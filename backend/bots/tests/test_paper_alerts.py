"""Tests du canal Telegram du simulateur (bot ORACLE, spec §13) — 100 % hors-ligne.

Aucun réseau : ``notify.send`` est monkeypatché, et le seul cas où il pourrait
être atteint sans l'être est justement celui qu'on vérifie (canal absent ->
``False`` SANS toucher au réseau).

Isolation disque : ``store.DATA_DIR`` pointe sur ``tmp_path`` — ``alerts``
dérive son fichier de son parent, donc le vrai ``data/`` du dépôt n'est jamais
lu.
"""
import json

import pytest

from backend.bots.harvester import telegram_config
from backend.bots.paper import alerts, store

PAPER = {"token": "paper-token", "chat_id": "111"}
HARVESTER = {"token": "harvester-token", "chat_id": "222"}


@pytest.fixture(autouse=True)
def _isolate(tmp_path, monkeypatch):
    """``data/`` = tmp_path, ``data/paper_trading/`` = tmp_path/paper_trading."""
    monkeypatch.setattr(store, "DATA_DIR", tmp_path / "paper_trading")
    return tmp_path


@pytest.fixture(autouse=True)
def _no_harvester_config(monkeypatch):
    """Par défaut, AUCUN repli : les tests qui le veulent l'installent."""
    monkeypatch.setattr(telegram_config, "load", lambda path=None: {})


def _write_paper(tmp_path, payload):
    path = tmp_path / alerts.PAPER_TG_NAME
    path.write_text(json.dumps(payload) if isinstance(payload, (dict, list))
                    else str(payload), encoding="utf-8")
    return path


# --------------------------------------------------------------------------- #
# load_cfg
# --------------------------------------------------------------------------- #

def test_le_fichier_paper_est_prioritaire(tmp_path, monkeypatch):
    monkeypatch.setattr(telegram_config, "load", lambda path=None: HARVESTER)
    _write_paper(tmp_path, PAPER)
    assert alerts.load_cfg() == PAPER


def test_repli_sur_le_harvester_si_le_fichier_paper_manque(monkeypatch):
    monkeypatch.setattr(telegram_config, "load", lambda path=None: HARVESTER)
    assert alerts.load_cfg() == HARVESTER


@pytest.mark.parametrize("payload", [
    {"token": "t"},                       # pas de destinataire
    {"chat_id": "1"},                     # pas de jeton
    {"token": "", "chat_id": ""},         # posé mais vide
    ["pas", "un", "objet"],
    "{ json cassé",
])
def test_un_fichier_paper_incomplet_ou_illisible_bascule_sur_le_repli(
        tmp_path, monkeypatch, payload):
    """Une config à moitié posée n'est pas un canal : on ne s'y arrête pas."""
    monkeypatch.setattr(telegram_config, "load", lambda path=None: HARVESTER)
    _write_paper(tmp_path, payload)
    assert alerts.load_cfg() == HARVESTER


def test_rien_nulle_part_rend_none():
    assert alerts.load_cfg() is None


def test_un_harvester_incomplet_ne_compte_pas(monkeypatch):
    monkeypatch.setattr(telegram_config, "load", lambda path=None: {"token": "t"})
    assert alerts.load_cfg() is None


def test_harvester_absent_ou_en_panne_rend_none(monkeypatch):
    def boom(path=None):
        raise IOError("disque en panne")

    monkeypatch.setattr(telegram_config, "load", boom)
    assert alerts.load_cfg() is None


def test_le_chemin_est_surchargeable(tmp_path):
    other = tmp_path / "ailleurs.json"
    other.write_text(json.dumps(PAPER), encoding="utf-8")
    assert alerts.load_cfg(path=other) == PAPER


def test_le_chemin_suit_le_repertoire_de_donnees(tmp_path, monkeypatch):
    """Un test qui isole ``store.DATA_DIR`` isole aussi le canal : sans ça, une
    suite de tests pourrait lire (voire utiliser) la vraie config du serveur."""
    assert alerts.paper_path() == tmp_path / alerts.PAPER_TG_NAME
    monkeypatch.setattr(store, "DATA_DIR", tmp_path / "autre" / "paper_trading")
    assert alerts.paper_path() == tmp_path / "autre" / alerts.PAPER_TG_NAME


# --------------------------------------------------------------------------- #
# send
# --------------------------------------------------------------------------- #

class _Notify(object):
    """Faux ``notify.send`` : enregistre, ne sort jamais de la machine."""

    def __init__(self, ok=True):
        self.ok = ok
        self.calls = []

    def send(self, text, cfg, client=None):
        self.calls.append((text, cfg, client))
        return self.ok


@pytest.fixture
def spy(monkeypatch):
    from backend.bots.harvester import notify
    fake = _Notify()
    monkeypatch.setattr(notify, "send", fake.send)
    return fake


def test_send_utilise_la_config_du_disque_par_defaut(tmp_path, spy):
    _write_paper(tmp_path, PAPER)
    assert alerts.send("coucou") is True
    assert spy.calls == [("coucou", PAPER, None)]


def test_send_sans_aucun_canal_ne_touche_pas_au_reseau(spy):
    assert alerts.send("coucou") is False
    assert spy.calls == []


def test_send_avec_une_config_vide_est_un_canal_eteint(tmp_path, spy):
    """``{}`` explicite = éteint : on ne retombe PAS sur le disque (convention
    des voisins, et seule façon pour un test de garantir zéro envoi)."""
    _write_paper(tmp_path, PAPER)
    assert alerts.send("coucou", cfg={}) is False
    assert spy.calls == []


def test_send_transmet_le_client_injecte(spy):
    client = object()
    assert alerts.send("coucou", cfg=PAPER, client=client) is True
    assert spy.calls[0][2] is client


def test_send_rend_false_quand_telegram_refuse(monkeypatch):
    from backend.bots.harvester import notify
    monkeypatch.setattr(notify, "send", lambda text, cfg, client=None: False)
    assert alerts.send("coucou", cfg=PAPER) is False


def test_send_avale_toute_exception(monkeypatch):
    """Une trace d'exception pourrait porter le jeton : on ne la laisse jamais
    remonter (même posture que ``harvester/notify.py``)."""
    from backend.bots.harvester import notify

    def boom(text, cfg, client=None):
        raise RuntimeError("token=%s" % cfg.get("token"))

    monkeypatch.setattr(notify, "send", boom)
    assert alerts.send("coucou", cfg=PAPER) is False


def test_aucune_valeur_de_config_n_est_loguee(tmp_path, spy, caplog):
    _write_paper(tmp_path, PAPER)
    with caplog.at_level("DEBUG", logger="omenserver"):
        alerts.load_cfg()
        alerts.send("coucou")
    assert "paper-token" not in caplog.text and "111" not in caplog.text
