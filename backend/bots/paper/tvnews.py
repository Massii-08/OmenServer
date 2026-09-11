"""Volet TradingView de la veille news — le flux du titre, à la minute.

Décision D3 de la spec (``docs/superpowers/specs/2026-09-09-tv-coach-extension-design.md``) :
les news TradingView **entrent dans la base**. Elles n'ouvrent pas un canal
d'alerte de plus — elles rejoignent exactement le flux d'événements que
``newswatch`` écrit déjà (mêmes clés, même fichier d'état par utilisateur),
donc la toile, la convergence, le calendrier et la fiche du titre les voient
sans qu'aucun de ces modules n'ait à connaître TradingView.

Pourquoi ce flux plutôt qu'un de plus : mesuré le 09/09, il répond **200 sans
cookie** depuis le Mac ET depuis l'Omen, il porte 20+ sources (Reuters, Dow
Jones, CNBC, Cointelegraph…), et sa fraîcheur mesurée est de 2-3 minutes sur le
flux global contre 7-9 minutes sur AAPL — là où le repli RSS Yahoo, lui, se
compte en dizaines de minutes. C'est le levier n°1 de vitesse (§7 de la spec).

Découpage PUR / I-O, même règle que ``newswatch`` :

  * **PUR** : ``parse_items``, ``parse_story``, ``to_events``, ``tv_to_yahoo``,
    ``yahoo_to_tv`` — zéro I/O, zéro horloge implicite, 100 % testable hors
    ligne sur les fixtures réelles de ``backend/bots/tests/fixtures/tvcoach/``.
  * **I-O** : ``fetch_items``/``fetch_story`` (le client HTTP est INJECTÉ —
    n'importe quel objet avec ``.get(url, headers=...)`` façon ``httpx``) et
    ``run`` (l'horloge et l'état sont injectés eux aussi).

Cadence et budget (§10 de la spec) : **une requête par symbole et par minute**
au plus (``MIN_INTERVAL_S``), **60 requêtes par cycle** toutes langues et tous
symboles confondus (``REQUEST_BUDGET``), corps de dépêche (``fetch_story``)
seulement pour les items ``urgency <= 2`` d'un titre **DÉTENU** dont le
fournisseur est dans ``CURATED_PROVIDERS``. Un 429 ou un 5xx rend une liste
vide et laisse une trace dans l'état ; il ne lève jamais.

⚠️ ``src`` et non ``source`` pour la convergence — les deux sont écrits, et ce
n'est pas un doublon. ``convergence._curated`` lit ``src`` et le compare à sa
liste PERMISSIVE ``CURATED_NEWS_SOURCES`` : une dépêche Reuters sur un titre
détenu doit pouvoir allumer ``held_risk`` (qui tire SEUL), donc elle porte
``src="news"`` — le même canal que la dépêche par-symbole du guetteur, ce
qu'elle est littéralement. Tout le reste du flux TradingView porte
``src="tradingview"``, absent de cette liste : ces dépêches comptent comme
facteurs ORDINAIRES et nourrissent ``cross_source``, mais ne réveillent
personne toutes seules. ``source="tradingview"`` reste écrit sur les deux, pour
que l'origine soit lisible dans la fiche et dans la toile.
"""
import json
import logging
import re
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional, Tuple

logger = logging.getLogger("omenserver")

# --------------------------------------------------------------------------- #
# Constantes de collecte (URL EXACTES sondées le 09/09 — cf. spec §3)
# --------------------------------------------------------------------------- #

NEWS_URL = ("https://news-mediator.tradingview.com/news-flow/v2/news"
            "?filter=lang:{lang}&filter=symbol:{tv_symbol}"
            "&client=web&streaming=false")

STORY_URL = "https://news-headlines.tradingview.com/v2/story?id={item_id}&lang={lang}"

TV_BASE = "https://www.tradingview.com"

# ``User-Agent`` EXPLICITE (doctrine du dépôt : on se nomme, on ne se déguise
# pas) et ``Origin`` que le médiateur attend.
HEADERS = {
    "User-Agent": "Mozilla/5.0 (OmenServer coach)",
    "Origin": TV_BASE,
}

# Les deux langues demandées par symbole : l'anglais porte les dépêches
# d'agence, le français ce que la presse francophone a repris. Le dédoublonnage
# par ``id`` fait le reste.
LANGS = ("en", "fr")

# Fournisseurs CURÉS — ceux dont une mauvaise nouvelle sur un titre DÉTENU a le
# droit de faire partir un digest à elle seule (facteur ``held_risk``, qui tire
# seul). Liste PERMISSIVE, comme ``convergence.CURATED_NEWS_SOURCES`` : un
# fournisseur ajouté demain n'hérite pas de ce droit, il faut l'inscrire ici.
CURATED_PROVIDERS = frozenset({"reuters", "dow-jones", "cnbctv", "awp", "afp"})

# Un corps de dépêche ne se charge que pour les items URGENTS. Le flux met 1
# (flash) ou 2 (dépêche) ; au-delà c'est du commentaire.
MAX_URGENCY_FOR_STORY = 2

# Plancher entre deux appels pour LE MÊME symbole (§7 : « 60 s par titre suivi »).
MIN_INTERVAL_S = 60.0

# Budget dur d'un cycle, toutes requêtes confondues (listes + corps).
REQUEST_BUDGET = 60

# Fenêtre glissante des identifiants déjà vus. 2000 ≈ dix symboles suivis
# pendant une journée : assez pour ne jamais rejouer une dépêche, assez petit
# pour que l'état reste lisible.
SEEN_MAX = 2000

# Un corps de dépêche sert de CONTEXTE, pas d'article : au-delà, on tronque.
STORY_MAX_LEN = 1200

# Le CACHE par symbole (11/09). ``seen_ids`` sert les ALERTES : un item vu une
# fois n'est plus jamais réémis, et s'il a été vu pendant que personne ne
# regardait ce titre, il n'entre dans le carnet de personne. La FICHE, elle,
# doit montrer « ce que TradingView affiche », pas « ce qui est neuf » — d'où
# ce second rangement, par symbole, jamais filtré par ``seen_ids``.
SYMBOL_ITEMS_MAX = 15

# Combien de symboles gardent leur cache. L'état global est un fichier qu'on
# relit à chaque cycle : sans borne, il grossirait à la taille de toutes les
# watchlists de tous les comptes.
SYMBOL_CACHE_MAX = 60

# ``yahoo_to_tv`` préfixe tout ticker américain nu en ``NASDAQ:`` — un pari, pas
# une certitude : Suncor et Everest sont au NYSE, et TradingView répond 422.
# On essaie alors les autres places, UNE fois, et on retient celle qui répond.
US_FALLBACK_EXCHANGES = ("NASDAQ", "NYSE", "AMEX")

# Un symbole qu'aucune place ne connaît est mis au placard 24 h : le réessayer
# à chaque cycle coûtait 4 requêtes du budget par passage, pour rien.
UNKNOWN_TTL_S = 86400.0

# Le statut que TradingView rend pour un ``EXCHANGE:TICKER`` qu'il ne connaît
# pas. Ce n'est PAS une panne : le compteur d'anomalies doit l'ignorer, sans
# quoi il ne veut plus rien dire (228 « erreurs » relevées le 11/09).
UNKNOWN_SYMBOL_STATUS = 422


# --------------------------------------------------------------------------- #
# PUR — petits utilitaires
# --------------------------------------------------------------------------- #

def _text(value: Any) -> str:
    """Texte compacté (espaces normalisés). ``None`` -> chaîne vide."""
    return " ".join(str(value if value is not None else "").split())


def _int(value: Any) -> Optional[int]:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _iso_utc(value: Any) -> Optional[str]:
    """Horodatage TradingView -> ISO UTC. ``None`` si illisible.

    Le flux écrit un epoch en SECONDES (mesuré : ``1788976046``). Un epoch en
    millisecondes est toléré (le seuil ``1e11`` sépare les deux sans ambiguïté
    jusqu'en l'an 5138), une chaîne ISO aussi — mais **rien n'est inventé** :
    un champ absent rend ``None``, et l'item est jeté par ``parse_items``.
    """
    if value is None or value == "":
        return None
    if isinstance(value, str):
        raw = value.strip()
        if not raw:
            return None
        try:
            moment = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except ValueError:
            return None
        if moment.tzinfo is None:
            moment = moment.replace(tzinfo=timezone.utc)
        return moment.astimezone(timezone.utc).isoformat()
    try:
        seconds = float(value)
    except (TypeError, ValueError):
        return None
    if seconds > 1e11:            # millisecondes
        seconds = seconds / 1000.0
    try:
        return datetime.fromtimestamp(seconds, timezone.utc).isoformat()
    except (OverflowError, OSError, ValueError):
        return None


def _provider_id(raw: Any) -> str:
    """L'identifiant du fournisseur, que le flux l'écrive en objet
    (``{"id": "reuters", ...}``, forme de ``/news``) ou en chaîne (forme de
    ``/story``)."""
    if isinstance(raw, dict):
        return _text(raw.get("id")).lower()
    return _text(raw).lower()


# --------------------------------------------------------------------------- #
# PUR — le pont TradingView <-> Yahoo
# --------------------------------------------------------------------------- #

# Places dont le ticker Yahoo est le ticker nu.
_US_EXCHANGES = frozenset({
    "NASDAQ", "NYSE", "BATS", "AMEX", "ARCA", "OTC", "NYSEARCA", "CBOE",
    "SP", "DJ", "NASDAQOTH",
})

# Places dont le ticker Yahoo porte un suffixe.
_SUFFIX_EXCHANGES = {
    "SIX": ".SW", "BX": ".SW",
    "XETR": ".DE", "FWB": ".DE", "GETTEX": ".DE", "TRADEGATE": ".DE",
    "EURONEXT": ".PA", "EPA": ".PA",
    "LSE": ".L",
    "MIL": ".MI",
    "BME": ".MC",
    "TSX": ".TO",
    "OMXSTO": ".ST",
}

_CRYPTO_EXCHANGES = frozenset({
    "BITSTAMP", "BINANCE", "KRAKEN", "COINBASE", "CRYPTO", "BITFINEX",
    "BYBIT", "OKX", "GEMINI",
})

_FX_EXCHANGES = frozenset({"FX", "OANDA", "FX_IDC", "FOREXCOM", "SAXO"})

_TVC_MAP = {
    "UKOIL": "BZ=F", "USOIL": "CL=F", "GOLD": "GC=F", "SILVER": "SI=F",
    "NATGAS": "NG=F",
}

_CRYPTO_QUOTES = ("USDT", "USDC", "USD")

# Table INVERSE minimale (Yahoo -> TradingView), pour aller chercher le flux
# d'un symbole que l'Omen connaît déjà. Volontairement courte : un symbole
# absent d'ici rend ``None`` plutôt qu'une place inventée — interroger le flux
# d'un `EXCHANGE:TICKER` qui n'existe pas ne rend rien et coûte une requête.
_YAHOO_TO_TV = {
    "BTC-USD": "BITSTAMP:BTCUSD",
    "ETH-USD": "BITSTAMP:ETHUSD",
    "SOL-USD": "COINBASE:SOLUSD",
    "XRP-USD": "BITSTAMP:XRPUSD",
    "NESN.SW": "SIX:NESN",
    "ROG.SW": "SIX:ROG",
    "NOVN.SW": "SIX:NOVN",
    "UBSG.SW": "SIX:UBSG",
    "SAP.DE": "XETR:SAP",
    "MC.PA": "EURONEXT:MC",
    "AIR.PA": "EURONEXT:AIR",
    "SHEL.L": "LSE:SHEL",
    "ENI.MI": "MIL:ENI",
    "EURUSD=X": "FX:EURUSD",
    "BZ=F": "TVC:UKOIL",
    "CL=F": "TVC:USOIL",
    "GC=F": "TVC:GOLD",
}

_PLAIN_TICKER_RE = re.compile(r"^[A-Z][A-Z0-9.\-]{0,9}$")


def _split_tv(tv_symbol: Any) -> Optional[Tuple[str, str]]:
    """``EXCHANGE:TICKER`` -> ``(EXCHANGE, TICKER)`` en majuscules, suffixe
    perpétuel ``.P`` retiré. ``None`` si la forme n'y est pas."""
    raw = _text(tv_symbol).upper()
    if ":" not in raw:
        return None
    exchange, _, ticker = raw.partition(":")
    exchange = exchange.strip()
    ticker = ticker.strip()
    if ticker.endswith(".P"):
        ticker = ticker[:-2]
    if not exchange or not ticker:
        return None
    return exchange, ticker


def _fallback_tv_to_yahoo(tv_symbol: Any) -> Optional[str]:
    """Repli LOCAL du mapping TradingView -> Yahoo.

    La table de référence vit dans ``brief.tv_to_yahoo`` (lot A/B, testée à
    l'identique côté extension). Ce repli existe pour que ce module reste
    autonome — et testable — quand ``brief`` n'est pas encore là ; il couvre
    les places réellement rencontrées dans les fixtures du 09/09, pas plus.
    """
    parts = _split_tv(tv_symbol)
    if parts is None:
        return None
    exchange, ticker = parts
    if exchange in _US_EXCHANGES:
        return ticker
    if exchange in _SUFFIX_EXCHANGES:
        return ticker + _SUFFIX_EXCHANGES[exchange]
    if exchange in _CRYPTO_EXCHANGES:
        base = ticker
        for quote in _CRYPTO_QUOTES:
            if base.endswith(quote) and len(base) > len(quote):
                base = base[:-len(quote)]
                break
        else:
            return None
        if base == "XBT":
            base = "BTC"
        return base + "-USD"
    if exchange in _FX_EXCHANGES:
        if len(ticker) == 6 and ticker.isalpha():
            return ticker + "=X"
        return None
    if exchange == "TVC":
        return _TVC_MAP.get(ticker)
    if exchange == "CME" and ticker.rstrip("!0123456789") == "BTC":
        return "BTC=F"
    return None


def tv_to_yahoo(tv_symbol: Any) -> Optional[str]:
    """Symbole TradingView -> symbole Yahoo canonique, ou ``None``.

    Délègue à ``brief.tv_to_yahoo`` (la table de référence du lot A/B) par un
    import PARESSEUX dans un ``try`` : le module peut ne pas exister encore, ou
    lever à l'import. Dans ce cas — et seulement dans ce cas — on retombe sur
    ``_fallback_tv_to_yahoo``. Jamais d'exception, jamais un symbole inventé.
    """
    try:
        from backend.bots.paper.brief import tv_to_yahoo as _mapper
    except Exception:             # noqa: BLE001 — lot A/B pas encore là
        _mapper = None
    if _mapper is not None:
        try:
            mapped = _mapper(tv_symbol)
        except Exception:         # noqa: BLE001 — une table cassée ne casse rien
            mapped = None
        if mapped:
            return _text(mapped)
    return _fallback_tv_to_yahoo(tv_symbol)


def yahoo_to_tv(symbol: Any) -> Optional[str]:
    """Symbole Yahoo -> symbole TradingView interrogeable, ou ``None``.

    Table inverse explicite d'abord ; un ticker NU (sans suffixe de place,
    donc américain) est ensuite préfixé ``NASDAQ:``. Tout le reste rend
    ``None`` : demander le flux d'un symbole qui n'existe pas coûte une requête
    du budget et ne rend rien.
    """
    raw = _text(symbol).upper()
    if not raw:
        return None
    if raw in _YAHOO_TO_TV:
        return _YAHOO_TO_TV[raw]
    if any(ch in raw for ch in ".-=^"):
        return None
    if not _PLAIN_TICKER_RE.match(raw):
        return None
    return "NASDAQ:" + raw


# --------------------------------------------------------------------------- #
# PUR — parseurs
# --------------------------------------------------------------------------- #

def parse_items(payload: Any, tv_symbol: Any) -> List[Dict[str, Any]]:
    """Charge utile du flux -> liste d'items à la forme COMPLÈTE et stable ::

        {"id", "title", "published" (ISO UTC), "provider", "urgency",
         "story_path", "related" [EXCHANGE:TICKER, ...], "tv_symbol",
         "symbol" (Yahoo|None), "url"}

    Un item sans ``title`` ou sans ``published`` est **jeté** : sans l'un on ne
    peut rien afficher, sans l'autre on ne peut pas dire quand — et une news
    sans date, dans ce dépôt, c'est une date inventée qui attend son heure.
    Déduplication par ``id`` (le flux répète des dépêches d'un appel à l'autre).

    ``symbol`` est celui du PREMIER ``relatedSymbols`` mappable, et à défaut
    celui du symbole demandé — jamais un symbole deviné à partir du titre.
    """
    if isinstance(payload, dict):
        raw_items = payload.get("items")
    else:
        raw_items = payload
    if not isinstance(raw_items, (list, tuple)):
        return []

    wanted = _text(tv_symbol).upper()
    out: List[Dict[str, Any]] = []
    seen = set()
    for raw in raw_items:
        if not isinstance(raw, dict):
            continue
        title = _text(raw.get("title"))
        published = _iso_utc(raw.get("published"))
        if not title or not published:
            continue
        item_id = _text(raw.get("id"))
        marker = item_id or ("%s|%s" % (published, title))
        if marker in seen:
            continue
        seen.add(marker)

        related = []
        for entry in raw.get("relatedSymbols") or []:
            if isinstance(entry, dict):
                sym = _text(entry.get("symbol")).upper()
            else:
                sym = _text(entry).upper()
            if sym and sym not in related:
                related.append(sym)

        symbol = None
        for candidate in related + ([wanted] if wanted else []):
            symbol = tv_to_yahoo(candidate)
            if symbol:
                break

        story_path = _text(raw.get("storyPath"))
        url = (TV_BASE + story_path) if story_path else _text(raw.get("link"))

        out.append({
            "id": item_id,
            "title": title,
            "published": published,
            "provider": _provider_id(raw.get("provider")),
            "urgency": _int(raw.get("urgency")),
            "story_path": story_path,
            "related": related,
            "tv_symbol": wanted,
            "symbol": symbol,
            "url": url,
        })
    return out


# --------------------------------------------------------------------------- #
# PUR — le cache par symbole (« ce que TradingView affiche »)
# --------------------------------------------------------------------------- #

# Les seules clés gardées en cache : de quoi peindre une ligne de fiche, rien
# de plus. Ni ``related``, ni ``story_path`` — l'état global est relu à chaque
# cycle, chaque octet s'y paie.
CACHE_KEYS = ("id", "title", "published", "provider", "url", "lang",
              "symbol", "tv_symbol", "urgency")


def cache_row(item: Any, lang: Any = None) -> Optional[Dict[str, Any]]:
    """Un item de :func:`parse_items` -> la ligne de cache, ou ``None``.

    ``lang`` est ajouté ici parce que le flux ne le porte pas : c'est nous qui
    savons dans quelle langue on vient de le demander.
    """
    if not isinstance(item, dict):
        return None
    title = _text(item.get("title"))
    published = _text(item.get("published"))
    if not title or not published:
        return None
    return {
        "id": _text(item.get("id")),
        "title": title,
        "published": published,
        "provider": _text(item.get("provider")),
        "url": _text(item.get("url")),
        "lang": _text(lang) or None,
        "symbol": item.get("symbol") or None,
        "tv_symbol": _text(item.get("tv_symbol")) or None,
        "urgency": _int(item.get("urgency")),
    }


def merge_symbol_items(existing: Any, fresh: Any,
                       limit: int = SYMBOL_ITEMS_MAX) -> List[Dict[str, Any]]:
    """Cache d'un symbole + lecture fraîche -> la liste gardée (PURE).

    Dédup par ``id`` (à défaut l'``url``, à défaut date+titre) : **la dernière
    ligne lue gagne**. Donc le frais écrase l'ancien, et la dernière langue de
    :data:`LANGS` écrase la première — le français, celui que le panneau de
    Massii affiche. Tri par ``published`` DÉCROISSANT, coupe à ``limit``.

    Le tri est lexicographique et c'est volontaire : ``_iso_utc`` normalise
    TOUT en UTC ``+00:00``, donc l'ordre des chaînes est l'ordre du temps —
    sans reparser quinze dates à chaque cycle.

    Une ligne sans titre ou sans date est jetée (même règle que
    :func:`parse_items` : on n'affiche pas une dépêche qu'on ne sait pas dater).
    """
    try:
        cap = max(0, int(limit))
    except (TypeError, ValueError):
        cap = SYMBOL_ITEMS_MAX

    by_marker: Dict[str, Dict[str, Any]] = {}
    for source in (existing, fresh):          # l'ordre de LECTURE
        if not isinstance(source, (list, tuple)):
            continue
        for row in source:
            if not isinstance(row, dict):
                continue
            title = _text(row.get("title"))
            published = _text(row.get("published"))
            if not title or not published:
                continue
            marker = (_text(row.get("id")) or _text(row.get("url"))
                      or ("%s|%s" % (published, title)))
            by_marker[marker] = row

    out = sorted(by_marker.values(),
                 key=lambda row: _text(row.get("published")), reverse=True)
    return out[:cap]


def _ast_text(node: Any, chunks: List[str]) -> None:
    """Aplatit récursivement l'arbre ``astDescription`` en morceaux de texte."""
    if isinstance(node, str):
        text = node.strip()
        if text:
            chunks.append(text)
        return
    if isinstance(node, dict):
        for child in node.get("children") or []:
            _ast_text(child, chunks)
        return
    if isinstance(node, (list, tuple)):
        for child in node:
            _ast_text(child, chunks)


def parse_story(payload: Any) -> Optional[str]:
    """Corps d'une dépêche -> texte plat tronqué à ``STORY_MAX_LEN``, ou
    ``None``.

    ``shortDescription`` d'abord (c'est le résumé du fournisseur) ; à défaut,
    l'arbre ``astDescription`` aplati. Rien d'exploitable -> ``None``, jamais
    une chaîne vide qu'un appelant prendrait pour un corps.
    """
    if not isinstance(payload, dict):
        return None
    short = _text(payload.get("shortDescription"))
    if short:
        return short[:STORY_MAX_LEN]
    chunks: List[str] = []
    _ast_text(payload.get("astDescription"), chunks)
    body = _text(" ".join(chunks))
    return body[:STORY_MAX_LEN] if body else None


def to_events(items: Any, held: Any = None,
              bodies: Optional[Dict[str, str]] = None) -> List[Dict[str, Any]]:
    """Items -> événements à la forme de ``newswatch`` (PUR).

    Chaque événement porte ::

        {"ts", "symbol", "title", "link", "sentiment", "source": "tradingview",
         "src", "provider", "curated", "muted": True, "story", "body"?}

    * ``sentiment`` vient de ``newswatch.classify`` (le classifieur du dépôt,
      importé et non recopié) ; un titre neutre garde ``NEUTRAL_SENTIMENT`` —
      il compte pour la toile, jamais pour un facteur.
    * ``symbol`` : celui de l'item ; à défaut, celui que ``crypto_symbol``
      reconnaît dans un titre CRYPTO (``is_crypto_topic``). Sinon ``None`` —
      un événement mal étiqueté polluerait le facteur « titre détenu ».
    * ``curated`` (et donc ``src="news"``, cf. tête de fichier) : fournisseur
      curé ET urgence ``<= MAX_URGENCY_FOR_STORY`` ET titre DÉTENU.
    * ``muted: True`` toujours : ce volet n'envoie RIEN sur Telegram. Il
      nourrit la base, la fiche et le push WebSocket — la parole reste à la
      convergence.
    """
    try:
        from backend.bots.paper import newswatch as _nw
    except Exception:             # noqa: BLE001 — jamais fatal
        _nw = None

    held_upper = {_text(s).upper() for s in (held or []) if _text(s)}
    bodies = bodies or {}

    out: List[Dict[str, Any]] = []
    for item in items or []:
        if not isinstance(item, dict):
            continue
        title = _text(item.get("title"))
        if not title:
            continue
        symbol = item.get("symbol") or None
        sentiment = None
        story = ""
        if _nw is not None:
            try:
                sentiment = _nw.classify(title)
                if not symbol and _nw.is_crypto_topic(title):
                    symbol = _nw.crypto_symbol(title)
                story = _nw.story_key(title)
            except Exception:     # noqa: BLE001 — classifieur en panne
                sentiment = None
        if sentiment is None:
            sentiment = getattr(_nw, "NEUTRAL_SENTIMENT", "neutral") if _nw else "neutral"

        provider = _text(item.get("provider")).lower()
        urgency = _int(item.get("urgency"))
        curated = bool(
            provider in CURATED_PROVIDERS
            and urgency is not None and urgency <= MAX_URGENCY_FOR_STORY
            and symbol and _text(symbol).upper() in held_upper
        )
        event = {
            "ts": item.get("published"),
            "symbol": symbol,
            "title": title,
            "link": _text(item.get("url")),
            "sentiment": sentiment,
            "source": "tradingview",
            "src": "news" if curated else "tradingview",
            "provider": provider,
            "curated": curated,
            "muted": True,
            "story": story,
        }
        body = bodies.get(_text(item.get("id")))
        if body:
            event["body"] = body
        out.append(event)
    return out


def needs_story(item: Any, held: Any = None) -> bool:
    """Faut-il charger le CORPS de cet item ? (PUR.)

    Trois conditions, et il faut les trois : urgence ``<= 2``, fournisseur
    curé, titre DÉTENU. C'est la règle §7 de la spec — le corps coûte une
    requête du budget, il ne se paie que pour ce qui peut faire vendre.
    """
    if not isinstance(item, dict):
        return False
    urgency = _int(item.get("urgency"))
    if urgency is None or urgency > MAX_URGENCY_FOR_STORY:
        return False
    if _text(item.get("provider")).lower() not in CURATED_PROVIDERS:
        return False
    symbol = _text(item.get("symbol")).upper()
    if not symbol:
        return False
    held_upper = {_text(s).upper() for s in (held or []) if _text(s)}
    return symbol in held_upper


# --------------------------------------------------------------------------- #
# I-O — le client HTTP est TOUJOURS injecté
# --------------------------------------------------------------------------- #

def _get_json_status(client: Any, url: str) -> Tuple[Optional[Any], int]:
    """``client.get(url, headers=HEADERS)`` -> ``(JSON|None, statut HTTP)``.

    Tolère les deux formes de réponse rencontrées : un objet façon ``httpx``
    (``.status_code`` + ``.json()``/``.text``) et un simple dict déjà décodé
    (ce que rend un client de test minimal). Un statut != 200 (429 compris),
    un corps illisible ou une exception réseau rendent ``None`` — jamais une
    exception vers l'appelant.

    Le STATUT est rendu parce que ``run`` en a besoin pour distinguer « le flux
    est tombé » (une anomalie) de « TradingView ne connaît pas ce symbole »
    (:data:`UNKNOWN_SYMBOL_STATUS`, qui n'en est pas une). Une exception réseau
    rend ``0`` : il n'y a pas eu de statut du tout.
    """
    try:
        response = client.get(url, headers=dict(HEADERS))
    except Exception as exc:      # noqa: BLE001 — réseau/TLS/HTTP
        logger.warning("paper tvnews: appel échoué (%s)", type(exc).__name__)
        return None, 0
    if isinstance(response, (dict, list)):
        return response, 200
    status = getattr(response, "status_code", 200)
    try:
        status = int(status)
    except (TypeError, ValueError):
        status = 200
    if status != 200:
        # Un symbole inconnu n'a rien d'alarmant une fois qu'il est traité
        # (place mémorisée ou mis au placard) : il ne mérite pas un warning
        # par cycle dans le journal.
        if status == UNKNOWN_SYMBOL_STATUS:
            logger.debug("paper tvnews: symbole refusé (%s)", url)
        else:
            logger.warning("paper tvnews: statut %s", status)
        return None, status
    getter = getattr(response, "json", None)
    if callable(getter):
        try:
            return getter(), status
        except Exception:         # noqa: BLE001 — JSON cassé
            return None, status
    text = getattr(response, "text", None)
    if isinstance(text, str):
        try:
            return json.loads(text), status
        except ValueError:
            return None, status
    return None, status


def _get_json(client: Any, url: str) -> Optional[Any]:
    """Le JSON seul (``None`` en panne) — pour qui se moque du statut."""
    return _get_json_status(client, url)[0]


def _fetch_items_raw(client: Any, tv_symbol: str,
                     lang: str = "en") -> Tuple[List[Dict[str, Any]], bool, int]:
    """``(items, transport_ok, statut)``.

    ``transport_ok`` distingue « le flux n'a rien de neuf » de « le flux n'a
    pas répondu » : sans lui, ``run`` compterait une anomalie chaque fois qu'un
    titre discret ne fait parler de lui — et le drapeau d'erreur de l'état ne
    voudrait plus rien dire. Le ``statut`` va plus loin : il sépare la panne du
    symbole INCONNU (:data:`UNKNOWN_SYMBOL_STATUS`).
    """
    url = NEWS_URL.format(lang=_text(lang) or "en", tv_symbol=_text(tv_symbol))
    payload, status = _get_json_status(client, url)
    if payload is None:
        return [], False, status
    return parse_items(payload, tv_symbol), True, status


def fetch_items(client: Any, tv_symbol: str, lang: str = "en") -> List[Dict[str, Any]]:
    """Le flux d'un symbole dans une langue -> items parsés (``[]`` en panne)."""
    return _fetch_items_raw(client, tv_symbol, lang)[0]


def fetch_story(client: Any, item_id: str, lang: str = "en") -> Optional[str]:
    """Le corps d'une dépêche -> texte tronqué, ou ``None`` (panne comprise)."""
    ident = _text(item_id)
    if not ident:
        return None
    url = STORY_URL.format(item_id=ident, lang=_text(lang) or "en")
    payload = _get_json(client, url)
    if payload is None:
        return None
    return parse_story(payload)


# --------------------------------------------------------------------------- #
# Le cycle
# --------------------------------------------------------------------------- #

def _default_state() -> Dict[str, Any]:
    """Le sous-état ``tv_news`` tel qu'il est sur le disque (copie).

    Import PARESSEUX de ``newswatch`` dans un ``try``, comme ``tv_to_yahoo``
    fait pour ``brief`` : ce module doit rester lisible même si la veille n'est
    pas là (tests unitaires, import circulaire).
    """
    try:
        from backend.bots.paper import newswatch
        return newswatch.tv_news_state()
    except Exception:             # noqa: BLE001 — veille absente ou cassée
        return {}


def _cache_of(state: Any) -> Dict[str, Any]:
    if not isinstance(state, dict):
        return {}
    cache = state.get("items_by_symbol")
    return cache if isinstance(cache, dict) else {}


def cached_items(tv_symbol: Any, state: Any = None,
                 limit: int = 10) -> List[Dict[str, Any]]:
    """Les dernières dépêches que TradingView affiche pour CE symbole.

    ``state`` : le sous-état ``tv_news`` (injectable) ; à défaut celui du
    fichier global de ``newswatch``. ``[]`` si le symbole n'a jamais été
    scanné — et **jamais** d'exception : la fiche du titre ne tombe pas parce
    qu'un cache manque.

    Ce que cette fonction rend N'EST PAS filtré par ``seen_ids``. C'est tout
    son intérêt : la dédup globale sert les alertes, elle a fait disparaître
    de la fiche une dépêche que TradingView montrait encore (11/09).

    Le symbole est cherché tel quel, puis par le DÉTOUR YAHOO
    (``BINANCE:BTCUSDT.P`` -> ``BTC-USD`` -> ``BITSTAMP:BTCUSD``) : l'extension
    affiche la place que Massii a choisie, le cycle range sous celle de la
    table inverse, et les deux n'ont aucune raison d'être la même.
    """
    try:
        cap = max(0, int(limit))
    except (TypeError, ValueError):
        cap = 10
    try:
        cache = _cache_of(state if state is not None else _default_state())
        if not cache:
            return []
        wanted = _text(tv_symbol).upper()
        keys = [wanted] if wanted else []
        alias = yahoo_to_tv(tv_to_yahoo(wanted)) if wanted else None
        if alias and alias not in keys:
            keys.append(alias)
        for key in keys:
            entry = cache.get(key)
            rows = entry.get("items") if isinstance(entry, dict) else None
            if isinstance(rows, list) and rows:
                return [row for row in rows if isinstance(row, dict)][:cap]
    except Exception:             # noqa: BLE001 — un cache n'est jamais fatal
        logger.debug("paper tvnews: cache illisible")
    return []


def _remember_items(state: Dict[str, Any], tv_symbol: str,
                    fresh: List[Dict[str, Any]], now_dt: datetime) -> None:
    """Range la lecture fraîche d'un symbole dans le cache, EN PLACE."""
    cache = state.get("items_by_symbol")
    if not isinstance(cache, dict):
        cache = {}
        state["items_by_symbol"] = cache
    entry = cache.get(tv_symbol)
    existing = entry.get("items") if isinstance(entry, dict) else None
    cache[tv_symbol] = {"fetched_at": now_dt.isoformat(),
                        "items": merge_symbol_items(existing, fresh)}
    if len(cache) > SYMBOL_CACHE_MAX:
        # On jette les symboles les plus anciennement lus : ce sont ceux que
        # plus personne ne regarde.
        stale = sorted(cache.items(),
                       key=lambda kv: _text((kv[1] or {}).get("fetched_at")))
        for key, _ in stale[:len(cache) - SYMBOL_CACHE_MAX]:
            cache.pop(key, None)


def _now_dt(now: Any = None) -> datetime:
    if isinstance(now, datetime):
        return now if now.tzinfo else now.replace(tzinfo=timezone.utc)
    return datetime.now(timezone.utc)


def _seconds_since(state_iso: Any, now_dt: datetime) -> Optional[float]:
    """Secondes écoulées depuis un horodatage d'état. Illisible -> ``None``
    (donc « jamais interrogé », donc on interroge)."""
    if not state_iso:
        return None
    try:
        last = datetime.fromisoformat(str(state_iso))
    except (TypeError, ValueError):
        return None
    if last.tzinfo is None:
        last = last.replace(tzinfo=timezone.utc)
    delta = (now_dt - last).total_seconds()
    return delta if delta >= 0 else None      # horloge en arrière -> on réessaie


def _is_us_fallback(symbol: str, tv_symbol: str) -> bool:
    """Vrai si ``tv_symbol`` est le PARI ``NASDAQ:`` de :func:`yahoo_to_tv`.

    Un symbole de la table inverse (``BTC-USD`` -> ``BITSTAMP:BTCUSD``) n'est
    pas un pari : lui chercher une place américaine n'aurait aucun sens.
    """
    return (symbol not in _YAHOO_TO_TV
            and tv_symbol == US_FALLBACK_EXCHANGES[0] + ":" + symbol)


def _alt_us_symbols(symbol: str, tv_symbol: str) -> List[str]:
    """Les autres places américaines à essayer pour ce ticker, ou ``[]``."""
    if not _is_us_fallback(symbol, tv_symbol):
        return []
    return [exchange + ":" + symbol for exchange in US_FALLBACK_EXCHANGES
            if exchange + ":" + symbol != tv_symbol]


def _tv_for(symbol: str, state: Dict[str, Any]) -> Optional[str]:
    """Le ``EXCHANGE:TICKER`` à interroger : la place MÉMORISÉE d'abord."""
    memo = state.get("exchange_of")
    if isinstance(memo, dict):
        known = _text(memo.get(symbol)).upper()
        if known:
            return known
    return yahoo_to_tv(symbol)


def _is_unknown(state: Dict[str, Any], symbol: str, now_dt: datetime) -> bool:
    """Ce symbole est-il au placard ? (Et l'en sortir quand le délai est
    passé, ou quand l'entrée est illisible.)"""
    memo = state.get("unknown")
    if not isinstance(memo, dict):
        return False
    elapsed = _seconds_since(memo.get(symbol), now_dt)
    if elapsed is not None and elapsed < UNKNOWN_TTL_S:
        return True
    memo.pop(symbol, None)
    return False


def _targets(username_symbols: Any, focus: Any) -> List[Tuple[str, Optional[str]]]:
    """Les symboles Yahoo à scanner, dans l'ordre : positions/watchlist de
    chaque compte, puis les symboles en FOCUS (§7, levier n°3).

    Rend une liste ``(symbole, username_du_focus_ou_None)`` dédupliquée : le
    second membre dit à qui pousser la news en direct sur le WebSocket.
    """
    focus_map: Dict[str, str] = {}
    if isinstance(focus, dict):
        for username, symbol in focus.items():
            sym = _text(symbol).upper()
            if sym:
                focus_map[sym] = _text(username)
    elif _text(focus):
        focus_map[_text(focus).upper()] = ""

    out: List[Tuple[str, Optional[str]]] = []
    seen = set()
    for symbols in (username_symbols or {}).values():
        for symbol in symbols or []:
            sym = _text(symbol).upper()
            if sym and sym not in seen:
                seen.add(sym)
                out.append((sym, focus_map.get(sym) or None))
    for sym, username in focus_map.items():
        if sym not in seen:
            seen.add(sym)
            out.append((sym, username or None))
    return out


def run(username_symbols: Any = None,
        focus: Any = None,
        client: Any = None,
        state: Any = None,
        now: Any = None,
        held: Any = None,
        emit: Optional[Callable[..., Any]] = None,
        budget: int = REQUEST_BUDGET,
        langs: Any = LANGS) -> List[Dict[str, Any]]:
    """Un passage du volet TradingView -> les événements NOUVEAUX.

    ``username_symbols`` : ``{username: [symboles Yahoo]}`` (positions ∪
    watchlist). ``focus`` : ``{username: symbole}`` (ou un symbole seul), les
    titres regardés en ce moment dans TradingView — ils sont scannés même sans
    position. ``held`` : les symboles réellement DÉTENUS (le corps de dépêche
    ne se charge que pour eux). ``state`` : le sous-état persistant, MUTÉ en
    place ::

        {"last_fetch": {tv_symbol: iso}, "seen_ids": [...],
         "errors": int, "last_error": iso|None, "requests": int,
         "items_by_symbol": {tv_symbol: {"fetched_at": iso, "items": [...]}},
         "exchange_of": {symbole_yahoo: "EXCHANGE:TICKER"},
         "unknown": {symbole_yahoo: iso}}

    Trois garde-fous, dans cet ordre : la **cadence** (un symbole n'est
    réinterrogé qu'après ``MIN_INTERVAL_S``), le **budget** (``budget``
    requêtes au plus par cycle, corps compris), la **déduplication**
    (``seen_ids``, fenêtre glissante ``SEEN_MAX``).

    ``items_by_symbol`` est le CACHE lu par :func:`cached_items` (donc par la
    fiche du titre) : il se remplit à chaque lecture réussie, **même quand
    aucun item n'est neuf**. Les événements rendus, eux, restent filtrés par
    ``seen_ids`` — les deux répondent à deux questions différentes (« qu'est-ce
    qui vient d'arriver ? » contre « qu'est-ce que TradingView affiche ? »).

    ``emit`` (injecté, défaut ``paper_ws.emit``) reçoit les news des symboles en
    FOCUS : c'est le chemin « ≤ 2 s » de la spec §7. Best-effort strict — une
    panne de push ne fait perdre aucun événement.
    """
    now_dt = _now_dt(now)
    state = state if isinstance(state, dict) else {}
    last_fetch = state.setdefault("last_fetch", {})
    if not isinstance(last_fetch, dict):
        last_fetch = {}
        state["last_fetch"] = last_fetch
    seen_ids = state.setdefault("seen_ids", [])
    if not isinstance(seen_ids, list):
        seen_ids = []
        state["seen_ids"] = seen_ids
    seen_set = set(seen_ids)

    try:
        remaining = max(0, int(budget))
    except (TypeError, ValueError):
        remaining = REQUEST_BUDGET
    used = 0

    held_upper = {_text(s).upper() for s in (held or []) if _text(s)}
    lang_list = [l for l in (langs or LANGS) if _text(l)] or list(LANGS)

    fresh_items: List[Dict[str, Any]] = []
    focus_of: Dict[str, str] = {}

    for symbol, focus_user in _targets(username_symbols, focus):
        if _is_unknown(state, symbol, now_dt):
            continue
        tv_symbol = _tv_for(symbol, state)
        if not tv_symbol:
            continue
        elapsed = _seconds_since(last_fetch.get(tv_symbol), now_dt)
        if elapsed is not None and elapsed < MIN_INTERVAL_S:
            continue
        if used >= remaining:
            break

        alternatives = _alt_us_symbols(symbol, tv_symbol)
        collected: List[Dict[str, Any]] = []   # pour le CACHE (tout, pas juste le neuf)
        fetched_ok = False
        unknown_symbol = False
        cascade_cut_short = False

        for lang in lang_list:
            if used >= remaining:
                break
            used += 1
            if client is None:
                items, transport_ok, status = [], False, 0
            else:
                items, transport_ok, status = _fetch_items_raw(client, tv_symbol, lang)
                if status == UNKNOWN_SYMBOL_STATUS and alternatives:
                    # Le pari ``NASDAQ:`` est tombé à côté : on essaie les
                    # autres places américaines UNE fois, et on retient celle
                    # qui répond pour tous les cycles suivants.
                    for alt in alternatives:
                        if used >= remaining:
                            cascade_cut_short = True
                            break
                        used += 1
                        items, transport_ok, status = _fetch_items_raw(client, alt, lang)
                        if status != UNKNOWN_SYMBOL_STATUS:
                            tv_symbol = alt
                            memo = state.setdefault("exchange_of", {})
                            if isinstance(memo, dict):
                                memo[symbol] = alt
                            break
                    alternatives = []          # une seule cascade par cycle
            if status == UNKNOWN_SYMBOL_STATUS:
                # Symbole que TradingView ne connaît pas : ce n'est PAS une
                # panne, c'est notre table qui a parié de travers.
                #
                # SAUF si le budget a coupé la cascade : condamner un symbole
                # pour 24 h sans avoir essayé les autres places, ce serait
                # punir un titre valide parce que le cycle était chargé.
                unknown_symbol = not cascade_cut_short
                break
            if not transport_ok:
                # 429, 5xx, JSON cassé, réseau coupé : on laisse une TRACE
                # dans l'état (§7 de la spec) sans jamais lever. Un flux
                # simplement vide, lui, n'est pas une anomalie.
                state["errors"] = int(state.get("errors") or 0) + 1
                state["last_error"] = now_dt.isoformat()
                continue
            fetched_ok = True
            for item in items:
                row = cache_row(item, lang)
                if row is not None:
                    collected.append(row)
                marker = _text(item.get("id")) or _text(item.get("url"))
                if not marker or marker in seen_set:
                    continue
                seen_set.add(marker)
                seen_ids.append(marker)
                fresh_items.append(item)
                if focus_user:
                    focus_of[marker] = focus_user

        if unknown_symbol:
            memo = state.setdefault("unknown", {})
            if isinstance(memo, dict):
                memo[symbol] = now_dt.isoformat()
            continue                           # ni cache, ni cadence : au placard
        if fetched_ok:
            # Le CACHE se remplit même quand aucun item n'est neuf : c'est tout
            # l'objet du 11/09 — la fiche montre le flux, pas la nouveauté.
            _remember_items(state, tv_symbol, collected, now_dt)
        last_fetch[tv_symbol] = now_dt.isoformat()

    # Corps de dépêche — après la collecte, pour que le budget serve d'abord à
    # voir large et seulement ensuite à creuser.
    bodies: Dict[str, str] = {}
    for item in fresh_items:
        if used >= remaining:
            break
        if not needs_story(item, held_upper):
            continue
        used += 1
        body = fetch_story(client, item.get("id"), "en") if client is not None else None
        if body:
            bodies[_text(item.get("id"))] = body

    if len(seen_ids) > SEEN_MAX:
        del seen_ids[:len(seen_ids) - SEEN_MAX]
    state["requests"] = used

    events = to_events(fresh_items, held=held_upper, bodies=bodies)

    # Push WebSocket des news du titre REGARDÉ (spec §7 : « ≤ 2 s si l'onglet
    # est l'onglet focus »). Best-effort STRICT : jamais fatal.
    if focus_of:
        pusher = emit
        if pusher is None:
            try:
                from backend.bots import paper_ws
                pusher = paper_ws.emit
            except Exception:     # noqa: BLE001 — module absent
                pusher = None
        if pusher is not None:
            for item, event in zip(fresh_items, events):
                username = focus_of.get(_text(item.get("id"))
                                        or _text(item.get("url")))
                if not username:
                    continue
                try:
                    pusher(username, "news", event.get("symbol"), dict(event))
                except Exception:  # noqa: BLE001 — un push perdu n'est rien
                    logger.debug("paper tvnews: push WS impossible")
    return events
