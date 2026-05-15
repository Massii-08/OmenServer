# 🤖 AGENTS.md — Guide du Bond Scanner Bot

> Référence complète du Bond Scanner et de son intégration OmenServer.
> Dernière mise à jour : 14 mai 2026

---

## 📋 Vue d'Ensemble

| Agent | Type | IA ? | Statut |
|-------|------|------|--------|
| 🔍 Bond Scanner | Bot Python autonome | ❌ Non | ✅ Opérationnel |

> **Note** : Le Bond Scanner n'utilise aucune IA. Il est basé sur du scraping web (Playwright), des formules financières déterministes, et du filtrage algorithmique.

---

## 🔍 Bond Scanner — Recherche Automatique d'Obligations

### Identité

| Propriété | Valeur |
|-----------|--------|
| **Nom** | Bond Scanner |
| **Type** | Bot Python autonome + intégration OmenServer |
| **Emplacement standalone** | `/Users/massimiliano/bot obbligation/` |
| **Emplacement serveur** | `/Users/massimiliano/Projet serveur/bond-scanner/` |
| **API Backend** | `backend/bots/scanner_router.py` |
| **UI Frontend** | `frontend/js/bots_module.js` (section Bond Scanner) |
| **Langue** | 🇮🇹 Italien (logs, Excel, messages) |

### Ce qu'il fait

```
🌐 Deutsche Börse → 📋 Filtrage → 📊 Calcul Yield → 📗 Excel
```

1. **Scanne** le marché obligataire de Deutsche Börse (Bond Search)
2. **Filtre** selon des critères configurables (prezzo, yield, scadenza, rating)
3. **Calcule** le rendement avec la formule 30/360 du Yield Bot
4. **Génère** un fichier Excel au format "Lista acquisti" avec 3 fogli

### Modules Internes

#### `scanner/market_scraper.py` — Scraper de Marché

- Utilise **Playwright** (Chromium headless)
- **Technique** : interception des API JSON (pas de DOM scraping)
- Navigue la page Bond Search de Deutsche Börse
- Pagination automatique (jusqu'à 20 pages)
- Enrichissement par page de détail pour chaque bond candidat
- Recherche récursive des champs dans les JSON (robuste aux changements de structure)

**Champs extraits** :
| Champ | Clés API recherchées |
|-------|---------------------|
| Prix | `lastprice`, `last`, `close`, `price`, `currentprice` |
| Coupon | `coupon`, `couponrate`, `interestrate`, `nominalinterest` |
| Scadenza | `maturity`, `maturitydate`, `expirationdate`, `redemptiondate` |
| Rating | `rating`, `sprating`, `moodyrating`, `fitchrating`, `creditrating` |
| Volume | `volume`, `issuevolume`, `outstanding` |
| Min piece | `minimumdenomination`, `smallestunit`, `minpiece`, `lotsize` |

#### `filter/criteria.py` — Moteur de Filtrage

**Critères configurables** :
| Critère | Défaut | Plage |
|---------|--------|-------|
| `max_price` | 100 | 85 — 110 |
| `min_yield` | 3% | 1% — 10% |
| `max_maturity_years` | 9 ans | 5 — 15 |
| `min_rating` | BBB- | A → BBB- |
| `currencies` | EUR, USD, GBP | Checkboxes |

**Échelle de Rating** (S&P) :
```
AAA → AA+ → AA → AA- → A+ → A → A- → BBB+ → BBB → BBB-
                                                    ↑ cutoff Investment Grade (défaut)
BB+ → BB → BB- → B+ → B → ... (speculative grade — rejeté)
```

**Conversion Moody's** intégrée :
```
Aaa → AAA,  Aa1 → AA+,  A1 → A+,  Baa1 → BBB+,  Baa3 → BBB-
```

⚠️ Le rating est récupéré depuis Deutsche Börse (pas calculé). Il n'est pas toujours disponible.

#### `calculator/` — Formules Financières

Copiées identiques du Yield Bot :

| Fonction | Type de Bond |
|----------|-------------|
| `calculate_yield_at_current_price()` | Standard (coupon + maturité) |
| `calculate_yield_zero_coupon()` | Zero-coupon (pas de coupon) |
| `calculate_yield_perpetual()` | Perpétuelle (pas de maturité) |
| `days360()` | Convention 30/360 (réplique Excel DAYS360) |

#### `excel/report_generator.py` — Génération Excel

- 3 fogli : **Euro**, **USD**, **GBP**
- Colonnes : PAPY, Nom, Emissione, ISIN, Price, Yield, Rating, Volume, Min.pie
- Trié par yield décroissant dans chaque foglio
- Coloration rouge si prix > seuil (101 par défaut)
- Dates en format italien (mag.25, feb.23)
- Volumes en format compact (500k, 1,000k)

#### `bot/rate_limiter.py` — Rate Limiter

- **Max 2 scansions par jour** (plus strict que le Yield Bot à 5)
- Stocké dans `.rate_limit.json`
- Reset automatique à minuit
- API `/usage` pour vérifier le compteur

### Sécurité & Confidentialité

```
✅ RESTE LOCAL                          ⚠️ SORT (mais public)
─────────────────────                   ─────────────────────
• Résultats de recherche                • Navigation du site Deutsche Börse
• Yields calculés                         (site public, aucune API key)
• Fichier Excel                         • User-Agent simulé Chrome
• Critères de filtrage
```

- **Aucune IA** — algorithmes déterministes uniquement
- **Aucune API key requise** — scraping du site public
- **Aucune donnée personnelle envoyée**

---

## 🔗 Intégration OmenServer

### Architecture d'Intégration

```
┌─────────────────────────────────────────────────┐
│                  OmenServer                      │
│  ┌─────────────┐    ┌────────────────────────┐  │
│  │  Frontend    │    │  Backend (FastAPI)      │  │
│  │  bots_module │◄──►│  scanner_router.py     │  │
│  │   .js        │    │    ↓ subprocess         │  │
│  └─────────────┘    │  bond-scanner/main.py  │  │
│                      │    ↓                     │  │
│                      │  Opportunita_Bond.xlsx  │  │
│                      └────────────────────────┘  │
└─────────────────────────────────────────────────┘
                        │
                        ▼
              Deutsche Börse (scraping)
```

### Routes API

| Méthode | Route | Rôle |
|---------|-------|------|
| `POST` | `/api/bots/scanner/run` | Lancer un scan avec critères |
| `GET` | `/api/bots/scanner/status/{id}` | État + logs + stats temps réel |
| `GET` | `/api/bots/scanner/download/{id}` | Télécharger l'Excel résultat |
| `POST` | `/api/bots/scanner/stop/{id}` | Arrêter un scan en cours |
| `GET` | `/api/bots/scanner/usage` | Rate limit (2/jour) |
| `GET` | `/api/bots/scanner/active` | Reconnexion à un job actif |

### Accès & Permissions

| Rôle | Accès |
|------|-------|
| `admin` | ✅ Complet |
| `money` | ✅ Complet |
| `moderator` | ❌ Pas de carte visible |
| `developer` | ❌ Pas de carte visible |
| `player` | ❌ Pas de carte visible |
| `spectator` | ❌ Pas de carte visible |

### Exécution Backend

Le scan est exécuté via `subprocess.Popen` (comme le Yield Bot) :
- Process Python séparé → ne bloque pas FastAPI
- Capture stdout en temps réel via thread daemon
- Parsing regex des logs pour les stats live
- Le process peut être terminé via `proc.terminate()`

### Interface Frontend (3 écrans)

1. **Config** — Formulaire avec sliders + dropdowns + checkboxes
2. **Running** — Progress bar + 4 stat cards + terminal de logs + bouton stop
3. **Completed** — Résumé final + bouton download + bouton nouvelle scansione

---

## 📊 Relation avec les Autres Bots

```
┌────────────────────┐     ┌─────────────────────┐
│   Yield Bot 🏦     │     │  Bond Scanner 🔍     │
├────────────────────┤     ├─────────────────────┤
│ MET À JOUR un      │     │ TROUVE de nouvelles  │
│ fichier Excel       │     │ obligations sur le   │
│ existant avec les   │     │ marché selon des     │
│ derniers prix       │     │ critères             │
├────────────────────┤     ├─────────────────────┤
│ Input: Excel + ISIN │     │ Input: Critères      │
│ Output: _AGGIORNATO │     │ Output: Opportunita_ │
│ Rate: 5/jour        │     │ Rate: 2/jour         │
│ Scraping: 1 par ISIN│     │ Scraping: marché     │
└────────────────────┘     └─────────────────────┘
        │                           │
        └──── Code partagé ────────┘
              • days360.py
              • yield_calculator.py
```

---

## 🔮 Évolutions Futures Possibles

- [ ] Source de rating supplémentaire (CBONDS, autre site)
- [ ] Alertes push quand de nouvelles opportunités apparaissent
- [ ] Historique des scansions (comparer les résultats jour après jour)
- [ ] Filtre par émetteur ou secteur
- [ ] Export PDF du rapport
- [ ] Intégration avec le Yield Bot (ajouter les bonds trouvés au portefeuille)
