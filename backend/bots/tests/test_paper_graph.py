"""Tests du graphe des connexions (module PUR) — 100 % hors ligne.

Aucune I/O, aucun réseau, aucune horloge implicite : ``build_graph`` reçoit son
``now``, et la seule dépendance du dehors (``whales.match_issuer``, pure elle
aussi) est empruntée par import paresseux — donc monkeypatchable.
"""
from datetime import datetime, timedelta

import pytest

from backend.bots.paper import graph

NOW = datetime(2026, 8, 26, 12, 0, 0)


def _iso(days_ago=0, hours_ago=0):
    return (NOW - timedelta(days=days_ago, hours=hours_ago)).isoformat()


def ids(nodes):
    return [node["id"] for node in nodes]


def types_of(nodes):
    return {node["id"]: node["type"] for node in nodes}


def node_by_type(built, kind):
    return [node for node in built["nodes"] if node["type"] == kind]


def build(**kwargs):
    """``build_graph`` avec des entrées vides par défaut — chaque test ne pose
    que ce qui le concerne."""
    params = {"anchors": [], "events": [], "hypotheses": [], "whale_moves": [],
              "pipeline": [], "now": NOW.isoformat(), "symbol": None}
    params.update(kwargs)
    return graph.build_graph(params["anchors"], params["events"],
                             params["hypotheses"], params["whale_moves"],
                             params["pipeline"], params["now"],
                             symbol=params["symbol"])


# --------------------------------------------------------------------------- #
# Ancres
# --------------------------------------------------------------------------- #

def test_the_three_anchor_families_become_nodes():
    built = build(
        anchors=[{"symbol": "nesn.sw", "kind": "position"},
                 {"symbol": "AAPL", "name": "Apple Inc", "kind": "watchlist"}],
        pipeline=[{"symbol": "MSFT", "name": "Microsoft", "computed_stage": "etude"}])
    assert types_of(built["nodes"]) == {"NESN.SW": "position",
                                        "AAPL": "watchlist",
                                        "MSFT": "pipeline"}
    # id = symbole en MAJUSCULES, label = nom quand on en a un, sinon symbole.
    labels = {node["id"]: node["label"] for node in built["nodes"]}
    assert labels == {"NESN.SW": "NESN.SW", "AAPL": "Apple Inc",
                      "MSFT": "Microsoft"}


def test_a_closed_pipeline_item_is_not_an_anchor():
    built = build(pipeline=[{"symbol": "MSFT", "computed_stage": "clos"}])
    assert built["nodes"] == []


def test_a_held_and_watched_symbol_is_one_node_typed_position():
    """L'argent engagé prime — mais le NOM de la watchlist est conservé, sans
    quoi aucun émetteur 13F ne rejoindrait jamais ce titre."""
    built = build(anchors=[{"symbol": "AAPL", "kind": "position"},
                           {"symbol": "AAPL", "name": "Apple Inc",
                            "kind": "watchlist"}])
    assert len(built["nodes"]) == 1
    assert built["nodes"][0]["type"] == "position"
    assert built["nodes"][0]["label"] == "Apple Inc"


def test_an_unknown_anchor_kind_falls_back_to_watchlist():
    built = build(anchors=[{"symbol": "AAPL", "kind": "n'importe quoi"},
                           {"symbol": "MSFT"}])
    assert types_of(built["nodes"]) == {"AAPL": "watchlist", "MSFT": "watchlist"}


# --------------------------------------------------------------------------- #
# Arêtes — chaque mécanisme
# --------------------------------------------------------------------------- #

def test_news_links_to_a_position_by_symbol():
    built = build(
        anchors=[{"symbol": "AAPL", "kind": "position"}],
        events=[{"ts": _iso(hours_ago=2), "symbol": "AAPL", "title": "Résultats",
                 "link": "http://n/1", "sentiment": "pos"}])
    news = node_by_type(built, "news")
    assert len(news) == 1 and news[0]["label"] == "Résultats"
    assert built["edges"] == [{"source": news[0]["id"], "target": "AAPL",
                               "type": graph.EDGE_SYMBOL, "sentiment": "pos"}]


def test_a_watch_headline_is_a_catalyst_node():
    built = build(
        anchors=[{"symbol": "AAPL", "kind": "position"}],
        events=[{"ts": _iso(hours_ago=1), "symbol": "AAPL",
                 "title": "Résultats attendus jeudi", "link": "http://n/2",
                 "sentiment": "watch"}])
    assert len(node_by_type(built, "catalyst")) == 1
    assert built["edges"][0]["sentiment"] == "watch"


def test_a_hypothesis_links_to_a_watchlist_symbol_by_ticker():
    built = build(
        anchors=[{"symbol": "AAPL", "name": "Apple Inc", "kind": "watchlist"}],
        hypotheses=[{"id": "h1", "status": "open", "created_at": _iso(days_ago=1),
                     "thesis": "Le cycle du iPhone repart", "tickers": ["AAPL", "MSFT"],
                     "risk_level": "mesure", "outcome": None}])
    hyp = node_by_type(built, "hypothesis")[0]
    assert hyp["id"] == "hyp:h1"
    assert hyp["status"] == "open" and hyp["outcome"] is None
    assert hyp["level"] == "mesure"
    # MSFT n'est pas une ancre : aucune arête inventée vers lui.
    assert built["edges"] == [{"source": "hyp:h1", "target": "AAPL",
                               "type": graph.EDGE_TICKER}]


def test_a_long_thesis_is_cut_at_sixty_characters():
    built = build(
        anchors=[{"symbol": "AAPL", "kind": "position"}],
        hypotheses=[{"id": "h1", "status": "open", "created_at": _iso(),
                     "thesis": "x" * 200, "tickers": ["AAPL"]}])
    label = node_by_type(built, "hypothesis")[0]["label"]
    assert len(label) == graph.LABEL_CAP and label.endswith("…")


def test_a_whale_move_links_through_match_issuer_on_the_real_name():
    """Le rapprochement passe par ``whales.match_issuer`` — le vrai, pas une
    copie : c'est le nom Yahoo de la watchlist qui rend « APPLE INC » lisible."""
    built = build(
        anchors=[{"symbol": "AAPL", "name": "Apple Inc", "kind": "watchlist"}],
        whale_moves=[{"manager_label": "Berkshire", "manager_id": "brk",
                      "action": "sortie", "name": "APPLE INC",
                      "quarter": "T2 2026", "fetched_at": _iso(days_ago=1)}])
    move = node_by_type(built, "whale_move")[0]
    assert move["label"] == "Berkshire · sortie · APPLE INC"
    assert move["action"] == "sortie" and move["quarter"] == "T2 2026"
    assert move["manager"] == "Berkshire" and move["symbol"] == "AAPL"
    assert built["edges"] == [{"source": move["id"], "target": "AAPL",
                               "type": graph.EDGE_ISSUER}]


def test_a_whale_move_on_an_unknown_issuer_is_dropped():
    """Aucun rapprochement -> aucun lien, et donc pas de nœud orphelin : un
    mouvement attribué au mauvais titre serait pire que pas de mouvement."""
    built = build(
        anchors=[{"symbol": "AAPL", "name": "Apple Inc", "kind": "position"}],
        whale_moves=[{"manager_label": "Berkshire", "action": "sortie",
                      "name": "OCCIDENTAL PETROLEUM CORP",
                      "fetched_at": _iso(days_ago=1)}])
    assert node_by_type(built, "whale_move") == []
    assert built["edges"] == []


def test_an_x_post_with_a_cashtag_links_to_its_anchor():
    built = build(
        anchors=[{"symbol": "TSLA", "kind": "position"}],
        events=[{"ts": _iso(hours_ago=3), "symbol": "TSLA", "src": "x",
                 "handle": "elonmusk", "title": "Production record",
                 "link": "http://x.com/p/1", "sentiment": "pos"}])
    post = node_by_type(built, "x")[0]
    assert post["handle"] == "elonmusk" and post["link"] == "http://x.com/p/1"
    assert built["edges"] == [{"source": post["id"], "target": "TSLA",
                               "type": graph.EDGE_SYMBOL, "sentiment": "pos"}]


def test_a_crypto_headline_with_a_held_symbol_links_to_it():
    built = build(
        anchors=[{"symbol": "BTC-USD", "kind": "position"}],
        events=[{"ts": _iso(hours_ago=4), "symbol": "BTC-USD", "src": "crypto",
                 "title": "Le bitcoin franchit un seuil", "link": "http://c/1",
                 "sentiment": "pos"}])
    coin = node_by_type(built, "crypto")[0]
    assert built["edges"] == [{"source": coin["id"], "target": "BTC-USD",
                               "type": graph.EDGE_SYMBOL, "sentiment": "pos"}]


# --------------------------------------------------------------------------- #
# Le pivot « monde »
# --------------------------------------------------------------------------- #

def test_a_gov_headline_without_a_symbol_hangs_on_the_world_pivot():
    built = build(
        anchors=[{"symbol": "AAPL", "kind": "position"}],
        events=[{"ts": _iso(hours_ago=2), "symbol": "GOV", "title": "Nouveaux tarifs",
                 "link": "http://g/1", "sentiment": "gov"}])
    gov = node_by_type(built, "gov")[0]
    world = node_by_type(built, graph.CONTEXT_TYPE)
    assert len(world) == 1 and world[0]["id"] == graph.WORLD_ID
    assert built["edges"] == [{"source": gov["id"], "target": graph.WORLD_ID,
                               "type": graph.EDGE_CONTEXT, "sentiment": "gov"}]
    # Le pivot n'est relié à AUCUNE ancre.
    assert not [e for e in built["edges"] if e["target"] == "AAPL"]


def test_gov_pseudo_symbol_never_attaches_to_a_real_ticker_named_gov():
    """« GOV » est le marqueur de ``newswatch`` pour le politique GLOBAL, pas un
    ticker : il ne doit jamais accrocher toute la politique du monde au titre
    d'un porteur qui s'appellerait ainsi."""
    built = build(
        anchors=[{"symbol": "GOV", "kind": "position"}],
        events=[{"ts": _iso(hours_ago=1), "symbol": "GOV", "title": "Sanctions",
                 "link": "http://g/2", "sentiment": "gov"}])
    assert built["edges"] == [{"source": node_by_type(built, "gov")[0]["id"],
                               "target": graph.WORLD_ID,
                               "type": graph.EDGE_CONTEXT, "sentiment": "gov"}]


def test_an_unsymbolised_crypto_headline_also_reaches_the_pivot():
    built = build(
        anchors=[{"symbol": "AAPL", "kind": "position"}],
        events=[{"ts": _iso(hours_ago=2), "symbol": "", "src": "crypto",
                 "title": "Le marché crypto recule", "link": "http://c/2",
                 "sentiment": "neg"}])
    assert node_by_type(built, graph.CONTEXT_TYPE)
    assert built["edges"][0]["target"] == graph.WORLD_ID


def test_a_political_x_post_stays_typed_x_and_reaches_the_pivot():
    """Le TYPE dit la provenance (c'est un post), la tonalité dit la nature
    (c'est du macro) : les deux doivent survivre."""
    built = build(
        anchors=[{"symbol": "AAPL", "kind": "position"}],
        events=[{"ts": _iso(hours_ago=1), "symbol": None, "src": "x",
                 "handle": "potus", "title": "Tarifs sur l'acier",
                 "link": "http://x.com/p/9", "sentiment": "gov"}])
    assert len(node_by_type(built, "x")) == 1
    assert built["edges"][0]["target"] == graph.WORLD_ID


def test_the_pivot_is_absent_when_nothing_hangs_on_it():
    built = build(anchors=[{"symbol": "AAPL", "kind": "position"}])
    assert node_by_type(built, graph.CONTEXT_TYPE) == []


# --------------------------------------------------------------------------- #
# Orphelins
# --------------------------------------------------------------------------- #

def test_an_info_matching_no_anchor_is_omitted():
    built = build(
        anchors=[{"symbol": "AAPL", "kind": "position"}],
        events=[{"ts": _iso(hours_ago=1), "symbol": "ZZZZ", "title": "Sans rapport",
                 "link": "http://n/9", "sentiment": "pos"}])
    assert ids(built["nodes"]) == ["AAPL"]
    assert built["edges"] == []


def test_a_hypothesis_on_no_anchor_is_omitted():
    built = build(
        anchors=[{"symbol": "AAPL", "kind": "position"}],
        hypotheses=[{"id": "h9", "status": "open", "created_at": _iso(),
                     "thesis": "Une idée sur un titre qu'on ne suit pas",
                     "tickers": ["ZZZZ"]}])
    assert ids(built["nodes"]) == ["AAPL"]


# --------------------------------------------------------------------------- #
# Fenêtre de fraîcheur
# --------------------------------------------------------------------------- #

def test_an_eight_day_old_headline_is_out_of_the_window():
    built = build(
        anchors=[{"symbol": "AAPL", "kind": "position"}],
        events=[{"ts": _iso(days_ago=8), "symbol": "AAPL", "title": "Vieux",
                 "link": "http://n/old", "sentiment": "pos"},
                {"ts": _iso(days_ago=6), "symbol": "AAPL", "title": "Récent",
                 "link": "http://n/new", "sentiment": "pos"}])
    assert [n["label"] for n in node_by_type(built, "news")] == ["Récent"]


def test_an_eight_day_old_whale_move_is_out_of_the_window():
    built = build(
        anchors=[{"symbol": "AAPL", "name": "Apple Inc", "kind": "position"}],
        whale_moves=[{"manager_label": "Berkshire", "action": "sortie",
                      "name": "APPLE INC", "fetched_at": _iso(days_ago=8)}])
    assert node_by_type(built, "whale_move") == []


def test_an_open_hypothesis_survives_any_age_a_scored_one_does_not():
    built = build(
        anchors=[{"symbol": "AAPL", "kind": "position"}],
        hypotheses=[
            {"id": "old-open", "status": "open", "created_at": _iso(days_ago=40),
             "thesis": "Toujours vivante", "tickers": ["AAPL"]},
            {"id": "fresh-scored", "status": "scored", "outcome": "hit",
             "created_at": _iso(days_ago=30), "scored_at": _iso(days_ago=2),
             "thesis": "Verdict frais", "tickers": ["AAPL"]},
            {"id": "stale-scored", "status": "scored", "outcome": "miss",
             "created_at": _iso(days_ago=40), "scored_at": _iso(days_ago=20),
             "thesis": "Verdict périmé", "tickers": ["AAPL"]},
        ])
    assert sorted(n["id"] for n in node_by_type(built, "hypothesis")) == \
        ["hyp:fresh-scored", "hyp:old-open"]


def test_a_scored_hypothesis_without_any_readable_date_is_dropped():
    built = build(
        anchors=[{"symbol": "AAPL", "kind": "position"}],
        hypotheses=[{"id": "h1", "status": "scored", "outcome": "hit",
                     "created_at": "", "scored_at": None,
                     "thesis": "Sans date", "tickers": ["AAPL"]}])
    assert node_by_type(built, "hypothesis") == []


def test_a_headline_with_an_unreadable_date_is_kept():
    """Même posture que ``convergence._within`` : mieux vaut un nœud de trop
    qu'une info perdue parce qu'une source a changé son format."""
    built = build(
        anchors=[{"symbol": "AAPL", "kind": "position"}],
        events=[{"ts": "hier matin", "symbol": "AAPL", "title": "Date illisible",
                 "link": "http://n/x", "sentiment": "neg"}])
    assert len(node_by_type(built, "news")) == 1


# --------------------------------------------------------------------------- #
# Dédoublonnage
# --------------------------------------------------------------------------- #

def test_the_same_link_seen_twice_is_one_node_and_one_edge():
    event = {"ts": _iso(hours_ago=1), "symbol": "AAPL", "title": "Résultats",
             "link": "http://n/1", "sentiment": "pos"}
    built = build(anchors=[{"symbol": "AAPL", "kind": "position"}],
                  events=[dict(event), dict(event)])
    assert len(node_by_type(built, "news")) == 1
    assert len(built["edges"]) == 1


def test_a_linkless_headline_is_deduped_on_symbol_and_title():
    event = {"ts": _iso(hours_ago=1), "symbol": "AAPL", "title": "Résultats",
             "sentiment": "pos"}
    built = build(anchors=[{"symbol": "AAPL", "kind": "position"}],
                  events=[dict(event), dict(event)])
    assert len(node_by_type(built, "news")) == 1


def test_two_moves_of_the_same_manager_on_the_same_issuer_are_one_node():
    move = {"manager_label": "Berkshire", "action": "sortie", "name": "APPLE INC",
            "fetched_at": _iso(days_ago=1)}
    built = build(anchors=[{"symbol": "AAPL", "name": "Apple Inc",
                            "kind": "position"}],
                  whale_moves=[dict(move), dict(move)])
    assert len(node_by_type(built, "whale_move")) == 1
    assert len(built["edges"]) == 1


def test_node_ids_are_unique_across_families():
    built = build(
        anchors=[{"symbol": "AAPL", "name": "Apple Inc", "kind": "position"}],
        events=[{"ts": _iso(hours_ago=1), "symbol": "AAPL", "title": "Résultats",
                 "link": "http://n/1", "sentiment": "pos"},
                {"ts": _iso(hours_ago=2), "symbol": "GOV", "title": "Tarifs",
                 "link": "http://g/1", "sentiment": "gov"}],
        hypotheses=[{"id": "h1", "status": "open", "created_at": _iso(),
                     "thesis": "T", "tickers": ["AAPL"]}],
        whale_moves=[{"manager_label": "Berkshire", "action": "sortie",
                      "name": "APPLE INC", "fetched_at": _iso(days_ago=1)}])
    node_ids = ids(built["nodes"])
    assert len(node_ids) == len(set(node_ids))


# --------------------------------------------------------------------------- #
# Branche par titre (filtre ego)
# --------------------------------------------------------------------------- #

def _two_anchor_graph(**kwargs):
    params = {
        "anchors": [{"symbol": "AAPL", "name": "Apple Inc", "kind": "position"},
                    {"symbol": "MSFT", "name": "Microsoft", "kind": "watchlist"}],
        "events": [
            {"ts": _iso(hours_ago=1), "symbol": "AAPL", "title": "Sur Apple",
             "link": "http://n/a", "sentiment": "pos"},
            {"ts": _iso(hours_ago=2), "symbol": "MSFT", "title": "Sur Microsoft",
             "link": "http://n/m", "sentiment": "neg"},
            {"ts": _iso(hours_ago=3), "symbol": "GOV", "title": "Tarifs",
             "link": "http://g/1", "sentiment": "gov"},
        ],
        "hypotheses": [{"id": "h1", "status": "open", "created_at": _iso(),
                        "thesis": "Les deux montent", "tickers": ["AAPL", "MSFT"]}],
    }
    params.update(kwargs)
    return build(**params)


def test_the_branch_keeps_the_anchor_its_neighbours_and_nothing_else():
    built = _two_anchor_graph(symbol="AAPL")
    kinds = types_of(built["nodes"])
    assert kinds["AAPL"] == "position"
    assert "MSFT" not in kinds
    assert set(kinds.values()) == {"position", "news", "hypothesis"}
    assert all(edge["target"] == "AAPL" for edge in built["edges"])
    assert len(built["edges"]) == 2


def test_the_branch_never_shows_the_world_pivot():
    built = _two_anchor_graph(symbol="AAPL")
    assert graph.WORLD_ID not in ids(built["nodes"])
    assert node_by_type(built, graph.CONTEXT_TYPE) == []


def test_the_branch_accepts_a_lowercase_symbol():
    assert ids(_two_anchor_graph(symbol="aapl")["nodes"])[0] == "AAPL"


def test_a_symbol_that_is_not_an_anchor_gives_an_empty_branch():
    """Le graphe est ancré sur ce qu'on détient, suit ou projette. Fabriquer un
    centre que la mémoire ne porte pas mettrait un nœud faux à l'écran."""
    built = _two_anchor_graph(symbol="ZZZZ")
    assert built == {"nodes": [], "edges": [], "truncated": False}


def test_a_branch_without_neighbours_is_just_the_anchor():
    built = build(anchors=[{"symbol": "AAPL", "kind": "position"}], symbol="AAPL")
    assert ids(built["nodes"]) == ["AAPL"] and built["edges"] == []


# --------------------------------------------------------------------------- #
# Plafonds
# --------------------------------------------------------------------------- #

def _many_events(count, symbol="AAPL"):
    """``count`` dépêches, la n° 0 étant la plus RÉCENTE."""
    return [{"ts": _iso(hours_ago=i + 1), "symbol": symbol,
             "title": "Dépêche %03d" % i, "link": "http://n/%03d" % i,
             "sentiment": "pos"} for i in range(count)]


def test_the_node_cap_keeps_the_most_recent_infos_and_flags_truncation():
    built = build(anchors=[{"symbol": "AAPL", "kind": "position"}],
                  events=_many_events(120))
    assert built["truncated"] is True
    assert len(built["nodes"]) == graph.MAX_NODES
    labels = [n["label"] for n in node_by_type(built, "news")]
    assert labels[0] == "Dépêche 000"                    # la plus récente
    assert "Dépêche 100" not in labels                   # les vieilles sautent


def test_the_cap_never_sacrifices_an_anchor():
    anchors = [{"symbol": "SYM%03d" % i, "kind": "position"} for i in range(90)]
    built = build(anchors=anchors, events=_many_events(20, symbol="SYM000"))
    kept = types_of(built["nodes"])
    assert sum(1 for kind in kept.values() if kind == "position") == 90
    assert node_by_type(built, "news") == []             # plus de place
    assert built["truncated"] is True


def test_a_small_graph_is_not_truncated():
    built = build(anchors=[{"symbol": "AAPL", "kind": "position"}],
                  events=_many_events(3))
    assert built["truncated"] is False
    assert len(built["nodes"]) == 4


def test_the_edge_cap_bounds_the_edges():
    """Une hypothèse par ancre, chacune reliée à 20 ancres : les arêtes
    dépassent leur plafond avant les nœuds."""
    anchors = [{"symbol": "SYM%02d" % i, "kind": "position"} for i in range(20)]
    tickers = [a["symbol"] for a in anchors]
    hypotheses = [{"id": "h%02d" % i, "status": "open", "created_at": _iso(),
                   "thesis": "Panier %d" % i, "tickers": tickers}
                  for i in range(20)]
    built = build(anchors=anchors, hypotheses=hypotheses)
    assert len(built["edges"]) == graph.MAX_EDGES
    assert built["truncated"] is True


def test_the_pivot_never_dangles_when_the_edge_cap_cuts_its_link():
    """Le pivot se décide APRÈS les deux coupes : si le plafond d'ARÊTES mange
    le lien du macro, « Monde » ne doit pas rester seul à l'écran."""
    anchors = [{"symbol": "SYM%02d" % i, "kind": "position"} for i in range(20)]
    tickers = [a["symbol"] for a in anchors]
    built = build(
        anchors=anchors,
        hypotheses=[{"id": "h%02d" % i, "status": "open", "created_at": _iso(),
                     "thesis": "Panier %d" % i, "tickers": tickers}
                    for i in range(20)],
        events=[{"ts": _iso(hours_ago=1), "symbol": "GOV", "title": "Tarifs",
                 "link": "http://g/1", "sentiment": "gov"}])
    assert len(built["edges"]) == graph.MAX_EDGES
    assert node_by_type(built, graph.CONTEXT_TYPE) == []


def test_the_pivot_disappears_when_the_cap_eats_all_its_satellites():
    """Un « Monde » solitaire ne dirait rien : il ne sort que si au moins un
    satellite survit à la coupe."""
    events = _many_events(120)
    events.append({"ts": _iso(days_ago=6), "symbol": "GOV", "title": "Vieux tarifs",
                   "link": "http://g/old", "sentiment": "gov"})
    built = build(anchors=[{"symbol": "AAPL", "kind": "position"}], events=events)
    assert node_by_type(built, graph.CONTEXT_TYPE) == []
    assert not [e for e in built["edges"] if e["target"] == graph.WORLD_ID]


# --------------------------------------------------------------------------- #
# Robustesse des entrées
# --------------------------------------------------------------------------- #

def test_everything_empty_gives_an_empty_graph():
    assert build() == {"nodes": [], "edges": [], "truncated": False}


@pytest.mark.parametrize("junk", [None, "texte", 42, {"a": 1}])
def test_non_list_inputs_are_read_as_empty(junk):
    built = graph.build_graph(junk, junk, junk, junk, junk, NOW.isoformat())
    assert built == {"nodes": [], "edges": [], "truncated": False}


def test_rows_that_are_not_dicts_are_skipped():
    built = build(anchors=["AAPL", None, {"symbol": "MSFT", "kind": "position"}],
                  events=[None, "dépêche"])
    assert ids(built["nodes"]) == ["MSFT"]


def test_an_unreadable_now_falls_back_to_the_module_clock():
    """Aucune exception, et la fenêtre reste appliquée depuis MAINTENANT."""
    built = graph.build_graph([{"symbol": "AAPL", "kind": "position"}],
                              [{"ts": datetime.utcnow().isoformat(),
                                "symbol": "AAPL", "title": "Frais",
                                "link": "http://n/1", "sentiment": "pos"}],
                              [], [], [], "pas une date")
    assert len(node_by_type(built, "news")) == 1


def test_a_missing_whales_module_only_costs_the_issuer_matching(monkeypatch):
    """Déploiement partiel : sans ``whales``, on perd les liens par nom
    d'émetteur, jamais le graphe."""
    monkeypatch.setattr(graph, "_default_matcher", lambda: None)
    built = build(
        anchors=[{"symbol": "AAPL", "name": "Apple Inc", "kind": "position"}],
        events=[{"ts": _iso(hours_ago=1), "symbol": "AAPL", "title": "Résultats",
                 "link": "http://n/1", "sentiment": "pos"}],
        whale_moves=[{"manager_label": "Berkshire", "action": "sortie",
                      "name": "APPLE INC", "fetched_at": _iso(days_ago=1)}])
    assert len(node_by_type(built, "news")) == 1
    assert node_by_type(built, "whale_move") == []


def test_a_move_that_already_carries_its_symbol_skips_the_matching(monkeypatch):
    """``convergence._collect_whale_moves`` pose déjà ``symbol`` : on l'honore
    sans redemander un rapprochement."""
    monkeypatch.setattr(graph, "_default_matcher", lambda: None)
    built = build(anchors=[{"symbol": "AAPL", "kind": "position"}],
                  whale_moves=[{"manager_label": "Berkshire", "action": "sortie",
                                "name": "APPLE INC", "symbol": "AAPL",
                                "fetched_at": _iso(days_ago=1)}])
    assert node_by_type(built, "whale_move")[0]["symbol"] == "AAPL"


def test_a_matcher_that_raises_never_breaks_the_graph(monkeypatch):
    def boom(name, candidates):
        raise RuntimeError("rapprochement cassé")

    monkeypatch.setattr(graph, "_default_matcher", lambda: boom)
    built = build(anchors=[{"symbol": "AAPL", "name": "Apple Inc",
                            "kind": "position"}],
                  whale_moves=[{"manager_label": "Berkshire", "action": "sortie",
                                "name": "APPLE INC", "fetched_at": _iso(days_ago=1)}])
    assert ids(built["nodes"]) == ["AAPL"]


def test_a_matcher_pointing_outside_the_anchors_is_ignored(monkeypatch):
    monkeypatch.setattr(graph, "_default_matcher",
                        lambda: (lambda name, candidates: "ZZZZ"))
    built = build(anchors=[{"symbol": "AAPL", "name": "Apple Inc",
                            "kind": "position"}],
                  whale_moves=[{"manager_label": "Berkshire", "action": "sortie",
                                "name": "APPLE INC", "fetched_at": _iso(days_ago=1)}])
    assert built["edges"] == []


def test_the_graph_is_deterministic():
    """Deux appels sur les mêmes entrées rendent exactement le même graphe —
    sans quoi le frontend redessinerait la toile à chaque rafraîchissement."""
    kwargs = {"anchors": [{"symbol": "AAPL", "name": "Apple Inc",
                           "kind": "position"},
                          {"symbol": "MSFT", "kind": "watchlist"}],
              "events": _many_events(10) + _many_events(10, symbol="MSFT")}
    assert build(**kwargs) == build(**kwargs)
