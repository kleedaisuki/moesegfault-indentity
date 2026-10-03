import { IdentityApiClient, ApiError } from "./api/client";
import type { MessageKey } from "./i18n";
import { el, field, replace, setButtonBusy, statePanel } from "./ui/dom";
import { pageHeading } from "./ui/shell";

/** In-memory proof for exactly one mailbox, issued before any account exists. */
export interface VerifiedRegistrationEmail { email: string; token: string; expiresAt: string; csrfToken: string; }

/** Renders the mandatory first signup step, keeping retries and address correction local. */
export function renderRegistrationEmailGate(main: HTMLElement, api: IdentityApiClient, signal: AbortSignal,
  t: (key: MessageKey) => string, onVerified: (proof: VerifiedRegistrationEmail) => void): void {
  const emailField = field(t("email"), "email", { required: true, type: "email", autocomplete: "email", icon: "mail" });
  const emailInput = emailField.querySelector<HTMLInputElement>("input")!;
  const send = el("button", { className: "button button--primary button--wide", attrs: { type: "submit" } }, t("sendSignupCode"));
  const addressForm = el("form", { className: "auth-form" }, emailField, send);
  const codeField = field(t("verificationCode"), "code", { required: true, autocomplete: "one-time-code", pattern: "[0-9]{8}", minlength: "8", icon: "lock" });
  const codeInput = codeField.querySelector<HTMLInputElement>("input")!;
  codeInput.inputMode = "numeric"; codeInput.maxLength = 8;
  const confirm = el("button", { className: "button button--primary", attrs: { type: "submit" } }, t("confirmEmail"));
  const resend = el("button", { className: "button button--secondary", attrs: { type: "button" } }, t("resendCode"));
  const change = el("button", { className: "button button--secondary", attrs: { type: "button" } }, t("changeSignupEmail"));
  const codeForm = el("form", { className: "auth-form", attrs: { hidden: true } }, codeField,
    el("div", { className: "button-pair" }, confirm, resend), change);
  const status = el("div", { className: "inline-state", attrs: { "aria-live": "polite" } });
  let transaction: Awaited<ReturnType<IdentityApiClient["startRegistrationEmail"]>> | undefined;
  let csrfToken = "";
  let sending = false;
  let confirming = false;
  let cooldown: ReturnType<typeof setTimeout> | undefined;

  /** Keeps resend timing tied to the server response and releases the timer on navigation. */
  const waitToResend = (until: number): void => {
    clearTimeout(cooldown);
    resend.disabled = true;
    cooldown = setTimeout(() => { if (!signal.aborted) resend.disabled = false; }, Math.max(0, until - Date.now()));
  };
  const showError = (error: unknown, title: MessageKey = "codeSendFailed"): void => {
    const code = error instanceof ApiError ? error.problem?.error_code : undefined;
    const key = code === "verification_failed" ? "signupWrongCode" : code === "invalid_transaction" ? "signupCodeExpired" : code === "rate_limited" ? "signupRateLimited" : undefined;
    const message = key ? t(key) : error instanceof ApiError ? error.problem?.detail ?? error.message : t("codeSendFailed");
    replace(status, statePanel("error", t(title), message));
  };
  const sendCode = async (): Promise<void> => {
    if (sending || confirming || signal.aborted) return;
    sending = true;
    setButtonBusy(send, true, t("sendingCode"));
    resend.disabled = true; change.disabled = true; confirm.disabled = true;
    try {
      csrfToken = (await api.getBrowserContext(signal)).csrf_token;
      const next = await api.startRegistrationEmail(emailInput.value.trim(), csrfToken, signal);
      if (signal.aborted) return;
      transaction = next;
      emailInput.readOnly = true; send.hidden = true; codeForm.hidden = false; codeInput.value = "";
      replace(status, statePanel("success", t("codeSent"), `${next.delivery_hint} · ${t("signupCodeHint")}`));
      waitToResend(Date.parse(next.resend_after));
      codeInput.focus();
    } catch (error) {
      if (!signal.aborted) { showError(error); waitToResend(Date.now() + 60_000); }
    } finally {
      sending = false; setButtonBusy(send, false); confirm.disabled = !transaction; change.disabled = false;
    }
  };
  addressForm.addEventListener("submit", (event) => { event.preventDefault(); void sendCode(); });
  resend.addEventListener("click", () => { void sendCode(); });
  change.addEventListener("click", () => {
    clearTimeout(cooldown); transaction = undefined; codeForm.hidden = true; send.hidden = false;
    emailInput.readOnly = false; status.replaceChildren(); emailInput.focus();
  });
  codeForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!transaction || sending || confirming || signal.aborted) return;
    confirming = true;
    setButtonBusy(confirm, true, t("verifyingCode")); resend.disabled = true; change.disabled = true;
    try {
      const proof = await api.completeRegistrationEmail(transaction.transaction_id, codeInput.value.trim(), csrfToken, signal);
      if (signal.aborted) return;
      clearTimeout(cooldown);
      onVerified({ email: emailInput.value.trim(), token: proof.email_verification_token, expiresAt: proof.expires_at, csrfToken });
    } catch (error) {
      if (!signal.aborted) {
        showError(error, "codeInvalid");
        waitToResend(Date.parse(transaction.resend_after));
      }
    } finally { confirming = false; setButtonBusy(confirm, false); change.disabled = false; }
  });
  signal.addEventListener("abort", () => clearTimeout(cooldown), { once: true });
  replace(main, pageHeading("VERIFY_EMAIL", t("verifyEmailTitle"), t("signupEmailIntro")),
    el("section", { className: "moe-glass auth-card" }, addressForm, codeForm, status),
    el("p", { className: "switcher" }, t("haveAccount"), " ", el("a", { attrs: { href: "/login" } }, t("login"))));
}
