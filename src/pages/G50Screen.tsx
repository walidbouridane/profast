// ============================================================================
//  Écran Pré-état G50 (section TVA)
//  • Période mensuelle ou trimestrielle
//  • Ventilation 19 % / 9 % / 0 % (collectée & déductible)
//  • Solde : net à payer  |  crédit à reporter
//  • Export CSV, archivage (snapshot), impression PDF
// ============================================================================
import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { computeG50, type G50Result, type TvaRate } from "../fiscal/engine";
import type { G50Raw } from "../types";

const fmt = (n: number) =>
  new Intl.NumberFormat("fr-DZ", { style: "currency", currency: "DZD" }).format(n);

const YEARS = [2024, 2025, 2026, 2027, 2028];
const MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

export default function G50Screen() {
  const now = new Date();
  const [periodType, setPeriodType] = useState<"MONTH" | "QUARTER">("MONTH");
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1); // 1..12
  const [quarter, setQuarter] = useState(Math.ceil((now.getMonth() + 1) / 3));
  const [raw, setRaw] = useState<G50Raw | null>(null);
  const [result, setResult] = useState<G50Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const refMonth = periodType === "QUARTER" ? (quarter - 1) * 3 + 1 : month;

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await api.g50Report(periodType, year, refMonth);
      setRaw(r);
      setResult(
        computeG50({
          period: { type: periodType, year, month: refMonth },
          sales: r.sales.map((x) => ({ rate: x.rate as TvaRate, base: x.base, tva: x.tva })),
          purchases: [
            ...r.purchases.map((x) => ({
              rate: x.rate as TvaRate, base: x.base, tva: x.tva, deductible: true,
            })),
            ...r.purchases_non_deductible.map((x) => ({
              rate: x.rate as TvaRate, base: x.base, tva: x.tva, deductible: false,
            })),
          ],
        }),
      );
    } catch (e) {
      setError(String(e));
    }
  }, [periodType, year, refMonth]);

  useEffect(() => {
    void load();
  }, [load]);

  const exportCsv = () => {
    if (!result) return;
    const lines: string[] = [
      "PROFAST FACTURE - PRE-ETAT G50 (section TVA)",
      `periode;${result.periodStart};${result.periodEnd}`,
      `type;${result.period.type === "MONTH" ? "mensuelle" : "trimestrielle"}`,
      "",
      "TVA COLLECTEE (ventes)",
      "taux;base;tva",
      ...result.collectee.map((l) => `${l.rate};${l.base.toFixed(2)};${l.tva.toFixed(2)}`),
      `TOTAL_COLLECTEE;;${result.totalCollectee.toFixed(2)}`,
      "",
      "TVA DEDUCTIBLE (achats)",
      "taux;base;tva",
      ...result.deductible.map((l) => `${l.rate};${l.base.toFixed(2)};${l.tva.toFixed(2)}`),
      `TOTAL_DEDUCTIBLE;;${result.totalDeductible.toFixed(2)}`,
      "",
      `SOLDE;${result.balance.toFixed(2)};${result.situation}`,
      `VENTES_EXONEREES_BASE;${result.exemptSalesBase.toFixed(2)};`,
      `ACHATS_NON_DEDUCTIBLES_BASE;${result.nonDeductiblePurchasesBase.toFixed(2)};`,
    ];
    download(`G50_${result.periodStart}_${result.periodEnd}.csv`, lines.join("\r\n"));
  };

  const archive = async () => {
    if (!result) return;
    await api.g50SaveSnapshot(periodType, year, refMonth, JSON.stringify(result));
    setMsg("Pré-état archivé (non modifiable) ✓");
    setTimeout(() => setMsg(null), 2500);
  };

  const print = async () => {
    if (!result) return;
    const dir = await api.pdfOutDir();
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      body{font-family:Segoe UI,system-ui,sans-serif;padding:32px;color:#0f172a}
      h1{font-size:18px}h2{font-size:14px;margin-top:24px;text-transform:uppercase;letter-spacing:.05em;color:#475569}
      table{width:100%;border-collapse:collapse;margin-top:8px;font-size:12px}
      th,td{border:1px solid #cbd5e1;padding:6px 10px;text-align:right}th:first-child,td:first-child{text-align:left}
      th{background:#f1f5f9}.tot{font-weight:700;background:#eff6ff}
      .badge{display:inline-block;padding:6px 14px;border-radius:8px;font-weight:700;font-size:14px}
      .pay{background:#fee2e2;color:#b91c1c}.cred{background:#dcfce7;color:#15803d}
    </style></head><body>
      <h1>Pré-état G50 — TVA ${result.period.type === "MONTH" ? "mensuelle" : "trimestrielle"}</h1>
      <p>Période : ${result.periodStart} → ${result.periodEnd}</p>
      <h2>TVA collectée (ventes)</h2>
      <table><tr><th>Taux</th><th>Base HT</th><th>TVA</th></tr>
      ${result.collectee.map((l) => `<tr><td>${pct(l.rate)}</td><td>${fmt(l.base)}</td><td>${fmt(l.tva)}</td></tr>`).join("")}
      <tr class="tot"><td>Total collectée</td><td></td><td>${fmt(result.totalCollectee)}</td></tr></table>
      <h2>TVA déductible (achats)</h2>
      <table><tr><th>Taux</th><th>Base HT</th><th>TVA</th></tr>
      ${result.deductible.map((l) => `<tr><td>${pct(l.rate)}</td><td>${fmt(l.base)}</td><td>${fmt(l.tva)}</td></tr>`).join("")}
      <tr class="tot"><td>Total déductible</td><td></td><td>${fmt(result.totalDeductible)}</td></tr></table>
      <p style="margin-top:24px">Solde : <span class="badge ${result.balance > 0 ? "pay" : "cred"}">
        ${result.balance > 0 ? `NET À PAYER : ${fmt(result.balance)}` : `CRÉDIT À REPORTER : ${fmt(-result.balance)}`}
      </span></p>
      <p style="font-size:11px;color:#64748b;margin-top:32px">
        Ventes exonérées (base 0 %) : ${fmt(result.exemptSalesBase)} ·
        Achats non déductibles (hors G50) : ${fmt(result.nonDeductiblePurchasesBase)} ·
        Généré par ProFast Facture — ${new Date().toLocaleString("fr-DZ")}
      </p>
    </body></html>`;
    await api.printPdf(html, `${dir}/G50_${result.periodStart}_${result.periodEnd}.pdf`);
  };

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4">
      {/* Sélecteur de période */}
      <div className="flex flex-wrap items-end gap-3 rounded-xl bg-white p-4 shadow-sm">
        <Field label="Type de période">
          <select value={periodType} onChange={(e) => setPeriodType(e.target.value as "MONTH" | "QUARTER")}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm">
            <option value="MONTH">Mensuelle</option>
            <option value="QUARTER">Trimestrielle</option>
          </select>
        </Field>
        <Field label="Année">
          <select value={year} onChange={(e) => setYear(Number(e.target.value))}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm">
            {YEARS.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </Field>
        {periodType === "MONTH" ? (
          <Field label="Mois">
            <select value={month} onChange={(e) => setMonth(Number(e.target.value))}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm">
              {MONTHS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </Field>
        ) : (
          <Field label="Trimestre">
            <select value={quarter} onChange={(e) => setQuarter(Number(e.target.value))}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm">
              {[1, 2, 3, 4].map((q) => <option key={q} value={q}>T{q}</option>)}
            </select>
          </Field>
        )}
        <div className="ml-auto flex gap-2">
          <button onClick={exportCsv} disabled={!result}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50 disabled:opacity-50">
            ⬇ Export CSV
          </button>
          <button onClick={() => void archive()} disabled={!result}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50 disabled:opacity-50">
            🗄 Archiver
          </button>
          <button onClick={() => void print()} disabled={!result}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
            🖨 PDF
          </button>
        </div>
      </div>

      {msg && <p className="rounded-lg bg-emerald-50 px-4 py-2 text-sm text-emerald-700">{msg}</p>}
      {error && <p className="rounded-lg bg-red-50 px-4 py-2 text-sm text-red-700">⚠ {error}</p>}

      {result && (
        <>
          {/* Solde */}
          <div className={`rounded-xl p-5 shadow-sm ${result.balance > 0 ? "bg-red-50" : result.balance < 0 ? "bg-emerald-50" : "bg-slate-100"}`}>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Solde de la période {result.periodStart} → {result.periodEnd}
            </p>
            <p className={`mt-1 text-3xl font-bold tabular-nums ${result.balance > 0 ? "text-red-700" : "text-emerald-700"}`}>
              {result.balance > 0 ? `${fmt(result.balance)} — TVA nette À PAYER`
                : result.balance < 0 ? `${fmt(-result.balance)} — CRÉDIT DE TVA À REPORTER`
                : "Néant"}
            </p>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <RateTable title="TVA collectée (ventes)" rows={result.collectee} total={result.totalCollectee} />
            <RateTable title="TVA déductible (achats)" rows={result.deductible} total={result.totalDeductible} />
          </div>

          {(result.exemptSalesBase > 0 || result.nonDeductiblePurchasesBase > 0) && (
            <div className="rounded-xl bg-white p-4 text-sm shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Ventilation annexe</p>
              {result.exemptSalesBase > 0 && (
                <p className="mt-1 text-slate-600">
                  Ventes exonérées (0 %) hors base imposable : <strong>{fmt(result.exemptSalesBase)}</strong>
                </p>
              )}
              {result.nonDeductiblePurchasesBase > 0 && (
                <p className="text-amber-700">
                  ⚠ Achats non déductibles (factures incomplètes ?) : <strong>{fmt(result.nonDeductiblePurchasesBase)}</strong>
                </p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

function RateTable({
  title, rows, total,
}: {
  title: string;
  rows: Array<{ rate: number; base: number; tva: number }>;
  total: number;
}) {
  return (
    <div className="rounded-xl bg-white p-4 shadow-sm">
      <h3 className="text-sm font-semibold text-slate-700">{title}</h3>
      <table className="mt-2 w-full text-sm">
        <thead>
          <tr className="text-xs uppercase text-slate-400">
            <th className="py-1 text-left">Taux</th>
            <th className="py-1 text-right">Base HT</th>
            <th className="py-1 text-right">TVA</th>
          </tr>
        </thead>
        <tbody>
          {[0.19, 0.09, 0].map((r) => {
            const row = rows.find((x) => Math.abs(x.rate - r) < 1e-9);
            return (
              <tr key={r} className="border-t border-slate-100">
                <td className="py-1.5">{pct(r)}</td>
                <td className="py-1.5 text-right tabular-nums">{fmt(row?.base ?? 0)}</td>
                <td className="py-1.5 text-right tabular-nums">{fmt(row?.tva ?? 0)}</td>
              </tr>
            );
          })}
          <tr className="border-t-2 border-slate-200 font-semibold">
            <td className="py-1.5">Total</td>
            <td className="py-1.5" />
            <td className="py-1.5 text-right tabular-nums">{fmt(total)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

const pct = (r: number) => (r === 0 ? "0 % (exonéré)" : `${(r * 100).toFixed(0)} %`);

function download(filename: string, content: string) {
  const blob = new Blob(["\uFEFF" + content], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
