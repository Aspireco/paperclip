// Aspireco: one-tap approve/reject buttons on Telegram approval alerts.
import { describe, expect, it, vi } from "vitest";
import {
  approvalButtonHandler,
  approvalButtons,
  decodeApprovalAction,
  encodeApprovalAction,
} from "../services/approval-telegram-buttons.js";

const SECRET = "test-signing-secret";
const ID = "5c615cd0-e659-4837-837f-bf7e56f3cb7f";

describe("approval button encoding", () => {
  it("round-trips approve and reject for the exact approval", () => {
    expect(decodeApprovalAction(SECRET, encodeApprovalAction(SECRET, "approve", ID))).toEqual({ decision: "approve", approvalId: ID });
    expect(decodeApprovalAction(SECRET, encodeApprovalAction(SECRET, "reject", ID))).toEqual({ decision: "reject", approvalId: ID });
  });

  it("fits Telegram's 64-byte callback_data inside Paperclip's chat wrapper", () => {
    for (const button of approvalButtons(SECRET, ID).inline_keyboard[0]) {
      expect(Buffer.byteLength(button.callback_data, "utf8")).toBeLessThanOrEqual(64);
    }
    expect(approvalButtons(SECRET, ID).inline_keyboard[0].map((b) => b.text)).toEqual(["✅ Approve", "❌ Reject", "✏️ Change"]);
  });

  it("rejects a forged signature, a flipped decision, another approval's id, and a different secret", () => {
    const approve = encodeApprovalAction(SECRET, "approve", ID);
    const forged = approve.slice(0, -1) + (approve.endsWith("A") ? "B" : "A");
    const flipped = "pan" + approve.slice(3);
    const otherId = encodeApprovalAction(SECRET, "approve", "11111111-2222-4333-8444-555555555555");
    const swapped = approve.slice(0, 3) + otherId.slice(3, 25) + approve.slice(25);
    expect(decodeApprovalAction(SECRET, forged)).toBeNull();
    expect(decodeApprovalAction(SECRET, flipped)).toBeNull();
    expect(decodeApprovalAction(SECRET, swapped)).toBeNull();
    expect(decodeApprovalAction("another-secret", approve)).toBeNull();
    expect(decodeApprovalAction(undefined, approve)).toBeNull();
  });

  it("ignores ordinary chat actions", () => {
    expect(decodeApprovalAction(SECRET, "confirm:abc")).toBeNull();
  });
});

describe("approval button handler", () => {
  function setup(approval: { id: string; companyId: string; status: string } | null, decided?: unknown) {
    const decideApproval = vi.fn(async () => (decided ?? { outcome: "decided", approval: { ...approval!, status: "approved" }, applied: true }) as never);
    const handler = approvalButtonHandler({
      secret: SECRET,
      getApproval: async () => approval,
      decideApproval,
      isActiveMember: async (_u: string, c: string) => c === "co-1",
      requestChange: vi.fn(async () => ({ promptText: "What should change? Reply to this message." })),
      userLabel: async () => "John",
    });
    return { handler, decideApproval };
  }
  const pending = { id: ID, companyId: "co-1", status: "pending" };

  it("approves through the shared decision path as the linked user", async () => {
    const { handler, decideApproval } = setup(pending);
    const status = await handler.handle({ actionId: encodeApprovalAction(SECRET, "approve", ID), userId: "user-john", companyId: "co-1" });
    expect(status).toBe("✅ Approved by John");
    expect(decideApproval).toHaveBeenCalledWith(ID, "approve", "user-john");
  });

  it("rejects through the shared decision path", async () => {
    const { handler, decideApproval } = setup(pending, { outcome: "decided", approval: { ...pending, status: "rejected" }, applied: true });
    const status = await handler.handle({ actionId: encodeApprovalAction(SECRET, "reject", ID), userId: "user-john", companyId: "co-1" });
    expect(status).toBe("❌ Rejected by John");
    expect(decideApproval).toHaveBeenCalledWith(ID, "reject", "user-john");
  });

  it("does nothing for an approval in another company", async () => {
    const { handler, decideApproval } = setup({ ...pending, companyId: "co-2" });
    const status = await handler.handle({ actionId: encodeApprovalAction(SECRET, "approve", ID), userId: "u", companyId: "co-1" });
    expect(status).toBe("This approval is not available here.");
    expect(decideApproval).not.toHaveBeenCalled();
  });

  it("does nothing for an approval already decided", async () => {
    const { handler, decideApproval } = setup({ ...pending, status: "rejected" });
    const status = await handler.handle({ actionId: encodeApprovalAction(SECRET, "approve", ID), userId: "u", companyId: "co-1" });
    expect(status).toBe("Already decided: rejected.");
    expect(decideApproval).not.toHaveBeenCalled();
  });

  it("says when the held action expired", async () => {
    const { handler } = setup(pending, { outcome: "expired" });
    const status = await handler.handle({ actionId: encodeApprovalAction(SECRET, "approve", ID), userId: "u", companyId: "co-1" });
    expect(status).toBe("Expired before a decision. Nothing was run.");
  });

  it("a forged approval button is refused without deciding anything", async () => {
    const { handler, decideApproval } = setup(pending);
    const forged = encodeApprovalAction("attacker-secret", "approve", ID);
    expect(await handler.handle({ actionId: forged, userId: "u", companyId: "co-1" })).toBe("This button is not valid. Open Paperclip to decide.");
    expect(decideApproval).not.toHaveBeenCalled();
  });

  it("leaves non-approval actions to normal chat handling", async () => {
    const { handler } = setup(pending);
    expect(await handler.handle({ actionId: "question-1", userId: "u", companyId: "co-1" })).toBeNull();
  });
});

describe("cross-company and change", () => {
  const NORPEX = "c09ef533-845c-4bad-a3fe-46ccc53ada7c";
  const HQ = "a62c615c-51b6-4bb0-b03f-78e61c919919";
  const pending = { id: ID, companyId: NORPEX, status: "pending" };

  function handler(member: boolean) {
    return approvalButtonHandler({
      secret: SECRET,
      getApproval: async () => pending,
      isActiveMember: vi.fn(async (_u: string, c: string) => member && c === NORPEX),
      decideApproval: vi.fn(async () => ({ outcome: "decided" as const, approval: { ...pending, status: "approved" }, applied: true })),
      requestChange: vi.fn(async () => ({ promptText: "What should change? Reply to this message." })),
    });
  }

  it("decides a Norpex approval tapped through the HQ endpoint when the user is a Norpex member", async () => {
    const h = handler(true);
    const out = await h.handle({ actionId: encodeApprovalAction(SECRET, "approve", ID), userId: "u1", companyId: HQ });
    expect(out).toBe("✅ Approved");
  });

  it("non-member: refuses and decides nothing", async () => {
    const h = handler(false);
    const out = await h.handle({ actionId: encodeApprovalAction(SECRET, "approve", ID), userId: "u1", companyId: HQ });
    expect(out).toBe("This approval is not available here.");
  });

  it("change: asks what should change with a force-reply prompt", async () => {
    const h = handler(true);
    const out = await h.handle({ actionId: encodeApprovalAction(SECRET, "change", ID), userId: "u1", companyId: HQ });
    expect(out).toEqual({ status: "✏️ Changes requested", forceReply: "What should change? Reply to this message.", approvalId: ID });
  });

  it("has three buttons, each within 64 bytes", () => {
    const row = approvalButtons(SECRET, ID).inline_keyboard[0];
    expect(row.map((b) => b.text)).toEqual(["✅ Approve", "❌ Reject", "✏️ Change"]);
    for (const b of row) expect(Buffer.byteLength(b.callback_data, "utf8")).toBeLessThanOrEqual(64);
  });
});
