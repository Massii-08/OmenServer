'use strict';
// Réalisme PARAMÉTRÉ (spec §7.1) : transforme une réponse/un comportement « parfait » en
// apparence humaine via des modèles contrôlés (distribution de timing, taux de faute, gigue de
// visée). Calibré sur de VRAIES captures (3 joueurs, 1,5 M ticks @20 Hz, juin 2026) :
//   Δyaw/tick médian ≈ 0°, p90 ≈ 4.5°, p99 ≈ 27° (queue lourde) ; figé ~50 % du temps ;
//   latence chat médiane ≈ 3 s (0.4 → 47 s). PAS de clonage 1:1 (signature analysable) — un MODÈLE.

const DEG = Math.PI / 180;
function _clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

/** Tirage normal centré-réduit (Box-Muller). Consomme 2 valeurs rng. */
function _gauss(rng) {
  const u1 = Math.max(rng(), 1e-9);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Échantillonne un temps de réaction CHAT (ms) depuis une normale, tronqué. */
function sampleDelay(params, rng = Math.random) {
  const chat = (params && params.chat) || {};
  const mean = chat.latencyMeanMs == null ? 800 : chat.latencyMeanMs;
  const std = chat.latencyStdMs == null ? 300 : chat.latencyStdMs;
  const ms = mean + _gauss(rng) * std;
  // borné : jamais < 80ms (réflexe humain mini), jamais > mean + 3*std (anti-traîne)
  return Math.round(Math.min(Math.max(ms, 80), mean + 3 * std));
}

/**
 * Délai de RÉACTION (ms) avant un réflexe physique (manger/fuir/riposter/remonter/se murer).
 * Anti-tell #3 : un humain ne réagit jamais en 0 ms à l'event moteur (= aimbot/ban). Calibré
 * sur reaction.meanMs/stdMs des captures si présents (le mod 0.1.0 ne les loggue pas encore →
 * défaut humain ~300 ms). Plancher 120 ms (réflexe mini), plafond mean+3*std.
 */
function sampleReactionDelay(params, rng = Math.random) {
  const r = (params && params.reaction) || {};
  const mean = r.meanMs == null ? 300 : r.meanMs;
  const std = r.stdMs == null ? 110 : r.stdMs;
  const ms = mean + _gauss(rng) * std;
  return Math.round(Math.min(Math.max(ms, 120), mean + 3 * std));
}

/**
 * Prochaine cible de visée (marche aléatoire bornée) — anti snap-aim / tête figée.
 * `cur` = {yaw, pitch} en RADIANS ; retourne {yaw, pitch, kind} en radians.
 * Distribution calée sur les captures : la plupart des pas = micro-dérive (~0°), parfois un
 * coup d'œil (quelques °), rarement (mode 'active') un grand tour (regard alentour).
 * `opts.mode` : 'active' (au jeu, grands tours possibles) | 'idle' (dérive douce SEULEMENT —
 * pas de gestes brusques, cf. exigence Massii « pas de gestes bizarres »).
 */
function nextLook(cur, params, rng = Math.random, opts = {}) {
  const y0 = (cur && typeof cur.yaw === 'number') ? cur.yaw : 0;
  const p0 = (cur && typeof cur.pitch === 'number') ? cur.pitch : 0;
  const rawJ = params && (params.lookJitter != null ? params.lookJitter
    : (params.movementJitter != null ? params.movementJitter : 0.2));
  const intensity = _clamp(Number(rawJ) || 0, 0, 1);
  const scale = 0.5 + intensity;                 // 0 → 0.5× … 1 → 1.5×
  const idle = opts.mode === 'idle';
  const roll = rng();

  let dyawDeg = 0;
  let dpitchDeg = 0;
  const holdCut = idle ? 0.70 : 0.55;
  if (roll < holdCut) {                           // HOLD : micro-dérive (la vue « respire »)
    dyawDeg = _gauss(rng) * 0.6 * scale;
    dpitchDeg = _gauss(rng) * 0.35 * scale;
  } else if (idle || roll < 0.90) {               // GLANCE : petit coup d'œil
    const sign = rng() < 0.5 ? -1 : 1;
    const span = idle ? 4 : 6;                     // idle plus doux
    dyawDeg = sign * (2 + span * rng()) * scale;
    dpitchDeg = (rng() - 0.5) * 4 * scale;
  } else {                                         // TURN : grand tour (regard alentour) — actif only
    const sign = rng() < 0.5 ? -1 : 1;
    dyawDeg = sign * (15 + 35 * rng()) * scale;
    dpitchDeg = (rng() - 0.5) * 6 * scale;
  }
  return {
    yaw: y0 + dyawDeg * DEG,
    pitch: _clamp(p0 + dpitchDeg * DEG, -Math.PI / 2, Math.PI / 2),
    kind: roll < holdCut ? 'hold' : (idle || roll < 0.90 ? 'glance' : 'turn'),
  };
}

// Voisins clavier (QWERTY — substitution « doigt à côté », la faute humaine dominante).
const _NEIGHBORS = {
  a: 'sqz', b: 'vghn', c: 'xdfv', d: 'serfcx', e: 'wsdr', f: 'drtgvc', g: 'ftyhbv',
  h: 'gyujnb', i: 'ujko', j: 'huikmn', k: 'jiolm', l: 'kop', m: 'njk', n: 'bhjm',
  o: 'iklp', p: 'ol', q: 'wa', r: 'edft', s: 'awedxz', t: 'rfgy', u: 'yhji',
  v: 'cfgb', w: 'qase', x: 'zsdc', y: 'tghu', z: 'asx',
};

/** Insère occasionnellement des fautes de frappe (taux paramétré). 0 = aucune.
 *  3 modes pondérés : transposition, substitution voisin-clavier (réaliste), omission. */
function applyTypos(text, rate = 0, rng = Math.random) {
  if (!text || rate <= 0) return text;
  const chars = String(text).split('');
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (!/[a-zA-Zàâéèêëîïôûùç]/.test(ch)) continue;
    if (rng() >= rate) continue;
    const pick = rng();
    if (pick < 0.34 && i + 1 < chars.length) {                 // inversion
      chars[i] = chars[i + 1]; chars[i + 1] = ch; i++;
    } else if (pick < 0.70) {                                   // substitution voisin clavier
      const lower = ch.toLowerCase();
      const nb = _NEIGHBORS[lower];
      if (nb) {
        const sub = nb[Math.floor(rng() * nb.length)] || ch;
        chars[i] = (ch === lower) ? sub : sub.toUpperCase();
      } else { chars[i] = ''; }
    } else {                                                    // omission
      chars[i] = '';
    }
  }
  return chars.join('');
}

/** Munge de REGISTRE chat Minecraft réel : minuscules + chute de la ponctuation finale.
 *  `params.chat.casual` ∈ [0,1] (0 = inchangé). Conserve TOUJOURS le contenu (mêmes mots). */
function mungeChat(text, params, rng = Math.random) {
  const casual = (params && params.chat && params.chat.casual != null) ? params.chat.casual : 0.5;
  let out = String(text == null ? '' : text);
  if (casual <= 0) return out;
  if (rng() < casual) out = out.toLowerCase();
  // retire UN point final simple (pas les '...' ni '?'/'!') — chat de jeu = peu ponctué
  if (rng() < casual && /[^.]\.$/.test(out)) out = out.replace(/\.$/, '');
  return out;
}

/**
 * Post-traite la réponse selon le profil → { text, delayMs }.
 * delayMs = latence de réflexion (sampleDelay) + TEMPS DE FRAPPE proportionnel à la longueur
 * (anti-tell : latence indépendante du contenu) + rare « distraction » (queue lourde réelle).
 */
function humanizeReply(profile, reply, rng = Math.random) {
  const params = (profile && profile.params) || {};
  const typoRate = (params.chat && params.chat.typoRate) || 0;
  const text = applyTypos(mungeChat(reply, params, rng), typoRate, rng);
  const base = sampleDelay(params, rng);
  const perChar = 35 + 55 * rng();                              // 35–90 ms / caractère
  let typing = Math.min(String(reply == null ? '' : reply).length * perChar, 8000);
  if (rng() < 0.08) typing += 1000 + 4000 * rng();             // distraction occasionnelle (tail)
  return { text, delayMs: Math.round(base + typing) };
}

module.exports = {
  sampleDelay, sampleReactionDelay, applyTypos, mungeChat, nextLook, humanizeReply,
};
