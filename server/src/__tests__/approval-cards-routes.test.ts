import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { approvalCardRoutes } from "../routes/approval-cards.js";

const ID = "5c615cd0-e659-4837-837f-bf7e56f3cb7f";
const TOKEN = "hermes-test-token"; // pragma: allowlist secret

function app(over: Partial<Parameters<typeof approvalCardRoutes>[0]> = {}) {
  const deps = {
    hermesToken: TOKEN,
    getApproval: vi.fn(async () => ({ id: ID, companyId: "co", status: "pending" })),
    toolAction: vi.fn(async () => ({ tool: "mail_send", arguments: { op: "send_draft", params: { id: "d1" }, body: { expectedHash: "ab" } }, expiresAt: "2026-10-16T00:00:00Z" })),
    cards: { send: vi.fn(async () => ({ ok: true, messageIds: [1] })), settle: vi.fn(async () => {}), hasCard: () => false },
    decideApproval: vi.fn(async () => ({ outcome: "decided", approval: { id: ID, status: "approved" }, applied: true })),
    rejectApproval: vi.fn(async () => ({ id: ID, status: "rejected" })),
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
    await request(a).post(`/api/approvals/${ID}/supersede`).set("authorization", `Bearer ${TOKEN}`);
    expect(deps.rejectApproval).toHaveBeenCalledWith(ID, "superseded: the content changed after the card");
    expect(deps.cards.settle).toHaveBeenCalledWith(ID, "↩️ Superseded - a new card follows");
  });
});
