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
const { loadStyle } = require('./style');   // capture-clone : params humains depuis style.json (--style)
const { loadClips, createClipPlayer } = require('./clips');   // capture-clone : rejeu motricité (--clips)
const { humanAimSwing, jitterLook } = require('./aim');   // capture-clone (E) : swing + wobble de visée humain
const { loadProfile } = require('./profiles');
const { say } = require('./skills/say');
const { follow } = require('./skills/follow');
const { goto } = require('./skills/goto');
const { mineBlock, collectWood } = require('./skills/mineBlock');
const { attackNearest } = require('./skills/attackNearest');
const { fleeFrom, isFleeHostile } = require('./skills/fleeFrom');
const { installReflexes } = require('./reflexes');
const { decideReaction } = require('./triggers');
const { loadCommands, isAllowed, buildCommandDocs } = require('./commands');
const { loadPolicy, isTrusted, parseTpRequest, parseTradeRequest, gateDecision, buildTrustDocs } = require('./trust');
const { parseOrder } = require('./orders');
const { createTaskController } = require('./tasks');
const { createMemory } = require('./memory');
const { bestWeapon, bestToolFor } = require('./tools');
const { shouldSprint } = require('./movement');   // sprint « vrai joueur » ON par défaut (Massii 2026-06-22)
const vec3Lib = require('vec3'); // watchdog anti-jam (blocs barrants)
const { gather, woodExpeditionCount } = require('./skills/gather');
const { mineDown } = require('./skills/mineDown');
const { guard } = require('./skills/guard');
const { giveItem, giveAll } = require('./skills/give');
const { craftItem } = require('./skills/craft');
const { deposit } = require('./skills/deposit');
const { equipItem, eat } = require('./skills/equip');
const { loiter } = require('./skills/loiter');
const fs = require('fs');
const { runPlanner } = require('./planner');
const { chainFor, buildCtxInv, firstUnmet, cookedCount, armorNeed } = require('./goals');
const { isForbiddenCheat } = require('./nogive');
const homewarp = require('./homewarp'); // couche warp LÉGITIME sans-give (/sethome+/home ; goSpawn=/home safe)
const { secureSpot } = require('./skills/secureSpot'); // secure-then-warp : pilier/se murer/flotter AVANT le /home
const { SCAFFOLD } = require('./skills/pillarUp');     // blocs sacrifiables (comptés pour la tactique)
const { huntPassive } = require('./skills/hunt');
const { nearestPassive, survivalTick, nearbyHostiles, lavaNearby } = require('./survival');
const { loadWorld, saveWorld, setObjective, clearObjective } = require('./worldModel');
const { _nearestTable } = require('./skills/craft'); // craftItem déjà importé plus haut
const { placeBlockNear } = require('./skills/placeBlockNear');
const { smelt } = require('./skills/smelt');
const { descendDiagonal } = require('./skills/descendDiagonal');
const { branchMine, floodFillVein } = require('./skills/branchMine');
const { classifyAuthPrompt, genPassword, resolveAuthChat } = require('./auth');
const { loadMemory, worldKey, resolveBiome } = require('./worldMemory');
const { driestCell, oreBase } = require('./ores');         // warp near-spawn DRY-AWARE + normalisation type (fix #8)
const { recordAnchor, pickDryAnchor } = require('./anchors'); // ancres profondes SÈCHES (anti boucle de noyade)
const { runMapper } = require('./mapper');
const { LOCATE_KINDS, parseLocateResponse, structureFoundEvent } = require('./structures');
const { isInWater, escapeWater, findLandTarget, isFloatingStuck, recoverFloating, isFrozenDesync } = require('./unstuck');
const deathzones = require('./deathzones'); // ban-zone des camps de mort (≥2 alertes → fuite active)
const { recordOceanStuck } = require('./oceanEscalate'); // baie humide PERSISTANTE → relocate forcé (live 22/06 ResBot1)
const { recordJam } = require('./jamEscalate'); // JAM persistant au MÊME endroit → relocate forcé (live 22/06 SOIR ResBot2)
const { runResource } = require('./skills/resource');
const { planSmeltRaw } = require('./bank');   // fonte périodique du brut or/fer → lingots bankables
const { tunnelTo } = require('./skills/tunnelTo');
const { junkItems, ITEMS_FOR } = require('./quota');
const { Y_OPT, pickaxePlan, armorPlan, ARMOR_PIECES, bestArmorToEquip, armorUpgradePlan, isMinimallyArmored, shieldPlan, smeltPlan, smeltReady } = require('./gear');
// Torche tous les N paliers de branch-mine (mob-aware phase B) — best-effort : sans torche
// en poche le minage continue sans (zéro coût en peaceful, sécurité en non-pacifique).
const TORCH_EVERY = 8;
const { createClaims, createPresence } = require('./claims');
const { pickMapperTp } = require('./mapperTp'); // TP-au-mappeur : à qui demander le /tpa (décision pure)
const { tierRank } = require('./tools');
const { createTeleportWatcher, wireTeleportDetection } = require('./teleport');
const { isNight, shelterUntilDawn, shouldShelter } = require('./skills/shelter');
const { maybeRunKit } = require('./kit');   // survie mappeur : /kit serveur au démarrage/respawn (décision pure)
const { needDirtBuffer } = require('./dirt');   // survie mappeur : buffer de blocs posables pour sceller l'abri
const { panicWall } = require('./skills/panicWall');

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { o[argv[i].slice(2)] = argv[i + 1]; i++; }
  }
  return o;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const args = parseArgs(process.argv.slice(2));
// Mode SANS-GIVE (run nether 2026-07-13) : AUCUNE triche serveur — le bot mine/fond/crafte TOUT.
// --no-give 1 → (1) provisionStartKit/ensureFood ne /give plus RIEN, (2) filtre dur sur bot.chat
// (isForbiddenCheat) qui bloque tout /give //tp //effect… résiduel (défense en profondeur).
const NO_GIVE = args['no-give'] === '1' || args['no-give'] === 'true';
// Confinement arène (--confine "X Z R") : garde le bot dans R de l'ancre sèche (cf. confine.js).
const { parseConfine, confineSpreadCommand } = require('./confine');
const CONFINE = parseConfine(args['confine']);
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

// Capture-clone (étape B) : --style <style.json> distillé d'un VRAI joueur → params humains
// (reaction réelle / lookJitter / chat) qui REMPLACENT les défauts du profil pour l'humanisation.
// Sans --style → styleParams=null → humanizeParams = profil (comportement EXACTEMENT inchangé).
const styleParams = loadStyle(args.style);
const humanizeParams = styleParams || (profile && profile.params) || {};
if (styleParams) emit({ type: 'style_loaded', player: styleParams._player, reaction: styleParams.reaction, lookJitter: styleParams.lookJitter });
// Capture-clone (étape D) : --clips <dir> distillé → rejeu de la MOTRICITÉ humaine réelle (Δyaw/Δpitch
// par contexte) sur la visée. Sans --clips → clipPlayer=null → nextLook (modèle) inchangé.
const _clipsByCtx = loadClips(args.clips);
const clipPlayer = (args.clips && Object.keys(_clipsByCtx).length) ? createClipPlayer(_clipsByCtx) : null;
if (clipPlayer) emit({ type: 'clips_loaded', ctxs: Object.keys(_clipsByCtx) });
// Capture-clone (étape E) : visée d'ACQUISITION humaine. ON ssi --style/--clips → les look-ats
// DÉLIBÉRÉS de notre code (demi-tours, faire face à un joueur) deviennent des SWINGS humains
// (anti snap-aim, tell n°1) au lieu d'un bot.look instantané. OFF → comportement EXACTEMENT inchangé.
// (Visées INTERNES des plugins — pvp.attack re-track, collectBlock pour le dig, pathfinder pour la
//  marche — restent gérées par eux : frontière clone-hybride documentée dans le rapport.)
const humanAim = !!(clipPlayer || styleParams);
const _aimJitterDeg = (humanizeParams && humanizeParams.lookJitter ? humanizeParams.lookJitter : 0.15) * 20;
// Helper : tourne la caméra vers (yaw,pitch) en swing humain si humanAim, sinon snap instantané.
// `bot` est capturé par closure (créé plus bas, à l'appel `bot` existe). clipCtx → motricité réelle.
async function aimSwingTo(yaw, pitch, clipCtx) {
  if (humanAim) {
    let clipFrames = null;
    if (clipPlayer && clipCtx) { const c = clipPlayer.next(clipCtx); if (c && Array.isArray(c.frames)) clipFrames = c.frames; }
    try { await humanAimSwing(bot, { yaw, pitch }, { jitterDeg: _aimJitterDeg, clipFrames }); return; } catch (e) {}
  }
  try { await bot.look(yaw, pitch, true); } catch (e) {}
}
// yaw/pitch pour faire face à un point (MÊME formule que mineflayer bot.lookAt → signe pitch correct).
function entityYawPitch(toPos) {
  const e = bot.entity; if (!e || !e.position) return null;
  const ex = e.position.x, ey = e.position.y + (e.height || 1.62), ez = e.position.z;
  const dx = toPos.x - ex, dy = toPos.y - ey, dz = toPos.z - ez;
  const ground = Math.sqrt(dx * dx + dz * dz);
  return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, ground) };
}

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
// Rôle MAPPEUR (seedé par le backend dans le world file) : combat fuite-d'abord + riposte au contact only.
const IS_MAPPER = !!(world && world.objective && world.objective.type === 'mapper');
let taskToken = { cancelled: true };
let deathTimes = [];
let _escapeOnSpawn = false; // anti-camping : 2 morts <60 s → warp + re-spawnpoint au prochain spawn
let _safeHomeSet = false;     // warp légitime : /sethome safe posé (fallback = position de spawn courante)
let _safeHomeSurface = false; // safe posé à une VRAIE surface (y≥58) → cible idéale pour goSpawn
let _deathArmed = false;      // watchdog PV : lieu de mort marqué (/sethome death) → post-respawn goHome('death')+ramassage
let _wsiteMineSet = false;    // NO_GIVE : chantier profond SEC mémorisé (/sethome wsite) → re-descente = /home wsite (1 tp)
                              // au lieu de re-creuser ~52 blocs (chaque re-descente cassait une pioche → no_pickaxe → fer jamais accumulé, vécu homedeath)
let _drySteerTries = 0;       // NO_GIVE : marches tentées vers la cellule 128 sèche (arrivée VÉRIFIÉE, ≤3 —
                              // vécu live NethBot2 : goto interrompu par un réflexe → « arrivé » à 180 blocs
                              // de la cible avec l'ancien one-shot → descente en zone humide quand même)
let _deathMark = null;        // dernière position marquée death {x,y,z,at} → dédup anti-spam du watchdog
let _imminentBusy = false;    // anti-rafale : un seul warp de sauvetage PV à la fois
let _homeRefusedAt = {};      // RC3 : refus TP Essentials par home {safe|wsite|death → ts} — un /home
                              // refusé (« destination unsafe », monde noyé) ne téléporte PAS : sans ça
                              // le filet de secours était un no-op silencieux (zombie 1.8 PV, vécu NethBot2)
// Le /home safe est-il inutilisable en ce moment (refus récent, pas encore re-posé) ?
function safeWarpDown() {
  return !!(_homeRefusedAt.safe && (Date.now() - _homeRefusedAt.safe) <= homewarp.REFUSAL_DEGRADE_MS);
}
let _tpCancelledAt = 0;       // secure-then-warp : dernière annulation Essentials vue (teleport-delay)
let presence = null;          // heartbeat de présence du groupe (positions-<group>.json, --positions)
let _lastMapperTpAt = 0;      // TP-au-mappeur : cooldown (1 tentative / 4 min)
let _dzones = [];             // camps de mort : zones où ≥2 alertes « mort imminente » (deathzones.js)
let _safeHomePos = null;      // coords du dernier /sethome safe (pour fuir VERS lui si hors zone bannie)
let _posSamples = [];         // desync-watchdog : échantillons de position (30 s × 10 = 5 min)
let _stillBusy = false;       // immobilité LÉGITIME en cours (fonte au four, abri nocturne) — gate desync
let _smeltOppBusy = false;    // fonte opportuniste : une seule passe à la fois

// Attend l'atterrissage d'un /home : saut de position >16 blocs = warpé ; message « cancelled »
// (teleport-delay : le bot a bougé/pris un coup pendant le warmup) = échec explicite ; sinon
// timeout. Remplace les sleep(3000) aveugles — plus RAPIDE sur serveur direct (delay 0 : sort dès
// le saut détecté) et plus COUVRANT sur serveur à warmup 5 s (attend jusqu'à 9 s).
async function awaitWarp(opts = {}) {
  const maxMs = opts.maxMs || 9000;
  const from = bot.entity && bot.entity.position && bot.entity.position.clone
    ? bot.entity.position.clone() : null;
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    await sleep(300);
    if (_tpCancelledAt > t0) return { warped: false, cancelled: true };
    const p = bot.entity && bot.entity.position;
    if (from && p && Math.hypot(p.x - from.x, p.y - from.y, p.z - from.z) > 16) return { warped: true };
  }
  return { warped: false };
}

// FUITE d'un camp de mort fraîchement banni : vers le home safe s'il est HORS de la zone (warp
// sécurisé), sinon à PIED 90 blocs dans une direction aléatoire (mieux que rester sous les coups).
// Fire-and-forget depuis le watchdog imminent — best-effort, les réflexes couvrent la course.
async function fleeDeathCamp(fromPos) {
  const now = Date.now();
  if (_safeHomePos && !deathzones.isBanned(_dzones, _safeHomePos.x, _safeHomePos.z, now)) {
    emit({ type: 'death_camp_flee', via: 'home_safe' });
    await safeWarpHome('safe');
    return;
  }
  const ang = Math.random() * Math.PI * 2;
  const tx = Math.round(fromPos.x + Math.cos(ang) * 90);
  const tz = Math.round(fromPos.z + Math.sin(ang) * 90);
  emit({ type: 'death_camp_flee', via: 'foot', x: tx, z: tz });
  try { stopMotion(); } catch (e) {}
  try {
    await withTimeout(bot.pathfinder.goto(new pfGoals.GoalNear(tx, Math.round(fromPos.y), tz, 4)),
      90000, () => { try { stopMotion(); } catch (e) {} });
  } catch (e) { /* best-effort */ }
}

// TP-AU-MAPPEUR : demande /tpa vers le mappeur choisi par pickMapperTp (frais, qui rapproche de
// la cible d'au moins 150 blocs — ou le plus loin de moi sans cible). L'acceptation est automatique
// côté mappeur (policy.group_bots) ; l'atterrissage est détecté par awaitWarp (warmup couvert).
// Échec (pas de candidat, /tpa non coché, refus, timeout) = on continue À PIED, jamais bloquant.
async function tryTpToMapper(goal) {
  if (!presence) return { ok: false, reason: 'no_presence' };
  if (Date.now() - _lastMapperTpAt < 240000) return { ok: false, reason: 'cooldown' };
  const p = bot.entity && bot.entity.position;
  if (!p) return { ok: false, reason: 'no_pos' };
  const pick = pickMapperTp({
    self: { x: p.x, z: p.z }, selfName: bot.username,
    goal: goal || null, mappers: presence.list(), now: Date.now(),
  });
  if (!pick) return { ok: false, reason: 'no_candidate' };
  if (!isAllowed('/tpa ' + pick.name, whitelist)) {
    emit({ type: 'mapper_tpa_blocked', to: pick.name });   // /tpa pas coché dans le profil serveur
    return { ok: false, reason: 'not_whitelisted' };
  }
  _lastMapperTpAt = Date.now();
  emit({ type: 'mapper_tpa', to: pick.name, gain: pick.gain });
  try { stopMotion(); } catch (e) {}
  try { bot.chat('/tpa ' + pick.name); } catch (e) { return { ok: false, reason: 'chat_failed' }; }
  const r = await awaitWarp({ maxMs: 15000 });   // acceptation (~2 s) + éventuel warmup teleport-delay
  emit({ type: 'mapper_tpa_result', to: pick.name, warped: !!r.warped });
  return { ok: !!r.warped };
}

// Warp de secours COMPLET (secure-then-warp, Massii 15/07) : se mettre en sécurité (pilier / se
// murer / flotter) AVANT le /home — sur les serveurs à teleport-delay, le TP est annulé si on
// bouge/prend un coup pendant le warmup ~5 s, et nos secours partent précisément sous les coups.
// Best-effort intégral : un échec de mise en sécurité n'empêche jamais le warp ; 1 retry si annulé.
async function safeWarpHome(name, opts = {}) {
  const state = {
    inWater: (function () { try { return isInWater(bot); } catch (e) { return false; } })(),
    hostiles: (function () { try { return nearbyHostiles(bot, 8).length; } catch (e) { return 0; } })(),
    blocks: (function () {
      try { return bot.inventory.items().filter((i) => SCAFFOLD.includes(i.name)).reduce((s, i) => s + i.count, 0); } catch (e) { return 0; }
    })(),
    headroom: (function () {
      try {
        const f = bot.entity.position.floored();
        return [2, 3, 4].every((dy) => { const b = bot.blockAt(f.offset(0, dy, 0)); return !b || b.boundingBox !== 'block'; });
      } catch (e) { return false; }
    })(),
  };
  const tactic = opts.tactic || homewarp.secureTactic(state);
  if (tactic !== 'none') {
    try { stopMotion(); } catch (e) {}
    try { await withTimeout(secureSpot(bot, tactic, { token: taskToken, emit }), 6000, () => {}); } catch (e) {}
  }
  try { stopMotion(); } catch (e) {}    // IMMOBILE pendant l'éventuel warmup (sinon annulation)
  homewarp.goHome(bot, name);
  let r = await awaitWarp(opts);
  if (!r.warped && r.cancelled) {       // annulé (coup reçu/mouvement) → re-sécuriser + 1 retry
    emit({ type: 'safe_warp_retry', name, tactic });
    try { await withTimeout(secureSpot(bot, tactic === 'none' ? 'seal' : tactic, { token: taskToken, emit }), 6000, () => {}); } catch (e) {}
    try { stopMotion(); } catch (e) {}
    homewarp.goHome(bot, name);
    r = await awaitWarp(opts);
  }
  if (tactic === 'float') { try { bot.setControlState('jump', false); } catch (e) {} }
  emit({ type: 'safe_warp', name, tactic, warped: !!r.warped });
  return r;
}
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
  // worn : pièces d'armure PORTÉES (slots 5-8, absentes de inventory.items()) — les chaînes armure
  // (iron_armor/diamond_armor) en ont besoin pour leurs prédicats armorNeed/armorWornOk.
  return { hasTable: !!_nearestTable(bot), y: pos ? pos.y : undefined, worn: [..._wornArmor()] };
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
  _stillBusy = true;    // immobilité LÉGITIME (poll du four ≤3 min) — le desync-watchdog ne doit pas tirer
  try { return await _smeltWithFurnaceInner(input, output, count, fuelOverride); }
  finally { _stillBusy = false; }
}
async function _smeltWithFurnaceInner(input, output, count, fuelOverride) {
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
  // ARMURE-AVANT-PROFONDEUR pour le chemin planner (chaîne diamant + kit mappeur, hole A §1.3) :
  // avant une descente/branche, tente armure+bouclier (best-effort, borné, idempotent si déjà armé).
  if (goal.skill === 'descendDiagonal' || goal.skill === 'branchMine') {
    try { await withTimeout(armorUp(), 120000, () => { try { stopMotion(); } catch (e) {} }); } catch (e) {}
    // Sans-give : chasse best-effort AVANT la descente (bornée 90 s, jamais bloquante — cf. goals.js,
    // le but food_stock bloquant stallait à vie sur no_prey). Surface seulement.
    if (NO_GIVE && goal.skill === 'descendDiagonal') {
      const _y = bot.entity && bot.entity.position ? bot.entity.position.y : 0;
      if (_y >= 45 && cookedCount(buildCtxInv(bot)) < 4) {
        try { await withTimeout(huntCookGoal(4), 90000, () => { try { stopMotion(); } catch (e) {} }); } catch (e) {}
      }
      // ⭐ Steering STRATÉGIQUE vers le SEC (mur de l'eau, run water-wall) : descendre « où on
      // est » en zone aquifère = fuite permanente = 0 minage (vécu homedeath : smelt:0 après des
      // heures à Y16 — l'évitement TACTIQUE de l'eau ne suffit pas). La carte du groupe (mappers)
      // connaît les cellules 128 SÈCHES riches du minerai cible → on MARCHE (pathfinder,
      // no_give-légal — /tp bloqué) vers la meilleure AVANT la 1re descente ; ensuite le wsite
      // (53ca041) ancre le chantier sec pour toutes les re-descentes. Une tentative par session :
      // échec → on descend sur place (comportement historique inchangé).
      if (_drySteerTries < 3 && !_wsiteMineSet && bot.entity && bot.entity.position) {
        try {
          const memDS = (args['wm-live'] && args['world-memory']) ? loadMemory(args['world-memory']) : bot._worldMemory;
          const wkDS = String(bot._worldKey || '');
          const wDS = memDS && memDS.worlds && (memDS.worlds[wkDS] || memDS.worlds[wkDS.replace(/^minecraft:/, '')]);
          const pDS = bot.entity.position;
          const matDS = (goal.args && typeof goal.args.targetY === 'number' && goal.args.targetY < 0) ? 'diamond' : 'iron';
          // range 224 (cycle 2 water-wall) : à 600, la cellule élue pouvait être à 350+ blocs →
          // marche infaisable à pied (3× dry_steer_failed short, morts en route, death_loop — vécu
          // live NethBot2). 224 ≈ 2 cellules : atteignable en ~1 goto ; au-delà on descend sur place.
          const cellDS = (wDS && Array.isArray(wDS.ores))
            ? driestCell(wDS.ores, { base: { x: pDS.x, z: pDS.z }, range: 224, cellSize: 128, minOres: 12, material: matDS })
            : null;
          // > 20 % wet = pas mieux qu'ici → pas de marche pour rien (on descend sur place).
          if (cellDS && cellDS.wetFraction <= 0.2) {
            _drySteerTries++;
            emit({ type: 'dry_steer', x: cellDS.x, z: cellDS.z, wet: Math.round(cellDS.wetFraction * 1000) / 1000, material: matDS, try: _drySteerTries });
            try {
              await withTimeout(bot.pathfinder.goto(new pfGoals.GoalNearXZ(cellDS.x, cellDS.z, 12)), 300000,
                () => { try { stopMotion(); } catch (e) {} });
            } catch (e) { /* jugé sur la DISTANCE réelle ci-dessous, pas sur la promesse */ }
            if (isInWater(bot)) { try { await escapeWater(bot, { emit }); } catch (e) {} }
            // Arrivée VÉRIFIÉE (un réflexe/watchdog peut résoudre le goto à mi-chemin) : à >24 blocs
            // de la cible, on NE descend PAS ici (zone humide probable) → échec doux, le planner
            // re-tente descend_y16 et la marche REPREND d'où on est (jusqu'à 3 tentatives).
            const pArr = bot.entity && bot.entity.position;
            const dArr = pArr ? Math.hypot(pArr.x - cellDS.x, pArr.z - cellDS.z) : Infinity;
            if (dArr <= 24) {
              _drySteerTries = 3;                       // arrivé → plus de steering ce run
              emit({ type: 'dry_steer_arrived', x: Math.round(pArr.x), z: Math.round(pArr.z) });
            } else {
              emit({ type: 'dry_steer_failed', reason: 'short', dist: Math.round(dArr), try: _drySteerTries });
              if (_drySteerTries < 3) return { ok: false, reason: 'dry_steer_short' };
            }
          } else {
            _drySteerTries = 3;                         // pas de cellule sèche mappée → comportement historique
          }
        } catch (e) { /* best-effort : sans carte/cellule, descente sur place comme avant */ }
      }
      // Aquifère re-percé en boucle (vécu NethBot2 : ocean_stuck, descend_y16→water_ahead au même
      // bord de lac) : après un échec EAU, se DÉCALER à pied 30-50 blocs (direction aléatoire)
      // avant de re-creuser — marcher, pas de warp (sans-give).
      if (_descendWaterFails > 0 && bot.entity && bot.entity.position) {
        const _ang = Math.random() * Math.PI * 2;
        const _d = 30 + Math.random() * 20;
        const _p = bot.entity.position;
        const _tx = Math.round(_p.x + Math.cos(_ang) * _d);
        const _tz = Math.round(_p.z + Math.sin(_ang) * _d);
        emit({ type: 'descend_relocate', x: _tx, z: _tz, fails: _descendWaterFails });
        try { await withTimeout(bot.pathfinder.goto(new pfGoals.GoalNear(_tx, Math.round(_p.y), _tz, 3)), 60000, () => { try { stopMotion(); } catch (e) {} }); } catch (e) {}
      }
    }
  }
  if (goal.skill === 'gatherLog') {
    // armor_fuel (fix n°4 water-wall) : CHARBON d'abord quand une pioche est en poche — 1 charbon
    // fond 8 items (vs bûche 1.5) et le charbon ne dépend PAS des forêts (vécu live NethBot3 :
    // boucle explore_directed sur la MÊME forêt apprise déjà PELÉE par 20 sessions → not_found ×28
    // à un craft de T1). Borné 120 s → il reste tout le budget du skill pour le repli bois.
    if (goal.name === 'armor_fuel' && ((bot.inventory && bot.inventory.items()) || []).some((i) => i.name.endsWith('_pickaxe'))) {
      let rc = null;
      try {
        rc = await withTimeout(gather(bot, { name: ['coal_ore', 'deepslate_coal_ore'], count: 3, explore: true }, taskToken),
          120000, () => { try { stopMotion(); } catch (e) {} });
      } catch (e) { rc = null; }
      if (rc && rc.ok) return rc;
      if (taskToken.cancelled) return { ok: false, reason: 'cancelled' };
    }
    // arbre le plus proche de N'IMPORTE quelle essence (pas oak hardcodé) — robustesse terrain
    const logNames = Object.keys(bot.registry.blocksByName).filter((n) => n.endsWith('_log'));
    // EXPÉDITION BOIS (Massii 15/07) : si aucun arbre LOCAL (≤48), le bot doit VOYAGER (spawn
    // déboisé) → autant faire le plein en un trajet (≥12 = tout le bootstrap) plutôt que revenir
    // grappiller 3 bûches. Un lot partiel est rendu ok par gather (got>0) → jamais de sur-boucle.
    const _logIds = logNames.map((n) => bot.registry.blocksByName[n]).filter(Boolean).map((d) => d.id);
    const _localWood = !!(_logIds.length && bot.findBlock({ matching: _logIds, maxDistance: 48 }));
    const _count = woodExpeditionCount(goal.args.count, _localWood);
    if (_count !== goal.args.count) emit({ type: 'wood_expedition', batch: _count });
    return gather(bot, { name: logNames.length ? logNames : 'oak_log', count: _count, explore: true }, taskToken);
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
  if (goal.skill === 'descendDiagonal') {
    // FIX churn re-descente (NO_GIVE) : un chantier profond SEC est mémorisé → y retourner par
    // /home wsite (1 tp) plutôt que re-creuser ~52 blocs (chaque re-descente cassait une pioche pierre
    // → no_pickaxe → le fer ne s'accumulait jamais). water_rescue ramenait en SURFACE, forçant cette
    // re-descente : c'est LE moteur du churn. Garde : si le tp atterrit dans l'eau, le wsite est noyé
    // → on l'oublie et on re-creuse (qui relocalise au sec via _descendWaterFails).
    if (NO_GIVE && _wsiteMineSet && bot.entity && bot.entity.position && bot.entity.position.y > 30) {
      emit({ type: 'descend_via_home_wsite' });
      try { homewarp.goHome(bot, 'wsite'); } catch (e) {}
      await awaitWarp({ maxMs: 8000 }); // atterrissage OU warmup teleport-delay couvert (remplace le sleep aveugle)
      await sleep(1200);                // settle chunks post-tp
      const _py = (bot.entity && bot.entity.position) ? bot.entity.position.y : 99;
      if (isInWater(bot)) { _wsiteMineSet = false; try { await escapeWater(bot, { emit }); } catch (e) {} }
      else if (_py <= 20) return { ok: true, viaHome: true };  // arrivé profond & sec → pas de re-creusage
    }
    const r = await descendDiagonal(bot, goal.args || {}, taskToken);
    // suivi des échecs EAU → le pré-hook ci-dessus décale le prochain essai (anti re-perçage d'aquifère)
    if (r && r.ok === false && /water|flood|drown/i.test(String(r.reason || ''))) _descendWaterFails++;
    else if (r && r.ok) {
      _descendWaterFails = 0;
      // chantier profond atteint & SEC → mémoriser (les re-descentes suivantes = /home wsite, pas de creusage)
      if (NO_GIVE && !isInWater(bot)) { try { homewarp.bookmark(bot, 'wsite'); } catch (e) {} _wsiteMineSet = true; emit({ type: 'wsite_mine_bookmarked' }); }
    }
    return r;
  }
  if (goal.skill === 'branchMine') {
    const rBM = await branchMine(bot, goal.args || {}, taskToken);
    // Fix n°2 water-wall (NO_GIVE) : aquifère VERROUILLANT (waterlocked = toutes directions
    // mouillées + scellement inopérant) ou stall → se DÉCALER à pied 30-50 blocs À PROFONDEUR
    // (pathfinder creuse son chemin) avant que le planner ne retente iron_deep au même endroit.
    // Le wsite noyé est oublié / re-marqué au sec (sinon /home wsite ramènerait dans la nappe).
    if (NO_GIVE && rBM && rBM.ok === false && (rBM.reason === 'waterlocked' || rBM.reason === 'stalled')
        && bot.entity && bot.entity.position) {
      const _ang = Math.random() * Math.PI * 2;
      const _d = 30 + Math.random() * 20;
      const _p = bot.entity.position;
      const _tx = Math.round(_p.x + Math.cos(_ang) * _d);
      const _tz = Math.round(_p.z + Math.sin(_ang) * _d);
      emit({ type: 'waterlocked_relocate', x: _tx, z: _tz, reason: rBM.reason });
      try {
        await withTimeout(bot.pathfinder.goto(new pfGoals.GoalNear(_tx, Math.round(_p.y), _tz, 3)), 90000,
          () => { try { stopMotion(); } catch (e) {} });
      } catch (e) {}
      if (isInWater(bot)) { _wsiteMineSet = false; try { await escapeWater(bot, { emit }); } catch (e) {} }
      else { try { homewarp.bookmark(bot, 'wsite'); _wsiteMineSet = true; emit({ type: 'wsite_mine_bookmarked', ctx: 'waterlocked_relocate' }); } catch (e) {} }
    }
    return rBM;
  }
  // Chaîne iron_armor : ensureArmor fond le brut nécessaire + craft la pièce fer la moins chère +
  // équipe (1 pièce/appel — le planner re-boucle). Progrès = besoin d'armure qui BAISSE ou pièce
  // équipée en plus ; sinon {ok:false} → failStreak → stall propre (ex. four perdu, fer volatilisé).
  if (goal.skill === 'ensureArmor') {
    const need = () => armorNeed({ inv: buildCtxInv(bot), worn: [..._wornArmor()] }, 3);
    const before = need(); const wornBefore = _wornArmor().size;
    try { await ensureArmor({ ironKeep: 0 }); } catch (e) { /* best-effort, jugé sur le progrès */ }
    const after = need();
    return (after < before || _wornArmor().size > wornBefore || after === 0)
      ? { ok: true } : { ok: false, reason: 'armor_no_progress' };
  }
  // Chaîne diamond_armor : équipe toute pièce diamant en poche (jamais downgrade) puis craft la
  // pièce diamant la moins chère du slot encore sous-diamant (armorUpgradePlan, pur/testé).
  if (goal.skill === 'craftDiamondArmor') {
    const itemsOf = () => ((bot.inventory && bot.inventory.items()) || []).map((i) => ({ name: i.name, count: i.count }));
    let progressed = false;
    for (const piece of bestArmorToEquip(itemsOf(), _wornArmor())) {
      const it = ((bot.inventory && bot.inventory.items()) || []).find((i) => i.name === piece.name);
      if (it) { try { await bot.equip(it, ARMOR_SLOTS[piece.slot]); progressed = true; } catch (e) {} }
    }
    const plan = armorUpgradePlan(itemsOf(), _wornArmor(), { material: 'diamond' });
    if (plan) {
      const r = await craftSmart({ name: plan.craft, count: 1 });
      if (r && r.ok) {
        progressed = true;
        emit({ type: 'gear_craft', item: plan.craft, ok: true, why: 'diamond_armor' });
        const it = ((bot.inventory && bot.inventory.items()) || []).find((i) => i.name === plan.craft);
        if (it) { try { await bot.equip(it, ARMOR_SLOTS[plan.slot]); } catch (e) {} }
      }
    }
    return progressed ? { ok: true } : { ok: false, reason: 'no_diamond_progress' };
  }
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
    const gotIron = await tryMetal(['iron_ore', 'deepslate_iron_ore'], 'raw_iron', 'iron_ingot', 'iron_sword');
    if (!gotIron) await tryMetal(['copper_ore', 'deepslate_copper_ore'], 'raw_copper', 'copper_ingot', 'copper_sword');
  } catch (e) { /* best-effort : on cartographie à la pierre */ }
  // Mappeur exposé aux mobs (hole A §1.3) : enfile armure+bouclier avec le fer du kit-upgrade
  // (ironKeep=0 : pas de quota fer à préserver). Best-effort — sans fer en poche, no-op.
  try { await armorUp(0); } catch (e) { /* best-effort */ }
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

// Abri nocturne PARTAGÉ (kit + roaming mappeur, hole §1.4) : nuit + (mort récente OU PV ≤10) + pas
// d'abri depuis 10 min → trou couvert jusqu'à l'aube (borné 13 min). Retourne true si on s'est abrité.
// `proactive=true` (mappeurs en roaming, fix fable1) : la nuit SUFFIT — attendre une mort pour
// s'abriter, c'est déjà avoir perdu (MapperBot1+2 sniped par squelettes la 1re nuit du monde neuf).
async function maybeNightShelter(proactive = false) {
  const deathsRecent = deathTimes.filter((t) => Date.now() - t < 10 * 60 * 1000).length;
  // Décision d'abri déléguée à shouldShelter (skills/shelter) : sensible à l'OBSCURITÉ (lightLevel
  // ≤7) en plus de la nuit — un bot dans une grotte sombre / à l'ombre profonde de jour se terre
  // aussi. Robuste au lightLevel inconnu (mineflayer ne le livre pas toujours → retombe sur hostiles).
  const _pp = bot.entity && bot.entity.position;
  const naked = _wornArmor().size === 0;
  let lightLevel = null;
  try { const b = _pp && bot.blockAt(_pp.floored()); if (b && typeof b.light === 'number') lightLevel = b.light; } catch (e) {}
  const hostilesNear = (() => { try { const e = bot.nearestEntity((x) => x && x.kind === 'Hostile mobs'); return !!(e && bot.entity && e.position.distanceTo(bot.entity.position) <= 8); } catch (e) { return false; } })();
  // Sous terre (y<45, seuil historique) : pas d'abri du tout — un mineur s'enterrait en boucle
  // dans sa propre mine (dark permanent + nu en chaîne armure), 10-13 min perdues par cycle.
  const sig = { night: isNight(bot), lightLevel, naked, lowHp: (bot.health != null && bot.health <= 10), hostilesNear, proactive, underground: !!(_pp && _pp.y < 45) };
  if (shouldShelter(sig).shelter && Date.now() - lastShelterT > 10 * 60 * 1000) {
    lastShelterT = Date.now();
    // MAPPEUR (Massii 2026-07-15) : d'abord REVENIR au home 'safe' de surface (/home safe, visible),
    // puis se terrer là — plutôt que de creuser un trou au hasard là où la nuit l'a surpris.
    if (IS_MAPPER && _safeHomeSet) {
      try { emit({ type: 'mapper_home_return', home: 'safe' }); homewarp.goHome(bot, 'safe'); await sleep(4000); } catch (e) {}
    }
    _stillBusy = true;    // terré jusqu'à l'aube (≤13 min immobile) : immobilité légitime, pas un desync
    try {
      await withTimeout(shelterUntilDawn(bot, taskToken, { emit }), 13 * 60 * 1000,
        () => { try { stopMotion(); } catch (e) {} });
    } finally { _stillBusy = false; }
    return true;
  }
  return false;
}

// Échecs EAU consécutifs de descendDiagonal (anti re-perçage d'aquifère — cf. pré-hook descend).
let _descendWaterFails = 0;

async function runSkillWithTelemetry(g) {
  await settleSurvivalKit();                                  // survie d'abord, le craft ensuite
  if (taskToken.cancelled) return { ok: false, reason: 'cancelled' };
  // NUIT + (mort récente OU PV bas) pendant le kit → ABRI jusqu'à l'aube (vécu Surv4 : 7 morts
  // nocturnes en boucle ; un trou couvert coûte 2 blocs et sauve le kit).
  if (await maybeNightShelter() && taskToken.cancelled) return { ok: false, reason: 'cancelled' };
  const r = await withTimeout(runGoalSkill(g), timeoutFor(g.skill), () => { try { stopMotion(); } catch (e) {} });
  if (!r || r.ok === false) emit({ type: 'goal_failed', name: g.name, reason: (r && r.reason) || 'unknown' });
  return r;
}

// Boucle cartographe (objectif `mapper`) : mini-kit pierre via planner → upgrade best-effort →
// cartographie CONTINUE (ne « finit » jamais — seule l'annulation/stop l'arrête).
async function startMapper() {
  await survivalKitUp();   // /kit + équipement (si configuré) — AVANT le mini-kit pierre
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
  // filet survie : buffer de terre pour sceller l'abri + bouffe pour régén PV (best-effort, bornés)
  try { if (needDirtBuffer(bot.inventory.items(), 8)) await gather(bot, { name: ['dirt', 'grass_block', 'gravel'], count: 8, maxDistance: 48 }, taskToken); } catch (e) {}
  try { await huntCookGoal(6); } catch (e) {}
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
  const boatMod = require('./boat');
  // Centroïde des cellules déjà mappées (référence "vers le large").
  const mappedCentroid = () => {
    const w = bot._worldMemory && bot._worldMemory.worlds && bot._worldMemory.worlds[bot._worldKey];
    const bs = (w && w.biomes) || [];
    if (!bs.length) { const p = bot.entity.position; return { x: p.x, z: p.z }; }
    let sx = 0, sz = 0; for (const b of bs) { sx += b.x; sz += b.z; }
    return { x: sx / bs.length, z: sz / bs.length };
  };
  const sampleBlock = (x, y, z) => { try { return bot.blockAt(vec3Lib(x, y, z)); } catch (e) { return null; } };
  const escapeWaterHook = async () => { try { await escapeWater(bot, { emit }); } catch (e) {} };
  await runMapper(bot, {
    worldKey: bot._worldKey,
    memory: bot._worldMemory,
    frontier: !!args.frontier,
    boat: {
      cross: async (fromPos) => {
        // 1) cap vers le large + REPÉRER l'eau (scanne le cap outward ± offsets : la côte n'est pas
        //    forcément pile au cap). Aucune eau à portée → no_water (le mapper marchera).
        let heading = boatMod.outwardHeading(fromPos, mappedCentroid(), mapperSector, Math.random);
        let edge = null;
        // Bateau UNIQUEMENT sur l'OCÉAN, rivière à la NAGE, flaque/caverne/lac → pas de traversée
        // (Massii live 2026-07-15 : bateau posé en mini-caverne = bot bloqué contre un mur).
        let mode = null;
        for (const off of [0, 0.5, -0.5, 1.0, -1.0, 1.5, -1.5, Math.PI]) {
          const h = heading + off;
          const e = boatMod.waterEdgeAlong(sampleBlock, bot.entity.position, h, { reach: 56, step: 2 });
          if (!e.found) continue;
          let bio = null;
          try {
            const wb = bot.blockAt(vec3Lib(e.pos.x, e.pos.y, e.pos.z));
            bio = (wb && wb.biome) ? resolveBiome(bot, wb) : null;
          } catch (err) { /* chunk non chargé → cap suivant */ }
          const m = boatMod.waterCrossMode(bio && bio.name);
          if (!m) continue;                       // eau non-traversable → cap suivant
          heading = h; edge = e; mode = m; break;
        }
        if (!edge) return { ok: false, landed: false, reason: 'no_crossable_water' };
        // 2) bateau en poche UNIQUEMENT en mode océan (kit ou craft) ; rivière = nage pure.
        const eb = mode === 'boat' ? await boatMod.ensureBoat(bot, { craft: (a) => craftSmart(a) }) : { ok: false };
        // 3) marcher jusqu'au bord de l'eau repéré
        try {
          await withTimeout(bot.pathfinder.goto(new pfGoals.GoalNear(edge.pos.x, edge.pos.y, edge.pos.z, 2)),
            60000, () => { try { stopMotion(); } catch (e) {} });
        } catch (e) { /* best-effort : on tente depuis ici */ }
        // 4) poser le bateau sur l'eau + embarquer (océan avec bateau en poche uniquement)
        if (mode === 'boat' && eb.ok) {
          try {
            const boatItem = bot.inventory.items().find((i) => /_boat$/.test(i.name));
            const water = bot.blockAt(vec3Lib(edge.pos.x, edge.pos.y, edge.pos.z));
            if (boatItem && water && boatMod.WATER_NAMES.has(water.name)) {
              await bot.equip(boatItem, 'hand');
              await bot.lookAt(water.position.offset(0.5, 1, 0.5), true);
              await bot.activateItem();
              await new Promise((r) => setTimeout(r, 800));
              const ent = bot.nearestEntity((e) => /boat/i.test(e.name || '') || /boat/i.test(e.objectType || ''));
              if (ent && bot.entity.position.distanceTo(ent.position) < 6) {
                try { await bot.mount(ent); await new Promise((r) => setTimeout(r, 600)); } catch (e) {}
              }
            }
          } catch (e) { /* best-effort */ }
        }
        // 5) traverser (bateau ou nage) — sailToLand n'accepte un débarquement qu'APRÈS être passé
        //    au-dessus de l'eau (anti « atterrissage sur sa propre côte »).
        const r = await boatMod.sailToLand(bot, heading, { sampleBlock, reach: 40, step: 4, timeoutMs: 90000 });
        if (!r.landed) { await escapeWaterHook(); }   // secours : sortir de l'eau (jamais figé)
        return { ok: true, landed: r.landed, reason: r.reason };
      },
    },
    reloadMemory: (args['wm-live'] && args['world-memory'])
      ? () => loadMemory(args['world-memory']) : null,
    getSector: () => mapperSector,
    teleport: tpWatch, // #10 : TP détecté → ré-ancrage (heading propre depuis la position réelle)
    emit,
    fleeFrom,
    preferFlee: true,  // mappeur : fuit par défaut, ne se défend qu'à portée de coup (Massii 2026-07-15)
    nightShelter: () => maybeNightShelter(true), // fix fable1 bis : se terrer AVANT chaque départ de nuit

    // kit incomplet (stall terrain au départ) → re-tenté discrètement toutes les ~10 arrivées :
    // le terrain a changé (le bot a bougé), la pose de table a souvent une 2e chance ailleurs.
    onPeriodic: async () => {
      const ctx = Object.assign({ inv: buildCtxInv(bot) }, ctxExtra());
      if (firstUnmet(kitChain, ctx)) { emit({ type: 'mapper_kit_retry' }); await runKit(); }
      try { await armorUp(0); } catch (e) { /* best-effort */ }   // hole A : le mappeur s'arme aussi
      try { if (needDirtBuffer(bot.inventory.items(), 4)) await gather(bot, { name: ['dirt', 'grass_block', 'gravel'], count: 8, maxDistance: 48 }, taskToken); } catch (e) {}
      try { await maybeNightShelter(true); } catch (e) {}         // hole §1.4 : abri nocturne en roaming
    },
    // CHASSE OPPORTUNISTE (vécu Surv1 : le retry périodique coïncide rarement avec des proies à
    // portée → stock jamais constitué) : à chaque arrivée, si le stock cuit est bas ET qu'une proie
    // passe à ≤24 blocs → on la tue MAINTENANT (cru en poche ; la cuisson se fait au retry du kit).
    onArrive: async () => {
      // Fix fable1 : abri nocturne PROACTIF à CHAQUE arrivée (onPeriodic = 1/10 arrivées, trop rare —
      // les mappeurs se faisaient sniper en surface la nuit avant le prochain check). No-op le jour.
      if (await maybeNightShelter(true)) return; // aube : on reprend au prochain cycle (pas de chasse de nuit)
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
// H5 : case OUVERTE (air/cave_air) adjacente à un minerai exposé — pour ARRIVER DANS la grotte par
// l'ouverture en pathfinding normal, JAMAIS creuser droit sur les coords du bloc (= X-ray). null si
// entouré de roche pleine (→ fallback adjacence). Eau exclue (on ne plonge pas dans une nappe).
function openNeighborOf(pos) {
  const OFFS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  for (const [dx, dy, dz] of OFFS) {
    const b = bot.blockAt(vec3Lib(pos.x + dx, pos.y + dy, pos.z + dz));
    if (b && (b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air'
        || (b.boundingBox === 'empty' && b.name !== 'lava' && b.name !== 'water'))) {
      return { x: pos.x + dx, y: pos.y + dy, z: pos.z + dz };
    }
  }
  return null;
}

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

// H4 : libérer un slot SUR PLACE (JAMAIS remonter en surface sur inventaire plein). tossJunk d'abord
// (garde quota/outils/bouffe, jamais le quota, jamais re-ramassé) ; si toujours plein → creuser DEVANT
// (idiome du watchdog anti-jam) pour ouvrir de l'espace, puis re-toss. Branché comme `cleanup` du
// runResource → empêche le dump-surface qui abandonnait les diamants au sol (vécu live ResBot2).
async function makeRoomInPlace(b) {
  try { await tossJunk(b); } catch (e) {}
  if (b.inventory && typeof b.inventory.emptySlotCount === 'function' && b.inventory.emptySlotCount() > 1) return;
  try {
    const p = b.entity && b.entity.position; if (!p) return;
    const yaw = (b.entity && b.entity.yaw) || 0;
    const fdx = Math.round(-Math.sin(yaw)), fdz = Math.round(Math.cos(yaw));
    for (const dy of [0, 1]) {                                    // tête + pieds DEVANT le bot
      const blk = b.blockAt(vec3Lib(Math.floor(p.x) + fdx, Math.floor(p.y) + dy, Math.floor(p.z) + fdz));
      if (blk && blk.boundingBox === 'block' && (typeof b.canDigBlock !== 'function' || b.canDigBlock(blk))) {
        const tool = bestToolFor(b, blk);
        if (tool) { try { await b.equip(tool, 'hand'); } catch (e) {} }
        try { await b.dig(blk); } catch (e) {}
      }
    }
    try { await tossJunk(b); } catch (e) {}
  } catch (e) { /* best-effort, jamais throw */ }
}

// BANK-EN-PLACE (no-keepInventory) : pose un coffre adjacent, dépose la liste de LIVRABLES décidée par
// resource.js (planBank), renvoie {ok, before, after, pos}. resource.js crédite tracker.noteBanked avec
// before/after → le compte tient même quand l'inventaire est vidé. Le coffre est LAISSÉ sur place (les
// items doivent survivre aux morts — c'est tout l'intérêt). Best-effort : un échec ne casse jamais le run.
async function bankDeposit(depositList) {
  const snap = () => ((bot.inventory && bot.inventory.items()) || []).map((i) => ({ name: i.name, count: i.count }));
  const hasChest = () => ((bot.inventory && bot.inventory.items()) || []).some((i) => i.name === 'chest');
  if (!hasChest()) {
    // Re-craft un coffre (8 planches) si possible ; sinon abandon propre (le run continue sans banker).
    const items = (bot.inventory && bot.inventory.items()) || [];
    const planks = items.filter((i) => i.name.endsWith('_planks')).reduce((a, i) => a + i.count, 0);
    if (planks < 8) {
      const log = items.find((i) => i.name.endsWith('_log'));
      if (log) { try { await craftSmart({ name: log.name.replace('_log', '_planks'), count: 2 }); } catch (e) {} }
    }
    try { await craftSmart({ name: 'chest', count: 1 }); } catch (e) {}
    if (!hasChest()) return { ok: false, reason: 'no_chest_item' };
  }
  let place;
  try { place = await placeBlockNear(bot, 'chest'); } catch (e) { return { ok: false, reason: 'place_exception' }; }
  if (!place || !place.ok) return { ok: false, reason: 'place_failed:' + ((place && place.reason) || '?') };
  try { await waitForBlock(place.pos, 'chest', 3000); } catch (e) {}
  await sleep(300);
  const before = snap();
  let chest;
  try { chest = await bot.openContainer(bot.blockAt(place.pos)); }
  catch (e) { return { ok: false, reason: 'open_failed', pos: place.pos }; }
  for (const d of depositList || []) {
    const it = ((bot.inventory && bot.inventory.items()) || []).find((i) => i.name === d.name);
    if (it) { try { await chest.deposit(it.type, null, Math.min(d.count, it.count)); } catch (e) { /* slot plein/désync */ } }
  }
  try { chest.close(); } catch (e) {}
  return { ok: true, before, after: snap(), pos: place.pos };
}

// Quota --quota <path> : {type: n} (JSON, validé par quota.normalizeQuota côté runResource).
function loadQuota() {
  if (!args.quota) return null;
  try { return JSON.parse(require('fs').readFileSync(String(args.quota), 'utf8')); }
  catch (e) { return null; }
}

// Cumul bankē persisté --banked <path> : durabilité de la progression bankée à travers les re-créations
// du tracker (re-entrée de runResource dans le MÊME process + respawn cross-process + deploy). Sans ça
// le banked repart à 0 → les diamants déposés dans des coffres au sol sont OUBLIÉS (cause racine du
// plateau multi-nuits). Fichier keyé server+user côté manager (stable across respawn/deploy). Best-effort :
// toute erreur d'I/O → repart de 0 (jamais bloquant), comme la mémoire de monde.
function loadBanked() {
  if (!args.banked) return null;
  try {
    const o = JSON.parse(require('fs').readFileSync(String(args.banked), 'utf8'));
    return (o && typeof o === 'object') ? o : null;
  } catch (e) { return null; }
}
function saveBanked(snapshot) {
  if (!args.banked || !snapshot) return;
  const fs = require('fs');
  const p = String(args.banked);
  try {
    const tmp = p + '.tmp';                       // write+rename = écriture atomique (anti-corruption sur mort process)
    fs.writeFileSync(tmp, JSON.stringify(snapshot));
    fs.renameSync(tmp, p);
  } catch (e) { /* best-effort, comme world memory */ }
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
async function ensureArmor(opts = {}) {
  const items = () => ((bot.inventory && bot.inventory.items()) || []).map((i) => ({ name: i.name, count: i.count }));
  const cnt = (n) => items().filter((i) => i.name === n).reduce((a, i) => a + i.count, 0);
  const worn = _wornArmor();
  // bug #4 : déjà 4 pièces d'armure (TOUTE matière — ex. diamant du kit OP) → ne RIEN faire. Sinon le
  // craft ci-dessous re-fabriquerait du FER et l'équiperait PAR-DESSUS le diamant (downgrade). Slot-agnostique.
  const _SLOT_SUF = ['_helmet', '_chestplate', '_leggings', '_boots'];
  if (_SLOT_SUF.filter((suf) => [...worn].some((w) => String(w).endsWith(suf))).length >= 4) return;
  // 1) Équiper la MEILLEURE pièce d'armure en poche par slot (TOUTE matière, jamais downgrade).
  //    ⚠️ L'ancienne boucle ne connaissait QUE ARMOR_PIECES (fer) → un kit DIAMANT fourni restait en
  //    poche, le bot combattait NON ARMURÉ → morts en boucle (vécu live cette nuit : ResBot2 0 armure).
  //    bestArmorToEquip (pur, testé) couvre diamant/netherite/fer/… → on équipe le kit donné.
  for (const piece of bestArmorToEquip(items(), worn)) {
    const it = ((bot.inventory && bot.inventory.items()) || []).find((i) => i.name === piece.name);
    if (it) { try { await bot.equip(it, ARMOR_SLOTS[piece.slot]); worn.add(piece.name); } catch (e) {} }
  }
  // 2) Craft la prochaine pièce. ironKeep FIXE bas (8) — l'armure PRIME (survie #1 Massii) : le
  //    bot re-mine le quota fer, l'armure survit aux morts (keepInventory). Le gate quota-strict
  //    bloquait tout (armorPlan null en boucle, vécu : 0 armure craftée). Smelt FORCÉ du raw_iron
  //    nécessaire si les lingots manquent pour la pièce la moins chère.
  const ironKeep = opts.ironKeep != null ? opts.ironKeep : 8;  // buffer fer au GATE (mappeur=0, resource=8)
  const nextPiece = ARMOR_PIECES.find((pc) => !worn.has(pc.name) && !items().some((i) => i.name === pc.name));
  if (nextPiece) {
    const totalIron = cnt('raw_iron') + cnt('iron_ingot');
    if (totalIron - ironKeep >= nextPiece.ingots) {
      const need = nextPiece.ingots - cnt('iron_ingot');
      if (need > 0 && cnt('raw_iron') >= need) {
        // event diagnostic (fix n°4 water-wall) : l'échec de fonte était AVALÉ → armor_no_progress
        // en boucle sans cause visible (vécu live NethBot3 : 0 combustible, indevinable des events).
        let sm = null;
        try { sm = await smeltWithFurnace('raw_iron', 'iron_ingot', need); } catch (e) { sm = { ok: false, reason: 'threw' }; }
        if (!sm || !sm.ok) emit({ type: 'armor_smelt', ok: false, reason: (sm && sm.reason) || '?' });
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
  if (shieldPlan(items(), hasShield)) {
    try {
      const r = await craftSmart({ name: 'shield', count: 1 });
      if (r && r.ok) {
        const sh = ((bot.inventory && bot.inventory.items()) || []).find((i) => i.name === 'shield');
        if (sh) { try { await bot.equip(sh, 'off-hand'); emit({ type: 'gear_craft', item: 'shield', ok: true, why: 'armor' }); } catch (e) {} }
      }
    } catch (e) {}
  }
}

// ── Phase B : stock de torches (mob-aware) PROACTIF (hole B — éclairer = moins de mobs = moins de
// morts). Manque de charbon → mine le charbon EXPOSÉ tout proche (≤24, JAMAIS de roaming en plein
// tunnel) ; manque de sticks → en craft depuis les planches du kit. Best-effort, jamais bloquant.
async function ensureTorches() {
  const inv = () => (bot.inventory && bot.inventory.items()) || [];
  const count = (n) => inv().filter((i) => i.name === n).reduce((a, i) => a + i.count, 0);
  if (count('torch') >= 8) return;
  if ((count('coal') + count('charcoal')) < 1) {
    const coalDefs = ['coal_ore', 'deepslate_coal_ore'].map((n) => bot.registry.blocksByName[n]).filter(Boolean);
    if (coalDefs.length && bot.findBlock({ matching: coalDefs.map((b) => b.id), maxDistance: 24 })) {
      try { await gather(bot, { name: ['coal_ore', 'deepslate_coal_ore'], count: 3, explore: false }, taskToken); } catch (e) { /* best-effort */ }
    }
  }
  if (count('stick') < 1) {
    const planks = inv().find((i) => i.name.endsWith('_planks'));
    if (planks) { try { await craftSmart({ name: 'stick', count: 4 }); } catch (e) {} }
  }
  if ((count('coal') + count('charcoal')) < 1 || count('stick') < 1) return; // toujours rien → on mine sans
  try {
    const r = await craftSmart({ name: 'torch', count: 8 });
    if (r && r.ok) emit({ type: 'gear_craft', item: 'torch', ok: true, why: 'mob_aware' });
  } catch (e) { /* best-effort */ }
}

// Cycle d'équipement de survie réutilisable (hole A — mappeurs + ressource + porte avant-profondeur
// l'appellent) : torches proactives + armure de fer + bouclier. ironKeep = fer à préserver pour un
// quota (mappeur = 0, il n'a pas de quota fer ; ressource = fer-quota-restant).
async function armorUp(ironKeep = 8) {
  try { await ensureTorches(); } catch (e) { /* best-effort */ }
  try { await ensureArmor({ ironKeep }); } catch (e) { /* best-effort */ }
}

// /kit serveur (configuré au profil, policy.kit_command) : lancé au démarrage du mappeur + à chaque
// respawn, cooldown LOCAL anti-spam via maybeRunKit (décision pure). Best-effort : on tape la
// commande, on laisse le serveur livrer, puis on équipe l'armure reçue (ironKeep=0 = tout utiliser)
// et on mange. Toute erreur est avalée (le mini-kit pierre du planner reste le vrai filet).
let _lastKitAt = null;
async function survivalKitUp() {
  const d = maybeRunKit({ kitCommand: policy.kit_command, lastRunAt: _lastKitAt, now: Date.now() });
  if (!d.run) return;
  _lastKitAt = Date.now();
  try { bot.chat(String(policy.kit_command)); emit({ type: 'kit_used', cmd: policy.kit_command }); } catch (e) {}
  await new Promise((r) => setTimeout(r, 2500));         // réception des items du kit (peut être lent)
  try { await armorUp(0); } catch (e) {}                 // équipe l'armure reçue
  try { await eat(bot); } catch (e) {}
  // 2e passe : des items de kit arrivent parfois après coup → ré-équipe si l'armure n'est pas portée
  try {
    if (typeof _wornArmor === 'function' && _wornArmor().size < 4) {
      await new Promise((r) => setTimeout(r, 2000));
      await armorUp(0);
      emit({ type: 'kit_equipped', worn: _wornArmor().size });
    }
  } catch (e) {}
}

// Ravitaillement NOURRITURE (bug review #1 — cause directe de famine mortelle) : le bot resource
// minait des HEURES à Y-58 où il n'y a AUCUN mob passif → impossible de chasser → faim → 0, et en
// difficulté HARD la famine TUE (+ bloque la régen). Filet de survie : (1) en surface, chasse RÉELLE
// bornée (huntCook) ; (2) sinon (sous terre) /give déterministe (bot OP serveur de test, cohérent avec
// les warps/tp/spawnpoint déjà utilisés ; no-op silencieux si non-OP → le kit huntCook prend le relais).
async function ensureFood() {
  try {
    if (cookedCount(buildCtxInv(bot)) >= 4) return;            // assez de cuit en poche
    const y = bot.entity && bot.entity.position ? bot.entity.position.y : 64;
    if (y >= 45) {                                             // surface → chasse réaliste bornée
      try { await withTimeout(huntCookGoal(6), 120000, () => { try { stopMotion(); } catch (e) {} }); } catch (e) {}
    }
    if (cookedCount(buildCtxInv(bot)) >= 4) return;
    if (NO_GIVE) return;   // sans-give : la chasse en surface reste le SEUL ravitaillement
    // Sous terre la chasse est impossible (pas de passifs à Y-58) → filet déterministe anti-mort.
    try { bot.chat('/give ' + bot.username + ' cooked_beef 32'); emit({ type: 'food_resupply', via: 'give' }); } catch (e) {}
  } catch (e) { /* best-effort */ }
}

// Kit de départ DÉTERMINISTE (serveur de test, bot OP) : /give de quoi descendre miner + survivre +
// crafter SON armure, pour SAUTER le kit-bois de surface — déforesté par les runs précédents (piège
// #41) + mobs nocturnes = le bot roamait 140+ waypoints pour du bois et mourait en boucle SANS jamais
// atteindre la profondeur (vécu : 0 diamant, ~12 respawns/25 min). No-op silencieux si non-OP (vrai
// serveur → kit-bois autonome en fallback). L'armure reste CRAFTÉE (ensureArmor + le raw_iron donné).
async function provisionStartKit() {
  // SANS-GIVE : pas de kit — le bot part NU et gagne tout par la chaîne planner (règle du run nether).
  if (NO_GIVE) { emit({ type: 'start_kit_skipped', reason: 'no_give' }); return; }
  try {
    const u = bot.username;
    // Armure FINIE (pas raw_iron à crafter) : le craft prend ~45 s en surface → le bot mourait des mobs
    // AVANT de la porter (vécu live : death_loop en surface pendant l'équipement). Pièces données =
    // équipées instantanément par ensureArmor → protégé dès le spawn, puis descend.
    // Pioche DIAMANT (tier 3) — PAS iron (tier 2) : TIER_FOR.diamond=3 → seule une pioche tier 3 mine
    // le diamant_ore (vécu live : avec iron_pickaxe, 0💎 minable, le bot minait du fer Y16 + bestPickTier
    // restait <3 → kit-bois en boucle). diamond_pickaxe → bestPickTier=3 → saute le kit + mine diamant +
    // active le forçage mtype='diamond' (tierNow>=3) → branch-mine Y-58. Armure FER (suffit à survivre).
    const hasPick = () => ((bot.inventory && bot.inventory.items()) || []).some((i) => i.name === 'diamond_pickaxe' || i.name === 'netherite_pickaxe');
    // RESPAWN (keepInventory) : le bot GARDE sa pioche → NE PAS re-/give le kit. Sinon on réinjecte
    // 128 cobble + 64 food + … à CHAQUE respawn → l'inventaire SATURE → le prochain /give pioche est
    // DROPPÉ par le serveur ("Not enough space, 1 diamond pickaxe was lost" — vécu live : 0 pioche
    // malgré l'OP, inv plein de résidus 11 h de runs) → kit-bois en boucle. On ré-équipe juste l'armure
    // (gratuit, items déjà en poche) et on sort.
    if (hasPick()) { try { await ensureArmor({ ironKeep: 0 }); } catch (e) {} emit({ type: 'resource_start_kit_skipped_haspick' }); return; }
    // bug #4 (keepInv=false) : ARMURE DIAMANT donnée + équipée EN PREMIER (avant la pioche). Le bot
    // respawn NU et se faisait tuer PENDANT le provisionnement (5-20s de /give) → starve loop. Diamant
    // (pas fer) = survie bien meilleure en hard ; équipée DIRECTEMENT (bot.equip) → protégé en ~2s.
    await sleep(1500);                                  // les tout 1ers /give post-spawn sont perdus (serveur enregistre)
    for (const [name, slot] of [['diamond_boots', 'feet'], ['diamond_leggings', 'legs'], ['diamond_chestplate', 'torso'], ['diamond_helmet', 'head']]) {
      if (_wornArmor().has(name)) continue;
      try { bot.chat('/give ' + u + ' ' + name + ' 1'); } catch (e) {}
      for (let w = 0; w < 8 && !((bot.inventory && bot.inventory.items()) || []).some((i) => i.name === name); w++) await sleep(300);
      const it = ((bot.inventory && bot.inventory.items()) || []).find((i) => i.name === name);
      if (it) { try { await bot.equip(it, slot); } catch (e) {} }
    }
    emit({ type: 'resource_kit_armor', armor: 'diamond' });
    const gives = ['diamond_sword 1', 'shield 1', 'cooked_beef 64', 'cobblestone 128', 'torch 64',
      'crafting_table 1', 'oak_planks 16', 'stick 16', 'coal 16'];
    // DÉLAI INITIAL : les TOUTES PREMIÈRES commandes chat juste après le spawn sont PERDUES (le serveur
    // n'a pas fini d'enregistrer le joueur — vécu live : /give absentes des logs serveur). On laisse le
    // chat s'établir avant le 1er /give critique.
    await sleep(2000);
    // FAIRE DE LA PLACE : pas de pioche + inventaire potentiellement PLEIN (résidus de creusage gardés
    // par keepInventory) → le /give pioche est DROPPÉ faute de slot libre. On jette le junk (junkItems
    // garde outils/quota/bouffe/1 stack cobble — jamais la pioche ni les ores) AVANT, puis ENTRE chaque
    // tentative tant que la pioche n'a pas atterri. C'est LA cause-racine du « 0 pioche → kit-bois ».
    try { await tossJunk(bot); } catch (e) {}
    for (let attempt = 0; attempt < 5 && !hasPick(); attempt++) {
      try { bot.chat('/give ' + u + ' diamond_pickaxe 1'); } catch (e) {}
      for (let w = 0; w < 8 && !hasPick(); w++) await sleep(400);   // poll ~3.2 s
      if (!hasPick()) { try { await tossJunk(bot); } catch (e) {} } // inv encore plein → re-libère un slot
    }
    // H3 : ne /give que les items MANQUANTS — sinon la re-entrée (respawn SANS pioche, inv saturé) re-donne
    // 'diamond_sword 1' à chaque fois → 6 épées accumulées (saturent l'inv → aggravent le drop de pioche,
    // cercle vicieux). Épée(≥fer)/armure/bouclier/table déjà en poche → exclus ; consommables toujours.
    const _inv = () => (bot.inventory && bot.inventory.items()) || [];
    const _worn = _wornArmor();
    const _have = (n) => _inv().some((i) => i.name === n) || (_worn && _worn.has && _worn.has(n));
    const _SWT = ['wooden', 'stone', 'iron', 'golden', 'diamond', 'netherite'];
    const _hasSwordTier = (tier) => _inv().some((i) => i.name.endsWith('_sword') && _SWT.indexOf(i.name.replace('_sword', '')) >= tier);
    const toGive = gives.filter((g) => {
      const name = g.split(' ')[0];
      if (name === 'diamond_sword') return !_hasSwordTier(2);     // déjà épée ≥ fer → pas de doublon
      if (name === 'shield') return !_have('shield');
      if (name === 'crafting_table') return !_have('crafting_table');
      if (name.startsWith('iron_') && (name.endsWith('_helmet') || name.endsWith('_chestplate')
          || name.endsWith('_leggings') || name.endsWith('_boots'))) return !_have(name);  // 1 pièce/slot
      return true;                                                // consommables (food/cobble/torch/coal/planks/stick)
    });
    // ESPACER les commandes (≥300 ms) : /give en rafale = spam chat → kick serveur (anti-spam vanilla ~3 msg/s).
    for (const g of toGive) { try { bot.chat('/give ' + u + ' ' + g); } catch (e) {} await sleep(300); }
    // Équiper l'armure IMMÉDIATEMENT (sinon le bot reste nu jusqu'au 1er ensureGear → mort surface).
    try { await ensureArmor({ ironKeep: 0 }); } catch (e) { /* best-effort */ }
    emit({ type: 'resource_start_kit_provisioned', hadPick: hasPick() });
  } catch (e) { /* best-effort : non-OP → kit autonome */ }
}

// Tick de survie COURT exécuté PENDANT le branch-mining (hole E — la survie ne tournait qu'ENTRE
// les appels branchMine ; une branche de plusieurs minutes laissait le bot sans défense). Une action
// de survie (combat/fuite) + manger + re-stocker des torches. Borné par nature (1 action/appel).
async function branchSurvivalTick() {
  try { await survivalTick(bot, { fleeFrom, emit }); } catch (e) {}
  try { await eat(bot); } catch (e) {}
  // Ancre profonde SÈCHE : on est dans le branch-mine (y≈-58). Si l'OXYGÈNE est plein (= hors de
  // l'eau, sur la terre ferme du tunnel) ET on est profond, on mémorise la position comme refuge sec.
  // Sur une noyade ultérieure, le warp anti-noyade /tp ICI au lieu de re-monter en surface dans le
  // même aquifère (anti boucle de noyade, vécu live ResBot2). Voir anchors.js + onWaterStuck.
  try {
    const _p = bot.entity && bot.entity.position;
    if (_p && _p.y < 8 && typeof bot.oxygenLevel === 'number' && bot.oxygenLevel === 20) {
      bot._dryAnchors = recordAnchor(bot._dryAnchors, _p, { max: 4, minSep: 24 });
    }
  } catch (e) {}
  // BUG A (junk non jeté) : branchMine n'a AUCUN cleanup → le junk de creusage (cobble/deepslate/
  // tuff/dripstone…) sature l'inventaire en minage profond → les diamants minés sont VOIDÉS faute
  // de slot (« Not enough space, diamond was lost » — vécu ResBot1 : 1005 junk + inv plein). Le
  // `cleanup` de resource.js n'est atteint QUE dans le chemin collecte-cible, jamais en serpentin.
  // On vide ICI (hook tous les `survivalEvery` blocs) DÈS que l'inventaire se remplit. junkItems
  // garde diamants/outils/armure/food/1 stack cobble+deepslate (réserve de murage > COBBLE_RESERVE_MIN)
  // → jamais la pioche ni les ores. Gardé sur emptySlotCount pour ne pas tosser à chaque tick.
  try {
    if (bot.inventory && typeof bot.inventory.emptySlotCount === 'function'
        && bot.inventory.emptySlotCount() <= 6) {
      await tossJunk(bot);
      emit({ type: 'branch_cleanup', empty: bot.inventory.emptySlotCount() });
    }
  } catch (e) { /* best-effort : jamais bloquer la branche */ }
  // ensureTorches mine du charbon proche (gather/collectBlock) → borné, sinon il pourrait geler
  // la branche (le hook tourne DANS la boucle, hors de la détection de stall en tête de boucle).
  try { await withTimeout(ensureTorches(), 30000, () => { try { stopMotion(); } catch (e) {} }); } catch (e) {}
}

// Survie LÉGÈRE pendant la DESCENTE diagonale (bug review #7) : combat/fuite + manger UNIQUEMENT —
// SURTOUT PAS ensureTorches (miner du charbon via gather déplacerait le bot et désalignerait
// l'escalier 1×2 → digs hors range au palier suivant). La descente Y64→-58 dure plusieurs minutes
// pendant lesquelles seuls les réflexes event-driven protégeaient le bot.
async function descentSurvivalTick() {
  try { await survivalTick(bot, { fleeFrom, emit }); } catch (e) {}
  try { await eat(bot); } catch (e) {}
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
  // SANS-GIVE : /spreadplayers (relocateToRegion) est BLOQUÉ → on marque le chantier puis on monte au
  // spawn sûr (surface avec arbres) par /home safe. Retour au chantier par /home wsite (cf. plus bas).
  if (NO_GIVE) {
    if (p0) { homewarp.bookmark(bot, 'wsite'); emit({ type: 'wsite_bookmarked', ctx: 'pick_recovery', x: p0.x, y: p0.y, z: p0.z }); }
    homewarp.goSpawn(bot);
    await sleep(3500);
  } else {
    await relocateToRegion({ forest: true });
  }
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
    // SANS-GIVE : /tp @s bloqué → retour au chantier par le signet joueur /home wsite.
    if (NO_GIVE) { homewarp.goHome(bot, 'wsite'); emit({ type: 'wsite_return', x: p0.x, y: p0.y, z: p0.z }); }
    else { try { bot.chat('/tp @s ' + p0.x + ' ' + p0.y + ' ' + p0.z); } catch (e) {} }
    await sleep(3000);
  }
  return { ok: bestPickTier() >= 0 };
}

async function mineForType(type, needed, opts = {}) {
  // FIX #8 (live 22/06, révélé par #7) : NORMALISER le type (les appelants — _deepSerpentine/repli/enterré
  // de resource.js — passent le nom COMPLET 'deepslate_gold_ore', pas la base 'gold'). Sans ça
  // Y_OPT['deepslate_gold_ore']=undefined → targetY défaut -58 → le gold (Y_OPT -16) et l'iron (16)
  // descendaient à -58 dans un AQUIFÈRE → noyade en boucle (R2 : water_rescue_warp×16, 35 min figé).
  // Idem ITEMS_FOR[type] (stopOre) et type==='diamond'. Pour diamond/redstone le défaut -58 == Y_OPT donc
  // le bug était masqué (R1/R3 OK). Idempotent : oreBase('gold')='gold'.
  type = oreBase(type) || type;
  const targetY = Y_OPT[type] !== undefined ? Y_OPT[type] : -58;
  // SANS PIOCHE (Massii #5) : récupération AVANT toute tentative — les skills refusent
  // désormais de creuser à la main (no_pickaxe).
  if (bestPickTier() < 0) {
    const r0 = await withTimeout(recoverPickaxe(), 420000, () => { try { stopMotion(); } catch (e) {} });
    if (taskToken.cancelled) return { ok: true };
    if (!(r0 && r0.ok)) return { ok: false, reason: 'no_pickaxe' };
  }
  // PORTE ARMURE-AVANT-PROFONDEUR (hole A, survie #1 Massii) : avant de s'enfoncer vers un Y profond
  // (≤0 : diamant/redstone -58, or -16), enfile armure+bouclier si pas déjà minimalement équipé.
  // Best-effort, sans deadlock — le fer vient du palier fer Y=16 peu profond, miné en premier.
  if (targetY <= 0) {
    const worn = [..._wornArmor()];
    const hasShield = (bot.inventory && bot.inventory.slots && bot.inventory.slots[45] && bot.inventory.slots[45].name === 'shield')
      || ((bot.inventory && bot.inventory.items()) || []).some((i) => i.name === 'shield');
    if (!isMinimallyArmored(worn, hasShield)) { try { await withTimeout(armorUp(), 180000, () => { try { stopMotion(); } catch (e) {} }); } catch (e) { /* best-effort */ } }
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
      const d = await withTimeout(descendDiagonal(bot, { targetY, onSurvivalTick: descentSurvivalTick }, taskToken), 600000,
        () => { try { stopMotion(); } catch (e) {} });
      if (taskToken.cancelled) return { ok: true };
      if (d && d.ok) break;
      const yNow = (bot.entity && bot.entity.position) ? bot.entity.position.y : 999;
      if (yNow <= targetY + 2) break;                    // arrivé malgré le reason (edge)
      const why = (d && d.reason) || 'timeout';
      if (why === 'lava_ahead' || why === 'water_ahead' || why === 'air_at_y_-50' || why === 'drop_ahead') {
        lavaTurns++;
        if (lavaTurns > 3) return { ok: false, reason: why };   // 4 cardinaux barrés → vraie impasse
        await aimSwingTo(((bot.entity && bot.entity.yaw) || 0) + Math.PI / 2, 0, 'turn');  // capture-clone E : swing humain si humanAim, sinon snap
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
  // BUG PRIO 3.1 (Massii 16/06) : le DIAMANT se mine en galerie SERPENTINE (ondulante, virages
  // irréguliers), JAMAIS en grille de branches métronomiques (= tell X-ray refusé). mainLength plus
  // long en serpentin (couvre + de terrain frais à -58 → + de diamants au volume). Les autres types
  // gardent la grille de branches efficace. opts.serpentine force le mode (repli cave-first raté).
  const _serpentine = (type === 'diamond') || !!(opts && opts.serpentine);
  const r = await withTimeout(branchMine(bot, {
    targetY, mainLength: _serpentine ? 48 : 24, branchLength: 8, stopOre, serpentine: _serpentine,
    // §3.G : cap EXPLICITE vers la région mappée (fourni par resource.js) prioritaire sur le cap
    // persistant — le strip-mining PROGRESSE vers la zone du minerai sans goto-beeline sur le bloc.
    heading: (opts && opts.heading) || bot._branchHeading || null,
    torchEvery: 4,                          // hole B : torches plus fréquentes (était TORCH_EVERY=8)
    approachTimeoutMs: 20000,               // hole E : goto d'approche borné → plus de hang en branche
    survivalEvery: 4,
    // hole E : survie + éclairage PENDANT la branche ; + bank mid-branche (fix fable1 : les
    // diamants s'accumulaient en poche pendant les serpentines interrompues → perdus à la mort).
    onSurvivalTick: async () => {
      await branchSurvivalTick();
      if (opts && opts.maybeBank) { try { await opts.maybeBank(); } catch (e) { /* best-effort */ } }
    },
  }, taskToken), 900000, () => { try { stopMotion(); } catch (e) {} });
  if (taskToken.cancelled) return { ok: true };
  if (r && r.heading) bot._branchHeading = r.heading;
  // Lave/gouffre en travers du tunnel principal : on TOURNE (perpendiculaire) pour le prochain
  // call — persister le même cap re-tamponnerait le même obstacle à l'infini.
  if (r && (r.reason === 'lava' || r.reason === 'drop' || r.reason === 'stalled') && bot._branchHeading) {
    bot._branchHeading = { dx: -bot._branchHeading.dz, dz: bot._branchHeading.dx };
  }
  return (r && r.ok) ? r : { ok: false, reason: (r && r.reason) || 'branch_failed' };
}

// Base "near-spawn" du serveur de test : dérivée du POINT DE SPAWN RÉEL du monde courant
// (robuste à tout reset/déplacement de worldspawn — ex. world_dry1 = savane sèche), avec
// fallback historique (208,528) tant que bot.spawnPoint n'est pas encore connu.
function homeBase() {
  if (CONFINE) return { x: CONFINE.x, z: CONFINE.z };   // ancre arène fixe (≠ spawnPoint mineflayer parfois stale)
  try {
    const sp = bot && bot.spawnPoint;
    if (sp && Number.isFinite(sp.x) && Number.isFinite(sp.z)) return { x: Math.round(sp.x), z: Math.round(sp.z) };
  } catch (e) {}
  return { x: 208, z: 528 };
}

// ── Phase 2 : self-warp vers la RÉGION du bot (quadrant stable dérivé du username autour du
// spawn) — auto-récupération de starvation/échec sans intervention humaine (bot OP requis).
function regionCenter() {
  const base = homeBase();                               // spawn monde réel (fallback 208,528)
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
  // SANS-GIVE (catch-all) : relocateToRegion est PUREMENT /spreadplayers → BLOQUÉ par nogive →
  // no-op silencieux = bot FIGÉ (death_camp, floating_relocate, kit-forest…). On route TOUS les
  // modes vers /home safe (surface sûre). Perd le ciblage forêt/cluster (inopérant en sans-give de
  // toute façon) mais un bot à la surface sèche >>> un bot gelé. Les appelants water/pick gèrent
  // déjà leur propre goSpawn en amont (ce guard couvre le reste).
  if (NO_GIVE) {
    emit({ type: 'relocate_home_safe', mode: opts.forest ? 'forest' : (opts.nearSpawn ? 'near_spawn' : 'default') });
    try { stopMotion(); } catch (e) {}
    homewarp.goSpawn(bot);
    await sleep(3000);
    return;
  }
  // Cellule TERRE tirée de la mémoire de monde (biomes non-océan/rivière, ≥256 du spawn) :
  // le quadrant hashé de V2Res4 tombait en plein OCÉAN → relocalisations inutiles en boucle
  // (vécu phase 2). Rotation déterministe par bot (_relocSeq) → zones différentes à chaque fois.
  // opts.forest (phase 3) : viser un biome À ARBRES — le kit-relocate atterrissait en plaine/
  // désert sans bois (vécu V3Res2 : gatherLog not_found ×4 même après relocate).
  const FOREST_HINTS = ['forest', 'taiga', 'jungle', 'birch', 'grove', 'wooded', 'swamp'];
  // Anti-dispersion (vécu live : ResBot warpé à ~3000 blocs vers des régions humides/inconnues → noyades,
  // morts mob, 0 extraction). On garde les relocations dans le rayon SEC near-spawn (couche profonde
  // near-spawn vérifiée sèche). Au-delà → ignoré, fallback regionCenter (spawn±520, déjà borné).
  const HOME_RANGE = 800;
  const hb = homeBase();                                 // base near-spawn dynamique (= spawnPoint réel, savane sèche)
  // CONFINEMENT arène : court-circuite TOUTE la logique de dispersion (biome/cluster/spirale/regionCenter
  // visent 256..520 blocs = hors arène sèche). On re-spread dans R de l'ancre → le bot reste dans l'arène,
  // re-descend, reprend le minage local. Un seul floating_relocate ne l'éjecte plus à -869 (vécu 22/06).
  if (CONFINE) {
    emit({ type: 'resource_warp', x: CONFINE.x, z: CONFINE.z, confined: true });
    try { bot.chat(confineSpreadCommand(bot.username, CONFINE)); } catch (e) {}
    await sleep(5000);
    return;
  }
  let c = null;
  // bug #4 / BUG PRIO 2.4 : après une NOYADE, relocaliser vers le SEC near-spawn. Le hardcodé (208,528)
  // était SUPPOSÉ sec mais TOMBE DANS L'EAU en world_fresh2 (24-36% wet) → le bot warpe hors de l'eau
  // pour y RETOMBER → boucle de noyade, 0 minage (vécu live session 1). Fix DRY-AWARE : on vise la
  // cellule mappée la PLUS SÈCHE near-spawn (driestCell, depuis la mémoire de monde) ; fallback hardcodé.
  if (opts.nearSpawn) {
    let center = { x: hb.x, z: hb.z }; let foundDry = false;
    try {
      const memNS = (args['wm-live'] && args['world-memory']) ? loadMemory(args['world-memory']) : bot._worldMemory;
      const wNS = memNS && memNS.worlds && memNS.worlds[bot._worldKey];
      const dry = (wNS && Array.isArray(wNS.ores))
        ? driestCell(wNS.ores, { base: hb, range: HOME_RANGE, cellSize: 96, minOres: 12 }) : null;
      if (dry) { center = { x: dry.x, z: dry.z }; foundDry = true; }
    } catch (e) { /* fallback : la base homeBase() est déjà le spawn sec */ }
    if (foundDry) {
      const jx = ((_relocSeq++ * 53) % 80) - 40, jz = ((_relocSeq * 97) % 80) - 40;   // ±40 autour de la cellule sèche
      c = { x: center.x + jx, z: center.z + jz };
    } else {
      // Aucune cellule sèche mappée (mémoire des bots resource = VIDE) : le ±40 retombait dans la
      // MÊME colonne humide → re-descente → re-noyade au MÊME y-59 (vécu live ResBot3 : drowning warp
      // dry:false en boucle sur x298,z-2397). On EXPLORE en SPIRALE (golden-angle, rayon croissant
      // 120..360, dans HOME_RANGE) → chaque noyade atterrit dans une COLONNE DIFFÉRENTE → on finit
      // par sortir de l'aquifère, tout en restant near-spawn (zone réputée sèche, anti-dispersion).
      const n = _relocSeq++;
      const ang = (n * 2.39996323) % (Math.PI * 2);                 // golden angle → couverture régulière
      const rad = 120 + ((n % 4) * 80);                             // 120,200,280,360 (< HOME_RANGE 800)
      c = { x: Math.round(hb.x + Math.cos(ang) * rad), z: Math.round(hb.z + Math.sin(ang) * rad) };
    }
    emit({ type: 'resource_warp', x: c.x, z: c.z, near_spawn: true, dry: foundDry });
  }
  try {
    const memNow = (args['wm-live'] && args['world-memory']) ? loadMemory(args['world-memory']) : bot._worldMemory;
    const w = memNow && memNow.worlds && memNow.worlds[bot._worldKey];
    // G-bis step 3 : relocate DIAMANT → viser un CLUSTER DENSE de diamants EXPOSÉS (grotte mappée),
    // PAS une case biome au hasard. Le bot atterrit À L'APLOMB d'une grotte à diamants visibles → la
    // reach devient courte (vécu : sinon le diamant exposé est à ~100 blocs → goto échoue water/max_steps
    // → 0 extraction). Cellules 48×48, ≥3 diamants exposés, hors zone actuelle, rotation par bot.
    if (opts.diamondCluster && w && Array.isArray(w.ores)) {
      const cur = bot.entity && bot.entity.position;
      const cells = new Map();
      for (const o of w.ores) {
        if (!o || !o.exposed || o.wet || !String(o.material || '').includes('diamond')) continue;  // jamais un cluster NOYÉ (H7+)
        if (cur && Math.abs(o.x - cur.x) < 80 && Math.abs(o.z - cur.z) < 80) continue;  // pas la zone épuisée
        if ((o.x - hb.x) ** 2 + (o.z - hb.z) ** 2 > HOME_RANGE * HOME_RANGE) continue;   // anti-dispersion : reste near-spawn (sec)
        const k = Math.floor(o.x / 48) + ',' + Math.floor(o.z / 48);
        const e = cells.get(k) || { n: 0, x: Math.floor(o.x / 48) * 48 + 24, z: Math.floor(o.z / 48) * 48 + 24 };
        e.n++; cells.set(k, e);
      }
      const ranked = [...cells.values()].filter((e) => e.n >= 3).sort((a, b) => b.n - a.n);
      if (ranked.length) {
        let h = 0; for (const ch of String(bot.username || 'bot')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
        const pick = ranked[(h + (_relocSeq++) * 7) % Math.min(ranked.length, 12)];
        c = { x: pick.x, z: pick.z };
        emit({ type: 'resource_warp', x: c.x, z: c.z, cluster: pick.n });
      }
    }
    let land = (!c ? ((w && w.biomes) || []) : []).filter((b) => {
      const n = String(b.name || '');
      if (!n || n.includes('ocean') || n.includes('river') || n.includes('beach')) return false;
      const ddx = b.x - hb.x, ddz = b.z - hb.z; const d2 = ddx * ddx + ddz * ddz;
      return d2 > 256 * 256 && d2 < HOME_RANGE * HOME_RANGE;   // anti-dispersion : 256..HOME_RANGE du spawn
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

// FONTE FINALE (exigence Massii : LIVRER des lingots d'or/fer FONDUS, pas du minerai brut).
// Appelée UNIQUEMENT quand le quota est atteint (rare) → ne peut pas casser la boucle de minage.
// Fond tout le raw_iron/raw_gold restant en lingots via le four portable du kit. Best-effort,
// borné par smeltWithFurnace (180s/lot) + garde anti-boucle (pas de progrès → stop). Le four ne
// traite qu'1 item/10s → on boucle par lots (un lot peut être tronqué par le timeout, on reprend).
async function finalizeSmelt() {
  const cnt = (n) => ((bot.inventory && bot.inventory.items()) || [])
    .filter((i) => i.name === n).reduce((a, i) => a + i.count, 0);
  for (const [raw, ingot] of [['raw_iron', 'iron_ingot'], ['raw_gold', 'gold_ingot']]) {
    let n = cnt(raw);
    let guard = 0;
    while (n > 0 && guard < 12) {
      guard += 1;
      const batch = Math.min(n, 32);
      let s = null;
      try { s = await withTimeout(smeltWithFurnace(raw, ingot, batch), 200000, stopMotion); }
      catch (e) { s = { ok: false, reason: 'error' }; }
      const after = cnt(raw);
      emit({ type: 'finalize_smelt', raw, ingot, requested: batch, smelted: n - after, ok: !!(s && s.ok) });
      if (after >= n) break;            // aucun progrès (pas de four/fuel) → on arrête (best-effort)
      n = after;
    }
  }
}

async function startResource() {
  // NB : « l'évaporation d'items » (rapport 16/06) était un FAUX diagnostic — `data get entity
  // <joueur EN LIGNE>` est trompeur sur Paper (NBT périmé/tronqué). Le compte autoritaire (`clear`
  // online / playerdata.dat offline) a montré l'inventaire INTACT (64💎 atteints). La sonde
  // inv_probe TEMP est retirée. Les vrais freins étaient : noyade en branchMine (case-eau prise pour
  // de l'air → fix water_ahead) + junk non jeté en deep-serpentine (fix tossJunk/branchSurvivalTick).
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
  // Kit de départ déterministe (OP) AVANT le kit-bois : provisionne → bestPickTier devient 3 → le
  // kit-bois mortel de surface est sauté, le bot descend miner directement. No-op si non-OP → kit-bois.
  if (bestPickTier() < 3) { await provisionStartKit(); if (taskToken.cancelled) return; }
  if (bestPickTier() < 3) {
    const fullChain = chainFor('iron_pickaxe');
    const cutAt = fullChain.findIndex((g) => g.name === 'iron_ore');
    const kitChain = cutAt >= 0 ? fullChain.slice(0, cutAt) : fullChain.slice();   // copie (jamais muter IRON_CHAIN)
    // NB : PAS de food_stock huntCook au kit — il STALLE le kit quand il n'y a pas de mob passif à
    // proximité (event no_prey → resource_kit_stalled, vécu live ResBot2). La nourriture est gérée par
    // provisionStartKit (/give au départ) + ensureFood (filet en boucle) — sans jamais bloquer le kit.
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
    // Garantie B anti-xray (§0 water-wall) : en sans-give, ne JAMAIS cibler un ore mappé enterré
    // (exposed:false) — même si l'obfuscation serveur fuit, le bot n'exploite que le visible.
    exposedOnly: NO_GIVE,
    // Durabilité de la progression bankée (cf. loadBanked/saveBanked) : seed au démarrage + persiste à
    // chaque dépôt → respawn/re-entrée/deploy ne remettent plus le compteur à 0 (les coffres tiennent au sol).
    bankedSeed: quota ? loadBanked() : null,
    saveBanked: quota ? saveBanked : null,
    // STRIP-MINE DESCENDANT pour TOUS les types du quota (fix #7 live 22/06). D'abord limité aux types
    // deep (Y_OPT≤-40), mais le cave-first galère AUSSI pour iron/gold exposés en grotte 1.18 (vécu R2 :
    // iron 54 figé 30 min, resource_cave×16/cave_meander×8/relocate×5, combat skeletons). Le deep-serpentine
    // (mineFor → descendDiagonal vers Y_OPT du type, puis branch-mine au volume) est PROUVÉ fiable (R3
    // redstone 30→80, R1 diamant). On l'applique à tous les types visés → le bot descend au bon Y et
    // strip-mine, au lieu de chasser des ores épars en grotte. Y_OPT={diamond/redstone -58, gold -16,
    // lapis 0, iron 16} → chaque type est miné à sa couche optimale.
    // STRIP-MINE DESCENDANT pour TOUS les types du quota (fix #7). Le fix #9 (cave-first pour la couche
    // gold noyée -16) a été REVERT : le cave-first faisait MOURIR les bots dans les grottes gold hostiles
    // (R2 deaths×3), pire que le strip -16 (qui avait fait 0→36). Le gold reste world-limité (-16 dense
    // mais aquifère ; -54 sec mais vide) → on garde le strip -16, le meilleur débit observé.
    deepStripTypes: quota ? new Set(Object.keys(quota)) : null,
    claims,
    reloadMemory,
    bank: quota ? bankDeposit : null,
    // FONTE PÉRIODIQUE (no-keepInventory + exigence « fondus ») : transforme le brut or/fer porté en
    // LINGOTS pendant le run → bankDeposit les met en coffre → survivent aux morts. Sans ça le brut
    // (non bankable) restait en poche et une mort l'effaçait (vécu live ResBot2 : gold/iron jamais ≥qq).
    // Bornée (200s/lot, comme finalizeSmelt) + best-effort. Renvoie {attempted, smelted} pour la télémétrie.
    smeltRaw: quota ? (async (b) => {
      const plan = planSmeltRaw((b.inventory && b.inventory.items()) || [], { minBatch: 8 });
      if (!plan.length) return { attempted: false, smelted: 0 };
      const cnt = (n) => ((b.inventory && b.inventory.items()) || [])
        .filter((i) => i.name === n).reduce((a, i) => a + i.count, 0);
      let total = 0;
      for (const { raw, ingot, count } of plan) {
        const before = cnt(raw);
        try { await withTimeout(smeltWithFurnace(raw, ingot, Math.min(count, 32)), 200000, stopMotion); }
        catch (e) { /* best-effort : pas de four/fuel → on réessaiera (backoff côté resource.js) */ }
        total += Math.max(0, before - cnt(raw));
        if (taskToken.cancelled) break;
      }
      return { attempted: true, smelted: total };
    }) : null,
    cleanup: quota ? makeRoomInPlace : null,
    mineFor: quota ? mineForType : null,
    relocate: quota ? relocateToRegion : null,
    // G-bis : MINAGE EN GROTTE des diamants EXPOSÉS (visibles → pas X-ray, stratégie joueur réelle). Le
    // bot VA à l'ore (goto borné, accessible par grotte) puis VIDE la veine connectée (floodFill). Bien
    // plus facile + SEC que le strip-mine aveugle à -58 noyé (frein #1 live). Borné 180s (goto+veine ne
    // doit jamais hang). nextOreTarget priorise déjà les exposés ; resource.js route ici si target.exposed.
    mineExposed: quota ? (async (target) => {
      await withTimeout((async () => {
        // H5 : viser la case d'AIR voisine (ouverture grotte), JAMAIS le bloc solide (= tunnel X-ray).
        const air = openNeighborOf(target);
        const goal = air ? new pfGoals.GoalNear(air.x, air.y, air.z, 1)
                         : new pfGoals.GoalGetToBlock(target.x, target.y, target.z);
        const prevMoves = bot.pathfinder.movements;
        // CAVE-FIRST (bug #3 Massii). Phase 1 : rejoindre la grotte SANS creuser (canDig=false) — le
        // chemin le plus humain (on entre par l'ouverture). Phase 2 (clarif #3) : pas walkable → creuser
        // POUR ATTEINDRE est AUTORISÉ (ne PAS sacrifier le diamant), MAIS le tunnel doit SERPENTER (un
        // tunnel parfaitement droit vers une grotte est AUSSI un tell X-ray) → on creuse via un point
        // intermédiaire décalé LATÉRALEMENT (coude aléatoire), pas en ligne droite.
        let r = null;
        try {
          const noDig = new Movements(bot);
          try { Object.assign(noDig, prevMoves); } catch (e) {}
          noDig.canDig = false;
          bot.pathfinder.setMovements(noDig);
          r = await withTimeout(bot.pathfinder.goto(goal), 60000, () => { try { stopMotion(); } catch (e) {} });
        } catch (e) { r = { ok: false }; }
        finally { try { if (prevMoves) bot.pathfinder.setMovements(prevMoves); } catch (e) {} }
        if (taskToken.cancelled) return;
        if (r && r.ok === false) {                              // phase 2 : creuser en SERPENTANT (clarif #3)
          const p0 = bot.entity && bot.entity.position;
          if (p0) {
            const dx = target.x - p0.x, dz = target.z - p0.z;
            const len = Math.sqrt(dx * dx + dz * dz) || 1;
            const off = (3 + Math.floor(Math.random() * 4)) * (Math.random() < 0.5 ? 1 : -1);  // ±3..6 latéral
            const mx = Math.round(p0.x + dx * 0.5 - (dz / len) * off);   // mi-chemin, décalé perpendiculaire = coude
            const mz = Math.round(p0.z + dz * 0.5 + (dx / len) * off);
            const my = Math.round((p0.y + target.y) / 2);
            emit({ type: 'cave_meander', mx, my, mz });
            try { await withTimeout(bot.pathfinder.goto(new pfGoals.GoalNear(mx, my, mz, 2)), 60000, () => { try { stopMotion(); } catch (e) {} }); } catch (e) {}
            if (taskToken.cancelled) return;
          }
          try { r = await withTimeout(bot.pathfinder.goto(goal), 90000, () => { try { stopMotion(); } catch (e) {} }); }
          catch (e) { throw new Error('cave_unreachable'); }
        }
        if (taskToken.cancelled) return;
        // Anti-noyade : ne JAMAIS floodFill en pleine eau (grotte inondée → noyade, 6 morts vécues) →
        // sortir d'abord ; toujours dans l'eau après → on abandonne cette veine (skip+relocate).
        if (isInWater(bot)) { try { await escapeWater(bot, { emit }); } catch (e) {} if (isInWater(bot)) return; }
        try { await floodFillVein(bot, target, taskToken); } catch (e) { /* best-effort */ }
      })(), 180000, () => { try { stopMotion(); } catch (e) {} });
    }) : null,
    // BORNÉ (vécu V3Res2 figé 40 min, events morts mais socket vivant — un hang dans la chaîne
    // gear/smelt/craft n'était couvert par AUCUN timeout, le watchdog physicsTick ne voit rien) :
    // même règle que tout appel mineflayer long (#42b).
    ensureGear: quota ? (async (types) => {
      // ironKeep BAS FIXE (8, comme mineForType l.915 + le timer armure) : l'armure PRIME (survie #1
      // Massii) — le bot re-mine le quota fer, l'armure survit aux morts (keepInventory). Passer
      // ironLeft (= quota.iron - have, jusqu'à 64) comme ironKeep bloquait TOUT craft d'armure sur le
      // chemin mappé (gate totalIron - 64 >= cost jamais franchi → 0 armure, bug review #5). ensureGear
      // tourne en tête de boucle resource AVANT chaque cible → couvre AUSSI la descente vers ore mappée.
      await withTimeout((async () => {
        await ensureGearFor(types); await armorUp(); await ensureFood();
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
  // Quota ATTEINT (r.done) → fonte finale : le brut récolté devient des LINGOTS livrés (or/fer).
  if (r && r.done && args.quota) {
    try { await finalizeSmelt(); } catch (e) { /* best-effort */ }
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
  // FIX fable1 (boucle de mort nocturne, 10 morts/30 min) : de NUIT, la marche de récupération est
  // une marche funèbre — respawn nu → 90 s de pathfinding vers l'endroit exact où campe le tueur →
  // re-mort (intervalle 60-120 s observé = burst<60 s jamais déclenché). Le kit est re-provisionné
  // par /give de toute façon → on ABANDONNE le stuff au sol, on se TERRE jusqu'à l'aube, kit ensuite.
  if (lastDeath && isNight(bot)) {
    lastDeath = null;
    emit({ type: 'death_recovery_skipped', reason: 'night' });
    lastShelterT = 0;                       // une mort de nuit = urgence, on saute le cooldown 10 min
    try { await maybeNightShelter(true); } catch (e) { /* best-effort, le kit reprend derrière */ }
  } else if (lastDeath && Date.now() - lastDeath.t < 4 * 60 * 1000 && invAfterDeath.length === 0) {
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
  const runChain = () => runPlanner(bot, {
    chain,
    runSkill: (g) => runSkillWithTelemetry(g),
    ctxExtra,
    onStep: (g) => emit({ type: 'goal', name: g.name }),
  }, taskToken);
  let res = await runChain();
  // Run nether (mode sans-give uniquement, rétro-compat) : un stall (not_found passager, zone
  // momentanément stérile, proie absente) ne doit PAS figer le bot à vie — pause 90 s puis le
  // planner re-dérive depuis l'état RÉEL. Les morts/exits restent couverts par le self-healing.
  while (NO_GIVE && res && res.stalled && !taskToken.cancelled) {
    emit({ type: 'autonomous_retry', goal: res.goal, in_s: 90 });
    await sleep(90000);
    if (taskToken.cancelled) return;
    res = await runChain();
  }
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
  // RC4 : cibles dirigées ÉPUISÉES (arrivé dessus, rien trouvé) — Set session lu par explore.js.
  // Survit aux respawns MC (même process) : une prairie pelée le reste après une mort.
  if (!bot._mcaExhausted) bot._mcaExhausted = new Set();
  // TP-AU-MAPPEUR (Massii 15/07) : heartbeat de présence partagé — TOUS les bots du groupe battent
  // position+rôle (1×/min) ; un bot ressource lit où sont les mappeurs et se /tpa vers eux
  // (raccourci « vrai joueur » vers les zones lointaines, auto-accepté intra-groupe).
  if (args.positions && !presence) {
    presence = createPresence(String(args.positions), { username: bot.username });
    const _beat = () => {
      try {
        const pB = bot.entity && bot.entity.position;
        if (!pB || !presence) return;
        const role = ((world.objective && world.objective.type) === 'mapper') ? 'mapper' : 'worker';
        presence.beat(Math.round(pB.x), Math.round(pB.z), role);
      } catch (e) { /* best-effort */ }
    };
    _beat();
    setInterval(_beat, 60000);
    // Cible dirigée LOINTAINE (>300) → tenter le raccourci /tpa AVANT la marche (hook explore).
    // Mappers exclus (ils ont /spreadplayers) ; bots non-autonomes : pas de longues marches dirigées.
    if (!bot._mcaBeforeLongTrip && world.objective && world.objective.type !== 'mapper') {
      bot._mcaBeforeLongTrip = async (target) => { try { await tryTpToMapper(target); } catch (e) {} };
    }
  }
  emit({ type: 'status', state: 'spawned', username: bot.username, profile: profile ? profile.id : null });
  // Capture-clone (E, frontière) : wobble de visée humain GLOBAL. On wrappe bot.look UNE fois → TOUTE
  // visée en hérite (pathfinder à chaque tick, pvp tracking, collectBlock dig, nos tours) → micro-
  // instabilité humaine qui tue le « tracking parfait » (dernier tell en jeu actif). Borné petit, réduit
  // en déplacement (anti-misstep pathfinder → la cible reste dans la tolérance, pathfinder corrige au
  // tick suivant). humanAim only → rétro-compat (sans style/clips, bot.look reste l'original exact).
  if (humanAim && typeof bot.look === 'function' && !bot._humanLookWrapped) {
    bot._humanLookWrapped = true;
    const _origLook = bot.look.bind(bot);
    const baseJitter = Math.max(0, Math.min(1, (humanizeParams && humanizeParams.lookJitter) || 0)) * 3; // 0..3°
    if (baseJitter > 0) {
      bot.look = function (yaw, pitch, force) {
        // bug #2 (Massii) : pendant un DIG actif → regard FIXE (wobble COUPÉ). Le jitter faisait
        // regarder à côté du bloc → dig avorté → re-path → saut → diamant laissé. L'humanisation ne
        // doit JAMAIS empêcher l'action de réussir (garde bornée : l'allure est humaine, le dig réussit).
        if (bot.targetDigBlock) return _origLook(yaw, pitch, force);
        const moving = !!(bot.pathfinder && bot.pathfinder.isMoving && bot.pathfinder.isMoving());
        const j = jitterLook(yaw, pitch, { jitterDeg: baseJitter, moving });
        return _origLook(j.yaw, j.pitch, force);
      };
      emit({ type: 'human_look_wrap', jitterDeg: Math.round(baseJitter * 100) / 100 });
    }
  }
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
    // Aquaphobie de MARCHE (vécu world_ax2 : 7-8 water_rescue/bot EN SURFACE — 20 laissait le
    // pathfinder traverser les rivières dès que le détour dépassait ~20 blocs/case d'eau).
    // 45/nœud liquide ≈ détour sec accepté jusqu'à ~45 blocs par case d'eau à traverser.
    if (typeof moves.liquidCost === 'number') moves.liquidCost = 45;
    // Hook eau des skills (explore skippe les waypoints aquatiques) — injectable, pas de require dur.
    bot._mcaInWater = (b) => { try { return isInWater(b || bot); } catch (e) { return false; } };
    // PILIER (Massii « monte mal en pilier ») : le pathfinder ne toure (`allow1by1towers`) qu'avec
    // ses `scafoldingBlocks` — défaut = **dirt + cobblestone UNIQUEMENT** (mineflayer-pathfinder
    // movements.js:75-77). Un bot qui mine de la deepslate n'a que du cobbled_deepslate/tuff →
    // liste vide d'utilisables → INCAPABLE de remonter en pilier (sortir d'un tunnel/trou).
    // On élargit aux blocs sacrifiables réellement en poche (mêmes familles que pillarUp.SCAFFOLD).
    try {
      const scaffoldNames = ['cobblestone', 'cobbled_deepslate', 'dirt', 'coarse_dirt', 'stone',
        'deepslate', 'tuff', 'granite', 'diorite', 'andesite', 'netherrack', 'gravel', 'grass_block'];
      const ids = scaffoldNames
        .map((n) => bot.registry.itemsByName[n] && bot.registry.itemsByName[n].id)
        .filter((x) => x != null);
      if (ids.length) moves.scafoldingBlocks = ids;
    } catch (e) { /* best-effort : garde le défaut dirt+cobblestone */ }
    bot.pathfinder.setMovements(moves);
    // SPRINT « vrai joueur » (Massii 2026-06-22) : `allowSprinting` laisse pathfinder sprinter
    // SEULEMENT sur de longs trajets droits → en minage (déplacements courts) le bot ne sprintait
    // quasi jamais (lent + tell). Garde tick : on FORCE le sprint dès qu'on avance sur la terre
    // ferme (faim ok, pas minage/eau/sneak). Décision pure dans movement.js (testée), état lu ici.
    // Dans le bloc bootDone → 1 seul interval par connexion (pas de fuite au respawn).
    setInterval(() => {
      try {
        const ent = bot.entity;
        if (!ent) return;
        const moving = (bot.pathfinder && bot.pathfinder.isMoving && bot.pathfinder.isMoving())
          || bot.getControlState('forward') || bot.getControlState('back');
        const want = shouldSprint({
          moving,
          onGround: ent.onGround,
          inWater: ent.isInWater || ent.isInLava,
          digging: !!bot.targetDigBlock,
          sneaking: bot.getControlState('sneak'),
          food: bot.food,
          sprinting: bot.getControlState('sprint'),
        });
        if (bot.getControlState('sprint') !== want) bot.setControlState('sprint', want);
      } catch (e) { /* best-effort : ne jamais crasher la boucle de contrôle */ }
    }, 150);
    let waterRescue = null; // évasion d'eau en cours (jamais 2 en parallèle)
    let waterEscapeFails = 0; // escapades LOCALES échouées d'affilée → escalade warp SEULEMENT à 3 (vrai
                              // blocage). PAS d'escalade temporelle agressive : à profondeur diamant les
                              // aquifères sont fréquents, des rencontres rapprochées sont NORMALES.
    let waterStuckTimes = []; // horodatages onWaterStuck (fenêtre 4 min) : zone PERSISTAMMENT humide
                              // (≥4 en 4 min) = escapeWater sort mais le bot y retombe → warp (vécu ResBot3).
    let panicInFlight = false; // garde de ré-entrée onPanic (bug review #3 : fire-and-forget non-awaité)
    installReflexes(bot, {
      emit, fleeFrom,
      // MAPPEUR (Massii live 2026-07-15) : riposte mêlée à portée de coup only (3) ; canardé → fuit.
      meleeRadius: IS_MAPPER ? 3 : undefined,
      preferFlee: IS_MAPPER,
      // DÉLAI DE RÉACTION humain sur les réflexes (anti aimbot 0 ms / anti-ban) — TOUJOURS actif
      // (sécurité, pas seulement en humanize) : ~300 ms par défaut (les captures ne mesurent pas
      // encore reaction.*). Coût nul sur le minage (ce n'est pas un réflexe). Cf. paquet 1.
      reactionMs: () => sampleReactionDelay(humanizeParams),   // capture-clone : réaction humaine réelle si --style
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
        // Garde de ré-entrée (bug review #3) : onPanic est fire-and-forget (non-awaité par le réflexe) ;
        // sans garde, des panicWall concurrents s'empilaient (jusqu'à 9 placeBlock × 5 s = ~45 s bloqué).
        // + withTimeout sur chaque étape : un placeBlock peut throw après 5 s en grotte ouverte.
        if (panicInFlight) return;
        panicInFlight = true;
        (async () => {
          try { stopMotion(); } catch (e) {}
          // panicWall (module dédié, hole C) : mur ROBUSTE même en grotte ouverte (pontage sur le
          // bloc-sol du bot) — l'ancien inline échouait en silence là où les mobs essaiment.
          try { await withTimeout(panicWall(bot), 3000, () => { try { stopMotion(); } catch (e) {} }); } catch (e) { /* best-effort */ }
          try { await withTimeout(eat(bot), 2500, () => {}); } catch (e) {}
        })().finally(() => { panicInFlight = false; });
      },
      // POSTURE DÉFENSIVE à ~10 PV (hole C — AVANT le seuil critique) : équipe + lève le bouclier
      // brièvement (réduit les dégâts entrants). La riposte mêlée et onRanged gèrent l'agresseur.
      onDefensive: () => {
        (async () => {
          try {
            const sh = ((bot.inventory && bot.inventory.items()) || []).find((i) => i.name === 'shield');
            if (sh) {
              const off = bot.inventory && bot.inventory.slots && bot.inventory.slots[45];
              if (!off || off.name !== 'shield') { try { await bot.equip(sh, 'off-hand'); } catch (e) {} }
            }
            try { bot.activateItem(true); } catch (e) {}          // lève le bouclier (main secondaire)
            setTimeout(() => { try { bot.deactivateItem(); } catch (e) {} }, 2000);
          } catch (e) { /* best-effort */ }
        })();
      },
      // SQUELETTE À DISTANCE (hole D) : charge bouclier levé et tue-le en mêlée (supprime la source
      // de flèches) — plus efficace qu'encaisser en kitant. Le plugin pvp gère l'approche. Best-effort.
      onRanged: (foe) => {
        (async () => {
          try {
            const sh = ((bot.inventory && bot.inventory.items()) || []).find((i) => i.name === 'shield');
            if (sh) {
              const off = bot.inventory && bot.inventory.slots && bot.inventory.slots[45];
              if (!off || off.name !== 'shield') { try { await bot.equip(sh, 'off-hand'); } catch (e) {} }
            }
            const w = bestWeapon(bot);
            if (w) { try { await bot.equip(w, 'hand'); } catch (e) {} }
            try { bot.pvp.attack(foe); } catch (e) {}
          } catch (e) { /* best-effort */ }
        })();
      },
      panicCooldownMs: 8000,
      onWaterStuck: () => {
        if (waterRescue) return;
        // Escapade LOCALE par défaut (RESTER au fond). Le warp-vers-surface détruisait la productivité :
        // un bot productif à y-58 touche un aquifère → warp en surface LOINTAINE → re-descente complète →
        // re-eau → boucle, diamants stagnants (vécu live : 0 progrès diamant en 20 min, tous en boucle).
        const nowMs = Date.now();
        waterStuckTimes.push(nowMs);
        waterStuckTimes = waterStuckTimes.filter((x) => nowMs - x <= 4 * 60 * 1000);
        // Zone PERSISTAMMENT humide (vécu ResBot3 : escapeWater sort mais le bot y retombe sans cesse →
        // ne déclenche jamais d'échec → jamais de warp → §1.5 violé) : ≥4 water-stuck en 4 min = il faut
        // QUITTER le biome noyé. Seuil HAUT → n'affecte pas les aquifères transitoires (ResBot1/2 en
        // touchent 1-2 et s'en sortent). Sinon : escapade locale, warp seulement après 3 échecs d'affilée.
        // Seuil 3 (baissé de 4) : onWaterStuck est gaté à ~1/45 s par le réflexe breathe → en 4 min on
        // n'atteint que ~3 invocations même en aquifère continu (vécu live ResBot2 : 88 reflex surface,
        // 3 onWaterStuck, JAMAIS de warp → figé à miner 0 dans l'eau). 3 = warp hors de l'aquifère.
        const persistentlyWet = waterStuckTimes.length >= 3;
        // EMERGENCY anti-noyade (bug #4, vécu ResBot3 keepInv=false : noyade sous un aquifère COUVERT
        // AVANT le warp 3-strikes → perte pioche → starve→respawn). Oxygène CRITIQUE → on warpe DE SUITE
        // (bypass escapeWater + le seuil) : sortir de l'eau prime, une noyade sous keepInventory = catastrophe.
        const _o2 = bot.oxygenLevel;
        const drowning = typeof _o2 === 'number' && _o2 <= 4;
        waterRescue = (async () => {
          if (persistentlyWet || drowning) {
            waterStuckTimes = []; waterEscapeFails = 0;
            emit({ type: 'water_rescue_warp', reason: drowning ? 'drowning' : 'persistent_wet' });
            try { stopMotion(); } catch (e) {}
            // SANS-GIVE : les warps admin (/tp ancre, /spreadplayers) sont BLOQUÉS par nogive → le bot
            // se noyait sans issue (LE tueur du run d'hier). On sort VIVANT via /home safe (goSpawn).
            if (NO_GIVE) {
              // RC3 : safe refusé récemment → le TP ne partira pas, escapeWater est le seul recours.
              if (safeWarpDown()) {
                emit({ type: 'water_rescue_no_warp' });
                try { await escapeWater(bot, { emit }); } catch (e) {}
                return;
              }
              emit({ type: 'water_rescue_home_safe' });
              await safeWarpHome('safe');                 // float+immobile pendant l'éventuel warmup
              return;
            }
            // 1er choix (bot OP historique) : /tp DIRECT vers une ancre profonde SÈCHE déjà minée.
            // Casse la boucle (re-warp surface → re-descente 160 blocs → même aquifère → re-noyade,
            // vécu live ResBot2 : warp dry:false en boucle) ET économise la re-descente (= débit).
            const _cur = bot.entity && bot.entity.position;
            const _anchor = pickDryAnchor(bot._dryAnchors, _cur, 24);
            if (_anchor) {
              emit({ type: 'dry_anchor_warp', x: _anchor.x, y: _anchor.y, z: _anchor.z });
              try { bot.chat('/tp @s ' + _anchor.x + ' ' + _anchor.y + ' ' + _anchor.z); } catch (e) {}
              await sleep(2500);                          // atterrissage (teleport_detected abandonne le goal pathfinder)
            } else {
              await relocateToRegion({ nearSpawn: true }); // pas d'ancre encore → fallback SEC near-spawn (surface)
            }
            return;
          }
          const r = await escapeWater(bot, { emit });
          if (r && r.ok === false) {
            waterEscapeFails += 1;
            if (waterEscapeFails >= 3) {
              waterEscapeFails = 0; waterStuckTimes = [];
              emit({ type: 'water_rescue_warp', reason: 'escape_failed' });
              try { stopMotion(); } catch (e) {}
              if (NO_GIVE) {
                if (safeWarpDown()) { emit({ type: 'water_rescue_no_warp' }); try { await escapeWater(bot, { emit }); } catch (e) {} }
                else { emit({ type: 'water_rescue_home_safe' }); await safeWarpHome('safe'); }
              } else await relocateToRegion({ nearSpawn: true });   // bug #4 : vers le SEC near-spawn (admin)
            }
          } else {
            waterEscapeFails = 0;   // sortie réussie → on reste au fond, pas de warp
          }
        })()
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
      onTeleport: () => { try { stopMotion(); } catch (e) {} _floatSettleUntil = Date.now() + 15000; },
    });
    await tryAuth();
    // ─── WATCHDOG PV « à une seconde de mourir » (warp légitime, NO_GIVE only) ──────────────────
    // Massii : les 3 morts « bêtes » (noyade/suffocation eau, lave, essaim de mobs) doivent être
    // ESQUIVÉES vivant via /home safe (goSpawn) au lieu de laisser mourir. Les autres causes (chute,
    // générique) : on marque le lieu (/sethome death) pour revenir RAMASSER après respawn (cible
    // keepInventory OFF). Remplace les warps admin bloqués. 1 seul warp de sauvetage à la fois.
    if (NO_GIVE) {
      setInterval(() => {
        try {
          if (_imminentBusy || taskToken.cancelled) return;
          // Re-pose d'un safe REFUSÉ — ou JAMAIS POSÉ (spawn les pieds dans l'eau, vécu world_ax2 :
          // la pose au boot est désormais skippée si mouillé) — dès qu'on repasse par une vraie
          // surface sèche : un signet noyé/absent = filet de secours mort pour toute la session.
          if ((_homeRefusedAt.safe || !_safeHomeSet) && bot.entity && bot.entity.position && bot.entity.onGround
              && bot.entity.position.y >= 58 && !isInWater(bot)) {
            homewarp.bookmark(bot, 'safe');
            delete _homeRefusedAt.safe;
            _safeHomeSet = true; _safeHomeSurface = true;
            const pR = bot.entity.position;
            _safeHomePos = { x: pR.x, y: pR.y, z: pR.z };
            emit({ type: 'safe_home_reset', x: Math.round(pR.x), y: Math.round(pR.y), z: Math.round(pR.z) });
          }
          const s = {
            health: bot.health,
            inWater: (function () { try { return isInWater(bot); } catch (e) { return false; } })(),
            oxygen: bot.oxygenLevel,
            lavaNear: (function () { try { return lavaNearby(bot, 2); } catch (e) { return false; } })(),
            nearbyHostiles: (function () { try { return nearbyHostiles(bot, 6).length; } catch (e) { return 0; } })(),
          };
          // Verdict DÉGRADÉ si le /home safe vient d'être refusé : re-spammer un TP qui ne part
          // pas est le no-op qui a zombifié NethBot2 — on se sauve à pied ou on accepte la mort
          // (keepInventory ON : mourir/respawner est PLUS SAIN qu'un stall à 1.8 PV).
          const verdict = homewarp.effectiveVerdict(homewarp.classifyImminent(s), _homeRefusedAt.safe, Date.now());
          if (!verdict) return;
          _imminentBusy = true;
          // CAMP DE MORT (piste n°2) : ≥2 alertes espacées dans la même zone 64 → bannie + FUITE
          // active (vécu Bot2 : 25× imminent au même spot, il RESTAIT sous les coups des mobs armés).
          {
            const pZ = bot.entity && bot.entity.position;
            if (pZ) {
              const dz = deathzones.note(_dzones, pZ.x, pZ.z, Date.now());
              _dzones = dz.zones;
              if (dz.newlyBanned) {
                emit({ type: 'death_camp_ban', x: Math.round(dz.zone.x), z: Math.round(dz.zone.z) });
                if (verdict !== 'escape') fleeDeathCamp(pZ).catch(() => {});   // escape warpe déjà
              }
            }
          }
          if (verdict === 'escape') {
            // Sortir VIVANT du piège (noyade/lave/essaim) → sécurisation (pilier/mur/flottaison)
            // PUIS /home safe (secure-then-warp : sur serveur à warmup, un TP sous les coups est annulé).
            emit({ type: 'imminent_escape', hp: s.health, inWater: s.inWater, lava: s.lavaNear, hostiles: s.nearbyHostiles });
            try { stopMotion(); } catch (e) {}
            safeWarpHome('safe').catch(() => {});
            setTimeout(() => { _imminentBusy = false; }, 12000); // secure (≤6 s) + warmup (≤9 s), anti-spam
          } else if (verdict === 'escape_no_warp') {
            emit({ type: 'imminent_escape_no_warp', hp: s.health, inWater: s.inWater });
            try { stopMotion(); } catch (e) {}
            if (s.inWater) { try { escapeWater(bot, { emit }).catch(() => {}); } catch (e) {} }
            const pN = bot.entity && bot.entity.position;
            if (pN) { homewarp.bookmark(bot, 'death'); _deathMark = { x: pN.x, y: pN.y, z: pN.z, at: Date.now() }; _deathArmed = true; }
            setTimeout(() => { _imminentBusy = false; }, 6000);
          } else {
            // 'bookmark' : mort probable inévitable (chute/générique) → marquer le lieu pour ramassage.
            // DÉDUP anti-spam : ne re-sethome death QUE si on a bougé (>8 blocs) ou après 30 s (le bot
            // peut rester longtemps à PV bas sans mourir — vécu bot1 : 9× re-sethome au même xyz).
            const p = bot.entity && bot.entity.position;
            const now = Date.now();
            const moved = !_deathMark || !p || (Math.abs(p.x - _deathMark.x) + Math.abs(p.z - _deathMark.z)) > 8 || (now - _deathMark.at) > 30000;
            if (moved && p) {
              emit({ type: 'imminent_bookmark_death', hp: s.health, x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) });
              homewarp.bookmark(bot, 'death');
              _deathMark = { x: p.x, y: p.y, z: p.z, at: now };
            }
            _deathArmed = true;
            setTimeout(() => { _imminentBusy = false; }, 4000);
          }
        } catch (e) { _imminentBusy = false; }
      }, 1000);
    }
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
  // ─── Warp légitime (NO_GIVE + MAPPEUR) : home 'safe' surface + récupération post-mort ───────────
  // Le MAPPEUR (Massii live 2026-07-15 : « je ne le vois pas poser l'home et revenir ») pose aussi
  // un home 'safe' de surface au spawn → la nuit il fait /home safe puis s'abrite (cf. maybeNightShelter).
  if (NO_GIVE || IS_MAPPER) {
    // 'safe' = cible de goSpawn. On le pose TOUJOURS (fallback = position de spawn courante, même
    // souterraine → goSpawn a toujours une cible valide) puis on l'UPGRADE dès qu'on spawne à une
    // vraie surface (y≥58, sèche). Sans ça un bot qui respawne toujours sous terre n'avait pas de
    // 'safe' → /home safe échouait (vécu bot1 : spawn direct y15, jamais de safe_home_set).
    // ⚠️ JAMAIS les pieds dans l'eau (vécu world_ax2 03:00 : reconnexion dans une rivière → safe
    // posé DANS l'eau → tous les /home safe morts (teleport-safety) → reflex surface ×190, bots
    // qui sautillent sur place à l'infini). Pas de pose mouillée ; le watchdog 1 s re-pose dès
    // la première surface sèche (condition élargie à !_safeHomeSet).
    {
      const p = bot.entity && bot.entity.position;
      const wet = (function () { try { return isInWater(bot); } catch (e) { return false; } })();
      if (p && !wet) {
        const atSurface = p.y >= 58;
        if (!_safeHomeSet || (!_safeHomeSurface && atSurface)) {
          homewarp.bookmark(bot, 'safe');
          _safeHomeSet = true;
          if (atSurface) _safeHomeSurface = true;
          _safeHomePos = { x: p.x, y: p.y, z: p.z };
          emit({ type: 'safe_home_set', surface: atSurface, x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) });
        }
      }
    }
    // Après une mort MARQUÉE (watchdog PV 'bookmark') : revenir au lieu exact ramasser les drops.
    // No-op propre sous keepInventory ON (0 item au sol) ; opérationnel quand keepInv passera OFF.
    if (_deathArmed) {
      _deathArmed = false;
      (async () => {
        try {
          await sleep(1500);
          emit({ type: 'death_recover_home' });
          homewarp.goHome(bot, 'death');
          await awaitWarp({ maxMs: 8000 }); // atterrissage OU warmup teleport-delay (post-respawn : calme, pas de secure)
          await sleep(1000);                // settle chunks
          await collectDeathDrops();
        } catch (e) { /* best-effort */ }
      })();
    }
  }
  if (world.objective && world.objective.status === 'in_progress') {
    emit({ type: 'autonomous_resume', objective: world.objective.type });
    startAutonomous(null);
  }
}

// Ramasse les items tombés autour de la position courante (post-mort, cible keepInventory OFF).
// keepInv ON → dropsWithin renvoie [] → no-op immédiat. Borné (temps + nb) pour ne pas geler.
async function collectDeathDrops() {
  try {
    const center = bot.entity && bot.entity.position;
    if (!center) return;
    const deadline = Date.now() + 45000;
    for (let i = 0; i < 20 && Date.now() < deadline; i++) {
      const drops = homewarp.dropsWithin(bot.entities, bot.entity.position, 20);
      if (!drops.length) break;
      const e = drops[0].entity;
      if (!e || !e.position) break;
      try {
        await withTimeout(
          bot.pathfinder.goto(new pfGoals.GoalNear(e.position.x, e.position.y, e.position.z, 1)),
          15000, () => { try { stopMotion(); } catch (er) {} });
      } catch (er) { break; }   // inatteignable → on abandonne le ramassage (best-effort)
      await sleep(600);          // laisse la collecte auto (proximité) opérer
    }
    emit({ type: 'death_drops_collected' });
  } catch (e) { /* best-effort */ }
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
// SANS-GIVE : filtre dur sur TOUTE commande sortante (défense en profondeur — même un chemin
// oublié qui tenterait /give //tp //effect est coupé ici, avec un event pour l'observabilité).
// ⚠️ bot.chat n'existe PAS synchroniquement après createBot (injecté par les plugins mineflayer,
// vécu live : TypeError bind of undefined) → on wrappe à `inject_allowed` (tous plugins chargés,
// AVANT le 1er spawn — aucun chat ne part avant).
if (NO_GIVE) {
  bot.once('inject_allowed', () => {
    const _origChat = bot.chat.bind(bot);
    bot.chat = (msg) => {
      if (isForbiddenCheat(msg)) {
        emit({ type: 'cheat_blocked', command: String(msg).trimStart().split(' ')[0] });
        return;
      }
      _origChat(msg);
    };
  });
}
bot.loadPlugin(pathfinder);
bot.loadPlugin(pvp);
bot.loadPlugin(collectBlock);

bot.on('spawn', () => { _floatSettleUntil = Date.now() + 15000; survivalKitUp().catch(() => {}); onSpawn().catch((e) => emit({ type: 'error', message: String((e && e.message) || e) })); });

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
  // capture-clone E : un humain se TOURNE vers son interlocuteur avant de parler (swing, anti snap).
  // Fire-and-forget (n'attend pas le swing pour parler). humanAim only → rétro-compat.
  if (humanAim && reaction.to) {
    const ent = bot.players[reaction.to] && bot.players[reaction.to].entity;
    if (ent && ent.position) { const yp = entityYawPitch(ent.position); if (yp) aimSwingTo(yp.yaw, yp.pitch, 'turn'); }
  }
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
  // RC3 : un /home vient d'être REFUSÉ par la teleport-safety Essentials → le bot n'a PAS bougé.
  // On invalide le home concerné pour que les filets de secours arrêtent de compter dessus :
  // wsite → re-creuser (pas re-TP) ; safe → sauvetage à pied + re-pose à la prochaine surface sèche.
  const refusedH = homewarp.refusedHome(bot, msg);
  if (refusedH) {
    _homeRefusedAt[refusedH] = Date.now();
    emit({ type: 'home_tp_refused', name: refusedH });
    if (refusedH === 'wsite') _wsiteMineSet = false;
    if (refusedH === 'safe') _safeHomeSurface = false;   // le prochain spawn surface re-posera un safe sain
  }
  // Secure-then-warp : serveurs à teleport-delay — warmup annoncé (info) et surtout ANNULATION
  // (le bot a bougé/pris un coup pendant l'attente) → awaitWarp la voit et safeWarpHome re-tente.
  if (homewarp.isTpCancelled(msg)) { _tpCancelledAt = Date.now(); emit({ type: 'home_tp_cancelled' }); }
  else if (homewarp.isTpWarmup(msg)) emit({ type: 'home_tp_warmup' });
  const tpWho = parseTpRequest(msg);
  // Bots du MÊME groupe : confiance mutuelle pour le TP (TP-au-mappeur) — n'élargit PAS le
  // gating des ordres (trusted seul) ni le comportement humain (trusted vide = tous, inchangé).
  const tpTrusted = tpWho && (isTrusted(tpWho, policy.trusted) || (policy.group_bots || []).includes(tpWho));
  if (tpTrusted && isAllowed('/tpaccept', whitelist)) {
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
  // Fix fable1 ter : le camping LENT (zombie sur le spawnpoint, morts espacées 2-7 min — MapperBot2
  // 5 morts/22 min) passait sous le radar du burst <60 s. 3 morts en 10 min = même endroit pourri
  // → warp d'évasion aussi (le shelter post-respawn fait le reste).
  if (burst >= 2 || deathTimes.length >= 3) _escapeOnSpawn = true;
  // Garde-fou ultime (relevé 3→5 : le warp anti-camping gère les boucles courtes) :
  // 5 morts / 10 min → on SORT du process (miroir du starved l.1172) pour laisser le self-healing
  // backend respawner avec un world.json FRAIS (status=in_progress) en ~15 s — inventaire + quota
  // du compte persistent (keepInventory). L'ancienne pause (status='paused' + process VIVANT) était
  // une IMPASSE : le manager ne respawne que sur mort du process → bot idle à vie, quota jamais
  // atteint (bug review #2). NE PAS persister 'paused' avant l'exit (le manager réécrit un world.json
  // frais au respawn ; saveWorld 'paused' empêcherait onSpawn de relancer l'objectif).
  if (deathTimes.length >= 5) {
    taskCtl.cancel();
    emit({ type: 'autonomous_stalled', reason: 'death_loop' });
    process.exit(2);
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
let _jamEsc = null;   // état d'escalade : unjams répétés AU MÊME endroit → relocate forcé (live 22/06 SOIR ResBot2)
setInterval(async () => {
  try {
    if (!bot.entity || !bot.entity.position) return;
    if (Date.now() < _floatSettleUntil) { _jamSample = null; return; }   // settle post-spawn/warp : pas de jam
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
    // ESCALADE : si le dig de l'unjam ne libère pas (jams répétés au MÊME endroit), le bot reboucle
    // droit dans l'obstacle (live 22/06 SOIR ResBot2 : unjam×12 à 381,65,395, 0 descente). Comme les
    // watchdogs flottant/océan, au 3e unjam ~même spot → relocate FORCÉ vers une cellule terre fraîche.
    const _je = recordJam(_jamEsc, p.x, p.z, now);
    _jamEsc = _je.state;
    if (_je.escalate) {
      emit({ type: 'unjam_relocate', x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
      _floatSettleUntil = Date.now() + 15000;
      try { stopMotion(); } catch (e) {}
      relocateToRegion().catch(() => {});
    }
  } catch (e) { /* watchdog : ne crash jamais */ }
}, 6000);

// Anti-stuck FLOTTANT (#8) — ÉTAIT DU CODE MORT : recoverFloating/isFloatingStuck définis+testés
// mais JAMAIS branchés. Le jam-watchdog ci-dessus ne couvre QUE les blocages AVEC goal pathfinder
// actif ; un bot coincé EN L'AIR sans goal (rebord, liane/toile #9, échec de pilier, retombée
// bloquée) n'était jamais récupéré → « se bloque ». Échantillonne pos+sol+eau+vélocité toutes les
// 2 s ; coincé-flottant (≈0 mouvement horizontal ET vy≈0, pas en chute/saut) → relâche tout +
// dégage les lianes + laisse retomber. Borné, ne crash jamais, no-op pendant un dig (légitime).
let _floatPrev = null;
let _floatBusy = false;
let _floatFails = 0;   // recoverFloating ok:false consécutifs → escalade (vécu live ResBot2 : floating
                       // ok:false EN BOUCLE, jamais résolu = blocage §1.5 — il flotte hors d'atteinte du sol)
let _floatHits = 0;    // détections consécutives (exiger 2 = ~4 s) avant d'agir (anti faux-positif transitoire)
let _floatSettleUntil = 0; // horodatage jusqu'auquel on N'ARME PAS la détection (post-spawn/téléport :
                       // chunk en cours de chargement → onGround faux alors que le bot est juste immobile)
// WATCHDOG EAU (run nether, vécu NethBot1 : 12+ min à flotter dans un lac, reflex surface ×192,
// planner muet — le warp de secours est bloqué en sans-give et rien d'autre ne reprenait la main).
// Dans l'eau en CONTINU ≥60 s (30 échantillons) → stopMotion + escapeWater forcé (nage persistante
// vers la terre + pillar-up, borné 60 s), compteur remis à zéro → re-tente au besoin.
let _waterTicks = 0;
let _waterBusy = false;
setInterval(async () => {
  try {
    if (_waterBusy || !bot.entity || !bot.entity.position) return;
    if (!isInWater(bot)) { _waterTicks = 0; return; }
    _waterTicks += 1;
    if (_waterTicks < 30) return;
    _waterTicks = 0;
    _waterBusy = true;
    emit({ type: 'unstuck', cause: 'water_watchdog' });
    try { stopMotion(); } catch (e) {}
    try { await escapeWater(bot, { emit }); } finally { _waterBusy = false; }
  } catch (e) { _waterBusy = false; }
}, 2000);
setInterval(async () => {
  try {
    if (_floatBusy || !bot.entity || !bot.entity.position) return;
    if (bot.targetDigBlock) { _floatPrev = null; _floatHits = 0; return; } // minage sur place = légitime
    // COMBAT sur place = légitime (fix fable1) : frapper immobile ressemble à « floating-stuck »
    // (mvt horizontal ≈0, vy≈0) → recoverFloating COUPAIT la défense en plein assaut (vécu ResBot1 :
    // unstuck cause floating pendant flee ×3 hostiles → slain by Zombie). Hostile ≤4 blocs →
    // détection OFF ; les vrais blocages sont couverts ensuite (jam-watchdog + escalade).
    try {
      const selfP = bot.entity.position;
      const foe = bot.nearestEntity((e) => e && e.position && isFleeHostile(e)
        && (e.position.distanceTo ? e.position.distanceTo(selfP) <= 4 : false));
      if (foe) { _floatPrev = null; _floatHits = 0; return; }
    } catch (e) { /* nearestEntity indispo → détection normale */ }
    // SETTLE post-spawn/téléport : juste après un warp (spawnpoint, /spreadplayers, water-rescue,
    // respawn) le chunk se charge → bot.entity.onGround reste FAUX qq s alors que le bot est immobile
    // en positionnement → FAUX POSITIF floating → recoverFloating coupe le branchMine + ok:false EN
    // BOUCLE → process.exit → respawn même spot → CRASH-LOOP (vécu live ResBot3 : 10→13→16). On laisse
    // la physique se stabiliser avant d'armer la détection.
    if (Date.now() < _floatSettleUntil) { _floatPrev = null; _floatHits = 0; _floatFails = 0; return; }
    const p = bot.entity.position;
    const vy = (bot.entity.velocity && bot.entity.velocity.y) || 0;
    const cur = { x: p.x, z: p.z, t: Date.now() };
    // Sol solide juste sous les pieds ? (anti faux-positif onGround flaky sur terrain solide, vécu live)
    let groundBelow = false;
    try {
      const b = bot.blockAt(vec3Lib(Math.floor(p.x), Math.floor(p.y) - 1, Math.floor(p.z)));
      groundBelow = !!(b && b.boundingBox === 'block');
    } catch (e) { /* blockAt indispo → on laisse la détection normale */ }
    if (isFloatingStuck(_floatPrev, cur, { onGround: !!bot.entity.onGround, inWater: isInWater(bot), vy, groundBelow })) {
      // EXIGER 2 détections consécutives (~4 s de flottement continu) : une seule peut être un
      // transitoire (positionnement en début de branche, micro-lag) et recoverFloating COUPE le
      // goal/mining → on interromprait du minage légitime.
      _floatHits += 1;
      if (_floatHits < 2) { _floatPrev = cur; return; }
      _floatHits = 0;
      _floatPrev = null;
      _floatBusy = true;
      let res;
      try { res = await recoverFloating(bot, { emit }); } finally { _floatBusy = false; }
      // ESCALADE GRADUÉE (ne plus crash-looper) : recoverFloating attend onGround ; s'il flotte coincé
      // (rebord/niche/bulle) il ne retombe jamais → ok:false. 3 échecs → 1 RELOCATE (warp terre fraîche,
      // casse la niche) + settle ; seulement 6 échecs → process.exit en dernier recours (le manager
      // respawne frais). keepInventory garde tout.
      if (res && res.ok === false) {
        _floatFails++;
        if (_floatFails === 3) {
          emit({ type: 'unstuck', cause: 'floating_relocate' });
          _floatSettleUntil = Date.now() + 15000;
          try { stopMotion(); } catch (e) {}
          relocateToRegion().catch(() => {});
        } else if (_floatFails >= 6) {
          emit({ type: 'autonomous_stalled', reason: 'floating_unrecoverable' }); process.exit(2);
        }
      } else { _floatFails = 0; }
      return;
    }
    _floatHits = 0;
    _floatPrev = cur;
  } catch (e) { _floatBusy = false; }
}, 2000);

// H2 — Watchdog ANTI-OSCILLATION-OCÉAN : un bot qui nage en SURFACE d'un océan profond garde son O2
// plein → toute la chaîne d'évasion (gated sur la baisse d'oxygène) ne se déclenche JAMAIS → allers-
// retours sans progrès (vécu live ResBot1 figé à 11, diamants gelés). Aucun bot ne doit entrer/rester
// dans un océan ni y construire un pont. Détection : in-water + AUCUNE terre ferme à ≤24 (sinon =
// rivière/rivage, se traverse à la nage → on n'agit pas) + <12 blocs de progrès NET sur 20 s → escapade
// + relocate FORCÉ vers la terre (relocateToRegion filtre déjà ocean/river/beach). Settle-aware (pas
// de double-warp post-spawn). Borné, ne crash jamais.
let _oceanBusy = false;
let _oceanSample = null;
let _oceanStuckTimes = [];   // horodatages ocean_stuck (fenêtre 3 min) : baie PERSISTANTE → relocate forcé
setInterval(async () => {
  try {
    if (Date.now() < _floatSettleUntil) { _oceanSample = null; return; }   // settle post-spawn/warp
    if (_oceanBusy || !bot.entity || !bot.entity.position) return;
    if (bot.targetDigBlock) { _oceanSample = null; return; }               // minage sur place = légitime
    if (!isInWater(bot)) { _oceanSample = null; return; }
    if (findLandTarget(bot, 24)) { _oceanSample = null; return; }          // terre proche → rivière, nage seul
    const p = bot.entity.position; const now = Date.now();
    if (!_oceanSample) { _oceanSample = { x: p.x, z: p.z, t: now }; return; }
    if (now - _oceanSample.t < 20000) return;                              // fenêtre 20 s
    const d = Math.sqrt((p.x - _oceanSample.x) ** 2 + (p.z - _oceanSample.z) ** 2);
    if (d >= 12) { _oceanSample = { x: p.x, z: p.z, t: now }; return; }    // progrès net → resample
    // océan confirmé : in-water, pas de terre à 24, <12 blocs nets en 20 s = oscillation
    _oceanSample = null; _oceanBusy = true;
    try {
      emit({ type: 'ocean_stuck', x: Math.floor(p.x), z: Math.floor(p.z) });
      // Persistance : escapeWater sort le bot à CHAQUE tour → le warp gaté sur isInWater ne se
      // déclenchait jamais alors qu'il re-ciblait la même baie humide en boucle (live ResBot1 : 0 minage,
      // unjam×7). Au 2e ocean_stuck en 3 min, la baie est PERSISTANTE → relocate forcé (oceanEscalate.js).
      const _esc = recordOceanStuck(_oceanStuckTimes, Date.now());
      _oceanStuckTimes = _esc.times;
      try { stopMotion(); } catch (e) {}
      try { await escapeWater(bot, { emit, maxDistance: 64 }); } catch (e) {}
      if (isInWater(bot) || _esc.forceRelocate) {                          // noyé OU baie persistante → terre ferme
        _floatSettleUntil = Date.now() + 15000;
        emit({ type: 'water_rescue_warp', reason: isInWater(bot) ? 'ocean_oscillation' : 'ocean_persistent' });
        try { stopMotion(); } catch (e) {}
        if (NO_GIVE) {
          if (safeWarpDown()) { emit({ type: 'water_rescue_no_warp', ctx: 'ocean' }); try { await escapeWater(bot, { emit }); } catch (e) {} }
          else { emit({ type: 'water_rescue_home_safe', ctx: 'ocean' }); await safeWarpHome('safe'); }
        }
        else { try { await relocateToRegion(); } catch (e) {} }
        _oceanStuckTimes = [];                                            // post-relocate : compteur propre
      }
    } finally { _oceanBusy = false; }
  } catch (e) { _oceanBusy = false; }
}, 5000);

// Watchdog connexion : un « Timed out » côté serveur peut laisser le socket client MUET sans
// event 'end' (vécu phase 2 : bot zombie, quota figé, jamais respawné). Pas de physicsTick
// pendant 90 s → on se suicide proprement, le manager auto-respawne la session resource.
let _lastTick = Date.now();
bot.on('physicsTick', () => {
  _lastTick = Date.now();
  // bug #2 (Massii) : pendant un DIG actif, FORCER jump OFF — le bot sautait en minant (parkour
  // résiduel pathfinder/collectBlock) → le bloc sortait de portée → dig avorté + diamant laissé.
  // Le dig se fait à l'arrêt à sa position → couper le saut est sûr. setControlState n'émet qu'au changement.
  if (bot.targetDigBlock) { try { bot.setControlState('jump', false); } catch (e) {} }
});
// Monté dans un BATEAU, mineflayer n'émet plus physicsTick (la physique vient du véhicule) —
// le watchdog tuait le bot en pleine traversée (vécu live 2026-07-15, cycles 90 s). L'event 'move'
// (position poussée par le serveur) prouve aussi que la connexion vit.
bot.on('move', () => { _lastTick = Date.now(); });
setInterval(() => {
  if (Date.now() - _lastTick > 90000) {
    emit({ type: 'error', message: 'connection_watchdog: 90s sans tick' });
    process.exit(1);
  }
}, 30000);

// TIMER ARMURE (Massii survie #1, hole A/D) : ensureArmor était appelé au HAUT de la boucle, qui
// n'itère quasi jamais (le bot passe ~tout son temps DANS mineForType/branchMine ≤900s) → 0 armure
// craftée live malgré le fer plein. Timer INDÉPENDANT : toutes les 90 s, hors dig, pour TOUT bot
// exposé en profondeur (resource | diamond | mapper), si une pièce d'armure manque et que le fer
// dépasse le buffer → en craft/équipe UNE. ironKeep=8 pour resource (a un quota fer à préserver),
// 0 sinon (mappeur/diamant : l'armure PRIME, aucun fer à garder). Borné, best-effort, jamais throw ;
// n'interrompt pas un dig en cours (immobile = légitime).
const _ARMOR_TIMER_OBJ = new Set(['resource', 'diamond', 'mapper']);
let _armorBusy = false;
setInterval(async () => {
  try {
    if (_armorBusy) return;
    const objType = (world.objective && world.objective.type) || '';
    if (!_ARMOR_TIMER_OBJ.has(objType)) return;
    if (bot.targetDigBlock) return;                       // pas en plein minage
    if (taskToken && taskToken.cancelled) return;
    const worn = _wornArmor();
    if (ARMOR_PIECES.every((pc) => worn.has(pc.name))) {  // set complet → équipe juste un éventuel reliquat
      const sh = ((bot.inventory && bot.inventory.items()) || []).find((i) => i.name === 'shield');
      if (sh) { try { await bot.equip(sh, 'off-hand'); } catch (e) {} }
      return;
    }
    const ironKeep = objType === 'resource' ? 8 : 0;
    _armorBusy = true;
    await withTimeout(ensureArmor({ ironKeep }), 150000, () => { try { stopMotion(); } catch (e) {} });
  } catch (e) { /* timer : ne crash jamais */ }
  finally { _armorBusy = false; }
}, 90000);

// FONTE OPPORTUNISTE (piste n°1 rapport water-wall) : le but smeltIron de la chaîne n'arrivait
// jamais (mort/reboucle avant) alors que fer+fuel+four convergeaient en poche (Bot2 : 9 raw_iron
// + four + bois, 0 lingot au bilan NBT). Timer INDÉPENDANT du planner, même esprit que le timer
// armure : dès (raw_iron≥3 ET furnace en poche ET fuel — planches/bûches acceptées), fondre UNE
// passe bornée (≤8) N'IMPORTE OÙ (le four portable se pose au fond du branch-mine).
const _SMELT_TIMER_OBJ = new Set(['resource', 'diamond', 'iron_armor', 'diamond_armor']);
setInterval(async () => {
  try {
    if (_smeltOppBusy || _armorBusy || _stillBusy || _imminentBusy) return;   // jamais pendant un sauvetage PV
    const objType = (world.objective && world.objective.type) || '';
    if (!_SMELT_TIMER_OBJ.has(objType)) return;
    if (!(world.objective && world.objective.status === 'in_progress')) return;
    if (bot.targetDigBlock) return;                        // pas en plein minage
    if (taskToken && taskToken.cancelled) return;
    const items = ((bot.inventory && bot.inventory.items()) || []).map((i) => ({ name: i.name, count: i.count }));
    const plan = smeltPlan(items);
    if (!plan.go) return;
    // POSE FIABLE (fix live 15/07) : le four portable ne se pose pas en eau / en l'air / en plein
    // pathfinding (vécu NethBot3 : opportunistic_smelt ok:false + armor_smelt no_furnace en surface
    // mouillée). On attend un sol stable et immobile — la prochaine passe (60 s) réessaiera.
    const _stable = {
      onGround: !!(bot.entity && bot.entity.onGround),
      inWater: (function () { try { return isInWater(bot); } catch (e) { return false; } })(),
      moving: !!(bot.pathfinder && bot.pathfinder.isMoving && bot.pathfinder.isMoving()),
    };
    if (!smeltReady(_stable)) return;
    _smeltOppBusy = true;
    const r = await withTimeout(smeltWithFurnace('raw_iron', 'iron_ingot', plan.count), 200000,
      () => { try { stopMotion(); } catch (e) {} });
    emit({ type: 'opportunistic_smelt', count: plan.count, ok: !!(r && r.ok), reason: (r && r.reason) || null });
  } catch (e) { /* best-effort : jamais throw depuis un timer */ }
  finally { _smeltOppBusy = false; }
}, 60000);

// WATCHDOG DESYNC (piste n°5) : position identique AU DIXIÈME pendant 5 min avec un planner qui
// tourne = client désynchronisé OU PIÉGEAGE PHYSIQUE (îlot/encoignure — vidéo Massii 16/07 :
// MapBot1 coincé sur un îlot d'un bloc, bateau raté à côté). exit(3) seul ne règle PAS le
// piégeage : le bot se reconnecte AU MÊME ENDROIT → boucle. D'abord une ÉVASION (warp légitime :
// /home safe en no-give, /spreadplayers relocate en admin — le TP force aussi un position-sync
// qui répare souvent le desync client) ; l'exit(3) reste le dernier recours si l'évasion échoue.
let _desyncEscapeAt = 0;
setInterval(async () => {
  try {
    if (!(world.objective && world.objective.status === 'in_progress')) { _posSamples = []; return; }
    // Immobilités légitimes LONGUES (fonte ≤3 min, abri ≤13 min, armure) → reset. Le DIG n'en est
    // PLUS une (vécu world_ax2 : 3 bots gelés EN PLEIN minage, targetDigBlock figé → l'ancien
    // reset rendait le desync invisible) → on échantillonne quand même, fenêtre doublée (10 min).
    if (_stillBusy || _smeltOppBusy || _armorBusy) { _posSamples = []; return; }
    const p = bot.entity && bot.entity.position;
    if (!p) return;
    _posSamples.push({ x: p.x, y: p.y, z: p.z });
    if (_posSamples.length > 20) _posSamples.shift();
    if (isFrozenDesync(_posSamples, { digging: !!bot.targetDigBlock })) {
      const nowD = Date.now();
      if (nowD - _desyncEscapeAt > 600000) {
        _desyncEscapeAt = nowD;
        emit({ type: 'desync_escape', x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) });
        try { stopMotion(); } catch (e) {}
        try { bot.clearControlStates(); } catch (e) {}
        try {
          if (NO_GIVE) await safeWarpHome('safe');
          else await relocateToRegion();
        } catch (e) { /* best-effort */ }
        const q = bot.entity && bot.entity.position;
        const last = _posSamples.length ? _posSamples[_posSamples.length - 1] : null;
        _posSamples = [];
        if (q && last && Math.hypot(q.x - last.x, q.y - last.y, q.z - last.z) > 8) {
          emit({ type: 'desync_escaped' });   // sorti du piège SANS respawn (position a bougé)
          return;
        }
      }
      emit({ type: 'desync_frozen', x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z), digging: !!bot.targetDigBlock });
      process.exit(3);
    }
  } catch (e) { /* watchdog : ne crash jamais */ }
}, 30000);

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
      // Capture-clone étape D : si --clips, REJOUER la motricité de visée HUMAINE RÉELLE (Δyaw/Δpitch
      // du clip idle — degrés → radians ×DEG) ; sinon le MODÈLE nextLook (étape C). « La copie » :
      // on reproduit COMMENT l'humain bougeait la caméra, pas une courbe lisse de bot.
      const _clip = clipPlayer ? clipPlayer.next('idle') : null;
      if (_clip) {
        const DEG = Math.PI / 180;
        const yaw = cur.yaw + (_clip.dyaw || 0) * DEG;
        let pitch = cur.pitch + (_clip.dpitch || 0) * DEG;
        pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, pitch));   // borne pitch (±90°)
        bot.look(yaw, pitch, false);
      } else {
        const nx = nextLook(cur, humanizeParams, Math.random, { mode: 'idle' });   // capture-clone : visée ∝ jitter humain
        bot.look(nx.yaw, nx.pitch, false);
      }
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
