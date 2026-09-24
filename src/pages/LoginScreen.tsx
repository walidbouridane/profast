// ============================================================================
//  Écran de connexion — sélection utilisateur + PIN (Argon2id côté serveur)
//  • 1er lancement : création du compte Administrateur
//  • Verrouillage 15 min après 5 échecs (géré par db.rs)
// ============================================================================
import { useEffect, useState } from "react";
import { api } from "../api";
import type { UserLite, UserSession } from "../types";

const ROLE_BADGE: Record<string, { label: string; cls: string }> = {
  ADMIN: { label: "Gérant", cls: "bg-blue-100 text-blue-700" },
  COMMERCIAL: { label: "Commercial", cls: "bg-emerald-100 text-emerald-700" },
  STOREKEEPER: { label: "Magasinier", cls: "bg-amber-100 text-amber-700" },
  ACCOUNTANT: { label: "Comptable", cls: "bg-violet-100 text-violet-700" },
};

export default function LoginScreen({
  users,
  onLogin,
}: {
  users: UserLite[];
  onLogin: (s: UserSession) => void;
}) {
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null);
  const [user, setUser] = useState<UserLite | null>(null);
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Setup admin : champs du 1er lancement
  const [suUser, setSuUser] = useState("admin");
  const [suName, setSuName] = useState("Gérant");
  const [suPin, setSuPin] = useState("");
  const [suPin2, setSuPin2] = useState("");

  useEffect(() => {
    void api.needsSetup().then(setNeedsSetup).catch(() => setNeedsSetup(false));
  }, []);

  const doLogin = async () => {
    if (!user) return;
    setBusy(true);
    setError(null);
    try {
      onLogin(await api.login(user.username, pin));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const doSetup = async () => {
    setBusy(true);
    setError(null);
    try {
      if (suPin !== suPin2) throw new Error("Les deux PIN ne correspondent pas");
      await api.setupAdmin(suUser, suName, suPin);
      onLogin(await api.login(suUser, suPin));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center bg-slate-100 p-6">
      <div className="w-full max-w-md rounded-2xl bg-white p-8 shadow-xl">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-blue-600 text-xl">⚡</div>
          <div>
            <h1 className="text-lg font-bold text-slate-900">ProFast Facture</h1>
            <p className="text-xs text-slate-500">
              {needsSetup ? "Premier lancement" : "Identifiez-vous (PIN)"}
            </p>
          </div>
        </div>

        {needsSetup === true ? (
          <div className="mt-6 space-y-3">
            <p className="rounded-lg bg-blue-50 p-3 text-xs text-blue-800">
              Créez le compte <strong>Administrateur</strong>. Le PIN est haché en
              local (Argon2id) — aucun réseau, aucune télémétrie.
            </p>
            <input value={suUser} onChange={(e) => setSuUser(e.target.value)}
              placeholder="Nom d'utilisateur" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
            <input value={suName} onChange={(e) => setSuName(e.target.value)}
              placeholder="Nom complet" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
            <input type="password" value={suPin} onChange={(e) => setSuPin(e.target.value)}
              placeholder="PIN (4 caractères min.)" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
            <input type="password" value={suPin2} onChange={(e) => setSuPin2(e.target.value)}
              placeholder="Confirmer le PIN" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
            {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">⚠ {error}</p>}
            <button onClick={() => void doSetup()} disabled={busy}
              className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
              Créer et se connecter
            </button>
          </div>
        ) : (
          <>
            <div className="mt-6 grid grid-cols-2 gap-2">
              {users.map((u) => (
                <button
                  key={u.id}
                  onClick={() => { setUser(u); setPin(""); setError(null); }}
                  className={`rounded-lg border px-3 py-2.5 text-left transition ${
                    user?.id === u.id
                      ? "border-blue-500 bg-blue-50 ring-1 ring-blue-500"
                      : "border-slate-200 hover:border-slate-300"
                  }`}
                >
                  <p className="truncate text-sm font-medium text-slate-800">{u.full_name}</p>
                  <span className={`mt-1 inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold ${ROLE_BADGE[u.role]?.cls ?? ""}`}>
                    {ROLE_BADGE[u.role]?.label ?? u.role}
                  </span>
                </button>
              ))}
            </div>

            {user && (
              <div className="mt-4">
                <input
                  type="password"
                  value={pin}
                  onChange={(e) => setPin(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void doLogin()}
                  placeholder={`PIN de ${user.username}`}
                  autoFocus
                  className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm tracking-widest outline-none ring-blue-500 focus:ring-2"
                />
                {error && (
                  <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">⚠ {error}</p>
                )}
                <button onClick={() => void doLogin()} disabled={busy || pin.length < 4}
                  className="mt-3 w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
                  {busy ? "Vérification…" : "Se connecter"}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
