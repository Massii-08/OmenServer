'use strict';
// FER EN GROTTE — exécution (le choix de la grappe est PUR, cf. ../caveIron.js).
//
// Marcher jusqu'à la paroi, miner chaque minerai VISIBLE (jamais à travers la roche : même garde
// `canSeeBlock` que le ramassage opportuniste), avec tick de survie et torches, borné en temps.
// Un minerai absent à l'arrivée (mémoire périmée, un coéquipier est passé) est retiré de la carte
// partagée via `ore_gone` — le même canal que le mode resource (backend `remove_ore`) — et on passe
// au suivant. Un minerai miné émet `ore_mined` pour la même raison : sinon la grappe resterait
// dans la mémoire et serait re-ciblée à vide.
//
// Toutes les actions bot sont INJECTÉES (index.js fournit le pathfinder, collectBlock, la survie) :
// ce module ne touche jamais mineflayer, il se teste avec des doublures.

const CAVE_MAX_MS = 6 * 60 * 1000;   // une grappe = 6 min au plus, trajet compris
const CAVE_MINE_MIN_MS = 3 * 60 * 1000;   // temps de minage garanti après l'arrivée (22/10)
const TORCH_EVERY_ORES = 3;          // une torche tous les 3 minerais traités (et une à l'arrivée)

/**
 * @param {object} o
 *   cave        : grappe de pickIronCave ({key,x,y,z,count,dist,ores})
 *   world       : clé de monde des events de carte
 *   travel(cave)        → bool   rejoint la grappe (borné par l'appelant)
 *   oreState(ore)       → 'ore' | 'gone' | 'unknown'  (unknown = chunk non lu)
 *   approach(ore)       → bool   se met à portée du minerai (borné)
 *   canSee(ore)         → bool   ligne de vue (garde anti-« à travers la paroi »)
 *   mineVein(ore)       → number minerais bruts gagnés (filon compris)
 *   survivalTick()      → Promise  combat/fuite/manger (best-effort)
 *   placeTorch()        → Promise  (best-effort)
 *   markWork()          → bool   pose le home work à l'entrée (best-effort)
 *   refreshClaim()      → void
 *   emit, now, maxMs
 * @returns {Promise<{ok:boolean, reason?:string, mined:number, gone:number, hidden:number, took_s:number}>}
 */
async function caveIron(o = {}, token = null) {
  const emit = typeof o.emit === 'function' ? o.emit : () => {};
  const now = typeof o.now === 'function' ? o.now : Date.now;
  const cave = o.cave;
  const stats = { mined: 0, gone: 0, hidden: 0, unreached: 0 };
  const t0 = now();
  const took = () => Math.round((now() - t0) / 1000);
  const fail = (why) => {
    emit({ type: 'cave_failed', why, x: cave && cave.x, y: cave && cave.y, z: cave && cave.z, took_s: took() });
    return Object.assign({ ok: false, reason: why, took_s: took() }, stats);
  };
  if (!cave || !Array.isArray(cave.ores) || !cave.ores.length) return fail('no_cave_target');
  let deadline = t0 + (Number.isFinite(o.maxMs) ? o.maxMs : CAVE_MAX_MS);
  const safe = async (fn, dflt) => { try { return typeof fn === 'function' ? await fn() : dflt; } catch (e) { return dflt; } };
  const cancelled = () => !!(token && token.cancelled);

  emit({ type: 'cave_target', x: cave.x, y: cave.y, z: cave.z, ores: cave.count || cave.ores.length, dist: cave.dist });
  const reached = await safe(() => o.travel(cave), false);
  if (cancelled()) return fail('cancelled');
  // `travel` peut rendre une RAISON (22/10) : 'interrupted' (TP, but pathfinder volé, bot emmené ailleurs)
  // ou 'stair_missed' (l'escalier dirigé n'a pas atteint la couche) — jamais dans le disjoncteur `unreachable`.
  if (typeof reached === 'string') return fail(reached);   // 'interrupted' | 'stair_missed'
  if (!reached) return fail(now() >= deadline ? 'timeout' : 'unreachable');
  await safe(() => o.markWork(), false);
  await safe(() => o.placeTorch(), null);
  // Un long trajet (escalier dirigé vers une grappe profonde, 22/10) ne doit pas manger le temps de
  // minage : arrivé, on garde au moins CAVE_MINE_MIN_MS pour le filon.
  deadline = Math.max(deadline, now() + CAVE_MINE_MIN_MS);

  let processed = 0;
  for (const ore of cave.ores) {
    if (cancelled()) return stats.mined > 0 ? done() : fail('cancelled');
    if (now() >= deadline) return stats.mined > 0 ? done() : fail('timeout');
    await safe(() => o.refreshClaim(), null);
    let st = await safe(() => o.oreState(ore), 'unknown');
    if (st === 'gone') { goneOre(ore); continue; }
    const near = await safe(() => o.approach(ore), false);
    if (cancelled()) continue;
    if (!near) { stats.unreached++; continue; }
    st = await safe(() => o.oreState(ore), 'unknown');
    if (st === 'gone') { goneOre(ore); continue; }
    if (st !== 'ore') { stats.unreached++; continue; }
    if (!(await safe(() => o.canSee(ore), false))) { stats.hidden++; continue; }
    const n = Number(await safe(() => o.mineVein(ore), 0)) || 0;
    if (n > 0) {
      stats.mined += n;
      emit({ type: 'ore_mined', world: o.world, material: ore.material, x: ore.x, y: ore.y, z: ore.z });
    }
    processed++;
    await safe(() => o.survivalTick(), null);
    if (processed % TORCH_EVERY_ORES === 0) await safe(() => o.placeTorch(), null);
  }
  if (stats.mined > 0) return done();
  return fail(stats.gone === cave.ores.length ? 'all_gone' : (stats.hidden > 0 ? 'hidden' : 'nothing_mined'));

  function goneOre(ore) {
    stats.gone++;
    emit({ type: 'ore_gone', world: o.world, x: ore.x, y: ore.y, z: ore.z });
  }
  function done() {
    emit({ type: 'cave_mined', ores: stats.mined, took_s: took(), gone: stats.gone, hidden: stats.hidden });
    return Object.assign({ ok: true, took_s: took() }, stats);
  }
}

module.exports = { caveIron, CAVE_MAX_MS, CAVE_MINE_MIN_MS, TORCH_EVERY_ORES };
