// ============================================================================
//  ProFast Facture — Bridge webview ⇄ main-process (Tauri invoke, typé)
// ============================================================================
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-shell";
import type {
  CanCreate,
  Dashboard,
  G50Raw,
  LicenseStatus,
  MovementRow,
  NewInvoice,
  PreloadData,
  ProductLite,
  SavedInvoice,
  StockRow,
  UserLite,
  UserSession,
} from "./types";

export const api = {
  // --- Licence ---
  licenseStatus: () => invoke<LicenseStatus>("license_status"),
  activate: (key: string) => invoke<LicenseStatus>("activate_license", { key }),
  canCreate: () => invoke<CanCreate>("can_create_invoice"),

  // --- Auth PIN ---
  login: (username: string, pin: string) =>
    invoke<UserSession>("auth_commands_login", { username, pin }),
  setupAdmin: (username: string, fullName: string, pin: string) =>
    invoke<void>("auth_commands_setup_admin", {
      username,
      fullName,
      pin,
    }),

  // --- Catalogue ---
  preload: () => invoke<PreloadData>("preload_catalog"),
  upsertProducts: (rows: unknown[]) =>
    invoke<ProductLite[]>("upsert_products", { rows }),

  // --- Facturation ---
  nextNumber: (docType: string) => invoke<string>("next_number", { docType }),
  saveInvoice: (doc: NewInvoice) => invoke<SavedInvoice>("save_invoice", { doc }),

  // --- G50 ---
  g50Report: (periodType: string, year: number, month: number) =>
    invoke<G50Raw>("g50_report", { periodType, year, month }),
  g50SaveSnapshot: (periodType: string, year: number, month: number, dataJson: string) =>
    invoke<void>("g50_save_snapshot", { periodType, year, month, dataJson }),

  // --- Stock ---
  stockOverview: () => invoke<StockRow[]>("stock_overview"),
  stockMovements: () => invoke<MovementRow[]>("stock_movements"),
  stockMove: (productId: number, delta: number, rtype: string, note?: string) =>
    invoke<void>("stock_move", { productId, delta, rtype, note }),
  transferStock: (productId: number, from: number, to: number, qty: number) =>
    invoke<void>("transfer_stock", {
      productId,
      fromWarehouse: from,
      toWarehouse: to,
      qty,
    }),

  // --- Dashboard ---
  dashboard: () => invoke<Dashboard>("dashboard_data"),

  // --- Achats / fournisseurs / change ---
  suppliers: () => invoke<import("./types").SupplierLite[]>("suppliers_list"),
  createSupplier: (name: string, nif: string) =>
    invoke<import("./types").SupplierLite>("create_supplier", { name, nif }),
  fxRecent: (currency: string) => invoke<import("./types").FxRow[]>("fx_recent", { currency }),
  recordFxRate: (
    date: string,
    currency: string,
    officialRate: number,
    parallelRate: number | null,
    source: string,
  ) =>
    invoke<void>("record_fx_rate", {
      date,
      currency,
      officialRate,
      parallelRate,
      source,
    }),
  recordPurchase: (purchase: import("./types").PurchaseInput) =>
    invoke<import("./types").PurchaseRow>("record_purchase", { purchase }),
  purchasesList: (start: string, end: string) =>
    invoke<import("./types").PurchaseRow[]>("purchases_list", { start, end }),

  // --- Inventaires ---
  inventoryStart: (warehouseId: number) =>
    invoke<import("./types").InventoryInfo>("inventory_start", { warehouseId }),
  inventoryGet: (id: number) =>
    invoke<import("./types").InventoryInfo>("inventory_get", { id }),
  inventoriesList: () =>
    invoke<import("./types").InventorySummary[]>("inventories_list"),
  inventoryValidate: (
    id: number,
    counts: Array<{ product_id: number; qty: number }>,
  ) => invoke<import("./types").InventoryResult>("inventory_validate", { id, counts }),

  // --- Utilisateurs & PIN ---
  usersAdminList: () => invoke<import("./types").AdminUser[]>("users_admin_list"),
  userCreate: (
    username: string,
    fullName: string,
    role: string,
    pin: string,
    canEditPrices: boolean,
  ) =>
    invoke<import("./types").AdminUser>("user_create", {
      username,
      fullName,
      role,
      pin,
      canEditPrices,
    }),
  userSetActive: (id: number, active: boolean) =>
    invoke<void>("user_set_active", { id, active }),
  userSetPriceRights: (id: number, can: boolean) =>
    invoke<void>("user_set_price_rights", { id, can }),
  changePin: (oldPin: string, newPin: string) =>
    invoke<void>("change_pin", { oldPin, newPin }),

  // --- Fichiers locaux ---
  readLocalImage: (path: string) => invoke<string>("read_local_image", { path }),
  pdfOutDir: () => invoke<string>("pdf_out_dir"),
  warehouses: () =>
    invoke<Array<{ id: number; code: string; name: string; is_default: boolean }>>(
      "warehouses_list",
    ),
  needsSetup: () => invoke<boolean>("auth_needs_setup"),

  // --- PDF local ---
  printPdf: async (html: string, outPath: string) => {
    await invoke<string>("print_pdf", { html, outPath });
    // Ouvre le PDF dans la visionneuse système (100 % local)
    await open(outPath).catch(() => {});
  },
};

export type { UserLite };
