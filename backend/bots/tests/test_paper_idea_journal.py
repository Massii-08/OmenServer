"""Tests du journal des idées du coach — 100 % hors ligne.

Isolation disque : ``store.DATA_DIR`` pointe sur ``tmp_path`` (le journal en
dérive à chaque appel), donc le vrai ``data/paper_trading/`` n'est jamais
touché.
"""
import json

import pytest

from backend.bots.paper import idea_journal, newswatch, radar, store


@pytest.fixture(autouse=True)
def _isolate_data_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "DATA_DIR", tmp_path)
    return tmp_path


NOW = "2026-08-26T10:00:00"


# --------------------------------------------------------------------------- #
# Écriture / lecture
# --------------------------------------------------------------------------- #

def test_une_entree_est_ajoutee_en_tete():
    idea_journal.append_entry("alice", "ideas", "première", now_iso=NOW)
    idea_journal.append_entry("alice", "ideas", "seconde",
                              now_iso="2026-08-27T10:00:00")
    entries = idea_journal.load_entries("alice")
    assert [e["text"] for e in entries] == ["seconde", "première"]


def test_le_journal_est_vide_avant_toute_ecriture():
    assert idea_journal.load_entries("alice") == []


def test_le_journal_est_ecrit_en_0600():
    idea_journal.append_entry("alice", "ideas", "x", now_iso=NOW)
    path = idea_journal.journal_path("alice")
    assert oct(path.stat().st_mode & 0o777) == "0o600"


def test_le_journal_est_plafonne(monkeypatch):
    monkeypatch.setattr(idea_journal, "MAX_ENTRIES", 3)
    for i in range(6):
        idea_journal.append_entry("alice", "ideas", "n%d" % i, now_iso=NOW)
    entries = idea_journal.load_entries("alice")
    assert len(entries) == 3
    assert entries[0]["text"] == "n5"           # le plus récent en tête


def test_une_entree_porte_ses_idees_et_son_niveau():
    idea_journal.append_entry(
        "alice", "ideas", "texte", risk_level="agressif",
        ideas=[{"ticker": "TSLA", "direction": "up", "tracked": True}],
        now_iso=NOW)
    entry = idea_journal.load_entries("alice")[0]
    assert entry["risk_level"] == "agressif"
    assert entry["ideas"][0]["ticker"] == "TSLA"
    assert entry["kind"] == "ideas"


def test_une_revue_porte_ses_verdicts():
    idea_journal.append_entry(
        "alice", "review", "texte",
        verdicts=[{"symbol": "KO", "stance": "alleger"}], now_iso=NOW)
    entry = idea_journal.load_entries("alice")[0]
    assert entry["kind"] == "review"
    assert entry["verdicts"] == [{"symbol": "KO", "stance": "alleger"}]


def test_un_genre_inconnu_retombe_sur_ideas():
    idea_journal.append_entry("alice", "n'importe quoi", "x", now_iso=NOW)
    assert idea_journal.load_entries("alice")[0]["kind"] == "ideas"


def test_un_journal_corrompu_ne_fait_pas_tomber_la_lecture():
    path = idea_journal.journal_path("alice")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{ pas du json", encoding="utf-8")
    assert idea_journal.load_entries("alice") == []


def test_un_nom_d_utilisateur_forge_est_rejete():
    with pytest.raises(ValueError):
        idea_journal.journal_path("../../etc/passwd")


# --------------------------------------------------------------------------- #
# ⚠️ Non-fantôme — le fichier ne doit ressembler à AUCUN compte
# --------------------------------------------------------------------------- #

def test_le_fichier_de_journal_ne_cree_pas_de_compte_fantome(tmp_path):
    """``<user>.ideas.json`` porte un point dans son radical : ni le radar ni
    la veille ne peuvent le prendre pour un compte. C'est exactement le bug qui
    avait créé les utilisateurs fantômes de la communauté."""
    store.save_portfolio("tester", {"cash_chf": 1.0, "positions": []})
    idea_journal.append_entry("tester", "ideas", "x", now_iso=NOW)

    assert radar._users_with_portfolio() == ["tester"]
    assert [u for u, _p in newswatch._discover_portfolios()] == []


def test_le_journal_n_apparait_pas_dans_la_communaute():
    store.save_portfolio("tester", {"cash_chf": 1.0, "positions": []})
    idea_journal.append_entry("tester", "ideas", "x", now_iso=NOW)
    store.append_note("tester", "Journal.md", "note\n")
    assert store.list_vault_users() == ["tester"]


# --------------------------------------------------------------------------- #
# PUR — résumé et index de résultats
# --------------------------------------------------------------------------- #

def _entry(day, tickers, kind="ideas", level="mesure"):
    return {"ts": "%sT10:00:00" % day, "kind": kind, "risk_level": level,
            "text": "un texte long qu'on ne veut PAS voir dans le résumé",
            "ideas": [{"ticker": t, "direction": "up", "thesis": "…"}
                      for t in tickers]}


def test_le_resume_ne_garde_que_l_essentiel():
    rows = idea_journal.summarize([_entry("2026-08-20", ["TSLA", "AAPL"])])
    assert rows == [{
        "date": "2026-08-20", "kind": "ideas", "risk_level": "mesure",
        "ideas": [{"ticker": "TSLA", "direction": "up"},
                  {"ticker": "AAPL", "direction": "up"}],
    }]


def test_le_resume_est_borne():
    entries = [_entry("2026-08-%02d" % (10 + i), ["T%d" % i]) for i in range(12)]
    assert len(idea_journal.summarize(entries)) == idea_journal.SUMMARY_LIMIT
    assert len(idea_journal.summarize(entries, limit=3)) == 3


def test_le_resume_porte_le_resultat_quand_on_le_retrouve():
    hypotheses = [{"status": "scored", "outcome": "hit", "tickers": ["TSLA"],
                   "created_at": "2026-08-20T11:00:00"}]
    index = idea_journal.outcome_index(hypotheses)
    rows = idea_journal.summarize([_entry("2026-08-20", ["TSLA"])],
                                  outcomes=index)
    assert rows[0]["ideas"][0]["outcome"] == "hit"


def test_le_resume_omet_un_resultat_introuvable():
    """Best-effort ASSUMÉ : on n'invente jamais un verdict."""
    rows = idea_journal.summarize([_entry("2026-08-20", ["TSLA"])], outcomes={})
    assert "outcome" not in rows[0]["ideas"][0]


def test_l_index_ignore_les_hypotheses_non_notees():
    hypotheses = [{"status": "open", "outcome": None, "tickers": ["TSLA"],
                   "created_at": "2026-08-20T11:00:00"}]
    assert idea_journal.outcome_index(hypotheses) == {}


def test_le_resume_porte_les_postures_d_une_revue():
    entry = {"ts": "2026-08-21T10:00:00", "kind": "review",
             "verdicts": [{"symbol": "ko", "stance": "sortir"}]}
    rows = idea_journal.summarize([entry])
    assert rows[0]["verdicts"] == [{"symbol": "KO", "stance": "sortir"}]


@pytest.mark.parametrize("entries", [None, "pas une liste", [1, 2, 3], []])
def test_le_resume_est_tolerant(entries):
    assert isinstance(idea_journal.summarize(entries), list)


def test_le_fichier_est_du_json_lisible():
    idea_journal.append_entry("alice", "ideas", "texte", now_iso=NOW)
    payload = json.loads(idea_journal.journal_path("alice").read_text("utf-8"))
    assert isinstance(payload["entries"], list)



# --------------------------------------------------------------------------- #
# advice_from_text — le paragraphe qui parle d'un ticker (PUR)
#
# Repli pour les idées journalisées AVANT l'enrichissement du schéma JSON
# (``stop``/``risk_pct``/``invalidated_if``/``why_now``) : le conseil complet
# du coach existe déjà dans ``entry["text"]``, seulement pas découpé par
# titre — on va le chercher, un paragraphe à la fois.
# --------------------------------------------------------------------------- #

def test_advice_from_text_returns_the_paragraph_mentioning_the_ticker():
    text = ("AAPL — hausse probable sur le lancement produit.\n\n"
            "TSLA — la thèse s'essouffle, prudence sur le momentum.")
    assert idea_journal.advice_from_text(text, "TSLA") == \
        "TSLA — la thèse s'essouffle, prudence sur le momentum."


def test_advice_from_text_is_case_insensitive():
    text = "aapl — un joli catalyseur cette semaine."
    assert idea_journal.advice_from_text(text, "AAPL") == \
        "aapl — un joli catalyseur cette semaine."


def test_advice_from_text_tries_the_base_before_dot_or_dash():
    text = "Bitcoin (BTC) reste porté par le momentum institutionnel."
    advice = idea_journal.advice_from_text(text, "BTC-USD")
    assert advice is not None and "Bitcoin" in advice


def test_advice_from_text_base_needs_at_least_three_chars():
    """``A.SW`` -> base ``A`` : trop court, jamais essayé seul (faux positif
    quasi garanti sur n'importe quel texte)."""
    text = "Une phrase quelconque qui contient la lettre A partout."
    assert idea_journal.advice_from_text(text, "A.SW") is None


def test_advice_from_text_no_match_returns_none():
    text = "AAPL — hausse probable.\n\nMSFT — cloud toujours solide."
    assert idea_journal.advice_from_text(text, "TSLA") is None


def test_advice_from_text_whole_word_only_no_substring_match():
    """Doctrine anti-faux-positif (même famille que le piège #31) : ``GM`` ne
    doit pas matcher dans ``GMO``."""
    text = "GMO Resources annonce un partenariat inattendu."
    assert idea_journal.advice_from_text(text, "GM") is None


@pytest.mark.parametrize("text,ticker", [
    ("", "AAPL"), (None, "AAPL"), ("du texte", ""), ("du texte", None),
    (None, None),
])
def test_advice_from_text_empty_inputs_return_none(text, ticker):
    assert idea_journal.advice_from_text(text, ticker) is None


def test_advice_from_text_short_paragraph_is_not_truncated():
    text = "AAPL — thèse courte."
    assert idea_journal.advice_from_text(text, "AAPL") == "AAPL — thèse courte."


def test_advice_from_text_is_truncated_on_a_word_boundary():
    words = " ".join("mot%d" % i for i in range(200))
    text = "AAPL — " + words
    advice = idea_journal.advice_from_text(text, "AAPL")
    assert len(advice) <= idea_journal.ADVICE_CLAMP_LEN + 1     # + l'ellipse
    assert advice.endswith("…")
    assert not advice[:-1].endswith(" ")          # pas d'espace avant l'ellipse
    # jamais coupé au milieu d'un token « motN »
    last_token = advice[:-1].rsplit(" ", 1)[-1]
    assert last_token == "" or last_token.startswith("mot") and last_token[3:].isdigit()


def test_les_fichiers_de_reglage_ne_creent_pas_de_compte_fantome(tmp_path):
    """``alerts_mode.json`` et ``x_accounts.json`` sont posés DANS le même
    répertoire que les portefeuilles et leur radical ne porte AUCUN point :
    l'allowlist ne les rejette donc pas toute seule. Sans exclusion explicite,
    la convergence leur écrirait un carnet — et « alerts_mode » apparaîtrait
    dans la communauté, exactement comme « newswatch_global » avant le
    correctif."""
    from backend.bots.paper import alerts

    store.save_portfolio("tester", {"cash_chf": 1.0, "positions": []})
    alerts.set_mode("tout")
    newswatch.save_x_accounts(["elonmusk"])

    assert radar._users_with_portfolio() == ["tester"]
    assert [u for u, _p in newswatch._discover_portfolios()] == []
