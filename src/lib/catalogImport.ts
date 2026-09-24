// ============================================================================
//  Import / Export catalogue (CSV / XLSX) — Excel compatible
//  Colonnes attendues (ligne d'en-tête, séparateur ; ou ,) :
//    sku ; barcode ; name ; category ; unit ; kind ;
//    purchase_price_ht ; purchase_currency ; fx_rate ; extra_costs_dzd ; cost_dzd ;
//    sale_price_ht ; tva_rate ; min_stock
//  (tva_rate : 19 | 9 | 0)
// ============================================================================
import * as XLSX from "xlsx";

export interface CatalogRow {
  sku: string;
  barcode?: string;
  name: string;
  category?: string;
  unit: string;
  kind: "PRODUCT" | "SERVICE";
  purchase_price_ht?: number;
  purchase_currency: "DZD" | "EUR" | "USD";
  fx_rate: number;
  extra_costs_dzd: number;
  cost_dzd: number;
  sale_price_ht: number;
  tva_rate: number;
  min_stock: number;
}

const num = (v: unknown, d = 0): number => {
  const n = typeof v === "string" ? parseFloat(v.replace(",", ".")) : (v as number);
  return Number.isFinite(n) ? n : d;
};

const str = (v: unknown, d = ""): string => (v == null ? d : String(v).trim());

/** Parse un fichier CSV (détection ; ou ,) en lignes catalogue. */
export function parseCatalogCsv(text: string): CatalogRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const sep = (lines[0].match(/;/g)?.length ?? 0) >= (lines[0].match(/,/g)?.length ?? 0) ? ";" : ",";
  const head = lines[0].split(sep).map((h) => h.trim().toLowerCase());
  const idx = (k: string) => head.indexOf(k);
  const has = (k: string) => idx(k) >= 0;

  const rows: CatalogRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i], sep);
    const get = (k: string) => (has(k) ? cells[idx(k)] : undefined);
    const sku = str(get("sku")) || str(get("barcode"));
    if (!sku || !str(get("name"))) continue;
    const tvaPct = num(get("tva_rate"), 19);
    rows.push({
      sku,
      barcode: str(get("barcode")) || undefined,
      name: str(get("name")),
      category: str(get("category")) || undefined,
      unit: str(get("unit")) || "U",
      kind: str(get("kind"), "PRODUCT").toUpperCase() === "SERVICE" ? "SERVICE" : "PRODUCT",
      purchase_price_ht: has("purchase_price_ht") ? num(get("purchase_price_ht")) : undefined,
      purchase_currency: (str(get("purchase_currency"), "DZD").toUpperCase() as "DZD") || "DZD",
      fx_rate: num(get("fx_rate"), 1),
      extra_costs_dzd: num(get("extra_costs_dzd")),
      cost_dzd: num(get("cost_dzd")),
      sale_price_ht: num(get("sale_price_ht")),
      tva_rate: tvaPct === 9 ? 0.09 : tvaPct === 0 ? 0 : 0.19,
      min_stock: num(get("min_stock")),
    });
  }
  return rows;
}

function splitCsvLine(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (const ch of line) {
    if (ch === '"') inQ = !inQ;
    else if (ch === sep && !inQ) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** Parse un fichier XLSX (1re feuille) en lignes catalogue. */
export function parseCatalogXlsx(data: ArrayBuffer): CatalogRow[] {
  const wb = XLSX.read(data, { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: "" });
  return json
    .map((r) => {
      const key = (k: string) => Object.keys(r).find((x) => x.toLowerCase() === k) ?? k;
      const get = (k: string) => r[key(k)];
      const sku = str(get("sku")) || str(get("barcode"));
      const tvaPct = num(get("tva_rate"), 19);
      return {
        sku,
        barcode: str(get("barcode")) || undefined,
        name: str(get("name")),
        category: str(get("category")) || undefined,
        unit: str(get("unit")) || "U",
        kind: str(get("kind"), "PRODUCT").toUpperCase() === "SERVICE" ? ("SERVICE" as const) : ("PRODUCT" as const),
        purchase_price_ht: num(get("purchase_price_ht")) || undefined,
        purchase_currency: "DZD" as const,
        fx_rate: num(get("fx_rate"), 1),
        extra_costs_dzd: num(get("extra_costs_dzd")),
        cost_dzd: num(get("cost_dzd")),
        sale_price_ht: num(get("sale_price_ht")),
        tva_rate: tvaPct === 9 ? 0.09 : tvaPct === 0 ? 0 : 0.19,
        min_stock: num(get("min_stock")),
      } as CatalogRow;
    })
    .filter((r) => r.sku && r.name);
}

/** Export CSV du catalogue courant (à télécharger). */
export function catalogToCsv(rows: Array<{
  sku: string; barcode: string | null; name: string; unit: string; kind: string;
  sale_price_ht: number; tva_rate: number; cost_dzd: number; stock: number;
}>): string {
  const head = "sku;barcode;name;unit;kind;sale_price_ht;tva_rate;cost_dzd;stock";
  const body = rows
    .map((r) =>
      [r.sku, r.barcode ?? "", r.name, r.unit, r.kind,
        r.sale_price_ht.toFixed(2), (r.tva_rate * 100).toFixed(0),
        r.cost_dzd.toFixed(2), r.stock.toFixed(0)]
        .map((v) => (/[;"\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v))
        .join(";"),
    )
    .join("\r\n");
  return [head, body].join("\r\n");
}
