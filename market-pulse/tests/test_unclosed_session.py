"""Régression : la séance dont la clôture n'est pas encore consolidée.

Découvert au run réel du 2026-07-28 sur ^N225 : la bougie du jour arrive avec
`open` renseigné et `close: null` (Yahoo n'a pas encore consolidé la clôture
quotidienne, alors que la séance est finie et que `regularMarketPrice` est à
jour). L'ancien parseur jetait cette bougie entière → la référence de clôture
reculait d'une séance → variation du jour FAUSSE (-6,11 % affiché au lieu de
-3,95 % réel) et gap du jour introuvable.

La fixture `chart_n225_unclosed.json` est la réponse Yahoo brute de ce moment.
"""
import json
import os

from pulse.config import Instrument
from pulse.gaps import all_gaps, latest_gap
from pulse.quotes import parse_chart
from pulse.snapshot import build_snapshot

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")


def _load(name):
    with open(os.path.join(FIXTURES, name)) as f:
        return json.load(f)


RAW = _load("chart_n225_unclosed.json")

# Valeurs lues dans la fixture (réelles) :
OPEN_28 = 64539.921875        # ouverture du 2026-07-28
CLOSE_27 = 64931.19140625     # clôture du 2026-07-27
CLOSE_23 = 66422.6015625      # clôture du 2026-07-23 (l'ancienne référence, fausse)
PRICE = 62364.92              # regularMarketPrice au moment de la capture


def test_open_only_candle_is_kept():
    """Une bougie qui a une ouverture mais pas encore de clôture est CONSERVÉE."""
    md = parse_chart(RAW)
    last = md.candles[-1]
    assert last.open == OPEN_28
    assert last.close is None


def test_fully_null_candle_is_still_dropped():
    """Une date sans aucune donnée (férié / trou) reste écartée."""
    md = parse_chart(RAW)
    raw_points = len(RAW["chart"]["result"][0]["timestamp"])
    # 10 points bruts, 1 entièrement nul (2026-07-24) → 9 bougies gardées
    assert len(md.candles) == raw_points - 1


def test_prev_close_is_the_last_consolidated_close():
    """La référence de variation est la dernière clôture DISPONIBLE avant la
    bougie courante — pas une clôture vieille de quatre séances."""
    snap = build_snapshot(
        lambda s: RAW,
        [Instrument("^N225", "Nikkei 225 (Tokyo)", "asia", "index")],
        1785283000,
    )
    m = snap["markets"][0]
    assert m["prev_close"] == CLOSE_27
    assert m["prev_close"] != CLOSE_23
    expected = round((PRICE - CLOSE_27) / CLOSE_27 * 100.0, 2)
    assert m["change_pct"] == expected
    assert m["change_pct"] == -3.95  # et non -6.11


def test_latest_gap_uses_the_unclosed_session():
    """Le gap du jour se calcule dès l'ouverture connue, sans attendre la
    clôture consolidée."""
    md = parse_chart(RAW)
    g = latest_gap(md.candles, md.tz_name)
    assert g is not None
    assert g.date == "2026-07-28"
    assert g.open == OPEN_28
    assert g.prev_close == CLOSE_27
    assert g.gap_pct == round((OPEN_28 - CLOSE_27) / CLOSE_27 * 100.0, 2)


def test_gap_carries_the_reference_date():
    """Le gap expose la date de la clôture de référence : le rapport peut dire
    « rispetto alla chiusura del 27/07 » au lieu de laisser croire à la veille."""
    md = parse_chart(RAW)
    g = latest_gap(md.candles, md.tz_name)
    assert g.prev_date == "2026-07-27"


def test_all_gaps_skips_pairs_without_a_reference_close():
    """Aucun gap fantôme : une paire dont la clôture précédente manque est
    sautée (pas de gap calculé contre None)."""
    md = parse_chart(RAW)
    gaps = all_gaps(md.candles, md.tz_name)
    assert all(g.prev_close is not None for g in gaps)
    # la dernière paire calculable est bien celle du 28
    assert gaps[-1].date == "2026-07-28"
