import type {
  PublicKeyCredentialCreationOptionsJson,
  PublicKeyCredentialJson,
  PublicKeyCredentialRequestOptionsJson,
} from "../api/types";
import { credentialToJson, decodeCreationOptions, decodeRequestOptions } from "./json";

/** WebAuthn 不可用、用户取消或浏览器拒绝时的可展示错误。Display-safe WebAuthn availability/cancellation error. */
export class WebAuthnUiError extends Error {
  /** 创建已净化的用户错误。Constructs a sanitized user-facing error. */
  public constructor(message: string) {
    super(message);
    this.name = "WebAuthnUiError";
  }
}

/** 检查当前安全上下文是否支持 Passkey。Checks passkey support in the current secure context. */
export function isWebAuthnAvailable(): boolean {
  return window.isSecureContext && "PublicKeyCredential" in window && navigator.credentials !== undefined;
}

/** 调用浏览器创建 Passkey，并返回可提交 JSON。Invokes browser passkey creation and returns submit-ready JSON. */
export async function createPasskey(
  options: PublicKeyCredentialCreationOptionsJson,
  signal?: AbortSignal,
): Promise<PublicKeyCredentialJson> {
  ensureAvailable();
  try {
    const credential = await navigator.credentials.create({ publicKey: decodeCreationOptions(options), signal });
    if (!(credential instanceof PublicKeyCredential)) throw new WebAuthnUiError("浏览器没有返回 Passkey 凭据。");
    return credentialToJson(credential);
  } catch (error) {
    throw normalizeWebAuthnError(error);
  }
}

/** 调用浏览器请求 Passkey assertion，并返回可提交 JSON。Invokes a browser passkey assertion and returns submit-ready JSON. */
export async function getPasskey(
  options: PublicKeyCredentialRequestOptionsJson,
  signal?: AbortSignal,
): Promise<PublicKeyCredentialJson> {
  ensureAvailable();
  try {
    const credential = await navigator.credentials.get({ publicKey: decodeRequestOptions(options), signal });
    if (!(credential instanceof PublicKeyCredential)) throw new WebAuthnUiError("浏览器没有返回 Passkey 凭据。");
    return credentialToJson(credential);
  } catch (error) {
    throw normalizeWebAuthnError(error);
  }
}

/** 在触发 ceremony 前报告环境问题。Reports environment problems before starting a ceremony. */
function ensureAvailable(): void {
  if (!isWebAuthnAvailable()) {
    throw new WebAuthnUiError("此浏览器或当前连接不支持 Passkey。请使用现代浏览器并通过 HTTPS 访问。");
  }
}

/** 将 DOMException 映射为不泄露内部选项的稳定文案。Maps DOMExceptions to stable messages without leaking ceremony details. */
function normalizeWebAuthnError(error: unknown): Error {
  if (error instanceof WebAuthnUiError) return error;
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "AbortError") {
      return new WebAuthnUiError("Passkey 操作已取消或超时；你可以安全地重试。");
    }
    if (error.name === "InvalidStateError") {
      return new WebAuthnUiError("这个 Passkey 已在账号中，无需重复添加。");
    }
  }
  return new WebAuthnUiError("浏览器无法完成 Passkey 操作，请重试。");
}
