-- ============================================================================
--  PROFast FACTURE — Schéma SQLite (100% local, sans Internet)
--  Cible : Tauri (Rust) + SQLite 3.35+  |  WAL  |  Foreign Keys ON
--
--  Conventions :
--   • Montants : REAL, arrondis à 2 décimales CÔTE APPLICATION (jamais en SQL).
--   • Dates    : TEXT ISO-8601 UTC ('...Z'). Les dates métier (doc.date)
--                sont en date locale YYYY-MM-DD.
--   • Taux TVA : stockés en décimal (0.19 / 0.09 / 0) — barème DZ.
--   • Performance < 10 ms : totaux dénormalisés (pas de SUM() au runtime),
--     index couvrants, catalogue pré-chargé en mémoire dans le webview.
-- ============================================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous  = NORMAL;
PRAGMA temp_store   = MEMORY;

-- ----------------------------------------------------------------------------
-- 1) LICENCES — verrouillage par empreinte matérielle (HWID)
--    Une ligne active par machine. Sans clé valide => ligne DEMO (max 10 factures).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS licenses (
    id               INTEGER PRIMARY KEY,
    hwid             TEXT    NOT NULL UNIQUE,            -- HWID-XXXX-XXXX-XXXX-XXXX
    license_key      TEXT    NOT NULL,                   -- PFF1.<payload b64url>.<signature Ed25519 b64url>
    public_key_id    TEXT    NOT NULL DEFAULT 'v1',      -- rotation des clés publiques du vendeur
    plan             TEXT    NOT NULL CHECK (plan IN ('ANNUAL','LIFETIME','DEMO')),
    serial           TEXT,                               -- n° commercial de la licence
    issued_at        TEXT    NOT NULL,                   -- UTC ISO-8601
    expires_at       TEXT,                               -- NULL => Licence À VIE
    status           TEXT    NOT NULL DEFAULT 'ACTIVE'
                    CHECK (status IN ('ACTIVE','EXPIRED','REVOKED','DEMO')),
    demo_used        INTEGER NOT NULL DEFAULT 0,         -- factures créées en mode Démo (plafond 10)
    installed_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    last_verified_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_licenses_status ON licenses(status);

-- ----------------------------------------------------------------------------
-- 2) CONFIGURATION SOCIÉTÉ (une seule ligne, id = 1)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS company_config (
    id                   INTEGER PRIMARY KEY CHECK (id = 1),
    company_name         TEXT    NOT NULL,
    legal_form           TEXT,                            -- EURL / SARL / EIRL / SPA...
    nif                  TEXT,                            -- N° Identification Fiscale
    nis                  TEXT,                            -- N° Identification Statistique
    rc                   TEXT,                            -- Registre de Commerce
    ai                   TEXT,                            -- Artisanat / autre
    address              TEXT,
    wilaya               TEXT,                            -- code INE (35 wilayas)
    phone                TEXT,
    email                TEXT,
    web                  TEXT,
    iban                 TEXT,
    bank_name            TEXT,
    bic                  TEXT,
    tva_regime           TEXT    NOT NULL DEFAULT 'REEL_NORMAL'
                         CHECK (tva_regime IN ('REEL_NORMAL','SIMPLIFIE','ASSIMILE')),
    g50_period           TEXT    NOT NULL DEFAULT 'MONTHLY'
                         CHECK (g50_period IN ('MONTHLY','QUARTERLY')),
    fiscal_year_start    INTEGER NOT NULL DEFAULT 1,      -- 1 = janvier, 7 = juillet
    currency_default     TEXT    NOT NULL DEFAULT 'DZD'
                         CHECK (currency_default IN ('DZD','EUR','USD')),
    invoice_prefix       TEXT    NOT NULL DEFAULT 'FA',
    quote_prefix         TEXT    NOT NULL DEFAULT 'DV',
    bl_prefix            TEXT    NOT NULL DEFAULT 'BL',
    stamp_png_path       TEXT,                            -- cachet numérisé (PNG)
    signature_png_path   TEXT,                            -- signature (PNG)
    logo_png_path        TEXT,
    timbre_rate          REAL    NOT NULL DEFAULT 0.01,   -- 1 %
    timbre_min           REAL    NOT NULL DEFAULT 5.0,    -- minimum légal (DA)
    timbre_max           REAL    NOT NULL DEFAULT 2500.0, -- plafond légal (DA)
    timbre_receipt_min   REAL    NOT NULL DEFAULT 2.0,    -- reçu de caisse (DA)
    whatsapp_footer      TEXT,                            -- signature du message WhatsApp
    created_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at           TEXT
);

-- ----------------------------------------------------------------------------
-- 3) UTILISATEURS — RBAC local (PIN/mot de passe haché Argon2id)
--    ADMIN (gérant) | COMMERCIAL | STOREKEEPER (magasinier) | ACCOUNTANT
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id                INTEGER PRIMARY KEY,
    username          TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    full_name         TEXT    NOT NULL,
    role              TEXT    NOT NULL
                      CHECK (role IN ('ADMIN','COMMERCIAL','STOREKEEPER','ACCOUNTANT')),
    pin_hash          TEXT    NOT NULL,                   -- argon2id(pin || username)
    pin_hint          TEXT,
    can_edit_prices   INTEGER NOT NULL DEFAULT 0,         -- 1 = modif. prix/remises en ligne (« droit modérable »)
    is_active         INTEGER NOT NULL DEFAULT 1,
    must_change_pin   INTEGER NOT NULL DEFAULT 1,
    failed_attempts   INTEGER NOT NULL DEFAULT 0,         -- verrou après 5 échecs
    locked_until      TEXT,
    created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    last_login_at     TEXT
);

-- ----------------------------------------------------------------------------
-- 4) CLIENTS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS clients (
    id                INTEGER PRIMARY KEY,
    code              TEXT    NOT NULL UNIQUE,            -- CL-00001
    name              TEXT    NOT NULL,
    nif               TEXT,
    nis               TEXT,
    rc                TEXT,
    ai                TEXT,
    address           TEXT,
    wilaya             TEXT,
    phone             TEXT,                               -- format international +213... (WhatsApp)
    email             TEXT,
    currency          TEXT    NOT NULL DEFAULT 'DZD'
                      CHECK (currency IN ('DZD','EUR','USD')),
    opening_balance   REAL    NOT NULL DEFAULT 0,         -- solde initial (DA)
    credit_limit      REAL,
    notes             TEXT,
    is_active         INTEGER NOT NULL DEFAULT 1,
    created_by        INTEGER REFERENCES users(id),
    created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_clients_name   ON clients(name);
CREATE INDEX IF NOT EXISTS idx_clients_nif    ON clients(nif);
CREATE INDEX IF NOT EXISTS idx_clients_phone  ON clients(phone);

-- ----------------------------------------------------------------------------
-- 5) FOURNISSEURS & ACHATS — source de la TVA déductible (G50) et du coût
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS suppliers (
    id          INTEGER PRIMARY KEY,
    code        TEXT    NOT NULL UNIQUE,                  -- FO-00001
    name        TEXT    NOT NULL,
    nif         TEXT,
    nis         TEXT,
    rc          TEXT,
    address     TEXT,
    wilaya      TEXT,
    phone       TEXT,
    email       TEXT,
    is_active   INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS purchase_items (
    id                INTEGER PRIMARY KEY,
    supplier_id       INTEGER NOT NULL REFERENCES suppliers(id),
    product_id        INTEGER REFERENCES products(id),
    doc_number        TEXT,                               -- n° facture fournisseur
    date              TEXT    NOT NULL,                   -- YYYY-MM-DD
    qty               REAL    NOT NULL DEFAULT 1,         -- quantité (1 si frais purs)
    unit_price_ht     REAL    NOT NULL,                   -- prix unitaire HT (devise d'achat)
    base_ht           REAL    NOT NULL,                   -- = qty * unit_price_ht
    tva_rate          REAL    NOT NULL CHECK (tva_rate IN (0, 0.09, 0.19)),
    tva               REAL    NOT NULL,
    ttc               REAL    NOT NULL,
    currency          TEXT    NOT NULL DEFAULT 'DZD'
                      CHECK (currency IN ('DZD','EUR','USD')),
    fx_rate           REAL    NOT NULL DEFAULT 1,         -- taux officiel ou parallèle
    deductible        INTEGER NOT NULL DEFAULT 1,         -- 1 = TVA déductible (facture complète)
    extra_costs_dzd   REAL    NOT NULL DEFAULT 0,         -- transport, douane, frais (TOTAL)
    landed_cost_dzd   REAL    NOT NULL DEFAULT 0,         -- coût posé UNITAIRE en DZD
    note              TEXT,
    created_by        INTEGER REFERENCES users(id),
    created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_pi_date     ON purchase_items(date);
CREATE INDEX IF NOT EXISTS idx_pi_supplier ON purchase_items(supplier_id);
CREATE INDEX IF NOT EXISTS idx_pi_product  ON purchase_items(product_id);

-- ----------------------------------------------------------------------------
-- 6) ARTICLES — Produits (stock) & Prestations de services (sans stock)
--    Le coût de revient « posé » (cost_dzd) est dénormalisé : lecture < 10 ms.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS products (
    id                    INTEGER PRIMARY KEY,
    sku                   TEXT    NOT NULL UNIQUE,        -- référence / code-barres
    barcode               TEXT,                           -- EAN-13 si distincte du SKU
    name                  TEXT    NOT NULL,
    category              TEXT,
    unit                  TEXT    NOT NULL DEFAULT 'U',   -- U, KG, L, M2, PCE...
    kind                  TEXT    NOT NULL DEFAULT 'PRODUCT'
                          CHECK (kind IN ('PRODUCT','SERVICE')),
    -- Achat (devise EUR/USD via fx_rate_at_purchase)
    purchase_price_ht     REAL,                           -- dans purchase_currency
    purchase_currency     TEXT    NOT NULL DEFAULT 'DZD'
                          CHECK (purchase_currency IN ('DZD','EUR','USD')),
    fx_rate_at_purchase   REAL    NOT NULL DEFAULT 1,     -- taux au dernier achat
    extra_costs_dzd       REAL    NOT NULL DEFAULT 0,     -- douane, transport, frais
    cost_dzd              REAL    NOT NULL DEFAULT 0,     -- coût posé = px*fx + frais
    -- Vente
    sale_price_ht         REAL    NOT NULL,
    tva_rate              REAL    NOT NULL DEFAULT 0.19
                          CHECK (tva_rate IN (0, 0.09, 0.19)),
    default_discount      REAL    NOT NULL DEFAULT 0,     -- remise par défaut (0..1)
    min_stock             REAL    NOT NULL DEFAULT 0,     -- alerte stock minimum
    is_active             INTEGER NOT NULL DEFAULT 1,
    created_by            INTEGER REFERENCES users(id),
    created_at            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at            TEXT
);
CREATE INDEX IF NOT EXISTS idx_products_sku     ON products(sku);
CREATE INDEX IF NOT EXISTS idx_products_name    ON products(name);
CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);
CREATE INDEX IF NOT EXISTS idx_products_active  ON products(is_active);

-- ----------------------------------------------------------------------------
-- 7) MAGASINS & STOCK (multi-dépôts, transferts, inventaires)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS warehouses (
    id          INTEGER PRIMARY KEY,
    code        TEXT    NOT NULL UNIQUE,                  -- P01, P02...
    name        TEXT    NOT NULL,
    is_default  INTEGER NOT NULL DEFAULT 0,
    is_active   INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS stock (
    product_id   INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
    qty          REAL    NOT NULL DEFAULT 0,
    updated_at   TEXT,
    PRIMARY KEY (product_id, warehouse_id)
);
CREATE INDEX IF NOT EXISTS idx_stock_warehouse ON stock(warehouse_id);

-- Mouvements traçables (qui / quoi / où / pourquoi)
CREATE TABLE IF NOT EXISTS stock_movements (
    id             INTEGER PRIMARY KEY,
    product_id     INTEGER NOT NULL REFERENCES products(id),
    warehouse_id   INTEGER NOT NULL REFERENCES warehouses(id),
    type           TEXT    NOT NULL
                   CHECK (type IN ('IN','OUT','ADJUST','TRANSFER_IN','TRANSFER_OUT')),
    qty            REAL    NOT NULL,                      -- signé : + entrée / − sortie
    unit_cost_dzd  REAL,
    ref_type       TEXT,                                  -- FACTURE / BL / ACHAT / INVENTAIRE / TRANSFERT
    ref_id         TEXT,
    note           TEXT,
    user_id        INTEGER REFERENCES users(id),
    created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_sm_product   ON stock_movements(product_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sm_warehouse ON stock_movements(warehouse_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sm_ref       ON stock_movements(ref_type, ref_id);

-- Inventaires
CREATE TABLE IF NOT EXISTS inventories (
    id            INTEGER PRIMARY KEY,
    warehouse_id  INTEGER NOT NULL REFERENCES warehouses(id),
    status        TEXT    NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','VALIDATED')),
    date          TEXT    NOT NULL,
    created_by    INTEGER REFERENCES users(id),
    created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    validated_at  TEXT
);
CREATE TABLE IF NOT EXISTS inventory_lines (
    id            INTEGER PRIMARY KEY,
    inventory_id  INTEGER NOT NULL REFERENCES inventories(id) ON DELETE CASCADE,
    product_id    INTEGER NOT NULL REFERENCES products(id),
    qty_book      REAL    NOT NULL,
    qty_counted   REAL    NOT NULL,
    diff          REAL    NOT NULL GENERATED ALWAYS AS (qty_counted - qty_book) STORED
);
CREATE INDEX IF NOT EXISTS idx_inv_lines ON inventory_lines(inventory_id);

-- ----------------------------------------------------------------------------
-- 8) DOCUMENTS — Devis / BL / Factures dans UNE table (doc_type)
--    Avantages : n° séquentiel par type, conversions DEVIS->FA, BL->FA,
--    totaux dénormalisés => dashboards < 10 ms sans agrégation.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invoices (
    id                 INTEGER PRIMARY KEY,
    doc_type           TEXT    NOT NULL CHECK (doc_type IN ('DEVIS','BL','FACTURE')),
    number             TEXT    NOT NULL UNIQUE,           -- FA-2026-000012
    client_id          INTEGER NOT NULL REFERENCES clients(id),
    status             TEXT    NOT NULL DEFAULT 'DRAFT'
                       CHECK (status IN ('DRAFT','VALIDATED','PARTIAL','PAID','CANCELED')),
    currency           TEXT    NOT NULL DEFAULT 'DZD'
                       CHECK (currency IN ('DZD','EUR','USD')),
    fx_rate            REAL    NOT NULL DEFAULT 1,        -- 1 si DZD (EUR/USD : taux du jour)
    date               TEXT    NOT NULL,                  -- date du document (locale)
    due_date           TEXT,
    payment_method     TEXT    CHECK (payment_method IN ('CASH','CHECK','TRANSFER','CREDIT','MIXED')),
    -- Totaux (dénorm. — source de vérité recalculée par le moteur fiscal à la validation)
    total_ht           REAL    NOT NULL DEFAULT 0,
    total_discount     REAL    NOT NULL DEFAULT 0,
    total_tva          REAL    NOT NULL DEFAULT 0,
    total_ttc          REAL    NOT NULL DEFAULT 0,
    timbre             REAL    NOT NULL DEFAULT 0,        -- dû uniquement sur les FACTURE
    total_due          REAL    NOT NULL DEFAULT 0,        -- TTC + timbre
    cost_dzd           REAL,                              -- Σ coût des lignes (visible ADMIN uniquement)
    margin_dzd         REAL,                              -- HT(DZD) − coût (visible ADMIN uniquement)
    -- Liens & traçabilité
    source_invoice_id  INTEGER REFERENCES invoices(id),   -- BL -> FACTURE, DEVIS -> FACTURE
    notes              TEXT,
    created_by         INTEGER REFERENCES users(id),
    created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at         TEXT,
    validated_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_inv_number    ON invoices(number);
CREATE INDEX IF NOT EXISTS idx_inv_client    ON invoices(client_id, date);
CREATE INDEX IF NOT EXISTS idx_inv_date      ON invoices(date);
CREATE INDEX IF NOT EXISTS idx_inv_status    ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_inv_type_date ON invoices(doc_type, date);

-- Lignes de document
CREATE TABLE IF NOT EXISTS invoice_items (
    id                INTEGER PRIMARY KEY,
    invoice_id        INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    line_no           INTEGER NOT NULL,
    product_id        INTEGER REFERENCES products(id),     -- NULL = prestation « à la volée »
    name              TEXT    NOT NULL,
    qty               REAL    NOT NULL,
    unit              TEXT,
    unit_price_ht     REAL    NOT NULL,                    -- devise du document
    discount_rate     REAL    NOT NULL DEFAULT 0,          -- 0..1
    discount_amount   REAL    NOT NULL DEFAULT 0,
    tva_rate          REAL    NOT NULL CHECK (tva_rate IN (0, 0.09, 0.19)),
    amount_ht         REAL    NOT NULL,
    amount_tva        REAL    NOT NULL,
    amount_ttc        REAL    NOT NULL,
    cost_unit_dzd     REAL,                                -- coût unitaire au moment de la vente
    UNIQUE (invoice_id, line_no)
);
CREATE INDEX IF NOT EXISTS idx_items_product ON invoice_items(product_id);

-- ----------------------------------------------------------------------------
-- 9) PAIEMENTS (règlements partiels, multi-devise)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payments (
    id              INTEGER PRIMARY KEY,
    invoice_id      INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    client_id       INTEGER NOT NULL REFERENCES clients(id),
    amount          REAL    NOT NULL,
    currency        TEXT    NOT NULL DEFAULT 'DZD'
                    CHECK (currency IN ('DZD','EUR','USD')),
    fx_rate         REAL    NOT NULL DEFAULT 1,
    method          TEXT    NOT NULL CHECK (method IN ('CASH','CHECK','TRANSFER','CREDIT')),
    ref             TEXT,                                  -- n° chèque / n° virement / n° reçu
    date            TEXT    NOT NULL,
    user_id         INTEGER REFERENCES users(id),
    created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_pay_invoice ON payments(invoice_id);
CREATE INDEX IF NOT EXISTS idx_pay_client  ON payments(client_id, date);
CREATE INDEX IF NOT EXISTS idx_pay_date    ON payments(date);

-- ----------------------------------------------------------------------------
-- 10) TAUX DE CHANGE (historique officiel / marché parallèle)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fx_rates (
    id             INTEGER PRIMARY KEY,
    date           TEXT    NOT NULL,
    currency       TEXT    NOT NULL CHECK (currency IN ('EUR','USD')),
    official_rate  REAL    NOT NULL,
    parallel_rate  REAL,
    source         TEXT    NOT NULL DEFAULT 'MANUAL',      -- MANUAL / BCA / BCE
    UNIQUE (date, currency)
);

-- ----------------------------------------------------------------------------
-- 11) NUMÉROTATION SÉQUENTIELLE par type & année  (FA-2026-000001)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS doc_sequences (
    doc_type     TEXT NOT NULL CHECK (doc_type IN ('DEVIS','BL','FACTURE')),
    year         INTEGER NOT NULL,
    last_number  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (doc_type, year)
);

-- ----------------------------------------------------------------------------
-- 12) AUDIT (traçabilité RBAC — qui a fait quoi, quand)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER REFERENCES users(id),
    action      TEXT    NOT NULL,                          -- LOGIN, SAVE_INVOICE, EXPORT_G50...
    entity      TEXT,
    entity_id   TEXT,
    before_json TEXT,
    after_json  TEXT,
    hwid        TEXT,
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_user_date ON audit_log(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_action    ON audit_log(action, created_at);

-- ----------------------------------------------------------------------------
-- 13) ARCHIVAGE G50 (pré-états validés, non modifiables)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS g50_snapshots (
    id            INTEGER PRIMARY KEY,
    period_type   TEXT    NOT NULL CHECK (period_type IN ('MONTH','QUARTER')),
    period_start  TEXT    NOT NULL,
    period_end    TEXT    NOT NULL,
    data_json     TEXT    NOT NULL,
    created_by    INTEGER REFERENCES users(id),
    created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (period_type, period_start, period_end)
);

-- ----------------------------------------------------------------------------
-- TRIGGERS : updated_at automatique (sûr : recursive_triggers OFF par défaut)
-- ----------------------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS trg_products_updated
AFTER UPDATE ON products
BEGIN
  UPDATE products SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_clients_updated
AFTER UPDATE ON clients
BEGIN
  UPDATE clients SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_invoices_updated
AFTER UPDATE ON invoices
BEGIN
  UPDATE invoices SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id;
END;

-- ----------------------------------------------------------------------------
-- SEED (dépliable au 1er lancement)
-- ----------------------------------------------------------------------------
INSERT OR IGNORE INTO warehouses (code, name, is_default) VALUES ('P01', 'Dépôt Principal', 1);
INSERT OR IGNORE INTO company_config (id, company_name) VALUES (1, 'Ma Société SARL');
-- Premier admin : le PIN est haché Argon2id pendant l'assistant d'installation.
INSERT OR IGNORE INTO users (username, full_name, role, pin_hash, can_edit_prices)
VALUES ('admin', 'Gérant', 'ADMIN', 'argon2id$PLACEHOLDER_FIRST_RUN', 1);