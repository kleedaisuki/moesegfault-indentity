# moeSegFault Identity

moeSegFault 的统一账户与身份平台：密码是可靠的基础入口，Passkey 是可选且抗钓鱼的增强入口；登录仪式、账号管理与身份权威分别部署。

The unified account and identity platform for moeSegFault. Passwords provide the universal baseline while passkeys remain an optional phishing-resistant upgrade. Login ceremonies, account management, and identity authority are separate deployments.

## 架构 / Architecture

```text
login.moesegfault.dev      account.moesegfault.dev
registration + sign-in    profile + contacts + security
            \              /
             identity.moesegfault.dev
             D1 authority + OAuth/OIDC + R2 audit
```

| 单元 / Unit | 职责 / Responsibility |
| --- | --- |
| `apps/login` | 注册、密码/Passkey 登录、恢复与 OAuth 恢复；不再承载账号管理 / registration, authentication, recovery, OAuth resume |
| `apps/account` | 资料、头像、联系方式、偏好、凭据、会话与应用授权体验 / modern self-service account experience |
| `crates/identity-domain` | 平台无关的领域类型与不变量 / platform-independent domain invariants |
| `crates/identity-worker` | D1/R2、HTTP、OAuth/OIDC 与定时任务适配 / authority and protocol adapter |
| `openapi/identity.yaml` | OpenAPI 3.1.1 唯一 HTTP 契约 / canonical HTTP contract |
| `migrations` | 只向前的 D1 模式演进 / forward-only D1 schema |

其他服务不“调用 Login 来验证 Token”。它们通过 `/.well-known/openid-configuration` 接入 Identity 的 OpenID Connect（OIDC），使用 Authorization Code + Proof Key for Code Exchange（PKCE）；浏览器应用优先采用前端专属后端（Backend for Frontend, BFF），令牌不进入浏览器存储。

平台设计见 [`ADR-0003`](docs/adr/0003-account-platform-redesign.md)，Cloudflare 邮箱验证与持久投递边界见 [`ADR-0004`](docs/adr/0004-email-verification.md)；视觉与同好社区研究见 [`docs/research/moesegfault-style-and-community-identity.md`](docs/research/moesegfault-style-and-community-identity.md)。

## 账户能力 / Account capabilities

- Username、必填 Email、可选国际手机号（独立国家区号并规范化为 E.164）。
- 通过 Cloudflare Email Service 发送 8 位邮箱验证码；D1 加密投递箱在供应商暂时不可用时异步重试。
- Unicode display name、avatar、bio、status、pronouns、favorite character、interest tags 与隐私可见性。
- 密码与 Passkey 并存；认证方法参考（Authentication Method Reference, AMR）和多因素认证（Multi-Factor Authentication, MFA）模型可扩展至 TOTP 等方式。
- 简体中文、English、日本語；`light`、`dark`、`system` 三态主题。
- 320px 起的响应式布局、安全区、动态视口和内置浏览器降级；无法使用 Passkey 时密码路径仍可用。
- 本地打包的 `moesegfault-style` v0.1.2 视觉令牌、品牌 SVG 与功能 SVG；认证关键路径不依赖第三方 CDN。

## 本地开发 / Local development

需要 Rust `1.88.0`、Node.js `24`、npm `11`，以及 WebAssembly target。

```bash
npm ci --ignore-scripts
npm audit --audit-level=high
cp .dev.vars.example .dev.vars

cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
cargo test --workspace --all-features --locked
cargo check -p identity-worker --target wasm32-unknown-unknown --locked

npm run typecheck:frontend-shared && npm run test:frontend-shared
npm run lint:login && npm run typecheck:login && npm run test:login && npm run build:login
npm run lint:account && npm run typecheck:account && npm run test:account && npm run build:account
npm run lint:openapi
npm run migrate:local
npm run test:migrations

# worker-build 0.8.5 is required / 需要 worker-build 0.8.5
npm run dry-run:identity
node scripts/tests/security-boundary.mjs
npm run dry-run:login
npm run dry-run:account
```

依赖清单与锁文件应一同审查，确保 `npm ci` 和 Cargo `--locked` 检查可复现。Vendored Passkey crate 有独立锁文件且不属于工作区；修改它时须单独验证。避免没有兼容性或安全公告依据的版本变动，并让仓库内 SKILL 的集成说明与 discovery、OpenAPI 和实际处理器保持一致。

Review dependency manifests with their lockfiles so `npm ci` and Cargo's `--locked` checks remain reproducible. The vendored Passkey crate is outside the workspace and has its own lockfile; validate it separately when changed. Avoid version-only churn without a concrete compatibility or advisory reason, and keep the checked-in SKILL's integration claims aligned with discovery, OpenAPI, and live handlers.

## CI/CD 与 SRE

GitHub Actions 对 Rust、Wasm、两个前端及共享浏览器原语、OpenAPI、全新和含数据的 D1 migration、隔离本地 D1 上的 Worker 请求边界、脚本和三个 Wrangler 包执行门禁。npm 工作区共享一个锁文件，依赖公告审计在契约任务中运行一次并阻止打包。`main` 把同一个校验和制品先部署至 staging 并冒烟验证，再经 GitHub Environment 提升至 production；不会在两个环境重新构建。

可观测性是发布契约的一部分：结构化日志和关联 ID 必须覆盖认证与 OAuth 路径，指标保持低基数，SLO 同时约束可用性与延迟。告警、回滚、迁移和故障响应见 [`infra/RUNBOOK.md`](infra/RUNBOOK.md)。

## 密钥 / Secrets

仓库只保存非敏感资源配置。GitHub Environments 提供 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID` 与用于头像 R2 自定义域名的 `CLOUDFLARE_ZONE_ID`；运行时 pepper、事务加密密钥、OIDC 私钥及 provider secret 只能放入 Workers Secrets，不得写入 JSONC、D1、日志或前端制品。完整清单见 [`.dev.vars.example`](.dev.vars.example) 和运行手册。

## License

[GNU General Public License v3.0 only](LICENSE).
