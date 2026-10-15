import { describe, expect, it, vi } from "vitest";
import { changePrompts } from "../services/approval-change-prompts.js";

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
});
