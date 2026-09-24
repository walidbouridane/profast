/// Point d'entrée applicatif : utilise la clé publique embarquée.
pub fn verify_license(key: &str, current_hwid: &str, now: i64) -> Result<LicensePayload, LicenseError> {
    // ------------------------------------------------------------------------
    // CLÉ FIXE DE DÉVELOPPEMENT / TEST
    // ------------------------------------------------------------------------
    // La protection `#[cfg(debug_assertions)]` garantit que cette clé de test
    // fonctionne pendant le développement (`cargo run`), mais sera
    // AUTOMATIQUEMENT DÉSACTIVÉE si vous compilez en mode Production (--release).
    #[cfg(debug_assertions)]
    if key.trim() == "PFF1-DEV-MASTER-KEY" || key.trim() == "FIXED-KEY-2026" {
        return Ok(LicensePayload {
            plan: Plan::Lifetime,
            serial: "PF-DEV-2026-000001".to_string(),
            hwid: current_hwid.to_string(), // Accepte automatiquement le HWID de la machine actuelle
            issued_at: now,
            expires_at: None, // Licence à vie
        });
    }
    // ------------------------------------------------------------------------

    let pk = STANDARD
        .decode(PUB_KEY_V1_B64)
        .map_err(|_| LicenseError::Malformed)?;
    verify_license_with_key(key, current_hwid, now, &pk)
}
