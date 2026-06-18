from backend.bots.harvester.setup import (
    PACING_BY_TIER, build_setup, build_setup_prompt, pacing_for, probe_difficulty,
)

SAMPLE_HTML = """
<section><ol class="row">
  <li><article class="product_pod">
    <h3><a href="b1.html" title="Book One">Book One ...</a></h3>
    <p class="price_color">£51.77</p>
  </article></li>
  <li><article class="product_pod">
    <h3><a href="b2.html" title="Book Two">Book Two ...</a></h3>
    <p class="price_color">£10.00</p>
  </article></li>
</ol></section>
"""

GENERATED = {
    "recipe": {
        "item_selector": {"tag": "article", "class": "product_pod"},
        "fields": {
            "title": {"selector": [{"tag": "h3"}, {"tag": "a"}], "extract": "attr:title"},
            "price": {"selector": {"tag": "p", "class": "price_color"}, "extract": "text"},
        },
    },
    "plan": {"mode": "pagination", "next_selector": {"tag": "li", "class": "next"}},
    "pacing": {"min_interval_s": 2.0, "jitter": [1.0, 3.0]},
}


def test_probe_difficulty_tiers():
    assert probe_difficulty(200, {}) == "facile"
    assert probe_difficulty(200, {"CF-Ray": "abc", "Server": "cloudflare"}) == "moyen"
    assert probe_difficulty(429, {}) == "dur"
    assert probe_difficulty(200, {"Retry-After": "30"}) == "dur"


def test_pacing_for_known_and_unknown_tier():
    assert pacing_for("facile") == PACING_BY_TIER["facile"]
    assert pacing_for("moyen") == PACING_BY_TIER["moyen"]
    assert pacing_for("zzz") == PACING_BY_TIER["facile"]  # safe default


def test_build_setup_prompt_includes_url_instructions_grammar_and_html():
    p = build_setup_prompt("https://x.test/p1", "get title and price",
                           "<article class='product_pod'>hi</article>", "facile")
    assert "https://x.test/p1" in p
    assert "get title and price" in p
    assert "item_selector" in p and "fields" in p           # output schema
    assert "attr:" in p and "class:" in p                   # extract grammar
    assert "product_pod" in p                               # sample html embedded


def test_build_setup_runs_recipe_on_sample_and_returns_preview():
    seen = {}

    def fake_fetch_full(url):
        seen["url"] = url
        return (200, {"Server": "nginx"}, SAMPLE_HTML)

    def fake_claude(prompt):
        seen["prompt"] = prompt
        return GENERATED

    out = build_setup("https://x.test/p1", "title + price",
                      fetch_full=fake_fetch_full, claude=fake_claude)
    assert seen["url"] == "https://x.test/p1"
    assert out["difficulty"] == "facile"
    assert out["recipe"] == GENERATED["recipe"]
    assert out["plan"] == GENERATED["plan"]
    assert out["pacing"] == GENERATED["pacing"]
    assert out["sample"] == [
        {"title": "Book One", "price": "£51.77"},
        {"title": "Book Two", "price": "£10.00"},
    ]


def test_build_setup_falls_back_to_tier_pacing_when_llm_omits_it():
    def fake_fetch_full(url):
        return (429, {}, SAMPLE_HTML)   # -> "dur"

    def fake_claude(prompt):
        return {"recipe": GENERATED["recipe"], "plan": GENERATED["plan"]}  # no pacing

    out = build_setup("https://x.test/p1", "x",
                      fetch_full=fake_fetch_full, claude=fake_claude)
    assert out["difficulty"] == "dur"
    assert out["pacing"] == PACING_BY_TIER["dur"]


def test_build_setup_caps_sample_to_ten():
    rows = "".join(
        '<li><article class="product_pod"><h3><a title="t{0}">t</a></h3>'
        '<p class="price_color">£1</p></article></li>'.format(i) for i in range(25)
    )
    html = "<ol>" + rows + "</ol>"

    def fake_fetch_full(url):
        return (200, {}, html)

    def fake_claude(prompt):
        return GENERATED

    out = build_setup("u", "x", fetch_full=fake_fetch_full, claude=fake_claude)
    assert len(out["sample"]) == 10
