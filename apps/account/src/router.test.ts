import { describe, expect, it } from "vitest";
import { ACCOUNT_ROUTES } from "@moesegfault/frontend-shared";
import { resolveRoute } from "./router";

describe("resolveRoute", () => {
  it("accepts every shared Account return route", () => {
    for (const route of ACCOUNT_ROUTES) expect(resolveRoute(route)).toBe(route);
  });
  it("accepts known routes and strips trailing slashes", () => { expect(resolveRoute("/security/")).toBe("/security"); expect(resolveRoute("/apps")).toBe("/apps"); });
  it("normalizes unknown routes to overview", () => { expect(resolveRoute("/old-account-page")).toBe("/"); });
});
