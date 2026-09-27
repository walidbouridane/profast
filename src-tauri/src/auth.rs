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
        Params::new(65536, 3, 4, None).expect("paramètres argon2 valides"),
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

// ----------------------------------------------------------------------------
// Auth (PIN) — commandes Tauri
// (déplacées ici depuis lib.rs : les commandes définies directement à la
//  racine du crate provoquaient un conflit de macro __cmd__ avec Tauri)
// ----------------------------------------------------------------------------

#[tauri::command]
pub async fn auth_commands_login(
    db: tauri::State<'_, crate::db::Db>,
    session_state: tauri::State<'_, std::sync::Mutex<crate::commands::Session>>,
    username: String,
    pin: String,
) -> Result<crate::db::UserSession, String> {
    let session = db.login(&username, &pin).await?;
    *session_state.lock().unwrap() = crate::commands::Session {
        user_id: session.id,
        role: session.role.clone(),
    };
    Ok(session)
}

#[tauri::command]
pub async fn auth_commands_setup_admin(
    db: tauri::State<'_, crate::db::Db>,
    username: String,
    full_name: String,
    pin: String,
) -> Result<(), String> {
    if !db.needs_setup().await? {
        return Err("un administrateur existe déjà".into());
    }
    let username = username.trim().to_string();
    if username.len() < 3 {
        return Err("nom d'utilisateur trop court (3 caractères min)".into());
    }
    if pin.len() < 4 {
        return Err("PIN trop court (4 caractères minimum)".into());
    }
    db.setup_admin(&username, &full_name, &pin).await
}

#[tauri::command]
pub async fn auth_needs_setup(db: tauri::State<'_, crate::db::Db>) -> Result<bool, String> {
    db.needs_setup().await
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
