"""Tests du calendrier des rendez-vous (``paper/calendar.py``) — 100 % hors ligne.

Tout ce qui sort de la machine est injecté : horloge, agenda des banques
centrales, hypothèses du radar, dépêches de veille, cours. Aucun test ne
touche au réseau ni au vrai ``data/paper_trading/`` (``store.DATA_DIR`` pointe
sur ``tmp_path``, et ``calendar.state_path()`` le relit à chaque appel).

L'extracteur de dates a droit à un test PAR FORMAT et un test PAR CAS
D'AMBIGUÏTÉ : c'est la pièce qui peut, si elle se trompe, faire apparaître un
rendez-vous qui n'existe pas.
"""
import os
import stat
from datetime import datetime, timedelta

import pytest

from backend.bots.paper import calendar as cal
from backend.bots.paper import store

# Mercredi 27 août 2026, midi. Choisi une fois pour toutes : « September 17 »
# tombe alors à 21 jours (dans la fenêtre), « December 20 » à 115 (hors).
NOW = datetime(2026, 8, 27, 12, 0, 0)


# --------------------------------------------------------------------------- #
# Fixtures
# --------------------------------------------------------------------------- #

@pytest.fixture(autouse=True)
def _isolate_data_dir(tmp_path, monkeypatch):
    """Aucun test n'écrit dans le vrai data/paper_trading/."""
    monkeypatch.setattr(store, "DATA_DIR", tmp_path)
    return tmp_path


def _hyp(hid="h1", created=NOW, horizon=10, status="open",
         tickers=("AAPL",), direction="up", thesis="Apple monte"):
    return {"id": hid, "created_at": created.isoformat(), "horizon_days": horizon,
            "status": status, "tickers": list(tickers), "direction": direction,
            "thesis": thesis}


def _news(title, symbol="AAPL", sentiment="watch", link=None, ts=NOW):
    return {"ts": ts.isoformat(), "symbol": symbol, "title": title,
            "link": link if link is not None else "https://ex/%s" % abs(hash(title)),
            "sentiment": sentiment}


# --------------------------------------------------------------------------- #
# extract_date — un test par FORMAT accepté
# --------------------------------------------------------------------------- #

def test_extract_mois_complet():
    assert cal.extract_date("Apple earnings on September 17", NOW) == "2026-09-17"


def test_extract_abreviation_pointee():
    assert cal.extract_date("Sept. 17 results ahead", NOW) == "2026-09-17"


def test_extract_abreviation_avec_annee():
    assert cal.extract_date("Investor day set for Sep 17, 2026", NOW) == "2026-09-17"


def test_extract_ordinal():
    assert cal.extract_date("Earnings call September 17th", NOW) == "2026-09-17"


def test_extract_numerique_mois_jour_us():
    """Presse américaine -> 9/17 est le 17 SEPTEMBRE, jamais le 9 juillet."""
    assert cal.extract_date("Q3 earnings on 9/17", NOW) == "2026-09-17"


def test_extract_numerique_avec_annee_pleine():
    assert cal.extract_date("Guidance update 9/17/2026", NOW) == "2026-09-17"


def test_extract_numerique_avec_annee_courte():
    assert cal.extract_date("Guidance update 9/17/26", NOW) == "2026-09-17"


def test_extract_annee_implicite_bascule_sur_l_annee_suivante():
    """Sans année, on prend la première qui rend la date FUTURE."""
    december = datetime(2026, 12, 15, 9, 0, 0)
    assert cal.extract_date("Results due January 5", december) == "2027-01-05"


def test_extract_meme_date_repetee_n_est_pas_ambigue():
    """Deux mentions du MÊME jour désignent un seul rendez-vous."""
    title = "September 17 earnings: what to expect from the September 17 call"
    assert cal.extract_date(title, NOW) == "2026-09-17"


# --------------------------------------------------------------------------- #
# extract_date — futur seulement, horizon 90 jours
# --------------------------------------------------------------------------- #

def test_extract_date_passee_avec_annee_explicite_rend_none():
    assert cal.extract_date("Recap of the September 17, 2020 crash", NOW) is None


def test_extract_date_du_jour_meme_compte():
    """Un rendez-vous daté « au jour » vaut jusqu'à la fin de sa journée."""
    assert cal.extract_date("Results out August 27", NOW) == "2026-08-27"


def test_extract_date_d_hier_rend_none():
    yesterday = NOW + timedelta(days=1)      # on avance l'horloge d'un jour
    assert cal.extract_date("Results out August 27, 2026", yesterday) is None


def test_extract_horizon_90_jours_borne_incluse():
    """+90 jours passe, +91 non — la borne est vérifiée des deux côtés."""
    assert cal.extract_date("Capital markets day November 25", NOW) == "2026-11-25"
    assert cal.extract_date("Capital markets day November 26", NOW) is None


def test_extract_date_trop_lointaine_rend_none():
    assert cal.extract_date("Annual meeting December 20", NOW) is None


# --------------------------------------------------------------------------- #
# extract_date — AMBIGU => RIEN (un test par cas)
# --------------------------------------------------------------------------- #

def test_ambigu_deux_dates_rend_none():
    assert cal.extract_date("Earnings September 17 and October 3", NOW) is None


def test_ambigu_jour_nu_sans_mois_rend_none():
    assert cal.extract_date("Board meets on the 17 to decide", NOW) is None


def test_ambigu_annee_seule_rend_none():
    assert cal.extract_date("Outlook for 2026 remains cloudy", NOW) is None


def test_ambigu_mois_seul_rend_none():
    assert cal.extract_date("September could be volatile", NOW) is None


def test_ambigu_date_impossible_rend_none():
    assert cal.extract_date("Results due February 30", NOW) is None


def test_ambigu_date_impossible_meme_accompagnee_d_une_valide():
    """Une candidate irrésolue contamine tout le titre : on ne choisit pas."""
    assert cal.extract_date("February 30 and September 17 events", NOW) is None


def test_ambigu_pourcentage_n_est_pas_une_date():
    """« may 17% » a la forme d'une date et n'en est pas une."""
    assert cal.extract_date("Analysts say shares may 17% swing", NOW) is None


def test_titre_vide_rend_none():
    assert cal.extract_date("", NOW) is None
    assert cal.extract_date(None, NOW) is None


def test_titre_sans_date_rend_none():
    assert cal.extract_date("Apple beats expectations", NOW) is None


# --------------------------------------------------------------------------- #
# event_verdict — PUR
# --------------------------------------------------------------------------- #

def test_verdict_flop_presse_negative_et_baisse():
    assert cal.event_verdict(-4.0, ["neg"]) == "flop"


def test_verdict_confirme_presse_positive_et_hausse():
    assert cal.event_verdict(4.0, ["pos"]) == "confirme"


def test_verdict_seuil_des_deux_cotes_a_la_baisse():
    assert cal.event_verdict(-2.9, ["neg"]) == "mitige"
    assert cal.event_verdict(-3.0, ["neg"]) == "flop"


def test_verdict_seuil_des_deux_cotes_a_la_hausse():
    assert cal.event_verdict(2.9, ["pos"]) == "mitige"
    assert cal.event_verdict(3.0, ["pos"]) == "confirme"


def test_verdict_incoherent_presse_negative_et_hausse():
    assert cal.event_verdict(4.0, ["neg"]) == "mitige"


def test_verdict_incoherent_presse_positive_et_baisse():
    assert cal.event_verdict(-4.0, ["pos"]) == "mitige"


def test_verdict_sans_cours_est_mitige():
    assert cal.event_verdict(None, ["neg"]) == "mitige"


def test_verdict_presse_muette_est_mitige():
    """Un gros mouvement sans repère de presse ne se juge pas."""
    assert cal.event_verdict(-6.0, ["watch", "gov", "neutral"]) == "mitige"


def test_verdict_presse_contradictoire_est_mitige():
    assert cal.event_verdict(-6.0, ["pos", "neg"]) == "mitige"


def test_verdict_direction_down_qui_baisse_est_confirme():
    """LE cas de la spec : un pari « down » qui baisse n'est pas un flop."""
    assert cal.event_verdict(-4.0, [], "down") == "confirme"


def test_verdict_direction_down_qui_monte_est_flop():
    assert cal.event_verdict(4.0, [], "down") == "flop"


def test_verdict_direction_up_qui_monte_est_confirme():
    assert cal.event_verdict(4.0, [], "up") == "confirme"


def test_verdict_direction_up_qui_baisse_est_flop():
    assert cal.event_verdict(-4.0, [], "up") == "flop"


def test_verdict_direction_prime_sur_la_presse():
    """Un pari se juge sur le PRIX : la presse ne renverse pas le verdict."""
    assert cal.event_verdict(-4.0, ["pos"], "down") == "confirme"
    assert cal.event_verdict(4.0, ["neg"], "up") == "confirme"


def test_verdict_direction_mais_mouvement_plat_est_mitige():
    assert cal.event_verdict(1.0, ["neg"], "down") == "mitige"


def test_verdict_direction_inconnue_retombe_sur_la_presse():
    assert cal.event_verdict(-4.0, ["neg"], "lateral") == "flop"


def test_verdict_move_illisible_est_mitige():
    assert cal.event_verdict("pas un nombre", ["neg"]) == "mitige"
    assert cal.event_verdict(True, ["neg"]) == "mitige"


# --------------------------------------------------------------------------- #
# Assemblage des trois sources
# --------------------------------------------------------------------------- #

def test_upcoming_assemble_les_trois_sources_et_trie():
    bc = [{"date": "2026-09-10", "bank": "Fed", "label": "riunione del FOMC",
           "source_url": "https://fed"}]
    hyps = [_hyp(created=NOW, horizon=20)]                    # -> 2026-09-16
    news = [_news("Nvidia earnings on September 3", symbol="NVDA")]

    rows = cal.upcoming(NOW, bc_events=bc, hypotheses=hyps, events=news)

    assert [r["date"] for r in rows] == ["2026-09-03", "2026-09-10", "2026-09-16"]
    assert [r["kind"] for r in rows] == ["catalyst", "bc", "hypothesis"]
    # forme COMPLÈTE et stable : aucun champ optionnel
    for row in rows:
        assert set(row) == {"key", "kind", "date", "label", "source_id",
                            "symbol", "tickers", "direction"}
    assert rows[0]["symbol"] == "NVDA"
    assert rows[2]["direction"] == "up"
    assert rows[2]["tickers"] == ["AAPL"]
    assert rows[1]["symbol"] is None and rows[1]["tickers"] == []


def test_upcoming_dedoublonne_un_catalyseur_vu_deux_fois():
    """Deux journaux, un seul rendez-vous."""
    news = [
        _news("Apple earnings on September 17", link="https://reuters/1"),
        _news("Apple set to report September 17", link="https://cnbc/2"),
    ]
    rows = cal.upcoming(NOW, bc_events=[], hypotheses=[], events=news)
    assert len(rows) == 1


def test_upcoming_ne_fusionne_pas_deux_banques_centrales_le_meme_jour():
    """Une entrée « bc » n'a pas de symbole : dédoublonner par symbole les
    ferait fusionner (Fed + BoE le même jour, ça arrive)."""
    bc = [{"date": "2026-09-17", "bank": "Fed", "label": "riunione"},
          {"date": "2026-09-17", "bank": "BoE", "label": "riunione"}]
    rows = cal.upcoming(NOW, bc_events=bc, hypotheses=[], events=[])
    assert len(rows) == 2


def test_upcoming_ne_fusionne_pas_deux_paris_sur_le_meme_titre():
    """Deux thèses distinctes échéant le même jour = deux rendez-vous."""
    hyps = [_hyp(hid="h1", horizon=10, thesis="thèse A"),
            _hyp(hid="h2", horizon=10, thesis="thèse B")]
    rows = cal.upcoming(NOW, bc_events=[], hypotheses=hyps, events=[])
    assert len(rows) == 2
    assert {r["label"] for r in rows} == {"thèse A", "thèse B"}


def test_upcoming_ignore_les_hypotheses_closes():
    hyps = [_hyp(hid="open1", status="open"),
            _hyp(hid="scored1", status="scored"),
            _hyp(hid="none1", status=None)]
    rows = cal.upcoming(NOW, bc_events=[], hypotheses=hyps, events=[])
    assert [r["source_id"] for r in rows] == ["open1"]


def test_upcoming_ignore_les_depeches_qui_ne_sont_pas_des_catalyseurs():
    news = [_news("Apple earnings on September 17", sentiment="pos"),
            _news("Fed speech September 18", sentiment="gov", symbol="GOV"),
            _news("Nvidia earnings on September 19", symbol="NVDA")]
    rows = cal.upcoming(NOW, bc_events=[], hypotheses=[], events=news)
    assert [r["symbol"] for r in rows] == ["NVDA"]


def test_upcoming_fenetre_le_passe_et_le_futur():
    bc = [{"date": "2026-08-20", "bank": "Fed", "label": "passé lointain"},
          {"date": "2026-08-25", "bank": "Fed", "label": "passé proche"},
          {"date": "2026-09-01", "bank": "Fed", "label": "futur"},
          {"date": "2027-06-01", "bank": "Fed", "label": "trop loin"}]
    ahead = cal.upcoming(NOW, bc_events=bc, hypotheses=[], events=[])
    assert [r["label"] for r in ahead] == ["Fed — futur"]

    with_past = cal.upcoming(NOW, bc_events=bc, hypotheses=[], events=[],
                             back_days=3)
    assert [r["label"] for r in with_past] == ["Fed — passé proche", "Fed — futur"]


def test_un_catalyseur_survit_au_lendemain_de_son_rendez_vous():
    """Sans ça, la re-lecture du « mitigé » à D+1 ne pourrait JAMAIS avoir lieu
    pour un catalyseur : ``extract_date`` refuse une date passée, donc l'entrée
    disparaîtrait le lendemain. ``back_days`` recule le point de repère."""
    news = [_news("Apple earnings on August 26", link="https://ex/1")]
    day_after = datetime(2026, 8, 27, 12, 0, 0)        # le rendez-vous était hier

    sans_passe = cal.upcoming(day_after, bc_events=[], hypotheses=[], events=news)
    assert sans_passe == []

    avec_passe = cal.upcoming(day_after, bc_events=[], hypotheses=[], events=news,
                              back_days=cal.VIEW_BACK_D)
    assert [r["date"] for r in avec_passe] == ["2026-08-26"]


def test_upcoming_une_source_en_panne_ne_casse_pas_les_autres(monkeypatch):
    def _boom(*_args, **_kwargs):
        raise RuntimeError("radar cassé")

    monkeypatch.setattr(cal, "normalize_hypotheses", _boom)
    rows = cal.upcoming(
        NOW,
        bc_events=[{"date": "2026-09-10", "bank": "Fed", "label": "riunione"}],
        hypotheses=[_hyp()],
        events=[_news("Apple earnings on September 17")],
    )
    assert [r["kind"] for r in rows] == ["bc", "catalyst"]


def test_upcoming_sans_aucune_source_disponible_rend_une_liste_vide(monkeypatch):
    """Déploiement partiel : le calendrier rétrécit, il ne tombe pas.

    ⚠️ Le stub se pose À LA FOIS dans ``sys.modules`` ET en attribut du paquet.
    ``from backend.bots.paper import radar`` regarde l'ATTRIBUT en premier :
    dès qu'un autre test de la session a importé le vrai module une fois,
    neutraliser ``sys.modules`` seul ne suffit plus (ce test passait seul et
    partait chercher le réseau dans la suite complète).
    """
    import sys

    import backend.bots.paper as paper_pkg

    for name in ("agenda_bridge", "radar", "newswatch"):
        monkeypatch.setitem(sys.modules, "backend.bots.paper." + name, None)
        monkeypatch.setattr(paper_pkg, name, None, raising=False)
    assert cal.upcoming(NOW) == []


def test_upcoming_borne_le_nombre_d_entrees():
    bc = [{"date": "2026-09-0%d" % (i + 1), "bank": "B%d" % i, "label": "r"}
          for i in range(9)]
    rows = cal.upcoming(NOW, bc_events=bc, hypotheses=[], events=[],
                        max_entries=3)
    assert len(rows) == 3


def test_upcoming_est_reproductible_quel_que_soit_l_ordre_des_sources():
    """La clé de verdict dépend du survivant du dédoublonnage : deux passages
    sur les mêmes données doivent rendre exactement les mêmes clés."""
    news = [_news("Apple earnings on September 17", link="https://b"),
            _news("Apple reports September 17", link="https://a")]
    first = cal.upcoming(NOW, bc_events=[], hypotheses=[], events=news)
    second = cal.upcoming(NOW, bc_events=[], hypotheses=[],
                          events=list(reversed(news)))
    assert [r["key"] for r in first] == [r["key"] for r in second]


# --------------------------------------------------------------------------- #
# Échéance d'une hypothèse
# --------------------------------------------------------------------------- #

def test_hypothesis_due_date_ajoute_l_horizon():
    hyp = _hyp(created=datetime(2026, 8, 1, 8, 0, 0), horizon=10)
    assert cal.hypothesis_due_date(hyp, 10) == "2026-08-11"


def test_hypothesis_due_date_sans_created_at_rend_none():
    assert cal.hypothesis_due_date({"horizon_days": 10}, 10) is None
    assert cal.hypothesis_due_date(None, 10) is None


def test_hypothesis_due_date_demande_l_horizon_au_radar_par_defaut():
    """Sans horizon fourni, c'est ``radar.hypothesis_horizon`` qui tranche —
    une seule définition de l'échéance dans tout le projet."""
    hyp = _hyp(created=datetime(2026, 8, 1), horizon=12)
    assert cal.hypothesis_due_date(hyp) == "2026-08-13"


# --------------------------------------------------------------------------- #
# Clé d'entrée
# --------------------------------------------------------------------------- #

def test_la_cle_porte_le_genre_et_la_date():
    entry = cal._entry("catalyst", "2026-09-17", "titre", "https://ex/1",
                       symbol="AAPL")
    assert entry["key"] == "catalyst|2026-09-17|https://ex/1"
    assert cal.parse_key(entry["key"]) == ("catalyst", "2026-09-17", "https://ex/1")


def test_parse_key_tolere_une_cle_deformee():
    assert cal.parse_key("") == ("", "", "")
    assert cal.parse_key("nawak") == ("nawak", "", "")
    assert cal.parse_key(None) == ("", "", "")


# --------------------------------------------------------------------------- #
# État persistant — 0o600, radical à POINT, DATA_DIR isolé
# --------------------------------------------------------------------------- #

def test_le_fichier_d_etat_est_ecrit_en_0600(tmp_path):
    cal.save_verdicts({"k": {"verdict": "flop"}})
    path = cal.state_path()
    assert path.is_file()
    assert stat.S_IMODE(os.stat(str(path)).st_mode) == 0o600


def test_le_fichier_d_etat_vit_sous_le_data_dir_isole(tmp_path):
    assert cal.state_path().parent == tmp_path
    assert cal.state_path().name == "calendar.verdicts.json"


def test_le_radical_du_fichier_porte_un_point_donc_pas_de_compte_fantome(tmp_path):
    """Convention anti-fantôme : un radical à point ne peut pas être pris pour
    un nom d'utilisateur, ni par ``store`` ni par le recensement du radar."""
    from pathlib import Path as _Path
    from backend.bots.paper import radar

    stem = _Path(cal.STATE_NAME).stem
    assert "." in stem
    with pytest.raises(ValueError):
        store.portfolio_path(stem)

    cal.save_verdicts({"k": {"verdict": "flop"}})
    (tmp_path / "alice.json").write_text("{}", encoding="utf-8")
    assert radar._users_with_portfolio() == ["alice"]


def test_load_verdicts_tolere_l_absence_et_la_corruption(tmp_path):
    assert cal.load_verdicts() == {}
    (tmp_path / cal.STATE_NAME).write_text("{pas du json", encoding="utf-8")
    assert cal.load_verdicts() == {}
    (tmp_path / cal.STATE_NAME).write_text('["une liste"]', encoding="utf-8")
    assert cal.load_verdicts() == {}


def test_verdict_for_rend_none_quand_rien_n_a_ete_juge():
    assert cal.verdict_for("catalyst|2026-09-17|x") is None
    assert cal.verdict_for("k", {"k": {"verdict": "flop"}})["verdict"] == "flop"


# --------------------------------------------------------------------------- #
# should_judge — jugé UNE fois, sauf le mitigé relu à D+1
# --------------------------------------------------------------------------- #

def test_should_judge_une_entree_jamais_vue():
    assert cal.should_judge(None, "2026-08-27") is True


def test_should_judge_refuse_un_verdict_deja_tranche():
    for verdict in ("flop", "confirme"):
        row = {"verdict": verdict, "checked_at": "2026-08-20T12:00:00"}
        assert cal.should_judge(row, "2026-08-27") is False


def test_should_judge_relit_un_mitige_le_lendemain():
    row = {"verdict": "mitige", "checked_at": "2026-08-26T12:00:00"}
    assert cal.should_judge(row, "2026-08-27") is True


def test_should_judge_ne_relit_pas_un_mitige_le_jour_meme():
    row = {"verdict": "mitige", "checked_at": "2026-08-27T09:00:00"}
    assert cal.should_judge(row, "2026-08-27") is False


def test_should_judge_fige_un_mitige_deja_relu():
    row = {"verdict": "mitige", "checked_at": "2026-08-26T12:00:00",
           "rechecked": True}
    assert cal.should_judge(row, "2026-08-27") is False


# --------------------------------------------------------------------------- #
# Lecture de la presse au jour J
# --------------------------------------------------------------------------- #

def test_sentiments_for_filtre_par_symbole_et_par_fenetre():
    events = [
        _news("récente", symbol="AAPL", sentiment="neg", ts=NOW - timedelta(hours=2)),
        _news("vieille", symbol="AAPL", sentiment="pos", ts=NOW - timedelta(hours=40)),
        _news("autre titre", symbol="MSFT", sentiment="pos", ts=NOW),
    ]
    assert cal.sentiments_for("AAPL", events, NOW) == ["neg"]
    assert cal.sentiments_for("", events, NOW) == []


def test_headline_for_rend_le_titre_le_plus_recent():
    events = [
        _news("ancienne", symbol="AAPL", ts=NOW - timedelta(hours=5)),
        _news("la plus fraîche", symbol="AAPL", ts=NOW - timedelta(hours=1)),
    ]
    assert cal.headline_for("AAPL", events, NOW) == "la plus fraîche"
    assert cal.headline_for("ZZZZ", events, NOW) == ""


# --------------------------------------------------------------------------- #
# run_verdicts
# --------------------------------------------------------------------------- #

def _entry(kind="catalyst", day="2026-08-27", symbol="AAPL", direction=None,
           source_id="https://ex/1"):
    return cal._entry(kind, day, "un titre", source_id, symbol=symbol,
                      tickers=[symbol] if symbol else [], direction=direction)


def test_run_verdicts_juge_un_rendez_vous_echu():
    entries = [_entry()]
    news = [_news("mauvaise nouvelle", sentiment="neg", ts=NOW)]
    out = cal.run_verdicts(NOW, entries=entries, quote=lambda s: -5.0, events=news)

    assert out["checked"] == 1
    assert out["judged"][0]["verdict"] == "flop"
    assert out["judged"][0]["move_pct"] == -5.0
    assert out["judged"][0]["headline"] == "mauvaise nouvelle"
    stored = cal.load_verdicts()[entries[0]["key"]]
    assert stored["verdict"] == "flop"
    assert stored["checked_at"] == NOW.isoformat()


def test_run_verdicts_ignore_un_rendez_vous_a_venir():
    entries = [_entry(day="2026-09-30")]
    out = cal.run_verdicts(NOW, entries=entries, quote=lambda s: -9.0, events=[])
    assert out == {"checked": 0, "judged": []}
    assert cal.load_verdicts() == {}


def test_run_verdicts_ignore_une_entree_sans_symbole():
    """Une réunion de banque centrale n'a pas de cours à mesurer."""
    entries = [_entry(kind="bc", symbol=None, source_id="bc:abc")]
    out = cal.run_verdicts(NOW, entries=entries, quote=lambda s: -9.0, events=[])
    assert out["checked"] == 0


def test_run_verdicts_ne_juge_qu_une_fois():
    entries = [_entry()]
    news = [_news("mauvaise nouvelle", sentiment="neg", ts=NOW)]
    cal.run_verdicts(NOW, entries=entries, quote=lambda s: -5.0, events=news)

    later = NOW + timedelta(days=1)
    calls = []

    def _quote(symbol):
        calls.append(symbol)
        return 8.0

    out = cal.run_verdicts(later, entries=entries, quote=_quote, events=news)
    assert out["checked"] == 0 and calls == []
    assert cal.load_verdicts()[entries[0]["key"]]["verdict"] == "flop"


def test_run_verdicts_relit_un_mitige_a_j_plus_1_puis_le_fige():
    entries = [_entry()]
    news = [_news("nouvelle", sentiment="neg", ts=NOW)]

    # J : la séance finit à plat -> mitigé.
    first = cal.run_verdicts(NOW, entries=entries, quote=lambda s: 0.4, events=news)
    assert first["judged"][0]["verdict"] == "mitige"

    # J+1 : le marché a digéré -> le verdict se corrige, et se verrouille.
    day2 = NOW + timedelta(days=1)
    news2 = [_news("nouvelle", sentiment="neg", ts=day2)]
    second = cal.run_verdicts(day2, entries=entries, quote=lambda s: -6.0,
                              events=news2)
    assert second["checked"] == 1
    assert second["judged"][0]["verdict"] == "flop"

    # J+2 : plus rien, même si le cours s'agite encore.
    day3 = NOW + timedelta(days=2)
    third = cal.run_verdicts(day3, entries=entries, quote=lambda s: 12.0,
                             events=news2)
    assert third["checked"] == 0
    assert cal.load_verdicts()[entries[0]["key"]]["verdict"] == "flop"


def test_run_verdicts_fige_aussi_un_mitige_reste_mitige():
    """Le drapeau se pose même quand la relecture rend encore « mitigé »."""
    entries = [_entry()]
    cal.run_verdicts(NOW, entries=entries, quote=lambda s: 0.0, events=[])
    day2 = NOW + timedelta(days=1)
    cal.run_verdicts(day2, entries=entries, quote=lambda s: 0.0, events=[])
    day3 = NOW + timedelta(days=2)
    assert cal.run_verdicts(day3, entries=entries, quote=lambda s: 0.0,
                            events=[])["checked"] == 0
    assert cal.load_verdicts()[entries[0]["key"]]["rechecked"] is True


def test_run_verdicts_utilise_la_direction_du_pari():
    entries = [_entry(kind="hypothesis", direction="down", source_id="h1")]
    news = [_news("bonne nouvelle", sentiment="pos", ts=NOW)]
    out = cal.run_verdicts(NOW, entries=entries, quote=lambda s: -7.0, events=news)
    assert out["judged"][0]["verdict"] == "confirme"


def test_run_verdicts_ne_leve_jamais_si_le_cours_explose():
    def _boom(_symbol):
        raise RuntimeError("Yahoo est down")

    out = cal.run_verdicts(NOW, entries=[_entry()], quote=_boom, events=[])
    assert out["judged"][0]["verdict"] == "mitige"
    assert out["judged"][0]["move_pct"] is None


def test_run_verdicts_ne_leve_jamais_meme_sur_des_entrees_absurdes():
    out = cal.run_verdicts(NOW, entries="pas une liste", quote=lambda s: 1.0,
                           events=[])
    assert out == {"checked": 0, "judged": []}


def test_run_verdicts_sans_ecriture_ne_persiste_rien():
    out = cal.run_verdicts(NOW, entries=[_entry()], quote=lambda s: -5.0,
                           events=[{"ts": NOW.isoformat(), "symbol": "AAPL",
                                    "title": "t", "sentiment": "neg"}],
                           save=False)
    assert out["checked"] == 1
    assert cal.load_verdicts() == {}


# --------------------------------------------------------------------------- #
# Contrats publics du router et de la convergence
# --------------------------------------------------------------------------- #

def test_calendar_view_fusionne_le_verdict_quand_il_existe():
    bc = [{"date": "2026-09-10", "bank": "Fed", "label": "riunione"}]
    news = [_news("Apple earnings on August 26", link="https://ex/1",
                  ts=NOW - timedelta(days=1))]
    entries = cal.upcoming(NOW, bc_events=bc, hypotheses=[], events=news,
                           back_days=cal.VIEW_BACK_D)
    cal.run_verdicts(NOW, entries=entries, quote=lambda s: -5.0,
                     events=[_news("chute", sentiment="neg", ts=NOW)])

    rows = cal.calendar_view(NOW, bc_events=bc, hypotheses=[], events=news)
    by_kind = {r["kind"]: r for r in rows}
    assert by_kind["catalyst"]["verdict"] == "flop"
    assert by_kind["catalyst"]["move_pct"] == -5.0
    assert by_kind["catalyst"]["checked_at"] == NOW.isoformat()
    # le rendez-vous à venir est là, sans verdict, mais avec la forme complète
    assert by_kind["bc"]["verdict"] is None
    assert by_kind["bc"]["move_pct"] is None
    assert by_kind["bc"]["headline"] == ""
    assert by_kind["bc"]["checked_at"] is None


def test_run_verdicts_fige_l_identite_du_rendez_vous_dans_la_ligne():
    """Le consommateur (convergence) a besoin de ``symbol``/``tickers`` pour
    savoir si le titre est DÉTENU. L'instant du jugement est le seul où ils
    existent encore : ils sont donc COPIÉS dans la ligne persistée."""
    entries = [_entry(kind="hypothesis", symbol="AAPL", direction="down",
                      source_id="h1")]
    cal.run_verdicts(NOW, entries=entries, quote=lambda s: -7.0, events=[])
    stored = cal.load_verdicts()[entries[0]["key"]]
    assert stored["kind"] == "hypothesis"
    assert stored["symbol"] == "AAPL"
    assert stored["tickers"] == ["AAPL"]
    assert stored["direction"] == "down"
    assert stored["label"] == "un titre"


def test_recent_verdicts_est_une_lecture_pure_sans_aucune_collecte(monkeypatch):
    """CONTRAT : la convergence l'appelle à chaque cycle. Un repli qui
    reconstruisait le calendrier ferait ré-interroger le guetteur de presse une
    seconde fois par cycle — et la déduplication des dépêches entre comptes
    tomberait avec. Ce test empêche le repli de revenir."""
    def _boom(*_args, **_kwargs):
        raise AssertionError("recent_verdicts ne doit RIEN collecter")

    entries = [_entry(kind="hypothesis", symbol="AAPL", direction="down",
                      source_id="h1")]
    cal.run_verdicts(NOW, entries=entries, quote=lambda s: -7.0, events=[])

    monkeypatch.setattr(cal, "upcoming", _boom)
    monkeypatch.setattr(cal, "_fetch_events", _boom)
    monkeypatch.setattr(cal, "_fetch_bc", _boom)
    monkeypatch.setattr(cal, "_fetch_hypotheses", _boom)

    rows = cal.recent_verdicts(NOW, days=7)       # ni entries, ni verdicts
    assert len(rows) == 1
    assert rows[0]["symbol"] == "AAPL"
    assert rows[0]["tickers"] == ["AAPL"]
    assert rows[0]["direction"] == "down"
    assert rows[0]["kind"] == "hypothesis"
    assert rows[0]["verdict"] == "confirme"


def test_recent_verdicts_rend_les_jugements_recents_du_plus_frais_au_plus_vieux():
    table = {
        "catalyst|2026-08-26|https://a": {"verdict": "flop", "move_pct": -5.0,
                                          "headline": "chute", "symbol": "AAPL",
                                          "checked_at": "2026-08-26T12:00:00"},
        "hypothesis|2026-08-27|h1": {"verdict": "confirme", "move_pct": 6.0,
                                     "headline": "", "symbol": "MSFT",
                                     "checked_at": "2026-08-27T09:00:00"},
    }
    rows = cal.recent_verdicts(NOW, days=7, verdicts=table, entries=[])
    assert [r["verdict"] for r in rows] == ["confirme", "flop"]
    assert [r["symbol"] for r in rows] == ["MSFT", "AAPL"]
    # genre et date restent lisibles depuis la CLÉ (lignes d'avant le figeage)
    assert rows[0]["kind"] == "hypothesis" and rows[0]["date"] == "2026-08-27"
    assert rows[1]["kind"] == "catalyst" and rows[1]["date"] == "2026-08-26"


def test_recent_verdicts_tolere_une_ligne_ancienne_sans_identite():
    """Rétro-compat : une ligne écrite avant le figeage n'a ni symbole ni
    libellé — elle reste lisible, elle ne fait pas tomber la lecture."""
    table = {"catalyst|2026-08-26|https://a": {
        "verdict": "flop", "checked_at": "2026-08-26T12:00:00"}}
    rows = cal.recent_verdicts(NOW, days=7, verdicts=table)
    assert rows[0]["symbol"] is None and rows[0]["tickers"] == []
    assert rows[0]["kind"] == "catalyst" and rows[0]["label"] == ""


def test_recent_verdicts_ecarte_les_jugements_trop_vieux():
    table = {"catalyst|2026-08-01|https://a": {
        "verdict": "flop", "checked_at": "2026-08-01T12:00:00"}}
    assert cal.recent_verdicts(NOW, days=7, verdicts=table, entries=[]) == []


def test_recent_verdicts_enrichit_avec_l_entree_quand_elle_existe_encore():
    entries = [_entry(day="2026-08-26", symbol="AAPL", source_id="https://a")]
    table = {entries[0]["key"]: {"verdict": "flop", "move_pct": -5.0,
                                 "headline": "chute",
                                 "checked_at": "2026-08-26T12:00:00"}}
    rows = cal.recent_verdicts(NOW, days=7, verdicts=table, entries=entries)
    assert rows[0]["symbol"] == "AAPL"
    assert rows[0]["label"] == "un titre"


def test_recent_verdicts_ignore_une_ligne_sans_verdict():
    table = {"catalyst|2026-08-26|https://a": {"checked_at": "2026-08-26T12:00:00"}}
    assert cal.recent_verdicts(NOW, days=7, verdicts=table, entries=[]) == []
