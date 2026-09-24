// ============================================================================
//  ProFast Facture — Tests du moteur fiscal DZ (vecteurs de référence)
//  Lancement :  node --test  (ou via le runner TS configuré, ex. tsx --test)
// ============================================================================
import test from "node:test";
import assert from "node:assert/strict";
import {
  computeLine,
  computeDocTotals,
  computeTimbre,
  computeReceiptTimbre,
  timbreForPayment,
  computeLandedCostDzd,
  computeG50,
  periodToRange,
  journalEntryForInvoice,
  DZ_TIMBRE,
} from "./engine";

// ---------------------------------------------------------------------------
// Lignes & totaux
// ---------------------------------------------------------------------------
test("ligne : 3 x 1000 HT, remise 10 %, TVA 19 %", () => {
  const l = computeLine(
    { name: "Ciment 50kg", qty: 3, unitPriceHt: 1000, discountRate: 0.1, tvaRate: 0.19, costUnitDzd: 780 },
  );
  assert.equal(l.gross, 3000);
  assert.equal(l.discountAmount, 300);
  assert.equal(l.amountHt, 2700);
  assert.equal(l.amountTva, 513);       // 2700 * 0.19
  assert.equal(l.amountTtc, 3213);
  assert.equal(l.costDzd, 2340);        // 780 * 3
  assert.equal(l.marginDzd, 360);       // 2700 - 2340
  assert.equal(l.marginPct, 13.33);
});

test("lignes multi-taux : ventilation 19/9/0", () => {
  const lines = [
    computeLine({ name: "A", qty: 100, unitPriceHt: 100, discountRate: 0, tvaRate: 0.19 }),
    computeLine({ name: "B", qty: 100, unitPriceHt: 100, discountRate: 0, tvaRate: 0.09 }),
    computeLine({ name: "C", qty: 100, unitPriceHt: 100, discountRate: 0, tvaRate: 0 }),
  ];
  const t = computeDocTotals(lines);
  assert.equal(t.totalHt, 30000);
  assert.equal(t.totalTva, 2800); // 1900 + 900 + 0
  assert.equal(t.totalTtc, 32800);
  const rates = t.tvaByRate.map((r) => r.rate);
  assert.deepEqual(rates, [0.19, 0.09, 0]);
  assert.equal(t.tvaByRate[0].tva, 1900);
  assert.equal(t.tvaByRate[1].tva, 900);
});

// ---------------------------------------------------------------------------
// Timbre fiscal
// ---------------------------------------------------------------------------
test("timbre : 1 % arrondi au dinar supérieur, min 5 DA", () => {
  assert.equal(computeTimbre(3213), 33);    // 32.13 -> 33
  assert.equal(computeTimbre(11900), 119);  // 119 exact -> 119
  assert.equal(computeTimbre(100), 5);      // 1 -> min 5
  assert.equal(computeTimbre(0), 0);
});

test("timbre : plafond 2500 DA", () => {
  assert.equal(computeTimbre(500000), 2500); // 5000 -> plafonné 2500
});

test("timbre reçu de caisse : min 2 DA", () => {
  assert.equal(computeReceiptTimbre(100), 2);   // ceil(1) = 1 -> min 2
  assert.equal(computeReceiptTimbre(3213), 33); // 33 >= 2
});

test("timbreForPayment : espèces => facture + reçu ; chèque => facture seule", () => {
  const cash = timbreForPayment(3213, "CASH");
  assert.equal(cash.timbreFacture, 33);
  assert.equal(cash.timbreRecu, 33); // 33 >= min 2
  const cheque = timbreForPayment(3213, "CHECK");
  assert.equal(cheque.timbreFacture, 33);
  assert.equal(cheque.timbreRecu, 0);
});

// ---------------------------------------------------------------------------
// Coût posé (double monnaie)
// ---------------------------------------------------------------------------
test("coût posé EUR : 12.5 EUR x 145 DA + douane 40 DA", () => {
  assert.equal(computeLandedCostDzd({ purchasePriceHt: 12.5, currency: "EUR", fxRate: 145, extraCostsDzd: 40 }), 1852.5);
});

test("coût posé DZD : simple addition des frais", () => {
  assert.equal(computeLandedCostDzd({ purchasePriceHt: 800, currency: "DZD", fxRate: 1, extraCostsDzd: 60 }), 860);
});

test("marge réelle DZD sur facture en EUR", () => {
  const l = computeLine(
    { name: "Machine", qty: 2, unitPriceHt: 500, discountRate: 0, tvaRate: 0.19, costUnitDzd: 1200 },
    145, // fx EUR -> DZD
  );
  // HT DZD = 2 * 500 * 145 = 145000 ; coût = 2400 ; marge = 142600
  assert.equal(l.marginDzd, 142600);
});

// ---------------------------------------------------------------------------
// G50
// ---------------------------------------------------------------------------
test("G50 mensuel : solde net à payer", () => {
  const g = computeG50({
    period: { type: "MONTH", year: 2026, month: 9 },
    sales: [
      { rate: 0.19, base: 100000, tva: 19000 },
      { rate: 0.09, base: 50000, tva: 4500 },
      { rate: 0, base: 20000, tva: 0 },
    ],
    purchases: [
      { rate: 0.19, base: 60000, tva: 11400, deductible: true },
      { rate: 0.19, base: 5000, tva: 950, deductible: false },
    ],
  });
  assert.equal(g.periodStart, "2026-09-01");
  assert.equal(g.periodEnd, "2026-09-30");
  assert.equal(g.totalCollectee, 23500);
  assert.equal(g.totalDeductible, 11400);
  assert.equal(g.balance, 12100);
  assert.equal(g.situation, "A_PAYER");
  assert.equal(g.exemptSalesBase, 20000);
  assert.equal(g.nonDeductiblePurchasesBase, 5000);
  assert.deepEqual(
    g.collectee.map((l) => l.rate),
    [0.19, 0.09, 0],
  );
});

test("G50 trimestriel : crédit de TVA à reporter", () => {
  const g = computeG50({
    period: { type: "QUARTER", year: 2026, month: 4 },
    sales: [{ rate: 0.19, base: 10000, tva: 1900 }],
    purchases: [{ rate: 0.19, base: 80000, tva: 15200, deductible: true }],
  });
  assert.equal(g.periodStart, "2026-04-01");
  assert.equal(g.periodEnd, "2026-06-30");
  assert.equal(g.balance, -13300);
  assert.equal(g.situation, "CREDIT_A_REPORTER");
});

// ---------------------------------------------------------------------------
// Export comptable
// ---------------------------------------------------------------------------
test("écriture PC Compta : 411 = TTC + timbre | 707 = HT | 44571 = TVA | 444 = timbre", () => {
  const lines = [
    computeLine({ name: "A", qty: 10, unitPriceHt: 100, discountRate: 0, tvaRate: 0.19 }),
  ];
  const totals = computeDocTotals(lines); // TTC 1190, timbre 12
  const e = journalEntryForInvoice({
    number: "FA-2026-000001",
    date: "2026-09-23",
    clientName: "SARL Exemple",
    kind: "PRODUCT",
    paymentMethod: "CASH",
    totals,
  });
  const sum = (f: (l: (typeof e.lines)[number]) => number) =>
    e.lines.reduce((a, l) => a + f(l), 0);
  // Équilibre de l'écriture : débit = crédit
  assert.equal(sum((l) => l.debit), sum((l) => l.credit));
  const c411 = e.lines.find((l) => l.account === "411");
  assert.equal(c411?.debit, totals.totalDue); // TTC + timbre
  assert.equal(e.lines.find((l) => l.account === "707")?.credit, totals.totalHt);
  assert.equal(e.lines.find((l) => l.account === "44571")?.credit, totals.totalTva);
  assert.equal(e.lines.find((l) => l.account === "444")?.credit, totals.timbre);
});

test("constant defaults DZ", () => {
  assert.deepEqual(DZ_TIMBRE, { rate: 0.01, min: 5, max: 2500, receiptMin: 2 });
});
