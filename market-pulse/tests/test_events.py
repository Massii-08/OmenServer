"""Tri « qui a fait quoi » — le critère de Massii, pas la simple récence.

    « l'important des news est de nous donner tout ce qui pourrait changer la
      courbe d'une entreprise, bourse... (genre cette personne a fait ça) »

Tous les titres ci-dessous sont RÉELS, relevés dans les flux le 2026-07-29.
"""
from pulse.events import ACTOR_KINDS, classify, is_event, rank_events

# Un acteur identifiable a fait quelque chose de concret.
FAITS = [
    "Ford raises guidance after Q2 earnings beat, says F-Series recovery is on track",
    "Coca-Cola hikes full-year forecast. CEO tells CNBC the World Cup boosted its brands",
    "Boeing posts wider loss than expected as Air Force One costs weigh on results",
    "Corning tumbles 12% after earnings, leading rout in optical stocks",
    "Minister apologizes as Korean leveraged ETF investors nurse heavy losses",
    "The Federal Reserve on Wednesday voted to hold its key interest rate",
    "Danone keeps its guidance as Q2 sales beat expectations",
    "FERRARI N.V.: PERIODIC REPORT ON THE BUYBACK PROGRAM",
    "Gericht bestellt vorläufigen Insolvenzverwalter für Centrum Development",
    "Global oil prices settle at a 2-week low, as Trump meets with Netanyahu",
    "SK Hynix announces Q2 results, stock falls AH",
    "La Bce lascia i tassi invariati",
    "Intesa Sanpaolo nomina un nuovo amministratore delegato",
    "Stellantis richiama 120.000 veicoli per un difetto ai freni",
]

# Du commentaire : personne n'a rien fait, c'est une opinion ou une question.
COMMENTAIRES = [
    "Is the AI rally running out of steam?",
    "Forget oil. A surging El Nino could kill Fed rate cuts",
    "What is really behind the recent AI semiconductor selloff",
    "Why do so many people believe 'Mag 7' companies in 2050 do not exist yet?",
    "America's favorite activity is price gouging.",
    "Investors are piling into bond funds at a rapid rate. That's a problem",
    "Perche la borsa sale quando l'economia rallenta?",
    "Cinque cose da sapere prima dell'apertura",
]


def test_real_events_are_recognised():
    for title in FAITS:
        assert is_event(title) is True, "raté comme fait : %r" % title


def test_commentary_is_not_an_event():
    for title in COMMENTAIRES:
        assert is_event(title) is False, "faux positif sur du commentaire : %r" % title


def test_is_event_tolerates_garbage():
    assert is_event(None) is False
    assert is_event("") is False
    assert is_event(42) is False


def test_classification_names_the_actor_and_the_action():
    c = classify("Coca-Cola hikes full-year forecast. CEO tells CNBC the World Cup boosted its brands")
    assert c["is_event"] is True
    assert c["actor"] == "azienda"
    assert "previsioni" in c["actions"] or "dirigenti" in c["actions"]

    c2 = classify("The Federal Reserve on Wednesday voted to hold its key interest rate")
    assert c2["actor"] == "banca centrale"

    c3 = classify("Minister apologizes as Korean leveraged ETF investors nurse heavy losses")
    assert c3["actor"] == "governo"

    c4 = classify("Gericht bestellt vorläufigen Insolvenzverwalter für Centrum Development")
    assert c4["actor"] == "giustizia"


def test_every_declared_actor_kind_is_reachable():
    """Un type d'acteur déclaré mais jamais détectable serait du code mort."""
    found = set()
    for title in FAITS:
        found.add(classify(title)["actor"])
    assert found, "aucun acteur détecté"
    assert found <= set(ACTOR_KINDS)


def test_classification_of_commentary_has_no_actor():
    c = classify("Is the AI rally running out of steam?")
    assert c["is_event"] is False
    assert c["actor"] is None
    assert c["actions"] == []


def test_a_question_mark_alone_does_not_kill_a_real_event():
    """« Should you buy » est du conseil, mais « La Bce taglia i tassi? » reste
    un titre d'actualité : c'est l'ACTION qui décide, pas la ponctuation."""
    assert is_event("La Bce taglia i tassi dello 0,25%?") is True


# --------------------------------------------------------------------------
# Classement — ce qui bouge une courbe passe devant
# --------------------------------------------------------------------------

def test_events_are_ranked_before_commentary():
    items = [{"title": t, "published": 1785300000} for t in COMMENTAIRES[:3]]
    items += [{"title": t, "published": 1785200000} for t in FAITS[:3]]
    ranked = rank_events(items)
    # les faits passent devant, MÊME s'ils sont plus anciens
    assert all(r["event"]["is_event"] for r in ranked[:3])
    assert not any(r["event"]["is_event"] for r in ranked[3:])


def test_ranking_keeps_recency_inside_each_group():
    items = [
        {"title": FAITS[0], "published": 100},
        {"title": FAITS[1], "published": 900},
        {"title": COMMENTAIRES[0], "published": 500},
    ]
    ranked = rank_events(items)
    assert ranked[0]["title"] == FAITS[1]
    assert ranked[1]["title"] == FAITS[0]
    assert ranked[2]["title"] == COMMENTAIRES[0]


def test_ranking_does_not_drop_anything():
    """On CLASSE, on ne censure pas : le commentaire descend, il ne disparaît
    pas — c'est au rapport de décider combien il en montre."""
    items = [{"title": t, "published": 1} for t in FAITS[:2] + COMMENTAIRES[:2]]
    assert len(rank_events(items)) == 4


def test_ranking_on_empty_or_broken_input():
    assert rank_events([]) == []
    assert rank_events(None) == []
    assert rank_events([{}, None]) == []


def test_ranking_survives_missing_dates():
    items = [{"title": FAITS[0]}, {"title": FAITS[1], "published": 5}]
    ranked = rank_events(items)
    assert len(ranked) == 2


# --------------------------------------------------------------------------
# La ligne rouge tient : classer n'est pas prédire
# --------------------------------------------------------------------------

def test_classification_never_states_a_direction():
    """Dire « cet événement peut bouger la courbe » est un fait sur la NATURE du
    titre. Dire dans quel sens serait une prévision — le champ ne doit pas
    exister."""
    c = classify("Ford raises guidance after Q2 earnings beat")
    assert "direction" not in c
    assert "sentiment" not in c
    assert "target" not in c
    assert set(c) == {"is_event", "actor", "actions"}


def test_real_misses_found_by_running_it_live():
    """Deux titres RÉELS que ma première version classait en commentaire alors
    qu'ils rapportent bien une action — trouvés en lançant le classeur sur les
    flux du jour, pas en relisant le code."""
    # « lost » manquait : je n'avais que « loss »
    assert is_event("Meta's Reality Labs lost over $4.6 billion in second quarter") is True
    # une OPA est une offre publique d'achat : l'événement le plus brutal qui
    # existe pour une courbe, et il passait à la trappe
    c = classify("Webuild lancia opa su Trevi da 295 milioni")
    assert c["is_event"] is True
    assert "operazioni" in c["actions"]
