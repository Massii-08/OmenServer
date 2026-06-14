"""
Distillation des captures comportementales (Phase 1b.1, spec §7).

Deux sorties à partir d'un ou plusieurs .jsonl :
  ① style.json  — statistiques de style (latence chat, réaction, taux de faute) ;
                  bloc derivedParams calé 1:1 sur mc-agent/humanize.js (calibration 1b.2).
  ② clips       — bibliothèque de motricité réelle segmentée par contexte (rejeu 1b.3).

Stdlib uniquement (json, gzip, statistics). Coefficients volontairement simples en v1
(se tunent sur de vraies captures) ; seule la FORME des sorties est figée par la spec.
"""
import gzip
import json
import statistics

# Défauts sains si la capture est trop pauvre pour mesurer (jamais 0 → humanize resterait muet).
_DEFAULTS = {
    "chat": {"latencyMeanMs": 1500, "latencyStdMs": 600, "typoRate": 0.03},
    "errorRate": 0.05,
    "movementJitter": 0.15,
}
_CLIP_MIN_FRAMES = 2


def _maybe_gunzip(payload):
    if payload[:2] == b"\x1f\x8b":  # magic gzip
        return gzip.decompress(payload)
    return payload


def load_records(payload):
    """Décompresse au besoin, parse le .jsonl → (header, [records])."""
    raw = _maybe_gunzip(payload)
    lines = [l for l in raw.decode("utf-8").splitlines() if l.strip()]
    if not lines:
        return {}, []
    header = json.loads(lines[0])
    records = []
    for line in lines[1:]:
        try:
            records.append(json.loads(line))
        except ValueError:
            continue
    return header, records


def _chat_latencies(records):
    """Latences (ms) entre un chat_in et le chat_out suivant — proxy du temps de réponse."""
    lat = []
    pending_in = None
    for r in records:
        if r.get("type") == "chat_in":
            pending_in = r.get("t")
        elif r.get("type") == "chat_out" and pending_in is not None:
            dt = r.get("t", 0) - pending_in
            if dt >= 0:
                lat.append(dt)
            pending_in = None
    return lat


def _typo_rate(records):
    """Heuristique simple : proportion de chat_out contenant un mot 'cassé' (sans voyelle / répétition)."""
    outs = [r.get("text", "") for r in records if r.get("type") == "chat_out"]
    if not outs:
        return None
    suspicious = sum(1 for t in outs if any(len(w) > 2 and not any(v in w.lower() for v in "aeiouy") for w in t.split()))
    return round(suspicious / len(outs), 3)


def _reaction_times(records):
    """Délais (ms) entre un stimulus (mob_appear/damage) et le tick suivant qui change d'input."""
    times = []
    last_stim = None
    last_in = None
    for r in records:
        t = r.get("type")
        if t in ("mob_appear", "damage"):
            last_stim = r.get("t")
        elif t == "tick":
            cur_in = r.get("in", {})
            if last_stim is not None and last_in is not None and cur_in != last_in:
                dt = r.get("t", 0) - last_stim
                if 0 <= dt <= 5000:
                    times.append(dt)
                last_stim = None
            last_in = cur_in
    return times


def _movement_jitter(records):
    """Écart-type des deltas de yaw entre ticks consécutifs (proxy de gigue de visée)."""
    yaws = [r.get("yaw") for r in records if r.get("type") == "tick" and r.get("yaw") is not None]
    if len(yaws) < 2:
        return None
    deltas = [abs(yaws[i + 1] - yaws[i]) for i in range(len(yaws) - 1)]
    try:
        return round(statistics.pstdev(deltas), 3)
    except statistics.StatisticsError:
        return None


def _mean_std(values):
    if not values:
        return None, None
    mean = round(statistics.mean(values))
    std = round(statistics.pstdev(values)) if len(values) > 1 else 0
    return mean, std


def distill_style(payloads, player):
    """Agrège ≥1 captures d'un joueur en un style.json (forme spec §7.1)."""
    all_records = []
    for p in payloads:
        _, recs = load_records(p)
        all_records.extend(recs)

    chat_lat = _chat_latencies(all_records)
    react = _reaction_times(all_records)
    lat_mean, lat_std = _mean_std(chat_lat)
    re_mean, re_std = _mean_std(react)
    typo = _typo_rate(all_records)
    jitter = _movement_jitter(all_records)

    chat_block = {
        "latencyMeanMs": lat_mean if lat_mean is not None else _DEFAULTS["chat"]["latencyMeanMs"],
        "latencyStdMs": lat_std if lat_std is not None else _DEFAULTS["chat"]["latencyStdMs"],
        "typoRate": typo if typo is not None else _DEFAULTS["chat"]["typoRate"],
        "msgs": sum(1 for r in all_records if r.get("type") == "chat_out"),
    }
    error_rate = _DEFAULTS["errorRate"]  # proxy affiné en 1b.2 sur vrais volumes
    movement_jitter = jitter if jitter is not None else _DEFAULTS["movementJitter"]

    return {
        "schema": 1,
        "player": player,
        "ticks": sum(1 for r in all_records if r.get("type") == "tick"),
        "reaction": {"meanMs": re_mean or 0, "stdMs": re_std or 0, "n": len(react)},
        "chat": chat_block,
        "errorRate": error_rate,
        "derivedParams": {
            "chat": {"latencyMeanMs": chat_block["latencyMeanMs"],
                     "latencyStdMs": chat_block["latencyStdMs"],
                     "typoRate": chat_block["typoRate"]},
            "errorRate": error_rate,
            "movementJitter": movement_jitter,
        },
    }


def _classify(prev_tick, cur_tick, recent_attack):
    """Contexte d'un tick : combat (attaque récente), mine (use/atk sur bloc), turn (gros dyaw), idle, locomotion."""
    cin = cur_tick.get("in", {})
    if recent_attack:
        return "combat"
    if cin.get("atk") or cin.get("use"):
        return "mine"
    dyaw = abs((cur_tick.get("yaw", 0) or 0) - (prev_tick.get("yaw", 0) or 0)) if prev_tick else 0
    moving = cin.get("fwd") or cin.get("back") or cin.get("left") or cin.get("right")
    if dyaw > 8:
        return "turn"
    if not moving and dyaw < 1:
        return "idle"
    return "locomotion"


def segment_clips(records, player):
    """Découpe le flux tick en clips courts taggés par contexte (frames = in + deltas de visée)."""
    ticks = [r for r in records if r.get("type") == "tick"]
    attack_times = [r.get("t", 0) for r in records if r.get("type") == "attack"]

    clips = []
    cur_ctx = None
    frames = []
    prev = None
    for tk in ticks:
        recent_attack = any(abs(tk.get("t", 0) - at) <= 500 for at in attack_times)
        ctx = _classify(prev, tk, recent_attack)
        dyaw = round((tk.get("yaw", 0) or 0) - (prev.get("yaw", 0) or 0), 3) if prev else 0.0
        dpitch = round((tk.get("pitch", 0) or 0) - (prev.get("pitch", 0) or 0), 3) if prev else 0.0
        frame = {"in": tk.get("in", {}), "dyaw": dyaw, "dpitch": dpitch}

        if ctx != cur_ctx and frames:
            if len(frames) >= _CLIP_MIN_FRAMES:
                clips.append({"ctx": cur_ctx, "player": player, "durTicks": len(frames), "frames": frames})
            frames = []
        cur_ctx = ctx
        frames.append(frame)
        prev = tk

    if frames and len(frames) >= _CLIP_MIN_FRAMES:
        clips.append({"ctx": cur_ctx, "player": player, "durTicks": len(frames), "frames": frames})
    return clips


# ── CLI de (re)distillation (capture-clone §3.A) — relancer quand de nouvelles REC arrivent ──────
# Usage : python -m backend.bots.mc_capture_distill [captures_dir] [out_dir]
#   captures_dir (déf data/mc-captures) : un sous-dossier par joueur, *.jsonl dedans.
#   out_dir      (déf data/mc-captures-distilled) : écrit <player>/style.json + <player>/clips/<ctx>.json.
# Produit AUSSI un "_all" (corpus tous joueurs fusionné) = style/clips plus robustes. Stdlib only.
def _read_player_payloads(captures_dir, player):
    import os
    import glob
    pdir = os.path.join(captures_dir, player)
    return sorted(glob.glob(os.path.join(pdir, "*.jsonl")))


def distill_to_dir(payload_files, out_player_dir, player):
    """Distille une liste de fichiers .jsonl → out_player_dir/{style.json, clips/<ctx>.json}."""
    import os
    payloads = []
    all_records = []
    for f in payload_files:
        with open(f, "rb") as fh:
            data = fh.read()
        payloads.append(data)
        _, recs = load_records(data)
        all_records.extend(recs)
    if not payloads:
        return None
    style = distill_style(payloads, player)
    clips = segment_clips(all_records, player)
    os.makedirs(out_player_dir, exist_ok=True)
    with open(os.path.join(out_player_dir, "style.json"), "w") as fh:
        json.dump(style, fh, indent=2)
    by_ctx = {}
    for c in clips:
        by_ctx.setdefault(c.get("ctx") or "idle", []).append(c)
    cdir = os.path.join(out_player_dir, "clips")
    os.makedirs(cdir, exist_ok=True)
    # purge d'anciens clips (re-distillation propre)
    for old in os.listdir(cdir):
        if old.endswith(".json"):
            try:
                os.remove(os.path.join(cdir, old))
            except OSError:
                pass
    for ctx, cs in by_ctx.items():
        with open(os.path.join(cdir, str(ctx) + ".json"), "w") as fh:
            json.dump(cs, fh)
    ticks = sum(1 for r in all_records if r.get("type") == "tick")
    return {"player": player, "sessions": len(payload_files), "ticks": ticks,
            "clips": len(clips), "ctx": {k: len(v) for k, v in by_ctx.items()}}


def main(argv=None):
    import os
    import sys
    args = argv if argv is not None else sys.argv[1:]
    captures_dir = args[0] if len(args) > 0 else "data/mc-captures"
    out_dir = args[1] if len(args) > 1 else "data/mc-captures-distilled"
    if not os.path.isdir(captures_dir):
        print("captures_dir introuvable:", captures_dir)
        return []
    players = sorted(d for d in os.listdir(captures_dir)
                     if os.path.isdir(os.path.join(captures_dir, d)) and not d.startswith("_"))
    summary = []
    all_files = []
    for p in players:
        files = _read_player_payloads(captures_dir, p)
        all_files.extend(files)
        r = distill_to_dir(files, os.path.join(out_dir, p), p)
        if r:
            summary.append(r)
            print("distilled", json.dumps(r))
    # corpus combiné tous joueurs
    if all_files:
        r = distill_to_dir(all_files, os.path.join(out_dir, "_all"), "_all")
        if r:
            summary.append(r)
            print("distilled", json.dumps(r))
    return summary


if __name__ == "__main__":
    main()
