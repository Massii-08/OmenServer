"""Collecte de la presse financière — RSS uniquement, stdlib, déterministe.

Toutes les sources ci-dessous ont été SONDÉES une par une le 2026-07-28 : code
HTTP, type de contenu, nombre d'items, fraîcheur du plus récent. Trois leçons
en sont sorties, et elles sont câblées dans le code :

- **Reddit est mort pour nous** : les endpoints `.json` publics renvoient 403.
  Aucun flux Reddit ne figure donc ici (le plan initial en prévoyait — la
  sonde a tranché).
- **Un « 200 OK » ne prouve rien.** Des flux répondent parfaitement avec des
  titres vieux d'une semaine. D'où le filtre de fraîcheur et la liste
  `stale_sources` : une source périmée est signalée, pas recopiée.
- **Un titre de presse peut ÊTRE un conseil d'investissement**
  (« 3 stocks to buy now »). Le bot n'en relaie aucun : `sentiment.is_advice`
  les écarte et on compte combien.

Aucune dépendance : `xml.etree` et `email.utils` de la stdlib, `httpx` (déjà
présent) pour le réseau, injecté en test.
"""
import time
import xml.etree.ElementTree as ET
from email.utils import parsedate_to_datetime
from typing import Any, Callable, Dict, List, Optional

from .sentiment import extract_themes, is_advice, is_offtopic, tone_counts

USER_AGENT = "Mozilla/5.0 (compatible; MarketPulse/1.0; +https://omenserver.org)"

# Flux retenus après sonde réelle. Trois italiens (la langue du lecteur), trois
# anglophones pour le contexte international, un institutionnel.
FEEDS = [
    {"name": "Il Sole 24 Ore", "lang": "it",
     "url": "https://www.ilsole24ore.com/rss/finanza--quotate-italia.xml"},
    {"name": "ANSA Economia", "lang": "it",
     "url": "https://www.ansa.it/sito/notizie/economia/economia_rss.xml"},
    {"name": "Google News (borsa)", "lang": "it",
     "url": "https://news.google.com/rss/search?q=borsa+when:1d&hl=it&gl=IT&ceid=IT:it"},
    {"name": "CNBC Mercati", "lang": "en",
     "url": "https://www.cnbc.com/id/15839135/device/rss/rss.html"},
    {"name": "CNBC Economia", "lang": "en",
     "url": "https://www.cnbc.com/id/10000664/device/rss/rss.html"},
    # ⚠️ NE PAS remplacer par `marketwatch/marketpulse/` : ce flux répond
    # 200 avec 30 items parfaitement valides… vieux de TREIZE MOIS (sondé le
    # 2026-07-28 : le plus récent avait 9 367 h). C'est le piège du flux
    # abandonné — seul le filtre de fraîcheur l'a démasqué. `topstories` est
    # vivant ; il charrie parfois une chronique de vie personnelle, c'est le
    # prix à payer et c'est moins grave qu'une source morte.
    {"name": "MarketWatch", "lang": "en",
     "url": "https://feeds.marketwatch.com/marketwatch/topstories/"},
    {"name": "BCE", "lang": "en",
     "url": "https://www.ecb.europa.eu/rss/press.html"},
]

_ATOM = "{http://www.w3.org/2005/Atom}"


def _text(node) -> str:
    return (node.text or "").strip() if node is not None else ""


def _epoch(raw: str) -> Optional[int]:
    """RFC 822 (« Tue, 28 Jul 2026 16:47:00 GMT », « ... +0200 ») ou ISO Atom."""
    raw = (raw or "").strip()
    if not raw:
        return None
    try:
        return int(parsedate_to_datetime(raw).timestamp())
    except (TypeError, ValueError, IndexError, OverflowError):
        pass
    try:
        from datetime import datetime
        return int(datetime.fromisoformat(raw.replace("Z", "+00:00")).timestamp())
    except (TypeError, ValueError):
        return None


def _strip_source_suffix(title: str, source_name: str) -> str:
    """Google News colle « - Nom du journal » à la fin de chaque titre.

    On ne coupe qu'au dernier tiret ET seulement si la queue ressemble à un nom
    de média (courte, sans ponctuation de phrase) — sinon on mutilerait un vrai
    titre qui contient un tiret.
    """
    if " - " not in title:
        return title
    head, tail = title.rsplit(" - ", 1)
    if head and len(tail) <= 40 and not tail.endswith((".", "?", "!")):
        return head.strip()
    return title


def parse_feed(data: Any, source: str, lang: str) -> List[Dict[str, Any]]:
    """RSS ou Atom → liste d'items. Ne lève jamais : un flux cassé rend []."""
    if not data:
        return []
    try:
        root = ET.fromstring(data)
    except ET.ParseError:
        return []

    nodes = root.findall(".//item") or root.findall(".//" + _ATOM + "entry")
    items = []
    for node in nodes:
        title = _text(node.find("title")) or _text(node.find(_ATOM + "title"))
        if not title:
            continue
        link = _text(node.find("link"))
        if not link:
            atom_link = node.find(_ATOM + "link")
            link = atom_link.get("href", "") if atom_link is not None else ""
        published = _epoch(_text(node.find("pubDate"))
                           or _text(node.find(_ATOM + "updated"))
                           or _text(node.find(_ATOM + "published")))
        # Un agrégateur porte le vrai éditeur dans <source>.
        real_source = _text(node.find("source")) or source
        items.append({
            "title": _strip_source_suffix(" ".join(title.split()), real_source),
            "source": real_source,
            "url": link,
            "published": published,
            "lang": lang,
        })
    return items


def _default_fetch(url: str) -> bytes:
    import httpx
    r = httpx.get(url, headers={"User-Agent": USER_AGENT}, timeout=20.0,
                  follow_redirects=True)
    r.raise_for_status()
    return r.content


def collect_news(fetch: Optional[Callable[[str], Any]] = None,
                 feeds: Optional[List[Dict[str, str]]] = None,
                 now_ts: Optional[int] = None,
                 max_age_h: float = 36.0,
                 per_source: int = 6,
                 max_items: int = 30,
                 pacing_s: float = 0.4,
                 sleep: Callable[[float], None] = time.sleep) -> Dict[str, Any]:
    """Agrège les flux en un payload prêt pour le rapport et le dashboard.

    Une source en panne n'invalide jamais les autres : elle part dans
    `sources_failed`, et le rapport le dit au lecteur.
    """
    fetch = fetch or _default_fetch
    feeds = FEEDS if feeds is None else feeds
    now_ts = int(now_ts if now_ts is not None else time.time())
    cutoff = now_ts - max_age_h * 3600.0

    ok, failed, stale, filtered, offtopic = [], [], [], 0, 0
    by_source = []      # une liste d'items PAR source, pour le partage équitable
    seen = set()

    for index, feed in enumerate(feeds):
        if index and pacing_s:
            sleep(pacing_s)      # low-and-slow : on ne martèle personne
        name = feed.get("name") or feed.get("url", "?")
        try:
            raw = fetch(feed["url"])
        except Exception as e:
            failed.append({"source": name, "error": "%s: %s" % (type(e).__name__, e)})
            continue
        ok.append(name)

        mine = []
        fresh_seen = False
        for item in parse_feed(raw, name, feed.get("lang", "it")):
            published = item.get("published")
            if published is not None and published < cutoff:
                continue
            fresh_seen = True
            if is_advice(item["title"]):
                filtered += 1
                continue
            if is_offtopic(item["title"]):
                offtopic += 1
                continue
            key = " ".join(item["title"].lower().split())
            if key in seen:
                continue
            seen.add(key)
            mine.append(item)
            if len(mine) >= per_source:
                break
        by_source.append(mine)
        if not fresh_seen:
            # Le flux a répondu mais n'a rien d'actuel : le signaler, sinon on
            # croirait à une source saine qui n'a « rien à dire ce matin ».
            stale.append(name)

    # Partage ÉQUITABLE avant de tronquer : une simple coupe par récence
    # effaçait la presse italienne, dont les dépêches sont horodatées plus tôt
    # que les fils américains — or c'est la langue du lecteur. On prend un
    # titre par source à tour de rôle, puis on ordonne le résultat.
    collected = []
    for rank in range(per_source):
        for items in by_source:
            if rank < len(items):
                collected.append(items[rank])
    collected = collected[:max_items]
    collected.sort(key=lambda i: i.get("published") or 0, reverse=True)

    return {
        "items": collected,
        "themes": extract_themes(collected),
        "tone": tone_counts(collected),
        "sources_ok": ok,
        "sources_failed": failed,
        "stale_sources": stale,
        "filtered_advice": filtered,
        "filtered_offtopic": offtopic,
        "generated_at": now_ts,
    }
