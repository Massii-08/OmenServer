"""No-PII gate, porté de Feedsmith (FieldPolicy). Pur, zéro dépendance."""
from typing import Any, Dict, Iterable

PII_FIELDS = frozenset({
    "name", "first_name", "last_name", "fullname",
    "email", "phone", "mobile",
    "address", "street",
    "ssn", "tax_id", "dob", "birthdate",
    "photo", "avatar",
    "ip", "ip_address",
    "user_id", "username", "profile_url",
})


class PolicyViolation(Exception):
    """Levée quand un record brut contient un champ PII interdit."""
    pass


class FieldPolicy:
    """Politique no-PII stricte : rejette tout record contenant un nom de champ
    PII, et ne garde que les clés explicitement autorisées (le reste est ignoré)."""

    def __init__(self, allowed: Iterable[str], pii_fields: frozenset = PII_FIELDS) -> None:
        self.allowed = set(allowed)
        self.pii_fields = pii_fields

    def validate(self, raw: Dict[str, Any]) -> Dict[str, Any]:
        for key in raw:
            if key.lower() in self.pii_fields:
                raise PolicyViolation(
                    "PII field '{0}' is not allowed in this feed".format(key)
                )
        return {k: v for k, v in raw.items() if k in self.allowed}
