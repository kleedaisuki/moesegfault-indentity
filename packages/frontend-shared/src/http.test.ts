import { describe, expect, it } from "vitest";
import { apiOrigin, parseProblem } from "./http";

describe("apiOrigin", () => {
  it("returns the normalized origin and rejects path, query, fragment, or non-HTTP schemes", () => {
    expect(apiOrigin("https://identity.example/")).toBe("https://identity.example");
    for (const value of ["https://identity.example/v1", "https://identity.example/?x=1", "https://identity.example/#x", "javascript:alert(1)"]) {
      expect(() => apiOrigin(value)).toThrow(TypeError);
    }
  });
});

describe("parseProblem", () => {
  it("accepts JSON Problem Details while ignoring HTML and malformed JSON", async () => {
    expect(await parseProblem<{ title: string }>(new Response('{"title":"Conflict"}', { headers: { "content-type": "application/problem+json" } })))
      .toEqual({ title: "Conflict" });
    expect(await parseProblem(new Response("<h1>Proxy failure</h1>", { headers: { "content-type": "text/html" } }))).toBeUndefined();
    expect(await parseProblem(new Response("{", { headers: { "content-type": "application/json" } }))).toBeUndefined();
  });
});
