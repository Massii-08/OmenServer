"""Tests du ledger de scalps de l'extension TradingView (LOT D) — 100 % hors ligne.

Trois étages, comme le lot lui-même :

1. ``paper.scalps`` — module PUR (validation, recalcul, biais, stats) plus son
   unique I/O (``data/paper_trading/<user>.scalps.json``, redirigé sur
   ``tmp_path``) ;
2. ``paper.llm.build_scalp_review_prompt`` — construction du prompt du bilan de
   session, sans jamais lancer le CLI ;
3. ``paper_tv_router`` section LOT D — TestClient FastAPI, ``get_current_user``
   surchargé (c'est là-dessus que ``require_role`` se branche), cotation
   serveur doublée, ``llm.write_scalp_review`` doublé.

Rien ici ne touche le réseau : aucune horloge réelle n'est utilisée pour un
seuil (``scalps.utc_now`` est monkeypatché ou l'instant est passé en
argument), aucun cours n'est relevé (``quotes.get_quote``/``fx_to_chf`` sont
remplacés), aucun binaire Claude n'est appelé.
"""
import os
import time
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.auth.utils import get_current_user
from backend.bots import paper_tv_router as tvr
from backend.bots.paper import llm, quotes, scalps, store

# --------------------------------------------------------------------------- #
# Repères de temps
#
# ``LOCAL_NOON`` est MIDI LOCAL du 9 septembre 2026, converti en UTC *aware*.
# Passer par l'heure locale (et non par un ``datetime(..., tzinfo=utc)`` écrit
# en dur) rend les tests indépendants du fuseau de la machine : « aujourd'hui »
# se calcule sur la date LOCALE (cf. ``scalps._local_date``), et midi est à
# douze heures de la frontière de jour la plus proche, quel que soit le fuseau.
# --------------------------------------------------------------------------- #
LOCAL_NOON = datetime(2026, 9, 9, 12, 0, 0).astimezone(timezone.utc)


@pytest.fixture(autouse=True)
def _registre_des_travaux_vide():
    """Le registre des travaux détachés de ``paper_router`` est un état de
    MODULE : sans remise à zéro il fuit d'un fichier de test à l'autre et le
    plafond par compte finit par rendre 429 (échec mesuré côté
    ``test_paper_router.py``)."""
    from backend.bots import paper_router as pr
    pr._JOBS.clear()
    yield
    pr._JOBS.clear()


def iso(dt):
    """ISO *aware* UTC (ce que l'extension enverra : offset explicite)."""
    return dt.astimezone(timezone.utc).isoformat()


def mins(n):
    return timedelta(minutes=n)


# --------------------------------------------------------------------------- #
# Fabriques de charges utiles
# --------------------------------------------------------------------------- #
def payload(entry_price=100.0, exit_price=101.0, side="buy", qty=10.0,
            entry_at=None, exit_at=None, samples=None, client_id="c1",
            fee_profile="yuh", **extra):
    """Une charge utile de scalp telle que l'extension la poste."""
    entry_at = LOCAL_NOON - mins(4) if entry_at is None else entry_at
    exit_at = LOCAL_NOON - mins(1) if exit_at is None else exit_at
    if samples is None:
        samples = [[iso(entry_at), entry_price], [iso(exit_at), exit_price]]
    data = {
        "client_id": client_id,
        "tv_symbol": "SIX:NESN",
        "symbol": "NESN.SW",
        "side": side,
        "qty": qty,
        "entry": {"price": entry_price, "ts": iso(entry_at)},
        "exit": {"price": exit_price, "ts": iso(exit_at)},
        "samples": samples,
        "fee_profile": fee_profile,
    }
    data.update(extra)
    return data


def settled(pnl_chf=1.0, fees_chf=0.5, duration_s=180, entry_at=None,
            exit_at=None, client_id="c1", gross_chf=None):
    """Une ligne DÉJÀ réglée, comme ``scalps.settle`` la rend — pour tester
    directement les dérivés (stats, biais, discipline) sans repasser par le
    recalcul."""
    entry_at = LOCAL_NOON - mins(30) if entry_at is None else entry_at
    exit_at = entry_at + timedelta(seconds=duration_s) if exit_at is None else exit_at
    return {
        "client_id": client_id,
        "symbol": "NESN.SW",
        "tv_symbol": "SIX:NESN",
        "side": "buy",
        "qty": 10.0,
        "entry_price": 100.0,
        "entry_ts": iso(entry_at),
        "exit_price": 100.0 + pnl_chf / 10.0,
        "exit_ts": iso(exit_at),
        "duration_s": duration_s,
        "currency": "CHF",
        "fx_rate": 1.0,
        "fee_profile": "yuh",
        "gross_chf": pnl_chf + fees_chf if gross_chf is None else gross_chf,
        "fees_chf": fees_chf,
        "pnl_chf": pnl_chf,
        "pnl_pct": round(pnl_chf / 1000.0 * 100.0, 4),
        "mae_pct": 0.0,
        "mfe_pct": 0.0,
    }


# =========================================================================== #
# 1. Validation — 6 refus + 1 acceptation
# =========================================================================== #
def test_validate_ok_normalise_en_utc_aware():
    clean = scalps.validate(payload(), server_price=100.5, now=LOCAL_NOON)
    assert clean["side"] == "buy"
    assert clean["qty"] == 10.0
    assert clean["entry_dt"].tzinfo is not None
    assert clean["entry_dt"].utcoffset() == timedelta(0)
    assert clean["exit_dt"] > clean["entry_dt"]
    assert len(clean["samples"]) == 2


def test_validate_refuse_side_inconnu():
    with pytest.raises(scalps.ScalpRefused) as err:
        scalps.validate(payload(side="hold"), server_price=100.0, now=LOCAL_NOON)
    assert err.value.code == "bad_side"


@pytest.mark.parametrize("qty", [0, -3, "abc", None])
def test_validate_refuse_qty_non_positive(qty):
    with pytest.raises(scalps.ScalpRefused) as err:
        scalps.validate(payload(qty=qty), server_price=100.0, now=LOCAL_NOON)
    assert err.value.code == "bad_qty"


def test_validate_refuse_prix_hors_tolerance():
    # 110 contre une cotation serveur à 100 = +10 %, au-delà des ±5 %.
    with pytest.raises(scalps.ScalpRefused) as err:
        scalps.validate(payload(exit_price=110.0), server_price=100.0,
                        now=LOCAL_NOON)
    assert err.value.code == "price_off_market"


def test_validate_accepte_juste_sous_la_tolerance():
    clean = scalps.validate(payload(entry_price=104.9, exit_price=95.2),
                            server_price=100.0, now=LOCAL_NOON)
    assert clean["entry_price"] == 104.9


def test_validate_sans_cotation_serveur_aucun_controle_de_prix():
    """Cotation inconnue -> on ne compare à RIEN : un contrôle contre une
    référence absente inventerait un refus."""
    clean = scalps.validate(payload(entry_price=1.0, exit_price=999.0),
                            server_price=None, now=LOCAL_NOON)
    assert clean["exit_price"] == 999.0


def test_validate_refuse_horodatage_hors_24h():
    vieux = LOCAL_NOON - timedelta(hours=30)
    with pytest.raises(scalps.ScalpRefused) as err:
        scalps.validate(payload(entry_at=vieux, exit_at=vieux + mins(3)),
                        server_price=100.0, now=LOCAL_NOON)
    assert err.value.code == "ts_out_of_window"


def test_validate_refuse_sortie_avant_entree():
    with pytest.raises(scalps.ScalpRefused) as err:
        scalps.validate(payload(entry_at=LOCAL_NOON - mins(1),
                                exit_at=LOCAL_NOON - mins(4),
                                samples=[]),
                        server_price=100.0, now=LOCAL_NOON)
    assert err.value.code == "exit_before_entry"


def test_validate_refuse_trop_d_echantillons():
    start = LOCAL_NOON - mins(15)
    trop = [[iso(start + timedelta(seconds=i)), 100.0]
            for i in range(scalps.MAX_SAMPLES + 1)]
    with pytest.raises(scalps.ScalpRefused) as err:
        scalps.validate(payload(samples=trop), server_price=100.0, now=LOCAL_NOON)
    assert err.value.code == "too_many_samples"


def test_validate_refuse_echantillons_non_tries():
    a, b = LOCAL_NOON - mins(4), LOCAL_NOON - mins(2)
    desordre = [[iso(b), 100.0], [iso(a), 100.5]]
    with pytest.raises(scalps.ScalpRefused) as err:
        scalps.validate(payload(samples=desordre), server_price=100.0,
                        now=LOCAL_NOON)
    assert err.value.code == "samples_unsorted"


def test_validate_horodatage_naif_lu_en_heure_locale():
    """Un ``ts`` sans offset est de l'heure LOCALE — le même instant écrit avec
    et sans offset doit donner le MÊME instant UTC (le piège du lot)."""
    aware = LOCAL_NOON - mins(3)
    naif = aware.astimezone().replace(tzinfo=None).isoformat()
    clean = scalps.validate(
        payload(entry_at=aware, samples=[]), server_price=100.0, now=LOCAL_NOON)
    brut = payload(samples=[])
    brut["entry"]["ts"] = naif
    clean_naif = scalps.validate(brut, server_price=100.0, now=LOCAL_NOON)
    assert clean_naif["entry_dt"] == clean["entry_dt"]


def test_validate_emotion_hors_whitelist_effacee():
    clean = scalps.validate(payload(emotion="pas-une-emotion", note=" note "),
                            server_price=100.0, now=LOCAL_NOON)
    assert clean["emotion"] is None
    assert clean["note"] == "note"
    clean2 = scalps.validate(payload(emotion="revanche"), server_price=100.0,
                             now=LOCAL_NOON)
    assert clean2["emotion"] == "revanche"


# =========================================================================== #
# 2. Recalcul (settle)
# =========================================================================== #
def test_settle_achat_gagnant():
    clean = scalps.validate(payload(entry_price=100.0, exit_price=101.0,
                                    qty=10.0, fee_profile="ibkr"),
                            server_price=100.0, now=LOCAL_NOON)
    row = scalps.settle(clean)
    # Brut : (101 - 100) x 10 = 10 CHF.
    assert row["gross_chf"] == 10.0
    # IBKR : 0,05 % du montant, minimum 1,50 CHF -> 1,50 par jambe, x2.
    assert row["fees_chf"] == 3.0
    assert row["pnl_chf"] == 7.0
    # Net rapporté au montant engagé à l'entrée (100 x 10 = 1000 CHF).
    assert row["pnl_pct"] == 0.7
    assert row["duration_s"] == 180


def test_settle_vente_a_decouvert_gagne_quand_ca_baisse():
    clean = scalps.validate(payload(side="sell", entry_price=100.0,
                                    exit_price=99.0, qty=10.0,
                                    fee_profile="ibkr"),
                            server_price=100.0, now=LOCAL_NOON)
    row = scalps.settle(clean)
    assert row["gross_chf"] == 10.0
    assert row["pnl_chf"] == 7.0


def test_settle_convertit_via_fx_injecte():
    clean = scalps.validate(payload(entry_price=100.0, exit_price=101.0,
                                    qty=10.0, fee_profile="ibkr"),
                            server_price=100.0, now=LOCAL_NOON)
    row = scalps.settle(clean, currency="USD", fx=lambda code: 0.5)
    # Brut 10 USD -> 5 CHF ; les frais sont calculés sur le montant EN FRANCS
    # (500 CHF par jambe -> minimum 1,50 CHF x2).
    assert row["gross_chf"] == 5.0
    assert row["fees_chf"] == 3.0
    assert row["pnl_chf"] == 2.0
    assert row["fx_rate"] == 0.5
    assert row["currency"] == "USD"


def test_settle_profil_inconnu_repli_yuh_avec_drapeau():
    """Le catalogue de ``fees`` bouge dans un autre lot : un profil qu'il ne
    connaît pas encore ne doit ni exploser ni rendre le trading gratuit."""
    clean = scalps.validate(payload(fee_profile="kraken_ultra_futures"),
                            server_price=100.0, now=LOCAL_NOON)
    row = scalps.settle(clean)
    assert row["fee_profile"] == "yuh"
    assert row["fee_profile_fallback"] is True
    assert row["fee_profile_asked"] == "kraken_ultra_futures"
    assert row["fees_chf"] > 0


def test_settle_profil_custom_utilise_le_pourcentage_saisi():
    clean = scalps.validate(payload(fee_profile="custom", custom_pct=0.1,
                                    entry_price=100.0, exit_price=101.0,
                                    qty=10.0),
                            server_price=100.0, now=LOCAL_NOON)
    row = scalps.settle(clean)
    # 0,1 % de 1000 CHF à l'entrée + 0,1 % de 1010 CHF à la sortie.
    assert row["fees_chf"] == 2.01
    assert row["fee_profile"] == "custom"
    assert row["fee_profile_fallback"] is False


def test_settle_mae_mfe_depuis_les_echantillons():
    start = LOCAL_NOON - mins(4)
    ech = [[iso(start), 100.0],
           [iso(start + mins(1)), 99.0],     # creux : -1 %
           [iso(start + mins(2)), 102.0],    # sommet : +2 %
           [iso(start + mins(3)), 101.0]]
    clean = scalps.validate(payload(entry_price=100.0, exit_price=101.0,
                                    samples=ech),
                            server_price=100.0, now=LOCAL_NOON)
    row = scalps.settle(clean)
    assert row["mae_pct"] == -1.0
    assert row["mfe_pct"] == 2.0


def test_settle_mae_mfe_a_la_vente_inverses():
    start = LOCAL_NOON - mins(4)
    ech = [[iso(start), 100.0],
           [iso(start + mins(1)), 99.0],
           [iso(start + mins(2)), 102.0]]
    clean = scalps.validate(payload(side="sell", entry_price=100.0,
                                    exit_price=99.0, samples=ech),
                            server_price=100.0, now=LOCAL_NOON)
    row = scalps.settle(clean)
    # Vendeur : la hausse à 102 est DÉFAVORABLE, la baisse à 99 est favorable.
    assert row["mae_pct"] == -2.0
    assert row["mfe_pct"] == 1.0


def test_settle_sans_echantillon_excursions_inconnues():
    """Zéro échantillon -> ``None``, jamais ``0.0`` : un zéro prétendrait avoir
    mesuré quelque chose (même doctrine que ``tradestats.excursions``)."""
    clean = scalps.validate(payload(samples=[]), server_price=100.0,
                            now=LOCAL_NOON)
    row = scalps.settle(clean)
    assert row["mae_pct"] is None
    assert row["mfe_pct"] is None
    assert row["n_samples"] == 0


# =========================================================================== #
# 3. Persistance
# =========================================================================== #
@pytest.fixture()
def disque(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "DATA_DIR", tmp_path / "paper_trading")
    return tmp_path / "paper_trading"


def test_record_ecrit_en_0600(disque):
    out = scalps.record("tester", settled(), now=LOCAL_NOON)
    assert out["created"] is True
    path = scalps.scalps_path("tester")
    assert path.is_file()
    assert oct(os.stat(str(path)).st_mode & 0o777) == "0o600"


def test_record_dedup_par_client_id(disque):
    first = scalps.record("tester", settled(client_id="abc"), now=LOCAL_NOON)
    second = scalps.record("tester", settled(client_id="abc", pnl_chf=99.0),
                           now=LOCAL_NOON)
    assert second["created"] is False
    # La ligne rendue est l'EXISTANTE (même id, même P&L), pas la nouvelle.
    assert second["entry"]["id"] == first["entry"]["id"]
    assert second["entry"]["pnl_chf"] == first["entry"]["pnl_chf"]
    assert len(scalps.load_scalps("tester")) == 1


def test_record_plafond_500_glissant(disque):
    state = {"items": [dict(settled(client_id="old-%d" % i), id="id-%d" % i)
                       for i in range(scalps.MAX_SCALPS)]}
    scalps.save_state("tester", state)
    scalps.record("tester", settled(client_id="neuf"), now=LOCAL_NOON)
    items = scalps.load_scalps("tester")
    assert len(items) == scalps.MAX_SCALPS
    # Glissant : la plus ANCIENNE est tombée, la neuve est en queue.
    assert items[0]["client_id"] == "old-1"
    assert items[-1]["client_id"] == "neuf"


def test_load_scalps_fichier_absent_liste_vide(disque):
    assert scalps.load_scalps("inconnu") == []


# =========================================================================== #
# 4. Statistiques, biais, discipline
# =========================================================================== #
def jeu_de_12():
    """12 scalps : 8 aujourd'hui (4 gagnants / 4 perdants), 4 plus tôt dans la
    semaine."""
    rows = []
    for i in range(8):
        gagnant = i % 2 == 0
        rows.append(settled(
            client_id="today-%d" % i,
            pnl_chf=2.0 if gagnant else -2.0,
            fees_chf=0.5,
            duration_s=120 if gagnant else 300,
            entry_at=LOCAL_NOON - mins(300 - i * 20)))
    for i in range(4):
        rows.append(settled(
            client_id="week-%d" % i,
            pnl_chf=1.0,
            fees_chf=0.5,
            entry_at=LOCAL_NOON - timedelta(days=2, minutes=i * 10)))
    return rows


def test_stats_du_jour_et_de_la_semaine():
    out = scalps.stats(jeu_de_12(), now=LOCAL_NOON)
    assert out["today"]["n"] == 8
    assert out["today"]["wins"] == 4
    assert out["today"]["pnl_chf"] == 0.0
    assert out["today"]["fees_chf"] == 4.0
    assert out["today"]["avg_duration_s"] == 210
    assert out["week"]["n"] == 12
    assert out["week"]["pnl_chf"] == 4.0


def test_stats_sur_rien_ne_ment_pas():
    out = scalps.stats([], now=LOCAL_NOON)
    assert out["today"]["n"] == 0
    assert out["today"]["pnl_chf"] == 0.0
    assert out["today"]["avg_duration_s"] is None


def test_biais_revenge_trade():
    perdant = settled(client_id="a", pnl_chf=-5.0,
                      entry_at=LOCAL_NOON - mins(60), duration_s=180)
    juste_apres = settled(client_id="b", pnl_chf=1.0,
                          entry_at=LOCAL_NOON - mins(55))
    assert "revenge_trade" in scalps.biases([perdant, juste_apres], now=LOCAL_NOON)
    # Le même perdant suivi d'un scalp une demi-heure plus tard : pas de biais.
    plus_tard = settled(client_id="c", pnl_chf=1.0,
                        entry_at=LOCAL_NOON - mins(20))
    assert "revenge_trade" not in scalps.biases([perdant, plus_tard],
                                                now=LOCAL_NOON)


def test_biais_overtrading():
    rows = [settled(client_id="s%d" % i, pnl_chf=1.0,
                    entry_at=LOCAL_NOON - mins(50 - i * 5)) for i in range(7)]
    assert "overtrading" in scalps.biases(rows, now=LOCAL_NOON)
    assert "overtrading" not in scalps.biases(rows[:6], now=LOCAL_NOON)


def test_biais_fee_bleed():
    # Brut gagné du jour : 2 CHF ; frais du jour : 1,50 CHF > 50 % de 2.
    rows = [settled(client_id="g", pnl_chf=1.0, fees_chf=1.0, gross_chf=2.0,
                    entry_at=LOCAL_NOON - mins(40)),
            settled(client_id="p", pnl_chf=-0.5, fees_chf=0.5, gross_chf=0.0,
                    entry_at=LOCAL_NOON - mins(10))]
    assert "fee_bleed" in scalps.biases(rows, now=LOCAL_NOON)


def test_biais_let_losers_run():
    rows = [settled(client_id="g1", pnl_chf=1.0, fees_chf=0.1, duration_s=60,
                    entry_at=LOCAL_NOON - mins(50)),
            settled(client_id="g2", pnl_chf=1.0, fees_chf=0.1, duration_s=60,
                    entry_at=LOCAL_NOON - mins(40)),
            settled(client_id="p1", pnl_chf=-1.0, fees_chf=0.1, duration_s=400,
                    entry_at=LOCAL_NOON - mins(30))]
    assert "let_losers_run" in scalps.biases(rows, now=LOCAL_NOON)


def test_biais_session_propre_aucun_code():
    rows = [settled(client_id="g1", pnl_chf=2.0, fees_chf=0.1, gross_chf=2.1,
                    duration_s=120, entry_at=LOCAL_NOON - mins(120)),
            settled(client_id="p1", pnl_chf=-0.5, fees_chf=0.1, gross_chf=-0.4,
                    duration_s=120, entry_at=LOCAL_NOON - mins(60))]
    assert scalps.biases(rows, now=LOCAL_NOON) == []


def test_discipline_retire_dix_points_par_biais():
    perdant = settled(client_id="a", pnl_chf=-5.0, fees_chf=0.1,
                      entry_at=LOCAL_NOON - mins(60), duration_s=180)
    juste_apres = settled(client_id="b", pnl_chf=1.0, fees_chf=0.1,
                          gross_chf=1.1, entry_at=LOCAL_NOON - mins(55))
    out = scalps.discipline([perdant, juste_apres], now=LOCAL_NOON,
                            equity_chf=10000.0)
    assert out["biases"] == ["revenge_trade"]
    assert out["score"] == 90
    assert out["daily_loss"] is False


def test_discipline_daily_loss_retire_vingt_points():
    gros_perdant = settled(client_id="a", pnl_chf=-250.0, fees_chf=1.0,
                           entry_at=LOCAL_NOON - mins(30))
    out = scalps.discipline([gros_perdant], now=LOCAL_NOON, equity_chf=10000.0)
    assert out["daily_loss"] is True
    assert out["score"] == 80


def test_discipline_sans_equite_ne_juge_pas_la_perte_du_jour():
    gros_perdant = settled(client_id="a", pnl_chf=-250.0,
                           entry_at=LOCAL_NOON - mins(30))
    out = scalps.discipline([gros_perdant], now=LOCAL_NOON, equity_chf=None)
    assert out["daily_loss"] is None
    assert out["score"] == 100


def test_session_context_forme():
    ctx = scalps.session_context(jeu_de_12(), now=LOCAL_NOON, equity_chf=10000.0)
    for key in ("today", "week", "biases", "discipline", "scalps", "symbols"):
        assert key in ctx
    assert ctx["today"]["n"] == 8
    assert len(ctx["scalps"]) <= scalps.CONTEXT_SCALPS
    assert ctx["symbols"] == ["NESN.SW"]


# =========================================================================== #
# 5. Plafond des bilans (3 par jour)
# =========================================================================== #
def test_reserve_review_plafonne_a_trois(disque):
    for expected in (1, 2, 3):
        assert scalps.reserve_review("tester", now=LOCAL_NOON) == expected
    with pytest.raises(scalps.ReviewCapReached):
        scalps.reserve_review("tester", now=LOCAL_NOON)


def test_release_review_rend_le_jeton(disque):
    scalps.reserve_review("tester", now=LOCAL_NOON)
    scalps.release_review("tester", now=LOCAL_NOON)
    assert scalps.reserve_review("tester", now=LOCAL_NOON) == 1


def test_reserve_review_repart_a_zero_le_lendemain(disque):
    for _ in range(3):
        scalps.reserve_review("tester", now=LOCAL_NOON)
    demain = LOCAL_NOON + timedelta(days=1)
    assert scalps.reserve_review("tester", now=demain) == 1


def test_reserve_review_ne_perd_pas_les_scalps(disque):
    scalps.record("tester", settled(client_id="x"), now=LOCAL_NOON)
    scalps.reserve_review("tester", now=LOCAL_NOON)
    assert len(scalps.load_scalps("tester")) == 1


# =========================================================================== #
# 6. Prompt du bilan de session
# =========================================================================== #
def test_prompt_bilan_porte_le_contexte_et_la_langue():
    ctx = scalps.session_context(jeu_de_12(), now=LOCAL_NOON, equity_chf=10000.0)
    prompt = llm.build_scalp_review_prompt(ctx, lang="fr")
    assert llm.SYSTEM_PROMPT in prompt
    assert "français" in prompt
    assert "120 mots" in prompt
    assert '"today"' in prompt          # le bloc JSON du contexte est bien là
    assert "NESN.SW" in prompt


def test_prompt_bilan_change_de_langue():
    prompt = llm.build_scalp_review_prompt({}, lang="it")
    assert "italiano" in prompt


def test_prompt_bilan_tolere_un_contexte_vide():
    assert llm.build_scalp_review_prompt(None) .strip()


# =========================================================================== #
# 7. Routes (section LOT D)
# =========================================================================== #
class FakeUser(object):
    def __init__(self, role="admin", username="tester"):
        self.role = role
        self.is_admin = role == "admin"
        self.username = username


@pytest.fixture()
def client(tmp_path, monkeypatch):
    """TestClient isolé : disque en tmp, horloge figée, cotation et LLM doublés."""
    monkeypatch.setattr(store, "DATA_DIR", tmp_path / "paper_trading")
    monkeypatch.setattr(scalps, "utc_now", lambda: LOCAL_NOON)
    monkeypatch.setattr(tvr, "_now_iso", lambda: "2026-09-09T12:00:00")

    monkeypatch.setattr(quotes, "get_quote",
                        lambda symbol, client=None: {
                            "symbol": symbol, "price": 100.0,
                            "currency": "CHF", "change_pct": 0.0,
                            "name": "Nestle SA"})
    monkeypatch.setattr(quotes, "fx_to_chf", lambda code, client=None: 1.0)
    monkeypatch.setattr(llm, "write_scalp_review",
                        lambda context, lang="fr": "Tes frais mangent la moitié "
                                                   "de ton brut. Ralentis.")

    ecrit = []
    monkeypatch.setattr(tvr, "_append_journal",
                        lambda user, title, body, now: ecrit.append(
                            (user, title, body, now)))

    app = FastAPI()
    app.include_router(tvr.router)
    app.dependency_overrides[get_current_user] = lambda: FakeUser()
    return TestClient(app), ecrit


def test_post_scalp_200_forme_du_contrat(client):
    http, _ = client
    resp = http.post("/api/paper/scalps", json=payload(fee_profile="ibkr"))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    for key in ("id", "pnl_chf", "pnl_pct", "fees_chf", "mae_pct", "mfe_pct",
                "duration_s", "biases", "discipline"):
        assert key in body
    assert body["pnl_chf"] == 7.0
    assert isinstance(body["biases"], list)
    assert "score" in body["discipline"]
    assert body["duplicate"] is False


def test_post_scalp_400_prix_aberrant_avec_code(client):
    http, _ = client
    resp = http.post("/api/paper/scalps", json=payload(exit_price=150.0))
    assert resp.status_code == 400
    assert resp.json()["detail"]["code"] == "price_off_market"


def test_post_scalp_400_side_invalide_avec_code(client):
    http, _ = client
    resp = http.post("/api/paper/scalps", json=payload(side="peut-etre"))
    assert resp.status_code == 400
    assert resp.json()["detail"]["code"] == "bad_side"


def test_post_scalp_dedup_ne_double_jamais(client):
    http, _ = client
    first = http.post("/api/paper/scalps", json=payload(client_id="uuid-1"))
    second = http.post("/api/paper/scalps", json=payload(client_id="uuid-1"))
    assert second.status_code == 200
    assert second.json()["duplicate"] is True
    assert second.json()["id"] == first.json()["id"]
    listing = http.get("/api/paper/scalps").json()
    assert len(listing["items"]) == 1


def test_get_scalps_liste_et_stats(client):
    http, _ = client
    http.post("/api/paper/scalps",
              json=payload(client_id="u1", entry_at=LOCAL_NOON - mins(20),
                           exit_at=LOCAL_NOON - mins(17)))
    http.post("/api/paper/scalps",
              json=payload(client_id="u2", entry_at=LOCAL_NOON - mins(10),
                           exit_at=LOCAL_NOON - mins(7)))
    body = http.get("/api/paper/scalps?limit=50").json()
    assert len(body["items"]) == 2
    # La plus RÉCENTE en tête (convention du registre du module).
    assert body["items"][0]["client_id"] == "u2"
    assert body["stats"]["today"]["n"] == 2
    assert "week" in body["stats"]
    assert body["stats"]["today"]["avg_duration_s"] == 180


def test_get_scalps_limit_tronque(client):
    http, _ = client
    for i in range(4):
        http.post("/api/paper/scalps",
                  json=payload(client_id="u%d" % i,
                               entry_at=LOCAL_NOON - mins(40 - i * 5),
                               exit_at=LOCAL_NOON - mins(37 - i * 5)))
    body = http.get("/api/paper/scalps?limit=2").json()
    assert len(body["items"]) == 2
    assert body["items"][0]["client_id"] == "u3"


def test_review_sync_rend_la_reponse_et_ecrit_au_carnet(client):
    http, ecrit = client
    http.post("/api/paper/scalps", json=payload(client_id="u1"))
    resp = http.post("/api/paper/scalps/review?sync=1", json={"lang": "fr"})
    assert resp.status_code == 200, resp.text
    assert "Ralentis" in resp.json()["answer"]
    assert ecrit and ecrit[0][1] == "bilan scalps"
    assert ecrit[0][0] == "tester"


def test_review_detache_rend_un_job(client):
    http, ecrit = client
    resp = http.post("/api/paper/scalps/review", json={})
    assert resp.status_code == 200
    job_id = resp.json()["job"]

    # On ATTEND la fin du fil : un travail détaché encore en vol quand le test
    # se termine verrait ``monkeypatch`` remettre le VRAI ``write_scalp_review``
    # et partirait sur le CLI Claude — un test « hors ligne » qui ne l'est que
    # la plupart du temps ne prouve rien.
    from backend.bots import paper_router as pr
    for _ in range(200):
        if pr._JOBS.get(job_id, {}).get("status") != pr.JOB_PENDING:
            break
        time.sleep(0.01)
    assert pr._JOBS[job_id]["status"] == pr.JOB_DONE
    assert "Ralentis" in pr._JOBS[job_id]["result"]["answer"]
    assert ecrit and ecrit[0][1] == "bilan scalps"


def test_review_quatrieme_du_jour_429(client):
    http, _ = client
    for _ in range(3):
        assert http.post("/api/paper/scalps/review?sync=1",
                         json={}).status_code == 200
    resp = http.post("/api/paper/scalps/review?sync=1", json={})
    assert resp.status_code == 429


def test_review_llm_muet_502_et_jeton_rendu(client, monkeypatch):
    http, _ = client

    def muet(context, lang="fr"):
        raise RuntimeError("le coach n'a pas répondu")

    monkeypatch.setattr(llm, "write_scalp_review", muet)
    assert http.post("/api/paper/scalps/review?sync=1",
                     json={}).status_code == 502
    # Le jeton du plafond a été RENDU : le bilan suivant repart de zéro.
    monkeypatch.setattr(llm, "write_scalp_review",
                        lambda context, lang="fr": "Ça repart.")
    for _ in range(3):
        assert http.post("/api/paper/scalps/review?sync=1",
                         json={}).status_code == 200
    assert http.post("/api/paper/scalps/review?sync=1",
                     json={}).status_code == 429


def test_post_scalp_cotation_muette_accepte_quand_meme(client, monkeypatch):
    """Omen sans cours (Yahoo muet) : le scalp entre au ledger sans contrôle de
    prix — on ne perd pas la trace d'un trade parce qu'une source est morte."""
    http, _ = client

    def muet(symbol, client=None):
        raise quotes.QuoteError("cours indisponible")

    monkeypatch.setattr(quotes, "get_quote", muet)
    resp = http.post("/api/paper/scalps", json=payload(exit_price=999.0))
    assert resp.status_code == 200
    assert resp.json()["price_checked"] is False


def test_role_insuffisant_refuse(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "DATA_DIR", tmp_path / "paper_trading")
    app = FastAPI()
    app.include_router(tvr.router)
    app.dependency_overrides[get_current_user] = lambda: FakeUser(role="user")
    http = TestClient(app)
    assert http.get("/api/paper/scalps").status_code == 403
