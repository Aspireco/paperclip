// Aspireco: approve/reject/change an approval with one tap in Telegram (John's choice, 2026-10-12,
// over upstream's "tool side effects stay in Paperclip"). Safety: a tap only acts when it arrives
// through Paperclip's verified Telegram webhook from a principal linked to an active non-viewer
// member (chat-channels checks that before calling handle()), the button is HMAC-signed for exactly
// one approval and decision, and the approval must belong to a company where the tapping user is an
// active non-viewer member (was: the endpoint's company). Deciding goes through the same
// decideApproval() as the board's Approvals page.
import { createHmac, timingSafeEqual } from "node:crypto";
import { telegramChatSdkCallbackData } from "./chat-interaction-publications.js";

/** Aspireco: the fixed Change-button prompt, shared with app.ts's requestChange and reused verbatim
 * for a repeat tap on an approval already in revision_requested (see approvalButtonHandler). */
export const CHANGE_PROMPT_TEXT = "What should change? Reply to this message.";

type Decision = "approve" | "reject" | "change";
const FLAG: Record<Decision, string> = { approve: "y", reject: "n", change: "c" };
const FROM_FLAG: Record<string, Decision> = { y: "approve", n: "reject", c: "change" };
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
  return `${PREFIX}${FLAG[decision]}${compactId(approvalId)}${signature(secret, decision, approvalId)}`;
}

export function decodeApprovalAction(
  secret: string | null | undefined,
  actionId: string,
): { decision: Decision; approvalId: string } | null {
  if (!secret || actionId.length !== 2 + 1 + 22 + SIG_CHARS || !actionId.startsWith(PREFIX)) return null;
  const decision = FROM_FLAG[actionId[2]];
  if (!decision) return null;
  const approvalId = expandId(actionId.slice(3, 25));
  if (!approvalId) return null;
  const given = Buffer.from(actionId.slice(25));
  const expected = Buffer.from(signature(secret, decision, approvalId));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return { decision, approvalId };
}

/** Telegram inline keyboard: [✅ Approve] [❌ Reject] [✏️ Change], wrapped in Paperclip's chat-SDK callback format. */
export function approvalButtons(secret: string, approvalId: string) {
  return {
    inline_keyboard: [[
      { text: "✅ Approve", callback_data: telegramChatSdkCallbackData(encodeApprovalAction(secret, "approve", approvalId)) },
      { text: "❌ Reject", callback_data: telegramChatSdkCallbackData(encodeApprovalAction(secret, "reject", approvalId)) },
      { text: "✏️ Change", callback_data: telegramChatSdkCallbackData(encodeApprovalAction(secret, "change", approvalId)) },
    ]],
  };
}

type Approval = { id: string; companyId: string; status: string };
type DecideResult = { outcome: "expired" } | { outcome: "decided"; approval: Approval; applied: boolean };

export function approvalButtonHandler(deps: {
  secret: string | null | undefined;
  getApproval: (id: string) => Promise<Approval | null>;
  isActiveMember: (userId: string, companyId: string) => Promise<boolean>;
  decideApproval: (id: string, decision: "approve" | "reject", userId: string) => Promise<DecideResult>;
  requestChange: (approvalId: string, userId: string) => Promise<{ promptText: string }>;
  userLabel?: (userId: string) => Promise<string | null>;
}) {
  return {
    /** null = not an approval button (let chat-channels handle it); otherwise the status line to show
     * (or, for a Change tap, the force-reply prompt to send). */
    async handle(
      input: { actionId: string; userId: string; companyId: string },
    ): Promise<string | { status: string; forceReply: string; approvalId: string } | null> {
      const parsed = decodeApprovalAction(deps.secret, input.actionId);
      if (!parsed) return input.actionId.startsWith(PREFIX) ? "This button is not valid. Open Paperclip to decide." : null;
      const approval = await deps.getApproval(parsed.approvalId);
      if (!approval || !(await deps.isActiveMember(input.userId, approval.companyId))) {
        return "This approval is not available here.";
      }
      if (approval.status !== "pending" && approval.status !== "revision_requested") {
        return `Already decided: ${approval.status}.`;
      }
      if (parsed.decision === "change") {
        // A second Change tap (or a stale card) lands here with the approval already
        // revision_requested: svc.requestRevision only accepts pending, so calling it again would
        // throw instead of settling the button. Idempotent: resend the same prompt without deciding
        // anything new.
        if (approval.status === "revision_requested") {
          return { status: "✏️ Changes requested", forceReply: CHANGE_PROMPT_TEXT, approvalId: parsed.approvalId };
        }
        try {
          const { promptText } = await deps.requestChange(parsed.approvalId, input.userId);
          return { status: "✏️ Changes requested", forceReply: promptText, approvalId: parsed.approvalId };
        } catch {
          const latest = await deps.getApproval(parsed.approvalId).catch(() => null);
          return latest ? `Already decided: ${latest.status}.` : "Could not request changes. Open Paperclip.";
        }
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
