"""
Unit tests for scanner/found_store.py — dédup persistante inter-scans.
"""
import tempfile
import unittest
from pathlib import Path

from scanner.found_store import FoundStore
from scanner.models import ScannedBond


def _bond(isin, name='Test Bond 1% 30', rating='A'):
    return ScannedBond(isin=isin, name=name, rating=rating)


class TestFoundStore(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False)
        tmp.close()
        self.path = Path(tmp.name)
        self.path.unlink()  # start fresh

    def tearDown(self):
        if self.path.exists():
            self.path.unlink()

    def test_empty_store_contains_nothing(self):
        store = FoundStore(self.path)
        self.assertFalse(store.contains('US25746UCY38'))
        self.assertEqual(store.count(), 0)

    def test_add_then_contains(self):
        store = FoundStore(self.path)
        added = store.add_many([_bond('US25746UCY38'), _bond('US11135FCD15')])
        self.assertEqual(added, 2)
        self.assertTrue(store.contains('US25746UCY38'))
        self.assertTrue(store.contains('US11135FCD15'))
        self.assertFalse(store.contains('XS0000000000'))

    def test_persists_across_instances(self):
        store1 = FoundStore(self.path)
        store1.add_many([_bond('US25746UCY38')])
        # New instance reads the same file
        store2 = FoundStore(self.path)
        self.assertTrue(store2.contains('US25746UCY38'))
        self.assertEqual(store2.count(), 1)

    def test_add_duplicate_does_not_double_count(self):
        store = FoundStore(self.path)
        store.add_many([_bond('US25746UCY38')])
        added = store.add_many([_bond('US25746UCY38'), _bond('US11135FCD15')])
        self.assertEqual(added, 1)  # only the new one
        self.assertEqual(store.count(), 2)

    def test_reset_clears_everything(self):
        store = FoundStore(self.path)
        store.add_many([_bond('US25746UCY38'), _bond('US11135FCD15')])
        n = store.reset()
        self.assertEqual(n, 2)
        self.assertEqual(store.count(), 0)
        self.assertFalse(store.contains('US25746UCY38'))
        self.assertFalse(self.path.exists())

    def test_stores_name_and_rating_metadata(self):
        store = FoundStore(self.path)
        store.add_many([_bond('US25746UCY38', name='Dominion Energy 2% 30', rating='BBB+')])
        store2 = FoundStore(self.path)
        entry = store2._data['US25746UCY38']
        self.assertEqual(entry['rating'], 'BBB+')
        self.assertIn('Dominion', entry['name'])
        self.assertIn('date', entry)

    def test_ignores_bonds_without_isin(self):
        store = FoundStore(self.path)
        b = ScannedBond(isin='', name='No ISIN')
        added = store.add_many([b])
        self.assertEqual(added, 0)
        self.assertEqual(store.count(), 0)


if __name__ == '__main__':
    unittest.main()
