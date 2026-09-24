//! ============================================================================
//!  ProFast Facture — MOTEUR FISCAL DZ (portage Rust)
//!
//!  ⚠ SOURCE DE VÉRITÉ : le main-process recalcule TOUS les totaux avec ce
//!  module à l'enregistrement ; le moteur TS (src/fiscal/engine.ts) sert à
//!  l'affichage instantané dans le webview. Les deux partsagent les MÊMES
//!  vecteurs de test (voir #[cfg(test)] ci-dessous = mêmes valeurs que
//!  engine.test.ts) pour qu'aucune divergence ne passe inaperçue.
//!
//!  Règles DZ : TVA 19/9/0 % · Timbre 1 % du TTC, arrondi au dinar supérieur,
//!  min 5 DA, plafond 2 500 DA (reçu de caisse min 2 DA).
//! ============================================================================

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TimbreCfg {
    pub rate: f64,
    pub min: f64,
    pub max: f64,
    pub receipt_min: f64,
}

pub const DZ_TIMBRE: TimbreCfg = TimbreCfg {
    rate: 0.01,
    min: 5.0,
    max: 2500.0,
    receipt_min: 2.0,
};

pub fn round2(n: f64) -> f64 {
    (n * 100.0 + f64::EPSILON).round() / 100.0
}

pub fn compute_timbre(total_ttc: f64, cfg: &TimbreCfg) -> f64 {
    if total_ttc <= 0.0 {
        return 0.0;
    }
    let v = (total_ttc * cfg.rate).ceil(); // arrondi AU DINAR SUPÉRIEUR
    v.clamp(cfg.min, cfg.max)
}

pub fn compute_receipt_timbre(total_ttc: f64, cfg: &TimbreCfg) -> f64 {
    if total_ttc <= 0.0 {
        return 0.0;
    }
    let v = (total_ttc * cfg.rate).ceil();
    v.clamp(cfg.receipt_min, cfg.max)
}

/// Coût de revient UNITAIRE en DZD pour un achat :
///   DZD     : prix unitaire + frais annexes unitaires (douane, transport…)
///   EUR/USD : prix unitaire × taux de change (officiel ou parallèle) + frais unitaires
/// `extra_costs_dzd` est le TOTAL des frais ; `qty` sert à le répartir.
pub fn landed_cost_unit_dzd(
    unit_price_ht: f64,
    is_dzd: bool,
    fx_rate: f64,
    extra_costs_total_dzd: f64,
    qty: f64,
) -> f64 {
    if qty <= 0.0 {
        return 0.0;
    }
    let base = if is_dzd { unit_price_ht } else { unit_price_ht * fx_rate };
    round2(base + extra_costs_total_dzd / qty)
}

// ----------------------------------------------------------------------------
// Lignes
// ----------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize)]
pub struct LineCalc {
    pub gross: f64,
    pub discount_amount: f64,
    pub amount_ht: f64,
    pub amount_tva: f64,
    pub amount_ttc: f64,
    pub cost_dzd: f64,
    pub margin_dzd: f64,
    pub margin_pct: f64,
}

pub fn compute_line(
    qty: f64,
    unit_price_ht: f64,
    discount_rate: f64,
    tva_rate: f64,
    cost_unit_dzd: f64,
    fx_rate_dzd: f64,
) -> LineCalc {
    let gross = round2(qty * unit_price_ht);
    let dr = discount_rate.clamp(0.0, 1.0);
    let discount_amount = round2(gross * dr);
    let amount_ht = round2(gross - discount_amount);
    let amount_tva = round2(amount_ht * tva_rate);
    let amount_ttc = round2(amount_ht + amount_tva);
    let cost_dzd = round2(cost_unit_dzd * qty);
    let ht_dzd = round2(amount_ht * fx_rate_dzd);
    let margin_dzd = round2(ht_dzd - cost_dzd);
    let margin_pct = if ht_dzd > 0.0 { round2(margin_dzd / ht_dzd * 100.0) } else { 0.0 };
    LineCalc {
        gross,
        discount_amount,
        amount_ht,
        amount_tva,
        amount_ttc,
        cost_dzd,
        margin_dzd,
        margin_pct,
    }
}

// ----------------------------------------------------------------------------
// Totaux document
// ----------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize)]
pub struct TvaRateLine {
    pub rate: f64,
    pub base: f64,
    pub tva: f64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Totals {
    pub total_ht: f64,
    pub total_discount: f64,
    pub total_tva: f64,
    pub total_ttc: f64,
    pub tva_by_rate: Vec<TvaRateLine>,
    pub timbre: f64,
    pub total_due: f64,
    pub cost_dzd: f64,
    pub margin_dzd: f64,
    pub margin_pct: f64,
}

/// Ligne d'entrée du calcul (les taux voyagent avec la ligne).
#[derive(Debug, Clone)]
pub struct LineInput {
    pub qty: f64,
    pub unit_price_ht: f64,
    pub discount_rate: f64,
    pub tva_rate: f64,
    pub cost_unit_dzd: f64,
}

impl LineInput {
    pub fn calc(&self, fx_rate_dzd: f64) -> LineCalc {
        compute_line(
            self.qty,
            self.unit_price_ht,
            self.discount_rate,
            self.tva_rate,
            self.cost_unit_dzd,
            fx_rate_dzd,
        )
    }
}

/// Totaux document — fonction utilisée par db.rs à l'enregistrement.
pub fn doc_totals_full(lines: &[LineInput], fx_rate_dzd: f64, apply_timbre: bool) -> Totals {
    let mut by_rate: Vec<(f64, f64, f64)> = Vec::new();
    let (mut total_ht, mut total_discount, mut total_tva, mut total_ttc, mut cost_dzd) =
        (0.0f64, 0.0f64, 0.0f64, 0.0f64, 0.0f64);

    for l in lines {
        let c = l.calc(fx_rate_dzd);
        total_ht += c.amount_ht;
        total_discount += c.discount_amount;
        total_tva += c.amount_tva;
        total_ttc += c.amount_ttc;
        cost_dzd += c.cost_dzd;
        match by_rate.iter_mut().find(|(r, _, _)| (r - l.tva_rate).abs() < 1e-9) {
            Some(e) => {
                e.1 += c.amount_ht;
                e.2 += c.amount_tva;
            }
            None => by_rate.push((l.tva_rate, c.amount_ht, c.amount_tva)),
        }
    }

    by_rate.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap());
    let tva_by_rate = by_rate
        .into_iter()
        .map(|(rate, base, tva)| TvaRateLine { rate, base: round2(base), tva: round2(tva) })
        .collect();

    let total_ht = round2(total_ht);
    let total_ttc = round2(total_ttc);
    let timbre = if apply_timbre { compute_timbre(total_ttc, &DZ_TIMBRE) } else { 0.0 };
    let ht_dzd = round2(total_ht * fx_rate_dzd);
    let cost_dzd = round2(cost_dzd);
    let margin_dzd = round2(ht_dzd - cost_dzd);

    Totals {
        total_ht,
        total_discount: round2(total_discount),
        total_tva: round2(total_tva),
        total_ttc,
        tva_by_rate,
        timbre,
        total_due: round2(total_ttc + timbre),
        cost_dzd,
        margin_dzd,
        margin_pct: if ht_dzd > 0.0 { round2(margin_dzd / ht_dzd * 100.0) } else { 0.0 },
    }
}

// ----------------------------------------------------------------------------
// Tests — MÊMES vecteurs que src/fiscal/engine.test.ts
// ----------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ligne_ciment() {
        let c = compute_line(3.0, 1000.0, 0.1, 0.19, 780.0, 1.0);
        assert_eq!(c.gross, 3000.0);
        assert_eq!(c.discount_amount, 300.0);
        assert_eq!(c.amount_ht, 2700.0);
        assert_eq!(c.amount_tva, 513.0);
        assert_eq!(c.amount_ttc, 3213.0);
        assert_eq!(c.cost_dzd, 2340.0);
        assert_eq!(c.margin_dzd, 360.0);
        assert_eq!(c.margin_pct, 13.33);
    }

    #[test]
    fn timbre_1pct_ceil_min5_max2500() {
        assert_eq!(compute_timbre(3213.0, &DZ_TIMBRE), 33.0);
        assert_eq!(compute_timbre(11900.0, &DZ_TIMBRE), 119.0);
        assert_eq!(compute_timbre(100.0, &DZ_TIMBRE), 5.0);
        assert_eq!(compute_timbre(0.0, &DZ_TIMBRE), 0.0);
        assert_eq!(compute_timbre(500000.0, &DZ_TIMBRE), 2500.0);
    }

    #[test]
    fn recu_caisse_min_2() {
        assert_eq!(compute_receipt_timbre(100.0, &DZ_TIMBRE), 2.0);
        assert_eq!(compute_receipt_timbre(3213.0, &DZ_TIMBRE), 33.0);
    }

    #[test]
    fn totaux_multi_taux() {
        let lines = vec![
            LineInput { qty: 100.0, unit_price_ht: 100.0, discount_rate: 0.0, tva_rate: 0.19, cost_unit_dzd: 0.0 },
            LineInput { qty: 100.0, unit_price_ht: 100.0, discount_rate: 0.0, tva_rate: 0.09, cost_unit_dzd: 0.0 },
            LineInput { qty: 100.0, unit_price_ht: 100.0, discount_rate: 0.0, tva_rate: 0.0, cost_unit_dzd: 0.0 },
        ];
        let t = doc_totals_full(&lines, 1.0, true);
        assert_eq!(t.total_ht, 30000.0);
        assert_eq!(t.total_tva, 2800.0);
        assert_eq!(t.total_ttc, 32800.0);
        assert_eq!(t.tva_by_rate.len(), 3);
        assert_eq!(t.tva_by_rate[0].rate, 0.19);
        assert_eq!(t.tva_by_rate[0].tva, 1900.0);
        assert_eq!(t.tva_by_rate[1].tva, 900.0);
        assert_eq!(t.timbre, 328.0); // ceil(328.0)
        assert_eq!(t.total_due, 33128.0);
    }

    #[test]
    fn marge_eur() {
        let c = compute_line(2.0, 500.0, 0.0, 0.19, 1200.0, 145.0);
        assert_eq!(c.margin_dzd, 142600.0);
    }

    #[test]
    fn timbre_caisse_specifique() {
        // 11900 TTC : facture 119 ; espèces => +reçu 119 ; chèque => 0
        assert_eq!(compute_receipt_timbre(11900.0, &DZ_TIMBRE), 119.0);
    }

    #[test]
    fn coute_pose_eur_douane() {
        // 12.5 EUR × 145 DA + 40 DA de frais pour 2 unités => (1812.5 + 20) = 1832.50
        assert_eq!(
            landed_cost_unit_dzd(12.5, false, 145.0, 40.0, 2.0),
            1832.5
        );
        // DZD : 800 + 60/1 = 860
        assert_eq!(landed_cost_unit_dzd(800.0, true, 1.0, 60.0, 1.0), 860.0);
        // qty = 0 => 0
        assert_eq!(landed_cost_unit_dzd(10.0, false, 145.0, 0.0, 0.0), 0.0);
    }
}
