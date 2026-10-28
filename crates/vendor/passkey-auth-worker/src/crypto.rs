//! Signature verification - the only crypto operation the server
//! performs during the WebAuthn auth ceremony.
//!
//! Algorithms supported (matching `cose::CoseKey`):
//!   * ES256 (P-256 ECDSA over SHA-256), the universal default
//!   * EdDSA (Ed25519), used by some authenticators (e.g. Yubikey 5+)
//!
//! WebAuthn signs `authenticatorData || SHA-256(clientDataJSON)`. The
//! ES256 signature on the wire is **DER-encoded**, not raw r||s - be
//! careful here.

use ed25519_dalek::{Signature as EdSig, Verifier as _, VerifyingKey as EdKey};
use p256::ecdsa::{Signature as EsSig, VerifyingKey as EsKey, signature::Verifier as _};
use p256::elliptic_curve::sec1::FromSec1Point;
use p256::{PublicKey, Sec1Point};

use crate::cose::CoseKey;
use crate::error::{Error, Result};

/// Verify `sig` over `msg` using the COSE public key. Returns `Ok(())`
/// on a valid signature; any failure path (wrong key, malformed sig,
/// algorithm mismatch) collapses to [`Error::BadSignature`] so we
/// don't leak which check failed to the wire.
pub(crate) fn verify(key: &CoseKey, msg: &[u8], sig: &[u8]) -> Result<()> {
    match key {
        CoseKey::Es256 { x, y } => verify_es256(x, y, msg, sig),
        CoseKey::Ed25519 { key } => verify_ed25519(key, msg, sig),
    }
}

fn verify_es256(x: &[u8; 32], y: &[u8; 32], msg: &[u8], sig: &[u8]) -> Result<()> {
    // SEC1 uncompressed point: 0x04 || X || Y.
    let mut sec1 = [0u8; 65];
    sec1[0] = 0x04;
    sec1[1..33].copy_from_slice(x);
    sec1[33..65].copy_from_slice(y);
    let point = Sec1Point::from_bytes(sec1).map_err(|_| Error::BadSignature)?;
    let pk = PublicKey::from_sec1_point(&point);
    let pk = Option::<PublicKey>::from(pk).ok_or(Error::BadSignature)?;
    let vk = EsKey::from(&pk);

    // WebAuthn ES256 signatures are DER-encoded ECDSA. p256 has a
    // direct `from_der` parser.
    //
    // Note on signature malleability (high-S):
    // ECDSA admits two valid signatures (r, s) and (r, n-s) for any
    // message. WebAuthn does NOT require the verifier to reject the
    // high-S form, and major server implementations (webauthn-rs,
    // WebAuthn4J, Yubico java-webauthn-server) accept both. The
    // single-use challenge in our `state` prevents the malleable
    // variant from being useful for replay, so we follow suit and
    // accept either form here.
    let parsed = EsSig::from_der(sig).map_err(|_| Error::BadSignature)?;
    vk.verify(msg, &parsed).map_err(|_| Error::BadSignature)
}

fn verify_ed25519(key: &[u8; 32], msg: &[u8], sig: &[u8]) -> Result<()> {
    let vk = EdKey::from_bytes(key).map_err(|_| Error::BadSignature)?;
    if sig.len() != 64 {
        return Err(Error::BadSignature);
    }
    let mut sb = [0u8; 64];
    sb.copy_from_slice(sig);
    let parsed = EdSig::from_bytes(&sb);
    vk.verify(msg, &parsed).map_err(|_| Error::BadSignature)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer as _, SigningKey};
    use p256::ecdsa::{SigningKey as EsSigningKey, signature::Signer as _};
    use p256::elliptic_curve::Generate;
    use rand::RngCore;

    #[test]
    fn ed25519_round_trip() {
        let mut seed = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut seed);
        let sk = SigningKey::from_bytes(&seed);
        let vk_bytes = sk.verifying_key().to_bytes();
        let msg = b"hello passkey world";
        let sig: EdSig = sk.sign(msg);
        let key = CoseKey::Ed25519 { key: vk_bytes };
        verify(&key, msg, &sig.to_bytes()).expect("good sig must verify");

        // Tamper → rejected.
        let mut bad = sig.to_bytes();
        bad[0] ^= 0x01;
        assert!(verify(&key, msg, &bad).is_err());
    }

    #[test]
    fn historical_es256_der_accepts_high_and_low_s() {
        // RFC 6979 A.2.5, P-256/SHA-256 signature of "sample". These fixed public
        // bytes predate this dependency upgrade; no new signer can mask wire drift.
        let x: [u8; 32] =
            hex::decode("60fed4ba255a9d31c961eb74c6356d68c049b8923b61fa6ce669622e60f29fb6")
                .unwrap()
                .try_into()
                .unwrap();
        let y: [u8; 32] =
            hex::decode("7903fe1008b8bc99a41ae9e95628bc64f2f1b20c2d7e9f5177a3c294d4462299")
                .unwrap()
                .try_into()
                .unwrap();
        let key = CoseKey::Es256 { x, y };
        let high_s = hex::decode("3046022100efd48b2aacb6a8fd1140dd9cd45e81d69d2c877b56aaf991c34d0ea84eaf3716022100f7cb1c942d657c41d436c7a1b6e29f65f3e900dbb9aff4064dc4ab2f843acda8").unwrap();
        let low_s = hex::decode("3045022100efd48b2aacb6a8fd1140dd9cd45e81d69d2c877b56aaf991c34d0ea84eaf371602200834e36ad29a83bf2bc9385e491d6099c8fdf9d1ed67aa7ea5f51f93782857a9").unwrap();
        verify(&key, b"sample", &high_s).expect("existing high-S DER remains accepted");
        verify(&key, b"sample", &low_s).expect("equivalent low-S DER remains accepted");
        assert!(verify(&key, b"tampered", &high_s).is_err());
        assert!(verify(&key, b"tampered", &low_s).is_err());
        let mut malformed = low_s;
        malformed[0] = 0x31;
        assert!(verify(&key, b"sample", &malformed).is_err());
    }

    #[test]
    fn es256_round_trip() {
        let sk = EsSigningKey::generate();
        let vk = sk.verifying_key();
        let pt = vk.to_sec1_point(false);
        let xs = pt.x().expect("x coord");
        let ys = pt.y().expect("y coord");
        let mut x = [0u8; 32];
        let mut y = [0u8; 32];
        // GenericArray derefs to &[u8] - avoid the deprecated as_slice().
        x.copy_from_slice(&xs[..]);
        y.copy_from_slice(&ys[..]);

        let msg = b"hello passkey world";
        let sig: EsSig = sk.sign(msg);
        let der = sig.to_der().to_bytes().to_vec();

        let key = CoseKey::Es256 { x, y };
        verify(&key, msg, &der).expect("good sig must verify");

        // Tamper → rejected.
        let mut bad = der.clone();
        let n = bad.len();
        bad[n - 1] ^= 0x01;
        assert!(verify(&key, msg, &bad).is_err());
    }
}
