import { ApiError, createIdempotencyKey, IdentityApiClient } from "./api/client";
import type { Account, Contact, ContactVerificationTransaction, Identifier, MobileNumberInput, PasswordAuthenticationInput, PasswordSessionResult, RegistrationResult, RegistrationStart } from "./api/types";
import { currentTransaction } from "./transaction";
import type { AppRoute } from "./router";
import { createPasskey, getPasskey, isWebAuthnAvailable } from "./webauthn/ceremony";
import type { Locale, MessageKey } from "./i18n";
import { translate } from "./i18n";
import { el, errorMessage, field, replace, setButtonBusy, statePanel } from "./ui/dom";
import { icon, iconLabel } from "./ui/icons";
import { pageHeading } from "./ui/shell";
import { InlineStepUpCoordinator } from "./step-up";
import { resolveAccountReturnUri, validateAccountReturnUri } from "./environment";
import { avatarFilePicker } from "./ui/file-picker";

/** 只驻留于当前页面 Realm 的 CSRF capability。CSRF capability held only in this page realm. */
let sessionCsrfToken: string | undefined;

/** 登录页面渲染所需的本地化上下文。Localized context required to render login pages. */
export interface PageContext { locale: Locale }

/** 渲染登录站公开路由；账号管理始终位于 account 子域。Renders public login routes; account management always lives on the account subdomain. */
export async function renderPage(route: AppRoute, main: HTMLElement, api: IdentityApiClient, signal: AbortSignal, context: PageContext): Promise<void> {
  const t = (key: MessageKey) => translate(context.locale, key);
  replace(main, statePanel("loading", "…", t("signingIn")));
  try {
    if (route === "/register") renderRegister(main, api, signal, t, context.locale);
    else if (route === "/recovery") renderRecovery(main, api, signal, t);
    else if (route === "/passkey/enroll") await renderPasskeyEnrollment(main, api, signal, t);
    else if (route === "/recovery-codes/rotate") renderRecoveryCodeRotation(main, api, signal, t);
    else renderLogin(main, api, signal, t, validateAccountReturnUri(location));
  } catch (error) {
    if (!signal.aborted) replace(main, statePanel("error", t("loginFailed"), errorMessage(error)));
  }
}

/** 呈现密码为默认、Passkey 为平等可选项的登录页。Renders password-first login with passkey as an equal option. */
function renderLogin(main: HTMLElement, api: IdentityApiClient, signal: AbortSignal, t: (key: MessageKey) => string, returnUri?: string): void {
  const message = el("div", { className: "inline-state", attrs: { "aria-live": "polite" } });
  const submit = el("button", { className: "button button--primary button--wide", attrs: { type: "submit" } }, iconLabel("lock", t("signInPassword")));
  const form = el("form", { className: "auth-form" },
    field(t("identity"), "login", { required: true, autocomplete: "username", icon: "mail" }),
    field(t("password"), "password", { required: true, autocomplete: "current-password", type: "password", icon: "lock" }),
    el("div", { className: "form-meta" }, el("a", { attrs: { href: "/recovery" } }, t("recovery"))), submit,
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault(); setButtonBusy(submit, true, t("signingIn"));
    try {
      const data = new FormData(form);
      const result = await api.authenticateWithPassword({ login: String(data.get("login") ?? "").trim(), password: String(data.get("password") ?? ""), ...(currentTransaction() ? { authorization_transaction_id: currentTransaction() } : {}) }, await requireBrowserCsrf(api, signal), signal);
      finishAuthentication(main, result, t, returnUri);
    } catch (error) { replace(message, statePanel("error", t("loginFailed"), errorMessage(error))); setButtonBusy(submit, false); }
  });

  const passkey = el("button", { className: "button button--secondary button--wide", attrs: { type: "button", disabled: !isWebAuthnAvailable() } }, iconLabel("key", t("usePasskey")));
  passkey.addEventListener("click", async () => {
    setButtonBusy(passkey, true, t("waitingPasskey"));
    try {
      const transaction = await api.startAuthentication({ purpose: "login", ...(currentTransaction() ? { authorization_transaction_id: currentTransaction() } : {}) }, await requireBrowserCsrf(api, signal), signal);
      const credential = await getPasskey(transaction.public_key, signal);
      const result = await api.completeAuthentication(transaction.transaction_id, credential, { csrfToken: transaction.csrf_token, idempotencyKey: createIdempotencyKey(), signal });
      finishAuthentication(main, result, t, returnUri);
    } catch (error) { replace(message, statePanel("error", t("loginFailed"), errorMessage(error))); setButtonBusy(passkey, false); }
  });

  replace(main, pageHeading("IDENTITY_GATEWAY", t("welcome"), t("welcomeIntro")),
    el("section", { className: "moe-glass auth-card", attrs: { "aria-labelledby": "login-options" } },
      el("div", { className: "card-sparkle", attrs: { "aria-hidden": "true" } }, icon("star")),
      el("h2", { className: "visually-hidden", attrs: { id: "login-options" } }, t("login")), form, divider(t("divider")), passkey,
      !isWebAuthnAvailable() && el("p", { className: "hint hint--warning" }, t("passkeyUnavailable")), message),
    el("p", { className: "switcher" }, t("noAccount"), " ", el("a", { attrs: { href: "/register" } }, t("create"))), accountCenterNote(t));
}

/** 呈现包含社区资料、密码与可选 Passkey 的注册页。Renders registration with community profile, password, and optional passkey. */
function renderRegister(main: HTMLElement, api: IdentityApiClient, signal: AbortSignal, t: (key: MessageKey) => string, locale: Locale): void {
  const message = el("div", { className: "inline-state", attrs: { "aria-live": "polite" } });
  const passwordButton = el("button", { className: "button button--primary", attrs: { type: "submit", value: "password", name: "method" } }, iconLabel("lock", t("registerPassword")));
  const passkeyButton = el("button", { className: "button button--secondary", attrs: { type: "submit", value: "passkey", name: "method", disabled: !isWebAuthnAvailable() } }, iconLabel("key", t("registerPasskey")));
  const callingCode = el("select", { attrs: { name: "calling_code", "aria-label": t("countryCode") } },
    ...[["+86", "🇨🇳 +86"], ["+81", "🇯🇵 +81"], ["+1", "🇺🇸/🇨🇦 +1"], ["+44", "🇬🇧 +44"], ["+65", "🇸🇬 +65"], ["+852", "🇭🇰 +852"]].map(([value, label]) => el("option", { attrs: { value } }, label)));
  const form = el("form", { className: "moe-glass auth-card register-form" },
    el("div", { className: "field-grid" }, field(t("displayName"), "display_name", { required: true, autocomplete: "name", placeholder: "Klee ✦", icon: "user" }), field(t("username"), "username", { required: true, autocomplete: "username", placeholder: "klee", icon: "user", pattern: "[a-zA-Z0-9_]{3,32}" })),
    field(t("email"), "email", { required: true, autocomplete: "email", type: "email", placeholder: "klee@example.com", icon: "mail" }),
    avatarFilePicker({ label: t("avatar"), choose: t("chooseAvatar"), empty: t("noAvatarSelected") }), el("p", { className: "hint" }, t("addAvatar")),
    el("div", { className: "field-grid" }, field(t("statusLabel"), "status_message", { placeholder: t("statusPlaceholder"), icon: "star" }), field(t("oshiLabel"), "favorite_character", { placeholder: "Klee", icon: "star" })),
    field(t("interestsLabel"), "interests", { placeholder: "ACG, Linux, VOCALOID", icon: "star" }),
    el("label", { className: "field" }, el("span", { className: "field__label" }, t("mobile")), el("span", { className: "phone-field" }, callingCode, el("input", { attrs: { name: "mobile", type: "tel", autocomplete: "tel-national", inputmode: "tel", placeholder: "138 0000 0000" } }))), el("p", { className: "hint" }, t("phoneHint")),
    el("div", { className: "field-grid" }, field(t("password"), "password", { autocomplete: "new-password", type: "password", minlength: "15", icon: "lock" }), field(t("passwordAgain"), "password_confirm", { autocomplete: "new-password", type: "password", minlength: "15", icon: "lock" })), el("p", { className: "hint" }, t("passwordHint")),
    el("fieldset", { className: "method-picker" }, el("legend", {}, t("methodTitle")), el("p", { className: "hint" }, t("passkeyOptional")), el("div", { className: "button-pair" }, passwordButton, passkeyButton)), message, el("p", { className: "terms" }, t("terms")));
  form.addEventListener("submit", async (event) => {
    event.preventDefault(); const submitter = (event as SubmitEvent).submitter as HTMLButtonElement | null; const method = submitter?.value === "passkey" ? "passkey" : "password";
    const data = new FormData(form); const password = String(data.get("password") ?? "");
    if (method === "password" && [...password].length < 15) { replace(message, statePanel("error", t("registerFailed"), t("passwordHint"))); return; }
    if (method === "password" && password !== String(data.get("password_confirm") ?? "")) { replace(message, statePanel("error", t("registerFailed"), t("mismatch"))); return; }
    setButtonBusy(submitter ?? passwordButton, true, method === "passkey" ? t("waitingPasskey") : t("registering"));
    const mobile = mobileFromForm(data); const avatar = data.get("avatar") instanceof File && (data.get("avatar") as File).size > 0 ? data.get("avatar") as File : undefined;
    const profile = { ...(optionalString(data, "status_message") ? { status_message: optionalString(data, "status_message") } : {}), ...(optionalString(data, "favorite_character") ? { favorite_character: optionalString(data, "favorite_character") } : {}), ...(optionalString(data, "interests") ? { interests: optionalString(data, "interests")?.split(",").map((value) => value.trim()).filter(Boolean) } : {}) };
    const common = { username: String(data.get("username") ?? "").trim(), display_name: String(data.get("display_name") ?? "").trim(), email: String(data.get("email") ?? "").trim(), locale, ...(mobile ? { mobile } : {}), ...(Object.keys(profile).length ? { profile } : {}) };
    try {
      if (method === "password") { const result = await api.registerWithPassword({ ...common, password }, await requireBrowserCsrf(api, signal), signal); rememberCsrf(result.csrf_token); await renderRegistrationEmailVerification(main, api, result.account, result.csrf_token, signal, t, () => finishAuthentication(main, result, t)); const avatarOk = await uploadOptionalAvatar(api, avatar, result.csrf_token, signal); if (!avatarOk) main.append(statePanel("info", t("success"), t("avatarUploadFailed"))); return; }
      const input: RegistrationStart = { ...common, authenticator_label: browserPasskeyLabel(t) };
      const transaction = await api.startRegistration(input, await requireBrowserCsrf(api, signal), signal); const credential = await createPasskey(transaction.public_key, signal);
      const result = await api.completeRegistration(transaction.transaction_id, credential, { csrfToken: transaction.csrf_token, idempotencyKey: createIdempotencyKey(), signal });
      // 验证步骤与恢复代码必须先于次要上传或导航呈现。Verification and recovery codes render before secondary uploads or navigation.
      rememberCsrf(result.csrf_token);
      await renderRegistrationEmailVerification(main, api, result.account, result.csrf_token, signal, t, () => finishRegistration(main, result, t), result.recovery_codes, result.next_uri);
      const avatarOk = await uploadOptionalAvatar(api, avatar, result.csrf_token, signal);
      if (!avatarOk) main.append(statePanel("info", t("success"), t("avatarUploadFailed")));
    } catch (error) { replace(message, statePanel("error", t("registerFailed"), errorMessage(error))); setButtonBusy(submitter ?? passwordButton, false); }
  });
  replace(main, pageHeading("CREATE_PRINCIPAL", t("newTitle"), t("newIntro")), form, el("p", { className: "switcher" }, t("haveAccount"), " ", el("a", { attrs: { href: "/login" } }, t("login"))));
}

/** 呈现恢复代码加新 Passkey 流程。Renders recovery-code plus new-passkey flow. */
function renderRecovery(main: HTMLElement, api: IdentityApiClient, signal: AbortSignal, t: (key: MessageKey) => string): void {
  const message = el("div", { attrs: { "aria-live": "polite" } }); const submit = el("button", { className: "button button--primary button--wide", attrs: { type: "submit" } }, iconLabel("key", t("recover")));
  const form = el("form", { className: "moe-glass auth-card auth-form" }, field(t("recoveryCode"), "recovery_code", { required: true, autocomplete: "off", placeholder: "msf_rc_…", icon: "lock" }), field(t("newPasskeyLabel"), "authenticator_label", { required: true, placeholder: browserPasskeyLabel(t), icon: "key" }), submit, message);
  form.addEventListener("submit", async (event) => { event.preventDefault(); setButtonBusy(submit, true, t("waitingPasskey")); const data = new FormData(form);
    try { const started = await api.startRecovery({ recovery_code: String(data.get("recovery_code") ?? ""), authenticator_label: String(data.get("authenticator_label") ?? "") }, await requireBrowserCsrf(api, signal), signal); const credential = await createPasskey(started.public_key, signal); const result = await api.completeRecovery(started.transaction_id, started.csrf_token, credential, signal); rememberCsrf(result.csrf_token); replace(main, pageHeading("RECOVERY_COMPLETE", t("success"), t("signedIn")), recoveryCodePanel(result.recovery_codes, t)); }
    catch (error) { replace(message, statePanel("error", t("recoveryFailed"), errorMessage(error))); setButtonBusy(submit, false); }
  });
  replace(main, pageHeading("RECOVERY_LINK", t("recovery"), t("recoveryIntro")), form, el("p", { className: "switcher" }, el("a", { attrs: { href: "/login" } }, t("back"))));
}

/** 为账号中心执行单一的 Passkey 登记仪式，不承载管理列表。Performs one passkey enrollment ceremony without hosting management UI. */
async function renderPasskeyEnrollment(main: HTMLElement, api: IdentityApiClient, signal: AbortSignal, t: (key: MessageKey) => string): Promise<void> {
  const session = await api.getPrincipal(signal); rememberCsrf(session.csrf_token);
  const message = el("div", { attrs: { "aria-live": "polite" } });
  const submit = el("button", { className: "button button--primary button--wide", attrs: { type: "submit", disabled: !isWebAuthnAvailable() } }, iconLabel("key", t("enroll")));
  const labelField = field(t("passkeyName"), "label", { required: true, value: browserPasskeyLabel(t), icon: "key" });
  const passwordMessage = el("div", { attrs: { "aria-live": "polite" } });
  const passwordSubmit = el("button", { className: "button button--secondary button--wide", attrs: { type: "submit" } }, iconLabel("lock", t("reauthWithPassword")));
  const passwordForm = el("form", { className: "password-fallback auth-form" },
    field(t("reauthIdentity"), "login", { required: true, autocomplete: "username", icon: "user" }),
    field(t("reauthPassword"), "password", { required: true, autocomplete: "current-password", type: "password", icon: "lock" }), passwordSubmit, passwordMessage);
  const fallback = el("details", { className: "password-fallback-wrap" }, el("summary", {}, t("passwordReauthTitle")), el("p", { className: "hint" }, t("passwordReauthIntro")), passwordForm);
  const form = el("form", { className: "moe-glass auth-card auth-form" }, labelField, submit, message);
  const complete = async (transaction: Awaited<ReturnType<IdentityApiClient["startAuthenticatorRegistration"]>>, label: string) => {
    const credential = await createPasskey(transaction.public_key, signal);
    const completed = await api.completeAuthenticatorRegistration(transaction.transaction_id, credential, { csrfToken: transaction.csrf_token, idempotencyKey: createIdempotencyKey(), signal });
    rememberCsrf(completed.csrf_token); replace(main, statePanel("success", t("enrolled"), label, accountLink(t)));
  };
  form.addEventListener("submit", async (event) => {
    event.preventDefault(); setButtonBusy(submit, true, t("waitingPasskey"));
    try {
      const label = String(new FormData(form).get("label") ?? "").trim();
      const transaction = await stepUpCoordinator(api).execute((controls) => api.startAuthenticatorRegistration(label, controls), { signal, onStepUpRequired: () => replace(message, statePanel("info", t("stepUp"), t("waitingPasskey"))) });
      await complete(transaction, label);
    } catch (error) { replace(message, statePanel("error", t("registerFailed"), errorMessage(error))); setButtonBusy(submit, false); }
  });
  passwordForm.addEventListener("submit", async (event) => {
    event.preventDefault(); setButtonBusy(passwordSubmit, true, t("signingIn"));
    try {
      const data = new FormData(passwordForm); const label = labelField.querySelector<HTMLInputElement>("input[name='label']")?.value.trim() ?? "";
      const browserCsrf = (await api.getBrowserContext(signal)).csrf_token;
      const started = await reauthenticateAndStartEnrollment(api, { login: String(data.get("login") ?? "").trim(), password: String(data.get("password") ?? "") }, label, browserCsrf, signal);
      rememberCsrf(started.csrfToken); await complete(started.transaction, label);
    } catch (error) { replace(passwordMessage, statePanel("error", t("loginFailed"), errorMessage(error))); setButtonBusy(passwordSubmit, false); }
  });
  replace(main, pageHeading("PASSKEY_ENROLLMENT", t("enrollTitle"), t("enrollIntro")), form, fallback);
}

/** 以密码刷新近期认证并立即创建 Passkey 登记事务。Refreshes recent authentication with a password and immediately starts passkey enrollment. */
export async function reauthenticateAndStartEnrollment(api: IdentityApiClient, authentication: PasswordAuthenticationInput, label: string, browserCsrf: string, signal: AbortSignal) {
  const session = await api.authenticateWithPassword(authentication, browserCsrf, signal);
  const transaction = await api.startAuthenticatorRegistration(label, { csrfToken: session.csrf_token, idempotencyKey: createIdempotencyKey(), signal });
  return { csrfToken: session.csrf_token, transaction };
}

/** 执行恢复代码轮换并只在本页展示一次结果。Rotates recovery codes and shows the result only on this page. */
function renderRecoveryCodeRotation(main: HTMLElement, api: IdentityApiClient, signal: AbortSignal, t: (key: MessageKey) => string): void {
  const message = el("div", { attrs: { "aria-live": "polite" } });
  const button = el("button", { className: "button button--primary button--wide", attrs: { type: "button" } }, iconLabel("lock", t("rotate")));
  button.addEventListener("click", async () => {
    setButtonBusy(button, true, t("waitingPasskey"));
    try {
      const result = await stepUpCoordinator(api).execute((controls) => api.rotateRecoveryCodes(controls), { signal, onStepUpRequired: () => replace(message, statePanel("info", t("stepUp"), t("waitingPasskey"))) });
      replace(main, pageHeading("RECOVERY_CODES", t("success"), t("codesIntro")), recoveryCodePanel(result.recovery_codes, t));
    } catch (error) { replace(message, statePanel("error", t("recoveryFailed"), errorMessage(error))); setButtonBusy(button, false); }
  });
  replace(main, pageHeading("RECOVERY_ROTATION", t("rotateTitle"), t("rotateIntro")), el("section", { className: "moe-glass auth-card" }, button, message));
}

/** 创建一次性恢复代码的复制和下载界面。Creates copy and download controls for one-time recovery codes. */
function recoveryCodePanel(codes: string[], t: (key: MessageKey) => string, nextUri?: string, showProceed = true): HTMLElement {
  const text = codes.join("\n");
  const copy = el("button", { className: "button button--secondary", attrs: { type: "button" } }, t("copyCodes"));
  copy.addEventListener("click", async () => { try { await navigator.clipboard.writeText(text); copy.textContent = t("copied"); } catch { window.prompt(t("copyCodes"), text); } });
  const download = el("button", { className: "button button--secondary", attrs: { type: "button" } }, t("downloadCodes"));
  download.addEventListener("click", () => { const url = URL.createObjectURL(new Blob([`${text}\n`], { type: "text/plain;charset=utf-8" })); const anchor = el("a", { attrs: { href: url, download: "moesegfault-recovery-codes.txt" } }); anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 0); });
  const proceed = nextUri
    ? el("button", { className: "button button--primary", attrs: { type: "button" }, on: { click: () => navigateToHttpUrl(nextUri) } }, t("continueAccount"))
    : accountLink(t);
  return el("section", { className: "moe-glass auth-card recovery-codes", attrs: { "aria-labelledby": "recovery-code-title" } }, el("h2", { attrs: { id: "recovery-code-title" } }, t("codesTitle")), el("p", { className: "hint" }, t("codesIntro")), el("ul", {}, ...codes.map((code) => el("li", {}, el("code", {}, code)))), el("div", { className: "button-pair" }, copy, download), showProceed && proceed);
}

/** 选择注册创建的主邮箱，不将手机或 username 误作验证目标。Selects the primary registration email without mistaking mobile or username identifiers. */
export function registrationEmailIdentifier(account: Account): Identifier | undefined {
  const emails = account.identifiers.filter((identifier) => identifier.kind === "email");
  return emails.find((identifier) => identifier.is_primary) ?? emails[0];
}

/** 把注册后邮箱验证呈现为必经状态，重发失败时仍保留上一个有效事务和恢复代码。Renders post-registration email verification as a required state, retaining the prior transaction and recovery codes when resend fails. */
async function renderRegistrationEmailVerification(main: HTMLElement, api: IdentityApiClient, account: Account, csrfToken: string, signal: AbortSignal, t: (key: MessageKey) => string, onVerified: () => void, recoveryCodes?: string[], nextUri?: string): Promise<void> {
  let email: Pick<Identifier, "identifier_id" | "value" | "verification_state"> | Pick<Contact, "contact_id" | "value" | "verification_state"> | undefined = registrationEmailIdentifier(account);
  if (!email) {
    try {
      const contacts = await api.listContacts(signal);
      email = contacts.find((contact) => contact.kind === "email" && contact.is_primary) ?? contacts.find((contact) => contact.kind === "email");
    } catch (error) {
      replace(main, pageHeading("VERIFY_EMAIL", t("verifyEmailTitle"), t("verifyEmailIntro")), statePanel("error", t("codeSendFailed"), errorMessage(error), accountLink(t)), ...(recoveryCodes?.length ? [recoveryCodePanel(recoveryCodes, t, nextUri, false)] : []));
      return;
    }
  }
  if (!email) {
    replace(main, pageHeading("VERIFY_EMAIL", t("verifyEmailTitle"), t("verifyEmailIntro")), statePanel("error", t("codeSendFailed"), t("codeInvalid"), accountLink(t)), ...(recoveryCodes?.length ? [recoveryCodePanel(recoveryCodes, t, nextUri, false)] : []));
    return;
  }
  if (email.verification_state === "verified") { onVerified(); return; }
  const contactId = "identifier_id" in email ? email.identifier_id : email.contact_id;
  let transaction: ContactVerificationTransaction | undefined;
  const status = el("div", { className: "inline-state", attrs: { "aria-live": "polite" } });
  const confirm = el("button", { className: "button button--primary", attrs: { type: "submit", disabled: true } }, iconLabel("mail", t("confirmEmail")));
  const resend = el("button", { className: "button button--secondary", attrs: { type: "button" } }, t("resendCode"));
  const codeField = field(t("verificationCode"), "code", { required: true, autocomplete: "one-time-code", pattern: "[0-9]{8}", minlength: "8", placeholder: "12345678", icon: "lock" });
  const codeInput = codeField.querySelector<HTMLInputElement>("input");
  if (codeInput) { codeInput.inputMode = "numeric"; codeInput.maxLength = 8; }
  const form = el("form", { className: "moe-glass auth-card verification-card" },
    codeField,
    el("div", { className: "button-pair" }, confirm, resend), status);
  const recovery = recoveryCodes?.length ? recoveryCodePanel(recoveryCodes, t, nextUri, false) : undefined;
  replace(main, pageHeading("VERIFY_EMAIL", t("verifyEmailTitle"), t("verifyEmailIntro")), el("div", { className: "verification-layout" }, form, recovery));

  const send = async () => {
    setButtonBusy(resend, true, t("sendingCode"));
    try {
      const next = await api.startContactVerification(contactId, { csrfToken, idempotencyKey: createIdempotencyKey(), signal });
      transaction = next; confirm.disabled = false;
      replace(status, statePanel("success", t("codeSent"), next.delivery_hint));
    } catch (error) {
      replace(status, statePanel("error", t("codeSendFailed"), errorMessage(error)));
    } finally { setButtonBusy(resend, false); }
  };
  resend.addEventListener("click", () => { void send(); });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!transaction) { await send(); return; }
    setButtonBusy(confirm, true, t("verifyingCode"));
    try {
      const code = String(new FormData(form).get("code") ?? "").trim();
      await api.completeContactVerification(contactId, transaction.transaction_id, code, { csrfToken, idempotencyKey: createIdempotencyKey(), signal });
      if (!recoveryCodes?.length) { onVerified(); return; }
      replace(main, pageHeading("EMAIL_VERIFIED", t("emailVerified"), t("codesIntro")), statePanel("success", t("emailVerified"), t("signedIn")), recoveryCodePanel(recoveryCodes, t, nextUri));
    } catch (error) {
      replace(status, statePanel("error", t("codeInvalid"), errorMessage(error)));
      setButtonBusy(confirm, false);
    }
  });
  await send();
}

/** 每个 API 客户端共享一个页面内再认证协调器。One in-page step-up coordinator is shared per API client. */
const stepUpCoordinators = new WeakMap<IdentityApiClient, InlineStepUpCoordinator>();
function stepUpCoordinator(api: IdentityApiClient): InlineStepUpCoordinator {
  const existing = stepUpCoordinators.get(api); if (existing) return existing;
  const readSession = async (signal: AbortSignal) => { const current = await api.getPrincipal(signal); rememberCsrf(current.csrf_token); return current.csrf_token; };
  const coordinator = new InlineStepUpCoordinator(api, { readSessionCsrf: async (signal) => sessionCsrfToken ?? readSession(signal), refreshSessionCsrf: readSession, readBrowserCsrf: async (signal) => (await api.getBrowserContext(signal)).csrf_token, rememberSessionCsrf: rememberCsrf });
  stepUpCoordinators.set(api, coordinator); return coordinator;
}

function finishAuthentication(main: HTMLElement, result: PasswordSessionResult, t: (key: MessageKey) => string, returnUri?: string): void {
  rememberCsrf(result.csrf_token);
  const destination = postAuthenticationDestination(result, returnUri);
  if (destination) { navigateToHttpUrl(destination); return; }
  replace(main, statePanel("success", t("success"), t("signedIn"), accountLink(t)));
}

/** OAuth 恢复始终优先于 Account 回跳。OAuth transaction resumption always takes precedence over an Account return URI. */
export function postAuthenticationDestination(result: Pick<PasswordSessionResult, "authorization_resume_uri">, returnUri?: string): string | undefined {
  return result.authorization_resume_uri ?? returnUri;
}
function finishRegistration(main: HTMLElement, result: RegistrationResult, t: (key: MessageKey) => string): void {
  rememberCsrf(result.csrf_token);
  if (result.recovery_codes?.length) { replace(main, pageHeading("ACCOUNT_CREATED", t("success"), t("signedIn")), recoveryCodePanel(result.recovery_codes, t, result.next_uri)); return; }
  if (result.next_uri) { navigateToHttpUrl(result.next_uri); return; }
  replace(main, statePanel("success", t("success"), t("signedIn"), accountLink(t)));
}
function accountLink(t: (key: MessageKey) => string): HTMLAnchorElement { return el("a", { className: "button button--primary", attrs: { href: resolveAccountReturnUri(location) } }, iconLabel("external", t("accountLink"))); }
function accountCenterNote(t: (key: MessageKey) => string): HTMLElement { return el("aside", { className: "account-note" }, icon("external"), el("div", {}, el("a", { attrs: { href: resolveAccountReturnUri(location) } }, t("accountLink")), el("p", {}, t("accountHint")))); }
function divider(label: string): HTMLElement { return el("div", { className: "divider", attrs: { role: "separator" } }, el("span", {}, label)); }
function optionalString(data: FormData, name: string): string | undefined { const value = String(data.get(name) ?? "").trim(); return value || undefined; }
function mobileFromForm(data: FormData): MobileNumberInput | undefined { const national = optionalString(data, "mobile")?.replace(/[\s()-]/g, ""); return national ? { country_calling_code: String(data.get("calling_code") ?? "+86"), national_number: national } : undefined; }
function browserPasskeyLabel(t: (key: MessageKey) => string): string { return /Android|iPhone|iPad/i.test(navigator.userAgent) ? t("mobileDevice") : t("desktopDevice"); }
async function uploadOptionalAvatar(api: IdentityApiClient, avatar: File | undefined, csrfToken: string, signal: AbortSignal): Promise<boolean> { if (!avatar) return true; try { await api.uploadAvatar(avatar, csrfToken, signal); return true; } catch { return false; } }
function rememberCsrf(token: string): void { sessionCsrfToken = token; }
async function requireBrowserCsrf(api: IdentityApiClient, signal: AbortSignal): Promise<string> { if (!sessionCsrfToken) rememberCsrf((await api.getBrowserContext(signal)).csrf_token); return sessionCsrfToken as string; }
function navigateToHttpUrl(value: string): void { const url = new URL(value, location.href); if (url.protocol !== "https:" && url.protocol !== "http:") throw new ApiError(0, { type: "urn:moesegfault:problem:invalid_navigation", title: "Invalid navigation", status: 0 }); location.assign(url.href); }
