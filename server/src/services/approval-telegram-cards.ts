// Aspireco: Hermes builds the approval card (it holds the content and the preview lock); this
// sends it through the Paperclip Telegram endpoint so button taps come back to Paperclip's
// verified webhook. Spec docs/superpowers/specs/2026-10-15-mobile-approvals-design.md (agentic-system).
import { approvalButtons } from "./approval-telegram-buttons.js";

type SendResult = { ok: boolean; messageId?: number };
/** Aspireco: what Paperclip remembers about a card, on the approval itself (payload.telegramCard),
 * so a restart neither forgets the card (the plain fallback alert would double it) nor loses the
 * chance to say "approved, but not sent". `settled` is the outcome line once a tap or Hermes
 * settled it; `checked` once the released call's result was looked at. */
export type CardRecord = { messageId: number; settled?: string; checked?: boolean };
/** The released call's result: not finished yet, finished and done, or finished and refused. */
export type CardOutcome = { done: false } | { done: true; refused?: string };
export function approvalCards(deps: {
  secret: string;
  chatId: string;
  send: (body: Record<string, unknown>) => Promise<SendResult>;
  edit: (messageId: number, line: string) => Promise<boolean>;
  persist?: (approvalId: string, record: CardRecord) => Promise<void>;
  outcome?: (approvalId: string) => Promise<CardOutcome>;
}) {
  const cardMessage = new Map<string, number>();
  const save = (approvalId: string, record: CardRecord) =>
    (deps.persist ? deps.persist(approvalId, record) : Promise.resolve()).catch(() => undefined);

  return {
    hasCard: (approvalId: string) => cardMessage.has(approvalId),
    // Aspireco: exact match on the tracked card's own message id, not just "this approval has a
    // card somewhere" — a chat-channels tap settle must never touch a message that merely shares
    // the approval id (e.g. a stale alert) but isn't the card itself.
    isCardMessage: (approvalId: string, messageId: number) => cardMessage.get(approvalId) === messageId,
    async send(approvalId: string, card: { text: string; parts: string[] }, opts: { buttons: boolean }) {
      const first = await deps.send({
        chat_id: deps.chatId,
        text: card.text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        ...(opts.buttons ? { reply_markup: approvalButtons(deps.secret, approvalId) } : {}),
      });
      if (!first.ok || first.messageId === undefined) return { ok: false, messageIds: [] as number[] };
      cardMessage.set(approvalId, first.messageId);
      await save(approvalId, { messageId: first.messageId });
      const ids = [first.messageId];
      for (const part of card.parts) {
        const r = await deps.send({
          chat_id: deps.chatId, text: part, parse_mode: "HTML",
          disable_web_page_preview: true, reply_to_message_id: first.messageId,
        });
        if (!r.ok || r.messageId === undefined) {
          await deps.edit(first.messageId, "⚠️ Full text incomplete - open the board.");
          return { ok: false, messageIds: ids };
        }
        ids.push(r.messageId);
      }
      return { ok: true, messageIds: ids };
    },
    async settle(approvalId: string, line: string) {
      const id = cardMessage.get(approvalId);
      if (id === undefined) return;
      await deps.edit(id, line);
      // Settled: no longer the live card for this approval, so a later tap on a stale copy of
      // the same message (or a reused approval id) is never mistaken for it.
      cardMessage.delete(approvalId);
      await save(approvalId, { messageId: id, settled: line });
    },
    /** After a restart: the cards still waiting for a tap become live again. */
    seed(rows: Array<{ approvalId: string; record: CardRecord }>) {
      for (const { approvalId, record } of rows) {
        if (!record.settled && Number.isInteger(record.messageId)) cardMessage.set(approvalId, record.messageId);
      }
    },
    /** Approved cards whose released call has finished: a refused send says so on the card
     * (final review I3 — otherwise it reads "Approved" while nothing went out). Each card is
     * looked at once; an unfinished call is looked at again on the next sweep. */
    async checkOutcomes(rows: Array<{ approvalId: string; record: CardRecord }>) {
      if (!deps.outcome) return 0;
      let flagged = 0;
      for (const { approvalId, record } of rows) {
        if (!record.settled || record.checked) continue;
        const result = await deps.outcome(approvalId).catch(() => ({ done: false as const }));
        if (!result.done) continue;
        if (result.refused) {
          await deps.edit(record.messageId, `${record.settled} · ⚠️ not sent: ${result.refused}`.slice(0, 120));
          flagged += 1;
        }
        await save(approvalId, { ...record, checked: true });
      }
      return flagged;
    },
  };
}
