// Aspireco: the ✏️ Change button asks "What should change?"; John's reply to that prompt is
// posted on the approval as his comment, which wakes the requesting agent. In memory with a
// 24 h TTL: after a restart an old prompt's reply falls through to ordinary chat handling.
export function changePrompts(deps: {
  addComment: (approvalId: string, userId: string, body: string) => Promise<void>;
  ttlMs: number;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const prompts = new Map<number, { approvalId: string; userId: string; at: number }>();
  return {
    remember(promptMessageId: number, approvalId: string, userId: string) {
      prompts.set(promptMessageId, { approvalId, userId, at: now() });
    },
    async capture(replyToMessageId: number, userId: string, text: string): Promise<boolean> {
      const p = prompts.get(replyToMessageId);
      if (!p || p.userId !== userId || now() - p.at > deps.ttlMs) return false;
      // Aspireco (I3, fix round 1): delete the prompt only once the comment is actually written.
      // If addComment throws, the prompt survives so a retry of the same reply can capture it
      // again, instead of silently falling through to ordinary agent chat.
      await deps.addComment(p.approvalId, userId, text.slice(0, 4000));
      prompts.delete(replyToMessageId);
      return true;
    },
  };
}

/**
 * Aspireco (I4, fix round 1): the pure decision at the top of chat-channels' inbound Telegram
 * message handler — pulled out so it is unit-testable without loading that 38k-line module (which
 * hangs on a bare import in a test, since its dependency graph opens real connections at import
 * time). chat-channels.ts calls this with the already-resolved principal and message, and only
 * proceeds to `changePrompts.capture(...)` when it returns non-null. Never captures from a bot,
 * an unlinked/guest principal, a non-numeric reply target, or an empty (post-trim) reply — only a
 * linked, active, non-bot principal replying to a tracked prompt with real text is a candidate.
 */
export function telegramChangePromptCandidate(input: {
  provider: string;
  principal: {
    linkedDenied: boolean;
    userId: string | null | undefined;
    kind: string;
    isBot: boolean;
  };
  raw: unknown;
  text: string;
}): { replyTo: number; userId: string; text: string } | null {
  if (input.provider !== "telegram") return null;
  if (
    input.principal.linkedDenied ||
    !input.principal.userId ||
    input.principal.kind !== "user" ||
    input.principal.isBot
  )
    return null;
  const replyTo = (
    input.raw as { reply_to_message?: { message_id?: unknown } } | null
  )?.reply_to_message?.message_id;
  if (typeof replyTo !== "number") return null;
  const text = input.text.trim();
  if (!text) return null;
  return { replyTo, userId: input.principal.userId, text };
}

/**
 * Aspireco (C1/I3, fix round 1): once a reply is captured, the confirmation send and the delivery
 * finalization are pulled into their own function so both are independently testable: the
 * confirmation send can fail (e.g. Telegram is briefly down) without throwing — `onConfirmationError`
 * is called instead — and `markDeliveryProcessed` always runs once the comment has landed, so the
 * delivery row never stays "processing" past this point. Leaving it "processing" is exactly what let
 * the redrive sweep (DELIVERY_PROCESSING_STALE_MS) re-run the message after the prompt was already
 * consumed, sending John's reply into ordinary agent chat after he was told "Sent to the agent."
 */
export async function finalizeTelegramChangePromptCapture(deps: {
  chatId: unknown;
  sendConfirmation: (chatId: unknown) => Promise<unknown>;
  markDeliveryProcessed: () => Promise<void>;
  onConfirmationError?: (err: unknown) => void;
}): Promise<void> {
  if (deps.chatId !== undefined) {
    try {
      await deps.sendConfirmation(deps.chatId);
    } catch (err) {
      deps.onConfirmationError?.(err);
    }
  }
  await deps.markDeliveryProcessed();
}
