"""Tests P3c — recommandation déterministe de tier.

Quand un run en tier httpx/stealth se fait BLOQUER de façon PERSISTANTE
(PushbackError consécutifs sans progrès), l'engine émet UNE fois un événement
``recommend_tier`` (via on_event) pour conseiller le tier 'unblocker'. Le
DÉCLENCHEUR est 100% déterministe (le runtime du harvester est déterministe par
design) ; aucun LLM dans la boucle.
"""
from backend.bots.harvester.engine import Engine
from backend.bots.harvester.fetch import FetchError, PushbackError
from backend.bots.harvester.recipe import Recipe
from backend.bots.harvester.store import Store

LISTING_RECIPE = {
    "item_selector": {"tag": "article", "class": "product_pod"},
    "fields": {"title": {"selector": {"tag": "a"}, "extract": "attr:title"}},
}
PAGE1 = ('<html><body><article class="product_pod"><h3><a title="A">a</a></h3>'
         '</article><ul class="pager"><li class="next">'
         '<a href="page-2.html">next</a></li></ul></body></html>')
PLAN_PAGINATION = {"mode": "pagination", "next_selector": {"tag": "li", "class": "next"}}


class AlwaysPushback(object):
    def get(self, url):
        raise PushbackError("429", status=429, retry_after=None)


class SeqFetcher(object):
    """Joue une séquence de comportements par appel : 'pb' = PushbackError,
    sinon la chaîne est rendue comme HTML. Au-delà de la liste -> 'pb'."""

    def __init__(self, behaviors):
        self.behaviors = list(behaviors)
        self.i = 0

    def get(self, url):
        b = self.behaviors[self.i] if self.i < len(self.behaviors) else "pb"
        self.i += 1
        if b == "pb":
            raise PushbackError("429", status=429, retry_after=None)
        return b


class FakePacer(object):
    def interval(self):
        return 0.0

    def penalize(self, retry_after=None):
        pass

    def relax(self):
        pass


def _allow_all(url, source_url):
    # filtre d'URL permissif : hôtes fictifs (x.test) qui ne résolvent pas en DNS.
    # Le filtre anti-SSRF réel est testé dans test_harvester_ssrf.py.
    return True


def _engine(tmp_path, fetcher, plan, events, **kw):
    from backend.bots.harvester.policy import FieldPolicy
    store = Store(str(tmp_path / "store.json"))
    store.add_todo("https://x.test/page-1.html")
    eng = Engine(store, Recipe.from_dict(LISTING_RECIPE), fetcher,
                 FieldPolicy(allowed=["title"]), plan, sleep=lambda s: None,
                 pacer=FakePacer(), on_event=events.append,
                 max_pushback_retries=10, url_filter=_allow_all, **kw)
    return store, eng


def test_recommends_unblocker_after_consecutive_pushbacks(tmp_path):
    events = []
    _, eng = _engine(tmp_path, AlwaysPushback(), {"mode": "sitemap"}, events,
                     recommend_after=3)
    eng.step(); eng.step(); eng.step()
    recos = [e for e in events if e.get("type") == "recommend_tier"]
    assert len(recos) == 1
    assert recos[0]["tier"] == "unblocker"
    assert recos[0]["from_tier"] == "httpx"
    assert recos[0]["consecutive_blocks"] == 3
    assert "reason" in recos[0] and recos[0]["reason"]


def test_does_not_recommend_before_threshold(tmp_path):
    events = []
    _, eng = _engine(tmp_path, AlwaysPushback(), {"mode": "sitemap"}, events,
                     recommend_after=5)
    eng.step(); eng.step()
    assert not any(e.get("type") == "recommend_tier" for e in events)


def test_recommends_only_once(tmp_path):
    events = []
    _, eng = _engine(tmp_path, AlwaysPushback(), {"mode": "sitemap"}, events,
                     recommend_after=3)
    for _ in range(10):
        eng.step()
    recos = [e for e in events if e.get("type") == "recommend_tier"]
    assert len(recos) == 1


def test_consecutive_resets_on_success(tmp_path):
    events = []
    # 2 blocages sur page-1, puis page-1 réussit (record + pagination -> page-2),
    # puis page-2 bloque. Le streak doit repartir de 0 après la réussite : la reco
    # ne se déclenche qu'au 3e blocage CONSÉCUTIF (sur page-2).
    fetcher = SeqFetcher(["pb", "pb", PAGE1])  # le reste -> 'pb' (page-2 bloque)
    _, eng = _engine(tmp_path, fetcher, PLAN_PAGINATION, events, recommend_after=3)
    for _ in range(12):
        eng.step()
    recos = [e for e in events if e.get("type") == "recommend_tier"]
    assert len(recos) == 1
    assert recos[0]["consecutive_blocks"] == 3   # 3 d'affilée sur page-2, pas 5 cumulés


def test_no_recommend_when_already_unblocker(tmp_path):
    events = []
    _, eng = _engine(tmp_path, AlwaysPushback(), {"mode": "sitemap", "fetch_tier": "unblocker"},
                     events, recommend_after=3)
    for _ in range(6):
        eng.step()
    assert not any(e.get("type") == "recommend_tier" for e in events)


def test_recommend_from_tier_reports_stealth(tmp_path):
    events = []
    _, eng = _engine(tmp_path, AlwaysPushback(), {"mode": "sitemap", "fetch_tier": "stealth"},
                     events, recommend_after=2)
    eng.step(); eng.step()
    recos = [e for e in events if e.get("type") == "recommend_tier"]
    assert recos and recos[0]["from_tier"] == "stealth"


def test_default_threshold_is_five(tmp_path):
    events = []
    _, eng = _engine(tmp_path, AlwaysPushback(), {"mode": "sitemap"}, events)
    for _ in range(4):
        eng.step()
    assert not any(e.get("type") == "recommend_tier" for e in events)
    eng.step()   # 5e blocage consécutif
    assert any(e.get("type") == "recommend_tier" for e in events)


# ---- revue #3 : un FetchError (échec non-blocage) casse le streak ---------

class SeqBlockErr(object):
    """Joue 'pb' (PushbackError) ou 'err' (FetchError) selon la séquence."""

    def __init__(self, seq):
        self.seq = list(seq)
        self.i = 0

    def get(self, url):
        b = self.seq[self.i] if self.i < len(self.seq) else "pb"
        self.i += 1
        if b == "pb":
            raise PushbackError("429", status=429, retry_after=None)
        raise FetchError("boom")


def test_fetcherror_resets_consecutive_streak(tmp_path):
    # SANS pacer : pb et err marquent l'URL done et avancent -> 1 URL par step.
    # pb, err, pb, err, pb -> jamais 2 blocages D'AFFILÉE -> pas de reco (seuil 2).
    from backend.bots.harvester.policy import FieldPolicy
    events = []
    store = Store(str(tmp_path / "store.json"))
    for i in range(1, 6):
        store.add_todo("https://x.test/page-{0}.html".format(i))
    eng = Engine(store, Recipe.from_dict(LISTING_RECIPE),
                 SeqBlockErr(["pb", "err", "pb", "err", "pb"]),
                 FieldPolicy(allowed=["title"]), {"mode": "sitemap"},
                 sleep=lambda s: None, on_event=events.append,
                 recommend_after=2)            # PAS de pacer
    for _ in range(5):
        eng.step()
    assert not any(e.get("type") == "recommend_tier" for e in events)
