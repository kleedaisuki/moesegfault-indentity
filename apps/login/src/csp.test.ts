import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Login static Content Security Policy", () => {
  it("allows the processed-avatar object URL used by the registration preview", () => {
    const headers = readFileSync(new URL("../public/_headers", import.meta.url), "utf8");

    expect(headers).toMatch(/img-src[^;]*\bblob:/u);
  });
});
