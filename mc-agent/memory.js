'use strict';
// Mémoire de conversation par joueur : fenêtre glissante + TTL d'inactivité (oubli).
// Horloge injectable (tests déterministes), comme RateLimiter.

function createMemory({ maxTurns = 8, ttlMs = 600000, now = () => Date.now() } = {}) {
  const store = new Map(); // userLower -> { turns:[{role,content}], lastTs }
  const key = (u) => String(u == null ? '' : u).trim().toLowerCase();

  function entry(user) {
    const k = key(user);
    let e = store.get(k);
    const t = now();
    if (e && t - e.lastTs > ttlMs) { store.delete(k); e = null; } // expiré → oubli
    if (!e) { e = { turns: [], lastTs: t }; store.set(k, e); }
    return e;
  }

  return {
    history(user) { return entry(user).turns.slice(); },
    append(user, role, content) {
      const e = entry(user);
      e.turns.push({ role: role === 'assistant' ? 'assistant' : 'user', content: String(content == null ? '' : content) });
      if (e.turns.length > maxTurns) e.turns = e.turns.slice(-maxTurns);
      e.lastTs = now();
    },
    reset(user) { store.delete(key(user)); },
  };
}

module.exports = { createMemory };
