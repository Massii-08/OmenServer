'use strict';
// Adaptateurs LLM pour le cerveau du bot. Chaque client expose la MÊME interface que le SDK
// Anthropic : client.messages.create({model, max_tokens, system, messages}) -> {content:[{text}]}.
// Ainsi brain.js (think) reste agnostique du fournisseur — on branche Claude (payant) ou
// Gemini (free tier) via une variable d'env, sans toucher au reste du bot.
const Anthropic = require('@anthropic-ai/sdk');

/** Client Gemini (REST generateContent) déguisé en client Anthropic-like. Gratuit (free tier). */
function geminiClient({ apiKey, fetchImpl } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  return {
    messages: {
      async create({ model, max_tokens, system, messages }) {
        const userText = (messages || []).map((m) => m.content).join('\n');
        const body = {
          contents: [{ role: 'user', parts: [{ text: userText }] }],
          generationConfig: { maxOutputTokens: max_tokens || 300 },
        };
        if (system) body.systemInstruction = { parts: [{ text: system }] };
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        const resp = await doFetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!resp.ok) {
          const err = new Error(`gemini http ${resp.status}`);
          err.status = resp.status;
          throw err;
        }
        const data = await resp.json();
        const cand = (data.candidates || [])[0] || {};
        const parts = (cand.content && cand.content.parts) || [];
        const text = parts.map((p) => p.text || '').join('');
        return { content: [{ type: 'text', text }] };
      },
    },
  };
}

/** Fabrique le client LLM selon le provider. 'gemini' → Gemini gratuit ; sinon Anthropic (défaut). */
function createLLMClient(provider, opts = {}) {
  if (String(provider).toLowerCase() === 'gemini') {
    return geminiClient({ apiKey: opts.apiKey || process.env.GEMINI_API_KEY });
  }
  return new Anthropic(); // lit ANTHROPIC_API_KEY depuis l'environnement
}

module.exports = { createLLMClient, geminiClient };
