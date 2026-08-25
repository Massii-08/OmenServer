"""Notif Telegram best-effort (POST httpx). AUCUNE lib telegram (httpx déjà
présent -> zéro nouvelle dép). Ne lève JAMAIS, ne fuite JAMAIS le token (toute
exception est avalée -> False, on ne logge aucun message d'exception)."""
import logging

import httpx

_API = "https://api.telegram.org/bot{0}/sendMessage"

# 🔒 L'URL de l'API Telegram CONTIENT le jeton du bot (…/bot<TOKEN>/sendMessage)
# et httpx logge l'URL COMPLÈTE en INFO sur le logger "httpx"
# (« HTTP Request: POST https://api.telegram.org/bot<TOKEN>/sendMessage "HTTP/1.1
# 200 OK" ») -> le jeton se retrouvait EN CLAIR dans journalctl, lisible par tout
# ce qui lit les logs système. On remonte ce logger à WARNING dès l'import du
# module : les erreurs de transport restent visibles, plus AUCUNE requête httpx
# n'est tracée avec son URL.
#
# ⚠️ Portée : le niveau d'un logger est GLOBAL au processus. C'est voulu — dans
# le processus uvicorn, aucune trace httpx de niveau INFO n'a de valeur
# diagnostique qui justifie de risquer une fuite de secret dans une URL (le même
# problème existerait avec une clé d'API en query string). Les bots qui tournent
# en subprocess détaché (market-pulse, harvester…) ont leur propre processus et
# ne sont pas affectés par cette ligne.
logging.getLogger("httpx").setLevel(logging.WARNING)


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
