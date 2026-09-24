// ============================================================================
//  Inventaires physiques (ADMIN / STOREKEEPER)
//  • Démarrage (copie les quantités théoriques)
//  • Saisie des quantités comptées, écarts surlignés en direct
//  • Validation : ajustements appliqués au stock + mouvements ADJUST audités
// ============================================================================
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { InventoryInfo, InventoryResult, InventorySummary } from "../types";

const fmt = (n: number) =>
  new Intl.NumberFormat("fr-DZ", { style: "currency", currency: "DZD" }).format(n);

export default function InventoryScreen({ canEdit }: { canEdit: boolean }) {
  const [list, setList] = useState<InventorySummary[]>([]);
  const [current, setCurrent] = useState<InventoryInfo | null>(null);
  const [counted, setCounted] = useState<Record<number, string>>({});
  const [result, setResult] = useState<InventoryResult | null>(null);
  const [warehouses, setWarehouses] = useState<Array<{ id: number; name: string }>>([]);
  const [whId, setWhId] = useState<number>(1);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void api.inventoriesList().then(setList).catch((e) => setError(String(e)));
    void api.warehouses().then(setWarehouses).catch(() => {});
  }, []);

  useEffect(refresh, [refresh]);

  useEffect(() => {
    if (warehouses.length > 0 && !warehouses.some((w) => w.id === whId)) {
      setWhId(warehouses[0].id);
    }
  }, [warehouses, whId]);

  const flash = (m: string) => {
    setMsg(m);
    setTimeout(() => setMsg(null), 3000);
  };

  const open = async (id: number) => {
    const inv = await api.inventoryGet(id);
    setCurrent(inv);
    setResult(null);
    const init: Record<number, string> = {};
    inv.lines.forEach((l) => (init[l.product_id] = String(l.qty_book)));
    setCounted(init);
  };

  const start = async (wh: number) => {
    try {
      const inv = await api.inventoryStart(wh);
      flash(`Inventaire #${inv.id} démarré (${inv.lines.length} lignes)`);
      refresh();
      await open(inv.id);
    } catch (e) {
      setError(String(e));
    }
  };

  const validate = async () => {
    if (!current) return;
    const counts = current.lines.map((l) => ({
      product_id: l.product_id,
      qty: parseFloat((counted[l.product_id] ?? "0").replace(",", ".")) || 0,
    }));
    try {
      const res = await api.inventoryValidate(current.id, counts);
      setResult(res);
      flash(
        `Inventaire #${current.id} validé : ${res.adjustments.length} ajustement(s), écart ${res.variance_pct} %`,
      );
      refresh();
      const updated = await api.inventoryGet(current.id);
      setCurrent(updated);
    } catch (e) {
      setError(String(e));
    }
  };

  const diffs = useMemo(
    () =>
      (current?.lines ?? []).map((l) => {
        const c = parseFloat((counted[l.product_id] ?? "0").replace(",", ".")) || 0;
        return { ...l, countedNow: c, diff: Math.round((c - l.qty_book) * 100) / 100 };
      }),
    [current, counted],
  );

  const nbDiff = diffs.filter((d) => Math.abs(d.diff) > 1e-9).length;

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4">
      {error && <p className="rounded-lg bg-red-50 px-4 py-2 text-sm text-red-700">⚠ {error}</p>}
      {msg && <p className="rounded-lg bg-emerald-50 px-4 py-2 text-sm text-emerald-700">{msg}</p>}

      <div className="flex flex-wrap items-center gap-3 rounded-xl bg-white p-4 shadow-sm">
        <h3 className="text-sm font-semibold text-slate-700">Inventaires</h3>
        {canEdit && warehouses.length > 0 && (
          <div className="ml-auto flex gap-2">
            <select
              value={whId}
              onChange={(e) => setWhId(Number(e.target.value))}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
            >
              {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
            <button
              onClick={() => void start(whId)}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
            >
              + Démarrer un inventaire
            </button>
          </div>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
        {/* Liste */}
        <div className="rounded-xl bg-white shadow-sm">
          <div className="border-b border-slate-100 px-4 py-2 text-xs font-semibold uppercase text-slate-400">
            Historique
          </div>
          <div className="max-h-[60vh] overflow-auto p-2">
            {list.map((s) => (
              <button
                key={s.id}
                onClick={() => void open(s.id)}
                className={`mb-1 w-full rounded-lg border px-3 py-2 text-left text-sm transition ${
                  current?.id === s.id ? "border-blue-500 bg-blue-50" : "border-transparent hover:bg-slate-50"
                }`}
              >
                <p className="font-medium">
                  #{s.id} — {s.warehouse}
                  <span className={`ml-2 rounded px-1.5 py-0.5 text-[10px] font-bold ${s.status === "VALIDATED" ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>
                    {s.status === "VALIDATED" ? "VALIDÉ" : "EN COURS"}
                  </span>
                </p>
                <p className="text-xs text-slate-400">
                  {s.date} · {s.line_count} lignes{s.validated_at ? ` · validé le ${s.validated_at.slice(0, 10)}` : ""}
                </p>
              </button>
            ))}
            {list.length === 0 && <p className="p-6 text-center text-sm text-slate-400">Aucun inventaire</p>}
          </div>
        </div>

        {/* Détail */}
        {current ? (
          <div className="space-y-3">
            <div className="rounded-xl bg-white p-4 shadow-sm">
              <div className="flex flex-wrap items-center gap-3">
                <h3 className="text-sm font-semibold text-slate-700">
                  Inventaire #{current.id} — {current.date}
                </h3>
                <span className={`rounded px-2 py-0.5 text-xs font-bold ${current.status === "VALIDATED" ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>
                  {current.status === "VALIDATED" ? "VALIDÉ" : "EN COURS"}
                </span>
                {canEdit && current.status === "DRAFT" && (
                  <button
                    onClick={() => void validate()}
                    className="ml-auto rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700"
                  >
                    ✓ Valider & appliquer les écarts ({nbDiff})
                  </button>
                )}
              </div>

              <div className="mt-3 max-h-[46vh] overflow-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-slate-50 text-xs uppercase text-slate-400">
                    <tr>
                      <th className="px-3 py-2 text-left">Article</th>
                      <th className="px-2 py-2 text-right">Théorique</th>
                      <th className="px-2 py-2 text-right">Compté</th>
                      <th className="px-2 py-2 text-right">Écart</th>
                    </tr>
                  </thead>
                  <tbody>
                    {diffs.map((d) => (
                      <tr key={d.product_id} className={`border-t border-slate-100 ${Math.abs(d.diff) > 1e-9 ? "bg-amber-50/60" : ""}`}>
                        <td className="px-3 py-1.5">
                          <span className="font-mono text-xs text-slate-400">{d.sku}</span>
                          <span className="ml-2">{d.name}</span>
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{d.qty_book} {d.unit}</td>
                        <td className="px-2 py-1.5 text-right">
                          {current.status === "DRAFT" && canEdit ? (
                            <input
                              value={counted[d.product_id] ?? ""}
                              onChange={(e) => setCounted((c) => ({ ...c, [d.product_id]: e.target.value }))}
                              className="w-24 rounded border border-slate-300 px-2 py-1 text-right"
                            />
                          ) : (
                            <span className="tabular-nums">{d.countedNow}</span>
                          )}
                        </td>
                        <td className={`px-2 py-1.5 text-right font-semibold tabular-nums ${d.diff > 0 ? "text-emerald-700" : d.diff < 0 ? "text-red-600" : "text-slate-400"}`}>
                          {d.diff > 0 ? `+${d.diff}` : d.diff}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {result && (
              <div className="rounded-xl bg-white p-4 text-sm shadow-sm">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Résultat de la validation
                </h4>
                <p className="mt-2">
                  Écart global : <strong className={result.variance_pct < 0 ? "text-red-600" : "text-emerald-700"}>{result.variance_pct} %</strong>
                  {" · "}Valeur théorique : <strong>{fmt(result.book_value)}</strong>
                  {" · "}Valeur comptée : <strong>{fmt(result.counted_value)}</strong>
                </p>
                {result.adjustments.length > 0 && (
                  <table className="mt-3 w-full text-xs">
                    <thead className="text-slate-400">
                      <tr>
                        <th className="py-1 text-left">Article</th>
                        <th className="py-1 text-right">Théorique</th>
                        <th className="py-1 text-right">Compté</th>
                        <th className="py-1 text-right">Écart</th>
                        <th className="py-1 text-right">Valeur écart</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.adjustments.map((a) => (
                        <tr key={a.product_id} className="border-t border-slate-100">
                          <td className="py-1">{a.name}</td>
                          <td className="py-1 text-right tabular-nums">{a.book}</td>
                          <td className="py-1 text-right tabular-nums">{a.counted}</td>
                          <td className={`py-1 text-right font-semibold tabular-nums ${a.diff < 0 ? "text-red-600" : "text-emerald-700"}`}>{a.diff}</td>
                          <td className="py-1 text-right tabular-nums">{fmt(a.value_dzd)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="flex items-center justify-center rounded-xl bg-white p-10 text-sm text-slate-400 shadow-sm">
            Sélectionnez un inventaire pour le détail
          </div>
        )}
      </div>
    </div>
  );
}
