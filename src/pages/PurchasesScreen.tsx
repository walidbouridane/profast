// ============================================================================
//  Achats & Fournisseurs (ADMIN saisit · ACCOUNTANT lecture seule)
//  • Saisie d'une ligne d'achat (multi-devise EUR/USD, taux officiel/parallèle)
//  • Coût posé DZD recalculé automatiquement (px × fx + frais/douane)
//  • Alimente la TVA déductible du pré-état G50 + stock + coût du produit
// ============================================================================
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { FxRow, PurchaseInput, PurchaseRow, SupplierLite } from "../types";

const fmt = (n: number) =>
  new Intl.NumberFormat("fr-DZ", { style: "currency", currency: "DZD" }).format(n);

const today = () => new Date().toISOString().slice(0, 10);
const monthStart = () => today().slice(0, 8) + "01";

export default function PurchasesScreen({
  canEdit,
  canSeeCost,
  products,
}: {
  canEdit: boolean;
  canSeeCost: boolean;
  products: Array<{ id: number; name: string; sku: string; kind: string }>;
}) {
  const [suppliers, setSuppliers] = useState<SupplierLite[]>([]);
  const [fx, setFx] = useState<FxRow[]>([]);
  const [rows, setRows] = useState<PurchaseRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  // Formulaire
  const [supplierId, setSupplierId] = useState(0);
  const [newSupplier, setNewSupplier] = useState("");
  const [productId, setProductId] = useState(0);
  const [docNumber, setDocNumber] = useState("");
  const [date, setDate] = useState(today());
  const [qty, setQty] = useState("1");
  const [price, setPrice] = useState("");
  const [currency, setCurrency] = useState<"DZD" | "EUR" | "USD">("DZD");
  const [fxRate, setFxRate] = useState("145");
  const [fxSource, setFxSource] = useState<"OFFICIEL" | "PARALLELE">("OFFICIEL");
  const [tva, setTva] = useState<"0" | "9" | "19">("19");
  const [extra, setExtra] = useState("");
  const [deductible, setDeductible] = useState(true);

  const refresh = useCallback(() => {
    void api.suppliers().then(setSuppliers).catch(() => {});
    void api.fxRecent("EUR").then(setFx).catch(() => {});
    void api
      .purchasesList(monthStart(), today())
      .then(setRows)
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(refresh, [refresh]);

  // Derniers taux relevés (boutons de pré-remplissage)
  const lastFx = useMemo(() => fx[0] ?? null, [fx]);

  const flash = (m: string) => {
    setMsg(m);
    setTimeout(() => setMsg(null), 2500);
  };

  const q = parseFloat(qty.replace(",", ".")) || 0;
  const p = parseFloat(price.replace(",", ".")) || 0;
  const e = parseFloat(extra.replace(",", ".")) || 0;
  const f = parseFloat(fxRate.replace(",", ".")) || 1;
  const base = q * p;
  const landedUnit = currency === "DZD" ? p + e / (q || 1) : p * f + e / (q || 1);

  const submit = async () => {
    setError(null);
    if (supplierId === 0) return setError("Sélectionnez (ou créez) un fournisseur");
    if (q <= 0 || p <= 0) return setError("Quantité et prix doivent être > 0");
    const input: PurchaseInput = {
      supplier_id: supplierId,
      product_id: productId || null,
      doc_number: docNumber || null,
      date,
      qty: q,
      unit_price_ht: p,
      tva_rate: Number(tva) / 100,
      currency,
      fx_rate: currency === "DZD" ? 1 : f,
      deductible,
      extra_costs_dzd: e,
      note: null,
    };
    try {
      await api.recordPurchase(input);
      flash(
        `Achat enregistré — coût posé : ${fmt(landedUnit)}/unité (fx ${fxSource === "OFFICIEL" ? "officiel" : "parallèle"})`,
      );
      setQty("1"); setPrice(""); setDocNumber(""); setExtra("");
      refresh();
    } catch (err) {
      setError(String(err));
    }
  };

  const addSupplier = async () => {
    if (!newSupplier.trim()) return;
    try {
      const s = await api.createSupplier(newSupplier.trim(), "");
      setNewSupplier("");
      setSupplierId(s.id);
      flash(`Fournisseur « ${s.name} » créé (${s.code})`);
      refresh();
    } catch (err) {
      setError(String(err));
    }
  };

  const saveRate = async () => {
    try {
      const parallel = fxSource === "PARALLELE" ? f : null;
      await api.recordFxRate(date, currency === "DZD" ? "EUR" : currency, f, parallel, "MANUAL");
      flash("Taux de change enregistré");
      refresh();
    } catch (err) {
      setError(String(err));
    }
  };

  const monthTva = rows.reduce((a, r) => a + (r.deductible ? r.tva : 0), 0);
  const monthBase = rows.reduce((a, r) => a + r.base_ht, 0);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4">
      {error && <p className="rounded-lg bg-red-50 px-4 py-2 text-sm text-red-700">⚠ {error}</p>}
      {msg && <p className="rounded-lg bg-emerald-50 px-4 py-2 text-sm text-emerald-700">{msg}</p>}

      {canEdit && (
        <div className="rounded-xl bg-white p-4 shadow-sm">
          <h3 className="text-sm font-semibold text-slate-700">Saisir un achat (facture fournisseur)</h3>
          <div className="mt-3 grid gap-2 text-sm md:grid-cols-4">
            <label className="md:col-span-2">
              <span className="text-xs text-slate-500">Fournisseur</span>
              <div className="mt-1 flex gap-1">
                <select value={supplierId} onChange={(e) => setSupplierId(Number(e.target.value))}
                  className="w-full rounded-lg border border-slate-300 px-2 py-1.5">
                  <option value={0}>— Sélectionner —</option>
                  {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                <input value={newSupplier} onChange={(e) => setNewSupplier(e.target.value)}
                  placeholder="Nouveau…" className="w-28 rounded-lg border border-slate-300 px-2 py-1.5" />
                <button onClick={() => void addSupplier()}
                  className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs hover:bg-slate-50">+</button>
              </div>
            </label>
            <label className="md:col-span-2">
              <span className="text-xs text-slate-500">Article (facultatif — met à jour coût + stock)</span>
              <select value={productId} onChange={(e) => setProductId(Number(e.target.value))}
                className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5">
                <option value={0}>— Aucune (frais pur) —</option>
                {products.filter((p) => p.kind === "PRODUCT").map((p) => (
                  <option key={p.id} value={p.id}>{p.sku} — {p.name}</option>
                ))}
              </select>
            </label>
            <label>
              <span className="text-xs text-slate-500">N° facture fournisseur</span>
              <input value={docNumber} onChange={(e) => setDocNumber(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5" placeholder="FO-8842" />
            </label>
            <label>
              <span className="text-xs text-slate-500">Date</span>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5" />
            </label>
            <label>
              <span className="text-xs text-slate-500">Quantité</span>
              <input value={qty} onChange={(e) => setQty(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5" />
            </label>
            <label>
              <span className="text-xs text-slate-500">PU HT ({currency})</span>
              <input value={price} onChange={(e) => setPrice(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5" placeholder="12,50" />
            </label>
            <label>
              <span className="text-xs text-slate-500">Devise</span>
              <select value={currency} onChange={(e) => setCurrency(e.target.value as "DZD")}
                className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5">
                <option value="DZD">DZD</option>
                <option value="EUR">EUR</option>
                <option value="USD">USD</option>
              </select>
            </label>
            {currency !== "DZD" && (
              <label>
                <span className="text-xs text-slate-500">
                  Taux de change {fxSource === "OFFICIEL" ? "(officiel)" : "(parallèle)"}
                  {lastFx && (
                    <button onClick={() => setFxRate(String(fxSource === "OFFICIEL" ? lastFx.official_rate : (lastFx.parallel_rate ?? lastFx.official_rate)))}
                      className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] hover:bg-slate-200">
                      dernier : {fxSource === "OFFICIEL" ? lastFx.official_rate : lastFx.parallel_rate ?? lastFx.official_rate}
                    </button>
                  )}
                </span>
                <div className="mt-1 flex gap-1">
                  <input value={fxRate} onChange={(e) => setFxRate(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-2 py-1.5" />
                  <select value={fxSource} onChange={(e) => setFxSource(e.target.value as "OFFICIEL")}
                    className="rounded-lg border border-slate-300 px-1 text-xs">
                    <option value="OFFICIEL">Off.</option>
                    <option value="PARALLELE">Parallèle</option>
                  </select>
                  <button onClick={() => void saveRate()}
                    className="rounded-lg border border-slate-300 px-2 text-xs hover:bg-slate-50">💾</button>
                </div>
              </label>
            )}
            <label>
              <span className="text-xs text-slate-500">TVA</span>
              <select value={tva} onChange={(e) => setTva(e.target.value as "19")}
                className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5">
                <option value="19">19 %</option>
                <option value="9">9 %</option>
                <option value="0">0 %</option>
              </select>
            </label>
            <label>
              <span className="text-xs text-slate-500">Frais / douane (DZD, total)</span>
              <input value={extra} onChange={(e) => setExtra(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5" placeholder="0" />
            </label>
            <label className="flex items-end gap-2 pb-1.5">
              <input type="checkbox" checked={deductible} onChange={(e) => setDeductible(e.target.checked)} />
              <span className="text-xs text-slate-600">TVA déductible (facture complète)</span>
            </label>
          </div>

          <div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-3">
            <p className="text-sm text-slate-600">
              Base HT : <strong>{(currency === "DZD" ? "" : currency + " ") + base.toFixed(2)}</strong>
              {" · "}TVA : <strong>{(base * Number(tva) / 100).toFixed(2)} DA</strong>
              {canSeeCost && (
                <>
                  {" · "}Coût posé : <strong className="text-blue-700">{fmt(landedUnit)}/unité</strong>
                </>
              )}
            </p>
            <button onClick={() => void submit()}
              className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-semibold text-white hover:bg-blue-700">
              Enregistrer l'achat
            </button>
          </div>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-xl bg-white p-4 shadow-sm">
          <p className="text-xs font-semibold uppercase text-slate-500">Achats du mois (base HT)</p>
          <p className="mt-1 text-xl font-bold tabular-nums text-slate-800">{fmt(monthBase)}</p>
        </div>
        <div className="rounded-xl bg-white p-4 shadow-sm">
          <p className="text-xs font-semibold uppercase text-slate-500">TVA déductible (mois)</p>
          <p className="mt-1 text-xl font-bold tabular-nums text-emerald-700">{fmt(monthTva)}</p>
        </div>
        <div className="rounded-xl bg-white p-4 shadow-sm">
          <p className="text-xs font-semibold uppercase text-slate-500">Lignes ce mois</p>
          <p className="mt-1 text-xl font-bold tabular-nums text-slate-800">{rows.length}</p>
        </div>
      </div>

      <div className="max-h-[48vh] overflow-auto rounded-xl bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-slate-50 text-xs uppercase text-slate-400">
            <tr>
              <th className="px-3 py-2 text-left">Date</th>
              <th className="px-2 py-2 text-left">Fournisseur</th>
              <th className="px-2 py-2 text-left">Article / n° doc</th>
              <th className="px-2 py-2 text-right">Qté</th>
              <th className="px-2 py-2 text-right">Base HT</th>
              <th className="px-2 py-2 text-right">TVA</th>
              {canSeeCost && <th className="px-2 py-2 text-right">Coût posé/u</th>}
              <th className="px-2 py-2 text-center">Déd.</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-slate-100">
                <td className="px-3 py-1.5 text-slate-500">{r.date}</td>
                <td className="px-2 py-1.5">{r.supplier}</td>
                <td className="max-w-0 truncate px-2 py-1.5 text-slate-600">
                  {r.product ?? "—"} {r.doc_number && <span className="text-xs text-slate-400">· {r.doc_number}</span>}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums">{r.qty}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{r.base_ht.toFixed(2)} {r.currency}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{r.tva.toFixed(2)}</td>
                {canSeeCost && <td className="px-2 py-1.5 text-right tabular-nums text-blue-700">{fmt(r.landed_cost_dzd)}</td>}
                <td className="px-2 py-1.5 text-center">{r.deductible ? "✅" : "⚠️"}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={canSeeCost ? 8 : 7} className="py-8 text-center text-slate-400">Aucun achat ce mois-ci</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
