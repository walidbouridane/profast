// ProFast Facture — point d'entrée (tauri::run est dans le crate lib).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    profast_facture_lib::run()
}
