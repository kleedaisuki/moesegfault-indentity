# WebAuthn / Workers Wasm feasibility and runtime validation

Date: 2026-09-13

## Question

Can `passkey-auth = 0.1.3` and `worker = 0.8.5` coexist in a pure-Rust
Cloudflare Worker targeting `wasm32-unknown-unknown`, without OpenSSL,
`ring`, or `webauthn-rs`?

## Compile reproduction

The isolated spike used Rust 1.88.0, `worker-build = 0.8.5`, and a handler
which called `Webauthn::start_authentication(&[])` and type-checked D1 and R2
binding access.

```powershell
cargo +1.88.0 check --target wasm32-unknown-unknown --locked
$env:RUSTUP_TOOLCHAIN = "1.88.0"
worker-build --release
```

The dependency initially required explicit WebAssembly feature unification:

```toml
getrandom = { version = "=0.2.17", features = ["js"] }
```

Without it, compilation stopped with `getrandom`'s unsupported
`wasm*-unknown-unknown` diagnostic. With it, both commands completed.
`worker-build` produced an optimized 402,607-byte Wasm module in the isolated
fixture (SHA-256
`DDE6322C6CF8D7AF075319A7F8B6D4DDDE949642E066D09F150D71CC0241781B`).

## Dependency and version observations

- The effective MSRV is Rust 1.88, because `wasm-streams 0.6.0` requires it,
  despite the lower MSRV advertised by `worker` itself.
- The resolved verifier tree used `p256 0.13.2`, `ed25519-dalek 2.2.0`,
  `x509-cert 0.2.5`, and `rand 0.8.8`.
- `cargo tree` contained no `ring`, OpenSSL crate, or `webauthn-rs` crate.

## Confirmed runtime incompatibility in upstream 0.1.3

Compilation did not expose an upstream runtime defect: `passkey-auth` 0.1.3
unconditionally called `std::time::SystemTime::now()` from
`types::now_secs()`. A real workerd request reached that function through
`Webauthn::start_registration` and panicked on `wasm32-unknown-unknown`.

The project therefore consumes the auditable local source at
`crates/vendor/passkey-auth-worker`. The patch selects its clock by target:

| Target | Clock | Behavior |
| --- | --- | --- |
| `wasm32-unknown-unknown` | `js_sys::Date::now()` | Milliseconds are floored to Unix seconds; invalid/pre-epoch values become `0`. |
| all other targets | `std::time::SystemTime` | Upstream implementation is preserved. |

Cloudflare documents JavaScript `Date.now()` as the Workers current-time API
and notes that its value is fixed at the last I/O during a request. That is
compatible with this use: ceremony code takes a timestamp at request handling
boundaries, not for intra-request benchmarking. See
<https://developers.cloudflare.com/workers/runtime-apis/web-standards/>.

The exact upstream delta, provenance, license preservation, and upgrade policy
are recorded in `../vendor/passkey-auth-worker/WORKER-PATCH.md`.

## Verification

| Check | Result |
| --- | --- |
| Vendored native unit + ceremony/attestation tests | 47 passed |
| Vendored standalone `wasm32-unknown-unknown` check | passed |
| Workspace locked Wasm check | passed |
| `worker-build --release` | passed |
| Fresh local D1 + workerd registration start | `201 Created`, non-empty challenge |
| Same workerd instance authentication start | `201 Created`, non-empty challenge |

The workerd smoke used Wrangler 4.131.1 with a newly created isolated local D1,
applied `0001_identity_foundation.sql`, changed the local-only policy to `open`,
then obtained a browser-context cookie/CSRF pair before posting each start
request. The runtime log contained `GET 200`, registration `POST 201`, and
authentication `POST 201`, with no `SystemTime` panic.

These results establish that the clock path runs in the production-equivalent
local runtime, rather than only compiling. Browser virtual-authenticator tests
are still required to establish full ceremony interoperability.
