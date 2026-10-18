// Aspireco: John's reply to a Telegram Change prompt lands on the approval's linked issue as his
// comment, and the requesting agent is woken on that issue with the comment as its wake comment,
// the same task context an ordinary issue-comment wake carries.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hoistModuleGraph } from "./helpers/hoist-module-graph.js";

const mockApprovalService = vi.hoisted(() => ({
  getById: vi.fn(),
  addComment: vi.fn(),
}));
const mockHeartbeatService = vi.hoisted(() => ({ wakeup: vi.fn() }));
const mockIssueApprovalService = vi.hoisted(() => ({ listIssuesForApproval: vi.fn() }));
const mockIssueService = vi.hoisted(() => ({ addComment: vi.fn() }));
const mockLogActivity = vi.hoisted(() => vi.fn());

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => ({ decide: vi.fn() }),
    approvalService: () => mockApprovalService,
    heartbeatService: () => mockHeartbeatService,
    issueApprovalService: () => mockIssueApprovalService,
    logActivity: mockLogActivity,
    secretService: () => ({}),
  }));
  vi.doMock("../services/issues.js", () => ({
    issueService: () => mockIssueService,
  }));
}

const routeModules = hoistModuleGraph(registerModuleMocks, async () => {
  const { approvalRoutes } = await import("../routes/approvals.js");
  return { approvalRoutes };
});

describe("Change reply comment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApprovalService.addComment.mockResolvedValue({ id: "acomment-1", companyId: "company-1" });
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-1",
      companyId: "company-1",
      requestedByAgentId: "agent-1",
    });
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([{ id: "issue-1" }, { id: "issue-2" }]);
    mockIssueService.addComment.mockImplementation(async (issueId: string) => ({ id: `icomment-${issueId}` }));
    mockHeartbeatService.wakeup.mockResolvedValue({ id: "wake-1" });
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("posts the note on each linked issue as John and wakes the agent on the issue with that comment", async () => {
    const router = routeModules.value.approvalRoutes({} as any);
    await router.addComment("approval-1", "john", "make it shorter, mention Friday");

    expect(mockApprovalService.addComment).toHaveBeenCalledWith("approval-1", "make it shorter, mention Friday", { userId: "john" });
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      "issue-1", "make it shorter, mention Friday", { userId: "john" }, { authorType: "user" },
    );
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      "issue-2", "make it shorter, mention Friday", { userId: "john" }, { authorType: "user" },
    );

    expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1);
    const [agentId, wake] = mockHeartbeatService.wakeup.mock.calls[0];
    expect(agentId).toBe("agent-1");
    expect(wake.reason).toBe("approval_change_requested");
    expect(wake.requestedByActorId).toBe("john");
    expect(wake.payload).toMatchObject({
      approvalId: "approval-1",
      issueId: "issue-1",
      issueIds: ["issue-1", "issue-2"],
      commentId: "icomment-issue-1",
    });
    expect(wake.contextSnapshot).toMatchObject({
      approvalId: "approval-1",
      issueId: "issue-1",
      taskId: "issue-1",
      issueIds: ["issue-1", "issue-2"],
      commentId: "icomment-issue-1",
      wakeCommentId: "icomment-issue-1",
      wakeReason: "approval_change_requested",
    });
  });

  it("wakes on the first issue whose comment landed when an earlier mirror fails", async () => {
    mockIssueService.addComment.mockImplementation(async (issueId: string) => {
      if (issueId === "issue-1") throw new Error("issue locked");
      return { id: `icomment-${issueId}` };
    });
    const router = routeModules.value.approvalRoutes({} as any);
    await router.addComment("approval-1", "john", "note");

    const [, wake] = mockHeartbeatService.wakeup.mock.calls[0];
    expect(wake.contextSnapshot).toMatchObject({
      issueId: "issue-2",
      taskId: "issue-2",
      wakeCommentId: "icomment-issue-2",
    });
  });

  it("still wakes on the linked issue, without a wake comment, when no mirror landed", async () => {
    mockIssueService.addComment.mockRejectedValue(new Error("down"));
    const router = routeModules.value.approvalRoutes({} as any);
    await router.addComment("approval-1", "john", "note");

    const [, wake] = mockHeartbeatService.wakeup.mock.calls[0];
    expect(wake.contextSnapshot).toMatchObject({ issueId: "issue-1", taskId: "issue-1" });
    expect(wake.contextSnapshot.wakeCommentId).toBeUndefined();
    expect(wake.payload.commentId).toBeUndefined();
  });
});
