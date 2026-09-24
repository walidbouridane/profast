//! ============================================================================
//!  ProFast Facture — Authentification PIN (Argon2id) + verrouillage
//!  • Hachage : argon2id (m=64 MiB, t=3, p=4) sur (username || "|" || pin)
//!  • Verrou : 5 échecs => 15 minutes (users.failed_attempts / locked_until)
//! ============================================================================

use argon2::{
    Algorithm, Argon2, PasswordHash, PasswordHasher, PasswordVerifier, Params, Version,
    password_hash::{rand_core::OsRng, SaltString},
};

pub const MAX_ATTEMPTS: i64 = 5;
pub const LOCK_MINUTES: i64 = 15;

fn argon2() -> Argon2<'static> {
    // m = 65536 KiB (64 MiB), t = 3 itérations, p = 4 parallélismes
    Argon2::new(
        Algorithm::Argon2id,
        Version::V0x13,
        Params::new(65536, 3, 4).expect("paramètres argon2 valides"),
    )
}

pub fn hash_pin(pin: &str, username: &str) -> Result<String, String> {
    let salt = SaltString::generate(&mut OsRng);
    let input = format!("{username}|{pin}");
    argon2()
        .hash_password(input.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| e.to_string())
}

pub fn verify_pin(pin: &str, username: &str, hash: &str) -> bool {
    let parsed = match PasswordHash::new(hash) {
        Ok(p) => p,
        Err(_) => return false,
    };
    let input = format!("{username}|{pin}");
    argon2().verify_password(input.as_bytes(), &parsed).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_pin() {
        let h = hash_pin("1234", "admin").unwrap();
        assert!(h.starts_with("$argon2id$"));
        assert!(verify_pin("1234", "admin", &h));
        assert!(!verify_pin("9999", "admin", &h));
        // le PIN est lié au username : même PIN, autre utilisateur => rejet
        assert!(!verify_pin("1234", "commercial", &h));
    }
}
