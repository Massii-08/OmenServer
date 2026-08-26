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
            self.asked = []

    bag = _Bag()

    def _recent_events(username):
        bag.asked.append(username)
        return list(bag.events)

    def _match_issuer(name, candidates):
        """Rapprochement volontairement NAÏF dans le stub (le vrai est testé
        chez lui) : premier candidat dont le symbole apparaît dans le nom."""
        for symbol in (candidates or {}):
            if symbol.split(".")[0].upper() in str(name or "").upper():
                return symbol
        return None

    news_stub = types.ModuleType("backend.bots.paper.newswatch")
    news_stub.recent_events = _recent_events
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


def test_le_prompt_numerote_ses_blocs_dans_l_ordre():
    prompt = _prompt(held_risk=True, whale_sold_watched=True)
    for n, titre in ((1, "CE QUI S'ALIGNE"), (2, "OPPORTUNITÉS"),
                     (3, "RISQUES SUR TES POSITIONS"), (4, "UN GRAND GÉRANT")):
        assert prompt.index("%d. " % n) < prompt.index(titre)
    assert "5. Une dernière ligne" in prompt


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
