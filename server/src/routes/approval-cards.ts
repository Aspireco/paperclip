// Aspireco: Hermes-only routes for approval cards (spec 2026-10-15 mobile approvals, agentic-system).
// A dedicated bearer, never an agent key: an agent must not be able to write the card John
// approves from.
import { Router } from "express";
import { timingSafeEqual } from "node:crypto";

const OPEN = new Set(["pending", "revision_requested"]);

export function approvalCardRoutes(deps: {
  hermesToken: string | undefined;
  getApproval: (id: string) => Promise<{ id: string; companyId: string; status: string } | null>;
  toolAction: (id: string) => Promise<{ tool: string; arguments: unknown; expiresAt: string | null } | null>;
  cards: { send: Function; settle: (id: string, line: string) => Promise<void> };
  decideApproval: (id: string, d: "approve", userId: string, note?: string) => Promise<{ outcome: string; applied?: boolean }>;
  rejectApproval: (id: string, note: string) => Promise<unknown>;
}) {
  const router = Router();
  const authed = (header: string | undefined) => {
    const want = deps.hermesToken ? Buffer.from(`Bearer ${deps.hermesToken}`) : null;
    const got = Buffer.from(header ?? "");
    return Boolean(want && got.length === want.length && timingSafeEqual(got, want));
  };
  router.use("/approvals/:id", (req, res, next) => (authed(req.headers.authorization) ? next() : res.status(401).json({ error: "unauthorized" })));

  router.get("/approvals/:id/tool-action", async (req, res) => {
    const approval = await deps.getApproval(req.params.id);
    const action = approval ? await deps.toolAction(approval.id) : null;
    if (!approval || !action) return res.status(404).json({ error: "not_found" });
    res.json({ approvalId: approval.id, companyId: approval.companyId, status: approval.status, ...action });
  });

  router.post("/approvals/:id/telegram-card", async (req, res) => {
    const approval = await deps.getApproval(req.params.id);
    if (!approval) return res.status(404).json({ error: "not_found" });
    if (!OPEN.has(approval.status)) return res.status(409).json({ error: "not_pending" });
    const text = req.body?.text;
    const parts = Array.isArray(req.body?.parts) ? req.body.parts.filter((p: unknown) => typeof p === "string") : [];
    if (typeof text !== "string" || !text) return res.status(400).json({ error: "text_required" });
    const out = await deps.cards.send(approval.id, { text, parts }, { buttons: req.body?.buttons !== false });
    return out.ok ? res.json({ messageIds: out.messageIds }) : res.status(502).json({ error: "telegram", messageIds: out.messageIds });
  });

  router.post("/approvals/:id/auto-approve", async (req, res) => {
    const ruleId = req.body?.ruleId;
    if (typeof ruleId !== "string" || !/^[\w-]{1,64}$/.test(ruleId)) return res.status(400).json({ error: "rule_required" });
    const approval = await deps.getApproval(req.params.id);
    if (!approval || !OPEN.has(approval.status)) return res.status(409).json({ error: "not_pending" });
    const result = await deps.decideApproval(approval.id, "approve", "auto-approver", `auto: rule ${ruleId}`);
    if (result.outcome !== "decided" || !result.applied) return res.status(409).json({ error: "not_applied" });
    await deps.cards.settle(approval.id, `🤖 Auto-approved (rule ${ruleId})`);
    res.json({ status: "approved" });
  });

  router.post("/approvals/:id/supersede", async (req, res) => {
    const approval = await deps.getApproval(req.params.id);
    if (!approval || !OPEN.has(approval.status)) return res.status(409).json({ error: "not_pending" });
    await deps.rejectApproval(approval.id, "superseded: the content changed after the card");
    await deps.cards.settle(approval.id, "↩️ Superseded - a new card follows");
    res.json({ status: "rejected" });
  });

  return router;
}
