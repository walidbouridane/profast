// ============================================================================
//  ProFast Facture — MOTEUR FISCAL DZ (DZ Engine)
//  TVA 19/9/0 + Timbre fiscal + Pré-état G50 + coûts posés + export comptable.
//
//  TypeScript pur, ZÉRO dépendance : testable (node:test), exécutable dans le
//  webview React ; portage Rust trivial si on veut un calcul côté main-process.
//
//  RÈGLES LÉGALES DZ APPLIQUÉES
//  ─────────────────────────────────────────────────────────────────────────
//  TVA  : barème 19 % (normal), 9 % (réduit), 0 % (exonéré).
//  TIMBRE (Code du timbre, art. 100 — mention obligatoire au paiement espèces) :
//         • 1 % du montant TTC de la facture,
//         • arrondi AU DINAR SUPÉRIEUR,
//         • minimum 5 DA, plafond 2 500 DA,
//         • reçu de caisse : minimum 2 DA.
//  G50  : déclaration mensuelle (section TVA) : TVA collectée (ventes)
//         − TVA déductible (achats) = net à payer  |  crédit à reporter.
//
//  ⚠ Le taux/plafond du timbre et les comptes comptables sont CONFIGURABLES
//    (company_config / ACCOUNTS) : à faire valider par le comptable avant
//    mise en production (barèmes susceptibles d'évoluer par loi de finances).
// ============================================================================

export type TvaRate = 0 | 0.09 | 0.19;
export type Currency = "DZD" | "EUR" | "USD";
export type PaymentMethod = "CASH" | "CHECK" | "TRANSFER" | "CREDIT" | "MIXED";

export interface TimbreConfig {
  /** Taux du timbre sur facture — 1 %. */
  rate: number;
  /** Minimum légal facture — 5 DA. */
  min: number;
  /** Plafond légal facture — 2 500 DA. */
  max: number;
  /** Minimum pour un reçu de caisse (règlement espèces) — 2 DA. */
  receiptMin: number;
}

export const DZ_TIMBRE: TimbreConfig = { rate: 0.01, min: 5, max: 2500, receiptMin: 2 };

export const round2 = (n: number): number =>
  Math.round((n + Number.EPSILON) * 100) / 100;

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

// ----------------------------------------------------------------------------
// 1. TIMBRE FISCAL
// ----------------------------------------------------------------------------

/**
 * Droit de timbre sur facture commerciale (DZ) :
 *   1 % du TTC, arrondi au DINAR SUPÉRIEUR, min 5 DA, plafond 2 500 DA.
 */
export function computeTimbre(totalTtc: number, cfg: TimbreConfig = DZ_TIMBRE): number {
  if (totalTtc <= 0) return 0;
  const value = Math.ceil(round2(totalTtc * cfg.rate));
  return Math.min(Math.max(value, cfg.min), cfg.max);
}

/** Timbre sur reçu de caisse (règlement en espèces) : min 2 DA. */
export function computeReceiptTimbre(totalTtc: number, cfg: TimbreConfig = DZ_TIMBRE): number {
  if (totalTtc <= 0) return 0;
  const value = Math.ceil(round2(totalTtc * cfg.rate));
  return Math.min(Math.max(value, cfg.receiptMin), cfg.max);
}

export interface TimbreBreakdown {
  /** Timbre porté par la facture elle-même. */
  timbreFacture: number;
  /** Timbre du reçu de caisse — dû uniquement si règlement EN ESPÈCES. */
  timbreRecu: number;
  totalTimbre: number;
}

/**
 * Timbre total selon le MODE DE PAIEMENT (pratique comptable DZ) :
 *  - CASH            => facture timbrée + reçu de caisse timbré (min 2 DA)
 *  - CHECK/TRANSFER  => seul le timbre-facture s'applique (pas de reçu)
 *  - CREDIT (crédit client) => timbre-facture seul, pas d'encaissement
 * Le timbre est toujours dû sur le document ; le mode de paiement décide
 * de l'émission du reçu de caisse.
 */
export function timbreForPayment(
  totalTtc: number,
  method: PaymentMethod,
  cfg: TimbreConfig = DZ_TIMBRE,
): TimbreBreakdown {
  const timbreFacture = computeTimbre(totalTtc, cfg);
  const timbreRecu = method === "CASH" ? computeReceiptTimbre(totalTtc, cfg) : 0;
  return { timbreFacture, timbreRecu, totalTimbre: round2(timbreFacture + timbreRecu) };
}

// ----------------------------------------------------------------------------
// 2. LIGNES DE DOCUMENT & MARGE RÉELLE (double monnaie)
// ----------------------------------------------------------------------------

export interface DocLineInput {
  name: string;
  qty: number;
  /** Prix unitaire HT DANS LA DEVISE DU DOCUMENT (DZD/EUR/USD). */
  unitPriceHt: number;
  /** Remise 0..1. */
  discountRate: number;
  tvaRate: TvaRate;
  unit?: string;
  /** Coût unitaire au moment de la vente, déjà EN DZD (coût posé). */
  costUnitDzd?: number;
}

export interface DocLineComputed extends DocLineInput {
  gross: number;
  discountAmount: number;
  amountHt: number;
  amountTva: number;
  amountTtc: number;
  /** Coût total de la ligne en DZD. */
  costDzd: number;
  /** Marge réelle = HT converti en DZD − coût (TVA neutre pour l'entreprise). */
  marginDzd: number;
  marginPct: number;
}

export function computeLine(l: DocLineInput, fxRateDzd: number = 1): DocLineComputed {
  const gross = round2(l.qty * l.unitPriceHt);
  const discountAmount = round2(gross * clamp01(l.discountRate));
  const amountHt = round2(gross - discountAmount);
  const amountTva = round2(amountHt * l.tvaRate);
  const amountTtc = round2(amountHt + amountTva);

  const costDzd = round2((l.costUnitDzd ?? 0) * l.qty);
  const htDzd = round2(amountHt * fxRateDzd);
  const marginDzd = round2(htDzd - costDzd);
  const marginPct = htDzd > 0 ? round2((marginDzd / htDzd) * 100) : 0;

  return {
    ...l,
    gross,
    discountAmount,
    amountHt,
    amountTva,
    amountTtc,
    costDzd,
    marginDzd,
    marginPct,
  };
}

// ----------------------------------------------------------------------------
// 3. TOTAUX DOCUMENT (TVA par taux, timbre, marge)
// ----------------------------------------------------------------------------

export interface DocTotals {
  totalHt: number;
  totalDiscount: number;
  totalTva: number;
  totalTtc: number;
  /** Détail par taux (19 % / 9 % / 0 %) — alimente l'annexe G50. */
  tvaByRate: Array<{ rate: TvaRate; base: number; tva: number }>;
  /** Timbre-facture en DZD (0 si doc non taxé ; appliqué sur FACTURE). */
  timbre: number;
  /** TTC + timbre : montant à régler. */
  totalDue: number;
  costDzd: number;
  marginDzd: number;
  marginPct: number;
}

export function computeDocTotals(
  lines: DocLineComputed[],
  opts: { fxRateDzd?: number; timbreCfg?: TimbreConfig; applyTimbre?: boolean } = {},
): DocTotals {
  const fx = opts.fxRateDzd ?? 1;
  const cfg = opts.timbreCfg ?? DZ_TIMBRE;
  const applyTimbre = opts.applyTimbre ?? true;

  const byRate = new Map<number, { base: number; tva: number }>();
  let totalHt = 0,
    totalDiscount = 0,
    totalTva = 0,
    totalTtc = 0,
    costDzd = 0;

  for (const l of lines) {
    totalHt += l.amountHt;
    totalDiscount += l.discountAmount;
    totalTva += l.amountTva;
    totalTtc += l.amountTtc;
    costDzd += l.costDzd;
    const e = byRate.get(l.tvaRate) ?? { base: 0, tva: 0 };
    e.base += l.amountHt;
    e.tva += l.amountTva;
    byRate.set(l.tvaRate, e);
  }

  totalHt = round2(totalHt);
  totalDiscount = round2(totalDiscount);
  totalTva = round2(totalTva);
  totalTtc = round2(totalTtc);
  costDzd = round2(costDzd);

  const tvaByRate = [...byRate.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([rate, v]) => ({ rate: rate as TvaRate, base: round2(v.base), tva: round2(v.tva) }));

  const timbre = applyTimbre ? computeTimbre(totalTtc, cfg) : 0;
  const htDzd = round2(totalHt * fx);
  const marginDzd = round2(htDzd - costDzd);

  return {
    totalHt,
    totalDiscount,
    totalTva,
    totalTtc,
    tvaByRate,
    timbre,
    totalDue: round2(totalTtc + timbre),
    costDzd,
    marginDzd,
    marginPct: htDzd > 0 ? round2((marginDzd / htDzd) * 100) : 0,
  };
}

// ----------------------------------------------------------------------------
// 4. COÛT POSÉ (landed cost) — double monnaie
// ----------------------------------------------------------------------------

/**
 * Coût de revient en DZD :
 *   DZD : prix achat + frais annexes
 *   EUR/USD : prix achat × taux de change (officiel OU parallèle) + frais
 */
export function computeLandedCostDzd(input: {
  purchasePriceHt: number;
  currency: Currency;
  fxRate: number; // 1 pour DZD
  extraCostsDzd: number;
}): number {
  const base =
    input.currency === "DZD"
      ? input.purchasePriceHt
      : input.purchasePriceHt * input.fxRate;
  return round2(base + input.extraCostsDzd);
}

// ----------------------------------------------------------------------------
// 5. PRÉ-ÉTAT G50 (section TVA) — mensuel ou trimestriel
// ----------------------------------------------------------------------------

export interface G50Period {
  type: "MONTH" | "QUARTER";
  year: number;
  /** Mois de référence 1..12 (pour QUARTER : 1,4,7,10). */
  month: number;
}

export interface G50RateLine {
  rate: TvaRate;
  base: number;
  tva: number;
}

export interface G50Result {
  period: G50Period;
  periodStart: string; // 'YYYY-MM-DD'
  periodEnd: string;   // 'YYYY-MM-DD'
  /** TVA collectée par taux (ventes). */
  collectee: G50RateLine[];
  /** TVA déductible par taux (achats déductibles). */
  deductible: G50RateLine[];
  totalCollectee: number;
  totalDeductible: number;
  /** > 0 : net à payer | < 0 : crédit à reporter | 0 : neutre. */
  balance: number;
  situation: "A_PAYER" | "CREDIT_A_REPORTER" | "NEUTRE";
  /** Ventilation annexe : ventes exonérées 0 % (non imposables, hors base). */
  exemptSalesBase: number;
  /** Achats non déductibles (ex. facture incomplète) — hors G50, à suivre. */
  nonDeductiblePurchasesBase: number;
}

export function computeG50(input: {
  period: G50Period;
  /** Ventes de la période (FACTURE validées, hors avoirs), par taux. */
  sales: Array<{ rate: TvaRate; base: number; tva: number }>;
  /** Achats de la période (factures fournisseurs), par taux + déductibilité. */
  purchases: Array<{ rate: TvaRate; base: number; tva: number; deductible: boolean }>;
}): G50Result {
  const { period, sales, purchases } = input;

  const groupByRate = (rows: Array<{ rate: number; base: number; tva: number }>): G50RateLine[] => {
    const m = new Map<number, { base: number; tva: number }>();
    for (const r of rows) {
      const e = m.get(r.rate) ?? { base: 0, tva: 0 };
      e.base += r.base;
      e.tva += r.tva;
      m.set(r.rate, e);
    }
    return [...m.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([rate, v]) => ({ rate: rate as TvaRate, base: round2(v.base), tva: round2(v.tva) }));
  };

  const collectee = groupByRate(sales);
  const deductible = groupByRate(purchases.filter((p) => p.deductible));

  const totalCollectee = round2(collectee.reduce((a, l) => a + l.tva, 0));
  const totalDeductible = round2(deductible.reduce((a, l) => a + l.tva, 0));
  const balance = round2(totalCollectee - totalDeductible);

  const { start, end } = periodToRange(period);

  return {
    period,
    periodStart: start,
    periodEnd: end,
    collectee,
    deductible,
    totalCollectee,
    totalDeductible,
    balance,
    situation: balance > 0 ? "A_PAYER" : balance < 0 ? "CREDIT_A_REPORTER" : "NEUTRE",
    exemptSalesBase: round2(
      sales.filter((s) => s.rate === 0).reduce((a, s) => a + s.base, 0),
    ),
    nonDeductiblePurchasesBase: round2(
      purchases.filter((p) => !p.deductible).reduce((a, p) => a + p.base, 0),
    ),
  };
}

/** Bornes de la période : mois complet ou trimestre civil. */
export function periodToRange(p: G50Period): { start: string; end: string } {
  const pad = (n: number) => String(n).padStart(2, "0");
  if (p.type === "MONTH") {
    const lastDay = new Date(Date.UTC(p.year, p.month, 0)).getUTCDate();
    return { start: `${p.year}-${pad(p.month)}-01`, end: `${p.year}-${pad(p.month)}-${pad(lastDay)}` };
  }
  const first = ((p.month - 1) / 3) | 0; // 0..3
  const m1 = first * 3 + 1;
  const m3 = m1 + 2;
  const lastDay = new Date(Date.UTC(p.year, m3, 0)).getUTCDate();
  return { start: `${p.year}-${pad(m1)}-01`, end: `${p.year}-${pad(m3)}-${pad(lastDay)}` };
}

/**
 * Requêtes SQL d'alimentation du moteur G50 (à exécuter côté main-process) :
 *
 *  -- TVA collectée (ventes) de la période :
 *  SELECT ii.tva_rate AS rate,
 *         ROUND(SUM(ii.amount_ht), 2)  AS base,
 *         ROUND(SUM(ii.amount_tva), 2) AS tva
 *  FROM invoices i
 *  JOIN invoice_items ii ON ii.invoice_id = i.id
 *  WHERE i.doc_type = 'FACTURE'
 *    AND i.status IN ('VALIDATED','PARTIAL','PAID')
 *    AND date(i.date) BETWEEN :start AND :end
 *  GROUP BY ii.tva_rate;
 *
 *  -- TVA déductible (achats) de la période :
 *  SELECT tva_rate AS rate,
 *         ROUND(SUM(base_ht), 2) AS base,
 *         ROUND(SUM(tva), 2)     AS tva
 *  FROM purchase_items
 *  WHERE deductible = 1 AND date(date) BETWEEN :start AND :end
 *  GROUP BY tva_rate;
 *  (une 2e passe avec deductible = 0 pour l'alerte « non déductible »)
 */

// ----------------------------------------------------------------------------
// 6. EXPORT COMPTABLE — PC COMPTA / SAGE 100
// ----------------------------------------------------------------------------

/**
 * Comptes du plan comptable algérien (base PCG français).
 * ⚠ À fiabiliser avec le comptable (le timbre se comptabilise selon les
 *    pratiques : 444 « État / impôts » ou 635 « autres impôts et taxes »).
 */
export const ACCOUNTS = {
  client: "411",
  banque: "512",
  caisse: "530",
  vente_matiere: "707", // revente matières / marchandises
  vente_produit: "701", // produits finis
  prestation_service: "708",
  tva: "44571", // débit : déductible | crédit : collectée
  tva_decharge: "44572",
  timbre: "444",
} as const;

export interface JournalLine {
  account: string;
  label: string;
  debit: number;
  credit: number;
}

export interface JournalEntry {
  date: string;
  journal: "VD" | "AC" | "BQ" | "BD";
  piece: string;
  lines: JournalLine[];
}

/** Écriture de VENTE (facture) : 411 = TTC + timbre | 70x = HT | 44571 = TVA. */
export function journalEntryForInvoice(doc: {
  number: string;
  date: string;
  clientName: string;
  kind: "PRODUCT" | "SERVICE";
  paymentMethod: PaymentMethod;
  totals: DocTotals;
}): JournalEntry {
  const saleAccount =
    doc.kind === "SERVICE" ? ACCOUNTS.prestation_service : ACCOUNTS.vente_matiere;
  const lines: JournalLine[] = [
    {
      account: ACCOUNTS.client,
      label: `Facture ${doc.number} — ${doc.clientName}`,
      debit: doc.totals.totalDue,
      credit: 0,
    },
    {
      account: saleAccount,
      label: `Ventes — ${doc.number}`,
      debit: 0,
      credit: doc.totals.totalHt,
    },
  ];
  if (doc.totals.totalTva > 0)
    lines.push({ account: ACCOUNTS.tva, label: "TVA collectée", debit: 0, credit: doc.totals.totalTva });
  if (doc.totals.timbre > 0)
    lines.push({ account: ACCOUNTS.timbre, label: "Droit de timbre (1 %)", debit: 0, credit: doc.totals.timbre });
  return { date: doc.date, journal: "VD", piece: doc.number, lines };
}

/** Écriture d'ENCAISSEMENT : 530 (espèces) ou 512 (banque) | 411. */
export function journalEntryForPayment(doc: {
  invoiceNumber: string;
  clientName: string;
  date: string;
  amount: number;
  method: PaymentMethod;
  ref?: string;
}): JournalEntry {
  const cash = doc.method === "CASH" ? ACCOUNTS.caisse : ACCOUNTS.banque;
  return {
    date: doc.date,
    journal: doc.method === "CASH" ? "BQ" : "BD",
    piece: doc.ref ?? doc.invoiceNumber,
    lines: [
      { account: cash, label: `Encaissement ${doc.invoiceNumber}`, debit: doc.amount, credit: 0 },
      { account: ACCOUNTS.client, label: `Règlement ${doc.clientName}`, debit: 0, credit: doc.amount },
    ],
  };
}

const csvEscape = (s: string) => (/[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/**
 * Export CSV compatible SAGE 100 (modèle « écritures ») / PC COMPTA.
 * Colonnes à mapper sur le modèle d'import officiel de la version utilisée :
 * date ; journal ; pièce ; n° ligne ; compte ; libellé ; débit ; crédit.
 */
export function toSage100Csv(entries: JournalEntry[]): string {
  const head = "date;journal;piece;ligne;compte;libelle;debit;credit";
  const rows: string[] = [];
  for (const e of entries)
    e.lines.forEach((l, i) =>
      rows.push(
        [
          e.date,
          e.journal,
          csvEscape(e.piece),
          i + 1,
          l.account,
          csvEscape(l.label),
          l.debit.toFixed(2),
          l.credit.toFixed(2),
        ].join(";"),
      ),
    );
  return [head, ...rows].join("\r\n");
}
