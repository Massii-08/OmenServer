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

module.exports = { parseDecision, RateLimiter };
