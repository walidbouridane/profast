//! ============================================================================
//!  ProFast Facture — MOTEUR PDF LOCAL (génération HTML → PDF instantanée)
//!
//!  Stratégie (100 % hors-ligne, aucun CDN) :
//!   • Chromium/Chrome portable BUNDLÉ avec l'installateur (ou système si
//!     présent) lancé en mode headless :
//!         chrome --headless=new --no-sandbox --disable-gpu
//!                --no-pdf-header-footer --print-to-pdf=out.pdf file.html
//!     => rendu pixel-perfect du gabarit React/Tailwind : cachet PNG,
//!        signature, QR code (images locales base64), polices système.
//!   • Alternative zéro-dépendance : crate `printpdf` (layout vectoriel,
//!     texte + images PNG) si l'on veut un .exe plus léger.
//!
//!  Le HTML du gabarit est produit par le webview (template React) avec :
//!   - NIF / NIS / RC de la société + logo + cachet + signature (base64 PNG)
//!   - QR code dynamique : PROFAST|N°|date|NIF|client|montant TTC
//!   - Timbre fiscal mentionné selon le mode de paiement
//! ============================================================================

use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// Trouve l'exécutable Chromium : bundle local d'abord, puis système.
fn find_chrome(app: &AppHandle) -> Result<PathBuf, String> {
    // 1) ./chromium/chrome.exe (émbarqué dans le resource dir de l'app)
    let res = app
        .path()
        .resolve("resources", tauri::path::BaseDirectory::Resource)
        .map_err(|e| e.to_string())?;
    let bundled = res.join("chromium").join(
        if cfg!(windows) { "chrome.exe" } else { "chrome" },
    );
    if bundled.exists() {
        return Ok(bundled);
    }
    // 2) Emplacements système courants (Windows / Linux / macOS)
    let candidates = [
        Path::new(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
        Path::new(r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"),
        Path::new("/usr/bin/google-chrome"),
        Path::new("/usr/bin/chromium"),
        Path::new("/usr/bin/chromium-browser"),
        Path::new("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    ];
    for c in candidates {
        if c.exists() {
            return Ok(c.to_path_buf());
        }
    }
    Err(
        "Aucun moteur PDF trouvé : installez Google Chrome ou placez un Chromium \
         portable dans resources/chromium/"
            .into(),
    )
}

/// Génère le PDF d'un document à partir du HTML du gabarit (local).
#[tauri::command]
pub async fn print_pdf(app: AppHandle, html: String, out_path: String) -> Result<String, String> {
    let chrome = find_chrome(&app)?;

    // Écrit le gabarit dans le temp (chemin court, ASCII pour Windows).
    let tmp = app
        .path()
        .resolve("print_tmp.html", tauri::path::BaseDirectory::Temp)
        .map_err(|e| e.to_string())?;
    tokio::fs::write(&tmp, html)
        .await
        .map_err(|e| e.to_string())?;

    let html_arg = tmp.to_string_lossy().to_string();
    let out = tokio::fs::create_dir_all(
        Path::new(&out_path)
            .parent()
            .unwrap_or_else(|| Path::new(".")),
    )
    .await;
    if let Err(e) = out {
        return Err(e.to_string());
    }

    let res = tokio::time::timeout(
        Duration::from_secs(15),
        tokio::process::Command::new(&chrome)
            .args([
                "--headless=new",
                "--no-sandbox",
                "--disable-gpu",
                "--disable-extensions",
                "--no-pdf-header-footer",
                "--print-to-pdf-no-header",
                &format!("--print-to-pdf={out_path}"),
                &html_arg,
            ])
            .output(),
    )
    .await
    .map_err(|_| "Le moteur PDF a dépassé 15 s (chromium planté ?)".to_string())?
    .map_err(|e| e.to_string())?;

    if !res.status.success() {
        let err = String::from_utf8_lossy(&res.stderr);
        return Err(format!("Échec génération PDF : {err}"));
    }
    let _ = tokio::fs::remove_file(&tmp).await;
    Ok(out_path)
}
