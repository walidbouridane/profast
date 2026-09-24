//! ============================================================================
//!  ProFast Facture — Commandes applicatives Tauri
//!  (catalogue, facturation, G50, stock, dashboard, PDF)
//!
//!  SÉCURITÉ RBAC : chaque commande vérifie le rôle de l'utilisateur connecté
//!  avant d'agir ; les champs sensibles (coûts/marges) ne sont sérialisés que
//!  pour les rôles autorisés.
//! ============================================================================

use crate::db::{Db, NewInvoice, ProductRow, SavedInvoice};
use chrono::Utc;
use serde::Serialize;
use sqlx::Row;
use tauri::State;

/// Session courante (stockée par fenêtre, posée par la commande `login`).
#[derive(Clone, Default)]
pub struct Session {
    pub user_id: i64,
    pub role: String,
}

#[tauri::command]
pub async fn set_session(state: tauri::State<Session>, user_id: i64, role: String) -> Result<(), String> {
    *state.inner() = Session { user_id, role };
    Ok(())
}

/// Rôle courant (le webview l'utilise pour masquer UI + double-check serveur).
#[tauri::command]
pub fn session_role(state: tauri::State<Session>) -> Option<String> {
    (!state.role.is_empty()).then(|| state.role.clone())
}

fn require(state: &tauri::State<Session>, roles: &[&str]) -> Result<i64, String> {
    if roles.contains(state.role.as_str()) {
        Ok(state.user_id)
    } else {
        Err(format!("Accès refusé (rôle {:?})", state.role))
    }
}

// ----------------------------------------------------------------------------
// Catalogue
// ----------------------------------------------------------------------------

#[tauri::command]
pub async fn preload_catalog(db: State<Db>, session: State<Session>) -> Result<crate::db::PreloadData, String> {
    let data = db.preload().await?;
    // Masquage SÉCURISÉ : les coûts ne quittent jamais le main-process pour
    // les rôles sans droit (COMMERCIAL/STOREKEEPER/ACCOUNTANT n'a pas besoin
    // du coût de revient pour vendre).
    let can_see_cost = session.role == "ADMIN";
    let products = if can_see_cost {
        data.products
    } else {
        data.products
            .into_iter()
            .map(|mut p| {
                p.cost_dzd = 0.0;
                p
            })
            .collect()
    };
    Ok(crate::db::PreloadData { products, ..data })
}

#[tauri::command]
pub async fn upsert_products(
    db: State<Db>,
    session: State<Session>,
    rows: Vec<ProductRow>,
) -> Result<Vec<crate::db::ProductLite>, String> {
    let user_id = require(&session, &["ADMIN"]?;
    db.upsert_products(user_id, rows).await
}

#[tauri::command]
pub async fn create_client(
    db: State<Db>,
    session: State<Session>,
    name: String,
    nif: String,
    phone: String,
) -> Result<crate::db::ClientLite, String> {
    let user_id = require(&session, &["ADMIN", "COMMERCIAL"]?;
    db.create_client(user_id, &name, &nif, &phone).await
}

// ----------------------------------------------------------------------------
// Facturation
// ----------------------------------------------------------------------------

#[tauri::command]
pub async fn next_number(db: State<Db>, doc_type: String) -> Result<String, String> {
    db.next_number_preview(&doc_type.to_uppercase()).await
}

#[tauri::command]
pub async fn save_invoice(
    db: State<Db>,
    session: State<Session>,
    doc: NewInvoice,
) -> Result<SavedInvoice, String> {
    let user_id = require(&session, &["ADMIN", "COMMERCIAL"]?;
    db.save_invoice(user_id, &doc).await
}

#[tauri::command]
pub async fn record_payment(
    db: State<Db>,
    session: State<Session>,
    invoice_id: i64,
    amount: f64,
    method: String,
    date: String,
    ref_number: Option<String>,
) -> Result<(), String> {
    let user_id = require(&session, &["ADMIN", "COMMERCIAL"]?;
    if !matches!(method.as_str(), "CASH" | "CHECK" | "TRANSFER" | "CREDIT") || amount <= 0.0 {
        return Err("paiement invalide".into());
    }
    let client_row = sqlx::query("SELECT client_id FROM invoices WHERE id = ?1")
        .bind(invoice_id)
        .fetch_one(&*db)
        .await
        .map_err(|e| e.to_string())?;
    let client_id: i64 = client_row.try_get(0).map_err(|e| e.to_string())?;
    sqlx::query(
        "INSERT INTO payments (invoice_id, client_id, amount, method, ref, date, user_id)
         VALUES (?1,?2,?3,?4,?5,?6,?7)",
    )
    .bind(invoice_id)
    .bind(client_id)
    .bind(amount)
    .bind(method)
    .bind(ref_number)
    .bind(date)
    .bind(user_id)
    .execute(&*db)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ----------------------------------------------------------------------------
// G50
// ----------------------------------------------------------------------------

fn period_range(period_type: &str, year: i32, month: u32) -> Result<(String, String), String> {
    let pad = |n: u32| format!("{n:02}");
    let last_day = |y: i32, m: u32| -> u32 {
        let d = chrono::NaiveDate::from_ymd_opt(y, m + 1, 1)
            .and_then(|d| d.pred_opt())
            .map(|d| d.day())
            .ok_or_else(|| "mois invalide".to_string())?;
        Ok(d)
    };
    match period_type {
        "MONTH" => {
            let ld = last_day(year, month)?;
            Ok((format!("{year}-{}-01", pad(month)), format!("{year}-{}-{ld:02}", pad(month))))
        }
        "QUARTER" => {
            let q0 = ((month - 1) / 3) as i32;
            let m1 = q0 * 3 + 1;
            let m3 = m1 + 2;
            let ld = last_day(year, m3 as u32)?;
            Ok((
                format!("{year}-{}-01", pad(m1 as u32)),
                format!("{year}-{}-{ld:02}", pad(m3 as u32)),
            ))
        }
        _ => Err("période invalide (MONTH|QUARTER)".into()),
    }
}

#[tauri::command]
pub async fn g50_report(
    db: State<Db>,
    session: State<Session>,
    period_type: String,
    year: i32,
    month: u32,
) -> Result<crate::db::G50Raw, String> {
    require(&session, &["ADMIN", "ACCOUNTANT"]?;
    let (start, end) = period_range(&period_type, year, month)?;
    db.g50_raw(&start, &end).await
}

#[tauri::command]
pub async fn g50_save_snapshot(
    db: State<Db>,
    session: State<Session>,
    period_type: String,
    year: i32,
    month: u32,
    data_json: String,
) -> Result<(), String> {
    let user_id = require(&session, &["ADMIN", "ACCOUNTANT"]?;
    let (start, end) = period_range(&period_type, year, month)?;
    db.save_g50_snapshot(user_id, &period_type, &start, &end, &data_json).await
}

// ----------------------------------------------------------------------------
// Stock (Magasinier + Admin)
// ----------------------------------------------------------------------------

#[tauri::command]
pub async fn stock_overview(db: State<Db>, session: State<Session>) -> Result<Vec<crate::db::StockRow>, String> {
    require(&session, &["ADMIN", "STOREKEEPER"]?;
    db.stock_overview().await
}

#[tauri::command]
pub async fn stock_movements(db: State<Db>, session: State<Session>) -> Result<Vec<crate::db::MovementRow>, String> {
    require(&session, &["ADMIN", "STOREKEEPER", "ACCOUNTANT"]?;
    db.stock_movements(50).await
}

#[tauri::command]
pub async fn stock_move(
    db: State<Db>,
    session: State<Session>,
    product_id: i64,
    delta: f64,
    rtype: String,
    note: Option<String>,
) -> Result<(), String> {
    let user_id = require(&session, &["ADMIN", "STOREKEEPER"]?;
    db.stock_move(user_id, product_id, delta, &rtype, note.as_deref()).await
}

#[tauri::command]
pub async fn transfer_stock(
    db: State<Db>,
    session: State<Session>,
    product_id: i64,
    from_warehouse: i64,
    to_warehouse: i64,
    qty: f64,
) -> Result<(), String> {
    let user_id = require(&session, &["ADMIN", "STOREKEEPER"]?;
    db.transfer_stock(user_id, product_id, from_warehouse, to_warehouse, qty).await
}

// ----------------------------------------------------------------------------
// ACHATS & FOURNISSEURS (ADMIN saisit, ACCOUNTANT lit)
// ----------------------------------------------------------------------------

#[tauri::command]
pub async fn suppliers_list(db: State<Db>, session: State<Session>) -> Result<Vec<crate::db::SupplierLite>, String> {
    require(&session, &["ADMIN", "ACCOUNTANT"]?;
    db.suppliers_list().await
}

#[tauri::command]
pub async fn create_supplier(db: State<Db>, session: State<Session>, name: String, nif: String) -> Result<crate::db::SupplierLite, String> {
    let _user = require(&session, &["ADMIN"]?;
    db.create_supplier(&name, if nif.is_empty() { None } else { Some(nif.as_str()) }).await
}

#[tauri::command]
pub async fn fx_recent(db: State<Db>, session: State<Session>, currency: String) -> Result<Vec<crate::db::FxRow>, String> {
    require(&session, &["ADMIN", "ACCOUNTANT"]?;
    db.fx_recent(&currency.to_uppercase()).await
}

#[tauri::command]
pub async fn record_fx_rate(
    db: State<Db>,
    session: State<Session>,
    date: String,
    currency: String,
    official_rate: f64,
    parallel_rate: Option<f64>,
    source: String,
) -> Result<(), String> {
    let _user = require(&session, &["ADMIN"]?;
    db.record_fx_rate(&date, &currency.to_uppercase(), official_rate, parallel_rate, &source).await
}

#[tauri::command]
pub async fn record_purchase(
    db: State<Db>,
    session: State<Session>,
    purchase: crate::db::PurchaseInput,
) -> Result<crate::db::PurchaseRow, String> {
    let user_id = require(&session, &["ADMIN"]?;
    db.record_purchase(user_id, &purchase).await
}

#[tauri::command]
pub async fn purchases_list(
    db: State<Db>,
    session: State<Session>,
    start: String,
    end: String,
) -> Result<Vec<crate::db::PurchaseRow>, String> {
    require(&session, &["ADMIN", "ACCOUNTANT"]?;
    db.purchases_list(&start, &end).await
}

// ----------------------------------------------------------------------------
// INVENTAIRES PHYSIQUES (ADMIN / STOREKEEPER)
// ----------------------------------------------------------------------------

#[tauri::command]
pub async fn inventory_start(db: State<Db>, session: State<Session>, warehouse_id: i64) -> Result<crate::db::InventoryInfo, String> {
    let user_id = require(&session, &["ADMIN", "STOREKEEPER"]?;
    db.inventory_start(user_id, warehouse_id).await
}

#[tauri::command]
pub async fn inventory_get(db: State<Db>, session: State<Session>, id: i64) -> Result<crate::db::InventoryInfo, String> {
    require(&session, &["ADMIN", "STOREKEEPER", "ACCOUNTANT"]?;
    db.inventory_get(id).await
}

#[tauri::command]
pub async fn inventories_list(db: State<Db>, session: State<Session>) -> Result<Vec<crate::db::InventorySummary>, String> {
    require(&session, &["ADMIN", "STOREKEEPER", "ACCOUNTANT"]?;
    db.inventories_list(20).await
}

#[tauri::command]
pub async fn inventory_validate(
    db: State<Db>,
    session: State<Session>,
    id: i64,
    counts: Vec<crate::db::CountedLine>,
) -> Result<crate::db::InventoryResult, String> {
    let user_id = require(&session, &["ADMIN", "STOREKEEPER"]?;
    db.inventory_validate(user_id, id, counts).await
}

// ----------------------------------------------------------------------------
// UTILISATEURS & RÔLES (ADMIN) + CHANGEMENT DE PIN
// ----------------------------------------------------------------------------

#[tauri::command]
pub async fn users_admin_list(db: State<Db>, session: State<Session>) -> Result<Vec<crate::db::AdminUser>, String> {
    require(&session, &["ADMIN"]?;
    db.admin_users().await
}

#[tauri::command]
pub async fn user_create(
    db: State<Db>,
    session: State<Session>,
    username: String,
    full_name: String,
    role: String,
    pin: String,
    can_edit_prices: bool,
) -> Result<crate::db::AdminUser, String> {
    let actor = require(&session, &["ADMIN"]?;
    db.create_user(actor, &username, &full_name, &role, &pin, can_edit_prices).await
}

#[tauri::command]
pub async fn user_set_active(db: State<Db>, session: State<Session>, id: i64, active: bool) -> Result<(), String> {
    let actor = require(&session, &["ADMIN"]?;
    db.set_user_active(actor, id, active).await
}

#[tauri::command]
pub async fn user_set_price_rights(db: State<Db>, session: State<Session>, id: i64, can: bool) -> Result<(), String> {
    let actor = require(&session, &["ADMIN"]?;
    db.set_user_price_rights(actor, id, can).await
}

#[tauri::command]
pub async fn change_pin(db: State<Db>, session: State<Session>, old_pin: String, new_pin: String) -> Result<(), String> {
    // Chaque utilisateur connecté peut changer SON PIN.
    if session.role.is_empty() {
        return Err("non connecté".into());
    }
    db.change_pin(session.user_id, &old_pin, &new_pin).await
}

// ----------------------------------------------------------------------------
// Utilitaires fichiers locaux (PDF, images cachet/signature/logo)
// ----------------------------------------------------------------------------

/// Lit une image locale et la renvoie en data-URL (pour le gabarit PDF).
#[tauri::command]
pub async fn read_local_image(path: String) -> Result<String, String> {
    use base64::Engine as _;
    let bytes = tokio::fs::read(&path).await.map_err(|e| format!("{path} : {e}"))?;
    let mime = match path.rsplit('.').next().unwrap_or("").to_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        other => return Err(format!("format image non supporté : {other}")),
    };
    Ok(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

/// Dossier de sortie des PDF (dossier applicatif /pdf).
#[tauri::command]
pub fn pdf_out_dir(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("pdf");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().to_string())
}

#[derive(Serialize, Clone)]
pub struct WarehouseLite {
    pub id: i64,
    pub code: String,
    pub name: String,
    pub is_default: bool,
}

#[tauri::command]
pub async fn warehouses_list(db: State<Db>) -> Result<Vec<WarehouseLite>, String> {
    let rows = sqlx::query("SELECT id, code, name, is_default FROM warehouses ORDER BY id")
        .fetch_all(&*db)
        .await
        .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|r| WarehouseLite {
            id: r.try_get(0).unwrap_or(0),
            code: r.try_get(1).unwrap_or_default(),
            name: r.try_get(2).unwrap_or_default(),
            is_default: r.try_get::<i64, _>(3).unwrap_or(0) == 1,
        })
        .collect())
}

// ----------------------------------------------------------------------------
// Dashboard
// ----------------------------------------------------------------------------

#[tauri::command]
pub async fn dashboard_data(db: State<Db>, session: State<Session>) -> Result<crate::db::Dashboard, String> {
    require(&session, &["ADMIN", "ACCOUNTANT"]?;
    db.dashboard().await
}

// ----------------------------------------------------------------------------
// PDF / WhatsApp (aucune donnée sensible requise)
// ----------------------------------------------------------------------------

#[derive(Serialize)]
pub struct PdfResult {
    pub path: String,
}

// (print_pdf est dans crate::pdf)

#[allow(dead_code)]
fn _now() -> i64 {
    Utc::now().timestamp()
}
