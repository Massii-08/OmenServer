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
