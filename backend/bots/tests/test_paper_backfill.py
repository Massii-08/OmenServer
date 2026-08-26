"""Tests du dossier HISTORIQUE des titres suivis — 100 % hors ligne.

Tout ce qui sort de la machine est injecté : ``fetch``, ``sleep``, ``now``,
``resolve_name``. Aucun test ne touche le réseau ; ``store.DATA_DIR`` est
monkeypatché vers ``tmp_path`` pour CHACUN (même fixture autouse que
``test_paper_store.py`` et ``test_paper_radar.py``).

Le client HTTP est construit ICI plutôt qu'importé de ``test_paper_router`` :
ce lot a été écrit en parallèle d'un autre sur le même fichier de tests, et un
fichier autonome ne casse pas parce que le voisin est à mi-édition.
"""
import json
import os
import stat
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.auth.utils import get_current_user
from backend.bots import paper_router as pr
from backend.bots.paper import backfill, llm, models, newswatch, quotes, radar, store

NOW = datetime(2026, 8, 26, 12, 0, 0)


@pytest.fixture(autouse=True)
def _isolate_data_dir(tmp_path, monkeypatch):
    """Aucun test n'écrit dans le vrai data/paper_trading/."""
    monkeypatch.setattr(store, "DATA_DIR", tmp_path)
    return tmp_path


@pytest.fixture(autouse=True)
def _no_network(monkeypatch):
    """Ceinture : même un oubli d'injection ne doit pas sortir de la machine."""
    def _boom(*args, **kwargs):
        raise AssertionError("appel réseau interdit dans les tests")
    monkeypatch.setattr(backfill, "_default_fetch", _boom)
    monkeypatch.setattr(backfill, "_default_resolve_name", _boom)


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #

def _item(title, when, link=None):
    return (title, link or "https://news.example/%s" % abs(hash(title)), when)


def _rss(items):
    """Un flux Google News réaliste (même structure item/title/link/pubDate que
    celle que ``newswatch.parse_rss`` lit déjà pour le volet politique)."""
    body = "".join(
        "<item><title><![CDATA[%s]]></title><link>%s</link>"
        "<pubDate>%s</pubDate></item>"
        % (title, link, format_datetime(when.replace(tzinfo=timezone.utc)))
        for title, link, when in items)
    return ('<?xml version="1.0" encoding="UTF-8"?><rss version="2.0">'
            '<channel><title>Google News</title>%s</channel></rss>' % body)


class Feed(object):
    """Faux Google News : mémorise les URL demandées, sert une réponse par
    fenêtre (dans l'ordre), et sait tomber en panne."""

    def __init__(self, payloads=None, broken=()):
        self.payloads = list(payloads or [])
        self.broken = set(broken)          # index des fenêtres en panne
        self.urls = []
        self.sleeps = []

    def fetch(self, url):
        index = len(self.urls)
        self.urls.append(url)
        if index in self.broken:
            raise RuntimeError("RSS HTTP 503")
        if index < len(self.payloads):
            return self.payloads[index]
        return _rss([])

    def sleep(self, seconds):
        self.sleeps.append(seconds)


def _anchor(username="alice", symbol="NVDA", name="NVIDIA Corporation"):
    """Un compte avec UNE position et le nom du titre en watchlist."""
    store.save_portfolio(username, {"cash_chf": 10000.0, "positions": [
        {"symbol": symbol, "qty": 1, "avg_price": 100.0, "side": "long"}]})
    if name:
        store.save_watchlist(username, [{"symbol": symbol, "name": name}])
    return username


def _state_with(symbol="NVDA", windows=None):
    """Un état posé à la main — la matière des tests de mise en forme."""
    return {"symbols": {symbol: {"name": "NVIDIA", "fetched_at": NOW.isoformat(),
                                 "windows": windows or []}}}


def _win(from_, to, items):
    return {"from": from_, "to": to, "items": list(items)}


def _it(ts, title, sentiment="neutre"):
    return {"ts": ts, "title": title, "sentiment": sentiment}


class FakeUser(object):
    def __init__(self, role="admin", username="tester"):
        self.role = role
        self.is_admin = role == "admin"
        self.username = username


def make_client(role="admin"):
    app = FastAPI()
    app.include_router(pr.router)
    app.dependency_overrides[get_current_user] = lambda: FakeUser(role)
    return TestClient(app)


# =========================================================================== #
#  PUR — fenêtres trimestrielles
# =========================================================================== #

def test_quatre_fenetres_trimestrielles_couvrent_douze_mois():
    windows = backfill.quarter_windows(NOW)
    assert len(windows) == backfill.WINDOWS == 4
    # de la plus ANCIENNE à la plus récente, et la dernière finit aujourd'hui
    assert windows[0]["from"] == (NOW.date() - timedelta(days=364)).isoformat()
    assert windows[-1]["to"] == NOW.date().isoformat()


def test_les_fenetres_sont_contigues_et_sans_recouvrement():
    windows = backfill.quarter_windows(NOW)
    for previous, following in zip(windows, windows[1:]):
        assert previous["to"] == following["from"]


def test_les_fenetres_suivent_l_horloge_injectee():
    autre = backfill.quarter_windows(NOW - timedelta(days=30))
    assert autre[-1]["to"] == (NOW.date() - timedelta(days=30)).isoformat()


def test_les_fenetres_tolerent_un_datetime_avec_fuseau():
    """Comparer naïf et aware lève un TypeError : tout est ramené en UTC naïf."""
    aware = NOW.replace(tzinfo=timezone.utc)
    assert backfill.quarter_windows(aware) == backfill.quarter_windows(NOW)


# =========================================================================== #
#  PUR — la requête part sur le NOM, dépouillé de sa forme juridique
# =========================================================================== #

@pytest.mark.parametrize("raw,expected", [
    ("NVIDIA Corporation", "NVIDIA"),
    ("Nestlé S.A.", "Nestlé"),
    ("Alphabet Inc.", "Alphabet"),
    ("ASML Holding N.V.", "ASML Holding"),      # « Holding » fait partie du nom
    ("Novartis AG", "Novartis"),
    ("The Coca-Cola Co", "The Coca-Cola"),
])
def test_le_nom_perd_sa_forme_juridique(raw, expected):
    assert backfill.query_name(raw) == expected


def test_les_mots_du_nom_ne_sont_jamais_retires(  # piège #29a du dépôt
):
    """« Worldwide », « Holdings », « Finance », « Capital » DÉSIGNENT l'entité :
    les retirer fabrique un faux positif sur une autre société."""
    assert backfill.query_name("Hilton Worldwide Holdings Inc") == \
        "Hilton Worldwide Holdings"
    assert backfill.query_name("Ally Financial Inc") == "Ally Financial"


def test_un_nom_qui_ne_serait_que_du_suffixe_est_garde_tel_quel():
    assert backfill.query_name("SA") == "SA"
    assert backfill.query_name("") == ""


def test_l_url_est_celle_qui_a_ete_sondee():
    url = backfill.search_url("NVIDIA Corporation",
                              {"from": "2025-06-01", "to": "2025-09-01"})
    assert url == (
        "https://news.google.com/rss/search?q=%22NVIDIA%22%20after%3A2025-06-01"
        "%20before%3A2025-09-01&hl=en-US&gl=US&ceid=US:en")


def test_l_url_met_le_nom_entre_guillemets():
    """Sans guillemets, « Visa » ramène de l'administratif et « Alphabet » de
    la linguistique."""
    assert "%22Visa%22" in backfill.search_url("Visa Inc", None)


# =========================================================================== #
#  PUR — conseils d'investissement
# =========================================================================== #

@pytest.mark.parametrize("title", [
    "3 top stocks to buy now", "Le migliori azioni da comprare",
    "Best stocks to own in 2026",
])
def test_un_conseil_d_investissement_n_entre_jamais_dans_le_dossier(title):
    assert backfill.is_advice(title) is True


def test_une_depeche_ordinaire_n_est_pas_un_conseil():
    assert backfill.is_advice("Nvidia beats estimates") is False
    assert backfill.is_advice("") is False


# =========================================================================== #
#  Collecte — parse, sentiment, cap
# =========================================================================== #

def test_la_collecte_interroge_les_quatre_fenetres_sur_le_nom():
    feed = Feed()
    out = backfill.backfill_symbol("NVDA", "NVIDIA Corporation", now=NOW,
                                   fetch=feed.fetch, sleep=feed.sleep)
    assert out["windows"] == 4 and out["errors"] == 0
    assert len(feed.urls) == 4
    assert all("%22NVIDIA%22" in url for url in feed.urls)
    # les bornes des quatre fenêtres, dans l'ordre
    for window, url in zip(backfill.quarter_windows(NOW), feed.urls):
        assert ("after%3A" + window["from"]) in url
        assert ("before%3A" + window["to"]) in url


def test_la_collecte_espace_ses_requetes():
    """Piège #67 : un burst de requêtes vaut un 429. Pas de pause AVANT la
    première — on ne fait pas attendre pour rien."""
    feed = Feed()
    backfill.backfill_symbol("NVDA", "NVIDIA", now=NOW, fetch=feed.fetch,
                             sleep=feed.sleep)
    assert feed.sleeps == [backfill.PACE_S] * 3


def test_le_sentiment_vient_des_classifieurs_de_la_veille():
    when = NOW - timedelta(days=200)
    feed = Feed([_rss([_item("Nvidia plunges after profit warning", when),
                       _item("Nvidia beats estimates", when - timedelta(days=1)),
                       _item("Nvidia to report earnings next week",
                             when - timedelta(days=2)),
                       _item("Nvidia opens a new campus", when - timedelta(days=3))])])
    backfill.backfill_symbol("NVDA", "NVIDIA", now=NOW, fetch=feed.fetch,
                             sleep=lambda s: None)
    items = backfill.load_state()["symbols"]["NVDA"]["windows"][0]["items"]
    assert [i["sentiment"] for i in items] == ["neg", "pos", "watch", "neutre"]
    # les mêmes verdicts que la veille elle-même — pas une seconde table
    assert newswatch.classify("Nvidia plunges after profit warning") == "neg"


def test_un_conseil_est_ecarte_de_la_collecte():
    when = NOW - timedelta(days=200)
    feed = Feed([_rss([_item("3 top stocks to buy now", when),
                       _item("Nvidia beats estimates", when - timedelta(days=1))])])
    backfill.backfill_symbol("NVDA", "NVIDIA", now=NOW, fetch=feed.fetch,
                             sleep=lambda s: None)
    titles = [i["title"] for i in
              backfill.load_state()["symbols"]["NVDA"]["windows"][0]["items"]]
    assert titles == ["Nvidia beats estimates"]


def test_une_fenetre_garde_au_plus_douze_titres_les_plus_recents():
    when = NOW - timedelta(days=200)
    feed = Feed([_rss([_item("titre %02d" % i, when - timedelta(days=i))
                       for i in range(20)])])
    out = backfill.backfill_symbol("NVDA", "NVIDIA", now=NOW, fetch=feed.fetch,
                                   sleep=lambda s: None)
    items = backfill.load_state()["symbols"]["NVDA"]["windows"][0]["items"]
    assert len(items) == backfill.MAX_ITEMS_PER_WINDOW == 12
    assert items[0]["title"] == "titre 00"      # le plus récent en tête
    assert out["items"] == 12


def test_un_titre_sans_date_lisible_est_ecarte():
    """Sans date, un titre ne peut pas servir de repère dans le temps — et
    c'est exactement ce qu'on lui demande ici."""
    xml = ('<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>'
           '<item><title>sans date</title><link>https://x/1</link>'
           '<pubDate>pas une date</pubDate></item></channel></rss>')
    feed = Feed([xml])
    backfill.backfill_symbol("NVDA", "NVIDIA", now=NOW, fetch=feed.fetch,
                             sleep=lambda s: None)
    assert backfill.load_state()["symbols"]["NVDA"]["windows"][0]["items"] == []


def test_un_symbole_illisible_ne_declenche_aucune_requete():
    feed = Feed()
    out = backfill.backfill_symbol("../../etc/passwd", "x", now=NOW,
                                   fetch=feed.fetch, sleep=feed.sleep)
    assert out["skipped"] is True and out["reason"] == "invalid"
    assert feed.urls == []


def test_sans_nom_la_requete_retombe_sur_la_racine_du_ticker():
    feed = Feed()
    backfill.backfill_symbol("NESN.SW", None, now=NOW, fetch=feed.fetch,
                             sleep=lambda s: None)
    assert "%22NESN%22" in feed.urls[0]


# =========================================================================== #
#  Collecte — best-effort
# =========================================================================== #

def test_une_fenetre_en_panne_n_empeche_pas_les_autres():
    feed = Feed(broken={1})
    out = backfill.backfill_symbol("NVDA", "NVIDIA", now=NOW, fetch=feed.fetch,
                                   sleep=lambda s: None)
    assert out["errors"] == 1 and out["windows"] == 3
    assert len(backfill.load_state()["symbols"]["NVDA"]["windows"]) == 3


def test_une_source_totalement_muette_ne_pose_PAS_la_date_de_collecte():
    """Sinon un hoquet réseau condamnerait le symbole à trente jours sans
    dossier — la panne se figerait en « déjà fait »."""
    _anchor()
    feed = Feed(broken={0, 1, 2, 3})
    out = backfill.backfill_symbol("NVDA", "NVIDIA", now=NOW, fetch=feed.fetch,
                                   sleep=lambda s: None)
    assert out["errors"] == 4 and out["reason"] == "unreachable"
    assert backfill.load_state()["symbols"] == {}
    # le symbole reste en tête de file : la panne ne s'est pas figée en « fait »
    assert [a["symbol"] for a in backfill.pending_backfills(NOW)] == ["NVDA"]


def test_une_fenetre_vide_est_un_SUCCES():
    """« La presse n'a rien écrit ce trimestre-là » est une information : la
    réessayer indéfiniment n'en produirait pas d'autre."""
    feed = Feed()
    out = backfill.backfill_symbol("NVDA", "NVIDIA", now=NOW, fetch=feed.fetch,
                                   sleep=lambda s: None)
    assert out["items"] == 0 and out["reason"] == "collected"
    assert backfill.load_state()["symbols"]["NVDA"]["fetched_at"] == NOW.isoformat()


# =========================================================================== #
#  Anti-refetch
# =========================================================================== #

def test_un_dossier_de_moins_de_trente_jours_n_est_pas_recollecte():
    backfill.backfill_symbol("NVDA", "NVIDIA", now=NOW, fetch=Feed().fetch,
                             sleep=lambda s: None)
    feed = Feed()
    out = backfill.backfill_symbol("NVDA", "NVIDIA",
                                   now=NOW + timedelta(days=29),
                                   fetch=feed.fetch, sleep=feed.sleep)
    assert out["skipped"] is True and out["reason"] == "fresh"
    assert feed.urls == []


def test_passe_trente_jours_le_dossier_est_refait():
    backfill.backfill_symbol("NVDA", "NVIDIA", now=NOW, fetch=Feed().fetch,
                             sleep=lambda s: None)
    feed = Feed()
    later = NOW + timedelta(days=31)
    out = backfill.backfill_symbol("NVDA", "NVIDIA", now=later, fetch=feed.fetch,
                                   sleep=lambda s: None)
    assert out["skipped"] is False and len(feed.urls) == 4
    assert backfill.load_state()["symbols"]["NVDA"]["fetched_at"] == later.isoformat()


def test_force_passe_outre_la_fraicheur():
    backfill.backfill_symbol("NVDA", "NVIDIA", now=NOW, fetch=Feed().fetch,
                             sleep=lambda s: None)
    feed = Feed()
    out = backfill.backfill_symbol("NVDA", "NVIDIA", now=NOW, fetch=feed.fetch,
                                   sleep=lambda s: None, force=True)
    assert out["skipped"] is False and len(feed.urls) == 4


def test_une_date_de_collecte_illisible_vaut_PAS_FRAIS():
    assert backfill.is_fresh({"fetched_at": "n'importe quoi"}, NOW) is False
    assert backfill.is_fresh({}, NOW) is False
    assert backfill.is_fresh(None, NOW) is False


# =========================================================================== #
#  État sur disque
# =========================================================================== #

def test_l_etat_est_ecrit_en_0600(tmp_path):
    backfill.backfill_symbol("NVDA", "NVIDIA", now=NOW, fetch=Feed().fetch,
                             sleep=lambda s: None)
    mode = stat.S_IMODE(os.stat(str(backfill.state_path())).st_mode)
    assert mode == 0o600


def test_un_etat_illisible_rend_un_etat_vierge(tmp_path):
    backfill.state_path().write_text("{pas du json", encoding="utf-8")
    assert backfill.load_state() == {"symbols": {}}


def test_l_etat_a_plat_est_ramene_a_la_forme_canonique(tmp_path):
    """Tolérance de forme : un fichier posé à la main sans enveloppe reste
    lisible, et repart canonique à la prochaine collecte."""
    backfill.state_path().write_text(
        json.dumps({"NVDA": {"name": "NVIDIA", "windows": []}}), encoding="utf-8")
    assert "NVDA" in backfill.load_state()["symbols"]


# =========================================================================== #
#  ⚠️ Non-fantôme — ``backfill.json`` EST ``portfolio_path("backfill")``
# =========================================================================== #

def test_le_fichier_d_historique_ne_cree_pas_de_compte_fantome(tmp_path):
    """Piège maison : contrairement à ``radar.json`` ou ``convergence.json``,
    le chemin de cet état est EXACTEMENT celui qu'aurait le portefeuille d'un
    compte nommé « backfill » — ``_is_real_account`` répondrait donc VRAI sans
    la réserve de nom. Deux verrous, testés ensemble."""
    _anchor()
    backfill.backfill_symbol("NVDA", "NVIDIA", now=NOW, fetch=Feed().fetch,
                             sleep=lambda s: None)
    assert backfill.state_path() == store.portfolio_path("backfill")

    assert radar._users_with_portfolio() == ["alice"]
    assert [u for u, _p in newswatch._discover_portfolios()] == ["alice"]

    # même avec un carnet déjà écrit sur le disque (installations déployées)
    store.append_note("backfill", "Journal.md", "## fantôme\n")
    store.append_note("alice", "Journal.md", "note\n")
    assert store.list_vault_users() == ["alice"]


# =========================================================================== #
#  Ancres et file de travail
# =========================================================================== #

def test_les_ancres_sont_les_positions_union_la_watchlist():
    store.save_portfolio("alice", {"cash_chf": 1.0, "positions": [
        {"symbol": "NVDA", "qty": 1}]})
    store.save_watchlist("alice", [{"symbol": "NESN.SW", "name": "Nestlé S.A."}])
    anchors = backfill.anchor_symbols()
    assert [a["symbol"] for a in anchors] == ["NVDA", "NESN.SW"]
    # le nom vient de la watchlist — une position n'en porte pas
    assert dict((a["symbol"], a["name"]) for a in anchors) == {
        "NVDA": "", "NESN.SW": "Nestlé S.A."}


def test_une_ancre_sans_dossier_est_en_attente():
    _anchor()
    assert [a["symbol"] for a in backfill.pending_backfills(NOW)] == ["NVDA"]


def test_une_ancre_deja_collectee_sort_de_la_file():
    _anchor()
    backfill.backfill_symbol("NVDA", "NVIDIA", now=NOW, fetch=Feed().fetch,
                             sleep=lambda s: None)
    assert backfill.pending_backfills(NOW) == []
    # ... et y revient quand le dossier a vieilli
    assert [a["symbol"] for a in
            backfill.pending_backfills(NOW + timedelta(days=31))] == ["NVDA"]


def test_sans_compte_la_file_est_vide():
    assert backfill.anchor_symbols() == []
    assert backfill.pending_backfills(NOW) == []


def test_run_pending_traite_UN_symbole_par_appel():
    """Quatre requêtes espacées par symbole : en traiter dix d'un coup gèlerait
    l'appelant. La file se vide d'elle-même, passage après passage."""
    store.save_portfolio("alice", {"cash_chf": 1.0, "positions": [
        {"symbol": "NVDA", "qty": 1}, {"symbol": "AAPL", "qty": 1}]})
    feed = Feed()
    out = backfill.run_pending(now=NOW, fetch=feed.fetch, sleep=lambda s: None,
                               resolve_name=lambda s: "")
    assert out["processed"] == 1 and out["symbols"] == ["NVDA"]
    assert len(feed.urls) == 4

    out = backfill.run_pending(now=NOW, fetch=feed.fetch, sleep=lambda s: None,
                               resolve_name=lambda s: "")
    assert out["symbols"] == ["AAPL"]
    assert backfill.pending_backfills(NOW) == []


def test_run_pending_peut_en_traiter_plusieurs():
    store.save_portfolio("alice", {"cash_chf": 1.0, "positions": [
        {"symbol": "NVDA", "qty": 1}, {"symbol": "AAPL", "qty": 1}]})
    out = backfill.run_pending(max_symbols=2, now=NOW, fetch=Feed().fetch,
                               sleep=lambda s: None, resolve_name=lambda s: "")
    assert out["processed"] == 2 and out["symbols"] == ["NVDA", "AAPL"]


def test_run_pending_resout_le_nom_manquant():
    """Une position ne porte pas de nom : on va le chercher, best-effort."""
    store.save_portfolio("alice", {"cash_chf": 1.0, "positions": [
        {"symbol": "NVDA", "qty": 1}]})
    feed = Feed()
    backfill.run_pending(now=NOW, fetch=feed.fetch, sleep=lambda s: None,
                         resolve_name=lambda s: "NVIDIA Corporation")
    assert "%22NVIDIA%22" in feed.urls[0]


def test_run_pending_survit_a_une_resolution_de_nom_en_panne():
    store.save_portfolio("alice", {"cash_chf": 1.0, "positions": [
        {"symbol": "NVDA", "qty": 1}]})

    def _boom(symbol):
        raise RuntimeError("cours indisponible")

    feed = Feed()
    out = backfill.run_pending(now=NOW, fetch=feed.fetch, sleep=lambda s: None,
                               resolve_name=_boom)
    assert out["processed"] == 1 and "%22NVDA%22" in feed.urls[0]


def test_run_pending_compte_les_pannes_sans_les_propager():
    """« Pas sauté » ne veut pas dire « fait » : une source muette n'a rien
    rangé, donc le symbole n'est PAS traité — et il reste en tête de file."""
    _anchor()
    feed = Feed(broken={0, 1, 2, 3})
    out = backfill.run_pending(now=NOW, fetch=feed.fetch, sleep=lambda s: None,
                               resolve_name=lambda s: "")
    assert out["errors"] == 4 and out["processed"] == 0
    assert out["symbols"] == []
    assert [a["symbol"] for a in backfill.pending_backfills(NOW)] == ["NVDA"]


# =========================================================================== #
#  PUR — mise en forme du dossier
# =========================================================================== #

def test_le_dossier_est_une_ligne_par_repere():
    state = _state_with(windows=[_win("2025-08-27", "2025-11-26", [
        _it("2025-09-12T10:00:00", "Nvidia beats estimates", "pos")])])
    assert backfill.digest_for(["NVDA"], state=state) == {
        "NVDA": ["2025-09 Nvidia beats estimates (pos)"]}


def test_le_dossier_se_lit_du_plus_ancien_au_plus_recent():
    state = _state_with(windows=[_win("a", "b", [
        _it("2026-05-01T10:00:00", "récent", "pos"),
        _it("2025-09-01T10:00:00", "ancien", "neg")])])
    lines = backfill.digest_for(["NVDA"], state=state)["NVDA"]
    assert lines == ["2025-09 ancien (neg)", "2026-05 récent (pos)"]


def test_le_dossier_s_etale_sur_les_quatre_trimestres():
    """Six lignes toutes tirées du dernier trimestre ne seraient pas une base,
    juste de l'actualité un peu moins fraîche."""
    windows = [_win("w%d" % q, "w%d" % (q + 1),
                    [_it("202%d-0%d-0%dT10:00:00" % (5 + q // 3, 1 + q, i + 1),
                         "T%d-%d" % (q, i), "pos")
                     for i in range(5)])
               for q in range(4)]
    lines = backfill.digest_for(["NVDA"], limit_per=4,
                                state=_state_with(windows=windows))["NVDA"]
    assert len(lines) == 4
    # un repère venu de CHAQUE trimestre
    assert sorted(line.split()[1].split("-")[0] for line in lines) == \
        ["T0", "T1", "T2", "T3"]


def test_les_titres_classes_passent_avant_les_neutres():
    """Avec six lignes, dépenser le budget en titres neutres reviendrait à ne
    rien dire."""
    state = _state_with(windows=[_win("a", "b", [
        _it("2026-01-05T10:00:00", "neutre récent"),
        _it("2026-01-04T10:00:00", "neutre récent 2"),
        _it("2025-12-01T10:00:00", "classé ancien", "neg")])])
    lines = backfill.digest_for(["NVDA"], limit_per=2, state=state)["NVDA"]
    assert "classé ancien" in lines[0]
    assert len(lines) == 2


def test_un_symbole_sans_dossier_est_ABSENT_du_retour():
    """Le consommateur doit distinguer « rien collecté » de « rien trouvé »."""
    assert backfill.digest_for(["AAPL"], state=_state_with()) == {}


def test_le_dossier_est_insensible_a_la_casse_et_dedoublonne():
    state = _state_with(windows=[_win("a", "b", [
        _it("2026-01-05T10:00:00", "x", "pos")])])
    assert list(backfill.digest_for(["nvda", "NVDA"], state=state)) == ["NVDA"]


def test_un_titre_tres_long_est_borne():
    state = _state_with(windows=[_win("a", "b", [
        _it("2026-01-05T10:00:00", "mot " * 80, "pos")])])
    line = backfill.digest_for(["NVDA"], state=state)["NVDA"][0]
    assert len(line) < backfill.MAX_TITLE_LINE + 30 and line.endswith("(pos)")


@pytest.mark.parametrize("bad", [None, "pas un dict", {"symbols": "cassé"}])
def test_la_mise_en_forme_tolere_un_etat_deforme(bad):
    assert backfill.digest_for(["NVDA"], state=bad) == {}


def test_digest_for_lit_l_etat_du_disque_par_defaut():
    backfill.save_state(_state_with(windows=[_win("a", "b", [
        _it("2026-01-05T10:00:00", "x", "pos")])]))
    assert backfill.digest_for(["NVDA"]) == {"NVDA": ["2026-01 x (pos)"]}


def test_digest_for_anchors_sert_toutes_les_ancres():
    _anchor()
    backfill.save_state(_state_with(windows=[_win("a", "b", [
        _it("2026-01-05T10:00:00", "x", "pos")])]))
    assert backfill.digest_for_anchors() == {"NVDA": ["2026-01 x (pos)"]}


def test_entry_for_rend_le_dossier_brut():
    backfill.save_state(_state_with(windows=[_win("a", "b", [])]))
    assert backfill.entry_for("nvda")["name"] == "NVIDIA"
    assert backfill.entry_for("INCONNU") == {}
    assert backfill.entry_for("../x") == {}


# =========================================================================== #
#  Injections — le contexte du coach et le fait-pack de la revue
# =========================================================================== #

@pytest.fixture
def _quiet_context(monkeypatch):
    """Les sources voisines du contexte, éteintes : ce test-ci ne mesure QUE
    l'arrivée de l'historique."""
    for name in ("_recent_news", "_recent_filings", "_recent_crypto",
                 "_whale_moves", "_open_radar_hypotheses"):
        monkeypatch.setattr(pr, name, lambda *a, **k: [])


def test_l_historique_arrive_dans_le_contexte_de_strategie(_quiet_context):
    store.save_portfolio("tester", {"cash_chf": 1.0, "positions": [
        {"symbol": "NVDA", "qty": 1}]})
    backfill.save_state(_state_with(windows=[_win("a", "b", [
        _it("2026-01-05T10:00:00", "Nvidia beats estimates", "pos")])]))

    context = pr._strategy_context("tester")
    assert context["historique"] == {
        "NVDA": ["2026-01 Nvidia beats estimates (pos)"]}


def test_le_contexte_de_strategie_couvre_AUSSI_la_watchlist(_quiet_context):
    store.save_portfolio("tester", {"cash_chf": 1.0, "positions": []})
    store.save_watchlist("tester", [{"symbol": "NVDA", "name": "NVIDIA"}])
    backfill.save_state(_state_with(windows=[_win("a", "b", [
        _it("2026-01-05T10:00:00", "x", "pos")])]))
    assert "NVDA" in pr._strategy_context("tester")["historique"]


def test_l_historique_arrive_sur_chaque_position_de_la_revue(monkeypatch):
    monkeypatch.setattr(pr, "_recent_news", lambda username: [])
    monkeypatch.setattr(pr, "_whale_moves", lambda: [])
    monkeypatch.setattr(quotes, "get_quote",
                        lambda symbol: {"symbol": symbol, "price": 120.0,
                                        "name": "NVIDIA"})
    backfill.save_state(_state_with(windows=[_win("a", "b", [
        _it("2026-01-05T10:00:00", "Nvidia beats estimates", "pos")])]))

    portfolio = models.Portfolio.from_dict({"cash_chf": 1.0, "positions": [
        {"symbol": "NVDA", "qty": 1, "avg_price": 100.0}]})
    rows = pr._position_factpack("tester", portfolio)["positions"]
    assert rows[0]["historique"] == ["2026-01 Nvidia beats estimates (pos)"]


def test_une_position_sans_dossier_recoit_une_liste_vide(monkeypatch):
    monkeypatch.setattr(pr, "_recent_news", lambda username: [])
    monkeypatch.setattr(pr, "_whale_moves", lambda: [])
    monkeypatch.setattr(quotes, "get_quote",
                        lambda symbol: {"symbol": symbol, "price": 1.0})
    portfolio = models.Portfolio.from_dict({"cash_chf": 1.0, "positions": [
        {"symbol": "AAPL", "qty": 1, "avg_price": 1.0}]})
    rows = pr._position_factpack("tester", portfolio)["positions"]
    assert rows[0]["historique"] == []


def test_le_contexte_survit_a_un_module_absent(monkeypatch):
    def _absent():
        raise ImportError("pas déployé")
    monkeypatch.setattr(pr, "_backfill", _absent)
    assert pr._backfill_digest(["NVDA"]) == {}


def test_le_contexte_survit_a_un_etat_en_panne(monkeypatch):
    class _Broken(object):
        @staticmethod
        def digest_for(symbols, limit_per):
            raise RuntimeError("état illisible")
    monkeypatch.setattr(pr, "_backfill", lambda: _Broken)
    assert pr._backfill_digest(["NVDA"]) == {}


# =========================================================================== #
#  Injections — les prompts
# =========================================================================== #

_HISTORY_MARK = "HISTORIQUE (12 derniers mois, collecté d'archives"


@pytest.mark.parametrize("build", [
    lambda: llm.build_ideas_prompt({"historique": {"NVDA": ["2026-01 x (pos)"]}}),
    lambda: llm.build_scenarios_prompt({"historique": {"NVDA": ["2026-01 x (pos)"]}}),
    lambda: llm.build_review_prompt({"positions": [
        {"symbol": "NVDA", "historique": ["2026-01 x (pos)"]}]}),
])
def test_les_prompts_disent_quoi_faire_de_l_historique(build):
    prompt = build()
    assert _HISTORY_MARK in prompt
    # la donnée voyage dans le bloc de contexte déjà sérialisé
    assert "2026-01 x (pos)" in prompt


def test_le_prompt_interdit_de_conclure_d_une_absence():
    """Sans cette phrase, un titre jamais collecté se lirait « il ne s'est rien
    passé depuis un an » — le contresens exact qu'on cherche à éviter."""
    assert "n'en conclus RIEN" in llm.build_ideas_prompt({})


def test_le_prompt_du_radar_porte_l_historique():
    prompt = radar.build_prompt([], [], [], [], {}, NOW.isoformat(),
                                history={"NVDA": ["2026-01 x (pos)"]})
    assert "HISTORIQUE (12 derniers mois" in prompt
    assert "· 2026-01 x (pos)" in prompt


def test_le_prompt_du_radar_le_dit_quand_il_n_y_a_pas_de_dossier():
    prompt = radar.build_prompt([], [], [], [], {}, NOW.isoformat())
    assert "aucun dossier historique collecté" in prompt


# =========================================================================== #
#  Radar — branchement best-effort
# =========================================================================== #

@pytest.mark.real_backfill
def test_le_radar_avance_la_file_a_la_fin_du_run(monkeypatch):
    calls = []
    monkeypatch.setattr(backfill, "run_pending",
                        lambda **kwargs: calls.append(kwargs) or {"processed": 1})
    assert radar._fill_history() == {"processed": 1}
    assert calls == [{"max_symbols": 1}]


@pytest.mark.real_backfill
def test_une_collecte_en_panne_ne_casse_pas_le_radar(monkeypatch):
    def _boom(**kwargs):
        raise RuntimeError("réseau coupé")
    monkeypatch.setattr(backfill, "run_pending", _boom)
    assert radar._fill_history() == {}


def test_un_historique_illisible_ne_casse_pas_le_prompt(monkeypatch):
    def _boom(*a, **k):
        raise RuntimeError("état illisible")
    monkeypatch.setattr(backfill, "digest_for_anchors", _boom)
    assert radar._collect_history() == {}


# =========================================================================== #
#  Endpoints
# =========================================================================== #

def test_les_endpoints_sont_refuses_au_role_player():
    c = make_client(role="player")
    assert c.post("/api/paper/backfill/run", json={}).status_code == 403
    assert c.get("/api/paper/backfill").status_code == 403


def test_le_role_trader_peut_lancer_la_collecte(monkeypatch):
    c = make_client(role="trader")
    monkeypatch.setattr(backfill, "run_pending",
                        lambda **kwargs: {"processed": 1, "skipped": 0,
                                          "items": 3, "errors": 0,
                                          "symbols": ["NVDA"]})
    response = c.post("/api/paper/backfill/run", json={})
    assert response.status_code == 200
    assert response.json()["symbols"] == ["NVDA"]


def test_la_collecte_sans_corps_marche_aussi(monkeypatch):
    c = make_client()
    monkeypatch.setattr(backfill, "run_pending",
                        lambda **kwargs: {"processed": 0, "skipped": 0,
                                          "items": 0, "errors": 0, "symbols": []})
    assert c.post("/api/paper/backfill/run").status_code == 200


def test_un_symbole_demande_est_refait_meme_s_il_est_frais(monkeypatch):
    c = make_client()
    seen = {}

    def _one(symbol, name=None, **kwargs):
        seen.update({"symbol": symbol, "force": kwargs.get("force")})
        return {"symbol": symbol, "skipped": False, "items": 5, "errors": 0}

    monkeypatch.setattr(backfill, "backfill_symbol", _one)
    body = c.post("/api/paper/backfill/run", json={"symbol": "nvda"}).json()
    assert seen == {"symbol": "NVDA", "force": True}
    assert body == {"processed": 1, "skipped": 0, "items": 5, "errors": 0,
                    "symbols": ["NVDA"]}


def test_la_lecture_rend_le_dossier_d_un_titre():
    c = make_client()
    backfill.save_state(_state_with(windows=[_win("a", "b", [
        _it("2026-01-05T10:00:00", "x", "pos")])]))
    body = c.get("/api/paper/backfill?symbol=NVDA").json()
    assert body["symbol"] == "NVDA"
    assert body["entry"]["windows"][0]["items"][0]["title"] == "x"


def test_un_titre_jamais_collecte_rend_un_dossier_VIDE_en_200():
    c = make_client()
    response = c.get("/api/paper/backfill?symbol=AAPL")
    assert response.status_code == 200
    assert response.json() == {"symbol": "AAPL", "entry": {}}


def test_la_lecture_sans_symbole_rend_l_index():
    c = make_client()
    backfill.save_state(_state_with(windows=[_win("a", "b", [])]))
    assert c.get("/api/paper/backfill").json() == {"symbols": [
        {"symbol": "NVDA", "name": "NVIDIA",
         "fetched_at": NOW.isoformat(), "windows": 1}]}


def test_un_module_absent_est_une_erreur_au_lancement_mais_pas_a_la_lecture(monkeypatch):
    c = make_client()

    def _absent():
        raise ImportError("pas déployé")
    monkeypatch.setattr(pr, "_backfill", _absent)

    assert c.post("/api/paper/backfill/run", json={}).status_code == 503
    assert c.get("/api/paper/backfill").json() == {"symbols": []}


# =========================================================================== #
#  Balayage FRAIS à la demande (26/08) — « chercher plus profondément au-delà »
#
#  Le dossier historique dit ce que l'année a raconté ; il ne dit pas ce qui est
#  tombé depuis le dernier cycle de veille. C'est ce que cette porte va chercher,
#  au clic, en UNE requête.
# =========================================================================== #

def test_la_fenetre_du_balayage_couvre_bien_les_sept_derniers_jours():
    window = backfill.recent_window(now=NOW)
    assert window["from"] == (NOW.date() - timedelta(days=7)).isoformat()
    # ``before:`` est une borne de JOURNÉE exclusive côté Google News : s'arrêter
    # à aujourd'hui écarterait les titres du jour, ceux qu'on vient chercher.
    assert window["to"] == (NOW.date() + timedelta(days=1)).isoformat()


def test_le_balayage_rend_les_titres_recents_du_plus_frais_au_plus_vieux():
    xml = _rss([_item("NVIDIA beats estimates", NOW - timedelta(days=1)),
                _item("NVIDIA ouvre un centre de recherche", NOW - timedelta(days=5))])
    rows = backfill.sweep_recent("NVIDIA Corporation", now=NOW,
                                 fetch=lambda url: xml)
    assert [row["title"] for row in rows] == ["NVIDIA beats estimates",
                                              "NVIDIA ouvre un centre de recherche"]
    assert [row["sentiment"] for row in rows] == ["pos", "neutre"]


def test_le_balayage_interroge_le_NOM_sans_sa_forme_juridique():
    seen = []

    def _fetch(url):
        seen.append(url)
        return _rss([])

    backfill.sweep_recent("NVIDIA Corporation", now=NOW, fetch=_fetch)
    assert len(seen) == 1                      # UNE requête, pas quatre
    assert "NVIDIA" in seen[0] and "Corporation" not in seen[0]
    assert "after%3A" in seen[0] and "before%3A" in seen[0]


def test_le_balayage_ecarte_les_conseils_comme_les_archives():
    """Doctrine Market Pulse (piège #67d) : un conseil recopié se lirait comme
    l'avis DU COACH — la porte fraîche ne le rouvre pas."""
    xml = _rss([_item("3 top stocks to buy now", NOW - timedelta(days=1)),
                _item("NVIDIA beats estimates", NOW - timedelta(days=2))])
    rows = backfill.sweep_recent("NVIDIA", now=NOW, fetch=lambda url: xml)
    assert [row["title"] for row in rows] == ["NVIDIA beats estimates"]


def test_le_balayage_est_borne_en_nombre_de_titres():
    xml = _rss([_item("Titre %02d" % i, NOW - timedelta(hours=i))
                for i in range(20)])
    rows = backfill.sweep_recent("NVIDIA", now=NOW, fetch=lambda url: xml)
    assert len(rows) == backfill.SWEEP_ITEMS == 5
    assert rows[0]["title"] == "Titre 00"      # le plus récent


def test_le_balayage_n_ECRIT_rien():
    """Une consultation n'est pas une collecte : laisser le balayage toucher
    l'état écraserait douze mois d'archives par une semaine."""
    backfill.save_state(_state_with("NVDA"))
    before = json.dumps(backfill.load_state(), sort_keys=True)

    backfill.sweep_recent("NVIDIA", now=NOW,
                          fetch=lambda url: _rss([_item("Neuf", NOW)]))

    assert json.dumps(backfill.load_state(), sort_keys=True) == before


def test_un_nom_vide_ne_declenche_aucune_requete():
    """Sans nom, la requête ramènerait la une du jour — on préfère ne rien
    demander (même prudence que ``search_url``)."""
    def _boom(url):
        raise AssertionError("aucune requête ne devrait partir")

    assert backfill.sweep_recent("", now=NOW, fetch=_boom) == []
    assert backfill.sweep_recent(None, now=NOW, fetch=_boom) == []


def test_une_panne_du_balayage_est_PROPAGEE_a_l_appelant():
    """Contrairement au reste du module : seul l'appelant sait s'il vaut mieux
    se passer de ce symbole ou de tout le balayage — et un ``[]`` muet lui
    ferait confondre « rien de neuf » avec « source injoignable »."""
    def _boom(url):
        raise RuntimeError("Google News injoignable")

    with pytest.raises(RuntimeError):
        backfill.sweep_recent("NVIDIA", now=NOW, fetch=_boom)
