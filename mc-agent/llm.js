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

/** Client Groq (API OpenAI-compatible) déguisé en client Anthropic-like. Gratuit (free tier, UE OK). */
function groqClient({ apiKey, fetchImpl } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  return {
    messages: {
      async create({ model, max_tokens, system, messages }) {
        const msgs = [];
        if (system) msgs.push({ role: 'system', content: system });
        for (const m of messages || []) msgs.push({ role: m.role || 'user', content: m.content });
        const resp = await doFetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model, messages: msgs, max_tokens: max_tokens || 300 }),
        });
        if (!resp.ok) {
          const err = new Error(`groq http ${resp.status}`);
          err.status = resp.status;
          throw err;
        }
        const data = await resp.json();
        const text = (((data.choices || [])[0] || {}).message || {}).content || '';
        return { content: [{ type: 'text', text }] };
      },
    },
  };
}

/** Fabrique le client LLM selon le provider. 'gemini'/'groq' → gratuit ; sinon Anthropic (défaut). */
function createLLMClient(provider, opts = {}) {
  const p = String(provider).toLowerCase();
  if (p === 'gemini') return geminiClient({ apiKey: opts.apiKey || process.env.GEMINI_API_KEY });
  if (p === 'groq') return groqClient({ apiKey: opts.apiKey || process.env.GROQ_API_KEY });
  return new Anthropic(); // lit ANTHROPIC_API_KEY depuis l'environnement
}

module.exports = { createLLMClient, geminiClient, groqClient };
