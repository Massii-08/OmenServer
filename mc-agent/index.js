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
const { humanizeReply, nextLook, sampleReactionDelay } = require('./humanize');
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
const vec3Lib = require('vec3'); // watchdog anti-jam (blocs barrants)
const { gather } = require('./skills/gather');
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
const { classifyAuthPrompt, genPassword, resolveAuthChat } = require('./auth');
const { loadMemory, worldKey } = require('./worldMemory');
const { runMapper } = require('./mapper');
const { LOCATE_KINDS, parseLocateResponse, structureFoundEvent } = require('./structures');
const { isInWater, escapeWater, findLandTarget } = require('./unstuck');
const { runResource } = require('./skills/resource');
const { tunnelTo } = require('./skills/tunnelTo');
const { junkItems, ITEMS_FOR } = require('./quota');
const { Y_OPT, pickaxePlan, armorPlan, ARMOR_PIECES } = require('./gear');
// Torche tous les N paliers de branch-mine (mob-aware phase B) — best-effort : sans torche
// en poche le minage continue sans (zéro coût en peaceful, sécurité en non-pacifique).
const TORCH_EVERY = 8;
const { createClaims } = require('./claims');
const { tierRank } = require('./tools');
const { createTeleportWatcher, wireTeleportDetection } = require('./teleport');
const { isNight, shelterUntilDawn } = require('./skills/shelter');

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

// Mode FURTIF (--stealth 1) : humanisation COMPLÈTE y compris loiter (« stop = vivant »).
// OFF PAR DÉFAUT (phase 3) : les bots utilitaires vont à vitesse machine.
const STEALTH = String(args.stealth || '') === '1';
// HUMANISATION ciblée (--humanize 1, spec cartographes Massii 07/06) : déplacements naturels
// (jitter explore), latence de réponse humaine ET STOP-POUR-RÉPONDRE (un humain lâche ses
// touches pour taper — bouger en répondant = tell de bot). SANS le loiter (gestes bizarres,
// réservé à STEALTH). STEALTH implique HUMANIZE.
const HUMANIZE = STEALTH || String(args.humanize || '') === '1';

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
const tpWatch = createTeleportWatcher(); // #10 : suivi de position → détection TP + ré-ancrage mapper

// --- Planner autonome (Phase 3) : le but autonome = tâche par défaut de taskCtl ---
const worldFile = args.world || path.join(__dirname, '..', 'data', `mc_agent_world_${args.user || 'TrainBot'}.json`);
const world = loadWorld(worldFile);
let taskToken = { cancelled: true };
let deathTimes = [];
let _escapeOnSpawn = false; // anti-camping : 2 morts <60 s → warp + re-spawnpoint au prochain spawn
let _convoPauseUntil = 0;   // stop-pour-répondre : gèle les gotos pendant réflexion+frappe (HUMANIZE)
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

// Login serveur configuré par l'admin (--login-command <path>) : commande complète AVEC le secret
// (substitué côté backend). Lue depuis un fichier temp chmod 600. JAMAIS émise/loggée (contient le pw).
function readLoginCommand() {
  if (!args['login-command']) return null;
  try {
    const cmd = fs.readFileSync(args['login-command'], 'utf8').trim();
    return cmd || null;
  } catch (e) { return null; }
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
  // Barreau manquant de l'échelle (vécu V2Res1 en crash-loop) : table PERDUE (kick avant
  // reclaim) → placeBlockNear échouait 'unknown_item' pour toujours. Une table se re-craft
  // en 2×2 SANS table (4 planks) → on la re-fabrique avant de la poser.
  const hasTableItem = ((bot.inventory && bot.inventory.items()) || []).some((i) => i.name === 'crafting_table');
  if (!hasTableItem) {
    // Re-craft 2×2 (4 planks). Planks manquantes mais BÛCHES en poche → planches d'abord
    // (essence du log en main — phase 3, complète le fix V2Res1).
    const items = (bot.inventory && bot.inventory.items()) || [];
    const planks = items.filter((i) => i.name.endsWith('_planks')).reduce((a, i) => a + i.count, 0);
    if (planks < 4) {
      const log = items.find((i) => i.name.endsWith('_log'));
      if (log) { try { await craftItem(bot, { name: log.name.replace('_log', '_planks'), count: 1 }); } catch (e) { /* best-effort */ } }
    }
    try { await craftItem(bot, { name: 'crafting_table', count: 1 }); } catch (e) { /* best-effort */ }
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
// gather/gatherLog : 8 min — un trajet DIRIGÉ légitime peut faire ≤1500 blocs (mémoire de monde) ;
// sûr car chaque goto interne d'explore est borné individuellement (directed 240s / waypoint 90s).
// gatherLog 180s (phase 3) : une chasse au bois honnête (biais dirigé + anneaux ≤128) tient en
// <3 min — au-delà la zone est déforestée et le kit-relocate forêt est plus rentable que d'insister
// (vécu V3Res1/4 : 480s × 4 tentatives = 32 min d'anneaux stériles avant le stall).
const SKILL_TIMEOUTS = { descendDiagonal: 900000, branchMine: 900000, huntCook: 480000, smeltCharcoal: 300000, gather: 480000, gatherLog: 180000 };
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
  const coalDefs = ['coal_ore', 'deepslate_coal_ore'].map((n) => bot.registry.blocksByName[n]).filter(Boolean);
  if (coalDefs.length && bot.findBlock({ matching: coalDefs.map((b) => b.id), maxDistance: 32 })) {
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
  if (goal.skill === 'smeltIron') return smeltWithFurnace('raw_iron', 'iron_ingot', goal.args.count || 3);
  if (goal.skill === 'smeltCharcoal') return smeltCharcoalGoal(goal.args.count || 2);
  if (goal.skill === 'huntCook') return huntCookGoal(goal.args.target || 4);
  if (goal.skill === 'descendDiagonal') return descendDiagonal(bot, goal.args || {}, taskToken);
  if (goal.skill === 'branchMine') return branchMine(bot, goal.args || {}, taskToken);
  return { ok: false, reason: 'unknown_skill' };
}

// Upgrade kit du cartographe (spec §5.1) : fer « si rapide » (minerai visible ≤32 blocs, sinon on
// n'insiste pas) → sinon fallback CUIVRE registry-gated (copper_sword n'existe qu'en 1.21.9+/moddé ;
// sur 1.21.4 ce bloc est inerte). Best-effort : chaque étape bornée, tout échec = on part à la pierre.
async function tryKitUpgrade() {
  const reg = bot.registry;
  const oreIds = (names) => names.map((n) => reg.blocksByName[n]).filter(Boolean).map((b) => b.id);
  const tryMetal = async (ores, raw, ingot, sword) => {
    if (!reg.itemsByName[sword]) return false;                       // registry-gated (cuivre)
    const ids = oreIds(ores);
    if (!ids.length || !bot.findBlock({ matching: ids, maxDistance: 32 })) return false; // pas « rapide »
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
  // ── Phase 2 : rotation /locate (bot OP) — 1 structure/60 s, réponse op parsée en messagestr.
  // Échec silencieux si pas op / serveur sans la structure (réponse d'erreur non matchée).
  let locateIdx = 0;
  let pendingLocate = null;
  // 180 s + jitter par bot : un /locate sur structure non générée fouille les region files —
  // ×5 mappers à 60 s ça a contribué au freeze serveur 49 s (vécu phase 2).
  const locateTimer = args.frontier ? setInterval(() => {
    if (taskToken.cancelled) { clearInterval(locateTimer); return; }
    const item = LOCATE_KINDS[locateIdx++ % LOCATE_KINDS.length];
    pendingLocate = { kind: item.kind, at: Date.now() };
    try { bot.chat('/locate structure ' + item.arg); } catch (e) { /* best-effort */ }
  }, 180000 + Math.floor(Math.random() * 60000)) : null;
  if (args.frontier) {
    bot.on('messagestr', (msg) => {
      if (!pendingLocate || Date.now() - pendingLocate.at > 10000) return;
      const r = parseLocateResponse(msg);
      if (!r) return;
      emit(structureFoundEvent(bot._worldKey, pendingLocate.kind, { x: r.x, y: 64, z: r.z }));
      pendingLocate = null;
    });
  }
  // Warp self-service (bot OP) : /spreadplayers ≈ tp SÛR en surface près de (x,z).
  const warp = args.frontier ? (async (x, z) => {
    bot.chat('/spreadplayers ' + Math.round(x) + ' ' + Math.round(z) + ' 0 48 false ' + bot.username);
  }) : null;
  await runMapper(bot, {
    worldKey: bot._worldKey,
    memory: bot._worldMemory,
    frontier: !!args.frontier,
    warp,
    reloadMemory: (args['wm-live'] && args['world-memory'])
      ? () => loadMemory(args['world-memory']) : null,
    getSector: () => mapperSector,
    teleport: tpWatch, // #10 : TP détecté → ré-ancrage (heading propre depuis la position réelle)
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
    goto: async (wp) => {
      // stop-pour-répondre : pas de nouvelle jambe tant que le bot « tape » sa réponse.
      while (Date.now() < _convoPauseUntil) await sleep(250);
      const r = await withTimeout(
        bot.pathfinder.goto(new pfGoals.GoalNear(wp.x, wp.y, wp.z, 8)),
        45000, () => { try { stopMotion(); } catch (e) {} });
      if (r && r.ok === false) throw new Error(r.reason || 'goto_failed');
    },
  }, taskToken);
}

// --- Bot RESSOURCE (objectif `resource`, role worker) : mine les minerais EXPOSÉS de la carte ----

// Meilleur palier de pioche en poche (-1 = aucune) : filtre les cibles inminables (diamant sans fer).
function bestPickTier() {
  const items = (bot.inventory && bot.inventory.items()) || [];
  let best = -1;
  for (const it of items) {
    if (it && it.name && it.name.endsWith('_pickaxe')) best = Math.max(best, tierRank(it.name));
  }
  return best;
}

// Navigation bornée vers un minerai (x,y,z exact) avec PERSISTANCE PAR PROGRÈS (pattern explore
// dirigé) : un goto interrompu par les réflexes (flee/surface → GoalChanged) est repris tant qu'on
// se RAPPROCHE ; un timeout (240s, cible gelée) ou 2 tentatives sans progrès → unreachable (throw).
async function gotoOreBounded(t) {
  const dist = () => {
    const p = bot.entity && bot.entity.position;
    if (!p) return Infinity;
    return Math.sqrt((p.x - t.x) ** 2 + (p.y - t.y) ** 2 + (p.z - t.z) ** 2);
  };
  if (dist() <= 4) return;                                     // déjà à portée de collect
  emit({ type: 'ore_approach', phase: 'direct', x: t.x, y: t.y, z: t.z, d: Math.round(dist()) });

  // Phase 1 — goto direct BREF (90 s) : suffit pour les ores exposées/accessibles par grotte.
  // On ne s'acharne pas : pathfinder ne sait PAS traverser 60 blocs de roche pleine (A*
  // explose → chemins partiels qui plafonnent en surface — vécu live, 3 bots à l'arrêt).
  const direct = await withTimeout(
    bot.pathfinder.goto(new pfGoals.GoalNear(t.x, t.y, t.z, 2)),
    90000, () => { try { stopMotion(); } catch (e) {} });
  if (taskToken.cancelled) return;
  if (!(direct && direct.ok === false)) return;                // arrivé
  if (dist() <= 5) return;                                     // assez proche (collect range ~6)

  const below = (bot.entity && bot.entity.position ? bot.entity.position.y : 0) - t.y;
  if (below > 4) {
    emit({ type: 'ore_approach', phase: 'xz', x: t.x, z: t.z, d: Math.round(dist()) });
    // Phase 2 — cible ENFOUIE : rapprochement XZ BEST-EFFORT (un NoPath instantané sur une
    // cible à 150+ blocs ne doit PAS tuer l'approche — vécu live), puis tunnelTo fait LE
    // RESTE (il creuse aussi l'horizontal : marches 1×2 anti-lave orientées cible).
    for (let attempts = 0; attempts < 2; attempts++) {
      const r = await withTimeout(
        bot.pathfinder.goto(new pfGoals.GoalNearXZ(t.x, t.z, 16)),
        120000, () => { try { stopMotion(); } catch (e) {} });
      if (taskToken.cancelled) return;
      if (!(r && r.ok === false)) break;                       // arrivé au-dessus (ou proche)
      await sleep(2000);                                        // NoPath transitoire → 1 retry
    }
    if (taskToken.cancelled) return;
    emit({ type: 'ore_approach', phase: 'tunnel', d: Math.round(dist()) });
    const dug = await withTimeout(
      tunnelTo(bot, t, {}, taskToken),
      420000, () => { try { stopMotion(); } catch (e) {} });
    if (taskToken.cancelled) return;
    emit({ type: 'tunnel_result', ok: !!(dug && dug.ok), reason: (dug && dug.reason) || null, d: Math.round(dist()) });
    if (dug && dug.ok && dist() <= 6) return;
    throw new Error('unreachable');                            // lave/échec → claim relâchée
  }

  // Cible au niveau / au-dessus : persistance par progrès. PHASE 3 (mouvement décisif) :
  // tranches 120 s (au lieu de 300) et verdict après 2 tranches sans progrès — un goto gelé
  // coûtait jusqu'à 10 min de sur-place/twitch avant le verdict unreachable.
  let lastD = dist();
  let noProgress = 0;
  for (let attempts = 0; attempts < 8; attempts++) {
    const r = await withTimeout(
      bot.pathfinder.goto(new pfGoals.GoalNear(t.x, t.y, t.z, 2)),
      120000, () => { try { stopMotion(); } catch (e) {} });
    if (taskToken.cancelled) return;
    if (!(r && r.ok === false)) return;                        // arrivé (goto résolu)
    const d = dist();
    if (d < lastD - 8) { lastD = d; noProgress = 0; continue; } // progrès → persiste
    noProgress++;
    if (noProgress >= 2) throw new Error('unreachable');
    await sleep(2000);
  }
  throw new Error('unreachable');
}


// Boucle ressource : kit pioche minimal si nécessaire (zéro→pioche pierre, chaîne existante), puis
// mine les ores de la carte un à un. Liste vide/épuisée → idle PROPRE (immobile, réflexes survie ON).
// Toss du junk de creusage (mode quota, sous terre : pas de coffre — on garde pioches/bouffe/quota).
async function tossJunk(b) {
  const items = (b.inventory && b.inventory.items()) || [];
  for (const it of junkItems(items)) {
    try { await b.toss(it.type, null, it.count); } catch (e) { /* slot bougé → tant pis */ }
  }
}

// Quota --quota <path> : {type: n} (JSON, validé par quota.normalizeQuota côté runResource).
function loadQuota() {
  if (!args.quota) return null;
  try { return JSON.parse(require('fs').readFileSync(String(args.quota), 'utf8')); }
  catch (e) { return null; }
}

// ── Phase 2 : maintenance d'outillage (craft stone/iron pick depuis les matériaux minés).
// Backoff après échec (phase 3, vécu V3Res3 : gear_craft FAIL ×11 — le craft raté était RETENTÉ
// à chaque itération de cible, et chaque tentative = goto table + pose ≈ 30 s → ~40 min perdues.
// Le manque de matériaux ne change pas en 10 s : on retente au plus toutes les 2 min.
let _gearFailAt = 0;
async function ensureGearFor(neededTypes) {
  if (Date.now() - _gearFailAt < 120000) return;
  const items = (bot.inventory && bot.inventory.items()) || [];
  const plan = pickaxePlan(items.map((i) => ({ name: i.name, count: i.count })), neededTypes);
  if (!plan.craft) return;
  if (plan.craft === 'iron_pickaxe') {
    // lingots manquants mais raw_iron en poche → fonte d'abord (four portable du kit)
    const count = (n) => items.filter((i) => i.name === n).reduce((a, i) => a + i.count, 0);
    if (count('iron_ingot') < 3 && count('raw_iron') >= 3) {
      try { await smeltWithFurnace('raw_iron', 'iron_ingot', 3); } catch (e) { /* best-effort */ }
    }
  }
  try {
    const r = await craftSmart({ name: plan.craft, count: 1 });
    emit({ type: 'gear_craft', item: plan.craft, ok: !!(r && r.ok), why: plan.why });
    if (!(r && r.ok)) _gearFailAt = Date.now();
  } catch (e) { emit({ type: 'gear_craft', item: plan.craft, ok: false, why: plan.why }); _gearFailAt = Date.now(); }
}

// ── Phase B SURVIE (Massii) : ARMURE de fer = levier #1. Équipe toute pièce d'armure déjà en
// poche (slot vide), puis craft la pièce manquante la moins chère SI le bot a du fer en LARGE
// excès du quota (ironKeep = manque quota restant + 4 marge → on ne sacrifie pas l'objectif fer).
// + BOUCLIER (6 planks + 1 lingot) en main secondaire (anti-squelette). Best-effort, borné.
const ARMOR_SLOTS = { feet: 'feet', head: 'head', legs: 'legs', torso: 'torso' };
function _wornArmor() {
  // pièces d'armure ACTUELLEMENT portées (slots 5-8) — pour ne pas re-équiper/re-crafter.
  const worn = new Set();
  try {
    for (const it of (bot.inventory && bot.inventory.slots ? bot.inventory.slots.slice(5, 9) : [])) {
      if (it && it.name) worn.add(it.name);
    }
  } catch (e) {}
  return worn;
}
async function ensureArmor(neededIronRemaining) {
  const items = () => ((bot.inventory && bot.inventory.items()) || []).map((i) => ({ name: i.name, count: i.count }));
  const cnt = (n) => items().filter((i) => i.name === n).reduce((a, i) => a + i.count, 0);
  const worn = _wornArmor();
  // 1) Équiper les pièces déjà en poche mais pas portées.
  for (const piece of ARMOR_PIECES) {
    if (worn.has(piece.name)) continue;
    const it = ((bot.inventory && bot.inventory.items()) || []).find((i) => i.name === piece.name);
    if (it) { try { await bot.equip(it, ARMOR_SLOTS[piece.slot]); worn.add(piece.name); } catch (e) {} }
  }
  // 2) Craft la prochaine pièce. ironKeep FIXE bas (8) — l'armure PRIME (survie #1 Massii) : le
  //    bot re-mine le quota fer, l'armure survit aux morts (keepInventory). Le gate quota-strict
  //    bloquait tout (armorPlan null en boucle, vécu : 0 armure craftée). Smelt FORCÉ du raw_iron
  //    nécessaire si les lingots manquent pour la pièce la moins chère.
  const ironKeep = 8;       // buffer fer total préservé pour le quota (appliqué AU GATE ci-dessous)
  const nextPiece = ARMOR_PIECES.find((pc) => !worn.has(pc.name) && !items().some((i) => i.name === pc.name));
  if (nextPiece) {
    const totalIron = cnt('raw_iron') + cnt('iron_ingot');
    if (totalIron - ironKeep >= nextPiece.ingots) {
      const need = nextPiece.ingots - cnt('iron_ingot');
      if (need > 0 && cnt('raw_iron') >= need) {
        try { await smeltWithFurnace('raw_iron', 'iron_ingot', need); } catch (e) {}
      }
    }
  }
  // armorPlan ironKeep=0 : le buffer fer est DÉJÀ enforced par le gate totalIron ci-dessus —
  // le ré-appliquer sur les seuls lingots (armorPlan ne compte QUE iron_ingot) le double-comptait
  // → spendable négatif → 0 armure craftée (vécu live, fer haut mais pioche fer consomme les
  //   lingots et il n'en reste jamais 8+).
  const plan = armorPlan(items(), { have: worn, ironKeep: 0 });
  if (plan) {
    try {
      const r = await craftSmart({ name: plan.craft, count: 1 });
      if (r && r.ok) {
        const it = ((bot.inventory && bot.inventory.items()) || []).find((i) => i.name === plan.craft);
        if (it) { try { await bot.equip(it, ARMOR_SLOTS[plan.slot]); } catch (e) {} }
        emit({ type: 'gear_craft', item: plan.craft, ok: true, why: 'armor' });
      }
    } catch (e) {}
  }
  // 3) Bouclier (anti-projectile) : craft + garde en off-hand.
  const hasShield = ((bot.inventory && bot.inventory.items()) || []).some((i) => i.name === 'shield')
    || worn.has('shield') || (bot.inventory && bot.inventory.slots && bot.inventory.slots[45] && bot.inventory.slots[45].name === 'shield');
  const planks = items().filter((i) => i.name.endsWith('_planks')).reduce((a, i) => a + i.count, 0);
  if (!hasShield && planks >= 6 && cnt('iron_ingot') >= 1) {
    try {
      const r = await craftSmart({ name: 'shield', count: 1 });
      if (r && r.ok) {
        const sh = ((bot.inventory && bot.inventory.items()) || []).find((i) => i.name === 'shield');
        if (sh) { try { await bot.equip(sh, 'off-hand'); emit({ type: 'gear_craft', item: 'shield', ok: true, why: 'armor' }); } catch (e) {} }
      }
    } catch (e) {}
  }
}

// ── Phase B : stock de torches (mob-aware) — 1 charbon + 1 stick = 4 torches. Best-effort :
// sans charbon (le branch-mine en croise sans arrêt) ni sticks, on mine sans torches.
async function ensureTorches() {
  const items = (bot.inventory && bot.inventory.items()) || [];
  const count = (n) => items.filter((i) => i.name === n).reduce((a, i) => a + i.count, 0);
  if (count('torch') >= 8) return;
  if ((count('coal') + count('charcoal')) < 1 || count('stick') < 1) return;
  try {
    const r = await craftSmart({ name: 'torch', count: 8 });
    if (r && r.ok) emit({ type: 'gear_craft', item: 'torch', ok: true, why: 'mob_aware' });
  } catch (e) { /* best-effort */ }
}

// ── Phase 2 : branch-mine RÉEL au Y optimal du type (anti-xray : on ne voit plus à travers
// la roche — on mine comme un joueur). Descente diagonale puis branchMine (anti-lave +
// collecte opportuniste des ores exposés par NOS digs — l'anti-xray les révèle au block update).
// ── Récupération de pioche (Massii #5) : JAMAIS de minage à la main. 1) craft SUR PLACE
// (buffers sticks/planks/table du rab post-kit — un stone pick = 3 cobble + 2 sticks) ;
// 2) sinon EXPÉDITION BOIS : position SAUVÉE, warp forêt (bot OP), gather logs, craft
// planks→sticks→pioche, puis /tp RETOUR EXACT au spot — pas de respawn, on ne perd pas la mine.
async function recoverPickaxe() {
  emit({ type: 'pick_recovery' });
  try { await ensureGearFor(['iron']); } catch (e) { /* best-effort */ }
  if (bestPickTier() >= 0) return { ok: true };
  try { await craftSmart({ name: 'stone_pickaxe', count: 1 }); } catch (e) {}
  if (bestPickTier() >= 0) return { ok: true };
  const pp = bot.entity && bot.entity.position;
  const p0 = pp ? { x: Math.floor(pp.x), y: Math.floor(pp.y), z: Math.floor(pp.z) } : null;
  emit({ type: 'pick_recovery_trip', from: p0 });
  await relocateToRegion({ forest: true });
  if (taskToken.cancelled) return { ok: false };
  const logNames = Object.keys((bot.registry && bot.registry.blocksByName) || {}).filter((n) => n.endsWith('_log'));
  try { await withTimeout(gather(bot, { name: logNames, count: 4, explore: true }, taskToken), 240000, () => { try { stopMotion(); } catch (e) {} }); } catch (e) {}
  try {
    const log = ((bot.inventory && bot.inventory.items()) || []).find((i) => i.name.endsWith('_log'));
    if (log) await craftItem(bot, { name: log.name.replace('_log', '_planks'), count: 3 });
    await craftSmart({ name: 'stick', count: 4 });
    await craftSmart({ name: 'stone_pickaxe', count: 1 });
    if (bestPickTier() < 0) await craftSmart({ name: 'wooden_pickaxe', count: 1 });
  } catch (e) { /* best-effort */ }
  if (p0) {
    try { bot.chat('/tp @s ' + p0.x + ' ' + p0.y + ' ' + p0.z); } catch (e) {}
    await sleep(3000);
  }
  return { ok: bestPickTier() >= 0 };
}

async function mineForType(type, needed) {
  const targetY = Y_OPT[type] !== undefined ? Y_OPT[type] : -58;
  // SANS PIOCHE (Massii #5) : récupération AVANT toute tentative — les skills refusent
  // désormais de creuser à la main (no_pickaxe).
  if (bestPickTier() < 0) {
    const r0 = await withTimeout(recoverPickaxe(), 420000, () => { try { stopMotion(); } catch (e) {} });
    if (taskToken.cancelled) return { ok: true };
    if (!(r0 && r0.ok)) return { ok: false, reason: 'no_pickaxe' };
  }
  const p = bot.entity && bot.entity.position;
  if (!p) return { ok: false, reason: 'no_pos' };
  if (p.y < targetY - 6) return { ok: false, reason: 'below_target' };   // remonter = relocate (warp surface)
  if (p.y > targetY + 2) {
    // Phase 3 : descente PERSISTANTE — un timeout a fait du progrès (y a baissé), on REPREND de
    // la position courante au lieu d'échouer (l'échec → relocate-surface détruisait tout, vécu
    // V3Res4 ×5). Lave/vide devant → ROTATION 90° puis re-descente (une nappe barre rarement
    // les 4 cardinaux) au lieu de retenter le même mur (vécu V3Res2 : lava_ahead ×5 même cap).
    let lavaTurns = 0;
    for (let att = 0; att < 6; att++) {
      const d = await withTimeout(descendDiagonal(bot, { targetY }, taskToken), 600000,
        () => { try { stopMotion(); } catch (e) {} });
      if (taskToken.cancelled) return { ok: true };
      if (d && d.ok) break;
      const yNow = (bot.entity && bot.entity.position) ? bot.entity.position.y : 999;
      if (yNow <= targetY + 2) break;                    // arrivé malgré le reason (edge)
      const why = (d && d.reason) || 'timeout';
      if (why === 'lava_ahead' || why === 'air_at_y_-50' || why === 'drop_ahead') {
        lavaTurns++;
        if (lavaTurns > 3) return { ok: false, reason: why };   // 4 cardinaux barrés → vraie impasse
        try { await bot.look(((bot.entity && bot.entity.yaw) || 0) + Math.PI / 2, 0, true); } catch (e) {}
        // LONGER LA PAROI (vécu V3Res2 : drop_ahead en boucle au bord d'une méga-grotte 1.18 —
        // re-descendre du MÊME point re-trouve le même gouffre) : ~8 blocs dans la nouvelle
        // direction avant de re-tenter, pathfinder borné (il contourne ou échoue vite).
        try {
          const yawNow = (bot.entity && bot.entity.yaw) || 0;
          const px = bot.entity.position.x - Math.sin(yawNow) * 8;
          const pz = bot.entity.position.z + Math.cos(yawNow) * 8;
          await withTimeout(
            bot.pathfinder.goto(new pfGoals.GoalNearXZ(px, pz, 2)),
            20000, () => { try { stopMotion(); } catch (e) {} });
        } catch (e) { /* best-effort */ }
        if (taskToken.cancelled) return { ok: true };
        continue;
      }
      if (why === 'timeout' || why === 'dig_failed') continue;  // progrès conservé → on re-descend
      return { ok: false, reason: why };                 // max_depth/no_pos → la boucle décide
    }
    const yEnd = (bot.entity && bot.entity.position) ? bot.entity.position.y : 999;
    if (yEnd > targetY + 2) return { ok: false, reason: 'descend_failed' };
  }
  // Phase 3 : stop sur DELTA récolté (mode quota — le bot PORTE déjà des items du type) +
  // cap PERSISTANT entre calls (le tunnel continue tout droit au lieu de se recroiser).
  const stopOre = { items: ITEMS_FOR[type] || [type], count: Math.max(1, Number(needed) || 1) };
  const r = await withTimeout(branchMine(bot, {
    targetY, mainLength: 24, branchLength: 8, stopOre,
    heading: bot._branchHeading || null,
    torchEvery: TORCH_EVERY,
  }, taskToken), 900000, () => { try { stopMotion(); } catch (e) {} });
  if (taskToken.cancelled) return { ok: true };
  if (r && r.heading) bot._branchHeading = r.heading;
  // Lave/gouffre en travers du tunnel principal : on TOURNE (perpendiculaire) pour le prochain
  // call — persister le même cap re-tamponnerait le même obstacle à l'infini.
  if (r && (r.reason === 'lava' || r.reason === 'drop') && bot._branchHeading) {
    bot._branchHeading = { dx: -bot._branchHeading.dz, dz: bot._branchHeading.dx };
  }
  return (r && r.ok) ? r : { ok: false, reason: (r && r.reason) || 'branch_failed' };
}

// ── Phase 2 : self-warp vers la RÉGION du bot (quadrant stable dérivé du username autour du
// spawn) — auto-récupération de starvation/échec sans intervention humaine (bot OP requis).
function regionCenter() {
  const base = { x: 208, z: 528 };                       // spawn monde du serveur de test
  let h = 0;
  for (const c of String(bot.username || 'bot')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const quad = h % 4;
  const dx = (quad & 1) ? 520 : -520;
  const dz = (quad & 2) ? 520 : -520;
  const jitter = ((h >> 4) % 200) - 100;
  return { x: base.x + dx + jitter, z: base.z + dz + jitter };
}
let _relocSeq = Math.floor(Math.random() * 997);   // graine par process : pas la même 1re cellule à chaque respawn
async function relocateToRegion(opts = {}) {
  // Cellule TERRE tirée de la mémoire de monde (biomes non-océan/rivière, ≥256 du spawn) :
  // le quadrant hashé de V2Res4 tombait en plein OCÉAN → relocalisations inutiles en boucle
  // (vécu phase 2). Rotation déterministe par bot (_relocSeq) → zones différentes à chaque fois.
  // opts.forest (phase 3) : viser un biome À ARBRES — le kit-relocate atterrissait en plaine/
  // désert sans bois (vécu V3Res2 : gatherLog not_found ×4 même après relocate).
  const FOREST_HINTS = ['forest', 'taiga', 'jungle', 'birch', 'grove', 'wooded', 'swamp'];
  let c = null;
  try {
    const memNow = (args['wm-live'] && args['world-memory']) ? loadMemory(args['world-memory']) : bot._worldMemory;
    const w = memNow && memNow.worlds && memNow.worlds[bot._worldKey];
    let land = ((w && w.biomes) || []).filter((b) => {
      const n = String(b.name || '');
      if (!n || n.includes('ocean') || n.includes('river') || n.includes('beach')) return false;
      const ddx = b.x - 208, ddz = b.z - 528;
      return (ddx * ddx + ddz * ddz) > 256 * 256;
    });
    if (opts.forest) {
      // 1er choix : un endroit où une BÛCHE a été VUE (memory.finds, alimenté en live par les
      // material_found des autres bots) — une cellule « biome forêt » peut être pelée (vécu
      // V3Res2 : warp en forêt nominale, 158 waypoints sans un arbre).
      const logFinds = ((w && w.finds) || []).filter((f) => String(f.material || '').endsWith('_log'));
      if (logFinds.length) {
        let h = 0;
        for (const ch of String(bot.username || 'bot')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
        const pick = logFinds[(h + (_relocSeq++) * 7919) % logFinds.length];
        c = { x: pick.x, z: pick.z };
      } else {
        const wooded = land.filter((b) => FOREST_HINTS.some((hh) => String(b.name || '').includes(hh)));
        if (wooded.length) land = wooded;                // fallback : terre quelconque si aucune forêt mappée
      }
    }
    if (!c && land.length) {
      let h = 0;
      for (const ch of String(bot.username || 'bot')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      const pick = land[(h + (_relocSeq++) * 7919) % land.length];
      c = { x: pick.x + 64, z: pick.z + 64 };
    }
  } catch (e) { /* fallback quadrant */ }
  if (!c) c = regionCenter();
  emit({ type: 'resource_warp', x: c.x, z: c.z });
  // mode forêt : spread serré (48) — atterrir À CÔTÉ des arbres confirmés, pas à 120 blocs.
  const spread = opts.forest ? 48 : 120;
  try { bot.chat('/spreadplayers ' + c.x + ' ' + c.z + ' 0 ' + spread + ' false ' + bot.username); } catch (e) {}
  await sleep(5000);                                     // atterrissage + chunks
}

async function startResource() {
  // Anti-race inventaire : au spawn, les packets d'inventaire peuvent arriver APRÈS
  // startAutonomous → bestPickTier lisait un inventaire VIDE → un bot DÉJÀ équipé partait
  // en phase kit (vécu live : ResBot avec pioche diamant à errer en quête de bois).
  for (let w = 0; w < 10 && ((bot.inventory && bot.inventory.items()) || []).length === 0; w++) {
    await sleep(500);
    if (taskToken.cancelled) return;
  }
  // Phase 3 : kit SANS la chasse au fer de surface — sous anti-xray le fer exposé en surface est
  // rarissime (vécu V3Res2 : 5 goal_failed = ~25 min d'anneaux stériles). On s'arrête au FOUR
  // (pioche pierre + table + sticks + four) ; le FER vient du branch-mining à Y=16, bootstrap
  // déterministe de la boucle ressource (resource.js privilégie 'iron' tant que tier < 3).
  // Kit raté SANS pioche pierre (spawn déforesté par les runs précédents) → RELOCATE zone fraîche
  // (arbres intacts) + retry — le respawn seul rejouait le kit au même endroit stérile.
  if (bestPickTier() < 3) {
    const fullChain = chainFor('iron_pickaxe');
    const cutAt = fullChain.findIndex((g) => g.name === 'iron_ore');
    const kitChain = cutAt >= 0 ? fullChain.slice(0, cutAt) : fullChain;
    // Pré-check bois (phase 3) : le spawn est DÉFORESTÉ par les runs précédents — la 1re
    // tentative de kit y brûlait jusqu'à 8 min d'anneaux gatherLog stériles. Pas de bûche
    // visible ≤48 ET rien en poche → relocate-forêt AVANT le kit.
    try {
      const inv0 = (bot.inventory && bot.inventory.items()) || [];
      const hasWood = inv0.some((i) => i.name.endsWith('_log') || i.name.endsWith('_planks'));
      const hasTable = inv0.some((i) => i.name === 'crafting_table');
      // Du bois sera nécessaire si : pas de pioche (kit complet) OU table perdue (re-craft 3×3
      // impossible sans elle — un bot tier 2 SANS table a besoin de bois autant qu'un bot nu).
      const needsWood = (bestPickTier() < 2 || !hasTable) && !hasWood;
      if (needsWood) {
        const logIds = Object.entries((bot.registry && bot.registry.blocksByName) || {})
          .filter(([n]) => n.endsWith('_log')).map(([, d]) => d.id);
        const near = logIds.length ? bot.findBlock({ matching: logIds, maxDistance: 48 }) : null;
        if (!near) {
          emit({ type: 'resource_kit_relocate', attempt: 0, goal: 'logs' });
          await relocateToRegion({ forest: true });
          if (taskToken.cancelled) return;
        }
      }
    } catch (e) { /* best-effort */ }
    let res = { stalled: false };
    for (let attempt = 0; attempt < 3; attempt++) {
      const kitToken = { cancelled: false };
      const poll = setInterval(() => {
        if (taskToken.cancelled || bestPickTier() >= 3) kitToken.cancelled = true;
      }, 5000);
      res = await runPlanner(bot, {
        chain: kitChain,
        runSkill: (g) => runSkillWithTelemetry(g),
        ctxExtra,
        onStep: (g) => emit({ type: 'goal', name: g.name }),
      }, kitToken);
      clearInterval(poll);
      if (taskToken.cancelled) return;
      if (!res.stalled) break;                          // kit complet
      // Stall sur un but BOIS (logs/planks/table) → la zone est déforestée, quel que soit le
      // palier de pioche (vécu V3Res1/4 : tier 2 SANS table → logs not_found en boucle, la
      // relocalisation ne s'armait que pour tier<2). Autre stall avec pioche pierre → dégradé.
      const woodStall = ['logs', 'planks', 'crafting_table'].includes(res.goal);
      if (!woodStall && bestPickTier() >= 2) break;     // stall non-bois avec pioche → on tente la mine
      emit({ type: 'resource_kit_relocate', attempt: attempt + 1, goal: res.goal });
      try { await relocateToRegion({ forest: true }); } catch (e) { /* best-effort */ }
      if (taskToken.cancelled) return;
    }
    if (res.stalled) emit({ type: 'resource_kit_stalled', goal: res.goal }); // dégradé : on tente quand même
    // RAB DE SURVIE post-kit (phase 3) : une mort pendant un craft = table POSÉE perdue → chaque
    // respawn repartait en chasse au bois (l'impôt récurrent, vécu V3Res1/3 à chaque mort).
    // Tampon : planks ≥12 (3 re-crafts de table), 2e table de RECHANGE, sticks ≥16 (~8 pioches).
    try {
      const cnt = (n) => ((bot.inventory && bot.inventory.items()) || [])
        .filter((i) => i.name === n).reduce((a, i) => a + i.count, 0);
      const planksCnt = () => ((bot.inventory && bot.inventory.items()) || [])
        .filter((i) => i.name.endsWith('_planks')).reduce((a, i) => a + i.count, 0);
      if (planksCnt() < 12) {
        const log = ((bot.inventory && bot.inventory.items()) || []).find((i) => i.name.endsWith('_log'));
        if (log) { try { await craftItem(bot, { name: log.name.replace('_log', '_planks'), count: Math.ceil((12 - planksCnt()) / 4) }); } catch (e) {} }
      }
      if (cnt('crafting_table') < 2 && planksCnt() >= 8) {
        try { await craftSmart({ name: 'crafting_table', count: 1 }); } catch (e) {}
      }
      const sticks = cnt('stick');
      if (sticks < 16) await craftSmart({ name: 'stick', count: 16 - sticks });
      // ÉPÉE (phase B, vécu V3Res1 : duel zombie À LA PIOCHE perdu 6× — bestWeapon n'avait
      // rien de mieux). Une épée pierre = 2 cobble + 1 stick : la riposte devient gagnante.
      const hasSword = ((bot.inventory && bot.inventory.items()) || []).some((i) => i.name.endsWith('_sword'));
      if (!hasSword) { try { await craftSmart({ name: 'stone_sword', count: 1 }); } catch (e) {} }
    } catch (e) { /* best-effort */ }
  }
  // SPAWNPOINT post-kit (phase 3) : le spawn du monde est un LAC déforesté — chaque mort y
  // renvoyait le bot (re-nage + re-voyage ~10 min). Bot OP → ancre son respawn ICI (zone kit
  // saine, équipée). Une mort ne coûte plus que le retour à la mine.
  try { bot.chat('/spawnpoint'); emit({ type: 'command', command: '/spawnpoint', reason: 'kit_done' }); } catch (e) {}
  const quota = loadQuota();
  // Claims anti-collision (fichier partagé du groupe) — seulement si fourni par le manager.
  const claims = args.claims ? createClaims(String(args.claims), { username: bot.username }) : null;
  // Mémoire LIVE (--wm-live) : re-lecture du fichier du groupe à chaque tour d'attente —
  // les cartographes alimentent la carte PENDANT que les bots ressources minent.
  const reloadMemory = (args['wm-live'] && args['world-memory'])
    ? () => loadMemory(args['world-memory']) : null;
  const r = await runResource(bot, {
    emit,
    goto: gotoOreBounded,
    pickTier: bestPickTier,
    deposit: () => deposit(bot),
    quota,
    claims,
    reloadMemory,
    cleanup: quota ? tossJunk : null,
    mineFor: quota ? mineForType : null,
    relocate: quota ? relocateToRegion : null,
    // BORNÉ (vécu V3Res2 figé 40 min, events morts mais socket vivant — un hang dans la chaîne
    // gear/smelt/craft n'était couvert par AUCUN timeout, le watchdog physicsTick ne voit rien) :
    // même règle que tout appel mineflayer long (#42b).
    ensureGear: quota ? (async (types) => {
      const ironLeft = (() => {                          // fer quota restant → ironKeep d'ensureArmor
        try {
          const inv = (bot.inventory && bot.inventory.items()) || [];
          const have = inv.filter((i) => i.name === 'raw_iron' || i.name === 'iron_ingot').reduce((a, i) => a + i.count, 0);
          return Math.max(0, ((quota && quota.iron) || 0) - have);
        } catch (e) { return 0; }
      })();
      await withTimeout((async () => {
        await ensureGearFor(types); await ensureTorches(); await ensureArmor(ironLeft);
      })(), 240000, () => { try { stopMotion(); } catch (e) {} });
    }) : null,
    onTarget: async () => {
      if (isInWater(bot)) await escapeWater(bot, { emit });
      await settleSurvivalKit();
    },
  }, taskToken);
  if (taskToken.cancelled) return;
  // STARVED (mode quota) : kit cassé / région stérile / échecs en série — un idle ÉTERNEL ici
  // bloquait le self-healing (process vivant = pas de respawn backend, vécu Res3 55 min).
  // On SORT : le manager respawne en 15 s → kit complet re-tenté depuis un état frais.
  if (r && r.ok === false && r.reason === 'starved' && args.quota) {
    emit({ type: 'resource_exit_for_respawn', mined: (r && r.mined) || 0 });
    process.exit(2);
  }
  // Fini (carte épuisée ou vide) : objectif clos + idle propre — plus de mouvement volontaire,
  // les réflexes (manger/fuir/respirer) restent branchés. Un nouveau start relancera la boucle.
  clearObjective(world); saveWorld(worldFile, world);
  emit({ type: 'resource_idle', mined: (r && r.mined) || 0 });
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
  // keepInventory ON → rien au sol → l'aller-retour de récupération (90 s) est du pur gaspillage.
  // Heuristique : inventaire NON vide au respawn = keepInventory actif → skip (phase 3).
  const invAfterDeath = (bot.inventory && bot.inventory.items()) || [];
  if (lastDeath && Date.now() - lastDeath.t < 4 * 60 * 1000 && invAfterDeath.length === 0) {
    const d = lastDeath; lastDeath = null;
    emit({ type: 'death_recovery', x: Math.round(d.x), y: Math.round(d.y), z: Math.round(d.z) });
    await withTimeout(
      bot.pathfinder.goto(new pfGoals.GoalNear(d.x, d.y, d.z, 1)),
      90000, () => { try { stopMotion(); } catch (e) {} });
    await sleep(1500); // laisser le pickup aspirer les items au sol
  } else if (lastDeath) {
    lastDeath = null; // inventaire conservé (keepInventory) → reprise directe
  }
  if (objType === 'mapper') return startMapper(); // rôle continu : jamais « done »
  if (objType === 'resource') return startResource(); // mine les ores EXPOSÉS de la carte du groupe
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

// Bootstrap AuthMe : écoute le prompt ~3s. Login serveur configuré (--login-command) → chatte la
// commande de l'admin (secret déjà inclus, jamais émis) ; sinon self-persist : /login si pw connu,
// /register sinon (pw généré + stocké local). La décision est déléguée à resolveAuthChat (pur, testé)
// — index.js ne fait que générer/persister le pw au besoin puis brancher bot.chat sans logger la commande.
function tryAuth() {
  let pw = readPw();
  const loginCommand = readLoginCommand();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; bot.removeListener('messagestr', onMsg); resolve(); } };
    const onMsg = (msg) => {
      const kind = classifyAuthPrompt(msg);
      if (!kind) return;
      // register self-persist : génère + stocke un pw si on n'en a pas (sauf si login serveur dédié).
      if (kind === 'register' && !loginCommand && !pw) {
        pw = genPassword(); writePw(pw); emit({ type: 'auth', action: 'generated_pw' });
      }
      const decision = resolveAuthChat({ kind, loginCommand, pw });
      if (decision) {
        bot.chat(decision.chat);                       // contient le secret → jamais émis ni loggé
        emit({ type: 'auth', action: decision.action }); // event SANS la commande
        finish();
      }
    };
    bot.on('messagestr', onMsg);
    setTimeout(finish, 3000); // pas de prompt (serveur sans login) → on continue
  });
}

async function onSpawn() {
  bot._mcaProfile = profile; // expose le profil au skill explore (jitter humanisation ∝ movementJitter)
  bot._mcaStealth = HUMANIZE; // explore : jitter de déplacement humain (furtif OU humanize cartographe)
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
    moves.allowSprinting = true;    // anti-tell (paquet 1) : un humain sprinte en voyage (pathfinder gère)
    if (typeof moves.maxDropDown === 'number') moves.maxDropDown = 4; // limite les chutes profondes
    // Anti-noyade (vu live HarvT7 : drowned ×3 en trajet dirigé) : l'eau coûte CHER au pathfinder →
    // il contourne les lacs/rivières quand un chemin terrestre existe (coût fini : traverse encore
    // si c'est la SEULE option ; le réflexe oxygène de reflexes.js est le filet de sécurité).
    if (typeof moves.liquidCost === 'number') moves.liquidCost = 20;
    bot.pathfinder.setMovements(moves);
    let waterRescue = null; // évasion d'eau en cours (jamais 2 en parallèle)
    let lastWaterRescueAt = 0; // escalade : 2e rescue <5 min → warp dur (aquifère inextirpable)
    installReflexes(bot, {
      emit, fleeFrom,
      // DÉLAI DE RÉACTION humain sur les réflexes (anti aimbot 0 ms / anti-ban) — TOUJOURS actif
      // (sécurité, pas seulement en humanize) : ~300 ms par défaut (les captures ne mesurent pas
      // encore reaction.*). Coût nul sur le minage (ce n'est pas un réflexe). Cf. paquet 1.
      reactionMs: () => sampleReactionDelay(profile && profile.params),
      // RIPOSTE (phase B) : frappé par un hostile mêlée au contact → meilleure arme + pvp.
      // Le plugin poursuit la cible ; les boucles (resource/mapper) reprennent leur goto après
      // (interruption gérée comme un flee : retry/timeout).
      attack: (foe) => {
        const w = bestWeapon(bot);
        const go = () => { try { bot.pvp.attack(foe); } catch (e) {} };
        if (w) { bot.equip(w, 'hand').then(go, go); } else { go(); }
      },
      // BARBOTAGE (phase 3, vécu V3Res1/4 : 199 épisodes O2 en 30 min pendant le kit) : le
      // réflexe oxygène fait flotter mais ne SORT pas de l'eau → escapeWater global (nage
      // persistante vers la terre), quel que soit la tâche en cours.
      // ESCALADE (vécu run B : 3 bots PARALYSÉS dans des aquifères souterrains — la nage ne
      // trouve aucune terre atteignable, water_rescue re-tirait à vide ×N) : un 2e rescue en
      // <5 min = l'évasion a ÉCHOUÉ → WARP dur vers une terre fraîche (bot OP), la tâche en
      // cours se re-dérive (goto échoue → cible suivante).
      // PANIC WALL (Massii survie mobs) : PV critiques → poser des blocs sur les 4 côtés
      // (tête+pieds) pour couper le contact mêlée, puis manger. Best-effort, non bloquant.
      onPanic: () => {
        (async () => {
          try {
            const wall = ((bot.inventory && bot.inventory.items()) || [])
              .find((i) => ['cobblestone', 'cobbled_deepslate', 'dirt', 'netherrack'].includes(i.name)
                || i.name.endsWith('_planks') || i.name === 'stone' || i.name === 'deepslate');
            if (!wall || typeof bot.placeBlock !== 'function') return;
            try { bot.pathfinder && bot.pathfinder.setGoal && bot.pathfinder.setGoal(null); } catch (e) {}
            const fp = bot.entity.position.floored();
            for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
              for (const dy of [0, 1]) {
                try {
                  const ref = bot.blockAt(vec3Lib(fp.x + dx, fp.y + dy - 1, fp.z + dz));
                  if (ref && ref.boundingBox === 'block') { await bot.equip(wall, 'hand'); await bot.placeBlock(ref, vec3Lib(0, 1, 0)); }
                } catch (e) { /* face occupée → suivant */ }
              }
            }
            try { await eat(bot); } catch (e) {}
          } catch (e) { /* best-effort */ }
        })();
      },
      onWaterStuck: () => {
        if (waterRescue) return;
        const nowMs = Date.now();
        const escalate = nowMs - lastWaterRescueAt < 5 * 60 * 1000;
        lastWaterRescueAt = nowMs;
        waterRescue = (escalate
          ? (async () => {
              emit({ type: 'water_rescue_warp' });
              try { stopMotion(); } catch (e) {}
              await relocateToRegion();
            })()
          : escapeWater(bot, { emit }))
          .catch(() => {})
          .finally(() => { waterRescue = null; });
      },
    });
    // TÉLÉPORTATION (#10) : détecte tout TP (admin /tp, /home, portail, respawn) → émet
    // teleport_detected{from,to} + ABANDONNE le goal pathfinder (il visait l'ancienne position —
    // jamais y retourner à pied). Le mapper consomme le pending pour se ré-ancrer (mapper.js).
    tpWatch.anchor(bot.entity && bot.entity.position);
    wireTeleportDetection(bot, tpWatch, {
      emit,
      onTeleport: () => { try { stopMotion(); } catch (e) {} },
    });
    await tryAuth();
    bootDone = true;
  }
  // ANTI-CAMPING (phase B) : mort en rafale → on FUIT la zone du spawnpoint campé AVANT de
  // reprendre (warp terre fraîche + ré-ancrage du respawn ici). Casse les boucles zombie-camp.
  if (_escapeOnSpawn) {
    _escapeOnSpawn = false;
    emit({ type: 'death_camp_escape' });
    try { await relocateToRegion(); } catch (e) { /* best-effort */ }
    try { bot.chat('/spawnpoint'); } catch (e) {}
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
  // stop-pour-répondre (paquet 1) : on fige aussi le BRAS (un humain lâche le clic pour taper).
  try { if (bot.targetDigBlock && bot.stopDigging) bot.stopDigging(); } catch (e) {}
  ['forward', 'back', 'left', 'right', 'sneak', 'jump', 'sprint'].forEach((c) => { try { bot.setControlState(c, false); } catch (e) {} });
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
      // explore:true : un take ORDONNÉ peut voyager (biais dirigé via la carte du groupe si la
      // ressource est connue, sinon anneaux bornés ≤256). Annulable par `stop` comme toute tâche.
      const r = await gather(bot, { ...a, explore: true }, token);
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
      if (STEALTH) {
        // furtif : « stop = vivant » (loiter anti-tell, piège #40)
        taskCtl.begin('loiter', () => {});
        taskCtl.setCleanup(loiter(bot, profile));
      } else {
        // utilitaire (défaut phase 3) : stop = immobile net, zéro geste parasite
        taskCtl.cancel();
        stopMotion();
      }
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
  // STOP-POUR-RÉPONDRE (spec cartographes) : on s'arrête DÈS qu'on nous adresse la parole —
  // pendant la « réflexion » (LLM) et la « frappe » (latence humanisée) le bot reste immobile
  // (_convoPauseUntil gèle les prochains gotos des boucles), puis reprend après l'envoi.
  if (HUMANIZE) {
    _convoPauseUntil = Date.now() + 15000;            // borne dure (libérée à l'envoi)
    try { stopMotion(); } catch (e) {}
  }
  try {
    const history = memory.history(username);
    const decision0 = await think(client, { state: snapshot(bot), message, model, limiter, profile, commandDocs, trustDocs, sender: username, history, lang });
    if (!decision0) { emit({ type: 'info', message: 'rate-limited' }); return; }
    const decision = gateDecision(decision0, username, policy.trusted);
    if (decision !== decision0) { emit({ type: 'order_refused', from: username }); }
    if (decision.reply) {
      // Humanisé : latence naturelle + typos + STOP-POUR-RÉPONDRE (on lâche les touches le
      // temps de taper — la tâche reprend seule : son goto interrompu re-path). Sinon
      // (utilitaire pur) : réponse immédiate, verbatim, sans s'arrêter.
      const { text, delayMs } = HUMANIZE
        ? humanizeReply(profile, decision.reply)
        : { text: String(decision.reply), delayMs: 0 };
      if (HUMANIZE) { try { stopMotion(); } catch (e) {} }
      if (delayMs > 0) await sleep(delayMs);
      if (text) { replyTo(reaction, text); emit({ type: 'say', message: text, private: reaction.private, to: reaction.to }); }
      if (HUMANIZE) _convoPauseUntil = Date.now();     // message parti → on reprend la route
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
  if (p) lastDeath = { x: p.x, y: p.y, z: p.z, t: Date.now() };
  deathTimes.push(Date.now());
  deathTimes = deathTimes.filter((t) => Date.now() - t < 10 * 60 * 1000);
  // ANTI-CAMPING (phase B, vécu V3Res1 : zombie campé sur le spawnpoint = 6 morts en 51 s,
  // et l'ancienne pause à 3 morts le laissait IDLE en punching-ball) : 2 morts en <60 s →
  // au prochain spawn, WARP ailleurs + ré-ancrage du spawnpoint (le camping est cassé net).
  const burst = deathTimes.filter((t) => Date.now() - t < 60000).length;
  if (burst >= 2) _escapeOnSpawn = true;
  // Garde-fou ultime (relevé 3→5 : le warp anti-camping gère les boucles courtes) :
  // 5 morts / 10 min → pause objectif + notifie (le self-healing backend reprendra).
  if (deathTimes.length >= 5) {
    taskCtl.cancel();
    if (world.objective) { world.objective.status = 'paused'; saveWorld(worldFile, world); }
    emit({ type: 'autonomous_stalled', reason: 'death_loop' });
  }
});
bot.on('kicked', (reason) => emit({ type: 'error', message: 'kicked: ' + reason }));
bot.on('error', (e) => emit({ type: 'error', message: String((e && e.message) || e) }));
bot.on('end', () => { emit({ type: 'status', state: 'disconnected' }); process.exit(0); });

// Watchdog ANTI-JAM (Massii, vécu V3Res1 : SAUT INFINI contre un mur de 2 — zéro progrès
// horizontal avec un goal pathfinder actif, sans dig en cours) : position quasi inchangée
// ≥18 s pendant un goto → coupe le saut, CREUSE les blocs qui barrent (tête/pieds/au-dessus,
// s'ils sont minables) puis stopMotion → la tâche re-path/re-dérive. Couvre aussi les
// cartographes figés en jambe (même signature). Jamais pendant un dig (immobile = légitime).
let _jamSample = null;
setInterval(async () => {
  try {
    if (!bot.entity || !bot.entity.position) return;
    const p = bot.entity.position;
    const digging = !!bot.targetDigBlock;
    const hasGoal = !!(bot.pathfinder && bot.pathfinder.goal);
    const now = Date.now();
    if (!hasGoal || digging) { _jamSample = null; return; }
    if (!_jamSample) { _jamSample = { x: p.x, z: p.z, t: now }; return; }
    const d = Math.sqrt((p.x - _jamSample.x) ** 2 + (p.z - _jamSample.z) ** 2);
    if (d >= 0.8) { _jamSample = { x: p.x, z: p.z, t: now }; return; }   // ça avance → resample
    if (now - _jamSample.t < 18000) return;                              // pas encore un jam
    _jamSample = null;
    emit({ type: 'unjam', x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
    try { bot.setControlState('jump', false); } catch (e) {}
    const yaw = (bot.entity && bot.entity.yaw) || 0;
    const jdx = Math.round(-Math.sin(yaw)), jdz = Math.round(Math.cos(yaw));
    for (const dy of [1, 0, 2]) {                                        // tête, pieds, au-dessus
      try {
        const b = bot.blockAt(vec3Lib(Math.floor(p.x) + jdx, Math.floor(p.y) + dy, Math.floor(p.z) + jdz));
        if (b && b.boundingBox === 'block'
            && (typeof bot.canDigBlock !== 'function' || bot.canDigBlock(b))) {
          const tool = bestToolFor(bot, b);
          if (tool) { try { await bot.equip(tool, 'hand'); } catch (e) {} }
          await bot.dig(b);
        }
      } catch (e) { /* best-effort */ }
    }
    try { stopMotion(); } catch (e) {}                                   // le goto rejette → re-path
  } catch (e) { /* watchdog : ne crash jamais */ }
}, 6000);

// Watchdog connexion : un « Timed out » côté serveur peut laisser le socket client MUET sans
// event 'end' (vécu phase 2 : bot zombie, quota figé, jamais respawné). Pas de physicsTick
// pendant 90 s → on se suicide proprement, le manager auto-respawne la session resource.
let _lastTick = Date.now();
bot.on('physicsTick', () => { _lastTick = Date.now(); });
setInterval(() => {
  if (Date.now() - _lastTick > 90000) {
    emit({ type: 'error', message: 'connection_watchdog: 90s sans tick' });
    process.exit(1);
  }
}, 30000);

// TIMER ARMURE (Massii survie #1) : ensureArmor était appelé au HAUT de la boucle resource, qui
// n'itère quasi jamais (le bot passe ~tout son temps DANS mineForType/branchMine ≤900s) → 0 armure
// craftée live malgré le fer plein. Timer INDÉPENDANT : toutes les 90 s, hors dig, en session
// resource, si une pièce d'armure manque et que le fer dépasse le buffer → en craft/équipe UNE.
// Borné, best-effort, jamais throw ; n'interrompt pas un dig en cours (immobile = légitime).
let _armorBusy = false;
setInterval(async () => {
  try {
    if (_armorBusy) return;
    if ((world.objective && world.objective.type) !== 'resource') return;
    if (bot.targetDigBlock) return;                       // pas en plein minage
    if (taskToken && taskToken.cancelled) return;
    const worn = _wornArmor();
    if (ARMOR_PIECES.every((pc) => worn.has(pc.name))) {  // set complet → équipe juste un éventuel reliquat
      const sh = ((bot.inventory && bot.inventory.items()) || []).find((i) => i.name === 'shield');
      if (sh) { try { await bot.equip(sh, 'off-hand'); } catch (e) {} }
      return;
    }
    const ironLeft = (() => {
      try {
        const inv = (bot.inventory && bot.inventory.items()) || [];
        const have = inv.filter((i) => i.name === 'raw_iron' || i.name === 'iron_ingot').reduce((a, i) => a + i.count, 0);
        const q = loadQuota() || {};
        return Math.max(0, ((q && q.iron) || 0) - have);
      } catch (e) { return 0; }
    })();
    _armorBusy = true;
    await withTimeout(ensureArmor(ironLeft), 150000, () => { try { stopMotion(); } catch (e) {} });
  } catch (e) { /* timer : ne crash jamais */ }
  finally { _armorBusy = false; }
}, 90000);

// ── Anti-tell motricité (paquet 1) : BRUIT DE VISÉE au repos — un humain ne fige jamais sa tête
// (vraies captures : la vue « respire » même à l'arrêt, figé strict ~0 %). Dérive DOUCE (nextLook
// mode idle : micro-mouvements + rares petits coups d'œil, AUCUN geste brusque — exigence Massii).
// UNIQUEMENT si humanisé ET inactif : pas pendant un dig (vise le bloc), un déplacement (pathfinder
// mène la visée) ou un combat (pvp vise). Mode utilitaire pur (resource souterrain, non vu) = OFF.
// force=false → bot.look interpole à vitesse de souris finie (pas de snap).
if (HUMANIZE) {
  setInterval(() => {
    try {
      if (!bot.entity) return;
      if (bot.targetDigBlock) return;
      if (bot.pathfinder && bot.pathfinder.goal) return;
      if (bot.pvp && bot.pvp.target) return;
      const cur = { yaw: bot.entity.yaw || 0, pitch: bot.entity.pitch || 0 };
      const nx = nextLook(cur, (profile && profile.params) || {}, Math.random, { mode: 'idle' });
      bot.look(nx.yaw, nx.pitch, false);
    } catch (e) { /* best-effort : ne crash jamais */ }
  }, 180 + Math.floor(Math.random() * 120)); // ~180-300 ms : cadence de micro-ajustement humaine
}

onCommand((cmd) => {
  if (cmd.type === 'say') say(bot, cmd.message);
  else if (cmd.type === 'quit') bot.quit();
  // Re-balance multi-cartographes : le manager re-pousse {index,count} quand N change dans le groupe.
  // Lu live par runMapper via getSector() → effet au prochain batch (pas de redémarrage).
  else if (cmd.type === 'sector' && cmd.count >= 1) {
    mapperSector = { index: Number(cmd.index) || 0, count: Number(cmd.count) };
    emit({ type: 'sector_set', index: mapperSector.index, count: mapperSector.count });
  }
  // Déclenchement autonome DIFFÉRÉ (tests live / manager) : connecter le bot idle, le positionner
  // (tp), PUIS lancer l'objectif depuis sa position courante (objectif explicite sinon --objective).
  else if (cmd.type === 'start') {
    if (cmd.objective) { setObjective(world, { type: String(cmd.objective), status: 'in_progress' }); saveWorld(worldFile, world); }
    startAutonomous(null);
  }
  // Ordre direct injecté par le harness/manager (même chemin déterministe que le /msg joueur).
  else if (cmd.type === 'order' && cmd.text) {
    const order = parseOrder(String(cmd.text));
    if (order) executeOrder(order, cmd.sender || 'console').catch((e) => emit({ type: 'error', message: String((e && e.message) || e) }));
    else emit({ type: 'error', message: 'order non reconnu: ' + cmd.text });
  }
});
