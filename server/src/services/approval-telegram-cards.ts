// Aspireco: Hermes builds the approval card (it holds the content and the preview lock); this
// sends it through the Paperclip Telegram endpoint so button taps come back to Paperclip's
// verified webhook. Spec docs/superpowers/specs/2026-10-15-mobile-approvals-design.md (agentic-system).
import { approvalButtons } from "./approval-telegram-buttons.js";

type SendResult = { ok: boolean; messageId?: number };
export function approvalCards(deps: {
  secret: string;
  chatId: string;
  send: (body: Record<string, unknown>) => Promise<SendResult>;
  edit: (messageId: number, line: string) => Promise<boolean>;
}) {
  const cardMessage = new Map<string, number>();

  return {
    hasCard: (approvalId: string) => cardMessage.has(approvalId),
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
      if (id !== undefined) await deps.edit(id, line);
    },
  };
}
