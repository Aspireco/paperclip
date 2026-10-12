// Aspireco: a decision on a tool action's formal approval settles the held action in the same click,
// and an approval whose action already expired is refused and cleared instead of recorded.
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hoistModuleGraph } from "./helpers/hoist-module-graph.js";

const mockApprovalService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  cancel: vi.fn(),
  requestRevision: vi.fn(),
  resubmit: vi.fn(),
  listComments: vi.fn(),
  addComment: vi.fn(),
}));
const mockHeartbeatService = vi.hoisted(() => ({ wakeup: vi.fn() }));
const mockIssueApprovalService = vi.hoisted(() => ({
  listIssuesForApproval: vi.fn(),
  linkManyForApproval: vi.fn(),
}));
const mockSecretService = vi.hoisted(() => ({ normalizeHireApprovalPayloadForPersistence: vi.fn() }));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockAccessService = vi.hoisted(() => ({ decide: vi.fn() }));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    approvalService: () => mockApprovalService,
    heartbeatService: () => mockHeartbeatService,
    issueApprovalService: () => mockIssueApprovalService,
    logActivity: mockLogActivity,
    secretService: () => mockSecretService,
  }));
}

const routeModules = hoistModuleGraph(registerModuleMocks, async () => {
  const { errorHandler } = await import("../middleware/index.js");
  const { approvalRoutes } = await import("../routes/approvals.js");
  return { errorHandler, approvalRoutes };
});

// Answers db.select().from(table).where(...).limit(n) with the held action request, and the
// approve route's other reads (heartbeat runs) with nothing.
function dbWithHeldAction(held: Record<string, unknown> | null) {
  if (held) held = { approvalId: "approval-1", companyId: "company-1", ...held };
  const chain = (rows: unknown[]) => {
    const result = Promise.resolve(rows);
    return Object.assign(result, { limit: () => Promise.resolve(rows) });
  };
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({ where: vi.fn(() => chain(held ? [held] : [])) })),
    })),
  } as any;
}

const toolActions = { approve: vi.fn(), decline: vi.fn() };

async function createApp(held: Record<string, unknown> | null) {
  const { errorHandler, approvalRoutes } = routeModules.value;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = { type: "board", userId: "john", companyIds: ["company-1"], source: "session", isInstanceAdmin: false };
    next();
  });
  app.use("/api", approvalRoutes(dbWithHeldAction(held), { toolActions }));
  app.use(errorHandler);
  return app;
}

const toolApproval = (status = "pending") => ({
  id: "approval-1",
  companyId: "company-1",
  type: "request_board_approval",
  status,
  payload: { source: "tool_gateway", actionRequestId: "action-1", tool: "mail-send" },
  requestedByAgentId: "agent-1",
});

describe("Aspireco: tool action approvals are one click", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({ allowed: true, action: "company_scope:read", reason: "allow_test", explanation: "ok" });
    mockHeartbeatService.wakeup.mockResolvedValue({ id: "wake-1" });
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([{ id: "issue-1" }]);
    mockLogActivity.mockResolvedValue(undefined);
    mockApprovalService.getById.mockResolvedValue(toolApproval());
    toolActions.approve.mockResolvedValue({ status: "executed" });
    toolActions.decline.mockResolvedValue({ status: "rejected" });
  });

  it("approving the formal approval releases the held action as the same user", async () => {
    mockApprovalService.approve.mockResolvedValue({ approval: toolApproval("approved"), applied: true });

    const res = await request(await createApp({ id: "action-1", status: "pending", expiresAt: new Date(Date.now() + 60_000) }))
      .post("/api/approvals/approval-1/approve").send({});

    expect(res.status).toBe(200);
    expect(toolActions.approve).toHaveBeenCalledWith({
      companyId: "company-1", actionRequestId: "action-1", actor: { userId: "john" },
    });
  });

  it("approving after the action expired is refused, cleared, and runs nothing", async () => {
    const res = await request(await createApp({ id: "action-1", status: "pending", expiresAt: new Date(Date.now() - 1_000) }))
      .post("/api/approvals/approval-1/approve").send({});

    expect(res.status).toBe(409);
    expect(res.body.reasonCode).toBe("action_expired");
    expect(mockApprovalService.cancel).toHaveBeenCalledWith("approval-1", "Expired before a decision; nothing was run.");
    expect(mockApprovalService.approve).not.toHaveBeenCalled();
    expect(toolActions.approve).not.toHaveBeenCalled();
  });

  it("an action the sweep already expired is refused the same way", async () => {
    const res = await request(await createApp({ id: "action-1", status: "expired", expiresAt: new Date(Date.now() - 1_000) }))
      .post("/api/approvals/approval-1/approve").send({});

    expect(res.status).toBe(409);
    expect(toolActions.approve).not.toHaveBeenCalled();
  });

  it("rejecting the formal approval declines the held action", async () => {
    mockApprovalService.reject.mockResolvedValue({ approval: toolApproval("rejected"), applied: true });

    const res = await request(await createApp({ id: "action-1", status: "pending" }))
      .post("/api/approvals/approval-1/reject").send({ decisionNote: "not this one" });

    expect(res.status).toBe(200);
    expect(toolActions.decline).toHaveBeenCalledWith({
      companyId: "company-1", actionRequestId: "action-1", actor: { userId: "john" }, reason: "not this one",
    });
  });

  it("a release that fails still records the approval and answers 200", async () => {
    mockApprovalService.approve.mockResolvedValue({ approval: toolApproval("approved"), applied: true });
    toolActions.approve.mockRejectedValue(new Error("provider down"));

    const res = await request(await createApp({ id: "action-1", status: "pending", expiresAt: null }))
      .post("/api/approvals/approval-1/approve").send({});

    expect(res.status).toBe(200);
  });

  it("an approval that only names someone else's held action releases nothing (no laundering)", async () => {
    // An agent can create an approval with any payload; only the gateway pairs an action to its approval.
    mockApprovalService.approve.mockResolvedValue({ approval: toolApproval("approved"), applied: true });

    const res = await request(await createApp({ id: "action-1", status: "pending", approvalId: "the-real-approval", expiresAt: null }))
      .post("/api/approvals/approval-1/approve").send({});

    expect(res.status).toBe(200);
    expect(toolActions.approve).not.toHaveBeenCalled();
    expect(mockApprovalService.cancel).not.toHaveBeenCalled();
  });

  it("a forged reference to another company's action releases nothing", async () => {
    mockApprovalService.approve.mockResolvedValue({ approval: toolApproval("approved"), applied: true });

    const res = await request(await createApp({ id: "action-1", status: "pending", companyId: "company-2", expiresAt: null }))
      .post("/api/approvals/approval-1/approve").send({});

    expect(res.status).toBe(200);
    expect(toolActions.approve).not.toHaveBeenCalled();
  });

  it("rejecting an approval that only names someone else's held action declines nothing", async () => {
    mockApprovalService.reject.mockResolvedValue({ approval: toolApproval("rejected"), applied: true });

    const res = await request(await createApp({ id: "action-1", status: "pending", approvalId: "the-real-approval" }))
      .post("/api/approvals/approval-1/reject").send({});

    expect(res.status).toBe(200);
    expect(toolActions.decline).not.toHaveBeenCalled();
  });

  it("ordinary approvals are untouched", async () => {
    const hire = { id: "approval-1", companyId: "company-1", type: "hire_agent", status: "pending", payload: {}, requestedByAgentId: "agent-1" };
    mockApprovalService.getById.mockResolvedValue(hire);
    mockApprovalService.approve.mockResolvedValue({ approval: { ...hire, status: "approved" }, applied: true });

    const res = await request(await createApp(null)).post("/api/approvals/approval-1/approve").send({});

    expect(res.status).toBe(200);
    expect(toolActions.approve).not.toHaveBeenCalled();
    expect(mockApprovalService.cancel).not.toHaveBeenCalled();
  });
});
