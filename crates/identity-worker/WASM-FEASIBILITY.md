# WebAuthn / Workers Wasm feasibility spike

Date: 2026-09-13

## Question

Can `passkey-auth = 0.1.3` and `worker = 0.8.5` coexist in a pure-Rust
Cloudflare Worker targeting `wasm32-unknown-unknown`, without OpenSSL,
`ring`, or `webauthn-rs`?

## Reproduction

The isolated spike used Rust 1.88.0, `worker-build = 0.8.5`, and a handler
which called `Webauthn::start_authentication(&[])` and type-checked D1 and R2
binding access.

```powershell
cargo +1.88.0 check --target wasm32-unknown-unknown --locked
$env:RUSTUP_TOOLCHAIN = "1.88.0"
worker-build --release
```

The dependency required explicit WebAssembly feature unification:

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

## Provisional conclusion

The combination is **compile- and bundle-feasible**, so the backend enables
Passkey registration and authentication rather than weakening verification or
installing an unavailable fallback. This spike does not prove browser/runtime
interoperability. Production promotion still requires a real Worker runtime
test and browser virtual-authenticator ceremony tests.
