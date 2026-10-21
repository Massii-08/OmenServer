'use strict';
// Dispatch `runGoalSkill` : la branche `goal.skill === 'craftPlanks'` (goal MAPPER_KIT « planks »,
// goals.js:446) réimplémentait sa propre recherche de bûche en `.endsWith('_log')` NU, sans exclure
// les bûches écorcées (`stripped_*`), et nommait la planche par simple `.replace('_log','_planks')`.
// Vécu en prod (session-113, MapBot2, 22/10) : inventaire `stripped_birch_log:1, birch_log:8` →
// `.find()` tombe parfois sur la bûche écorcée → crafte `stripped_birch_planks`, un item qui
// N'EXISTE PAS dans minecraft-data (ni l'inverse : `stripped_birch_boat` vu en session-108) →
// `goal_failed name:planks reason:unknown_item` en boucle serrée (8× en 10 min, mapper_kit_stalled).
// `craftPlan.logBase` fait déjà ce tri correctement (testé dans craftPlan.test.js) — cette branche
// doit s'en servir au lieu de sa propre logique, comme le fait déjà `_craftPrereqs`/`_craftSmartRaw`.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
function grab(re, label) {
  const m = SRC.match(re);
  assert.ok(m, `${label} introuvable dans index.js (déplacé, renommé, ou déclaré hors niveau module ?)`);
  return m[0];
}
const fnSrc = (name) => grab(new RegExp(`^(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}$`, 'm'), `function ${name}`);

test('dispatch : runGoalSkill importe logBase depuis craftPlan', () => {
  assert.match(SRC, /require\('\.\/craftPlan'\)/);
  const reqLine = grab(/^const \{[^}]*\} = require\('\.\/craftPlan'\);$/m, "require('./craftPlan')");
  assert.match(reqLine, /\blogBase\b/, "logBase n'est pas déstructuré depuis craftPlan — la branche craftPlanks ne peut pas s'en servir");
});

test('dispatch : runGoalSkill/craftPlanks utilise logBase (exclut stripped_*), pas .endsWith("_log") nu', () => {
  const rgs = fnSrc('runGoalSkill');
  const block = rgs.match(/if \(goal\.skill === 'craftPlanks'\) \{[\s\S]*?\n {2}\}/);
  assert.ok(block, "bloc 'craftPlanks' introuvable dans runGoalSkill");
  const body = block[0];
  assert.match(body, /logBase\(i\.name\)/, 'la recherche de la bûche doit filtrer via logBase (exclut stripped_*)');
  assert.match(body, /logBase\(log\.name\)/, 'le nom de la planche cible doit être dérivé via logBase, pas un .replace naïf');
  assert.doesNotMatch(
    body, /\.find\(\(i\) => i\.name\.endsWith\('_log'\)\)/,
    'régression : la recherche de bûche est redevenue naïve (accepte à nouveau stripped_*)'
  );
  assert.doesNotMatch(
    body, /log\.name\.replace\('_log', '_planks'\)/,
    "régression : le nom de planche est redevenu un .replace('_log','_planks') naïf"
  );
});
