"""Tests C — politesse robots.txt (Crawl-delay comme plancher de pacing)."""
from backend.bots.harvester.robots import (
    fetch_crawl_delay, parse_crawl_delay, resolve_base_interval,
)

_ROBOTS = """
# exemple
User-agent: *
Crawl-delay: 5
Disallow: /private

User-agent: BadBot
Crawl-delay: 60
"""


def test_parse_star_crawl_delay():
    assert parse_crawl_delay(_ROBOTS, "OmenHarvester/0.1") == 5.0


def test_parse_specific_ua_wins_over_star():
    txt = "User-agent: *\nCrawl-delay: 2\nUser-agent: omenharvester\nCrawl-delay: 9\n"
    assert parse_crawl_delay(txt, "OmenHarvester/0.1 polite") == 9.0


def test_parse_no_crawl_delay_returns_none():
    assert parse_crawl_delay("User-agent: *\nDisallow: /x\n") is None


def test_parse_empty_or_garbage():
    assert parse_crawl_delay("", "x") is None
    assert parse_crawl_delay("not a robots file", "x") is None


def test_parse_ignores_non_numeric_delay():
    assert parse_crawl_delay("User-agent: *\nCrawl-delay: soon\n", "x") is None


def test_fetch_crawl_delay_uses_origin_robots():
    seen = {}

    def fake_get(url):
        seen["url"] = url
        return "User-agent: *\nCrawl-delay: 7\n"

    cd = fetch_crawl_delay("https://site.test/deep/page-1.html", fake_get)
    assert cd == 7.0
    assert seen["url"] == "https://site.test/robots.txt"


def test_fetch_crawl_delay_best_effort_on_error():
    def boom(url):
        raise RuntimeError("network down")
    assert fetch_crawl_delay("https://site.test/x", boom) is None


def test_fetch_crawl_delay_bad_url():
    assert fetch_crawl_delay("notaurl", lambda u: "") is None


def test_resolve_base_interval_floors_to_crawl_delay():
    got = resolve_base_interval(1.5, "https://s.test/p",
                                lambda u: "User-agent: *\nCrawl-delay: 8\n")
    assert got == 8.0


def test_resolve_base_interval_keeps_configured_when_higher():
    got = resolve_base_interval(12.0, "https://s.test/p",
                                lambda u: "User-agent: *\nCrawl-delay: 3\n")
    assert got == 12.0


def test_resolve_base_interval_no_robots_get_is_passthrough():
    assert resolve_base_interval(1.5, "https://s.test/p", None) == 1.5
