"""Grands portefeuilles — dépôts 13F de la SEC (EDGAR), et guetteur de dépôts.

Deux usages, une seule source :

1. **Snapshot** (`get_snapshot`) : le dernier trimestre agrégé d'un gérant +
   le DIFF contre le trimestre précédent (entrées, sorties, renforcements,
   allègements, top 15, concentration).
2. **Guetteur** (`check_new_filings`) : détecte les NOUVEAUX dépôts EDGAR des
   gérants du catalogue et prévient par Telegram. Aucun job n'est armé ici —
   ce module expose la fonction, le planificateur est ailleurs.
   ⚠️ « Nouveau » veut dire DEUX choses et il faut les deux : jamais vu ET
   déposé il y a moins de ``NOTIFY_MAX_AGE_D`` jours (cf. le bloc de constantes
   du guetteur — l'incident du 25/08 est né de l'oubli de la seconde).

Honnêteté pédagogique (à afficher dans l'UI, pas seulement ici) : un 13F paraît
jusqu'à 45 jours APRÈS la fin du trimestre et ne couvre que les actions US
longues — ni ventes à découvert, ni liquidités, ni titres hors US. On y apprend
l'ALLOCATION des grands, on n'y copie pas des trades « live ».

⚠️ **Limite structurelle des gérants INTERNATIONAUX** (BNS, Norges Bank, Baillie
Gifford, TCI, Temasek, Nomura — ajoutés le 26/08) : le 13F est une obligation
AMÉRICAINE. On ne voit donc de ces fonds **que leur poche d'actions cotées aux
États-Unis**, jamais leur portefeuille réel. Le fonds souverain norvégien
détient des milliers de lignes dans le monde entier ; son 13F n'en montre
qu'une tranche. Lire « voilà ce que fait Norges Bank » serait faux — la bonne
lecture est « voilà ce que fait Norges Bank AUX ÉTATS-UNIS ». Cette phrase doit
accompagner ces gérants partout où ils s'affichent.

Trois volets tournent dans la même ronde (``check_new_filings``), au même
rythme et avec le même pacing :

1. les **dépôts des gérants** du catalogue (13F, 13D/G, formulaires 4) ;
2. les **dépôts des titres de l'utilisateur** (8-K et compagnie — cf. le bloc
   « volet SES titres ») ;
3. les **rendez-vous des banques centrales** à moins de 7 jours (cf. le bloc
   « volet AGENDA »), empruntés au moteur Market Pulse via ``agenda_bridge``.

Faits MESURÉS sur la source (sonde du 24/08, pas des suppositions) :

* ``data.sec.gov/submissions/CIK{10 chiffres}.json`` → 200 avec un User-Agent
  identifiant ; sans User-Agent la SEC bloque. Champs utiles : ``name`` et
  ``filings.recent.{form,accessionNumber,filingDate,reportDate}`` (tableaux
  parallèles, triés du dépôt le plus récent au plus ancien).
* Un même trimestre peut avoir DEUX dépôts : le ``13F-HR`` puis un amendement
  ``13F-HR/A`` plus tardif — mesuré chez Berkshire (période 2025-03-31 amendée
  le 2025-08-14). C'est l'amendement qui fait foi.
* Dans le dossier d'archive, l'infotable a un nom ARBITRAIRE (mesuré :
  ``56757.xml``) → détection par CONTENU (namespace
  ``thirteenf/informationtable``), jamais par nom de fichier.
* ``value`` est en DOLLARS (mesuré : 577 211 815 pour 12 561 737 actions Ally,
  soit ~46 $/action — cohérent). ⚠️ Les 13F d'avant ~2023 exprimaient ce champ
  en MILLIERS de dollars ; on ne lit ici que les deux trimestres les plus
  récents, donc toujours des dollars. Aucune mise à l'échelle « magique » n'est
  appliquée : deviner corromprait silencieusement le chiffre.
* ⚠️ Un même émetteur apparaît sur PLUSIEURS lignes (mesuré : Ally, Apple,
  Coca-Cola… chez Berkshire — gérants internes distincts) → agrégation par
  CUSIP OBLIGATOIRE, sinon le top est faux.

Anti-mauvais-nom (esprit du piège #31 du dépôt) : chaque gérant porte un mot
clé ``expect`` ; si le champ ``name`` du JSON SEC ne le contient pas, le
gérant passe en statut ``unverified`` et AUCUNE donnée n'est servie sous son
nom. Un CIK erroné ne peut donc jamais afficher le portefeuille de quelqu'un
d'autre.

Tout est injectable (``client``, ``sleep``, ``now``, ``notifier``) : les tests
tournent 100 % hors ligne.

Canal Telegram : ``paper/alerts.py`` (bot ORACLE, spec §13) — seuls les DÉFAUTS
de ``notifier``/``tg_cfg`` ont changé, l'injection reste la même.
"""
import json
import logging
import os
import re
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple
from urllib.parse import quote_plus, urljoin

logger = logging.getLogger("omenserver")

# --------------------------------------------------------------------------- #
# Constantes de la source
# --------------------------------------------------------------------------- #

# backend/bots/paper/whales.py -> racine projet = parents[3]
_PROJECT_ROOT = Path(__file__).resolve().parents[3]
DATA_DIR = _PROJECT_ROOT / "data" / "paper_trading"

# La SEC EXIGE un User-Agent qui identifie l'appelant (sinon 403/blocage).
SEC_USER_AGENT = "OmenServer paper-trading educational tool contact@omenserver.org"
SEC_HEADERS = {
    "User-Agent": SEC_USER_AGENT,
    "Accept-Encoding": "gzip, deflate",
}

SUBMISSIONS_URL = "https://data.sec.gov/submissions/CIK{cik}.json"
ARCHIVE_DIR_URL = "https://www.sec.gov/Archives/edgar/data/{cik}/{accession}/"
# Page de consultation humaine (mise dans les notifications : Massii clique et
# vérifie lui-même — même esprit que le lien Fitch de la cellule G du scanner).
BROWSE_URL = ("https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany"
              "&CIK={cik}&type={form}&dateb=&owner=include&count=10")

TIMEOUT_S = 20.0
PACE_S = 1.0                 # 1 requête/seconde : la limite de courtoisie SEC
MAX_XML_CANDIDATES = 3       # borne dure : on ne balaie pas un dossier entier

INFOTABLE_NS_MARK = "thirteenf/informationtable"

CACHE_TTL_S = 24 * 3600.0
TOP_N = 15
CONCENTRATION_N = 10
# Sous ce seuil, une variation de position est du bruit d'arrondi/de gestion.
MOVE_THRESHOLD_PCT = 3.0

# Guetteur : formulaires suivis + taille des mémoires.
WATCHED_FORMS = frozenset({
    "13F-HR", "13F-HR/A",
    "SC 13D", "SC 13D/A",
    "SC 13G", "SC 13G/A",
    "4", "4/A",
})
MAX_NOTIFY_PER_MANAGER = 3   # anti-tempête : le reste est marqué vu, pas notifié
MAX_EVENTS = 100             # journal des dépôts détectés (les plus récents en tête)

# --------------------------------------------------------------------------- #
# Anti-spam de dépôts ANTIQUES — incident mesuré le 25/08 (30 messages à 09:02
# pour des dépôts SEC de 2009-2021, et le spam serait reparti toutes les 30 min).
#
# Mécanisme exact du bug : ``state["seen"][mid]`` était CAPÉ à 300 accessions
# alors que ``filings.recent`` de la SEC en renvoie couramment plusieurs
# centaines (mesuré : 300 PILE pour berkshire/pershing/soros/gates/renaissance/
# tiger = le cap, donc troncature). Les accessions évincées du cap
# redevenaient « inconnues » au passage suivant -> re-notifiées -> re-évincées ->
# re-notifiées : une boucle infinie de dépôts vieux de dix ans.
#
# Deux protections, dans cet ordre :
#
#   1. CEINTURE — ``NOTIFY_MAX_AGE_D`` : un dépôt plus vieux que 14 jours n'est
#      JAMAIS notifié ni journalisé, quel que soit l'état de ``seen``. C'est la
#      garde qui tient même si la mémoire est vide, corrompue ou remise à neuf.
#   2. BRETELLES — un plafond de ``seen`` qui ne peut plus causer de
#      ré-émission : tout dépôt de moins de ``SEEN_RECENT_D`` jours est gardé
#      quoi qu'il arrive, et le reste est capé LARGE (``MAX_SEEN_PER_MANAGER``,
#      bien au-dessus de la fenêtre ``filings.recent`` de la SEC, plafonnée à
#      1000) en gardant les PLUS RÉCENTS.
#
# ⚠️ Leçon générale : un cap qui ÉVINCE une mémoire « déjà vu » ne borne pas un
# fichier, il fabrique des faux positifs récurrents. Soit la mémoire couvre
# toute la fenêtre de la source, soit la décision d'alerte ne dépend pas d'elle
# (ici : les deux).
NOTIFY_MAX_AGE_D = 14
SEEN_RECENT_D = 90
MAX_SEEN_PER_MANAGER = 2000


class WhaleError(RuntimeError):
    """Source SEC indisponible ou réponse inexploitable."""


# --------------------------------------------------------------------------- #
# Catalogue des gérants
# --------------------------------------------------------------------------- #
# ``cik`` est une PISTE, pas une vérité : c'est ``expect`` confronté au champ
# ``name`` du JSON SEC qui tranche au runtime (cf. anti-mauvais-nom).
MANAGERS = [
    {"id": "berkshire", "label": "Warren Buffett — Berkshire Hathaway",
     "cik": "0001067983", "expect": "berkshire"},
    {"id": "bridgewater", "label": "Ray Dalio — Bridgewater",
     "cik": "0001350694", "expect": "bridgewater"},
    {"id": "scion", "label": "Michael Burry — Scion",
     "cik": "0001649339", "expect": "scion"},
    {"id": "pershing", "label": "Bill Ackman — Pershing Square",
     "cik": "0001336528", "expect": "pershing"},
    {"id": "duquesne", "label": "Stanley Druckenmiller — Duquesne",
     "cik": "0001536411", "expect": "duquesne"},
    {"id": "soros", "label": "Soros Fund Management",
     "cik": "0001029160", "expect": "soros"},
    {"id": "gates", "label": "Bill & Melinda Gates Foundation Trust",
     "cik": "0001166559", "expect": "gates"},
    {"id": "renaissance", "label": "Renaissance Technologies",
     "cik": "0001037389", "expect": "renaissance"},
    {"id": "tiger", "label": "Tiger Global",
     "cik": "0001167483", "expect": "tiger"},
    {"id": "appaloosa", "label": "David Tepper — Appaloosa",
     "cik": "0001656456", "expect": "appaloosa"},
    # --- Gérants INTERNATIONAUX (26/08) ------------------------------------- #
    # Ils déposent un 13F parce qu'ils détiennent des actions américaines, pas
    # parce qu'ils sont américains : on ne voit donc que leur poche US (cf. la
    # limite structurelle en tête de fichier). CIK vérifiés un par un contre
    # ``data.sec.gov/submissions`` le 26/08 — le champ ``name`` renvoyé par la
    # SEC est cité en commentaire quand il ne se devine pas.
    # Le nom SEC est cité DANS le libellé : c'est lui que Massii retrouvera sur
    # EDGAR, et c'est aussi ce qui garde le mot clé ``expect`` vérifiable contre
    # le libellé (invariant du catalogue — un libellé traduit sans son original
    # rendrait la garde anti-mauvais-nom impossible à relire).
    {"id": "snb-ch", "label": "Banque nationale suisse (Swiss National Bank)",
     "cik": "0001582202", "expect": "swiss national"},
    # ⚠️ PAS 0001374911 : ce CIK-là est « CAPITAL CITY ENERGY FUND XIV LLC »,
    # un fonds texan. C'est exactement le genre de confusion que la garde
    # ``expect`` attrape (elle refuserait de servir ses lignes sous le nom du
    # fonds souverain norvégien) — mesuré, pas supposé.
    {"id": "norges", "label": "Norges Bank (fonds souverain norvégien)",
     "cik": "0001374170", "expect": "norges"},
    {"id": "baillie", "label": "Baillie Gifford (UK)",
     "cik": "0001088875", "expect": "baillie"},
    {"id": "tci", "label": "TCI Fund (UK)",
     "cik": "0001647251", "expect": "tci"},
    {"id": "temasek", "label": "Temasek (Singapour)",
     "cik": "0001021944", "expect": "temasek"},
    {"id": "nomura", "label": "Nomura (Japon)",
     "cik": "0001163653", "expect": "nomura"},
]


def find_manager(manager_id: Any) -> Optional[Dict[str, str]]:
    """Le gérant du catalogue portant cet identifiant, sinon None."""
    for m in MANAGERS:
        if m["id"] == manager_id:
            return m
    return None


# --------------------------------------------------------------------------- #
# Client HTTP (paresseux, injectable) et pacing
# --------------------------------------------------------------------------- #
_client = None                              # instance module, créée à la demande
_now: Callable[[], float] = time.time       # horloge du cache (injectable)


def get_client():
    """Client httpx partagé du module (créé à la première demande)."""
    global _client
    if _client is None:
        import httpx
        _client = httpx.Client(timeout=TIMEOUT_S, headers=dict(SEC_HEADERS),
                               follow_redirects=True)
    return _client


def set_client(client) -> None:
    """Remplace le client module (tests, ou client partagé maison)."""
    global _client
    _client = client


class _Pacer(object):
    """Espace les requêtes d'au moins ``PACE_S``. La PREMIÈRE ne dort pas :
    on ne paie la politesse qu'entre deux appels réellement consécutifs."""

    def __init__(self, sleep: Optional[Callable[[float], None]] = None,
                 interval_s: float = PACE_S) -> None:
        self._sleep = sleep or time.sleep
        self._interval = interval_s
        self._armed = False

    def wait(self) -> None:
        if self._armed:
            self._sleep(self._interval)
        self._armed = True


def _http_get(url: str, client=None, pacer: Optional[_Pacer] = None):
    """GET SEC : User-Agent obligatoire, timeout borné, pacing respecté.
    Lève ``WhaleError`` sur tout statut >= 400 ou toute panne de transport."""
    if pacer is not None:
        pacer.wait()
    cli = client if client is not None else get_client()
    try:
        resp = cli.get(url, headers=dict(SEC_HEADERS), timeout=TIMEOUT_S)
    except Exception as exc:                      # noqa: BLE001 — transport
        raise WhaleError("%s indisponible (%s)" % (_host(url), type(exc).__name__))
    status = getattr(resp, "status_code", 0)
    if status >= 400:
        raise WhaleError("%s a répondu %s" % (_host(url), status))
    return resp


def _host(url: str) -> str:
    """Hôte lisible pour un message d'erreur COURT (jamais l'URL entière)."""
    m = re.match(r"https?://([^/]+)", url or "")
    return m.group(1) if m else "SEC"


# --------------------------------------------------------------------------- #
# Fonctions PURES — parsing / agrégation / comparaison
# --------------------------------------------------------------------------- #

def _local(tag: Any) -> str:
    """Nom local d'une balise, namespace retiré."""
    return str(tag).rsplit("}", 1)[-1]


def _child_text(node, name: str) -> str:
    for child in node:
        if _local(child.tag) == name:
            return (child.text or "").strip()
    return ""


def _deep_text(node, name: str) -> str:
    """Texte du premier descendant portant ce nom local (profondeur libre)."""
    for sub in node.iter():
        if _local(sub.tag) == name:
            return (sub.text or "").strip()
    return ""


def _to_number(text: str) -> Optional[float]:
    """Nombre tolérant (« 1,234.00 » compris). None si illisible."""
    if not text:
        return None
    cleaned = text.replace(",", "").replace(" ", "").replace(" ", "")
    try:
        return float(cleaned)
    except ValueError:
        return None


def parse_infotable(xml_text: str) -> List[Dict[str, Any]]:
    """Lit une infotable 13F → une ligne par ``<infoTable>``.

    Retourne ``[{name, cusip, class, value_usd, shares, share_type}]``.
    Une ligne sans CUSIP ou sans valeur lisible est ignorée (on ne peut ni
    l'agréger ni la comparer). XML illisible → ``[]`` : la source ne fait
    jamais planter l'appelant.

    Le namespace est traité par NOM LOCAL (et non par URI figée) : les
    filers publient la même structure sous des variantes de namespace, et
    c'est le contenu qui fait foi.
    """
    if not xml_text:
        return []
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return []
    rows = []  # type: List[Dict[str, Any]]
    for node in root.iter():
        if _local(node.tag) != "infoTable":
            continue
        cusip = _child_text(node, "cusip").upper()
        value = _to_number(_child_text(node, "value"))
        if not cusip or value is None:
            continue
        shares = _to_number(_deep_text(node, "sshPrnamt")) or 0.0
        rows.append({
            "name": _child_text(node, "nameOfIssuer") or cusip,
            "cusip": cusip,
            "class": _child_text(node, "titleOfClass"),
            "value_usd": int(round(value)),
            "shares": int(round(shares)),
            # 'SH' = actions, 'PRN' = nominal (obligataire) — conservé pour que
            # l'UI ne présente pas un nominal comme un nombre d'actions.
            "share_type": _deep_text(node, "sshPrnamtType") or "SH",
        })
    return rows


def aggregate(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Fusionne les lignes d'un même CUSIP (obligatoire, cf. en-tête) et trie
    par valeur décroissante.

    Le nom et la classe retenus sont ceux de la PREMIÈRE ligne rencontrée ;
    ``lines`` dit combien de lignes ont été fusionnées (transparence : c'est
    ce qui explique un écart avec un total lu ailleurs).
    """
    by_cusip = {}  # type: Dict[str, Dict[str, Any]]
    order = []  # type: List[str]
    for row in rows or []:
        cusip = row.get("cusip")
        if not cusip:
            continue
        entry = by_cusip.get(cusip)
        if entry is None:
            entry = {
                "cusip": cusip,
                "name": row.get("name") or cusip,
                "class": row.get("class", ""),
                "share_type": row.get("share_type", "SH"),
                "value_usd": 0,
                "shares": 0,
                "lines": 0,
            }
            by_cusip[cusip] = entry
            order.append(cusip)
        entry["value_usd"] += int(row.get("value_usd") or 0)
        entry["shares"] += int(row.get("shares") or 0)
        entry["lines"] += 1
    out = [by_cusip[c] for c in order]
    # Tri déterministe : valeur décroissante, puis CUSIP (deux positions de
    # valeur identique doivent sortir toujours dans le même ordre).
    out.sort(key=lambda e: (-e["value_usd"], e["cusip"]))
    return out


def _index(agg: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    return {e["cusip"]: e for e in (agg or []) if e.get("cusip")}


def diff_quarters(cur: List[Dict[str, Any]],
                  prev: List[Dict[str, Any]]) -> Dict[str, List[Dict[str, Any]]]:
    """Compare deux trimestres AGRÉGÉS (sortie de ``aggregate``).

    Renvoie ``{new, exits, increased, decreased}``.

    La variation se mesure sur le NOMBRE D'ACTIONS, jamais sur la valeur : le
    prix bouge tout seul, un portefeuille immobile verrait sinon toutes ses
    lignes « varier ». Seuil : ±``MOVE_THRESHOLD_PCT`` % (en deçà, c'est du
    bruit). Une position dont le trimestre précédent affiche 0 action est
    ignorée des renforcements/allègements : aucun pourcentage n'est calculable
    (on préfère ne rien dire à inventer un « +∞ »).

    ⚠️ Chaque mouvement porte sa CLASSE de titre (``class``). Deux classes
    d'actions d'un même émetteur ont des CUSIP différents et ne se fusionnent
    donc pas — mesuré en vrai chez Berkshire : « ALPHABET INC » sort DEUX fois
    (Class A +658 %, Class C +45 %). Sans la classe, l'écran afficherait deux
    lignes au nom identique et cela se lirait comme un doublon.
    """
    cur_ix, prev_ix = _index(cur), _index(prev)
    new, exits, increased, decreased = [], [], [], []

    for cusip, entry in cur_ix.items():
        if cusip not in prev_ix:
            new.append({
                "cusip": cusip, "name": entry["name"],
                "class": entry.get("class", ""),
                "value_usd": entry["value_usd"], "shares": entry["shares"],
            })
            continue
        before = prev_ix[cusip]
        prev_shares = before.get("shares") or 0
        if prev_shares <= 0:
            continue
        delta_pct = round(
            (entry["shares"] - prev_shares) * 100.0 / prev_shares, 2)
        move = {
            "cusip": cusip, "name": entry["name"],
            "class": entry.get("class", ""),
            "value_usd": entry["value_usd"],
            "shares": entry["shares"], "prev_shares": prev_shares,
            "delta_pct": delta_pct,
        }
        if delta_pct > MOVE_THRESHOLD_PCT:
            increased.append(move)
        elif delta_pct < -MOVE_THRESHOLD_PCT:
            decreased.append(move)

    for cusip, before in prev_ix.items():
        if cusip not in cur_ix:
            exits.append({
                "cusip": cusip, "name": before["name"],
                "class": before.get("class", ""),
                "value_usd": before["value_usd"], "shares": before["shares"],
            })

    new.sort(key=lambda e: (-e["value_usd"], e["cusip"]))
    exits.sort(key=lambda e: (-e["value_usd"], e["cusip"]))
    increased.sort(key=lambda e: (-e["delta_pct"], e["cusip"]))
    decreased.sort(key=lambda e: (e["delta_pct"], e["cusip"]))
    return {"new": new, "exits": exits,
            "increased": increased, "decreased": decreased}


def quarter_label(report_date: Optional[str]) -> str:
    """« 2026-06-30 » → « T2 2026 ». Date illisible → la date telle quelle."""
    if not report_date:
        return ""
    try:
        year, month = int(report_date[0:4]), int(report_date[5:7])
    except (TypeError, ValueError):
        return str(report_date)
    if not 1 <= month <= 12:
        return str(report_date)
    return "T%d %d" % ((month - 1) // 3 + 1, year)


def summarize(agg: List[Dict[str, Any]],
              diff: Dict[str, List[Dict[str, Any]]],
              quarter: Optional[str],
              prev_quarter: Optional[str]) -> Dict[str, Any]:
    """Fiche prête pour l'UI : poids du top 15, concentration, mouvements."""
    agg = agg or []
    total = sum(int(e.get("value_usd") or 0) for e in agg)
    top = []
    for entry in agg[:TOP_N]:
        value = int(entry.get("value_usd") or 0)
        top.append({
            "cusip": entry.get("cusip"),
            "name": entry.get("name"),
            "class": entry.get("class", ""),
            "value_usd": value,
            "shares": entry.get("shares", 0),
            "pct": round(value * 100.0 / total, 2) if total else 0.0,
        })
    top10 = sum(int(e.get("value_usd") or 0) for e in agg[:CONCENTRATION_N])
    return {
        "quarter": quarter,
        "quarter_label": quarter_label(quarter),
        "prev_quarter": prev_quarter,
        "prev_quarter_label": quarter_label(prev_quarter),
        "total_value_usd": total,
        "n_positions": len(agg),
        "top": top,
        "concentration_top10_pct": (round(top10 * 100.0 / total, 2)
                                    if total else 0.0),
        "moves": diff or {"new": [], "exits": [],
                          "increased": [], "decreased": []},
    }


# --------------------------------------------------------------------------- #
# I/O SEC
# --------------------------------------------------------------------------- #

def _cik10(cik: Any) -> str:
    """CIK sur 10 chiffres (forme exigée par l'URL submissions)."""
    digits = re.sub(r"\D", "", str(cik or ""))
    return digits.rjust(10, "0")[-10:]


def fetch_submissions(cik: str, client=None,
                      pacer: Optional[_Pacer] = None) -> Dict[str, Any]:
    """Le JSON ``submissions`` du déposant (identité + derniers dépôts)."""
    url = SUBMISSIONS_URL.format(cik=_cik10(cik))
    resp = _http_get(url, client=client, pacer=pacer)
    try:
        data = resp.json()
    except Exception:                             # noqa: BLE001
        raise WhaleError("réponse SEC illisible (JSON invalide)")
    if not isinstance(data, dict):
        raise WhaleError("réponse SEC inattendue")
    return data


def latest_13f_accessions(subm: Dict[str, Any]) -> List[Tuple[str, str]]:
    """Les DEUX derniers trimestres 13F distincts : ``[(accession, reportDate)]``.

    Un trimestre peut avoir plusieurs dépôts (le ``13F-HR`` puis un
    ``13F-HR/A``) : pour une même ``reportDate`` on garde le dépôt à la
    ``filingDate`` la plus récente — l'amendement fait foi.
    """
    recent = ((subm or {}).get("filings") or {}).get("recent") or {}
    forms = recent.get("form") or []
    accs = recent.get("accessionNumber") or []
    filed = recent.get("filingDate") or []
    reported = recent.get("reportDate") or []

    best = {}  # type: Dict[str, Tuple[str, str]]
    for form, acc, fdate, rdate in zip(forms, accs, filed, reported):
        if not str(form or "").startswith("13F-HR"):
            continue
        if not acc or not rdate:
            continue
        current = best.get(rdate)
        # > et non >= : à filingDate égale, la première rencontrée gagne (les
        # tableaux SEC sont ordonnés du plus récemment ACCEPTÉ au plus ancien).
        if current is None or str(fdate or "") > current[1]:
            best[rdate] = (acc, str(fdate or ""))

    quarters = sorted(best.keys(), reverse=True)[:2]
    return [(best[q][0], q) for q in quarters]


def _xml_candidates(listing_html: str, base_url: str) -> List[str]:
    """URLs des .xml du dossier d'archive, les plus probables d'abord.

    L'infotable a un nom ARBITRAIRE : on ne peut pas la deviner. On se contente
    d'ordonner (``primary_doc.xml`` en dernier, il n'est jamais l'infotable) —
    la décision finale se prend sur le CONTENU, pas sur ce classement. Les
    chemins ``xsl…/`` sont écartés : ce sont les rendus HTML du viewer EDGAR,
    pas le XML brut.
    """
    hrefs = re.findall(r'href="([^"]+\.xml)"', listing_html or "",
                       flags=re.IGNORECASE)
    seen, primary, others = set(), [], []
    for href in hrefs:
        if "/xsl" in href.lower():
            continue
        url = urljoin(base_url, href)
        if url in seen:
            continue
        seen.add(url)
        (primary if href.lower().endswith("primary_doc.xml") else others).append(url)
    return others + primary


def _is_infotable(xml_text: str) -> bool:
    """Vrai si ce XML est bien une infotable 13F (décision par CONTENU)."""
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return False
    return (INFOTABLE_NS_MARK in str(root.tag).lower()
            or _local(root.tag) == "informationTable")


def _period_of(xml_text: str) -> Optional[str]:
    """``periodOfReport`` d'un ``primary_doc.xml`` (None si absent/illisible)."""
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return None
    value = _deep_text(root, "periodOfReport")
    return value or None


def fetch_infotable(cik: str, accession: str, client=None,
                    pacer: Optional[_Pacer] = None) -> Tuple[str, Optional[str]]:
    """Télécharge l'infotable d'un dépôt → ``(xml_text, periodOfReport|None)``.

    Le nom du fichier étant arbitraire, on liste le dossier puis on essaie au
    plus ``MAX_XML_CANDIDATES`` fichiers en testant leur CONTENU. Si l'un des
    candidats testés se révèle être le ``primary_doc.xml``, on en profite pour
    y lire ``periodOfReport`` — on ne le télécharge JAMAIS exprès (une requête
    SEC de plus par trimestre pour une information que ``reportDate`` donne
    déjà).
    """
    acc_nodash = re.sub(r"\D", "", accession or "")
    cik_int = str(int(_cik10(cik)))          # l'URL d'archive veut le CIK NU
    base = ARCHIVE_DIR_URL.format(cik=cik_int, accession=acc_nodash)
    listing = _http_get(base, client=client, pacer=pacer)
    candidates = _xml_candidates(getattr(listing, "text", "") or "", base)
    if not candidates:
        raise WhaleError("aucun XML dans le dossier d'archive")

    period = None
    for url in candidates[:MAX_XML_CANDIDATES]:
        resp = _http_get(url, client=client, pacer=pacer)
        text = getattr(resp, "text", "") or ""
        if _is_infotable(text):
            return text, period
        if period is None:
            period = _period_of(text)
    raise WhaleError("infotable introuvable dans le dépôt")


def manager_snapshot(manager: Dict[str, str], client=None,
                     sleep: Optional[Callable[[float], None]] = None) -> Dict[str, Any]:
    """Fiche complète d'un gérant : identité vérifiée, dernier trimestre agrégé
    et comparé au précédent.

    Trois issues possibles, jamais autre chose :
      * ``{"status": "ok", ...}`` ;
      * ``{"status": "unverified", ...}`` — le nom SEC ne contient pas le mot
        clé attendu : AUCUNE donnée n'est servie (jamais le portefeuille d'un
        autre sous ce nom) ;
      * ``{"status": "error", "detail": ...}`` — réseau, format, dépôt absent.
    """
    pacer = _Pacer(sleep)
    head = {"id": manager.get("id"), "label": manager.get("label"),
            "cik": _cik10(manager.get("cik"))}
    try:
        subm = fetch_submissions(manager.get("cik"), client=client, pacer=pacer)
        sec_name = str(subm.get("name") or "")
        expect = str(manager.get("expect") or "").lower()
        if not expect or expect not in sec_name.lower():
            out = dict(head)
            out.update({"status": "unverified", "sec_name": sec_name,
                        "expected": manager.get("expect")})
            return out

        accessions = latest_13f_accessions(subm)
        if not accessions:
            out = dict(head)
            out.update({"status": "error", "sec_name": sec_name,
                        "detail": "aucun dépôt 13F pour ce déposant"})
            return out

        cur_acc, cur_period = accessions[0]
        cur_xml, cur_doc_period = fetch_infotable(
            manager.get("cik"), cur_acc, client=client, pacer=pacer)
        cur_agg = aggregate(parse_infotable(cur_xml))

        prev_agg, prev_period = [], None
        if len(accessions) > 1:
            prev_acc, prev_period = accessions[1]
            prev_xml, _ = fetch_infotable(
                manager.get("cik"), prev_acc, client=client, pacer=pacer)
            prev_agg = aggregate(parse_infotable(prev_xml))

        # Sans trimestre précédent, TOUT paraîtrait « nouvellement acheté » —
        # ce serait un mensonge. On ne compare que ce qui est comparable.
        diff = (diff_quarters(cur_agg, prev_agg) if prev_agg
                else {"new": [], "exits": [], "increased": [], "decreased": []})

        out = dict(head)
        out.update(summarize(cur_agg, diff,
                             cur_period or cur_doc_period, prev_period))
        out.update({"status": "ok", "sec_name": sec_name,
                    "accession": cur_acc,
                    "has_previous": bool(prev_agg)})
        return out
    except WhaleError as exc:
        out = dict(head)
        out.update({"status": "error", "detail": _short(str(exc))})
        return out
    except Exception as exc:                      # noqa: BLE001 — jamais de 500
        out = dict(head)
        out.update({"status": "error", "detail": _short(type(exc).__name__)})
        return out


def _short(text: Any, limit: int = 160) -> str:
    """Message d'erreur court : l'UI affiche une phrase, pas une trace."""
    s = " ".join(str(text or "").split())
    return s[:limit]


# --------------------------------------------------------------------------- #
# Le coach ASSIMILE les mouvements des gérants (extension 2026-08-26)
#
# Demande de l'utilisateur : « ils peuvent voir quelque chose qu'on ne voit pas
# en VENDANT leurs actions ». Les VENTES sont donc le signal principal — c'est
# l'inverse de la lecture habituelle des 13F, qui ne regarde que les achats.
#
# ⚠️ Deux limites que le coach doit TOUJOURS énoncer : un 13F a jusqu'à 45 jours
# de retard sur la réalité, et une vente peut n'être qu'une rotation interne.
# On donne un indice, jamais une preuve.
# --------------------------------------------------------------------------- #

MOVES_SUMMARY_MAX = 30

# Les VENTES d'abord : ce sont elles qu'on cherche.
_MOVE_ORDER = (("exits", "sortie"), ("decreased", "allégé"),
               ("new", "nouveau"), ("increased", "renforcé"))

# Suffixes de forme juridique et de classe de titre — retirés avant de comparer
# deux noms d'émetteur. « APPLE INC » et « Apple Inc. » doivent se rejoindre.
_ISSUER_SUFFIXES = frozenset({
    "inc", "incorporated", "corp", "corporation", "co", "company", "plc",
    "ltd", "limited", "llc", "lp", "sa", "nv", "ag", "spa", "se", "holdings",
    "holding", "group", "the", "com", "cl", "class", "a", "b", "c",
    "new", "shs", "shares", "ord", "adr", "reit", "trust", "trusts",
})


def _issuer_tokens(name: Any) -> List[str]:
    """Tokens SIGNIFICATIFS d'un nom d'émetteur (PUR) : majuscules, ponctuation
    retirée, formes juridiques et classes de titre écartées."""
    raw = re.sub(r"[^A-Za-z0-9]+", " ", str(name or "")).upper()
    return [tok for tok in raw.split()
            if tok and tok.lower() not in _ISSUER_SUFFIXES]


def match_issuer(name: Any, candidates: Any) -> Optional[str]:
    """Le symbole dont le nom correspond à cet émetteur 13F, ou ``None`` (PUR).

    ``candidates`` = ``{symbole: nom}`` — les noms viennent de Yahoo et sont
    déjà stockés avec les positions et la watchlist ; on ne devine donc rien.

    Le rapprochement se fait sur les tokens SIGNIFICATIFS et jamais sur un mot
    générique seul (leçon du piège #31 du dépôt : « Deutsche » ne suffit pas à
    identifier « Deutsche Bank »). Concrètement il faut au moins un token
    commun, et ce token doit être distinctif — les formes juridiques et les
    classes de titre ont été retirées des deux côtés. Aucun candidat -> ``None``
    plutôt qu'un rapprochement approximatif : un move attribué au mauvais titre
    serait pire que pas de move du tout.
    """
    tokens = set(_issuer_tokens(name))
    if not tokens or not isinstance(candidates, dict):
        return None
    best, best_score = None, 0
    for symbol, label in candidates.items():
        if not symbol:
            continue
        other = set(_issuer_tokens(label))
        common = tokens & other
        if not common:
            continue
        score = len(common)
        if score > best_score:
            best, best_score = str(symbol), score
    return best


def moves_summary(cache: Any = None,
                  limit: int = MOVES_SUMMARY_MAX) -> List[Dict[str, Any]]:
    """Les mouvements du trimestre de TOUS les gérants, depuis le CACHE SEUL.

    Jamais de requête SEC ici : cette fonction est appelée à chaque fois que le
    coach réfléchit (idées, scénarios, revue de positions, radar). Elle doit
    donc être gratuite — c'est ``check_new_filings`` qui tient le cache au
    chaud, en tâche de fond.

    Tri : sorties, puis allégements, puis nouveautés, puis renforcements. Les
    deux premières familles sont LE signal recherché ; les deux autres sont du
    contexte. Cap global à ``limit``.
    """
    data = cache if isinstance(cache, dict) else _load_cache()
    try:
        limit = max(0, int(limit))
    except (TypeError, ValueError):
        limit = MOVES_SUMMARY_MAX

    buckets: Dict[str, List[Dict[str, Any]]] = {key: [] for key, _ in _MOVE_ORDER}
    for manager in MANAGERS:
        entry = data.get(manager["id"])
        if not isinstance(entry, dict):
            continue
        snap = entry.get("snapshot")
        if not isinstance(snap, dict) or snap.get("status") != "ok":
            continue
        moves = snap.get("moves")
        if not isinstance(moves, dict):
            continue
        for key, action in _MOVE_ORDER:
            for move in (moves.get(key) or []):
                if not isinstance(move, dict) or not move.get("name"):
                    continue
                row = {
                    "manager_id": manager["id"],
                    "manager_label": manager["label"],
                    "quarter": snap.get("quarter_label") or snap.get("quarter") or "",
                    "action": action,
                    "name": move.get("name"),
                    "class": move.get("class") or "",
                    "fetched_at": entry.get("fetched_at"),
                }
                if move.get("delta_pct") is not None:
                    row["delta_pct"] = move["delta_pct"]
                buckets[key].append(row)

    out: List[Dict[str, Any]] = []
    for key, _action in _MOVE_ORDER:
        for row in buckets[key]:
            if len(out) >= limit:
                return out
            out.append(row)
    return out


# --------------------------------------------------------------------------- #
# Persistance (cache 24 h + état du guetteur) — écriture ATOMIQUE 0o600
# --------------------------------------------------------------------------- #

def cache_path() -> Path:
    return DATA_DIR / "whales_cache.json"


def watch_path() -> Path:
    return DATA_DIR / "whales_watch.json"


def _atomic_write_json(path: Path, data: Any) -> None:
    """Patron obligatoire du dépôt : le temporaire NAÎT en 0o600 (``os.open``,
    pas de fenêtre world-readable), puis ``os.replace`` bascule d'un coup."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.parent / (".%s.tmp-%d" % (path.name, os.getpid()))
    fd = os.open(str(tmp_path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.fchmod(fd, 0o600)
    except (AttributeError, OSError):
        pass
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=2)
        os.replace(str(tmp_path), str(path))
    except Exception:
        try:
            os.remove(str(tmp_path))
        except OSError:
            pass
        raise


def _load_json(path: Path) -> Optional[Any]:
    """Lecture tolérante : absent ou corrompu → None (jamais d'exception).
    Un cache illisible n'est qu'un cache vide, il ne casse pas l'écran."""
    path = Path(path)
    if not path.is_file():
        return None
    try:
        with open(str(path), "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return None


def _load_cache() -> Dict[str, Any]:
    data = _load_json(cache_path())
    return data if isinstance(data, dict) else {}


# --------------------------------------------------------------------------- #
# API publique — snapshots (cache 24 h)
# --------------------------------------------------------------------------- #

def get_snapshot(manager_id: str, client=None, force: bool = False,
                 sleep: Optional[Callable[[float], None]] = None,
                 now: Optional[float] = None) -> Dict[str, Any]:
    """Fiche d'un gérant, servie par le cache 24 h quand il est frais.

    Politique du cache, dans cet ordre :
      1. cache frais et ``force`` absent → on le sert, zéro requête SEC ;
      2. sinon on interroge la SEC ; un ``status == "ok"`` est mis en cache ;
      3. si l'appel échoue et qu'un cache PÉRIMÉ existe → on sert le périmé
         avec ``stale: true`` : un blip SEC ne doit jamais vider l'écran.

    Seuls les snapshots ``ok`` sont mis en cache : un verdict ``unverified``
    (mauvais CIK) ou une erreur doivent être reconsidérés dès la requête
    suivante, sinon corriger un CIK resterait sans effet pendant 24 h.
    """
    manager = find_manager(manager_id)
    if manager is None:
        raise KeyError(manager_id)

    stamp = now if now is not None else _now()
    cache = _load_cache()
    entry = cache.get(manager_id) if isinstance(cache.get(manager_id), dict) else None
    cached_snap = (entry or {}).get("snapshot")
    cached_ts = (entry or {}).get("fetched_ts")
    try:
        cached_ts = float(cached_ts)
    except (TypeError, ValueError):
        cached_ts = None

    fresh = (cached_snap and cached_ts is not None
             and 0 <= (stamp - cached_ts) < CACHE_TTL_S)
    if fresh and not force:
        out = dict(cached_snap)
        out.update({"cached": True, "stale": False,
                    "fetched_at": (entry or {}).get("fetched_at")})
        return out

    snap = manager_snapshot(manager, client=client, sleep=sleep)
    if snap.get("status") == "ok":
        cache[manager_id] = {
            "fetched_at": datetime.fromtimestamp(stamp).isoformat(),
            "fetched_ts": stamp,
            "snapshot": snap,
        }
        try:
            _atomic_write_json(cache_path(), cache)
        except OSError:
            pass                                  # un cache non écrit n'invalide
                                                  # pas une donnée déjà obtenue
        out = dict(snap)
        out.update({"cached": False, "stale": False,
                    "fetched_at": datetime.fromtimestamp(stamp).isoformat()})
        return out

    if cached_snap:
        out = dict(cached_snap)
        out.update({"cached": True, "stale": True,
                    "fetched_at": (entry or {}).get("fetched_at"),
                    "refresh_error": snap.get("detail") or snap.get("status")})
        return out
    return snap


def list_managers() -> List[Dict[str, Any]]:
    """Catalogue + état du cache (l'UI sait quoi afficher avant tout fetch)."""
    cache = _load_cache()
    out = []
    for manager in MANAGERS:
        entry = cache.get(manager["id"])
        snap = entry.get("snapshot") if isinstance(entry, dict) else None
        item = {"id": manager["id"], "label": manager["label"],
                "cached": bool(snap)}
        if snap:
            item["quarter"] = snap.get("quarter")
            item["quarter_label"] = snap.get("quarter_label")
            item["fetched_at"] = entry.get("fetched_at")
        out.append(item)
    return out


# --------------------------------------------------------------------------- #
# API publique — guetteur de nouveaux dépôts EDGAR
# --------------------------------------------------------------------------- #

def form_explanation(form: str) -> str:
    """Ce que le formulaire veut dire, en une phrase — le lecteur n'a pas à
    connaître la nomenclature SEC pour comprendre l'alerte."""
    code = str(form or "").upper()
    if code.startswith("SC 13D"):
        return "13D : franchissement des 5 % d'une société (position activiste)"
    if code.startswith("SC 13G"):
        return "13G : franchissement des 5 % (position passive)"
    if code.startswith("13F-HR"):
        return ("13F : portefeuille trimestriel complet publié — "
                "l'onglet Grands portefeuilles est à rafraîchir")
    if code.startswith("4"):
        return ("Form 4 : transaction d'initié/gros actionnaire "
                "(le trade date d'il y a <= 2 jours ouvrés)")
    return "Nouveau dépôt SEC"


# --- PUR : âge d'un dépôt et mémoire « déjà vu » --------------------------- #

def _as_datetime(value: Any) -> datetime:
    """Normalise une horloge : ``datetime`` tel quel, epoch -> ``datetime``.
    Valeur illisible -> maintenant (on ne fabrique jamais une date arbitraire
    qui fausserait un calcul d'âge)."""
    if isinstance(value, datetime):
        return value
    try:
        return datetime.fromtimestamp(float(value))
    except (TypeError, ValueError, OverflowError, OSError):
        return datetime.fromtimestamp(_now())


def _parse_filing_date(value: Any) -> Optional[datetime]:
    """``2026-08-21`` (forme EDGAR) -> ``datetime``. Illisible/absent -> None."""
    text = str(value or "").strip()
    if len(text) < 10:
        return None
    try:
        return datetime.strptime(text[:10], "%Y-%m-%d")
    except ValueError:
        return None


def is_stale_filing(filing_date: Any, now: Any,
                    max_age_days: int = NOTIFY_MAX_AGE_D) -> bool:
    """Ce dépôt est-il trop VIEUX pour mériter une alerte ? (PUR)

    Une date ILLISIBLE rend ``False`` : on ne peut pas PROUVER l'ancienneté, et
    museler sur un doute ferait taire une vraie alerte. Une date dans le futur
    (horloge décalée, fixture de test) n'est pas « vieille » non plus.

    La comparaison se fait au JOUR : une ``filingDate`` EDGAR n'a pas d'heure,
    comparer un minuit contre l'heure courante rendrait le verdict dépendant de
    l'heure à laquelle le guetteur tourne (un dépôt « de 14 jours » serait
    périmé à 09:02 et frais à 00:01).
    """
    when = _parse_filing_date(filing_date)
    if when is None:
        return False
    cutoff = (_as_datetime(now) - timedelta(days=max_age_days)).replace(
        hour=0, minute=0, second=0, microsecond=0)
    return when < cutoff


def prune_seen(filings: List[Dict[str, str]], now: Any,
               recent_days: int = SEEN_RECENT_D,
               cap: int = MAX_SEEN_PER_MANAGER) -> List[str]:
    """Les accessions à retenir comme « déjà vues » pour un gérant (PUR).

    ``filings`` arrive dans l'ordre SEC (du plus récent au plus ancien). On
    garde **toutes** celles dont le dépôt a moins de ``recent_days`` jours — ce
    sont les seules qu'un oubli pourrait faire re-notifier — puis on complète
    avec les plus récentes des anciennes jusqu'au plafond ``cap``.
    """
    now_dt = _as_datetime(now)
    recent, older = [], []
    for filing in filings or []:
        accession = str((filing or {}).get("accession") or "")
        if not accession:
            continue
        if is_stale_filing((filing or {}).get("filing_date"), now_dt, recent_days):
            older.append(accession)
        else:
            recent.append(accession)
    room = cap - len(recent)
    return recent + (older[:room] if room > 0 else [])


def _notification_text(manager: Dict[str, str], form: str,
                       filing_date: str) -> str:
    """Texte SOBRE (aucun emoji) : l'alerte doit se lire, pas se décorer."""
    url = BROWSE_URL.format(cik=_cik10(manager.get("cik")),
                            form=quote_plus(str(form or "")))
    return ("[Simulateur] Nouveau dépôt SEC — %s\n%s\nDépôt du %s. Détail : %s"
            % (manager.get("label"), form_explanation(form),
               filing_date or "?", url))


def _load_watch_state() -> Dict[str, Any]:
    """État du guetteur. Fichier absent OU corrompu → état neuf : le guetteur
    repart de zéro (donc re-seed silencieux) plutôt que de planter.

    Les cinq clés des volets du 26/08 (``own_*`` pour les dépôts des titres de
    l'utilisateur, ``agenda_*`` pour les banques centrales) suivent la même
    règle que les trois anciennes : mal typées ou absentes — donc y compris
    dans un état écrit AVANT elles — elles repartent vides. Aucune migration à
    écrire, et le pire qui arrive est un amorçage muet de plus.
    """
    data = _load_json(watch_path())
    if not isinstance(data, dict):
        data = {}

    def _dict(key: str) -> Dict[str, Any]:
        value = data.get(key)
        return value if isinstance(value, dict) else {}

    events = data.get("events")
    return {
        "seen": _dict("seen"),
        "seeded": _dict("seeded"),
        "events": events if isinstance(events, list) else [],
        "own_seen": _dict("own_seen"),
        "own_seeded": _dict("own_seeded"),
        "own_cursor": data.get("own_cursor"),
        "agenda_seen": _dict("agenda_seen"),
        "agenda_seeded": bool(data.get("agenda_seeded")),
    }


def _watched_filings(subm: Dict[str, Any]) -> List[Dict[str, str]]:
    """Dépôts suivis, du plus récent au plus ancien (ordre SEC préservé)."""
    recent = ((subm or {}).get("filings") or {}).get("recent") or {}
    forms = recent.get("form") or []
    accs = recent.get("accessionNumber") or []
    filed = recent.get("filingDate") or []
    out = []
    for form, acc, fdate in zip(forms, accs, filed):
        if str(form or "") not in WATCHED_FORMS or not acc:
            continue
        out.append({"form": str(form), "accession": str(acc),
                    "filing_date": str(fdate or "")})
    return out


def stalest_manager(cache: Any, now_ts: float,
                    ttl_s: float = CACHE_TTL_S) -> Optional[str]:
    """Le gérant dont le snapshot est le PLUS périmé, ou ``None`` si tous sont
    frais (PUR).

    Un gérant jamais récupéré passe en premier (âge infini) : c'est le seul
    moyen pour le cache de se remplir tout seul sur une installation neuve.
    Sert la rotation douce de ``check_new_filings`` — UN gérant par cycle, donc
    aucune rafale à la SEC, jamais.

    ⚠️ **Ce que coûtent les six gérants internationaux du 26/08** : la rotation
    reste d'UN par cycle (le pacing ne bouge pas d'un pouce), mais un tour
    complet passe de dix à SEIZE cycles — soit, au rythme de 30 minutes du
    planificateur, **environ huit heures** au lieu de cinq. C'est le seul prix
    payé, et il est payé par la fraîcheur du cache, pas par la SEC : un
    snapshot peut donc dater de huit heures au lieu de cinq. Sans conséquence
    ici — un 13F ne bouge qu'une fois par trimestre, et un 13F qui vient de
    tomber court-circuite la rotation (cf. ``_warm_cache``, règle 1).
    """
    data = cache if isinstance(cache, dict) else {}
    worst, worst_age = None, None
    for manager in MANAGERS:
        entry = data.get(manager["id"])
        stamp = (entry or {}).get("fetched_ts") if isinstance(entry, dict) else None
        try:
            age = now_ts - float(stamp)
        except (TypeError, ValueError):
            age = float("inf")                    # jamais récupéré : priorité
        if age < ttl_s:
            continue
        if worst_age is None or age > worst_age:
            worst, worst_age = manager["id"], age
    return worst


def _warm_cache(manager_ids: Any, cache: Any, stamp: float, client,
                sleep: Optional[Callable[[float], None]],
                counters: Dict[str, Any]) -> None:
    """Tient les snapshots au chaud SANS l'interface (26/08).

    Avant cette extension, un snapshot n'était calculé que lorsqu'un humain
    ouvrait l'écran des grands portefeuilles. Le coach, lui, réfléchit la nuit :
    il aurait lu un cache vide. Deux règles, dans cet ordre :

    1. un dépôt 13F FRAIS vient d'être détecté pour un gérant -> son snapshot
       est recalculé tout de suite (c'est précisément là que ses mouvements
       changent) ;
    2. sinon, UN SEUL gérant par cycle : le plus périmé au-delà de 24 h.

    Best-effort intégral : la SEC muette ne doit jamais faire échouer la ronde
    des dépôts, qui a déjà fait son travail quand on arrive ici.
    """
    targets = [mid for mid in (manager_ids or [])]
    if not targets:
        stale = stalest_manager(cache, stamp)
        if stale:
            targets = [stale]
    for manager_id in targets:
        try:
            get_snapshot(manager_id, client=client, force=True, sleep=sleep,
                         now=stamp)
        except Exception:                          # noqa: BLE001 — best-effort
            counters["errors"] += 1


def _fire_convergence(tg_cfg: Optional[Dict[str, Any]] = None,
                      notifier: Optional[Callable[..., Any]] = None,
                      converge: Optional[Callable[..., Any]] = None,
                      counters: Optional[Dict[str, Any]] = None) -> bool:
    """Consulte la couche de convergence — best-effort STRICT (même patron que
    ``radar._fire_convergence`` et ``newswatch._fire_convergence``).

    Appelée APRÈS l'écriture de l'état : la convergence relit ce fichier, elle
    doit voir les dépôts que la ronde vient de découvrir. Tant que
    ``convergence.should_fire`` refuse (moins de deux facteurs, cooldown, même
    matière), l'appel ne fait que de la lecture locale — aucun modèle, aucun
    réseau.
    """
    try:
        if converge is not None:
            result = converge(notifier=notifier, tg_cfg=tg_cfg)
        else:
            from backend.bots.paper import convergence
            result = convergence.maybe_fire(notifier=notifier, tg_cfg=tg_cfg)
    except Exception:                              # noqa: BLE001
        logger.warning("paper whales: convergence indisponible")
        if counters is not None:
            counters["errors"] += 1
        return False
    result = result if isinstance(result, dict) else {}
    if counters is not None and result.get("sent"):
        counters["notified"] += 1
    return bool(result.get("fired"))


# --------------------------------------------------------------------------- #
# Volet « SES titres » — les 8-K des ancres de l'utilisateur (26/08)
#
# Le guetteur savait dire « Buffett a déposé quelque chose » et restait MUET sur
# « ta position vient de publier un événement matériel » — alors que c'est ce
# second cas qui bouge son argent. Même infrastructure EDGAR, même pacing, même
# ronde : un volet de plus, pas un second guetteur.
#
# Formulaires suivis et ce qu'ils veulent dire :
#   8-K    l'entreprise SIGNALE un événement matériel (fusion, départ du
#          directeur général, perte d'un contrat, résultats préliminaires) —
#          c'est le formulaire « il vient de se passer quelque chose » ;
#   10-Q   le trimestre ; 10-K l'année ; 6-K l'équivalent d'un 8-K pour un
#          émetteur ÉTRANGER coté aux États-Unis (sans lui, un ADR européen
#          n'émettrait jamais rien).
#
# ⚠️ Ce volet ne connaît que les titres cotés aux ÉTATS-UNIS : la table de
# correspondance est celle de la SEC. Un ``NESN.SW`` n'y est pas, et c'est
# normal — il est compté (``own_non_us``) puis SAUTÉ en silence, jamais signalé
# comme une erreur.
# --------------------------------------------------------------------------- #

# Mesuré le 26/08 : 200 OK, 10 388 entrées de la forme
# ``{"0": {"cik_str": 320193, "ticker": "AAPL", "title": "Apple Inc."}, ...}``.
# User-Agent maison obligatoire, comme partout chez la SEC.
TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"
# Sept jours : une introduction en bourse ou un changement de symbole n'a pas
# besoin d'être connu à l'heure, et re-télécharger 220 Ko toutes les 30 minutes
# pour une table qui bouge une fois par semaine serait grossier.
TICKERS_TTL_S = 7 * 24 * 3600.0

# Page de consultation HUMAINE d'un dépôt précis (l'index du dossier). Vérifiée
# le 26/08 : 200 sur ``0000320193-26-000018`` (8-K Apple du 30 juillet).
FILING_INDEX_URL = ("https://www.sec.gov/Archives/edgar/data/{cik}/{nodash}/"
                    "{accession}-index.htm")

OWN_FORMS = frozenset({"8-K", "8-K/A", "10-Q", "10-K", "6-K"})
# Même garde d'âge que les dépôts de gérants : un 8-K de l'an dernier n'est pas
# une nouvelle (cf. l'incident du 25/08 en tête de fichier).
OWN_MAX_AGE_D = 14
# Une à deux ancres par cycle. Le pacing d'une seconde s'applique à ces requêtes
# comme aux autres : deux ancres = deux secondes de plus, et un portefeuille de
# vingt titres est balayé en dix cycles (cinq heures au rythme du
# planificateur). Monter ce chiffre, c'est marteler la SEC pour gagner des
# minutes sur une information qui reste vraie quatorze jours.
OWN_PER_CYCLE = 2
MAX_OWN_NOTIFY_PER_SYMBOL = 2


def tickers_path() -> Path:
    # ⚠️ Le POINT dans le nom est STRUCTUREL, pas cosmétique : les fichiers de
    # ce dossier sont recensés comme des COMPTES par
    # ``radar._users_with_portfolio`` (regex ``^[A-Za-z0-9_-]+\.json$``) et la
    # convergence écrit un carnet à chacun. Un ``edgar_tickers.json`` créerait
    # donc un utilisateur fantôme « edgar_tickers » — exactement le bug déjà
    # payé deux fois par le dépôt (``alerts_mode``/``x_accounts``, puis
    # ``backfill``), rattrapé chaque fois par une liste d'exclusion qu'il faut
    # penser à tenir. Un radical qui porte un point ne peut PAS matcher.
    return DATA_DIR / "edgar.tickers.json"


def parse_ticker_map(payload: Any) -> Dict[str, str]:
    """``company_tickers.json`` → ``{SYMBOLE: CIK sur 10 chiffres}`` (PUR).

    Les deux formes sont acceptées : le dictionnaire indexé par rang que la SEC
    sert aujourd'hui, et une liste à la racine (au cas où elle changerait d'avis
    — le contenu de chaque entrée, lui, est ce qui fait foi).

    Une entrée sans symbole ou sans CIK est ignorée. Le PREMIER symbole
    rencontré gagne : la table est ordonnée par capitalisation décroissante, et
    en cas de doublon c'est le gros émetteur qu'on veut.
    """
    rows = payload.values() if isinstance(payload, dict) else payload
    out: Dict[str, str] = {}
    for row in rows or []:
        if not isinstance(row, dict):
            continue
        symbol = str(row.get("ticker") or "").strip().upper()
        digits = re.sub(r"\D", "", str(row.get("cik_str") or ""))
        if not symbol or not digits:
            continue
        out.setdefault(symbol, _cik10(digits))
    return out


def load_ticker_map(client=None, pacer: Optional[_Pacer] = None,
                    now: Optional[float] = None,
                    force: bool = False) -> Dict[str, str]:
    """La table symbole → CIK, servie par un cache 7 jours.

    Même politique que ``get_snapshot`` : cache frais → zéro requête ; sinon on
    télécharge ; échec avec un cache périmé → on sert le périmé. Une table d'il
    y a huit jours reste juste pour 10 387 symboles sur 10 388.

    Ne lève jamais : sans table, le volet « ses titres » se tait, il ne casse
    pas la ronde.
    """
    stamp = now if now is not None else _now()
    cached = _load_json(tickers_path())
    cached = cached if isinstance(cached, dict) else {}
    rows = cached.get("map") if isinstance(cached.get("map"), dict) else {}
    try:
        cached_ts = float(cached.get("fetched_ts"))
    except (TypeError, ValueError):
        cached_ts = None

    fresh = (rows and cached_ts is not None
             and 0 <= (stamp - cached_ts) < TICKERS_TTL_S)
    if fresh and not force:
        return dict(rows)

    try:
        resp = _http_get(TICKERS_URL, client=client, pacer=pacer)
        payload = resp.json()
    except Exception:                             # noqa: BLE001 — best-effort
        return dict(rows)                         # périmé > vide

    fetched = parse_ticker_map(payload)
    if not fetched:
        return dict(rows)
    try:
        _atomic_write_json(tickers_path(),
                           {"fetched_ts": stamp,
                            "fetched_at": datetime.fromtimestamp(stamp).isoformat(),
                            "map": fetched})
    except OSError:
        pass
    return fetched


def _paper_users() -> List[str]:
    """Les comptes du simulateur — MÊME liste que la convergence et le radar.

    Source unique volontaire : deux listes divergentes iraient chercher les
    ancres de gens différents.
    """
    try:
        from backend.bots.paper import radar
        return list(radar._users_with_portfolio() or [])
    except Exception:                             # noqa: BLE001
        return []


def own_anchors() -> List[str]:
    """Les titres de l'utilisateur : positions ∪ watchlist ∪ pipeline.

    Ordre de première apparition, et cet ordre a un sens : les POSITIONS
    d'abord (l'argent engagé), puis la watchlist, puis le pipeline. La rotation
    étant circulaire, tout finit par passer — mais quand le cycle est coupé
    (redémarrage), c'est le début de la liste qui a été servi.

    Best-effort par compte ET par source : un fichier illisible rétrécit la
    liste, il ne casse jamais la ronde.
    """
    symbols: List[str] = []
    seen = set()

    def _add(value: Any) -> None:
        symbol = str(value or "").strip().upper()
        if symbol and symbol not in seen:
            seen.add(symbol)
            symbols.append(symbol)

    try:
        from backend.bots.paper import board, store
    except Exception:                             # noqa: BLE001
        return []

    for username in _paper_users():
        try:
            portfolio = store.load_portfolio(username) or {}
            for position in (portfolio.get("positions") or []):
                if isinstance(position, dict):
                    _add(position.get("symbol"))
        except Exception:                         # noqa: BLE001
            pass
        try:
            for row in (store.load_watchlist(username) or []):
                if isinstance(row, dict):
                    _add(row.get("symbol"))
        except Exception:                         # noqa: BLE001
            pass
        try:
            for row in board.load_board(username).get("pipeline") or []:
                if isinstance(row, dict):
                    _add(row.get("symbol"))
        except Exception:                         # noqa: BLE001
            pass
    return symbols


def next_own_targets(anchors: Any, cursor: Any,
                     per_cycle: int = OWN_PER_CYCLE) -> Tuple[List[str], int]:
    """``(les ancres de CE cycle, le curseur suivant)`` — rotation circulaire
    (PUR).

    Le curseur vit dans l'état du guetteur : sans lui, chaque cycle rebalaierait
    les deux mêmes titres et le troisième ne serait jamais interrogé. Un curseur
    illisible ou hors bornes repart de zéro plutôt que de planter.
    """
    rows = [str(a or "").strip().upper() for a in (anchors or [])]
    rows = [a for a in rows if a]
    if not rows:
        return [], 0
    try:
        start = int(cursor)
    except (TypeError, ValueError):
        start = 0
    if start < 0 or start >= len(rows):
        start = 0
    try:
        take = max(0, int(per_cycle))
    except (TypeError, ValueError):
        take = OWN_PER_CYCLE
    take = min(take, len(rows))
    picked = [rows[(start + i) % len(rows)] for i in range(take)]
    return picked, (start + take) % len(rows)


def own_form_explanation(form: str) -> str:
    """Ce que le formulaire veut dire, en trois mots — le titre de l'alerte le
    porte, pour que « 8-K » ne reste pas un code."""
    code = str(form or "").upper()
    if code.startswith("8-K"):
        return "événement matériel"
    if code.startswith("10-Q"):
        return "rapport trimestriel"
    if code.startswith("10-K"):
        return "rapport annuel"
    if code.startswith("6-K"):
        return "rapport d'émetteur étranger"
    return "dépôt SEC"


def _own_filings(subm: Dict[str, Any]) -> List[Dict[str, str]]:
    """Dépôts de ``OWN_FORMS``, du plus récent au plus ancien (ordre SEC)."""
    recent = ((subm or {}).get("filings") or {}).get("recent") or {}
    forms = recent.get("form") or []
    accs = recent.get("accessionNumber") or []
    filed = recent.get("filingDate") or []
    out = []
    for form, acc, fdate in zip(forms, accs, filed):
        if str(form or "") not in OWN_FORMS or not acc:
            continue
        out.append({"form": str(form), "accession": str(acc),
                    "filing_date": str(fdate or "")})
    return out


def filing_index_url(cik: Any, accession: Any) -> str:
    """Le lien vers l'index du dépôt — la page que Massii ouvre pour LIRE le
    8-K. Forme vérifiée le 26/08 (200 sur un dépôt Apple réel)."""
    acc = str(accession or "")
    return FILING_INDEX_URL.format(cik=str(int(_cik10(cik))),
                                   nodash=re.sub(r"\D", "", acc),
                                   accession=acc)


def own_event_title(symbol: str, form: str) -> str:
    """« AAPL — 8-K déposé (événement matériel) »."""
    return "%s — %s déposé (%s)" % (str(symbol or "").upper(), form,
                                    own_form_explanation(form))


# Ce que le formulaire veut dire pour QUELQU'UN QUI DÉTIENT LE TITRE — une
# phrase, pas la nomenclature SEC. ⚠️ Ne pas réutiliser ``form_explanation`` ici
# (celle des gérants) : elle ne connaît que les 13F/13D/13G/4 et rendrait
# « Nouveau dépôt SEC » pour un 8-K, c'est-à-dire une ligne qui n'apprend rien.
_OWN_FORM_NOTES = (
    ("8-K", "L'entreprise signale elle-même un événement qu'elle juge "
            "important : fusion, changement de dirigeant, gros contrat, "
            "chiffres préliminaires."),
    ("10-Q", "Comptes du trimestre."),
    ("10-K", "Comptes de l'année."),
    ("6-K", "Communication d'un émetteur étranger coté aux États-Unis "
            "(l'équivalent d'un 8-K)."),
)


def own_form_note(form: str) -> str:
    """La phrase d'explication du formulaire, pour un porteur du titre."""
    code = str(form or "").upper()
    for prefix, note in _OWN_FORM_NOTES:
        if code.startswith(prefix):
            return note
    return "Nouveau dépôt auprès de la SEC."


def _own_notification_text(symbol: str, form: str, filing_date: str,
                           link: str) -> str:
    """Texte SOBRE (aucun emoji), même forme que l'alerte des gérants."""
    return ("[Simulateur] Dépôt SEC sur un de tes titres — %s\n%s\n"
            "Dépôt du %s. Détail : %s"
            % (own_event_title(symbol, form), own_form_note(form),
               filing_date or "?", link))


# --------------------------------------------------------------------------- #
# Volet AGENDA — les rendez-vous des banques centrales (26/08)
#
# Un catalyseur DATÉ vaut plus qu'une rumeur : c'est la seule matière du
# contexte sur laquelle on peut construire un « avant / pendant / après ». Les
# dates viennent du moteur Market Pulse (``agenda_bridge``), qui les tient déjà
# à jour pour le briefing — on ne réécrit aucun parseur.
#
# ⚠️ L'événement écrit ici porte ``src: "eco"`` et NON ``src: "agenda"``. Ce
# n'est pas une approximation : c'est ``src`` qui décide où la toile le range.
# « eco » le fait atterrir sous le pivot « monde », famille macroéconomie —
# exactement là où doit vivre une réunion de banque centrale. Un ``src``
# inconnu tomberait dans la famille « presse », et comme l'événement ne nomme
# aucun titre, la toile l'OMETTRAIT purement et simplement (règle 5 de
# ``graph._dispatch`` : une dépêche qu'on ne sait rattacher à rien n'est pas une
# connexion). Le champ ``agenda: True`` reste là pour le reconnaître.
#
# ⚠️ Et il porte un lien VIDE, alors qu'on en a un. La mémoire dédoublonne par
# lien ; or deux réunions de la Fed partagent la même page de calendrier —
# écrire ce lien fusionnerait la réunion de septembre avec celle d'octobre. Le
# lien vérifiable voyage donc dans le message Telegram, où il ne dédoublonne
# rien.
# --------------------------------------------------------------------------- #

AGENDA_HORIZON_D = 7
MAX_AGENDA_NOTIFY = 3


def agenda_event_key(row: Any) -> str:
    """La clé de dédoublonnage d'un rendez-vous : ``banque|date`` (PUR).

    Ni le libellé (le moteur peut le reformuler d'une version à l'autre) ni le
    lien (partagé par toutes les réunions d'une même banque) : la banque et le
    jour, c'est ce qui identifie un rendez-vous.
    """
    if not isinstance(row, dict):
        return ""
    bank = str(row.get("bank") or "").strip().lower()
    date = str(row.get("date") or "").strip()[:10]
    if not bank or len(date) != 10:
        return ""
    return "%s|%s" % (bank, date)


def _agenda_notification_text(row: Dict[str, Any]) -> str:
    """Texte SOBRE. Le lien de la source y figure : c'est ici, et pas dans la
    mémoire, qu'il sert (cf. le bloc ci-dessus)."""
    link = str(row.get("source_url") or "").strip()
    base = ("[Simulateur] Rendez-vous macro — %s\nLe %s."
            % (row.get("label"), row.get("date")))
    return base + ("\nSource : %s" % link if link else "")


def _upcoming_agenda(agenda: Optional[Callable[..., Any]],
                     now_dt: datetime) -> List[Dict[str, Any]]:
    """Les rendez-vous à moins de ``AGENDA_HORIZON_D`` jours — best-effort
    strict (même patron que ``_fire_convergence``)."""
    try:
        if agenda is not None:
            rows = agenda(now=now_dt, horizon_days=AGENDA_HORIZON_D)
        else:
            from backend.bots.paper import agenda_bridge
            rows = agenda_bridge.upcoming_events(now=now_dt,
                                                 horizon_days=AGENDA_HORIZON_D)
    except Exception:                             # noqa: BLE001
        logger.warning("paper whales: agenda indisponible")
        return []
    return [row for row in (rows or []) if isinstance(row, dict)]


# --------------------------------------------------------------------------- #
# La MÉMOIRE partagée — où atterrissent les deux nouveaux volets
#
# Les événements de ces volets ne vont PAS dans le journal des dépôts
# (``whales_watch.json``), qui n'est lu que par l'écran des grands
# portefeuilles. Ils vont dans la mémoire de la VEILLE (l'état global de
# ``newswatch``), parce que c'est elle — et elle seule — que lisent les trois
# consommateurs qu'on vise : le contexte du coach
# (``paper_router._recent_news``), la toile (``_graph_inputs``) et la
# convergence (``convergence._collect_news``). Écrire ailleurs aurait obligé à
# ouvrir un quatrième lecteur dans chacun des trois.
#
# ⚠️ Deux processus écrivent donc ce fichier : la veille (toutes les 5 min) et
# cette ronde (toutes les 30 min). L'écriture est atomique de chaque côté, mais
# rien n'empêche une lecture-modification-écriture d'en écraser une autre. La
# fenêtre est de quelques millisecondes contre plusieurs secondes de collecte
# réseau côté veille, et la conséquence maximale est de perdre un événement.
# On la rend RÉCUPÉRABLE plutôt que de la nier : l'état « déjà vu » n'est écrit
# qu'après une mémorisation RÉUSSIE, donc un événement perdu revient au cycle
# suivant au lieu d'être marqué vu et oublié. Et si l'inverse arrive (mémoire
# écrite, état du guetteur perdu), le doublon se referme tout seul en aval :
# les deux consommateurs dédoublonnent par lien, ou à défaut par le couple
# symbole+titre — identiques dans les deux cas.
#
# ⚠️ Cette mémoire est GLOBALE (comme les volets politique, éco, climat, crypto
# et X de la veille) : les événements ne sont pas rangés par compte. C'est
# volontaire et cohérent avec le reste du simulateur, mono-utilisateur en
# pratique, dont les ancres sont déjà additionnées tous comptes confondus
# (``own_anchors``, ``convergence._collect_positions``).
# --------------------------------------------------------------------------- #

def remember_events(events: List[Dict[str, Any]]) -> bool:
    """Range ces événements en tête de la mémoire de la veille.

    Rend ``True`` si l'écriture a eu lieu — c'est ce booléen qui autorise
    l'appelant à marquer les dépôts « vus » (cf. le bloc ci-dessus).
    """
    if not events:
        return True
    try:
        from backend.bots.paper import newswatch
        state = newswatch._load_global_seen()
        cap = getattr(newswatch, "_MAX_EVENTS", MAX_EVENTS)
        existing = state.get("events")
        state["events"] = (list(events)
                           + (existing if isinstance(existing, list) else []))[:cap]
        newswatch._save_global_seen(state)
        return True
    except Exception:                             # noqa: BLE001 — best-effort
        logger.warning("paper whales: mémoire de la veille non écrite")
        return False


def _run_own_volet(state: Dict[str, Any], now_dt: datetime, when: str,
                   quiet: bool, notifier, cfg, client,
                   pacer: _Pacer,
                   counters: Dict[str, Any]) -> Tuple[List[Dict[str, Any]],
                                                      Optional[Dict[str, Any]]]:
    """Le volet « ses titres » d'un cycle.

    Rend ``(événements à mémoriser, état à valider)``. L'état n'est PAS écrit
    ici : l'appelant ne le validera qu'une fois la mémorisation réussie, sinon
    un dépôt perdu serait marqué vu et jamais revu (cf. le bloc « MÉMOIRE
    partagée »).

    Aucune ancre → zéro requête, pas même la table des symboles : un compte
    vide ne doit rien coûter à la SEC.
    """
    anchors = own_anchors()
    if not anchors:
        return [], None
    targets, cursor = next_own_targets(anchors, state.get("own_cursor"))
    if not targets:
        return [], None

    ticker_map = load_ticker_map(client=client, pacer=pacer,
                                 now=now_dt.timestamp())
    pending_seen: Dict[str, List[str]] = {}
    pending_seeded: Dict[str, bool] = {}
    fresh: List[Dict[str, Any]] = []

    for symbol in targets:
        cik = ticker_map.get(symbol)
        if not cik:
            # Ni une erreur ni un silence : un titre hors des États-Unis n'est
            # tout simplement pas dans le registre de la SEC.
            counters["own_non_us"] += 1
            continue
        try:
            subm = fetch_submissions(cik, client=client, pacer=pacer)
            filings = _own_filings(subm)
        except Exception:                          # noqa: BLE001 — un titre HS
            counters["errors"] += 1                # ne doit pas tuer la ronde
            continue

        counters["own_checked"] += 1
        seen = set(state["own_seen"].get(symbol) or [])
        new_ones = [f for f in filings if f["accession"] not in seen]

        if not state["own_seeded"].get(symbol):
            pending_seeded[symbol] = True          # amorçage muet
        elif new_ones:
            handled = 0
            for filing in new_ones:
                if is_stale_filing(filing["filing_date"], now_dt, OWN_MAX_AGE_D):
                    continue
                if handled >= MAX_OWN_NOTIFY_PER_SYMBOL:
                    break
                handled += 1
                counters["own_filings"] += 1
                link = filing_index_url(cik, filing["accession"])
                event = {
                    "ts": when, "symbol": symbol,
                    "title": own_event_title(symbol, filing["form"]),
                    "link": link, "sentiment": "watch", "src": "sec_own",
                    "form": filing["form"], "accession": filing["accession"],
                    "filing_date": filing["filing_date"], "muted": True,
                }
                fresh.append(event)
                if quiet:
                    # Mode calme : la détection reste entière (mémoire, toile,
                    # convergence), seul l'envoi disparaît.
                    continue
                try:
                    notifier(_own_notification_text(
                        symbol, filing["form"], filing["filing_date"], link), cfg)
                    counters["notified"] += 1
                    event["muted"] = False
                except Exception:                  # noqa: BLE001 — best-effort
                    pass

        pending_seen[symbol] = prune_seen(filings, now_dt)

    return fresh, {"seen": pending_seen, "seeded": pending_seeded,
                   "cursor": cursor}


def _run_agenda_volet(state: Dict[str, Any], now_dt: datetime, when: str,
                      quiet: bool, notifier, cfg, counters: Dict[str, Any],
                      agenda: Optional[Callable[..., Any]] = None
                      ) -> Tuple[List[Dict[str, Any]], Optional[Dict[str, Any]]]:
    """Le volet « agenda » d'un cycle — même contrat de retour que le précédent.

    La mémoire des rendez-vous déjà vus est REMPLACÉE par ceux de l'horizon
    courant : un rendez-vous qui sort de la fenêtre a eu lieu, il ne peut plus
    revenir (une date passée ne ressort jamais de ``agenda_bridge``). La
    mémoire se purge donc toute seule et reste bornée par l'horizon.

    Une collecte VIDE laisse la mémoire intacte : cinq banques centrales muettes
    en même temps est un incident de réseau, et repartir de zéro rejouerait tous
    les rendez-vous au cycle suivant.
    """
    rows = _upcoming_agenda(agenda, now_dt)
    if not rows:
        return [], None

    seen = state["agenda_seen"]
    seeded = bool(state.get("agenda_seeded"))
    pending: Dict[str, str] = {}
    fresh: List[Dict[str, Any]] = []
    handled = 0

    for row in rows:
        key = agenda_event_key(row)
        if not key:
            continue
        pending[key] = str(row.get("date") or "")
        if not seeded or key in seen or handled >= MAX_AGENDA_NOTIFY:
            continue
        handled += 1
        counters["agenda_events"] += 1
        event = {
            "ts": when,
            # Pas de symbole : une réunion de banque centrale ne nomme aucun
            # titre, elle concerne tout le portefeuille. C'est ce qui la range
            # sous le pivot « monde » de la toile.
            "symbol": None,
            "title": str(row.get("label") or ""),
            # Lien VIDE À DESSEIN — cf. le bloc « volet AGENDA ».
            "link": "", "sentiment": "watch", "src": "eco",
            "agenda": True, "bank": row.get("bank"), "date": row.get("date"),
            "muted": True,
        }
        fresh.append(event)
        if quiet:
            continue
        try:
            notifier(_agenda_notification_text(row), cfg)
            counters["notified"] += 1
            event["muted"] = False
        except Exception:                          # noqa: BLE001 — best-effort
            pass

    return fresh, {"seen": pending, "seeded": True}


def check_new_filings(client=None, notifier=None, tg_cfg=None,
                      sleep: Optional[Callable[[float], None]] = None,
                      now: Optional[float] = None,
                      mode: Optional[str] = None,
                      converge: Optional[Callable[..., Any]] = None,
                      warm: bool = True,
                      agenda: Optional[Callable[..., Any]] = None) -> Dict[str, Any]:
    """Guette les nouveaux dépôts EDGAR des gérants du catalogue.

    Retourne ``{managers, new_filings, notified, errors}`` — plus, depuis le
    26/08, ``own_checked``/``own_filings``/``own_non_us`` (volet « ses titres »)
    et ``agenda_events`` (volet « banques centrales »).

    Quatre garde-fous :
      * **Telegram non configuré → zéro requête réseau** (la fonction sort
        immédiatement) : une fonctionnalité éteinte ne consomme rien et ne
        martèle pas la SEC ;
      * **premier passage d'un gérant → tout est marqué vu, RIEN n'est
        notifié** : sans ça, le déploiement déclencherait une tempête de
        centaines d'alertes pour des dépôts déjà anciens ;
      * **garde d'âge ABSOLUE** (``NOTIFY_MAX_AGE_D``) : un dépôt de plus de
        14 jours est marqué vu et rien d'autre — ni alerte, ni event. Elle ne
        dépend d'AUCUN état, donc une mémoire vide, corrompue ou tronquée ne
        peut plus faire sonner un dépôt de 2011 (incident du 25/08) ;
      * **cap de ``MAX_NOTIFY_PER_MANAGER`` notifications par gérant et par
        passage** : le surplus est marqué vu (il ne repartira pas au tour
        suivant) mais n'est pas envoyé.

    Une erreur sur UN gérant incrémente ``errors`` et n'interrompt pas les
    autres. Aucun job n'est armé ici : le planificateur appelle cette fonction.

    Trois ajouts du 26/08, tous après la ronde des dépôts :

    * **mode d'alerte** (``alerts.get_mode``) : en « calme » — le défaut — le
      dépôt est journalisé (``muted: True``) mais RIEN n'est envoyé. Seule la
      convergence parle ;
    * **cache tenu au chaud** (``warm``) : le coach lit les portefeuilles des
      gérants quand il réfléchit, pas quand un humain ouvre l'écran ;
    * **convergence événementielle** : un dépôt qui aligne des facteurs
      déclenche le digest tout de suite, pas au prochain réveil planifié.

    Et DEUX volets de plus (26/08 soir), intercalés entre la ronde des gérants
    et la convergence — donc AVANT elle, pour qu'un 8-K détecté à l'instant
    puisse compter dans le digest du même cycle :

    * **ses titres** : les 8-K/10-Q/10-K/6-K des ancres de l'utilisateur, une à
      deux ancres par cycle en rotation ;
    * **agenda** : les rendez-vous de banques centrales à moins de sept jours.

    Les deux écrivent dans la MÉMOIRE DE LA VEILLE et non dans le journal des
    dépôts (cf. le bloc « MÉMOIRE partagée ») : c'est elle que lisent le
    contexte du coach, la toile et la convergence. Les deux sont best-effort
    intégral et sous le même interrupteur que le reste — Telegram non
    configuré, rien ne part, rien n'est téléchargé.

    ``agenda`` (injectable) remplace ``agenda_bridge.upcoming_events`` : les
    tests n'ont ainsi ni banque centrale ni cache à simuler.
    """
    counters: Dict[str, Any] = {"managers": 0, "new_filings": 0, "notified": 0,
                                "errors": 0, "convergence_fired": False,
                                "own_checked": 0, "own_filings": 0,
                                "own_non_us": 0, "agenda_events": 0}

    if tg_cfg is not None:
        cfg = tg_cfg
    else:
        # Canal du paper trading (bot ORACLE, spec §13) : ``alerts`` lit le
        # fichier dédié et retombe tout seul sur la config du Harvester.
        from backend.bots.paper import alerts
        cfg = alerts.load_cfg()
    if not (cfg or {}).get("token") or not (cfg or {}).get("chat_id"):
        return counters                            # éteint : zéro réseau

    from backend.bots.paper import alerts as _alerts
    if notifier is None:
        notifier = _alerts.send
    quiet = _alerts.is_quiet(mode)

    stamp = now if now is not None else _now()
    now_dt = _as_datetime(stamp)
    when = now_dt.isoformat()
    state = _load_watch_state()
    pacer = _Pacer(sleep)
    fresh_events = []  # type: List[Dict[str, Any]]
    refreshed = []     # type: List[str]  gérants dont le 13F vient de bouger

    for manager in MANAGERS:
        mid = manager["id"]
        try:
            subm = fetch_submissions(manager.get("cik"), client=client,
                                     pacer=pacer)
            filings = _watched_filings(subm)
        except Exception:                          # noqa: BLE001 — un gérant HS
            counters["errors"] += 1                # ne doit pas tuer la ronde
            continue

        counters["managers"] += 1
        seen = set(state["seen"].get(mid) or [])
        already_seeded = bool(state["seeded"].get(mid))
        new_ones = [f for f in filings if f["accession"] not in seen]

        if not already_seeded:
            state["seeded"][mid] = True            # amorçage muet
        elif new_ones:
            counters["new_filings"] += len(new_ones)
            handled = 0
            for filing in new_ones:
                # CEINTURE : un dépôt antique est marqué vu (plus bas) et rien
                # de plus. Aucune alerte, aucun event -> l'UI et la convergence
                # ne voient pas passer un dépôt de 2011 comme une nouveauté.
                if is_stale_filing(filing["filing_date"], now_dt):
                    continue
                if handled >= MAX_NOTIFY_PER_MANAGER:
                    break
                handled += 1
                event = {
                    "ts": when, "manager_id": mid, "label": manager["label"],
                    "form": filing["form"], "filing_date": filing["filing_date"],
                    "accession": filing["accession"],
                }
                fresh_events.append(event)
                if str(filing.get("form") or "").upper().startswith("13F"):
                    if mid not in refreshed:
                        refreshed.append(mid)      # ses mouvements ont changé
                if quiet:
                    # Mode calme : la détection reste entière (journal, UI,
                    # convergence), seul l'envoi disparaît.
                    event["muted"] = True
                    continue
                try:
                    notifier(_notification_text(manager, filing["form"],
                                                filing["filing_date"]), cfg)
                    counters["notified"] += 1
                    event["muted"] = False
                except Exception:                  # noqa: BLE001 — best-effort
                    pass                           # une notif perdue n'annule
                                                   # pas la détection

        # Tous les dépôts vus deviennent connus (y compris ceux au-delà du cap et
        # les antiques) : sinon la prochaine ronde les redécouvrirait. Le plafond
        # ne peut PLUS évincer un dépôt récent (cf. ``prune_seen`` et le bloc de
        # constantes) — c'est exactement ce que faisait l'ancien cap de 300.
        state["seen"][mid] = prune_seen(filings, now_dt)

    if fresh_events:
        state["events"] = (fresh_events + state["events"])[:MAX_EVENTS]

    # --- les deux volets du 26/08 soir, avant l'écriture de l'état ---------- #
    own_events, own_pending = _run_own_volet(
        state, now_dt, when, quiet, notifier, cfg, client, pacer, counters)
    agenda_events, agenda_pending = _run_agenda_volet(
        state, now_dt, when, quiet, notifier, cfg, counters, agenda=agenda)

    # « Vu » ne se grave qu'une fois la mémoire ÉCRITE : un événement perdu par
    # une écriture concurrente revient au cycle suivant au lieu d'être oublié.
    if remember_events(own_events + agenda_events):
        if own_pending is not None:
            state["own_seen"].update(own_pending["seen"])
            state["own_seeded"].update(own_pending["seeded"])
            state["own_cursor"] = own_pending["cursor"]
        if agenda_pending is not None:
            state["agenda_seen"] = agenda_pending["seen"]
            state["agenda_seeded"] = agenda_pending["seeded"]

    try:
        _atomic_write_json(watch_path(), state)
    except OSError:
        pass

    # Le cache des portefeuilles est rafraîchi APRÈS l'écriture de l'état : un
    # échec SEC ici ne doit pas faire perdre les dépôts qu'on vient de détecter.
    if warm:
        _warm_cache(refreshed, _load_cache(), stamp, client, sleep, counters)

    counters["convergence_fired"] = _fire_convergence(
        tg_cfg=tg_cfg, notifier=notifier, converge=converge, counters=counters)
    return counters


def recent_filing_events(now: Any = None) -> List[Dict[str, Any]]:
    """Journal des dépôts détectés, les plus récents en tête (absent → []).

    **Filtré À LA LECTURE** par la même garde d'âge que la notification : un
    event dont le dépôt a plus de ``NOTIFY_MAX_AGE_D`` jours ne sort pas d'ici.
    Deux raisons :

      * l'écran et la convergence consomment cette fonction — un dépôt de 2011
        n'est un « signal » ni pour l'un ni pour l'autre ;
      * cela PURGE de fait les events pourris déjà écrits par l'incident du
        25/08, sans avoir à toucher au fichier d'état en production.

    ``now`` (epoch ou ``datetime``) est injectable pour les tests ; par défaut
    l'horloge du module.
    """
    now_dt = _as_datetime(now if now is not None else _now())
    return [event for event in _load_watch_state()["events"]
            if isinstance(event, dict)
            and not is_stale_filing(event.get("filing_date"), now_dt)]
