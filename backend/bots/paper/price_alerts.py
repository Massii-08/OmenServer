"""Alertes de prix personnalisées (Lot A1) — logique PURE, zéro I/O ici.

L'utilisateur pose « préviens-moi si SYMBOLE passe au-dessus/en dessous de
PRIX ». C'est un ordre EXPLICITE : à la différence d'une dépêche de presse
(un émetteur ÉDITORIAL, que le mode « calme » peut faire taire, cf. tête de
``paper/alerts.py``), une alerte de prix tire dans les DEUX modes — la faire
taire reviendrait à ignorer une demande que l'utilisateur a formulée
lui-même.

Persistance : ``<user>.alerts.json`` via ``store.alerts_path``/
``load_alerts``/``save_alerts`` (même patron que la watchlist — fichier
SÉPARÉ du portefeuille, cf. la docstring de ``store.watchlist_path``). Ce
module ne touche jamais le disque : c'est le router (création/liste/
suppression) et ``newswatch._run_price_alerts_volet`` (vérification +
déclenchement) qui appellent ``store.*`` et les fonctions PURES d'ici.

ONE-SHOT : une alerte déclenchée passe en ``STATUS_TRIGGERED`` et n'est plus
jamais réévaluée (cf. ``condition_met`` appelée seulement sur les alertes
``STATUS_ARMED`` côté guetteur) — recréable à la main si l'utilisateur veut
la reposer.
"""
from typing import Any, Dict, List, Optional

# Deux conditions seulement — liste FERMÉE, comme ``calendar.KIND_*`` : un
# champ texte libre à la place ouvrirait la porte à une valeur imprévue qui
# ne matcherait jamais ``condition_met`` (donc une alerte qui n'armerait
# jamais, en silence).
OP_ABOVE = "above"
OP_BELOW = "below"
OPS = (OP_ABOVE, OP_BELOW)

STATUS_ARMED = "armed"
STATUS_TRIGGERED = "triggered"

# Même ordre de grandeur que ``paper_router.MAX_WATCHLIST`` — au-delà, ce
# n'est plus une poignée de niveaux à surveiller mais un fourre-tout.
MAX_ALERTS_PER_USER = 30


def is_valid_op(op: Any) -> bool:
    """``op`` est-elle une des DEUX conditions reconnues ? (PUR)"""
    return str(op or "") in OPS


def new_alert(alert_id: Any, symbol: Any, op: Any, price: Any,
             now_iso: Any) -> Dict[str, Any]:
    """Construit une alerte à la forme COMPLÈTE et stable (PUR), ARMÉE.

    Tous les champs sont TOUJOURS présents (même règle que
    ``calendar._entry`` : une forme à géométrie variable oblige chaque
    consommateur à se souvenir de quels champs existent — cf. piège #61 du
    dépôt) : ``triggered_at``/``trigger_price`` valent ``None`` tant que
    l'alerte n'a pas tiré.
    """
    return {
        "id": str(alert_id),
        "symbol": str(symbol or "").upper(),
        "op": str(op or ""),
        "price": float(price) if price is not None else None,
        "created_at": str(now_iso or ""),
        "status": STATUS_ARMED,
        "triggered_at": None,
        "trigger_price": None,
    }


def condition_met(op: Any, current_price: Optional[float],
                  level: Optional[float]) -> bool:
    """La condition d'une alerte est-elle VRAIE maintenant ? (PUR)

    Franchissement INCLUSIF (``>=``/``<=``) : un cours qui arrive PILE sur le
    niveau demandé a bien atteint ce qu'on surveillait. Cours OU niveau
    introuvable -> ``False`` — on ne déclenche jamais sur une valeur
    manquante (c'est la garde qui permet au guetteur de laisser une alerte
    ARMÉE quand le cours du jour est en panne, cf. spec A1).
    """
    if current_price is None or level is None:
        return False
    try:
        price = float(current_price)
        lvl = float(level)
    except (TypeError, ValueError):
        return False
    if op == OP_ABOVE:
        return price >= lvl
    if op == OP_BELOW:
        return price <= lvl
    return False


def active_count(alerts: Any) -> int:
    """Nombre d'alertes ARMÉES (PUR) — sert le plafond côté router. Une
    alerte déjà déclenchée ne pèse plus sur le quota : elle a fait son
    travail, elle ne surveille plus rien."""
    return sum(1 for row in (alerts or [])
              if isinstance(row, dict) and row.get("status") == STATUS_ARMED)


def trigger(alert: Dict[str, Any], current_price: Any, now_iso: str) -> Dict[str, Any]:
    """Rend une COPIE de ``alert`` passée en ``STATUS_TRIGGERED`` (PUR) — ne
    mute jamais l'entrée d'origine, l'appelant décide s'il la persiste."""
    out = dict(alert)
    out["status"] = STATUS_TRIGGERED
    out["triggered_at"] = str(now_iso or "")
    out["trigger_price"] = current_price
    return out


def _fmt_price(value: Any) -> str:
    """Nombre lisible dans un message Telegram — sans zéros inutiles, sans
    dépendre d'un format Excel/UI que ce module n'a pas à connaître."""
    try:
        text = "%.4f" % float(value)
    except (TypeError, ValueError):
        return str(value if value is not None else "?")
    return text.rstrip("0").rstrip(".") if "." in text else text


def format_trigger_message(username: str, symbol: str, op: str, level: Any,
                           current_price: Any) -> str:
    """Message Telegram sobre, SANS EMOJI (PUR) — même doctrine que
    ``newswatch.format_message``/``format_gov_message``/
    ``format_pressefi_message`` : aucun symbole décoratif, un fait, un lien
    quand il y en a un (il n'y en a pas ici, ce n'est pas une dépêche)."""
    verb = "dépassé" if op == OP_ABOVE else "franchi à la baisse"
    return (
        "[Simulateur] Alerte de prix — %s\n"
        "%s : %s a %s %s (cours actuel %s)."
        % (symbol, username or "?", symbol, verb,
           _fmt_price(level), _fmt_price(current_price))
    )
