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
    command: typeof obj.command === 'string' ? obj.command : null,
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

const ACTIONS_DOC =
  'Actions possibles : "follow" {player}, "goto" {x,y,z}, "mineBlock" {name,count}, ' +
  '"collectWood" {count}, "attackNearest" {}, "fleeFrom" {}, ou null (juste parler).';

// Posture ÉVASIVE (décision Massii 07/06 : le bot doit passer pour un humain, ne jamais avouer).
// Injectée dans TOUS les prompts (base + profils). Remplace l'ancienne clause d'honnêteté.
const EVASIVE = "Si on te demande si tu es un bot, une IA ou un programme, reste naturel et evasif comme un vrai joueur agace, ne l'admets jamais et ne te trahis pas.";

// Prompt de base (profil null). Conservé comme export pour compat (tests Phase 0).
const SYSTEM_PROMPT = [
  'Tu incarnes un joueur dans une partie Minecraft.',
  EVASIVE,
  'Reponds UNIQUEMENT en JSON : {"reply": string, "action": string|null, "args": object}.',
  ACTIONS_DOC,
].join(' ');

const LANG_NAMES = { fr: 'francais', en: 'anglais', it: 'italien' };

/** Bloc langue pour le system prompt. '' si langue inconnue/absente. */
// LANGUE — MIROIR de l'interlocuteur (Massii, live 26/07 : « corrige aussi qu'il parle pas que en
// francais, parce qu'on leur fait les question en ita et il rep [en fr] »). L'ancienne consigne
// « Ecris TOUJOURS le champ reply en <langue> » ECRASAIT la langue de la question : un joueur
// italien recevait une reponse en francais, ce qui est un tell de bot autant qu'une impolitesse.
// Un vrai joueur repond dans la langue ou on lui parle ; la langue du profil n'est qu'un REPLI.
function buildLangDocs(lang) {
  const name = LANG_NAMES[String(lang || '').toLowerCase()];
  if (!name) return '';
  return `Ecris le champ "reply" dans la MEME langue que le message recu. Si la langue du message est indeterminable, ecris en ${name}.`;
}

/** Construit le system prompt : persona + commandes serveur + gens de confiance + langue. */
function buildSystemPrompt(profile, commandDocs = '', trustDocs = '', langDocs = '') {
  const base = profile
    ? [
        'Tu incarnes un joueur dans une partie Minecraft.',
        profile.persona || '',
        EVASIVE,
        'Reponds UNIQUEMENT en JSON : {"reply": string, "action": string|null, "args": object, "command": string|null}.',
        ACTIONS_DOC,
      ]
    : [SYSTEM_PROMPT];
  if (commandDocs) base.push(commandDocs);
  if (trustDocs) base.push(trustDocs);
  if (langDocs) base.push(langDocs);
  return base.filter(Boolean).join(' ');
}

/**
 * Appelle Claude avec l'état + le message reçu. `client` = SDK Anthropic (injectable pour tests).
 * Retourne une décision parsée, ou null si le rate-limiter bloque l'appel.
 * `profile` : objet profil optionnel (injecte la persona dans le system prompt).
 */
async function think(client, { state, message, model, limiter, profile = null, commandDocs = '', trustDocs = '', sender = '', history = [], lang = '' }) {
  if (limiter && !limiter.tryAcquire()) return null;
  const fromLine = sender ? `De: ${sender}\n` : '';
  const prior = (Array.isArray(history) ? history : []).map((h) => ({
    role: h && h.role === 'assistant' ? 'assistant' : 'user',
    content: String((h && h.content) || ''),
  }));
  const resp = await client.messages.create({
    model,
    max_tokens: 300,
    system: buildSystemPrompt(profile, commandDocs, trustDocs, buildLangDocs(lang)),
    messages: [...prior, { role: 'user', content: `Etat: ${JSON.stringify(state)}\n${fromLine}Message recu: ${message}` }],
  });
  const text = (resp.content || []).map((b) => b.text || '').join('');
  return parseDecision(text);
}

module.exports = { parseDecision, RateLimiter, think, SYSTEM_PROMPT, buildSystemPrompt, buildLangDocs };
