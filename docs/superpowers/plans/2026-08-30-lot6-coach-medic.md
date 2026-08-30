# LOT 6 — l'infirmier du coach — plan d'implémentation

> **Pour l'agent qui exécute :** exécution INLINE directe (TDD strict), pas de
> sous-agents — la tâche est fortement séquentielle (chantier 1 conditionne la
> compréhension du reste) et tient dans un seul contexte déjà chargé.

**But :** (1) fermer les 2 trous `market_closed` vécus en prod (passe forcée +
digest week-end) via une règle d'univers unique ; (2) livrer
`tools/coach_medic.py`, un médecin autonome cron (stdlib pur) qui détecte les
pannes du coach, s'auto-limite, et déclenche une session de réparation
`claude --dangerously-skip-permissions` scoping stricte ; (3) permettre au
bilan hebdomadaire de proposer UNE amélioration bornée, que le médecin peut
transformer en session le dimanche soir.

**Architecture :** aucune nouvelle dépendance. Chantier 1 = pure-function
reuse (`coach_trader.crypto_only_at`) aux 2 points d'appel qui l'omettaient.
Chantier 2 = script `tools/` totalement découplé du paquet `backend` (lit les
JSON/Markdown à la main) pour rester diagnostiquable même si `backend` est
cassé — c'est précisément ce qu'il surveille. Chantier 3 = 1 paragraphe de
prompt (`llm.py`) + 1 mode supplémentaire dans le médecin (même état, même
mécanique de session).

---

## Chantier 1 — cohérence `market_closed`

### Bug A — passe forcée (`backend/bots/paper_router.py:paper_coach_trader_run`)
Aujourd'hui : `run_coach_daily_pass(_now_iso())` — `crypto_only` reste au
défaut `False` quel que soit le jour. Fix : capturer `now_iso = _now_iso()`
une fois, calculer `crypto_only = coach_trader.crypto_only_at(now_iso)`
(fonction PURE déjà utilisée par la passe naturelle dans
`coach_trader.maybe_run`), le passer à `run_coach_daily_pass`.

`coach_trader._aware_utc` ne sait aujourd'hui traiter que `datetime`/`None`
(une chaîne non-`datetime` fait tomber sur `datetime.now(timezone.utc)`,
silencieusement — testable en prod, pas en test à horloge figée). Enhancement
additif : `_aware_utc` délègue à `_parse_iso` quand `now` est une chaîne
(même convention naïf-traité-UTC que partout ailleurs dans ce module) —
aucun appelant existant ne passe de chaîne aujourd'hui (grep vérifié), donc
zéro régression.

### Bug B — digest (`backend/bots/paper/convergence.py:maybe_fire`)
`_execute_coach` n'a jamais reçu ni transmis `crypto_only`. Fix : calculer
`crypto_only = coach_trader.crypto_only_at(now_dt)` (import paresseux, même
geste que `_coach_book`), le passer à `_execute_coach(...)`, qui le relaie à
l'exécuteur (`execute_coach_actions` le supporte déjà).

⚠️ Le test double `_Exec` (`test_paper_convergence.py`) n'accepte pas
`crypto_only` → `TypeError` avalé par `_execute_coach` (comportement
DOCUMENTÉ, cf. sa docstring) → régression silencieuse des tests existants qui
inspectent `runner.calls`. Étendre `_Exec.__call__` avec
`crypto_only=False, **_ignored` et l'enregistrer dans `self.calls`.

### Tests à ajouter
- `test_paper_router.py` : passe forcée un dimanche → `crypto_only=True`
  transmis (mock léger sur `run_coach_daily_pass`) ; passe forcée un jour de
  semaine → `crypto_only=False`. Puis, au niveau `run_coach_daily_pass`
  directement (comme `test_the_weekend_pass_refuses_stocks_and_keeps_crypto`
  déjà existant) : dimanche 01:47 (l'incident réel) + action US → refus
  `market_closed` ; + BTC-USD → accepté.
- `test_paper_convergence.py` : `maybe_fire(now=DIMANCHE, ...)` avec une
  action US dans le bloc → ligne `market_closed` ; avec BTC-USD → acceptée ;
  `now=NOW` (lundi, existant) → comportement inchangé (non-régression).

---

## Chantier 2 — `tools/coach_medic.py`

Script `tools/coach_medic.py`, stdlib uniquement (`json/os/re/sys/subprocess/
hashlib/shlex/logging/urllib.request/pathlib/datetime/zoneinfo/collections`).
Chemins en constantes de MODULE (monkeypatchables, même doctrine que
`store.DATA_DIR`) :

```
REPO_DIR              = Path(__file__).resolve().parents[1]
DATA_DIR              = REPO_DIR / "data" / "paper_trading"
LEDGER_PATH           = DATA_DIR / "coach.ledger.json"
COACH_STATE_PATH      = DATA_DIR / "coach_trader.state.json"
NEWSWATCH_STATE_PATH  = DATA_DIR / "newswatch_global.json"
COACH_JOURNAL_PATH    = DATA_DIR / "coach-vault" / "Journal.md"
TELEGRAM_CFG_PATH     = REPO_DIR / "data" / "harvester_telegram.json"
MEDIC_STATE_PATH      = Path.home() / "coach-medic.state.json"
MEDIC_DISABLED_PATH   = Path.home() / "coach-medic.disabled"
MEDIC_RUNS_DIR        = Path.home() / "medic-runs"
MEDIC_LOG_PATH        = Path.home() / "coach-medic.log"
```

### PUR — détection (une fonction par panne, prend des données déjà lues)
- `detect_llm_failure(ledger_rows)` — 2 lignes les PLUS RÉCENTES (le registre
  est en tête-d'abord, cf. `push_ledger`) toutes deux en échec
  (`action=="pass" and reason=="llm_failed"`, ou `action=="parse" and
  reason=="parse_failed"`).
- `detect_planner_dead(state, now)` — `state["last_pass"]` absent → pas assez
  de données pour accuser (fraîche installation), pas de panne inventée ;
  sinon `business_hours_between(last, now, "Europe/Rome") >= 36`.
  `business_hours_between` compte les heures dans une fenêtre lundi-vendredi
  (jour par jour, proportionnel aux bords) — heuristique de santé, pas un
  calcul financier.
- `detect_newswatch_stuck(mtime, now)` — `mtime is None` → pas de panne
  inventée ; sinon âge > 45 min.
- `detect_code_error(journal_text)` — découpe le texte en blocs de
  traceback (repère `"Traceback (most recent call last):"`, la ligne finale
  NON indentée clôt le bloc — d'où `journalctl -o cat` côté I/O, qui ne
  préfixe pas chaque ligne d'un timestamp), garde ceux qui mentionnent
  `backend/bots/paper`, signature = hash de la ligne d'exception du premier
  bloc.

Chaque détecteur rend `None` ou un `Failure(code, signature, detail)`
(namedtuple). `signature = f"{code}:{sha1(extract)[:10]}"` — stable tant que
l'`extract` ne change pas (même panne persistante → même signature → le
cooldown fonctionne).

### PUR — garde-fous (sur l'historique déjà chargé)
- `already_handled(history, signature, now, cooldown_hours=24)`
- `daily_cap_reached(history, now, cap=2, window_hours=24)`
- `kill_switch_active(path)` — pas pure (I/O `Path.exists()`), mais triviale.

### PUR — dossier de panne
`build_dossier(failure, extracts, now_iso)` → texte Markdown contenant :
extraits (registre/état/log), ET le brief de réparation en dur — périmètre
(`backend/bots/paper/**` + `paper_router.py` + `paper_module.js`
UNIQUEMENT), interdits (auth/power/scheduler/net_guard, `pip install`), TDD +
suite complète verte + `node -e "new Function(...)"` (parse JS) avant tout
push, commande de push exacte (`git push origin medic-fix:main`), repli
`rapport.md` sans push si rouge, bump cache-bust si frontend touché.

### I/O — lecteurs (tolérants, injectables)
`_read_json_list`/`_read_json_dict`/`_mtime_or_none`/`default_journalctl`
(`journalctl -u omenserver --since -30min --no-pager -o cat`, `run=`
injectable) / `load_telegram_cfg`.

### I/O — Telegram (`notify(text, cfg=None, opener=None)`)
`urllib.request` pur (zéro dépendance). **Ne journalise jamais l'URL ni le
token** — seul un booléen "envoyé"/"échec" est loggé, jamais l'exception brute
(un message d'erreur urllib peut contenir l'URL complète).

### I/O — session de réparation
`git_remote_head(ref, run=..., cwd=...)` (avant/après pour détecter un
nouveau commit) ; `run_repair_session(dossier_path, log_path, model="sonnet",
claude_bin=None, popen=subprocess.Popen, cwd=None)` — construit
`git fetch origin && git checkout -B medic-fix origin/main && <claude> \
--model sonnet --dangerously-skip-permissions -p < dossier.md`, lancé via
`Popen(["bash","-c",script], start_new_session=True)`, **attend la fin**
(`.wait()`) pour pouvoir envoyer le message Telegram de fin dans la MÊME
invocation cron. `_claude_bin()` = mirroir minimal de `llm.claude_bin()`
(`CLAUDE_BIN` env, `~/.local/bin/claude`, `PATH`), sans importer `backend`.

### Orchestration — `run_medic(now=None, **injectables) -> dict`
1. Kill-switch → `{"action": "disabled"}` immédiat.
2. `diagnose()` (I/O + les 4 détecteurs), `load_medic_state()`.
3. Cap journalier atteint → `{"action": "cap_reached"}`.
4. 1ʳᵉ panne dont la signature n'est pas en cooldown → `chosen`.
5. Sinon, chantier 3 : `maybe_weekly_improvement(now, history)` (gate
   dimanche ≥21h, 1×/semaine, lit `coach-vault/Journal.md`, extrait le
   dernier bilan hebdo, cherche `AMELIORATION_PROPOSEE`).
6. Rien → `{"action": "idle"}`.
7. Sinon : dossier → notify (lancement) → `run_repair_session` → diff
   `origin/main` avant/après → notify (fin) → append à l'état → sauvegarde.
`main()` = CLI mince (`argparse` optionnel `--dry-run`), jamais lever.

### En tête de fichier — bloc INSTALL (commentaire, pas de code)
```
# INSTALL (crontab -e) :
#   */30 * * * * <chemin venv prod>/bin/python3 ~/paper-dev/tools/coach_medic.py >> ~/coach-medic.cron.log 2>&1
```

### Tests — `backend/bots/tests/test_coach_medic.py`
Import via `importlib.util.spec_from_file_location` (le script n'est pas un
paquet `backend`). Couvre : chaque détecteur sur fixtures (ledger cassé/OK,
state vieux/absent, mtime vieux/absent, journalctl stub avec/sans traceback
`backend/bots/paper`) ; stabilité de signature (2 appels, même entrée → même
signature) ; `already_handled`/`daily_cap_reached`/`kill_switch_active` ;
génération du dossier (contient le périmètre ET les portes de push) ; Telegram
stub (payload `{chat_id, text}` correct, capture des logs → jamais le token) ;
`run_medic` de bout en bout avec TOUT injecté (diagnostic bidon, popen bidon,
opener bidon) pour les 2 chemins panne/idle/cap/kill-switch.

---

## Chantier 3 — amélioration hebdomadaire bornée

### `backend/bots/paper/llm.py::build_weekly_prompt`
Ajoute une consigne : bloc optionnel ` ```AMELIORATION_PROPOSEE ... ``` ` en
fin de réponse, UNE SEULE proposition concrète (outillage/données/règles —
pas une refonte, pas un conseil de trading), à omettre si rien de concret.
`weekly.py` ne change PAS : le texte brut (bloc compris) part déjà tel quel
vers Telegram ET le carnet — c'est le comportement voulu ("le bilan Telegram
la garde").

### `tools/coach_medic.py` — mode hebdo
`weekly_gate_ok(history, now)` — dimanche, heure locale ≥ 21h, aucune session
`kind="weekly_improvement"` déjà lancée cette semaine ISO (même historique
que les réparations, filtré par `kind`).
`extract_amelioration(text)` — bloc ` ```AMELIORATION_PROPOSEE...``` ` (même
regex fenced-block que `coach_trader._block_re`) ; plusieurs blocs → le
PREMIER seulement ; absent → `None`.
`last_weekly_bilan_body(journal_text)` — dernière entrée
`## <date> — bilan hebdomadaire...` du carnet (jusqu'à la prochaine `## ` ou
la fin du fichier). **Décision de scope** : le carnet lu est celui du compte
`coach` (`coach-vault/Journal.md`) — cohérent avec le périmètre de ce lot
(l'infirmier du COACH), pas celui de tous les comptes.
`maybe_weekly_improvement(now, history, journal_reader=None)` — gate → lit →
extrait bilan → extrait proposition → `Failure("weekly_improvement", ...)`
ou `None`.

### Tests
- `test_paper_llm.py` : `build_weekly_prompt` mentionne
  `AMELIORATION_PROPOSEE`.
- `test_coach_medic.py` : extraction bloc présent/absent/multiple (premier
  seul) ; gate dimanche avant/après 21h, jour de semaine, déjà fait cette
  semaine ISO.

---

## Ordre d'exécution
1. Chantier 1 (fix + tests) — le plus risqué en prod, à isoler dans son
   propre commit.
2. Chantier 2 (script + tests) — le plus gros morceau.
3. Chantier 3 (prompt + mode hebdo du médecin) — dépend du fichier déjà en
   place au chantier 2.
4. Suite complète + `backend/` complet + vérif 0 octet NUL + rapport final.
