// ============================================================================
//  Écran d'activation — fenêtre de vérification au démarrage
//  • Affiche le HWID de la machine (à communiquer au vendeur)
//  • Saisie de la clé PFF1.... (signée, liée au HWID)
//  • Sans clé valide => mode Démo (10 factures)
// ============================================================================
import { useState } from "react";
import { api } from "../api";
import type { LicenseStatus } from "../types";

const PLAN_LABEL: Record<string, string> = {
  ANNUAL: "Licence Annuelle",
  LIFETIME: "Licence À Vie",
};

export default function ActivationScreen({
  status,
  onActivated,
}: {
  status: LicenseStatus;
  onActivated: (s: LicenseStatus) => void;
}) {
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const demoRemaining = Math.min(status.demo_remaining, 10);

  const activate = async () => {
    setBusy(true);
    setError(null);
    try {
      const st = await api.activate(key);
      onActivated(st);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const copyHwid = async () => {
    try {
      await navigator.clipboard.writeText(status.hwid);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard indisponible : le texte reste sélectionnable */
    }
  };

  return (
    <div className="flex h-full items-center justify-center bg-gradient-to-br from-slate-900 via-slate-800 to-blue-950 p-6">
      <div className="w-full max-w-lg rounded-2xl bg-white p-8 shadow-2xl">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-blue-600 text-2xl">⚡</div>
          <div>
            <h1 className="text-xl font-bold text-slate-900">ProFast Facture</h1>
            <p className="text-sm text-slate-500">Activation — 100 % local, hors-ligne</p>
          </div>
        </div>

        {status.active ? (
          <div className="mt-6 rounded-lg bg-emerald-50 p-4 text-sm text-emerald-800">
            ✅ {PLAN_LABEL[status.plan ?? ""] ?? "Licence active"}
            {status.expires_at
              ? ` — expire le ${new Date(status.expires_at * 1000).toLocaleDateString("fr-DZ")}`
              : " — À vie"}
          </div>
        ) : (
          <>
            <p className="mt-5 text-sm text-slate-600">
              Communiquez cet <strong>HWID</strong> (empreinte machine) au vendeur pour
              recevoir votre clé d'activation :
            </p>
            <div className="mt-2 flex items-center gap-2">
              <code className="flex-1 select-all rounded-lg bg-slate-100 px-3 py-2.5 font-mono text-sm text-slate-800">
                {status.hwid}
              </code>
              <button
                onClick={copyHwid}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50"
              >
                {copied ? "✓" : "Copier"}
              </button>
            </div>

            <label className="mt-5 block text-xs font-semibold uppercase tracking-wide text-slate-500">
              Clé d'activation
            </label>
            <input
              value={key}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void activate()}
              placeholder="PFF1.████████.████████"
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 font-mono text-sm outline-none ring-blue-500 focus:ring-2"
              autoFocus
            />

            {error && (
              <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                ⚠ {error}
              </p>
            )}

            <button
              onClick={() => void activate()}
              disabled={busy || key.trim().length < 8}
              className="mt-4 w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-700 disabled:opacity-50"
            >
              {busy ? "Vérification…" : "Activer la licence"}
            </button>

            <div className="mt-5 rounded-lg bg-amber-50 p-3 text-xs text-amber-800">
              📌 <strong>Sans licence</strong> : mode Démo — {demoRemaining} facture(s)
              restante(s). L'application reste utilisable pour découvrir les modules.
            </div>
          </>
        )}

        {!status.active && (
          <button
            onClick={() => onActivated(status)}
            className="mt-4 w-full text-center text-xs text-slate-400 underline-offset-2 hover:text-slate-600 hover:underline"
          >
            Continuer en mode Démo
          </button>
        )}
      </div>
    </div>
  );
}
