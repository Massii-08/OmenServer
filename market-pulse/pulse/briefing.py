"""Assemblage du briefing d'UNE place — pur, tout injecté.

C'est la pièce qui relie les autres : l'indice de la place, la comparaison avec
les bourses déjà passées, l'agenda daté, les news triées par « qui a fait quoi »,
les titres suivis et les nouveaux titres apparus.

Deux principes de conception :

1. **La comparaison ne montre que ce qui ÉCLAIRE cette ouverture.** Quand
   l'Europe ouvre, l'Asie a déjà fermé et l'Amérique n'a pas commencé : lister
   les vingt marchés noierait le lecteur. On dit l'état de chacun, et le lecteur
   voit tout de suite d'où vient la couleur du jour.
2. **Suivi et proposé ne se mélangent jamais.** Ce que Massii suit d'un côté,
   ce qu'on lui propose d'ajouter de l'autre. La distinction est tout l'intérêt
   de la liste de découverte.

⚠️ Aucun champ de direction, de recommandation ni d'objectif de cours — un test
inspecte le JSON produit et échoue si un tel mot y apparaît.
"""
from typing import Any, Dict, List, Optional

from .events import rank_events
from .exchanges import Exchange, session_windows

_STATE_IT = {
    "open": "aperto",
    "closed": "chiuso",
    "unknown": "stato ignoto",
}

_EMPTY_NEWS = {"items": [], "themes": [], "tone": {}, "sources_ok": [],
               "sources_failed": [], "stale_sources": [], "filtered_advice": 0}


def _market_state(market: Dict[str, Any], now_ts: int) -> str:
    """Où en est ce marché par rapport à MAINTENANT, dit simplement."""
    clock = market.get("clock") or {}
    status = clock.get("status")
    if status == "open":
        return "aperto"
    opens_at = clock.get("opens_at")
    if opens_at and opens_at > now_ts:
        # Il rouvrira plus tard aujourd'hui : il n'a donc pas encore donné le
        # ton de la journée.
        return "non ancora aperto"
    return _STATE_IT.get(status, "stato ignoto")


def _comparison(markets: List[Dict[str, Any]], own_symbol: Optional[str],
                now_ts: int) -> List[Dict[str, Any]]:
    out = []
    for m in markets:
        if own_symbol and m.get("symbol") == own_symbol:
            continue
        if (m.get("kind") or "index") != "index":
            continue
        out.append({
            "symbol": m.get("symbol"),
            "label": m.get("label"),
            "region": m.get("region"),
            "change_pct": m.get("change_pct"),
            "state": _market_state(m, now_ts),
        })
    return out


def build_briefing(exchange: Optional[Exchange],
                   snapshot: Optional[Dict[str, Any]] = None,
                   news: Optional[Dict[str, Any]] = None,
                   agenda: Optional[List[Dict[str, Any]]] = None,
                   followed: Optional[List[Dict[str, Any]]] = None,
                   discovered: Optional[List[Dict[str, Any]]] = None,
                   now_ts: Optional[int] = None) -> Optional[Dict[str, Any]]:
    """Le briefing d'une place, prêt pour le rapport, l'Excel et l'UI.

    Rend None sans place : il n'y a rien à assembler, et fabriquer un briefing
    vide serait pire (il aurait l'air normal).
    """
    if exchange is None:
        return None
    snapshot = snapshot or {"markets": [], "errors": [], "generated_at": now_ts}
    markets = snapshot.get("markets") or []
    now_ts = int(now_ts if now_ts is not None else (snapshot.get("generated_at") or 0))

    index = None
    for m in markets:
        if m.get("symbol") == exchange.symbol:
            index = m
            break

    # Les news sont RECLASSÉES ici : le critère de Massii — ce qui bouge une
    # courbe passe devant — s'applique au moment de l'assemblage, pas à la
    # collecte, pour que le même lot serve plusieurs places.
    src = news or _EMPTY_NEWS
    ranked = rank_events(src.get("items") or [])

    windows = session_windows(exchange)
    return {
        "exchange": exchange.id,
        "label": exchange.label,
        "country": exchange.country,
        "index": index,
        "session": {
            "tz": exchange.tz,
            "opens_at": exchange.opens_at,
            "closes_at": exchange.closes_at,
            # La pause déjeuner est DITE : Yahoo rend la séance en un bloc, et
            # afficher « aperto » à midi à Tokyo serait faux.
            "lunch": list(exchange.lunch) if exchange.lunch else None,
            "windows": [list(w) for w in windows],
        },
        "comparison": _comparison(markets, exchange.symbol, now_ts),
        "agenda": list(agenda or []),
        "news": {
            "items": ranked,
            "themes": src.get("themes") or [],
            "tone": src.get("tone") or {},
            "sources_ok": src.get("sources_ok") or [],
            "sources_failed": src.get("sources_failed") or [],
            "stale_sources": src.get("stale_sources") or [],
            # Compteurs de transparence : on écarte des titres, on le dit.
            "filtered_advice": src.get("filtered_advice") or 0,
            "filtered_offtopic": src.get("filtered_offtopic") or 0,
            # Alarmes de collecte (ex. : X a changé sa sérialisation). Elles
            # DOIVENT traverser jusqu'à l'écran : une source muette rendrait un
            # briefing vide qui ressemble à « il n'y avait rien à dire ».
            "alarms": list(src.get("alarms") or []),
        },
        "followed": list(followed or []),
        "discovered": list(discovered or []),
        "errors": list(snapshot.get("errors") or []),
        "generated_at": now_ts,
    }
