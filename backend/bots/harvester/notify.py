"""Notif Telegram best-effort (POST httpx). AUCUNE lib telegram (httpx déjà
présent -> zéro nouvelle dép). Ne lève JAMAIS, ne fuite JAMAIS le token (toute
exception est avalée -> False, on ne logge aucun message d'exception)."""
import httpx

_API = "https://api.telegram.org/bot{0}/sendMessage"


def send(text, cfg, client=None):
    """Envoie ``text`` au chat configuré. Retourne True si HTTP < 400, sinon False.
    cfg = {"token", "chat_id"}. ``client`` httpx injectable (test offline)."""
    token = (cfg or {}).get("token")
    chat_id = (cfg or {}).get("chat_id")
    if not token or not chat_id:
        return False
    owns = client is None
    if owns:
        client = httpx.Client(timeout=10.0)
    try:
        resp = client.post(_API.format(token),
                           json={"chat_id": chat_id, "text": text})
        return resp.status_code < 400
    except Exception:  # noqa: BLE001 — best-effort, ne fuite jamais le token
        return False
    finally:
        if owns:
            try:
                client.close()
            except Exception:  # noqa: BLE001
                pass
