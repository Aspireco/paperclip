import { describe, expect, it, vi } from "vitest";
import { approvalCards } from "../services/approval-telegram-cards.js";

const ID = "5c615cd0-e659-4837-837f-bf7e56f3cb7f";

function deps(results: Array<{ ok: boolean; messageId?: number }>) {
  const sent: any[] = [];
  return {
    sent,
    d: {
      secret: "s",
      chatId: "8690378276",
      send: vi.fn(async (body: any) => { sent.push(body); return results.shift() ?? { ok: true, messageId: 99 }; }),
      edit: vi.fn(async () => true),
    },
  };
}

describe("approvalCards", () => {
  it("sends the card as HTML with buttons, then each part as a reply to it", async () => {
    const { sent, d } = deps([{ ok: true, messageId: 10 }, { ok: true, messageId: 11 }]);
    const cards = approvalCards(d);
    const out = await cards.send(ID, { text: "<b>card</b>", parts: ["part 2/2"] }, { buttons: true });
    expect(out).toEqual({ ok: true, messageIds: [10, 11] });
    expect(sent[0].parse_mode).toBe("HTML");
    expect(sent[0].reply_markup.inline_keyboard[0]).toHaveLength(3);
    expect(sent[1].reply_to_message_id).toBe(10);
    expect(cards.hasCard(ID)).toBe(true);
  });

  it("a failed part reports not ok and the card is settled as incomplete", async () => {
    const { d } = deps([{ ok: true, messageId: 10 }, { ok: false }]);
    const cards = approvalCards(d);
    const out = await cards.send(ID, { text: "card", parts: ["p2"] }, { buttons: true });
    expect(out.ok).toBe(false);
    expect(d.edit).toHaveBeenCalledWith(10, "⚠️ Full text incomplete - open the board.");
  });

  it("buttons:false sends an FYI card with no keyboard", async () => {
    const { sent, d } = deps([{ ok: true, messageId: 12 }]);
    await approvalCards(d).send(ID, { text: "auto", parts: [] }, { buttons: false });
    expect(sent[0].reply_markup).toBeUndefined();
  });

  it("isCardMessage matches only the tracked card's own message id", async () => {
    const { d } = deps([{ ok: true, messageId: 20 }]);
    const cards = approvalCards(d);
    await cards.send(ID, { text: "card", parts: [] }, { buttons: true });
    expect(cards.isCardMessage(ID, 20)).toBe(true);
    expect(cards.isCardMessage(ID, 21)).toBe(false);
    expect(cards.isCardMessage("other-id", 20)).toBe(false);
  });

  it("settle edits the card then forgets it, so a later settle or isCardMessage check is a no-op", async () => {
    const { d } = deps([{ ok: true, messageId: 30 }]);
    const cards = approvalCards(d);
    await cards.send(ID, { text: "card", parts: [] }, { buttons: true });
    await cards.settle(ID, "done");
    expect(d.edit).toHaveBeenCalledWith(30, "done");
    expect(cards.hasCard(ID)).toBe(false);
    expect(cards.isCardMessage(ID, 30)).toBe(false);
    d.edit.mockClear();
    await cards.settle(ID, "again");
    expect(d.edit).not.toHaveBeenCalled();
  });

  it("remembers each card on the approval, and a settle keeps the record with its outcome line", async () => {
    const { d } = deps([{ ok: true, messageId: 40 }]);
    const persist = vi.fn(async () => undefined);
    const cards = approvalCards({ ...d, persist });
    await cards.send(ID, { text: "card", parts: [] }, { buttons: true });
    expect(persist).toHaveBeenLastCalledWith(ID, { messageId: 40 });
    await cards.settle(ID, "✅ Approved by John");
    expect(persist).toHaveBeenLastCalledWith(ID, { messageId: 40, settled: "✅ Approved by John" });
  });

  it("after a restart, seed makes the unsettled cards live again (no second plain alert)", () => {
    const { d } = deps([]);
    const cards = approvalCards(d);
    cards.seed([{ approvalId: ID, record: { messageId: 50 } }, { approvalId: "done-id", record: { messageId: 51, settled: "x" } }]);
    expect(cards.hasCard(ID)).toBe(true);
    expect(cards.isCardMessage(ID, 50)).toBe(true);
    expect(cards.hasCard("done-id")).toBe(false);
  });

  it("an approved card whose send was refused says so, once", async () => {
    const { d } = deps([]);
    const persist = vi.fn(async () => undefined);
    const outcome = vi.fn(async () => ({ done: true as const, refused: "stale" }));
    const cards = approvalCards({ ...d, persist, outcome });
    const rows = [{ approvalId: ID, record: { messageId: 60, settled: "✅ Approved by John" } }];
    expect(await cards.checkOutcomes(rows)).toBe(1);
    expect(d.edit).toHaveBeenCalledWith(60, "✅ Approved by John · ⚠️ not sent: stale");
    expect(persist).toHaveBeenLastCalledWith(ID, { messageId: 60, settled: "✅ Approved by John", checked: true });
    expect(await cards.checkOutcomes([{ approvalId: ID, record: { ...rows[0].record, checked: true } }])).toBe(0);
  });

  it("a send that went out, or one still running, leaves the card alone", async () => {
    const { d } = deps([]);
    const persist = vi.fn(async () => undefined);
    const results = [{ done: false as const }, { done: true as const }];
    const cards = approvalCards({ ...d, persist, outcome: vi.fn(async () => results.shift()!) });
    const rows = [{ approvalId: ID, record: { messageId: 70, settled: "✅ Approved by John" } }];
    await cards.checkOutcomes(rows);
    expect(persist).not.toHaveBeenCalled();
    await cards.checkOutcomes(rows);
    expect(d.edit).not.toHaveBeenCalled();
    expect(persist).toHaveBeenCalledTimes(1);
  });
});

