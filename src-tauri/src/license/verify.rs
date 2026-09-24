//! ============================================================================
//!  ProFast Facture — VÉRIFICATION DE LICENCE (signature Ed25519) + MODE DÉMO
//!
//!  FORMAT DE CLÉ (une seule ligne, copier-coller) :
//!      PFF1.<base64url(payload JSON)>.<base64url(signature Ed25519)>
//!
//!  PAYLOAD JSON :
//!      { "plan": "ANNUAL" | "LIFETIME",
//!        "serial": "PF-2026-000123",
//!        "hwid":   "HWID-XXXX-XXXX-XXXX-XXXX",
//!        "issued_at": 1758000000,
//!        "expires_at": 1789000000 | null }      // null => licence À VIE
//!
//!  SÉCURITÉ :
//!   • La clé est SIGNÉE par la clé privée du vendeur (jamais embarquée).
//!     On embarque uniquement la clé PUBLIQUE => impossible de forger une
//!     clé valide, de réutiliser la clé d'un autre client, ou de modifier
//!     expires_at sans casser la signature.
//!   • Le HWID est DANS le payload => la clé est liée à la machine
//!     (anti-clonage multi-PC, anti-revente).
//!   • Grâce de 7 jours après expiration, puis bascule en mode Démo.
//!   • Mode Démo : 10 factures maximum, compteur persistant (licenses.demo_used).
//! ============================================================================

use base64::Engine as _;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::Deserialize;
use std::time::Duration;

/// Délai de grâce après expiration avant bascule en mode Démo.
pub const GRACE_PERIOD: Duration = Duration::from_secs(7 * 24 * 3600);
/// Plafond de factures en mode Démo.
pub const DEMO_INVOICE_LIMIT: u32 = 10;

/// Clé publique EMBARQUÉE (base64 standard). À remplacer par la vraie clé
/// publique du vendeur (générée par `keygen.rs`). En production : obfusquée.
const PUB_KEY_V1_B64: &str = "REPLACE_WITH_VENDOR_PUBLIC_KEY_BASE64";

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Plan {
    Annual,
    Lifetime,
}

impl<'de> Deserialize<'de> for Plan {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        match s.as_str() {
            "ANNUAL" => Ok(Plan::Annual),
            "LIFETIME" => Ok(Plan::Lifetime),
            _ => Err(serde::de::Error::custom(format!("plan inconnu: {s}"))),
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct LicensePayload {
    pub plan: Plan,
    pub serial: String,
    pub hwid: String,
    pub issued_at: i64,
    #[serde(default)]
    pub expires_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum LicenseError {
    Malformed,
    BadSignature,
    HwidMismatch { expected: String, actual: String },
    Expired,
}

impl std::fmt::Display for LicenseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LicenseError::Malformed => write!(f, "Clé d'activation malformée"),
            LicenseError::BadSignature => write!(f, "Signature de licence invalide"),
            LicenseError::HwidMismatch { expected, actual } => write!(
                f,
                "Licence liée à une autre machine (attendu {expected}, machine {actual})"
            ),
            LicenseError::Expired => write!(f, "Licence expirée"),
        }
    }
}

// ----------------------------------------------------------------------------
// Vérification
// ----------------------------------------------------------------------------

/// Vérification complète avec une clé publique explicite (testable).
pub fn verify_license_with_key(
    key: &str,
    current_hwid: &str,
    now: i64,
    pub_key: &[u8],
) -> Result<LicensePayload, LicenseError> {
    // 1. Format : PFF1.<payload b64url>.<signature b64url>
    let parts: Vec<&str> = key.split('.').collect();
    if parts.len() != 3 || parts[0] != "PFF1" {
        return Err(LicenseError::Malformed);
    }
    let payload_bytes = URL_SAFE_NO_PAD
        .decode(parts[1])
        .map_err(|_| LicenseError::Malformed)?;
    let sig_bytes = URL_SAFE_NO_PAD
        .decode(parts[2])
        .map_err(|_| LicenseError::Malformed)?;

    // 2. Clé publique
    let pk: [u8; 32] = pub_key
        .try_into()
        .map_err(|_| LicenseError::BadSignature)?;
    let vk = VerifyingKey::from_bytes(&pk).map_err(|_| LicenseError::BadSignature)?;

    // 3. Signature : garantit intégrité du payload (hwid, plan, dates)
    let sig = Signature::from_slice(&sig_bytes).map_err(|_| LicenseError::BadSignature)?;
    vk.verify(&payload_bytes, &sig)
        .map_err(|_| LicenseError::BadSignature)?;

    // 4. Décodage du payload
    let lic: LicensePayload =
        serde_json::from_slice(&payload_bytes).map_err(|_| LicenseError::Malformed)?;

    // 5. Vérification de la machine (HWID)
    if !lic.hwid.eq_ignore_ascii_case(current_hwid) {
        return Err(LicenseError::HwidMismatch {
            expected: lic.hwid.clone(),
            actual: current_hwid.to_string(),
        });
    }

    // 6. Date d'expiration (+ grâce 7 jours)
    if let Some(exp) = lic.expires_at {
        if now > exp + GRACE_PERIOD.as_secs() as i64 {
            return Err(LicenseError::Expired);
        }
    }

    Ok(lic)
}

/// Point d'entrée applicatif : utilise la clé publique embarquée.
pub fn verify_license(key: &str, current_hwid: &str, now: i64) -> Result<LicensePayload, LicenseError> {
    let pk = STANDARD
        .decode(PUB_KEY_V1_B64)
        .map_err(|_| LicenseError::Malformed)?;
    verify_license_with_key(key, current_hwid, now, &pk)
}

// ----------------------------------------------------------------------------
// Statut complet pour l'UI (commande Tauri)
// ----------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize)]
pub struct LicenseStatus {
    pub hwid: String,
    pub active: bool,
    pub plan: Option<String>,
    pub serial: Option<String>,
    pub expires_at: Option<i64>,
    /// Factures restantes en mode Démo (u32::MAX si licence active).
    pub demo_remaining: u32,
    pub error: Option<String>,
}

/// Abstraction persistance (implémentée par sqlx/rusqlite sur `licenses`).
pub trait LicenseStore {
    fn current_license_key(&self) -> Result<Option<String>, String>;
    fn demo_remaining(&self) -> u32;
    fn mark_verified(&self);
}

/// Boucle de démarrage : HWID machine + clé stockée => statut pour l'UI.
///  - OK                => accès complet
///  - Erreur / absence  => MODE DÉMO (compteur <= 10 factures)
pub fn evaluate(db: &dyn LicenseStore, now: i64) -> LicenseStatus {
    let hwid = super::hwid::compute_hwid();
    match db.current_license_key() {
        Ok(Some(key)) => match verify_license(&key, &hwid, now) {
            Ok(lic) => {
                db.mark_verified();
                LicenseStatus {
                    hwid,
                    active: true,
                    plan: Some(match lic.plan {
                        Plan::Annual => "ANNUAL".into(),
                        Plan::Lifetime => "LIFETIME".into(),
                    }),
                    serial: Some(lic.serial),
                    expires_at: lic.expires_at,
                    demo_remaining: u32::MAX,
                    error: None,
                }
            }
            Err(e) => LicenseStatus {
                hwid,
                active: false,
                plan: None,
                serial: None,
                expires_at: None,
                demo_remaining: db.demo_remaining(),
                error: Some(e.to_string()),
            },
        },
        Ok(None) => LicenseStatus {
            hwid,
            active: false,
            plan: None,
            serial: None,
            expires_at: None,
            demo_remaining: db.demo_remaining(),
            error: Some("Aucune clé d'activation — mode Démo (10 factures)".into()),
        },
        Err(e) => LicenseStatus {
            hwid,
            active: false,
            plan: None,
            serial: None,
            expires_at: None,
            demo_remaining: db.demo_remaining(),
            error: Some(e),
        },
    }
}

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::Signer;

    struct Vendor {
        sk: ed25519_dalek::SigningKey,
    }

    impl Vendor {
        fn new(seed: [u8; 32]) -> Self {
            Vendor {
                sk: ed25519_dalek::SigningKey::from_bytes(&seed),
            }
        }
        fn pub_key(&self) -> [u8; 32] {
            self.sk.verifying_key().to_bytes()
        }
        fn sign(&self, hwid: &str, plan: &str, issued: i64, expires: Option<i64>) -> String {
            let payload = serde_json::json!({
                "plan": plan,
                "serial": "PF-2026-000001",
                "hwid": hwid,
                "issued_at": issued,
                "expires_at": expires,
            })
            .to_string();
            let sig = self.sk.sign(payload.as_bytes());
            format!(
                "PFF1.{}.{}",
                URL_SAFE_NO_PAD.encode(payload.as_bytes()),
                URL_SAFE_NO_PAD.encode(sig.to_bytes())
            )
        }
    }

    const HWID: &str = "HWID-ABCD-EFGH-IJKL-MNOP";
    const NOW: i64 = 1_758_000_000;
    const DAY: i64 = 86_400;

    #[test]
    fn annuelle_valide() {
        let v = Vendor::new([1u8; 32]);
        let key = v.sign(HWID, "ANNUAL", NOW - DAY, Some(NOW + 365 * DAY));
        let lic = verify_license_with_key(key.as_str(), HWID, NOW, &v.pub_key()).unwrap();
        assert_eq!(lic.plan, Plan::Annual);
        assert_eq!(lic.serial, "PF-2026-000001");
    }

    #[test]
    fn a_vie_valide() {
        let v = Vendor::new([2u8; 32]);
        let key = v.sign(HWID, "LIFETIME", NOW - DAY, None);
        assert!(verify_license_with_key(&key, HWID, NOW, &v.pub_key()).is_ok());
    }

    #[test]
    fn mauvaise_machine_rejetee() {
        let v = Vendor::new([3u8; 32]);
        let key = v.sign(HWID, "ANNUAL", NOW, Some(NOW + 365 * DAY));
        let err = verify_license_with_key(&key, "HWID-0000-0000-0000-0000", NOW, &v.pub_key())
            .unwrap_err();
        assert!(matches!(err, LicenseError::HwidMismatch { .. }));
    }

    #[test]
    fn expiree_apres_grace() {
        let v = Vendor::new([4u8; 32]);
        let key = v.sign(HWID, "ANNUAL", NOW - 400 * DAY, Some(NOW - 8 * DAY));
        assert!(matches!(
            verify_license_with_key(&key, HWID, NOW, &v.pub_key()).unwrap_err(),
            LicenseError::Expired
        ));
    }

    #[test]
    fn dans_grace_acceptee() {
        let v = Vendor::new([5u8; 32]);
        let key = v.sign(HWID, "ANNUAL", NOW - 400 * DAY, Some(NOW - 2 * DAY));
        assert!(verify_license_with_key(&key, HWID, NOW, &v.pub_key()).is_ok());
    }

    #[test]
    fn payload_tampon_rejete() {
        let v = Vendor::new([6u8; 32]);
        let key = v.sign(HWID, "ANNUAL", NOW, Some(NOW + 365 * DAY));
        // On modifie un byte du payload (ex. expires_at) sans re-signer.
        let mut parts: Vec<String> = key.split('.').map(|s| s.to_string()).collect();
        let mut payload = URL_SAFE_NO_PAD.decode(&parts[1]).unwrap();
        *payload.last_mut().unwrap() ^= 0xFF;
        parts[1] = URL_SAFE_NO_PAD.encode(&payload);
        let forged = parts.join(".");
        let err =
            verify_license_with_key(&forged, HWID, NOW, &v.pub_key()).unwrap_err();
        assert!(matches!(err, LicenseError::BadSignature));
    }

    #[test]
    fn cle_malformee_rejetee() {
        let v = Vendor::new([7u8; 32]);
        assert!(matches!(
            verify_license_with_key("XXXX.pas.bon", HWID, NOW, &v.pub_key()),
            Err(LicenseError::Malformed)
        ));
    }
}
