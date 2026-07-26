'use strict';
// `smelt` : fond `count`× `input` -> `output` dans un four proche (<=6 blocs). Combustible = bois
// (planches/buches) ou charbon, pris dans l'inventaire. Le four est posé par l'appelant
// (placeBlockNear 'furnace', table/four PORTABLE). On récolte la sortie au fur et à mesure et on
// re-charge du combustible si le four s'éteint avant la fin. Garde-fou de temps (maxMs).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function _itemId(bot, name) {
  const d = bot.registry && bot.registry.itemsByName && bot.registry.itemsByName[name];
  return d ? d.id : null;
}
function _invCount(bot, name) {
  return ((bot.inventory && bot.inventory.items()) || []).filter((i) => i.name === name).reduce((s, i) => s + i.count, 0);
}
function _findFurnace(bot) {
  const d = bot.registry && bot.registry.blocksByName && bot.registry.blocksByName.furnace;
  return d ? bot.findBlock({ matching: [d.id], maxDistance: 6 }) : null;
}

/**
 * smelt(bot, { input, output, count, fuel, pollMs, maxMs }, token)
 *  input : nom de l'item à fondre (ex. 'raw_iron')
 *  output: nom attendu en sortie (info ; le four décide) (ex. 'iron_ingot')
 *  count : combien d'items fondre (borné par l'inventaire)
 *  fuel  : liste de noms de combustibles acceptés (ex. ['coal','charcoal','oak_planks',...])
 * Retour : { ok, got } | { ok:false, reason }
 */
async function smelt(bot, { input, output, count = 1, fuel = [], pollMs = 1000, maxMs = 180000 } = {}, token = null) {
  const inId = _itemId(bot, input);
  if (inId == null) return { ok: false, reason: 'unknown_item' };
  const fblock = _findFurnace(bot);
  if (!fblock) return { ok: false, reason: 'no_furnace' };
  const have = _invCount(bot, input);
  if (have < 1) return { ok: false, reason: 'no_input' };
  // PRÉ-CHECK DÉFICIT DE COMBUSTIBLE (lever vérifié, AltoClef SmeltInFurnaceTask.fuelNeeded) :
  // `fuelUnits` = SOURCE UNIQUE du combustible-équivalent dispo (coal=8, planches/bûches=1.5, …).
  // On ne charge JAMAIS plus d'input qu'on ne peut fondre → sinon du raw_iron reste dans le slot
  // input du four et peut être perdu au reclaim (four repris après une fonte partielle). Fonte
  // PARTIELLE assumée (want borné) plutôt qu'abort dur : ce qui est fondu est banké.
  const items0 = (bot.inventory && bot.inventory.items()) || [];
  const affordable = Math.floor(fuelUnits(items0, fuel));
  if (affordable < 1) return { ok: false, reason: 'no_fuel' };   // 0 combustible utile
  const want = Math.min(count, have, affordable);                 // borné par ce qu'on peut fondre
  // Combustible choisi par PRIORITÉ de la liste `fuel` (ordonnée coal→charcoal→planks→logs par
  // l'appelant), pas par ordre d'inventaire → le charbon est brûlé AVANT le bois (§0-bis anti-churn
  // bois : le bois reste dispo pour les outils/bâtons, le charbon miné en descendant fait la fonte).
  const pickFuel = () => pickFuelByPriority((bot.inventory && bot.inventory.items()) || [], fuel);

  let furnace;
  try { furnace = await bot.openFurnace(fblock); }
  catch (e) { return { ok: false, reason: 'open_failed' }; }

  let got = 0;
  try {
    try { await furnace.putInput(inId, null, want); } catch (e) {}
    const f0 = pickFuel();
    if (f0) { try { await furnace.putFuel(_itemId(bot, f0.name), null, Math.min(f0.count, want)); } catch (e) {} }

    const started = Date.now();
    while (got < want) {
      if (token && token.cancelled) break;
      if (Date.now() - started > maxMs) break;
      // re-charge du combustible si le four est à sec mais qu'il reste de l'input à fondre
      const hasFuel = !!(furnace.fuelItem && furnace.fuelItem());
      const hasInput = !!(furnace.inputItem && furnace.inputItem());
      if (!hasFuel && hasInput) {
        const f = pickFuel();
        if (!f) break;                                   // plus de combustible -> on s'arrête
        try { await furnace.putFuel(_itemId(bot, f.name), null, 1); } catch (e) {}
      }
      const out = furnace.outputItem && furnace.outputItem();
      if (out && out.count >= 1) {
        // takeOutput() retire la PILE ENTIÈRE. L'ancien `got += 1` sous-comptait donc massivement
        // (7 lingots pris en 2 prises = got 2) → `got >= want` faux → une fonte RÉUSSIE était
        // rapportée en échec, et le planner rebouclait sur un but déjà atteint. Vécu live
        // world_ax4 25/07 : 3× `opportunistic_smelt ok:false` alors que les bots avaient 1 et
        // 6 lingots en poche. On compte ce qui est réellement pris.
        try {
          const taken = await furnace.takeOutput();
          got += (taken && taken.count) ? taken.count : out.count;
        } catch (e) {}
        continue;                                        // re-check tout de suite (peut-être plusieurs prêts)
      }
      if (!hasInput && !(out && out.count >= 1)) break;  // plus rien à fondre ni à récupérer
      await sleep(pollMs);
    }
  } finally {
    try { furnace.close && furnace.close(); } catch (e) {}
  }
  return { ok: got >= want, got };
}

// PUR : choisit le 1er item d'inventaire présent en suivant l'ORDRE de priorité `fuel`
// (coal→charcoal→planks→logs) au lieu de l'ordre d'inventaire. §0-bis : brûle le charbon avant le bois.
function pickFuelByPriority(items, fuel) {
  const list = items || [];
  for (const name of (fuel || [])) {
    const it = list.find((i) => i && i.name === name);
    if (it) return it;
  }
  return null;
}

// Combustible-équivalent (nb d'items qu'UN exemplaire fond) — mécaniques MC standard (wiki Smelting).
// Le bois (toutes essences : planks/log/wood/stem/hyphae) = 1.5 ; charbon/charcoal = 8 ; etc.
const FUEL_BURN = {
  coal: 8, charcoal: 8, coal_block: 80, dried_kelp_block: 20, blaze_rod: 12,
  lava_bucket: 100, stick: 0.5, bamboo: 0.25,
};
function burnValue(name) {
  if (name == null) return 0;
  if (Object.prototype.hasOwnProperty.call(FUEL_BURN, name)) return FUEL_BURN[name];
  if (/_(planks|log|wood|stem|hyphae)$/.test(name)) return 1.5;   // toutes essences de bois
  return 0;                                                       // pas un combustible connu
}
// PUR : total du combustible-équivalent DISPO parmi les items acceptés (`fuel` = liste de noms
// autorisés). Sert de plafond au nombre d'items fondables (SOURCE UNIQUE, réutilisable par goals/gear).
function fuelUnits(items, fuel) {
  const allowed = new Set(fuel || []);
  return ((items || []).reduce(
    (s, it) => s + (it && allowed.has(it.name) ? burnValue(it.name) * (it.count || 0) : 0), 0));
}

// BÛCHES → PLANCHES AVANT DE BRÛLER (analyse jeu humain, 26/07).
// Une bûche brûlée telle quelle fond 1,5 objet ; convertie en 4 planches, elle en fond 6.
// Brûler la bûche brute gaspille donc 75 % du bois — et le manque de combustible est exactement
// ce qui bloquait la fonte (4 fontes réussies sur tout un run de 6 h 36). On ne convertit QUE
// si l'on n'a ni charbon ni assez de planches : le charbon reste prioritaire (il ne sert qu'à ça,
// alors que le bois sert aussi à crafter).
const PLANKS_PER_LOG = 4;

/**
 * PUR — faut-il convertir des bûches en planches avant d'allumer le four ?
 * @param {Array<{name,count}>} items inventaire
 * @param {number} wantSmelts nombre d'objets qu'on veut fondre
 * @returns {{convert:boolean, name?:string, logs?:number}}
 */
function logsToConvert(items, wantSmelts = 1) {
  const list = items || [];
  const counts = {};
  for (const it of list) if (it && it.name) counts[it.name] = (counts[it.name] || 0) + (it.count || 0);
  if ((counts.coal || 0) > 0 || (counts.charcoal || 0) > 0) return { convert: false };
  const planks = Object.keys(counts).filter((n) => n.endsWith('_planks'))
    .reduce((s, n) => s + counts[n], 0);
  if (planks * 1.5 >= wantSmelts) return { convert: false };     // les planches suffisent déjà
  const logName = Object.keys(counts).find((n) => n.endsWith('_log') && counts[n] > 0);
  if (!logName) return { convert: false };
  const manquant = wantSmelts - planks * 1.5;
  const logs = Math.min(counts[logName], Math.max(1, Math.ceil(manquant / (PLANKS_PER_LOG * 1.5))));
  return { convert: true, name: logName, logs };
}

module.exports = { smelt, pickFuelByPriority, fuelUnits, burnValue, logsToConvert, PLANKS_PER_LOG };
