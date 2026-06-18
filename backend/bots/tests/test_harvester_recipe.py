from backend.bots.harvester.recipe import Recipe

HTML = """
<html><body>
  <article class="product_pod">
    <h3><a href="cat/book1.html" title="Book One">Book One trunc</a></h3>
    <p class="price_color">£51.77</p>
    <p class="instock availability">  In stock  </p>
    <p class="star-rating Three"></p>
  </article>
  <article class="product_pod">
    <h3><a href="cat/book2.html" title="Book Two">Book Two trunc</a></h3>
    <p class="price_color">£10.00</p>
    <p class="instock availability">In stock</p>
    <p class="star-rating One"></p>
  </article>
</body></html>
"""

RECIPE = {
    "item_selector": {"tag": "article", "class": "product_pod"},
    "fields": {
        "title": {"selector": {"tag": "a"}, "extract": "attr:title"},
        "url": {"selector": {"tag": "a"}, "extract": "attr:href"},
        "price": {"selector": {"tag": "p", "class": "price_color"}, "extract": "text"},
        "availability": {"selector": {"tag": "p", "class": "availability"}, "extract": "text"},
        "rating": {"selector": {"tag": "p", "class": "star-rating"}, "extract": "class:1"},
    },
}


def test_from_dict_roundtrip():
    r = Recipe.from_dict(RECIPE)
    assert r.to_dict() == RECIPE
    assert sorted(r.field_names()) == ["availability", "price", "rating", "title", "url"]


def test_extract_two_records():
    r = Recipe.from_dict(RECIPE)
    records = r.extract(HTML)
    assert records == [
        {"title": "Book One", "url": "cat/book1.html", "price": "£51.77",
         "availability": "In stock", "rating": "Three"},
        {"title": "Book Two", "url": "cat/book2.html", "price": "£10.00",
         "availability": "In stock", "rating": "One"},
    ]


def test_missing_node_yields_empty_string():
    r = Recipe.from_dict({
        "item_selector": {"tag": "article", "class": "product_pod"},
        "fields": {"missing": {"selector": {"tag": "span", "class": "nope"}, "extract": "text"}},
    })
    records = r.extract(HTML)
    assert records == [{"missing": ""}, {"missing": ""}]


def test_extract_from_item_itself_when_no_selector():
    r = Recipe.from_dict({
        "item_selector": {"tag": "p", "class": "price_color"},
        "fields": {"price": {"extract": "text"}},
    })
    assert r.extract(HTML) == [{"price": "£51.77"}, {"price": "£10.00"}]


# Structure RÉELLE de books.toscrape : l'ancre IMAGE (sans title) précède
# l'ancre du titre dans <h3>. Un sélecteur {tag:'a'} simple tombe sur l'image.
REAL_HTML = """
<section><ol class="row">
  <li><article class="product_pod">
    <div class="image_container"><a href="catalogue/book_1/index.html"><img class="thumbnail"></a></div>
    <p class="star-rating Three"></p>
    <h3><a href="catalogue/book_1/index.html" title="A Light in the Attic">A Light in the ...</a></h3>
    <div class="product_price"><p class="price_color">£51.77</p>
      <p class="instock availability">In stock</p></div>
  </article></li>
</ol></section>
"""


def test_single_anchor_selector_grabs_wrong_anchor():
    # documents the limitation that motivated descendant chains
    r = Recipe.from_dict({
        "item_selector": {"tag": "article", "class": "product_pod"},
        "fields": {"title": {"selector": {"tag": "a"}, "extract": "attr:title"}},
    })
    assert r.extract(REAL_HTML) == [{"title": ""}]  # image anchor has no title


def test_descendant_chain_selector_picks_h3_anchor():
    r = Recipe.from_dict({
        "item_selector": {"tag": "article", "class": "product_pod"},
        "fields": {
            "title": {"selector": [{"tag": "h3"}, {"tag": "a"}], "extract": "attr:title"},
            "price": {"selector": {"tag": "p", "class": "price_color"}, "extract": "text"},
            "rating": {"selector": {"tag": "p", "class": "star-rating"}, "extract": "class:1"},
        },
    })
    assert r.extract(REAL_HTML) == [
        {"title": "A Light in the Attic", "price": "£51.77", "rating": "Three"},
    ]


def test_chain_with_missing_intermediate_yields_empty():
    r = Recipe.from_dict({
        "item_selector": {"tag": "article", "class": "product_pod"},
        "fields": {"x": {"selector": [{"tag": "nope"}, {"tag": "a"}], "extract": "attr:title"}},
    })
    assert r.extract(REAL_HTML) == [{"x": ""}]
