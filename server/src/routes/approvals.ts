import { Router, type Request } from "express";
import { and, eq } from "drizzle-orm";
import { heartbeatRuns, toolActionRequests, type Db } from "@paperclipai/db";
import {
  addApprovalCommentSchema,
  createApprovalSchema,
  requestApprovalRevisionSchema,
  resolveApprovalSchema,
  resubmitApprovalSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logger } from "../middleware/logger.js";
import {
  approvalService,
  accessService,
  heartbeatService,
  issueApprovalService,
  logActivity,
  secretService,
} from "../services/index.js";
import { assertBoard, assertCompanyAccess, getAccessibleResource, getActorInfo, hasCompanyAccess } from "./authz.js";
import { redactEventPayload } from "../redaction.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { issueService } from "../services/issues.js";
import { REVIEW_PATH_RECOVERY_INSTRUCTION } from "../services/recovery/review-path-recovery.js";

function redactApprovalPayload<T extends { payload: Record<string, unknown> }>(approval: T): T {
  return {
    ...approval,
    payload: redactEventPayload(approval.payload) ?? {},
  };
}

function isStatusOnlyRecoveryContext(contextSnapshot: unknown) {
  if (!contextSnapshot || typeof contextSnapshot !== "object" || Array.isArray(contextSnapshot)) return false;
  const context = contextSnapshot as Record<string, unknown>;
  return context.recoveryIntent === "status_only" &&
    context.allowDeliverableWork === false &&
    context.allowDocumentUpdates === false &&
    context.resumeRequiresNormalModel === true;
}

// Aspireco: the tool gateway's own review calls, so a decision on a tool action's formal approval
// also settles the held action (one click). Late-bound in app.ts: the gateway is built after this router.
type ToolActionDecision = {
  companyId: string;
  actionRequestId: string;
  actor: { agentId?: string | null; userId?: string | null };
  reason?: string;
};
export type ApprovalToolActions = {
  approve: (input: ToolActionDecision) => Promise<unknown>;
  decline: (input: ToolActionDecision) => Promise<unknown>;
};

function toolActionRequestIdOf(approval: { payload: unknown }): string | null {
  const payload = (approval.payload ?? {}) as Record<string, unknown>;
  return payload.source === "tool_gateway" && typeof payload.actionRequestId === "string"
    ? payload.actionRequestId
    : null;
}

export function approvalRoutes(
  db: Db,
  options: { pluginWorkerManager?: PluginWorkerManager; toolActions?: ApprovalToolActions } = {},
) {
  const router = Router();
  const svc = approvalService(db);
  const access = accessService(db);
  const heartbeat = heartbeatService(db, {
    pluginWorkerManager: options.pluginWorkerManager,
  });
  const issueApprovalsSvc = issueApprovalService(db);
  const issuesSvc = issueService(db);
  const secretsSvc = secretService(db);
  const strictSecretsMode = process.env.PAPERCLIP_SECRETS_STRICT_MODE === "true";

  // Aspireco: the held tool action this approval was minted for, or null. The payload names an
  // action, but only the gateway sets toolActionRequests.approvalId, so an approval an agent wrote
  // itself that names someone else's action never settles it (no approval laundering).
  async function pairedToolAction(approval: { id: string; companyId: string; payload: unknown }) {
    const actionRequestId = toolActionRequestIdOf(approval);
    if (!actionRequestId) return null;
    const [held] = await db
      .select()
      .from(toolActionRequests)
      .where(and(
        eq(toolActionRequests.id, actionRequestId),
        eq(toolActionRequests.approvalId, approval.id),
        eq(toolActionRequests.companyId, approval.companyId),
      ))
      .limit(1);
    return held && held.approvalId === approval.id && held.companyId === approval.companyId ? held : null;
  }

  async function lostReviewPathIssueIds(
    companyId: string,
    linkedIssues: Awaited<ReturnType<typeof issueApprovalsSvc.listIssuesForApproval>>,
  ) {
    const attention = await issuesSvc.listReviewAttention(companyId, linkedIssues);
    return new Set(linkedIssues
      .filter((issue) => attention.get(issue.id)?.state === "stalled")
      .map((issue) => issue.id));
  }

  function approvalReviewPathContext(approvalId: string) {
    return {
      reviewPathLost: true,
      reviewPathConsumedRef: approvalId,
      reviewPathInstruction: REVIEW_PATH_RECOVERY_INSTRUCTION,
    };
  }

  async function queueAdditionalApprovalReviewPathWakes(input: {
    approvalId: string;
    approvalStatus: string;
    companyId: string;
    linkedIssues: Awaited<ReturnType<typeof issueApprovalsSvc.listIssuesForApproval>>;
    lostIssueIds: Set<string>;
    alreadyWoken?: { agentId: string; issueId: string } | null;
    requestedByUserId: string;
  }) {
    for (const issue of input.linkedIssues) {
      if (!input.lostIssueIds.has(issue.id) || !issue.assigneeAgentId) continue;
      if (
        input.alreadyWoken?.agentId === issue.assigneeAgentId
        && input.alreadyWoken.issueId === issue.id
      ) continue;

      const wakeReason = `approval_${input.approvalStatus}`;
      try {
        const wakeRun = await heartbeat.wakeup(issue.assigneeAgentId, {
          source: "automation",
          triggerDetail: "system",
          reason: wakeReason,
          idempotencyKey: `approval-review-path:${input.approvalId}:${issue.id}:${input.approvalStatus}`,
          payload: {
            approvalId: input.approvalId,
            approvalStatus: input.approvalStatus,
            issueId: issue.id,
            ...approvalReviewPathContext(input.approvalId),
          },
          requestedByActorType: "user",
          requestedByActorId: input.requestedByUserId,
          contextSnapshot: {
            source: `approval.${input.approvalStatus}`,
            approvalId: input.approvalId,
            approvalStatus: input.approvalStatus,
            issueId: issue.id,
            taskId: issue.id,
            wakeReason,
            ...approvalReviewPathContext(input.approvalId),
          },
        });

        await logActivity(db, {
          companyId: input.companyId,
          actorType: "user",
          actorId: input.requestedByUserId,
          action: "approval.review_path_wakeup_queued",
          entityType: "approval",
          entityId: input.approvalId,
          details: {
            approvalStatus: input.approvalStatus,
            issueId: issue.id,
            assigneeAgentId: issue.assigneeAgentId,
            wakeRunId: wakeRun?.id ?? null,
          },
        });
      } catch (err) {
        logger.warn(
          { err, approvalId: input.approvalId, issueId: issue.id, agentId: issue.assigneeAgentId },
          "failed to queue review-path wake after approval resolution",
        );
        await logActivity(db, {
          companyId: input.companyId,
          actorType: "user",
          actorId: input.requestedByUserId,
          action: "approval.review_path_wakeup_failed",
          entityType: "approval",
          entityId: input.approvalId,
          details: {
            approvalStatus: input.approvalStatus,
            issueId: issue.id,
            assigneeAgentId: issue.assigneeAgentId,
            error: err instanceof Error ? err.message : String(err),
          },
        });
      }
    }
  }

  async function requireApprovalAccess(req: Request, id: string) {
    const approval = await svc.getById(id);
    if (!approval || !hasCompanyAccess(req, approval.companyId)) {
      return null;
    }
    assertCompanyAccess(req, approval.companyId);
    return approval;
  }

  async function assertApprovalAccessAllowed(req: Request, res: any, companyId: string) {
    const decision = await access.decide({
      actor: req.actor,
      action: "company_scope:read",
      resource: { type: "company", companyId },
    });
    if (decision.allowed) return true;
    res.status(403).json({ error: "Approvals are outside this actor's authorization boundary" });
    return false;
  }

  async function assertApprovalMutationAllowedByRunContext(req: Request, res: any, companyId: string) {
    if (req.actor.type !== "agent") return true;
    const runId = req.actor.runId?.trim();
    if (!runId || !req.actor.agentId) return true;

    const run = await db
      .select({
        id: heartbeatRuns.id,
        companyId: heartbeatRuns.companyId,
        agentId: heartbeatRuns.agentId,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    if (!run || run.companyId !== companyId || run.agentId !== req.actor.agentId) return true;
    if (!isStatusOnlyRecoveryContext(run.contextSnapshot)) return true;

    res.status(403).json({
      error: "Status-only recovery runs cannot create or modify approvals",
      details: {
        companyId,
        runId: run.id,
        recoveryIntent: "status_only",
        resumeRequiresNormalModel: true,
      },
    });
    return false;
  }

  router.get("/companies/:companyId/approvals", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await assertApprovalAccessAllowed(req, res, companyId))) return;
    const status = req.query.status as string | undefined;
    const result = await svc.list(companyId, status);
    res.json(result.map((approval) => redactApprovalPayload(approval)));
  });

  router.get("/approvals/:id", async (req, res) => {
    const id = req.params.id as string;
    const approval = await getAccessibleResource(req, res, svc.getById(id), "Approval not found");
    if (!approval) return;
    if (!(await assertApprovalAccessAllowed(req, res, approval.companyId))) return;
    res.json(redactApprovalPayload(approval));
  });

  router.post("/companies/:companyId/approvals", validate(createApprovalSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await assertApprovalAccessAllowed(req, res, companyId))) return;
    if (!(await assertApprovalMutationAllowedByRunContext(req, res, companyId))) return;
    const rawIssueIds = req.body.issueIds;
    const issueIds = Array.isArray(rawIssueIds)
      ? rawIssueIds.filter((value: unknown): value is string => typeof value === "string")
      : [];
    const uniqueIssueIds = Array.from(new Set(issueIds));
    const { issueIds: _issueIds, ...approvalInput } = req.body;
    const normalizedPayload =
      approvalInput.type === "hire_agent"
        ? await secretsSvc.normalizeHireApprovalPayloadForPersistence(
            companyId,
            approvalInput.payload,
            { strictMode: strictSecretsMode },
          )
        : approvalInput.payload;

    const actor = getActorInfo(req);
    const approval = await svc.create(companyId, {
      ...approvalInput,
      payload: normalizedPayload,
      requestedByUserId: actor.actorType === "user" ? actor.actorId : null,
      requestedByAgentId:
        approvalInput.requestedByAgentId ?? (actor.actorType === "agent" ? actor.actorId : null),
      status: "pending",
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      updatedAt: new Date(),
    });

    if (uniqueIssueIds.length > 0) {
      await issueApprovalsSvc.linkManyForApproval(approval.id, uniqueIssueIds, {
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
      });
    }

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "approval.created",
      entityType: "approval",
      entityId: approval.id,
      details: { type: approval.type, issueIds: uniqueIssueIds },
    });

    res.status(201).json(redactApprovalPayload(approval));
  });

  router.get("/approvals/:id/issues", async (req, res) => {
    const id = req.params.id as string;
    const approval = await getAccessibleResource(req, res, svc.getById(id), "Approval not found");
    if (!approval) return;
    if (!(await assertApprovalAccessAllowed(req, res, approval.companyId))) return;
    const issues = await issueApprovalsSvc.listIssuesForApproval(id);
    res.json(issues);
  });

  // Aspireco: the one decision path for an approval, shared by the board routes below and by
  // Telegram's approve/reject buttons (chat-channels). Callers check access first.
  async function decideApproval(
    id: string,
    decision: "approve" | "reject",
    decidedByUserId: string,
    decisionNote?: string | null,
  ): Promise<
    | { outcome: "expired" }
    | { outcome: "decided"; approval: Awaited<ReturnType<typeof svc.approve>>["approval"]; applied: boolean }
  > {
    if (decision === "reject") {
      const { approval, applied } = await svc.reject(id, decidedByUserId, decisionNote);

      const rejectedActionId = applied ? (await pairedToolAction(approval))?.id ?? null : null;
      if (rejectedActionId && options.toolActions) {
        try {
          await options.toolActions.decline({
            companyId: approval.companyId,
            actionRequestId: rejectedActionId,
            actor: { userId: decidedByUserId },
            reason: decisionNote ?? undefined,
          });
        } catch (err) {
          logger.warn({ err, approvalId: approval.id, actionRequestId: rejectedActionId }, "rejected, but declining the held tool action failed");
        }
      }

      if (applied) {
        const linkedIssues = await issueApprovalsSvc.listIssuesForApproval(approval.id);
        const lostReviewIssueIds = await lostReviewPathIssueIds(approval.companyId, linkedIssues);
        await logActivity(db, {
          companyId: approval.companyId,
          actorType: "user",
          actorId: decidedByUserId,
          action: "approval.rejected",
          entityType: "approval",
          entityId: approval.id,
          details: { type: approval.type },
        });
        await queueAdditionalApprovalReviewPathWakes({
          approvalId: approval.id,
          approvalStatus: approval.status,
          companyId: approval.companyId,
          linkedIssues,
          lostIssueIds: lostReviewIssueIds,
          requestedByUserId: decidedByUserId,
        });
      }
      return { outcome: "decided", approval, applied };
    }

    // Aspireco: a tool action that already expired cannot run; say so instead of recording an
    // approval that does nothing, and clear it from the queue.
    const pendingApproval = await svc.getById(id);
    const held = pendingApproval ? await pairedToolAction(pendingApproval) : null;
    const heldActionId = held?.id ?? null;
    if (pendingApproval && held && (pendingApproval.status === "pending" || pendingApproval.status === "revision_requested")) {
      const expired = held.status === "expired" || held.status === "cancelled" || held.status === "rejected"
        || (held.status === "pending" && held.expiresAt !== null && held.expiresAt <= new Date());
      if (expired) {
        await svc.cancel(id, "Expired before a decision; nothing was run.");
        return { outcome: "expired" };
      }
    }
    const { approval, applied } = await svc.approve(id, decidedByUserId, decisionNote);

    if (applied && heldActionId && options.toolActions) {
      try {
        await options.toolActions.approve({
          companyId: approval.companyId,
          actionRequestId: heldActionId,
          actor: { userId: decidedByUserId },
        });
      } catch (err) {
        logger.warn({ err, approvalId: approval.id, actionRequestId: heldActionId }, "approved, but releasing the held tool action failed");
      }
    }

    if (applied) {
      const linkedIssues = await issueApprovalsSvc.listIssuesForApproval(approval.id);
      const linkedIssueIds = linkedIssues.map((issue) => issue.id);
      const primaryIssueId = linkedIssueIds[0] ?? null;
      const lostReviewIssueIds = await lostReviewPathIssueIds(approval.companyId, linkedIssues);
      const primaryReviewPathContext = primaryIssueId && lostReviewIssueIds.has(primaryIssueId)
        ? approvalReviewPathContext(approval.id)
        : null;

      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "user",
        actorId: decidedByUserId,
        action: "approval.approved",
        entityType: "approval",
        entityId: approval.id,
        details: {
          type: approval.type,
          requestedByAgentId: approval.requestedByAgentId,
          linkedIssueIds,
        },
      });

      let primaryReviewPathWakeCovered = false;
      if (approval.requestedByAgentId) {
        try {
          const wakeRun = await heartbeat.wakeup(approval.requestedByAgentId, {
            source: "automation",
            triggerDetail: "system",
            reason: "approval_approved",
            payload: {
              approvalId: approval.id,
              approvalStatus: approval.status,
              issueId: primaryIssueId,
              issueIds: linkedIssueIds,
              ...(primaryReviewPathContext ?? {}),
            },
            requestedByActorType: "user",
            requestedByActorId: decidedByUserId,
            contextSnapshot: {
              source: "approval.approved",
              approvalId: approval.id,
              approvalStatus: approval.status,
              issueId: primaryIssueId,
              issueIds: linkedIssueIds,
              taskId: primaryIssueId,
              wakeReason: "approval_approved",
              ...(primaryReviewPathContext ?? {}),
            },
          });
          primaryReviewPathWakeCovered = Boolean(wakeRun && primaryReviewPathContext);

          await logActivity(db, {
            companyId: approval.companyId,
            actorType: "user",
            actorId: decidedByUserId,
            action: "approval.requester_wakeup_queued",
            entityType: "approval",
            entityId: approval.id,
            details: {
              requesterAgentId: approval.requestedByAgentId,
              wakeRunId: wakeRun?.id ?? null,
              linkedIssueIds,
            },
          });
        } catch (err) {
          logger.warn(
            {
              err,
              approvalId: approval.id,
              requestedByAgentId: approval.requestedByAgentId,
            },
            "failed to queue requester wakeup after approval",
          );
          await logActivity(db, {
            companyId: approval.companyId,
            actorType: "user",
            actorId: decidedByUserId,
            action: "approval.requester_wakeup_failed",
            entityType: "approval",
            entityId: approval.id,
            details: {
              requesterAgentId: approval.requestedByAgentId,
              linkedIssueIds,
              error: err instanceof Error ? err.message : String(err),
            },
          });
        }
      }

      await queueAdditionalApprovalReviewPathWakes({
        approvalId: approval.id,
        approvalStatus: approval.status,
        companyId: approval.companyId,
        linkedIssues,
        lostIssueIds: lostReviewIssueIds,
        alreadyWoken: primaryReviewPathWakeCovered && approval.requestedByAgentId && primaryIssueId
          ? { agentId: approval.requestedByAgentId, issueId: primaryIssueId }
          : null,
        requestedByUserId: decidedByUserId,
      });
    }

    return { outcome: "decided", approval, applied };
  }

  router.post("/approvals/:id/approve", validate(resolveApprovalSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    if (!(await requireApprovalAccess(req, id))) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    const result = await decideApproval(id, "approve", req.actor.userId ?? "board", req.body.decisionNote);
    if (result.outcome === "expired") {
      res.status(409).json({
        error: "This action expired before it was approved, so nothing was run. Ask the agent to try again.",
        reasonCode: "action_expired",
      });
      return;
    }
    res.json(redactApprovalPayload(result.approval));
  });

  router.post("/approvals/:id/reject", validate(resolveApprovalSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    if (!(await requireApprovalAccess(req, id))) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    const result = await decideApproval(id, "reject", req.actor.userId ?? "board", req.body.decisionNote);
    if (result.outcome === "expired") throw new Error("unreachable: a rejection never expires");
    res.json(redactApprovalPayload(result.approval));
  });

  router.post(
    "/approvals/:id/request-revision",
    validate(requestApprovalRevisionSchema),
    async (req, res) => {
      assertBoard(req);
      const id = req.params.id as string;
      if (!(await requireApprovalAccess(req, id))) {
        res.status(404).json({ error: "Approval not found" });
        return;
      }
      const decidedByUserId = req.actor.userId ?? "board";
      const approval = await svc.requestRevision(id, decidedByUserId, req.body.decisionNote);

      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "approval.revision_requested",
        entityType: "approval",
        entityId: approval.id,
        details: { type: approval.type },
      });

      res.json(redactApprovalPayload(approval));
    },
  );

  router.post("/approvals/:id/resubmit", validate(resubmitApprovalSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await getAccessibleResource(req, res, svc.getById(id), "Approval not found");
    if (!existing) return;
    if (!(await assertApprovalMutationAllowedByRunContext(req, res, existing.companyId))) return;

    if (req.actor.type === "agent" && req.actor.agentId !== existing.requestedByAgentId) {
      res.status(403).json({ error: "Only requesting agent can resubmit this approval" });
      return;
    }

    const normalizedPayload = req.body.payload
      ? existing.type === "hire_agent"
        ? await secretsSvc.normalizeHireApprovalPayloadForPersistence(
            existing.companyId,
            req.body.payload,
            { strictMode: strictSecretsMode },
          )
        : req.body.payload
      : undefined;
    const approval = await svc.resubmit(id, normalizedPayload);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: approval.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "approval.resubmitted",
      entityType: "approval",
      entityId: approval.id,
      details: { type: approval.type },
    });
    res.json(redactApprovalPayload(approval));
  });

  router.get("/approvals/:id/comments", async (req, res) => {
    const id = req.params.id as string;
    const approval = await getAccessibleResource(req, res, svc.getById(id), "Approval not found");
    if (!approval) return;
    const comments = await svc.listComments(id);
    res.json(comments);
  });

  router.post("/approvals/:id/comments", validate(addApprovalCommentSchema), async (req, res) => {
    const id = req.params.id as string;
    const approval = await getAccessibleResource(req, res, svc.getById(id), "Approval not found");
    if (!approval) return;
    if (!(await assertApprovalMutationAllowedByRunContext(req, res, approval.companyId))) return;
    const actor = getActorInfo(req);
    const comment = await svc.addComment(id, req.body.body, {
      agentId: actor.agentId ?? undefined,
      userId: actor.actorType === "user" ? actor.actorId : undefined,
    });

    await logActivity(db, {
      companyId: approval.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "approval.comment_added",
      entityType: "approval",
      entityId: approval.id,
      details: { commentId: comment.id },
    });

    res.status(201).json(comment);
  });

  // Aspireco: request a revision outside the board route, for Telegram's Change button.
  async function requestChangeRevision(id: string, decidedByUserId: string, decisionNote?: string | null) {
    const approval = await svc.requestRevision(id, decidedByUserId, decisionNote);

    await logActivity(db, {
      companyId: approval.companyId,
      actorType: "user",
      actorId: decidedByUserId,
      action: "approval.revision_requested",
      entityType: "approval",
      entityId: approval.id,
      details: { type: approval.type },
    });

    return approval;
  }

  // Aspireco: add a comment outside the board route, for a Telegram Change-prompt reply (Task 5).
  // Same persistence and activity logging as POST /approvals/:id/comments.
  //
  // I2 (controller ruling, fix round 1, 2026-10-15): the original brief assumed an approval comment
  // alone wakes the requesting agent. It does not — agents don't read approval comments. So this also
  // posts the same note on the approval's linked issue(s) through the same `issueService().addComment`
  // the board's issue-comment route uses, and separately wakes the requesting agent the way
  // `decideApproval` does above (`heartbeat.wakeup`), since posting an issue comment does not itself
  // enqueue a wake outside the live agent-chat path. Both failure paths are caught and logged rather
  // than thrown: the approval comment (the record of what John asked for) must not be lost because the
  // issue mirror or the wake failed.
  async function addApprovalComment(id: string, userId: string, body: string) {
    const comment = await svc.addComment(id, body, { userId });

    await logActivity(db, {
      companyId: comment.companyId,
      actorType: "user",
      actorId: userId,
      action: "approval.comment_added",
      entityType: "approval",
      entityId: id,
      details: { commentId: comment.id },
    });

    const linkedIssues = await issueApprovalsSvc.listIssuesForApproval(id).catch(() => []);
    for (const issue of linkedIssues) {
      try {
        await issuesSvc.addComment(issue.id, body, { userId }, { authorType: "user" });
      } catch (err) {
        logger.warn(
          { err, approvalId: id, issueId: issue.id },
          "could not mirror the Change reply onto the linked issue",
        );
      }
    }

    const approval = await svc.getById(id).catch(() => null);
    if (approval?.requestedByAgentId) {
      const linkedIssueIds = linkedIssues.map((issue) => issue.id);
      try {
        const wakeRun = await heartbeat.wakeup(approval.requestedByAgentId, {
          source: "automation",
          triggerDetail: "system",
          reason: "approval_change_requested",
          payload: { approvalId: id, issueIds: linkedIssueIds },
          requestedByActorType: "user",
          requestedByActorId: userId,
          contextSnapshot: {
            source: "approval.change_comment",
            approvalId: id,
            issueIds: linkedIssueIds,
            wakeReason: "approval_change_requested",
          },
        });
        await logActivity(db, {
          companyId: comment.companyId,
          actorType: "user",
          actorId: userId,
          action: "approval.requester_wakeup_queued",
          entityType: "approval",
          entityId: id,
          details: { requesterAgentId: approval.requestedByAgentId, wakeRunId: wakeRun?.id ?? null, linkedIssueIds },
        });
      } catch (err) {
        logger.warn(
          { err, approvalId: id, requestedByAgentId: approval.requestedByAgentId },
          "failed to queue requester wakeup after a Change reply comment",
        );
      }
    }

    return comment;
  }

  return Object.assign(router, {
    decideApproval,
    getApproval: (id: string) => svc.getById(id),
    requestRevision: requestChangeRevision,
    addComment: addApprovalComment,
  });
}
