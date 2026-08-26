"""Le JOURNAL des idées du coach — ce qu'il a déjà proposé, et quand.

Demande de l'utilisateur : « journal des vieilles idées avec dates, le coach y
a accès pour ne pas reproposer les mêmes (ou les reproposer SI un facteur a
changé la donne) ».

Pourquoi un module à part et non ``store.py`` : ``store`` est de l'I/O PUR (il
range et relit des fichiers, sans jamais savoir ce qu'ils contiennent). Le
journal, lui, a une FORME — des entrées typées, un plafond, un résumé destiné à
un prompt et un index de résultats croisé avec le radar. Mettre cette logique
dans ``store`` y ferait entrer du métier, et la sortir du jour où l'on veut
l'enrichir demanderait de démêler les deux. Le fichier reste rangé au même
endroit et écrit avec le même patron (atomique, 0o600).

⚠️ **Non-fantôme** : le fichier s'appelle ``<user>.ideas.json``. Son radical
(``alice.ideas``) contient un point, donc l'allowlist de ``store`` le REJETTE
comme nom d'utilisateur et les deux recensements de comptes du paquet
(``radar._users_with_portfolio`` par regex, ``newswatch._discover_portfolios``
par liste de suffixes) ne peuvent pas le prendre pour un compte. C'est la même
protection que ``<user>.board.json`` — et exactement le bug qui avait créé les
utilisateurs fantômes de la communauté.
"""
import json
import os
from pathlib import Path
from typing import Any, Dict, List, Optional

# Deux genres d'entrées, et pas un de plus : ce que le coach a PROPOSÉ, et ce
# qu'il a dit des positions déjà ouvertes.
KINDS = ("ideas", "review")
DEFAULT_KIND = "ideas"

# Plafond en TÊTE : les 50 dernières entrées. Le journal sert à ne pas se
# répéter et à mesurer, pas à archiver — et il est relu à chaque demande
# d'idées, donc il doit rester petit.
MAX_ENTRIES = 50

# Ce qu'on injecte dans le prompt. Au-delà, on n'aide plus le modèle, on
# encombre son contexte.
SUMMARY_LIMIT = 8

JOURNAL_SUFFIX = ".ideas.json"


def _store():
    """``store`` importé PARESSEUSEMENT (patron du paquet) — et relu à chaque
    appel pour qu'un test qui isole ``DATA_DIR`` isole aussi le journal."""
    from backend.bots.paper import store
    return store


def journal_path(username: str) -> Path:
    """Chemin du journal de l'utilisateur (nom validé par ``store``)."""
    store = _store()
    # On passe par ``portfolio_path`` pour hériter de la validation stricte du
    # nom d'utilisateur ET de la résolution du répertoire (monkeypatchable).
    return store.portfolio_path(username).parent / ("%s%s" % (username,
                                                              JOURNAL_SUFFIX))


def _text(value: Any) -> str:
    return str(value if value is not None else "").strip()


def _entries_of(raw: Any) -> List[Dict[str, Any]]:
    if not isinstance(raw, dict):
        return []
    rows = raw.get("entries")
    if not isinstance(rows, list):
        return []
    return [row for row in rows if isinstance(row, dict)]


def load_entries(username: str) -> List[Dict[str, Any]]:
    """Les entrées du journal, la plus RÉCENTE en tête. Absent/corrompu -> []."""
    path = journal_path(username)
    if not path.is_file():
        return []
    try:
        with open(str(path), "r", encoding="utf-8") as handle:
            return _entries_of(json.load(handle))
    except (OSError, ValueError):
        return []


def append_entry(username: str, kind: str = DEFAULT_KIND,
                 text: Any = "", lang: str = "fr",
                 risk_level: Optional[str] = None,
                 ideas: Any = None, verdicts: Any = None,
                 now_iso: Optional[str] = None) -> Dict[str, Any]:
    """Ajoute une entrée en TÊTE et rend l'entrée écrite.

    Écriture atomique 0o600 (patron du dépôt). L'identifiant est dérivé du
    contenu et de l'horodatage : deux entrées de la même seconde restent
    distinctes, et l'identifiant reste stable si le fichier est relu.
    """
    kind = kind if kind in KINDS else DEFAULT_KIND
    entry: Dict[str, Any] = {
        "id": "%s-%d" % (kind, abs(hash((now_iso, _text(text)[:200]))) % 10 ** 8),
        "ts": _text(now_iso),
        "kind": kind,
        "lang": _text(lang) or "fr",
        "text": _text(text),
    }
    if risk_level:
        entry["risk_level"] = _text(risk_level)
    if isinstance(ideas, list):
        entry["ideas"] = [i for i in ideas if isinstance(i, dict)]
    if isinstance(verdicts, list):
        entry["verdicts"] = [v for v in verdicts if isinstance(v, dict)]

    rows = ([entry] + load_entries(username))[:MAX_ENTRIES]
    path = journal_path(username)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.parent / (".%s.tmp-%d" % (path.name, os.getpid()))
    fd = os.open(str(tmp_path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.fchmod(fd, 0o600)
    except (AttributeError, OSError):
        pass
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump({"entries": rows}, handle, ensure_ascii=False, indent=2)
        os.replace(str(tmp_path), str(path))
    except Exception:
        try:
            os.remove(str(tmp_path))
        except OSError:
            pass
        raise
    return entry


# --------------------------------------------------------------------------- #
# PUR — le résumé injecté dans le prompt
# --------------------------------------------------------------------------- #

def outcome_index(hypotheses: Any) -> Dict[str, str]:
    """``{"TICKER|AAAA-MM-JJ": "hit"|"miss"|…}`` depuis l'état du radar (PUR).

    Sert à dire au coach ce que ses idées passées ont DONNÉ. Le rapprochement
    se fait par ticker ET par jour de création : c'est best-effort assumé — une
    hypothèse qu'on ne retrouve pas n'apparaît simplement pas dans le résumé,
    on n'invente jamais un verdict.
    """
    out: Dict[str, str] = {}
    if not isinstance(hypotheses, (list, tuple)):
        return out
    for hyp in hypotheses:
        if not isinstance(hyp, dict) or hyp.get("status") != "scored":
            continue
        outcome = _text(hyp.get("outcome"))
        if not outcome:
            continue
        day = _text(hyp.get("created_at"))[:10]
        for ticker in (hyp.get("tickers") or []):
            key = "%s|%s" % (_text(ticker).upper(), day)
            if key:
                out.setdefault(key, outcome)
    return out


def summarize(entries: Any, limit: int = SUMMARY_LIMIT,
              outcomes: Any = None) -> List[Dict[str, Any]]:
    """Les ``limit`` dernières entrées, réduites à ce qui compte pour ne pas se
    répéter (PUR) : date, niveau, et pour chaque idée son ticker, sa direction
    et — si on la retrouve — ce qu'elle a donné.

    On ne recopie PAS le texte des réponses : une idée passée doit tenir en une
    ligne, sinon huit entrées noieraient le contexte de la demande en cours.
    """
    rows = entries if isinstance(entries, list) else []
    index = outcomes if isinstance(outcomes, dict) else {}
    try:
        limit = max(0, int(limit))
    except (TypeError, ValueError):
        limit = SUMMARY_LIMIT

    out: List[Dict[str, Any]] = []
    for entry in rows[:limit]:
        if not isinstance(entry, dict):
            continue
        day = _text(entry.get("ts"))[:10]
        row: Dict[str, Any] = {
            "date": day,
            "kind": _text(entry.get("kind")) or DEFAULT_KIND,
        }
        if entry.get("risk_level"):
            row["risk_level"] = _text(entry.get("risk_level"))

        items: List[Dict[str, Any]] = []
        for idea in (entry.get("ideas") or []):
            if not isinstance(idea, dict):
                continue
            ticker = _text(idea.get("ticker")).upper()
            if not ticker:
                continue
            item = {"ticker": ticker,
                    "direction": _text(idea.get("direction")) or "up"}
            outcome = index.get("%s|%s" % (ticker, day))
            if outcome:
                item["outcome"] = outcome
            items.append(item)
        if items:
            row["ideas"] = items

        stances: List[Dict[str, Any]] = []
        for verdict in (entry.get("verdicts") or []):
            if not isinstance(verdict, dict):
                continue
            symbol = _text(verdict.get("symbol")).upper()
            if not symbol:
                continue
            stances.append({"symbol": symbol,
                            "stance": _text(verdict.get("stance"))})
        if stances:
            row["verdicts"] = stances

        out.append(row)
    return out
