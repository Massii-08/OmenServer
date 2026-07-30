"""Catalogue des places boursières suivies — pur, aucune I/O.

Les dix opérateurs demandés par Massii. Deux subtilités que la liste impose :

1. **Ce sont des OPÉRATEURS, pas des indices.** Euronext regroupe sept pays —
   Amsterdam, Paris, Bruxelles, Lisbonne, Dublin, **Milan**, Oslo. La bourse du
   grand-père est donc *dans* Euronext, pas à côté.
2. **Dix opérateurs ne font que CINQ ouvertures** — mesuré, pas supposé, et
   stable été comme hiver :

       00:00 UTC  JPX
       01:30 UTC  HKEX + SSE + SZSE      (tous en UTC+8, sans changement d'heure)
       03:45 UTC  NSE
       07:00 UTC  Euronext + LSE + Deutsche Börse   (08:00 UTC l'hiver)
       13:30 UTC  NYSE + Nasdaq                     (14:30 UTC l'hiver)

   Les deux regroupements qui ne sautent pas aux yeux : **Londres ouvre au même
   instant que Paris et Francfort** (08:00 locales contre 09:00 — Londres est
   toujours une heure derrière l'Europe continentale), et Hong Kong au même
   instant que les deux places chinoises. `opening_groups()` fait ce
   regroupement : produire deux briefings identiques à la même seconde n'aurait
   aucun sens.

Tous les symboles, fuseaux, heures d'ouverture et pauses déjeuner ci-dessous
ont été SONDÉS en réel le 2026-07-29.

⚠️ Les pauses déjeuner ne sont pas décoratives : Yahoo rend la séance en UN
bloc (Tokyo 09:00-15:30), donc sans cette donnée on afficherait « aperto »
pendant la pause — un fait faux.
"""
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

# Flux de presse locale, tous sondés (code HTTP, nombre d'items, âge du plus
# récent). Le catalogue complet des 154 flux vit dans
# docs/superpowers/specs/2026-07-29-market-pulse-sources-locales.md ; on garde
# ici les deux à quatre plus solides par place.
#
# ⚠️ Les requêtes Bluesky font AU MOINS deux mots, toujours. La recherche n'a
# aucune notion de sujet ni de pays : « nikkei » seul a ramené « SJ Nikkei
# Resisters » et un post personnel sur la bulle IA sous le nom de la Bourse de
# Tokyo, et « borsa » rendait 50 % de posts turcs. Un test verrouille la règle.
_F = lambda name, url, lang: {"name": name, "url": url, "lang": lang}  # noqa: E731


@dataclass(frozen=True)
class Exchange:
    id: str
    label: str
    country: str
    symbol: str                      # indice de référence de la place
    index_label: str
    tz: str                          # fuseau IANA
    opens_at: str                    # "HH:MM" heure LOCALE de la place
    feeds: Tuple[Dict[str, str], ...] = ()      # presse locale
    reddit_subs: Tuple[str, ...] = ()
    bluesky_queries: Tuple[str, ...] = ()
    lunch: Optional[Tuple[str, str]] = None     # pause déjeuner ("11:30","12:30")
    places: Tuple[Dict[str, str], ...] = ()     # sous-places (Euronext seulement)
    closes_at: Optional[str] = None

    def as_dict(self) -> Dict[str, Any]:
        """Forme JSON consommée par le briefing, le router et l'UI."""
        return {
            "id": self.id, "label": self.label, "country": self.country,
            "symbol": self.symbol, "index_label": self.index_label,
            "tz": self.tz, "opens_at": self.opens_at, "closes_at": self.closes_at,
            "lunch": list(self.lunch) if self.lunch else None,
            "feeds": [dict(f) for f in self.feeds],
            "reddit_subs": list(self.reddit_subs),
            "bluesky_queries": list(self.bluesky_queries),
            "places": [dict(p) for p in self.places],
        }


# Les sept places d'Euronext, chacune avec son indice propre (tous sondés OK).
_EURONEXT_PLACES = (
    {"city": "Amsterdam", "index": "AEX", "symbol": "^AEX", "tz": "Europe/Amsterdam"},
    {"city": "Parigi", "index": "CAC 40", "symbol": "^FCHI", "tz": "Europe/Paris"},
    {"city": "Bruxelles", "index": "BEL 20", "symbol": "^BFX", "tz": "Europe/Brussels"},
    {"city": "Lisbona", "index": "PSI 20", "symbol": "PSI20.LS", "tz": "Europe/Lisbon"},
    {"city": "Dublino", "index": "ISEQ", "symbol": "^ISEQ", "tz": "Europe/Dublin"},
    {"city": "Milano", "index": "FTSE MIB", "symbol": "FTSEMIB.MI", "tz": "Europe/Rome"},
    {"city": "Oslo", "index": "OSEBX", "symbol": "OSEBX.OL", "tz": "Europe/Oslo"},
)


DEFAULT_EXCHANGES: List[Exchange] = [
    Exchange(
        id="nyse", label="NYSE", country="Stati Uniti",
        symbol="^NYA", index_label="NYSE Composite",
        tz="America/New_York", opens_at="09:30", closes_at="16:00",
        feeds=(_F("CNBC Mercati", "https://www.cnbc.com/id/15839135/device/rss/rss.html", "en"),
               _F("CNBC Economia", "https://www.cnbc.com/id/10000664/device/rss/rss.html", "en"),
               _F("MarketWatch", "https://feeds.marketwatch.com/marketwatch/topstories/", "en")),
        reddit_subs=("investing", "stocks", "StockMarket"),
        bluesky_queries=("wall street", "stock market"),
    ),
    Exchange(
        id="nasdaq", label="Nasdaq", country="Stati Uniti",
        symbol="^IXIC", index_label="Nasdaq Composite",
        tz="America/New_York", opens_at="09:30", closes_at="16:00",
        feeds=(_F("CNBC Mercati", "https://www.cnbc.com/id/15839135/device/rss/rss.html", "en"),
               _F("MarketWatch", "https://feeds.marketwatch.com/marketwatch/topstories/", "en")),
        reddit_subs=("stocks", "wallstreetbets"),
        bluesky_queries=("nasdaq composite", "tech stocks"),
    ),
    Exchange(
        id="jpx", label="JPX", country="Giappone",
        symbol="^N225", index_label="Nikkei 225",
        tz="Asia/Tokyo", opens_at="09:00", closes_at="15:30",
        lunch=("11:30", "12:30"),
        feeds=(_F("Japan Times business", "https://www.japantimes.co.jp/feed/", "en"),
               _F("Google News JP (mercati)",
                  "https://news.google.com/rss/search?q=%E6%97%A5%E7%B5%8C%E5%B9%B3%E5%9D%87"
                  "+when:1d&hl=ja&gl=JP&ceid=JP:ja", "ja")),
        reddit_subs=("JapanFinance",),
        bluesky_queries=("nikkei 225", "tokyo stocks"),
    ),
    Exchange(
        id="euronext", label="Euronext", country="Area euro (NL, FR, BE, PT, IE, IT, NO)",
        symbol="^N100", index_label="Euronext 100",
        tz="Europe/Paris", opens_at="09:00", closes_at="17:30",
        places=_EURONEXT_PLACES,
        feeds=(_F("Il Sole 24 Ore",
                  "https://www.ilsole24ore.com/rss/finanza--quotate-italia.xml", "it"),
               _F("ANSA Economia",
                  "https://www.ansa.it/sito/notizie/economia/economia_rss.xml", "it"),
               _F("Les Echos marches",
                  "https://feeds.feedburner.com/lesechos/4MR4suAcqTl", "fr"),
               _F("Google News IT (borsa)",
                  "https://news.google.com/rss/search?q=borsa+when:1d&hl=it&gl=IT&ceid=IT:it", "it")),
        reddit_subs=("eupersonalfinance", "ItaliaPersonalFinance"),
        bluesky_queries=("piazza affari", "borsa milano", "ftse mib"),
    ),
    Exchange(
        id="hkex", label="HKEX", country="Hong Kong",
        symbol="^HSI", index_label="Hang Seng",
        tz="Asia/Hong_Kong", opens_at="09:30", closes_at="16:00",
        lunch=("12:00", "13:00"),
        feeds=(_F("SCMP business", "https://www.scmp.com/rss/92/feed", "en"),
               _F("Google News HK",
                  "https://news.google.com/rss/search?q=Hang+Seng+when:1d&hl=en-HK&gl=HK&ceid=HK:en",
                  "en")),
        bluesky_queries=("hang seng",),
    ),
    Exchange(
        id="sse", label="SSE", country="Cina (Shanghai)",
        symbol="000001.SS", index_label="Shanghai Composite",
        tz="Asia/Shanghai", opens_at="09:30", closes_at="15:00",
        lunch=("11:30", "13:00"),
        feeds=(_F("Caixin Global", "https://www.caixinglobal.com/rss/", "en"),
               _F("Google News CN (mercati)",
                  "https://news.google.com/rss/search?q=China+stocks+when:1d&hl=en-US&gl=US&ceid=US:en",
                  "en")),
        bluesky_queries=("china stocks",),
    ),
    Exchange(
        id="lse", label="LSE", country="Regno Unito",
        symbol="^FTSE", index_label="FTSE 100",
        tz="Europe/London", opens_at="08:00", closes_at="16:30",
        feeds=(_F("Guardian business", "https://www.theguardian.com/uk/business/rss", "en"),
               _F("BBC business", "https://feeds.bbci.co.uk/news/business/rss.xml", "en"),
               _F("Google News GB",
                  "https://news.google.com/rss/search?q=FTSE+100+when:1d&hl=en-GB&gl=GB&ceid=GB:en",
                  "en")),
        reddit_subs=("UKInvesting",),
        bluesky_queries=("ftse 100",),
    ),
    Exchange(
        id="nse", label="NSE", country="India",
        symbol="^NSEI", index_label="Nifty 50",
        tz="Asia/Kolkata", opens_at="09:15", closes_at="15:30",
        feeds=(_F("Economic Times markets",
                  "https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms", "en"),
               _F("Google News IN",
                  "https://news.google.com/rss/search?q=Nifty+50+when:1d&hl=en-IN&gl=IN&ceid=IN:en",
                  "en")),
        reddit_subs=("IndiaInvestments",),
        bluesky_queries=("nifty 50",),
    ),
    Exchange(
        id="szse", label="SZSE", country="Cina (Shenzhen)",
        symbol="399001.SZ", index_label="Shenzhen Component",
        tz="Asia/Shanghai", opens_at="09:30", closes_at="15:00",
        lunch=("11:30", "13:00"),
        feeds=(_F("Caixin Global", "https://www.caixinglobal.com/rss/", "en"),),
        bluesky_queries=("shenzhen stocks",),
    ),
    Exchange(
        id="deutsche_boerse", label="Deutsche Börse", country="Germania",
        symbol="^GDAXI", index_label="DAX",
        tz="Europe/Berlin", opens_at="09:00", closes_at="17:30",
        feeds=(_F("Handelsblatt Finanzen",
                  "https://www.handelsblatt.com/contentexport/feed/finanzen", "de"),
               _F("Manager Magazin", "https://www.manager-magazin.de/finanzen/index.rss", "de"),
               _F("Tagesschau Wirtschaft",
                  "https://www.tagesschau.de/wirtschaft/index~rss2.xml", "de"),
               _F("Google News DE",
                  "https://news.google.com/rss/search?q=DAX+B%C3%B6rse+when:1d&hl=de&gl=DE&ceid=DE:de",
                  "de")),
        reddit_subs=("Finanzen",),
        bluesky_queries=("dax index", "borse dax"),
    ),
]


def by_id(exchange_id: Optional[str]) -> Optional[Exchange]:
    """La place portant cet identifiant, ou None."""
    if not exchange_id:
        return None
    for e in DEFAULT_EXCHANGES:
        if e.id == exchange_id:
            return e
    return None


def _minutes_utc(exchange: Exchange, on=None) -> int:
    """Minutes depuis minuit UTC de l'ouverture — sert UNIQUEMENT à ordonner
    les groupes dans la journée (l'Asie avant l'Europe avant New York).

    On passe par un jour de référence fixe : l'ordre relatif des ouvertures ne
    dépend pas de la date, seulement des décalages horaires.
    """
    from datetime import datetime
    from zoneinfo import ZoneInfo
    hour, minute = (int(x) for x in exchange.opens_at.split(":"))
    day = on or datetime(2026, 7, 29)
    ref = datetime(day.year, day.month, day.day, hour, minute,
                   tzinfo=ZoneInfo(exchange.tz))
    utc = ref.astimezone(ZoneInfo("UTC"))
    return utc.hour * 60 + utc.minute


def opening_groups(exchanges: Optional[List[Exchange]]
                   ) -> List[Tuple[List[str], str, str]]:
    """Regroupe les places qui ouvrent au MÊME instant.

    Rend une liste de `(identifiants, fuseau, "HH:MM")`, ordonnée dans la
    journée. Dix opérateurs donnent sept déclencheurs : produire deux briefings
    à la même seconde pour NYSE et Nasdaq n'aurait aucun sens.
    """
    if not exchanges:
        # `None` ne veut PAS dire « toutes » : une selection nulle venue d'une
        # config doit produire ZERO briefing, pas les dix en silence. C'est la
        # classe de bug la plus couteuse du depot (une branche toujours vraie).
        return []
    buckets = {}   # type: Dict[int, List[Exchange]]
    for e in exchanges:
        buckets.setdefault(_minutes_utc(e), []).append(e)
    out = []
    for minutes in sorted(buckets):
        group = buckets[minutes]
        out.append(([e.id for e in group], group[0].tz, group[0].opens_at))
    return out


def session_windows(exchange: Optional[Exchange]) -> List[Tuple[str, Optional[str]]]:
    """Fenêtres de cotation, pause déjeuner comprise.

    Tokyo, Hong Kong et les places chinoises ferment à midi. Yahoo l'ignore et
    rend la séance en un seul bloc : c'est ici qu'on rétablit la vérité.
    """
    if exchange is None:
        return []
    if not exchange.lunch:
        return [(exchange.opens_at, exchange.closes_at)]
    start_break, end_break = exchange.lunch
    return [(exchange.opens_at, start_break), (end_break, exchange.closes_at)]
