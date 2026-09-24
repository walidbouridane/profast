//! ============================================================================
//!  ProFast Facture — Inventaires physiques : cœur de calcul PUR (testable)
//!  Les ajustements de stock après inventaire sont calculés ici ; la
//!  persistance (transac. stock + mouvements ADJUST) est dans db.rs.
//! ============================================================================

use crate::fiscal::round2;

#[derive(Debug, Clone, serde::Serialize)]
pub struct InvLine {
    pub product_id: i64,
    pub sku: String,
    pub name: String,
    pub unit: String,
    /// Quantité théorique (livre).
    pub book: f64,
    /// Quantité comptée (physique).
    pub counted: f64,
    /// Coût unitaire posé DZD (pour la valorisation).
    pub cost_unit: f64,
}

impl InvLine {
    /// Écart arrondi à 2 décimales (compté − livre).
    pub fn diff(&self) -> f64 {
        round2(self.counted - self.book)
    }

    pub fn is_adjusted(&self) -> bool {
        self.diff().abs() > 1e-9
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Adjustment {
    pub product_id: i64,
    pub name: String,
    pub book: f64,
    pub counted: f64,
    pub diff: f64,
    /// Valeur de l'écart en DZD (diff × coût unitaire).
    pub value_dzd: f64,
}

/// Ajustements à appliquer au stock (lignes avec écart ≠ 0).
pub fn adjustments(lines: &[InvLine]) -> Vec<Adjustment> {
    lines
        .iter()
        .filter(|l| l.is_adjusted())
        .map(|l| Adjustment {
            product_id: l.product_id,
            name: l.name.clone(),
            book: l.book,
            counted: l.counted,
            diff: l.diff(),
            value_dzd: round2(l.diff() * l.cost_unit),
        })
        .collect()
}

/// Valorisation du stock : (valeur livre, valeur comptée) en DZD.
pub fn valuation(lines: &[InvLine]) -> (f64, f64) {
    let book: f64 = lines.iter().map(|l| l.book * l.cost_unit).sum();
    let counted: f64 = lines.iter().map(|l| l.counted * l.cost_unit).sum();
    (round2(book), round2(counted))
}

/// Ratio de perte/gain : (counted − book) / book, en % (0 si book = 0).
pub fn variance_pct(lines: &[InvLine]) -> f64 {
    let book = round2(lines.iter().map(|l| l.book).sum::<f64>());
    let counted = round2(lines.iter().map(|l| l.counted).sum::<f64>());
    if book.abs() < 1e-9 {
        0.0
    } else {
        round2((counted - book) / book * 100.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines() -> Vec<InvLine> {
        vec![
            InvLine { product_id: 1, sku: "A".into(), name: "Ciment".into(), unit: "U".into(), book: 100.0, counted: 97.0, cost_unit: 780.0 },
            InvLine { product_id: 2, sku: "B".into(), name: "Huile".into(), unit: "U".into(), book: 50.0, counted: 50.0, cost_unit: 1852.5 },
            InvLine { product_id: 3, sku: "C".into(), name: "Sucre".into(), unit: "KG".into(), book: 200.0, counted: 202.5, cost_unit: 110.0 },
        ]
    }

    #[test]
    fn ajustements_uniquement_ecarts() {
        let adj = adjustments(&lines());
        assert_eq!(adj.len(), 2, "seules les lignes à écart figurent");
        assert_eq!(adj[0].product_id, 1);
        assert_eq!(adj[0].diff, -3.0);
        assert_eq!(adj[0].value_dzd, -2340.0); // -3 × 780
        assert_eq!(adj[1].diff, 2.5);
        assert_eq!(adj[1].value_dzd, 275.0);   // 2.5 × 110
    }

    #[test]
    fn inventaire_sans_ecart() {
        let l = vec![InvLine {
            product_id: 1, sku: "A".into(), name: "A".into(), unit: "U".into(),
            book: 10.0, counted: 10.0, cost_unit: 5.0,
        }];
        assert!(adjustments(&l).is_empty());
        assert_eq!(variance_pct(&l), 0.0);
    }

    #[test]
    fn valorisation_dzd() {
        let (book_v, counted_v) = valuation(&lines());
        assert_eq!(book_v, 100.0 * 780.0 + 50.0 * 1852.5 + 200.0 * 110.0);
        assert_eq!(
            counted_v,
            97.0 * 780.0 + 50.0 * 1852.5 + 202.5 * 110.0
        );
    }

    #[test]
    fn variance_negative_si_manquant() {
        // -3 + 2.5 = -0.5 sur 350 => -0.14 %
        assert_eq!(variance_pct(&lines()), -0.14);
    }

    #[test]
    fn rounding_ecart() {
        let l = vec![InvLine {
            product_id: 1, sku: "A".into(), name: "A".into(), unit: "U".into(),
            book: 10.0, counted: 10.004, cost_unit: 1.0,
        }];
        assert!(!l[0].is_adjusted(), "écart < 0,01 => pas d'ajustement");
    }
}
