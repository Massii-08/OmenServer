"""Tests de la sauvegarde nocturne du simulateur (Lot G1) — 100% hors ligne.

Isolation : ``store.DATA_DIR`` est monkeypatché vers ``tmp_path`` pour CHAQUE
test (même fixture autouse que test_paper_store.py) — on n'écrit jamais dans
le vrai ``data/paper_trading/`` du dépôt, et ``default_dest_dir()`` (qui en
dérive) suit automatiquement.
"""
import json
import os
import stat
import tarfile
from datetime import datetime, timezone
from pathlib import Path

import pytest

from backend.bots.paper import backup, store


@pytest.fixture(autouse=True)
def _isolate_data_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "DATA_DIR", tmp_path / "paper_trading")
    yield


# --------------------------------------------------------------------------- #
# PUR -- should_run / heure locale
# --------------------------------------------------------------------------- #

def test_should_run_true_when_never_backed_up_and_hour_ok():
    # 08:00 UTC en janvier = 09:00 à Rome (UTC+1, hiver) -- après RUN_AFTER_HOUR.
    now = datetime(2026, 1, 15, 8, 0, 0, tzinfo=timezone.utc)
    assert backup.should_run(now, None) is True


def test_should_run_false_before_run_after_hour_local():
    # 5h UTC en janvier = 6h à Rome (hiver) -- avant 7h locale.
    now = datetime(2026, 1, 15, 5, 0, 0, tzinfo=timezone.utc)
    assert backup.should_run(now, None) is False


def test_should_run_false_when_already_done_today_local():
    now = datetime(2026, 1, 15, 8, 0, 0, tzinfo=timezone.utc)
    assert backup.should_run(now, backup._local_day(now)) is False


def test_should_run_true_when_last_backup_was_a_different_local_day():
    now = datetime(2026, 1, 15, 8, 0, 0, tzinfo=timezone.utc)
    assert backup.should_run(now, "2026-01-14") is True


def test_should_run_uses_local_day_not_utc_day_across_midnight():
    """23h30 UTC un 15 janvier = 00h30 le 16 à Rome (hiver, UTC+1) -- c'est le
    jour LOCAL qui doit compter, pas le jour UTC (sinon le gate se déclenche
    ou se bloque un jour trop tôt/tard selon le fuseau)."""
    now = datetime(2026, 1, 15, 23, 30, 0, tzinfo=timezone.utc)
    assert backup._local_day(now) == "2026-01-16"
    # Déjà fait le jour UTC (15) mais PAS le jour local (16) -> encore dû,
    # sauf que l'heure locale (00h30) est avant RUN_AFTER_HOUR -> False quand
    # même, pour la bonne raison (l'heure), pas la mauvaise (la date).
    assert backup.should_run(now, "2026-01-15") is False
    assert backup._local_hour(now) == 0


def test_should_run_accepts_naive_datetime_as_utc():
    now = datetime(2026, 1, 15, 8, 0, 0)     # naïf
    assert backup.should_run(now, None) is True


def test_local_hour_reflects_dst_in_summer():
    # 5h30 UTC en juillet = 7h30 à Rome (été, UTC+2) -- pile après le seuil.
    now = datetime(2026, 7, 15, 5, 30, 0, tzinfo=timezone.utc)
    assert backup._local_hour(now) == 7
    assert backup.should_run(now, None) is True


# --------------------------------------------------------------------------- #
# I/O -- run_backup (chemins injectés)
# --------------------------------------------------------------------------- #

NOW = datetime(2026, 1, 15, 8, 0, 0, tzinfo=timezone.utc)


def _seed_src(tmp_path, name="paper_trading"):
    src = tmp_path / name
    src.mkdir(parents=True, exist_ok=True)
    (src / "alice.json").write_text('{"cash_chf": 1000}', encoding="utf-8")
    (src / "alice.watchlist.json").write_text('{"symbols": []}', encoding="utf-8")
    return src


def test_run_backup_writes_named_archive_with_source_contents(tmp_path):
    src = _seed_src(tmp_path)
    dest = tmp_path / "backups" / "paper_trading"
    target = backup.run_backup(NOW, src, dest)

    assert target == dest / "paper-20260115.tar.gz"
    assert target.is_file()
    with tarfile.open(str(target), "r:gz") as tar:
        names = tar.getnames()
    assert "paper_trading/alice.json" in names
    assert "paper_trading/alice.watchlist.json" in names


def test_run_backup_leaves_no_tmp_file_on_success(tmp_path):
    src = _seed_src(tmp_path)
    dest = tmp_path / "backups" / "paper_trading"
    backup.run_backup(NOW, src, dest)
    leftovers = [p for p in dest.iterdir() if p.name.startswith(".")]
    assert leftovers == []


def test_run_backup_tolerates_missing_source(tmp_path):
    src = tmp_path / "does_not_exist"
    dest = tmp_path / "backups" / "paper_trading"
    target = backup.run_backup(NOW, src, dest)
    assert target.is_file()
    with tarfile.open(str(target), "r:gz") as tar:
        assert tar.getnames() == []


def test_run_backup_rotation_keeps_only_the_most_recent(tmp_path):
    src = _seed_src(tmp_path)
    dest = tmp_path / "backups" / "paper_trading"
    dest.mkdir(parents=True)
    for day in ("20260110", "20260111", "20260112"):
        (dest / ("paper-%s.tar.gz" % day)).write_bytes(b"old")

    backup.run_backup(NOW, src, dest, keep=2)

    remaining = sorted(p.name for p in dest.glob("paper-*.tar.gz"))
    # 3 anciennes + 1 neuve = 4, keep=2 -> les 2 plus RÉCENTES par nom
    # (tri lexicographique = tri chronologique sur AAAAMMJJ).
    assert remaining == ["paper-20260112.tar.gz", "paper-20260115.tar.gz"]


def test_run_backup_excludes_dest_dir_when_nested_inside_src(tmp_path):
    """Un appelant qui configure dest SOUS src ne doit jamais produire une
    archive qui s'engloutit elle-même."""
    src = _seed_src(tmp_path)
    dest = src / "backups"     # dest DANS src, cas normalement jamais vu en prod
    dest.mkdir()
    (dest / "old.tar.gz").write_bytes(b"stale")

    target = backup.run_backup(NOW, src, dest)
    with tarfile.open(str(target), "r:gz") as tar:
        names = tar.getnames()
    assert "paper_trading/alice.json" in names
    assert not any(n.startswith("paper_trading/backups") for n in names)


def test_run_backup_default_keep_constant_used():
    assert backup.KEEP == 14


# --------------------------------------------------------------------------- #
# I/O -- state (atomique, 0o600)
# --------------------------------------------------------------------------- #

def test_state_round_trips(tmp_path):
    assert backup.load_state() == {}
    backup.save_state({"last_backup_date": "2026-01-15"})
    assert backup.load_state() == {"last_backup_date": "2026-01-15"}


def test_state_file_is_0600(tmp_path):
    backup.save_state({"last_backup_date": "2026-01-15"})
    mode = stat.S_IMODE(os.stat(str(backup.state_path())).st_mode)
    assert mode == 0o600


def test_state_corrupt_file_returns_empty_dict(tmp_path):
    path = backup.state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{not valid json", encoding="utf-8")
    assert backup.load_state() == {}


def test_state_name_has_a_dot_in_its_radical():
    """Convention anti-fantôme du dépôt (cf. store.py/calendar.py) : un
    radical SANS point pourrait matcher un compte utilisateur."""
    assert "." in backup.STATE_NAME[:-len(".json")]
    with pytest.raises(ValueError):
        store.portfolio_path(backup.STATE_NAME[:-len(".json")])


# --------------------------------------------------------------------------- #
# I/O -- chemins par défaut (dérivés de store.DATA_DIR, résolus paresseusement)
# --------------------------------------------------------------------------- #

def test_default_src_dir_is_data_dir(tmp_path):
    assert backup.default_src_dir() == store.DATA_DIR


def test_default_dest_dir_is_a_sibling_of_data_dir(tmp_path):
    assert backup.default_dest_dir() == store.DATA_DIR.parent / "backups" / "paper_trading"
    # Jamais un enfant de DATA_DIR (l'archive ne doit pas s'engloutir).
    assert not str(backup.default_dest_dir()).startswith(str(store.DATA_DIR) + os.sep)


# --------------------------------------------------------------------------- #
# I/O -- maybe_run, le GATE (best-effort STRICT, n'échoue jamais)
# --------------------------------------------------------------------------- #

def test_maybe_run_backs_up_and_arms_state_when_due(tmp_path):
    _seed_src(tmp_path, name=store.DATA_DIR.name)
    # store.DATA_DIR pointe déjà vers tmp_path/"paper_trading" (fixture) --
    # on y écrit directement pour que default_src_dir() trouve quelque chose.
    store.DATA_DIR.mkdir(parents=True, exist_ok=True)
    (store.DATA_DIR / "alice.json").write_text("{}", encoding="utf-8")

    result = backup.maybe_run(now=NOW)
    assert result["ran"] is True
    assert Path(result["path"]).is_file()
    assert backup.load_state()["last_backup_date"] == "2026-01-15"


def test_maybe_run_does_nothing_twice_the_same_local_day(tmp_path):
    store.DATA_DIR.mkdir(parents=True, exist_ok=True)
    first = backup.maybe_run(now=NOW)
    assert first["ran"] is True
    second = backup.maybe_run(now=NOW + (datetime(2026, 1, 15, 9, 0, tzinfo=timezone.utc) - NOW))
    assert second["ran"] is False
    assert second["path"] is None


def test_maybe_run_never_raises_on_a_broken_runner(tmp_path):
    store.DATA_DIR.mkdir(parents=True, exist_ok=True)

    def _boom(now, src, dest, keep=backup.KEEP):
        raise RuntimeError("disque plein")

    result = backup.maybe_run(now=NOW, runner=_boom)
    assert result == {"ran": False, "path": None, "error": "RuntimeError"}
    # L'état n'a pas été armé -- un échec doit pouvoir être retenté au cycle
    # suivant, pas seulement demain.
    assert backup.load_state() == {}


def test_maybe_run_uses_injected_runner_and_paths(tmp_path):
    calls = []

    def _fake_runner(now, src, dest, keep=backup.KEEP):
        calls.append((src, dest, keep))
        target = Path(dest) / "fake.tar.gz"
        Path(dest).mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"x")
        return target

    src = tmp_path / "src"
    dest = tmp_path / "dest"
    result = backup.maybe_run(now=NOW, src_dir=src, dest_dir=dest, keep=3,
                              runner=_fake_runner)
    assert result["ran"] is True
    assert calls == [(src, dest, 3)]


def test_maybe_run_before_hour_does_nothing(tmp_path):
    store.DATA_DIR.mkdir(parents=True, exist_ok=True)
    early = datetime(2026, 1, 15, 5, 0, 0, tzinfo=timezone.utc)   # 6h à Rome
    result = backup.maybe_run(now=early)
    assert result == {"ran": False, "path": None}
