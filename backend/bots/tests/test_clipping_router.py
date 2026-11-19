"""Tests du router Clipping (listing + tickets de téléchargement à usage unique)."""
import io
import json
import os
import zipfile

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.auth.utils import get_current_user
from backend.bots import clipping_router as clip


class _U:
    def __init__(self, role, is_admin=False):
        self.role = role
        self.is_admin = is_admin
        self.username = "tester"


def _client(role="developer", is_admin=False):
    app = FastAPI()
    app.include_router(clip.router)
    app.dependency_overrides[get_current_user] = lambda: _U(role, is_admin)
    return TestClient(app)


def _write_live(lives, date, dossier, extraits, statut="termine", streamer="Bob", wav=True):
    live = lives / date / dossier
    (live / "extraits").mkdir(parents=True)
    (live / "meta.json").write_text(json.dumps({
        "streamer": streamer, "plateforme": "twitch", "langue": "fr",
        "titre": "Titre <b>", "statut": statut}))
    entries = []
    for i, (tranche, num, rang) in enumerate(extraits):
        rel = "extraits/tranche_%02d/extrait_%02d.mp4" % (tranche, num)
        f = live / rel
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_bytes(b"MP4" + bytes([i]) * (10 + i))
        audio = rel[:-4] + ".wav"
        if wav:
            (live / audio).write_bytes(b"WAV")
        entries.append({"fichier": rel, "audio": audio, "rang_global": rang,
                        "rang_tranche": 1, "tranche": tranche, "score": 2.5,
                        "duree_s": 90})
    (live / "extraits" / "index.json").write_text(json.dumps({"extraits": entries}))
    return live


@pytest.fixture(autouse=True)
def root(tmp_path, monkeypatch):
    r = tmp_path / "donnees"
    monkeypatch.setenv("CLIPPING_DATA_DIR", str(r))
    monkeypatch.setenv("CLIPPING_KEY_FILE", str(tmp_path / "cle" / "clipping_cle.json"))
    monkeypatch.setattr(clip, "_tickets", {})
    lives = r / "lives"
    _write_live(lives, "2026-11-16", "bob_2130", [(0, 3, 2), (0, 1, 1)])
    _write_live(lives, "2026-11-16", "alice_0900", [(1, 2, 1)], statut="en_cours", streamer="Alice")
    _write_live(lives, "2026-11-15", "carl_1800", [(0, 0, 1)], streamer="Carl")
    # Live sans extraits : omis
    (lives / "2026-11-15" / "vide_1000").mkdir(parents=True)
    # Un fichier hors arborescence (cible de traversée)
    (tmp_path / "secret.mp4").write_bytes(b"SECRET")
    return r


def _ticket(c, type_, cible):
    return c.post("/api/clipping/ticket", json={"type": type_, "cible": cible})


# ------------------------------------------------------------------ listing

def test_listing_structure_and_order():
    r = _client().get("/api/clipping/extraits?jours=3")
    assert r.status_code == 200
    jours = r.json()["jours"]
    assert [j["date"] for j in jours] == ["2026-11-16", "2026-11-15"]
    day = jours[0]
    ids = [l["id"] for l in day["lives"]]
    assert ids == ["2026-11-16/alice_0900", "2026-11-16/bob_2130"]
    alice, bob = day["lives"]
    assert alice["en_cours"] is True and bob["en_cours"] is False
    assert bob["streamer"] == "Bob" and bob["plateforme"] == "twitch"
    assert [e["rang_global"] for e in bob["extraits"]] == [1, 2]
    assert bob["extraits"][0]["chemin"] == "2026-11-16/bob_2130/extraits/tranche_00/extrait_01.mp4"
    total = sum(e["taille_octets"] for l in day["lives"] for e in l["extraits"])
    assert day["total_octets"] == total > 0
    # Aucun chemin absolu dans la réponse
    assert str(os.sep + "tmp") not in r.text and "donnees" not in r.text


def test_listing_jours_limit_and_bounds():
    c = _client()
    assert [j["date"] for j in c.get("/api/clipping/extraits?jours=1").json()["jours"]] == ["2026-11-16"]
    assert c.get("/api/clipping/extraits?jours=0").status_code == 422
    assert c.get("/api/clipping/extraits?jours=15").status_code == 422


def test_listing_missing_root(monkeypatch, tmp_path):
    monkeypatch.setenv("CLIPPING_DATA_DIR", str(tmp_path / "nope"))
    r = _client().get("/api/clipping/extraits")
    assert r.status_code == 200 and r.json() == {"jours": []}


def test_admin_allowed():
    assert _client(role="player", is_admin=True).get("/api/clipping/extraits").status_code == 200


@pytest.mark.parametrize("role", ["money", "player", "spectator", "moderator"])
def test_permission_denied(role):
    c = _client(role=role)
    assert c.get("/api/clipping/extraits").status_code == 403
    assert _ticket(c, "jour", "2026-11-16").status_code == 403


# ------------------------------------------------------------------ tickets

def test_ticket_extrait_single_use():
    c = _client()
    r = _ticket(c, "extrait", "2026-11-16/bob_2130/extraits/tranche_00/extrait_03.mp4")
    assert r.status_code == 200
    url = r.json()["url"]
    assert url.startswith("/api/clipping/telecharger/")
    # Téléchargement SANS header d'auth : application sans override
    app = FastAPI()
    app.include_router(clip.router)
    anon = TestClient(app)
    d = anon.get(url)
    assert d.status_code == 200
    assert d.headers["content-type"] == "video/mp4"
    assert 'filename="Bob_2130_t00_02.mp4"' in d.headers["content-disposition"]
    assert d.content.startswith(b"MP4")
    assert anon.get(url).status_code == 404  # 2e usage


def test_ticket_expired():
    now = [1000.0]
    clip_now = clip._now
    try:
        clip._now = lambda: now[0]
        c = _client()
        url = _ticket(c, "live", "2026-11-16/bob_2130").json()["url"]
        now[0] += clip.TICKET_TTL_S + 1
        assert c.get(url).status_code == 404
    finally:
        clip._now = clip_now


def test_unknown_ticket():
    assert _client().get("/api/clipping/telecharger/nimportequoi").status_code == 404


def _zip_check(resp, root):
    """Ouvre le zip reçu, vérifie ZIP_STORED et le contenu octet pour octet ;
    renvoie les noms triés."""
    assert resp.headers["content-type"] == "application/zip"
    assert "attachment" in resp.headers["content-disposition"]
    lives = root / "lives"
    with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
        assert zf.testzip() is None
        names = []
        for info in zf.infolist():
            assert info.compress_type == zipfile.ZIP_STORED
            assert info.flag_bits & 0x08  # data descriptor : flux sans seek
            dossier, rel = info.filename.split("/", 1)
            src = None
            for live in lives.glob("*/" + dossier):
                src = live / rel
            assert src is not None and zf.read(info) == src.read_bytes()
            names.append(info.filename)
        return sorted(names)


def test_zip_live(root):
    c = _client()
    url = _ticket(c, "live", "2026-11-16/bob_2130").json()["url"]
    r = c.get(url)
    assert r.status_code == 200
    assert 'filename="2026-11-16_bob_2130.zip"' in r.headers["content-disposition"]
    assert _zip_check(r, root) == [
        "bob_2130/extraits/index.json",
        "bob_2130/extraits/tranche_00/extrait_01.mp4",
        "bob_2130/extraits/tranche_00/extrait_03.mp4"]
    # Rien n'est écrit sur disque
    assert not (root / ".telechargements").exists()


def test_zip_jour(root):
    c = _client()
    r = c.get(_ticket(c, "jour", "2026-11-16").json()["url"])
    assert r.status_code == 200
    assert _zip_check(r, root) == [
        "alice_0900/extraits/index.json",
        "alice_0900/extraits/tranche_01/extrait_02.mp4",
        "bob_2130/extraits/index.json",
        "bob_2130/extraits/tranche_00/extrait_01.mp4",
        "bob_2130/extraits/tranche_00/extrait_03.mp4"]


def test_zip_live_readable_by_lot(root, tmp_path):
    """Rejoue la logique de `clipper lot` sur le zip décompressé."""
    c = _client()
    r = c.get(_ticket(c, "live", "2026-11-16/bob_2130").json()["url"])
    out = tmp_path / "decompresse"
    with zipfile.ZipFile(io.BytesIO(r.content)) as zf:
        zf.extractall(out)
    indexes = list(out.rglob("extraits/index.json"))
    assert len(indexes) == 1
    racine_live = indexes[0].parent.parent
    entries = json.loads(indexes[0].read_text())["extraits"]
    servis = [e for e in entries if (racine_live / e["fichier"]).is_file()]
    assert len(servis) == 2 == len(entries)
    for e in servis:
        assert (racine_live / e["fichier"]).read_bytes()[:3] == b"MP4"


def test_zip_stream_chunks_big_file(root):
    big = root / "lives" / "2026-11-15" / "carl_1800" / "extraits" / "tranche_00" / "extrait_00.mp4"
    payload = os.urandom(2 * 1024 * 1024 + 12345)
    big.write_bytes(payload)
    target = clip._resolve_target("live", "2026-11-15/carl_1800")
    blocks = list(clip._zip_stream(target["members"]))
    assert len(blocks) >= 3  # données découpées en blocs ~1 Mo + répertoire central
    assert max(len(b) for b in blocks) <= 2 * clip.CHUNK
    with zipfile.ZipFile(io.BytesIO(b"".join(blocks))) as zf:
        assert zf.read("carl_1800/extraits/tranche_00/extrait_00.mp4") == payload
    # Et de bout en bout par HTTP
    c = _client()
    r = c.get(_ticket(c, "live", "2026-11-15/carl_1800").json()["url"])
    assert _zip_check(r, root) == [
        "carl_1800/extraits/index.json",
        "carl_1800/extraits/tranche_00/extrait_00.mp4"]


def test_zip_stream_skips_vanished_file(root, caplog):
    target = clip._resolve_target("jour", "2026-11-16")
    (root / "lives" / "2026-11-16" / "bob_2130" / "extraits" / "tranche_00" / "extrait_01.mp4").unlink()
    data = b"".join(clip._zip_stream(target["members"]))
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        assert sorted(zf.namelist()) == [
            "alice_0900/extraits/index.json",
            "alice_0900/extraits/tranche_01/extrait_02.mp4",
            "bob_2130/extraits/index.json",
            "bob_2130/extraits/tranche_00/extrait_03.mp4"]
    assert any("disparu" in rec.getMessage() for rec in caplog.records)


def test_zip_duplicate_names(root):
    f = root / "lives" / "2026-11-15" / "carl_1800" / "extraits" / "tranche_00" / "extrait_00.mp4"
    data = b"".join(clip._zip_stream([(f, "a/x.mp4"), (f, "a/x.mp4")]))
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        assert zf.namelist() == ["a/x.mp4", "a/x_2.mp4"]


# ------------------------------------------------------------------ traversées

@pytest.mark.parametrize("type_,cible,codes", [
    ("extrait", "2026-11-16/bob_2130/../../../secret.mp4", (400,)),
    ("extrait", "/etc/passwd", (400,)),
    ("extrait", "2026-11-16/bob_2130/extraits/tranche_00/extrait_03.wav", (400,)),
    ("extrait", "2026-11-16/bob_2130/meta.json", (400,)),
    ("extrait", "2026-11-16/bob_2130/extraits/tranche_00/extrait_99.mp4", (404,)),
    ("live", "2026-11-16/..", (400,)),
    ("live", "../2026-11-16", (400,)),
    ("live", "2026-11-16/nexistepas", (404,)),
    ("live", "2026-11-15/vide_1000", (404,)),
    ("jour", "..", (400,)),
    ("jour", "2026-11-16/bob_2130", (400,)),
    ("jour", "2020-01-01", (404,)),
    ("autre", "2026-11-16", (400,)),
])
def test_traversal_refused(type_, cible, codes, tmp_path):
    r = _ticket(_client(), type_, cible)
    assert r.status_code in codes
    assert str(tmp_path) not in r.text


def test_mp4_not_in_index_refused(root):
    extra = root / "lives" / "2026-11-16" / "bob_2130" / "extraits" / "tranche_00" / "extrait_50.mp4"
    extra.write_bytes(b"MP4")
    r = _ticket(_client(), "extrait", "2026-11-16/bob_2130/extraits/tranche_00/extrait_50.mp4")
    assert r.status_code == 404


def test_symlink_refused(root, tmp_path):
    live = root / "lives" / "2026-11-16" / "bob_2130"
    target = live / "extraits" / "tranche_00" / "extrait_03.mp4"
    target.unlink()
    target.symlink_to(tmp_path / "secret.mp4")
    r = _ticket(_client(), "extrait", "2026-11-16/bob_2130/extraits/tranche_00/extrait_03.mp4")
    assert r.status_code == 404
    # Et un live entier symlinké n'est pas listé
    (root / "lives" / "2026-11-16" / "evil_0000").symlink_to(live)
    ids = [l["id"] for j in _client().get("/api/clipping/extraits").json()["jours"] for l in j["lives"]]
    assert "2026-11-16/evil_0000" not in ids


def test_index_entry_escaping_live_ignored(root):
    live = root / "lives" / "2026-11-15" / "carl_1800"
    idx = live / "extraits" / "index.json"
    data = json.loads(idx.read_text())
    data["extraits"].append({"fichier": "../../../../secret.mp4", "rang_global": 9, "tranche": 0})
    data["extraits"].append({"fichier": "/abs/x.mp4", "rang_global": 10, "tranche": 0})
    idx.write_text(json.dumps(data))
    jours = _client().get("/api/clipping/extraits?jours=5").json()["jours"]
    carl = [l for j in jours for l in j["lives"] if l["id"] == "2026-11-15/carl_1800"][0]
    assert len(carl["extraits"]) == 1


# ------------------------------------------------------------------ montages

def _write_montages(r):
    m = r / "montages"
    d1 = m / "2026-11-19"
    (d1 / "bob").mkdir(parents=True)
    (d1 / "alice").mkdir(parents=True)
    (d1 / "lot_2026-11-19.md").write_text("# Lot <b>\nrecap", encoding="utf-8")
    (d1 / "bob" / "2026-11-19_bob_lot-02.mp4").write_bytes(b"BOB2")
    (d1 / "bob" / "2026-11-19_bob_lot-02.txt").write_text("fiche bob", encoding="utf-8")
    (d1 / "bob" / "transcription.srt").write_text("srt")
    (d1 / "alice" / "2026-11-19_alice_lot-01.mp4").write_bytes(b"ALICE1")
    d0 = m / "2026-11-18"
    (d0 / "x").mkdir(parents=True)
    (d0 / "x" / "2026-11-18_x_lot-01.mp4").write_bytes(b"X")
    return m


def test_montages_listing(root):
    _write_montages(root)
    r = _client().get("/api/clipping/montages?jours=3")
    assert r.status_code == 200
    jours = r.json()["jours"]
    assert [j["date"] for j in jours] == ["2026-11-19", "2026-11-18"]
    d = jours[0]
    assert d["recap"] == "# Lot <b>\nrecap"
    assert [c["nom"] for c in d["clips"]] == ["2026-11-19_alice_lot-01.mp4", "2026-11-19_bob_lot-02.mp4"]
    assert d["clips"][0]["chemin"] == "alice/2026-11-19_alice_lot-01.mp4"
    assert d["clips"][0]["fiche"] is None
    assert d["clips"][1]["fiche"] == "fiche bob"
    assert d["clips"][1]["taille"] == 4
    assert jours[1]["recap"] is None
    assert str(root) not in r.text
    assert len(_client().get("/api/clipping/montages?jours=1").json()["jours"]) == 1


def test_montages_truncation(root):
    m = _write_montages(root)
    (m / "2026-11-19" / "lot_2026-11-19.md").write_text("a" * 30000)
    (m / "2026-11-19" / "bob" / "2026-11-19_bob_lot-02.txt").write_text("b" * 9000)
    d = _client().get("/api/clipping/montages").json()["jours"][0]
    assert len(d["recap"]) == 20000
    assert len(d["clips"][1]["fiche"]) == 4000


def test_montages_root_absent(root):
    assert _client().get("/api/clipping/montages").json() == {"jours": []}


def test_montage_ticket_single_use(root):
    _write_montages(root)
    c = _client()
    cible = "2026-11-19/bob/2026-11-19_bob_lot-02.mp4"
    r = _ticket(c, "montage", cible)
    assert r.status_code == 200
    url = r.json()["url"]
    d = c.get(url)
    assert d.status_code == 200
    assert d.content == b"BOB2"
    assert c.get(url).status_code == 404


def test_montages_jour_zip(root):
    _write_montages(root)
    c = _client()
    url = _ticket(c, "montages_jour", "2026-11-19").json()["url"]
    d = c.get(url)
    assert d.status_code == 200
    zf = zipfile.ZipFile(io.BytesIO(d.content))
    assert sorted(zf.namelist()) == sorted([
        "lot_2026-11-19.md",
        "alice/2026-11-19_alice_lot-01.mp4",
        "bob/2026-11-19_bob_lot-02.mp4",
        "bob/2026-11-19_bob_lot-02.txt",
    ])
    assert zf.read("bob/2026-11-19_bob_lot-02.mp4") == b"BOB2"


@pytest.mark.parametrize("cible", [
    "2026-11-19/../../secret.mp4",
    "2026-11-19/bob/../../../secret.mp4",
    "../secret.mp4",
    "2026-11-19/bob/transcription.srt",
    "2026-11-19/bob/2026-11-19_bob_lot-02.txt",
    "2026-11-19/2026-11-19_bob_lot-02.mp4",
    "2026-11-19/bob/sub/x.mp4",
])
def test_montage_refused(root, cible):
    _write_montages(root)
    assert _ticket(_client(), "montage", cible).status_code in (400, 404)


def test_montages_jour_bad_date(root):
    _write_montages(root)
    assert _ticket(_client(), "montages_jour", "../x").status_code == 400
    assert _ticket(_client(), "montages_jour", "2026-01-01").status_code == 404


def test_montage_symlink_refused(root, tmp_path):
    m = _write_montages(root)
    (m / "2026-11-19" / "bob" / "evil.mp4").symlink_to(tmp_path / "secret.mp4")
    assert _ticket(_client(), "montage", "2026-11-19/bob/evil.mp4").status_code == 404
    names = [c["nom"] for c in _client().get("/api/clipping/montages").json()["jours"][0]["clips"]]
    assert "evil.mp4" not in names
    # sous-dossier lien symbolique
    (m / "2026-11-19" / "lnk").symlink_to(tmp_path)
    assert _ticket(_client(), "montage", "2026-11-19/lnk/secret.mp4").status_code == 404
    zf = zipfile.ZipFile(io.BytesIO(_client().get(
        _ticket(_client(), "montages_jour", "2026-11-19").json()["url"]).content))
    assert not any("secret" in n or "evil" in n for n in zf.namelist())


# ------------------------------------------------------------------ clé pour scripts

def _admin():
    return _client(role="admin", is_admin=True)


def _new_key():
    return _admin().post("/api/clipping/cle").json()["cle"]


def _kh(cle):
    return {"X-Clip-Key": cle}


def test_key_admin_only():
    c = _client(role="developer", is_admin=False)
    assert c.post("/api/clipping/cle").status_code == 403
    assert c.get("/api/clipping/cle").status_code == 403
    assert c.delete("/api/clipping/cle").status_code == 403
    r = _admin().post("/api/clipping/cle")
    assert r.status_code == 200 and r.json()["cle"].startswith("clp_")


def test_key_never_in_get_and_file_has_only_hash():
    a = _admin()
    cle = a.post("/api/clipping/cle").json()["cle"]
    st = a.get("/api/clipping/cle")
    assert st.json()["active"] is True and st.json()["par"] == "tester"
    assert cle not in st.text
    raw = open(os.environ["CLIPPING_KEY_FILE"]).read()
    assert cle not in raw
    data = json.loads(raw)
    assert data["sha256"] == clip._hash_key(cle) and set(data) == {"sha256", "cree", "par"}


def test_key_file_mode_600():
    _new_key()
    assert (os.stat(os.environ["CLIPPING_KEY_FILE"]).st_mode & 0o777) == 0o600


def test_key_status_inactive():
    assert _admin().get("/api/clipping/cle").json()["active"] is False


def test_key_montages_auth(root):
    _write_montages(root)
    c = _client(role="spectator")  # aucune session utile : seule la clé compte
    assert c.get("/api/clipping/cle/montages").status_code == 401  # aucune clé configurée
    cle = _new_key()
    assert c.get("/api/clipping/cle/montages").status_code == 401
    assert c.get("/api/clipping/cle/montages", headers=_kh("clp_mauvaise")).status_code == 401
    r = c.get("/api/clipping/cle/montages?jours=3", headers=_kh(cle))
    assert r.status_code == 200
    assert r.json() == _client().get("/api/clipping/montages?jours=3").json()


def test_key_fichier(root, tmp_path):
    m = _write_montages(root)
    cle = _new_key()
    c = _client(role="spectator")
    r = c.get("/api/clipping/cle/fichier", params={"chemin": "2026-11-19/bob/2026-11-19_bob_lot-02.mp4"},
              headers=_kh(cle))
    assert r.status_code == 200 and r.content == b"BOB2"
    assert r.headers["content-length"] == "4"
    assert c.get("/api/clipping/cle/fichier",
                 params={"chemin": "2026-11-19/bob/2026-11-19_bob_lot-02.mp4"}).status_code == 401
    for bad in ("2026-11-19/bob/../../../secret.mp4", "../secret.mp4", "2026-11-19/bob/transcription.srt",
                "2026-11-19/bob/2026-11-19_bob_lot-02.txt", "2026-11-19/bob/absent.mp4"):
        assert c.get("/api/clipping/cle/fichier", params={"chemin": bad},
                     headers=_kh(cle)).status_code in (400, 404)
    (m / "2026-11-19" / "bob" / "evil.mp4").symlink_to(tmp_path / "secret.mp4")
    assert c.get("/api/clipping/cle/fichier", params={"chemin": "2026-11-19/bob/evil.mp4"},
                 headers=_kh(cle)).status_code == 404


def test_key_regenerate_invalidates_old(root):
    _write_montages(root)
    old = _new_key()
    new = _new_key()
    c = _client(role="spectator")
    assert c.get("/api/clipping/cle/montages", headers=_kh(old)).status_code == 401
    assert c.get("/api/clipping/cle/montages", headers=_kh(new)).status_code == 200


def test_key_revoke(root):
    cle = _new_key()
    assert _admin().delete("/api/clipping/cle").status_code == 200
    assert not os.path.exists(os.environ["CLIPPING_KEY_FILE"])
    assert _client(role="spectator").get("/api/clipping/cle/montages", headers=_kh(cle)).status_code == 401
    assert _admin().get("/api/clipping/cle").json()["active"] is False
