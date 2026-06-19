import json

from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.bots import harvester_router as hr
from backend.auth.utils import get_current_user


class FakeUser(object):
    def __init__(self, is_admin):
        self.is_admin = is_admin
        self.role = "admin" if is_admin else "player"
        self.username = "tester"


def make_client(tmp_path, monkeypatch, is_admin=True):
    # isolate the runs dir + neutralise the real subprocess launch
    monkeypatch.setattr(hr, "HARVESTER_RUNS_DIR", tmp_path)

    launched = {}

    def fake_launch(run_dir, job):
        launched["run_dir"] = run_dir
        job["status"] = "running"
        job["process"] = None
        # mirror the real launch contract: a pidfile (live pid) so the
        # disk-based status reconstruction (A) sees the run as "running".
        import os as _os
        hr._pid_path(run_dir).write_text(str(_os.getpid()), encoding="utf-8")
        return None

    monkeypatch.setattr(hr, "_launch_subprocess", fake_launch)

    app = FastAPI()
    app.include_router(hr.router)
    app.dependency_overrides[get_current_user] = lambda: FakeUser(is_admin)
    return TestClient(app), launched


GOOD_BODY = {
    "url": "https://books.toscrape.com/catalogue/page-1.html",
    "recipe": {
        "item_selector": {"tag": "article", "class": "product_pod"},
        "fields": {"title": {"selector": {"tag": "a"}, "extract": "attr:title"}},
    },
    "plan": {"mode": "pagination", "next_selector": {"tag": "li", "class": "next"}},
    "pacing": {"min_interval_s": 1.5, "jitter": [0.5, 2.0]},
}


def test_run_refuses_non_admin(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch, is_admin=False)
    r = c.post("/api/bots/harvester/run", json=GOOD_BODY)
    assert r.status_code == 403


def test_run_rejects_pii_field_name(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    body = json.loads(json.dumps(GOOD_BODY))
    body["recipe"]["fields"] = {"email": {"selector": {"tag": "a"}, "extract": "attr:title"}}
    r = c.post("/api/bots/harvester/run", json=body)
    assert r.status_code == 400


def test_run_launches_and_returns_feed_key(tmp_path, monkeypatch):
    c, launched = make_client(tmp_path, monkeypatch)
    r = c.post("/api/bots/harvester/run", json=GOOD_BODY)
    assert r.status_code == 200
    data = r.json()
    assert data["job_id"]
    assert data["feed_key"]
    assert "run_dir" in launched  # subprocess launch was invoked
    # config.json frozen on disk
    cfg_path = tmp_path / data["job_id"] / "config.json"
    assert cfg_path.is_file()


def test_run_config_json_is_chmod_600(tmp_path, monkeypatch):
    # config.json porte des secrets (feed_key, creds proxy) -> permissions 600
    import os
    import stat
    c, _ = make_client(tmp_path, monkeypatch)
    job_id = c.post("/api/bots/harvester/run", json=GOOD_BODY).json()["job_id"]
    mode = stat.S_IMODE(os.stat(str(tmp_path / job_id / "config.json")).st_mode)
    assert mode == 0o600


def test_status_and_active(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    job_id = c.post("/api/bots/harvester/run", json=GOOD_BODY).json()["job_id"]
    s = c.get("/api/bots/harvester/status/{0}".format(job_id))
    assert s.status_code == 200
    assert s.json()["status"] == "running"
    a = c.get("/api/bots/harvester/active")
    assert a.status_code == 200
    assert a.json()["job_id"] == job_id


def test_data_requires_feed_key(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    resp = c.post("/api/bots/harvester/run", json=GOOD_BODY).json()
    job_id, feed_key = resp["job_id"], resp["feed_key"]
    # seed the store on disk (the subprocess would normally do this)
    from backend.bots.harvester.store import Store
    store = Store(str(tmp_path / job_id / "store.json"))
    store.add_record({"title": "A"})
    store.save()

    # wrong / missing key -> 401
    assert c.get("/api/bots/harvester/data/{0}".format(job_id)).status_code == 401
    assert c.get("/api/bots/harvester/data/{0}".format(job_id),
                 headers={"X-Feed-Key": "wrong"}).status_code == 401

    # right key -> records
    ok = c.get("/api/bots/harvester/data/{0}".format(job_id),
               headers={"X-Feed-Key": feed_key})
    assert ok.status_code == 200
    assert ok.json()["records"] == [{"title": "A"}]

    # csv format
    csv_resp = c.get("/api/bots/harvester/data/{0}?format=csv".format(job_id),
                     headers={"X-Feed-Key": feed_key})
    assert csv_resp.status_code == 200
    assert "title" in csv_resp.text


def test_data_unknown_job_404(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    assert c.get("/api/bots/harvester/data/nope",
                 headers={"X-Feed-Key": "x"}).status_code == 404


def test_data_read_touches_mtime_for_retention(tmp_path, monkeypatch):
    # Consommer /data doit rafraîchir le mtime de store.json -> un feed encore
    # tiré n'est jamais auto-purgé (fix revue : perte de données silencieuse).
    import os
    import time
    c, _ = make_client(tmp_path, monkeypatch)
    resp = c.post("/api/bots/harvester/run", json=GOOD_BODY).json()
    job_id, feed_key = resp["job_id"], resp["feed_key"]
    from backend.bots.harvester.store import Store
    sp = tmp_path / job_id / "store.json"
    store = Store(str(sp))
    store.add_record({"title": "A"})
    store.save()
    old = time.time() - 30 * 86400
    os.utime(str(sp), (old, old))
    ok = c.get("/api/bots/harvester/data/{0}".format(job_id),
               headers={"X-Feed-Key": feed_key})
    assert ok.status_code == 200
    assert os.path.getmtime(str(sp)) > old + 86400   # mtime poussé à ~maintenant


def test_run_rejects_non_http_scheme(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    body = json.loads(json.dumps(GOOD_BODY))
    body["url"] = "file:///etc/passwd"
    r = c.post("/api/bots/harvester/run", json=body)
    assert r.status_code == 400


def test_data_csv_neutralizes_formula_injection(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    resp = c.post("/api/bots/harvester/run", json=GOOD_BODY).json()
    job_id, feed_key = resp["job_id"], resp["feed_key"]
    from backend.bots.harvester.store import Store
    store = Store(str(tmp_path / job_id / "store.json"))
    store.add_record({"title": "=1+2"})
    store.save()
    csv_resp = c.get("/api/bots/harvester/data/{0}?format=csv".format(job_id),
                     headers={"X-Feed-Key": feed_key})
    assert csv_resp.status_code == 200
    assert "'=1+2" in csv_resp.text  # leading '=' neutralised with apostrophe


def test_setup_refuses_non_admin(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch, is_admin=False)
    r = c.post("/api/bots/harvester/setup",
               json={"url": "https://books.toscrape.com/", "instructions": "titles"})
    assert r.status_code == 403


def test_setup_returns_preview(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    preview = {
        "url": "https://books.toscrape.com/",
        "difficulty": "facile",
        "recipe": {"item_selector": {"tag": "article", "class": "product_pod"},
                   "fields": {"title": {"selector": [{"tag": "h3"}, {"tag": "a"}],
                                        "extract": "attr:title"}}},
        "plan": {"mode": "pagination", "next_selector": {"tag": "li", "class": "next"}},
        "pacing": {"min_interval_s": 1.5, "jitter": [0.5, 2.0]},
        "sample": [{"title": "Book One"}],
    }
    monkeypatch.setattr(hr, "_run_setup", lambda url, instructions: preview)
    r = c.post("/api/bots/harvester/setup",
               json={"url": "https://books.toscrape.com/", "instructions": "titles"})
    assert r.status_code == 200
    body = r.json()
    assert body["difficulty"] == "facile"
    assert body["sample"] == [{"title": "Book One"}]
    assert body["recipe"]["item_selector"]["class"] == "product_pod"


def test_setup_rejects_generated_pii_field(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)
    preview = {
        "url": "u", "difficulty": "facile",
        "recipe": {"item_selector": {"tag": "article"},
                   "fields": {"email": {"extract": "text"}}},
        "plan": {}, "pacing": {}, "sample": [],
    }
    monkeypatch.setattr(hr, "_run_setup", lambda url, instructions: preview)
    r = c.post("/api/bots/harvester/setup", json={"url": "https://x.test/", "instructions": "x"})
    assert r.status_code == 400


def test_setup_surfaces_llm_failure_as_502(tmp_path, monkeypatch):
    c, _ = make_client(tmp_path, monkeypatch)

    def boom(url, instructions):
        raise RuntimeError("claude cli rc=2")

    monkeypatch.setattr(hr, "_run_setup", boom)
    r = c.post("/api/bots/harvester/setup", json={"url": "https://x.test/", "instructions": "x"})
    assert r.status_code == 502
