import { describe, expect, it } from "vitest";
import { resolveRoute } from "./router";

describe("resolveRoute", () => {
  it("accepts known routes and strips trailing slashes", () => { expect(resolveRoute("/security/")).toBe("/security"); expect(resolveRoute("/apps")).toBe("/apps"); });
  it("normalizes unknown routes to overview", () => { expect(resolveRoute("/old-account-page")).toBe("/"); });
});
