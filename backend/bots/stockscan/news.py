"""News du scanner : admission, classement, récence (PUR) + flux TradingView frais.

Le classement est CELUI DU COACH (``newswatch.classify`` : neg > pos > watch >
neutre, mots-clés FR/EN/IT) : le scanner se base sur les news du coach, il
doit les lire avec les mêmes yeux.

Admission d'un titre :

- refusé si ``newswatch.is_advice`` le dit (règle du coach) ;
- refusé si c'est un conseil ADRESSÉ AU LECTEUR (« 3 stocks to buy », « should
  you buy », « da comprare »…) — la liste du coach est minimale ;
- les changements de recommandation d'analystes (« upgrade », « downgrade »)
  restent admis, comme dans la veille du coach : ce sont des événements qui
  font bouger les cours. Le filtre plus strict de Market Pulse (fait pour un
  lecteur âgé) n'est volontairement PAS repris : il jette aussi « X to sell its
  unit to Y », qui est un fait (une cession).

La partie I/O (``fetch_fresh``) va chercher le flux TradingView des titres de
la présélection — même hôte que la veille du coach, donc pacing, plafond et
disjoncteur : au premier 429 (ou à trois pannes de suite) on arrête, les titres
restants sont marqués ``news_unverified`` et le scan va au bout quand même.
"""
import re
import time
import unicodedata
from datetime import datetime, timezone
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple

NEUTRAL = "neutral"
SENTIMENTS = ("pos", "neg", "watch", NEUTRAL)

# Familles de sources — « plusieurs familles distinctes » est un signal de
# convergence (même idée que ``convergence.cross_source`` du coach).
FAMILY_TRADINGVIEW = "tradingview"
FAMILY_PRESS = "presse"
FAMILY_SOCIAL = "social"
FAMILY_SEC = "sec"

_SOCIAL_SRC = frozenset({"reddit", "x", "bsky"})

# Conseils adressés au lecteur. Motifs, jamais un mot nu (« buy » seul
# jetterait « Buyout » ou « buyback ») — cf. la mise en garde de
# ``pulse.sentiment`` sur les termes ambigus.
EXTRA_ADVICE_PATTERNS = [
    r"\bstocks? to (buy|own|watch)\b", r"\bshould you (buy|sell)\b",
    r"\bis it a (buy|sell)\b", r"\btop picks?\b", r"\bstrong buy\b",
    r"\bbest stocks?\b", r"\btime to (buy|sell)\b",
    r"\bda comprare\b", r"\btitoli da (comprare|acquistare)\b",
    r"\ba acheter\b", r"\bactions a acheter\b", r"\bfaut-il acheter\b",
]
_EXTRA_ADVICE_RE = [re.compile(p, re.IGNORECASE) for p in EXTRA_ADVICE_PATTERNS]

# « Buy now, pay later » est un MÉTIER (Klarna, Affirm), pas un conseil — or la
# liste du coach contient « buy now ». On retire l'expression avant de juger,
# sinon toute dépêche sur ces sociétés serait jetée comme un conseil.
_BNPL_RE = re.compile(r"buy[\s-]+now[\s,-]+pay[\s-]+later", re.IGNORECASE)

# Un horodatage dans le futur est toléré jusqu'à une heure (horloges décalées) ;
# au-delà c'est une date inventée, l'item est jeté.
FUTURE_TOLERANCE_H = 1.0


# --------------------------------------------------------------------------- #
# PUR — admission et classement
# --------------------------------------------------------------------------- #

def _fold(text: Any) -> str:
    if not isinstance(text, str):
        return ""
    folded = unicodedata.normalize("NFKD", text)
    return "".join(c for c in folded if not unicodedata.combining(c)).lower()


def _coach():
    """Le module de veille du coach (import paresseux, comme partout ailleurs)."""
    from backend.bots.paper import newswatch
    return newswatch


def is_advice(title: Any) -> bool:
    """Le titre est-il lui-même un conseil d'investissement ?"""
    if not isinstance(title, str) or not title.strip():
        return False
    title = _BNPL_RE.sub(" ", title)
    try:
        if _coach().is_advice(title):
            return True
    except Exception:             # noqa: BLE001 — veille du coach absente
        pass
    folded = _fold(title)
    return any(rx.search(folded) for rx in _EXTRA_ADVICE_RE)


def classify(title: Any) -> str:
    """``pos`` | ``neg`` | ``watch`` | ``neutral`` — le classement du coach."""
    if not isinstance(title, str) or not title.strip():
        return NEUTRAL
    try:
        verdict = _coach().classify(title)
    except Exception:             # noqa: BLE001
        verdict = None
    return verdict if verdict in SENTIMENTS else NEUTRAL


def parse_ts(value: Any) -> Optional[datetime]:
    """ISO ou epoch -> datetime UTC conscient. Un ISO NAÏF est lu en UTC.

    Les ``ts`` du coach n'ont pas tous la même origine (heure de lecture pour
    le RSS, de publication pour TradingView, heure locale naïve pour la SEC) :
    l'erreur ≤ 2 h est négligeable sur une fenêtre de 24 à 72 h.
    """
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        seconds = float(value)
        if seconds > 1e11:
            seconds /= 1000.0
        try:
            return datetime.fromtimestamp(seconds, tz=timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None
    if isinstance(value, str) and value.strip():
        try:
            moment = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
        except ValueError:
            return None
        return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)
    return None


def age_hours(ts: Any, now: datetime) -> Optional[float]:
    moment = parse_ts(ts)
    if moment is None:
        return None
    return (now - moment).total_seconds() / 3600.0


def in_window(ts: Any, now: datetime, window_h: float) -> bool:
    age = age_hours(ts, now)
    return age is not None and -FUTURE_TOLERANCE_H <= age <= float(window_h)


def recency_weight(age_h: Optional[float]) -> float:
    """≤ 24 h : 1 ; ≤ 48 h : 0,6 ; au-delà : 0,3 (spec §6)."""
    if age_h is None:
        return 0.0
    if age_h <= 24:
        return 1.0
    if age_h <= 48:
        return 0.6
    return 0.3


def normalize_title(title: Any) -> str:
    return " ".join(re.sub(r"[^\w\s]", " ", _fold(title)).split())


def merge(*lists: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Fusion dédoublonnée (URL, puis titre normalisé), la plus récente d'abord.

    À doublon égal, la PREMIÈRE liste passée gagne : l'appelant passe d'abord
    la source la plus riche (le flux frais avant le carnet du coach).
    """
    out: List[Dict[str, Any]] = []
    seen_urls, seen_titles = set(), set()
    for items in lists:
        for item in items or []:
            if not isinstance(item, dict) or not item.get("title"):
                continue
            url = (item.get("url") or "").strip()
            title_key = normalize_title(item.get("title"))
            if (url and url in seen_urls) or (title_key and title_key in seen_titles):
                continue
            if url:
                seen_urls.add(url)
            if title_key:
                seen_titles.add(title_key)
            out.append(item)
    out.sort(key=lambda it: parse_ts(it.get("published")) or datetime.min.replace(tzinfo=timezone.utc),
             reverse=True)
    return out


def item_from_tv(raw: Dict[str, Any], lang: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Item de ``tvnews.parse_items`` (ou du cache du coach) -> item du scanner."""
    if not isinstance(raw, dict):
        return None
    title = (raw.get("title") or "").strip()
    published = raw.get("published")
    if not title or parse_ts(published) is None:
        return None
    url = (raw.get("url") or "").strip()
    return {
        "title": title,
        "url": url if url.startswith(("http://", "https://")) else "",
        "published": parse_ts(published).isoformat(),
        "source": FAMILY_TRADINGVIEW,
        "family": FAMILY_TRADINGVIEW,
        "provider": (raw.get("provider") or "") or None,
        "lang": raw.get("lang") or lang,
        "sentiment": classify(title),
    }


def family_of_event(event: Dict[str, Any]) -> str:
    """Famille d'un événement du carnet du coach (cf. champ ``src``)."""
    src = str(event.get("src") or "").lower()
    source = str(event.get("source") or "").lower()
    if source == "tradingview" or src == "tradingview":
        return FAMILY_TRADINGVIEW
    if src in _SOCIAL_SRC:
        return FAMILY_SOCIAL
    if src == "sec_own":
        return FAMILY_SEC
    return FAMILY_PRESS


def item_from_event(event: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Événement du carnet du coach -> item du scanner (classement du coach
    conservé quand il est l'un des quatre connus, recalculé sinon)."""
    if not isinstance(event, dict):
        return None
    title = (event.get("title") or "").strip()
    moment = parse_ts(event.get("ts"))
    if not title or moment is None:
        return None
    link = (event.get("link") or "").strip()
    sentiment = event.get("sentiment")
    if sentiment not in SENTIMENTS:
        sentiment = classify(title)
    family = family_of_event(event)
    src = str(event.get("src") or "").lower()
    return {
        "title": title,
        "url": link if link.startswith(("http://", "https://")) else "",
        "published": moment.isoformat(),
        "source": src or ("tradingview" if family == FAMILY_TRADINGVIEW else "coach"),
        "family": family,
        "provider": event.get("provider") or event.get("handle") or event.get("subreddit") or None,
        "lang": event.get("lang"),
        "sentiment": sentiment,
    }


def admit(items: Iterable[Dict[str, Any]], now: datetime,
          window_h: float) -> Tuple[List[Dict[str, Any]], int]:
    """Garde les items dans la fenêtre et non-conseils -> ``(gardés, conseils écartés)``."""
    kept: List[Dict[str, Any]] = []
    advice = 0
    for item in items or []:
        if not isinstance(item, dict):
            continue
        if not in_window(item.get("published"), now, window_h):
            continue
        if is_advice(item.get("title")):
            advice += 1
            continue
        kept.append(item)
    return kept, advice


# --------------------------------------------------------------------------- #
# I/O — le flux TradingView frais de la présélection
# --------------------------------------------------------------------------- #

def tv_fetcher(client: Any) -> Callable[[str, str], Tuple[Optional[List[Dict[str, Any]]], int]]:
    """``fetch(tv_symbol, lang) -> (items | None si panne, statut)`` sur ``client``.

    Réutilise l'URL, les en-têtes et le parseur du collecteur du coach
    (``paper/tvnews.py``) : une seule définition du flux dans le dépôt.
    """
    from backend.bots.paper import tvnews

    def fetch(tv_symbol: str, lang: str):
        url = tvnews.NEWS_URL.format(lang=lang or "en", tv_symbol=tv_symbol)
        try:
            resp = client.get(url, headers=dict(tvnews.HEADERS))
        except Exception:         # noqa: BLE001 — réseau/TLS
            return None, 0
        status = getattr(resp, "status_code", 0)
        try:
            status = int(status)
        except (TypeError, ValueError):
            status = 0
        if status != 200:
            return None, status
        try:
            payload = resp.json()
        except Exception:         # noqa: BLE001
            return None, status
        return tvnews.parse_items(payload, tv_symbol), status

    return fetch


def fetch_fresh(targets: List[Tuple[str, Tuple[str, ...]]],
                fetch: Callable[[str, str], Tuple[Optional[List[Dict[str, Any]]], int]],
                cache: Optional[Dict[str, Dict[str, Any]]] = None,
                now: Optional[datetime] = None,
                sleep: Callable[[float], None] = time.sleep,
                monotonic: Callable[[], float] = time.monotonic,
                min_interval: float = 1.2,
                cache_fresh_s: float = 900.0,
                max_consecutive_failures: int = 3,
                should_stop: Optional[Callable[[], bool]] = None,
                on_progress: Optional[Callable[[int, int], None]] = None,
                ) -> Tuple[Dict[str, List[Dict[str, Any]]], Dict[str, Any]]:
    """News TradingView de chaque cible -> ``({tv_symbol: [items]}, stats)``.

    ``targets`` = ``[(tv_symbol, langues)]`` dans l'ordre de priorité.
    ``cache`` = ``items_by_symbol`` du coach : une entrée lue il y a moins de
    ``cache_fresh_s`` secondes est réutilisée telle quelle (zéro requête).

    Un symbole dont rien n'a pu être lu (panne, disjoncteur, arrêt) est ABSENT
    du résultat — c'est ce qui permet de le marquer ``news_unverified`` ; un
    symbole lu sans aucune news a une liste vide.
    """
    now = now or datetime.now(timezone.utc)
    cache = cache if isinstance(cache, dict) else {}
    stats = {"requests": 0, "ok": 0, "failed": 0, "unknown": 0,
             "from_cache": 0, "skipped": 0, "breaker": False, "breaker_status": None}
    out: Dict[str, List[Dict[str, Any]]] = {}
    consecutive = 0
    last_call: Optional[float] = None
    total = len(targets)

    for index, (tv_symbol, langs) in enumerate(targets):
        if on_progress:
            on_progress(index, total)
        if stats["breaker"] or (should_stop and should_stop()):
            stats["skipped"] += 1
            continue

        entry = cache.get(tv_symbol)
        if isinstance(entry, dict):
            fetched = parse_ts(entry.get("fetched_at"))
            if fetched is not None and 0 <= (now - fetched).total_seconds() <= cache_fresh_s:
                rows = [item_from_tv(r) for r in entry.get("items") or []]
                out[tv_symbol] = [r for r in rows if r]
                stats["from_cache"] += 1
                continue

        collected: List[Dict[str, Any]] = []
        read_any = False
        for lang in langs or ("en",):
            if last_call is not None:
                wait = min_interval - (monotonic() - last_call)
                if wait > 0:
                    sleep(wait)
            last_call = monotonic()
            stats["requests"] += 1
            items, status = fetch(tv_symbol, lang)
            if items is not None:
                read_any = True
                consecutive = 0
                for raw in items:
                    item = item_from_tv(raw, lang)
                    if item:
                        collected.append(item)
                continue
            if status == 422:         # symbole inconnu du flux : pas une panne
                stats["unknown"] += 1
                read_any = True
                continue
            consecutive += 1
            if status == 429 or consecutive >= max_consecutive_failures:
                stats["breaker"] = True
                stats["breaker_status"] = status
                break
        if read_any:
            stats["ok"] += 1
            out[tv_symbol] = merge(collected)
        else:
            stats["failed"] += 1
    if on_progress:
        on_progress(total, total)
    return out, stats
