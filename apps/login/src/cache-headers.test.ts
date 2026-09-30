import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Login static cache policy", () => {
  const headers = readFileSync(new URL("../public/_headers", import.meta.url), "utf8");

  it("detaches the broad no-store rule before caching hashed JavaScript and CSS", () => {
    for (const extension of ["js", "css"]) {
      const rule = headers.split(`/assets/index-*.${extension}\n`)[1]?.split(/\n\s*\n/u)[0];
      expect(rule).toMatch(/^\s*! Cache-Control\s*\n\s*Cache-Control: public, max-age=31536000, immutable\s*$/u);
    }
  });

  it("keeps HTML and unhashed public assets out of immutable caching", () => {
    expect(headers).toMatch(/^\/\*\s*\n\s*Cache-Control: no-store, no-transform/u);
    expect(headers).not.toMatch(/^\/assets\/\*\s*$/mu);
    expect(headers).not.toMatch(/^\/(?:assets\/.*\.svg|\*)\s*\n\s*(?:! Cache-Control\s*\n\s*)?Cache-Control:.*immutable/mu);
  });
});
