// ============================================================================
//  ProFast Facture — Vue « Facturation Rapide » (moteur FAST)
//  React 18 + Tailwind CSS.
//
//  PRINCIPES DE RAPIDITÉ (< 10 ms)
//   • Catalogue + clients PRÉ-CHARGÉS dans le webview (1 seul invoke Tauri
//     au démarrage) : la recherche est 100 % locale, en mémoire, avec
//     normalisation (accents/casse) — aucune requête SQL pendant la saisie.
//   • Totaux recalculés par useMemo seulement quand une ligne change.
//   • Les montants sont RÉCAlculés côté main-process (source de vérité)
//     à l'enregistrement ; le webview affiche en avance.
//
//  RACCOURCIS CLAVIER
//   F2        = nouvelle ligne vide      F5   = article « à la volée »
//   F9        = enregistrer              F12  = envoyer par WhatsApp
//   Ctrl+P    = imprimer / PDF           Échap = fermer modale/suggestions
//   Entrée    (champ SKU) = ajoute le produit exact (scan code-barres)
//
//  RBAC INTÉGRÉ
//   ADMIN        : coûts + marges visibles, modifie tout.
//   COMMERCIAL   : prix d'achat / coût / marge MASQUÉS STRICTEMENT.
//   ACCOUNTANT   : lecture seule.
//   STOREKEEPER  : n'a pas accès à cet écran (géré par la navigation).
// ============================================================================
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  computeDocTotals,
  computeLine,
  timbreForPayment,
  type DocLineInput,
  type DocLineComputed,
  type DocTotals,
  type PaymentMethod,
  type TvaRate,
} from "../fiscal/engine";

// ---------------------------------------------------------------------------
// Types partagés
// ---------------------------------------------------------------------------
export type Role = "ADMIN" | "COMMERCIAL" | "STOREKEEPER" | "ACCOUNTANT";
export type DocType = "DEVIS" | "BL" | "FACTURE";

export interface ClientLite {
  id: number;
  name: string;
  nif: string;
  phone: string; // +213...
}

export interface ProductLite {
  id: number;
  sku: string;
  barcode?: string;
  name: string;
  unit: string;
  kind: "PRODUCT" | "SERVICE";
  salePriceHt: number;
  tvaRate: TvaRate;
  /** Coût posé DZD — champ SENSIBLE : jamais sérialisé pour les rôles sans droit. */
  costDzd: number;
  stock: number;
}

/** Structure JSON du document (payload envoyé au main-process). */
export interface InvoicePayload {
  docType: DocType;
  number: string;
  date: string;
  clientId: number;
  paymentMethod: PaymentMethod;
  currency: string;
  fxRate: number;
  items: Array<{
    productId: number | null;
    name: string;
    qty: number;
    unit: string;
    unitPriceHt: number;
    discountRate: number;
    tvaRate: TvaRate;
  }>;
  totals: DocTotals;
}

interface Props {
  role: Role;
  userCanEditPrices: boolean;
  clients: ClientLite[];
  products: ProductLite[];
  docType: DocType;
  numberPreview: string; // FA-2026-000012 (séquence preview côté app)
  date: string; // YYYY-MM-DD
  companyNif: string;
  demo: { isDemo: boolean; remaining: number };
  onSave: (p: InvoicePayload) => Promise<void>;
  onPrint: (p: InvoicePayload) => void;
  onWhatsApp: (p: InvoicePayload & { clientName: string; clientPhone: string }) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const fmtDZD = (n: number) =>
  new Intl.NumberFormat("fr-DZ", { style: "currency", currency: "DZD" }).format(n);

const norm = (s: string) =>
  s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const parseNum = (s: string, fallback = 0) => {
  const v = parseFloat(s.replace(",", "."));
  return Number.isFinite(v) ? v : fallback;
};

let lineSeq = 0;
const nextLineKey = () => `L${Date.now()}_${lineSeq++}`;

interface DraftLine {
  key: string;
  productId: number | null;
  name: string;
  qty: number;
  unit: string;
  unitPriceHt: number;
  discountRate: number; // 0..1
  tvaRate: TvaRate;
  costUnitDzd: number;
  stock: number;
}

// ---------------------------------------------------------------------------
// WhatsApp + QR
// ---------------------------------------------------------------------------
export function buildWhatsAppLink(phone: string, text: string): string {
  let d = phone.replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  return `https://wa.me/${d}?text=${encodeURIComponent(text)}`;
}

export function buildWhatsAppMessage(d: {
  docType: DocType;
  number: string;
  date: string;
  clientName: string;
  totalTtc: number;
  timbre: number;
  totalDue: number;
  nif: string;
  footer?: string;
}): string {
  const kind = d.docType === "FACTURE" ? "facture" : d.docType === "BL" ? "bon de livraison" : "devis";
  return [
    `Bonjour ${d.clientName},`,
    ``,
    `Veuillez trouver ci-joint notre ${kind} N° ${d.number} du ${d.date}.`,
    ``,
    `• Montant TTC : ${d.totalTtc.toFixed(2)} DA`,
    d.timbre > 0 ? `• Droit de timbre : ${d.timbre.toFixed(2)} DA` : null,
    `• TOTAL À RÉGLER : ${d.totalDue.toFixed(2)} DA`,
    ``,
    `NIF vendeur : ${d.nif}`,
    d.footer ?? `Le PDF du document est joint.`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Charge du QR code gravé sur le PDF (vérification instantanée client). */
export function buildQrPayload(d: {
  number: string;
  date: string;
  nif: string;
  clientName: string;
  totalDue: number;
}): string {
  return `PROFAST|${d.number}|${d.date}|NIF:${d.nif}|${d.clientName}|${d.totalDue.toFixed(2)} DZD`;
}

// ---------------------------------------------------------------------------
// Composant
// ---------------------------------------------------------------------------
export default function InvoiceFastEditor(props: Props) {
  const {
    role, userCanEditPrices, clients, products, docType,
    numberPreview, date, companyNif, demo,
  } = props;

  const readOnly = role === "ACCOUNTANT";
  const canSeeCost = role === "ADMIN";
  const canEditPrices = (role === "ADMIN" || userCanEditPrices) && !readOnly;
  const applyTimbre = docType === "FACTURE"; // le timbre ne concerne que la facture

  // --- État ---------------------------------------------------------------
  const [clientId, setClientId] = useState<number | "">("");
  const [clientQuery, setClientQuery] = useState("");
  const [clientOpen, setClientOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("CASH");
  const [showQuickProduct, setShowQuickProduct] = useState(false);
  const [saved, setSaved] = useState(false);

  const searchRef = useRef<HTMLInputElement>(null);
  const inputRefs = useRef<Map<string, HTMLInputElement | HTMLSelectElement>>(new Map());

  // Auto-focus permanent sur le champ SKU (démarrage / après ajout)
  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // --- Recherche instantanée (locale, < 10 ms) ----------------------------
  const results = useMemo(() => {
    const q = norm(query);
    if (!q) return [];
    return products
      .filter(
        (p) =>
          norm(p.sku).includes(q) ||
          norm(p.name).includes(q) ||
          (p.barcode ? p.barcode.includes(query.trim()) : false),
      )
      .slice(0, 8);
  }, [query, products]);

  const clientResults = useMemo(() => {
    const q = norm(clientQuery);
    if (!q) return [];
    return clients.filter((c) => norm(c.name).includes(q) || (c.nif && c.nif.includes(q))).slice(0, 8);
  }, [clientQuery, clients]);

  // --- Lignes --------------------------------------------------------------
  const makeLine = useCallback(
    (p: ProductLite): DraftLine => ({
      key: nextLineKey(),
      productId: p.id,
      name: p.name,
      qty: 1,
      unit: p.unit,
      unitPriceHt: p.salePriceHt,
      discountRate: 0,
      tvaRate: p.tvaRate,
      costUnitDzd: canSeeCost ? p.costDzd : 0, // jamais exposé au COMMERCIAL
      stock: p.stock,
    }),
    [canSeeCost],
  );

  const addProduct = useCallback(
    (p: ProductLite) => {
      setLines((ls) => {
        const i = ls.findIndex((l) => l.productId === p.id);
        if (i >= 0) {
          return ls.map((l, j) => (j === i ? { ...l, qty: round2(l.qty + 1) } : l));
        }
        return [...ls, makeLine(p)];
      });
      setQuery("");
      setSuggestOpen(false);
      searchRef.current?.focus();
    },
    [makeLine],
  );

  const addEmptyLine = useCallback(() => {
    setLines((ls) => [
      ...ls,
      {
        key: nextLineKey(),
        productId: null,
        name: "",
        qty: 1,
        unit: "U",
        unitPriceHt: 0,
        discountRate: 0,
        tvaRate: 0.19,
        costUnitDzd: 0,
        stock: 0,
      },
    ]);
  }, []);

  const addQuickProduct = useCallback((p: ProductLite) => {
    addProduct(p);
    setShowQuickProduct(false);
  }, [addProduct]);

  const patchLine = useCallback((key: string, patch: Partial<DraftLine>) => {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }, []);

  const removeLine = useCallback((key: string) => {
    setLines((ls) => ls.filter((l) => l.key !== key));
  }, []);

  const focusNext = useCallback(
    (key: string, field: "qty" | "price" | "disc" | "tva") => {
      const order: Array<"qty" | "price" | "disc" | "tva"> = ["qty", "price", "disc", "tva"];
      const idx = order.indexOf(field);
      setLines((ls) => {
        const i = ls.findIndex((l) => l.key === key);
        if (i < 0) return ls;
        if (idx < order.length - 1) {
          requestAnimationFrame(() => inputRefs.current.get(`${key}:${order[idx + 1]}`)?.focus());
        } else if (i < ls.length - 1) {
          requestAnimationFrame(() => inputRefs.current.get(`${ls[i + 1].key}:qty`)?.focus());
        } else {
          requestAnimationFrame(() => searchRef.current?.focus());
        }
        return ls;
      });
    },
    [],
  );

  // --- Totaux (recalcul mémorisé) ------------------------------------------
  const computed: DocLineComputed[] = useMemo(
    () => lines.map((l) => computeLine({ ...toInput(l) }, 1)),
    [lines],
  );

  const totals = useMemo(
    () => computeDocTotals(computed, { applyTimbre }),
    [computed, applyTimbre],
  );

  const timbre = useMemo(
    () => timbreForPayment(totals.totalTtc, paymentMethod),
    [totals.totalTtc, paymentMethod],
  );

  const client = useMemo(() => clients.find((c) => c.id === clientId), [clientId, clients]);

  // --- Persistance ----------------------------------------------------------
  const buildPayload = useCallback((): InvoicePayload => {
    return {
      docType,
      number: numberPreview,
      date,
      clientId: clientId as number,
      paymentMethod,
      currency: "DZD",
      fxRate: 1,
      items: lines.map((l) => ({
        productId: l.productId,
        name: l.name,
        qty: l.qty,
        unit: l.unit,
        unitPriceHt: l.unitPriceHt,
        discountRate: l.discountRate,
        tvaRate: l.tvaRate,
      })),
      totals,
    };
  }, [docType, numberPreview, date, clientId, paymentMethod, lines, totals]);

  const canSave = clientId !== "" && lines.some((l) => l.qty > 0 && l.unitPriceHt > 0);

  const save = useCallback(async () => {
    if (!canSave || saved) return;
    await props.onSave(buildPayload()); // backend : recalcul fiscal + n° + stock + audit
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }, [canSave, saved, props, buildPayload]);

  const print = useCallback(() => {
    if (!canSave) return;
    props.onPrint(buildPayload());
  }, [canSave, props, buildPayload]);

  const whatsApp = useCallback(() => {
    if (!canSave || !client) return;
    props.onWhatsApp({
      ...buildPayload(),
      clientName: client.name,
      clientPhone: client.phone,
    });
  }, [canSave, client, props, buildPayload]);

  // --- Raccourcis clavier ----------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F2") { e.preventDefault(); addEmptyLine(); }
      else if (e.key === "F5") { e.preventDefault(); setShowQuickProduct(true); }
      else if (e.key === "F9") { e.preventDefault(); void save(); }
      else if (e.key === "F12") { e.preventDefault(); whatsApp(); }
      else if (e.key === "Escape") {
        setSuggestOpen(false);
        setShowQuickProduct(false);
      } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault(); print();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [addEmptyLine, save, whatsApp, print]);

  // --- Rendu -----------------------------------------------------------------
  return (
    <div className="flex h-full flex-col bg-slate-100 text-slate-900">
      {/* Bandeau document */}
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-2 shadow-sm">
        <div className="flex items-center gap-3">
          <span className="rounded-md bg-blue-600 px-2.5 py-1 text-xs font-bold tracking-wide text-white">
            {docType === "FACTURE" ? "FACTURE" : docType === "BL" ? "BON DE LIVRAISON" : "DEVIS"}
          </span>
          <h1 className="text-lg font-semibold">{numberPreview}</h1>
          <span className="text-sm text-slate-500">{date}</span>
          {demo.isDemo && (
            <span className="rounded-md bg-amber-100 px-2 py-1 text-xs font-semibold text-amber-800">
              MODE DÉMO — {demo.remaining} facture(s) restante(s)
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 text-xs text-slate-500">
          <kbd className="rounded bg-slate-100 px-1.5 py-0.5">F2</kbd> ligne
          <kbd className="rounded bg-slate-100 px-1.5 py-0.5">F5</kbd> article
          <kbd className="rounded bg-slate-100 px-1.5 py-0.5">F9</kbd> OK
          <kbd className="rounded bg-slate-100 px-1.5 py-0.5">F12</kbd> WhatsApp
          <kbd className="rounded bg-slate-100 px-1.5 py-0.5">Ctrl+P</kbd> PDF
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* ---------------------- Colonne gauche : saisie ---------------------- */}
        <div className="flex min-w-0 flex-1 flex-col gap-3 p-3">
          {/* Recherche produits / code-barres */}
          <div className="relative">
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setSuggestOpen(true);
              }}
              onFocus={() => setSuggestOpen(true)}
              onBlur={() => setTimeout(() => setSuggestOpen(false), 150)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && results.length > 0) {
                  e.preventDefault();
                  addProduct(results[0]);
                }
              }}
              placeholder="⌂  Scanner un code-barres ou taper (réf / nom)…"
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm shadow-sm outline-none ring-blue-500 transition focus:ring-2 disabled:opacity-60"
              disabled={readOnly}
            />
            {suggestOpen && results.length > 0 && (
              <ul className="absolute z-20 mt-1 max-h-72 w-full overflow-auto rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
                {results.map((p) => (
                  <li key={p.id}>
                    <button
                      onMouseDown={(e) => { e.preventDefault(); addProduct(p); }}
                      className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-blue-50"
                    >
                      <span className="truncate">
                        <span className="font-mono text-xs text-slate-500">{p.sku}</span>
                        <span className="ml-2">{p.name}</span>
                      </span>
                      <span className="shrink-0 text-right">
                        <span className="font-medium">{fmtDZD(p.salePriceHt)}</span>
                        <span className="ml-2 text-xs text-slate-400">TVA {(p.tvaRate * 100).toFixed(0)}%</span>
                        {p.kind === "PRODUCT" && (
                          <span className={`ml-2 text-xs ${p.stock <= 0 ? "text-red-500" : "text-slate-400"}`}>
                            stock {p.stock}
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Tableau des lignes */}
          <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-slate-200 bg-white shadow-sm">
            <table className="w-full border-collapse text-sm">
              <thead className="sticky top-0 z-10 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2 text-left">Désignation</th>
                  <th className="w-20 px-2 py-2 text-right">Qté</th>
                  <th className="w-28 px-2 py-2 text-right">PU HT</th>
                  <th className="w-20 px-2 py-2 text-right">Rem.%</th>
                  <th className="w-20 px-2 py-2 text-right">TVA</th>
                  <th className="w-28 px-2 py-2 text-right">Total TTC</th>
                  {canSeeCost && <th className="w-28 px-2 py-2 text-right">Marge</th>}
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => {
                  const c = computed.find((x) => x.name === l.name && x.unitPriceHt === l.unitPriceHt && x.qty === l.qty);
                  const lineTotal = c ?? computeLine(toInput(l), 1);
                  const outOfStock = l.productId !== null && l.qty > l.stock;
                  return (
                    <tr key={l.key} className="border-t border-slate-100 hover:bg-slate-50/60">
                      <td className="max-w-0 px-3 py-1.5">
                        <input
                          value={l.name}
                          onChange={(e) => patchLine(l.key, { name: e.target.value })}
                          disabled={readOnly || l.productId !== null}
                          placeholder="Désignation (prestation à la volée…)"
                          className="w-full bg-transparent text-sm outline-none"
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <input
                          ref={(el) => { if (el) inputRefs.current.set(`${l.key}:qty`, el); }}
                          type="number" min={0} step="any"
                          value={l.qty}
                          disabled={readOnly}
                          onChange={(e) => patchLine(l.key, { qty: parseNum(e.target.value) })}
                          onKeyDown={(e) => e.key === "Enter" && focusNext(l.key, "qty")}
                          className={cnNum(outOfStock)}
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <input
                          ref={(el) => { if (el) inputRefs.current.set(`${l.key}:price`, el); }}
                          type="number" min={0} step="0.01"
                          value={l.unitPriceHt}
                          disabled={readOnly || !canEditPrices}
                          onChange={(e) => patchLine(l.key, { unitPriceHt: parseNum(e.target.value) })}
                          onKeyDown={(e) => e.key === "Enter" && focusNext(l.key, "price")}
                          className="w-full rounded bg-transparent px-2 py-1 text-right text-sm outline-none ring-blue-500 focus:ring-1 disabled:bg-slate-50"
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <input
                          ref={(el) => { if (el) inputRefs.current.set(`${l.key}:disc`, el); }}
                          type="number" min={0} max={100} step="1"
                          value={l.discountRate * 100}
                          disabled={readOnly || !canEditPrices}
                          onChange={(e) => patchLine(l.key, { discountRate: parseNum(e.target.value, 0) / 100 })}
                          onKeyDown={(e) => e.key === "Enter" && focusNext(l.key, "disc")}
                          className="w-full rounded bg-transparent px-2 py-1 text-right text-sm outline-none ring-blue-500 focus:ring-1 disabled:bg-slate-50"
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <select
                          ref={(el) => { if (el) inputRefs.current.set(`${l.key}:tva`, el); }}
                          value={l.tvaRate}
                          disabled={readOnly || !canEditPrices}
                          onChange={(e) =>
                            patchLine(l.key, { tvaRate: parseFloat(e.target.value) as TvaRate })
                          }
                          className="w-full rounded bg-transparent px-1 py-1 text-right text-sm outline-none"
                        >
                          <option value={0.19}>19 %</option>
                          <option value={0.09}>9 %</option>
                          <option value={0}>0 %</option>
                        </select>
                      </td>
                      <td className="px-2 py-1.5 text-right font-medium tabular-nums">
                        {fmtDZD(lineTotal.amountTtc)}
                      </td>
                      {canSeeCost && (
                        <td
                          className={`px-2 py-1.5 text-right tabular-nums ${
                            lineTotal.marginDzd < 0 ? "font-semibold text-red-600" : "text-emerald-700"
                          }`}
                          title={`Coût : ${fmtDZD(lineTotal.costDzd)}`}
                        >
                          {fmtDZD(lineTotal.marginDzd)}
                          <span className="ml-1 text-xs text-slate-400">({lineTotal.marginPct}%)</span>
                        </td>
                      )}
                      <td className="px-1 py-1.5 text-center">
                        <button
                          onClick={() => removeLine(l.key)}
                          disabled={readOnly}
                          className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-40"
                          aria-label="Supprimer la ligne"
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {lines.length === 0 && (
                  <tr>
                    <td colSpan={canSeeCost ? 8 : 7} className="px-3 py-10 text-center text-sm text-slate-400">
                      Scannez un code-barres ou tapez une référence — <kbd className="rounded bg-slate-100 px-1">F2</kbd> pour une ligne libre
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* ---------------------- Colonne droite : client + totaux ------------- */}
        <aside className="flex w-80 shrink-0 flex-col gap-3 overflow-auto border-l border-slate-200 bg-white p-3">
          {/* Client */}
          <div className="relative">
            <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">Client</label>
            <input
              value={clientOpen ? clientQuery : client?.name ?? clientQuery}
              onChange={(e) => { setClientQuery(e.target.value); setClientOpen(true); }}
              onFocus={() => setClientOpen(true)}
              onBlur={() => setTimeout(() => setClientOpen(false), 150)}
              placeholder="Rechercher le client (nom / NIF)…"
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm shadow-sm outline-none ring-blue-500 focus:ring-2"
              disabled={readOnly}
            />
            {clientOpen && clientResults.length > 0 && (
              <ul className="absolute z-20 mt-1 w-full overflow-auto rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
                {clientResults.map((c) => (
                  <li key={c.id}>
                    <button
                      onMouseDown={(e) => { e.preventDefault(); setClientId(c.id); setClientQuery(""); }}
                      className="block w-full truncate px-3 py-2 text-left text-sm hover:bg-blue-50"
                    >
                      {c.name} <span className="text-xs text-slate-400">· NIF {c.nif || "—"}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {client && (
              <p className="mt-1 text-xs text-slate-500">
                {client.nif && <>NIF {client.nif} · </>}{client.phone}
              </p>
            )}
          </div>

          {/* Mode de paiement */}
          <div>
            <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">Mode de paiement</label>
            <select
              value={paymentMethod}
              onChange={(e) => setPaymentMethod(e.target.value as PaymentMethod)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm shadow-sm outline-none"
              disabled={readOnly}
            >
              <option value="CASH">Espèces (reçu timbré)</option>
              <option value="CHECK">Chèque</option>
              <option value="TRANSFER">Virement</option>
              <option value="CREDIT">Crédit client</option>
            </select>
          </div>

          {/* Totaux */}
          <div className="rounded-lg bg-slate-50 p-3 text-sm">
            <Row label="Total HT" value={fmtDZD(totals.totalHt)} />
            {totals.totalDiscount > 0 && (
              <Row label="Remises" value={`− ${fmtDZD(totals.totalDiscount)}`} />
            )}
            {totals.tvaByRate.map((r) => (
              <Row
                key={r.rate}
                label={r.rate === 0 ? "Exonéré (0 %)" : `TVA ${(r.rate * 100).toFixed(0)} %`}
                value={fmtDZD(r.tva)}
              />
            ))}
            <Row label="Total TTC" value={fmtDZD(totals.totalTtc)} strong />
            {applyTimbre && (
              <>
                <Row label="Timbre fiscal (1 %)" value={fmtDZD(totals.timbre)} />
                {timbre.timbreRecu > 0 && (
                  <Row label="Timbre reçu (espèces)" value={fmtDZD(timbre.timbreRecu)} muted />
                )}
              </>
            )}
            <div className="mt-2 flex items-center justify-between border-t border-slate-200 pt-2">
              <span className="font-semibold">Total à régler</span>
              <span className="text-lg font-bold tabular-nums text-blue-700">
                {fmtDZD(totals.totalDue)}
              </span>
            </div>
          </div>

          {/* Marge — ADMIN UNIQUEMENT (jamais rendue pour les autres rôles) */}
          {canSeeCost && (
            <div className={`rounded-lg p-3 text-sm ${totals.marginDzd < 0 ? "bg-red-50" : "bg-emerald-50"}`}>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Marge réelle (DZD)</p>
              <p className={`mt-1 text-xl font-bold tabular-nums ${totals.marginDzd < 0 ? "text-red-700" : "text-emerald-700"}`}>
                {fmtDZD(totals.marginDzd)}
                <span className="ml-2 text-sm font-medium">({totals.marginPct} %)</span>
              </p>
              <p className="mt-0.5 text-xs text-slate-500">Coût posé : {fmtDZD(totals.costDzd)}</p>
            </div>
          )}

          {/* Actions */}
          <div className="mt-auto grid grid-cols-2 gap-2">
            <button
              onClick={() => void save()}
              disabled={!canSave || readOnly || saved}
              className="col-span-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saved ? "✓ Enregistré" : "Enregistrer (F9)"}
            </button>
            <button
              onClick={print}
              disabled={!canSave || readOnly}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium shadow-sm transition hover:bg-slate-50 disabled:opacity-50"
            >
              🖨 PDF
            </button>
            <button
              onClick={whatsApp}
              disabled={!canSave || readOnly || !client}
              className="rounded-lg border border-emerald-600 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-700 shadow-sm transition hover:bg-emerald-100 disabled:opacity-50"
            >
              💬 WhatsApp
            </button>
          </div>
        </aside>
      </div>

      {/* Modale « article à la volée » (F5) */}
      {showQuickProduct && <QuickProductModal role={role} onClose={() => setShowQuickProduct(false)} onCreated={addQuickProduct} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sous-composants
// ---------------------------------------------------------------------------
function Row({ label, value, strong, muted }: { label: string; value: string; strong?: boolean; muted?: boolean }) {
  return (
    <div className="flex items-center justify-between py-0.5">
      <span className={muted ? "text-xs text-slate-400" : "text-slate-600"}>{label}</span>
      <span className={strong ? "font-semibold tabular-nums" : "tabular-nums"}>{value}</span>
    </div>
  );
}

const cnNum = (warn: boolean) =>
  `w-full rounded px-2 py-1 text-right text-sm outline-none ring-blue-500 focus:ring-1 ${
    warn ? "bg-red-50 text-red-700" : ""
  }`;

function toInput(l: DraftLine): DocLineInput {
  return {
    name: l.name,
    qty: l.qty,
    unitPriceHt: l.unitPriceHt,
    discountRate: l.discountRate,
    tvaRate: l.tvaRate,
    unit: l.unit,
    costUnitDzd: l.costUnitDzd,
  };
}

/** Création d'article « à la volée » pendant la saisie (F5). */
function QuickProductModal({
  role, onClose, onCreated,
}: {
  role: Role;
  onClose: () => void;
  onCreated: (p: ProductLite) => void;
}) {
  const canSeeCost = role === "ADMIN";
  const [sku, setSku] = useState("");
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"PRODUCT" | "SERVICE">("PRODUCT");
  const [sale, setSale] = useState("0");
  const [cost, setCost] = useState("0");
  const [tva, setTva] = useState<TvaRate>(0.19);
  const [unit, setUnit] = useState("U");

  const create = () => {
    // Backend : INSERT products (+ prix) puis retour du produit complet.
    // Ici : simulation locale immédiate pour la fluidité de la saisie.
    onCreated({
      id: -1, // id réel renvoyé par le main-process
      sku: sku || `TEMP-${Date.now()}`,
      name: name || "Prestation",
      unit,
      kind,
      salePriceHt: parseNum(sale),
      tvaRate: tva,
      costDzd: canSeeCost ? parseNum(cost) : 0,
      stock: 0,
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <div className="w-full max-w-md rounded-xl bg-white p-4 shadow-2xl">
        <h2 className="text-sm font-bold uppercase tracking-wide text-slate-600">
          Nouveau article « à la volée » (F5)
        </h2>
        <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
          <input autoFocus value={sku} onChange={(e) => setSku(e.target.value)} placeholder="Réf / code-barres" className="rounded border border-slate-300 px-2 py-1.5" />
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Désignation" className="rounded border border-slate-300 px-2 py-1.5" />
          <select value={kind} onChange={(e) => setKind(e.target.value as "PRODUCT" | "SERVICE")} className="rounded border border-slate-300 px-2 py-1.5">
            <option value="PRODUCT">Produit (stock)</option>
            <option value="SERVICE">Prestation (sans stock)</option>
          </select>
          <input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="Unité (U, KG…)" className="rounded border border-slate-300 px-2 py-1.5" />
          <input type="number" value={sale} onChange={(e) => setSale(e.target.value)} placeholder="Prix de vente HT (DA)" className="rounded border border-slate-300 px-2 py-1.5" />
          {canSeeCost && (
            <input type="number" value={cost} onChange={(e) => setCost(e.target.value)} placeholder="Coût posé (DA)" className="rounded border border-slate-300 px-2 py-1.5" />
          )}
          <select value={tva} onChange={(e) => setTva(parseFloat(e.target.value) as TvaRate)} className="rounded border border-slate-300 px-2 py-1.5">
            <option value={0.19}>TVA 19 %</option>
            <option value={0.09}>TVA 9 %</option>
            <option value={0}>Exonéré 0 %</option>
          </select>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100">Annuler (Échap)</button>
          <button onClick={create} className="rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-blue-700">
            Créer et ajouter
          </button>
        </div>
      </div>
    </div>
  );
}
