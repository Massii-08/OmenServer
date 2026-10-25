'use strict';
// Câblage index.js des chantiers du 25/10 (fer des montagnes, bouclier enfilé, nuit sous terre).
// La logique est PURE (mountainIron.js, nightDeep.js, lowhp.js) ; ici on fige les branchements.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');

test('ctxExtra expose mountainIron (garde typeof pour les bacs à sable)', () => {
  assert.match(SRC, /mountainIron: \(typeof mountainIronForPlanner === 'function'\) \? mountainIronForPlanner\(\) : null,/);
});

test('runSkill : le skill mountainIron est dispatché et borné', () => {
  assert.match(SRC, /if \(goal\.skill === 'mountainIron'\) return await runMountainIron\(\);/);
  assert.match(SRC, /mountainIron: 300000/);
});

test('runMountainIron trace mountain_iron start/done avec le compte de blocs visibles', () => {
  const body = SRC.slice(SRC.indexOf('async function runMountainIron'), SRC.indexOf('async function runMountainIron') + 5000);
  assert.match(body, /type: 'mountain_iron', phase: 'start', visible: target\.visible/);
  assert.match(body, /type: 'mountain_iron', phase: 'done', outcome, visible: target\.visible/);
  assert.match(body, /floodFillVein\(bot, ore, tok\)/);           // outil récoltant + garde lave
  assert.match(body, /_caveInvTier\(\) < 2/);                       // jamais sans pioche pierre+
});

test('le bouclier forgé est enfilé en main secondaire', () => {
  const i = SRC.indexOf("if (goal.args.name === 'shield') {");
  assert.ok(i > 0);
  assert.match(SRC.slice(i, i + 900), /bot\.equip\(sh, 'off-hand'\)/);
});

test('maybeNightShelter tente la nuit sous terre (crépuscule / nuit) avant l abri de surface', () => {
  const i = SRC.indexOf('async function maybeNightShelter(');
  const body = SRC.slice(i, i + 9000);
  const deep = body.indexOf('await _duskDeepStep(sig)');
  const shelter = body.indexOf('if (shouldShelter(sig).shelter && Date.now() - lastShelterT > _shelterGap)');
  assert.ok(deep > 0 && shelter > deep);
});

test('hideFromThreat refuse l abri sous terre (sauf urgence, nightDeep.undergroundShelterVeto)', () => {
  const i = SRC.indexOf('async function hideFromThreat(');
  assert.match(SRC.slice(i, i + 1500), /nightDeep\.undergroundShelterVeto\(/);
});

test('lowHpSignals transmet underground à lowHpStep', () => {
  const i = SRC.indexOf('function lowHpSignals()');
  assert.match(SRC.slice(i, i + 2500), /underground: \(\(\) =>/);
});

test('gardes de niveau MODULE (piège #56)', () => {
  assert.match(SRC, /^let _mountainCache = /m);
  assert.match(SRC, /^let _duskDeepTriedNight = null;/m);
  assert.match(SRC, /^let _undergroundVetoAt = 0;/m);
});
