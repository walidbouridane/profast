# ProFast Facture — Architecture Technique

**Cible** : PME algériennes (grossistes, commerçants, comptables) · 100 % hors-ligne · .EXE local.

## 1. Stack retenue

| Couche | Choix | Rôle |
|---|---|---|
| Shell desktop | **Tauri 2 (Rust)** | .EXE léger (~5-15 Mo), commandes IPC |
| UI | **React 18 + Tailwind CSS** | Vue fast-invoicing, dashboards, G50 |
| BDD | **SQLite (WAL)** | Fichier unique `profast.db` (option : SQLCipher chiffré) |
| PDF | **Chromium portable headless** (`--print-to-pdf`) ou `printpdf` (zéro-dep) | HTML→PDF instantané, cachet/QR/signature |
| Licence | **Ed25519** (clé publique embarquée) | Clés signées côté vendeur, HWID lié |
| Auth | **Argon2id** (PIN) | RBAC local, verrou 5 échecs / 15 min |

> Le schéma SQL et le moteur fiscal sont indépendants du shell : portage
> **C# .NET 8 / WinForms+WebView2** possible sans modifier `db/schema.sql`
> ni la logique de `src/fiscal/engine.ts` (portage en C# 1:1).

## 2. Diagramme de flux

```
┌──────────────────────────────────────────────────────────────┐
│  WEBVIEW (React + Tailwind)                                  │
│  • Catalogue/clients PRÉ-CHARGÉS (1 invoke) => recherche     │
│    100 % mémoire (< 10 ms, pas de SQL pendant la saisie)     │
│  • Moteur fiscal TS (recalcul affichage)                     │
└───────────────▲──────────────────────────────────────────────┘
                │  Tauri commands (IPC, ~0,1 ms)
┌───────────────▼──────────────────────────────────────────────┐
│  MAIN PROCESS (Rust)                                         │
│  • license: compute_hwid() + verify_license() [gate boot]    │
│  • db: sqlx/SQLite WAL (tx atomiques: facture + stock + n°)  │
│  • fiscal (recalcul de contrôle) • pdf: print_pdf()          │
│  • audit_log sur chaque action sensible                      │
└──────────────────────────────────────────────────────────────┘
```

## 3. Séquence de démarrage (gate licence)

```
boot → compute_hwid()
     → SELECT licence active dans `licenses`
     → verify_license(clé, hwid, now)   [signature → hwid → expiry (+grâce 7 j)]
     ├─ OK            → accès complet
     └─ KO / absente  → ÉCRAN D'ACTIVATION + MODE DÉMO
                        (compteur `licenses.demo_used`, plafond 10 factures)
```

Format de clé : `PFF1.<base64url(payload JSON)>.<base64url(sig Ed25519)>`
payload : `{plan, serial, hwid, issued_at, expires_at|null}` — **le HWID est
dans le payload signé** : la clé est inutilisable sur un autre PC.

## 4. Matrice RBAC

| Fonction | ADMIN | COMMERCIAL | STOREKEEPER | ACCOUNTANT |
|---|:---:|:---:|:---:|:---:|
| Dashboard financier / marges nettes | ✅ | ❌ | ❌ | ✅ RO |
| Config NIF/NIS/RC, logo, cachet | ✅ | ❌ | ❌ | ❌ |
| Devis / BL / Factures | ✅ | ✅ | ❌ | 👁 RO |
| Prix d'achat / coût de revient | ✅ | ❌ **masqué** | ❌ | ✅ (comptabilité) |
| Marge réelle (DZD) | ✅ | ❌ **masquée** | ❌ | ❌ |
| Modif. prix/remises en ligne | ✅ | selon `users.can_edit_prices` | ❌ | ❌ |
| Entrées/Sorties stock, inventaires, transferts | ✅ | ❌ | ✅ | ❌ |
| Rapports fiscaux, G50, exports PC Compta/SAGE | ✅ | ❌ | ❌ | ✅ |
| Licences / utilisateurs | ✅ | ❌ | ❌ | ❌ |

Règle technique : le masquage est fait **côté main-process** (la colonne
`cost_dzd` n'est tout simplement jamais sérialisée pour les rôles sans droit)
+ règle visuelle côté React. Toute action sensible est journalisée dans
`audit_log` (user, action, before/after JSON, hwid, timestamp).

## 5. Numérotation

`FA-2026-000012` = `prefixe-type` + `-` + `année` + `-` + `6 chiffres`.
Séquence en `doc_sequences (doc_type, year)` :

```sql
INSERT INTO doc_sequences (doc_type, year, last_number) VALUES (?1, ?2, 1)
ON CONFLICT (doc_type, year) DO UPDATE SET last_number = last_number + 1
RETURNING last_number;   -- dans la TX d'enregistrement de la facture
```

## 6. Écriture atomique d'une facture (transaction unique)

```
BEGIN
  1. n° = séquence (verrou explicite: SELECT ... FOR UPDATE via pragma)
  2. recalcul fiscal (moteur, source de vérité) — reject si divergence UI
  3. INSERT invoices + invoice_items (totaux dénormalisés, cost/margin DZD)
  4. si FACTURE: UPDATE stock (OUT) + stock_movements (ref=FACTURE)
  5. INSERT audit_log
COMMIT
```

## 7. PDF (100 % local)

Gabarit React → HTML (images cachet/signature/QR en base64) →
`chrome --headless=new --print-to-pdf`. Le QR contient :
`PROFAST|N°|date|NIF vendeur|client|montant TTC` (vérification client
instantanée). Timbre mentionné selon le mode de paiement (art. 100 code du
timbre : mention obligatoire au règlement espèces).

Alternative légère : crate `printpdf` (layout vectoriel) si l'on ne veut pas
embarquer Chromium (~100 Mo).

## 8. WhatsApp

`https://wa.me/<numéro>?text=<message>` pré-rempli (N°, dates, TTC, timbre,
total à régler, NIF). ⚠ Limitation web : `wa.me` ne joint pas de fichier
automatiquement — l'app ouvre le PDF dans la visionneuse locale (partage)
ou propose l'envoi via l'app WhatsApp desktop (copier le lien + joindre le
fichier local en un geste). Documenté dans l'UI.

## 9. Performance (< 10 ms)

- WAL + `synchronous=NORMAL` : écritures non bloquantes.
- Catalogue entier pré-chargé dans le webview (≈ 50 k articles en ~30 ms au
  boot) → recherche fuzzy locale 0 requête.
- Totaux dénormalisés dans `invoices` → dashboard sans `SUM()`.
- Index couvrants : `(client_id, date)`, `(doc_type, date)`, `sku`, `barcode`.
- Recalcul des totaux en `useMemo` React (O(lignes), < 1 ms).

## 10. Sécurité

- Argon2id (m=64 Mo, t=3) sur `pin || username`, verrou 5 échecs.
- Clé de licence signée (impossible à forger / dupliquer sur autre machine).
- `audit_log` horodaté avec HWID (non repoussable localement, exportable).
- Option : **SQLCipher** pour chiffrer `profast.db` au repos (clé dérivée du
  PIN admin au 1er lancement).
- Pas de télémétrie, pas d'appel réseau : l'app ne fait **aucune** connexion.

## 11. Build & distribution

```bash
pnpm i && pnpm tauri dev          # développement
pnpm tauri build                  # NSIS .exe (Windows) + appimage (Linux)
cargo run --bin pff-keygen -- init                    # vendeur
cargo run --bin pff-keygen -- sign --hwid HWID-... --plan ANNUAL --serial PF-2026-000001 --days 365
```

Mises à jour sans Internet : installateur versionné local (le client met à
jour par clé USB ; la licence reste valide, le HWID n'ayant pas changé).
