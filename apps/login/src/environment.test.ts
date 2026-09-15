import { describe, expect, it } from "vitest";
import { resolveAccountOrigin, resolveAccountReturnUri, resolveIdentityOrigin } from "./environment";

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

  it("keeps Account return links in the matching environment", () => {
    expect(resolveAccountOrigin({ hostname: "login-staging.moesegfault.dev" })).toBe("https://account-staging.moesegfault.dev");
    expect(resolveAccountOrigin({ hostname: "login.moesegfault.dev" })).toBe("https://account.moesegfault.dev");
    expect(resolveAccountOrigin({ hostname: "localhost" })).toBe("http://localhost:5174");
  });

  it("accepts only same-environment Account return URIs", () => {
    expect(resolveAccountReturnUri({ hostname: "login-staging.moesegfault.dev", href: "https://login-staging.moesegfault.dev/passkey/enroll?return_uri=https%3A%2F%2Faccount-staging.moesegfault.dev%2Fsecurity" })).toBe("https://account-staging.moesegfault.dev/security");
    expect(resolveAccountReturnUri({ hostname: "login-staging.moesegfault.dev", href: "https://login-staging.moesegfault.dev/passkey/enroll?return_uri=https%3A%2F%2Faccount.moesegfault.dev%2Fsecurity" })).toBe("https://account-staging.moesegfault.dev");
    expect(resolveAccountReturnUri({ hostname: "login.moesegfault.dev", href: "https://login.moesegfault.dev/passkey/enroll?return_uri=javascript%3Aalert(1)" })).toBe("https://account.moesegfault.dev");
  });
});
