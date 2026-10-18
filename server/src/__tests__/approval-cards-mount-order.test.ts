import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Live 2026-10-18: mounted after the actor middleware, the Hermes card routes answered every
// Hermes call with 401 "Agent token did not verify" (the middleware treats any bearer as an agent
// key). The routes' own tests mount them alone, so only the app's order can catch this.
describe("approval card routes in app.ts", () => {
  it("are mounted before the actor middleware", () => {
    const src = readFileSync(new URL("../app.ts", import.meta.url), "utf8");
    const mount = src.indexOf("approvalCardsRouter ? approvalCardsRouter(req, res, next) : next()");
    const actor = src.indexOf("actorMiddleware(db,");
    expect(mount).toBeGreaterThan(0);
    expect(actor).toBeGreaterThan(0);
    expect(mount).toBeLessThan(actor);
  });
});
