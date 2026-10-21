'use strict';
// BUG (veille autonome 21/10) : session NethBot3 crashée par OOM après 24 min de branch-mine, avec
// des centaines de `craft_fail_ctx {name:"torch", reason:"no_coal"}` au même rythme que
// `branchSurvivalTick` (tous les 4 paliers). Cause : `ensureTorches()` ne vérifie qu'« au moins 1
// charbon » avant d'appeler `craftSmart({name:'torch', count:8})` — avec 1 à 7 charbons en poche
// (le cas courant en branch-mine, le charbon n'arrive pas par lot de 8), le craft ÉCHOUE TOUJOURS
// (la recette veut 1 charbon PAR torche) et se refait à la prochaine survivalTick, indéfiniment,
// jusqu'à ce que le charbon atteigne 8. Fix : demander `min(8, charbon dispo)`, comme le fait déjà
// le but planner équivalent (index.js:2879, `Math.min(goal.args.count || 2, coalHave)`).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
function grab(re, label) {
  const m = SRC.match(re);
  assert.ok(m, `${label} introuvable dans index.js (déplacé, renommé, ou déclaré hors niveau module ?)`);
  return m[0];
}
const fnSrc = (name) => grab(new RegExp(`^(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}$`, 'm'), `function ${name}`);
const run = (sb, code) => vm.runInContext("'use strict';\n" + code, sb);

function itemsFor(coal, stick, torch) {
  const out = [];
  if (coal > 0) out.push({ name: 'coal', count: coal });
  if (stick > 0) out.push({ name: 'stick', count: stick });
  if (torch > 0) out.push({ name: 'torch', count: torch });
  return out;
}

function sandbox({ coal, stick = 4, torch = 0 }) {
  const sb = {
    craftCalls: [], events: [],
    emit(e) { sb.events.push(e); },
    gather: async () => ({ ok: false }),
    craftSmart: async (args) => { sb.craftCalls.push(args); return { ok: true }; },
    bot: {
      registry: { blocksByName: {} },
      findBlock: () => null,
      inventory: { items: () => itemsFor(coal, stick, torch) },
    },
    taskToken: null,
  };
  vm.createContext(sb);
  run(sb, fnSrc('ensureTorches'));
  return sb;
}

test('ensureTorches : avec moins de 8 charbons, demande un lot borné au charbon dispo (jamais un craft voué à échouer)', async () => {
  const sb = sandbox({ coal: 3 });
  await run(sb, 'ensureTorches()');
  assert.strictEqual(sb.craftCalls.length, 1, 'un seul appel craftSmart attendu');
  assert.strictEqual(sb.craftCalls[0].name, 'torch');
  assert.ok(sb.craftCalls[0].count <= 3, `count (${sb.craftCalls[0].count}) ne doit pas dépasser le charbon dispo (3)`);
});

test('ensureTorches : avec >= 8 charbons, demande toujours un lot de 8 (comportement historique préservé)', async () => {
  const sb = sandbox({ coal: 12 });
  await run(sb, 'ensureTorches()');
  assert.strictEqual(sb.craftCalls.length, 1);
  assert.strictEqual(sb.craftCalls[0].count, 8);
});

test('ensureTorches : déjà 8 torches en poche → ne tente rien', async () => {
  const sb = sandbox({ coal: 12, torch: 8 });
  await run(sb, 'ensureTorches()');
  assert.strictEqual(sb.craftCalls.length, 0);
});
