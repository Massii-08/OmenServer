'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { SYSTEM_PROMPT, buildSystemPrompt, buildLangDocs } = require('./brain');


// ─── LANGUE : repondre dans la langue de la QUESTION ───────────────────────────────────────────
// Massii, live 26/07 : « corrige aussi qu'il parle pas que en francais, parce qu'on leur fait les
// question en ita et il rep [en fr] ». L'instruction etait « Ecris TOUJOURS le champ reply en
// francais » : le prompt ECRASAIT la langue de l'interlocuteur. Un vrai joueur repond dans la
// langue ou on lui parle.
test('buildLangDocs : miroir de la langue de l interlocuteur, avec repli configure', () => {
  const doc = buildLangDocs('fr');
  assert.match(doc, /m[eê]me langue|same language/i, 'doit demander de repondre dans la langue du message');
  assert.match(doc, /fran[cç]ais/i, 'doit nommer la langue de repli');
  assert.doesNotMatch(doc, /TOUJOURS/i, 'ne doit plus imposer une langue unique');
});

test('buildLangDocs : langue inconnue/absente → aucune consigne (rétro-compat)', () => {
  assert.strictEqual(buildLangDocs(''), '');
  assert.strictEqual(buildLangDocs('xx'), '');
});

test('buildSystemPrompt(null) reste STRICTEMENT le SYSTEM_PROMPT (invariant pinne)', () => {
  assert.strictEqual(buildSystemPrompt(null), SYSTEM_PROMPT);
});
