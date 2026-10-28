# `passkey-auth` 0.1.3 Workers patch / Workers 补丁说明

## Provenance / 来源

- Upstream package: `passkey-auth` 0.1.3
- crates.io archive checksum: `68b76d109aa51f99c94d2f361c10dc0c93980dd87aa1ad5212df83e7e1b80a29`
- Upstream repository: <https://github.com/marirs/passkey-auth-rs>
- Upstream Git revision recorded by the published crate:
  `63a54b2df1cdc10d6f42b3383a761b68f8d68bf4`
- License: MIT OR Apache-2.0. The upstream `LICENSE` and `APACHE-LICENSE`
  files are preserved verbatim.

本目录来自 crates.io 发布的 `passkey-auth` 0.1.3；发布包记录的来源、校验和与
双许可证文件均保留，便于审计和复现。

## Why the fork exists / 补丁原因

The upstream `types::now_secs()` unconditionally called
`std::time::SystemTime::now()`. That compiles for `wasm32-unknown-unknown`, but
the standard-library implementation panics when a registration or
authentication ceremony starts in workerd/Cloudflare Workers.

上游 `types::now_secs()` 无条件调用 `std::time::SystemTime::now()`；该调用能
通过 `wasm32-unknown-unknown` 编译，却会在 workerd/Cloudflare Workers 开始
注册或认证仪式时 panic。

Cloudflare documents `Date.now()` as the supported current-time API in the
Workers runtime. `js_sys::Date::now()` is the `wasm-bindgen` binding for that API
and returns milliseconds since the Unix epoch:

- <https://developers.cloudflare.com/workers/reference/security-model/>
- <https://developers.cloudflare.com/workers/runtime-apis/web-standards/>
- <https://docs.rs/js-sys/0.3.102/js_sys/struct.Date.html#method.now>

## Exact source delta / 精确源码差异

Relative to the published crate, the maintained patch is deliberately small:

1. `src/types.rs`
   - keeps the original `SystemTime` implementation behind
     `cfg(not(all(target_arch = "wasm32", target_os = "unknown")))`;
   - adds a `cfg(all(target_arch = "wasm32", target_os = "unknown"))`
     implementation backed by
     `js_sys::Date::now()`;
   - floors milliseconds to seconds, preserving the original Unix-seconds
     representation and every registration/authentication expiry comparison;
   - maps non-finite or pre-epoch host values to zero, matching the native
     function's non-panicking fallback;
   - adds one native boundary test for the abstraction.
2. `Cargo.toml` and `Cargo.toml.orig`
   - add target-only `js-sys = 0.3.102`;
   - enable `getrandom/js` only on `wasm32`, so this vendored package is also
     independently checkable for the Worker target.
3. `Cargo.lock`
   - is regenerated only for those target dependencies and retained for
     reproducible standalone validation of this vendored package.
4. `WORKER-PATCH.md`
   - records provenance, validation, and maintenance policy; it is not library
     runtime code.

The published `.cargo_vcs_info.json`, `.cargo-ok`, and `.gitignore` are also
retained byte-for-byte as provenance/package artifacts; the first two and the
lockfile are force-added because upstream's own `.gitignore` excludes them.

除上述时钟选择、目标依赖、测试与本说明外，上游实现未改动。尤其没有修改
challenge 生成、客户端数据校验、签名验证、计数器规则、attestation 处理或
仪式过期阈值，因此 WebAuthn 验证语义保持不变。

To reproduce the code delta against a freshly unpacked upstream package:

```powershell
git diff --no-index -- `
  "$env:USERPROFILE/.cargo/registry/src/index.crates.io-*/passkey-auth-0.1.3" `
  crates/vendor/passkey-auth-worker
```

The expected runtime-code diff is limited to `src/types.rs`; dependency metadata
is limited to the two target-only dependencies above.

## Validation contract / 验证契约

Run from the repository root with the pinned toolchain:

```powershell
Push-Location crates/vendor/passkey-auth-worker
cargo test --locked --lib --tests
cargo check --locked --target wasm32-unknown-unknown
Pop-Location

cargo test --workspace --locked
cargo check --workspace --locked --target wasm32-unknown-unknown
$env:RUSTUP_TOOLCHAIN = "1.88.0"
worker-build --release crates/identity-worker
```

Compilation alone is insufficient: start Wrangler in local mode with a fresh
D1 persistence directory, apply `migrations/`, then POST both registration-start
and authentication-start requests. The registration response must contain a
non-empty WebAuthn challenge and must not contain the former `SystemTime` panic.

仅有编译结果不够：还必须使用全新的本地 D1 持久化目录启动 Wrangler，应用
`migrations/`，并实测注册与认证 start 请求。注册响应必须含非空 WebAuthn
challenge，且日志和响应中不得再出现 `SystemTime` panic。

## Maintenance strategy / 维护策略

1. Keep the consuming dependency pinned to this path and version `=0.1.3`.
2. For an upstream upgrade, unpack the exact crates.io release into a temporary
   directory, verify its archive checksum and license files, and compare all
   files before porting this patch.
3. Re-run the complete validation contract, including real workerd requests.
4. Remove this fork as soon as an upstream release provides a tested
   `wasm32-unknown-unknown` clock path; do not carry both implementations or add
   request-layer workarounds.
5. Never mix product changes into this vendor directory. A future patch must be
   separately documented and reviewable against the recorded upstream source.

消费方固定使用本路径与 `=0.1.3`。升级时先验证新发布包与许可证，再重新移植并
执行完整验证；上游一旦正式支持该目标，应删除本 fork，而不是叠加兼容分支。

## Security dependency update — 2026-10-28

[RUSTSEC-2026-0387](https://rustsec.org/advisories/RUSTSEC-2026-0387.html)
reports secret-dependent timing in crypto-bigint arithmetic before 0.7.6.
Although this server only verifies public WebAuthn inputs (authenticator private
keys stay on user devices), a supported stable upstream upgrade is available;
no advisory ignore or local cryptographic backport is needed.

The pinned lockfiles now resolve the stable `p256 0.14.0` →
`elliptic-curve 0.14.3` → `crypto-bigint 0.7.10` chain. The upstream minimum Rust
versions are respectively 1.85, 1.87, and 1.87, compatible with the repository's
Rust 1.88 toolchain. The vendor manifest minimum is raised to 1.87 accordingly.
`crypto-bigint 0.7.6` was the initial security fix, but is now yanked; 0.7.10 is
the maintained non-yanked stable resolution. `deny.toml` remains unchanged.

Production `p256` explicitly disables defaults and enables `ecdsa` plus `alloc`.
In particular, this does not add a new OS RNG/getrandom backend to the Worker.
Only native dev/test builds enable p256's default `std`/RNG features for synthetic
signers. The existing rand 0.8 + getrandom 0.2 JavaScript-backed challenge
randomness is unchanged. `cargo tree --locked -p identity-worker --target
wasm32-unknown-unknown -i getrandom@0.4.3` has no production path.

The dependency generation renames SEC1 point APIs; `src/crypto.rs` and
`src/attestation.rs` use the corresponding upstream `Sec1Point` and
`FromSec1Point` names. `x509-cert` moves to 0.3 (and `const-oid` to 0.10) to match
signature 3 / DER 0.8 traits used by the P-256 attestation test certificate
builder. `src/x509.rs` accesses the same parsed DER fields through upstream
getters. The synthetic certificate tests use a minimal self-signed attestation
profile, not the new TLS-oriented certificate profiles.

Credential COSE bytes, stored credential IDs, public coordinates, SHA-256
message hashing, strict DER signature encoding, challenge/state formats, and
accepted algorithms remain unchanged. Both high-S and low-S ES256 signatures
remain valid: upstream p256's `NistP256::NORMALIZE_S` is false. The fixed RFC 6979
A.2.5 public key and SHA-256 signature of `sample`, plus its `n-s` twin, exercise
this compatibility without a newly generated signature hiding drift. Tampered
messages and malformed DER reject. Existing ceremony and attestation end-to-end
tests continue to cover generated Ed25519/P-256 verification and certificate
AAGUID matching/rejection.

Sources:
- [P-256 0.14 manifest](https://docs.rs/crate/p256/0.14.0/source/Cargo.toml)
- [elliptic-curve 0.14.3 manifest](https://docs.rs/crate/elliptic-curve/0.14.3/source/Cargo.toml)
- [crypto-bigint changelog](https://docs.rs/crate/crypto-bigint/0.7.10/source/CHANGELOG.md)
- [RFC 6979 test vectors](https://www.rfc-editor.org/rfc/rfc6979#appendix-A.2.5)

This section supersedes the earlier statement that runtime delta is limited to
`src/types.rs` and metadata to clock dependencies. The complete vendor delta
also includes the explicitly scoped security dependency/API updates above.

Validation completed on Rust 1.88.0 (Windows, one compiler job):

```text
cargo check --manifest-path crates/vendor/passkey-auth-worker/Cargo.toml --lib --locked -j 1
cargo check --manifest-path crates/vendor/passkey-auth-worker/Cargo.toml --lib --locked --target wasm32-unknown-unknown -j 1
cargo test --manifest-path crates/vendor/passkey-auth-worker/Cargo.toml --locked --lib --test attestation_e2e --test ceremony_e2e -j 1
```

The native and wasm32 checks passed; all 48 tests passed (29 unit, 6 certificate-attestation,
13 ceremony). Hosted Actions remains the release gate for the complete Identity
Worker, dependency policy, and staging user journey.
