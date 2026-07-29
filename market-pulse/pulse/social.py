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
from typing import Any, Dict, List, Optional

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
