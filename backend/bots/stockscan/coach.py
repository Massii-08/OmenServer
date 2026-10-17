"""Les signaux du coach, en LECTURE SEULE — ce que la veille a déjà récolté.

Zéro réseau : on relit les mémoires que ``backend/bots/paper`` tient à jour
(carnets news de tous les comptes, cache TradingView, tendances Reddit,
hypothèses ouvertes du radar, positions et watchlist du demandeur) et on les
range par symbole Yahoo canonique.

Ce module n'ÉCRIT RIEN sous ``data/paper_trading/`` (ni cache, ni état) : le
scanner est un lecteur. Seule exception, qui n'est pas de notre fait : les
chargeurs du coach renomment en ``.corrupt`` un fichier JSON illisible.

Trois règles, toutes héritées des leçons du dépôt :

1. **Pertinence.** Un événement sans ``src`` vient du flux Yahoo PAR SYMBOLE,
   qui est un flux SECTORIEL (40-75 % des titres parlent vraiment de la société,
   mesuré en phase D de Market Pulse) : il ne compte pour un titre que si son
   libellé NOMME la société (``entities.detect_companies``, mot entier, avec les
   noms du screener comme ancres). Les autres familles portent déjà un symbole
   fiable (TradingView filtre par symbole, la SEC dépose par ticker, la veille
   presse passe par ``entities``).
2. **Pseudo-symbole.** ``GOV`` (annonces politiques) n'est pas un titre.
3. **Vie privée.** ``followed`` ne contient QUE les positions et la watchlist
   du demandeur. Les carnets des autres comptes ne servent qu'aux news — des
   titres publics — jamais à dire qui suit quoi.

Chaque chargeur est injectable (tests) et isolé : une mémoire illisible
n'empêche pas les autres d'être lues, elle laisse une ligne dans ``errors``.
"""
from datetime import datetime
from typing import Any, Callable, Dict, Iterable, List, Optional

from backend.bots.stockscan import markets as mk
from backend.bots.stockscan import news as nw

PSEUDO_SYMBOLS = frozenset({"GOV", ""})

# Les tickers courts sont des mots courants (« ON », « ALL », « NOW ») : un
# ticker ne sert d'ancre de pertinence qu'à partir de quatre lettres.
MIN_TICKER_ANCHOR = 4


class Loaders:
    """Accès aux mémoires du coach — chaque méthode peut être remplacée."""

    def users(self) -> List[str]:
        from backend.bots.paper import radar
        return radar._users_with_portfolio()

    def events(self, username: str) -> List[Dict[str, Any]]:
        from backend.bots.paper import newswatch
        return newswatch.recent_events(username)

    def trends(self, now: datetime) -> Dict[str, Dict[str, int]]:
        from backend.bots.paper import newswatch
        return newswatch.recent_trends(now)

    def tv_state(self) -> Dict[str, Any]:
        from backend.bots.paper import newswatch
        return newswatch.tv_news_state()

    def hypotheses(self) -> List[Dict[str, Any]]:
        from backend.bots.paper import radar
        return list((radar.load_state() or {}).get("hypotheses") or [])

    def portfolio(self, username: str) -> Optional[Dict[str, Any]]:
        from backend.bots.paper import store
        return store.load_portfolio(username)

    def watchlist(self, username: str) -> List[Dict[str, Any]]:
        from backend.bots.paper import store
        return store.load_watchlist(username)


def _canonical(symbol: Any) -> str:
    if not isinstance(symbol, str):
        return ""
    try:
        from backend.bots.paper.quotes import canonical
        return canonical(symbol)
    except Exception:             # noqa: BLE001
        return symbol.strip().upper()


def _safe(call: Callable[[], Any], label: str, errors: List[str], default: Any) -> Any:
    try:
        value = call()
    except Exception as exc:      # noqa: BLE001 — une mémoire n'est jamais fatale
        errors.append("%s: %s" % (label, type(exc).__name__))
        return default
    return default if value is None else value


def build_anchors(rows: Iterable[Dict[str, Any]]) -> Dict[str, str]:
    """``{nom en minuscules: symbole}`` pour le contrôle de pertinence (PUR).

    Noms du screener (et de la watchlist), plus le ticker NU quand il est assez
    long pour ne pas être un mot courant.
    """
    try:
        from backend.bots.paper import entities
    except Exception:             # noqa: BLE001
        return {}
    anchor_rows: List[Dict[str, Any]] = []
    for row in rows or []:
        if not isinstance(row, dict):
            continue
        symbol = _canonical(row.get("symbol"))
        if not symbol:
            continue
        anchor_rows.append({"symbol": symbol, "name": row.get("name")})
        ticker = str(row.get("ticker") or "").strip()
        if len(ticker) >= MIN_TICKER_ANCHOR and ticker.isalpha():
            anchor_rows.append({"symbol": symbol, "name": ticker})
    return entities.anchor_index(anchor_rows)


def is_relevant(event: Dict[str, Any], symbol: str, anchors: Dict[str, str]) -> bool:
    """Un événement du carnet parle-t-il vraiment de ``symbol`` ?"""
    if nw.family_of_event(event) != nw.FAMILY_PRESS or event.get("src"):
        return True               # symbole posé par une source fiable
    try:
        from backend.bots.paper import entities
        found = entities.detect_companies(event.get("title") or "", anchors)
    except Exception:             # noqa: BLE001
        return False
    return symbol in found


def _slot(by_symbol: Dict[str, Dict[str, Any]], symbol: str) -> Dict[str, Any]:
    if symbol not in by_symbol:
        by_symbol[symbol] = {"news": [], "reddit": None, "filings": [], "hypotheses": []}
    return by_symbol[symbol]


def load(username: str, now: datetime, window_h: float,
         universe: Iterable[Dict[str, Any]],
         loaders: Optional[Loaders] = None) -> Dict[str, Any]:
    """Les signaux du coach rangés par symbole Yahoo canonique.

    Rend ``{"by_symbol", "followed", "tv_cache", "stats", "errors"}`` ; ne lève
    jamais.
    """
    loaders = loaders or Loaders()
    errors: List[str] = []
    stats = {"users": 0, "events": 0, "events_in_window": 0, "assigned": 0,
             "out_of_universe": 0, "dropped_irrelevant": 0, "filtered_advice": 0,
             "hypotheses_open": 0, "tv_cache_symbols": 0, "reddit_symbols": 0}
    by_symbol: Dict[str, Dict[str, Any]] = {}

    # --- le demandeur : ce qu'il suit -----------------------------------------
    followed = set()
    portfolio = _safe(lambda: loaders.portfolio(username), "portfolio", errors, {})
    for pos in (portfolio or {}).get("positions") or []:
        if isinstance(pos, dict) and _canonical(pos.get("symbol")):
            followed.add(_canonical(pos.get("symbol")))
    watch_rows = _safe(lambda: loaders.watchlist(username), "watchlist", errors, [])
    for row in watch_rows or []:
        if isinstance(row, dict) and _canonical(row.get("symbol")):
            followed.add(_canonical(row.get("symbol")))

    universe_rows = [r for r in universe or [] if isinstance(r, dict)]
    # Seuls les titres de l'univers seront notés : un signal sur un autre titre
    # ne sert à rien ici (et fausserait le compteur « hors sujet »).
    universe_symbols = {_canonical(r.get("symbol")) for r in universe_rows} - {""}
    anchors = build_anchors(list(universe_rows) + [r for r in watch_rows or []
                                                   if isinstance(r, dict)])

    # --- les carnets news de tous les comptes (dédup par lien) ------------------
    users = list(_safe(loaders.users, "users", errors, []) or [])
    if username and username not in users:
        users.append(username)
    stats["users"] = len(users)
    seen_links = set()
    for user in users:
        events = _safe(lambda u=user: loaders.events(u), "events:%s" % user, errors, [])
        for event in events or []:
            if not isinstance(event, dict):
                continue
            key = event.get("link") or "%s|%s" % (event.get("ts"), event.get("title"))
            if key in seen_links:
                continue
            seen_links.add(key)
            stats["events"] += 1
            if not nw.in_window(event.get("ts"), now, window_h):
                continue
            stats["events_in_window"] += 1
            symbol = _canonical(event.get("symbol"))
            if symbol in PSEUDO_SYMBOLS:
                continue
            if symbol not in universe_symbols:
                stats["out_of_universe"] += 1
                continue
            if nw.is_advice(event.get("title")):
                stats["filtered_advice"] += 1
                continue
            if not is_relevant(event, symbol, anchors):
                stats["dropped_irrelevant"] += 1
                continue
            item = nw.item_from_event(event)
            if item is None:
                continue
            slot = _slot(by_symbol, symbol)
            slot["news"].append(item)
            stats["assigned"] += 1
            if item["family"] == nw.FAMILY_SEC:
                slot["filings"].append({"form": event.get("form") or "",
                                        "title": item["title"], "url": item["url"],
                                        "published": item["published"]})

    # --- le cache TradingView du coach -------------------------------------------
    tv_state = _safe(loaders.tv_state, "tv_state", errors, {})
    tv_cache = tv_state.get("items_by_symbol") if isinstance(tv_state, dict) else None
    tv_cache = tv_cache if isinstance(tv_cache, dict) else {}
    stats["tv_cache_symbols"] = len(tv_cache)
    for tv_symbol, entry in tv_cache.items():
        rows = entry.get("items") if isinstance(entry, dict) else None
        for raw in rows or []:
            if not isinstance(raw, dict):
                continue
            symbol = _canonical(raw.get("symbol")) or (mk.tv_to_yahoo(tv_symbol) or "")
            item = nw.item_from_tv(raw)
            if symbol not in universe_symbols or item is None \
                    or not nw.in_window(item["published"], now, window_h):
                continue
            if nw.is_advice(item["title"]):
                stats["filtered_advice"] += 1
                continue
            _slot(by_symbol, symbol)["news"].append(item)

    # --- la foule (Reddit) ---------------------------------------------------------
    trends = _safe(lambda: loaders.trends(now), "trends", errors, {})
    for sym, view in (trends or {}).items():
        symbol = _canonical(sym)
        if symbol not in universe_symbols or not isinstance(view, dict):
            continue
        _slot(by_symbol, symbol)["reddit"] = {"count": int(view.get("count") or 0),
                                              "prev": int(view.get("prev") or 0)}
        stats["reddit_symbols"] += 1

    # --- les hypothèses ouvertes du radar ------------------------------------------
    for hyp in _safe(loaders.hypotheses, "radar", errors, []) or []:
        if not isinstance(hyp, dict) or hyp.get("status") != "open" or hyp.get("evicted_at"):
            continue
        stats["hypotheses_open"] += 1
        for ticker in hyp.get("tickers") or []:
            symbol = _canonical(ticker)
            if symbol not in universe_symbols:
                continue
            _slot(by_symbol, symbol)["hypotheses"].append({
                "direction": hyp.get("direction") if hyp.get("direction") in ("up", "down") else None,
                "thesis": str(hyp.get("thesis") or "")[:400],
                "confidence": hyp.get("confidence"),
                "horizon_days": hyp.get("horizon_days"),
                "source": hyp.get("source") or "radar",
                "created_at": hyp.get("created_at"),
            })

    for slot in by_symbol.values():
        slot["news"] = nw.merge(slot["news"])

    return {"by_symbol": by_symbol, "followed": followed, "tv_cache": tv_cache,
            "stats": stats, "errors": errors}
