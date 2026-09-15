import { describe, expect, it } from "vitest";
import { resolveIdentityOrigin } from "./environment";

describe("resolveIdentityOrigin", () => {
  it("isolates production, staging and development", () => { expect(resolveIdentityOrigin({ hostname: "account.moesegfault.dev" } as Location)).toBe("https://identity.moesegfault.dev"); expect(resolveIdentityOrigin({ hostname: "account-staging.moesegfault.dev" } as Location)).toBe("https://identity-staging.moesegfault.dev"); expect(resolveIdentityOrigin({ hostname: "localhost" } as Location)).toBe("http://localhost:8787"); });
  it("honors explicit preview origins", () => { expect(resolveIdentityOrigin({ hostname: "preview.example" } as Location, "https://api-preview.example")).toBe("https://api-preview.example"); });
});
