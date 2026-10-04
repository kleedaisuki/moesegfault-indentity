import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Account static cache policy", () => {
  const headers = readFileSync(new URL("../public/_headers", import.meta.url), "utf8");

  it("gives only content-hashed entry JavaScript and CSS an immutable policy", () => {
    for (const extension of ["js", "css"]) {
      const rule = headers.split(`/assets/index-*.${extension}\n`)[1]?.split(/\n\s*\n/u)[0];
      expect(rule).toMatch(/^\s*! Cache-Control\s*\n\s*Cache-Control: public, max-age=31536000, immutable\s*$/u);
    }
    expect(headers).not.toMatch(/^\/assets\/\*\s*$/mu);
    expect(headers).not.toMatch(/^\/(?:icons\/\*|\*)\s*\n\s*(?:! Cache-Control\s*\n\s*)?Cache-Control:.*immutable/mu);
  });

  it("permits only fixed Subscribe deployments while forbidding Account embedding", () => {
    expect(headers).toContain("frame-src https://subscribe.moesegfault.dev https://subscribe-staging.moesegfault.dev;");
    expect(headers).toContain("frame-ancestors 'none'");
  });

  it("preserves the broad security policy while changing only cache headers", () => {
    const broad = headers.split("# Vite")[0];
    expect(broad).toContain("Content-Security-Policy:");
    expect(broad).toContain("X-Content-Type-Options: nosniff");
    expect(broad).not.toContain("immutable");
  });
});
