"""Tests de la persistance du simulateur paper trading — I/O fichier only.

Isolation : DATA_DIR est monkeypatché vers tmp_path pour CHAQUE test (fixture
autouse) — on n'écrit jamais dans le vrai data/paper_trading/ du repo.
"""
import os
import stat

import pytest

from backend.bots.paper import store


@pytest.fixture(autouse=True)
def _isolate_data_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "DATA_DIR", tmp_path)
    yield


# --------------------------------------------------------------------------- #
# username : validation stricte (rejet, pas de sanitisation silencieuse)
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("bad", [
    "", "a b", "a/b", "a..b", "../etc/passwd", "héllo", "user@site",
    "a" * 200, None, 123, "with\nnewline",
    "alice\n",  # piège $ + match() : accepterait à tort un '\n' final (fullmatch requis)
])
def test_sanitize_username_rejects_invalid(bad):
    with pytest.raises(ValueError):
        store.portfolio_path(bad)


@pytest.mark.parametrize("good", ["alice", "Alice_08", "user-123", "MASSII", "a"])
def test_sanitize_username_accepts_valid(good, tmp_path):
    assert store.portfolio_path(good) == tmp_path / f"{good}.json"


# --------------------------------------------------------------------------- #
# portfolio_path / coach_path
# --------------------------------------------------------------------------- #

def test_portfolio_path_uses_data_dir(tmp_path):
    assert store.portfolio_path("alice") == tmp_path / "alice.json"


def test_coach_path_uses_data_dir(tmp_path):
    assert store.coach_path("alice") == tmp_path / "alice.coach.json"


def test_portfolio_and_coach_paths_do_not_collide():
    assert store.portfolio_path("alice") != store.coach_path("alice")


# --------------------------------------------------------------------------- #
# load_* absent -> None
# --------------------------------------------------------------------------- #

def test_load_portfolio_missing_returns_none():
    assert store.load_portfolio("alice") is None


def test_load_coach_missing_returns_none():
    assert store.load_coach("alice") is None


# --------------------------------------------------------------------------- #
# save/load roundtrip
# --------------------------------------------------------------------------- #

def test_save_then_load_portfolio_roundtrip():
    data = {"cash_chf": 9000.0, "positions": [], "open_orders": [], "trades": [],
            "fee_profile": "yuh", "initial_capital": 10000.0, "created_at": "2026-08-24T00:00:00"}
    store.save_portfolio("alice", data)
    assert store.load_portfolio("alice") == data


def test_save_then_load_coach_roundtrip():
    data = {"created_at": "2026-08-24T00:00:00", "n_sessions": 1, "bias_history": {},
            "resolved_biases": [], "milestones": [], "arena_history": [], "notes": []}
    store.save_coach("alice", data)
    assert store.load_coach("alice") == data


def test_save_overwrites_previous_content():
    store.save_portfolio("dave", {"cash_chf": 1})
    store.save_portfolio("dave", {"cash_chf": 2})
    assert store.load_portfolio("dave") == {"cash_chf": 2}


def test_two_users_do_not_collide():
    store.save_portfolio("alice", {"cash_chf": 111})
    store.save_portfolio("bob", {"cash_chf": 222})
    assert store.load_portfolio("alice") == {"cash_chf": 111}
    assert store.load_portfolio("bob") == {"cash_chf": 222}


# --------------------------------------------------------------------------- #
# écriture atomique 0o600
# --------------------------------------------------------------------------- #

def test_save_portfolio_is_chmod_600():
    store.save_portfolio("alice", {"cash_chf": 1})
    mode = stat.S_IMODE(os.stat(store.portfolio_path("alice")).st_mode)
    assert mode == 0o600


def test_save_coach_is_chmod_600():
    store.save_coach("alice", {"n_sessions": 1})
    mode = stat.S_IMODE(os.stat(store.coach_path("alice")).st_mode)
    assert mode == 0o600


def test_save_is_600_even_if_fchmod_unavailable(monkeypatch):
    # défense en profondeur : le fichier doit NAÎTRE en 0o600 (création
    # atomique via os.open), pas via un chmod post-création.
    def _boom(*a, **k):
        raise OSError("fchmod unavailable")
    if hasattr(store.os, "fchmod"):
        monkeypatch.setattr(store.os, "fchmod", _boom)
    store.save_portfolio("alice", {"cash_chf": 1})
    mode = stat.S_IMODE(os.stat(store.portfolio_path("alice")).st_mode)
    assert mode == 0o600


def test_no_leftover_tmp_files_after_save(tmp_path):
    store.save_portfolio("carol", {"cash_chf": 10000})
    leftovers = [p for p in tmp_path.iterdir() if ".tmp-" in p.name]
    assert leftovers == []


def test_save_creates_data_dir_if_missing(tmp_path, monkeypatch):
    nested = tmp_path / "nested" / "dir"
    monkeypatch.setattr(store, "DATA_DIR", nested)
    assert not nested.exists()
    store.save_portfolio("alice", {"cash_chf": 1})
    assert nested.is_dir()
    assert store.load_portfolio("alice") == {"cash_chf": 1}


def test_failed_write_does_not_corrupt_existing_file_or_leave_tmp(tmp_path):
    store.save_portfolio("erin", {"cash_chf": 100})

    class Unserializable(object):
        pass

    with pytest.raises(TypeError):
        store.save_portfolio("erin", {"bad": Unserializable()})
    # l'écriture a échoué AVANT le replace -> le fichier existant reste intact
    assert store.load_portfolio("erin") == {"cash_chf": 100}
    leftovers = [p for p in tmp_path.iterdir() if ".tmp-" in p.name]
    assert leftovers == []


# --------------------------------------------------------------------------- #
# lecture tolérante : JSON corrompu
# --------------------------------------------------------------------------- #

def test_load_portfolio_corrupt_json_is_renamed_and_returns_none(tmp_path):
    p = store.portfolio_path("bob")
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text("{not valid json", encoding="utf-8")
    assert store.load_portfolio("bob") is None
    assert not p.exists()
    corrupt = tmp_path / "bob.json.corrupt"
    assert corrupt.is_file()
    assert corrupt.read_text(encoding="utf-8") == "{not valid json"


def test_load_coach_corrupt_json_is_renamed_and_returns_none(tmp_path):
    p = store.coach_path("bob")
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text("not json at all", encoding="utf-8")
    assert store.load_coach("bob") is None
    corrupt = tmp_path / "bob.coach.json.corrupt"
    assert corrupt.is_file()


# --------------------------------------------------------------------------- #
# §11 — carnet Markdown : vault_dir / append_note / list_notes / read_note
# --------------------------------------------------------------------------- #

def test_vault_dir_creates_directory(tmp_path):
    d = store.vault_dir("alice")
    assert d == tmp_path / "alice-vault"
    assert d.is_dir()


def test_vault_dir_rejects_bad_username():
    with pytest.raises(ValueError):
        store.vault_dir("../etc")


@pytest.mark.parametrize("bad_name", [
    "", "Journal", "Journal.txt", "../Journal.md", "/Journal.md",
    "Biais/sub/deep.md", "Bi ais/x.md", "Biais/.md", "..md", "Biais/../x.md",
    "Journal.md\n",  # même piège $ + match() que le username
])
def test_validate_rel_name_rejects_invalid(bad_name):
    with pytest.raises(ValueError):
        store.append_note("alice", bad_name, "texte")


@pytest.mark.parametrize("good_name", ["Journal.md", "Biais/revenge_trade.md", "Biais/no_stop.md"])
def test_validate_rel_name_accepts_valid(good_name, tmp_path):
    store.append_note("alice", good_name, "texte")
    assert (tmp_path / "alice-vault" / good_name).is_file()


def test_append_note_creates_file_and_subdirectory(tmp_path):
    store.append_note("alice", "Biais/no_stop.md", "## bloc 1\n\n")
    target = tmp_path / "alice-vault" / "Biais" / "no_stop.md"
    assert target.is_file()
    assert target.read_text(encoding="utf-8") == "## bloc 1\n\n"


def test_append_note_appends_without_overwriting():
    store.append_note("alice", "Journal.md", "## bloc 1\n\n")
    store.append_note("alice", "Journal.md", "## bloc 2\n\n")
    content = store.read_note("alice", "Journal.md")
    assert content == "## bloc 1\n\n## bloc 2\n\n"


def test_append_note_is_chmod_600(tmp_path):
    store.append_note("alice", "Journal.md", "x")
    mode = stat.S_IMODE(os.stat(tmp_path / "alice-vault" / "Journal.md").st_mode)
    assert mode == 0o600


def test_append_note_600_even_if_fchmod_unavailable(monkeypatch, tmp_path):
    def _boom(*a, **k):
        raise OSError("fchmod unavailable")
    if hasattr(store.os, "fchmod"):
        monkeypatch.setattr(store.os, "fchmod", _boom)
    store.append_note("alice", "Journal.md", "x")
    mode = stat.S_IMODE(os.stat(tmp_path / "alice-vault" / "Journal.md").st_mode)
    assert mode == 0o600


def test_list_notes_empty_when_vault_absent():
    assert store.list_notes("alice") == []


def test_list_notes_does_not_create_vault_directory(tmp_path):
    store.list_notes("alice")
    assert not (tmp_path / "alice-vault").exists()


def test_list_notes_returns_name_size_modified_sorted_desc():
    store.append_note("alice", "Journal.md", "aaaa")
    store.append_note("alice", "Biais/no_stop.md", "bb")
    notes = store.list_notes("alice")
    names = {n["name"] for n in notes}
    assert names == {"Journal.md", "Biais/no_stop.md"}
    for n in notes:
        assert set(n.keys()) == {"name", "size", "modified"}
        assert isinstance(n["size"], int)
        assert isinstance(n["modified"], str)
    journal = next(n for n in notes if n["name"] == "Journal.md")
    assert journal["size"] == 4
    # tri décroissant par modified : le plus récent en premier
    mods = [n["modified"] for n in notes]
    assert mods == sorted(mods, reverse=True)


def test_read_note_missing_returns_none():
    assert store.read_note("alice", "Journal.md") is None


def test_read_note_returns_content():
    store.append_note("alice", "Biais/oversized.md", "## contenu\n")
    assert store.read_note("alice", "Biais/oversized.md") == "## contenu\n"


def test_read_note_rejects_invalid_rel_name():
    with pytest.raises(ValueError):
        store.read_note("alice", "../../etc/passwd.md")


def test_read_note_confined_to_vault_even_via_symlink(tmp_path):
    # ceinture+bretelles : même si un lien symbolique pointait hors du vault,
    # la vérification relative_to() doit refuser de servir le contenu.
    outside = tmp_path / "outside.md"
    outside.write_text("secret hors vault", encoding="utf-8")
    vault = store.vault_dir("alice")
    (vault / "Biais").mkdir(parents=True, exist_ok=True)
    link = vault / "Biais" / "escape.md"
    try:
        link.symlink_to(outside)
    except OSError:
        pytest.skip("symlinks non supportés dans cet environnement")
    assert store.read_note("alice", "Biais/escape.md") is None


def test_notes_are_isolated_per_user():
    store.append_note("alice", "Journal.md", "alice content")
    store.append_note("bob", "Journal.md", "bob content")
    assert store.read_note("alice", "Journal.md") == "alice content"
    assert store.read_note("bob", "Journal.md") == "bob content"
