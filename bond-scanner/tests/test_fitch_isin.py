"""
Tests du rating Fitch PAR ISIN (scanner/fitch_isin.py).

Parser testé contre des réponses GraphQL Fitch RÉELLES capturées
(tests/fixtures/fitch_isin_responses.json). Aucun appel réseau.
"""
import json
import os
import tempfile
import unittest
from pathlib import Path

from scanner.fitch_isin import FitchIsinClient, select_rating
from scanner.rating_providers import _Cache

_FIX = os.path.join(os.path.dirname(__file__), "fixtures", "fitch_isin_responses.json")


def _resp(isin):
    with open(_FIX, encoding="utf-8") as f:
        return json.load(f)[isin]


class TestSelectRating(unittest.TestCase):
    """select_rating() sur données réelles."""

    def test_oncor_default_now_security_A(self):
        # DÉFAUT (2026-05-29) = note du TITRE exact : Oncor secured → A.
        r = select_rating(_resp("XS2813774341"), "XS2813774341")
        self.assertIsNotNone(r)
        self.assertEqual(r["rating"], "A")             # primaire = note du titre
        self.assertEqual(r["issuer_rating"], "BBB+")   # l'IDR émetteur reste dispo
        self.assertEqual(r["security_rating"], "A")
        self.assertIn("XS2813774341", r["url"])

    def test_oncor_prefer_issuer_gives_BBBplus(self):
        # Bascule explicite sur la note émetteur → BBB+.
        r = select_rating(_resp("XS2813774341"), "XS2813774341", prefer_security=False)
        self.assertEqual(r["rating"], "BBB+")

    def test_deutsche_telekom_bbbplus(self):
        r = select_rating(_resp("XS2024716099"), "XS2024716099")
        self.assertEqual(r["rating"], "BBB+")
        self.assertEqual(r["issuer_name"], "Deutsche Telekom AG")

    def test_dominion_bbbplus(self):
        r = select_rating(_resp("US25746UCY38"), "US25746UCY38")
        self.assertEqual(r["rating"], "BBB+")

    def test_unknown_isin_returns_none(self):
        # ISIN bidon → totalHits 0 → aucune note → None (bond exclu).
        self.assertIsNone(select_rating(_resp("XS1234567890"), "XS1234567890"))

    def test_short_term_ratings_ignored(self):
        # Le code ne doit jamais renvoyer F2 (Short Term IDR).
        r = select_rating(_resp("XS2813774341"), "XS2813774341")
        self.assertNotIn(r["rating"], ("F1", "F2", "F3"))

    def test_accepts_bare_search_object(self):
        # Tolère qu'on passe directement l'objet `search` (sans clé `data`).
        search = _resp("US25746UCY38")["data"]["search"]
        r = select_rating({"search": search}, "US25746UCY38")
        self.assertEqual(r["rating"], "BBB+")


class TestFitchIsinClientCached(unittest.TestCase):
    """Le client sert le cache positif/négatif sans réseau."""

    def setUp(self):
        tmp = tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False)
        tmp.close()
        self.path = Path(tmp.name)
        self.path.unlink()
        self.cache = _Cache(self.path)

    def tearDown(self):
        if self.path.exists():
            self.path.unlink()

    def test_positive_cache_hit(self):
        self.cache.set("US25746UCY38", "BBB+", "Fitch", "Fitch ISIN",
                       url="https://www.fitchratings.com/search/?query=US25746UCY38")
        client = FitchIsinClient(cache=self.cache)
        # _session reste None → si ça touchait le réseau le test planterait
        ri = client.fetch("US25746UCY38")
        self.assertIsNotNone(ri)
        self.assertEqual(ri.value, "BBB+")
        self.assertEqual(ri.source, "Fitch")
        self.assertTrue(ri.source_url.endswith("US25746UCY38"))

    def test_negative_cache_hit_returns_none(self):
        self.cache.set("XX0000000000", "", "", "Fitch no-hit", url="")
        client = FitchIsinClient(cache=self.cache)
        self.assertIsNone(client.fetch("XX0000000000"))


class _FakeResp:
    def __init__(self, payload, status=200):
        self.status_code = status
        self._p = payload

    def json(self):
        return self._p


class _FakeSession:
    """Session curl_cffi factice : renvoie la fixture selon l'ISIN du body."""
    def __init__(self, fixtures):
        self.fixtures = fixtures
        self.calls = 0

    def post(self, url, json=None, headers=None, timeout=None):
        self.calls += 1
        isin = json["variables"]["t"]
        return _FakeResp(self.fixtures.get(isin, {"data": {"search": {"totalHits": 0}}}))


class TestFitchIsinClientFetch(unittest.TestCase):
    """fetch() de bout en bout avec une session injectée (pas de réseau)."""

    def setUp(self):
        tmp = tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False)
        tmp.close()
        self.path = Path(tmp.name)
        self.path.unlink()
        with open(_FIX, encoding="utf-8") as f:
            self.fixtures = json.load(f)

    def tearDown(self):
        if self.path.exists():
            self.path.unlink()

    def _client(self):
        c = FitchIsinClient(cache=_Cache(self.path))
        c._session = _FakeSession(self.fixtures)  # injecte la fausse session
        return c

    def test_fetch_oncor(self):
        # Défaut = note du titre exact → Oncor secured A.
        ri = self._client().fetch("XS2813774341")
        self.assertEqual(ri.value, "A")
        self.assertTrue(ri.source_url.endswith("XS2813774341"))

    def test_fetch_unknown_none_and_cached(self):
        c = self._client()
        self.assertIsNone(c.fetch("XS1234567890"))
        # 2e appel → cache négatif, pas de nouvel appel réseau
        before = c._session.calls
        self.assertIsNone(c.fetch("XS1234567890"))
        self.assertEqual(c._session.calls, before)


if __name__ == "__main__":
    unittest.main()
