import { describe, expect, it } from "vitest";
import { frontendOrigins } from "./environment";

describe("frontendOrigins", () => {
  it("keeps both application hostnames in one staging environment", () => {
    for (const hostname of ["login-staging.moesegfault.dev", "account-staging.moesegfault.dev"]) {
      expect(frontendOrigins(hostname)).toEqual({
        identity: "https://identity-staging.moesegfault.dev",
        login: "https://login-staging.moesegfault.dev",
        account: "https://account-staging.moesegfault.dev",
      });
    }
  });

  it("preserves localhost, loopback and unknown-host fallbacks", () => {
    expect(frontendOrigins("127.0.0.1")).toEqual(frontendOrigins("localhost"));
    expect(frontendOrigins("localhost").login).toBe("http://localhost:5173");
    expect(frontendOrigins("preview.example").identity).toBe("https://identity.moesegfault.dev");
  });
});
