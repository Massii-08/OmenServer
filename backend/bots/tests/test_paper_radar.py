"""Tests du radar d'hypothèses de second ordre — 100 % hors-ligne.

Tout ce qui sort de la machine est injecté : LLM, bougies Yahoo, notifieur
Telegram, horloge, et le fetch des réseaux sociaux. Les modules voisins
(``newswatch``, ``whales``) sont remplacés par des stubs posés À LA FOIS dans
``sys.modules`` ET en attribut du paquet — l'import paresseux
``from backend.bots.paper import newswatch`` passe par le second dès que le
vrai module a été importé une fois dans la session (piège classique du stub
qui « ne prend pas »).

Isolation disque : ``store.DATA_DIR`` est monkeypatché vers ``tmp_path``, ce
qui isole du même coup l'état du radar (``state_path()`` le relit à chaque
appel) et le carnet Markdown.

Depuis la spec §13, le radar est MUET : le silence est verrouillé par des
tests (un notifieur espion passé à ``run_once`` ne doit recevoir AUCUN appel,
ni pour une hypothèse ni pour un verdict), et la couche de convergence est
neutralisée par défaut pour qu'un test du radar ne mesure qu'un comportement.
"""
import calendar
import json
import os
import stat
import sys
import types
from datetime import datetime, timedelta

import pytest

from backend.bots.paper import alerts, convergence, radar, store

# La VRAIE collecte sociale, capturée avant que la fixture autouse ne la
# neutralise : les 4 tests sociaux la réinstallent explicitement.
_REAL_COLLECT_SOCIAL = radar._collect_social


# --------------------------------------------------------------------------- #
# Fixtures
# --------------------------------------------------------------------------- #

@pytest.fixture(autouse=True)
def _isolate_data_dir(tmp_path, monkeypatch):
    """Aucun test n'écrit dans le vrai data/paper_trading/."""
    monkeypatch.setattr(store, "DATA_DIR", tmp_path)
    return tmp_path


@pytest.fixture(autouse=True)
def _no_social(monkeypatch):
    """Par défaut : aucune requête sociale (les 2 tests dédiés la réactivent)."""
    monkeypatch.setattr(radar, "_collect_social", lambda *a, **k: ([], 0))


@pytest.fixture(autouse=True)
def _no_convergence(monkeypatch):
    """Par défaut : la convergence est neutralisée.

    ``run_once`` la consulte désormais à chaque passage ; sans ce garde-fou, la
    plupart des tests du radar mesureraient DEUX comportements à la fois. Les
    tests dédiés (section « convergence ») réinstallent un espion."""
    monkeypatch.setattr(convergence, "maybe_fire",
                        lambda **kwargs: {"fired": False, "reason": "too_few",
                                          "factors": {}, "sent": False,
                                          "llm": False})


@pytest.fixture(autouse=True)
def _no_telegram_channel(monkeypatch):
    """Aucun test ne doit pouvoir lire la vraie config Telegram du dépôt (ni,
    a fortiori, envoyer un message) : le canal est éteint par défaut."""
    monkeypatch.setattr(alerts, "load_cfg", lambda path=None: None)


@pytest.fixture
def sources(monkeypatch):
    """Stubs de newswatch/whales, pilotables depuis le test."""
    class _Bag:
        def __init__(self):
            self.events = []
            self.filings = []

    bag = _Bag()

    news_stub = types.ModuleType("backend.bots.paper.newswatch")
    news_stub.recent_events = lambda username: list(bag.events)
    whales_stub = types.ModuleType("backend.bots.paper.whales")
    whales_stub.recent_filing_events = lambda: list(bag.filings)

    import backend.bots.paper as paper_pkg
    monkeypatch.setitem(sys.modules, "backend.bots.paper.newswatch", news_stub)
    monkeypatch.setitem(sys.modules, "backend.bots.paper.whales", whales_stub)
    monkeypatch.setattr(paper_pkg, "newswatch", news_stub, raising=False)
    monkeypatch.setattr(paper_pkg, "whales", whales_stub, raising=False)
    return bag


@pytest.fixture
def alice(tmp_path):
    """Un utilisateur avec un portefeuille (donc destinataire des notes)."""
    (tmp_path / "alice.json").write_text('{"cash_chf": 10000}', encoding="utf-8")
    return "alice"


NOW = datetime(2026, 8, 24, 9, 0, 0)
TG = {"token": "t", "chat_id": "1"}


def _epoch(dt):
    """Epoch UTC d'un datetime naïf (les bougies Yahoo sont en epoch)."""
    return calendar.timegm(dt.utctimetuple())


def _candles(start, closes, step_days=1):
    """Bougies quotidiennes ``{ts, close}`` à partir de ``start``."""
    return [{"ts": _epoch(start + timedelta(days=i * step_days)),
             "open": c, "high": c, "low": c, "close": c}
            for i, c in enumerate(closes)]


def _hyp(**over):
    """Une hypothèse ouverte plausible."""
    base = {
        "id": "abc123",
        "created_at": (NOW - timedelta(days=10)).isoformat(),
        "thesis": "Le fret maritime cher renchérit le café en Europe",
        "chain": ["fret +40 %", "coût du café importé", "marges torréfacteurs"],
        "markets": ["agroalimentaire européen"],
        "tickers": ["NESN.SW"],
        "direction": "up",
        "horizon_days": 5,
        "confidence": "moyenne",
        "invalidation": "le fret retombe sous 2000 USD",
        "status": "open",
        "outcome": None,
        "scored_at": None,
        "move_pct": None,
    }
    base.update(over)
    return base


def _llm(payload, calls=None):
    """Faux LLM : rend le JSON demandé et enregistre le prompt reçu."""
    def _call(prompt):
        if calls is not None:
            calls.append(prompt)
        return payload
    return _call


def _notifier(sent):
    def _send(text, cfg):
        sent.append(text)
        return True
    return _send


TWO_HYPS = json.dumps({"hypotheses": [
    {"thesis": "T1", "chain": ["a", "b"], "markets": ["m1"],
     "tickers": ["AAA"], "direction": "up", "horizon_days": 10,
     "confidence": "moyenne", "invalidation": "i1"},
    {"thesis": "T2", "chain": ["c", "d"], "markets": ["m2"],
     "tickers": ["BBB"], "direction": "down", "horizon_days": 7,
     "confidence": "basse", "invalidation": "i2"},
]})

EVENT = {"ts": (NOW - timedelta(hours=3)).isoformat(), "symbol": "NESN.SW",
         "title": "Le fret maritime bondit de 40 %", "link": "http://x.test/1",
         "sentiment": "negative"}


# --------------------------------------------------------------------------- #
# parse_llm
# --------------------------------------------------------------------------- #

def test_parse_llm_extrait_le_json_noye_dans_du_bavardage():
    raw = "Voici mon analyse.\n" + TWO_HYPS + "\nVoilà, j'espère que ça aide."
    out = radar.parse_llm(raw)
    assert [h["thesis"] for h in out] == ["T1", "T2"]
    assert out[0]["tickers"] == ["AAA"]
    assert out[1]["direction"] == "down"
    assert out[1]["confidence"] == "basse"


def test_parse_llm_jette_item_invalide_sans_jeter_le_lot():
    raw = json.dumps({"hypotheses": [
        {"thesis": "", "chain": ["a"], "tickers": ["AAA"]},          # sans thèse
        {"thesis": "bonne", "chain": ["a"], "tickers": ["AAA"]},     # valide
        {"thesis": "sans ticker", "chain": ["a"], "tickers": []},    # sans ticker
        {"thesis": "sans chaîne", "chain": [], "tickers": ["BBB"]},  # sans chaîne
        "pas un objet",
    ]})
    out = radar.parse_llm(raw)
    assert [h["thesis"] for h in out] == ["bonne"]


@pytest.mark.parametrize("given,expected", [
    (90, 30), (1, 3), (10, 10), ("12", 12), (None, radar.DEFAULT_HORIZON_D),
    ("n'importe quoi", radar.DEFAULT_HORIZON_D),
])
def test_parse_llm_clampe_horizon(given, expected):
    raw = json.dumps({"hypotheses": [
        {"thesis": "t", "chain": ["a"], "tickers": ["AAA"], "horizon_days": given}]})
    assert radar.parse_llm(raw)[0]["horizon_days"] == expected


@pytest.mark.parametrize("given,expected", [
    ("haute", "moyenne"), ("élevée", "moyenne"), ("certaine", "moyenne"),
    ("moyenne", "moyenne"), ("basse", "basse"), ("low", "basse"), (None, "moyenne"),
])
def test_parse_llm_plafonne_la_confiance(given, expected):
    """Le radar spécule : il n'a JAMAIS le droit de se dire sûr."""
    raw = json.dumps({"hypotheses": [
        {"thesis": "t", "chain": ["a"], "tickers": ["AAA"], "confidence": given}]})
    assert radar.parse_llm(raw)[0]["confidence"] == expected


@pytest.mark.parametrize("given,expected", [
    ("up", "up"), ("down", "down"), ("baisse", "down"), ("de côté", "up"), (None, "up"),
])
def test_parse_llm_clampe_la_direction(given, expected):
    raw = json.dumps({"hypotheses": [
        {"thesis": "t", "chain": ["a"], "tickers": ["AAA"], "direction": given}]})
    assert radar.parse_llm(raw)[0]["direction"] == expected


@pytest.mark.parametrize("raw", ["", None, "pas de json du tout", "{cassé,,}", "[]", "{}"])
def test_parse_llm_entrees_illisibles(raw):
    assert radar.parse_llm(raw) == []


def test_parse_llm_cap_a_trois():
    raw = json.dumps({"hypotheses": [
        {"thesis": "t%d" % i, "chain": ["a"], "tickers": ["A%d" % i]} for i in range(9)]})
    assert len(radar.parse_llm(raw)) == radar.MAX_PER_RUN


def test_parse_llm_ignore_les_champs_de_gestion():
    """id/status/outcome appartiennent à l'état, pas au LLM."""
    raw = json.dumps({"hypotheses": [
        {"thesis": "t", "chain": ["a"], "tickers": ["AAA"],
         "id": "piraté", "status": "scored", "outcome": "hit"}]})
    out = radar.parse_llm(raw)[0]
    assert "id" not in out and "status" not in out and "outcome" not in out


def test_parse_llm_dedoublonne_et_majuscule_les_tickers():
    raw = json.dumps({"hypotheses": [
        {"thesis": "t", "chain": ["a"], "tickers": ["aaa", "AAA", "bbb"]}]})
    assert radar.parse_llm(raw)[0]["tickers"] == ["AAA", "BBB"]


def test_parse_llm_invalidation_vide_est_explicite():
    raw = json.dumps({"hypotheses": [{"thesis": "t", "chain": ["a"], "tickers": ["A"]}]})
    assert radar.parse_llm(raw)[0]["invalidation"] == "(non précisée)"


def test_parse_llm_accepte_une_chaine_causale_en_texte():
    raw = json.dumps({"hypotheses": [
        {"thesis": "t", "chain": "un seul maillon", "tickers": ["A"]}]})
    assert radar.parse_llm(raw)[0]["chain"] == ["un seul maillon"]


# --------------------------------------------------------------------------- #
# score_hypothesis
# --------------------------------------------------------------------------- #

def test_score_pas_encore_echu_rend_none():
    """Avant l'échéance il n'y a rien à dire — surtout pas un verdict."""
    hyp = _hyp(created_at=(NOW - timedelta(days=2)).isoformat(), horizon_days=10)
    candles = {"NESN.SW": _candles(NOW - timedelta(days=2), [100.0, 130.0])}
    assert radar.score_hypothesis(hyp, candles, NOW) is None


def test_score_up_hit():
    start = NOW - timedelta(days=10)
    hyp = _hyp()
    out = radar.score_hypothesis(hyp, {"NESN.SW": _candles(start, [100.0, 102.0, 105.0])}, NOW)
    assert out["outcome"] == "hit"
    assert out["move_pct"] == pytest.approx(5.0)
    assert out["scored_at"]


def test_score_up_miss():
    start = NOW - timedelta(days=10)
    out = radar.score_hypothesis(_hyp(), {"NESN.SW": _candles(start, [100.0, 95.0])}, NOW)
    assert out["outcome"] == "miss"
    assert out["move_pct"] == pytest.approx(-5.0)


@pytest.mark.parametrize("closes", [[100.0, 101.0], [100.0, 99.0], [100.0, 100.0]])
def test_score_up_unclear_sous_le_seuil(closes):
    """Sous 3 %, on ne distingue pas la thèse du bruit : indécis, pas réussi."""
    out = radar.score_hypothesis(_hyp(), {"NESN.SW": _candles(NOW - timedelta(days=10), closes)}, NOW)
    assert out["outcome"] == "unclear"


def test_score_down_est_symetrique():
    start = NOW - timedelta(days=10)
    down = _hyp(direction="down")
    hit = radar.score_hypothesis(down, {"NESN.SW": _candles(start, [100.0, 90.0])}, NOW)
    miss = radar.score_hypothesis(down, {"NESN.SW": _candles(start, [100.0, 110.0])}, NOW)
    unclear = radar.score_hypothesis(down, {"NESN.SW": _candles(start, [100.0, 101.0])}, NOW)
    assert (hit["outcome"], miss["outcome"], unclear["outcome"]) == ("hit", "miss", "unclear")
    assert hit["move_pct"] == pytest.approx(-10.0)


def test_score_prend_la_mediane_des_tickers():
    """Un ticker aberrant ne doit pas décider seul du verdict."""
    start = NOW - timedelta(days=10)
    hyp = _hyp(tickers=["A", "B", "C"])
    out = radar.score_hypothesis(hyp, {
        "A": _candles(start, [100.0, 104.0]),    # +4 %
        "B": _candles(start, [100.0, 108.0]),    # +8 %
        "C": _candles(start, [100.0, 60.0]),     # -40 %, aberrant
    }, NOW)
    assert out["move_pct"] == pytest.approx(4.0)     # médiane de (-40, 4, 8)
    assert out["outcome"] == "hit"
    assert set(out["moves"]) == {"A", "B", "C"}


def test_score_mediane_paire():
    start = NOW - timedelta(days=10)
    out = radar.score_hypothesis(_hyp(tickers=["A", "B"]), {
        "A": _candles(start, [100.0, 102.0]),
        "B": _candles(start, [100.0, 108.0]),
    }, NOW)
    assert out["move_pct"] == pytest.approx(5.0)


def test_score_aucune_bougie_rend_unclear():
    """Pas de mesure -> pas de verdict inventé."""
    out = radar.score_hypothesis(_hyp(), {}, NOW)
    assert out["outcome"] == "unclear"
    assert out["move_pct"] is None
    out2 = radar.score_hypothesis(_hyp(), {"NESN.SW": []}, NOW)
    assert out2["outcome"] == "unclear"


def test_score_part_de_la_premiere_cloture_apres_la_naissance():
    """Les bougies antérieures à l'hypothèse ne comptent pas : on ne s'attribue
    pas un mouvement qui a eu lieu AVANT d'avoir parlé."""
    created = NOW - timedelta(days=10)
    candles = _candles(created - timedelta(days=5), [50.0, 60.0, 70.0])   # avant
    candles += _candles(created, [100.0, 106.0])                          # après
    out = radar.score_hypothesis(_hyp(), {"NESN.SW": candles}, NOW)
    assert out["move_pct"] == pytest.approx(6.0)


def test_score_ignore_les_clotures_nulles():
    created = NOW - timedelta(days=10)
    candles = _candles(created, [100.0, 0.0, 110.0])
    candles[1]["close"] = None
    out = radar.score_hypothesis(_hyp(), {"NESN.SW": candles}, NOW)
    assert out["move_pct"] == pytest.approx(10.0)


def test_is_mature_sans_date_de_naissance():
    """Une hypothèse dont la date est illisible doit être close, pas éternelle."""
    assert radar.is_mature({"created_at": "n'importe quoi"}, NOW) is True


# ================================================================
#  ÉCHÉANCE DES IDÉES DU COACH — le semi-long forex tient jusqu'au bout
#
#  Le niveau spéculatif propose du forex sur 2-3 MOIS. Scoré au 30ᵉ jour comme
#  une hypothèse de radar, un tel pari mesurerait le bruit de son premier tiers
#  et le bilan par niveau accuserait le spéculatif d'un échec fabriqué ici.
# ================================================================

def _coach_idea(days, horizon):
    """Une idée du coach née il y a ``days`` jours, d'horizon ``horizon``."""
    return _hyp(source="coach", risk_level="speculatif", asset_kind="forex",
                created_at=(NOW - timedelta(days=days)).isoformat(),
                horizon_days=horizon, tickers=["EURUSD=X"])


def test_une_idee_coach_de_75_jours_n_est_pas_mature_au_40e():
    assert radar.is_mature(_coach_idea(40, 75), NOW) is False


def test_une_idee_coach_de_75_jours_est_mature_au_76e():
    assert radar.is_mature(_coach_idea(76, 75), NOW) is True


def test_une_hypothese_du_radar_reste_plafonnee_a_30_jours():
    """Comportement EXISTANT verrouillé : la doctrine du radar (« au-delà d'un
    mois on ne sait plus relier au déclencheur ») ne bouge pas d'un jour."""
    radar_hyp = _hyp(created_at=(NOW - timedelta(days=31)).isoformat(),
                     horizon_days=75)
    assert radar.is_mature(radar_hyp, NOW) is True


def test_un_etat_ancien_sans_source_garde_le_plafond_de_30():
    """Aucune migration : ce qui a été écrit avant se comporte comme avant."""
    ancienne = _hyp(created_at=(NOW - timedelta(days=31)).isoformat(),
                    horizon_days=90)
    assert "source" not in ancienne
    assert radar.max_horizon_for(ancienne) == radar.MAX_HORIZON_D
    assert radar.is_mature(ancienne, NOW) is True


@pytest.mark.parametrize("source,expected", [
    ("coach", 120), ("COACH", 120), (None, 30), ("", 30), ("radar", 30),
])
def test_le_plafond_depend_de_la_source(source, expected):
    hyp = {"horizon_days": 75}
    if source is not None:
        hyp["source"] = source
    assert radar.max_horizon_for(hyp) == expected
    assert radar.hypothesis_horizon(hyp) == min(75, expected)


@pytest.mark.parametrize("given,expected", [
    (75, 75), (400, 120), (1, 3), (None, radar.DEFAULT_HORIZON_D),
])
def test_l_horizon_d_une_idee_coach_reste_borne(given, expected):
    """Ouvrir le plafond n'est pas l'enlever : 400 jours reste un pari qu'on ne
    saurait plus juger, et une valeur illisible retombe sur le défaut."""
    assert radar.hypothesis_horizon({"source": "coach",
                                     "horizon_days": given}) == expected


def test_parse_llm_clampe_toujours_les_hypotheses_du_radar_a_30():
    """Le plafond ouvert vaut pour les idées du COACH, pas pour ce que le radar
    s'autorise à générer lui-même."""
    raw = json.dumps({"hypotheses": [
        {"thesis": "t", "chain": ["a"], "tickers": ["AAA"], "horizon_days": 75}]})
    assert radar.parse_llm(raw)[0]["horizon_days"] == radar.MAX_HORIZON_D


def test_le_carnet_annonce_l_horizon_REELLEMENT_score():
    """Une seule définition de l'horizon : le carnet ne peut pas écrire « 30
    jours » pour un pari qui sera noté au 75ᵉ (mensonge invisible trois mois)."""
    idea = _coach_idea(0, 75)
    assert "- Horizon : 75 jours" in radar.format_hypothesis_note(idea)
    assert "Horizon ~75 j." in radar.format_alert(idea)
    assert "horizon 75 jours" in radar.format_outcome_note(idea)


# --------------------------------------------------------------------------- #
# build_prompt
# --------------------------------------------------------------------------- #

def test_build_prompt_porte_les_interdits_cles():
    prompt = radar.build_prompt(
        [EVENT], [], [_hyp(thesis="hypothèse déjà ouverte sur le café")], [],
        {"hits": 3, "misses": 5, "unclear": 2}, NOW.isoformat())
    assert "0 hypothèse" in prompt                       # le droit de ne rien rendre
    assert "certitude" in prompt                         # jamais présenté comme sûr
    assert "hypothèse déjà ouverte sur le café" in prompt  # anti-doublon
    assert "3 réussies / 5 ratées / 2 indécises" in prompt  # bilan cumulé
    assert "INTERDIT d'inventer" in prompt
    assert "argent réel" in prompt
    assert "Le fret maritime bondit de 40 %" in prompt


def test_build_prompt_expose_les_hypotheses_notees_pour_apprendre():
    scored = _hyp(status="scored", outcome="miss", move_pct=-1.2,
                  thesis="chaîne qui a raté")
    prompt = radar.build_prompt([], [], [], [scored], {}, NOW.isoformat())
    assert "chaîne qui a raté" in prompt
    assert "miss" in prompt
    assert "APPRENDS" in prompt


def test_build_prompt_section_sociale_dediee():
    prompt = radar.build_prompt(
        [], [], [], [], {}, NOW.isoformat(),
        [{"source": "Reddit r/stocks", "text": "tout le monde parle du fret"}])
    assert "TENDANCES SOCIALES (bruit élevé, non vérifié — à recouper " \
           "avant d'en tirer une hypothèse)" in prompt
    assert "tout le monde parle du fret" in prompt


def test_build_prompt_sans_rien_reste_lisible():
    prompt = radar.build_prompt([], [], [], [], None, "")
    assert "(aucun)" in prompt and "(aucune)" in prompt
    assert "0 réussies / 0 ratées / 0 indécises" in prompt


# --------------------------------------------------------------------------- #
# Mise en forme
# --------------------------------------------------------------------------- #

def test_format_alert_dit_que_c_est_un_pari_et_donne_le_bilan():
    msg = radar.format_alert(_hyp(), {"hits": 2, "misses": 4, "unclear": 1})
    assert "PARI, PAS UNE CERTITUDE" in msg
    assert "(confiance moyenne)" in msg
    assert "Bilan du radar : 2 réussies / 4 ratées / 1 indécises." in msg
    assert "fret +40 % → coût du café importé → marges torréfacteurs" in msg
    assert "NESN.SW" in msg
    assert "Horizon ~5 j" in msg
    assert "le fret retombe sous 2000 USD" in msg
    assert "≤ 1 %" in msg


def test_format_alert_plafonne_la_confiance_meme_si_l_etat_est_pollue():
    msg = radar.format_alert(_hyp(confidence="haute"), {})
    assert "(confiance moyenne)" in msg
    assert "haute" not in msg


def test_format_verdict_est_court_et_factuel():
    hyp = _hyp(status="scored", outcome="hit", move_pct=4.23)
    msg = radar.format_verdict(hyp, {"hits": 1, "misses": 0, "unclear": 0})
    assert msg.startswith("[Simulateur] Verdict radar :")
    assert "réussie" in msg and "+4.2 %" in msg
    assert "Bilan : 1 réussies / 0 ratées / 0 indécises." in msg


def test_format_verdict_avoue_quand_la_mesure_manque():
    msg = radar.format_verdict(_hyp(outcome="unclear", move_pct=None), {})
    assert "indécise" in msg and "mouvement non mesurable" in msg


def test_format_hypothesis_note_est_un_bloc_markdown_date():
    note = radar.format_hypothesis_note(_hyp())
    assert note.startswith("## 2026-08-14 — hypothèse ouverte (confiance moyenne)")
    assert "Pari assumé, pas une certitude" in note
    assert "[[Journal]]" in note
    assert note.endswith("\n")


def test_format_outcome_note_sans_triomphalisme():
    note = radar.format_outcome_note(
        _hyp(status="scored", outcome="hit", move_pct=7.0,
             scored_at=NOW.isoformat()))
    assert note.startswith("## 2026-08-24 — verdict : réussie (+7.0 %)")
    assert "Ouverte le 2026-08-14, horizon 5 jours." in note
    # Ni fanfare ni excuse : que des faits.
    for mot in ("bravo", "malheureusement", "hélas", "excellent"):
        assert mot not in note.lower()


# --------------------------------------------------------------------------- #
# État persistant
# --------------------------------------------------------------------------- #

def test_save_state_est_atomique_et_600():
    radar.save_state({"hypotheses": [_hyp()], "stats": {"hits": 1, "misses": 0, "unclear": 0}})
    path = radar.state_path()
    assert path.name == "radar.json"
    assert stat.S_IMODE(os.stat(str(path)).st_mode) == 0o600
    assert radar.load_state()["stats"]["hits"] == 1
    # aucun temporaire laissé derrière
    assert not list(path.parent.glob(".radar.json.tmp*"))


def test_load_state_absent_ou_corrompu_rend_un_etat_vierge():
    assert radar.load_state() == radar.blank_state()
    radar.state_path().parent.mkdir(parents=True, exist_ok=True)
    radar.state_path().write_text("{pas du json", encoding="utf-8")
    assert radar.load_state() == radar.blank_state()


def test_load_state_tolere_une_forme_deformee():
    radar.state_path().parent.mkdir(parents=True, exist_ok=True)
    radar.state_path().write_text(
        json.dumps({"hypotheses": "pas une liste", "stats": {"hits": "x"}}),
        encoding="utf-8")
    state = radar.load_state()
    assert state["hypotheses"] == [] and state["stats"]["hits"] == 0


def test_users_with_portfolio_ecarte_les_fichiers_de_module(tmp_path):
    """Les états des MODULES vivent dans le même répertoire que les comptes :
    en oublier un fabrique un utilisateur fantôme, qui recevrait des notes de
    carnet dans son propre vault."""
    for name in ("alice.json", "bob.json", "alice.coach.json",
                 "alice.news_seen.json", "radar.json", "whales_cache.json",
                 "whales_watch.json", "newswatch_global.json",
                 "convergence.json"):
        (tmp_path / name).write_text("{}", encoding="utf-8")
    assert radar._users_with_portfolio() == ["alice", "bob"]


# --------------------------------------------------------------------------- #
# run_once — (a) génération
# --------------------------------------------------------------------------- #

def test_run_once_genere_ecrit_les_notes_et_se_tait(sources, alice, tmp_path):
    """Spec §13 : les hypothèses s'accumulent en SILENCE (état + carnet)."""
    sources.events = [EVENT]
    sent = []
    out = radar.run_once(now=NOW, llm=_llm(TWO_HYPS), notifier=_notifier(sent),
                         tg_cfg=TG, fetch_candles=lambda *a: [])

    assert out == {"generated": 2, "notified": 0, "scored": 0, "errors": 0,
                   "fired": False}
    assert sent == []            # <- le verrou : plus AUCUN envoi par hypothèse

    state = radar.load_state()
    assert [h["thesis"] for h in state["hypotheses"]] == ["T1", "T2"]
    for hyp in state["hypotheses"]:
        assert hyp["status"] == "open"
        assert hyp["outcome"] is None and hyp["scored_at"] is None
        assert hyp["created_at"] == NOW.isoformat()
        assert len(hyp["id"]) == 8
    assert len({h["id"] for h in state["hypotheses"]}) == 2

    note = (tmp_path / "alice-vault" / "Radar.md").read_text(encoding="utf-8")
    assert "T1" in note and "T2" in note
    assert note.count("## 2026-08-24 — hypothèse ouverte") == 2


def test_run_once_ecrit_la_note_chez_chaque_utilisateur(sources, tmp_path):
    sources.events = [EVENT]
    for user in ("alice", "bob"):
        (tmp_path / ("%s.json" % user)).write_text("{}", encoding="utf-8")
    radar.run_once(now=NOW, llm=_llm(TWO_HYPS), tg_cfg={}, fetch_candles=lambda *a: [])
    for user in ("alice", "bob"):
        assert (tmp_path / ("%s-vault" % user) / "Radar.md").is_file()


def test_run_once_declenche_aussi_sur_un_13f_seul(sources, alice):
    """La presse n'est pas la seule matière : un dépôt 13F suffit."""
    sources.filings = [{"ts": (NOW - timedelta(days=1)).isoformat(),
                        "manager_id": "brk", "label": "Berkshire", "form": "13F-HR",
                        "filing_date": "2026-08-23"}]
    calls = []
    out = radar.run_once(now=NOW, llm=_llm(TWO_HYPS, calls), tg_cfg={},
                         fetch_candles=lambda *a: [])
    assert out["generated"] == 2
    assert "Berkshire" in calls[0]


def test_run_once_ecarte_les_evenements_trop_vieux(sources, alice):
    sources.events = [dict(EVENT, ts=(NOW - timedelta(hours=72)).isoformat())]
    calls = []
    out = radar.run_once(now=NOW, llm=_llm(TWO_HYPS, calls), tg_cfg={},
                         fetch_candles=lambda *a: [])
    assert calls == [] and out["generated"] == 0


def test_run_once_dedoublonne_les_evenements_entre_utilisateurs(sources, tmp_path):
    """Deux comptes qui suivent le même titre ne doivent pas doubler l'entrée."""
    for user in ("alice", "bob"):
        (tmp_path / ("%s.json" % user)).write_text("{}", encoding="utf-8")
    sources.events = [EVENT]
    calls = []
    radar.run_once(now=NOW, llm=_llm(TWO_HYPS, calls), tg_cfg={},
                   fetch_candles=lambda *a: [])
    assert calls[0].count("Le fret maritime bondit de 40 %") == 1


# --------------------------------------------------------------------------- #
# run_once — (b) pas de doublon / file pleine
# --------------------------------------------------------------------------- #

def test_run_once_relance_expose_les_ouvertes_au_llm(sources, alice):
    """Le mécanisme anti-doublon : les hypothèses ouvertes sont DANS le prompt."""
    sources.events = [EVENT]
    calls = []
    radar.run_once(now=NOW, llm=_llm(TWO_HYPS, calls), tg_cfg={}, fetch_candles=lambda *a: [])
    radar.run_once(now=NOW, llm=_llm('{"hypotheses": []}', calls), tg_cfg={},
                   fetch_candles=lambda *a: [])

    premier, second = calls
    assert "HYPOTHÈSES DÉJÀ OUVERTES (à NE PAS reproposer) :\n- (aucune)" in premier
    assert "T1" in second and "T2" in second
    assert "NE PAS reproposer" in second
    # 0 hypothèse rendue = réponse légitime, l'état ne bouge pas
    assert len(radar.load_state()["hypotheses"]) == 2


def test_run_once_file_pleine_score_mais_ne_genere_pas(sources, alice):
    sources.events = [EVENT]
    radar.save_state({
        "hypotheses": [_hyp(id="h%d" % i, thesis="t%d" % i,
                            created_at=NOW.isoformat(), horizon_days=30)
                       for i in range(radar.MAX_OPEN)],
        "stats": {"hits": 0, "misses": 0, "unclear": 0},
    })
    calls = []
    out = radar.run_once(now=NOW, llm=_llm(TWO_HYPS, calls), tg_cfg={},
                         fetch_candles=lambda *a: [])
    assert calls == []                      # aucun jeton dépensé
    assert out["generated"] == 0
    assert len(radar.load_state()["hypotheses"]) == radar.MAX_OPEN


def test_run_once_file_pleine_libere_une_place_en_scorant(sources, alice):
    """Scorer d'abord : une hypothèse échue rend sa place à la génération."""
    sources.events = [EVENT]
    hyps = [_hyp(id="h%d" % i, thesis="t%d" % i, created_at=NOW.isoformat(),
                 horizon_days=30) for i in range(radar.MAX_OPEN - 1)]
    hyps.append(_hyp(id="vieille", thesis="échue",
                     created_at=(NOW - timedelta(days=20)).isoformat(),
                     horizon_days=5, tickers=["AAA"]))
    radar.save_state({"hypotheses": hyps,
                      "stats": {"hits": 0, "misses": 0, "unclear": 0}})

    calls = []
    out = radar.run_once(
        now=NOW, llm=_llm(TWO_HYPS, calls), tg_cfg={},
        fetch_candles=lambda *a: _candles(NOW - timedelta(days=20), [100.0, 110.0]))
    assert out["scored"] == 1
    assert out["generated"] == 2
    assert calls                            # le LLM a bien été appelé


# --------------------------------------------------------------------------- #
# Rotation de file — le garde-fou anti-mutisme (26/08)
#
# Mesuré sur le compte réel : 6 ouvertes = MAX_OPEN, plus une seule génération
# depuis la veille. La file partagée avec le coach se remplit en une soirée, et
# rien ne mûrit avant deux semaines : le radar se taisait.
# --------------------------------------------------------------------------- #

def test_la_file_ouverte_tient_douze_paris():
    """Le plafond est ÉPINGLÉ : il est passé de 6 à 12 parce que les idées du
    coach partagent la même file depuis la v6."""
    assert radar.MAX_OPEN == 12


def _full_queue(days_ago=3, **over):
    """Une file PLEINE d'hypothèses du radar, toutes plus vieilles que 48 h et
    aucune arrivée à échéance (horizon 30 jours)."""
    return [_hyp(id="h%02d" % i, thesis="t%d" % i, horizon_days=30,
                 created_at=(NOW - timedelta(days=days_ago + i)).isoformat(),
                 **over)
            for i in range(radar.MAX_OPEN)]


def test_pick_rotation_choisit_la_doyenne_quand_tout_est_vieux():
    rows = _full_queue()
    assert radar.pick_rotation(rows, NOW)["id"] == "h%02d" % (radar.MAX_OPEN - 1)


def test_pick_rotation_ne_fait_rien_si_la_file_n_est_pas_pleine():
    assert radar.pick_rotation(_full_queue()[:-1], NOW) is None


def test_pick_rotation_ne_fait_rien_si_une_ouverte_a_moins_de_48h():
    """Une seule hypothèse fraîche suffit : la file TOURNE encore, il n'y a pas
    d'embouteillage à casser."""
    rows = _full_queue()
    rows[0]["created_at"] = (NOW - timedelta(hours=47)).isoformat()
    assert radar.pick_rotation(rows, NOW) is None


def test_pick_rotation_epargne_toujours_les_idees_du_coach():
    """Elles portent le bilan par niveau de risque : les roter fabriquerait des
    « indécises » dans un bilan qu'on lit pour juger ces niveaux-là."""
    rows = _full_queue()
    rows[-1]["source"] = "coach"             # la doyenne est une idée du coach
    rows[-2]["source"] = "COACH  "           # écrit salement : compte pareil
    assert radar.pick_rotation(rows, NOW)["id"] == "h%02d" % (radar.MAX_OPEN - 3)


def test_pick_rotation_prefere_le_silence_a_une_file_100_pourcent_coach():
    assert radar.pick_rotation(_full_queue(source="coach"), NOW) is None


def test_pick_rotation_est_deterministe_sur_les_ex_aequo():
    rows = _full_queue(days_ago=0)           # toutes la même date... non
    for row in rows:
        row["created_at"] = (NOW - timedelta(days=9)).isoformat()
    assert radar.pick_rotation(rows, NOW)["id"] == "h00"   # l'id tranche


def test_pick_rotation_ne_meurt_pas_sur_une_entree_deformee():
    rows = _full_queue() + ["pas un dict", None]
    assert radar.pick_rotation(rows, NOW) is not None
    assert radar.pick_rotation(None, NOW) is None


def test_run_once_rote_la_doyenne_et_retrouve_la_parole(sources, alice):
    """Le tour complet : file pleine et figée -> UNE place rendue -> le radar
    génère à nouveau."""
    sources.events = [EVENT]
    radar.save_state({"hypotheses": _full_queue(tickers=["AAA"]),
                      "stats": {"hits": 0, "misses": 0, "unclear": 0}})

    calls = []
    out = radar.run_once(
        now=NOW, llm=_llm(TWO_HYPS, calls), tg_cfg={},
        # La doyenne est née il y a 14 jours : les deux bougies lui sont
        # postérieures, donc mesurables (100 -> 108).
        fetch_candles=lambda *a: _candles(NOW - timedelta(days=13),
                                          [100.0, 108.0]))

    assert out["scored"] == 1 and out["generated"] == 2 and calls
    state = radar.load_state()
    rotated = [h for h in state["hypotheses"]
               if h["id"] == "h%02d" % (radar.MAX_OPEN - 1)][0]
    assert rotated["status"] == "scored"
    # « indécise » MÊME avec +8 % : on note avant l'échéance, on ne choisit pas
    # sa fenêtre de mesure après coup.
    assert rotated["outcome"] == "unclear"
    assert rotated["move_pct"] == pytest.approx(8.0)
    assert rotated["note"] == radar.ROTATION_NOTE
    assert rotated["scored_at"] == NOW.isoformat()
    assert state["stats"]["unclear"] == 1


def test_run_once_ne_rote_qu_une_seule_place_par_passage(sources, alice):
    sources.events = [EVENT]
    radar.save_state({"hypotheses": _full_queue(),
                      "stats": {"hits": 0, "misses": 0, "unclear": 0}})
    radar.run_once(now=NOW, llm=_llm('{"hypotheses": []}'), tg_cfg={},
                   fetch_candles=lambda *a: [])
    open_left = [h for h in radar.load_state()["hypotheses"]
                 if h["status"] == "open"]
    assert len(open_left) == radar.MAX_OPEN - 1


def test_run_once_file_pleine_de_coach_reste_muette_sans_rien_roter(sources, alice):
    sources.events = [EVENT]
    radar.save_state({"hypotheses": _full_queue(source="coach"),
                      "stats": {"hits": 0, "misses": 0, "unclear": 0}})
    calls = []
    out = radar.run_once(now=NOW, llm=_llm(TWO_HYPS, calls), tg_cfg={},
                         fetch_candles=lambda *a: [])
    assert calls == [] and out["scored"] == 0 and out["generated"] == 0
    assert all(h["status"] == "open" for h in radar.load_state()["hypotheses"])


def test_le_carnet_dit_qu_un_verdict_vient_d_une_rotation():
    note = radar.format_outcome_note(_hyp(status="scored", outcome="unclear",
                                          scored_at=NOW.isoformat(),
                                          move_pct=1.2,
                                          note=radar.ROTATION_NOTE))
    assert radar.ROTATION_NOTE in note
    assert "AVANT son échéance" in note


def test_le_carnet_ordinaire_ne_parle_pas_de_rotation():
    assert "rotation" not in radar.format_outcome_note(
        _hyp(status="scored", outcome="hit", scored_at=NOW.isoformat()))


# --------------------------------------------------------------------------- #
# run_once — (c) scoring à l'échéance
# --------------------------------------------------------------------------- #

def test_run_once_score_a_l_echeance(sources, alice, tmp_path):
    radar.save_state({"hypotheses": [_hyp(tickers=["NESN.SW"])],
                      "stats": {"hits": 0, "misses": 0, "unclear": 0}})
    sent = []
    asked = []

    def fetch(symbol, range_, interval):
        asked.append((symbol, range_, interval))
        return _candles(NOW - timedelta(days=10), [100.0, 103.0, 108.0])

    out = radar.run_once(now=NOW, llm=_llm('{"hypotheses": []}'),
                         fetch_candles=fetch, notifier=_notifier(sent), tg_cfg=TG)

    assert out["scored"] == 1 and out["errors"] == 0
    assert asked == [("NESN.SW", radar.SCORE_RANGE, radar.SCORE_INTERVAL)]

    state = radar.load_state()
    hyp = state["hypotheses"][0]
    assert hyp["status"] == "scored" and hyp["outcome"] == "hit"
    assert hyp["move_pct"] == pytest.approx(8.0)
    assert hyp["scored_at"] == NOW.isoformat()
    assert state["stats"] == {"hits": 1, "misses": 0, "unclear": 0}

    # Le verdict ne part PLUS sur Telegram (spec §13) : il vit dans le carnet.
    assert sent == []
    note = (tmp_path / "alice-vault" / "Radar.md").read_text(encoding="utf-8")
    assert "verdict : réussie (+8.0 %)" in note


def test_run_once_ne_score_pas_avant_l_echeance(sources, alice):
    radar.save_state({"hypotheses": [_hyp(created_at=(NOW - timedelta(days=1)).isoformat(),
                                          horizon_days=20)],
                      "stats": {"hits": 0, "misses": 0, "unclear": 0}})
    called = []
    out = radar.run_once(now=NOW, llm=_llm('{"hypotheses": []}'), tg_cfg={},
                         fetch_candles=lambda *a: called.append(a) or [])
    assert out["scored"] == 0 and called == []
    assert radar.load_state()["hypotheses"][0]["status"] == "open"


def test_run_once_ticker_muet_ne_casse_pas_le_scoring(sources, alice):
    """Bougies indisponibles -> ticker ignoré, erreur comptée, verdict honnête."""
    radar.save_state({"hypotheses": [_hyp(tickers=["AAA", "BBB"])],
                      "stats": {"hits": 0, "misses": 0, "unclear": 0}})

    def fetch(symbol, range_, interval):
        if symbol == "AAA":
            raise RuntimeError("Yahoo muet")
        return _candles(NOW - timedelta(days=10), [100.0, 110.0])

    out = radar.run_once(now=NOW, llm=_llm('{"hypotheses": []}'), tg_cfg={},
                         fetch_candles=fetch)
    assert out["scored"] == 1 and out["errors"] == 1
    hyp = radar.load_state()["hypotheses"][0]
    assert hyp["outcome"] == "hit" and hyp["move_pct"] == pytest.approx(10.0)


def test_run_once_aucune_bougie_du_tout_rend_indecis(sources, alice):
    radar.save_state({"hypotheses": [_hyp(tickers=["AAA"])],
                      "stats": {"hits": 0, "misses": 0, "unclear": 0}})
    out = radar.run_once(now=NOW, llm=_llm('{"hypotheses": []}'), tg_cfg={},
                         fetch_candles=lambda *a: [])
    assert out["scored"] == 1
    assert radar.load_state()["stats"] == {"hits": 0, "misses": 0, "unclear": 1}


# --------------------------------------------------------------------------- #
# run_once — (d) LLM en panne
# --------------------------------------------------------------------------- #

def test_run_once_llm_en_panne_compte_une_erreur_et_garde_le_scoring(sources, alice):
    sources.events = [EVENT]
    radar.save_state({"hypotheses": [_hyp(tickers=["NESN.SW"])],
                      "stats": {"hits": 0, "misses": 0, "unclear": 0}})

    def boom(prompt):
        raise RuntimeError("CLI Claude introuvable")

    out = radar.run_once(
        now=NOW, llm=boom, tg_cfg={},
        fetch_candles=lambda *a: _candles(NOW - timedelta(days=10), [100.0, 110.0]))

    assert out["errors"] == 1 and out["generated"] == 0 and out["scored"] == 1

    state = radar.load_state()
    assert state["stats"] == {"hits": 1, "misses": 0, "unclear": 0}
    assert state["hypotheses"][0]["status"] == "scored"     # le scoring est SAUVÉ


# --------------------------------------------------------------------------- #
# run_once — (e) aucune matière = aucun appel LLM
# --------------------------------------------------------------------------- #

def test_run_once_sans_matiere_n_appelle_pas_le_llm(sources, alice):
    """Rien à raisonner = pas de jetons. Un radar qui « réfléchit » à vide
    fabrique exactement l'astrologie qu'on s'interdit."""
    calls = []
    out = radar.run_once(now=NOW, llm=_llm(TWO_HYPS, calls), tg_cfg={},
                         fetch_candles=lambda *a: [])
    assert calls == []
    assert out == {"generated": 0, "notified": 0, "scored": 0, "errors": 0,
                   "fired": False}
    assert radar.load_state() == radar.blank_state()


def test_run_once_sans_utilisateur_ne_fait_rien(sources):
    sources.events = [EVENT]
    calls = []
    out = radar.run_once(now=NOW, llm=_llm(TWO_HYPS, calls), tg_cfg={},
                         fetch_candles=lambda *a: [])
    assert calls == [] and out["generated"] == 0


# --------------------------------------------------------------------------- #
# run_once — (f) sans Telegram
# --------------------------------------------------------------------------- #

def test_run_once_sans_telegram_genere_et_score_quand_meme(sources, alice, tmp_path):
    """Le radar vaut par l'UI seule : pas de config = pas de notif, rien d'autre."""
    sources.events = [EVENT]
    radar.save_state({"hypotheses": [_hyp(tickers=["NESN.SW"])],
                      "stats": {"hits": 0, "misses": 0, "unclear": 0}})
    sent = []
    out = radar.run_once(
        now=NOW, llm=_llm(TWO_HYPS), notifier=_notifier(sent), tg_cfg={},
        fetch_candles=lambda *a: _candles(NOW - timedelta(days=10), [100.0, 110.0]))

    assert sent == []
    assert out["notified"] == 0
    assert out["generated"] == 2 and out["scored"] == 1
    assert (tmp_path / "alice-vault" / "Radar.md").is_file()


def test_run_once_notifieur_en_panne_ne_casse_rien(sources, alice):
    sources.events = [EVENT]

    def boom(text, cfg):
        raise RuntimeError("Telegram down")

    out = radar.run_once(now=NOW, llm=_llm(TWO_HYPS), notifier=boom, tg_cfg=TG,
                         fetch_candles=lambda *a: [])
    assert out["generated"] == 2 and out["notified"] == 0
    assert len(radar.load_state()["hypotheses"]) == 2


# --------------------------------------------------------------------------- #
# run_once — (g) passage de relais à la convergence (spec §13)
# --------------------------------------------------------------------------- #

def _convergence_spy(monkeypatch, result=None, boom=False):
    """Espionne (ou casse) ``convergence.maybe_fire`` — rend la liste d'appels."""
    calls = []

    def _fake(**kwargs):
        calls.append(kwargs)
        if boom:
            raise RuntimeError("convergence cassée")
        return result if result is not None else {"fired": False, "sent": False}

    monkeypatch.setattr(convergence, "maybe_fire", _fake)
    return calls


def test_run_once_passe_la_main_a_la_convergence_en_fin_de_course(
        sources, alice, monkeypatch):
    """Le radar se tait, mais il PRÉVIENT la couche qui, elle, a le droit de
    parler — en lui passant ses propres dépendances injectées."""
    sources.events = [EVENT]
    sent = []
    notifier = _notifier(sent)
    llm = _llm(TWO_HYPS)
    calls = _convergence_spy(monkeypatch, {"fired": True, "sent": True})

    out = radar.run_once(now=NOW, llm=llm, notifier=notifier, tg_cfg=TG,
                         fetch_candles=lambda *a: [])

    assert len(calls) == 1
    assert calls[0]["now"] == NOW
    assert calls[0]["llm"] is llm
    assert calls[0]["notifier"] is notifier
    assert calls[0]["tg_cfg"] == TG
    # Le seul message possible d'un run est celui de la convergence.
    assert out["fired"] is True and out["notified"] == 1
    assert out["generated"] == 2


def test_run_once_consulte_la_convergence_meme_sans_matiere(sources, alice,
                                                            monkeypatch):
    """C'est justement quand le radar n'a plus rien à produire que ce qui s'est
    accumulé mérite un regard : aucune sortie anticipée ne doit la sauter."""
    calls = _convergence_spy(monkeypatch)
    out = radar.run_once(now=NOW, llm=_llm(TWO_HYPS), tg_cfg={},
                         fetch_candles=lambda *a: [])
    assert len(calls) == 1 and out["generated"] == 0


def test_run_once_consulte_la_convergence_meme_file_pleine(sources, alice,
                                                           monkeypatch):
    sources.events = [EVENT]
    radar.save_state({
        "hypotheses": [_hyp(id="h%d" % i, created_at=(NOW - timedelta(days=1)).isoformat(),
                            horizon_days=30)
                       for i in range(radar.MAX_OPEN)],
        "stats": {"hits": 0, "misses": 0, "unclear": 0}})
    calls = _convergence_spy(monkeypatch)
    out = radar.run_once(now=NOW, llm=_llm(TWO_HYPS), tg_cfg={},
                         fetch_candles=lambda *a: [])
    assert len(calls) == 1 and out["generated"] == 0


def test_run_once_convergence_en_panne_compte_une_erreur_sans_casser(
        sources, alice, monkeypatch):
    """Le radar a déjà fait son travail quand la convergence parle : une panne
    de celle-ci ne doit jamais faire perdre un scoring."""
    sources.events = [EVENT]
    _convergence_spy(monkeypatch, boom=True)

    out = radar.run_once(now=NOW, llm=_llm(TWO_HYPS), tg_cfg={},
                         fetch_candles=lambda *a: [])

    assert out["generated"] == 2 and out["errors"] == 1 and out["fired"] is False
    assert len(radar.load_state()["hypotheses"]) == 2   # l'état est sauvé


# --------------------------------------------------------------------------- #
# run_once — tendances sociales (spec §13)
# --------------------------------------------------------------------------- #

REDDIT_XML = (
    '<?xml version="1.0" encoding="UTF-8"?>'
    '<feed xmlns="http://www.w3.org/2005/Atom">'
    '<entry>'
    '<title>Le fret maritime explose https://exemple.test/abc #trading #stocks</title>'
    '<link href="https://reddit.test/1"/>'
    '<category term="stocks"/>'
    '<updated>2026-08-24T07:00:00+00:00</updated>'
    '</entry>'
    '</feed>'
)

BSKY_JSON = json.dumps({"posts": [{
    "record": {"text": "les taux bougent, regardez le cuivre",
               "createdAt": "2026-08-24T07:30:00Z"},
    "author": {"handle": "quelquun.bsky.social"},
    "uri": "at://did:plc:x/app.bsky.feed.post/abc",
}]})


def test_run_once_sources_sociales_toutes_en_panne(sources, alice, monkeypatch):
    """Aucune source sociale ne répond -> le run continue, erreurs comptées."""
    monkeypatch.setattr(radar, "_collect_social", _REAL_COLLECT_SOCIAL)
    sources.events = [EVENT]

    def dead_fetch(url):
        raise RuntimeError("réseau coupé")

    calls = []
    out = radar.run_once(now=NOW, llm=_llm(TWO_HYPS, calls), tg_cfg={},
                         fetch_candles=lambda *a: [],
                         social_fetch=dead_fetch, sleep=lambda s: None)

    # 5 sources (1 Reddit + 2 Bluesky + 2 X), toutes muettes.
    assert out["errors"] == 5
    assert out["generated"] == 2            # le radar tourne quand même
    assert "TENDANCES SOCIALES" in calls[0]
    assert "- (aucune)" in calls[0]


def test_run_once_nettoie_les_textes_sociaux_avant_le_prompt(sources, alice, monkeypatch):
    """Tout texte social passe par clean_social_text : ni URL, ni grappe de
    hashtags dans le prompt (on paie des jetons pour du sens, pas du bruit)."""
    monkeypatch.setattr(radar, "_collect_social", _REAL_COLLECT_SOCIAL)
    sources.events = [EVENT]

    def fetch(url):
        if "reddit.com" in url:
            return REDDIT_XML
        if "bsky" in url:
            return BSKY_JSON
        return ""                            # X : page vide, source ignorée

    calls = []
    out = radar.run_once(now=NOW, llm=_llm(TWO_HYPS, calls), tg_cfg={},
                         fetch_candles=lambda *a: [],
                         social_fetch=fetch, sleep=lambda s: None)

    prompt = calls[0]
    assert out["errors"] == 0
    assert "TENDANCES SOCIALES" in prompt
    assert "Le fret maritime explose" in prompt
    assert "exemple.test" not in prompt      # URL retirée
    assert "#trading" not in prompt          # grappe de hashtags retirée
    assert "les taux bougent, regardez le cuivre" in prompt
    assert "Reddit r/stocks" in prompt


def test_collect_social_une_seule_requete_reddit_en_multireddit(monkeypatch):
    """Plafond MESURÉ 1 req/60 s/IP : jamais un sub à la fois."""
    urls = []

    def fetch(url):
        urls.append(url)
        return ""

    items, errors = _REAL_COLLECT_SOCIAL(fetch, lambda s: None)
    reddit_urls = [u for u in urls if "reddit.com" in u]
    assert len(reddit_urls) == 1
    for sub in radar.SOCIAL_SUBS:
        assert sub in reddit_urls[0]
    assert "limit=%d" % radar.SOCIAL_REDDIT_LIMIT in reddit_urls[0]
    assert len(urls) == 5                    # 1 Reddit + 2 Bluesky + 2 X
    assert (items, errors) == ([], 0)


def test_collect_social_x_fragile_est_avale(monkeypatch):
    """Le scraping de X casse quand X change son HTML : silence + compteur."""
    social = radar._social_module()

    def fetch(url):
        if "x.com" in url:
            raise social.XSerializationChanged("format changé")
        return ""

    items, errors = _REAL_COLLECT_SOCIAL(fetch, lambda s: None)
    assert errors == 2                       # les 2 comptes X, rien d'autre
    assert items == []


# --------------------------------------------------------------------------- #
# recent — contrat public du router
# --------------------------------------------------------------------------- #

def test_recent_ouvertes_d_abord_puis_les_plus_fraiches():
    radar.save_state({
        "hypotheses": [
            _hyp(id="scored_vieux", thesis="vieux verdict", status="scored",
                 outcome="miss", scored_at="2026-08-01T00:00:00"),
            _hyp(id="open_vieux", thesis="ouverte ancienne",
                 created_at="2026-08-02T00:00:00"),
            _hyp(id="scored_frais", thesis="verdict frais", status="scored",
                 outcome="hit", scored_at="2026-08-20T00:00:00"),
            _hyp(id="open_frais", thesis="ouverte fraîche",
                 created_at="2026-08-22T00:00:00"),
        ],
        "stats": {"hits": 1, "misses": 1, "unclear": 0},
    })
    out = radar.recent()
    assert [h["id"] for h in out["hypotheses"]] == [
        "open_frais", "open_vieux", "scored_frais", "scored_vieux"]
    assert out["stats"] == {"hits": 1, "misses": 1, "unclear": 0}


def test_recent_respecte_la_limite():
    radar.save_state({
        "hypotheses": [_hyp(id="h%d" % i, created_at="2026-08-%02dT00:00:00" % (i + 1))
                       for i in range(10)],
        "stats": {"hits": 0, "misses": 0, "unclear": 0},
    })
    assert len(radar.recent(limit=3)["hypotheses"]) == 3
    assert radar.recent(limit=0)["hypotheses"] == []
    assert len(radar.recent(limit="oups")["hypotheses"]) == 10


def test_recent_sans_etat():
    assert radar.recent() == {"stats": {"hits": 0, "misses": 0, "unclear": 0},
                              "stats_by_level": {}, "hypotheses": []}


# ================================================================
#  bilan PAR NIVEAU DE RISQUE — l'honnêteté par étage
#
#  But produit : voir si le niveau spéculatif gagne ou s'il brûle du crédit.
#  Un bilan global le noierait dans la masse.
# ================================================================

def _scored(level=None, outcome="hit", source=None, **over):
    """Une hypothèse NOTÉE, avec (ou sans) niveau de risque."""
    row = _hyp(status="scored", outcome=outcome,
               scored_at=NOW.isoformat(), move_pct=4.0, **over)
    if level is not None:
        row["risk_level"] = level
    if source is not None:
        row["source"] = source
    return row


def test_stats_by_level_ventile_par_etage():
    rows = [
        _scored("speculatif", "hit", source="coach"),
        _scored("speculatif", "miss", source="coach"),
        _scored("speculatif", "unclear", source="coach"),
        _scored("agressif", "hit", source="coach"),
        _scored("mesure", "miss", source="coach"),
    ]
    assert radar.stats_by_level(rows) == {
        "speculatif": {"hits": 1, "misses": 1, "unclear": 1},
        "agressif": {"hits": 1, "misses": 0, "unclear": 0},
        "mesure": {"hits": 0, "misses": 1, "unclear": 0},
    }


def test_stats_by_level_ne_compte_que_les_hypotheses_notees():
    """Une hypothèse OUVERTE n'a encore rien prouvé : elle n'entre pas au
    bilan, sinon le niveau spéculatif aurait l'air excellent le temps que ses
    paris arrivent à échéance."""
    rows = [_hyp(risk_level="speculatif", source="coach"),          # ouverte
            _scored("speculatif", "hit", source="coach")]
    assert radar.stats_by_level(rows) == {
        "speculatif": {"hits": 1, "misses": 0, "unclear": 0}}


def test_stats_by_level_range_le_radar_automatique_a_part():
    """Les hypothèses du radar ne sont pas des idées de trade dimensionnées :
    elles ont leur propre case, elles ne gonflent aucun étage."""
    rows = [_scored(None, "hit"), _scored(None, "miss")]
    assert radar.stats_by_level(rows) == {
        "radar": {"hits": 1, "misses": 1, "unclear": 0}}


def test_stats_by_level_compte_les_vieilles_idees_du_coach_en_mesure():
    """État d'AVANT la fonctionnalité : une idée du coach sans niveau a été
    produite avec la doctrine devenue « mesuré » — la compter sous « radar »
    serait faux."""
    rows = [_scored(None, "hit", source="coach")]
    assert radar.stats_by_level(rows) == {
        "mesure": {"hits": 1, "misses": 0, "unclear": 0}}


def test_stats_by_level_repli_vers_le_bas_sur_un_niveau_inconnu():
    rows = [_scored("yolo", "hit", source="coach")]
    assert radar.stats_by_level(rows) == {
        "mesure": {"hits": 1, "misses": 0, "unclear": 0}}


def test_stats_by_level_ignore_les_entrees_deformees():
    assert radar.stats_by_level(None) == {}
    assert radar.stats_by_level(["pas un dict", 42, {}]) == {}


def test_stats_by_level_case_absente_plutot_que_zeros():
    """« 0 réussie / 0 ratée » se lirait comme un échec ; « pas encore de
    verdict » se dit en n'affichant pas la case."""
    assert "agressif" not in radar.stats_by_level([_scored("mesure", "hit",
                                                           source="coach")])


def test_recent_expose_le_bilan_par_niveau_sur_tout_l_etat():
    """Le bilan porte sur l'état entier, pas sur la tranche rendue : un bilan
    qui rétrécirait avec ``limit`` ne serait plus un bilan."""
    radar.save_state({
        "hypotheses": [_scored("speculatif", "hit", source="coach", id="s1"),
                       _scored("speculatif", "miss", source="coach", id="s2"),
                       _scored("mesure", "hit", source="coach", id="m1")],
        "stats": {"hits": 2, "misses": 1, "unclear": 0},
    })
    out = radar.recent(limit=1)
    assert len(out["hypotheses"]) == 1
    assert out["stats_by_level"] == {
        "speculatif": {"hits": 1, "misses": 1, "unclear": 0},
        "mesure": {"hits": 1, "misses": 0, "unclear": 0},
    }


def test_un_etat_ancien_sans_niveau_se_relit_sans_erreur():
    """Rétro-compatibilité stricte : un radar.json écrit AVANT cette
    fonctionnalité se relit, se trie et se ventile sans exception."""
    radar.save_state({
        "hypotheses": [_hyp(id="vieille_ouverte"),
                       _scored(None, "hit", id="vieux_verdict")],
        "stats": {"hits": 1, "misses": 0, "unclear": 0},
    })
    out = radar.recent()
    assert [h["id"] for h in out["hypotheses"]] == ["vieille_ouverte",
                                                    "vieux_verdict"]
    assert out["stats_by_level"] == {"radar": {"hits": 1, "misses": 0,
                                               "unclear": 0}}


def test_les_cases_de_bilan_refletent_les_niveaux_du_coach():
    """⚠️ Miroir VOLONTAIRE (le radar n'importe pas le module LLM) : ce test est
    le seul garde-fou contre une divergence silencieuse le jour où un quatrième
    niveau apparaîtra — piège #61 du dépôt."""
    from backend.bots.paper import llm
    assert radar.RISK_BUCKETS == llm.RISK_LEVELS
    assert radar.DEFAULT_BUCKET == llm.DEFAULT_RISK_LEVEL
    assert radar.RADAR_BUCKET not in llm.RISK_LEVELS


def test_collect_social_partage_equitablement_les_places(monkeypatch):
    """Reddit rend 50 posts d'un coup : sans partage équitable il mangerait
    les 25 places et Bluesky/X disparaîtraient sans que rien ne le signale
    (même leçon que la revue de presse de Market Pulse)."""
    entries = "".join(
        '<entry><title>post reddit %d</title><link href="https://r.test/%d"/>'
        '<category term="stocks"/></entry>' % (i, i) for i in range(50))
    reddit_xml = ('<?xml version="1.0" encoding="UTF-8"?>'
                  '<feed xmlns="http://www.w3.org/2005/Atom">%s</feed>' % entries)

    def fetch(url):
        if "reddit.com" in url:
            return reddit_xml
        if "bsky" in url:
            return BSKY_JSON
        return ""

    items, errors = _REAL_COLLECT_SOCIAL(fetch, lambda s: None)
    assert errors == 0
    assert len(items) == radar.MAX_SOCIAL_ITEMS
    sources_vues = {i["source"] for i in items}
    assert any("Reddit" in s for s in sources_vues)
    assert any("Bluesky" in s for s in sources_vues)     # non étouffé par Reddit


# =========================================================================== #
#  Étage « crypto » et mouvements de gérants (26/08)
# =========================================================================== #

def test_le_bilan_a_une_case_crypto():
    """Le 4e étage d'idées doit être JUGÉ comme les trois autres, sinon on ne
    saura jamais s'il gagne ou s'il brûle du crédit."""
    assert "crypto" in radar.RISK_BUCKETS
    hypotheses = [
        {"status": "scored", "outcome": "hit", "risk_level": "crypto"},
        {"status": "scored", "outcome": "miss", "risk_level": "crypto"},
        {"status": "scored", "outcome": "hit", "risk_level": "mesure"},
    ]
    stats = radar.stats_by_level(hypotheses)
    assert stats["crypto"] == {"hits": 1, "misses": 1, "unclear": 0}
    assert stats["mesure"]["hits"] == 1


def test_une_hypothese_crypto_garde_sa_case():
    assert radar.level_bucket({"risk_level": "crypto"}) == "crypto"


def test_le_prompt_porte_les_mouvements_des_gerants():
    moves = [{"manager_label": "Warren Buffett — Berkshire Hathaway",
              "action": "sortie", "name": "KROGER CO"},
             {"manager_label": "Michael Burry — Scion", "action": "allégé",
              "name": "APPLE INC", "delta_pct": -42.0}]
    prompt = radar.build_prompt([], [], [], [], {}, "2026-08-26", None, moves)
    assert "MOUVEMENTS DE PORTEFEUILLE DES GRANDS GÉRANTS" in prompt
    assert "sortie sur KROGER CO" in prompt
    assert "allégé sur APPLE INC (-42.0 %)" in prompt
    assert "45 jours" in prompt                 # l'honnêteté sur la latence


def test_le_prompt_dit_quand_aucun_gerant_n_a_bouge():
    prompt = radar.build_prompt([], [], [], [], {}, "2026-08-26", None, [])
    assert "MOUVEMENTS DE PORTEFEUILLE DES GRANDS GÉRANTS" in prompt


def test_les_mouvements_des_gerants_sont_bornes():
    moves = [{"manager_label": "M", "action": "sortie", "name": "N%d" % i}
             for i in range(50)]
    prompt = radar.build_prompt([], [], [], [], {}, "2026-08-26", None, moves)
    assert prompt.count("sortie sur N") == radar.MAX_WHALE_MOVES


def _install_whales(monkeypatch, stub):
    """Pose le stub À LA FOIS dans ``sys.modules`` ET en attribut du paquet.

    ⚠️ ``from backend.bots.paper import whales`` lit l'ATTRIBUT du paquet dès
    que le vrai module a été importé une fois dans la session : sans le second
    monkeypatch, le test passe seul et échoue dans la suite complète (même
    piège que la suite de la convergence)."""
    import backend.bots.paper as paper_pkg
    monkeypatch.setitem(sys.modules, "backend.bots.paper.whales", stub)
    monkeypatch.setattr(paper_pkg, "whales", stub, raising=False)


def test_les_mouvements_viennent_du_cache_sans_requete(monkeypatch):
    """``_collect_whale_moves`` lit ``moves_summary``, qui ne touche jamais la
    SEC — le radar tourne trois fois par jour, il ne doit rien coûter."""
    import types
    whales_stub = types.ModuleType("backend.bots.paper.whales")
    whales_stub.moves_summary = lambda: [{"manager_label": "M",
                                          "action": "sortie", "name": "X"}]
    _install_whales(monkeypatch, whales_stub)
    assert radar._collect_whale_moves()[0]["name"] == "X"


def test_un_module_whales_absent_ne_casse_pas_le_radar(monkeypatch):
    import types
    whales_stub = types.ModuleType("backend.bots.paper.whales")

    def boom():
        raise RuntimeError("cache illisible")

    whales_stub.moves_summary = boom
    _install_whales(monkeypatch, whales_stub)
    assert radar._collect_whale_moves() == []


# ==========================================================================
#  LOT 5 — hygiène des tickers : une hypothèse peut nommer un titre qui
#  n'existe pas.
#
#  Vécu : le modèle a écrit « SAP.TO », qui n'existe pas chez Yahoo. Sans
#  contrôle, ce fantôme entrait dans l'univers du coach et y restait — la
#  cotation échouait à chaque passe, silencieusement. On ne SUPPRIME pas
#  l'hypothèse pour autant : sa thèse peut être juste, c'est le ticker de
#  mesure qui est faux. On la MARQUE, et le coach l'ignore comme candidat.
# ==========================================================================

def test_a_quoted_ticker_leaves_no_mark():
    hyp = {"tickers": ["NESN.SW", "AAPL"]}
    radar.mark_unquoted(hyp, is_quoted=lambda symbol: True)
    assert "unquoted" not in hyp
    assert hyp["tickers"] == ["NESN.SW", "AAPL"]


def test_an_unknown_ticker_is_marked_but_kept():
    """L'hypothèse SURVIT : sa thèse peut être juste, c'est son ticker de
    mesure qui est faux. La jeter perdrait le raisonnement avec le fantôme."""
    hyp = {"thesis": "une chaîne valable", "tickers": ["SAP.TO", "NESN.SW"]}
    radar.mark_unquoted(hyp, is_quoted=lambda symbol: symbol != "SAP.TO")
    assert hyp["tickers"] == ["SAP.TO", "NESN.SW"]
    assert hyp["unquoted"] == ["SAP.TO"]
    assert hyp["thesis"] == "une chaîne valable"


def test_the_mark_lists_the_guilty_tickers_not_the_whole_hypothesis():
    """⚠️ Choix de conception : la marque est la LISTE des tickers muets, pas
    un booléen sur l'hypothèse. Un booléen ferait jeter deux tickers valides
    parce qu'un troisième est mort — et une hypothèse en porte jusqu'à trois."""
    hyp = {"tickers": ["MORT1", "NESN.SW", "MORT2"]}
    radar.mark_unquoted(hyp, is_quoted=lambda s: s == "NESN.SW")
    assert hyp["unquoted"] == ["MORT1", "MORT2"]


def test_the_mark_is_refreshed_not_accumulated():
    """Un titre peut redevenir cotable (nouvelle place, fin de suspension) :
    la marque se REFAIT à chaque contrôle plutôt que de s'empiler."""
    hyp = {"tickers": ["NESN.SW"], "unquoted": ["NESN.SW"]}
    radar.mark_unquoted(hyp, is_quoted=lambda symbol: True)
    assert "unquoted" not in hyp


def test_a_quote_failure_is_not_an_absent_ticker():
    """Yahoo en panne n'est pas « ce titre n'existe pas ». Une exception du
    contrôle laisse le ticker INTACT : marquer sur une panne réseau
    supprimerait tout l'univers du coach le jour d'une coupure."""
    def _boom(symbol):
        raise RuntimeError("Yahoo injoignable")

    hyp = {"tickers": ["NESN.SW"]}
    radar.mark_unquoted(hyp, is_quoted=_boom)
    assert "unquoted" not in hyp


def test_marking_tolerates_anything():
    for junk in (None, {}, {"tickers": None}, {"tickers": [1, None, True]}):
        radar.mark_unquoted(junk, is_quoted=lambda symbol: False)   # ne lève pas


def test_generated_hypotheses_are_checked_at_birth(sources, alice, monkeypatch):
    """Le contrôle vit au POINT D'ÉCRITURE : une hypothèse née avec un ticker
    fantôme doit porter sa marque tout de suite, pas au premier échec de
    cotation trois jours plus tard."""
    sources.events = [EVENT]
    monkeypatch.setattr(radar, "_default_is_quoted",
                        lambda symbol: symbol != "SAP.TO", raising=False)
    answer = json.dumps({"hypotheses": [{
        "thesis": "les licences reculent",
        "chain": ["a", "b"],
        "tickers": ["SAP.TO", "NESN.SW"],
        "direction": "down",
        "horizon_days": 10,
        "invalidation": "un rebond",
    }]})

    radar.run_once(now=NOW, llm=_llm(answer), tg_cfg=TG,
                   fetch_candles=lambda *a: [])
    hyp = radar.load_state()["hypotheses"][-1]
    assert hyp["tickers"] == ["SAP.TO", "NESN.SW"]
    assert hyp["unquoted"] == ["SAP.TO"]
