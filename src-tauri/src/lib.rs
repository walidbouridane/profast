//! ProFast Facture — crate lib Tauri (backend local 100 % hors-ligne).

mod auth;
mod commands;
mod db;
mod fiscal;
mod inventory_core;
pub mod license;
mod pdf;

use commands::Session;
use db::Db;
use tauri::Manager;

const SCHEMA: &str = include_str!("../../db/schema.sql");

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(Session::default())
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::block_on(async move {
                let dir = handle
                    .path()
                    .app_data_dir()
                    .map_err(|e| format!("dossier applicatif introuvable : {e}"))?;
                std::fs::create_dir_all(&dir)
                    .map_err(|e| format!("création du dossier applicatif : {e}"))?;
                let db = Db::open(&dir.join("profast.db"), SCHEMA)
                    .await
                    .map_err(|e| format!("initialisation BDD : {e}"))?;
                handle.manage(db);
                Ok(()) as Result<(), String>
            })?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // licence
            license::commands::license_status,
            license::commands::activate_license,
            license::commands::can_create_invoice,
            license::commands::consume_demo_invoice,
            // session / RBAC
            commands::set_session,
            commands::session_role,
            // auth PIN
            auth_commands_login,
            auth_commands_setup_admin,
            auth_needs_setup,
            // fichiers locaux (PDF / images)
            commands::read_local_image,
            commands::pdf_out_dir,
            commands::warehouses_list,
            // catalogue
            commands::preload_catalog,
            commands::upsert_products,
            commands::create_client,
            // facturation
            commands::next_number,
            commands::save_invoice,
            commands::record_payment,
            // G50
            commands::g50_report,
            commands::g50_save_snapshot,
            // stock
            commands::stock_overview,
            commands::stock_movements,
            commands::stock_move,
            commands::transfer_stock,
            // inventaires
            commands::inventory_start,
            commands::inventory_get,
            commands::inventories_list,
            commands::inventory_validate,
            // achats / fournisseurs / change
            commands::suppliers_list,
            commands::create_supplier,
            commands::fx_recent,
            commands::record_fx_rate,
            commands::record_purchase,
            commands::purchases_list,
            // utilisateurs & PIN
            commands::users_admin_list,
            commands::user_create,
            commands::user_set_active,
            commands::user_set_price_rights,
            commands::change_pin,
            // dashboard
            commands::dashboard_data,
            // PDF local
            pdf::print_pdf,
        ])
        .run(tauri::generate_context!())
        .expect("erreur fatale Tauri");
}

// ----------------------------------------------------------------------------
// Auth (PIN) — commandes
// ----------------------------------------------------------------------------

#[tauri::command]
pub async fn auth_commands_login(
    db: tauri::State<Db>,
    session_state: tauri::State<Session>,
    username: String,
    pin: String,
) -> Result<db::UserSession, String> {
    let session = db.login(&username, &pin).await?;
    *session_state.inner() = Session {
        user_id: session.id,
        role: session.role.clone(),
    };
    Ok(session)
}

#[tauri::command]
pub async fn auth_commands_setup_admin(
    db: tauri::State<Db>,
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
pub async fn auth_needs_setup(db: tauri::State<Db>) -> Result<bool, String> {
    db.needs_setup().await
}
