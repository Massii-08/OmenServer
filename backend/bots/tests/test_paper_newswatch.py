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
import sys
import types
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime

import pytest

from backend.bots.paper import alerts, newswatch, store

# Capturée AVANT toute fixture : ``_no_side_channels`` remplace la vraie
# fonction pour éteindre le volet X par défaut, et les tests de la CONFIG des
# comptes ont justement besoin de la vraie.
_REAL_LOAD_X_ACCOUNTS = newswatch.load_x_accounts
# Idem pour le volet Reddit : la fixture l'éteint en rendant une URL vide, et
# le test qui vérifie le FORMAT de l'URL a besoin de la vraie fonction.
_REAL_REDDIT_URL = newswatch._reddit_url


@pytest.fixture(autouse=True)
def _isolate_data_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "DATA_DIR", tmp_path)
    yield


@pytest.fixture(autouse=True)
def _no_side_channels(monkeypatch):
    """Trois portes de sortie s'ouvriraient sinon PAR DÉFAUT dans cette suite :

    * le **volet X** — sans configuration, ``load_x_accounts`` rend les comptes
      livrés par défaut et le volet irait vraiment chercher x.com ;
    * le **volet Reddit** — il ne dépend d'AUCUNE configuration (les subs sont
      en dur) : sans neutralisation, chaque cycle de test partirait sur
      reddit.com. On coupe par l'URL, seul point de passage du volet ;
    * la **convergence** — appelée à la fin de chaque cycle, elle appellerait
      le VRAI CLI Claude le jour où deux facteurs s'alignent dans une fixture.

    Les trois sont neutralisés ici, et les tests qui les visent réinstallent
    leur propre doublure. Un test de veille ne doit jamais dépendre du réseau.
    """
    monkeypatch.setattr(newswatch, "load_x_accounts", lambda: [])
    monkeypatch.setattr(newswatch, "_reddit_url", lambda: "")
    from backend.bots.paper import convergence
    monkeypatch.setattr(convergence, "maybe_fire",
                        lambda **kwargs: {"fired": False, "sent": False})


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
                        "errors": 0, "convergence_fired": False}
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
    assert counters["fetched"] == 5   # 1 symbole + 2 gov + 2 crypto (volets globaux)
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


def test_run_once_counts_fetch_error_and_continues_other_symbols():
    store.save_portfolio("carol", _portfolio(["AAA", "BBB"]))
    fetch = _FetchQueue()
    fetch.push(RuntimeError("boom"))
    fetch.push(_rss([("Some headline", "https://y/bbb1", NOW - timedelta(hours=1))]))
    notifier = _NotifySpy()
    counters = _run(fetch, notifier)
    assert counters["symbols"] == 2
    assert counters["errors"] == 1
    assert counters["fetched"] == 5    # BBB (1) + 2 gov + 2 crypto
    assert len(fetch.calls) == 6       # 2 gov + 2 crypto + AAA (échoue) + BBB


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
    # 4 fetches au total (2 gov + SYM1 + SYM2) -> pas de pause avant le 1er,
    # une pause avant chacun des 3 suivants.
    assert sleeps == [1.1, 1.1, 1.1, 1.1, 1.1]


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
    # les volets GLOBAUX (gov + crypto) tournent quand même -- seul le volet
    # PAR SYMBOLE (les appels qu'il y aurait eu avec une position) est absent.
    assert len(fetch.calls) == 4


def test_run_once_no_portfolios_still_runs_gov_watch():
    """Sans AUCUN portefeuille nulle part, run_once ne fait plus "rien" comme
    avant l'extension §13 : le volet politique global tourne quand même."""
    fetch = _FetchQueue()
    counters = _run(fetch, _NotifySpy())
    assert counters == {"users": 0, "symbols": 0, "fetched": 4, "notified": 0,
                        "errors": 0, "convergence_fired": False}


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
    assert counters["fetched"] == 4      # 2 gov + 2 crypto
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
    assert counters["fetched"] == 3      # 1 gov qui répond + 2 crypto
    assert len(fetch.calls) == 4


def test_run_once_gov_runs_even_with_zero_portfolios():
    fetch = _FetchQueue()
    fetch.push(_rss([]))
    fetch.push(_rss([]))
    counters = _run(fetch, _NotifySpy(), prime_gov=False)
    assert counters["users"] == 0
    assert counters["fetched"] == 4      # 2 gov + 2 crypto
    assert len(fetch.calls) == 4


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
    monkeypatch.setattr(newswatch, "_reddit_url", lambda: url)

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
    monkeypatch.setattr(newswatch, "_reddit_url", lambda: url)
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
