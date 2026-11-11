// Aspireco: board users that can never decide anything (PAPERCLIP_NON_DECIDING_USER_IDS, comma separated).
//
// Built for the Paperclip Admin service user: an operator member whose board key lives in a service the
// DSH Holding agents call. Any non-viewer member can approve, reject or accept at the server level
// (approvals, tool-gateway action requests, interactions, decisions, join requests, secret proposals,
// CLI-auth challenges...), so instead of patching each of those routes, a listed user may only READ, plus
// the few writes below. Every decision route is refused by default, including ones added later.
import type { Request, RequestHandler } from "express";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Each allowed write also limits the body to plain fields, so a listed user cannot set an execution policy,
// a review request or interaction, a review policy, or anything else that records a decision.
const ALLOWED_WRITES: ReadonlyArray<{ method: string; path: RegExp; fields: readonly string[] }> = [
  {
    method: "POST",
    path: /^\/api\/companies\/[^/]+\/issues$/,
    fields: ["title", "description", "assigneeAgentId", "priority", "status", "parentId", "projectId"],
  },
  {
    method: "PATCH",
    path: /^\/api\/issues\/[^/]+$/,
    fields: ["title", "description", "status", "priority", "assigneeAgentId", "comment"],
  },
  { method: "POST", path: /^\/api\/issues\/[^/]+\/comments$/, fields: ["body"] },
  { method: "POST", path: /^\/api\/agents\/[^/]+\/(pause|resume)$/, fields: [] },
  { method: "PUT", path: /^\/api\/agents\/[^/]+\/instructions-bundle\/file$/, fields: ["path", "content", "baseHash"] },
];

export function nonDecidingUserIds(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  return new Set(
    (env.PAPERCLIP_NON_DECIDING_USER_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

function isAllowedWrite(req: Request): boolean {
  const path = req.originalUrl.split("?")[0];
  const allowed = ALLOWED_WRITES.find((entry) => entry.method === req.method && entry.path.test(path));
  if (!allowed) return false;
  const body: unknown = req.body ?? {};
  if (typeof body !== "object" || Array.isArray(body)) return false;
  return Object.keys(body).every((key) => allowed.fields.includes(key));
}

/** True for a board actor listed in PAPERCLIP_NON_DECIDING_USER_IDS (route handlers use it to refuse review sign-offs). */
export function isNonDecidingActor(req: Request, env: NodeJS.ProcessEnv = process.env): boolean {
  const actor = req.actor;
  return actor?.type === "board" && !!actor.userId && nonDecidingUserIds(env).has(actor.userId);
}

export function nonDecidingUserGuard(env: NodeJS.ProcessEnv = process.env): RequestHandler {
  const listed = nonDecidingUserIds(env);
  return (req, res, next) => {
    if (listed.size === 0 || SAFE_METHODS.has(req.method)) return next();
    const actor = req.actor;
    if (actor?.type !== "board" || !actor.userId || !listed.has(actor.userId)) return next();
    if (isAllowedWrite(req)) return next();
    res.status(403).json({
      error: "This user can never decide approvals and may only make a few listed changes.",
      code: "decision_not_allowed",
    });
  };
}
