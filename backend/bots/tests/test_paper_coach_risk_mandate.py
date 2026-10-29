"""Le coach est mesuré contre SON mandat de risque (3 %), les humains restent à 2 %."""
from backend.bots import paper_router as pr
from backend.bots.paper import coach, coach_trader, tradestats
from backend.bots.tests.test_paper_router import make_client

THESIS = "Une thèse écrite avant l'entrée, assez longue pour compter"


def _trade(**kw):
    # risque = |100-95| * 50 = 250 CHF = 2,5 % de 10 000
    t = {"symbol": "X", "side": "long", "qty": 50, "entry_price": 100.0,
         "exit_price": 105.0, "entry_at": "2026-06-01T10:00:00",
         "exit_at": "2026-06-01T12:00:00", "fees_chf": 1.0,
         "stamp_duty_chf": 0.0, "pnl_chf": 250.0, "pnl_pct": 5.0,
         "r_multiple": 1.0, "thesis": THESIS, "exit_reason": "target",
         "planned_stop": 95.0, "fx_rate": 1.0}
    t.update(kw)
    return t


def _oversized(biases):
    return [b for b in biases if b["code"] == "oversized"]


def test_discipline_pure_human_25_fautif_coach_respecte():
    trades = [_trade() for _ in range(5)]
    human = tradestats.discipline_score(trades, 10000.0)
    assert human["components"]["risk_respected"]["pct"] == 0.0
    assert human["components"]["risk_respected"]["limit_pct"] == 2.0
    mandate = tradestats.discipline_score(trades, 10000.0, 3.0)
    assert mandate["components"]["risk_respected"]["pct"] == 100.0
    assert mandate["components"]["risk_respected"]["limit_pct"] == 3.0


def test_oversized_pure_human_25_fautif_coach_respecte():
    trades = [_trade()]
    assert len(_oversized(coach.detect_biases(trades, [], 10000.0))) == 1
    assert _oversized(coach.detect_biases(trades, [], 10000.0,
                                          risk_limit_pct=3.0)) == []
    orders = [{"symbol": "O", "risk_chf": 250.0}]
    assert len(_oversized(coach.detect_biases([], orders, 10000.0))) == 1
    assert _oversized(coach.detect_biases([], orders, 10000.0,
                                          risk_limit_pct=3.0)) == []
    # au-dessus du mandat : toujours fautif
    big = [{"symbol": "O", "risk_chf": 350.0}]
    assert len(_oversized(coach.detect_biases([], big, 10000.0,
                                              risk_limit_pct=3.0))) == 1


def test_risk_limit_for_ne_vise_que_le_coach():
    assert pr._risk_limit_for(coach_trader.COACH_USERNAME) == coach_trader.MAX_RISK_PCT
    assert pr._risk_limit_for("tester") is None


def _seed(username):
    portfolio = pr._ensure_coach_account() \
        if username == coach_trader.COACH_USERNAME else pr._load(username)
    portfolio.trades = [pr.models.Trade.from_dict(_trade()) for _ in range(5)]
    pr._save(username, portfolio)


def test_route_coach_trader_applique_3_pct(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    _seed(coach_trader.COACH_USERNAME)
    body = c.get("/api/paper/coach-trader").json()
    comp = body["discipline"]["components"]["risk_respected"]
    assert comp["pct"] == 100.0 and comp["limit_pct"] == 3.0


def test_route_discipline_humain_reste_a_2_pct(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    _seed("tester")
    comp = c.get("/api/paper/discipline").json()["components"]["risk_respected"]
    assert comp["pct"] == 0.0 and comp["limit_pct"] == 2.0


def test_route_discipline_compte_coach_applique_3_pct(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    monkeypatch.setattr(coach_trader, "COACH_USERNAME", "tester")
    _seed("tester")
    comp = c.get("/api/paper/discipline").json()["components"]["risk_respected"]
    assert comp["pct"] == 100.0 and comp["limit_pct"] == 3.0


def test_route_coach_biais_oversized_selon_le_compte(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    _seed("tester")
    body = c.get("/api/paper/coach").json()
    assert len(_oversized(body["biases"])) == 1          # humain : 2,5 % fautif
    monkeypatch.setattr(coach_trader, "COACH_USERNAME", "tester")
    body = c.get("/api/paper/coach").json()
    assert _oversized(body["biases"]) == []              # mandat 3 % : respecté
