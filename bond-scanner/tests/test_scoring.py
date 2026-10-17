"""
Unit tests for scanner/scoring.py — classement équilibré 50 % rating / 50 % yield
(décision Massii 2026-10-17) + répartition des quotas par devise.

Spec : docs/superpowers/specs/2026-10-17-bond-scanner-balanced-score-design.md

Pure-Python: no network. Seule I/O : la fixture réelle
tests/fixtures/usd_2026-09-06_delivered.json (100 bonds USD livrés le 2026-09-06).
"""
import json
import os
import unittest
from collections import Counter

from scanner.models import ScannedBond
from scanner.scoring import (
    DEFAULT_RATING_FLOOR,
    RATING_WEIGHT,
    compute_quotas,
    rating_points,
    top_n_per_currency,
    yield_points,
)


def _bond(isin, currency, price, calc_yield, rating):
    """Helper factory : create a ScannedBond with the fields needed for scoring."""
    return ScannedBond(
        isin=isin,
        name=f"Test {isin}",
        currency=currency,
        current_price=price,
        calculated_yield=calc_yield,
        rating=rating,
    )


def _isins(bonds):
    return [b.isin for b in bonds]


class TestConstants(unittest.TestCase):
    def test_rating_weight_is_half(self):
        # Décision 2026-10-17 : 50 % rating / 50 % yield
        self.assertEqual(RATING_WEIGHT, 0.5)

    def test_default_rating_floor_is_bbb_minus(self):
        self.assertEqual(DEFAULT_RATING_FLOOR, 'BBB-')


class TestRatingPoints(unittest.TestCase):
    def test_aaa_is_one_and_floor_is_zero(self):
        self.assertEqual(rating_points('AAA', 'BBB'), 1.0)
        self.assertEqual(rating_points('BBB', 'BBB'), 0.0)

    def test_linear_between_floor_and_aaa(self):
        # Plancher BBB = index 8 dans RATING_SCALE : A+ (4) → 4/8, AA- (3) → 5/8,
        # BBB+ (7) → 1/8.
        self.assertAlmostEqual(rating_points('A+', 'BBB'), 0.5)
        self.assertAlmostEqual(rating_points('AA-', 'BBB'), 0.625)
        self.assertAlmostEqual(rating_points('BBB+', 'BBB'), 0.125)

    def test_below_floor_is_clamped_to_zero(self):
        self.assertEqual(rating_points('BBB-', 'BBB'), 0.0)

    def test_default_floor_when_none_given(self):
        # Sans plancher → BBB- (index 9) : BBB = 1/9, BBB- = 0
        self.assertAlmostEqual(rating_points('BBB'), 1 / 9)
        self.assertEqual(rating_points('BBB-'), 0.0)

    def test_unknown_floor_falls_back_to_default(self):
        self.assertAlmostEqual(rating_points('BBB', 'XYZ'), 1 / 9)

    def test_aaa_floor_does_not_divide_by_zero(self):
        self.assertEqual(rating_points('AAA', 'AAA'), 1.0)
        self.assertEqual(rating_points('AA+', 'AAA'), 0.0)

    def test_moodys_on_both_sides(self):
        # Baa1 → BBB+ ; plancher Baa2 → BBB
        self.assertAlmostEqual(rating_points('Baa1', 'BBB'), 0.125)
        self.assertAlmostEqual(rating_points('A+', 'Baa2'), 0.5)

    def test_missing_or_unknown_rating_is_zero(self):
        self.assertEqual(rating_points(None, 'BBB'), 0.0)
        self.assertEqual(rating_points('', 'BBB'), 0.0)
        self.assertEqual(rating_points('pas un rating', 'BBB'), 0.0)


_POOL = [0.03, 0.04, 0.04, 0.05, 0.06]


class TestYieldPoints(unittest.TestCase):
    def test_rank_within_pool(self):
        self.assertEqual(yield_points(0.03, _POOL), 0.0)
        self.assertAlmostEqual(yield_points(0.04, _POOL), 0.375)   # ex-aequo : rang moyen
        self.assertAlmostEqual(yield_points(0.05, _POOL), 0.75)
        self.assertEqual(yield_points(0.06, _POOL), 1.0)

    def test_missing_yield_is_zero(self):
        self.assertEqual(yield_points(None, _POOL), 0.0)

    def test_single_or_empty_pool_is_one(self):
        self.assertEqual(yield_points(0.05, [0.05]), 1.0)
        self.assertEqual(yield_points(0.05, []), 1.0)

    def test_all_equal_pool_is_half(self):
        self.assertAlmostEqual(yield_points(0.04, [0.04, 0.04, 0.04]), 0.5)

    def test_value_outside_pool_stays_in_unit_range(self):
        for value in (0.10, 0.01):
            points = yield_points(value, _POOL)
            self.assertGreaterEqual(points, 0.0)
            self.assertLessEqual(points, 1.0)


class TestComputeQuotas(unittest.TestCase):
    def test_one_currency_gets_all(self):
        self.assertEqual(compute_quotas(100, 1), [100])

    def test_two_currencies_split_evenly(self):
        self.assertEqual(compute_quotas(100, 2), [50, 50])

    def test_three_currencies_with_remainder(self):
        self.assertEqual(compute_quotas(100, 3), [34, 33, 33])

    def test_three_currencies_even_division(self):
        self.assertEqual(compute_quotas(75, 3), [25, 25, 25])

    def test_three_currencies_two_remainders(self):
        # 50 / 3 = 16 base, 2 remainder → [17, 17, 16]
        self.assertEqual(compute_quotas(50, 3), [17, 17, 16])

    def test_zero_target_returns_zeros(self):
        self.assertEqual(compute_quotas(0, 3), [0, 0, 0])

    def test_zero_currencies_returns_empty(self):
        self.assertEqual(compute_quotas(100, 0), [])


class TestTopNPerCurrency(unittest.TestCase):
    def test_split_3_currencies_each_full_pool(self):
        # Generate a pool with 50 bonds per currency, all with valid scores
        bonds = []
        for i in range(50):
            for ccy in ('EUR', 'USD', 'GBP'):
                bonds.append(_bond(f'{ccy}{i:02d}', ccy, 95, 0.04, 'A'))
        result = top_n_per_currency(bonds, target_count=100, currencies=['EUR', 'USD', 'GBP'])
        self.assertEqual(len(result['EUR']), 34)
        self.assertEqual(len(result['USD']), 33)
        self.assertEqual(len(result['GBP']), 33)

    def test_pool_secco_returns_what_is_available(self):
        # 10 EUR bonds only — target=100 with 1 currency → 10 returned
        bonds = [_bond(f'EUR{i}', 'EUR', 95, 0.04, 'A') for i in range(10)]
        result = top_n_per_currency(bonds, target_count=100, currencies=['EUR'])
        self.assertEqual(len(result['EUR']), 10)

    def test_higher_score_comes_first(self):
        bonds = [
            _bond('LOW', 'EUR', 105, 0.03, 'BBB'),   # weakish
            _bond('HIGH', 'EUR', 85, 0.06, 'AAA'),    # strong
            _bond('MID', 'EUR', 95, 0.04, 'A'),       # medium
        ]
        result = top_n_per_currency(bonds, target_count=10, currencies=['EUR'])
        ordered = [b.isin for b in result['EUR']]
        self.assertEqual(ordered, ['HIGH', 'MID', 'LOW'])

    def test_composite_score_attribute_set(self):
        bonds = [_bond('X', 'EUR', 95, 0.04, 'A')]
        result = top_n_per_currency(bonds, target_count=10, currencies=['EUR'])
        self.assertGreater(result['EUR'][0].composite_score, 0)

    def test_currency_not_in_selected_is_dropped(self):
        bonds = [
            _bond('EUR', 'EUR', 95, 0.04, 'A'),
            _bond('USD', 'USD', 95, 0.04, 'A'),
            _bond('GBP', 'GBP', 95, 0.04, 'A'),
        ]
        # Only EUR + USD selected → GBP must NOT appear in result
        result = top_n_per_currency(bonds, target_count=100, currencies=['EUR', 'USD'])
        self.assertEqual(len(result), 2)
        self.assertIn('EUR', result)
        self.assertIn('USD', result)
        self.assertNotIn('GBP', result)

    # ------------------------------------------------------------------
    #  Classement équilibré 50/50 (2026-10-17)
    # ------------------------------------------------------------------

    def test_compromise_beats_both_extremes(self):
        # SAFE : meilleur rating, pire yield → 0,5 rating + 0 yield = 0,5
        # RISKY : rating au plancher, meilleur yield → 0 + 0,5 = 0,5
        # MID : bon rating ET bon yield → 0,5625 → passe devant les deux.
        bonds = [
            _bond('SAFE', 'EUR', 95, 0.040, 'AAA'),
            _bond('MID', 'EUR', 95, 0.055, 'AA-'),
            _bond('RISKY', 'EUR', 95, 0.060, 'BBB'),
        ]
        result = top_n_per_currency(
            bonds, target_count=10, currencies=['EUR'], rating_floor='BBB',
        )
        # SAFE et RISKY à égalité (0,5) : le meilleur rating passe devant.
        self.assertEqual(_isins(result['EUR']), ['MID', 'SAFE', 'RISKY'])

    def test_rating_floor_changes_the_trade_off(self):
        def ranking(floor):
            bonds = [
                _bond('SAFE', 'EUR', 95, 0.040, 'AAA'),
                _bond('RISKY', 'EUR', 95, 0.060, 'A-'),
            ]
            result = top_n_per_currency(
                bonds, target_count=10, currencies=['EUR'], rating_floor=floor,
            )
            return _isins(result['EUR'])

        # Plancher BBB : A- vaut 0,25 de rating → le yield de RISKY l'emporte.
        self.assertEqual(ranking('BBB'), ['RISKY', 'SAFE'])
        # Plancher A- : A- vaut 0 de rating → égalité à 0,5, le rating départage.
        self.assertEqual(ranking('A-'), ['SAFE', 'RISKY'])

    def test_default_floor_is_bbb_minus(self):
        x = _bond('X', 'EUR', 95, 0.06, 'BBB-')   # rating 0 + yield 1 → 0,5
        y = _bond('Y', 'EUR', 95, 0.04, 'BBB')    # rating 1/9 + yield 0 → 0,5/9
        top_n_per_currency([x, y], target_count=10, currencies=['EUR'])
        self.assertEqual(x.composite_score, 0.5)
        self.assertAlmostEqual(y.composite_score, 0.5 / 9)

    def test_extreme_yield_does_not_crush_the_others(self):
        # 10 bonds notés A à 4,0-4,9 % + un BBB à 20 %. Un min-max donnerait
        # ≈ 0,22 à A49 ; avec le rang percentile : 0,5 × 0,375 + 0,5 × 0,9 = 0,6375.
        bonds = [_bond(f'A{40 + i}', 'EUR', 95, (40 + i) / 1000, 'A') for i in range(10)]
        bonds.append(_bond('OUT', 'EUR', 95, 0.20, 'BBB'))
        result = top_n_per_currency(
            bonds, target_count=20, currencies=['EUR'], rating_floor='BBB',
        )
        ordered = result['EUR']
        self.assertEqual(_isins(ordered)[:4], ['A49', 'A48', 'A47', 'OUT'])
        self.assertAlmostEqual(ordered[0].composite_score, 0.6375)

    def test_yield_is_ranked_within_each_currency(self):
        # Les yields EUR (3,5-3,7 %) ne sont pas jugés contre les GBP (5-6 %) :
        # le meilleur de chaque devise a le même score.
        bonds = [
            _bond('E35', 'EUR', 95, 0.035, 'A'),
            _bond('E36', 'EUR', 95, 0.036, 'A'),
            _bond('E37', 'EUR', 95, 0.037, 'A'),
            _bond('G50', 'GBP', 95, 0.050, 'A'),
            _bond('G55', 'GBP', 95, 0.055, 'A'),
            _bond('G60', 'GBP', 95, 0.060, 'A'),
        ]
        result = top_n_per_currency(bonds, target_count=10, currencies=['EUR', 'GBP'])
        self.assertEqual(result['EUR'][0].isin, 'E37')
        self.assertEqual(result['GBP'][0].isin, 'G60')
        self.assertAlmostEqual(
            result['EUR'][0].composite_score, result['GBP'][0].composite_score,
        )

    def test_ties_are_broken_by_isin(self):
        zzz = _bond('ZZZ', 'EUR', 95, 0.04, 'A')
        aaa1 = _bond('AAA1', 'EUR', 95, 0.04, 'A')
        # Quel que soit l'ordre d'entrée, l'ISIN croissant départage.
        for entry_order in ([zzz, aaa1], [aaa1, zzz]):
            result = top_n_per_currency(entry_order, target_count=10, currencies=['EUR'])
            self.assertEqual(_isins(result['EUR']), ['AAA1', 'ZZZ'])

    def test_float_noise_does_not_break_rating_tiebreak(self):
        # Plancher BBB- par défaut : AAP (AA+, rang yield 1/3), AP (A+, 2/3) et
        # BBBP (BBB+, 1) valent tous EXACTEMENT 11/18. Le flottant les sépare de
        # 1e-16 (AAP = 0,611111111111111 vs 0,6111111111111112) : le meilleur
        # rating doit quand même les départager, pas le bruit.
        bonds = [
            _bond('BBBP', 'EUR', 95, 0.033, 'BBB+'),
            _bond('AP', 'EUR', 95, 0.032, 'A+'),
            _bond('LOW', 'EUR', 95, 0.030, 'BBB-'),
            _bond('AAP', 'EUR', 95, 0.031, 'AA+'),
        ]
        result = top_n_per_currency(bonds, target_count=10, currencies=['EUR'])
        self.assertEqual(_isins(result['EUR']), ['AAP', 'AP', 'BBBP', 'LOW'])

    def test_missing_yield_counts_zero_on_yield(self):
        n = _bond('N', 'EUR', 95, None, 'AAA')
        p = _bond('P', 'EUR', 95, 0.04, 'AAA')
        q = _bond('Q', 'EUR', 95, 0.05, 'AAA')
        result = top_n_per_currency([n, p, q], target_count=10, currencies=['EUR'])
        # N : rating 1 → 0,5 + yield absent 0 → 0,5 (à égalité avec P ; le
        # meilleur yield départage, N est donc dernier).
        self.assertEqual(_isins(result['EUR']), ['Q', 'P', 'N'])
        self.assertEqual(n.composite_score, 0.5)

    def test_price_is_not_in_the_score(self):
        cheap = _bond('B_CHEAP', 'EUR', 85, 0.04, 'A')
        par = _bond('A_PAR', 'EUR', 99.9, 0.04, 'A')
        result = top_n_per_currency([cheap, par], target_count=10, currencies=['EUR'])
        self.assertAlmostEqual(cheap.composite_score, par.composite_score)
        # Score égal malgré 15 points de prix d'écart → l'ISIN départage.
        self.assertEqual(_isins(result['EUR']), ['A_PAR', 'B_CHEAP'])


# ---------------------------------------------------------------------------
#  Fixture réelle : 100 bonds USD livrés par le scan du 2026-09-06
#  (tri « rating d'abord » de l'époque ; on les reclasse avec le nouveau calcul)
# ---------------------------------------------------------------------------

_FIXTURE = os.path.join(
    os.path.dirname(__file__), 'fixtures', 'usd_2026-09-06_delivered.json',
)


def _load_usd_fixture():
    with open(_FIXTURE, encoding='utf-8') as f:
        data = json.load(f)
    return [
        ScannedBond(
            isin=row['isin'],
            name=row['name'],
            currency='USD',
            current_price=row['price'],
            calculated_yield=row['yield'],
            rating=row['rating'],
        )
        for row in data['bonds']
    ]


_SUBSET_ISINS = {
    'US298785JV96', 'US045167GA55', 'US66815M2U00', 'US912828YS30',
    'XS2830445727', 'XS2880093849', 'US302154DJ59', 'US06406RAR84',
}


class TestRealUsdFixture(unittest.TestCase):
    @staticmethod
    def _rank(bonds):
        result = top_n_per_currency(
            bonds, target_count=100, currencies=['USD'], rating_floor='BBB',
        )
        return result['USD']

    def test_subset_exact_order(self):
        bonds = [b for b in _load_usd_fixture() if b.isin in _SUBSET_ISINS]
        self.assertEqual(len(bonds), 8)
        ranked = self._rank(bonds)
        self.assertEqual(_isins(ranked), [
            'XS2830445727', 'US66815M2U00', 'US298785JV96', 'US302154DJ59',
            'US912828YS30', 'US045167GA55', 'US06406RAR84', 'XS2880093849',
        ])
        self.assertAlmostEqual(ranked[0].composite_score, 0.875)
        self.assertAlmostEqual(ranked[-1].composite_score, 0.375)

    def test_full_list_top12(self):
        ranked = self._rank(_load_usd_fixture())
        self.assertEqual(len(ranked), 100)
        # Le 9e et le 10e sont à égalité parfaite : l'ISIN départage.
        self.assertEqual(_isins(ranked[:12]), [
            'US66815M2U00', 'XS2830445727', 'US66815M2Q97', 'US302154DJ59',
            'XS3061310101', 'XS2865538776', 'XS3443185908', 'XS3276317990',
            'US48128BAU52', 'USW8454EBD95', 'USH3698DCW23', 'XS2348658035',
        ])

    def test_full_list_top30_is_a_real_mix(self):
        top30 = self._rank(_load_usd_fixture())[:30]
        self.assertEqual(
            dict(Counter(b.rating for b in top30)),
            {'AAA': 5, 'AA+': 3, 'AA': 4, 'AA-': 8, 'A+': 10},
        )
        # Valeur exacte 0,051493 (le tri « rating d'abord » donnait 0,044627,
        # avec 6 AAA + 24 AA+).
        mean_yield = sum(b.calculated_yield for b in top30) / 30
        self.assertGreater(mean_yield, 0.051)


if __name__ == '__main__':
    unittest.main()
