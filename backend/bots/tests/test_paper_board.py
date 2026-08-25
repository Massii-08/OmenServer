"""Tests de la vue « Plan » — pipeline, scénarios, progression.

100 % hors ligne : le module ne touche ni le réseau ni le LLM, et son unique
I/O (``<user>.board.json``) est redirigée vers ``tmp_path`` par le
monkeypatch de ``store.DATA_DIR``.

Ce que ces tests protègent avant tout, c'est L'INVARIANT du tableau : les
trois dernières étapes d'un item (ordre/position/clos) sont DÉRIVÉES du
portefeuille, jamais stockées. Le jour où quelqu'un « optimise » en
persistant l'étape, ces tests tombent — et c'est le but.
"""
import pytest

from backend.bots.paper import board, llm, store

NOW = "2026-08-25T10:00:00"
BEFORE = "2026-08-01T09:00:00"
AFTER = "2026-08-26T17:30:00"


@pytest.fixture(autouse=True)
def isolated_disk(tmp_path, monkeypatch):
    """Toute écriture du module atterrit dans le répertoire du test."""
    monkeypatch.setattr(store, "DATA_DIR", tmp_path / "paper_trading")


def item(**kwargs):
    row = {"id": "i1", "symbol": "NESN.SW", "name": "Nestle SA", "thesis": "",
           "source": "moi", "stage_manual": "etude", "created_at": NOW}
    row.update(kwargs)
    return row


def portfolio(positions=(), open_orders=(), trades=()):
    return {"positions": list(positions), "open_orders": list(open_orders),
            "trades": list(trades)}


def trade(symbol="NESN.SW", exit_at=AFTER, r_multiple=1.8, **kwargs):
    row = {"symbol": symbol, "exit_at": exit_at, "entry_at": exit_at,
           "r_multiple": r_multiple}
    row.update(kwargs)
    return row


# ================================================================
#  L'ÉTAPE RÉELLE — dérivée, jamais stockée
# ================================================================

def test_the_five_stages():
    """Les cinq états, dans l'ordre de priorité du contrat."""
    empty = portfolio()
    assert board.computed_stage(item(), empty) == "etude"
    assert board.computed_stage(item(stage_manual="pret"), empty) == "pret"
    assert board.computed_stage(
        item(), portfolio(open_orders=[{"symbol": "NESN.SW"}])) == "ordre"
    assert board.computed_stage(
        item(), portfolio(positions=[{"symbol": "NESN.SW"}])) == "position"
    assert board.computed_stage(
        item(), portfolio(trades=[trade()])) == "clos"


def test_an_open_order_wins_over_a_position_and_a_past_trade():
    """Un ordre en attente est l'état le plus engageant : il passe devant."""
    pf = portfolio(open_orders=[{"symbol": "NESN.SW"}],
                   positions=[{"symbol": "NESN.SW"}],
                   trades=[trade()])
    assert board.computed_stage(item(), pf) == "ordre"
    pf["open_orders"] = []
    assert board.computed_stage(item(), pf) == "position"


def test_symbols_are_compared_without_case():
    """Yahoo écrit NESN.SW, le LLM écrit parfois nesn.sw — deux lignes pour le
    même titre casseraient tout le tableau."""
    pf = portfolio(positions=[{"symbol": "nesn.sw"}])
    assert board.computed_stage(item(symbol="NESN.SW"), pf) == "position"
    assert board.computed_stage(item(symbol=" nesn.sw "), pf) == "position"


def test_a_trade_older_than_the_item_does_not_close_it():
    """Un trade d'avant la note ne dit RIEN de l'idée notée ce matin — sinon
    toute idée sur un titre déjà tradé naîtrait « close »."""
    pf = portfolio(trades=[trade(exit_at=BEFORE)])
    assert board.computed_stage(item(created_at=NOW), pf) == "etude"


def test_a_trade_without_a_readable_date_is_ignored():
    """On ne peut pas prouver qu'il est postérieur : on ne marque pas « clos »."""
    pf = portfolio(trades=[trade(exit_at="", entry_at="")])
    assert board.computed_stage(item(), pf) == "etude"


def test_an_unknown_manual_stage_falls_back_to_study():
    assert board.computed_stage(item(stage_manual="ordre"), portfolio()) == "etude"
    assert board.computed_stage(item(stage_manual="n'importe quoi"),
                                portfolio()) == "etude"


def test_a_broken_portfolio_never_raises():
    assert board.computed_stage(item(), None) == "etude"
    assert board.computed_stage(item(), {"positions": "pas une liste"}) == "etude"
    assert board.computed_stage(None, portfolio()) == "etude"


def test_pipeline_view_carries_the_r_of_the_last_closing_trade():
    pf = portfolio(trades=[trade(exit_at="2026-08-26T09:00:00", r_multiple=0.5),
                           trade(exit_at="2026-08-27T09:00:00", r_multiple=-1.0)])
    row = board.pipeline_view([item()], pf)[0]
    assert row["computed_stage"] == "clos"
    assert row["last_r"] == -1.0


def test_pipeline_view_leaves_last_r_none_when_nothing_is_closed():
    row = board.pipeline_view([item()], portfolio())[0]
    assert row["computed_stage"] == "etude"
    assert row["last_r"] is None


def test_pipeline_view_keeps_last_r_none_when_no_stop_was_planned():
    """``r_multiple`` vaut ``None`` quand aucun stop n'était planifié : la
    métrique n'a alors aucun sens, on n'invente pas un chiffre."""
    pf = portfolio(trades=[trade(r_multiple=None)])
    row = board.pipeline_view([item()], pf)[0]
    assert row["computed_stage"] == "clos"
    assert row["last_r"] is None


# ================================================================
#  PIPELINE — dédoublonnage, cap, étapes manuelles
# ================================================================

def test_add_then_read_back():
    added = board.add_pipeline_item("tester", "nesn.sw", "Défensive", "moi",
                                    name="Nestle SA", now_iso=NOW)
    assert added["symbol"] == "NESN.SW"           # normalisé
    assert added["source"] == "moi"
    assert added["stage_manual"] == "etude"
    assert added["duplicate"] is False
    assert [i["symbol"] for i in board.load_board("tester")["pipeline"]] == ["NESN.SW"]


def test_the_board_file_is_0600():
    board.add_pipeline_item("tester", "NESN.SW", "", "moi", now_iso=NOW)
    mode = board.board_path("tester").stat().st_mode & 0o777
    assert mode == 0o600


def test_an_empty_symbol_is_refused():
    with pytest.raises(ValueError):
        board.add_pipeline_item("tester", "   ", "", "moi")


def test_an_unknown_source_falls_back_to_mine():
    added = board.add_pipeline_item("tester", "NESN.SW", "", "n'importe quoi",
                                    now_iso=NOW)
    assert added["source"] == "moi"


def test_the_same_active_symbol_is_never_doubled():
    """Le coach peut reproposer AAPL trois jours de suite : une seule ligne."""
    board.add_pipeline_item("tester", "AAPL", "Momentum", "coach", now_iso=NOW)
    again = board.add_pipeline_item("tester", "aapl", "Momentum bis", "coach",
                                    now_iso=AFTER)
    assert again["duplicate"] is True
    assert again["thesis"] == "Momentum"          # l'existant, pas le nouveau
    assert len(board.load_board("tester")["pipeline"]) == 1


def test_a_closed_symbol_can_come_back():
    """Un titre tradé ET refermé peut revenir : c'est une NOUVELLE idée sur le
    même titre, pas un doublon."""
    board.add_pipeline_item("tester", "AAPL", "1re idée", "moi", now_iso=NOW)
    store.save_portfolio("tester", portfolio(trades=[trade(symbol="AAPL")]))
    again = board.add_pipeline_item("tester", "AAPL", "2e idée", "moi", now_iso=AFTER)
    assert again["duplicate"] is False
    assert len(board.load_board("tester")["pipeline"]) == 2


def test_the_cap_purges_the_oldest_closed_first():
    """Le cap est une borne dure ; les items dont la boucle est bouclée
    partent en premier."""
    store.save_portfolio("tester", portfolio(trades=[trade(symbol="OLD")]))
    data = board.blank_board()
    # 1 item CLOS très ancien + le reste actif, jusqu'au cap.
    data["pipeline"].append({"id": "old", "symbol": "OLD", "stage_manual": "etude",
                             "created_at": "2026-01-01T00:00:00", "source": "moi"})
    for i in range(board.MAX_PIPELINE - 1):
        data["pipeline"].append({"id": "a%d" % i, "symbol": "A%d" % i,
                                 "stage_manual": "etude",
                                 "created_at": "2026-02-01T00:%02d:00" % (i + 1),
                                 "source": "moi"})
    board.save_board("tester", data)

    board.add_pipeline_item("tester", "NEW", "", "moi", now_iso=AFTER)
    symbols = [i["symbol"] for i in board.load_board("tester")["pipeline"]]
    assert len(symbols) == board.MAX_PIPELINE
    assert "OLD" not in symbols                   # le clos est parti
    assert "NEW" in symbols
    assert "A0" in symbols                        # aucun actif n'a été touché


def test_the_cap_falls_back_to_the_oldest_when_nothing_is_closed():
    """Sans repli, un pipeline plein d'items actifs refuserait en SILENCE
    toute idée nouvelle."""
    data = board.blank_board()
    for i in range(board.MAX_PIPELINE):
        data["pipeline"].append({"id": "a%d" % i, "symbol": "A%d" % i,
                                 "stage_manual": "etude",
                                 "created_at": "2026-02-01T00:%02d:00" % (i + 1),
                                 "source": "moi"})
    board.save_board("tester", data)

    board.add_pipeline_item("tester", "NEW", "", "moi", now_iso=AFTER)
    symbols = [i["symbol"] for i in board.load_board("tester")["pipeline"]]
    assert len(symbols) == board.MAX_PIPELINE
    assert "A0" not in symbols                    # le plus ancien
    assert "NEW" in symbols


def test_set_stage_moves_between_the_two_manual_steps():
    added = board.add_pipeline_item("tester", "NESN.SW", "", "moi", now_iso=NOW)
    updated = board.set_stage("tester", added["id"], "pret")
    assert updated["stage_manual"] == "pret"
    assert board.load_board("tester")["pipeline"][0]["stage_manual"] == "pret"


def test_set_stage_refuses_a_derived_stage():
    """« position » se mérite : la déclarer à la main rendrait le tableau
    menteur."""
    added = board.add_pipeline_item("tester", "NESN.SW", "", "moi", now_iso=NOW)
    for forbidden in ("position", "ordre", "clos", ""):
        with pytest.raises(ValueError):
            board.set_stage("tester", added["id"], forbidden)


def test_set_stage_on_an_unknown_item_returns_none():
    assert board.set_stage("tester", "nope", "pret") is None


def test_remove_pipeline_item():
    added = board.add_pipeline_item("tester", "NESN.SW", "", "moi", now_iso=NOW)
    assert board.remove_pipeline_item("tester", added["id"]) is True
    assert board.load_board("tester")["pipeline"] == []
    assert board.remove_pipeline_item("tester", added["id"]) is False


# ================================================================
#  LECTURE TOLÉRANTE
# ================================================================

def test_a_missing_board_reads_blank():
    assert board.load_board("tester") == {"pipeline": [], "scenarios": []}


def test_a_corrupt_board_reads_blank_and_is_kept_aside():
    path = board.board_path("tester")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{ pas du json", encoding="utf-8")
    assert board.load_board("tester") == {"pipeline": [], "scenarios": []}
    assert path.with_name(path.name + ".corrupt").is_file()


def test_a_board_of_the_wrong_shape_reads_blank():
    path = board.board_path("tester")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('["une liste"]', encoding="utf-8")
    assert board.load_board("tester") == {"pipeline": [], "scenarios": []}


def test_an_invalid_username_is_refused():
    with pytest.raises(ValueError):
        board.board_path("../evil")


# ================================================================
#  SCÉNARIOS — normalisation, résolution, bornes
# ================================================================

def raw_tree(n_branches=2, children=0):
    return {
        "title": "La Fed baisse-t-elle en septembre ?",
        "context": "Deux phrases de contexte.",
        "branches": [
            {"label": "chemin %d" % i, "prob": "haute", "consequence": "ça bouge",
             "plays": [{"ticker": "iwm", "direction": "up"}],
             "children": [{"label": "sous-chemin", "prob": "faible",
                           "children": [{"label": "trop profond"}]}
                          for _ in range(children)]}
            for i in range(n_branches)
        ],
    }


def test_normalize_tree_posts_ids_and_statuses_server_side():
    tree = board.normalize_tree(raw_tree(), NOW)
    assert tree["status"] == "active"
    assert tree["created_at"] == tree["updated_at"] == NOW
    assert len(tree["id"]) == 8
    assert all(len(b["id"]) == 8 for b in tree["branches"])
    assert all(b["status"] == "open" for b in tree["branches"])


def test_normalize_tree_clamps_depth_to_two_levels():
    tree = board.normalize_tree(raw_tree(children=1), NOW)
    child = tree["branches"][0]["children"][0]
    assert child["label"] == "sous-chemin"
    assert child["children"] == []                # le 3e niveau est coupé


def test_normalize_tree_clamps_the_branch_count():
    tree = board.normalize_tree(raw_tree(n_branches=9), NOW)
    assert len(tree["branches"]) == board.MAX_BRANCHES


def test_normalize_tree_drops_a_branch_without_a_label_alone():
    raw = raw_tree()
    raw["branches"].append({"prob": "haute"})
    tree = board.normalize_tree(raw, NOW)
    assert len(tree["branches"]) == 2


def test_normalize_tree_survives_garbage():
    tree = board.normalize_tree("pas un dict", NOW)
    assert tree["branches"] == []
    assert tree["title"] == "Scénarios"


def test_resolve_branch_is_recursive():
    tree = board.normalize_tree(raw_tree(children=1), NOW)
    child_id = tree["branches"][0]["children"][0]["id"]
    assert board.resolve_branch(tree, child_id, "happened") is True
    assert tree["branches"][0]["children"][0]["status"] == "happened"
    assert tree["branches"][0]["status"] == "open"     # le parent n'a pas bougé


def test_resolve_branch_on_a_top_branch():
    tree = board.normalize_tree(raw_tree(), NOW)
    assert board.resolve_branch(tree, tree["branches"][1]["id"], "invalidated") is True
    assert tree["branches"][1]["status"] == "invalidated"


def test_resolve_branch_unknown_id():
    tree = board.normalize_tree(raw_tree(), NOW)
    assert board.resolve_branch(tree, "nope", "happened") is False
    assert board.resolve_branch(tree, "", "happened") is False


def test_resolve_branch_refuses_to_reopen():
    """Ré-ouvrir une branche jugée effacerait la seule chose qui a de la
    valeur : la trace de ce qu'on avait prévu."""
    tree = board.normalize_tree(raw_tree(), NOW)
    for forbidden in ("open", "", "annulé"):
        with pytest.raises(ValueError):
            board.resolve_branch(tree, tree["branches"][0]["id"], forbidden)


def test_only_three_trees_stay_active():
    for i in range(4):
        board.add_scenario("tester", raw_tree(),
                           "2026-08-%02dT10:00:00" % (20 + i))
    trees = board.load_board("tester")["scenarios"]
    assert len(trees) == 4
    active = [t for t in trees if t["status"] == "active"]
    archived = [t for t in trees if t["status"] == "archived"]
    assert len(active) == board.MAX_ACTIVE_TREES
    assert len(archived) == 1
    assert archived[0]["created_at"] == "2026-08-20T10:00:00"   # le plus vieux


def test_archives_are_bounded():
    for i in range(board.MAX_ARCHIVED_TREES + board.MAX_ACTIVE_TREES + 4):
        board.add_scenario("tester", raw_tree(), "2026-06-%02dT10:00:00" % (i + 1))
    archived = [t for t in board.load_board("tester")["scenarios"]
                if t["status"] == "archived"]
    assert len(archived) == board.MAX_ARCHIVED_TREES
    assert "2026-06-01T10:00:00" not in [t["created_at"] for t in archived]


def test_resolve_scenario_branch_persists_and_stamps():
    tree = board.add_scenario("tester", raw_tree(), NOW)
    branch_id = tree["branches"][0]["id"]
    updated = board.resolve_scenario_branch("tester", tree["id"], branch_id,
                                            "happened", AFTER)
    assert updated["updated_at"] == AFTER
    stored = board.load_board("tester")["scenarios"][0]
    assert stored["branches"][0]["status"] == "happened"


def test_resolve_scenario_branch_returns_none_when_absent():
    tree = board.add_scenario("tester", raw_tree(), NOW)
    assert board.resolve_scenario_branch("tester", "nope", "x", "happened", AFTER) is None
    assert board.resolve_scenario_branch("tester", tree["id"], "nope",
                                         "happened", AFTER) is None


def test_archive_scenario_never_deletes():
    tree = board.add_scenario("tester", raw_tree(), NOW)
    archived = board.archive_scenario("tester", tree["id"], AFTER)
    assert archived["status"] == "archived"
    assert len(board.load_board("tester")["scenarios"]) == 1
    assert board.archive_scenario("tester", "nope", AFTER) is None


def test_scenarios_view_puts_the_active_ones_first():
    for i in range(4):
        board.add_scenario("tester", raw_tree(), "2026-08-%02dT10:00:00" % (20 + i))
    view = board.scenarios_view(board.load_board("tester"))
    assert [t["status"] for t in view] == ["active", "active", "active", "archived"]
    # actifs du plus récent au plus ancien
    assert view[0]["created_at"] == "2026-08-23T10:00:00"


def test_scenarios_view_is_capped():
    for i in range(8):
        board.add_scenario("tester", raw_tree(), "2026-08-%02dT10:00:00" % (10 + i))
    assert len(board.scenarios_view(board.load_board("tester"))) == 5
    assert len(board.scenarios_view(board.load_board("tester"), cap=2)) == 2


# ================================================================
#  PROGRESSION — recalculée, jamais stockée
# ================================================================

def test_learning_summary_on_a_real_profile():
    profile = {
        "lessons_passed": ["l1", "l2", "l2"],          # dédoublonné
        "arena_history": [{"week": "2026-W33", "id": "c1"},
                          {"week": "2026-W34", "id": "c2"}],
        "bias_history": {"no_stop": {"count": 3}, "oversized": {"count": 1}},
        "resolved_biases": [{"code": "revenge_trade", "resolved_at": NOW}],
        "milestones": [{"key": "first_10_trades", "reached_at": NOW}],
    }
    trades = [{"pnl_chf": 100.0, "r_multiple": 2.0},
              {"pnl_chf": -50.0, "r_multiple": -1.0}]
    rows = [{"week": "2026-W33", "status": "done"},
            {"week": "2026-W34", "status": "failed"}]

    summary = board.learning_summary(profile, trades, lessons_total=8,
                                     initial_capital=10000.0, arena_rows=rows)
    assert summary["lessons"] == {"passed": 2, "total": 8}
    assert summary["arena"] == {"accepted": 2, "done": 1}
    assert summary["biases"] == {"active": 2, "resolved": 1}
    assert summary["milestones"] == [{"key": "first_10_trades", "reached_at": NOW}]
    assert summary["n_trades"] == 2
    assert summary["expectancy_r"] == 0.5


def test_learning_summary_on_an_empty_profile():
    """Un compte neuf doit rendre un tableau lisible, jamais un 500."""
    from backend.bots.paper import coach as coach_mod
    summary = board.learning_summary(coach_mod.empty_profile(), [])
    assert summary["lessons"] == {"passed": 0, "total": 8}
    assert summary["arena"] == {"accepted": 0, "done": 0}
    assert summary["biases"] == {"active": 0, "resolved": 0}
    assert summary["milestones"] == []
    assert summary["n_trades"] == 0
    assert summary["expectancy_r"] is None


def test_learning_summary_survives_a_garbage_profile():
    summary = board.learning_summary(
        {"lessons_passed": "pas une liste", "arena_history": 3,
         "bias_history": [], "resolved_biases": None, "milestones": "non"},
        "pas une liste")
    assert summary["lessons"]["passed"] == 0
    assert summary["arena"] == {"accepted": 0, "done": 0}
    assert summary["biases"] == {"active": 0, "resolved": 0}
    assert summary["milestones"] == []
    assert summary["n_trades"] == 0


def test_learning_summary_does_not_invent_arena_wins():
    """Sans l'historique ÉVALUÉ, ``done`` reste à 0 : le profil ne STOCKE pas
    le verdict d'un défi (le compter depuis lui serait une branche morte)."""
    profile = {"arena_history": [{"week": "2026-W33", "id": "c1", "status": "done"}]}
    summary = board.learning_summary(profile, [])
    assert summary["arena"] == {"accepted": 1, "done": 0}


# ================================================================
#  BORNES PARTAGÉES AVEC LE PROMPT
# ================================================================

def test_the_prompt_and_the_storage_agree_on_the_bounds():
    """Un prompt qui promet 4 branches à un stockage qui n'en garde que 3
    perdrait la dernière EN SILENCE."""
    assert llm.SCENARIO_MIN_BRANCHES == board.MIN_BRANCHES
    assert llm.SCENARIO_MAX_BRANCHES == board.MAX_BRANCHES
    assert llm.SCENARIO_MAX_DEPTH == board.MAX_DEPTH
    assert llm.SCENARIO_MAX_PLAYS == board.MAX_PLAYS
    assert llm.SCENARIO_PROBS == board.BRANCH_PROBS
    assert llm.SCENARIO_DIRECTIONS == board.PLAY_DIRECTIONS
