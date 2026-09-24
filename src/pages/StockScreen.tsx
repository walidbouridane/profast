// ============================================================================
//  Stock & Dépôts (ADMIN / STOREKEEPER)
//  • Position par article (alerte sous stock minimum)
//  • Entrées / sorties manuelles (+ mouvements audités)
//  • Transferts entre dépôts
// ============================================================================
import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { MovementRow, StockRow } from "../types";

const KIND_FR: Record<string, string> = {
  IN: "Entrée", OUT: "Sortie", ADJUST: "Ajustement",
  TRANSFER_IN: "Transfert ↘", TRANSFER_OUT: "Transfert ↗",
};

export default function StockScreen({ canSeeCost }: { canSeeCost: boolean }) {
  const [rows, setRows] = useState<StockRow[]>([]);
  const [moves, setMoves] = useState<MovementRow[]>([]);
  const [warehouses, setWarehouses] = useState<Array<{ id: number; code: string; name: string; is_default: boolean }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  // Transfert
  const [tProduct, setTProduct] = useState<number>(0);
  const [tFrom, setTFrom] = useState(1);
  const [tTo, setTTo] = useState(2);
  const [tQty, setTQty] = useState("1");

  const refresh = useCallback(() => {
    void api.stockOverview().then(setRows).catch((e) => setError(String(e)));
    void api.stockMovements().then(setMoves).catch(() => {});
    void api.warehouses().then(setWarehouses).catch(() => {});
  }, []);

  useEffect(refresh, [refresh]);

  const flash = (m: string) => {
    setMsg(m);
    setTimeout(() => setMsg(null), 2000);
  };

  const move = async (productId: number, delta: number) => {
    try {
      await api.stockMove(productId, delta, delta > 0 ? "IN" : "OUT", "Saisie magasin");
      refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  const transfer = async () => {
    const qty = parseFloat(tQty.replace(",", "."));
    if (!Number.isFinite(qty) || qty <= 0) return;
    try {
      await api.transferStock(tProduct, tFrom, tTo, qty);
      flash("Transfert effectué ✓");
      refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4">
      {error && <p className="rounded-lg bg-red-50 px-4 py-2 text-sm text-red-700">⚠ {error}</p>}
      {msg && <p className="rounded-lg bg-emerald-50 px-4 py-2 text-sm text-emerald-700">{msg}</p>}

      <div className="rounded-xl bg-white shadow-sm">
        <div className="border-b border-slate-100 px-4 py-3">
          <h3 className="text-sm font-semibold text-slate-700">Position du stock (dépôt principal)</h3>
        </div>
        <div className="max-h-96 overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-slate-50 text-xs uppercase text-slate-400">
              <tr>
                <th className="px-4 py-2 text-left">Article</th>
                <th className="px-2 py-2 text-right">Qté</th>
                <th className="px-2 py-2 text-right">Min</th>
                {canSeeCost && <th className="px-2 py-2 text-right">Coût posé</th>}
                <th className="px-2 py-2 text-center">Mouvements</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.product_id} className={`border-t border-slate-100 ${r.qty < r.min_stock ? "bg-red-50/50" : ""}`}>
                  <td className="px-4 py-1.5">
                    <span className="font-mono text-xs text-slate-400">{r.sku}</span>
                    <span className="ml-2">{r.name}</span>
                  </td>
                  <td className={`px-2 py-1.5 text-right font-semibold tabular-nums ${r.qty < r.min_stock ? "text-red-600" : ""}`}>
                    {r.qty} {r.unit}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-slate-400">{r.min_stock}</td>
                  {canSeeCost && (
                    <td className="px-2 py-1.5 text-right tabular-nums text-slate-500">
                      {new Intl.NumberFormat("fr-DZ", { style: "currency", currency: "DZD" }).format(r.cost_dzd)}
                    </td>
                  )}
                  <td className="px-2 py-1.5 text-center">
                    <button onClick={() => void move(r.product_id, 1)}
                      className="rounded bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700 hover:bg-emerald-100">+1</button>
                    <button onClick={() => void move(r.product_id, -1)}
                      className="ml-1 rounded bg-red-50 px-2 py-0.5 text-xs text-red-700 hover:bg-red-100">−1</button>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={canSeeCost ? 5 : 4} className="py-8 text-center text-slate-400">Aucun produit en stock</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Transfert entre dépôts */}
        <div className="rounded-xl bg-white p-4 shadow-sm">
          <h3 className="text-sm font-semibold text-slate-700">Transfert entre dépôts</h3>
          <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
            <select value={tProduct} onChange={(e) => setTProduct(Number(e.target.value))}
              className="col-span-2 rounded-lg border border-slate-300 px-2 py-1.5">
              <option value={0}>— Article —</option>
              {rows.map((r) => <option key={r.product_id} value={r.product_id}>{r.name} ({r.qty})</option>)}
            </select>
            <select value={tFrom} onChange={(e) => setTFrom(Number(e.target.value))}
              className="rounded-lg border border-slate-300 px-2 py-1.5">
              {warehouses.map((w) => <option key={w.id} value={w.id}>De : {w.name}</option>)}
            </select>
            <select value={tTo} onChange={(e) => setTTo(Number(e.target.value))}
              className="rounded-lg border border-slate-300 px-2 py-1.5">
              {warehouses.map((w) => <option key={w.id} value={w.id}>Vers : {w.name}</option>)}
            </select>
            <input value={tQty} onChange={(e) => setTQty(e.target.value)} placeholder="Quantité"
              className="rounded-lg border border-slate-300 px-2 py-1.5" />
            <button onClick={() => void transfer()} disabled={!tProduct || tFrom === tTo}
              className="rounded-lg bg-blue-600 px-3 py-1.5 font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
              Transférer
            </button>
          </div>
        </div>

        {/* Journal des mouvements */}
        <div className="rounded-xl bg-white p-4 shadow-sm">
          <h3 className="text-sm font-semibold text-slate-700">Derniers mouvements (audités)</h3>
          <div className="mt-2 max-h-56 overflow-auto">
            <table className="w-full text-xs">
              <tbody>
                {moves.map((m) => (
                  <tr key={m.id} className="border-t border-slate-100">
                    <td className="py-1.5 text-slate-400">{m.date.slice(0, 16).replace("T", " ")}</td>
                    <td className="py-1.5 font-medium">{m.product}</td>
                    <td className="py-1.5">{KIND_FR[m.kind] ?? m.kind}</td>
                    <td className={`py-1.5 text-right tabular-nums ${m.qty > 0 ? "text-emerald-700" : "text-red-600"}`}>
                      {m.qty > 0 ? `+${m.qty}` : m.qty}
                    </td>
                    <td className="py-1.5 text-right text-slate-400">{m.ref_number ?? m.user ?? ""}</td>
                  </tr>
                ))}
                {moves.length === 0 && (
                  <tr><td className="py-6 text-center text-slate-400">Aucun mouvement</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
