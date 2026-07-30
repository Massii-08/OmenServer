"""Collecteurs sociaux — Reddit, Bluesky et X. Parseurs PURS, aucune I/O.

Les trois routes ont été sondées et vérifiées à la main le 2026-07-29. Ce qui
suit n'est pas une supposition sur des formats : c'est ce que ces services
renvoient réellement.

**Reddit** — le `.json` rend 403 (même en curl_cffi, empreinte Chrome), mais le
flux Atom `.rss` d'un MULTIREDDIT rend jusqu'à 100 posts en UNE requête :

    https://www.reddit.com/r/investing+stocks+StockMarket/.rss?limit=100

Plafond mesuré : 1 requête / 60 s par IP. Notre usage — une requête par
ouverture de bourse — est trois ordres de grandeur en dessous.

**Bluesky** — httpx nu, sans compte. Deux formes à avaler : la recherche rend
`posts[]`, le fil d'un compte rend `feed[].post`.

⚠️ **La recherche est multilingue et n'a aucune notion de pays.** Mesuré : la
requête « borsa » rend **50 % de posts turcs** (« Borsa İstanbul », #xu100) —
le mot veut dire « bourse » en turc aussi. Les requêtes doivent être
DISCRIMINANTES : « piazza affari », « borsa milano », « ftse mib » rendent
0 % de bruit turc sur la même sonde. Une requête d'un seul mot commun est
presque toujours un piège.

**X** — `x.com/<handle>` rend les cinq derniers posts dans le HTML rendu côté
serveur. ⚠️ **Ce n'est PAS du JSON** : sérialisation Relay, **clés non
quotées**, horodatage `created_at_ms` en millisecondes. Chercher
`"full_text"` avec guillemets ne trouve RIEN — c'est l'erreur qui m'a coûté
trois essais, sur une page de 300 Ko qui contenait pourtant bien cinq posts.
"""
import html as _html
import json
import re
import xml.etree.ElementTree as ET
from typing import Any, Callable, Dict, List, Optional

_ATOM = "{http://www.w3.org/2005/Atom}"

# Sérialisation Relay : clés SANS guillemets. `display_text_range` vaut
# `$R[232]=[0,117]` — il CONTIENT une virgule, donc tout motif englobant en
# `[^,]*` casse. On extrait les deux champs séparément et on les apparie.
_X_TEXT = re.compile(r'full_text:"((?:[^"\\]|\\.)*)"')
_X_MS = re.compile(r'created_at_ms:(\d{13})')

# Au-delà de cette taille, une page sans le moindre post signifie que X a changé
# sa sérialisation — pas qu'il n'a rien publié.
_X_ALARM_SIZE = 100000


class XSerializationChanged(RuntimeError):
    """X répond 200 et une grosse page, mais on n'en extrait plus rien.

    Sans cette alarme, le briefing sortirait silencieusement vide — le pire des
    échecs, parce qu'il ressemble à « il n'y avait rien à dire ».
    """


def _txt(node) -> str:
    return (node.text or "").strip() if node is not None else ""


def _epoch_iso(raw: str) -> Optional[int]:
    from datetime import datetime
    if not raw:
        return None
    try:
        return int(datetime.fromisoformat(raw.replace("Z", "+00:00")).timestamp())
    except (TypeError, ValueError):
        return None


# --------------------------------------------------------------------------
# Reddit
# --------------------------------------------------------------------------

def parse_reddit(data: Any, lang: str = "en") -> List[Dict[str, Any]]:
    """Flux Atom d'un subreddit ou d'un multireddit → items au format news."""
    if not data:
        return []
    try:
        root = ET.fromstring(data)
    except ET.ParseError:
        return []
    out = []
    for entry in root.findall(".//" + _ATOM + "entry"):
        title = _txt(entry.find(_ATOM + "title"))
        if not title:
            continue
        link = entry.find(_ATOM + "link")
        # `category` porte le subreddit : sans lui, un multireddit devient une
        # bouillie où l'on ne sait plus quelle communauté a dit quoi.
        cat = entry.find(_ATOM + "category")
        sub = (cat.get("term") if cat is not None else "") or "?"
        out.append({
            "title": " ".join(title.split()),
            "source": "Reddit r/" + sub,
            "subreddit": sub,
            "url": link.get("href", "") if link is not None else "",
            "published": _epoch_iso(_txt(entry.find(_ATOM + "updated"))
                                    or _txt(entry.find(_ATOM + "published"))),
            "lang": lang,
        })
    return out


# --------------------------------------------------------------------------
# Bluesky
# --------------------------------------------------------------------------

def parse_bluesky(data: Any, source: str = "Bluesky",
                  lang: str = "en") -> List[Dict[str, Any]]:
    """Recherche (`posts[]`) ou fil d'un compte (`feed[].post`) → items news."""
    if not data:
        return []
    try:
        payload = json.loads(data if isinstance(data, (str, bytes)) else "{}")
    except ValueError:
        return []
    posts = payload.get("posts")
    if posts is None:
        posts = [f.get("post") for f in (payload.get("feed") or []) if f]
    out = []
    for post in (posts or []):
        if not post:
            continue
        record = post.get("record") or {}
        text = (record.get("text") or "").strip()
        if not text:
            continue
        handle = ((post.get("author") or {}).get("handle")) or ""
        uri = post.get("uri") or ""
        rkey = uri.rsplit("/", 1)[-1] if uri else ""
        url = ("https://bsky.app/profile/%s/post/%s" % (handle, rkey)) if handle and rkey else ""
        out.append({
            "title": " ".join(text.split()),
            "source": source,
            "author": handle,
            "url": url,
            "published": _epoch_iso(record.get("createdAt") or ""),
            "lang": lang,
        })
    return out


# --------------------------------------------------------------------------
# X
# --------------------------------------------------------------------------

def _x_clean(raw: str) -> str:
    s = raw.replace('\\/', '/').replace('\\"', '"').replace("\\n", " ")
    try:
        s = s.encode("utf-8").decode("unicode_escape").encode(
            "latin1", "ignore").decode("utf-8", "ignore")
    except (UnicodeDecodeError, UnicodeEncodeError):
        pass
    return " ".join(_html.unescape(s).split())


def parse_x(page: Any, handle: str, lang: str = "en") -> List[Dict[str, Any]]:
    """Posts d'un profil X depuis le HTML rendu côté serveur.

    Lève `XSerializationChanged` si la page est GROSSE mais ne rend aucun post :
    c'est le signal que le format a bougé, et il vaut mieux un run en erreur
    qu'un briefing vide qui a l'air normal.
    """
    if not page:
        return []
    stamps = [(m.start(), int(m.group(1))) for m in _X_MS.finditer(page)]
    out = []
    for m in _X_TEXT.finditer(page):
        text = _x_clean(m.group(1))
        if not text:
            continue
        # On apparie chaque texte au DERNIER horodatage qui le précède : les
        # champs intermédiaires varient et contiennent des virgules.
        before = [ts for pos, ts in stamps if pos < m.start()]
        out.append({
            "title": text,
            "source": "X @" + handle,
            "author": handle,
            "url": "https://x.com/" + handle,
            "published": int(before[-1] / 1000) if before else None,
            "lang": lang,
        })
    if not out and len(page) > _X_ALARM_SIZE:
        raise XSerializationChanged(
            "x.com/%s : page de %d octets sans aucun post — la sérialisation a "
            "probablement changé" % (handle, len(page)))
    # Le post ÉPINGLÉ casse l'ordre de la page : on trie, toujours.
    out.sort(key=lambda i: i.get("published") or 0, reverse=True)
    return out


# --------------------------------------------------------------------------
# Collecte — la couche qui allait chercher, et qui manquait
# --------------------------------------------------------------------------
#
# Les parseurs ci-dessus étaient écrits et testés, mais rien ne construisait les
# URL et `main.py` ne les appelait jamais : les quatre options `reddit`,
# `bluesky`, `x`, `x_account` de `prefs.json` ne faisaient RIEN. C'est le piège
# le plus coûteux du dépôt — un test qui injecte une dépendance ne prouve pas
# qu'on la branche. D'où, ici, des tests qui vérifient l'URL DEMANDÉE.

USER_AGENT = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
              "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36")

# Plafond de l'attente après un 429 : le run du matin ne doit jamais se
# suspendre parce qu'un serveur a répondu « reviens dans 27 heures ».
MAX_RETRY_WAIT_S = 60.0
DEFAULT_RETRY_WAIT_S = 5.0


def reddit_url(subs, limit: int = 100) -> str:
    """UNE requête pour tous les subs (multireddit).

    Plafond mesuré : 1 requête / 60 s / IP. Interroger les subs un par un
    prendrait un 429 dès le troisième ; le multireddit rend 100 posts d'un coup.
    """
    clean = [str(s).strip().lstrip("r/").strip("/") for s in (subs or ())]
    clean = [s for s in clean if s]
    if not clean:
        return ""
    return "https://www.reddit.com/r/%s/.rss?limit=%d" % ("+".join(clean), int(limit))


def bluesky_search_url(query: str, limit: int = 25) -> str:
    from urllib.parse import quote
    return ("https://api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=%s&limit=%d"
            % (quote(str(query or "")), int(limit)))


def bluesky_author_url(actor: str, limit: int = 20) -> str:
    from urllib.parse import quote
    return ("https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed"
            "?actor=%s&limit=%d" % (quote(str(actor or "")), int(limit)))


def x_url(handle: str) -> str:
    return "https://x.com/" + str(handle or "").lstrip("@").strip("/")


def _status_of(exc) -> Optional[int]:
    """Code HTTP porté par une exception de client, sans dépendre d'httpx.

    Le fetch est injecté ; on ne sait pas quelle bibliothèque l'appelant utilise.
    On regarde donc `exc.response.status_code` s'il existe — c'est la forme
    d'httpx comme de requests.
    """
    response = getattr(exc, "response", None)
    code = getattr(response, "status_code", None)
    try:
        return int(code) if code is not None else None
    except (TypeError, ValueError):
        return None


def _retry_wait(exc) -> float:
    """Combien attendre avant l'unique reprise, d'après le serveur lui-même."""
    response = getattr(exc, "response", None)
    headers = getattr(response, "headers", None) or {}
    raw = None
    for key in ("x-ratelimit-reset", "retry-after", "X-Ratelimit-Reset", "Retry-After"):
        try:
            raw = headers.get(key)
        except AttributeError:
            raw = None
        if raw:
            break
    try:
        wait = float(str(raw).strip())
    except (TypeError, ValueError):
        wait = DEFAULT_RETRY_WAIT_S
    if wait <= 0:
        wait = DEFAULT_RETRY_WAIT_S
    return min(wait + 1.0, MAX_RETRY_WAIT_S)


def _default_fetch(url: str):
    import httpx
    r = httpx.get(url, headers={"User-Agent": USER_AGENT}, timeout=20.0,
                  follow_redirects=True)
    r.raise_for_status()
    return r.content if "reddit.com" in url else r.text


def _fetch_once(fetch, url, sleep):
    """Un appel, **une** reprise sur 429, puis on abandonne.

    ⚠️ Jamais de boucle : un 429 qu'on provoque soi-même ne prouve rien, et
    marteler un service qui vient de dire non est la façon la plus sûre de se
    faire bloquer l'IP pour de bon.
    """
    try:
        return fetch(url)
    except Exception as first:
        if _status_of(first) != 429:
            raise
        sleep(_retry_wait(first))
        return fetch(url)


def collect_social(fetch: Optional[Callable[[str], Any]] = None,
                   subs=(), queries=(), authors=(), handles=(),
                   now_ts: Optional[int] = None,
                   max_age_h: float = 36.0,
                   per_source: int = 6,
                   max_items: int = 12,
                   reddit_limit: int = 100,
                   pacing_s: float = 0.4,
                   sleep: Optional[Callable[[float], None]] = None) -> Dict[str, Any]:
    """Posts sociaux, au MÊME contrat de sortie que `news.collect_news`.

    Une liste vide ne déclenche aucune requête : c'est la garantie que décocher
    une option dans `prefs.json` la coupe réellement.

    Ne lève jamais. Deux cas particuliers surveillés :
    - un **429** → une seule reprise, espacée de ce que le serveur demande ;
    - une **page X grosse et vide** → une ALARME remontée, parce qu'un briefing
      silencieusement vide est le pire des échecs (il a l'air normal).
    """
    import time as _time
    from .sentiment import is_advice, is_offtopic

    fetch = fetch or _default_fetch
    sleep = sleep or _time.sleep
    now_ts = int(now_ts if now_ts is not None else _time.time())
    cutoff = now_ts - float(max_age_h) * 3600.0

    jobs = []      # (nom de source, url, parseur)
    url = reddit_url(subs, reddit_limit)
    if url:
        jobs.append(("Reddit r/%s" % "+".join(subs), url,
                     lambda raw: parse_reddit(raw)))
    for query in (queries or ()):
        jobs.append(("Bluesky « %s »" % query, bluesky_search_url(query),
                     lambda raw, q=query: parse_bluesky(raw, "Bluesky « %s »" % q)))
    for actor in (authors or ()):
        jobs.append(("Bluesky @%s" % actor, bluesky_author_url(actor),
                     lambda raw, a=actor: parse_bluesky(raw, "Bluesky @%s" % a)))
    for handle in (handles or ()):
        clean = str(handle).lstrip("@")
        jobs.append(("X @%s" % clean, x_url(handle),
                     lambda raw, h=clean: parse_x(raw, h)))

    ok, failed, alarms = [], [], []
    filtered_advice, filtered_offtopic = 0, 0
    by_source, seen = [], set()

    for index, (name, target, parser) in enumerate(jobs):
        if index and pacing_s:
            sleep(pacing_s)
        try:
            raw = _fetch_once(fetch, target, sleep)
            items = parser(raw)
        except XSerializationChanged as e:
            # Surfacée, jamais avalée : c'est tout l'intérêt de l'alarme.
            alarms.append(str(e))
            failed.append({"source": name, "error": "XSerializationChanged"})
            continue
        except Exception as e:
            failed.append({"source": name, "error": "%s: %s" % (type(e).__name__, e)})
            continue
        ok.append(name)

        mine = []
        for item in items:
            published = item.get("published")
            if published is not None and published < cutoff:
                continue
            if is_advice(item["title"]):
                filtered_advice += 1
                continue
            if is_offtopic(item["title"]):
                filtered_offtopic += 1
                continue
            key = " ".join(item["title"].lower().split())
            if key in seen:
                continue
            seen.add(key)
            mine.append(item)
            if len(mine) >= per_source:
                break
        by_source.append(mine)

    # Partage équitable avant de tronquer — même geste que la presse : sinon un
    # sub bavard écraserait les autres sources.
    collected = []
    for rank in range(per_source):
        for items in by_source:
            if rank < len(items):
                collected.append(items[rank])
    collected.sort(key=lambda i: i.get("published") or 0, reverse=True)

    return {"items": collected[:max_items], "sources_ok": ok,
            "sources_failed": failed, "alarms": alarms,
            "filtered_advice": filtered_advice,
            "filtered_offtopic": filtered_offtopic,
            "generated_at": now_ts}
