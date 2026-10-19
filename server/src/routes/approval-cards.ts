// Aspireco: Hermes-only routes for approval cards (spec 2026-10-15 mobile approvals, agentic-system).
// A dedicated bearer, never an agent key: an agent must not be able to write the card John
// approves from.
import { Router, type NextFunction, type Request, type Response } from "express";
import { timingSafeEqual } from "node:crypto";

const OPEN = new Set(["pending", "revision_requested"]);

type SendResult = { ok: boolean; messageIds: number[] };

export function approvalCardRoutes(deps: {
  hermesToken: string | undefined;
  getApproval: (
    id: string,
  ) => Promise<
    { id: string; companyId: string; status: string; requestedByAgentId: string | null; payload: unknown } | null
  >;
  toolAction: (id: string) => Promise<{ tool: string; arguments: unknown; expiresAt: string | null } | null>;
  cards: {
    send: (approvalId: string, card: { text: string; parts: string[] }, opts: { buttons: boolean }) => Promise<SendResult>;
    settle: (id: string, line: string) => Promise<void>;
  };
  /** Adds the full readable detail text as an approval comment, authored by the requesting agent
   * (option 1, John 2026-10-18: the board carries the detail, Telegram carries only a link). Also
   * stamps `payload.details` so a retry of the same version is a no-op. */
  addDetails: (
    approvalId: string,
    text: string,
    version: string,
    agentId: string | null,
  ) => Promise<{ commentId: string }>;
  /** Fail-closed gate for an actionable (buttons:true) card: false when signing or delivery isn't
   * fully configured, so Hermes never gets a 200 for a card whose buttons can't be decoded. */
  cardsConfigured: boolean;
  decideApproval: (id: string, d: "approve", userId: string, note?: string) => Promise<{ outcome: string; applied?: boolean }>;
  rejectApproval: (id: string, note: string) => Promise<{ applied: boolean }>;
}) {
  const router = Router();

  // Aspireco (C1 fix): a dedicated middleware attached to each route individually — never a
  // router.use(prefix) gate. This router mounts on the same `/api` prefix as every board and
  // agent route (app.ts, ahead of the board mutation guard); a prefix gate here would have
  //401'd every other `/api/approvals/:id/*` request (board approve/reject, resubmit, comments)
  // whenever it lacked the Hermes bearer, including John's own board session.
  function requireHermes(req: Request, res: Response, next: NextFunction) {
    const token = deps.hermesToken?.trim();
    const want = token ? Buffer.from(`Bearer ${token}`) : null;
    const got = Buffer.from(req.headers.authorization ?? "");
    if (want && got.length === want.length && timingSafeEqual(got, want)) return next();
    res.status(401).json({ error: "unauthorized" });
  }

  router.get("/approvals/:id/tool-action", requireHermes, async (req, res) => {
    const approval = await deps.getApproval(req.params.id as string);
    if (!approval) return res.status(404).json({ error: "not_found" });
    if (!OPEN.has(approval.status)) return res.status(409).json({ error: "not_pending" });
    const action = await deps.toolAction(approval.id);
    if (!action) return res.status(404).json({ error: "not_found" });
    if (action.arguments === null || action.arguments === undefined) {
      return res.status(500).json({ error: "undecodable" });
    }
    res.json({ approvalId: approval.id, companyId: approval.companyId, status: approval.status, ...action });
  });

  router.post("/approvals/:id/telegram-card", requireHermes, async (req, res) => {
    const approval = await deps.getApproval(req.params.id as string);
    if (!approval) return res.status(404).json({ error: "not_found" });
    if (!OPEN.has(approval.status)) return res.status(409).json({ error: "not_pending" });
    const text = req.body?.text;
    const parts = Array.isArray(req.body?.parts) ? req.body.parts.filter((p: unknown) => typeof p === "string") : [];
    if (typeof text !== "string" || !text) return res.status(400).json({ error: "text_required" });
    const buttons = req.body?.buttons !== false;
    if (buttons && !deps.cardsConfigured) return res.status(503).json({ error: "not_configured" });
    const out = await deps.cards.send(approval.id, { text, parts }, { buttons });
    return out.ok ? res.json({ messageIds: out.messageIds }) : res.status(502).json({ error: "telegram", messageIds: out.messageIds });
  });

  // Aspireco (John 2026-10-18, option 1): the full detail text lives on the approval, as a
  // comment Hermes adds before it sends John the short Telegram line. Idempotent per `version` —
  // Hermes retries the same tick's post if the ping after it fails, and that retry must not add a
  // second comment.
  router.post("/approvals/:id/details", requireHermes, async (req, res) => {
    const approval = await deps.getApproval(req.params.id as string);
    if (!approval) return res.status(404).json({ error: "not_found" });
    if (!OPEN.has(approval.status)) return res.status(409).json({ error: "not_pending" });
    const text = req.body?.text;
    const version = req.body?.version;
    if (typeof text !== "string" || text.length < 1 || text.length > 20000) {
      return res.status(400).json({ error: "text_required" });
    }
    if (typeof version !== "string" || version.length < 1 || version.length > 128) {
      return res.status(400).json({ error: "version_required" });
    }
    const existingDetails = (approval.payload as { details?: { version?: string; commentId?: string } } | null)
      ?.details;
    if (existingDetails && existingDetails.version === version) {
      return res.status(200).json({ commentId: existingDetails.commentId, existing: true });
    }
    const { commentId } = await deps.addDetails(approval.id, text, version, approval.requestedByAgentId);
    return res.status(201).json({ commentId });
  });

  router.post("/approvals/:id/auto-approve", requireHermes, async (req, res) => {
    const ruleId = req.body?.ruleId;
    if (typeof ruleId !== "string" || !/^[\w-]{1,64}$/.test(ruleId)) return res.status(400).json({ error: "rule_required" });
    const approval = await deps.getApproval(req.params.id as string);
    if (!approval || !OPEN.has(approval.status)) return res.status(409).json({ error: "not_pending" });
    const result = await deps.decideApproval(approval.id, "approve", "auto-approver", `auto: rule ${ruleId}`);
    if (result.outcome !== "decided" || !result.applied) return res.status(409).json({ error: "not_applied" });
    await deps.cards.settle(approval.id, `🤖 Auto-approved (rule ${ruleId})`);
    res.json({ status: "approved" });
  });

  router.post("/approvals/:id/supersede", requireHermes, async (req, res) => {
    const approval = await deps.getApproval(req.params.id as string);
    if (!approval || !OPEN.has(approval.status)) return res.status(409).json({ error: "not_pending" });
    // Aspireco (I2 fix): a race (someone already decided it on the board) must not settle the
    // card as "superseded" when nothing was actually rejected.
    const result = await deps.rejectApproval(approval.id, "superseded: the content changed after the card");
    if (!result.applied) return res.status(409).json({ error: "not_applied" });
    await deps.cards.settle(approval.id, "↩️ Superseded - a new card follows");
    res.json({ status: "rejected" });
  });

  return router;
}
