"""Le « bar replay » — l'entraînement (LOT 3, A3).

Demande de l'utilisateur : « des dizaines de faux trades en une soirée ».
L'idée : montrer 60 bougies journalières RÉELLES d'un titre anonymisé, faire
choisir long/flat/short bougie après bougie sur les 20 suivantes (cachées
jusqu'au clic), puis révéler le titre et comparer le résultat au simple
buy-and-hold de la même fenêtre — le benchmark qui apprend l'humilité (un
trader qui bat rarement le hold n'a pas encore de raison de trader activement).

Module PUR au sens du dépôt : aucune I/O, aucun réseau, aucune horloge. Le
router se charge de choisir un symbole, d'aller chercher ses bougies
(``quotes.get_candles``) et de persister les sessions terminées
(``store.replay_path``).

``make_window`` a besoin d'un tirage aléatoire (quelle fenêtre de l'historique
jouer) : comme partout ailleurs dans ce dépôt pour l'horloge (``now`` injecté),
la source d'aléa (``rng``) est INJECTÉE — jamais le module ``random`` global —
pour rester 100 % testable, déterministe sous seed.

**« Pas d'anti-triche », assumé et documenté** : ``GET /replay/window`` rend
la fenêtre à révéler (``reveal``) EN MÊME TEMPS que la fenêtre visible — c'est
au CLIENT de la cacher jusqu'à la fin de la partie. Un utilisateur qui irait
lire la réponse réseau dans les outils de dev ne tricherait qu'à ses propres
dépens : c'est un outil d'entraînement personnel (un seul compte réel sur ce
serveur), pas un jeu multi-joueurs à scores comparés. Documenté ici plutôt que
caché en silence, pour que la prochaine lecture ne le redécouvre pas comme un
bug de sécurité.
"""
from typing import Any, Dict, List, Optional

# En dessous, il n'y aurait qu'une poignée de fenêtres de départ possibles
# (voire une seule) -- l'entraînement rejouerait toujours le même bout
# d'histoire. 90 = 60 visibles + 20 à révéler + une marge de départs distincts.
MIN_CANDLES = 90

DEFAULT_SHOWN = 60
DEFAULT_STEPS = 20

# Au-delà, le journal d'entraînement sert à mesurer une TENDANCE (bat-on le
# hold plus souvent qu'avant ?), pas à archiver une vie entière de parties.
MAX_REPLAY_SESSIONS = 50

# Position tenue par décision, en unités du sous-jacent (±1, jamais de levier).
_POSITION = {"buy": 1.0, "flat": 0.0, "sell": -1.0}


def _val(value: Any) -> Optional[float]:
    if value is None or isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def make_window(candles: Any, rng: Any, shown: int = DEFAULT_SHOWN,
                steps: int = DEFAULT_STEPS) -> Dict[str, List[Dict[str, Any]]]:
    """Choisit une fenêtre ALÉATOIRE de bougies journalières : ``shown``
    visibles puis ``steps`` à révéler une par une.

    ``rng`` : source d'aléa injectée (``random.Random`` ou tout objet exposant
    ``randint(a, b)``) -- PUR, jamais ``random`` global.

    Lève ``ValueError`` si moins de :data:`MIN_CANDLES` bougies sont
    disponibles -- en dessous, la fenêtre de départ serait quasi toujours la
    même, ce qui viderait l'entraînement de sa valeur (toujours le même bout
    d'histoire).
    """
    rows = [c for c in (candles or []) if isinstance(c, dict)]
    total = int(shown) + int(steps)
    if len(rows) < MIN_CANDLES:
        raise ValueError(
            "pas assez de bougies pour une session d'entraînement (%d < %d)"
            % (len(rows), MIN_CANDLES))
    if len(rows) < total:
        raise ValueError(
            "pas assez de bougies pour %d visibles + %d à révéler (%d dispo)"
            % (shown, steps, len(rows)))

    max_start = len(rows) - total
    start = int(rng.randint(0, max_start)) if max_start > 0 else 0
    return {
        "candles": rows[start:start + shown],
        "reveal": rows[start + shown:start + total],
    }


def grade(session: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Rejoue les décisions d'une session d'entraînement (PUR).

    ``session["decisions"]`` : une entrée PAR bougie révélée, chacune
    autoportante -- ``{"prev_close": <clôture juste avant>, "close": <clôture
    de cette bougie>, "action": "buy"|"flat"|"sell"}``. Une décision = la
    position tenue PENDANT cette bougie (choisie AVANT qu'elle ne soit
    révélée, comme au jeu) ; le P&L de l'étape = position x variation en % de
    ``prev_close`` à ``close``, additionné (pas composé -- une somme de petits
    mouvements en % reste lisible, un produit masquerait vite les décisions
    individuelles derrière l'effet du taux composé).

    ``hold_pnl_pct`` : simple buy-and-hold sur la MÊME fenêtre (de la clôture
    juste avant la 1ʳᵉ bougie révélée à la clôture de la dernière) -- le
    benchmark auquel comparer le résultat.

    Décisions vides ou illisibles -> zéros, jamais une exception : une session
    interrompue avant la première bougie n'est pas une erreur, juste une
    partie très courte.
    """
    rows = [d for d in ((session or {}).get("decisions") or []) if isinstance(d, dict)]
    n = len(rows)
    if n == 0:
        return {"pnl_pct": 0.0, "n_decisions": 0, "hold_pnl_pct": 0.0}

    pnl = 0.0
    for row in rows:
        prev = _val(row.get("prev_close"))
        close = _val(row.get("close"))
        pos = _POSITION.get(str(row.get("action") or "flat"), 0.0)
        if prev is None or close is None or prev == 0:
            continue
        pnl += pos * (close - prev) / prev * 100.0

    start = _val(rows[0].get("prev_close"))
    end = _val(rows[-1].get("close"))
    hold = 0.0
    if start is not None and end is not None and start != 0:
        hold = (end - start) / start * 100.0

    return {"pnl_pct": round(pnl, 2), "n_decisions": n, "hold_pnl_pct": round(hold, 2)}


def stats(sessions: Any) -> Dict[str, Any]:
    """Statistiques cumulées du journal d'entraînement (PUR) — ``GET
    /replay/stats``.

    ``beat_hold_pct`` est LE chiffre qui compte : le pourcentage de séances
    où le joueur a fait MIEUX que le simple buy-and-hold de la même fenêtre —
    en dessous de 50 %, le message est clair (trader activement n'a pas
    encore payé). Aucune séance -> tout à ``None`` (pas de moyenne sur du
    vide, même politique que ``tradestats.discipline_score``)."""
    rows = [s for s in (sessions or []) if isinstance(s, dict)]
    n = len(rows)
    if n == 0:
        return {"n": 0, "avg_pnl_pct": None, "avg_hold_pnl_pct": None,
                "beat_hold_pct": None}

    pnls = [_val(s.get("pnl_pct")) for s in rows]
    holds = [_val(s.get("hold_pnl_pct")) for s in rows]
    pnls_ok = [v for v in pnls if v is not None]
    holds_ok = [v for v in holds if v is not None]
    beats = sum(1 for p, h in zip(pnls, holds) if p is not None and h is not None and p > h)

    return {
        "n": n,
        "avg_pnl_pct": round(sum(pnls_ok) / len(pnls_ok), 2) if pnls_ok else None,
        "avg_hold_pnl_pct": round(sum(holds_ok) / len(holds_ok), 2) if holds_ok else None,
        "beat_hold_pct": round(beats / n * 100.0, 1),
    }
