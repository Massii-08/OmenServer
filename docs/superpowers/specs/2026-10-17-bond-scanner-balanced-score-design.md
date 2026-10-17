# Bond Scanner — classement équilibré 50 % rating / 50 % yield

Date : 2026-10-17 · Demande Massii : « plutôt que les meilleurs ratings, la liste doit être un entre-deux des meilleurs rating et yield ».

## Problème

`bond-scanner/scanner/scoring.py::top_n_per_currency` calcule un score composite (20 % prix / 40 % yield / 40 % rating) mais **ne trie pas dessus** : la clé de tri est `(rating, composite)`, donc rating d'abord, le composite ne sert qu'à départager deux bonds de même rating. Mesure sur l'Excel USD du 2026-09-06 (job `f76189ed`, 100 bonds) : top 30 = 6 AAA + 24 AA+ (surtout des bons du Trésor US), yield moyen 4,46 % ; les AA- à 5,2-5,5 % finissent en bas et les A/BBB n'entrent jamais.

Défauts secondaires de l'ancien calcul :
- yield normalisé par le max **toutes devises confondues** → un EUR à 3,9 % était jugé contre un GBP à 6 % ;
- normalisation en valeur (yield / max) → un seul yield extrême écrase la note de tous les autres (cas réel GBP : NatWest 6,97 % à 7 mois d'échéance).

## Décision (validée par Massii, option « Score 50/50 » parmi 3)

Pour chaque devise, au moment de garder les N meilleurs bonds :

| Composante | Poids | Calcul |
|---|---|---|
| Rating | 50 % | position linéaire entre le rating minimum du scan (= 0) et AAA (= 1). Défaut si absent/inconnu : BBB- |
| Yield | 50 % | rang percentile du yield **dans le pool de la même devise** : pire = 0, meilleur = 1, ex-aequo = rang moyen ; yield absent = 0 ; pool d'un seul yield = 1 |

- `score = 0,5 × rating + 0,5 × yield`, stocké dans `ScannedBond.composite_score` (∈ [0, 1]).
- Tri : score décroissant, puis meilleur rating, puis meilleur yield, puis ISIN croissant (ordre déterministe).
- **Le prix sort du classement** : il reste un filtre (prix max). Le yield intègre déjà la décote d'un bond sous le pair ; le compter aussi le compterait deux fois.
- Poids exposé en constante de module (`RATING_WEIGHT = 0.5`) — pas de curseur UI (option écartée par Massii).

Avec le rating minimum par défaut de l'UI (BBB), en points sur 50 : AAA 50 · AA+ 43,75 · AA 37,5 · AA- 31,25 · A+ 25 · A 18,75 · A- 12,5 · BBB+ 6,25 · BBB 0. Un AAA mal payé et un BBB très payé plafonnent tous deux à 50/100 : ce sont les compromis qui montent.

Effet mesuré sur les 100 bonds USD du 2026-09-06 (minorant : ces 100 avaient déjà été choisis rating d'abord) : top 30 → 5 AAA · 3 AA+ · 4 AA · 8 AA- · 10 A+, yield moyen 4,46 % → 5,15 %.

## Périmètre

Change :
- `scanner/scoring.py` : nouveau calcul ; suppression de l'ancien score Defensive (`DEFAULT_WEIGHTS`, `PRICE_MIN/MAX`, `_score_price`, `_score_yield`, `_score_rating`, `compute_composite_score`), qui n'a plus aucun consommateur.
- `scanner/bond_scanner.py` : transmet `criteria.min_rating` au classement ; commentaires et log mis à jour.
- Texte d'aide `scanner.target_count_hint` (FR/EN/IT) + commentaires stale (`scanner_router.py`, `bots_module.js`) + cache-bust.
- Copie standalone `../bot obbligation/` (fichiers identiques à la prod au 2026-10-17) : recopiée.

Ne change pas : format de l'Excel (aucune colonne), quotas par devise (`compute_quotas`), filtres, mémoires found/seen, collecte de tout le pool avant classement.

## Tests

TDD (`bond-scanner/tests/test_scoring.py`, unittest, Python 3.9) :
- points rating (bornes, défaut BBB-, plancher AAA sans division par zéro, notation Moody's) ;
- points yield (rang, ex-aequo, absent, pool d'un seul) ;
- le compromis passe devant les deux extrêmes ; le plancher de rating change l'arbitrage ;
- un yield aberrant n'écrase pas les autres et ne prend pas la tête au rating minimum ;
- normalisation par devise ; départage déterministe ;
- fixture réelle `tests/fixtures/usd_2026-09-06_delivered.json` : ordre exact d'un sous-ensemble de 8 bonds + top 12 + propriétés du top 30.

## Vérification bout en bout

Après déploiement : scan USD réel depuis une **copie isolée** de `bond-scanner/` sur l'Omen, `--no-dedup --target-count 9999` → Excel contenant tout le pool dans le nouvel ordre. La copie a son propre `.rate_limit.json` (ne consomme pas les 2 scans/jour de Massii) et `--no-dedup` ne lit ni n'écrit les mémoires found/seen. Comparaison ancien (rating d'abord) vs nouveau top 50 sur ce même pool.
