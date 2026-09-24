// ============================================================================
//  Gate obligatoire de changement de PIN (must_change_pin après login)
//  — ex. premier connexion avec un PIN initial créé par le gérant
// ============================================================================
import { useState } from "react";
import { api } from "../api";

export default function ChangePinGate({
  userName,
  onDone,
  onCancel,
}: {
  userName: string;
  onDone: () => void;
  onCancel?: () => void;
}) {
  const [oldPin, setOldPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [newPin2, setNewPin2] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    if (newPin !== newPin2) return setError("Les deux nouveaux PIN ne correspondent pas");
    setBusy(true);
    try {
      await api.changePin(oldPin, newPin);
      onDone();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center bg-slate-100 p-6">
      <div className="w-full max-w-sm rounded-2xl bg-white p-8 shadow-xl">
        <h1 className="text-lg font-bold text-slate-900">Changement de PIN requis</h1>
        <p className="mt-1 text-sm text-slate-500">
          Bonjour <strong>{userName}</strong> — modifiez votre PIN avant de continuer
          (recommandation de sécurité).
        </p>
        <div className="mt-5 space-y-3">
          <input type="password" placeholder="PIN actuel" value={oldPin}
            onChange={(e) => setOldPin(e.target.value)} autoFocus
            className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm tracking-widest" />
          <input type="password" placeholder="Nouveau PIN (≥ 4 caractères)" value={newPin}
            onChange={(e) => setNewPin(e.target.value)}
            className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm tracking-widest" />
          <input type="password" placeholder="Confirmer le nouveau PIN" value={newPin2}
            onChange={(e) => setNewPin2(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void submit()}
            className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm tracking-widest" />
          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">⚠ {error}</p>}
          <button onClick={() => void submit()} disabled={busy || oldPin.length < 4 || newPin.length < 4}
            className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
            {busy ? "Enregistrement…" : "Changer le PIN"}
          </button>
          {onCancel && (
            <button onClick={onCancel} className="w-full text-center text-xs text-slate-400 hover:text-slate-600">
              Se déconnecter
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
