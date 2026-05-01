const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(
  path.join(__dirname, "../server/routes/sessions.js"),
  "utf8"
);

describe("session route guardrails", () => {
  test("topics route is registered before the session-code catch-all", () => {
    const topicsRouteIndex = source.indexOf("router.get('/topics'");
    const sessionCodeRouteIndex = source.indexOf("router.get('/:code'");

    expect(topicsRouteIndex).toBeGreaterThan(-1);
    expect(sessionCodeRouteIndex).toBeGreaterThan(-1);
    expect(topicsRouteIndex).toBeLessThan(sessionCodeRouteIndex);
  });

  test("raw session data routes require session access checks", () => {
    const protectedRoutes = [
      "router.get('/:code/source-text'",
      "router.get('/:code'",
      "router.post('/:code/materials'",
      "router.post('/:code/prime'",
      "router.get('/:code/messages'",
      "router.get('/:shortCode/analytics'",
      "router.post('/:shortCode/teacher-notes'",
      "router.delete('/:code/materials/:materialId'"
    ];

    for (const route of protectedRoutes) {
      const routeStart = source.indexOf(route);
      expect(routeStart).toBeGreaterThan(-1);
      const nextRouteStart = source.indexOf("\nrouter.", routeStart + route.length);
      const routeBody = source.slice(routeStart, nextRouteStart === -1 ? source.length : nextRouteStart);
      expect(routeBody).toContain("requireSessionAccess");
    }
  });

  test("signed session access can reach analytics routes before auth account checks", () => {
    expect(source).toContain("router.get('/:shortCode/analytics', async");
    expect(source).toContain("router.post('/:shortCode/teacher-notes', async");
    expect(source).not.toContain("router.get('/:shortCode/analytics', requireAuth");
    expect(source).not.toContain("router.post('/:shortCode/teacher-notes', requireAuth");
  });
});
