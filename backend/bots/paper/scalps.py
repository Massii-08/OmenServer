"""Ledger des SCALPS de l'extension TradingView (LOT D, spec §5.4 / §6.2-6.3).

Un scalp, ici, c'est un aller-retour de trois à quatre minutes exécuté DANS
l'extension sur le prix live de la page (décision D8) : l'extension l'ouvre,
échantillonne le prix à 1 Hz, le ferme, et poste le tout. Ce module est ce que
le serveur en fait.

Doctrine du lot, en trois phrases :

1. **Le serveur RECALCULE tout.** Le client envoie des faits bruts (prix,
   horodatages, échantillons) ; le P&L, les frais, les excursions et la durée
   sont refaits ici. Aucun chiffre d'argent venu du navigateur n'est cru.
2. **Un chiffre invérifiable n'est pas inventé.** Sans cotation serveur, aucun
   contrôle de prix (plutôt que d'inventer un refus) ; sans échantillon, MAE et
   MFE valent ``None`` (plutôt qu'un ``0.0`` qui prétendrait avoir mesuré).
3. **Les formules d'argent ne sont écrites qu'une fois.** Les frais passent par
   ``fees.compute_fees`` (une fois par jambe, comme ``fees.round_trip_pct``),
   la conversion par ``quotes.fx_to_chf``, les excursions par
   ``tradestats.excursions``. Rien n'est recopié ici.

**Post-mortem LLM automatique : DÉSACTIVÉ pour les scalps** (spec §5.4) — le
plafond de 6 par jour serait brûlé en une heure de session. À la place, un
bilan de session (``POST /scalps/review``), plafonné à trois par jour et dont
le compteur vit dans ce même fichier.

**Horodatages** : tout ce qui entre est normalisé en ``datetime`` *aware* UTC
dès la validation. Un ``ts`` sans offset est lu comme de l'heure LOCALE (c'est
ce qu'un navigateur produit quand il sérialise mal) ; un naïf et un aware ne se
comparent jamais directement. Les dates de « journée » (stats du jour, plafond
des bilans), elles, sont calculées sur le calendrier LOCAL : une session de
scalping se raconte dans le fuseau où elle a été vécue, pas en UTC.

Persistance : ``data/paper_trading/<user>.scalps.json`` (même convention que
``<user>.ledger.json``/``<user>.alerts.json``), écriture atomique 0o600 par
``store._atomic_write_json``, plafond de 500 lignes GLISSANT. Les scalps sont
privés, comme les positions — rien n'est partagé entre traders (spec §10).
"""
import threading
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from backend.bots.paper import fees, models, quotes, store, tradestats

# --------------------------------------------------------------------------- #
# Seuils (spec §5.4 et §6.3)
# --------------------------------------------------------------------------- #
SIDES = ("buy", "sell")

MAX_SAMPLES = 600               # ce que l'extension peut poster (10 min à 1 Hz)
MAX_SCALPS = 500                # plafond glissant du ledger
PRICE_TOLERANCE_PCT = 5.0       # écart maximum à la cotation serveur
TS_WINDOW_S = 24 * 3600         # un scalp de plus de 24 h n'existe pas
MAX_REVIEWS_PER_DAY = 3         # bilans de session par jour et par compte
CONTEXT_SCALPS = 20             # scalps du jour envoyés au prompt de bilan

# Frais : profil de repli quand celui demandé est inconnu du catalogue (celui-ci
# grossit dans un autre lot — un profil pas encore livré ne doit ni faire
# tomber la requête, ni rendre le trading gratuit).
FALLBACK_PROFILE = models.DEFAULT_FEE_PROFILE
MAX_CUSTOM_PCT = 10.0           # au-delà, la saisie est une faute de frappe

# Biais (plan §4, Task 9) — ordre CANONIQUE de restitution.
BIAS_CODES = ("revenge_trade", "overtrading", "fee_bleed", "let_losers_run")
REVENGE_WINDOW_S = 10 * 60      # rouvrir moins de 10 min après un perdant
OVERTRADING_PER_HOUR = 6        # STRICTEMENT plus de 6 dans l'heure
FEE_BLEED_RATIO = 0.5           # frais du jour > 50 % du brut gagné
LOSER_DURATION_RATIO = 1.5      # perdants tenus 1,5 x plus longtemps

# Discipline : score propre 0-100 (``tradestats.discipline_score`` ne convient
# pas — il note un stop planifié, une thèse écrite et un profit factor sur
# >= 5 trades CLÔTURÉS du portefeuille, trois choses qu'un scalp de trois
# minutes ne porte pas).
BIAS_PENALTY = 10               # par biais détecté sur la journée
DAILY_LOSS_PENALTY = 20         # si la perte réalisée du jour touche le seuil
DAILY_LOSS_PCT = 2.0            # -2 % de l'équité (garde-fou ``daily_loss``)

# Un seul verrou pour tout le fichier d'état : ``record`` et les deux
# opérations du compteur de bilans sont des lire-modifier-réécrire, et deux
# travaux détachés du même compte peuvent finir en même temps.
_LOCK = threading.RLock()


class ScalpRefused(ValueError):
    """Refus de validation PORTEUR D'UN CODE — le panneau affiche un message
    précis, pas un « 400 » nu. ``code`` fait partie du contrat d'API."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


class ReviewCapReached(RuntimeError):
    """Le quota de bilans de session du jour est épuisé (429 côté router)."""


# --------------------------------------------------------------------------- #
# Helpers numériques et horodatages
# --------------------------------------------------------------------------- #
def _val(value: Any) -> Optional[float]:
    """``float`` ou ``None`` — jamais une exception, jamais un booléen déguisé
    en nombre (même garantie que ``tradestats._val``)."""
    if value is None or isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def utc_now() -> datetime:
    """L'instant courant, *aware* UTC. Fonction de MODULE -> monkeypatchable
    (aucun test de ce lot ne dépend de l'horloge réelle)."""
    return datetime.now(timezone.utc)


def parse_ts(value: Any, code: str = "bad_ts") -> datetime:
    """ISO -> ``datetime`` *aware* UTC. Lève :class:`ScalpRefused`.

    Deux formes arrivent de l'extension : avec offset (``…+02:00``, ``…Z``) ou
    sans. **Sans offset, c'est de l'heure LOCALE** — la convertir en la
    déclarant UTC décalerait chaque scalp d'une ou deux heures selon la saison,
    et le décalage ne se verrait qu'à la frontière de journée. ``astimezone``
    sur un naïf fait exactement la bonne lecture (Python présume le fuseau
    système).

    Le suffixe ``Z`` est réécrit ``+00:00`` : ``datetime.fromisoformat`` de
    Python 3.9 ne le lit pas.
    """
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc)
    text = str(value or "").strip()
    if not text:
        raise ScalpRefused(code, "horodatage manquant")
    if text[-1:] in ("Z", "z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        raise ScalpRefused(code, "horodatage illisible: %r" % (value,))
    return parsed.astimezone(timezone.utc)


def _parse_ts_safe(value: Any) -> Optional[datetime]:
    """Comme :func:`parse_ts`, mais ``None`` au lieu d'un refus — pour relire
    le ledger déjà écrit (une ligne illisible ne doit pas faire tomber une
    statistique, elle doit juste ne pas compter)."""
    try:
        return parse_ts(value)
    except ScalpRefused:
        return None


def to_utc_iso(moment: datetime) -> str:
    """``datetime`` -> ISO *aware* UTC à la seconde (ce qui est écrit au
    ledger : un horodatage stocké sans offset serait ambigu pour toujours)."""
    return moment.astimezone(timezone.utc).isoformat(timespec="seconds")


def _local_date(moment: datetime) -> date:
    """La date CALENDAIRE locale de cet instant — « aujourd'hui » se compte
    dans le fuseau où la session a été vécue, pas en UTC (à Zurich, une
    frontière de jour UTC couperait la journée de scalping à 02h00)."""
    return moment.astimezone().date()


# --------------------------------------------------------------------------- #
# Validation (spec §5.4 : le serveur reste AUTORITAIRE)
# --------------------------------------------------------------------------- #
def _clean_samples(raw: Any) -> List[Tuple[datetime, float]]:
    """Les échantillons de prix, normalisés et VÉRIFIÉS.

    - plus de :data:`MAX_SAMPLES` -> ``too_many_samples`` (compté sur la liste
      BRUTE : c'est le volume posté qu'on borne, pas ce qui en survit) ;
    - horodatages décroissants -> ``samples_unsorted`` (un ordre cassé fausse
      le MAE/MFE, donc on refuse) ;
    - un échantillon malformé (mauvaise forme, prix illisible, ts illisible)
      est IGNORÉ en silence : il ne porte pas d'argent, et jeter tout le scalp
      pour un tick abîmé ferait perdre une trace qu'on ne retrouvera jamais.
    """
    if raw is None:
        return []
    if not isinstance(raw, (list, tuple)):
        return []
    if len(raw) > MAX_SAMPLES:
        raise ScalpRefused("too_many_samples",
                           "trop d'échantillons: %d (maximum %d)"
                           % (len(raw), MAX_SAMPLES))
    out: List[Tuple[datetime, float]] = []
    previous: Optional[datetime] = None
    for item in raw:
        if not isinstance(item, (list, tuple)) or len(item) < 2:
            continue
        moment = _parse_ts_safe(item[0])
        price = _val(item[1])
        if moment is None or price is None or price <= 0:
            continue
        if previous is not None and moment < previous:
            raise ScalpRefused("samples_unsorted",
                               "échantillons non triés par horodatage")
        previous = moment
        out.append((moment, price))
    return out


def _custom_pct(value: Any) -> Optional[float]:
    """Le pourcentage de frais saisi à la main (profil ``custom``, spec §6.4).
    Hors de ``[0, MAX_CUSTOM_PCT]`` ou illisible -> ``None`` (le profil retombe
    alors sur le repli, avec son drapeau)."""
    pct = _val(value)
    if pct is None or pct < 0 or pct > MAX_CUSTOM_PCT:
        return None
    return pct


def validate(payload: Any, server_price: Any = None,
             now: Optional[datetime] = None) -> Dict[str, Any]:
    """Contrôle la charge utile d'un scalp et la NORMALISE.

    Lève :class:`ScalpRefused` (code + message) pour les six refus du contrat :
    ``bad_side``, ``bad_qty``, ``bad_price``, ``ts_out_of_window``,
    ``exit_before_entry``, ``too_many_samples``/``samples_unsorted`` et
    ``price_off_market``.

    ``server_price`` est la cotation que le serveur connaît, INJECTÉE par
    l'appelant (aucun réseau ici). ``None`` = cotation inconnue -> **aucun**
    contrôle de prix : refuser un scalp parce qu'une source est muette ferait
    perdre la trace d'un vrai trade (spec §11 : source morte = champ nul,
    jamais une décision inventée).

    Rend un dictionnaire prêt pour :func:`settle` (les instants y sont des
    ``datetime`` *aware* UTC, pas des chaînes).
    """
    moment = now or utc_now()
    data = payload if isinstance(payload, dict) else {}

    side = str(data.get("side") or "").strip().lower()
    if side not in SIDES:
        raise ScalpRefused("bad_side",
                           "sens invalide: %r (attendu buy ou sell)"
                           % (data.get("side"),))

    qty = _val(data.get("qty"))
    if qty is None or qty <= 0:
        raise ScalpRefused("bad_qty",
                           "quantité invalide: %r" % (data.get("qty"),))

    entry = data.get("entry") if isinstance(data.get("entry"), dict) else {}
    exit_ = data.get("exit") if isinstance(data.get("exit"), dict) else {}
    entry_price = _val(entry.get("price"))
    exit_price = _val(exit_.get("price"))
    if entry_price is None or entry_price <= 0 \
            or exit_price is None or exit_price <= 0:
        raise ScalpRefused("bad_price", "prix d'entrée ou de sortie invalide")

    entry_dt = parse_ts(entry.get("ts"))
    exit_dt = parse_ts(exit_.get("ts"))
    for label, when in (("entry", entry_dt), ("exit", exit_dt)):
        if abs((moment - when).total_seconds()) > TS_WINDOW_S:
            raise ScalpRefused(
                "ts_out_of_window",
                "horodatage %s hors des 24 dernières heures" % label)
    if exit_dt < entry_dt:
        raise ScalpRefused("exit_before_entry",
                           "la sortie précède l'entrée")

    reference = _val(server_price)
    if reference is not None and reference > 0:
        for label, price in (("entrée", entry_price), ("sortie", exit_price)):
            gap = abs(price - reference) / reference * 100.0
            if gap > PRICE_TOLERANCE_PCT:
                raise ScalpRefused(
                    "price_off_market",
                    "prix de %s %.4f à %.2f %% de la cotation serveur "
                    "(%.4f), au-delà des ±%.0f %%"
                    % (label, price, gap, reference, PRICE_TOLERANCE_PCT))

    # Hoisté : cette fonction peut REFUSER (``too_many_samples``,
    # ``samples_unsorted``), et un refus caché dans un littéral se lit mal.
    samples = _clean_samples(data.get("samples"))

    emotion = str(data.get("emotion") or "").strip()
    note = str(data.get("note") or "").strip()

    return {
        "client_id": str(data.get("client_id") or "").strip()[:64],
        "symbol": str(data.get("symbol") or "").strip()[:32],
        "tv_symbol": str(data.get("tv_symbol") or "").strip()[:64],
        "side": side,
        "qty": qty,
        "entry_price": entry_price,
        "entry_dt": entry_dt,
        "exit_price": exit_price,
        "exit_dt": exit_dt,
        "samples": samples,
        "fee_profile": str(data.get("fee_profile") or "").strip().lower(),
        "custom_pct": _custom_pct(data.get("custom_pct")),
        # Whitelist FERMÉE (``models.EMOTIONS``) : une étiquette fantaisiste
        # polluerait les regroupements par émotion du journal.
        "emotion": emotion if emotion in models.EMOTIONS else None,
        "note": note[:500],
    }


# --------------------------------------------------------------------------- #
# Recalcul (settle) — le serveur refait TOUS les chiffres
# --------------------------------------------------------------------------- #
def resolve_profile(profile: Any) -> Tuple[str, bool]:
    """``(profil effectif, repli utilisé)``.

    Le catalogue ``fees.FEE_PROFILES`` gagne ses entrées de scalping
    (``tv_paper``, ``kraken_spot``, ``kraken_futures``, ``custom``) dans un
    AUTRE lot. Un profil qu'il ne connaît pas retombe donc sur
    :data:`FALLBACK_PROFILE` **avec un drapeau** : ni exception (le scalp
    serait perdu alors que le trade, lui, a bien eu lieu), ni silence (les
    frais seraient sous-estimés sans que personne le sache).
    """
    key = str(profile or "").strip().lower()
    if key in fees.FEE_PROFILES:
        return key, False
    return FALLBACK_PROFILE, True


def _leg_fee_chf(profile: str, amount_chf: float, symbol: str,
                 custom_pct: Optional[float]) -> float:
    """Frais d'UNE jambe, en francs. Appelée deux fois (entrée puis sortie) —
    exactement le patron de ``fees.round_trip_pct``.

    **Aucun barème n'est écrit ici**, pas même celui du profil ``custom`` :
    ``fees`` sait déjà appliquer un taux saisi par côté (§6.4). Le
    ``custom_pct`` n'est transmis que si le profil se déclare réinscriptible
    (clé ``custom`` de sa fiche) — ce qui vaut aussi contrôle de version du
    catalogue : un catalogue qui ne connaît pas encore le taux saisi n'a pas
    non plus cette clé, et l'appel reste à trois arguments.
    """
    conf = fees.FEE_PROFILES.get(profile) or {}
    if custom_pct is not None and conf.get("custom"):
        return fees.compute_fees(profile, amount_chf, symbol,
                                 custom_pct=custom_pct)["total_chf"]
    return fees.compute_fees(profile, amount_chf, symbol)["total_chf"]


def _excursions(clean: Dict[str, Any]) -> Dict[str, Optional[float]]:
    """MAE/MFE par ``tradestats.excursions`` sur des pseudo-bougies bâties
    depuis les échantillons (chaque tick = une bougie ``o=h=l=c``).

    Sans échantillon, ``tradestats`` rend ``{}`` et on rend ``None`` : un
    ``0.0`` prétendrait avoir mesuré une excursion nulle alors qu'on n'a rien
    mesuré du tout (sa doctrine, reprise telle quelle).

    Les échantillons ne sont PAS refiltrés sur la fenêtre entrée/sortie : c'est
    l'extension qui échantillonne, et exactement pendant le scalp. Deux limites
    assumées — un client bogué qui déborderait la fenêtre élargirait ses
    propres excursions (sans toucher au P&L, lui recalculé), et ``tradestats``
    arrondit à deux décimales, ce qui est grossier pour un mouvement de trois
    minutes (0,004 % s'affiche 0,0).
    """
    candles = [{"open": price, "high": price, "low": price, "close": price}
               for _, price in clean.get("samples") or []]
    side = "long" if clean.get("side") == "buy" else "short"
    out = tradestats.excursions(candles, clean.get("entry_price"), side)
    return {"mae_pct": out.get("mae_pct"), "mfe_pct": out.get("mfe_pct")}


def settle(clean: Dict[str, Any], fee_profile: Any = None,
           custom_pct: Any = None, currency: Any = None,
           fx: Any = None) -> Dict[str, Any]:
    """Le RECALCUL complet d'un scalp validé -> la ligne du ledger.

    - brut = ``(sortie − entrée) × qty × (+1 achat / −1 vente) × fx`` ;
    - frais = :func:`_leg_fee_chf` à l'entrée **et** à la sortie ;
    - net = brut − frais ; ``pnl_pct`` = net rapporté au montant ENGAGÉ à
      l'entrée (c'est le rendement du capital immobilisé, pas la variation du
      cours : sur un scalp, les frais pèsent plus que le mouvement) ;
    - MAE/MFE par :func:`_excursions`, durée par différence d'horodatages.

    ``fx`` est le convertisseur devise -> CHF, INJECTABLE (défaut :
    ``quotes.fx_to_chf``, qui parle réseau — les tests passent le leur). Une
    devise inconnue fait remonter la ``QuoteError`` de ``quotes`` : sans taux,
    le montant en francs serait inventé, et le router en fait un 502 (doctrine
    déjà en place pour les ordres).
    """
    asked = fee_profile if fee_profile is not None else clean.get("fee_profile")
    pct = _custom_pct(custom_pct) if custom_pct is not None \
        else clean.get("custom_pct")
    profile, fallback = resolve_profile(asked)

    code = str(currency or clean.get("currency") or "CHF").strip().upper() or "CHF"
    if code == "CHF":
        rate = 1.0
    else:
        convert = fx if fx is not None else quotes.fx_to_chf
        rate = float(convert(code))
        if rate <= 0:
            raise quotes.QuoteError("taux %s->CHF invalide: %r" % (code, rate))

    entry_price = float(clean["entry_price"])
    exit_price = float(clean["exit_price"])
    qty = float(clean["qty"])
    symbol = str(clean.get("symbol") or "")
    direction = 1.0 if clean["side"] == "buy" else -1.0

    entry_amount = entry_price * qty * rate
    exit_amount = exit_price * qty * rate
    gross = round((exit_price - entry_price) * qty * direction * rate, 2)
    fees_chf = round(_leg_fee_chf(profile, entry_amount, symbol, pct)
                     + _leg_fee_chf(profile, exit_amount, symbol, pct), 2)
    pnl = round(gross - fees_chf, 2)

    excursions = _excursions(clean)
    duration_s = int(round(
        (clean["exit_dt"] - clean["entry_dt"]).total_seconds()))

    return {
        "client_id": clean.get("client_id") or "",
        "symbol": symbol,
        "tv_symbol": clean.get("tv_symbol") or "",
        "side": clean["side"],
        "qty": qty,
        "entry_price": entry_price,
        "entry_ts": to_utc_iso(clean["entry_dt"]),
        "exit_price": exit_price,
        "exit_ts": to_utc_iso(clean["exit_dt"]),
        "duration_s": duration_s,
        "currency": code,
        "fx_rate": rate,
        "fee_profile": profile,
        "fee_profile_asked": str(asked or "").strip().lower(),
        "fee_profile_fallback": bool(fallback),
        "custom_pct": pct,
        "gross_chf": gross,
        "fees_chf": fees_chf,
        "pnl_chf": pnl,
        "pnl_pct": round(pnl / entry_amount * 100.0, 4) if entry_amount > 0 else None,
        "mae_pct": excursions["mae_pct"],
        "mfe_pct": excursions["mfe_pct"],
        "n_samples": len(clean.get("samples") or []),
        "note": clean.get("note") or "",
        "emotion": clean.get("emotion"),
    }


# --------------------------------------------------------------------------- #
# Persistance — ``data/paper_trading/<user>.scalps.json``
# --------------------------------------------------------------------------- #
def scalps_path(username: str) -> Path:
    """Chemin du ledger de scalps (nom d'utilisateur VALIDÉ par ``store``).

    Le chemin est construit ici plutôt qu'ajouté à ``store`` : ce lot ne
    possède pas ``store.py`` (il est édité par d'autres lots en parallèle).
    ``store.DATA_DIR`` est lu à CHAQUE appel — c'est ce que les tests
    redirigent sur ``tmp_path``.
    """
    safe = store._sanitize_username(username)
    return store.DATA_DIR / ("%s.scalps.json" % safe)


def load_state(username: str) -> Dict[str, Any]:
    """L'état complet : ``{"items": [...], "reviews": {...}}``.

    Absent ou corrompu -> état vide (``store._load_json`` met de côté un JSON
    illisible en ``.corrupt`` plutôt que de le perdre).
    """
    raw = store._load_json(scalps_path(username))
    if not isinstance(raw, dict):
        return {"items": [], "reviews": {}}
    items = raw.get("items")
    reviews = raw.get("reviews")
    return {
        "items": [i for i in items if isinstance(i, dict)]
                 if isinstance(items, list) else [],
        "reviews": reviews if isinstance(reviews, dict) else {},
    }


def save_state(username: str, state: Dict[str, Any]) -> None:
    """Écrit l'état — atomique, 0o600 (``store._atomic_write_json``)."""
    data = state or {}
    store._atomic_write_json(scalps_path(username), {
        "items": list(data.get("items") or []),
        "reviews": dict(data.get("reviews") or {}),
    })


def load_scalps(username: str) -> List[Dict[str, Any]]:
    """Les scalps, du plus ANCIEN au plus récent (ordre de stockage)."""
    return load_state(username)["items"]


def record(username: str, row: Dict[str, Any],
           now: Optional[datetime] = None) -> Dict[str, Any]:
    """Range un scalp réglé au ledger -> ``{"entry": ligne, "created": bool}``.

    **Dédoublonnage par ``client_id``** : l'extension garde les scalps qu'elle
    n'a pas pu poster dans une file locale et les rejoue (spec §11). Un
    ``client_id`` déjà connu rend la ligne EXISTANTE et n'écrit rien — jamais
    un doublon, jamais un scalp perdu.

    Plafond GLISSANT : au-delà de :data:`MAX_SCALPS`, les plus anciens tombent.
    """
    moment = now or utc_now()
    with _LOCK:
        state = load_state(username)
        items = state["items"]
        client_id = str(row.get("client_id") or "").strip()
        if client_id:
            for existing in items:
                if str(existing.get("client_id") or "") == client_id:
                    return {"entry": dict(existing), "created": False}
        entry = dict(row)
        entry["id"] = uuid.uuid4().hex[:12]
        entry["recorded_at"] = to_utc_iso(moment)
        items.append(entry)
        state["items"] = items[-MAX_SCALPS:]
        save_state(username, state)
        return {"entry": dict(entry), "created": True}


# --------------------------------------------------------------------------- #
# Plafond des bilans de session (3 par jour, état DANS le fichier scalps)
# --------------------------------------------------------------------------- #
def _review_count(state: Dict[str, Any], day: str) -> int:
    reviews = state.get("reviews") or {}
    if str(reviews.get("date") or "") != day:
        return 0
    return int(_val(reviews.get("count")) or 0)


def reserve_review(username: str, now: Optional[datetime] = None) -> int:
    """Consomme un jeton de bilan et rend le rang du jour (1, 2 ou 3).

    Le jeton est réservé AVANT le travail (donc avant de détacher le job) :
    c'est ce qui permet au router de rendre un vrai 429 sur la requête HTTP,
    plutôt qu'une erreur cachée dans le résultat d'un travail détaché.

    Lève :class:`ReviewCapReached` au quatrième du jour.
    """
    moment = now or utc_now()
    day = _local_date(moment).isoformat()
    with _LOCK:
        state = load_state(username)
        count = _review_count(state, day)
        if count >= MAX_REVIEWS_PER_DAY:
            raise ReviewCapReached(
                "plafond de %d bilans de session par jour atteint"
                % MAX_REVIEWS_PER_DAY)
        state["reviews"] = {"date": day, "count": count + 1}
        save_state(username, state)
        return count + 1


def release_review(username: str, now: Optional[datetime] = None) -> None:
    """Rend le jeton réservé — appelée quand le bilan n'a PAS abouti (LLM
    muet). Un quota de trois par jour est trop serré pour qu'une panne du
    modèle en consomme un."""
    moment = now or utc_now()
    day = _local_date(moment).isoformat()
    with _LOCK:
        state = load_state(username)
        count = _review_count(state, day)
        if count <= 0:
            return
        state["reviews"] = {"date": day, "count": count - 1}
        save_state(username, state)


# --------------------------------------------------------------------------- #
# Dérivés : statistiques, biais, discipline
# --------------------------------------------------------------------------- #
def _rows(entries: Any) -> List[Dict[str, Any]]:
    return [e for e in entries if isinstance(e, dict)] \
        if isinstance(entries, (list, tuple)) else []


def _entry_dt(row: Dict[str, Any]) -> Optional[datetime]:
    return _parse_ts_safe(row.get("entry_ts"))


def _exit_dt(row: Dict[str, Any]) -> Optional[datetime]:
    return _parse_ts_safe(row.get("exit_ts"))


def _today_rows(entries: Any, moment: datetime) -> List[Dict[str, Any]]:
    """Les scalps de la JOURNÉE LOCALE de ``moment``, triés chronologiquement.
    Une ligne dont l'horodatage est illisible ne compte pas (elle ne fausse
    aucune statistique, elle en est simplement absente)."""
    today = _local_date(moment)
    kept = []
    for row in _rows(entries):
        when = _entry_dt(row)
        if when is not None and _local_date(when) == today:
            kept.append((when, row))
    kept.sort(key=lambda pair: pair[0])
    return [row for _, row in kept]


def _bucket(rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    """``{n, wins, pnl_chf, fees_chf, avg_duration_s}`` d'un paquet de scalps.

    ``avg_duration_s`` vaut ``None`` sur un paquet vide : une durée moyenne de
    zéro seconde n'existe pas.
    """
    n = len(rows)
    wins = sum(1 for r in rows if (_val(r.get("pnl_chf")) or 0.0) > 0)
    pnl = sum((_val(r.get("pnl_chf")) or 0.0) for r in rows)
    fees_chf = sum((_val(r.get("fees_chf")) or 0.0) for r in rows)
    durations = [d for d in (_val(r.get("duration_s")) for r in rows)
                 if d is not None]
    return {
        "n": n,
        "wins": wins,
        "pnl_chf": round(pnl, 2),
        "fees_chf": round(fees_chf, 2),
        "avg_duration_s": int(round(sum(durations) / len(durations)))
                          if durations else None,
    }


def stats(entries: Any, now: Optional[datetime] = None) -> Dict[str, Any]:
    """``{"today": …, "week": …}`` — la journée LOCALE et les 7 derniers jours
    GLISSANTS (une fenêtre glissante, pas une semaine calendaire : une session
    de scalping se compare à la semaine écoulée, pas au lundi précédent)."""
    moment = now or utc_now()
    floor = moment - timedelta(days=7)
    week = []
    for row in _rows(entries):
        when = _entry_dt(row)
        if when is not None and when >= floor:
            week.append(row)
    return {"today": _bucket(_today_rows(entries, moment)),
            "week": _bucket(week)}


def biases(entries: Any, now: Optional[datetime] = None) -> List[str]:
    """Les biais de la JOURNÉE, dans l'ordre canonique :data:`BIAS_CODES`.

    - ``revenge_trade`` : un scalp rouvert moins de 10 min après la CLÔTURE
      d'un perdant (le garde-fou ``cooldown`` du panneau, §6.3) ;
    - ``overtrading`` : strictement plus de 6 scalps dans une heure glissante ;
    - ``fee_bleed`` : frais du jour > 50 % du BRUT gagné. Évalué seulement si
      quelque chose a été gagné en brut : sans gain, il n'y a rien à saigner,
      et le diagnostic est ailleurs (``daily_loss``) ;
    - ``let_losers_run`` : durée moyenne des perdants > 1,5 x celle des
      gagnants (exige au moins un de chaque — une moyenne sur zéro trade ne
      dit rien).
    """
    moment = now or utc_now()
    rows = _today_rows(entries, moment)
    found: List[str] = []

    # revenge_trade
    for index, row in enumerate(rows):
        if (_val(row.get("pnl_chf")) or 0.0) >= 0:
            continue
        closed = _exit_dt(row)
        if closed is None:
            continue
        for later in rows[index + 1:]:
            opened = _entry_dt(later)
            if opened is None:
                continue
            gap = (opened - closed).total_seconds()
            if gap < 0:
                continue                      # chevauchement, pas une revanche
            if gap < REVENGE_WINDOW_S:
                found.append("revenge_trade")
            break                             # seul le SUIVANT immédiat compte
        if "revenge_trade" in found:
            break

    # overtrading — fenêtre d'une heure GLISSANTE
    starts = [w for w in (_entry_dt(r) for r in rows) if w is not None]
    for index, start in enumerate(starts):
        in_window = sum(1 for other in starts[index:]
                        if (other - start).total_seconds() <= 3600)
        if in_window > OVERTRADING_PER_HOUR:
            found.append("overtrading")
            break

    # fee_bleed
    gross_won = sum(g for g in (_val(r.get("gross_chf")) for r in rows)
                    if g is not None and g > 0)
    fees_day = sum((_val(r.get("fees_chf")) or 0.0) for r in rows)
    if gross_won > 0 and fees_day > FEE_BLEED_RATIO * gross_won:
        found.append("fee_bleed")

    # let_losers_run
    winners, losers = [], []
    for row in rows:
        pnl = _val(row.get("pnl_chf"))
        duration = _val(row.get("duration_s"))
        if pnl is None or duration is None:
            continue
        if pnl > 0:
            winners.append(duration)
        elif pnl < 0:
            losers.append(duration)
    if winners and losers:
        avg_win = sum(winners) / len(winners)
        avg_loss = sum(losers) / len(losers)
        if avg_win > 0 and avg_loss > LOSER_DURATION_RATIO * avg_win:
            found.append("let_losers_run")

    return [code for code in BIAS_CODES if code in found]


def discipline(entries: Any, now: Optional[datetime] = None,
               equity_chf: Any = None) -> Dict[str, Any]:
    """Score de discipline du JOUR, 0-100.

    ``tradestats.discipline_score`` ne convient pas ici : ses quatre
    composantes (stop planifié, thèse écrite, risque tenu, profit factor sur
    >= 5 trades clôturés) mesurent un trade de portefeuille, pas un scalp de
    trois minutes ouvert au prix live. D'où un score PROPRE, volontairement
    simple et entièrement explicable :

        100 − 10 par biais du jour − 20 si la perte réalisée du jour touche
        −2 % de l'équité (le garde-fou ``daily_loss`` du panneau, §6.3).

    ``equity_chf`` absent -> ``daily_loss`` vaut ``None`` (INCONNU, pas
    « non ») et ne retire rien : on ne condamne pas sur une référence qu'on
    n'a pas.
    """
    moment = now or utc_now()
    codes = biases(entries, now=moment)
    rows = _today_rows(entries, moment)
    pnl_today = round(sum((_val(r.get("pnl_chf")) or 0.0) for r in rows), 2)

    equity = _val(equity_chf)
    daily_loss = None
    if equity is not None and equity > 0:
        daily_loss = pnl_today <= -(equity * DAILY_LOSS_PCT / 100.0)

    bias_penalty = BIAS_PENALTY * len(codes)
    loss_penalty = DAILY_LOSS_PENALTY if daily_loss else 0
    score = max(0, min(100, 100 - bias_penalty - loss_penalty))
    return {
        "score": score,
        "biases": codes,
        "daily_loss": daily_loss,
        "n_today": len(rows),
        "pnl_chf_today": pnl_today,
        "penalties": {"biases": bias_penalty, "daily_loss": loss_penalty},
    }


def _compact(row: Dict[str, Any]) -> Dict[str, Any]:
    """La ligne réduite à ce qu'un bilan a besoin de lire (pas de note libre,
    pas d'échantillons : le prompt doit rester court et sans texte injecté)."""
    return {key: row.get(key) for key in
            ("symbol", "side", "entry_ts", "duration_s", "pnl_chf",
             "fees_chf", "pnl_pct", "mae_pct", "mfe_pct", "emotion")}


def session_context(entries: Any, now: Optional[datetime] = None,
                    equity_chf: Any = None) -> Dict[str, Any]:
    """Le contexte DÉTERMINISTE du bilan de session — tout ce que le modèle a
    le droit de citer, et rien d'autre (il n'invente aucun chiffre : il n'en a
    aucun autre sous la main)."""
    moment = now or utc_now()
    rows = _today_rows(entries, moment)
    counts = stats(entries, now=moment)
    score = discipline(entries, now=moment, equity_chf=equity_chf)
    symbols = sorted({str(r.get("symbol") or "") for r in rows
                      if str(r.get("symbol") or "")})
    return {
        "now": to_utc_iso(moment),
        "today": counts["today"],
        "week": counts["week"],
        "biases": score["biases"],
        "discipline": score,
        "equity_chf": _val(equity_chf),
        "symbols": symbols,
        "scalps": [_compact(r) for r in rows[-CONTEXT_SCALPS:]],
    }
