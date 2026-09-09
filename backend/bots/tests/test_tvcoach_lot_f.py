"""Tests du LOT F — les cinq restes v1 de l'extension « coach TradingView ».

Cinq sujets sans rapport les uns avec les autres, réunis ici parce qu'ils
FERMENT la v1 :

  1. ``POST /api/paper/ideas/note`` — la note rapide au journal des idées ;
  2. le producteur de ``brief_changed`` (portefeuille écrit, scalp rangé) ;
  3. le GARDE anti-appel LLM réel (fixture autouse de ``conftest.py``) ;
  4. les libellés des deux facteurs BTC dans le frontend OmenServer ;
  5. le refiltrage des échantillons de scalp sur la fenêtre entrée/sortie.

100 % hors ligne : aucun test ne cote, ne parle au CLI Claude ni n'ouvre de
socket. Le patron des routes est celui des voisins (TestClient +
``dependency_overrides[get_current_user]``, cf. ``test_tvcoach_brief.py``).

Spec : ``docs/superpowers/specs/2026-09-09-tv-coach-extension-design.md``.
"""
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.auth.utils import get_current_user
from backend.bots import paper_tv_router as ptr
from backend.bots import paper_ws
from backend.bots.paper import idea_journal, llm, scalps, store

NOW = "2026-09-10T09:30:00"

# backend/bots/tests/… -> racine du dépôt = parents[3] (même calcul que
# ``store._PROJECT_ROOT``).
_PROJECT_ROOT = Path(__file__).resolve().parents[3]
_LANG_JS = _PROJECT_ROOT / "frontend" / "js" / "lang.js"
_PAPER_JS = _PROJECT_ROOT / "frontend" / "js" / "paper_module.js"


class FakeUser(object):
    def __init__(self, role="admin", username="tester"):
        self.role = role
        self.is_admin = role == "admin"
        self.username = username


def make_client(tmp_path, monkeypatch, role="admin"):
    """Client isolé : disque en tmp, horloge figée. Aucun double n'est
    nécessaire — la route ne sort ni sur le réseau ni sur le modèle."""
    monkeypatch.setattr(store, "DATA_DIR", tmp_path / "paper_trading")
    monkeypatch.setattr(ptr, "_now_iso", lambda: NOW)
    app = FastAPI()
    app.include_router(ptr.router)
    app.dependency_overrides[get_current_user] = lambda: FakeUser(role)
    return TestClient(app)


# --------------------------------------------------------------------------- #
# 1. POST /ideas/note — la note rapide
# --------------------------------------------------------------------------- #

def test_note_range_l_entree_et_rend_sa_forme(tmp_path, monkeypatch):
    client = make_client(tmp_path, monkeypatch)
    got = client.post("/api/paper/ideas/note",
                      json={"text": "  le gap de 8h30 s'est refermé  "})

    assert got.status_code == 200
    body = got.json()
    assert body["ok"] is True
    entry = body["entry"]
    assert entry["kind"] == "note"
    assert entry["text"] == "le gap de 8h30 s'est refermé"
    assert entry["ts"] == NOW
    assert entry["lang"] == "fr"
    assert entry["id"]

    # Et elle est VRAIMENT au journal, en tête.
    rows = idea_journal.load_entries("tester")
    assert [r["text"] for r in rows] == ["le gap de 8h30 s'est refermé"]


def test_note_le_genre_note_est_accepte_par_le_journal():
    """Sans ``"note"`` dans ``KINDS``, ``append_entry`` retomberait en silence
    sur ``ideas`` — la note se lirait comme une proposition du coach."""
    assert "note" in idea_journal.KINDS


def test_note_vide_est_refusee(tmp_path, monkeypatch):
    client = make_client(tmp_path, monkeypatch)
    for payload in ({"text": ""}, {"text": "   \n\t "}, {}):
        got = client.post("/api/paper/ideas/note", json=payload)
        assert got.status_code == 400, payload
    assert idea_journal.load_entries("tester") == []


def test_note_est_tronquee_a_500_caracteres(tmp_path, monkeypatch):
    client = make_client(tmp_path, monkeypatch)
    got = client.post("/api/paper/ideas/note", json={"text": "a" * 600})

    assert got.status_code == 200
    assert got.json()["entry"]["text"] == "a" * ptr.NOTE_MAX_LEN
    assert ptr.NOTE_MAX_LEN == 500


def test_note_prefixe_le_symbole_canonise(tmp_path, monkeypatch):
    """``rog.sw`` -> ``RO.SW`` : le préfixe porte le symbole CANONIQUE, celui
    sous lequel le reste du simulateur range ce titre."""
    client = make_client(tmp_path, monkeypatch)
    got = client.post("/api/paper/ideas/note",
                      json={"text": "troisième rejet sur la MM200",
                            "symbol": "rog.sw"})

    assert got.status_code == 200
    assert got.json()["entry"]["text"] == \
        "[RO.SW] troisième rejet sur la MM200"


def test_note_sans_symbole_n_invente_aucun_prefixe(tmp_path, monkeypatch):
    client = make_client(tmp_path, monkeypatch)
    got = client.post("/api/paper/ideas/note",
                      json={"text": "journée sans conviction", "symbol": "  "})
    assert got.json()["entry"]["text"] == "journée sans conviction"


def test_note_la_troncature_porte_sur_le_texte_pas_sur_le_prefixe(tmp_path,
                                                                  monkeypatch):
    """Deux notes de 500 signes doivent donner deux entrées comparables, que
    l'une porte un symbole de trois lettres et l'autre un de huit."""
    client = make_client(tmp_path, monkeypatch)
    got = client.post("/api/paper/ideas/note",
                      json={"text": "b" * 600, "symbol": "AAPL"})
    assert got.json()["entry"]["text"] == "[AAPL] " + "b" * 500


def test_note_retient_la_langue_demandee(tmp_path, monkeypatch):
    client = make_client(tmp_path, monkeypatch)
    got = client.post("/api/paper/ideas/note",
                      json={"text": "terzo rifiuto", "lang": "it"})
    assert got.json()["entry"]["lang"] == "it"


def test_note_une_langue_exotique_retombe_sur_le_francais(tmp_path, monkeypatch):
    client = make_client(tmp_path, monkeypatch)
    got = client.post("/api/paper/ideas/note",
                      json={"text": "hello", "lang": "klingon"})
    assert got.json()["entry"]["lang"] == "fr"


def test_note_refuse_un_role_sans_droit(tmp_path, monkeypatch):
    client = make_client(tmp_path, monkeypatch, role="player")
    assert client.post("/api/paper/ideas/note",
                       json={"text": "x"}).status_code == 403


def test_note_refuse_un_visiteur_anonyme():
    app = FastAPI()
    app.include_router(ptr.router)
    assert TestClient(app).post("/api/paper/ideas/note",
                                json={"text": "x"}).status_code == 401


# --------------------------------------------------------------------------- #
# 2. Le producteur de ``brief_changed``
# --------------------------------------------------------------------------- #

def _spy_emit(monkeypatch):
    """Espionne ``paper_ws.emit`` -> la liste des appels (tuples)."""
    calls = []
    monkeypatch.setattr(paper_ws, "emit",
                        lambda *a, **k: calls.append((a, k)))
    return calls


def test_brief_changed_est_pousse_apres_l_ecriture_du_portefeuille(tmp_path,
                                                                   monkeypatch):
    monkeypatch.setattr(store, "DATA_DIR", tmp_path / "paper_trading")
    calls = _spy_emit(monkeypatch)

    store.save_portfolio("tester", {"cash_chf": 10000.0, "positions": []})

    assert calls == [(("tester", "brief_changed", None,
                       {"reason": "portfolio"}), {})]
    # Et l'écriture, elle, a bien eu lieu.
    assert store.load_portfolio("tester")["cash_chf"] == 10000.0


def test_brief_changed_ne_fait_JAMAIS_echouer_une_ecriture(tmp_path,
                                                           monkeypatch):
    """``paper_ws`` indisponible (import cassé) -> le portefeuille s'écrit
    quand même. La notification est un bonus, jamais une dépendance.

    ⚠️ ``sys.modules[…] = None`` ne casse l'import que parce que le helper
    écrit ``import backend.bots.paper_ws as paper_ws`` : la forme
    ``from backend.bots import paper_ws`` lirait l'attribut déjà posé sur le
    paquet parent et ce test ne prouverait rien (mesuré).
    """
    monkeypatch.setattr(store, "DATA_DIR", tmp_path / "paper_trading")
    monkeypatch.setitem(sys.modules, "backend.bots.paper_ws", None)

    store.save_portfolio("tester", {"cash_chf": 42.0})

    assert store.load_portfolio("tester")["cash_chf"] == 42.0


def test_brief_changed_avale_une_panne_d_emit(tmp_path, monkeypatch):
    """Même contrat quand c'est ``emit`` lui-même qui explose."""
    monkeypatch.setattr(store, "DATA_DIR", tmp_path / "paper_trading")

    def _boom(*a, **k):
        raise RuntimeError("boucle morte")

    monkeypatch.setattr(paper_ws, "emit", _boom)
    store.save_portfolio("tester", {"cash_chf": 7.0})
    assert store.load_portfolio("tester")["cash_chf"] == 7.0


def _scalp_row(client_id="c1"):
    return {"client_id": client_id, "symbol": "BTC-USD", "side": "buy",
            "qty": 0.01, "entry_price": 100.0, "exit_price": 101.0,
            "pnl_chf": 1.0}


def test_brief_changed_est_pousse_apres_un_scalp_range(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "DATA_DIR", tmp_path / "paper_trading")
    calls = _spy_emit(monkeypatch)

    scalps.record("tester", _scalp_row())

    assert calls == [(("tester", "brief_changed", None,
                       {"reason": "scalp"}), {})]


def test_brief_changed_ne_repart_PAS_sur_un_rejeu(tmp_path, monkeypatch):
    """Un ``client_id`` déjà connu ne crée rien : notifier quand même ferait
    clignoter le panneau à chaque reprise de la file locale de l'extension."""
    monkeypatch.setattr(store, "DATA_DIR", tmp_path / "paper_trading")
    scalps.record("tester", _scalp_row())
    calls = _spy_emit(monkeypatch)

    outcome = scalps.record("tester", _scalp_row())

    assert outcome["created"] is False
    assert calls == []


def test_brief_changed_est_un_type_du_contrat():
    """Un type hors contrat passerait quand même (``emit`` est permissif) mais
    le client ne saurait pas quoi en faire."""
    assert "brief_changed" in paper_ws.MESSAGE_TYPES


# --------------------------------------------------------------------------- #
# 3. Le garde anti-appel LLM réel (fixture autouse de ``conftest.py``)
# --------------------------------------------------------------------------- #

class _FakeProc(object):
    def __init__(self, returncode=0, stdout="", stderr=""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


def test_le_garde_refuse_un_appel_LLM_sans_double():
    """Sans ``run=``, ``_claude_text`` lancerait le VRAI CLI Claude : un
    sous-processus, du réseau, de l'argent et des dizaines de secondes — et le
    test passerait quand même, ce qui rend la panne invisible."""
    with pytest.raises(RuntimeError, match="appel LLM réel interdit en test"):
        llm._claude_text("dis bonjour")


def test_le_garde_voit_aussi_un_run_passe_en_POSITIONNEL():
    import subprocess
    with pytest.raises(RuntimeError, match="appel LLM réel interdit en test"):
        llm._claude_text("p", llm.DEFAULT_MODEL, llm.DEFAULT_TIMEOUT,
                         subprocess.run)


def test_le_garde_delegue_a_l_original_quand_un_run_est_injecte():
    """Avec un double, on veut le VRAI comportement de ``_claude_text``
    (décodage de l'enveloppe JSON compris), pas un mannequin."""
    seen = {}

    def fake_run(cmd, **kwargs):
        seen["cmd"] = cmd
        seen["input"] = kwargs.get("input")
        return _FakeProc(0, '{"result": "  bonjour  "}')

    assert llm._claude_text("dis bonjour", run=fake_run) == "bonjour"
    assert seen["input"] == "dis bonjour"
    assert "--output-format" in seen["cmd"]


def test_le_monkeypatch_d_un_test_l_emporte_sur_le_garde(monkeypatch):
    """L'ordre RÉEL : la fixture autouse pose son garde avant le corps du
    test, celui-ci l'écrase, et c'est SON double qui répond. C'est ce qui rend
    le garde compatible avec les tests existants qui doublent ``_claude_text``
    eux-mêmes (``test_paper_llm``, ``test_paper_translate``,
    ``test_paper_router``)."""
    monkeypatch.setattr(llm, "_claude_text", lambda *a, **k: "réponse doublée")
    assert llm._claude_text("peu importe") == "réponse doublée"


@pytest.mark.real_llm
def test_le_marqueur_real_llm_retire_le_garde():
    """Le marqueur n'APPELLE rien (ce serait un test en ligne) : il prouve
    seulement que ``_claude_text`` est resté la fonction d'origine."""
    assert llm._claude_text.__module__ == "backend.bots.paper.llm"
    assert llm._claude_text.__name__ == "_claude_text"


# --------------------------------------------------------------------------- #
# 4. Les libellés des facteurs de convergence dans le frontend OmenServer
# --------------------------------------------------------------------------- #

_BTC_FACTOR_KEYS = ("paper.conv_f_funding_extreme", "paper.conv_f_oi_buildup")


def _conv_factor_i18n_keys():
    """Les clés i18n de la table FERMÉE ``_CONV_FACTORS`` de
    ``paper_module.js`` (lue au texte : le frontend est en vanilla JS, il n'y
    a rien d'autre à interroger depuis Python)."""
    source = _PAPER_JS.read_text(encoding="utf-8")
    block = re.search(r"_CONV_FACTORS:\s*\{(.*?)\n    \},", source, re.S)
    assert block, "table _CONV_FACTORS introuvable dans paper_module.js"
    return re.findall(r"^\s*\w+:\s*\['([^']+)'", block.group(1), re.M)


def _lang_blocks():
    """``{"fr": "…", "en": "…", "it": "…"}`` — le corps de chaque table de
    traduction de ``lang.js``, découpé sur ses en-têtes ``fr:``/``en:``/``it:``."""
    source = _LANG_JS.read_text(encoding="utf-8")
    heads = [(m.group(1), m.start()) for m in
             re.finditer(r"^        (fr|en|it): \{$", source, re.M)]
    assert [h[0] for h in heads] == ["fr", "en", "it"], heads
    bounds = [h[1] for h in heads] + [len(source)]
    return {heads[i][0]: source[bounds[i]:bounds[i + 1]]
            for i in range(len(heads))}


@pytest.mark.parametrize("key", _BTC_FACTOR_KEYS)
def test_les_deux_facteurs_BTC_sont_dans_la_table_des_facteurs(key):
    assert key in _conv_factor_i18n_keys()


@pytest.mark.parametrize("code", ("funding_extreme", "oi_buildup"))
def test_les_codes_des_facteurs_BTC_sont_CEUX_du_backend(code):
    """Un code inventé côté frontend afficherait le code brut du backend."""
    from backend.bots.paper import btc
    assert code in (btc.FACTOR_FUNDING, btc.FACTOR_OI)


@pytest.mark.parametrize("lang", ("fr", "en", "it"))
@pytest.mark.parametrize("key", _BTC_FACTOR_KEYS)
def test_les_deux_facteurs_BTC_sont_traduits_dans_les_trois_langues(key, lang):
    block = _lang_blocks()[lang]
    found = re.search(r"'%s': '(.*?)'(?<!\\'),\n" % re.escape(key), block)
    assert found, "%s manquante en %s" % (key, lang)
    assert len(found.group(1)) > 10


@pytest.mark.parametrize("lang", ("fr", "en", "it"))
def test_AUCUN_facteur_de_convergence_n_est_orphelin(lang):
    """Parité COMPLÈTE de la table, pas seulement des deux nouvelles clés :
    c'est ce qui empêchera le prochain facteur d'arriver sans libellé."""
    block = _lang_blocks()[lang]
    missing = [k for k in _conv_factor_i18n_keys()
               if ("'%s':" % k) not in block]
    assert missing == []


def test_les_versions_des_fichiers_frontend_ont_ete_bumpees():
    """Sans le bump, le service worker sert l'ancien ``lang.js`` et les deux
    libellés n'apparaissent jamais chez l'utilisateur (piège du dépôt)."""
    index = (_PROJECT_ROOT / "frontend" / "index.html").read_text(encoding="utf-8")
    sw = (_PROJECT_ROOT / "frontend" / "sw.js").read_text(encoding="utf-8")
    assert "/js/lang.js?v=292" in index
    assert "/js/paper_module.js?v=30" in index
    assert "omenserver-v189" in sw


# --------------------------------------------------------------------------- #
# 5. Le refiltrage des échantillons de scalp sur la fenêtre entrée/sortie
# --------------------------------------------------------------------------- #

_T0 = datetime(2026, 9, 10, 9, 0, 0, tzinfo=timezone.utc)


def _clean(samples):
    return {"side": "buy", "entry_price": 100.0,
            "entry_dt": _T0, "exit_dt": _T0 + timedelta(minutes=3),
            "samples": samples}


def test_les_excursions_ne_comptent_que_la_fenetre_du_trade():
    """Un échantillon hors fenêtre, PLUS extrême, ne doit toucher ni le MAE ni
    le MFE : il décrirait un creux ou un sommet que le trade n'a pas vécu."""
    dedans = _clean([(_T0 + timedelta(minutes=1), 99.0),
                     (_T0 + timedelta(minutes=2), 101.0)])
    dehors = _clean([(_T0 - timedelta(minutes=5), 90.0),
                     (_T0 + timedelta(minutes=1), 99.0),
                     (_T0 + timedelta(minutes=2), 101.0),
                     (_T0 + timedelta(minutes=9), 120.0)])

    assert scalps._excursions(dedans) == {"mae_pct": -1.0, "mfe_pct": 1.0}
    assert scalps._excursions(dehors) == scalps._excursions(dedans)


def test_les_bornes_de_la_fenetre_sont_INCLUSES():
    """Le tick d'entrée et celui de sortie font partie du trade."""
    got = scalps._excursions(_clean([(_T0, 98.0),
                                     (_T0 + timedelta(minutes=3), 103.0)]))
    assert got == {"mae_pct": -2.0, "mfe_pct": 3.0}


def test_sans_echantillon_dans_la_fenetre_on_ne_mesure_RIEN():
    """``None``, jamais ``0.0`` : un zéro prétendrait avoir mesuré une
    excursion nulle (doctrine de ``tradestats.excursions``)."""
    got = scalps._excursions(_clean([(_T0 - timedelta(hours=1), 90.0)]))
    assert got == {"mae_pct": None, "mfe_pct": None}


def test_sans_bornes_lisibles_aucun_echantillon_n_est_jete():
    """``settle`` est aussi appelée sur des dictionnaires forgés à la main :
    une borne absente ne doit pas faire tomber la mesure."""
    got = scalps._excursions({"side": "buy", "entry_price": 100.0,
                              "samples": [(_T0, 99.0), (_T0, 101.0)]})
    assert got == {"mae_pct": -1.0, "mfe_pct": 1.0}
