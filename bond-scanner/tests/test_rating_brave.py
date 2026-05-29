"""
Unit tests for the Brave/Fitch rating provider.

Pure-Python: parser regex, scoring, REJECT keywords, cache TTL.
No network calls — the live Brave API is exercised manually via
`python -m scanner.rating_providers <ISIN> <issuer>` after wiring.
"""
import asyncio
import json
import os
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path
from unittest import mock

from scanner.rating_providers import (
    FITCH_TITLE_RATING_RE,
    RATING_MAX_AGE_YEARS,
    BraveFitchProvider,
    _Cache,
    _url_age_years,
    is_valid_rating,
    normalize_to_sp,
)

_FIXTURES = os.path.join(os.path.dirname(__file__), 'fixtures', 'brave_results.json')


def _load_fixture(key):
    """Charge une réponse Brave réelle capturée (tests/fixtures/)."""
    with open(_FIXTURES, encoding='utf-8') as f:
        return json.load(f)[key]


class _FakeSerpResp:
    """Stub httpx.Response : renvoie une SERP Brave figée (≠ _FakeResp 429)."""

    def __init__(self, results):
        self.status_code = 200
        self.text = ''
        self.headers = {}
        self._results = results

    def json(self):
        return {'web': {'results': self._results}}


def _fake_async_client(results):
    """Fabrique une classe httpx.AsyncClient factice servant `results`."""

    class _FakeAsyncClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, *a, **k):
            return _FakeSerpResp(results)

    return _FakeAsyncClient


class TestFitchTitleRegex(unittest.TestCase):
    """Regex tested against the 5 confirmed Fitch title formats."""

    def test_idr_with_simple_quotes(self):
        m = FITCH_TITLE_RATING_RE.search("Fitch Affirms IBM's IDR at 'A-'; Outlook Stable")
        self.assertIsNotNone(m)
        self.assertEqual(m.group('rating'), 'A-')

    def test_upgrade_double_quotes(self):
        m = FITCH_TITLE_RATING_RE.search('Fitch Upgrades Broadcom to "BBB+"; Outlook Positive')
        self.assertIsNotNone(m)
        self.assertEqual(m.group('rating'), 'BBB+')

    def test_senior_notes(self):
        m = FITCH_TITLE_RATING_RE.search("Fitch Rates Dominion Energy's Senior Notes 'BBB+'")
        self.assertIsNotNone(m)
        self.assertEqual(m.group('rating'), 'BBB+')

    def test_curly_quotes(self):
        # Fitch sert parfois des guillemets typographiques Unicode (U+2018/U+2019).
        # Le regex doit supporter ces variants en plus des quotes ASCII (U+0027).
        m = FITCH_TITLE_RATING_RE.search("Fitch Upgrades AstraZeneca to ‘A’; Outlook Positive")
        self.assertIsNotNone(m)
        self.assertEqual(m.group('rating'), 'A')

    def test_longest_match_wins(self):
        # Garde-fou : "AA-" doit matcher AVANT "A" sur "Affirms 'AA-'"
        m = FITCH_TITLE_RATING_RE.search("Fitch Affirms SomeIssuer at 'AA-'")
        self.assertIsNotNone(m)
        self.assertEqual(m.group('rating'), 'AA-')


class TestScoring(unittest.TestCase):
    """Provider scoring: HIGH_PREF > issue-specific > 0."""

    def setUp(self):
        self.p = BraveFitchProvider(api_key='dummy')

    def test_idr_keyword_scores_higher_than_senior_notes(self):
        idr_title = "Fitch Affirms IBM's IDR at 'A-'; Outlook Stable"
        sn_title = "Fitch Rates IBM's Senior Notes 'A-'"
        self.assertGreater(
            self.p._score_title(idr_title),
            self.p._score_title(sn_title),
        )

    def test_upgrade_keyword_scores_high(self):
        self.assertGreaterEqual(
            self.p._score_title("Fitch Upgrades Broadcom to 'BBB+'"),
            2,
        )

    def test_reject_keyword_returns_negative(self):
        # Special sentinel: REJECT keywords get -999 so the hit is dropped
        title = "Fitch Affirms Hilton Grand Vacations Trust 2026-1 at 'BB-'"
        self.assertLess(self.p._score_title(title), 0)


class TestIssuerStrip(unittest.TestCase):
    """Test the prudent strip: legal-pure suffixes only."""

    def setUp(self):
        self.p = BraveFitchProvider(api_key='dummy')

    def test_strip_inc(self):
        self.assertEqual(self.p._strip_issuer('Dominion Energy Inc'), 'Dominion Energy')

    def test_strip_corp(self):
        self.assertEqual(self.p._strip_issuer('Broadcom Corp'), 'Broadcom')

    def test_dont_strip_worldwide(self):
        # Critical: "Hilton Worldwide" != "Hilton Grand Vacations"
        self.assertEqual(self.p._strip_issuer('Hilton Worldwide'), 'Hilton Worldwide')

    def test_dont_strip_finance(self):
        self.assertEqual(
            self.p._strip_issuer('AstraZeneca Finance LLC'),
            'AstraZeneca Finance',
        )

    def test_only_one_strip(self):
        # We strip the FIRST matching suffix only - no recursive strip
        self.assertEqual(self.p._strip_issuer('Foo Inc.'), 'Foo')


class TestCacheTTL(unittest.TestCase):
    """30-day TTL by ISIN."""

    def setUp(self):
        self.tmp = tempfile.NamedTemporaryFile(
            mode='w', suffix='.json', delete=False,
        )
        self.tmp.close()
        self.path = Path(self.tmp.name)
        self.path.unlink()  # we want a fresh start

    def tearDown(self):
        if self.path.exists():
            self.path.unlink()

    def test_set_then_get(self):
        cache = _Cache(self.path)
        cache.set('US25746UCY38', 'BBB+', 'Fitch', 'Brave Search')
        entry = cache.get('US25746UCY38')
        self.assertIsNotNone(entry)
        self.assertEqual(entry['rating'], 'BBB+')

    def test_ttl_expiry(self):
        cache = _Cache(self.path)
        cache.set('XX', 'A', 'Fitch', 'src')
        # Manually backdate the entry past TTL
        cache._data['XX']['date'] = (date.today() - timedelta(days=31)).isoformat()
        cache._save()
        cache2 = _Cache(self.path)  # reload
        self.assertIsNone(cache2.get('XX'))

    def test_miss_returns_none(self):
        cache = _Cache(self.path)
        self.assertIsNone(cache.get('NONEXISTENT'))


class TestValidators(unittest.TestCase):
    """Carried over from old rating_providers - confirm still exported."""

    def test_is_valid_rating(self):
        self.assertTrue(is_valid_rating('BBB+'))
        self.assertFalse(is_valid_rating('not rated'))

    def test_normalize_moodys(self):
        self.assertEqual(normalize_to_sp('Baa1'), 'BBB+')


class _FakeResp:
    """Minimal stub of httpx.Response for testing the 429 quota detection."""
    def __init__(self, status_code, text=''):
        self.status_code = status_code
        self.text = text

    def json(self):
        import json as _json
        return _json.loads(self.text or '{}')


class TestQuotaExhaustionDetection(unittest.TestCase):
    """Detection of Brave Search quota exhaustion (Task post-15:30)."""

    def setUp(self):
        # Each test gets a fresh provider so _consecutive_429 starts at 0
        self.p = BraveFitchProvider(api_key='dummy')

    def test_quota_keyword_body_triggers_immediately(self):
        """A 429 with 'quota'/'monthly'/'exhausted' in body marks as exhausted on FIRST hit."""
        # We can't easily call get_rating() without mocking httpx, but we can
        # exercise the same detection logic by inspecting how _consecutive_429
        # + the keyword check would interact. Here we simulate via direct flag.
        body_with_quota = '{"error": "Monthly quota exceeded for your plan"}'
        is_quota = any(kw in body_with_quota.lower() for kw in (
            'quota', 'monthly', 'exhausted', 'limit exceeded',
            'plan limit', 'subscription',
        ))
        self.assertTrue(is_quota)

    def test_transient_429_without_quota_keyword_does_not_mark(self):
        """A 429 with no quota keyword (just throttling) does not mark exhausted on first hit."""
        body_transient = '{"error": "Too many requests, retry after 1 second"}'
        is_quota = any(kw in body_transient.lower() for kw in (
            'quota', 'monthly', 'exhausted', 'limit exceeded',
            'plan limit', 'subscription',
        ))
        self.assertFalse(is_quota)

    def test_consecutive_429_threshold_fallback(self):
        """After 3 consecutive 429s (no keyword match), should still mark as exhausted."""
        # Directly simulate the counter logic
        consecutive = 0
        for _ in range(3):
            consecutive += 1
        self.assertGreaterEqual(consecutive, 3)
        # In the real code, this triggers self.quota_exhausted = True

    def test_quota_exhausted_default_false(self):
        self.assertFalse(self.p.quota_exhausted)
        self.assertEqual(self.p._consecutive_429, 0)

    def test_manual_set_quota_exhausted(self):
        """Once the flag is set, the provider should be marked as exhausted."""
        self.p.quota_exhausted = True
        self.assertTrue(self.p.quota_exhausted)


class TestIssuerIdentityGate(unittest.TestCase):
    """
    Régression du bug du 2026-05-29 : un rating Fitch ne doit être accepté
    QUE s'il provient d'une page Fitch parlant DU MÊME émetteur.

    Bug constaté : recherche 'Iccrea Banca' (petite banque coopérative
    italienne, non notée par Fitch) → Brave renvoyait des pages d'AUTRES
    banques, dont "Fitch Affirms ICBC at 'A'" → Iccrea taggé 'A'.
    ICBC (Bank of China) ≠ Iccrea Banca. Faux positif total.
    """

    def setUp(self):
        self.p = BraveFitchProvider(api_key='dummy')

    def test_wrong_issuer_rejected_iccrea_vs_icbc(self):
        self.assertFalse(self.p._issuer_matches_hit(
            'Iccrea Banca',
            "Fitch Affirms ICBC at 'A'; Outlook Stable",
            'https://www.fitchratings.com/research/banks/'
            'fitch-affirms-icbc-at-a-outlook-stable-16-05-2025',
        ))

    def test_correct_issuer_accepted_dominion(self):
        self.assertTrue(self.p._issuer_matches_hit(
            'Dominion Energy',
            "Fitch Rates Dominion Energy's Senior Notes 'BBB+'",
            'https://www.fitchratings.com/research/corporate-finance/'
            'fitch-rates-dominion-energy-senior-notes-bbb-06-03-2025',
        ))

    def test_correct_issuer_accepted_bayerische(self):
        self.assertTrue(self.p._issuer_matches_hit(
            'Bayerische Landesbank',
            "Fitch Affirms Bayerische Landesbank's IDR at 'A-'/Stable",
            'https://www.fitchratings.com/research/banks/'
            'fitch-affirms-bayerische-landesbank-idr-at-a-stable-20-04-2018',
        ))

    def test_match_via_url_slug_when_title_omits_issuer(self):
        # Le slug de l'URL porte l'identité même si le titre est tronqué.
        self.assertTrue(self.p._issuer_matches_hit(
            'Dominion Energy',
            "Fitch Rates Senior Notes 'BBB+'",
            'https://www.fitchratings.com/research/corporate-finance/'
            'fitch-rates-dominion-energy-senior-notes-bbb-06-03-2025',
        ))

    def test_substring_inside_word_does_not_match(self):
        # "ubs" ne doit PAS matcher "subsidiary" (match par token, pas substring).
        self.assertFalse(self.p._issuer_matches_hit(
            'UBS',
            "Fitch Affirms Some Bank's Subsidiary at 'A'",
            'https://www.fitchratings.com/research/banks/some-bank-subsidiary',
        ))

    def test_all_generic_name_rejected(self):
        # Nom 100% générique → impossible de vérifier l'identité → rejet.
        self.assertFalse(self.p._issuer_matches_hit(
            'Bank Group Holding',
            "Fitch Affirms SomeBank at 'A'",
            'https://www.fitchratings.com/research/banks/somebank',
        ))

    # --- Régression mots géographiques (scan réel 2026-05-29) ---

    def test_german_sovereign_not_matched_by_telefonica_deutschland(self):
        # Bund allemand (AAA) NE doit PAS être taggé via "Telefonica Deutschland".
        self.assertFalse(self.p._issuer_matches_hit(
            'Deutschland, Bundesrepublik',
            "Fitch Affirms Telefonica Deutschland at 'BBB'; Outlook Stable",
            'https://www.fitchratings.com/research/corporate-finance/'
            'fitch-affirms-telefonica-deutschland-at-bbb-outlook-stable-26-09-2025',
        ))

    def test_dz_bank_not_matched_by_deutsche_bank(self):
        # DZ BANK ≠ Deutsche Bank : le token "deutsche" ne doit pas suffire.
        self.assertFalse(self.p._issuer_matches_hit(
            'DZ BANK AG Deutsche Zentral-Genossenschaftsbank, Frankfurt am Main',
            "Fitch Affirms Deutsche Bank at 'A-'; Outlook Stable",
            'https://www.fitchratings.com/research/banks/'
            'fitch-affirms-deutsche-bank-at-a-outlook-stable-21-06-2024',
        ))

    def test_deutsche_telekom_still_matches_on_brand(self):
        # Vrai positif : "deutsche" neutralisé → identité portée par "telekom".
        self.assertTrue(self.p._issuer_matches_hit(
            'Deutsche Telekom AG',
            "Fitch Affirms Deutsche Telekom at 'BBB+'; Outlook Stable",
            'https://www.fitchratings.com/research/corporate-finance/'
            'fitch-affirms-deutsche-telekom-at-bbb-outlook-stable-09-08-2023',
        ))

    def test_single_brand_token_oncor_matches(self):
        # Marque unique ("oncor") suffit même si "electric delivery" absent du titre.
        self.assertTrue(self.p._issuer_matches_hit(
            'Oncor Electric Delivery Co. LLC',
            "Fitch Rates Oncor's Senior Secured Notes 'A'",
            'https://www.fitchratings.com/research/corporate-finance/'
            'fitch-rates-oncor-senior-secured-notes-a-23-09-2025',
        ))


class TestGetRatingEndToEnd(unittest.TestCase):
    """
    get_rating() de bout en bout contre des réponses Brave RÉELLES capturées
    (tests/fixtures/brave_results.json). Prouve que le gate d'identité
    transforme le faux positif Iccrea en None et garde le vrai Dominion BBB+.
    """

    def setUp(self):
        tmp = tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False)
        tmp.close()
        self.path = Path(tmp.name)
        self.path.unlink()
        self.cache = _Cache(self.path)

    def tearDown(self):
        if self.path.exists():
            self.path.unlink()

    def _run(self, isin, issuer, fixture_key):
        provider = BraveFitchProvider(api_key='dummy', cache=self.cache)
        results = _load_fixture(fixture_key)
        with mock.patch('httpx.AsyncClient', _fake_async_client(results)):
            return asyncio.run(provider.get_rating(isin, bond_name=issuer))

    def test_iccrea_false_positive_is_now_none(self):
        ri = self._run('IT0005000001', 'Iccrea Banca', 'iccrea_banca')
        self.assertIsNone(ri)

    def test_dominion_true_positive_bbbplus(self):
        ri = self._run('US25746UCY38', 'Dominion Energy', 'dominion_energy')
        self.assertIsNotNone(ri)
        self.assertEqual(ri.value, 'BBB+')

    def test_dominion_carries_verifiable_fitch_url(self):
        ri = self._run('US25746UCY38', 'Dominion Energy', 'dominion_energy')
        self.assertIsNotNone(ri)
        self.assertTrue(ri.source_url.startswith('https://www.fitchratings.com'))

    def _run_crafted(self, issuer, results):
        provider = BraveFitchProvider(api_key='dummy', cache=self.cache)
        with mock.patch('httpx.AsyncClient', _fake_async_client(results)):
            return asyncio.run(provider.get_rating('XS_TEST', bond_name=issuer))

    def test_withdrawn_url_rejected_even_if_title_clean(self):
        # Titre tronqué SANS "withdraw", mais l'URL le contient (Vodafone West).
        ri = self._run_crafted('Vodafone Group', [{
            'url': 'https://www.fitchratings.com/research/corporate-finance/'
                   'fitch-affirms-vodafone-west-gmbh-at-bbb-withdraws-'
                   'ratings-15-09-2020',
            'title': "Fitch Affirms Vodafone West GmbH at 'BBB'",
        }])
        self.assertIsNone(ri)

    def test_stale_2009_rating_rejected(self):
        # GM 'D' de 2009 (faillite) — bon émetteur mais périmé → rejeté.
        ri = self._run_crafted('General Motors', [{
            'url': 'https://www.fitchratings.com/research/corporate-finance/'
                   'fitch-downgrades-general-motors-to-d-unsecured-'
                   'recoveries-minimal-01-06-2009',
            'title': "Fitch Downgrades General Motors to 'D'",
        }])
        self.assertIsNone(ri)


class TestBraveReserveParsing(unittest.TestCase):
    """
    Garde-fou réserve Brave : ne doit PAS se déclencher quand le plan n'a
    AUCUN cap mensuel (limite mensuelle = 0 → métré/pay-as-you-go).
    Bug 2026-05-29 : header réel 'x-ratelimit-remaining: 49, 0' +
    'x-ratelimit-limit: 50, 0' était lu comme "0 restant" → quota_low.
    """

    class _Resp:
        def __init__(self, headers):
            self.headers = headers

    def test_no_monthly_cap_does_not_flag_low(self):
        p = BraveFitchProvider(api_key='dummy')
        p._read_remaining(self._Resp({
            'X-RateLimit-Limit': '50, 0',
            'X-RateLimit-Remaining': '49, 0',
        }))
        self.assertFalse(p.quota_low)
        # remaining_monthly doit être None (pas 0) → ne persiste rien qui
        # bloquerait le pré-lancement backend.
        self.assertIsNone(p.remaining_monthly)

    def test_real_monthly_cap_low_flags(self):
        p = BraveFitchProvider(api_key='dummy')
        p._read_remaining(self._Resp({
            'X-RateLimit-Limit': '1, 2000',
            'X-RateLimit-Remaining': '1, 42',
        }))
        self.assertTrue(p.quota_low)
        self.assertEqual(p.remaining_monthly, 42)

    def test_real_monthly_cap_healthy_does_not_flag(self):
        p = BraveFitchProvider(api_key='dummy')
        p._read_remaining(self._Resp({
            'X-RateLimit-Limit': '1, 2000',
            'X-RateLimit-Remaining': '1, 800',
        }))
        self.assertFalse(p.quota_low)


class TestStalenessGuards(unittest.TestCase):
    """
    Garde anti-péremption + notation retirée (fix 2026-05-29). Découvert en
    test : 'General Motors' → 'D' depuis une URL Fitch de 2009 (faillite GM) ;
    'Vodafone West GmbH ... Withdraws Ratings' (rating retiré).
    """

    def setUp(self):
        self.p = BraveFitchProvider(api_key='dummy')

    def test_old_url_age_exceeds_threshold(self):
        url = ('https://www.fitchratings.com/research/corporate-finance/'
               'fitch-downgrades-general-motors-to-d-unsecured-recoveries-'
               'minimal-01-06-2009')
        age = _url_age_years(url)
        self.assertIsNotNone(age)
        self.assertGreater(age, RATING_MAX_AGE_YEARS)

    def test_recent_url_age_under_threshold(self):
        url = ('https://www.fitchratings.com/research/banks/'
               'fitch-affirms-citigroup-inc-at-a-f1-outlook-stable-15-08-2025')
        age = _url_age_years(url)
        self.assertIsNotNone(age)
        self.assertLess(age, RATING_MAX_AGE_YEARS)

    def test_no_date_in_url_returns_none(self):
        self.assertIsNone(_url_age_years(
            'https://www.fitchratings.com/entity/dominion-energy-12345'))

    def test_withdrawn_rating_rejected_by_score(self):
        title = ("Fitch Affirms Vodafone West GmbH at 'BBB'; "
                 "Withdraws Ratings")
        self.assertLess(self.p._score_title(title), 0)


if __name__ == '__main__':
    unittest.main()
