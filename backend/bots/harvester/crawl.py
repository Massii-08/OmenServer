"""Exécuteur de plan de crawl : énumération d'URL (sitemap / pagination).

Pur, zéro dépendance (xml.etree + urllib.parse stdlib + dom.py)."""
import xml.etree.ElementTree as ET
from typing import Dict, List, Optional
from urllib.parse import urljoin

from backend.bots.harvester.dom import find_first, parse_html


def absolute_url(base: str, href: str) -> str:
    return urljoin(base, href)


def parse_sitemap(xml: str) -> List[str]:
    """Retourne les <loc> d'un <urlset> OU d'un <sitemapindex> (namespace-agnostique)."""
    locs = []  # type: List[str]
    try:
        root = ET.fromstring(xml.strip())
    except ET.ParseError:
        return locs
    for el in root.iter():
        tag = el.tag.rsplit("}", 1)[-1]  # strip namespace
        if tag == "loc" and el.text:
            locs.append(el.text.strip())
    return locs


def next_page_url(html: str, base_url: str, next_selector: Dict[str, str]) -> Optional[str]:
    """Suit le lien 'page suivante' : 1er <a href> sous l'élément next_selector."""
    root = parse_html(html)
    container = find_first(root, next_selector)
    if container is None:
        return None
    anchor = find_first(container, {"tag": "a"})
    if anchor is None:
        return None
    href = anchor.get_attr("href")
    if not href:
        return None
    return absolute_url(base_url, href)
