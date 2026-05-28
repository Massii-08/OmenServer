"""
Unit tests for MarketScraper._looks_like_bond_name (bug fix 2026-05-28 19:25).

Contexte : la recherche récursive de champs name/title dans les API
Deutsche Börse captait des états de widgets UI ("disabled") → query Brave
"site:fitchratings.com disabled" → faux rating CCC Scripps appliqué à tous
les bonds. Le validateur garantit qu'on n'envoie à Brave que des noms
plausibles (au pire : pas de rating = cellule vide = sûr).

MarketScraper.__init__ ne touche pas à Playwright (importé seulement dans
start()), donc instanciable en test sans browser.
"""
import unittest

from scanner.market_scraper import MarketScraper


class TestLooksLikeBondName(unittest.TestCase):
    def setUp(self):
        self.m = MarketScraper()

    def test_rejects_ui_garbage_words(self):
        for junk in ('disabled', 'enabled', 'loading', 'true', 'false',
                     'null', 'none', 'undefined', 'active', 'hidden'):
            self.assertFalse(
                self.m._looks_like_bond_name(junk),
                f"{junk!r} devrait être rejeté",
            )

    def test_accepts_real_bond_names(self):
        for name in (
            'ALLIANZ SE EO-MED.TERM NOTES 20(28)',
            'Bundesrepublik Deutschland 0% 31',
            'Dominion Energy Inc',
            'IBM 3.5% 2030',
            'Broadcom Corp 4.15% 28',
        ):
            self.assertTrue(
                self.m._looks_like_bond_name(name),
                f"{name!r} devrait être accepté",
            )

    def test_rejects_bare_single_word(self):
        # Mot seul sans espace ni chiffre → rejeté (échec sûr : pas de
        # rating plutôt qu'un faux rating). Les vrais instrumentName
        # Deutsche Börse ont toujours type/coupon/échéance.
        self.assertFalse(self.m._looks_like_bond_name('Volkswagen'))

    def test_accepts_single_word_with_digit(self):
        # Un nom avec un chiffre passe même sans espace
        self.assertTrue(self.m._looks_like_bond_name('Bond2030xx'))

    def test_rejects_too_short(self):
        self.assertFalse(self.m._looks_like_bond_name('a'))
        self.assertFalse(self.m._looks_like_bond_name(''))
        self.assertFalse(self.m._looks_like_bond_name('AB12'))  # 4 chars

    def test_rejects_too_long(self):
        self.assertFalse(self.m._looks_like_bond_name('x' * 121))

    def test_rejects_non_string(self):
        self.assertFalse(self.m._looks_like_bond_name(None))
        self.assertFalse(self.m._looks_like_bond_name(123))
        self.assertFalse(self.m._looks_like_bond_name(['a', 'b']))

    def test_rejects_media_slugs(self):
        self.assertFalse(self.m._looks_like_bond_name('boersen-radio episode 12'))
        self.assertFalse(self.m._looks_like_bond_name('https://example.com/x'))
        self.assertFalse(self.m._looks_like_bond_name('cover image 2024'))


if __name__ == '__main__':
    unittest.main()
