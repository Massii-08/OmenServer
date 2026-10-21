'use strict';
// ─── CREUSER SANS JAMAIS RESTER BLOQUÉ (live 21/10, NethBot3 session 48) ─────────────────────────
// `bot.dig` de mineflayer 4.37 (lib/plugins/digging.js) n'a AUCUNE borne : après l'envoi du paquet de
// fin, il attend l'event `blockUpdate:<pos>` qui annonce le bloc devenu air. Si cet event ne vient
// jamais — le bot a été TÉLÉPORTÉ pendant le creusage (/home safe parti juste avant l'abri : le chunk
// d'origine est déchargé, le serveur ignore un coup porté à 400 blocs), ou le serveur refuse la casse —
// la promesse ne se résout ni ne se rejette, JAMAIS. Vécu : `shelter dig_in` puis 10+ min sans un seul
// event, planner gelé, bot debout au jour levé.
// `boundedDig` : la course entre le creusage et trois sorties — borne de temps, téléport (`forcedMove`,
// émis par mineflayer à chaque position imposée par le serveur) et jeton annulé (relu toutes les 250 ms).
// Toute sortie autre que la casse appelle `bot.stopDigging()` (retire l'écouteur de mineflayer, arme
// `diggingAborted`) : rien ne reste en vol derrière nous.

const DIG_STEP_TIMEOUT_MS = 15000;   // une étape de creusage d'abri : ≤ 15 s (pierre à la main ≈ 7,5 s)
const EQUIP_TIMEOUT_MS = 5000;

/** Course promesse / borne, sans throw : → { ok:true, value } | { ok:false, reason:'timeout'|'error' }. */
function bounded(promise, ms) {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve({ ok: false, reason: 'timeout' }); } }, ms);
    Promise.resolve(promise).then(
      (v) => { if (!done) { done = true; clearTimeout(t); resolve({ ok: true, value: v }); } },
      () => { if (!done) { done = true; clearTimeout(t); resolve({ ok: false, reason: 'error' }); } },
    );
  });
}

/** Équiper, borné (jamais de throw). → true si équipé. */
async function boundedEquip(bot, item, dest = 'hand', ms = EQUIP_TIMEOUT_MS) {
  if (!bot || typeof bot.equip !== 'function' || !item) return false;
  let p;
  try { p = bot.equip(item, dest); } catch (e) { return false; }
  const r = await bounded(p, ms);
  return r.ok;
}

const FORCED_MOVE_TELEPORT_DIST = 2; // même seuil que le avant/après de shelter.js (piège du jour, 21/10)

/**
 * Creuse `block`, borné. → { ok:true } | { ok:false, reason:'timeout'|'teleported'|'cancelled'|'error'|'no_block' }.
 * opts : { timeoutMs (déf 15 s), token ({cancelled}), pollMs (déf 250) }. Jamais de throw.
 *
 * ⚠️ `forcedMove` (mineflayer) n'est pas toujours un VRAI téléport : le paquet position_and_look que le
 * serveur envoie pour CONFIRMER le respawn (ou un simple resync anti-cheat) le déclenche aussi, SANS
 * déplacer le bot (`dist:0` mesuré en live, NethBot1 21/10 — mort en boucle juste après le respawn,
 * précisément parce que la dig du puits était avortée à tort à cet instant). Avec `bot.entity.position`
 * connu, on ne traite le `forcedMove` comme un téléport que s'il a RÉELLEMENT déplacé le bot (position
 * COPIÉE — `entity.position` est muté en place par le serveur, piège #73d). Sans `bot.entity` (faux bots
 * des tests d'origine) : comportement d'origine, tout forcedMove reste un téléport.
 */
function boundedDig(bot, block, opts = {}) {
  if (!bot || !block || typeof bot.dig !== 'function') return Promise.resolve({ ok: false, reason: 'no_block' });
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : DIG_STEP_TIMEOUT_MS;
  const pollMs = Number.isFinite(opts.pollMs) && opts.pollMs > 0 ? opts.pollMs : 250;
  const token = opts.token || null;
  const p0 = bot.entity && bot.entity.position;
  const from = (p0 && Number.isFinite(p0.x) && Number.isFinite(p0.y) && Number.isFinite(p0.z))
    ? { x: p0.x, y: p0.y, z: p0.z } : null;
  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    let poll = null;
    const onMove = () => {
      if (from) {
        const p1 = bot.entity && bot.entity.position;
        const moved = p1 ? Math.hypot(p1.x - from.x, p1.y - from.y, p1.z - from.z) : Infinity;
        if (moved < FORCED_MOVE_TELEPORT_DIST) return; // resync/confirmation de respawn — pas un vrai téléport
      }
      finish({ ok: false, reason: 'teleported' }, true);
    };
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (poll) clearInterval(poll);
      try { if (typeof bot.removeListener === 'function') bot.removeListener('forcedMove', onMove); } catch (e) { /* best-effort */ }
    };
    function finish(res, abort) {
      if (done) return;
      done = true;
      cleanup();
      if (abort) { try { if (typeof bot.stopDigging === 'function') bot.stopDigging(); } catch (e) { /* best-effort */ } }
      resolve(res);
    }
    if (token && token.cancelled) { done = true; resolve({ ok: false, reason: 'cancelled' }); return; }
    try { if (typeof bot.on === 'function') bot.on('forcedMove', onMove); } catch (e) { /* best-effort */ }
    timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }, true), timeoutMs);
    if (token) poll = setInterval(() => { if (token.cancelled) finish({ ok: false, reason: 'cancelled' }, true); }, pollMs);
    let p;
    try { p = bot.dig(block); } catch (e) { finish({ ok: false, reason: 'error' }, false); return; }
    Promise.resolve(p).then(() => finish({ ok: true }, false), () => finish({ ok: false, reason: 'error' }, false));
  });
}

module.exports = { boundedDig, boundedEquip, bounded, DIG_STEP_TIMEOUT_MS, EQUIP_TIMEOUT_MS };
