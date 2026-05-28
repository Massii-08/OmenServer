# 🧠 CLAUDE.md — Mémoire Projet Bond Scanner

> Ce fichier contient tout le contexte nécessaire pour travailler sur le Bond Scanner.
> Dernière mise à jour : 14 mai 2026

---

## 📦 Projet : Bond Scanner — Recherche Automatique d'Obligations

| Clé | Valeur |
|-----|--------|
| **Emplacement standalone** | `/Users/massimiliano/bot obbligation/` |
| **Emplacement OmenServer** | `/Users/massimiliano/Projet serveur/bond-scanner/` |
| **Stack** | Python + Playwright + openpyxl |
| **Output** | `Opportunita_Bond_YYYY-MM-DD.xlsx` |
| **IA utilisée** | ❌ Aucune — 100% algorithmique |
| **Source de données** | Deutsche Börse (live.deutsche-boerse.com) |
| **Langue interface** | 🇮🇹 Italien (logs, Excel, UI) |

---

## 🏗️ Architecture

```
bot obbligation/
├── main.py                      → CLI entry point (argparse)
├── requirements.txt             → openpyxl, playwright
├── scanner/
│   ├── models.py                → Dataclass ScannedBond
│   ├── market_scraper.py        → Scraper Deutsche Börse Bond Search (Playwright)
│   └── bond_scanner.py          → Orchestrateur principal
├── filter/
│   └── criteria.py              → Moteur de filtrage configurable + échelle ratings
├── calculator/
│   ├── days360.py               → Convention 30/360 (copie Yield Bot)
│   └── yield_calculator.py      → 3 formules de yield (copie Yield Bot)
├── excel/
│   └── report_generator.py      → Génération Excel format "Lista acquisti"
└── bot/
    ├── rate_limiter.py           → Max 2 scansions/jour
    └── .rate_limit.json          → Stockage rate limit
```

---

## ⚙️ Fonctionnement

### Flux Complet
```
🔍 Deutsche Börse Bond Search
   ↓ (Playwright + API JSON interception)
📋 Liste brute de bonds
   ↓ (pré-filtrage prezzo + scadenza)
🔬 Enrichissement données (page détail de chaque bond)
   ↓
📊 Calcul Yield (formule 30/360)
   ↓ (filtrage complet : yield, rating, valuta)
📗 Génération Excel (3 fogli : Euro, USD, GBP)
```

### Critères de Filtrage (Configurables)
| Critère | Défaut | Configurable ? |
|---------|--------|----------------|
| Prezzo massimo | ≤ 100 (sous la pari) | ✅ Oui |
| Yield minimo | ≥ 3% | ✅ Oui |
| Scadenza | ≤ 9 anni | ✅ Oui |
| Rating minimo | BBB- (Investment Grade) | ✅ Oui |
| Valute | EUR, USD, GBP | ✅ Oui |

### Rating
- Le rating est récupéré **uniquement** via Brave Search API en mode `site:fitchratings.com {issuer}` (mirror Yield Bot, 2026-05-28)
- Parsing du rating depuis le **titre** des pages Fitch indexées (regex `FITCH_TITLE_RATING_RE`)
- Politique **fitch_only strict** : pas de fallback S&P / Moody's converti
- Si Fitch ne rate pas l'émetteur → `bond.rating_display = None` → cellule Excel vide (pas de `'?'` placeholder)
- Cache `~/.cache/bond-scanner-ratings.json` (TTL 30 jours par ISIN, négatifs inclus pour ne pas re-burn la quota Brave)
- Clé API : `BRAVE_SEARCH_API_KEY` (partagée avec Yield Bot — 1000 req/mois free largement suffisant pour les 2 bots cumulés)
- Le `merge_ratings()` legacy n'est plus appelé (1 seule source = pas de fusion)
- Échelle S&P / conversions Moody's (`MOODY_TO_SP`, `RATING_SCALE`) conservées car consommées par `filter/criteria.py`

### Formules de Yield (copiées du Yield Bot)
| Type | Formule |
|------|---------|
| **Standard** | `yield = (taux/100)/(prix/100) - (100-prix)/tempo_scadenza/100` |
| **Zero-coupon** | `yield = (100/prix)^(1/anni) - 1` |
| **Perpétuelle** | `yield = (taux/100)/(prix/100)` |

---

## 🖥️ Commandes CLI

```bash
python main.py --scan                             # Scansione standard
python main.py --scan --max-price 98              # Solo bond sotto 98
python main.py --scan --min-yield 0.05            # Solo yield > 5%
python main.py --scan --currencies EUR,USD        # Solo EUR e USD
python main.py --scan --max-maturity 7            # Solo scadenza ≤ 7 anni
python main.py --scan --min-rating A-             # Solo rating ≥ A-
python main.py --scan --output risultati.xlsx     # File output custom
python main.py --scan --show                      # Browser visibile (debug)
python main.py --usage                            # Stato rate limit
```

---

## 🔗 Intégration OmenServer

### Backend
| Fichier | Rôle |
|---------|------|
| `backend/bots/scanner_router.py` | Router FastAPI — 6 routes API |
| `backend/main.py` | Enregistrement du router |

### Routes API
| Méthode | Route | Rôle |
|---------|-------|------|
| `POST` | `/api/bots/scanner/run` | Lancer un scan avec critères |
| `GET` | `/api/bots/scanner/status/{id}` | État + logs temps réel |
| `GET` | `/api/bots/scanner/download/{id}` | Télécharger le résultat |
| `GET` | `/api/bots/scanner/usage` | Vérifier rate limit (2/jour) |
| `POST` | `/api/bots/scanner/stop/{id}` | Arrêter un scan |
| `GET` | `/api/bots/scanner/active` | Reconnexion à un job actif |

### Frontend
| Fichier | Modification |
|---------|-------------|
| `bots_module.js` | Carte virtuelle (vert émeraude) + 3 écrans UI |
| `lang.js` | 29 clés `scanner.*` en FR, EN, IT |

### Écrans UI
1. **Config** — Sliders (prezzo, yield), dropdowns (scadenza, rating), checkboxes (valute)
2. **Running** — Barre de progression, stats temps réel, logs live, bouton stop
3. **Completed** — Résumé stats, bouton download Excel, bouton nouvelle scansione

### Accès
- **Rôles autorisés** : `admin`, `money`
- **Rate limit** : 2 scansions/jour (géré via `.rate_limit.json`)

---

## 📗 Format Excel de Sortie

### Structure (3 fogli)
```
Euro  →  Bonds en EUR, triés par yield décroissant
USD   →  Bonds en USD, triés par yield décroissant
GBP   →  Bonds en GBP, triés par yield décroissant
```

### Colonnes
| Col | Nom | Description |
|-----|-----|-------------|
| A | PAPY | Vide (l'utente segna a mano) |
| B | Nom | ISSUER COUPON% - DD.MM.YY |
| C | Emissione | Date d'émission (format italien: mag.25) |
| D | ISIN | Code ISIN |
| E | Price | Prix courant |
| F | Yield | Rendement calculé (format %) |
| G | Rating (to check) | Rating Fitch/S&P si disponible, sinon `?` |
| H | Volume | Volume d'émission (format Xk) |
| I | Min. pie | Plus petit lot négociable (format Xk) |

### Coloration
- **Noir** : prix ≤ seuil (101 par défaut)
- **Rouge** : prix > seuil

---

## 🔒 Sécurité & Confidentialité

```
✅ RESTE LOCAL                          ⚠️ SORT (mais public)
─────────────────────                   ─────────────────────
• Résultats de la scansione             • Navigation Deutsche Börse
• Yields calculés                         (site public, pas d'API key)
• Fichier Excel généré                  • User-Agent simulé Chrome
• Critères de recherche
```

- **Aucune IA** — formules déterministes uniquement
- **Aucune API key** — scraping du site public
- **Aucune base de données** — fichiers JSON + Excel

---

## 🚨 Points d'Attention

- Le scraper dépend de la structure des API JSON de Deutsche Börse → peut casser si elles changent
- Le rating n'est **pas toujours disponible** sur Deutsche Börse → colonne `(to check)`
- Le rate limit est de **2 scansions/jour** (pas 5 comme le Yield Bot)
- L'exécution prend ~5-15 min selon le nombre de bonds et la connexion
- Le bot utilise Playwright avec Chromium → nécessite `playwright install chromium`

---

## 📋 Relation avec le Yield Bot

| Aspect | Yield Bot | Bond Scanner |
|--------|-----------|-------------|
| **But** | Mettre à jour les yields d'un Excel existant | Trouver de nouvelles obligations sur le marché |
| **Input** | Fichier Excel avec ISIN | Aucun (scanne le marché) |
| **Output** | `_AGGIORNATO.xlsx` | `Opportunita_Bond_YYYY-MM-DD.xlsx` |
| **Scraping** | 1 page par ISIN | Pages de listing + détail |
| **Rate limit** | 5/jour | 2/jour |
| **Code partagé** | — | `days360.py`, `yield_calculator.py` (copiés) |
