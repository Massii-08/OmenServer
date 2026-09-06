"""Frais de courtage suisses simulés — PUR (aucun I/O, aucun réseau).

Pédagogie n°1 du module : l'utilisateur doit VOIR ce que coûte un aller-retour.
Trois profils réels, dont un courtier étranger (IBKR) qui échappe au droit de
timbre — c'est la comparaison qui enseigne.

Droit de timbre fédéral de négociation (Umsatzabgabe), dû à CHAQUE transaction
(achat ET vente) et uniquement chez un courtier SUISSE :
  * 0,075 % sur un titre suisse ;
  * 0,15 %  sur un titre étranger.

Les montants sont arrondis à 2 décimales (centimes) ; le total est la somme des
composantes DÉJÀ arrondies, pour que l'affichage soit cohérent avec le détail.
"""
from typing import Any, Dict, List, Optional, Tuple

# Taux du droit de timbre fédéral (part suisse, courtier suisse uniquement).
STAMP_DUTY_SWISS = 0.00075      # 0,075 % — titre suisse
STAMP_DUTY_FOREIGN = 0.0015     # 0,15 %  — titre étranger

SWISS_SUFFIX = ".SW"

# Paliers Swissquote : (montant maximum inclus, courtage CHF).
_SWISSQUOTE_TIERS: List[Tuple[float, float]] = [
    (1000.0, 9.0),
    (5000.0, 20.0),
    (10000.0, 30.0),
    (15000.0, 55.0),
    (25000.0, 80.0),
]
_SWISSQUOTE_ABOVE = 135.0

FEE_PROFILES: Dict[str, Dict[str, Any]] = {
    "yuh": {
        "label": "Yuh",
        "model": "percent",
        "rate": 0.005,            # 0,5 % du montant
        "min_chf": 1.0,
        "stamp_duty": True,       # courtier suisse
        "description": "0,5 % du montant, minimum 1 CHF, droit de timbre inclus.",
    },
    "swissquote": {
        "label": "Swissquote",
        "model": "tiers",
        "tiers": _SWISSQUOTE_TIERS,
        "above_chf": _SWISSQUOTE_ABOVE,
        "stamp_duty": True,       # courtier suisse
        "description": "Palier fixe selon le montant (9 a 135 CHF), droit de timbre inclus.",
    },
    "ibkr": {
        "label": "Interactive Brokers",
        "model": "percent",
        "rate": 0.0005,           # 0,05 % du montant
        "min_chf": 1.5,
        "stamp_duty": False,      # courtier etranger -> pas de droit de timbre
        "description": "0,05 % du montant, minimum 1,50 CHF, pas de droit de timbre.",
    },
}


def is_swiss_security(symbol: Optional[str]) -> bool:
    """Vrai si le ticker designe un titre coté en Suisse (suffixe Yahoo ``.SW``).

    C'est ce qui fait passer le droit de timbre de 0,15 % a 0,075 %.
    """
    if not symbol or not isinstance(symbol, str):
        return False
    return symbol.strip().upper().endswith(SWISS_SUFFIX)


def stamp_duty_rate(symbol: Optional[str]) -> float:
    """Taux du droit de timbre applicable au titre (hors profil de courtier)."""
    return STAMP_DUTY_SWISS if is_swiss_security(symbol) else STAMP_DUTY_FOREIGN


def _brokerage(profile: Dict[str, Any], amount_chf: float) -> float:
    """Courtage brut du profil pour ce montant (avant arrondi)."""
    if profile.get("model") == "tiers":
        for max_amount, fee in profile.get("tiers", []):
            if amount_chf <= max_amount:
                return float(fee)
        return float(profile.get("above_chf", 0.0))
    # modele pourcentage avec minimum
    raw = amount_chf * float(profile.get("rate", 0.0))
    return max(raw, float(profile.get("min_chf", 0.0)))


def compute_fees(profile: str, amount_chf: float, symbol: str) -> Dict[str, float]:
    """Frais complets d'UNE transaction (achat ou vente), en CHF.

    ``amount_chf`` est le montant brut de la transaction (qty x prix x fx), déjà
    en francs. Sa valeur absolue est utilisée : un montant négatif ne produit
    jamais un frais négatif.

    Un montant nul ou négatif ne coûte RIEN (pas de minimum de courtage fantôme
    sur une transaction inexistante).

    Retourne ``{"brokerage_chf", "stamp_duty_chf", "total_chf"}``.
    Lève ``ValueError`` si le profil est inconnu — un profil mal orthographié ne
    doit pas silencieusement rendre le trading gratuit.
    """
    key = (profile or "").strip().lower()
    if key not in FEE_PROFILES:
        raise ValueError(
            "profil de frais inconnu: %r (connus: %s)"
            % (profile, ", ".join(sorted(FEE_PROFILES)))
        )
    conf = FEE_PROFILES[key]

    try:
        amount = abs(float(amount_chf))
    except (TypeError, ValueError):
        raise ValueError("montant invalide: %r" % (amount_chf,))

    if amount <= 0.0:
        return {"brokerage_chf": 0.0, "stamp_duty_chf": 0.0, "total_chf": 0.0}

    brokerage = round(_brokerage(conf, amount), 2)
    duty = 0.0
    if conf.get("stamp_duty"):
        duty = round(amount * stamp_duty_rate(symbol), 2)
    return {
        "brokerage_chf": brokerage,
        "stamp_duty_chf": duty,
        "total_chf": round(brokerage + duty, 2),
    }


def round_trip_pct(profile: str, notional_chf: float,
                   symbol: Optional[str] = None) -> float:
    """Coût d'un ALLER-RETOUR (achat PUIS vente) sur ce profil, en % du
    montant — LOT 12 : la conscience des frais.

    Réutilise ``compute_fees`` DEUX FOIS (une jambe à l'entrée, une jambe à
    la sortie, même montant approximé pour les deux) — aucun barème n'est
    réinventé ici. ``symbol`` absent -> taux de timbre ÉTRANGER (le plus
    pénalisant, 0,15 % au lieu de 0,075 %) : c'est la doctrine déjà retenue
    ailleurs dans ce module (cf. ``gate_decision`` côté ``coach_trader`` :
    mieux vaut un plancher un peu large qu'un chiffre optimiste inventé).

    Un montant nul ou négatif ne coûte RIEN (même doctrine que
    :func:`compute_fees`). Profil inconnu -> ``ValueError``, comme
    :func:`compute_fees` : un profil mal orthographié ne doit pas
    silencieusement rendre le trading gratuit.
    """
    amount = abs(float(notional_chf)) if notional_chf is not None else 0.0
    # ``compute_fees`` valide le profil AVANT de regarder le montant (il lève
    # même à 0.0) : un seul appel suffit à la fois pour la validation et pour
    # le chiffre.
    leg = compute_fees(profile, amount, symbol or "")
    if amount <= 0.0:
        return 0.0
    return round(leg["total_chf"] * 2.0 / amount * 100.0, 4)


def list_profiles() -> List[Dict[str, Any]]:
    """Catalogue public des profils (pour le sélecteur du dashboard)."""
    return [
        {
            "id": key,
            "label": conf["label"],
            "stamp_duty": bool(conf.get("stamp_duty")),
            "description": conf.get("description", ""),
        }
        for key, conf in sorted(FEE_PROFILES.items())
    ]
