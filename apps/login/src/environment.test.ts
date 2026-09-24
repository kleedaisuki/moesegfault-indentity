import { describe, expect, it } from "vitest";
import { ACCOUNT_ROUTES } from "@moesegfault/frontend-shared";
import { resolveAccountOrigin, resolveAccountReturnUri, resolveIdentityOrigin, validateAccountReturnUri } from "./environment";

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

  it("allows only exact known Account paths without extra URL components", () => {
    const login = "https://login.moesegfault.dev/login?return_uri=";
    expect(validateAccountReturnUri({ hostname: "login.moesegfault.dev", href: `${login}${encodeURIComponent("https://account.moesegfault.dev/security")}` })).toBe("https://account.moesegfault.dev/security");
    expect(validateAccountReturnUri({ hostname: "login.moesegfault.dev", href: `${login}${encodeURIComponent("https://account.moesegfault.dev/security/")}` })).toBeUndefined();
    expect(validateAccountReturnUri({ hostname: "login.moesegfault.dev", href: `${login}${encodeURIComponent("https://account.moesegfault.dev/security?next=https://evil.example")}` })).toBeUndefined();
    expect(validateAccountReturnUri({ hostname: "login.moesegfault.dev", href: `${login}${encodeURIComponent("https://account.moesegfault.dev/unknown")}` })).toBeUndefined();
    expect(validateAccountReturnUri({ hostname: "login.moesegfault.dev", href: `${login}${encodeURIComponent("https://account-staging.moesegfault.dev/security")}` })).toBeUndefined();
  });

  it("accepts every Account route from the shared route contract", () => {
    for (const route of ACCOUNT_ROUTES) {
      const target = `https://account.moesegfault.dev${route}`;
      expect(validateAccountReturnUri({
        hostname: "login.moesegfault.dev",
        href: `https://login.moesegfault.dev/login?return_uri=${encodeURIComponent(target)}`,
      })).toBe(target);
    }
  });
});
