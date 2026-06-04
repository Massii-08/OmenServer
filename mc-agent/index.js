'use strict';
// Point d'entrée de l'agent Minecraft. Lancé par le backend Python en subprocess.
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals: pfGoals } = require('mineflayer-pathfinder');
const { plugin: pvp } = require('mineflayer-pvp');
const { plugin: collectBlock } = require('mineflayer-collectblock');
const { createLLMClient } = require('./llm');
const path = require('path');
const { emit, onCommand } = require('./io');
const { snapshot } = require('./state');
const { think, RateLimiter } = require('./brain');
const { humanizeReply } = require('./humanize');
const { loadProfile } = require('./profiles');
const { say } = require('./skills/say');
const { follow } = require('./skills/follow');
const { goto } = require('./skills/goto');
const { mineBlock, collectWood } = require('./skills/mineBlock');
const { attackNearest } = require('./skills/attackNearest');
const { fleeFrom } = require('./skills/fleeFrom');
const { installReflexes } = require('./reflexes');
const { decideReaction } = require('./triggers');
const { loadCommands, isAllowed, buildCommandDocs } = require('./commands');
const { loadPolicy, isTrusted, parseTpRequest, parseTradeRequest, gateDecision, buildTrustDocs } = require('./trust');
const { parseOrder } = require('./orders');
const { createTaskController } = require('./tasks');
const { createMemory } = require('./memory');
const { bestWeapon, bestToolFor } = require('./tools');
const { gather, findExposedOre } = require('./skills/gather');
const { mineDown } = require('./skills/mineDown');
const { guard } = require('./skills/guard');
const { giveItem, giveAll } = require('./skills/give');
const { craftItem } = require('./skills/craft');
const { deposit } = require('./skills/deposit');
const { equipItem, eat } = require('./skills/equip');
const { loiter } = require('./skills/loiter');
const fs = require('fs');
const { runPlanner } = require('./planner');
const { chainFor, buildCtxInv, firstUnmet, cookedCount } = require('./goals');
const { huntPassive } = require('./skills/hunt');
const { nearestPassive, survivalTick } = require('./survival');
const { loadWorld, saveWorld, setObjective, clearObjective } = require('./worldModel');
const { _nearestTable } = require('./skills/craft'); // craftItem déjà importé plus haut
const { placeBlockNear } = require('./skills/placeBlockNear');
const { smelt } = require('./skills/smelt');
const { descendDiagonal } = require('./skills/descendDiagonal');
const { branchMine } = require('./skills/branchMine');
const { classifyAuthPrompt, genPassword } = require('./auth');
const { loadMemory, worldKey } = require('./worldMemory');
const { runMapper } = require('./mapper');
const { isInWater, escapeWater, findLandTarget } = require('./unstuck');
const { isNight, shelterUntilDawn } = require('./skills/shelter');
const { depositFiltered } = require('./skills/deposit');
const { nextAction, marathonCounts, miningYFor, RESERVES, cookedFood, woodUnits } = require('./marathon');
const { scaffoldCount } = require('./skills/branchMine');

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { o[argv[i].slice(2)] = argv[i + 1]; i++; }
  }
  return o;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const args = parseArgs(process.argv.slice(2));
// Provider LLM enfichable : MC_AGENT_LLM=gemini (gratuit) sinon Anthropic (défaut). Cf. ./llm.js
const provider = (process.env.MC_AGENT_LLM || 'anthropic').toLowerCase();
const DEFAULT_MODELS = { gemini: 'gemini-2.0-flash', groq: 'llama-3.3-70b-versatile', anthropic: 'claude-haiku-4-5-20251001' };
const model = args.model || DEFAULT_MODELS[provider] || DEFAULT_MODELS.anthropic;
// maxCalls par défaut 15/min : reste sous le quota/min du free tier Gemini (anti-429).
const limiter = new RateLimiter(Number(args.maxCalls || 15), 60000);
const client = createLLMClient(provider); // lit la clé du provider depuis l'environnement
// Politique de réponse en chat public : 'mention' (défaut) | 'never' | 'always'. Privé (/msg) = toujours.
const PUBLIC_MODE = (process.env.MC_AGENT_PUBLIC_MODE || 'mention').toLowerCase();

let profile = null;
try { profile = loadProfile(args.profile || 'intermediaire'); }
catch (e) { emit({ type: 'error', message: 'profil invalide: ' + e.message }); }

// Commandes serveur autorisées (fichier JSON écrit par le backend, passé via --commands).
const whitelist = loadCommands(args.commands);
const commandDocs = buildCommandDocs(whitelist); // bloc injecté dans le system prompt LLM

// Politique de confiance : gens autorisés à donner des ordres + auto-accept TP/trade.
const policy = loadPolicy(args.policy);
const trustDocs = buildTrustDocs(policy.trusted);

// Langue parlée par le LLM (champ reply) : fr|en|it. Défaut fr.
const lang = String(args.lang || 'fr').toLowerCase();
const taskCtl = createTaskController();
const memory = createMemory();

// --- Planner autonome (Phase 3) : le but autonome = tâche par défaut de taskCtl ---
const worldFile = args.world || path.join(__dirname, '..', 'data', `mc_agent_world_${args.user || 'TrainBot'}.json`);
const world = loadWorld(worldFile);
let taskToken = { cancelled: true };
let deathTimes = [];
let bootDone = false; // réflexes/mouvements/auth = une seule fois par connexion (pas à chaque respawn)

// --- Mémoire de monde (1a/1b) : bootstrap du groupe (--world-memory) + clé de monde (--world-label).
// Posés sur le bot au spawn : gather y émet material_found ; explore y lit le biais dirigé ;
// le mapper y lit les cellules déjà mappées.
const worldMemoryBootstrap = loadMemory(args['world-memory']);
// Secteur multi-cartographes (1c) : assigné au lancement (--sector-index/--sector-count) puis
// RE-BALANCÉ live par le manager via stdin {type:'sector',index,count} quand N change.
let mapperSector = (args['sector-index'] !== undefined && args['sector-count'] !== undefined)
  ? { index: Number(args['sector-index']), count: Number(args['sector-count']) } : null;

// Store secrets local (mot de passe AuthMe). data/ gitignored, perms 600. JAMAIS dans emit/logs.
const secretsFile = args.secrets || path.join(__dirname, '..', 'data', `mc_agent_secret_${args.user || 'TrainBot'}.json`);
function readPw() {
  try { return JSON.parse(fs.readFileSync(secretsFile, 'utf8')).authmePassword || null; }
  catch (e) { return args.authpw || null; }
}
function writePw(pw) {
  try {
    fs.mkdirSync(path.dirname(secretsFile), { recursive: true });
    fs.writeFileSync(secretsFile, JSON.stringify({ authmePassword: pw }), { mode: 0o600 });
  } catch (e) { emit({ type: 'error', message: 'secrets write failed' }); }
}

function ctxExtra() {
  const pos = bot && bot.entity && bot.entity.position;
  return { hasTable: !!_nearestTable(bot), y: pos ? pos.y : undefined };
}

// Table de craft PORTABLE : le bot garde 1 crafting_table en poche et la pose/reprend à la demande
// pour chaque craft 3×3 (anti-stranding — la table vient au bot, où qu'il soit, surface OU sous-sol).
// Remplace l'ancien ensureNearTable (qui exigeait de REVENIR à une table fixe → échouait après
// le creusage du cobble, cf. revert table-on-spot). placeBlockNear gère désormais le sous-sol.
// #3 retours live : après placeBlock, le bloc n'existe pas INSTANTANÉMENT côté client (aller-retour
// serveur) → on poll jusqu'à le voir avant de l'utiliser (sinon openContainer/craft sur du vide).
async function waitForBlock(pos, blockName, timeoutMs = 2000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const b = pos ? bot.blockAt(pos) : null;
    if (b && b.name === blockName) return true;
    await sleep(120);
  }
  return false;
}

async function reclaimBlock(pos, blockName = 'crafting_table') {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      let b = pos ? bot.blockAt(pos) : null;
      if (!b || b.name !== blockName) {
        const def = bot.registry.blocksByName[blockName];
        b = def ? bot.findBlock({ matching: [def.id], maxDistance: 4 }) : null;
      }
      if (!b) return;                              // plus de bloc posé → déjà repris
      // ⚠️ ÉQUIPER LE BON OUTIL (vécu Surv5 : un FOUR cassé sans pioche en main NE DROP PAS →
      // four perdu en boucle). collectBlock n'équipe rien (mineflayer-tool non chargé).
      const tool = bestToolFor(bot, b);
      if (tool) { try { await bot.equip(tool, 'hand'); } catch (e) {} }
      await bot.collectBlock.collect(b);
      return;                                      // repris
    } catch (e) { /* retry une fois */ }
  }
}

// Garantit une table à portée le temps d'exécuter fn (un craft), puis reprend la table si on l'a posée.
// ⚠️ findBlock(6) > portée d'interaction (~4.5) : une table « proche » peut être INATTEIGNABLE (jungle :
// posée sous la canopée pendant que le bot est dans l'arbre) → on s'en APPROCHE d'abord ; si le craft
// échoue quand même, on pose une table portable en fallback (vu live MapT1 : stall wooden_pickaxe ×4).
async function withCraftingTable(fn) {
  // P13b/P14 : table perdue (mort OU reclaim raté) ET non posée à portée → se la refabriquer (2×2).
  // P14 (run#16 : no_table:unknown_item en boucle avec 66 bûches en poche !) : le self-heal exigeait
  // des PLANCHES — avec un stock 100% bûches il ne se déclenchait jamais → bûche→planches d'abord.
  if (!_nearestTable(bot) && !bot.inventory.items().some((i) => i.name === 'crafting_table')) {
    if (!bot.inventory.items().some((i) => i.name.endsWith('_planks'))) {
      const log = bot.inventory.items().find((i) => i.name.endsWith('_log'));
      if (log) { try { await craftItem(bot, { name: log.name.replace('_log', '_planks'), count: 1 }); } catch (e) {} }
    }
    if (bot.inventory.items().some((i) => i.name.endsWith('_planks'))) {
      try { await craftItem(bot, { name: 'crafting_table', count: 1 }); } catch (e) {}
    }
  }
  const t = _nearestTable(bot);
  if (t) {
    try {
      if (bot.entity.position.distanceTo(t.position) > 3) {
        await withTimeout(
          bot.pathfinder.goto(new pfGoals.GoalNear(t.position.x, t.position.y, t.position.z, 2)),
          30000, () => { try { stopMotion(); } catch (e) {} }
        );
      }
    } catch (e) { /* pas de chemin → on tentera la table portable */ }
    const r0 = await fn();
    if (r0.ok) return r0;                          // table existante atteinte → craft passé
  }
  let place = await placeBlockNear(bot, 'crafting_table');
  if (!place.ok) {
    // sol encombré (feuillage jungle, pente) → se déplacer vers un sol dégagé proche et re-tenter
    // UNE fois (vu live MapT4 : stall wooden_pickaxe avec table+planks+sticks en poche, pose impossible).
    const spot = findLandTarget(bot, 24);
    if (spot) {
      try {
        await withTimeout(bot.pathfinder.goto(new pfGoals.GoalNear(spot.x, spot.y + 1, spot.z, 1)),
          30000, () => { try { stopMotion(); } catch (e) {} });
      } catch (e) {}
      place = await placeBlockNear(bot, 'crafting_table');
    }
    if (!place.ok) return { ok: false, reason: 'no_table:' + (place.reason || '?') }; // sous-raison (diagnostic live)
  }
  await waitForBlock(place.pos, 'crafting_table'); // #3 : ne pas ouvrir la table avant qu'elle existe
  await sleep(300);                                // settle pose→ouverture (serveur + humanisation)
  const r = await fn();
  await sleep(250);                                // craft 100% terminé AVANT de casser la table
  await reclaimBlock(place.pos);                   // garder la table PORTABLE (1 seule)
  return r;
}

// Craft "intelligent" : tente direct (2×2, ou table déjà à portée) ; si pas de recette / craft échoué
// faute de table (craft 3×3), pose une table portable, re-tente, puis reprend la table.
async function craftSmart(args) {
  const r = await craftItem(bot, args);
  if (r.ok) return r;
  if (r.reason === 'no_recipe' || r.reason === 'craft_failed') return withCraftingTable(() => craftItem(bot, args));
  return r;
}

// Combustibles acceptés pour le smelt : charbon + TOUTES planches/bûches (PAS les bâtons, réservés
// aux pioches). Le bot a des planches en rab après les crafts → le smelt les brûle.
function fuelNames() {
  const names = ['coal', 'charcoal'];
  for (const n of Object.keys((bot.registry && bot.registry.itemsByName) || {})) {
    if (n.endsWith('_planks') || n.endsWith('_log')) names.push(n);
  }
  return names;
}

// Four PORTABLE (même esprit que la table) : pose un four à côté du bot si aucun à portée, fond, puis
// le reprend → le bot garde 1 four en poche et fond où qu'il soit (surface OU fond du tunnel à fer).
// `fuelOverride` : liste de combustibles imposée (ex. charbon de bois : EXCLURE les bûches, sinon
// le four brûle l'input qu'on veut fondre).
async function smeltWithFurnace(input, output, count, fuelOverride) {
  const fdef = bot.registry.blocksByName.furnace;
  let near = fdef ? bot.findBlock({ matching: [fdef.id], maxDistance: 4 }) : null;
  // Four PERDU (reclaim raté lors d'une fonte précédente — vécu live Surv1) : avant d'échouer ou
  // de re-crafter, on va RÉCUPÉRER un four posé à ≤24 blocs (le nôtre, abandonné).
  if (!near && !bot.inventory.items().some((i) => i.name === 'furnace')) {
    const lost = fdef ? bot.findBlock({ matching: [fdef.id], maxDistance: 24 }) : null;
    if (lost) {
      try {
        await withTimeout(bot.pathfinder.goto(new pfGoals.GoalNear(lost.position.x, lost.position.y, lost.position.z, 2)),
          30000, () => { try { stopMotion(); } catch (e) {} });
      } catch (e) {}
      near = bot.findBlock({ matching: [fdef.id], maxDistance: 4 });
    }
  }
  // P13 (run#12 : torches → no_furnace en boucle) : four perdu à une MORT et jamais re-crafté hors
  // kit → s'auto-réparer ici (8 cobble → craft), comme la table portable. Couvre smelt/huntCook/torches.
  if (!near && !bot.inventory.items().some((i) => i.name === 'furnace')) {
    if (scaffoldCount(bot) < 8) {
      const sdef = bot.registry.blocksByName.stone;
      if (sdef && !bot.findBlock({ matching: [sdef.id], maxDistance: 32 })) {
        await withTimeout(mineDown(bot, { depth: 4 }, taskToken), 60000, () => { try { stopMotion(); } catch (e) {} });
      }
      await withTimeout(gather(bot, { name: ['stone', 'deepslate'], count: 8 }, taskToken),
        120000, () => { try { stopMotion(); } catch (e) {} });
      if (taskToken.cancelled) return { ok: false, reason: 'cancelled' };
    }
    const c = await craftSmart({ name: 'furnace', count: 1 });
    if (!c.ok) return { ok: false, reason: 'no_furnace_craft:' + (c.reason || '?') };
  }
  let pos = null;
  if (!near) {
    const place = await placeBlockNear(bot, 'furnace');
    if (!place.ok) return { ok: false, reason: 'no_furnace' };
    pos = place.pos;
    await waitForBlock(pos, 'furnace');            // #3 : même règle que la table (pose async serveur)
    await sleep(300);
  }
  const r = await smelt(bot, { input, output, count, fuel: fuelOverride || fuelNames() }, taskToken);
  if (pos) {
    await sleep(250);
    await reclaimBlock(pos, 'furnace');            // garder le four PORTABLE
    if (!bot.inventory.items().some((i) => i.name === 'furnace')) {
      emit({ type: 'reclaim_failed', block: 'furnace' }); // pas revenu en poche (récupérable ≤24 plus tard)
    }
  }
  return r;
}

// Garde-fou anti-freeze : pathfinder/collectBlock peuvent rester bloqués indéfiniment sur une cible
// inatteignable (terrain) → on borne CHAQUE skill dans le temps. Au timeout : on coupe le mouvement
// et on rend {ok:false,reason:'timeout'} → le planner re-dérive (au lieu de geler pour toujours).
const SKILL_TIMEOUT_MS = Number(args.skillTimeout || 90000);
// Skills DIAMANT longs par nature : descente y=64→-54 (118 blocs × ~4s avec pathfinder = trop juste
// à 6 min) + branch mining 48 + 2×8 branches (~64 blocs avec pathfinder entre chaque dig). 15 min/chacun.
// huntCook = 3 vagues de chasse + cuisson au four (vécu Surv5 : tué à 90s en pleine chasse) ;
// smeltCharcoal = gather bûches éventuel + fonte (180s de smelt max).
const SKILL_TIMEOUTS = { descendDiagonal: 900000, branchMine: 900000, huntCook: 480000, smeltCharcoal: 300000, gatherLog: 240000, gatherIron: 900000 };  // gatherLog 4 min : explore vers une forêt lointaine (Surv11 : ×12 timeouts à 90s) ; gatherIron 15 min : descente Y16 + branch mine (Marathon run#2 : 90s ridicules → boucle infinie)
function timeoutFor(skill) { return SKILL_TIMEOUTS[skill] || SKILL_TIMEOUT_MS; }
function withTimeout(promise, ms, onTimeout) {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => {
      if (done) return; done = true;
      try { onTimeout && onTimeout(); } catch (e) {}
      resolve({ ok: false, reason: 'timeout' });
    }, ms);
    Promise.resolve(promise)
      .then((r) => { if (!done) { done = true; clearTimeout(t); resolve(r); } })
      .catch(() => { if (!done) { done = true; clearTimeout(t); resolve({ ok: false, reason: 'error' }); } });
  });
}

// --- Kit de survie : charbon de bois + chasse/cuisson (phase « bot parfait ») ---------------------

const RAW2COOKED = {
  beef: 'cooked_beef', porkchop: 'cooked_porkchop', chicken: 'cooked_chicken',
  mutton: 'cooked_mutton', rabbit: 'cooked_rabbit', cod: 'cooked_cod', salmon: 'cooked_salmon',
};
function _invTotal(filter) {
  return bot.inventory.items().filter(filter).reduce((s, i) => s + i.count, 0);
}

// Charbon de bois : s'assure d'avoir `count` bûches (gather+explore au besoin) puis les fond.
// ⚠️ fuel = planches/charbon UNIQUEMENT (jamais de bûches — c'est l'input). Si aucune planche :
// convertit 1 bûche en planches d'abord.
async function smeltCharcoalGoal(count) {
  // 0) du COAL_ORE visible ? le miner direct (commun, plus simple que le charbon de bois — Surv8 :
  //    20 échecs no_fuel en plaines sans arbres alors que la pierre regorge de charbon).
  if (findExposedOre(bot, ['coal_ore', 'deepslate_coal_ore'], 32)) { // anti-xray (Massii A) : exposé seulement
    const g = await gather(bot, { name: ['coal_ore', 'deepslate_coal_ore'], count, explore: false }, taskToken);
    if (taskToken.cancelled) return { ok: false, reason: 'cancelled' };
    if (g.ok && _invTotal((i) => i.name === 'coal') >= count) return { ok: true };
  }
  // 1) charbon de bois : il faut count bûches À FONDRE + de quoi alimenter le four (planches)
  const logNames = Object.keys(bot.registry.blocksByName).filter((n) => n.endsWith('_log'));
  const logsHave = () => _invTotal((i) => i.name.endsWith('_log'));
  const planksHave = () => _invTotal((i) => i.name.endsWith('_planks'));
  emit({ type: 'charcoal_state', logs: logsHave(), planks: planksHave() }); // télémétrie (no_fuel ×20 inexpliqués)
  if (logsHave() < count + 1) { // +1 bûche → planches de combustible
    const g = await gather(bot, { name: logNames, count: count + 1 - logsHave(), explore: true }, taskToken);
    if (taskToken.cancelled) return { ok: false, reason: 'cancelled' };
    if (!g.ok && logsHave() < count) return { ok: false, reason: 'no_logs' };
  }
  if (planksHave() < 2) {
    const log = bot.inventory.items().find((i) => i.name.endsWith('_log'));
    if (log) {
      const c = await craftItem(bot, { name: log.name.replace('_log', '_planks'), count: 1 });
      if (!c.ok) emit({ type: 'charcoal_state', planks_craft_failed: c.reason });
    }
  }
  if (planksHave() < 1 && _invTotal((i) => i.name === 'coal') < 1) {
    return { ok: false, reason: 'no_fuel_planks' };             // diagnostic PRÉCIS (≠ no_fuel du smelt)
  }
  // ⚠️ PAS de 'charcoal' dans le fuel ici : on ne brûle pas le produit qu'on fabrique (vécu Surv1)
  const fuel = ['coal'].concat(
    Object.keys(bot.registry.itemsByName).filter((n) => n.endsWith('_planks')));
  // fond l'essence la plus abondante (l'input du smelt est un nom d'item exact)
  const byName = {};
  for (const i of bot.inventory.items()) if (i.name.endsWith('_log')) byName[i.name] = (byName[i.name] || 0) + i.count;
  const top = Object.entries(byName).sort((a, b) => b[1] - a[1])[0];
  if (!top) return { ok: false, reason: 'no_logs' };
  return smeltWithFurnace(top[0], 'charcoal', Math.min(count, top[1]), fuel);
}

// Stock de nourriture CUITE : chasse des passifs proches (jusqu'à 3 vagues) puis cuit tout le cru.
// Pas de proie → on cuit ce qu'on a ; rien du tout → échec propre (le planner re-tentera ailleurs
// via la re-tentative périodique du kit — le bot aura bougé).
async function huntCookGoal(target) {
  const cooked = () => cookedCount(buildCtxInv(bot));
  const raw = () => _invTotal((i) => RAW2COOKED[i.name]);
  for (let wave = 0; wave < 3 && cooked() + raw() < target; wave++) {
    const r = await withTimeout(
      huntPassive(bot, { count: target - cooked() - raw(), maxDistance: 32 }, taskToken),
      120000, () => { try { stopMotion(); } catch (e) {} });
    if (taskToken.cancelled) return { ok: false, reason: 'cancelled' };
    if (!r || !r.ok) break;
  }
  let cookedAny = false;
  for (const [rawName, cookedName] of Object.entries(RAW2COOKED)) {
    const n = _invTotal((i) => i.name === rawName);
    if (!n) continue;
    const s = await smeltWithFurnace(rawName, cookedName, n);
    if (s.ok) cookedAny = true;
    if (taskToken.cancelled) return { ok: false, reason: 'cancelled' };
  }
  if (cooked() >= target || cookedAny) return { ok: true, got: cooked() };
  return { ok: false, reason: 'no_prey' };
}

// Dispatch d'un but de la chaîne vers le skill réel (0 token).
async function runGoalSkill(goal) {
  // #1 retours live : coincé dans l'eau → s'en sortir AVANT de tenter le skill (sinon le pathfinder
  // rame dans l'angle jusqu'au timeout, le planner re-dérive, et ça recommence).
  if (isInWater(bot)) await escapeWater(bot, { emit });
  if (goal.skill === 'gatherLog') {
    // arbre le plus proche de N'IMPORTE quelle essence (pas oak hardcodé) — robustesse terrain
    const logNames = Object.keys(bot.registry.blocksByName).filter((n) => n.endsWith('_log'));
    // explore:true → si aucun arbre à portée, le bot VOYAGE pour en trouver (autonomie ressources).
    return gather(bot, { name: logNames.length ? logNames : 'oak_log', count: goal.args.count, explore: true }, taskToken);
  }
  // explore:true sur les gather de la chaîne autonome (bois/pierre/minerai) → le bot va chercher
  // la ressource si elle n'est pas dans le voisinage. (Les gather opportunistes internes — branchMine
  // maxDistance:6 — appellent gather() directement SANS explore → pas de roaming en plein tunnel.)
  if (goal.skill === 'gather') {
    // PIERRE : inutile de roamer (timeouts ×3 vécus Surv6) — la couche de pierre est à 3-5 blocs
    // sous l'herbe PARTOUT → pas de pierre visible ≤32 ? on creuse 4 blocs et on mine sur place.
    if (goal.args.name === 'stone') {
      const def = bot.registry.blocksByName.stone;
      if (def && !bot.findBlock({ matching: [def.id], maxDistance: 32 })) {
        await mineDown(bot, { depth: 4 }, taskToken);
        if (taskToken.cancelled) return { ok: false, reason: 'cancelled' };
      }
    }
    return gather(bot, { ...goal.args, explore: true }, taskToken);
  }
  if (goal.skill === 'craftPlanks') {
    const log = bot.inventory.items().find((i) => i.name.endsWith('_log'));
    if (!log) return { ok: false, reason: 'not_found' };
    // ne pas sur-demander : convertir au plus le nb de bûches de cette essence (sinon bot.craft throw)
    const same = bot.inventory.items().filter((i) => i.name === log.name).reduce((s, i) => s + i.count, 0);
    return craftItem(bot, { name: log.name.replace('_log', '_planks'), count: Math.min(goal.args.count || 1, same) });
  }
  if (goal.skill === 'craft') {
    // torches : adapter le nb de lots au charbon disponible (1 charbon → 1 lot de 4 au lieu d'un
    // craft_failed ; le but torches reste unmet → la chaîne refait du charbon puis le 2e lot).
    if (goal.args.name === 'torch') {
      const coalHave = _invTotal((i) => i.name === 'coal' || i.name === 'charcoal');
      if (coalHave < 1) return { ok: false, reason: 'no_coal' };
      return craftSmart({ name: 'torch', count: Math.min(goal.args.count || 2, coalHave) });
    }
    return craftSmart(goal.args);    // pose une table portable si craft 3×3
  }
  if (goal.skill === 'gatherIron') return gatherIronGoal(goal.args.count || 3);
  if (goal.skill === 'smeltIron') return smeltWithFurnace('raw_iron', 'iron_ingot', goal.args.count || 3);
  if (goal.skill === 'smeltCharcoal') return smeltCharcoalGoal(goal.args.count || 2);
  if (goal.skill === 'huntCook') return huntCookGoal(goal.args.target || 4);
  if (goal.skill === 'descendDiagonal') return descendDiagonal(bot, goal.args || {}, taskToken);
  if (goal.skill === 'branchMine') return branchMine(bot, goal.args || {}, taskToken);
  return { ok: false, reason: 'unknown_skill' };
}

// Recherche de fer ROBUSTE (vécu Marathon run#2 : ×20 timeouts en roaming surface) :
// 1) visible ≤32 → gather direct ; 2) sinon DESCENTE Y=16 (pic du fer 1.18+) + branch mine
//    avec arrêt dès `need` raw_iron (le tunnel ramasse aussi charbon/cuivre au passage).
// ⚠️ CHAQUE phase est bornée individuellement (vécu run#3 : fer VISIBLE ≤32 mais inatteignable
// → collectBlock/A* pend SANS timeout interne → 15 min de gel sur place, retry, re-gel —
// même mécanique suspectée pour P2/OOM : l'open set A* alloue sans borne sur cible impossible).
// Réutilisée par le kit (goal gatherIron) ET l'action marathon 'iron' (pioches de secours, Massii 12:15).
async function gatherIronGoal(need) {
  {
    const ironHave = () => _invTotal((i) => i.name === 'raw_iron' || i.name === 'iron_ingot');
    const phase = (p) => emit({ type: 'gatherIron_phase', phase: p, y: Math.round(bot.entity.position.y), iron: ironHave() });
    // anti-xray (Massii A) : on ne « voit » un fer que s'il est EXPOSÉ — sinon branch-mine légit
    if (findExposedOre(bot, ['iron_ore', 'deepslate_iron_ore'], 32)) {
      phase('visible_gather');
      const g = await withTimeout(
        gather(bot, { name: ['iron_ore', 'deepslate_iron_ore'], count: need, explore: false }, taskToken),
        120000, () => { try { stopMotion(); } catch (e) {} });
      if (g.ok || ironHave() >= need) return { ok: true };
    }
    if (taskToken.cancelled) return { ok: false, reason: 'cancelled' };
    // réserve de murage avant de creuser (la lave à Y16 existe aussi)
    if (scaffoldCount(bot) < 12) {
      phase('scaffold');
      await withTimeout(gather(bot, { name: ['stone', 'deepslate'], count: 12 - scaffoldCount(bot) }, taskToken),
        120000, () => { try { stopMotion(); } catch (e) {} });
      if (taskToken.cancelled) return { ok: false, reason: 'cancelled' };
    }
    if (bot.entity.position.y > 18) {
      phase('descend');
      const d = await descendRobust(16);  // P5/P9 : escalier ⇄ mineDown alternés, borné
      if (taskToken.cancelled) return { ok: false, reason: 'cancelled' };
      if (!d.ok && bot.entity.position.y > 24) return { ok: false, reason: 'descend:' + (d.reason || 'stuck') };
    }
    phase('branch_mine');
    const bm = await branchMine(bot, {
      targetY: Math.floor(bot.entity.position.y), mainLength: 40, branchSpacing: 3, branchLength: 6,
      stopWhen: () => ironHave() >= need,
    }, taskToken);
    if (ironHave() >= need) return { ok: true };
    return { ok: false, reason: 'iron_not_found:' + ((bm && bm.reason) || 'tunnel_dry') };
  }
}

// Upgrade kit du cartographe (spec §5.1) : fer « si rapide » (minerai visible ≤32 blocs, sinon on
// n'insiste pas) → sinon fallback CUIVRE registry-gated (copper_sword n'existe qu'en 1.21.9+/moddé ;
// sur 1.21.4 ce bloc est inerte). Best-effort : chaque étape bornée, tout échec = on part à la pierre.
async function tryKitUpgrade() {
  const reg = bot.registry;
  const oreIds = (names) => names.map((n) => reg.blocksByName[n]).filter(Boolean).map((b) => b.id);
  const tryMetal = async (ores, raw, ingot, sword) => {
    if (!reg.itemsByName[sword]) return false;                       // registry-gated (cuivre)
    if (!findExposedOre(bot, ores, 32)) return false; // pas « rapide » (et jamais x-ray — Massii A)
    // four : 8 cobble + craft (si pas déjà en poche)
    if (!bot.inventory.items().some((i) => i.name === 'furnace')) {
      const c = await withTimeout(gather(bot, { name: 'stone', count: 8 }, taskToken), 120000, stopMotion);
      if (!c.ok || taskToken.cancelled) return false;
      const f = await craftSmart({ name: 'furnace', count: 1 });
      if (!f.ok) return false;
    }
    const g = await withTimeout(gather(bot, { name: ores, count: 3 }, taskToken), 180000, stopMotion);
    if (!g.ok || taskToken.cancelled) return false;
    const s = await withTimeout(smeltWithFurnace(raw, ingot, 2), 120000, stopMotion);
    if (!s.ok || taskToken.cancelled) return false;
    const c2 = await craftSmart({ name: sword, count: 1 });
    if (c2.ok) emit({ type: 'mapper_kit_upgrade', metal: ingot });
    return c2.ok;
  };
  try {
    if (await tryMetal(['iron_ore', 'deepslate_iron_ore'], 'raw_iron', 'iron_ingot', 'iron_sword')) return;
    await tryMetal(['copper_ore', 'deepslate_copper_ore'], 'raw_copper', 'copper_ingot', 'copper_sword');
  } catch (e) { /* best-effort : on cartographie à la pierre */ }
}

// SURVIE PENDANT LE KIT (vécu Surv4 : 7 morts nocturnes — le planner n'avait AUCUNE survie active,
// seuls les réflexes minimaux) : avant chaque skill, on règle les menaces comme le fait la boucle
// mapper (combat 1-2 hostiles / fuite si submergé ou PV bas / manger), avec cap anti-blocage.
async function settleSurvivalKit() {
  for (let i = 0; i < 10; i++) {
    if (taskToken.cancelled) return;
    const action = await survivalTick(bot, { fleeFrom, emit });
    if (!action) return;
    await sleep(1500);
  }
}

// Exécute un skill de but avec timeout + TÉLÉMÉTRIE d'échec : sans la raison dans les logs live,
// un stall est indiagnosticable à distance (vécu Surv2 : stone_sword ×5 sans explication).
let lastShelterT = 0; // anti re-trigger : 1 abri par nuit max

async function runSkillWithTelemetry(g) {
  await settleSurvivalKit();                                  // survie d'abord, le craft ensuite
  if (taskToken.cancelled) return { ok: false, reason: 'cancelled' };
  // NUIT + (mort récente OU PV bas) pendant le kit → ABRI jusqu'à l'aube (vécu Surv4 : 7 morts
  // nocturnes en boucle ; un trou couvert coûte 2 blocs et sauve le kit).
  const deathsRecent = deathTimes.filter((t) => Date.now() - t < 10 * 60 * 1000).length;
  if (isNight(bot) && (deathsRecent >= 1 || (bot.health != null && bot.health <= 10))
      && Date.now() - lastShelterT > 10 * 60 * 1000) {
    lastShelterT = Date.now();
    await withTimeout(shelterUntilDawn(bot, taskToken, { emit }), 13 * 60 * 1000,
      () => { try { stopMotion(); } catch (e) {} });
    if (taskToken.cancelled) return { ok: false, reason: 'cancelled' };
  }
  const r = await withTimeout(runGoalSkill(g), timeoutFor(g.skill), () => { try { stopMotion(); } catch (e) {} });
  if (!r || r.ok === false) emit({ type: 'goal_failed', name: g.name, reason: (r && r.reason) || 'unknown' });
  return r;
}

// Boucle cartographe (objectif `mapper`) : mini-kit pierre via planner → upgrade best-effort →
// cartographie CONTINUE (ne « finit » jamais — seule l'annulation/stop l'arrête).
async function startMapper() {
  const kitChain = chainFor('mapper');
  const runKit = () => runPlanner(bot, {
    chain: kitChain,
    runSkill: (g) => runSkillWithTelemetry(g),
    ctxExtra,
    onStep: (g) => emit({ type: 'goal', name: g.name }),
  }, taskToken);
  const res = await runKit();
  if (taskToken.cancelled) return;
  if (res.stalled) emit({ type: 'mapper_kit_stalled', goal: res.goal }); // on cartographie quand même (dégradé)
  else await tryKitUpgrade();
  if (taskToken.cancelled) return;
  emit({ type: 'mapper_started', world: bot._worldKey, sector: mapperSector });
  await runMapper(bot, {
    worldKey: bot._worldKey,
    memory: bot._worldMemory,
    getSector: () => mapperSector,
    emit,
    fleeFrom,
    // kit incomplet (stall terrain au départ) → re-tenté discrètement toutes les ~10 arrivées :
    // le terrain a changé (le bot a bougé), la pose de table a souvent une 2e chance ailleurs.
    onPeriodic: async () => {
      const ctx = Object.assign({ inv: buildCtxInv(bot) }, ctxExtra());
      if (firstUnmet(kitChain, ctx)) { emit({ type: 'mapper_kit_retry' }); await runKit(); }
    },
    // CHASSE OPPORTUNISTE (vécu Surv1 : le retry périodique coïncide rarement avec des proies à
    // portée → stock jamais constitué) : à chaque arrivée, si le stock cuit est bas ET qu'une proie
    // passe à ≤24 blocs → on la tue MAINTENANT (cru en poche ; la cuisson se fait au retry du kit).
    onArrive: async () => {
      const inv = buildCtxInv(bot);
      const rawHave = Object.keys(RAW2COOKED).reduce((s, n) => s + (inv[n] || 0), 0);
      const missing = 4 - cookedCount(inv) - rawHave;
      if (missing <= 0) return;
      if (!nearestPassive(bot, 24)) return;
      const r = await withTimeout(huntPassive(bot, { count: Math.min(missing, 2), maxDistance: 24 }, taskToken),
        60000, () => { try { stopMotion(); } catch (e) {} });
      if (r && r.kills) emit({ type: 'opportunistic_hunt', kills: r.kills });
    },
    // chaque jambe bornée (anti-freeze pathfinder, cf. withTimeout) ; timeout → virage + jambe suivante.
    // 45s : une jambe fait 8-64 blocs à pied — si ce n'est pas atteint en 45s, c'est inatteignable
    // (vu live MapT7B : 120s × jambes ratées en jungle dense = mapper figé de longues minutes).
    goto: (wp) => withTimeout(
      bot.pathfinder.goto(new pfGoals.GoalNear(wp.x, wp.y, wp.z, 8)),
      45000, () => { try { stopMotion(); } catch (e) {} }
    ).then((r) => { if (r && r.ok === false) throw new Error(r.reason || 'goto_failed'); }),
  }, taskToken);
}

// --- MARATHON : 64× diamant/redstone/lapis/or (inventaire + coffre de base), réserves maintenues —
// boucle nextAction (pur, ./marathon.js) → dispatch ici. Conçue pour tourner DES HEURES.

// Valuables déposés au coffre de base ; les réserves de travail restent en poche (surplus déposé).
const MARATHON_VALUABLES = ['diamond', 'redstone', 'lapis_lazuli', 'raw_gold', 'gold_ingot',
  'emerald', 'amethyst_shard'];
function marathonSurplus() {
  return {
    cobblestone: RESERVES.scaffoldKeep, cobbled_deepslate: RESERVES.scaffoldKeep,
    raw_iron: RESERVES.ironKeep, iron_ingot: RESERVES.ironKeep,
    coal: RESERVES.coalKeep, charcoal: RESERVES.coalKeep,
    // junk de minage : tout au coffre (slots inventaire = la denrée rare en profondeur)
    granite: 0, diorite: 0, andesite: 0, tuff: 0, gravel: 0, flint: 0, dirt: 0,
  };
}

// Compromis nourriture : ≥3 restocks food ratés d'affilée (monde sans animaux) + faim pleine
// → le gate READY de descente n'attend plus l'impossible (cf. nextAction.foodCompromise).
let restockFoodFails = 0;

function marathonCtx() {
  const pos = bot.entity && bot.entity.position;
  return {
    inv: buildCtxInv(bot),
    banked: world.banked || {},
    y: pos ? pos.y : undefined,
    emptySlots: bot.inventory && bot.inventory.emptySlotCount ? bot.inventory.emptySlotCount() : undefined,
    hasBase: !!world.home,
    hunger: bot.food, // P12 : la vraie faim gate le restock (le stock seul est trop strict)
    foodCompromise: restockFoodFails >= 3 && bot.food != null && bot.food >= 16,
  };
}

async function gotoPos(p, range, ms) {
  // Massii B : jamais partir en voyage en pataugeant — on sort de l'eau d'abord.
  if (isInWater(bot)) await escapeWater(bot, { emit });
  const r = await withTimeout(bot.pathfinder.goto(new pfGoals.GoalNear(p.x, p.y, p.z, range)), ms,
    () => { try { stopMotion(); } catch (e) {} });
  // arrivé (ou timeout) DANS l'eau → évasion immédiate (le voyage a pu router dans un lac)
  if (isInWater(bot)) await escapeWater(bot, { emit });
  return r;
}

// Garantit n planches en poche (bûches→planches au besoin). P16 (run#19 : base stall —
// craft chest no_recipe avec 98 unités de bois 100% BÛCHES, même classe que P14).
async function ensurePlanks(n) {
  const have = () => _invTotal((i) => i.name.endsWith('_planks'));
  for (let guard = 0; guard < 8 && have() < n; guard++) {
    const log = bot.inventory.items().find((i) => i.name.endsWith('_log'));
    if (!log) break;
    const c = await craftItem(bot, { name: log.name.replace('_log', '_planks'), count: Math.max(1, Math.ceil((n - have()) / 4)) });
    if (!c.ok) break;
  }
  return have() >= n;
}

// Pose le coffre de base à la profondeur de minage → world.home (les dépôts en dépendent).
// Massii C (option 3) : la base reçoit aussi une table de craft PERMANENTE (jamais reprise) —
// un humain laisse sa table à sa base ; le cycle portable ne sert plus que loin en minage.
async function establishBase() {
  await ensurePlanks(12); // coffre 8 + table permanente 4 (best-effort, P16)
  if (!bot.inventory.items().some((i) => i.name === 'chest')) {
    const c = await craftSmart({ name: 'chest', count: 1 });
    if (!c.ok) return { ok: false, reason: 'no_chest_item:' + (c.reason || '?') };
  }
  const place = await placeBlockNear(bot, 'chest');
  if (!place.ok) return { ok: false, reason: 'place_failed:' + (place.reason || '?') };
  await waitForBlock(place.pos, 'chest');
  world.home = { x: place.pos.x, y: place.pos.y, z: place.pos.z };
  world.chests = (world.chests || []).concat([world.home]);
  world.banked = world.banked || {};
  saveWorld(worldFile, world);
  emit({ type: 'marathon_base', x: world.home.x, y: world.home.y, z: world.home.z });
  // table permanente (best-effort) : pas de table à portée → en poser une SANS reclaim
  if (!_nearestTable(bot)) {
    if (!bot.inventory.items().some((i) => i.name === 'crafting_table') && await ensurePlanks(4)) {
      try { await craftItem(bot, { name: 'crafting_table', count: 1 }); } catch (e) {}
    }
    if (bot.inventory.items().some((i) => i.name === 'crafting_table')) {
      const t = await placeBlockNear(bot, 'crafting_table');
      if (t.ok) { await waitForBlock(t.pos, 'crafting_table'); emit({ type: 'marathon_base_table' }); }
    }
  }
  return { ok: true };
}

async function marathonDeposit() {
  if (!world.home) return { ok: false, reason: 'no_base' };
  const g = await gotoPos(world.home, 2, 8 * 60 * 1000);
  if (g && g.ok === false) emit({ type: 'marathon_goto_base_failed' }); // on tente quand même (peut être à côté)
  const r = await depositFiltered(bot, { only: MARATHON_VALUABLES, surplus: marathonSurplus() });
  if (!r.ok) {
    // coffre introuvable/cassé → re-base au prochain tour ; banked re-lu au prochain dépôt réussi
    emit({ type: 'marathon_chest_lost', reason: r.reason });
    world.home = null; saveWorld(worldFile, world);
    return r;
  }
  world.banked = r.chest;             // source de vérité = contenu du coffre RELU après dépôt
  saveWorld(worldFile, world);
  emit({ type: 'marathon_deposit', deposited: r.deposited, banked: world.banked });
  return r;
}

// Supply run SURFACE : bois + nourriture (un seul trip combiné), puis la boucle redescendra.
// P11 (run#10b : boucle restock infinie, zone de spawn vidée de ses proies) : (a) retour HONNÊTE
// (ok:false si les réserves restent basses → l'anti-stall de la boucle marathon s'enclenche) ;
// (b) ROAMING par sauts de ~48 blocs quand AUCUNE proie à portée (huntPassive ne roame pas) ;
// (c) sous-tâches conditionnelles (ne re-gather pas du bois déjà au niveau).
async function marathonRestock() {
  if (world.surface) {
    const g = await gotoPos(world.surface, 8, 10 * 60 * 1000);
    if (g && g.ok === false) emit({ type: 'marathon_surface_failed' });
  }
  const inv = () => buildCtxInv(bot);
  // Bois : viser le PLEIN chargement (~1 stack d'unités, Massii 12:15), par passes bornées —
  // chaque restock en rajoute, le gate de descente re-vérifie.
  if (woodUnits(inv()) < RESERVES.woodReady) {
    const logNames = Object.keys(bot.registry.blocksByName).filter((n) => n.endsWith('_log'));
    const missing = Math.min(32, RESERVES.woodReady - woodUnits(inv())); // passe bornée (32 bûches max)
    await withTimeout(gather(bot, { name: logNames, count: missing, explore: true }, taskToken),
      timeoutFor('gatherLog'), () => { try { stopMotion(); } catch (e) {} });
    if (taskToken.cancelled) return { ok: false, reason: 'cancelled' };
  }
  for (let hop = 0; hop < 3 && cookedFood(inv()) < RESERVES.foodReady; hop++) {
    if (!nearestPassive(bot, 32)) {
      // aucune proie en vue : saute ~48 blocs dans une direction aléatoire et re-scanne
      const a = Math.random() * 2 * Math.PI;
      const p = bot.entity.position;
      emit({ type: 'restock_roam', hop, x: Math.round(p.x + Math.cos(a) * 48), z: Math.round(p.z + Math.sin(a) * 48) });
      await gotoPos({ x: p.x + Math.cos(a) * 48, y: p.y, z: p.z + Math.sin(a) * 48 }, 8, 120000);
      if (taskToken.cancelled) return { ok: false, reason: 'cancelled' };
      if (!nearestPassive(bot, 32)) continue;
    }
    await withTimeout(huntCookGoal(RESERVES.foodReady), timeoutFor('huntCook'),
      () => { try { stopMotion(); } catch (e) {} });
    if (taskToken.cancelled) return { ok: false, reason: 'cancelled' };
  }
  // Retour honnête vs les seuils READY (gate de descente) — l'anti-stall + foodCompromise
  // s'appuient dessus. Un restock partiel reste un échec tant que le plein n'est pas fait.
  const okFood = cookedFood(inv()) >= RESERVES.foodReady;
  const okWood = woodUnits(inv()) >= RESERVES.woodReady;
  if (okFood && okWood) {
    // camp de surface = là où le restock a RÉUSSI (le terrain s'use, les ressources se déplacent)
    const p = bot.entity.position;
    if (p && p.y >= 55) { world.surface = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }; saveWorld(worldFile, world); }
    return { ok: true };
  }
  return { ok: false, reason: 'restock_incomplete:' + (okFood ? '' : 'food') + (okWood ? '' : '+wood') };
}

// Torches sur place : bâtons (planches→sticks) + charbon (miné ou charbon de bois) → craft.
// Retour basé sur le PROGRÈS (run#17 : convergence lente 0→8 mais chaque action finissait sur un
// échec spurieux de dernier lot → faux stall) : si le stock de torches a augmenté, c'est un succès.
async function marathonTorches() {
  const count = (n) => _invTotal((i) => i.name === n);
  const before = count('torch');
  const coalNeed = Math.ceil((RESERVES.torchReady - before) / 4);
  if (count('stick') < Math.min(8, coalNeed)) {
    if (!bot.inventory.items().some((i) => i.name.endsWith('_planks'))) {
      const log = bot.inventory.items().find((i) => i.name.endsWith('_log'));
      if (log) await craftItem(bot, { name: log.name.replace('_log', '_planks'), count: 1 });
    }
    await craftSmart({ name: 'stick', count: 2 }); // 2 lots = 8 bâtons
  }
  if (count('coal') + count('charcoal') < coalNeed) {
    const sc = await smeltCharcoalGoal(Math.min(8, coalNeed)); // gros lots (cible ~48 torches)
    if (!sc.ok && count('coal') + count('charcoal') < 1) return count('torch') > before ? { ok: true } : sc;
  }
  const coalHave = count('coal') + count('charcoal');
  if (coalHave < 1) return count('torch') > before ? { ok: true } : { ok: false, reason: 'no_coal' };
  const r = await craftSmart({ name: 'torch', count: Math.min(16, coalHave) });
  if (count('torch') > before) return { ok: true, made: count('torch') - before };
  return r;
}

// Pioche fer de RECHANGE (≥2 en poche) dès que le fer du tunnel le permet.
async function marathonSparePickaxe() {
  if (_invTotal((i) => i.name === 'iron_ingot') < 3) {
    const s = await smeltWithFurnace('raw_iron', 'iron_ingot', 3);
    if (!s.ok) return s;
  }
  if (_invTotal((i) => i.name === 'stick') < 2) await craftSmart({ name: 'stick', count: 1 });
  return craftSmart({ name: 'iron_pickaxe', count: 1 });
}

// Descente ROBUSTE (P9, run#9 : ×5 stalls action=descend) : l'escalier diagonal échoue dans les
// puits/reliefs piégeux (no_progress) ; mineDown casse le cas puits mais s'arrête sur danger.
// On ALTERNE les deux (+ petit déplacement entre rounds pour changer le terrain), borné.
async function descendRobust(targetY) {
  const atTarget = () => bot.entity.position.y <= targetY + 2;
  for (let round = 0; round < 4; round++) {
    if (taskToken.cancelled) return { ok: false, reason: 'cancelled' };
    if (atTarget()) return { ok: true };
    const d = await withTimeout(descendDiagonal(bot, { targetY }, taskToken), 480000,
      () => { try { stopMotion(); } catch (e) {} });
    if (taskToken.cancelled) return { ok: false, reason: 'cancelled' };
    if (atTarget()) return { ok: true };
    const depth = Math.max(1, Math.floor(bot.entity.position.y) - targetY);
    const m = await withTimeout(mineDown(bot, { depth }, taskToken), 300000,
      () => { try { stopMotion(); } catch (e) {} });
    emit({ type: 'descend_round', round, y: Math.round(bot.entity.position.y),
      stair: (d && d.reason) || 'ok', stairDetail: (d && d.detail) || undefined,
      mine: (m && m.reason) || 'ok', mined: (m && m.dug) || 0 });
    if (taskToken.cancelled) return { ok: false, reason: 'cancelled' };
    if (atTarget()) return { ok: true };
    // ni l'un ni l'autre n'a abouti : bouger un peu change le contexte terrain pour le round suivant
    const spot = findLandTarget(bot, 16);
    if (spot) await gotoPos({ x: spot.x, y: spot.y + 1, z: spot.z }, 2, 60 * 1000);
  }
  return atTarget() ? { ok: true } : { ok: false, reason: 'descend_stuck' };
}

async function marathonDescend(targetY) {
  // base existante en profondeur → pathfinder y retourne (réutilise l'escalier creusé) ;
  // sinon (1er voyage / base perdue) → descente robuste.
  if (world.home && world.home.y <= targetY + 4) {
    const g = await gotoPos(world.home, 3, 10 * 60 * 1000);
    if (!(g && g.ok === false)) return { ok: true };
    emit({ type: 'marathon_goto_base_failed', phase: 'descend' });
  }
  return descendRobust(targetY);
}

async function marathonAscend(targetY) {
  const p = bot.entity.position;
  const goal = pfGoals.GoalY ? new pfGoals.GoalY(targetY) : new pfGoals.GoalNear(p.x, targetY, p.z, 8);
  return withTimeout(bot.pathfinder.goto(goal), 10 * 60 * 1000, () => { try { stopMotion(); } catch (e) {} });
}

async function startMarathon() {
  // ancre de surface (restock trips) : figée la 1re fois qu'on voit le bot en surface
  const p0 = bot.entity && bot.entity.position;
  if (!world.surface && p0 && p0.y >= 55) {
    world.surface = { x: Math.floor(p0.x), y: Math.floor(p0.y), z: Math.floor(p0.z) };
    saveWorld(worldFile, world);
  }
  const kitChain = chainFor('marathon');
  const runKit = () => runPlanner(bot, {
    chain: kitChain,
    runSkill: (g) => runSkillWithTelemetry(g),
    ctxExtra: () => Object.assign(ctxExtra(), { hasBase: !!world.home }),
    onStep: (g) => emit({ type: 'goal', name: g.name }),
  }, taskToken);

  let lastAction = null;
  let sameFails = 0;
  while (!taskToken.cancelled) {
    // Massii B : tick anti-stuck eau À CHAQUE itération (tous contextes : supply run, descente,
    // voyage…) — un vrai joueur sort de l'eau en 1-2 s, jamais de flottage sur place.
    if (isInWater(bot)) await escapeWater(bot, { emit });
    await settleSurvivalKit();                       // menaces/faim d'abord
    if (taskToken.cancelled) return;
    const ctx = marathonCtx();
    const counts = marathonCounts(ctx.inv, ctx.banked);
    const action = nextAction(ctx);
    emit({
      type: 'marathon', action, counts,
      y: ctx.y !== undefined ? Math.round(ctx.y) : null, slots: ctx.emptySlots,
      // réserves (gate READY) : observables sans rcon (la sortie NBT est tronquée à 132 chars)
      wood: woodUnits(ctx.inv), cooked: cookedFood(ctx.inv),
      torch: ctx.inv.torch || 0, picks: ctx.inv.iron_pickaxe || 0, hunger: ctx.hunger,
    });
    if (action === 'done') {
      clearObjective(world); saveWorld(worldFile, world);
      emit({ type: 'autonomous_done', objective: 'marathon', counts });
      return;
    }
    let r = { ok: false, reason: 'unknown_action' };
    try {
      if (action === 'pickaxe') {
        const k = await runKit();
        r = k.done ? { ok: true } : { ok: false, reason: k.stalled ? 'kit_stalled:' + k.goal : 'kit_cancelled' };
      } else if (action === 'base') r = await withTimeout(establishBase(), 3 * 60 * 1000, stopMotion);
      else if (action === 'deposit') r = await withTimeout(marathonDeposit(), 10 * 60 * 1000, stopMotion);
      else if (action === 'restock') r = await withTimeout(marathonRestock(), 15 * 60 * 1000, stopMotion);
      else if (action === 'torches') r = await withTimeout(marathonTorches(), 6 * 60 * 1000, stopMotion);
      else if (action === 'iron') r = await withTimeout(gatherIronGoal(9), timeoutFor('gatherIron'), stopMotion);
      else if (action === 'scaffold') r = await withTimeout(gather(bot, { name: ['stone', 'deepslate'], count: 16 }, taskToken), 5 * 60 * 1000, stopMotion);
      else if (action === 'spare_pickaxe') r = await withTimeout(marathonSparePickaxe(), 6 * 60 * 1000, stopMotion);
      else if (action === 'descend') r = await withTimeout(marathonDescend(miningYFor(counts)), 15 * 60 * 1000, stopMotion);
      else if (action === 'ascend') r = await marathonAscend(miningYFor(counts));
      else if (action === 'mine') {
        r = await withTimeout(branchMine(bot, {
          targetY: miningYFor(counts), mainLength: 24, branchSpacing: 3, branchLength: 8,
          stopWhen: (b) => (b.inventory && b.inventory.emptySlotCount ? b.inventory.emptySlotCount() : 99) <= RESERVES.invFullSlots,
        }, taskToken), 15 * 60 * 1000, stopMotion);
        if (r && r.ores) emit({ type: 'marathon_mined', ores: r.ores });
      }
    } catch (e) { r = { ok: false, reason: String((e && e.message) || e).slice(0, 120) }; }
    if (taskToken.cancelled) return;
    // suivi du compromis nourriture (gate READY) : ratés food consécutifs vs succès
    if (action === 'restock') {
      if (r && r.ok === false && String(r.reason || '').includes('food')) restockFoodFails++;
      else if (r && r.ok) restockFoodFails = 0;
    }
    if (!r || r.ok === false) {
      emit({ type: 'marathon_action_failed', action, reason: (r && r.reason) || 'unknown' });
      sameFails = action === lastAction ? sameFails + 1 : 1;
      lastAction = action;
      if (sameFails >= 5) {
        // anti-blocage : bouger ailleurs change le contexte terrain (pose/gather/path re-tentables)
        emit({ type: 'marathon_stalled', action });
        const spot = findLandTarget(bot, 24);
        if (spot) await gotoPos({ x: spot.x, y: spot.y + 1, z: spot.z }, 2, 60 * 1000);
        sameFails = 0;
      }
    } else { sameFails = 0; lastAction = action; }
    await sleep(800);
  }
}

// Lance (ou relance) la boucle autonome ; le planner re-dérive depuis l'état courant.
async function startAutonomous(sender) {
  // objectif : depuis le world (seedé par le backend/launch), sinon --objective, sinon pioche pierre.
  const objType = (world.objective && world.objective.type) || args.objective || 'stone_pickaxe';
  setObjective(world, { type: objType, status: 'in_progress' });
  saveWorld(worldFile, world);
  taskToken = taskCtl.begin('autonomous', stopMotion);
  emit({ type: 'autonomous_start', objective: objType });
  // RÉCUPÉRATION POST-MORT (vécu Surv4 : chaque mort = kit perdu = re-kit de zéro = spirale) :
  // les items restent 5 min au sol → on retourne les ramasser AVANT de reprendre (borné, best-effort).
  // P10 : la mort persiste dans world.json → la récupération survit à un restart du process.
  if (!lastDeath && world.lastDeath) lastDeath = world.lastDeath;
  if (lastDeath && Date.now() - lastDeath.t < 4 * 60 * 1000) {
    const d = lastDeath; lastDeath = null;
    emit({ type: 'death_recovery', x: Math.round(d.x), y: Math.round(d.y), z: Math.round(d.z) });
    await withTimeout(
      bot.pathfinder.goto(new pfGoals.GoalNear(d.x, d.y, d.z, 1)),
      90000, () => { try { stopMotion(); } catch (e) {} });
    await sleep(1500); // laisser le pickup aspirer les items au sol
  }
  if (objType === 'mapper') return startMapper(); // rôle continu : jamais « done »
  if (objType === 'marathon') return startMarathon(); // 64×4 minerais, boucle longue durée
  const chain = chainFor(objType);               // pioche pierre (MVP) ou pioche fer (IRON_CHAIN)
  const res = await runPlanner(bot, {
    chain,
    runSkill: (g) => runSkillWithTelemetry(g),
    ctxExtra,
    onStep: (g) => emit({ type: 'goal', name: g.name }),
  }, taskToken);
  if (taskToken.cancelled) return; // préempté par une commande
  if (res.done) { clearObjective(world); saveWorld(worldFile, world); if (sender) ackPrivate(sender, doneWord()); emit({ type: 'autonomous_done' }); }
  else if (res.stalled) { if (sender) ackPrivate(sender, failMsg('not_found')); emit({ type: 'autonomous_stalled', goal: res.goal }); }
}

// Bootstrap AuthMe : écoute le prompt ~3s ; /login si pw connu sinon /register (pw généré, stocké local).
function tryAuth() {
  let pw = readPw();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; bot.removeListener('messagestr', onMsg); resolve(); } };
    const onMsg = (msg) => {
      const kind = classifyAuthPrompt(msg);
      if (kind === 'login' && pw) { bot.chat(`/login ${pw}`); emit({ type: 'auth', action: 'login' }); finish(); }
      else if (kind === 'register') {
        if (!pw) { pw = genPassword(); writePw(pw); emit({ type: 'auth', action: 'generated_pw' }); }
        bot.chat(`/register ${pw} ${pw}`); emit({ type: 'auth', action: 'register' }); finish();
      }
    };
    bot.on('messagestr', onMsg);
    setTimeout(finish, 3000); // pas de prompt (serveur sans login) → on continue
  });
}

async function onSpawn() {
  bot._mcaProfile = profile; // expose le profil au skill explore (jitter humanisation ∝ movementJitter)
  // Mémoire de monde : gather émet material_found (apprentissage matériau↔biome), explore lit le
  // biais dirigé, le mapper skippe les cellules déjà mappées. _worldKey re-résolu à chaque spawn
  // (la dimension peut changer : portail nether/end) ; le label explicite (--world-label) prime.
  bot._emit = emit;
  bot._worldMemory = worldMemoryBootstrap;
  bot._worldKey = worldKey(bot, args['world-label']);
  emit({ type: 'status', state: 'spawned', username: bot.username, profile: profile ? profile.id : null });
  if (!bootDone) {
    // une seule fois par connexion : sinon 'spawn' (respawn) ré-ajoute des listeners (fuite, MaxListeners)
    // Movements : défense en profondeur contre le stranding au minage (la table portable est le vrai fix).
    const moves = new Movements(bot);
    moves.canDig = true;            // doit pouvoir miner pour atteindre le cobble
    moves.allow1by1towers = true;   // peut remonter en colonne (cobble en poche) → pas coincé au fond
    moves.allowParkour = true;
    // Massii B : ne router dans l'eau que s'il n'y a AUCUNE alternative terrestre (un bot qui
    // patauge = signature). S'applique à TOUS les goto (les Movements sont globaux au pathfinder).
    if (typeof moves.liquidCost === 'number') moves.liquidCost = 25;
    else moves.liquidCost = 25;
    if (typeof moves.maxDropDown === 'number') moves.maxDropDown = 4; // limite les chutes profondes
    bot.pathfinder.setMovements(moves);
    installReflexes(bot, { emit, fleeFrom });
    await tryAuth();
    bootDone = true;
  }
  if (world.objective && world.objective.status === 'in_progress') {
    emit({ type: 'autonomous_resume', objective: world.objective.type });
    startAutonomous(null);
  }
}

const DONE = { fr: 'fait', en: 'done', it: 'fatto' };
const FAILS = {
  not_found: { fr: 'introuvable', en: 'not found', it: 'non trovato' },
  no_block: { fr: 'quel bloc ?', en: 'which block?', it: 'quale blocco?' },
  no_item: { fr: 'rien à donner', en: 'nothing to give', it: 'niente da dare' },
  empty: { fr: 'inventaire vide', en: 'inventory empty', it: 'inventario vuoto' },
  no_food: { fr: 'pas de nourriture', en: 'no food', it: 'niente cibo' },
  full: { fr: 'pas faim', en: 'not hungry', it: 'non ho fame' },
  no_recipe: { fr: 'pas de recette', en: 'no recipe', it: 'nessuna ricetta' },
  unknown_item: { fr: 'objet inconnu', en: 'unknown item', it: 'oggetto sconosciuto' },
  no_chest: { fr: 'pas de coffre', en: 'no chest', it: 'nessuna cassa' },
  not_visible: { fr: 'je ne te vois pas', en: "can't see you", it: 'non ti vedo' },
  void_below: { fr: 'le vide en dessous', en: 'void below', it: 'vuoto sotto' },
  danger_below: { fr: 'danger en dessous', en: 'danger below', it: 'pericolo sotto' },
};
function doneWord() { return DONE[lang] || DONE.en; }
function failMsg(reason) { const m = FAILS[reason]; return m ? (m[lang] || m.en) : (reason || 'erreur'); }
function ackPrivate(sender, text) { if (sender && text) { try { bot.whisper(sender, text); } catch (e) {} } }

function stopMotion() {
  try { bot.pathfinder && bot.pathfinder.setGoal(null); } catch (e) {}
  try { bot.pvp && bot.pvp.stop(); } catch (e) {}
  ['forward', 'back', 'left', 'right', 'sneak', 'jump'].forEach((c) => { try { bot.setControlState(c, false); } catch (e) {} });
}

const authMode = args.auth === 'microsoft' ? 'microsoft' : 'offline';
const botOpts = {
  host: args.host,
  port: Number(args.port || 25565),
  username: args.user || 'TrainBot',
  auth: authMode,
};
if (authMode === 'microsoft') {
  // Compte officiel requis sur un serveur online-mode (refuse les crackés).
  // device-code flow : on surface le code de login dans le transcript.
  // Aucun mot de passe n'est stocké ; le token est mis en cache dans .mc-auth/
  // (gitignored) → pas de re-login device-code aux redémarrages suivants.
  botOpts.profilesFolder = path.join(__dirname, '.mc-auth');
  botOpts.onMsaCode = (data) => emit({
    type: 'msa',
    message: `Connexion Microsoft : va sur ${data.verification_uri} et entre le code ${data.user_code}`,
  });
}
const bot = mineflayer.createBot(botOpts);
bot.loadPlugin(pathfinder);
bot.loadPlugin(pvp);
bot.loadPlugin(collectBlock);

bot.on('spawn', () => { onSpawn().catch((e) => emit({ type: 'error', message: String((e && e.message) || e) })); });

// Télémétrie mémoire (vécu Marathon run#1 : OOM 2 Go en 116 s, indiagnosticable sans ça) :
// RSS + heap toutes les 30 s → corrélable avec le skill actif dans le même log.
setInterval(() => {
  const m = process.memoryUsage();
  emit({ type: 'mem', rss_mb: Math.round(m.rss / 1048576), heap_mb: Math.round(m.heapUsed / 1048576) });
}, 30000).unref();

async function runAction(decision) {
  const a = decision.action;
  const args2 = decision.args || {};
  if (a === 'follow') { const ok = follow(bot, args2); emit({ type: 'action', skill: 'follow', args: args2, success: ok }); }
  else if (a === 'goto') { emit({ type: 'action', skill: 'goto', args: args2 }); await goto(bot, args2); }
  else if (a === 'mineBlock') { emit({ type: 'action', skill: 'mineBlock', args: args2 }); await mineBlock(bot, args2); }
  else if (a === 'collectWood') { emit({ type: 'action', skill: 'collectWood', args: args2 }); await collectWood(bot, args2); }
  else if (a === 'attackNearest') { const ok = attackNearest(bot); emit({ type: 'action', skill: 'attackNearest', success: ok }); }
  else if (a === 'fleeFrom') { const ok = fleeFrom(bot); emit({ type: 'action', skill: 'fleeFrom', success: ok }); }
}

function replyTo(reaction, text) {
  if (!isAllowed(text, whitelist)) { emit({ type: 'blocked_command', command: text }); return; }
  if (reaction.private) bot.whisper(reaction.to, text); // réponse en privé (/tell)
  else say(bot, text);                                  // réponse en public
}

// Exécute la commande serveur décidée par le LLM, UNIQUEMENT si elle est whitelistée.
function runCommand(decision) {
  const cmd = decision.command;
  if (!cmd) return;
  if (isAllowed(cmd, whitelist)) { bot.chat(String(cmd)); emit({ type: 'command', command: cmd }); }
  else { emit({ type: 'blocked_command', command: cmd }); }
}

// Exécute une commande directe (déterministe, ZÉRO LLM). Retours en /msg privé à l'émetteur.
async function executeOrder(order, sender) {
  const a = order.args || {};
  emit({ type: 'order', verb: order.verb, by: sender });
  switch (order.verb) {
    case 'take': {
      const token = taskCtl.begin('take', stopMotion);
      const r = await gather(bot, a, token);
      if (token.cancelled) break;
      ackPrivate(sender, r.ok ? doneWord() : failMsg(r.reason));
      break;
    }
    case 'mineDown': {
      const token = taskCtl.begin('mineDown', stopMotion);
      const r = await mineDown(bot, a, token);
      if (token.cancelled) break;
      ackPrivate(sender, r.ok ? doneWord() : failMsg(r.reason));
      break;
    }
    case 'follow': {
      taskCtl.begin('follow', stopMotion);
      if (!follow(bot, { player: sender })) ackPrivate(sender, failMsg('not_visible'));
      break;
    }
    case 'come': {
      taskCtl.begin('come', stopMotion);
      const ent = bot.players[sender] && bot.players[sender].entity;
      if (!ent || !ent.position) { ackPrivate(sender, failMsg('not_visible')); break; }
      await goto(bot, { x: ent.position.x, y: ent.position.y, z: ent.position.z });
      ackPrivate(sender, doneWord());
      break;
    }
    case 'goto': {
      taskCtl.begin('goto', stopMotion);
      await goto(bot, a);
      ackPrivate(sender, doneWord());
      break;
    }
    case 'guard': {
      const token = taskCtl.begin('guard', () => {});
      taskCtl.setCleanup(guard(bot, token));
      break;
    }
    case 'stop': {
      taskCtl.begin('loiter', () => {});
      taskCtl.setCleanup(loiter(bot, profile));
      break;
    }
    case 'afk': {
      taskCtl.cancel();
      stopMotion();
      if (isAllowed('/afk', whitelist)) { bot.chat('/afk'); emit({ type: 'command', command: '/afk' }); }
      break;
    }
    case 'pvp': {
      taskCtl.begin('pvp', () => { try { bot.pvp.stop(); } catch (e) {} });
      const ent = bot.players[a.player] && bot.players[a.player].entity;
      if (!ent) { ackPrivate(sender, failMsg('not_visible')); break; }
      const w = bestWeapon(bot);
      if (w) { try { await bot.equip(w, 'hand'); } catch (e) {} }
      try { bot.pvp.attack(ent); } catch (e) {}
      break;
    }
    case 'tpa': {
      const target = a.target === 'me' ? sender : a.target;
      const cmd = '/tpa ' + target;
      if (isAllowed(cmd, whitelist)) { bot.chat(cmd); emit({ type: 'command', command: cmd }); }
      else { emit({ type: 'blocked_command', command: cmd }); }
      break;
    }
    case 'give': { const r = await giveItem(bot, a, sender); if (!r.ok) ackPrivate(sender, failMsg(r.reason)); break; }
    case 'giveAll': { const r = await giveAll(bot, a, sender); ackPrivate(sender, r.ok ? doneWord() : failMsg(r.reason)); break; }
    case 'craft': { const r = await craftItem(bot, a); if (!r.ok) ackPrivate(sender, failMsg(r.reason)); break; }
    case 'deposit': { const r = await deposit(bot); ackPrivate(sender, r.ok ? doneWord() : failMsg(r.reason)); break; }
    case 'equip': { const r = await equipItem(bot, a); if (!r.ok) ackPrivate(sender, failMsg(r.reason)); break; }
    case 'eat': { const r = await eat(bot); if (!r.ok) ackPrivate(sender, failMsg(r.reason)); break; }
    case 'startAutonomous': { startAutonomous(sender); break; } // tâche de fond : ne pas await
    default: break;
  }
  // Reprise de l'objectif autonome après une commande transitoire (préemption → resume).
  const transient = !['stop', 'afk', 'guard', 'follow', 'pvp', 'startAutonomous'].includes(order.verb);
  if (transient && world.objective && world.objective.status === 'in_progress') {
    startAutonomous(null); // le planner re-dérive depuis l'état courant
  }
  emit({ type: 'order_done', verb: order.verb });
}

// Traite un message entrant (chat public OU whisper privé) selon la politique de réponse.
// Anti-giveaway + anti-coût : on n'appelle le LLM que si le message nous est adressé.
async function handleIncoming(username, message, isWhisper) {
  if (username === bot.username) return;

  // Pré-filtre commandes directes : UNIQUEMENT en /msg privé, ZÉRO appel LLM.
  if (isWhisper) {
    const order = parseOrder(message);
    if (order) {
      const allowed = isTrusted(username, policy.trusted) || (policy.trusted || []).length === 0;
      emit({ type: 'chat', from: username, message, private: true, handled: allowed });
      if (allowed) {
        try { await executeOrder(order, username); }
        catch (e) { emit({ type: 'error', message: String((e && e.message) || e) }); }
      } else {
        emit({ type: 'order_ignored', by: username });
      }
      return; // ne descend jamais vers le LLM
    }
  }

  const reaction = decideReaction({ username, message, isWhisper, botUsername: bot.username, publicMode: PUBLIC_MODE });
  emit({ type: 'chat', from: username, message, private: !!isWhisper, handled: !!reaction });
  if (!reaction) return;
  try {
    const history = memory.history(username);
    const decision0 = await think(client, { state: snapshot(bot), message, model, limiter, profile, commandDocs, trustDocs, sender: username, history, lang });
    if (!decision0) { emit({ type: 'info', message: 'rate-limited' }); return; }
    const decision = gateDecision(decision0, username, policy.trusted);
    if (decision !== decision0) { emit({ type: 'order_refused', from: username }); }
    if (decision.reply) {
      const { text, delayMs } = humanizeReply(profile, decision.reply);
      await sleep(delayMs);
      if (text) { replyTo(reaction, text); emit({ type: 'say', message: text, private: reaction.private, to: reaction.to }); }
    }
    memory.append(username, 'user', message);
    if (decision.reply) memory.append(username, 'assistant', decision.reply);
    await runAction(decision);
    runCommand(decision);
  } catch (e) {
    emit({ type: 'error', message: String((e && e.message) || e) });
  }
}

bot.on('chat', (username, message) => handleIncoming(username, message, false));
bot.on('whisper', (username, message) => handleIncoming(username, message, true));

// Auto-accept des demandes TP (et trade) UNIQUEMENT des gens de confiance, et seulement si
// la commande d'acceptation est cochée dans la whitelist (synergie avec la config commandes).
bot.on('messagestr', (msg) => {
  const tpWho = parseTpRequest(msg);
  if (tpWho && isTrusted(tpWho, policy.trusted) && isAllowed('/tpaccept', whitelist)) {
    bot.chat('/tpaccept'); emit({ type: 'command', command: '/tpaccept', reason: 'tp:' + tpWho });
    return;
  }
  if (policy.trade) {
    const trWho = parseTradeRequest(msg, policy.trade);
    if (trWho && isTrusted(trWho, policy.trusted) && isAllowed(policy.trade.acceptCmd, whitelist)) {
      bot.chat(policy.trade.acceptCmd); emit({ type: 'command', command: policy.trade.acceptCmd, reason: 'trade:' + trWho });
    }
  }
});

let lastDeath = null; // {x,y,z,t} — pour retourner ramasser ses items au respawn (despawn 5 min)

bot.on('death', () => {
  emit({ type: 'status', state: 'dead' });
  const p = bot.entity && bot.entity.position;
  if (p) {
    lastDeath = { x: p.x, y: p.y, z: p.z, t: Date.now() };
    // P10 : persister la mort — un restart du process (crash/redeploy) perdait la position
    // → pas de récupération d'items à la reprise alors qu'ils restent 5 min au sol.
    try { world.lastDeath = lastDeath; saveWorld(worldFile, world); } catch (e) {}
  }
  // Garde-fou anti-boucle de mort : 3 morts / 10 min → stop + notifie (sinon respawn → onSpawn → reprise).
  deathTimes.push(Date.now());
  deathTimes = deathTimes.filter((t) => Date.now() - t < 10 * 60 * 1000);
  if (deathTimes.length >= 3) {
    taskCtl.cancel();
    if (world.objective) { world.objective.status = 'paused'; saveWorld(worldFile, world); }
    emit({ type: 'autonomous_stalled', reason: 'death_loop' });
  }
});
bot.on('kicked', (reason) => emit({ type: 'error', message: 'kicked: ' + reason }));
bot.on('error', (e) => emit({ type: 'error', message: String((e && e.message) || e) }));
bot.on('end', () => { emit({ type: 'status', state: 'disconnected' }); process.exit(0); });

onCommand((cmd) => {
  if (cmd.type === 'say') say(bot, cmd.message);
  else if (cmd.type === 'quit') bot.quit();
  // Re-balance multi-cartographes : le manager re-pousse {index,count} quand N change dans le groupe.
  // Lu live par runMapper via getSector() → effet au prochain batch (pas de redémarrage).
  else if (cmd.type === 'sector' && cmd.count >= 1) {
    mapperSector = { index: Number(cmd.index) || 0, count: Number(cmd.count) };
    emit({ type: 'sector_set', index: mapperSector.index, count: mapperSector.count });
  }
});
