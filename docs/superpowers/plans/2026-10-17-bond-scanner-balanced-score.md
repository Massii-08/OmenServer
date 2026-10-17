# Bond Scanner — classement équilibré 50/50 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Exécution réelle : skill `orchestrateur` (Fable spécifie/contrôle, Sonnet code ; les sous-agents ne commitent pas).

**Goal :** remplacer le tri « rating d'abord » du Bond Scanner par un score équilibré 50 % rating / 50 % yield (spec : `docs/superpowers/specs/2026-10-17-bond-scanner-balanced-score-design.md`).

**Architecture :** tout le calcul vit dans `bond-scanner/scanner/scoring.py` (fonctions pures). `bond_scanner.py` ne fait que passer le rating minimum du scan. L'Excel garde l'ordre reçu (`composite_score` non nul → ordre préservé, code existant inchangé).

**Tech stack :** Python 3.9 (pas de syntaxe 3.10+ à l'exécution : pas de `match`, pas de `X | Y` hors annotations — le module a `from __future__ import annotations`), unittest/pytest, stdlib uniquement (`bisect`). Vanilla JS pour le texte d'aide.

**Commande de test :** `cd bond-scanner && "/Users/massimiliano/omenserver Project/Projet serveur/venv/bin/python" -m pytest tests -q` (baseline : 114 passed). Racine du worktree : `/Users/massimiliano/omenserver Project/omen-worktrees/bond-balanced`.

---

## Fichiers

| Fichier | Rôle |
|---|---|
| `bond-scanner/scanner/scoring.py` | Modifié : nouveau calcul, ancien score Defensive supprimé |
| `bond-scanner/tests/test_scoring.py` | Modifié : tests réécrits pour le nouveau calcul |
| `bond-scanner/tests/fixtures/usd_2026-09-06_delivered.json` | **Déjà créé** (Fable) : 100 bonds USD réels `{isin, name, price, yield, rating}` sous la clé `bonds` |
| `bond-scanner/scanner/bond_scanner.py` | Modifié : passe `criteria.min_rating`, commentaires/log |
| `frontend/js/lang.js`, `frontend/js/bots_module.js`, `backend/bots/scanner_router.py`, `frontend/index.html`, `frontend/sw.js` | Texte d'aide ×3 langues, 2 commentaires stale, cache-bust |

---

### Task 1 : nouveau calcul dans `scoring.py` (TDD)

**Interface cible** (noms exacts, utilisés par les tests et par Task 2) :

```python
RATING_WEIGHT = 0.5            # part du rating ; le yield prend 1 - RATING_WEIGHT
DEFAULT_RATING_FLOOR = 'BBB-'  # plancher si rating minimum absent/inconnu

def rating_points(rating: str | None, floor: str | None = None) -> float: ...
def yield_points(value: float | None, sorted_pool_yields: Sequence[float]) -> float: ...
def compute_quotas(target_count: int, n_currencies: int) -> List[int]: ...   # INCHANGÉ
def top_n_per_currency(bonds, target_count, currencies, rating_floor: str | None = None) -> Dict[str, List[ScannedBond]]: ...
```

**Sémantique :**
- `rating_points` : normaliser `rating` et `floor` via `normalize_to_sp` (rating_providers, accepte Moody's). Rating absent ou hors `RATING_SCALE` → `0.0`. Floor absent ou hors échelle → `DEFAULT_RATING_FLOOR`. Avec `fi`/`ri` = index dans `RATING_SCALE` : si `fi == 0` → `1.0` si `ri == 0` sinon `0.0` ; sinon `(fi - ri) / fi` borné à `[0, 1]`.
- `yield_points` : `value is None` → `0.0` ; `n = len(sorted_pool_yields)` ; `n <= 1` → `1.0` ; sinon `below = bisect_left`, `eq = bisect_right - below`, résultat `(below + (eq - 1) / 2) / (n - 1)` borné à `[0, 1]`. La liste reçue est déjà triée et sans `None`.
- `top_n_per_currency` : regrouper les bonds par devise sélectionnée (`(b.currency or '').upper()`, les autres devises sont ignorées) ; **pour chaque devise** : `ys = sorted(yields non-None du pool)`, puis `b.composite_score = RATING_WEIGHT * rating_points(b.rating, rating_floor) + (1 - RATING_WEIGHT) * yield_points(b.calculated_yield, ys)` ; trier par `(-composite_score, index du rating normalisé (999 si inconnu), -(calculated_yield or 0), isin)` ; prendre la quota (`compute_quotas`). Garder le warning « pool secco » existant. Résultat : `{CURRENCY_UPPER: [bonds]}`, comme aujourd'hui.
- **Supprimer** : `DEFAULT_WEIGHTS`, `PRICE_MIN`, `PRICE_MAX`, `_score_price`, `_score_yield`, `_score_rating`, `compute_composite_score`, le paramètre `weights`. Aucun autre consommateur (vérifié par grep).
- Docstring de module à réécrire (décision 2026-10-17, référence au spec) ; commentaires en français ou italien comme le reste du fichier.

**Fichiers :** modifier `bond-scanner/scanner/scoring.py`, `bond-scanner/tests/test_scoring.py`.

- [ ] **Step 1 : réécrire `tests/test_scoring.py`** — retirer les classes qui testent les fonctions supprimées (`TestScorePrice`, `TestScoreYield`, `TestScoreRating`, la classe du score composite). Garder telles quelles toutes les classes `compute_quotas` et ces tests de `TestTopNPerCurrency` : `test_split_3_currencies_each_full_pool`, `test_pool_secco_returns_what_is_available`, `test_higher_score_comes_first`, `test_composite_score_attribute_set`, `test_currency_not_in_selected_is_dropped` (ils restent vrais avec le nouveau calcul). Garder le helper `_bond(isin, currency, price, calc_yield, rating)`. Ajouter :

  **`TestRatingPoints`**
  | Appel | Attendu |
  |---|---|
  | `rating_points('AAA', 'BBB')` | `1.0` |
  | `rating_points('BBB', 'BBB')` | `0.0` |
  | `rating_points('A+', 'BBB')` / `('AA-', 'BBB')` / `('BBB+', 'BBB')` | `0.5` / `0.625` / `0.125` |
  | `rating_points('BBB-', 'BBB')` (sous le plancher) | `0.0` |
  | `DEFAULT_RATING_FLOOR` ; `rating_points('BBB')` ; `rating_points('BBB-')` | `'BBB-'` ; `≈ 1/9` ; `0.0` |
  | `rating_points('BBB', 'XYZ')` (plancher inconnu → BBB-) | `≈ 1/9` |
  | `rating_points('AAA', 'AAA')` ; `rating_points('AA+', 'AAA')` | `1.0` ; `0.0` (pas de ZeroDivisionError) |
  | `rating_points('Baa1', 'BBB')` ; `rating_points('A+', 'Baa2')` | `0.125` ; `0.5` (Moody's des deux côtés) |
  | `rating_points(None, 'BBB')` ; `rating_points('pas un rating', 'BBB')` | `0.0` ; `0.0` |

  **`TestYieldPoints`** — pool `P = [0.03, 0.04, 0.04, 0.05, 0.06]`
  | Appel | Attendu |
  |---|---|
  | `yield_points(0.03, P)` / `(0.04, P)` / `(0.05, P)` / `(0.06, P)` | `0.0` / `0.375` / `0.75` / `1.0` |
  | `yield_points(None, P)` | `0.0` |
  | `yield_points(0.05, [0.05])` ; `yield_points(0.05, [])` | `1.0` ; `1.0` |
  | `yield_points(0.04, [0.04, 0.04, 0.04])` | `0.5` |
  | `yield_points(0.10, P)` ; `yield_points(0.01, P)` (hors pool) | dans `[0, 1]` |

  **Nouveaux tests `TestTopNPerCurrency`** (devise `EUR` sauf mention, `target_count=10`) :
  - `test_compromise_beats_both_extremes` : `SAFE` AAA 4,0 % · `MID` AA- 5,5 % · `RISKY` BBB 6,0 %, `rating_floor='BBB'` → ordre `['MID', 'SAFE', 'RISKY']` (SAFE et RISKY à égalité 0,5 : le meilleur rating passe devant).
  - `test_rating_floor_changes_the_trade_off` : `SAFE` AAA 4,0 % · `RISKY` A- 6,0 % → `rating_floor='BBB'` : `['RISKY', 'SAFE']` ; `rating_floor='A-'` : `['SAFE', 'RISKY']`.
  - `test_default_floor_is_bbb_minus` : sans `rating_floor`, `X` BBB- 6 % et `Y` BBB 4 % → `X.composite_score == 0.5` et `Y.composite_score ≈ 0.5 / 9`.
  - `test_extreme_yield_does_not_crush_the_others` : 10 bonds `A40`…`A49` notés A, yields 4,0 %…4,9 % (pas de 0,1 %), + `OUT` BBB 20 %, `rating_floor='BBB'`, `target_count=20` → 4 premiers `['A49', 'A48', 'A47', 'OUT']` et `A49.composite_score ≈ 0.6375` (un min-max lui aurait donné ≈ 0,22).
  - `test_yield_is_ranked_within_each_currency` : EUR `E35`/`E36`/`E37` (A, 3,5/3,6/3,7 %) et GBP `G50`/`G55`/`G60` (A, 5,0/5,5/6,0 %), `currencies=['EUR', 'GBP']` → `result['EUR'][0].isin == 'E37'`, `result['GBP'][0].isin == 'G60'`, et leurs `composite_score` égaux (assertAlmostEqual).
  - `test_ties_are_broken_by_isin` : `ZZZ` et `AAA1`, mêmes rating A / yield 4 % / prix → ordre `['AAA1', 'ZZZ']`, quel que soit l'ordre d'entrée (tester les deux).
  - `test_missing_yield_counts_zero_on_yield` : `N` AAA `calculated_yield=None`, `P` AAA 4 %, `Q` AAA 5 % → ordre `['Q', 'P', 'N']`, `N.composite_score == 0.5`.
  - `test_price_is_not_in_the_score` : `B_CHEAP` (prix 85) et `A_PAR` (prix 99,9), mêmes rating A / yield 4 % → `composite_score` égaux, ordre `['A_PAR', 'B_CHEAP']`.

  **`TestRealUsdFixture`** — charger `tests/fixtures/usd_2026-09-06_delivered.json` (chemin relatif à `__file__`), clé `bonds`, en `ScannedBond(isin, name, currency='USD', current_price=price, calculated_yield=yield, rating=rating)` ; toujours `currencies=['USD']`, `rating_floor='BBB'`, `target_count=100` :
  - `test_subset_exact_order` : pool réduit aux 8 ISIN `US298785JV96, US045167GA55, US66815M2U00, US912828YS30, XS2830445727, XS2880093849, US302154DJ59, US06406RAR84` → ordre exact `['XS2830445727', 'US66815M2U00', 'US298785JV96', 'US302154DJ59', 'US912828YS30', 'US045167GA55', 'US06406RAR84', 'XS2880093849']` ; premier score ≈ `0.875`, dernier ≈ `0.375`.
  - `test_full_list_top12` : les 100 → 12 premiers `['US66815M2U00', 'XS2830445727', 'US66815M2Q97', 'US302154DJ59', 'XS3061310101', 'XS2865538776', 'XS3443185908', 'XS3276317990', 'US48128BAU52', 'USW8454EBD95', 'USH3698DCW23', 'XS2348658035']` (le 9ᵉ et le 10ᵉ sont à égalité parfaite : l'ISIN départage).
  - `test_full_list_top30_is_a_real_mix` : comptage des ratings du top 30 `== {'AAA': 5, 'AA+': 3, 'AA': 4, 'AA-': 8, 'A+': 10}` et yield moyen du top 30 `> 0.051` (valeur exacte 0,051493 ; rating d'abord donnait 0,044627 avec 6 AAA + 24 AA+).

- [ ] **Step 2 : lancer les tests → ÉCHEC attendu** (`ImportError` sur `rating_points` / `yield_points` / `RATING_WEIGHT` / `DEFAULT_RATING_FLOOR`).
- [ ] **Step 3 : implémenter `scoring.py`** selon l'interface ci-dessus.
- [ ] **Step 4 : lancer toute la suite → PASS** (114 − tests supprimés + nouveaux, zéro échec).

### Task 2 : brancher le plancher dans `bond_scanner.py`

**Fichier :** `bond-scanner/scanner/bond_scanner.py` (aucun test unitaire : `scan()` exige Playwright ; vérifié par relecture du diff + scan réel en Task 5).

- [ ] **Step 1 :** dans l'étape « 4. Task 15 — scoring composito » (~l. 408-425), passer `rating_floor=self.criteria.min_rating` à `top_n_per_currency(...)` ; remplacer le commentaire « Defensive (20% prezzo / 40% yield / 40% rating) » par le nouveau principe (50 % rating / 50 % yield, rang du yield par devise, prix = filtre seulement, 2026-10-17) et le log `⚖️ Scoring composito + top-N per valuta...` par `⚖️ Classement 50 % rating / 50 % yield + top-{N} par devise...`.
- [ ] **Step 2 :** corriger le commentaire stale ~l. 376-381 (« top_n_per_currency garde les MEILLEURS par rating desc ») → « garde les meilleurs compromis rating/yield ».
- [ ] **Step 3 :** relancer toute la suite → PASS ; `grep -n "Defensive\|rating desc\|compute_composite_score\|DEFAULT_WEIGHTS" bond-scanner/scanner` → plus aucune occurrence.

### Task 3 : texte d'aide, commentaires, cache-bust (agent séparé, en parallèle)

**Fichiers :** `frontend/js/lang.js`, `frontend/js/bots_module.js`, `backend/bots/scanner_router.py`, `frontend/index.html`, `frontend/sw.js`.

- [ ] **Step 1 : `scanner.target_count_hint`** (3 occurrences, une par bloc fr/en/it — chercher la clé, pas un numéro de ligne). Le bloc `fr` contient déjà de l'italien pour les clés `scanner.*` : le garder en italien.
  - bloc `fr` et bloc `it` : `'Split equilibrato sulle valute selezionate. Classifica 50% rating / 50% yield.'`
  - bloc `en` : `'Even split across selected currencies. Ranked 50% rating / 50% yield.'`
- [ ] **Step 2 : commentaires stale** — `scanner_router.py` (`target_count: int = 50  # ... best-N triés rating desc`) et `bots_module.js` (`targetCount: 50, // ... best-N triés par rating desc`) → `best-N classés 50 % rating / 50 % yield (2026-10-17)`. Ne rien changer d'autre à ces lignes.
- [ ] **Step 3 : cache-bust** (`origin/main` au 2026-10-17) : `index.html` `lang.js?v=296` → `297`, `bots_module.js?v=239` → `240` ; `sw.js` `const CACHE_NAME = 'omenserver-v193'` → `'omenserver-v194'`.
- [ ] **Step 4 : parse** — `node -e "new Function(require('fs').readFileSync('frontend/js/lang.js','utf8')); new Function(require('fs').readFileSync('frontend/js/bots_module.js','utf8')); console.log('parse OK')"` → `parse OK`.

### Task 4 : contrôle + standalone + docs (Fable)

- [ ] Lire le diff complet ; relancer la suite ; cocher chaque critère des Tasks 1-3.
- [ ] Standalone `../bot obbligation/` (pas un dépôt git ; fichiers identiques à la prod avant changement) : recopier `scanner/scoring.py`, `scanner/bond_scanner.py`, `tests/test_scoring.py`, `tests/fixtures/usd_2026-09-06_delivered.json` ; relancer sa suite.
- [ ] Docs : `bond-scanner/CLAUDE.md` (étape 5 du flux + section format Excel « triés par yield décroissant », déjà faux) ; `CLAUDE.md` racine (ligne d'historique + piège) ; commit unique avec le spec et le plan.

### Task 5 : déploiement + vérification réelle (Fable)

- [ ] `git fetch` ; vérifier que les `?v=` / `CACHE_NAME` d'`origin/main` n'ont pas bougé (sinon re-bumper au-dessus) ; vérifier qu'aucun scan ne tourne (`/api/bots/scanner/active`) ; rebase sur `origin/main`, merge fast-forward dans `main`, push → auto-deploy (1 min).
- [ ] Attendre le déploiement en lisant `index.html` en prod (`?v=297` visible), jamais l'asset non versionné (piège #68l) ; vérifier le texte d'aide dans le panneau (verify-ui).
- [ ] Scan réel USD depuis une copie isolée de `bond-scanner/` sur l'Omen : `--scan --currencies USD --min-rating BBB --target-count 9999 --no-dedup --output <scratch>` → Excel = tout le pool dans le nouvel ordre ; recalculer depuis ce même pool l'ancien top 50 (rating d'abord) et le nouveau ; rapporter yield moyen + répartition des ratings.
