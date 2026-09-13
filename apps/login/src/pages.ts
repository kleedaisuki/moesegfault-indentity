import { ApiError, createIdempotencyKey, IdentityApiClient } from "./api/client";
import type {
  Authenticator,
  BindingProvider,
  IdentityBinding,
  IdentitySession,
  RecoveryCodeRotation,
  RegistrationResult,
  ResourceList,
} from "./api/types";
import type { AppRoute } from "./router";
import { navigate } from "./router";
import { InlineStepUpCoordinator } from "./step-up";
import type { HighRiskRequestControls } from "./step-up";
import { currentTransaction } from "./transaction";
import { createPasskey, getPasskey, isWebAuthnAvailable } from "./webauthn/ceremony";
import { el, errorMessage, field, formatTime, replace, setButtonBusy, statePanel } from "./ui/dom";
import { pageHeading } from "./ui/shell";

/** 仅保存在当前页面 Realm 的 CSRF 能力。CSRF capability held only in the current page realm. */
let sessionCsrfToken: string | undefined;

/** 每个 API 客户端只共享一个页面内再认证协调器。One in-page reauthentication coordinator is shared per API client. */
const stepUpCoordinators = new WeakMap<IdentityApiClient, InlineStepUpCoordinator>();

/** 根据静态路由呈现页面；AbortSignal 防止旧页面回写 DOM。Renders a static route; AbortSignal prevents stale-page DOM writes. */
export async function renderPage(route: AppRoute, main: HTMLElement, api: IdentityApiClient, signal: AbortSignal): Promise<void> {
  replace(main, statePanel("loading", "正在准备页面", "正在从 Identity 读取最新状态…"));
  try {
    switch (route) {
      case "/register": renderRegister(main, api, signal); break;
      case "/login": renderLogin(main, api, signal); break;
      case "/recovery": renderRecovery(main, api, signal); break;
      case "/account": await renderAccount(main, api, signal); break;
      case "/account/passkeys": await renderPasskeys(main, api, signal); break;
      case "/account/bindings": await renderBindings(main, api, signal); break;
      case "/account/sessions": await renderSessions(main, api, signal); break;
      case "/account/recovery": await renderRecoveryCodes(main, api, signal); break;
    }
  } catch (error) {
    if (signal.aborted) return;
    renderPageError(main, error, () => window.dispatchEvent(new PopStateEvent("popstate")));
  }
}

/** 呈现注册及首个 Passkey ceremony。Renders registration and the first-passkey ceremony. */
function renderRegister(main: HTMLElement, api: IdentityApiClient, signal: AbortSignal): void {
  const message = el("div", { className: "inline-state", attrs: { "aria-live": "polite" } });
  const submit = el("button", { className: "button button--primary", attrs: { type: "submit" } }, "创建账号与 Passkey");
  const form = el("form", { className: "card form-card" },
    el("h2", {}, "你的账号"),
    field("用户名", "username", { required: true, autocomplete: "username", placeholder: "klee" }),
    field("显示名称", "display_name", { required: true, autocomplete: "name", placeholder: "Klee" }),
    field("首个 Passkey 标签", "authenticator_label", { required: true, autocomplete: "off", placeholder: "例如：Pixel 手机" }),
    field("注册能力（如注册策略要求）", "registration_capability", { autocomplete: "off" }),
    el("p", { className: "hint" }, "不需要 Email 或密码。Passkey 将绑定到 login.moesegfault.dev。"),
    message,
    submit,
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setButtonBusy(submit, true, "等待 Passkey…");
    replace(message, statePanel("loading", "正在创建 Passkey", "请按浏览器提示完成设备验证。"));
    const data = new FormData(form);
    try {
      const capability = String(data.get("registration_capability") ?? "").trim();
      const transaction = await api.startRegistration({
        username: String(data.get("username") ?? "").trim(),
        display_name: String(data.get("display_name") ?? "").trim(),
        authenticator_label: String(data.get("authenticator_label") ?? "").trim(),
        locale: navigator.language || "zh-CN",
        ...(capability ? { registration_capability: capability } : {}),
      }, await requireBrowserCsrf(api, signal), signal);
      const credential = await createPasskey(transaction.public_key, signal);
      const result = await api.completeRegistration(transaction.transaction_id, credential, {
        csrfToken: transaction.csrf_token,
        idempotencyKey: createIdempotencyKey(),
        signal,
      });
      rememberCsrf(result.csrf_token);
      renderRegistrationSuccess(main, result);
    } catch (error) {
      replace(message, statePanel("error", "注册未完成", errorMessage(error)));
      setButtonBusy(submit, false);
    }
  });
  replace(main,
    pageHeading("NEW PRINCIPAL", "创建你的身份", "用设备上的 Passkey 建立账号。验证秘密不会离开认证器。"),
    !isWebAuthnAvailable() && statePanel("error", "当前环境不支持 Passkey", "请使用支持 WebAuthn 的现代浏览器，并通过 HTTPS 访问。"),
    form,
    el("p", { className: "switcher" }, "已经有账号？", el("a", { attrs: { href: "/login" } }, "使用 Passkey 登录")),
  );
}

/** 呈现注册后的实际结果与一次性恢复材料。Renders actual registration effects and one-time recovery material. */
function renderRegistrationSuccess(main: HTMLElement, result: RegistrationResult): void {
  const username = accountUsername(result.account);
  replace(main,
    pageHeading("ACCOUNT CREATED", `欢迎，${result.account.profile.display_name}`, "账号与首个 Passkey 已创建。下一步请保存恢复材料。"),
    result.recovery_codes?.length ? recoveryCodePanel(result.recovery_codes) : statePanel("info", "未返回恢复代码", "请前往账号恢复页面生成并保存恢复代码。"),
    statePanel("success", "注册已生效", `主体 ${username ? `@${username}` : result.account.principal_id} 已激活。建议再添加一个独立 Passkey。`,
      el("a", { className: "button button--primary", attrs: { href: "/account/passkeys" } }, "管理 Passkeys")),
  );
}

/** 呈现无用户名 Passkey 登录。Renders username-less passkey authentication. */
function renderLogin(main: HTMLElement, api: IdentityApiClient, signal: AbortSignal): void {
  const message = el("div", { attrs: { "aria-live": "polite" } });
  const button = el("button", { className: "button button--primary button--large" }, "使用 Passkey 登录");
  button.addEventListener("click", async () => {
    setButtonBusy(button, true, "等待 Passkey…");
    replace(message, statePanel("loading", "等待设备验证", "请选择一个 Passkey，并完成解锁。"));
    try {
      const transaction = await api.startAuthentication({
        purpose: "login",
        ...(currentTransaction() ? { authorization_transaction_id: currentTransaction() } : {}),
      }, await requireBrowserCsrf(api, signal), signal);
      const credential = await getPasskey(transaction.public_key, signal);
      const result = await api.completeAuthentication(transaction.transaction_id, credential, {
        csrfToken: transaction.csrf_token,
        idempotencyKey: createIdempotencyKey(),
        signal,
      });
      rememberCsrf(result.csrf_token);
      if (result.authorization_resume_uri) {
        navigateToHttpUrl(result.authorization_resume_uri);
        return;
      }
      replace(main,
        pageHeading("SIGNED IN", `欢迎回来，${result.account.profile.display_name}`, "新的 Identity Session 已建立。"),
        statePanel("success", "登录成功", "你现在可以查看账号和安全状态。",
          el("a", { className: "button button--primary", attrs: { href: "/account" } }, "进入账号中心")),
      );
    } catch (error) {
      replace(message, statePanel("error", "登录未完成", errorMessage(error)));
      setButtonBusy(button, false);
    }
  });
  replace(main,
    pageHeading("PASSKEY SIGN IN", "欢迎回来", "无需输入用户名。浏览器会让你选择属于此站点的 Passkey。"),
    el("section", { className: "hero-card" },
      el("div", { className: "orb", attrs: { "aria-hidden": "true" } }, "✦"),
      el("h2", {}, "用你的设备证明是你"),
      el("p", {}, "Passkey 抗钓鱼，并由设备生物识别、PIN 或安全密钥保护。"),
      button,
      message,
    ),
    el("div", { className: "link-row" },
      el("a", { attrs: { href: "/register" } }, "创建账号"),
      el("a", { attrs: { href: "/recovery" } }, "使用恢复代码"),
    ),
  );
}

/** 呈现一次性代码恢复并立即登记新 Passkey 的流程。Renders one-time-code recovery followed immediately by new passkey enrollment. */
function renderRecovery(main: HTMLElement, api: IdentityApiClient, signal: AbortSignal): void {
  const message = el("div", { attrs: { "aria-live": "polite" } });
  const submit = el("button", { className: "button button--danger", attrs: { type: "submit" } }, "消费代码并更换 Passkey");
  const form = el("form", { className: "card form-card" },
    el("h2", {}, "输入一次性恢复代码"),
    field("恢复代码", "recovery_code", { required: true, autocomplete: "off", placeholder: "msf_rc_…" }),
    field("新 Passkey 标签", "authenticator_label", { required: true, autocomplete: "off", placeholder: "例如：新手机" }),
    el("p", { className: "hint" }, "恢复会撤销所有既有会话和 Token family；旧代码只可使用一次。"),
    message,
    submit,
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setButtonBusy(submit, true, "正在恢复…");
    replace(message, statePanel("loading", "验证恢复材料", "验证完成后，浏览器会立即要求创建新 Passkey。"));
    const input = form.elements.namedItem("recovery_code") as HTMLInputElement;
    const recoveryCode = input.value;
    input.value = "";
    try {
      const authenticatorLabel = String(new FormData(form).get("authenticator_label") ?? "").trim();
      const started = await api.startRecovery({ recovery_code: recoveryCode, authenticator_label: authenticatorLabel }, await requireBrowserCsrf(api, signal), signal);
      const credential = await createPasskey(started.public_key, signal);
      const recovery = await api.completeRecovery(started.transaction_id, started.csrf_token, credential, signal);
      rememberCsrf(recovery.csrf_token);
      replace(main,
        pageHeading("RECOVERY COMPLETE", "账号控制权已恢复", "新 Passkey、正常 Identity Session 与恢复材料已原子创建。"),
        statePanel("success", "恢复已生效", `“${recovery.authenticator.label}”是现在唯一的有效 Passkey。旧 Passkeys 与会话已撤销。`),
        recoveryCodePanel(recovery.recovery_codes),
      );
    } catch (error) {
      replace(message, statePanel("error", "恢复未完成", errorMessage(error)));
      setButtonBusy(submit, false);
    }
  });
  replace(main,
    pageHeading("ACCOUNT RECOVERY", "恢复账号控制权", "只有你保存的其他 Passkey 或一次性恢复代码可以恢复账号。"),
    form,
  );
}

/** 呈现账号资料概览和可编辑显示名称。Renders account overview and editable display name. */
async function renderAccount(main: HTMLElement, api: IdentityApiClient, signal: AbortSignal): Promise<void> {
  const envelope = await api.getPrincipal(signal);
  rememberCsrf(envelope.csrf_token);
  const principal = envelope.account;
  const username = accountUsername(principal);
  const message = el("div", { attrs: { "aria-live": "polite" } });
  const save = el("button", { className: "button button--primary", attrs: { type: "submit" } }, "保存显示名称");
  const form = el("form", { className: "card form-card" },
    el("h2", {}, "公开资料"),
    field("显示名称", "display_name", { required: true, autocomplete: "name", value: principal.profile.display_name }),
    el("dl", { className: "facts" },
      el("div", {}, el("dt", {}, "Username"), el("dd", {}, username ? `@${username}` : "尚未设置")),
      el("div", {}, el("dt", {}, "账号状态"), el("dd", {}, principal.lifecycle_state)),
      el("div", {}, el("dt", {}, "创建时间"), el("dd", {}, formatTime(principal.created_at))),
    ),
    message,
    save,
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setButtonBusy(save, true);
    try {
      const updated = await api.updatePrincipal({
        display_name: String(new FormData(form).get("display_name") ?? "").trim(),
      }, { csrfToken: await requireCsrf(api, signal), idempotencyKey: createIdempotencyKey(), signal });
      replace(message, statePanel("success", "资料已更新", `显示名称现在是“${updated.profile.display_name}”。`));
    } catch (error) {
      replace(message, statePanel("error", "保存失败", errorMessage(error)));
    } finally {
      setButtonBusy(save, false);
    }
  });
  replace(main,
    pageHeading("ACCOUNT", `你好，${principal.profile.display_name}`, "这里展示 Identity 当前确认的账号事实。"),
    form,
    el("section", { className: "quick-grid", attrs: { "aria-label": "安全管理入口" } },
      quickLink("/account/passkeys", "Passkeys", "逐个查看、命名、增加或撤销"),
      quickLink("/account/bindings", "Bindings", "管理外部身份边界"),
      quickLink("/account/sessions", "会话", "查看设备并撤销访问"),
      quickLink("/account/recovery", "恢复代码", "轮换一次性离线材料"),
    ),
  );
}

/** 呈现 Passkey 列表、重命名、登记和撤销。Renders passkey listing, rename, enrollment, and revocation. */
async function renderPasskeys(main: HTMLElement, api: IdentityApiClient, signal: AbortSignal, notice?: HTMLElement): Promise<void> {
  const response = await api.listAuthenticators(signal);
  const authenticators = unwrapList(response);
  const list = authenticators.length === 0
    ? statePanel("empty", "没有可用 Passkey", "账号目前没有 Passkey；恢复受限态下请立即添加一个。")
    : el("div", { className: "stack" }, ...authenticators.map((item) => authenticatorCard(item, api, signal, main)));
  const labelField = field("新 Passkey 标签", "label", { required: true, placeholder: "例如：Pixel 手机" });
  const add = el("button", { className: "button button--primary", attrs: { type: "submit" } }, "添加 Passkey");
  const addMessage = el("div", { attrs: { "aria-live": "polite" } });
  const addForm = el("form", { className: "card compact-form" }, labelField, add, addMessage);
  addForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setButtonBusy(add, true, "等待设备…");
    try {
      const label = String(new FormData(addForm).get("label") ?? "").trim();
      const transaction = await executeHighRisk(api, signal, addMessage, (controls) =>
        api.startAuthenticatorRegistration(label, controls));
      const credential = await createPasskey(transaction.public_key, signal);
      const completion = await api.completeAuthenticatorRegistration(transaction.transaction_id, credential, {
        csrfToken: transaction.csrf_token,
        idempotencyKey: createIdempotencyKey(),
        signal,
      });
      rememberCsrf(completion.csrf_token);
      await renderPasskeys(main, api, signal, statePanel("success", "Passkey 已添加", `“${completion.authenticator.label}”现在可以用于登录。`));
    } catch (error) {
      replace(addMessage, statePanel("error", "添加失败", errorMessage(error)));
      setButtonBusy(add, false);
    }
  });
  replace(main,
    pageHeading("AUTHENTICATORS", "Passkeys", "每个 Passkey 都是独立认证器。撤销后会展示最新服务端列表。"),
    notice,
    addForm,
    list,
  );
}

/** 创建一个可独立管理的 Passkey 卡片。Creates an independently manageable passkey card. */
function authenticatorCard(item: Authenticator, api: IdentityApiClient, signal: AbortSignal, main: HTMLElement): HTMLElement {
  const message = el("div", { attrs: { "aria-live": "polite" } });
  const rename = el("button", { className: "button button--quiet", attrs: { type: "submit" } }, "保存标签");
  const renameForm = el("form", { className: "inline-form" },
    field("设备标签", "label", { required: true, value: item.label }), rename,
  );
  renameForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setButtonBusy(rename, true);
    try {
      const updated = await api.renameAuthenticator(item.authenticator_id, String(new FormData(renameForm).get("label") ?? "").trim(), {
        csrfToken: await requireCsrf(api, signal), idempotencyKey: createIdempotencyKey(), signal,
      });
      await renderPasskeys(main, api, signal, statePanel("success", "标签已更新", `Passkey 现在显示为“${updated.label}”。`));
    } catch (error) {
      replace(message, statePanel("error", "重命名失败", errorMessage(error)));
      setButtonBusy(rename, false);
    }
  });
  const revoke = el("button", { className: "button button--danger", attrs: { type: "button" } }, "撤销这个 Passkey");
  revoke.addEventListener("click", async () => {
    if (!confirm(`确认撤销“${item.label}”？由它建立的相关会话也可能被撤销。`)) return;
    setButtonBusy(revoke, true, "正在撤销…");
    try {
      await executeHighRisk(api, signal, message, (controls) => api.revokeAuthenticator(item.authenticator_id, controls));
      await renderPasskeys(main, api, signal, statePanel("success", "Passkey 已撤销", `“${item.label}”已从可用认证器列表移除。`));
    } catch (error) {
      replace(message, statePanel("error", "撤销失败", errorMessage(error)));
      setButtonBusy(revoke, false);
    }
  });
  return el("article", { className: "card entity-card" },
    el("div", { className: "entity-card__heading" },
      el("div", {}, el("h2", {}, item.label), el("p", { className: "muted" }, item.is_current ? "建立了当前会话" : "未建立当前会话")),
      el("span", { className: `badge ${item.backup_state ? "badge--synced" : ""}` }, item.backup_state ? "已同步" : item.backup_eligible ? "可同步" : "设备绑定"),
    ),
    el("dl", { className: "facts facts--row" },
      el("div", {}, el("dt", {}, "创建"), el("dd", {}, formatTime(item.created_at))),
      el("div", {}, el("dt", {}, "最近使用"), el("dd", {}, formatTime(item.last_used_at))),
    ),
    renameForm, revoke, message,
  );
}

/** 呈现 provider 与已建立 Binding。Renders providers and established identity bindings. */
async function renderBindings(main: HTMLElement, api: IdentityApiClient, signal: AbortSignal, notice?: HTMLElement): Promise<void> {
  const [bindingResponse, providerResponse] = await Promise.all([api.listBindings(signal), api.listBindingProviders(signal)]);
  const bindings = unwrapList(bindingResponse);
  const providers = unwrapList(providerResponse);
  const established = bindings.length
    ? el("div", { className: "stack" }, ...bindings.map((binding) => bindingCard(binding, api, signal, main)))
    : statePanel("empty", "尚无外部 Binding", "你的账号目前只能通过本地 Passkey 进入。");
  const available = providers.length
    ? el("div", { className: "provider-grid" }, ...providers.map((provider) => providerCard(provider, api, signal)))
    : statePanel("empty", "没有可用 Provider", "部署配置尚未启用外部身份 Provider。Passkey 登录不受影响。");
  replace(main,
    pageHeading("FEDERATED IDENTITY", "Identity Bindings", "Binding 扩大账号的身份边界；相同 Email 不会自动合并账号。"),
    notice,
    el("section", {}, el("h2", {}, "已建立"), established),
    el("section", {}, el("h2", {}, "可添加的 Provider"), available),
  );
}

/** 创建已建立 Binding 卡片。Creates an established binding card. */
function bindingCard(binding: IdentityBinding, api: IdentityApiClient, signal: AbortSignal, main: HTMLElement): HTMLElement {
  const message = el("div", { attrs: { "aria-live": "polite" } });
  const remove = el("button", { className: "button button--danger" }, "解除 Binding");
  remove.addEventListener("click", async () => {
    if (!confirm(`确认解除 ${binding.display_label ?? binding.provider_id}？由它建立的会话也会被撤销。`)) return;
    setButtonBusy(remove, true, "正在解除…");
    try {
      await executeHighRisk(api, signal, message, (controls) => api.removeBinding(binding.binding_id, controls));
      await renderBindings(main, api, signal, statePanel("success", "Binding 已解除", "外部主体已从服务端列表移除，相关认证能力不再有效。"));
    } catch (error) {
      replace(message, statePanel("error", "解除失败", errorMessage(error)));
      setButtonBusy(remove, false);
    }
  });
  return el("article", { className: "card entity-card" },
    el("div", { className: "entity-card__heading" },
      el("div", {}, el("h3", {}, binding.display_label ?? binding.provider_id), el("p", { className: "muted" }, binding.provider_id)),
      el("span", { className: "badge" }, binding.authentication_enabled ? "可用于登录" : "仅绑定"),
    ),
    el("p", {}, `建立于 ${formatTime(binding.created_at)} · 最近认证 ${formatTime(binding.last_authenticated_at)}`),
    remove, message,
  );
}

/** 创建可建立 Binding 的 provider 卡片。Creates a provider card for starting a binding. */
function providerCard(provider: BindingProvider, api: IdentityApiClient, signal: AbortSignal): HTMLElement {
  const message = el("div", { attrs: { "aria-live": "polite" } });
  const add = el("button", { className: "button button--quiet" }, `绑定 ${provider.display_name}`);
  add.addEventListener("click", async () => {
    setButtonBusy(add, true, "准备跳转…");
    try {
      const result = await executeHighRisk(api, signal, message, (controls) => api.startBinding(provider.provider_id, controls));
      navigateToHttpUrl(result.authorization_uri);
    } catch (error) {
      replace(message, statePanel("error", "无法开始绑定", errorMessage(error)));
      setButtonBusy(add, false);
    }
  });
  return el("article", { className: "card provider-card" },
    el("h3", {}, provider.display_name),
    el("p", {}, provider.authentication_enabled ? "绑定后可作为较低认证上下文的登录入口。" : "仅建立外部主体映射，不能用于登录。"),
    add, message,
  );
}

/** 呈现当前及其他 Identity Sessions。Renders current and other identity sessions. */
async function renderSessions(main: HTMLElement, api: IdentityApiClient, signal: AbortSignal, notice?: HTMLElement): Promise<void> {
  const response = await api.listSessions(signal);
  const sessions = unwrapList(response);
  const revokeAll = el("button", { className: "button button--danger" }, "撤销全部设备会话");
  const allMessage = el("div", { attrs: { "aria-live": "polite" } });
  revokeAll.addEventListener("click", async () => {
    if (!confirm("确认撤销全部 Identity Sessions？当前页面也会退出登录。")) return;
    setButtonBusy(revokeAll, true, "正在全部撤销…");
    try {
      await api.revokeAllSessions({ csrfToken: await requireCsrf(api, signal), idempotencyKey: createIdempotencyKey(), signal });
      replace(main,
        pageHeading("SESSIONS", "全部会话已撤销", "服务端不再接受这些 Identity Session。"),
        statePanel("success", "撤销已生效", "包括当前设备在内的会话已失效。", el("a", { className: "button button--primary", attrs: { href: "/login" } }, "重新登录")),
      );
    } catch (error) {
      replace(allMessage, statePanel("error", "批量撤销失败", errorMessage(error)));
      setButtonBusy(revokeAll, false);
    }
  });
  const list = sessions.length
    ? el("div", { className: "stack" }, ...sessions.map((session) => sessionCard(session, api, signal, main)))
    : statePanel("empty", "没有活跃会话", "服务端当前没有返回任何 Identity Session。");
  replace(main,
    pageHeading("SESSIONS", "Identity Sessions", "逐个查看最近活动和绝对过期时间，并在异常时撤销。"),
    notice,
    el("section", { className: "card danger-zone" }, el("h2", {}, "全部设备登出"), el("p", {}, "这会撤销全部 Identity Session 和关联的 Refresh Token families。"), revokeAll, allMessage),
    list,
  );
}

/** 创建可撤销 Session 卡片。Creates a revocable session card. */
function sessionCard(session: IdentitySession, api: IdentityApiClient, signal: AbortSignal, main: HTMLElement): HTMLElement {
  const message = el("div", { attrs: { "aria-live": "polite" } });
  const revoke = el("button", { className: "button button--danger" }, session.is_current ? "撤销当前会话" : "撤销会话");
  revoke.addEventListener("click", async () => {
    if (!confirm(`确认撤销这个 ${session.authentication_method} 会话？`)) return;
    setButtonBusy(revoke, true, "正在撤销…");
    try {
      await api.revokeSession(session.session_id, {
        csrfToken: await requireCsrf(api, signal), idempotencyKey: createIdempotencyKey(), signal,
      });
      if (session.is_current) {
        navigate("/login");
        return;
      }
      await renderSessions(main, api, signal, statePanel("success", "会话已撤销", "指定会话已从活跃列表移除。"));
    } catch (error) {
      replace(message, statePanel("error", "撤销失败", errorMessage(error)));
      setButtonBusy(revoke, false);
    }
  });
  return el("article", { className: "card entity-card" },
    el("div", { className: "entity-card__heading" },
      el("h2", {}, session.authentication_method === "passkey" ? "Passkey 会话" : "Federated 会话"),
      session.is_current && el("span", { className: "badge badge--current" }, "当前会话"),
    ),
    el("dl", { className: "facts facts--row" },
      el("div", {}, el("dt", {}, "最近活动"), el("dd", {}, formatTime(session.last_seen_at))),
      el("div", {}, el("dt", {}, "绝对过期"), el("dd", {}, formatTime(session.expires_at))),
      el("div", {}, el("dt", {}, "认证上下文"), el("dd", {}, session.acr)),
    ),
    revoke, message,
  );
}

/** 呈现恢复代码轮换与一次性展示。Renders recovery-code rotation and one-time display. */
async function renderRecoveryCodes(main: HTMLElement, api: IdentityApiClient, signal: AbortSignal, result?: RecoveryCodeRotation): Promise<void> {
  if (!sessionCsrfToken) {
    const envelope = await api.getPrincipal(signal);
    rememberCsrf(envelope.csrf_token);
  }
  const status = result ?? await api.getRecoveryCodeStatus(signal);
  const message = el("div", { attrs: { "aria-live": "polite" } });
  const rotate = el("button", { className: "button button--danger" }, result ? "再次轮换" : "生成一组新恢复代码");
  rotate.addEventListener("click", async () => {
    if (!confirm("轮换后，所有旧恢复代码都会失效。确认继续？")) return;
    setButtonBusy(rotate, true, "正在轮换…");
    try {
      const rotated = await executeHighRisk(api, signal, message, (controls) => api.rotateRecoveryCodes(controls));
      await renderRecoveryCodes(main, api, signal, rotated);
    } catch (error) {
      replace(message, statePanel("error", "轮换失败", errorMessage(error)));
      setButtonBusy(rotate, false);
    }
  });
  replace(main,
    pageHeading("RECOVERY MATERIAL", "恢复代码", "代码是 Passkey 全部丢失时唯一的账号恢复方式。Identity 不提供 Email 或人工绕过。"),
    statePanel("info", "当前恢复材料", `共 ${status.total_count} 个代码，剩余 ${status.remaining_count} 个；生成于 ${formatTime(status.generated_at)}。`),
    result && statePanel("success", "恢复代码已轮换", `新代码生成于 ${formatTime(result.generated_at)}；旧代码已失效。`),
    result && recoveryCodePanel(result.recovery_codes),
    el("section", { className: "card danger-zone" },
      el("h2", {}, "轮换恢复材料"),
      el("p", {}, "此操作需要近期 Passkey 验证。请将新代码离线保存在受控位置。"),
      rotate, message,
    ),
  );
}

/** 创建一次性恢复代码展示、复制与下载区域。Creates one-time recovery-code display, copy, and download controls. */
function recoveryCodePanel(codes: string[]): HTMLElement {
  const message = el("div", { attrs: { "aria-live": "polite" } });
  const list = el("ol", { className: "recovery-list" }, ...codes.map((code) => el("li", {}, el("code", {}, code))));
  const copy = el("button", { className: "button button--quiet" }, "复制全部");
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      replace(message, statePanel("success", "已复制", "请粘贴到你控制的离线秘密管理位置。"));
    } catch {
      replace(message, statePanel("error", "无法访问剪贴板", "请逐条手动抄录，或使用下载按钮。"));
    }
  });
  const download = el("button", { className: "button button--quiet" }, "下载文本文件");
  download.addEventListener("click", () => downloadRecoveryCodes(codes));
  return el("section", { className: "card recovery-card" },
    el("h2", {}, "只显示这一次"),
    el("p", {}, "页面离开后无法重新读取这些代码。每个代码只能使用一次。"),
    list,
    el("div", { className: "button-row" }, copy, download),
    message,
  );
}

/** 用用户触发的本地下载保存恢复代码，不写入 Web Storage。Downloads recovery codes on explicit user action without Web Storage. */
function downloadRecoveryCodes(codes: string[]): void {
  const blob = new Blob([`moeSegFault recovery codes\n\n${codes.join("\n")}\n`], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = el("a", { attrs: { href: url, download: "moesegfault-recovery-codes.txt" } });
  anchor.click();
  URL.revokeObjectURL(url);
}

/** 创建账号安全快捷入口。Creates an account-security shortcut. */
function quickLink(href: AppRoute, title: string, detail: string): HTMLAnchorElement {
  return el("a", { className: "quick-link", attrs: { href } }, el("strong", {}, title), el("span", {}, detail), el("b", { attrs: { "aria-hidden": "true" } }, "→"));
}

/** 规范化裸数组或资源包装列表。Normalizes bare arrays and resource-wrapped lists. */
function unwrapList<T>(response: ResourceList<T>): T[] {
  return response.items;
}

/** 从列表包装获取页面生命周期 CSRF token。Reads a page-lifetime CSRF token from a list envelope. */
/** 从账号 identifiers 中取得首期 username。Reads the first-release username from account identifiers. */
function accountUsername(account: { identifiers: Array<{ kind: string; value: string }> }): string | undefined {
  return account.identifiers.find((identifier) => identifier.kind === "username")?.value;
}

/** 仅在内存中记住非空 CSRF token。Remembers a non-empty CSRF token in memory only. */
function rememberCsrf(value: string | undefined): void {
  if (value) sessionCsrfToken = value;
}

/** 获取 CSRF token；缺失时从当前 Principal 刷新一次。Gets a CSRF token, refreshing current principal once if missing. */
async function requireCsrf(api: IdentityApiClient, signal: AbortSignal): Promise<string> {
  if (sessionCsrfToken) return sessionCsrfToken;
  const envelope = await api.getPrincipal(signal);
  rememberCsrf(envelope.csrf_token);
  if (!sessionCsrfToken) throw new Error("Identity 未返回请求防伪令牌，请刷新页面后重试。");
  return sessionCsrfToken;
}

/** 获取匿名浏览器绑定的 CSRF token，并只保存在当前 Realm。Gets an anonymous browser CSRF token and retains it only in this realm. */
async function requireBrowserCsrf(api: IdentityApiClient, signal: AbortSignal): Promise<string> {
  const context = await api.getBrowserContext(signal);
  return context.csrf_token;
}

/**
 * 在原位告知用户并调度可重用的 Passkey 再认证。
 * Notifies the user in place and coordinates reusable passkey step-up.
 */
function executeHighRisk<T>(
  api: IdentityApiClient,
  signal: AbortSignal,
  message: HTMLElement,
  operation: (controls: HighRiskRequestControls) => Promise<T>,
): Promise<T> {
  return stepUpCoordinator(api).execute(operation, {
    signal,
    onStepUpRequired: () => replace(message, statePanel(
      "loading",
      "需要再次验证 Passkey",
      "此操作会改变账号恢复或登录能力。请按浏览器提示确认是你本人。",
    )),
  });
}

/** 延迟创建协调器，且不持久化任何令牌或 assertion。Lazily creates a coordinator without persisting tokens or assertions. */
function stepUpCoordinator(api: IdentityApiClient): InlineStepUpCoordinator {
  const existing = stepUpCoordinators.get(api);
  if (existing) return existing;
  const created = new InlineStepUpCoordinator(api, {
    readSessionCsrf: (signal) => requireCsrf(api, signal),
    readBrowserCsrf: (signal) => requireBrowserCsrf(api, signal),
    rememberSessionCsrf: rememberCsrf,
  });
  stepUpCoordinators.set(api, created);
  return created;
}

/** 只允许 Identity 返回的 HTTP(S) 完整导航，拒绝脚本 scheme。Allows only an absolute HTTP(S) navigation returned by Identity. */
function navigateToHttpUrl(value: string): void {
  const target = new URL(value, location.origin);
  if (!["https:", "http:"].includes(target.protocol)) throw new Error("Identity 返回了不安全的导航地址。");
  location.assign(target.href);
}

/** 呈现可恢复的加载错误；401 特别引导重新登录。Renders a recoverable load error; 401 specifically directs sign-in. */
function renderPageError(main: HTMLElement, error: unknown, retry: () => void): void {
  const isUnauthorized = error instanceof ApiError && error.status === 401;
  const action = isUnauthorized
    ? el("a", { className: "button button--primary", attrs: { href: "/login" } }, "重新登录")
    : el("button", { className: "button button--primary", on: { click: retry } }, "重试");
  replace(main,
    pageHeading("UNAVAILABLE", isUnauthorized ? "需要登录" : "暂时无法读取页面", "没有敏感数据被写入浏览器存储。"),
    statePanel("error", isUnauthorized ? "Identity Session 无效" : "请求失败", errorMessage(error), action),
  );
}
