import { readFileSync } from "node:fs";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { nonDecidingUserGuard, nonDecidingUserIds } from "../middleware/non-deciding-users.js";

const ENV = { PAPERCLIP_NON_DECIDING_USER_IDS: " svc-admin , ,other-svc" } as NodeJS.ProcessEnv;

function createApp(actor: Record<string, unknown>, env: NodeJS.ProcessEnv = ENV) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use(nonDecidingUserGuard(env));
  app.all("/{*rest}", (_req, res) => {
    res.status(200).json({ reached: true });
  });
  return app;
}

const svc = { type: "board", userId: "svc-admin", source: "board_key", isInstanceAdmin: false };
const john = { type: "board", userId: "john", source: "session", isInstanceAdmin: true };
const agent = { type: "agent", agentId: "agent-1", companyId: "c1" };

const DECISIONS: Array<[string, string]> = [
  ["post", "/api/approvals/a1/approve"],
  ["post", "/api/approvals/a1/reject"],
  ["post", "/api/approvals/a1/request-revision"],
  ["post", "/api/approvals/a1/resubmit"],
  ["post", "/api/approvals/a1/auto-approve"],
  ["post", "/api/agents/a1/approve"],
  ["post", "/api/tool-gateway/action-requests/r1/approve"],
  ["post", "/api/issues/i1/interactions/x1/accept"],
  ["post", "/api/issues/i1/stalled-review-decision"],
  ["post", "/api/decisions/d1/decide"],
  ["post", "/api/companies/c1/join-requests/j1/approve"],
  ["post", "/api/companies/c1/secret-proposals/s1/approve"],
  ["post", "/api/cli-auth/challenges/x/approve"],
  ["post", "/api/board-api-keys"],
  ["post", "/api/companies/c1/agents"],
  ["patch", "/api/companies/c1"],
  ["patch", "/api/agents/a1"],
  ["delete", "/api/issues/i1"],
  ["post", "/API/approvals/a1/approve"],
  ["post", "/api/Companies/c1/issues"],
  ["post", "/api/companies/c1/issues/extra"],
];

describe("nonDecidingUserIds", () => {
  it("parses a comma list, trimming blanks", () => {
    expect([...nonDecidingUserIds(ENV)]).toEqual(["svc-admin", "other-svc"]);
    expect(nonDecidingUserIds({} as NodeJS.ProcessEnv).size).toBe(0);
  });
});

describe("nonDecidingUserGuard", () => {
  it.each(DECISIONS)("refuses %s %s for a listed user", async (method, path) => {
    const res = await (request(createApp(svc)) as any)[method](path).send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("decision_not_allowed");
  });

  it.each([
    ["post", "/api/companies/c1/issues"],
    ["patch", "/api/issues/NOR-1"],
    ["post", "/api/issues/i1/comments"],
    ["post", "/api/agents/a1/pause"],
    ["post", "/api/agents/a1/resume"],
    ["put", "/api/agents/a1/instructions-bundle/file"],
    ["get", "/api/approvals/a1"],
    ["get", "/api/companies/c1/issues?status=todo"],
  ])("lets a listed user %s %s", async (method, path) => {
    const res = await (request(createApp(svc)) as any)[method](path).send({});
    expect(res.status).toBe(200);
  });

  it.each(DECISIONS)("leaves other users alone: %s %s", async (method, path) => {
    expect((await (request(createApp(john)) as any)[method](path).send({})).status).toBe(200);
    expect((await (request(createApp(agent)) as any)[method](path).send({})).status).toBe(200);
  });

  it("does nothing when no user is listed", async () => {
    const res = await request(createApp(svc, {} as NodeJS.ProcessEnv)).post("/api/approvals/a1/approve").send({});
    expect(res.status).toBe(200);
  });

  it("is mounted after the actor and Cloud control middleware", () => {
    const app = readFileSync(new URL("../app.ts", import.meta.url), "utf8");
    const actor = app.indexOf("actorMiddleware(db");
    const cloud = app.indexOf("app.use(cloudControlMiddleware());");
    const guard = app.indexOf("app.use(nonDecidingUserGuard());");
    const apiMount = app.indexOf('app.use("/api", api);');
    expect(actor).toBeGreaterThan(0);
    expect(guard).toBeGreaterThan(cloud);
    expect(cloud).toBeGreaterThan(actor);
    expect(apiMount).toBeGreaterThan(guard);
  });
});
