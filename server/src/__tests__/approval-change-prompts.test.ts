import { describe, expect, it, vi } from "vitest";
import {
  changePrompts,
  finalizeTelegramChangePromptCapture,
  telegramChangePromptCandidate,
} from "../services/approval-change-prompts.js";

describe("change prompts", () => {
  it("a reply to the prompt becomes a comment on that approval, once", async () => {
    const addComment = vi.fn(async () => {});
    const p = changePrompts({ addComment, ttlMs: 86_400_000, now: () => 0 });
    p.remember(500, "appr-1", "u1");
    expect(await p.capture(500, "u1", "make it shorter, mention Friday")).toBe(true);
    expect(addComment).toHaveBeenCalledWith("appr-1", "u1", "make it shorter, mention Friday");
    expect(await p.capture(500, "u1", "again")).toBe(false);
  });
  it("ignores a reply from someone else, an unknown message and an expired prompt", async () => {
    let t = 0;
    const p = changePrompts({ addComment: vi.fn(async () => {}), ttlMs: 1000, now: () => t });
    p.remember(500, "appr-1", "u1");
    expect(await p.capture(500, "u2", "x")).toBe(false);
    expect(await p.capture(501, "u1", "x")).toBe(false);
    t = 2000;
    expect(await p.capture(500, "u1", "x")).toBe(false);
  });

  // Aspireco (I3, fix round 1): addComment failing must not consume the prompt — a retry of the
  // same reply (same replyToMessageId/userId) has to be able to capture it again.
  it("keeps the prompt when addComment fails, so a retry can capture it again", async () => {
    const addComment = vi.fn().mockRejectedValueOnce(new Error("db down")).mockResolvedValueOnce(undefined);
    const p = changePrompts({ addComment, ttlMs: 86_400_000, now: () => 0 });
    p.remember(500, "appr-1", "u1");
    await expect(p.capture(500, "u1", "make it shorter")).rejects.toThrow("db down");
    expect(await p.capture(500, "u1", "make it shorter")).toBe(true);
    expect(addComment).toHaveBeenCalledTimes(2);
  });
});

// Aspireco (I4, fix round 1): the decision chat-channels.ts uses before calling
// changePrompts.capture(...). Unit-tested directly because chat-channels.ts itself hangs on a bare
// import in a test (its dependency graph opens real connections at import time), so this is the
// "stubbed harness around the capture decision" the fix-round-1 review called for.
describe("telegramChangePromptCandidate", () => {
  const principal = { linkedDenied: false, userId: "u1", kind: "user", isBot: false };
  const raw = { reply_to_message: { message_id: 500 }, chat: { id: 123 } };

  it("is a candidate for a linked, active, non-bot principal replying to a tracked message", () => {
    expect(
      telegramChangePromptCandidate({ provider: "telegram", principal, raw, text: "  shorter please  " }),
    ).toEqual({ replyTo: 500, userId: "u1", text: "shorter please" });
  });
  it("ignores a bot principal", () => {
    expect(
      telegramChangePromptCandidate({ provider: "telegram", principal: { ...principal, isBot: true }, raw, text: "x" }),
    ).toBeNull();
  });
  it("ignores an unlinked/guest principal (no userId)", () => {
    expect(
      telegramChangePromptCandidate({ provider: "telegram", principal: { ...principal, userId: null }, raw, text: "x" }),
    ).toBeNull();
  });
  it("ignores a principal whose link was denied (no longer an active non-viewer member)", () => {
    expect(
      telegramChangePromptCandidate({ provider: "telegram", principal: { ...principal, linkedDenied: true }, raw, text: "x" }),
    ).toBeNull();
  });
  it("ignores a non-Telegram provider", () => {
    expect(
      telegramChangePromptCandidate({ provider: "slack", principal, raw, text: "x" }),
    ).toBeNull();
  });
  it("ignores a message that is not a reply", () => {
    expect(
      telegramChangePromptCandidate({ provider: "telegram", principal, raw: { chat: { id: 123 } }, text: "x" }),
    ).toBeNull();
  });
  it("ignores a reply whose text is empty after trimming (cheap minor fix)", () => {
    expect(
      telegramChangePromptCandidate({ provider: "telegram", principal, raw, text: "   " }),
    ).toBeNull();
  });
});

describe("finalizeTelegramChangePromptCapture", () => {
  it("sends the confirmation and marks the delivery processed", async () => {
    const sendConfirmation = vi.fn(async () => {});
    const markDeliveryProcessed = vi.fn(async () => {});
    await finalizeTelegramChangePromptCapture({ chatId: 123, sendConfirmation, markDeliveryProcessed });
    expect(sendConfirmation).toHaveBeenCalledWith(123);
    expect(markDeliveryProcessed).toHaveBeenCalledTimes(1);
  });
  it("skips the confirmation when there is no chat id, but still marks the delivery processed", async () => {
    const sendConfirmation = vi.fn(async () => {});
    const markDeliveryProcessed = vi.fn(async () => {});
    await finalizeTelegramChangePromptCapture({ chatId: undefined, sendConfirmation, markDeliveryProcessed });
    expect(sendConfirmation).not.toHaveBeenCalled();
    expect(markDeliveryProcessed).toHaveBeenCalledTimes(1);
  });
  // Aspireco (C1/I3, fix round 1): the comment already landed by the time this runs — a failed
  // confirmation send must never stop the delivery from being marked final (that is what let the
  // redrive sweep replay an already-captured reply into ordinary agent chat).
  it("still marks the delivery processed when the confirmation send fails, and reports the error", async () => {
    const sendConfirmation = vi.fn().mockRejectedValue(new Error("telegram down"));
    const markDeliveryProcessed = vi.fn(async () => {});
    const onConfirmationError = vi.fn();
    await finalizeTelegramChangePromptCapture({ chatId: 123, sendConfirmation, markDeliveryProcessed, onConfirmationError });
    expect(markDeliveryProcessed).toHaveBeenCalledTimes(1);
    expect(onConfirmationError).toHaveBeenCalledWith(expect.any(Error));
  });
});
