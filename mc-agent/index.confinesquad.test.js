'use strict';
// Câblage index.js (22/10, NethBot1/3) : le rappel confine ne ramène plus chez lui un bot qui travaille
// avec la squad. Bac à sable vm strict : le vrai texte de confineWithSquad (niveau module, piège #56).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { mateNearby } = require('./regroup');

const SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
const fnSrc = (name) => {
  const m = SRC.match(new RegExp(`^(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}$`, 'm'));
  assert.ok(m, `function ${name} introuvable dans index.js`);
  return m[0];
};

function sandbox(mates, pos = { x: -218, y: 15, z: 236 }) {
  const sb = {
    Date: { now: () => 1_000_000 }, Math,
    mateNearby,
    presence: mates ? { list: () => mates } : null,
    bot: { username: 'NethBot3', entity: { position: pos } },
  };
  vm.createContext(sb);
  vm.runInContext("'use strict';\n" + fnSrc('confineWithSquad') + '\nthis.f = confineWithSquad;', sb);
  return sb;
}

test('confineWithSquad : NethBot1 à 28 blocs → avec la squad', () => {
  const sb = sandbox([{ name: 'NethBot1', x: -209, z: 263, role: 'worker', at: 1_000_000 }]);
  assert.strictEqual(sb.f(), true);
});

test('confineWithSquad : seul, sans présence ou coéquipier loin → false', () => {
  assert.strictEqual(sandbox(null).f(), false);
  assert.strictEqual(sandbox([{ name: 'NethBot1', x: 200, z: 263, role: 'worker', at: 1_000_000 }]).f(), false);
  assert.strictEqual(sandbox([{ name: 'NethBot3', x: -218, z: 236, role: 'worker', at: 1_000_000 }]).f(), false, 'soi-même');
});

test('câblage : le timer d enforcement passe withSquad à shouldEnforceConfine', () => {
  assert.match(SRC, /const withSquad = confineWithSquad\(\);/);
  assert.match(SRC, /lastAt: _lastConfineEnforceAt, withSquad \}\)\) \{/);
  assert.match(SRC, /^let _lastConfineSquadHoldAt = 0;$/m);
});
