//! ============================================================================
//!  ProFast Facture — Commandes Tauri du module licence
//!  Gate de démarrage + activation + garde-fou mode Démo (10 factures).
//! ============================================================================

use crate::db::Db;
use crate::license::verify::{self, LicenseStatus, DEMO_INVOICE_LIMIT};
use chrono::Utc;
use tauri::State;

fn status_inactive(hwid: &str, demo_remaining: u32, error: impl Into<String>) -> LicenseStatus {
    LicenseStatus {
        hwid: hwid.to_string(),
        active: false,
        plan: None,
        serial: None,
        expires_at: None,
        demo_remaining,
        error: Some(error.into()),
    }
}

/// Fenêtre de vérification au démarrage.
#[tauri::command]
pub async fn license_status(db: State<Db>) -> LicenseStatus {
    let now = Utc::now().timestamp();
    let hwid = crate::license::hwid::compute_hwid();
    match db.current_license_key().await {
        Ok(Some(key)) => match verify::verify_license(&key, &hwid, now) {
            Ok(lic) => {
                let _ = db.mark_verified().await;
                LicenseStatus {
                    hwid,
                    active: true,
                    plan: Some(match lic.plan {
                        verify::Plan::Annual => "ANNUAL".into(),
                        verify::Plan::Lifetime => "LIFETIME".into(),
                    }),
                    serial: Some(lic.serial),
                    expires_at: lic.expires_at,
                    demo_remaining: u32::MAX,
                    error: None,
                }
            }
            Err(e) => {
                let demo = db.demo_remaining().await.unwrap_or(0);
                status_inactive(&hwid, demo, e.to_string())
            }
        },
        Ok(None) => {
            let _ = db.ensure_demo_license(&hwid).await;
            let demo = db.demo_remaining().await.unwrap_or(DEMO_INVOICE_LIMIT);
            status_inactive(&hwid, demo, "Aucune clé d'activation — mode Démo (10 factures)")
        }
        Err(e) => status_inactive(&hwid, 0, e),
    }
}

/// Activation : vérifie la clé (HWID + signature + dates) PUIS persiste.
#[tauri::command]
pub async fn activate_license(db: State<Db>, key: String) -> Result<LicenseStatus, String> {
    let key = key.trim().to_string();
    let hwid = crate::license::hwid::compute_hwid();
    let now = Utc::now().timestamp();

    let lic = verify::verify_license(&key, &hwid, now).map_err(|e| e.to_string())?;

    db.save_license(
        &hwid,
        &key,
        match lic.plan {
            verify::Plan::Annual => "ANNUAL",
            verify::Plan::Lifetime => "LIFETIME",
        },
        &lic.serial,
        lic.issued_at,
        lic.expires_at,
    )
    .await?;

    Ok(license_status(db).await)
}

/// Garde-fou : autorise-t-on la CRÉATION d'une facture ?
#[tauri::command]
pub async fn can_create_invoice(db: State<Db>) -> Result<CanCreate, String> {
    let status = license_status(db).await;
    if status.active {
        return Ok(CanCreate { ok: true, remaining: u32::MAX });
    }
    let remaining = status.demo_remaining.min(DEMO_INVOICE_LIMIT);
    Ok(CanCreate { ok: remaining > 0, remaining })
}

/// Incrémente le compteur Démo après enregistrement réussi d'une facture.
#[tauri::command]
pub async fn consume_demo_invoice(db: State<Db>) -> Result<(), String> {
    db.bump_demo_used().await
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct CanCreate {
    pub ok: bool,
    /// Factures restantes (u32::MAX si licence active).
    pub remaining: u32,
}
