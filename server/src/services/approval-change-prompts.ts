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
      prompts.delete(replyToMessageId);
      await deps.addComment(p.approvalId, userId, text.slice(0, 4000));
      return true;
    },
  };
}
