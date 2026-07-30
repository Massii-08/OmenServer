"""L'agenda daté — les « prévisions » du bot, et la seule forme honnête d'en faire.

Massii a demandé « des prévisions ». Ce qu'on lui donne : **la liste des rendez-vous
datés qui arrivent, et ce qui est en jeu à chacun**. Une date est un fait ; « la
bourse va monter » n'en est pas un. `at_stake` dit donc ce qui bouge selon l'issue,
**jamais laquelle** — un test cherche le vocabulaire interdit dans tout l'agenda.

Trois sources vivantes, sondées à la main le 2026-07-30 :

    Fed  federalreserve.gov/monetarypolicy/fomccalendars.htm   -> nyse, nasdaq
    BoJ  boj.or.jp/en/mopo/mpmsche_minu/index.htm              -> jpx
    BNS  snb.ch/public/rss/en/events                           -> toutes

⚠️ **BCE et BoE ne sont pas là, et ce n'est pas un oubli** : leurs pages de
calendrier répondent 200 mais construisent les dates en JavaScript — elles ne
sont PAS dans le HTML (vérifié : la page BCE ne contient qu'une seule date, et
c'est celle du jour). Elles passent donc par le fichier curé
`data/market_pulse/agenda.json`, qu'on remplit à la main. Une date inventée
serait pire que pas de date : le lecteur n'a aucun moyen de la vérifier.

⚠️ **Le garde-fou central : jamais une date passée.** Yahoo rend la dernière date
de résultats quand la prochaine n'est pas annoncée (spec §3quinquies), un flux
MarketWatch a rendu 200 avec des titres de treize mois. Ici, tout événement dont
le jour est révolu est écarté — et un événement daté « au jour » (sans heure)
reste valable jusqu'à la fin de sa journée.

Horizon par défaut : **7 jours**. À 48 h la section serait vide cinq jours sur
sept, et une section vide se lit comme « rien ne se passe » — ce qui est faux.
"""
import calendar
import io
import json
import os
import re
import time
import xml.etree.ElementTree as ET
from typing import Any, Callable, Dict, List, Optional

DEFAULT_CURATED_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "data", "market_pulse", "agenda.json")

DEFAULT_HORIZON_H = 168.0        # 7 jours — voir le docstring
DEFAULT_MAX_ITEMS = 8

USER_AGENT = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
              "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36")

SOURCES = (
    {"name": "Fed", "kind": "fomc_html", "venues": ("nyse", "nasdaq"),
     "url": "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm"},
    {"name": "BoJ", "kind": "boj_html", "venues": ("jpx",),
     "url": "https://www.boj.or.jp/en/mopo/mpmsche_minu/index.htm"},
    {"name": "BNS", "kind": "snb_rss", "venues": (),
     "url": "https://www.snb.ch/public/rss/en/events"},
)

_MESI = ("gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno",
         "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre")

_MONTHS = {
    "january": 1, "jan": 1, "february": 2, "feb": 2, "march": 3, "mar": 3,
    "april": 4, "apr": 4, "may": 5, "june": 6, "jun": 6, "july": 7, "jul": 7,
    "august": 8, "aug": 8, "september": 9, "sept": 9, "sep": 9,
    "october": 10, "oct": 10, "november": 11, "nov": 11, "december": 12, "dec": 12,
}


# --------------------------------------------------------------------------
# Outils de date
# --------------------------------------------------------------------------

def _epoch_day(year: int, month: int, day: int) -> Optional[int]:
    try:
        return calendar.timegm((year, month, day, 0, 0, 0, 0, 0, 0))
    except (ValueError, OverflowError):
        return None


def _epoch_iso(raw: Any) -> Optional[int]:
    """ISO 8601 → epoch UTC. Rend None sur tout ce qui n'est pas une date."""
    if not isinstance(raw, str):
        return None
    s = raw.strip().replace("Z", "+0000")
    for fmt in ("%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M%z",
                "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M", "%Y-%m-%d"):
        try:
            import datetime
            dt = datetime.datetime.strptime(s, fmt)
        except ValueError:
            continue
        if dt.tzinfo is None:
            return calendar.timegm(dt.timetuple())
        return int(dt.timestamp())
    return None


def _text(node) -> str:
    return (node.text or "").strip() if node is not None else ""


def _strip_tags(html: str) -> str:
    return " ".join(re.sub(r"<[^>]+>", " ", html or "").split())


def _event(when: str, when_ts: int, day_only: bool, what: str,
           at_stake: str, source: str, source_url: str,
           venues) -> Dict[str, Any]:
    return {"when": when, "when_ts": int(when_ts), "day_only": bool(day_only),
            "what": what, "at_stake": at_stake, "source": source,
            "source_url": source_url, "venues": list(venues or ())}


# --------------------------------------------------------------------------
# Fed — les huit réunions de l'année, dans un panneau par année
# --------------------------------------------------------------------------

_FOMC_YEAR = re.compile(r'<h4><a id="\d+">(20\d\d) FOMC Meetings</a></h4>')
_FOMC_ROW = re.compile(
    r'fomc-meeting__month[^>]*>(.*?)</div>.*?fomc-meeting__date[^>]*>(.*?)</div>',
    re.S)
_FOMC_DAYS = re.compile(r"(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?")

_FED_AT_STAKE = "il costo del denaro negli Stati Uniti"


def parse_fomc_calendar(html: Any,
                        venues=("nyse", "nasdaq")) -> List[Dict[str, Any]]:
    """Réunions du FOMC depuis la page calendrier de la Fed.

    La page est découpée en panneaux `<h4>2026 FOMC Meetings</h4>` — c'est de là
    que vient l'année, jamais d'une supposition sur « l'année en cours ».

    ⚠️ **La date rendue est celle de la DÉCISION, donc le DERNIER jour** : une
    réunion « October 27-28 » se conclut le 28. Annoncer le 27 ferait attendre le
    communiqué un jour trop tôt.
    """
    if not isinstance(html, str):
        try:
            html = html.decode("utf-8", "replace")
        except AttributeError:
            return []
    parts = _FOMC_YEAR.split(html)
    out = []
    for index in range(1, len(parts) - 1, 2):
        try:
            year = int(parts[index])
        except ValueError:
            continue
        for raw_month, raw_days in _FOMC_ROW.findall(parts[index + 1]):
            month = _MONTHS.get(_strip_tags(raw_month).strip().lower().rstrip("."))
            if not month:
                continue
            # Le « * » signale une réunion avec projections économiques : c'est
            # une note de bas de page du site, pas une information pour le lecteur.
            days = _FOMC_DAYS.search(_strip_tags(raw_days))
            if not days:
                continue
            first = int(days.group(1))
            last = int(days.group(2)) if days.group(2) else first
            end_month, end_year = month, year
            if last < first:
                # « April 30 - May 1 » : le second jour est dans le mois suivant.
                end_month = 1 if month == 12 else month + 1
                end_year = year + 1 if month == 12 else year
            ts = _epoch_day(end_year, end_month, last)
            if ts is None:
                continue
            span = "%d" % first if last == first else "%d-%d" % (first, last)
            out.append(_event(
                when="%04d-%02d-%02d" % (end_year, end_month, last),
                when_ts=ts, day_only=True,
                what="Fed — riunione del FOMC (%s %s)" % (span, _MESI[month - 1]),
                at_stake=_FED_AT_STAKE, source="Fed",
                source_url="https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm",
                venues=venues))
    out.sort(key=lambda e: e["when_ts"])
    return out


# --------------------------------------------------------------------------
# BoJ — un tableau par année, l'année en légende
# --------------------------------------------------------------------------

_BOJ_TABLE = re.compile(r"<table.*?</table>", re.S)
_BOJ_CAPTION = re.compile(r"<caption[^>]*>(.*?)</caption>", re.S)
_BOJ_ROW = re.compile(r"<tr>(.*?)</tr>", re.S)
_BOJ_CELL = re.compile(r"<td[^>]*>(.*?)</td>", re.S)
# « July 30 (Thurs.), 31 (Fri.) » — le mois n'est écrit qu'une fois.
_BOJ_DATE = re.compile(
    r"([A-Z][a-z]{2,8})\.?\s*(\d{1,2})\s*\([^)]*\)(?:\s*,\s*(\d{1,2})\s*\([^)]*\))?")

_BOJ_AT_STAKE = "il costo del denaro in Giappone e il cambio dello yen"


def parse_boj_schedule(html: Any, venues=("jpx",)) -> List[Dict[str, Any]]:
    """Réunions de politique monétaire de la Banque du Japon.

    La **première cellule** de chaque ligne porte la date de réunion ; l'année
    vient de la légende du tableau (« Table : 2026 »). Les lignes passées
    enveloppent la date dans un lien vers le PDF du communiqué — d'où le
    nettoyage des balises et du « [PDF 171KB] ».
    """
    if not isinstance(html, str):
        try:
            html = html.decode("utf-8", "replace")
        except AttributeError:
            return []
    out = []
    for table in _BOJ_TABLE.findall(html):
        caption = _BOJ_CAPTION.search(table)
        year_match = re.search(r"(20\d\d)", _strip_tags(caption.group(1)) if caption else "")
        if not year_match:
            continue
        year = int(year_match.group(1))
        for row in _BOJ_ROW.findall(table):
            cells = _BOJ_CELL.findall(row)
            if not cells:
                continue
            raw = re.sub(r"\[PDF[^\]]*\]", " ", _strip_tags(cells[0]))
            found = _BOJ_DATE.search(raw)
            if not found:
                continue
            month = _MONTHS.get(found.group(1).strip().lower().rstrip("."))
            if not month:
                continue
            first = int(found.group(2))
            last = int(found.group(3)) if found.group(3) else first
            ts = _epoch_day(year, month, max(first, last))
            if ts is None:
                continue
            span = "%d" % first if last == first else "%d-%d" % (first, last)
            out.append(_event(
                when="%04d-%02d-%02d" % (year, month, max(first, last)),
                when_ts=ts, day_only=True,
                what="BoJ — riunione di politica monetaria (%s %s)"
                     % (span, _MESI[month - 1]),
                at_stake=_BOJ_AT_STAKE, source="BoJ",
                source_url="https://www.boj.or.jp/en/mopo/mpmsche_minu/index.htm",
                venues=venues))
    out.sort(key=lambda e: e["when_ts"])
    return out


# --------------------------------------------------------------------------
# BNS — le seul RSS de banque centrale réellement daté dans le futur
# --------------------------------------------------------------------------

# Ordre significatif : « Monetary policy assessment … (news conference) » contient
# les deux motifs, le plus spécifique doit gagner.
_SNB_LABELS = (
    ("summary of monetary policy discussion",
     "BNS — verbale della discussione di politica monetaria", ""),
    ("monetary policy assessment",
     "BNS — valutazione di politica monetaria",
     "il costo del denaro in Svizzera e il cambio del franco"),
    ("interim results", "BNS — risultati intermedi", ""),
    ("annual result", "BNS — risultato annuale", ""),
    ("news conference", "BNS — conferenza stampa", ""),
)

_SNB_PREFIX = re.compile(r"^\s*\d{4}-\d{2}-\d{2}\s*-\s*")


def _snb_label(title: str):
    low = title.lower()
    for needle, label, at_stake in _SNB_LABELS:
        if needle in low:
            if "press release" in low:
                label += " (comunicato)"
            elif "news conference" in low and "conferenza" not in label:
                label += " (conferenza stampa)"
            return label, at_stake
    # Aucun motif connu : on garde le titre de la source, préfixé — un fait
    # sourcé en anglais vaut mieux qu'une traduction devinée.
    return "BNS — " + title, ""


def parse_snb_events(data: Any, venues=()) -> List[Dict[str, Any]]:
    """Agenda de la Banque nationale suisse (RSS `cb:` avec `<date>` ISO).

    ⚠️ Le flux est servi **du plus lointain au plus proche** (2028 en premier) :
    un parseur qui ferait confiance à `items[0]` annoncerait 2028 comme prochain
    rendez-vous. On trie, toujours.
    """
    if not data:
        return []
    try:
        root = ET.fromstring(data if isinstance(data, bytes) else str(data).encode("utf-8"))
    except ET.ParseError:
        return []
    out = []
    for item in root.iter():
        if not item.tag.endswith("item"):
            continue
        title, link, when = "", "", ""
        for child in item:
            tag = child.tag.split("}")[-1]
            if tag == "title":
                title = _text(child)
            elif tag == "link" and not link:
                link = _text(child)
            elif tag == "date":
                when = _text(child)
        ts = _epoch_iso(when)
        if ts is None or not title:
            continue
        clean = _SNB_PREFIX.sub("", title).strip()
        label, at_stake = _snb_label(clean)
        out.append(_event(when=when, when_ts=ts, day_only=False, what=label,
                          at_stake=at_stake, source="BNS",
                          source_url=link or "https://www.snb.ch/en/the-snb/events",
                          venues=venues))
    out.sort(key=lambda e: e["when_ts"])
    return out


# --------------------------------------------------------------------------
# Fichier curé — BCE, BoE, et tout ce que Massii veut ajouter à la main
# --------------------------------------------------------------------------

def load_curated(path: Optional[str] = None) -> List[Dict[str, Any]]:
    """Événements écrits à la main. Absent ou cassé → liste vide, jamais d'erreur.

    Deux formes acceptées : `{"eventi": [...]}` ou une liste à la racine. Un
    fichier édité à la main auquel il manque la clé enveloppe serait sinon
    ignoré en silence — et un silence ressemble à « rien à l'agenda ».
    """
    path = path or DEFAULT_CURATED_PATH
    if not os.path.isfile(path):
        return []
    try:
        with io.open(path, encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, ValueError):
        return []
    rows = raw.get("eventi") if isinstance(raw, dict) else raw
    if not isinstance(rows, list):
        return []
    out = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        when = row.get("when")
        ts = _epoch_iso(when)
        what = str(row.get("what") or "").strip()
        if ts is None or not what:
            continue                       # sans date lisible, on jette
        out.append(_event(
            when=str(when), when_ts=ts, day_only=len(str(when).strip()) == 10,
            what=what, at_stake=str(row.get("at_stake") or ""),
            source=str(row.get("source") or "agenda"),
            source_url=str(row.get("source_url") or ""),
            venues=row.get("venues") or ()))
    out.sort(key=lambda e: e["when_ts"])
    return out


def write_example(path: Optional[str] = None) -> str:
    """Écrit un exemple COMMENTÉ à côté du vrai fichier.

    Il ne contient **aucune date réelle** : une date d'exemple recopiée par
    inadvertance serait un fait faux. C'est la forme qui est documentée.
    """
    path = (path or DEFAULT_CURATED_PATH) + ".esempio"
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    body = json.dumps({
        "_come_usare": "Copia in agenda.json. Serve per le banche centrali il cui "
                       "calendario non e leggibile automaticamente (BCE, BoE): "
                       "scrivi la data solo se l'hai verificata sul sito.",
        "_campi": {"when": "AAAA-MM-GG oppure AAAA-MM-GGTHH:MMZ",
                   "what": "cosa succede, in italiano",
                   "at_stake": "cosa e in gioco — mai in che direzione",
                   "source_url": "il link che permette di verificare",
                   "venues": "elenco di borse, vuoto = tutte"},
        "eventi": [],
    }, ensure_ascii=False, indent=1)
    with io.open(path, "w", encoding="utf-8") as f:
        f.write(body + "\n")
    return path


# --------------------------------------------------------------------------
# Collecte
# --------------------------------------------------------------------------

def _default_fetch(url: str):
    import httpx
    r = httpx.get(url, headers={"User-Agent": USER_AGENT}, timeout=20.0,
                  follow_redirects=True)
    r.raise_for_status()
    return r.text


_PARSERS = {
    "fomc_html": parse_fomc_calendar,
    "boj_html": parse_boj_schedule,
    "snb_rss": parse_snb_events,
}


def _still_ahead(event: Dict[str, Any], now_ts: int, horizon_s: float) -> bool:
    """Un événement daté « au jour » court jusqu'à la fin de sa journée.

    Sans cette tolérance, la réunion du jour disparaîtrait de l'agenda à
    00:00:01 — alors que c'est précisément le jour où elle compte.
    """
    grace = 86399 if event.get("day_only") else 0
    if event["when_ts"] + grace < now_ts:
        return False
    return event["when_ts"] <= now_ts + horizon_s


def for_venue(events: List[Dict[str, Any]],
              venue: Optional[str]) -> List[Dict[str, Any]]:
    """Événements qui concernent cette place. Sans étiquette = partout."""
    if venue is None:
        return list(events or [])
    return [e for e in (events or [])
            if not e.get("venues") or venue in e["venues"]]


def collect_agenda(now_ts: Optional[int] = None,
                   fetch: Optional[Callable[[str], Any]] = None,
                   sources=SOURCES,
                   curated_path: Optional[str] = None,
                   horizon_h: float = DEFAULT_HORIZON_H,
                   max_items: int = DEFAULT_MAX_ITEMS,
                   pacing_s: float = 0.4,
                   sleep: Callable[[float], None] = time.sleep) -> Dict[str, Any]:
    """Les rendez-vous datés qui arrivent, toutes sources confondues.

    Ne lève JAMAIS : une banque centrale injoignable part dans `sources_failed`
    et les autres sortent quand même. Perdre l'agenda ne doit pas coûter le
    briefing.
    """
    fetch = fetch or _default_fetch
    now_ts = int(now_ts if now_ts is not None else time.time())
    horizon_s = float(horizon_h) * 3600.0

    ok, failed = [], []
    events = []
    for index, source in enumerate(sources or ()):
        parser = _PARSERS.get(source.get("kind"))
        if parser is None:
            continue
        if index and pacing_s:
            sleep(pacing_s)          # low-and-slow : on ne martèle personne
        try:
            raw = fetch(source["url"])
            found = parser(raw, venues=tuple(source.get("venues") or ()))
        except Exception as e:
            failed.append({"source": source.get("name") or source.get("url"),
                           "error": "%s: %s" % (type(e).__name__, e)})
            continue
        ok.append(source.get("name") or source.get("url"))
        events.extend(found)

    events.extend(load_curated(curated_path))

    keep, seen = [], set()
    for e in sorted(events, key=lambda x: x["when_ts"]):
        if not _still_ahead(e, now_ts, horizon_s):
            continue
        key = (e["when"][:10], e["what"])
        if key in seen:
            continue
        seen.add(key)
        keep.append(e)

    return {"events": keep[:max_items], "sources_ok": ok,
            "sources_failed": failed, "generated_at": now_ts,
            "horizon_h": float(horizon_h)}


def upcoming_events(now_ts: Optional[int] = None,
                    venue: Optional[str] = None,
                    **kwargs) -> List[Dict[str, Any]]:
    """Ce que le briefing consomme : la liste, filtrée pour une place."""
    return for_venue(collect_agenda(now_ts, **kwargs)["events"], venue)
