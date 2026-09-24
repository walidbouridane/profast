// ============================================================================
//  Gabarit PDF des documents (A4) — HTML → PDF local (print_pdf)
//  • En-tête société (NIF / NIS / RC) + logo
//  • Bloc client + coordonnées
//  • Tableau des lignes, totaux par taux TVA, TIMBRE FISCAL
//  • QR code dynamique : N° | date | NIF | client | montant TTC
//  • Cachet PNG numérisé + signature
// ============================================================================
import type { CompanyConfig, Totals } from "../types";
import type { DocType, PaymentMethod } from "../types";

export interface PdfLine {
  name: string;
  qty: number;
  unit: string;
  unit_price_ht: number;
  discount_rate: number;
  tva_rate: number;
  amount_ht: number;
  amount_tva: number;
  amount_ttc: number;
}

const M = (n: number) =>
  new Intl.NumberFormat("fr-DZ", { style: "currency", currency: "DZD", currencyDisplay: "code" })
    .format(n)
    .replace(" DZD", " DA");

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const DOC_LABEL: Record<DocType, string> = {
  FACTURE: "FACTURE",
  BL: "BON DE LIVRAISON",
  DEVIS: "DEVIS",
};

const PAY_LABEL: Record<string, string> = {
  CASH: "Espèces", CHECK: "Chèque", TRANSFER: "Virement",
  CREDIT: "Crédit client", MIXED: "Mixte",
};

export function buildInvoiceHtml(args: {
  docType: DocType;
  number: string;
  date: string;
  client: { name: string; nif?: string; address?: string; phone?: string };
  company: CompanyConfig;
  lines: PdfLine[];
  totals: Totals;
  paymentMethod: PaymentMethod;
  qrDataUrl: string;
  logoDataUrl?: string | null;
  stampDataUrl?: string | null;
  signatureDataUrl?: string | null;
}): string {
  const { docType, number, date, client, company, lines, totals, paymentMethod } = args;
  const showTimbre = docType === "FACTURE" && totals.timbre > 0;

  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<style>
  @page { size: A4; margin: 14mm 12mm; }
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", Arial, sans-serif; color: #0f172a; font-size: 11px; margin: 0; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #1d4ed8; padding-bottom: 10px; }
  .co { max-width: 55%; }
  .co h1 { font-size: 17px; margin: 0 0 2px; color: #1e3a8a; }
  .co p { margin: 1px 0; color: #475569; }
  .docbox { text-align: right; }
  .docbox h2 { font-size: 20px; margin: 0; color: #1d4ed8; letter-spacing: .04em; }
  .docbox .num { font-size: 14px; font-weight: 700; margin-top: 4px; }
  .grid { display: flex; gap: 24px; margin-top: 14px; }
  .client { width: 55%; }
  .client h3, .meta h3 { font-size: 10px; text-transform: uppercase; letter-spacing: .08em; color: #94a3b8; margin: 0 0 4px; }
  .client p { margin: 1px 0; }
  .meta p { margin: 1px 0; text-align: right; }
  table.lines { width: 100%; border-collapse: collapse; margin-top: 16px; }
  table.lines th { background: #eff6ff; color: #1e3a8a; font-size: 10px; text-transform: uppercase; padding: 6px 8px; border: 1px solid #dbeafe; }
  table.lines td { padding: 5px 8px; border: 1px solid #e2e8f0; }
  .r { text-align: right; font-variant-numeric: tabular-nums; }
  .totals { margin-top: 12px; margin-left: auto; width: 55%; border-collapse: collapse; }
  .totals td { padding: 3px 8px; }
  .totals .lbl { color: #475569; }
  .totals .tot { font-weight: 700; font-size: 14px; background: #eff6ff; }
  .timbre { color: #b45309; }
  .foot { display: flex; justify-content: space-between; align-items: flex-end; margin-top: 34px; }
  .sign { text-align: center; }
  .sign p { margin: 4px 0 0; font-size: 10px; color: #64748b; }
  .qr img { width: 84px; height: 84px; }
  .stamp img { height: 84px; opacity: .85; transform: rotate(-6deg); }
  .note { margin-top: 10px; font-size: 9px; color: #94a3b8; }
</style></head>
<body>
  <div class="head">
    <div class="co">
      ${args.logoDataUrl ? `<img src="${args.logoDataUrl}" style="height:44px;margin-bottom:6px">` : ""}
      <h1>${esc(company.company_name)}</h1>
      <p>${esc(company.legal_form ?? "")} ${company.address ? "· " + esc(company.address) : ""}${company.wilaya ? " — " + esc(company.wilaya) : ""}</p>
      <p>NIF : ${esc(company.nif ?? "—")} · NIS : ${esc(company.nis ?? "—")} · RC : ${esc(company.rc ?? "—")}</p>
      <p>${company.phone ? "Tél : " + esc(company.phone) : ""}${company.iban ? " · " + esc(company.bank_name ?? "") + " " + esc(company.iban) : ""}</p>
    </div>
    <div class="docbox">
      <h2>${DOC_LABEL[docType]}</h2>
      <p class="num">N° ${esc(number)}</p>
      <p>Date : ${esc(date)}</p>
      <p>Règlement : ${PAY_LABEL[paymentMethod] ?? paymentMethod}</p>
    </div>
  </div>

  <div class="grid">
    <div class="client">
      <h3>Client</h3>
      <p><strong>${esc(client.name)}</strong></p>
      ${client.nif ? `<p>NIF : ${esc(client.nif)}</p>` : ""}
      ${client.address ? `<p>${esc(client.address)}</p>` : ""}
      ${client.phone ? `<p>Tél : ${esc(client.phone)}</p>` : ""}
    </div>
    <div class="meta">
      <h3>Références</h3>
      <p>Document : ${esc(number)}</p>
      <p>Devise : DZD</p>
      ${showTimbre ? `<p class="timbre">Timbre fiscal (1 %) : ${M(totals.timbre)}</p>` : ""}
    </div>
  </div>

  <table class="lines">
    <thead>
      <tr>
        <th style="width:34%">Désignation</th>
        <th class="r">Qté</th>
        <th class="r">PU HT</th>
        <th class="r">Rem.</th>
        <th class="r">TVA</th>
        <th class="r">Total HT</th>
        <th class="r">TVA</th>
        <th class="r">Total TTC</th>
      </tr>
    </thead>
    <tbody>
      ${lines
        .map(
          (l) => `<tr>
            <td>${esc(l.name)}</td>
            <td class="r">${l.qty} ${esc(l.unit)}</td>
            <td class="r">${M(l.unit_price_ht)}</td>
            <td class="r">${l.discount_rate > 0 ? (l.discount_rate * 100).toFixed(0) + " %" : ""}</td>
            <td class="r">${(l.tva_rate * 100).toFixed(0)} %</td>
            <td class="r">${M(l.amount_ht)}</td>
            <td class="r">${M(l.amount_tva)}</td>
            <td class="r"><strong>${M(l.amount_ttc)}</strong></td>
          </tr>`,
        )
        .join("")}
    </tbody>
  </table>

  <table class="totals">
    <tr><td class="lbl">Total HT</td><td class="r">${M(totals.total_ht)}</td></tr>
    ${totals.total_discount > 0 ? `<tr><td class="lbl">Remises</td><td class="r">− ${M(totals.total_discount)}</td></tr>` : ""}
    ${totals.tva_by_rate
      .map((r) => `<tr><td class="lbl">${r.rate === 0 ? "Exonéré (0 %)" : "TVA " + (r.rate * 100).toFixed(0) + " %"}</td><td class="r">${M(r.tva)}</td></tr>`)
      .join("")}
    <tr><td class="lbl">Total TTC</td><td class="r">${M(totals.total_ttc)}</td></tr>
    ${showTimbre ? `<tr><td class="lbl timbre">Droit de timbre</td><td class="r timbre">${M(totals.timbre)}</td></tr>` : ""}
    <tr class="tot"><td>TOTAL À RÉGLER</td><td class="r">${M(totals.total_due)}</td></tr>
  </table>

  <div class="foot">
    <div>
      <div class="note">
        ${showTimbre && paymentMethod === "CASH"
          ? "Droit de timbre calculé sur le montant TTC (1 %, min 5 DA) — mention obligatoire au règlement en espèces.<br>"
          : ""}
        NIF vendeur : ${esc(company.nif ?? "—")} · ProFast Facture (document généré localement)
      </div>
    </div>
    ${args.stampDataUrl ? `<div class="stamp"><img src="${args.stampDataUrl}"></div>` : ""}
    <div class="sign">
      ${args.signatureDataUrl ? `<img src="${args.signatureDataUrl}" style="height:64px">` : ""}
      <p>Signature & cachet</p>
    </div>
    <div class="qr">
      <img src="${args.qrDataUrl}">
      <p style="font-size:8px;color:#94a3b8;margin:2px 0 0">Vérification : N° · date · NIF · client · montant</p>
    </div>
  </div>
</body></html>`;
}
