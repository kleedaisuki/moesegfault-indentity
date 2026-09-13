import { describe, expect, it } from "vitest";
import { resolveIdentityOrigin } from "./environment";

describe("resolveIdentityOrigin", () => {
  it("keeps staging and production authorities isolated", () => {
    expect(resolveIdentityOrigin({ hostname: "login-staging.moesegfault.dev" } as Location))
      .toBe("https://identity-staging.moesegfault.dev");
    expect(resolveIdentityOrigin({ hostname: "login.moesegfault.dev" } as Location))
      .toBe("https://identity.moesegfault.dev");
  });

  it("uses local Worker development and explicit preview overrides", () => {
    expect(resolveIdentityOrigin({ hostname: "localhost" } as Location)).toBe("http://localhost:8787");
    expect(resolveIdentityOrigin({ hostname: "preview.example" } as Location, "https://identity-preview.example"))
      .toBe("https://identity-preview.example");
  });
});
