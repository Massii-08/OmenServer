"""LOT 18 — le registre du coach garde tout (archive JSONL mensuelle) et les
faux refus ``stop_widen`` (stop recopié à l'identique) ne sont plus des
événements. 100 % hors ligne, disque en tmp."""
import json
import os
import stat
import tarfile
from datetime import datetime, timezone

import pytest

from backend.bots import paper_router as pr
from backend.bots.paper import backup, coach_trader, llm, radar, store
from backend.bots.tests.test_paper_router import (
    FIXED_NOW, coach_portfolio, make_client, seed_coach_position,
    seed_coach_short)


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    d = tmp_path / "paper_trading"
    monkeypatch.setattr(store, "DATA_DIR", d)
    return d


def _row(ts, action="hold", symbol=""):
    return {"ts": ts, "source": "daily", "action": action, "symbol": symbol,
            "accepted": True}


# --------------------------------------------------------------------------- #
# Défaut C — l'archive
# --------------------------------------------------------------------------- #

def test_append_archive_ecrit_une_ligne_dans_le_fichier_du_mois(data_dir):
    store.append_ledger_archive("coach", _row("2026-10-03T10:00:00"))
    path = data_dir / "coach.ledger.2026-10.jsonl"
    assert path.is_file()
    lines = path.read_text(encoding="utf-8").splitlines()
    assert json.loads(lines[-1])["ts"] == "2026-10-03T10:00:00"
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600


def test_amorcage_ecrit_les_lignes_existantes_par_mois_dans_l_ordre(data_dir):
    # Registre : plus récent d'abord.
    store.save_ledger("coach", [
        _row("2026-11-02T09:00:00", "buy", "A"),
        _row("2026-10-30T09:00:00", "buy", "B"),
        _row("2026-10-01T09:00:00", "buy", "C"),
    ])
    store.append_ledger_archive("coach", _row("2026-11-05T09:00:00", "sell", "D"))
    out = store.load_ledger_archive("coach")
    assert [r["symbol"] for r in out] == ["C", "B", "A", "D"]
    octo = store.load_ledger_archive("coach", month="2026-10")
    assert [r["symbol"] for r in octo] == ["C", "B"]
    nov = store.load_ledger_archive("coach", month="2026-11")
    assert [r["symbol"] for r in nov] == ["A", "D"]


def test_deuxieme_ecriture_n_ajoute_qu_une_ligne(data_dir):
    store.save_ledger("coach", [_row("2026-11-02T09:00:00", "buy", "A")])
    store.append_ledger_archive("coach", _row("2026-11-05T09:00:00", "x", "B"))
    store.append_ledger_archive("coach", _row("2026-11-06T09:00:00", "x", "C"))
    assert [r["symbol"] for r in store.load_ledger_archive("coach")] == \
        ["A", "B", "C"]


def test_archive_sans_ts_valide_retombe_sur_le_mois_courant(data_dir):
    store.append_ledger_archive("coach", {"action": "hold"})
    month = datetime.now(timezone.utc).strftime("%Y-%m")
    files = [p.name for p in data_dir.glob("coach.ledger.*.jsonl")]
    assert files and all(f.endswith(".jsonl") for f in files)
    assert len(store.load_ledger_archive("coach", month=month)) in (0, 1)
    assert len(store.load_ledger_archive("coach")) == 1


def test_load_archive_ignore_les_lignes_illisibles_et_ne_leve_pas(data_dir):
    store.append_ledger_archive("coach", _row("2026-10-03T10:00:00", "a", "A"))
    path = data_dir / "coach.ledger.2026-10.jsonl"
    with open(path, "a", encoding="utf-8") as f:
        f.write("pas du json\n")
    store.append_ledger_archive("coach", _row("2026-10-04T10:00:00", "a", "B"))
    assert [r["symbol"] for r in store.load_ledger_archive("coach")] == ["A", "B"]
    assert store.load_ledger_archive("inconnu") == []
    assert store.load_ledger_archive("coach", month="2000-01") == []


def test_append_archive_ne_leve_jamais(data_dir, monkeypatch):
    def boom(*a, **k):
        raise OSError("disque plein")
    monkeypatch.setattr(store.os, "open", boom)
    store.append_ledger_archive("coach", _row("2026-10-03T10:00:00"))  # ne lève pas
    store.append_ledger_archive("nom invalide !", _row("2026-10-03T10:00:00"))


def test_le_routeur_archive_chaque_entree_poussee(tmp_path, monkeypatch):
    make_client(tmp_path, monkeypatch)
    store.save_ledger("coach", [_row("2026-08-20T09:00:00", "buy", "OLD")])
    pr._push_coach_ledger([_row("2026-08-24T10:00:00", "hold"),
                           _row("2026-08-24T10:01:00", "note")])
    arch = store.load_ledger_archive("coach")
    assert [r["ts"] for r in arch] == [
        "2026-08-20T09:00:00", "2026-08-24T10:00:00", "2026-08-24T10:01:00"]
    pr._push_coach_ledger([_row("2026-08-25T10:00:00", "hold")])
    assert len(store.load_ledger_archive("coach")) == 4
    assert len(store.load_ledger("coach")) == 4


def test_un_echec_d_archive_n_empeche_pas_le_registre(tmp_path, monkeypatch):
    make_client(tmp_path, monkeypatch)

    def boom(*a, **k):
        raise OSError("archive KO")
    monkeypatch.setattr(store, "append_ledger_archive", boom)
    pr._push_coach_ledger([_row("2026-08-24T10:00:00", "hold")])
    assert [r["ts"] for r in store.load_ledger("coach")] == ["2026-08-24T10:00:00"]


def test_max_ledger_reste_200():
    assert coach_trader.MAX_LEDGER == 200


def test_le_jsonl_n_est_pas_pris_pour_un_utilisateur(data_dir, monkeypatch):
    store.append_ledger_archive("coach", _row("2026-10-03T10:00:00"))
    store.save_ledger("coach", [_row("2026-10-03T10:00:00")])
    assert (data_dir / "coach.ledger.2026-10.jsonl").is_file()
    assert "coach.ledger.2026-10" not in radar._users_with_portfolio()
    assert "coach.ledger" not in radar._users_with_portfolio()
    assert not radar._USER_FILE_RE.match("coach.ledger.2026-10.jsonl")
    assert radar._users_with_portfolio() == []


def test_la_sauvegarde_nocturne_embarque_l_archive(data_dir, tmp_path):
    store.append_ledger_archive("coach", _row("2026-10-03T10:00:00"))
    dest = tmp_path / "backups"
    target = backup.run_backup(datetime(2026, 11, 11, 3, 0, tzinfo=timezone.utc),
                               data_dir, dest)
    with tarfile.open(str(target)) as tar:
        names = tar.getnames()
    assert any(n.endswith("coach.ledger.2026-10.jsonl") for n in names)


# --------------------------------------------------------------------------- #
# Défaut D — le stop recopié
# --------------------------------------------------------------------------- #

def test_drop_noop_adjusts_pur():
    positions = [{"symbol": "NESN.SW", "side": "long", "stop_loss": 80.9},
                 {"symbol": "ABC", "side": "long", "stop_loss": None}]
    acts = [
        {"action": "adjust_stop", "symbol": "NESN.SW", "stop": 80.9},
        {"action": "adjust_stop", "symbol": "NESN.SW", "stop": 80.9000000001},
        {"action": "adjust_stop", "symbol": "NESN.SW", "stop": 81.5},
        {"action": "adjust_stop", "symbol": "ABC", "stop": 10.0},
        {"action": "sell", "symbol": "NESN.SW"},
    ]
    kept, dropped = coach_trader.drop_noop_adjusts(acts, positions)
    assert [a["action"] for a in dropped] == ["adjust_stop", "adjust_stop"]
    assert len(kept) == 3
    assert coach_trader.drop_noop_adjusts(None, None) == ([], [])
    assert coach_trader.drop_noop_adjusts(["x"], positions) == (["x"], [])


@pytest.mark.parametrize("source", ["daily", "digest", "guardian"])
def test_adjust_stop_a_l_identique_est_un_non_evenement(
        tmp_path, monkeypatch, source):
    make_client(tmp_path, monkeypatch)
    seed_coach_position(qty=10, stop_loss=80.9)
    rows = pr.execute_coach_actions(
        [{"action": "adjust_stop", "symbol": "NESN.SW", "stop": 80.9}],
        source=source, note="je garde le stop")
    assert [r["action"] for r in rows] == ["hold"]
    assert rows[0]["accepted"] is True
    assert rows[0]["detail"] == "je garde le stop"
    assert all(r.get("reason") != "stop_widen"
               for r in store.load_ledger("coach"))
    assert coach_portfolio()["positions"][0]["stop_loss"] == 80.9


def test_noop_melange_a_une_vraie_action_ne_garde_que_la_vraie(
        tmp_path, monkeypatch):
    make_client(tmp_path, monkeypatch)
    seed_coach_position(qty=10, stop_loss=80.9)
    rows = pr.execute_coach_actions(
        [{"action": "adjust_stop", "symbol": "NESN.SW", "stop": 80.9},
         {"action": "adjust_stop", "symbol": "NESN.SW", "stop": 80.0}],
        source="daily")
    assert [r.get("reason") for r in rows] == ["stop_widen"]


def test_un_vrai_recul_reste_refuse_stop_widen(tmp_path, monkeypatch):
    make_client(tmp_path, monkeypatch)
    seed_coach_position(qty=10, stop_loss=80.9)
    rows = pr.execute_coach_actions(
        [{"action": "adjust_stop", "symbol": "NESN.SW", "stop": 80.0}],
        source="daily")
    assert rows[0]["reason"] == "stop_widen"


def test_adjust_stop_a_l_identique_sur_un_short_aussi(tmp_path, monkeypatch):
    make_client(tmp_path, monkeypatch)
    seed_coach_short(qty=15, stop_loss=108.0)
    rows = pr.execute_coach_actions(
        [{"action": "adjust_stop", "symbol": "NESN.SW", "stop": 108.0}],
        source="guardian")
    assert [r["action"] for r in rows] == ["hold"]


# --- le prompt du gardien --------------------------------------------------- #

CTX = {"symbol": "NESN.SW", "side": "long", "qty": 20, "avg_price": 92.4,
       "current_price": 98.5, "stop_loss": 80.9, "target": 110.0,
       "trigger": "move"}


def _json_block(prompt):
    start = prompt.rindex("```" + coach_trader.ACTIONS_MARKER)
    return prompt[start:]


def test_prompt_gardien_exemple_final_est_aucune_action():
    block = _json_block(llm.build_coach_guardian_prompt(CTX))
    assert '"actions": []' in block
    assert "80.9" not in block
    assert "adjust_stop" not in block


def test_prompt_gardien_le_bloc_reste_le_dernier_element():
    prompt = llm.build_coach_guardian_prompt(CTX)
    assert prompt.rstrip().endswith("```")
    assert prompt.count("```" + coach_trader.ACTIONS_MARKER) == 1
    assert prompt.endswith("```")


def test_prompt_gardien_explique_resserrer_et_interdit_le_stop_en_place():
    prompt = llm.build_coach_guardian_prompt(CTX)
    before = prompt[:prompt.rindex("```" + coach_trader.ACTIONS_MARKER)]
    assert "NOUVEAU niveau" in before
    assert "strictement plus protecteur" in before
    assert "80.9" in before
    assert "Ne renvoie jamais un `adjust_stop` au niveau déjà en place" in before
    assert "ce n'est pas une action" in before


def test_prompt_gardien_sans_stop_connu_ne_plante_pas():
    prompt = llm.build_coach_guardian_prompt(dict(CTX, stop_loss=None))
    assert "NOUVEAU niveau" in prompt
