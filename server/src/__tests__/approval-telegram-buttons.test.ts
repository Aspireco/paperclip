// Aspireco: one-tap approve/reject buttons on Telegram approval alerts.
import { describe, expect, it, vi } from "vitest";
import {
  approvalButtonHandler,
  approvalButtons,
  CHANGE_PROMPT_TEXT,
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

  it("rewriting a signed Change button's flag to Approve fails verification", () => {
    const change = encodeApprovalAction(SECRET, "change", ID);
    const rewritten = "pay" + change.slice(3);
    expect(decodeApprovalAction(SECRET, rewritten)).toBeNull();
  });
});

describe("approval button handler", () => {
  function setup(
    approval: { id: string; companyId: string; status: string } | null,
    decided?: unknown,
    isActiveDecider?: (userId: string, companyId: string) => Promise<boolean>,
  ) {
    const decideApproval = vi.fn(async () => (decided ?? { outcome: "decided", approval: { ...approval!, status: "approved" }, applied: true }) as never);
    const decider = isActiveDecider ? vi.fn(isActiveDecider) : undefined;
    const handler = approvalButtonHandler({
      secret: SECRET,
      getApproval: async () => approval,
      decideApproval,
      // Merge of hq-pinned's isActiveDecider into this branch's isActiveMember (one check): a test that
      // passes a check gets it as isActiveMember; otherwise the user is a member of co-1 only.
      isActiveMember: decider ?? (async (_u: string, c: string) => c === "co-1"),
      requestChange: vi.fn(async () => ({ promptText: "What should change? Reply to this message." })),
      userLabel: async () => "John",
    });
    return { handler, decideApproval, decider };
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

  it("does nothing for an approval in another company the user is not a member of", async () => {
    const { handler, decideApproval } = setup({ ...pending, companyId: "co-2" });
    const status = await handler.handle({ actionId: encodeApprovalAction(SECRET, "approve", ID), userId: "u", companyId: "co-1" });
    expect(status).toBe("This approval is not available here.");
    expect(decideApproval).not.toHaveBeenCalled();
  });

  // Aspireco 2026-10-15: one Telegram bot (the HQ org's endpoint) alerts for every org's approvals, so a
  // tap on another org's approval must work for someone who can decide approvals in THAT org.
  it("decides another company's approval when the tapping user is an active non-viewer member there", async () => {
    const { handler, decideApproval, decider } = setup({ ...pending, companyId: "co-2" }, undefined, async () => true);
    const status = await handler.handle({ actionId: encodeApprovalAction(SECRET, "approve", ID), userId: "user-john", companyId: "co-1" });
    expect(status).toBe("✅ Approved by John");
    expect(decider).toHaveBeenCalledWith("user-john", "co-2");
    expect(decideApproval).toHaveBeenCalledWith(ID, "approve", "user-john");
  });

  it("does nothing for another company's approval when the tapping user cannot decide there", async () => {
    const { handler, decideApproval, decider } = setup({ ...pending, companyId: "co-2" }, undefined, async () => false);
    const status = await handler.handle({ actionId: encodeApprovalAction(SECRET, "approve", ID), userId: "u", companyId: "co-1" });
    expect(status).toBe("This approval is not available here.");
    expect(decider).toHaveBeenCalledWith("u", "co-2");
    expect(decideApproval).not.toHaveBeenCalled();
  });

  it("does not consult the membership check for the endpoint's own company", async () => {
    const { handler, decider } = setup(pending, undefined, async () => false);
    const status = await handler.handle({ actionId: encodeApprovalAction(SECRET, "approve", ID), userId: "user-john", companyId: "co-1" });
    expect(status).toBe("✅ Approved by John");
    expect(decider).not.toHaveBeenCalled();
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

  function handler(member: boolean, status: string = "pending") {
    const approval = { ...pending, status };
    const decideApproval = vi.fn(async () => ({ outcome: "decided" as const, approval: { ...approval, status: "approved" }, applied: true }));
    const requestChange = vi.fn(async () => ({ promptText: "What should change? Reply to this message." }));
    const h = approvalButtonHandler({
      secret: SECRET,
      getApproval: async () => approval,
      isActiveMember: vi.fn(async (_u: string, c: string) => member && c === NORPEX),
      decideApproval,
      requestChange,
    });
    return { h, decideApproval, requestChange };
  }

  it("decides a Norpex approval tapped through the HQ endpoint when the user is a Norpex member", async () => {
    const { h } = handler(true);
    const out = await h.handle({ actionId: encodeApprovalAction(SECRET, "approve", ID), userId: "u1", companyId: HQ });
    expect(out).toBe("✅ Approved");
  });

  it("non-member: refuses and decides nothing", async () => {
    const { h } = handler(false);
    const out = await h.handle({ actionId: encodeApprovalAction(SECRET, "approve", ID), userId: "u1", companyId: HQ });
    expect(out).toBe("This approval is not available here.");
  });

  it("change: asks what should change with a force-reply prompt", async () => {
    const { h, decideApproval, requestChange } = handler(true);
    const out = await h.handle({ actionId: encodeApprovalAction(SECRET, "change", ID), userId: "u1", companyId: HQ });
    expect(out).toEqual({ status: "✏️ Changes requested", forceReply: "What should change? Reply to this message.", approvalId: ID });
    expect(decideApproval).not.toHaveBeenCalled();
    expect(requestChange).toHaveBeenCalledWith(ID, "u1");
  });

  it("change on an approval already revision_requested: does not call requestChange, resends the prompt", async () => {
    const { h, requestChange } = handler(true, "revision_requested");
    const out = await h.handle({ actionId: encodeApprovalAction(SECRET, "change", ID), userId: "u1", companyId: HQ });
    expect(out).toEqual({ status: "✏️ Changes requested", forceReply: CHANGE_PROMPT_TEXT, approvalId: ID });
    expect(requestChange).not.toHaveBeenCalled();
  });

  it("requestChange throwing (a decision race) returns a defined string instead of throwing out of handle()", async () => {
    const approval = { ...pending, status: "pending" };
    const getApproval = vi
      .fn()
      .mockResolvedValueOnce(approval)
      .mockResolvedValueOnce({ ...approval, status: "approved" });
    const h = approvalButtonHandler({
      secret: SECRET,
      getApproval,
      isActiveMember: async () => true,
      decideApproval: vi.fn(),
      requestChange: vi.fn(async () => {
        throw new Error("unprocessable: only pending approvals can request revision");
      }),
    });
    const out = await h.handle({ actionId: encodeApprovalAction(SECRET, "change", ID), userId: "u1", companyId: HQ });
    expect(out).toBe("Already decided: approved.");
  });

  it("requestChange throwing when the approval can't be re-read still returns a defined string", async () => {
    const approval = { ...pending, status: "pending" };
    const getApproval = vi
      .fn()
      .mockResolvedValueOnce(approval)
      .mockRejectedValueOnce(new Error("db unavailable"));
    const h = approvalButtonHandler({
      secret: SECRET,
      getApproval,
      isActiveMember: async () => true,
      decideApproval: vi.fn(),
      requestChange: vi.fn(async () => {
        throw new Error("race");
      }),
    });
    const out = await h.handle({ actionId: encodeApprovalAction(SECRET, "change", ID), userId: "u1", companyId: HQ });
    expect(out).toBe("Could not request changes. Open Paperclip.");
  });

  it("has three buttons, each within 64 bytes", () => {
    const row = approvalButtons(SECRET, ID).inline_keyboard[0];
    expect(row.map((b) => b.text)).toEqual(["✅ Approve", "❌ Reject", "✏️ Change"]);
    for (const b of row) expect(Buffer.byteLength(b.callback_data, "utf8")).toBeLessThanOrEqual(64);
  });
});
