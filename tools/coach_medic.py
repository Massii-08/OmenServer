#!/usr/bin/env python3
"""coach_medic.py — le médecin autonome du coach de paper trading (LOT 6).

Détecte les pannes du module ``backend/bots/paper/coach_trader.py`` (et de
tout ce qui le fait tourner : le guetteur, le planificateur, le code lui-
même), s'auto-limite (cooldown par signature, plafond quotidien, kill-
switch), puis déclenche une session de réparation autonome
(``claude --dangerously-skip-permissions``) scoping STRICT au module
concerné.

⚠️ **Volontairement STANDALONE, stdlib PUR, zéro import ``backend``** : ce
script surveille précisément le code qu'un import de ``backend`` pourrait
faire planter. S'il devait importer ``backend.bots.paper.store`` pour lire
un fichier, une panne du paquet backend le rendrait aveugle pile quand il
devrait le plus voir clair. Il lit donc les JSON/Markdown à la main.

INSTALL (crontab -e, toutes les 30 minutes, avec le python du venv prod) :
    */30 * * * * <chemin venv prod>/bin/python3 <chemin dépôt>/tools/coach_medic.py >> ~/coach-medic.cron.log 2>&1

Chemins réels sur l'Omen (à adapter si le dépôt/venv déménagent) :
    */30 * * * * /home/massii08/paper-dev/venv/bin/python3 /home/massii08/paper-dev/tools/coach_medic.py >> ~/coach-medic.cron.log 2>&1

Kill-switch : ``touch ~/coach-medic.disabled`` (le script sort en silence,
code 0, tant que ce fichier existe). Le retirer réarme le médecin.
"""
import hashlib
import json
import logging
import os
import re
import shlex
import subprocess
import urllib.request
from collections import namedtuple
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

logger = logging.getLogger("coach_medic")


# --------------------------------------------------------------------------- #
# Chemins — constantes de MODULE (monkeypatchables), résolues une fois
# --------------------------------------------------------------------------- #

REPO_DIR = Path(__file__).resolve().parents[1]
DATA_DIR = REPO_DIR / "data" / "paper_trading"
LEDGER_PATH = DATA_DIR / "coach.ledger.json"
COACH_STATE_PATH = DATA_DIR / "coach_trader.state.json"
NEWSWATCH_STATE_PATH = DATA_DIR / "newswatch_global.json"
COACH_JOURNAL_PATH = DATA_DIR / "coach-vault" / "Journal.md"
TELEGRAM_CFG_PATH = REPO_DIR / "data" / "harvester_telegram.json"

MEDIC_STATE_PATH = Path.home() / "coach-medic.state.json"
MEDIC_DISABLED_PATH = Path.home() / "coach-medic.disabled"
MEDIC_RUNS_DIR = Path.home() / "medic-runs"
MEDIC_LOG_PATH = Path.home() / "coach-medic.log"


# --------------------------------------------------------------------------- #
# Panne détectée — un code stable + une signature + un détail lisible
# --------------------------------------------------------------------------- #

Failure = namedtuple("Failure", "code signature detail")

FAIL_LLM = "llm_failed"
FAIL_PLANNER_DEAD = "planner_dead"
FAIL_NEWSWATCH_STUCK = "newswatch_stuck"
FAIL_CODE_ERROR = "code_error"

LOCAL_TZ = "Europe/Rome"          # même convention que coach_trader.LOCAL_TZ
PLANNER_DEAD_HOURS = 36.0
NEWSWATCH_STUCK_MINUTES = 45.0


def _sig(code, extract=""):
    """Signature STABLE : le code de la panne + le hash court d'un extrait.

    Stable tant que l'extrait ne change pas — c'est ce qui permet au
    cooldown de reconnaître « la même panne » d'un passage à l'autre du
    cron, sans dépendre d'un horodatage."""
    digest = hashlib.sha1(str(extract or "").encode("utf-8", "ignore")).hexdigest()[:10]
    return "%s:%s" % (code, digest)


def _is_llm_failure_row(row):
    if not isinstance(row, dict) or row.get("accepted") is not False:
        return False
    action = row.get("action")
    reason = row.get("reason")
    return (action == "pass" and reason == "llm_failed") \
        or (action == "parse" and reason == "parse_failed")


def detect_llm_failure(ledger_rows):
    """Panne du modèle : les DEUX lignes les PLUS RÉCENTES du registre
    (``coach.ledger.json`` est en tête-d'abord, cf. ``coach_trader.
    push_ledger``) sont TOUTES LES DEUX des échecs consécutifs. Une seule
    ligne en échec n'est pas une panne — le modèle a pu simplement hoqueter
    une fois."""
    rows = [r for r in (ledger_rows or []) if isinstance(r, dict)]
    if len(rows) < 2:
        return None
    if not (_is_llm_failure_row(rows[0]) and _is_llm_failure_row(rows[1])):
        return None
    extract = "%s|%s" % (rows[0].get("reason") or rows[0].get("action"),
                         rows[1].get("reason") or rows[1].get("action"))
    return Failure(FAIL_LLM, _sig(FAIL_LLM, extract),
                  "2 dernières passes en échec (%s)" % extract)


# --------------------------------------------------------------------------- #
# détection — planificateur mort (coach_trader.state.json)
# --------------------------------------------------------------------------- #

def _parse_iso_utc(value):
    """ISO -> ``datetime`` aware (naïf traité comme UTC), ou ``None`` — même
    tolérance que ``coach_trader._parse_iso``."""
    if not isinstance(value, str) or not value.strip():
        return None
    raw = value.strip()
    if raw[-1] in ("Z", "z"):
        raw = raw[:-1]
    try:
        parsed = datetime.fromisoformat(raw)
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def business_hours_between(start, end, tz=LOCAL_TZ):
    """Heures OUVRÉES (lundi-vendredi, heure locale) entre deux instants
    aware — heuristique de SANTÉ, pas un calcul financier précis : compte
    jour par jour, proportionnel aux bords."""
    if end <= start:
        return 0.0
    zi = ZoneInfo(tz)
    cursor = start.astimezone(zi)
    end_local = end.astimezone(zi)
    total = 0.0
    while cursor < end_local:
        next_midnight = (cursor.replace(hour=0, minute=0, second=0, microsecond=0)
                         + timedelta(days=1))
        segment_end = min(end_local, next_midnight)
        if cursor.weekday() < 5:
            total += (segment_end - cursor).total_seconds() / 3600.0
        cursor = segment_end
    return total


def detect_planner_dead(state, now, threshold_hours=PLANNER_DEAD_HOURS):
    """Le planificateur (``newswatch.run_once`` -> ``coach_trader.maybe_run``)
    tourne-t-il encore ? ``last_pass`` est ARMÉ après CHAQUE tentative, réussie
    ou non (cf. ``coach_trader.maybe_run``) — un ``last_pass`` qui n'avance
    plus du tout pendant :data:`PLANNER_DEAD_HOURS` heures OUVRÉES ne dit pas
    « le modèle échoue » (ça, c'est :func:`detect_llm_failure`), ça dit
    « le mécanisme qui déclenche la passe s'est arrêté ».

    ``last_pass`` absent -> pas assez de données pour accuser (fraîche
    installation) : jamais de panne INVENTÉE."""
    last = _parse_iso_utc((state or {}).get("last_pass"))
    if last is None:
        return None
    elapsed = business_hours_between(last, now)
    if elapsed < threshold_hours:
        return None
    return Failure(FAIL_PLANNER_DEAD, _sig(FAIL_PLANNER_DEAD, "no_pass"),
                  "aucune passe depuis %.1fh ouvrées (dernière: %s)"
                  % (elapsed, state.get("last_pass")))


# --------------------------------------------------------------------------- #
# détection — cycle de veille figé (mtime de newswatch_global.json)
# --------------------------------------------------------------------------- #

def detect_newswatch_stuck(mtime, now, threshold_minutes=NEWSWATCH_STUCK_MINUTES):
    """``newswatch_global.json`` est réécrit à CHAQUE cycle réussi du
    guetteur (toutes les 5 min, cf. ``newswatch.run_once``) — un ``mtime``
    trop vieux dit que le cron/scheduler qui l'appelle s'est arrêté, pas que
    le coach spécifiquement échoue.

    ``mtime`` absent (fichier jamais écrit) -> pas de panne inventée."""
    if mtime is None:
        return None
    age_minutes = (now - mtime).total_seconds() / 60.0
    if age_minutes < threshold_minutes:
        return None
    return Failure(FAIL_NEWSWATCH_STUCK, _sig(FAIL_NEWSWATCH_STUCK, "stuck"),
                  "newswatch_global.json vieux de %.0f min" % age_minutes)


# --------------------------------------------------------------------------- #
# détection — panne de code (traceback backend/bots/paper dans journalctl)
#
# ⚠️ Suppose un journal en sortie ``-o cat`` (``default_journalctl`` ci-
# dessous l'utilise) : le format PAR DÉFAUT de ``journalctl`` préfixe CHAQUE
# ligne d'un horodatage+unité, ce qui détruit l'indentation Python (chaque
# ligne d'un traceback devient "non indentée" une fois préfixée) — sans quoi
# la détection du bloc, ci-dessous, ne verrait plus jamais sa fin.
# --------------------------------------------------------------------------- #

_TRACEBACK_HEADER = "Traceback (most recent call last):"


def _split_tracebacks(text):
    """Découpe un texte de journal en blocs de traceback Python — du
    ``Traceback (most recent call last):`` à la ligne d'exception finale
    (la première ligne suivante qui n'est PAS indentée)."""
    lines = (text or "").splitlines()
    blocks = []
    i = 0
    while i < len(lines):
        if lines[i].strip() == _TRACEBACK_HEADER:
            block = [lines[i]]
            j = i + 1
            while j < len(lines):
                block.append(lines[j])
                j += 1
                if lines[j - 1] and not lines[j - 1][0].isspace():
                    break
            blocks.append("\n".join(block))
            i = j
        else:
            i += 1
    return blocks


def detect_code_error(journal_text, needle="backend/bots/paper"):
    """Une panne de CODE (par opposition à une panne du modèle) : un
    traceback dans les logs récents qui mentionne le module surveillé.

    Signature = hash de la ligne d'exception finale du PREMIER bloc trouvé —
    stable tant que c'est la MÊME exception qui se répète (le cooldown
    empêche de ré-ouvrir une session par tick de cron sur une panne déjà
    prise en charge), mais distingue deux bugs différents."""
    blocks = [b for b in _split_tracebacks(journal_text) if needle in b]
    if not blocks:
        return None
    last_line = ""
    for line in blocks[0].splitlines():
        stripped = line.strip()
        if stripped:
            last_line = stripped
    return Failure(FAIL_CODE_ERROR, _sig(FAIL_CODE_ERROR, last_line),
                  "traceback %s : %s" % (needle, last_line[:200]))


# --------------------------------------------------------------------------- #
# garde-fous — cooldown par signature, plafond quotidien, kill-switch
#
# Chaque session (réparation OU amélioration hebdomadaire, cf. chantier 3)
# est une entrée ``{"signature", "ts", "kind"}`` de l'historique
# ``~/coach-medic.state.json``. Les deux gardes lisent le MÊME historique —
# c'est ce qui permet au plafond quotidien de compter TOUTES les sessions,
# quel que soit leur type.
# --------------------------------------------------------------------------- #

COOLDOWN_HOURS = 24.0
DAILY_CAP = 2


def already_handled(history, signature, now, cooldown_hours=COOLDOWN_HOURS):
    """Une session pour CETTE signature a-t-elle déjà tourné dans les
    dernières ``cooldown_hours`` ? Un horodatage illisible n'est jamais
    considéré comme récent (mieux vaut retenter que rester bloqué à vie sur
    une entrée corrompue)."""
    for entry in (history or []):
        if not isinstance(entry, dict) or entry.get("signature") != signature:
            continue
        ts = _parse_iso_utc(entry.get("ts"))
        if ts is not None and (now - ts).total_seconds() < cooldown_hours * 3600.0:
            return True
    return False


def daily_cap_reached(history, now, cap=DAILY_CAP, window_hours=24.0):
    """Combien de sessions (TOUTES signatures confondues) ont démarré dans
    la fenêtre ? Au-delà de ``cap``, le médecin s'arrête pour la journée —
    même s'il reste des pannes non traitées."""
    count = 0
    for entry in (history or []):
        if not isinstance(entry, dict):
            continue
        ts = _parse_iso_utc(entry.get("ts"))
        if ts is not None and (now - ts).total_seconds() < window_hours * 3600.0:
            count += 1
    return count >= cap


def kill_switch_active(path=None):
    """``~/coach-medic.disabled`` existe -> le médecin doit sortir en
    silence (code 0), sans même diagnostiquer."""
    return Path(path or MEDIC_DISABLED_PATH).exists()


# --------------------------------------------------------------------------- #
# dossier de panne — le brief qui gouverne TOUTE la session de réparation
#
# Il ne suffit pas de dire « répare » : une session headless
# (``--dangerously-skip-permissions``) sans périmètre écrit noir sur blanc
# peut dériver n'importe où dans le dépôt. Ce dossier EST le contrat.
# --------------------------------------------------------------------------- #

REPAIR_SCOPE = (
    "backend/bots/paper/**", "backend/bots/paper_router.py",
    "frontend/js/paper_module.js",
)
FORBIDDEN_ZONES = (
    "backend/auth/**", "backend/power*/**", "backend/scheduler/**",
    "backend/net_guard.py",
)

_DOSSIER_TEMPLATE = """# Dossier de panne — coach_medic

**Signature** : {signature}
**Code** : {code}
**Détecté à** : {now_iso}
**Détail** : {detail}

## Extraits

{extracts}

## Mission

Réparer la panne ci-dessus. **TDD strict** : un test qui échoue avant, le
code minimal qui le fait passer, puis la suite complète.

## Périmètre STRICT

Tu ne touches QUE :
- {scope}

**INTERDITS** — ne touche JAMAIS à :
- {forbidden}
- N'installe RIEN (`pip install` interdit) : zéro nouvelle dépendance.

## Portes de sortie (dans cet ordre)

1. La suite complète `backend/bots/tests/` doit être VERTE.
2. Si `frontend/js/paper_module.js` a été touché : valide le parse avec
   `node -e "new Function(require('fs').readFileSync('frontend/js/paper_module.js','utf8'))"`
   et bump le cache-bust (`?v=` dans `index.html` + `sw.js`).
3. **Seulement si tout est vert** : `git add` les fichiers pertinents,
   `git commit`, puis `git push origin medic-fix:main`.
4. Si quoi que ce soit reste rouge : N'ESSAIE PAS de pousser. Écris à la
   place un rapport dans `rapport.md` (même répertoire que ce dossier)
   expliquant ce qui bloque, et termine sans pousser.
"""


def build_dossier(failure, extracts, now_iso):
    """Le texte Markdown COMPLET du dossier de panne (PUR — string building).

    ``extracts`` = ``{nom: texte}`` des pièces jointes (registre, état,
    journal…). ``failure`` porte le code/la signature/le détail déjà
    calculés par un détecteur."""
    extracts = extracts if isinstance(extracts, dict) else {}
    extracts_text = "\n\n".join(
        "### %s\n```\n%s\n```" % (name, text) for name, text in extracts.items()
    ) or "(aucun extrait)"
    return _DOSSIER_TEMPLATE.format(
        signature=failure.signature, code=failure.code, now_iso=now_iso,
        detail=failure.detail, extracts=extracts_text,
        scope="\n- ".join(REPAIR_SCOPE), forbidden="\n- ".join(FORBIDDEN_ZONES),
    )


# --------------------------------------------------------------------------- #
# I/O — lecteurs tolérants (absent/corrompu -> valeur neutre, jamais lever)
# --------------------------------------------------------------------------- #

def _read_json_list(path):
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    return data if isinstance(data, list) else []


def _read_json_dict(path):
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _mtime_or_none(path):
    try:
        return datetime.fromtimestamp(Path(path).stat().st_mtime, tz=timezone.utc)
    except OSError:
        return None


# --------------------------------------------------------------------------- #
# Telegram — BOT OMENBOT (``data/harvester_telegram.json``), JAMAIS le canal
# Oracle (``paper_telegram.json``, décision utilisateur : Oracle = marché,
# omenbot = machine). ``urllib`` pur (zéro dépendance).
#
# 🔒 L'URL de l'API Telegram CONTIENT le jeton (…/bot<TOKEN>/sendMessage) —
# même piège que ``backend/bots/harvester/notify.py`` : ne JAMAIS journaliser
# l'URL, la requête, ni le texte brut d'une exception qui pourrait l'embarquer
# (un ``OSError`` de socket répète souvent l'URL demandée). Seul un booléen
# succès/échec est loggé.
# --------------------------------------------------------------------------- #

_TELEGRAM_API = "https://api.telegram.org/bot%s/sendMessage"


def load_telegram_cfg(path=None):
    return _read_json_dict(path or TELEGRAM_CFG_PATH)


def notify(text, cfg=None, opener=None):
    cfg = cfg if cfg is not None else load_telegram_cfg()
    token = (cfg or {}).get("token")
    chat_id = (cfg or {}).get("chat_id")
    if not token or not chat_id:
        return False
    url = _TELEGRAM_API % token
    body = json.dumps({"chat_id": chat_id, "text": text}).encode("utf-8")
    req = urllib.request.Request(url, data=body,
                                 headers={"Content-Type": "application/json"},
                                 method="POST")
    opener = opener or urllib.request.urlopen
    try:
        with opener(req, timeout=10) as resp:
            ok = 200 <= int(getattr(resp, "status", 0)) < 400
    except Exception:      # noqa: BLE001 — ne JAMAIS journaliser l'exception brute
        ok = False
    logger.info("telegram: %s", "envoye" if ok else "echec")
    return ok


# --------------------------------------------------------------------------- #
# session de réparation — git fetch/checkout + CLI Claude headless
# --------------------------------------------------------------------------- #

_OMEN_CLAUDE_PATH = os.path.expanduser("~/.local/bin/claude")


def _claude_bin():
    """Chemin du CLI Claude : ``CLAUDE_BIN``, puis l'Omen, puis le ``PATH`` —
    mirroir minimal de ``backend/bots/paper/llm.py:claude_bin`` (SANS
    importer ``backend``, cf. tête de fichier)."""
    explicit = os.environ.get("CLAUDE_BIN")
    if explicit:
        return explicit
    if os.path.exists(_OMEN_CLAUDE_PATH):
        return _OMEN_CLAUDE_PATH
    from shutil import which
    return which("claude") or _OMEN_CLAUDE_PATH


def git_remote_head(ref="origin/main", run=subprocess.run, cwd=None):
    """``git rev-parse <ref>``, ou ``None`` en cas d'échec — sert à détecter
    si la session de réparation a bien POUSSÉ un nouveau commit (avant/après
    autour de :func:`run_repair_session`)."""
    try:
        proc = run(["git", "rev-parse", ref], cwd=str(cwd or REPO_DIR),
                  capture_output=True, text=True, timeout=20)
    except Exception:      # noqa: BLE001
        return None
    out = (getattr(proc, "stdout", "") or "").strip()
    return out or None


def run_repair_session(dossier_path, log_path, model="sonnet",
                       claude_bin=None, popen=subprocess.Popen, cwd=None):
    """Lance la session de réparation, BLOQUANT (``.wait()``) — c'est ce qui
    permet à l'appelant d'envoyer le message Telegram de FIN dans la même
    invocation cron. ``start_new_session=True`` détache le sous-processus de
    la session du cron parent (même patron que les scans détachés du dépôt,
    cf. ``bond-scanner`` : un ``git push`` déclenché en fin de session ne doit
    pas être tué si le cron parent est interrompu).

    Le script shell est intentionnellement `set -e` : si `git fetch` ou
    `git checkout` échoue, le CLI Claude n'est JAMAIS lancé — pas de
    réparation à l'aveugle sur un dépôt dans un état inconnu."""
    binp = claude_bin or _claude_bin()
    script = "; ".join([
        "set -e",
        "git fetch origin",
        "git checkout -B medic-fix origin/main",
        "%s --model %s --dangerously-skip-permissions -p < %s"
        % (shlex.quote(binp), shlex.quote(model), shlex.quote(str(dossier_path))),
    ])
    with open(str(log_path), "a", encoding="utf-8") as logf:
        proc = popen(["bash", "-c", script], cwd=str(cwd or REPO_DIR),
                     stdout=logf, stderr=subprocess.STDOUT,
                     start_new_session=True)
        return proc.wait()


# --------------------------------------------------------------------------- #
# journalctl — I/O par défaut (injectable partout où on la consomme)
# --------------------------------------------------------------------------- #

def default_journalctl(minutes=30, run=subprocess.run):
    """``-o cat`` = pas de préfixe horodatage/unité par ligne : préserve
    l'indentation Python des tracebacks (cf. tête de :func:`detect_code_error`
    pour pourquoi c'est indispensable)."""
    try:
        proc = run(["journalctl", "-u", "omenserver", "--since",
                   "-%dmin" % int(minutes), "--no-pager", "-o", "cat"],
                  capture_output=True, text=True, timeout=20)
        return proc.stdout or ""
    except Exception:      # noqa: BLE001 — best-effort, jamais lever
        return ""


# --------------------------------------------------------------------------- #
# état du médecin — persistance (``~/coach-medic.state.json``, 0o600)
# --------------------------------------------------------------------------- #

def load_medic_state(path=None):
    data = _read_json_dict(path or MEDIC_STATE_PATH)
    sessions = data.get("sessions")
    return {"sessions": sessions if isinstance(sessions, list) else []}


def save_medic_state(state, path=None):
    """Écriture atomique-safe 0o600 (création via ``os.open``, jamais
    ``open()``+``chmod()``) — même doctrine que ``store``/``weekly`` côté
    backend, appliquée ici sans les importer."""
    p = Path(path or MEDIC_STATE_PATH)
    p.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(p), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.fchmod(fd, 0o600)
    except (AttributeError, OSError):
        pass
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(dict(state or {}), f, ensure_ascii=False, indent=2)


# --------------------------------------------------------------------------- #
# diagnose — combine les 4 détecteurs (I/O + PUR)
# --------------------------------------------------------------------------- #

def diagnose(now=None, ledger_path=None, coach_state_path=None,
            newswatch_state_path=None, journal_fetch=None):
    now = now or datetime.now(timezone.utc)
    out = []

    failure = detect_llm_failure(_read_json_list(ledger_path or LEDGER_PATH))
    if failure is not None:
        out.append(failure)

    failure = detect_planner_dead(
        _read_json_dict(coach_state_path or COACH_STATE_PATH), now)
    if failure is not None:
        out.append(failure)

    failure = detect_newswatch_stuck(
        _mtime_or_none(newswatch_state_path or NEWSWATCH_STATE_PATH), now)
    if failure is not None:
        out.append(failure)

    failure = detect_code_error((journal_fetch or default_journalctl)())
    if failure is not None:
        out.append(failure)

    return out


# --------------------------------------------------------------------------- #
# orchestration — run_medic
# --------------------------------------------------------------------------- #

def run_medic(now=None, disabled_path=None,
             ledger_path=None, coach_state_path=None, newswatch_state_path=None,
             journal_fetch=None, journal_reader=None, state_path=None,
             telegram_cfg=None, notifier=None, popen=subprocess.Popen,
             claude_bin=None, model="sonnet", git_run=subprocess.run,
             runs_dir=None, weekly_check=None):
    """Le cycle complet d'un passage de cron. NE LÈVE JAMAIS ce qui peut être
    évité — un médecin qui plante est un médecin de moins.

    Sans ``weekly_check`` explicite, le chantier 3 (amélioration hebdomadaire
    bornée) tourne par défaut via :func:`maybe_weekly_improvement` — le
    dimanche soir, le carnet du coach est lu via ``journal_reader``
    (injectable, sinon ``coach-vault/Journal.md`` sur disque)."""
    now = now or datetime.now(timezone.utc)

    if kill_switch_active(disabled_path):
        return {"action": "disabled"}

    state = load_medic_state(state_path)
    history = state["sessions"]

    if daily_cap_reached(history, now):
        return {"action": "cap_reached"}

    failures = diagnose(now=now, ledger_path=ledger_path,
                        coach_state_path=coach_state_path,
                        newswatch_state_path=newswatch_state_path,
                        journal_fetch=journal_fetch)

    chosen = None
    kind = "repair"
    for failure in failures:
        if not already_handled(history, failure.signature, now):
            chosen = failure
            break

    if chosen is None:
        check = weekly_check
        if check is None:
            check = lambda n, h: maybe_weekly_improvement(n, h, journal_reader=journal_reader)
        weekly_failure = check(now, history)
        if weekly_failure is not None:
            chosen = weekly_failure
            kind = WEEKLY_IMPROVEMENT_KIND

    if chosen is None:
        return {"action": "idle", "failures": [f.code for f in failures]}

    now_iso = now.isoformat()
    run_dir = Path(runs_dir or MEDIC_RUNS_DIR) / now_iso.replace(":", "-")
    run_dir.mkdir(parents=True, exist_ok=True)
    dossier_path = run_dir / "dossier.md"
    dossier_path.write_text(build_dossier(chosen, {}, now_iso), encoding="utf-8")
    log_path = run_dir / "session.log"

    cfg = telegram_cfg if telegram_cfg is not None else load_telegram_cfg()
    send = notifier if notifier is not None else notify
    verb = "réparation" if kind == "repair" else "amélioration"
    send("Le coach s'ouvre une session de %s : %s" % (verb, chosen.signature), cfg)

    before = git_remote_head(run=git_run)
    rc = run_repair_session(dossier_path, log_path, model=model,
                            claude_bin=claude_bin, popen=popen)
    after = git_remote_head(run=git_run)
    pushed = bool(before) and bool(after) and before != after

    send("%s : %s" % ("fix poussé" if pushed else "rapport sans fix",
                      chosen.signature), cfg)

    history = list(history) + [{
        "signature": chosen.signature, "ts": now_iso, "kind": kind,
        "outcome": "pushed" if pushed else "reported",
    }]
    save_medic_state({"sessions": history}, state_path)
    return {"action": kind, "signature": chosen.signature, "pushed": pushed, "rc": rc}


# --------------------------------------------------------------------------- #
# chantier 3 — amélioration hebdomadaire bornée
#
# Le dimanche soir, le bilan hebdomadaire (``backend/bots/paper/llm.py::
# build_weekly_prompt``) peut proposer UNE amélioration concrète et bornée
# (outillage/données/règles — jamais une refonte, jamais un conseil de
# trading). Le médecin la lit dans le carnet du COACH (``coach-vault/
# Journal.md`` — décision de scope : ce lot est L'INFIRMIER DU COACH, pas de
# tous les comptes) et, s'il en trouve une, en fait une session — même
# mécanique/périmètre/portes que la réparation.
# --------------------------------------------------------------------------- #

WEEKLY_IMPROVEMENT_KIND = "weekly_improvement"
WEEKLY_RUN_WEEKDAY = 6      # dimanche (datetime.weekday())
WEEKLY_RUN_AFTER_HOUR = 21  # heure LOCALE Europe/Rome

# Même famille de motif que ``coach_trader._block_re`` (bloc fenced, clôture
# optionnelle si le texte est tronqué en fin de réponse).
_AMELIORATION_RE = re.compile(
    r"```[ \t]*AMELIORATION_PROPOSEE[ \t]*\r?\n(.*?)(?:```|\Z)",
    re.DOTALL | re.IGNORECASE)

# Une entrée du carnet commence par ``## <date> — <titre>`` (cf.
# ``coach.journal_entry``) ; le corps va jusqu'à la PROCHAINE entrée ou la
# fin du fichier.
_WEEKLY_ENTRY_RE = re.compile(
    r"^## .*? — bilan hebdomadaire.*?$\n\n(.*?)(?=^## |\Z)",
    re.DOTALL | re.MULTILINE)


def extract_amelioration(text):
    """Le bloc ``AMELIORATION_PROPOSEE`` d'un bilan (PUR). Plusieurs blocs ->
    le PREMIER seulement (le modèle s'est répété). Absent ou vide -> ``None``."""
    matches = list(_AMELIORATION_RE.finditer(text or ""))
    if not matches:
        return None
    body = matches[0].group(1).strip()
    return body or None


def last_weekly_bilan_body(journal_text):
    """Le corps de la DERNIÈRE entrée ``bilan hebdomadaire`` du carnet (PUR)
    — un carnet est APPEND-ONLY, donc « la dernière » est la PLUS RÉCENTE
    (le dernier match du texte)."""
    matches = list(_WEEKLY_ENTRY_RE.finditer(journal_text or ""))
    if not matches:
        return None
    return matches[-1].group(1).strip()


def weekly_gate_ok(history, now, weekday=WEEKLY_RUN_WEEKDAY,
                   after_hour=WEEKLY_RUN_AFTER_HOUR, tz=LOCAL_TZ):
    """Le moment est-il venu de regarder le bilan hebdo ? Dimanche, à partir
    de :data:`WEEKLY_RUN_AFTER_HOUR` heure LOCALE, et pas déjà fait cette
    semaine ISO (une session ``weekly_improvement`` par semaine — les
    sessions ``repair`` de l'historique ne comptent PAS ici, elles ont leur
    propre garde-fou)."""
    local = now.astimezone(ZoneInfo(tz))
    if local.weekday() != weekday or local.hour < after_hour:
        return False
    iso_week = "%04d-W%02d" % local.isocalendar()[:2]
    for entry in (history or []):
        if not isinstance(entry, dict) or entry.get("kind") != WEEKLY_IMPROVEMENT_KIND:
            continue
        ts = _parse_iso_utc(entry.get("ts"))
        if ts is None:
            continue
        ts_local = ts.astimezone(ZoneInfo(tz))
        if "%04d-W%02d" % ts_local.isocalendar()[:2] == iso_week:
            return False
    return True


def maybe_weekly_improvement(now, history, journal_reader=None):
    """Assemble le gate + la lecture du carnet + l'extraction (I/O + PUR).
    Rend une :class:`Failure` (code ``"weekly_improvement"``) ou ``None``."""
    if not weekly_gate_ok(history, now):
        return None
    reader = journal_reader or (lambda: _read_text(COACH_JOURNAL_PATH))
    body = last_weekly_bilan_body(reader())
    if body is None:
        return None
    proposal = extract_amelioration(body)
    if proposal is None:
        return None
    return Failure(WEEKLY_IMPROVEMENT_KIND, _sig(WEEKLY_IMPROVEMENT_KIND, proposal),
                  proposal)


def _read_text(path):
    try:
        return Path(path).read_text(encoding="utf-8")
    except OSError:
        return ""


# --------------------------------------------------------------------------- #
# CLI — ne lève jamais (un médecin qui plante est un médecin de moins)
# --------------------------------------------------------------------------- #

def main():
    try:
        MEDIC_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        logging.basicConfig(filename=str(MEDIC_LOG_PATH), level=logging.INFO,
                            format="%(asctime)s %(levelname)s %(message)s")
    except Exception:      # noqa: BLE001 — pas de log possible n'empêche pas de tourner
        pass
    try:
        result = run_medic()
        logger.info("cycle termine: %s", (result or {}).get("action"))
        return 0
    except Exception:      # noqa: BLE001
        logger.exception("cycle en echec")
        return 1


if __name__ == "__main__":
    import sys
    sys.exit(main())
