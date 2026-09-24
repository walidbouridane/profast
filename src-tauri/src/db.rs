//! ============================================================================
//!  ProFast Facture — Couche persistance SQLite (sqlx)
//!  • Ouverture WAL + clés étrangères
//!  • Script de schéma (db/schema.sql) exécuté au démarrage (idempotent)
//!  • Licence (store), auth, catalogue pré-chargé, facture ATOMIQUE, G50,
//!    stock, dashboard
//! ============================================================================

use crate::auth;
use crate::fiscal;
use serde::{Deserialize, Serialize};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions};
use sqlx::{Row, SqliteRow};
use std::ops::Deref;
use std::path::Path;
use std::time::Duration;

pub struct Db {
    pool: SqlitePool,
}

impl Deref for Db {
    type Target = SqlitePool;
    fn deref(&self) -> &Self::Target {
        &self.pool
    }
}

impl Db {
    pub async fn open(path: &Path, schema: &str) -> Result<Self, String> {
        let opts = SqliteConnectOptions::from_str(&format!("sqlite:{}", path.display()))
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .foreign_keys(true)
            .busy_timeout(Duration::from_secs(5));
        let pool = SqlitePoolOptions::new()
            .max_connections(1) // 1 writer local => jamais de SQLITE_BUSY
            .connect_with(opts)
            .await
            .map_err(|e| format!("ouverture de la BDD impossible : {e}"))?;

        for stmt in split_sql_script(schema) {
            sqlx::query(&stmt)
                .execute(&pool)
                .await
                .map_err(|e| format!("schéma SQL invalide : {e}"))?;
        }
        Ok(Db { pool })
    }
}

/// Découpe un script SQL en énoncés exécutables, en respectant les blocs
/// BEGIN…END des TRIGGERS (qui contiennent des point-virgules internes).
pub fn split_sql_script(script: &str) -> Vec<String> {
    let mut stmts: Vec<String> = Vec::new();
    let mut buf: Vec<String> = Vec::new();
    let mut in_trigger = false;

    for line in script.lines() {
        let trimmed = line.trim();
        let upper = trimmed.to_uppercase();

        if in_trigger {
            buf.push(line.to_string());
            if upper == "END;" || upper.starts_with("END;") {
                let s = buf.join("\n").trim().to_string();
                if !s.is_empty() {
                    stmts.push(s);
                }
                buf.clear();
                in_trigger = false;
            }
            continue;
        }
        if upper.starts_with("CREATE TRIGGER") || upper.starts_with("CREATE UNIQUE TRIGGER") {
            in_trigger = true;
            buf.push(line.to_string());
            continue;
        }
        if trimmed.is_empty() || trimmed.starts_with("--") {
            continue;
        }
        buf.push(line.to_string());
        if trimmed.ends_with(';') {
            let s = buf.join("\n").trim().to_string();
            if !s.is_empty() {
                stmts.push(s);
            }
            buf.clear();
        }
    }
    let rest = buf.join("\n").trim().to_string();
    if !rest.is_empty() {
        stmts.push(rest);
    }
    stmts
}

// ----------------------------------------------------------------------------
// Types sérialisés vers le webview
// ----------------------------------------------------------------------------

#[derive(Serialize, Clone)]
pub struct UserLite {
    pub id: i64,
    pub username: String,
    pub full_name: String,
    pub role: String,
}

#[derive(Serialize, Clone)]
pub struct UserSession {
    pub id: i64,
    pub full_name: String,
    pub role: String,
    pub can_edit_prices: bool,
    pub must_change_pin: bool,
}

#[derive(Serialize, Clone)]
pub struct ClientLite {
    pub id: i64,
    pub name: String,
    pub nif: String,
    pub phone: String,
}

#[derive(Serialize, Clone)]
pub struct ProductLite {
    pub id: i64,
    pub sku: String,
    pub barcode: Option<String>,
    pub name: String,
    pub unit: String,
    pub kind: String,
    pub sale_price_ht: f64,
    pub tva_rate: f64,
    pub cost_dzd: f64,
    pub stock: f64,
}

#[derive(Serialize, Clone)]
pub struct CompanyConfig {
    pub company_name: String,
    pub legal_form: Option<String>,
    pub nif: Option<String>,
    pub nis: Option<String>,
    pub rc: Option<String>,
    pub ai: Option<String>,
    pub address: Option<String>,
    pub wilaya: Option<String>,
    pub phone: Option<String>,
    pub email: Option<String>,
    pub iban: Option<String>,
    pub bank_name: Option<String>,
    pub timbre_rate: f64,
    pub timbre_min: f64,
    pub timbre_max: f64,
    pub timbre_receipt_min: f64,
    pub stamp_png_path: Option<String>,
    pub signature_png_path: Option<String>,
    pub logo_png_path: Option<String>,
    pub whatsapp_footer: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct PreloadData {
    pub clients: Vec<ClientLite>,
    pub products: Vec<ProductLite>,
    pub users: Vec<UserLite>,
    pub config: CompanyConfig,
}

/// Ligne importée du catalogue (CSV / XLSX) — miroir de CatalogRow (TS).
#[derive(Deserialize, Clone, Debug)]
pub struct ProductRow {
    pub sku: String,
    #[serde(default)]
    pub barcode: Option<String>,
    pub name: String,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default = "default_unit")]
    pub unit: String,
    #[serde(default = "default_product")]
    pub kind: String,
    #[serde(default)]
    pub purchase_price_ht: Option<f64>,
    #[serde(default = "default_dzd")]
    pub purchase_currency: String,
    #[serde(default = "default_one")]
    pub fx_rate: f64,
    #[serde(default)]
    pub extra_costs_dzd: f64,
    #[serde(default)]
    pub cost_dzd: f64,
    #[serde(default)]
    pub sale_price_ht: f64,
    #[serde(default = "default_tva19")]
    pub tva_rate: f64,
    #[serde(default)]
    pub min_stock: f64,
}

fn default_unit() -> String {
    "U".into()
}
fn default_product() -> String {
    "PRODUCT".into()
}
fn default_dzd() -> String {
    "DZD".into()
}
fn default_one() -> f64 {
    1.0
}
fn default_tva19() -> f64 {
    0.19
}

/// Ligne de document envoyée par le webview (miroir de InvoiceItemPayload).
#[derive(Deserialize, Clone, Debug)]
pub struct NewInvoiceItem {
    pub product_id: Option<i64>,
    pub name: String,
    pub qty: f64,
    #[serde(default = "default_unit")]
    pub unit: String,
    pub unit_price_ht: f64,
    #[serde(default)]
    pub discount_rate: f64,
    pub tva_rate: f64,
}

/// Document complet (miroir de NewInvoice TS).
#[derive(Deserialize, Clone, Debug)]
pub struct NewInvoice {
    pub doc_type: String,
    pub client_id: i64,
    pub date: String,
    pub payment_method: String,
    #[serde(default = "default_dzd")]
    pub currency: String,
    #[serde(default = "default_one")]
    pub fx_rate: f64,
    #[serde(default)]
    pub notes: Option<String>,
    pub items: Vec<NewInvoiceItem>,
}

#[derive(Serialize, Clone)]
pub struct SavedInvoice {
    pub id: i64,
    pub number: String,
    pub totals: fiscal::Totals,
    /// u32::MAX si licence active (sinon : factures Démo restantes).
    pub demo_remaining: u32,
}

#[derive(Serialize, Clone)]
pub struct RateAgg {
    pub rate: f64,
    pub base: f64,
    pub tva: f64,
}

/// Données brutes du pré-état G50 (l'agrégation fine se fait côté TS/RS).
#[derive(Serialize, Clone)]
pub struct G50Raw {
    pub period_start: String,
    pub period_end: String,
    pub sales: Vec<RateAgg>,
    pub purchases: Vec<RateAgg>,
    pub purchases_non_deductible: Vec<RateAgg>,
}

#[derive(Serialize, Clone)]
pub struct DashboardLastDoc {
    pub number: String,
    pub doc_type: String,
    pub client: String,
    pub date: String,
    pub total_ttc: f64,
    pub status: String,
}

#[derive(Serialize, Clone)]
pub struct DashboardTopProduct {
    pub name: String,
    pub qty: f64,
    pub revenue: f64,
}

#[derive(Serialize, Clone)]
pub struct Dashboard {
    pub ca_month: f64,
    pub tva_month: f64,
    pub unpaid: f64,
    pub low_stock: i64,
    pub last_docs: Vec<DashboardLastDoc>,
    pub top_products: Vec<DashboardTopProduct>,
}

#[derive(Serialize, Clone)]
pub struct StockRow {
    pub product_id: i64,
    pub sku: String,
    pub name: String,
    pub unit: String,
    pub qty: f64,
    pub min_stock: f64,
    pub cost_dzd: f64,
}

#[derive(Serialize, Clone)]
pub struct MovementRow {
    pub id: i64,
    pub date: String,
    pub product: String,
    pub kind: String,
    pub qty: f64,
    pub warehouse: String,
    pub ref_number: Option<String>,
    pub user: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct SupplierLite {
    pub id: i64,
    pub code: String,
    pub name: String,
    pub nif: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct FxRow {
    pub id: i64,
    pub date: String,
    pub currency: String,
    pub official_rate: f64,
    pub parallel_rate: Option<f64>,
}

/// Achat entrant (miroir de PurchaseInput TS).
#[derive(Deserialize, Clone, Debug)]
pub struct PurchaseInput {
    pub supplier_id: i64,
    pub product_id: Option<i64>,
    pub doc_number: Option<String>,
    pub date: String,
    pub qty: f64,
    pub unit_price_ht: f64,
    pub tva_rate: f64,
    #[serde(default = "default_dzd")]
    pub currency: String,
    #[serde(default = "default_one")]
    pub fx_rate: f64,
    #[serde(default = "default_true")]
    pub deductible: bool,
    #[serde(default)]
    pub extra_costs_dzd: f64,
    #[serde(default)]
    pub note: Option<String>,
}

fn default_true() -> bool {
    true
}

#[derive(Serialize, Clone)]
pub struct PurchaseRow {
    pub id: i64,
    pub supplier: String,
    pub product: Option<String>,
    pub doc_number: Option<String>,
    pub date: String,
    pub qty: f64,
    pub unit_price_ht: f64,
    pub base_ht: f64,
    pub tva_rate: f64,
    pub tva: f64,
    pub ttc: f64,
    pub currency: String,
    pub fx_rate: f64,
    pub deductible: bool,
    pub extra_costs_dzd: f64,
    pub landed_cost_dzd: f64,
}

#[derive(Serialize, Clone)]
pub struct InventoryLineRow {
    pub id: i64,
    pub product_id: i64,
    pub sku: String,
    pub name: String,
    pub unit: String,
    pub qty_book: f64,
    pub qty_counted: f64,
}

#[derive(Serialize, Clone)]
pub struct InventoryInfo {
    pub id: i64,
    pub warehouse_id: i64,
    pub status: String,
    pub date: String,
    pub created_at: String,
    pub validated_at: Option<String>,
    pub lines: Vec<InventoryLineRow>,
}

#[derive(Serialize, Clone)]
pub struct InventorySummary {
    pub id: i64,
    pub warehouse: String,
    pub status: String,
    pub date: String,
    pub line_count: i64,
    pub validated_at: Option<String>,
}

/// Quantité comptée envoyée par le webview à la validation (miroir TS).
#[derive(Deserialize, Clone, Debug)]
pub struct CountedLine {
    pub product_id: i64,
    pub qty: f64,
}

#[derive(Serialize, Clone)]
pub struct InventoryResult {
    pub id: i64,
    pub adjustments: Vec<crate::inventory_core::Adjustment>,
    pub book_value: f64,
    pub counted_value: f64,
    pub variance_pct: f64,
}

#[derive(Serialize, Clone)]
pub struct AdminUser {
    pub id: i64,
    pub username: String,
    pub full_name: String,
    pub role: String,
    pub can_edit_prices: bool,
    pub is_active: bool,
}

// ----------------------------------------------------------------------------
// LICENCE — persistance (store) + compteur Démo
// ----------------------------------------------------------------------------

impl Db {
    /// Dernière clé stockée (hors Démo). None => jamais activé.
    pub async fn current_license_key(&self) -> Result<Option<String>, String> {
        let row = sqlx::query(
            r#"SELECT license_key FROM licenses
               WHERE status IN ('ACTIVE','EXPIRED','REVOKED')
               ORDER BY id DESC LIMIT 1"#,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| e.to_string())?;
        row.map(|r| r.try_get(0).map_err(|e| e.to_string())).transpose()
    }

    /// Factures Démo restantes (plafond 10) pour cette machine.
    pub async fn demo_remaining(&self) -> Result<u32, String> {
        let hwid = crate::license::hwid::compute_hwid();
        let row = sqlx::query("SELECT demo_used FROM licenses WHERE hwid = ?1 AND plan = 'DEMO'")
            .bind(&hwid)
            .fetch_optional(&self.pool)
            .await
            .map_err(|e| e.to_string())?;
        let used: i64 = row
            .and_then(|r| r.try_get::<i64, _>(0).ok())
            .unwrap_or(0);
        Ok(crate::license::verify::DEMO_INVOICE_LIMIT.saturating_sub(used as u32))
    }

    /// Crée la licence Démo de la machine au premier lancement.
    pub async fn ensure_demo_license(&self, hwid: &str) -> Result<(), String> {
        sqlx::query(
            r#"INSERT INTO licenses (hwid, license_key, plan, status, demo_used)
               VALUES (?1, 'DEMO', 'DEMO', 'DEMO', 0)
               ON CONFLICT(hwid) DO NOTHING"#,
        )
        .bind(hwid)
        .execute(&self.pool)
        .await
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Consomme 1 facture du contingent Démo.
    pub async fn bump_demo_used(&self) -> Result<(), String> {
        let hwid = crate::license::hwid::compute_hwid();
        sqlx::query("UPDATE licenses SET demo_used = demo_used + 1 WHERE hwid = ?1 AND plan = 'DEMO'")
            .bind(&hwid)
            .execute(&self.pool)
            .await
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Horodatage de la dernière vérification (audit).
    pub async fn mark_verified(&self) -> Result<(), String> {
        sqlx::query(
            r#"UPDATE licenses SET last_verified_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
               WHERE status IN ('ACTIVE','EXPIRED')"#,
        )
        .execute(&self.pool)
        .await
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Persiste une clé vérifiée (activation).
    pub async fn save_license(
        &self,
        hwid: &str,
        key: &str,
        plan: &str,
        serial: &str,
        issued_at: i64,
        expires_at: Option<i64>,
    ) -> Result<(), String> {
        let issued = iso8601(issued_at);
        let exp = expires_at.map(iso8601);
        sqlx::query(
            r#"INSERT INTO licenses (hwid, license_key, plan, serial, issued_at, expires_at, status)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'ACTIVE')
               ON CONFLICT(hwid) DO UPDATE SET
                 license_key = excluded.license_key,
                 plan = excluded.plan,
                 serial = excluded.serial,
                 issued_at = excluded.issued_at,
                 expires_at = excluded.expires_at,
                 status = 'ACTIVE',
                 last_verified_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')"#,
        )
        .bind(hwid)
        .bind(key)
        .bind(plan)
        .bind(serial)
        .bind(&issued)
        .bind(exp)
        .execute(&self.pool)
        .await
        .map_err(|e| e.to_string())?;
        Ok(())
    }
}

// ----------------------------------------------------------------------------
// AUTH — setup initial, login PIN (Argon2id), verrouillage
// ----------------------------------------------------------------------------

impl Db {
    /// Vrai tant que le compte admin n'a PAS défini son PIN (placeholder).
    pub async fn needs_setup(&self) -> Result<bool, String> {
        let row = sqlx::query(
            r#"SELECT COUNT(*) FROM users
               WHERE pin_hash NOT LIKE '%PLACEHOLDER_FIRST_RUN'"#,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(|e| e.to_string())?;
        let n: i64 = row.try_get(0).map_err(|e| e.to_string())?;
        Ok(n == 0)
    }

    /// Personnalise le compte placeholder créé par le seed.
    pub async fn setup_admin(&self, username: &str, full_name: &str, pin: &str) -> Result<(), String> {
        let hash = auth::hash_pin(pin, username)?;
        sqlx::query(
            r#"UPDATE users SET username = ?1, full_name = ?2, pin_hash = ?3,
                must_change_pin = 0, failed_attempts = 0
             WHERE id = (SELECT MIN(id) FROM users)"#,
        )
        .bind(username)
        .bind(full_name)
        .bind(hash)
        .execute(&self.pool)
        .await
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn login(&self, username: &str, pin: &str) -> Result<UserSession, String> {
        let row = sqlx::query(
            r#"SELECT id, full_name, role, pin_hash, can_edit_prices, must_change_pin,
                    failed_attempts, locked_until
             FROM users WHERE username = ?1 AND is_active = 1"#,
        )
        .bind(username)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Utilisateur inconnu".to_string())?;

        let id: i64 = row.try_get(0).map_err(|e| e.to_string())?;
        let full_name: String = row.try_get(1).map_err(|e| e.to_string())?;
        let role: String = row.try_get(2).map_err(|e| e.to_string())?;
        let pin_hash: String = row.try_get(3).map_err(|e| e.to_string())?;
        let can_edit_prices: i64 = row.try_get(4).map_err(|e| e.to_string())?;
        let must_change_pin: i64 = row.try_get(5).map_err(|e| e.to_string())?;
        let failed_attempts: i64 = row.try_get(6).map_err(|e| e.to_string())?;
        let locked_until: Option<String> = row.try_get(7).map_err(|e| e.to_string())?;

        // Verrouissement (15 min après 5 échecs)
        if let Some(until) = &locked_until {
            let until_secs = parse_iso8601(until).unwrap_or(0);
            if chrono::Utc::now().timestamp() < until_secs {
                return Err(format!("Compte verrouillé jusqu'à {until}"));
            }
        }

        if auth::verify_pin(pin, username, &pin_hash) {
            sqlx::query(
                r#"UPDATE users SET failed_attempts = 0, locked_until = NULL,
                    last_login_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1"#,
            )
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(|e| e.to_string())?;
            self.audit(id, "LOGIN", None, None).await?;
            Ok(UserSession {
                id,
                full_name,
                role,
                can_edit_prices: can_edit_prices == 1,
                must_change_pin: must_change_pin == 1,
            })
        } else {
            let attempts = failed_attempts + 1;
            let lock = if attempts >= auth::MAX_ATTEMPTS {
                let secs = chrono::Utc::now().timestamp() + auth::LOCK_MINUTES * 60;
                Some(iso8601(secs))
            } else {
                None
            };
            sqlx::query(
                "UPDATE users SET failed_attempts = ?1, locked_until = ?2 WHERE id = ?3",
            )
            .bind(attempts)
            .bind(lock)
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(|e| e.to_string())?;
            if lock.is_some() {
                Err("Trop de tentatives — compte verrouillé 15 minutes".into())
            } else {
                Err(format!("PIN incorrect (tentative {attempts}/5)"))
            }
        }
    }
}

// ----------------------------------------------------------------------------
// CATALOGUE (pré-chargé pour la recherche < 10 ms)
// ----------------------------------------------------------------------------

impl Db {
    pub async fn preload(&self) -> Result<PreloadData, String> {
        let clients = sqlx::query(
            r#"SELECT id, name, COALESCE(nif,''), COALESCE(phone,'') FROM clients WHERE is_active = 1 ORDER BY name"#,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|r| ClientLite {
            id: r.try_get(0).unwrap_or(0),
            name: r.try_get(1).unwrap_or_default(),
            nif: r.try_get(2).unwrap_or_default(),
            phone: r.try_get(3).unwrap_or_default(),
        })
        .collect::<Vec<_>>();

        let products = sqlx::query(
            r#"SELECT p.id, p.sku, p.barcode, p.name, p.unit, p.kind, p.sale_price_ht,
                    p.tva_rate, p.cost_dzd,
                    (SELECT COALESCE(SUM(s.qty), 0) FROM stock s WHERE s.product_id = p.id)
             FROM products p
             WHERE p.is_active = 1
             ORDER BY p.name"#,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|r| ProductLite {
            id: r.try_get(0).unwrap_or(0),
            sku: r.try_get(1).unwrap_or_default(),
            barcode: r.try_get(2).ok(),
            name: r.try_get(3).unwrap_or_default(),
            unit: r.try_get(4).unwrap_or_else(|_| "U".into()),
            kind: r.try_get(5).unwrap_or_else(|_| "PRODUCT".into()),
            sale_price_ht: r.try_get(6).unwrap_or(0.0),
            tva_rate: r.try_get(7).unwrap_or(0.19),
            cost_dzd: r.try_get(8).unwrap_or(0.0),
            stock: r.try_get(9).unwrap_or(0.0),
        })
        .collect::<Vec<_>>();

        let users = sqlx::query(
            "SELECT id, username, full_name, role FROM users WHERE is_active = 1 ORDER BY id",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|r| UserLite {
            id: r.try_get(0).unwrap_or(0),
            username: r.try_get(1).unwrap_or_default(),
            full_name: r.try_get(2).unwrap_or_default(),
            role: r.try_get(3).unwrap_or_default(),
        })
        .collect::<Vec<_>>();

        let cfg_row = sqlx::query(
            r#"SELECT company_name, legal_form, nif, nis, rc, ai, address, wilaya, phone, email,
                    iban, bank_name, timbre_rate, timbre_min, timbre_max, timbre_receipt_min,
                    stamp_png_path, signature_png_path, logo_png_path, whatsapp_footer
             FROM company_config WHERE id = 1"#,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "company_config introuvable (seed)".to_string())?;

        let config = CompanyConfig {
            company_name: cfg_row.try_get(0).unwrap_or_default(),
            legal_form: cfg_row.try_get(1).ok(),
            nif: cfg_row.try_get(2).ok(),
            nis: cfg_row.try_get(3).ok(),
            rc: cfg_row.try_get(4).ok(),
            ai: cfg_row.try_get(5).ok(),
            address: cfg_row.try_get(6).ok(),
            wilaya: cfg_row.try_get(7).ok(),
            phone: cfg_row.try_get(8).ok(),
            email: cfg_row.try_get(9).ok(),
            iban: cfg_row.try_get(10).ok(),
            bank_name: cfg_row.try_get(11).ok(),
            timbre_rate: cfg_row.try_get(12).unwrap_or(fiscal::DZ_TIMBRE.rate),
            timbre_min: cfg_row.try_get(13).unwrap_or(fiscal::DZ_TIMBRE.min),
            timbre_max: cfg_row.try_get(14).unwrap_or(fiscal::DZ_TIMBRE.max),
            timbre_receipt_min: cfg_row.try_get(15).unwrap_or(fiscal::DZ_TIMBRE.receipt_min),
            stamp_png_path: cfg_row.try_get(16).ok(),
            signature_png_path: cfg_row.try_get(17).ok(),
            logo_png_path: cfg_row.try_get(18).ok(),
            whatsapp_footer: cfg_row.try_get(19).ok(),
        };

        Ok(PreloadData {
            clients,
            products,
            users,
            config,
        })
    }

    pub async fn upsert_products(
        &self,
        user_id: i64,
        rows: Vec<ProductRow>,
    ) -> Result<Vec<ProductLite>, String> {
        let mut tx = self.pool.begin().await.map_err(|e| e.to_string())?;
        for r in &rows {
            let tva_ok = (0.0 - r.tva_rate).abs() < 1e-9
                || (0.09 - r.tva_rate).abs() < 1e-9
                || (0.19 - r.tva_rate).abs() < 1e-9;
            if !tva_ok {
                return Err(format!("taux TVA {} hors barème DZ (sku {})", r.tva_rate, r.sku));
            }
            let kind = if r.kind.to_uppercase() == "SERVICE" {
                "SERVICE"
            } else {
                "PRODUCT"
            };
            sqlx::query(
                r#"INSERT INTO products (sku, barcode, name, category, unit, kind,
                        purchase_price_ht, purchase_currency, fx_rate_at_purchase, extra_costs_dzd,
                        cost_dzd, sale_price_ht, tva_rate, min_stock, created_by)
                   VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)
                   ON CONFLICT(sku) DO UPDATE SET
                        barcode = excluded.barcode,
                        name = excluded.name,
                        category = excluded.category,
                        unit = excluded.unit,
                        kind = excluded.kind,
                        purchase_price_ht = excluded.purchase_price_ht,
                        purchase_currency = excluded.purchase_currency,
                        fx_rate_at_purchase = excluded.fx_rate_at_purchase,
                        extra_costs_dzd = excluded.extra_costs_dzd,
                        cost_dzd = excluded.cost_dzd,
                        sale_price_ht = excluded.sale_price_ht,
                        tva_rate = excluded.tva_rate,
                        min_stock = excluded.min_stock"#,
            )
            .bind(&r.sku)
            .bind(&r.barcode)
            .bind(&r.name)
            .bind(&r.category)
            .bind(&r.unit)
            .bind(kind)
            .bind(r.purchase_price_ht)
            .bind(&r.purchase_currency)
            .bind(r.fx_rate)
            .bind(r.extra_costs_dzd)
            .bind(r.cost_dzd)
            .bind(r.sale_price_ht)
            .bind(r.tva_rate)
            .bind(r.min_stock)
            .bind(user_id)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
        }
        let ref_id = rows.len().to_string();
        self.audit_tx(&mut tx, user_id, "UPLOAD_CATALOG", "products", &ref_id)
            .await?;
        tx.commit().await.map_err(|e| e.to_string())?;
        Ok(self.preload().await?.products)
    }

    pub async fn create_client(
        &self,
        user_id: i64,
        name: &str,
        nif: &str,
        phone: &str,
    ) -> Result<ClientLite, String> {
        let name = name.trim();
        if name.is_empty() {
            return Err("nom de client vide".into());
        }
        let count = sqlx::query("SELECT COUNT(*) FROM clients")
            .fetch_one(&self.pool)
            .await
            .map_err(|e| e.to_string())?;
        let n: i64 = count.try_get(0).map_err(|e| e.to_string())?;
        let code = format!("CL-{:05}", n + 1);
        let row = sqlx::query(
            r#"INSERT INTO clients (code, name, nif, phone, created_by)
               VALUES (?1,?2,?3,?4,?5)
               RETURNING id, name, COALESCE(nif,''), COALESCE(phone,'')"#,
        )
        .bind(&code)
        .bind(name)
        .bind(if nif.is_empty() { None } else { Some(nif) })
        .bind(if phone.is_empty() { None } else { Some(phone) })
        .bind(user_id)
        .fetch_one(&self.pool)
        .await
        .map_err(|e| e.to_string())?;
        let ref_id = code.clone();
        self.audit(user_id, "CLIENT_CREATE", Some("clients"), Some(&ref_id))
            .await?;
        Ok(ClientLite {
            id: row.try_get(0).map_err(|e| e.to_string())?,
            name: row.try_get(1).map_err(|e| e.to_string())?,
            nif: row.try_get(2).map_err(|e| e.to_string())?,
            phone: row.try_get(3).map_err(|e| e.to_string())?,
        })
    }
}

// ----------------------------------------------------------------------------
// FACTURATION — numérotation + écriture ATOMIQUE (séquence, document, lignes,
// stock, mouvements, audit) en UNE seule transaction
// ----------------------------------------------------------------------------

fn doc_prefix(doc_type: &str) -> &'static str {
    match doc_type {
        "DEVIS" => "DV",
        "BL" => "BL",
        _ => "FA",
    }
}

impl Db {
    /// Aperçu du prochain n° (sans consommer la séquence).
    pub async fn next_number_preview(&self, doc_type: &str) -> Result<String, String> {
        let year = chrono::Local::now().year();
        let row = sqlx::query(
            "SELECT last_number FROM doc_sequences WHERE doc_type = ?1 AND year = ?2",
        )
        .bind(doc_type)
        .bind(year)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| e.to_string())?;
        let last: i64 = row.and_then(|r| r.try_get::<i64, _>(0).ok()).unwrap_or(0);
        Ok(format!("{}-{}-{:06}", doc_prefix(doc_type), year, last + 1))
    }

    pub async fn save_invoice(&self, user_id: i64, doc: &NewInvoice) -> Result<SavedInvoice, String> {
        let doc_type = doc.doc_type.to_uppercase();
        if !matches!(doc_type.as_str(), "DEVIS" | "BL" | "FACTURE") {
            return Err("type de document invalide (DEVIS|BL|FACTURE)".into());
        }
        if doc.items.is_empty() {
            return Err("document sans ligne".into());
        }
        if !matches!(doc.currency.as_str(), "DZD" | "EUR" | "USD") {
            return Err("devise invalide".into());
        }
        let client = sqlx::query("SELECT id FROM clients WHERE id = ?1")
            .bind(doc.client_id)
            .fetch_optional(&self.pool)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "client introuvable".to_string())?;
        let _ = client;

        let cfg_row = sqlx::query(
            "SELECT timbre_rate, timbre_min, timbre_max, timbre_receipt_min FROM company_config WHERE id = 1",
        )
        .fetch_one(&self.pool)
        .await
        .map_err(|e| e.to_string())?;
        let _timbre_cfg = fiscal::TimbreCfg {
            rate: cfg_row.try_get(0).map_err(|e| e.to_string())?,
            min: cfg_row.try_get(1).map_err(|e| e.to_string())?,
            max: cfg_row.try_get(2).map_err(|e| e.to_string())?,
            receipt_min: cfg_row.try_get(3).map_err(|e| e.to_string())?,
        };

        let fx_dzd = if doc.currency == "DZD" { 1.0 } else { doc.fx_rate };

        // Coûts unitaires au moment de la vente (marge figée sur le document)
        let mut lines: Vec<fiscal::LineInput> = Vec::with_capacity(doc.items.len());
        let mut costs: Vec<f64> = Vec::with_capacity(doc.items.len());
        for it in &doc.items {
            let tva_ok = (0.0 - it.tva_rate).abs() < 1e-9
                || (0.09 - it.tva_rate).abs() < 1e-9
                || (0.19 - it.tva_rate).abs() < 1e-9;
            if !tva_ok {
                return Err("taux TVA hors barème DZ (0, 9, 19)".into());
            }
            let cost = if let Some(pid) = it.product_id {
                sqlx::query("SELECT cost_dzd FROM products WHERE id = ?1")
                    .bind(pid)
                    .fetch_optional(&self.pool)
                    .await
                    .map_err(|e| e.to_string())?
                    .and_then(|r| r.try_get::<f64, _>(0).ok())
                    .unwrap_or(0.0)
            } else {
                0.0 // prestation « à la volée » : sans coût de revient
            };
            costs.push(cost);
            lines.push(fiscal::LineInput {
                qty: it.qty,
                unit_price_ht: it.unit_price_ht,
                discount_rate: it.discount_rate,
                tva_rate: it.tva_rate,
                cost_unit_dzd: cost,
            });
        }

        // Moteur fiscal = source de vérité (même vecteurs que le TS)
        let apply_timbre = doc_type == "FACTURE";
        let totals = fiscal::doc_totals_full(&lines, fx_dzd, apply_timbre);
        let year = chrono::Local::now().year();

        let mut tx = self.pool.begin().await.map_err(|e| e.to_string())?;

        // 1) Séquence
        let nrow = sqlx::query(
            r#"INSERT INTO doc_sequences (doc_type, year, last_number) VALUES (?1, ?2, 1)
               ON CONFLICT(doc_type, year) DO UPDATE SET last_number = last_number + 1
               RETURNING last_number"#,
        )
        .bind(&doc_type)
        .bind(year)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
        let n: i64 = nrow.try_get(0).map_err(|e| e.to_string())?;
        let number = format!("{}-{}-{:06}", doc_prefix(&doc_type), year, n);

        // 2) Document (totaux dénormalisés)
        let irow = sqlx::query(
            r#"INSERT INTO invoices (doc_type, number, client_id, status, date, currency, fx_rate,
                    payment_method, total_ht, total_discount, total_tva, total_ttc, timbre,
                    total_due, cost_dzd, margin_dzd, notes, created_by, validated_at)
               VALUES (?1,?2,?3,'VALIDATED',?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,
                       strftime('%Y-%m-%dT%H:%M:%fZ','now'))
               RETURNING id"#,
        )
        .bind(&doc_type)
        .bind(&number)
        .bind(doc.client_id)
        .bind(&doc.date)
        .bind(&doc.currency)
        .bind(fx_dzd)
        .bind(&doc.payment_method)
        .bind(totals.total_ht)
        .bind(totals.total_discount)
        .bind(totals.total_tva)
        .bind(totals.total_ttc)
        .bind(totals.timbre)
        .bind(totals.total_due)
        .bind(totals.cost_dzd)
        .bind(totals.margin_dzd)
        .bind(&doc.notes)
        .bind(user_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
        let inv_id: i64 = irow.try_get(0).map_err(|e| e.to_string())?;

        // 3) Lignes
        for (i, it) in doc.items.iter().enumerate() {
            let c = fiscal::compute_line(
                it.qty,
                it.unit_price_ht,
                it.discount_rate,
                it.tva_rate,
                costs[i],
                fx_dzd,
            );
            sqlx::query(
                r#"INSERT INTO invoice_items (invoice_id, line_no, product_id, name, qty, unit,
                        unit_price_ht, discount_rate, discount_amount, tva_rate,
                        amount_ht, amount_tva, amount_ttc, cost_unit_dzd)
                   VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)"#,
            )
            .bind(inv_id)
            .bind((i + 1) as i64)
            .bind(it.product_id)
            .bind(&it.name)
            .bind(it.qty)
            .bind(&it.unit)
            .bind(it.unit_price_ht)
            .bind(it.discount_rate)
            .bind(c.discount_amount)
            .bind(it.tva_rate)
            .bind(c.amount_ht)
            .bind(c.amount_tva)
            .bind(c.amount_ttc)
            .bind(costs[i])
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
        }

        // 4) Sortie de stock (FACTURE & BL, articles physiques uniquement)
        if doc_type == "FACTURE" || doc_type == "BL" {
            for (i, it) in doc.items.iter().enumerate() {
                if let Some(pid) = it.product_id {
                    if it.qty > 0.0 {
                        sqlx::query(
                            r#"UPDATE stock
                                SET qty = qty - ?1
                              WHERE product_id = ?2
                                AND warehouse_id = (SELECT id FROM warehouses WHERE is_default = 1)"#,
                        )
                        .bind(it.qty)
                        .bind(pid)
                        .execute(&mut *tx)
                        .await
                        .map_err(|e| e.to_string())?;
                        sqlx::query(
                            r#"INSERT INTO stock_movements (product_id, warehouse_id, type, qty,
                                    unit_cost_dzd, ref_type, ref_id, user_id)
                               SELECT ?1, id, 'OUT', ?2, ?3, ?4, ?5, ?6
                                 FROM warehouses WHERE is_default = 1"#,
                        )
                        .bind(pid)
                        .bind(-it.qty)
                        .bind(costs[i])
                        .bind(&doc_type)
                        .bind(&number)
                        .bind(user_id)
                        .execute(&mut *tx)
                        .await
                        .map_err(|e| e.to_string())?;
                    }
                }
            }
        }

        self.audit_tx(&mut tx, user_id, "SAVE_INVOICE", "invoices", &number)
            .await?;
        tx.commit().await.map_err(|e| e.to_string())?;

        // 5) Mode Démo : chaque FACTURE validée consomme le contingent (10)
        let demo_remaining = if doc_type == "FACTURE" && self.current_license_key().await?.is_none()
        {
            let _ = self.bump_demo_used().await;
            self.demo_remaining().await.unwrap_or(0)
        } else {
            u32::MAX
        };

        Ok(SavedInvoice {
            id: inv_id,
            number,
            totals,
            demo_remaining,
        })
    }
}
// ----------------------------------------------------------------------------
// G50 — données brutes du pré-état + archivage
// ----------------------------------------------------------------------------

impl Db {
    pub async fn g50_raw(&self, start: &str, end: &str) -> Result<G50Raw, String> {
        let map_rows = |rows: Vec<SqliteRow>| -> Vec<RateAgg> {
            rows.into_iter()
                .map(|r| RateAgg {
                    rate: r.try_get(0).unwrap_or(0.0),
                    base: r.try_get(1).unwrap_or(0.0),
                    tva: r.try_get(2).unwrap_or(0.0),
                })
                .collect()
        };
        let sales = sqlx::query(
            r#"SELECT ii.tva_rate, ROUND(SUM(ii.amount_ht), 2), ROUND(SUM(ii.amount_tva), 2)
               FROM invoices i JOIN invoice_items ii ON ii.invoice_id = i.id
               WHERE i.doc_type = 'FACTURE' AND i.status IN ('VALIDATED','PARTIAL','PAID')
                 AND date(i.date) BETWEEN ?1 AND ?2
               GROUP BY ii.tva_rate ORDER BY ii.tva_rate DESC"#,
        )
        .bind(start)
        .bind(end)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.to_string())?;

        let purchases = sqlx::query(
            r#"SELECT tva_rate, ROUND(SUM(base_ht), 2), ROUND(SUM(tva), 2)
               FROM purchase_items
               WHERE deductible = 1 AND date(date) BETWEEN ?1 AND ?2
               GROUP BY tva_rate ORDER BY tva_rate DESC"#,
        )
        .bind(start)
        .bind(end)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.to_string())?;

        let purchases_non_deductible = sqlx::query(
            r#"SELECT tva_rate, ROUND(SUM(base_ht), 2), ROUND(SUM(tva), 2)
               FROM purchase_items
               WHERE deductible = 0 AND date(date) BETWEEN ?1 AND ?2
               GROUP BY tva_rate ORDER BY tva_rate DESC"#,
        )
        .bind(start)
        .bind(end)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.to_string())?;

        Ok(G50Raw {
            period_start: start.to_string(),
            period_end: end.to_string(),
            sales: map_rows(sales),
            purchases: map_rows(purchases),
            purchases_non_deductible: map_rows(purchases_non_deductible),
        })
    }

    pub async fn save_g50_snapshot(
        &self,
        user_id: i64,
        period_type: &str,
        start: &str,
        end: &str,
        data_json: &str,
    ) -> Result<(), String> {
        if !matches!(period_type, "MONTH" | "QUARTER") {
            return Err("période invalide (MONTH|QUARTER)".into());
        }
        sqlx::query(
            r#"INSERT OR REPLACE INTO g50_snapshots (period_type, period_start, period_end, data_json, created_by)
               VALUES (?1, ?2, ?3, ?4, ?5)"#,
        )
        .bind(period_type)
        .bind(start)
        .bind(end)
        .bind(data_json)
        .bind(user_id)
        .execute(&self.pool)
        .await
        .map_err(|e| e.to_string())?;
        let ref_id = format!("{period_type}:{start}");
        self.audit(user_id, "EXPORT_G50", Some("g50_snapshots"), Some(&ref_id))
            .await?;
        Ok(())
    }
}

// ----------------------------------------------------------------------------
// STOCK — vue d'ensemble, mouvements, ajustements, transferts
// ----------------------------------------------------------------------------

impl Db {
    pub async fn stock_overview(&self) -> Result<Vec<StockRow>, String> {
        let rows = sqlx::query(
            r#"SELECT p.id, p.sku, p.name, p.unit,
                    COALESCE(SUM(s.qty), 0), p.min_stock, p.cost_dzd
               FROM products p
               LEFT JOIN stock s ON s.product_id = p.id
               WHERE p.kind = 'PRODUCT' AND p.is_active = 1
               GROUP BY p.id
               ORDER BY p.name"#,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.to_string())?;
        Ok(rows
            .into_iter()
            .map(|r| StockRow {
                product_id: r.try_get(0).unwrap_or(0),
                sku: r.try_get(1).unwrap_or_default(),
                name: r.try_get(2).unwrap_or_default(),
                unit: r.try_get(3).unwrap_or_else(|_| "U".into()),
                qty: r.try_get(4).unwrap_or(0.0),
                min_stock: r.try_get(5).unwrap_or(0.0),
                cost_dzd: r.try_get(6).unwrap_or(0.0),
            })
            .collect())
    }

    pub async fn stock_movements(&self, limit: i64) -> Result<Vec<MovementRow>, String> {
        let rows = sqlx::query(
            r#"SELECT m.id, date(m.created_at), p.name, m.type, m.qty, w.name, m.ref_id, u.full_name
               FROM stock_movements m
               JOIN products p ON p.id = m.product_id
               JOIN warehouses w ON w.id = m.warehouse_id
               LEFT JOIN users u ON u.id = m.user_id
               ORDER BY m.id DESC
               LIMIT ?1"#,
        )
        .bind(limit)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.to_string())?;
        Ok(rows
            .into_iter()
            .map(|r| MovementRow {
                id: r.try_get(0).unwrap_or(0),
                date: r.try_get(1).unwrap_or_default(),
                product: r.try_get(2).unwrap_or_default(),
                kind: r.try_get(3).unwrap_or_default(),
                qty: r.try_get(4).unwrap_or(0.0),
                warehouse: r.try_get(5).unwrap_or_default(),
                ref_number: r.try_get(6).ok(),
                user: r.try_get(7).ok(),
            })
            .collect())
    }

    /// Ajustement manuel (IN / OUT / ADJUST) au dépôt par défaut.
    pub async fn stock_move(
        &self,
        user_id: i64,
        product_id: i64,
        delta: f64,
        rtype: &str,
        note: Option<&str>,
    ) -> Result<(), String> {
        if !matches!(rtype, "IN" | "OUT" | "ADJUST") {
            return Err("type de mouvement invalide (IN|OUT|ADJUST)".into());
        }
        if delta == 0.0 {
            return Err("quantité nulle".into());
        }
        let mut tx = self.pool.begin().await.map_err(|e| e.to_string())?;
        sqlx::query(
            r#"INSERT INTO stock (product_id, warehouse_id, qty)
               SELECT ?1, id, ?2 FROM warehouses WHERE is_default = 1
               ON CONFLICT(product_id, warehouse_id)
               DO UPDATE SET qty = qty + ?2,
                             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')"#,
        )
        .bind(product_id)
        .bind(delta)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
        sqlx::query(
            r#"INSERT INTO stock_movements (product_id, warehouse_id, type, qty, note, ref_type, user_id)
               SELECT ?1, id, ?2, ?3, ?4, 'MANUEL', ?5 FROM warehouses WHERE is_default = 1"#,
        )
        .bind(product_id)
        .bind(rtype)
        .bind(delta)
        .bind(note)
        .bind(user_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
        let ref_id = product_id.to_string();
        self.audit_tx(&mut tx, user_id, "STOCK_MOVE", "stock", &ref_id)
            .await?;
        tx.commit().await.map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Transfert entre dépôts (débit source / crédit destination, 2 mouvements).
    pub async fn transfer_stock(
        &self,
        user_id: i64,
        product_id: i64,
        from_warehouse: i64,
        to_warehouse: i64,
        qty: f64,
    ) -> Result<(), String> {
        if from_warehouse == to_warehouse {
            return Err("dépôt source et destination identiques".into());
        }
        if qty <= 0.0 {
            return Err("quantité de transfert invalide".into());
        }
        let mut tx = self.pool.begin().await.map_err(|e| e.to_string())?;

        let cur = sqlx::query(
            "SELECT qty FROM stock WHERE product_id = ?1 AND warehouse_id = ?2",
        )
        .bind(product_id)
        .bind(from_warehouse)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
        let available: f64 = cur.and_then(|r| r.try_get::<f64, _>(0).ok()).unwrap_or(0.0);
        if available + 1e-9 < qty {
            return Err(format!("stock insuffisant au dépôt source ({available} disponibles)"));
        }

        sqlx::query(
            "UPDATE stock SET qty = qty - ?1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
             WHERE product_id = ?2 AND warehouse_id = ?3",
        )
        .bind(qty)
        .bind(product_id)
        .bind(from_warehouse)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
        sqlx::query(
            r#"INSERT INTO stock (product_id, warehouse_id, qty)
               VALUES (?1, ?2, ?3)
               ON CONFLICT(product_id, warehouse_id)
               DO UPDATE SET qty = qty + ?3,
                             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')"#,
        )
        .bind(product_id)
        .bind(to_warehouse)
        .bind(qty)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;

        sqlx::query(
            "INSERT INTO stock_movements (product_id, warehouse_id, type, qty, ref_type, ref_id, user_id)
             VALUES (?1, ?2, 'TRANSFER_OUT', -?3, 'TRANSFERT', ?4, ?5)",
        )
        .bind(product_id)
        .bind(from_warehouse)
        .bind(qty)
        .bind(format!("{from_warehouse}->{to_warehouse}"))
        .bind(user_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
        sqlx::query(
            "INSERT INTO stock_movements (product_id, warehouse_id, type, qty, ref_type, ref_id, user_id)
             VALUES (?1, ?2, 'TRANSFER_IN', ?3, 'TRANSFERT', ?4, ?5)",
        )
        .bind(product_id)
        .bind(to_warehouse)
        .bind(qty)
        .bind(format!("{from_warehouse}->{to_warehouse}"))
        .bind(user_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;

        let ref_id = product_id.to_string();
        self.audit_tx(&mut tx, user_id, "STOCK_TRANSFER", "stock", &ref_id)
            .await?;
        tx.commit().await.map_err(|e| e.to_string())?;
        Ok(())
    }
}
// ----------------------------------------------------------------------------
// ACHATS / FOURNISSEURS / CHANGE
// ----------------------------------------------------------------------------

impl Db {
    pub async fn suppliers_list(&self) -> Result<Vec<SupplierLite>, String> {
        let rows = sqlx::query(
            "SELECT id, code, name, nif FROM suppliers WHERE is_active = 1 ORDER BY name",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.to_string())?;
        Ok(rows
            .into_iter()
            .map(|r| SupplierLite {
                id: r.try_get(0).unwrap_or(0),
                code: r.try_get(1).unwrap_or_default(),
                name: r.try_get(2).unwrap_or_default(),
                nif: r.try_get(3).ok(),
            })
            .collect())
    }

    pub async fn create_supplier(&self, name: &str, nif: Option<&str>) -> Result<SupplierLite, String> {
        let name = name.trim();
        if name.is_empty() {
            return Err("nom de fournisseur vide".into());
        }
        let count = sqlx::query("SELECT COUNT(*) FROM suppliers")
            .fetch_one(&self.pool)
            .await
            .map_err(|e| e.to_string())?;
        let n: i64 = count.try_get(0).map_err(|e| e.to_string())?;
        let code = format!("FO-{:05}", n + 1);
        let row = sqlx::query(
            r#"INSERT INTO suppliers (code, name, nif)
               VALUES (?1, ?2, ?3)
               RETURNING id, code, name, nif"#,
        )
        .bind(&code)
        .bind(name)
        .bind(nif)
        .fetch_one(&self.pool)
        .await
        .map_err(|e| e.to_string())?;
        Ok(SupplierLite {
            id: row.try_get(0).unwrap_or(0),
            code: row.try_get(1).unwrap_or_default(),
            name: row.try_get(2).unwrap_or_default(),
            nif: row.try_get(3).ok(),
        })
    }

    pub async fn fx_recent(&self, currency: &str) -> Result<Vec<FxRow>, String> {
        let rows = sqlx::query(
            r#"SELECT id, date, currency, official_rate, parallel_rate
               FROM fx_rates WHERE currency = ?1
               ORDER BY date DESC LIMIT 10"#,
        )
        .bind(currency)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.to_string())?;
        Ok(rows
            .into_iter()
            .map(|r| FxRow {
                id: r.try_get(0).unwrap_or(0),
                date: r.try_get(1).unwrap_or_default(),
                currency: r.try_get(2).unwrap_or_default(),
                official_rate: r.try_get(3).unwrap_or(0.0),
                parallel_rate: r.try_get(4).ok(),
            })
            .collect())
    }

    pub async fn record_fx_rate(
        &self,
        date: &str,
        currency: &str,
        official_rate: f64,
        parallel_rate: Option<f64>,
        source: &str,
    ) -> Result<(), String> {
        if !matches!(currency, "EUR" | "USD") {
            return Err("devise de change invalide (EUR|USD)".into());
        }
        if official_rate <= 0.0 {
            return Err("taux officiel invalide".into());
        }
        sqlx::query(
            r#"INSERT INTO fx_rates (date, currency, official_rate, parallel_rate, source)
               VALUES (?1, ?2, ?3, ?4, ?5)
               ON CONFLICT(date, currency) DO UPDATE SET
                 official_rate = excluded.official_rate,
                 parallel_rate = excluded.parallel_rate,
                 source = excluded.source"#,
        )
        .bind(date)
        .bind(currency)
        .bind(official_rate)
        .bind(parallel_rate)
        .bind(source)
        .execute(&self.pool)
        .await
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    // ACHATS (source de la TVA déductible G50) + mise à jour du coût posé
    pub async fn record_purchase(&self, user_id: i64, p: &PurchaseInput) -> Result<PurchaseRow, String> {
        let rate_ok = (0.0 - p.tva_rate).abs() < 1e-9
            || (0.09 - p.tva_rate).abs() < 1e-9
            || (0.19 - p.tva_rate).abs() < 1e-9;
        if !rate_ok {
            return Err("taux de TVA hors barème DZ (0, 9, 19)".into());
        }
        if !matches!(p.currency.as_str(), "DZD" | "EUR" | "USD") {
            return Err("devise invalide".into());
        }
        if p.qty <= 0.0 || p.unit_price_ht < 0.0 {
            return Err("quantité / prix invalide".into());
        }

        let base_ht = fiscal::round2(p.qty * p.unit_price_ht);
        let tva = fiscal::round2(base_ht * p.tva_rate);
        let ttc = fiscal::round2(base_ht + tva);
        let landed_unit = fiscal::landed_cost_unit_dzd(
            p.unit_price_ht,
            p.currency == "DZD",
            p.fx_rate,
            p.extra_costs_dzd,
            p.qty,
        );

        let mut tx = self.pool.begin().await.map_err(|e| e.to_string())?;

        if let Some(pid) = p.product_id {
            let r = sqlx::query("SELECT id, kind FROM products WHERE id = ?1")
                .bind(pid)
                .fetch_optional(&mut *tx)
                .await
                .map_err(|e| e.to_string())?
                .ok_or_else(|| format!("article introuvable (id {pid})"))?;
            let kind: String = r.try_get(1).map_err(|e| e.to_string())?;
            if kind != "PRODUCT" {
                return Err("un achat ne peut référencer qu'un produit (pas une prestation)".into());
            }
        }

        sqlx::query(
            r#"INSERT INTO purchase_items (supplier_id, product_id, doc_number, date, qty,
                    unit_price_ht, base_ht, tva_rate, tva, ttc, currency, fx_rate, deductible,
                    extra_costs_dzd, landed_cost_dzd, note, created_by)
               VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)
               RETURNING id"#,
        )
        .bind(p.supplier_id)
        .bind(p.product_id)
        .bind(&p.doc_number)
        .bind(&p.date)
        .bind(p.qty)
        .bind(p.unit_price_ht)
        .bind(base_ht)
        .bind(p.tva_rate)
        .bind(tva)
        .bind(ttc)
        .bind(&p.currency)
        .bind(p.fx_rate)
        .bind(i64::from(p.deductible))
        .bind(p.extra_costs_dzd)
        .bind(landed_unit)
        .bind(&p.note)
        .bind(user_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;

        // Mise à jour du coût posé + entrée de stock (produit physique)
        if let Some(pid) = p.product_id {
            sqlx::query(
                r#"UPDATE products
                    SET purchase_price_ht = ?1,
                        purchase_currency = ?2,
                        fx_rate_at_purchase = ?3,
                        extra_costs_dzd = ?4,
                        cost_dzd = ?5
                  WHERE id = ?6"#,
            )
            .bind(p.unit_price_ht)
            .bind(&p.currency)
            .bind(p.fx_rate)
            .bind(p.extra_costs_dzd)
            .bind(landed_unit)
            .bind(pid)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;

            sqlx::query(
                r#"INSERT INTO stock (product_id, warehouse_id, qty)
                   SELECT ?1, id, ?2 FROM warehouses WHERE is_default = 1
                   ON CONFLICT(product_id, warehouse_id)
                   DO UPDATE SET qty = qty + ?2,
                                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')"#,
            )
            .bind(pid)
            .bind(p.qty)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
            sqlx::query(
                r#"INSERT INTO stock_movements (product_id, warehouse_id, type, qty, unit_cost_dzd, ref_type, ref_id, user_id)
                   SELECT ?1, id, 'IN', ?2, ?3, 'ACHAT', ?4, ?5 FROM warehouses WHERE is_default = 1"#,
            )
            .bind(pid)
            .bind(p.qty)
            .bind(landed_unit)
            .bind(&p.doc_number)
            .bind(user_id)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
        }

        self.audit_tx(&mut tx, user_id, "RECORD_PURCHASE", "purchase_items", &p.date)
            .await?;
        tx.commit().await.map_err(|e| e.to_string())?;

        // Re-sélection de la ligne créée (pour le retour UI)
        let row = sqlx::query(
            r#"SELECT pi.id, s.name, p.name, pi.doc_number, pi.date, pi.qty, pi.unit_price_ht,
                    pi.base_ht, pi.tva_rate, pi.tva, pi.ttc, pi.currency, pi.fx_rate,
                    pi.deductible, pi.extra_costs_dzd, pi.landed_cost_dzd
               FROM purchase_items pi
               JOIN suppliers s ON s.id = pi.supplier_id
               LEFT JOIN products p ON p.id = pi.product_id
               WHERE pi.id = (SELECT MAX(id) FROM purchase_items)"#,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(|e| e.to_string())?;
        Ok(Self::purchase_row(row))
    }

    fn purchase_row(r: SqliteRow) -> PurchaseRow {
        PurchaseRow {
            id: r.try_get(0).unwrap_or(0),
            supplier: r.try_get(1).unwrap_or_default(),
            product: r.try_get(2).ok(),
            doc_number: r.try_get(3).ok(),
            date: r.try_get(4).unwrap_or_default(),
            qty: r.try_get(5).unwrap_or(0.0),
            unit_price_ht: r.try_get(6).unwrap_or(0.0),
            base_ht: r.try_get(7).unwrap_or(0.0),
            tva_rate: r.try_get(8).unwrap_or(0.0),
            tva: r.try_get(9).unwrap_or(0.0),
            ttc: r.try_get(10).unwrap_or(0.0),
            currency: r.try_get(11).unwrap_or_else(|_| "DZD".into()),
            fx_rate: r.try_get(12).unwrap_or(1.0),
            deductible: r.try_get::<i64, _>(13).unwrap_or(1) == 1,
            extra_costs_dzd: r.try_get(14).unwrap_or(0.0),
            landed_cost_dzd: r.try_get(15).unwrap_or(0.0),
        }
    }

    pub async fn purchases_list(&self, start: &str, end: &str) -> Result<Vec<PurchaseRow>, String> {
        let rows = sqlx::query(
            r#"SELECT pi.id, s.name, p.name, pi.doc_number, pi.date, pi.qty, pi.unit_price_ht,
                    pi.base_ht, pi.tva_rate, pi.tva, pi.ttc, pi.currency, pi.fx_rate,
                    pi.deductible, pi.extra_costs_dzd, pi.landed_cost_dzd
               FROM purchase_items pi
               JOIN suppliers s ON s.id = pi.supplier_id
               LEFT JOIN products p ON p.id = pi.product_id
               WHERE date(pi.date) BETWEEN ?1 AND ?2
               ORDER BY pi.date DESC, pi.id DESC"#,
        )
        .bind(start)
        .bind(end)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.to_string())?;
        Ok(rows.into_iter().map(Self::purchase_row).collect())
    }
}

// ----------------------------------------------------------------------------
// INVENTAIRES PHYSIQUES
// ----------------------------------------------------------------------------

impl Db {
    pub async fn inventory_start(&self, user_id: i64, warehouse_id: i64) -> Result<InventoryInfo, String> {
        let date = chrono::Local::now().format("%Y-%m-%d").to_string();
        let inv_row = sqlx::query(
            r#"INSERT INTO inventories (warehouse_id, status, date, created_by)
               VALUES (?1, 'DRAFT', ?2, ?3) RETURNING id"#,
        )
        .bind(warehouse_id)
        .bind(&date)
        .bind(user_id)
        .fetch_one(&self.pool)
        .await
        .map_err(|e| e.to_string())?;
        let inv_id: i64 = inv_row.try_get(0).map_err(|e| e.to_string())?;

        sqlx::query(
            r#"INSERT INTO inventory_lines (inventory_id, product_id, qty_book, qty_counted)
               SELECT ?1, p.id, s.qty, s.qty
               FROM stock s JOIN products p ON p.id = s.product_id
               WHERE s.warehouse_id = ?2"#,
        )
        .bind(inv_id)
        .bind(warehouse_id)
        .execute(&self.pool)
        .await
        .map_err(|e| e.to_string())?;

        let ref_id = inv_id.to_string();
        self.audit(user_id, "INVENTORY_START", Some("inventories"), Some(&ref_id))
            .await?;
        self.inventory_get(inv_id).await
    }

    pub async fn inventory_get(&self, id: i64) -> Result<InventoryInfo, String> {
        let h = sqlx::query(
            "SELECT id, warehouse_id, status, date, created_at, validated_at FROM inventories WHERE id = ?1",
        )
        .bind(id)
        .fetch_one(&self.pool)
        .await
        .map_err(|e| e.to_string())?;
        let lines = sqlx::query(
            r#"SELECT il.id, il.product_id, p.sku, p.name, p.unit, il.qty_book, il.qty_counted
               FROM inventory_lines il JOIN products p ON p.id = il.product_id
               WHERE il.inventory_id = ?1 ORDER BY p.name"#,
        )
        .bind(id)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.to_string())?;
        Ok(InventoryInfo {
            id: h.try_get(0).unwrap_or(id),
            warehouse_id: h.try_get(1).unwrap_or(0),
            status: h.try_get(2).unwrap_or_default(),
            date: h.try_get(3).unwrap_or_default(),
            created_at: h.try_get(4).unwrap_or_default(),
            validated_at: h.try_get(5).ok(),
            lines: lines
                .into_iter()
                .map(|r| InventoryLineRow {
                    id: r.try_get(0).unwrap_or(0),
                    product_id: r.try_get(1).unwrap_or(0),
                    sku: r.try_get(2).unwrap_or_default(),
                    name: r.try_get(3).unwrap_or_default(),
                    unit: r.try_get(4).unwrap_or_else(|_| "U".into()),
                    qty_book: r.try_get(5).unwrap_or(0.0),
                    qty_counted: r.try_get(6).unwrap_or(0.0),
                })
                .collect(),
        })
    }

    pub async fn inventories_list(&self, limit: i64) -> Result<Vec<InventorySummary>, String> {
        let rows = sqlx::query(
            r#"SELECT i.id, w.name, i.status, i.date,
                    (SELECT COUNT(*) FROM inventory_lines il WHERE il.inventory_id = i.id),
                    i.validated_at
               FROM inventories i JOIN warehouses w ON w.id = i.warehouse_id
               ORDER BY i.id DESC LIMIT ?1"#,
        )
        .bind(limit)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.to_string())?;
        Ok(rows
            .into_iter()
            .map(|r| InventorySummary {
                id: r.try_get(0).unwrap_or(0),
                warehouse: r.try_get(1).unwrap_or_default(),
                status: r.try_get(2).unwrap_or_default(),
                date: r.try_get(3).unwrap_or_default(),
                line_count: r.try_get(4).unwrap_or(0),
                validated_at: r.try_get(5).ok(),
            })
            .collect())
    }

    /// Clôture l'inventaire : applique les écarts au stock (mouvements ADJUST).
    pub async fn inventory_validate(
        &self,
        user_id: i64,
        id: i64,
        counts: Vec<CountedLine>,
    ) -> Result<InventoryResult, String> {
        let info = self.inventory_get(id).await?;
        if info.status != "DRAFT" {
            return Err("inventaire déjà validé".into());
        }
        let wh = info.warehouse_id;

        // Lignes de calcul (coût unitaire pour la valorisation)
        let mut core_lines: Vec<crate::inventory_core::InvLine> = Vec::new();
        let mut counted_map: std::collections::HashMap<i64, f64> =
            counts.iter().map(|c| (c.product_id, c.qty)).collect();
        for l in &info.lines {
            let counted = counted_map.remove(&l.product_id).unwrap_or(l.qty_book);
            core_lines.push(crate::inventory_core::InvLine {
                product_id: l.product_id,
                sku: l.sku.clone(),
                name: l.name.clone(),
                unit: l.unit.clone(),
                book: l.qty_book,
                counted,
                cost_unit: 0.0, // rempli ci-dessous
            });
        }
        // Coûts unitaires
        for cl in core_lines.iter_mut() {
            let c = sqlx::query("SELECT cost_dzd FROM products WHERE id = ?1")
                .bind(cl.product_id)
                .fetch_optional(&self.pool)
                .await
                .map_err(|e| e.to_string())?;
            cl.cost_unit = c.and_then(|r| r.try_get::<f64, _>(0).ok()).unwrap_or(0.0);
        }

        let adjustments = crate::inventory_core::adjustments(&core_lines);
        let (book_value, counted_value) = crate::inventory_core::valuation(&core_lines);
        let variance_pct = crate::inventory_core::variance_pct(&core_lines);

        let mut tx = self.pool.begin().await.map_err(|e| e.to_string())?;
        for cl in &core_lines {
            sqlx::query(
                "UPDATE inventory_lines SET qty_counted = ?1 WHERE inventory_id = ?2 AND product_id = ?3",
            )
            .bind(cl.counted)
            .bind(id)
            .bind(cl.product_id)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
        }
        for a in &adjustments {
            sqlx::query(
                r#"UPDATE stock SET qty = qty + ?1,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
                 WHERE product_id = ?2 AND warehouse_id = ?3"#,
            )
            .bind(a.diff)
            .bind(a.product_id)
            .bind(wh)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
            sqlx::query(
                r#"INSERT INTO stock_movements (product_id, warehouse_id, type, qty, note, ref_type, ref_id, user_id)
                   VALUES (?1, ?2, 'ADJUST', ?3, 'Inventaire physique', 'INVENTAIRE', ?4, ?5)"#,
            )
            .bind(a.product_id)
            .bind(wh)
            .bind(a.diff)
            .bind(id.to_string())
            .bind(user_id)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
        }
        sqlx::query(
            r#"UPDATE inventories SET status = 'VALIDATED',
                validated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1"#,
        )
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
        let ref_id = id.to_string();
        self.audit_tx(&mut tx, user_id, "INVENTORY_VALIDATE", "inventories", &ref_id)
            .await?;
        tx.commit().await.map_err(|e| e.to_string())?;

        Ok(InventoryResult {
            id,
            adjustments,
            book_value,
            counted_value,
            variance_pct,
        })
    }
}
// ----------------------------------------------------------------------------
// UTILISATEURS (ADMIN) & CHANGEMENT DE PIN
// ----------------------------------------------------------------------------

impl Db {
    pub async fn admin_users(&self) -> Result<Vec<AdminUser>, String> {
        let rows = sqlx::query(
            "SELECT id, username, full_name, role, can_edit_prices, is_active FROM users ORDER BY id",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.to_string())?;
        Ok(rows
            .into_iter()
            .map(|r| AdminUser {
                id: r.try_get(0).unwrap_or(0),
                username: r.try_get(1).unwrap_or_default(),
                full_name: r.try_get(2).unwrap_or_default(),
                role: r.try_get(3).unwrap_or_default(),
                can_edit_prices: r.try_get::<i64, _>(4).unwrap_or(0) == 1,
                is_active: r.try_get::<i64, _>(5).unwrap_or(1) == 1,
            })
            .collect())
    }

    pub async fn create_user(
        &self,
        actor: i64,
        username: &str,
        full_name: &str,
        role: &str,
        pin: &str,
        can_edit_prices: bool,
    ) -> Result<AdminUser, String> {
        let username = username.trim();
        if username.len() < 3 {
            return Err("nom d'utilisateur trop court (3 caractères min)".into());
        }
        if !matches!(role, "ADMIN" | "COMMERCIAL" | "STOREKEEPER" | "ACCOUNTANT") {
            return Err("rôle invalide".into());
        }
        if pin.len() < 4 {
            return Err("PIN trop court (4 caractères minimum)".into());
        }
        let hash = auth::hash_pin(pin, username)?;
        let dup = sqlx::query("SELECT COUNT(*) FROM users WHERE username = ?1")
            .bind(username)
            .fetch_one(&self.pool)
            .await
            .map_err(|e| e.to_string())?;
        if dup.try_get::<i64, _>(0).map_err(|e| e.to_string())? > 0 {
            return Err("nom d'utilisateur déjà utilisé".into());
        }
        // must_change_pin = 1 : le PIN initial (défini par le gérant) DOIT être
        // changé à la première connexion (gate ChangePinGate côté UI).
        sqlx::query(
            r#"INSERT INTO users (username, full_name, role, pin_hash, can_edit_prices, must_change_pin)
               VALUES (?1,?2,?3,?4,?5, 1)"#,
        )
        .bind(username)
        .bind(full_name)
        .bind(role)
        .bind(hash)
        .bind(i64::from(can_edit_prices))
        .execute(&self.pool)
        .await
        .map_err(|e| e.to_string())?;
        let ref_id = username.to_string();
        self.audit(actor, "USER_CREATE", Some("users"), Some(&ref_id))
            .await?;
        self.admin_users()
            .await
            .map(|all| {
                all.into_iter()
                    .find(|u| u.username == username)
                    .unwrap_or_else(|| AdminUser {
                        id: 0,
                        username: username.into(),
                        full_name: full_name.into(),
                        role: role.into(),
                        can_edit_prices,
                        is_active: true,
                    })
            })
    }

    pub async fn set_user_active(&self, actor: i64, id: i64, active: bool) -> Result<(), String> {
        if actor == id && !active {
            return Err("vous ne pouvez pas désactiver votre propre compte".into());
        }
        sqlx::query("UPDATE users SET is_active = ?1 WHERE id = ?2")
            .bind(i64::from(active))
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(|e| e.to_string())?;
        let ref_id = id.to_string();
        self.audit(
            actor,
            if active { "USER_ACTIVATE" } else { "USER_DEACTIVATE" },
            Some("users"),
            Some(&ref_id),
        )
        .await?;
        Ok(())
    }

    pub async fn set_user_price_rights(&self, actor: i64, id: i64, can: bool) -> Result<(), String> {
        sqlx::query("UPDATE users SET can_edit_prices = ?1 WHERE id = ?2")
            .bind(i64::from(can))
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(|e| e.to_string())?;
        let ref_id = id.to_string();
        self.audit(actor, "USER_PRICE_RIGHTS", Some("users"), Some(&ref_id))
            .await?;
        Ok(())
    }

    /// Changement de PIN (ancien PIN requis). Réinitialise aussi le drapeau
    /// must_change_pin.
    pub async fn change_pin(&self, user_id: i64, old_pin: &str, new_pin: &str) -> Result<(), String> {
        if new_pin.len() < 4 {
            return Err("nouveau PIN trop court (4 caractères minimum)".into());
        }
        let row = sqlx::query("SELECT pin_hash FROM users WHERE id = ?1 AND is_active = 1")
            .bind(user_id)
            .fetch_one(&self.pool)
            .await
            .map_err(|e| e.to_string())?;
        let username = sqlx::query("SELECT username FROM users WHERE id = ?1")
            .bind(user_id)
            .fetch_one(&self.pool)
            .await
            .map_err(|e| e.to_string())?;
        let username: String = username.try_get(0).map_err(|e| e.to_string())?;
        let old_hash: String = row.try_get(0).map_err(|e| e.to_string())?;
        if !auth::verify_pin(old_pin, &username, &old_hash) {
            return Err("PIN actuel incorrect".into());
        }
        let new_hash = auth::hash_pin(new_pin, &username)?;
        sqlx::query(
            "UPDATE users SET pin_hash = ?1, must_change_pin = 0, failed_attempts = 0 WHERE id = ?2",
        )
        .bind(new_hash)
        .bind(user_id)
        .execute(&self.pool)
        .await
        .map_err(|e| e.to_string())?;
        let ref_id = user_id.to_string();
        self.audit(user_id, "PIN_CHANGED", Some("users"), Some(&ref_id))
            .await?;
        Ok(())
    }
}

// ----------------------------------------------------------------------------
// DASHBOARD (totaux dénormalisés => lecture < 10 ms)
// ----------------------------------------------------------------------------

impl Db {
    pub async fn dashboard(&self) -> Result<Dashboard, String> {
        let now = chrono::Local::now();
        let start = format!("{:04}-{:02}-01", now.year(), now.month());
        let last_day = chrono::NaiveDate::from_ymd_opt(now.year(), now.month() + 1, 1)
            .and_then(|d| d.pred_opt())
            .map(|d| d.day())
            .unwrap_or(28);
        let end = format!("{:04}-{:02}-{:02}", now.year(), now.month(), last_day);

        let m = sqlx::query(
            r#"SELECT COALESCE(SUM(CASE WHEN doc_type = 'FACTURE' THEN total_ttc ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN doc_type = 'FACTURE' THEN total_tva ELSE 0 END), 0)
               FROM invoices
               WHERE status IN ('VALIDATED','PARTIAL','PAID')
                 AND date(date) BETWEEN ?1 AND ?2"#,
        )
        .bind(&start)
        .bind(&end)
        .fetch_one(&self.pool)
        .await
        .map_err(|e| e.to_string())?;
        let ca_month: f64 = m.try_get(0).unwrap_or(0.0);
        let tva_month: f64 = m.try_get(1).unwrap_or(0.0);

        let unpaid_row = sqlx::query(
            r#"SELECT COALESCE(SUM(i.total_due - COALESCE(p.paid, 0)), 0)
               FROM invoices i
               LEFT JOIN (
                   SELECT invoice_id, SUM(amount) AS paid FROM payments GROUP BY invoice_id
               ) p ON p.invoice_id = i.id
               WHERE i.status IN ('VALIDATED','PARTIAL')"#,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(|e| e.to_string())?;
        let unpaid: f64 = unpaid_row.try_get(0).unwrap_or(0.0);

        let low_row = sqlx::query(
            r#"SELECT COUNT(*) FROM products p
               WHERE p.kind = 'PRODUCT' AND p.is_active = 1
                 AND COALESCE((SELECT SUM(qty) FROM stock WHERE product_id = p.id), 0) < p.min_stock"#,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(|e| e.to_string())?;
        let low_stock: i64 = low_row.try_get(0).unwrap_or(0);

        let docs = sqlx::query(
            r#"SELECT i.number, i.doc_type, c.name, i.date, i.total_ttc, i.status
               FROM invoices i JOIN clients c ON c.id = i.client_id
               WHERE i.doc_type = 'FACTURE'
               ORDER BY i.id DESC LIMIT 8"#,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.to_string())?;
        let last_docs = docs
            .into_iter()
            .map(|r| DashboardLastDoc {
                number: r.try_get(0).unwrap_or_default(),
                doc_type: r.try_get(1).unwrap_or_default(),
                client: r.try_get(2).unwrap_or_default(),
                date: r.try_get(3).unwrap_or_default(),
                total_ttc: r.try_get(4).unwrap_or(0.0),
                status: r.try_get(5).unwrap_or_default(),
            })
            .collect::<Vec<_>>();

        let top = sqlx::query(
            r#"SELECT ii.name, SUM(ii.qty), SUM(ii.amount_ttc)
               FROM invoice_items ii
               JOIN invoices i ON i.id = ii.invoice_id
               WHERE i.doc_type = 'FACTURE'
                 AND i.status IN ('VALIDATED','PARTIAL','PAID')
                 AND date(i.date) BETWEEN ?1 AND ?2
               GROUP BY ii.name ORDER BY 2 DESC LIMIT 5"#,
        )
        .bind(&start)
        .bind(&end)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.to_string())?;
        let top_products = top
            .into_iter()
            .map(|r| DashboardTopProduct {
                name: r.try_get(0).unwrap_or_default(),
                qty: r.try_get(1).unwrap_or(0.0),
                revenue: r.try_get(2).unwrap_or(0.0),
            })
            .collect::<Vec<_>>();

        Ok(Dashboard {
            ca_month,
            tva_month,
            unpaid,
            low_stock,
            last_docs,
            top_products,
        })
    }
}

// ----------------------------------------------------------------------------
// AUDIT (traçabilité RBAC) + helpers
// ----------------------------------------------------------------------------

impl Db {
    async fn audit(
        &self,
        user_id: i64,
        action: &str,
        entity: Option<&str>,
        entity_id: Option<&str>,
    ) -> Result<(), String> {
        let hwid = crate::license::hwid::compute_hwid();
        sqlx::query(
            "INSERT INTO audit_log (user_id, action, entity, entity_id, hwid) VALUES (?1,?2,?3,?4,?5)",
        )
        .bind(user_id)
        .bind(action)
        .bind(entity)
        .bind(entity_id)
        .bind(&hwid)
        .execute(&self.pool)
        .await
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    async fn audit_tx(
        &self,
        tx: &mut sqlx::SqliteTransaction,
        user_id: i64,
        action: &str,
        entity: &str,
        entity_id: &str,
    ) -> Result<(), String> {
        let hwid = crate::license::hwid::compute_hwid();
        sqlx::query(
            "INSERT INTO audit_log (user_id, action, entity, entity_id, hwid) VALUES (?1,?2,?3,?4,?5)",
        )
        .bind(user_id)
        .bind(action)
        .bind(entity)
        .bind(entity_id)
        .bind(&hwid)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
        Ok(())
    }
}

fn iso8601(secs: i64) -> String {
    chrono::DateTime::from_timestamp(secs, 0)
        .map(|d| d.format("%Y-%m-%dT%H:%M:%fZ").to_string())
        .unwrap_or_default()
}

fn parse_iso8601(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|d| d.timestamp())
        .or_else(|| s.parse::<i64>().ok())
}

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_script_gere_triggers() {
        let script = "PRAGMA journal_mode = WAL;\n\nCREATE TABLE t (id INTEGER);\n\n-- commentaire\nCREATE TRIGGER trg AFTER UPDATE ON t BEGIN\n  UPDATE t SET x = 1 WHERE id = NEW.id;\nEND;\nINSERT INTO t (id) VALUES (1);";
        let stmts = split_sql_script(script);
        // PRAGMA + CREATE TABLE + TRIGGER (';' internes) + INSERT
        assert_eq!(stmts.len(), 4, "attend 4 énoncés, obtenu {stmts:?}");
        assert!(stmts[0].starts_with("PRAGMA"));
        assert!(stmts[1].starts_with("CREATE TABLE"));
        assert!(stmts[2].contains("BEGIN") && stmts[2].ends_with("END;"));
        assert!(stmts[3].starts_with("INSERT"));
    }

    #[test]
    fn split_script_ignore_commentaires() {
        let script = "-- seule une ligne de commentaire\nCREATE TABLE a (id INTEGER);\n";
        let stmts = split_sql_script(script);
        assert_eq!(stmts.len(), 1);
        assert!(stmts[0].starts_with("CREATE TABLE"));
    }
}
