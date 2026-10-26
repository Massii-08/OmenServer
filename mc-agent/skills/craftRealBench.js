'use strict';
// BANC « VRAI MINEFLAYER » pour les crafts (26/10) : les plugins `inventory` et `craft` de mineflayer
// 4.37 tels quels (recipesFor, craft, clickWindow, putAway…), branchés sur un faux serveur qui tient
// son propre modèle de fenêtre (prismarine-windows) et calcule la case résultat comme vanilla.
// Pas un fichier de test : un outil pour les tests (craft.realbench.test.js).
const EventEmitter = require('events');
const { Vec3 } = require('vec3');
const registry = require('prismarine-registry')('1.21.4');
const Item = require('prismarine-item')(registry);
const windows = require('prismarine-windows')('1.21.4');
const { Recipe } = require('prismarine-recipe')(registry);

function makeBot(inv, opts = {}) {
  const bot = new EventEmitter();
  bot.registry = registry; bot.version = '1.21.4';
  bot.supportFeature = registry.supportFeature;
  bot.entity = { position: new Vec3(0, 0, 0), id: 1, yaw: 0, pitch: 0 };
  bot.game = { gameMode: 'survival' };
  bot.lookAt = async () => {}; bot.swingArm = () => {};
  const client = new EventEmitter();
  bot._client = client;
  const log = [];
  // ── serveur ──
  const sInv = windows.createWindow(0, 'minecraft:inventory', 'Inventory');
  let slot = 9;
  for (const [name, count, at] of inv) { const s = at != null ? at : slot++; sInv.updateSlot(s, new Item(registry.itemsByName[name].id, count)); }
  let sWin = null; let nextId = opts.firstWindowId || 1;
  const later = (fn) => setImmediate(fn);
  function gridResult(win, w) {
    const cells = []; for (let i = 0; i < w * w; i++) cells.push(win.slots[1 + i]);
    // recherche brute sur toutes les recettes connues des items du test
    for (const name of opts.products || []) {
      for (const r of Recipe.find(registry.itemsByName[name].id, null)) {
        if (!r.inShape) {
          const have = cells.filter(Boolean).map((c) => c.type).sort();
          const want = r.ingredients.map((i) => i.id).sort();
          if (have.length === want.length && have.every((v, i) => v === want[i])) return new Item(r.result.id, r.result.count);
          continue;
        }
        let ok = true;
        for (let y = 0; y < w && ok; y++) for (let x = 0; x < w && ok; x++) {
          const want = (r.inShape[y] && r.inShape[y][x]) ? r.inShape[y][x].id : -1;
          const have = cells[y * w + x];
          if (want === -1 ? have != null : (!have || have.type !== want)) ok = false;
        }
        if (ok) return new Item(r.result.id, r.result.count);
      }
    }
    return null;
  }
  function sendAll(win) {
    const items = win.slots.map((it) => Item.toNotch(it));
    later(() => client.emit('window_items', { windowId: win.id, stateId: 1, items, carriedItem: Item.toNotch(win.selectedItem) }));
  }
  client.write = (name, data) => {
    log.push([name, data.slot, data.mouseButton, data.mode]);
    if (name === 'block_place') {
      const id = nextId; nextId = nextId % 100 + 1;
      sWin = windows.createWindow(id, 'minecraft:crafting', 'Crafting');
      for (let i = 9; i < 45; i++) if (sInv.slots[i]) sWin.updateSlot(i + 1, new Item(sInv.slots[i].type, sInv.slots[i].count));
      later(() => { client.emit('open_window', { windowId: id, inventoryType: 'minecraft:crafting', windowTitle: 'Crafting' }); sendAll(sWin); });
    } else if (name === 'window_click') {
      const win = data.windowId === 0 ? sInv : sWin;
      const w = data.windowId === 0 ? 2 : 3;
      const click = { slot: data.slot, mouseButton: data.mouseButton, mode: data.mode, windowId: data.windowId, item: data.slot === -999 ? null : win.slots[data.slot] };
      if (data.slot === 0) {
        const res = gridResult(win, w);
        if (res && data.mode === 1) {
          // shift-clic vanilla : le résultat file dans l'inventaire (pas sur le curseur)
          const e = win.firstEmptySlotRange(win.inventoryStart, win.inventoryEnd);
          if (e != null) {
            win.updateSlot(e, res); win.updateSlot(0, null);
            for (let i = 1; i <= w * w; i++) { const g = win.slots[i]; if (g) { g.count--; win.updateSlot(i, g.count > 0 ? g : null); } }
          }
        } else if (res && !win.selectedItem) {
          win.selectedItem = res; win.updateSlot(0, null);
          for (let i = 1; i <= w * w; i++) { const g = win.slots[i]; if (g) { g.count--; win.updateSlot(i, g.count > 0 ? g : null); } }
        }
      } else win.acceptClick(click);
      if (data.slot >= 1 && data.slot <= w * w || data.slot === 0) {
        const r = gridResult(win, w);
        later(() => client.emit('set_slot', { windowId: data.windowId, stateId: 1, slot: 0, item: Item.toNotch(r) }));
      }
    } else if (name === 'close_window') {
      if (sWin && data.windowId === sWin.id) {
        for (let i = 10; i < 46; i++) sInv.updateSlot(i - 1, sWin.slots[i] ? new Item(sWin.slots[i].type, sWin.slots[i].count) : null);
        for (let i = 1; i <= 9; i++) if (sWin.slots[i]) { const e = sInv.firstEmptySlotRange(9, 45); sInv.updateSlot(e, new Item(sWin.slots[i].type, sWin.slots[i].count)); }
        sWin = null;
        sendAll(sInv);
      }
    }
  };
  require('mineflayer/lib/plugins/inventory')(bot, { hideErrors: true });
  require('mineflayer/lib/plugins/craft')(bot);
  bot.quickBarSlot = 0;
  // inventaire client = serveur au départ
  for (let i = 0; i < 46; i++) bot.inventory.updateSlot(i, sInv.slots[i] ? new Item(sInv.slots[i].type, sInv.slots[i].count) : null);
  bot._srv = { sInv, log };
  return bot;
}

async function run(label, inv, product, count = 1, opts = {}) {
  const bot = makeBot(inv, { products: [product], ...opts });
  const id = registry.itemsByName[product].id;
  const table = { position: new Vec3(1, 0, 0) };
  const recipes = bot.recipesFor(id, null, 1, table);
  let res;
  try { await bot.craft(recipes[0], count, table); res = 'OK'; } catch (e) { res = 'ERR ' + e.message; }
  await new Promise((r) => setTimeout(r, 20));
  const out = {};
  for (const it of bot.inventory.items()) out[it.name] = (out[it.name] || 0) + it.count;
  console.log(label, '| recettes', recipes.length, 'r0', recipes[0] && recipes[0].delta.map((d) => registry.items[d.id].name + d.count).join(','), '|', res, '|', JSON.stringify(out));
  return bot;
}

module.exports = { makeBot };
