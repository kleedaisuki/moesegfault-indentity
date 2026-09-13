import { describe, expect, it } from "vitest";
import type { PublicKeyCredentialCreationOptionsJson, PublicKeyCredentialRequestOptionsJson } from "../api/types";
import { decodeBase64Url, decodeCreationOptions, decodeRequestOptions, encodeBase64Url } from "./json";

describe("WebAuthn JSON adapters", () => {
  it("round-trips arbitrary binary through unpadded Base64URL", () => {
    const bytes = Uint8Array.from([0, 1, 2, 127, 128, 250, 255]);
    const encoded = encodeBase64Url(bytes);

    expect(encoded).toBe("AAECf4D6_w");
    expect([...new Uint8Array(decodeBase64Url(encoded))]).toEqual([...bytes]);
  });

  it("decodes registration challenge, user ID, and excluded credential IDs", () => {
    const json: PublicKeyCredentialCreationOptionsJson = {
      challenge: "AQID",
      rp: { id: "login.moesegfault.dev", name: "moeSegFault" },
      user: { id: "BAUG", name: "klee", display_name: "Klee" },
      pub_key_cred_params: [{ type: "public-key", alg: -7 }],
      exclude_credentials: [{ type: "public-key", id: "BwgJ", transports: ["internal"] }],
    };

    const decoded = decodeCreationOptions(json);

    expect([...new Uint8Array(decoded.challenge as ArrayBuffer)]).toEqual([1, 2, 3]);
    expect([...new Uint8Array(decoded.user.id as ArrayBuffer)]).toEqual([4, 5, 6]);
    expect([...new Uint8Array((decoded.excludeCredentials?.[0]?.id ?? new ArrayBuffer()) as ArrayBuffer)]).toEqual([7, 8, 9]);
  });

  it("decodes assertion challenge and allowCredentials without mutating JSON", () => {
    const json: PublicKeyCredentialRequestOptionsJson = {
      challenge: "AQI",
      rp_id: "login.moesegfault.dev",
      allow_credentials: [{ type: "public-key", id: "AwQ" }],
      user_verification: "required",
    };

    const decoded = decodeRequestOptions(json);

    expect([...new Uint8Array(decoded.challenge as ArrayBuffer)]).toEqual([1, 2]);
    expect([...new Uint8Array((decoded.allowCredentials?.[0]?.id ?? new ArrayBuffer()) as ArrayBuffer)]).toEqual([3, 4]);
    expect(json.allow_credentials?.[0]?.id).toBe("AwQ");
  });

  it("rejects malformed Base64URL", () => {
    expect(() => decodeBase64Url("%%%"))
      .toThrow(/Base64URL/u);
  });
});
