# Paper Trading + Coach — design (2026-08-24)

Module OmenServer : simulateur de **trading actif** en argent fictif sur des
actions réelles, doublé d'un **coach à mémoire persistante** qui apprend le
profil de l'utilisateur.

Public : Massii, débutant complet, résident suisse. Objectif déclaré :
apprendre à **prendre du risque de façon mesurée**, pas à jouer la sécurité.

---

## 1. Décisions arrêtées

| Sujet | Décision | Pourquoi |
|---|---|---|
| Style | **Trading actif** (swing) | choix utilisateur |
| Hébergement | module OmenServer | réutilise auth, cours Yahoo, design Ion, accès mobile |
| Devise | **CHF** | résident suisse |
| Capital initial | 10 000 CHF (paramétrable) | ordre de grandeur réaliste |
| Données | Yahoo chart (`market-pulse/pulse/fetcher.py`), **différé ~15 min** | déjà en prod, zéro nouvelle dep. Suffit au swing, pas au scalping. |
| Accès RBAC | `admin` + `money` | convention des 3 autres bots finance |
| LLM | Claude CLI (patron `pulse/analyst.py`) — **hors boucle** | le runtime reste déterministe (règle projet) |
| Nouvelles deps | **AUCUNE** | auto-deploy propre (piège #33g) |

## 2. Position morale du coach

Le coach **ne recommande jamais un titre**, ni en simulation ni en réel : il ne
dit pas quoi acheter. Il travaille sur la **méthode de décision** :

- il exige une thèse écrite AVANT l'entrée, et la confronte à la sortie ;
- il est **agressif sur les idées, impitoyable sur le dimensionnement** ;
- il ne pousse pas vers « le plus sûr » : il pousse vers **le risque mesuré**.
  Un risque de 2 % du capital assumé et décidé à l'avance vaut mieux qu'un
  risque de 0,3 % subi sans le savoir.

## 3. Architecture

```
backend/bots/paper/
  models.py   # dataclasses Portfolio/Position/Order/Trade  (PUR)
  fees.py     # profils Yuh/Swissquote/IBKR + droit de timbre CH (PUR)
  fills.py    # exécution market/limit/stop contre les bougies (PUR)
  risk.py     # sizing, R multiple, drawdown, exposition, quotas AFC (PUR)
  coach.py    # détection de biais + profil qui grandit (PUR)
  store.py    # persistance JSON atomique 0o600 (I/O)
  quotes.py   # passerelle vers le fetcher Yahoo (I/O, injectable)
  llm.py      # appel Claude CLI (I/O, injectable)
backend/bots/paper_router.py
frontend/js/paper_module.js
data/paper_trading/<user>.json          # portefeuille
data/paper_trading/<user>.coach.json    # mémoire du coach
```

**Règle de séparation** : tout ce qui est marqué PUR n'a AUCUN I/O et AUCUN
réseau → 100 % testable hors-ligne. Les 3 modules d'I/O sont injectés.

## 4. Contrat de données (fige les interfaces entre lots)

```python
Position: symbol, qty, avg_price, currency, opened_at, side  # side: long|short
Order:    id, symbol, side, kind, qty, limit_price, stop_price, created_at,
          status, thesis, stop_loss, target, risk_chf
Trade:    symbol, side, qty, entry_price, exit_price, entry_at, exit_at,
          fees_chf, stamp_duty_chf, pnl_chf, pnl_pct, r_multiple,
          thesis, exit_reason, planned_stop
Portfolio: cash_chf, positions[], open_orders[], trades[], fee_profile,
           initial_capital, created_at
```

`r_multiple` = (résultat) / (risque initial planifié). **Métrique centrale** :
c'est elle qui apprend le risque, pas le pourcentage de gain.

## 5. Frais simulés (pédagogie n°1)

Trois profils réels sélectionnables, pour que l'utilisateur VOIE le coût :

| Profil | Courtage | Droit de timbre |
|---|---|---|
| Yuh | ~0,5 % du montant | oui (courtier suisse) |
| Swissquote | palier fixe selon montant | oui |
| Interactive Brokers | ~0,05 %, minimum bas | **non** (courtier étranger) |

Droit de timbre fédéral : **0,075 %** titres suisses / **0,15 %** titres
étrangers, **à l'achat ET à la vente**, uniquement pour les courtiers suisses.

## 6. Détection de biais — DÉTERMINISTE (aucun LLM)

| Code | Règle de détection |
|---|---|
| `cut_winners_early` | R moyen des gagnants < \|R moyen des perdants\| |
| `let_losers_run` | durée moyenne des perdants > 1,5× celle des gagnants |
| `no_stop` | > 30 % des trades ouverts sans `stop_loss` |
| `oversized` | risque planifié > 2 % du capital |
| `revenge_trade` | nouvelle entrée < 30 min après une perte ET taille supérieure |
| `overtrading` | volume annualisé approchant 5× le capital (seuil AFC) |
| `concentration` | une position > 25 % du portefeuille |
| `fee_bleed` | frais cumulés > 20 % du P&L brut |
| `no_thesis` | thèse vide ou < 15 caractères |

Le LLM n'intervient QUE pour rédiger (post-mortem, fiche d'analyse, quiz) —
jamais pour décider. Chaque biais cite ses trades en preuve.

## 7. Mode Arène

Un défi risqué par semaine, en argent fictif, tiré d'un catalogue fixe
(concentration, résultats trimestriels, vente à découvert, tenir malgré un
drawdown). But : faire VIVRE le risque, avec débriefing chiffré ensuite.

## 8. Garde-fou fiscal suisse

Compteur permanent des 5 critères de la circulaire AFC n°36 (détention ≥ 6
mois, volume ≤ 5× le capital, gains < 50 % du revenu, pas de levier, dérivés de
couverture seulement) : l'utilisateur voit en direct s'il sortirait du statut
d'investisseur privé — la leçon la plus chère qu'un trader suisse puisse
ignorer.

---

## 9. Contrat d'API (figé — le router et le frontend s'y conforment)

Préfixe `/api/paper`, tout gated `require_role("admin", "money")`.

| Endpoint | Verbe | Corps / retour |
|---|---|---|
| `/portfolio` | GET | portefeuille + quotes live des positions + `exposure` + `afc` + `stats` + `biases` |
| `/portfolio/reset` | POST | `{initial_capital?, fee_profile?}` → remet à zéro (garde le profil coach) |
| `/search?q=` | GET | recherche ticker Yahoo → `[{symbol, name, exchange, currency}]` |
| `/quotes?symbols=A,B` | GET | `{symbol: {price, currency, change_pct, fx_rate_chf}}` |
| `/orders` | POST | `{symbol, side, kind, qty, limit_price?, stop_price?, thesis, stop_loss?, target?}` → market = exécuté immédiatement au dernier cours ; limit/stop = stocké `open`. Retourne l'ordre + `warnings` (thèse vide, pas de stop, risque > 2 %) — on AVERTIT, on ne bloque jamais. |
| `/orders/{id}/cancel` | POST | annule un ordre `open` |
| `/positions/{symbol}/close` | POST | `{qty?}` (défaut tout) → clôture au marché |
| `/tick` | POST | passe les ordres `open` + stops de protection contre les bougies intraday récentes → `{fills: [...]}` (appelé par le front au chargement/refresh) |
| `/coach` | GET | biais courants + `coach_summary` du profil |
| `/coach/ask` | POST | `{question?}` → message du coach (LLM, contexte = summary+stats+derniers trades) |
| `/analysis` | POST | `{symbol}` → fiche d'analyse LLM (chiffres via Yahoo chart + quoteSummary si dispo) |
| `/postmortem` | POST | `{trade_index?}` (défaut dernier trade clos) → post-mortem LLM |
| `/lessons` | GET | catalogue + progression (quiz réussis, depuis le profil coach) |
| `/lessons/{id}/quiz` | POST | `{answers: [int]}` → `{score, correct: [int], passed}` ; si passed, enregistré dans le profil |
| `/arena` | GET | défi de la semaine (déterministe : hash de l'ISO-week) + historique |
| `/arena/accept` | POST | accepte le défi de la semaine |

Le LLM (3 endpoints marqués LLM) suit le patron `market-pulse/pulse/analyst.py`
(`claude_bin()`, subprocess injectable) — timeout 120 s, erreur → 502 avec
message clair, JAMAIS de crash du router. Prompt système du coach : direct,
exigeant, tutoiement, focalisé méthode/risque, ne recommande JAMAIS un titre
précis à l'achat, et rappelle que c'est un simulateur.

## 10. Contenu pédagogique

- `backend/bots/paper/lessons_fr.json` : 8 leçons FR (le contenu pédagogique
  est FR-only en v1 — l'UI chrome reste i18n ×3). Écrit à la main par Fable.
- `backend/bots/paper/arena.json` : catalogue de défis. Sélection de la semaine
  = `sha1(iso_year-week) % len(catalog)`.

## 11. Carnet du coach — mémoire lisible façon Obsidian (ajout Massii 2026-08-24)

En PLUS du profil JSON (mémoire machine), le coach tient un **carnet Markdown**
lisible par l'humain : `data/paper_trading/<user>-vault/`
- `Journal.md` : append-only — une entrée datée par post-mortem et par session
  coach (`## 2026-08-24 — NESN.SW +1.8R` + le texte du coach).
- `Biais/<code>.md` : une page par biais qui GRANDIT — chaque nouvelle
  détection appende date + preuves ; la résolution appende une entrée de
  félicitations. Wikilinks `[[Journal]]` entre pages.
Endpoints (mêmes rôles) : `GET /coach/notes` → liste `[{name, size, modified}]` ;
`GET /coach/notes/{name}` → `{name, markdown}` (name validé anti-traversal,
whitelist `[A-Za-z0-9_/-]+\.md`, confiné au vault). L'UI (onglet Coach,
section « Carnet ») liste et affiche le markdown brut dans un bloc mono lisible.
Les writes passent par store.py (append atomique, même patron 0o600).

## 12. Onglet « Grands portefeuilles » — 13F SEC (ajout Massii 2026-08-24)

Suivi des portefeuilles des grands gérants via les dépôts 13F (SEC EDGAR,
gratuit, JSON+XML). Sondé le 24/08 : `data.sec.gov/submissions/CIK{10}.json`
(User-Agent obligatoire) → accessions 13F-HR ; l'infotable est le XML du dossier
d'archive qui n'est PAS primary_doc.xml (nom ARBITRAIRE → détection par
namespace `thirteenf/informationtable`) ; `value` en DOLLARS ; ⚠️ un même
issuer sur PLUSIEURS lignes → agrégation par CUSIP obligatoire.

Honnêteté pédagogique (affichée dans l'UI) : un 13F paraît jusqu'à 45 jours
après la fin du trimestre, ne couvre que les actions US longues (ni shorts, ni
cash, ni non-US) — on y apprend l'ALLOCATION des grands, on ne copie pas des
trades « live ».

Module `backend/bots/paper/whales.py` + router séparé
`backend/bots/whales_router.py` (prefix /api/paper/whales, mêmes rôles) :
- `GET /api/paper/whales` → liste des gérants (cache) ;
- `GET /api/paper/whales/{id}` → dernier trimestre agrégé + DIFF vs trimestre
  précédent (new/exit/increased/decreased, top 15, concentration top 10).
Gérants curés (CIK vérifié au fetch contre le champ `name` du submissions JSON
— esprit piège #31 : jamais de données sous le mauvais nom ; mismatch → statut
`unverified`, pas de données fausses). Cache disque 24 h
(`data/paper_trading/whales_cache.json`), pacing 1 req/s, User-Agent dédié.

## 13. Veille politique + tendances sociales + cadence radar (ajouts Massii 24/08 soir)

- **Radar 3×/jour** : 07:45, 12:00, 19:00 (3 jobs cron séparés).
- **Veille annonces politiques (immédiate, cycle 5 min du newswatch)** — sondé le 24/08 :
  Google News RSS (`news.google.com/rss/search?q=…`, 200, daté — la sonde a rendu
  « Trump announces 50 % tariff » du jour même) + `trumpstruth.org/feed` (archive
  RSS Truth Social, 200). Classifieur `gov` déterministe (tariff/executive
  order/sanctions/participation de l'État/subventions/export ban…) → Telegram
  immédiat + event `sentiment:"gov"`. État vu GLOBAL (pas par user). Seed
  silencieux au 1er run.
- **Tendances sociales en entrée du radar** : réutilisation du `social.py` de
  Market Pulse via le pont ENGINE_DIR (reddit multireddit `.rss` — ⚠️ plafond
  mesuré 1 req/60 s/IP → UNE requête par run ; recherche Bluesky ×2 ; X par
  handles finance best-effort, garde `XSerializationChanged`). Étiquetées
  « bruit élevé, à recouper » dans le prompt.

## 13. Convergence — le radar se tait, Claude s'active (ajout Massii 2026-08-24 soir)

Retours : (a) les notifs paper doivent passer par le BOT ORACLE, pas celui du
Harvester ; (b) le radar notifie trop — il doit ACCUMULER en silence dans la
mémoire de l'Omen (radar.json + vault) ; (c) quand PLUSIEURS facteurs spéciaux
convergent, UN message : résumé + meilleurs mouvements à jouer (simulateur).
Doctrine Massii verbatim : « n'attends pas le parfait parce que ce sera déjà
trop tard — il faut faire des hypothèses pour prévoir » → seuil de déclenchement
VOLONTAIREMENT bas (2 facteurs), confiance affichée, bilan radar rappelé dans
chaque digest (on risque, on ne se ment pas).

- `paper/alerts.py` : `load_cfg()` → `data/paper_telegram.json` (bot Oracle,
  posé serveur-side, 0600) sinon repli config Harvester. Tous les envois paper
  (newswatch, whales, convergence) passent par lui.
- Radar : plus AUCUN envoi Telegram par hypothèse ni par verdict — tout va à
  l'état + Radar.md. Les fonctions de formatage restent (digest les réutilise).
- `paper/convergence.py` : facteurs 48 h — F1 ≥2 hypothèses fraîches ·
  F2 annonce politique · F3 catalyseur sur position DÉTENUE · F4 dépôt SEC
  whale · F5 même symbole dans ≥2 sources distinctes. `should_fire` = ≥2
  facteurs ET cooldown 6 h ET empreinte des items contributifs ≠ dernière
  (pas de redite). Digest LLM (résumé + 2-4 mouvements simulateur : direction,
  ticker, thèse, horizon, risque 0.5-1 %, invalidation) ; panne LLM → résumé
  déterministe compact QUAND MÊME envoyé (le déclencheur est la valeur).
  État `data/paper_trading/convergence.json`, note vault `Signaux.md`.
- Câblage : fin de `radar.run_once` (3×/j) + `POST /api/paper/digest/run`
  (manuel) + `GET /api/paper/digest` (historique).
