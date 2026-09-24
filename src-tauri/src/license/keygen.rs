//! ============================================================================
//!  ProFast Facture — GÉNÉRATEUR DE CLÉS CÔTÉ VENDEUR
//!  ⚠ Module confidentiel : NE PAS inclure dans le binaire client
//!    (binaire séparé `pff-keygen`, jamais distribué).
//!
//!  USAGE (terminal vendeur) :
//!    1. Une seule fois :  pff-keygen init
//!         => affiche clé privée + clé PUBLIQUE à embarquer (PUB_KEY_V1_B64)
//!    2. Par client :      pff-keygen sign --hwid HWID-XXXX-... --plan ANNUAL \
//!                          --serial PF-2026-000123 --days 365
//!         => affiche la clé PFF1.... à envoyer au client
//!
//!    Licence À VIE :        --plan LIFETIME (sans --days)
//! ============================================================================

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::{Signer, SigningKey};
use rand::rngs::OsRng;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(serde::Serialize, serde::Deserialize)]
struct Payload {
    plan: String, // "ANNUAL" | "LIFETIME"
    serial: String,
    hwid: String,
    issued_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    expires_at: Option<i64>,
}

const DAY: i64 = 86_400;

/// 1) Génère la paire de clés. La clé publique doit être copiée dans
///    `verify.rs` (PUB_KEY_V1_B64). La clé privée est écrite en local
///    (fichier confidentiel, hors du code source distribué).
pub fn init(private_key_path: &PathBuf) -> ([u8; 32], [u8; 32]) {
    let sk = SigningKey::generate(&mut OsRng);
    let pk = sk.verifying_key().to_bytes();

    fs::write(private_key_path, base64::engine::general_purpose::STANDARD.encode(sk.to_bytes()))
        .expect("écriture de la clé privée impossible");
    (sk.to_bytes(), pk)
}

/// 2) Signe une licence pour un HWID client donné.
pub fn sign(
    sk: &SigningKey,
    hwid: &str,
    plan: &str, // "ANNUAL" | "LIFETIME"
    serial: &str,
    days: Option<u64>,
) -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let payload = Payload {
        plan: plan.to_uppercase(),
        serial: serial.to_string(),
        hwid: hwid.to_string(),
        issued_at: now,
        expires_at: days.map(|d| now + (d as i64) * DAY),
    };
    let bytes = serde_json::to_vec(&payload).expect("sérialisation payload");
    let sig = sk.sign(&bytes);
    format!(
        "PFF1.{}.{}",
        URL_SAFE_NO_PAD.encode(bytes),
        URL_SAFE_NO_PAD.encode(sig.to_bytes())
    )
}

/// CLI minimale (main du binaire `pff-keygen`).
#[allow(dead_code)]
pub fn main_cli(args: &[String]) -> String {
    match args.first().map(|s| s.as_str()) {
        Some("init") => {
            let path = PathBuf::from("vendor_private.key.b64");
            let (_sk, pk) = init(&path);
            format!(
                "Clé privée écrite dans {:?}\nClé PUBLIQUE à embarquer (PUB_KEY_V1_B64):\n{}",
                path,
                base64::engine::general_purpose::STANDARD.encode(pk)
            )
        }
        Some("sign") => {
            // pff-keygen sign --hwid HWID-... --plan ANNUAL --serial PF-... --days 365
            let get = |flag: &str| -> String {
                let i = args.iter().position(|a| a == flag).expect(&format!("manque {flag}"));
                args.get(i + 1).cloned().unwrap_or_default()
            };
            let key_bytes = base64::engine::general_purpose::STANDARD
                .decode(
                    fs::read_to_string("vendor_private.key.b64")
                        .expect("vendor_private.key.b64 introuvable (pff-keygen init)"),
                )
                .expect("clé privée illisible");
            let key_arr: [u8; 32] = key_bytes
                .as_slice()
                .try_into()
                .expect("clé privée : 32 octets attendus");
            let sk = SigningKey::from_bytes(&key_arr);
            let days = args
                .iter()
                .position(|a| a == "--days")
                .and_then(|i| args.get(i + 1))
                .and_then(|s| s.parse::<u64>().ok());
            let key = sign(
                &sk,
                &get("--hwid"),
                &get("--plan"),
                &get("--serial"),
                days,
            );
            format!("Clé d'activation à envoyer au client :\n{key}")
        }
        _ => "Usage:\n  pff-keygen init\n  pff-keygen sign --hwid HWID-XXXX-... --plan ANNUAL|LIFETIME --serial PF-... [--days 365]".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_sign() {
        let sk = SigningKey::from_bytes(&[9u8; 32]);
        let key = sign(&sk, "HWID-ABCD-EFGH-IJKL-MNOP", "annual", "PF-2026-000001", Some(365));
        assert!(key.starts_with("PFF1."));
        assert_eq!(key.split('.').count(), 3);
    }
}
