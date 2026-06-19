"""C — politesse robots.txt.

Lit le ``Crawl-delay`` de ``/robots.txt`` et l'impose comme PLANCHER de pacing
(on ne va jamais plus vite que ce que la cible demande). Parseur pur + fetch
best-effort injectable -> testable offline, et tout échec retombe en silence
(robots absent / illisible = pas de contrainte ajoutée).
"""
from urllib.parse import urlsplit


def parse_crawl_delay(robots_txt, user_agent="*"):
    """Crawl-delay (float secondes) applicable à ``user_agent``, sinon None.

    Groupes robots standard (lignes User-agent consécutives = un groupe, jusqu'à
    la 1re directive). Précédence : un groupe ciblant notre UA prime sur ``*``.
    Parseur tolérant : commentaires, lignes vides et clés inconnues ignorés."""
    ua = (user_agent or "*").lower()
    groups = []           # list[{"agents": [...], "delay": float|None}]
    cur = None
    prev_was_directive = False
    for raw in (robots_txt or "").splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line or ":" not in line:
            continue
        key, _, val = line.partition(":")
        key = key.strip().lower()
        val = val.strip()
        if key == "user-agent":
            if cur is None or prev_was_directive:
                cur = {"agents": [], "delay": None}
                groups.append(cur)
                prev_was_directive = False
            cur["agents"].append(val.lower())
        else:
            prev_was_directive = True
            if key == "crawl-delay" and cur is not None:
                try:
                    cur["delay"] = float(val)
                except (TypeError, ValueError):
                    pass

    specific = None
    star = None
    for g in groups:
        if g["delay"] is None:
            continue
        for a in g["agents"]:
            if a == "*":
                star = g["delay"] if star is None else min(star, g["delay"])
            elif a and a in ua:
                specific = g["delay"] if specific is None else max(specific, g["delay"])
    return specific if specific is not None else star


def fetch_crawl_delay(start_url, get, user_agent="*"):
    """GET ``<origin>/robots.txt`` via ``get`` (injectable) et parse le
    Crawl-delay. Best-effort : toute erreur -> None."""
    p = urlsplit(start_url or "")
    if not p.scheme or not p.netloc:
        return None
    robots_url = "{0}://{1}/robots.txt".format(p.scheme, p.netloc)
    try:
        txt = get(robots_url)
    except Exception:  # noqa: BLE001 — robots injoignable = pas de contrainte
        return None
    return parse_crawl_delay(txt, user_agent)


def resolve_base_interval(min_interval_s, start_url, robots_get, user_agent="*"):
    """Plancher de pacing = max(intervalle configuré, Crawl-delay robots.txt).

    ``robots_get`` None -> aucune contrainte robots (chemin de test offline)."""
    base = float(min_interval_s)
    if robots_get is None:
        return base
    cd = fetch_crawl_delay(start_url, robots_get, user_agent)
    if cd and cd > base:
        return cd
    return base
