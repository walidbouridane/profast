//! Vérification du cœur ProFast Facture (licence + fiscal) — mêmes fichiers
//! que src-tauri (inclus par #[path]), sans Tauri.
#![allow(dead_code)]

#[path = "../../../src-tauri/src/license/hwid.rs"]
pub mod hwid;

#[path = "../../../src-tauri/src/license/verify.rs"]
pub mod verify;

#[path = "../../../src-tauri/src/license/keygen.rs"]
pub mod keygen;

#[path = "../../../src-tauri/src/fiscal.rs"]
pub mod fiscal;

#[path = "../../../src-tauri/src/inventory_core.rs"]
pub mod inventory_core;
