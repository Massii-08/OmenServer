"""Tests de la couche de convergence (spec §13) — 100 % hors-ligne.

Tout ce qui sort de la machine est injecté : LLM, notifieur Telegram, config
Telegram, horloge, et l'état du radar (``fetch_state``). Les modules voisins
(``newswatch``, ``whales``) sont remplacés par des stubs posés À LA FOIS dans
``sys.modules`` ET en attribut du paquet — l'import paresseux
``from backend.bots.paper import newswatch`` passe par le second dès que le
vrai module a été importé une fois dans la session.

Isolation disque : ``store.DATA_DIR`` pointe sur ``tmp_path``, ce qui isole
l'état de la convergence (``state_path()`` le relit à chaque appel), le carnet
Markdown, ET le fichier de config du canal Telegram (``alerts`` le dérive du
même répertoire).
"""
import json
import os
import stat
import sys
import types
from datetime import datetime, timedelta

import pytest

from backend.bots.paper import alerts, convergence, store

NOW = datetime(2026, 8, 24, 12, 0, 0)
TG = {"token": "t", "chat_id": "c"}


# --------------------------------------------------------------------------- #
# Fixtures
# --------------------------------------------------------------------------- #

@pytest.fixture(autouse=True)
def _isolate_data_dir(tmp_path, monkeypatch):
    """Aucun test n'écrit dans le vrai data/paper_trading/."""
    monkeypatch.setattr(store, "DATA_DIR", tmp_path)
    return tmp_path


@pytest.fixture(autouse=True)
def _no_telegram_channel(monkeypatch):
    """Aucun test ne lit la vraie config Telegram du dépôt."""
    monkeypatch.setattr(alerts, "load_cfg", lambda path=None: None)


@pytest.fixture
def sources(monkeypatch):
    """Stubs de newswatch/whales, pilotables depuis le test."""
    class _Bag(object):
        def __init__(self):
            self.events = []
            self.filings = []
            self.moves = []          # mouvements de gérants (26/08)
            self.trends = {}         # mentions Reddit par ticker (26/08 soir)
            self.asked = []
            self.trend_clock = []

    bag = _Bag()

    def _recent_events(username):
        bag.asked.append(username)
        return list(bag.events)

    def _recent_trends(now=None):
        bag.trend_clock.append(now)
        return dict(bag.trends)

    def _match_issuer(name, candidates):
        """Rapprochement volontairement NAÏF dans le stub (le vrai est testé
        chez lui) : premier candidat dont le symbole apparaît dans le nom."""
        for symbol in (candidates or {}):
            if symbol.split(".")[0].upper() in str(name or "").upper():
                return symbol
        return None

    news_stub = types.ModuleType("backend.bots.paper.newswatch")
    news_stub.recent_events = _recent_events
    news_stub.recent_trends = _recent_trends
    whales_stub = types.ModuleType("backend.bots.paper.whales")
    whales_stub.recent_filing_events = lambda: list(bag.filings)
    whales_stub.moves_summary = lambda: list(bag.moves)
    whales_stub.match_issuer = _match_issuer

    import backend.bots.paper as paper_pkg
    monkeypatch.setitem(sys.modules, "backend.bots.paper.newswatch", news_stub)
    monkeypatch.setitem(sys.modules, "backend.bots.paper.whales", whales_stub)
    monkeypatch.setattr(paper_pkg, "newswatch", news_stub, raising=False)
    monkeypatch.setattr(paper_pkg, "whales", whales_stub, raising=False)
    return bag


@pytest.fixture
def alice(tmp_path):
    """Un compte avec un portefeuille (donc destinataire des notes de carnet)."""
    store.save_portfolio("alice", {
        "cash_chf": 10000.0,
        "positions": [{"symbol": "NESN.SW", "qty": 10, "side": "long"}],
    })
    return "alice"


def _hyp(**over):
    base = {
        "id": "h1",
        "created_at": (NOW - timedelta(hours=5)).isoformat(),
        "thesis": "Le fret cher renchérit le café en Europe",
        "tickers": ["NESN.SW"],
        "status": "open",
    }
    base.update(over)
    return base


def _news(**over):
    base = {
        "ts": (NOW - timedelta(hours=3)).isoformat(),
        "symbol": "NESN.SW",
        "title": "Le fret maritime bondit de 40 %",
        "link": "http://x.test/1",
        "sentiment": "neg",
    }
    base.update(over)
    return base


def _filing(**over):
    base = {
        "ts": (NOW - timedelta(hours=6)).isoformat(),
        "manager_id": "brk",
        "label": "Berkshire Hathaway",
        "form": "13F-HR",
        "filing_date": "2026-08-24",
        "accession": "acc-1",
    }
    base.update(over)
    return base


def _collect(hyps=(), news=(), filings=(), held=()):
    return convergence.collect_factors(NOW, list(hyps), list(news),
                                       list(filings), list(held))


def _flags(hyps=(), news=(), filings=(), held=()):
    return _collect(hyps, news, filings, held)["factors"]


def _notifier(sent, ok=True):
    def _send(text, cfg):
        sent.append((text, cfg))
        return ok
    return _send


def _llm(answer):
    def _call(prompt):
        return answer
    return _call


# =========================================================================== #
#  PUR — collect_factors, facteur par facteur
# =========================================================================== #

def test_aucune_matiere_aucun_facteur():
    out = _collect()
    assert out["factors"] == {c: False for c in convergence.FACTOR_CODES}
    assert out["items"] == []


def test_fresh_hyps_demande_au_moins_deux_hypotheses():
    assert _flags(hyps=[_hyp()])["fresh_hyps"] is False
    assert _flags(hyps=[_hyp(), _hyp(id="h2")])["fresh_hyps"] is True


def test_fresh_hyps_ignore_les_hypotheses_deja_notees():
    hyps = [_hyp(), _hyp(id="h2", status="scored")]
    assert _flags(hyps=hyps)["fresh_hyps"] is False


def test_fresh_hyps_ignore_une_hypothese_hors_fenetre():
    old = _hyp(id="h2", created_at=(NOW - timedelta(hours=49)).isoformat())
    assert _flags(hyps=[_hyp(), old])["fresh_hyps"] is False


def test_gov_sur_une_annonce_politique():
    gov = _news(symbol="GOV", sentiment="gov", title="Droits de douane à 50 %",
                link="http://x.test/gov")
    assert _flags(news=[gov])["gov"] is True
    assert _flags(news=[_news()])["gov"] is False


def test_held_catalyst_seulement_sur_un_titre_detenu():
    watch = _news(sentiment="watch", link="http://x.test/w")
    assert _flags(news=[watch], held=["NESN.SW"])["held_catalyst"] is True
    assert _flags(news=[watch], held=["TSLA"])["held_catalyst"] is False
    assert _flags(news=[watch])["held_catalyst"] is False


def test_held_catalyst_est_insensible_a_la_casse():
    watch = _news(sentiment="watch", symbol="nesn.sw", link="http://x.test/w")
    assert _flags(news=[watch], held=["NESN.SW"])["held_catalyst"] is True


def test_held_catalyst_ne_compte_pas_une_depeche_ordinaire():
    """Seul un CATALYSEUR (``watch``) allume ce facteur : une dépêche de plus
    sur un titre détenu n'est pas un rendez-vous à venir."""
    assert _flags(news=[_news()], held=["NESN.SW"])["held_catalyst"] is False


def test_whale_filing_dans_la_fenetre():
    assert _flags(filings=[_filing()])["whale_filing"] is True
    old = _filing(ts=(NOW - timedelta(hours=49)).isoformat())
    assert _flags(filings=[old])["whale_filing"] is False


def test_whale_filing_retombe_sur_la_date_de_depot():
    """Un dépôt sans ``ts`` porte quand même sa date : on la lit."""
    old = _filing(ts=None, filing_date="2026-08-01")
    assert _flags(filings=[old])["whale_filing"] is False


def test_cross_source_deux_familles_sur_le_meme_symbole():
    """Une hypothèse sur NESN.SW ET une dépêche à tonalité sur NESN.SW."""
    assert _flags(hyps=[_hyp()], news=[_news()])["cross_source"] is True


def test_cross_source_absent_quand_les_symboles_different():
    assert _flags(hyps=[_hyp(tickers=["TSLA"])],
                  news=[_news()])["cross_source"] is False


def test_cross_source_est_insensible_a_la_casse():
    hyp = _hyp(tickers=["nesn.sw"])
    news = _news(symbol="NESN.SW")
    assert _flags(hyps=[hyp], news=[news])["cross_source"] is True


def test_cross_source_ne_compte_pas_deux_fois_la_meme_famille():
    """Deux dépêches du même flux sur le même titre, ce n'est pas une
    convergence : c'est la même information comptée deux fois."""
    two = [_news(link="http://x.test/1"), _news(link="http://x.test/2")]
    assert _flags(news=two)["cross_source"] is False


def test_cross_source_marche_aussi_entre_depeche_et_catalyseur():
    news = _news(link="http://x.test/1")
    watch = _news(sentiment="watch", link="http://x.test/2")
    assert _flags(news=[news, watch])["cross_source"] is True


def test_cross_source_ignore_les_symboles_vides():
    """Une dépêche sans symbole et une hypothèse sans ticker ne « croisent »
    pas sur la chaîne vide."""
    hyp = _hyp(tickers=[])
    news = _news(symbol="", link="http://x.test/1")
    watch = _news(symbol="", sentiment="watch", link="http://x.test/2")
    assert _flags(hyps=[hyp], news=[news, watch])["cross_source"] is False


def test_la_fenetre_est_de_48_heures_pour_toutes_les_sources():
    old = (NOW - timedelta(hours=49)).isoformat()
    out = _collect(hyps=[_hyp(created_at=old), _hyp(id="h2", created_at=old)],
                   news=[_news(ts=old, sentiment="gov", symbol="GOV")],
                   filings=[_filing(ts=old)])
    assert out["factors"] == {c: False for c in convergence.FACTOR_CODES}
    assert out["items"] == []


def test_une_date_illisible_est_conservee():
    """Mieux vaut un déclencheur de trop qu'un déclencheur perdu parce qu'une
    source a changé son format de date (même posture que le radar)."""
    assert _flags(filings=[_filing(ts="jeudi dernier", filing_date="")])[
        "whale_filing"] is True


# --------------------------------------------------------------------------- #
# PUR — les items contributifs
# --------------------------------------------------------------------------- #

def test_les_items_ne_viennent_que_des_facteurs_allumes():
    """Une hypothèse SEULE n'allume rien : elle ne doit pas peser dans
    l'empreinte, sinon la moindre dépêche relancerait un digest identique."""
    out = _collect(hyps=[_hyp()], filings=[_filing()])
    assert out["factors"]["whale_filing"] is True
    assert out["factors"]["fresh_hyps"] is False
    assert [i["src"] for i in out["items"]] == ["filing"]


def test_chaque_item_porte_une_source_et_un_identifiant():
    gov = _news(symbol="GOV", sentiment="gov", link="http://x.test/gov")
    out = _collect(hyps=[_hyp(), _hyp(id="h2")], news=[gov], filings=[_filing()])
    assert {i["src"] for i in out["items"]} == {"hyp", "gov", "filing"}
    assert all(i["id"] for i in out["items"])


def test_un_item_contributif_a_deux_titres_n_apparait_qu_une_fois():
    """Une hypothèse peut porter ``fresh_hyps`` ET ``cross_source`` : elle ne
    doit pas être comptée deux fois dans les items."""
    out = _collect(hyps=[_hyp(), _hyp(id="h2")], news=[_news()])
    assert out["factors"]["fresh_hyps"] and out["factors"]["cross_source"]
    assert len([i for i in out["items"] if i["src"] == "hyp"]) == 2


def test_un_item_sans_identifiant_propre_en_recoit_un_stable():
    news = _news(link="")
    out = _collect(hyps=[_hyp()], news=[news])          # cross_source
    ids = [i["id"] for i in out["items"] if i["src"] == "news"]
    assert ids and ids == [i["id"] for i in _collect(
        hyps=[_hyp()], news=[_news(link="")])["items"] if i["src"] == "news"]


# =========================================================================== #
#  PUR — fingerprint
# =========================================================================== #

def test_fingerprint_est_stable_et_independant_de_l_ordre():
    a = [{"src": "hyp", "id": "1"}, {"src": "news", "id": "2"}]
    b = [{"src": "news", "id": "2"}, {"src": "hyp", "id": "1"}]
    assert convergence.fingerprint(a) == convergence.fingerprint(b)


def test_fingerprint_change_avec_le_contenu():
    a = [{"src": "hyp", "id": "1"}]
    b = [{"src": "hyp", "id": "1"}, {"src": "news", "id": "2"}]
    assert convergence.fingerprint(a) != convergence.fingerprint(b)


def test_fingerprint_distingue_deux_sources_au_meme_identifiant():
    a = [{"src": "hyp", "id": "1"}]
    b = [{"src": "news", "id": "1"}]
    assert convergence.fingerprint(a) != convergence.fingerprint(b)


def test_fingerprint_entrees_illisibles():
    assert convergence.fingerprint(None) == convergence.fingerprint([])
    assert convergence.fingerprint(["pas un dict"]) == convergence.fingerprint([])


# =========================================================================== #
#  PUR — should_fire
# =========================================================================== #

def _two_factors():
    return {"fresh_hyps": True, "gov": True, "held_catalyst": False,
            "whale_filing": False, "cross_source": False}


def test_should_fire_a_deux_facteurs():
    assert convergence.should_fire(_two_factors(), {}, NOW, "fp") == (True, "ok")


def test_should_fire_refuse_un_seul_facteur():
    one = dict(_two_factors(), gov=False)
    assert convergence.should_fire(one, {}, NOW, "fp") == (False, "too_few")


def test_should_fire_accepte_le_retour_complet_de_collect_factors():
    """Signature tolérante : le dict de drapeaux OU l'enveloppe — le bug du
    mauvais niveau de lecture est la classe d'erreur la plus coûteuse du dépôt."""
    wrapped = {"factors": _two_factors(), "items": []}
    assert convergence.should_fire(wrapped, {}, NOW, "fp") == (True, "ok")


def test_should_fire_respecte_le_cooldown():
    state = {"last_fired": (NOW - timedelta(hours=5)).isoformat(),
             "last_fingerprint": "autre"}
    assert convergence.should_fire(_two_factors(), state, NOW, "fp") == (False, "cooldown")


def test_should_fire_apres_le_cooldown():
    state = {"last_fired": (NOW - timedelta(hours=7)).isoformat(),
             "last_fingerprint": "autre"}
    assert convergence.should_fire(_two_factors(), state, NOW, "fp") == (True, "ok")


def test_should_fire_refuse_la_redite():
    state = {"last_fired": (NOW - timedelta(hours=7)).isoformat(),
             "last_fingerprint": "fp"}
    assert convergence.should_fire(_two_factors(), state, NOW, "fp") == (False, "same_items")


def test_should_fire_ignore_un_dernier_envoi_dans_le_futur():
    """Une horloge décalée verrouillerait le cooldown POUR TOUJOURS."""
    state = {"last_fired": (NOW + timedelta(days=3)).isoformat()}
    assert convergence.should_fire(_two_factors(), state, NOW, "fp") == (True, "ok")


def test_force_saute_le_cooldown_et_l_empreinte():
    state = {"last_fired": (NOW - timedelta(minutes=1)).isoformat(),
             "last_fingerprint": "fp"}
    assert convergence.should_fire(_two_factors(), state, NOW, "fp",
                                   force=True) == (True, "ok")


def test_force_ne_saute_PAS_le_seuil_de_facteurs():
    """Un digest sans convergence n'a rien à dire : le forcer produirait
    exactement le bruit qu'on vient de supprimer."""
    one = dict(_two_factors(), gov=False)
    assert convergence.should_fire(one, {}, NOW, "fp", force=True) == (False, "too_few")


def test_should_fire_tolere_un_etat_deforme():
    assert convergence.should_fire(_two_factors(), "pas un dict", NOW, "fp") == (True, "ok")
    assert convergence.should_fire(None, {}, NOW, "fp") == (False, "too_few")


# =========================================================================== #
#  PUR — prompt et résumé de secours
# =========================================================================== #

def _digest_items():
    return _collect(hyps=[_hyp(), _hyp(id="h2")],
                    news=[_news(symbol="GOV", sentiment="gov",
                                link="http://x.test/gov")])


def test_le_prompt_porte_le_bilan_du_radar():
    prompt = convergence.build_digest_prompt(
        _digest_items()["factors"], _digest_items()["items"],
        {"hits": 3, "misses": 2, "unclear": 1}, [], NOW.isoformat())
    assert "3 réussies / 2 ratées / 1 indécise" in prompt


def test_le_prompt_porte_les_interdits_et_la_structure():
    out = _digest_items()
    prompt = convergence.build_digest_prompt(out["factors"], out["items"],
                                             {}, [], NOW.isoformat())
    assert "OPPORTUNITÉS (simulateur)" in prompt
    assert "invalidé si" in prompt
    assert "0,5 %" in prompt and "1 %" in prompt
    assert "sûr" in prompt and "garanti" in prompt
    assert "ARGENT RÉEL" in prompt
    assert "inventer une donnée" in prompt


def test_le_prompt_liste_la_matiere_et_les_positions():
    out = _digest_items()
    prompt = convergence.build_digest_prompt(
        out["factors"], out["items"], {},
        [{"symbol": "NESN.SW", "side": "long", "qty": 10}], NOW.isoformat())
    assert "Le fret cher renchérit le café en Europe" in prompt
    assert "NESN.SW long x10" in prompt
    assert "annonce politique" in prompt


def test_le_prompt_sans_rien_reste_lisible():
    prompt = convergence.build_digest_prompt({}, [], None, None, "")
    assert "(aucun item)" in prompt and "(aucune)" in prompt


def test_le_resume_de_secours_tient_en_25_lignes():
    out = _collect(hyps=[_hyp(id="h%d" % i) for i in range(30)],
                   news=[_news(symbol="GOV", sentiment="gov",
                               link="http://x.test/gov")])
    text = convergence.fallback_digest(out["factors"], out["items"],
                                       {"hits": 1, "misses": 0, "unclear": 0})
    lines = text.split("\n")
    assert len(lines) <= convergence.MAX_FALLBACK_LINES
    assert lines[0] == convergence.HEADER
    assert lines[-1] == convergence.FALLBACK_TAIL
    assert "1 réussies / 0 ratées / 0 indécises" in text


def test_le_resume_de_secours_dit_ce_qui_a_convergé():
    out = _digest_items()
    text = convergence.fallback_digest(out["factors"], out["items"], {})
    assert "annonce politique" in text
    assert "Droits" in text or "fret" in text


def test_le_resume_de_secours_sans_rien():
    text = convergence.fallback_digest({}, [], {})
    assert text.startswith(convergence.HEADER)
    assert text.endswith(convergence.FALLBACK_TAIL)


def test_le_titre_de_la_note_ne_deborde_pas():
    """Tous les facteurs = un titre à rallonge : on garde les trois premiers et
    on compte le reste. Le suffixe SUIT le nombre de facteurs (il n'est donc
    pas écrit en dur ici) — sinon ajouter un facteur casserait ce test sans
    qu'aucun comportement n'ait changé."""
    all_true = {c: True for c in convergence.FACTOR_CODES}
    title = convergence.format_note("digest", NOW.isoformat(), all_true, True).split("\n")[0]
    assert title.startswith("## 2026-08-24 — convergence (")
    assert title.endswith("+%d)" % (len(convergence.FACTOR_CODES) - 3))
    assert len(title) < 160


def test_la_note_dit_quand_le_modele_n_a_pas_repondu():
    note = convergence.format_note("brut", NOW.isoformat(), {"gov": True}, False)
    assert "Résumé de secours" in note
    assert "[[Radar]]" in note and note.endswith("\n")


def test_l_entete_est_commun_et_idempotent():
    assert convergence.with_header("bla").startswith(convergence.HEADER)
    twice = convergence.with_header(convergence.with_header("bla"))
    assert twice.count(convergence.HEADER) == 1


# =========================================================================== #
#  I/O — état
# =========================================================================== #

def test_save_state_est_atomique_et_600(tmp_path):
    convergence.save_state(convergence.blank_state())
    path = convergence.state_path()
    assert path.is_file()
    assert stat.S_IMODE(os.stat(str(path)).st_mode) == 0o600
    assert not [p for p in tmp_path.glob(".*tmp*")]     # aucun résidu


def test_load_state_absent_ou_corrompu_rend_un_etat_vierge():
    assert convergence.load_state() == convergence.blank_state()
    convergence.state_path().parent.mkdir(parents=True, exist_ok=True)
    convergence.state_path().write_text("{cassé", encoding="utf-8")
    assert convergence.load_state() == convergence.blank_state()


def test_load_state_tolere_une_forme_deformee():
    convergence.state_path().parent.mkdir(parents=True, exist_ok=True)
    convergence.state_path().write_text(
        json.dumps({"last_fired": 42, "last_fingerprint": [], "history": "non"}),
        encoding="utf-8")
    state = convergence.load_state()
    assert state == convergence.blank_state()


def test_recent_rend_l_historique_borne():
    convergence.save_state({
        "last_fired": None, "last_fingerprint": None,
        "history": [{"ts": "t%d" % i} for i in range(20)]})
    assert len(convergence.recent(limit=5)["history"]) == 5
    assert convergence.recent(limit=5)["history"][0]["ts"] == "t0"


def test_recent_sans_etat():
    assert convergence.recent() == {"history": []}


# =========================================================================== #
#  I/O — maybe_fire
# =========================================================================== #

def _radar_state(hyps=(), stats=None):
    return lambda: {"hypotheses": list(hyps),
                    "stats": stats or {"hits": 1, "misses": 2, "unclear": 0}}


def test_maybe_fire_chemin_heureux(sources, alice, tmp_path):
    """Deux facteurs -> digest rédigé, envoyé, état armé, carnet écrit."""
    sources.events = [_news(symbol="GOV", sentiment="gov", link="http://x.test/gov")]
    sources.filings = [_filing()]
    sent = []

    out = convergence.maybe_fire(now=NOW, llm=_llm("Voici ce qui converge."),
                                 notifier=_notifier(sent), tg_cfg=TG,
                                 fetch_state=_radar_state())

    assert out["fired"] is True and out["reason"] == "ok"
    assert out["sent"] is True and out["llm"] is True
    assert out["factors"]["gov"] and out["factors"]["whale_filing"]

    assert len(sent) == 1
    text, cfg = sent[0]
    assert cfg == TG
    assert text.startswith(convergence.HEADER)
    assert "Voici ce qui converge." in text

    state = convergence.load_state()
    assert state["last_fired"] == NOW.isoformat()
    assert state["last_fingerprint"]
    assert len(state["history"]) == 1
    entry = state["history"][0]
    assert entry["factors"] == ["gov", "whale_filing"]
    assert entry["n_items"] == 2 and entry["llm"] is True

    note = (tmp_path / "alice-vault" / "Signaux.md").read_text(encoding="utf-8")
    assert "## 2026-08-24 — convergence" in note
    assert "Voici ce qui converge." in note


def test_maybe_fire_lit_les_tendances_reddit_du_guetteur(sources, alice):
    """Le facteur ``crowd_buzz`` vient de l'état de ``newswatch`` — et l'horloge
    passée est celle du RUN, pas celle du système : les fenêtres 24 h / 24-48 h
    doivent parler du même instant que le reste du calcul."""
    sources.events = [_news(symbol="GOV", sentiment="gov",
                            link="http://x.test/gov")]
    sources.trends = {"NESN.SW": {"count": 15, "prev": 2}}

    out = convergence.maybe_fire(now=NOW, llm=_llm("digest"),
                                 notifier=_notifier([]), tg_cfg=TG,
                                 fetch_state=_radar_state())

    assert out["factors"]["crowd_buzz"] is True
    assert sources.trend_clock == [NOW]


def test_un_guetteur_sans_tendances_ne_casse_rien(sources, alice):
    """Le module ou l'état absent -> pas de facteur, jamais une exception."""
    sources.trends = {}
    out = convergence.maybe_fire(now=NOW, llm=_llm("digest"),
                                 notifier=_notifier([]), tg_cfg=TG,
                                 fetch_state=_radar_state())
    assert out["factors"]["crowd_buzz"] is False


def test_maybe_fire_ecrit_la_note_chez_chaque_compte(sources, tmp_path):
    sources.events = [_news(symbol="GOV", sentiment="gov", link="http://x.test/gov")]
    sources.filings = [_filing()]
    for user in ("alice", "bob"):
        store.save_portfolio(user, {"cash_chf": 1.0, "positions": []})

    convergence.maybe_fire(now=NOW, llm=_llm("digest"), notifier=_notifier([]),
                           tg_cfg=TG, fetch_state=_radar_state())

    for user in ("alice", "bob"):
        assert (tmp_path / ("%s-vault" % user) / "Signaux.md").is_file()


def test_maybe_fire_utilise_les_positions_detenues(sources, alice):
    """Le facteur ``held_catalyst`` lit le portefeuille réel du compte."""
    sources.events = [_news(sentiment="watch", link="http://x.test/w"),
                      _news(symbol="GOV", sentiment="gov", link="http://x.test/gov")]
    out = convergence.maybe_fire(now=NOW, llm=_llm("digest"),
                                 notifier=_notifier([]), tg_cfg=TG,
                                 fetch_state=_radar_state())
    assert out["factors"]["held_catalyst"] is True and out["fired"] is True


def test_maybe_fire_utilise_aussi_la_watchlist(sources, alice):
    """``held_catalyst`` s'allume aussi sur un titre SUIVI (watchlist), pas
    seulement détenu — extension utilisateur ``watched = held ∪ watchlist``.
    TSLA n'est PAS dans les positions d'``alice`` (qui détient NESN.SW),
    seulement dans sa watchlist : c'est bien elle qui doit allumer le facteur.
    """
    store.save_watchlist("alice", [{"symbol": "TSLA", "name": "Tesla Inc",
                                    "currency": "USD",
                                    "added_at": NOW.isoformat()}])
    sources.events = [_news(symbol="TSLA", sentiment="watch", link="http://x.test/w2"),
                      _news(symbol="GOV", sentiment="gov", link="http://x.test/gov")]
    out = convergence.maybe_fire(now=NOW, llm=_llm("digest"),
                                 notifier=_notifier([]), tg_cfg=TG,
                                 fetch_state=_radar_state())
    assert out["factors"]["held_catalyst"] is True and out["fired"] is True


def test_maybe_fire_llm_en_panne_envoie_le_resume_brut(sources, alice):
    """Le déclencheur EST la valeur : une panne de rédaction n'annule pas le
    message, elle le dégrade."""
    sources.events = [_news(symbol="GOV", sentiment="gov", link="http://x.test/gov")]
    sources.filings = [_filing()]
    sent = []

    def boom(prompt):
        raise RuntimeError("CLI Claude introuvable")

    out = convergence.maybe_fire(now=NOW, llm=boom, notifier=_notifier(sent),
                                 tg_cfg=TG, fetch_state=_radar_state())

    assert out["fired"] is True and out["llm"] is False and out["sent"] is True
    assert convergence.FALLBACK_TAIL in sent[0][0]
    assert convergence.load_state()["history"][0]["llm"] is False


def test_maybe_fire_llm_muet_bascule_aussi_sur_le_resume_brut(sources, alice):
    """Une réponse vide n'est pas une réponse."""
    sources.events = [_news(symbol="GOV", sentiment="gov", link="http://x.test/gov")]
    sources.filings = [_filing()]
    sent = []
    out = convergence.maybe_fire(now=NOW, llm=_llm("   "), notifier=_notifier(sent),
                                 tg_cfg=TG, fetch_state=_radar_state())
    assert out["llm"] is False and convergence.FALLBACK_TAIL in sent[0][0]


def test_maybe_fire_sans_canal_telegram_n_arme_rien(sources, alice):
    """Le message n'a été composé pour personne : il doit pouvoir partir dès
    qu'un canal existe."""
    sources.events = [_news(symbol="GOV", sentiment="gov", link="http://x.test/gov")]
    sources.filings = [_filing()]
    calls = []

    out = convergence.maybe_fire(now=NOW, llm=lambda p: calls.append(p) or "d",
                                 notifier=_notifier([]), tg_cfg={},
                                 fetch_state=_radar_state())

    assert out == {"fired": False, "reason": "no_telegram",
                   "factors": out["factors"], "sent": False, "llm": False}
    assert calls == []                                  # pas un jeton dépensé
    assert convergence.load_state() == convergence.blank_state()


def test_maybe_fire_sans_canal_configure_du_tout(sources, alice, monkeypatch):
    """Même chose quand ``tg_cfg`` n'est pas fourni : ``alerts`` ne trouve rien."""
    sources.events = [_news(symbol="GOV", sentiment="gov", link="http://x.test/gov")]
    sources.filings = [_filing()]
    out = convergence.maybe_fire(now=NOW, llm=_llm("d"), notifier=_notifier([]),
                                 fetch_state=_radar_state())
    assert out["reason"] == "no_telegram"


def test_maybe_fire_envoi_rate_arme_quand_meme_l_etat(sources, alice):
    """Sinon le même message repartirait à chaque passage du radar : une redite
    en boucle est pire qu'un digest perdu, qui se rattrape au signal suivant."""
    sources.events = [_news(symbol="GOV", sentiment="gov", link="http://x.test/gov")]
    sources.filings = [_filing()]
    out = convergence.maybe_fire(now=NOW, llm=_llm("digest"),
                                 notifier=_notifier([], ok=False), tg_cfg=TG,
                                 fetch_state=_radar_state())
    assert out["fired"] is True and out["sent"] is False
    assert convergence.load_state()["last_fired"] == NOW.isoformat()


def test_maybe_fire_notifieur_en_panne_ne_casse_rien(sources, alice):
    sources.events = [_news(symbol="GOV", sentiment="gov", link="http://x.test/gov")]
    sources.filings = [_filing()]

    def boom(text, cfg):
        raise RuntimeError("Telegram down")

    out = convergence.maybe_fire(now=NOW, llm=_llm("digest"), notifier=boom,
                                 tg_cfg=TG, fetch_state=_radar_state())
    assert out["fired"] is True and out["sent"] is False


def test_maybe_fire_trop_peu_de_facteurs(sources, alice):
    sources.filings = [_filing()]                       # un seul facteur
    sent = []
    out = convergence.maybe_fire(now=NOW, llm=_llm("digest"),
                                 notifier=_notifier(sent), tg_cfg=TG,
                                 fetch_state=_radar_state())
    assert out == {"fired": False, "reason": "too_few", "factors": out["factors"],
                   "sent": False, "llm": False}
    assert sent == []
    assert convergence.load_state() == convergence.blank_state()


def test_maybe_fire_respecte_le_cooldown(sources, alice):
    sources.events = [_news(symbol="GOV", sentiment="gov", link="http://x.test/gov")]
    sources.filings = [_filing()]
    sent = []
    convergence.maybe_fire(now=NOW, llm=_llm("digest"), notifier=_notifier(sent),
                           tg_cfg=TG, fetch_state=_radar_state())
    later = NOW + timedelta(hours=1)
    sources.filings = [_filing(accession="acc-2")]      # matière DIFFÉRENTE
    out = convergence.maybe_fire(now=later, llm=_llm("digest"),
                                 notifier=_notifier(sent), tg_cfg=TG,
                                 fetch_state=_radar_state())
    assert out["reason"] == "cooldown" and len(sent) == 1


def test_maybe_fire_refuse_la_redite_apres_le_cooldown(sources, alice):
    sources.events = [_news(symbol="GOV", sentiment="gov", link="http://x.test/gov")]
    sources.filings = [_filing()]
    sent = []
    convergence.maybe_fire(now=NOW, llm=_llm("digest"), notifier=_notifier(sent),
                           tg_cfg=TG, fetch_state=_radar_state())
    later = NOW + timedelta(hours=7)                    # cooldown écoulé...
    out = convergence.maybe_fire(now=later, llm=_llm("digest"),
                                 notifier=_notifier(sent), tg_cfg=TG,
                                 fetch_state=_radar_state())
    assert out["reason"] == "same_items" and len(sent) == 1   # ...mais rien de neuf


def test_maybe_fire_force_saute_cooldown_et_redite(sources, alice):
    sources.events = [_news(symbol="GOV", sentiment="gov", link="http://x.test/gov")]
    sources.filings = [_filing()]
    sent = []
    convergence.maybe_fire(now=NOW, llm=_llm("digest"), notifier=_notifier(sent),
                           tg_cfg=TG, fetch_state=_radar_state())
    out = convergence.maybe_fire(now=NOW + timedelta(minutes=5), llm=_llm("digest"),
                                 notifier=_notifier(sent), tg_cfg=TG,
                                 fetch_state=_radar_state(), force=True)
    assert out["fired"] is True and len(sent) == 2
    assert len(convergence.load_state()["history"]) == 2


def test_maybe_fire_force_ne_force_pas_un_digest_vide(sources, alice):
    sent = []
    out = convergence.maybe_fire(now=NOW, llm=_llm("digest"),
                                 notifier=_notifier(sent), tg_cfg=TG,
                                 fetch_state=_radar_state(), force=True)
    assert out == {"fired": False, "reason": "too_few", "factors": out["factors"],
                   "sent": False, "llm": False}
    assert sent == []


def test_maybe_fire_lit_les_hypotheses_du_radar(sources, alice):
    """Deux hypothèses fraîches + une annonce politique = convergence."""
    sources.events = [_news(symbol="GOV", sentiment="gov", link="http://x.test/gov")]
    out = convergence.maybe_fire(
        now=NOW, llm=_llm("digest"), notifier=_notifier([]), tg_cfg=TG,
        fetch_state=_radar_state(hyps=[_hyp(), _hyp(id="h2")]))
    assert out["factors"]["fresh_hyps"] is True and out["fired"] is True


def test_maybe_fire_sans_fetch_state_lit_l_etat_du_radar(sources, alice):
    """Par défaut, l'état vient du module radar lui-même (fichier isolé en tmp)."""
    from backend.bots.paper import radar
    radar.save_state({"hypotheses": [_hyp(), _hyp(id="h2")],
                      "stats": {"hits": 0, "misses": 0, "unclear": 0}})
    sources.events = [_news(symbol="GOV", sentiment="gov", link="http://x.test/gov")]
    out = convergence.maybe_fire(now=NOW, llm=_llm("digest"),
                                 notifier=_notifier([]), tg_cfg=TG)
    assert out["factors"]["fresh_hyps"] is True and out["fired"] is True


def test_maybe_fire_dedoublonne_les_depeches_entre_comptes(sources):
    """``recent_events`` fusionne déjà les annonces politiques GLOBALES dans le
    retour de chaque compte : sans déduplication, une annonce compterait autant
    de fois qu'il y a de comptes."""
    for user in ("alice", "bob"):
        store.save_portfolio(user, {"cash_chf": 1.0, "positions": []})
    sources.events = [_news(symbol="GOV", sentiment="gov", link="http://x.test/gov")]
    sources.filings = [_filing()]

    out = convergence.maybe_fire(now=NOW, llm=_llm("digest"),
                                 notifier=_notifier([]), tg_cfg=TG,
                                 fetch_state=_radar_state())

    assert sources.asked == ["alice", "bob"]
    assert convergence.load_state()["history"][0]["n_items"] == 2   # 1 gov + 1 dépôt


def test_maybe_fire_sources_absentes_ne_casse_rien(alice, monkeypatch):
    """Aucun stub de newswatch/whales : les imports paresseux échouent ou
    rendent du vide -> pas de matière, pas de digest, pas d'exception."""
    monkeypatch.setitem(sys.modules, "backend.bots.paper.newswatch", None)
    monkeypatch.setitem(sys.modules, "backend.bots.paper.whales", None)
    out = convergence.maybe_fire(now=NOW, llm=_llm("digest"),
                                 notifier=_notifier([]), tg_cfg=TG,
                                 fetch_state=_radar_state())
    assert out["fired"] is False and out["reason"] == "too_few"


def test_maybe_fire_source_en_panne_est_avalee(sources, alice):
    def boom(username):
        raise IOError("état illisible")

    sources.events = [_news(symbol="GOV", sentiment="gov", link="http://x.test/gov")]
    import backend.bots.paper.newswatch as stub
    stub.recent_events = boom
    sources.filings = [_filing()]

    out = convergence.maybe_fire(now=NOW, llm=_llm("digest"),
                                 notifier=_notifier([]), tg_cfg=TG,
                                 fetch_state=_radar_state())
    assert out["factors"]["gov"] is False       # la source muette a juste disparu
    assert out["fired"] is False


def test_maybe_fire_etat_du_radar_en_panne_est_avale(sources, alice):
    def boom():
        raise RuntimeError("radar cassé")

    sources.events = [_news(symbol="GOV", sentiment="gov", link="http://x.test/gov")]
    sources.filings = [_filing()]
    out = convergence.maybe_fire(now=NOW, llm=_llm("digest"),
                                 notifier=_notifier([]), tg_cfg=TG,
                                 fetch_state=boom)
    assert out["fired"] is True                 # les autres sources suffisent


def test_maybe_fire_borne_l_historique(sources, alice, monkeypatch):
    monkeypatch.setattr(convergence, "MAX_HISTORY", 3)
    sources.events = [_news(symbol="GOV", sentiment="gov", link="http://x.test/gov")]
    sources.filings = [_filing()]
    for i in range(5):
        convergence.maybe_fire(now=NOW + timedelta(hours=7 * i), llm=_llm("d%d" % i),
                               notifier=_notifier([]), tg_cfg=TG,
                               fetch_state=_radar_state(), force=True)
    history = convergence.load_state()["history"]
    assert len(history) == 3
    assert history[0]["digest"].endswith("d4")          # le plus récent en tête


# =========================================================================== #
#  PUR — held_risk : une mauvaise nouvelle sur un titre DÉTENU (26/08)
# =========================================================================== #

def _collect6(hyps=(), news=(), filings=(), watched=(), held=(), moves=()):
    """``collect_factors`` avec les deux ensembles SÉPARÉS (suivis / détenus)
    et les mouvements de gérants."""
    return convergence.collect_factors(NOW, list(hyps), list(news),
                                       list(filings), list(watched),
                                       held_symbols=list(held),
                                       whale_moves=list(moves))


def test_held_risk_s_allume_sur_une_mauvaise_nouvelle_d_un_titre_detenu():
    out = _collect6(news=[_news(sentiment="neg")], held=["NESN.SW"])
    assert out["factors"]["held_risk"] is True
    assert [i["src"] for i in out["items"]] == ["neg_held"]


def test_held_risk_ignore_un_titre_seulement_SUIVI():
    """La watchlist ne suffit PAS : ici on parle d'argent qui bouge, pas
    d'information."""
    out = _collect6(news=[_news(sentiment="neg")], watched=["NESN.SW"])
    assert out["factors"]["held_risk"] is False


def test_held_risk_sans_ensemble_detenu_est_faux():
    """Défaut = ensemble VIDE, jamais un repli sur les titres suivis."""
    flags = convergence.collect_factors(
        NOW, [], [_news(sentiment="neg")], [], ["NESN.SW"])["factors"]
    assert flags["held_risk"] is False


def test_held_risk_ignore_une_bonne_nouvelle():
    out = _collect6(news=[_news(sentiment="pos")], held=["NESN.SW"])
    assert out["factors"]["held_risk"] is False


def test_held_risk_ne_regarde_que_la_fenetre_de_48h():
    vieux = _news(sentiment="neg", ts=(NOW - timedelta(hours=60)).isoformat())
    assert _collect6(news=[vieux], held=["NESN.SW"])["factors"]["held_risk"] is False


def test_held_risk_accepte_le_synonyme_negative():
    """Un état plus ancien peut porter « negative » : un facteur ne doit pas
    s'éteindre sur un synonyme (même prudence que ``_is_polar``)."""
    out = _collect6(news=[_news(sentiment="negative")], held=["NESN.SW"])
    assert out["factors"]["held_risk"] is True


def test_une_meme_depeche_n_est_comptee_qu_une_fois():
    """``held_risk`` et ``cross_source`` peuvent proposer LA MÊME dépêche sous
    deux étiquettes — la matière ne doit pas doubler pour autant."""
    news = _news(sentiment="neg")
    out = _collect6(hyps=[_hyp(), _hyp(id="h2")], news=[news], held=["NESN.SW"],
                    watched=["NESN.SW"])
    ids = [i["id"] for i in out["items"]]
    assert len(ids) == len(set(ids))


# =========================================================================== #
#  PUR — les volets MONDE (éco, climat) rejoignent le pool GÉNÉRIQUE (26/08 soir)
#
#  Décision de conception : ces deux volets n'ont AUCUN facteur à eux, et ils
#  n'allument PAS celui de la politique. Ils portent une tonalité ordinaire
#  (pos/neg/watch), donc ils pèsent exactement comme une dépêche de presse —
#  ni plus (pas de facteur inventé), ni moins (ils comptent vraiment).
# =========================================================================== #

def _world_news(src, **over):
    base = {
        "ts": (NOW - timedelta(hours=3)).isoformat(),
        "symbol": None,
        "title": "L'inflation américaine accélère",
        "link": "http://w.test/%s" % src,
        "sentiment": "neg",
        "src": src,
    }
    base.update(over)
    return base


@pytest.mark.parametrize("src", ["eco", "climat"])
def test_une_depeche_monde_n_allume_pas_le_facteur_politique(src):
    """C'est l'invariant du chantier : le facteur ``gov`` ne regarde QUE la
    tonalité ``gov``, que seul le volet politique produit."""
    out = _collect6(news=[_world_news(src)])
    assert out["factors"]["gov"] is False


def test_une_annonce_politique_allume_toujours_son_facteur():
    """Ceinture de l'invariant précédent : on n'a rien cassé du volet
    politique en ajoutant les deux autres."""
    out = _collect6(news=[_news(sentiment="gov", symbol="GOV")])
    assert out["factors"]["gov"] is True


@pytest.mark.parametrize("src", ["eco", "climat"])
def test_une_mauvaise_nouvelle_monde_sur_un_titre_detenu_allume_held_risk(src):
    """« Une sécheresse ampute la récolte » avec un titre DÉTENU dedans, c'est
    de l'argent qui bouge : ``entities`` a posé le symbole, le facteur de
    menace le lit comme n'importe quelle mauvaise nouvelle."""
    out = _collect6(news=[_world_news(src, symbol="NESN.SW")],
                    held=["NESN.SW"])
    assert out["factors"]["held_risk"] is True
    assert out["factors"]["gov"] is False


@pytest.mark.parametrize("src", ["eco", "climat"])
def test_une_depeche_monde_participe_au_croisement_de_sources(src):
    """Deux familles différentes sur le même titre : une hypothèse du radar et
    une dépêche macro à tonalité, c'est bien un croisement."""
    out = _collect6(hyps=[_hyp()], news=[_world_news(src, symbol="NESN.SW")])
    assert out["factors"]["cross_source"] is True


@pytest.mark.parametrize("src", ["eco", "climat"])
def test_un_catalyseur_monde_sur_un_titre_suivi_allume_held_catalyst(src):
    out = _collect6(news=[_world_news(src, symbol="NESN.SW",
                                      sentiment="watch")],
                    watched=["NESN.SW"])
    assert out["factors"]["held_catalyst"] is True


def test_les_volets_monde_n_ajoutent_aucun_facteur_au_contrat():
    """« Pas de nouveau facteur » : le contrat public reste les huit codes."""
    assert convergence.FACTOR_CODES == (
        "fresh_hyps", "gov", "held_catalyst", "held_risk", "whale_filing",
        "whale_sold_watched", "cross_source", "crowd_buzz")


# =========================================================================== #
#  PUR — whale_sold_watched : un grand gérant a vendu (26/08)
# =========================================================================== #

def _move(**over):
    base = {
        "manager_id": "brk",
        "manager_label": "Warren Buffett — Berkshire Hathaway",
        "quarter": "T2 2026",
        "action": "sortie",
        "name": "NESTLE SA",
        "class": "COM",
        "symbol": "NESN.SW",
        "fetched_at": (NOW - timedelta(days=1)).isoformat(),
    }
    base.update(over)
    return base


def test_whale_sold_watched_sur_un_titre_detenu():
    out = _collect6(moves=[_move()], held=["NESN.SW"], watched=["NESN.SW"])
    assert out["factors"]["whale_sold_watched"] is True
    assert [i["src"] for i in out["items"]] == ["whale_move"]
    assert "sortie" in out["items"][0]["title"]


def test_whale_sold_watched_compte_aussi_un_titre_seulement_suivi():
    out = _collect6(moves=[_move()], watched=["NESN.SW"])
    assert out["factors"]["whale_sold_watched"] is True


def test_whale_sold_watched_ignore_un_titre_ni_detenu_ni_suivi():
    out = _collect6(moves=[_move()], watched=["TSLA"])
    assert out["factors"]["whale_sold_watched"] is False


@pytest.mark.parametrize("action", ["nouveau", "renforcé"])
def test_whale_sold_watched_ignore_les_achats(action):
    """C'est la VENTE qu'on cherche : « ils peuvent voir quelque chose qu'on ne
    voit pas en vendant »."""
    out = _collect6(moves=[_move(action=action)], watched=["NESN.SW"])
    assert out["factors"]["whale_sold_watched"] is False


def test_whale_sold_watched_ignore_un_snapshot_de_dix_jours():
    vieux = _move(fetched_at=(NOW - timedelta(days=10)).isoformat())
    out = _collect6(moves=[vieux], watched=["NESN.SW"])
    assert out["factors"]["whale_sold_watched"] is False


def test_whale_sold_watched_accepte_un_allegement_avec_son_pourcentage():
    out = _collect6(moves=[_move(action="allégé", delta_pct=-31.4)],
                    watched=["NESN.SW"])
    assert out["factors"]["whale_sold_watched"] is True
    assert "-31.4" in out["items"][0]["title"]


# =========================================================================== #
#  PUR — crowd_buzz : la foule Reddit s'agite (26/08 soir)
# =========================================================================== #

def _crowd(hyps=(), news=(), watched=(), held=(), trends=None):
    return convergence.collect_factors(NOW, list(hyps), list(news), [],
                                       list(watched), held_symbols=list(held),
                                       reddit_trends=trends if trends is not None
                                       else {})


def test_crowd_buzz_sur_un_titre_detenu_qui_s_emballe():
    out = _crowd(trends={"NESN.SW": {"count": 12, "prev": 3}}, held=["NESN.SW"],
                 watched=["NESN.SW"])
    assert out["factors"]["crowd_buzz"] is True
    item = [i for i in out["items"] if i["src"] == "crowd"][0]
    assert item["symbol"] == "NESN.SW"
    assert "la foule Reddit s'agite sur NESN.SW" in item["title"]
    assert "12 mentions" in item["title"] and "×4,0" in item["title"]


def test_crowd_buzz_compte_aussi_un_titre_seulement_SUIVI():
    out = _crowd(trends={"TSLA": {"count": 9, "prev": 0}}, watched=["TSLA"])
    assert out["factors"]["crowd_buzz"] is True
    assert "aucune la veille" in out["items"][0]["title"]


def test_crowd_buzz_ignore_un_titre_ni_detenu_ni_suivi():
    """La foule parle de tout ; ce facteur ne parle que de CE portefeuille."""
    out = _crowd(trends={"GME": {"count": 80, "prev": 2}}, watched=["NESN.SW"])
    assert out["factors"]["crowd_buzz"] is False


def test_crowd_buzz_exige_un_nombre_minimum_de_mentions():
    """Trois personnes qui en parlent, ce n'est pas une foule."""
    assert _crowd(trends={"TSLA": {"count": 4, "prev": 0}},
                  watched=["TSLA"])["factors"]["crowd_buzz"] is False
    assert _crowd(trends={"TSLA": {"count": 5, "prev": 0}},
                  watched=["TSLA"])["factors"]["crowd_buzz"] is True


def test_crowd_buzz_exige_une_ACCELERATION_pas_un_volume():
    """Un titre dont la foule parle tous les jours ne dit rien de neuf."""
    assert _crowd(trends={"TSLA": {"count": 40, "prev": 30}},
                  watched=["TSLA"])["factors"]["crowd_buzz"] is False
    assert _crowd(trends={"TSLA": {"count": 61, "prev": 30}},
                  watched=["TSLA"])["factors"]["crowd_buzz"] is True


def test_crowd_buzz_est_insensible_a_la_casse_du_symbole():
    out = _crowd(trends={"tsla": {"count": 9, "prev": 1}}, watched=["TSLA"])
    assert out["factors"]["crowd_buzz"] is True


@pytest.mark.parametrize("bad", [None, "cassé", {"TSLA": "pas un dict"},
                                 {"TSLA": {"count": "beaucoup"}}, {}])
def test_crowd_buzz_est_tolerant_a_un_etat_deforme(bad):
    out = _crowd(trends=bad, watched=["TSLA"])
    assert out["factors"]["crowd_buzz"] is False


def test_les_tickers_les_plus_mentionnes_viennent_en_premier():
    out = _crowd(trends={"AAPL": {"count": 6, "prev": 0},
                         "TSLA": {"count": 20, "prev": 1}},
                 watched=["AAPL", "TSLA"])
    assert [i["symbol"] for i in out["items"]] == ["TSLA", "AAPL"]


def test_l_empreinte_change_quand_la_vague_grossit():
    """Sinon un digest resterait bloqué sur « même matière » alors que la foule
    est passée de 6 à 40 mentions."""
    small = _crowd(trends={"TSLA": {"count": 6, "prev": 0}}, watched=["TSLA"])
    big = _crowd(trends={"TSLA": {"count": 40, "prev": 0}}, watched=["TSLA"])
    assert convergence.fingerprint(small["items"]) \
        != convergence.fingerprint(big["items"])


def test_la_foule_ne_tire_JAMAIS_seule():
    """Le bruit social est un accélérant, pas une preuve : ``crowd_buzz`` n'est
    PAS un facteur de menace, il lui faut un second facteur."""
    assert "crowd_buzz" not in convergence.THREAT_FACTORS
    flags = {c: False for c in convergence.FACTOR_CODES}
    flags["crowd_buzz"] = True
    assert convergence.should_fire(flags, {}, NOW, "fp") == (False, "too_few")


def test_la_foule_ne_fabrique_pas_un_cross_source():
    """Une quatrième famille faite de bruit social permettrait à UNE dépêche de
    fabriquer un croisement. On la tient hors de ce calcul."""
    out = _crowd(news=[_news()], trends={"NESN.SW": {"count": 20, "prev": 0}},
                 held=["NESN.SW"], watched=["NESN.SW"])
    assert out["factors"]["crowd_buzz"] is True
    assert out["factors"]["cross_source"] is False


# =========================================================================== #
#  PUR — should_fire : les facteurs de MENACE tirent SEULS (26/08)
# =========================================================================== #

@pytest.mark.parametrize("code", convergence.THREAT_FACTORS)
def test_un_facteur_de_menace_tire_seul(code):
    """« Être le dernier à vendre est le seul cas qu'on ne peut pas se
    permettre » : le seuil de deux facteurs ne s'applique pas ici."""
    flags = {c: False for c in convergence.FACTOR_CODES}
    flags[code] = True
    assert convergence.should_fire(flags, {}, NOW, "fp") == (True, "ok")


def test_un_facteur_d_opportunite_seul_ne_tire_toujours_pas():
    flags = {c: False for c in convergence.FACTOR_CODES}
    flags["gov"] = True
    assert convergence.should_fire(flags, {}, NOW, "fp") == (False, "too_few")


def test_le_cooldown_tient_meme_pour_un_facteur_de_menace():
    """Le seuil saute, pas les garde-fous de redite : le coût reste borné."""
    flags = {c: False for c in convergence.FACTOR_CODES}
    flags["held_risk"] = True
    state = {"last_fired": (NOW - timedelta(hours=2)).isoformat()}
    assert convergence.should_fire(flags, state, NOW, "fp") == (False, "cooldown")


def test_l_empreinte_tient_meme_pour_un_facteur_de_menace():
    flags = {c: False for c in convergence.FACTOR_CODES}
    flags["held_risk"] = True
    state = {"last_fingerprint": "abc"}
    assert convergence.should_fire(flags, state, NOW, "abc") == (False, "same_items")


# =========================================================================== #
#  PUR — le prompt : débutant, risques, gérants, et « parle tôt »
# =========================================================================== #

def _prompt(**flags):
    base = {c: False for c in convergence.FACTOR_CODES}
    base.update(flags)
    return convergence.build_digest_prompt(base, [], {}, [], NOW.isoformat())


def test_le_prompt_s_adresse_a_un_debutant():
    assert "DÉBUTANT" in _prompt(gov=True)


def test_le_prompt_ouvre_une_section_risques_quand_le_compte_est_menace():
    prompt = _prompt(held_risk=True)
    assert "RISQUES SUR TES POSITIONS" in prompt
    assert "neg_held" in prompt


def test_le_prompt_n_ouvre_pas_la_section_risques_sans_menace():
    assert "RISQUES SUR TES POSITIONS" not in _prompt(gov=True)


def test_le_prompt_ouvre_une_section_gerant_et_dit_les_45_jours():
    """L'honnêteté sur la latence est OBLIGATOIRE : un 13F a jusqu'à 45 jours
    de retard, et le message doit le DIRE."""
    prompt = _prompt(whale_sold_watched=True)
    assert "UN GRAND GÉRANT A VENDU" in prompt
    assert "45 jours" in prompt
    assert "rotation" in prompt


def test_le_prompt_ouvre_une_section_foule_et_dit_ce_qu_elle_ne_prouve_pas():
    """La phrase demandée : « le bruit social est un accélérant, pas une
    preuve » — elle doit atteindre le modèle, pas seulement le code."""
    prompt = _prompt(crowd_buzz=True)
    assert "LA FOULE S'AGITE" in prompt
    assert "ACCÉLÉRANT, pas une preuve" in prompt
    assert "crowd" in prompt


def test_le_prompt_n_ouvre_pas_la_section_foule_sans_agitation():
    assert "LA FOULE S'AGITE" not in _prompt(gov=True)


def test_le_prompt_numerote_ses_blocs_dans_l_ordre():
    prompt = _prompt(held_risk=True, whale_sold_watched=True, crowd_buzz=True)
    for n, titre in ((1, "CE QUI S'ALIGNE"), (2, "OPPORTUNITÉS"),
                     (3, "RISQUES SUR TES POSITIONS"), (4, "UN GRAND GÉRANT"),
                     (5, "LA FOULE S'AGITE")):
        assert prompt.index("%d. " % n) < prompt.index(titre)
    assert "6. Une dernière ligne" in prompt


def test_le_prompt_interdit_d_attendre_la_confirmation():
    """« Le coach ne doit pas attendre le 100 % de sûreté, sinon on sera les
    derniers à acheter ou vendre »."""
    prompt = _prompt(gov=True)
    assert "jamais par l'attente" in prompt
    assert "attendre la confirmation" in prompt
    assert "INTERDIT" in prompt


# =========================================================================== #
#  I/O — verrou anti double-digest (26/08)
# =========================================================================== #

def test_deux_declenchements_dans_la_meme_fenetre_n_envoient_qu_un_digest(
        sources, alice):
    """Trois guetteurs (news 5 min, dépôts 30 min, radar 3×/j) tournent dans le
    MÊME process : sans la section critique, deux entrées simultanées liraient
    le même ``last_fired`` et enverraient deux fois le même message."""
    sources.events = [_news(symbol="GOV", sentiment="gov",
                            link="http://x.test/gov")]
    sources.filings = [_filing()]
    sent = []
    first = convergence.maybe_fire(now=NOW, llm=_llm("digest"),
                                   notifier=_notifier(sent), tg_cfg=TG,
                                   fetch_state=_radar_state())
    second = convergence.maybe_fire(now=NOW, llm=_llm("digest"),
                                    notifier=_notifier(sent), tg_cfg=TG,
                                    fetch_state=_radar_state())
    assert first["fired"] is True
    assert second["fired"] is False and second["reason"] in ("cooldown", "same_items")
    assert len(sent) == 1


def test_le_verrou_est_relache_meme_quand_rien_ne_part(sources, alice):
    """Un ``return`` dans la section critique ne doit pas laisser le verrou
    fermé : le cycle suivant se bloquerait pour toujours."""
    convergence.maybe_fire(now=NOW, llm=_llm("x"), notifier=_notifier([]),
                           tg_cfg=TG, fetch_state=_radar_state())
    assert convergence._FIRE_LOCK.acquire(blocking=False) is True
    convergence._FIRE_LOCK.release()


def test_maybe_fire_lit_les_mouvements_de_gerants(sources, alice):
    """Le facteur « un gérant a vendu » vient du CACHE des portefeuilles, via
    ``whales.moves_summary`` — jamais d'une requête SEC."""
    sources.moves = [_move(name="NESN SA", symbol=None)]
    out = convergence.maybe_fire(now=NOW, llm=_llm("digest"),
                                 notifier=_notifier([]), tg_cfg=TG,
                                 fetch_state=_radar_state())
    assert out["factors"]["whale_sold_watched"] is True
    assert out["fired"] is True                 # un facteur de menace tire seul


def test_le_nom_de_la_watchlist_l_emporte_sur_le_ticker(tmp_path):
    """⚠️ ``models.Position`` ne porte PAS de nom. Un titre à la fois DÉTENU et
    SUIVI est lu deux fois : d'abord sans nom (position), puis avec (watchlist).
    Si le premier passage gagnait, la clé resterait « NESN.SW » et aucun
    émetteur 13F (« NESTLE SA ») ne la rejoindrait jamais."""
    store.save_portfolio("alice", {
        "cash_chf": 1.0,
        "positions": [{"symbol": "NESN.SW", "qty": 1, "side": "long"}],
    })
    store.save_watchlist("alice", [{"symbol": "NESN.SW", "name": "Nestlé S.A."}])
    assert convergence._symbol_names(["alice"]) == {"NESN.SW": "Nestlé S.A."}


def test_un_titre_detenu_sans_nom_garde_au_moins_sa_cle(tmp_path):
    store.save_portfolio("alice", {
        "cash_chf": 1.0,
        "positions": [{"symbol": "TSLA", "qty": 1, "side": "long"}],
    })
    assert convergence._symbol_names(["alice"]) == {"TSLA": "TSLA"}


# =========================================================================== #
#  W2a — doctrine « le pouvoir nomme, l'administration investit »
# =========================================================================== #

def test_une_annonce_politique_qui_NOMME_un_titre_suivi_est_un_catalyseur():
    """Observation de Massii : quand un dirigeant cite une entreprise par son
    nom, l'argent public suit souvent, et le marché le sait avant la signature.

    Avant, un « l'administration veut acheter des cartes à Nvidia » n'allumait
    que ``gov`` — au même titre qu'une annonce de droits de douane sur l'acier
    qui ne concerne aucune position. Il désignait pourtant un titre précis, et
    suivi.
    """
    named = _news(symbol="NVDA", sentiment="gov",
                  title="L'administration veut acheter des cartes à Nvidia",
                  link="http://x.test/named")
    assert _flags(news=[named], held=["NVDA"])["held_catalyst"] is True
    assert _flags(news=[named], held=["NVDA"])["gov"] is True      # les DEUX


def test_une_annonce_politique_qui_ne_nomme_personne_reste_un_simple_gov():
    """Le facteur ne s'élargit pas au point de tout allumer : le pseudo-symbole
    « GOV » d'une annonce anonyme ne touche aucun titre."""
    anonymous = _news(symbol="GOV", sentiment="gov",
                      title="Droits de douane à 50 % sur l'acier",
                      link="http://x.test/anon")
    out = _flags(news=[anonymous], held=["NVDA"])
    assert out["gov"] is True and out["held_catalyst"] is False


def test_une_annonce_politique_sur_un_titre_NON_suivi_ne_compte_pas():
    named = _news(symbol="BA", sentiment="gov",
                  title="Commande publique record chez Boeing",
                  link="http://x.test/ba")
    assert _flags(news=[named], held=["NVDA"])["held_catalyst"] is False


def test_le_facteur_couvre_aussi_un_titre_DETENU_passe_a_part():
    """``watched`` porte déjà l'union côté appelant, mais ce facteur ne doit pas
    dépendre de la discipline d'un appelant pour couvrir les positions."""
    named = _news(symbol="NVDA", sentiment="gov", title="Nvidia nommée",
                  link="http://x.test/n2")
    out = _collect6(news=[named], watched=[], held=["NVDA"])
    assert out["factors"]["held_catalyst"] is True


def test_une_annonce_nommee_n_est_comptee_qu_UNE_fois_dans_la_matiere():
    """Elle porte deux facteurs (``gov`` et ``held_catalyst``) : le
    dédoublonnage par identifiant l'empêche de peser double dans l'empreinte."""
    named = _news(symbol="NVDA", sentiment="gov", title="Nvidia nommée",
                  link="http://x.test/n3")
    items = _collect(news=[named], held=["NVDA"])["items"]
    assert [i["id"] for i in items] == ["http://x.test/n3"]


def test_le_digest_porte_la_doctrine_du_pouvoir_qui_nomme():
    """Écrite UNE fois (dans ``llm.py``) et injectée dans les trois prompts qui
    proposent des mouvements — deux formulations d'une même doctrine divergent
    au premier ajustement, et personne ne s'en aperçoit."""
    from backend.bots.paper.llm import POWER_NAMED_LINE
    prompt = convergence.build_digest_prompt(
        {"gov": True, "held_catalyst": True}, [], {}, [], NOW.isoformat())
    assert POWER_NAMED_LINE in prompt
    assert "PROMESSES" in prompt      # une mention n'est pas un contrat


def test_le_digest_part_quand_meme_si_la_doctrine_est_illisible(monkeypatch):
    """Une consigne de plus n'a jamais valu qu'on perde un message."""
    monkeypatch.setattr(convergence, "_power_named_line", lambda: "")
    prompt = convergence.build_digest_prompt({"gov": True}, [], {}, [],
                                             NOW.isoformat())
    assert "POURQUOI CE MESSAGE PART MAINTENANT" in prompt


# =========================================================================== #
#  F1 — DEUX facteurs, mais UN SEUL fait (27/08)
#
#  Le seuil comptait des ÉTIQUETTES. Une annonce politique qui nomme un titre
#  suivi allume ``gov`` ET ``held_catalyst`` : deux facteurs pour un seul
#  événement, c'est-à-dire exactement ce que le module s'interdit trois
#  paragraphes plus haut (« la même information comptée deux fois n'est pas une
#  convergence »).
# =========================================================================== #

def _named_gov(**over):
    """Une annonce politique qui NOMME un titre suivi — l'événement qui porte
    deux étiquettes à lui tout seul."""
    base = dict(symbol="NVDA", sentiment="gov", link="http://x.test/named",
                title="L'administration veut acheter des cartes à Nvidia")
    base.update(over)
    return _news(**base)


def test_F1_un_seul_event_gov_nommant_un_titre_suivi_ne_converge_PAS():
    """Reproduction du finding : ``gov`` + ``held_catalyst`` = 2 drapeaux, mais
    une seule dépêche. Le digest partait sur un événement unique."""
    collected = _collect6(news=[_named_gov()], held=["NVDA"])
    assert collected["factors"]["gov"] is True
    assert collected["factors"]["held_catalyst"] is True     # les deux drapeaux
    assert convergence.independent_factors(collected) == ["gov"]
    assert convergence.should_fire(collected, {}, NOW, "fp") == (False, "too_few")


def test_F1_la_meme_annonce_PLUS_une_depeche_independante_converge():
    """Le seuil n'est pas devenu inatteignable : un SECOND fait le franchit."""
    presse = _news(symbol="NVDA", sentiment="watch", link="http://x.test/w",
                   title="Nvidia dévoile sa nouvelle génération")
    collected = _collect6(news=[_named_gov(), presse], watched=["NVDA"],
                          held=["NVDA"])
    assert convergence.independent_factors(collected) == ["gov", "held_catalyst"]
    assert convergence.should_fire(collected, {}, NOW, "fp") == (True, "ok")


def test_F1_independent_factors_retient_un_facteur_qui_apporte_du_neuf():
    """Un facteur dont TOUS les ids sont déjà couverts n'ajoute rien ; il suffit
    d'UN item neuf pour qu'il compte."""
    payload = {"factors": {"gov": True, "held_catalyst": True},
               "factor_ids": {"gov": ["a"], "held_catalyst": ["a", "b"]}}
    assert convergence.independent_factors(payload) == ["gov", "held_catalyst"]
    payload["factor_ids"]["held_catalyst"] = ["a"]
    assert convergence.independent_factors(payload) == ["gov"]


def test_F1_sans_table_d_ids_on_compte_comme_avant():
    """Rétro-compatibilité : un appelant qui ne passe que des drapeaux ne peut
    pas prouver la redite — on ne l'invente pas à sa place."""
    flags = {"gov": True, "held_catalyst": True}
    assert convergence.independent_factors(flags) == ["gov", "held_catalyst"]
    assert convergence.should_fire(flags, {}, NOW, "fp") == (True, "ok")


def test_F1_un_facteur_sans_ids_connus_est_retenu():
    payload = {"factors": {"gov": True, "crowd_buzz": True},
               "factor_ids": {"gov": ["a"]}}
    assert convergence.independent_factors(payload) == ["gov", "crowd_buzz"]


def test_F1_une_MENACE_tire_toujours_seule_meme_redondante():
    """Le garde-fou d'indépendance borne le bruit d'opportunité, pas
    l'avertissement sur une position détenue."""
    collected = _collect6(news=[_news(sentiment="neg")], held=["NESN.SW"])
    assert convergence.independent_factors(collected) == ["held_risk"]
    assert convergence.should_fire(collected, {}, NOW, "fp") == (True, "ok")


def test_F1_maybe_fire_passe_bien_la_table_des_ids_a_should_fire(sources, alice):
    """Le garde-fou meurt en silence si ``maybe_fire`` ne passe que les drapeaux
    (piège #61 : le champ lu au mauvais niveau ne plante jamais)."""
    sources.events = [_news(symbol="NESN.SW", sentiment="gov",
                            title="L'État commande chez Nestlé",
                            link="http://x.test/one")]
    sent = []
    out = convergence.maybe_fire(now=NOW, llm=_llm("texte"),
                                 notifier=_notifier(sent), tg_cfg=TG,
                                 fetch_state=lambda: {})
    assert out["fired"] is False and out["reason"] == "too_few"
    assert sent == []


# =========================================================================== #
#  F2 — un compte X en PROBATION ne pèse dans aucun facteur (27/08)
# =========================================================================== #

def _candidate_news(**over):
    base = dict(symbol="NESN.SW", sentiment="neg", src="x",
                link="http://x.test/cand", title="Un inconnu tape sur Nestlé")
    base.update(over)
    event = _news(**base)
    event["candidate"] = True
    return event


def test_F2_un_event_de_candidat_n_allume_aucun_facteur():
    collected = _collect6(news=[_candidate_news()], held=["NESN.SW"],
                          watched=["NESN.SW"])
    assert collected["factors"] == {c: False for c in convergence.FACTOR_CODES}
    assert collected["items"] == []


def test_F2_un_event_de_candidat_ne_bouge_pas_l_empreinte():
    """Il ne doit pas non plus faire repartir un digest identique sur le fond."""
    vrai = _news(sentiment="neg", link="http://x.test/vrai")
    seul = _collect6(news=[vrai], held=["NESN.SW"])
    avec = _collect6(news=[vrai, _candidate_news()], held=["NESN.SW"])
    assert convergence.fingerprint(avec["items"]) == convergence.fingerprint(seul["items"])


def test_F2_un_compte_X_PROMU_lui_compte_normalement():
    """Le drapeau, pas la source : un compte de la liste manuelle pèse."""
    promu = _news(symbol="NESN.SW", sentiment="neg", src="x",
                  link="http://x.test/promu", title="Nestlé rappelle un lot")
    assert _collect6(news=[promu], held=["NESN.SW"])["factors"]["held_risk"] is True


# =========================================================================== #
#  F7 — la foule et les inconnus ne réveillent jamais SEULS (27/08)
# =========================================================================== #

@pytest.mark.parametrize("src", ["bsky", "reddit"])
def test_F7_une_source_ANONYME_n_allume_pas_le_facteur_de_menace(src):
    """Reproduction : la recherche Bluesky OUVERTE ramène n'importe qui ; un
    post négatif sur un titre détenu faisait partir le digest à lui seul."""
    anonyme = _news(symbol="NESN.SW", sentiment="neg", src=src,
                    link="http://x.test/%s" % src)
    collected = _collect6(news=[anonyme], held=["NESN.SW"], watched=["NESN.SW"])
    assert collected["factors"]["held_risk"] is False
    assert convergence.should_fire(collected, {}, NOW, "fp") == (False, "too_few")


def test_F7_un_candidat_est_refuse_meme_avec_une_source_autorisee():
    anonyme = _candidate_news(src="pressefi")
    assert _collect6(news=[anonyme], held=["NESN.SW"])["factors"]["held_risk"] is False


@pytest.mark.parametrize("src", ["", "gov", "bc", "pressefi", "sec_own",
                                 "eco", "climat", "crypto", "x"])
def test_F7_une_source_CUREE_garde_le_droit_de_tirer_seule(src):
    curee = _news(symbol="NESN.SW", sentiment="neg", src=src,
                  link="http://x.test/c%s" % (src or "none"))
    if not src:
        curee.pop("src", None)          # la dépêche par-symbole n'en écrit pas
    collected = _collect6(news=[curee], held=["NESN.SW"])
    assert collected["factors"]["held_risk"] is True
    assert convergence.should_fire(collected, {}, NOW, "fp") == (True, "ok")


def test_F7_une_source_anonyme_pese_quand_meme_comme_facteur_ORDINAIRE():
    """On lui retire le droit de tirer SEULE, pas le droit d'exister : elle
    nourrit toujours ``cross_source``."""
    anonyme = _news(symbol="NESN.SW", sentiment="neg", src="bsky",
                    link="http://x.test/b")
    collected = _collect6(hyps=[_hyp(), _hyp(id="h2")], news=[anonyme])
    assert collected["factors"]["cross_source"] is True
    assert collected["factors"]["held_risk"] is False


def test_F7_whale_sold_watched_ne_vient_JAMAIS_d_une_depeche():
    """Le second facteur de menace n'a pas besoin de ce garde-fou : sa matière
    vient de ``whales``, pas du guetteur de presse."""
    assert convergence.THREAT_FACTORS == ("held_risk", "whale_sold_watched")
    anonyme = _news(symbol="NESN.SW", sentiment="neg", src="reddit",
                    link="http://x.test/r2")
    assert _collect6(news=[anonyme], held=["NESN.SW"],
                     watched=["NESN.SW"])["factors"]["whale_sold_watched"] is False


# =========================================================================== #
#  F8 — « GOV » n'est pas un titre (27/08)
# =========================================================================== #

def test_F8_une_watchlist_contenant_GOV_n_allume_pas_held_catalyst():
    """Reproduction : le pseudo-symbole d'une annonce anonyme rencontrait
    « GOV » dans la watchlist, et TOUTE la politique du monde devenait un
    « catalyseur sur un titre suivi »."""
    anonyme = _news(symbol="GOV", sentiment="gov", link="http://x.test/anon",
                    title="Droits de douane à 50 % sur l'acier")
    collected = _collect6(news=[anonyme], watched=["GOV"], held=["GOV"])
    assert collected["factors"]["gov"] is True
    assert collected["factors"]["held_catalyst"] is False
    assert collected["factors"]["held_risk"] is False


def test_F8_le_pseudo_symbole_est_ecarte_de_TOUS_les_ensembles():
    """Un filtre à l'entrée plutôt que six filtres par facteur : « GOV » n'est
    ni détenu, ni vendu par un gérant, ni un sujet de foule."""
    trends = {"GOV": {"count": 40, "prev": 0}}
    collected = convergence.collect_factors(
        NOW, [], [], [], ["GOV"], held_symbols=["GOV"],
        whale_moves=[{"action": "sortie", "symbol": "GOV",
                      "manager_label": "Berkshire", "name": "Gov Inc",
                      "fetched_at": NOW.isoformat()}],
        reddit_trends=trends)
    assert collected["factors"]["crowd_buzz"] is False
    assert collected["factors"]["whale_sold_watched"] is False


def test_F8_le_miroir_des_pseudo_symboles_reste_synchronise_avec_graph():
    """La constante est RECOPIÉE (une fonction pure ne dépend pas d'un module
    d'I/O) — donc la synchronisation doit être épinglée, sinon les deux
    divergeront au premier ajustement."""
    from backend.bots.paper import graph
    assert convergence.PSEUDO_SYMBOLS == graph._PSEUDO_SYMBOLS


def test_F8_un_vrai_titre_reste_evidemment_compte():
    """Ceinture : on n'a pas coupé les symboles ordinaires en filtrant GOV."""
    named = _news(symbol="NVDA", sentiment="gov", link="http://x.test/nv",
                  title="Nvidia nommée")
    assert _collect6(news=[named], watched=["NVDA"])["factors"]["held_catalyst"] is True
