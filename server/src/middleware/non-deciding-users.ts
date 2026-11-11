// Aspireco: board users that can never decide anything (PAPERCLIP_NON_DECIDING_USER_IDS, comma separated).
//
// Built for the Paperclip Admin service user: an operator member whose board key lives in a service the
// DSH Holding agents call. Any non-viewer member can approve, reject or accept at the server level
// (approvals, tool-gateway action requests, interactions, decisions, join requests, secret proposals,
// CLI-auth challenges...), so instead of patching each of those routes, a listed user may only READ, plus
// the few writes below. Every decision route is refused by default, including ones added later.
import type { Request, RequestHandler } from "express";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const ALLOWED_WRITES: ReadonlyArray<{ method: string; path: RegExp }> = [
  { method: "POST", path: /^\/api\/companies\/[^/]+\/issues$/ },
  { method: "PATCH", path: /^\/api\/issues\/[^/]+$/ },
  { method: "POST", path: /^\/api\/issues\/[^/]+\/comments$/ },
  { method: "POST", path: /^\/api\/agents\/[^/]+\/(pause|resume)$/ },
  { method: "PUT", path: /^\/api\/agents\/[^/]+\/instructions-bundle\/file$/ },
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
  return ALLOWED_WRITES.some((allowed) => allowed.method === req.method && allowed.path.test(path));
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
