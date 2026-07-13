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
  const want = Math.min(count, have);
  // Combustible choisi par PRIORITÉ de la liste `fuel` (ordonnée coal→charcoal→planks→logs par
  // l'appelant), pas par ordre d'inventaire → le charbon est brûlé AVANT le bois (§0-bis anti-churn
  // bois : le bois reste dispo pour les outils/bâtons, le charbon miné en descendant fait la fonte).
  const pickFuel = () => pickFuelByPriority((bot.inventory && bot.inventory.items()) || [], fuel);
  if (!pickFuel()) return { ok: false, reason: 'no_fuel' };

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
        try { await furnace.takeOutput(); got += 1; } catch (e) {}
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

module.exports = { smelt, pickFuelByPriority };
