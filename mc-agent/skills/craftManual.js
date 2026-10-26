'use strict';
// CRAFT MANUEL CASE PAR CASE (26/10) — bouclier « missing ingredient » sur le vrai serveur.
//
// Sonde `CraftProbe` (16 planches de chêne + 2 lingots, table à côté) : `bot.craft` lève
// `missing ingredient` sur la recette `[[planche, LINGOT, planche], …]`. Instrumentation de
// `window.findInventoryItem` : planches trouvées (slot 38), lingot trouvé (slot 37), puis planches
// INTROUVABLES. Mécanisme (mineflayer/lib/plugins/craft.js, `clickShape`) : quand l'ingrédient change
// en cours de ligne, mineflayer clique la pile suivante AVEC l'ancienne encore sur le curseur — un
// ÉCHANGE (swap) curseur ↔ case. Les planches restantes atterrissent dans la case du lingot côté
// prédiction locale, et le serveur réel renvoie ses propres mises à jour par-dessus : le modèle local
// perd les planches. Le bouclier est la seule recette courante où deux ingrédients ALTERNENT sur une
// ligne, d'où pioches/épées/armure/four/table indemnes.
//
// Remède : un craft qui ne fait JAMAIS d'échange. Pour chaque ingrédient distinct : curseur vide →
// clic gauche sur la pile (prise) → un clic DROIT par case cible (dépose 1) → clic gauche sur la case
// d'origine (ou une case libre) pour reposer le reste. Le curseur est vide entre deux ingrédients.
// Puis shift-clic sur la case résultat (slot 0), et fermeture de la fenêtre (le serveur rend tout ce
// qui resterait dans la grille). Chaque étape est bornée dans le temps. UNE fenêtre par exemplaire.

const STEP_TIMEOUT_MS = 4000;     // une action fenêtre (clic, ouverture)
const RESULT_TIMEOUT_MS = 2500;   // le serveur calcule la case résultat
const POLL_MS = 50;

const _realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// PUR : cases de la grille (3 de large par défaut) à remplir, regroupées par ingrédient, dans l'ordre
// de première apparition. Slot = 1 + x + largeur × y (fenêtre de table : 1..9, ligne par ligne).
// `null` si la recette n'est pas en forme ou ne tient pas dans la grille.
function shapedPlacement(recipe, width = 3) {
  const shape = recipe && recipe.inShape;
  if (!Array.isArray(shape) || !shape.length || shape.length > width) return null;
  const groups = [];
  const byKey = new Map();
  for (let y = 0; y < shape.length; y++) {
    const row = shape[y] || [];
    if (row.length > width) return null;
    for (let x = 0; x < row.length; x++) {
      const ing = row[x];
      if (!ing || ing.id == null || ing.id === -1) continue;
      const key = ing.id + ':' + (ing.metadata == null ? '*' : ing.metadata);
      let g = byKey.get(key);
      if (!g) { g = { id: ing.id, metadata: ing.metadata == null ? null : ing.metadata, slots: [] }; byKey.set(key, g); groups.push(g); }
      g.slots.push(1 + x + width * y);
    }
  }
  return groups.length ? groups : null;
}

// PUR : la recette doit-elle passer par le chemin manuel d'office ? Une ligne où deux ingrédients
// différents alternent (A, B, A) — le motif qui déclenche l'échange de curseur dans mineflayer.
function hasAlternatingRow(recipe) {
  const shape = recipe && recipe.inShape;
  if (!Array.isArray(shape)) return false;
  for (const row of shape) {
    const ids = (row || []).map((i) => (i && i.id != null ? i.id : -1)).filter((id) => id !== -1);
    const seen = new Set();
    let prev = null;
    for (const id of ids) {
      if (id !== prev && seen.has(id)) return true;
      seen.add(id); prev = id;
    }
  }
  return false;
}

function _withTimeout(p, ms, label) {
  let t;
  const guard = new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timeout:' + label)), ms); });
  Promise.resolve(p).catch(() => {});        // une promesse abandonnée ne doit pas lever plus tard
  return Promise.race([p, guard]).finally(() => clearTimeout(t));
}

function _matches(item, id, metadata) {
  return item && item.type === id && (metadata == null || item.metadata === metadata);
}

function _findSource(win, id, metadata) {
  for (let s = win.inventoryStart; s < win.inventoryEnd; s++) if (_matches(win.slots[s], id, metadata)) return s;
  return null;
}

function _emptyInvSlot(win, prefer) {
  if (prefer != null && !win.slots[prefer]) return prefer;
  for (let s = win.inventoryStart; s < win.inventoryEnd; s++) if (!win.slots[s]) return s;
  return null;
}

// Repose ce qui est sur le curseur (case préférée, sinon une case vide). true si curseur vide.
async function _dropCursor(bot, win, prefer) {
  if (!win.selectedItem) return true;
  const dest = _emptyInvSlot(win, prefer);
  if (dest == null) return false;
  await _withTimeout(bot.clickWindow(dest, 0, 0), STEP_TIMEOUT_MS, 'drop_cursor');
  return !win.selectedItem;
}

// Un exemplaire, fenêtre de table déjà ouverte. Lève sur échec (message court).
async function _fillAndTake(bot, win, groups, resultId, sleep) {
  if (!(await _dropCursor(bot, win))) throw new Error('cursor_stuck');
  for (const g of groups) {
    let i = 0;
    while (i < g.slots.length) {
      const src = _findSource(win, g.id, g.metadata);
      if (src == null) throw new Error('missing ingredient (manual ' + g.id + ')');
      await _withTimeout(bot.clickWindow(src, 0, 0), STEP_TIMEOUT_MS, 'pick');
      if (!_matches(win.selectedItem, g.id, g.metadata)) throw new Error('pick_failed');
      while (i < g.slots.length && win.selectedItem) {
        await _withTimeout(bot.clickWindow(g.slots[i], 1, 0), STEP_TIMEOUT_MS, 'place');
        i++;
      }
      if (!(await _dropCursor(bot, win, src))) throw new Error('cursor_stuck');
    }
  }
  // Le serveur calcule le résultat (set_slot 0).
  for (let w = 0; !(win.slots[0] && win.slots[0].type === resultId); w += POLL_MS) {
    if (w >= RESULT_TIMEOUT_MS) throw new Error('no_result');
    await sleep(POLL_MS);
  }
  await _withTimeout(bot.clickWindow(0, 0, 1), STEP_TIMEOUT_MS, 'take');   // shift-clic → inventaire
  await sleep(150);
  await _dropCursor(bot, win);
}

// Craft d'une recette EN FORME sur une table, sans échange de curseur. Lève sur échec ; la fenêtre est
// toujours refermée (le serveur rend alors grille et curseur à l'inventaire).
async function craftShapedManual(bot, recipe, table, count = 1, opts = {}) {
  const sleep = typeof opts.sleep === 'function' ? opts.sleep : _realSleep;
  const groups = shapedPlacement(recipe, 3);
  if (!groups) throw new Error('manual_unsupported');
  if (!table) throw new Error('manual_needs_table');
  const resultId = recipe.result && recipe.result.id;
  const n = Math.max(1, Number(count) || 1);
  for (let k = 0; k < n; k++) {
    if (bot.currentWindow) { try { bot.closeWindow(bot.currentWindow); } catch (e) {} await sleep(150); }
    const win = await _withTimeout(bot.openBlock(table), STEP_TIMEOUT_MS, 'open');
    try {
      if (!win || !String(win.type || '').startsWith('minecraft:crafting')) throw new Error('not_a_crafting_table');
      await _fillAndTake(bot, win, groups, resultId, sleep);
    } finally {
      try { await _dropCursor(bot, win); } catch (e) {}
      try { bot.closeWindow(win); } catch (e) {}
    }
    await sleep(200);
  }
}

module.exports = { craftShapedManual, shapedPlacement, hasAlternatingRow, STEP_TIMEOUT_MS, RESULT_TIMEOUT_MS };
