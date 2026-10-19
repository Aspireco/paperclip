import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { approvalCardRoutes } from "../routes/approval-cards.js";

const ID = "5c615cd0-e659-4837-837f-bf7e56f3cb7f";
const TOKEN = "hermes-test-token"; // pragma: allowlist secret

function app(over: Partial<Parameters<typeof approvalCardRoutes>[0]> = {}) {
  const deps = {
    hermesToken: TOKEN,
    cardsConfigured: true,
    getApproval: vi.fn(async () => ({ id: ID, companyId: "co", status: "pending", requestedByAgentId: "agent-1", payload: {} })),
    toolAction: vi.fn(async () => ({ tool: "mail_send", arguments: { op: "send_draft", params: { id: "d1" }, body: { expectedHash: "ab" } }, expiresAt: "2026-10-16T00:00:00Z" })),
    cards: { send: vi.fn(async () => ({ ok: true, messageIds: [1] })), settle: vi.fn(async () => {}) },
    addDetails: vi.fn(async () => ({ commentId: "comment-1" })),
    decideApproval: vi.fn(async () => ({ outcome: "decided", approval: { id: ID, status: "approved" }, applied: true })),
    rejectApproval: vi.fn(async () => ({ applied: true })),
    ...over,
  };
  const a = express();
  a.use(express.json());
  a.use("/api", approvalCardRoutes(deps as any));
  return { a, deps };
}

describe("approval card routes", () => {
  it("refuses any other bearer", async () => {
    const { a } = app();
    expect((await request(a).get(`/api/approvals/${ID}/tool-action`).set("authorization", "Bearer nope")).status).toBe(401);
  });
  it("returns the held tool action", async () => {
    const { a } = app();
    const r = await request(a).get(`/api/approvals/${ID}/tool-action`).set("authorization", `Bearer ${TOKEN}`);
    expect(r.status).toBe(200);
    expect(r.body.tool).toBe("mail_send");
  });
  it("sends a card for a pending approval", async () => {
    const { a, deps } = app();
    const r = await request(a).post(`/api/approvals/${ID}/telegram-card`).set("authorization", `Bearer ${TOKEN}`).send({ text: "card", parts: [] });
    expect(r.status).toBe(200);
    expect(deps.cards.send).toHaveBeenCalledWith(ID, { text: "card", parts: [] }, { buttons: true });
  });
  it("refuses a card for a decided approval", async () => {
    const { a } = app({ getApproval: vi.fn(async () => ({ id: ID, companyId: "co", status: "approved" })) });
    expect((await request(a).post(`/api/approvals/${ID}/telegram-card`).set("authorization", `Bearer ${TOKEN}`).send({ text: "c" })).status).toBe(409);
  });
  it("auto-approves as the auto-approver with the rule id, and settles the card", async () => {
    const { a, deps } = app();
    const r = await request(a).post(`/api/approvals/${ID}/auto-approve`).set("authorization", `Bearer ${TOKEN}`).send({ ruleId: "r1" });
    expect(r.status).toBe(200);
    expect(deps.decideApproval).toHaveBeenCalledWith(ID, "approve", "auto-approver", "auto: rule r1");
    expect(deps.cards.settle).toHaveBeenCalledWith(ID, "🤖 Auto-approved (rule r1)");
  });
  it("supersede rejects with the superseded note and settles the card", async () => {
    const { a, deps } = app();
    const r = await request(a).post(`/api/approvals/${ID}/supersede`).set("authorization", `Bearer ${TOKEN}`);
    expect(r.status).toBe(200);
    expect(deps.rejectApproval).toHaveBeenCalledWith(ID, "superseded: the content changed after the card");
    expect(deps.cards.settle).toHaveBeenCalledWith(ID, "↩️ Superseded - a new card follows");
  });

  // C1 regression: the four Hermes routes gate individually; everything else under
  // /api/approvals/:id/* (board routes, mounted after this router) must never see a 401 just
  // because it didn't carry the Hermes bearer.
  describe("C1: no prefix gate on /approvals/:id", () => {
    function appWithBoardStub() {
      const { a, deps } = app();
      a.get("/api/approvals/:id", (_req, res) => res.status(200).json({ from: "board-stub" }));
      a.post("/api/approvals/:id/approve", (_req, res) => res.status(200).json({ from: "board-stub" }));
      return { a, deps };
    }
    it("a board route reaches its own handler with no bearer at all", async () => {
      const { a } = appWithBoardStub();
      const r = await request(a).get(`/api/approvals/${ID}`);
      expect(r.status).toBe(200);
      expect(r.body.from).toBe("board-stub");
    });
    it("a board route reaches its own handler even with a wrong bearer", async () => {
      const { a } = appWithBoardStub();
      const r = await request(a).post(`/api/approvals/${ID}/approve`).set("authorization", "Bearer nope");
      expect(r.status).toBe(200);
      expect(r.body.from).toBe("board-stub");
    });
    it("the four Hermes routes still 401 with no bearer", async () => {
      const { a } = appWithBoardStub();
      expect((await request(a).get(`/api/approvals/${ID}/tool-action`)).status).toBe(401);
      expect((await request(a).post(`/api/approvals/${ID}/telegram-card`).send({ text: "c" })).status).toBe(401);
      expect((await request(a).post(`/api/approvals/${ID}/auto-approve`).send({ ruleId: "r1" })).status).toBe(401);
      expect((await request(a).post(`/api/approvals/${ID}/supersede`)).status).toBe(401);
    });
    it("the four Hermes routes still 401 with a wrong bearer", async () => {
      const { a } = appWithBoardStub();
      const wrong = { authorization: "Bearer nope" };
      expect((await request(a).get(`/api/approvals/${ID}/tool-action`).set(wrong)).status).toBe(401);
      expect((await request(a).post(`/api/approvals/${ID}/telegram-card`).set(wrong).send({ text: "c" })).status).toBe(401);
      expect((await request(a).post(`/api/approvals/${ID}/auto-approve`).set(wrong).send({ ruleId: "r1" })).status).toBe(401);
      expect((await request(a).post(`/api/approvals/${ID}/supersede`).set(wrong)).status).toBe(401);
    });
  });

  // I2 regression: a race where the approval was already decided elsewhere must not settle the
  // card as superseded.
  it("supersede does not settle the card when the reject did not apply (already decided)", async () => {
    const { a, deps } = app({ rejectApproval: vi.fn(async () => ({ applied: false })) });
    const r = await request(a).post(`/api/approvals/${ID}/supersede`).set("authorization", `Bearer ${TOKEN}`);
    expect(r.status).toBe(409);
    expect(deps.cards.settle).not.toHaveBeenCalled();
  });

  // I3 regression: an actionable card must fail closed, not report 200, when signing/delivery
  // isn't fully configured.
  describe("I3: fail closed when cards aren't configured", () => {
    it("buttons:true (default) returns 503 and never sends", async () => {
      const { a, deps } = app({ cardsConfigured: false });
      const r = await request(a).post(`/api/approvals/${ID}/telegram-card`).set("authorization", `Bearer ${TOKEN}`).send({ text: "card" });
      expect(r.status).toBe(503);
      expect(r.body.error).toBe("not_configured");
      expect(deps.cards.send).not.toHaveBeenCalled();
    });
    it("buttons:false (an FYI card) still sends", async () => {
      const { a, deps } = app({ cardsConfigured: false });
      const r = await request(a).post(`/api/approvals/${ID}/telegram-card`).set("authorization", `Bearer ${TOKEN}`).send({ text: "fyi", buttons: false });
      expect(r.status).toBe(200);
      expect(deps.cards.send).toHaveBeenCalledWith(ID, { text: "fyi", parts: [] }, { buttons: false });
    });
  });

  // Minor 4: tool-action is 409 for a non-open approval, and 500 "undecodable" instead of a 200
  // with arguments: null, when the signed arguments fail to decode.
  describe("minor 4: tool-action status handling", () => {
    it("409 for a decided approval", async () => {
      const { a } = app({ getApproval: vi.fn(async () => ({ id: ID, companyId: "co", status: "approved" })) });
      const r = await request(a).get(`/api/approvals/${ID}/tool-action`).set("authorization", `Bearer ${TOKEN}`);
      expect(r.status).toBe(409);
    });
    it("500 undecodable when the held action's arguments fail to decode", async () => {
      const { a } = app({ toolAction: vi.fn(async () => ({ tool: "mail_send", arguments: null, expiresAt: null })) });
      const r = await request(a).get(`/api/approvals/${ID}/tool-action`).set("authorization", `Bearer ${TOKEN}`);
      expect(r.status).toBe(500);
      expect(r.body.error).toBe("undecodable");
    });
  });

  // Minor 9: a whitespace-only token is treated as unset (fail closed), not as a literal bearer
  // value to match against.
  it("treats a whitespace-only hermesToken as unset", async () => {
    const { a } = app({ hermesToken: "   " });
    const r = await request(a).get(`/api/approvals/${ID}/tool-action`).set("authorization", "Bearer    ");
    expect(r.status).toBe(401);
  });

  // John 2026-10-18 (option 1): the full detail text lives on the approval as a comment, before
  // Telegram ever gets a short line pointing at it.
  describe("POST /approvals/:id/details", () => {
    it("refuses without the bearer", async () => {
      const { a } = app();
      const r = await request(a).post(`/api/approvals/${ID}/details`).send({ text: "the full email", version: "v1" });
      expect(r.status).toBe(401);
    });
    it("400s a bad body", async () => {
      const { a } = app();
      const r1 = await request(a).post(`/api/approvals/${ID}/details`).set("authorization", `Bearer ${TOKEN}`).send({ version: "v1" });
      expect(r1.status).toBe(400);
      const r2 = await request(a).post(`/api/approvals/${ID}/details`).set("authorization", `Bearer ${TOKEN}`).send({ text: "x" });
      expect(r2.status).toBe(400);
    });
    it("409s when the approval isn't open", async () => {
      const { a } = app({ getApproval: vi.fn(async () => ({ id: ID, companyId: "co", status: "approved", requestedByAgentId: null, payload: {} })) });
      const r = await request(a).post(`/api/approvals/${ID}/details`).set("authorization", `Bearer ${TOKEN}`).send({ text: "x", version: "v1" });
      expect(r.status).toBe(409);
    });
    it("201s on the first call and adds the detail comment", async () => {
      const { a, deps } = app();
      const r = await request(a).post(`/api/approvals/${ID}/details`).set("authorization", `Bearer ${TOKEN}`).send({ text: "the full email body", version: "v1" });
      expect(r.status).toBe(201);
      expect(r.body.commentId).toBe("comment-1");
      expect(deps.addDetails).toHaveBeenCalledWith(ID, "the full email body", "v1", "agent-1");
    });
    it("200s with existing:true on a retry of the same version, and adds nothing", async () => {
      const { a, deps } = app({
        getApproval: vi.fn(async () => ({
          id: ID,
          companyId: "co",
          status: "pending",
          requestedByAgentId: "agent-1",
          payload: { details: { version: "v1", commentId: "comment-1" } },
        })),
      });
      const r = await request(a).post(`/api/approvals/${ID}/details`).set("authorization", `Bearer ${TOKEN}`).send({ text: "the full email body", version: "v1" });
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ commentId: "comment-1", existing: true });
      expect(deps.addDetails).not.toHaveBeenCalled();
    });
  });
});
