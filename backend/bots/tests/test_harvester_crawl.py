from backend.bots.harvester.crawl import absolute_url, parse_sitemap, next_page_url

SITEMAP = """<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://x.test/a.html</loc></url>
  <url><loc>https://x.test/b.html</loc></url>
</urlset>"""

SITEMAP_INDEX = """<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://x.test/sitemap1.xml</loc></sitemap>
  <sitemap><loc>https://x.test/sitemap2.xml</loc></sitemap>
</sitemapindex>"""

PAGE_WITH_NEXT = """
<html><body>
  <ul class="pager">
    <li class="next"><a href="page-2.html">next</a></li>
  </ul>
</body></html>"""

PAGE_NO_NEXT = "<html><body><ul class='pager'></ul></body></html>"


def test_absolute_url_resolves_relative():
    assert absolute_url("https://x.test/catalogue/page-1.html", "page-2.html") == \
        "https://x.test/catalogue/page-2.html"
    assert absolute_url("https://x.test/catalogue/page-1.html", "/z.html") == \
        "https://x.test/z.html"


def test_parse_sitemap_urlset():
    assert parse_sitemap(SITEMAP) == ["https://x.test/a.html", "https://x.test/b.html"]


def test_parse_sitemap_index():
    assert parse_sitemap(SITEMAP_INDEX) == \
        ["https://x.test/sitemap1.xml", "https://x.test/sitemap2.xml"]


def test_next_page_url_found():
    nxt = next_page_url(PAGE_WITH_NEXT, "https://x.test/catalogue/page-1.html",
                        {"tag": "li", "class": "next"})
    assert nxt == "https://x.test/catalogue/page-2.html"


def test_next_page_url_absent_returns_none():
    assert next_page_url(PAGE_NO_NEXT, "https://x.test/catalogue/page-1.html",
                         {"tag": "li", "class": "next"}) is None
