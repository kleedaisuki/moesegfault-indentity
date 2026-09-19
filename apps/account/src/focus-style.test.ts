import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Account route focus styling", () => {
  it("does not draw the global focus ring around the programmatically focused main landmark", () => {
    const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

    expect(styles).toMatch(/main\[tabindex="-1"\]:focus-visible\s*\{\s*outline:\s*none/u);
  });
});
