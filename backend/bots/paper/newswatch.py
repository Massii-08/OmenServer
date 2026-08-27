"""Veille news des positions du simulateur de paper trading -> notification
Telegram immédiate (Lot E, spec docs/superpowers/specs/2026-08-24-paper-trading-design.md,
section 13 pour l'extension politique/radar du 24/08 soir).

Deux volets :
  1. Par utilisateur -- tant qu'un utilisateur détient une position OU un
     symbole en watchlist (union des deux, extension 25/08 -- cf.
     _merged_symbols), on interroge le flux RSS Yahoo Finance de chaque
     symbole surveillé et on notifie par Telegram toute news classée
     bonne/mauvaise (déjà tombée) OU catalyseur à venir (anticipation d'un
     mouvement -- résultats annoncés, fusion/acquisition, décision FDA...).
  2. GLOBAL (pas par utilisateur) -- veille des annonces politiques à impact
     économique probable (tarifs, sanctions, participation de l'État...),
     tirée de Google News + de l'archive RSS Truth Social. Tourne à CHAQUE
     cycle, même si personne ne détient de position -- une politique
     commerciale n'attend pas qu'on ait un portefeuille pour bouger le marché.

Objectif des deux volets : que l'utilisateur puisse se positionner dans le
simulateur AVANT que le marché n'ait fini de digérer la nouvelle, pas
seulement après.

Séparation stricte PUR / I-O (même règle que le reste du lot, cf. store.py) :
  - PUR  : parse_rss / classify / classify_gov / format_message /
           format_gov_message -- zéro I/O, 100% testable hors-ligne.
  - I/O  : tout le reste -- fetch réseau (curl_cffi), Telegram (paper/alerts.py
           -- le bot ORACLE, spec §13), lecture/écriture des états "vu" sur
           disque. fetch/notifier/tg_cfg/sleep sont TOUS injectables dans
           run_once().

Pas de configuration Telegram -> le watcher NE FAIT RIEN (aucun accès disque,
aucun accès réseau, PAS MÊME le volet politique global) : silencieux, log
debug uniquement. C'est une feature opt-in, pas un flux qu'on peut oublier
d'éteindre.

États "vu" :
  - par utilisateur : data/paper_trading/<user>.news_seen.json (même dossier
    que les portefeuilles -- chemin dérivé de store.portfolio_path(), jamais
    recalculé à la main, pour rester valide même si DATA_DIR est monkeypatché
    en test) ;
  - global (politique) : data/paper_trading/newswatch_global.json.
Écriture atomique 0o600 pour les deux, même patron que store.py /
telegram_config.py / unblocker_config.py (le fichier tmp NAÎT en 0o600 via
os.open, jamais un open()+chmod() qui laisserait une fenêtre world-readable).

Canal Telegram : ``paper/alerts.py`` (bot Oracle, repli sur la config du
Harvester). Les paramètres ``notifier``/``tg_cfg`` restent injectables — seuls
les DÉFAUTS ont changé.

recent_events(username) FUSIONNE désormais les événements propres à
l'utilisateur ET les événements politiques globaux (sentiment "gov", symbole
"GOV", partagés par tout le monde) -- le router n'a rien à changer, la
fusion est interne à cette fonction.

Extension 2026-08-26 (fin de journée), deux ajouts qui se répondent :

  * volet REDDIT « tendances de la foule » -- un cycle sur trois, une seule
    requête multireddit. Il ne notifie JAMAIS (cf. _run_reddit_volet) : il
    nourrit la mémoire et la convergence, parce que le bruit social est un
    accélérant, pas une preuve ;
  * DÉTECTION D'ENTREPRISES (paper/entities.py) branchée sur les volets
    politique, X et Reddit. « L'administration Trump veut acheter des cartes
    graphiques à Nvidia » devient un event portant symbol="NVDA" -- il rejoint
    donc la branche du titre dans la toile et pèse sur les facteurs qui
    regardent les titres DÉTENUS. Avant, il partait au pivot « monde » et ne
    servait à rien de précis.

Extension 2026-08-26 (soir) — deux volets MONDE de plus, ``eco`` et ``climat`` :

  * « grosse partie des infos c'est que politique — il y a aussi l'économique,
    l'écologique ». Les deux suivent le patron du volet politique à la lettre
    (Google News, ``parse_rss``, cadence, amorçage muet, mode calme, mémoire +
    convergence + toile), avec un budget d'envoi PROPRE et une clé d'histoire
    préfixée par le volet ;
  * leur tonalité est ``pos``/``neg``/``watch`` — jamais ``gov``. Ils rejoignent
    donc le pool de presse GÉNÉRIQUE de la convergence (``cross_source``,
    ``held_risk`` sur un titre détenu) sans jamais allumer le facteur politique,
    et sans qu'aucun facteur nouveau ait été inventé.

Extension 2026-08-26 (W2a) — **le scanner devient MONDIAL** (« tout ce qui peut
bouger la courbe, ne te limite pas ») :

  * volet ``bc`` — les **banques centrales à la source** (Fed, BCE, BNS), un
    cycle sur trois. Doctrine : *la source décide, la presse commente*. Pas de
    gate de pertinence, parce qu'un flux de banque centrale est intégralement de
    la banque centrale — et parce que le communiqué qui compte est justement
    celui dont le titre ne contient aucun mot-clé ;
  * volet ``pressefi`` — la **presse financière mondiale** (Suisse, Allemagne,
    Royaume-Uni, Hong Kong, Inde + les flux du moteur Market Pulse), un cycle
    sur six. Sa cascade de collecte est EMPRUNTÉE à ``pulse.news.collect_news``,
    jamais réécrite : elle porte cinq leçons sondées (fraîcheur, flux périmés,
    refus des conseils, refus du hors-sujet, partage équitable par langue) ;
  * volet ``bsky`` — **Bluesky**, le social OUVERT, un cycle sur trois. Deux
    requêtes fixes génériques + le nom de chaque titre détenu ou suivi, toutes
    d'au moins deux mots (piège #68k) ;
  * **six subreddits internationaux** de plus, pour la même requête et le même
    coût réseau (un multireddit ajoute des sources, pas des requêtes) ;
  * une **file de PROBATION** des comptes X : toute ``@mention`` trouvée dans un
    texte RETENU (presse, X, Bluesky — jamais le volet politique, cf.
    ``_note_mentions_from``) devient un candidat, sondé à basse fréquence, muet
    par construction, promu après deux publications importantes et éjecté après
    six passages silencieux. **La liste manuelle n'est jamais évincée.**

Aucune nouvelle dépendance : curl_cffi (déjà utilisé par bond-scanner et
market-pulse -- Yahoo bloque les clients HTTP nus au niveau TLS, piège #67/#68)
+ stdlib (xml.etree, email.utils, re, hashlib, json, os).
"""
import hashlib
import json
import logging
import os
import re
import sys
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple
from urllib.parse import quote

from backend.bots.paper import alerts, entities, store

logger = logging.getLogger("omenserver")

# Le moteur Market Pulse, atteint par pont ``sys.path`` (le dossier est tirété,
# donc ``import pulse.social`` ne marche pas tel quel) — même patron que
# ``quotes.ENGINE_DIR`` et ``radar.ENGINE_DIR``.
ENGINE_DIR = Path(__file__).resolve().parents[3] / "market-pulse"

# --------------------------------------------------------------------------- #
# Constantes
# --------------------------------------------------------------------------- #

_RSS_URL_TEMPLATE = "https://feeds.finance.yahoo.com/rss/2.0/headline?s={symbol}&region=CH&lang=fr-CH"

_MAX_AGE_S = 48 * 3600          # une news plus vieille ne déclenche jamais de notif
_MAX_NOTIFY_PER_SYMBOL = 3      # cap PAR SYMBOLE PAR RUN, partagé pos/neg/watch

# Cap de l'historique persisté, PAR ÉTAT (l'état global des volets partagés, et
# celui de chaque compte).
#
# ⚠️ 100 -> 300 le 27/08. Ce chiffre datait de DEUX volets ; ils sont huit et
# plus (politique, crypto, éco, climat, X, Bluesky, Reddit, presse mondiale, plus
# le volet par symbole). Chacun journalise jusqu'à quatre à huit événements par
# cycle, et le cycle tourne plusieurs fois par jour : à 100, la fenêtre ROULAIT
# — une dépêche de la veille était déjà chassée par le bruit du matin, et
# l'utilisateur voyait « la base ne grandit pas » alors qu'elle se vidait par le
# bas aussi vite qu'elle se remplissait par le haut.
#
# Conséquences vérifiées avant de bouger le chiffre :
#   * les CONSOMMATEURS bornent déjà par le TEMPS et non par le nombre —
#     ``convergence`` sur 48 h, ``radar`` sur ``EVENT_WINDOW_H``, la toile sur
#     sept jours puis ``graph.MAX_NODES``. Trois fois plus d'histoire ne leur
#     fait pas trois fois plus de travail : elle leur donne accès aux dépêches
#     de la veille, qui tombaient dehors ;
#   * le seul consommateur qui ne bornait rien était le contexte du coach
#     (``paper_router._strategy_context``), qui recopie les dépêches dans un
#     PROMPT. Il a reçu son propre plafond (``STRATEGY_NEWS_CAP``) — sinon ce
#     bump aurait triplé la facture de chaque appel au modèle ;
#   * la purge par âge (``_purge_old_seen``) est inchangée : elle continue de
#     borner le fichier par le haut, indépendamment de ce cap.
_MAX_EVENTS = 300
_SEEN_MAX_AGE_DAYS = 30          # purge des entrées "seen" trop vieilles
_PACE_S = 1.1                    # piège #67 : un burst de requêtes = 429

# --- titres NEUTRES du volet par symbole (extension 2026-08-26) ------------- #
#
# Mesure du 26/08 sur le compte réel : la toile des connexions affichait **0
# événement de presse**. Cause exacte : un titre que ``classify`` ne sait pas
# qualifier était marqué VU et jeté — or c'est la très grande majorité des
# dépêches d'un flux Yahoo. La branche presse d'un titre restait donc vide en
# permanence, alors même que le flux parlait de lui tous les jours.
#
# Un titre neutre devient maintenant un événement, avec trois verrous :
#
#   1. ``sentiment: "neutral"`` — il ne ment pas sur ce qu'il est, et AUCUN
#      facteur de convergence ne le compte (``_is_polar`` teste les préfixes
#      ``pos``/``neg``, les autres facteurs testent ``gov``/``watch`` — un test
#      dédié fige cette exclusion) ;
#   2. ``muted: True`` — jamais envoyé, dans AUCUN mode. Ce volet ne lui ouvre
#      aucun canal, exactement comme le volet Reddit ;
#   3. ``_MAX_NEUTRAL_PER_SYMBOL`` — au plus 4 en mémoire par symbole, les plus
#      récents chassant les plus vieux. Sans ce cap, du bruit de fond repousserait
#      les vraies dépêches hors de l'historique (``_MAX_EVENTS``).
#
# Un CONSEIL d'investissement, lui, reste jeté : ``classify`` rend ``None`` pour
# les deux, mais relayer un conseil est interdit par doctrine (piège #67d) et le
# transformer en nœud de la toile serait précisément le relayer.
NEUTRAL_SENTIMENT = "neutral"
_MAX_NEUTRAL_PER_SYMBOL = 4

# --- volet politique GLOBAL (§13 de la spec, ajout 24/08 soir) ------------- #

# Sondées le 24/08 (200 confirmé toutes les deux). Google News ramène toute
# dépêche mentionnant Trump/Maison Blanche/executive order croisée avec un
# mot économique ; trumpstruth.org est l'archive RSS de Truth Social (le
# texte du post EST le titre de l'item).
_GOV_SOURCES = [
    "https://news.google.com/rss/search?q=Trump%20OR%20%22White%20House%22%20OR%20%22executive%20order%22%20(announces%20OR%20tariff%20OR%20tariffs%20OR%20investment%20OR%20sanctions%20OR%20ban%20OR%20stake)&hl=en-US&gl=US&ceid=US:en",
    "https://trumpstruth.org/feed",
]
_GOV_MAX_AGE_S = 24 * 3600       # plus court que le 48h "par symbole" : l'immédiateté est le but
_MAX_GOV_NOTIFY_PER_RUN = 3      # cap partagé entre LES DEUX sources gov, par run

# --------------------------------------------------------------------------- #
# Anti-spam du volet politique — incident mesuré le 24/08 au soir : ~53 messages
# entre 20h et 22h.
#
# Cause exacte : le dédoublonnage se fait par LIEN, or la MÊME histoire (les
# tarifs Trump/Canada, les sanctions Iran) est reprise par une quinzaine de
# médias, donc quinze liens différents -> quinze messages. Multiplié par les 12
# passages horaires du planificateur (IntervalTrigger 5 min) et le cap de 3
# notifications par passage, le plafond réel était de 36 messages par heure.
#
# Deux couches, dans cet ordre :
#
#   1. ``story_key`` — une clé d'HISTOIRE dérivée du titre. Une histoire déjà
#      envoyée il y a moins de ``_GOV_STORY_MUTE_H`` heures est mise en
#      sourdine. Elle rattrape les reprises quasi identiques (fil repris tel
#      quel, titre re-ponctué, suffixe « - Source » de Google News) ;
#   2. ``_GOV_MAX_SENDS_PER_HOUR`` — un budget DUR sur une fenêtre glissante
#      d'une heure. C'est LA garantie : quelle que soit la matière entrante,
#      le téléphone ne reçoit pas plus de 4 annonces politiques par heure.
#
# Rien n'est perdu : un item mis en sourdine est marqué vu ET journalisé avec
# ``"muted": True`` -> il reste visible dans le feed de l'UI et il compte
# toujours comme facteur pour la convergence. Seul l'ENVOI est supprimé.
_GOV_STORY_MUTE_H = 6            # même histoire : au plus un envoi / 6 h
_GOV_MAX_SENDS_PER_HOUR = 4      # budget dur, fenêtre glissante

# --- volet CRYPTO GLOBAL (extension 2026-08-26) ---------------------------- #
#
# Origine : le coach en niveau spéculatif a répondu, honnêtement, « le contexte
# ne contient aucune donnée crypto ». Le trou n'était pas dans le prompt, il
# était dans la COLLECTE — rien ne ramenait jamais d'actualité crypto.
#
# Sondées le 26/08 (200, RSS standard avec pubDate) : Cointelegraph est un flux
# PUR crypto (31 items) ; Decrypt est un flux tech MÉLANGÉ (on y trouve du
# SpaceX) — c'est le GATE de pertinence de ``classify_crypto`` qui le filtre,
# pas la liste de sources.
_CRYPTO_SOURCES = [
    "https://cointelegraph.com/rss",
    "https://decrypt.co/feed",
]
_CRYPTO_MAX_AGE_S = 24 * 3600    # comme le gov : l'immédiateté est le but
_MAX_CRYPTO_NOTIFY_PER_RUN = 3   # cap partagé entre les deux sources, par run
# Budget PROPRE (et non celui du gov) : les deux volets parlent de mondes
# différents, partager le budget ferait taire l'un dès que l'autre s'agite —
# et l'utilisateur ne saurait jamais lequel a mangé la place.
_CRYPTO_MAX_SENDS_PER_HOUR = 4

# --- volets MONDE : ÉCONOMIE et ÉCOLOGIE (extension 2026-08-26 soir) -------- #
#
# Retour utilisateur, mot pour mot : « grosse partie des infos c'est que
# politique — il y a aussi l'économique, l'écologique ». C'était exact : les
# deux seuls volets qui parlaient du monde étaient ``gov`` (politique) et
# ``crypto``. Une décision de la Fed, une vague d'inflation, une sécheresse qui
# ampute une récolte bougent les marchés sans qu'aucun gouvernement n'annonce
# quoi que ce soit — et rien ne les ramenait.
#
# Deux volets de plus, MÊME patron que ``gov`` (Google News, ``parse_rss``,
# cadence de 5 min, amorçage muet, mode calme, mémoire + convergence + toile) et
# MÊME appareil anti-spam. Ce qui leur est PROPRE :
#
#   * un **budget horaire à eux** (comme crypto et X). Partager celui du gov
#     ferait taire l'économie dès que la politique s'agite, et personne ne
#     saurait lequel a mangé la place ;
#   * une **clé d'histoire préfixée par le volet** (``eco:``/``climat:``) : deux
#     volets peuvent parler du même sujet sans se rendre muets l'un l'autre, et
#     les clés déjà écrites par le volet politique restent valides telles quelles.
#
# Ils rejoignent le pool de presse GÉNÉRIQUE de la convergence (``cross_source``,
# ``held_risk`` quand une mauvaise nouvelle touche un titre détenu) mais PAS le
# facteur ``gov``, qui reste politique : leur tonalité est ``pos``/``neg``/
# ``watch``, jamais ``gov``. Aucun facteur nouveau, aucun seuil déplacé.
_GNEWS_TEMPLATE = ("https://news.google.com/rss/search?q=%s"
                   "&hl=en-US&gl=US&ceid=US:en")


def gnews_url(query: str) -> str:
    """L'URL Google News d'une requête, correctement encodée (PUR).

    ``safe=""`` : les guillemets, les parenthèses et le ``:`` de ``when:1d``
    sont des caractères de la REQUÊTE, pas de l'URL — les laisser bruts
    marcherait par tolérance du serveur, jusqu'au jour où un opérateur en
    contiendrait un qui ne passe pas. On encode tout, le serveur décode.

    ``hl=en-US`` : la presse macro et climatique de référence est anglophone,
    et les listes de mots-clés ci-dessous sont d'abord calibrées sur l'anglais
    (le FR/IT y est en appoint, comme dans ``classify``).
    """
    return _GNEWS_TEMPLATE % quote(str(query or "").strip(), safe="")


# Requête ÉCO : la macroéconomie mondiale. ``when:1d`` borne à la journée — la
# fraîcheur est le sujet même de ces volets (cf. ``_ECO_MAX_AGE_S``).
ECO_QUERY = ('("Federal Reserve" OR ECB OR inflation OR recession OR '
             '"interest rates" OR "oil prices" OR "energy prices" OR '
             'unemployment) when:1d')
_ECO_SOURCES = [gnews_url(ECO_QUERY)]
_ECO_MAX_AGE_S = 24 * 3600
_MAX_ECO_NOTIFY_PER_RUN = 3
_ECO_MAX_SENDS_PER_HOUR = 4

# Requête CLIMAT : un aléa climatique ET sa dimension économique. Le croisement
# est DANS la requête (elle ne ramène pas un ouragan qui ne touche rien) puis
# re-vérifié par le gate de ``classify_climat`` — une requête peut dériver, un
# gate en dur non.
CLIMAT_QUERY = ('(drought OR hurricane OR wildfire OR flood OR heatwave OR '
                '"crop failure" OR "climate policy") '
                '(economy OR prices OR supply OR crops OR insurance) when:1d')
_CLIMAT_SOURCES = [gnews_url(CLIMAT_QUERY)]
_CLIMAT_MAX_AGE_S = 24 * 3600
_MAX_CLIMAT_NOTIFY_PER_RUN = 3
_CLIMAT_MAX_SENDS_PER_HOUR = 4

# Même fenêtre de sourdine par histoire que le volet politique : ces deux
# volets tirent de Google News, où une même dépêche est reprise par quinze
# médias — c'est exactement l'incident du 24/08 au soir.
_WORLD_STORY_MUTE_H = _GOV_STORY_MUTE_H

# --- volet BANQUES CENTRALES « bc » (extension 2026-08-26, W2a) ------------- #
#
# Doctrine : **la source décide, la presse commente.** Les volets ``eco`` et
# ``pressefi`` lisent ce que les journaux écrivent D'UNE décision ; celui-ci lit
# la décision elle-même, à la source, sans intermédiaire et sans délai
# rédactionnel. Quand les deux se contredisent, c'est celui-ci qui a raison.
#
# Les trois flux ont été SONDÉS (200 confirmé, RSS/Atom standard avec date) :
# Fed (press_all), BCE (press) et BNS (news). Ils sont servis par le MÊME moteur
# que ``eco``/``climat`` (``_run_world_volet``), qui sait déjà itérer plusieurs
# sources dans une même fiche — d'où une fiche unique à trois URL plutôt que
# trois fiches jumelles qui divergeraient au premier correctif.
_BC_SOURCES = [
    "https://www.federalreserve.gov/feeds/press_all.xml",
    "https://www.ecb.europa.eu/rss/press.html",
    "https://www.snb.ch/public/en/rss/news",
]

# 48 h et non 24 : une décision de banque centrale reste L'ÉVÉNEMENT pendant
# plusieurs jours, là où une dépêche de presse est périmée le lendemain. On ne
# perd rien à laisser la fenêtre ouverte — le dédoublonnage par lien empêche de
# toute façon qu'un communiqué soit relu deux fois.
_BC_MAX_AGE_S = 48 * 3600
_MAX_BC_NOTIFY_PER_RUN = 3
_BC_MAX_SENDS_PER_HOUR = 4
# Cap d'événements JOURNALISÉS par passage. ``eco``/``climat`` n'en ont pas :
# leur classifieur a un gate qui jette la plus grande partie de ce que Google
# News rend. Celui-ci n'en a pas, par construction — sans ce plafond, trois flux
# institutionnels relus après une purge de l'état « vu » rempliraient à eux
# seuls l'historique (``_MAX_EVENTS``) et en chasseraient tout le reste.
_BC_MAX_EVENTS_PER_RUN = 8

# UN CYCLE SUR TROIS (~15 min). Les guetteurs tournent toutes les 5 minutes ;
# une banque centrale ne publie pas toutes les 5 minutes. Interroger trois
# serveurs institutionnels 288 fois par jour pour rien serait un martèlement
# sans contrepartie.
_BC_CYCLE_EVERY = 3

# --- volet PRESSE FINANCIÈRE MONDIALE « pressefi » (W2a) ------------------- #
#
# « Tout ce qui peut bouger la courbe, ne te limite pas. » Les volets écrits
# jusqu'ici regardent le monde par le trou de serrure d'une requête Google News
# anglophone. Il manquait la presse elle-même — suisse, allemande, britannique,
# asiatique, indienne — celle qui parle des entreprises que Massii détient dans
# la langue du pays où elles sont cotées.
#
# ⚠️ La cascade de collecte n'est PAS réécrite ici : ``pulse.news.collect_news``
# du moteur Market Pulse la porte déjà, sondée et corrigée par l'expérience
# (fraîcheur, ``stale_sources``, ``is_advice``, ``is_offtopic``, partage
# ÉQUITABLE par source avant troncature — cf. piège #67e, une simple coupe par
# récence effaçait toute une langue). La réécrire, c'est se garantir de perdre
# ces cinq leçons une par une.
#
# Les neuf flux ci-dessous ont été sondés le 26/08. La langue est TAGGÉE parce
# que la cascade s'en sert pour le partage équitable — et parce qu'un titre
# allemand ne sera pas classé par ``classify`` (calibré EN/FR/IT) : il entrera
# en ``neutral``, ce qui est honnête, plutôt que forcé dans une tonalité.
PRESSEFI_EXTRA_FEEDS: Tuple[Dict[str, str], ...] = (
    {"name": "cash.ch", "lang": "de", "url": "https://www.cash.ch/feeds/latest/news"},
    {"name": "NZZ Wirtschaft", "lang": "de", "url": "https://www.nzz.ch/wirtschaft.rss"},
    {"name": "Handelsblatt Finanzen", "lang": "de",
     "url": "https://www.handelsblatt.com/contentexport/feed/finanzen"},
    {"name": "DW Business", "lang": "en", "url": "https://rss.dw.com/rdf/rss-en-bus"},
    {"name": "BBC Business", "lang": "en",
     "url": "https://feeds.bbci.co.uk/news/business/rss.xml"},
    {"name": "Guardian Business", "lang": "en",
     "url": "https://www.theguardian.com/uk/business/rss"},
    {"name": "SCMP Business", "lang": "en", "url": "https://www.scmp.com/rss/92/feed"},
    {"name": "Economic Times Markets", "lang": "en",
     "url": "https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms"},
    {"name": "Yahoo Finance", "lang": "en",
     "url": "https://finance.yahoo.com/news/rssindex"},
)

# UN CYCLE SUR SIX (~30 min). C'est du CONTEXTE, pas de l'urgence : une revue de
# presse mondiale ne se lit pas toutes les cinq minutes, et seize sources à
# chaque cycle, ce serait seize fois le martèlement pour la même information.
_PRESSEFI_CYCLE_EVERY = 6
_PRESSEFI_MAX_AGE_H = 24.0
_PRESSEFI_PER_SOURCE = 3        # par source, AVANT le partage équitable
_PRESSEFI_MAX_ITEMS = 24        # ce que la cascade rend au plus, toutes sources
# Cap d'événements JOURNALISÉS par passage : sans lui, un seul passage de presse
# mondiale chasserait toute la politique et toute la mémoire du fil (plafonné à
# ``_MAX_EVENTS``). Même raison, même chiffre d'ordre de grandeur que Reddit.
_PRESSEFI_MAX_EVENTS_PER_RUN = 8
# Budget d'envoi PROPRE, et volontairement le plus SERRÉ de tous les volets :
# c'est du contexte. Il parle peu, il nourrit surtout la mémoire.
_MAX_PRESSEFI_NOTIFY_PER_RUN = 2
_PRESSEFI_MAX_SENDS_PER_HOUR = 3

# --- volet BLUESKY « bsky » : le social OUVERT (W2a) ----------------------- #
#
# X se referme (empreinte TLS, murs, escalade vers un navigateur furtif) ;
# Bluesky sert une API de recherche PUBLIQUE, sans clé, et ``pulse.social`` sait
# déjà en lire la réponse (chemin PROUVÉ en production sur Market Pulse — un 403
# sondé depuis le Mac est un accident de réseau local, pas un refus de Bluesky).
#
# Deux natures de requêtes, et c'est délibéré :
#   * DEUX requêtes fixes et GÉNÉRIQUES — « market selloff », « rate decision ».
#     Pas de sujet d'actualité figé dans le code : « tariffs canada » serait vrai
#     six semaines puis mort, et personne ne s'en apercevrait ;
#   * le NOM de chaque ancre (positions ∪ watchlist, cap 4) — ce dont la foule
#     dit quelque chose SUR CE PORTEFEUILLE.
#
# ⚠️ Leçon #68k, câblée dans ``bsky_queries`` : **une requête d'un seul mot
# courant est presque toujours un piège** (« borsa » rendait la moitié de posts
# turcs, « nikkei » ramenait un collectif militant). Toute requête sort d'ici
# avec AU MOINS deux mots.
BSKY_FIXED_QUERIES: Tuple[str, ...] = ("market selloff", "rate decision")
BSKY_MAX_ANCHOR_QUERIES = 4
BSKY_SEARCH_LIMIT = 25
# Le mot ajouté à un nom d'ancre d'un seul mot pour satisfaire la règle des deux
# mots. « stock » plutôt que « news » : il désigne l'objet, il ne décrit pas un
# genre de contenu — « nestle stock » parle de bourse, « nestle news » ramènerait
# la moitié du marketing de la marque.
BSKY_ANCHOR_SUFFIX = "stock"
_BSKY_CYCLE_EVERY = 3
_BSKY_MAX_AGE_S = 24 * 3600
_BSKY_MAX_POSTS_PER_QUERY = 8
_BSKY_MAX_EVENTS_PER_RUN = 8
_MAX_BSKY_NOTIFY_PER_RUN = 3
_BSKY_MAX_SENDS_PER_HOUR = 4

# --- DÉCOUVERTE de comptes X, EN PROBATION (W2a) --------------------------- #
#
# « Des annonces intéressantes d'autres utilisateurs. » La liste des comptes
# suivis est aujourd'hui figée à la main ; or les comptes qui comptent se citent
# entre eux. La liste grandit donc DEPUIS LE RÉSEAU DE CE QU'ON LIT DÉJÀ : toute
# mention ``@handle`` trouvée dans un post retenu (X, Bluesky) ou dans un titre
# de presse devient un CANDIDAT.
#
# Un candidat n'est pas un compte suivi : il est en PROBATION. Il est interrogé à
# BASSE FRÉQUENCE, il ne parle JAMAIS au téléphone (ses événements naissent en
# sourdine), et il ne rejoint la vraie liste qu'après avoir PROUVÉ deux fois
# qu'il publie quelque chose d'important.
X_CANDIDATE_MAX = 10             # cap de la file d'attente
X_CANDIDATE_PROMOTE_HITS = 2     # deux preuves valent mieux qu'un coup de chance
X_CANDIDATE_EVICT_POLLS = 6      # six passages muets = ce n'était pas la peine
_X_CANDIDATE_EVERY = 6           # un cycle X sur six (le volet X tourne déjà 1/2)

# Un candidat qui a fait ses preuves alors que la liste manuelle est PLEINE
# reste dans la file, marqué ``pending_manual`` (on n'évince pas un compte que
# Massii a choisi lui-même). Il y restait POUR TOUJOURS : son verdict est
# « promote » à vie, et l'éjection ordinaire exige ``hits == 0``. Dix comptes
# dans cet état, et la file est pleine de gens qui ne bougeront plus — plus
# aucune inscription possible, donc **la découverte meurt**, en silence.
#
# Il est donc LIBÉRÉ après ce nombre de passages supplémentaires. On ne perd pas
# son nom pour autant : il rejoint ``x_pending_seen``, une trace consultable
# (« ces comptes-là méritaient une place, il n'y en avait pas »).
X_CANDIDATE_PENDING_POLLS = 6
X_PENDING_SEEN_MAX = 10

# Cap d'événements JOURNALISÉS par passage de la file de probation. Dix
# candidats × huit posts = quatre-vingts événements possibles en un passage,
# contre ``_MAX_EVENTS`` (300, et 100 quand ce cap a été écrit) pour TOUT
# l'historique : la file la moins fiable
# du guetteur pouvait à elle seule chasser la presse, la politique et les
# banques centrales du fil. Le cap borne la JOURNALISATION, jamais la MESURE :
# les ``hits`` qui décident d'une promotion continuent de compter au-delà (même
# règle que le cap du volet monde, cf. ``_run_world_volet``).
X_CANDIDATE_MAX_EVENTS_PER_RUN = 4

# Anomalies tolérées sur un CANDIDAT avant de le sortir de la file. Un candidat
# est souvent un compte qui n'existe pas (une mention mal lue, un compte
# supprimé) : deux refus suffisent à le dire, et il n'a droit à aucune escalade
# vers le navigateur furtif — cf. ``_x_posts_for``.
X_CANDIDATE_MAX_FAILS = 2

# ⚠️ La longueur est vérifiée EN PYTHON, pas dans l'expression. Un ``{1,15}``
# suivi d'une garde de fin de mot BACKTRACKE : sur un jeton de dix-sept
# caractères il finirait par accepter les quatorze premiers, c'est-à-dire un
# compte qui n'existe pas. On capture le jeton ENTIER, puis on jette ce qui
# dépasse — un handle X fait au plus quinze caractères.
_MENTION_RE = re.compile(r"(?<![A-Za-z0-9_@])@([A-Za-z0-9_]+)")

# --- volet X « comptes influents » (extension 2026-08-26) ------------------ #
#
# Canal SONDÉ : ``GET https://x.com/<handle>`` en curl_cffi
# (``impersonate="chrome"``) rend un HTML avec les derniers posts en clair,
# que ``pulse.social.parse_x`` du moteur market-pulse sait lire (mesuré :
# elonmusk -> 10 posts, WhiteHouse -> 4).
#
# Cadence : UN CYCLE SUR DEUX. Les guetteurs tournent toutes les 5 min ; X
# serait donc interrogé 288 fois par jour et par compte — c'est beaucoup pour
# une page qu'on n'a pas le droit de marteler. Une fois sur deux (~10 min)
# suffit largement pour un signal qui se joue à l'heure.
X_ACCOUNTS_NAME = "x_accounts.json"
X_DEFAULT_HANDLES = ("elonmusk", "WhiteHouse")
X_MAX_HANDLES = 10
# Longueur maximale d'un handle X. Écrite ICI et réutilisée par
# ``_X_HANDLE_RE`` comme par ``extract_mentions`` : deux chiffres en dur
# finiraient par diverger, et le jour où X change sa limite on ne
# corrigerait que la moitié du fichier.
X_HANDLE_MAX_LEN = 15
_X_HANDLE_RE = re.compile(r"^[A-Za-z0-9_]{1,%d}$" % X_HANDLE_MAX_LEN)
_X_CYCLE_EVERY = 2               # 1 cycle sur 2 (cf. ci-dessus)
_X_PACE_S = 1.5                  # plancher entre deux comptes
_X_POST_MAX_LEN = 140            # un post tronqué reste un titre lisible
_X_MAX_POSTS_PER_HANDLE = 8      # les plus récents suffisent
_X_MAX_NOTIFY_PER_RUN = 3
_X_MAX_SENDS_PER_HOUR = 4

# Escalade vers le navigateur furtif du Harvester. Un blocage FRANC (403/429)
# escalade tout de suite ; une anomalie molle (page sans post, sérialisation
# changée) doit se répéter — un blip ne justifie pas de démarrer un Chrome.
_X_ESCALATE_AFTER = 2
# Une fois le furtif adopté pour un compte, on y reste 24 h : re-tenter le
# chemin léger à chaque cycle, ce serait re-payer l'échec toutes les 10 minutes.
_X_STEALTH_TTL_S = 24 * 3600

_CASHTAG_RE = re.compile(r"\$([A-Z]{1,5})\b")

# --- volet REDDIT « tendances de la foule » (extension 2026-08-26) --------- #
#
# Chemin PROUVÉ (sondé pour le radar, spec §13) : le ``.json`` de Reddit rend
# 403 même en empreinte Chrome, mais le flux Atom d'un MULTIREDDIT rend jusqu'à
# 100 posts en UNE requête. On emprunte donc ``pulse.social`` du moteur Market
# Pulse (``reddit_url`` + ``parse_reddit``) plutôt que de réécrire un parseur.
#
# ⚠️ Plafond MESURÉ : **1 requête / 60 s / IP**. Le guetteur tourne toutes les
# 5 minutes ; on n'interroge donc Reddit qu'UN CYCLE SUR TROIS (~15 min), ce qui
# laisse quinze fois la marge du plafond — et suffit largement pour un compteur
# de mentions dont la fenêtre est de 24 heures. Un 429 n'est JAMAIS réessayé
# dans le même cycle (marteler un service qui vient de dire non est la façon la
# plus sûre de se faire bloquer l'IP) : il compte une erreur, et le prochain
# cycle dû retentera un quart d'heure plus tard.
# --- DEUX groupes, interrogés en ALTERNANCE (correctif 27/08) -------------- #
#
# L'élargissement du 26/08 avait mis les dix subs dans UN multireddit, au motif
# qu'il ne coûtait pas une requête de plus. Deux défauts, dont un mesuré en
# production :
#
# 1. **panne totale** — le multireddit à dix a rendu **403 depuis l'Omen**. Un
#    seul sub en quarantaine, privé ou renommé, et TOUT tombe : les six
#    nouveaux ET les quatre d'origine, qui marchaient très bien avant. Une
#    source unique qui agrège dix dépendances est dix fois plus fragile qu'une
#    source unique. (Le 403 n'a PAS pu être attribué à un sub précis : les
#    sondes par-sub rendent 200 — l'hypothèse encore ouverte est une
#    heuristique anti-bot sur les URL longues, d'où des groupes COURTS.)
# 2. **dilution** — la réponse est plafonnée à cent posts, quel que soit le
#    nombre de subs. Dix subs dans la même requête, c'est dix fois moins de
#    chaque : le compteur de mentions, qui cherche une ACCÉLÉRATION, perdait la
#    résolution qui lui sert à la voir.
#
# Chaque passage n'interroge donc qu'UN groupe (une requête, le plafond de
# 1 req/60 s reste tenu avec la même marge), et les groupes alternent. Un
# groupe qui échoue compte une erreur et laisse l'autre continuer : le passage
# suivant tombe sur l'autre groupe, quoi qu'il arrive.
#
# Le prix, assumé : chaque groupe est vu deux fois moins souvent (~1 cycle sur
# six, soit une demi-heure). Pour un compteur dont la fenêtre est de 24 h, c'est
# indolore ; la panne totale, elle, ne l'était pas.
REDDIT_CORE = ("wallstreetbets", "stocks", "investing", "StockMarket")

# Le monde. « IndianStreetBets » manque VOLONTAIREMENT : la sonde par-sub
# depuis l'Omen n'en a tiré que des 429 de collision avec le guetteur vivant —
# ni mort ni sain prouvé. Le mécanisme d'alternance tolérerait un sub malade,
# mais on ne lance pas avec un doute connu. Réintégrable après une sonde propre :
#     "IndianStreetBets",
REDDIT_INTL = ("mauerstrassenwetten", "UKInvesting", "ASX_Bets",
               "CanadianInvestor", "eupersonalfinance")

#: Les groupes, dans l'ordre d'alternance. Le groupe HISTORIQUE d'abord : un
#: état neuf (compteur à 0) commence par les quatre subs qui ont toujours
#: répondu.
REDDIT_GROUPS: Tuple[Tuple[str, ...], ...] = (REDDIT_CORE, REDDIT_INTL)

#: Tous les subs suivis, toutes rotations confondues — c'est la vue « qui
#: nourrit ce compteur », pas une URL : aucune requête ne les demande ensemble.
REDDIT_SUBS = REDDIT_CORE + REDDIT_INTL
REDDIT_LIMIT = 100
_REDDIT_CYCLE_EVERY = 3          # 1 cycle sur 3 (cf. ci-dessus)
_REDDIT_MAX_AGE_S = 24 * 3600    # comme le gov et le crypto : l'immédiateté

# --- le VERDICT du jour J (27/08) ------------------------------------------ #
#
# Un cycle sur trois, comme Reddit — mais pour une raison inverse : Reddit est
# limité par le débit qu'on nous accorde, le calendrier par l'utilité. Les cours
# bougent en continu, un verdict rendu quinze minutes plus tôt ne change aucune
# décision, et chaque passage coûte une cotation par titre échu.
_CALENDAR_CYCLE_EVERY = 3

# Le flux rend 100 posts d'un coup. Tous comptent pour les TENDANCES (un
# compteur ne coûte qu'un horodatage), mais seule une poignée devient un
# événement affiché : sans ce cap, un seul passage Reddit chasserait toute la
# presse et toute la politique du fil (plafonné à ``_MAX_EVENTS``).
_REDDIT_MAX_EVENTS_PER_RUN = 6

# Tonalité DÉDIÉE, et surtout : neutre pour tous les facteurs existants. Donner
# « neg » à un post Reddit ferait tirer SEUL le facteur de menace ``held_risk``
# (cf. ``convergence.THREAT_FACTORS``) — un coup de gueule anonyme réveillerait
# le téléphone comme un avertissement sur résultats. La foule pèse par son
# NOMBRE (facteur ``crowd_buzz``), jamais par le ton d'un post isolé.
REDDIT_SENTIMENT = "crowd"

# Fenêtres du compteur de mentions. 24 h contre les 24 h précédentes : c'est
# l'ACCÉLÉRATION qu'on cherche, pas le volume absolu (un titre populaire l'est
# tous les jours, ça ne dit rien de neuf).
REDDIT_TREND_WINDOW_H = 24
REDDIT_TREND_MAX_AGE_H = 48      # au-delà, l'horodatage ne sert plus à rien
REDDIT_TRENDS_MAX = 40           # cap du nombre de tickers suivis


# =========================================================================== #
#  PUR -- zéro I/O, zéro réseau, 100% testable hors-ligne
# =========================================================================== #

def _text(node) -> str:
    """Texte d'un noeud XML, "" si absent (ElementTree fusionne déjà le
    contenu CDATA dans .text -- rien de spécial à faire côté appelant)."""
    return (node.text or "").strip() if node is not None else ""


def _parse_pub_ts(raw: str) -> int:
    """Epoch (UTC) d'un pubDate RFC822. 0 si absent/invalide -- traité comme
    "infiniment vieux" par le filtre de fraîcheur, jamais comme une erreur qui
    ferait planter le parsing du flux entier."""
    raw = (raw or "").strip()
    if not raw:
        return 0
    try:
        dt = parsedate_to_datetime(raw)
    except (TypeError, ValueError, IndexError, OverflowError):
        return 0
    if dt is None:
        return 0
    try:
        return int(dt.timestamp())
    except (OverflowError, OSError, ValueError):
        return 0


def parse_rss(xml_text: str) -> List[Dict[str, Any]]:
    """Parse un flux RSS 2.0 (Yahoo Finance, Google News ou l'archive Truth
    Social -- même structure item/title/link/pubDate) -> [{"title", "link",
    "pub_ts"}].

    Un item sans titre ou sans lien est jeté (donnée inexploitable pour la
    suite). Un XML invalide (ou vide) rend une liste vide -- ne lève JAMAIS,
    cohérent avec le reste du projet : une source cassée ne doit jamais faire
    planter l'appelant (run_once la compte en erreur et passe à la suite)."""
    if not xml_text:
        return []
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return []
    items: List[Dict[str, Any]] = []
    for node in root.findall(".//item"):
        title = " ".join(_text(node.find("title")).split())
        link = _text(node.find("link"))
        if not title or not link:
            continue
        items.append({
            "title": title,
            "link": link,
            "pub_ts": _parse_pub_ts(_text(node.find("pubDate"))),
        })
    return items


# --- classification par symbole (mots-clés FR/EN/IT, compacts) ------------- #

# Un conseil d'investissement n'est JAMAIS relayé, quel que soit le reste du
# titre (doctrine Market Pulse, piège #67d) -- vérifié EN PREMIER, prioritaire
# sur tout le reste (neg/pos/watch inclus).
_ADVICE_KEYWORDS = [
    "buy now", "top stocks", "actions à acheter", "da comprare", "best stocks to",
]

# Mauvaise nouvelle DÉJÀ TOMBÉE -- prioritaire sur "pos" ET sur "watch" (si un
# titre matche neg ET watch, la nouvelle est déjà tombée, ce n'est plus une
# anticipation).
_NEG_KEYWORDS = [
    "profit warning", "downgrade", "cut guidance", "guidance cut",
    "misses estimates", "miss estimates", "lawsuit", "recall", "probe",
    "investigation", "fraud", "plunge", "sinks", "slumps", "tumbles",
    "layoffs", "bankruptcy",
    "chute", "effondre", "avertissement sur résultats", "abaisse", "enquête",
    "rappel de produits", "licenciements", "faillite",
    "perdita", "crolla", "indagine", "richiamo", "fallimento", "taglia le stime",
]

# Bonne nouvelle DÉJÀ TOMBÉE -- prioritaire sur "watch".
_POS_KEYWORDS = [
    "beats estimates", "beats expectations", "raises guidance", "upgrade",
    "record profit", "buyback", "dividend increase", "dividend hike",
    "surges", "soars", "jumps", "wins contract", "approval",
    "relève ses prévisions", "bénéfice record", "rachat d'actions",
    "hausse du dividende", "bondit", "s'envole", "contrat remporté",
    "utile record",
    "alza le stime", "balza", "vola", "maxi commessa",
]

# Catalyseur À VENIR -- rien n'est encore tombé, c'est une anticipation
# (résultats annoncés, M&A, décision réglementaire...). Extension de mission
# 2026-08-24 : signaler AUSSI ces titres pour permettre de se positionner
# AVANT le mouvement. Priorité la PLUS BASSE (neg > pos > watch) : si la
# nouvelle est déjà arrivée, ce n'est plus une anticipation.
_WATCH_KEYWORDS = [
    "to report earnings", "reports q1", "reports q2", "reports q3", "reports q4",
    "earnings preview", "ahead of earnings", "earnings date", "set to announce",
    "poised to", "expected to report", "merger", "takeover bid",
    "acquisition of", "to acquire", "fda decision", "pdufa", "investor day",
    "product launch", "to launch", "unveils", "guidance update",
    "outlook update", "spin-off", "ipo of",
    "publiera ses résultats", "résultats attendus", "avant les résultats",
    "devrait annoncer", "opa sur", "offre publique", "fusion",
    "acquisition de", "lancement de", "journée investisseurs", "scission",
    "pubblicherà i risultati", "risultati attesi", "opa su", "fusione",
    "acquisizione di", "lancio di", "scissione",
]


def _keyword_matches(title_lower: str, keyword: str) -> bool:
    """Un mot-clé SANS espace = un mot entier -> \\b (évite "chute" trouvé
    dans "parachute", "fusion" dans "confusion"). Un mot-clé AVEC espace = un
    composé -> substring simple (une séquence de plusieurs mots ne peut pas
    se retrouver "à l'intérieur" d'un autre mot)."""
    if " " in keyword:
        return keyword in title_lower
    return re.search(r"\b" + re.escape(keyword) + r"\b", title_lower) is not None


def is_advice(title: str) -> bool:
    """Le titre EST-IL lui-même un conseil d'investissement ? (PUR)

    ``classify`` rend ``None`` pour un conseil ET pour un titre neutre — deux
    silences très différents. Un titre neutre a le droit d'exister dans la
    mémoire (c'est de la matière factuelle) ; un conseil, non : le recopier,
    même sans l'envoyer, c'est le relayer (doctrine Market Pulse, piège #67d).
    D'où ce prédicat, extrait pour être appelable SANS repasser par ``classify``.
    """
    if not title:
        return False
    t = title.lower()
    return any(_keyword_matches(t, kw) for kw in _ADVICE_KEYWORDS)


def cap_neutral(events: List[Dict[str, Any]], symbol: str,
                cap: int = _MAX_NEUTRAL_PER_SYMBOL) -> List[Dict[str, Any]]:
    """Ne garde que les ``cap`` événements NEUTRES les plus récents de ``symbol``
    dans ``events`` — MUTE la liste et la rend (PUR au sens « pas d'I/O »).

    ``events`` est rangé du plus récent au plus vieux (les volets font
    ``insert(0, …)``) : on garde donc les premiers rencontrés et on retire les
    suivants. Rien d'autre n'est touché — ni les événements à tonalité, ni les
    neutres des autres symboles.
    """
    kept = 0
    survivors: List[Dict[str, Any]] = []
    for event in events:
        if (isinstance(event, dict)
                and event.get("sentiment") == NEUTRAL_SENTIMENT
                and event.get("symbol") == symbol):
            kept += 1
            if kept > max(0, cap):
                continue
        survivors.append(event)
    events[:] = survivors
    return events


def classify(title: str) -> Optional[str]:
    """Classe un titre de news PAR SYMBOLE : "neg" | "pos" | "watch" | None.

    Ordre de priorité (le premier qui matche gagne) :
      1. conseil d'investissement -> None, TOUJOURS, quel que soit le reste
         du titre (on ne relaie jamais un conseil, doctrine Market Pulse) ;
      2. "neg"   -- mauvaise nouvelle déjà tombée ;
      3. "pos"   -- bonne nouvelle déjà tombée ;
      4. "watch" -- catalyseur à venir (anticipation, rien n'est encore
         arrivé) ;
      5. sinon None (neutre).
    """
    if not title:
        return None
    t = title.lower()
    if is_advice(title):
        return None
    if any(_keyword_matches(t, kw) for kw in _NEG_KEYWORDS):
        return "neg"
    if any(_keyword_matches(t, kw) for kw in _POS_KEYWORDS):
        return "pos"
    if any(_keyword_matches(t, kw) for kw in _WATCH_KEYWORDS):
        return "watch"
    return None


def format_message(symbol: str, title: str, link: str, sentiment: str, lang: str = "fr") -> str:
    """Message Telegram sobre, sans emoji, pour une news PAR SYMBOLE.

    "watch" a un texte dédié qui ne dit JAMAIS "achète"/"investis" -- on
    signale un catalyseur, on ne recommande jamais un titre (même doctrine
    que le coach, section 2 de la spec). ``lang`` n'a qu'une variante FR pour
    l'instant (seule formulation demandée) -- gardé pour cohérence de
    signature avec le reste du projet, ignoré sinon."""
    if sentiment == "watch":
        return (
            f"[Simulateur] Catalyseur à venir — {symbol}\n"
            f"« {title} »\n"
            f"Mouvement possible : si tu veux le jouer, pose ta thèse dans le "
            f"simulateur maintenant (argent fictif).\n"
            f"{link}"
        )
    label = "Bonne" if sentiment == "pos" else "Mauvaise"
    return f"[Simulateur] {label} nouvelle potentielle — {symbol}\n« {title} »\n{link}"


# --- classification GLOBALE politique (§13, ajout 24/08 soir) -------------- #

# Vocabulaire à impact ÉCONOMIQUE probable. Matching en SUBSTRING SIMPLE
# (contrairement à _keyword_matches ci-dessus, pas de \b) : (a) le
# vocabulaire est spécifique et le risque de collision par substring est
# faible ("sanctions"/"bailout"/"subvention" ne sont substrings d'aucun autre
# mot courant) ; (b) "nationaliz" est un RADICAL délibéré, à substring
# obligatoire pour couvrir nationalize/nationalide/nationalise/
# nationalization/nationalized -- un \b échouerait sur toutes ces formes.
# "tariff"/"tariffs" listés séparément pour rester lisible, mais "tariff" en
# substring couvre déjà "tariffs" à lui seul.
_GOV_KEYWORDS = [
    "tariff", "tariffs", "droits de douane", "executive order", "sanctions",
    "export ban", "import ban", "government stake", "state stake", "nationaliz",
    "subsidy", "subsidies", "subvention", "bailout", "price cap",
    "trade deal", "accord commercial", "defense contract", "chips act",
    "emergency declaration", "announces investment", "federal funding",
]


def classify_gov(title: str) -> bool:
    """True si un titre parle d'une annonce politique à impact ÉCONOMIQUE
    probable (tarifs, sanctions, participation de l'État, subventions...).
    Un titre purement électoral/sondage/polémique SANS mot économique ->
    False PAR CONSTRUCTION (aucun mot-clé ne matche) -- pas de liste
    d'exclusion séparée à maintenir : un post "Fake Polls" ne contient aucun
    des mots ci-dessus, donc ne bouge jamais ce classifieur."""
    if not title:
        return False
    t = title.lower()
    return any(kw in t for kw in _GOV_KEYWORDS)


def format_gov_message(title: str, link: str) -> str:
    """Message Telegram pour une annonce politique à impact économique
    probable. Ne recommande JAMAIS un titre précis -- signale un contexte,
    laisse la thèse (et la décision) à l'utilisateur, même doctrine que le
    coach (section 2 de la spec)."""
    return (
        "[Simulateur] Annonce politique — mouvement de marché possible\n"
        f"« {title} »\n"
        f"{link}\n"
        "Si un secteur te semble touché : simulateur, thèse, petit sizing."
    )


# --- classification CRYPTO (volet global, 26/08) --------------------------- #

# GATE de pertinence. C'est LUI qui rend un flux mélangé (Decrypt) utilisable :
# un titre sans le moindre marqueur crypto n'est pas classé du tout, quelle que
# soit sa tonalité — c'est ainsi qu'un « SpaceX lands... » disparaît sans qu'on
# ait à maintenir une liste de sujets à exclure.
_CRYPTO_MARKERS = [
    "bitcoin", "btc", "ethereum", "ether", "eth", "solana", "xrp", "ripple",
    "dogecoin", "cardano", "avalanche", "chainlink", "litecoin", "polkadot",
    "crypto", "cryptos", "cryptocurrency", "cryptocurrencies", "crypto-monnaie",
    "blockchain", "stablecoin", "stablecoins", "tether", "usdt", "usdc",
    "defi", "altcoin", "altcoins", "web3", "onchain", "on-chain",
    "binance", "coinbase", "kraken", "microstrategy",
    "spot etf", "bitcoin etf", "ether etf", "crypto etf", "halving",
]

# Mauvaise nouvelle DÉJÀ TOMBÉE — prioritaire sur pos et watch.
_CRYPTO_NEG_KEYWORDS = [
    "hack", "hacked", "exploit", "exploited", "stolen", "drained",
    "sec sues", "sec charges", "charged with", "lawsuit", "delisting",
    "delisted", "ban", "banned", "crackdown", "liquidations", "liquidated",
    "outflows", "plunge", "plunges", "crash", "crashes", "slumps", "tumbles",
    "selloff", "sell-off", "rug pull", "insolvency", "bankruptcy", "fraud",
    "halts withdrawals", "seizes",
]

# Bonne nouvelle DÉJÀ TOMBÉE — prioritaire sur watch.
_CRYPTO_POS_KEYWORDS = [
    "etf approval", "approves etf", "etf approved", "inflows", "record inflows",
    "adoption", "adopts", "integration", "integrates", "partnership",
    "all-time high", "all time high", "record high", "surges", "soars",
    "rallies", "jumps", "upgrade completed", "upgrade goes live",
    "mainnet launch", "legal tender", "green light",
]

# Catalyseur À VENIR — rien n'est tombé, c'est une anticipation.
_CRYPTO_WATCH_KEYWORDS = [
    "etf decision", "sec decision", "deadline", "halving", "hard fork",
    "upgrade scheduled", "scheduled for", "token unlock", "unlock",
    "vote on", "ruling expected", "expected to rule", "proposal", "testnet",
    "set to launch", "ahead of",
]

# Mapping best-effort titre -> paire Yahoo. Liste ORDONNÉE (et non un dict) :
# le premier marqueur trouvé gagne, et les noms longs passent avant leurs
# abréviations pour qu'« ethereum » ne soit pas attrapé par « eth ».
_CRYPTO_SYMBOLS = [
    ("bitcoin", "BTC-USD"), ("btc", "BTC-USD"),
    ("ethereum", "ETH-USD"), ("ether", "ETH-USD"), ("eth", "ETH-USD"),
    ("solana", "SOL-USD"),
    ("ripple", "XRP-USD"), ("xrp", "XRP-USD"),
    ("dogecoin", "DOGE-USD"), ("cardano", "ADA-USD"),
    ("avalanche", "AVAX-USD"), ("chainlink", "LINK-USD"),
    ("litecoin", "LTC-USD"), ("polkadot", "DOT-USD"),
]


def is_crypto_topic(title: str) -> bool:
    """Le titre parle-t-il de crypto ? (GATE de pertinence, PUR).

    Séparé de ``classify_crypto`` pour être testable seul : c'est la moitié du
    volet qui décide ce qui ENTRE, l'autre moitié ne fait que doser le ton.
    """
    if not title:
        return False
    t = title.lower()
    return any(_keyword_matches(t, kw) for kw in _CRYPTO_MARKERS)


def crypto_symbol(title: str) -> Optional[str]:
    """La paire Yahoo évoquée par le titre (``BTC-USD``…), ou ``None``.

    Best-effort ASSUMÉ : une dépêche « crypto market falls » ne nomme aucune
    pièce, et l'event partira sans symbole plutôt qu'avec un symbole inventé —
    un event mal étiqueté polluerait le facteur « titre détenu » de la
    convergence.
    """
    if not title:
        return None
    t = title.lower()
    for marker, symbol in _CRYPTO_SYMBOLS:
        if _keyword_matches(t, marker):
            return symbol
    return None


def classify_crypto(title: str) -> Optional[str]:
    """Classe un titre CRYPTO : "neg" | "pos" | "watch" | None (PUR).

    Deux étages, dans cet ordre :

    1. le **gate de pertinence** (``is_crypto_topic``) — sans marqueur crypto,
       ``None`` immédiat, quelle que soit la tonalité du titre. C'est lui qui
       rend un flux tech mélangé exploitable ;
    2. la tonalité, avec la même hiérarchie que ``classify`` : conseil
       d'investissement -> ``None`` toujours ; puis neg > pos > watch.
    """
    if not is_crypto_topic(title):
        return None
    t = title.lower()
    if any(_keyword_matches(t, kw) for kw in _ADVICE_KEYWORDS):
        return None
    if any(_keyword_matches(t, kw) for kw in _CRYPTO_NEG_KEYWORDS):
        return "neg"
    if any(_keyword_matches(t, kw) for kw in _CRYPTO_POS_KEYWORDS):
        return "pos"
    if any(_keyword_matches(t, kw) for kw in _CRYPTO_WATCH_KEYWORDS):
        return "watch"
    return None


def format_crypto_message(title: str, link: str, sentiment: str,
                          symbol: Optional[str] = None) -> str:
    """Message Telegram d'une dépêche crypto. Ne recommande JAMAIS d'acheter —
    même doctrine que les deux autres volets."""
    head = {"neg": "Mauvaise nouvelle crypto",
            "pos": "Bonne nouvelle crypto"}.get(sentiment, "Catalyseur crypto à venir")
    tail = " — %s" % symbol if symbol else ""
    return ("[Simulateur] %s%s\n« %s »\n%s" % (head, tail, title, link))


# --- classification ÉCO (volet macroéconomie mondiale, 26/08 soir) --------- #

# GATE de pertinence, même rôle que ``_CRYPTO_MARKERS`` : sans marqueur macro,
# le titre n'est pas classé DU TOUT, quelle que soit sa tonalité. C'est lui qui
# empêche « Nvidia beats estimates » — une dépêche d'entreprise — d'entrer par
# la porte de l'économie mondiale et d'aller peser sur le pivot « monde ».
_ECO_MARKERS = [
    "fed", "federal reserve", "fomc", "powell", "central bank", "central banks",
    "ecb", "bce", "european central bank", "lagarde", "bank of england",
    "bank of japan", "boj", "snb", "monetary policy", "quantitative easing",
    "inflation", "cpi", "ppi", "deflation", "stagflation", "consumer prices",
    "interest rate", "interest rates", "rate hike", "rate cut", "rates",
    "recession", "gdp", "economic growth", "output gap",
    "unemployment", "jobless", "payrolls", "jobs report", "chômage",
    "oil", "crude", "opec", "brent", "wti", "energy prices", "gas prices",
    "treasury", "treasuries", "bond yield", "bond yields", "yields",
    "dollar", "euro", "yen", "trade deficit", "retail sales",
    "consumer confidence", "tariffs on imports",
    "taux directeur", "inflazione", "disoccupazione",
]

# Mauvaise nouvelle DÉJÀ TOMBÉE — prioritaire sur pos et watch.
#
# Les tournures l'emportent sur les mots nus partout où c'est possible :
# « recession » seul ferait passer « recession risk fades » pour une mauvaise
# nouvelle. On garde quelques mots nus (crash, stagflation, default) parce
# qu'ils ne s'écrivent jamais dans une bonne nouvelle.
_ECO_NEG_KEYWORDS = [
    "recession fears", "recession risk", "recession warning", "recession looms",
    "into recession", "enters recession", "contraction", "shrinks", "slowdown",
    "hard landing", "stagflation", "crash", "crashes",
    "inflation surges", "inflation accelerates", "inflation jumps",
    "inflation rises", "inflation climbs", "inflation heats",
    "prices surge", "price surge", "prices soar", "cost of living crisis",
    "rate hike", "hikes rates", "raises rates", "raise rates",
    "tightening", "plunge", "plunges", "slumps", "tumbles", "selloff",
    "sell-off", "default", "defaults", "downgrade", "downgraded",
    "layoffs", "job losses", "jobless claims rise", "unemployment rises",
    "unemployment jumps", "unemployment climbs",
    "oil prices surge", "oil prices jump", "energy crisis", "supply shock",
    "debt crisis", "banking crisis", "trade war", "yields spike",
    "worse than expected", "récession", "chute",
]

# Bonne nouvelle DÉJÀ TOMBÉE — prioritaire sur watch.
_ECO_POS_KEYWORDS = [
    "inflation cools", "inflation eases", "inflation slows", "inflation falls",
    "inflation drops", "inflation retreats", "price pressures ease",
    "rate cut", "rate cuts", "cuts rates", "cut rates", "lowers rates",
    "easing cycle", "soft landing", "growth beats", "beats forecasts",
    "better than expected", "recovery", "rebounds", "rebound",
    "unemployment falls", "unemployment drops", "jobless claims fall",
    "hiring accelerates", "oil prices fall", "oil prices ease",
    "energy prices fall", "upgrade", "upgraded", "record growth",
    "recul de l'inflation", "baisse des taux", "reprise économique",
    "inflazione rallenta", "taglio dei tassi",
]

# Catalyseur À VENIR — rien n'est tombé, c'est une anticipation.
#
# Une DÉCISION de taux y compris un STATU QUO est rangée ici, et c'est un choix :
# un « la Fed laisse ses taux inchangés » n'est ni une bonne ni une mauvaise
# nouvelle, c'est un jalon qui dit où la suite se joue. Le ranger en pos ou en
# neg mentirait ; le laisser tomber effacerait l'événement macro le plus suivi
# de tous.
_ECO_WATCH_KEYWORDS = [
    "fed meeting", "fomc meeting", "fomc minutes", "rate decision",
    "policy meeting", "policy decision", "ecb meeting", "boj meeting",
    "cpi report", "cpi data", "inflation data", "jobs report",
    "payrolls report", "gdp data", "opec meets", "opec meeting",
    "expected to", "is due", "are due", "due next", "ahead of", "set to",
    "scheduled for", "to decide", "awaits", "watch for",
    "holds rates", "holds interest rates", "keeps rates", "leaves rates",
    "rates unchanged", "holds steady", "stands pat",
    "réunion de la fed", "décision de taux", "taux inchangés",
    "riunione della fed", "tassi invariati",
]


def is_eco_topic(title: str) -> bool:
    """Le titre parle-t-il de macroéconomie ? (GATE de pertinence, PUR.)"""
    if not title:
        return False
    t = title.lower()
    return any(_keyword_matches(t, kw) for kw in _ECO_MARKERS)


def classify_eco(title: str) -> Optional[str]:
    """Classe un titre MACRO : ``"neg"`` | ``"pos"`` | ``"watch"`` | ``None`` (PUR).

    Deux étages, exactement comme ``classify_crypto`` : le **gate** d'abord
    (sans marqueur macro, ``None`` immédiat), la **tonalité** ensuite, avec la
    hiérarchie de la maison — conseil d'investissement -> ``None`` toujours
    (doctrine, piège #67d), puis neg > pos > watch.

    La tonalité est celle du MARCHÉ, pas celle du citoyen : une baisse des taux
    est ``pos`` parce qu'elle porte les actifs, une inflation qui repart est
    ``neg``. C'est la même convention que ``classify`` et ``classify_crypto``.
    """
    if not is_eco_topic(title):
        return None
    t = title.lower()
    if any(_keyword_matches(t, kw) for kw in _ADVICE_KEYWORDS):
        return None
    if any(_keyword_matches(t, kw) for kw in _ECO_NEG_KEYWORDS):
        return "neg"
    if any(_keyword_matches(t, kw) for kw in _ECO_POS_KEYWORDS):
        return "pos"
    if any(_keyword_matches(t, kw) for kw in _ECO_WATCH_KEYWORDS):
        return "watch"
    return None


def format_eco_message(title: str, link: str, sentiment: str,
                       symbol: Optional[str] = None) -> str:
    """Message Telegram d'une dépêche macro. Signale un CONTEXTE, ne recommande
    jamais un titre — même doctrine que les trois autres volets."""
    head = {"neg": "Mauvaise nouvelle économique",
            "pos": "Bonne nouvelle économique"}.get(
                sentiment, "Rendez-vous économique à venir")
    tail = " — %s" % symbol if symbol else ""
    return "[Simulateur] %s%s\n« %s »\n%s" % (head, tail, title, link)


# --- classification CLIMAT (volet écologie à impact, 26/08 soir) ----------- #

# L'aléa lui-même. Ne suffit PAS : cf. ``is_climat_topic``.
_CLIMAT_MARKERS = [
    "drought", "hurricane", "typhoon", "cyclone", "wildfire", "wildfires",
    "flood", "floods", "flooding", "heatwave", "heat wave", "heat dome",
    "crop failure", "climate policy", "climate change", "climate rules",
    "carbon tax", "carbon price", "emissions", "el nino", "el niño",
    "la nina", "frost", "monsoon", "storm", "storms", "blizzard", "hailstorm",
    "sécheresse", "canicule", "inondation", "inondations", "incendies",
    "ouragan", "tempête", "siccità", "alluvione", "incendi",
]

# La dimension ÉCONOMIQUE. C'est la MOITIÉ obligatoire du gate : « un ouragan
# sans dimension économique ne passe pas ». Un simulateur de bourse n'a pas à
# tenir la chronique météo du monde ; il a à savoir quand un aléa touche une
# récolte, une raffinerie, un assureur ou un prix.
_CLIMAT_IMPACT_MARKERS = [
    "economy", "economic", "price", "prices", "cost", "costs",
    "supply", "supplies", "supply chain", "shortage", "shortages",
    "crop", "crops", "harvest", "wheat", "corn", "coffee", "cocoa", "sugar",
    "cattle", "livestock", "farmers", "farmland",
    "insurance", "insurers", "insured", "claims",
    "production", "output", "refinery", "refineries", "oil", "gas", "power",
    "energy", "shipping", "ports", "exports", "imports", "trade",
    "damage", "damages", "losses", "billion", "million",
    "market", "markets", "utility", "utilities", "tourism",
    "récolte", "prix", "pénurie", "assurance", "raccolto", "prezzi",
]

# Mauvaise nouvelle DÉJÀ TOMBÉE.
_CLIMAT_NEG_KEYWORDS = [
    "destroys", "destroyed", "devastates", "devastated", "wipes out",
    "crop failure", "crop losses", "harvest fails", "failed harvest",
    "shortage", "shortages", "supply disruption", "disrupts", "disrupted",
    "halts production", "shuts down", "shutdown", "forced to close",
    "damage", "damages", "losses", "insured losses",
    "prices surge", "prices jump", "prices soar", "prices spike",
    "evacuated", "evacuation", "state of emergency", "emergency declared",
    "death toll", "record heat", "worst on record", "hits output",
    "cuts production", "slashes forecast",
    "détruit", "détruites", "ravage", "distrugge",
]

# Bonne nouvelle — RARE, et c'est normal : un aléa climatique fait rarement une
# bonne nouvelle. La liste existe pour ne pas classer en menace un marché qui
# se DÉTEND (une récolte record, une sécheresse qui se lève).
_CLIMAT_POS_KEYWORDS = [
    "record harvest", "bumper crop", "bumper harvest", "prices ease",
    "prices fall", "prices drop", "rains ease", "drought eases",
    "eases drought", "output recovers", "supply recovers",
    "returns to normal", "better than feared",
]

# Catalyseur À VENIR — l'aléa n'a pas encore frappé.
_CLIMAT_WATCH_KEYWORDS = [
    "approaching", "approaches", "braces for", "bracing for", "warning",
    "warns", "forecast", "forecasts", "expected to hit", "expected to",
    "set to hit", "on track to", "alert", "looms",
    "landfall expected", "could disrupt", "may disrupt", "prepares for",
    # Toutes les personnes du verbe : ``_keyword_matches`` compare un mot NU en
    # mot entier, donc « threaten » ne reconnaît pas « threatens » (mesuré sur
    # « Wildfires threaten California power supply », qui tombait à None).
    "threaten", "threatens", "threatened", "threat",
    "menace", "menacée", "menacées", "alerte", "minaccia",
]


def is_climat_topic(title: str) -> bool:
    """Le titre croise-t-il un aléa climatique ET une dimension économique ?
    (GATE, PUR.)

    Les DEUX sont exigés. « Hurricane approaches the Florida coast » parle de
    météo et rien d'autre : il ne passe pas, et c'est la règle qui empêche ce
    volet de devenir un fil d'actualité générale.
    """
    if not title:
        return False
    t = title.lower()
    if not any(_keyword_matches(t, kw) for kw in _CLIMAT_MARKERS):
        return False
    return any(_keyword_matches(t, kw) for kw in _CLIMAT_IMPACT_MARKERS)


def classify_climat(title: str) -> Optional[str]:
    """Classe un titre CLIMAT à impact : ``"neg"`` | ``"pos"`` | ``"watch"`` |
    ``None`` (PUR). Même architecture que ``classify_eco`` : gate, puis conseil
    -> ``None``, puis neg > pos > watch."""
    if not is_climat_topic(title):
        return None
    t = title.lower()
    if any(_keyword_matches(t, kw) for kw in _ADVICE_KEYWORDS):
        return None
    if any(_keyword_matches(t, kw) for kw in _CLIMAT_NEG_KEYWORDS):
        return "neg"
    if any(_keyword_matches(t, kw) for kw in _CLIMAT_POS_KEYWORDS):
        return "pos"
    if any(_keyword_matches(t, kw) for kw in _CLIMAT_WATCH_KEYWORDS):
        return "watch"
    return None


def format_climat_message(title: str, link: str, sentiment: str,
                          symbol: Optional[str] = None) -> str:
    """Message Telegram d'une dépêche climatique à impact économique."""
    head = {"neg": "Aléa climatique — impact économique",
            "pos": "Détente climatique — impact économique"}.get(
                sentiment, "Aléa climatique à venir")
    tail = " — %s" % symbol if symbol else ""
    return "[Simulateur] %s%s\n« %s »\n%s" % (head, tail, title, link)


# --- classification BANQUES CENTRALES (volet « bc », W2a) ------------------ #
#
# Pas de GATE de pertinence, et c'est le point : ces trois flux sont
# INTÉGRALEMENT de la banque centrale. Un gate y serait une seconde opinion sur
# une source qui n'en a pas besoin — et il ferait taire précisément ce qu'on est
# venu chercher (un communiqué dont le titre ne contient aucun mot-clé macro,
# « Statement by the Board of Governors », est exactement le communiqué qui
# compte).
#
# La tonalité est celle du MARCHÉ, comme partout ailleurs dans ce fichier : un
# resserrement est ``neg`` (il pèse sur les actifs), une détente est ``pos``.
_BC_NEG_KEYWORDS = [
    "emergency", "unscheduled", "intervention", "intervenes", "intervened",
    "crisis", "bailout", "rescue", "failure", "failed bank", "resolution",
    "enforcement action", "cease and desist", "penalty", "fine", "fines",
    "sanction", "suspends", "suspension", "restrictions", "systemic risk",
    "raises rates", "raise rates", "rate hike", "rate increase", "hikes",
    "tightening", "tighter policy", "quantitative tightening",
    "hausse des taux", "resserrement", "rialzo dei tassi",
]

# RARE, et c'est normal : une banque centrale annonce rarement une bonne
# nouvelle en toutes lettres. La liste existe pour ne pas ranger une DÉTENTE
# parmi les menaces.
_BC_POS_KEYWORDS = [
    "rate cut", "rate cuts", "cuts rates", "cut rates", "lowers rates",
    "lower rates", "lowers the target", "easing", "accommodative",
    "asset purchases", "liquidity support", "swap line", "swap lines",
    "baisse des taux", "assouplissement", "taglio dei tassi",
]


def classify_bc(title: str) -> Optional[str]:
    """Classe un communiqué de banque centrale : ``"neg"`` | ``"pos"`` |
    ``"watch"`` (PUR). Ne rend ``None`` que sur un titre VIDE — ou sur un conseil
    d'investissement, cas qui n'arrivera jamais depuis ces sources mais dont la
    garde reste posée : la doctrine « on ne relaie jamais un conseil » (piège
    #67d) ne souffre aucune exception de provenance.

    ``"watch"`` est le DÉFAUT, pas un repli : un communiqué, un procès-verbal, un
    discours de gouverneur sont par nature des choses **à surveiller**. Les
    ranger en pos ou en neg serait prétendre lire une décision que le texte ne
    contient pas.
    """
    if not title:
        return None
    t = title.lower()
    if any(_keyword_matches(t, kw) for kw in _ADVICE_KEYWORDS):
        return None
    if any(_keyword_matches(t, kw) for kw in _BC_NEG_KEYWORDS):
        return "neg"
    if any(_keyword_matches(t, kw) for kw in _BC_POS_KEYWORDS):
        return "pos"
    return "watch"


def format_bc_message(title: str, link: str, sentiment: str,
                      symbol: Optional[str] = None) -> str:
    """Message Telegram d'un communiqué de banque centrale.

    L'en-tête dit d'où ça vient — « source officielle » — parce que c'est
    précisément ce qui distingue ce volet des trois autres : ce n'est pas un
    journal qui rapporte, c'est l'institution qui parle.
    """
    head = {"neg": "Banque centrale — resserrement ou mesure d'urgence",
            "pos": "Banque centrale — détente"}.get(
                sentiment, "Banque centrale — publication à surveiller")
    tail = " — %s" % symbol if symbol else ""
    return ("[Simulateur] %s%s (source officielle)\n« %s »\n%s"
            % (head, tail, title, link))


# --- classification des posts X (volet « comptes influents », 26/08) ------- #

def x_post_title(text: str) -> str:
    """Le post ramené à un titre lisible : espaces normalisés, tronqué à
    ``_X_POST_MAX_LEN`` (PUR). Un post de 4 000 caractères n'est pas un titre."""
    compact = " ".join(str(text or "").split())
    if len(compact) <= _X_POST_MAX_LEN:
        return compact
    return compact[:_X_POST_MAX_LEN - 1].rstrip() + "…"


def cashtag_symbol(text: str) -> Optional[str]:
    """Le premier ``$TICKER`` du post, en majuscules, ou ``None`` (PUR)."""
    match = _CASHTAG_RE.search(str(text or ""))
    return match.group(1) if match else None


def classify_x(text: str, anchors: Any = None) -> Optional[Dict[str, Any]]:
    """Un post X est-il IMPORTANT ? -> ``{"sentiment", "symbol"}`` ou ``None``.

    C'est la demande explicite : « important seulement ». Quatre portes, aucune
    ouverte par défaut — un mème, une photo, une pique politique sans contenu
    économique ne franchit rien et disparaît :

    1. un **cashtag** ``$TICKER`` — l'auteur parle explicitement d'un titre. Le
       ton est alors affiné par le classifieur ordinaire (``classify``), et à
       défaut c'est un simple « à surveiller » ;
    2. **impact politique/économique** (``classify_gov``, réutilisé tel quel) ->
       ``gov``, exactement comme une dépêche du volet politique ;
    3. **crypto** (``classify_crypto``, réutilisé tel quel) -> son ton et sa
       paire Yahoo ;
    4. une **entreprise NOMMÉE** (``entities.first_company``, extension du
       26/08) — « Trump veut acheter des cartes graphiques à Nvidia » ne porte
       ni cashtag, ni mot politique de la liste, ni marqueur crypto, et
       disparaissait donc en silence alors qu'il parle très précisément d'un
       titre. ``anchors`` = les noms des positions et de la watchlist (cf.
       ``entities.anchor_index``), qui PRIMENT sur la table livrée.

    Ordre de priorité : ``gov`` puis ``crypto`` puis le cashtag puis
    l'entreprise nommée. Un post qui annonce des droits de douane ET cite
    ``$F`` est d'abord une annonce politique — mais il garde le symbole, qui
    reste l'information la plus précise qu'il porte ; et à défaut de cashtag,
    c'est l'entreprise nommée qui le fournit.
    """
    if not text:
        return None
    body = str(text)
    if any(_keyword_matches(body.lower(), kw) for kw in _ADVICE_KEYWORDS):
        return None

    cash = cashtag_symbol(body)
    named = entities.first_company(body, anchors)
    if classify_gov(body):
        return {"sentiment": "gov", "symbol": cash or named}
    crypto = classify_crypto(body)
    if crypto:
        return {"sentiment": crypto, "symbol": cash or crypto_symbol(body) or named}
    if cash:
        return {"sentiment": classify(body) or "watch", "symbol": cash}
    if named:
        return {"sentiment": classify(body) or "watch", "symbol": named}
    return None


def format_x_message(handle: str, title: str, link: str, sentiment: str,
                     symbol: Optional[str] = None) -> str:
    """Message Telegram d'un post X retenu. Signale, ne recommande jamais."""
    tail = " — %s" % symbol if symbol else ""
    return ("[Simulateur] Compte suivi @%s%s\n« %s »\n%s"
            % (handle, tail, title, link))


def format_pressefi_message(source: str, title: str, link: str, sentiment: str,
                            symbol: Optional[str] = None) -> str:
    """Message Telegram d'une dépêche de presse mondiale.

    Le NOM DU JOURNAL est affiché : sur ce volet, il est la moitié de
    l'information. « Nestlé rachète » vu par la NZZ et vu par le South China
    Morning Post ne se lisent pas de la même façon, et savoir d'où ça vient est
    ce qui permet à Massii de juger sans nous croire sur parole.
    """
    label = {"neg": "Mauvaise nouvelle", "pos": "Bonne nouvelle"}.get(
        sentiment, "Catalyseur à venir")
    who = " ".join(str(source or "").split()) or "presse"
    tail = " — %s" % symbol if symbol else ""
    return ("[Simulateur] %s (%s)%s\n« %s »\n%s"
            % (label, who, tail, title, link))


def classify_social(text: str, anchors: Any = None) -> Optional[Dict[str, Any]]:
    """Un post SOCIAL est-il important ? -> ``{"sentiment", "symbol"}`` ou
    ``None`` (PUR).

    C'est ``classify_x`` — ses quatre portes, dans son ordre — plus **deux
    portes de plus**, et elles ne sont pas décoratives : les deux requêtes fixes
    du volet Bluesky (« market selloff », « rate decision ») ramènent
    précisément des posts MACRO. Or « the Fed cuts rates » ne porte ni cashtag,
    ni mot de ``_GOV_KEYWORDS``, ni marqueur crypto, ni nom d'entreprise : sans
    ces deux portes, les deux requêtes génériques ne rendraient jamais rien et
    le volet serait un décor.

    5. **macroéconomie** (``classify_eco``, gate compris) ;
    6. **climat à impact économique** (``classify_climat``, dont le gate exige
       DÉJÀ un aléa ET une dimension économique — la porte la plus étroite des
       six, donc la moins susceptible de laisser passer du bruit).

    Le symbole reste celui de l'entreprise NOMMÉE quand il y en a une : une
    dépêche macro qui cite Nestlé rejoint la branche de Nestlé, pas le pivot
    « monde ». ``classify_x`` n'est PAS modifiée — le volet X garde exactement
    le comportement épinglé par ses tests, et cette extension ne vaut que pour
    les canaux qui la demandent.
    """
    verdict = classify_x(text, anchors)
    if verdict is not None:
        return verdict
    if not text:
        return None
    body = str(text)
    for classifier in (classify_eco, classify_climat):
        sentiment = classifier(body)
        if sentiment:
            return {"sentiment": sentiment,
                    "symbol": entities.first_company(body, anchors)}
    return None


def format_bsky_message(author: str, title: str, link: str, sentiment: str,
                        symbol: Optional[str] = None) -> str:
    """Message Telegram d'un post Bluesky retenu.

    L'auteur est affiché SANS ``@`` collé au nom : un handle Bluesky est un nom
    de domaine (``ledger.bsky.social``), l'arobase y ferait croire à un compte X.
    """
    who = str(author or "").strip() or "inconnu"
    tail = " — %s" % symbol if symbol else ""
    return ("[Simulateur] Bluesky (%s)%s\n« %s »\n%s"
            % (who, tail, title, link))


# --- Bluesky : les requêtes, construites à chaque cycle (PUR) -------------- #

def _anchor_names(anchors: Any) -> List[str]:
    """Un nom par SYMBOLE ancré, ordre déterministe (PUR).

    ``anchors`` est ``{nom en minuscules: SYMBOLE}`` (cf.
    ``entities.anchor_index``) : plusieurs clés y pointent le même symbole — le
    nom complet, le nom sans sa forme juridique, ET LE TICKER LUI-MÊME. D'où
    deux règles de choix, les deux mesurées :

    1. **le ticker est un DERNIER RECOURS.** « nesn.sw stock » ne ramène rien sur
       un réseau social, « nestle stock » ramène ce dont les gens parlent — et
       c'est le ticker qui gagnait tant qu'on prenait le nom le plus LONG
       (« nesn.sw » fait sept caractères, « nestle » six) ;
    2. entre deux VRAIS noms, **le plus court gagne** : c'est la MARQUE.
       « apple » trouve ce que « apple inc. » manque, et ``strip_legal_suffix``
       garantit déjà que le plus court reste un nom, pas un fragment.

    Le tri final se fait par SYMBOLE pour que deux cycles produisent exactement
    la même liste de requêtes.
    """
    if not isinstance(anchors, dict):
        return []
    best: Dict[str, Tuple[int, int, str]] = {}
    for name, symbol in anchors.items():
        key = str(symbol or "").strip().upper()
        value = " ".join(str(name or "").split())
        if not key or not value:
            continue
        # (0) un vrai nom passe avant (1) le ticker ; puis le plus court ; puis
        # l'ordre alphabétique, pour ne jamais dépendre de l'ordre du dict.
        rank = (1 if value.lower() == key.lower() else 0, len(value), value)
        if key not in best or rank < best[key]:
            best[key] = rank
    return [best[symbol][2] for symbol in sorted(best)]


def bsky_queries(anchors: Any = None,
                 fixed: Any = BSKY_FIXED_QUERIES,
                 cap: int = BSKY_MAX_ANCHOR_QUERIES) -> List[str]:
    """Les requêtes de recherche Bluesky de ce cycle (PUR).

    Les deux fixes d'abord (le monde), puis au plus ``cap`` requêtes d'ancre (ce
    portefeuille). Dédoublonnées sans tenir compte de la casse, ordre stable.

    **Invariant, leçon #68k : toute requête rendue a au moins DEUX mots.** Un
    nom d'ancre d'un seul mot se voit adjoindre ``BSKY_ANCHOR_SUFFIX``
    (« nestle » -> « nestle stock ») ; une requête fixe d'un seul mot est
    REFUSÉE plutôt que rafistolée — si quelqu'un en écrit une un jour, c'est le
    catalogue qu'il faut corriger, pas la requête qu'il faut deviner.
    """
    out: List[str] = []
    seen = set()

    def _add(query: str) -> None:
        clean = " ".join(str(query or "").split())
        if len(clean.split()) < 2 or clean.lower() in seen:
            return
        seen.add(clean.lower())
        out.append(clean)

    for query in (fixed or ()):
        _add(query)
    for name in _anchor_names(anchors)[:max(0, int(cap))]:
        _add(name if len(name.split()) >= 2
             else "%s %s" % (name, BSKY_ANCHOR_SUFFIX))
    return out


def normalize_handles(values: Any) -> List[str]:
    """Liste de comptes X validée (PUR) : ``@`` retiré, format
    ``^[A-Za-z0-9_]{1,15}$``, dédoublonnée sans tenir compte de la casse,
    plafonnée à ``X_MAX_HANDLES``.

    On REJETTE en silence un handle invalide plutôt que de le corriger : un
    nom sanitisé pointerait sur un AUTRE compte que celui demandé.
    """
    out: List[str] = []
    seen = set()
    if not isinstance(values, (list, tuple)):
        return out
    for raw in values:
        handle = str(raw or "").strip().lstrip("@")
        if not _X_HANDLE_RE.match(handle) or handle.lower() in seen:
            continue
        seen.add(handle.lower())
        out.append(handle)
        if len(out) >= X_MAX_HANDLES:
            break
    return out


# --------------------------------------------------------------------------- #
# DÉCOUVERTE de comptes X — la file de probation (PUR)
#
# Doctrine : **la liste grandit depuis le réseau de ce qu'on lit déjà.** On ne
# va pas chercher des comptes dans un annuaire ni dans un classement de
# popularité — on regarde qui les comptes et les journaux qu'on lit DÉJÀ citent.
# Un compte cité par une source qu'on a jugée digne d'être lue a, par
# construction, une chance d'être lui aussi digne d'être lu.
#
# Et on ne le croit pas sur parole : il entre en PROBATION. Interrogé à basse
# fréquence, muet par construction (ses événements naissent en sourdine), il ne
# rejoint la vraie liste qu'après ``X_CANDIDATE_PROMOTE_HITS`` publications
# jugées importantes par le classifieur ordinaire. Sans rien de tel au bout de
# ``X_CANDIDATE_EVICT_POLLS`` passages, il repart — la file ne se transforme pas
# en cimetière.
# --------------------------------------------------------------------------- #

def extract_mentions(text: Any) -> List[str]:
    """Les comptes ``@mentionnés`` dans un texte (PUR).

    Dédoublonnés sans tenir compte de la casse, dans l'ordre d'apparition, avec
    la casse d'ORIGINE (un handle X est insensible à la casse mais s'affiche
    comme son porteur l'écrit).

    Trois gardes valent d'être dites :

    * la mention doit être un MOT (pas d'``@`` collé à une lettre, sinon
      ``john@example.com`` deviendrait un compte) ;
    * un jeton de plus de quinze caractères est JETÉ, pas tronqué — au-delà, ce
      n'est plus un handle X, et en tronquer un fabriquerait un compte qui
      n'existe pas ;
    * ⚠️ un jeton suivi d'un **point puis d'une lettre ou d'un chiffre** est
      jeté aussi : c'est un NOM DE DOMAINE, donc une mention **Bluesky**
      (``@nytimes.com``, ``@bloomberg.bsky.social``), pas un handle X. Sans
      cette garde on gardait la TÊTE (``nytimes``, ``bloomberg``) et on
      inscrivait dans la file de probation un compte X *inventé* : il rend 404,
      deux 404 valaient une escalade, et on démarrait un Chrome furtif pour un
      compte qui n'existe pas — jusqu'à dix fois par heure. Le volet Bluesky en
      ramène à chaque passage : le robinet ne se fermait jamais.

    Le test porte sur le point ET sur ce qui le suit : un point de FIN DE PHRASE
    (« merci @elonmusk. ») n'est pas un domaine, et ce compte-là existe. La
    garde est écrite EN PYTHON et non dans l'expression — un ``(?!\\.)`` ferait
    BACKTRACKER le moteur, qui accepterait alors ``nytime``, c'est-à-dire
    exactement le compte inventé qu'on cherche à éviter (même piège que la note
    de ``_MENTION_RE``).
    """
    body = str(text or "")
    out: List[str] = []
    seen = set()
    for match in _MENTION_RE.finditer(body):
        handle = match.group(1)
        if len(handle) > X_HANDLE_MAX_LEN or handle.lower() in seen:
            continue
        tail = body[match.end():match.end() + 2]
        if tail[:1] == "." and tail[1:2].isalnum():
            continue                  # domaine -> mention Bluesky, pas un handle X
        seen.add(handle.lower())
        out.append(handle)
    return out


def note_mentions(candidates: Any, mentions: Any, now_iso: str,
                  known: Any = (), cap: int = X_CANDIDATE_MAX) -> List[str]:
    """Inscrit des comptes mentionnés dans la file de probation — MUTE
    ``candidates`` et rend la liste des handles RÉELLEMENT ajoutés (PUR au sens
    « aucune I/O »).

    Trois refus, tous silencieux : un compte DÉJÀ suivi (il n'est pas candidat,
    il est en poste), un compte déjà candidat (son compteur ne repart pas de
    zéro à chaque citation — sinon un compte cité tous les jours ne serait
    jamais ni promu ni éjecté), et tout le reste une fois le cap atteint.
    """
    if not isinstance(candidates, dict):
        return []
    followed = {str(h or "").strip().lstrip("@").lower()
                for h in (known or ()) if str(h or "").strip()}
    existing = {str(h).lower() for h in candidates}
    added: List[str] = []
    for handle in (mentions or []):
        name = str(handle or "").strip().lstrip("@")
        low = name.lower()
        if not _X_HANDLE_RE.match(name) or low in followed or low in existing:
            continue
        if len(candidates) >= max(0, int(cap)):
            break
        candidates[name] = {"first_seen": now_iso, "polls": 0, "hits": 0}
        existing.add(low)
        added.append(name)
    return added


def candidate_verdict(entry: Any,
                      promote_hits: int = X_CANDIDATE_PROMOTE_HITS,
                      evict_polls: int = X_CANDIDATE_EVICT_POLLS) -> str:
    """Le sort d'un candidat : ``"promote"`` | ``"evict"`` | ``"keep"`` (PUR).

    L'éjection exige ``hits == 0`` : un candidat qui a montré UNE chose
    intéressante mais pas deux n'est pas un mauvais compte, c'est un compte
    lent — on le garde. Seul le silence complet est éliminatoire.

    Un état illisible rend ``"keep"`` : on ne promeut ni n'éjecte sur une
    donnée qu'on ne sait pas lire.
    """
    if not isinstance(entry, dict):
        return "keep"
    try:
        hits = int(entry.get("hits") or 0)
        polls = int(entry.get("polls") or 0)
    except (TypeError, ValueError):
        return "keep"
    if hits >= promote_hits:
        return "promote"
    if hits <= 0 and polls >= evict_polls:
        return "evict"
    return "keep"


def _int_field(entry: Dict[str, Any], key: str) -> int:
    """Un compteur d'entrée de file, illisible -> 0 (PUR)."""
    try:
        return int(entry.get(key) or 0)
    except (TypeError, ValueError):
        return 0


def promote_candidates(candidates: Any, known: Any,
                       cap: int = X_MAX_HANDLES,
                       pending_seen: Any = None,
                       pending_polls: int = X_CANDIDATE_PENDING_POLLS
                       ) -> Dict[str, List[str]]:
    """Applique les verdicts à toute la file — MUTE ``candidates``.

    Rend ``{"promoted", "pending", "evicted", "released"}``.

    **La liste manuelle est intouchable.** Quand elle est PLEINE, un candidat qui
    a fait ses preuves n'évince personne : il est marqué ``pending_manual`` et
    reste dans la file, visible. Évincer un compte que Massii a choisi lui-même
    au profit d'un compte découvert tout seul, ce serait décider à sa place —
    et il n'aurait aucun moyen de savoir ce qui a disparu.

    ``pending`` ne liste que les candidats NOUVELLEMENT en attente : sans ça,
    l'appelant rejournaliserait les mêmes noms toutes les dix minutes jusqu'à
    ce qu'une place se libère. Le drapeau, lui, reste posé — et il n'empêche
    JAMAIS une promotion le jour où une place se libère vraiment.

    ⚠️ **Mais il ne squatte plus la file à vie.** Un candidat en attente a un
    verdict « promote » PERPÉTUEL et l'éjection ordinaire exige ``hits == 0`` :
    il ne pouvait donc plus jamais sortir. Dix comptes dans cet état, et plus
    aucune inscription n'était possible — la découverte mourait, sans un mot.
    Après ``pending_polls`` passages de plus, il est **libéré** (``released``),
    et son nom rejoint ``pending_seen`` (liste MUTÉE, plafonnée à
    ``X_PENDING_SEEN_MAX``, les plus récents gardés) pour qu'on sache ce qu'on
    a laissé partir. Une place qui se libère AVANT ce délai le promeut quand
    même : la libération est un plan B, pas une condamnation.
    """
    result = {"promoted": [], "pending": [], "evicted": [], "released": []}
    if not isinstance(candidates, dict):
        return result
    room = max(0, int(cap) - len(normalize_handles(list(known or []))))
    for handle in sorted(candidates):
        entry = candidates.get(handle)
        verdict = candidate_verdict(entry)
        if verdict == "evict":
            candidates.pop(handle, None)
            result["evicted"].append(handle)
        elif verdict == "promote":
            if room > 0:
                candidates.pop(handle, None)
                result["promoted"].append(handle)
                room -= 1
                continue
            if not isinstance(entry, dict):
                continue
            already = bool(entry.get("pending_manual"))
            entry["pending_manual"] = True
            if not already:
                # Le passage de RÉFÉRENCE, posé une seule fois : c'est de lui
                # que se compte l'attente. Un état écrit avant cette extension
                # n'en a pas -> il le reçoit ici et repart pour un tour plein.
                entry["pending_since_polls"] = _int_field(entry, "polls")
                result["pending"].append(handle)
                continue
            entry.setdefault("pending_since_polls", _int_field(entry, "polls"))
            waited = _int_field(entry, "polls") - _int_field(entry, "pending_since_polls")
            if waited >= max(0, int(pending_polls)):
                candidates.pop(handle, None)
                result["released"].append(handle)
                _note_pending_seen(pending_seen, handle, entry)
    return result


def _note_pending_seen(pending_seen: Any, handle: str,
                       entry: Dict[str, Any]) -> None:
    """Garde la trace d'un candidat LIBÉRÉ faute de place — MUTE la liste.

    Ce n'est pas une file de travail, c'est un pense-bête : « ces comptes-là
    avaient fait leurs preuves, la liste manuelle était pleine ». Plafonné, les
    plus récents gardés (une trace qui grossit sans fin n'est plus une trace).
    """
    if not isinstance(pending_seen, list):
        return
    pending_seen.append({
        "handle": handle,
        "hits": _int_field(entry, "hits"),
        "first_seen": str(entry.get("first_seen") or ""),
    })
    if len(pending_seen) > X_PENDING_SEEN_MAX:
        pending_seen[:] = pending_seen[-X_PENDING_SEEN_MAX:]


def reddit_group(counter: Any) -> Tuple[str, ...]:
    """Le groupe de subreddits à interroger à ce passage (PUR).

    Alternance stricte sur un compteur qui monte à CHAQUE passage, réussi ou
    non : c'est ce qui garantit qu'un groupe en panne ne peut pas retenir
    l'autre en otage — le passage suivant change de groupe quoi qu'il arrive.

    Compteur illisible -> le premier groupe (le groupe historique), jamais une
    exception : un état corrompu ne doit pas éteindre le volet.
    """
    try:
        index = int(counter)
    except (TypeError, ValueError):
        index = 0
    if not REDDIT_GROUPS:
        return ()
    return REDDIT_GROUPS[index % len(REDDIT_GROUPS)]


def cycle_due(cycle: Any, every: Any) -> bool:
    """Ce cycle doit-il faire tourner un volet cadencé ? (PUR.)

    Généralisation de ``x_cycle_due``/``reddit_cycle_due`` pour les volets
    arrivés ensuite (banques centrales, presse mondiale, Bluesky), qui n'ont pas
    tous la même période. Même posture qu'eux sur une donnée illisible :
    ``True`` — un état corrompu ne doit jamais éteindre un volet pour toujours.
    """
    try:
        period = int(every)
    except (TypeError, ValueError):
        return True
    if period <= 1:
        return True
    try:
        return int(cycle) % period == 0
    except (TypeError, ValueError):
        return True


def x_cycle_due(cycle: Any) -> bool:
    """Ce cycle doit-il interroger X ? (PUR — un cycle sur ``_X_CYCLE_EVERY``.)

    Compteur illisible -> ``True`` : mieux vaut un passage de trop qu'un volet
    éteint pour toujours par un état corrompu.
    """
    try:
        return int(cycle) % _X_CYCLE_EVERY == 0
    except (TypeError, ValueError):
        return True


def calendar_cycle_due(cycle: Any) -> bool:
    """Ce cycle doit-il juger les rendez-vous échus ? (PUR — un cycle sur
    ``_CALENDAR_CYCLE_EVERY``.)

    Même posture qu'``x_cycle_due``/``reddit_cycle_due`` pour un compteur
    illisible : ``True``. Un état corrompu ne doit pas éteindre pour toujours la
    seule boucle qui dit ce qui s'est VRAIMENT passé au rendez-vous — et un
    passage de trop ne coûte que des cotations déjà mises en cache.
    """
    try:
        return int(cycle) % _CALENDAR_CYCLE_EVERY == 0
    except (TypeError, ValueError):
        return True


def reddit_cycle_due(cycle: Any) -> bool:
    """Ce cycle doit-il interroger Reddit ? (PUR — un cycle sur
    ``_REDDIT_CYCLE_EVERY``, soit ~15 min.)

    Même posture que ``x_cycle_due`` pour un compteur illisible : ``True``, on
    ne laisse pas un état corrompu éteindre un volet pour toujours. Le plafond
    de Reddit (1 req/60 s) reste respecté avec une marge de quinze : un cycle de
    trop ne coûte rien, un volet mort ne se voit jamais.
    """
    try:
        return int(cycle) % _REDDIT_CYCLE_EVERY == 0
    except (TypeError, ValueError):
        return True


# --- tendances Reddit : le compteur de mentions (PUR) ---------------------- #
#
# Ce qui est PERSISTÉ (``reddit_trends`` de l'état global) est
# ``{SYMBOLE: [horodatage ISO, ...]}`` — les mentions elles-mêmes. Ce qui est
# CONSOMMÉ (convergence, toile, router) est ``{SYMBOLE: {count, prev}}``,
# recalculé à la lecture par ``trends_view``.
#
# Pourquoi pas stocker directement les deux compteurs ? Parce qu'une fenêtre
# GLISSANTE ne se recalcule pas depuis un compteur nu : à 14 h, « les 24
# dernières heures » ne contiennent plus ce qu'elles contenaient à 13 h. Sans
# les horodatages, on ne pourrait que remettre le compteur à zéro à heure fixe
# — et un pic qui traverse minuit deviendrait invisible.

def _iso_dt(value: Any) -> Optional[datetime]:
    """Un horodatage ISO -> datetime AWARE (UTC si le fuseau manque). Illisible
    -> ``None`` (même prudence que ``_purge_old_seen``)."""
    try:
        parsed = datetime.fromisoformat(str(value))
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def purge_trends(trends: Any, now_dt: datetime,
                 max_age_h: float = REDDIT_TREND_MAX_AGE_H,
                 cap: int = REDDIT_TRENDS_MAX) -> None:
    """Purge EN PLACE le compteur de mentions (PUR).

    Trois coupes : les horodatages plus vieux que ``max_age_h`` (ils ne peuvent
    plus peser sur aucune des deux fenêtres), les symboles qui n'en ont plus
    aucun, puis les symboles au-delà de ``cap`` — on garde les plus mentionnés,
    le symbole tranchant les ex æquo pour que deux purges rendent exactement le
    même état. Un horodatage illisible est purgé par prudence, comme partout
    ailleurs dans ce module.

    Elle NORMALISE aussi : une valeur qui n'est pas une liste d'horodatages
    disparaît. C'est ce qui rend le volet insensible à un état corrompu.
    """
    if not isinstance(trends, dict):
        return
    cutoff = now_dt.timestamp() - max_age_h * 3600
    kept: Dict[str, List[str]] = {}
    for symbol, stamps in trends.items():
        if not isinstance(symbol, str) or not isinstance(stamps, list):
            continue
        fresh = []
        for raw in stamps:
            parsed = _iso_dt(raw)
            if parsed is not None and parsed.timestamp() >= cutoff:
                fresh.append(raw)
        if fresh:
            kept[symbol] = fresh
    if len(kept) > cap:
        ranked = sorted(kept.items(), key=lambda kv: (-len(kv[1]), kv[0]))
        kept = dict(ranked[:cap])
    trends.clear()
    trends.update(kept)


def trends_view(trends: Any, now: Any = None) -> Dict[str, Dict[str, int]]:
    """``{SYMBOLE: {"count", "prev"}}`` depuis les mentions brutes (PUR).

    ``count`` = mentions des ``REDDIT_TREND_WINDOW_H`` dernières heures,
    ``prev`` = mentions des ``REDDIT_TREND_WINDOW_H`` heures d'AVANT. C'est le
    rapport des deux qui dit « la foule s'agite », pas le volume absolu.

    Un symbole dont ``count`` est nul est OMIS : afficher « SYM ×0 » sur la
    toile ou le proposer au digest serait du bruit — sa seule histoire, c'est
    qu'il ne se passe plus rien.
    """
    now_dt = now if isinstance(now, datetime) else datetime.now(timezone.utc)
    if now_dt.tzinfo is None:
        now_dt = now_dt.replace(tzinfo=timezone.utc)
    recent_cut = now_dt.timestamp() - REDDIT_TREND_WINDOW_H * 3600
    older_cut = now_dt.timestamp() - 2 * REDDIT_TREND_WINDOW_H * 3600

    out: Dict[str, Dict[str, int]] = {}
    if not isinstance(trends, dict):
        return out
    for symbol, stamps in trends.items():
        if not isinstance(symbol, str) or not isinstance(stamps, list):
            continue
        count = prev = 0
        for raw in stamps:
            parsed = _iso_dt(raw)
            if parsed is None:
                continue
            when = parsed.timestamp()
            if when >= recent_cut:
                count += 1
            elif when >= older_cut:
                prev += 1
        if count:
            out[symbol] = {"count": count, "prev": prev}
    return out


# --- anti-spam du volet politique : clé d'HISTOIRE (cf. le commentaire de
# tête de fichier ~L99 pour le design complet -- deux couches, story_key ici
# pour la couche 1) ---------------------------------------------------------- #

# 4 et non 6 : la règle PRIMAIRE décrite au design (les 6 tokens
# significatifs les plus longs) a été essayée en premier et NE CONVERGE PAS
# naturellement sur les paires réelles de calibration -- des mots longs mais
# non partagés ("economic"/"unveils"/"partners") battent systématiquement des
# mots courts mais identifiants ("Iran"/"US") dans une sélection par
# longueur. Repli DOCUMENTÉ (comme prévu) : 4 tokens, triés alphabétiquement.
# Validé par calibration -- cf. tests test_story_key_*.
_STORY_KEY_TOKENS = 4
_STORY_KEY_TRUNC = 6   # troncature légère type "stemming pauvre" -- unifie
                        # threatened/threats -> "threat", tariff/tariffs ->
                        # "tariff", sans dépendance externe.

_STORY_KEY_STOPWORDS = frozenset(
    ("the a an of to on as and in for with after new les des sur "
     "at its against by from "
     "le la les des du un une et ou mais donc car dans sous avec sans pour "
     "par en au aux ce cet cette ces qui que quoi dont").split()
) | frozenset({
    # Verbes de reportage génériques -- omniprésents dans les titres de
    # presse quel que soit le SUJET (annoncer/dévoiler/avertir...), donc zéro
    # pouvoir discriminant pour identifier UNE histoire précise (même
    # raisonnement que "new"/"after" ci-dessus, juste plus long à énumérer).
    "unveils", "unveiled", "announces", "announced", "says", "said",
    "tells", "told", "warns", "warned", "reports", "reported",
    "vows", "vowed", "urges", "urged", "look", "looks", "looking",
    "eyes", "eyed",
    # "trump" : quasi omniprésent dans CE flux précis -- la requête Google
    # News de _GOV_SOURCES filtre déjà sur Trump/White House/executive
    # order -- donc zéro pouvoir discriminant pour séparer une histoire
    # d'une autre ICI (vérifié sans collision entre histoires réellement
    # différentes dans les tests de calibration).
    "trump",
})

# Suffixe " - Source" de Google News (1 à 5 mots après le tiret -- borné pour
# ne pas avaler une vraie clause finale du titre qui utiliserait aussi un
# tiret comme séparateur).
_GNEWS_SUFFIX_RE = re.compile(r"\s+-\s+[A-Za-z0-9.&']+(?:\s+[A-Za-z0-9.&']+){0,4}$")
# Citation entre guillemets (droits ou courbes) : la formule PERSONNELLE de
# quelqu'un, pas le fait rapporté par l'article -- ne se retrouve quasiment
# jamais telle quelle dans la reprise d'un autre média.
_QUOTED_RE = re.compile(r'["“”].*?["“”]')
# "trading partner(s)" : formule diplomatique générique (n'importe quel pays
# a des "trading partners") -- même statut que "trade deal"/"executive
# order", déjà traités comme génériques dans _GOV_KEYWORDS.
_TRADING_PARTNERS_RE = re.compile(r"trading partners?", re.IGNORECASE)
_STORY_KEY_PUNCT_RE = re.compile(r"[^a-z0-9]+")
# Codes d'entité assez courts pour tomber sous le filtre de longueur, assez
# identifiants pour qu'on les garde quand même (US/UE/UK/ONU).
_STORY_ENTITY_CODES = ("us", "eu", "uk", "un")


def story_tokens(title: str) -> List[str]:
    """Les tokens SIGNIFICATIFS d'un titre (PUR) -- l'étage COMMUN de
    ``story_key`` et du regroupement thématique du graphe.

    Pipeline : retrait du suffixe " - Source" de Google News -> retrait des
    citations entre guillemets -> retrait de la formule "trading partner(s)"
    -> minuscules -> retrait ponctuation -> retrait stopwords EN/FR + verbes
    de reportage génériques + "trump" (cf. _STORY_KEY_STOPWORDS) -> retrait
    des tokens courts non identifiants.

    Rend les formes de SURFACE, dans l'ordre du titre et SANS dédoublonnage :
    c'est le seul étage où l'on sait encore que le titre dit "tariffs" et pas
    "tariff" -- ``story_key`` tronque juste après (cf. ``story_stem``), et le
    graphe a besoin des deux (le stem pour RAPPROCHER deux variantes, la
    surface pour ÉCRIRE un nom de thème lisible).

    Sorti de ``story_key`` le 26/08 pour que graph.theme_clusters emprunte
    exactement le même découpage -- deux tokenisations finiraient par diverger,
    et un thème nommé sur d'autres mots que ceux qui l'ont formé se lirait
    comme un bug de la mémoire.
    """
    if not title:
        return []
    t = _GNEWS_SUFFIX_RE.sub("", title)
    t = _QUOTED_RE.sub(" ", t)
    t = _TRADING_PARTNERS_RE.sub(" ", t)
    t = t.lower()
    t = t.replace("’", "'")
    t = re.sub(r"[.']", "", t)            # "U.S." -> "us" (pas "u s")
    t = _STORY_KEY_PUNCT_RE.sub(" ", t)    # reste de la ponctuation -> espace
    tokens = [w for w in t.split() if w]
    tokens = [w for w in tokens if w not in _STORY_KEY_STOPWORDS]
    # Token court gardé seulement s'il est un code entité reconnu (US/UE/
    # UK/ONU) -- sinon c'est du bruit (particule/article mal filtré).
    return [w for w in tokens if len(w) >= 3 or w in _STORY_ENTITY_CODES]


def story_stem(token: str) -> str:
    """Le "stemming pauvre" de la maison : troncature à 6 caractères. C'est lui
    qui unifie threatened/threats -> "threat" et tariff/tariffs -> "tariff",
    sans dépendance externe."""
    return str(token or "")[:_STORY_KEY_TRUNC]


def story_key(title: str) -> str:
    """Clé d'HISTOIRE dérivée d'un titre (PUR -- cf. le commentaire de tête
    de fichier ~L99 pour le design complet de l'anti-spam politique).

    ``story_tokens`` (le découpage commun) -> ``story_stem`` sur chacun ->
    garde les 4 tokens significatifs restants (dédupliqués), triés
    alphabétiquement, joints par '-'. "" si le titre est vide.

    4 et non 6 -- cf. le commentaire au-dessus de _STORY_KEY_TOKENS : la
    règle des 6 tokens les plus longs ne convergeait pas naturellement sur
    les paires réelles de calibration, ce repli à 4 est le résultat DOCUMENTÉ
    de cette calibration."""
    tokens = [story_stem(w) for w in story_tokens(title)]
    seen_local = set()
    significant = []
    for w in tokens:
        if w not in seen_local:
            seen_local.add(w)
            significant.append(w)
    return "-".join(sorted(significant)[:_STORY_KEY_TOKENS])


# =========================================================================== #
#  I/O -- réseau (curl_cffi), Telegram, disque. Tout injectable dans run_once.
# =========================================================================== #

# --- fetch RSS (curl_cffi, empreinte TLS Chrome) ---------------------------- #

_session = None  # session curl_cffi partagée, créée à la demande (import paresseux)


def _get_session():
    """Session curl_cffi paresseuse et RÉUTILISÉE entre les appels (empreinte
    TLS Chrome -- Yahoo bloque les clients HTTP nus, même patron que
    market-pulse/pulse/fetcher.py et bond-scanner/scanner/fitch_isin.py)."""
    global _session
    if _session is None:
        from curl_cffi import requests as creq  # import paresseux
        _session = creq.Session(impersonate="chrome")
    return _session


def _rss_url(symbol: str) -> str:
    return _RSS_URL_TEMPLATE.format(symbol=quote(symbol, safe=""))


def _fetch_rss(url: str) -> str:
    """Récupère le texte d'un flux RSS (Yahoo, Google News ou Truth Social --
    même client pour les trois). Lève si le statut HTTP n'est pas 200 ou en
    cas d'erreur réseau/TLS -- laissé à l'appelant (run_once) de comptabiliser
    l'erreur : best-effort, jamais de crash du run entier."""
    session = _get_session()
    resp = session.get(url, timeout=15.0)
    if resp.status_code != 200:
        raise RuntimeError(f"RSS HTTP {resp.status_code} pour {url}")
    return resp.text


# --- états "vu" (générique -- sert le state par-utilisateur ET le state global) #

def _news_seen_path(username: str) -> Path:
    """Chemin du fichier d'état "vu" PAR UTILISATEUR, dans le MÊME dossier
    que les portefeuilles. Délègue à store.portfolio_path() pour la
    validation du nom d'utilisateur ET la résolution du dossier -- reste
    valide même si store.DATA_DIR est monkeypatché (les tests le font)."""
    portfolio_p = store.portfolio_path(username)  # valide + lève ValueError si invalide
    return portfolio_p.parent / f"{username}.news_seen.json"


def _global_seen_path() -> Path:
    """Chemin de l'état "vu" GLOBAL (annonces politiques, pas par
    utilisateur). Relit store.DATA_DIR à chaque appel (pas de constante
    figée à l'import) pour rester valide même monkeypatché en test."""
    return store.DATA_DIR / "newswatch_global.json"


def _default_seen_state() -> Dict[str, Any]:
    return {"seen": {}, "events": [], "seeded": {}, "stories": {},
            "sent_log": [], "crypto_sent_log": [], "x_sent_log": [],
            "eco_sent_log": [], "climat_sent_log": [],
            "bc_sent_log": [], "pressefi_sent_log": [], "bsky_sent_log": [],
            "x_cycle": 0, "x_tiers": {}, "x_fails": {},
            "x_candidates": {}, "x_cand_cycle": 0, "x_pending_seen": [],
            "bc_cycle": 0, "pressefi_cycle": 0, "bsky_cycle": 0,
            "reddit_cycle": 0, "reddit_group_cycle": 0, "reddit_trends": {}}


def _load_seen_state(path: Path) -> Dict[str, Any]:
    """Charge un état "vu" depuis un chemin quelconque (sert les deux
    stores : par-utilisateur et global). Absent -> état vierge. Corrompu ->
    état vierge SANS jamais planter (le fichier fautif est renommé en
    .corrupt, même convention que store.py -- on garde la trace du bug sans
    perdre la capacité de tourner).

    "stories" (dict story_key -> dernier envoi ISO) et "sent_log" (liste
    d'horodatages ISO d'envois gov, fenêtre glissante 1h) ne servent QUE
    l'état global politique (anti-spam par histoire, cf. tête de fichier
    ~L99) -- absents/mal typés (y compris un état "ancien format" écrit
    AVANT cette extension) -> repartent d'un dict/liste vide SANS planter,
    même philosophie que "seen"/"events"/"seeded" ci-dessous.

    Idem pour les clés des volets ajoutés le 26/08 : "crypto_sent_log" et
    "x_sent_log" (budgets propres, cf. constantes), "x_cycle" (cadence un
    cycle sur deux), "x_tiers" (quel chemin de récupération marche pour quel
    compte) et "x_fails" (anomalies consécutives avant escalade). Un état
    écrit AVANT cette extension repart donc de zéro sans migration.

    Idem pour le volet REDDIT : "reddit_cycle" (cadence un cycle sur trois) et
    "reddit_trends" (les mentions horodatées par ticker, cf. trends_view).

    Idem, enfin, pour les deux volets MONDE du 26/08 au soir : "eco_sent_log" et
    "climat_sent_log" (leurs budgets horaires propres). Un état écrit avant eux
    repart d'une liste vide, donc d'un budget plein — c'est le bon défaut : au
    pire un volet neuf parle une fois de trop à son premier passage, jamais
    l'inverse.

    Idem, encore, pour les trois volets MONDIAUX du 26/08 (W2a) :
    "bc_sent_log"/"pressefi_sent_log"/"bsky_sent_log" (budgets propres) et
    "bc_cycle"/"pressefi_cycle"/"bsky_cycle" (leurs cadences, qui n'ont pas
    toutes la même période — cf. ``cycle_due``). Et pour la file de probation
    des comptes X : "x_candidates" (les candidats et leurs compteurs),
    "x_cand_cycle" (leur cadence de sondage) et "x_pending_seen" (la trace des
    candidats libérés faute de place dans la liste manuelle).

    Idem, encore, pour "reddit_group_cycle" (27/08) : quel GROUPE de subreddits
    a été interrogé au dernier passage — cf. REDDIT_GROUPS. Absent -> 0, donc
    le groupe historique d'abord.

    Idem, enfin, pour "calendar_cycle" (27/08) : la cadence du VERDICT du jour J
    (cf. ``calendar_cycle_due``).

    ⚠️ Ce retour est une ALLOWLIST : toute clé absente de la liste ci-dessous
    est SILENCIEUSEMENT perdue à la relecture, même si le cycle vient de
    l'écrire. Un compteur de cadence oublié ici serait donc relu à zéro à chaque
    passage — la cadence n'existerait plus, le volet tournerait à CHAQUE cycle,
    et rien ne le signalerait (c'est exactement ce qui est arrivé à
    "calendar_cycle" au premier branchement, attrapé par un test dédié). Tout
    ajout de clé d'état doit passer par ici."""
    if not path.is_file():
        return _default_seen_state()
    try:
        with open(str(path), "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        try:
            os.replace(str(path), str(path.parent / (path.name + ".corrupt")))
        except OSError:
            pass
        return _default_seen_state()
    if not isinstance(data, dict):
        return _default_seen_state()
    def _dict(key):
        value = data.get(key)
        return value if isinstance(value, dict) else {}

    def _list(key):
        value = data.get(key)
        return value if isinstance(value, list) else []

    def _counter(key):
        try:
            return int(data.get(key) or 0)
        except (TypeError, ValueError):
            return 0

    return {
        "seen": _dict("seen"),
        "events": _list("events"),
        "seeded": _dict("seeded"),
        "stories": _dict("stories"),
        "sent_log": _list("sent_log"),
        "crypto_sent_log": _list("crypto_sent_log"),
        "x_sent_log": _list("x_sent_log"),
        "eco_sent_log": _list("eco_sent_log"),
        "climat_sent_log": _list("climat_sent_log"),
        "bc_sent_log": _list("bc_sent_log"),
        "pressefi_sent_log": _list("pressefi_sent_log"),
        "bsky_sent_log": _list("bsky_sent_log"),
        "x_cycle": _counter("x_cycle"),
        "x_tiers": _dict("x_tiers"),
        "x_fails": _dict("x_fails"),
        "x_candidates": _dict("x_candidates"),
        "x_cand_cycle": _counter("x_cand_cycle"),
        "x_pending_seen": _list("x_pending_seen"),
        "bc_cycle": _counter("bc_cycle"),
        "pressefi_cycle": _counter("pressefi_cycle"),
        "bsky_cycle": _counter("bsky_cycle"),
        "reddit_cycle": _counter("reddit_cycle"),
        "reddit_group_cycle": _counter("reddit_group_cycle"),
        "reddit_trends": _dict("reddit_trends"),
        "calendar_cycle": _counter("calendar_cycle"),
    }


def _save_seen_state(path: Path, state: Dict[str, Any]) -> None:
    """Persiste un état "vu" (générique) de façon atomique et 0o600 -- même
    patron que store.py/telegram_config.py (le fichier tmp NAÎT en 0o600 via
    os.open, jamais un open()+chmod() qui laisserait une fenêtre
    world-readable)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.parent / f".{path.name}.tmp-{os.getpid()}"
    fd = os.open(str(tmp_path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.fchmod(fd, 0o600)
    except (AttributeError, OSError):
        pass
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(state, f, ensure_ascii=False, indent=2)
        os.replace(str(tmp_path), str(path))
    except Exception:
        try:
            os.remove(str(tmp_path))
        except OSError:
            pass
        raise


def _load_seen(username: str) -> Dict[str, Any]:
    return _load_seen_state(_news_seen_path(username))


def _save_seen(username: str, state: Dict[str, Any]) -> None:
    _save_seen_state(_news_seen_path(username), state)


def _load_global_seen() -> Dict[str, Any]:
    return _load_seen_state(_global_seen_path())


def _save_global_seen(state: Dict[str, Any]) -> None:
    _save_seen_state(_global_seen_path(), state)


def _purge_old_seen(state: Dict[str, Any], now_dt: datetime,
                    max_age_days: int = _SEEN_MAX_AGE_DAYS) -> None:
    """Purge EN PLACE les entrées "seen" plus vieilles que max_age_days (évite
    une croissance illimitée du fichier -- vaut pour les deux stores). Une
    date illisible est purgée par prudence -- mieux vaut re-détecter un item
    une fois qu'accumuler une fuite silencieuse."""
    seen = state.get("seen")
    if not isinstance(seen, dict):
        return
    cutoff = now_dt.timestamp() - max_age_days * 86400
    stale = []
    for key, iso_ts in seen.items():
        keep = False
        try:
            ts = datetime.fromisoformat(iso_ts)
            if ts.tzinfo is None:
                ts = ts.replace(tzinfo=timezone.utc)
            keep = ts.timestamp() >= cutoff
        except (TypeError, ValueError):
            keep = False
        if not keep:
            stale.append(key)
    for key in stale:
        del seen[key]


def _purge_old_sent_log(sent_log: List[str], now_dt: datetime, max_age_h: float) -> None:
    """Purge EN PLACE les horodatages d'envoi gov plus vieux que max_age_h
    heures -- fenêtre glissante du budget dur (_GOV_MAX_SENDS_PER_HOUR, cf.
    tête de fichier ~L99). Une entrée illisible est purgée par prudence,
    même raisonnement que _purge_old_seen : mieux vaut sous-compter le budget
    (donc parfois muter un envoi qui aurait pu passer) que le laisser
    grossir indéfiniment sur une entrée cassée."""
    cutoff = now_dt.timestamp() - max_age_h * 3600
    kept = []
    for iso_ts in sent_log:
        try:
            ts = datetime.fromisoformat(iso_ts)
            if ts.tzinfo is None:
                ts = ts.replace(tzinfo=timezone.utc)
            if ts.timestamp() >= cutoff:
                kept.append(iso_ts)
        except (TypeError, ValueError):
            continue
    sent_log[:] = kept


def _hash_link(link: str) -> str:
    return hashlib.md5(link.encode("utf-8")).hexdigest()


# --------------------------------------------------------------------------- #
# Comptes X suivis — config utilisateur (26/08)
# --------------------------------------------------------------------------- #

def x_accounts_path() -> Path:
    """Chemin du fichier des comptes X suivis. Relit ``store.DATA_DIR`` à
    chaque appel (même raison que ``_global_seen_path``)."""
    return store.DATA_DIR / X_ACCOUNTS_NAME


def load_x_accounts() -> List[str]:
    """Les comptes X suivis. Fichier absent/illisible/vide -> les DÉFAUTS
    livrés (``X_DEFAULT_HANDLES``) : un volet neuf doit produire quelque chose
    sans qu'on ait à le configurer. Une liste explicitement VIDE reste vide —
    c'est une décision de l'utilisateur, pas une absence de décision.
    """
    path = x_accounts_path()
    if not path.is_file():
        return list(X_DEFAULT_HANDLES)
    try:
        with open(str(path), "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return list(X_DEFAULT_HANDLES)
    if not isinstance(data, dict) or not isinstance(data.get("handles"), list):
        return list(X_DEFAULT_HANDLES)
    return normalize_handles(data["handles"])


def save_x_accounts(handles: Any) -> List[str]:
    """Persiste la liste (atomique, 0o600) et rend la liste RÉELLEMENT écrite
    — normalisée, donc ce que l'appelant affiche est ce qui s'applique.

    ``_save_seen_state`` est réutilisé pour son ÉCRITURE (temporaire 0o600 puis
    ``os.replace``), pas pour la forme de son contenu : il sérialise le
    dictionnaire qu'on lui donne, quel qu'il soit.
    """
    valid = normalize_handles(handles)
    _save_seen_state(x_accounts_path(), {"handles": valid})
    return valid


# --------------------------------------------------------------------------- #
# Récupération d'un profil X — DEUX ÉTAGES
#
# 1. **léger** : curl_cffi en empreinte Chrome. C'est le chemin normal, prouvé,
#    et il coûte une requête ;
# 2. **furtif** : ``StealthFetcher`` du AI Harvester (patchright + vrai Chrome
#    sur le ``:100`` de l'Omen). Réservé aux cibles dures, exactement comme le
#    veut la doctrine du Harvester — on n'y va que si l'étage léger a montré un
#    signal de blocage (403/429, page-challenge, ou sérialisation cassée deux
#    cycles de suite sur le MÊME compte).
#
# Les flux RSS (Yahoo, Google News, Cointelegraph, Decrypt, EDGAR) NE passent
# jamais par là : ils répondent au chemin léger, y mettre un navigateur serait
# du gaspillage pur.
# --------------------------------------------------------------------------- #

def _x_url(handle: str) -> str:
    return "https://x.com/%s" % handle


def _fetch_x_light(handle: str) -> str:
    """Étage 1 : le HTML du profil via curl_cffi (empreinte Chrome).

    Import PARESSEUX : le module doit rester importable sur une machine sans
    ``curl_cffi`` — le volet X se contente alors d'échouer proprement.
    """
    from curl_cffi import requests as creq   # import paresseux (cf. docstring)
    session = creq.Session(impersonate="chrome")
    response = session.get(_x_url(handle), timeout=25)
    status = getattr(response, "status_code", 0)
    if status in (403, 429):
        from backend.bots.harvester.fetch import PushbackError
        raise PushbackError("x.com/%s a refusé (HTTP %s)" % (handle, status),
                            status=status)
    if status >= 400:
        from backend.bots.harvester.fetch import FetchError
        raise FetchError("x.com/%s: HTTP %s" % (handle, status))
    return response.text or ""


def _fetch_x_stealth(handle: str) -> str:
    """Étage 2 : le même HTML, via le navigateur furtif du Harvester.

    Tout est PARESSEUX (module ET instanciation) : sur le Mac de développement
    ``patchright`` n'est pas installé, et l'étage doit alors être simplement
    INDISPONIBLE — un compteur d'erreur, jamais une exception qui casserait le
    cycle de veille des trois autres volets.
    """
    from backend.bots.harvester.fetch import RateLimiter
    from backend.bots.harvester.fetch_stealth import StealthFetcher
    fetcher = StealthFetcher(rate=RateLimiter(_X_PACE_S))
    return fetcher.get(_x_url(handle))


def _social_module():
    """``pulse.social`` du moteur Market Pulse (pont ``sys.path``, même patron
    que ``quotes.py`` et ``radar._social_module`` : le dossier est tirété, donc
    ``import pulse.social`` ne marche pas tel quel).

    UN seul point d'entrée pour les deux volets qui en dépendent (X et Reddit) :
    deux ponts parallèles finiraient par pointer deux chemins différents.
    """
    path = str(ENGINE_DIR)
    if path not in sys.path:
        sys.path.insert(0, path)
    from pulse import social                  # noqa: E402 — pont sys.path
    return social


def _news_module():
    """``pulse.news`` du moteur Market Pulse (même pont ``sys.path`` que
    ``_social_module``).

    ⚠️ C'est LUI qui porte la cascade de collecte de presse — fraîcheur,
    ``stale_sources``, filtre des conseils, filtre du hors-sujet, partage
    ÉQUITABLE par source avant troncature. Cinq comportements sondés et corrigés
    par l'expérience (cf. piège #67c/e). On l'EMPRUNTE ; on ne le réécrit pas.
    """
    path = str(ENGINE_DIR)
    if path not in sys.path:
        sys.path.insert(0, path)
    from pulse import news                    # noqa: E402 — pont sys.path
    return news


def pressefi_feeds() -> List[Dict[str, str]]:
    """La liste des flux du volet presse mondiale.

    Les flux du moteur Market Pulse (italiens et anglophones, déjà sondés)
    PLUS les neuf sondés le 26/08. Deux précisions :

    * un flux déjà servi par le volet **banques centrales** est RETIRÉ ici (le
      moteur embarque celui de la BCE). Un même communiqué lu par deux volets ne
      produirait qu'un seul événement — le dédoublonnage se fait par lien — mais
      ce serait celui des DEUX qui a tourné le premier, donc au hasard : le
      communiqué de la BCE finirait tantôt en « source officielle », tantôt en
      « presse ». La source officielle a la priorité, c'est la doctrine du volet ;
    * moteur absent -> les neuf sondés suffisent. Le volet rétrécit, il ne meurt
      pas.
    """
    owned = {str(url) for url in _BC_SOURCES}
    feeds: List[Dict[str, str]] = []
    try:
        base = _news_module().FEEDS or []
    except Exception:      # noqa: BLE001 — moteur absent
        logger.warning("paper newswatch: moteur market-pulse absent, "
                       "presse mondiale réduite aux flux propres")
        base = []
    for feed in base:
        if isinstance(feed, dict) and str(feed.get("url") or "") not in owned:
            feeds.append(dict(feed))
    feeds.extend(dict(feed) for feed in PRESSEFI_EXTRA_FEEDS)
    return feeds


def _collect_news(**kwargs) -> Dict[str, Any]:
    """La cascade de presse du moteur, appelée telle quelle."""
    return _news_module().collect_news(**kwargs)


# --- volet Bluesky : URL, fetch et parseur (I/O) ---------------------------- #

def _bsky_urls(queries: Any) -> List[Tuple[str, str]]:
    """``[(requête, URL de recherche)]``, ou ``[]`` si le moteur manque.

    ``pulse.social.bluesky_search_url`` est empruntée telle quelle : c'est elle
    qui porte la connaissance de l'endpoint public (``app.bsky.feed.searchPosts``),
    sondé et vérifié en production sur Market Pulse.
    """
    try:
        social = _social_module()
    except Exception:      # noqa: BLE001 — moteur absent
        logger.warning("paper newswatch: moteur market-pulse absent, "
                       "Bluesky ignoré")
        return []
    out: List[Tuple[str, str]] = []
    for query in (queries or []):
        url = social.bluesky_search_url(query, BSKY_SEARCH_LIMIT)
        if url:
            out.append((query, url))
    return out


def _fetch_bsky(url: str) -> Any:
    """La réponse JSON de la recherche Bluesky, en OCTETS.

    Même session curl_cffi que les autres volets. Tout statut non-200 lève :
    l'appelant compte une erreur et passe à la requête suivante — une recherche
    en panne ne doit jamais emporter les autres.
    """
    session = _get_session()
    resp = session.get(url, timeout=20.0)
    status = getattr(resp, "status_code", 0)
    if status != 200:
        raise RuntimeError("Bluesky HTTP %s" % status)
    return resp.content


def _parse_bsky_posts(raw: Any) -> List[Dict[str, Any]]:
    """Les posts d'une réponse de recherche, via ``pulse.social.parse_bluesky``
    (qui nettoie déjà les textes : URL collée, grappe de hashtags, marqueurs de
    continuation)."""
    return _social_module().parse_bluesky(raw) or []


def _parse_x_posts(page: str, handle: str) -> List[Dict[str, Any]]:
    """Les posts d'une page de profil, via ``pulse.social.parse_x``.

    Laisse remonter ``XSerializationChanged`` : c'est un SIGNAL (la page a
    changé de forme, ou on nous sert un mur), pas un détail — l'appelant s'en
    sert pour décider d'escalader.
    """
    return _social_module().parse_x(page, handle)


def _x_serialization_error():
    """La classe ``XSerializationChanged`` du moteur, ou un repli inoffensif si
    le moteur n'est pas déployé (``except`` sur une classe absente lèverait)."""
    try:
        return _social_module().XSerializationChanged
    except Exception:      # noqa: BLE001 — moteur absent
        class _Never(RuntimeError):
            pass
        return _Never


# --- volet Reddit : URL, fetch et parseur (I/O) ----------------------------- #

def _reddit_url(subs: Any = None) -> str:
    """L'URL multireddit du flux Atom pour ``subs``, ou ``""`` si le moteur
    manque.

    ``pulse.social.reddit_url`` est empruntée telle quelle : c'est elle qui
    porte la connaissance du format (``/r/a+b+c/.rss?limit=N``), sondée et
    vérifiée à la main pour le radar.

    ``subs`` absent -> TOUS les subs suivis. Ce n'est PAS ce que le volet
    demande (il passe un groupe, cf. ``REDDIT_GROUPS``) : c'est le défaut de
    lecture, pour qui veut savoir à quoi ressemble l'URL de la totalité.
    """
    try:
        return _social_module().reddit_url(subs or REDDIT_SUBS,
                                           REDDIT_LIMIT) or ""
    except Exception:      # noqa: BLE001 — moteur absent
        logger.warning("paper newswatch: moteur market-pulse absent, Reddit ignoré")
        return ""


def _fetch_reddit(url: str) -> bytes:
    """Le flux Atom, en OCTETS, via la session curl_cffi déjà partagée.

    Des octets et non du texte : le flux porte sa déclaration d'encodage, et
    c'est la forme que ``pulse.social._default_fetch`` a elle-même retenue pour
    Reddit après sondage — on ne réinvente pas ce qui a déjà été mesuré.

    Lève sur 429 comme sur tout autre statut non-200 : l'appelant compte une
    erreur et passe. **Aucune reprise dans le cycle** — le plafond est de
    1 requête / 60 s, le prochain cycle dû arrive dans un quart d'heure.
    """
    session = _get_session()
    resp = session.get(url, timeout=20.0)
    status = getattr(resp, "status_code", 0)
    if status == 429:
        raise RuntimeError("Reddit a répondu 429 (plafond 1 req/60 s)")
    if status != 200:
        raise RuntimeError("Reddit HTTP %s" % status)
    return resp.content


def _parse_reddit_posts(raw: Any) -> List[Dict[str, Any]]:
    """Les posts du flux, via ``pulse.social.parse_reddit``, TITRES NETTOYÉS.

    ``clean_social_text`` retire l'URL collée dans le titre, la grappe de
    hashtags terminale et les marqueurs de continuation — un titre Reddit en
    charrie constamment. Un post dont le titre n'était QUE ça est écarté plutôt
    que journalisé nu.
    """
    social = _social_module()
    out: List[Dict[str, Any]] = []
    for post in (social.parse_reddit(raw) or []):
        if not isinstance(post, dict):
            continue
        title = social.clean_social_text(post.get("title"))
        if not title:
            continue
        row = dict(post)
        row["title"] = title
        out.append(row)
    return out


def _x_default_pacer():
    """Le ``AdaptivePacer`` du Harvester (c'est sa raison d'être : ralentir
    quand la cible pousse, réaccélérer quand elle laisse faire). Module absent
    -> un cadenceur fixe minimal, pour que le volet tourne quand même."""
    try:
        from backend.bots.harvester.pacing import AdaptivePacer
        return AdaptivePacer(_X_PACE_S)
    except Exception:      # noqa: BLE001
        class _Fixed(object):
            def interval(self):
                return _X_PACE_S

            def penalize(self, retry_after=None):
                pass

            def relax(self):
                pass
        return _Fixed()


def x_tier_for(handle: str, tiers: Any, now_dt: datetime) -> str:
    """Quel étage utiliser pour ce compte ? ``"light"`` ou ``"stealth"`` (PUR).

    Le furtif est MÉMORISÉ par compte pendant ``_X_STEALTH_TTL_S`` : sans ça on
    re-paierait l'échec du chemin léger à chaque cycle. Passé ce délai on
    retente le léger — un blocage n'est pas éternel, et le navigateur coûte
    infiniment plus cher.
    """
    since = (tiers or {}).get(handle) if isinstance(tiers, dict) else None
    if not since:
        return "light"
    try:
        started = datetime.fromisoformat(str(since))
        if started.tzinfo is None:
            started = started.replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return "light"             # horodatage illisible -> on retente le léger
    if (now_dt - started).total_seconds() >= _X_STEALTH_TTL_S:
        return "light"
    return "stealth"


def recent_events(username: str) -> List[Dict[str, Any]]:
    """CONTRAT PUBLIC (consommé par le router) : événements news récents pour
    un utilisateur, TRIÉS PAR ts DÉCROISSANT -- fusionne les événements
    propres à l'utilisateur ET les événements politiques GLOBAUX (sentiment
    "gov", symbole "GOV", partagés par tout le monde, y compris un
    utilisateur qui n'a jamais eu de portefeuille). Fichier(s) absent(s) ->
    juste la partie manquante compte pour []. Username invalide -> lève
    ValueError (même convention que store.py : on rejette, on ne sanitize
    jamais en silence) -- vérifié EN PREMIER, avant même de toucher l'état
    global."""
    user_events = list(_load_seen(username).get("events", []))
    gov_events = list(_load_global_seen().get("events", []))
    merged = user_events + gov_events
    merged.sort(key=lambda e: e.get("ts") or "", reverse=True)
    return merged


def recent_trends(now: Any = None) -> Dict[str, Dict[str, int]]:
    """CONTRAT PUBLIC (convergence, toile, router) : ``{SYMBOLE: {count, prev}}``
    — les tickers dont la foule Reddit parle, et à quel rythme.

    GLOBAL comme le sont les volets politique, crypto et X : la foule ne parle
    pas à un compte, elle parle au marché. Fichier absent -> dictionnaire vide.
    """
    return trends_view(_load_global_seen().get("reddit_trends"), now)


# --- portefeuilles + watchlist (extension 25/08 -- "sans baisser le nombre
# d'infos générales" : le volet gov ci-dessus est INCHANGÉ, cette union ne
# touche QUE le volet par-symbole) ------------------------------------------ #

def _position_symbols(portfolio: Dict[str, Any]) -> List[str]:
    """Symboles distincts (ordre de première apparition) des positions
    ouvertes d'un portefeuille."""
    symbols: List[str] = []
    for pos in portfolio.get("positions") or []:
        if not isinstance(pos, dict):
            continue
        sym = pos.get("symbol")
        if sym and sym not in symbols:
            symbols.append(sym)
    return symbols


def _load_watchlist_symbols(username: str) -> List[str]:
    """Symboles de la watchlist d'un utilisateur -- délègue à
    store.load_watchlist() (source de vérité I/O du paquet paper/, écrite et
    lue via le même chemin store.watchlist_path() par TOUS les modules,
    watchlist et news compris ; corrompu/absent -> [] par construction, cf.
    store.py). Entrée sans "symbol" -> ignorée en silence, jamais de crash --
    le volet news ne doit jamais tomber pour une donnée d'un AUTRE module."""
    symbols: List[str] = []
    for entry in store.load_watchlist(username):
        sym = entry.get("symbol")
        if isinstance(sym, str) and sym:
            symbols.append(sym)
    return symbols


def _merged_symbols(portfolio: Dict[str, Any], username: str) -> List[str]:
    """Symboles à surveiller pour un utilisateur : positions ouvertes UNION
    watchlist, dédupliqués de façon insensible à la casse (la casse de la
    PREMIÈRE occurrence est conservée -- positions d'abord, puis
    watchlist)."""
    merged: List[str] = []
    seen_upper = set()
    for sym in _position_symbols(portfolio):
        upper = sym.upper()
        if upper not in seen_upper:
            seen_upper.add(upper)
            merged.append(sym)
    for sym in _load_watchlist_symbols(username):
        upper = sym.upper()
        if upper not in seen_upper:
            seen_upper.add(upper)
            merged.append(sym)
    return merged


def _discover_portfolios() -> List[Tuple[str, Dict[str, Any]]]:
    """Liste (username, portfolio) pour chaque portefeuille possédant au
    moins une position ouverte OU un symbole en watchlist (extension 25/08).
    Ignore les fichiers auxiliaires (.coach.json, .news_seen.json,
    .watchlist.json, .board.json -- ils matchent aussi le glob "*.json") ; les
    fichiers corrompus sont déjà hors du glob (store.py les renomme en .corrupt
    à la lecture, extension qui ne matche plus "*.json").

    Ceinture ET bretelles : même si un suffixe auxiliaire manquait à la liste
    ci-dessous, son radical porterait un point ("alice.board") et
    store.portfolio_path() le REJETTERAIT (ValueError -- allowlist stricte, un
    '.' est structurellement interdit), ce que le except ci-dessous transforme
    en simple saut. La liste explicite reste la première ligne de défense :
    elle DOCUMENTE ce qui n'est pas un compte, là où l'exception ne fait que le
    constater."""
    data_dir = store.DATA_DIR
    if not data_dir.is_dir():
        return []
    out: List[Tuple[str, Dict[str, Any]]] = []
    for path in sorted(data_dir.glob("*.json")):
        name = path.name
        if (name.endswith(".coach.json") or name.endswith(".news_seen.json")
                or name.endswith(".watchlist.json")
                or name.endswith(".board.json")
                or name.endswith(".ideas.json")
                # Fichiers de RÉGLAGE (26/08) : leur radical ne porte pas de
                # point, donc l'allowlist de store ne les rejette PAS — ils
                # doivent être nommés explicitement.
                or name in ("alerts_mode.json", "x_accounts.json")):
            continue
        username = path.stem
        try:
            portfolio = store.load_portfolio(username)
        except ValueError:
            continue
        if not isinstance(portfolio, dict):
            continue
        if _position_symbols(portfolio) or _load_watchlist_symbols(username):
            out.append((username, portfolio))
    return out


def _anchor_extra(portfolios: List[Tuple[str, Dict[str, Any]]]) -> Dict[str, str]:
    """``{nom en minuscules: SYMBOLE}`` des titres détenus ET suivis, tous
    comptes confondus — la matière que ``entities`` fait PRIMER sur sa table.

    Le simulateur est mono-utilisateur en pratique ; on additionne quand même
    les comptes, exactement comme ``convergence._collect_positions``, pour que
    la reconnaissance d'un titre ne dépende pas de QUI l'a mis en watchlist.

    ⚠️ Une POSITION ne porte pas de nom, seulement son symbole ; c'est la
    watchlist qui fournit les noms (mêmes précautions que
    ``convergence._symbol_names``). Best-effort de bout en bout : un compte
    illisible rétrécit la reconnaissance, il ne casse jamais le cycle.
    """
    rows: List[Dict[str, Any]] = []
    for username, portfolio in portfolios:
        for symbol in _position_symbols(portfolio):
            rows.append({"symbol": symbol})
        try:
            entries = store.load_watchlist(username) or []
        except Exception:      # noqa: BLE001 — un compte cassé ne casse rien
            continue
        for entry in entries:
            if isinstance(entry, dict) and entry.get("symbol"):
                rows.append({"symbol": entry.get("symbol"),
                             "name": entry.get("name")})
    return entities.anchor_index(rows)


def _post_dt(published: Any, now_dt: datetime,
             max_age_s: float = _REDDIT_MAX_AGE_S) -> Optional[datetime]:
    """La date d'un post social, si elle est FRAÎCHE — sinon ``None``.

    Un horodatage absent ou illisible rend ``None`` (le post est écarté), même
    règle que les trois autres volets : sans date, on ne peut pas prétendre à
    la fraîcheur, et un flux qui change de format ne doit pas remplir le
    compteur de mentions avec des posts d'il y a trois semaines.
    """
    try:
        when = datetime.fromtimestamp(float(published), tz=timezone.utc)
    except (TypeError, ValueError, OverflowError, OSError):
        return None
    age_s = now_dt.timestamp() - when.timestamp()
    if age_s < 0 or age_s > max_age_s:
        return None
    return when


def _run_reddit_volet(state: Dict[str, Any], now_dt: datetime,
                      anchor_extra: Dict[str, str], counters: Dict[str, Any],
                      reddit_fetch: Optional[Callable[[str], Any]] = None,
                      reddit_parse: Optional[Callable[[Any], List[Dict[str, Any]]]] = None
                      ) -> None:
    """Le volet « tendances de la foule » : UNE requête multireddit sur UN
    groupe de subs, deux produits, ZÉRO notification. MUTE ``state`` — la
    persistance est faite par l'appelant.

    Les deux groupes (``REDDIT_GROUPS``) alternent d'un passage à l'autre, et le
    compteur d'alternance monte AVANT la requête : un groupe qui rend 403 compte
    une erreur et rend la main, l'autre passera au tour suivant. C'est tout
    l'objet du découpage — un multireddit de dix subs tombe entièrement dès
    qu'un seul d'entre eux est en quarantaine, et il a effectivement rendu 403
    en production.

    **Il n'envoie jamais rien, dans aucun mode.** Ce n'est pas un oubli : la
    foule est un ACCÉLÉRANT, pas une preuve, et lui donner un canal direct vers
    le téléphone recréerait exactement le bruit qu'on a passé la journée à
    tuer. Ses deux produits parlent à la convergence, qui décide :

    1. des **événements** (``src: "reddit"``), UNIQUEMENT pour les posts qui
       portent un ticker reconnaissable — cashtag ``$X``, ou entreprise nommée
       (``entities``). Un post sans ticker n'apprend rien à ce portefeuille ;
    2. les **mentions** par ticker (``reddit_trends``), qui alimentent le
       facteur ``crowd_buzz`` de la convergence.

    Pas d'amorçage silencieux (le « seed » des autres volets) : il n'existe que
    pour empêcher une tempête de notifications au déploiement, et ce volet
    n'en émet aucune. Ce sont le filtre de fraîcheur (24 h) et le cap
    d'événements par passage qui tiennent le premier cycle.
    """
    # Le compteur monte AVANT la requête, et même si elle échoue : c'est ce qui
    # empêche un groupe en panne de bloquer l'autre (cf. ``reddit_group``).
    group_cycle = state.get("reddit_group_cycle") or 0
    subs = reddit_group(group_cycle)
    try:
        state["reddit_group_cycle"] = int(group_cycle) + 1
    except (TypeError, ValueError):
        state["reddit_group_cycle"] = 1

    url = _reddit_url(subs)
    if not url:
        return

    fetch_fn = reddit_fetch if reddit_fetch is not None else _fetch_reddit
    parse_fn = reddit_parse if reddit_parse is not None else _parse_reddit_posts

    try:
        raw = fetch_fn(url)
    except Exception as exc:      # noqa: BLE001 — 403, 429, réseau, TLS
        # Le groupe est nommé : sans lui, un 403 récurrent reste indébuggable —
        # on ne saurait pas LEQUEL des deux est fâché.
        logger.warning("paper newswatch: Reddit injoignable sur [%s] (%s)",
                       "+".join(subs), type(exc).__name__)
        counters["errors"] += 1
        return
    counters["fetched"] += 1

    try:
        posts = parse_fn(raw) or []
    except Exception as exc:      # noqa: BLE001 — flux illisible
        logger.warning("paper newswatch: Reddit illisible (%s)",
                       type(exc).__name__)
        counters["errors"] += 1
        return

    seen = state["seen"]
    events = state["events"]
    trends = state["reddit_trends"]
    # Purge D'ABORD : elle jette les mentions périmées, mais surtout elle
    # NORMALISE le dictionnaire relu du disque (une valeur qui ne serait pas une
    # liste disparaît). Sans ça, un état corrompu ferait lever le ``.append``
    # ci-dessous et emporterait tout le cycle de veille, pas seulement ce volet.
    purge_trends(trends, now_dt)
    logged = 0

    for post in posts:
        if not isinstance(post, dict):
            continue
        title = str(post.get("title") or "").strip()
        link = str(post.get("url") or "").strip()
        if not title or not link:
            continue
        key = _hash_link("reddit:%s" % link)
        if key in seen:
            continue
        seen[key] = now_dt.isoformat()

        when = _post_dt(post.get("published"), now_dt)
        if when is None:
            continue
        # Le cashtag d'abord : c'est l'auteur qui dit de quel titre il parle,
        # on ne va pas lui préférer notre propre reconnaissance.
        symbol = cashtag_symbol(title) or entities.first_company(title, anchor_extra)
        if not symbol:
            continue

        # TOUTES les mentions comptent pour la tendance (un horodatage ne coûte
        # rien) ; seule une poignée devient un événement affiché.
        trends.setdefault(symbol, []).append(when.isoformat())
        if logged >= _REDDIT_MAX_EVENTS_PER_RUN:
            continue
        logged += 1
        events.insert(0, {
            "ts": now_dt.isoformat(),
            "symbol": symbol,
            "title": title,
            "link": link,
            "sentiment": REDDIT_SENTIMENT,
            "src": "reddit",
            "subreddit": str(post.get("subreddit") or ""),
            # Toujours vrai : ce volet ne dispose d'aucun canal d'envoi.
            "muted": True,
        })

    # Purge de sortie : c'est elle qui applique le CAP, après les ajouts.
    purge_trends(trends, now_dt)


def _pushback_error():
    """La classe ``PushbackError`` du Harvester, ou un repli inoffensif si le
    module n'est pas déployé (un ``except`` sur une classe absente lèverait)."""
    try:
        from backend.bots.harvester.fetch import PushbackError
        return PushbackError
    except Exception:      # noqa: BLE001
        class _Never(RuntimeError):
            pass
        return _Never


def _x_try(fetch_fn: Callable[[str], str],
           parse_fn: Callable[[str, str], List[Dict[str, Any]]],
           handle: str, pacer: Any, counters: Dict[str, Any],
           serial_error: Any) -> Tuple[Optional[List[Dict[str, Any]]], str]:
    """UNE tentative de récupération d'un profil -> ``(posts|None, signal)``.

    ``signal`` vaut ``""`` (succès), ``"block"`` (refus FRANC : 403/429, donc
    escalade immédiate) ou ``"anomaly"`` (page vide, sérialisation cassée,
    panne — il en faut deux de suite avant de sortir le navigateur).
    """
    try:
        page = fetch_fn(handle)
    except _pushback_error() as exc:
        pacer.penalize(getattr(exc, "retry_after", None))
        counters["errors"] += 1
        return None, "block"
    except Exception as exc:      # noqa: BLE001 — réseau, TLS, module absent
        logger.warning("paper newswatch: X @%s injoignable (%s)",
                       handle, type(exc).__name__)
        counters["errors"] += 1
        return None, "anomaly"

    counters["fetched"] += 1
    try:
        posts = parse_fn(page, handle)
    except serial_error:
        # La page est GROSSE mais ne rend plus rien : format changé, ou mur.
        logger.warning("paper newswatch: X @%s ne rend plus de posts", handle)
        counters["errors"] += 1
        return None, "anomaly"
    except Exception as exc:      # noqa: BLE001
        logger.warning("paper newswatch: X @%s illisible (%s)",
                       handle, type(exc).__name__)
        counters["errors"] += 1
        return None, "anomaly"

    if not posts:
        # Petite page sans aucun post = page-challenge probable.
        return None, "anomaly"
    pacer.relax()
    return posts, ""


def _x_posts_for(handle: str, now_dt: datetime, tiers: Dict[str, Any],
                 fails: Dict[str, Any], light: Callable[[str], str],
                 heavy: Callable[[str], str],
                 parse_fn: Callable[[str, str], List[Dict[str, Any]]],
                 pacer: Any, counters: Dict[str, Any],
                 serial_error: Any,
                 escalate: bool = True) -> List[Dict[str, Any]]:
    """Les posts d'un compte, en montant d'un étage SEULEMENT si nécessaire.

    Le compteur d'anomalies est PERSISTÉ par compte : c'est lui qui distingue
    un blip (une page vide un cycle) d'un vrai mur (deux cycles de suite), et
    il ne peut pas vivre en mémoire de process — la veille redémarre à chaque
    déploiement.

    ``escalate=False`` interdit TOUT recours au navigateur furtif : c'est le
    régime des comptes EN PROBATION. Un candidat est très souvent un compte qui
    n'existe pas (une mention mal lue, un compte supprimé) ; démarrer un Chrome
    pour lui, c'est payer le prix fort pour un 404, et le faire en boucle. Le
    furtif reste réservé aux comptes CHOISIS À LA MAIN, qui eux existent. Le
    compteur d'échecs monte quand même — c'est lui qui sort le candidat de la
    file (cf. ``_poll_candidates``).
    """
    # Un candidat reste sur le chemin léger même si ``tiers`` porte un étage
    # furtif hérité : l'interdiction est sur le CANAL, pas sur l'historique.
    tier = x_tier_for(handle, tiers, now_dt) if escalate else "light"
    posts: Optional[List[Dict[str, Any]]] = None

    if tier == "light":
        posts, signal = _x_try(light, parse_fn, handle, pacer, counters,
                               serial_error)
        if not signal:
            fails.pop(handle, None)
            return posts or []
        if signal == "block":
            fails[handle] = _X_ESCALATE_AFTER      # refus franc : on monte tout de suite
        else:
            fails[handle] = int(fails.get(handle) or 0) + 1
        if not escalate:
            return []                              # un candidat ne réveille JAMAIS Chrome
        if int(fails.get(handle) or 0) < _X_ESCALATE_AFTER:
            return []                              # un blip ne réveille pas Chrome
        tier = "stealth"

    posts, signal = _x_try(heavy, parse_fn, handle, pacer, counters,
                           serial_error)
    if signal or posts is None:
        # Le furtif a échoué aussi (typiquement : patchright absent de la
        # machine). On n'inscrit PAS un étage qui ne marche pas — sinon le
        # compte resterait 24 h sur un chemin mort.
        tiers.pop(handle, None)
        return []
    # Escalade réussie : mémorisée pour 24 h. L'horodatage n'est PAS rafraîchi
    # aux passages suivants — sans quoi on ne retenterait jamais le chemin
    # léger, qui coûte mille fois moins cher.
    tiers.setdefault(handle, now_dt.isoformat())
    fails.pop(handle, None)
    return posts


def _run_x_volet(state: Dict[str, Any], now_dt: datetime, cfg: Dict[str, Any],
                 notify_fn: Callable[[str, Dict[str, Any]], bool],
                 sleep_fn: Callable[[float], None], quiet: bool,
                 counters: Dict[str, Any],
                 x_fetch: Optional[Callable[[str], str]] = None,
                 x_stealth: Optional[Callable[[str], str]] = None,
                 x_parse: Optional[Callable[[str, str], List[Dict[str, Any]]]] = None,
                 x_pacer: Any = None,
                 anchor_extra: Optional[Dict[str, str]] = None) -> None:
    """Le volet « comptes influents » : lit les profils suivis, ne garde que ce
    qui est IMPORTANT (``classify_x``), journalise, et n'envoie qu'en mode
    « tout ». MUTE ``state`` — la persistance est faite par l'appelant.

    ``anchor_extra`` (les noms des titres détenus et suivis) descend jusqu'à
    ``classify_x`` : c'est ce qui fait qu'un post nommant une entreprise, sans
    cashtag ni mot politique, devient un événement SYMBOLISÉ.

    ⚠️ Une liste manuelle VIDE ne coupe pas la probation. Elle le faisait (un
    ``return`` en tête), et c'était le pire moment pour l'éteindre : sans compte
    choisi à la main, la découverte est le SEUL moyen d'en avoir un — et il y a
    dix places libres. La boucle ci-dessous ne fait simplement rien quand la
    liste est vide."""
    handles = load_x_accounts()

    light = x_fetch if x_fetch is not None else _fetch_x_light
    heavy = x_stealth if x_stealth is not None else _fetch_x_stealth
    parse_fn = x_parse if x_parse is not None else _parse_x_posts
    pacer = x_pacer if x_pacer is not None else _x_default_pacer()
    serial_error = _x_serialization_error()

    seen = state["seen"]
    events = state["events"]
    seeded = state["seeded"]
    tiers = state["x_tiers"]
    fails = state["x_fails"]
    sent_log = state["x_sent_log"]
    _purge_old_sent_log(sent_log, now_dt, max_age_h=1)
    notified = 0
    first = True

    for handle in handles:
        if not first:
            sleep_fn(pacer.interval())
        first = False

        posts = _x_posts_for(handle, now_dt, tiers, fails, light, heavy,
                             parse_fn, pacer, counters, serial_error)
        seed_key = "x:%s" % handle
        is_first_pass = seed_key not in seeded

        for post in posts[:_X_MAX_POSTS_PER_HANDLE]:
            text = str((post or {}).get("title") or "")
            if not text.strip():
                continue
            key = _hash_link("x:%s:%s" % (handle, text))
            if key in seen:
                continue
            seen[key] = now_dt.isoformat()

            if is_first_pass:
                continue  # seed silencieux, comme les trois autres volets

            published = post.get("published")
            if published:
                try:
                    age_s = now_dt.timestamp() - float(published)
                except (TypeError, ValueError):
                    age_s = 0
                if age_s < 0 or age_s > _GOV_MAX_AGE_S:
                    continue

            verdict = classify_x(text, anchor_extra)
            if verdict is None:
                continue  # mème, pique, photo : jeté, c'est la demande

            _note_mentions_from(state, text, now_dt, handles)
            title = x_post_title(text)
            link = str(post.get("url") or _x_url(handle))
            event = {
                "ts": now_dt.isoformat(),
                "symbol": verdict.get("symbol"),
                "title": title,
                "link": link,
                "sentiment": verdict.get("sentiment"),
                "src": "x",
                "handle": handle,
            }

            if quiet or notified >= _X_MAX_NOTIFY_PER_RUN \
                    or len(sent_log) >= _X_MAX_SENDS_PER_HOUR:
                event["muted"] = True
                events.insert(0, event)
                continue

            try:
                ok = notify_fn(format_x_message(handle, title, link,
                                                event["sentiment"],
                                                event["symbol"]), cfg)
            except Exception as exc:      # noqa: BLE001
                logger.warning("paper newswatch: notif X échouée (%s)",
                               type(exc).__name__)
                ok = False
            if ok:
                counters["notified"] += 1
                notified += 1
                sent_log.append(now_dt.isoformat())
                event["muted"] = False
                events.insert(0, event)
            else:
                counters["errors"] += 1

        if is_first_pass and posts:
            seeded[seed_key] = True

    # --- la file de probation, à basse fréquence ---------------------------- #
    if _counter_due(state, "x_cand_cycle", _X_CANDIDATE_EVERY):
        _poll_candidates(state, now_dt, counters, light, heavy, parse_fn,
                         pacer, serial_error, sleep_fn, anchor_extra)

    candidates = state.get("x_candidates")
    # Photo AVANT le verdict : ``promote_candidates`` SORT le promu de la file,
    # et la persistance vient après. Une écriture qui échoue (disque plein,
    # droits) le perdait des DEUX côtés — ni suivi, ni candidat, et ses deux
    # preuves avec lui.
    before = dict(candidates) if isinstance(candidates, dict) else {}
    outcome = promote_candidates(candidates, handles,
                                 pending_seen=state.get("x_pending_seen"))
    if outcome["promoted"]:
        try:
            save_x_accounts(list(handles) + outcome["promoted"])
        except Exception as exc:      # noqa: BLE001 — disque plein, droits
            # Non persisté -> on REMET les candidats dans la file, avec leurs
            # compteurs intacts. Le prochain passage réessaiera ; rien n'est
            # perdu, et surtout rien n'est promu « à moitié ».
            if isinstance(candidates, dict):
                for handle in outcome["promoted"]:
                    entry = before.get(handle)
                    if isinstance(entry, dict):
                        candidates[handle] = entry
            logger.warning("paper newswatch: promotion X non persistée (%s) — "
                           "candidats replacés dans la file",
                           type(exc).__name__)
        else:
            logger.info("paper newswatch: comptes X promus (%s)",
                        ", ".join(outcome["promoted"]))
    if outcome["pending"]:
        logger.info("paper newswatch: comptes X en attente d'une place "
                    "(la liste manuelle est pleine) : %s",
                    ", ".join(outcome["pending"]))
    if outcome["released"]:
        logger.info("paper newswatch: comptes X libérés de la file après une "
                    "attente sans place (trace gardée) : %s",
                    ", ".join(outcome["released"]))


def _poll_candidates(state: Dict[str, Any], now_dt: datetime,
                     counters: Dict[str, Any], light: Callable[[str], str],
                     heavy: Callable[[str], str],
                     parse_fn: Callable[[str, str], List[Dict[str, Any]]],
                     pacer: Any, serial_error: Any,
                     sleep_fn: Callable[[float], None],
                     anchor_extra: Optional[Dict[str, str]] = None) -> None:
    """Interroge les comptes EN PROBATION — MUTE ``state``.

    Ils passent par exactement la même machinerie que les comptes suivis
    (``_x_posts_for``, ses deux étages, sa mémoire de tier, son cadenceur) : un
    candidat qui se comporte comme un compte suivi doit être MESURÉ comme un
    compte suivi, sinon la promotion ne voudrait rien dire.

    Quatre différences, et elles vont toutes dans le même sens :

    * un candidat **ne parle jamais au téléphone** (ses événements naissent en
      sourdine, quel que soit le mode) ;
    * son compteur de passages monte MÊME quand la page ne rend rien — un compte
      supprimé ou muré doit finir par quitter la file tout seul ;
    * il **ne déclenche jamais le navigateur furtif** (``escalate=False``) et
      ``X_CANDIDATE_MAX_FAILS`` refus le SORTENT de la file séance tenante : un
      candidat est très souvent un compte qui n'existe pas, et payer un Chrome
      pour un 404 en boucle est le pire achat du guetteur ;
    * ses événements sont plafonnés à ``X_CANDIDATE_MAX_EVENTS_PER_RUN`` pour
      TOUT le passage (dix candidats × huit posts = quatre-vingts événements
      possibles contre ``_MAX_EVENTS`` — 300, et 100 quand ce cap a été écrit —
      pour l'historique entier : la file
      la moins fiable chassait tout le reste du fil). Le cap borne la
      JOURNALISATION, jamais la MESURE — les ``hits`` qui décident d'une
      promotion continuent de compter au-delà.
    """
    candidates = state.get("x_candidates")
    if not isinstance(candidates, dict) or not candidates:
        return
    seen = state["seen"]
    events = state["events"]
    tiers = state["x_tiers"]
    fails = state["x_fails"]
    logged = 0

    for handle in sorted(candidates)[:X_CANDIDATE_MAX]:
        entry = candidates.get(handle)
        if not isinstance(entry, dict):
            candidates.pop(handle, None)      # état illisible : on repart net
            continue
        sleep_fn(pacer.interval())
        posts = _x_posts_for(handle, now_dt, tiers, fails, light, heavy,
                             parse_fn, pacer, counters, serial_error,
                             escalate=False)
        try:
            entry["polls"] = int(entry.get("polls") or 0) + 1
        except (TypeError, ValueError):
            entry["polls"] = 1

        if int(fails.get(handle) or 0) >= X_CANDIDATE_MAX_FAILS:
            # Injoignable ou inexistant : on ne le garde pas six passages de
            # plus à re-cogner sur une porte fermée.
            candidates.pop(handle, None)
            fails.pop(handle, None)
            tiers.pop(handle, None)
            logger.info("paper newswatch: candidat X @%s sorti de la file "
                        "(injoignable)", handle)
            continue

        for post in (posts or [])[:_X_MAX_POSTS_PER_HANDLE]:
            text = str((post or {}).get("title") or "")
            if not text.strip():
                continue
            key = _hash_link("x:%s:%s" % (handle, text))
            if key in seen:
                continue
            seen[key] = now_dt.isoformat()
            verdict = classify_x(text, anchor_extra)
            if verdict is None:
                continue
            try:
                entry["hits"] = int(entry.get("hits") or 0) + 1
            except (TypeError, ValueError):
                entry["hits"] = 1
            # La MESURE (ci-dessus) n'est jamais capée ; seule la trace l'est.
            if logged >= X_CANDIDATE_MAX_EVENTS_PER_RUN:
                continue
            logged += 1
            events.insert(0, {
                "ts": now_dt.isoformat(),
                "symbol": verdict.get("symbol"),
                "title": x_post_title(text),
                "link": str(post.get("url") or _x_url(handle)),
                "sentiment": verdict.get("sentiment"),
                "src": "x",
                "handle": handle,
                # Ce qui distingue un candidat d'un compte suivi dans le fil :
                # sans ce drapeau, on ne saurait pas d'où vient l'information —
                # et c'est LUI que la convergence lit pour ne PAS le compter
                # (cf. ``convergence.collect_factors``).
                "candidate": True,
                "muted": True,
            })


# --- le cycle ----------------------------------------------------------------- #

def _gov_event(now_dt: datetime, title: str, link: str, symbol: str,
               muted: bool) -> Dict[str, Any]:
    """Un événement du volet politique, sous ses trois formes (envoyé, mis en
    sourdine, ou mode calme) — une seule fabrique pour que les trois portent
    exactement les mêmes champs.

    ``symbol`` vaut le PSEUDO-symbole « GOV » quand l'annonce ne nomme aucune
    entreprise, et le vrai ticker quand elle en nomme une. La tonalité, elle,
    reste ``gov`` dans les deux cas : c'est toujours une annonce politique, et
    c'est elle qui allume le facteur ``gov`` de la convergence. Un titre
    symbolisé rejoint EN PLUS la branche de ce titre dans la toile — au lieu de
    finir au pivot « monde », où personne n'allait le chercher.
    """
    return {"ts": now_dt.isoformat(), "symbol": symbol, "title": title,
            "link": link, "sentiment": "gov", "muted": muted}


# --- les deux volets MONDE (éco, climat) — un seul moteur -------------------- #
#
# Ils ne diffèrent que par leur requête, leur classifieur, leur formateur et
# leurs deux compteurs. Écrire deux fois le bloc du volet politique, c'était
# garantir qu'un correctif futur n'en toucherait qu'un des deux — c'est
# exactement ce qui rend un anti-spam faux. Un seul moteur, deux fiches.

def _story_muted(stories: Dict[str, Any], key: str, now_dt: datetime,
                 mute_h: float) -> bool:
    """Cette histoire a-t-elle déjà été envoyée il y a moins de ``mute_h`` ?

    Horodatage illisible -> ``False`` (pas de sourdine par prudence) : même
    posture que le volet politique, dont ce code reprend la logique mot pour
    mot. Une clé VIDE (titre sans token significatif) ne mute jamais rien —
    sinon deux dépêches sans rapport partageraient la même clé « vide ».
    """
    if not key:
        return False
    last_iso = stories.get(key)
    if not last_iso:
        return False
    try:
        last_dt = datetime.fromisoformat(last_iso)
    except (TypeError, ValueError):
        return False
    if last_dt.tzinfo is None:
        last_dt = last_dt.replace(tzinfo=timezone.utc)
    return (now_dt - last_dt).total_seconds() / 3600 < mute_h


def _world_event(now_dt: datetime, src: str, title: str, link: str,
                 symbol: Optional[str], sentiment: str,
                 muted: bool) -> Dict[str, Any]:
    """Un événement d'un volet monde, sous ses trois formes (envoyé, mis en
    sourdine, mode calme) — une seule fabrique, comme ``_gov_event``.

    ``symbol`` vient de ``entities.first_company`` : une dépêche macro nomme
    parfois une entreprise (« les droits de douane frappent Boeing »), et c'est
    ce symbole qui la fait rejoindre la BRANCHE de ce titre dans la toile au
    lieu du pivot « monde ». Aucune entreprise reconnue -> ``None``, jamais un
    symbole inventé (doctrine ``entities``).
    """
    return {"ts": now_dt.isoformat(), "symbol": symbol, "title": title,
            "link": link, "sentiment": sentiment, "src": src, "muted": muted}


def _note_mentions_from(state: Dict[str, Any], text: Any, now_dt: datetime,
                        known: Any = ()) -> None:
    """Verse les ``@mentions`` d'un texte RETENU dans la file de probation.

    Appelée depuis chaque volet qui garde quelque chose (monde, presse, X,
    Bluesky) : la découverte se nourrit de ce qu'on a jugé digne d'être gardé,
    jamais de ce qu'on vient de jeter. Best-effort STRICT — un état de
    candidats déformé ne doit pas coûter un cycle de veille.

    ⚠️ **Le volet POLITIQUE en est délibérément exclu.** Une de ses deux sources
    est l'archive de Truth Social, où presque chaque publication interpelle
    quelqu'un : branchée là, la file de dix places se remplirait de comptes
    politiques en une soirée et il n'y aurait plus de place pour un compte de
    marché. On découvre des comptes DE FINANCE, dans de la presse de finance.
    """
    mentions = extract_mentions(text)
    if not mentions:
        return
    candidates = state.get("x_candidates")
    if not isinstance(candidates, dict):
        candidates = {}
        state["x_candidates"] = candidates
    note_mentions(candidates, mentions, now_dt.isoformat(), known)


def _run_world_volet(spec: Dict[str, Any], state: Dict[str, Any],
                     now_dt: datetime, cfg: Dict[str, Any],
                     notify_fn: Callable[[str, Dict[str, Any]], bool],
                     pace: Callable[[], None], quiet: bool,
                     counters: Dict[str, Any],
                     fetch_fn: Callable[[str], str],
                     anchor_extra: Dict[str, str],
                     known_handles: Any = ()) -> None:
    """Un volet monde (éco ou climat) — un passage complet.

    Le déroulé est celui du volet politique, dans le même ordre : dédoublonnage
    par LIEN -> amorçage muet au premier passage -> fraîcheur -> classement ->
    symbole -> mode calme -> anti-spam (histoire, budget horaire, cap par
    passage) -> envoi.

    Deux points où il suit CRYPTO plutôt que GOV, et c'est délibéré :

    * un item écarté par le cap de passage est **journalisé en sourdine** au
      lieu d'être sauté en silence — rien ne se perd, la toile et la
      convergence le voient, seul l'envoi tombe ;
    * son budget horaire est le sien (``spec["sent_log"]``).

    ⚠️ ``spec["max_events"]`` borne la JOURNALISATION, **jamais l'envoi** : une
    décision de taux arrivée en neuvième position doit pouvoir partir. L'envoi
    a ses bornes à lui (``max_notify``, ``max_per_hour``), et un item envoyé est
    journalisé quoi qu'il arrive — le fil doit porter ce que l'utilisateur a
    reçu.

    L'état est modifié EN PLACE (``seen``/``events``/``seeded``/``stories``) ;
    l'appelant sauve une fois pour tous les volets.
    """
    src = spec["src"]
    seen = state["seen"]
    events = state["events"]
    stories = state["stories"]
    sent_log = state[spec["sent_log"]]
    _purge_old_sent_log(sent_log, now_dt, max_age_h=1)
    is_first_pass = src not in state["seeded"]
    notified = 0
    # Cap d'événements JOURNALISÉS par passage, OPTIONNEL (absent -> aucun) —
    # et journalisés SEULEMENT : il ne peut pas empêcher un envoi (cf. plus bas).
    # ``eco``/``climat`` n'en ont pas besoin : leur classifieur a un gate, il
    # rejette la plus grande partie de ce que Google News rend. ``bc``, lui,
    # n'a PAS de gate par construction (la source décide) — trois flux
    # institutionnels relus après une purge de l'état « vu » pourraient donc
    # remplir à eux seuls l'historique et en chasser tout le reste.
    max_events = spec.get("max_events")
    logged = 0

    for url in spec["sources"]:
        pace()
        try:
            xml_text = fetch_fn(url)
        except Exception as exc:      # noqa: BLE001 — réseau/TLS, best-effort
            logger.warning("paper newswatch: fetch %s échoué (%s)", src,
                           type(exc).__name__)
            counters["errors"] += 1
            continue
        counters["fetched"] += 1

        for item in parse_rss(xml_text):
            link = item.get("link")
            if not link:
                continue
            key = _hash_link(link)
            if key in seen:
                continue
            seen[key] = now_dt.isoformat()

            if is_first_pass:
                continue  # amorçage muet, comme tous les autres volets

            pub_ts = item.get("pub_ts") or 0
            age_s = now_dt.timestamp() - pub_ts
            if age_s < 0 or age_s > spec["max_age_s"]:
                continue
            title = item.get("title", "")
            sentiment = spec["classify"](title)
            if sentiment is None:
                continue  # hors sujet, neutre, ou conseil -> juste marqué vu

            symbol = entities.first_company(title, anchor_extra)
            _note_mentions_from(state, title, now_dt, known_handles)
            # ⚠️ Ce cap ne borne QUE la JOURNALISATION, jamais l'ENVOI.
            #
            # Il bornait les deux : un ``continue`` sautait tout le bloc, donc
            # aussi la notification. Sur ``bc``, dont les sources sont trois flux
            # institutionnels relus d'un coup, la décision de taux arrivée en
            # neuvième position était donc étouffée — l'événement le plus
            # important du volet, tu par un garde-fou d'HISTORIQUE.
            #
            # L'envoi a déjà ses propres bornes, et elles sont faites pour ça :
            # ``max_notify`` par passage et ``max_per_hour`` par heure.
            loggable = max_events is None or logged < max_events
            event = _world_event(now_dt, src, title, link, symbol, sentiment,
                                 muted=True)

            if quiet:
                if loggable:
                    logged += 1
                    events.insert(0, event)
                continue

            # Clé d'histoire PRÉFIXÉE par le volet : deux volets peuvent parler
            # du même sujet sans se rendre muets l'un l'autre, et les clés déjà
            # écrites par le volet politique restent valides telles quelles.
            skey = story_key(title)
            mute_key = ("%s:%s" % (src, skey)) if skey else ""
            if (_story_muted(stories, mute_key, now_dt, spec["mute_h"])
                    or len(sent_log) >= spec["max_per_hour"]
                    or notified >= spec["max_notify"]):
                if loggable:
                    logged += 1
                    events.insert(0, event)
                continue

            try:
                ok = notify_fn(spec["format"](title, link, sentiment, symbol),
                               cfg)
            except Exception as exc:  # noqa: BLE001 — un notifieur injecté peut lever
                logger.warning("paper newswatch: notif %s échouée (%s)", src,
                               type(exc).__name__)
                ok = False
            if ok:
                counters["notified"] += 1
                notified += 1
                if mute_key:
                    stories[mute_key] = now_dt.isoformat()
                sent_log.append(now_dt.isoformat())
                event["muted"] = False
                # Journalisé même au-delà du cap : le fil doit porter ce que
                # l'utilisateur a reçu sur son téléphone. Le compteur monte
                # quand même, pour que le cap reste une comptabilité honnête.
                logged += 1
                events.insert(0, event)
            else:
                counters["errors"] += 1

    if is_first_pass:
        state["seeded"][src] = True


#: Les fiches. L'ORDRE est figé (éco, climat, puis banques centrales) pour que
#: deux cycles consomment les sources dans le même sens — un test qui scripte des
#: réponses ne doit pas dépendre du hasard d'un dictionnaire. Une fiche ajoutée
#: se met À LA FIN, pour la même raison.
#:
#: ``cycle_key``/``cycle_every`` sont OPTIONNELS : sans eux le volet tourne à
#: chaque cycle (c'est le cas d'``eco`` et de ``climat``, dont Google News
#: rafraîchit la requête en continu). ``bc`` les porte parce qu'une banque
#: centrale ne publie pas toutes les cinq minutes.
WORLD_VOLETS: Tuple[Dict[str, Any], ...] = (
    {"src": "eco", "sources": _ECO_SOURCES, "max_age_s": _ECO_MAX_AGE_S,
     "classify": classify_eco, "format": format_eco_message,
     "max_notify": _MAX_ECO_NOTIFY_PER_RUN,
     "max_per_hour": _ECO_MAX_SENDS_PER_HOUR,
     "sent_log": "eco_sent_log", "mute_h": _WORLD_STORY_MUTE_H},
    {"src": "climat", "sources": _CLIMAT_SOURCES,
     "max_age_s": _CLIMAT_MAX_AGE_S,
     "classify": classify_climat, "format": format_climat_message,
     "max_notify": _MAX_CLIMAT_NOTIFY_PER_RUN,
     "max_per_hour": _CLIMAT_MAX_SENDS_PER_HOUR,
     "sent_log": "climat_sent_log", "mute_h": _WORLD_STORY_MUTE_H},
    {"src": "bc", "sources": _BC_SOURCES, "max_age_s": _BC_MAX_AGE_S,
     "classify": classify_bc, "format": format_bc_message,
     "max_notify": _MAX_BC_NOTIFY_PER_RUN,
     "max_per_hour": _BC_MAX_SENDS_PER_HOUR,
     "sent_log": "bc_sent_log", "mute_h": _WORLD_STORY_MUTE_H,
     "cycle_key": "bc_cycle", "cycle_every": _BC_CYCLE_EVERY,
     "max_events": _BC_MAX_EVENTS_PER_RUN},
)


def _volet_due(state: Dict[str, Any], spec: Dict[str, Any]) -> bool:
    """Ce volet cadencé doit-il tourner ce cycle ? — MUTE ``state`` (le compteur
    est incrémenté À CHAQUE cycle, qu'on tourne ou non).

    Le compteur est lu AVANT d'être incrémenté, exactement comme les volets X et
    Reddit : un déploiement neuf (compteur à 0) interroge donc la source dès son
    premier cycle, au lieu d'attendre un quart d'heure sans raison.
    """
    key = spec.get("cycle_key")
    if not key:
        return True
    cycle = state.get(key) or 0
    try:
        state[key] = int(cycle) + 1
    except (TypeError, ValueError):
        state[key] = 1
    return cycle_due(cycle, spec.get("cycle_every"))


def _counter_due(state: Dict[str, Any], key: str, every: int) -> bool:
    """Version « volet libre » de ``_volet_due`` (pour ceux qui n'ont pas de
    fiche ``WORLD_VOLETS``) — même règle, même lecture-avant-incrément."""
    return _volet_due(state, {"cycle_key": key, "cycle_every": every})


# --- volet PRESSE FINANCIÈRE MONDIALE (W2a) -------------------------------- #

def _run_pressefi_volet(state: Dict[str, Any], now_dt: datetime,
                        cfg: Dict[str, Any],
                        notify_fn: Callable[[str, Dict[str, Any]], bool],
                        sleep_fn: Callable[[float], None], quiet: bool,
                        counters: Dict[str, Any],
                        fetch_fn: Callable[[str], Any],
                        anchor_extra: Dict[str, str],
                        known_handles: Any = (),
                        collect: Optional[Callable[..., Any]] = None) -> None:
    """La presse financière du monde — MUTE ``state``, la persistance est faite
    par l'appelant.

    **La collecte n'est pas écrite ici.** Elle est déléguée à
    ``pulse.news.collect_news`` (cf. ``_news_module``), qui porte déjà la
    fraîcheur, la détection des flux périmés, le refus des conseils
    d'investissement, le refus du hors-sujet et le partage équitable par source.
    Ce qui est écrit ici, c'est ce que la veille en FAIT : dédoublonnage,
    symbolisation, tonalité, anti-spam, journalisation.

    Tonalité : ``classify`` est calibré EN/FR/IT. Un titre allemand qu'il ne sait
    pas trancher devient ``neutral`` — journalisé, jamais envoyé, et PLAFONNÉ par
    symbole (``cap_neutral``). C'est la posture honnête : on garde le fait, on ne
    lui invente pas une couleur.
    """
    feeds = pressefi_feeds()
    if not feeds:
        return
    collect_fn = collect if collect is not None else _collect_news

    try:
        payload = collect_fn(fetch=fetch_fn, feeds=feeds,
                             now_ts=int(now_dt.timestamp()),
                             max_age_h=_PRESSEFI_MAX_AGE_H,
                             per_source=_PRESSEFI_PER_SOURCE,
                             max_items=_PRESSEFI_MAX_ITEMS,
                             pacing_s=_PACE_S, sleep=sleep_fn)
    except Exception as exc:      # noqa: BLE001 — moteur absent, réseau, TLS
        logger.warning("paper newswatch: presse mondiale indisponible (%s)",
                       type(exc).__name__)
        counters["errors"] += 1
        return

    payload = payload if isinstance(payload, dict) else {}
    counters["fetched"] += len(payload.get("sources_ok") or [])
    counters["errors"] += len(payload.get("sources_failed") or [])
    stale = payload.get("stale_sources") or []
    if stale:
        # Un flux qui répond 200 avec des titres vieux de treize mois est
        # indiscernable d'un flux sain sans regarder les dates (piège #67c).
        # On le DIT dans les journaux plutôt que de recopier ses titres.
        logger.info("paper newswatch: flux de presse sans rien de frais (%s)",
                    ", ".join(str(name) for name in stale[:8]))

    seen = state["seen"]
    events = state["events"]
    stories = state["stories"]
    sent_log = state["pressefi_sent_log"]
    _purge_old_sent_log(sent_log, now_dt, max_age_h=1)
    is_first_pass = "pressefi" not in state["seeded"]
    logged = 0
    notified = 0
    saw_something = False

    for item in (payload.get("items") or []):
        if not isinstance(item, dict):
            continue
        title = " ".join(str(item.get("title") or "").split())
        if not title:
            continue
        saw_something = True
        link = str(item.get("url") or "").strip()
        # Clé sur le LIEN NU (et non préfixée par le volet) : c'est ce qui fait
        # qu'une dépêche déjà vue par un autre volet n'est pas racontée deux
        # fois sous deux étiquettes différentes.
        key = _hash_link(link or "pressefi:%s" % title)
        if key in seen:
            continue
        seen[key] = now_dt.isoformat()

        if is_first_pass:
            continue          # amorçage muet, comme tous les autres volets

        if is_advice(title):
            # La cascade les a déjà écartés ; la garde reste posée parce que la
            # doctrine ne dépend pas du bon vouloir d'un module voisin.
            continue

        symbol = entities.first_company(title, anchor_extra)
        _note_mentions_from(state, title, now_dt, known_handles)
        sentiment = classify(title) or NEUTRAL_SENTIMENT

        if logged >= _PRESSEFI_MAX_EVENTS_PER_RUN:
            continue
        logged += 1
        event = {"ts": now_dt.isoformat(), "symbol": symbol, "title": title,
                 "link": link, "sentiment": sentiment, "src": "pressefi",
                 "source": str(item.get("source") or ""),
                 "lang": str(item.get("lang") or ""), "muted": True}

        skey = story_key(title)
        mute_key = ("pressefi:%s" % skey) if skey else ""
        if (quiet
                or sentiment == NEUTRAL_SENTIMENT
                or _story_muted(stories, mute_key, now_dt, _WORLD_STORY_MUTE_H)
                or len(sent_log) >= _PRESSEFI_MAX_SENDS_PER_HOUR
                or notified >= _MAX_PRESSEFI_NOTIFY_PER_RUN):
            events.insert(0, event)
            if sentiment == NEUTRAL_SENTIMENT:
                cap_neutral(events, symbol)
            continue

        try:
            ok = notify_fn(format_pressefi_message(
                event["source"], title, link, sentiment, symbol), cfg)
        except Exception as exc:  # noqa: BLE001 — un notifieur injecté peut lever
            logger.warning("paper newswatch: notif presse échouée (%s)",
                           type(exc).__name__)
            ok = False
        if ok:
            counters["notified"] += 1
            notified += 1
            if mute_key:
                stories[mute_key] = now_dt.isoformat()
            sent_log.append(now_dt.isoformat())
            event["muted"] = False
            events.insert(0, event)
        else:
            counters["errors"] += 1

    if is_first_pass and saw_something:
        # Seulement si la cascade a VRAIMENT rendu quelque chose : marquer
        # l'amorçage fait alors que les seize sources étaient muettes ferait
        # partir une rafale au cycle suivant, exactement ce que l'amorçage
        # existe pour empêcher.
        state["seeded"]["pressefi"] = True


# --- volet BLUESKY (W2a) ---------------------------------------------------- #

def _run_bsky_volet(state: Dict[str, Any], now_dt: datetime,
                    cfg: Dict[str, Any],
                    notify_fn: Callable[[str, Dict[str, Any]], bool],
                    sleep_fn: Callable[[float], None], quiet: bool,
                    counters: Dict[str, Any],
                    anchor_extra: Dict[str, str],
                    known_handles: Any = (),
                    bsky_fetch: Optional[Callable[[str], Any]] = None,
                    bsky_parse: Optional[Callable[[Any], List[Dict[str, Any]]]] = None
                    ) -> None:
    """Le social OUVERT — recherche Bluesky, une requête à la fois. MUTE
    ``state``.

    Les requêtes sont RECONSTRUITES à chaque passage depuis les ancres du
    portefeuille (``bsky_queries``) : quand Massii achète un titre, le volet se
    met à écouter ce qu'on en dit, sans qu'il ait rien à configurer. Et quand il
    le vend, on arrête — sans qu'une requête morte reste dans un fichier.
    """
    targets = _bsky_urls(bsky_queries(anchor_extra))
    if not targets:
        return
    fetch = bsky_fetch if bsky_fetch is not None else _fetch_bsky
    parse = bsky_parse if bsky_parse is not None else _parse_bsky_posts

    seen = state["seen"]
    events = state["events"]
    sent_log = state["bsky_sent_log"]
    _purge_old_sent_log(sent_log, now_dt, max_age_h=1)
    is_first_pass = "bsky" not in state["seeded"]
    logged = 0
    notified = 0
    saw_something = False
    first = True

    for query, url in targets:
        if not first:
            sleep_fn(_PACE_S)
        first = False

        try:
            raw = fetch(url)
        except Exception as exc:      # noqa: BLE001 — réseau, TLS, 429
            logger.warning("paper newswatch: Bluesky injoignable (%s)",
                           type(exc).__name__)
            counters["errors"] += 1
            continue
        counters["fetched"] += 1

        try:
            posts = parse(raw) or []
        except Exception as exc:      # noqa: BLE001 — réponse illisible
            logger.warning("paper newswatch: Bluesky illisible (%s)",
                           type(exc).__name__)
            counters["errors"] += 1
            continue

        for post in posts[:_BSKY_MAX_POSTS_PER_QUERY]:
            if not isinstance(post, dict):
                continue
            text = str(post.get("title") or "").strip()
            if not text:
                continue
            saw_something = True
            link = str(post.get("url") or "").strip()
            key = _hash_link("bsky:%s" % (link or text))
            if key in seen:
                continue
            seen[key] = now_dt.isoformat()

            if is_first_pass:
                continue          # amorçage muet, comme tous les autres volets

            if _post_dt(post.get("published"), now_dt, _BSKY_MAX_AGE_S) is None:
                continue

            verdict = classify_social(text, anchor_extra)
            if verdict is None:
                continue          # bavardage : jeté, comme sur X

            title = x_post_title(text)
            author = str(post.get("author") or "")
            _note_mentions_from(state, text, now_dt, known_handles)

            if logged >= _BSKY_MAX_EVENTS_PER_RUN:
                continue
            logged += 1
            event = {"ts": now_dt.isoformat(), "symbol": verdict.get("symbol"),
                     "title": title, "link": link,
                     "sentiment": verdict.get("sentiment"), "src": "bsky",
                     "handle": author, "query": query, "muted": True}

            if (quiet or notified >= _MAX_BSKY_NOTIFY_PER_RUN
                    or len(sent_log) >= _BSKY_MAX_SENDS_PER_HOUR):
                events.insert(0, event)
                continue

            try:
                ok = notify_fn(format_bsky_message(author, title, link,
                                                   event["sentiment"],
                                                   event["symbol"]), cfg)
            except Exception as exc:      # noqa: BLE001
                logger.warning("paper newswatch: notif Bluesky échouée (%s)",
                               type(exc).__name__)
                ok = False
            if ok:
                counters["notified"] += 1
                notified += 1
                sent_log.append(now_dt.isoformat())
                event["muted"] = False
                events.insert(0, event)
            else:
                counters["errors"] += 1

    if is_first_pass and saw_something:
        state["seeded"]["bsky"] = True


def run_once(now: Optional[datetime] = None,
            fetch: Optional[Callable[[str], str]] = None,
            notifier: Optional[Callable[[str, Dict[str, Any]], bool]] = None,
            tg_cfg: Optional[Dict[str, Any]] = None,
            sleep: Optional[Callable[[float], None]] = None,
            mode: Optional[str] = None,
            x_fetch: Optional[Callable[[str], str]] = None,
            x_stealth: Optional[Callable[[str], str]] = None,
            x_parse: Optional[Callable[[str, str], List[Dict[str, Any]]]] = None,
            x_pacer: Any = None,
            reddit_fetch: Optional[Callable[[str], Any]] = None,
            reddit_parse: Optional[Callable[[Any], List[Dict[str, Any]]]] = None,
            news_collect: Optional[Callable[..., Any]] = None,
            bsky_fetch: Optional[Callable[[str], Any]] = None,
            bsky_parse: Optional[Callable[[Any], List[Dict[str, Any]]]] = None,
            converge: Optional[Callable[..., Any]] = None,
            judge: Optional[Callable[..., Any]] = None,
            translate: Optional[Callable[..., Any]] = None) -> Dict[str, Any]:
    """Un cycle de veille news, DIX volets :

    1. **politique GLOBAL** (toujours, même sans portefeuille) ;
    2. **crypto GLOBAL** (26/08 — le coach n'avait aucune matière crypto) ;
    3. **économie GLOBALE** (26/08 soir — macro : banques centrales, inflation,
       taux, emploi, pétrole) ;
    4. **écologie GLOBALE** (26/08 soir — un aléa climatique ET sa dimension
       économique, jamais la météo seule) ;
    5. **banques centrales OFFICIELLES** (W2a — un cycle sur trois : Fed, BCE,
       BNS à la source, sans intermédiaire ni délai rédactionnel) ;
    6. **presse financière MONDIALE** (W2a — un cycle sur six, cascade Market
       Pulse : Suisse, Allemagne, Royaume-Uni, Hong Kong, Inde) ;
    7. **Bluesky** (W2a — un cycle sur trois : le social ouvert, deux requêtes
       génériques + le nom de chaque titre détenu ou suivi) ;
    8. **comptes X influents** (26/08 — un cycle sur deux) — plus, depuis W2a,
       la **file de probation** des comptes découverts par ``@mention`` ;
    9. **tendances Reddit** (26/08 — un cycle sur trois, ne notifie jamais) ;
    10. **par utilisateur, par symbole** détenu ∪ suivi (RSS Yahoo).

    Retourne ``{users, symbols, fetched, notified, errors, convergence_fired}``
    — les volets globaux contribuent à fetched/notified/errors mais jamais à
    users/symbols (qui ne parlent que des portefeuilles).

    **Mode d'alerte** (``alerts.get_mode``, lu UNE fois ici et propagé) : en
    « calme » — le défaut — aucun de ces volets n'ENVOIE quoi que ce soit ; ils
    enregistrent exactement la même matière, marquée ``"muted": True``. Seule
    la convergence parle. En « tout », comportement historique.

    **Convergence événementielle** : à la toute fin, la couche de convergence
    est consultée (best-effort). C'est la demande — « quand les bons facteurs
    sont là, il s'active tout de suite, pas au prochain réveil planifié ». Le
    coût reste nul en régime normal : ``convergence.should_fire`` sort avant
    tout appel au modèle tant que les facteurs ne s'alignent pas.

    **Traduction des titres étrangers** (27/08) : EN TOUT DERNIER, un sweep
    best-effort (``paper.translate``) traduit vers le français les titres
    ALLEMANDS accumulés dans les dépêches politiques GLOBALES (c'est là que
    la presse mondiale du volet 6 écrit — NZZ/cash.ch/Handelsblatt). Coût nul
    en régime normal : le sweep gate lui-même sur l'heure (son propre cache
    disque, pas un compteur de cycle ici — cf. tête de ``translate.py``), et
    n'appelle le modèle qu'une fois par heure au plus, jamais par titre.

    Sans config Telegram -> ne fait RIEN du tout (ni disque ni réseau, feature
    opt-in silencieuse) : c'est vérifié EN PREMIER, avant tout accès à data/.
    """
    counters: Dict[str, Any] = {"users": 0, "symbols": 0, "fetched": 0,
                                "notified": 0, "errors": 0,
                                "convergence_fired": False, "verdicts": 0}

    cfg = tg_cfg if tg_cfg is not None else (alerts.load_cfg() or {})
    if not cfg.get("token") or not cfg.get("chat_id"):
        logger.debug("paper newswatch: Telegram non configuré, rien à faire")
        return counters

    now_dt = now if now is not None else datetime.now(timezone.utc)
    if now_dt.tzinfo is None:
        now_dt = now_dt.replace(tzinfo=timezone.utc)
    fetch_fn = fetch if fetch is not None else _fetch_rss
    notify_fn = notifier if notifier is not None else alerts.send
    sleep_fn = sleep if sleep is not None else time.sleep
    # UNE seule lecture du mode pour tout le cycle : deux lectures pourraient
    # tomber de part et d'autre d'un changement de réglage et rendre le même
    # passage à moitié bavard.
    quiet = alerts.is_quiet(mode)

    # Les portefeuilles sont découverts UNE fois pour tout le cycle : le volet
    # par-symbole les parcourt, et les QUATRE volets ont besoin des noms des
    # titres détenus/suivis pour reconnaître une entreprise citée dans un titre
    # (« ...à Nvidia » -> NVDA). Deux découvertes parallèles finiraient par
    # diverger — l'une verrait un compte que l'autre ignore.
    portfolios = _discover_portfolios()
    try:
        anchor_extra = _anchor_extra(portfolios)
    except Exception as exc:      # noqa: BLE001 — reconnaissance best-effort
        logger.warning("paper newswatch: ancres illisibles (%s)",
                       type(exc).__name__)
        anchor_extra = {}

    first_call = True

    # ----------------------------------------------------------------- #
    # Volet 1 -- annonces politiques GLOBALES (§13). Tourne TOUJOURS, même
    # si personne ne détient de position : une politique commerciale ne
    # demande pas la permission d'un portefeuille pour bouger le marché.
    #
    # Anti-spam par HISTOIRE (incident du 24/08 soir, cf. commentaire de tête
    # ~L99) : deux couches AVANT le cap historique par-run
    # (_MAX_GOV_NOTIFY_PER_RUN, inchangé) -- mute par story_key (6h) puis
    # budget dur glissant (_GOV_MAX_SENDS_PER_HOUR). Les deux marquent
    # l'item vu (déjà fait plus haut) ET journalisent un event
    # "muted": True (rien n'est perdu, cf. tête de fichier) ; le cap
    # historique, lui, continue de sauter l'item EN SILENCE (comportement
    # préexistant conservé tel quel).
    # ----------------------------------------------------------------- #
    gov_state = _load_global_seen()
    gov_seen = gov_state["seen"]
    gov_seeded = gov_state["seeded"]
    gov_events = gov_state["events"]
    gov_stories = gov_state["stories"]
    gov_sent_log = gov_state["sent_log"]
    _purge_old_sent_log(gov_sent_log, now_dt, max_age_h=1)
    gov_changed = False
    gov_is_first_pass = "gov" not in gov_seeded
    gov_notified_count = 0

    for gov_url in _GOV_SOURCES:
        if not first_call:
            sleep_fn(_PACE_S)
        first_call = False

        try:
            xml_text = fetch_fn(gov_url)
        except Exception as exc:
            logger.warning("paper newswatch: fetch gov échoué (%s)", type(exc).__name__)
            counters["errors"] += 1
            continue
        counters["fetched"] += 1
        items = parse_rss(xml_text)

        for item in items:
            link = item.get("link")
            if not link:
                continue
            key = _hash_link(link)
            if key in gov_seen:
                continue
            gov_seen[key] = now_dt.isoformat()
            gov_changed = True

            if gov_is_first_pass:
                continue  # anti-tempête au déploiement : seed, on ne notifie rien

            pub_ts = item.get("pub_ts") or 0
            age_s = now_dt.timestamp() - pub_ts
            if age_s < 0 or age_s > _GOV_MAX_AGE_S:
                continue
            title = item.get("title", "")
            if not classify_gov(title):
                continue  # neutre/électoral -> juste marqué vu

            # Une annonce politique qui NOMME une entreprise porte son ticker
            # (extension 26/08) ; sinon le pseudo-symbole « GOV » historique.
            gov_symbol = entities.first_company(title, anchor_extra) or "GOV"

            if quiet:
                # Mode calme : la matière est gardée intacte (feed, mémoire,
                # convergence), seul l'ENVOI disparaît. On court-circuite donc
                # tout l'appareil anti-spam, qui ne protège que l'envoi.
                gov_events.insert(0, _gov_event(now_dt, title, link, gov_symbol,
                                                muted=True))
                continue

            skey = story_key(title)
            muted = False
            last_sent_iso = gov_stories.get(skey)
            if last_sent_iso:
                try:
                    last_sent_dt = datetime.fromisoformat(last_sent_iso)
                    if last_sent_dt.tzinfo is None:
                        last_sent_dt = last_sent_dt.replace(tzinfo=timezone.utc)
                    age_story_h = (now_dt - last_sent_dt).total_seconds() / 3600
                    muted = age_story_h < _GOV_STORY_MUTE_H
                except (TypeError, ValueError):
                    muted = False  # horodatage illisible -> pas de mute par prudence
            if not muted and len(gov_sent_log) >= _GOV_MAX_SENDS_PER_HOUR:
                muted = True

            if muted:
                gov_events.insert(0, _gov_event(now_dt, title, link, gov_symbol,
                                                muted=True))
                continue

            if gov_notified_count >= _MAX_GOV_NOTIFY_PER_RUN:
                continue

            message = format_gov_message(title, link)
            try:
                ok = notify_fn(message, cfg)
            except Exception as exc:
                logger.warning("paper newswatch: notif gov échouée (%s)", type(exc).__name__)
                ok = False
            if ok:
                counters["notified"] += 1
                gov_notified_count += 1
                gov_stories[skey] = now_dt.isoformat()
                gov_sent_log.append(now_dt.isoformat())
                gov_events.insert(0, _gov_event(now_dt, title, link, gov_symbol,
                                                muted=False))
            else:
                counters["errors"] += 1

    if gov_is_first_pass:
        gov_seeded["gov"] = True
        gov_changed = True  # persiste le flag même si les deux flux étaient vides

    # ----------------------------------------------------------------- #
    # Volet 1bis -- CRYPTO GLOBAL (26/08). Même état que le volet politique
    # (fichier global) : ces deux volets parlent à TOUT LE MONDE, pas à un
    # portefeuille. Budget d'envoi PROPRE (cf. _CRYPTO_MAX_SENDS_PER_HOUR).
    #
    # Le gate de pertinence de classify_crypto est ce qui rend Decrypt (flux
    # tech mélangé) utilisable : un titre sans marqueur crypto est marqué vu
    # et rien d'autre.
    # ----------------------------------------------------------------- #
    crypto_sent_log = gov_state["crypto_sent_log"]
    _purge_old_sent_log(crypto_sent_log, now_dt, max_age_h=1)
    crypto_is_first_pass = "crypto" not in gov_seeded
    crypto_notified_count = 0

    for crypto_url in _CRYPTO_SOURCES:
        if not first_call:
            sleep_fn(_PACE_S)
        first_call = False

        try:
            xml_text = fetch_fn(crypto_url)
        except Exception as exc:
            logger.warning("paper newswatch: fetch crypto échoué (%s)",
                           type(exc).__name__)
            counters["errors"] += 1
            continue
        counters["fetched"] += 1

        for item in parse_rss(xml_text):
            link = item.get("link")
            if not link:
                continue
            key = _hash_link(link)
            if key in gov_seen:
                continue
            gov_seen[key] = now_dt.isoformat()
            gov_changed = True

            if crypto_is_first_pass:
                continue  # seed silencieux, comme les autres volets

            pub_ts = item.get("pub_ts") or 0
            age_s = now_dt.timestamp() - pub_ts
            if age_s < 0 or age_s > _CRYPTO_MAX_AGE_S:
                continue
            title = item.get("title", "")
            sentiment = classify_crypto(title)
            if sentiment is None:
                continue  # hors sujet (le SpaceX de Decrypt) ou neutre

            symbol = crypto_symbol(title)
            event = {
                "ts": now_dt.isoformat(),
                "symbol": symbol,
                "title": title,
                "link": link,
                "sentiment": sentiment,
                "src": "crypto",
            }

            if quiet:
                event["muted"] = True
                gov_events.insert(0, event)
                continue
            if (crypto_notified_count >= _MAX_CRYPTO_NOTIFY_PER_RUN
                    or len(crypto_sent_log) >= _CRYPTO_MAX_SENDS_PER_HOUR):
                event["muted"] = True
                gov_events.insert(0, event)
                continue

            try:
                ok = notify_fn(format_crypto_message(title, link, sentiment,
                                                     symbol), cfg)
            except Exception as exc:
                logger.warning("paper newswatch: notif crypto échouée (%s)",
                               type(exc).__name__)
                ok = False
            if ok:
                counters["notified"] += 1
                crypto_notified_count += 1
                crypto_sent_log.append(now_dt.isoformat())
                event["muted"] = False
                gov_events.insert(0, event)
            else:
                counters["errors"] += 1

    if crypto_is_first_pass:
        gov_seeded["crypto"] = True
        gov_changed = True

    # ----------------------------------------------------------------- #
    # Volets 1ter -- ÉCONOMIE et ÉCOLOGIE (26/08 soir).
    #
    # « Grosse partie des infos c'est que politique — il y a aussi
    # l'économique, l'écologique. » Même état global, même cadence, même
    # anti-spam, budgets d'envoi PROPRES (cf. WORLD_VOLETS). Leur tonalité
    # est pos/neg/watch : ils rejoignent le pool de presse générique de la
    # convergence, JAMAIS le facteur « gov », qui reste politique.
    # ----------------------------------------------------------------- #
    def _pace() -> None:
        """L'espacement partagé du cycle (piège #67 : un burst = 429). Pas de
        pause avant le tout premier fetch, une pause avant chacun des
        suivants — exactement la règle des volets écrits avant celui-ci."""
        nonlocal first_call
        if not first_call:
            sleep_fn(_PACE_S)
        first_call = False

    # Les comptes X déjà suivis, lus UNE fois : la file de probation ne doit
    # jamais inscrire un compte qui est déjà en poste, et chaque volet qui garde
    # un texte y verse ses ``@mentions`` (cf. ``_note_mentions_from``).
    try:
        known_handles = tuple(load_x_accounts())
    except Exception as exc:      # noqa: BLE001 — fichier illisible
        logger.warning("paper newswatch: comptes X illisibles (%s)",
                       type(exc).__name__)
        known_handles = ()

    for spec in WORLD_VOLETS:
        if not _volet_due(gov_state, spec):
            continue
        _run_world_volet(spec, gov_state, now_dt, cfg, notify_fn, _pace,
                         quiet, counters, fetch_fn, anchor_extra,
                         known_handles=known_handles)
    gov_changed = True

    # ----------------------------------------------------------------- #
    # Volet 1sexies -- PRESSE FINANCIÈRE MONDIALE (W2a), UN CYCLE SUR SIX.
    #
    # C'est du CONTEXTE : seize sources, une revue de presse, pas une alerte.
    # Sa cascade de collecte est celle de Market Pulse, empruntée telle
    # quelle (cf. _run_pressefi_volet) — la réécrire, ce serait reperdre
    # une par une les cinq leçons qu'elle porte.
    # ----------------------------------------------------------------- #
    if _counter_due(gov_state, "pressefi_cycle", _PRESSEFI_CYCLE_EVERY):
        _run_pressefi_volet(gov_state, now_dt, cfg, notify_fn, sleep_fn, quiet,
                            counters, fetch_fn, anchor_extra,
                            known_handles=known_handles, collect=news_collect)

    # ----------------------------------------------------------------- #
    # Volet 1septies -- BLUESKY (W2a), UN CYCLE SUR TROIS. Le social OUVERT :
    # deux requêtes génériques + le nom des titres détenus/suivis.
    # ----------------------------------------------------------------- #
    if _counter_due(gov_state, "bsky_cycle", _BSKY_CYCLE_EVERY):
        _run_bsky_volet(gov_state, now_dt, cfg, notify_fn, sleep_fn, quiet,
                        counters, anchor_extra, known_handles=known_handles,
                        bsky_fetch=bsky_fetch, bsky_parse=bsky_parse)

    # ----------------------------------------------------------------- #
    # Volet 1quater -- comptes X influents (26/08), UN CYCLE SUR DEUX.
    # ----------------------------------------------------------------- #
    # Le compteur est lu AVANT d'être incrémenté : un déploiement neuf
    # (compteur à 0) interroge donc X dès son premier cycle, au lieu
    # d'attendre dix minutes sans raison.
    x_cycle = int(gov_state.get("x_cycle") or 0)
    gov_state["x_cycle"] = x_cycle + 1
    gov_changed = True
    if x_cycle_due(x_cycle):
        _run_x_volet(gov_state, now_dt, cfg, notify_fn, sleep_fn, quiet,
                     counters, x_fetch, x_stealth, x_parse, x_pacer,
                     anchor_extra=anchor_extra)

    # ----------------------------------------------------------------- #
    # Volet 1quinquies -- tendances Reddit (26/08), UN CYCLE SUR TROIS.
    #
    # Même lecture du compteur AVANT incrément que le volet X : un
    # déploiement neuf interroge Reddit dès son premier cycle. Ce volet
    # n'envoie RIEN (cf. _run_reddit_volet) — il n'a donc ni budget d'envoi
    # ni cap de notification, seulement un cap d'événements journalisés.
    # ----------------------------------------------------------------- #
    reddit_cycle = int(gov_state.get("reddit_cycle") or 0)
    gov_state["reddit_cycle"] = reddit_cycle + 1
    gov_changed = True          # le compteur de cadence DOIT être persisté
    if reddit_cycle_due(reddit_cycle):
        _run_reddit_volet(gov_state, now_dt, anchor_extra, counters,
                          reddit_fetch, reddit_parse)

    # ----------------------------------------------------------------- #
    # Volet 1sexies -- le VERDICT DU JOUR J (27/08), UN CYCLE SUR TROIS.
    #
    # Le simulateur savait dire « il va se passer quelque chose le 17 » ; il ne
    # disait jamais ce qui s'était RÉELLEMENT passé le 17. Ce passage juge les
    # rendez-vous arrivés à échéance, et ses verdicts deviennent des facteurs
    # de convergence (``event_flop``/``event_confirmed``).
    #
    # POURQUOI ICI, et pas dans le chemin d'un endpoint : le jugement coûte des
    # cotations et une relecture des dépêches. Le brancher sur le cycle du
    # guetteur le rend gratuit du point de vue de l'utilisateur — et surtout il
    # tourne même quand personne n'a ouvert le tableau de bord, ce qui est
    # exactement le cas où l'avertissement compte (« le jour J c'est un flop ->
    # le coach m'avertit VITE »).
    #
    # Un cycle sur trois, comme Reddit : les cours bougent en continu, mais un
    # verdict rendu quinze minutes plus tôt ne change aucune décision, et le
    # compteur lu AVANT incrément fait qu'un déploiement neuf juge dès son
    # premier cycle.
    #
    # AVANT la sauvegarde de l'état global et AVANT ``_fire_convergence`` : la
    # convergence relit les verdicts, elle doit voir ceux de CE cycle.
    # ----------------------------------------------------------------- #
    calendar_cycle = int(gov_state.get("calendar_cycle") or 0)
    gov_state["calendar_cycle"] = calendar_cycle + 1
    if calendar_cycle_due(calendar_cycle):
        counters["verdicts"] = _run_calendar_verdicts(now_dt, counters,
                                                      judge=judge)

    if gov_changed:
        gov_state["events"] = gov_events[:_MAX_EVENTS]
        _purge_old_seen(gov_state, now_dt)
        _save_global_seen(gov_state)

    # ----------------------------------------------------------------- #
    # Volet 2 -- par utilisateur, par symbole détenu ∪ symbole en watchlist
    # (extension 25/08 -- cf. _merged_symbols).
    # ----------------------------------------------------------------- #
    for username, portfolio in portfolios:
        counters["users"] += 1
        symbols = _merged_symbols(portfolio, username)
        state = _load_seen(username)
        seen = state["seen"]
        seeded = state["seeded"]
        events = state["events"]
        changed = False

        for symbol in symbols:
            counters["symbols"] += 1
            if not first_call:
                sleep_fn(_PACE_S)
            first_call = False

            try:
                xml_text = fetch_fn(_rss_url(symbol))
            except Exception as exc:  # réseau/TLS/HTTP -- best-effort
                logger.warning("paper newswatch: fetch échoué pour %s (%s)",
                               symbol, type(exc).__name__)
                counters["errors"] += 1
                continue
            counters["fetched"] += 1
            items = parse_rss(xml_text)

            is_first_pass = symbol not in seeded
            notified_for_symbol = 0

            for item in items:
                link = item.get("link")
                if not link:
                    continue
                key = _hash_link(link)
                if key in seen:
                    continue
                # marqué vu dans TOUS les cas -- jamais retraité, jamais
                # renotifié, même si non éligible / au-delà du cap ci-dessous.
                seen[key] = now_dt.isoformat()
                changed = True

                if is_first_pass:
                    continue  # anti-tempête au déploiement : on seed, on ne notifie rien

                pub_ts = item.get("pub_ts") or 0
                age_s = now_dt.timestamp() - pub_ts
                if age_s < 0 or age_s > _MAX_AGE_S:
                    continue  # trop vieux (ou horloge en avance) -> vu, pas notifié

                sentiment = classify(item.get("title", ""))
                if sentiment is None:
                    # NEUTRE : journalisé, JAMAIS envoyé (dans aucun mode),
                    # jamais compté par la convergence. C'est ce qui donne une
                    # branche de presse à un titre dont le flux ne dit rien de
                    # tranché -- le cas le plus fréquent. Un CONSEIL, lui, reste
                    # jeté : le recopier serait le relayer.
                    if not is_advice(item.get("title", "")):
                        events.insert(0, {
                            "ts": now_dt.isoformat(),
                            "symbol": symbol,
                            "title": item["title"],
                            "link": link,
                            "sentiment": NEUTRAL_SENTIMENT,
                            "muted": True,
                        })
                        cap_neutral(events, symbol)
                    continue

                # Le cap ne concerne QUE les envois -- il est donc lu APRÈS le
                # tri ci-dessus, sinon trois dépêches à tonalité suffiraient à
                # rendre la branche presse muette pour le reste du passage.
                if notified_for_symbol >= _MAX_NOTIFY_PER_SYMBOL:
                    continue  # cap atteint -> le reste reste marqué vu, pas notifié

                if quiet:
                    # Mode calme : on journalise EXACTEMENT ce que le mode
                    # bavard aurait envoyé (même cap par symbole, donc même
                    # matière pour la convergence), sans rien envoyer.
                    notified_for_symbol += 1
                    events.insert(0, {
                        "ts": now_dt.isoformat(),
                        "symbol": symbol,
                        "title": item["title"],
                        "link": link,
                        "sentiment": sentiment,
                        "muted": True,
                    })
                    continue

                message = format_message(symbol, item["title"], link, sentiment)
                try:
                    ok = notify_fn(message, cfg)
                except Exception as exc:
                    # notify.send ne lève déjà jamais lui-même ; on reste
                    # défensif si un futur notifier injecté, lui, lève.
                    logger.warning(
                        "paper newswatch: notif Telegram échouée pour %s (%s)",
                        symbol, type(exc).__name__)
                    ok = False
                if ok:
                    counters["notified"] += 1
                    notified_for_symbol += 1
                    events.insert(0, {
                        "ts": now_dt.isoformat(),
                        "symbol": symbol,
                        "title": item["title"],
                        "link": link,
                        "sentiment": sentiment,
                    })
                else:
                    counters["errors"] += 1

            if is_first_pass:
                seeded[symbol] = True
                changed = True  # persiste le flag même si le flux était vide

        if changed:
            state["events"] = events[:_MAX_EVENTS]
            _purge_old_seen(state, now_dt)
            _save_seen(username, state)

    # ----------------------------------------------------------------- #
    # Convergence ÉVÉNEMENTIELLE — après les sauvegardes d'état, jamais
    # avant : la convergence RELIT ces fichiers, elle doit voir la matière du
    # cycle qui vient de se terminer.
    # ----------------------------------------------------------------- #
    counters["convergence_fired"] = _fire_convergence(
        now_dt, tg_cfg=tg_cfg, notifier=notifier, converge=converge,
        counters=counters)

    # ----------------------------------------------------------------- #
    # Volet transverse -- traduction des titres ALLEMANDS accumulés par la
    # presse mondiale (NZZ/cash.ch/Handelsblatt, cf. _run_pressefi_volet),
    # EN TOUT DERNIER : après la convergence, comme la doc de tête le dit.
    # ``gov_events`` (déjà en mémoire depuis le volet 1, jamais relu depuis le
    # disque) est la SEULE source de titres allemands -- la presse mondiale
    # écrit dans l'état politique GLOBAL, jamais dans un état par utilisateur.
    # N'affecte AUCUN volet ci-dessus : le sweep n'écrit que son propre cache
    # de traduction, jamais gov_state.
    # ----------------------------------------------------------------- #
    _run_translate_sweep(now_dt, gov_events, counters, translate=translate)

    return counters


def _run_translate_sweep(now_dt: datetime,
                         events: List[Dict[str, Any]],
                         counters: Optional[Dict[str, Any]] = None,
                         translate: Optional[Callable[..., Any]] = None
                         ) -> Dict[str, Any]:
    """Traduit les titres de presse allemande accumulés dans ``events`` --
    best-effort STRICT, même patron que ``_run_calendar_verdicts`` : un
    module de confort qui plante ne doit JAMAIS emporter le cycle de veille
    qui l'appelle.

    Ne touche à AUCUN état de veille : la sortie ne sert qu'à peupler le
    cache disque de traduction (``paper/translate.py``), relu par le SERVICE
    au moment de servir ``/graph``/``/graph/grove``/``/digest`` -- jamais
    ici. Une panne de ce volet ne fait donc perdre AUCUNE matière déjà
    collectée par les volets précédents.

    ⚠️ Le gating horaire (« pas plus d'un sweep par heure ») vit DANS le
    cache de traduction lui-même (``last_sweep_ts``), PAS dans un compteur de
    cycle ajouté à ``_load_seen_state`` -- ce serait retomber dans son piège
    allowlist documenté en tête de fichier (une clé de cadence oubliée à la
    relecture y est silencieusement perdue). C'est pourquoi cet appel est
    SANS CONDITION à chaque cycle : c'est ``run_sweep`` qui décide, seul, de
    ne rien faire.
    """
    try:
        if translate is not None:
            result = translate(now=now_dt, events=events)
        else:
            from backend.bots.paper import translate as translate_mod
            result = translate_mod.run_sweep(now=now_dt, events=events)
    except Exception as exc:      # noqa: BLE001 -- jamais fatal pour le cycle
        logger.warning("paper newswatch: traduction en panne (%s)",
                       type(exc).__name__)
        if counters is not None:
            counters["errors"] = int(counters.get("errors") or 0) + 1
        return {}
    return result if isinstance(result, dict) else {}


def _run_calendar_verdicts(now_dt: datetime,
                           counters: Optional[Dict[str, Any]] = None,
                           judge: Optional[Callable[..., Any]] = None) -> int:
    """Juge les rendez-vous arrivés à échéance — best-effort STRICT.

    Même patron que ``_fire_convergence``, et pour la même raison : le guetteur
    a déjà fait son travail quand on arrive ici, un calendrier en panne ne doit
    JAMAIS faire perdre un cycle de veille. L'échec est compté et logué, jamais
    propagé.

    Le module peut ne pas être déployé (déploiement partiel) : l'``ImportError``
    est traitée comme n'importe quelle panne — zéro verdict, cycle intact.

    Rend le NOMBRE de rendez-vous jugés à ce passage, pour que le compteur du
    cycle le dise. Un zéro est le cas NORMAL : la plupart des jours, aucun
    rendez-vous n'arrive à échéance.

    ⚠️ ``run_verdicts`` rend un DICT ``{"checked", "judged"}``, pas une liste.
    Un ``len()`` posé dessus sans y penser compterait ses DEUX clés et
    annoncerait « 2 verdicts » à chaque cycle, y compris quand rien n'a été
    jugé — un compteur qui ment est pire que pas de compteur (mesuré : c'est
    exactement ce qu'a rendu le premier lancement).
    """
    try:
        if judge is not None:
            result = judge(now=now_dt)
        else:
            from backend.bots.paper import calendar as calendar_mod
            result = calendar_mod.run_verdicts(now=now_dt)
    except Exception as exc:      # noqa: BLE001 — jamais fatal pour le cycle
        logger.warning("paper newswatch: verdicts du calendrier en panne (%s)",
                       type(exc).__name__)
        if counters is not None:
            counters["errors"] = int(counters.get("errors") or 0) + 1
        return 0
    if isinstance(result, dict):
        try:
            return len(result.get("judged") or [])
        except TypeError:
            return 0
    try:
        return len(result or [])  # tolérance : une doublure de test peut rendre une liste
    except TypeError:
        return 0


def _fire_convergence(now_dt: datetime,
                      tg_cfg: Optional[Dict[str, Any]] = None,
                      notifier: Optional[Callable[..., Any]] = None,
                      converge: Optional[Callable[..., Any]] = None,
                      counters: Optional[Dict[str, Any]] = None) -> bool:
    """Consulte la couche de convergence — best-effort STRICT (même patron que
    ``radar._fire_convergence``).

    Le guetteur a déjà fait son travail et sauvé son état quand on arrive ici :
    une convergence en panne ne doit JAMAIS faire perdre un cycle de veille.
    L'échec est compté et logué, jamais propagé.

    Économie : ``convergence.should_fire`` exige ≥ 2 facteurs, un cooldown de
    6 h et une empreinte différente de la dernière — tant que ces gardes
    refusent, l'appel ne fait QUE de la lecture de fichiers locaux, sans
    toucher au modèle ni au réseau. C'est ce qui rend l'évaluation à chaque
    cycle de 5 minutes gratuite.
    """
    try:
        if converge is not None:
            result = converge(now=now_dt, notifier=notifier, tg_cfg=tg_cfg)
        else:
            from backend.bots.paper import convergence
            result = convergence.maybe_fire(now=now_dt, notifier=notifier,
                                            tg_cfg=tg_cfg)
    except Exception as exc:      # noqa: BLE001 — module absent ou bug interne
        logger.warning("paper newswatch: convergence indisponible (%s)",
                       type(exc).__name__)
        if counters is not None:
            counters["errors"] += 1
        return False
    result = result if isinstance(result, dict) else {}
    if counters is not None and result.get("sent"):
        counters["notified"] += 1
    return bool(result.get("fired"))
