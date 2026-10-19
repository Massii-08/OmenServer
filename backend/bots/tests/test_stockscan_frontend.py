"""Scanner d'actions — l'écran, lu au texte (le frontend est en vanilla JS,
sans banc d'essai JS dans le dépôt : même méthode que test_tvcoach_lot_f)."""
import re
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[3]
_LANG_JS = _ROOT / "frontend" / "js" / "lang.js"


def _lang_blocks():
    """``{"fr": "…", "en": "…", "it": "…"}`` — le corps de chaque table de
    traduction de ``lang.js``, découpé sur ses en-têtes ``fr:``/``en:``/``it:``."""
    source = _LANG_JS.read_text(encoding="utf-8")
    heads = [(m.group(1), m.start()) for m in
             re.finditer(r"^        (fr|en|it): \{$", source, re.M)]
    assert [h[0] for h in heads] == ["fr", "en", "it"], heads
    bounds = [h[1] for h in heads] + [len(source)]
    return {heads[i][0]: source[bounds[i]:bounds[i + 1]] for i in range(len(heads))}


def _label(block, key):
    found = re.search(r"'%s': '((?:[^'\\]|\\.)*)'," % re.escape(key), block)
    return found.group(1) if found else None


# Le volume est rapporté à la médiane de SON marché (volume « à l'heure ») :
# un « ×2 » sans dire « par rapport à quoi » se lirait comme avant (10 j).
VOLUME_LABELS = {
    "fr": ("vol. rel. ×{v} vs son marché (brut ×{raw})", "Volume ×{v} vs son marché"),
    "en": ("rel. vol. ×{v} vs its market (raw ×{raw})", "Volume ×{v} vs its market"),
    "it": ("vol. rel. ×{v} rispetto al suo mercato (grezzo ×{raw})",
           "Volume ×{v} rispetto al suo mercato"),
}


@pytest.mark.parametrize("lang", ("fr", "en", "it"))
def test_volume_labels_say_what_the_volume_is_compared_to(lang):
    block = _lang_blocks()[lang]
    adjusted, reason = VOLUME_LABELS[lang]
    assert _label(block, "stocks.rel_volume_adj") == adjusted
    assert _label(block, "stocks.reason.volume") == reason


@pytest.mark.parametrize("lang", ("fr", "en", "it"))
def test_the_two_removed_session_warnings_have_no_label_left(lang):
    block = _lang_blocks()[lang]
    assert "stocks.rwarn.volume_adjusted" not in block
    assert "stocks.rwarn.session_uncertain" not in block


def test_frontend_versions_were_bumped():
    """Sans le bump, le service worker sert l'ancien ``lang.js`` / module et
    les nouveaux libellés n'apparaissent jamais (piège #9 du dépôt). MONOTONE :
    un bump suivant ne doit pas rendre ce test rouge."""
    index = (_ROOT / "frontend" / "index.html").read_text(encoding="utf-8")
    sw = (_ROOT / "frontend" / "sw.js").read_text(encoding="utf-8")

    def _v(pattern, text):
        found = re.search(pattern, text)
        assert found, pattern
        return int(found.group(1))
    assert _v(r"/js/lang\.js\?v=(\d+)", index) >= 301
    assert _v(r"/js/stockscan_module\.js\?v=(\d+)", index) >= 6
    assert _v(r"omenserver-v(\d+)", sw) >= 200
