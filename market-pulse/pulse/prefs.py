"""Tes préférences — un seul fichier JSON, lisible et modifiable à la main.

    data/market_pulse/prefs.json

Tout est optionnel : sans fichier, le bot tourne avec des valeurs sensées. Tu
n'écris que ce que tu veux changer.

    {
      "borse":  ["euronext", "nyse", "jpx"],
      "titoli": {"euronext": ["RACE.MI", "ASML.AS"], "nyse": ["NKE"]},
      "opzioni": {
        "reddit": true, "bluesky": true, "x": false,
        "x_account": ["CNBC", "Reuters"],
        "sintesi": true, "scoperte": true, "quaderno": true,
        "max_notizie": 10
      }
    }

Deux principes :

- **Une clé inconnue ne casse rien** et n'est pas silencieusement ignorée : elle
  est signalée dans `warnings`. Une faute de frappe (« bourse » au lieu de
  « borse ») doit se voir, pas se perdre.
- **Une valeur invalide retombe sur le défaut** et le dit, plutôt que de faire
  tomber le run du matin.
"""
import io
import json
import os
from typing import Any, Dict, List, Optional, Tuple

DEFAULT_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "data", "market_pulse", "prefs.json")

# Les trois places qui couvrent la journée : Europe (Milan est dedans), Wall
# Street, Tokyo. Modifiable — c'est justement le but du fichier.
DEFAULT_BORSE = ["euronext", "nyse", "jpx"]

DEFAULT_OPZIONI = {
    "reddit": True,
    "bluesky": True,
    "x": False,              # marche, mais c'est la route la plus fragile
    # Comptes FINANCE seulement. Mesuré au premier run réel : le fil général de
    # Reuters faisait remonter « Detained Ugandan opposition figure is
    # unconscious » sous le nom de la Borsa di Milano. Un fil de rédaction
    # générale n'a pas sa place dans un briefing de marché.
    "x_account": ["CNBC", "MarketWatch"],
    "sintesi": True,         # la synthèse en italien par le LLM
    "scoperte": True,        # la liste de nouveaux titres apparus
    "quaderno": True,        # écrire la note dans le coffre Obsidian
    "max_notizie": 10,
}

_KNOWN_TOP = {"borse", "titoli", "opzioni"}
_MAX_BORSE = 10


def _known_exchange_ids() -> List[str]:
    from .exchanges import DEFAULT_EXCHANGES
    return [e.id for e in DEFAULT_EXCHANGES]


def validate(raw: Optional[Dict[str, Any]]) -> Tuple[Dict[str, Any], List[str]]:
    """Rend (préférences propres, avertissements). Ne lève jamais."""
    warnings = []          # type: List[str]
    raw = raw if isinstance(raw, dict) else {}
    if raw and not isinstance(raw, dict):
        warnings.append("le fichier ne contient pas un objet JSON")

    for key in raw:
        if key not in _KNOWN_TOP:
            warnings.append("clé inconnue ignorée : %r (attendu %s)"
                            % (key, ", ".join(sorted(_KNOWN_TOP))))

    known = _known_exchange_ids()
    borse = raw.get("borse")
    if borse is None:
        borse = list(DEFAULT_BORSE)
    elif not isinstance(borse, list):
        warnings.append("« borse » doit être une liste — valeur par défaut utilisée")
        borse = list(DEFAULT_BORSE)
    else:
        clean = []
        for b in borse:
            if b in known and b not in clean:
                clean.append(b)
            elif b not in known:
                warnings.append("bourse inconnue ignorée : %r" % b)
        if not clean:
            warnings.append("aucune bourse valide — valeur par défaut utilisée")
            clean = list(DEFAULT_BORSE)
        if len(clean) > _MAX_BORSE:
            warnings.append("plus de %d bourses : les suivantes sont ignorées" % _MAX_BORSE)
            clean = clean[:_MAX_BORSE]
        borse = clean

    titoli = {}
    raw_titoli = raw.get("titoli")
    if raw_titoli is not None and not isinstance(raw_titoli, dict):
        warnings.append("« titoli » doit être un objet {bourse: [symboles]}")
    elif isinstance(raw_titoli, dict):
        for venue, syms in raw_titoli.items():
            if venue not in known:
                warnings.append("titoli : bourse inconnue %r" % venue)
                continue
            if not isinstance(syms, list):
                warnings.append("titoli[%r] doit être une liste" % venue)
                continue
            kept = [str(s).strip() for s in syms if str(s).strip()]
            if kept:
                titoli[venue] = kept

    opzioni = dict(DEFAULT_OPZIONI)
    raw_opz = raw.get("opzioni")
    if raw_opz is not None and not isinstance(raw_opz, dict):
        warnings.append("« opzioni » doit être un objet")
    elif isinstance(raw_opz, dict):
        for key, value in raw_opz.items():
            if key not in DEFAULT_OPZIONI:
                warnings.append("option inconnue ignorée : %r" % key)
                continue
            expected = DEFAULT_OPZIONI[key]
            if isinstance(expected, bool):
                if isinstance(value, bool):
                    opzioni[key] = value
                else:
                    warnings.append("option %r : vrai/faux attendu" % key)
            elif isinstance(expected, int):
                try:
                    n = int(value)
                except (TypeError, ValueError):
                    warnings.append("option %r : nombre attendu" % key)
                else:
                    opzioni[key] = max(1, min(50, n))
            elif isinstance(expected, list):
                if isinstance(value, list):
                    opzioni[key] = [str(v).strip() for v in value if str(v).strip()]
                else:
                    warnings.append("option %r : liste attendue" % key)

    return {"borse": borse, "titoli": titoli, "opzioni": opzioni}, warnings


def load(path: Optional[str] = None) -> Tuple[Dict[str, Any], List[str]]:
    """Préférences du disque. Sans fichier, les défauts — et ce n'est pas une
    erreur : le bot doit tourner dès l'installation."""
    path = path or DEFAULT_PATH
    if not os.path.isfile(path):
        clean, warnings = validate(None)
        return clean, warnings
    try:
        raw = json.load(io.open(path, encoding="utf-8"))
    except (OSError, ValueError) as e:
        clean, warnings = validate(None)
        warnings.insert(0, "fichier illisible (%s) — valeurs par défaut utilisées"
                        % type(e).__name__)
        return clean, warnings
    return validate(raw)


def save(prefs: Dict[str, Any], path: Optional[str] = None) -> Dict[str, Any]:
    """Valide PUIS écrit : une config cassée ne doit jamais atterrir sur le
    disque, elle serait rechargée chaque matin."""
    path = path or DEFAULT_PATH
    clean, _warnings = validate(prefs)
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    with io.open(path, "w", encoding="utf-8") as f:
        f.write(json.dumps(clean, ensure_ascii=False, indent=1) + "\n")
    return clean


def write_example(path: Optional[str] = None) -> str:
    """Écrit un fichier d'exemple COMMENTÉ à côté du vrai, pour qu'on sache quoi
    changer sans lire le code."""
    path = (path or DEFAULT_PATH) + ".esempio"
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    body = json.dumps({
        "_come_usare": "Copia questo file in prefs.json e modifica cio che vuoi. "
                       "Tutto e opzionale.",
        "_borse_disponibili": _known_exchange_ids(),
        "borse": list(DEFAULT_BORSE),
        "titoli": {"euronext": ["RACE.MI", "ASML.AS"], "nyse": ["NKE"]},
        "opzioni": dict(DEFAULT_OPZIONI),
    }, ensure_ascii=False, indent=1)
    with io.open(path, "w", encoding="utf-8") as f:
        f.write(body + "\n")
    return path
