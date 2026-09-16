import { ApiError, AccountApiClient } from "./api/client";
import type { Account, AccountPreferences, Contact, Credential, MutationProof, SecuritySummary } from "./api/types";
import type { Locale, MessageKey } from "./i18n";
import type { Route } from "./router";
import { resolveRoute } from "./router";
import { busy, el, formatTime, icon, replace } from "./ui/dom";
import { resolveAccountOrigin, resolveLoginOrigin } from "./environment";

/** 页面渲染所需的会话态；CSRF 只驻留内存。In-memory page session; CSRF never leaves memory. */
export interface PageContext { api: AccountApiClient; account: Account; preferences: AccountPreferences; csrfToken: string; locale: Locale; t: (key: MessageKey) => string; signal: AbortSignal; refresh(): Promise<void>; }

/** 渲染一级账号页面。Renders one top-level Account page. */
export async function renderPage(route: Route, main: HTMLElement, context: PageContext): Promise<void> {
  replace(main, status(context.t("loading")));
  if (route === "/") renderOverview(main, context);
  if (route === "/profile") await renderProfile(main, context);
  if (route === "/security") await renderSecurity(main, context);
  if (route === "/sessions") await renderSessions(main, context);
  if (route === "/apps") await renderApps(main, context);
}

/** 总览将最常用动作提升为卡片。Overview promotes common actions into cards. */
function renderOverview(main: HTMLElement, c: PageContext): void {
  replace(main,
    heading(`${c.t("hello")}，${c.account.profile.display_name}`, c.t("subtitle")),
    el("section", { className: "hero-card moe-glass" },
      el("div", { className: "hero-avatar-wrap" }, avatar(c.account), el("span", { className: "sparkle" }, icon("sparkle"))),
      el("div", {}, el("p", { className: "eyebrow" }, `@${username(c.account)}`), el("h2", { attrs: { dir: "auto" } }, c.account.profile.display_name), el("p", { className: "muted", attrs: { dir: "auto" } }, c.account.profile.bio || c.t("editProfile"))),
      el("a", { className: "button primary", attrs: { href: "/profile" }, dataset: { route: "/profile" } }, icon("user"), c.t("editProfile")),
    ),
    el("div", { className: "quick-grid" },
      quick("shield", c.t("security"), c.t("securityScore"), "/security"), quick("devices", c.t("sessions"), c.t("devicesIntro"), "/sessions"), quick("apps", c.t("apps"), c.t("connectedIntro"), "/apps"),
    ),
  );
}

/** 资料、头像、联系方式统一成一个编辑心智模型。Profile, avatar and contacts share one editing model. */
async function renderProfile(main: HTMLElement, c: PageContext): Promise<void> {
  const contacts = await c.api.listContacts(c.signal);
  if (c.signal.aborted) return;
  const avatarInput = el("input", { attrs: { type: "file", accept: "image/avif,image/png,image/jpeg,image/webp", hidden: true } });
  const avatarMessage = el("span", { className: "inline-message", attrs: { "aria-live": "polite" } });
  const avatarButton = button(c.t("upload"), "quiet");
  avatarButton.addEventListener("click", () => avatarInput.click());
  avatarInput.addEventListener("change", async () => {
    const file = avatarInput.files?.[0]; if (!file) return;
    if (file.size > 10 * 1024 * 1024) { avatarMessage.textContent = c.t("avatarTooLarge"); return; }
    busy(avatarButton, true);
    try { await c.api.uploadAvatar(file, proof(c)); avatarMessage.textContent = c.t("saved"); await c.refresh(); } catch (error) { avatarMessage.textContent = errorText(error, c.t("unexpectedError")); } finally { busy(avatarButton, false); }
  });
  const profileForm = el("form", { className: "card form-card moe-glass" },
    el("h2", {}, c.t("editProfile")), inputField(c.t("displayName"), "display_name", c.account.profile.display_name, { required: true, maxLength: "80", autocomplete: "name", dir: "auto" }),
    textAreaField(c.t("bio"), "bio", c.account.profile.bio ?? "", 500),
    inputField(c.t("statusMessage"), "status_message", c.account.profile.status_message ?? "", { maxLength: "100", dir: "auto" }),
    inputField(c.t("pronouns"), "pronouns", c.account.profile.pronouns ?? "", { maxLength: "40" }),
    inputField(c.t("favoriteCharacter"), "favorite_character", c.account.profile.favorite_character ?? "", { maxLength: "100", dir: "auto" }),
    inputField(c.t("interests"), "interests", c.account.profile.interests?.join(", ") ?? "", { placeholder: "Touhou, Vocaloid, Rust" }),
    inputField(c.t("links"), "links", c.account.profile.links?.join("\n") ?? "", { placeholder: "https://example.com" }),
    selectField(c.t("visibility"), "profile_visibility", [["private", c.t("private")], ["members", c.t("members")], ["public", c.t("public")]], c.account.profile.profile_visibility ?? "members"),
    selectField(c.t("locale"), "locale", [["zh-CN", "简体中文"], ["en", "English"], ["ja", "日本語"]], c.preferences.locale),
    inputField(c.t("timezone"), "timezone", c.preferences.timezone, { required: true, placeholder: "Asia/Shanghai" }),
    el("div", { className: "form-actions" }, button(c.t("save"), "primary", "submit"), el("span", { className: "inline-message", attrs: { "aria-live": "polite" } })),
  );
  profileForm.addEventListener("submit", async (event) => {
    event.preventDefault(); const submit = profileForm.querySelector<HTMLButtonElement>("[type=submit]")!; const message = profileForm.querySelector<HTMLElement>(".inline-message")!; busy(submit, true);
    const data = new FormData(profileForm);
    try {
      await Promise.all([
        c.api.updateMe({ display_name: String(data.get("display_name")), bio: nullable(data.get("bio")), status_message: nullable(data.get("status_message")), pronouns: nullable(data.get("pronouns")), favorite_character: nullable(data.get("favorite_character")), interests: commaList(data.get("interests")), links: lineList(data.get("links")), profile_visibility: String(data.get("profile_visibility")) as "private" | "members" | "public" }, proof(c)),
        c.api.updatePreferences({ locale: String(data.get("locale")), timezone: String(data.get("timezone")) }, proof(c)),
      ]);
      message.textContent = c.t("saved"); await c.refresh();
    } catch (error) { message.textContent = errorText(error, c.t("unexpectedError")); } finally { busy(submit, false); }
  });
  replace(main, heading(c.t("profile"), `@${username(c.account)}`),
    el("section", { className: "card avatar-card moe-glass" }, avatar(c.account), el("div", {}, el("h2", {}, c.t("avatar")), el("p", { className: "muted" }, c.t("avatarFormats")), el("div", { className: "button-row" }, avatarInput, avatarButton, c.account.profile.avatar_url ? actionButton(c.t("remove"), async (btn) => { await c.api.deleteAvatar(proof(c)); await c.refresh(); busy(btn, false); }, "danger", c) : null, avatarMessage))),
    profileForm, contactsPanel(contacts, c));
}

/** 联系方式卡片允许跨国手机号并显式展示验证状态。Contact card supports international numbers and explicit verification state. */
function contactsPanel(contacts: Contact[], c: PageContext): HTMLElement {
  const rows = contacts.map((contact) => el("article", { className: "entity-row" },
    icon(contact.kind === "email" ? "mail" : "phone"),
    el("div", {}, el("strong", {}, contact.value), el("div", { className: "badge-row" },
      badge(contact.verification_state === "verified" ? c.t("verified") : c.t("pending"), contact.verification_state === "verified" ? "good" : "warm"),
      contact.is_primary ? badge(c.t("primary"), "accent") : null,
    )),
    el("div", { className: "row-actions" },
      contact.verification_state !== "verified" ? verificationButton(contact, c) : null,
      !contact.is_primary && contact.verification_state === "verified" ? actionButton(c.t("makePrimary"), async (btn) => { await c.api.makePrimary(contact.contact_id, proof(c)); await c.refresh(); busy(btn, false); }, "quiet", c) : null,
      actionButton(c.t("remove"), async (btn) => { await c.api.deleteContact(contact.contact_id, proof(c)); await c.refresh(); busy(btn, false); }, "danger", c),
    ),
  ));
  const list = el("div", { className: "entity-list" }, ...rows);
  const form = el("form", { className: "contact-form" },
    selectField(c.t("contacts"), "kind", [["email", c.t("email")], ["mobile", c.t("mobile")]], "email"),
    selectField(c.t("countryRegion"), "calling_code", [["+86", `+86 ${c.t("mainlandChina")}`], ["+81", `+81 ${c.t("japan")}`], ["+65", `+65 ${c.t("singapore")}`], ["+1", `+1 ${c.t("usCanada")}`], ["+44", `+44 ${c.t("unitedKingdom")}`], ["+852", `+852 ${c.t("hongKong")}`]], "+86"),
    inputField(c.t("value"), "value", "", { required: true, autocomplete: "email" }), button(c.t("add"), "primary", "submit"), el("span", { className: "inline-message" }),
  );
  const codeField = form.querySelector<HTMLElement>("[name=calling_code]")!.closest("label")!;
  const kind = form.querySelector<HTMLSelectElement>("[name=kind]")!;
  const syncKind = () => { codeField.hidden = kind.value !== "mobile"; const input = form.querySelector<HTMLInputElement>("[name=value]")!; input.type = kind.value === "email" ? "email" : "tel"; input.autocomplete = kind.value === "email" ? "email" : "tel-national"; }; kind.addEventListener("change", syncKind); syncKind();
  form.addEventListener("submit", async (event) => { event.preventDefault(); const submit = form.querySelector<HTMLButtonElement>("[type=submit]")!; const message = form.querySelector<HTMLElement>(".inline-message")!; const data = new FormData(form); busy(submit, true); try { const contactKind = String(data.get("kind")) as "email" | "mobile"; const raw = String(data.get("value")).trim(); const code = String(data.get("calling_code")); const national = raw.replace(/^0+|[\s()-]/gu, ""); await c.api.addContact(contactKind === "mobile" ? { kind: contactKind, mobile: { country_calling_code: code, national_number: national } } : { kind: contactKind, email: raw }, proof(c)); await c.refresh(); } catch (error) { message.textContent = errorText(error, c.t("unexpectedError")); } finally { busy(submit, false); } });
  return el("section", { className: "card moe-glass" }, el("h2", {}, c.t("contacts")), list, form);
}

/** 安全中心把密码与 Passkey 视为并列登录方式。Security treats passwords and passkeys as peer sign-in methods. */
async function renderSecurity(main: HTMLElement, c: PageContext): Promise<void> {
  const [security, credentials] = await Promise.all([c.api.getSecurity(c.signal), c.api.listCredentials(c.signal)]); if (c.signal.aborted) return;
  const loginUrl = loginManagementUrl("passkeys");
  replace(main, heading(c.t("security"), c.t(securityAttention(security) ? "danger" : "secure")),
    el("div", { className: "security-grid" },
      securityCard("key", c.t("passkeys"), `${security.passkey_count}`, el("a", { className: "button primary", attrs: { href: loginUrl } }, c.t("manageAtLogin"))),
      passwordCard(security, c),
      securityCard("shield", c.t("twoFactor"), security.mfa_methods.length > 1 ? c.t("enabled") : c.t("comingSoon"), el("span", { className: "badge warm" }, c.t("technicalMethods"))),
      securityCard("sparkle", c.t("recovery"), security.recovery_ready ? c.t("enabled") : c.t("disabled"), el("a", { className: "button quiet", attrs: { href: loginManagementUrl("recovery") } }, c.t("manageAtLogin"))),
    ),
    el("section", { className: "card moe-glass" }, el("h2", {}, c.t("passkeys")), ...credentials.items.map((credential) => passkeyRow(credential, c))),
  );
}

/** 密码可选，且绝不暗示 Passkey 是唯一选项。Password is optional and passkeys are never presented as mandatory. */
function passwordCard(security: SecuritySummary, c: PageContext): HTMLElement {
  const form = el("form", { className: "password-form" },
    security.password ? inputField(c.t("currentPassword"), "current_password", "", { required: true, type: "password", autocomplete: "current-password" }) : null,
    inputField(c.t("newPassword"), "password", "", { required: true, type: "password", autocomplete: "new-password", minLength: "15" }),
    button(security.password ? c.t("save") : c.t("add"), "quiet", "submit"),
    security.password ? actionButton(c.t("remove"), async (btn) => { await c.api.deletePassword(proof(c)); await c.refresh(); busy(btn, false); }, "danger", c) : null,
    el("span", { className: "inline-message" }),
  );
  form.addEventListener("submit", async (event) => { event.preventDefault(); const btn = form.querySelector<HTMLButtonElement>("button[type=submit]")!; const data = new FormData(form); busy(btn, true); try { await c.api.setPassword(String(data.get("password")), proof(c), String(data.get("current_password") ?? "")); await c.refresh(); } catch (error) { form.querySelector<HTMLElement>(".inline-message")!.textContent = errorText(error, c.t("unexpectedError")); } finally { busy(btn, false); } });
  return securityCard("shield", c.t("password"), security.password ? c.t("enabled") : c.t("disabled"), form);
}

/** 会话页面支持逐个退出但保留当前上下文。Sessions can be revoked individually while preserving the current context. */
async function renderSessions(main: HTMLElement, c: PageContext): Promise<void> {
  const sessions = await c.api.listSessions(c.signal); if (c.signal.aborted) return;
  const rows = sessions.items.map((session) => el("article", { className: "entity-row" },
    icon("devices"),
    el("div", {}, el("strong", {}, session.authentication_method === "password" ? c.t("password") : session.authentication_method === "passkey" ? c.t("passkeys") : c.t("federated")), el("p", { className: "muted" }, [session.amr.join(" + "), formatTime(session.last_seen_at, c.locale)].join(" · "))),
    session.is_current ? badge(c.t("current"), "accent") : actionButton(c.t("revoke"), async (btn) => { await c.api.revokeSession(session.session_id, proof(c)); await c.refresh(); busy(btn, false); }, "danger", c),
  ));
  replace(main, heading(c.t("sessions"), c.t("devicesIntro")), el("section", { className: "card moe-glass" }, ...(rows.length ? rows : [empty(c.t("noSessions"))])));
}

/** 已连接应用清楚列出 scope 与最后使用时间。Connected apps expose scopes and last use. */
async function renderApps(main: HTMLElement, c: PageContext): Promise<void> {
  const apps = await c.api.listConnectedApps(c.signal); if (c.signal.aborted) return;
  replace(main, heading(c.t("apps"), c.t("connectedIntro")), el("div", { className: "app-grid" }, ...(apps.items.length ? apps.items.map((app) => el("article", { className: "card app-card moe-glass" }, app.logo_url ? el("img", { className: "app-logo", attrs: { src: app.logo_url, alt: "" } }) : icon("apps"), el("h2", {}, app.display_name), el("p", { className: "muted" }, `${c.t("permissions")}: ${app.scopes.join(" · ")}`), el("p", { className: "muted" }, formatTime(app.last_used_at ?? app.granted_at, c.locale)), actionButton(c.t("disconnect"), async (btn) => { await c.api.revokeConnectedApp(app.authorization_id, proof(c)); await c.refresh(); busy(btn, false); }, "danger", c))) : [empty(c.t("noApps"))])));
}

/** 页面标题。Page heading. */
function heading(title: string, intro: string): HTMLElement { return el("header", { className: "page-heading" }, el("p", { className: "eyebrow" }, "MOESEGFAULT"), el("h1", {}, title), el("p", { className: "lede" }, intro)); }
/** 快捷入口。Quick entry. */
function quick(iconName: string, title: string, text: string, href: Route): HTMLElement { return el("a", { className: "quick-card moe-glass", attrs: { href }, dataset: { route: href } }, icon(iconName), el("div", {}, el("h2", {}, title), el("p", {}, text)), icon("chevron")); }
/** 用户头像，缺省使用品牌而非远程占位服务。User avatar with a local brand fallback. */
function avatar(account: Account): HTMLImageElement { return el("img", { className: "avatar", attrs: { src: account.profile.avatar_url || "/icons/logo.svg", alt: account.profile.display_name } }); }
/** 普通输入字段。Ordinary input field. */
function inputField(label: string, name: string, value: string, attrs: Record<string, string | boolean> = {}): HTMLLabelElement { return el("label", { className: "field" }, el("span", {}, label), el("input", { attrs: { name, value, ...attrs } })); }
/** 多行字段。Multiline field. */
function textAreaField(label: string, name: string, value: string, maxLength: number): HTMLLabelElement { const area = el("textarea", { attrs: { name, maxlength: String(maxLength), rows: "4" } }, value); return el("label", { className: "field" }, el("span", {}, label), area); }
/** 选择字段。Select field. */
function selectField(label: string, name: string, options: ReadonlyArray<readonly [string, string]>, selected: string): HTMLLabelElement { return el("label", { className: "field" }, el("span", {}, label), el("select", { attrs: { name } }, ...options.map(([value, text]) => el("option", { attrs: { value, selected: value === selected } }, text)))); }
/** 一致按钮。Consistent button. */
function button(text: string, tone: "primary" | "quiet" | "danger", type: "button" | "submit" = "button"): HTMLButtonElement { return el("button", { className: `button ${tone}`, attrs: { type } }, text); }
/** 异步 mutation 按钮；近期认证不足时统一展示 Login 动作。Async mutation button with shared recent-auth recovery UX. */
function actionButton(text: string, action: (button: HTMLButtonElement) => Promise<void>, tone: "primary" | "quiet" | "danger", c: PageContext): HTMLButtonElement {
  const result = button(text, tone); let feedback: HTMLElement | undefined;
  result.addEventListener("click", async () => {
    feedback?.remove(); busy(result, true);
    try { await action(result); }
    catch (error) {
      const presentation = mutationErrorPresentation(error, c.t, location);
      feedback = el("span", { className: "inline-message mutation-feedback", attrs: { role: "alert" } }, presentation.message,
        presentation.actionHref ? el("a", { className: "button quiet", attrs: { href: presentation.actionHref } }, presentation.actionLabel) : null);
      result.insertAdjacentElement("afterend", feedback); busy(result, false);
    }
  });
  return result;
}
/** 状态徽章。Status badge. */
function badge(text: string, tone: "good" | "warm" | "accent"): HTMLElement { return el("span", { className: `badge ${tone}` }, text); }
/** 空状态。Empty state. */
function empty(text: string): HTMLElement { return el("div", { className: "empty" }, icon("sparkle"), el("p", {}, text)); }
/** 加载状态。Loading status. */
function status(text: string): HTMLElement { return el("div", { className: "loading", attrs: { role: "status" } }, icon("sparkle"), text); }
/** 生成 mutation proof。Constructs a mutation proof. */
function proof(c: PageContext): MutationProof { return { csrfToken: c.csrfToken, signal: c.signal }; }
/** 规范化展示错误，保留关联 ID 供支持排障。Normalizes errors while retaining correlation IDs for support. */
export function errorText(error: unknown, fallback = ""): string { if (error instanceof ApiError) return `${error.message}${error.correlationId ? ` · ID ${error.correlationId}` : ""}`; return error instanceof Error ? error.message : fallback; }
/** 安全摘要是否需要注意。Whether a security summary needs attention. */
export function securityAttention(value: SecuritySummary): boolean { return value.passkey_count + Number(value.password) === 0 || !value.recovery_ready; }
/** 由 Login origin 完成 WebAuthn，Account 不跨 RP 调用 ceremony。Routes WebAuthn through the Login origin instead of crossing RP boundaries. */
export function loginManagementUrl(section: "passkeys" | "recovery"): string { const path = section === "passkeys" ? "/passkey/enroll" : "/recovery-codes/rotate"; return `${resolveLoginOrigin(location)}${path}?return_uri=${encodeURIComponent(`${resolveAccountOrigin(location)}/security`)}`; }

/** 为当前 Account 页生成严格的同环境再认证地址。Builds a strict same-environment reauthentication URL for the current Account page. */
export function reauthenticationUrl(current: Pick<Location, "hostname" | "pathname">): string {
  const login = new URL("/login", resolveLoginOrigin(current));
  login.searchParams.set("return_uri", `${resolveAccountOrigin(current)}${resolveRoute(current.pathname)}`);
  return login.href;
}

/** mutation 错误的可测试展示模型。Testable presentation model for mutation errors. */
export function mutationErrorPresentation(error: unknown, t: (key: MessageKey) => string, current: Pick<Location, "hostname" | "pathname">): { message: string; actionHref?: string; actionLabel?: string } {
  if (error instanceof ApiError && error.problem?.error_code === "reauthentication_required") {
    return { message: t("reauthenticationBody"), actionHref: reauthenticationUrl(current), actionLabel: t("reauthenticate") };
  }
  return { message: errorText(error, t("unexpectedError")) };
}
/** 安全卡片。Security card. */
function securityCard(iconName: string, title: string, value: string, child: HTMLElement): HTMLElement { return el("article", { className: "card security-card moe-glass" }, icon(iconName), el("div", {}, el("h2", {}, title), el("strong", { className: "security-value" }, value)), child); }

/** Passkey 行提供本地管理动作；只有登记 ceremony 回到 Login。Passkey rows manage metadata locally; only enrollment returns to Login. */
function passkeyRow(credential: Credential, c: PageContext): HTMLElement {
  const actions = el("div", { className: "row-actions" });
  const rename = button(c.t("rename"), "quiet");
  rename.addEventListener("click", () => {
    const form = el("form", { className: "verification-form" }, inputField(c.t("passkeyLabel"), "label", credential.label, { required: true, maxlength: "80" }), buttonElement(c.t("save")), el("span", { className: "inline-message" }));
    form.addEventListener("submit", async (event) => { event.preventDefault(); const submit = form.querySelector<HTMLButtonElement>("button")!; busy(submit, true); try { await c.api.renameCredential(credential.authenticator_id, String(new FormData(form).get("label")), proof(c)); await c.refresh(); } catch (error) { form.querySelector<HTMLElement>(".inline-message")!.textContent = errorText(error, c.t("unexpectedError")); busy(submit, false); } });
    actions.replaceWith(form);
  });
  actions.append(rename, actionButton(c.t("revoke"), async (btn) => { await c.api.revokeCredential(credential.authenticator_id, proof(c)); await c.refresh(); busy(btn, false); }, "danger", c));
  return el("article", { className: "entity-row" }, icon("key"), el("div", {}, el("strong", { attrs: { dir: "auto" } }, credential.label), el("p", { className: "muted" }, formatTime(credential.last_used_at, c.locale)), credential.is_current ? badge(c.t("current"), "accent") : null), actions);
}

/**
 * 把发送、输入和重新发送验证码保留在当前联系方式行内。
 * Keeps code delivery, entry, and resend within the contact row.
 *
 * 首次发送失败时保留原按钮；事务过期或提交失败后，用户可直接重新发送而不必刷新页面。
 * The original button survives an initial delivery failure; after expiry or a failed
 * completion, users can resend without refreshing the page.
 */
function verificationButton(contact: Contact, c: PageContext): HTMLButtonElement {
  return actionButton(c.t("verify"), async (verifyButton) => {
    let transaction = await c.api.startContactVerification(contact.contact_id, proof(c));
    const form = el("form", { className: "verification-form" },
      inputField(`${c.t("verificationCode")} · ${transaction.delivery_hint}`, "code", "", { required: true, autocomplete: "one-time-code", inputmode: "numeric", minlength: "8", maxlength: "8", pattern: "[0-9]{8}" }),
      el("div", { className: "verification-actions" }, buttonElement(c.t("confirm")), button(c.t("resendCode"), "quiet")),
      el("span", { className: "inline-message success", attrs: { "aria-live": "polite", role: "status" } }, c.t("verificationSent")),
    );
    const code = form.querySelector<HTMLInputElement>("[name=code]")!;
    const [submit, resend] = Array.from(form.querySelectorAll<HTMLButtonElement>("button"));
    const message = form.querySelector<HTMLElement>(".inline-message")!;
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      busy(submit!, true);
      try {
        await c.api.completeContactVerification(contact.contact_id, transaction.transaction_id, code.value, proof(c));
        setVerificationMessage(message, c.t("verificationComplete"), true);
        await c.refresh();
      } catch (error) {
        setVerificationMessage(message, `${c.t("verificationFailed")} ${errorText(error, c.t("unexpectedError"))}`, false);
      } finally { busy(submit!, false); }
    });
    resend!.addEventListener("click", async () => {
      busy(resend!, true);
      try {
        transaction = await c.api.startContactVerification(contact.contact_id, proof(c));
        code.value = "";
        setVerificationMessage(message, c.t("verificationSent"), true);
        code.focus();
      } catch (error) {
        setVerificationMessage(message, `${c.t("verificationSendFailed")} ${errorText(error, c.t("unexpectedError"))}`, false);
      } finally { busy(resend!, false); }
    });
    verifyButton.replaceWith(form);
  }, "quiet", c);
}

/** 更新验证码反馈的语义与视觉状态。Updates verification feedback semantics and visual state. */
function setVerificationMessage(message: HTMLElement, text: string, success: boolean): void {
  message.textContent = text;
  message.classList.toggle("success", success);
  message.setAttribute("role", success ? "status" : "alert");
}

/** 验证表单提交按钮。Verification form submit button. */
function buttonElement(text: string): HTMLButtonElement { return el("button", { className: "button primary", attrs: { type: "submit" } }, text); }

/** 从稳定标识符读取用户名。Reads the username from stable identifiers. */
function username(account: Account): string { return account.identifiers.find((identifier) => identifier.kind === "username")?.value ?? account.principal_id.slice(0, 8); }
/** 空白字符串在 merge patch 中表达移除。Blank strings express removal in merge patches. */
function nullable(value: FormDataEntryValue | null): string | null { const text = String(value ?? "").trim(); return text || null; }
/** 解析逗号分隔兴趣。Parses comma-separated interests. */
function commaList(value: FormDataEntryValue | null): string[] { return String(value ?? "").split(/[,，]/u).map((item) => item.trim()).filter(Boolean).slice(0, 20); }
/** 解析逐行 URL。Parses line-separated URLs. */
function lineList(value: FormDataEntryValue | null): string[] { return String(value ?? "").split(/\r?\n/u).map((item) => item.trim()).filter(Boolean).slice(0, 10); }
