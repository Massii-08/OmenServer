"""Unit tests for scanner/seen_store.py — mémoire des rejetés (TTL 60j)."""
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path

from scanner.seen_store import SeenStore


class TestSeenStore(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False)
        tmp.close()
        self.path = Path(tmp.name)
        self.path.unlink()

    def tearDown(self):
        if self.path.exists():
            self.path.unlink()

    def test_empty_contains_nothing(self):
        s = SeenStore(self.path)
        self.assertFalse(s.contains('US25746UCY38'))

    def test_add_then_contains(self):
        s = SeenStore(self.path)
        s.add_many(['US25746UCY38', 'XS123'], reason='Yield < 4%')
        self.assertTrue(s.contains('US25746UCY38'))
        self.assertTrue(s.contains('XS123'))
        self.assertFalse(s.contains('OTHER'))

    def test_persists_across_instances(self):
        SeenStore(self.path).add_many(['US25746UCY38'])
        self.assertTrue(SeenStore(self.path).contains('US25746UCY38'))

    def test_ttl_expiry_60d(self):
        s = SeenStore(self.path)
        s.add_many(['XX'])
        # Backdate au-delà des 60j
        s._data['XX']['date'] = (date.today() - timedelta(days=61)).isoformat()
        s._save()
        s2 = SeenStore(self.path)
        self.assertFalse(s2.contains('XX'))  # expiré → re-évaluable

    def test_within_ttl_still_seen(self):
        s = SeenStore(self.path)
        s.add_many(['YY'])
        s._data['YY']['date'] = (date.today() - timedelta(days=59)).isoformat()
        s._save()
        s2 = SeenStore(self.path)
        self.assertTrue(s2.contains('YY'))  # 59j < 60j → encore skippé

    def test_prune_removes_expired(self):
        s = SeenStore(self.path)
        s.add_many(['FRESH'])
        s._data['OLD'] = {'date': (date.today() - timedelta(days=70)).isoformat(), 'reason': ''}
        s._save()
        removed = s.prune()
        self.assertEqual(removed, 1)
        self.assertTrue(s.contains('FRESH'))
        self.assertFalse(s.contains('OLD'))

    def test_reset(self):
        s = SeenStore(self.path)
        s.add_many(['A', 'B'])
        n = s.reset()
        self.assertEqual(n, 2)
        self.assertEqual(s.count(), 0)
        self.assertFalse(self.path.exists())

    def test_ignores_empty_isin(self):
        s = SeenStore(self.path)
        added = s.add_many(['', None])
        self.assertEqual(added, 0)


if __name__ == '__main__':
    unittest.main()
