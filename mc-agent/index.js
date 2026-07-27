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
const { installReflexes, RANGED, DEFENSIVE_HEALTH, isFleeOnlyMob, FOODS, EMERGENCY_FOODS } = require('./reflexes');
const { decideReaction } = require('./triggers');
const { loadCommands, isAllowed, buildCommandDocs } = require('./commands');
const { loadPolicy, isTrusted, parseTpRequest, parseTradeRequest, gateDecision, buildTrustDocs } = require('./trust');
const { parseOrder } = require('./orders');
const { createTaskController } = require('./tasks');
const { createMemory } = require('./memory');
const { bestWeapon, bestToolFor } = require('./tools');
const { shouldSprint, applyPathfinderBounds } = require('./movement');   // sprint « vrai joueur » ON par défaut (Massii 2026-06-22) + bornage A* (anti-OOM 2026-07-25)
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
const { chainFor, buildCtxInv, firstUnmet, cookedCount, armorNeed, nextObjectiveAfter, wantsOpportunisticArmor } = require('./goals');
const { isForbiddenCheat } = require('./nogive');
const homewarp = require('./homewarp'); // couche warp LÉGITIME sans-give (/sethome+/home ; goSpawn=/home safe)
const { secureSpot } = require('./skills/secureSpot'); // secure-then-warp : pilier/se murer/flotter AVANT le /home
const { SCAFFOLD } = require('./skills/pillarUp');     // blocs sacrifiables (comptés pour la tactique)
const basecamp = require('./basecamp');                // base personnelle : s'éloigner du spawn du monde puis /sethome
const oregrab = require('./oregrab');                  // « ils passent à côté du fer sans le prendre »
const { huntPassive } = require('./skills/hunt');
const { nearestPassive, survivalTick, nearbyHostiles, lavaNearby, armorPoints, weaponDamage } = require('./survival');
const { loadWorld, saveWorld, setObjective, clearObjective } = require('./worldModel');
const { _nearestTable, tablePlan, TABLE_REACH, TABLE_SEEK } = require('./skills/craft'); // craftItem déjà importé plus haut
const { placeBlockNear } = require('./skills/placeBlockNear');
const { smelt, logsToConvert } = require('./skills/smelt');
const { descendDiagonal } = require('./skills/descendDiagonal');
const { pickWornOutToReport } = require('./wornOut');
const { branchMine, floodFillVein } = require('./skills/branchMine');
const { caveHunt } = require('./skills/caveHunt');   // cave-first diamant (Massii 26/07)
const { classifyAuthPrompt, genPassword, resolveAuthChat } = require('./auth');
const { loadMemory, worldKey, resolveBiome } = require('./worldMemory');
const { driestCell, oreBase } = require('./ores');         // warp near-spawn DRY-AWARE + normalisation type (fix #8)
const { recordAnchor, pickDryAnchor } = require('./anchors'); // ancres profondes SÈCHES (anti boucle de noyade)
const { runMapper } = require('./mapper');
// (LOCATE_KINDS / parseLocateResponse ne sont plus importés : /locate est retiré des bots, cf. plus bas.
//  structureFoundEvent est émis par mapper.js depuis les signatures VUES.)
const { isInWater, escapeWater, findLandTarget, isFloatingStuck, recoverFloating, isFrozenDesync } = require('./unstuck');
const deathzones = require('./deathzones'); // ban-zone des camps de mort (≥2 alertes → fuite active)
const { recordOceanStuck } = require('./oceanEscalate'); // baie humide PERSISTANTE → relocate forcé (live 22/06 ResBot1)
// Verdict de zone + migration autonome (Massii 27/07). L'état de zone est PERSISTÉ (zoneState*) :
// en mémoire de process, son horloge repartait à zéro à chaque respawn et l'hystérésis de 15 min
// n'était jamais atteinte — c'est pourquoi la migration n'a jamais tiré de la journée.
const {
  zoneVerdict, verdictTelemetry, pickMigrationTarget, migrationLeg, legIsGood, minDistFor,
  zoneFailureKind, zoneStateInit, zoneStateLoad, zoneStateAfterMigration, MAX_LEGS, MIGRATE_MIN_PROGRESS,
} = require('./zone');
const { recordWorkDrown, noteDrownedSite, isDrownedNear, offsetFromDrowned } = require('./workDrown'); // chantier adjacent à un aquifère → abandon + BANNISSEMENT du lieu (3a)
const { recordWorkStuck } = require('./workStuck'); // chantier menant à une impasse SÈCHE (drop_ahead/max_depth) → abandon+relocate (live 27/07 world_mn9)
// SYSTÈME À 3 HOMES (Massii 27/07) : safe = LA BASE, work = le chantier courant, death = la dette
// de mort. Le serveur n'autorise que 3 homes et le code en posait 4 → un /sethome échouait EN
// SILENCE sur chaque bot (bug prouvé world_mn5). Voir homes.js.
const { HOME_SAFE, HOME_WORK, HOME_DEATH, LEGACY_HOMES, canBookmarkDeath, openDebt, debtAction, isSurfaceSpot, SAFE_HOME_MIN_Y } = require('./homes');
const { recordJam } = require('./jamEscalate'); // JAM persistant au MÊME endroit → relocate forcé (live 22/06 SOIR ResBot2)
const { runResource } = require('./skills/resource');
const { planSmeltRaw } = require('./bank');   // fonte périodique du brut or/fer → lingots bankables
const { tunnelTo } = require('./skills/tunnelTo');
const { junkItems, ITEMS_FOR } = require('./quota');
const { Y_OPT, pickaxePlan, armorPlan, ARMOR_PIECES, bestArmorToEquip, armorUpgradePlan, isMinimallyArmored, shieldPlan, smeltPlan, smeltReady, isNearlyBroken } = require('./gear');
// Torche tous les N paliers de branch-mine (mob-aware phase B) — best-effort : sans torche
// en poche le minage continue sans (zéro coût en peaceful, sécurité en non-pacifique).
const TORCH_EVERY = 8;
const { createClaims, createPresence } = require('./claims');
const { pickMapperTp } = require('./mapperTp'); // TP-au-mappeur : à qui demander le /tpa (décision pure)
// REGROUPEMENT APRÈS MORT (idée Massii 25/07, flag --regroup, OFF par défaut) : décision pure.
const { pickRegroupTarget, squadTarget } = require('./regroup');
// ENTRAIDE D'ÉQUIPE (Massii 25/07 : « qu'ils s'aident entre eux, et quand ils ont l'armure
// fer ils se séparent »). Décisions PURES ; l'exécution (marche + toss) est ci-dessous.
const { teamStatus, pickDonation, allArmored, pickMobAssist, pickMapperToEquip, giftSetPlan } = require('./teamwork');
const { tierRank } = require('./tools');
const { createTeleportWatcher, wireTeleportDetection } = require('./teleport');
const { isNight, shelterUntilDawn, shouldShelter } = require('./skills/shelter');
const { maybeRunKit } = require('./kit');   // survie mappeur : /kit serveur au démarrage/respawn (décision pure)
const { needDirtBuffer } = require('./dirt');   // survie mappeur : buffer de blocs posables pour sceller l'abri
const { panicWall } = require('./skills/panicWall');
// COUVERT anti-squelette (tueur n°1 des bots nus, preuve live world_ax4 25/07) : couper la
// ligne de vue d'un tireur au lieu de charger/fuir à découvert. Décision pure dans cover.js.
const { shouldTakeCover } = require('./cover');
// DISCIPLINE DE TORCHE calée sur la capture réelle (131/97 torches en 33 min chez les humains,
// torche en main ~10 % du temps) — le bot n'éclairait QUE le tunnel de branch-mine.
const { shouldPlaceTorch } = require('./torches');
const { takeCover, pickCoverBlock } = require('./skills/takeCover');

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
// --regroup : après une mort, rejoindre le groupe en /tpa tant que l'armure fer n'est pas là
// (idée Massii 25/07). ÉTEINT par défaut — à activer explicitement, run par run.
const REGROUP = args.regroup === '1' || args.regroup === 'true';
// Confinement arène (--confine "X Z R") : garde le bot dans R de l'ancre sèche (cf. confine.js).
const { parseConfine, confineSpreadCommand, CONFINE_HOME, DEFAULT_CONFINE_RADIUS, shouldEnforceConfine, pickAnchorNow, canAnchorHere, effectiveConfine } = require('./confine');
let CONFINE = parseConfine(args['confine']);   // ← 'let' : la base PERSISTEE le remplace au boot (effectiveConfine)
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
let _deathDebtBusy = false;   // une seule récupération de dette en vol (le respawn peut se répéter en rafale)
// Buts qui exigent du BOIS ou une TABLE : introuvables sous terre (cf. wood_trip ci-dessous).
const WOOD_GOALS = new Set(['logs', 'planks', 'plank_buffer', 'crafting_table', 'sticks', 'wooden_pickaxe']);
let _lastWoodTripAt = 0;      // cooldown 2 min : un aller-retour surface ne doit pas boucler
let _workSet = false;    // NO_GIVE : chantier profond SEC mémorisé (/sethome work) → re-descente = /home work (1 tp)
                              // au lieu de re-creuser ~52 blocs (chaque re-descente cassait une pioche → no_pickaxe → fer jamais accumulé, vécu homedeath)
let _workDrownTimes = [];    // horodatages des sauvetages-noyade RAMENANT au chantier (live 27/07 world_mn9) : au seuil,
                              // le chantier est adjacent à un aquifère → on l'abandonne (cf. workDrown.js). Reset par spawn + bookmark frais.
let _workStuckTimes = [];    // horodatages des échecs de descente SECS (drop_ahead/max_depth/…) via le chantier (live 27/07
                              // world_mn9 : NethBot4 en boucle 15× descend_via_home_work→drop_ahead) : au seuil, le chantier mène
                              // à une impasse sèche → on l'abandonne + relocate (cf. workStuck.js). Reset par spawn + bookmark frais.
// Un sauvetage-noyade (/home safe) ramenant à un chantier mémorisé : si ça se répète (aquifère adjacent),
// on OUBLIE le chantier (même effet que waterlocked_relocate) → la re-descente creuse un puits frais ailleurs,
// au lieu de /home work → re-noyade en boucle (mesuré : 3/5 workers, 118 sauvetages, 0 minerai).
let _drownedSites = [];       // chantiers PROUVÉS noyés : on refuse d'y re-creuser (3a, cf. workDrown.js)
let _drownedOffsetSeed = 0;   // fait TOURNER le cap du décalage : re-tenter le même cap = même nappe
let _drownedRelocate = null;  // point de re-pose imposé après une noyade (décalage 30-50 blocs)
let _workPos = null;          // position du chantier courant (pour bannir le BON endroit)

/** Position horizontale courante du bot, ou null. */
function _botXZ() {
  const p = bot.entity && bot.entity.position;
  return p ? { x: p.x, z: p.z } : null;
}

function abandonWorkIfDrowned() {
  if (!_workSet) { _workDrownTimes = []; return; }
  const r = recordWorkDrown(_workDrownTimes, Date.now());
  _workDrownTimes = r.times;
  if (!r.abandon) return;
  _workSet = false;
  // 3a : BANNIR le lieu, pas seulement l'oublier. L'oubli seul laissait la re-descente re-percer
  // le MÊME aquifère quelques blocs plus loin — mesuré : 118 sauvetages, 0 minerai.
  const now = Date.now();
  const site = _workPos || (bot.entity && bot.entity.position);
  if (site) {
    _drownedSites = noteDrownedSite(_drownedSites, site, now);
    _drownedOffsetSeed += 1;
    const off = offsetFromDrowned(site, _drownedOffsetSeed);
    _drownedRelocate = off;                 // la prochaine descente partira de LÀ, pas d'ici
    emit({
      type: 'work_abandoned_drowning',
      x: Math.round(site.x), z: Math.round(site.z), toX: off.x, toZ: off.z,
    });
  } else {
    emit({ type: 'work_abandoned_drowning' });
  }
  _descendWaterFails += 1;   // arme le relogement (même effet que waterlocked_relocate)
  _zoneWaterFails += 1;      // ET alimente le verdict de ZONE : chantier noyé → zone peut-être noyée
}
let _drySteerTries = 0;       // NO_GIVE : marches tentées vers la cellule 128 sèche (arrivée VÉRIFIÉE, ≤3 —
                              // vécu live NethBot2 : goto interrompu par un réflexe → « arrivé » à 180 blocs
                              // de la cible avec l'ancien one-shot → descente en zone humide quand même)
let _wornOutReported = new Set();     // pièces d'ARMURE déjà signalées gear_worn_out (dédup, cf. wornOut.js)
let _offhandWornReported = new Set();  // idem pour la MAIN SECONDAIRE (bouclier usé)
let _deathMark = null;        // dernière position marquée death {x,y,z,at} → dédup anti-spam du watchdog
let _imminentBusy = false;    // anti-rafale : un seul warp de sauvetage PV à la fois
let _homeRefusedAt = {};      // RC3 : refus TP Essentials par home {safe|chantier|death → ts} — un /home
                              // refusé (« destination unsafe », monde noyé) ne téléporte PAS : sans ça
                              // le filet de secours était un no-op silencieux (zombie 1.8 PV, vécu NethBot2)
// Le /home safe est-il inutilisable en ce moment (refus récent, pas encore re-posé) ?
function safeWarpDown() {
  return !!(_homeRefusedAt.safe && (Date.now() - _homeRefusedAt.safe) <= homewarp.REFUSAL_DEGRADE_MS);
}
let _tpCancelledAt = 0;       // secure-then-warp : dernière annulation Essentials vue (teleport-delay)
let _confineDyn = null;       // confine AUTO-ancré (brique 2) : posé à la 1re terre sèche stable
let _anchorSet = false;      // home 'ancre' posé à l'ancre → l'enforcement /home peut tirer
let _lastConfineEnforceAt = 0;// cooldown enforcement (2 min, cf. shouldEnforceConfine)
let _campEstablished = false; // brique 3 : four (+coffre) posés à l'ancre = camp de base
let presence = null;          // heartbeat de présence du groupe (positions-<group>.json, --positions)
let _lastMapperTpAt = 0;      // TP-au-mappeur : cooldown (1 tentative / 4 min)
let _dzones = [];             // camps de mort : zones où ≥2 alertes « mort imminente » (deathzones.js)
let _safeHomePos = null;      // coords du dernier /sethome safe (pour fuir VERS lui si hors zone bannie)
let _posSamples = [];         // desync-watchdog : échantillons de position (30 s × 10 = 5 min)
let _stillBusy = false;       // immobilité LÉGITIME en cours (fonte au four, abri nocturne) — gate desync
let _smeltOppBusy = false;    // fonte opportuniste : une seule passe à la fois
let panicInFlight = false;    // garde de ré-entrée onPanic. DOIT rester au niveau module : les gates
                              // survie (l. ~3713/3792/3811) la lisent HORS de onSpawn — déclarée en
                              // `let` dans onSpawn elle levait un ReferenceError qui TUAIT le process
                              // au 1er tick du timer (vécu : les 3 workers morts en boucle, run Minestrator)

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

// CAMP DE BASE (brique 3 v1, Massii 16/07) : à l'ancre, poser un FOUR (fixe, jamais reclaim —
// smeltWithFurnace l'utilise sans le poser quand il le trouve à ≤4) + un COFFRE si en poche.
// Le camp rend la poche auto-suffisante : fonte fiable au même endroit, stock au retour. Best-effort
// intégral, ré-essayé par le timer d'enforcement tant que pas établi.
async function tryEstablishCamp() {
  try {
    if (_campEstablished || !_anchorSet) return;
    const conf = CONFINE || _confineDyn;
    if (!conf) return;
    const p = bot.entity && bot.entity.position;
    if (!p || Math.hypot(p.x - conf.x, p.z - conf.z) > 24) return;   // seulement près de l'ancre
    for (const it of ['furnace', 'chest']) {
      const def = bot.registry.blocksByName[it];
      if (!def) continue;
      if (bot.findBlock({ matching: [def.id], maxDistance: 8 })) continue;   // déjà posé au camp
      const has = ((bot.inventory && bot.inventory.items()) || []).some((i) => i.name === it);
      if (!has) continue;
      try {
        const r = await placeBlockNear(bot, it);
        if (r && r.ok) emit({ type: 'camp_block_placed', block: it });
      } catch (e) { /* best-effort */ }
    }
    const fdef = bot.registry.blocksByName.furnace;
    if (fdef && bot.findBlock({ matching: [fdef.id], maxDistance: 8 })) {
      _campEstablished = true;
      emit({ type: 'camp_established', x: conf.x, z: conf.z });
    }
  } catch (e) { /* best-effort */ }
}

// ENFORCEMENT confine no-give (brique 1) : le bot a dérivé hors de sa poche (> rayon ×1.25) →
// /home ancre (commande joueur, secure-then-warp inclus). C'est CE retour qui casse le pattern
// mortel « atteint iron_deep → explore loin → eau → churn » (vécu world_ax2 toute la nuit).
setInterval(() => {
  try {
    const conf = CONFINE || _confineDyn;
    if (!conf || !_anchorSet || !NO_GIVE) return;
    if (!(world.objective && world.objective.status === 'in_progress')) return;
    const p = bot.entity && bot.entity.position;
    if (!p) return;
    if (!_campEstablished) tryEstablishCamp().catch(() => {});    // retry léger du camp
    // `_migrating` DOIT compter comme occupé : sinon l'enforcement yank le marcheur vers l'ancre
    // qu'on est précisément en train de quitter (même classe que les autres gardes busy).
    const busy = !!bot.targetDigBlock || _stillBusy || _imminentBusy || _smeltOppBusy || _armorBusy || _migrating;
    const dist = Math.hypot(p.x - conf.x, p.z - conf.z);
    if (shouldEnforceConfine({ dist, radius: conf.radius, busy, now: Date.now(), lastAt: _lastConfineEnforceAt })) {
      _lastConfineEnforceAt = Date.now();
      emit({ type: 'confine_enforce', dist: Math.round(dist), x: conf.x, z: conf.z });
      safeWarpHome(CONFINE_HOME).catch(() => {});
    }
  } catch (e) { /* watchdog : ne crash jamais */ }
}, 45000);

// VERDICT DE ZONE (Massii 27/07) : « le fer et les autres matériaux ne sont pas qu'au spawn ».
// Toutes les 60 s on juge la zone COURANTE sur ses compteurs ; l'hystérésis (15 min sur place) et
// le cooldown (20 min entre deux migrations) vivent dans zone.zoneVerdict — sans eux la flotte
// deviendrait nomade et ne produirait plus rien.
setInterval(() => {
  try { checkZoneVerdict(); } catch (e) { /* watchdog : ne crash jamais */ }
}, 60000);

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

// REGROUPEMENT APRÈS MORT (--regroup, OFF par défaut). Avec keepInventory, mourir ne coûte
// presque rien : ce qui tue une 2e fois, c'est le RETOUR à pied (200-400 blocs sous les mobs).
// Un /tpa vers le coéquipier le plus proche supprime ce trajet — 100 % « vrai joueur », et /tpa
// passe le filtre sans-give (≠ /tp<espace>). S'éteint tout seul dès que l'armure fer est portée
// (règle Massii : le groupe ne sert que jusque-là). Décision pure : regroup.pickRegroupTarget.
let _lastRegroupAt = 0;
async function tryRegroup() {
  if (!REGROUP) return { ok: false, reason: 'disabled' };
  if (!presence) return { ok: false, reason: 'no_presence' };
  const p = bot.entity && bot.entity.position;
  if (!p) return { ok: false, reason: 'no_pos' };
  let armorComplete = false;
  try { armorComplete = armorNeed({ inv: buildCtxInv(bot), worn: [..._wornArmor()] }, 3) === 0; } catch (e) {}
  const pick = pickRegroupTarget({
    self: { x: p.x, z: p.z }, selfName: bot.username, mates: presence.list(),
    armorComplete, now: Date.now(), lastAt: _lastRegroupAt,
  });
  if (!pick) return { ok: false, reason: 'no_candidate' };
  if (!isAllowed('/tpa ' + pick.name, whitelist)) {
    emit({ type: 'regroup_blocked', to: pick.name });      // /tpa pas coché dans le profil serveur
    return { ok: false, reason: 'not_whitelisted' };
  }
  _lastRegroupAt = Date.now();
  emit({ type: 'regroup_tpa', to: pick.name, dist: pick.dist });
  try { stopMotion(); } catch (e) {}
  try { bot.chat('/tpa ' + pick.name); } catch (e) { return { ok: false, reason: 'chat_failed' }; }
  const r = await awaitWarp({ maxMs: 15000 });
  emit({ type: 'regroup_result', to: pick.name, warped: !!r.warped });
  return { ok: !!r.warped };
}

// SQUAD — rester ENSEMBLE en continu (Massii 2026-07-26 : « ils ne sont toujours pas ensemble,
// j'ai vraiment envie qu'ils soient une petite squad qui reste ensemble »). Différence avec
// tryRegroup, qui ne servait qu'après une mort : chef DÉTERMINISTE (tout le monde converge au même
// point au lieu de se courir après) et seuil serré (64 blocs, 60 s) au lieu de 120 blocs / 2 min.
let _lastSquadAt = 0;
async function trySquad() {
  if (!REGROUP || !presence) return { ok: false, reason: 'disabled' };
  const p = bot.entity && bot.entity.position;
  if (!p) return { ok: false, reason: 'no_pos' };
  let armorComplete = false;
  try { armorComplete = armorNeed({ inv: buildCtxInv(bot), worn: [..._wornArmor()] }, 3) === 0; } catch (e) {}
  // Minage/tâche longue en cours → on ne yanke pas (piège #42c). Même jeu de gardes que
  // l'enforcement confine (bot.targetDigBlock + immobilités légitimes) : le squad était le SEUL
  // mécanisme de tp sans ce garde-fou → il rejetait les branchMine des workers toutes les ~30 s.
  const busy = !!bot.targetDigBlock || _stillBusy || _imminentBusy || _smeltOppBusy || _armorBusy;
  const pick = squadTarget({
    // `y`/`ironZone` de SOI : sans eux un mineur productif se croirait « rien du tout » et
    // remonterait rejoindre un flâneur resté en surface — l'inverse exact du but.
    self: { x: p.x, z: p.z, y: Math.round(p.y), ironZone: _zoneIronMined },
    selfName: bot.username, mates: presence.list(),
    armorComplete, busy, now: Date.now(), lastAt: _lastSquadAt,
  });
  if (!pick) return { ok: false, reason: 'no_need' };
  if (!isAllowed('/tpa ' + pick.name, whitelist)) {
    emit({ type: 'squad_blocked', to: pick.name });          // /tpa pas coché dans le profil serveur
    return { ok: false, reason: 'not_whitelisted' };
  }
  _lastSquadAt = Date.now();
  emit({ type: 'squad_join', to: pick.name, dist: pick.dist });
  try { stopMotion(); } catch (e) {}
  try { bot.chat('/tpa ' + pick.name); } catch (e) { return { ok: false, reason: 'chat_failed' }; }
  const r = await awaitWarp({ maxMs: 15000 });
  emit({ type: 'squad_result', to: pick.name, warped: !!r.warped });
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
  // offhand : item de la MAIN SECONDAIRE (slot 45), lui aussi absent de inventory.items(). Sans
  // lui, le but `shield` ne verrait jamais le bouclier une fois ÉQUIPÉ → re-craft à l'infini.
  let offhand = null;
  try {
    const s = bot && bot.inventory && bot.inventory.slots && bot.inventory.slots[45];
    // Un bouclier à bout de course = pas de bouclier : il vaut 1 lingot, on le remplace avant
    // qu'il ne casse au pire moment (il ANNULE le coup, c'est la pièce la plus rentable du run).
    const obWorn = (s && s.name && isNearlyBroken(s)) ? [s.name] : [];
    const or = pickWornOutToReport(obWorn, _offhandWornReported);   // dédup (cf. wornOut.js)
    _offhandWornReported = or.reported;
    for (const name of or.toEmit) emit({ type: 'gear_worn_out', item: name, slot: 'offhand' });
    offhand = (s && s.name && !isNearlyBroken(s)) ? s.name : null;
  } catch (e) { /* best-effort */ }
  const gift = _giftContext();
  return {
    hasTable: !!_nearestTable(bot), y: pos ? pos.y : undefined, worn: [..._wornArmor()], offhand,
    mapperTarget: gift.target, giftReady: gift.ready,
  };
}

// ── ARMURE DES CARTOGRAPHES : choix + réservation de la cible ────────────────────────────────────
// La chaîne MAPPER_ARMOR_CHAIN est entièrement gouvernée par `ctx.mapperTarget` : tant qu'il est
// null, tous ses buts sont satisfaits et le bot enchaîne sur le diamant.
//
// La cible est choisie de façon DÉTERMINISTE (teamwork.pickMapperToEquip) — donc identique pour
// tous les workers au même instant : sans réservation, les 5 forgeraient un set pour le MÊME
// cartographe. On RÉSERVE donc via le lockfile de claims partagé du groupe, et on descend la liste
// tant qu'une cible est déjà prise.
//
// Deux garde-fous temporels :
//  - le heartbeat de présence est à 60 s : un mappeur qu'on vient d'équiper se publie « nu »
//    encore une minute → `_giftDone` empêche de le resservir (TTL 5 min) ;
//  - `ctxExtra` est appelé à chaque pas du planner : on met le résultat en cache 15 s pour ne pas
//    marteler le lockfile.
const GIFT_PIECES = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'];
const GIFT_CACHE_MS = 15000;
const GIFT_DONE_TTL_MS = 300000;
let _teamClaims = null;          // instancié au spawn si --claims est fourni
let _giftTarget = null;          // cartographe réservé (nom) ou null
let _giftAt = 0;                 // instant du dernier calcul (cache)
const _giftDone = new Map();     // nom -> instant de livraison (anti double-service)

function _giftContext() {
  const empty = { target: null, ready: false };
  try {
    const items = (bot && bot.inventory && bot.inventory.items()) || [];
    const ready = giftSetPlan(items).ready;
    const now = Date.now();
    if (now - _giftAt < GIFT_CACHE_MS) return { target: _giftTarget, ready };
    _giftAt = now;
    for (const [name, at] of _giftDone) { if (now - at > GIFT_DONE_TTL_MS) _giftDone.delete(name); }
    if (!presence) { _giftTarget = null; return { target: null, ready }; }
    // SORTIE ANTICIPÉE avant tout accès au fichier partagé. `presence.list()` prend un VERROU et
    // RÉÉCRIT positions-<groupe>.json ; `ctxExtra()` est appelé à chaque pas du planner, et 8 bots
    // se partagent ce fichier. On payait donc ce verrou en permanence pour, juste après, constater
    // que le bot n'a pas fini SA propre armure et qu'il n'y a rien à faire — la garde de
    // pickMapperToEquip arrivait trop tard. Tant qu'un worker n'est pas 4/4, il ne peut équiper
    // personne : on le sait sans consulter personne.
    const selfStatus = teamStatus(buildCtxInv(bot), [..._wornArmor()]);
    if ((selfStatus.armor || 0) < 4) { _giftTarget = null; return { target: null, ready }; }
    const mates = presence.list();
    const skip = new Set(_giftDone.keys());
    for (let i = 0; i < 6; i++) {                      // descend la liste des cibles déjà prises
      const pick = pickMapperToEquip({
        selfName: bot.username, selfStatus, mates, claimed: skip, now,
      });
      if (!pick) { _giftTarget = null; return { target: null, ready }; }
      // Sans lockfile (groupe sans --claims) on accepte la cible telle quelle : mieux vaut deux
      // sets livrés qu'aucun — un mappeur sur-équipé garde simplement des pièces en poche.
      if (!_teamClaims || _teamClaims.tryClaim('marmor:' + pick.to)) {
        _giftTarget = pick.to;
        return { target: pick.to, ready };
      }
      skip.add(pick.to);
    }
    _giftTarget = null;
    return { target: null, ready };
  } catch (e) { return empty; }
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
  // Échec de reprise = un bloc ABANDONNÉ sur le terrain. C'était silencieux, donc invisible dans
  // les journaux : c'est ainsi qu'une vingtaine de tables se sont accumulées au spawn sans qu'aucun
  // event ne le signale. On l'émet désormais (le bot n'a rien de mieux à faire, mais on le SAIT).
  try { emit({ type: 'reclaim_failed', block: blockName, x: pos && pos.x, y: pos && pos.y, z: pos && pos.z }); } catch (e) {}
}

// Garantit une table à portée le temps d'exécuter fn (un craft), puis reprend la table si on l'a posée.
// ⚠️ findBlock(6) > portée d'interaction (~4.5) : une table « proche » peut être INATTEIGNABLE (jungle :
// posée sous la canopée pendant que le bot est dans l'arbre) → on s'en APPROCHE d'abord ; si le craft
// échoue quand même, on pose une table portable en fallback (vu live MapT1 : stall wooden_pickaxe ×4).
async function withCraftingTable(fn) {
  // On CHERCHE loin (TABLE_SEEK) puis on marche jusqu'à la table : réutiliser une table déjà
  // posée évite d'en semer une nouvelle à chaque craft. Avec l'ancien rayon de 6, une table à
  // 10 blocs était invisible → une vingtaine de tables accumulées au spawn (signalé par Massii).
  const t = _nearestTable(bot, TABLE_SEEK);
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
  let hasTableItem = ((bot.inventory && bot.inventory.items()) || []).some((i) => i.name === 'crafting_table');
  const plan = tablePlan({
    tableInReach: !!_nearestTable(bot, TABLE_REACH),
    tableSeen: !!_nearestTable(bot, TABLE_SEEK),
    hasTableItem,
  });
  // Une table est DÉJÀ à portée de craft : en poser une seconde ne peut RIEN changer (l'échec
  // vient des matériaux). C'était la branche qui semait une table par craft raté — des traînées
  // de tables sur tout le parcours des bots (photo Massii 26/07).
  if (plan === 'use_existing') return { ok: false, reason: 'craft_failed:table_present' };
  // Table ABANDONNÉE en vue (une mort ou un timeout a coupé le cycle avant la reprise) : aller
  // la REPRENDRE plutôt que d'en fabriquer une neuve → le terrain se nettoie au lieu de se joncher.
  if (plan === 'recycle') {
    const litter = _nearestTable(bot, TABLE_SEEK);
    if (litter) {
      try {
        if (bot.entity.position.distanceTo(litter.position) > 3) {
          await withTimeout(
            bot.pathfinder.goto(new pfGoals.GoalNear(litter.position.x, litter.position.y, litter.position.z, 2)),
            30000, () => { try { stopMotion(); } catch (e) {} }
          );
        }
        await reclaimBlock(litter.position);
      } catch (e) { /* pas de chemin → on retombe sur la fabrication */ }
      hasTableItem = ((bot.inventory && bot.inventory.items()) || []).some((i) => i.name === 'crafting_table');
      emit({ type: 'table_recycled', ok: hasTableItem });
    }
  }
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
  // reclaimBlock retourne en SILENCE quand il ne retrouve pas le bloc (il suppose « déjà repris »).
  // C'est ainsi que les tables s'accumulaient sans qu'aucun event ne le signale : on vérifie.
  try {
    const left = place.pos ? bot.blockAt(place.pos) : null;
    if (left && left.name === 'crafting_table') {
      emit({ type: 'table_abandoned', x: place.pos.x, y: place.pos.y, z: place.pos.z });
    }
  } catch (e) { /* best-effort */ }
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
  // BÛCHES → PLANCHES avant d'allumer (analyse 26/07) : une bûche brute fond 1,5 objet, ses
  // 4 planches en fondent 6 — brûler la bûche telle quelle gaspille 75 % du bois, alors que le
  // manque de combustible bloquait la fonte. Best-effort : si le craft échoue, on brûle comme avant.
  try {
    const lp = logsToConvert(((bot.inventory && bot.inventory.items()) || [])
      .map((i) => ({ name: i.name, count: i.count })), count);
    if (lp.convert && lp.name) {
      const plankName = lp.name.replace(/_log$/, '_planks');
      await craftSmart({ name: plankName, count: (lp.logs || 1) * 4 });   // 4 planches par bûche
      emit({ type: 'logs_to_planks', from: lp.name, logs: lp.logs || 1 });
    }
  } catch (e) { /* best-effort : on fond quand même */ }
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
const SKILL_TIMEOUTS = { descendDiagonal: 900000, branchMine: 900000, caveHunt: 900000, huntCook: 480000, smeltCharcoal: 300000, gather: 480000, gatherLog: 180000, ensurePick: 480000 };
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
  // ─── REMONTER CHERCHER LE BOIS (idée Massii, live 26/07) ──────────────────────────────────────
  // « si ils ont plus de bois ils peuvent placer un home, se tp au /spawn ou un home en surface,
  // prendre ce qu'il faut et après retourner ou ils sont. » C'est LE frein n°1 du projet : les
  // outils cassent en profondeur, et sous terre il n'y a NI bois NI table pour en refaire — le bot
  // tournait alors en boucle sur `no_recipe` / `no_table` (mesuré live sur NethBot1).
  // Le RETOUR existait déjà (`/home work`, « c'est LE moteur du churn ») ; l'ALLER manquait.
  // On pose donc le chantier avant de partir, puis on remonte au home de surface : la descente
  // suivante repartira en un seul tp au lieu de recreuser ~52 blocs.
  // ⚠️ DEUX ÉLARGISSEMENTS (Massii 27/07 : « s'ils n'ont plus de bois ils retournent au home en
  // surface, on en a parlé »). Le déclencheur d'origine ratait précisément le cas vécu :
  //   (a) il exigeait `y < 30`, or les bots tournaient en boucle dans une salle à y 40-60 ;
  //   (b) il ne regardait que le NOM du but, et `help_pick` — celui qui échouait en boucle sur
  //       `no_sticks`, 31 fois mesurées — n'est pas dans WOOD_GOALS.
  // Résultat : le bot manquait de bois, le savait, et ne remontait jamais en chercher.
  if (NO_GIVE && (WOOD_GOALS.has(goal.name) || _needsWoodTrip) && bot.entity && bot.entity.position
      && bot.entity.position.y < 62 && (Date.now() - _lastWoodTripAt) > 120000) {
    _lastWoodTripAt = Date.now();
    try {
      if (!_workSet && !isInWater(bot)) {
        homewarp.bookmark(bot, HOME_WORK); _workSet = true; _workPos = _botXZ();
        emit({ type: 'work_bookmarked', why: 'wood_trip' });
      }
      emit({
        type: 'wood_trip', goal: goal.name, y: Math.round(bot.entity.position.y),
        why: _needsWoodTrip ? 'no_wood_proven' : 'wood_goal',
      });
      _needsWoodTrip = false;
      await safeWarpHome('safe');   // surface : c'est là qu'il y a des arbres et de quoi crafter
    } catch (e) { /* best-effort : à défaut on tente le skill sur place, comportement d'avant */ }
  }
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
      // no_give-légal — /tp bloqué) vers la meilleure AVANT la 1re descente ; ensuite le chantier
      // (53ca041) ancre le chantier sec pour toutes les re-descentes. Une tentative par session :
      // échec → on descend sur place (comportement historique inchangé).
      if (_drySteerTries < 3 && !_workSet && bot.entity && bot.entity.position) {
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
              // NE PLUS renvoyer d'échec (Massii 27/07 : « il faut qu'il arrête de se bloquer
              // sur ça »). Le steering n'est qu'une OPTIMISATION — aller creuser dans une cellule
              // plus sèche. En cas d'échec on renvoyait {ok:false} : le planner re-dérivait sur
              // descend_y16 et relançait la MÊME marche, et comme `_drySteerTries` vit dans le
              // PROCESS, chaque respawn le remettait à zéro → boucle sans fin à travers les
              // sessions. Mesuré sur world_mn5 : 11 `dry_steer_short`, cause d'échec n°1, et
              // ZÉRO fer en 1 h 45 — les workers ne descendaient jamais.
              // Aggravant : `driestCell` exige ≥12 minerais cartographiés ; après une purge de
              // mémoire la carte est vide, la cible est donc mauvaise par construction.
              // On arrête de steerer et on CREUSE ICI : descendre quelque part vaut mieux que
              // tourner en rond en surface.
              _drySteerTries = 3;
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
        const _p = bot.entity.position;
        // 3a : quand un chantier a été PROUVÉ noyé, le décalage n'est plus aléatoire — il part du
        // site banni sur un cap qui TOURNE à chaque essai (une nappe s'étend rarement dans toutes
        // les directions ; re-tirer un angle au hasard retombait dedans une fois sur deux).
        let _tx; let _tz;
        if (_drownedRelocate) {
          _tx = _drownedRelocate.x; _tz = _drownedRelocate.z;
          _drownedRelocate = null;
        } else {
          const _ang = Math.random() * Math.PI * 2;
          const _d = 30 + Math.random() * 20;
          _tx = Math.round(_p.x + Math.cos(_ang) * _d);
          _tz = Math.round(_p.z + Math.sin(_ang) * _d);
        }
        // Et on ne se relogue JAMAIS sur un chantier déjà banni : on repousse jusqu'à sortir.
        for (let k = 0; k < 6 && isDrownedNear(_drownedSites, { x: _tx, z: _tz }, Date.now()); k++) {
          _drownedOffsetSeed += 1;
          const alt = offsetFromDrowned({ x: _tx, z: _tz }, _drownedOffsetSeed);
          _tx = alt.x; _tz = alt.z;
        }
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
  // ENTRAIDE/CARTOGRAPHES (piège world_mn8 27/07) : un bot dont la pioche a cassé refait une pioche
  // fer-capable AVANT de miner (expédition bois + bootstrap bois→pierre), au lieu de boucler
  // iron_deep → no_pickaxe. recoverPickaxe rend {ok:true} immédiatement s'il a déjà une pioche.
  if (goal.skill === 'ensurePick') return recoverPickaxe();
  if (goal.skill === 'smeltIron') return smeltWithFurnace('raw_iron', 'iron_ingot', goal.args.count || 3);
  if (goal.skill === 'smeltCharcoal') return smeltCharcoalGoal(goal.args.count || 2);
  if (goal.skill === 'huntCook') return huntCookGoal(goal.args.target || 4);
  if (goal.skill === 'descendDiagonal') {
    // FIX churn re-descente (NO_GIVE) : un chantier profond SEC est mémorisé → y retourner par
    // /home work (1 tp) plutôt que re-creuser ~52 blocs (chaque re-descente cassait une pioche pierre
    // → no_pickaxe → le fer ne s'accumulait jamais). water_rescue ramenait en SURFACE, forçant cette
    // re-descente : c'est LE moteur du churn. Garde : si le tp atterrit dans l'eau, le chantier est noyé
    // → on l'oublie et on re-creuse (qui relocalise au sec via _descendWaterFails).
    if (NO_GIVE && _workSet && bot.entity && bot.entity.position && bot.entity.position.y > 30) {
      emit({ type: 'descend_via_home_work' });
      try { homewarp.goHome(bot, HOME_WORK); } catch (e) {}
      await awaitWarp({ maxMs: 8000 }); // atterrissage OU warmup teleport-delay couvert (remplace le sleep aveugle)
      await sleep(1200);                // settle chunks post-tp
      const _py = (bot.entity && bot.entity.position) ? bot.entity.position.y : 99;
      if (isInWater(bot)) { _workSet = false; try { await escapeWater(bot, { emit }); } catch (e) {} }
      else if (_py <= 20) return { ok: true, viaHome: true };  // arrivé profond & sec → pas de re-creusage
    }
    const r = await descendDiagonal(bot, goal.args || {}, taskToken);
    // suivi des échecs EAU → le pré-hook ci-dessus décale le prochain essai (anti re-perçage d'aquifère)
    if (r && r.ok === false && /water|flood|drown/i.test(String(r.reason || ''))) _descendWaterFails++;
    else if (r && r.ok) {
      _descendWaterFails = 0;
      _workStuckTimes = [];
      // chantier profond atteint & SEC → mémoriser (les re-descentes suivantes = /home work, pas de creusage)
      if (NO_GIVE && !isInWater(bot)) { try { homewarp.bookmark(bot, HOME_WORK); } catch (e) {} _workSet = true; _workPos = _botXZ(); _workDrownTimes = []; emit({ type: 'work_bookmarked' }); }
    } else if (NO_GIVE && _workSet && r && r.ok === false && /drop_ahead|max_depth|air_at_y|lava_ahead/i.test(String(r.reason || ''))) {
      // Le chantier mène en boucle à une impasse SÈCHE (grotte/vide/lave minée autour du puits) : miroir
      // SEC de workDrown (live NethBot4 world_mn9 : 15× descend_via_home_work→drop_ahead, 0 minerai).
      // Au seuil, on OUBLIE le chantier + on ARME le relocate (_descendWaterFails) → la re-descente creuse
      // un puits FRAIS 30-50 blocs plus loin au lieu de /home work → même drop_ahead.
      const s = recordWorkStuck(_workStuckTimes, Date.now());
      _workStuckTimes = s.times;
      if (s.abandon) { _workSet = false; _descendWaterFails++; emit({ type: 'work_abandoned_stuck', reason: r.reason }); }
    }
    return r;
  }
  // CAVE-FIRST (Massii, live 26/07). On chasse le diamant DANS LES GROTTES : uniquement des
  // minerais mappés, EXPOSÉS et SECS (`caveHunt` impose exposedOnly + excludeWet). Le creusement
  // n'est plus la stratégie mais le TRAJET : quand plus aucune cible n'est visible, on enchaîne un
  // tunnel COURT (16 blocs, 4 galeries) vers la zone suivante — pas le strip de 48 × 16 d'avant.
  if (goal.skill === 'caveHunt') {
    const memCH = (args['wm-live'] && args['world-memory']) ? loadMemory(args['world-memory']) : bot._worldMemory;
    const _count = (name) => ((bot.inventory && bot.inventory.items()) || [])
      .reduce((s, i) => s + (i.name === name ? i.count : 0), 0);
    const rCH = await caveHunt(bot, Object.assign({
      emit,
      memory: memCH,
      world: String(bot._worldKey || 'overworld'),
      // Déplacement borné : on ne s'acharne pas sur une cible inatteignable (le skill la met de côté).
      goTo: async (t) => {
        try {
          await withTimeout(bot.pathfinder.goto(new pfGoals.GoalNear(t.x, t.y, t.z, 2)),
            120000, () => { try { stopMotion(); } catch (e) {} });
        } catch (e) { /* inatteignable → false */ }
        const p = bot.entity && bot.entity.position;
        return !!(p && Math.hypot(p.x - t.x, p.y - t.y, p.z - t.z) <= 6);
      },
      // Le filon entier, pas juste le bloc visé : un diamant vient rarement seul.
      mineAt: async (t) => {
        const before = _count('diamond') + _count('raw_iron') * 0;
        try { await floodFillVein(bot, t, taskToken); } catch (e) { /* best-effort */ }
        return Math.max(0, _count('diamond') - before);
      },
    }, goal.args || {}), taskToken);
    if (rCH && rCH.reason === 'no_cave_target') {
      emit({ type: 'cave_travel', reason: 'no_cave_target' });
      return await branchMine(bot, Object.assign(
        { torchEvery: TORCH_EVERY, onSurvivalTick: branchSurvivalTick, survivalEvery: 4 },
        { targetY: (goal.args && goal.args.targetY) || -54, mainLength: 16, branchSpacing: 4, branchLength: 4 }),
      taskToken);
    }
    return rCH;
  }
  if (goal.skill === 'branchMine') {
    // TUNNEL ÉCLAIRÉ + SURVIE PROACTIVE (analyse jeu humain, 26/07). `branchMine` SAIT poser des
    // torches (`torchEvery`) et faire tourner un tick de survie (`onSurvivalTick`) — la chaîne ne
    // les lui demandait simplement jamais. Or c'est la phase la plus LONGUE de T1 (jusqu'à 15 min) :
    // elle se creusait dans le noir (block-light 0 ⇒ les mobs apparaissent DANS le tunnel) et sans
    // aucune décision de survie proactive — le bot ne réagissait qu'APRÈS avoir encaissé.
    // Les args du but restent prioritaires (Object.assign) : rien n'est imposé à un appelant qui
    // aurait ses propres valeurs.
    // ARRÊT SUR COMPTE (analyse 26/07) : `branchMine` sait s'arrêter dès qu'un DELTA d'items est
    // récolté (`stopOre`) — la chaîne ne le lui demandait pas, donc le bot restait sous terre
    // jusqu'au timeout (15 min) même une fois son fer obtenu. Chaque minute de plus au fond est
    // une exposition gratuite. On vise le besoin RESTANT (armure + pioche + bouclier), borné à 16
    // pour que le bot remonte fondre/forger par paliers au lieu de tout jouer sur une descente.
    let stopOre = goal.args && goal.args.stopOre;
    const _obj = (world.objective && world.objective.type) || '';
    if (!stopOre && (_obj === 'iron_armor' || _obj === 'diamond_armor')) {
      try {
        const besoin = armorNeed({ inv: buildCtxInv(bot), worn: [..._wornArmor()] }, 3);
        if (besoin > 0) stopOre = { items: ['raw_iron', 'iron_ingot'], count: Math.min(besoin, 16) };
      } catch (e) { /* best-effort : sans stop, comportement d'avant */ }
    }
    // TORCHES : TORCH_EVERY (8) et pas 4 — Massii 2026-07-26 « ils placent aussi beaucoup trop de
    // torches quand ils creusent leur tunnel = beaucoup trop d'utilisation de charbon ». Le charbon
    // est aussi le COMBUSTIBLE de la fonte (piège #54f) : chaque torche de trop retarde l'armure.
    // branchMine randomise déjà l'intervalle sur [N, 2N[ → une torche tous les 8 à 15 paliers,
    // largement de quoi tenir la lumière d'un tunnel (un humain les espace comme ça).
    const rBM = await branchMine(bot, Object.assign(
      { torchEvery: TORCH_EVERY, onSurvivalTick: branchSurvivalTick, survivalEvery: 4 },
      goal.args || {}, stopOre ? { stopOre } : {}), taskToken);
    // Fix n°2 water-wall (NO_GIVE) : aquifère VERROUILLANT (waterlocked = toutes directions
    // mouillées + scellement inopérant) ou stall → se DÉCALER à pied 30-50 blocs À PROFONDEUR
    // (pathfinder creuse son chemin) avant que le planner ne retente iron_deep au même endroit.
    // Le chantier noyé est oublié / re-marqué au sec (sinon /home work ramènerait dans la nappe).
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
      if (isInWater(bot)) { _workSet = false; try { await escapeWater(bot, { emit }); } catch (e) {} }
      else { try { homewarp.bookmark(bot, HOME_WORK); _workSet = true; _workPos = _botXZ(); emit({ type: 'work_bookmarked', ctx: 'waterlocked_relocate' }); } catch (e) {} }
    }
    return rBM;
  }
  // Chaîne iron_armor : ensureArmor fond le brut nécessaire + craft la pièce fer la moins chère +
  // équipe (1 pièce/appel — le planner re-boucle). Progrès = besoin d'armure qui BAISSE ou pièce
  // équipée en plus ; sinon {ok:false} → failStreak → stall propre (ex. four perdu, fer volatilisé).
  // Forge les pièces MANQUANTES du set à offrir (celles qui ne sont pas déjà en poche). Le worker
  // porte les siennes dans les slots 5-8, absents de inventory.items() : une pièce en poche est
  // donc bien du surplus livrable, jamais celle qu'il a sur le dos.
  if (goal.skill === 'craftGiftSet') {
    const itemsOf = () => (bot.inventory && bot.inventory.items()) || [];
    const plan = giftSetPlan(itemsOf());
    if (plan.ready) return { ok: true };
    let progressed = false;
    for (const piece of plan.missing) {
      const r = await craftSmart({ name: piece, count: 1 });
      if (r && r.ok) { progressed = true; emit({ type: 'gift_craft', item: piece }); }
    }
    return progressed ? { ok: true } : { ok: false, reason: 'gift_craft:' + plan.ingotsShort };
  }
  // Livraison : /tpa VERS le cartographe (jamais l'inverse — il ne doit pas s'arrêter), puis
  // remise en main propre. Il s'équipe seul : `armorUp(0)` tourne dans son onPeriodic.
  if (goal.skill === 'deliverMapperArmor') {
    const to = _giftTarget;
    if (!to) return { ok: true };                       // plus personne à servir
    if (!isAllowed('/tpa ' + to, whitelist)) {
      emit({ type: 'gift_blocked', to });               // /tpa pas coché dans le profil serveur
      return { ok: false, reason: 'tpa_not_whitelisted' };
    }
    emit({ type: 'gift_tpa', to });
    try { stopMotion(); } catch (e) {}
    // Poser le chantier AVANT de partir : sans ça le worker livrait son armure et reprenait sa
    // chaîne à l'endroit du cartographe, à l'autre bout de la carte (son puits de mine abandonné).
    markWorkBeforeTrip('gift_tpa');
    try { bot.chat('/tpa ' + to); } catch (e) { return { ok: false, reason: 'chat_failed' }; }
    const w = await awaitWarp({ maxMs: 20000 });
    if (!w.warped) {
      // Échec de TP : on RELÂCHE la réservation pour qu'un autre worker (peut-être plus proche
      // ou moins malchanceux) puisse servir ce cartographe. Le set reste en poche, rien n'est perdu.
      try { if (_teamClaims) _teamClaims.release('marmor:' + to); } catch (e) {}
      _giftTarget = null; _giftAt = 0;
      emit({ type: 'gift_tpa_failed', to });
      return { ok: false, reason: 'tpa_failed' };
    }
    let given = 0;
    for (const piece of GIFT_PIECES) {
      try { const r = await giveItem(bot, { name: piece }, to); if (r && r.ok) given += 1; } catch (e) {}
    }
    emit({ type: 'gift_delivered', to, pieces: given });
    _giftDone.set(to, Date.now());                      // le heartbeat le publiera « nu » encore 60 s
    try { if (_teamClaims) _teamClaims.release('marmor:' + to); } catch (e) {}
    _giftTarget = null; _giftAt = 0;
    await returnToWork('gift_done');                    // ← LE retour qui manquait
    return given > 0 ? { ok: true } : { ok: false, reason: 'gift_toss_failed' };
  }
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
  // « nu » au sens de l'abri = armure INCOMPLÈTE, pas « zéro pièce ». Une seule botte suffisait à
  // désactiver l'abri nocturne, alors qu'en hard un zombie tue un bot à 3 pièces presque aussi vite
  // qu'un bot nu. Les porteurs de set complet (mappeurs via /kit) restent libres de travailler.
  const naked = _wornArmor().size < 4;
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

// ─── COMPTEURS DE ZONE (feature « migration autonome », Massii 27/07) ───────────────────────────
// Remis à ZÉRO à chaque ré-ancrage : ils jugent la zone COURANTE, pas la carrière du bot.
// Ce sont les entrées de zone.zoneVerdict — cf. zone.js pour les seuils et leur justification.
let _zoneAnchoredAt = 0;      // instant du dernier ancrage/migration (0 = pas encore ancré)
let _zoneWaterFails = 0;      // échecs eau (descente noyée, sauvetages) dans la zone
let _zoneLogsNotFound = 0;    // `logs`/bois introuvable → la zone est rasée
let _zoneIronMined = 0;       // fers récoltés dans la zone (rendement)
let _zoneMiningMs = 0;        // temps de minage effectif dans la zone
let _lastMigrationAt = 0;     // cooldown anti-nomadisme
let _lastZoneVerdictReason = null; // dedup télémétrie : dernière raison de verdict tracée
let _migrating = false;       // marche de migration en cours → l'enforcement confine est SUSPENDU
let _migrationLegs = 0;       // jambes déjà parcourues (marche à l'aveugle)

/** Applique un état de zone (pur → variables de module). */
function _applyZoneState(s) {
  _zoneAnchoredAt = s.anchoredAt;
  _zoneWaterFails = s.waterFails;
  _zoneLogsNotFound = s.logsNotFound;
  _zoneIronMined = s.ironMined;
  _zoneMiningMs = s.miningMs;
  _lastMigrationAt = s.lastMigrationAt;
}

/** Sérialise l'état de zone courant pour le mémo de base. */
function _zoneStateNow() {
  return {
    anchoredAt: _zoneAnchoredAt, waterFails: _zoneWaterFails, logsNotFound: _zoneLogsNotFound,
    ironMined: _zoneIronMined, miningMs: _zoneMiningMs, lastMigrationAt: _lastMigrationAt,
  };
}

// ⚠️ L'ÉTAT DE ZONE DOIT SURVIVRE AU PROCESS — c'est LA raison pour laquelle la migration n'a
// jamais tiré de la journée du 27/07. L'horloge et les compteurs vivaient ici, en mémoire de
// process, alors que le self-healing relance un bot toutes les quelques minutes : chaque respawn
// les remettait à zéro et l'hystérésis de 15 min n'était JAMAIS atteinte (verdict bloqué sur
// `too_soon` en permanence). Même classe que les pièges #52 et #63, documentés le matin même.

/** Charge l'état de zone depuis le mémo de base (horloge CONTINUE), ou en démarre un frais. */
function loadZoneState() {
  const st = loadBaseState();
  _applyZoneState(zoneStateLoad(st && st.zone, Date.now()));
}

/** Persiste l'état de zone dans le mémo de base (à côté de la dette de mort). */
function persistZoneState() {
  const st = loadBaseState() || {};
  saveBaseState(Object.assign({}, st, { zone: _zoneStateNow() }));
}

/** Remet les compteurs à zéro : la zone jugée est celle où l'on vient de s'ancrer. */
function resetZoneCounters(now) {
  _applyZoneState(zoneStateInit(now || Date.now()));
  _descendWaterFails = 0;
  persistZoneState();
}

/** Buts qui MINENT : leur durée est le dénominateur du rendement de la zone (verdict 'exhausted'). */
const MINING_GOALS = new Set(['descend_y16', 'iron_deep', 'iron_help', 'cobble_lava', 'diamond']);

/** Buts dont l'échec accuse la ZONE (pas le bot) : bois absent ou nappe d'eau. */
const _WATER_FAIL_RE = /water|flood|drown|noy/i;

let _needsWoodTrip = false;   // un échec a prouvé le manque de bois → la prochaine passe remonte

/** Alimente les compteurs depuis l'échec d'un but (appelé au point de passage unique).
 *  Le classement vit dans zone.zoneFailureKind (pur, testé) : c'est lui qui sait que
 *  `pick_recovery:no_sticks` accuse la ZONE (pas de bois) et non le bot. */
function noteZoneFailure(goalName, reason) {
  const kind = zoneFailureKind(goalName, reason);
  if (kind === 'water') _zoneWaterFails += 1;
  else if (kind === 'wood') { _zoneLogsNotFound += 1; _needsWoodTrip = true; }
}

// Rendement fer : mesuré par ÉCHANTILLONNAGE de l'inventaire (branchMine n'émet pas par minerai,
// et un event par bloc serait un emballement). On ne compte que les HAUSSES : un dépôt à la base
// fait baisser le stock sans que la zone y soit pour rien.
let _lastIronSample = null;
function sampleZoneIron() {
  try {
    const inv = buildCtxInv(bot);
    const n = (inv.raw_iron || 0) + (inv.iron_ingot || 0);
    if (_lastIronSample != null && n > _lastIronSample) _zoneIronMined += (n - _lastIronSample);
    _lastIronSample = n;
  } catch (e) { /* best-effort */ }
}

/** Cellules de biome + cellules épuisées de la carte partagée du groupe (ou {} si illisible). */
function loadWorldCells() {
  try {
    const mem = args['world-memory'] ? loadMemory(String(args['world-memory'])) : null;
    const w = (mem && mem.worlds && mem.worlds[bot._worldKey || worldKey(bot, args['world-label'])]) || {};
    return { biomes: w.biomes || [], depleted: w.depleted || [], ores: w.ores || [] };
  } catch (e) { return { biomes: [], depleted: [], ores: [] }; }
}

/** Ancre courante du bot (base persistée, sinon confine, sinon position). */
function currentAnchor() {
  if (_safeHomePos && Number.isFinite(_safeHomePos.x)) return { x: _safeHomePos.x, z: _safeHomePos.z };
  const eff = CONFINE || _confineDyn;
  if (eff) return { x: eff.x, z: eff.z };
  const p = bot.entity && bot.entity.position;
  return p ? { x: p.x, z: p.z } : null;
}

/**
 * MIGRATION DE ZONE (Massii 27/07) — « s'éloigner assez pour trouver une nouvelle zone tout seuls,
 * continuer à marcher jusqu'à trouver le bon endroit, y poser leur home safe, et miner LÀ ».
 *
 * Deux modes :
 *   - avec carte : une cellule de biome TERRE non-épuisée à 200-1500 blocs, choisie de façon
 *     DÉTERMINISTE (tous les ouvriers calculent la même) + claim partagé → l'escouade migre ENSEMBLE ;
 *   - sans carte : marche directionnelle par jambes de 128 blocs, terrain vérifié à chaque jambe.
 *
 * Pendant la marche, l'enforcement confine est SUSPENDU (`_migrating`) — sinon il ramènerait le
 * marcheur à l'ancre qu'on essaie justement de quitter.
 */
async function migrateZone(reason) {
  if (_migrating) return;
  const from = currentAnchor();
  if (!from) return;
  _migrating = true;
  _migrationLegs = 0;
  const t0 = Date.now();
  try {
    const cells = loadWorldCells();
    // « Si une zone a été vidée de ses minerais, il s'éloigne de BEAUCOUP » (Massii) : pour un
    // épuisement, la cellule d'à côté est le même sous-sol déjà fouillé → plancher bien plus haut.
    const minDist = minDistFor(reason);
    let target = pickMigrationTarget({ from, biomes: cells.biomes, depleted: cells.depleted, minDist });
    // Claim PARTAGÉ : si un coéquipier a déjà fixé la cible, on adopte la sienne — l'escouade doit
    // atterrir au MÊME endroit même si les cartes divergent d'un bot à l'autre.
    if (target && _teamClaims) {
      const key = 'migration:' + Math.round(target.x / 128) + ',' + Math.round(target.z / 128);
      try { _teamClaims.tryClaim(key); } catch (e) { /* best-effort */ }
    }
    emit({
      type: 'zone_migration_start', reason,
      fromX: Math.round(from.x), fromZ: Math.round(from.z),
      toX: target ? target.x : null, toZ: target ? target.z : null,
      source: target ? target.source : 'blind', biome: target ? target.biome : null,
    });

    let travelFrom = { x: from.x, z: from.z };   // origine RÉELLE du voyage (mise à jour après la remontée)
    // L'ORDRE COMPTE : on remonte AVANT de voyager. Auparavant la remontée venait après les
    // tentatives de trajet — le bot tentait donc la traversée SOUS TERRE (NoPath quasi garanti sur
    // plusieurs centaines de blocs), remontait ensuite, et jugeait son arrivée là où il n'avait pas
    // bougé : `zone_migration_failed underground:true` à chaque fois (mesuré world_mn11).
    // ⚠️ ON REMONTE PAR `/home safe`, PAS A LA PIOCHE (mesure live world_mn11, 28/07 : toutes les
    // migrations `wood` echouaient encore `underground:true` MALGRE cette remontee — depuis y=17-21
    // il y a ~45 blocs de roche a percer, le pathfinder rend NoPath ou depasse le budget, a plus
    // forte raison sans pioche adaptee). Or le bot POSSEDE deja un home de surface : le faire
    // remonter a pied etait absurde. Un joueur qui demenage rentre chez lui d abord.
    // Bonus : partir de la surface rend le trajet vers la nouvelle foret PLAT — c est exactement
    // ce qui manquait au trek souterrain que la veille avait diagnostique (5db0192).
    {
      const pUp = bot.entity && bot.entity.position;
      if (pUp && pUp.y < SAFE_HOME_MIN_Y) {
        emit({ type: 'zone_migration_surfacing', from_y: Math.round(pUp.y), via: 'home_safe' });
        try {
          await safeWarpHome(HOME_SAFE);
        } catch (e) { /* best-effort */ }
        // Repli : si le home a ete refuse (teleport-safety) on tente quand meme la remontee a pied.
        const pAfterWarp = bot.entity && bot.entity.position;
        if (pAfterWarp && pAfterWarp.y < SAFE_HOME_MIN_Y) {
          emit({ type: 'zone_migration_surfacing', from_y: Math.round(pAfterWarp.y), via: 'walk' });
          try {
            await withTimeout(bot.pathfinder.goto(new pfGoals.GoalY(SAFE_HOME_MIN_Y + 4)),
              90000, () => { try { stopMotion(); } catch (e) {} });
          } catch (e) { /* best-effort : on juge l'arrivée telle qu'elle est */ }
        }
      }
    }
    // ⚠️ LE VOYAGE PART D'APRÈS LA REMONTÉE, PAS DE L'ANCRE (bug créé par le correctif précédent,
    // vu live : `zone_migrated dist:123 took_s:0` alors que la cible était à l'OPPOSÉ). Le
    // `/home safe` de remontée déplace le bot de plusieurs dizaines de blocs ; mesuré depuis
    // l'ancre, ce simple retour à la maison passait pour un déménagement réussi — le bot se
    // ré-ancrait sur son ANCIENNE base et brûlait le cooldown sans avoir bougé d'un pouce.
    {
      const pT = bot.entity && bot.entity.position;
      if (pT) travelFrom = { x: pT.x, z: pT.z };
    }
    if (target) {
      // Trajet borné et découpé : un goto unique de 1500 blocs ne rend jamais la main proprement.
      for (let hop = 0; hop < 6 && !taskToken.cancelled; hop++) {
        const p = bot.entity && bot.entity.position;
        if (!p) break;
        if (Math.hypot(p.x - target.x, p.z - target.z) <= 32) break;
        await withTimeout(
          bot.pathfinder.goto(new pfGoals.GoalNearXZ(target.x, target.z, 24)),
          120000, () => { try { stopMotion(); } catch (e) {} });
      }
      // ⚠️ UN GOTO QUI ÉCHOUE NE DOIT PAS PASSER POUR UNE MIGRATION (mesuré live sur world_mn11 :
      // `zone_migration_start` vers une forêt à 236 blocs, puis `zone_migrated dist:2 took_s:3`).
      // Le pathfinder rend `NoPath` en quelques secondes sur une cible lointaine (chunks non
      // chargés) ; on tombait alors dans la branche « arrivée » et on re-ancrait la base 2 blocs
      // plus loin — le bot restait dans la zone morte EN CROYANT avoir déménagé, cooldown brûlé.
      // Si on n'a pas vraiment avancé, on bascule sur la marche par JAMBES : des sauts de 128
      // blocs que le pathfinder sait faire, dans la direction de la cible.
      const pAfter = bot.entity && bot.entity.position;
      const moved = pAfter ? Math.hypot(pAfter.x - travelFrom.x, pAfter.z - travelFrom.z) : 0;
      if (moved < MIGRATE_MIN_PROGRESS) {
        emit({ type: 'zone_migration_hop_failed', moved: Math.round(moved), toX: target.x, toZ: target.z });
        const heading = Math.atan2(target.z - travelFrom.z, target.x - travelFrom.x);
        for (let i = 0; i < MAX_LEGS && !taskToken.cancelled; i++) {
          const pl = bot.entity && bot.entity.position;
          const leg = migrationLeg({ from: pl ? { x: pl.x, z: pl.z } : from, heading, legs: i });
          if (!leg) break;
          await withTimeout(
            bot.pathfinder.goto(new pfGoals.GoalNearXZ(leg.x, leg.z, 16)),
            90000, () => { try { stopMotion(); } catch (e) {} });
          _migrationLegs = i + 1;
          const pn = bot.entity && bot.entity.position;
          if (pn && Math.hypot(pn.x - target.x, pn.z - target.z) <= 48) break;   // arrivé
          if (pn && legIsGood(probeTerrain())) break;                            // déjà bon ici
        }
      }
    } else {
      // MARCHE À L'AVEUGLE : on continue tant que le terrain n'est pas bon, cap total borné.
      const heading = basecamp.headingForName(bot.username, 3);
      for (let i = 0; i < MAX_LEGS && !taskToken.cancelled; i++) {
        const p = bot.entity && bot.entity.position;
        const leg = migrationLeg({ from: p ? { x: p.x, z: p.z } : from, heading, legs: i });
        if (!leg) break;
        await withTimeout(
          bot.pathfinder.goto(new pfGoals.GoalNearXZ(leg.x, leg.z, 16)),
          90000, () => { try { stopMotion(); } catch (e) {} });
        _migrationLegs = i + 1;
        if (legIsGood(probeTerrain())) break;      // « le bon endroit » : arbres, au sec, pas d'océan
      }
    }

    // ARRIVÉE : la nouvelle zone devient LA base. `safe` bouge, le confine se ré-ancre, et le memo
    // persisté fait que tout respawn (self-healing compris) repartira d'ICI — c'est la pièce qui
    // manquait aux deux tentatives précédentes (split-brain confine).
    const p2 = bot.entity && bot.entity.position;
    const p2wet = !!(p2 && isInWater(bot));
    // On n'ancre une NOUVELLE base que si on a réellement déménagé : sans ça un goto raté
    // re-posait la base à 2 blocs et consommait le cooldown (bug mesuré sur world_mn11).
    const reallyMoved = p2 ? Math.hypot(p2.x - travelFrom.x, p2.z - travelFrom.z) >= MIGRATE_MIN_PROGRESS : false;
    // ⚠️ SURFACE OBLIGATOIRE (bugfix world_mn10, 27/07) : `safe`/base/spawnpoint ne s'ancrent QUE
    // sur une vraie surface sèche. Une « migration » à l'aveugle (cible null → aucun déplacement,
    // dist ~11 blocs) laissait le mineur À SA POSITION SOUTERRAINE (y=-7) ; l'ancienne garde ne
    // testait que `!isInWater` → base sous terre → /home safe noyé → jamais de bois → `logs
    // not_found` 98.9 %, done figé à 0. Sous terre on traite la migration comme NON aboutie (le
    // bot garde son safe de surface précédent) — cf. isSurfaceSpot dans homes.js.
    if (p2 && reallyMoved && isSurfaceSpot({ y: p2.y, inWater: p2wet })) {
      // « Il enlève leur vieux home et il le remet au nouveau safe place » (Massii, 27/07).
      // Le `work` DOIT partir : il pointe sur le chantier de la zone qu'on vient d'abandonner —
      // le laisser en place, c'est garder un `/home work` qui re-téléporte à des centaines de
      // blocs en arrière, dans la zone qu'on a jugée morte. Puis on retire explicitement l'ancien
      // `safe` et on le repose ICI (l'ordre compte : on a déjà vérifié qu'on est au sec, donc le
      // re-sethome qui suit ne peut pas échouer sur une destination noyée).
      try { homewarp.delhome(bot, HOME_WORK); } catch (e) { /* best-effort */ }
      try { homewarp.delhome(bot, HOME_SAFE); } catch (e) { /* best-effort */ }
      homewarp.bookmark(bot, HOME_SAFE);
      _safeHomeSet = true;
      _safeHomeSurface = p2.y >= 58;
      _safeHomePos = { x: p2.x, y: p2.y, z: p2.z };
      try { bot.chat('/spawnpoint'); } catch (e) {}
      const base = { x: Math.round(p2.x), y: Math.round(p2.y), z: Math.round(p2.z) };
      const st = loadBaseState() || {};
      saveBaseState(Object.assign({}, st, { base, personal: true }));
      _confineDyn = { x: base.x, z: base.z, radius: (CONFINE && CONFINE.radius) || DEFAULT_CONFINE_RADIUS };
      if (CONFINE) CONFINE = { x: base.x, z: base.z, radius: CONFINE.radius };
      _anchorSet = true;
      bot._mcaExploreBounds = { x: base.x, z: base.z, radius: Math.max(_confineDyn.radius * 2, 128) };
      _workSet = false;                            // l'ancien chantier est à l'autre bout du monde
      _applyZoneState(zoneStateAfterMigration(Date.now()));
      _descendWaterFails = 0;
      persistZoneState();
      emit({
        type: 'zone_migrated', reason,
        fromX: Math.round(from.x), fromZ: Math.round(from.z),
        toX: base.x, toZ: base.z, legs: _migrationLegs,
        dist: Math.round(Math.hypot(base.x - from.x, base.z - from.z)),
        took_s: Math.round((Date.now() - t0) / 1000),
      });
    } else {
      // Arrivée dans l'eau, SOUS TERRE, ou position illisible : on NE pose PAS la base (un home
      // mouillé/souterrain rend `/home safe` mortel). Le cooldown court quand même — on ne relance
      // pas un trek dans la foulée, et le bot garde son safe de surface précédent.
      _lastMigrationAt = Date.now();
      emit({
        type: 'zone_migration_failed', reason, wet: p2wet,
        underground: !!(p2 && !p2wet && p2.y < SAFE_HOME_MIN_Y),
      });
    }
  } catch (e) {
    _lastMigrationAt = Date.now();
    emit({ type: 'zone_migration_failed', reason, error: String((e && e.message) || e) });
  } finally {
    _migrating = false;
  }
}

/** Lecture du terrain sous le bot pour `legIsGood` (arbres visibles, pieds au sec, biome). */
function probeTerrain() {
  let treesNear = 0;
  let biome = null;
  try {
    const ids = Object.keys(bot.registry.blocksByName)
      .filter((n) => n.endsWith('_log')).map((n) => bot.registry.blocksByName[n].id);
    treesNear = bot.findBlocks({ matching: ids, maxDistance: 48, count: 4 }).length;
  } catch (e) { treesNear = 0; }
  try {
    const p = bot.entity && bot.entity.position;
    const b = p && bot.blockAt(p);
    if (b && b.biome && b.biome.name) biome = String(b.biome.name).replace(/^minecraft:/, '');
  } catch (e) { biome = null; }
  return { treesNear, inWater: (function () { try { return isInWater(bot); } catch (e) { return false; } })(), biome };
}

/** Le verdict de zone, évalué périodiquement. Migre si la zone ne vaut plus le temps qu'on y passe. */
function checkZoneVerdict() {
  if (_migrating || taskToken.cancelled || IS_MAPPER) return;   // les cartographes DOIVENT bouger, ils ne migrent pas
  // ⚠️ NE PAS exiger `_anchorSet` : sur une zone rasée le bot ne s'ancre jamais (pickAnchorNow
  // refusait sans arbre) — exiger l'ancre rendait donc la migration IMPOSSIBLE précisément dans
  // le cas qu'elle doit résoudre. L'horloge de zone démarre au spawn, pas à l'ancrage.
  if (!_zoneAnchoredAt) return;
  sampleZoneIron();
  const now = Date.now();
  const cells = loadWorldCells();
  const from = currentAnchor();
  // Une cellule sèche mappée à portée est une meilleure réponse qu'un trek : le code sait déjà y aller.
  let dryCellKnown = false;
  try {
    dryCellKnown = !!(from && driestCell(cells.ores, {
      base: from, range: 224, cellSize: 128, minOres: 12,
    }));
  } catch (e) { dryCellKnown = false; }
  const depletedNear = (cells.depleted || []).filter((d) => d && Number.isFinite(d.x) && from
    && Math.hypot(d.x - from.x, d.z - from.z) <= 160).length;
  const v = zoneVerdict({
    minutesInZone: (now - _zoneAnchoredAt) / 60000,
    waterFails: _zoneWaterFails,
    logsNotFound: _zoneLogsNotFound,
    ironMined: _zoneIronMined,
    miningMinutes: _zoneMiningMs / 60000,
    depletedNear,
    dryCellKnown,
    lastMigrationAt: _lastMigrationAt,
    now,
  });
  // TRACE : sans elle, un 'stay' est muet → on ne peut pas voir QUELLE porte bloque la migration
  // (trop tôt / cooldown / cellule sèche connue). Dédup au changement de raison (anti-emballement).
  const tel = verdictTelemetry(v, _lastZoneVerdictReason);
  _lastZoneVerdictReason = tel.reason;
  if (tel.log) emit({
    type: 'zone_verdict', verdict: v.verdict, reason: v.reason,
    minutesInZone: Math.round((now - _zoneAnchoredAt) / 60000),
    waterFails: _zoneWaterFails, logsNotFound: _zoneLogsNotFound,
    ironMined: _zoneIronMined, miningMinutes: Math.round(_zoneMiningMs / 60000),
    depletedNear, dryCellKnown,
  });
  persistZoneState();          // les compteurs accumulés doivent survivre au prochain respawn
  if (v.verdict === 'migrate') migrateZone(v.reason).catch(() => {});
}

async function runSkillWithTelemetry(g) {
  await settleSurvivalKit();                                  // survie d'abord, le craft ensuite
  if (taskToken.cancelled) return { ok: false, reason: 'cancelled' };
  // NUIT + (mort récente OU PV bas) pendant le kit → ABRI jusqu'à l'aube (vécu Surv4 : 7 morts
  // nocturnes en boucle ; un trou couvert coûte 2 blocs et sauve le kit).
  if (await maybeNightShelter() && taskToken.cancelled) return { ok: false, reason: 'cancelled' };
  const _t0 = Date.now();
  const r = await withTimeout(runGoalSkill(g), timeoutFor(g.skill), () => { try { stopMotion(); } catch (e) {} });
  // Temps de MINAGE effectif : c'est le dénominateur du rendement de la zone (verdict 'exhausted').
  if (MINING_GOALS.has(g.name)) _zoneMiningMs += (Date.now() - _t0);
  if (!r || r.ok === false) {
    emit({ type: 'goal_failed', name: g.name, reason: (r && r.reason) || 'unknown' });
    noteZoneFailure(g.name, r && r.reason);
  }
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
  // ── /locate RETIRÉ (Massii 2026-07-26 : « les bots ne doivent pas utiliser de commandes comme
  // /locate »). C'est une commande d'opérateur qui RÉVÈLE la position de structures qu'un joueur ne
  // peut pas connaître — même nature que le x-ray qu'on passe justement le run à neutraliser, et
  // c'était la seule source de structures « devinées » plutôt que VUES.
  // Il en partait 107 en 20 minutes, et chaque appel sur une structure non générée fouille les
  // region files (contributeur du freeze serveur de 49 s, piège #43c) : on y gagne aussi du CPU.
  // La découverte de structures repose désormais UNIQUEMENT sur `findAllSignatures` — des blocs
  // réellement dans le champ du bot (cloche, rail, spawner, reinforced_deepslate…), donc légitimes.
  // Les parseurs purs de structures.js (`parseLocateResponse`, LOCATE_KINDS) restent en place et
  // testés : ils ne sont plus appelés.
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
              const ent = bot.nearestEntity((e) => /boat/i.test(e.name || '') || /boat/i.test(e.displayName || ''));
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

// ─── BASE PERSONNELLE (Massii 2026-07-26) ───────────────────────────────────────────────────────
// « Les bots doivent apprendre à survivre dès qu'ils spawnent (tu pourras pas changer le spawn
// juste pour éviter les morts) ; le mieux ce serait qu'ils se déplacent et mettent un home pour
// l'utiliser comme spawn. » → le bot marche par ses propres moyens jusqu'à SA zone (cap en
// éventail, forêt connue si la carte en a une), y pose /sethome safe ET /spawnpoint : ses morts
// suivantes le relâchent CHEZ LUI, plus au spawn du monde partagé.
// Pourquoi ça compte (mesuré sur world_ax4) : 3 ouvriers + 235 respawns sur le même carré →
// forêt rasée en 1 h (récolte de bois : 93 % d'échec, 46 % de tous les buts du run) + boucle de mort.
// Fichier keyé par bot → survit aux morts, aux relances du self-healing et aux déploiements.
const baseFile = args.base || path.join(__dirname, '..', 'data', `mc_agent_base_${args.user || 'TrainBot'}.json`);
let _baseState = null;    // { base:{x,y,z}, worldSpawn:{x,z} }
let _baseBusy = false;    // une seule installation à la fois (le spawn peut se répéter en rafale)
let _baseAbort = false;   // le bot est mort en route → l'installation en vol s'arrête (levé par onSpawn)

function loadBaseState() {
  if (_baseState) return _baseState;
  try {
    const o = JSON.parse(fs.readFileSync(baseFile, 'utf8'));
    if (o && typeof o === 'object') _baseState = o;
  } catch (e) { _baseState = null; }
  return _baseState;
}

function saveBaseState(st) {
  _baseState = st;
  try {
    const tmp = baseFile + '.tmp';                // write+rename = atomique (cf. saveBanked)
    fs.writeFileSync(tmp, JSON.stringify(st));
    fs.renameSync(tmp, baseFile);
  } catch (e) { /* best-effort : sans le fichier, le bot re-marchera, il ne casse rien */ }
}

// ─── DETTE DE MORT (Massii 27/07) ───────────────────────────────────────────────────────────────
// « death = posé quand il va mourir (sauf lave) ; après respawn il se re-TP IMMÉDIATEMENT pour
// tuer tout et récupérer son loot ; il ne supprime ce home qu'une fois TOUT le loot récupéré —
// sinon il revient encore et encore, même s'il meurt en continu. »
//
// La dette est PERSISTÉE dans le memo base : le self-healing relance le process à chaque mort, or
// c'est PRÉCISÉMENT là qu'elle sert. Une dette gardée en mémoire de process serait perdue au seul
// moment qui compte. Borne naturelle : le despawn vanilla à 5 min (cf. homes.DEBT_TTL_MS) — au-delà
// il n'y a plus rien au sol, la dette se lève seule. Pas de boucle infinie possible.

// ─── EXCURSION VOLONTAIRE : poser `work` AVANT de partir, revenir par `/home work` ──────────────
// Massii : « work = la zone de travail : posé quand il doit se TP quelque part (vers la base, chez
// un joueur, n'importe où) pour pouvoir REVENIR au travail ensuite. »
// Le trajet bois posait déjà son signet ; la livraison d'armure au cartographe, elle, faisait un
// /tpa et NE REVENAIT JAMAIS — le worker reprenait sa chaîne depuis l'autre bout de la carte.
// Garde : jamais dans l'eau (un home mouillé rend tous les /home morts, teleport-safety), et on
// n'ÉCRASE PAS un chantier déjà mémorisé (le puits de mine profond vaut mieux que la position
// de surface d'où l'on part).

/** Pose le signet de chantier avant une excursion. Retourne true si un retour sera possible. */
function markWorkBeforeTrip(why) {
  if (_workSet) return true;                       // chantier déjà mémorisé : c'est là qu'on rentre
  try {
    if (isInWater(bot)) return false;
    if (!homewarp.bookmark(bot, HOME_WORK)) return false;
    _workSet = true; _workPos = _botXZ();
    emit({ type: 'work_bookmarked', why });
    return true;
  } catch (e) { return false; }
}

/** Retour au chantier après l'excursion (no-op si aucun chantier n'a pu être posé). */
async function returnToWork(why) {
  if (!_workSet) return false;
  try {
    homewarp.goWork(bot);
    const r = await awaitWarp({ maxMs: 12000 });
    emit({ type: 'work_return', why, warped: !!(r && r.warped) });
    return !!(r && r.warped);
  } catch (e) { return false; }
}

/** Lit la dette persistée (ou null). */
function loadDeathDebt() {
  const st = loadBaseState();
  return (st && st.deathDebt) || null;
}

/** Écrit (ou efface avec null) la dette dans le memo base, en préservant le reste. */
function persistDeathDebt(debt) {
  const st = loadBaseState() || {};
  const next = Object.assign({}, st);
  if (debt) next.deathDebt = debt; else delete next.deathDebt;
  saveBaseState(next);
}

/** Nom du bloc à une position relative au bot (null si illisible — registry/chunk pas prêt). */
function _blockNameAt(dx, dy, dz) {
  try {
    const p = bot.entity && bot.entity.position;
    if (!p) return null;
    const b = bot.blockAt(p.offset(dx, dy, dz));
    return (b && b.name) || null;
  } catch (e) { return null; }
}

/**
 * Marque le lieu de mort courant (/sethome death) et ouvre la dette.
 * Refusé dans la lave : y revenir n'est pas une récupération mais une 2e mort, et le loot y a brûlé.
 * Le home suit toujours la DERNIÈRE mort (Essentials écrase le home du même nom).
 * @returns true si la dette a été posée.
 */
function bookmarkDeathHere() {
  const p = bot.entity && bot.entity.position;
  if (!p) return false;
  const feet = _blockNameAt(0, 0, 0);
  const below = _blockNameAt(0, -1, 0);
  if (!canBookmarkDeath({ feet, below })) {
    emit({ type: 'death_bookmark_skipped', reason: 'lava' });
    return false;
  }
  if (!homewarp.bookmark(bot, HOME_DEATH)) return false;
  const debt = openDebt(p, Date.now());
  persistDeathDebt(debt);
  return true;
}

/** Lève la dette : /delhome death (le slot est rendu) + effacement du memo. */
function settleDeathDebt(reason) {
  try { homewarp.delhome(bot, HOME_DEATH); } catch (e) { /* best-effort */ }
  persistDeathDebt(null);
  emit({ type: 'death_debt_settled', reason });
}

/**
 * Récupération post-respawn : /home death → tuer tout ce qui traîne → ramasser → ne lever la dette
 * QUE s'il ne reste plus rien au sol. Sinon la dette reste et le prochain respawn y revient.
 * Prioritaire sur la reprise de chaîne ; les réflexes de survie restent armés pendant toute la manœuvre.
 */
async function recoverDeathDebt() {
  if (_deathDebtBusy) return;
  const debt0 = loadDeathDebt();
  const first = debtAction({ debt: debt0, now: Date.now() });
  if (first.act === 'none') return;
  if (first.act === 'settle') { settleDeathDebt(first.reason); return; }
  _deathDebtBusy = true;
  try {
    await sleep(1500);
    emit({ type: 'death_recover_home', x: debt0.x, y: debt0.y, z: debt0.z });
    homewarp.goHome(bot, HOME_DEATH);
    await awaitWarp({ maxMs: 8000 }); // atterrissage OU warmup teleport-delay
    await sleep(1000);                // settle chunks
    // « tuer tout » : ce qui nous a tué campe souvent sur le loot. On ENGAGE (bestWeapon), on ne fuit pas.
    try { await clearHostilesAround(); } catch (e) { /* best-effort */ }
    await collectDeathDrops();
    // Récupéré = MESURÉ, pas supposé : plus aucune item entity autour après nettoyage.
    const left = homewarp.dropsWithin(bot.entities, bot.entity && bot.entity.position, DEATH_DROP_RADIUS).length;
    const after = debtAction({ debt: loadDeathDebt(), now: Date.now(), arrived: true, dropsLeft: left });
    if (after.act === 'settle') settleDeathDebt(after.reason);
    else emit({ type: 'death_debt_kept', drops_left: left });   // on repassera au prochain respawn
  } catch (e) {
    /* best-effort : la dette reste, le prochain respawn re-tentera (ou le TTL la lèvera) */
  } finally {
    _deathDebtBusy = false;
  }
}

const DEATH_DROP_RADIUS = 16;   // rayon de mesure des drops restants (cf. homewarp.dropsWithin)
const DEATH_CLEAR_RADIUS = 12;  // hostiles à écarter avant de ramasser

/** Engage les hostiles proches du lieu de mort (borné) : « le but est de tuer tout, pas de fuir ». */
async function clearHostilesAround() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    let target = null;
    try {
      const list = nearbyHostiles(bot, DEATH_CLEAR_RADIUS);
      target = list && list.length ? list[0] : null;
    } catch (e) { target = null; }
    if (!target) return;
    // Même séquence que le réflexe de défense : arme en main PUIS attaque (au poing = 1 dégât).
    try {
      const w = bestWeapon(bot);
      if (w) await bot.equip(w, 'hand').catch(() => {});
    } catch (e) { /* best-effort */ }
    try { bot.pvp.attack(target); } catch (e) { return; }
    await sleep(1200);
  }
  try { bot.pvp && bot.pvp.stop(); } catch (e) {}
}

/**
 * Marche jusqu'à la zone de base, y pose le home 'safe' + ancre le respawn (/spawnpoint).
 * Deux temps, calés sur le fonctionnement d'équipe déjà en place (`team_split`) :
 *   - défaut        : base COMMUNE (cap 0, cible déterministe) — la phase où les bots restent
 *                     ensemble pour se faire leur kit, et où le /tpa de regroupement a raison ;
 *   - {personal:true}: à la SÉPARATION (tout le monde en armure), chacun repart poser SA base,
 *                     en éventail depuis la base commune (cap déduit de son nom).
 * Best-effort, jamais bloquant.
 */
async function establishBase(opts = {}) {
  if (_baseBusy) return;
  _baseBusy = true;
  _baseAbort = false;
  try {
    const personal = !!opts.personal;
    const st = loadBaseState() || {};
    if (personal && st.personal) return;            // base personnelle déjà posée
    const p0 = bot.entity && bot.entity.position;
    // Spawn du monde : mémorisé au TOUT premier boot (le bot y apparaît forcément) puis relu du
    // fichier — car après /spawnpoint, bot.spawnPoint désigne la base et non plus le spawn du monde.
    // ⚠️ `bot.spawnPoint` AVANT la position courante : mesuré live, les 3 ouvriers avaient chacun
    // enregistré un worldSpawn DIFFÉRENT (leur position de boot, dispersée par le spawn radius du
    // serveur) — donc trois origines, donc trois cibles, donc une base « commune » où NethBot3
    // s'installait à 280 blocs des deux autres. Le spawn du monde est le MÊME pour tous, et
    // mineflayer le fournit (paquet spawn_position).
    const sp = bot.spawnPoint;
    const wspawn = (st.worldSpawn && Number.isFinite(st.worldSpawn.x))
      ? st.worldSpawn
      : (sp && Number.isFinite(sp.x) ? { x: Math.round(sp.x), z: Math.round(sp.z) }
        : (p0 ? { x: Math.round(p0.x), z: Math.round(p0.z) } : null));
    // Viser une forêt CONNUE de la carte du groupe plutôt qu'un cap à l'aveugle (le bois est le
    // goulot n°1) ; carte encore vide au démarrage du run → repli sur le cap en éventail.
    let biomes = null;
    let depleted = null;
    try {
      const mem = args['world-memory'] ? loadMemory(String(args['world-memory'])) : null;
      const w = (mem && mem.worlds && mem.worlds[bot._worldKey || worldKey(bot, args['world-label'])]) || {};
      biomes = w.biomes;
      depleted = w.depleted;
    } catch (e) { /* carte illisible → cap seul */ }
    // Phase kit : cible DÉTERMINISTE et identique pour les 3 ouvriers (cap 0, même spawn du monde,
    // même carte partagée) → ils convergent sans coordination, et le /tpa de regroupement ne se bat
    // pas contre le trajet. Après la séparation : éventail par nom, mesuré depuis la base commune.
    const origin = (personal && st.base && Number.isFinite(st.base.x)) ? st.base : wspawn;
    const heading = personal ? basecamp.headingForName(bot.username, 3) : 0;
    const distFrom = (q) => (origin && q ? Math.hypot(q.x - origin.x, q.z - origin.z) : Infinity);

    // PROGRESSIF, pas tout-ou-rien (échec live : un unique goto de 240 s vers une cible à 180 blocs
    // rendait `too_close` avec 1 à 22 blocs parcourus — terrain montagneux, le trajet n'aboutit
    // jamais tel quel). L'exigence réelle n'est pas « atteindre ce point » mais « ne plus camper le
    // point de départ » : on tente des cibles de plus en plus proches, bornées court, et on s'arrête
    // dès que la distance suffit. Chaque tentative laisse le bot plus loin que la précédente.
    // Chaque tentative doit viser AILLEURS, sinon la progression n'en est pas une : mesuré live,
    // les 3 essais tombaient sur la MÊME cellule boisée (128,-128) inatteignable, parce que la
    // cellule connue l'emporte sur la distance demandée. La carte sert au 1ᵉʳ essai ; les suivants
    // prennent un point brut sur le cap, de plus en plus proche.
    let rGoto = null;
    let spot = null;
    const plans = [
      { dist: basecamp.BASE_DIST, biomes },
      { dist: 90, biomes: null },
      { dist: 70, biomes: null },
    ];
    // « Assez loin » NE SUFFIT PAS : le spot doit aussi être EN SURFACE (bugfix world_mn10). Un bot
    // recyclé sur sa base souterraine est déjà loin du spawn du monde → l'ancienne condition cassait
    // la boucle sans marcher → il re-ancrait `safe` sous terre. On continue tant qu'on n'est pas à
    // la fois assez loin ET au sec en surface.
    const _atGoodSpot = () => {
      const pp = bot.entity && bot.entity.position;
      if (!pp) return false;
      const wet = (function () { try { return isInWater(bot); } catch (e) { return false; } })();
      return distFrom(pp) >= basecamp.MIN_BASE_DIST && isSurfaceSpot({ y: pp.y, inWater: wet });
    };
    for (const plan of plans) {
      if (_atGoodSpot()) break;
      spot = basecamp.pickBaseSpot({
        spawn: origin, biomes: plan.biomes, depleted, heading, dist: plan.dist,
      });
      emit({
        type: 'base_establish_start', x: spot.x, z: spot.z,
        source: spot.source, biome: spot.biome || null, personal, dist: plan.dist,
      });
      try {
        rGoto = await withTimeout(
          bot.pathfinder.goto(new pfGoals.GoalNearXZ(spot.x, spot.z, 12)),
          90000, () => { try { stopMotion(); } catch (e) {} });
      } catch (e) { rGoto = { ok: false }; }   // NoPath → on retente ailleurs, pas d'abandon
      if (_baseAbort) return;
    }
    const p = bot.entity && bot.entity.position;
    if (!p) return;
    const d = distFrom(p);
    if (d < basecamp.MIN_BASE_DIST) {
      // `goto` a rendu la main sans que le bot bouge : c'est le symptôme d'un trajet ANNULÉ par un
      // autre consommateur du pathfinder (le planner autonome ou le /tpa de regroupement, qui
      // démarrent au même spawn). On remonte le verdict du goto pour pouvoir trancher sur les logs.
      emit({
        type: 'base_establish_failed', reason: 'too_close', d: Math.round(d), personal,
        goto: rGoto && rGoto.ok === false ? 'timeout' : 'resolved',
      });
      return;
    }
    // Jamais sous terre ni les pieds dans l'eau : un home mouillé/souterrain rend tous les /home safe
    // morts (teleport-safety) ET prive le bot de bois/table — c'est LE piège world_mn10. On refuse
    // d'ancrer ici plutôt que d'empoisonner le safe ; le bot retentera au prochain spawn.
    {
      const _wet = (function () { try { return isInWater(bot); } catch (e) { return false; } })();
      if (!isSurfaceSpot({ y: p.y, inWater: _wet })) {
        emit({ type: 'base_establish_failed', reason: _wet ? 'wet' : 'underground', y: Math.round(p.y) });
        return;
      }
    }
    homewarp.bookmark(bot, 'safe');
    _safeHomeSet = true;
    _safeHomeSurface = p.y >= 58;
    _safeHomePos = { x: p.x, y: p.y, z: p.z };
    // « mettre un home pour l'utiliser comme spawn » : /spawnpoint ancre le respawn ICI, donc une
    // mort ne renvoie plus au spawn du monde partagé (précédent : /spawnpoint post-kit des bots
    // ressource, cf. 'kit_done').
    try { bot.chat('/spawnpoint'); } catch (e) {}
    const base = { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) };
    saveBaseState({ base, worldSpawn: wspawn, personal: personal || !!st.personal });
    emit({
      type: 'base_established', ...base, d: Math.round(d), personal,
      source: (spot && spot.source) || 'in_place',   // aucune tentative lancée = déjà assez loin
    });
  } catch (e) {
    emit({ type: 'base_establish_failed', reason: String((e && e.message) || e).slice(0, 80) });
  } finally { _baseBusy = false; }
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
  // USURE (analyse 26/07) : une pièce à bout de course NE COMPTE PLUS comme portée. Le bot
  // n'avait aucune notion de durabilité — il gardait son armure jusqu'à la rupture, et c'est
  // très probablement ce qui lui a fait PERDRE T1 (3 pièces + bouclier évaporés en une nuit).
  // En la déclarant absente au-delà de 85 % d'usure, `armorNeed` la recompte comme manquante et
  // la chaîne la reforge pendant qu'elle protège encore.
  const worn = new Set();
  try {
    // _wornArmor() est appelé ~18×/tick du planner → on DÉDUP gear_worn_out (émis à la seule
    // transition « pièce devient usée », pas à chaque appel). Vécu NethBot1 : 32 % des events
    // d'une session = la MÊME pièce répétée (event sans consommateur, cf. wornOut.js).
    const nearlyBroken = [];
    for (const it of (bot.inventory && bot.inventory.slots ? bot.inventory.slots.slice(5, 9) : [])) {
      if (!it || !it.name) continue;
      if (isNearlyBroken(it)) { nearlyBroken.push(it.name); continue; }
      worn.add(it.name);
    }
    const wr = pickWornOutToReport(nearlyBroken, _wornOutReported);
    _wornOutReported = wr.reported;
    for (const name of wr.toEmit) emit({ type: 'gear_worn_out', item: name, slot: 'armor' });
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
    // BUTIN D'ABORD (Massii 2026-07-26 : « ils meurent beaucoup de faim aussi » — 7 morts de faim
    // sur les 20 premières minutes du run). Le bot tue des dizaines de mobs et LAISSE tout au sol :
    // `attackNearest` ne ramasse rien. Or la chair putréfiée et la viande crue nourrissent
    // (cf. EMERGENCY_FOODS) — c'est de la nourriture gratuite, déjà tuée, à quelques blocs.
    // Court et borné : on ne transforme pas la faim en expédition.
    try {
      const got = await lootNearby({ radius: 12, maxItems: 6, budgetMs: 20000 });
      if (got) emit({ type: 'food_loot_swept', items: got });
    } catch (e) { /* best-effort */ }
    if (cookedCount(buildCtxInv(bot)) >= 4) return;
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
let _pickRecovering = false;   // garde de ré-entrée : le planner (ensurePick) et mineForType peuvent
                               // tous deux l'appeler — une seule expédition de récupération à la fois.
async function recoverPickaxe() {
  if (_pickRecovering) return { ok: bestPickTier() >= 0 };
  _pickRecovering = true;
  try {
    return await _recoverPickaxeInner();
  } finally { _pickRecovering = false; }
}
async function _recoverPickaxeInner() {
  emit({ type: 'pick_recovery' });
  try { await ensureGearFor(['iron']); } catch (e) { /* best-effort */ }
  if (bestPickTier() >= 0) return { ok: true };
  try { await craftSmart({ name: 'stone_pickaxe', count: 1 }); } catch (e) {}
  if (bestPickTier() >= 0) return { ok: true };
  const _invAt = () => {
    const it = (bot.inventory && bot.inventory.items()) || [];
    const n = (name) => it.filter((i) => i.name === name).reduce((a, i) => a + i.count, 0);
    const any = (sfx) => it.filter((i) => i.name.endsWith(sfx)).reduce((a, i) => a + i.count, 0);
    return { logs: any('_log'), planks: any('_planks'), sticks: n('stick'),
             cobble: n('cobblestone') + n('cobbled_deepslate'), table: n('crafting_table') };
  };
  const pp = bot.entity && bot.entity.position;
  const p0 = pp ? { x: Math.floor(pp.x), y: Math.floor(pp.y), z: Math.floor(pp.z) } : null;
  emit({ type: 'pick_recovery_trip', from: p0 });
  // SANS-GIVE : /spreadplayers (relocateToRegion) est BLOQUÉ → on marque le chantier puis on monte au
  // spawn sûr (surface avec arbres) par /home safe. Retour au chantier par /home work (cf. plus bas).
  if (NO_GIVE) {
    if (p0) { homewarp.bookmark(bot, HOME_WORK); emit({ type: 'work_bookmarked', ctx: 'pick_recovery', x: p0.x, y: p0.y, z: p0.z }); }
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
    // SANS-GIVE : /tp @s bloqué → retour au chantier par le signet joueur /home work.
    if (NO_GIVE) { homewarp.goHome(bot, HOME_WORK); emit({ type: 'work_return', x: p0.x, y: p0.y, z: p0.z }); }
    else { try { bot.chat('/tp @s ' + p0.x + ' ' + p0.y + ' ' + p0.z); } catch (e) {} }
    await sleep(3000);
  }
  // POURQUOI l'expedition a echoue (Massii/Repartition 27/07 : `help_pick` echouait 7 fois sur 9
  // avec la raison « unknown »). recoverPickaxe ne renvoyait que {ok}, donc le planner ecrivait
  // 'unknown' et le diagnostic etait impossible — exactement le « silence est un bug » (#55a).
  // On rend desormais la MATIERE manquante : c'est elle qui dit si le frein est le bois, la
  // pierre ou le craft.
  if (bestPickTier() >= 0) return { ok: true };
  const inv = _invAt();
  const reason = (inv.logs === 0 && inv.planks === 0) ? 'no_wood'
    : (inv.sticks === 0) ? 'no_sticks'
      : (inv.cobble < 3) ? 'no_cobble'
        : (inv.table === 0) ? 'no_table' : 'craft_failed';
  emit({ type: 'pick_recovery_failed', reason, ...inv });
  return { ok: false, reason: 'pick_recovery:' + reason };
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
  if (CONFINE || _confineDyn) {
    const confR = CONFINE || _confineDyn;
    emit({ type: 'resource_warp', x: confR.x, z: confR.z, confined: true });
    // no-give : /spreadplayers est BLOQUÉ par nogive → retour légitime /home ancre (brique 1)
    if (NO_GIVE && _anchorSet) { await safeWarpHome(CONFINE_HOME); return; }
    try { bot.chat(confineSpreadCommand(bot.username, confR)); } catch (e) {}
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
    // MORT ONE-SHOT (pas d'imminence détectée → aucun home `death` posé, donc aucune dette).
    // `/back` ramène au dernier lieu de mort en UN saut : 90 s de pathfinding vers l'endroit exact
    // où campe le tueur, c'est la « marche funèbre » déjà mesurée. Whitelisté et permissionné
    // (essentials.back). S'il échoue, la marche reste le filet.
    let warped = false;
    try {
      bot.chat('/back');
      const r = await awaitWarp({ maxMs: 8000 });
      warped = !!(r && r.warped);
      if (warped) emit({ type: 'death_recovery_back' });
    } catch (e) { warped = false; }
    if (!warped) {
      await withTimeout(
        bot.pathfinder.goto(new pfGoals.GoalNear(d.x, d.y, d.z, 1)),
        90000, () => { try { stopMotion(); } catch (e) {} });
    }
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
  if (res.done) {
    // DIAG done-immédiat (nuit 16/07 : done <1 s post-start, reproductible, cause introuvable à
    // l'œil) : dumper le CTX exact qui a rendu firstUnmet nul — inventaire, armure portée, y.
    try {
      const _dbg = Object.assign({ inv: buildCtxInv(bot) }, ctxExtra());
      emit({ type: 'autonomous_done_ctx', objective: objType, y: _dbg.y, worn: _dbg.worn, hasTable: _dbg.hasTable, inv: _dbg.inv });
    } catch (e) { /* diag best-effort */ }
    if (sender) ackPrivate(sender, doneWord());
    emit({ type: 'autonomous_done' });
    // ENCHAÎNEMENT (Massii, live 26/07 : « si ils ont finis il aident en priorité les autres bot et
    // après il vont chercher les diamant »). Sans ça, `clearObjective` laissait le bot INERTE —
    // 3 workers sur 5 à l'arrêt une fois leur armure bouclée.
    const nextObj = nextObjectiveAfter(objType, presence ? presence.list() : []);
    if (nextObj) {
      setObjective(world, { type: nextObj, status: 'in_progress' });
      saveWorld(worldFile, world);
      emit({ type: 'autonomous_chain', from: objType, to: nextObj });
      // RELANCER LE MOTEUR : poser l'objectif ne suffit pas, la boucle du planner vient de se
      // terminer sur ce `done` et rien ne la rallume avant le prochain spawn. Mesuré live
      // (Massii : « neth 1 4 5 sont toujours immobiles ») : `autonomous_chain` émis, objectif
      // en poche, et 0 bloc parcouru en 45 s. setTimeout plutôt qu'un appel direct = pile
      // d'appels neuve ; la chaîne s'arrête d'elle-même (nextObjectiveAfter('diamond') → null).
      setTimeout(() => { try { startAutonomous(null); } catch (e) { /* best-effort */ } }, 1500);
    } else {
      clearObjective(world); saveWorld(worldFile, world);
    }
  }
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
  // BORNE D'EXPLORATION sous confine (anti-drift NE, piège #54) : la poche autour de l'ancre lue par
  // skills/explore.js. Généreuse (2× le rayon confine, plancher 128) pour que le bois reste trouvable,
  // mais FINIE — sans elle un worker re-dérive à 600+ blocs entre deux enforcements (vécu NethBot5).
  // Pour un confine DYNAMIQUE, elle est (re)posée à l'ancrage (confine_anchored). Mappeurs : pas de confine.
  { const _cn = CONFINE || _confineDyn; if (_cn) bot._mcaExploreBounds = { x: _cn.x, z: _cn.z, radius: Math.max(_cn.radius * 2, 128) }; }
  // TP-AU-MAPPEUR (Massii 15/07) : heartbeat de présence partagé — TOUS les bots du groupe battent
  // position+rôle (1×/min) ; un bot ressource lit où sont les mappeurs et se /tpa vers eux
  // (raccourci « vrai joueur » vers les zones lointaines, auto-accepté intra-groupe).
  if (args.positions && !presence) {
    presence = createPresence(String(args.positions), { username: bot.username });
    // Claims d'ÉQUIPE (fichier partagé du groupe) : sert à réserver le cartographe qu'on habille.
    // Même fichier que l'anti-collision minerai du mode resource — les clés sont préfixées.
    if (args.claims && !_teamClaims) {
      try { _teamClaims = createClaims(String(args.claims), { username: bot.username }); } catch (e) { _teamClaims = null; }
    }
    const _beat = () => {
      try {
        const pB = bot.entity && bot.entity.position;
        if (!pB || !presence) return;
        const role = ((world.objective && world.objective.type) === 'mapper') ? 'mapper' : 'worker';
        // On publie AUSSI son état d'équipement : c'est ce qui permet aux coéquipiers de voir qui
        // a besoin d'aide (et de savoir quand tout le monde est équipé → séparation).
        // Les CARTOGRAPHES publient leur état eux aussi (26/07) : c'est la seule façon pour un
        // worker de savoir lesquels sont encore nus — et donc à qui porter une armure, puis quand
        // tout le monde est couvert et qu'on peut passer au diamant. Sans ça, `armor` était
        // absent des entrées mappeur et un mappeur équipé restait indistinguable d'un mappeur nu.
        // Aucun risque de régression : pickDonation et allArmored écartent déjà `role === 'mapper'`.
        let st = null;
        try { st = teamStatus(buildCtxInv(bot), [..._wornArmor()]); } catch (e) {}
        // `y` + `ironZone` : c'est ce qui permet de distinguer un MINEUR AU TRAVAIL d'un bot qui
        // traîne en surface. Sans eux, `squadLeader` ne pouvait trancher qu'à l'alphabet — et si
        // le premier dans l'alphabet flânait, toute la squad remontait le rejoindre au lieu de
        // descendre miner (Massii, 27/07 : « ils se tp aux bots en surface donc ils ne descendent
        // jamais »). Ajoutés APRÈS le spread de `st` pour qu'ils ne puissent pas être écrasés.
        presence.beat(Math.round(pB.x), Math.round(pB.z), role,
          Object.assign({}, st || {}, { y: Math.round(pB.y), ironZone: _zoneIronMined }));
      } catch (e) { /* best-effort */ }
    };
    _beat();
    setInterval(_beat, 60000);

    // ── ÉCLAIRAGE (capture réelle 26/07) : les humains posent 3-5 torches/min sous terre, le bot
    // n'éclairait que son tunnel de branch-mine. Or block-light 0 est la condition EXACTE
    // d'apparition des mobs : chaque couloir sombre qu'il laisse derrière lui devient un spawner.
    // Tick léger (8 s), 100 % local, best-effort — jamais bloquant.
    {
      let _torchLastAt = 0;
      let _torchLastPos = null;
      let _torchBusy = false;
      setInterval(async () => {
        if (_torchBusy || _stillBusy || _imminentBusy || bot.targetDigBlock) return;
        const pT = bot.entity && bot.entity.position;
        if (!pT) return;
        try {
          const items = (bot.inventory && bot.inventory.items()) || [];
          const torches = items.filter((i) => i.name === 'torch').reduce((a, i) => a + i.count, 0);
          let light = null;
          try { const b = bot.blockAt(pT.floored()); if (b && typeof b.light === 'number') light = b.light; } catch (e) {}
          if (!shouldPlaceTorch({
            y: pT.y, lightLevel: light, torches, now: Date.now(),
            lastAt: _torchLastAt, pos: { x: pT.x, z: pT.z }, lastPos: _torchLastPos,
          })) return;
          _torchBusy = true;
          const torch = items.find((i) => i.name === 'torch');
          const ref = bot.blockAt(pT.floored().offset(0, -1, 0));
          if (torch && ref && ref.boundingBox === 'block') {
            await bot.equip(torch, 'hand');
            await bot.placeBlock(ref, vec3Lib(0, 1, 0));
            _torchLastAt = Date.now();
            _torchLastPos = { x: pT.x, z: pT.z };
            emit({ type: 'torch_placed', y: Math.round(pT.y), light });
          }
        } catch (e) { /* best-effort : sol impossible, pas grave */ }
        finally { _torchBusy = false; }
      }, 8000);
    }

    // ── DÉFENSE MUTUELLE : voler au secours d'un coéquipier attaqué ─────────────────────────
    // Massii 25/07 : « il faut aussi qu'ils s'aident contre les mobs ». La présence partagée
    // (heartbeat 60 s) est inutilisable ici — un combat dure quelques secondes. On lit donc la
    // perception LOCALE : les coéquipiers visibles (bot.players) et les hostiles autour.
    // Tick court (4 s) mais 100 % local : aucun findBlocks, coût négligeable.
    if (REGROUP && !IS_MAPPER) {
      let _assistBusy = false;
      let _lastAssistAt = 0;
      setInterval(() => {
        if (_assistBusy || _stillBusy || _imminentBusy) return;
        if (!bot.entity || !presence) return;
        // Mes propres réflexes gèrent MES agresseurs : ici on ne parle que de secourir l'autre.
        if (bot.health != null && bot.health <= DEFENSIVE_HEALTH) return;
        if (Date.now() - _lastAssistAt < 8000) return;              // anti-spam de ciblage
        try {
          const p = bot.entity.position;
          // Coéquipiers VISIBLES (le roster du groupe, croisé avec ce que je vois réellement).
          const roster = presence.list().filter((m) => m.role !== 'mapper' && m.name !== bot.username);
          const mates = [];
          for (const m of roster) {
            const e = bot.players[m.name] && bot.players[m.name].entity;
            if (e && e.position) mates.push({ name: m.name, x: e.position.x, z: e.position.z });
          }
          if (!mates.length) return;
          const hostiles = nearbyHostiles(bot, 32).map((h) => ({
            name: h.name, x: h.position.x, z: h.position.z, _e: h,
          }));
          const pick = pickMobAssist({
            self: { x: p.x, z: p.z, health: bot.health },
            mates, hostiles, isFleeOnly: (n) => isFleeOnlyMob(n, bot.health),
          });
          if (!pick) return;
          _lastAssistAt = Date.now();
          _assistBusy = true;
          emit({ type: 'team_assist', mob: pick.mob.name, mate: pick.mate, dist: pick.dist });
          (async () => {
            try {
              const w = bestWeapon(bot);
              if (w) { try { await bot.equip(w, 'hand'); } catch (e) {} }
              bot.pvp.attack(pick.mob._e);
            } catch (e) { /* best-effort */ }
            finally { setTimeout(() => { _assistBusy = false; }, 5000); }
          })();
        } catch (e) { _assistBusy = false; }
      }, 4000);
    }

    // ── ÉQUIPE (gated REGROUP) : entraide matérielle, cohésion, puis séparation ──────────────
    // Cas qui l'a motivé (mesuré world_ax4) : un bot à 3 pièces d'armure gardait 6 lingots
    // d'avance pendant qu'un autre, à 50 blocs, n'avait RIEN. Le fer dormait dans la mauvaise
    // poche. Tant que l'équipe n'est pas équipée : on partage son SURPLUS et on reste ensemble.
    // Une fois tout le monde en armure fer : chacun repart de son côté (demande Massii).
    if (REGROUP && !IS_MAPPER) {
      let _teamBusy = false;
      let _split = false;
      setInterval(async () => {
        if (_teamBusy || _stillBusy || _imminentBusy || _smeltOppBusy || _armorBusy) return;
        if (!presence || !bot.entity) return;
        _teamBusy = true;
        try {
          const p = bot.entity.position;
          const me = teamStatus(buildCtxInv(bot), [..._wornArmor()]);
          const mates = presence.list();

          // SÉPARATION : tout le monde équipé → la phase groupée s'arrête (une seule annonce).
          if (allArmored(me, mates)) {
            if (!_split) {
              _split = true;
              emit({ type: 'team_split', armor: me.armor });
              // Pas de dispersion physique ici. Massii a d'abord rappelé le fonctionnement
              // historique (« ils restaient ensemble pour faire leur kit et après ils se
              // séparaient »), puis tranché : « il faut surtout qu'ils restent en GROUPE, c'est
              // important ». La séparation reste donc ce qu'elle était — la fin de la phase de
              // partage obligatoire — et tout le monde garde la base commune.
              // (`establishBase({personal:true})` existe et fonctionne : c'est le jour où il voudra
              // 3 zones de récolte distinctes qu'il faudra le rebrancher ici.)
            }
            return;
          }
          _split = false;

          // 1) ENTRAIDE : donner son surplus de lingots au coéquipier le moins équipé.
          const gift = pickDonation({
            self: { x: p.x, z: p.z }, selfName: bot.username, selfStatus: me,
            mates, now: Date.now(),
          });
          if (gift) {
            const ent = bot.players[gift.to] && bot.players[gift.to].entity;
            const far = !ent || !ent.position || bot.entity.position.distanceTo(ent.position) > 4;
            if (far && ent && ent.position) {
              try {
                await withTimeout(bot.pathfinder.goto(
                  new pfGoals.GoalNear(ent.position.x, ent.position.y, ent.position.z, 2)),
                  45000, () => { try { stopMotion(); } catch (e) {} });
              } catch (e) { /* on tente le toss quand même s'il est à portée */ }
            }
            const r = await giveItem(bot, { name: 'iron_ingot' }, gift.to);
            emit({ type: 'team_gift', to: gift.to, amount: gift.amount, ok: !!(r && r.ok) });
            return;
          }

          // 2) COHÉSION : rester à portée du groupe tant que l'armure n'est pas faite. Le /tpa
          //    intra-groupe est auto-accepté (policy) — même raccourci que le TP-au-mappeur.
          await tryRegroup();
        } catch (e) { /* best-effort : jamais throw depuis un timer */ }
        finally { _teamBusy = false; }
      }, 90000);
    }
    // Cible dirigée LOINTAINE (>300) → tenter le raccourci /tpa AVANT la marche (hook explore).
    // Mappers exclus (ils ont /spreadplayers) ; bots non-autonomes : pas de longues marches dirigées.
    if (!bot._mcaBeforeLongTrip && world.objective && world.objective.type !== 'mapper') {
      bot._mcaBeforeLongTrip = async (target) => {
        if ((CONFINE || _confineDyn) && _anchorSet) return;   // sous confine : pas de long trip
        try { await tryTpToMapper(target); } catch (e) {}
      };
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
    // MÉNAGE DES HOMES LEGACY (Massii 27/07) — À FAIRE AVANT TOUT `/sethome`.
    // Les comptes existants ont déjà 3 homes posés aux ANCIENS noms (`canchor`, `wsite`). Comme
    // le serveur plafonne à 3 (`sethome-multiple: default: 3`), les `/sethome safe|work` suivants
    // échoueraient EN SILENCE tant que ces slots sont occupés — exactement le bug prouvé sur
    // world_mn5 (NethBot2 sans home `safe` → sa roue de secours anti-noyade était un no-op).
    // Essentials répond « home not found » quand le nom n'existe pas : c'est inoffensif.
    for (const legacy of LEGACY_HOMES) {
      try { homewarp.delhome(bot, legacy); } catch (e) { /* best-effort */ }
    }
    emit({ type: 'legacy_homes_purged', names: LEGACY_HOMES });
    // une seule fois par connexion : sinon 'spawn' (respawn) ré-ajoute des listeners (fuite, MaxListeners)
    // Movements : défense en profondeur contre le stranding au minage (la table portable est le vrai fix).
    const moves = new Movements(bot);
    moves.canDig = true;            // doit pouvoir miner pour atteindre le cobble
    // PILIER DU PATHFINDER : LAISSÉ ACTIF. Deux mesures successives ont tranché contre mon propre
    // correctif « pas de pilier » (demande Massii « ils ont trop de difficulté à placer des blocs
    // sous leurs pieds ») :
    //   1. coupé PARTOUT → les 3 ouvriers avançaient de 1 à 22 blocs en 240 s (world_ax5 est
    //      montagneux : bots relevés à y=15, 34, 88, 97) ;
    //   2. coupé seulement EN SURFACE (bascule à y<50) → les 3 bots FIGÉS, `unjam` en boucle à
    //      y=86-88, « il place des blocs et les casse sans avancer » — sans colonne le pathfinder
    //      n'a plus de chemin, il tente une pose, le watchdog anti-jam la recasse, ça oscille.
    // La colonne du pathfinder est de la TRAVERSÉE (franchir un ressaut), pas le pilier que Massii
    // voit : celui-là était le pilier DÉLIBÉRÉ de `secureTactic`/`pillarUp`, et lui reste retiré.
    moves.allow1by1towers = true;
    // ⚠️ POSER UN BLOC DOIT COÛTER CHER (Massii, photo du 27/07 : le terrain autour du spawn est
    // QUADRILLÉ de longues passerelles de pierre). `placeCost` vaut 1 par défaut — poser un bloc
    // coûte donc autant que faire un pas, et le pathfinder préfère systématiquement construire un
    // pont tout droit plutôt que contourner. Sur 8 bots × 12 h, ça donne le treillis de la photo,
    // et rien ne le nettoie jamais. À 6, un pont de 2-3 blocs reste choisi quand il fait vraiment
    // gagner du chemin, mais le détour redevient préférable dès qu'il existe — ce que fait un
    // joueur. On ne DÉSACTIVE rien (le pilier reste possible, cf. la régression de world_ax5).
    moves.placeCost = 6;
    bot._mcaMoves = moves;
    moves.allowParkour = true;
    moves.allowSprinting = true;    // anti-tell (paquet 1) : un humain sprinte en voyage (pathfinder gère)
    if (typeof moves.maxDropDown === 'number') moves.maxDropDown = 4; // limite les chutes profondes
    // Anti-noyade (vu live HarvT7 : drowned ×3 en trajet dirigé) : l'eau coûte CHER au pathfinder →
    // il contourne les lacs/rivières quand un chemin terrestre existe (coût fini : traverse encore
    // si c'est la SEULE option ; le réflexe oxygène de reflexes.js est le filet de sécurité).
    // Aquaphobie de MARCHE (vécu world_ax2 : 7-8 water_rescue/bot EN SURFACE — 20 laissait le
    // pathfinder traverser les rivières dès que le détour dépassait ~20 blocs/case d'eau).
    // 45/nœud liquide ≈ détour sec accepté jusqu'à ~45 blocs par case d'eau à traverser.
    // ⚠️ DOIT RESTER < placeCost (30 ouvrier / 60 mappeur). À 45 il coûtait PLUS CHER de nager que
    // de poser un bloc → l'A* préférait bâtir un pont dans l'AIR au-dessus de l'eau (retirer l'eau
    // des `replaceables` empêche de poser DANS l'eau, pas au-dessus). D'où les « ponts immenses sur
    // l'eau » signalés par Massii le 26/07, qui a tranché l'arbitrage : « ils peuvent traverser à la
    // nage ». À 20, un détour SEC de ≤20 blocs par case d'eau reste préféré (aquaphobie conservée),
    // mais dès qu'il faut choisir entre nager et construire, nager gagne.
    if (typeof moves.liquidCost === 'number') moves.liquidCost = 20;
    // PONTS : OUI dans le vide, JAMAIS au-dessus de l'eau (Massii 2026-07-19 « arrêtez de
    // construire des ponts au-dessus de l'eau » PUIS 2026-07-26 « ils doivent aussi faire des
    // ponts dans le vide en surface »). Un simple `placeCost` ne sait pas distinguer les deux :
    // à 50 (> liquidCost 45) plus aucun pont ne se faisait, à 8 il rebétonnait les étangs.
    // Le vrai levier est `replaceables` (mineflayer-pathfinder movements.js:68-73), qui contient
    // l'EAU et la LAVE par défaut : c'est ce qui autorisait la pose d'un bloc DANS un plan d'eau.
    // On les retire ⇒ poser dans l'eau/la lave devient impossible par construction, quel que soit
    // le coût, et `placeCost` peut redevenir abordable pour franchir un ravin / un trou.
    try {
      const wId = bot.registry.blocksByName.water && bot.registry.blocksByName.water.id;
      const lId = bot.registry.blocksByName.lava && bot.registry.blocksByName.lava.id;
      if (wId != null) moves.replaceables.delete(wId);
      if (lId != null) moves.replaceables.delete(lId);
    } catch (e) { /* best-effort : à défaut, placeCost reste le seul frein */ }
    // 30 pour un OUVRIER : un pont se fait quand le détour sec dépasse ~30 blocs par bloc posé —
    // un vrai ravin se franchit, mais on ne pose plus un bloc à la moindre marche (à 12, mesuré
    // live : « il place des blocs et les casse sans avancer », de concert avec le watchdog anti-jam).
    // 60 pour un CARTOGRAPHE (Massii 2026-07-26 : « les mappeurs continuent à construire des ponts
    // sur le vide inutilement ») : un mappeur n'a AUCUNE raison de ponter. Il ne va nulle part en
    // particulier — son travail est de couvrir du terrain, donc contourner lui coûte zéro, alors
    // qu'un pont lui coûte du temps, des blocs et un risque de chute. L'ouvrier, lui, a une cible
    // précise (sa base, son gisement) où le détour peut être plus cher que trois blocs posés.
    // 45 pour un OUVRIER (etait 30). Massii, live 26/07 : « il place un bloc en dessous des pieds
    // seulement pour placer un bloc alors qu'il pouvait tout simplement sauter en avant ». On ne
    // PEUT PAS retirer la colonne du pathfinder — deja tente (7f69de6) et REVERTE (7d0501d) : les
    // 3 bots avancaient de 1 a 22 blocs en 240 s, puis restaient figes en oscillant pose/casse.
    // Le seul levier sain est donc le PRIX : a 45, marcher/sauter/nager (20) gagne largement, et
    // poser redevient un dernier recours. Le budget vient de se liberer en baissant liquidCost.
    moves.placeCost = IS_MAPPER ? 60 : 45;
    // STALACTITES à ÉVITER (Massii 2026-07-26 : « surtout les stalactites »). Le pointed_dripstone
    // a une boîte de collision partielle que le pathfinder croit franchissable : le bot s'y coince,
    // et il empale (1 mort mesurée sur ce run). `blocksToAvoid` le fait contourner ; `clearSnares`
    // le casse quand il est déjà collé dedans.
    try {
      for (const n of ['pointed_dripstone', 'powder_snow', 'cactus', 'magma_block', 'sweet_berry_bush']) {
        const b = bot.registry.blocksByName[n];
        if (b) moves.blocksToAvoid.add(b.id);
      }
    } catch (e) { /* best-effort */ }
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
    // ANTI-OOM (crash live 25/07 : NethBot2 → 2 Go de heap en 38 s → FATAL heap out of memory,
    // juste après `survival:flee`). mineflayer-pathfinder livre `searchRadius = -1` = espace de
    // recherche ILLIMITÉ ; couplé au GoalInvert de fleeFrom (heuristique négative → s'éloigner
    // fait TOUJOURS baisser f), un but insatisfiable (bot acculé) fait exploser l'A* jusqu'à
    // l'OOM. Le think-timeout de 5 s ne protège pas : 5 s suffisent à allouer des Go.
    // Budget de détour, pas rayon absolu (cf. movement.js) → les longs trajets restent intacts.
    applyPathfinderBounds(bot.pathfinder);
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
    panicInFlight = false; // garde de ré-entrée onPanic (bug review #3 : fire-and-forget non-awaité).
                           // Réinitialisée à CHAQUE spawn (déclarée au niveau module, cf. l. ~229).
    _workDrownTimes = []; // fresh par session (les strikes de noyade ne traversent pas un respawn)
    _workStuckTimes = []; // idem : les strikes d'impasse sèche ne traversent pas un respawn
    installReflexes(bot, {
      emit, fleeFrom,
      // COUVERT au lieu de la FUITE quand c'est un TIREUR qui nous met à PV bas (autopsie live
      // world_ax4 25/07 : chaque mort précédée d'un `flee`, squelette = 52 morts sur 103). Repli
      // sur la fuite si rien à poser — mieux vaut courir que rester planté sous les flèches.
      onCover: (shooter) => {
        (async () => {
          try {
            try { stopMotion(); } catch (e) {}   // idem : poser exige d'être immobile
            const r = await withTimeout(takeCover(bot, shooter), 3000,
              () => { try { stopMotion(); } catch (e) {} });
            emit({ type: 'take_cover', mob: shooter && shooter.name, from: 'flee',
                   placed: (r && r.placed) || 0, ok: !!(r && r.ok) });
            if (!r || !r.ok) { try { fleeFrom(bot); } catch (e) {} }
          } catch (e) { try { fleeFrom(bot); } catch (e2) {} }
        })();
      },
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
          // DANS L'EAU : « si ils sont en train de suffoquer ça sert à rien de se faire un box en
          // pierre, ils doivent nager vers le haut » (Massii 2026-07-26). onPanic ne regardait pas
          // l'eau : à PV critiques en train de se noyer, le bot se murait — d'où les « box en pierre
          // à des moments aléatoires » vus à l'écran. Un mur ne rend pas d'oxygène.
          let wet = false;
          try { wet = isInWater(bot); } catch (e) {}
          if (wet) {
            emit({ type: 'panic_swim_up' });
            try { bot.setControlState('jump', true); } catch (e) {}   // remonter TOUT DE SUITE
            try { await withTimeout(escapeWater(bot, { emit }), 8000, () => {}); } catch (e) {}
            try { await withTimeout(eat(bot), 2500, () => {}); } catch (e) {}
            return;
          }
          try { stopMotion(); } catch (e) {}
          // panicWall (module dédié, hole C) : mur ROBUSTE même en grotte ouverte (pontage sur le
          // bloc-sol du bot) — l'ancien inline échouait en silence là où les mobs essaiment.
          try { await withTimeout(panicWall(bot), 3000, () => { try { stopMotion(); } catch (e) {} }); } catch (e) { /* best-effort */ }
          try { await withTimeout(eat(bot), 2500, () => {}); } catch (e) {}
        })().finally(() => { panicInFlight = false; });
      },
      // POSTURE DÉFENSIVE à ~10 PV (hole C — AVANT le seuil critique) : équipe + lève le bouclier
      // brièvement (réduit les dégâts entrants). La riposte mêlée et onRanged gèrent l'agresseur.
      onDefensive: (threat) => {
        (async () => {
          try {
            const sh = ((bot.inventory && bot.inventory.items()) || []).find((i) => i.name === 'shield');
            // BANDE DÉFENSIVE (6-10 PV) : SANS bouclier, « lever le bouclier » est un no-op et le
            // bot continue d'encaisser les flèches jusqu'au seuil de fuite — souvent trop tard
            // (mesure live : le couvert au seuil de fuite ne se déclenchait presque jamais, les
            // bots mouraient avant d'y arriver). Face à un TIREUR et sans bouclier, on se masque
            // ICI, une bande de PV plus tôt.
            if (!sh && threat && RANGED.has(threat.name) && threat.position && bot.entity) {
              const dist = bot.entity.position.distanceTo(threat.position);
              const doCover = shouldTakeCover({
                distance: dist, health: bot.health,
                armorPoints: armorPoints(bot), weaponDamage: weaponDamage(bot),
                hasShield: false, hasBlock: !!pickCoverBlock(bot),
              }) && !(function () { try { return isInWater(bot); } catch (e) { return false; } })();
              // …et JAMAIS dans l'eau : poser un muret en nageant ne coupe aucune ligne de vue et
              // fait perdre les secondes d'oxygène qui restent (même règle que onPanic).
              if (doCover) {
                // S'IMMOBILISER D'ABORD : mesure live 25/07, 1 couvert sur 2 rendait placed:0 —
                // `placeBlock` échoue quand le bot est en plein déplacement (il ne peut pas viser
                // la face de référence). Un muret posé vaut infiniment mieux qu'un pas de course.
                try { stopMotion(); } catch (e) {}
                const rc = await withTimeout(takeCover(bot, threat), 3000,
                  () => { try { stopMotion(); } catch (e) {} });
                emit({ type: 'take_cover', mob: threat.name, from: 'defensive',
                       dist: Math.round(dist), placed: (rc && rc.placed) || 0, ok: !!(rc && rc.ok) });
                if (rc && rc.ok) return;                 // masqué : inutile de lever un bouclier absent
              }
            }
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
            // COUVERT AVANT CHARGE (preuve live world_ax4 25/07 : « was shot by Skeleton » ×8 en
            // 4 min sur un seul bot — les squelettes sont le tueur n°1 des bots NUS). Charger à
            // découvert sur 10-16 blocs sans bouclier ni armure = encaisser 3-4 flèches pour rien.
            // Un squelette qui ne voit plus sa cible CESSE de tirer → on lui coupe la ligne de vue.
            const dist = (foe && foe.position && bot.entity && bot.entity.position)
              ? bot.entity.position.distanceTo(foe.position) : 99;
            const cover = shouldTakeCover({
              distance: dist,
              health: bot.health,
              armorPoints: armorPoints(bot),
              weaponDamage: weaponDamage(bot),
              hasShield: !!sh,
              hasBlock: !!pickCoverBlock(bot),
            });
            if (cover) {
              const r = await withTimeout(takeCover(bot, foe), 3000,
                () => { try { stopMotion(); } catch (e) {} });
              emit({ type: 'take_cover', mob: foe && foe.name, dist: Math.round(dist),
                     placed: (r && r.placed) || 0, ok: !!(r && r.ok) });
              if (r && r.ok) return;                 // masqué : on reprend le cours normal
              // pas de couvert possible (rien où poser) → on retombe sur la charge ci-dessous
            }
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
        // EN SURFACE, TOMBER DANS L'EAU N'EST PAS UNE URGENCE (Massii, 27/07 : « s'ils tombent
        // dans l'eau à la surface c'est bon, ils doivent juste remonter et sortir de l'eau »).
        // Toute la machinerie de sauvetage (comptage, warp `/home safe`, abandon du chantier)
        // existe pour les AQUIFÈRES SOUTERRAINS, où le bot est piégé sans issue. À ciel ouvert
        // il lui suffit de nager : warper serait perdre son travail pour un non-problème.
        const _pw = bot.entity && bot.entity.position;
        const _o2s = bot.oxygenLevel;
        const surfaceWater = _pw && _pw.y >= 58 && !(typeof _o2s === 'number' && _o2s <= 6);
        if (surfaceWater) {
          waterRescue = (async () => {
            try { await escapeWater(bot, { emit }); } catch (e) { /* best-effort */ }
            emit({ type: 'water_surface_swim_out' });
          })().finally(() => { waterRescue = null; });
          return;
        }
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
              abandonWorkIfDrowned();                     // chantier noyé ? → l'oublier (sinon /home work y ramène)
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
                else { emit({ type: 'water_rescue_home_safe' }); abandonWorkIfDrowned(); await safeWarpHome('safe'); }
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
          // AUTO-ANCRAGE confine (brique 2, Massii 16/07) : chaque semaine = un monde NEUF (seed
          // non choisi) → le bot s'établit SEUL une poche sèche. Première position stable (au sol,
          // hors eau, surface) → home 'ancre' + confine dynamique (rayon 140). L'enforcement
          // (/home ancre) et le camp de base s'y rattachent. L'ancre ne bouge plus de la session.
          if (!_anchorSet && bot.entity && bot.entity.position
              && (world.objective && world.objective.status === 'in_progress')
              && pickAnchorNow({
                onGround: bot.entity.onGround, inWater: isInWater(bot), y: bot.entity.position.y,
                // zone BOISÉE exigée pour l'ancre dynamique (plank_buffer = retour bois constant) —
                // vécu 16/07 : ancre posée au spawn DÉBOISÉ → poche stérile → churn logs éternel
                woodNear: (function () {
                  try {
                    const ids = Object.keys(bot.registry.blocksByName).filter((n) => n.endsWith('_log')).map((n) => bot.registry.blocksByName[n].id);
                    return !!bot.findBlock({ matching: ids, maxDistance: 32 });
                  } catch (e) { return undefined; }   // registry pas prêt → ne pas bloquer l'ancrage
                })(),
                // Temps passé à chercher une zone boisée : au-delà du délai de grâce, on ancre
                // quand même (sinon une zone rasée interdit à jamais l'ancrage — donc la migration).
                waitedMs: Date.now() - (_zoneAnchoredAt || Date.now()),
              })) {
            const pA = bot.entity.position;
            // Fenêtre de pose = TOUT le disque de confinement (cf. confine.canAnchorHere). La borner
            // plus serré (c'était ≤24 blocs) empêchait un bot ayant dérivé de s'ancrer — donc
            // l'enforcement, qui exige l'ancre, ne s'armait jamais et plus rien ne le retenait :
            // mesuré live le 26/07, écart de 300 blocs pour un rayon de 64.
            const nearStatic = canAnchorHere({
              confine: CONFINE,
              dist: CONFINE ? Math.hypot(pA.x - CONFINE.x, pA.z - CONFINE.z) : 0,
            });
            if (nearStatic && homewarp.bookmark(bot, CONFINE_HOME)) {
              _anchorSet = true;
              if (!CONFINE) _confineDyn = { x: Math.round(pA.x), z: Math.round(pA.z), radius: DEFAULT_CONFINE_RADIUS };
              const eff = CONFINE || _confineDyn;
              bot._mcaExploreBounds = { x: eff.x, z: eff.z, radius: Math.max(eff.radius * 2, 128) };  // borne explore = poche confine (#54)
              emit({ type: 'confine_anchored', x: eff.x, z: eff.z, radius: eff.radius, static: !!CONFINE });
              // Les compteurs de zone jugent la zone où l'on vient de s'ancrer : on repart de zéro.
              if (!_zoneAnchoredAt) loadZoneState();   // reprend l'horloge persistée, ne la remet pas à zéro
              tryEstablishCamp().catch(() => {});
            }
          }
          // NOTE (26/07) — le deadlock d'ancrage sous confine statique est RÉEL (cf.
          // confine.shouldTravelToAnchor et ses tests) : hors des 24 blocs de pose, rien ne
          // ramène le bot. Mais le corriger par un `pathfinder.goto` CONCURRENT ici NE MARCHE
          // PAS et NUIT : mesuré live, la distance ne bouge pas (171→171→172→171… sur 9 essais,
          // et un autre bot qui S'ÉLOIGNE 117→250) parce que le planner relance aussitôt son
          // propre goto — deux goto simultanés s'annulent — et le `stopMotion` du timeout
          // interrompt son travail toutes les 60 s (`descend_y16` et `furnace` passés à 100 %
          // d'échec). La parade opérationnelle est d'ANCRER SUR LE SPAWN DU MONDE : un bot qui
          // apparaît ou réapparaît y est déjà, l'ancre se pose sans un pas. Une vraie correction
          // logicielle devrait passer par le planner (un but « rejoindre l'ancre »), pas contre lui.
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
            if (pN && bookmarkDeathHere()) _deathMark = { x: pN.x, y: pN.y, z: pN.z, at: Date.now() };
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
              // Garde lave + ouverture de la dette PERSISTÉE (le home suit la dernière mort).
              if (bookmarkDeathHere()) _deathMark = { x: p.x, y: p.y, z: p.z, at: now };
            }
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
    // Base personnelle DÉJÀ installée → on ADOPTE son home 'safe' (Essentials le persiste côté
    // serveur, il survit au process) pour que le bloc générique ci-dessous ne le re-pose PAS à
    // l'endroit du respawn — sinon la 1ʳᵉ mort ramènerait 'safe' au spawn du monde et annulerait
    // tout le bénéfice de la base.
    if (!IS_MAPPER) {
      const st0 = loadBaseState();
      if (st0 && st0.base && Number.isFinite(st0.base.x) && !_safeHomeSet) {
        _safeHomeSet = true;
        _safeHomeSurface = (st0.base.y || 0) >= 58;
        _safeHomePos = { x: st0.base.x, y: st0.base.y, z: st0.base.z };
        emit({ type: 'base_adopted', x: st0.base.x, y: st0.base.y, z: st0.base.z });
      }
      // PRÉCÉDENCE DE L'ANCRE PERSISTÉE (migration de zone, Massii 27/07) : après une migration,
      // tout respawn doit repartir de la NOUVELLE ancre. Le self-healing backend relance la session
      // avec le `--confine` de BOOTSTRAP, et le keeper garde le sien → sans cette précédence, chaque
      // mort ramenait le bot à l'ANCIENNE zone et l'enforcement l'y clouait : c'est le split-brain
      // confine qui a déjà mordu DEUX fois. `--confine` ne fixe plus que le rayon.
      if (st0 && st0.base) {
        const effC = effectiveConfine({ confine: CONFINE, base: st0.base });
        if (effC && (!CONFINE || effC.x !== CONFINE.x || effC.z !== CONFINE.z)) {
          CONFINE = effC;
          emit({ type: 'confine_from_base', x: effC.x, z: effC.z, radius: effC.radius });
        }
      }
    }
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
    // BASE PERSONNELLE (ouvriers seulement — un cartographe roame, une base n'a pas de sens pour
    // lui). 'establish' = aller la poser ; 'return' = relâché loin de chez lui (mort dont le
    // /spawnpoint n'a pas tenu) → rentrer ; 'stay' = déjà chez lui.
    let _baseEstablishing = false;
    if (!IS_MAPPER) {
      // Ce spawn = une nouvelle vie : toute installation encore en vol appartient à la précédente
      // (le bot est mort en chemin) et doit s'arrêter au lieu de marcher vers un point périmé.
      _baseAbort = true;
      const stB = loadBaseState();
      const act = basecamp.spawnAction({
        base: stB && stB.base,
        pos: bot.entity && bot.entity.position,
        spawn: stB && stB.worldSpawn,
      });
      if (act === 'return') {
        emit({ type: 'base_return' });
        homewarp.goHome(bot, 'safe');
      } else if (act === 'establish') {
        // AWAIT, pas fire-and-forget (échec live : `too_close` d=1..23 sur les 3 bots). Le planner
        // autonome et le /tpa de regroupement démarrent au même spawn et prennent le pathfinder :
        // le trajet d'installation était annulé dans la seconde, le bot ne bougeait pas d'un bloc.
        _baseEstablishing = true;
        await establishBase();
      }
    }
    // DETTE DE MORT : revenir au lieu exact, tuer ce qui campe le loot, ramasser — et ne lever la
    // dette QUE quand il ne reste plus rien (Massii : « il revient encore et encore »). La dette est
    // lue depuis le MEMO PERSISTÉ, pas d'un drapeau de process : le self-healing relance le bot à
    // chaque mort, un drapeau mémoire serait perdu au moment précis où il sert.
    // No-op propre sous keepInventory ON (0 item au sol → dette levée à la 1re arrivée).
    if (loadDeathDebt()) {
      (async () => { try { await recoverDeathDebt(); } catch (e) { /* best-effort */ } })();
    }
    // Puis, si --regroup : rejoindre le groupe (no-op silencieux quand le flag est éteint).
    // Pas de regroupement sur le spawn où l'on vient d'installer la base : les 3 ouvriers visent la
    // MÊME base commune, ils se retrouvent donc sans /tpa — et un /tpa ici ramènerait le premier
    // arrivé auprès d'un coéquipier encore au spawn du monde.
    if (REGROUP && !_baseEstablishing) {
      (async () => { try { await sleep(2500); await tryRegroup(); } catch (e) {} })();
    }
  }
  if (world.objective && world.objective.status === 'in_progress') {
    emit({ type: 'autonomous_resume', objective: world.objective.type });
    startAutonomous(null);
  }
}

// Ramasse les items tombés autour de la position courante. Borné (temps + nb) pour ne pas geler.
async function lootNearby(opts = {}) {
  const radius = opts.radius || 20;
  const maxItems = opts.maxItems || 20;
  const budgetMs = opts.budgetMs || 45000;
  let got = 0;
  try {
    if (!(bot.entity && bot.entity.position)) return 0;
    const deadline = Date.now() + budgetMs;
    for (let i = 0; i < maxItems && Date.now() < deadline; i++) {
      const drops = homewarp.dropsWithin(bot.entities, bot.entity.position, radius);
      if (!drops.length) break;
      const e = drops[0].entity;
      if (!e || !e.position) break;
      try {
        await withTimeout(
          bot.pathfinder.goto(new pfGoals.GoalNear(e.position.x, e.position.y, e.position.z, 1)),
          15000, () => { try { stopMotion(); } catch (er) {} });
      } catch (er) { break; }   // inatteignable → on abandonne le ramassage (best-effort)
      await sleep(600);          // laisse la collecte auto (proximité) opérer
      got++;
    }
  } catch (e) { /* best-effort */ }
  return got;
}

// Post-mort (cible keepInventory OFF) : keepInv ON → dropsWithin renvoie [] → no-op immédiat.
async function collectDeathDrops() {
  await lootNearby({ radius: 20, maxItems: 20, budgetMs: 45000 });
  emit({ type: 'death_drops_collected' });
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

// ⚠️ NE COUPE PLUS LE BRAS PAR DÉFAUT (Massii, live 26/07, signalé 3 fois : « ils ont toujours un
// souci pour casser les blocs, il faut qu'ils tiennent le bouton pour les casser, pas spam le
// bouton »). `bot.dig` TIENT le clic jusqu'à la casse — sauf si on l'interrompt, auquel cas le
// minage repart de ZÉRO. Or `stopMotion` était le nettoyage de TOUS les `withTimeout` du code
// (74 appels) et de plusieurs watchdogs : chaque déclenchement annulait le dig en cours et le
// relançait. D'où un minage visuellement saccadé et interminable.
// Le lâcher de bras reste disponible pour le seul cas où il a du sens — répondre en chat, où un
// humain lâche le clic pour taper — via stopMotion({ arm: true }).
function stopMotion(opts = {}) {
  try { bot.pathfinder && bot.pathfinder.setGoal(null); } catch (e) {}
  try { bot.pvp && bot.pvp.stop(); } catch (e) {}
  if (opts.arm) { try { if (bot.targetDigBlock && bot.stopDigging) bot.stopDigging(); } catch (e) {} }
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

bot.on('spawn', () => {
  _floatSettleUntil = Date.now() + 15000;
  // L'état de zone est REPRIS du mémo, jamais réinitialisé : son horloge doit traverser les
  // respawns, sinon l'hystérésis de 15 min n'est jamais atteinte (le bot respawn plus souvent).
  if (!_zoneAnchoredAt) loadZoneState();
  survivalKitUp().catch(() => {});
  onSpawn().catch((e) => emit({ type: 'error', message: String((e && e.message) || e) }));
});

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
  // chantier → re-creuser (pas re-TP) ; safe → sauvetage à pied + re-pose à la prochaine surface sèche.
  const refusedH = homewarp.refusedHome(bot, msg);
  if (refusedH) {
    _homeRefusedAt[refusedH] = Date.now();
    emit({ type: 'home_tp_refused', name: refusedH });
    if (refusedH === HOME_WORK) _workSet = false;
    if (refusedH === 'safe') _safeHomeSurface = false;   // le prochain spawn surface re-posera un safe sain
  }
  // Secure-then-warp : serveurs à teleport-delay — warmup annoncé (info) et surtout ANNULATION
  // (le bot a bougé/pris un coup pendant l'attente) → awaitWarp la voit et safeWarpHome re-tente.
  if (homewarp.isTpCancelled(msg)) { _tpCancelledAt = Date.now(); emit({ type: 'home_tp_cancelled' }); }
  // Refus « demande déjà en attente » : rien n'arrivera, inutile d'attendre les 15 s d'awaitWarp
  // immobile (mesuré : 384 refus en 20 min sur world_mn3). On le traite comme une annulation.
  else if (homewarp.isTpAlreadyPending(msg)) { _tpCancelledAt = Date.now(); emit({ type: 'tpa_already_pending' }); }
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
// ── PRISE OPPORTUNISTE DE MINERAI (Massii 2026-07-26 : « il y a plein de fois où les bots passent
// à côté du fer mais ne le prennent pas »). On ne mine QUE ce qui est déjà à portée de bras (≤4,2
// blocs, aucun déplacement, aucun pathfinding) → la tâche en cours n'est jamais interrompue, elle
// est juste ponctuée. Et on vérifie l'OUTIL : miner du fer à la pioche de bois casse le bloc et ne
// donne rien du tout (`oregrab.canHarvest`).
let _oreGrabBusy = false;
let _oreGrabIds = null;
let _oreDetourIds = null;   // ids des minerais RARES qui valent un detour (cf. oregrab)
setInterval(async () => {
  if (_oreGrabBusy) return;
  try {
    if (!bot.entity || !bot.entity.position || !bot.registry) return;
    const hostile = (() => {
      try {
        const e = bot.nearestEntity((x) => x && x.position && isFleeHostile(x)
          && x.position.distanceTo(bot.entity.position) <= 10);
        return !!e;
      } catch (e) { return false; }
    })();
    const ok = oregrab.shouldGrab({
      busy: _imminentBusy || panicInFlight || _armorBusy || _smeltOppBusy || _baseBusy,
      digging: !!bot.targetDigBlock,
      inWater: (function () { try { return isInWater(bot); } catch (e) { return false; } })(),
      hostilesNear: hostile,
      health: bot.health,
    });
    if (!ok) return;
    if (!_oreGrabIds) {
      _oreGrabIds = [...oregrab.WANTED_ORES]
        .map((n) => bot.registry.blocksByName[n] && bot.registry.blocksByName[n].id)
        .filter((x) => x != null);
    }
    if (!_oreGrabIds.length) return;
    // DÉTOUR pour un minerai RARE visible (Massii 26/07 : « neth 4 a reussi a esquiver une cave,
    // alors que dans la cave il y avait un diamant »). La portée de bras (4,2) ne suffit pas, et
    // pendant la DESCENTE `caveHunt` ne tourne pas encore : un diamant longé à dix blocs passait.
    // Seuls les minerais rares justifient de quitter sa tâche (cf. oregrab.isDetourWorthy).
    try {
      if (!_oreDetourIds) {
        _oreDetourIds = [...oregrab.DETOUR_ORES]
          .map((n) => bot.registry.blocksByName[n] && bot.registry.blocksByName[n].id)
          .filter((x) => x != null);
      }
      if (_oreDetourIds.length) {
        const rare = bot.findBlocks({ matching: _oreDetourIds, maxDistance: 20, count: 1 });
        const rp = rare && rare[0];
        if (rp) {
          const rb = bot.blockAt(rp);
          const d = rb && rb.position.distanceTo(bot.entity.position);
          // ⚠️ Tester le MEILLEUR outil DISPONIBLE, pas celui qui traîne en main. Massii a filmé
          // un bot passant a cote d'un diamant avec un BOUCLIER en main : la pioche etait dans
          // l'inventaire, mais le test portait sur `bot.heldItem` — donc faux, donc aucun detour.
          const _best = bestToolFor(bot, rb);
          if (rb && d > 4.2 && oregrab.canHarvest(rb, _best ? _best.type : (bot.heldItem && bot.heldItem.type))) {
            if (_best) { try { await bot.equip(_best, 'hand'); } catch (e) { /* best-effort */ } }
            _oreGrabBusy = true;
            emit({ type: 'ore_detour', ore: rb.name, d: Math.round(d) });
            await withTimeout(bot.pathfinder.goto(new pfGoals.GoalNear(rp.x, rp.y, rp.z, 2)),
              25000, () => { try { stopMotion(); } catch (er) {} });
            return;   // la passe suivante (800 ms) le minera à portée de bras
          }
        }
      }
    } catch (e) { /* best-effort : jamais bloquant */ }
    // ⚠️ LE SCAN DOIT PORTER AUSSI LOIN QUE LA MARCHE AUTORISÉE (Massii, 27/07 : « il est devant
    // du fer et il ne le mine pas »). `oreStepPlan` accepte de faire quelques pas jusqu'à
    // ORE_STEP_MAX, mais ce scan avait un rayon de 5 : un filon à 8 blocs dans une paroi n'était
    // jamais dans la liste des candidats — la marche était donc morte-née. Les deux valeurs
    // viennent maintenant de la MÊME constante. Coût maîtrisé : `count: 4` arrête le scan dès 4
    // trouvailles, et le rayon reste sans commune mesure avec les scans 256 qui gelaient l'event
    // loop (piège #43a).
    const hits = bot.findBlocks({ matching: _oreGrabIds, maxDistance: oregrab.ORE_STEP_MAX, count: 4 });
    // RAMASSAGE AU SOL (Massii, live 26/07 : « si il y a des item qui leur servent (genre diamant)
    // ils doivent les prendre »). Un minerai miné hors du rayon de ramassage automatique tombe et
    // reste là. On ne se détourne QUE pour ce qui fait avancer la chaîne (cf. oregrab.isValuableDrop)
    // et seulement quand il n'y a pas de minerai à portée — le minage garde la priorité.
    if (!hits || !hits.length) {
      try {
        const drops = homewarp.dropsWithin(bot.entities, bot.entity.position, 10)
          .filter((d) => {
            const n = (d.entity && d.entity.metadata && d.entity.metadata.find
              && (d.entity.name || '')) || (d.entity && d.entity.name) || '';
            const stack = d.entity && (d.entity.displayName || d.entity.itemName || n);
            return oregrab.isValuableDrop(String(stack || '').toLowerCase().replace(/\s+/g, '_'));
          });
        if (drops.length) {
          _oreGrabBusy = true;
          const e = drops[0].entity;
          emit({ type: 'drop_pickup', d: Math.round(drops[0].dist) });
          await withTimeout(bot.pathfinder.goto(new pfGoals.GoalNear(e.position.x, e.position.y, e.position.z, 1)),
            10000, () => { try { stopMotion(); } catch (er) {} });
          await sleep(400);   // laisse la collecte automatique par proximité opérer
        }
      } catch (e) { /* best-effort : jamais bloquant */ }
      return;
    }
    _oreGrabBusy = true;
    for (const pos of hits) {
      const blk = bot.blockAt(pos);
      if (!blk || !oregrab.isWantedOre(blk.name)) continue;
      // QUELQUES PAS pour du minerai visible (Massii 27/07, photo de 3 veines de fer intactes
      // dans les parois d'une salle creusée par les bots). L'ancien contrat — « portée de bras
      // stricte, aucun déplacement » — expliquait exactement ce qu'il voyait : dans une salle,
      // le fer est dans les PAROIS à 5-10 blocs, jamais à 4,2. Un joueur fait les trois pas.
      const plan = oregrab.oreStepPlan({
        name: blk.name, dist: blk.position.distanceTo(bot.entity.position),
      });
      if (!plan) continue;
      if (plan === 'walk') {
        try {
          await withTimeout(
            bot.pathfinder.goto(new pfGoals.GoalNear(blk.position.x, blk.position.y, blk.position.z, 2)),
            12000, () => { try { stopMotion(); } catch (er) {} });
        } catch (e) { continue; }               // inatteignable → on laisse, sans insister
        if (blk.position.distanceTo(bot.entity.position) > oregrab.ORE_REACH) continue;
      }
      const tool = bestToolFor(bot, blk);
      if (tool) { try { await bot.equip(tool, 'hand'); } catch (e) {} }
      const held = bot.heldItem && bot.heldItem.type;
      if (!oregrab.canHarvest(blk, held)) continue;      // pioche insuffisante → on laisse le bloc
      // ⚠️ NE PAS CASSER À TRAVERS LA PAROI (Massii, 27/07 : « neth 2 réussit à casser du fer à
      // travers les blocs mais il ne va pas le chercher »). Sans cette garde, on minait un bloc
      // hors ligne de vue : le minerai tombait de l'AUTRE côté du mur et n'était jamais ramassé —
      // le bot voyait le filon disparaître sans rien gagner. `branchMine` avait déjà cette garde
      // (canSeeBlock/canDigBlock + approche), le ramassage opportuniste non. On s'approche une
      // fois ; toujours pas visible → on laisse le bloc plutôt que de le gaspiller.
      const _reachable = () => {
        try {
          if (typeof bot.canDigBlock === 'function' && !bot.canDigBlock(blk)) return false;
          if (typeof bot.canSeeBlock === 'function' && !bot.canSeeBlock(blk)) return false;
        } catch (e) { /* API absente → on ne bloque pas */ }
        return true;
      };
      if (!_reachable()) {
        try {
          await withTimeout(
            bot.pathfinder.goto(new pfGoals.GoalGetToBlock(blk.position.x, blk.position.y, blk.position.z)),
            12000, () => { try { stopMotion(); } catch (er) {} });
        } catch (e) { continue; }
        if (!_reachable()) continue;                     // inatteignable : on ne le gaspille pas
      }
      try {
        await withTimeout(bot.dig(blk), 12000, () => { try { bot.stopDigging(); } catch (e) {} });
        emit({ type: 'ore_grabbed', ore: blk.name, y: Math.round(blk.position.y) });
        if (/iron/i.test(String(blk.name))) _zoneIronMined += 1;   // rendement de la zone courante
      } catch (e) { /* best-effort : le bloc peut disparaître ou être hors ligne de vue */ }
      break;                                             // un seul par passe : on reste ponctuel
    }
  } catch (e) { /* watchdog : ne crash jamais */ }
  finally { _oreGrabBusy = false; }
// 800 ms, pas 4000 (Massii, live 26/07 : « des fois il passe a cote du fer sans le prendre »).
// Arithmetique du rate : un bot qui sprinte fait ~5,6 blocs/s pour une portee de bras de 4,2.
// A 4 s d'intervalle il parcourait ~22 blocs entre deux controles — il traversait des filons
// ENTIERS sans jamais etre a portee au moment du test. A 800 ms il avance ~4,5 blocs par passe,
// soit la portee : plus de trou de couverture. Le scan lui-meme est minuscule (rayon 5, ~500
// blocs) — sans rapport avec les scans rayon 256 qui gelent la boucle d'evenements (piege #43a).
}, 800);

// ── FAIM : FILET INDÉPENDANT DU RÉFLEXE (mesure 2026-07-26 : 3 morts de faim ALORS QUE les bots
// avaient 64 steaks en poche — contradiction qui dit que manger échouait, pas que la nourriture
// manquait). Cause : `installReflexes` ne branche `tryEat` que sur l'event `health`, et l'eat
// lui-même est un `equip`+`consume` dont l'échec est avalé en silence (`.catch(() => {})`) — or
// `equip` échoue quand le bot est en train de miner, ce qu'un ouvrier fait en permanence.
// Ici : on ARRÊTE de creuser, on mange, et on DIT ce qui s'est passé (le silence est ce qui a
// laissé ce bug vivre plusieurs runs).
let _hungerBusy = false;
setInterval(async () => {
  if (_hungerBusy) return;
  try {
    if (!bot.inventory || bot.food == null || bot.food > 8) return;
    const items = bot.inventory.items() || [];
    const food = items.find((i) => FOODS.has(i.name)) || items.find((i) => EMERGENCY_FOODS.has(i.name));
    if (!food) return;                                   // vraiment rien à manger : ensureFood s'en occupe
    _hungerBusy = true;
    try { bot.stopDigging(); } catch (e) {}               // libère la main (la cause du silence)
    try {
      await withTimeout((async () => {
        await bot.equip(food, 'hand');
        await bot.consume();
      })(), 8000, () => {});
      emit({ type: 'ate', item: food.name, food: bot.food });
    } catch (e) {
      emit({ type: 'eat_failed', item: food.name, food: bot.food, reason: String((e && e.message) || e).slice(0, 60) });
    }
  } catch (e) { /* watchdog : ne crash jamais */ }
  finally { _hungerBusy = false; }
}, 5000);

// ── PLUS DE PIOCHE → EN REFAIRE UNE (Massii 2026-07-26 : « si ils n'ont plus de pioche ils doivent
// en faire une »). La capacité existait (`recoverPickaxe`, buts wooden_pickaxe/stone_pickaxe) mais
// n'était déclenchée QUE depuis le branch-mine, et dans la chaîne armure les buts pioche sont
// court-circuités dès que l'armure est complète (`withFinal(g, IA)`) : un bot équipé mais désarmé
// de sa pioche ne la refaisait jamais. Filet indépendant de la tâche, borné, silencieux s'il manque
// la matière (le planner, lui, ira chercher le bois/cobble).
let _pickFixBusy = false;
setInterval(async () => {
  if (_pickFixBusy) return;
  const hasPick = () => ((bot.inventory && bot.inventory.items()) || [])
    .some((i) => i.name && i.name.endsWith('_pickaxe'));
  try {
    if (!bot.inventory || !bot.entity) return;
    if (hasPick()) return;
    if (_imminentBusy || panicInFlight || _armorBusy || _baseBusy) return;
    _pickFixBusy = true;
    emit({ type: 'pickaxe_missing' });
    for (const name of ['stone_pickaxe', 'wooden_pickaxe']) {
      try { await withTimeout(craftSmart({ name, count: 1 }), 60000, () => {}); } catch (e) {}
      if (hasPick()) { emit({ type: 'pickaxe_recrafted', name }); break; }
    }
  } catch (e) { /* watchdog : ne crash jamais */ }
  finally { _pickFixBusy = false; }
}, 20000);

// ── SQUAD : contrôle À SON PROPRE RYTHME (20 s). Mesuré : branché sur la boucle d'équipe (90 s),
// les bots dérivaient de 300 à 485 blocs entre deux contrôles — le /tpa partait bien (`squad_join`
// → `warped: True`) mais toujours trop tard. C'est la FRÉQUENCE DU CONTRÔLE qui fait la squad, pas
// le seuil. Le cooldown de `squadTarget` (30 s) garde le débit de /tpa raisonnable.
if (REGROUP) {
  let _squadBusy = false;
  setInterval(async () => {
    if (_squadBusy) return;
    if (_imminentBusy || panicInFlight || _baseBusy) return;   // survie et installation d'abord
    _squadBusy = true;
    try { await trySquad(); } catch (e) { /* best-effort */ }
    finally { _squadBusy = false; }
  }, 20000);
}

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
    // 7 s (Massii 2026-07-26 : « quand ils n'arrivent pas à avancer, ils cassent les blocs devant
    // eux »). Le dig-devant existait déjà, mais il attendait 18 s : à l'écran le bot semblait
    // simplement planté. Un joueur réel insiste 2-3 s puis casse.
    if (now - _jamSample.t < 7000) return;                               // pas encore un jam
    _jamSample = null;
    emit({ type: 'unjam', x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
    const yaw = (bot.entity && bot.entity.yaw) || 0;
    const jdx = Math.round(-Math.sin(yaw)), jdz = Math.round(Math.cos(yaw));
    // SAUTER D'ABORD (Massii 2026-07-26 : « ils doivent aussi tester de sauter et aller en avant si
    // c'est juste un bloc en dessous qui bloque le passage »). Une marche d'UN bloc se franchit en
    // sautant : c'est gratuit, instantané, et ça ne défigure pas le terrain. On ne creuse que si le
    // saut n'a rien donné. Condition : la case AU-DESSUS de l'obstacle doit être libre, sinon sauter
    // ne mène nulle part (mur de 2 blocs ou plus → il faut bien creuser).
    {
      const ahead1 = bot.blockAt(vec3Lib(Math.floor(p.x) + jdx, Math.floor(p.y) + 1, Math.floor(p.z) + jdz));
      const ahead2 = bot.blockAt(vec3Lib(Math.floor(p.x) + jdx, Math.floor(p.y) + 2, Math.floor(p.z) + jdz));
      const stepOnly = ahead1 && ahead1.boundingBox === 'block'
        && (!ahead2 || ahead2.boundingBox !== 'block');
      if (stepOnly) {
        try {
          bot.setControlState('forward', true);
          bot.setControlState('jump', true);
          await sleep(700);
        } catch (e) { /* best-effort */ }
        try { bot.setControlState('jump', false); bot.setControlState('forward', false); } catch (e) {}
        const p2 = bot.entity && bot.entity.position;
        if (p2 && Math.hypot(p2.x - p.x, p2.z - p.z) >= 0.8) {
          emit({ type: 'unjam_jumped', x: Math.floor(p2.x), y: Math.floor(p2.y), z: Math.floor(p2.z) });
          _jamSample = null;
          return;                                      // franchi en sautant : aucun bloc cassé
        }
      }
    }
    try { bot.setControlState('jump', false); } catch (e) {}
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
    // 2e TIER — relocate PROUVÉ futile (escalades répétées au MÊME endroit) : sous NO_GIVE+confine, le
    // relocate warpe vers l'ANCRE confine = le spot de jam lui-même (live NethBot4 27/07 world_mn9 : figé
    // à la surface de (0,0,~119), 27 unjam, 0 descente, session gelée). Boucler indéfiniment = bot
    // vivant-en-panne invisible du self-heal (il émet des events → pas « starved »). On SORT du process
    // (miroir death_loop l.4023) → respawn FRAIS (pathfinder/jam vidés, planner repart, keepInventory
    // garde le fer) → le piège est cassé. Bot productif : bouge après relocate → escalades à des spots
    // différents → jamais giveUp.
    if (_je.giveUp) {
      try { taskCtl.cancel(); } catch (e) {}
      emit({ type: 'autonomous_stalled', reason: 'jam_loop', x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
      process.exit(2);
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
// Source unique = goals.wantsOpportunisticArmor (piège #61 : ce Set omettait iron_armor/diamond_armor
// → armure figée pour la flotte de nuit ; désormais testé côté goals + mirroir du timer de fonte).
let _armorBusy = false;
setInterval(async () => {
  try {
    if (_armorBusy) return;
    const objType = (world.objective && world.objective.type) || '';
    if (!wantsOpportunisticArmor(objType)) return;
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
