# moeSegFault Identity

`moesegfault-identity` 是 moeSegFault 的 Passkey-first 身份权威，采用纯 Rust Cloudflare Worker 后端和 TypeScript 登录前端。

`moesegfault-identity` is moeSegFault's Passkey-first identity authority, implemented as a pure Rust Cloudflare Worker backend and a TypeScript login frontend.

## 架构 / Architecture

```text
login.moesegfault.dev                  identity.moesegfault.dev
TypeScript + Workers Static Assets --> Rust workers-rs Worker
                                        |-- D1 identity facts
                                        |-- private R2 audit archive
                                        `-- UTC cron outbox drain
```

两者是独立 Worker 与独立发布单元。Login 不绑定 D1/R2，不签发令牌。详细的边界、数据模型与协议不变量见 [`docs/login-identity-design.md`](docs/login-identity-design.md)。

They are independent Workers and deployment units. Login has no D1/R2 binding and issues no tokens. See [`docs/login-identity-design.md`](docs/login-identity-design.md) for boundaries, data models, and protocol invariants.

| 路径 / Path | 职责 / Responsibility |
| --- | --- |
| `crates/identity-domain` | 平台无关的领域类型、不变量与纯逻辑 / platform-independent domain logic |
| `crates/identity-worker` | Cloudflare D1/R2/HTTP/Cron 适配层 / Cloudflare adapter |
| `apps/login` | 无 token 持久化的 TypeScript UI / TypeScript UI without token persistence |
| `migrations` | 只向前的 D1 migrations / forward-only D1 migrations |
| `openapi` | OpenAPI 3.1.1 机器契约 / machine-readable contract |

## 本地开发 / Local development

需要 Rust `1.88.0`、Node.js `24` 和 npm `11`。版本已由 `rust-toolchain.toml` 与 lockfile 固定。

Rust `1.88.0`, Node.js `24`, and npm `11` are required. Tool and dependency versions are pinned by `rust-toolchain.toml` and lockfiles.

```bash
npm ci --ignore-scripts
cp .dev.vars.example .dev.vars

cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
cargo test --workspace --all-features --locked
cargo check -p identity-worker --target wasm32-unknown-unknown --locked

npm run lint:login
npm run test:login
npm run build:login
npm run lint:openapi
npm run migrate:local

# worker-build 0.8.5 must be installed first / 需先安装 worker-build 0.8.5
npm run dry-run:identity
npm run dry-run:login
```

`wrangler.identity.jsonc` 默认指向独立 staging D1/R2 和 staging Custom Domain。Wrangler 本地模式使用本地存储；不要在普通开发中使用 `--remote`。

The default identity configuration names dedicated staging resources and Custom Domains. Wrangler local mode uses local storage; do not add `--remote` during routine development.

## CI/CD

- Pull request 不读取 Cloudflare secrets；它执行 Rust fmt/clippy/test/Wasm build、TypeScript lint/test/build、OpenAPI lint、全新本地 D1 migration 和两个 Wrangler dry-run。
- `main` 在同一工作流的所有门禁通过后，通过 `cloudflare-deployment` GitHub Environment 串行执行 production D1 migration、identity deploy、login deploy 与公网冒烟检查。
- 首次资源检查/创建仅在手动 **Cloudflare bootstrap** 工作流执行。日常发布不重建资源，不直接修改 DNS。
- Custom Domains 声明在 `wrangler.*.jsonc`，由 Cloudflare 调和 DNS 与证书。

Production operations, token permissions, migration discipline, and rollback steps are documented in [`infra/RUNBOOK.md`](infra/RUNBOOK.md).

## 密钥 / Secrets

仓库仅存储非敏感资源 ID。GitHub 需要 `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID`；Worker 基础运行时需要 `REGISTRATION_PEPPER`、`RECOVERY_CODE_PEPPER`、`TRANSACTION_PEPPER`、`TRANSACTION_STATE_KEY`、`SESSION_PEPPER` 与 `CSRF_PEPPER`。开启 OAuth 还需 `AUTHORIZATION_CODE_PEPPER`、`REFRESH_TOKEN_PEPPER`、`PAIRWISE_SUBJECT_KEY` 和 `OIDC_PRIVATE_KEY_PKCS8`。它们必须分别用 `wrangler secret put` 配置，不得写入 JSONC、D1 或前端构建物。`TRANSACTION_STATE_KEY` 是无填充 Base64URL 编码的 32-byte key；`OIDC_PRIVATE_KEY_PKCS8` 是 PKCS#8 PEM 编码的 RSA 私钥。

Only non-secret resource IDs are committed. Runtime secrets belong in Workers Secrets, never JSONC, D1, or frontend bundles.

## License

[GNU General Public License v3.0 only](LICENSE).
