"""Routes de l'extension TradingView « coach » — préfixe ``/api/paper``.

Spec : ``docs/superpowers/specs/2026-09-09-tv-coach-extension-design.md``.
Plan : ``docs/superpowers/plans/2026-09-09-tv-coach-extension.md``.

Chaque lot ajoute ses routes SOUS SON ANCRE et n'y touche pas ailleurs ; les
helpers communs s'importent depuis ``backend.bots.paper_router``
(``_job_or_sync``, ``_load``, ``_now_iso``, ``_append_journal``).
"""

from fastapi import APIRouter

router = APIRouter(prefix="/api/paper", tags=["paper-tv"])

# --- LOT A/B : brief, precheck, alerts/{id}/fire (brief.py, precheck.py) ---
#
# Trois routes de LECTURE et de CALCUL, aucune n'appelle le modèle (§7, levier
# n°4 : « le LLM n'est jamais sur le chemin d'un ordre ») :
#   * ``GET  /brief``            la fiche du titre affiché (spec §5.1) ;
#   * ``POST /precheck``         le ticket chiffré et commenté (spec §5.2) ;
#   * ``POST /alerts/{id}/fire`` l'alerte que l'extension a vue passer (§5.5).
#
# Les imports du lot vivent SOUS l'ancre, pas en tête de fichier : quatre lots
# éditent ce fichier en parallèle, chacun dans sa section, et un bloc d'imports
# partagé en tête serait le seul endroit où ils se marcheraient dessus. Les
# alias suffixés ``_AB`` sont volontairement redondants avec ceux des autres
# sections — chaque section doit pouvoir vivre seule.
from typing import Any as _AnyAB                       # noqa: E402
from typing import Optional as _OptionalAB             # noqa: E402

from fastapi import Depends as _DependsAB              # noqa: E402
from fastapi import HTTPException as _HTTPExceptionAB  # noqa: E402
from pydantic import BaseModel as _BaseModelAB         # noqa: E402

from backend.auth.models import User as _UserAB        # noqa: E402
from backend.auth.permissions import require_role as _require_role_ab  # noqa: E402
from backend.bots.paper import brief, precheck         # noqa: E402
from backend.bots.paper import price_alerts as _price_alerts_ab  # noqa: E402
from backend.bots.paper import quotes as _quotes_ab    # noqa: E402
from backend.bots.paper import store as _store_ab      # noqa: E402
# ``_now_iso`` est importé sous son nom NU (et non suffixé) à dessein : c'est
# l'horloge partagée du module, celle que les tests figent avec un seul
# ``monkeypatch.setattr(paper_tv_router, "_now_iso", ...)``. Un alias par lot
# donnerait quatre horloges à figer pour un seul instant.
from backend.bots.paper_router import _load, _now_iso  # noqa: E402,F811

_BRIEF_ROLES = ("admin", "money", "trader")


class PrecheckPayload(_BaseModelAB):
    """Le ticket soumis au pré-check (§1.3), plus le CONTEXTE de marché.

    Les huit premiers champs sont le contrat. Les suivants sont ce que le
    panneau a DÉJÀ sous la main (il vient de lire ``/brief``, et il mesure
    lui-même l'ATR 1 min et le spread sur le graphique) : les lui redemander
    ferait sortir cette route sur Yahoo et sur les sites de banque centrale à
    CHAQUE déplacement de la ligne de stop (§6.2 : ``onMove`` -> recalcul).
    Elle ne fait donc AUCUN appel réseau — c'est ce qui la rend utilisable au
    rythme de la souris.

    Le serveur, lui, garde la main sur ce qui lui appartient : le portefeuille,
    l'historique des trades et le profil de frais viennent du disque, jamais du
    client.

    Types permissifs à dessein : ``precheck.evaluate`` est tolérant par
    contrat (« une entrée illisible ne lève jamais »), et un 422 nu de Pydantic
    priverait le panneau du ticket au lieu de l'avertir.
    """
    symbol: str = ""
    side: str = "buy"
    price: _OptionalAB[float] = None
    stop: _OptionalAB[float] = None
    target: _OptionalAB[float] = None
    risk_pct: _OptionalAB[float] = None
    qty: _OptionalAB[float] = None
    mode: str = "swing"
    thesis: str = ""
    # --- contexte fourni par le panneau ---
    atr1_m: _OptionalAB[float] = None
    atr14_d: _OptionalAB[float] = None
    atr1_m_median: _OptionalAB[float] = None
    spread_pct: _OptionalAB[float] = None
    spread_median_pct: _OptionalAB[float] = None
    fee_profile: str = ""
    custom_pct: _OptionalAB[float] = None
    commission_chf: _OptionalAB[float] = None
    calendar: _AnyAB = None
    news: _AnyAB = None
    btc: _AnyAB = None
    scalps_today: _AnyAB = None
    thresholds: _AnyAB = None


class AlertFirePayload(_BaseModelAB):
    """``{price, ts, by}`` — ce que l'extension a vu au moment du franchissement.

    ``ts`` absent -> l'heure du serveur : mieux vaut l'horodatage de la
    réception que pas d'horodatage du tout.
    """
    price: _OptionalAB[float] = None
    ts: str = ""
    by: str = "extension"


def _resolve_symbol(symbol: _AnyAB, tv_symbol: _AnyAB) -> str:
    """Le symbole YAHOO CANONIQUE du titre demandé, ``""`` si introuvable.

    ``symbol`` d'abord (le panneau l'envoie quand il l'a), sinon la traduction
    du symbole TradingView par la table de :func:`brief.tv_to_yahoo`. Le
    résultat passe par :func:`quotes.canonical` — c'est ICI que les alias du
    serveur s'appliquent (``ROG.SW`` -> ``RO.SW``), la table de ``brief`` étant
    le miroir de celle de l'extension, qui ne les connaît pas.
    """
    wanted = _quotes_ab.canonical(symbol)
    if not wanted:
        wanted = _quotes_ab.canonical(brief.tv_to_yahoo(tv_symbol) or "")
    return wanted


@router.get("/brief")
def paper_tv_brief(symbol: str = "", tv: str = "",
                   current_user: _UserAB = _DependsAB(
                       _require_role_ab(*_BRIEF_ROLES))):
    """La fiche du titre affiché dans TradingView (spec §5.1) — LECTURE PURE.

    ``symbol`` : le symbole Yahoo. ``tv`` : le symbole TradingView
    (``EXCHANGE:TICKER``), qui sert à la fois de repli quand ``symbol`` manque
    et de filtre pour les dépêches du volet TradingView.

    400 si aucun des deux ne donne un symbole connu : mieux vaut le dire que
    peindre un panneau vide qui aurait l'air d'un titre sans actualité.

    Jamais de 500 : chaque source de ``brief.build`` vit dans son propre
    ``try``, et celles qui sont tombées sont nommées dans ``degraded``.
    """
    wanted = _resolve_symbol(symbol, tv)
    if not wanted:
        raise _HTTPExceptionAB(
            status_code=400,
            detail="Symbole inconnu (ni Yahoo, ni une place TradingView connue).")
    return brief.build(current_user.username, wanted,
                       str(tv or "").strip().upper(), now=_now_iso())


@router.post("/precheck")
def paper_tv_precheck(data: PrecheckPayload,
                      current_user: _UserAB = _DependsAB(
                          _require_role_ab(*_BRIEF_ROLES))):
    """Le ticket AVANT l'ordre : taille, risque, frais, R, avertissements.

    **Rien ne bloque** (§5.2) : ``warnings`` et ``refusals`` sont deux listes
    d'informations, et la route rend 200 même quand tout est au rouge. C'est
    l'humain qui décide ; le serveur ne fait que chiffrer.

    Zéro appel réseau, zéro LLM, zéro écriture — la seule lecture est celle du
    portefeuille sur le disque.
    """
    username = current_user.username
    portfolio = _load(username).to_dict()

    order = {"symbol": data.symbol, "side": data.side, "price": data.price,
             "stop": data.stop, "target": data.target, "mode": data.mode}
    if data.risk_pct is not None:
        order["risk_pct"] = data.risk_pct
    if data.qty is not None:
        order["qty"] = data.qty
    # La thèse n'entre dans le ticket QUE si l'appelant en a écrit une : sans
    # ce filtre, le champ vide par défaut du modèle ferait naître chaque ticket
    # avec un ``no_thesis`` que personne n'a demandé (cf. ``precheck.evaluate``).
    if str(data.thesis or "").strip():
        order["thesis"] = data.thesis

    return precheck.evaluate(
        order,
        portfolio=portfolio,
        trades=portfolio.get("trades") or [],
        fees_profile=data.fee_profile or portfolio.get("fee_profile"),
        custom_pct=data.custom_pct, commission_chf=data.commission_chf,
        atr1_m=data.atr1_m, atr14_d=data.atr14_d,
        atr1_m_median=data.atr1_m_median, spread_pct=data.spread_pct,
        spread_median_pct=data.spread_median_pct, calendar=data.calendar,
        news=data.news, btc=data.btc, scalps_today=data.scalps_today,
        thresholds=data.thresholds, now=_now_iso())


@router.post("/alerts/{alert_id}/fire")
def paper_tv_alert_fire(alert_id: str, data: AlertFirePayload,
                        current_user: _UserAB = _DependsAB(
                            _require_role_ab(*_BRIEF_ROLES))):
    """Marque une alerte de prix comme DÉCLENCHÉE par l'extension (§5.5).

    L'extension évalue les alertes sur le prix VIF du titre d'onglet (§7,
    levier n°5) : elle voit le franchissement une à quinze minutes avant le
    guetteur serveur. Cette route enregistre ce qu'elle a vu.

    404 si l'id est inconnu, 409 si l'alerte a déjà tiré (le rejeu de la file
    locale après une coupure ne doit pas réécrire le prix du premier
    déclenchement), 200 sinon.

    Le statut passe par :func:`price_alerts.trigger` — la MÊME transition que
    le guetteur de 15 minutes, ce qui dédoublonne les deux évaluations : une
    alerte déclenchée ici n'est plus ``armed``, donc le cycle serveur ne la
    regardera plus. Les quatre champs ``fired*`` s'ajoutent par-dessus : ils
    disent QUI a vu passer le niveau, ce que le statut seul ne dit pas.
    """
    username = current_user.username
    rows = _store_ab.load_alerts(username)

    found = None
    for index, row in enumerate(rows):
        if isinstance(row, dict) and str(row.get("id")) == str(alert_id):
            found = index
            break
    if found is None:
        raise _HTTPExceptionAB(status_code=404, detail="Alerte introuvable.")

    alert = rows[found]
    if alert.get("fired") or alert.get("status") != _price_alerts_ab.STATUS_ARMED:
        raise _HTTPExceptionAB(status_code=409, detail="Alerte déjà déclenchée.")

    when = str(data.ts or "").strip() or _now_iso()
    fired = _price_alerts_ab.trigger(alert, data.price, when)
    fired["fired"] = True
    fired["fired_at"] = when
    fired["fired_by"] = str(data.by or "extension")
    fired["fired_price"] = data.price
    rows[found] = fired
    _store_ab.save_alerts(username, rows)
    return {"ok": True, "alert": fired}


# --- LOT C : focus, tvcalendar (focus.py, tvnews.py, tvcalendar.py) ---
#
# Trois routes seulement — le gros du lot C vit dans le CYCLE du guetteur
# (``newswatch.run_once``) et dans le push WebSocket, pas sur le chemin d'une
# requête. Ce qui reste ici, c'est ce que l'extension doit pouvoir dire ou
# demander : « je regarde ce titre » (focus, spec §7 levier n°3) et « donne-moi
# l'agenda macro » (spec §1.8).
#
# Les imports du lot vivent SOUS l'ancre, pas en tête de fichier : quatre lots
# éditent ce fichier en parallèle, chacun dans sa section, et un bloc d'imports
# partagé en tête serait le seul endroit où ils se marcheraient dessus. Ils
# sont donc VOLONTAIREMENT redondants avec ceux des autres sections — une
# section doit pouvoir vivre seule.
from typing import Any as _AnyC, Dict as _DictC      # noqa: E402,F401

from fastapi import Depends as _DependsC             # noqa: E402
from fastapi import HTTPException as _HTTPExceptionC  # noqa: E402
from pydantic import BaseModel as _BaseModelC        # noqa: E402

from backend.auth.models import User as _UserC       # noqa: E402
from backend.auth.permissions import require_role as _require_role_c  # noqa: E402
from backend.bots.paper import focus as _focus       # noqa: E402
from backend.bots.paper import tvcalendar as _tvcalendar  # noqa: E402

_FEED_ROLES = ("admin", "money", "trader")


class FocusPayload(_BaseModelC):
    """``{"symbol": "BTC-USD"}`` — le titre affiché dans TradingView.

    Le symbole est le YAHOO canonique (l'extension fait la traduction avec la
    même table que ``brief.tv_to_yahoo``) : l'Omen ne connaît que celui-là, et
    accepter ici un ``BITSTAMP:BTCUSD`` ferait scanner un symbole qui n'existe
    dans aucune de ses mémoires.
    """
    symbol: str = ""


@router.post("/focus")
def paper_set_focus(data: FocusPayload,
                    current_user: _UserC = _DependsC(_require_role_c(*_FEED_ROLES))):
    """Pose (ou renouvelle) le focus 10 minutes -> ``{ok, symbol, until}``.

    Un seul titre par utilisateur : reposer un focus REMPLACE le précédent.
    L'extension rappelle cette route toutes les deux minutes tant que l'onglet
    est visible — un focus qu'on cesse de renouveler s'éteint tout seul, ce qui
    est exactement le comportement voulu quand l'onglet est fermé.

    400 si le symbole n'a pas la forme d'un symbole (on REJETTE, on ne nettoie
    jamais en silence — doctrine ``store``).
    """
    try:
        return _focus.set_focus(current_user.username, data.symbol)
    except ValueError as exc:
        raise _HTTPExceptionC(status_code=400, detail=str(exc)[:200])


@router.get("/focus")
def paper_get_focus(current_user: _UserC = _DependsC(_require_role_c(*_FEED_ROLES))):
    """Le focus courant -> ``{symbol|null, until|null}`` (forme COMPLÈTE même
    quand il n'y en a pas : l'appelant n'a jamais à deviner quelles clés
    existent)."""
    return _focus.get_focus(current_user.username)


@router.get("/tvcalendar")
def paper_tvcalendar(days: int = 14,
                     current_user: _UserC = _DependsC(_require_role_c(*_FEED_ROLES))):
    """Le calendrier économique TradingView -> ``{items: [...]}`` (spec §1.8).

    Sert le CACHE (``data/paper_trading/tvcalendar.state.json``) et ne le
    rafraîchit que s'il a plus d'une heure : au plus un appel sortant par
    heure, jamais un sur le chemin critique d'un affichage. Source muette ->
    on rend le cache précédent plutôt qu'une liste vide (§11 : une panne
    rétrécit, elle ne détruit pas).
    """
    try:
        span = max(1, min(int(days), 60))
    except (TypeError, ValueError):
        span = 14
    try:
        _tvcalendar.refresh(client=_tvcalendar_client(), days=span)
    except Exception:                            # noqa: BLE001 — best-effort
        pass
    return {"items": _tvcalendar.cached_items(days=span)}


_TVCAL_CLIENT = None


def _tvcalendar_client():
    """Le client HTTP du calendrier — ``None`` si ``httpx`` manque.

    Créé à la DEMANDE et RÉUTILISÉ (même patron que la session paresseuse de
    ``newswatch``) : un client neuf à chaque requête laisserait un pool de
    connexions derrière lui, pour une route qui ne sort du cache qu'une fois
    par heure. Fonction dédiée plutôt que constante de module parce que les
    tests la remplacent par une doublure hors ligne.
    """
    global _TVCAL_CLIENT
    if _TVCAL_CLIENT is None:
        try:
            import httpx
        except ImportError:                      # pragma: no cover — httpx est là
            return None
        _TVCAL_CLIENT = httpx.Client(timeout=10.0, follow_redirects=True)
    return _TVCAL_CLIENT


# --- LOT D : scalps (scalps.py) ---
#
# Ledger des scalps de l'extension (spec §5.4) : l'extension ouvre un scalp au
# prix live, échantillonne à 1 Hz, le ferme, et poste le tout ; le SERVEUR
# recalcule P&L, frais, excursions, durée, biais et discipline (§10 : « le
# serveur reste autoritaire »). Le post-mortem LLM automatique est DÉSACTIVÉ
# ici — à sa place, un bilan de session plafonné à trois par jour.
#
# Les imports du lot vivent SOUS l'ancre, pas en tête de fichier : quatre lots
# éditent ce fichier en parallèle, chacun dans sa section, et un bloc d'imports
# partagé en tête serait le seul endroit où ils se marcheraient dessus. Les
# alias suffixés ``_D`` sont volontairement redondants avec ceux des autres
# sections — chaque section doit pouvoir vivre seule, et deux sections ne
# doivent jamais se réécrire un nom l'une l'autre. Exceptions assumées :
# ``scalps`` (le module DU lot, que personne d'autre n'importe) et les helpers
# de ``paper_router``, partagés sous leur nom nu — ``_now_iso`` et
# ``_append_journal`` sont l'horloge et le carnet communs, que les tests figent
# d'un seul ``monkeypatch.setattr(paper_tv_router, …)``.
from typing import Any as _AnyD, Dict as _DictD    # noqa: E402
from typing import List as _ListD                  # noqa: E402
from typing import Optional as _OptionalD          # noqa: E402

from fastapi import Depends as _DependsD           # noqa: E402
from fastapi import HTTPException as _HTTPExceptionD  # noqa: E402
from pydantic import BaseModel as _BaseModelD      # noqa: E402

from backend.auth.models import User as _UserD     # noqa: E402
from backend.auth.permissions import require_role as _require_role_d  # noqa: E402
from backend.bots.paper import llm as _llm_d       # noqa: E402
from backend.bots.paper import quotes as _quotes_d # noqa: E402
from backend.bots.paper import scalps              # noqa: E402
from backend.bots.paper_router import (              # noqa: E402,F811
    _append_journal, _job_or_sync, _load, _now_iso, normalize_lang)

# Rôles du module Trading — les mêmes que dans ``paper_router`` (le simulateur
# est privé : un scalp porte le comportement de son auteur).
_SCALP_ROLES = ("admin", "money", "trader")


class ScalpPayload(_BaseModelD):
    """Un aller-retour de scalping tel que l'extension le poste.

    ``qty`` et les deux jambes sont typés ``Any``/``Dict`` À DESSEIN : c'est
    ``scalps.validate`` qui refuse, avec un CODE que le panneau sait afficher
    (``bad_qty``, ``bad_price``…). Un typage strict ici rendrait un 422 nu et
    laisserait ces codes du contrat inatteignables.
    """
    client_id: str = ""
    tv_symbol: str = ""
    symbol: str = ""
    side: str = ""
    qty: _AnyD = 0
    entry: _DictD[str, _AnyD] = {}
    exit: _DictD[str, _AnyD] = {}
    samples: _ListD[_AnyD] = []
    fee_profile: str = ""
    custom_pct: _OptionalD[float] = None
    note: str = ""
    emotion: str = ""


class ScalpReviewPayload(_BaseModelD):
    lang: str = "fr"


def _scalp_body(data: ScalpPayload) -> _DictD[str, _AnyD]:
    """Le corps en dictionnaire, quelle que soit la version de Pydantic."""
    return data.model_dump() if hasattr(data, "model_dump") else data.dict()


def _server_quote(symbol: str):
    """``(prix serveur, devise)`` du titre — ``(None, None)`` si la source est
    muette.

    Une cotation absente ne fait PAS échouer l'enregistrement : elle désactive
    le contrôle des ±5 % (spec §11 — une source morte donne un champ nul,
    jamais une décision inventée). Le scalp entre au ledger avec
    ``price_checked: false``, et on sait donc qu'il n'a pas été confronté au
    marché.
    """
    name = str(symbol or "").strip()
    if not name:
        return None, None
    try:
        quote = _quotes_d.get_quote(name)
    except _quotes_d.QuoteError:
        return None, None
    if not isinstance(quote, dict):
        return None, None
    return quote.get("price"), quote.get("currency")


@router.post("/scalps")
def paper_scalp_record(data: ScalpPayload,
                       current_user: _UserD = _DependsD(_require_role_d(*_SCALP_ROLES))):
    """Enregistre un scalp — le serveur RECALCULE tout (spec §5.4).

    400 avec un ``{"code", "message"}`` en cas de refus (prix hors ±5 % de la
    cotation serveur, horodatage hors des 24 h, sortie avant l'entrée, plus de
    600 échantillons ou échantillons non triés, sens invalide, quantité nulle).
    502 si la devise est connue mais son taux de change introuvable : sans
    taux, le montant en francs serait inventé.

    Dédoublonné par ``client_id`` : l'extension rejoue sa file locale après une
    coupure (§11), et un rejeu rend la ligne existante avec
    ``duplicate: true`` — jamais un second scalp.
    """
    username = current_user.username
    body = _scalp_body(data)
    now = scalps.utc_now()

    server_price, currency = _server_quote(body.get("symbol"))
    try:
        clean = scalps.validate(body, server_price=server_price, now=now)
    except scalps.ScalpRefused as refused:
        raise _HTTPExceptionD(status_code=400,
                              detail={"code": refused.code,
                                      "message": refused.message})

    try:
        row = scalps.settle(clean, currency=currency or "CHF")
    except _quotes_d.QuoteError as e:
        raise _HTTPExceptionD(status_code=502, detail=str(e)[:300])
    # Deux drapeaux d'HONNÊTETÉ rangés avec la ligne : ce qui n'a pas pu être
    # vérifié doit rester visible dans le ledger, pas seulement dans la
    # réponse HTTP de l'instant.
    row["price_checked"] = server_price is not None
    row["fx_assumed"] = not bool(currency)

    outcome = scalps.record(username, row, now=now)
    entry = outcome["entry"]
    score = scalps.discipline(scalps.load_scalps(username), now=now,
                              equity_chf=_load(username).initial_capital)
    return {
        "id": entry.get("id"),
        "pnl_chf": entry.get("pnl_chf"),
        "pnl_pct": entry.get("pnl_pct"),
        "fees_chf": entry.get("fees_chf"),
        "mae_pct": entry.get("mae_pct"),
        "mfe_pct": entry.get("mfe_pct"),
        "duration_s": entry.get("duration_s"),
        "biases": score["biases"],
        "discipline": score,
        "duplicate": not outcome["created"],
        "price_checked": bool(entry.get("price_checked")),
        "fee_profile": entry.get("fee_profile"),
        "fee_profile_fallback": bool(entry.get("fee_profile_fallback")),
        "scalp": entry,
    }


@router.get("/scalps")
def paper_scalps_list(limit: int = 50,
                      current_user: _UserD = _DependsD(_require_role_d(*_SCALP_ROLES))):
    """Le ledger, la plus RÉCENTE en tête, plus les compteurs du jour et des 7
    derniers jours glissants (même convention d'affichage que le registre des
    décisions du simulateur)."""
    username = current_user.username
    entries = scalps.load_scalps(username)
    try:
        bounded = int(limit)
    except (TypeError, ValueError):
        bounded = 50
    bounded = max(1, min(bounded, scalps.MAX_SCALPS))
    return {"items": list(reversed(entries))[:bounded],
            "stats": scalps.stats(entries, now=scalps.utc_now())}


def _scalp_review_work(username: str, data: ScalpReviewPayload) -> _DictD[str, _AnyD]:
    """Le bilan de session — exécuté en ligne ou dans un fil détaché.

    Le jeton du plafond a déjà été RÉSERVÉ par l'endpoint (c'est ce qui permet
    un vrai 429 sur la requête HTTP plutôt qu'une erreur enfouie dans le
    résultat d'un travail détaché) ; un modèle muet le RESTITUE — trois bilans
    par jour, c'est trop serré pour qu'une panne en consomme un.
    """
    now = scalps.utc_now()
    context = scalps.session_context(
        scalps.load_scalps(username), now=now,
        equity_chf=_load(username).initial_capital)
    try:
        answer = _llm_d.write_scalp_review(context, lang=normalize_lang(data.lang))
    except RuntimeError as e:
        scalps.release_review(username, now=now)
        raise _HTTPExceptionD(status_code=502, detail=str(e)[:300])
    _append_journal(username, "bilan scalps", answer, _now_iso())
    return {"answer": answer}


@router.post("/scalps/review")
def paper_scalps_review(data: ScalpReviewPayload, sync: bool = False,
                        current_user: _UserD = _DependsD(_require_role_d(*_SCALP_ROLES))):
    """Bilan d'une session de scalping (le post-mortem automatique est
    désactivé pour les scalps, spec §5.4).

    DÉTACHÉ par défaut (``{"job": id}``), en ligne sur ``?sync=1`` — même
    patron ``_job_or_sync`` que les six autres appels au modèle. Plafonné à
    trois par jour et par compte (le compteur vit dans le fichier des scalps) ;
    le quatrième rend 429. La réponse est aussi archivée au carnet.
    """
    username = current_user.username
    try:
        scalps.reserve_review(username, now=scalps.utc_now())
    except scalps.ReviewCapReached as e:
        raise _HTTPExceptionD(status_code=429, detail=str(e))
    return _job_or_sync(sync, username,
                        lambda: _scalp_review_work(username, data))


# --- LOT E : btc (btc.py) ---
#
# Les imports du lot vivent SOUS SON ANCRE et pas en tête de fichier : quatre
# lots écrivent dans ce module EN PARALLÈLE, et une ligne d'import partagée est
# exactement le genre de ligne que deux agents réécrivent en même temps. Python
# accepte un import au milieu d'un module ; un conflit de fusion, non. Les
# alias suffixés ``_E`` suivent la même convention que la section A/B — chaque
# section doit pouvoir vivre seule.
from fastapi import Depends as _DependsE                           # noqa: E402

from backend.auth.models import User as _UserE                     # noqa: E402
from backend.auth.permissions import require_role as _require_role_e  # noqa: E402
from backend.bots.paper import btc                                 # noqa: E402

_BTC_ROLES = ("admin", "money", "trader")


@router.get("/btc")
def paper_tv_btc(current_user: _UserE = _DependsE(
        _require_role_e(*_BTC_ROLES))):
    """Le volet Bitcoin : la photo du moment + l'agenda crypto des 7 jours.

    La photo (``btc.snapshot``) est la clé ``btc`` du brief (spec §5.1) ;
    l'agenda (``btc.crypto_agenda``) est CALCULÉ — funding, expirations
    Deribit, bornes du week-end CME, ouverture américaine — donc il ne coûte
    aucune requête et ne peut pas être périmé.

    **Aucune des deux ne lève.** Une source morte met son champ à ``None`` et
    son nom dans ``degraded`` : le panneau affiche alors un chip en moins, il
    n'affiche jamais une valeur inventée, et la route reste 200. Rendre un 502
    parce que Deribit tousse priverait Massii des cinq autres chiffres.

    Le client HTTP est celui du module (``btc.get_client``, créé à la première
    demande) ; les tests posent le leur avec ``btc.set_client``, et l'état —
    caches de 60 s / 1 h, séries de 48 h — est relu et réécrit dans
    ``data/paper_trading/btc.state.json``.
    """
    data = btc.snapshot()
    data["agenda"] = btc.crypto_agenda()
    return data


# --- LOT F : note rapide au journal des idées (idea_journal.py) ---
#
# Une seule route d'ÉCRITURE, 0 LLM, 0 réseau : ``POST /ideas/note`` range au
# journal des idées ce que Massii vient d'observer sur le graphique (« le gap
# de 8h30 s'est refermé », « troisième rejet sur 42 500 »). C'est le dernier
# reste v1 côté journal : sans elle, une observation attrapée au vol se perd,
# et le coach reproposera la même idée trois jours plus tard sans savoir
# qu'elle a déjà été examinée.
#
# Le journal des IDÉES et non le carnet Markdown (``_append_journal``) : c'est
# le journal des idées que le coach relit AVANT de proposer (``llm.write_ideas``
# reçoit son résumé), donc c'est le seul endroit où une note peut lui revenir
# sous les yeux au bon moment.
#
# Les imports du lot vivent SOUS SON ANCRE et pas en tête de fichier — même
# raison que les cinq sections au-dessus : plusieurs lots écrivent dans ce
# module en parallèle, et une ligne d'import partagée est exactement celle que
# deux agents réécrivent en même temps. Les alias suffixés ``_F`` sont
# volontairement redondants avec ceux des autres sections.
from typing import Optional as _OptionalF                           # noqa: E402

from fastapi import Depends as _DependsF                            # noqa: E402
from fastapi import HTTPException as _HTTPExceptionF                # noqa: E402
from pydantic import BaseModel as _BaseModelF                       # noqa: E402

from backend.auth.models import User as _UserF                      # noqa: E402
from backend.auth.permissions import require_role as _require_role_f  # noqa: E402
from backend.bots.paper import idea_journal as _idea_journal_f      # noqa: E402
from backend.bots.paper import quotes as _quotes_f                  # noqa: E402
from backend.bots.paper_router import (                             # noqa: E402,F811
    normalize_lang as _normalize_lang_f)

_NOTE_ROLES = ("admin", "money", "trader")

# Une note, pas un mémoire : 500 caractères. Le journal est relu ENTIER à
# chaque demande d'idées (50 entrées), et il part dans le contexte du modèle —
# une note de 20 000 signes y noierait les huit idées qui comptent.
NOTE_MAX_LEN = 500


class NotePayload(_BaseModelF):
    """La note telle que le panneau la poste : le texte, et — si l'onglet
    TradingView affiche un titre — le symbole qu'elle concerne."""
    text: str = ""
    symbol: _OptionalF[str] = None
    lang: str = "fr"


@router.post("/ideas/note")
def paper_tv_idea_note(data: NotePayload,
                       current_user: _UserF = _DependsF(
                           _require_role_f(*_NOTE_ROLES))):
    """Range une note rapide au journal des idées -> ``{"ok", "entry"}``.

    400 sur une note VIDE (après ``strip``) : une entrée sans texte n'aurait
    rien à redonner au coach mais mangerait quand même une des cinquante
    places du journal.

    Le symbole est CANONISÉ (``quotes.canonical``, mêmes alias que les ordres
    et la watchlist) puis préfixé au texte entre crochets : le journal n'a pas
    de champ ``symbol``, et c'est ``advice_from_text`` — qui cherche le ticker
    en MOT ENTIER dans le texte — qui retrouvera la note le jour où le coach
    parlera de ce titre. Un symbole rangé dans une clé qu'il ne lit pas serait
    invisible.

    La troncature à :data:`NOTE_MAX_LEN` porte sur le texte de l'utilisateur,
    AVANT le préfixe : deux notes de 500 signes doivent donner deux entrées
    comparables, que l'une porte un symbole de trois lettres et l'autre un de
    huit.
    """
    username = current_user.username
    text = str(data.text or "").strip()[:NOTE_MAX_LEN]
    if not text:
        raise _HTTPExceptionF(status_code=400, detail="Note vide.")

    symbol = _quotes_f.canonical(data.symbol)
    if symbol:
        text = "[%s] %s" % (symbol, text)

    entry = _idea_journal_f.append_entry(username, kind="note", text=text,
                                         lang=_normalize_lang_f(data.lang),
                                         now_iso=_now_iso())
    return {"ok": True, "entry": entry}
