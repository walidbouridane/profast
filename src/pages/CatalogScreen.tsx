// ============================================================================
//  Catalogue (ADMIN) — Import CSV/XLSX, export, aperçu
// ============================================================================
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import {
  catalogToCsv,
  parseCatalogCsv,
  parseCatalogXlsx,
  type CatalogRow,
} from "../lib/catalogImport";
import type { ProductLite } from "../types";

const HEADERS =
  "sku;barcode;name;category;unit;kind;purchase_price_ht;purchase_currency;fx_rate;extra_costs_dzd;cost_dzd;sale_price_ht;tva_rate;min_stock";

export default function CatalogScreen({
  products,
  onProducts,
}: {
  products: ProductLite[];
  onProducts: (p: ProductLite[]) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // template de départ
    const template = [HEADERS, "EX-001;;Ciment 50kg;Matériaux;U;PRODUCT;780;DZD;1;0;780;1250;19;10"];
    download("modele_catalogue.csv", template.join("\r\n"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onFile = async (f: File) => {
    setError(null);
    try {
      const rows: CatalogRow[] =
        f.name.toLowerCase().endsWith(".xlsx") || f.name.toLowerCase().endsWith(".xls")
          ? parseCatalogXlsx(await f.arrayBuffer())
          : parseCatalogCsv(await f.text());
      if (rows.length === 0) throw new Error("Aucune ligne valide trouvée (colonnes : " + HEADERS.split(";").slice(0, 3).join(", ") + "…)");
      const updated = await api.upsertProducts(rows as unknown as unknown[]);
      onProducts(updated);
      setMsg(`${rows.length} article(s) importé(s) ✓`);
      setTimeout(() => setMsg(null), 3000);
    } catch (e) {
      setError(String(e));
    }
  };

  const exportAll = () => {
    download("catalogue_profast.csv", catalogToCsv(products));
  };

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4">
      <div className="flex flex-wrap items-center gap-3 rounded-xl bg-white p-4 shadow-sm">
        <h3 className="text-sm font-semibold text-slate-700">Catalogue ({products.length} articles)</h3>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,.xlsx,.xls"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onFile(f);
            e.target.value = "";
          }}
        />
        <button onClick={() => fileRef.current?.click()}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700">
          ⬆ Importer CSV / XLSX
        </button>
        <button onClick={exportAll}
          className="rounded-lg border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50">
          ⬇ Exporter le catalogue
        </button>
        <p className="w-full text-xs text-slate-400">
          Colonnes : {HEADERS}
        </p>
      </div>

      {msg && <p className="rounded-lg bg-emerald-50 px-4 py-2 text-sm text-emerald-700">{msg}</p>}
      {error && <p className="rounded-lg bg-red-50 px-4 py-2 text-sm text-red-700">⚠ {error}</p>}

      <div className="max-h-[60vh] overflow-auto rounded-xl bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-slate-50 text-xs uppercase text-slate-400">
            <tr>
              <th className="px-4 py-2 text-left">Réf</th>
              <th className="px-2 py-2 text-left">Désignation</th>
              <th className="px-2 py-2 text-left">Type</th>
              <th className="px-2 py-2 text-right">PV HT</th>
              <th className="px-2 py-2 text-right">TVA</th>
              <th className="px-2 py-2 text-right">Stock</th>
            </tr>
          </thead>
          <tbody>
            {products.map((p) => (
              <tr key={p.id} className="border-t border-slate-100">
                <td className="px-4 py-1.5 font-mono text-xs text-slate-400">{p.sku}</td>
                <td className="px-2 py-1.5">{p.name}</td>
                <td className="px-2 py-1.5 text-xs text-slate-500">{p.kind === "SERVICE" ? "Prestation" : "Produit"}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">
                  {new Intl.NumberFormat("fr-DZ", { style: "currency", currency: "DZD" }).format(p.sale_price_ht)}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums">{(p.tva_rate * 100).toFixed(0)} %</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{p.kind === "PRODUCT" ? p.stock : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function download(filename: string, content: string) {
  const blob = new Blob(["\uFEFF" + content], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
