from backend.bots.harvester.dom import parse_html, find_all, find_first, node_matches

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


def test_find_all_by_tag_and_class():
    root = parse_html(HTML)
    pods = find_all(root, {"tag": "article", "class": "product_pod"})
    assert len(pods) == 2


def test_find_first_descendant_and_attr():
    root = parse_html(HTML)
    pod = find_all(root, {"tag": "article", "class": "product_pod"})[0]
    a = find_first(pod, {"tag": "a"})
    assert a is not None
    assert a.get_attr("title") == "Book One"
    assert a.get_attr("href") == "cat/book1.html"


def test_text_is_whitespace_collapsed():
    root = parse_html(HTML)
    pod = find_all(root, {"tag": "article", "class": "product_pod"})[0]
    avail = find_first(pod, {"tag": "p", "class": "availability"})
    assert avail.text() == "In stock"


def test_classes_and_node_matches():
    root = parse_html(HTML)
    pod = find_all(root, {"tag": "article", "class": "product_pod"})[0]
    star = find_first(pod, {"tag": "p", "class": "star-rating"})
    assert star.classes() == ["star-rating", "Three"]
    assert node_matches(star, {"tag": "p", "class": "Three"}) is True
    assert node_matches(star, {"tag": "p", "class": "Five"}) is False


def test_void_elements_do_not_nest():
    root = parse_html("<div><img src='a.png'><p>after</p></div>")
    div = find_first(root, {"tag": "div"})
    # img is void -> p is a sibling of img, both direct children of div
    assert [c.tag for c in div.children] == ["img", "p"]


def test_implied_close_p_siblings():
    root = parse_html("<div><p>one<p>two</div>")
    div = find_first(root, {"tag": "div"})
    ps = [c for c in div.children if c.tag == "p"]
    assert len(ps) == 2
    assert ps[0].text() == "one"
    assert ps[1].text() == "two"


def test_implied_close_li_siblings():
    root = parse_html("<ul><li>one<li>two<li>three</ul>")
    ul = find_first(root, {"tag": "ul"})
    lis = [c for c in ul.children if c.tag == "li"]
    assert [li.text() for li in lis] == ["one", "two", "three"]


def test_block_element_closes_open_p():
    root = parse_html("<p>intro<div>block</div>")
    ps = find_all(root, {"tag": "p"})
    assert len(ps) == 1
    assert ps[0].text() == "intro"  # the div is NOT absorbed into p
    div = find_first(root, {"tag": "div"})
    assert div.text() == "block"


def test_table_implied_cells():
    root = parse_html("<table><tr><td>a<td>b</tr></table>")
    tds = find_all(root, {"tag": "td"})
    assert [td.text() for td in tds] == ["a", "b"]


def test_well_formed_p_unaffected():
    root = parse_html("<div><p>x</p><p>y</p></div>")
    div = find_first(root, {"tag": "div"})
    ps = [c for c in div.children if c.tag == "p"]
    assert [p.text() for p in ps] == ["x", "y"]
