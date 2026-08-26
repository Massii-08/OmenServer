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
              "pipeline": [], "now": NOW.isoformat(), "symbol": None,
              "reddit_trends": None}
    params.update(kwargs)
    return graph.build_graph(params["anchors"], params["events"],
                             params["hypotheses"], params["whale_moves"],
                             params["pipeline"], params["now"],
                             symbol=params["symbol"],
                             reddit_trends=params["reddit_trends"])


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


def test_a_neutral_headline_reaches_its_anchor_but_never_colours_the_edge():
    """Depuis le 26/08 ``newswatch`` garde quelques titres NEUTRES par symbole
    (sans eux la branche presse était VIDE : 0 event mesuré sur le compte
    réel). Ils font un nœud « news » comme les autres, mais leur arête sort
    SANS tonalité — un lien qui ne dit rien ne doit pas se peindre."""
    built = build(
        anchors=[{"symbol": "AAPL", "kind": "position"}],
        events=[{"ts": _iso(hours_ago=2), "symbol": "AAPL",
                 "title": "Apple nomme un directeur financier",
                 "link": "http://n/n1", "sentiment": graph.NEUTRAL_SENTIMENT,
                 "muted": True}])
    news = node_by_type(built, "news")
    assert len(news) == 1 and news[0]["sentiment"] == "neutral"
    assert built["edges"] == [{"source": news[0]["id"], "target": "AAPL",
                               "type": graph.EDGE_SYMBOL}]


def test_a_neutral_headline_appears_in_the_branch_of_its_symbol():
    built = build(
        anchors=[{"symbol": "AAPL", "kind": "position"}],
        events=[{"ts": _iso(hours_ago=2), "symbol": "AAPL", "title": "Neutre",
                 "link": "http://n/n1", "sentiment": graph.NEUTRAL_SENTIMENT}],
        symbol="AAPL")
    assert [n["label"] for n in node_by_type(built, "news")] == ["Neutre"]
    assert "sentiment" not in built["edges"][0]


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


def test_a_hypothesis_on_no_anchor_joins_the_radar_grove():
    """Le « Canada invisible » (mesure du 26/08) : les paris du radar sur des
    tickers non détenus n'apparaissaient NULLE PART. Ils sont du premier rang —
    ils rejoignent leur propre bosquet, avec leurs tickers en meta."""
    built = build(
        anchors=[{"symbol": "AAPL", "kind": "position"}],
        hypotheses=[{"id": "h9", "status": "open", "created_at": _iso(),
                     "thesis": "Le rail canadien profite du blé",
                     "tickers": ["CNI", "CP"]}])
    hyp = node_by_type(built, "hypothesis")[0]
    assert hyp["id"] == "hyp:h9" and hyp["meta"] == {"tickers": ["CNI", "CP"]}
    assert graph.RADAR_ID in ids(built["nodes"])
    assert built["edges"] == [{"source": "hyp:h9", "target": graph.RADAR_ID,
                               "type": graph.EDGE_CONTEXT}]


def test_a_hypothesis_with_an_anchored_ticker_stays_a_branch():
    """Un ticker ancré -> la branche, comme avant : le bosquet radar est le
    RECOURS des orphelines, pas un nouveau passage obligé."""
    built = build(
        anchors=[{"symbol": "AAPL", "kind": "position"}],
        hypotheses=[{"id": "h1", "status": "open", "created_at": _iso(),
                     "thesis": "Le cycle du iPhone repart",
                     "tickers": ["AAPL", "ZZZZ"]}])
    assert graph.RADAR_ID not in ids(built["nodes"])
    assert built["edges"] == [{"source": "hyp:h1", "target": "AAPL",
                               "type": graph.EDGE_TICKER}]


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


def test_a_grove_is_never_starved_by_the_branches():
    """Le budget du bosquet est PRIS À PART : 120 dépêches de branche saturent
    le plafond, la seule annonce politique garde quand même sa place et son
    pivot. C'est l'autre moitié de la mesure du 26/08 — avant, le décor et le
    sujet se disputaient les mêmes 80 places, dans les deux sens."""
    events = _many_events(120)
    events.append({"ts": _iso(days_ago=6), "symbol": "GOV", "title": "Vieux tarifs",
                   "link": "http://g/old", "sentiment": "gov"})
    built = build(anchors=[{"symbol": "AAPL", "kind": "position"}], events=events)
    assert built["truncated"] is True                    # les branches, elles, coupent
    assert [n["label"] for n in node_by_type(built, "gov")] == ["Vieux tarifs"]
    assert [e for e in built["edges"] if e["target"] == graph.WORLD_ID]
    assert graph.WORLD_ID in ids(built["nodes"])


# --------------------------------------------------------------------------- #
# Sous-plafonds PAR BOSQUET + agrégat
#
# La mesure du 26/08 sur le compte réel : ``_build_graph("Massii08")`` rendait
# 81 nœuds dont 79 annonces politiques, 1 ancre et 1 pivot, ``truncated: true``.
# Le décor avait mangé le sujet.
# --------------------------------------------------------------------------- #

def _many_gov(count):
    """``count`` annonces politiques, la n° 0 étant la plus RÉCENTE."""
    return [{"ts": _iso(hours_ago=i + 1), "symbol": "GOV",
             "title": "Annonce %03d" % i, "link": "http://g/%03d" % i,
             "sentiment": "gov"} for i in range(count)]


def aggregates(built):
    return [n for n in built["nodes"] if n["type"] == graph.AGGREGATE_TYPE]


def test_the_measured_scenario_a_grove_no_longer_eats_the_whole_graph():
    """79 gov + 1 ancre : le bosquet se réduit à 12 + un agrégat « +67 », les
    branches restent entières, et rien n'est tronqué — l'agrégat DIT ce qu'il
    reste, donc rien n'a été perdu en silence."""
    built = build(anchors=[{"symbol": "AAPL", "kind": "position"}],
                  events=_many_gov(79) + _many_events(3))

    assert len(node_by_type(built, "gov")) == graph.MAX_GROVE
    assert aggregates(built) == [{"id": "agg:monde", "type": "aggregate",
                                  "label": "+67 autres", "symbol": "", "ts": "",
                                  "meta": {"count": 67}}]
    assert len(node_by_type(built, "news")) == 3        # branches intactes
    assert built["truncated"] is False
    assert graph.WORLD_ID in ids(built["nodes"])


def test_the_aggregate_hangs_on_its_pivot_and_the_overflow_carries_no_edge():
    built = build(events=_many_gov(20))
    world_edges = [e for e in built["edges"] if e["target"] == graph.WORLD_ID]
    # 12 satellites + l'agrégat, jamais les 8 laissés dehors.
    assert len(world_edges) == graph.MAX_GROVE + 1
    assert world_edges[-1] == {"source": "agg:monde", "target": graph.WORLD_ID,
                               "type": graph.EDGE_CONTEXT}
    assert len(node_by_type(built, "gov")) == graph.MAX_GROVE


def test_the_grove_keeps_the_most_recent():
    built = build(events=_many_gov(20))
    labels = [n["label"] for n in node_by_type(built, "gov")]
    assert labels[0] == "Annonce 000"                   # la plus récente
    assert "Annonce 019" not in labels                  # la plus vieille saute


def test_a_grove_just_at_its_cap_has_no_aggregate():
    built = build(events=_many_gov(graph.MAX_GROVE))
    assert len(node_by_type(built, "gov")) == graph.MAX_GROVE
    assert aggregates(built) == []


def test_each_grove_has_its_OWN_budget():
    """Les bosquets ne se partagent pas un pot commun : « monde » saturé ne
    coûte pas une place à « foule », ni au « radar »."""
    built = build(
        events=_many_gov(40),
        reddit_trends={"SYM%02d" % i: {"count": 50 - i, "prev": 0}
                       for i in range(5)},
        hypotheses=[{"id": "h%d" % i, "status": "open", "created_at": _iso(),
                     "thesis": "Pari %d" % i, "tickers": ["ZZZ%d" % i]}
                    for i in range(4)])
    assert len(node_by_type(built, "gov")) == graph.MAX_GROVE
    assert len(node_by_type(built, graph.TREND_TYPE)) == 5
    assert len(node_by_type(built, "hypothesis")) == 4
    assert {n["id"] for n in node_by_type(built, graph.CONTEXT_TYPE)} == {
        graph.WORLD_ID, graph.CROWD_ID, graph.RADAR_ID}


def test_a_saturated_grove_never_costs_an_anchor():
    """La règle intangible tient aussi avec les bosquets : 90 ancres restent 90
    ancres, quoi qu'il arrive à côté."""
    anchors = [{"symbol": "SYM%03d" % i, "kind": "position"} for i in range(90)]
    built = build(anchors=anchors, events=_many_gov(50))
    assert sum(1 for k in types_of(built["nodes"]).values()
               if k == "position") == 90
    assert len(node_by_type(built, "gov")) == graph.MAX_GROVE


# --------------------------------------------------------------------------- #
# Le bosquet du radar (hypothèses sans ticker ancré)
# --------------------------------------------------------------------------- #

def _hyp(id_, status="open", thesis=None, days_ago=0, tickers=("ZZZZ",)):
    row = {"id": id_, "status": status, "thesis": thesis or "Thèse %s" % id_,
           "tickers": list(tickers), "created_at": _iso(days_ago=days_ago)}
    if status != "open":
        row["scored_at"] = _iso(days_ago=days_ago)
    return row


def test_the_radar_grove_shows_open_first_then_the_freshest_verdicts():
    built = build(hypotheses=[
        _hyp("vieux_verdict", status="scored", days_ago=5),
        _hyp("frais_verdict", status="scored", days_ago=1),
        _hyp("ouverte", days_ago=20)])
    assert [n["id"] for n in node_by_type(built, "hypothesis")] == [
        "hyp:ouverte", "hyp:frais_verdict", "hyp:vieux_verdict"]


def test_the_radar_grove_is_capped_and_aggregates_the_rest():
    built = build(hypotheses=[_hyp("h%02d" % i, days_ago=i) for i in range(20)])
    assert len(node_by_type(built, "hypothesis")) == graph.MAX_GROVE
    assert aggregates(built) == [{"id": "agg:radar", "type": "aggregate",
                                  "label": "+8 autres", "symbol": "", "ts": "",
                                  "meta": {"count": 8}}]


def test_the_branch_never_shows_the_radar_pivot():
    built = build(anchors=[{"symbol": "AAPL", "kind": "position"}],
                  hypotheses=[_hyp("h9")], symbol="AAPL")
    assert ids(built["nodes"]) == ["AAPL"]
    assert graph.RADAR_ID not in ids(built["nodes"])


def test_the_radar_pivot_is_absent_without_any_orphan_hypothesis():
    built = build(anchors=[{"symbol": "AAPL", "kind": "position"}],
                  hypotheses=[_hyp("h1", tickers=["AAPL"])])
    assert node_by_type(built, graph.CONTEXT_TYPE) == []


def test_a_hypothesis_without_tickers_carries_no_meta():
    built = build(hypotheses=[{"id": "h0", "status": "open",
                               "created_at": _iso(), "thesis": "Sans mesure"}])
    assert "meta" not in node_by_type(built, "hypothesis")[0]


def test_the_groves_are_deterministic():
    kwargs = {"anchors": [{"symbol": "AAPL", "kind": "position"}],
              "events": _many_gov(20),
              "hypotheses": [_hyp("h%02d" % i, days_ago=i % 3)
                             for i in range(20)],
              "reddit_trends": {"GME": {"count": 9, "prev": 0},
                                "TSLA": {"count": 9, "prev": 2}}}
    assert build(**kwargs) == build(**kwargs)


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


# --------------------------------------------------------------------------- #
# Le bosquet de la foule (tendances Reddit)
# --------------------------------------------------------------------------- #

def crowd_edges(built):
    return [e for e in built["edges"] if e["target"] == graph.CROWD_ID]


def test_a_reddit_trend_hangs_on_its_own_pivot():
    """Un ticker dont la foule parle a sa place à l'écran même si le
    portefeuille ne le connaît pas : c'est là qu'on découvre un titre."""
    built = build(anchors=[{"symbol": "AAPL", "kind": "position"}],
                  reddit_trends={"GME": {"count": 42, "prev": 3}})
    trend = node_by_type(built, graph.TREND_TYPE)[0]
    assert trend["id"] == "rt:GME" and trend["label"] == "GME ×42"
    assert trend["symbol"] == "GME"
    assert trend["meta"] == {"count": 42, "prev": 3}

    pivot = node_by_type(built, graph.CONTEXT_TYPE)
    assert len(pivot) == 1 and pivot[0]["id"] == graph.CROWD_ID
    assert crowd_edges(built) == [{"source": "rt:GME", "target": graph.CROWD_ID,
                                   "type": graph.EDGE_CONTEXT}]
    # Le pivot de la foule n'est relié à AUCUNE ancre.
    assert not [e for e in built["edges"] if e["target"] == "AAPL"]


def test_a_trend_on_an_anchor_also_gets_an_edge_to_that_anchor():
    """« EN PLUS » : la tendance reste dans son bosquet ET rejoint la branche
    du titre — c'est là qu'elle éclaire une décision."""
    built = build(anchors=[{"symbol": "AAPL", "kind": "position"}],
                  reddit_trends={"AAPL": {"count": 9, "prev": 1}})
    assert crowd_edges(built)
    assert {"source": "rt:AAPL", "target": "AAPL",
            "type": graph.EDGE_SYMBOL} in built["edges"]


def test_the_branch_shows_the_trend_but_never_the_crowd_pivot():
    built = build(anchors=[{"symbol": "AAPL", "kind": "position"}],
                  reddit_trends={"AAPL": {"count": 9, "prev": 1}},
                  symbol="AAPL")
    assert ids(built["nodes"]) == ["AAPL", "rt:AAPL"]
    assert built["edges"] == [{"source": "rt:AAPL", "target": "AAPL",
                               "type": graph.EDGE_SYMBOL}]
    assert graph.CROWD_ID not in ids(built["nodes"])


def test_the_crowd_pivot_is_absent_without_any_trend():
    built = build(anchors=[{"symbol": "AAPL", "kind": "position"}])
    assert node_by_type(built, graph.CONTEXT_TYPE) == []


def test_the_grove_is_capped():
    trends = {"SYM%02d" % i: {"count": 50 - i, "prev": 0} for i in range(30)}
    built = build(reddit_trends=trends)
    grove = node_by_type(built, graph.TREND_TYPE)
    assert len(grove) == graph.MAX_TRENDS
    # Les PLUS mentionnés, pas les premiers venus.
    assert grove[0]["id"] == "rt:SYM00"


def test_a_trend_without_mentions_is_not_a_trend():
    built = build(reddit_trends={"GME": {"count": 0, "prev": 12}})
    assert built["nodes"] == []


def test_a_deformed_trend_state_never_breaks_the_graph():
    for bad in (None, "cassé", {"GME": "pas un dict"}, {"": {"count": 5}},
                {"GME": {"count": "beaucoup"}}):
        built = build(anchors=[{"symbol": "AAPL", "kind": "position"}],
                      reddit_trends=bad)
        assert ids(built["nodes"]) == ["AAPL"]


def test_the_grove_is_deterministic():
    kwargs = {"anchors": [{"symbol": "AAPL", "kind": "position"}],
              "reddit_trends": {"AAPL": {"count": 9, "prev": 1},
                                "GME": {"count": 9, "prev": 0},
                                "TSLA": {"count": 40, "prev": 2}}}
    assert build(**kwargs) == build(**kwargs)


# --------------------------------------------------------------------------- #
# Les dépêches Reddit (src "reddit")
# --------------------------------------------------------------------------- #

def test_a_reddit_headline_keeps_its_own_type():
    built = build(anchors=[{"symbol": "AAPL", "kind": "position"}],
                  events=[{"ts": _iso(hours_ago=2), "symbol": "AAPL",
                           "src": "reddit", "title": "AAPL to the moon",
                           "link": "http://r/1", "sentiment": "crowd"}])
    assert len(node_by_type(built, "reddit")) == 1
    assert built["edges"][0]["target"] == "AAPL"


def test_an_orphan_reddit_headline_is_omitted_not_pivoted():
    """Un post Reddit n'est pas du macro : il parle d'un titre, simplement pas
    d'un titre qu'on suit. Il suit donc la règle des orphelins — omis."""
    built = build(anchors=[{"symbol": "AAPL", "kind": "position"}],
                  events=[{"ts": _iso(hours_ago=2), "symbol": "GME",
                           "src": "reddit", "title": "GME squeeze",
                           "link": "http://r/2", "sentiment": "crowd"}])
    assert ids(built["nodes"]) == ["AAPL"]
    assert built["edges"] == []


def test_a_gov_headline_naming_a_held_title_reaches_that_title():
    """Depuis que ``newswatch`` reconnaît les entreprises, une annonce politique
    peut porter un vrai ticker : elle doit alors rejoindre la BRANCHE du titre,
    et non le pivot « monde » où personne n'allait la chercher."""
    built = build(anchors=[{"symbol": "NVDA", "kind": "position"}],
                  events=[{"ts": _iso(hours_ago=2), "symbol": "NVDA",
                           "title": "Tarifs sur les puces Nvidia",
                           "link": "http://g/9", "sentiment": "gov"}])
    gov = node_by_type(built, "gov")[0]
    assert built["edges"] == [{"source": gov["id"], "target": "NVDA",
                               "type": graph.EDGE_SYMBOL, "sentiment": "gov"}]
    assert graph.WORLD_ID not in ids(built["nodes"])
    # …et elle est bien visible depuis la branche de ce titre.
    branch = build(anchors=[{"symbol": "NVDA", "kind": "position"}],
                   events=[{"ts": _iso(hours_ago=2), "symbol": "NVDA",
                            "title": "Tarifs sur les puces Nvidia",
                            "link": "http://g/9", "sentiment": "gov"}],
                   symbol="NVDA")
    assert len(node_by_type(branch, "gov")) == 1


def test_a_gov_headline_naming_an_unheld_title_still_reaches_the_world_pivot():
    """La règle du macro ne change PAS : une annonce politique reste du macro,
    même quand elle nomme une entreprise qu'on ne suit pas. Elle rejoint le
    pivot au lieu d'être omise comme une dépêche orpheline."""
    built = build(anchors=[{"symbol": "AAPL", "kind": "position"}],
                  events=[{"ts": _iso(hours_ago=2), "symbol": "NVDA",
                           "title": "Tarifs sur les puces Nvidia",
                           "link": "http://g/9", "sentiment": "gov"}])
    assert built["edges"] == [{"source": node_by_type(built, "gov")[0]["id"],
                               "target": graph.WORLD_ID,
                               "type": graph.EDGE_CONTEXT, "sentiment": "gov"}]


# --------------------------------------------------------------------------- #
# Les deux volets MONDE : économie (src "eco") et écologie (src "climat")
#
# « Grosse partie des infos c'est que politique — il y a aussi l'économique,
# l'écologique. » Ils ont leur FAMILLE, distincte de « gov » : une décision de
# la Fed n'est pas une annonce politique, et les mélanger rendrait le rameau
# « Politique » aussi illisible qu'avant.
# --------------------------------------------------------------------------- #

def _world(src, symbol=None, title="Inflation surges", link="http://w/1",
           sentiment="neg", hours_ago=2):
    return {"ts": _iso(hours_ago=hours_ago), "symbol": symbol, "title": title,
            "link": link, "sentiment": sentiment, "src": src}


@pytest.mark.parametrize("src", ["eco", "climat"])
def test_a_world_headline_keeps_its_own_type_and_family(src):
    """La PROVENANCE nomme le nœud — la tonalité, elle, est celle de tout le
    monde (pos/neg/watch), donc elle ne peut pas le faire."""
    built = build(events=[_world(src)])
    node = node_by_type(built, src)[0]
    assert node["sentiment"] == "neg"        # …et pas « gov »
    assert graph._family_of(node) == src
    assert src in graph.INFO_TYPES


@pytest.mark.parametrize("src", ["eco", "climat"])
def test_an_orphan_world_headline_reaches_the_world_pivot(src):
    """« L'inflation américaine accélère » ne nomme aucun titre et concerne
    tout le portefeuille : c'est du macro, comme la politique et la crypto."""
    built = build(anchors=[{"symbol": "AAPL", "kind": "position"}],
                  events=[_world(src)])
    assert built["edges"] == [{"source": node_by_type(built, src)[0]["id"],
                               "target": graph.WORLD_ID,
                               "type": graph.EDGE_CONTEXT, "sentiment": "neg"}]
    assert src in graph.PIVOT_TYPES


@pytest.mark.parametrize("src", ["eco", "climat"])
def test_a_world_headline_naming_a_held_title_reaches_that_title(src):
    """C'est ``entities`` de bout en bout : la veille a posé le symbole, la
    toile le rattache à la branche du titre au lieu du pivot."""
    built = build(anchors=[{"symbol": "NVDA", "kind": "position"}],
                  events=[_world(src, symbol="NVDA")])
    node = node_by_type(built, src)[0]
    assert built["edges"] == [{"source": node["id"], "target": "NVDA",
                               "type": graph.EDGE_SYMBOL, "sentiment": "neg"}]
    assert graph.WORLD_ID not in ids(built["nodes"])


def test_the_world_families_are_three_distinct_ones():
    """Politique, économie, écologie : trois familles, trois rameaux. Le
    frontend peut leur donner trois couleurs."""
    families = {graph._family_of({"type": kind})
                for kind in ("gov", "eco", "climat")}
    assert families == {"gov", "eco", "climat"}


def test_a_world_headline_lands_in_the_world_grove_list():
    listed = grove(graph.WORLD_ID, events=[
        _world("eco", link="http://w/e"),
        _world("climat", title="Drought destroys wheat crops",
               link="http://w/c", hours_ago=3)])
    assert [item["type"] for item in listed["items"]] == ["eco", "climat"]
    assert listed["total"] == 2


# --------------------------------------------------------------------------- #
# La LISTE complète d'un bosquet (``build_grove``)
#
# Doctrine : « quand on ouvre, on voit tout ». Le dessin garde ses douze, la
# masse passe en liste — sinon « +71 autres » annonce une masse et la cache.
# --------------------------------------------------------------------------- #

def grove(kind, **kwargs):
    params = {"anchors": [], "events": [], "hypotheses": [], "whale_moves": [],
              "pipeline": [], "now": NOW.isoformat(), "reddit_trends": None}
    params.update(kwargs)
    return graph.build_grove(kind, params["anchors"], params["events"],
                             params["hypotheses"], params["whale_moves"],
                             params["pipeline"], params["now"],
                             reddit_trends=params["reddit_trends"])


def test_the_world_grove_lists_everything_the_canvas_left_out():
    """40 annonces politiques : la toile en dessine 12 et compte « +28 », la
    liste les rend toutes les 40. C'est LE point de la fonctionnalité."""
    events = _many_gov(40)
    assert len(node_by_type(build(events=events), "gov")) == graph.MAX_GROVE

    listed = grove(graph.WORLD_ID, events=events)
    assert listed["kind"] == graph.WORLD_ID
    assert listed["total"] == 40
    assert len(listed["items"]) == 40


def test_the_listed_items_are_the_canvas_nodes_untouched():
    """Un item EST le nœud : date, libellé, tonalité, lien et ``meta`` y sont
    déjà — le frontend n'a rien à reconstituer."""
    listed = grove(graph.WORLD_ID, events=[
        {"ts": _iso(hours_ago=1), "symbol": "GOV", "title": "Nouveaux tarifs",
         "link": "http://g/1", "sentiment": "gov"}])
    item = listed["items"][0]
    assert item["type"] == "gov"
    assert item["label"] == "Nouveaux tarifs"
    assert item["link"] == "http://g/1"
    assert item["sentiment"] == "gov"
    assert item["ts"] == _iso(hours_ago=1)


def test_the_world_grove_is_sorted_from_the_freshest_down():
    listed = grove(graph.WORLD_ID, events=_many_gov(20))
    # ``_many_gov`` numérote de la plus récente à la plus vieille.
    assert [item["label"] for item in listed["items"]] == \
        ["Annonce %03d" % i for i in range(20)]


def test_the_crowd_grove_lists_the_trends_from_the_most_mentioned_down():
    listed = grove(graph.CROWD_ID,
                   reddit_trends={"GME": {"count": 42, "prev": 3},
                                  "TSLA": {"count": 9, "prev": 1}})
    assert listed["total"] == 2
    assert [item["id"] for item in listed["items"]] == ["rt:GME", "rt:TSLA"]
    assert listed["items"][0]["meta"] == {"count": 42, "prev": 3}


def test_the_radar_grove_lists_open_hypotheses_first_then_fresh_verdicts():
    """La liste garde l'ordre DU BOSQUET, pas celui de la fraîcheur seule :
    les paris encore en jeu d'abord."""
    listed = grove(graph.RADAR_ID, hypotheses=[
        _hyp("vieux_verdict", status="scored", days_ago=5),
        _hyp("frais_verdict", status="scored", days_ago=1),
        _hyp("ouverte", days_ago=20)])
    assert [item["id"] for item in listed["items"]] == [
        "hyp:ouverte", "hyp:frais_verdict", "hyp:vieux_verdict"]
    assert listed["items"][0]["meta"] == {"tickers": ["ZZZZ"]}


def _many_gov_within_the_hour(count):
    """``count`` annonces politiques espacées d'une MINUTE — toutes dans la
    fenêtre de fraîcheur, quel qu'en soit le nombre.

    ``_many_gov`` les espace d'une heure : passé 168, les plus vieilles sortent
    des sept jours et la liste se plafonne toute seule. Un test du plafond de
    LISTE doit mesurer le plafond, pas la fenêtre (mesuré : 168 pour 175
    demandées).
    """
    return [{"ts": _iso(hours_ago=(i + 1) / 60.0), "symbol": "GOV",
             "title": "Annonce %03d" % i, "link": "http://g/m%03d" % i,
             "sentiment": "gov"} for i in range(count)]


def test_the_list_is_capped_but_says_how_many_the_memory_really_holds():
    """Au-delà du plafond, ``total`` DIT le reste — jamais un silence."""
    listed = grove(graph.WORLD_ID,
                   events=_many_gov_within_the_hour(graph.GROVE_LIST_CAP + 25))
    assert len(listed["items"]) == graph.GROVE_LIST_CAP
    assert listed["total"] == graph.GROVE_LIST_CAP + 25
    # …et ce sont bien les PLUS RÉCENTES qu'on garde.
    assert listed["items"][0]["label"] == "Annonce 000"


def test_a_grove_just_at_the_cap_is_whole():
    listed = grove(graph.WORLD_ID,
                   events=_many_gov_within_the_hour(graph.GROVE_LIST_CAP))
    assert len(listed["items"]) == graph.GROVE_LIST_CAP
    assert listed["total"] == graph.GROVE_LIST_CAP


def test_the_window_of_freshness_still_applies_to_the_list():
    """La liste rend tout le BOSQUET, pas toutes les archives : une annonce de
    huit jours n'est plus dans le bosquet, donc pas dans la liste."""
    listed = grove(graph.WORLD_ID, events=[
        {"ts": _iso(hours_ago=2), "symbol": "GOV", "title": "Frais",
         "link": "http://g/1", "sentiment": "gov"},
        {"ts": _iso(days_ago=8), "symbol": "GOV", "title": "Périmé",
         "link": "http://g/2", "sentiment": "gov"}])
    assert [item["label"] for item in listed["items"]] == ["Frais"]


def test_the_list_composes_the_grove_exactly_like_the_canvas_does():
    """Ce qui touche une ancre est une BRANCHE, pas un bosquet : une dépêche
    politique qui nomme un titre détenu ne doit pas figurer dans « monde », ni
    dans la liste, ni sur la toile."""
    events = [{"ts": _iso(hours_ago=1), "symbol": "NVDA",
               "title": "Tarifs sur les puces Nvidia", "link": "http://g/9",
               "sentiment": "gov"},
              {"ts": _iso(hours_ago=2), "symbol": "GOV", "title": "Tarifs acier",
               "link": "http://g/1", "sentiment": "gov"}]
    listed = grove(graph.WORLD_ID,
                   anchors=[{"symbol": "NVDA", "kind": "position"}],
                   events=events)
    assert [item["label"] for item in listed["items"]] == ["Tarifs acier"]


def test_an_empty_grove_is_an_empty_list_not_an_error():
    listed = grove(graph.RADAR_ID)
    assert listed == {"kind": graph.RADAR_ID, "items": [], "total": 0}


@pytest.mark.parametrize("kind", ["", None, "titres", "agg:monde", 7, "mondes"])
def test_an_unknown_grove_is_refused_rather_than_answered_empty(kind):
    """Une liste vide se lirait « il n'y a rien » alors qu'on a mal demandé."""
    with pytest.raises(ValueError):
        grove(kind)


@pytest.mark.parametrize("kind", ["MONDE", " monde ", "Monde"])
def test_the_kind_is_normalised_before_being_judged(kind):
    """C'est le MÊME bosquet : la casse et les espaces d'une chaîne d'URL ne
    doivent pas décider qu'un bosquet existe ou non."""
    assert grove(kind, events=_many_gov(3))["kind"] == graph.WORLD_ID


def test_the_three_groves_are_the_public_contract():
    assert graph.GROVE_KINDS == (graph.WORLD_ID, graph.CROWD_ID, graph.RADAR_ID)


def test_the_list_is_deterministic():
    kwargs = {"anchors": [{"symbol": "AAPL", "kind": "position"}],
              "events": _many_gov(20)}
    assert grove(graph.WORLD_ID, **kwargs) == grove(graph.WORLD_ID, **kwargs)


# --------------------------------------------------------------------------- #
# Les THÈMES — « une branche que pour ça, ça se répartit mieux »
#
# Le scénario MESURÉ (capture utilisateur du 26/08) : douze feuilles
# « Politique » sous un même rameau, dont HUIT sur la même histoire
# Trump/Canada. Douze points identiques, à survoler un par un.
# --------------------------------------------------------------------------- #

#: Les douze titres de la capture (huit Trump/Canada, trois Iran, un isolé).
CAPTURE_TITLES = [
    "Trump threatens Canada with new tariffs over dairy dispute - Reuters",
    "Trump says Canada tariffs will start on Friday - CNBC",
    "Canada retaliates against US tariffs with counter-measures - BBC",
    "White House confirms Canada tariff exemption for autos - Bloomberg",
    "Trump doubles steel tariffs on Canada and Mexico - Financial Times",
    "Canada PM calls Trump tariffs unjustified - Globe and Mail",
    "Trump tariffs on Canada spark market selloff - MarketWatch",
    "US Senate votes to block Canada tariffs - Politico",
    "Iran nuclear talks resume in Geneva - Reuters",
    "Iran rejects new sanctions over nuclear programme - AP",
    "Iran nuclear deal deadline extended by two weeks - Al Jazeera",
    "ICC issues arrest warrant in Sudan case - Le Monde",
]


def _capture_gov(titles=None):
    """Les dépêches de la capture, la n° 0 étant la plus RÉCENTE."""
    rows = CAPTURE_TITLES if titles is None else titles
    return [{"ts": _iso(hours_ago=i + 1), "symbol": "GOV", "title": title,
             "link": "http://g/c%02d" % i, "sentiment": "gov"}
            for i, title in enumerate(rows)]


def _leaves(titles, kind="gov"):
    return [{"id": "ev:%02d" % i, "type": kind, "label": title}
            for i, title in enumerate(titles)]


def themes(built):
    return [n for n in built["nodes"] if n["type"] == graph.THEME_TYPE]


def test_the_measured_scenario_twelve_political_leaves_become_three_subjects():
    """LE test de la fonctionnalité : les huit Trump/Canada se rassemblent sous
    un seul sujet NOMMÉ, les trois Iran sous un autre, l'isolée tombe au
    fourre-tout."""
    got = graph.theme_clusters(_leaves(CAPTURE_TITLES))
    assert [(c["label"], len(c["leaf_ids"])) for c in got] == [
        ("Canada · Tariffs", 8), ("Iran · Nuclear", 3), ("Divers", 1)]
    # …et le fourre-tout contient bien la dépêche isolée (la CPI), pas une autre.
    assert got[-1]["leaf_ids"] == ["ev:11"]
    assert got[-1]["key"] == graph.MISC_THEME_KEY


def test_two_stories_merge_when_they_share_two_significant_tokens():
    """« canada » + « tariff » de part et d'autre : c'est le même sujet."""
    got = graph.theme_clusters(_leaves([
        "Canada PM calls Trump tariffs unjustified",
        "US Senate votes to block Canada tariffs"]))
    assert [len(c["leaf_ids"]) for c in got] == [2]
    assert got[0]["key"] != graph.MISC_THEME_KEY


def test_one_shared_token_is_not_a_subject():
    """« canada » seul relie une taxe douanière à un match de hockey : deux
    histoires, deux singletons, donc le fourre-tout."""
    got = graph.theme_clusters(_leaves([
        "Canada raises tariffs on imported steel",
        "Canada wins Olympic hockey final in Milan"]))
    assert [(c["key"], len(c["leaf_ids"])) for c in got] == [(graph.MISC_THEME_KEY, 2)]


def test_the_label_shows_the_surface_word_not_the_stem():
    """On COMPTE par racine (tariff + tariffs = un seul sujet) mais on AFFICHE
    le mot tel qu'il est écrit : « Nuclear », jamais « Nuclea »."""
    got = graph.theme_clusters(_leaves(CAPTURE_TITLES[8:11]))
    assert got[0]["label"] == "Iran · Nuclear"


def test_a_leaf_without_a_title_lands_in_the_misc_cluster():
    leaves = _leaves(CAPTURE_TITLES[:2]) + [{"id": "ev:99", "type": "gov", "label": ""}]
    got = graph.theme_clusters(leaves)
    assert got[-1]["key"] == graph.MISC_THEME_KEY
    assert got[-1]["leaf_ids"] == ["ev:99"]


def test_the_clusters_do_not_depend_on_the_order_of_the_leaves():
    """Deux appels, et deux ORDRES d'entrée, rendent exactement la même
    répartition : c'est ce qui fait qu'ouvrir deux fois le même bosquet donne
    deux fois la même image."""
    leaves = _leaves(CAPTURE_TITLES)
    straight = graph.theme_clusters(leaves)
    assert straight == graph.theme_clusters(leaves)
    reversed_ = graph.theme_clusters(list(reversed(leaves)))
    assert [(c["key"], c["label"], sorted(c["leaf_ids"])) for c in straight] == \
        [(c["key"], c["label"], sorted(c["leaf_ids"])) for c in reversed_]


def test_no_leaves_no_clusters():
    assert graph.theme_clusters([]) == []
    assert graph.theme_clusters(None) == []
    assert graph.theme_clusters([{"label": "sans identifiant"}]) == []


def test_a_leaf_is_never_lost_by_the_clustering():
    """Ceinture : chaque feuille est dans un thème et un seul."""
    got = graph.theme_clusters(_leaves(CAPTURE_TITLES))
    seen = [lid for c in got for lid in c["leaf_ids"]]
    assert sorted(seen) == ["ev:%02d" % i for i in range(len(CAPTURE_TITLES))]
    assert len(seen) == len(set(seen))


def test_without_newswatch_there_is_simply_no_theme(monkeypatch):
    """Le graphe garde sa forme d'avant, à plat — qui se lit toujours."""
    monkeypatch.setattr(graph, "_story_tools", lambda: None)
    assert graph.theme_clusters(_leaves(CAPTURE_TITLES)) == []
    assert themes(build(events=_capture_gov())) == []


# --- l'insertion dans le dessin --------------------------------------------- #

def test_six_leaves_or_fewer_keep_no_theme_level():
    """Un niveau de plus ne se justifie que quand l'œil ne suit plus."""
    six = _capture_gov(CAPTURE_TITLES[:graph.THEME_MIN_LEAVES])
    built = build(events=six)
    assert themes(built) == []
    assert len(node_by_type(built, "gov")) == graph.THEME_MIN_LEAVES
    # …et chaque feuille garde son lien DIRECT au pivot.
    assert {e["target"] for e in built["edges"]} == {graph.WORLD_ID}


def test_beyond_six_the_grove_gains_its_subjects():
    built = build(events=_capture_gov())
    assert [(n["label"], n["meta"]["count"]) for n in themes(built)] == [
        ("Canada · Tariffs", 8), ("Iran · Nuclear", 3), ("Divers", 1)]
    # Le thème est un nœud de STRUCTURE : ni symbole, ni date.
    for node in themes(built):
        assert node["id"].startswith("th:")
        assert node["symbol"] == "" and node["ts"] == ""
        assert node["meta"]["key"]


def test_the_twelve_drawn_leaves_stay_twelve():
    """Le thème RÉPARTIT, il n'ajoute aucune feuille (règle 5 du module)."""
    built = build(events=_capture_gov(CAPTURE_TITLES * 3))
    assert len(node_by_type(built, "gov")) == graph.MAX_GROVE


def test_the_edges_are_rerouted_leaf_to_theme_to_pivot():
    built = build(events=_capture_gov())
    by_id = {n["id"]: n for n in built["nodes"]}
    theme_ids = {n["id"] for n in themes(built)}
    for edge in built["edges"]:
        if edge["source"] in theme_ids:
            assert edge["target"] == graph.WORLD_ID
            assert edge["type"] == graph.EDGE_THEME
        else:
            # Une feuille ne parle plus qu'à son thème.
            assert edge["target"] in theme_ids
            assert by_id[edge["source"]]["type"] == "gov"


def test_no_edge_dangles_once_the_themes_are_in():
    built = build(events=_capture_gov())
    known = {n["id"] for n in built["nodes"]} | set(graph.PIVOT_IDS)
    assert all(e["source"] in known and e["target"] in known for e in built["edges"])
    # Le pivot est toujours là : le thème le vise, donc il n'est pas solitaire.
    assert graph.WORLD_ID in {n["id"] for n in built["nodes"]}


def test_a_grove_where_nothing_groups_stays_flat():
    """Douze annonces sans vocabulaire commun : un unique nœud « Divers » qui
    rassemblerait tout allongerait le chemin sans rien répartir."""
    built = build(events=_many_gov(12))
    assert themes(built) == []


def test_a_reddit_trend_grove_stays_flat():
    """« GME ×42 » n'est pas une histoire : rien à regrouper, aucun niveau."""
    trends = {"SYM%02d" % i: {"count": 40 - i, "prev": 1} for i in range(10)}
    built = build(reddit_trends=trends)
    assert themes(built) == []
    assert len(node_by_type(built, graph.TREND_TYPE)) == 10


def test_the_branch_of_a_title_gets_its_subjects_too():
    """Même règle sur un titre : douze dépêches qui le nomment se répartissent."""
    events = [dict(e, symbol="NVDA") for e in _capture_gov()]
    built = build(anchors=[{"symbol": "NVDA", "kind": "position"}],
                  events=events, symbol="NVDA")
    assert sorted(n["meta"]["count"] for n in themes(built)) == [1, 3, 8]
    theme_ids = {n["id"] for n in themes(built)}
    for edge in built["edges"]:
        if edge["source"] in theme_ids:
            assert edge["target"] == "NVDA" and edge["type"] == graph.EDGE_THEME
        else:
            assert edge["target"] in theme_ids


def test_a_rerouted_branch_edge_keeps_its_mechanism_and_its_tone():
    """C'est l'arête de la feuille qui COLORE le lien : la re-router ne doit
    pas lui faire perdre ce qu'elle disait."""
    events = [dict(e, symbol="NVDA", sentiment="neg") for e in _capture_gov()]
    built = build(anchors=[{"symbol": "NVDA", "kind": "position"}],
                  events=events, symbol="NVDA")
    theme_ids = {n["id"] for n in themes(built)}
    leaf_edges = [e for e in built["edges"] if e["source"] not in theme_ids]
    assert leaf_edges and all(e["type"] == graph.EDGE_SYMBOL
                              and e["sentiment"] == "neg" for e in leaf_edges)


def test_themes_never_reach_the_index_branches():
    """La vue globale COMPTE les feuilles d'un titre (« Presse 12 ») : y
    intercaler des thèmes ferait tomber le compteur à trois."""
    events = [dict(e, symbol="NVDA") for e in _capture_gov()]
    built = build(anchors=[{"symbol": "NVDA", "kind": "position"}], events=events)
    assert themes(built) == []
    assert len([e for e in built["edges"] if e["target"] == "NVDA"]) == 12


def test_the_themed_graph_is_deterministic():
    kwargs = {"events": _capture_gov()}
    assert build(**kwargs) == build(**kwargs)


# --- la LISTE : chaque item sait de quel sujet il relève -------------------- #

def test_the_list_labels_each_item_with_its_subject_and_groups_them():
    listed = grove(graph.WORLD_ID, events=_capture_gov())
    assert [item["theme_label"] for item in listed["items"]] == \
        ["Canada · Tariffs"] * 8 + ["Iran · Nuclear"] * 3 + ["Divers"]
    # …le fourre-tout est reconnaissable par sa CLÉ, pas par son libellé
    # français (que le frontend retraduit).
    assert listed["items"][-1]["theme_key"] == graph.MISC_THEME_KEY
    assert listed["items"][0]["theme_key"] != graph.MISC_THEME_KEY


def test_inside_a_subject_the_list_keeps_the_order_of_the_canvas():
    listed = grove(graph.WORLD_ID, events=_capture_gov())
    canada = [item["label"] for item in listed["items"]
              if item["theme_key"] != graph.MISC_THEME_KEY][:8]
    assert canada == CAPTURE_TITLES[:8]          # la n° 0 est la plus récente


def test_the_list_groups_further_than_the_canvas_can_draw():
    """Le dessin ne voit que douze satellites, la liste voit tout : le sujet de
    la liste peut donc être PLUS gros que celui de la toile. C'est justement en
    ouvrant qu'on veut voir la répartition."""
    events = _capture_gov(CAPTURE_TITLES[:8] * 3)     # 24 dépêches Canada
    assert [n["meta"]["count"] for n in themes(build(events=events))] == [12]
    listed = grove(graph.WORLD_ID, events=events)
    assert listed["total"] == 24
    assert len([i for i in listed["items"]
                if i["theme_label"] == "Canada · Tariffs"]) == 24


def test_the_list_stays_flat_when_nothing_groups():
    """Un unique intertitre « Divers » au-dessus d'une liste plate est du bruit :
    on n'envoie alors aucun champ de thème."""
    listed = grove(graph.WORLD_ID, events=_many_gov(20))
    assert all("theme_label" not in item for item in listed["items"])


def test_the_listed_item_still_carries_everything_the_canvas_node_had():
    listed = grove(graph.WORLD_ID, events=_capture_gov())
    item = listed["items"][0]
    assert item["type"] == "gov" and item["sentiment"] == "gov"
    assert item["label"] == CAPTURE_TITLES[0] and item["link"] == "http://g/c00"


def test_the_themed_list_is_deterministic():
    kwargs = {"events": _capture_gov()}
    assert grove(graph.WORLD_ID, **kwargs) == grove(graph.WORLD_ID, **kwargs)


def test_the_list_never_loses_an_item_to_the_grouping():
    listed = grove(graph.WORLD_ID, events=_capture_gov())
    assert sorted(i["label"] for i in listed["items"]) == sorted(CAPTURE_TITLES)


# --------------------------------------------------------------------------- #
# Les SOUS-SUJETS — « séparer encore plus »
#
# Suite du niveau précédent : quand un sujet grossit (soixante-dix dépêches
# « Canada · Tariffs »), le thème ne répartit plus rien — on a remplacé un mur
# de points par un mur de lignes sous un seul intertitre.
# --------------------------------------------------------------------------- #

#: Quatre sujets NETS sous une même histoire Canada/tarifs, six formulations
#: chacun (une histoire reprise par plusieurs médias, comme dans la vraie vie).
BEEF = [
    "Canada beef exports hit by new tariffs",
    "Beef producers brace as Canada tariffs start",
    "Tariffs push Canada beef prices to a record",
    "Ottawa defends beef farmers from Canada tariffs",
    "Canada beef shipments slow under tariffs",
    "Grocers flag beef costs as Canada tariffs bite",
]
STEEL = [
    "Canada steel tariffs double overnight",
    "Steel mills cut output as Canada tariffs land",
    "Canada steel exporters seek tariff relief",
    "Tariffs on Canada steel raise construction costs",
    "Steel prices jump after Canada tariffs",
    "Canada steel quota talks stall over tariffs",
]
AUTOS = [
    "Canada autos exempt from tariffs for now",
    "Autos plants idle as Canada tariffs bite",
    "Tariffs hit Canada autos supply chain",
    "Canada autos parts makers seek a tariff carve-out",
    "Autos sector flags Canada tariffs risk",
    "Canada autos exports slip under tariffs",
]
RETALIATION = [
    "Canada retaliation targets US tariffs",
    "Ottawa plans retaliation over Canada tariffs",
    "Canada retaliation list grows as tariffs bite",
    "Retaliation measures answer Canada tariffs",
    "Canada weighs retaliation against tariffs",
    "Retaliation talk rises after Canada tariffs",
]


def _big_canada(blocks=(BEEF, STEEL, AUTOS, RETALIATION), repeats=3):
    """72 dépêches d'un même thème, quatre sujets de 18."""
    titles = []
    for block in blocks:
        for _ in range(repeats):
            titles.extend(block)
    return titles


def test_seventy_leaves_of_one_theme_split_into_named_subjects():
    """LE test de la fonctionnalité : sous « Canada · Tariffs », le bœuf,
    l'acier, les autos et les représailles se séparent — et se NOMMENT."""
    leaves = _leaves(_big_canada())
    assert [(c["label"], len(c["leaf_ids"])) for c in graph.theme_clusters(leaves)] \
        == [("Canada · Tariffs", 72)]        # un seul thème au premier étage

    subs = graph.subtheme_clusters(leaves, ["canada", "tariffs"])
    assert [(c["label"], len(c["leaf_ids"])) for c in subs] == [
        ("Autos", 18), ("Beef", 18), ("Retaliation", 18), ("Steel", 18)]


def test_a_subject_never_repeats_the_name_of_its_parent():
    """« Canada » et « Tariffs » sont le contexte : les répéter à l'étage du
    dessous n'apprendrait rien."""
    subs = graph.subtheme_clusters(_leaves(_big_canada()), ["canada", "tariffs"])
    for cluster in subs:
        assert "canada" not in cluster["label"].lower()
        assert "tariff" not in cluster["label"].lower()


def test_a_word_shared_by_the_whole_pack_is_context_even_unnamed():
    """Le second filet : un mot que la moitié du paquet porte est du contexte,
    que l'appelant l'ait nommé ou non. Sans lui, un « US » omniprésent
    recollerait entre eux des sous-sujets étrangers."""
    titles = ["US Canada tariffs hit %s exports" % topic
              for topic in ("beef", "beef", "steel", "steel",
                            "autos", "autos", "lumber", "lumber")]
    subs = graph.subtheme_clusters(_leaves(titles), [])
    labels = [c["label"] for c in subs]
    assert "US" not in labels and "Canada" not in labels
    assert sorted(labels) == ["Autos", "Beef", "Lumber", "Steel"]


def test_a_leaf_made_only_of_the_parent_words_lands_in_the_misc_cluster():
    leaves = _leaves(_big_canada() + ["Canada tariffs"])
    subs = graph.subtheme_clusters(leaves, ["canada", "tariffs"])
    assert subs[-1]["key"] == graph.MISC_THEME_KEY
    assert subs[-1]["leaf_ids"] == ["ev:72"]


def test_a_word_carried_by_a_single_leaf_is_not_a_subject():
    """Un mot qu'on ne voit qu'une fois nommerait un sous-groupe d'un
    élément — le premier étage refuse déjà ça."""
    subs = graph.subtheme_clusters(
        _leaves(["Canada tariffs hit beef", "Canada tariffs raise lumber"]),
        ["canada", "tariffs"])
    assert [c["key"] for c in subs] == [graph.MISC_THEME_KEY]


def test_no_leaves_no_subthemes():
    assert graph.subtheme_clusters([]) == []
    assert graph.subtheme_clusters(None, ["canada"]) == []


def test_the_subthemes_do_not_depend_on_the_order_of_the_leaves():
    leaves = _leaves(_big_canada())
    straight = graph.subtheme_clusters(leaves, ["canada", "tariffs"])
    assert straight == graph.subtheme_clusters(leaves, ["canada", "tariffs"])
    reversed_ = graph.subtheme_clusters(list(reversed(leaves)),
                                        ["canada", "tariffs"])
    assert [(c["key"], c["label"], sorted(c["leaf_ids"])) for c in straight] == \
        [(c["key"], c["label"], sorted(c["leaf_ids"])) for c in reversed_]


def test_no_leaf_is_lost_by_the_second_level():
    subs = graph.subtheme_clusters(_leaves(_big_canada()), ["canada", "tariffs"])
    seen = [lid for c in subs for lid in c["leaf_ids"]]
    assert sorted(seen) == sorted("ev:%02d" % i for i in range(72))
    assert len(seen) == len(set(seen))


def test_without_newswatch_there_is_simply_no_subtheme(monkeypatch):
    monkeypatch.setattr(graph, "_story_tools", lambda: None)
    assert graph.subtheme_clusters(_leaves(_big_canada()), ["canada"]) == []


# --- l'insertion dans la LISTE (le dessin, lui, n'en sait rien) ------------- #

def _big_gov(titles):
    """Des dépêches politiques dont la n° 0 est la plus RÉCENTE, espacées d'une
    minute pour tenir toutes dans la fenêtre de fraîcheur."""
    return [{"ts": _iso(hours_ago=(i + 1) / 60.0), "symbol": "GOV",
             "title": title, "link": "http://g/b%03d" % i, "sentiment": "gov"}
            for i, title in enumerate(titles)]


def test_a_theme_that_overflows_gains_a_second_level_in_the_list():
    listed = grove(graph.WORLD_ID, events=_big_gov(_big_canada()))
    assert {item["theme_label"] for item in listed["items"]} == {"Canada · Tariffs"}
    # …et sous ce thème unique, quatre sous-sujets nommés, groupés.
    subs = [item["subtheme_label"] for item in listed["items"]]
    assert subs == ["Autos"] * 18 + ["Beef"] * 18 + \
        ["Retaliation"] * 18 + ["Steel"] * 18


def test_inside_a_subject_the_list_keeps_the_order_of_the_grove():
    listed = grove(graph.WORLD_ID, events=_big_gov(_big_canada()))
    beef = [item["label"] for item in listed["items"]
            if item.get("subtheme_label") == "Beef"]
    assert beef == [t for t in _big_canada() if t in BEEF][:18]


def test_a_theme_below_the_threshold_stays_at_one_level():
    """Règle « pas de niveau inutile » : douze feuilles se lisent très bien
    sous un seul intertitre."""
    listed = grove(graph.WORLD_ID, events=_capture_gov())
    assert len(listed["items"]) == 12
    assert all("subtheme_label" not in item for item in listed["items"])


def test_a_theme_where_nothing_further_groups_stays_at_one_level():
    """Vingt variantes du même communiqué : elles forment bien un thème, mais
    dessous il n'y a rien à répartir — on n'ajoute pas d'étage."""
    flat = ["Canada tariffs update number %03d" % i for i in range(20)]
    listed = grove(graph.WORLD_ID, events=_big_gov(flat))
    assert len(listed["items"]) == 20
    labels = {item["theme_label"] for item in listed["items"]}
    assert len(labels) == 1 and graph.MISC_THEME_LABEL not in labels
    assert all("subtheme_label" not in item for item in listed["items"])


def test_the_misc_theme_never_gets_a_second_level():
    """Un reste n'a pas de sous-sujets : c'est ce qui le définit."""
    isolated = ["Annonce %03d" % i for i in range(20)]   # rien ne les relie
    listed = grove(graph.WORLD_ID, events=_big_gov(_big_canada() + isolated))
    misc = [item for item in listed["items"]
            if item["theme_key"] == graph.MISC_THEME_KEY]
    assert len(misc) == 20
    assert all("subtheme_label" not in item for item in misc)


def test_an_item_without_a_subject_carries_no_subtheme_field():
    """L'absence dit « sans sous-sujet » — jamais un intertitre « Divers » de
    plus. Et l'item ferme son thème."""
    events = _big_gov(_big_canada() + ["Canada tariffs"])
    listed = grove(graph.WORLD_ID, events=events)
    orphan = [item for item in listed["items"] if item["label"] == "Canada tariffs"]
    assert len(orphan) == 1
    assert "subtheme_label" not in orphan[0]
    assert orphan[0]["theme_label"] == "Canada · Tariffs"   # le thème, lui, reste
    assert listed["items"][-1]["label"] == "Canada tariffs"


def test_a_subthemed_item_still_carries_everything_the_node_had():
    listed = grove(graph.WORLD_ID, events=_big_gov(_big_canada()))
    item = listed["items"][0]
    assert item["type"] == "gov" and item["sentiment"] == "gov"
    assert item["link"].startswith("http://g/b") and item["ts"]
    assert item["theme_key"] and item["subtheme_label"]


def test_the_canvas_keeps_a_single_level_of_themes():
    """Le second étage est une affaire de LISTE : au-delà, on ne lit plus un
    graphe, on l'explore."""
    built = build(events=_big_gov(_big_canada()))
    # Le dessin ne voit que ses douze satellites : il en tire UN thème, et il
    # s'arrête là (les nœuds de thème de niveau 2 n'existent pas côté serveur).
    assert len(themes(built)) == 1
    assert all("subtheme_label" not in n for n in built["nodes"])


def test_the_subthemed_list_is_deterministic():
    kwargs = {"events": _big_gov(_big_canada())}
    assert grove(graph.WORLD_ID, **kwargs) == grove(graph.WORLD_ID, **kwargs)


def test_the_second_level_never_loses_an_item():
    titles = _big_canada() + ["Canada tariffs"]
    listed = grove(graph.WORLD_ID, events=_big_gov(titles))
    assert sorted(i["label"] for i in listed["items"]) == sorted(titles)


# --------------------------------------------------------------------------- #
# W2a — les trois volets MONDIAUX dans la toile
#
# Piège #61 en tête : un champ lu au mauvais niveau ne plante jamais, il rend
# juste la fonctionnalité MORTE. Ces trois tests figent la famille de chaque
# nouvelle provenance — sans eux, un événement `bc`/`pressefi`/`bsky` tomberait
# en silence dans la famille « other » et personne ne le verrait.
# --------------------------------------------------------------------------- #

def test_un_communique_de_banque_centrale_est_une_depeche_MACRO():
    """Il rejoint le rameau « éco » plutôt que d'ouvrir une famille à lui tout
    seul : ce que sa provenance ajoute (« source officielle ») est déjà dit par
    son message, un rameau de plus serait un rameau de plus à lire."""
    built = build(events=[_world("bc", title="FOMC statement",
                                 sentiment="watch")])
    node = node_by_type(built, "eco")[0]
    assert graph._family_of(node) == "eco"
    assert node["sentiment"] == "watch"


def test_une_depeche_de_presse_mondiale_est_de_la_PRESSE():
    """Une dépêche de la BBC sur Nestlé est une dépêche sur Nestlé : elle tombe
    sur la tonalité, comme le volet par symbole, et atterrit dans « press » —
    exactement là où on la cherche."""
    built = build(anchors=[{"symbol": "NESN.SW", "kind": "position"}],
                  events=[_world("pressefi", symbol="NESN.SW",
                                 title="Nestlé beats estimates",
                                 sentiment="pos")])
    node = node_by_type(built, "news")[0]
    assert graph._family_of(node) == "press"


def test_un_post_bluesky_est_du_SOCIAL_comme_x_et_reddit():
    built = build(anchors=[{"symbol": "NVDA", "kind": "position"}],
                  events=[_world("bsky", symbol="NVDA",
                                 title="$NVDA raises guidance",
                                 sentiment="pos")])
    node = node_by_type(built, "bsky")[0]
    assert graph._family_of(node) == "social"
    assert "bsky" in graph.INFO_TYPES


def test_un_post_bluesky_ORPHELIN_ne_va_pas_au_pivot_monde():
    """Même règle qu'un post Reddit orphelin : ce n'est pas du macro, c'est
    quelqu'un qui parle d'un titre qu'on ne suit pas."""
    assert "bsky" not in graph.PIVOT_TYPES
    built = build(anchors=[{"symbol": "AAPL", "kind": "position"}],
                  events=[_world("bsky", title="marché nerveux ce matin")])
    assert graph.WORLD_ID not in ids(built["nodes"])
