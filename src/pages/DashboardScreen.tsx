// ============================================================================
//  Tableau de bord financier (ADMIN / ACCOUNTANT)
//  Totaux dénormalisés => lecture < 10 ms
// ============================================================================
import { useEffect, useState } from "react";
import { api } from "../api";
import type { Dashboard } from "../types";

const fmt = (n: number) =>
  new Intl.NumberFormat("fr-DZ", { style: "currency", currency: "DZD" }).format(n);

const STATUS_FR: Record<string, string> = {
  DRAFT: "Brouillon", VALIDATED: "Validée", PARTIAL: "Partiel",
  PAID: "Payée", CANCELED: "Annulée",
};

export default function DashboardScreen() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.dashboard().then(setData).catch((e) => setError(String(e)));
  }, []);

  if (error) return <p className="p-6 text-red-600">⚠ {error}</p>;
  if (!data) return <p className="p-6 text-slate-400">Chargement…</p>;

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card title="CA du mois (TTC)" value={fmt(data.ca_month)} accent="text-blue-700" />
        <Card title="TVA collectée (mois)" value={fmt(data.tva_month)} accent="text-slate-800" />
        <Card title="Impayés clients" value={fmt(data.unpaid)} accent={data.unpaid > 0 ? "text-red-600" : "text-emerald-700"} />
        <Card
          title="Alertes stock"
          value={data.low_stock === 0 ? "Aucune" : `${data.low_stock} article(s)`}
          accent={data.low_stock > 0 ? "text-amber-600" : "text-emerald-700"}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl bg-white p-4 shadow-sm">
          <h3 className="text-sm font-semibold text-slate-700">Derniers documents</h3>
          <table className="mt-2 w-full text-sm">
            <tbody>
              {data.last_docs.map((d) => (
                <tr key={d.number} className="border-t border-slate-100">
                  <td className="py-2 font-mono text-xs">{d.number}</td>
                  <td className="py-2 truncate text-slate-600">{d.client}</td>
                  <td className="py-2 text-right tabular-nums">{fmt(d.total_ttc)}</td>
                  <td className="py-2 text-right text-xs text-slate-400">{STATUS_FR[d.status] ?? d.status}</td>
                </tr>
              ))}
              {data.last_docs.length === 0 && (
                <tr><td className="py-6 text-center text-slate-400">Aucun document</td></tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="rounded-xl bg-white p-4 shadow-sm">
          <h3 className="text-sm font-semibold text-slate-700">Top 5 du mois (CA TTC)</h3>
          <table className="mt-2 w-full text-sm">
            <tbody>
              {data.top_products.map((p) => (
                <tr key={p.name} className="border-t border-slate-100">
                  <td className="max-w-0 truncate py-2">{p.name}</td>
                  <td className="py-2 text-right text-xs text-slate-400">× {p.qty}</td>
                  <td className="py-2 text-right tabular-nums">{fmt(p.revenue)}</td>
                </tr>
              ))}
              {data.top_products.length === 0 && (
                <tr><td className="py-6 text-center text-slate-400">Aucune vente ce mois-ci</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Card({ title, value, accent }: { title: string; value: string; accent: string }) {
  return (
    <div className="rounded-xl bg-white p-4 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</p>
      <p className={`mt-1 text-xl font-bold tabular-nums ${accent}`}>{value}</p>
    </div>
  );
}
