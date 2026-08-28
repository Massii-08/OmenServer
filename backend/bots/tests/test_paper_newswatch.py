"""Tests de la veille news des positions + veille politique globale (Lot E,
extension §13) -- 100% offline.

fetch/notifier/tg_cfg/sleep sont TOUJOURS injectés : aucun réseau, aucune
horloge réelle. Isolation disque : DATA_DIR est monkeypatché vers tmp_path
pour CHAQUE test (même fixture autouse que test_paper_store.py) -- on
n'écrit jamais dans le vrai data/paper_trading/ du dépôt.

⚠️ Depuis l'extension §13, run_once() interroge TOUJOURS le volet politique
GLOBAL (2 sources) en tête de chaque cycle, même sans portefeuille. Pour ne
pas polluer les ~25 tests "par symbole" préexistants avec deux réponses gov à
empiler à chaque appel, le helper `_run()` PRIME automatiquement 2 réponses
gov VIDES en tête de la file de fetch (`_FetchQueue.prime_gov()`) avant
chaque appel à run_once -- désactivable via `prime_gov=False` pour les tests
qui pilotent le volet gov eux-mêmes.
"""
import json
import sys
import types
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime
from urllib.parse import unquote

import pytest

from backend.bots.paper import alerts, newswatch, store

# Capturée AVANT toute fixture : ``_no_side_channels`` remplace la vraie
# fonction pour éteindre le volet X par défaut, et les tests de la CONFIG des
# comptes ont justement besoin de la vraie.
_REAL_LOAD_X_ACCOUNTS = newswatch.load_x_accounts
# Idem pour le volet Reddit : la fixture l'éteint en rendant une URL vide, et
# le test qui vérifie le FORMAT de l'URL a besoin de la vraie fonction.
_REAL_REDDIT_URL = newswatch._reddit_url
# Idem pour les deux volets W2a que la fixture éteint : capturés AVANT elle.
_REAL_PRESSEFI_FEEDS = newswatch.pressefi_feeds
_REAL_BSKY_URLS = newswatch._bsky_urls
# Les URL de presse mondiale, figées une fois : ``_FetchQueue`` s'en sert pour
# router ces flux vers leur propre file (patron des volets crypto/éco/climat).
_PRESSEFI_URLS = frozenset(
    str(feed.get("url") or "") for feed in _REAL_PRESSEFI_FEEDS())


@pytest.fixture(autouse=True)
def _isolate_data_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "DATA_DIR", tmp_path)
    yield


@pytest.fixture(autouse=True)
def _no_side_channels(monkeypatch):
    """SEPT portes de sortie s'ouvriraient sinon PAR DÉFAUT dans cette suite
    (le compte était resté à « CINQ » depuis l'ajout des verdicts du
    calendrier — mis à jour en même temps que l'ajout de la sauvegarde) :

    * le **volet X** — sans configuration, ``load_x_accounts`` rend les comptes
      livrés par défaut et le volet irait vraiment chercher x.com ;
    * le **volet Reddit** — il ne dépend d'AUCUNE configuration (les subs sont
      en dur) : sans neutralisation, chaque cycle de test partirait sur
      reddit.com. On coupe par l'URL, seul point de passage du volet ;
    * le **volet Bluesky** (W2a) — même cas exactement : deux requêtes fixes en
      dur, aucune configuration, donc chaque cycle partirait sur bsky.app. On
      coupe par ``_bsky_urls``, son seul point de passage ;
    * le **volet presse mondiale** (W2a) — celui-là passe bien par le ``fetch``
      injecté (aucun risque de réseau), mais il demande SEIZE sources à chaque
      passage dû : laissé branché, il ajouterait seize appels au compteur de la
      soixantaine de tests écrits avant lui, dont aucun comportement n'a changé.
      On coupe par sa liste de flux ;
    * la **convergence** — appelée à la fin de chaque cycle, elle appellerait
      le VRAI CLI Claude le jour où deux facteurs s'alignent dans une fixture ;
    * les **verdicts du calendrier** (27/08) — un cycle sur trois juge les
      rendez-vous échus, et pour les juger il DEMANDE UNE COTATION par titre.
      C'est une porte réseau, et elle s'est ouverte toute seule : le premier
      lancement après le branchement a rendu ``verdicts: 2`` dans un test qui
      se croyait hors ligne (des fixtures d'hypothèses arrivées à échéance). On
      coupe donc au même endroit que les autres ;
    * la **sauvegarde nocturne** (G1, 27/08) — ``backup.maybe_run`` écrirait un
      VRAI ``tar.gz`` sur le disque à chaque test (``store.DATA_DIR`` vaut
      ``tmp_path`` ici, mais ``backup.default_dest_dir()`` en dérive un dossier
      FRÈRE, ``tmp_path.parent/backups/paper_trading`` — hors de l'isolation
      par test). Neutralisé par défaut ; les tests dédiés de ce garde-fou
      injectent leur propre ``backup_check``.
    * le **bilan hebdomadaire** (LOT 3, C2, 28/08) — ``weekly.maybe_run``
      appellerait le VRAI CLI Claude si le gate ``weekly_due`` tombe juste
      (peu probable avec ``NOW`` = un lundi, mais un test dédié pourrait tout
      à fait choisir un dimanche soir). Neutralisé par défaut ; les tests
      dédiés injectent leur propre ``weekly_check``.

    Et un HUITIÈME garde-fou, celui-là contre un piège mesuré : un compte X dont
    la page ne rend AUCUN post compte une « anomalie », et deux anomalies de
    suite escaladent vers le NAVIGATEUR FURTIF du Harvester. Un test qui rend
    deux fois une liste de posts vide déclenchait donc le vrai
    ``_fetch_x_stealth`` — mesuré à 34 secondes sur une machine sans patchright,
    et une tentative de démarrer un Chrome sur une machine qui en a un. On le
    remplace par un échec IMMÉDIAT, qui est exactement ce que fait le vrai étage
    quand patchright manque. Un test qui vise l'escalade injecte le sien.

    Les sept premiers sont neutralisés ici, et les tests qui les visent
    réinstallent leur propre doublure. Un test de veille ne doit jamais
    dépendre du réseau ni écrire hors de son ``tmp_path``.

    ⚠️ Le volet **banques centrales**, lui, N'EST PAS neutralisé : c'est un volet
    RSS ordinaire servi par le même moteur qu'``eco``/``climat`` et par le même
    ``fetch`` injecté. Ses trois sources sont routées par ``_FetchQueue`` vers un
    flux vide, et elles COMPTENT dans les compteurs — c'est la vérité du cycle,
    et la cacher rendrait la suite moins fidèle qu'elle ne l'est.
    """
    monkeypatch.setattr(newswatch, "load_x_accounts", lambda: [])
    monkeypatch.setattr(newswatch, "_reddit_url", lambda subs=None: "")
    monkeypatch.setattr(newswatch, "_bsky_urls", lambda queries: [])
    monkeypatch.setattr(newswatch, "pressefi_feeds", lambda: [])
    monkeypatch.setattr(newswatch, "_fetch_x_stealth", _no_stealth)
    from backend.bots.paper import convergence
    monkeypatch.setattr(convergence, "maybe_fire",
                        lambda **kwargs: {"fired": False, "sent": False})
    from backend.bots.paper import calendar as calendar_mod
    monkeypatch.setattr(calendar_mod, "run_verdicts", lambda **kwargs: [])
    from backend.bots.paper import backup as backup_mod
    monkeypatch.setattr(backup_mod, "maybe_run", lambda **kwargs: {"ran": False})
    from backend.bots.paper import weekly as weekly_mod
    monkeypatch.setattr(weekly_mod, "maybe_run",
                        lambda **kwargs: {"ran": False, "n_accounts": 0, "sent": 0})


def _no_stealth(handle):
    """L'étage furtif, INDISPONIBLE — ce que fait le vrai sur une machine sans
    patchright, mais tout de suite (cf. ``_no_side_channels``)."""
    raise RuntimeError("navigateur furtif indisponible en test")


NOW = datetime(2026, 8, 24, 12, 0, 0, tzinfo=timezone.utc)
CFG = {"token": "t", "chat_id": "c"}


def _portfolio(symbols):
    return {
        "cash_chf": 5000.0,
        "positions": [
            {"symbol": s, "qty": 1, "avg_price": 10.0, "currency": "CHF",
             "opened_at": NOW.isoformat(), "side": "long"}
            for s in symbols
        ],
        "open_orders": [], "trades": [], "fee_profile": "yuh",
        "initial_capital": 10000.0, "created_at": NOW.isoformat(),
    }


_RSS_ITEM = ('<item><title><![CDATA[{title}]]></title>'
            '<link>{link}</link><pubDate>{pubdate}</pubDate></item>')

_RSS_ENVELOPE = ('<?xml version="1.0" encoding="UTF-8"?>'
                 '<rss version="2.0"><channel><title>Feed</title>'
                 '{items}</channel></rss>')


def _rss(entries):
    """entries : liste de (title, link, pubdate_dt) -> texte RSS minimal,
    fidèle à la forme sondée sur feeds.finance.yahoo.com / Google News /
    trumpstruth.org (CDATA + pubDate RFC822 -- format_datetime est le
    complément exact de parsedate_to_datetime utilisé par
    newswatch._parse_pub_ts)."""
    items_xml = "".join(
        _RSS_ITEM.format(title=title, link=link, pubdate=format_datetime(dt))
        for title, link, dt in entries
    )
    return _RSS_ENVELOPE.format(items=items_xml)


_EMPTY_RSS = _RSS_ENVELOPE.format(items="")


class _FetchQueue:
    """Fetch injectable : une file de réponses (texte RSS ou exception) par
    appel, consommée dans l'ordre -- pour scripter des runs successifs sans
    dépendre du réseau. Si run_once appelle fetch plus de fois que prévu,
    pop() lève IndexError -- filet de sécurité utile (bug de boucle)."""
    def __init__(self):
        self.calls = []
        self._answers = []
        self._crypto = []
        self._eco = []
        self._climat = []
        self._bc = []
        self._pressefi = []

    def push(self, xml_or_exc):
        self._answers.append(xml_or_exc)

    def push_crypto(self, xml_or_exc):
        """Réponse du volet CRYPTO (26/08), déclarée À PART.

        Les URL crypto sont servies depuis leur propre file et, si le test n'en
        a déclaré aucune, par un flux VIDE — sans jamais consommer la file
        principale. Sans cette séparation, l'ajout d'un volet global décalerait
        l'arithmétique de la vingtaine de tests « par symbole » écrits avant
        lui, alors qu'aucun de leurs comportements n'a changé.
        """
        self._crypto.append(xml_or_exc)

    def push_eco(self, xml_or_exc):
        """Réponse du volet ÉCO (26/08 soir) — même séparation que crypto."""
        self._eco.append(xml_or_exc)

    def push_climat(self, xml_or_exc):
        """Réponse du volet CLIMAT (26/08 soir) — même séparation que crypto."""
        self._climat.append(xml_or_exc)

    def push_bc(self, xml_or_exc):
        """Réponse du volet BANQUES CENTRALES (W2a) — même séparation.

        La fiche porte TROIS sources (Fed, BCE, BNS) : une réponse poussée ici
        sert la PREMIÈRE qui appelle, les deux suivantes reçoivent un flux vide.
        C'est ce qui permet d'écrire un test de communiqué sans avoir à empiler
        deux silences derrière lui.
        """
        self._bc.append(xml_or_exc)

    def push_pressefi(self, xml_or_exc):
        """Réponse d'un flux de PRESSE MONDIALE (W2a).

        Le volet est éteint par la fixture autouse ; un test qui le rallume
        (``pressefi_feeds`` réinstallée) fait passer ses flux par ici.
        """
        self._pressefi.append(xml_or_exc)

    def prime_gov(self, xml_or_exc=None):
        """Insère 2 réponses gov (une par source, run_once en interroge
        exactement 2 en tête de cycle) EN TÊTE de la file -- quel que soit ce
        que le test a déjà empilé pour les symboles/portefeuilles, qui eux
        sont consommés APRÈS le volet gov."""
        answer = xml_or_exc if xml_or_exc is not None else _EMPTY_RSS
        self._answers[0:0] = [answer, answer]

    def __call__(self, url):
        self.calls.append(url)
        if url in newswatch._CRYPTO_SOURCES:
            ans = self._crypto.pop(0) if self._crypto else _EMPTY_RSS
        elif url in newswatch._ECO_SOURCES:
            ans = self._eco.pop(0) if self._eco else _EMPTY_RSS
        elif url in newswatch._CLIMAT_SOURCES:
            ans = self._climat.pop(0) if self._climat else _EMPTY_RSS
        elif url in newswatch._BC_SOURCES:
            ans = self._bc.pop(0) if self._bc else _EMPTY_RSS
        elif url in _PRESSEFI_URLS:
            ans = self._pressefi.pop(0) if self._pressefi else _EMPTY_RSS
        else:
            ans = self._answers.pop(0)
        if isinstance(ans, Exception):
            raise ans
        return ans


class _NotifySpy:
    def __init__(self, ok=True):
        self.calls = []
        self.ok = ok

    def __call__(self, text, cfg):
        self.calls.append((text, cfg))
        return self.ok


def _run(fetch, notifier, now=NOW, tg_cfg=CFG, prime_gov=True, mode="tout", **kw):
    """⚠️ ``mode="tout"`` par DÉFAUT ici : la très grande majorité de cette
    suite décrit le comportement BAVARD (qui envoie message par message), et
    c'est bien celui-là qu'on veut continuer d'épingler. Le mode « calme »,
    qui est le défaut de PRODUCTION depuis le 26/08, a ses tests dédiés."""
    if prime_gov:
        fetch.prime_gov()
    return newswatch.run_once(now=now, fetch=fetch, notifier=notifier,
                              tg_cfg=tg_cfg, sleep=lambda s: None, mode=mode,
                              **kw)


# =========================================================================== #
#  PUR -- parse_rss
# =========================================================================== #

def test_parse_rss_extracts_title_link_pubdate():
    xml = _rss([
        ("Nestlé beats estimates", "https://finance.yahoo.com/a", NOW),
        ("Second headline", "https://finance.yahoo.com/b", NOW - timedelta(hours=1)),
    ])
    items = newswatch.parse_rss(xml)
    assert len(items) == 2
    assert items[0] == {
        "title": "Nestlé beats estimates",
        "link": "https://finance.yahoo.com/a",
        "pub_ts": int(NOW.timestamp()),
    }
    assert items[1]["pub_ts"] == int((NOW - timedelta(hours=1)).timestamp())


def test_parse_rss_drops_item_without_link():
    xml = ('<?xml version="1.0"?><rss version="2.0"><channel>'
          '<item><title>No link here</title><pubDate>{0}</pubDate></item>'
          '</channel></rss>').format(format_datetime(NOW))
    assert newswatch.parse_rss(xml) == []


def test_parse_rss_drops_item_without_title():
    xml = ('<?xml version="1.0"?><rss version="2.0"><channel>'
          '<item><link>https://x.test/a</link><pubDate>{0}</pubDate></item>'
          '</channel></rss>').format(format_datetime(NOW))
    assert newswatch.parse_rss(xml) == []


def test_parse_rss_invalid_xml_returns_empty_list():
    assert newswatch.parse_rss("<not><valid") == []


def test_parse_rss_empty_string_returns_empty_list():
    assert newswatch.parse_rss("") == []


def test_parse_rss_missing_pubdate_defaults_to_zero():
    xml = ('<?xml version="1.0"?><rss version="2.0"><channel>'
          '<item><title>No date</title><link>https://x.test/a</link></item>'
          '</channel></rss>')
    items = newswatch.parse_rss(xml)
    assert items == [{"title": "No date", "link": "https://x.test/a", "pub_ts": 0}]


# =========================================================================== #
#  PUR -- classify (par symbole)
# =========================================================================== #

def test_classify_pos_en():
    assert newswatch.classify("Apple beats estimates and raises guidance") == "pos"


def test_classify_neg_fr():
    assert newswatch.classify(
        "Le groupe annonce un avertissement sur résultats et abaisse ses prévisions"
    ) == "neg"


def test_classify_neg_overrides_pos_when_both_match():
    assert newswatch.classify(
        "Group raises guidance then issues profit warning days later"
    ) == "neg"


def test_classify_advice_returns_none_regardless_of_other_keywords():
    assert newswatch.classify("3 top stocks to buy now for 2026") is None


def test_classify_neutral_returns_none():
    assert newswatch.classify("Company opens new headquarters in Zurich") is None


def test_classify_empty_title_returns_none():
    assert newswatch.classify("") is None


def test_classify_single_word_keyword_respects_word_boundary():
    # "fusion" ne doit pas matcher à l'intérieur de "confusion" (piège \b).
    assert newswatch.classify("Investors voice confusion over new policy") is None


# --- extension "watch" (catalyseur à venir, 2026-08-24) --------------------- #

def test_classify_watch_en():
    assert newswatch.classify("Tesla set to announce Q3 deliveries next week") == "watch"


def test_classify_watch_fr():
    assert newswatch.classify("Nestlé publiera ses résultats la semaine prochaine") == "watch"


def test_classify_neg_overrides_watch():
    assert newswatch.classify(
        "Company set to announce a profit warning ahead of Q2 results"
    ) == "neg"


def test_classify_pos_overrides_watch():
    assert newswatch.classify(
        "Firm raises guidance ahead of its investor day"
    ) == "pos"


def test_classify_advice_beats_catalyst_keywords():
    assert newswatch.classify("Top stocks to buy now ahead of earnings season") is None


# --- PUR : is_advice / cap_neutral (titres neutres, 2026-08-26) ------------- #

def test_is_advice_separates_the_two_silences_of_classify():
    """``classify`` rend ``None`` dans deux cas très différents : un conseil (à
    ne JAMAIS relayer) et un titre neutre (matière factuelle légitime)."""
    assert newswatch.is_advice("3 top stocks to buy now for 2026") is True
    assert newswatch.is_advice("Company opens new headquarters in Zurich") is False
    assert newswatch.is_advice("") is False


def _neutral(symbol, n):
    return {"ts": "t%d" % n, "symbol": symbol, "title": "neutre %d" % n,
            "link": "l%d" % n, "sentiment": "neutral", "muted": True}


def test_cap_neutral_keeps_the_four_most_recent_of_that_symbol():
    events = [_neutral("AAA", n) for n in range(6)]      # 0 = le plus récent
    newswatch.cap_neutral(events, "AAA")
    assert [e["title"] for e in events] == ["neutre %d" % n for n in range(4)]


def test_cap_neutral_touches_neither_other_symbols_nor_tonal_events():
    tonal = {"ts": "t", "symbol": "AAA", "title": "warning", "link": "l",
             "sentiment": "neg"}
    events = ([_neutral("AAA", n) for n in range(3)] + [tonal]
              + [_neutral("BBB", n) for n in range(9, 15)]
              + [_neutral("AAA", 3), _neutral("AAA", 4)])
    newswatch.cap_neutral(events, "AAA")
    assert tonal in events
    assert sum(1 for e in events if e["symbol"] == "BBB") == 6   # intact
    assert [e["title"] for e in events if e["symbol"] == "AAA"
            and e["sentiment"] == "neutral"] == ["neutre %d" % n for n in range(4)]


def test_cap_neutral_survives_a_deformed_history():
    events = ["pas un dict", None, _neutral("AAA", 0)]
    newswatch.cap_neutral(events, "AAA")
    assert events == ["pas un dict", None, _neutral("AAA", 0)]


# =========================================================================== #
#  PUR -- format_message
# =========================================================================== #

def test_format_message_pos_wording():
    msg = newswatch.format_message("NESN.SW", "Nestlé beats estimates", "https://y/a", "pos")
    assert msg == "[Simulateur] Bonne nouvelle potentielle — NESN.SW\n« Nestlé beats estimates »\nhttps://y/a"


def test_format_message_neg_wording():
    msg = newswatch.format_message("NESN.SW", "Nestlé profit warning", "https://y/a", "neg")
    assert msg == "[Simulateur] Mauvaise nouvelle potentielle — NESN.SW\n« Nestlé profit warning »\nhttps://y/a"


def test_format_message_watch_wording_never_says_buy():
    msg = newswatch.format_message("TSLA", "Tesla set to announce Q3 deliveries", "https://y/b", "watch")
    assert msg == (
        "[Simulateur] Catalyseur à venir — TSLA\n"
        "« Tesla set to announce Q3 deliveries »\n"
        "Mouvement possible : si tu veux le jouer, pose ta thèse dans le "
        "simulateur maintenant (argent fictif).\n"
        "https://y/b"
    )
    lowered = msg.lower()
    assert "achète" not in lowered and "achete" not in lowered
    assert "investis" not in lowered


# =========================================================================== #
#  PUR -- classify_gov / format_gov_message (volet politique global, §13)
# =========================================================================== #

def test_classify_gov_tariff_is_true():
    assert newswatch.classify_gov("Trump announces 50% tariff on steel imports") is True


def test_classify_gov_electoral_poll_is_false():
    assert newswatch.classify_gov("Fake Polls, Fake News, total disaster say pundits") is False


def test_classify_gov_purely_polemical_post_is_false():
    assert newswatch.classify_gov("Witch Hunt continues, Radical Left is out of control!") is False


def test_classify_gov_executive_order_is_true():
    assert newswatch.classify_gov("President signs new executive order on AI") is True


def test_classify_gov_sanctions_is_true():
    assert newswatch.classify_gov("White House announces new sanctions on shipping firms") is True


def test_classify_gov_nationaliz_stem_matches_inflections():
    # "nationaliz" est un radical délibéré -- doit matcher les inflexions
    # anglaises courantes sans qu'on les liste une par une.
    assert newswatch.classify_gov("Government moves to nationalize the steel plant") is True
    assert newswatch.classify_gov("Officials discuss nationalization of key assets") is True


def test_classify_gov_empty_title_is_false():
    assert newswatch.classify_gov("") is False


def test_format_gov_message_wording():
    msg = newswatch.format_gov_message("Trump announces 50% tariff on steel", "https://n/1")
    assert msg == (
        "[Simulateur] Annonce politique — mouvement de marché possible\n"
        "« Trump announces 50% tariff on steel »\n"
        "https://n/1\n"
        "Si un secteur te semble touché : simulateur, thèse, petit sizing."
    )


# =========================================================================== #
#  PUR -- story_key (anti-spam par histoire, incident du 24/08 soir)
#
#  Calibration OBLIGATOIRE sur 2 paires réelles (cf. mission) :
#   - Iran/sanctions : même histoire racontée sous 2 angles très différents
#     -> MÊME clé attendue. La règle primaire du design (6 tokens les plus
#     longs) NE convergeait PAS naturellement dessus (des mots longs mais non
#     partagés comme "economic"/"unveils"/"partners" battent "Iran"/"US" à la
#     sélection par longueur) -> repli documenté à 4 tokens (cf.
#     _STORY_KEY_TOKENS dans newswatch.py), qui lui converge.
#   - Tarifs Canada : 2 dépêches sur le MÊME sujet (tarifs autos canadiens)
#     mais formulées trop différemment pour partager assez de vocabulaire ->
#     divergence ACCEPTÉE (le but est de compresser 15 reprises en 1-3 clés,
#     pas la perfection -- cf. mission).
# =========================================================================== #

def test_story_key_converges_on_same_underlying_story():
    a = 'U.S. unveils new Iran sanctions after Trump threatened "economic D-Day"'
    b = 'A look at the new U.S. sanctions on Iran and threats against its trading partners'
    assert newswatch.story_key(a) == newswatch.story_key(b)
    assert newswatch.story_key(a) != ""


def test_story_key_diverges_on_differently_worded_tariff_stories():
    c = "Trump vows to double Canadian auto tariffs, escalating fight"
    d = "Retaliatory tariffs expected Tuesday as Trump threatens 50% duties on Canadian autos"
    assert newswatch.story_key(c) != newswatch.story_key(d)


def test_story_key_strips_google_news_source_suffix():
    base = "Trump announces new sanctions on Iranian oil exports"
    assert newswatch.story_key(base) == newswatch.story_key(base + " - CNN")
    assert newswatch.story_key(base) == newswatch.story_key(base + " - Reuters")


def test_story_key_is_stable_across_calls():
    t = "White House announces new tariffs on steel imports"
    assert newswatch.story_key(t) == newswatch.story_key(t)


def test_story_key_case_and_punctuation_insensitive():
    x = "TRUMP ANNOUNCES NEW TARIFF ON STEEL IMPORTS!!"
    y = "Trump, announces: new tariff... on steel imports?"
    assert newswatch.story_key(x) == newswatch.story_key(y)


def test_story_key_empty_title_returns_empty_string():
    assert newswatch.story_key("") == ""


# --- l'étage COMMUN, emprunté par graph.theme_clusters ---------------------- #
#
# ``story_tokens``/``story_stem`` ont été SORTIS de ``story_key`` le 26/08 pour
# que le regroupement thématique du graphe reparte du même découpage. Ces tests
# pinnent le contrat de l'étage extrait ; les six ci-dessus, inchangés, prouvent
# que l'extraction n'a pas bougé ``story_key`` d'un pouce.

def test_story_tokens_keeps_the_surface_form_in_reading_order():
    """Formes de SURFACE, non tronquées, dans l'ordre du titre : c'est le seul
    étage qui sait encore que le titre dit « tariffs » et pas « tariff »."""
    assert newswatch.story_tokens(
        "White House confirms Canada tariff exemption for autos - Bloomberg") == \
        ["white", "house", "confirms", "canada", "tariff", "exemption", "autos"]


def test_story_tokens_drops_stopwords_reporting_verbs_and_short_noise():
    """« new »/« on » (stopwords), « announces » (verbe de dépêche) et
    « trump » (omniprésent dans CE flux) ne disent rien d'une histoire ; « US »,
    lui, est un code entité — il reste malgré ses deux lettres."""
    assert newswatch.story_tokens("Trump announces new US tariffs on steel") == \
        ["us", "tariffs", "steel"]


def test_story_tokens_empty_title_is_an_empty_list():
    assert newswatch.story_tokens("") == []
    assert newswatch.story_tokens(None) == []


def test_story_stem_unifies_the_variants_of_a_word():
    assert newswatch.story_stem("tariffs") == newswatch.story_stem("tariff")
    assert newswatch.story_stem("threatened") == newswatch.story_stem("threats")
    assert newswatch.story_stem("") == ""


def test_story_key_is_exactly_story_tokens_stemmed_deduped_sorted_and_cut():
    """La clé n'est plus qu'un ARRANGEMENT de l'étage commun — si les deux
    divergeaient, un thème serait nommé sur d'autres mots que ceux qui l'ont
    formé, ce qui se lirait comme un bug de la mémoire."""
    title = "Trump doubles steel tariffs on Canada and Mexico - Financial Times"
    stems = [newswatch.story_stem(w) for w in newswatch.story_tokens(title)]
    expected = "-".join(sorted(dict.fromkeys(stems))[:4])
    assert newswatch.story_key(title) == expected


# =========================================================================== #
#  I/O -- run_once, volet "par utilisateur"
# =========================================================================== #

def test_run_once_no_config_does_nothing():
    store.save_portfolio("alice", _portfolio(["NESN.SW"]))
    fetch = _FetchQueue()
    notifier = _NotifySpy()
    counters = newswatch.run_once(now=NOW, fetch=fetch, notifier=notifier,
                                  tg_cfg={}, sleep=lambda s: None, mode="tout")
    assert counters == {"users": 0, "symbols": 0, "fetched": 0, "notified": 0,
                        "errors": 0, "convergence_fired": False,
                        "verdicts": 0}
    assert fetch.calls == []   # ni le volet gov ni le volet par symbole ne tournent
    assert notifier.calls == []


def test_le_canal_par_defaut_est_celui_du_paper_trading(monkeypatch):
    """Spec §13 : sans ``tg_cfg``, la config vient de ``paper/alerts`` (bot
    ORACLE, avec son repli interne), plus directement de celle du Harvester."""
    store.save_portfolio("alice", _portfolio(["NESN.SW"]))
    monkeypatch.setattr(alerts, "load_cfg", lambda path=None: None)
    fetch = _FetchQueue()
    counters = newswatch.run_once(now=NOW, fetch=fetch, sleep=lambda s: None,
                                  mode="tout")
    assert counters["fetched"] == 0 and fetch.calls == []   # éteint : zéro réseau


def test_le_notifieur_par_defaut_est_celui_du_paper_trading(monkeypatch):
    """Et les messages partent par ``alerts.send``, pas par celui du Harvester."""
    sent = []
    monkeypatch.setattr(alerts, "load_cfg", lambda path=None: CFG)
    monkeypatch.setattr(alerts, "send",
                        lambda text, cfg=None, client=None: sent.append((text, cfg)) or True)
    store.save_portfolio("hank", _portfolio(["TSLA"]))

    fetch = _FetchQueue()
    fetch.push(_rss([("Seed", "https://y/seed", NOW - timedelta(hours=10))]))
    fetch.prime_gov()
    newswatch.run_once(now=NOW, fetch=fetch, sleep=lambda s: None,
                       mode="tout")   # amorçage muet

    later = NOW + timedelta(minutes=10)
    fetch.push(_rss([
        ("Seed", "https://y/seed", NOW - timedelta(hours=10)),
        ("Tesla set to announce Q3 deliveries next week", "https://y/watch1", later),
    ]))
    fetch.prime_gov()
    counters = newswatch.run_once(now=later, fetch=fetch, sleep=lambda s: None,
                                  mode="tout")

    assert counters["notified"] == 1
    assert len(sent) == 1 and sent[0][1] == CFG
    assert "TSLA" in sent[0][0]


def test_run_once_no_config_missing_chat_id_does_nothing():
    store.save_portfolio("alice", _portfolio(["NESN.SW"]))
    fetch = _FetchQueue()
    counters = _run(fetch, _NotifySpy(), tg_cfg={"token": "t"})
    assert counters["fetched"] == 0
    assert fetch.calls == []


def test_run_once_first_pass_seeds_without_notifying():
    store.save_portfolio("alice", _portfolio(["NESN.SW"]))
    fetch = _FetchQueue()
    fetch.push(_rss([
        ("Old headline one", "https://y/old1", NOW - timedelta(hours=5)),
        ("Old headline two, profit warning", "https://y/old2", NOW - timedelta(hours=3)),
    ]))
    notifier = _NotifySpy()
    counters = _run(fetch, notifier)
    assert counters["users"] == 1
    assert counters["symbols"] == 1
    # 1 symbole + les volets globaux : 2 gov + 2 crypto + eco + climat + 3 bc.
    assert counters["fetched"] == 10
    assert counters["notified"] == 0
    assert counters["errors"] == 0
    assert notifier.calls == []
    assert newswatch.recent_events("alice") == []


def test_run_once_second_pass_notifies_new_neg_item():
    store.save_portfolio("alice", _portfolio(["NESN.SW"]))
    fetch = _FetchQueue()
    old_items = [
        ("Old headline one", "https://y/old1", NOW - timedelta(hours=5)),
        ("Old headline two", "https://y/old2", NOW - timedelta(hours=3)),
    ]
    fetch.push(_rss(old_items))
    notifier = _NotifySpy()
    _run(fetch, notifier)
    assert notifier.calls == []  # premier passage : rien

    later = NOW + timedelta(minutes=10)
    fetch.push(_rss(old_items + [
        ("Nestlé issues profit warning on weak sales", "https://y/new1", later - timedelta(minutes=5)),
    ]))
    counters = _run(fetch, notifier, now=later)
    assert counters["notified"] == 1
    assert counters["errors"] == 0
    assert len(notifier.calls) == 1
    text, cfg = notifier.calls[0]
    assert "NESN.SW" in text
    assert "Nestlé issues profit warning on weak sales" in text
    assert cfg == CFG

    events = newswatch.recent_events("alice")
    assert len(events) == 1
    assert events[0] == {
        "ts": events[0]["ts"],  # horodatage exact non re-vérifié ici
        "symbol": "NESN.SW",
        "title": "Nestlé issues profit warning on weak sales",
        "link": "https://y/new1",
        "sentiment": "neg",
    }


def test_run_once_does_not_renotify_already_seen_item():
    store.save_portfolio("alice", _portfolio(["NESN.SW"]))
    fetch = _FetchQueue()
    old_items = [("Old headline", "https://y/old1", NOW - timedelta(hours=5))]
    fetch.push(_rss(old_items))
    notifier = _NotifySpy()
    _run(fetch, notifier)

    later = NOW + timedelta(minutes=10)
    new_feed = old_items + [
        ("Nestlé profit warning strikes again", "https://y/new1", later - timedelta(minutes=5)),
    ]
    fetch.push(_rss(new_feed))
    _run(fetch, notifier, now=later)
    assert len(notifier.calls) == 1  # run 2 : 1 notif

    even_later = later + timedelta(minutes=10)
    fetch.push(_rss(new_feed))  # exactement le même flux, rien de neuf
    counters = _run(fetch, notifier, now=even_later)
    assert counters["notified"] == 0
    assert len(notifier.calls) == 1  # toujours 1 au total : pas de re-notif


def test_run_once_caps_notifications_per_symbol_shared_across_categories():
    store.save_portfolio("bob", _portfolio(["ABCN.SW"]))
    fetch = _FetchQueue()
    fetch.push(_rss([("Seed item", "https://y/seed", NOW - timedelta(hours=10))]))
    notifier = _NotifySpy()
    _run(fetch, notifier)

    later = NOW + timedelta(minutes=10)
    burst = [
        ("Company issues profit warning on weak demand", "https://y/n1", later),   # neg
        ("Regulator opens probe into pricing practices", "https://y/n2", later),   # neg
        ("Firm set to announce new product launch", "https://y/n3", later),        # watch
        ("Analysts await earnings date announcement", "https://y/n4", later),      # watch
        ("Group beats estimates and raises guidance", "https://y/n5", later),      # pos
    ]
    fetch.push(_rss(burst))
    counters = _run(fetch, notifier, now=later)
    assert counters["notified"] == 3   # cap partagé entre neg/pos/watch (5 candidats -> 3)
    assert len(notifier.calls) == 3

    # Les 5 items (notifiés ou non) sont marqués vus : un run identique
    # supplémentaire ne notifie plus rien -- y compris les 2 qui avaient
    # dépassé le cap.
    even_later = later + timedelta(minutes=10)
    fetch.push(_rss(burst))
    counters3 = _run(fetch, notifier, now=even_later)
    assert counters3["notified"] == 0
    assert len(notifier.calls) == 3


# --- titres NEUTRES : la branche presse de la toile (2026-08-26) ------------ #
#
# Mesure du 26/08 : la toile du compte réel affichait 0 événement de presse.
# Les titres neutres -- l'immense majorité d'un flux Yahoo -- étaient marqués
# vus puis jetés.

def _seeded(user="alice", symbols=("NESN.SW",)):
    """Un compte dont le premier passage (seed, silencieux) est déjà fait."""
    store.save_portfolio(user, _portfolio(list(symbols)))
    fetch = _FetchQueue()
    for _ in symbols:
        fetch.push(_rss([("Seed", "https://y/seed", NOW - timedelta(hours=10))]))
    _run(fetch, _NotifySpy())
    return fetch


NEUTRAL_TITLE = "Nestlé opens a new plant in Vevey"


def test_run_once_records_a_neutral_headline_without_ever_notifying():
    fetch = _seeded()
    later = NOW + timedelta(minutes=10)
    fetch.push(_rss([(NEUTRAL_TITLE, "https://y/n1", later)]))
    notifier = _NotifySpy()
    counters = _run(fetch, notifier, now=later)

    assert notifier.calls == [] and counters["notified"] == 0
    events = newswatch.recent_events("alice")
    assert len(events) == 1
    assert events[0]["title"] == NEUTRAL_TITLE
    assert events[0]["sentiment"] == newswatch.NEUTRAL_SENTIMENT
    assert events[0]["muted"] is True
    assert events[0]["symbol"] == "NESN.SW" and events[0]["link"] == "https://y/n1"


def test_a_neutral_headline_is_silent_in_the_talkative_mode_too():
    """« Aucun mode » n'est pas une figure de style : le mode bavard, celui qui
    envoie dépêche par dépêche, se tait lui aussi sur un titre neutre."""
    fetch = _seeded(user="bob")
    later = NOW + timedelta(minutes=10)
    fetch.push(_rss([(NEUTRAL_TITLE, "https://y/n1", later),
                     ("Nestlé issues profit warning", "https://y/neg", later)]))
    notifier = _NotifySpy()
    _run(fetch, notifier, now=later, mode="tout")

    assert len(notifier.calls) == 1                     # la « neg » SEULEMENT
    assert "profit warning" in notifier.calls[0][0]
    tones = sorted(e["sentiment"] for e in newswatch.recent_events("bob"))
    assert tones == ["neg", "neutral"]


def test_an_advice_headline_is_never_recorded_even_as_neutral():
    """``classify`` rend ``None`` pour un conseil comme pour un titre neutre —
    mais recopier un conseil dans la mémoire, c'est le relayer."""
    fetch = _seeded(user="carol")
    later = NOW + timedelta(minutes=10)
    fetch.push(_rss([("3 top stocks to buy now for 2026", "https://y/a1", later),
                     (NEUTRAL_TITLE, "https://y/n1", later)]))
    _run(fetch, _NotifySpy(), now=later)

    titles = [e["title"] for e in newswatch.recent_events("carol")]
    assert titles == [NEUTRAL_TITLE]


def test_neutral_headlines_are_capped_at_four_per_symbol_across_runs():
    """Le cap vit dans l'ÉTAT, pas dans le passage : six titres neutres étalés
    sur deux runs laissent quatre traces, les plus récentes."""
    fetch = _seeded(user="dave")
    later = NOW + timedelta(minutes=10)
    fetch.push(_rss([("Neutre %d de Nestlé" % i, "https://y/x%d" % i, later)
                     for i in range(3)]))
    _run(fetch, _NotifySpy(), now=later)

    even_later = later + timedelta(minutes=10)
    fetch.push(_rss([("Neutre %d de Nestlé" % i, "https://y/x%d" % i, even_later)
                     for i in range(3, 6)]))
    _run(fetch, _NotifySpy(), now=even_later)

    titles = [e["title"] for e in newswatch.recent_events("dave")]
    assert len(titles) == newswatch._MAX_NEUTRAL_PER_SYMBOL
    assert titles == ["Neutre 5 de Nestlé", "Neutre 4 de Nestlé",
                      "Neutre 3 de Nestlé", "Neutre 2 de Nestlé"]


def test_the_notify_cap_never_silences_the_neutral_trace():
    """Le cap de 3 envois par symbole ne concerne QUE les envois : trois
    dépêches à tonalité ne doivent pas rendre la branche presse muette."""
    fetch = _seeded(user="erin")
    later = NOW + timedelta(minutes=10)
    fetch.push(_rss([
        ("Nestlé issues profit warning", "https://y/1", later),
        ("Regulator opens probe into Nestlé pricing", "https://y/2", later),
        ("Nestlé beats estimates", "https://y/3", later),
        (NEUTRAL_TITLE, "https://y/4", later),
    ]))
    counters = _run(fetch, _NotifySpy(), now=later, mode="tout")

    assert counters["notified"] == 3
    assert newswatch.NEUTRAL_SENTIMENT in [
        e["sentiment"] for e in newswatch.recent_events("erin")]


def test_a_neutral_event_lights_no_convergence_factor():
    """Garde-fou inter-modules (piège #61) : ``newswatch`` produit la tonalité,
    ``convergence`` la lit. Les huit facteurs doivent rester ÉTEINTS — un titre
    neutre est de la matière d'affichage, jamais un déclencheur."""
    from backend.bots.paper import convergence

    events = [{"ts": NOW.isoformat(), "symbol": "NESN.SW",
               "title": "Neutre %d" % i, "link": "https://y/%d" % i,
               "sentiment": newswatch.NEUTRAL_SENTIMENT, "muted": True}
              for i in range(6)]
    out = convergence.collect_factors(NOW, [], events, [], ["NESN.SW"],
                                      held_symbols=["NESN.SW"])
    assert not any(out["factors"].values())
    assert out["items"] == []


def test_run_once_counts_fetch_error_and_continues_other_symbols():
    store.save_portfolio("carol", _portfolio(["AAA", "BBB"]))
    fetch = _FetchQueue()
    fetch.push(RuntimeError("boom"))
    fetch.push(_rss([("Some headline", "https://y/bbb1", NOW - timedelta(hours=1))]))
    notifier = _NotifySpy()
    counters = _run(fetch, notifier)
    assert counters["symbols"] == 2
    assert counters["errors"] == 1
    # BBB (1) + 9 globaux (2 gov, 2 crypto, eco, climat, 3 bc).
    assert counters["fetched"] == 10
    assert len(fetch.calls) == 11      # 9 globaux + AAA (échoue) + BBB


def test_run_once_recovers_from_corrupt_seen_file():
    store.save_portfolio("dave", _portfolio(["ZZZ"]))
    seen_path = store.portfolio_path("dave").parent / "dave.news_seen.json"
    seen_path.write_text("{not valid json", encoding="utf-8")

    fetch = _FetchQueue()
    fetch.push(_rss([("Some headline", "https://y/z1", NOW - timedelta(hours=1))]))
    notifier = _NotifySpy()
    counters = _run(fetch, notifier)
    # état corrompu -> reparti de zéro -> traité comme un premier passage
    # (seed, pas de notif) -- surtout, ça ne plante JAMAIS.
    assert counters["errors"] == 0
    assert counters["notified"] == 0
    assert notifier.calls == []
    # le fichier corrompu a été mis de côté, pas perdu.
    assert (seen_path.parent / "dave.news_seen.json.corrupt").is_file()


def test_run_once_ignores_items_older_than_48h():
    store.save_portfolio("erin", _portfolio(["OLD.SW"]))
    fetch = _FetchQueue()
    fetch.push(_rss([("Seed", "https://y/seed", NOW - timedelta(hours=200))]))
    notifier = _NotifySpy()
    _run(fetch, notifier)

    later = NOW + timedelta(hours=1)
    fetch.push(_rss([
        ("Seed", "https://y/seed", NOW - timedelta(hours=200)),
        ("Stale profit warning from way back", "https://y/stale", later - timedelta(hours=60)),
    ]))
    counters = _run(fetch, notifier, now=later)
    assert counters["notified"] == 0
    assert notifier.calls == []


def test_run_once_paces_between_multiple_fetches():
    store.save_portfolio("fiona", _portfolio(["SYM1", "SYM2"]))
    fetch = _FetchQueue()
    fetch.push(_rss([]))
    fetch.push(_rss([]))
    sleeps = []
    fetch.prime_gov()
    newswatch.run_once(now=NOW, fetch=fetch, notifier=_NotifySpy(),
                       tg_cfg=CFG, sleep=sleeps.append, mode="tout")
    # 11 fetches au total (2 gov + 2 crypto + eco + climat + 3 bc + SYM1 +
    # SYM2) -> pas de pause avant le 1er, une pause avant chacun des 10
    # suivants.
    assert sleeps == [1.1] * 10


def test_run_once_notifies_watch_with_expected_wording():
    store.save_portfolio("hank", _portfolio(["TSLA"]))
    fetch = _FetchQueue()
    fetch.push(_rss([("Seed", "https://y/seed", NOW - timedelta(hours=10))]))
    notifier = _NotifySpy()
    _run(fetch, notifier)

    later = NOW + timedelta(minutes=10)
    fetch.push(_rss([
        ("Seed", "https://y/seed", NOW - timedelta(hours=10)),
        ("Tesla set to announce Q3 deliveries next week", "https://y/watch1", later),
    ]))
    counters = _run(fetch, notifier, now=later)
    assert counters["notified"] == 1
    text, cfg = notifier.calls[0]
    assert text == (
        "[Simulateur] Catalyseur à venir — TSLA\n"
        "« Tesla set to announce Q3 deliveries next week »\n"
        "Mouvement possible : si tu veux le jouer, pose ta thèse dans le "
        "simulateur maintenant (argent fictif).\n"
        "https://y/watch1"
    )
    events = newswatch.recent_events("hank")
    assert events[0]["sentiment"] == "watch"


def test_run_once_notify_failure_counts_as_error_but_still_marks_seen():
    store.save_portfolio("ivan", _portfolio(["FAIL.SW"]))
    fetch = _FetchQueue()
    fetch.push(_rss([("Seed", "https://y/seed", NOW - timedelta(hours=10))]))
    failing_notifier = _NotifySpy(ok=False)
    _run(fetch, failing_notifier)

    later = NOW + timedelta(minutes=10)
    fetch.push(_rss([
        ("Seed", "https://y/seed", NOW - timedelta(hours=10)),
        ("Company issues profit warning", "https://y/n1", later),
    ]))
    counters = _run(fetch, failing_notifier, now=later)
    assert counters["notified"] == 0
    assert counters["errors"] == 1
    assert newswatch.recent_events("ivan") == []  # pas d'event pour une notif ratée

    # l'item reste marqué vu malgré l'échec (best-effort, pas de retry) :
    even_later = later + timedelta(minutes=10)
    fetch.push(_rss([
        ("Seed", "https://y/seed", NOW - timedelta(hours=10)),
        ("Company issues profit warning", "https://y/n1", later),
    ]))
    counters3 = _run(fetch, failing_notifier, now=even_later)
    assert counters3["notified"] == 0
    assert counters3["errors"] == 0  # plus rien à (re)notifier -> plus d'erreur


def test_run_once_multiple_users_do_not_collide():
    store.save_portfolio("alice", _portfolio(["NESN.SW"]))
    store.save_portfolio("bob", _portfolio(["ABCN.SW"]))
    fetch = _FetchQueue()
    fetch.push(_rss([("Alice seed", "https://y/a-seed", NOW - timedelta(hours=10))]))
    fetch.push(_rss([("Bob seed", "https://y/b-seed", NOW - timedelta(hours=10))]))
    notifier = _NotifySpy()
    counters = _run(fetch, notifier)
    assert counters["users"] == 2
    assert counters["symbols"] == 2
    assert newswatch.recent_events("alice") == []
    assert newswatch.recent_events("bob") == []


def test_run_once_ignores_portfolio_without_positions():
    store.save_portfolio("kevin", _portfolio([]))
    fetch = _FetchQueue()
    counters = _run(fetch, _NotifySpy())
    assert counters["users"] == 0
    # les volets GLOBAUX (gov, crypto, éco, climat, banques centrales)
    # tournent quand même -- seul le volet PAR SYMBOLE (les appels qu'il y
    # aurait eu avec une position) est absent.
    assert len(fetch.calls) == 9


def test_run_once_no_portfolios_still_runs_gov_watch():
    """Sans AUCUN portefeuille nulle part, run_once ne fait plus "rien" comme
    avant l'extension §13 : le volet politique global tourne quand même."""
    fetch = _FetchQueue()
    counters = _run(fetch, _NotifySpy())
    assert counters == {"users": 0, "symbols": 0, "fetched": 9, "notified": 0,
                        "errors": 0, "convergence_fired": False,
                        "verdicts": 0}


# =========================================================================== #
#  I/O -- run_once, volet "par utilisateur" étendu à la WATCHLIST (25/08) --
#  positions ∪ watchlist. Le volet gov (nombre d'infos générales) est
#  INCHANGÉ, ces tests ne portent que sur le volet par-symbole.
# =========================================================================== #

def _write_watchlist(username, symbols):
    """symbols : liste de strings -> persiste via store.save_watchlist(),
    l'API canonique du paquet paper/ (même chemin/contrat que le module qui
    écrit la VRAIE watchlist ; newswatch._load_watchlist_symbols lit via
    store.load_watchlist())."""
    store.save_watchlist(username, [{"symbol": s} for s in symbols])


def test_run_once_watchlist_only_user_with_zero_positions_still_fetches():
    store.save_portfolio("wendy", _portfolio([]))  # 0 position ouverte
    _write_watchlist("wendy", ["AAPL", "MSFT"])

    fetch = _FetchQueue()
    fetch.push(_rss([]))  # AAPL, seed
    fetch.push(_rss([]))  # MSFT, seed
    counters = _run(fetch, _NotifySpy())
    assert counters["users"] == 1
    assert counters["symbols"] == 2


def test_run_once_watchlist_dedups_against_position_case_insensitive():
    store.save_portfolio("xavier", _portfolio(["AAPL"]))
    _write_watchlist("xavier", ["aapl"])  # même symbole, casse différente

    fetch = _FetchQueue()
    fetch.push(_rss([]))  # UN SEUL fetch -- pas 2
    counters = _run(fetch, _NotifySpy())
    assert counters["users"] == 1
    assert counters["symbols"] == 1


def test_run_once_corrupt_watchlist_does_not_block_the_run():
    store.save_portfolio("yara", _portfolio(["TSLA"]))
    store.watchlist_path("yara").write_text("{not valid json", encoding="utf-8")

    fetch = _FetchQueue()
    fetch.push(_rss([("Some headline", "https://y/z1", NOW - timedelta(hours=1))]))
    counters = _run(fetch, _NotifySpy())
    assert counters["users"] == 1
    assert counters["symbols"] == 1  # la watchlist corrompue n'ajoute rien -- TSLA seul
    assert counters["errors"] == 0


def test_run_once_watchlist_with_unexpected_shape_is_ignored():
    store.save_portfolio("noemi", _portfolio(["NESN.SW"]))
    # "symbols" n'est pas une liste -- rien de tout ça ne doit planter le run.
    store.watchlist_path("noemi").write_text('{"symbols": "not-a-list"}', encoding="utf-8")

    fetch = _FetchQueue()
    fetch.push(_rss([]))
    counters = _run(fetch, _NotifySpy())
    assert counters["users"] == 1
    assert counters["symbols"] == 1
    assert counters["errors"] == 0


def test_discover_portfolios_glob_excludes_watchlist_files():
    store.save_portfolio("zack", _portfolio(["NESN.SW"]))
    _write_watchlist("zack", ["MSFT"])

    discovered = newswatch._discover_portfolios()
    # "zack.watchlist.json" ne doit JAMAIS apparaître comme un utilisateur à
    # part entière (ni via le glob, ni via une validation de nom accidentelle).
    assert [u for u, _p in discovered] == ["zack"]


# =========================================================================== #
#  I/O -- run_once, volet politique GLOBAL (§13)
# =========================================================================== #

def test_run_once_gov_first_pass_seeds_silently_even_without_portfolios():
    fetch = _FetchQueue()
    fetch.push(_rss([("Trump announces 50% tariff on steel", "https://n/1", NOW - timedelta(hours=1))]))
    fetch.push(_rss([]))  # trumpstruth vide
    notifier = _NotifySpy()
    counters = _run(fetch, notifier, prime_gov=False)
    assert counters["notified"] == 0
    assert counters["fetched"] == 9      # 2 gov + 2 crypto + eco + climat + 3 bc
    assert notifier.calls == []
    assert newswatch.recent_events("anyone") == []


def test_run_once_gov_second_pass_notifies_new_tariff_item():
    fetch = _FetchQueue()
    fetch.push(_rss([]))
    fetch.push(_rss([]))
    notifier = _NotifySpy()
    _run(fetch, notifier, prime_gov=False)  # seed

    later = NOW + timedelta(minutes=10)
    fetch.push(_rss([("Trump announces 50% tariff on imports", "https://n/tariff1", later)]))
    fetch.push(_rss([]))
    counters = _run(fetch, notifier, now=later, prime_gov=False)
    assert counters["notified"] == 1
    text, cfg = notifier.calls[0]
    assert text == (
        "[Simulateur] Annonce politique — mouvement de marché possible\n"
        "« Trump announces 50% tariff on imports »\n"
        "https://n/tariff1\n"
        "Si un secteur te semble touché : simulateur, thèse, petit sizing."
    )
    assert cfg == CFG

    # fusionné dans recent_events pour N'IMPORTE QUEL utilisateur -- même un
    # qui n'a jamais eu de portefeuille (le router n'a rien à changer).
    events = newswatch.recent_events("nobody_special")
    assert len(events) == 1
    assert events[0]["symbol"] == "GOV"
    assert events[0]["sentiment"] == "gov"
    assert events[0]["title"] == "Trump announces 50% tariff on imports"
    assert events[0]["link"] == "https://n/tariff1"


def test_run_once_gov_merges_with_user_events_sorted_by_ts_desc():
    # ⚠️ Le "ts" enregistré dans un event est l'HORLOGE DU RUN (now_dt), pas le
    # pubDate de l'item -- deux notifications émises dans le MÊME run_once
    # portent donc le même ts (tri stable -> ordre d'insertion, pas de vrai
    # test du tri). Il faut deux runs à des "now" distincts pour vérifier
    # sérieusement le tri par ts décroissant.
    store.save_portfolio("merge_user", _portfolio(["NESN.SW"]))
    fetch = _FetchQueue()
    fetch.push(_rss([]))
    fetch.push(_rss([]))
    fetch.push(_rss([("Seed", "https://y/seed", NOW - timedelta(hours=10))]))
    notifier = _NotifySpy()
    _run(fetch, notifier, prime_gov=False)  # seed les deux volets

    t1 = NOW + timedelta(minutes=5)
    fetch.push(_rss([]))  # gov reste vide à ce run
    fetch.push(_rss([]))
    fetch.push(_rss([
        ("Seed", "https://y/seed", NOW - timedelta(hours=10)),
        ("Nestlé profit warning on weak sales", "https://y/n1", t1),
    ]))
    _run(fetch, notifier, now=t1, prime_gov=False)

    t2 = t1 + timedelta(minutes=5)
    fetch.push(_rss([("Trump announces tariff on chips", "https://n/g1", t2)]))
    fetch.push(_rss([]))
    fetch.push(_rss([  # portefeuille inchangé, rien de neuf côté symbole
        ("Seed", "https://y/seed", NOW - timedelta(hours=10)),
        ("Nestlé profit warning on weak sales", "https://y/n1", t1),
    ]))
    _run(fetch, notifier, now=t2, prime_gov=False)

    events = newswatch.recent_events("merge_user")
    assert [e["symbol"] for e in events] == ["GOV", "NESN.SW"]
    assert events[0]["sentiment"] == "gov"
    assert events[1]["sentiment"] == "neg"


def test_run_once_gov_caps_at_three_per_run():
    fetch = _FetchQueue()
    fetch.push(_rss([]))
    fetch.push(_rss([]))
    notifier = _NotifySpy()
    _run(fetch, notifier, prime_gov=False)  # seed

    later = NOW + timedelta(minutes=10)
    burst = [
        ("Trump announces new tariff on autos", "https://n/g1", later),
        ("White House announces sanctions on shipping", "https://n/g2", later),
        ("Government announces bailout for airlines", "https://n/g3", later),
        ("New executive order on chips act funding", "https://n/g4", later),
    ]
    fetch.push(_rss(burst))
    fetch.push(_rss([]))
    counters = _run(fetch, notifier, now=later, prime_gov=False)
    assert counters["notified"] == 3
    assert len(notifier.calls) == 3


def test_run_once_gov_does_not_renotify_seen_item():
    fetch = _FetchQueue()
    fetch.push(_rss([]))
    fetch.push(_rss([]))
    notifier = _NotifySpy()
    _run(fetch, notifier, prime_gov=False)  # seed

    later = NOW + timedelta(minutes=10)
    tariff_item = ("Trump announces tariff on semiconductors", "https://n/g1", later)
    fetch.push(_rss([tariff_item]))
    fetch.push(_rss([]))
    _run(fetch, notifier, now=later, prime_gov=False)
    assert len(notifier.calls) == 1

    even_later = later + timedelta(minutes=10)
    fetch.push(_rss([tariff_item]))
    fetch.push(_rss([]))
    counters = _run(fetch, notifier, now=even_later, prime_gov=False)
    assert counters["notified"] == 0
    assert len(notifier.calls) == 1


def test_run_once_gov_ignores_electoral_titles():
    fetch = _FetchQueue()
    fetch.push(_rss([]))
    fetch.push(_rss([]))
    notifier = _NotifySpy()
    _run(fetch, notifier, prime_gov=False)  # seed

    later = NOW + timedelta(minutes=10)
    fetch.push(_rss([("Fake Polls rigged again says campaign", "https://n/poll1", later)]))
    fetch.push(_rss([]))
    counters = _run(fetch, notifier, now=later, prime_gov=False)
    assert counters["notified"] == 0
    assert notifier.calls == []


def test_run_once_gov_ignores_items_older_than_24h():
    fetch = _FetchQueue()
    fetch.push(_rss([]))
    fetch.push(_rss([]))
    notifier = _NotifySpy()
    _run(fetch, notifier, prime_gov=False)  # seed

    later = NOW + timedelta(hours=1)
    fetch.push(_rss([("Trump announces old tariff news", "https://n/stale", later - timedelta(hours=30))]))
    fetch.push(_rss([]))
    counters = _run(fetch, notifier, now=later, prime_gov=False)
    assert counters["notified"] == 0
    assert notifier.calls == []


def test_run_once_gov_fetch_error_counts_and_does_not_block_second_source():
    fetch = _FetchQueue()
    fetch.push(RuntimeError("boom"))
    fetch.push(_rss([]))
    counters = _run(fetch, _NotifySpy(), prime_gov=False)
    assert counters["errors"] == 1
    # 1 gov qui répond + 2 crypto + eco + climat + 3 bc.
    assert counters["fetched"] == 8
    assert len(fetch.calls) == 9


def test_run_once_gov_runs_even_with_zero_portfolios():
    fetch = _FetchQueue()
    fetch.push(_rss([]))
    fetch.push(_rss([]))
    counters = _run(fetch, _NotifySpy(), prime_gov=False)
    assert counters["users"] == 0
    assert counters["fetched"] == 9      # 2 gov + 2 crypto + eco + climat + 3 bc
    assert len(fetch.calls) == 9


def test_run_once_gov_recovers_from_corrupt_global_seen_file():
    global_path = store.DATA_DIR / "newswatch_global.json"
    global_path.parent.mkdir(parents=True, exist_ok=True)
    global_path.write_text("{not valid json", encoding="utf-8")

    fetch = _FetchQueue()
    fetch.push(_rss([("Trump announces tariff", "https://n/1", NOW - timedelta(hours=1))]))
    fetch.push(_rss([]))
    notifier = _NotifySpy()
    counters = _run(fetch, notifier, prime_gov=False)
    assert counters["errors"] == 0
    assert notifier.calls == []  # état corrompu -> reparti de zéro -> 1er passage = seed
    assert (global_path.parent / "newswatch_global.json.corrupt").is_file()


# =========================================================================== #
#  I/O -- run_once, anti-spam par HISTOIRE du volet gov (incident du 24/08
#  soir -- cf. commentaire de tête de newswatch.py ~L99). Titres choisis et
#  calibrés (cf. tests story_key_* ci-dessus) pour converger/diverger comme
#  voulu -- ce ne sont pas des exemples arbitraires.
# =========================================================================== #

def test_run_once_gov_same_story_x3_sends_once_and_mutes_the_rest():
    fetch = _FetchQueue()
    fetch.push(_rss([]))
    fetch.push(_rss([]))
    notifier = _NotifySpy()
    _run(fetch, notifier, prime_gov=False)  # seed

    later = NOW + timedelta(minutes=10)
    same_story = [
        ("Trump announces new sanctions on Iranian oil exports", "https://n/s1", later),
        ("Trump announces new sanctions on Iranian oil exports - Reuters", "https://n/s2", later),
        ("Trump announces new sanctions on Iranian oil exports - AP News", "https://n/s3", later),
    ]
    fetch.push(_rss(same_story))
    fetch.push(_rss([]))
    counters = _run(fetch, notifier, now=later, prime_gov=False)
    assert counters["notified"] == 1
    assert len(notifier.calls) == 1

    events = newswatch.recent_events("anyone")
    assert len(events) == 3  # rien n'est perdu -- les 2 mutés restent dans le feed
    assert sorted(e["muted"] for e in events) == [False, True, True]
    sent = [e for e in events if not e["muted"]]
    assert sent[0]["link"] == "https://n/s1"


def test_run_once_gov_story_mute_blocks_resend_within_6h():
    fetch = _FetchQueue()
    fetch.push(_rss([]))
    fetch.push(_rss([]))
    notifier = _NotifySpy()
    _run(fetch, notifier, prime_gov=False)  # seed

    t1 = NOW + timedelta(minutes=10)
    nk_title = "Trump announces new sanctions on North Korea over missile tests"
    fetch.push(_rss([(nk_title, "https://n/nk1", t1)]))
    fetch.push(_rss([]))
    counters1 = _run(fetch, notifier, now=t1, prime_gov=False)
    assert counters1["notified"] == 1

    t2 = t1 + timedelta(hours=2)  # < 6h -- même histoire, encore mutée
    fetch.push(_rss([(nk_title + " - Reuters", "https://n/nk2", t2)]))
    fetch.push(_rss([]))
    counters2 = _run(fetch, notifier, now=t2, prime_gov=False)
    assert counters2["notified"] == 0
    assert len(notifier.calls) == 1  # toujours 1 au total

    events = newswatch.recent_events("anyone")
    muted_evt = next(e for e in events if e["link"] == "https://n/nk2")
    assert muted_evt["muted"] is True


def test_run_once_gov_story_mute_expires_after_6h():
    fetch = _FetchQueue()
    fetch.push(_rss([]))
    fetch.push(_rss([]))
    notifier = _NotifySpy()
    _run(fetch, notifier, prime_gov=False)  # seed

    t1 = NOW + timedelta(minutes=10)
    nk_title = "Trump announces new sanctions on North Korea over missile tests"
    fetch.push(_rss([(nk_title, "https://n/nk1", t1)]))
    fetch.push(_rss([]))
    _run(fetch, notifier, now=t1, prime_gov=False)

    t2 = t1 + timedelta(hours=7)  # > 6h -- l'histoire peut de nouveau être envoyée
    fetch.push(_rss([(nk_title + " - Reuters", "https://n/nk2", t2)]))
    fetch.push(_rss([]))
    counters2 = _run(fetch, notifier, now=t2, prime_gov=False)
    assert counters2["notified"] == 1
    assert len(notifier.calls) == 2

    events = newswatch.recent_events("anyone")
    resent_evt = next(e for e in events if e["link"] == "https://n/nk2")
    assert resent_evt["muted"] is False


def test_run_once_gov_hard_budget_mutes_the_fifth_send_within_the_hour():
    fetch = _FetchQueue()
    fetch.push(_rss([]))
    fetch.push(_rss([]))
    notifier = _NotifySpy()
    _run(fetch, notifier, prime_gov=False)  # seed

    # 3 histoires DISTINCTES en 1 run -- le cap historique par-run (3) est
    # respecté, rien à voir avec le budget dur.
    t1 = NOW + timedelta(minutes=10)
    first_three = [
        ("Trump announces tariff on French wine imports", "https://n/b1", t1),
        ("White House announces sanctions on Cuban officials", "https://n/b2", t1),
        ("Government announces bailout for steel industry", "https://n/b3", t1),
    ]
    fetch.push(_rss(first_three))
    fetch.push(_rss([]))
    counters1 = _run(fetch, notifier, now=t1, prime_gov=False)
    assert counters1["notified"] == 3

    # 2 histoires DISTINCTES de plus, même heure glissante : la 4e passe
    # encore (budget dur = 4/h), la 5e est muette.
    t2 = t1 + timedelta(minutes=10)
    next_two = [
        ("New executive order on semiconductor exports", "https://n/b4", t2),
        ("Trump announces tariff on Japanese electronics", "https://n/b5", t2),
    ]
    fetch.push(_rss(next_two))
    fetch.push(_rss([]))
    counters2 = _run(fetch, notifier, now=t2, prime_gov=False)
    assert counters2["notified"] == 1
    assert len(notifier.calls) == 4

    events = newswatch.recent_events("anyone")
    muted_evt = next(e for e in events if e["link"] == "https://n/b5")
    assert muted_evt["muted"] is True


def test_run_once_gov_hard_budget_resets_after_sent_log_purge():
    fetch = _FetchQueue()
    fetch.push(_rss([]))
    fetch.push(_rss([]))
    notifier = _NotifySpy()
    _run(fetch, notifier, prime_gov=False)  # seed

    t1 = NOW + timedelta(minutes=10)
    burst = [
        ("Trump announces tariff on French wine imports", "https://n/c1", t1),
        ("White House announces sanctions on Cuban officials", "https://n/c2", t1),
        ("Government announces bailout for steel industry", "https://n/c3", t1),
    ]
    fetch.push(_rss(burst))
    fetch.push(_rss([]))
    _run(fetch, notifier, now=t1, prime_gov=False)

    t2 = t1 + timedelta(minutes=5)  # toujours dans l'heure -- 4e envoi, encore permis
    fetch.push(_rss([("New executive order on semiconductor exports", "https://n/c4", t2)]))
    fetch.push(_rss([]))
    counters2 = _run(fetch, notifier, now=t2, prime_gov=False)
    assert counters2["notified"] == 1
    assert len(notifier.calls) == 4

    # plus d'1h après CHACUN des 4 envois précédents -> sent_log entièrement
    # purgé -> le budget est de nouveau disponible (pas de plafond permanent).
    t3 = t1 + timedelta(hours=1, minutes=30)
    fetch.push(_rss([("Trump announces tariff on Japanese electronics", "https://n/c5", t3)]))
    fetch.push(_rss([]))
    counters3 = _run(fetch, notifier, now=t3, prime_gov=False)
    assert counters3["notified"] == 1
    assert len(notifier.calls) == 5


def test_run_once_gov_missing_stories_key_in_state_does_not_crash():
    global_path = store.DATA_DIR / "newswatch_global.json"
    global_path.parent.mkdir(parents=True, exist_ok=True)
    # état "ancien format" (écrit avant l'extension anti-spam par histoire) --
    # JSON valide, seed déjà fait, mais sans les clés stories/sent_log.
    global_path.write_text(
        '{"seen": {}, "events": [], "seeded": {"gov": true}}', encoding="utf-8",
    )

    fetch = _FetchQueue()
    fetch.push(_rss([("Trump announces new sanctions on Iranian oil exports", "https://n/old1", NOW)]))
    fetch.push(_rss([]))
    notifier = _NotifySpy()
    counters = _run(fetch, notifier, prime_gov=False)
    assert counters["errors"] == 0
    assert counters["notified"] == 1  # ni stories ni sent_log absents ne bloquent l'envoi
    assert len(notifier.calls) == 1


# =========================================================================== #
#  I/O -- recent_events (contrat public consommé par le router)
# =========================================================================== #

def test_recent_events_empty_when_no_file():
    assert newswatch.recent_events("ghost") == []


def test_recent_events_orders_most_recent_first():
    store.save_portfolio("gabi", _portfolio(["EVT.SW"]))
    fetch = _FetchQueue()
    fetch.push(_rss([("Seed", "https://y/seed", NOW - timedelta(hours=10))]))
    notifier = _NotifySpy()
    _run(fetch, notifier)

    t1 = NOW + timedelta(minutes=5)
    fetch.push(_rss([
        ("Seed", "https://y/seed", NOW - timedelta(hours=10)),
        ("First profit warning", "https://y/e1", t1),
    ]))
    _run(fetch, notifier, now=t1)

    t2 = t1 + timedelta(minutes=5)
    fetch.push(_rss([
        ("Seed", "https://y/seed", NOW - timedelta(hours=10)),
        ("First profit warning", "https://y/e1", t1),
        ("Second downgrade announced", "https://y/e2", t2),
    ]))
    _run(fetch, notifier, now=t2)

    events = newswatch.recent_events("gabi")
    assert [e["link"] for e in events] == ["https://y/e2", "https://y/e1"]


def test_recent_events_invalid_username_raises():
    with pytest.raises(ValueError):
        newswatch.recent_events("../etc/passwd")


# =========================================================================== #
#  engine._arm_paper_jobs -- résilience du bloc scheduler
#  (Lot E veille news + whales 13F + radar ×3, cf. spec §12/§13)
# =========================================================================== #

def _inject_fake_module(monkeypatch, dotted_name, **attrs):
    """Pose un faux module dans sys.modules ET comme attribut du paquet
    parent -- `from parent import child` vérifie D'ABORD getattr(parent,
    child) avant de retomber sur sys.modules, donc les deux doivent être
    posés pour que l'injection soit fiable quel que soit l'ordre d'imports
    déjà en cache."""
    mod = types.ModuleType(dotted_name)
    for k, v in attrs.items():
        setattr(mod, k, v)
    monkeypatch.setitem(sys.modules, dotted_name, mod)
    parent_name, _, child_name = dotted_name.rpartition(".")
    parent = sys.modules.get(parent_name)
    if parent is not None:
        monkeypatch.setattr(parent, child_name, mod, raising=False)
    return mod


def _break_module(monkeypatch, dotted_name):
    """Force l'échec d'un `from parent import child` -- sys.modules[name] =
    None est le sentinel documenté de l'import system ("import halted"), et
    on retire aussi l'attribut du paquet parent au cas où il aurait déjà été
    importé avec succès plus tôt dans la session de test."""
    monkeypatch.setitem(sys.modules, dotted_name, None)
    parent_name, _, child_name = dotted_name.rpartition(".")
    parent = sys.modules.get(parent_name)
    if parent is not None:
        monkeypatch.delattr(parent, child_name, raising=False)


class _FakeSchedulerEngine:
    def __init__(self):
        self.calls = []

    def add_job(self, func, **kwargs):
        self.calls.append((func, kwargs))


def _job(sched, job_id):
    return next((f, kw) for f, kw in sched.calls if kw["id"] == job_id)


def _ids(sched):
    return [kw["id"] for _f, kw in sched.calls]


def test_arm_paper_jobs_registers_newswatch_job():
    from backend.scheduler.engine import _arm_paper_jobs
    sched = _FakeSchedulerEngine()
    _arm_paper_jobs(sched)
    func, kwargs = _job(sched, "paper_news_watch")
    assert func is newswatch.run_once
    assert kwargs["replace_existing"] is True


def test_arm_paper_jobs_survives_newswatch_import_failure(monkeypatch):
    from backend.scheduler.engine import _arm_paper_jobs
    _break_module(monkeypatch, "backend.bots.paper.newswatch")
    sched = _FakeSchedulerEngine()
    _arm_paper_jobs(sched)  # ne doit lever aucune exception
    assert "paper_news_watch" not in _ids(sched)


def test_arm_paper_jobs_registers_whales_job_when_available(monkeypatch):
    from backend.scheduler.engine import _arm_paper_jobs

    def _fake_check_new_filings():
        return None

    _inject_fake_module(monkeypatch, "backend.bots.paper.whales",
                        check_new_filings=_fake_check_new_filings)
    sched = _FakeSchedulerEngine()
    _arm_paper_jobs(sched)
    func, kwargs = _job(sched, "paper_whales_watch")
    assert func is _fake_check_new_filings
    assert kwargs["replace_existing"] is True


def test_arm_paper_jobs_survives_whales_import_failure_without_blocking_others(monkeypatch):
    from backend.scheduler.engine import _arm_paper_jobs
    _break_module(monkeypatch, "backend.bots.paper.whales")
    sched = _FakeSchedulerEngine()
    _arm_paper_jobs(sched)  # ne doit lever aucune exception
    ids = _ids(sched)
    assert "paper_whales_watch" not in ids
    assert "paper_news_watch" in ids  # l'échec de whales ne bloque pas newswatch


def test_arm_paper_jobs_registers_three_radar_jobs_when_available(monkeypatch):
    from backend.scheduler.engine import _arm_paper_jobs

    def _fake_run_once():
        return None

    _inject_fake_module(monkeypatch, "backend.bots.paper.radar", run_once=_fake_run_once)
    sched = _FakeSchedulerEngine()
    _arm_paper_jobs(sched)
    ids = _ids(sched)
    assert "paper_radar_0745" in ids
    assert "paper_radar_1200" in ids
    assert "paper_radar_1900" in ids

    expected = {"paper_radar_0745": (7, 45), "paper_radar_1200": (12, 0), "paper_radar_1900": (19, 0)}
    for job_id, (hour, minute) in expected.items():
        func, kwargs = _job(sched, job_id)
        assert func is _fake_run_once
        assert kwargs["replace_existing"] is True
        trigger = kwargs["trigger"]
        names = trigger.FIELD_NAMES
        assert str(trigger.fields[names.index("hour")]) == str(hour)
        assert str(trigger.fields[names.index("minute")]) == str(minute)


def test_arm_paper_jobs_survives_radar_import_failure_without_blocking_others(monkeypatch):
    from backend.scheduler.engine import _arm_paper_jobs
    _break_module(monkeypatch, "backend.bots.paper.radar")
    sched = _FakeSchedulerEngine()
    _arm_paper_jobs(sched)  # ne doit lever aucune exception
    ids = _ids(sched)
    assert "paper_radar_0745" not in ids
    assert "paper_radar_1200" not in ids
    assert "paper_radar_1900" not in ids
    assert "paper_news_watch" in ids


def test_arm_paper_jobs_all_three_independent_failures_leave_scheduler_intact(monkeypatch):
    """Le pire cas : les trois imports échouent en même temps -> aucune
    exception ne doit remonter (c'est ce qui protège start_scheduler)."""
    from backend.scheduler.engine import _arm_paper_jobs
    _break_module(monkeypatch, "backend.bots.paper.newswatch")
    _break_module(monkeypatch, "backend.bots.paper.whales")
    _break_module(monkeypatch, "backend.bots.paper.radar")
    sched = _FakeSchedulerEngine()
    _arm_paper_jobs(sched)  # ne doit lever aucune exception
    assert sched.calls == []


# =========================================================================== #
#  PUR — classification CRYPTO (volet global, 26/08)
# =========================================================================== #

def test_le_gate_de_pertinence_jette_un_titre_hors_sujet():
    """Decrypt est un flux tech MÉLANGÉ : c'est le gate qui le rend utilisable,
    pas une liste de sujets à exclure."""
    assert newswatch.is_crypto_topic("SpaceX lands another booster") is False
    assert newswatch.classify_crypto("SpaceX lands another booster") is None


def test_un_titre_crypto_negatif_est_classe_neg():
    assert newswatch.classify_crypto(
        "Binance hot wallet exploit drains $200M") == "neg"


def test_un_titre_crypto_positif_est_classe_pos():
    assert newswatch.classify_crypto(
        "Bitcoin ETF sees record inflows for a third week") == "pos"


def test_une_decision_a_venir_est_classee_watch():
    assert newswatch.classify_crypto(
        "SEC faces Solana ETF decision next month") == "watch"


def test_une_mauvaise_nouvelle_prime_sur_une_bonne():
    assert newswatch.classify_crypto(
        "Ethereum ETF inflows continue despite exchange hack") == "neg"


def test_un_conseil_d_achat_crypto_n_est_jamais_relaye():
    assert newswatch.classify_crypto("3 crypto to buy now before the halving") is None


def test_un_titre_crypto_neutre_ne_produit_rien():
    assert newswatch.classify_crypto("Bitcoin conference opens in Miami") is None


@pytest.mark.parametrize("title,symbol", [
    ("Bitcoin breaks its all-time high", "BTC-USD"),
    ("Ethereum upgrade goes live", "ETH-USD"),
    ("Solana ETF decision expected", "SOL-USD"),
    ("Ripple wins its ruling", "XRP-USD"),
    ("BTC outflows accelerate", "BTC-USD"),
])
def test_le_symbole_est_devine_depuis_le_titre(title, symbol):
    assert newswatch.crypto_symbol(title) == symbol


def test_un_titre_crypto_sans_piece_nommee_n_a_pas_de_symbole():
    """Mieux vaut un event sans symbole qu'un event mal étiqueté : c'est le
    symbole qui décide du facteur « titre détenu » de la convergence."""
    assert newswatch.crypto_symbol("Crypto market cap slides") is None


# =========================================================================== #
#  I/O — volet CRYPTO
# =========================================================================== #

CRYPTO_HACK = "Coinbase exchange hack drains user funds"
CRYPTO_LINK = "https://cointelegraph.com/hack"


def _crypto_feed(now=None, title=CRYPTO_HACK, link=CRYPTO_LINK):
    return _rss([(title, link, now or NOW)])


def test_le_volet_crypto_amorce_en_silence_puis_notifie():
    fetch = _FetchQueue()
    fetch.push_crypto(_crypto_feed())
    notifier = _NotifySpy()
    _run(fetch, notifier)
    assert notifier.calls == []                 # amorçage muet

    later = NOW + timedelta(minutes=10)
    fetch.push_crypto(_crypto_feed(now=later, link="https://cointelegraph.com/2"))
    counters = _run(fetch, notifier, now=later)
    assert counters["notified"] == 1
    assert "crypto" in notifier.calls[0][0].lower()


def test_le_volet_crypto_journalise_meme_ce_qu_il_n_envoie_pas():
    fetch = _FetchQueue()
    fetch.push_crypto(_crypto_feed())
    _run(fetch, _NotifySpy())                   # seed
    later = NOW + timedelta(minutes=10)
    fetch.push_crypto(_crypto_feed(now=later, link="https://cointelegraph.com/2"))
    _run(fetch, _NotifySpy(), now=later)

    events = [e for e in newswatch.recent_events("nobody") if e.get("src") == "crypto"]
    assert len(events) == 1
    assert events[0]["sentiment"] == "neg"
    assert events[0]["symbol"] is None          # aucune pièce nommée dans ce titre


def test_le_volet_crypto_ignore_un_titre_hors_sujet():
    fetch = _FetchQueue()
    fetch.push_crypto(_rss([("Seed", "https://c/seed", NOW)]))
    _run(fetch, _NotifySpy())
    later = NOW + timedelta(minutes=10)
    fetch.push_crypto(_rss([
        ("Seed", "https://c/seed", NOW),
        ("SpaceX lands another booster", "https://c/space", later),
    ]))
    notifier = _NotifySpy()
    _run(fetch, notifier, now=later)
    assert notifier.calls == []
    assert [e for e in newswatch.recent_events("nobody")
            if e.get("src") == "crypto"] == []


def test_le_budget_crypto_est_distinct_de_celui_du_gov():
    """Partager le budget ferait taire un volet dès que l'autre s'agite — et
    on ne saurait jamais lequel a mangé la place."""
    assert newswatch._CRYPTO_MAX_SENDS_PER_HOUR > 0
    fetch = _FetchQueue()
    fetch.push_crypto(_rss([("Seed", "https://c/seed", NOW)]))
    _run(fetch, _NotifySpy())
    later = NOW + timedelta(minutes=10)
    burst = [("Seed", "https://c/seed", NOW)] + [
        ("Exchange hack number %d drains bitcoin" % i,
         "https://cointelegraph.com/h%d" % i, later) for i in range(6)
    ]
    fetch.push_crypto(_rss(burst))
    notifier = _NotifySpy()
    _run(fetch, notifier, now=later)
    assert len(notifier.calls) == newswatch._MAX_CRYPTO_NOTIFY_PER_RUN
    muted = [e for e in newswatch.recent_events("nobody")
             if e.get("src") == "crypto" and e.get("muted")]
    assert muted, "le surplus doit rester dans la mémoire, seul l'envoi tombe"


# =========================================================================== #
#  PUR — volets MONDE : ÉCONOMIE et ÉCOLOGIE (26/08 soir)
#
#  « Grosse partie des infos c'est que politique — il y a aussi l'économique,
#  l'écologique. »
# =========================================================================== #

def test_l_url_google_news_est_encodee_et_en_anglais():
    """Les guillemets, les parenthèses et le ``:`` de ``when:1d`` appartiennent
    à la REQUÊTE : ils sont encodés, pas laissés bruts."""
    url = newswatch.gnews_url('("Federal Reserve" OR inflation) when:1d')
    assert url.startswith("https://news.google.com/rss/search?q=")
    assert "hl=en-US" in url and "gl=US" in url and "ceid=US:en" in url
    assert '"' not in url and " " not in url
    assert "when%3A1d" in url and "%22Federal%20Reserve%22" in url
    # …et la requête se relit telle quelle après décodage.
    query = unquote(url.split("q=", 1)[1].split("&", 1)[0])
    assert query == '("Federal Reserve" OR inflation) when:1d'


def test_les_deux_volets_monde_interrogent_une_url_google_news_chacun():
    assert len(newswatch._ECO_SOURCES) == 1
    assert len(newswatch._CLIMAT_SOURCES) == 1
    assert newswatch._ECO_SOURCES[0] == newswatch.gnews_url(newswatch.ECO_QUERY)
    assert newswatch._CLIMAT_SOURCES[0] == newswatch.gnews_url(
        newswatch.CLIMAT_QUERY)
    assert newswatch._ECO_SOURCES[0] != newswatch._CLIMAT_SOURCES[0]


# --- le gate de pertinence ÉCO ---------------------------------------------- #

def test_le_gate_eco_jette_une_depeche_d_entreprise():
    """Sans marqueur macro, rien n'entre — quelle que soit la tonalité. C'est
    ce qui empêche une dépêche d'entreprise d'aller peser sur le pivot
    « monde »."""
    assert newswatch.is_eco_topic("Nvidia beats estimates in Q3") is False
    assert newswatch.classify_eco("Nvidia beats estimates in Q3") is None


def test_le_gate_eco_reconnait_les_marqueurs_macro():
    for title in ("US inflation data lands tomorrow",
                  "ECB weighs its next move",
                  "Oil prices steady before the OPEC meeting",
                  "Unemployment ticks up in Germany"):
        assert newswatch.is_eco_topic(title) is True


@pytest.mark.parametrize("title,expected", [
    ("US inflation surges to 6%", "neg"),
    ("Recession fears grow as unemployment jumps", "neg"),
    ("Fed hikes rates by half a point", "neg"),
    ("Inflation cools to 2.1% in the euro zone", "pos"),
    ("ECB cuts rates by 25 basis points", "pos"),
    ("Fed meeting ahead of key CPI report", "watch"),
    ("Fed holds rates steady", "watch"),
])
def test_classify_eco_donne_la_tonalite_du_marche(title, expected):
    """Un statu quo de taux est un ``watch`` : il ne dit ni « bon » ni
    « mauvais », il dit que la suite se joue là — le ranger ailleurs mentirait,
    le laisser tomber effacerait l'événement macro le plus suivi."""
    assert newswatch.classify_eco(title) == expected


def test_une_mauvaise_nouvelle_eco_prime_sur_une_bonne():
    assert newswatch.classify_eco(
        "Inflation cools but recession fears grow") == "neg"


def test_un_conseil_d_achat_macro_n_est_jamais_relaye():
    """Doctrine du dépôt : on ne recopie jamais un conseil, même déguisé en
    dépêche macro."""
    assert newswatch.classify_eco(
        "Inflation cools: top stocks to ride the rebound") is None


def test_un_titre_macro_sans_tonalite_ne_produit_rien():
    assert newswatch.classify_eco("The Fed published its usual bulletin") is None
    assert newswatch.classify_eco("") is None
    assert newswatch.is_eco_topic("") is False


# --- le gate de pertinence CLIMAT (les DEUX moitiés) ------------------------ #

def test_un_ouragan_sans_dimension_economique_ne_passe_pas():
    """LE test du volet : un simulateur de bourse n'a pas à tenir la chronique
    météo du monde."""
    title = "Hurricane Milton approaches Florida coast"
    assert newswatch.is_climat_topic(title) is False
    assert newswatch.classify_climat(title) is None


def test_le_meme_ouragan_passe_des_qu_il_touche_l_economie():
    title = "Hurricane forces refinery shutdown as oil prices jump"
    assert newswatch.is_climat_topic(title) is True
    assert newswatch.classify_climat(title) == "neg"


def test_une_depeche_economique_sans_alea_climatique_ne_passe_pas_non_plus():
    """L'autre moitié du gate : le croisement est exigé dans les DEUX sens."""
    assert newswatch.is_climat_topic("Oil prices jump on supply fears") is False


@pytest.mark.parametrize("title,expected", [
    ("Drought destroys wheat crops in Argentina", "neg"),
    ("Flooding halts production at Thai chip plants", "neg"),
    ("Wildfires threaten California power supply", "watch"),
    ("Heatwave warning as energy demand set to peak", "watch"),
    ("Rains ease Brazil drought and coffee prices fall", "pos"),
])
def test_classify_climat_donne_la_tonalite(title, expected):
    assert newswatch.classify_climat(title) == expected


def test_les_deux_volets_monde_ne_produisent_jamais_la_tonalite_gov():
    """C'est l'invariant qui garde le facteur politique de la convergence
    propre : ces volets parlent la langue de tout le monde (pos/neg/watch)."""
    titles = ["US inflation surges to 6%", "Fed holds rates steady",
              "Drought destroys wheat crops in Argentina",
              "Wildfires threaten California power supply"]
    tones = ([newswatch.classify_eco(t) for t in titles]
             + [newswatch.classify_climat(t) for t in titles])
    assert "gov" not in tones


def test_les_messages_monde_signalent_sans_jamais_conseiller():
    eco = newswatch.format_eco_message("US inflation surges", "https://g/1",
                                       "neg")
    climat = newswatch.format_climat_message("Drought destroys wheat crops",
                                             "https://g/2", "neg", "ADM")
    assert eco.startswith("[Simulateur] ") and "https://g/1" in eco
    assert "ADM" in climat and "https://g/2" in climat
    for message in (eco, climat):
        low = message.lower()
        assert "achet" not in low and "vends" not in low and "buy" not in low


# =========================================================================== #
#  I/O — volets MONDE (éco, climat)
# =========================================================================== #

ECO_TITLE = "US inflation surges to a 6% annual rate"
ECO_LINK = "https://news.google.com/eco1"
CLIMAT_TITLE = "Drought destroys wheat crops and lifts prices"
CLIMAT_LINK = "https://news.google.com/cli1"


def _eco_feed(now=None, title=ECO_TITLE, link=ECO_LINK):
    return _rss([(title, link, now or NOW)])


def _climat_feed(now=None, title=CLIMAT_TITLE, link=CLIMAT_LINK):
    return _rss([(title, link, now or NOW)])


def test_le_volet_eco_amorce_en_silence_puis_notifie():
    fetch = _FetchQueue()
    fetch.push_eco(_eco_feed())
    notifier = _NotifySpy()
    _run(fetch, notifier)
    assert notifier.calls == []                 # amorçage muet

    later = NOW + timedelta(minutes=10)
    fetch.push_eco(_eco_feed(now=later, link="https://news.google.com/eco2"))
    counters = _run(fetch, notifier, now=later)
    assert counters["notified"] == 1
    assert "économique" in notifier.calls[0][0].lower()

    events = [e for e in newswatch.recent_events("nobody")
              if e.get("src") == "eco"]
    assert len(events) == 1
    assert events[0]["sentiment"] == "neg" and events[0]["muted"] is False


def test_le_volet_climat_amorce_en_silence_puis_notifie():
    fetch = _FetchQueue()
    fetch.push_climat(_climat_feed())
    notifier = _NotifySpy()
    _run(fetch, notifier)
    assert notifier.calls == []

    later = NOW + timedelta(minutes=10)
    fetch.push_climat(_climat_feed(now=later,
                                   link="https://news.google.com/cli2"))
    counters = _run(fetch, notifier, now=later)
    assert counters["notified"] == 1
    assert "climatique" in notifier.calls[0][0].lower()
    assert [e["src"] for e in newswatch.recent_events("nobody")
            if e.get("src") == "climat"] == ["climat"]


def test_le_volet_eco_ignore_un_titre_hors_sujet():
    fetch = _FetchQueue()
    fetch.push_eco(_rss([("Seed", "https://g/eseed", NOW)]))
    _run(fetch, _NotifySpy())
    later = NOW + timedelta(minutes=10)
    fetch.push_eco(_rss([
        ("Seed", "https://g/eseed", NOW),
        ("Nvidia beats estimates in Q3", "https://g/e-off", later),
    ]))
    notifier = _NotifySpy()
    _run(fetch, notifier, now=later)
    assert notifier.calls == []
    assert [e for e in newswatch.recent_events("nobody")
            if e.get("src") == "eco"] == []


def test_le_volet_climat_ignore_un_alea_sans_economie():
    fetch = _FetchQueue()
    fetch.push_climat(_rss([("Seed", "https://g/cseed", NOW)]))
    _run(fetch, _NotifySpy())
    later = NOW + timedelta(minutes=10)
    fetch.push_climat(_rss([
        ("Seed", "https://g/cseed", NOW),
        ("Hurricane Milton approaches Florida coast", "https://g/c-off", later),
    ]))
    _run(fetch, _NotifySpy(), now=later)
    assert [e for e in newswatch.recent_events("nobody")
            if e.get("src") == "climat"] == []


def test_le_volet_eco_ignore_un_titre_plus_vieux_que_24h():
    fetch = _FetchQueue()
    fetch.push_eco(_rss([("Seed", "https://g/eseed", NOW)]))
    _run(fetch, _NotifySpy())
    later = NOW + timedelta(minutes=10)
    fetch.push_eco(_rss([
        ("Seed", "https://g/eseed", NOW),
        (ECO_TITLE, "https://g/e-old", later - timedelta(hours=30)),
    ]))
    notifier = _NotifySpy()
    _run(fetch, notifier, now=later)
    assert notifier.calls == []
    assert [e for e in newswatch.recent_events("nobody")
            if e.get("src") == "eco"] == []


def test_une_depeche_macro_qui_nomme_une_entreprise_porte_son_symbole():
    """C'est ``entities`` branché : la dépêche rejoint alors la BRANCHE de ce
    titre dans la toile, au lieu de finir au pivot « monde »."""
    fetch = _FetchQueue()
    fetch.push_eco(_rss([("Seed", "https://g/eseed", NOW)]))
    _run(fetch, _NotifySpy())

    later = NOW + timedelta(minutes=10)
    fetch.push_eco(_rss([
        ("Seed", "https://g/eseed", NOW),
        ("Fed rate cut lifts Nvidia and the whole chip sector",
         "https://g/e-nvda", later),
    ]))
    _run(fetch, _NotifySpy(), now=later)
    events = [e for e in newswatch.recent_events("nobody")
              if e.get("src") == "eco"]
    assert [e["symbol"] for e in events] == ["NVDA"]


def test_une_depeche_macro_qui_ne_nomme_personne_n_invente_pas_de_symbole():
    fetch = _FetchQueue()
    fetch.push_eco(_eco_feed())
    _run(fetch, _NotifySpy())
    later = NOW + timedelta(minutes=10)
    fetch.push_eco(_eco_feed(now=later, link="https://news.google.com/eco2"))
    _run(fetch, _NotifySpy(), now=later)
    events = [e for e in newswatch.recent_events("nobody")
              if e.get("src") == "eco"]
    assert events[0]["symbol"] is None


def test_le_budget_eco_est_distinct_de_celui_du_gov_et_du_crypto():
    """Trois volets, trois budgets : partager ferait taire l'un dès que l'autre
    s'agite, et personne ne saurait lequel a mangé la place."""
    state = newswatch._default_seen_state()
    assert {"sent_log", "crypto_sent_log", "eco_sent_log",
            "climat_sent_log"} <= set(state)

    fetch = _FetchQueue()
    fetch.push_eco(_rss([("Seed", "https://g/eseed", NOW)]))
    _run(fetch, _NotifySpy())

    later = NOW + timedelta(minutes=10)
    # SIX histoires DIFFÉRENTES : six reprises de la même seraient mises en
    # sourdine par la couche « histoire », et on ne mesurerait plus le budget.
    stories = [
        "US inflation surges to a six percent annual rate",
        "German unemployment jumps to a decade high",
        "Oil prices surge after a supply shock in Libya",
        "Recession fears grow across the euro zone",
        "Fed hikes rates to fight stubborn price pressure",
        "Treasury yields spike as investors flee bonds",
    ]
    burst = [("Seed", "https://g/eseed", NOW)] + [
        (title, "https://g/e%d" % i, later)
        for i, title in enumerate(stories)]
    fetch.push_eco(_rss(burst))
    notifier = _NotifySpy()
    _run(fetch, notifier, now=later)

    assert len(notifier.calls) == newswatch._MAX_ECO_NOTIFY_PER_RUN
    muted = [e for e in newswatch.recent_events("nobody")
             if e.get("src") == "eco" and e.get("muted")]
    assert muted, "le surplus doit rester en mémoire, seul l'envoi tombe"
    # …et le budget consommé est bien celui du volet, pas celui du gov.
    state = newswatch._load_global_seen()
    assert len(state["eco_sent_log"]) == newswatch._MAX_ECO_NOTIFY_PER_RUN
    assert state["sent_log"] == [] and state["crypto_sent_log"] == []


def test_la_meme_histoire_macro_reprise_par_trois_medias_n_envoie_qu_une_fois():
    """Google News est justement la source où une histoire arrive quinze fois —
    c'est l'incident du 24/08 au soir, et l'anti-spam est le même."""
    fetch = _FetchQueue()
    fetch.push_eco(_rss([("Seed", "https://g/eseed", NOW)]))
    _run(fetch, _NotifySpy())

    later = NOW + timedelta(minutes=10)
    fetch.push_eco(_rss([("Seed", "https://g/eseed", NOW)] + [
        ("US inflation surges to a six percent annual rate - " + source,
         "https://g/e-" + source, later)
        for source in ("Reuters", "CNBC", "Bloomberg")]))
    notifier = _NotifySpy()
    _run(fetch, notifier, now=later)

    assert len(notifier.calls) == 1
    events = [e for e in newswatch.recent_events("nobody")
              if e.get("src") == "eco"]
    assert [e["muted"] for e in events].count(True) == 2


def test_la_sourdine_par_histoire_ne_traverse_pas_les_volets():
    """Clé PRÉFIXÉE par le volet : l'économie et l'écologie peuvent parler du
    même sujet le même jour sans se rendre muettes l'une l'autre."""
    fetch = _FetchQueue()
    fetch.push_eco(_rss([("Seed", "https://g/eseed", NOW)]))
    fetch.push_climat(_rss([("Seed", "https://g/cseed", NOW)]))
    _run(fetch, _NotifySpy())

    later = NOW + timedelta(minutes=10)
    shared = "Drought destroys wheat crops and oil prices surge"
    fetch.push_eco(_rss([("Seed", "https://g/eseed", NOW),
                         (shared, "https://g/e-shared", later)]))
    fetch.push_climat(_rss([("Seed", "https://g/cseed", NOW),
                            (shared, "https://g/c-shared", later)]))
    notifier = _NotifySpy()
    _run(fetch, notifier, now=later)
    assert len(notifier.calls) == 2

    state = newswatch._load_global_seen()
    prefixes = sorted(k.split(":", 1)[0] for k in state["stories"])
    assert prefixes == ["climat", "eco"]


def test_le_volet_eco_en_panne_ne_bloque_pas_le_volet_climat():
    fetch = _FetchQueue()
    fetch.push_eco(RuntimeError("boom"))
    fetch.push_climat(_climat_feed())
    counters = _run(fetch, _NotifySpy())
    assert counters["errors"] == 1
    # 2 gov + 2 crypto + climat + 3 bc (l'éco a levé) = 8 réponses reçues.
    assert counters["fetched"] == 8


def test_mode_calme_les_volets_monde_n_envoient_plus_rien():
    fetch = _FetchQueue()
    fetch.push_eco(_rss([("Seed", "https://g/eseed", NOW)]))
    fetch.push_climat(_rss([("Seed", "https://g/cseed", NOW)]))
    _run(fetch, _NotifySpy())                        # seed

    later = NOW + timedelta(minutes=10)
    fetch.push_eco(_rss([("Seed", "https://g/eseed", NOW),
                         (ECO_TITLE, "https://g/e2", later)]))
    fetch.push_climat(_rss([("Seed", "https://g/cseed", NOW),
                            (CLIMAT_TITLE, "https://g/c2", later)]))
    notifier = _NotifySpy()
    counters = _run(fetch, notifier, now=later, mode="calme")

    assert notifier.calls == [] and counters["notified"] == 0
    events = [e for e in newswatch.recent_events("nobody")
              if e.get("src") in ("eco", "climat")]
    assert sorted(e["src"] for e in events) == ["climat", "eco"]
    assert all(e["muted"] is True for e in events)
    # …et aucun budget n'a été consommé : le mode calme ne dépense rien.
    state = newswatch._load_global_seen()
    assert state["eco_sent_log"] == [] and state["climat_sent_log"] == []


def test_un_etat_ecrit_avant_les_volets_monde_ne_plante_pas():
    """Rétro-compat : un ``newswatch_global.json`` d'avant l'extension n'a ni
    ``eco_sent_log`` ni ``climat_sent_log`` — il repart d'un budget plein."""
    path = store.DATA_DIR / "newswatch_global.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"seen": {}, "events": [],
                                "seeded": {"gov": True, "crypto": True,
                                           "eco": True, "climat": True}}),
                    encoding="utf-8")
    fetch = _FetchQueue()
    fetch.push_eco(_eco_feed())
    notifier = _NotifySpy()
    counters = _run(fetch, notifier)
    assert counters["errors"] == 0
    assert len(notifier.calls) == 1          # déjà amorcé -> il notifie


# =========================================================================== #
#  MODE CALME (26/08) — la mémoire reste, l'envoi disparaît
# =========================================================================== #

def test_mode_calme_le_volet_gov_n_envoie_plus_rien():
    fetch = _FetchQueue()
    gov = _rss([("Trump announces 50% tariffs on EU goods", "https://g/1", NOW)])
    fetch.prime_gov(_EMPTY_RSS)
    _run(fetch, _NotifySpy(), prime_gov=False)       # seed

    later = NOW + timedelta(minutes=10)
    gov_later = _rss([("Trump announces 50% tariffs on EU goods",
                       "https://g/2", later)])
    fetch.push(gov_later)
    fetch.push(_EMPTY_RSS)
    notifier = _NotifySpy()
    counters = _run(fetch, notifier, now=later, prime_gov=False, mode="calme")

    assert notifier.calls == []                      # silence
    assert counters["notified"] == 0
    events = [e for e in newswatch.recent_events("nobody")
              if e.get("sentiment") == "gov"]
    assert len(events) == 1 and events[0]["muted"] is True


def test_mode_calme_le_volet_par_symbole_n_envoie_plus_rien():
    store.save_portfolio("alice", _portfolio(["NESN.SW"]))
    fetch = _FetchQueue()
    fetch.push(_rss([("Seed", "https://y/seed", NOW - timedelta(hours=5))]))
    _run(fetch, _NotifySpy())                        # seed

    later = NOW + timedelta(minutes=10)
    fetch.push(_rss([
        ("Seed", "https://y/seed", NOW - timedelta(hours=5)),
        ("Nestlé issues profit warning", "https://y/neg", later),
    ]))
    notifier = _NotifySpy()
    counters = _run(fetch, notifier, now=later, mode="calme")

    assert notifier.calls == [] and counters["notified"] == 0
    events = [e for e in newswatch.recent_events("alice")
              if e.get("symbol") == "NESN.SW"]
    assert len(events) == 1
    assert events[0]["sentiment"] == "neg" and events[0]["muted"] is True


def test_mode_calme_est_le_defaut_quand_rien_n_est_precise(monkeypatch):
    """Le défaut de PRODUCTION est le silence : ``run_once`` lit le réglage,
    et le réglage absent vaut « calme »."""
    store.save_portfolio("alice", _portfolio(["NESN.SW"]))
    fetch = _FetchQueue()
    fetch.push(_rss([("Seed", "https://y/seed", NOW - timedelta(hours=5))]))
    _run(fetch, _NotifySpy(), mode=None)

    later = NOW + timedelta(minutes=10)
    fetch.push(_rss([
        ("Seed", "https://y/seed", NOW - timedelta(hours=5)),
        ("Nestlé issues profit warning", "https://y/neg", later),
    ]))
    notifier = _NotifySpy()
    _run(fetch, notifier, now=later, mode=None)
    assert notifier.calls == []


# =========================================================================== #
#  PUR — classification des posts X
# =========================================================================== #

def test_un_post_avec_cashtag_est_retenu():
    out = newswatch.classify_x("Just doubled down on $TSLA today")
    assert out == {"sentiment": "watch", "symbol": "TSLA"}


def test_un_post_a_impact_politique_est_classe_gov():
    out = newswatch.classify_x("We will impose new tariffs on all imports")
    assert out["sentiment"] == "gov"


def test_un_post_crypto_porte_sa_paire():
    out = newswatch.classify_x("Bitcoin ETF sees record inflows again")
    assert out == {"sentiment": "pos", "symbol": "BTC-USD"}


def test_un_meme_est_jete():
    """« Important seulement » : c'est la demande explicite."""
    assert newswatch.classify_x("good morning everyone") is None
    assert newswatch.classify_x("") is None


def test_un_cashtag_avec_une_mauvaise_nouvelle_est_classe_neg():
    """C'est ce qui permet au facteur « menace sur une position détenue » de
    s'allumer depuis un post."""
    out = newswatch.classify_x("$NESN profit warning after weak sales")
    assert out == {"sentiment": "neg", "symbol": "NESN"}


def test_un_conseil_d_achat_poste_sur_x_n_est_jamais_relaye():
    assert newswatch.classify_x("top stocks to buy now: $AAPL $MSFT") is None


def test_le_titre_d_un_post_est_tronque():
    long_post = "bitcoin " * 60
    title = newswatch.x_post_title(long_post)
    assert len(title) <= newswatch._X_POST_MAX_LEN
    assert title.endswith("…")


def test_les_comptes_x_sont_valides_dedupliques_et_plafonnes():
    handles = newswatch.normalize_handles(
        ["@elonmusk", "elonmusk", "ELONMUSK", "nom invalide !", "x" * 20, ""]
        + ["compte%d" % i for i in range(15)])
    assert handles[0] == "elonmusk"
    assert len(handles) == newswatch.X_MAX_HANDLES
    assert "nom invalide !" not in handles


def test_la_cadence_x_est_d_un_cycle_sur_deux():
    assert newswatch.x_cycle_due(0) is True
    assert newswatch.x_cycle_due(1) is False
    assert newswatch.x_cycle_due(2) is True
    assert newswatch.x_cycle_due("cassé") is True   # jamais éteint pour toujours


def test_les_comptes_x_par_defaut_sont_livres():
    assert _REAL_LOAD_X_ACCOUNTS() == list(newswatch.X_DEFAULT_HANDLES)


def test_une_liste_de_comptes_x_vide_reste_vide():
    """Une liste explicitement vide est une DÉCISION, pas une absence."""
    assert newswatch.save_x_accounts([]) == []
    assert _REAL_LOAD_X_ACCOUNTS() == []


def test_les_comptes_x_sont_ecrits_en_0600():
    newswatch.save_x_accounts(["WhiteHouse"])
    assert _REAL_LOAD_X_ACCOUNTS() == ["WhiteHouse"]
    assert oct(newswatch.x_accounts_path().stat().st_mode & 0o777) == "0o600"


# =========================================================================== #
#  I/O — volet X : deux étages, escalade, mémoire du tier, pacing
# =========================================================================== #

class _XPacer:
    """Faux ``AdaptivePacer`` : enregistre au lieu de temporiser."""

    def __init__(self):
        self.penalized = []
        self.relaxed = 0

    def interval(self):
        return 1.5

    def penalize(self, retry_after=None):
        self.penalized.append(retry_after)

    def relax(self):
        self.relaxed += 1


def _post(text, ts=None):
    return {"title": text, "url": "https://x.com/elonmusk",
            "published": int((ts or NOW).timestamp())}


def _x_env(monkeypatch, handles=("elonmusk",)):
    """Réinstalle un volet X pilotable (la fixture autouse l'éteint)."""
    monkeypatch.setattr(newswatch, "load_x_accounts", lambda: list(handles))


def _run_x(fetch, notifier, now=NOW, mode="tout", due=True, **kw):
    """Un cycle où le volet X tourne À COUP SÛR.

    La cadence « un cycle sur deux » a son propre test ci-dessous ; partout
    ailleurs elle obligerait à intercaler des cycles blancs illisibles, donc on
    remet le compteur à un cycle dû. ``due=False`` laisse la cadence agir."""
    if due:
        state = newswatch._load_global_seen()
        state["x_cycle"] = 0
        newswatch._save_global_seen(state)
    fetch.prime_gov()
    return newswatch.run_once(now=now, fetch=fetch, notifier=notifier,
                              tg_cfg=CFG, sleep=lambda s: None, mode=mode, **kw)


def test_le_volet_x_amorce_en_silence_puis_notifie(monkeypatch):
    _x_env(monkeypatch)
    posts = [_post("New tariffs on all imported cars starting Monday")]
    calls = []

    def light(handle):
        calls.append(handle)
        return "<html>page</html>"

    notifier = _NotifySpy()
    kw = dict(due=False, x_fetch=light, x_pacer=_XPacer(),
              x_parse=lambda page, handle: list(posts))
    _run_x(_FetchQueue(), notifier, **kw)
    assert notifier.calls == []                 # cycle 0 : amorçage muet

    later = NOW + timedelta(minutes=10)
    posts[:] = [_post("New tariffs on all imported steel next week", later)]
    _run_x(_FetchQueue(), notifier, now=later, **kw)
    assert len(calls) == 1                      # cycle 1 : la cadence saute X

    even_later = NOW + timedelta(minutes=20)
    _run_x(_FetchQueue(), notifier, now=even_later, **kw)
    assert len(calls) == 2                      # cycle 2 : X est réinterrogé
    assert len(notifier.calls) == 1
    assert "@elonmusk" in notifier.calls[0][0]


def test_le_volet_x_se_tait_en_mode_calme_mais_journalise(monkeypatch):
    _x_env(monkeypatch)
    posts = [_post("We will impose tariffs on every imported car")]
    parse = lambda page, handle: list(posts)
    _run_x(_FetchQueue(), _NotifySpy(), x_fetch=lambda h: "<html/>",
           x_parse=parse, x_pacer=_XPacer())    # seed

    later = NOW + timedelta(minutes=20)
    posts[:] = [_post("New sanctions on imported steel announced", later)]
    notifier = _NotifySpy()
    _run_x(_FetchQueue(), notifier, now=later, mode="calme",
           x_fetch=lambda h: "<html/>", x_parse=parse, x_pacer=_XPacer())

    assert notifier.calls == []
    events = [e for e in newswatch.recent_events("nobody") if e.get("src") == "x"]
    assert len(events) == 1
    assert events[0]["handle"] == "elonmusk" and events[0]["muted"] is True


def test_un_post_deja_vu_n_est_pas_renotifie(monkeypatch):
    _x_env(monkeypatch)
    posts = [_post("Tariffs on imported cars announced today")]
    parse = lambda page, handle: list(posts)
    _run_x(_FetchQueue(), _NotifySpy(), x_fetch=lambda h: "<html/>",
           x_parse=parse, x_pacer=_XPacer())    # seed
    notifier = _NotifySpy()
    for minutes in (20, 40):
        _run_x(_FetchQueue(), notifier, now=NOW + timedelta(minutes=minutes),
               x_fetch=lambda h: "<html/>", x_parse=parse, x_pacer=_XPacer())
    assert notifier.calls == []                 # même texte = déjà vu


def test_une_seule_anomalie_ne_reveille_pas_le_navigateur(monkeypatch):
    """« Un blip ne déclenche pas le navigateur lourd. »"""
    _x_env(monkeypatch)
    heavy_calls = []

    def heavy(handle):
        heavy_calls.append(handle)
        return "<html/>"

    _run_x(_FetchQueue(), _NotifySpy(), x_fetch=lambda h: "<html/>",
           x_parse=lambda p, h: [], x_stealth=heavy, x_pacer=_XPacer())
    assert heavy_calls == []


def test_deux_anomalies_consecutives_declenchent_l_escalade(monkeypatch):
    _x_env(monkeypatch)
    serial = newswatch._x_serialization_error()

    def broken_parse(page, handle):
        raise serial("la page ne rend plus rien")

    heavy_calls = []

    def heavy(handle):
        heavy_calls.append(handle)
        return "<html>stealth</html>"

    kw = dict(x_fetch=lambda h: "<html/>", x_stealth=heavy, x_pacer=_XPacer())
    _run_x(_FetchQueue(), _NotifySpy(), x_parse=broken_parse, **kw)
    assert heavy_calls == []                    # 1re anomalie : on encaisse
    _run_x(_FetchQueue(), _NotifySpy(), now=NOW + timedelta(minutes=20),
           x_parse=broken_parse, **kw)
    assert heavy_calls == ["elonmusk"]          # 2e : on monte d'un étage


def test_un_refus_franc_escalade_tout_de_suite(monkeypatch):
    """403/429 n'est pas ambigu : inutile d'attendre un second cycle."""
    from backend.bots.harvester.fetch import PushbackError
    _x_env(monkeypatch)
    heavy_calls = []
    pacer = _XPacer()

    def light(handle):
        raise PushbackError("x.com refuse", status=429, retry_after=30)

    def heavy(handle):
        heavy_calls.append(handle)
        return "<html>stealth</html>"

    _run_x(_FetchQueue(), _NotifySpy(), x_fetch=light, x_stealth=heavy,
           x_parse=lambda p, h: [_post("Tariffs announced on imports")],
           x_pacer=pacer)
    assert heavy_calls == ["elonmusk"]
    assert pacer.penalized == [30]              # le pacer encaisse le refus


def test_l_etage_furtif_indisponible_est_une_erreur_propre(monkeypatch):
    """Sur le Mac de développement patchright n'est pas installé : l'étage doit
    être INDISPONIBLE, pas explosif."""
    from backend.bots.harvester.fetch import PushbackError
    _x_env(monkeypatch)

    def light(handle):
        raise PushbackError("x.com refuse", status=403)

    def heavy(handle):
        raise ImportError("patchright n'est pas installé")

    counters = _run_x(_FetchQueue(), _NotifySpy(), x_fetch=light, x_stealth=heavy,
                      x_parse=lambda p, h: [], x_pacer=_XPacer())
    assert counters["errors"] >= 2              # les deux étages ont échoué
    state = newswatch._load_global_seen()
    assert state["x_tiers"] == {}               # on n'inscrit pas un étage mort


def test_le_tier_furtif_est_memorise_puis_re_teste_apres_24h(monkeypatch):
    _x_env(monkeypatch)
    from backend.bots.harvester.fetch import PushbackError
    light_calls, heavy_calls = [], []

    def light(handle):
        light_calls.append(handle)
        raise PushbackError("refus", status=403)

    def heavy(handle):
        heavy_calls.append(handle)
        return "<html>stealth</html>"

    parse = lambda p, h: [_post("Tariffs on imported cars", NOW)]
    kw = dict(x_fetch=light, x_stealth=heavy, x_parse=parse, x_pacer=_XPacer())

    _run_x(_FetchQueue(), _NotifySpy(), **kw)                      # escalade
    assert len(light_calls) == 1 and len(heavy_calls) == 1
    state = newswatch._load_global_seen()
    assert "elonmusk" in state["x_tiers"]

    # Cycle suivant DANS les 24 h : on ne re-paie pas l'échec du léger.
    _run_x(_FetchQueue(), _NotifySpy(), now=NOW + timedelta(minutes=20), **kw)
    assert len(light_calls) == 1 and len(heavy_calls) == 2

    # Après 24 h : on retente le chemin léger.
    _run_x(_FetchQueue(), _NotifySpy(), now=NOW + timedelta(hours=25), **kw)
    assert len(light_calls) == 2


def test_le_pacer_se_detend_quand_x_repond(monkeypatch):
    _x_env(monkeypatch)
    pacer = _XPacer()
    _run_x(_FetchQueue(), _NotifySpy(), x_fetch=lambda h: "<html/>",
           x_parse=lambda p, h: [_post("Tariffs announced")], x_pacer=pacer)
    assert pacer.relaxed == 1 and pacer.penalized == []


def test_le_volet_x_ne_tourne_pas_sans_compte_configure(monkeypatch):
    calls = []
    monkeypatch.setattr(newswatch, "load_x_accounts", lambda: [])
    _run_x(_FetchQueue(), _NotifySpy(), x_fetch=lambda h: calls.append(h) or "",
           x_parse=lambda p, h: [], x_pacer=_XPacer())
    assert calls == []


# =========================================================================== #
#  PUR — détection d'entreprises branchée sur classify_x (26/08 soir)
# =========================================================================== #

def test_un_post_x_qui_nomme_une_entreprise_devient_un_event_symbolise():
    """Le cas décrit par l'utilisateur : ni cashtag, ni mot politique de la
    liste, ni marqueur crypto — et pourtant le post parle très précisément d'un
    titre. Avant, il disparaissait."""
    out = newswatch.classify_x(
        "Nvidia is shipping a lot more chips than anyone expected")
    assert out == {"sentiment": "watch", "symbol": "NVDA"}


def test_une_annonce_politique_qui_nomme_une_entreprise_garde_les_deux():
    """La tonalité reste politique (c'est elle qui allume le facteur ``gov``),
    et le symbole s'ajoute (c'est lui qui la raccroche à la branche du titre)."""
    out = newswatch.classify_x(
        "New tariffs will hit every chip Nvidia sells into China")
    assert out == {"sentiment": "gov", "symbol": "NVDA"}


def test_le_cashtag_prime_sur_l_entreprise_nommee():
    """C'est l'auteur qui dit de quel titre il parle."""
    out = newswatch.classify_x("$AAPL will suffer more than Nvidia here")
    assert out["symbol"] == "AAPL"


def test_une_ancre_de_l_utilisateur_prime_dans_classify_x():
    extra = newswatch.entities.anchor_index(
        [{"symbol": "NVDA.SW", "name": "Nvidia"}])
    out = newswatch.classify_x("Nvidia ships more chips than expected", extra)
    assert out["symbol"] == "NVDA.SW"


def test_un_post_sans_ticker_ni_politique_ni_crypto_disparait_toujours():
    """L'ajout de la détection n'ouvre PAS la porte à tout : « important
    seulement » reste la règle."""
    assert newswatch.classify_x("belle journée, allez au parc") is None


def test_un_conseil_d_achat_nommant_une_entreprise_n_est_toujours_pas_relaye():
    assert newswatch.classify_x("top stocks to buy now: Nvidia and Apple") is None


# =========================================================================== #
#  I/O — le volet politique gagne un symbole quand il nomme une entreprise
# =========================================================================== #

def test_une_annonce_politique_qui_nomme_une_entreprise_porte_son_ticker():
    fetch = _FetchQueue()
    fetch.push(_EMPTY_RSS)
    fetch.push(_EMPTY_RSS)
    _run(fetch, _NotifySpy(), prime_gov=False)          # amorçage silencieux

    later = NOW + timedelta(minutes=5)
    fetch.push(_rss([("US announces tariffs on Nvidia chips",
                      "https://n/nvda", later)]))
    fetch.push(_EMPTY_RSS)
    _run(fetch, _NotifySpy(), now=later, prime_gov=False)

    events = newswatch.recent_events("nobody")
    assert len(events) == 1
    assert events[0]["symbol"] == "NVDA"
    # La TONALITÉ reste politique : c'est elle qui allume le facteur ``gov``.
    assert events[0]["sentiment"] == "gov"


def test_une_annonce_politique_sans_entreprise_garde_le_pseudo_symbole_gov():
    fetch = _FetchQueue()
    fetch.push(_EMPTY_RSS)
    fetch.push(_EMPTY_RSS)
    _run(fetch, _NotifySpy(), prime_gov=False)

    later = NOW + timedelta(minutes=5)
    fetch.push(_rss([("US announces tariffs on imported steel",
                      "https://n/steel", later)]))
    fetch.push(_EMPTY_RSS)
    _run(fetch, _NotifySpy(), now=later, prime_gov=False)

    assert newswatch.recent_events("nobody")[0]["symbol"] == "GOV"


def test_un_titre_detenu_est_reconnu_par_son_nom_de_watchlist():
    """Le nom vient de la watchlist (une position n'en porte pas) et PRIME sur
    la table livrée — le symbole de l'utilisateur est celui qui compte."""
    store.save_portfolio("anchor_user", _portfolio(["SREN.SW"]))
    store.save_watchlist("anchor_user",
                         [{"symbol": "SREN.SW", "name": "Swiss Re AG"}])
    fetch = _FetchQueue()
    fetch.push(_EMPTY_RSS)
    fetch.push(_EMPTY_RSS)
    fetch.push(_EMPTY_RSS)                              # le symbole surveillé
    _run(fetch, _NotifySpy(), prime_gov=False)

    later = NOW + timedelta(minutes=5)
    fetch.push(_rss([("Government announces subsidies for Swiss Re",
                      "https://n/sre", later)]))
    fetch.push(_EMPTY_RSS)
    fetch.push(_EMPTY_RSS)
    _run(fetch, _NotifySpy(), now=later, prime_gov=False)

    events = [e for e in newswatch.recent_events("anchor_user")
              if e.get("sentiment") == "gov"]
    assert events and events[0]["symbol"] == "SREN.SW"


# =========================================================================== #
#  PUR — le compteur de mentions Reddit
# =========================================================================== #

def _stamps(*hours_ago):
    return [(NOW - timedelta(hours=h)).isoformat() for h in hours_ago]


def test_trends_view_separe_les_dernieres_24h_des_24h_d_avant():
    view = newswatch.trends_view({"NVDA": _stamps(1, 5, 23, 30, 47)}, NOW)
    assert view == {"NVDA": {"count": 3, "prev": 2}}


def test_trends_view_omet_un_symbole_dont_plus_personne_ne_parle():
    """« SYM ×0 » n'est pas une tendance : sa seule histoire, c'est qu'il ne se
    passe plus rien."""
    assert newswatch.trends_view({"NVDA": _stamps(30, 40)}, NOW) == {}


def test_trends_view_est_tolerant_a_un_etat_deforme():
    assert newswatch.trends_view(None, NOW) == {}
    assert newswatch.trends_view("cassé", NOW) == {}
    assert newswatch.trends_view({"NVDA": "pas une liste"}, NOW) == {}
    assert newswatch.trends_view({"NVDA": ["pas une date", NOW.isoformat()]},
                                 NOW) == {"NVDA": {"count": 1, "prev": 0}}


def test_purge_trends_jette_les_mentions_de_plus_de_48h():
    trends = {"NVDA": _stamps(1, 60), "AAPL": _stamps(100)}
    newswatch.purge_trends(trends, NOW)
    assert list(trends) == ["NVDA"]
    assert len(trends["NVDA"]) == 1


def test_purge_trends_plafonne_le_nombre_de_tickers_suivis():
    trends = {"SYM%02d" % i: _stamps(*range(i + 1)) for i in range(50)}
    newswatch.purge_trends(trends, NOW)
    assert len(trends) == newswatch.REDDIT_TRENDS_MAX
    # On garde les PLUS mentionnés (SYM49 en tête), pas les premiers venus.
    assert "SYM49" in trends and "SYM00" not in trends


def test_la_cadence_reddit_est_d_un_cycle_sur_trois():
    assert newswatch.reddit_cycle_due(0) is True
    assert newswatch.reddit_cycle_due(1) is False
    assert newswatch.reddit_cycle_due(2) is False
    assert newswatch.reddit_cycle_due(3) is True
    assert newswatch.reddit_cycle_due("cassé") is True   # jamais éteint


# =========================================================================== #
#  I/O — le volet Reddit
# =========================================================================== #

_REDDIT_URL = "https://www.reddit.com/r/stocks/.rss?limit=100"


def _rpost(title, link, ts=None, sub="stocks"):
    return {"title": title, "url": link, "subreddit": sub,
            "published": int((ts or NOW).timestamp())}


def _reddit_env(monkeypatch, posts, url=_REDDIT_URL):
    """Réinstalle un volet Reddit pilotable (la fixture autouse l'éteint) et
    rend la liste des URL réellement demandées."""
    calls = []
    monkeypatch.setattr(newswatch, "_reddit_url", lambda subs=None: url)

    def fetch(target):
        calls.append(target)
        return b"<feed/>"

    monkeypatch.setattr(newswatch, "_fetch_reddit", fetch)
    monkeypatch.setattr(newswatch, "_parse_reddit_posts", lambda raw: list(posts))
    return calls


def _run_reddit(monkeypatch, fetch, notifier, now=NOW, mode="tout", due=True,
                url=_REDDIT_URL, **kw):
    """Un cycle où le volet Reddit tourne à coup sûr (la cadence a son propre
    test — ailleurs elle obligerait à intercaler des cycles blancs).

    ``url`` réinstalle la cible que la fixture autouse avait coupée ; ``url=""``
    rejoue le cas « moteur market-pulse absent »."""
    monkeypatch.setattr(newswatch, "_reddit_url", lambda subs=None: url)
    if due:
        state = newswatch._load_global_seen()
        state["reddit_cycle"] = 0
        newswatch._save_global_seen(state)
    fetch.prime_gov()
    return newswatch.run_once(now=now, fetch=fetch, notifier=notifier,
                              tg_cfg=CFG, sleep=lambda s: None, mode=mode, **kw)


def test_un_post_reddit_portant_un_cashtag_devient_un_event(monkeypatch):
    fetch = _FetchQueue()
    posts = [_rpost("$NVDA is going to the moon", "https://r.test/1")]
    counters = _run_reddit(monkeypatch, fetch, _NotifySpy(),
                           reddit_fetch=lambda url: b"x",
                           reddit_parse=lambda raw: posts)

    events = [e for e in newswatch.recent_events("nobody")
              if e.get("src") == "reddit"]
    assert len(events) == 1
    assert events[0]["symbol"] == "NVDA"
    assert events[0]["sentiment"] == newswatch.REDDIT_SENTIMENT
    assert events[0]["subreddit"] == "stocks"
    assert counters["fetched"] >= 1


def test_un_post_reddit_qui_nomme_une_entreprise_devient_un_event(monkeypatch):
    posts = [_rpost("Nvidia earnings are going to be wild", "https://r.test/1")]
    _run_reddit(monkeypatch, _FetchQueue(), _NotifySpy(), reddit_fetch=lambda url: b"x",
                reddit_parse=lambda raw: posts)
    events = [e for e in newswatch.recent_events("nobody")
              if e.get("src") == "reddit"]
    assert [e["symbol"] for e in events] == ["NVDA"]


def test_un_post_reddit_sans_ticker_reconnaissable_est_ignore(monkeypatch):
    """La foule parle beaucoup ; on ne garde que ce qui désigne un titre."""
    posts = [_rpost("lost my whole account today, AMA", "https://r.test/1")]
    _run_reddit(monkeypatch, _FetchQueue(), _NotifySpy(), reddit_fetch=lambda url: b"x",
                reddit_parse=lambda raw: posts)
    assert [e for e in newswatch.recent_events("nobody")
            if e.get("src") == "reddit"] == []


def test_le_volet_reddit_n_envoie_jamais_rien_meme_en_mode_tout(monkeypatch):
    """La foule est un ACCÉLÉRANT, pas une preuve : elle n'a aucun canal vers le
    téléphone, dans aucun mode. Elle nourrit la convergence, qui décide."""
    posts = [_rpost("$NVDA to the moon", "https://r.test/%d" % i)
             for i in range(10)]
    notifier = _NotifySpy()
    _run_reddit(monkeypatch, _FetchQueue(), notifier, mode="tout",
                reddit_fetch=lambda url: b"x", reddit_parse=lambda raw: posts)
    assert notifier.calls == []
    events = [e for e in newswatch.recent_events("nobody")
              if e.get("src") == "reddit"]
    assert events and all(e["muted"] is True for e in events)


def test_toutes_les_mentions_comptent_mais_les_events_sont_plafonnes(monkeypatch):
    """Un compteur ne coûte qu'un horodatage ; un fil illisible coûte tout le
    reste de la mémoire."""
    posts = [_rpost("$NVDA again", "https://r.test/%d" % i) for i in range(20)]
    _run_reddit(monkeypatch, _FetchQueue(), _NotifySpy(), reddit_fetch=lambda url: b"x",
                reddit_parse=lambda raw: posts)

    events = [e for e in newswatch.recent_events("nobody")
              if e.get("src") == "reddit"]
    assert len(events) == newswatch._REDDIT_MAX_EVENTS_PER_RUN
    assert newswatch.recent_trends(NOW) == {"NVDA": {"count": 20, "prev": 0}}


def test_un_post_reddit_deja_vu_ne_recompte_pas(monkeypatch):
    posts = [_rpost("$NVDA to the moon", "https://r.test/1")]
    kw = dict(reddit_fetch=lambda url: b"x", reddit_parse=lambda raw: posts)
    _run_reddit(monkeypatch, _FetchQueue(), _NotifySpy(), **kw)
    _run_reddit(monkeypatch, _FetchQueue(), _NotifySpy(), now=NOW + timedelta(minutes=15), **kw)
    assert newswatch.recent_trends(NOW)["NVDA"]["count"] == 1


def test_un_post_reddit_trop_vieux_ne_compte_pas(monkeypatch):
    old = NOW - timedelta(days=3)
    posts = [_rpost("$NVDA old news", "https://r.test/1", ts=old),
             _rpost("$AAPL sans date", "https://r.test/2")]
    posts[1].pop("published")
    _run_reddit(monkeypatch, _FetchQueue(), _NotifySpy(), reddit_fetch=lambda url: b"x",
                reddit_parse=lambda raw: posts)
    assert newswatch.recent_trends(NOW) == {}


def test_un_429_de_reddit_compte_une_erreur_et_ne_casse_rien(monkeypatch):
    """Plafond 1 req/60 s : on ne réessaie PAS dans le cycle, on compte et on
    repart au prochain cycle dû."""
    def refuse(url):
        raise RuntimeError("Reddit a répondu 429 (plafond 1 req/60 s)")

    counters = _run_reddit(monkeypatch, _FetchQueue(), _NotifySpy(), reddit_fetch=refuse,
                           reddit_parse=lambda raw: [])
    assert counters["errors"] == 1
    assert counters["users"] == 0                # le reste du cycle a tourné


def test_un_flux_reddit_illisible_compte_une_erreur_et_ne_casse_rien(monkeypatch):
    def boom(raw):
        raise ValueError("XML cassé")

    counters = _run_reddit(monkeypatch, _FetchQueue(), _NotifySpy(),
                           reddit_fetch=lambda url: b"x", reddit_parse=boom)
    assert counters["errors"] == 1


def test_le_volet_reddit_ne_tourne_qu_un_cycle_sur_trois(monkeypatch):
    calls = _reddit_env(monkeypatch, [])
    for index in range(4):
        _run_reddit(monkeypatch, _FetchQueue(), _NotifySpy(), due=(index == 0),
                    now=NOW + timedelta(minutes=5 * index))
    # cycles 0 et 3 -> deux passages seulement.
    assert len(calls) == 2


def test_le_volet_reddit_demande_UNE_seule_url_multireddit(monkeypatch):
    """Plafond MESURÉ 1 req/60 s : jamais un sub à la fois."""
    calls = _reddit_env(monkeypatch, [])
    _run_reddit(monkeypatch, _FetchQueue(), _NotifySpy())
    assert calls == [_REDDIT_URL]


def test_sans_moteur_market_pulse_le_volet_reddit_se_tait(monkeypatch):
    """Moteur absent -> URL vide -> le volet ne tourne pas. Ce n'est PAS une
    erreur : un déploiement sans market-pulse doit garder les autres volets."""
    counters = _run_reddit(monkeypatch, _FetchQueue(), _NotifySpy(), url="",
                           reddit_fetch=lambda url: b"x",
                           reddit_parse=lambda raw: [_rpost("$NVDA",
                                                            "https://r.test/1")])
    assert counters["errors"] == 0
    assert newswatch.recent_trends(NOW) == {}


def test_recent_trends_est_vide_quand_le_guetteur_n_a_jamais_tourne():
    assert newswatch.recent_trends(NOW) == {}


def test_un_compteur_corrompu_sur_le_disque_ne_casse_pas_le_cycle(monkeypatch):
    """Un état déformé doit être NORMALISÉ, pas faire lever le volet : la
    veille entière tomberait avec lui."""
    state = newswatch._load_global_seen()
    state["reddit_trends"] = {"NVDA": "pas une liste", "AAPL": 42}
    newswatch._save_global_seen(state)

    posts = [_rpost("$NVDA to the moon", "https://r.test/1")]
    counters = _run_reddit(monkeypatch, _FetchQueue(), _NotifySpy(),
                           reddit_fetch=lambda url: b"x",
                           reddit_parse=lambda raw: posts)
    assert counters["errors"] == 0
    assert newswatch.recent_trends(NOW) == {"NVDA": {"count": 1, "prev": 0}}


def test_l_url_reddit_reelle_est_bien_un_multireddit():
    """Le pont vers ``pulse.social`` est le seul point de vérité du format."""
    url = _REAL_REDDIT_URL()
    assert url.startswith("https://www.reddit.com/r/")
    assert "+" in url and url.endswith("/.rss?limit=%d" % newswatch.REDDIT_LIMIT)
    for sub in newswatch.REDDIT_SUBS:
        assert sub in url


# =========================================================================== #
#  Convergence ÉVÉNEMENTIELLE (26/08)
# =========================================================================== #

def test_le_cycle_consulte_la_convergence_et_remonte_le_resultat():
    seen = {}

    def converge(now=None, notifier=None, tg_cfg=None):
        seen["now"] = now
        seen["tg_cfg"] = tg_cfg
        return {"fired": True, "sent": True}

    counters = _run(_FetchQueue(), _NotifySpy(), converge=converge)
    assert counters["convergence_fired"] is True
    assert counters["notified"] == 1            # le digest compte comme un envoi
    assert seen["tg_cfg"] == CFG and seen["now"] == NOW


def test_la_convergence_ne_coute_rien_quand_les_facteurs_ne_s_alignent_pas():
    """L'évaluation à chaque cycle de 5 min doit être GRATUITE : tant que
    ``should_fire`` refuse, aucun modèle et aucun réseau."""
    from backend.bots.paper import convergence

    def boom(prompt):
        raise AssertionError("le LLM ne doit pas être appelé")

    counters = _run(_FetchQueue(), _NotifySpy(),
                    converge=lambda **kw: convergence.maybe_fire(llm=boom, **kw))
    assert counters["convergence_fired"] is False


def test_une_convergence_en_panne_ne_casse_pas_le_guetteur():
    def boom(**kwargs):
        raise RuntimeError("convergence cassée")

    counters = _run(_FetchQueue(), _NotifySpy(), converge=boom)
    assert counters["convergence_fired"] is False
    assert counters["errors"] == 1              # comptée, jamais propagée


def test_la_convergence_est_consultee_apres_l_ecriture_des_etats():
    """Elle RELIT les fichiers du guetteur : elle doit voir la matière du cycle
    qui vient de se terminer, pas celle du précédent."""
    store.save_portfolio("alice", _portfolio(["NESN.SW"]))
    fetch = _FetchQueue()
    fetch.push(_rss([("Nestlé issues profit warning", "https://y/neg", NOW)]))
    seen = {}

    def converge(now=None, notifier=None, tg_cfg=None):
        seen["events"] = newswatch.recent_events("alice")
        return {"fired": False, "sent": False}

    _run(fetch, _NotifySpy(), mode="calme", converge=converge)
    assert seen["events"] is not None           # l'état a bien été relu


# =========================================================================== #
#  W2a — le scanner devient MONDIAL
#
#  Trois volets de plus (banques centrales, presse financière mondiale,
#  Bluesky), six subreddits internationaux, et une file de PROBATION qui fait
#  grandir la liste des comptes X depuis le réseau de ce qu'on lit déjà.
# =========================================================================== #

# --- PUR : classify_bc ------------------------------------------------------ #

def test_classify_bc_n_a_pas_de_gate_un_communique_quelconque_passe():
    """C'est LE point du volet : la source décide. Un titre qui ne contient
    aucun mot-clé macro est quand même un communiqué de banque centrale, et
    c'est souvent celui-là qui compte."""
    assert newswatch.classify_bc("Statement by the Board of Governors") == "watch"
    assert newswatch.classify_bc("Speech by Governor Waller") == "watch"
    assert newswatch.classify_bc("Minutes of the March meeting") == "watch"


def test_classify_bc_range_un_resserrement_en_mauvaise_nouvelle():
    """Tonalité du MARCHÉ, comme partout ailleurs dans ce fichier."""
    assert newswatch.classify_bc("Fed raises rates by 50 basis points") == "neg"
    assert newswatch.classify_bc("SNB announces emergency liquidity") == "neg"
    assert newswatch.classify_bc("ECB intervenes in the bond market") == "neg"


def test_classify_bc_range_une_detente_en_bonne_nouvelle():
    assert newswatch.classify_bc("ECB cuts rates by 25 basis points") == "pos"
    assert newswatch.classify_bc("Fed opens a swap line with the SNB") == "pos"


def test_classify_bc_refuse_le_vide_et_le_conseil():
    assert newswatch.classify_bc("") is None
    assert newswatch.classify_bc("Top stocks to buy now, says the Fed") is None


def test_format_bc_dit_que_la_source_est_officielle_et_ne_conseille_jamais():
    message = newswatch.format_bc_message("FOMC statement", "https://f/1",
                                          "watch")
    assert "officielle" in message and "https://f/1" in message
    low = message.lower()
    assert "achet" not in low and "vends" not in low and "buy" not in low


# --- I/O : le volet bc ------------------------------------------------------ #

BC_TITLE = "Federal Reserve issues FOMC statement"
BC_LINK = "https://www.federalreserve.gov/news/1"


def _run_bc(fetch, notifier, now=NOW, mode="tout", due=True, **kw):
    """Un cycle où le volet BANQUES CENTRALES tourne à coup sûr (sa cadence a
    son propre test — ailleurs elle obligerait à intercaler des cycles blancs
    illisibles)."""
    if due:
        state = newswatch._load_global_seen()
        state["bc_cycle"] = 0
        newswatch._save_global_seen(state)
    fetch.prime_gov()
    return newswatch.run_once(now=now, fetch=fetch, notifier=notifier,
                              tg_cfg=CFG, sleep=lambda s: None, mode=mode, **kw)


def test_le_volet_bc_interroge_ses_trois_sources():
    fetch = _FetchQueue()
    _run_bc(fetch, _NotifySpy())
    for url in newswatch._BC_SOURCES:
        assert url in fetch.calls
    assert len(newswatch._BC_SOURCES) == 3


def test_le_volet_bc_amorce_en_silence_puis_notifie():
    fetch = _FetchQueue()
    fetch.push_bc(_rss([(BC_TITLE, BC_LINK, NOW)]))
    notifier = _NotifySpy()
    _run_bc(fetch, notifier)
    assert notifier.calls == []                 # amorçage muet

    later = NOW + timedelta(minutes=10)
    fetch.push_bc(_rss([(BC_TITLE, "https://www.federalreserve.gov/news/2",
                         later)]))
    counters = _run_bc(fetch, notifier, now=later)
    assert counters["notified"] == 1
    assert "officielle" in notifier.calls[0][0]

    events = [e for e in newswatch.recent_events("nobody")
              if e.get("src") == "bc"]
    assert len(events) == 1
    assert events[0]["sentiment"] == "watch" and events[0]["muted"] is False


def test_la_cadence_bc_est_d_un_cycle_sur_trois():
    assert newswatch.cycle_due(0, 3) is True
    assert newswatch.cycle_due(1, 3) is False
    assert newswatch.cycle_due(2, 3) is False
    assert newswatch.cycle_due(3, 3) is True
    assert newswatch.cycle_due("cassé", 3) is True     # jamais éteint
    assert newswatch.cycle_due(7, 1) is True           # période 1 = chaque cycle
    assert newswatch.cycle_due(7, None) is True


def test_le_volet_bc_saute_les_cycles_qui_ne_sont_pas_dus():
    """Une banque centrale ne publie pas toutes les cinq minutes : on ne va pas
    frapper trois serveurs institutionnels 288 fois par jour."""
    fetch = _FetchQueue()
    _run_bc(fetch, _NotifySpy())                       # cycle 0 : dû
    assert fetch.calls.count(newswatch._BC_SOURCES[0]) == 1

    for minutes in (5, 10):
        _run_bc(fetch, _NotifySpy(), now=NOW + timedelta(minutes=minutes),
                due=False)                             # cycles 1 et 2 : sautés
    assert fetch.calls.count(newswatch._BC_SOURCES[0]) == 1

    _run_bc(fetch, _NotifySpy(), now=NOW + timedelta(minutes=15), due=False)
    assert fetch.calls.count(newswatch._BC_SOURCES[0]) == 2   # cycle 3 : dû


def test_le_budget_bc_est_distinct_de_celui_des_autres_volets():
    """Un volet neuf ne doit jamais manger la parole d'un volet existant."""
    state = newswatch._load_global_seen()
    assert state["bc_sent_log"] == []
    assert "bc_sent_log" in newswatch._default_seen_state()
    for spec in newswatch.WORLD_VOLETS:
        if spec["src"] == "bc":
            assert spec["sent_log"] == "bc_sent_log"
            assert spec["max_per_hour"] == newswatch._BC_MAX_SENDS_PER_HOUR
            break
    else:                                              # pragma: no cover
        raise AssertionError("la fiche bc a disparu de WORLD_VOLETS")


def test_le_volet_bc_plafonne_ce_qu_il_journalise_en_un_passage():
    """Il n'a pas de gate : sans plafond, trois flux institutionnels relus
    après une purge de l'état « vu » rempliraient à eux seuls l'historique et
    en chasseraient tout le reste."""
    fetch = _FetchQueue()
    fetch.push_bc(_rss([("Seed", "https://f/seed", NOW)]))
    _run_bc(fetch, _NotifySpy())

    later = NOW + timedelta(minutes=10)
    fetch.push_bc(_rss([("Statement number %d" % i, "https://f/s%d" % i, later)
                        for i in range(20)]))
    _run_bc(fetch, _NotifySpy(), now=later)

    events = [e for e in newswatch.recent_events("nobody")
              if e.get("src") == "bc"]
    assert len(events) == newswatch._BC_MAX_EVENTS_PER_RUN


def test_les_volets_eco_et_climat_n_ont_PAS_de_plafond_d_evenements():
    """Leur classifieur a un gate — il jette déjà la plus grande partie de ce
    que Google News rend. Un plafond de plus les ferait taire sans raison."""
    for spec in newswatch.WORLD_VOLETS:
        if spec["src"] in ("eco", "climat"):
            assert spec.get("max_events") is None


def test_mode_calme_le_volet_bc_n_envoie_rien_mais_journalise():
    fetch = _FetchQueue()
    fetch.push_bc(_rss([("Seed", "https://f/seed", NOW)]))
    _run_bc(fetch, _NotifySpy())                       # amorçage

    later = NOW + timedelta(minutes=10)
    fetch.push_bc(_rss([(BC_TITLE, BC_LINK, later)]))
    notifier = _NotifySpy()
    _run_bc(fetch, notifier, now=later, mode="calme")

    assert notifier.calls == []
    events = [e for e in newswatch.recent_events("nobody")
              if e.get("src") == "bc"]
    assert len(events) == 1 and events[0]["muted"] is True


def test_un_etat_ecrit_avant_les_volets_mondiaux_ne_plante_pas(tmp_path):
    """Un état d'AVANT W2a n'a ni les budgets ni les cadences des trois
    nouveaux volets : il doit repartir de zéro, pas planter."""
    path = store.DATA_DIR / "newswatch_global.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"seen": {}, "events": [], "seeded": {}}),
                    encoding="utf-8")
    state = newswatch._load_global_seen()
    for key in ("bc_sent_log", "pressefi_sent_log", "bsky_sent_log"):
        assert state[key] == []
    for key in ("bc_cycle", "pressefi_cycle", "bsky_cycle", "x_cand_cycle"):
        assert state[key] == 0
    assert state["x_candidates"] == {}
    counters = _run_bc(_FetchQueue(), _NotifySpy())
    assert counters["errors"] == 0


# --- I/O : le volet presse financière MONDIALE ------------------------------ #

_PF_URL = "https://feeds.bbci.co.uk/news/business/rss.xml"
_PF_FEED = {"name": "BBC Business", "lang": "en", "url": _PF_URL}
_PF_DE_URL = "https://www.nzz.ch/wirtschaft.rss"
_PF_DE_FEED = {"name": "NZZ Wirtschaft", "lang": "de", "url": _PF_DE_URL}


def _pressefi_env(monkeypatch, feeds=(_PF_FEED,)):
    """Rallume le volet presse (la fixture autouse l'éteint) avec une liste de
    flux courte — dont les URL sont de VRAIES URL du catalogue, pour que
    ``_FetchQueue`` les route vers la file dédiée."""
    monkeypatch.setattr(newswatch, "pressefi_feeds",
                        lambda: [dict(feed) for feed in feeds])


def _run_pressefi(fetch, notifier, now=NOW, mode="tout", due=True, **kw):
    if due:
        state = newswatch._load_global_seen()
        state["pressefi_cycle"] = 0
        newswatch._save_global_seen(state)
    fetch.prime_gov()
    return newswatch.run_once(now=now, fetch=fetch, notifier=notifier,
                              tg_cfg=CFG, sleep=lambda s: None, mode=mode, **kw)


def test_format_pressefi_nomme_le_journal_et_ne_conseille_jamais():
    message = newswatch.format_pressefi_message(
        "SCMP Business", "Tencent beats estimates", "https://scmp/1", "pos",
        "0700.HK")
    assert "SCMP Business" in message and "0700.HK" in message
    low = message.lower()
    assert "achet" not in low and "vends" not in low and "buy" not in low
    # Source absente -> un repli lisible, jamais une parenthèse vide.
    assert "(presse)" in newswatch.format_pressefi_message(
        "", "un titre", "https://x/1", "neg")


def test_la_cascade_de_market_pulse_est_REUTILISEE_pas_reecrite(monkeypatch):
    """Le point le plus important de ce volet : la collecte n'est pas réécrite.

    On patche ``collect_news`` DANS le moteur — si le volet avait sa propre
    boucle, ce patch ne changerait rien et l'assertion tomberait."""
    _pressefi_env(monkeypatch)
    engine = newswatch._news_module()
    seen = []
    monkeypatch.setattr(engine, "collect_news",
                        lambda **kw: seen.append(kw) or {"items": [],
                                                         "sources_ok": ["BBC"]})
    _run_pressefi(_FetchQueue(), _NotifySpy())
    assert len(seen) == 1
    assert [f["url"] for f in seen[0]["feeds"]] == [_PF_URL]
    # Les garde-fous de la cascade sont PASSÉS, pas devinés : fraîcheur bornée,
    # partage équitable par source, horloge injectée.
    assert seen[0]["max_age_h"] == newswatch._PRESSEFI_MAX_AGE_H
    assert seen[0]["per_source"] == newswatch._PRESSEFI_PER_SOURCE
    assert seen[0]["now_ts"] == int(NOW.timestamp())
    assert callable(seen[0]["fetch"]) and callable(seen[0]["sleep"])


def test_le_volet_pressefi_amorce_en_silence_puis_journalise(monkeypatch):
    _pressefi_env(monkeypatch)
    fetch = _FetchQueue()
    fetch.push_pressefi(_rss([("Nestlé beats estimates", "https://bbc/1", NOW)]))
    notifier = _NotifySpy()
    _run_pressefi(fetch, notifier)
    assert notifier.calls == []                 # amorçage muet

    later = NOW + timedelta(minutes=10)
    fetch.push_pressefi(_rss([("Nestlé beats estimates", "https://bbc/2",
                               later)]))
    _run_pressefi(fetch, notifier, now=later)
    events = [e for e in newswatch.recent_events("nobody")
              if e.get("src") == "pressefi"]
    assert len(events) == 1
    assert events[0]["symbol"] == "NESN.SW"     # entities, langue indépendante
    assert events[0]["sentiment"] == "pos"
    assert events[0]["source"] == "BBC Business"
    # Une dépêche À TONALITÉ, elle, a bien le droit de parler (mode « tout »),
    # et le message NOMME LE JOURNAL — sur ce volet, savoir d'où ça vient est la
    # moitié de l'information.
    assert len(notifier.calls) == 1
    assert "NESN.SW" in notifier.calls[0][0]
    assert "BBC Business" in notifier.calls[0][0]
    assert events[0]["muted"] is False


def test_un_titre_de_presse_ALLEMAND_est_symbolise_meme_sans_tonalite(monkeypatch):
    """``entities`` ne lit pas la langue, il lit les NOMS : « Nestlé kündigt »
    donne NESN.SW. ``classify``, lui, est calibré EN/FR/IT — il ne tranche pas,
    et le titre entre en ``neutral`` plutôt qu'avec une couleur inventée."""
    _pressefi_env(monkeypatch, feeds=(_PF_DE_FEED,))
    fetch = _FetchQueue()
    fetch.push_pressefi(_rss([("Seed", "https://nzz/seed", NOW)]))
    _run_pressefi(fetch, _NotifySpy())

    later = NOW + timedelta(minutes=10)
    fetch.push_pressefi(_rss([
        ("Nestlé kündigt Milliarden-Rückkauf an", "https://nzz/1", later)]))
    notifier = _NotifySpy()
    _run_pressefi(fetch, notifier, now=later)

    events = [e for e in newswatch.recent_events("nobody")
              if e.get("src") == "pressefi"]
    assert len(events) == 1
    assert events[0]["symbol"] == "NESN.SW"
    assert events[0]["sentiment"] == newswatch.NEUTRAL_SENTIMENT
    assert events[0]["lang"] == "de"
    # Un titre neutre n'est JAMAIS envoyé, dans aucun mode.
    assert notifier.calls == []
    assert events[0]["muted"] is True


def test_les_titres_neutres_de_presse_sont_plafonnes_par_symbole(monkeypatch):
    """Sans ce plafond, du bruit de fond repousserait les vraies dépêches hors
    de l'historique.

    Il faut plusieurs passages pour l'atteindre : la cascade ne rend au plus que
    ``_PRESSEFI_PER_SOURCE`` titres par source et par appel — c'est
    déjà une première digue, celle-ci est la seconde."""
    _pressefi_env(monkeypatch, feeds=(_PF_DE_FEED,))
    fetch = _FetchQueue()
    fetch.push_pressefi(_rss([("Seed", "https://nzz/seed", NOW)]))
    _run_pressefi(fetch, _NotifySpy())

    written = 0
    for step in range(1, 4):
        when = NOW + timedelta(minutes=10 * step)
        fetch.push_pressefi(_rss([
            ("Nestlé Nachricht Nummer %d" % (written + i),
             "https://nzz/n%d" % (written + i), when)
            for i in range(newswatch._PRESSEFI_PER_SOURCE)]))
        written += newswatch._PRESSEFI_PER_SOURCE
        _run_pressefi(fetch, _NotifySpy(), now=when)

    assert written > newswatch._MAX_NEUTRAL_PER_SYMBOL      # le cap a servi
    events = [e for e in newswatch.recent_events("nobody")
              if e.get("src") == "pressefi"]
    assert len(events) == newswatch._MAX_NEUTRAL_PER_SYMBOL


def test_la_cadence_pressefi_est_d_un_cycle_sur_six(monkeypatch):
    _pressefi_env(monkeypatch)
    fetch = _FetchQueue()
    _run_pressefi(fetch, _NotifySpy())                 # cycle 0 : dû
    assert fetch.calls.count(_PF_URL) == 1
    for minutes in range(5, 30, 5):                    # cycles 1..5 : sautés
        _run_pressefi(fetch, _NotifySpy(), now=NOW + timedelta(minutes=minutes),
                      due=False)
    assert fetch.calls.count(_PF_URL) == 1
    _run_pressefi(fetch, _NotifySpy(), now=NOW + timedelta(minutes=30),
                  due=False)
    assert fetch.calls.count(_PF_URL) == 2             # cycle 6 : dû


def test_mode_calme_le_volet_pressefi_n_envoie_rien(monkeypatch):
    _pressefi_env(monkeypatch)
    fetch = _FetchQueue()
    fetch.push_pressefi(_rss([("Seed", "https://bbc/seed", NOW)]))
    _run_pressefi(fetch, _NotifySpy())

    later = NOW + timedelta(minutes=10)
    fetch.push_pressefi(_rss([("Nestlé beats estimates", "https://bbc/2",
                               later)]))
    notifier = _NotifySpy()
    _run_pressefi(fetch, notifier, now=later, mode="calme")
    assert notifier.calls == []
    events = [e for e in newswatch.recent_events("nobody")
              if e.get("src") == "pressefi"]
    assert len(events) == 1 and events[0]["muted"] is True


def test_le_budget_pressefi_est_le_sien_et_le_plus_serre(monkeypatch):
    state = newswatch._load_global_seen()
    assert state["pressefi_sent_log"] == []
    assert (newswatch._PRESSEFI_MAX_SENDS_PER_HOUR
            < newswatch._GOV_MAX_SENDS_PER_HOUR)


def test_une_source_de_presse_en_panne_compte_une_erreur_sans_bloquer(monkeypatch):
    _pressefi_env(monkeypatch, feeds=(_PF_FEED, _PF_DE_FEED))
    fetch = _FetchQueue()
    fetch.push_pressefi(RuntimeError("boom"))
    fetch.push_pressefi(_rss([("Nestlé beats estimates", "https://nzz/1", NOW)]))
    counters = _run_pressefi(fetch, _NotifySpy())
    assert counters["errors"] == 1
    assert counters["fetched"] >= 1


def test_le_flux_de_la_bce_n_est_pas_servi_par_deux_volets():
    """La source OFFICIELLE a la priorité : le flux de la BCE appartient au
    volet « banques centrales », pas à la revue de presse. Sans cette
    exclusion, le même communiqué finirait tantôt « source officielle », tantôt
    « presse », selon le volet qui a tourné le premier."""
    urls = {feed["url"] for feed in _REAL_PRESSEFI_FEEDS()}
    assert not urls.intersection(newswatch._BC_SOURCES)
    # …et les flux sondés (26/08 puis 27/08 pour la presse US, D8) sont tous là.
    for feed in newswatch.PRESSEFI_EXTRA_FEEDS:
        assert feed["url"] in urls
    assert len(urls) > len(newswatch.PRESSEFI_EXTRA_FEEDS)   # + ceux du moteur


# --- presse US directe (D8) ------------------------------------------------- #

_US_FEED_NAMES = ("Bloomberg Markets", "CNBC Markets", "CNBC Top", "NYT Business")


def test_d8_the_four_us_feeds_are_registered_in_english():
    by_name = {feed["name"]: feed for feed in newswatch.PRESSEFI_EXTRA_FEEDS}
    for name in _US_FEED_NAMES:
        assert name in by_name, name
        assert by_name[name]["lang"] == "en"
        assert by_name[name]["url"].startswith("https://")


def test_d8_us_feeds_urls_are_the_exact_ones_specified():
    by_name = {feed["name"]: feed["url"] for feed in newswatch.PRESSEFI_EXTRA_FEEDS}
    assert by_name["Bloomberg Markets"] == "https://feeds.bloomberg.com/markets/news.rss"
    assert by_name["CNBC Markets"] == (
        "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000664")
    assert by_name["CNBC Top"] == "https://www.cnbc.com/id/100003114/device/rss/rss.html"
    assert by_name["NYT Business"] == "https://rss.nytimes.com/services/xml/rss/nyt/Business.xml"


def test_d8_wsj_is_deliberately_not_included():
    """Flux sondés ZOMBIES le 27/08 (rien de frais depuis janvier 2025) --
    voir le commentaire à côté de ``PRESSEFI_EXTRA_FEEDS``."""
    names = " ".join(feed["name"].lower() for feed in newswatch.PRESSEFI_EXTRA_FEEDS)
    urls = " ".join(feed["url"].lower() for feed in newswatch.PRESSEFI_EXTRA_FEEDS)
    assert "wsj" not in names and "wsj" not in urls
    assert "dowjones" not in urls and "dj.com" not in urls


def test_d8_bloomberg_item_is_collected_symbolised_and_classified(monkeypatch):
    """Fixture RSS réaliste (2 items, forme réelle) sur le flux Bloomberg --
    la MÊME cascade que les flux existants s'applique : fraîcheur, parsing,
    symbolisation, tonalité."""
    feed = {"name": "Bloomberg Markets", "lang": "en",
           "url": "https://feeds.bloomberg.com/markets/news.rss"}
    _pressefi_env(monkeypatch, feeds=(feed,))
    fetch = _FetchQueue()
    fetch.push_pressefi(_rss([("Seed", "https://bloomberg/seed", NOW)]))
    _run_pressefi(fetch, _NotifySpy())          # amorçage muet

    later = NOW + timedelta(minutes=10)
    fetch.push_pressefi(_rss([
        ("Nestle beats estimates on strong pet-care sales",
         "https://www.bloomberg.com/news/articles/1", later),
        ("Oil prices slide as OPEC weighs output hike",
         "https://www.bloomberg.com/news/articles/2", later),
    ]))
    notifier = _NotifySpy()
    _run_pressefi(fetch, notifier, now=later)

    events = [e for e in newswatch.recent_events("nobody") if e.get("src") == "pressefi"]
    assert len(events) == 2
    assert events[0]["source"] == "Bloomberg Markets"
    assert events[0]["lang"] == "en"
    nestle = next(e for e in events if e["symbol"] == "NESN.SW")
    assert nestle["sentiment"] == "pos"


def test_d8_us_feeds_filter_investment_advice_like_the_others(monkeypatch):
    """Preuve explicite de la demande A1/D8 : « les fils US charrient du
    conseil d'achat » -- le titre est écarté (jamais envoyé), pas relayé."""
    feed = {"name": "CNBC Top", "lang": "en",
           "url": "https://www.cnbc.com/id/100003114/device/rss/rss.html"}
    _pressefi_env(monkeypatch, feeds=(feed,))
    fetch = _FetchQueue()
    fetch.push_pressefi(_rss([("Seed", "https://cnbc/seed", NOW)]))
    _run_pressefi(fetch, _NotifySpy())

    later = NOW + timedelta(minutes=10)
    fetch.push_pressefi(_rss([
        ("3 stocks to buy right now as rates fall", "https://cnbc/advice", later)]))
    notifier = _NotifySpy()
    _run_pressefi(fetch, notifier, now=later)

    assert notifier.calls == []
    events = [e for e in newswatch.recent_events("nobody") if e.get("src") == "pressefi"]
    assert events == []       # la cascade l'a déjà écarté -- rien à journaliser


def test_d8_us_feeds_share_the_same_budget_as_the_rest_of_pressefi(monkeypatch):
    """Aucun budget dédié : les flux US passent par le MÊME appel de cascade
    que les flux existants, donc par les mêmes ``max_age_h``/``per_source``/
    ``max_items`` (déjà vérifiés par
    test_la_cascade_de_market_pulse_est_REUTILISEE_pas_reecrite)."""
    feeds = (
        {"name": "Bloomberg Markets", "lang": "en",
         "url": "https://feeds.bloomberg.com/markets/news.rss"},
        {"name": "NYT Business", "lang": "en",
         "url": "https://rss.nytimes.com/services/xml/rss/nyt/Business.xml"},
    )
    _pressefi_env(monkeypatch, feeds=feeds)
    engine = newswatch._news_module()
    seen = []
    monkeypatch.setattr(engine, "collect_news",
                        lambda **kw: seen.append(kw) or {"items": [], "sources_ok": []})
    _run_pressefi(_FetchQueue(), _NotifySpy())
    assert len(seen) == 1
    assert seen[0]["max_age_h"] == newswatch._PRESSEFI_MAX_AGE_H
    assert seen[0]["per_source"] == newswatch._PRESSEFI_PER_SOURCE
    assert [f["url"] for f in seen[0]["feeds"]] == [f["url"] for f in feeds]


# --- PUR : les requêtes Bluesky --------------------------------------------- #

def test_les_requetes_bluesky_ont_toujours_au_moins_deux_mots():
    """Leçon #68k : une requête d'un seul mot courant est presque toujours un
    piège (« nikkei » ramenait un collectif militant)."""
    queries = newswatch.bsky_queries({"nestle": "NESN.SW"})
    assert all(len(q.split()) >= 2 for q in queries)
    assert "nestle stock" in queries


def test_les_requetes_bluesky_partent_des_deux_fixes_puis_des_ancres():
    assert newswatch.bsky_queries(None) == list(newswatch.BSKY_FIXED_QUERIES)
    queries = newswatch.bsky_queries({"general motors": "GM"})
    assert queries[:2] == list(newswatch.BSKY_FIXED_QUERIES)
    assert queries[2] == "general motors"       # déjà deux mots : intact


def test_les_requetes_d_ancre_sont_plafonnees_et_deterministes():
    anchors = {"nestle": "NESN.SW", "roche": "ROG.SW", "novartis": "NOVN.SW",
               "apple": "AAPL", "tesla": "TSLA", "boeing": "BA"}
    first = newswatch.bsky_queries(anchors)
    assert first == newswatch.bsky_queries(anchors)     # deux appels, même liste
    extra = len(first) - len(newswatch.BSKY_FIXED_QUERIES)
    assert extra == newswatch.BSKY_MAX_ANCHOR_QUERIES


def test_le_TICKER_ne_doit_JAMAIS_gagner_contre_le_nom_de_la_marque():
    """Défaut trouvé au premier essai à blanc : « nesn.sw » fait sept
    caractères, « nestle » six — en prenant le nom le plus LONG, on interrogeait
    Bluesky sur « nesn.sw stock », qui ne ramène rien. Le ticker est un dernier
    recours, jamais un choix."""
    queries = newswatch.bsky_queries({"nestle": "NESN.SW",
                                      "nesn.sw": "NESN.SW"})
    assert "nestle stock" in queries and "nesn.sw stock" not in queries


def test_entre_deux_vrais_noms_c_est_la_MARQUE_qui_gagne():
    """« apple » trouve ce que « apple inc. » manque."""
    anchors = {"apple inc.": "AAPL", "apple": "AAPL", "aapl": "AAPL"}
    assert "apple stock" in newswatch.bsky_queries(anchors)


def test_un_ticker_reste_utilisable_quand_aucun_nom_n_est_connu():
    """Une POSITION ne porte pas de nom (``models.Position`` n'a que le
    symbole) : sans ce repli, un titre détenu mais absent de la watchlist ne
    serait jamais écouté."""
    assert "nesn.sw stock" in newswatch.bsky_queries({"nesn.sw": "NESN.SW"})


def test_le_nom_retenu_ne_depend_pas_de_l_ordre_du_dictionnaire():
    a = newswatch.bsky_queries({"general motors": "GM", "gm holding": "GM"})
    b = newswatch.bsky_queries({"gm holding": "GM", "general motors": "GM"})
    assert a == b


def test_une_requete_fixe_d_un_seul_mot_est_refusee_pas_rafistolee():
    assert newswatch.bsky_queries(None, fixed=("borsa",)) == []


# --- PUR : classify_social --------------------------------------------------- #

def test_classify_social_garde_les_quatre_portes_de_classify_x():
    assert newswatch.classify_social("$NVDA is ripping")["symbol"] == "NVDA"
    assert newswatch.classify_social(
        "New tariffs on imported steel")["sentiment"] == "gov"


def test_classify_social_ouvre_la_porte_MACRO_que_classify_x_n_a_pas():
    """Sans elle, les deux requêtes génériques du volet ne rendraient jamais
    rien : « the Fed cuts rates » ne porte ni cashtag, ni mot politique, ni
    marqueur crypto, ni nom d'entreprise."""
    text = "The Fed cuts rates by 50 basis points, inflation cools"
    assert newswatch.classify_x(text) is None           # la porte manquait
    assert newswatch.classify_social(text)["sentiment"] == "pos"


def test_classify_social_ouvre_aussi_la_porte_CLIMAT():
    text = "Drought destroys wheat crops and lifts prices"
    assert newswatch.classify_social(text)["sentiment"] == "neg"


def test_classify_social_jette_toujours_le_bavardage():
    assert newswatch.classify_social("gm everyone, coffee time") is None
    assert newswatch.classify_social("") is None


# --- I/O : le volet Bluesky -------------------------------------------------- #

def _bpost(text, link, ts=None, author="analyst.bsky.social"):
    return {"title": text, "url": link, "author": author,
            "published": int((ts or NOW).timestamp())}


def _bsky_env(monkeypatch):
    """Rallume le volet Bluesky (la fixture autouse l'éteint) et rend la liste
    des requêtes réellement demandées."""
    asked = []

    def urls(queries):
        asked.extend(queries)
        return [(q, "https://bsky.test/search?q=%s" % q.replace(" ", "+"))
                for q in queries]

    monkeypatch.setattr(newswatch, "_bsky_urls", urls)
    return asked


def _run_bsky(fetch, notifier, now=NOW, mode="tout", due=True, **kw):
    if due:
        state = newswatch._load_global_seen()
        state["bsky_cycle"] = 0
        newswatch._save_global_seen(state)
    fetch.prime_gov()
    return newswatch.run_once(now=now, fetch=fetch, notifier=notifier,
                              tg_cfg=CFG, sleep=lambda s: None, mode=mode, **kw)


def test_le_volet_bsky_amorce_en_silence_puis_notifie(monkeypatch):
    asked = _bsky_env(monkeypatch)
    posts = [_bpost("$NVDA guidance raised, stock surges",
                    "https://bsky.app/p/1")]
    kw = dict(bsky_fetch=lambda url: b"{}", bsky_parse=lambda raw: list(posts))

    notifier = _NotifySpy()
    _run_bsky(_FetchQueue(), notifier, **kw)
    assert notifier.calls == []                 # amorçage muet
    assert asked[:2] == list(newswatch.BSKY_FIXED_QUERIES)

    later = NOW + timedelta(minutes=10)
    posts[:] = [_bpost("$NVDA raises guidance again", "https://bsky.app/p/2",
                       later)]
    counters = _run_bsky(_FetchQueue(), notifier, now=later, **kw)
    assert counters["notified"] == 1
    assert "Bluesky" in notifier.calls[0][0]

    events = [e for e in newswatch.recent_events("nobody")
              if e.get("src") == "bsky"]
    assert len(events) == 1
    assert events[0]["symbol"] == "NVDA"
    assert events[0]["handle"] == "analyst.bsky.social"
    assert events[0]["query"] in newswatch.BSKY_FIXED_QUERIES


def test_le_volet_bsky_interroge_les_ancres_du_portefeuille(monkeypatch):
    store.save_portfolio("alice", _portfolio(["NESN.SW"]))
    _write_watchlist("alice", ["NESN.SW"])
    asked = _bsky_env(monkeypatch)
    fetch = _FetchQueue()
    fetch.push(_EMPTY_RSS)                      # le volet par symbole d'alice
    _run_bsky(fetch, _NotifySpy(), bsky_fetch=lambda url: b"{}",
              bsky_parse=lambda raw: [])
    assert any("nesn.sw" in q for q in asked)


def test_le_volet_bsky_se_tait_en_mode_calme_mais_journalise(monkeypatch):
    _bsky_env(monkeypatch)
    posts = [_bpost("Seed post about $NVDA", "https://bsky.app/p/seed")]
    kw = dict(bsky_fetch=lambda url: b"{}", bsky_parse=lambda raw: list(posts))
    _run_bsky(_FetchQueue(), _NotifySpy(), **kw)          # amorçage

    later = NOW + timedelta(minutes=10)
    posts[:] = [_bpost("$NVDA beats estimates", "https://bsky.app/p/2", later)]
    notifier = _NotifySpy()
    _run_bsky(_FetchQueue(), notifier, now=later, mode="calme", **kw)
    assert notifier.calls == []
    events = [e for e in newswatch.recent_events("nobody")
              if e.get("src") == "bsky"]
    assert len(events) == 1 and events[0]["muted"] is True


def test_un_post_bluesky_trop_vieux_est_ignore(monkeypatch):
    _bsky_env(monkeypatch)
    posts = [_bpost("Seed", "https://bsky.app/p/seed")]
    kw = dict(bsky_fetch=lambda url: b"{}", bsky_parse=lambda raw: list(posts))
    _run_bsky(_FetchQueue(), _NotifySpy(), **kw)

    later = NOW + timedelta(minutes=10)
    posts[:] = [_bpost("$NVDA beats estimates", "https://bsky.app/p/old",
                       later - timedelta(hours=30))]
    _run_bsky(_FetchQueue(), _NotifySpy(), now=later, **kw)
    assert [e for e in newswatch.recent_events("nobody")
            if e.get("src") == "bsky"] == []


def test_la_cadence_bsky_est_d_un_cycle_sur_trois(monkeypatch):
    asked = _bsky_env(monkeypatch)
    kw = dict(bsky_fetch=lambda url: b"{}", bsky_parse=lambda raw: [])
    _run_bsky(_FetchQueue(), _NotifySpy(), **kw)          # cycle 0 : dû
    assert len(asked) == 2
    for minutes in (5, 10):
        _run_bsky(_FetchQueue(), _NotifySpy(), now=NOW + timedelta(minutes=minutes),
                  due=False, **kw)
    assert len(asked) == 2                                 # cycles 1 et 2 sautés
    _run_bsky(_FetchQueue(), _NotifySpy(), now=NOW + timedelta(minutes=15),
              due=False, **kw)
    assert len(asked) == 4                                 # cycle 3 : dû


def test_une_recherche_bluesky_en_panne_ne_bloque_pas_les_autres(monkeypatch):
    _bsky_env(monkeypatch)
    calls = []

    def fetch(url):
        calls.append(url)
        if len(calls) == 1:
            raise RuntimeError("boom")
        return b"{}"

    counters = _run_bsky(_FetchQueue(), _NotifySpy(), bsky_fetch=fetch,
                         bsky_parse=lambda raw: [])
    assert len(calls) == 2 and counters["errors"] == 1


def test_sans_moteur_market_pulse_le_volet_bsky_se_tait(monkeypatch):
    """La fixture autouse rend déjà ``_bsky_urls`` vide — c'est exactement le
    cas « moteur absent ». On vérifie qu'il ne coûte RIEN."""
    called = []
    counters = _run_bsky(_FetchQueue(), _NotifySpy(),
                         bsky_fetch=lambda url: called.append(url) or b"{}",
                         bsky_parse=lambda raw: [])
    assert called == [] and counters["errors"] == 0


def test_le_budget_bsky_est_le_sien():
    state = newswatch._load_global_seen()
    assert state["bsky_sent_log"] == []
    assert newswatch._BSKY_MAX_SENDS_PER_HOUR > 0


# --- Reddit : la foule n'est pas qu'américaine ------------------------------ #

def test_les_subs_reddit_couvrent_le_monde_en_DEUX_groupes():
    """La couverture mondiale reste (correctif 27/08), mais en deux groupes
    interrogés en alternance : un multireddit de dix subs tombe entièrement dès
    qu'un seul d'entre eux est en quarantaine — mesuré, 403 depuis l'Omen."""
    for sub in ("mauerstrassenwetten", "UKInvesting", "ASX_Bets",
                "CanadianInvestor", "eupersonalfinance"):
        assert sub in newswatch.REDDIT_INTL
    assert newswatch.REDDIT_SUBS == newswatch.REDDIT_CORE + newswatch.REDDIT_INTL
    for group in newswatch.REDDIT_GROUPS:
        assert _REAL_REDDIT_URL(group).count("https://") == 1   # UNE requête


# --- PUR : les @mentions et la file de probation ----------------------------- #

def test_extract_mentions_lit_les_comptes_cites():
    assert newswatch.extract_mentions(
        "big call from @zerohedge and @DeItaone today") == ["zerohedge",
                                                            "DeItaone"]


def test_extract_mentions_dedoublonne_sans_tenir_compte_de_la_casse():
    assert newswatch.extract_mentions("@Elon @elon @ELON") == ["Elon"]


def test_extract_mentions_ne_prend_pas_une_adresse_email_pour_un_compte():
    assert newswatch.extract_mentions("write to john@example.com") == []


def test_extract_mentions_JETTE_un_jeton_trop_long_au_lieu_de_le_tronquer():
    """Un ``{1,15}`` suivi d'une garde de fin de mot backtracke : il finirait
    par accepter les quatorze premiers caractères, c'est-à-dire un compte qui
    n'existe pas."""
    assert newswatch.extract_mentions("@abcdefghijklmnopqrst") == []
    assert newswatch.extract_mentions("@abcdefghijklmno") == ["abcdefghijklmno"]


def test_note_mentions_inscrit_un_compte_inconnu():
    candidates = {}
    added = newswatch.note_mentions(candidates, ["zerohedge"], "2026-08-26T12:00:00")
    assert added == ["zerohedge"]
    assert candidates["zerohedge"] == {"first_seen": "2026-08-26T12:00:00",
                                       "polls": 0, "hits": 0}


def test_note_mentions_ignore_un_compte_deja_suivi():
    candidates = {}
    assert newswatch.note_mentions(candidates, ["ElonMusk"], "t",
                                   known=["elonmusk"]) == []
    assert candidates == {}


def test_note_mentions_ne_remet_pas_un_candidat_a_zero():
    """Sinon un compte cité tous les jours ne serait jamais ni promu ni
    éjecté."""
    candidates = {"zerohedge": {"first_seen": "t0", "polls": 4, "hits": 1}}
    assert newswatch.note_mentions(candidates, ["zerohedge"], "t1") == []
    assert candidates["zerohedge"]["polls"] == 4


def test_note_mentions_respecte_le_plafond_de_la_file():
    candidates = {}
    newswatch.note_mentions(candidates, ["u%d" % i for i in range(20)], "t")
    assert len(candidates) == newswatch.X_CANDIDATE_MAX


def test_le_verdict_promeut_a_deux_preuves_et_ejecte_apres_six_silences():
    assert newswatch.candidate_verdict({"polls": 2, "hits": 2}) == "promote"
    assert newswatch.candidate_verdict({"polls": 6, "hits": 0}) == "evict"
    assert newswatch.candidate_verdict({"polls": 5, "hits": 0}) == "keep"
    # Un compte LENT (une preuve, pas deux) n'est pas un mauvais compte.
    assert newswatch.candidate_verdict({"polls": 9, "hits": 1}) == "keep"
    assert newswatch.candidate_verdict("cassé") == "keep"


def test_promote_candidates_sort_les_promus_et_les_ejectes_de_la_file():
    candidates = {"good": {"polls": 3, "hits": 2},
                  "mute": {"polls": 6, "hits": 0},
                  "slow": {"polls": 3, "hits": 1}}
    out = newswatch.promote_candidates(candidates, ["elonmusk"])
    assert out["promoted"] == ["good"] and out["evicted"] == ["mute"]
    assert list(candidates) == ["slow"]


def test_un_candidat_promu_n_evince_JAMAIS_un_compte_choisi_a_la_main():
    """Évincer un compte que Massii a choisi lui-même au profit d'un compte
    découvert tout seul, ce serait décider à sa place — et il n'aurait aucun
    moyen de savoir ce qui a disparu."""
    full = ["h%d" % i for i in range(newswatch.X_MAX_HANDLES)]
    candidates = {"good": {"polls": 3, "hits": 5}}
    out = newswatch.promote_candidates(candidates, full)
    assert out["promoted"] == [] and out["pending"] == ["good"]
    assert candidates["good"]["pending_manual"] is True


def test_un_candidat_deja_en_attente_n_est_signale_qu_UNE_fois():
    """Sinon l'appelant rejournaliserait les mêmes noms toutes les dix minutes
    jusqu'à ce qu'une place se libère."""
    full = ["h%d" % i for i in range(newswatch.X_MAX_HANDLES)]
    candidates = {"good": {"polls": 3, "hits": 5}}
    newswatch.promote_candidates(candidates, full)
    assert newswatch.promote_candidates(candidates, full)["pending"] == []


def test_une_place_qui_se_libere_promeut_le_candidat_en_attente():
    """Le drapeau ``pending_manual`` marque une attente, il n'est pas une
    condamnation."""
    full = ["h%d" % i for i in range(newswatch.X_MAX_HANDLES)]
    candidates = {"good": {"polls": 3, "hits": 5}}
    newswatch.promote_candidates(candidates, full)
    out = newswatch.promote_candidates(candidates, full[:-1])
    assert out["promoted"] == ["good"] and candidates == {}


# --- I/O : la découverte, de bout en bout ------------------------------------ #

def test_une_mention_dans_une_depeche_de_presse_cree_un_candidat():
    fetch = _FetchQueue()
    fetch.push_eco(_rss([("Seed", "https://g/eseed", NOW)]))
    _run(fetch, _NotifySpy())                           # amorçage

    later = NOW + timedelta(minutes=10)
    fetch.push_eco(_rss([
        ("US inflation surges, warns @zerohedge", "https://g/e1", later)]))
    _run(fetch, _NotifySpy(), now=later)

    candidates = newswatch._load_global_seen()["x_candidates"]
    assert "zerohedge" in candidates
    assert candidates["zerohedge"]["polls"] == 0        # pas encore interrogé


def test_le_volet_POLITIQUE_ne_remplit_pas_la_file_de_probation():
    """Truth Social interpelle quelqu'un à presque chaque publication : branchée
    là, la file de dix places se remplirait de comptes politiques en une
    soirée. On découvre des comptes DE FINANCE, dans de la presse de finance."""
    fetch = _FetchQueue()
    fetch.push(_rss([("Seed", "https://n/seed", NOW)]))
    fetch.push(_EMPTY_RSS)
    _run(fetch, _NotifySpy(), prime_gov=False)          # amorçage gov

    later = NOW + timedelta(minutes=10)
    fetch.push(_rss([
        ("Seed", "https://n/seed", NOW),
        ("Trump announces tariffs, says @SomePolitician", "https://n/1", later),
    ]))
    fetch.push(_EMPTY_RSS)
    _run(fetch, _NotifySpy(), now=later, prime_gov=False)

    assert newswatch._load_global_seen()["x_candidates"] == {}


def _seed_candidate(handle, polls=0, hits=0):
    state = newswatch._load_global_seen()
    state["x_candidates"][handle] = {"first_seen": NOW.isoformat(),
                                     "polls": polls, "hits": hits}
    state["x_cand_cycle"] = 0
    state["seeded"]["x:%s" % handle] = True
    newswatch._save_global_seen(state)


def test_un_candidat_est_interroge_puis_promu_apres_deux_preuves(monkeypatch):
    _x_env(monkeypatch)                                 # elonmusk suivi
    _seed_candidate("zerohedge", polls=0, hits=1)       # une preuve déjà là
    posts = {"zerohedge": [_post("New tariffs on imported steel announced")]}
    kw = dict(x_fetch=lambda h: "<html/>", x_pacer=_XPacer(),
              x_parse=lambda page, handle: list(posts.get(handle, [])))

    _run_x(_FetchQueue(), _NotifySpy(), **kw)

    state = newswatch._load_global_seen()
    assert "zerohedge" not in state["x_candidates"]     # sorti de la file
    assert "zerohedge" in _REAL_LOAD_X_ACCOUNTS()       # entré dans la liste


def test_un_candidat_ne_parle_JAMAIS_au_telephone(monkeypatch):
    """Il est en probation : ses événements naissent en sourdine, quel que soit
    le mode."""
    _x_env(monkeypatch)
    _seed_candidate("zerohedge")
    posts = {"zerohedge": [_post("New tariffs on imported cars announced")]}
    notifier = _NotifySpy()
    _run_x(_FetchQueue(), notifier, mode="tout",
           x_fetch=lambda h: "<html/>", x_pacer=_XPacer(),
           x_parse=lambda page, handle: list(posts.get(handle, [])))

    assert notifier.calls == []
    events = [e for e in newswatch.recent_events("nobody")
              if e.get("handle") == "zerohedge"]
    assert len(events) == 1
    assert events[0]["candidate"] is True and events[0]["muted"] is True


def test_un_candidat_muet_finit_par_quitter_la_file(monkeypatch):
    _x_env(monkeypatch)
    _seed_candidate("silent", polls=newswatch.X_CANDIDATE_EVICT_POLLS - 1)
    _run_x(_FetchQueue(), _NotifySpy(), x_fetch=lambda h: "<html/>",
           x_pacer=_XPacer(), x_parse=lambda page, handle: [])

    state = newswatch._load_global_seen()
    assert "silent" not in state["x_candidates"]
    assert "silent" not in _REAL_LOAD_X_ACCOUNTS()


def test_la_file_de_probation_n_est_sondee_qu_un_cycle_sur_six(monkeypatch):
    _x_env(monkeypatch)
    _seed_candidate("zerohedge")
    asked = []
    kw = dict(x_fetch=lambda h: asked.append(h) or "<html/>",
              x_pacer=_XPacer(), x_parse=lambda page, handle: [])

    _run_x(_FetchQueue(), _NotifySpy(), **kw)           # cycle candidat 0 : dû
    assert asked.count("zerohedge") == 1
    for step in range(1, 6):
        _run_x(_FetchQueue(), _NotifySpy(),
               now=NOW + timedelta(minutes=10 * step), **kw)
    assert asked.count("zerohedge") == 1                # cycles 1..5 : sautés
    _run_x(_FetchQueue(), _NotifySpy(), now=NOW + timedelta(minutes=60), **kw)
    assert asked.count("zerohedge") == 2                # cycle 6 : dû


# --------------------------------------------------------------------------- #
# Les trois volets ENSEMBLE — le test qui attrape une collision d'état
# --------------------------------------------------------------------------- #

def test_les_trois_volets_mondiaux_cohabitent_dans_un_meme_cycle(monkeypatch):
    """Chacun a ses tests ; celui-ci vérifie qu'ils ne se marchent pas dessus.

    Trois budgets, trois cadences, trois clés d'amorçage, trois préfixes de
    sourdine — tout ça vit dans le MÊME fichier d'état. Une clé partagée par
    erreur ne se verrait sur aucun test isolé : elle ferait juste taire un volet
    quand un autre parle.
    """
    _pressefi_env(monkeypatch)
    _bsky_env(monkeypatch)
    bsky_posts = [_bpost("$NVDA raises guidance", "https://bsky.app/p/1")]
    kw = dict(bsky_fetch=lambda url: b"{}",
              bsky_parse=lambda raw: list(bsky_posts))

    def _cycle(now, notifier):
        fetch = _FetchQueue()
        fetch.push_bc(_rss([(BC_TITLE, "https://f/%s" % now.minute, now)]))
        fetch.push_pressefi(_rss([("Nestlé beats estimates",
                                   "https://bbc/%s" % now.minute, now)]))
        state = newswatch._load_global_seen()
        for key in ("bc_cycle", "pressefi_cycle", "bsky_cycle"):
            state[key] = 0
        newswatch._save_global_seen(state)
        fetch.prime_gov()
        return newswatch.run_once(now=now, fetch=fetch, notifier=notifier,
                                  tg_cfg=CFG, sleep=lambda s: None,
                                  mode="tout", **kw)

    _cycle(NOW, _NotifySpy())                          # amorçage des trois
    later = NOW + timedelta(minutes=10)
    bsky_posts[:] = [_bpost("$NVDA beats estimates", "https://bsky.app/p/2",
                            later)]
    counters = _cycle(later, _NotifySpy())

    srcs = {e.get("src") for e in newswatch.recent_events("nobody")}
    assert {"bc", "pressefi", "bsky"} <= srcs
    assert counters["errors"] == 0
    assert counters["notified"] == 3                   # un par volet

    # Trois budgets DISTINCTS, chacun avec sa propre trace d'envoi.
    state = newswatch._load_global_seen()
    for key in ("bc_sent_log", "pressefi_sent_log", "bsky_sent_log"):
        assert len(state[key]) == 1, key
    # …et trois amorçages distincts, aucun n'ayant marqué celui d'un autre.
    assert {"bc", "pressefi", "bsky"} <= set(state["seeded"])


# =========================================================================== #
#  F3 — une mention BLUESKY est un DOMAINE, pas un handle X (27/08)
# =========================================================================== #

def test_F3_une_mention_bluesky_ne_fabrique_PAS_un_compte_X():
    """Reproduction du finding : ``@nytimes.com`` donnait ``nytimes``, un compte
    X inventé qui rend 404 — et deux 404 valaient une escalade vers le
    navigateur furtif, jusqu'à dix démarrages de Chrome par heure."""
    assert newswatch.extract_mentions(
        "@nytimes.com and @bloomberg.bsky.social") == []


def test_F3_un_point_de_FIN_DE_PHRASE_ne_jette_pas_le_compte():
    """Le test porte sur le point ET sur ce qui le suit : « merci @elonmusk. »
    n'est pas un domaine, et ce compte-là existe."""
    assert newswatch.extract_mentions("merci @elonmusk.") == ["elonmusk"]
    assert newswatch.extract_mentions("@elonmusk. Ensuite") == ["elonmusk"]


def test_F3_les_deux_formes_dans_la_meme_phrase():
    assert newswatch.extract_mentions(
        "via @nytimes.com, repris par @elonmusk") == ["elonmusk"]


def test_F3_la_garde_ne_backtracke_pas():
    """Une garde écrite dans l'expression (``(?!\\.)``) ferait reculer le moteur
    et accepterait ``nytime`` — c'est-à-dire exactement le compte inventé."""
    for text in ("@nytimes.com", "@nytimes.co.uk", "@a.b"):
        assert newswatch.extract_mentions(text) == []


# --- ceinture : un CANDIDAT ne réveille jamais le navigateur furtif --------- #

def test_F3_un_candidat_injoignable_ne_declenche_PAS_l_escalade(monkeypatch):
    """Un candidat est souvent un compte qui n'existe pas. Démarrer un Chrome
    pour un 404, en boucle, était le pire achat du guetteur.

    DEUX passages : c'est au second que l'ancien code atteignait le seuil
    d'escalade et sortait le navigateur furtif."""
    _x_env(monkeypatch)
    _seed_candidate("ghosthandle")
    heavy_calls = []

    def light(handle):
        raise RuntimeError("HTTP 404")

    kw = dict(x_fetch=light, x_pacer=_XPacer(),
              x_stealth=lambda h: heavy_calls.append(h) or "<html/>",
              x_parse=lambda page, handle: [])
    _run_x(_FetchQueue(), _NotifySpy(), **kw)
    state = newswatch._load_global_seen()
    state["x_cand_cycle"] = 0                      # le rendre dû à nouveau
    newswatch._save_global_seen(state)
    _run_x(_FetchQueue(), _NotifySpy(), now=NOW + timedelta(minutes=10), **kw)

    # « ghosthandle » n'y est pas ; « elonmusk », compte CHOISI À LA MAIN et
    # injoignable lui aussi dans ce test, y est — c'est bien le régime du
    # CANDIDAT qui change, pas l'escalade en général (cf. le test suivant).
    assert "ghosthandle" not in heavy_calls


def test_F3_deux_anomalies_sortent_le_candidat_de_la_file(monkeypatch):
    """Deux refus suffisent à dire qu'un candidat n'existe pas ; on ne le garde
    pas six passages de plus à cogner sur une porte fermée."""
    _x_env(monkeypatch)
    _seed_candidate("ghosthandle")

    def light(handle):
        raise RuntimeError("HTTP 404")

    kw = dict(x_fetch=light, x_pacer=_XPacer(), x_stealth=lambda h: "<html/>",
              x_parse=lambda page, handle: [])
    _run_x(_FetchQueue(), _NotifySpy(), **kw)
    state = newswatch._load_global_seen()
    assert "ghosthandle" in state["x_candidates"]           # une anomalie : on garde
    state["x_cand_cycle"] = 0
    newswatch._save_global_seen(state)

    _run_x(_FetchQueue(), _NotifySpy(), now=NOW + timedelta(minutes=10), **kw)
    state = newswatch._load_global_seen()
    assert "ghosthandle" not in state["x_candidates"]       # deux : il sort
    assert "ghosthandle" not in state["x_fails"]
    assert "ghosthandle" not in _REAL_LOAD_X_ACCOUNTS()     # et n'est PAS promu


def test_F3_un_compte_SUIVI_garde_lui_son_droit_a_l_escalade(monkeypatch):
    """Le furtif reste réservé aux comptes choisis à la main — on n'a pas coupé
    l'escalade, on l'a réservée."""
    _x_env(monkeypatch, handles=("elonmusk",))
    heavy_calls = []

    def light(handle):
        raise RuntimeError("mur")

    kw = dict(x_fetch=light, x_pacer=_XPacer(),
              x_stealth=lambda h: heavy_calls.append(h) or "<html/>",
              x_parse=lambda page, handle: [])
    _run_x(_FetchQueue(), _NotifySpy(), **kw)
    _run_x(_FetchQueue(), _NotifySpy(), now=NOW + timedelta(minutes=10), **kw)

    assert heavy_calls == ["elonmusk"]


# =========================================================================== #
#  F2 — la file de probation ne chasse plus le fil (27/08)
# =========================================================================== #

def test_F2_les_events_de_candidats_sont_plafonnes_par_passage(monkeypatch):
    """Dix candidats × huit posts = quatre-vingts événements possibles, contre
    cent pour TOUT l'historique : la file la moins fiable du guetteur pouvait à
    elle seule chasser la presse, la politique et les banques centrales."""
    _x_env(monkeypatch)
    for name in ("candone", "candtwo", "candthree"):
        _seed_candidate(name)
    posts = [_post("Fed announces tariffs on imported steel n%d" % i)
             for i in range(8)]
    _run_x(_FetchQueue(), _NotifySpy(), x_fetch=lambda h: "<html/>",
           x_pacer=_XPacer(), x_parse=lambda page, handle: list(posts))

    events = [e for e in newswatch.recent_events("nobody") if e.get("candidate")]
    assert len(events) == newswatch.X_CANDIDATE_MAX_EVENTS_PER_RUN


def test_F2_le_cap_ne_touche_PAS_la_MESURE_qui_decide_d_une_promotion(monkeypatch):
    """Le cap borne la trace, jamais la mesure : sinon un candidat prolixe ne
    pourrait plus jamais faire ses preuves."""
    _x_env(monkeypatch)
    _seed_candidate("prolific")
    posts = [_post("Fed announces tariffs on imported steel n%d" % i)
             for i in range(8)]
    _run_x(_FetchQueue(), _NotifySpy(), x_fetch=lambda h: "<html/>",
           x_pacer=_XPacer(), x_parse=lambda page, handle: list(posts))

    # 8 preuves comptées (>= 2) -> promu, alors que 4 events seulement journalisés
    assert "prolific" in _REAL_LOAD_X_ACCOUNTS()


def test_F2_un_event_de_candidat_reste_VISIBLE_et_MARQUE(monkeypatch):
    """On ne le cache pas — la convergence, elle, ne le compte pas."""
    _x_env(monkeypatch)
    _seed_candidate("zerohedge")
    posts = [_post("New tariffs on imported cars announced")]
    _run_x(_FetchQueue(), _NotifySpy(), x_fetch=lambda h: "<html/>",
           x_pacer=_XPacer(), x_parse=lambda page, handle: list(posts))

    events = [e for e in newswatch.recent_events("nobody")
              if e.get("handle") == "zerohedge"]
    assert len(events) == 1
    assert events[0]["candidate"] is True and events[0]["muted"] is True


# =========================================================================== #
#  F4 — une promotion non persistée ne perd plus le candidat (27/08)
# =========================================================================== #

def test_F4_une_ecriture_ratee_remet_le_candidat_dans_la_file(monkeypatch):
    """``promote_candidates`` SORT le promu de la file, la persistance vient
    après : une écriture qui échoue le perdait des DEUX côtés — ni suivi, ni
    candidat, et ses deux preuves avec lui."""
    _x_env(monkeypatch)
    _seed_candidate("zerohedge", polls=3, hits=2)       # déjà promouvable

    def _boom(handles):
        raise OSError("disque plein")

    monkeypatch.setattr(newswatch, "save_x_accounts", _boom)
    _run_x(_FetchQueue(), _NotifySpy(), x_fetch=lambda h: "<html/>",
           x_pacer=_XPacer(), x_parse=lambda page, handle: [])

    candidates = newswatch._load_global_seen()["x_candidates"]
    assert "zerohedge" in candidates                    # replacé dans la file
    assert candidates["zerohedge"]["hits"] >= 2         # ses preuves intactes


def test_F4_le_passage_suivant_reussit_la_promotion(monkeypatch):
    """Rien n'est promu « à moitié » : le tour d'après réessaie et aboutit."""
    _x_env(monkeypatch)
    _seed_candidate("zerohedge", polls=3, hits=2)
    real_save = newswatch.save_x_accounts
    broken = [True]

    def _flaky(handles):
        if broken[0]:
            raise OSError("disque plein")
        return real_save(handles)

    monkeypatch.setattr(newswatch, "save_x_accounts", _flaky)
    kw = dict(x_fetch=lambda h: "<html/>", x_pacer=_XPacer(),
              x_parse=lambda page, handle: [])
    _run_x(_FetchQueue(), _NotifySpy(), **kw)
    assert "zerohedge" not in _REAL_LOAD_X_ACCOUNTS()

    broken[0] = False
    _run_x(_FetchQueue(), _NotifySpy(), now=NOW + timedelta(minutes=10), **kw)

    assert "zerohedge" in _REAL_LOAD_X_ACCOUNTS()
    assert "zerohedge" not in newswatch._load_global_seen()["x_candidates"]


# =========================================================================== #
#  F5 — un candidat en attente ne squatte plus la file à vie (27/08)
# =========================================================================== #

def _full_list():
    return ["h%d" % i for i in range(newswatch.X_MAX_HANDLES)]


def test_F5_un_pending_finit_par_liberer_sa_place():
    """Son verdict est « promote » à vie et l'éjection ordinaire exige
    ``hits == 0`` : il ne pouvait donc plus JAMAIS sortir. Dix comptes dans cet
    état, et la découverte mourait — sans un mot."""
    full = _full_list()
    candidates = {"good": {"polls": 3, "hits": 5, "first_seen": "2026-08-01"}}
    assert newswatch.promote_candidates(candidates, full)["pending"] == ["good"]

    for extra in range(newswatch.X_CANDIDATE_PENDING_POLLS):
        candidates["good"]["polls"] += 1
        out = newswatch.promote_candidates(candidates, full)
    assert out["released"] == ["good"]
    assert candidates == {}


def test_F5_la_trace_du_libere_est_gardee_et_plafonnee():
    """« Ces comptes-là méritaient une place, il n'y en avait pas. »"""
    full = _full_list()
    seen = []
    for i in range(newswatch.X_PENDING_SEEN_MAX + 3):
        name = "cand%d" % i
        candidates = {name: {"polls": 0, "hits": 5, "first_seen": "2026-08-01"}}
        newswatch.promote_candidates(candidates, full, pending_seen=seen)
        candidates[name]["polls"] = newswatch.X_CANDIDATE_PENDING_POLLS
        newswatch.promote_candidates(candidates, full, pending_seen=seen)

    assert len(seen) == newswatch.X_PENDING_SEEN_MAX     # plafonné
    assert seen[-1]["handle"] == "cand%d" % (newswatch.X_PENDING_SEEN_MAX + 2)
    assert seen[-1]["hits"] == 5                         # les plus RÉCENTS gardés


def test_F5_une_place_qui_se_libere_AVANT_le_delai_promeut_quand_meme():
    """La libération est un plan B, pas une condamnation."""
    full = _full_list()
    candidates = {"good": {"polls": 3, "hits": 5}}
    newswatch.promote_candidates(candidates, full)
    candidates["good"]["polls"] += 1
    out = newswatch.promote_candidates(candidates, full[:-1])
    assert out["promoted"] == ["good"] and out["released"] == []


def test_F5_la_file_LIBEREE_accepte_de_nouveau_des_inscriptions():
    """C'est tout l'objet du correctif : la file respire."""
    full = _full_list()
    candidates = {}
    for i in range(newswatch.X_CANDIDATE_MAX):
        candidates["cand%d" % i] = {"polls": 0, "hits": 5}
    newswatch.promote_candidates(candidates, full)               # tous pending
    assert newswatch.note_mentions(candidates, ["nouveau"], "now") == []

    for entry in candidates.values():
        entry["polls"] = newswatch.X_CANDIDATE_PENDING_POLLS
    out = newswatch.promote_candidates(candidates, full)
    assert len(out["released"]) == newswatch.X_CANDIDATE_MAX
    assert newswatch.note_mentions(candidates, ["nouveau"], "now") == ["nouveau"]


def test_F5_un_etat_ecrit_AVANT_cette_extension_repart_pour_un_tour_plein():
    """Un candidat déjà marqué ``pending_manual`` sans passage de référence ne
    doit pas être libéré au premier coup d'œil."""
    full = _full_list()
    candidates = {"vieux": {"polls": 40, "hits": 5, "pending_manual": True}}
    out = newswatch.promote_candidates(candidates, full)
    assert out["released"] == [] and "vieux" in candidates
    assert candidates["vieux"]["pending_since_polls"] == 40


def test_F5_le_volet_persiste_la_trace_des_liberes(monkeypatch):
    """Bout en bout : la trace vit dans l'état global, pas en mémoire."""
    _x_env(monkeypatch, handles=_full_list())
    state = newswatch._load_global_seen()
    state["x_candidates"]["good"] = {
        "first_seen": NOW.isoformat(), "polls": 0, "hits": 5,
        "pending_manual": True,
        "pending_since_polls": -newswatch.X_CANDIDATE_PENDING_POLLS}
    state["x_cand_cycle"] = 0
    newswatch._save_global_seen(state)

    _run_x(_FetchQueue(), _NotifySpy(), x_fetch=lambda h: "<html/>",
           x_pacer=_XPacer(), x_parse=lambda page, handle: [])

    state = newswatch._load_global_seen()
    assert "good" not in state["x_candidates"]
    assert [row["handle"] for row in state["x_pending_seen"]] == ["good"]


# =========================================================================== #
#  F6 — deux groupes Reddit en ALTERNANCE (27/08)
# =========================================================================== #

def test_F6_le_groupe_alterne_d_un_passage_a_l_autre():
    assert newswatch.reddit_group(0) == newswatch.REDDIT_CORE
    assert newswatch.reddit_group(1) == newswatch.REDDIT_INTL
    assert newswatch.reddit_group(2) == newswatch.REDDIT_CORE
    assert newswatch.reddit_group("cassé") == newswatch.REDDIT_CORE


def test_F6_indianstreetbets_reste_dehors_en_attendant_une_sonde_propre():
    """La sonde par-sub n'en a tiré que des 429 de collision : ni mort ni sain
    prouvé. Le mécanisme d'alternance tolérerait un sub malade, mais on ne
    lance pas avec un doute connu."""
    assert "IndianStreetBets" not in newswatch.REDDIT_SUBS


def _run_reddit_groups(monkeypatch, urls, now=NOW, fetch=None, parse=None):
    """Un cycle Reddit qui laisse voir QUEL groupe a été demandé.

    ``_run_reddit`` réinstalle ``_reddit_url`` avec une URL figée (c'est son
    rôle) : ce coureur-ci pose à la place une sonde qui note le groupe reçu. Le
    compteur d'alternance, lui, vit dans l'état — il survit donc d'un appel à
    l'autre, ce qui est précisément ce qu'on veut mesurer.
    """
    monkeypatch.setattr(
        newswatch, "_reddit_url",
        lambda subs=None: urls.append(tuple(subs)) or _REDDIT_URL)
    state = newswatch._load_global_seen()
    state["reddit_cycle"] = 0
    newswatch._save_global_seen(state)
    queue = _FetchQueue()
    queue.prime_gov()
    return newswatch.run_once(
        now=now, fetch=queue, notifier=_NotifySpy(), tg_cfg=CFG,
        sleep=lambda s: None, mode="tout",
        reddit_fetch=fetch or (lambda url: b"x"),
        reddit_parse=parse or (lambda raw: []))


def test_F6_un_passage_n_interroge_QU_UN_groupe(monkeypatch):
    """Une requête par passage — le plafond mesuré de 1 req/60 s reste tenu
    avec la même marge qu'avant."""
    urls, calls = [], []
    _run_reddit_groups(monkeypatch, urls,
                       fetch=lambda url: calls.append(url) or b"x")

    assert urls == [newswatch.REDDIT_CORE]
    assert len(calls) == 1


def test_F6_le_passage_suivant_prend_l_AUTRE_groupe(monkeypatch):
    urls = []
    for i in range(3):
        _run_reddit_groups(monkeypatch, urls, now=NOW + timedelta(minutes=10 * i))

    assert urls == [newswatch.REDDIT_CORE, newswatch.REDDIT_INTL,
                    newswatch.REDDIT_CORE]


def test_F6_un_groupe_en_PANNE_ne_bloque_pas_l_autre(monkeypatch):
    """Reproduction du finding : le multireddit à dix rendait 403 depuis
    l'Omen, et un sub en quarantaine emportait AUSSI les quatre d'origine."""
    urls = []

    def fetch(url):
        if urls[-1] == newswatch.REDDIT_CORE:
            raise RuntimeError("Reddit HTTP 403")
        return b"x"

    posts = [_rpost("$NVDA is going to the moon", "https://r.test/1")]
    counters = _run_reddit_groups(monkeypatch, urls, fetch=fetch)
    assert urls[-1] == newswatch.REDDIT_CORE
    assert counters["errors"] == 1                       # le groupe cassé compte

    later = NOW + timedelta(minutes=10)
    counters = _run_reddit_groups(monkeypatch, urls, now=later, fetch=fetch,
                                  parse=lambda raw: list(posts))
    assert urls[-1] == newswatch.REDDIT_INTL             # on est passé à l'autre
    assert counters["errors"] == 0                       # et il passe
    assert newswatch.recent_trends(later) == {"NVDA": {"count": 1, "prev": 0}}


def test_F6_l_evenement_reddit_garde_sa_provenance_par_sub(monkeypatch):
    """Un compteur de tendance ne dit pas d'où il vient ; l'ÉVÉNEMENT, si."""
    posts = [_rpost("$NVDA squeeze incoming", "https://r.test/9",
                    sub="mauerstrassenwetten")]
    _run_reddit(monkeypatch, _FetchQueue(), _NotifySpy(),
                reddit_fetch=lambda url: b"x", reddit_parse=lambda raw: posts)

    events = [e for e in newswatch.recent_events("nobody")
              if e.get("src") == "reddit"]
    assert events[0]["subreddit"] == "mauerstrassenwetten"


# =========================================================================== #
#  F9 — le cap d'HISTORIQUE n'étouffe plus un ENVOI (27/08)
# =========================================================================== #

def test_F9_un_communique_au_dela_du_cap_part_quand_meme():
    """Reproduction du finding : le cap ``max_events`` sautait tout le bloc,
    donc aussi la notification. Huit communiqués d'une même histoire (donc
    muets, budget d'envoi INTACT) remplissaient le cap — et la décision de taux
    arrivée en neuvième position était étouffée par un garde-fou d'HISTORIQUE."""
    fetch = _FetchQueue()
    fetch.push_bc(_rss([("Seed", "https://f/seed", NOW)]))
    _run_bc(fetch, _NotifySpy())                        # amorçage

    later = NOW + timedelta(minutes=10)
    items = [("Governor speech on financial stability", "https://f/s%d" % i, later)
             for i in range(newswatch._BC_MAX_EVENTS_PER_RUN)]
    items.append(("ECB raises key rate by 50 basis points", "https://f/rate", later))
    fetch.push_bc(_rss(items))
    notifier = _NotifySpy()
    _run_bc(fetch, notifier, now=later)

    envoyes = "\n".join(text for text, _cfg in notifier.calls)
    assert "50 basis points" in envoyes


def test_F9_un_item_ENVOYE_est_journalise_meme_au_dela_du_cap():
    """Le fil doit porter ce que l'utilisateur a reçu sur son téléphone."""
    fetch = _FetchQueue()
    fetch.push_bc(_rss([("Seed", "https://f/seed", NOW)]))
    _run_bc(fetch, _NotifySpy())

    later = NOW + timedelta(minutes=10)
    items = [("Governor speech on financial stability", "https://f/s%d" % i, later)
             for i in range(newswatch._BC_MAX_EVENTS_PER_RUN)]
    items.append(("ECB raises key rate by 50 basis points", "https://f/rate", later))
    fetch.push_bc(_rss(items))
    _run_bc(fetch, _NotifySpy(), now=later)

    events = [e for e in newswatch.recent_events("nobody")
              if e.get("src") == "bc"]
    envoye = [e for e in events if e["link"] == "https://f/rate"]
    assert envoye and envoye[0]["muted"] is False


def test_F9_le_cap_borne_toujours_ce_qui_n_est_PAS_envoye():
    """On n'a pas supprimé le garde-fou : ce qui ne part pas reste plafonné."""
    fetch = _FetchQueue()
    fetch.push_bc(_rss([("Seed", "https://f/seed", NOW)]))
    _run_bc(fetch, _NotifySpy())

    later = NOW + timedelta(minutes=10)
    fetch.push_bc(_rss([("Statement number %d" % i, "https://f/n%d" % i, later)
                        for i in range(30)]))
    _run_bc(fetch, _NotifySpy(), now=later, mode="calme")

    events = [e for e in newswatch.recent_events("nobody")
              if e.get("src") == "bc"]
    assert len(events) == newswatch._BC_MAX_EVENTS_PER_RUN


# =========================================================================== #
#  F10 — une liste X vide ne gèle plus la probation (27/08)
# =========================================================================== #

def test_F10_la_probation_tourne_meme_sans_compte_choisi_a_la_main(monkeypatch):
    """C'était le pire moment pour l'éteindre : sans compte manuel, la
    découverte est le SEUL moyen d'en avoir un — et il y a dix places libres."""
    _x_env(monkeypatch, handles=())
    _seed_candidate("zerohedge", polls=0, hits=1)
    posts = {"zerohedge": [_post("New tariffs on imported steel announced")]}
    _run_x(_FetchQueue(), _NotifySpy(), x_fetch=lambda h: "<html/>",
           x_pacer=_XPacer(),
           x_parse=lambda page, handle: list(posts.get(handle, [])))

    assert "zerohedge" in _REAL_LOAD_X_ACCOUNTS()       # promu, liste vide ou pas
    assert "zerohedge" not in newswatch._load_global_seen()["x_candidates"]


def test_F10_une_liste_vide_n_interroge_evidemment_aucun_compte(monkeypatch):
    """La boucle des comptes suivis ne fait rien — elle n'invente personne."""
    _x_env(monkeypatch, handles=())
    calls = []
    _run_x(_FetchQueue(), _NotifySpy(), x_fetch=lambda h: calls.append(h) or "",
           x_pacer=_XPacer(), x_parse=lambda page, handle: [])

    assert calls == []


# =========================================================================== #
#  LE PLAFOND D'HISTORIQUE (27/08) — « la base ne grandit pas »
# =========================================================================== #

def test_le_plafond_d_historique_tient_trois_cents_evenements():
    """100 -> 300 le 27/08. Le chiffre datait de DEUX volets ; ils sont huit et
    plus, chacun journalisant quatre à huit événements par cycle, plusieurs
    cycles par jour. À 100, la fenêtre ROULAIT : une dépêche de la veille était
    déjà chassée par le bruit du matin.

    Le test épingle la VALEUR parce que c'est elle que l'utilisateur voit —
    « la base ne grandit pas » était le symptôme exact de ce plafond."""
    assert newswatch._MAX_EVENTS == 300


def test_les_caps_PAR_VOLET_restent_tres_en_dessous_du_plafond():
    """Le rapport entre les deux est ce qui protège la diversité du fil : un
    seul volet ne doit jamais pouvoir chasser tous les autres. Monter le
    plafond sans regarder ce rapport aurait laissé la garde-fou intacte mais
    silencieuse."""
    per_run = (newswatch._BC_MAX_EVENTS_PER_RUN,
               newswatch._PRESSEFI_MAX_EVENTS_PER_RUN,
               newswatch._BSKY_MAX_EVENTS_PER_RUN,
               newswatch._REDDIT_MAX_EVENTS_PER_RUN,
               newswatch.X_CANDIDATE_MAX_EVENTS_PER_RUN)
    assert max(per_run) * len(per_run) < newswatch._MAX_EVENTS


# =========================================================================== #
#  LE VERDICT DU JOUR J (27/08) — le cycle juge les rendez-vous échus
#
#  « Le simulateur savait dire "il va se passer quelque chose le 17" ; il ne
#  disait jamais ce qui s'était RÉELLEMENT passé le 17. »
# =========================================================================== #

class _Judge(object):
    """Faux juge : compte ses passages, rend ce qu'on lui dit."""

    def __init__(self, judged=None, boom=False):
        self.calls = []
        self.judged = list(judged or [])
        self.boom = boom

    def __call__(self, now=None):
        self.calls.append(now)
        if self.boom:
            raise RuntimeError("cotations injoignables")
        return {"checked": len(self.judged), "judged": list(self.judged)}


def test_le_cycle_juge_les_rendez_vous_un_cycle_sur_trois():
    """Même cadence que Reddit, et compteur lu AVANT incrément : un déploiement
    neuf juge dès son PREMIER cycle."""
    judge = _Judge(judged=[{"key": "hypothesis|2026-08-24|h1",
                            "verdict": "flop"}])
    for _ in range(4):
        counters = _run(_FetchQueue(), _NotifySpy(), judge=judge)
    # cycles 0, 1, 2, 3 -> jugés aux cycles 0 et 3 seulement
    assert len(judge.calls) == 2
    assert counters["verdicts"] == 1


def test_le_compteur_de_cadence_du_calendrier_est_PERSISTE():
    """Sans persistance, chaque cycle repartirait de zéro et jugerait à chaque
    fois — la cadence serait morte sans que rien ne le signale."""
    judge = _Judge()
    _run(_FetchQueue(), _NotifySpy(), judge=judge)
    state = newswatch._load_global_seen()
    assert state["calendar_cycle"] == 1


def test_calendar_cycle_due_est_TOLERANT_a_un_compteur_illisible():
    """Un état corrompu ne doit pas éteindre pour toujours la seule boucle qui
    dit ce qui s'est vraiment passé au rendez-vous."""
    assert newswatch.calendar_cycle_due(0) is True
    assert newswatch.calendar_cycle_due(1) is False
    assert newswatch.calendar_cycle_due(3) is True
    assert newswatch.calendar_cycle_due("pas un nombre") is True
    assert newswatch.calendar_cycle_due(None) is True


def test_un_calendrier_en_panne_ne_fait_JAMAIS_perdre_un_cycle():
    """Best-effort STRICT, même patron que la convergence : l'échec est compté
    et logué, jamais propagé."""
    judge = _Judge(boom=True)
    counters = _run(_FetchQueue(), _NotifySpy(), judge=judge)
    assert counters["verdicts"] == 0
    assert counters["errors"] >= 1


def test_le_compteur_de_verdicts_lit_judged_et_non_les_cles_du_dict():
    """``run_verdicts`` rend ``{"checked", "judged"}``. Un ``len()`` posé
    dessus sans y penser compterait ses DEUX clés et annoncerait « 2 verdicts »
    à chaque cycle, y compris quand rien n'a été jugé — mesuré au premier
    branchement."""
    judge = _Judge(judged=[])
    counters = _run(_FetchQueue(), _NotifySpy(), judge=judge)
    assert counters["verdicts"] == 0


def test_les_verdicts_sont_rendus_AVANT_la_convergence():
    """La convergence RELIT les verdicts pour ses facteurs ``event_*`` : elle
    doit voir ceux de CE cycle, pas ceux du précédent."""
    order = []
    judge = _Judge()

    def spy_judge(now=None):
        order.append("judge")
        return judge(now=now)

    def spy_converge(**kwargs):
        order.append("converge")
        return {"fired": False, "sent": False}

    _run(_FetchQueue(), _NotifySpy(), judge=spy_judge, converge=spy_converge)
    assert order == ["judge", "converge"]


# =========================================================================== #
#  TRADUCTION DES TITRES ÉTRANGERS (27/08) — le cycle balaie les titres
#  allemands accumulés par la presse mondiale, EN TOUT DERNIER
#
#  « L'utilisateur (français) ne peut pas lire les titres ALLEMANDS qui
#  s'affichent dans les listes de la toile/connexions. »
# =========================================================================== #

class _Translate(object):
    """Faux sweep de traduction : compte ses passages, rend ce qu'on lui dit."""

    def __init__(self, result=None, boom=False):
        self.calls = []
        self.result = dict(result or {"translated": 0})
        self.boom = boom

    def __call__(self, now=None, events=None):
        self.calls.append({"now": now, "events": list(events or [])})
        if self.boom:
            raise RuntimeError("CLI Claude indisponible")
        return dict(self.result)


def test_le_cycle_appelle_le_sweep_de_traduction_une_fois_par_cycle():
    tr = _Translate()
    _run(_FetchQueue(), _NotifySpy(), translate=tr)
    assert len(tr.calls) == 1
    assert tr.calls[0]["now"] == NOW
    assert isinstance(tr.calls[0]["events"], list)


def test_le_sweep_de_traduction_recoit_les_depeches_politiques_globales():
    """La presse mondiale (source des titres allemands) écrit dans l'état
    politique GLOBAL, jamais par utilisateur (cf. ``_run_pressefi_volet``) --
    c'est donc CETTE liste que le sweep doit recevoir, et non un état vide
    reconstruit à côté.

    Deux cycles : le premier SEED le volet gov (anti-tempête au déploiement,
    cf. ``gov_is_first_pass``) -- une annonce du tout premier cycle n'entre
    jamais dans ``gov_events``, quel que soit son titre."""
    _run(_FetchQueue(), _NotifySpy())
    fetch = _FetchQueue()
    fetch.prime_gov(_rss([("New tariffs announced on steel imports",
                          "http://g/1", NOW)]))
    tr = _Translate()
    # ``prime_gov=False`` : la file a déjà été amorcée à la main ci-dessus --
    # laisser ``_run`` la primer une SECONDE fois repousserait notre item
    # derrière deux réponses vides (piège vécu en écrivant ce test).
    _run(fetch, _NotifySpy(), translate=tr, prime_gov=False)
    titles = [e.get("title") for e in tr.calls[0]["events"]]
    assert "New tariffs announced on steel imports" in titles


def test_un_sweep_de_traduction_en_panne_ne_fait_JAMAIS_perdre_un_cycle():
    """Best-effort STRICT, même patron que la convergence et le calendrier :
    l'échec est compté et logué, jamais propagé."""
    tr = _Translate(boom=True)
    counters = _run(_FetchQueue(), _NotifySpy(), translate=tr)
    assert counters["errors"] >= 1
    assert len(tr.calls) == 1


def test_le_sweep_de_traduction_tourne_APRES_la_convergence():
    order = []

    def spy_converge(**kwargs):
        order.append("converge")
        return {"fired": False, "sent": False}

    def spy_translate(now=None, events=None):
        order.append("translate")
        return {"translated": 0}

    _run(_FetchQueue(), _NotifySpy(), converge=spy_converge,
        translate=spy_translate)
    assert order == ["converge", "translate"]


def test_sans_translate_injecte_le_cycle_appelle_le_vrai_module(monkeypatch):
    """Câblage par défaut : le VRAI ``translate.run_sweep`` -- vérifié en le
    substituant, jamais en laissant tourner le vrai CLI Claude (la presse
    mondiale est éteinte par ``_no_side_channels`` dans cette suite, donc
    zéro candidat allemand de toute façon -- ce test vérifie le CÂBLAGE, pas
    le contenu du sweep, qui a ses propres tests dans
    ``test_paper_translate.py``)."""
    from backend.bots.paper import translate as translate_mod
    calls = []
    monkeypatch.setattr(translate_mod, "run_sweep",
                        lambda **kw: calls.append(kw) or {"translated": 0})
    _run(_FetchQueue(), _NotifySpy())
    assert len(calls) == 1
    assert calls[0]["now"] == NOW
    assert isinstance(calls[0]["events"], list)


# =========================================================================== #
#  I/O -- sauvegarde nocturne (Lot G1)
# =========================================================================== #

def test_run_once_calls_the_injected_backup_check():
    calls = []
    _run(_FetchQueue(), _NotifySpy(), backup_check=lambda now: calls.append(now))
    assert calls == [NOW]


def test_run_once_default_backup_check_calls_the_real_module(monkeypatch):
    """Câblage par défaut : le VRAI ``backup.maybe_run`` -- vérifié en le
    substituant (jamais en laissant tourner une vraie sauvegarde disque, cf.
    la neutralisation par ``_no_side_channels``)."""
    from backend.bots.paper import backup as backup_mod
    calls = []
    monkeypatch.setattr(backup_mod, "maybe_run",
                        lambda **kw: calls.append(kw) or {"ran": False})
    _run(_FetchQueue(), _NotifySpy())
    assert len(calls) == 1
    assert calls[0]["now"] == NOW


def test_a_broken_backup_check_never_breaks_the_cycle():
    def _boom(now):
        raise RuntimeError("disque plein")
    counters = _run(_FetchQueue(), _NotifySpy(), backup_check=_boom)
    assert counters["users"] == 0    # le cycle a continué normalement


def test_backup_check_does_not_affect_the_counters_contract():
    """La sauvegarde ne touche PAS `counters` -- un cycle sans portefeuille
    ni config Telegram reste EXACTEMENT ce qu'il était avant G1 (même
    assertion stricte que test_run_once_no_config_does_nothing)."""
    counters = newswatch.run_once(now=NOW, fetch=_FetchQueue(), notifier=_NotifySpy(),
                                  tg_cfg={}, sleep=lambda s: None, mode="tout")
    assert counters == {"users": 0, "symbols": 0, "fetched": 0, "notified": 0,
                        "errors": 0, "convergence_fired": False,
                        "verdicts": 0}


def test_backup_does_not_run_when_telegram_unconfigured():
    """Doctrine du fichier : sans Telegram, AUCUN accès disque -- la
    sauvegarde ne doit donc même pas être appelée."""
    calls = []
    newswatch.run_once(now=NOW, fetch=_FetchQueue(), notifier=_NotifySpy(),
                       tg_cfg={}, sleep=lambda s: None, mode="tout",
                       backup_check=lambda now: calls.append(now))
    assert calls == []


# =========================================================================== #
#  I/O -- bilan hebdomadaire (LOT 3, C2)
# =========================================================================== #

def test_run_once_calls_the_injected_weekly_check():
    calls = []
    _run(_FetchQueue(), _NotifySpy(), weekly_check=lambda now: calls.append(now))
    assert calls == [NOW]


def test_run_once_default_weekly_check_calls_the_real_module(monkeypatch):
    """Câblage par défaut : le VRAI ``weekly.maybe_run`` -- vérifié en le
    substituant (jamais en laissant tourner un vrai bilan, cf. la
    neutralisation par ``_no_side_channels``)."""
    from backend.bots.paper import weekly as weekly_mod
    calls = []
    monkeypatch.setattr(weekly_mod, "maybe_run",
                        lambda **kw: calls.append(kw) or {"ran": False})
    _run(_FetchQueue(), _NotifySpy())
    assert len(calls) == 1
    assert calls[0]["now"] == NOW


def test_a_broken_weekly_check_never_breaks_the_cycle():
    def _boom(now):
        raise RuntimeError("le coach n'a pas répondu")
    counters = _run(_FetchQueue(), _NotifySpy(), weekly_check=_boom)
    assert counters["users"] == 0    # le cycle a continué normalement


def test_weekly_check_does_not_affect_the_counters_contract():
    """Le bilan hebdomadaire ne touche PAS `counters` -- même assertion
    stricte que ``test_backup_check_does_not_affect_the_counters_contract``."""
    counters = newswatch.run_once(now=NOW, fetch=_FetchQueue(), notifier=_NotifySpy(),
                                  tg_cfg={}, sleep=lambda s: None, mode="tout")
    assert counters == {"users": 0, "symbols": 0, "fetched": 0, "notified": 0,
                        "errors": 0, "convergence_fired": False,
                        "verdicts": 0}


def test_weekly_does_not_run_when_telegram_unconfigured():
    """Doctrine du fichier : sans Telegram, AUCUN accès disque -- le bilan
    hebdomadaire ne doit donc même pas être appelé."""
    calls = []
    newswatch.run_once(now=NOW, fetch=_FetchQueue(), notifier=_NotifySpy(),
                       tg_cfg={}, sleep=lambda s: None, mode="tout",
                       weekly_check=lambda now: calls.append(now))
    assert calls == []


# =========================================================================== #
#  I/O -- alertes de prix (Lot A1)
# =========================================================================== #

def _seed_alert(username, **overrides):
    from backend.bots.paper import price_alerts
    alert_id = overrides.pop("id", "a1")
    symbol = overrides.pop("symbol", "NESN.SW")
    op = overrides.pop("op", "above")
    price = overrides.pop("price", 100.0)
    created_at = overrides.pop("created_at", NOW.isoformat())
    row = price_alerts.new_alert(alert_id, symbol, op, price, created_at)
    row.update(overrides)
    existing = store.load_alerts(username)
    existing.append(row)
    store.save_alerts(username, existing)
    return row


def _quote_fn(prices):
    def _q(symbol):
        if symbol not in prices:
            raise RuntimeError("cours introuvable pour %s" % symbol)
        return {"symbol": symbol, "price": prices[symbol]}
    return _q


def test_price_alert_fires_when_condition_is_crossed():
    _seed_alert("alice", op="above", price=100.0)
    notifier = _NotifySpy()
    _run(_FetchQueue(), notifier, alert_quote=_quote_fn({"NESN.SW": 101.0}))
    row = store.load_alerts("alice")[0]
    assert row["status"] == "triggered"
    assert row["trigger_price"] == 101.0
    assert row["triggered_at"] == NOW.isoformat()
    assert len(notifier.calls) == 1
    assert "NESN.SW" in notifier.calls[0][0]


def test_price_alert_stays_armed_when_condition_not_met():
    _seed_alert("alice", op="above", price=100.0)
    notifier = _NotifySpy()
    _run(_FetchQueue(), notifier, alert_quote=_quote_fn({"NESN.SW": 99.0}))
    assert store.load_alerts("alice")[0]["status"] == "armed"
    assert notifier.calls == []


def test_price_alert_stays_armed_when_quote_unavailable():
    _seed_alert("alice", op="above", price=100.0)

    def _boom(symbol):
        raise RuntimeError("panne Yahoo")

    notifier = _NotifySpy()
    _run(_FetchQueue(), notifier, alert_quote=_boom)
    assert store.load_alerts("alice")[0]["status"] == "armed"
    assert notifier.calls == []


def test_price_alert_fires_even_in_quiet_mode():
    """Doctrine A1 : une alerte de prix est un ordre EXPLICITE de
    l'utilisateur -- elle tire dans les DEUX modes, contrairement à toute
    autre matière du guetteur (cf. tête de run_once)."""
    _seed_alert("alice", op="above", price=100.0)
    notifier = _NotifySpy()
    _run(_FetchQueue(), notifier, mode="calme",
        alert_quote=_quote_fn({"NESN.SW": 101.0}))
    assert len(notifier.calls) == 1
    assert store.load_alerts("alice")[0]["status"] == "triggered"


def test_price_alert_is_one_shot():
    _seed_alert("alice", op="above", price=100.0)
    notifier = _NotifySpy()
    _run(_FetchQueue(), notifier, alert_quote=_quote_fn({"NESN.SW": 101.0}))
    assert len(notifier.calls) == 1

    later = NOW + timedelta(minutes=5)
    _run(_FetchQueue(), notifier, now=later,
        alert_quote=_quote_fn({"NESN.SW": 105.0}))
    assert len(notifier.calls) == 1        # toujours UN seul envoi, jamais un second


def test_price_alert_writes_an_event_in_the_user_feed():
    _seed_alert("alice", op="above", price=100.0)
    _run(_FetchQueue(), _NotifySpy(), alert_quote=_quote_fn({"NESN.SW": 101.0}))
    events = [e for e in newswatch.recent_events("alice") if e.get("src") == "alert"]
    assert len(events) == 1
    assert events[0]["symbol"] == "NESN.SW"
    assert events[0]["muted"] is False
    assert events[0]["sentiment"] == "alert"


def test_price_alert_event_marked_muted_when_notify_fails():
    _seed_alert("alice", op="above", price=100.0)
    _run(_FetchQueue(), _NotifySpy(ok=False), alert_quote=_quote_fn({"NESN.SW": 101.0}))
    events = [e for e in newswatch.recent_events("alice") if e.get("src") == "alert"]
    assert events[0]["muted"] is True


def test_price_alerts_batch_a_single_quote_call_per_distinct_symbol():
    """Deux comptes, deux alertes sur le MÊME symbole -> UN SEUL appel de
    cours (le batch est partagé, jamais répété par alerte ni par compte)."""
    _seed_alert("alice", id="a1", symbol="NESN.SW", op="above", price=100.0)
    _seed_alert("bob", id="b1", symbol="NESN.SW", op="above", price=90.0)
    calls = []

    def _q(symbol):
        calls.append(symbol)
        return {"symbol": symbol, "price": 101.0}

    _run(_FetchQueue(), _NotifySpy(), alert_quote=_q)
    assert calls == ["NESN.SW"]
    assert store.load_alerts("alice")[0]["status"] == "triggered"
    assert store.load_alerts("bob")[0]["status"] == "triggered"


def test_price_alerts_do_not_collide_across_users():
    _seed_alert("alice", op="above", price=100.0)
    _seed_alert("bob", op="below", price=50.0)     # 101.0 n'est PAS <= 50 -> reste armée
    _run(_FetchQueue(), _NotifySpy(), alert_quote=_quote_fn({"NESN.SW": 101.0}))
    assert store.load_alerts("alice")[0]["status"] == "triggered"
    assert store.load_alerts("bob")[0]["status"] == "armed"


def test_no_alert_files_means_zero_quote_calls():
    calls = []

    def _q(symbol):
        calls.append(symbol)
        return {"symbol": symbol, "price": 1.0}

    _run(_FetchQueue(), _NotifySpy(), alert_quote=_q)
    assert calls == []


def test_run_once_no_telegram_config_never_checks_alerts():
    """Doctrine du fichier : sans Telegram, RIEN ne tourne -- alertes de prix
    comprises, même si l'utilisateur en a d'armées."""
    _seed_alert("alice", op="above", price=100.0)
    calls = []

    def _q(symbol):
        calls.append(symbol)
        return {"symbol": symbol, "price": 999.0}

    newswatch.run_once(now=NOW, fetch=_FetchQueue(), notifier=_NotifySpy(),
                       tg_cfg={}, sleep=lambda s: None, mode="tout",
                       alert_quote=_q)
    assert calls == []
    assert store.load_alerts("alice")[0]["status"] == "armed"


def test_default_alert_quote_calls_the_real_quotes_module(monkeypatch):
    """Câblage par défaut : le VRAI ``quotes.get_quote`` -- vérifié en le
    substituant, jamais en laissant partir un vrai appel réseau."""
    from backend.bots.paper import quotes as quotes_mod
    calls = []
    monkeypatch.setattr(quotes_mod, "get_quote",
                        lambda symbol: calls.append(symbol) or {"price": 101.0})
    _seed_alert("alice", op="above", price=100.0)
    _run(_FetchQueue(), _NotifySpy())
    assert calls == ["NESN.SW"]
    assert store.load_alerts("alice")[0]["status"] == "triggered"


def test_a_broken_alert_account_does_not_break_the_others():
    """Un fichier d'alertes corrompu pour un compte ne doit jamais faire
    perdre les alertes des autres (même doctrine best-effort que le reste du
    guetteur)."""
    _seed_alert("bob", op="above", price=100.0)
    store.alerts_path("alice").parent.mkdir(parents=True, exist_ok=True)
    store.alerts_path("alice").write_text("{not valid json", encoding="utf-8")

    notifier = _NotifySpy()
    _run(_FetchQueue(), notifier, alert_quote=_quote_fn({"NESN.SW": 101.0}))
    assert store.load_alerts("bob")[0]["status"] == "triggered"
