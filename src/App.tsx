// ============================================================================
//  ProFast Facture — Shell applicatif
//  Boot : licence (gate HWID) → login PIN → navigation RBAC
// ============================================================================
import { useCallback, useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-shell";
import QRCode from "qrcode";
import { api } from "./api";
import InvoiceFastEditor, {
  buildQrPayload,
  buildWhatsAppLink,
  buildWhatsAppMessage,
  type InvoicePayload,
} from "./components/InvoiceFastEditor";
import { buildInvoiceHtml, type PdfLine } from "./templates/invoiceHtml";
import { computeLine } from "./fiscal/engine";
import ActivationScreen from "./pages/ActivationScreen";
import LoginScreen from "./pages/LoginScreen";
import DashboardScreen from "./pages/DashboardScreen";
import G50Screen from "./pages/G50Screen";
import StockScreen from "./pages/StockScreen";
import CatalogScreen from "./pages/CatalogScreen";
import PurchasesScreen from "./pages/PurchasesScreen";
import InventoryScreen from "./pages/InventoryScreen";
import UsersScreen from "./pages/UsersScreen";
import ChangePinGate from "./pages/ChangePinGate";
import type {
  ClientLite,
  DocType,
  LicenseStatus,
  ProductLite,
  Role,
  Totals,
  UserSession,
} from "./types";

type PageId = "dashboard" | "invoice" | "g50" | "stock" | "catalog" | "purchases" | "inventory" | "users";
type Stage = "boot" | "activation" | "login" | "app";

const NAV: Array<{ id: PageId; label: string; icon: string; roles: Role[] }> = [
  { id: "dashboard", label: "Tableau de bord", icon: "📊", roles: ["ADMIN", "ACCOUNTANT"] },
  { id: "invoice", label: "Facturation rapide", icon: "⚡", roles: ["ADMIN", "COMMERCIAL"] },
  { id: "g50", label: "Pré-état G50", icon: "🧾", roles: ["ADMIN", "ACCOUNTANT"] },
  { id: "stock", label: "Stock & Dépôts", icon: "📦", roles: ["ADMIN", "STOREKEEPER"] },
  { id: "purchases", label: "Achats & Fournisseurs", icon: "📥", roles: ["ADMIN", "ACCOUNTANT"] },
  { id: "inventory", label: "Inventaires", icon: "🔢", roles: ["ADMIN", "STOREKEEPER"] },
  { id: "catalog", label: "Catalogue", icon: "🗂️", roles: ["ADMIN"] },
  { id: "users", label: "Utilisateurs & rôles", icon: "👥", roles: ["ADMIN"] },
];

const today = () => new Date().toISOString().slice(0, 10);

export default function App() {
  const [stage, setStage] = useState<Stage>("boot");
  const [lic, setLic] = useState<LicenseStatus | null>(null);
  const [session, setSession] = useState<UserSession | null>(null);
  const [clients, setClients] = useState<ClientLite[]>([]);
  const [products, setProducts] = useState<ProductLite[]>([]);
  const [config, setConfig] = useState<Awaited<ReturnType<typeof api.preload>>["config"] | null>(null);
  const [users, setUsers] = useState<Awaited<ReturnType<typeof api.preload>>["users"]>([]);
  const [page, setPage] = useState<PageId>("invoice");
  const [docType, setDocType] = useState<DocType>("FACTURE");
  const [numberPreview, setNumberPreview] = useState("…");
  const [demoRemaining, setDemoRemaining] = useState(10);
  const [editorKey, setEditorKey] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [pinGate, setPinGate] = useState(false);

  // ---- Boot : fenêtre de vérification licence (HWID) -----------------------
  useEffect(() => {
    void (async () => {
      try {
        const st = await api.licenseStatus();
        setLic(st);
        setDemoRemaining(Math.min(st.demo_remaining, 10));
        if (st.active) {
          const p = await api.preload();
          setUsers(p.users);
          setStage("login");
        } else {
          setStage("activation");
        }
      } catch (e) {
        setFatal(String(e));
      }
    })();
  }, []);

  const afterLicense = async (st: LicenseStatus) => {
    setLic(st);
    const p = await api.preload();
    setUsers(p.users);
    setStage("login");
  };

  const onLogin = useCallback(async (s: UserSession) => {
    setSession(s);
    // Pré-chargement avec masquage RBAC (les coûts ne sortent que pour ADMIN)
    const p = await api.preload();
    setClients(p.clients);
    setProducts(p.products);
    setConfig(p.config);
    const first = NAV.find((n) => n.roles.includes(s.role));
    setPage(first?.id ?? "invoice");
    setPinGate(s.must_change_pin); // sécurité : PIN initial à changer (créé par le gérant)
    setStage("app");
  }, []);

  // ---- Numéro preview (séquence par type/année) ----------------------------
  useEffect(() => {
    if (stage !== "app") return;
    void api.nextNumber(docType).then(setNumberPreview).catch(() => setNumberPreview("…"));
  }, [stage, docType, editorKey]);

  // ---- Sauvegarde de facture (garde-fou Démo + recalcul serveur) ------------
  const handleSave = useCallback(
    async (payload: InvoicePayload) => {
      const guard = await api.canCreate();
      if (!guard.ok) throw new Error("Mode Démo épuisé (10 factures) — activez une licence.");
      const saved = await api.saveInvoice({
        doc_type: payload.docType,
        client_id: payload.clientId,
        date: payload.date,
        payment_method: payload.paymentMethod,
        currency: payload.currency as "DZD",
        fx_rate: payload.fxRate,
        notes: null,
        items: payload.items.map((i) => ({
          product_id: i.productId,
          name: i.name,
          qty: i.qty,
          unit: i.unit,
          unit_price_ht: i.unitPriceHt,
          discount_rate: i.discountRate,
          tva_rate: i.tvaRate,
        })),
      });
      if (saved.demo_remaining < u32max()) setDemoRemaining(saved.demo_remaining);
      setToast(`✓ ${saved.number} enregistré(e) — total ${fmtDA(saved.totals.total_due)}`);
      setTimeout(() => setToast(null), 4000);
      setEditorKey((k) => k + 1); // réinitialise la saisie
    },
    [],
  );

  // ---- PDF local (QR + cachet + signature) ----------------------------------
  const handlePrint = useCallback(
    async (payload: InvoicePayload) => {
      if (!config) return;
      const client = clients.find((c) => c.id === payload.clientId);
      if (!client) return;
      const qrDataUrl = await QRCode.toDataURL(
        buildQrPayload({
          number: payload.number,
          date: payload.date,
          nif: config.nif ?? "",
          clientName: client.name,
          totalDue: payload.totals.totalDue,
        }),
        { width: 320, margin: 1 },
      );
      const img = async (path: string | null) => {
        if (!path) return null;
        try {
          return await api.readLocalImage(path);
        } catch {
          return null;
        }
      };
      const [logo, stamp, signature] = await Promise.all([
        img(config.logo_png_path),
        img(config.stamp_png_path),
        img(config.signature_png_path),
      ]);
      const lines: PdfLine[] = payload.items.map((i) => {
        const c = computeLine(i, payload.fxRate);
        return {
          name: i.name, qty: i.qty, unit: i.unit, unit_price_ht: i.unitPriceHt,
          discount_rate: i.discountRate, tva_rate: i.tvaRate,
          amount_ht: c.amountHt, amount_tva: c.amountTva, amount_ttc: c.amountTtc,
        };
      });
      // Conversion DocTotals (camelCase UI) -> Totals (snake_case Rust)
      const totals: Totals = {
        total_ht: payload.totals.totalHt,
        total_discount: payload.totals.totalDiscount,
        total_tva: payload.totals.totalTva,
        total_ttc: payload.totals.totalTtc,
        tva_by_rate: payload.totals.tvaByRate.map((r) => ({
          rate: r.rate, base: r.base, tva: r.tva,
        })),
        timbre: payload.totals.timbre,
        total_due: payload.totals.totalDue,
        cost_dzd: payload.totals.costDzd,
        margin_dzd: payload.totals.marginDzd,
        margin_pct: payload.totals.marginPct,
      };
      const html = buildInvoiceHtml({
        docType: payload.docType,
        number: payload.number,
        date: payload.date,
        client: { name: client.name, nif: client.nif, phone: client.phone },
        company: config,
        lines,
        totals,
        paymentMethod: payload.paymentMethod,
        qrDataUrl,
        logoDataUrl: logo,
        stampDataUrl: stamp,
        signatureDataUrl: signature,
      });
      const dir = await api.pdfOutDir();
      await api.printPdf(html, `${dir}/${payload.number}.pdf`);
    },
    [config, clients],
  );

  // ---- WhatsApp (lien wa.me pré-rempli, ouverture locale) --------------------
  const handleWhatsApp = useCallback(
    (payload: InvoicePayload & { clientName: string; clientPhone: string }) => {
      if (!config) return;
      const text = buildWhatsAppMessage({
        docType: payload.docType,
        number: payload.number,
        date: payload.date,
        clientName: payload.clientName,
        totalTtc: payload.totals.totalTtc,
        timbre: payload.totals.timbre,
        totalDue: payload.totals.totalDue,
        nif: config.nif ?? "",
        footer: config.whatsapp_footer ?? "Le PDF du document est joint.",
      });
      void open(buildWhatsAppLink(payload.clientPhone, text));
    },
    [config],
  );

  // ---- Rendu ------------------------------------------------------------------
  if (fatal) {
    return (
      <div className="flex h-full items-center justify-center bg-red-50 p-8 text-red-700">
        Erreur fatale : {fatal}
      </div>
    );
  }
  if (stage === "boot") {
    return (
      <div className="flex h-full items-center justify-center bg-slate-100 text-slate-400">
        Chargement…
      </div>
    );
  }
  if (stage === "activation" && lic) {
    return <ActivationScreen status={lic} onActivated={(s) => void afterLicense(s)} />;
  }
  if (stage === "login") {
    return <LoginScreen users={users} onLogin={(s) => void onLogin(s)} />;
  }

  // Stage : application
  if (!session || !config) return null;
  if (pinGate) {
    return (
      <ChangePinGate
        userName={session.full_name}
        onDone={() => setPinGate(false)}
        onCancel={() => {
          setSession(null);
          setPinGate(false);
          setStage("login");
        }}
      />
    );
  }
  const nav = NAV.filter((n) => n.roles.includes(session.role));
  const isDemo = lic ? !lic.active : false;

  return (
    <div className="flex h-full">
      {/* Barre latérale */}
      <aside className="flex w-56 shrink-0 flex-col border-r border-slate-200 bg-white">
        <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-600 text-lg">⚡</div>
          <div>
            <p className="text-sm font-bold leading-tight">ProFast</p>
            <p className="text-[10px] leading-tight text-slate-400">Facture — local</p>
          </div>
        </div>
        <nav className="flex-1 space-y-1 p-2">
          {nav.map((n) => (
            <button
              key={n.id}
              onClick={() => setPage(n.id)}
              className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition ${
                page === n.id ? "bg-blue-50 font-semibold text-blue-700" : "text-slate-600 hover:bg-slate-50"
              }`}
            >
              <span>{n.icon}</span> {n.label}
            </button>
          ))}
        </nav>
        <div className="border-t border-slate-100 p-3">
          <p className="truncate text-xs font-medium text-slate-700">{session.full_name}</p>
          <p className="text-[10px] uppercase tracking-wide text-slate-400">{session.role}</p>
          <button
            onClick={() => {
              setSession(null);
              setStage("login");
            }}
            className="mt-2 w-full rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-500 hover:bg-slate-50"
          >
            Changer d'utilisateur
          </button>
        </div>
      </aside>

      {/* Contenu */}
      <main className="min-w-0 flex-1 overflow-auto bg-slate-100">
        {/* Bandeau supérieur */}
        <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-2">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold text-slate-700">
              {nav.find((n) => n.id === page)?.label}
            </h2>
            <span className="text-xs text-slate-400">{config.company_name}</span>
          </div>
          <div className="flex items-center gap-2">
            {isDemo && (
              <span className="rounded-md bg-amber-100 px-2 py-1 text-xs font-semibold text-amber-800">
                MODE DÉMO — {demoRemaining}/10
              </span>
            )}
            {lic?.active && (
              <span className="rounded-md bg-emerald-100 px-2 py-1 text-xs font-semibold text-emerald-700">
                {lic.plan === "LIFETIME" ? "Licence à vie" : `Licence — ${lic.expires_at ? new Date(lic.expires_at * 1000).toLocaleDateString("fr-DZ") : "active"}`}
              </span>
            )}
          </div>
        </header>

        {toast && (
          <div className="mx-4 mt-3 rounded-lg bg-blue-600 px-4 py-2 text-sm text-white shadow">
            {toast}
          </div>
        )}

        {page === "dashboard" && <DashboardScreen />}

        {page === "invoice" && (
          <div className="p-3">
            <div className="mb-2 flex items-center gap-2">
              {(["FACTURE", "BL", "DEVIS"] as DocType[]).map((t) => (
                <button
                  key={t}
                  onClick={() => { setDocType(t); setEditorKey((k) => k + 1); }}
                  className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${
                    docType === t ? "bg-blue-600 text-white" : "bg-white text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  {t === "FACTURE" ? "Facture" : t === "BL" ? "Bon de livraison" : "Devis"}
                </button>
              ))}
              <span className="ml-auto text-xs text-slate-400">
                Prochain n° : <strong className="text-slate-600">{numberPreview}</strong>
              </span>
            </div>
            <div className="h-[calc(100vh-140px)] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
              <InvoiceFastEditor
                key={`${docType}-${editorKey}`}
                role={session.role}
                userCanEditPrices={session.can_edit_prices}
                clients={clients.map((c) => ({ id: c.id, name: c.name, nif: c.nif, phone: c.phone }))}
                products={products.map((p) => ({
                  id: p.id,
                  sku: p.sku,
                  barcode: p.barcode ?? undefined,
                  name: p.name,
                  unit: p.unit,
                  kind: p.kind as "PRODUCT" | "SERVICE",
                  salePriceHt: p.sale_price_ht,
                  tvaRate: p.tva_rate as 0 | 0.09 | 0.19,
                  costDzd: p.cost_dzd,
                  stock: p.stock,
                }))}
                docType={docType}
                numberPreview={numberPreview}
                date={today()}
                companyNif={config.nif ?? ""}
                demo={{ isDemo, remaining: demoRemaining }}
                onSave={handleSave}
                onPrint={(p) => void handlePrint(p)}
                onWhatsApp={handleWhatsApp}
              />
            </div>
          </div>
        )}

        {page === "g50" && <G50Screen />}
        {page === "stock" && <StockScreen canSeeCost={session.role === "ADMIN"} />}
        {page === "purchases" && (
          <PurchasesScreen
            canEdit={session.role === "ADMIN"}
            canSeeCost={session.role === "ADMIN"}
            products={products.map((p) => ({ id: p.id, name: p.name, sku: p.sku, kind: p.kind }))}
          />
        )}
        {page === "inventory" && (
          <InventoryScreen canEdit={session.role === "ADMIN" || session.role === "STOREKEEPER"} />
        )}
        {page === "catalog" && (
          <CatalogScreen products={products} onProducts={setProducts} />
        )}
        {page === "users" && <UsersScreen />}
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
const u32max = () => 4294967295;
const fmtDA = (n: number) =>
  new Intl.NumberFormat("fr-DZ", { style: "currency", currency: "DZD" }).format(n);
