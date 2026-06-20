"""Garde anti-SSRF des requêtes sortantes.

Plusieurs fonctionnalités font le serveur émettre des requêtes vers des
destinations influencées par l'utilisateur (AI Harvester, install de mods,
webhook de notification). Sans garde, un utilisateur peut viser localhost, les
conteneurs Docker internes, le LAN ou les métadonnées (169.254.x).

Ce module fournit :
- ``is_public_url(url)`` / ``assert_public_url(url)`` : n'autorise que http(s)
  ET une destination dont TOUTES les IP résolues sont publiques (rejette
  loopback / privé RFC1918 / link-local / multicast / réservé).
- ``host_allowed(url, suffixes)`` : allowlist stricte d'hôtes (pour les CDN de
  mods — l'URL de download ne doit pas pouvoir viser une cible arbitraire).

Le resolver DNS est INJECTABLE -> testable offline. ⚠️ La validation
hostname->IP reste sujette au DNS-rebinding (TOCTOU entre la résolution et la
connexion) ; pour une cible vraiment hostile, préférer ``host_allowed`` (CDN
fixes) plutôt qu'une URL arbitraire.
"""
import ipaddress
import socket
from urllib.parse import urlparse


class UnsafeUrlError(ValueError):
    """Levée quand une URL sortante vise une destination interdite."""


def _default_resolver(host):
    """Résout un host en liste d'IP (v4 + v6) via getaddrinfo."""
    infos = socket.getaddrinfo(host, None)
    return [info[4][0] for info in infos]


def _ip_is_public(ip_str):
    """True seulement si l'IP est routable publiquement."""
    try:
        # strip d'un éventuel scope id IPv6 (fe80::1%eth0)
        ip = ipaddress.ip_address(ip_str.split("%")[0])
    except ValueError:
        return False
    return not (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    )


def is_public_url(url, *, resolver=None):
    """True si l'URL est http(s) ET pointe vers une destination publique.

    Bloqué si UNE SEULE des IP résolues est non-publique (anti-rebinding partiel).
    """
    resolver = resolver or _default_resolver
    try:
        parsed = urlparse(url)
    except (ValueError, AttributeError):
        return False
    if parsed.scheme not in ("http", "https"):
        return False
    host = parsed.hostname
    if not host:
        return False
    # IP littérale dans l'URL -> valider directement (pas de DNS)
    try:
        ipaddress.ip_address(host)
        return _ip_is_public(host)
    except ValueError:
        pass
    try:
        ips = resolver(host)
    except OSError:
        return False
    if not ips:
        return False
    return all(_ip_is_public(ip) for ip in ips)


def assert_public_url(url, *, resolver=None):
    """Lève UnsafeUrlError si l'URL n'est pas une destination publique sûre."""
    if not is_public_url(url, resolver=resolver):
        raise UnsafeUrlError(
            "URL sortante non autorisée (interne/privée/schéma invalide)"
        )


def host_allowed(url, allowed_suffixes):
    """True si l'hôte de l'URL est exactement un suffixe autorisé ou un
    sous-domaine de celui-ci (``media.forgecdn.net`` ⊂ ``forgecdn.net``).
    Rejette les lookalikes (``forgecdn.net.evil.com``)."""
    try:
        host = (urlparse(url).hostname or "").lower()
    except (ValueError, AttributeError):
        return False
    if not host:
        return False
    for suf in allowed_suffixes:
        s = suf.lower().strip(".")
        if host == s or host.endswith("." + s):
            return True
    return False
