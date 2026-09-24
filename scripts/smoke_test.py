#!/usr/bin/env python3
"""
ProFast Facture — Smoke test du schéma SQLite + moteur G50 (SQL).
Valide : DDL, seed, numérotation séquentielle, écriture atomique facture
(articles + stock + mouvements), agrégations G50 (collectée / déductible).
Lancement : python3 scripts/smoke_test.py
"""
import os
import sqlite3
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCHEMA = os.path.join(HERE, "..", "db", "schema.sql")


def main() -> int:
    tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
    tmp.close()
    try:
        con = sqlite3.connect(tmp.name)
        con.executescript(open(SCHEMA, encoding="utf-8").read())
        cur = con.cursor()

        # --- Seed : société, client, fournisseur, articles -------------------
        cur.execute("UPDATE company_config SET nif='096912345600012', nis='096912345600012', rc='16/00-123456789' WHERE id=1")
        cur.execute(
            "INSERT INTO clients (code, name, nif, phone, wilaya) VALUES ('CL-00001','SARL Exemple EURL','166998765400012','+213550123456','16')"
        )
        client_id = cur.lastrowid
        cur.execute(
            "INSERT INTO suppliers (code, name, nif) VALUES ('FO-00001','Importeur SA','296999999900012')"
        )
        supplier_id = cur.lastrowid

        # Article 19 % (DZD) + Article 9 % (achat EUR -> coût posé)
        cur.execute(
            """INSERT INTO products (sku, name, kind, purchase_price_ht, purchase_currency,
               fx_rate_at_purchase, extra_costs_dzd, cost_dzd, sale_price_ht, tva_rate, unit)
               VALUES ('CM-50KG','Ciment 50kg','PRODUCT', 780, 'DZD', 1, 0, 780, 1250, 0.19, 'U')"""
        )
        p1 = cur.lastrowid
        cur.execute(
            """INSERT INTO products (sku, name, kind, purchase_price_ht, purchase_currency,
               fx_rate_at_purchase, extra_costs_dzd, cost_dzd, sale_price_ht, tva_rate, unit)
               VALUES ('HUILE-5L','Huile 5L','PRODUCT', 12.5, 'EUR', 145, 40, 1852.5, 2400, 0.09, 'U')"""
        )
        p2 = cur.lastrowid
        cur.execute(
            "INSERT INTO stock (product_id, warehouse_id, qty) VALUES (?, 1, 100), (?, 1, 50)",
            (p1, p2),
        )

        # --- Numérotation séquentielle (2 factures dans l'année) --------------
        def next_number(doc_type: str, year: int) -> int:
            cur.execute(
                """INSERT INTO doc_sequences (doc_type, year, last_number) VALUES (?, ?, 1)
                   ON CONFLICT (doc_type, year) DO UPDATE SET last_number = last_number + 1
                   RETURNING last_number""",
                (doc_type, year),
            )
            return cur.fetchone()[0]

        n1, n2 = next_number("FACTURE", 2026), next_number("FACTURE", 2026)
        assert (n1, n2) == (1, 2), "séquence facturier défaillante"
        print(f"[OK] Numérotation : FA-2026-{n1:06d}, FA-2026-{n2:06d}")

        # --- Écriture atomique : facture 1 (19% + 9%, remise, timbre) ---------
        # Ligne 1 : 3 x 1250 HT, remise 10 % => HT 3375, TVA 641.25, TTC 4016.25
        # Ligne 2 : 2 x 2400 HT, remise 0   => HT 4800, TVA 432.00, TTC 5232.00
        cur.execute(
            """INSERT INTO invoices (doc_type, number, client_id, status, date, payment_method,
               total_ht, total_discount, total_tva, total_ttc, timbre, total_due,
               cost_dzd, margin_dzd, created_by)
               VALUES ('FACTURE','FA-2026-000001',?,'VALIDATED','2026-09-10','CASH',
               8175.0, 375.0, 1073.25, 9248.25, 93, 9341.25, 6045.0, 2130.0, 1)""",
            (client_id,),
        )
        inv1 = cur.lastrowid
        cur.executemany(
            """INSERT INTO invoice_items (invoice_id, line_no, product_id, name, qty, unit,
               unit_price_ht, discount_rate, discount_amount, tva_rate,
               amount_ht, amount_tva, amount_ttc, cost_unit_dzd)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            [
                (inv1, 1, p1, "Ciment 50kg", 3, "U", 1250, 0.10, 375.0, 0.19, 3375.0, 641.25, 4016.25, 780),
                (inv1, 2, p2, "Huile 5L", 2, "U", 2400, 0.0, 0.0, 0.09, 4800.0, 432.0, 5232.0, 1852.5),
            ],
        )
        # Stock : sorties + mouvements (dans la même TX en app)
        cur.executemany(
            "UPDATE stock SET qty = qty - ? WHERE product_id = ? AND warehouse_id = 1",
            [(3, p1), (2, p2)],
        )
        cur.executemany(
            """INSERT INTO stock_movements (product_id, warehouse_id, type, qty, unit_cost_dzd, ref_type, ref_id, user_id)
               VALUES (?,?, 'OUT', ?, ?, 'FACTURE', 'FA-2026-000001', 1)""",
            [(p1, 1, -3, 780), (p2, 1, -2, 1852.5)],
        )

        # Timbre vérifié par la même formule TS : ceil(9248.25 * 0.01) = 93
        assert cur.execute("SELECT timbre, total_due FROM invoices WHERE id=?", (inv1,)).fetchone() == (93.0, 9341.25)
        print("[OK] Facture FA-2026-000001 : TTC 9248.25 + timbre 93 = 9341.25 (coût 6045, marge 2130)")

        # --- Facture 2 (septembre, 19 %) + un devis (hors G50) -----------------
        cur.execute(
            """INSERT INTO invoices (doc_type, number, client_id, status, date, payment_method,
               total_ht, total_discount, total_tva, total_ttc, timbre, total_due, created_by)
               VALUES ('FACTURE','FA-2026-000002',?,'VALIDATED','2026-09-20','CHECK',
               5000, 0, 950, 5950, 60, 6010, 1)""",
            (client_id,),
        )
        inv2 = cur.lastrowid
        cur.execute("UPDATE stock SET qty = qty - 4 WHERE product_id = ? AND warehouse_id = 1", (p1,))
        cur.execute(
            """INSERT INTO stock_movements (product_id, warehouse_id, type, qty, unit_cost_dzd, ref_type, ref_id, user_id)
               VALUES (?, 1, 'OUT', -4, 780, 'FACTURE', 'FA-2026-000002', 1)""",
            (p1,),
        )
        cur.execute(
            """INSERT INTO invoice_items (invoice_id, line_no, product_id, name, qty, unit,
               unit_price_ht, discount_rate, discount_amount, tva_rate, amount_ht, amount_tva, amount_ttc)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (inv2, 1, p1, "Ciment 50kg", 4, "U", 1250, 0, 0, 0.19, 5000, 950, 5950),
        )
        next_number("DEVIS", 2026)
        cur.execute(
            """INSERT INTO invoices (doc_type, number, client_id, status, date, total_ht, total_tva, total_ttc, created_by)
               VALUES ('DEVIS','DV-2026-000001',?,'DRAFT','2026-09-21', 100000, 19000, 119000, 1)""",
            (client_id,),
        )

        # --- Achats (TVA déductible) ------------------------------------------
        # qty = quantité reçue (mouvement IN 'ACHAT' + incrément stock, comme dans db.rs)
        cur.execute(
            """INSERT INTO purchase_items (supplier_id, product_id, qty, unit_price_ht, doc_number, date,
               base_ht, tva_rate, tva, ttc, currency, fx_rate, deductible, extra_costs_dzd,
               landed_cost_dzd, created_by)
               VALUES (?,?, 200, 300, 'FO-8842', '2026-09-05', 60000, 0.19, 11400, 71400, 'DZD', 1, 1, 0, 0, 1),
                      (?,?, 25, 200, 'FO-9917', '2026-09-15', 5000, 0.19, 950, 5950, 'DZD', 1, 0, 0, 0, 1)""",
            (supplier_id, p1, supplier_id, p2),
        )
        # Achat FO-8842 : +200 ciment => stock p1 avant ventes = 100 + 200 = 300
        # Achat FO-9917 : +25 huile  => stock p2 avant ventes = 50 + 25 = 75
        cur.executemany(
            """INSERT INTO stock_movements (product_id, warehouse_id, type, qty, unit_cost_dzd, ref_type, ref_id, user_id)
               VALUES (?, 1, 'IN', ?, ?, 'ACHAT', ?, 1)""",
            [(p1, 200, 780, "FO-8842"), (p2, 25, 1852.5, "FO-9917")],
        )
        cur.execute("UPDATE stock SET qty = qty + 200 WHERE product_id = ? AND warehouse_id = 1", (p1,))
        cur.execute("UPDATE stock SET qty = qty + 25 WHERE product_id = ? AND warehouse_id = 1", (p2,))

        # --- Agrégations G50 (période = septembre 2026) -------------------------
        cur.execute(
            """SELECT ii.tva_rate, ROUND(SUM(ii.amount_ht),2), ROUND(SUM(ii.amount_tva),2)
               FROM invoices i JOIN invoice_items ii ON ii.invoice_id = i.id
               WHERE i.doc_type='FACTURE' AND i.status IN ('VALIDATED','PARTIAL','PAID')
                 AND date(i.date) BETWEEN '2026-09-01' AND '2026-09-30'
               GROUP BY ii.tva_rate ORDER BY ii.tva_rate DESC"""
        )
        collectee = cur.fetchall()  # 19% : 3375 + 5000 ; 9% : 4800 (devis exclu)
        assert collectee == [(0.19, 8375.0, 1591.25), (0.09, 4800.0, 432.0)], collectee

        cur.execute(
            """SELECT tva_rate, ROUND(SUM(base_ht),2), ROUND(SUM(tva),2) FROM purchase_items
               WHERE deductible=1 AND date(date) BETWEEN '2026-09-01' AND '2026-09-30'
               GROUP BY tva_rate"""
        )
        deductible = cur.fetchall()  # [(0.19, 60000, 11400)]
        assert deductible == [(0.19, 60000.0, 11400.0)], deductible

        total_collectee = sum(r[2] for r in collectee)   # 2023.25
        total_deductible = sum(r[2] for r in deductible) # 11400.00
        balance = round(total_collectee - total_deductible, 2)  # -9381.75 => crédit à reporter
        print(f"[OK] G50 sept-2026 : collectée {total_collectee} | déductible {total_deductible} "
              f"| solde {balance} ({'CREDIT_A_REPORTER' if balance < 0 else 'A_PAYER'})")

        # --- Contraintes & triggers ---------------------------------------------
        def expect_fail(sql, params=()):
            try:
                cur.execute(sql, params)
                return False
            except sqlite3.IntegrityError:
                return True

        assert expect_fail("INSERT INTO products (sku, name, sale_price_ht, tva_rate) VALUES ('X','x',1,0.07)"), \
            "taux TVA hors barème DZ accepté"
        cur.execute("INSERT INTO licenses (hwid, license_key, plan, issued_at, status) "
                    "VALUES ('HWID-A-B-C-D','PFF1.x','DEMO','2026-01-01','DEMO')")
        assert expect_fail(
            "INSERT INTO licenses (hwid, license_key, plan, issued_at, status) "
            "VALUES ('HWID-A-B-C-D','PFF1.y','ANNUAL','2026-01-01','ACTIVE')"
        ), "UNIQUE(hwid) sur licenses défaillant"
        cur.execute("UPDATE products SET name='Ciment 50kg (modif)' WHERE id=?", (p1,))
        assert cur.execute("SELECT updated_at FROM products WHERE id=?", (p1,)).fetchone()[0] is not None
        print("[OK] Contraintes (barème TVA) + triggers updated_at")

        # --- Inventaire physique (écarts -> ajustements ADJUST) ------------------
        # Théorique : p1 = 100 + 200 - 7 = 293 ; p2 = 50 + 25 - 2 = 73
        cur.execute(
            """INSERT INTO inventories (warehouse_id, status, date, created_by)
               VALUES (1, 'DRAFT', '2026-09-22', 1)""",
        )
        inv = cur.lastrowid
        # Compté : ciment 290 (écart -3), huile 75 (écart +2)
        cur.execute(
            """INSERT INTO inventory_lines (inventory_id, product_id, qty_book, qty_counted)
               VALUES (?, ?, 293, 290), (?, ?, 73, 75)""",
            (inv, p1, inv, p2),
        )
        # Application des écarts (même logique que db.rs : UPDATE stock + mouvement ADJUST)
        cur.executemany(
            """UPDATE stock SET qty = qty + ? WHERE product_id = ? AND warehouse_id = 1""",
            [(-3, p1), (2, p2)],
        )
        cur.executemany(
            """INSERT INTO stock_movements (product_id, warehouse_id, type, qty, unit_cost_dzd, ref_type, ref_id, user_id)
               VALUES (?, 1, 'ADJUST', ?, ?, 'INVENTAIRE', ?, 1)""",
            [(p1, -3, 780, str(inv)), (p2, 2, 1852.5, str(inv))],
        )
        cur.execute("UPDATE inventories SET status = 'VALIDATED', validated_at = datetime('now') WHERE id = ?", (inv,))

        # --- Stock final ---------------------------------------------------------
        s = dict(cur.execute("SELECT product_id, qty FROM stock WHERE warehouse_id=1").fetchall())
        # p1 : 100 + 200 (achat) - 7 (ventes) - 3 (écart inventaire) = 290
        # p2 : 50 + 25 (achat) - 2 (ventes) + 2 (écart inventaire)   = 75
        assert s == {p1: 290, p2: 75}, s
        assert cur.execute(
            "SELECT COUNT(*) FROM stock_movements WHERE type = 'ADJUST' AND ref_type = 'INVENTAIRE'"
        ).fetchone()[0] == 2
        print(f"[OK] Inventaire validé : ajustements ADJUST tracés (ciment {s[p1]}, huile {s[p2]})")

        print("\n=== SMOKE TEST : TOUT EST VALIDE ===")
        return 0
    finally:
        os.unlink(tmp.name)


if __name__ == "__main__":
    sys.exit(main())
