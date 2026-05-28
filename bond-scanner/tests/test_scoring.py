"""
Unit tests for scanner/scoring.py (Task 15 — composite scoring + top-N split).

Pure-Python: no network, no file I/O.
"""
import unittest

from scanner.models import ScannedBond
from scanner.scoring import (
    DEFAULT_WEIGHTS,
    PRICE_MAX,
    PRICE_MIN,
    _score_price,
    _score_rating,
    _score_yield,
    compute_composite_score,
    compute_quotas,
    top_n_per_currency,
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


class TestScorePrice(unittest.TestCase):
    def test_lowest_price_scores_1(self):
        self.assertEqual(_score_price(PRICE_MIN), 1.0)

    def test_highest_price_scores_0(self):
        self.assertEqual(_score_price(PRICE_MAX), 0.0)

    def test_midpoint_price_scores_half(self):
        midpoint = (PRICE_MIN + PRICE_MAX) / 2
        self.assertAlmostEqual(_score_price(midpoint), 0.5)

    def test_below_range_clamped_to_1(self):
        self.assertEqual(_score_price(50), 1.0)

    def test_above_range_clamped_to_0(self):
        self.assertEqual(_score_price(200), 0.0)

    def test_none_returns_neutral(self):
        self.assertEqual(_score_price(None), 0.5)


class TestScoreYield(unittest.TestCase):
    def test_zero_yield_scores_0(self):
        self.assertEqual(_score_yield(0, max_yield=0.05), 0.0)

    def test_max_yield_scores_1(self):
        self.assertEqual(_score_yield(0.05, max_yield=0.05), 1.0)

    def test_half_yield_scores_half(self):
        self.assertAlmostEqual(_score_yield(0.025, max_yield=0.05), 0.5)

    def test_none_yield_scores_0(self):
        self.assertEqual(_score_yield(None, max_yield=0.05), 0.0)

    def test_max_yield_zero_returns_0(self):
        # Degenerate case: no positive yield in the pool
        self.assertEqual(_score_yield(0.04, max_yield=0), 0.0)


class TestScoreRating(unittest.TestCase):
    def test_aaa_scores_1(self):
        self.assertEqual(_score_rating('AAA'), 1.0)

    def test_d_scores_0(self):
        self.assertEqual(_score_rating('D'), 0.0)

    def test_bbb_minus_lower_than_bbb(self):
        self.assertLess(_score_rating('BBB-'), _score_rating('BBB'))

    def test_aa_plus_higher_than_aa(self):
        self.assertGreater(_score_rating('AA+'), _score_rating('AA'))

    def test_invalid_returns_0(self):
        self.assertEqual(_score_rating('not a rating'), 0.0)

    def test_none_returns_0(self):
        self.assertEqual(_score_rating(None), 0.0)

    def test_moodys_converted(self):
        # Baa1 → BBB+ via normalize_to_sp
        baa1 = _score_rating('Baa1')
        bbbplus = _score_rating('BBB+')
        self.assertEqual(baa1, bbbplus)


class TestCompositeScore(unittest.TestCase):
    def test_defensive_weights_sum_to_1(self):
        total = sum(DEFAULT_WEIGHTS.values())
        self.assertAlmostEqual(total, 1.0)

    def test_perfect_bond_scores_1(self):
        # Lowest price + max yield + AAA → all sub-scores are 1.0
        b = _bond('X', 'EUR', PRICE_MIN, 0.05, 'AAA')
        score = compute_composite_score(b, max_yield=0.05)
        self.assertAlmostEqual(score, 1.0)

    def test_high_yield_outranks_high_rating(self):
        # With Defensive 20/40/40, yield and rating have equal weight.
        # A bond with max yield + lowest rating should score same range
        # as a bond with low yield + AAA.
        bond_high_yield = _bond('Y', 'EUR', 100, 0.10, 'BBB')
        bond_high_rating = _bond('R', 'EUR', 100, 0.03, 'AAA')
        sy = compute_composite_score(bond_high_yield, max_yield=0.10)
        sr = compute_composite_score(bond_high_rating, max_yield=0.10)
        # bond_high_yield has yield=1.0, rating=BBB≈0.62 (one notch under BBB+)
        # bond_high_rating has yield=0.3, rating=1.0
        # 0.4*1.0 + 0.4*0.62 = 0.65
        # 0.4*0.3 + 0.4*1.0 = 0.52
        # Plus price contribution (same 0 for both at 100 → 0.4)
        # Total: 0.4*0.2 + 0.65 = 0.73 vs 0.4*0.2 + 0.52 = 0.60
        self.assertGreater(sy, sr)


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


if __name__ == '__main__':
    unittest.main()
