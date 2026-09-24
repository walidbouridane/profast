# ProFast Facture

Application desktop **100 % locale** (sans Internet) de facturation pour le
marché algérien — PME, grossistes, commerçants, comptables.
**Tauri 2 (Rust) · React 18 + Tailwind CSS · SQLite (WAL) · PDF local · Licence HWID.**

## Ce qui est livré

| # | Livrable | Fichier(s) |
|---|---|---|
| 1 | **Schéma SQLite complet** (13 tables + triggers + seed) | `db/schema.sql` |
| 2 | **HWID + licence signée (Ed25519)** + mode Démo 10 factures | `src-tauri/src/license/{hwid,verify,keygen,commands}.rs` |
| 3 | **Moteur fiscal DZ** : TVA 19/9/0, timbre, G50, coûts posés, export PC Compta/SAGE | `src/fiscal/engine.ts` (UI) + `src-tauri/src/fiscal.rs` (source de vérité) |
| 4 | **Facturation rapide** (F2/F5/F9/F12, scan code-barres, marge ADMIN-only) | `src/components/InvoiceFastEditor.tsx` |
| 5 | **Application complète** : boot licence → login PIN → RBAC, dashboards, G50, stock, catalogue, PDF A4 (QR + cachet + signature), WhatsApp | `src/App.tsx`, `src/pages/*`, `src/templates/invoiceHtml.ts`, `src-tauri/src/{db,auth,commands,lib}.rs` |
| 6 | **Achats & Fournisseurs** : multi-devise (taux officiel/parallèle), coût de revient posé en DZD, TVA déductible G50, entrée de stock | `src/pages/PurchasesScreen.tsx`, `db.rs::record_purchase` |
| 7 | **Inventaires physiques** : théorique vs compté, écarts surlignés, valorisation DZD, ajustements ADJUST tracés | `src/pages/InventoryScreen.tsx`, `inventory_core.rs`, `db.rs::inventory_validate` |
| 8 | **Gestion utilisateurs** : création rôle/PIN, activation, droit « prix modifiables », changement de PIN forcé au 1er login | `src/pages/UsersScreen.tsx`, `src/pages/ChangePinGate.tsx`, `db.rs::create_user/change_pin` |

## Arborescence

```
profast-facture/
├── db/schema.sql                     # DDL (source de vérité BDD)
├── docs/ARCHITECTURE.md              # stack, flux, RBAC, perf, sécurité
├── scripts/smoke_test.py             # validation SQL (schéma + G50 + stock)
├── index.html, vite.config.ts, tsconfig.json, tailwind.config.js
├── package.json                      # pnpm install && pnpm tauri dev
├── src/
│   ├── main.tsx, styles.css, App.tsx # shell (boot licence → PIN → RBAC)
│   ├── api.ts                        # bridge Tauri typé
│   ├── types.ts                      # miroirs des structs Rust
│   ├── components/InvoiceFastEditor.tsx
│   ├── fiscal/engine.ts + engine.test.ts
│   ├── lib/catalogImport.ts          # import/export CSV/XLSX
│   ├── pages/{ActivationScreen,LoginScreen,ChangePinGate,G50Screen,DashboardScreen,StockScreen,CatalogScreen,PurchasesScreen,InventoryScreen,UsersScreen}.tsx
│   └── templates/invoiceHtml.ts      # gabarit A4 (QR, cachet, signature, timbre)
├── src-tauri/
│   ├── Cargo.toml, tauri.conf.json, build.rs
│   └── src/
│       ├── lib.rs, main.rs           # wiring Tauri (setup BDD + commandes)
│       ├── bin/keygen_bin.rs         # ⚠ pff-keygen (vendeur, non distribué)
│       ├── db.rs                     # persistance : facture ATOMIQUE, G50, stock, achats, inventaires, audit
│       ├── auth.rs                   # PIN Argon2id + verrou 5 échecs / 15 min
│       ├── inventory_core.rs         # calculs purs d'inventaire (écarts, valorisation DZD)
│       ├── fiscal.rs                 # recalcul fiscal serveur (mêmes vecteurs que TS)
│       ├── commands.rs               # commandes + garde-fous RBAC
│       ├── pdf.rs                    # HTML → PDF headless local
│       └── license/                  # hwid.rs, verify.rs, keygen.rs, commands.rs
└── tools/rust-check/                 # crate de test : cargo test (sans Tauri)
```

## Lancer l'application

Prérequis : [Node 20+](https://nodejs.org) (ou pnpm), [Rust stable](https://rustup.rs),
les deps système Tauri (Windows : rien d'autre ; Linux : webkit2gtk-4.1, libsoup3…).

```bash
pnpm install
pnpm tauri dev            # développement (Vite + Tauri)
pnpm tauri build          # .exe (NSIS) / .AppImage / .dmg
```

Au 1er lancement : création du compte Administrateur (PIN Argon2id),
puis écran d'activation (HWID affiché, clé `PFF1.…` à saisir) —
sans clé : mode Démo limité à 10 factures.

## Clés de licence (côté vendeur)

```bash
cargo run --bin pff-keygen -- init
cargo run --bin pff-keygen -- sign --hwid HWID-XXXX-XXXX-XXXX-XXXX --plan ANNUAL --serial PF-2026-000001 --days 365
# Licence à vie : --plan LIFETIME (sans --days)
```

La clé publique générée par `init` remplace `PUB_KEY_V1_B64` dans
`src-tauri/src/license/verify.rs`. Le binaire `pff-keygen` et le fichier
`vendor_private.key.b64` ne sont **jamais** distribués.

## Tests & validation (état actuel)

```bash
python3 scripts/smoke_test.py          # ✅ 100 % : DDL, séquences, facture, G50, achats, inventaire
npx tsx --test src/fiscal/engine.test.ts  # ✅ 13/13 vecteurs fiscaux
cargo test --manifest-path tools/rust-check/Cargo.toml  # ✅ 21/21 : HWID, Ed25519, fiscal, inventaire
npx tsc --noEmit                       # ✅ 0 erreur (strict)
```

## Points de vigilance (à valider avec le comptable)

1. **Timbre** : 1 % du TTC, arrondi au dinar supérieur, min 5 DA, plafond
   2 500 DA (art. 100 code du timbre), reçu de caisse min 2 DA — tout est
   paramétrable dans `company_config`.
2. **Compte timbre** : `ACCOUNTS.timbre = "444"` par défaut (pratique 635
   possible) — 1 constant à ajuster.
3. **SAGE 100** : mapper `toSage100Csv()` sur le modèle d'import de la
   version installée.
4. **Moteur PDF** : Chrome/Chromium portable requis (émbarqué dans
   `resources/chromium/`) ou installation système ; alternative zéro-dep :
   crate `printpdf` (layout vectoriel).
5. **HWID en VM** : champs DMI vides → `UNKNOWN` (HWID stable mais moins de
   matière première).
