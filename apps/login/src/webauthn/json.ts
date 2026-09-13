import type {
  PublicKeyCredentialCreationOptionsJson,
  PublicKeyCredentialJson,
  PublicKeyCredentialRequestOptionsJson,
} from "../api/types";

/**
 * Base64URL 文本解码为不共享的 ArrayBuffer。
 * Decodes Base64URL text into a non-shared ArrayBuffer.
 */
export function decodeBase64Url(value: string): ArrayBuffer {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new TypeError("WebAuthn 数据包含无效的 Base64URL");
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return bytes.buffer;
}

/**
 * ArrayBuffer 或视图编码为无 padding 的 Base64URL。
 * Encodes an ArrayBuffer or view as unpadded Base64URL.
 */
export function encodeBase64Url(value: ArrayBuffer | ArrayBufferView): string {
  const bytes = value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

/** 将注册 JSON 选项转换为浏览器 WebAuthn 输入。Converts registration JSON options to browser WebAuthn input. */
export function decodeCreationOptions(options: PublicKeyCredentialCreationOptionsJson): PublicKeyCredentialCreationOptions {
  return {
    challenge: decodeBase64Url(options.challenge),
    rp: options.rp,
    user: {
      id: decodeBase64Url(options.user.id),
      name: options.user.name,
      displayName: options.user.display_name,
    },
    pubKeyCredParams: options.pub_key_cred_params,
    timeout: options.timeout,
    excludeCredentials: options.exclude_credentials?.map((credential) => ({
      ...credential,
      id: decodeBase64Url(credential.id),
    })),
    authenticatorSelection: options.authenticator_selection ? {
      residentKey: options.authenticator_selection.resident_key,
      requireResidentKey: options.authenticator_selection.require_resident_key,
      userVerification: options.authenticator_selection.user_verification,
    } : undefined,
    attestation: options.attestation,
    extensions: options.extensions,
  };
}

/** 将认证 JSON 选项转换为浏览器 WebAuthn 输入。Converts authentication JSON options to browser WebAuthn input. */
export function decodeRequestOptions(options: PublicKeyCredentialRequestOptionsJson): PublicKeyCredentialRequestOptions {
  return {
    challenge: decodeBase64Url(options.challenge),
    timeout: options.timeout,
    rpId: options.rp_id,
    allowCredentials: options.allow_credentials?.map((credential) => ({
      ...credential,
      id: decodeBase64Url(credential.id),
    })),
    userVerification: options.user_verification,
    extensions: options.extensions,
  };
}

/**
 * 把浏览器凭据完整、无损地转换为 API JSON；可信性仍由服务端判断。
 * Losslessly converts a browser credential to API JSON; trust remains a server decision.
 */
export function credentialToJson(credential: PublicKeyCredential): PublicKeyCredentialJson {
  const common = {
    id: credential.id,
    raw_id: encodeBase64Url(credential.rawId),
    type: credential.type as PublicKeyCredentialType,
    authenticator_attachment: credential.authenticatorAttachment,
    client_extension_results: credential.getClientExtensionResults(),
  };

  if (credential.response instanceof AuthenticatorAttestationResponse) {
    return {
      ...common,
      response: {
        client_data_json: encodeBase64Url(credential.response.clientDataJSON),
        attestation_object: encodeBase64Url(credential.response.attestationObject),
        transports: credential.response.getTransports?.(),
      },
    };
  }

  if (credential.response instanceof AuthenticatorAssertionResponse) {
    return {
      ...common,
      response: {
        client_data_json: encodeBase64Url(credential.response.clientDataJSON),
        authenticator_data: encodeBase64Url(credential.response.authenticatorData),
        signature: encodeBase64Url(credential.response.signature),
        user_handle: credential.response.userHandle ? encodeBase64Url(credential.response.userHandle) : null,
      },
    };
  }

  throw new TypeError("浏览器返回了未知的 WebAuthn response 类型");
}
