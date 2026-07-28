"""Horloge des marchés — `now` injecté, aucun accès réseau ni horloge système."""
from pulse.clock import market_state
from pulse.quotes import MarketData

# Séance fictive DAX : 09:00 → 17:30 CEST le 2026-07-28 (epoch UTC)
START = 1785222000
END = 1785252600


def _md(start=START, end=END):
    return MarketData(
        symbol="^GDAXI", name="DAX", currency="EUR", tz_name="Europe/Berlin",
        price=25000.0, prev_close=24900.0,
        regular_start=start, regular_end=end, market_time=None, candles=[],
    )


def test_open_during_session():
    st = market_state(_md(), START + 3600)
    assert st.status == "open"
    assert st.closes_at == END
    assert st.opens_at is None


def test_closed_before_session_has_opens_at():
    st = market_state(_md(), START - 1800)
    assert st.status == "closed"
    assert st.opens_at == START


def test_closed_after_session():
    st = market_state(_md(), END + 60)
    assert st.status == "closed"
    assert st.opens_at is None
    assert st.closes_at == END


def test_unknown_without_trading_period():
    st = market_state(_md(start=None, end=None), START)
    assert st.status == "unknown"


def test_local_time_uses_market_timezone():
    # 12:00 UTC le 2026-07-28 = 14:00 à Berlin (CEST) et 21:00 à Tokyo
    noon_utc = 1785240000
    assert market_state(_md(), noon_utc).local_time == "14:00"
    tokyo = _md()
    tokyo.tz_name = "Asia/Tokyo"
    assert market_state(tokyo, noon_utc).local_time == "21:00"


def test_session_hours_are_exposed_in_local_time():
    """L'heure de séance (stable) permet d'afficher « riapre alle 09:00 » sans
    inventer une DATE de réouverture (jours fériés)."""
    st = market_state(_md(), END + 60)
    assert st.status == "closed"
    assert st.opens_at is None          # on ne devine pas le jour
    assert st.session_open == "09:00"   # mais l'heure, oui
    assert st.session_close == "17:30"


def test_session_hours_absent_when_period_unknown():
    st = market_state(_md(start=None, end=None), START)
    assert st.session_open is None and st.session_close is None
