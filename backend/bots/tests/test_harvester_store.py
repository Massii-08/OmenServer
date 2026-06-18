from backend.bots.harvester.store import Store


def test_add_todo_dedups_and_next_todo_order(tmp_path):
    s = Store(str(tmp_path / "store.json"))
    assert s.add_todo("u1") is True
    assert s.add_todo("u2") is True
    assert s.add_todo("u1") is False  # already seen
    assert s.next_todo() == "u1"
    s.mark_done("u1")
    assert s.next_todo() == "u2"


def test_add_todo_after_done_is_noop(tmp_path):
    s = Store(str(tmp_path / "store.json"))
    s.add_todo("u1")
    s.mark_done("u1")
    assert s.add_todo("u1") is False  # done counts as seen
    assert s.next_todo() is None


def test_records_and_counts(tmp_path):
    s = Store(str(tmp_path / "store.json"))
    s.add_todo("u1")
    s.add_record({"title": "A"})
    s.add_record({"title": "B"})
    s.add_error()
    c = s.counts()
    assert c == {"todo": 1, "done": 0, "records": 2, "errors": 1}


def test_save_and_resume_roundtrip(tmp_path):
    path = str(tmp_path / "store.json")
    s = Store(path)
    s.add_todo("u1")
    s.add_todo("u2")
    s.mark_done("u1")
    s.add_record({"title": "A"})
    s.save()

    s2 = Store.load(path)
    assert s2.next_todo() == "u2"          # u1 already done, not re-served
    assert s2.add_todo("u1") is False      # seen survives reload
    assert s2.counts() == {"todo": 1, "done": 1, "records": 1, "errors": 0}


def test_load_missing_file_is_empty(tmp_path):
    s = Store.load(str(tmp_path / "nope.json"))
    assert s.next_todo() is None
    assert s.counts() == {"todo": 0, "done": 0, "records": 0, "errors": 0}
