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
    """Cache et état du guetteur en tmp — jamais le vrai ``data/``."""
    monkeypatch.setattr(w, "DATA_DIR", tmp_path / "paper_trading")
    return tmp_path


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

def test_catalogue_shape_is_sane():
    assert len(w.MANAGERS) == 10
    ids = [m["id"] for m in w.MANAGERS]
    assert len(set(ids)) == 10
    for m in w.MANAGERS:
        assert len(m["cik"]) == 10 and m["cik"].isdigit()
        assert m["expect"] and m["expect"] == m["expect"].lower()
        # le mot clé de vérification doit être crédible face au label
        assert m["expect"] in m["label"].lower() or m["id"] == m["expect"]
    assert w.find_manager("scion")["label"].startswith("Michael Burry")
    assert w.find_manager("inconnu") is None


def test_list_managers_reports_the_cache_state():
    before = w.list_managers()
    assert len(before) == 10
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
    out = w.check_new_filings(client=client, notifier=notifier, tg_cfg={},
                              sleep=Recorder(), now=1000.0)
    assert out == {"managers": 0, "new_filings": 0, "notified": 0, "errors": 0}
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
    out = w.check_new_filings(client=client, notifier=notifier, tg_cfg=TG,
                              sleep=Recorder(), now=1000.0)
    assert out == {"managers": 1, "new_filings": 0, "notified": 0, "errors": 0}
    assert notifier.sent == []
    assert w.recent_filing_events() == []
    state = json.loads(w.watch_path().read_text(encoding="utf-8"))
    assert state["seeded"]["berkshire"] is True
    assert sorted(state["seen"]["berkshire"]) == ["a1", "a2", "a3"]
    assert oct(w.watch_path().stat().st_mode & 0o777) == "0o600"


def test_watcher_notifies_a_new_filing_on_the_second_pass(monkeypatch):
    _one_manager(monkeypatch)
    notifier = FakeNotifier()
    w.check_new_filings(client=FakeClient(_watch_routes([
        ("13F-HR", "old", "2026-05-15", "2026-03-31")])),
        notifier=notifier, tg_cfg=TG, sleep=Recorder(), now=1000.0)
    assert notifier.sent == []

    out = w.check_new_filings(client=FakeClient(_watch_routes([
        ("4", "brand-new", "2026-08-21", ""),
        ("13F-HR", "old", "2026-05-15", "2026-03-31")])),
        notifier=notifier, tg_cfg=TG, sleep=Recorder(), now=2000.0)
    assert out == {"managers": 1, "new_filings": 1, "notified": 1, "errors": 0}

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
    w.check_new_filings(client=FakeClient(_watch_routes(filings_v1)),
                        notifier=notifier, tg_cfg=TG, sleep=Recorder(), now=1.0)
    w.check_new_filings(client=FakeClient(_watch_routes(filings_v2)),
                        notifier=notifier, tg_cfg=TG, sleep=Recorder(), now=2.0)
    out = w.check_new_filings(client=FakeClient(_watch_routes(filings_v2)),
                              notifier=notifier, tg_cfg=TG, sleep=Recorder(), now=3.0)
    assert out["new_filings"] == 0 and out["notified"] == 0
    assert len(notifier.sent) == 1


def test_watcher_caps_at_three_notifications_but_marks_everything_seen(monkeypatch):
    _one_manager(monkeypatch)
    notifier = FakeNotifier()
    w.check_new_filings(client=FakeClient(_watch_routes([
        ("13F-HR", "old", "2026-05-15", "2026-03-31")])),
        notifier=notifier, tg_cfg=TG, sleep=Recorder(), now=1.0)

    many = [("4", "n%d" % i, "2026-08-2%d" % i, "") for i in range(5)]
    out = w.check_new_filings(client=FakeClient(_watch_routes(
        many + [("13F-HR", "old", "2026-05-15", "2026-03-31")])),
        notifier=notifier, tg_cfg=TG, sleep=Recorder(), now=2.0)
    assert out["new_filings"] == 5
    assert out["notified"] == w.MAX_NOTIFY_PER_MANAGER == 3
    assert len(notifier.sent) == 3
    # les 2 restants sont MARQUÉS VUS : ils ne repartiront pas au tour suivant
    again = w.check_new_filings(client=FakeClient(_watch_routes(
        many + [("13F-HR", "old", "2026-05-15", "2026-03-31")])),
        notifier=notifier, tg_cfg=TG, sleep=Recorder(), now=3.0)
    assert again["new_filings"] == 0 and again["notified"] == 0


def test_watcher_ignores_forms_outside_the_watch_list(monkeypatch):
    _one_manager(monkeypatch)
    notifier = FakeNotifier()
    w.check_new_filings(client=FakeClient(_watch_routes([
        ("4", "seed", "2026-01-01", "")])),
        notifier=notifier, tg_cfg=TG, sleep=Recorder(), now=1.0)
    out = w.check_new_filings(client=FakeClient(_watch_routes([
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
    out = w.check_new_filings(client=FakeClient(routes), notifier=FakeNotifier(),
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
    out = w.check_new_filings(client=FakeClient(_watch_routes([
        ("4", "a1", "2026-08-20", "")])),
        notifier=notifier, tg_cfg=TG, sleep=Recorder(), now=1.0)
    # état illisible -> on repart de zéro, donc ré-amorçage MUET (pas de tempête)
    assert out["managers"] == 1 and out["notified"] == 0
    assert notifier.sent == []
    assert json.loads(w.watch_path().read_text(encoding="utf-8"))["seeded"]


def test_a_failing_notifier_never_breaks_the_watch(monkeypatch):
    _one_manager(monkeypatch)
    boom = FakeNotifier(boom=True)
    w.check_new_filings(client=FakeClient(_watch_routes([
        ("13F-HR", "old", "2026-05-15", "2026-03-31")])),
        notifier=boom, tg_cfg=TG, sleep=Recorder(), now=1.0)
    out = w.check_new_filings(client=FakeClient(_watch_routes([
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
    w.check_new_filings(client=FakeClient(_watch_routes([])),
                        notifier=FakeNotifier(), tg_cfg=TG, sleep=sleeps, now=1.0)
    assert sleeps.calls == [w.PACE_S]           # 2 requêtes -> 1 attente


def test_events_are_capped_newest_first(monkeypatch):
    monkeypatch.setattr(w, "MAX_EVENTS", 2)
    _one_manager(monkeypatch)
    notifier = FakeNotifier()
    seed = [("13F-HR", "old", "2026-05-15", "2026-03-31")]
    w.check_new_filings(client=FakeClient(_watch_routes(seed)),
                        notifier=notifier, tg_cfg=TG, sleep=Recorder(), now=1.0)
    w.check_new_filings(client=FakeClient(_watch_routes(
        [("4", "n1", "2026-08-21", "")] + seed)),
        notifier=notifier, tg_cfg=TG, sleep=Recorder(), now=2.0)
    w.check_new_filings(client=FakeClient(_watch_routes(
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
    w.check_new_filings(client=FakeClient(_watch_routes([
        ("4", "seed", _at(3), "")])),
        notifier=notifier, tg_cfg=TG, sleep=Recorder(), now=INCIDENT_TS)
    assert notifier.sent == []                  # amorçage muet

    out = w.check_new_filings(client=FakeClient(_watch_routes([
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
    w.check_new_filings(client=FakeClient(_watch_routes([("4", "seed", _at(3), "")])),
                        notifier=FakeNotifier(), tg_cfg=TG, sleep=Recorder(),
                        now=INCIDENT_TS)
    w.check_new_filings(client=FakeClient(_watch_routes(filings)),
                        notifier=FakeNotifier(), tg_cfg=TG, sleep=Recorder(),
                        now=INCIDENT_TS)
    state = json.loads(w.watch_path().read_text(encoding="utf-8"))
    assert "antique" in state["seen"]["berkshire"]

    out = w.check_new_filings(client=FakeClient(_watch_routes(filings)),
                              notifier=FakeNotifier(), tg_cfg=TG,
                              sleep=Recorder(), now=INCIDENT_TS)
    assert out["new_filings"] == 0              # plus jamais « nouveau »


def test_un_depot_frais_sonne_toujours(monkeypatch):
    """Contre-épreuve : la garde d'âge ne doit pas avoir tué la fonctionnalité."""
    _one_manager(monkeypatch)
    notifier = FakeNotifier()
    w.check_new_filings(client=FakeClient(_watch_routes([("4", "seed", _at(3), "")])),
                        notifier=notifier, tg_cfg=TG, sleep=Recorder(),
                        now=INCIDENT_TS)
    out = w.check_new_filings(client=FakeClient(_watch_routes([
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

    w.check_new_filings(client=FakeClient(_watch_routes(filings)),
                        notifier=notifier, tg_cfg=TG, sleep=Recorder(),
                        now=INCIDENT_TS)                # amorçage
    state = json.loads(w.watch_path().read_text(encoding="utf-8"))
    assert len(state["seen"]["berkshire"]) == 5         # rien n'a été évincé

    out = w.check_new_filings(client=FakeClient(_watch_routes(filings)),
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
    out = w.check_new_filings(client=client, notifier=FakeNotifier(),
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
    w.check_new_filings(client=client, sleep=Recorder(), now=1000.0)   # amorçage muet
    client = FakeClient(_watch_routes([("4", "a2", "2026-08-21", ""),
                                       ("4", "a1", "2026-08-20", "")]))
    out = w.check_new_filings(client=client, sleep=Recorder(), now=2000.0)

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
    assert len(managers) == 10
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
