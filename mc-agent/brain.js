'use strict';
// Cerveau LLM événementiel (Claude) : dialogue + choix de skill.

/** Parse la réponse texte de Claude en décision structurée. Tolère les fences ```json. */
function parseDecision(text) {
  if (typeof text !== 'string') throw new Error('decision text must be a string');
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const obj = JSON.parse(t);
  return {
    reply: typeof obj.reply === 'string' ? obj.reply : '',
    action: typeof obj.action === 'string' ? obj.action : null,
    args: (obj.args && typeof obj.args === 'object') ? obj.args : {},
  };
}

/** Limiteur d'appels : au plus maxCalls dans une fenêtre glissante de windowMs (garde-fou coût). */
class RateLimiter {
  constructor(maxCalls, windowMs, now = () => Date.now()) {
    this.maxCalls = maxCalls;
    this.windowMs = windowMs;
    this._now = now;
    this._hits = [];
  }
  tryAcquire() {
    const t = this._now();
    this._hits = this._hits.filter((h) => t - h < this.windowMs);
    if (this._hits.length >= this.maxCalls) return false;
    this._hits.push(t);
    return true;
  }
}

const SYSTEM_PROMPT = [
  "Tu incarnes un joueur dans une partie Minecraft, dans un cadre d'entrainement de moderation.",
  "Tu es honnete : si on te demande si tu es un bot, tu peux le confirmer.",
  'Reponds UNIQUEMENT en JSON : {"reply": string, "action": string|null, "args": object}.',
  'Actions possibles : "follow" (args {player}), "goto" (args {x,y,z}), ou null (juste parler).',
].join(' ');

/**
 * Appelle Claude avec l'état + le message reçu. `client` = SDK Anthropic (injectable pour tests).
 * Retourne une décision parsée, ou null si le rate-limiter bloque l'appel.
 */
async function think(client, { state, message, model, limiter }) {
  if (limiter && !limiter.tryAcquire()) return null;
  const resp = await client.messages.create({
    model,
    max_tokens: 300,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: `Etat: ${JSON.stringify(state)}\nMessage recu: ${message}` }],
  });
  const text = (resp.content || []).map((b) => b.text || '').join('');
  return parseDecision(text);
}

module.exports = { parseDecision, RateLimiter, think, SYSTEM_PROMPT };
