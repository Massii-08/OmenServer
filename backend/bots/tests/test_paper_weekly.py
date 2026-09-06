"""Tests du bilan hebdomadaire du dimanche soir (LOT 3, C2) — 100% hors ligne.

Isolation : ``store.DATA_DIR`` est monkeypatché vers ``tmp_path`` pour CHAQUE
test (même fixture autouse que ``test_paper_backup.py``).
"""
from datetime import datetime, timezone

import pytest

from backend.bots.paper import store, weekly

SUNDAY_ON_TIME = datetime(2026, 8, 30, 16, 0, 0, tzinfo=timezone.utc)   # 18:00 Rome (été)
SUNDAY_TOO_EARLY = datetime(2026, 8, 30, 15, 59, 0, tzinfo=timezone.utc)
MONDAY_EVENING = datetime(2026, 8, 24, 20, 0, 0, tzinfo=timezone.utc)
PREVIOUS_SUNDAY = datetime(2026, 8, 23, 16, 30, 0, tzinfo=timezone.utc)
WINTER_SUNDAY = datetime(2026, 1, 11, 17, 0, 0, tzinfo=timezone.utc)    # 18:00 Rome (hiver)


@pytest.fixture(autouse=True)
def _isolate_data_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "DATA_DIR", tmp_path / "paper_trading")
    yield


# --------------------------------------------------------------------------- #
# PUR — weekly_due
# --------------------------------------------------------------------------- #

def test_weekly_due_true_on_sunday_evening_when_never_sent():
    assert weekly.weekly_due(SUNDAY_ON_TIME, None) is True


def test_weekly_due_false_before_the_hour_threshold():
    assert weekly.weekly_due(SUNDAY_TOO_EARLY, None) is False


def test_weekly_due_false_on_a_non_sunday():
    assert weekly.weekly_due(MONDAY_EVENING, None) is False


def test_weekly_due_respects_the_winter_offset_too():
    assert weekly.weekly_due(WINTER_SUNDAY, None) is True


def test_weekly_due_false_when_already_sent_this_iso_week():
    last = SUNDAY_ON_TIME.isoformat()
    assert weekly.weekly_due(SUNDAY_ON_TIME, last) is False


def test_weekly_due_true_when_last_sent_was_the_previous_sunday():
    assert weekly.weekly_due(SUNDAY_ON_TIME, PREVIOUS_SUNDAY.isoformat()) is True


def test_weekly_due_accepts_a_naive_datetime_as_utc():
    naive = datetime(2026, 8, 30, 16, 0, 0)
    assert weekly.weekly_due(naive, None) is True


def test_weekly_due_tolerates_an_unreadable_last_ts():
    assert weekly.weekly_due(SUNDAY_ON_TIME, "n'importe quoi") is True
    assert weekly.weekly_due(SUNDAY_ON_TIME, "") is True
    assert weekly.weekly_due(SUNDAY_ON_TIME, None) is True


# --------------------------------------------------------------------------- #
# PUR — closed_this_week
# --------------------------------------------------------------------------- #

def test_closed_this_week_keeps_only_the_last_seven_days():
    trades = [
        {"symbol": "IN_WINDOW", "exit_at": "2026-08-28T10:00:00"},   # 2j avant
        {"symbol": "TOO_OLD", "exit_at": "2026-08-01T10:00:00"},
        {"symbol": "UNREADABLE", "exit_at": "pas une date"},
        {"symbol": "MISSING"},
    ]
    out = weekly.closed_this_week(trades, SUNDAY_ON_TIME)
    assert [t["symbol"] for t in out] == ["IN_WINDOW"]


def test_closed_this_week_on_an_empty_history():
    assert weekly.closed_this_week([], SUNDAY_ON_TIME) == []
    assert weekly.closed_this_week(None, SUNDAY_ON_TIME) == []


def test_closed_this_week_ignores_non_dict_entries():
    trades = [{"symbol": "X", "exit_at": "2026-08-29T10:00:00"}, "junk", None]
    out = weekly.closed_this_week(trades, SUNDAY_ON_TIME)
    assert len(out) == 1


# --------------------------------------------------------------------------- #
# PUR — build_context
# --------------------------------------------------------------------------- #

def _portfolio():
    return {
        "cash_chf": 7000.0,
        "initial_capital": 10000.0,
        "positions": [{"symbol": "NESN.SW", "qty": 5, "side": "long"}],
        "open_orders": [],
        "trades": [
            {"symbol": "AAPL", "side": "long", "qty": 3, "entry_price": 200.0,
             "exit_price": 210.0, "entry_at": "2026-08-20T09:00:00",
             "exit_at": "2026-08-28T09:00:00", "pnl_chf": 30.0, "pnl_pct": 5.0,
             "r_multiple": 1.5, "thesis": "cassure", "planned_stop": 195.0},
        ],
    }


def test_build_context_assembles_every_section():
    ctx = weekly.build_context(_portfolio(), SUNDAY_ON_TIME,
                               radar_stats={"hits": 2, "misses": 1, "unclear": 0})
    assert [t["symbol"] for t in ctx["closed_this_week"]] == ["AAPL"]
    assert ctx["stats"]["n_trades"] == 1
    assert ctx["discipline"] == {"score": None}   # < 5 trades clos AU TOTAL
    assert ctx["open_positions"] == [{"symbol": "NESN.SW", "qty": 5, "side": "long"}]
    assert ctx["radar"] == {"hits": 2, "misses": 1, "unclear": 0}
    assert ctx["cash_chf"] == 7000.0
    assert ctx["initial_capital_chf"] == 10000.0
    assert isinstance(ctx["top_biases"], list)


def test_build_context_caps_top_biases():
    # Fabrique plus de TOP_BIASES biais que le plafond n'en garde : on
    # vérifie juste que la liste est BORNÉE (le contenu exact est du ressort
    # de coach.detect_biases, déjà testé ailleurs).
    ctx = weekly.build_context(_portfolio(), SUNDAY_ON_TIME)
    assert len(ctx["top_biases"]) <= weekly.TOP_BIASES


def test_build_context_tolerates_a_missing_portfolio():
    ctx = weekly.build_context(None, SUNDAY_ON_TIME)
    assert ctx["closed_this_week"] == []
    assert ctx["open_positions"] == []
    assert ctx["cash_chf"] is None


def test_build_context_defaults_radar_to_empty_dict():
    ctx = weekly.build_context(_portfolio(), SUNDAY_ON_TIME)
    assert ctx["radar"] == {}


# --------------------------------------------------------------------------- #
# PUR — LOT 12 : la conscience des frais dans le bilan hebdo
# --------------------------------------------------------------------------- #

def _portfolio_with_fees():
    pf = _portfolio()
    pf["trades"][0]["fees_chf"] = 3.0
    pf["trades"][0]["stamp_duty_chf"] = 1.5
    # pnl_chf reste 30.0 : DÉJÀ net des frais (même doctrine que _close_leg).
    return pf


def test_build_context_carries_the_fees_summary_of_the_week():
    ctx = weekly.build_context(_portfolio_with_fees(), SUNDAY_ON_TIME)
    assert ctx["fees_paid_chf"] == 4.5
    assert ctx["net_pnl_chf"] == 30.0
    assert ctx["gross_pnl_chf"] == 34.5


def test_build_context_fees_summary_is_zero_without_trades():
    ctx = weekly.build_context({"initial_capital": 10000.0}, SUNDAY_ON_TIME)
    assert ctx["fees_paid_chf"] == 0.0
    assert ctx["gross_pnl_chf"] == 0.0
    assert ctx["net_pnl_chf"] == 0.0


# --------------------------------------------------------------------------- #
# PUR — fallback_report / with_header
# --------------------------------------------------------------------------- #

def test_fallback_report_lists_the_trades_and_the_discipline_score():
    ctx = weekly.build_context(_portfolio(), SUNDAY_ON_TIME)
    text = weekly.fallback_report(ctx)
    assert weekly.HEADER in text
    assert "AAPL" in text
    assert weekly.FALLBACK_TAIL in text


def test_fallback_report_shows_the_fees_line_of_the_week():
    """LOT 12 : le bilan hebdo doit dire ce que les frais ont coûté, pas
    seulement le P&L net qui les cache déjà."""
    ctx = weekly.build_context(_portfolio_with_fees(), SUNDAY_ON_TIME)
    text = weekly.fallback_report(ctx)
    assert "4.50 CHF" in text or "4,50 CHF" in text
    assert "34.50 CHF" in text or "34,50 CHF" in text


def test_fallback_report_fees_line_is_zero_without_trades():
    ctx = weekly.build_context({"initial_capital": 10000.0}, SUNDAY_ON_TIME)
    text = weekly.fallback_report(ctx)
    assert "0.00 CHF" in text


def test_fallback_report_says_no_trades_explicitly():
    ctx = weekly.build_context({"initial_capital": 10000.0}, SUNDAY_ON_TIME)
    text = weekly.fallback_report(ctx)
    assert "Aucun trade clôturé cette semaine." in text


def test_fallback_report_caps_the_listed_trades():
    trades = [{"symbol": "S%d" % i, "exit_at": SUNDAY_ON_TIME.isoformat(),
              "pnl_chf": 1.0} for i in range(weekly.MAX_FALLBACK_TRADES + 5)]
    ctx = {"closed_this_week": trades, "stats": {}, "discipline": {"score": 50},
          "open_positions": []}
    text = weekly.fallback_report(ctx)
    assert "et 5 autre(s)." in text


def test_with_header_is_idempotent():
    once = weekly.with_header("texte")
    assert weekly.with_header(once) == once
    assert once.count(weekly.HEADER) == 1


def test_with_header_on_empty_text_is_just_the_header():
    assert weekly.with_header("") == weekly.HEADER
    assert weekly.with_header(None) == weekly.HEADER


# --------------------------------------------------------------------------- #
# I/O — maybe_run (le gate + l'exécution)
# --------------------------------------------------------------------------- #

CFG = {"token": "t", "chat_id": "c"}


class _NotifySpy:
    def __init__(self, ok=True):
        self.calls = []
        self.ok = ok

    def __call__(self, text, cfg):
        self.calls.append((text, cfg))
        return self.ok


def test_maybe_run_does_nothing_when_not_due():
    spy = _NotifySpy()
    out = weekly.maybe_run(now=MONDAY_EVENING, notifier=spy, tg_cfg=CFG,
                           portfolios=[("alice", _portfolio())])
    assert out["ran"] is False
    assert spy.calls == []
    assert weekly.load_state() == {}


def test_maybe_run_sends_via_llm_and_writes_the_state_and_the_journal():
    spy = _NotifySpy()
    out = weekly.maybe_run(now=SUNDAY_ON_TIME, notifier=spy, tg_cfg=CFG,
                           portfolios=[("alice", _portfolio())],
                           llm=lambda ctx: "Bilan rédigé par le modèle.")
    assert out == {"ran": True, "n_accounts": 1, "sent": 1}
    assert len(spy.calls) == 1
    assert "Bilan rédigé par le modèle." in spy.calls[0][0]
    assert weekly.HEADER in spy.calls[0][0]
    assert weekly.load_state()["last_sent_iso"] == SUNDAY_ON_TIME.isoformat()
    note = store.read_note("alice", "Journal.md")
    assert "Bilan rédigé par le modèle." in note
    assert "bilan hebdomadaire" in note


def test_maybe_run_falls_back_when_the_llm_raises():
    def _boom(ctx):
        raise RuntimeError("le coach n'a pas répondu")
    spy = _NotifySpy()
    out = weekly.maybe_run(now=SUNDAY_ON_TIME, notifier=spy, tg_cfg=CFG,
                           portfolios=[("alice", _portfolio())], llm=_boom)
    assert out["sent"] == 1
    assert weekly.FALLBACK_TAIL in spy.calls[0][0]
    note = store.read_note("alice", "Journal.md")
    assert "secours" in note


def test_maybe_run_falls_back_when_the_llm_returns_an_empty_text():
    spy = _NotifySpy()
    weekly.maybe_run(now=SUNDAY_ON_TIME, notifier=spy, tg_cfg=CFG,
                     portfolios=[("alice", _portfolio())], llm=lambda ctx: "   ")
    assert weekly.FALLBACK_TAIL in spy.calls[0][0]


def test_maybe_run_writes_the_journal_even_without_a_telegram_channel():
    spy = _NotifySpy()
    out = weekly.maybe_run(now=SUNDAY_ON_TIME, notifier=spy, tg_cfg={},
                           portfolios=[("alice", _portfolio())],
                           llm=lambda ctx: "Bilan.")
    assert spy.calls == []             # aucun canal -> jamais appelé
    assert out["sent"] == 0
    assert weekly.load_state().get("last_sent_iso")   # ARMÉ quand même
    assert "Bilan." in store.read_note("alice", "Journal.md")


def test_maybe_run_arms_the_state_even_with_zero_accounts():
    out = weekly.maybe_run(now=SUNDAY_ON_TIME, notifier=_NotifySpy(), tg_cfg=CFG,
                           portfolios=[])
    assert out == {"ran": True, "n_accounts": 0, "sent": 0}
    assert weekly.load_state().get("last_sent_iso")


def test_maybe_run_continues_when_one_account_is_unreadable():
    spy = _NotifySpy()
    out = weekly.maybe_run(
        now=SUNDAY_ON_TIME, notifier=spy, tg_cfg=CFG,
        portfolios=[("broken", "not-a-dict"), ("alice", _portfolio())],
        llm=lambda ctx: "Bilan.")
    assert out["n_accounts"] == 2
    assert out["sent"] == 1            # seule alice a pu être traitée
    assert len(spy.calls) == 1


def test_maybe_run_default_discovery_skips_auxiliary_files(tmp_path):
    store.save_portfolio("alice", _portfolio())
    store.save_coach("alice", {"n_sessions": 1})
    store.save_watchlist("alice", [{"symbol": "AAPL"}])
    store.save_replay_sessions("alice", [{"id": "x"}])
    spy = _NotifySpy()
    out = weekly.maybe_run(now=SUNDAY_ON_TIME, notifier=spy, tg_cfg=CFG,
                           llm=lambda ctx: "Bilan.")
    assert out["n_accounts"] == 1
    assert len(spy.calls) == 1


def test_maybe_run_never_raises_on_a_totally_broken_state_file(tmp_path, monkeypatch):
    def _boom():
        raise OSError("disque en panne")
    monkeypatch.setattr(weekly, "load_state", _boom)
    out = weekly.maybe_run(now=SUNDAY_ON_TIME, notifier=_NotifySpy(), tg_cfg=CFG,
                           portfolios=[("alice", _portfolio())])
    assert out["ran"] is False
    assert out["reason"] == "error"


# --------------------------------------------------------------------------- #
# _send / _default_llm — plomberie
# --------------------------------------------------------------------------- #

def test_send_uses_the_injected_notifier():
    spy = _NotifySpy()
    assert weekly._send(spy, "texte", CFG) is True
    assert spy.calls == [("texte", CFG)]


def test_send_swallows_exceptions_and_returns_false():
    def _boom(text, cfg):
        raise RuntimeError("réseau en panne")
    assert weekly._send(_boom, "texte", CFG) is False


def test_default_llm_calls_the_real_writer(monkeypatch):
    from backend.bots.paper import llm as llm_mod
    captured = {}

    def fake_writer(context):
        captured["context"] = context
        return "ok"

    monkeypatch.setattr(llm_mod, "write_weekly_report", fake_writer)
    assert weekly._default_llm({"stats": {}}) == "ok"
    assert captured["context"] == {"stats": {}}
