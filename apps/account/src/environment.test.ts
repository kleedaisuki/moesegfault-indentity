import { describe, expect, it } from "vitest";
import { accountLoginUrl, resolveIdentityOrigin } from "./environment";

describe("resolveIdentityOrigin", () => {
  it("isolates production, staging and development", () => { expect(resolveIdentityOrigin({ hostname: "account.moesegfault.dev" } as Location)).toBe("https://identity.moesegfault.dev"); expect(resolveIdentityOrigin({ hostname: "account-staging.moesegfault.dev" } as Location)).toBe("https://identity-staging.moesegfault.dev"); expect(resolveIdentityOrigin({ hostname: "localhost" } as Location)).toBe("http://localhost:8787"); });
  it("honors explicit preview origins", () => { expect(resolveIdentityOrigin({ hostname: "preview.example" } as Location, "https://api-preview.example")).toBe("https://api-preview.example"); });
});

describe("accountLoginUrl", () => {
  it("preserves a deep route in the matching environment", () => {
    expect(accountLoginUrl({ hostname: "account-staging.moesegfault.dev" }, "/security")).toBe("https://login-staging.moesegfault.dev/login?return_uri=https%3A%2F%2Faccount-staging.moesegfault.dev%2Fsecurity");
  });
});
