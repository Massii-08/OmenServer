"""Tests du lot « Grands portefeuilles » (13F SEC) — 100 % HORS LIGNE.

Aucun appel réseau, aucune horloge réelle, aucun ``time.sleep`` : le client
HTTP, le sleep de pacing, l'horloge et le notifieur Telegram sont injectés.
Les fixtures XML/JSON reproduisent la forme RÉELLE mesurée sur EDGAR le 24/08
(infotable au nom arbitraire, émetteur dédoublé, amendement 13F-HR/A).
"""
import json
import os
from datetime import datetime, timedelta

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.auth.utils import get_current_user
from backend.bots import whales_router as wr
from backend.bots.paper import whales as w


# =========================================================================== #
#  Faux client HTTP + fabriques de fixtures
# =========================================================================== #

class FakeResp(object):
    def __init__(self, status_code=200, text="", payload=None):
        self.status_code = status_code
        self.text = text
        self._payload = payload

    def json(self):
        if self._payload is None:
            return json.loads(self.text)
        return self._payload


class FakeClient(object):
    """Table URL -> réponse. Une valeur ``Exception`` est LEVÉE (panne réseau)."""

    def __init__(self, routes=None):
        self.routes = dict(routes or {})
        self.calls = []
        self.headers_seen = []

    def get(self, url, headers=None, timeout=None):
        self.calls.append(url)
        self.headers_seen.append(headers or {})
        if url not in self.routes:
            return FakeResp(404, "not found")
        value = self.routes[url]
        if isinstance(value, Exception):
            raise value
        if isinstance(value, FakeResp):
            return value
        if isinstance(value, dict):
            return FakeResp(200, json.dumps(value), payload=value)
        return FakeResp(200, value)


class Recorder(object):
    """Faux ``sleep`` : enregistre au lieu d'attendre."""

    def __init__(self):
        self.calls = []

    def __call__(self, seconds):
        self.calls.append(seconds)


NS = "http://www.sec.gov/edgar/document/thirteenf/informationtable"
PRIMARY_NS = "http://www.sec.gov/edgar/thirteenffiler"

CIK = "0001067983"
ACC_Q2 = "0001193125-26-352200"
ACC_Q1 = "0001193125-26-226661"

SUBM_URL = "https://data.sec.gov/submissions/CIK0001067983.json"


def _dir_url(accession):
    return ("https://www.sec.gov/Archives/edgar/data/1067983/%s/"
            % accession.replace("-", ""))


def _file_url(accession, name):
    return _dir_url(accession) + name


def info_xml(rows):
    """Infotable réaliste : namespace par DÉFAUT, shrsOrPrnAmt imbriqué."""
    body = "".join(
        "<infoTable>"
        "<nameOfIssuer>%s</nameOfIssuer>"
        "<titleOfClass>%s</titleOfClass>"
        "<cusip>%s</cusip>"
        "<value>%s</value>"
        "<shrsOrPrnAmt><sshPrnamt>%s</sshPrnamt>"
        "<sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt>"
        "<investmentDiscretion>DFND</investmentDiscretion>"
        "<votingAuthority><Sole>%s</Sole><Shared>0</Shared>"
        "<None>0</None></votingAuthority>"
        "</infoTable>" % (name, cls, cusip, value, shares, shares)
        for (name, cls, cusip, value, shares) in rows)
    return '<informationTable xmlns="%s">%s</informationTable>' % (NS, body)


def primary_xml(period="06-30-2026"):
    return ('<edgarSubmission xmlns="%s"><headerData><filerInfo>'
            '<periodOfReport>%s</periodOfReport>'
            '</filerInfo></headerData></edgarSubmission>' % (PRIMARY_NS, period))


def listing_html(accession, names):
    """Listing du dossier d'archive (liens en chemin absolu, comme EDGAR)."""
    path = "/Archives/edgar/data/1067983/%s/" % accession.replace("-", "")
    return "<html><body>%s</body></html>" % "".join(
        '<a href="%s%s">%s</a>' % (path, n, n) for n in names)


def submissions(name="BERKSHIRE HATHAWAY INC", filings=()):
    """filings = [(form, accession, filingDate, reportDate)]"""
    return {
        "name": name,
        "cik": "1067983",
        "filings": {"recent": {
            "form": [f[0] for f in filings],
            "accessionNumber": [f[1] for f in filings],
            "filingDate": [f[2] for f in filings],
            "reportDate": [f[3] for f in filings],
        }},
    }


# Deux trimestres : Q2 renforce Apple (+25 %), allège Coca-Cola (-20 %), sort de
# Kroger, entre sur Nvidia — et fait osciller Ally de +0,49 % (= du bruit, doit
# être ignoré). Les chiffres Ally sont ceux RÉELLEMENT mesurés sur le dépôt.
Q2_ROWS = [
    ("ALLY FINL INC", "COM", "02005N100", 300000000, 6000000),
    ("ALLY FINL INC", "COM", "02005N100", 277211815, 6561737),   # 2e ligne (dédoublée)
    ("APPLE INC", "COM", "037833100", 900000000, 5000000),
    ("COCA COLA CO", "COM", "191216100", 500000000, 8000000),
    ("NVIDIA CORP", "COM", "67066G104", 400000000, 2000000),
]
Q1_ROWS = [
    ("ALLY FINL INC", "COM", "02005N100", 560000000, 12500000),
    ("APPLE INC", "COM", "037833100", 700000000, 4000000),
    ("COCA COLA CO", "COM", "191216100", 620000000, 10000000),
    ("KROGER CO", "COM", "501044101", 100000000, 1500000),
]


@pytest.fixture(autouse=True)
def _isolated_data_dir(tmp_path, monkeypatch):
    """Cache et état du guetteur en tmp — jamais le vrai ``data/``.

    ``store.DATA_DIR`` est isolé EN PLUS depuis les volets W2b : celui des
    titres de l'utilisateur LIT les portefeuilles, watchlists et tableaux de
    bord pour trouver ses ancres, et les deux ÉCRIVENT dans la mémoire de la
    veille — qui vit sous ce même dossier. Sans cette ligne, un test « hors
    ligne » irait lire et écrire dans le vrai ``data/paper_trading`` de la
    machine (mesuré : c'est exactement ce qui est arrivé au premier passage).
    """
    from backend.bots.paper import store
    monkeypatch.setattr(w, "DATA_DIR", tmp_path / "paper_trading")
    monkeypatch.setattr(store, "DATA_DIR", tmp_path / "paper_trading")
    return tmp_path


# Capturé AVANT toute fixture : ``_no_side_channels`` le remplace pour éteindre
# le réchauffement du cache par défaut, et ses propres tests ont besoin du vrai.
_REAL_WARM_CACHE = w._warm_cache


@pytest.fixture(autouse=True)
def _no_side_channels(monkeypatch):
    """Depuis le 26/08, ``check_new_filings`` fait trois choses de plus APRÈS sa
    ronde : réchauffer le cache des portefeuilles (requêtes SEC), consulter la
    convergence (qui appellerait le VRAI CLI Claude le jour où des facteurs
    s'alignent) et relever l'agenda des banques centrales (cinq sites web).
    Les trois sont neutralisés par défaut ici ; les tests qui les visent
    réinstallent leur propre doublure.

    ⚠️ L'agenda est éteint AU NIVEAU DU PONT (``agenda_bridge``) et non de
    ``whales._upcoming_agenda`` : cette dernière porte la garde best-effort et
    l'aiguillage vers le paramètre injecté ``agenda=`` — la doubler ferait
    passer les tests d'agenda À CÔTÉ du code qu'ils croient exercer.
    """
    monkeypatch.setattr(w, "_warm_cache",
                        lambda ids, cache, stamp, client, sleep, counters: None)
    from backend.bots.paper import convergence
    monkeypatch.setattr(convergence, "maybe_fire",
                        lambda **kwargs: {"fired": False, "sent": False})
    from backend.bots.paper import agenda_bridge
    monkeypatch.setattr(agenda_bridge, "upcoming_events", lambda **kwargs: [])


def counters(**overrides):
    """Le dictionnaire de compteurs ATTENDU, avec ses défauts.

    Écrit une fois : chaque volet ajouté à ``check_new_filings`` en ajoute un,
    et une douzaine d'égalités littérales réparties dans le fichier finiraient
    par diverger de la vérité au premier oubli.
    """
    base = {"managers": 0, "new_filings": 0, "notified": 0, "errors": 0,
            "convergence_fired": False, "own_checked": 0, "own_filings": 0,
            "own_non_us": 0, "agenda_events": 0}
    base.update(overrides)
    return base


def full_routes():
    """Le parcours complet d'un gérant : submissions + 2 dossiers d'archive."""
    return {
        SUBM_URL: submissions(filings=[
            ("13F-HR", ACC_Q2, "2026-08-14", "2026-06-30"),
            ("13F-HR", ACC_Q1, "2026-05-15", "2026-03-31"),
            ("8-K", "0000000000-26-000001", "2026-04-01", ""),
        ]),
        _dir_url(ACC_Q2): listing_html(ACC_Q2, ["56757.xml", "primary_doc.xml"]),
        _file_url(ACC_Q2, "56757.xml"): info_xml(Q2_ROWS),
        _file_url(ACC_Q2, "primary_doc.xml"): primary_xml("06-30-2026"),
        _dir_url(ACC_Q1): listing_html(ACC_Q1, ["42.xml", "primary_doc.xml"]),
        _file_url(ACC_Q1, "42.xml"): info_xml(Q1_ROWS),
        _file_url(ACC_Q1, "primary_doc.xml"): primary_xml("03-31-2026"),
    }


BERKSHIRE = {"id": "berkshire", "label": "Warren Buffett — Berkshire Hathaway",
             "cik": CIK, "expect": "berkshire"}


# =========================================================================== #
#  PUR — parse_infotable / aggregate
# =========================================================================== #

def test_parse_infotable_reads_realistic_rows():
    rows = w.parse_infotable(info_xml(Q2_ROWS))
    assert len(rows) == 5                       # les 2 lignes Ally sont conservées
    first = rows[0]
    assert first["name"] == "ALLY FINL INC"
    assert first["cusip"] == "02005N100"
    assert first["class"] == "COM"
    assert first["value_usd"] == 300000000      # DOLLARS, pas milliers
    assert first["shares"] == 6000000
    assert first["share_type"] == "SH"


def test_aggregate_merges_the_duplicated_issuer():
    """Le piège central : un même émetteur sur PLUSIEURS lignes."""
    agg = w.aggregate(w.parse_infotable(info_xml(Q2_ROWS)))
    assert len(agg) == 4                        # 5 lignes -> 4 positions
    ally = [e for e in agg if e["cusip"] == "02005N100"][0]
    assert ally["value_usd"] == 577211815       # 300M + 277,2M
    assert ally["shares"] == 12561737           # 6 000 000 + 6 561 737
    assert ally["lines"] == 2
    assert ally["name"] == "ALLY FINL INC"


def test_aggregate_sorts_by_value_desc():
    agg = w.aggregate(w.parse_infotable(info_xml(Q2_ROWS)))
    assert [e["cusip"] for e in agg] == [
        "037833100", "02005N100", "191216100", "67066G104"]


def test_parse_infotable_on_garbage_returns_empty_list():
    assert w.parse_infotable("<not xml") == []
    assert w.parse_infotable("") == []
    assert w.parse_infotable("<html><body>404</body></html>") == []


def test_parse_infotable_skips_rows_without_cusip_or_value():
    xml = ('<informationTable xmlns="%s">'
           '<infoTable><nameOfIssuer>SANS CUSIP</nameOfIssuer>'
           '<value>10</value></infoTable>'
           '<infoTable><nameOfIssuer>SANS VALEUR</nameOfIssuer>'
           '<cusip>111111111</cusip></infoTable>'
           '<infoTable><nameOfIssuer>BON</nameOfIssuer>'
           '<cusip>222222222</cusip><value>5</value></infoTable>'
           '</informationTable>' % NS)
    rows = w.parse_infotable(xml)
    assert [r["cusip"] for r in rows] == ["222222222"]
    assert rows[0]["shares"] == 0               # pas de sshPrnamt -> 0, pas de crash


def test_parse_infotable_tolerates_another_namespace():
    """La décision se prend sur le NOM LOCAL, pas sur une URI figée."""
    xml = info_xml(Q1_ROWS).replace(NS, "http://example.test/whatever")
    assert len(w.parse_infotable(xml)) == 4   # Q1 = 4 lignes


# =========================================================================== #
#  PUR — diff_quarters
# =========================================================================== #

def _agg(rows):
    return w.aggregate(w.parse_infotable(info_xml(rows)))


def test_diff_flags_new_exit_increase_and_decrease():
    diff = w.diff_quarters(_agg(Q2_ROWS), _agg(Q1_ROWS))
    assert [e["cusip"] for e in diff["new"]] == ["67066G104"]        # Nvidia entre
    assert [e["cusip"] for e in diff["exits"]] == ["501044101"]      # Kroger sort
    assert [e["cusip"] for e in diff["increased"]] == ["037833100"]  # Apple +25 %
    assert diff["increased"][0]["delta_pct"] == 25.0
    assert diff["increased"][0]["prev_shares"] == 4000000
    assert [e["cusip"] for e in diff["decreased"]] == ["191216100"]  # Coca -20 %
    assert diff["decreased"][0]["delta_pct"] == -20.0
    # Ally passe de 12 500 000 à 12 561 737 actions = +0,49 % : c'est du bruit
    # de gestion, il ne doit apparaître dans AUCUN mouvement.
    moved = {e["cusip"] for lst in diff.values() for e in lst}
    assert "02005N100" not in moved


def test_moves_carry_the_share_class_to_separate_two_classes():
    """Cas MESURÉ chez Berkshire : « ALPHABET INC » sort DEUX fois du diff
    (Class A et Class C, CUSIP distincts). Sans la classe, l'écran afficherait
    deux lignes au nom identique — ça se lirait comme un doublon."""
    prev = [("ALPHABET INC", "CAP STK CL A", "02079K305", 100, 1000),
            ("ALPHABET INC", "CAP STK CL C", "02079K107", 100, 1000)]
    cur = [("ALPHABET INC", "CAP STK CL A", "02079K305", 800, 7580),   # +658 %
           ("ALPHABET INC", "CAP STK CL C", "02079K107", 150, 1452)]   # +45 %
    diff = w.diff_quarters(_agg(cur), _agg(prev))
    assert len(diff["increased"]) == 2               # deux titres, pas un doublon
    assert {e["class"] for e in diff["increased"]} == {
        "CAP STK CL A", "CAP STK CL C"}
    # la classe voyage aussi sur les entrées et les sorties
    assert w.diff_quarters(_agg(cur), [])["new"][0]["class"].startswith("CAP STK")
    assert w.diff_quarters([], _agg(prev))["exits"][0]["class"].startswith("CAP STK")


def test_diff_ignores_a_two_percent_wobble():
    """±2 % = bruit de gestion, pas un mouvement : rien ne doit sortir."""
    prev = [("APPLE INC", "COM", "037833100", 700000000, 1000000)]
    cur = [("APPLE INC", "COM", "037833100", 900000000, 1020000)]   # +2 %
    diff = w.diff_quarters(_agg(cur), _agg(prev))
    assert diff["increased"] == [] and diff["decreased"] == []
    assert diff["new"] == [] and diff["exits"] == []


def test_diff_uses_shares_not_value():
    """Le prix bouge tout seul : une valeur doublée à quantité constante
    ne doit produire AUCUN mouvement."""
    prev = [("APPLE INC", "COM", "037833100", 500000000, 1000000)]
    cur = [("APPLE INC", "COM", "037833100", 1000000000, 1000000)]
    diff = w.diff_quarters(_agg(cur), _agg(prev))
    assert diff == {"new": [], "exits": [], "increased": [], "decreased": []}


def test_diff_survives_a_zero_share_previous_line():
    prev = [("APPLE INC", "COM", "037833100", 1, 0)]
    cur = [("APPLE INC", "COM", "037833100", 900000000, 5000000)]
    diff = w.diff_quarters(_agg(cur), _agg(prev))
    # aucun pourcentage n'est calculable -> on n'invente pas de "+infini"
    assert diff["increased"] == [] and diff["new"] == [] and diff["exits"] == []


def test_diff_against_empty_previous_marks_everything_new():
    diff = w.diff_quarters(_agg(Q2_ROWS), [])
    assert len(diff["new"]) == 4 and diff["exits"] == []


def test_diff_sorts_moves_by_amplitude():
    prev = [("A", "COM", "111111111", 10, 1000),
            ("B", "COM", "222222222", 10, 1000),
            ("C", "COM", "333333333", 10, 1000)]
    cur = [("A", "COM", "111111111", 10, 1100),      # +10 %
           ("B", "COM", "222222222", 10, 2000),      # +100 %
           ("C", "COM", "333333333", 10, 400)]       # -60 %
    diff = w.diff_quarters(_agg(cur), _agg(prev))
    assert [e["cusip"] for e in diff["increased"]] == ["222222222", "111111111"]
    assert diff["decreased"][0]["delta_pct"] == -60.0


# =========================================================================== #
#  PUR — summarize / quarter_label
# =========================================================================== #

def test_summarize_computes_pct_and_concentration():
    agg = _agg(Q2_ROWS)
    diff = w.diff_quarters(agg, _agg(Q1_ROWS))
    out = w.summarize(agg, diff, "2026-06-30", "2026-03-31")
    assert out["quarter"] == "2026-06-30"
    assert out["quarter_label"] == "T2 2026"
    assert out["prev_quarter_label"] == "T1 2026"
    assert out["n_positions"] == 4
    assert out["total_value_usd"] == (900000000 + 577211815
                                      + 500000000 + 400000000)
    assert out["top"][0]["name"] == "APPLE INC"
    assert out["top"][0]["pct"] == pytest.approx(37.86, abs=0.5)
    assert sum(e["pct"] for e in out["top"]) == pytest.approx(100.0, abs=0.05)
    # 4 positions seulement -> le top 10 EST tout le portefeuille
    assert out["concentration_top10_pct"] == 100.0
    assert out["moves"] is diff


def test_summarize_caps_the_top_at_fifteen():
    rows = [("N%02d" % i, "COM", "%09d" % i, 1000 - i, 100) for i in range(30)]
    out = w.summarize(_agg(rows), {}, "2026-06-30", None)
    assert out["n_positions"] == 30
    assert len(out["top"]) == 15
    assert out["top"][0]["value_usd"] > out["top"][-1]["value_usd"]
    assert 0 < out["concentration_top10_pct"] < 100


def test_summarize_on_empty_portfolio_does_not_divide_by_zero():
    out = w.summarize([], {}, None, None)
    assert out["total_value_usd"] == 0
    assert out["concentration_top10_pct"] == 0.0
    assert out["top"] == [] and out["quarter_label"] == ""


@pytest.mark.parametrize("date,label", [
    ("2026-03-31", "T1 2026"), ("2026-06-30", "T2 2026"),
    ("2026-09-30", "T3 2026"), ("2025-12-31", "T4 2025"),
    ("", ""), ("n'importe quoi", "n'importe quoi"),
])
def test_quarter_label(date, label):
    assert w.quarter_label(date) == label


# =========================================================================== #
#  latest_13f_accessions
# =========================================================================== #

def test_latest_accessions_takes_two_distinct_quarters():
    subm = submissions(filings=[
        ("13F-HR", "acc-q2", "2026-08-14", "2026-06-30"),
        ("13F-HR", "acc-q1", "2026-05-15", "2026-03-31"),
        ("13F-HR", "acc-q4", "2026-02-17", "2025-12-31"),
    ])
    assert w.latest_13f_accessions(subm) == [
        ("acc-q2", "2026-06-30"), ("acc-q1", "2026-03-31")]


def test_a_more_recent_amendment_replaces_the_original():
    """Cas MESURÉ chez Berkshire : le 13F-HR/A du 2025-08-14 fait foi pour la
    période 2025-03-31, pas le 13F-HR du 2025-05-15."""
    subm = submissions(filings=[
        ("13F-HR", "acc-q2", "2025-08-14", "2025-06-30"),
        ("13F-HR/A", "acc-q1-amended", "2025-08-14", "2025-03-31"),
        ("13F-HR", "acc-q1-original", "2025-05-15", "2025-03-31"),
    ])
    assert w.latest_13f_accessions(subm) == [
        ("acc-q2", "2025-06-30"), ("acc-q1-amended", "2025-03-31")]


def test_an_older_amendment_does_not_win():
    subm = submissions(filings=[
        ("13F-HR", "acc-recent", "2026-05-15", "2026-03-31"),
        ("13F-HR/A", "acc-old-amendment", "2026-01-02", "2026-03-31"),
    ])
    assert w.latest_13f_accessions(subm) == [("acc-recent", "2026-03-31")]


def test_latest_accessions_ignores_other_forms_and_empty_input():
    subm = submissions(filings=[
        ("8-K", "acc-8k", "2026-08-14", ""),
        ("10-Q", "acc-10q", "2026-08-01", "2026-06-30"),
        ("13F-NT", "acc-nt", "2026-08-01", "2026-06-30"),
        ("13F-HR", "acc-ok", "2026-08-14", "2026-06-30"),
    ])
    assert w.latest_13f_accessions(subm) == [("acc-ok", "2026-06-30")]
    assert w.latest_13f_accessions({}) == []
    assert w.latest_13f_accessions({"filings": {"recent": {}}}) == []


# =========================================================================== #
#  fetch_submissions / fetch_infotable
# =========================================================================== #

def test_fetch_submissions_sends_the_mandatory_user_agent():
    client = FakeClient({SUBM_URL: submissions()})
    data = w.fetch_submissions(CIK, client=client)
    assert data["name"] == "BERKSHIRE HATHAWAY INC"
    assert client.calls == [SUBM_URL]           # CIK zéro-paddé sur 10
    assert client.headers_seen[0]["User-Agent"] == w.SEC_USER_AGENT


def test_fetch_submissions_raises_on_http_error_without_leaking_the_url():
    client = FakeClient({SUBM_URL: FakeResp(403, "forbidden")})
    with pytest.raises(w.WhaleError) as excinfo:
        w.fetch_submissions(CIK, client=client)
    assert "data.sec.gov" in str(excinfo.value)
    assert "CIK0001067983" not in str(excinfo.value)


def test_fetch_submissions_turns_a_transport_failure_into_whale_error():
    client = FakeClient({SUBM_URL: RuntimeError("boom")})
    with pytest.raises(w.WhaleError):
        w.fetch_submissions(CIK, client=client)


def test_fetch_infotable_finds_the_arbitrarily_named_xml():
    client = FakeClient(full_routes())
    xml, period = w.fetch_infotable(CIK, ACC_Q2, client=client)
    assert "<informationTable" in xml
    assert len(w.parse_infotable(xml)) == 5   # les 5 lignes brutes du dépôt
    # le fichier utile ne s'appelle PAS infotable.xml
    assert any(c.endswith("56757.xml") for c in client.calls)


def test_fetch_infotable_when_primary_doc_is_tried_first_keeps_the_period():
    """Ordre inversé dans le listing : primary_doc testé d'abord -> on en tire
    periodOfReport, puis on continue jusqu'à la vraie infotable."""
    routes = full_routes()
    routes[_dir_url(ACC_Q2)] = listing_html(ACC_Q2, ["primary_doc.xml", "aa.xml"])
    routes[_file_url(ACC_Q2, "aa.xml")] = info_xml(Q2_ROWS)
    # 'aa.xml' passe avant primary_doc grâce au classement -> on force le cas en
    # ne laissant qu'un candidat non-infotable devant.
    routes[_dir_url(ACC_Q2)] = listing_html(ACC_Q2, ["decoy.xml", "aa.xml"])
    routes[_file_url(ACC_Q2, "decoy.xml")] = primary_xml("06-30-2026")
    client = FakeClient(routes)
    xml, period = w.fetch_infotable(CIK, ACC_Q2, client=client)
    assert "<informationTable" in xml
    assert period == "06-30-2026"


def test_fetch_infotable_skips_the_xsl_rendered_paths():
    routes = full_routes()
    html = ('<a href="/Archives/edgar/data/1067983/%s/xslForm13F_X02/primary_doc.xml">x</a>'
            '<a href="/Archives/edgar/data/1067983/%s/56757.xml">y</a>'
            % (ACC_Q2.replace("-", ""), ACC_Q2.replace("-", "")))
    routes[_dir_url(ACC_Q2)] = html
    client = FakeClient(routes)
    xml, _ = w.fetch_infotable(CIK, ACC_Q2, client=client)
    assert "<informationTable" in xml
    assert not any("xsl" in c for c in client.calls)


def test_fetch_infotable_raises_when_no_infotable_is_there():
    routes = full_routes()
    routes[_dir_url(ACC_Q2)] = listing_html(ACC_Q2, ["primary_doc.xml"])
    client = FakeClient(routes)
    with pytest.raises(w.WhaleError):
        w.fetch_infotable(CIK, ACC_Q2, client=client)


def test_fetch_infotable_stops_after_three_candidates():
    routes = full_routes()
    names = ["a.xml", "b.xml", "c.xml", "d.xml"]
    routes[_dir_url(ACC_Q2)] = listing_html(ACC_Q2, names)
    for name in names:
        routes[_file_url(ACC_Q2, name)] = "<other/>"
    routes[_file_url(ACC_Q2, "d.xml")] = info_xml(Q2_ROWS)   # jamais atteint
    client = FakeClient(routes)
    with pytest.raises(w.WhaleError):
        w.fetch_infotable(CIK, ACC_Q2, client=client)
    assert len([c for c in client.calls if c.endswith(".xml")]) == 3


def test_pacing_sleeps_one_second_between_requests_but_not_before_the_first():
    client = FakeClient(full_routes())
    sleeps = Recorder()
    w.manager_snapshot(BERKSHIRE, client=client, sleep=sleeps)
    # 1 submissions + 2 x (listing + 1 infotable) = 5 requêtes -> 4 attentes
    assert len(client.calls) == 5
    assert sleeps.calls == [w.PACE_S] * 4


# =========================================================================== #
#  manager_snapshot
# =========================================================================== #

def test_manager_snapshot_happy_path():
    client = FakeClient(full_routes())
    snap = w.manager_snapshot(BERKSHIRE, client=client, sleep=Recorder())
    assert snap["status"] == "ok"
    assert snap["id"] == "berkshire"
    assert snap["sec_name"] == "BERKSHIRE HATHAWAY INC"
    assert snap["quarter"] == "2026-06-30"
    assert snap["prev_quarter"] == "2026-03-31"
    assert snap["quarter_label"] == "T2 2026"
    assert snap["n_positions"] == 4
    assert snap["has_previous"] is True
    assert snap["accession"] == ACC_Q2
    assert [e["cusip"] for e in snap["moves"]["new"]] == ["67066G104"]
    assert [e["cusip"] for e in snap["moves"]["exits"]] == ["501044101"]
    assert snap["top"][0]["name"] == "APPLE INC"


def test_manager_snapshot_refuses_a_wrong_name_and_serves_no_data():
    """Anti-mauvais-nom : le CIK pointe sur une autre société -> AUCUNE donnée
    ne sort sous le nom du gérant attendu."""
    routes = full_routes()
    routes[SUBM_URL] = submissions(name="ICBC BANK OF CHINA", filings=[
        ("13F-HR", ACC_Q2, "2026-08-14", "2026-06-30")])
    client = FakeClient(routes)
    snap = w.manager_snapshot(BERKSHIRE, client=client, sleep=Recorder())
    assert snap["status"] == "unverified"
    assert snap["sec_name"] == "ICBC BANK OF CHINA"
    assert snap["expected"] == "berkshire"
    for forbidden in ("top", "moves", "total_value_usd", "n_positions"):
        assert forbidden not in snap
    # et surtout : on n'est même pas allé chercher le portefeuille
    assert client.calls == [SUBM_URL]


def test_manager_snapshot_name_match_is_case_insensitive():
    routes = full_routes()
    routes[SUBM_URL] = submissions(name="berkshire hathaway inc", filings=[
        ("13F-HR", ACC_Q2, "2026-08-14", "2026-06-30")])
    snap = w.manager_snapshot(BERKSHIRE, client=FakeClient(routes),
                              sleep=Recorder())
    assert snap["status"] == "ok"


def test_manager_snapshot_on_network_error_returns_a_short_detail():
    client = FakeClient({SUBM_URL: RuntimeError("connection reset by peer")})
    snap = w.manager_snapshot(BERKSHIRE, client=client, sleep=Recorder())
    assert snap["status"] == "error"
    assert snap["id"] == "berkshire"
    assert 0 < len(snap["detail"]) <= 160
    assert "top" not in snap


def test_manager_snapshot_when_the_manager_files_no_13f():
    routes = {SUBM_URL: submissions(filings=[("8-K", "a", "2026-01-01", "")])}
    snap = w.manager_snapshot(BERKSHIRE, client=FakeClient(routes),
                              sleep=Recorder())
    assert snap["status"] == "error"
    assert "13F" in snap["detail"]


def test_manager_snapshot_with_a_single_quarter_invents_no_moves():
    """Sans trimestre précédent, tout marquer « nouvellement acheté » serait
    un mensonge."""
    routes = full_routes()
    routes[SUBM_URL] = submissions(filings=[
        ("13F-HR", ACC_Q2, "2026-08-14", "2026-06-30")])
    snap = w.manager_snapshot(BERKSHIRE, client=FakeClient(routes),
                              sleep=Recorder())
    assert snap["status"] == "ok"
    assert snap["has_previous"] is False
    assert snap["prev_quarter"] is None
    assert snap["moves"] == {"new": [], "exits": [],
                             "increased": [], "decreased": []}
    assert snap["n_positions"] == 4             # le portefeuille est bien là


# =========================================================================== #
#  Cache 24 h
# =========================================================================== #

def test_get_snapshot_writes_a_0600_cache_and_reuses_it():
    client = FakeClient(full_routes())
    first = w.get_snapshot("berkshire", client=client, sleep=Recorder(), now=1000.0)
    assert first["status"] == "ok" and first["cached"] is False
    calls_after_first = len(client.calls)
    assert calls_after_first == 5

    assert oct(w.cache_path().stat().st_mode & 0o777) == "0o600"

    second = w.get_snapshot("berkshire", client=client, sleep=Recorder(),
                            now=1000.0 + 3600)
    assert second["cached"] is True and second["stale"] is False
    assert second["quarter"] == "2026-06-30"
    assert len(client.calls) == calls_after_first      # zéro requête de plus


def test_cache_expires_after_24h():
    client = FakeClient(full_routes())
    w.get_snapshot("berkshire", client=client, sleep=Recorder(), now=1000.0)
    calls = len(client.calls)
    out = w.get_snapshot("berkshire", client=client, sleep=Recorder(),
                         now=1000.0 + w.CACHE_TTL_S + 1)
    assert out["cached"] is False
    assert len(client.calls) > calls


def test_force_bypasses_a_fresh_cache():
    client = FakeClient(full_routes())
    w.get_snapshot("berkshire", client=client, sleep=Recorder(), now=1000.0)
    calls = len(client.calls)
    out = w.get_snapshot("berkshire", client=client, sleep=Recorder(),
                         now=1000.0 + 60, force=True)
    assert out["cached"] is False
    assert len(client.calls) == calls + 5


def test_a_sec_blip_serves_the_stale_cache_instead_of_emptying_the_screen():
    ok_client = FakeClient(full_routes())
    w.get_snapshot("berkshire", client=ok_client, sleep=Recorder(), now=1000.0)

    broken = FakeClient({SUBM_URL: RuntimeError("SEC down")})
    out = w.get_snapshot("berkshire", client=broken, sleep=Recorder(),
                         now=1000.0 + w.CACHE_TTL_S + 10)
    assert out["stale"] is True and out["cached"] is True
    assert out["status"] == "ok"
    assert out["n_positions"] == 4               # la donnée d'hier reste lisible
    assert out["refresh_error"]


def test_a_failure_without_any_cache_returns_the_error_verbatim():
    broken = FakeClient({SUBM_URL: RuntimeError("SEC down")})
    out = w.get_snapshot("berkshire", client=broken, sleep=Recorder(), now=1000.0)
    assert out["status"] == "error" and "stale" not in out


def test_unverified_is_never_cached():
    """Corriger un CIK dans le catalogue doit prendre effet TOUT DE SUITE."""
    routes = full_routes()
    routes[SUBM_URL] = submissions(name="AUTRE SOCIETE")
    out = w.get_snapshot("berkshire", client=FakeClient(routes),
                         sleep=Recorder(), now=1000.0)
    assert out["status"] == "unverified"
    assert not w.cache_path().is_file()


def test_a_corrupt_cache_file_is_ignored_not_fatal():
    w.cache_path().parent.mkdir(parents=True, exist_ok=True)
    w.cache_path().write_text("{ pas du json", encoding="utf-8")
    out = w.get_snapshot("berkshire", client=FakeClient(full_routes()),
                         sleep=Recorder(), now=1000.0)
    assert out["status"] == "ok"


def test_get_snapshot_rejects_an_unknown_manager():
    with pytest.raises(KeyError):
        w.get_snapshot("nexistepas")


# =========================================================================== #
#  Catalogue
# =========================================================================== #

CATALOGUE_SIZE = 16          # 10 historiques + 6 internationaux (26/08)


def test_catalogue_shape_is_sane():
    assert len(w.MANAGERS) == CATALOGUE_SIZE
    ids = [m["id"] for m in w.MANAGERS]
    assert len(set(ids)) == CATALOGUE_SIZE
    assert len({m["cik"] for m in w.MANAGERS}) == CATALOGUE_SIZE
    for m in w.MANAGERS:
        assert len(m["cik"]) == 10 and m["cik"].isdigit()
        assert m["expect"] and m["expect"] == m["expect"].lower()
        # le mot clé de vérification doit être crédible face au label
        assert m["expect"] in m["label"].lower() or m["id"] == m["expect"]
    assert w.find_manager("scion")["label"].startswith("Michael Burry")
    assert w.find_manager("inconnu") is None


def test_the_six_international_managers_are_in_the_catalogue():
    """Les CIK ont été vérifiés un par un contre ``data.sec.gov`` le 26/08 ;
    ce test fige le couple (identifiant, CIK) pour qu'une frappe ne le défasse
    pas en silence."""
    by_id = {m["id"]: m for m in w.MANAGERS}
    assert by_id["snb-ch"]["cik"] == "0001582202"
    assert by_id["norges"]["cik"] == "0001374170"
    assert by_id["baillie"]["cik"] == "0001088875"
    assert by_id["tci"]["cik"] == "0001647251"
    assert by_id["temasek"]["cik"] == "0001021944"
    assert by_id["nomura"]["cik"] == "0001163653"


def test_the_wrong_norges_cik_is_caught_by_the_expect_guard():
    """LE piège du lot : ``0001374911`` n'est PAS Norges Bank — la SEC le nomme
    « CAPITAL CITY ENERGY FUND XIV LLC » (fonds texan, mesuré). Avec ce CIK, le
    gérant doit sortir ``unverified`` et AUCUNE ligne ne doit être servie sous
    le nom du fonds souverain norvégien."""
    wrong = {"id": "norges", "label": "Norges Bank (fonds souverain norvégien)",
             "cik": "0001374911", "expect": "norges"}
    routes = {"https://data.sec.gov/submissions/CIK0001374911.json":
              submissions(name="CAPITAL CITY ENERGY FUND XIV LLC")}
    snap = w.manager_snapshot(wrong, client=FakeClient(routes), sleep=Recorder())
    assert snap["status"] == "unverified"
    assert snap["sec_name"] == "CAPITAL CITY ENERGY FUND XIV LLC"
    assert "top" not in snap and "moves" not in snap

    # ...et le VRAI CIK passe la garde.
    right = dict(wrong, cik="0001374170")
    routes = {"https://data.sec.gov/submissions/CIK0001374170.json":
              submissions(name="NORGES BANK")}
    assert w.manager_snapshot(
        right, client=FakeClient(routes), sleep=Recorder())["status"] == "error"


def test_rotation_absorbs_the_sixteen_managers_one_per_cycle():
    """La rotation reste d'UN gérant par cycle : le catalogue élargi coûte des
    CYCLES (seize au lieu de dix, soit ~8 h au rythme de 30 min), jamais une
    rafale vers la SEC."""
    cache, stamp, picked = {}, 10_000_000.0, []
    for _ in range(len(w.MANAGERS) + 2):
        stale = w.stalest_manager(cache, stamp)
        if stale is None:
            break
        picked.append(stale)
        cache[stale] = {"fetched_ts": stamp}       # ce cycle l'a rafraîchi
    assert len(picked) == CATALOGUE_SIZE           # tout le monde est passé...
    assert len(set(picked)) == CATALOGUE_SIZE      # ...et une seule fois
    assert set(picked) == {m["id"] for m in w.MANAGERS}
    # Tous frais -> la rotation s'arrête (zéro requête inutile).
    assert w.stalest_manager(cache, stamp) is None


def test_the_international_limit_is_written_down():
    """Un 13F ne montre que la poche AMÉRICAINE d'un fonds étranger. Cette
    limite doit être ÉCRITE quelque part que l'on relit — sinon on finira par
    lire « voilà le portefeuille de Norges Bank », ce qui est faux."""
    assert "13F est une obligation" in w.__doc__
    assert "AUX ÉTATS-UNIS" in w.__doc__


def test_list_managers_reports_the_cache_state():
    before = w.list_managers()
    assert len(before) == CATALOGUE_SIZE
    assert all(m["cached"] is False and "quarter" not in m for m in before)

    w.get_snapshot("berkshire", client=FakeClient(full_routes()),
                   sleep=Recorder(), now=1000.0)
    after = {m["id"]: m for m in w.list_managers()}
    assert after["berkshire"]["cached"] is True
    assert after["berkshire"]["quarter"] == "2026-06-30"
    assert after["berkshire"]["quarter_label"] == "T2 2026"
    assert after["scion"]["cached"] is False


# =========================================================================== #
#  Guetteur de nouveaux dépôts
# =========================================================================== #

TG = {"token": "123:abc", "chat_id": "42"}


class FakeNotifier(object):
    def __init__(self, boom=False):
        self.sent = []
        self.boom = boom

    def __call__(self, text, cfg):
        if self.boom:
            raise RuntimeError("telegram down")
        self.sent.append((text, cfg))
        return True


def _one_manager(monkeypatch, cik=CIK, expect="berkshire",
                 label="Warren Buffett — Berkshire Hathaway"):
    monkeypatch.setattr(w, "MANAGERS", [
        {"id": "berkshire", "label": label, "cik": cik, "expect": expect}])


def _watch_routes(filings):
    return {SUBM_URL: submissions(filings=filings)}


def test_watcher_does_nothing_without_telegram_config(monkeypatch):
    _one_manager(monkeypatch)
    client = FakeClient(_watch_routes([("4", "a1", "2026-08-20", "")]))
    notifier = FakeNotifier()
    out = w.check_new_filings(mode="tout", client=client, notifier=notifier, tg_cfg={},
                              sleep=Recorder(), now=1000.0)
    assert out == counters()
    assert client.calls == []                   # ZÉRO réseau quand c'est éteint
    assert notifier.sent == []
    assert not w.watch_path().is_file()


def test_watcher_first_pass_seeds_silently(monkeypatch):
    """Anti-tempête au déploiement : on marque tout vu, on n'alerte sur rien."""
    _one_manager(monkeypatch)
    client = FakeClient(_watch_routes([
        ("4", "a1", "2026-08-20", ""),
        ("13F-HR", "a2", "2026-08-14", "2026-06-30"),
        ("SC 13D", "a3", "2026-07-01", ""),
    ]))
    notifier = FakeNotifier()
    out = w.check_new_filings(mode="tout", client=client, notifier=notifier, tg_cfg=TG,
                              sleep=Recorder(), now=1000.0)
    assert out == counters(managers=1)
    assert notifier.sent == []
    assert w.recent_filing_events() == []
    state = json.loads(w.watch_path().read_text(encoding="utf-8"))
    assert state["seeded"]["berkshire"] is True
    assert sorted(state["seen"]["berkshire"]) == ["a1", "a2", "a3"]
    assert oct(w.watch_path().stat().st_mode & 0o777) == "0o600"


def test_watcher_notifies_a_new_filing_on_the_second_pass(monkeypatch):
    _one_manager(monkeypatch)
    notifier = FakeNotifier()
    w.check_new_filings(mode="tout", client=FakeClient(_watch_routes([
        ("13F-HR", "old", "2026-05-15", "2026-03-31")])),
        notifier=notifier, tg_cfg=TG, sleep=Recorder(), now=1000.0)
    assert notifier.sent == []

    out = w.check_new_filings(mode="tout", client=FakeClient(_watch_routes([
        ("4", "brand-new", "2026-08-21", ""),
        ("13F-HR", "old", "2026-05-15", "2026-03-31")])),
        notifier=notifier, tg_cfg=TG, sleep=Recorder(), now=2000.0)
    assert out == counters(managers=1, new_filings=1, notified=1)

    text, cfg = notifier.sent[0]
    assert cfg is TG
    assert text.startswith("[Simulateur] Nouveau dépôt SEC — "
                           "Warren Buffett — Berkshire Hathaway")
    assert "Form 4 : transaction d'initié" in text
    assert "Dépôt du 2026-08-21." in text
    assert "browse-edgar" in text and "CIK=0001067983" in text and "type=4" in text
    # sobriété exigée : aucun emoji dans l'alerte
    assert all(ord(ch) < 0x2190 for ch in text)

    events = w.recent_filing_events(now=2000.0)
    assert len(events) == 1
    assert events[0]["accession"] == "brand-new"
    assert events[0]["form"] == "4"
    assert events[0]["manager_id"] == "berkshire"
    assert events[0]["label"].startswith("Warren Buffett")
    assert events[0]["filing_date"] == "2026-08-21"
    assert events[0]["ts"]


def test_watcher_does_not_renotify_on_a_third_pass(monkeypatch):
    _one_manager(monkeypatch)
    notifier = FakeNotifier()
    filings_v1 = [("13F-HR", "old", "2026-05-15", "2026-03-31")]
    filings_v2 = [("4", "new", "2026-08-21", "")] + filings_v1
    w.check_new_filings(mode="tout", client=FakeClient(_watch_routes(filings_v1)),
                        notifier=notifier, tg_cfg=TG, sleep=Recorder(), now=1.0)
    w.check_new_filings(mode="tout", client=FakeClient(_watch_routes(filings_v2)),
                        notifier=notifier, tg_cfg=TG, sleep=Recorder(), now=2.0)
    out = w.check_new_filings(mode="tout", client=FakeClient(_watch_routes(filings_v2)),
                              notifier=notifier, tg_cfg=TG, sleep=Recorder(), now=3.0)
    assert out["new_filings"] == 0 and out["notified"] == 0
    assert len(notifier.sent) == 1


def test_watcher_caps_at_three_notifications_but_marks_everything_seen(monkeypatch):
    _one_manager(monkeypatch)
    notifier = FakeNotifier()
    w.check_new_filings(mode="tout", client=FakeClient(_watch_routes([
        ("13F-HR", "old", "2026-05-15", "2026-03-31")])),
        notifier=notifier, tg_cfg=TG, sleep=Recorder(), now=1.0)

    many = [("4", "n%d" % i, "2026-08-2%d" % i, "") for i in range(5)]
    out = w.check_new_filings(mode="tout", client=FakeClient(_watch_routes(
        many + [("13F-HR", "old", "2026-05-15", "2026-03-31")])),
        notifier=notifier, tg_cfg=TG, sleep=Recorder(), now=2.0)
    assert out["new_filings"] == 5
    assert out["notified"] == w.MAX_NOTIFY_PER_MANAGER == 3
    assert len(notifier.sent) == 3
    # les 2 restants sont MARQUÉS VUS : ils ne repartiront pas au tour suivant
    again = w.check_new_filings(mode="tout", client=FakeClient(_watch_routes(
        many + [("13F-HR", "old", "2026-05-15", "2026-03-31")])),
        notifier=notifier, tg_cfg=TG, sleep=Recorder(), now=3.0)
    assert again["new_filings"] == 0 and again["notified"] == 0


def test_watcher_ignores_forms_outside_the_watch_list(monkeypatch):
    _one_manager(monkeypatch)
    notifier = FakeNotifier()
    w.check_new_filings(mode="tout", client=FakeClient(_watch_routes([
        ("4", "seed", "2026-01-01", "")])),
        notifier=notifier, tg_cfg=TG, sleep=Recorder(), now=1.0)
    out = w.check_new_filings(mode="tout", client=FakeClient(_watch_routes([
        ("8-K", "noise-1", "2026-08-21", ""),
        ("10-K", "noise-2", "2026-08-21", ""),
        ("13F-NT", "noise-3", "2026-08-21", "2026-06-30"),
        ("4", "seed", "2026-01-01", "")])),
        notifier=notifier, tg_cfg=TG, sleep=Recorder(), now=2.0)
    assert out["new_filings"] == 0 and notifier.sent == []
    state = json.loads(w.watch_path().read_text(encoding="utf-8"))
    assert state["seen"]["berkshire"] == ["seed"]


@pytest.mark.parametrize("form,needle", [
    ("13F-HR", "13F : portefeuille trimestriel complet"),
    ("13F-HR/A", "13F : portefeuille trimestriel complet"),
    ("SC 13D", "13D : franchissement des 5 %"),
    ("SC 13D/A", "13D : franchissement des 5 %"),
    ("SC 13G", "13G : franchissement des 5 %"),
    ("SC 13G/A", "13G : franchissement des 5 %"),
    ("4", "Form 4 : transaction d'initié"),
    ("4/A", "Form 4 : transaction d'initié"),
])
def test_every_watched_form_has_a_plain_language_explanation(form, needle):
    assert needle in w.form_explanation(form)
    assert form in w.WATCHED_FORMS


def test_notification_url_encodes_a_form_containing_a_space():
    text = w._notification_text(BERKSHIRE, "SC 13D", "2026-08-21")
    assert "type=SC+13D" in text and " 13D&" not in text


def test_watcher_counts_one_broken_manager_and_carries_on(monkeypatch):
    monkeypatch.setattr(w, "MANAGERS", [
        {"id": "broken", "label": "HS", "cik": "0000000001", "expect": "hs"},
        {"id": "berkshire", "label": "Berkshire", "cik": CIK, "expect": "berkshire"},
    ])
    routes = _watch_routes([("4", "a1", "2026-08-20", "")])
    routes["https://data.sec.gov/submissions/CIK0000000001.json"] = \
        RuntimeError("boom")
    out = w.check_new_filings(mode="tout", client=FakeClient(routes), notifier=FakeNotifier(),
                              tg_cfg=TG, sleep=Recorder(), now=1.0)
    assert out["errors"] == 1
    assert out["managers"] == 1                 # le second a bien été traité
    state = json.loads(w.watch_path().read_text(encoding="utf-8"))
    assert "berkshire" in state["seeded"] and "broken" not in state["seeded"]


def test_watcher_survives_a_corrupt_state_file(monkeypatch):
    _one_manager(monkeypatch)
    w.watch_path().parent.mkdir(parents=True, exist_ok=True)
    w.watch_path().write_text("<<<pas du json>>>", encoding="utf-8")
    notifier = FakeNotifier()
    out = w.check_new_filings(mode="tout", client=FakeClient(_watch_routes([
        ("4", "a1", "2026-08-20", "")])),
        notifier=notifier, tg_cfg=TG, sleep=Recorder(), now=1.0)
    # état illisible -> on repart de zéro, donc ré-amorçage MUET (pas de tempête)
    assert out["managers"] == 1 and out["notified"] == 0
    assert notifier.sent == []
    assert json.loads(w.watch_path().read_text(encoding="utf-8"))["seeded"]


def test_a_failing_notifier_never_breaks_the_watch(monkeypatch):
    _one_manager(monkeypatch)
    boom = FakeNotifier(boom=True)
    w.check_new_filings(mode="tout", client=FakeClient(_watch_routes([
        ("13F-HR", "old", "2026-05-15", "2026-03-31")])),
        notifier=boom, tg_cfg=TG, sleep=Recorder(), now=1.0)
    out = w.check_new_filings(mode="tout", client=FakeClient(_watch_routes([
        ("4", "new", "2026-08-21", ""),
        ("13F-HR", "old", "2026-05-15", "2026-03-31")])),
        notifier=boom, tg_cfg=TG, sleep=Recorder(), now=2.0)
    assert out["new_filings"] == 1
    assert out["notified"] == 0                 # l'envoi a échoué...
    # ...mais la détection est gardée (``now`` explicite : sans lui le test
    # dépendrait de l'horloge réelle via la garde d'âge de lecture).
    assert len(w.recent_filing_events(now=2.0)) == 1


def test_watcher_paces_its_requests(monkeypatch):
    monkeypatch.setattr(w, "MANAGERS", [
        {"id": "a", "label": "A", "cik": CIK, "expect": "berkshire"},
        {"id": "b", "label": "B", "cik": CIK, "expect": "berkshire"},
    ])
    sleeps = Recorder()
    w.check_new_filings(mode="tout", client=FakeClient(_watch_routes([])),
                        notifier=FakeNotifier(), tg_cfg=TG, sleep=sleeps, now=1.0)
    assert sleeps.calls == [w.PACE_S]           # 2 requêtes -> 1 attente


def test_events_are_capped_newest_first(monkeypatch):
    monkeypatch.setattr(w, "MAX_EVENTS", 2)
    _one_manager(monkeypatch)
    notifier = FakeNotifier()
    seed = [("13F-HR", "old", "2026-05-15", "2026-03-31")]
    w.check_new_filings(mode="tout", client=FakeClient(_watch_routes(seed)),
                        notifier=notifier, tg_cfg=TG, sleep=Recorder(), now=1.0)
    w.check_new_filings(mode="tout", client=FakeClient(_watch_routes(
        [("4", "n1", "2026-08-21", "")] + seed)),
        notifier=notifier, tg_cfg=TG, sleep=Recorder(), now=2.0)
    w.check_new_filings(mode="tout", client=FakeClient(_watch_routes(
        [("4", "n3", "2026-08-23", ""), ("4", "n2", "2026-08-22", ""),
         ("4", "n1", "2026-08-21", "")] + seed)),
        notifier=notifier, tg_cfg=TG, sleep=Recorder(), now=3.0)
    events = w.recent_filing_events(now=3.0)
    assert len(events) == 2
    assert [e["accession"] for e in events] == ["n3", "n2"]   # les plus récents


def test_recent_filing_events_without_any_state_file():
    assert w.recent_filing_events() == []


# =========================================================================== #
#  Anti-spam de dépôts ANTIQUES — incident mesuré le 25/08 à 09:02
#
#  30 messages Telegram d'un coup pour des dépôts SEC de 2009-2021, et le
#  scénario allait se répéter toutes les 30 minutes : le cap de ``seen``
#  (300) tronquait une fenêtre SEC plus longue, donc les accessions évincées
#  redevenaient « nouvelles » à chaque ronde.
# =========================================================================== #

INCIDENT = datetime(2026, 8, 25, 9, 2, 0)      # l'heure exacte de l'incident
INCIDENT_TS = INCIDENT.timestamp()


def _at(days_ago):
    """Date de dépôt EDGAR à N jours de l'incident."""
    return (INCIDENT - timedelta(days=days_ago)).strftime("%Y-%m-%d")


@pytest.mark.parametrize("filing_date,stale", [
    ("2011-05-16", True),                      # un vrai des 30 messages reçus
    ("2009-11-13", True),
    ("2021-02-16", True),
    (_at(15), True),                           # juste au-delà de la fenêtre
    (_at(14), False),                          # la borne elle-même reste fraîche
    (_at(1), False),
    (_at(0), False),
    ("2027-01-01", False),                     # futur : pas « vieux »
    ("", False),                               # illisible -> on ne museler pas
    ("pas une date", False),
    (None, False),
])
def test_is_stale_filing_juge_l_age_sans_jamais_museler_sur_un_doute(filing_date, stale):
    assert w.is_stale_filing(filing_date, INCIDENT) is stale


def test_un_depot_antique_n_est_jamais_notifie_meme_absent_de_seen(monkeypatch):
    """LA garde : quel que soit l'état de ``seen`` (ici : vierge de ce dépôt),
    un dépôt de 2011 ne sonne pas et n'entre pas dans le journal."""
    _one_manager(monkeypatch)
    notifier = FakeNotifier()
    w.check_new_filings(mode="tout", client=FakeClient(_watch_routes([
        ("4", "seed", _at(3), "")])),
        notifier=notifier, tg_cfg=TG, sleep=Recorder(), now=INCIDENT_TS)
    assert notifier.sent == []                  # amorçage muet

    out = w.check_new_filings(mode="tout", client=FakeClient(_watch_routes([
        ("13F-HR", "antique-2011", "2011-05-16", "2011-03-31"),
        ("SC 13G", "antique-2009", "2009-11-13", ""),
        ("4", "seed", _at(3), "")])),
        notifier=notifier, tg_cfg=TG, sleep=Recorder(), now=INCIDENT_TS)

    assert out["new_filings"] == 2              # détectés (ils sont inconnus)...
    assert out["notified"] == 0                 # ...mais jamais envoyés
    assert notifier.sent == []
    assert w.recent_filing_events(now=INCIDENT_TS) == []   # ni journalisés


def test_un_depot_antique_est_quand_meme_marque_vu(monkeypatch):
    """Sinon il serait « re-détecté » à chaque ronde — 48 redécouvertes par
    jour à raison d'un passage toutes les 30 minutes."""
    _one_manager(monkeypatch)
    filings = [("13F-HR", "antique", "2011-05-16", "2011-03-31"),
               ("4", "seed", _at(3), "")]
    w.check_new_filings(mode="tout", client=FakeClient(_watch_routes([("4", "seed", _at(3), "")])),
                        notifier=FakeNotifier(), tg_cfg=TG, sleep=Recorder(),
                        now=INCIDENT_TS)
    w.check_new_filings(mode="tout", client=FakeClient(_watch_routes(filings)),
                        notifier=FakeNotifier(), tg_cfg=TG, sleep=Recorder(),
                        now=INCIDENT_TS)
    state = json.loads(w.watch_path().read_text(encoding="utf-8"))
    assert "antique" in state["seen"]["berkshire"]

    out = w.check_new_filings(mode="tout", client=FakeClient(_watch_routes(filings)),
                              notifier=FakeNotifier(), tg_cfg=TG,
                              sleep=Recorder(), now=INCIDENT_TS)
    assert out["new_filings"] == 0              # plus jamais « nouveau »


def test_un_depot_frais_sonne_toujours(monkeypatch):
    """Contre-épreuve : la garde d'âge ne doit pas avoir tué la fonctionnalité."""
    _one_manager(monkeypatch)
    notifier = FakeNotifier()
    w.check_new_filings(mode="tout", client=FakeClient(_watch_routes([("4", "seed", _at(3), "")])),
                        notifier=notifier, tg_cfg=TG, sleep=Recorder(),
                        now=INCIDENT_TS)
    out = w.check_new_filings(mode="tout", client=FakeClient(_watch_routes([
        ("13F-HR", "tout-frais", _at(1), "2026-06-30"),
        ("4", "seed", _at(3), "")])),
        notifier=notifier, tg_cfg=TG, sleep=Recorder(), now=INCIDENT_TS)
    assert out["notified"] == 1
    assert len(notifier.sent) == 1
    assert len(w.recent_filing_events(now=INCIDENT_TS)) == 1


# --- le plafond de ``seen`` ne doit plus pouvoir causer de ré-émission ------ #

def test_prune_seen_ne_sacrifie_jamais_un_depot_recent():
    filings = [{"accession": "a%d" % i, "filing_date": _at(i)} for i in range(5)]
    kept = w.prune_seen(filings, INCIDENT, cap=2)
    assert kept == ["a0", "a1", "a2", "a3", "a4"]   # le cap ne les touche pas


def test_prune_seen_cape_les_anciens_en_gardant_les_plus_recents():
    filings = ([{"accession": "frais", "filing_date": _at(1)}]
               + [{"accession": "vieux%d" % i, "filing_date": _at(100 + i)}
                  for i in range(5)])
    kept = w.prune_seen(filings, INCIDENT, cap=3)
    assert kept == ["frais", "vieux0", "vieux1"]


def test_prune_seen_ignore_une_ligne_sans_accession():
    assert w.prune_seen([{"filing_date": _at(1)}, {"accession": "ok",
                                                   "filing_date": _at(1)}],
                        INCIDENT) == ["ok"]


def test_l_eviction_du_cap_ne_renotifie_plus(monkeypatch):
    """Régression EXACTE de l'incident : avec l'ancien cap (troncature dure),
    les accessions évincées repartaient en alerte au passage suivant."""
    _one_manager(monkeypatch)
    monkeypatch.setattr(w, "MAX_SEEN_PER_MANAGER", 2)   # cap volontairement ridicule
    notifier = FakeNotifier()
    filings = [("4", "n%d" % i, _at(i + 1), "") for i in range(5)]

    w.check_new_filings(mode="tout", client=FakeClient(_watch_routes(filings)),
                        notifier=notifier, tg_cfg=TG, sleep=Recorder(),
                        now=INCIDENT_TS)                # amorçage
    state = json.loads(w.watch_path().read_text(encoding="utf-8"))
    assert len(state["seen"]["berkshire"]) == 5         # rien n'a été évincé

    out = w.check_new_filings(mode="tout", client=FakeClient(_watch_routes(filings)),
                              notifier=notifier, tg_cfg=TG, sleep=Recorder(),
                              now=INCIDENT_TS)
    assert out["new_filings"] == 0 and out["notified"] == 0
    assert notifier.sent == []


# --- purge à la LECTURE des events déjà pourris en production -------------- #

def test_recent_filing_events_filtre_les_events_pourris_deja_ecrits():
    """Fixture = ce que l'incident a laissé dans ``whales_watch.json``. La
    lecture les écarte -> pas de nettoyage manuel à faire sur l'Omen."""
    w._atomic_write_json(w.watch_path(), {
        "seen": {}, "seeded": {"berkshire": True},
        "events": [
            {"ts": INCIDENT.isoformat(), "manager_id": "berkshire",
             "label": "Berkshire", "form": "13F-HR",
             "filing_date": "2011-05-16", "accession": "vieux-1"},
            {"ts": INCIDENT.isoformat(), "manager_id": "soros",
             "label": "Soros", "form": "SC 13G",
             "filing_date": "2009-11-13", "accession": "vieux-2"},
            {"ts": INCIDENT.isoformat(), "manager_id": "gates",
             "label": "Gates", "form": "4",
             "filing_date": _at(2), "accession": "vraiment-neuf"},
        ],
    })
    events = w.recent_filing_events(now=INCIDENT_TS)
    assert [e["accession"] for e in events] == ["vraiment-neuf"]


def test_recent_filing_events_garde_un_event_sans_date_lisible():
    """Une date illisible n'est pas une preuve d'ancienneté (même règle qu'à
    la notification) : on ne fait pas disparaître un signal sur un doute."""
    w._atomic_write_json(w.watch_path(), {
        "seen": {}, "seeded": {},
        "events": [{"ts": INCIDENT.isoformat(), "form": "4",
                    "filing_date": "", "accession": "sans-date"}],
    })
    assert [e["accession"] for e in w.recent_filing_events(now=INCIDENT_TS)] \
        == ["sans-date"]


def test_watcher_reads_the_paper_telegram_config_by_default(monkeypatch):
    """Spec §13 : sans ``tg_cfg``, c'est le canal du paper trading (bot ORACLE,
    ``paper/alerts``) qui fait foi — plus directement celui du Harvester."""
    _one_manager(monkeypatch)
    from backend.bots.paper import alerts
    monkeypatch.setattr(alerts, "load_cfg", lambda path=None: None)
    client = FakeClient(_watch_routes([("4", "a1", "2026-08-20", "")]))
    out = w.check_new_filings(mode="tout", client=client, notifier=FakeNotifier(),
                              sleep=Recorder(), now=1.0)
    assert out["managers"] == 0 and client.calls == []   # éteint : zéro réseau


def test_watcher_notifies_through_the_paper_channel(monkeypatch):
    """Et les dépôts détectés partent par ``alerts.send``, pas par le notifieur
    du Harvester."""
    _one_manager(monkeypatch)
    from backend.bots.paper import alerts
    sent = []
    monkeypatch.setattr(alerts, "load_cfg",
                        lambda path=None: {"token": "t", "chat_id": "c"})
    monkeypatch.setattr(alerts, "send",
                        lambda text, cfg=None, client=None: sent.append((text, cfg)) or True)

    client = FakeClient(_watch_routes([("4", "a1", "2026-08-20", "")]))
    w.check_new_filings(mode="tout", client=client, sleep=Recorder(), now=1000.0)   # amorçage muet
    client = FakeClient(_watch_routes([("4", "a2", "2026-08-21", ""),
                                       ("4", "a1", "2026-08-20", "")]))
    out = w.check_new_filings(mode="tout", client=client, sleep=Recorder(), now=2000.0)

    assert out["notified"] == 1
    assert len(sent) == 1 and sent[0][1] == {"token": "t", "chat_id": "c"}


# =========================================================================== #
#  Router
# =========================================================================== #

class FakeUser(object):
    def __init__(self, role="admin"):
        self.role = role
        self.is_admin = role == "admin"
        self.username = "tester"


def make_client(role="admin"):
    app = FastAPI()
    app.include_router(wr.router)
    app.dependency_overrides[get_current_user] = lambda: FakeUser(role)
    return TestClient(app)


def test_router_lists_the_managers():
    resp = make_client().get("/api/paper/whales")
    assert resp.status_code == 200
    managers = resp.json()["managers"]
    assert len(managers) == CATALOGUE_SIZE
    assert managers[0]["id"] == "berkshire"


def test_router_serves_a_snapshot(monkeypatch):
    seen = {}

    def fake_get(manager_id, client=None, force=False, **kw):
        seen["id"] = manager_id
        seen["force"] = force
        return {"status": "ok", "id": manager_id, "quarter": "2026-06-30"}

    monkeypatch.setattr(w, "get_snapshot", fake_get)
    resp = make_client().get("/api/paper/whales/scion")
    assert resp.status_code == 200
    assert resp.json()["quarter"] == "2026-06-30"
    assert seen == {"id": "scion", "force": False}


def test_router_passes_the_force_flag(monkeypatch):
    seen = {}
    monkeypatch.setattr(w, "get_snapshot",
                        lambda mid, client=None, force=False, **kw:
                        seen.update(force=force) or {"status": "ok"})
    assert make_client().get(
        "/api/paper/whales/scion?force=true").status_code == 200
    assert seen["force"] is True


def test_router_404s_an_unknown_manager(monkeypatch):
    monkeypatch.setattr(w, "get_snapshot",
                        lambda *a, **k: pytest.fail("ne doit pas être appelé"))
    assert make_client().get("/api/paper/whales/madoff").status_code == 404


def test_router_surfaces_the_unverified_status_as_a_200(monkeypatch):
    """Un CIK qui ne correspond pas n'est pas une panne HTTP : c'est une
    information à AFFICHER — sans aucune donnée de portefeuille."""
    monkeypatch.setattr(w, "get_snapshot", lambda *a, **k: {
        "status": "unverified", "id": "scion", "sec_name": "AUTRE"})
    resp = make_client().get("/api/paper/whales/scion")
    assert resp.status_code == 200
    assert resp.json()["status"] == "unverified"
    assert "top" not in resp.json()


def test_router_events_route_is_not_swallowed_by_the_id_route(monkeypatch):
    """Piège d'ordre des routes : « events » ne doit JAMAIS être lu comme un
    identifiant de gérant (sinon 404 et endpoint injoignable)."""
    monkeypatch.setattr(w, "recent_filing_events",
                        lambda: [{"manager_id": "scion", "form": "SC 13D"}])
    monkeypatch.setattr(w, "get_snapshot",
                        lambda *a, **k: pytest.fail("route /events avalée !"))
    resp = make_client().get("/api/paper/whales/events")
    assert resp.status_code == 200
    assert resp.json()["events"][0]["form"] == "SC 13D"


def test_router_refuses_the_player_role():
    client = make_client(role="player")
    assert client.get("/api/paper/whales").status_code == 403
    assert client.get("/api/paper/whales/events").status_code == 403
    assert client.get("/api/paper/whales/berkshire").status_code == 403


def test_router_allows_the_money_role(monkeypatch):
    monkeypatch.setattr(w, "get_snapshot", lambda *a, **k: {"status": "ok"})
    client = make_client(role="money")
    assert client.get("/api/paper/whales").status_code == 200
    assert client.get("/api/paper/whales/events").status_code == 200
    assert client.get("/api/paper/whales/berkshire").status_code == 200


def test_router_allows_the_trader_role(monkeypatch):
    """Nouveau rôle : accès au SEUL module Trading — mêmes endpoints que
    money/admin (précédent exact : rectester, piège #37 CLAUDE.md)."""
    monkeypatch.setattr(w, "get_snapshot", lambda *a, **k: {"status": "ok"})
    client = make_client(role="trader")
    assert client.get("/api/paper/whales").status_code == 200
    assert client.get("/api/paper/whales/events").status_code == 200
    assert client.get("/api/paper/whales/berkshire").status_code == 200


# =========================================================================== #
#  Le coach ASSIMILE les portefeuilles des gérants (26/08)
# =========================================================================== #

def _ts_of(day):
    """Epoch d'un jour ``AAAA-MM-JJ`` — le guetteur raisonne en secondes."""
    return datetime.strptime(day, "%Y-%m-%d").timestamp()


def _snapshot(quarter="T2 2026", exits=(), decreased=(), new=(), increased=()):
    def rows(names, with_delta=False):
        out = []
        for i, name in enumerate(names):
            row = {"cusip": "c%d" % i, "name": name, "class": "COM",
                   "value_usd": 1000 - i, "shares": 10}
            if with_delta:
                row["delta_pct"] = -20.0 - i
            out.append(row)
        return out

    return {
        "status": "ok", "quarter": "2026-06-30", "quarter_label": quarter,
        "moves": {"exits": rows(exits), "decreased": rows(decreased, True),
                  "new": rows(new), "increased": rows(increased, True)},
    }


def _write_cache(monkeypatch, entries):
    """Pose un cache de snapshots (ce que ``get_snapshot`` aurait écrit)."""
    w._atomic_write_json(w.cache_path(), entries)


# --- match_issuer (PUR) ---------------------------------------------------- #

def test_match_issuer_rejoint_les_memes_emetteurs():
    assert w.match_issuer("APPLE INC", {"AAPL": "Apple Inc."}) == "AAPL"
    assert w.match_issuer("COCA COLA CO", {"KO": "Coca-Cola Company"}) == "KO"


def test_match_issuer_ignore_un_mot_generique_seul():
    """Leçon du piège #31 : « Deutsche » ne suffit pas à identifier « Deutsche
    Bank » — ici les formes juridiques sont retirées des DEUX côtés, donc un
    nom qui n'a plus qu'elles en commun ne matche rien."""
    assert w.match_issuer("NESTLE SA", {"AAPL": "Apple Inc."}) is None
    assert w.match_issuer("SOME HOLDINGS INC", {"X": "Other Holdings Inc"}) is None


def test_match_issuer_prefere_le_meilleur_candidat():
    candidates = {"AAPL": "Apple Inc.", "AAPU": "Apple Hospitality REIT"}
    assert w.match_issuer("APPLE HOSPITALITY REIT", candidates) == "AAPU"


def test_match_issuer_sans_candidat_rend_none():
    assert w.match_issuer("APPLE INC", {}) is None
    assert w.match_issuer("", {"AAPL": "Apple Inc."}) is None
    assert w.match_issuer("APPLE INC", None) is None


def test_match_issuer_distingue_deux_classes_du_meme_emetteur():
    """Deux classes d'un même émetteur ont des CUSIP différents et restent deux
    lignes : le rapprochement porte sur l'émetteur, la classe reste dans le
    mouvement lui-même."""
    candidates = {"GOOGL": "Alphabet Inc. Class A", "GOOG": "Alphabet Inc."}
    assert w.match_issuer("ALPHABET INC", candidates) in candidates


# --- moves_summary --------------------------------------------------------- #

def test_moves_summary_met_les_ventes_en_premier(monkeypatch):
    _one_manager(monkeypatch)
    _write_cache(monkeypatch, {"berkshire": {
        "fetched_at": "2026-08-24T10:00:00", "fetched_ts": 1000.0,
        "snapshot": _snapshot(exits=["KROGER CO"], decreased=["COCA COLA CO"],
                              new=["NVIDIA CORP"], increased=["APPLE INC"]),
    }})
    actions = [row["action"] for row in w.moves_summary()]
    assert actions == ["sortie", "allégé", "nouveau", "renforcé"]


def test_moves_summary_porte_le_gerant_le_trimestre_et_le_delta(monkeypatch):
    _one_manager(monkeypatch)
    _write_cache(monkeypatch, {"berkshire": {
        "fetched_at": "2026-08-24T10:00:00", "fetched_ts": 1000.0,
        "snapshot": _snapshot(decreased=["COCA COLA CO"]),
    }})
    row = w.moves_summary()[0]
    assert row["manager_label"] == "Warren Buffett — Berkshire Hathaway"
    assert row["quarter"] == "T2 2026"
    assert row["name"] == "COCA COLA CO" and row["delta_pct"] == -20.0
    assert row["fetched_at"] == "2026-08-24T10:00:00"


def test_moves_summary_est_plafonne(monkeypatch):
    _one_manager(monkeypatch)
    _write_cache(monkeypatch, {"berkshire": {
        "fetched_at": "2026-08-24T10:00:00", "fetched_ts": 1000.0,
        "snapshot": _snapshot(exits=["NOM %d" % i for i in range(50)]),
    }})
    assert len(w.moves_summary()) == w.MOVES_SUMMARY_MAX
    assert len(w.moves_summary(limit=5)) == 5


def test_moves_summary_ignore_un_snapshot_qui_n_est_pas_ok(monkeypatch):
    _one_manager(monkeypatch)
    snap = _snapshot(exits=["KROGER CO"])
    snap["status"] = "error"
    _write_cache(monkeypatch, {"berkshire": {"fetched_ts": 1.0, "snapshot": snap}})
    assert w.moves_summary() == []


def test_moves_summary_sans_cache_rend_une_liste_vide(monkeypatch):
    _one_manager(monkeypatch)
    assert w.moves_summary() == []


def test_moves_summary_ne_fait_aucune_requete(monkeypatch):
    """Appelée à chaque fois que le coach réfléchit : elle doit être GRATUITE."""
    _one_manager(monkeypatch)

    def boom(*a, **kw):
        raise AssertionError("aucune requête SEC ne doit partir d'ici")

    monkeypatch.setattr(w, "_http_get", boom)
    _write_cache(monkeypatch, {"berkshire": {
        "fetched_ts": 1.0, "snapshot": _snapshot(exits=["KROGER CO"])}})
    assert len(w.moves_summary()) == 1


# --- rotation du cache ----------------------------------------------------- #

def test_stalest_manager_choisit_le_plus_perime(monkeypatch):
    monkeypatch.setattr(w, "MANAGERS", [
        {"id": "a", "label": "A", "cik": "1", "expect": "a"},
        {"id": "b", "label": "B", "cik": "2", "expect": "b"},
    ])
    now = 10 * 86400.0
    cache = {"a": {"fetched_ts": now - 2 * 86400},     # 2 jours
             "b": {"fetched_ts": now - 5 * 86400}}     # 5 jours
    assert w.stalest_manager(cache, now) == "b"


def test_stalest_manager_priorise_un_gerant_jamais_recupere(monkeypatch):
    monkeypatch.setattr(w, "MANAGERS", [
        {"id": "a", "label": "A", "cik": "1", "expect": "a"},
        {"id": "b", "label": "B", "cik": "2", "expect": "b"},
    ])
    now = 10 * 86400.0
    assert w.stalest_manager({"a": {"fetched_ts": now - 5 * 86400}}, now) == "b"


def test_stalest_manager_rend_none_quand_tout_est_frais(monkeypatch):
    monkeypatch.setattr(w, "MANAGERS", [
        {"id": "a", "label": "A", "cik": "1", "expect": "a"}])
    now = 10 * 86400.0
    assert w.stalest_manager({"a": {"fetched_ts": now - 60}}, now) is None


def test_le_guetteur_rafraichit_un_seul_gerant_par_cycle(monkeypatch):
    """Rotation DOUCE : la dizaine du catalogue est couverte en une demi-journée
    sans jamais envoyer de rafale à la SEC."""
    refreshed = []
    monkeypatch.setattr(w, "get_snapshot",
                        lambda mid, **kw: refreshed.append(mid) or {"status": "ok"})
    monkeypatch.setattr(w, "_fire_convergence", lambda **kw: False)
    monkeypatch.setattr(w, "MANAGERS", [
        {"id": "a", "label": "A", "cik": "1", "expect": "a"},
        {"id": "b", "label": "B", "cik": "2", "expect": "b"}])
    counters = {"errors": 0}
    _REAL_WARM_CACHE([], {}, 10 * 86400.0, None, None, counters)
    assert len(refreshed) == 1


def test_un_depot_frais_rafraichit_ce_gerant_la(monkeypatch):
    refreshed = []
    monkeypatch.setattr(w, "get_snapshot",
                        lambda mid, **kw: refreshed.append(mid) or {"status": "ok"})
    _REAL_WARM_CACHE(["scion"], {}, 10 * 86400.0, None, None, {"errors": 0})
    assert refreshed == ["scion"]


def test_un_rafraichissement_en_panne_est_compte_pas_propage(monkeypatch):
    def boom(mid, **kw):
        raise RuntimeError("SEC muette")

    monkeypatch.setattr(w, "get_snapshot", boom)
    counters = {"errors": 0}
    _REAL_WARM_CACHE(["scion"], {}, 10 * 86400.0, None, None, counters)
    assert counters["errors"] == 1


# --- mode calme + convergence --------------------------------------------- #

def test_le_guetteur_se_tait_en_mode_calme_mais_journalise(monkeypatch):
    _one_manager(monkeypatch)
    routes = _watch_routes([("13F-HR", "a1", "2026-08-14", "2026-06-30")])
    w.check_new_filings(mode="tout", client=FakeClient(routes),
                        notifier=FakeNotifier(), tg_cfg=TG, sleep=Recorder(),
                        now=_ts_of("2026-08-20"))          # amorçage

    routes2 = _watch_routes([("13F-HR", "a1", "2026-08-14", "2026-06-30"),
                             ("13F-HR", "a2", "2026-08-19", "2026-06-30")])
    notifier = FakeNotifier()
    out = w.check_new_filings(mode="calme", client=FakeClient(routes2),
                              notifier=notifier, tg_cfg=TG, sleep=Recorder(),
                              now=_ts_of("2026-08-20"))
    assert notifier.sent == []                  # silence
    assert out["notified"] == 0 and out["new_filings"] == 1
    events = w.recent_filing_events(now=_ts_of("2026-08-20"))
    assert len(events) == 1 and events[0]["muted"] is True


def test_le_guetteur_consulte_la_convergence(monkeypatch):
    _one_manager(monkeypatch)
    seen = {}

    def converge(notifier=None, tg_cfg=None):
        seen["tg_cfg"] = tg_cfg
        return {"fired": True, "sent": True}

    out = w.check_new_filings(mode="tout", client=FakeClient(_watch_routes([])),
                              notifier=FakeNotifier(), tg_cfg=TG,
                              sleep=Recorder(), now=1000.0, converge=converge)
    assert out["convergence_fired"] is True
    assert out["notified"] == 1 and seen["tg_cfg"] == TG


def test_une_convergence_en_panne_ne_casse_pas_la_ronde(monkeypatch):
    _one_manager(monkeypatch)

    def boom(**kwargs):
        raise RuntimeError("convergence cassée")

    out = w.check_new_filings(mode="tout", client=FakeClient(_watch_routes([])),
                              notifier=FakeNotifier(), tg_cfg=TG,
                              sleep=Recorder(), now=1000.0, converge=boom)
    assert out["convergence_fired"] is False and out["errors"] == 1


# =========================================================================== #
#  Volet « SES titres » — les 8-K des ancres de l'utilisateur (W2b)
#
#  Le guetteur savait dire « Buffett a déposé quelque chose » et restait muet
#  sur « ta position vient de publier un événement matériel » — alors que c'est
#  ce second cas qui bouge son argent.
# =========================================================================== #

AAPL_CIK = "0000320193"
AAPL_SUBM = "https://data.sec.gov/submissions/CIK0000320193.json"

# Forme MESURÉE le 26/08 sur ``company_tickers.json`` (200 OK, 10 388 entrées).
TICKERS_PAYLOAD = {
    "0": {"cik_str": 1045810, "ticker": "NVDA", "title": "NVIDIA CORP"},
    "1": {"cik_str": 320193, "ticker": "AAPL", "title": "Apple Inc."},
    "2": {"cik_str": 789019, "ticker": "MSFT", "title": "MICROSOFT CORP"},
}


def _own_subm(filings, name="Apple Inc."):
    """``filings`` = [(form, accession, filingDate)]"""
    return {
        "name": name,
        "cik": "320193",
        "filings": {"recent": {
            "form": [f[0] for f in filings],
            "accessionNumber": [f[1] for f in filings],
            "filingDate": [f[2] for f in filings],
            "reportDate": ["" for _ in filings],
        }},
    }


def _own_routes(filings, tickers=None):
    return {
        w.TICKERS_URL: TICKERS_PAYLOAD if tickers is None else tickers,
        AAPL_SUBM: _own_subm(filings),
    }


def _anchors(positions=(), watchlist=(), pipeline=(), username="massii"):
    """Écrit de vraies ancres sur le disque isolé (portefeuille, watchlist,
    tableau) — le volet les découvre par les mêmes lecteurs que la prod."""
    from backend.bots.paper import board, store
    store.save_portfolio(username, {
        "cash": 1000.0,
        "positions": [{"symbol": s, "side": "long", "qty": 1, "avg_price": 1.0}
                      for s in positions],
        "trades": [],
    })
    if watchlist:
        store.save_watchlist(username, [{"symbol": s, "name": s} for s in watchlist])
    if pipeline:
        board.save_board(username, {
            "pipeline": [{"id": s.lower(), "symbol": s, "thesis": "",
                          "source": "coach"} for s in pipeline],
            "scenarios": [],
        })


def _memory_events():
    """Ce que la MÉMOIRE DE LA VEILLE contient — la lecture qu'utilisent le
    contexte du coach, la toile et la convergence."""
    from backend.bots.paper import newswatch
    return list(newswatch._load_global_seen().get("events") or [])


def _no_managers(monkeypatch):
    monkeypatch.setattr(w, "MANAGERS", [])


# --- PUR : table des symboles et rotation ---------------------------------- #

def test_parse_ticker_map_reads_the_measured_shape():
    mapping = w.parse_ticker_map(TICKERS_PAYLOAD)
    assert mapping["AAPL"] == "0000320193"        # CIK sur 10 chiffres
    assert mapping["NVDA"] == "0001045810"
    assert len(mapping) == 3


def test_parse_ticker_map_tolerates_a_list_and_skips_junk():
    mapping = w.parse_ticker_map([
        {"cik_str": 320193, "ticker": "aapl"},     # minuscules -> normalisé
        {"cik_str": 1, "ticker": ""},              # sans symbole
        {"ticker": "XXX"},                         # sans CIK
        "pas un dictionnaire",
    ])
    assert mapping == {"AAPL": "0000320193"}


def test_parse_ticker_map_keeps_the_first_of_a_duplicate():
    """La table est ordonnée par capitalisation décroissante : en cas de
    doublon, c'est le gros émetteur qu'on veut."""
    mapping = w.parse_ticker_map({
        "0": {"cik_str": 111, "ticker": "DUP"},
        "1": {"cik_str": 222, "ticker": "DUP"},
    })
    assert mapping["DUP"] == "0000000111"


@pytest.mark.parametrize("cursor,expected,next_cursor", [
    (None, ["A", "B"], 2),
    (0, ["A", "B"], 2),
    (2, ["C", "D"], 0),                            # boucle
    (3, ["D", "A"], 1),                            # chevauche la fin
    ("pas un nombre", ["A", "B"], 2),
    (99, ["A", "B"], 2),                           # hors bornes -> repart de 0
])
def test_next_own_targets_rotates_in_a_circle(cursor, expected, next_cursor):
    picked, after = w.next_own_targets(["A", "B", "C", "D"], cursor, per_cycle=2)
    assert picked == expected and after == next_cursor


def test_next_own_targets_on_an_empty_list():
    assert w.next_own_targets([], 3) == ([], 0)


def test_next_own_targets_never_asks_for_more_than_there_is():
    picked, after = w.next_own_targets(["A"], 0, per_cycle=2)
    assert picked == ["A"] and after == 0          # jamais deux fois le même


def test_own_anchors_merges_positions_watchlist_and_pipeline():
    _anchors(positions=["AAPL"], watchlist=["MSFT", "AAPL"], pipeline=["NVDA"])
    # Les positions d'abord (l'argent engagé), et jamais de doublon.
    assert w.own_anchors() == ["AAPL", "MSFT", "NVDA"]


def test_own_anchors_without_any_account():
    assert w.own_anchors() == []


def test_the_notification_explains_the_form_to_a_holder():
    """⚠️ ``form_explanation`` (celle des gérants) ne connaît que les
    13F/13D/13G/4 : elle rendrait « Nouveau dépôt SEC » pour un 8-K, une ligne
    qui n'apprend rien à qui détient le titre."""
    text = w._own_notification_text("AAPL", "8-K", "2026-08-25", "https://x/i.htm")
    assert "AAPL — 8-K déposé (événement matériel)" in text
    assert "changement de dirigeant" in text
    assert w.form_explanation("8-K") not in text     # surtout PAS celle-là
    assert "https://x/i.htm" in text
    assert "Comptes du trimestre" in w.own_form_note("10-Q")
    assert "Comptes de l\'année" in w.own_form_note("10-K")
    assert "émetteur étranger" in w.own_form_note("6-K")


def test_own_event_title_is_readable_without_knowing_the_sec():
    assert w.own_event_title("aapl", "8-K") == "AAPL — 8-K déposé (événement matériel)"
    assert "rapport trimestriel" in w.own_event_title("AAPL", "10-Q")
    assert "rapport annuel" in w.own_event_title("AAPL", "10-K")
    assert "émetteur étranger" in w.own_event_title("NVO", "6-K")


def test_filing_index_url_is_the_measured_form():
    """Forme vérifiée le 26/08 : 200 sur ce dépôt Apple réel."""
    assert w.filing_index_url(AAPL_CIK, "0000320193-26-000018") == (
        "https://www.sec.gov/Archives/edgar/data/320193/000032019326000018/"
        "0000320193-26-000018-index.htm")


# --- Table des symboles : cache 7 jours ------------------------------------ #

def test_the_ticker_map_is_cached_for_seven_days():
    client = FakeClient({w.TICKERS_URL: TICKERS_PAYLOAD})
    first = w.load_ticker_map(client=client, now=1000.0)
    assert first["AAPL"] == "0000320193"
    assert client.calls == [w.TICKERS_URL]
    assert oct(w.tickers_path().stat().st_mode & 0o777) == "0o600"

    # Six jours plus tard : toujours le cache, zéro requête de plus.
    again = w.load_ticker_map(client=client, now=1000.0 + 6 * 86400)
    assert again == first
    assert client.calls == [w.TICKERS_URL]

    # Huit jours : la table est re-téléchargée.
    w.load_ticker_map(client=client, now=1000.0 + 8 * 86400)
    assert client.calls == [w.TICKERS_URL, w.TICKERS_URL]


def test_a_dead_ticker_source_serves_the_stale_map():
    client = FakeClient({w.TICKERS_URL: TICKERS_PAYLOAD})
    w.load_ticker_map(client=client, now=1000.0)
    dead = FakeClient({w.TICKERS_URL: RuntimeError("sec down")})
    assert w.load_ticker_map(client=dead, now=1000.0 + 9 * 86400)["AAPL"] \
        == "0000320193"


def test_without_any_map_at_all_the_result_is_empty_not_an_error():
    dead = FakeClient({w.TICKERS_URL: RuntimeError("sec down")})
    assert w.load_ticker_map(client=dead, now=1000.0) == {}


def test_the_cache_files_are_not_mistaken_for_user_accounts(monkeypatch):
    """Les fichiers de MODULE de ce lot portent un point dans leur radical :
    sans ça, ``radar._users_with_portfolio`` les recenserait comme des comptes
    et la convergence leur écrirait un carnet (utilisateurs fantômes — le dépôt
    a déjà payé ce bug deux fois)."""
    from backend.bots.paper import agenda_bridge, radar
    w.load_ticker_map(client=FakeClient({w.TICKERS_URL: TICKERS_PAYLOAD}),
                      now=1000.0)
    monkeypatch.setattr(agenda_bridge, "DATA_DIR", w.DATA_DIR)
    # On écrit le cache de l'agenda par son propre écrivain (la fixture
    # ``_no_side_channels`` double ``upcoming_events``, qui n'écrirait rien).
    agenda_bridge._atomic_write_json(agenda_bridge.cache_path(),
                                     {"fetched_ts": 1000.0, "events": []})
    assert agenda_bridge.cache_path().is_file()
    _anchors(positions=["AAPL"])
    assert "." in w.tickers_path().stem
    assert "." in agenda_bridge.CACHE_NAME[:-len(".json")]
    assert w.tickers_path().is_file()
    assert radar._users_with_portfolio() == ["massii"]


# --- La ronde : détection, amorçage, mode calme ---------------------------- #

RECENT = "2026-08-25"                              # frais au regard de NOW_TS
NOW_TS = datetime(2026, 8, 26, 9, 0, 0).timestamp()


def test_own_volet_first_pass_seeds_silently(monkeypatch):
    """Anti-tempête : au premier passage d'un titre, tout est marqué vu et RIEN
    n'est notifié ni mémorisé."""
    _no_managers(monkeypatch)
    _anchors(positions=["AAPL"])
    notifier = FakeNotifier()
    out = w.check_new_filings(mode="tout", client=FakeClient(_own_routes([
        ("8-K", "acc-1", RECENT), ("10-Q", "acc-2", RECENT)])),
        notifier=notifier, tg_cfg=TG, sleep=Recorder(), now=NOW_TS)
    assert out["own_checked"] == 1 and out["own_filings"] == 0
    assert notifier.sent == [] and _memory_events() == []
    state = json.loads(w.watch_path().read_text(encoding="utf-8"))
    assert state["own_seeded"]["AAPL"] is True
    assert sorted(state["own_seen"]["AAPL"]) == ["acc-1", "acc-2"]


def test_own_volet_remembers_a_new_8k_on_the_second_pass(monkeypatch):
    _no_managers(monkeypatch)
    _anchors(positions=["AAPL"])
    notifier = FakeNotifier()
    w.check_new_filings(mode="tout", client=FakeClient(_own_routes([
        ("10-Q", "vieux", "2026-08-01")])),
        notifier=notifier, tg_cfg=TG, sleep=Recorder(), now=NOW_TS)

    out = w.check_new_filings(mode="tout", client=FakeClient(_own_routes([
        ("8-K", "frais", RECENT), ("10-Q", "vieux", "2026-08-01")])),
        notifier=notifier, tg_cfg=TG, sleep=Recorder(), now=NOW_TS)
    assert out["own_filings"] == 1 and out["notified"] == 1

    events = _memory_events()
    assert len(events) == 1
    event = events[0]
    assert event["symbol"] == "AAPL"
    assert event["src"] == "sec_own"
    assert event["sentiment"] == "watch"
    assert event["title"] == "AAPL — 8-K déposé (événement matériel)"
    assert event["link"].endswith("frais-index.htm")
    assert event["muted"] is False
    assert "8-K" in notifier.sent[0][0] and event["link"] in notifier.sent[0][0]


def test_own_volet_stays_mute_in_calm_mode_but_still_remembers(monkeypatch):
    """Mode calme : la détection reste ENTIÈRE (mémoire, toile, convergence),
    seul l'envoi disparaît. Seule la convergence parle."""
    _no_managers(monkeypatch)
    _anchors(positions=["AAPL"])
    notifier = FakeNotifier()
    w.check_new_filings(mode="calme", client=FakeClient(_own_routes([])),
                        notifier=notifier, tg_cfg=TG, sleep=Recorder(), now=NOW_TS)
    out = w.check_new_filings(mode="calme", client=FakeClient(_own_routes([
        ("8-K", "frais", RECENT)])),
        notifier=notifier, tg_cfg=TG, sleep=Recorder(), now=NOW_TS)
    assert out["own_filings"] == 1 and out["notified"] == 0
    assert notifier.sent == []
    assert _memory_events()[0]["muted"] is True


def test_own_volet_ignores_an_antique_filing(monkeypatch):
    """Même garde d'âge absolue que les dépôts de gérants (incident du 25/08) :
    un 8-K de 2011 est marqué vu et rien d'autre."""
    _no_managers(monkeypatch)
    _anchors(positions=["AAPL"])
    w.check_new_filings(mode="tout", client=FakeClient(_own_routes([])),
                        notifier=FakeNotifier(), tg_cfg=TG, sleep=Recorder(),
                        now=NOW_TS)
    out = w.check_new_filings(mode="tout", client=FakeClient(_own_routes([
        ("8-K", "antique", "2011-05-16")])),
        notifier=FakeNotifier(), tg_cfg=TG, sleep=Recorder(), now=NOW_TS)
    assert out["own_filings"] == 0 and _memory_events() == []
    state = json.loads(w.watch_path().read_text(encoding="utf-8"))
    assert "antique" in state["own_seen"]["AAPL"]   # vu, donc plus jamais revu


def test_a_non_us_symbol_is_skipped_and_counted(monkeypatch):
    """``NESN.SW`` n'est pas dans le registre de la SEC — ce n'est ni une
    erreur ni un silence, c'est un compteur."""
    _no_managers(monkeypatch)
    _anchors(positions=["NESN.SW"])
    client = FakeClient(_own_routes([]))
    out = w.check_new_filings(mode="tout", client=client, notifier=FakeNotifier(),
                              tg_cfg=TG, sleep=Recorder(), now=NOW_TS)
    assert out["own_non_us"] == 1
    assert out["own_checked"] == 0 and out["errors"] == 0
    assert AAPL_SUBM not in client.calls            # aucune requête gaspillée


def test_the_volet_rotates_across_cycles(monkeypatch):
    """Une à deux ancres par cycle : un portefeuille de quatre titres est
    balayé en deux cycles, sans jamais marteler la SEC."""
    _no_managers(monkeypatch)
    _anchors(positions=["AAPL", "MSFT"], watchlist=["NVDA"])
    seen_calls = []
    routes = dict(_own_routes([]))
    for cik in ("0000789019", "0001045810"):
        routes["https://data.sec.gov/submissions/CIK%s.json" % cik] = _own_subm([])

    for _ in range(2):
        client = FakeClient(routes)
        w.check_new_filings(mode="tout", client=client, notifier=FakeNotifier(),
                            tg_cfg=TG, sleep=Recorder(), now=NOW_TS)
        seen_calls.append([c for c in client.calls if "submissions" in c])

    assert len(seen_calls[0]) == 2                  # AAPL + MSFT
    assert seen_calls[1] != seen_calls[0]           # puis NVDA (rotation)
    state = json.loads(w.watch_path().read_text(encoding="utf-8"))
    assert sorted(state["own_seeded"]) == ["AAPL", "MSFT", "NVDA"]


def test_no_anchor_means_no_request_at_all(monkeypatch):
    """Un compte vide ne doit rien coûter à la SEC — pas même la table des
    symboles."""
    _no_managers(monkeypatch)
    client = FakeClient(_own_routes([]))
    out = w.check_new_filings(mode="tout", client=client, notifier=FakeNotifier(),
                              tg_cfg=TG, sleep=Recorder(), now=NOW_TS)
    assert client.calls == []
    assert out["own_checked"] == 0 and out["own_non_us"] == 0


def test_a_broken_symbol_counts_an_error_and_does_not_kill_the_round(monkeypatch):
    _no_managers(monkeypatch)
    _anchors(positions=["AAPL"])
    routes = dict(_own_routes([]))
    routes[AAPL_SUBM] = RuntimeError("sec down")
    out = w.check_new_filings(mode="tout", client=FakeClient(routes),
                              notifier=FakeNotifier(), tg_cfg=TG,
                              sleep=Recorder(), now=NOW_TS)
    assert out["errors"] == 1 and out["own_checked"] == 0


def test_seen_is_only_written_once_the_memory_accepted_the_event(monkeypatch):
    """Deux processus écrivent la mémoire de la veille. Si l'écriture échoue,
    le dépôt NE DOIT PAS être marqué vu — sinon il serait perdu pour toujours
    au lieu de revenir au cycle suivant."""
    _no_managers(monkeypatch)
    _anchors(positions=["AAPL"])
    w.check_new_filings(mode="tout", client=FakeClient(_own_routes([])),
                        notifier=FakeNotifier(), tg_cfg=TG, sleep=Recorder(),
                        now=NOW_TS)
    monkeypatch.setattr(w, "remember_events", lambda events: False)
    w.check_new_filings(mode="tout", client=FakeClient(_own_routes([
        ("8-K", "frais", RECENT)])),
        notifier=FakeNotifier(), tg_cfg=TG, sleep=Recorder(), now=NOW_TS)
    state = json.loads(w.watch_path().read_text(encoding="utf-8"))
    assert "frais" not in (state["own_seen"].get("AAPL") or [])


def test_the_own_volet_is_off_when_telegram_is_off(monkeypatch):
    _no_managers(monkeypatch)
    _anchors(positions=["AAPL"])
    client = FakeClient(_own_routes([("8-K", "frais", RECENT)]))
    out = w.check_new_filings(mode="tout", client=client, notifier=FakeNotifier(),
                              tg_cfg={}, sleep=Recorder(), now=NOW_TS)
    assert client.calls == [] and out == counters()


def test_a_watch_on_a_held_symbol_lights_the_held_catalyst_factor(monkeypatch):
    """Le point d'arrivée du volet : la convergence doit COMPTER ce 8-K comme un
    catalyseur sur un titre détenu. C'est le sentiment ``watch`` + le symbole
    qui l'allument — vérifié, pas supposé."""
    from backend.bots.paper import convergence
    _no_managers(monkeypatch)
    _anchors(positions=["AAPL"])
    w.check_new_filings(mode="calme", client=FakeClient(_own_routes([])),
                        notifier=FakeNotifier(), tg_cfg=TG, sleep=Recorder(),
                        now=NOW_TS)
    w.check_new_filings(mode="calme", client=FakeClient(_own_routes([
        ("8-K", "frais", RECENT)])),
        notifier=FakeNotifier(), tg_cfg=TG, sleep=Recorder(), now=NOW_TS)

    now_iso = datetime.fromtimestamp(NOW_TS).isoformat()
    collected = convergence.collect_factors(
        now_iso, [], _memory_events(), [], ["AAPL"], held_symbols=["AAPL"])
    assert collected["factors"]["held_catalyst"] is True


def test_the_8k_lands_on_the_branch_of_its_own_stock_in_the_web(monkeypatch):
    """Dans la toile, un ``sec_own`` porte un symbole et une tonalité
    ``watch`` : il devient un CATALYSEUR accroché à la branche de ce titre —
    la famille « presse », via le type existant."""
    from backend.bots.paper import graph
    _no_managers(monkeypatch)
    _anchors(positions=["AAPL"])
    w.check_new_filings(mode="calme", client=FakeClient(_own_routes([])),
                        notifier=FakeNotifier(), tg_cfg=TG, sleep=Recorder(),
                        now=NOW_TS)
    w.check_new_filings(mode="calme", client=FakeClient(_own_routes([
        ("8-K", "frais", RECENT)])),
        notifier=FakeNotifier(), tg_cfg=TG, sleep=Recorder(), now=NOW_TS)

    now_iso = datetime.fromtimestamp(NOW_TS).isoformat()
    built = graph.build_graph([{"symbol": "AAPL", "kind": "position"}],
                              _memory_events(), [], [], [], now_iso)
    node = [n for n in built["nodes"] if n.get("type") == "catalyst"]
    assert len(node) == 1 and node[0]["symbol"] == "AAPL"
    assert graph._FAMILY_OF["catalyst"] == "press"
    # L'ancre d'un titre porte son symbole pour identifiant (cf. ``_collect``).
    assert any("AAPL" in (e["target"], e["source"]) for e in built["edges"])


# =========================================================================== #
#  Volet AGENDA — les rendez-vous des banques centrales (W2b)
# =========================================================================== #

def _agenda(rows):
    """Un fournisseur d'agenda injecté (le pont réel est doublé par la fixture
    ``_no_side_channels`` — ici on passe par le paramètre ``agenda=``)."""
    def provider(now=None, horizon_days=None):
        return list(rows)
    return provider


FED = {"date": "2026-08-28", "bank": "Fed",
       "label": "Fed — riunione del FOMC (27-28 agosto)",
       "source_url": "https://fed.test/cal"}
BCE = {"date": "2026-08-31", "bank": "BCE",
       "label": "BCE — riunione di politica monetaria (decisione)",
       "source_url": "https://ecb.test/cal"}


def test_agenda_key_is_the_bank_and_the_day():
    assert w.agenda_event_key(FED) == "fed|2026-08-28"
    assert w.agenda_event_key({"bank": "", "date": "2026-08-28"}) == ""
    assert w.agenda_event_key({"bank": "Fed", "date": ""}) == ""
    assert w.agenda_event_key("pas un dict") == ""


def test_agenda_first_pass_seeds_silently(monkeypatch):
    _no_managers(monkeypatch)
    notifier = FakeNotifier()
    out = w.check_new_filings(mode="tout", client=FakeClient({}), notifier=notifier,
                              tg_cfg=TG, sleep=Recorder(), now=NOW_TS,
                              agenda=_agenda([FED, BCE]))
    assert out["agenda_events"] == 0 and notifier.sent == []
    assert _memory_events() == []
    state = json.loads(w.watch_path().read_text(encoding="utf-8"))
    assert state["agenda_seeded"] is True
    assert sorted(state["agenda_seen"]) == ["bce|2026-08-31", "fed|2026-08-28"]


def test_agenda_emits_a_new_meeting_once_only(monkeypatch):
    _no_managers(monkeypatch)
    notifier = FakeNotifier()
    w.check_new_filings(mode="tout", client=FakeClient({}), notifier=notifier,
                        tg_cfg=TG, sleep=Recorder(), now=NOW_TS,
                        agenda=_agenda([FED]))                 # amorçage

    out = w.check_new_filings(mode="tout", client=FakeClient({}), notifier=notifier,
                              tg_cfg=TG, sleep=Recorder(), now=NOW_TS,
                              agenda=_agenda([FED, BCE]))
    assert out["agenda_events"] == 1                            # BCE seulement
    event = _memory_events()[0]
    assert event["title"] == BCE["label"]
    assert event["symbol"] is None                              # « held-rien »
    assert event["sentiment"] == "watch"
    assert event["agenda"] is True and event["bank"] == "BCE"
    assert event["link"] == ""                                  # cf. dédup
    assert BCE["source_url"] in notifier.sent[0][0]             # mais vérifiable

    # Troisième cycle, même agenda : plus rien (dédoublonnage par banque+jour).
    again = w.check_new_filings(mode="tout", client=FakeClient({}),
                                notifier=notifier, tg_cfg=TG, sleep=Recorder(),
                                now=NOW_TS, agenda=_agenda([FED, BCE]))
    assert again["agenda_events"] == 0 and len(_memory_events()) == 1


def test_agenda_is_mute_in_calm_mode_but_still_remembered(monkeypatch):
    _no_managers(monkeypatch)
    notifier = FakeNotifier()
    w.check_new_filings(mode="calme", client=FakeClient({}), notifier=notifier,
                        tg_cfg=TG, sleep=Recorder(), now=NOW_TS,
                        agenda=_agenda([FED]))
    out = w.check_new_filings(mode="calme", client=FakeClient({}), notifier=notifier,
                              tg_cfg=TG, sleep=Recorder(), now=NOW_TS,
                              agenda=_agenda([FED, BCE]))
    assert out["agenda_events"] == 1 and notifier.sent == []
    assert _memory_events()[0]["muted"] is True


def test_an_empty_agenda_never_wipes_the_memory_of_what_was_seen(monkeypatch):
    """Cinq banques centrales muettes en même temps, c'est un incident réseau —
    repartir de zéro rejouerait tous les rendez-vous au cycle suivant."""
    _no_managers(monkeypatch)
    w.check_new_filings(mode="tout", client=FakeClient({}), notifier=FakeNotifier(),
                        tg_cfg=TG, sleep=Recorder(), now=NOW_TS,
                        agenda=_agenda([FED]))
    w.check_new_filings(mode="tout", client=FakeClient({}), notifier=FakeNotifier(),
                        tg_cfg=TG, sleep=Recorder(), now=NOW_TS,
                        agenda=_agenda([]))
    state = json.loads(w.watch_path().read_text(encoding="utf-8"))
    assert state["agenda_seen"] == {"fed|2026-08-28": "2026-08-28"}


def test_a_past_meeting_leaves_the_memory_by_itself(monkeypatch):
    """La mémoire est REMPLACÉE par l'horizon courant : un rendez-vous qui a eu
    lieu en sort tout seul, et ne peut pas revenir (le pont ne rend jamais une
    date passée). La mémoire reste donc bornée sans purge explicite."""
    _no_managers(monkeypatch)
    w.check_new_filings(mode="tout", client=FakeClient({}), notifier=FakeNotifier(),
                        tg_cfg=TG, sleep=Recorder(), now=NOW_TS,
                        agenda=_agenda([FED, BCE]))
    w.check_new_filings(mode="tout", client=FakeClient({}), notifier=FakeNotifier(),
                        tg_cfg=TG, sleep=Recorder(), now=NOW_TS,
                        agenda=_agenda([BCE]))                  # la Fed est passée
    state = json.loads(w.watch_path().read_text(encoding="utf-8"))
    assert list(state["agenda_seen"]) == ["bce|2026-08-31"]


def test_a_broken_agenda_never_breaks_the_round(monkeypatch):
    _no_managers(monkeypatch)

    def boom(**kwargs):
        raise RuntimeError("banques centrales injoignables")

    out = w.check_new_filings(mode="tout", client=FakeClient({}),
                              notifier=FakeNotifier(), tg_cfg=TG,
                              sleep=Recorder(), now=NOW_TS, agenda=boom)
    assert out["agenda_events"] == 0 and out["errors"] == 0


def test_a_central_bank_meeting_lands_under_the_world_pivot(monkeypatch):
    """Le point d'arrivée du volet : dans la toile, une réunion ne nomme aucun
    titre — elle doit donc rejoindre le pivot « monde », famille macro, et NON
    être omise comme une dépêche orpheline (règle 5 de ``graph._dispatch``)."""
    from backend.bots.paper import graph
    _no_managers(monkeypatch)
    w.check_new_filings(mode="calme", client=FakeClient({}), notifier=FakeNotifier(),
                        tg_cfg=TG, sleep=Recorder(), now=NOW_TS,
                        agenda=_agenda([FED]))
    w.check_new_filings(mode="calme", client=FakeClient({}), notifier=FakeNotifier(),
                        tg_cfg=TG, sleep=Recorder(), now=NOW_TS,
                        agenda=_agenda([FED, BCE]))

    now_iso = datetime.fromtimestamp(NOW_TS).isoformat()
    built = graph.build_graph([{"symbol": "AAPL", "kind": "position"}],
                              _memory_events(), [], [], [], now_iso)
    node = [n for n in built["nodes"] if n.get("label") == BCE["label"]]
    assert len(node) == 1
    assert node[0]["type"] in graph.PIVOT_TYPES         # macro, pas « presse »
    assert graph._FAMILY_OF[node[0]["type"]] == "eco"
    assert any(e["target"] == graph.WORLD_ID or e["source"] == graph.WORLD_ID
               for e in built["edges"])


def test_two_meetings_of_the_same_bank_stay_two_nodes(monkeypatch):
    """Pourquoi le lien de l'événement est VIDE : la mémoire dédoublonne par
    lien, et deux réunions de la Fed partagent la même page de calendrier —
    écrire ce lien fusionnerait septembre et octobre en un seul nœud."""
    from backend.bots.paper import graph
    _no_managers(monkeypatch)
    second = dict(FED, date="2026-09-30",
                  label="Fed — riunione del FOMC (29-30 settembre)")
    # L'amorçage muet porte sur une AUTRE banque : les deux réunions de la Fed
    # doivent toutes les deux être neuves au cycle suivant.
    w.check_new_filings(mode="calme", client=FakeClient({}), notifier=FakeNotifier(),
                        tg_cfg=TG, sleep=Recorder(), now=NOW_TS, agenda=_agenda([BCE]))
    w.check_new_filings(mode="calme", client=FakeClient({}), notifier=FakeNotifier(),
                        tg_cfg=TG, sleep=Recorder(), now=NOW_TS,
                        agenda=_agenda([FED, second]))

    # ⚠️ Une ancre est nécessaire : sans elle la vue d'ensemble est VIDE (un
    # graphe montre des connexions, pas un décor). Ce n'est pas ce qu'on teste
    # ici, mais sans elle le test serait vert pour la mauvaise raison.
    now_iso = datetime.fromtimestamp(NOW_TS).isoformat()
    built = graph.build_graph([{"symbol": "AAPL", "kind": "position"}],
                              _memory_events(), [], [], [], now_iso)
    labels = {n.get("label") for n in built["nodes"]}
    assert FED["label"] in labels and second["label"] in labels


def test_an_agenda_that_is_empty_at_the_first_pass_does_not_count_as_seeding(monkeypatch):
    """L'amorçage muet vaut pour le premier agenda NON VIDE. Sinon un incident
    réseau au tout premier cycle brûlerait le seed, et le vrai premier agenda —
    celui qui arrive au cycle suivant — serait envoyé en entier d'un coup."""
    _no_managers(monkeypatch)
    w.check_new_filings(mode="tout", client=FakeClient({}), notifier=FakeNotifier(),
                        tg_cfg=TG, sleep=Recorder(), now=NOW_TS, agenda=_agenda([]))
    state = json.loads(w.watch_path().read_text(encoding="utf-8"))
    assert state["agenda_seeded"] is False

    out = w.check_new_filings(mode="tout", client=FakeClient({}),
                              notifier=FakeNotifier(), tg_cfg=TG, sleep=Recorder(),
                              now=NOW_TS, agenda=_agenda([FED, BCE]))
    assert out["agenda_events"] == 0                 # amorçage, enfin
    assert _memory_events() == []
