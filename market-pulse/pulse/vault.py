"""Écriture du briefing dans le coffre Obsidian de l'Omen.

C'est la pièce qui fait VIVRE le coffre. Sans elle, `~/market-vault` est une
étagère vide.

Le mécanisme est volontairement bête, et c'est pour ça qu'il marche : chaque
briefing dépose une note datée qui **pointe** vers sa place (`[[Euronext]]`) et
vers chacun de ses thèmes (`[[banche-centrali]]`). Rien n'est calculé, rien
n'est indexé. Ce sont les **rétroliens** d'Obsidian qui font le travail : au
bout de quelques semaines, ouvrir `[[inflazione]]` montre tous les jours où le
sujet a touché une place, et laquelle a bougé ce jour-là. Le lien entre les
bourses se tisse tout seul.

⚠️ Le slug de thème est le point de jonction entre le moteur et le coffre. Le
moteur produit « banche centrali » (avec une espace), le fichier s'appelle
`banche-centrali.md`. Écrire `[[banche centrali]]` créerait un lien MORT et
laisserait la page de thème sans aucun rétrolien — c'est-à-dire exactement
l'inverse du but. `theme_slug` est là pour ça, et un test vérifie que TOUS les
thèmes du moteur ont un slug.

Le coffre est un CONFORT : si l'écriture échoue, le briefing a déjà été publié
ailleurs. `write_note` ne lève jamais.
"""
import io
import os
import re
import unicodedata
from datetime import datetime
from typing import Any, Dict, List, Optional

from .report import fmt_number, fmt_pct

DAILY_DIR = "20 - Giornaliero"
DEFAULT_ROOT = os.path.expanduser("~/market-vault")


def theme_slug(name: Any) -> str:
    """« banche centrali » → « banche-centrali » (le nom du fichier de thème)."""
    if not isinstance(name, str) or not name.strip():
        return ""
    folded = unicodedata.normalize("NFKD", name)
    plain = "".join(c for c in folded if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]+", "-", plain.lower()).strip("-")


def _safe(label: Any) -> str:
    """Un libellé utilisable dans un NOM DE FICHIER : pas de séparateur de
    chemin, sinon l'écriture part dans un dossier inattendu."""
    s = "" if label is None else str(label)
    return re.sub(r"[\\/:*?\"<>|]+", "-", s).strip() or "senza-nome"


def _day(now_ts: Optional[int], briefing: Dict[str, Any]) -> str:
    ts = now_ts if now_ts is not None else briefing.get("generated_at") or 0
    return datetime.fromtimestamp(int(ts)).strftime("%Y-%m-%d")


def note_filename(briefing: Dict[str, Any], now_ts: Optional[int] = None) -> str:
    return "%s — %s.md" % (_day(now_ts, briefing), _safe(briefing.get("label")))


def _index_lines(briefing: Dict[str, Any]) -> List[str]:
    idx = briefing.get("index")
    if not idx:
        return ["Indice non recuperato per questa rilevazione: **n/d**."]
    kind = idx.get("kind")
    price = (fmt_number(idx.get("price"), 4) if kind == "fx"
             else fmt_number(idx.get("price")))
    out = ["**%s** — %s %s · %s" % (idx.get("label") or idx.get("symbol"), price,
                                    idx.get("currency") or "", fmt_pct(idx.get("change_pct")))]
    gap = idx.get("gap") or {}
    if briefing.get("index", {}).get("gap_note") == "open_non_significativo":
        out.append("Gap di apertura non calcolabile: questa piazza non pubblica "
                   "un vero prezzo di apertura.")
    elif gap.get("gap_pct") is not None:
        label = "Gap di apertura" if idx.get("gap_is_today") else "Ultimo gap"
        out.append("%s : %s" % (label, fmt_pct(gap.get("gap_pct"))))
    return out


def render_note(briefing: Optional[Dict[str, Any]],
                analysis: Optional[Dict[str, Any]] = None,
                now_ts: Optional[int] = None) -> Optional[str]:
    """La note markdown du jour pour cette place."""
    if not briefing:
        return None
    day = _day(now_ts, briefing)
    label = briefing.get("label") or briefing.get("exchange") or "?"
    news = briefing.get("news") or {}
    session = briefing.get("session") or {}

    lines = [
        "---",
        "date: %s" % day,
        "borsa: %s" % (briefing.get("exchange") or ""),
        "tags: [briefing]",
        "---",
        "# %s — %s" % (day, label),
        "",
        # LE lien qui rattache la note à sa place : c'est lui qui fait apparaître
        # ce briefing dans les rétroliens de la note permanente de la bourse.
        "**Piazza** : [[%s]] · apertura %s (%s)%s" % (
            _safe(label), session.get("opens_at") or "?", session.get("tz") or "?",
            " · pausa %s-%s" % tuple(session["lunch"]) if session.get("lunch") else ""),
        "",
        "## Indice",
        "",
    ]
    lines += _index_lines(briefing)

    synth = (analysis or {}).get("text")
    lines += ["", "## Sintesi", ""]
    if synth:
        lines += [synth, "", "*(%s)*" % (analysis or {}).get("model", "?")]
    else:
        reason = (analysis or {}).get("reason") or "motivo non registrato"
        lines += ["Sintesi **non disponibile** — %s." % reason]

    comparison = briefing.get("comparison") or []
    if comparison:
        lines += ["", "## Confronto", "", "| Piazza | Var. | Stato |", "|---|---|---|"]
        for c in comparison:
            lines.append("| %s | %s | %s |" % (c.get("label") or "?",
                                               fmt_pct(c.get("change_pct")),
                                               c.get("state") or "?"))

    agenda = briefing.get("agenda") or []
    if agenda:
        lines += ["", "## Agenda", ""]
        for a in agenda:
            when = str(a.get("when") or "")[:16].replace("T", " ")
            stake = a.get("at_stake")
            lines.append("- **%s** — %s%s" % (when, a.get("what") or "?",
                                              " (%s)" % stake if stake else ""))

    items = news.get("items") or []
    facts = [i for i in items if (i.get("event") or {}).get("is_event")]
    rest = [i for i in items if not (i.get("event") or {}).get("is_event")]
    if facts:
        lines += ["", "## Notizie — qualcuno ha fatto qualcosa", ""]
        for i in facts[:12]:
            ev = i.get("event") or {}
            tag = "%s · %s" % (ev.get("actor") or "?",
                               ", ".join(ev.get("actions") or []) or "-")
            lines.append("- `%s` %s — *%s*" % (tag, i.get("title"), i.get("source") or "?"))
    if rest:
        lines += ["", "### Commenti e analisi", ""]
        for i in rest[:6]:
            lines.append("- %s — *%s*" % (i.get("title"), i.get("source") or "?"))

    themes = news.get("themes") or []
    if themes:
        # Les liens de thème : le second pilier du graphe.
        links = " · ".join("[[%s]]" % theme_slug(t.get("theme"))
                           for t in themes if theme_slug(t.get("theme")))
        lines += ["", "## Temi", "", links]

    followed = briefing.get("followed") or []
    if followed:
        lines += ["", "## Titoli seguiti", ""]
        for f in followed:
            lines.append("- **%s** (%s) %s" % (f.get("label") or f.get("symbol"),
                                               f.get("symbol"),
                                               fmt_pct(f.get("change_pct"))))

    discovered = briefing.get("discovered") or []
    if discovered:
        lines += ["", "## Nuovi titoli comparsi nelle notizie", "",
                  "*Comparsi nell'attualità di oggi e non ancora seguiti. "
                  "Nessun giudizio: sta a te decidere se seguirli.*", ""]
        for d in discovered:
            lines.append("- **%s** (%s) — %s mention(i) — « %s »" % (
                d.get("name") or d.get("symbol"), d.get("symbol"),
                d.get("mentions"), (d.get("headline") or "")[:90]))

    tone = news.get("tone") or {}
    lines += ["", "## Nota di raccolta", ""]
    lines.append("- fonti raggiunte : %s" % (", ".join(news.get("sources_ok") or []) or "nessuna"))
    if news.get("stale_sources"):
        lines.append("- fonti **non aggiornate** : %s" % ", ".join(news["stale_sources"]))
    if news.get("sources_failed"):
        lines.append("- fonti in errore : %s" % ", ".join(
            f.get("source", "?") for f in news["sources_failed"]))
    lines.append("- titoli scartati : %s consigli, %s fuori tema" % (
        news.get("filtered_advice", 0), news.get("filtered_offtopic", 0)))
    if tone:
        lines.append("- parole di tono nei titoli : %s positive, %s negative su %s"
                     % (tone.get("positive", 0), tone.get("negative", 0), tone.get("total", 0)))

    errors = briefing.get("errors") or []
    if errors:
        lines += ["", "## Dati mancanti", ""]
        for e in errors:
            lines.append("- `%s` — %s" % (e.get("symbol"), e.get("error")))

    lines += ["", "---", "",
              "*Documento informativo: solo fatti osservati, nessuna indicazione "
              "operativa.*", ""]
    return "\n".join(lines)


def write_note(root: Optional[str], briefing: Optional[Dict[str, Any]],
               analysis: Optional[Dict[str, Any]] = None,
               now_ts: Optional[int] = None) -> Optional[str]:
    """Écrit la note du jour. Rend le chemin, ou None si rien n'a été écrit.

    Ne lève JAMAIS : le coffre est un confort, pas une dépendance du run. Un
    rattrapage qui relance le briefing du jour REMPLACE la note au lieu d'en
    accumuler deux versions contradictoires pour la même date.
    """
    body = render_note(briefing, analysis, now_ts)
    if body is None:
        return None
    try:
        folder = os.path.join(root or DEFAULT_ROOT, DAILY_DIR)
        os.makedirs(folder, exist_ok=True)
        path = os.path.join(folder, note_filename(briefing, now_ts))
        with io.open(path, "w", encoding="utf-8") as f:
            f.write(body)
        return path
    except OSError:
        return None
