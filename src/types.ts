// ============================================================================
//  ProFast Facture — Types partagés webview ⇄ main-process (miroirs des
//  structs Rust de src-tauri/src/db.rs / license/verify.rs)
// ============================================================================

export type Role = "ADMIN" | "COMMERCIAL" | "STOREKEEPER" | "ACCOUNTANT";
export type DocType = "DEVIS" | "BL" | "FACTURE";
export type TvaRate = 0 | 0.09 | 0.19;
export type PaymentMethod = "CASH" | "CHECK" | "TRANSFER" | "CREDIT" | "MIXED";

export interface LicenseStatus {
  hwid: string;
  active: boolean;
  plan: string | null;
  serial: string | null;
  expires_at: number | null;
  demo_remaining: number; // u32::MAX si licence active
  error: string | null;
}

export interface UserLite {
  id: number;
  username: string;
  full_name: string;
  role: Role;
}

export interface UserSession {
  id: number;
  full_name: string;
  role: Role;
  can_edit_prices: boolean;
  must_change_pin: boolean;
}

export interface ClientLite {
  id: number;
  name: string;
  nif: string;
  phone: string;
}

export interface ProductLite {
  id: number;
  sku: string;
  barcode: string | null;
  name: string;
  unit: string;
  kind: "PRODUCT" | "SERVICE";
  sale_price_ht: number;
  tva_rate: number;
  cost_dzd: number; // 0 pour les rôles sans droit (masqué côté serveur)
  stock: number;
}

export interface CompanyConfig {
  company_name: string;
  legal_form: string | null;
  nif: string | null;
  nis: string | null;
  rc: string | null;
  ai: string | null;
  address: string | null;
  wilaya: string | null;
  phone: string | null;
  email: string | null;
  iban: string | null;
  bank_name: string | null;
  timbre_rate: number;
  timbre_min: number;
  timbre_max: number;
  timbre_receipt_min: number;
  stamp_png_path: string | null;
  signature_png_path: string | null;
  logo_png_path: string | null;
  whatsapp_footer: string | null;
}

export interface PreloadData {
  clients: ClientLite[];
  products: ProductLite[];
  users: UserLite[];
  config: CompanyConfig;
}

// --- Miroirs de fiscal.rs ----------------------------------------------------

export interface TvaRateLine {
  rate: number;
  base: number;
  tva: number;
}

export interface Totals {
  total_ht: number;
  total_discount: number;
  total_tva: number;
  total_ttc: number;
  tva_by_rate: TvaRateLine[];
  timbre: number;
  total_due: number;
  cost_dzd: number;
  margin_dzd: number;
  margin_pct: number;
}

export interface InvoiceItemPayload {
  product_id: number | null;
  name: string;
  qty: number;
  unit: string;
  unit_price_ht: number;
  discount_rate: number; // 0..1
  tva_rate: number;
}

export interface NewInvoice {
  doc_type: DocType;
  client_id: number;
  date: string; // YYYY-MM-DD
  payment_method: PaymentMethod;
  currency: "DZD" | "EUR" | "USD";
  fx_rate: number;
  notes: string | null;
  items: InvoiceItemPayload[];
}

export interface SavedInvoice {
  id: number;
  number: string;
  totals: Totals;
  demo_remaining: number;
}

export interface RateAgg {
  rate: number;
  base: number;
  tva: number;
}

export interface G50Raw {
  period_start: string;
  period_end: string;
  sales: RateAgg[];
  purchases: RateAgg[];
  purchases_non_deductible: RateAgg[];
}

export interface Dashboard {
  ca_month: number;
  tva_month: number;
  unpaid: number;
  low_stock: number;
  last_docs: Array<{
    number: string;
    doc_type: string;
    client: string;
    date: string;
    total_ttc: number;
    status: string;
  }>;
  top_products: Array<{ name: string; qty: number; revenue: number }>;
}

export interface StockRow {
  product_id: number;
  sku: string;
  name: string;
  unit: string;
  qty: number;
  min_stock: number;
  cost_dzd: number;
}

export interface MovementRow {
  id: number;
  date: string;
  product: string;
  kind: string;
  qty: number;
  warehouse: string;
  ref_number: string | null;
  user: string | null;
}

export interface CanCreate {
  ok: boolean;
  remaining: number;
}

// --- ACHATS / FOURNISSEURS / CHANGE ------------------------------------------

export interface SupplierLite {
  id: number;
  code: string;
  name: string;
  nif: string | null;
}

export interface FxRow {
  id: number;
  date: string;
  currency: string;
  official_rate: number;
  parallel_rate: number | null;
}

export interface PurchaseRow {
  id: number;
  supplier: string;
  product: string | null;
  doc_number: string | null;
  date: string;
  qty: number;
  unit_price_ht: number;
  base_ht: number;
  tva_rate: number;
  tva: number;
  ttc: number;
  currency: string;
  fx_rate: number;
  deductible: boolean;
  extra_costs_dzd: number;
  landed_cost_dzd: number;
}

export interface PurchaseInput {
  supplier_id: number;
  product_id: number | null;
  doc_number: string | null;
  date: string;
  qty: number;
  unit_price_ht: number;
  tva_rate: number;
  currency: "DZD" | "EUR" | "USD";
  fx_rate: number;
  deductible: boolean;
  extra_costs_dzd: number;
  note: string | null;
}

// --- INVENTAIRES ---------------------------------------------------------------

export interface InventoryLineRow {
  id: number;
  product_id: number;
  sku: string;
  name: string;
  unit: string;
  qty_book: number;
  qty_counted: number;
}

export interface InventoryInfo {
  id: number;
  warehouse_id: number;
  status: "DRAFT" | "VALIDATED";
  date: string;
  created_at: string;
  validated_at: string | null;
  lines: InventoryLineRow[];
}

export interface InventorySummary {
  id: number;
  warehouse: string;
  status: "DRAFT" | "VALIDATED";
  date: string;
  line_count: number;
  validated_at: string | null;
}

export interface InventoryAdjustment {
  product_id: number;
  name: string;
  book: number;
  counted: number;
  diff: number;
  value_dzd: number;
}

export interface InventoryResult {
  id: number;
  adjustments: InventoryAdjustment[];
  book_value: number;
  counted_value: number;
  variance_pct: number;
}

// --- UTILISATEURS (ADMIN) --------------------------------------------------------

export interface AdminUser {
  id: number;
  username: string;
  full_name: string;
  role: Role;
  can_edit_prices: boolean;
  is_active: boolean;
}
