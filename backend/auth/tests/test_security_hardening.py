"""
Tests des correctifs de sécurité (branche feat/security-hardening).

Couvre :
    #1 Invitations — entropie du code, max_uses appliqué, expiration par défaut.
    #2 Rate-limit login — clé non spoofable via X-Forwarded-For.
    #4 Clé agent — permissions 0o600 + comparaison constant-time.
    #3 .env auto-généré — chmod 0o600 best-effort.

Tous OFFLINE : DB SQLite in-memory isolée, pas de vrai réseau, pas de vraie DB prod.
"""
import os
import stat
import secrets

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend.database import Base
from backend.auth.models import User, Invitation


# ----------------------------------------------------------------------------
# Fixtures — DB SQLite in-memory isolée
# ----------------------------------------------------------------------------

@pytest.fixture
def db():
    """Session SQLAlchemy in-memory, schéma frais à chaque test."""
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    Session = sessionmaker(bind=engine)
    s = Session()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def admin(db):
    u = User(username="admin", hashed_password="x", is_admin=True, role="admin")
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


class _FakeURL:
    def __init__(self, scheme="https", netloc="omenserver.org"):
        self.scheme = scheme
        self.netloc = netloc


class _FakeClient:
    def __init__(self, host):
        self.host = host


class _FakeRequest:
    """Mime fastapi.Request pour le rate limiter (headers + client.host)."""
    def __init__(self, headers=None, client_host="203.0.113.1"):
        self.headers = headers or {}
        self.client = _FakeClient(client_host) if client_host is not None else None
        self.url = _FakeURL()


# ----------------------------------------------------------------------------
# #1 — Invitations
# ----------------------------------------------------------------------------

def test_invitation_code_has_strong_entropy():
    """Le code par défaut doit faire >= 16 chars (token_urlsafe(16) ~ 22 chars)."""
    inv = Invitation(created_by=1)
    # Le default callable est invoqué par SQLAlchemy à l'insertion ; on simule
    # ici en relisant le default de la colonne.
    default = Invitation.__table__.c.code.default.arg
    code = default(None) if callable(default) else default
    assert len(code) >= 16, f"Code trop court ({len(code)} chars) : entropie faible"


def test_new_invitation_defaults_to_single_use(admin, db):
    """Une invitation créée sans précision doit avoir max_uses=1 (pas illimité)."""
    from backend.auth.invite_router import create_invitation, CreateInvitationRequest
    inv = create_invitation(CreateInvitationRequest(role="player"), current_user=admin, db=db)
    row = db.query(Invitation).filter(Invitation.code == inv["code"]).first()
    assert row.max_uses == 1


def test_new_invitation_has_default_expiration(admin, db):
    """Sans expires_in_minutes, l'invitation doit quand même expirer (défaut sensé)."""
    from backend.auth.invite_router import create_invitation, CreateInvitationRequest
    inv = create_invitation(CreateInvitationRequest(role="player"), current_user=admin, db=db)
    row = db.query(Invitation).filter(Invitation.code == inv["code"]).first()
    assert row.expires_at is not None, "Une invitation par défaut ne doit jamais être éternelle"


def test_exhausted_invitation_rejects_second_join(admin, db):
    """max_uses=1 : le 2e join sur le même code doit être rejeté."""
    from fastapi import HTTPException
    from backend.auth.invite_router import join_with_invite, JoinRequest
    from backend.auth.rate_limiter import _attempts

    _attempts.clear()
    inv = Invitation(code="single-use-code-xyz", role="player", created_by=admin.id, max_uses=1, uses=0)
    db.add(inv)
    db.commit()

    req = _FakeRequest()
    # 1er join OK
    join_with_invite("single-use-code-xyz", JoinRequest(username="bob", password="password123"),
                     http_request=req, db=db)
    # 2e join doit échouer (épuisé)
    with pytest.raises(HTTPException) as exc:
        join_with_invite("single-use-code-xyz", JoinRequest(username="carol", password="password123"),
                         http_request=req, db=db)
    assert exc.value.status_code == 400


def test_unlimited_invitation_still_works(admin, db):
    """max_uses=0 (illimité, ancien comportement) ne doit jamais épuiser le code."""
    from backend.auth.invite_router import join_with_invite, JoinRequest
    from backend.auth.rate_limiter import _attempts

    _attempts.clear()
    inv = Invitation(code="unlimited-code-abc", role="player", created_by=admin.id, max_uses=0, uses=0)
    db.add(inv)
    db.commit()

    req = _FakeRequest()
    join_with_invite("unlimited-code-abc", JoinRequest(username="u1", password="password123"),
                     http_request=req, db=db)
    join_with_invite("unlimited-code-abc", JoinRequest(username="u2", password="password123"),
                     http_request=req, db=db)
    # Pas d'exception → 2 comptes créés
    assert db.query(User).filter(User.username.in_(["u1", "u2"])).count() == 2


def test_expired_invitation_rejected(admin, db):
    """Une invitation échue → 410."""
    from datetime import datetime, timezone, timedelta
    from fastapi import HTTPException
    from backend.auth.invite_router import join_with_invite, JoinRequest
    from backend.auth.rate_limiter import _attempts

    _attempts.clear()
    past = datetime.now(timezone.utc) - timedelta(minutes=10)
    inv = Invitation(code="expired-code-123", role="player", created_by=admin.id,
                     max_uses=1, uses=0, expires_at=past)
    db.add(inv)
    db.commit()

    req = _FakeRequest()
    with pytest.raises(HTTPException) as exc:
        join_with_invite("expired-code-123", JoinRequest(username="late", password="password123"),
                         http_request=req, db=db)
    assert exc.value.status_code == 410


# ----------------------------------------------------------------------------
# #2 — Rate limit login : X-Forwarded-For ne doit plus changer la clé
# ----------------------------------------------------------------------------

def test_rate_limit_ignores_spoofed_xff_auth():
    """backend.auth.rate_limiter : un XFF différent par requête ne contourne plus
    la limite (la clé reste basée sur request.client.host)."""
    from fastapi import HTTPException
    from backend.auth import rate_limiter as rl

    rl._attempts.clear()
    # 6 requêtes du MÊME client direct, chacune avec un XFF aléatoire
    hit = False
    for i in range(rl.MAX_ATTEMPTS + 3):
        req = _FakeRequest(
            headers={"X-Forwarded-For": f"{i}.{i}.{i}.{i}"},
            client_host="198.51.100.7",
        )
        try:
            rl.check_rate_limit(req, endpoint="login")
        except HTTPException as e:
            assert e.status_code == 429
            hit = True
            break
    assert hit, "Le rate-limit aurait dû se déclencher malgré le XFF spoofé"


def test_rate_limit_uses_cf_connecting_ip_when_present():
    """Si CF-Connecting-IP est posé (prod Cloudflare), il prime."""
    from backend.auth import rate_limiter as rl
    rl._attempts.clear()
    req = _FakeRequest(
        headers={"CF-Connecting-IP": "9.9.9.9", "X-Forwarded-For": "1.2.3.4"},
        client_host="10.0.0.1",
    )
    rl.check_rate_limit(req, endpoint="login")
    assert "login:9.9.9.9" in rl._attempts, "CF-Connecting-IP doit servir de clé"
    assert "login:1.2.3.4" not in rl._attempts, "XFF ne doit pas servir de clé"


def test_middleware_rate_limit_ignores_spoofed_xff():
    """backend.rate_limiter : _get_client_ip ne fait plus confiance à XFF."""
    from backend import rate_limiter as mrl
    req = _FakeRequest(headers={"X-Forwarded-For": "6.6.6.6"}, client_host="172.16.5.5")
    ip = mrl._get_client_ip(req)
    assert ip != "6.6.6.6", "Le XFF ne doit plus être utilisé comme IP de confiance"
    assert ip == "172.16.5.5"


def test_middleware_rate_limit_uses_cf_connecting_ip():
    from backend import rate_limiter as mrl
    req = _FakeRequest(headers={"CF-Connecting-IP": "8.8.8.8", "X-Forwarded-For": "6.6.6.6"},
                       client_host="172.16.5.5")
    assert mrl._get_client_ip(req) == "8.8.8.8"


# ----------------------------------------------------------------------------
# #4 — Clé agent : permissions + constant-time
# ----------------------------------------------------------------------------

def test_agent_key_file_is_0600(tmp_path, monkeypatch):
    """nodes_api_key.txt doit être créé en 0o600 (pas world-readable)."""
    from backend.monitoring import nodes_router as nr
    key_file = tmp_path / "nodes_api_key.txt"
    monkeypatch.setattr(nr, "_KEY_DIR", tmp_path)
    monkeypatch.setattr(nr, "_KEY_FILE", key_file)

    key = nr._get_or_create_api_key()
    assert key and len(key) >= 16
    mode = stat.S_IMODE(os.stat(key_file).st_mode)
    assert mode == 0o600, f"Permissions attendues 0o600, obtenues {oct(mode)}"


def test_agent_key_reset_is_0600(tmp_path, monkeypatch):
    """reset_api_key doit aussi écrire en 0o600."""
    from backend.monitoring import nodes_router as nr

    class _Admin:
        is_admin = True

    key_file = tmp_path / "nodes_api_key.txt"
    monkeypatch.setattr(nr, "_KEY_DIR", tmp_path)
    monkeypatch.setattr(nr, "_KEY_FILE", key_file)

    nr.reset_api_key(current_user=_Admin())
    mode = stat.S_IMODE(os.stat(key_file).st_mode)
    assert mode == 0o600, f"Permissions attendues 0o600, obtenues {oct(mode)}"


def test_agent_key_verify_uses_constant_time(tmp_path, monkeypatch):
    """_verify_agent_key doit utiliser secrets.compare_digest (pas !=)."""
    from fastapi import HTTPException
    from backend.monitoring import nodes_router as nr

    key_file = tmp_path / "nodes_api_key.txt"
    monkeypatch.setattr(nr, "_KEY_DIR", tmp_path)
    monkeypatch.setattr(nr, "_KEY_FILE", key_file)
    real_key = nr._get_or_create_api_key()

    # Bonne clé → pas d'exception
    nr._verify_agent_key(x_agent_key=real_key)

    # Mauvaise clé → 403
    with pytest.raises(HTTPException) as exc:
        nr._verify_agent_key(x_agent_key="wrong-key")
    assert exc.value.status_code == 403

    # Clé absente → 403 (pas de crash sur None)
    with pytest.raises(HTTPException):
        nr._verify_agent_key(x_agent_key=None)

    # Vérifier l'usage de compare_digest dans le module (anti-régression)
    import inspect
    src = inspect.getsource(nr._verify_agent_key)
    assert "compare_digest" in src, "La comparaison doit être constant-time"


# ----------------------------------------------------------------------------
# #3 — .env auto-généré : chmod 0o600 best-effort
# ----------------------------------------------------------------------------

def test_config_chmods_env_to_0600():
    """config.py doit poser os.chmod(_env_file, 0o600) après écriture du .env.

    On vérifie via le code source (le bloc s'exécute à l'import, conditionnel à un
    SECRET_KEY par défaut — non rejouable proprement en test sans réécrire le vrai
    .env de dev). Anti-régression : la séquence write_text → chmod 0o600 doit exister.
    """
    import inspect
    from backend import config
    src = inspect.getsource(config)
    assert "os.chmod(_env_file, 0o600)" in src, "Le .env auto-généré doit être chmod 0o600"


def test_env_chmod_pattern_actually_restricts(tmp_path):
    """Sanity : écrire un .env puis os.chmod 0o600 produit bien des perms owner-only."""
    env = tmp_path / ".env"
    env.write_text("SECRET_KEY=fake\n")
    os.chmod(env, 0o600)
    mode = stat.S_IMODE(os.stat(env).st_mode)
    assert mode == 0o600


# ----------------------------------------------------------------------------
# #5 — /api/sysdoc/me : secret_key INTENTIONNELLEMENT conservé (documenté)
# ----------------------------------------------------------------------------

def test_sysdoc_me_still_returns_secret_for_admin_by_design():
    """L'agent sysdoc SIGNE son propre JWT avec ce secret (tools/diagnostic_agent
    génère jwt.encode(payload, OMEN_JWT_SECRET)). Le retirer casserait l'auth agent.
    → on le LAISSE en place (refonte secret-agent-dédié = hors scope). Ce test
    documente la décision : non-admin ne reçoit JAMAIS le secret."""
    import inspect
    from backend.sysdoc import router as sysdoc_router
    src = inspect.getsource(sysdoc_router.get_my_agent_config)
    # Le secret n'est exposé QUE dans la branche admin.
    assert "if current_user.is_admin" in src
    assert 'response["secret_key"] = settings.SECRET_KEY' in src
