import pytest
from backend.bots.harvester.policy import FieldPolicy, PolicyViolation, PII_FIELDS


def test_allows_clean_record_and_drops_unlisted():
    policy = FieldPolicy(allowed=["title", "price"])
    out = policy.validate({"title": "Book", "price": "£10", "junk": "x"})
    assert out == {"title": "Book", "price": "£10"}


def test_raises_on_pii_field_even_if_allowed():
    policy = FieldPolicy(allowed=["email"])
    with pytest.raises(PolicyViolation):
        policy.validate({"email": "x@example.com"})


def test_pii_check_is_case_insensitive():
    policy = FieldPolicy(allowed=["title"])
    with pytest.raises(PolicyViolation):
        policy.validate({"title": "Book", "Email": "x@example.com"})
    with pytest.raises(PolicyViolation):
        policy.validate({"PHONE": "12345"})


def test_every_known_pii_field_is_blocked():
    for pii in PII_FIELDS:
        policy = FieldPolicy(allowed=[pii])
        with pytest.raises(PolicyViolation):
            policy.validate({pii: "value"})
