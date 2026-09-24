// ============================================================================
//  Utilisateurs & rôles (ADMIN)
//  • Création de compte (rôle + PIN Argon2id + droit « modifiable des prix »)
//  • Activation / désactivation, droits prix/remises (délégation COMMERCIAL)
//  • Traçabilité : chaque action est journalisée dans audit_log
// ============================================================================
import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { AdminUser, Role } from "../types";

const ROLE_LABEL: Record<Role, string> = {
  ADMIN: "Administrateur / Gérant",
  COMMERCIAL: "Commercial",
  STOREKEEPER: "Magasinier",
  ACCOUNTANT: "Comptable",
};

export default function UsersScreen() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [u, setU] = useState({ username: "", full_name: "", role: "COMMERCIAL" as Role, pin: "", can: false });

  const refresh = useCallback(() => {
    api.usersAdminList().then(setUsers).catch((e) => setError(String(e)));
  }, []);

  useEffect(refresh, [refresh]);

  const flash = (m: string) => {
    setMsg(m);
    setTimeout(() => setMsg(null), 2500);
  };

  const create = async () => {
    setError(null);
    if (u.username.trim().length < 3 || u.pin.length < 4) {
      return setError("Nom d'utilisateur (≥3 car.) et PIN (≥4 car.) requis");
    }
    try {
      await api.userCreate(u.username.trim(), u.full_name.trim() || u.username.trim(), u.role, u.pin, u.can);
      flash(`Compte « ${u.username} » créé (${ROLE_LABEL[u.role]})`);
      setU({ username: "", full_name: "", role: "COMMERCIAL", pin: "", can: false });
      setShowForm(false);
      refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4">
      {error && <p className="rounded-lg bg-red-50 px-4 py-2 text-sm text-red-700">⚠ {error}</p>}
      {msg && <p className="rounded-lg bg-emerald-50 px-4 py-2 text-sm text-emerald-700">{msg}</p>}

      <div className="flex items-center gap-3 rounded-xl bg-white p-4 shadow-sm">
        <h3 className="text-sm font-semibold text-slate-700">Utilisateurs ({users.length})</h3>
        <button
          onClick={() => setShowForm((s) => !s)}
          className="ml-auto rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
        >
          {showForm ? "Fermer" : "+ Nouveau compte"}
        </button>
      </div>

      {showForm && (
        <div className="rounded-xl bg-white p-4 shadow-sm">
          <div className="grid gap-2 text-sm md:grid-cols-5">
            <input placeholder="Nom d'utilisateur" value={u.username}
              onChange={(e) => setU({ ...u, username: e.target.value })}
              className="rounded-lg border border-slate-300 px-2 py-1.5" />
            <input placeholder="Nom complet" value={u.full_name}
              onChange={(e) => setU({ ...u, full_name: e.target.value })}
              className="rounded-lg border border-slate-300 px-2 py-1.5" />
            <select value={u.role} onChange={(e) => setU({ ...u, role: e.target.value as Role })}
              className="rounded-lg border border-slate-300 px-2 py-1.5">
              {(Object.keys(ROLE_LABEL) as Role[]).map((r) => (
                <option key={r} value={r}>{ROLE_LABEL[r]}</option>
              ))}
            </select>
            <input type="password" placeholder="PIN initial (≥4)" value={u.pin}
              onChange={(e) => setU({ ...u, pin: e.target.value })}
              className="rounded-lg border border-slate-300 px-2 py-1.5" />
            <label className="flex items-center gap-2 text-xs text-slate-600">
              <input type="checkbox" checked={u.can} onChange={(e) => setU({ ...u, can: e.target.checked })} />
              Peut modifier prix/remises en ligne
            </label>
          </div>
          <button onClick={() => void create()}
            className="mt-3 rounded-lg bg-blue-600 px-5 py-2 text-sm font-semibold text-white hover:bg-blue-700">
            Créer le compte
          </button>
        </div>
      )}

      <div className="overflow-auto rounded-xl bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-400">
            <tr>
              <th className="px-4 py-2 text-left">Utilisateur</th>
              <th className="px-2 py-2 text-left">Rôle</th>
              <th className="px-2 py-2 text-center">Prix modifiables</th>
              <th className="px-2 py-2 text-center">Actif</th>
              <th className="px-2 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((x) => (
              <tr key={x.id} className={`border-t border-slate-100 ${x.is_active ? "" : "opacity-50"}`}>
                <td className="px-4 py-2">
                  <p className="font-medium">{x.full_name}</p>
                  <p className="text-xs text-slate-400">@{x.username}</p>
                </td>
                <td className="px-2 py-2">
                  <span className={`rounded px-2 py-0.5 text-xs font-semibold ${
                    x.role === "ADMIN" ? "bg-blue-100 text-blue-700"
                    : x.role === "COMMERCIAL" ? "bg-emerald-100 text-emerald-700"
                    : x.role === "STOREKEEPER" ? "bg-amber-100 text-amber-700"
                    : "bg-violet-100 text-violet-700"
                  }`}>
                    {ROLE_LABEL[x.role as Role] ?? x.role}
                  </span>
                </td>
                <td className="px-2 py-2 text-center">
                  <input type="checkbox" checked={x.can_edit_prices} disabled={x.role === "ADMIN"}
                    onChange={(e) => void api.userSetPriceRights(x.id, e.target.checked).then(refresh)}
                    className="h-4 w-4" />
                </td>
                <td className="px-2 py-2 text-center">
                  <input type="checkbox" checked={x.is_active}
                    onChange={(e) =>
                      void api.userSetActive(x.id, e.target.checked)
                        .then(refresh)
                        .catch((err) => setError(String(err)))
                    }
                    className="h-4 w-4" />
                </td>
                <td className="px-2 py-2 text-right text-xs text-slate-400">
                  {x.role === "ADMIN" ? "Compte gérant" : "PIN : voir écran connexion"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-slate-400">
        Rappels RBAC — <strong>Commercial</strong> : devis/BL/factures sans voir prix d'achat, coûts ni marges ·
        <strong> Magasinier</strong> : stock, inventaires, transferts, aucun accès financier ·
        <strong> Comptable</strong> : lecture seule + G50 + exports comptables.
      </p>
    </div>
  );
}
