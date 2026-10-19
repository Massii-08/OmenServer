"""Configuration d'un scan : validation (PURE) + défauts persistés.

``validate`` ne lève JAMAIS : une valeur hors bornes est ramenée dans les
bornes, une valeur illisible retombe sur le défaut, un marché inconnu est
écarté — et CHAQUE correction laisse un avertissement. Une faute de frappe doit
se voir, pas se perdre (même doctrine que ``pulse.prefs.validate``).

Les défauts vivent dans ``data/stock_scanner/defaults.json`` : le dernier
réglage lancé devient le réglage proposé la fois suivante.
"""
import json
import os
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from backend.bots.stockscan import markets as mk

_PROJECT_ROOT = Path(__file__).resolve().parents[3]
# Relu à CHAQUE appel (les tests le redirigent vers tmp_path).
DATA_DIR = _PROJECT_ROOT / "data" / "stock_scanner"
DEFAULTS_NAME = "defaults.json"

WINDOWS_H = (24, 48, 72)
LANGS = ("fr", "en", "it")

DEFAULTS: Dict[str, Any] = {
    "markets": list(mk.DEFAULT_MARKETS),
    "min_cap_meur": 1000,
    "min_value_meur": 5,
    "window_h": 48,
    "top_n": 25,
    "shortlist": 40,
    "exclude_red": False,
    "lang": "fr",
}

# (min, max) des champs numériques — l'UI les lit via GET /config.
LIMITS: Dict[str, Tuple[float, float]] = {
    "min_cap_meur": (50, 500000),
    "min_value_meur": (0, 10000),
    # top_n ne peut pas dépasser la borne de la présélection : la présélection
    # est poussée à top_n, et une borne supérieure à 80 la ferait osciller
    # 100 -> 80 -> 100 à chaque validation (rapport de test réel du 19/10).
    "top_n": (5, 80),
    "shortlist": (10, 80),
}

_INT_FIELDS = ("top_n", "shortlist")


def _number(value: Any) -> Optional[float]:
    if isinstance(value, bool):
        return None
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    if out != out or out in (float("inf"), float("-inf")):
        return None
    return out


def validate(raw: Any) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    """Config brute (éventuellement partielle) -> ``(config propre, avertissements)``.

    Avertissements : ``{"code": "unknown_market", "value": …}``,
    ``{"code": "clamped", "field": …, "value": …, "used": …}``,
    ``{"code": "bad_value", "field": …, "value": …, "used": …}``,
    ``{"code": "default_markets"}``, ``{"code": "unknown_key", "field": …}``.
    """
    src = raw if isinstance(raw, dict) else {}
    clean: Dict[str, Any] = {}
    warnings: List[Dict[str, Any]] = []

    for key in src:
        if key not in DEFAULTS:
            warnings.append({"code": "unknown_key", "field": str(key)})

    # --- marchés ----------------------------------------------------------
    raw_markets = src.get("markets", DEFAULTS["markets"])
    if isinstance(raw_markets, str):
        raw_markets = [p for p in raw_markets.split(",")]
    chosen: List[str] = []
    if isinstance(raw_markets, (list, tuple)):
        for item in raw_markets:
            market = mk.by_id(item)
            if market is None:
                warnings.append({"code": "unknown_market", "value": str(item)})
                continue
            if market.id not in chosen:
                chosen.append(market.id)
    if not chosen:
        chosen = list(DEFAULTS["markets"])
        if "markets" in src:
            warnings.append({"code": "default_markets"})
    clean["markets"] = chosen

    # --- nombres bornés ---------------------------------------------------
    for field, (lo, hi) in LIMITS.items():
        default = DEFAULTS[field]
        if field not in src:
            clean[field] = default
            continue
        value = _number(src.get(field))
        if value is None:
            warnings.append({"code": "bad_value", "field": field,
                             "value": src.get(field), "used": default})
            clean[field] = default
            continue
        used = min(max(value, lo), hi)
        if used != value:
            warnings.append({"code": "clamped", "field": field,
                             "value": src.get(field), "used": used})
        if field in _INT_FIELDS:
            used = int(round(used))
        elif float(used).is_integer():
            used = int(used)
        clean[field] = used

    # --- fenêtre des news ---------------------------------------------------
    window = _number(src.get("window_h", DEFAULTS["window_h"]))
    if window is None or int(window) not in WINDOWS_H or window != int(window):
        if "window_h" in src:
            warnings.append({"code": "bad_value", "field": "window_h",
                             "value": src.get("window_h"), "used": DEFAULTS["window_h"]})
        clean["window_h"] = DEFAULTS["window_h"]
    else:
        clean["window_h"] = int(window)

    # --- booléen ----------------------------------------------------------
    excl = src.get("exclude_red", DEFAULTS["exclude_red"])
    if isinstance(excl, bool):
        clean["exclude_red"] = excl
    else:
        warnings.append({"code": "bad_value", "field": "exclude_red",
                         "value": excl, "used": DEFAULTS["exclude_red"]})
        clean["exclude_red"] = DEFAULTS["exclude_red"]

    # --- langue de l'Excel --------------------------------------------------
    lang = src.get("lang", DEFAULTS["lang"])
    lang = lang.strip().lower() if isinstance(lang, str) else lang
    if lang in LANGS:
        clean["lang"] = lang
    else:
        warnings.append({"code": "bad_value", "field": "lang",
                         "value": src.get("lang"), "used": DEFAULTS["lang"]})
        clean["lang"] = DEFAULTS["lang"]

    # La présélection ne peut pas être plus courte que la liste rendue.
    if clean["shortlist"] < clean["top_n"]:
        warnings.append({"code": "clamped", "field": "shortlist",
                         "value": clean["shortlist"], "used": clean["top_n"]})
        clean["shortlist"] = clean["top_n"]

    return clean, warnings


def defaults_path() -> Path:
    return Path(DATA_DIR) / DEFAULTS_NAME


def load_defaults(path: Optional[Path] = None) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    """Les défauts enregistrés (validés), ou les défauts d'usine. Ne lève jamais."""
    target = Path(path) if path else defaults_path()
    try:
        with open(str(target), "r", encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, ValueError):
        return dict(DEFAULTS, markets=list(DEFAULTS["markets"])), []
    return validate(raw)


def _atomic_write_json(path: Path, data: Any) -> None:
    """JSON atomique, NÉ en 0o600 (jamais ``open()`` puis ``chmod()``)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.parent / (".%s.tmp-%d" % (path.name, os.getpid()))
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.fchmod(fd, 0o600)
    except (AttributeError, OSError):
        pass
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(str(tmp), str(path))
    except Exception:
        try:
            os.remove(str(tmp))
        except OSError:
            pass
        raise


def save_defaults(cfg: Any, path: Optional[Path] = None) -> Dict[str, Any]:
    """Valide PUIS écrit (une config cassée serait reproposée à chaque fois)."""
    clean, _ = validate(cfg)
    _atomic_write_json(Path(path) if path else defaults_path(), clean)
    return clean
