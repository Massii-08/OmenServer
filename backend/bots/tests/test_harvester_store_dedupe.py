"""Tests — dédup de records (opt-in plan.dedupe). Dédup GLOBALE : ignore tout
record dont TOUS les champs sont identiques à un record déjà collecté sur
l'ensemble du run (utile quand des pages se chevauchent). L'index est reconstruit
au chargement -> reste cohérent après une reprise."""
from backend.bots.harvester.store import Store


def test_no_dedupe_keeps_duplicates_by_default(tmp_path):
    s = Store(str(tmp_path / "s.json"))            # dedupe off (défaut, rétro-compat)
    s.add_record({"x": "1"})
    s.add_record({"x": "1"})
    assert len(s.records()) == 2


def test_dedupe_drops_identical_records(tmp_path):
    s = Store(str(tmp_path / "s.json"), dedupe=True)
    assert s.add_record({"x": "1"}) is True
    assert s.add_record({"x": "1"}) is False       # doublon -> ignoré
    assert s.add_record({"x": "2"}) is True
    assert len(s.records()) == 2


def test_dedupe_is_field_order_insensitive(tmp_path):
    s = Store(str(tmp_path / "s.json"), dedupe=True)
    s.add_record({"a": "1", "b": "2"})
    assert s.add_record({"b": "2", "a": "1"}) is False   # même contenu, autre ordre
    assert len(s.records()) == 1


def test_dedupe_set_rebuilt_on_load_for_resume(tmp_path):
    # reprise : recharger le store puis re-fetcher une page déjà stockée -> skip
    p = str(tmp_path / "s.json")
    s = Store(p, dedupe=True)
    s.add_record({"x": "1"})
    s.save()
    s2 = Store.load(p, dedupe=True)
    assert s2.add_record({"x": "1"}) is False      # déjà présent depuis le chargement
    assert len(s2.records()) == 1


def test_load_without_dedupe_is_backward_compatible(tmp_path):
    p = str(tmp_path / "s.json")
    s = Store(p)
    s.add_record({"x": "1"})
    s.add_record({"x": "1"})
    s.save()
    s2 = Store.load(p)                              # dedupe off
    assert len(s2.records()) == 2
    assert s2.add_record({"x": "1"}) is True       # aucun dédup
