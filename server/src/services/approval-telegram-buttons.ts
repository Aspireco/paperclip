// Aspireco: approve/reject an approval with one tap in Telegram (John's choice, 2026-10-12, over
// upstream's "tool side effects stay in Paperclip"). Safety: a tap only acts when it arrives through
// Paperclip's verified Telegram webhook from a principal linked to an active non-viewer member
// (chat-channels checks that before calling handle()), the button is HMAC-signed for exactly one
// approval and decision, and the approval must belong to the endpoint's company - or (2026-10-15)
// to another company where the same user is an active, non-viewer member (isActiveDecider).
// Deciding goes through the same decideApproval() as the board's Approvals page.
import { createHmac, timingSafeEqual } from "node:crypto";
import { telegramChatSdkCallbackData } from "./chat-interaction-publications.js";

type Decision = "approve" | "reject";
const PREFIX = "pa";
const SIG_CHARS = 24;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function key(secret: string): Buffer {
  return createHmac("sha256", secret).update("aspireco:approval-telegram-buttons:v1").digest();
}

function signature(secret: string, decision: Decision, approvalId: string): string {
  return createHmac("sha256", key(secret))
    .update(`${decision}:${approvalId.toLowerCase()}`)
    .digest("base64url")
    .slice(0, SIG_CHARS);
}

function compactId(uuid: string): string {
  return Buffer.from(uuid.replace(/-/g, ""), "hex").toString("base64url");
}

function expandId(compact: string): string | null {
  const hex = Buffer.from(compact, "base64url").toString("hex");
  if (hex.length !== 32) return null;
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return UUID.test(uuid) ? uuid : null;
}

/** The chat action id for a button: "pa" + y|n + 22-char approval id + 24-char signature (49 chars). */
export function encodeApprovalAction(secret: string, decision: Decision, approvalId: string): string {
  if (!UUID.test(approvalId)) throw new Error("approval id must be a uuid");
  return `${PREFIX}${decision === "approve" ? "y" : "n"}${compactId(approvalId)}${signature(secret, decision, approvalId)}`;
}

export function decodeApprovalAction(
  secret: string | null | undefined,
  actionId: string,
): { decision: Decision; approvalId: string } | null {
  if (!secret || actionId.length !== 2 + 1 + 22 + SIG_CHARS || !actionId.startsWith(PREFIX)) return null;
  const flag = actionId[2];
  if (flag !== "y" && flag !== "n") return null;
  const decision: Decision = flag === "y" ? "approve" : "reject";
  const approvalId = expandId(actionId.slice(3, 25));
  if (!approvalId) return null;
  const given = Buffer.from(actionId.slice(25));
  const expected = Buffer.from(signature(secret, decision, approvalId));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return { decision, approvalId };
}

/** Telegram inline keyboard: [✅ Approve] [❌ Reject], wrapped in Paperclip's chat-SDK callback format. */
export function approvalButtons(secret: string, approvalId: string) {
  return {
    inline_keyboard: [[
      { text: "✅ Approve", callback_data: telegramChatSdkCallbackData(encodeApprovalAction(secret, "approve", approvalId)) },
      { text: "❌ Reject", callback_data: telegramChatSdkCallbackData(encodeApprovalAction(secret, "reject", approvalId)) },
    ]],
  };
}

type Approval = { id: string; companyId: string; status: string };
type DecideResult = { outcome: "expired" } | { outcome: "decided"; approval: Approval; applied: boolean };

export function approvalButtonHandler(deps: {
  secret: string | null | undefined;
  getApproval: (id: string) => Promise<Approval | null>;
  decideApproval: (id: string, decision: Decision, userId: string) => Promise<DecideResult>;
  userLabel?: (userId: string) => Promise<string | null>;
  /**
   * Aspireco 2026-10-15: one bot (one endpoint, in one company) alerts for every company's approvals.
   * chat-channels verifies the tapping user only for the endpoint's company, so an approval in another
   * company is decided only when this confirms the same user is an active, non-viewer member there.
   * Without it, other companies' approvals stay refused (the original behaviour).
   */
  isActiveDecider?: (userId: string, companyId: string) => Promise<boolean>;
}) {
  return {
    /** null = not an approval button (let chat-channels handle it); otherwise the status line to show. */
    async handle(input: { actionId: string; userId: string; companyId: string }): Promise<string | null> {
      const parsed = decodeApprovalAction(deps.secret, input.actionId);
      if (!parsed) return input.actionId.startsWith(PREFIX) ? "This button is not valid. Open Paperclip to decide." : null;
      const approval = await deps.getApproval(parsed.approvalId);
      if (!approval) return "This approval is not available here.";
      if (approval.companyId !== input.companyId) {
        const allowed = deps.isActiveDecider
          ? await deps.isActiveDecider(input.userId, approval.companyId).catch(() => false)
          : false;
        if (!allowed) return "This approval is not available here.";
      }
      if (approval.status !== "pending" && approval.status !== "revision_requested") {
        return `Already decided: ${approval.status}.`;
      }
      const result = await deps.decideApproval(parsed.approvalId, parsed.decision, input.userId);
      if (result.outcome === "expired") return "Expired before a decision. Nothing was run.";
      if (!result.applied) return `Already decided: ${result.approval.status}.`;
      const who = (await deps.userLabel?.(input.userId).catch(() => null)) ?? null;
      return parsed.decision === "approve"
        ? `✅ Approved${who ? ` by ${who}` : ""}`
        : `❌ Rejected${who ? ` by ${who}` : ""}`;
    },
  };
}
