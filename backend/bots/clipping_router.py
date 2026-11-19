"""
Clipping — consultation et téléchargement des extraits de lives présélectionnés.

L'enregistreur de lives (projet séparé) écrit sous :
    <RACINE>/lives/<YYYY-MM-DD>/<streamer>_<HHMM>/
        meta.json
        extraits/index.json   {"extraits": [{"fichier": "extraits/tranche_00/extrait_03.mp4", ...}]}
RACINE = $CLIPPING_DATA_DIR (défaut ~/clipping/donnees), relue à chaque appel.

Téléchargement : un <a href> ne peut pas porter le header Authorization, et
charger plusieurs Go en blob JS est exclu → TICKET à usage unique :
    POST /api/clipping/ticket            (auth + permission « clipping »)
    GET  /api/clipping/telecharger/{t}   (sans header : le ticket fait foi)
Le ticket vit 120 s en mémoire et ne sert qu'une fois.

Sécurité : toute cible venant du client est validée par regex stricte, chaque
composant du chemin est refusé s'il est un lien symbolique, le chemin résolu
doit rester sous <RACINE>/lives, et un extrait doit être un .mp4 LISTÉ dans
l'index.json de son live. Aucune réponse ne contient de chemin absolu.

Zips « live » et « jour » : arborescence de l'enregistreur reproduite
(<dossier>/extraits/tranche_NN/extrait_MM.mp4) avec l'extraits/index.json de
chaque live, pour que `python -m clipper lot <dossier>` les lise tels quels.
"""
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import threading
import time
import zipfile
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

from backend.auth.models import User
from backend.auth.permissions import require_permission
from backend.auth.utils import get_current_user

logger = logging.getLogger("omenserver")

router = APIRouter(prefix="/api/clipping", tags=["clipping"])

TICKET_TTL_S = 120
TICKETS_MAX = 500
JOURS_MAX = 14

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}\Z")
_NAME_RE = re.compile(r"^[A-Za-z0-9_.-]+\Z")
_HHMM_RE = re.compile(r"^\d{4}\Z")

# Horloge injectable (tests : expiration des tickets).
_now = time.time

_tickets: Dict[str, dict] = {}
_tickets_lock = threading.Lock()


# ------------------------------------------------------------------ chemins

def _root() -> Path:
    return Path(os.environ.get("CLIPPING_DATA_DIR", "~/clipping/donnees")).expanduser()


def _lives_dir() -> Path:
    return _root() / "lives"


def _montages_dir() -> Path:
    return _root() / "montages"


def _valid_name(s: str) -> bool:
    return bool(s) and bool(_NAME_RE.match(s)) and s not in (".", "..") and ".." not in s


def _confined(base: Path, parts: List[str]) -> Optional[Path]:
    """Chemin base/parts… si AUCUN composant n'est un lien symbolique et que le
    résultat résolu reste sous base. None sinon (ou si base est absente)."""
    if not base.is_dir() or base.is_symlink():
        return None
    cur = base
    for p in parts:
        if not _valid_name(p):
            return None
        cur = cur / p
        if cur.is_symlink():
            return None
    try:
        resolved = cur.resolve()
        resolved.relative_to(base.resolve())
    except (OSError, ValueError):
        return None
    return resolved


def _read_json(path: Path) -> Optional[dict]:
    try:
        if path.is_symlink() or not path.is_file():
            return None
        with path.open("r", encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def _rel_parts(fichier) -> Optional[List[str]]:
    """Découpe un `fichier` d'index.json (relatif au live) en composants sûrs."""
    if not isinstance(fichier, str) or not fichier or fichier.startswith("/") or "\\" in fichier:
        return None
    parts = fichier.split("/")
    if not all(_valid_name(p) for p in parts):
        return None
    if not parts[-1].lower().endswith(".mp4"):
        return None
    return parts


def _int(v, default=0) -> int:
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


# ------------------------------------------------------------------ lecture d'un live

def _live_extraits(live_dir: Path) -> List[Tuple[dict, List[str], Path]]:
    """Extraits .mp4 valides d'un live : (entrée index, composants relatifs, chemin)."""
    index = _read_json(live_dir / "extraits" / "index.json")
    if not index or not isinstance(index.get("extraits"), list):
        return []
    out = []
    seen = set()
    for e in index["extraits"]:
        if not isinstance(e, dict):
            continue
        parts = _rel_parts(e.get("fichier"))
        if not parts:
            continue
        key = "/".join(parts)
        if key in seen:
            continue
        path = _confined(live_dir, parts)
        if path is None or not path.is_file():
            continue
        seen.add(key)
        out.append((e, parts, path))
    out.sort(key=lambda t: (_int(t[0].get("rang_global"), 10 ** 9), "/".join(t[1])))
    return out


def _live_info(date: str, dossier: str) -> Optional[dict]:
    live_dir = _confined(_lives_dir(), [date, dossier])
    if live_dir is None or not live_dir.is_dir():
        return None
    meta = _read_json(live_dir / "meta.json") or {}
    return {"dir": live_dir, "meta": meta, "extraits": _live_extraits(live_dir)}


def _streamer_of(meta: dict, dossier: str) -> str:
    s = meta.get("streamer") if isinstance(meta.get("streamer"), str) else ""
    if not s:
        s = dossier.rsplit("_", 1)[0] if "_" in dossier else dossier
    return s


def _hhmm_of(dossier: str) -> str:
    tail = dossier.rsplit("_", 1)[-1] if "_" in dossier else ""
    return tail if _HHMM_RE.match(tail) else "0000"


def _safe_fname(s: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_.-]+", "_", s).strip("._")
    return cleaned or "live"


def _zip_member(dossier: str, entry: dict, parts: List[str]) -> str:
    return "%s/%s" % (dossier, "/".join(parts))


def _index_member(live_dir: Path, dossier: str) -> List[Tuple[Path, str]]:
    """Membre zip de l'index.json du live (servi tel quel), s'il est sûr."""
    path = _confined(live_dir, ["extraits", "index.json"])
    if path is None or not path.is_file():
        return []
    return [(path, "%s/extraits/index.json" % dossier)]


# ------------------------------------------------------------------ listing

@router.get("/extraits")
def list_extraits(jours: int = Query(3, ge=1, le=JOURS_MAX),
                  user: User = Depends(require_permission("clipping"))):
    lives_root = _lives_dir()
    if not lives_root.is_dir() or lives_root.is_symlink():
        return {"jours": []}
    try:
        dates = sorted((d.name for d in lives_root.iterdir()
                        if _DATE_RE.match(d.name) and d.is_dir() and not d.is_symlink()),
                       reverse=True)
    except OSError:
        return {"jours": []}

    result = []
    for date in dates:
        if len(result) >= jours:
            break
        date_dir = lives_root / date
        try:
            dossiers = sorted(p.name for p in date_dir.iterdir()
                              if _valid_name(p.name) and not p.name.startswith(".")
                              and p.is_dir() and not p.is_symlink())
        except OSError:
            continue
        lives = []
        total = 0
        for dossier in dossiers:
            info = _live_info(date, dossier)
            if not info or not info["extraits"]:
                continue
            meta = info["meta"]
            extraits = []
            for entry, parts, path in info["extraits"]:
                try:
                    size = path.stat().st_size
                except OSError:
                    continue
                total += size
                extraits.append({
                    "chemin": "/".join([date, dossier] + parts),
                    "tranche": _int(entry.get("tranche")),
                    "rang_global": _int(entry.get("rang_global")),
                    "score": entry.get("score") if isinstance(entry.get("score"), (int, float)) else None,
                    "duree_s": entry.get("duree_s") if isinstance(entry.get("duree_s"), (int, float)) else None,
                    "taille_octets": size,
                })
            if not extraits:
                continue

            def _s(k):
                v = meta.get(k)
                return v if isinstance(v, str) else ""

            lives.append({
                "id": "%s/%s" % (date, dossier),
                "streamer": _streamer_of(meta, dossier),
                "plateforme": _s("plateforme"),
                "langue": _s("langue"),
                "titre": _s("titre"),
                "en_cours": meta.get("statut") == "en_cours",
                "extraits": extraits,
            })
        if lives:
            result.append({"date": date, "total_octets": total, "lives": lives})
    return {"jours": result}


# ------------------------------------------------------------------ montages (clips verticaux finis)
#
#   <RACINE>/montages/<YYYY-MM-DD>/lot_*.md
#   <RACINE>/montages/<YYYY-MM-DD>/<sous-dossier>/<nom>.mp4 (+ <nom>.txt = fiche)
# Les transcription.srt et tout le reste sont ignorés.

RECAP_MAX = 20000
FICHE_MAX = 4000


def _read_text(base: Path, parts: List[str], limit: int) -> Optional[str]:
    path = _confined(base, parts)
    if path is None or not path.is_file():
        return None
    try:
        with path.open("r", encoding="utf-8", errors="replace") as fh:
            return fh.read(limit)
    except OSError:
        return None


def _list_dirs(base: Path) -> List[str]:
    try:
        return sorted(p.name for p in base.iterdir()
                      if _valid_name(p.name) and not p.name.startswith(".")
                      and p.is_dir() and not p.is_symlink())
    except OSError:
        return []


def _list_mp4(base: Path) -> List[str]:
    try:
        return sorted(p.name for p in base.iterdir()
                      if _valid_name(p.name) and p.name.lower().endswith(".mp4")
                      and p.is_file() and not p.is_symlink())
    except OSError:
        return []


def _recap_name(day_dir: Path) -> Optional[str]:
    try:
        names = sorted(p.name for p in day_dir.iterdir()
                       if _valid_name(p.name) and p.name.startswith("lot_")
                       and p.name.lower().endswith(".md") and p.is_file() and not p.is_symlink())
    except OSError:
        return None
    return names[0] if names else None


def _day_clips(day_dir: Path) -> List[Tuple[str, Path]]:
    """(chemin relatif au jour, chemin résolu) de chaque .mp4, trié par nom."""
    out = []
    for sub in _list_dirs(day_dir):
        sub_dir = _confined(day_dir, [sub])
        if sub_dir is None or not sub_dir.is_dir():
            continue
        for name in _list_mp4(sub_dir):
            path = _confined(day_dir, [sub, name])
            if path is not None and path.is_file():
                out.append(("%s/%s" % (sub, name), path))
    out.sort(key=lambda t: t[0].rsplit("/", 1)[-1])
    return out


@router.get("/montages")
def list_montages(jours: int = Query(3, ge=1, le=JOURS_MAX),
                  user: User = Depends(require_permission("clipping"))):
    return _montages_listing(jours)


def _montages_listing(jours: int) -> dict:
    root = _montages_dir()
    if not root.is_dir() or root.is_symlink():
        return {"jours": []}
    try:
        dates = sorted((d.name for d in root.iterdir()
                        if _DATE_RE.match(d.name) and d.is_dir() and not d.is_symlink()),
                       reverse=True)
    except OSError:
        return {"jours": []}
    result = []
    for date in dates:
        if len(result) >= jours:
            break
        day_dir = _confined(root, [date])
        if day_dir is None:
            continue
        rname = _recap_name(day_dir)
        recap = _read_text(day_dir, [rname], RECAP_MAX) if rname else None
        clips = []
        for rel, path in _day_clips(day_dir):
            try:
                size = path.stat().st_size
            except OSError:
                continue
            sub, name = rel.split("/")
            fiche = _read_text(day_dir, [sub, name[:-4] + ".txt"], FICHE_MAX)
            clips.append({"chemin": rel, "nom": name, "taille": size, "fiche": fiche})
        if clips or recap is not None:
            result.append({"date": date, "recap": recap, "clips": clips})
    return {"jours": result}


# ------------------------------------------------------------------ résolution des cibles

def _resolve_montage(parts: List[str]) -> dict:
    """Validation d'un clip monté <date>/<sous>/<nom>.mp4 (ticket ET clé)."""
    if len(parts) != 3 or not _DATE_RE.match(parts[0]) \
            or not all(_valid_name(p) for p in parts[1:]) \
            or not parts[2].lower().endswith(".mp4"):
        raise HTTPException(400, "Cible invalide")
    path = _confined(_montages_dir(), parts)
    if path is None or not path.is_file():
        raise HTTPException(404, "Introuvable")
    return {"kind": "file", "path": path, "filename": parts[2]}


def _resolve_target(kind: str, cible: str) -> dict:
    """Valide une cible et renvoie ce qu'il faut pour la servir.
    400 = format invalide, 404 = introuvable. Messages génériques (aucun chemin)."""
    if not isinstance(cible, str) or len(cible) > 512:
        raise HTTPException(400, "Cible invalide")
    parts = cible.split("/")

    if kind == "jour":
        if len(parts) != 1 or not _DATE_RE.match(parts[0]):
            raise HTTPException(400, "Cible invalide")
        date = parts[0]
        day_dir = _confined(_lives_dir(), [date])
        if day_dir is None or not day_dir.is_dir():
            raise HTTPException(404, "Introuvable")
        members = []
        try:
            dossiers = sorted(p.name for p in day_dir.iterdir()
                              if _valid_name(p.name) and not p.name.startswith(".")
                              and p.is_dir() and not p.is_symlink())
        except OSError:
            dossiers = []
        for dossier in dossiers:
            info = _live_info(date, dossier)
            if not info:
                continue
            if not info["extraits"]:
                continue
            members.extend(_index_member(info["dir"], dossier))
            for entry, rel, path in info["extraits"]:
                members.append((path, _zip_member(dossier, entry, rel)))
        if not members:
            raise HTTPException(404, "Introuvable")
        return {"kind": "zip", "members": members, "filename": "clips_%s.zip" % date}

    if kind == "live":
        if len(parts) != 2 or not _DATE_RE.match(parts[0]) or not _valid_name(parts[1]):
            raise HTTPException(400, "Cible invalide")
        date, dossier = parts
        info = _live_info(date, dossier)
        if not info or not info["extraits"]:
            raise HTTPException(404, "Introuvable")
        members = _index_member(info["dir"], dossier)
        members += [(path, _zip_member(dossier, entry, rel)) for entry, rel, path in info["extraits"]]
        return {"kind": "zip", "members": members,
                "filename": "%s_%s.zip" % (date, _safe_fname(dossier))}

    if kind == "extrait":
        if len(parts) < 3 or not _DATE_RE.match(parts[0]) or not _valid_name(parts[1]):
            raise HTTPException(400, "Cible invalide")
        rel = parts[2:]
        if not all(_valid_name(p) for p in rel) or not rel[-1].lower().endswith(".mp4"):
            raise HTTPException(400, "Cible invalide")
        date, dossier = parts[0], parts[1]
        info = _live_info(date, dossier)
        if not info:
            raise HTTPException(404, "Introuvable")
        wanted = "/".join(rel)
        for entry, erel, path in info["extraits"]:
            if "/".join(erel) == wanted:
                streamer = _safe_fname(_streamer_of(info["meta"], dossier))
                rang = _int(entry.get("rang_global"))
                fname = "%s_%s_t%02d_%02d.mp4" % (streamer, _hhmm_of(dossier),
                                                   _int(entry.get("tranche")), rang)
                return {"kind": "file", "path": path, "filename": fname}
        raise HTTPException(404, "Introuvable")

    if kind == "montages_jour":
        if len(parts) != 1 or not _DATE_RE.match(parts[0]):
            raise HTTPException(400, "Cible invalide")
        date = parts[0]
        day_dir = _confined(_montages_dir(), [date])
        if day_dir is None or not day_dir.is_dir():
            raise HTTPException(404, "Introuvable")
        members = []
        rname = _recap_name(day_dir)
        if rname:
            rp = _confined(day_dir, [rname])
            if rp is not None and rp.is_file():
                members.append((rp, rname))
        clips = _day_clips(day_dir)
        for rel, path in clips:
            members.append((path, rel))
            sub, name = rel.split("/")
            tp = _confined(day_dir, [sub, name[:-4] + ".txt"])
            if tp is not None and tp.is_file():
                members.append((tp, "%s/%s.txt" % (sub, name[:-4])))
        if not clips:
            raise HTTPException(404, "Introuvable")
        return {"kind": "zip", "members": members, "filename": "montages_%s.zip" % date}

    if kind == "montage":
        return _resolve_montage(parts)

    raise HTTPException(400, "Type invalide")


# ------------------------------------------------------------------ tickets

class TicketRequest(BaseModel):
    type: str
    cible: str


def _purge_tickets(now: float) -> None:
    for k in [k for k, t in _tickets.items() if t["expires"] <= now]:
        _tickets.pop(k, None)


@router.post("/ticket")
def create_ticket(req: TicketRequest, user: User = Depends(require_permission("clipping"))):
    _resolve_target(req.type, req.cible)  # valide MAINTENANT (400/404)
    token = secrets.token_urlsafe(32)
    now = _now()
    with _tickets_lock:
        _purge_tickets(now)
        if len(_tickets) >= TICKETS_MAX:
            raise HTTPException(429, "Trop de téléchargements en attente")
        _tickets[token] = {"type": req.type, "cible": req.cible, "expires": now + TICKET_TTL_S,
                           "user": getattr(user, "username", "")}
    logger.info("[clipping] ticket %s %s par %s", req.type, req.cible, getattr(user, "username", "?"))
    return {"url": "/api/clipping/telecharger/%s" % token}


def _consume_ticket(token: str) -> Optional[dict]:
    now = _now()
    with _tickets_lock:
        t = _tickets.pop(token, None)
        _purge_tickets(now)
    if not t or t["expires"] <= now:
        return None
    return t


# ------------------------------------------------------------------ zip en flux
#
# Le zip n'est JAMAIS écrit sur disque : un jour fait 5 Go+ sur le HDD de
# l'Omen, et Cloudflare coupe une réponse dont le premier octet tarde ~100 s.
# zipfile écrit dans un tampon sans seek() → il passe tout seul en mode « data
# descriptor » (tailles/CRC écrites APRÈS chaque membre) ; on vide le tampon
# par blocs d'~1 Mo. Le générateur est synchrone : starlette l'itère dans un
# threadpool, la boucle n'est pas bloquée.

CHUNK = 1024 * 1024


class _StreamBuffer:
    """Objet type fichier non seekable : accumule ce que zipfile écrit et
    compte les octets (tell) ; le générateur le vide au fil de l'eau."""

    def __init__(self):
        self._buf = bytearray()
        self._pos = 0

    def write(self, data):
        self._buf += data
        self._pos += len(data)
        return len(data)

    def tell(self):
        return self._pos

    def flush(self):
        pass

    def take(self) -> bytes:
        out = bytes(self._buf)
        self._buf.clear()
        return out

    def pending(self) -> int:
        # PAS de __len__ : zipfile teste « if not self.fp », un tampon vide
        # (len 0) passerait pour une archive fermée.
        return len(self._buf)


def _unique(arcname: str, used: set) -> str:
    name, n = arcname, 1
    while name in used:
        n += 1
        stem, dot, ext = arcname.rpartition(".")
        name = "%s_%d.%s" % (stem, n, ext) if dot else "%s_%d" % (arcname, n)
    used.add(name)
    return name


def _zip_stream(members: List[Tuple[Path, str]]):
    buf = _StreamBuffer()
    used = set()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_STORED, allowZip64=True) as zf:
        for path, arcname in members:
            try:
                src = open(str(path), "rb")
            except OSError:
                logger.warning("[clipping] extrait disparu pendant le zip, sauté : %s", arcname)
                continue
            with src:
                try:
                    info = zipfile.ZipInfo.from_file(str(path), arcname=_unique(arcname, used))
                except OSError:
                    logger.warning("[clipping] extrait illisible pendant le zip, sauté : %s", arcname)
                    continue
                info.compress_type = zipfile.ZIP_STORED
                with zf.open(info, "w", force_zip64=True) as dst:
                    while True:
                        block = src.read(CHUNK)
                        if not block:
                            break
                        dst.write(block)
                        if buf.pending() >= CHUNK:
                            yield buf.take()
            if buf.pending():
                yield buf.take()
    # Fermeture : répertoire central.
    if buf.pending():
        yield buf.take()


@router.get("/telecharger/{ticket}")
def download(ticket: str):
    t = _consume_ticket(ticket)
    if t is None:
        raise HTTPException(404, "Lien expiré ou déjà utilisé")
    target = _resolve_target(t["type"], t["cible"])
    if target["kind"] == "file":
        return FileResponse(str(target["path"]), media_type="video/mp4", filename=target["filename"])
    return StreamingResponse(
        _zip_stream(target["members"]),
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="%s"' % target["filename"]},
    )


# ------------------------------------------------------------------ clé de téléchargement pour scripts
#
# Une clé dédiée, révocable, qui ne donne accès QU'aux clips montés (listing +
# mp4). Seul son hash sha256 est stocké ; la clé n'est montrée qu'une fois.

KEY_PREFIX = "clp_"


def _key_path() -> Path:
    env = os.environ.get("CLIPPING_KEY_FILE")
    if env:
        return Path(env).expanduser()
    return Path(__file__).resolve().parents[2] / "data" / "clipping_cle.json"


def _hash_key(cle: str) -> str:
    return hashlib.sha256(cle.encode("utf-8")).hexdigest()


def _read_key_record() -> Optional[dict]:
    try:
        with _key_path().open("r", encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, dict) and isinstance(data.get("sha256"), str):
            return data
    except (OSError, ValueError):
        pass
    return None


def _write_key_record(rec: dict) -> None:
    """Écriture atomique, fichier créé en 0o600 (pas de fenêtre world-readable)."""
    path = _key_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.fchmod(fd, 0o600)
    except (AttributeError, OSError):
        pass
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(rec, fh)
    os.replace(str(tmp), str(path))


def _require_admin(user) -> None:
    if not getattr(user, "is_admin", False):
        raise HTTPException(403, "Réservé aux administrateurs")


@router.post("/cle")
def create_key(user: User = Depends(get_current_user)):
    _require_admin(user)
    cle = KEY_PREFIX + secrets.token_urlsafe(32)
    cree = time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(_now()))
    _write_key_record({"sha256": _hash_key(cle), "cree": cree,
                       "par": getattr(user, "username", "")})
    logger.info("[clipping] clé de téléchargement générée par %s", getattr(user, "username", "?"))
    return {"cle": cle, "cree": cree}


@router.get("/cle")
def key_status(user: User = Depends(get_current_user)):
    _require_admin(user)
    rec = _read_key_record()
    if not rec:
        return {"active": False, "cree": None, "par": None}
    return {"active": True, "cree": rec.get("cree"), "par": rec.get("par")}


@router.delete("/cle")
def revoke_key(user: User = Depends(get_current_user)):
    _require_admin(user)
    try:
        _key_path().unlink()
    except FileNotFoundError:
        pass
    except OSError:
        raise HTTPException(500, "Révocation impossible")
    logger.info("[clipping] clé de téléchargement révoquée par %s", getattr(user, "username", "?"))
    return {"active": False}


def _require_key(x_clip_key: Optional[str] = Header(None)) -> None:
    rec = _read_key_record()
    ok = False
    if rec and isinstance(x_clip_key, str) and x_clip_key:
        ok = hmac.compare_digest(_hash_key(x_clip_key), rec["sha256"])
    if not ok:
        raise HTTPException(401, "Clé invalide")


@router.get("/cle/montages")
def key_list_montages(jours: int = Query(3, ge=1, le=JOURS_MAX), _k: None = Depends(_require_key)):
    return _montages_listing(jours)


@router.get("/cle/fichier")
def key_montage_file(chemin: str = Query(..., max_length=512), _k: None = Depends(_require_key)):
    target = _resolve_montage(chemin.split("/"))
    return FileResponse(str(target["path"]), media_type="video/mp4", filename=target["filename"])
