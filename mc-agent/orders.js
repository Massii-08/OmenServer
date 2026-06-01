'use strict';
// Parseur des commandes directes (mot-clé anglais). Pur, testable sans client MC.
// parseOrder(texte) -> {verb, args} | null (null = pas une commande -> flux LLM).

function _int(tok, def) {
  const n = parseInt(tok, 10);
  return Number.isFinite(n) ? n : def;
}

function parseOrder(text) {
  const s = String(text == null ? '' : text).trim().toLowerCase();
  if (!s) return null;
  const p = s.split(/\s+/);

  // multi-mots d'abord
  if (s === 'follow me') return { verb: 'follow', args: { who: 'me' } };
  if (s === 'give all') return { verb: 'giveAll', args: {} };
  if (p[0] === 'come' && (p.length === 1 || (p.length === 2 && p[1] === 'here'))) return { verb: 'come', args: {} };
  if (p[0] === 'mine' && p[1] === 'down') {
    if (p[2] == null) return null;
    return { verb: 'mineDown', args: { count: Math.max(1, _int(p[2], 1)) } };
  }

  switch (p[0]) {
    case 'stop': return { verb: 'stop', args: {} };
    case 'afk': return { verb: 'afk', args: {} };
    case 'eat': return { verb: 'eat', args: {} };
    case 'deposit': return { verb: 'deposit', args: {} };
    case 'guard': return { verb: 'guard', args: {} };
    case 'take':
      if (!p[1]) return null;
      return { verb: 'take', args: { name: p[1], count: Math.max(1, _int(p[2], 1)) } };
    case 'craft':
      if (!p[1]) return null;
      return { verb: 'craft', args: { name: p[1], count: Math.max(1, _int(p[2], 1)) } };
    case 'give':
      if (!p[1]) return null;
      return { verb: 'give', args: { name: p[1] } };
    case 'equip':
      if (!p[1]) return null;
      return { verb: 'equip', args: { name: p[1] } };
    case 'pvp':
      if (!p[1]) return null;
      return { verb: 'pvp', args: { player: text.trim().split(/\s+/)[1] } }; // garde la casse du pseudo
    case 'tpa':
      if (!p[1]) return null;
      return { verb: 'tpa', args: { target: p[1] === 'me' ? 'me' : text.trim().split(/\s+/)[1] } };
    case 'goto':
      if (p[1] == null || p[2] == null || p[3] == null) return null;
      return { verb: 'goto', args: { x: _int(p[1], 0), y: _int(p[2], 0), z: _int(p[3], 0) } };
    default:
      return null;
  }
}

module.exports = { parseOrder };
