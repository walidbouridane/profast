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
use std::sync::Mutex;
use tauri::Manager;

const SCHEMA: &str = include_str!("../../db/schema.sql");

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(Mutex::new(Session::default()))
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
            auth::auth_commands_login,
            auth::auth_commands_setup_admin,
            auth::auth_needs_setup,
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

