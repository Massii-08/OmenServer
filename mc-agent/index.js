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
const { installOxygenGuard } = require('./oxygen');
const { installReflexes, RANGED, DEFENSIVE_HEALTH, isFleeOnlyMob, FOODS, EMERGENCY_FOODS, tryEat, pickFood, eatWanted } = require('./reflexes');
const { lowHpStep, craftBlockedAtLowHp, isLowHpSkip, lowHpTargetFor, LOWHP_RECOVERY_BUDGET_MS, LOWHP_FOOD_RUN_TTL_MS } = require('./lowhp');
const { healEatWanted, eatEffective, itemCount, noEffectBackoffMs, eatLockWaitMs, cookFirstWhenHurt, EAT_LOCK_MS, MAX_HEAL_BITES } = require('./eatSafe');
const { decideReaction } = require('./triggers');
const { loadCommands, isAllowed, buildCommandDocs } = require('./commands');
const { loadPolicy, isTrusted, parseTpRequest, parseTradeRequest, gateDecision, buildTrustDocs } = require('./trust');
const { parseOrder } = require('./orders');
const { createTaskController } = require('./tasks');
const { createMemory } = require('./memory');
const { bestWeapon, bestToolFor } = require('./tools');
const { shouldSprint, applyPathfinderBounds, withTempMovements } = require('./movement');   // sprint « vrai joueur » ON par défaut (Massii 2026-06-22) + bornage A* (anti-OOM 2026-07-25)
const { installBridgeGuard } = require('./bridges');   // pas de pont au-dessus d'une vallée / de l'eau (Massii 19/10)
const lavaGuard = require('./lavaGuard');   // lave : ni creuser un bloc qui la retient, ni longer son bord (23/10)
// `lava_avoided {where}` : au plus un par lieu toutes les 10 s (NIVEAU MODULE : appelé depuis des timers).
const _lavaAvoidedOk = lavaGuard.createAvoidedThrottle(10000);
function lavaAvoided(where, pos, extra) {
  try {
    if (!_lavaAvoidedOk(where)) return;
    const ev = { type: 'lava_avoided', where };
    if (pos) { ev.x = Math.floor(pos.x); ev.y = Math.floor(pos.y); ev.z = Math.floor(pos.z); }
    emit(Object.assign(ev, extra || {}));
  } catch (e) { /* jamais bloquant */ }
}
const { copySafetySettings, createMovesKeeper } = require('./pluginMoves');   // fuite de Movements des plugins collect/pvp (19/10)
const { createGoalTrace, installGoalTrace } = require('./goalTrace');   // DIAG GoalChanged : qui pose un but pendant un goto ? (aucun effet sur le bot)
const vec3Lib = require('vec3'); // watchdog anti-jam (blocs barrants)
const { realThreat, woodHidePlan, woodHideStateAt, hasLineOfSight } = require('./threatgate');
const { creeperPlan, creeperIsThreat, isCreeperFusing, awayPoint: creeperAwayPoint, fleeDone: creeperFleeDone, FLEE_KEEP: CREEPER_FLEE_KEEP } = require('./creeper');
const {
  HANDOFF_MAX_TRIES, HANDOFF_ENTITY_WAIT_MS, HANDOFF_APPROACH_MS, HANDOFF_POLL_MS, HANDOFF_BEAT_CHECK_MS,
  HANDOFF_RECEIVE_WAIT_MS, isGiftForMe, slotsToFree, pickupTargets, tossReady, deliveryProof, handoffNext, receiverNext,
} = require('./handoff');   // remise en main propre d'une pièce d'armure (24/10)
const { createHoldState, installGoalHold, holdSetGoal, hold: holdGoal, release: releaseGoalHold } = require('./goalHold');   // fuite creeper : le planner ne vole plus le but
const { auraTarget, auraPlan, auraReadyPlan, AURA_READY_REACH } = require('./aura');
const { gather, woodExpeditionCount, woodExploreShape } = require('./skills/gather');
const { gotoWithTimeout } = require('./skills/explore');   // trajet borné ET interruptible (abortIf)
// Kit de secours en coffre (run 10, 20/10) — décisions PURES, glue « KIT DE SECOURS EN COFFRE ».
const { depositPlan, restorePlan, STASH_NEAR_BASE } = require('./stash');
const { mineDown: _mineDownRaw } = require('./skills/mineDown');   // gardé plus bas (anti-vide)
const { guard } = require('./skills/guard');
const { giveItem, giveAll } = require('./skills/give');
const { craftItem } = require('./skills/craft');
const { planIntermediates, woodCountFallback, craftSignature, createCraftBackoff, logBase } = require('./craftPlan');
const { respawnFleePlan, fleeStuck, RESPAWN_FLEE_LEGS, RESPAWN_FLEE_LEG_MS, RESPAWN_STUCK_MS } = require('./respawnFlee');
const { deposit } = require('./skills/deposit');
const { equipItem, eat } = require('./skills/equip');
const { loiter } = require('./skills/loiter');
const fs = require('fs');
const { runPlanner } = require('./planner');
const { chainFor, buildCtxInv, firstUnmet, armorNeed, chainAfterDone, wantsOpportunisticArmor, GIFT_SET_INGOTS, objectiveForStart, diamondTargetOf, HELP_STOCK, diamondArmorPlanOf, swordPlanOf } = require('./goals');
const { isForbiddenCheat } = require('./nogive');
const homewarp = require('./homewarp');
const voidGuard = require('./voidGuard'); // anti-vide : sol sous les homes/spawnpoint, descente loin de la base, rattrapage post-TP // couche warp LÉGITIME sans-give (/sethome+/home ; goSpawn=/home safe)
const { secureSpot } = require('./skills/secureSpot'); // secure-then-warp : pilier/se murer/flotter AVANT le /home
const { SCAFFOLD, pillarUp } = require('./skills/pillarUp');     // blocs sacrifiables (comptés pour la tactique)
// PILIER ANTI-MÊLÉE + POINT DE RÉAPPARITION CAMPÉ (live 22/10, NethBot3 : 9 morts « slain by Zombie » en
// 2 min 27 s, en plein jour, au point de réapparition) — cf. meleePillar.js / respawnCamp.js.
const meleePillar = require('./meleePillar');
const respawnCamp = require('./respawnCamp');
const respawnEscape = require('./respawnEscape');   // sortir d'un point de réapparition campé (23/10)
const { boundedDig, boundedEquip } = require('./digBound');
const basecamp = require('./basecamp');                // base personnelle : s'éloigner du spawn du monde puis /sethome
const oregrab = require('./oregrab');
// NUIT AU TRAVAIL + FONDRE EN MINANT (Massii 21/10 : « fais qu'ils fassent comme les joueurs normaux »).
const { nightWorkPlan, nightUnderground, nightDeferGoal, nightSealCells, shelterCraftNext } = require('./nightWork');
const { furnaceJobPlan, fuelLoadPlan, jobReadyAt, SMELT_JOB_ABANDON_DIST, SMELT_JOB_COLLECT_DIST, furnaceJobRestore, furnaceCollectRoute, FURNACE_RETRY_MS } = require('./furnaceJob');                  // « ils passent à côté du fer sans le prendre »
const { huntPassive } = require('./skills/hunt');
const { fishCatch, rodPlan } = require('./skills/fish');   // pêche : la nourriture qui ne s'épuise pas
const { nearestPassive, survivalTick, nearbyHostiles, lavaNearby, armorPoints, weaponDamage } = require('./survival');
const { loadWorld, saveWorld, setObjective, clearObjective } = require('./worldModel');
const { _nearestTable, tableKey, tablePlan, TABLE_REACH, TABLE_SEEK, pickJunkToToss, needsRoomFor } = require('./skills/craft'); // craftItem déjà importé plus haut
const { fillOverflow, fillCapDue, tossTarget } = require('./fillCap');   // plafond de remblai (23/10)
const { noPickWhy } = require('./noPick');                   // pioche irremplaçable (23/10)
const { recycleWorthIt, createNoSpaceMemo, stepAsideCells } = require('./tableSpot');
const { placeBlockNear } = require('./skills/placeBlockNear');
const { smelt, logsToConvert, fuelUnits } = require('./skills/smelt');
const { descendDiagonal: _descendDiagonalRaw } = require('./skills/descendDiagonal');   // gardé plus bas (anti-vide)
const { pickTier, stoneBatchWant, stoneStairPlan } = require('./stoneDig');
const { pickWornOutToReport } = require('./wornOut');
const { equipPlan: armorEquipPlan, coolingSlots: armorCoolingSlots, recraftCooling: armorRecraftCooling, ironCraftBlocked } = require('./armorWear');
const { branchMine: _branchMineRaw, bmBail, floodFillVein, currentPhase: bmCurrentPhase, neighborsHaveLava: bmNeighborsHaveLava, wallLava: bmWallLava } = require('./skills/branchMine');   // gardé plus bas (disjoncteur OOM)
const heapGuard = require('./heapGuard');   // OOM « au même endroit » du branch-mine (23/10)
const { installToolGuard } = require('./toolGuard');
const { diaWornCount, armorTier, isIronDonor } = require('./diaArmor');   // armure diamant des mineurs (24/10 soir)   // OOM 23/10 : récursion sans fin de mineflayer-tool
const { diamondFree, cautionNight, diamondNightPlan } = require('./freeRoam');   // diamant complet = libre la nuit (24/10)
const loopGuard = require('./loopGuard');   // sync_loop_capped + loop_lag (gels de l'event loop)
const { caveHunt, sharedSkipStore: caveHuntSkip, sharedStrikeStore: caveHuntStrikes, nearSkipped: caveNearSkipped, approachBudgetMs: caveApproachBudgetMs, legWaypoint: caveLegWaypoint } = require('./skills/caveHunt');   // cave-first diamant (Massii 26/07)
const { digVisibleOre, oreStateOf: diamondOreStateOf, DIAMOND_ORES } = require('./skills/diamondDig');   // casse VÉRIFIÉE d'un diamant visible (25/10)
const { caveIron: caveIronSkill } = require('./skills/caveIron');   // fer en grotte (Massii 20/10)
const caveIronPick = require('./caveIron');
const oresScan = require('./ores');                          // scan ciblé du fer VU (ironCaveCtx, 24/10)
const { classifyAuthPrompt, genPassword, resolveAuthChat } = require('./auth');
const { loadMemory, worldKey, resolveBiome } = require('./worldMemory');
const { driestCell, oreBase } = require('./ores');         // warp near-spawn DRY-AWARE + normalisation type (fix #8)
const { recordAnchor, pickDryAnchor } = require('./anchors'); // ancres profondes SÈCHES (anti boucle de noyade)
const { runMapper, createExpiringSet } = require('./mapper');   // createExpiringSet : liste noire des tables inutilisables (withCraftingTable)
// (LOCATE_KINDS / parseLocateResponse ne sont plus importés : /locate est retiré des bots, cf. plus bas.
//  structureFoundEvent est émis par mapper.js depuis les signatures VUES.)
const { isInWater, escapeWater: _escapeWaterRaw, findLandTarget, isFloatingStuck, recoverFloating, isFrozenDesync,
  escapePlan, escapeReached, canReanchorSpawn, ESCAPE_SAFE_RADIUS,
  // Fuite dès le spawn + historique de morts persisté (live 19/10, MapBot1) — décisions PURES, cf. unstuck.js.
  spawnDanger, SPAWN_DANGER_MIN_WORN, hostilesWithin, deathTimesPrune, deathTimesLoad, deathMemoWith, escapeArmed, deathLoopTripped,
  // Premières secondes après un respawn : se terrer plutôt que courir (run 10, 20/10).
  spawnGuardPlan } = require('./unstuck');
// Neutres tant qu'on ne les provoque pas (enderman) : jamais une raison de fuir au spawn (même liste que nearbyHostiles).
const { NEUTRAL_NO_PROVOKE } = require('./survival');
const deathzones = require('./deathzones'); // ban-zone des camps de mort (≥2 alertes → fuite active)
const { recordOceanStuck } = require('./oceanEscalate'); // baie humide PERSISTANTE → relocate forcé (live 22/06 ResBot1)
// Verdict de zone + migration autonome (Massii 27/07). L'état de zone est PERSISTÉ (zoneState*) :
// en mémoire de process, son horloge repartait à zéro à chaque respawn et l'hystérésis de 15 min
// n'était jamais atteinte — c'est pourquoi la migration n'a jamais tiré de la journée.
const {
  zoneVerdict, verdictTelemetry, pickMigrationTarget, migrationLeg, legHeading, LEG_STUCK_MIN, legDigRetry, legIsGood, minDistFor,
  ironUnits, ironSampleGain,
  zoneFailureKind, zoneFailureWeight, zoneStateInit, zoneStateLoad, zoneStateAfterMigration, MAX_LEGS, MIGRATE_MIN_PROGRESS, LOADED_RADIUS,
  migrationCancelEffect, migrationResumeDecision, deathCampDefersToMigration,
  LOGS_NOT_FOUND_MAX, windowAdd, windowSum, windowPrune, ZONE_WINDOW_MS,
  zoneStateAfterFailedMigration, migrationEarlyExitOk, pruneFailedTargets, migrationArrivalOk,
  depletedForZone, migrationKeepWalking, migrationConfineGraceMs,
  migrationOrigin, woodRetryAvoid, woodSpots,
} = require('./zone');
const { recordWorkDrown, noteDrownedSite, isDrownedNear, offsetFromDrowned } = require('./workDrown'); // chantier adjacent à un aquifère → abandon + BANNISSEMENT du lieu (3a)
const { createDeathSpots } = require('./deathspots');
// deathzones.js = alertes PRÉ-mortem (camps de mobs, near-death) ; deathspots.js = morts RÉELLES
// toutes causes (chutes/ravins compris — vécu : 7 morts/12 min dans le même ravin, que le
// death-camp mobs ne voyait pas). Les deux coexistent.
const deathSpots = createDeathSpots();
const { recordWorkStuck } = require('./workStuck'); // chantier menant à une impasse SÈCHE (drop_ahead/max_depth) → abandon+relocate (live 27/07 world_mn9)
// Run 20/10 : regard d'enderman, faim sous terre, drop_ahead en boucle (cf. les trois modules purs).
const { lookIsUnsafe, wrapLook, creepyIndex, angerReason, hurtCulprit, endermanResponse } = require('./enderman');
const { descentFoodGate, undergroundFoodTripDue, foodGateLoad } = require('./foodGate');
const { noteDropAhead, turnYaw, shiftTarget } = require('./dropAhead');
const { canDealWith, attackDamage, boldFightAdvised } = require('./survival');
const { fleeTarget } = require('./skills/fleeFrom');
const { decideSkeletonResponse, findCoverCell, zigzagSide, shooterSees, rushStopReason, eatDuringRush, callerFromStack, rushRearmWanted, rushEquipBlocked } = require('./skeletonResponse');
const { createFightBreaker, isZombieDuel } = require('./fightBreaker');
// SYSTÈME À 3 HOMES (Massii 27/07) : safe = LA BASE, work = le chantier courant, death = la dette
// de mort. Le serveur n'autorise que 3 homes et le code en posait 4 → un /sethome échouait EN
// SILENCE sur chaque bot (bug prouvé world_mn5). Voir homes.js.
const { HOME_SAFE, HOME_WORK, HOME_DEATH, LEGACY_HOMES, canBookmarkDeath, openDebt, debtAction, inventoryKept, isSurfaceSpot, SAFE_HOME_MIN_Y, isSilentSafeFailure } = require('./homes');
// HOME `safe` CAMPÉ (live 19/10, MapBot2 : 8 morts en 3 min — chaque secours le ramenait au camp du
// spawn). Décisions PURES ; la glue (veto, re-pose, mémo) est plus bas, section « HOME safe CAMPÉ ».
const {
  homeCamped, spawnpointVeto, rescueWarpVeto, safeHomeMove, spawnSafeHomeAction, deathPosPrune, deathPosLoad, deathPosMemoWith,
  safeHomeLoad, safeHomeMemoWith, nearestHostile, hostileNearHome, CAMPED_EVENT_EVERY_MS, deathsNear, hostileSeenRecently,
} = require('./homeSafety');
const { createSurvey } = require('./survey');   // cartographie en passant par les mineurs (24/10)
const { deepSpotCheck, shouldRefreshDeepWork, deepWorkWarpPlan, deepWorkLanded, deepWorkLoad } = require('./deepWork');   // chantier de diamant persisté (24/10)
const { mapperNightPlan } = require('./mapperNight');   // nuit du cartographe : rentrer au home ou se terrer ICI (21/10)
const { recordJam, jamLoopMemoWith, jamLoopAtStart, jamLoopCleared } = require('./jamEscalate'); // JAM persistant au MÊME endroit → relocate forcé (live 22/06 SOIR ResBot2) ; jam_loop répété → escalier (20/10)
const { digOut: digOutSkill, isOutside: digOutIsOutside, DIG_OUT_MAX_MS } = require('./skills/digOut'); // escalier vers la surface quand aucun home ne sort le bot (20/10)
const { runResource } = require('./skills/resource');
const { planSmeltRaw } = require('./bank');   // fonte périodique du brut or/fer → lingots bankables
const { tunnelTo } = require('./skills/tunnelTo');
const { junkItems, ITEMS_FOR } = require('./quota');
const { Y_OPT, pickaxePlan, pickaxeRecraftPlan, armorPlan, ARMOR_PIECES, bestArmorToEquip, armorUpgradePlan, isMinimallyArmored, shieldPlan, smeltPlan, smeltReady, isNearlyBroken } = require('./gear');
// Torche tous les N paliers de branch-mine (mob-aware phase B) — best-effort : sans torche
// en poche le minage continue sans (zéro coût en peaceful, sécurité en non-pacifique).
const TORCH_EVERY = 12;   // 24/10 (Massii « moins de torches ») : + espacement ≥ 11 blocs (torches.js)
const { createClaims, createPresence } = require('./claims');
const { pickMapperTp } = require('./mapperTp'); // TP-au-mappeur : à qui demander le /tpa (décision pure)
// REGROUPEMENT APRÈS MORT (idée Massii 25/07, flag --regroup, OFF par défaut) : décision pure.
const { pickRegroupTarget, squadTarget, isMiningGoal, mateNearby } = require('./regroup');
// Tracé en LACETS du branch-mine fer + reprise au front (22/10, lawnMine.js).
const lawnMine = require('./lawnMine');
// ENTRAIDE D'ÉQUIPE (Massii 25/07 : « qu'ils s'aident entre eux, et quand ils ont l'armure
// fer ils se séparent »). Décisions PURES ; l'exécution (marche + toss) est ci-dessous.
const { teamStatus, pickDonation, allArmored, pickMobAssist, pickMapperToEquip, giftSetPlan, teamPhase,
  latchedTeamPhase, pickDivertedMiner, armorRepairs, TEAM_LATCH_STALE_MS, NAKED_MAPPER_MAX_WORN } = require('./teamwork');
// PHASE DIAMANT (24/10 soir) : objectif d'un mineur sous le cliquet + repli branch-mine du fer introuvable.
const { latchedMinerObjective, isIronOreGather, noteIronGatherFail, ironGatherPlan } = require('./diamondPhase');
const {
  isWoodGoal, woodWantFor, logCount, activeLumberjack, woodWaitDecision, WOOD_UNDERGROUND_Y, preferredLumberjack,
  lumberjackVerdict, pickWoodRequest, tossPlan, WOOD_REQUEST_TTL_MS, WOOD_MIN_GIFT, LUMBERJACK_STOCK,
  wornIronCount, LUMBERJACK_MIN_WORN, ljSwitchBlock,
  missingIronPieces, ownArmorAction, pickMapperForLumberjack, ljGiftReady,
  woodShortForFailure, woodGoalShortage, giftBatchFor, pickArmorTargetForLumberjack, mapperGiftNeed, lumberjackRetireForDiamond,
  stockFailsPrune, stockFailsAdd, needsForestTrip, forestTriedAdd, pickForestCell, LJ_FOREST_TRIP_MS,
  ljIronSlicePlan, LJ_IRON_SLICE_MS, LJ_IRON_CHECK_MS, LJ_MINE_COBBLE, ljMineTargetY,
  ljSliceRetryMs, ljSliceFailsAfter, isWaterFailReason, ljMineDetour,
  woodEquiv, peerWoodSupplier, peerDonorSafe, pickPeerWoodGift, woodGiftTossPlan, pickWoodedMate, ljWoodMigrationDue,
} = require('./lumberjack');
const { tierRank } = require('./tools');
const { createTeleportWatcher, wireTeleportDetection } = require('./teleport');
const { isNight, shelterUntilDawn, exitPendingShelter, shouldShelter, shelterHold, DAWN_WAIT_MAX_MS, DAWN_SAFE_EXIT_MAX_MS, escapePit, inPit: shelterInPit } = require('./skills/shelter');
const { plannerWatchdogVerdict, deriveToken } = require('./plannerWatchdog');
const { rushResumesPlanner, plannerOrphanVerdict } = require('./plannerRevive');
const { shelterToken, shelterCancelLoopNote } = require('./shelterToken');
// LIT (20/10) : réapparaître dans sa base, pas au spawn du monde campé — cf. bed.js.
const { bedItemIn, bedRecipeName, woolMissing, sheepKnown, bedMemoWith, bedMemoCleared, bedRetryMemo, bedOf, bedRetryActive,
  bedSpotPlan, parseBedMessage, sleepErrorReason, sleepDecision, isBedName, BED_HUNT_BUDGET_MS } = require('./bed');
const { maybeRunKit } = require('./kit');   // survie mappeur : /kit serveur au démarrage/respawn (décision pure)
const { needDirtBuffer } = require('./dirt');   // survie mappeur : buffer de blocs posables pour sceller l'abri
const { panicWall } = require('./skills/panicWall');
// DÉFENSE EN TUNNEL (run 21/10 soir) : sous terre dans un couloir, tenir la position (armé) ou se murer
// au lieu de fuir dans le noir — cf. tunnelDefense.js. Remplace la fuite des réflexes et des ticks de survie.
const { tunnelFlee } = require('./skills/tunnelGuard');
// COUVERT anti-squelette (tueur n°1 des bots nus, preuve live world_ax4 25/07) : couper la
// ligne de vue d'un tireur au lieu de charger/fuir à découvert. Décision pure dans cover.js.
const { shouldTakeCover } = require('./cover');
// DISCIPLINE DE TORCHE calée sur la capture réelle (131/97 torches en 33 min chez les humains,
// torche en main ~10 % du temps) — le bot n'éclairait QUE le tunnel de branch-mine.
const { shouldPlaceTorch, nearestTorchDist, sharedTorchRegistry } = require('./torches');
const { takeCover, pickCoverBlock } = require('./skills/takeCover');
// PRUDENCE / FIABILITÉ D'ÉQUIPEMENT DU CARTOGRAPHE (mesure live world_mn14 : les 3 mappeurs
// concentrent la moitié des morts de la flotte, MapBot1 92 morts en respawnant `worn:0` en boucle).
// Décisions PURES : abri tant qu'il est nu, ré-essai d'équipement, ramassage → équipement,
// raison de fonte toujours renseignée. Cf. caution.js.
const {
  mapperCaution, regroupCaution, migrationCaution, equipRetryPlan, isEquipPickup, normalizeSmeltResult, PICKUP_EQUIP_DELAY_MS,
  sprintAllowed,
  // DISCIPLINE DE NUIT (19/10 soir, run « de zéro » world_oct9 : 33 morts en 35 min, surtout la nuit) :
  // le prédicat COMMUN (nu + nuit connue), la décision du planner avant un skill, le compte des ré-abris.
  nightLockdown, nightPlannerStep, lockdownShelterNote, NIGHT_SHELTER_GAP_MS, NIGHT_UNDERGROUND_Y,
  // FAMINE (run world_mn15, 18/08 — 5 « starved to death » en 10 min sur des bots BLINDÉS) :
  // le déclencheur PRÉCOCE de la quête de nourriture, et son rationnement adaptatif (v7).
  foodRunNeeded, foodRunCooldownAfter, FOOD_RUN_COOLDOWN_MS,
  // Plancher de surface de la chasse — lu par `fishAtKnownWater` (mode « expédition », non appelé).
  FOOD_SURFACE_Y,
} = require('./caution');
// LA FICELLE — la pêche exige une canne (3 bâtons + 2 ficelles) et `no_rod` sortait 444 fois : la
// ficelle ne se ramasse pas au sol, elle se prend sur l'araignée (cf. skills/huntSpiders.js). Depuis
// le 19/10 la chasse dédiée n'est plus appelée (trop longue) ; la ficelle vient du ramassage après
// combat (wireCombatLoot). `fishAtKnownWater` reste défini, non appelé. 22/10 : `huntSpidersGoal`
// revient dans la sortie nourriture, BORNÉ (≤ 30 s, araignée en vue, seulement si la ficelle manque à la canne).
const { huntSpiders, nearestSpider } = require('./skills/huntSpiders');
// L'EAU CONNUE — de la carte du groupe (cellules océan/rivière peintes par les cartographes) vers
// un point où marcher. Cf. waterfind.js (lu par `fishAtKnownWater`, non appelé depuis le 19/10).
const { nearestWater, WATER_TRIP_MAX } = require('./waterfind');
// NOURRITURE EN POINTS DE FAIM + BUDGET DE TEMPS (Massii 19/10 : « l'important c'est la VITESSE : pas de
// choix qui font trop durer, et dans le pire des cas il y a la viande de zombie »). `food.js` = la
// table de points, les plafonds et les décisions pures ; `foodRun.js` = les deux orchestrateurs
// (ensureFood, huntCookGoal) testés avec des dépendances fausses. L'ancien compteur « viande CUITE
// seulement » n'existe plus : une seule mesure, `foodPoints`.
const {
  foodPoints, STOCK_POINTS, ENSURE_SKIP_POINTS, HUNT_SIGHT_RADIUS, HUNT_COOK_TIMEOUT_MS, FOOD_RUN_TIMEOUT_MS, HUNT_WAVE_MS,
  FISH_RADIUS, FISH_TARGET, FISH_MIN_MS, boundedToken, shouldLootAfterCombat,
  FISH_SESSION_RADIUS, FISH_SESSION_GOTO_MS, FISH_SESSION_CATCH_MS, FISH_SESSION_MISSES, STRING_HUNT_RADIUS,
  COMBAT_LOOT_RADIUS, COMBAT_LOOT_ITEMS, COMBAT_LOOT_MS, COMBAT_LOOT_HOSTILE_RADIUS, COMBAT_LOOT_SETTLE_MS,
  FOOD_DROP_RADIUS, pickFoodDrop,
} = require('./food');
const { runEnsureFood, runHuntCook, foodRunPreempt } = require('./foodRun');
const { isRawMeat, rawEatAllowed, ateFields, cookLotPlan, ironFuelReserve, COOK_LOT_MAX_MS, COOK_LOT_HARD_MS, COOK_FAIL_COOLDOWN_MS } = require('./cookMeat');
// L'EXPÉDITION VERS LE GIBIER (19/10) : à vraie faim, de jour, en surface, sans aucun passif à ≤ 32 blocs,
// UNE marche vers la cellule à animaux la plus proche connue de la carte du groupe. Les décisions pures
// (où, faut-il partir, quelle jambe, quelles cellules écarter) sont dans foodTrip.js, l'ordre des
// phases dans foodRun.runHuntCook ; le câblage sur le bot (foodTrip*) est juste avant huntCookGoal.
const {
  pickGrazingCell, foodTripLeg, triedCellsLoad, triedCellsAdd, FOOD_TRIP_MEMO_KEY, isOrderOwner,
  FOOD_TRIP_MS, FOOD_TRIP_YIELD_MAX_MS, FOOD_TRIP_NEAR, FOOD_TRIP_ARRIVED, FOOD_TRIP_LEG_MS, FOOD_TRIP_LEG_MIN_MS, FOOD_TRIP_MAX_LEGS, FOOD_TRIP_STUCK_MAX,
  FOOD_TRIP_LONG_EXTRA_MS, FOOD_TRIP_LONG_MEMO_KEY, longTripLoad, longTripDue, longTripRecord,
  HERD_BARREN_MEMO_KEY, herdBarrenRecord, herdBarrenRecent,
} = require('./foodTrip');
// TROUPEAUX VUS (22/10, huntReach.js) : chaque animal de bot.entities (jusqu'à 96 blocs) est noté par
// cellule de 32 dans le mémo de base ; l'expédition vise le troupeau connu le plus proche AVANT les biomes.
const { herdSightings, herdsLoad, herdsObserve, herdsForget, herdsChanged, pickHerd, knownHerdNear, herdToMarkAfterFail, HERD_MEMO_KEY, HERD_CELL } = require('./huntReach');
const { shelterCraftThrottled } = require('./lowhp');

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
// --xray 1 : run où le « full x-ray » est AUTORISÉ (décision opérateur, par run). Débride le
// filtre `exposedOnly` du CIBLAGE : le bot peut viser les minerais mappés ENTERRÉS, comme avant
// le durcissement water-wall. ÉTEINT par défaut → le couplage historique (anti-xray armé par le
// mode sans-give) reste strictement inchangé. Ne touche PAS à caveHunt, dont l'`exposedOnly` est
// une contrainte PHYSIQUE (il rejoint sa cible par la grotte, sans creuser).
const XRAY = args.xray === '1' || args.xray === 'true';
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
let deathTimes = [];        // morts récentes (10 min) — HÉRITÉES du mémo de base + celles de ce process
// Historique de morts PERSISTÉ (live 19/10, MapBot1 : 4 morts de plus à CHAQUE génération de process).
// `death_loop` fait process.exit(2), le self-healing relance un process NEUF : en mémoire de process
// l'historique repartait de zéro et l'évasion n'était armée qu'après 2-3 nouvelles morts. Il vit donc
// dans le mémo de base (loadDeathHistory / persistDeathHistory), comme la dette de mort et la zone.
// ⚠️ Gardes de NIVEAU MODULE (piège #56) : le handler `death` et le handler `spawn` les lisent HORS de
// onSpawn — déclarées dans onSpawn, elles lèveraient une ReferenceError et tueraient le process.
let _deathHistoryLoaded = false;   // l'historique a été relu du mémo (UNE fois par process)
const _bootAt = Date.now();        // démarrage de CE process : sépare ses morts propres des morts héritées
                                   // (le garde-fou death_loop ne compte que les siennes, cf. deathLoopTripped)
// keepInventory MESURÉ (20/10 — le propriétaire bascule le réglage entre deux runs) : total d'objets
// relevé au moment de la mort, comparé au respawn par homes.inventoryKept. Lu par recoverDeathDebt (timer
// compris) → NIVEAU MODULE (piège #56). -1 = pas de mort vue dans ce process (aucune preuve).
let _invAtDeath = -1;
let _escapeOnSpawn = false; // anti-camping : 2 morts <60 s → au prochain spawn, escapeDeathCamp()
                            // (sans-give : fuite À PIED puis re-spawnpoint SEULEMENT si au calme)
                            // Lu et CONSOMMÉ par guardSpawn (qui observe aussi le danger visible au spawn) ; armé aussi par un
                            // historique hérité qui dit « ce spawn est campé » (loadDeathHistory).
// Fuite d'évasion EN COURS. Garde de niveau MODULE (piège #56) lue par les deux mécanismes de TP
// automatique (enforcement confine + squad /tpa) : un yank pendant la fuite ramènerait le bot vers
// l'ancre/le chef, donc potentiellement DANS le camp qu'il est en train de quitter — exactement la
// classe de bug déjà vécue avec `_migrating`.
let _escaping = false;
// CHARGE SUR UN SQUELETTE EN COURS (23/10, skeletonResponse.js) : garde de NIVEAU MODULE lue par
// stopMotion, startAutonomous, l'enforcement confine, le squad, le regroupement, le rappel du home et le
// verrou de repas. Déclarée ICI (tôt) : ces fonctions la lisent toutes.
let _skelRushBusy = false;
let _skelRushWeapon = null;   // nom de l'arme de la charge en cours (lu par le garde d'equip, niveau MODULE)
let _skelRushEquipBlockedAt = -Infinity;
let _skelRushBlocked = { stops: 0, by: null };   // stopMotion/pvp.stop refusés pendant la charge (diag)
let _skelPlannerPending = false;                // un startAutonomous est arrivé pendant la charge
// DETTE DE RELANCE (live 24/10, NethBot1 s599 / NethBot2 s583) : la charge en cours a coupé le planner et doit
// le rallumer. Une 2e charge (ou une fuite) qui la préempte HÉRITE de la dette — sinon le planner mourait.
let _skelRushOwesPlanner = false;
let _skelRushYieldBy = null;                    // chemin VITAL qui a repris la main (lave, noyade, panique, creeper)
// EXPÉDITION VERS LE GIBIER EN COURS (marche + chasse sur place, cf. foodTripLock). Garde de niveau
// MODULE (piège #56), de la même famille que `_migrating`/`_escaping` : lue par l'enforcement confine,
// le squad et la décision elle-même (une seule expédition à la fois). Sans elle, l'ancre ou le chef
// ramèneraient le bot en /home ou /tpa au milieu de la marche — et l'expédition n'aboutirait jamais.
let _foodTripBusy = false;
// CHASSE EN COURS (huntCookGoal : chasse → cuisson → pêche, avec ou sans expédition). COMPTEUR de niveau
// MODULE (piège #56) — le hook de descente (planner) et le timer nourriture peuvent en lancer chacun une.
// 23/10 : 36 des 42 `hunt_failed` de 6 h = la marche vers la bête annulée par un autre goto (collectBlock,
// branchMine, oreGrab, descendDiagonal…). Lu par foodTripYield (le planner cède), le confine, le squad,
// le ramassage de minerai et foodRunTick.
let _huntCookBusy = 0;
// EXPLORATION DE SURFACE EN COURS (gather{explore:true} : lj_stock/logs et la chaîne autonome
// minerai/bois). Garde de niveau MODULE (piège #56), même famille que `_foodTripBusy` : `explore()`
// (skills/explore.js) est AUTORISÉ par `bot._mcaExploreBounds` à voyager jusqu'à 2× le rayon confine
// (280 blocs par défaut), mais l'enforcement confine yanke dès 1,25× (175) — sans elle, tout trajet
// au-delà de 175 blocs se faisait couper par un `/home` en pleine marche et recommençait pour rien
// (mesuré 21/10 : NethBot1 bûcheron, `confine_enforce dist:212` en pleine recherche de bois, 0 pièce
// d'armure en 180 min pendant que NethBot2 en avait 4 sans ce rôle).
let _exploreBusy = false;
// Génération de fuite : le bot peut MOURIR pendant sa course (c'est même le cas nominal quand le
// camp est tenace) → un nouveau onSpawn relance une évasion pendant que l'ancienne attend encore
// son `goto`. Sans ce jeton, la vieille invocation reprendrait la main après coup et poserait un
// /spawnpoint en jugeant une arrivée qui n'est plus la sienne — le bug qu'on répare, en pire.
let _escapeGen = 0;
let _safeHomeSet = false;     // warp légitime : /sethome safe posé (fallback = position de spawn courante)
let _safeHomeSurface = false; // safe posé à une VRAIE surface (y≥58) → cible idéale pour goSpawn
let _deathDebtBusy = false;   // une seule récupération de dette en vol (le respawn peut se répéter en rafale)
// Buts qui exigent du BOIS ou une TABLE : introuvables sous terre (cf. wood_trip ci-dessous).
const WOOD_GOALS = new Set(['logs', 'planks', 'plank_buffer', 'crafting_table', 'sticks', 'wooden_pickaxe']);
// Skills de MINAGE profond : le latch `_needsWoodTrip` ne les remonte jamais en surface (cf. woodTripWanted).
const WOOD_TRIP_NEVER_SKILLS = new Set(['branchMine', 'caveIron', 'caveHunt', 'descendDiagonal']);
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

// ── CHANTIER DE DIAMANT PERSISTÉ (deepWork.js, Massii 24/10) ─────────────────────────────────────
// Le home `work` profond (y ≤ -40, case sûre) est posé/rafraîchi PENDANT le travail et survit à la mort
// (mémo base `deepWork`) : `descend_y54` y retourne par /home work avant tout escalier. `_workSet` (le
// drapeau historique) est un état de PROCESS remis à faux à chaque mort — c'est lui qui renvoyait le bot
// dans ~120 blocs d'escalier après chaque réapparition. ⚠️ NIVEAU MODULE (piège #56) : lu par un timer.
let _deepWork = null;          // {x,y,z,at} | null
let _deepWorkLoaded = false;
let _deepWorkTryAt = 0;        // dernière tentative de pose (throttle 1/min, deepWork.shouldRefreshDeepWork)
let _deepWorkRefusedEvAt = 0;
let _deepWorkPosing = false;   // la pose vient de deepWorkTick : le callback de bookmark ne doit pas « oublier » l'ancien

function _loadDeepWork() {
  if (_deepWorkLoaded) return _deepWork;
  _deepWorkLoaded = true;
  try { _deepWork = deepWorkLoad(loadBaseState(), Date.now()); } catch (e) { _deepWork = null; }
  return _deepWork;
}

/** Mémo FUSIONNÉ (piège #73d). null = oublié. */
function _setDeepWork(v) {
  _deepWorkLoaded = true;
  _deepWork = v || null;
  try {
    const st = Object.assign({}, loadBaseState() || {});
    st.deepWork = _deepWork;
    saveBaseState(st);
  } catch (e) { /* best-effort */ }
}

/** Le chantier profond n'est plus une destination (noyé, impasse, home supprimé/refusé, migration…). */
function _forgetDeepWork(why) {
  if (!_loadDeepWork()) return;
  _setDeepWork(null);
  try { emit({ type: 'deep_work_forgotten', why: why || null }); } catch (e) { /* best-effort */ }
}

/** Callback de homewarp.bookmark : un `/sethome work` posé AILLEURS (surface, coupe de bois…) remplace le
 *  chantier profond — le home serveur ne pointe plus dessus. */
function _onBookmarked(info) {
  try {
    if (!info || info.name !== HOME_WORK || _deepWorkPosing) return;
    const w = _loadDeepWork();
    if (!w) return;
    const here = { x: info.x, y: info.y, z: info.z };
    // Posé ailleurs (même profond : la case n'a pas passé deepSpotCheck) → oublié ; le timer re-pose sur
    // une case vérifiée dans la minute si le bot travaille sous -40.
    if (!deepWorkLanded(w, here)) {
      _setDeepWork(null);
      emit({ type: 'deep_work_forgotten', why: 'work_moved', y: Number.isFinite(info.y) ? Math.round(info.y) : null });
    }
  } catch (e) { /* best-effort */ }
}

/** Timer : pose/rafraîchit le home `work` sur une case SÛRE du chantier quand le bot travaille sous -40. */
function deepWorkTick() {
  if (IS_MAPPER || !NO_GIVE || !bot || !bot.entity || !bot.entity.position) return;
  const p = bot.entity.position;
  const now = Date.now();
  const last = _loadDeepWork();
  if (!shouldRefreshDeepWork({ pos: { x: p.x, y: p.y, z: p.z }, last, now, lastTryAt: _deepWorkTryAt })) return;
  // Jamais en plein combat, minage, abri, migration, ni blessé / dans l'eau / un hostile à 8 blocs.
  if (bot.targetDigBlock || (bot.pvp && bot.pvp.target) || _shelterInFlight || _migrating) return;
  if (bot.health == null || bot.health < 10) return;
  try { if (isInWater(bot)) return; } catch (e) { return; }
  try {
    const h = bot.nearestEntity((x) => x && x.kind === 'Hostile mobs');
    if (h && h.position && h.position.distanceTo(p) <= 8) return;
  } catch (e) { return; }
  _deepWorkTryAt = now;
  const chk = deepSpotCheck((q) => bot.blockAt(new vec3Lib.Vec3(q.x, q.y, q.z)), { x: p.x, y: p.y, z: p.z });
  if (!chk.ok) {
    if (now - _deepWorkRefusedEvAt >= 5 * 60 * 1000) { _deepWorkRefusedEvAt = now; emit({ type: 'deep_work_unsafe', why: chk.why, y: Math.round(p.y) }); }
    return;
  }
  let ok = false;
  _deepWorkPosing = true;
  try { ok = !!homewarp.bookmark(bot, HOME_WORK); } catch (e) { ok = false; } finally { _deepWorkPosing = false; }
  if (!ok) return;
  _setDeepWork({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z), at: now });
  _workSet = true; _workPos = _botXZ(); _workDrownTimes = []; _workStuckTimes = [];
  emit({ type: 'work_bookmarked', ctx: 'deep_site', x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
}

function abandonWorkIfDrowned() {
  if (!_workSet) { _workDrownTimes = []; return; }
  const r = recordWorkDrown(_workDrownTimes, Date.now());
  _workDrownTimes = r.times;
  if (!r.abandon) return;
  _workSet = false; _forgetDeepWork('drowned');
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
  _zoneWaterWin = windowAdd(_zoneWaterWin, 1, Date.now());   // ... sur la fenêtre, seule lue par le verdict
}
// LIEUX DE MORT RÉPÉTÉE (deathspots.js) — miroir de abandonWorkIfDrowned : si le chantier courant
// est proche du spot fraîchement banni (mort réelle, toute cause), on l'oublie — pour que
// returnToWork cesse d'y renvoyer le bot mourir. Le ban lui-même vit dans deathSpots
// (isBanned/nearestBanDist, cf. fleeDeathCamp + boucle de relocalisation eau) : PAS dans
// _drownedSites, qui reste spécifique à la noyade d'un chantier (mécanisme distinct, 3a).
function abandonWorkIfDeathSpot(x, z) {
  if (!_workSet || !_workPos) return;
  if (Math.hypot(_workPos.x - x, _workPos.z - z) > 32) return;
  _workSet = false; _forgetDeepWork('drowned_ban');
  emit({ type: 'work_abandoned_death_spot', x: Math.round(x), z: Math.round(z) });
}
let _drySteerTries = 0;       // NO_GIVE : marches tentées vers la cellule 128 sèche (arrivée VÉRIFIÉE, ≤3 —
                              // vécu live NethBot2 : goto interrompu par un réflexe → « arrivé » à 180 blocs
                              // de la cible avec l'ancien one-shot → descente en zone humide quand même)
// REFORGE D'ARMURE (armorWear.js, boucle d'usure 24/10) : {slot: ts} de la dernière pièce forgée par slot.
// Jamais deux fois la même pièce en 10 min. PERSISTÉ dans le mémo de base (le self-healing relance le bot
// à chaque mort : un état en mémoire repartait à zéro). Niveau MODULE (piège #56).
let _armorCraftAt = null;
function _armorCraftMap() {
  if (_armorCraftAt) return _armorCraftAt;
  _armorCraftAt = {};
  try { const m = (loadBaseState() || {}).armorCraftAt; if (m && typeof m === 'object') _armorCraftAt = Object.assign({}, m); } catch (e) {}
  return _armorCraftAt;
}
function _noteArmorCraft(slot) {
  if (!slot) return;
  const m = _armorCraftMap(); m[slot] = Date.now();
  try { const b = Object.assign({}, loadBaseState() || {}); b.armorCraftAt = m; saveBaseState(b); } catch (e) {}
}
/** Slots d'armure tels qu'ils sont RÉELLEMENT occupés (pièces usées comprises, avec le drapeau). */
function _armorOccupants() {
  const out = [];
  try {
    for (const it of (bot.inventory && bot.inventory.slots ? bot.inventory.slots.slice(5, 9) : [])) {
      if (it && it.name) out.push({ name: it.name, broken: isNearlyBroken(it) });
    }
  } catch (e) {}
  return out;
}
let _wornOutReported = new Set();
const _wornOutAt = {};               // dernier gear_worn_out émis par pièce (TTL 10 min, cf. _wornArmor)     // pièces d'ARMURE déjà signalées gear_worn_out (dédup, cf. wornOut.js)
let _offhandWornReported = new Set();  // idem pour la MAIN SECONDAIRE (bouclier usé)
let _deathMark = null;        // dernière position marquée death {x,y,z,at} → dédup anti-spam du watchdog
let _imminentBusy = false;    // anti-rafale : un seul warp de sauvetage PV à la fois
let _homeRefusedAt = {};      // RC3 : refus TP Essentials par home {safe|chantier|death → ts} — un /home
                              // refusé (« destination unsafe », monde noyé) ne téléporte PAS : sans ça
                              // le filet de secours était un no-op silencieux (zombie 1.8 PV, vécu NethBot2)
// HOME INEXISTANT côté serveur (20/10, NethBot1 sessions 309-313) : le mémo de base disait « base
// installée » (base_adopted → _safeHomeSet = true) alors que le serveur répondait « Player has not set a
// home. » à chaque /home safe. Le bot croyait avoir un filet de secours qui n'existait pas, restait emmuré
// et bouclait jam_loop → exit → respawn au même endroit. On le NOTE (process + mémo de base, relu à
// l'adoption de la base) ; le watchdog NO_GIVE re-pose `safe` à la première surface sèche (même voie que
// le safe refusé) et l'escalier (digOutAndResume) sort le bot quand aucun home ne le peut.
let _homeMissingAt = {};      // { nom → ts } du dernier « has not set a home » attribué
let _homeMissingEvAt = {};    // throttle de l'event home_missing (1/min/nom)
const HOME_MISSING_EVENT_EVERY_MS = 60000;
const SAFE_MISSING_MEMO_KEY = 'safeHomeMissingAt';
function noteHomeMissing(name) {
  const now = Date.now();
  _homeMissingAt[name] = now;
  if (name === HOME_SAFE) {
    _safeHomeSet = false;           // le re-pose du watchdog (surface sèche) se déclenche sur !_safeHomeSet
    _safeHomeSurface = false;
    _homeRefusedAt.safe = now;      // les secours cessent de compter dessus (safeWarpDown)
    try { saveBaseState(Object.assign({}, loadBaseState() || {}, { [SAFE_MISSING_MEMO_KEY]: now })); } catch (e) { /* best-effort */ }
  }
  if (name === HOME_WORK) { _workSet = false; _forgetDeepWork('home_missing'); }
  if (now - (_homeMissingEvAt[name] || 0) >= HOME_MISSING_EVENT_EVERY_MS) {
    _homeMissingEvAt[name] = now;
    emit({ type: 'home_missing', name });
  }
}
/** Le serveur a-t-il dit que `safe` n'existe pas (et il n'a pas été re-posé depuis) ? */
function safeHomeKnownMissing() {
  return !!_homeMissingAt[HOME_SAFE];
}
// Le /home safe est-il inutilisable en ce moment (refus récent, pas encore re-posé) ?
function safeWarpDown() {
  return !!(_homeRefusedAt.safe && (Date.now() - _homeRefusedAt.safe) <= homewarp.REFUSAL_DEGRADE_MS);
}
let _safeNoopStreak = 0;      // /home safe SILENCIEUX consécutifs depuis sous terre (signet cassé vs
const SAFE_NOOP_MAX = 3;      // warmup teleport-delay ponctuel) — au 3e, on invalide safe (piège world_mn11)
let _tpCancelledAt = 0;       // secure-then-warp : dernière annulation Essentials vue (teleport-delay)
let _confineDyn = null;       // confine AUTO-ancré (brique 2) : posé à la 1re terre sèche stable
let _anchorSet = false;      // home 'ancre' posé à l'ancre → l'enforcement /home peut tirer
let _lastConfineEnforceAt = 0;// cooldown enforcement (2 min, cf. shouldEnforceConfine)
let _campEstablished = false; // brique 3 : four (+coffre) posés à l'ancre = camp de base
let presence = null;          // heartbeat de présence du groupe (positions-<group>.json, --positions)
let _lastMapperTpAt = 0;      // TP-au-mappeur : cooldown (1 tentative / 4 min)
let _dzones = [];             // camps de mort : zones où ≥2 alertes « mort imminente » (deathzones.js)
let _safeHomePos = null;      // coords du dernier /sethome safe (pour fuir VERS lui si hors zone bannie)
// HOME `safe` CAMPÉ (live 19/10, cf. homeSafety.js) — gardes de NIVEAU MODULE (piège #56) : le veto est
// lu par homewarp.goHome depuis n'importe quel timer, la re-pose tourne dans un setInterval, le handler
// `death` écrit les positions. Déclarées dans onSpawn, elles lèveraient une ReferenceError en prod.
let _deathPos = [];           // morts récentes {x,y,z,at} — miroir du champ `deathPos` du mémo de base
let _deathPosLoaded = false;  // relues du mémo UNE fois par process (les morts des process précédents comptent)
let _hostileNearHomeAt = 0;   // dernier hostile vu à ≤ 24 blocs du home safe (remis à 0 quand le home bouge)
let _homeCampedEventAt = 0;   // throttle de `home_safe_camped` (1×/min)
let _safeHomeMovedAt = 0;     // dernière re-pose du home pour cause de camp (cooldown 5 min)
let _posSamples = [];         // desync-watchdog : échantillons de position (30 s × 10 = 5 min)
let _stillBusy = false;       // immobilité LÉGITIME en cours (fonte au four, abri nocturne) — gate desync
let _smeltOppBusy = false;    // fonte opportuniste : une seule passe à la fois
let panicInFlight = false;    // garde de ré-entrée onPanic. DOIT rester au niveau module : les gates
                              // survie (l. ~3713/3792/3811) la lisent HORS de onSpawn — déclarée en
                              // `let` dans onSpawn elle levait un ReferenceError qui TUAIT le process
                              // au 1er tick du timer (vécu : les 3 workers morts en boucle, run Minestrator)

// DIAG « GoalChanged » (live : les trajets explore / migration de zone échouent en < 1 s avec « The goal
// was changed before it could be completed! ») — QUI pose un but pendant qu'un goto tourne ? On enveloppe
// bot.pathfinder.setGoal (goalTrace.js, posé dans onSpawn) et on vide les compteurs toutes les 60 s dans
// un event `goal_trace` { windowS, top:[{ by, calls, interrupted }] } : la tête de liste avec un
// `interrupted` élevé est le coupable. Pur diagnostic : aucun effet sur le comportement du bot.
// ATTENTION : NIVEAU MODULE, comme panicInFlight ci-dessus — le timer lit `_goalTrace` HORS de onSpawn ;
// déclarée dans onSpawn, elle lèverait une ReferenceError au 1er tick (le smoke test ne le voit pas).
const _goalTrace = createGoalTrace({});
let _goalTraceInstalled = false;   // le wrapper ne se pose qu'UNE fois par process (cf. onSpawn)
let _goalHoldInstalled = false;    // idem pour le verrou de but (fuite creeper, goalHold.js)
// FUITE DE MOVEMENTS (19/10, cf. pluginMoves.js) : collect/pvp posent leur Movements d'usine et ne
// rendent jamais la nôtre. Le gardien se pose UNE fois par process (envelopper deux fois collect, ou
// écouter deux fois stoppedAttacking, doublerait les restaurations). NIVEAU MODULE, comme ses sœurs.
let _pluginMovesInstalled = false;
let _movesKeeper = null;
// BUTIN APRÈS COMBAT (19/10, cf. food.shouldLootAfterCombat) : état lu et écrit par des écouteurs
// d'events, donc HORS de onSpawn → NIVEAU MODULE comme ses sœurs (piège #56 : un `let` posé dans
// onSpawn compile, passe les tests, et lève une ReferenceError au premier event). Les écouteurs ne se
// posent qu'UNE fois par process (deux `stoppedAttacking` écoutés = deux ramassages concurrents).
let _combatLootWired = false;
let _combatLootBusy = false;      // un seul ramassage post-combat à la fois
let _combatTarget = null;         // {name,kind,type} de la cible du combat en cours (relevé à startedAttacking)
let _foodDropSweepWired = false;  // timer posé une fois par process (cf. wireFoodDropSweep)
let _foodDropSweepAt = 0;         // balayage des drops comestibles (25/10) : dernier passage, au plus 1 / 4 s
// DISJONCTEUR DE COMBAT (22/10, fightBreaker.js) : état lu par l'event `health`, le wrapper de
// `bot.pvp.attack` et les ticks de survie → NIVEAU MODULE (piège #56). Posé une fois par process.
const _fightBreaker = createFightBreaker();
let _fightBreakerWired = false;
let _fightRefusedAt = -Infinity;  // event `fight_refused` : au plus 1 / 3 s
let _fightRefuseFleeAt = -Infinity; // fuite sur refus : au plus 1 / 1,5 s (anti-thrash du but de fuite)
// ── OOM DU BRANCH-MINE (23/10, heapGuard.js) ─────────────────────────────────────────────────────
// ≈85 sessions mortes « JavaScript heap out of memory » : heap 150 → 620 Mo en 10-25 s, AUCUN event,
// pendant une approche du serpentin, et la relance re-crashe AU MÊME ENDROIT. NIVEAU MODULE (piège #56) :
// l'échantillonneur et le wrapper `branchMine` (plus bas) lisent ces variables hors de onSpawn.
let _bmPhase = null;              // phase courante du branch-mine (posée par onPhase), null hors branchMine
let _bmMarkWriteAt = null;        // dernière écriture de la marque de position (throttle 3 s)
let _bmCrashChecked = false;      // contrôle « crash au même endroit » : une fois par process
let _bmCrashHits = 0;             // crashs consécutifs au même endroit (repris de la marque)
let _heapHighAt = null;           // dernier event heap_high (throttle 5 s)
let _toolGuardSaid = false;       // garde mineflayer-tool posée (toolGuard.js), une fois par process
setInterval(() => {
  try {
    const mu = process.memoryUsage();
    const heapUsedMb = Math.round(mu.heapUsed / 1048576);
    const now = Date.now();
    if (!heapGuard.shouldEmitHeapHigh(heapUsedMb, _heapHighAt, now)) return;
    _heapHighAt = now;
    let pfGoal = null; let moving = null; let mining = null; let ticks = null; let pos = null;
    try {
      pfGoal = heapGuard.goalLabel(bot.pathfinder && bot.pathfinder.goal);
      moving = !!(bot.pathfinder && bot.pathfinder.isMoving && bot.pathfinder.isMoving());
      mining = !!(bot.pathfinder && bot.pathfinder.isMining && bot.pathfinder.isMining());
      ticks = bot.listenerCount ? bot.listenerCount('physicsTick') : null;
      const p = bot.entity && bot.entity.position;
      if (p) pos = { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) };
    } catch (e) { /* bot pas encore créé (TDZ) : on émet quand même le heap */ }
    let bmPh = null;
    try { const ph = bmCurrentPhase(); bmPh = ph && ph.name !== 'idle' ? Object.assign({ ageMs: now - ph.at }, ph) : null; } catch (e) {}
    emit({ type: 'heap_high', heapUsedMb, heapTotalMb: Math.round(mu.heapTotal / 1048576),
      rssMb: Math.round(mu.rss / 1048576), externalMb: Math.round(mu.external / 1048576),
      goal: (_curGoal && _curGoal.name) || null, pfGoal, moving, mining, physicsTickListeners: ticks,
      phase: _bmPhase, bm: bmPh, pos });
  } catch (e) { /* diagnostic : ne crash jamais */ }
}, 2000);

// GELS DE L'EVENT LOOP (23/10, cf. loopGuard.js). NIVEAU MODULE (piège #56) : lu par des timers.
// `_capReport` : rapport différé `sync_loop_capped {where, count}` des boucles coupées par une garde.
// `loop_lag {ms, phase}` : retard du tick d'1 s au-delà de 2 s — chiffre chaque gel qui rend la main
// (une boucle infinie, elle, finit en OOM sans que ce timer puisse parler : c'est la garde qui la coupe).
const _capReport = loopGuard.createCapReporter({ emit });
const _loopLag = loopGuard.createLoopLagWatch({
  onLag: (e) => emit(Object.assign({ type: 'loop_lag' }, e)),
  phase: () => {
    let goal = null;
    try { goal = (_curGoal && _curGoal.name) || null; } catch (e) { goal = null; }
    return _bmPhase ? `bm:${_bmPhase}` : goal;
  },
});
setInterval(() => { _loopLag.tick(); }, loopGuard.LAG_INTERVAL_MS);

setInterval(() => {
  try {
    const d = _goalTrace.drain();
    if (d.top.length) emit({ type: 'goal_trace', ...d });
  } catch (e) { /* diagnostic : ne crash jamais */ }
}, _goalTrace.windowMs);

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
  // MIGRATION EN COURS (live 23/10, NethBot1 session 397) : la fuite prenait la main
  // (`taskCtl.begin('death_camp_flee')`) et tuait la migration 658 ms après son départ
  // (`zone_migration_failed cancelled:true legs:1`) — pour partir 90 blocs au HASARD alors que la
  // migration quittait déjà la zone. Elle EST la fuite : on la laisse marcher (et surtout pas de
  // /home safe qui ramènerait le marcheur en arrière), sauf si sa cible tombe dans le camp banni.
  {
    const t = _migrationTarget;
    let targetBanned = false;
    try {
      targetBanned = !!(t && Number.isFinite(t.x) && (deathzones.isBanned(_dzones, t.x, t.z, now) || deathSpots.isBanned(t.x, t.z)));
    } catch (e) { targetBanned = false; }
    if (deathCampDefersToMigration({ activeTask: taskCtl.active, targetBanned })) {
      emit({ type: 'death_camp_flee', via: 'migration', toX: t ? t.x : null, toZ: t ? t.z : null });
      return;
    }
  }
  // HOME CAMPÉ (19/10) : fuir un camp VERS un autre camp n'est pas une fuite → à pied, comme sans home.
  if (_safeHomePos && !deathzones.isBanned(_dzones, _safeHomePos.x, _safeHomePos.z, now)
      && !deathSpots.isBanned(_safeHomePos.x, _safeHomePos.z) && !safeHomeVeto('death_camp_flee')) {
    emit({ type: 'death_camp_flee', via: 'home_safe' });
    await safeWarpHome('safe', { ctx: 'death_camp_flee' });
    return;
  }
  // SQUELETTE EN VUE (22/10 : `death_camp_flee via:foot` à 1,5 PV puis « shot by Skeleton ») : 90 blocs
  // à pied dans son champ de tir, c'est la mort. On casse la ligne de vue / on le tue d'abord ; le camp
  // reste banni, la fuite repartira au prochain passage du watchdog si besoin.
  try {
    const sit = skeletonSituation(null);
    if (sit && sit.los) {
      const dec = skeletonRespond(sit.shooter, 'death_camp');
      if (dec && dec.action !== 'flee') { emit({ type: 'death_camp_flee', via: 'skeleton', action: dec.action }); return; }
    }
  } catch (e) { emit({ type: 'skeleton_response_error', err: String((e && e.message) || e).slice(0, 160) }); }
  const ang = Math.random() * Math.PI * 2;
  const tx = Math.round(fromPos.x + Math.cos(ang) * 90);
  const tz = Math.round(fromPos.z + Math.sin(ang) * 90);
  emit({ type: 'death_camp_flee', via: 'foot', x: tx, z: tz });
  // Mesure live (MapBot1, 22/10) : ce watchdog est fire-and-forget (appelé sans await depuis le
  // timer 1 s, `.catch(()=>{})`) — sans s'annoncer, la coupure du mouvement suivie d'une nouvelle
  // destination pathfinder arrivait en plein vol du `gather(explore:true)` du kit (bois), qui
  // subissait le reset du pathfinder SANS voir `token.cancelled` → rafales de `goal_failed logs
  // not_found` en ~30 ms au lieu d'un échec propre.
  // Même remède qu'`escapeDeathCamp` : on annule la tâche en cours ET on s'annonce busy (même
  // famille que `_exploreBusy`/`_foodTripBusy`, lue par les gardes confine/squad) AVANT de bouger.
  // RELANCE DU PLANNER (live 22/10, NethBot1 session 152) : un simple `taskCtl.cancel()` laissait le
  // planner MORT jusqu'au watchdog (6 min) — et la nuit, chaque abri dérivait de ce jeton mort. La fuite
  // prend donc la main avec SON jeton (patron migrateZone/dig_out) et rallume le planner en partant,
  // qu'elle ait abouti ou non — sauf si quelqu'un l'a préemptée entre-temps (ordre joueur, migration,
  // mort → onSpawn), ou si ce qu'elle a coupé n'était pas le planner (ordre joueur, stop/afk).
  const prevTask = taskCtl.active;
  let tok = null;
  try { tok = taskCtl.begin('death_camp_flee', stopMotion); } catch (e) { tok = null; }
  try { stopMotion(); } catch (e) {}
  _escaping = true;
  try {
    // But XZ : l'altitude à 90 blocs est INCONNUE. L'ancien GoalNear(tx, y_du_camp, tz, 4) était une
    // sphère 3D inatteignable sur relief → NoPath instantané, `withTimeout` l'avale en silence et le bot
    // restait dans le camp qu'il était censé fuir (même cause qu'explore, la migration et fleeFrom ;
    // la fuite « walk » de death_camp_escape vise déjà GoalNearXZ).
    await withTimeout(bot.pathfinder.goto(new pfGoals.GoalNearXZ(tx, tz, 4)),
      90000, () => { try { stopMotion(); } catch (e) {} });
  } catch (e) { /* best-effort */ }
  finally { _escaping = false; }
  await restartPlannerAfterFlee(tok, prevTask);
}

/** Fin de fleeDeathCamp (22/10) : attendre (borné) que l'ancien planner ait rendu la main, puis le
 *  rallumer — seulement si la fuite a coupé le PLANNER et que personne ne l'a préemptée depuis. */
async function restartPlannerAfterFlee(tok, prevTask, evType = 'death_camp_flee_done') {
  // Une MIGRATION coupée par la fuite (cible dans le camp) est une tâche du planner : on rallume le
  // planner, et la reprise de migration (maybeResumeMigration) repart de lui. Sans ça, plus rien
  // n'avait la main après la fuite (`prevTask` 'migration' ≠ 'autonomous').
  // Une charge sur squelette qui DEVAIT relancer le planner a été préemptée par nous : la dette passe ici.
  const owedByRush = prevTask === 'skeleton_rush' && _skelRushOwesPlanner;
  if (!tok || (prevTask !== 'autonomous' && prevTask !== 'migration' && !owedByRush)) return false;
  const w0 = Date.now();
  const migUnwinding = () => prevTask === 'migration' && _migrating;   // la migration coupée finit de se dérouler
  while ((_skillInFlight > 0 || _autoRunners > 0 || migUnwinding()) && !tok.cancelled && Date.now() - w0 < MIGRATION_PREEMPT_WAIT_MS) {
    await sleep(250);
  }
  if (tok.cancelled || _migrating || _ljSwitching) {     // un autre maître a la main
    // Branche autrefois MUETTE (24/10) : qui a repris la main, et la dette est-elle transmise ?
    emit({ type: 'planner_restart_skipped', ev: evType, why: tok.cancelled ? 'preempted' : (_migrating ? 'migrating' : 'lj_switching'),
      by: taskCtl.active || null, owes: _skelRushOwesPlanner, waited_ms: Date.now() - w0 });
    return false;
  }
  if (!(world.objective && world.objective.status === 'in_progress')) return false;
  if (owedByRush) _skelRushOwesPlanner = false;
  emit({ type: evType, restart: true, waited_ms: Date.now() - w0 });
  try {
    startAutonomous(null).catch((e) => emit({ type: 'error', message: String((e && e.message) || e) }));
  } catch (e) { /* best-effort */ }
  return true;
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

// AVEC LA SQUAD (22/10, NethBot1/3 : bases à ~360 blocs, /tpa de squad puis rappel confine 45 s plus tard,
// 7 rappels et 23 téléportations > 100 blocs en 70 min) : un coéquipier ouvrier à côté = le bot travaille
// avec le groupe, on ne le ramène pas chez lui. Niveau module (lu par le timer d'enforcement, piège #56).
let _lastConfineSquadHoldAt = 0;
function confineWithSquad() {
  if (!presence) return false;
  const p = bot.entity && bot.entity.position;
  if (!p) return false;
  try {
    return mateNearby({ self: { x: p.x, z: p.z }, selfName: bot.username, mates: presence.list(), now: Date.now() });
  } catch (e) { return false; }
}

// ENFORCEMENT confine no-give (brique 1) : le bot a dérivé hors de sa poche (> rayon ×1.25) →
// /home ancre (commande joueur, secure-then-warp inclus). C'est CE retour qui casse le pattern
// mortel « atteint iron_deep → explore loin → eau → churn » (vécu world_ax2 toute la nuit).
setInterval(() => {
  try {
    const conf = CONFINE || _confineDyn;
    // Cartographes : jamais confinés (leur travail est d'aller LOIN) — depuis qu'ils tournent en NO_GIVE
    // (19/10), l'auto-ancrage leur posait un confine de 140 blocs et ce rappel les ramenait à la base.
    if (!conf || !_anchorSet || !NO_GIVE || IS_MAPPER) return;
    if (!(world.objective && world.objective.status === 'in_progress')) return;
    const p = bot.entity && bot.entity.position;
    if (!p) return;
    // DIAMANT (25/10) : un mineur dans la bande des diamants (y ≤ -16) ou en armure diamant complète n'est
    // plus rappelé — NethBot3 minait un filon à 330 blocs, /home safe l'a remonté en surface, puis
    // night_go_deep l'a renvoyé au fond : aller-retour perdu à chaque passage.
    if (p.y <= -16 || diamondFreeNow()) return;
    if (!_campEstablished) tryEstablishCamp().catch(() => {});    // retry léger du camp
    // `_migrating` DOIT compter comme occupé : sinon l'enforcement yank le marcheur vers l'ancre
    // qu'on est précisément en train de quitter (même classe que les autres gardes busy).
    // `_escaping` idem : ramener le bot à l'ancre pendant une fuite anti-camping le remettrait
    // sous le nez du campeur (le spawnpoint campé est presque toujours près de la base).
    // `_foodTripBusy` idem : l'expédition vers le gibier s'éloigne de l'ancre PAR CONCEPTION (jusqu'à
    // 160 blocs) ; l'enforcement la ramènerait en /home au milieu de la marche ou de la chasse.
    // `_nightHold` idem (discipline de nuit, 19/10 soir) : un /home de rappel arracherait le bot nu à
    // l'abri qu'il est en train de reprendre — la nuit, c'est la discipline qui possède le bot.
    const busy = !!bot.targetDigBlock || _stillBusy || _imminentBusy || _smeltOppBusy || _armorBusy || _nightHold || _migrating || _escaping || _foodTripBusy || _exploreBusy || _skelRushBusy || _huntCookBusy > 0;
    // `_confineGraceUntil` (fix run10) : un trek lointain arrivé noyé/sous terre n'a pas posé sa base ;
    // le rappeler à l'ancre le renverrait dans la zone morte qu'il vient de quitter (18 cas mesurés).
    const graceHold = Date.now() < _confineGraceUntil;
    const dist = Math.hypot(p.x - conf.x, p.z - conf.z);
    const withSquad = confineWithSquad();
    if (withSquad && shouldEnforceConfine({ dist, radius: conf.radius, busy: busy || graceHold, now: Date.now(), lastAt: _lastConfineEnforceAt })
      && Date.now() - _lastConfineSquadHoldAt > 5 * 60000) {
      _lastConfineSquadHoldAt = Date.now();
      emit({ type: 'confine_squad_hold', dist: Math.round(dist), x: conf.x, z: conf.z });
    }
    if (shouldEnforceConfine({ dist, radius: conf.radius, busy: busy || graceHold, now: Date.now(), lastAt: _lastConfineEnforceAt, withSquad })) {
      _lastConfineEnforceAt = Date.now();
      emit({ type: 'confine_enforce', dist: Math.round(dist), x: conf.x, z: conf.z });
      safeWarpHome(CONFINE_HOME, { ctx: 'confine_enforce' }).catch(() => {});
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

// HOME `safe` CAMPÉ (live 19/10) : toutes les 5 s, note les hostiles vus près du home et, de jour, au
// calme, en surface, loin du camp, RE-POSE le home ici (1×/5 min max — cf. maybeMoveCampedSafeHome).
setInterval(() => {
  try { maybeMoveCampedSafeHome(); } catch (e) { /* watchdog : ne crash jamais */ }
}, 5000);

// TP-AU-MAPPEUR : demande /tpa vers le mappeur choisi par pickMapperTp (frais, qui rapproche de
// la cible d'au moins 150 blocs — ou le plus loin de moi sans cible). L'acceptation est automatique
// côté mappeur (policy.group_bots) ; l'atterrissage est détecté par awaitWarp (warmup couvert).
// Échec (pas de candidat, /tpa non coché, refus, timeout) = on continue À PIED, jamais bloquant.
async function tryTpToMapper(goal) {
  if (!presence) return { ok: false, reason: 'no_presence' };
  // DISCIPLINE DE NUIT (19/10 soir) : nu de nuit, pas de /tpa vers un cartographe — il est DEHORS, lui
  // (même règle que le squad, regroupCaution). Le cooldown n'est pas consommé : le raccourci reste
  // disponible au premier long trajet du matin.
  if (nightLockdownNow()) { nightGateNote('tpa_mapper'); return { ok: false, reason: 'night_lockdown' }; }
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

// PRUDENCE NOCTURNE DU REGROUPEMENT (18/08) — même mécanisme que mapperNightGuard (startMapper),
// appliqué à tryRegroup/trySquad. Flagrant délit world_mn15 ~02:30 : 6 morts en 2 min AU MÊME
// POINT — chaque mort → respawn → /tpa immédiat vers le groupe → bot téléporté NU, DE NUIT, dans
// le camp qui vient de le tuer (les hostiles y ont convergé) → re-mort → re-tpa. Le regroupement
// (pensé pour la logistique de jour) court-circuitait l'abri-si-nu. Décision pure :
// caution.regroupCaution (même seuil que mapperCaution : < 2 pièces portées + nuit → abri).
// Renvoie true si le bot doit se terrer (donc NE PAS /tpa) ; false si le regroupement peut suivre
// son cours normal — comportement d'avant cette fonction, intact (jour ou 2+ pièces portées).
async function regroupNightGuard() {
  let worn = 0;
  try { worn = _wornArmor().size; } catch (e) { /* inventaire pas encore livré → 0 = prudent */ }
  // `bot.time` peut manquer juste après un spawn/une reconnexion — exactement le moment où le bot
  // est nu : on passe alors `null` (inconnu) et regroupCaution retombe honnêtement sur les
  // hostiles, au lieu de conclure « il fait jour » (même garde que mapperNightGuard).
  const nightKnown = !!(bot && bot.time && bot.time.timeOfDay != null);
  let hostilesNear = false;
  try {
    const h = bot.nearestEntity((x) => x && x.kind === 'Hostile mobs');
    hostilesNear = !!(h && bot.entity && h.position.distanceTo(bot.entity.position) <= 8);
  } catch (e) { /* best-effort */ }
  const decision = regroupCaution({ worn, isNight: nightKnown ? isNight(bot) : null, hostilesNear });
  if (decision !== 'shelter') {
    bot._regroupCautionEpisode = false;   // aube OU 2+ pièces portées → l'épisode est clos
    return false;
  }
  if (!bot._regroupCautionEpisode) { bot._regroupCautionEpisode = true; emit({ type: 'regroup_caution', worn }); }
  // DANS L'EAU on ne force rien : pas de trou creusé en plein océan, le sauvetage d'eau garde la
  // main (même garde que mapperNightGuard).
  let inWater = false;
  try { inWater = isInWater(bot); } catch (e) { /* best-effort */ }
  try { await maybeNightShelter(true, inWater ? {} : { force: true }); } catch (e) { /* best-effort */ }
  return true;
}

// REGROUPEMENT APRÈS MORT (--regroup, OFF par défaut). Avec keepInventory, mourir ne coûte
// presque rien : ce qui tue une 2e fois, c'est le RETOUR à pied (200-400 blocs sous les mobs).
// Un /tpa vers le coéquipier le plus proche supprime ce trajet — 100 % « vrai joueur », et /tpa
// passe le filtre sans-give (≠ /tp<espace>). S'éteint tout seul dès que l'armure fer est portée
// (règle Massii : le groupe ne sert que jusque-là). Décision pure : regroup.pickRegroupTarget.
let _lastRegroupAt = 0;
async function tryRegroup(opts = {}) {
  if (!REGROUP) return { ok: false, reason: 'disabled' };
  if (isLumberjackObjective()) return { ok: false, reason: 'lumberjack' };   // il vit en surface par métier
  if (!presence) return { ok: false, reason: 'no_presence' };
  const p = bot.entity && bot.entity.position;
  if (!p) return { ok: false, reason: 'no_pos' };
  // APPEL PÉRIODIQUE (timer d'équipe, 90 s) : mêmes gardes que trySquad (22/10, chrono world_oct22).
  // Ce /tpa était le SEUL sans garde « tâche longue » : NethBot2 arraché en plein trajet vers une grappe
  // de fer (`regroup_tpa` 191 blocs → `cave_failed unreachable`), NethBot3 arraché 3× en pleine
  // migration (`regroup_tpa` 140/254/474 → migration annulée après 25 jambes). Un `unreachable` causé
  // par un TP compte dans le disjoncteur des grottes, qui finissait par couper `iron_cave` 2 h.
  // Le regroupement APRÈS MORT (handler spawn) garde son comportement : c'est lui qui évite la marche.
  // Trajet de grotte en cours (y compris juste après une mort, quand le planner a relancé la grotte avant
  // le regroupement d'après-mort) : jamais de /tpa — mesuré 22/10, NethBot1 téléporté à 593 blocs en
  // plein escalier (`cave_stair_done y:15 dropped:45` : ce n'était pas l'escalier qui descendait trop).
  if (_caveTripBusy || _skelRushBusy) return { ok: false, reason: 'busy' };
  if (opts && opts.periodic) {
    const longTask = _stillBusy || _imminentBusy || _smeltOppBusy || _armorBusy || _migrating || !!bot.targetDigBlock
      || _escaping || _foodTripBusy || _exploreBusy || _caveTripBusy || _craftDepth > 0 || _huntCookBusy > 0;
    if (longTask || isMiningGoal(_curGoal)) return { ok: false, reason: 'busy' };
  }
  if (await regroupNightGuard()) return { ok: false, reason: 'night_shelter' };
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
// But du planner EN COURS ({name, skill, at}) — lu par trySquad (timer) : NIVEAU MODULE (piège #56).
// Posé/retiré par runSkillWithTelemetry autour de l'exécution réelle du skill.
let _curGoal = null;
let _squadSkipWhy = null;     // dernière raison `squad_skip` tracée (dédup au changement, anti-spam 20 s)
let _squadSkipAt = 0;
function noteSquadSkip(why, to) {
  const t = Date.now();
  if (why === _squadSkipWhy && t - _squadSkipAt < 5 * 60000) return;
  _squadSkipWhy = why; _squadSkipAt = t;
  emit({ type: 'squad_skip', why, to: to || null, goal: (_curGoal && _curGoal.name) || null,
    y: (bot.entity && bot.entity.position) ? Math.round(bot.entity.position.y) : null });
}
async function trySquad() {
  if (!REGROUP || !presence) return { ok: false, reason: 'disabled' };
  if (isLumberjackObjective()) return { ok: false, reason: 'lumberjack' };   // jamais tiré au fond de la mine
  const p = bot.entity && bot.entity.position;
  if (!p) return { ok: false, reason: 'no_pos' };
  if (await regroupNightGuard()) return { ok: false, reason: 'night_shelter' };
  let armorComplete = false;
  try { armorComplete = armorNeed({ inv: buildCtxInv(bot), worn: [..._wornArmor()] }, 3) === 0; } catch (e) {}
  // Minage/tâche longue en cours → on ne yanke pas (piège #42c). Même jeu de gardes que
  // l'enforcement confine (bot.targetDigBlock + immobilités légitimes) : le squad était le SEUL
  // mécanisme de tp sans ce garde-fou → il rejetait les branchMine des workers toutes les ~30 s.
  // ⚠️ `_migrating` EN FAIT PARTIE (mesure 04:12 : 5 migrations, 0 aboutie, toutes en
  // `no_progress` avec spread=200). Je l'avais ajouté à l'enforcement confine et OUBLIÉ ici : le
  // /tpa de regroupement arrachait le bot en pleine marche de migration et le ramenait au chef,
  // donc le compteur de progrès repartait de zéro et le déménagement ne pouvait jamais aboutir.
  // Exactement la même classe que le yank du confine — un TP qui ignore une tâche longue.
  // `_escaping` (fuite anti-camping) est de la même famille : le /tpa arracherait le bot en pleine
  // évasion et le ré-ancrage post-fuite jugerait une zone qu'il n'a jamais atteinte.
  // `_foodTripBusy` aussi : le bot est parti À PIED chercher du gibier loin de la squad, le /tpa le
  // ramènerait au chef au milieu de la marche (ou de la chasse sur place) sans qu'il ait mangé.
  // `_craftDepth` (fix 20/10) : un /tpa tiré pendant un craft à la table laissait la table à 100 blocs
  // (`squad_join` → `table_abandoned` → `t1_sword craft_failed`, NethBot2 session 278).
  const busy = !!bot.targetDigBlock || _stillBusy || _imminentBusy || _smeltOppBusy || _armorBusy || _migrating || _escaping || _foodTripBusy || _exploreBusy || _caveTripBusy || _craftDepth > 0 || _skelRushBusy || _huntCookBusy > 0;
  const pick = squadTarget({
    // `y`/`ironZone` de SOI : sans eux un mineur productif se croirait « rien du tout » et
    // remonterait rejoindre un flâneur resté en surface — l'inverse exact du but.
    self: { x: p.x, z: p.z, y: Math.round(p.y), ironZone: _zoneIronMined },
    selfName: bot.username, mates: presence.list(),
    armorComplete, busy, now: Date.now(), lastAt: _lastSquadAt,
    // Mineur au fond / but de minage-descente-fonte → jamais arraché (regroup.squadHold, 21/10).
    goal: _curGoal, onSkip: noteSquadSkip,
  });
  if (!pick) return { ok: false, reason: 'no_need' };
  _squadSkipWhy = null;
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

// ── DÉFENSE MUTUELLE : voler au secours d'un coéquipier attaqué ─────────────────────────────────
// Massii 25/07 : « il faut aussi qu'ils s'aident contre les mobs ». La présence partagée
// (heartbeat 60 s) est inutilisable ici — un combat dure quelques secondes. On lit donc la
// perception LOCALE : les coéquipiers visibles (bot.players) et les hostiles autour.
// Tick court (4 s, posé dans onSpawn) mais 100 % local : aucun findBlocks, coût négligeable.
// DISCIPLINE DE NUIT (19/10 soir, NethBot3 : team_assist:spider ×3 > team_assist:creeper > … mort) :
// nu de nuit, on ne rejoint PAS la bagarre d'un coéquipier — chacun se défend avec ses réflexes, et un
// bot nu parti au secours fait deux morts au lieu d'une. Le choix (pickMobAssist) est quand même
// calculé : `night_gate` ne dit « retenu » que s'il y avait réellement quelqu'un à secourir.
// Gardes de NIVEAU MODULE (piège #56) : la fonction est appelée par le timer, et testée par extraction.
let _assistBusy = false;
let _lastAssistAt = 0;
function teamAssistTick() {
  if (_assistBusy || _stillBusy || _imminentBusy) return null;
  if (!bot.entity || !presence) return null;
  // Mes propres réflexes gèrent MES agresseurs : ici on ne parle que de secourir l'autre.
  if (bot.health != null && bot.health <= DEFENSIVE_HEALTH) return null;
  if (Date.now() - _lastAssistAt < 8000) return null;              // anti-spam de ciblage
  try {
    const p = bot.entity.position;
    // Coéquipiers VISIBLES (le roster du groupe, croisé avec ce que je vois réellement).
    const roster = presence.list().filter((m) => m.role !== 'mapper' && m.name !== bot.username);
    const mates = [];
    for (const m of roster) {
      const e = bot.players[m.name] && bot.players[m.name].entity;
      if (e && e.position) mates.push({ name: m.name, x: e.position.x, z: e.position.z });
    }
    if (!mates.length) return null;
    // Jamais un creeper : l'assister = le frapper au corps-à-corps (explosion). AltoClef 20/10.
    const hostiles = nearbyHostiles(bot, 32).filter((h) => h && h.name !== 'creeper').map((h) => ({
      name: h.name, x: h.position.x, z: h.position.z, _e: h,
    }));
    const pick = pickMobAssist({
      self: { x: p.x, z: p.z, health: bot.health },
      mates, hostiles, isFleeOnly: (n) => isFleeOnlyMob(n, bot.health),
    });
    if (!pick) return null;
    // Sous terre la nuit ne change rien (Massii 24/10) : on secourt le coéquipier comme de jour.
    if (nightLockdownNow() && !nightUndergroundNow()) { nightGateNote('team_assist', { mob: pick.mob.name, mate: pick.mate }); return null; }
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
    return pick;
  } catch (e) { _assistBusy = false; return null; }
}

// Warp de secours COMPLET (secure-then-warp, Massii 15/07) : se mettre en sécurité (pilier / se
// murer / flotter) AVANT le /home — sur les serveurs à teleport-delay, le TP est annulé si on
// bouge/prend un coup pendant le warmup ~5 s, et nos secours partent précisément sous les coups.
// Best-effort intégral : un échec de mise en sécurité n'empêche jamais le warp ; 1 retry si annulé.
// HOME `safe` CAMPÉ (live 19/10) : le veto passe AVANT la mise en sécurité — se murer 6 s pour un
// /home qui ne partira pas, c'est 6 s de plus sous les coups. On rend l'échec habituel (warped:false,
// + camped/why) : chaque appelant a déjà son repli (nager, creuser sur place, s'abriter où il est).
// `opts.ctx` = qui demande (tracé dans `home_safe_camped`).
async function safeWarpHome(name, opts = {}) {
  if (homewarp.sanitizeName(name) === HOME_SAFE) {
    const veto = safeHomeVeto(opts.ctx || 'safe_warp');
    if (veto) return { warped: false, cancelled: false, camped: true, why: veto.why };
  }
  const goOpts = { ctx: opts.ctx || 'safe_warp' };
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
  // goHome re-consulte le veto (la nuit a pu tomber pendant la mise en sécurité) : un /home NON ENVOYÉ
  // ne s'attend pas (9 s pour rien) et ne compte pas comme un /home muet — ce n'est pas un signet cassé.
  const NOT_SENT = { warped: false, cancelled: false, notSent: true };
  let r = homewarp.goHome(bot, name, goOpts) ? await awaitWarp(opts) : NOT_SENT;
  if (!r.warped && r.cancelled) {       // annulé (coup reçu/mouvement) → re-sécuriser + 1 retry
    emit({ type: 'safe_warp_retry', name, tactic });
    try { await withTimeout(secureSpot(bot, tactic === 'none' ? 'seal' : tactic, { token: taskToken, emit }), 6000, () => {}); } catch (e) {}
    try { stopMotion(); } catch (e) {}
    r = homewarp.goHome(bot, name, goOpts) ? await awaitWarp(opts) : NOT_SENT;
  }
  if (tactic === 'float') { try { bot.setControlState('jump', false); } catch (e) {} }
  emit({ type: 'safe_warp', name, tactic, warped: !!r.warped, ...(r.notSent ? { sent: false } : {}) });
  // /home safe SILENCIEUX depuis sous terre (warped:false, non annulé, aucun message de refus reconnu
  // par refusedHome) = signet safe cassé → le bot reste piégé en profondeur, /home safe ne le
  // remontera jamais. La voie « refus » (home_tp_refused) ne couvre que le refus EXPLICITE ; ce no-op
  // muet n'armait donc JAMAIS le self-heal `safe_home_reset` (mesuré world_mn11 : NethBot3 392 min à
  // y17, warped:false en boucle, 0 home_tp_refused). On l'invalide APRÈS quelques occurrences
  // consécutives (un warmup teleport-delay ponctuel ne se répète pas) → le self-heal re-pose un safe
  // sain à la prochaine surface sèche, et la survie cesse de compter sur ce warp mort.
  try {
    const py = bot.entity && bot.entity.position ? bot.entity.position.y : null;
    if (!r.notSent && isSilentSafeFailure({ name, warped: !!r.warped, cancelled: !!r.cancelled, y: py })) {
      _safeNoopStreak++;
      if (_safeNoopStreak >= SAFE_NOOP_MAX && !_homeRefusedAt.safe) {
        _homeRefusedAt.safe = Date.now();
        _safeHomeSurface = false;
        emit({ type: 'safe_home_broken', y: Math.round(py), streak: _safeNoopStreak });
      }
    } else if (name === HOME_SAFE && r.warped) {
      _safeNoopStreak = 0;   // un warp qui déplace vraiment le bot prouve que le signet est sain
    }
  } catch (e) { /* best-effort */ }
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

// GROTTES D'ABORD (Massii 24/10) : un diamant EXPOSÉ et SEC connu à ≤ 64 blocs (3D) — vu par le bot
// (scan des chunks chargés, diamants seulement) ou dans la carte — et pas mis de côté comme inatteignable.
// Lu par goals.descend_y54 : déjà dans la bande des diamants, on ne recreuse pas d'escalier vers -54 avant
// d'avoir visité cette grotte. Caché 20 s (ctxExtra tourne à chaque pas du planner). NIVEAU MODULE.
let _caveDiaNearCache = { at: 0, val: false };
function caveDiamondNearNow() {
  try {
    const now = Date.now();
    if (now - _caveDiaNearCache.at < 20000) return _caveDiaNearCache.val;
    let val = false;
    const p = bot && bot.entity && bot.entity.position;
    const obj = (world && world.objective && world.objective.type) || '';
    const items = (bot && bot.inventory && bot.inventory.items()) || [];
    const pick = items.some((i) => i && /^(iron|diamond|netherite)_pickaxe$/.test(i.name));
    if (p && obj === 'diamond' && pick && p.y <= -16) {
      const from = { x: p.x, y: p.y, z: p.z };
      const skip = new Set(caveHuntSkip.keys());
      const ores = require('./ores');
      for (const o of (ores.scanExposedOres(bot, { maxDistance: 48, count: 16, names: ['diamond_ore', 'deepslate_diamond_ore'] }) || [])) {
        if (caveNearSkipped(skip, o)) continue;     // grappe mise de côté (rayon 4), pas seulement le bloc
        try { if (ores.isWaterAdjacent(bot, o)) continue; } catch (e) { /* inconnu → gardé */ }
        if (Math.hypot(o.x - from.x, o.y - from.y, o.z - from.z) <= 64) { val = true; break; }
      }
      if (!val && bot._worldMemory) {
        const t = ores.nextOreTarget(bot._worldMemory, String(bot._worldKey || 'overworld'), from, {
          allowTypes: ['diamond'], exposedOnly: true, excludeWet: true, pickTier: 3, maxDist: 64, skip,
        });
        val = !!t;
      }
    }
    _caveDiaNearCache = { at: now, val };
    return val;
  } catch (e) { return false; }
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
  // ⚠️ NE RÉSERVER UN MAPPEUR QUE SI ON VA L'ARMER (fix 18/08). ctxExtra tourne à chaque pas de
  // TOUTES les chaînes : `_giftContext()` posait donc la réservation `marmor:` — et `_giftTarget`,
  // qui fait mettre 24 lingots de côté au team_gift — pour un ouvrier 4/4 parti au DIAMANT, qui ne
  // l'armerait jamais. Les coéquipiers sur mapper_armor trouvaient alors les mappeurs nus « déjà
  // réservés » → chaîne satisfaite d'office → la boucle à vide ×47 791. Seule MAPPER_ARMOR_CHAIN
  // lit mapperTarget/giftReady. Une réservation restée d'un mapper_armor interrompu (préemption,
  // respawn) est rendue ici, pour qu'un coéquipier puisse prendre le relais sans attendre le TTL.
  const onGiftChain = !!(world.objective && world.objective.type === 'mapper_armor');
  // BÛCHERON (20/10 soir) : SES pièces d'abord, puis l'armure d'un cartographe avec ce qui reste de
  // lingots — il RÉUTILISE gift_craft/gift_deliver, donc `mapperTarget`/`giftReady` viennent de son plan.
  const ljArmor = isLumberjackObjective() ? _ljArmorContext() : null;
  const ljGiftNow = ljArmor && ljArmor.gift;
  if (!onGiftChain && !ljGiftNow && _giftTarget) releaseGiftTarget(_giftTarget);
  const gift = onGiftChain ? _giftContext()
    : (ljGiftNow ? { target: ljGiftNow.to, ready: ljGiftNow.ready } : { target: null, ready: false });
  if (!onGiftChain) { _giftBatch = null; _giftNeed = null; }   // un lot n'a de sens que dans la chaîne mapper_armor
  // noWood : le bois est PROUVÉ rare dans cette zone (même seuil que le verdict « zone rasée »).
  // Rend `plank_buffer` non bloquant → un ouvrier remonté en surface d'un wood-desert peut enfin
  // redescendre miner son fer au lieu de boucler gatherLog→not_found (deadlock world_mn12, 28/07).
  // Se remet à false après une migration (le compteur est réinitialisé au ré-ancrage).
  // ⚠️ VOLONTAIREMENT sur le CUMUL de zone, pas sur la fenêtre du verdict (fix world_mn14) : c'est
  // un VERROU qui doit tenir jusqu'à la migration. Fenêtré, il se relâcherait après 20 min de calme,
  // `plank_buffer` redeviendrait bloquant en plein wood-desert et on recréerait le deadlock mn12 —
  // le bot re-tente, re-échoue, le verrou revient : du churn pour rien. Le verdict pose une question
  // de DÉBIT, ce verrou une question de FAIT ÉTABLI (piège #55b : identifier le consommateur).
  const noWood = _zoneLogsNotFound >= LOGS_NOT_FOUND_MAX;
  // passiveNear : un animal chassable à ≤ 32 blocs (même rayon que la chasse elle-même). Lu par le but
  // `food_stock` du kit mappeur : sans rien à chasser il est SATISFAIT et le kit avance (19/10 : MapBot2
  // coincé sur `no_prey:no_rod` au lieu d'aller cartographier). Lecture du monde impossible → false : on
  // préfère laisser avancer le kit que le bloquer sur une donnée qu'on n'a pas su lire (la faim a ses
  // propres filets : réflexe, timer « food run », chair de zombie).
  let passiveNear = false;
  try { passiveNear = !!nearestPassive(bot, HUNT_SIGHT_RADIUS); } catch (e) { passiveNear = false; }
  // LIT (but `bed`) : lit posé / essai raté en attente / mouton vu ou connu. Jamais de throw.
  let bedCtx = { bedPlaced: false, bedRetryLater: false, sheepNear: false };
  try { bedCtx = bedCtxNow(); } catch (e) { /* best-effort : sans info, le but est sauté */ }
  // Pioche diamant (goals.wantsDiamondPick) : l'amélioration fer → diamant déjà faite (une fois).
  let diaPickUpgraded = false;
  try { diaPickUpgraded = _diaPickState().upgraded; } catch (e) { diaPickUpgraded = false; }
  // Armure diamant (goals.diamondArmorPlanOf) : pièces d'armure SAINES en poche — une pièce usée sortie
  // de son slot ne doit pas être ré-enfilée en croyant le slot couvert.
  let pocketArmorGood = [];
  try { pocketArmorGood = _pocketArmorGood(); } catch (e) { pocketArmorGood = []; }
  // Épée (goals.SWORD_GOAL / sword.js) : épées SAINES en poche — une épée à bout de course est refaite.
  let swordsGood = [];
  try { swordsGood = _swordsGood(); } catch (e) { swordsGood = []; }
  // Armure : slots reforgés il y a < 10 min (armorWear) — jamais deux fois la même pièce.
  let armorCooldownSlots = [];
  try { armorCooldownSlots = armorCoolingSlots(_armorCraftMap(), Date.now()); } catch (e) { armorCooldownSlots = []; }
  return {
    pocketArmorGood, swordsGood, armorCooldownSlots,
    ...bedCtx,
    hasTable: !!_nearestTable(bot), y: pos ? pos.y : undefined, worn: [..._wornArmor()], offhand, diaPickUpgraded,
    mapperTarget: gift.target, giftReady: gift.ready, giftBatch: !!gift.batch, noWood, passiveNear,
    giftNeed: (gift.target && Number.isFinite(gift.need)) ? gift.need : undefined,
    // Fer en grotte : la grappe EXPOSÉE la plus rentable (null → but `iron_cave` sauté). Caché 30 s.
    // …et seulement à ≥ 12 PV (caveIron.caveHpOk, chrono 22/10) : blessé, on mine en galerie.
    ironCave: ironCaveForPlanner(),
    // Bûcheron : la demande réservée à servir (LUMBERJACK_CHAIN.lj_deliver). Null hors rôle.
    woodRequest: isLumberjackObjective() ? _ljContext() : null,
    ljOwnArmor: ljArmor ? ljArmor.own : null,
    ljForestTrip: isLumberjackObjective() ? _ljForestNeeded() : false,
    caveDiamondNear: caveDiamondNearNow(),
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

// LOT abordable pour le cartographe réservé (20/10, NethBot2 : 11 lingots, MapBot2 nu → bottes + casque
// tout de suite au lieu de redescendre miner 24 lingots). { to, pieces, ingots } ou null. Niveau module :
// lu par craftGiftSet / deliverMapperArmor (skills) et recalculé par _giftContext.
let _giftBatch = null;
// Lingots encore à réunir pour le cartographe réservé (24/10, lumberjack.mapperGiftNeed) — null = inconnu
// (set complet). Niveau module : lu par ctxExtra (but GN) et par le branch-mine (stopOre en mapper_armor).
let _giftNeed = null;
const GIFT_BATCH_REDO_MS = 90000;   // après un lot livré : le cartographe redevient servable dès que son
                                    // heartbeat (60 s) a publié ses nouvelles pièces manquantes

/** Poche : pièces fer SAINES (noms) + usées + lingots — mêmes règles que le plan du bûcheron. */
function _giftPocket() {
  const good = [], broken = [];
  let ingots = 0;
  for (const it of (bot.inventory && bot.inventory.items()) || []) {
    if (!it || !it.name) continue;
    if (it.name === 'iron_ingot') ingots += it.count || 0;
    if (GIFT_PIECES.includes(it.name)) (isNearlyBroken(it) ? broken : good).push(it.name);
  }
  return { good, broken, ingots };
}

/** Recalcule le lot pour `mate` (entrée de présence du cartographe réservé) ; null si rien d'abordable. */
function _refreshGiftBatch(mate, now) {
  const pk = _giftPocket();
  const b = mate ? giftBatchFor({ target: mate, ingots: pk.ingots, pocket: pk.good, brokenPocket: pk.broken, now }) : null;
  if (b && (!_giftBatch || _giftBatch.to !== b.to || _giftBatch.pieces.join() !== b.pieces.join())) {
    emit({ type: 'gift_batch', to: b.to, pieces: b.pieces.slice(), ingots: b.ingots, phase: 'planned' });
  }
  _giftBatch = b;
  return b;
}

function _giftContext() {
  const empty = { target: null, ready: false };
  try {
    const items = (bot && bot.inventory && bot.inventory.items()) || [];
    const fullReady = giftSetPlan(items).ready;
    // Lot en cours : prêt = toutes SES pièces en poche (sinon : le set complet historique).
    const readyNow = () => ((_giftBatch && _giftBatch.to === _giftTarget)
      ? ljGiftReady(_giftBatch.pieces, _giftPocket().good) : fullReady);
    let ready = fullReady;
    // Serveur SANS plugin de téléportation (whitelist sans /tpa) : la livraison est IMPOSSIBLE par
    // construction — `deliverMapperArmor` est gated par le même isAllowed. Sans cette sortie on
    // réserverait une cible que PERSONNE ne peut servir, et comme les cartographes y restent nus en
    // permanence, la chaîne mapper_armor bouclerait à vie sur gift_blocked sans jamais atteindre le
    // diamant. Pas de cible ⇒ tous les buts de la chaîne sont satisfaits d'office → le bot enchaîne.
    if (!isAllowed('/tpa x', whitelist)) { _giftTarget = null; _giftBatch = null; return { target: null, ready }; }
    const now = Date.now();
    if (now - _giftAt < GIFT_CACHE_MS) {
      return { target: _giftTarget, ready: readyNow(), batch: !!(_giftBatch && _giftBatch.to === _giftTarget && _giftTarget),
        need: _giftTarget ? _giftNeed : null };
    }
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
        // Phase diamant cliquetée (24/10 soir) : on ne détourne un mineur que pour un cartographe VRAIMENT nu.
        opts: _teamLatchActive() ? { maxWorn: NAKED_MAPPER_MAX_WORN } : {},
      });
      if (!pick) { _giftTarget = null; return { target: null, ready }; }
      // Sans lockfile (groupe sans --claims) on accepte la cible telle quelle : mieux vaut deux
      // sets livrés qu'aucun — un mappeur sur-équipé garde simplement des pièces en poche.
      if (!_teamClaims || _teamClaims.tryClaim('marmor:' + pick.to)) {
        _giftTarget = pick.to;
        const mate = (mates || []).find((m) => m && m.name === pick.to) || null;
        const batch = _refreshGiftBatch(mate, now);
        try { _giftNeed = mate ? mapperGiftNeed(mate, _giftPocket().good) : null; } catch (e) { _giftNeed = null; }
        ready = readyNow();
        return { target: pick.to, ready, batch: !!batch, need: _giftNeed };
      }
      skip.add(pick.to);
    }
    _giftTarget = null;
    _giftBatch = null;
    return { target: null, ready };
  } catch (e) { return empty; }
}

// ROUTAGE RÉALISTE (fix 18/08 : mapper_armor→mapper_armor ×47 791 sur un serveur AVEC /tpa). Au
// moment d'enchaîner, la seule question qui vaille est « CE bot a-t-il un cartographe à armer
// MAINTENANT ? » — pas « existe-t-il un mappeur nu ». On recalcule donc `_giftContext` SANS son
// cache de 15 s : 4/4 soi-même, mappeur frais non livré il y a < 5 min, réservation `marmor:` obtenue.
// ⚠️ Effet de bord ASSUMÉ : la réservation est posée. Si l'enchaînement part ailleurs (entraide,
// diamant), `releaseGiftTarget` la rend tout de suite — sinon le mappeur resterait bloqué 120 s
// (TTL des claims) pour les coéquipiers qui, eux, pourraient l'armer.
function freshGiftTarget() {
  _giftAt = 0;
  return _giftContext().target;
}
function releaseGiftTarget(name) {
  if (!name) return;
  try { if (_teamClaims) _teamClaims.release('marmor:' + name); } catch (e) { /* best-effort */ }
  if (_giftTarget === name) _giftTarget = null;
  if (_giftBatch && _giftBatch.to === name) _giftBatch = null;
  _giftAt = 0;
}

// ─── REMISE EN MAIN PROPRE (24/10, cf. handoff.js) ──────────────────────────────────────────────
// Vécu : `gift_delivered` 500 ms après le TP puis `/home work` 300 ms plus tard ; MapBot1 (poche
// pleine) et NethBot3 (reparti miner) n'ont jamais ramassé — 1 h 30 à 2/4, toute l'équipe retenue en
// mapper_armor. Le donneur ne déclare plus rien sans preuve ; le receveur s'arrête, fait de la place,
// ramasse et s'équipe. ⚠️ Niveau MODULE (piège #56) : lus par le handler messagestr et par le skill.
let _giftRecvBusy = false;          // une réception à la fois

/** Objets au sol connus du client → [{ id, name, x, y, z }]. Jamais de throw. */
function _groundItems() {
  const out = [];
  try {
    for (const e of Object.values(bot.entities || {})) {
      if (!e || !e.position || e.isValid === false) continue;
      if (e.name !== 'item' && e.displayName !== 'Item') continue;
      let name = null;
      try { const it = e.getDroppedItem && e.getDroppedItem(); name = it ? it.name : null; } catch (err) { name = null; }
      out.push({ id: e.id, name, x: e.position.x, y: e.position.y, z: e.position.z });
    }
  } catch (err) { /* best-effort */ }
  return out;
}

/** Nb de pièces `names` en poche. */
function _pocketCount(names) {
  const set = new Set(names || []);
  let n = 0;
  try { for (const it of (bot.inventory && bot.inventory.items()) || []) if (it && set.has(it.name)) n += it.count || 1; } catch (e) {}
  return n;
}

/** Entité du joueur `name` (attend ≤ maxMs qu'elle apparaisse après un TP). */
async function _waitPlayerEntity(name, maxMs) {
  const t0 = Date.now();
  for (;;) {
    const ent = bot.players && bot.players[name] && bot.players[name].entity;
    if (ent && ent.position) return ent;
    if (Date.now() - t0 >= maxMs) return null;
    await sleep(HANDOFF_POLL_MS);
  }
}

/**
 * DONNEUR : approche (≤ 2 blocs), regarde, jette `pieces`, puis attend la PREUVE (ramassage vu, ou
 * heartbeat du receveur postérieur au jet qui ne les liste plus). Sans preuve : reprend ses objets et
 * réessaie une fois. → { given, by, tries }. `given` = 0 tant que rien n'est prouvé. Jamais de throw.
 */
async function handOffPieces(to, pieces) {
  const gen = _lifeGen;
  let tries = 0;
  let collected = 0;
  let tossedNames = [];
  const onCollect = (collector, collectedEnt) => {
    try {
      if (!collector || collector.username !== to) return;
      let name = null;
      try { const it = collectedEnt && collectedEnt.getDroppedItem && collectedEnt.getDroppedItem(); name = it ? it.name : null; } catch (e) {}
      if (name == null || pieces.includes(name)) collected += 1;
    } catch (e) { /* jamais de throw dans un handler */ }
  };
  try { bot.on('playerCollect', onCollect); } catch (e) {}
  try {
    while (tries < HANDOFF_MAX_TRIES) {
      tries += 1;
      if (lifeStale(gen)) return { given: 0, by: null, tries, reason: 'life_changed' };
      const ent = await _waitPlayerEntity(to, HANDOFF_ENTITY_WAIT_MS);
      if (!ent) { emit({ type: 'gift_retry', to, try: tries, reason: 'not_visible' }); continue; }
      const me = bot.entity && bot.entity.position;
      let dist = me ? me.distanceTo(ent.position) : Infinity;
      if (!tossReady(dist)) {
        try { await gotoWithTimeout(bot, new pfGoals.GoalNear(ent.position.x, ent.position.y, ent.position.z, 1), HANDOFF_APPROACH_MS); } catch (e) {}
        const me2 = bot.entity && bot.entity.position;
        const e2 = bot.players && bot.players[to] && bot.players[to].entity;
        dist = (me2 && e2 && e2.position) ? me2.distanceTo(e2.position) : Infinity;
      }
      if (!tossReady(dist)) { emit({ type: 'gift_retry', to, try: tries, reason: 'too_far', dist: Math.round(dist * 10) / 10 }); continue; }
      const tgt = (bot.players[to] && bot.players[to].entity) || ent;
      try { await bot.lookAt(tgt.position.offset(0, 1.0, 0), true); } catch (e) {}
      tossedNames = [];
      collected = 0;
      for (const piece of pieces) {
        const it = ((bot.inventory && bot.inventory.items()) || []).find((i) => i && i.name === piece);
        if (!it) continue;
        try { await bot.tossStack(it); tossedNames.push(piece); } catch (e) {}
      }
      if (!tossedNames.length) return { given: 0, by: null, tries, reason: 'nothing_to_toss' };
      const tossAt = Date.now();
      emit({ type: 'gift_tossed', to, pieces: tossedNames.slice(), try: tries, dist: Math.round(dist * 10) / 10 });
      // Un pas en arrière : le délai de ramassage (2 s) vaut pour TOUT LE MONDE — collé au receveur, le
      // donneur reprendrait ses propres objets une fois sur deux.
      try { bot.setControlState('back', true); await sleep(600); } catch (e) {} finally { try { bot.setControlState('back', false); } catch (e) {} }
      let lastBeatCheck = 0;
      let receiver = null;
      let next = 'wait';
      while (next === 'wait') {
        if (lifeStale(gen)) return { given: 0, by: null, tries, reason: 'life_changed' };
        await sleep(HANDOFF_POLL_MS);
        const now = Date.now();
        if (presence && now - lastBeatCheck >= HANDOFF_BEAT_CHECK_MS) {
          lastBeatCheck = now;
          try { receiver = (presence.list() || []).find((m) => m && m.name === to) || null; } catch (e) { receiver = null; }
        }
        const proof = deliveryProof({ pieces: tossedNames, collected, receiver, tossAt, pocketBack: _pocketCount(tossedNames) });
        next = handoffNext({ proof, elapsedMs: now - tossAt, tries });
        if (next === 'delivered') {
          emit({ type: 'gift_confirmed', to, by: proof.by, pieces: tossedNames.slice(), took_ms: now - tossAt });
          return { given: tossedNames.length, by: proof.by, tries };
        }
      }
      // Pas de preuve : on reprend ce qui traîne encore (le receveur a pu ne pas pouvoir ramasser).
      for (const g of pickupTargets({ self: bot.entity.position, items: _groundItems(), radius: 8 })) {
        if (g.name != null && !tossedNames.includes(g.name)) continue;
        try { await gotoWithTimeout(bot, new pfGoals.GoalNear(g.x, g.y, g.z, 0), 5000); } catch (e) {}
      }
      await sleep(800);
      emit({ type: 'gift_retry', to, try: tries, reason: next === 'give_up' ? 'unconfirmed_final' : 'unconfirmed',
        back: _pocketCount(tossedNames) });
      if (next === 'give_up') break;
    }
    return { given: 0, by: null, tries, reason: 'unconfirmed' };
  } finally {
    try { bot.removeListener('playerCollect', onCollect); } catch (e) {}
  }
}

/**
 * RECEVEUR : un coéquipier qui tient `marmor:<moi>` vient de demander un /tpa → je m'arrête (verrou de
 * but), je fais de la place, j'attend ≤ 30 s, je ramasse les cadeaux à ≤ 4 blocs et je m'équipe aussitôt.
 * Fire-and-forget depuis le handler messagestr. Jamais de throw.
 */
async function receiveGiftFrom(donor) {
  if (_giftRecvBusy) return;
  _giftRecvBusy = true;
  const gen = _lifeGen;
  const t0 = Date.now();
  const wornBefore = _wornArmor().size;
  let outcome = 'timeout';
  emit({ type: 'gift_receive_wait', from: donor });
  try {
    try { if (bot.targetDigBlock && typeof bot.stopDigging === 'function') bot.stopDigging(); } catch (e) {}
    // Le verrou de but est PARTAGÉ avec la fuite creeper : on ne le vole jamais à un autre propriétaire.
    const holdFree = () => !(_creeperHold.until > Date.now() && _creeperHold.owner && _creeperHold.owner !== 'gift_receive');
    if (holdFree()) {
      holdGoal(_creeperHold, t0 + HANDOFF_RECEIVE_WAIT_MS, 'gift_receive');
      try { holdSetGoal(bot.pathfinder, _creeperHold, null); } catch (e) {}
    }
    // Place : une case par pièce attendue (l'armure ne s'empile pas). Poche pleine = rien ne se ramasse.
    try {
      const expected = missingIronPieces(buildCtxInv(bot), [..._wornArmor()]).length || 1;
      let toFree = slotsToFree({ emptySlots: bot.inventory.emptySlotCount(), expected });
      const tossed = [];
      while (toFree > 0) {
        const junk = pickJunkToToss(bot.inventory.items(), { exclude: [] });
        if (!junk) break;
        await bot.tossStack(junk);
        tossed.push(junk.name + ':' + junk.count);
        toFree -= 1;
      }
      if (tossed.length) emit({ type: 'gift_receive_room', tossed });
    } catch (e) { /* best-effort */ }
    let donorSeen = false;
    let donorGoneAt = 0;
    for (;;) {
      if (lifeStale(gen)) { outcome = 'life_changed'; break; }
      const now = Date.now();
      const me = bot.entity && bot.entity.position;
      const dEnt = bot.players && bot.players[donor] && bot.players[donor].entity;
      const near = !!(me && dEnt && dEnt.position && me.distanceTo(dEnt.position) <= 8);
      if (near) { donorSeen = true; donorGoneAt = 0; } else if (donorSeen && !donorGoneAt) donorGoneAt = now;
      const ground = me ? pickupTargets({ self: me, items: _groundItems() }) : [];
      const gotAll = missingIronPieces(buildCtxInv(bot), [..._wornArmor()]).length === 0;
      const step = receiverNext({ elapsedMs: now - t0, gotAll, groundLeft: ground.length, donorSeen,
        donorGoneMs: donorGoneAt ? now - donorGoneAt : 0 });
      if (step === 'done' || step === 'donor_left' || step === 'timeout') { outcome = step; break; }
      if (step === 'collect' && holdFree()) {
        const g = ground[0];
        holdGoal(_creeperHold, Math.max(now + 3000, t0 + HANDOFF_RECEIVE_WAIT_MS), 'gift_receive');
        try { holdSetGoal(bot.pathfinder, _creeperHold, new pfGoals.GoalNear(g.x, g.y, g.z, 0)); } catch (e) {}
      }
      await sleep(HANDOFF_POLL_MS);
    }
  } finally {
    if (_creeperHold.owner === 'gift_receive') {
      releaseGoalHold(_creeperHold);
      try { bot.pathfinder.setGoal(null); } catch (e) {}
    }
    try { await ensureArmor({ ironKeep: 0 }); } catch (e) { /* best-effort */ }
    const worn = _wornArmor().size;
    emit({ type: 'gift_received', from: donor, outcome, worn, gained: worn - wornBefore, took_ms: Date.now() - t0 });
    try { if (_beatNow) _beatNow(); } catch (e) {}   // le donneur attend ce heartbeat comme preuve
    _giftRecvBusy = false;
  }
}

// ─── BÛCHERON D'ÉQUIPE (Massii 20/10) ────────────────────────────────────────────────────────────
// « Un seul bot monte en surface faire le bois, puis il se /tpa vers les autres pour leur donner. »
// Le bois de surface était LE goulot : 63 % des morts arrivent en cherchant du bois (NethBot3, armure
// fer complète, 6 min bloqué sur gift_planks ; NethBot2 en boucle sur logs). Décisions PURES dans
// lumberjack.js ; ici la glue : demande publiée dans la présence, attente au chantier, élection par
// claim `lumberjack`, livraison par /tpa + toss, retour au spot de coupe (home `work`).
// Tout l'état est de NIVEAU MODULE (piège #56 : lu par les timers d'élection et par le planner).
// La demande EN COURS est persistée dans le mémo base (`woodRequest`, `woodTimedOutAt`) : le
// self-healing relance le process à chaque mort, l'horloge des 4 min doit y survivre (cf. #66a).
const LJ_CLAIM = 'lumberjack';
const LJ_TICK_MS = 30000;            // élection : la claim (TTL 120 s) est rafraîchie bien avant d'expirer
const LJ_CACHE_MS = 10000;           // ctxExtra tourne à chaque pas du planner : on ne martèle pas les verrous
const LJ_IDLE_MAX_MS = 300000;       // une tranche d'attente du bûcheron sans demande
const WOOD_DONE_TTL_MS = 120000;     // le heartbeat du servi le publie encore « demandeur » jusqu'à 60 s
const WOOD_FAIL_TTL_MS = 120000;     // /tpa raté : on laisse la demande à un autre essai plus tard
const WOOD_WAIT_POLL_MS = 1000;
const WOOD_WAIT_LJ_CHECK_MS = 20000; // « attendre 20 s par tranche » : bûcheron toujours là ?
let _woodReq = null;                 // { want, at } — MA demande en cours (persistée)
let _woodTimedOutAt = 0;             // dernier timeout (persisté) → 10 min d'autonomie bois
let _woodReqLoaded = false;
let _beatNow = null;                 // heartbeat immédiat (posé par onSpawn) — une demande se voit tout de suite
let _ljTarget = null;                // { to, amount, want } — demande RÉSERVÉE (claim `wood:<to>`)
let _ljAt = 0;
let _ljSwitching = false;
const _woodDone = new Map();         // nom → instant de livraison
const _woodFailed = new Map();       // nom → instant du /tpa raté
const _ljEvAt = {};                  // throttle des events d'observation

function _ljEmit(type, data, minMs) {
  const now = Date.now();
  if (minMs && _ljEvAt[type] && now - _ljEvAt[type] < minMs) return;
  _ljEvAt[type] = now;
  emit(Object.assign({ type }, data || {}));
}

function isLumberjackObjective() {
  return !!(world && world.objective && world.objective.type === 'lumberjack');
}

function loadWoodRequest() {
  if (_woodReqLoaded) return;
  _woodReqLoaded = true;
  try {
    const st = loadBaseState() || {};
    const r = st.woodRequest;
    if (r && r.want > 0 && Number.isFinite(r.at)) _woodReq = { want: r.want, at: r.at };
    if (Number.isFinite(st.woodTimedOutAt)) _woodTimedOutAt = st.woodTimedOutAt;
  } catch (e) { /* mémo illisible : pas de demande héritée */ }
}

/** Pose (ou retire avec null) MA demande, la persiste (FUSION du mémo base) et la publie tout de suite. */
function setWoodRequest(req) {
  _woodReq = req ? { want: req.want, at: req.at } : null;
  try {
    const next = Object.assign({}, loadBaseState() || {});
    if (_woodReq) next.woodRequest = _woodReq; else delete next.woodRequest;
    if (_woodTimedOutAt) next.woodTimedOutAt = _woodTimedOutAt;
    saveBaseState(next);
  } catch (e) { /* best-effort */ }
  try { if (_beatNow) _beatNow(); } catch (e) { /* best-effort */ }
}

/**
 * Qui peut me livrer du bois ? Le bûcheron actif ; à défaut (personne n'est 4/4 → pas d'élu, 23/10),
 * un coéquipier mineur dont le heartbeat annonce ≥ 24 bûches-équivalent (lumberjack.peerWoodSupplier).
 */
function woodSupplierNow(now) {
  if (!presence) return null;
  try {
    const mates = presence.list();
    return activeLumberjack({ mates, selfName: bot.username, now }) || peerWoodSupplier({ mates, selfName: bot.username, now });
  } catch (e) { return null; }
}
function _isLumberjackName(name) {
  if (!name || !presence) return false;
  try { return presence.list().some((m) => m && m.name === name && m.role === 'lumberjack'); } catch (e) { return false; }
}

/**
 * Avant un but BOIS (skill gatherLog) d'un ouvrier : demander au bûcheron et ATTENDRE au chantier au
 * lieu de remonter. Retourne null → lancer le skill normalement (pas de bûcheron, timeout, je suis le
 * bûcheron…) ; sinon le résultat à rendre au planner ({ok:true} bois reçu, {ok:false,'cancelled'}).
 */
async function woodWaitStep(g, why) {
  if (!isWoodGoal(g) || !presence) return null;
  loadWoodRequest();
  const now = Date.now();
  let lj = woodSupplierNow(now);
  const d = woodWaitDecision({
    isLumberjack: isLumberjackObjective(), isMapper: IS_MAPPER, lumberjack: lj,
    request: _woodReq, timedOutAt: _woodTimedOutAt, now,
    underground: (bot.entity && bot.entity.position && bot.entity.position.y != null) ? bot.entity.position.y < WOOD_UNDERGROUND_Y : true,
    noWoodHere: woodNoWoodHere(),
  });
  if (d.action === 'self') { if (d.clear) setWoodRequest(null); return null; }
  if (d.action === 'timeout') {
    const waited = _woodReq ? Math.round((now - _woodReq.at) / 1000) : null;
    _woodTimedOutAt = now;
    emit({ type: 'wood_request_timeout', goal: g.name, lumberjack: lj, waited_s: waited });
    setWoodRequest(null);
    return null;                                   // repli : il va chercher lui-même (comportement historique)
  }
  if (d.action === 'request') {
    const want = woodWantFor(g);
    setWoodRequest({ want, at: now });
    emit({ type: 'wood_request', want, goal: g.name, lumberjack: lj, why: why || 'wood_goal', peer: !_isLumberjackName(lj) });
  }
  const req = _woodReq;
  if (!req) return null;
  const deadline = req.at + WOOD_REQUEST_TTL_MS;
  // Bûches-ÉQUIVALENT (23/10) : un coéquipier peut donner 64 planches au lieu de 16 bûches.
  const before = woodEquiv(buildCtxInv(bot));
  const enough = Math.min(WOOD_MIN_GIFT, req.want);
  _ljEmit('wood_wait', { goal: g.name, lumberjack: lj, remaining_s: Math.round((deadline - Date.now()) / 1000) }, 60000);
  try { stopMotion(); } catch (e) { /* on reste au chantier */ }
  // Inventaire PLEIN → les bûches jetées par le bûcheron resteraient au sol : on libère UNE case de
  // déchet (liste blanche terre > gravier > roche > cobble au-delà de 32, cf. skills/craft.js).
  try {
    if (bot.inventory && typeof bot.inventory.emptySlotCount === 'function' && bot.inventory.emptySlotCount() === 0) {
      const junk = pickJunkToToss(bot.inventory.items(), { exclude: [] });
      if (junk) { await bot.toss(junk.type, null, junk.count); emit({ type: 'wood_wait_room', tossed: junk.name }); }
    }
  } catch (e) { /* best-effort : au pire il ramasse ce qui tient */ }
  let lastCheck = Date.now();
  while (Date.now() < deadline) {
    if (taskToken.cancelled || migrationOwnsBot()) return { ok: false, reason: 'cancelled' };
    await sleep(WOOD_WAIT_POLL_MS);
    const have = woodEquiv(buildCtxInv(bot));
    if (have - before >= enough) {
      emit({ type: 'wood_received', count: have - before, goal: g.name, from: lj });
      setWoodRequest(null);
      return { ok: true };
    }
    if (Date.now() - lastCheck >= WOOD_WAIT_LJ_CHECK_MS) {
      lastCheck = Date.now();
      const still = woodSupplierNow(Date.now());
      if (!still) {
        emit({ type: 'wood_wait_end', reason: 'no_lumberjack', goal: g.name });
        setWoodRequest(null);
        return null;                               // bûcheron disparu : on y va soi-même
      }
      lj = still;
    }
  }
  return woodWaitStep(g, why);                     // échéance → la décision rend 'timeout' → repli
}

/**
 * BOIS MANQUANT POUR UN CRAFT (20/10, NethBot2 session 312 : `gift_pick` 16× `pick_recovery:no_sticks`,
 * 1 planche, 0 bûche, à y 13 — jamais de demande au bûcheron, qui ne servait que les buts gatherLog).
 * Après l'échec d'un but NON bois dont la raison et la poche disent « pas assez de bois » (bâtons,
 * planches, table), on publie la même demande que pour un but bois et on attend au chantier (4 min max,
 * puis repli historique). null = rien à faire (pas de manque, pas de bûcheron, timeout…), sinon le
 * résultat à rendre au planner ({ok:true} = bois reçu, le planner re-tente le but avec le bois en poche).
 */
async function woodRequestOnShortage(g, reason, why) {
  try {
    if (!g || isWoodGoal(g) || IS_MAPPER || isLumberjackObjective()) return null;
    if (!woodShortForFailure({ reason, goalName: g.name, inv: buildCtxInv(bot), hasTable: !!_nearestTable(bot) })) return null;
    return await woodWaitStep({ name: g.name, skill: 'gatherLog', args: { count: 16 } }, why || String(reason || 'craft'));
  } catch (e) { return null; }
}

/** La zone est-elle PROUVÉE sans bois ? (verrou noWood du ctx, ou échec bois prouvé). Jamais de throw. */
function woodNoWoodHere() {
  try { return _zoneLogsNotFound >= LOGS_NOT_FOUND_MAX || !!_needsWoodTrip; } catch (e) { return false; }
}

/**
 * BUT DE CRAFT BOIS SANS LA MATIÈRE (23/10, NethBot2 : `sticks`/`crafting_table`/`planks` à y 18-54 →
 * `wood_trip` vers la surface puis `no_wood:planks` en boucle, AUCUNE `wood_request`, pendant que le
 * bûcheron attendait sur 51 bûches). woodWaitStep ne voyait que les buts `gatherLog`. On demande AVANT
 * le skill (donc avant le trajet surface de runGoalSkill), avec la même attente bornée (4 min).
 * null = rien à faire (bois en poche, pas de bûcheron, timeout…) → chemin historique.
 */
async function woodGoalRequestStep(g) {
  try {
    if (!g || isWoodGoal(g) || !WOOD_GOALS.has(g.name) || IS_MAPPER || isLumberjackObjective()) return null;
    if (!woodGoalShortage({ goalName: g.name, inv: buildCtxInv(bot), hasTable: !!_nearestTable(bot) })) return null;
    return await woodWaitStep({ name: g.name, skill: 'gatherLog', args: { count: 16 } }, 'wood_goal_short');
  } catch (e) { return null; }
}

// ─── ENTRAIDE BOIS SANS BÛCHERON : LE DONNEUR (23/10, cf. lumberjack.pickPeerWoodGift) ──────────
// Appelé ENTRE deux buts (runSkillWithTelemetry) : le donneur part de son propre contexte de planner,
// /tpa vers le demandeur, jette 16 bûches (ou 64 planches), rentre au chantier par /home work.
// Réservation `wood:<demandeur>` dans les claims PARTAGÉS (la même que le bûcheron) → un seul donneur.
// ⚠️ NIVEAU MODULE (piège #56) : throttle et Maps lus d'un appel à l'autre.
const PEER_GIFT_CHECK_MS = 15000;
let _peerGiftCheckAt = 0;
async function peerWoodGiftStep(gen) {
  try {
    if (IS_MAPPER || isLumberjackObjective() || !presence || !_teamClaims) return null;
    const now = Date.now();
    if (now - _peerGiftCheckAt < PEER_GIFT_CHECK_MS) return null;
    _peerGiftCheckAt = now;
    if (_migrating || migrationOwnsBot() || _woodReq) return null;      // je demande moi-même : je ne donne pas
    if (!isAllowed('/tpa x', whitelist)) return null;
    for (const [n, at] of _woodDone) { if (now - at > WOOD_DONE_TTL_MS) _woodDone.delete(n); }
    for (const [n, at] of _woodFailed) { if (now - at > WOOD_FAIL_TTL_MS) _woodFailed.delete(n); }
    const mates = presence.list();
    const lj = activeLumberjack({ mates, selfName: bot.username, now });
    const inv = buildCtxInv(bot);
    let planks = 0;
    for (const [k, v] of Object.entries(inv)) if (k.endsWith('_planks')) planks += v || 0;
    const skip = new Set([..._woodDone.keys(), ..._woodFailed.keys()]);
    const pick = pickPeerWoodGift({ mates, selfName: bot.username, now, logs: logCount(inv), planks, skip, lumberjack: lj });
    if (!pick) return null;
    let hostilesNear = 0;
    try {
      const h = bot.nearestEntity((x) => x && x.kind === 'Hostile mobs');
      if (h && bot.entity && h.position.distanceTo(bot.entity.position) <= 12) hostilesNear = 1;
    } catch (e) { /* best-effort */ }
    let worn = 0;
    try { worn = _wornArmor().size; } catch (e) { worn = 0; }
    const safe = peerDonorSafe({ health: bot.health, food: bot.food, hostilesNear,
      isNight: (bot.time && bot.time.timeOfDay != null) ? isNight(bot) : false, worn });
    if (!safe) { _ljEmit('peer_wood_gift_skip', { to: pick.to, why: 'danger' }, 60000); return null; }
    const key = 'wood:' + pick.to;
    if (!_teamClaims.tryClaim(key)) return null;                       // un autre donneur (ou le bûcheron) s'en charge
    const release = () => { try { _teamClaims.release(key); } catch (e) {} };
    if (!isAllowed('/tpa ' + pick.to, whitelist)) { release(); return null; }
    try { stopMotion(); } catch (e) {}
    markWorkBeforeTrip('peer_wood_gift');
    emit({ type: 'wood_tpa', to: pick.to, amount: pick.logs + pick.planks / 4, logs: pick.logs, planks: pick.planks, peer: true });
    try { bot.chat('/tpa ' + pick.to); } catch (e) { release(); return null; }
    const w = await awaitWarp({ maxMs: 20000 });
    if (lifeStale(gen)) { release(); return null; }
    if (!w.warped) {
      _woodFailed.set(pick.to, Date.now());
      release();
      emit({ type: 'peer_wood_tpa_failed', to: pick.to, reason: w.cancelled ? 'cancelled' : 'no_warp' });
      return null;
    }
    try {
      const ent = bot.players[pick.to] && bot.players[pick.to].entity;
      if (ent && ent.position && bot.lookAt) await bot.lookAt(ent.position.offset(0, 1, 0));
    } catch (e) { /* on jette quand même : le /tpa nous a posés sur lui */ }
    let given = 0;
    for (const st of woodGiftTossPlan((bot.inventory && bot.inventory.items()) || [], pick)) {
      try { await bot.toss(st.type, null, st.count); given += st.name.endsWith('_planks') ? st.count / 4 : st.count; } catch (e) { /* pile suivante */ }
    }
    emit({ type: 'wood_delivered', to: pick.to, count: given, want: pick.want, peer: true });
    if (given > 0) _woodDone.set(pick.to, Date.now()); else _woodFailed.set(pick.to, Date.now());
    release();
    // Retour TOUT DE SUITE (2 s de délai de ramassage : rester sur place nous ferait reprendre le bois).
    const back = await returnToWork('peer_wood_gift');
    if (!back && !lifeStale(gen)) { try { await safeWarpHome(HOME_SAFE, { ctx: 'peer_wood_return' }); } catch (e) { /* best-effort */ } }
    return { given };
  } catch (e) { return null; }
}

// ─── SANS BOIS ET SANS DONNEUR : ALLER COUPER CHEZ UN COÉQUIPIER EN FORÊT (23/10) ────────────────
// But bois, zone prouvée sans arbres, personne pour livrer : /tpa vers le coéquipier frais le plus
// proche qui se tient en surface près d'un endroit boisé CONNU (cellule de biome boisé ou bûches vues —
// zone.woodSpots), au lieu de ré-explorer 20 min une zone pelée. Throttle 5 min (NIVEAU MODULE, #56).
const WOOD_MATE_TPA_MS = 5 * 60000;
let _woodMateTpaAt = 0;
async function woodMateTpaStep(g, gen) {
  try {
    if (!isWoodGoal(g) || IS_MAPPER || isLumberjackObjective() || !presence) return null;
    if (!woodNoWoodHere()) return null;
    const now = Date.now();
    if (now - _woodMateTpaAt < WOOD_MATE_TPA_MS) return null;
    if (_migrating || migrationOwnsBot()) return null;
    const p = bot.entity && bot.entity.position;
    if (!p) return null;
    let worn = 0;
    try { worn = _wornArmor().size; } catch (e) { worn = 0; }
    if (bot.time && bot.time.timeOfDay != null && isNight(bot) && worn < 2) return null;   // jamais nu dans la nuit d'un autre
    const cells = loadWorldCells();
    const spots = woodSpots({ biomes: cells.biomes, finds: cells.finds, now });
    const pick = pickWoodedMate({ self: { x: p.x, z: p.z }, selfName: bot.username, mates: presence.list(), now, spots });
    if (!pick) return null;
    if (!isAllowed('/tpa ' + pick.name, whitelist)) return null;
    _woodMateTpaAt = now;
    try { stopMotion(); } catch (e) {}
    markWorkBeforeTrip('wood_mate_tpa');
    emit({ type: 'wood_mate_tpa', to: pick.name, dist: pick.dist, goal: g.name });
    try { bot.chat('/tpa ' + pick.name); } catch (e) { return null; }
    const w = await awaitWarp({ maxMs: 15000 });
    if (lifeStale(gen)) return null;
    emit({ type: 'wood_mate_tpa_result', to: pick.name, warped: !!w.warped });
    // Nouveau terrain : l'échec bois d'avant ne prouve plus rien ICI (le prochain skill re-cherche).
    if (w.warped) _needsWoodTrip = false;
    return { warped: !!w.warped };
  } catch (e) { return null; }
}

/** Bûcheron : demande à servir (réservée par claim `wood:<to>`), cache 10 s. Null si rien à faire. */
function _ljContext() {
  try {
    const now = Date.now();
    if (now - _ljAt < LJ_CACHE_MS) return _ljTarget;
    _ljAt = now;
    for (const [n, at] of _woodDone) { if (now - at > WOOD_DONE_TTL_MS) _woodDone.delete(n); }
    for (const [n, at] of _woodFailed) { if (now - at > WOOD_FAIL_TTL_MS) _woodFailed.delete(n); }
    const releaseCur = () => {
      if (_ljTarget) { try { if (_teamClaims) _teamClaims.release('wood:' + _ljTarget.to); } catch (e) {} }
      _ljTarget = null;
    };
    if (!presence || !isAllowed('/tpa x', whitelist)) { releaseCur(); return null; }
    const stock = logCount(buildCtxInv(bot));
    const mates = presence.list();
    const skip = new Set([..._woodDone.keys(), ..._woodFailed.keys()]);
    for (let i = 0; i < 6; i++) {
      const pick = pickWoodRequest({ mates, selfName: bot.username, now, stock, skip });
      if (!pick) break;
      if (!_teamClaims || _teamClaims.tryClaim('wood:' + pick.to)) {
        if (_ljTarget && _ljTarget.to !== pick.to) releaseCur();
        _ljTarget = pick;
        return pick;
      }
      skip.add(pick.to);
    }
    releaseCur();
    return null;
  } catch (e) { return null; }
}

/** Pose `work` au SPOT DE COUPE (le bûcheron y revient après chaque livraison). Jamais dans l'eau. */
function bookmarkCuttingSpot(why) {
  try {
    const p = bot.entity && bot.entity.position;
    if (!p || isInWater(bot)) return false;
    // Sous terre ce n'est pas un spot de coupe : on garde le chantier existant (comportement historique).
    if (p.y < SAFE_HOME_MIN_Y) return markWorkBeforeTrip(why);
    // Jamais de coin de coupe dans une zone prouvée NOYÉE (23/10) : chaque tranche 'mine' y repartirait.
    if (isDrownedNear(_drownedSites, { x: p.x, z: p.z }, Date.now())) {
      emit({ type: 'work_bookmark_refused', why, reason: 'drowned_site', x: Math.round(p.x), z: Math.round(p.z) });
      return false;
    }
    if (!homewarp.bookmark(bot, HOME_WORK)) return false;
    _workSet = true; _workPos = _botXZ();
    emit({ type: 'work_bookmarked', why });
    return true;
  } catch (e) { return false; }
}

/** Jette `amount` bûches vers `to` (on est sur lui : /tpa). Rend le nombre réellement jeté. */
async function tossLogsTo(to, amount) {
  try {
    const ent = bot.players[to] && bot.players[to].entity;
    if (ent && ent.position && bot.lookAt) await bot.lookAt(ent.position.offset(0, 1, 0));
  } catch (e) { /* on jette quand même : le /tpa nous a posés sur lui */ }
  let given = 0;
  const items = (bot.inventory && bot.inventory.items()) || [];
  for (const st of tossPlan(items, amount)) {
    try { await bot.toss(st.type, null, st.count); given += st.count; } catch (e) { /* pile suivante */ }
  }
  return given;
}

/** Skill `deliverWood` : /tpa vers le demandeur, toss, retour au spot de coupe. */
async function deliverWoodSkill() {
  const t = _ljTarget;
  if (!t) return { ok: true };                       // plus rien à servir
  const to = t.to;
  const release = () => {
    try { if (_teamClaims) _teamClaims.release('wood:' + to); } catch (e) {}
    if (_ljTarget && _ljTarget.to === to) _ljTarget = null;
    _ljAt = 0;
  };
  if (!isAllowed('/tpa ' + to, whitelist)) {
    release();
    emit({ type: 'lumberjack_tpa_failed', to, reason: 'not_whitelisted' });
    return { ok: false, reason: 'tpa_not_whitelisted' };
  }
  try { stopMotion(); } catch (e) {}
  bookmarkCuttingSpot('wood_tpa');
  emit({ type: 'wood_tpa', to, amount: t.amount });
  try { bot.chat('/tpa ' + to); } catch (e) { release(); return { ok: false, reason: 'chat_failed' }; }
  const w = await awaitWarp({ maxMs: 20000 });
  if (!w.warped) {
    _woodFailed.set(to, Date.now());
    release();
    emit({ type: 'lumberjack_tpa_failed', to, reason: w.cancelled ? 'cancelled' : 'no_warp' });
    return { ok: false, reason: 'tpa_failed' };
  }
  const given = await tossLogsTo(to, t.amount);
  emit({ type: 'wood_delivered', to, count: given, want: t.want });
  if (given > 0) _woodDone.set(to, Date.now()); else _woodFailed.set(to, Date.now());
  release();
  // Retour TOUT DE SUITE : les bûches jetées ont 2 s de délai de ramassage, rester sur place nous
  // ferait les reprendre. `work` = spot de coupe ; à défaut (posé dans l'eau/refusé), la base.
  const back = await returnToWork('wood_delivered');
  if (!back) { try { await safeWarpHome(HOME_SAFE, { ctx: 'lumberjack_return' }); } catch (e) { /* best-effort */ } }
  return given > 0 ? { ok: true } : { ok: false, reason: 'wood_toss_failed' };
}

/** Skill `lumberjackIdle` : stock plein, personne n'attend → patienter (≤ 5 min par tranche). */
async function lumberjackIdleSkill() {
  const _gen = _lifeGen;   // vie du lancement : après un respawn, le global taskToken est celui du runner suivant
  const t0 = Date.now();
  _ljEmit('lumberjack_idle', { stock: logCount(buildCtxInv(bot)) }, 300000);
  let ironCheckAt = 0;
  while (Date.now() - t0 < LJ_IDLE_MAX_MS) {
    if (taskToken.cancelled || lifeStale(_gen) || migrationOwnsBot()) return { ok: false, reason: 'cancelled' };
    // TEMPS MORT → FER (21/10) : plutôt qu'attendre, une tranche de fer bornée et préemptable.
    if (Date.now() - ironCheckAt >= LJ_IRON_CHECK_MS) {
      ironCheckAt = Date.now();
      const sliced = await ljIronSliceStep(_gen);
      if (sliced) return sliced;
    }
    await sleep(2000);
    if (logCount(buildCtxInv(bot)) < LUMBERJACK_STOCK) return { ok: true };   // stock entamé → refaire
    if (Date.now() - _ljAt >= LJ_CACHE_MS && _ljContext()) return { ok: true }; // une demande arrive
    let worn = 0;
    try { worn = _wornArmor().size; } catch (e) { worn = 0; }
    if (worn < 2 && isNight(bot)) return { held: 'night' };                  // rendre la main à la discipline de nuit
  }
  return { held: 'idle' };
}

// ─── BÛCHERON OISIF → FER (21/10, cf. lumberjack.ljIronSlicePlan) ────────────────────────────────
// Une TRANCHE : jeton DÉRIVÉ (annulé par le parent OU par la tranche elle-même) posé comme taskToken le
// temps du skill — runCaveIron / smelt le capturent, floodFillVein et les goto le lisent. Un chien de
// garde coupe la tranche dès qu'une demande de bois arrive (même test que l'attente historique) ou au
// bout de LJ_IRON_SLICE_MS : `withTimeout` n'annulerait rien, le jeton, si. ⚠️ NIVEAU MODULE (#56).
let _ljIronSliceAt = 0;
// Tranches ratées d'affilée (23/10) : le répit entre tranches double (lumberjack.ljSliceRetryMs). NIVEAU MODULE.
let _ljSliceFails = 0;

/** Plan + exécution ; null si rien d'utile (l'attente historique reprend). */
async function ljIronSliceStep(gen) {
  try {
    const items = (bot.inventory && bot.inventory.items()) || [];
    const n = (name) => items.reduce((s, i) => s + (i && i.name === name ? i.count : 0), 0);
    let worn = 0;
    try { worn = _wornArmor().size; } catch (e) { worn = 0; }
    const act = ljIronSlicePlan({
      rawIron: n('raw_iron'), ingots: n('iron_ingot'), cobble: n('cobblestone'),
      hasFurnace: n('furnace') > 0,
      hasStonePick: items.some((i) => i && /^(stone|iron|diamond|netherite)_pickaxe$/.test(i.name)),
      caveAvailable: _ljCaveAvailable(),
      // 3e acte 'mine' (21/10) : pioche pierre + de quoi murer la lave, au sec.
      canMine: items.some((i) => i && /^(stone|iron|diamond|netherite)_pickaxe$/.test(i.name))
        && n('cobblestone') >= LJ_MINE_COBBLE && !(function () { try { return isInWater(bot); } catch (e) { return false; } })(),
      nightLock: worn < 2 && bot.time && bot.time.timeOfDay != null && isNight(bot),
      now: Date.now(), lastSliceAt: _ljIronSliceAt, retryMs: ljSliceRetryMs(_ljSliceFails),
    });
    if (!act) return null;
    return await ljIronSlice(act, gen);
  } catch (e) { return null; }
}

/**
 * Tranche 'mine' (21/10) : descente en escalier de LJ_MINE_DEPTH blocs (fenêtre du fer) puis un court
 * branch-mine. Le jeton de la tranche (taskToken) coupe tout à la demande de bois. Jamais de bookmark
 * `work` : le bûcheron garde le sien au coin de coupe.
 */
async function ljMineSlice() {
  let p = bot.entity && bot.entity.position;
  if (!p) return { ok: false, reason: 'no_pos' };
  // DÉPART NOYÉ (23/10, NethBot1 : 44 tranches `water_ahead` en 7 s au même coin) : marcher d'abord
  // 30-50 blocs sur un cap qui tourne (workDrown), hors de tout départ banni. Jeton de la tranche :
  // une demande de bois coupe la marche (stopMotion du chien de garde → goto rejeté).
  const det = ljMineDetour({ pos: { x: p.x, z: p.z }, drownedSites: _drownedSites, seed: _drownedOffsetSeed, now: Date.now() });
  if (det) {
    _drownedOffsetSeed = det.seed;
    emit({ type: 'lj_mine_relocate', fromX: Math.round(p.x), fromZ: Math.round(p.z), x: det.x, z: det.z });
    try { await withTimeout(bot.pathfinder.goto(new pfGoals.GoalNearXZ(det.x, det.z, 3)), 60000, () => { try { stopMotion(); } catch (e) {} }); } catch (e) { /* on descend d'où l'on est */ }
    if (taskToken.cancelled) return { ok: false, reason: 'cancelled' };
    p = bot.entity && bot.entity.position;
    if (!p) return { ok: false, reason: 'no_pos' };
  }
  const start = { x: p.x, z: p.z };                       // COPIE : la position est un Vec3 muté en place
  const targetY = ljMineTargetY(p.y);
  if (p.y > targetY + 2) {
    const d = await descendDiagonal(bot, { targetY, maxDepth: 60, onSurvivalTick: descentSurvivalTick }, taskToken);
    if (taskToken.cancelled) return { ok: false, reason: 'cancelled' };
    const q = bot.entity && bot.entity.position;
    if (!q || q.y > targetY + 6) {
      const reason = (d && d.reason) || 'descent';
      if (isWaterFailReason(reason)) {
        _drownedSites = noteDrownedSite(_drownedSites, start, Date.now());
        emit({ type: 'lj_mine_drowned', x: Math.round(start.x), z: Math.round(start.z), reason });
      }
      return { ok: false, reason };
    }
  }
  return branchMine(bot, {
    torchEvery: TORCH_EVERY, onSurvivalTick: branchSurvivalTick, survivalEvery: 4,
    onNoPickaxe: () => rebuildPickHere('lj_mine'),
    targetY: Math.floor(bot.entity.position.y), mainLength: 24, branchSpacing: 3, branchLength: 6,
    serpentine: true, allowDeeper: true, stopOre: { items: ['raw_iron'], count: 8 },
  }, taskToken);
}

/** Fin de tranche 'mine' : lingots du four de mine, puis retour au coin de coupe. Jamais de throw. */
async function ljMineReturn() {
  try { await finishFurnaceJob('lj_mine', 60000); } catch (e) { /* best-effort */ }
  try {
    const p = bot.entity && bot.entity.position;
    if (p && homewarp.goHome(bot, HOME_WORK, { ctx: 'lj_mine_return' })) {
      emit({ type: 'work_return', ctx: 'lj_mine', x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) });
      await awaitWarp({ maxMs: 8000 });
    }
  } catch (e) { /* best-effort */ }
}

/** Grappe de fer exposé connue (même source que le but iron_cave). Jamais de throw. */
function _ljCaveAvailable() {
  try { return !!ironCaveCtx(); } catch (e) { return false; }
}

async function ljIronSlice(act, gen) {
  _ljIronSliceAt = Date.now();
  const _gen = gen != null ? gen : _lifeGen;   // vie du lancement (cf. _lifeGen)
  const parent = taskToken;
  let stop = false;
  let why = null;
  const slice = {
    get cancelled() { return stop || !!(parent && parent.cancelled) || lifeStale(_gen); },
    set cancelled(v) { if (v) stop = true; },
  };
  const count = (name) => ((bot.inventory && bot.inventory.items()) || [])
    .reduce((s, i) => s + (i && i.name === name ? i.count : 0), 0);
  const t0 = Date.now();
  const raw0 = count('raw_iron');
  const ing0 = count('iron_ingot');
  emit({ type: 'lj_iron_slice', phase: 'start', act });
  taskToken = slice;
  const watch = setInterval(() => {
    if (stop) return;
    if (Date.now() - t0 >= LJ_IRON_SLICE_MS) why = 'slice_time';
    else if (Date.now() - _ljAt >= LJ_CACHE_MS && _ljContext()) why = 'wood_request';
    else return;
    stop = true;
    try { stopMotion(); } catch (e) {}
  }, 2000);
  let r = null;
  try {
    if (act === 'smelt') {
      if (count('furnace') < 1) {
        const rf = await craftSmart({ name: 'furnace', count: 1 });
        if (!(rf && rf.ok)) r = { ok: false, reason: 'no_furnace' };
      }
      if (!r && !slice.cancelled) r = await smeltWithFurnace('raw_iron', 'iron_ingot', count('raw_iron'));
    } else if (act === 'mine') {
      r = await ljMineSlice();
    } else {
      r = await runCaveIron();
    }
  } catch (e) {
    r = { ok: false, reason: 'error' };
  } finally {
    clearInterval(watch);
    if (taskToken === slice) taskToken = parent;      // une préemption (migration) a pu le remplacer
    // Four de mine ramassé, puis /home work (coin de coupe) — jamais pour une vie finie : ce serait un TP
    // depuis le point de réapparition vers le chantier (vu après mort : `work_return ctx:lj_mine`).
    if (act === 'mine' && !lifeStale(_gen)) await ljMineReturn();
    else if (act === 'mine') dropStaleTask('lj_mine_return', _gen);
    _ljIronSliceAt = Date.now();                       // le répit anti boucle chaude part de la FIN
  }
  const _end = { ok: !!(r && r.ok), reason: why || (r && r.reason) || null,
    raw: count('raw_iron') - raw0, ingots: count('iron_ingot') - ing0 };
  if (parent && parent.cancelled && !_end.reason) _end.reason = 'cancelled';
  _ljSliceFails = ljSliceFailsAfter(_ljSliceFails, _end);
  emit({ type: 'lj_iron_slice', phase: 'end', act, ok: _end.ok, reason: _end.reason, raw: _end.raw, ingots: _end.ingots,
    took_s: Math.round((Date.now() - t0) / 1000), fails: _ljSliceFails, retry_s: Math.round(ljSliceRetryMs(_ljSliceFails) / 1000) });
  if (parent && parent.cancelled) return { ok: false, reason: 'cancelled' };
  // Rien n'est un échec du rôle : le planner re-dérive (une demande de bois passe en tête de chaîne).
  return { ok: true };
}

/**
 * Bascule d'objectif (devenir bûcheron / rendre le rôle). Préempte le planner comme migrateZone :
 * jeton CAPTURÉ, attente que le skill en vol rende la main, puis relance de startAutonomous.
 * Jamais par-dessus un ordre joueur, une migration ou un bot sans planner autonome.
 */
async function switchLumberjack(toLumberjack, why) {
  // Refus MOTIVÉ et visible (22/10, NethBot1 session 239 : bûcheron vidé resté bûcheron 6 min, refus
  // silencieux pendant une migration). Cf. lumberjack.ljSwitchBlock pour qui est préempté.
  const active = taskCtl.active;
  const block = ljSwitchBlock({ active, migrating: _migrating, switching: _ljSwitching,
    inProgress: !!(world.objective && world.objective.status === 'in_progress') });
  if (block) {
    if (block !== 'switching') {
      _ljEmit('lumberjack_switch_refused',
        { why: block, active: active || null, to: toLumberjack ? 'lumberjack' : 'resign', reason: why }, 60000);
    }
    return false;
  }
  _ljSwitching = true;
  try {
    const from = world.objective.type;
    const tok = taskCtl.begin('lumberjack_switch', stopMotion);
    const w0 = Date.now();
    while ((_skillInFlight > 0 || _autoRunners > 0) && !tok.cancelled && Date.now() - w0 < MIGRATION_PREEMPT_WAIT_MS) {
      await sleep(250);
    }
    if (tok.cancelled) {
      _ljEmit('lumberjack_switch_refused',
        { why: 'preempted', active: taskCtl.active || null, to: toLumberjack ? 'lumberjack' : 'resign', reason: why });
      return false;
    }
    taskToken = tok;
    const st = Object.assign({}, loadBaseState() || {});
    let to;
    if (toLumberjack) {
      to = 'lumberjack';
      if (from !== 'lumberjack') st.lumberjackPrev = from;   // l'objectif à reprendre si on rend le rôle
      saveBaseState(st);
      if (_woodReq) setWoodRequest(null);                    // le bûcheron ne se demande rien à lui-même
    } else {
      // Rôle rendu pour cause d'armure incomplète (usure/perte) : on REFORGE d'abord — la chaîne
      // iron_armor rend la main à la suite (iron_help → mapper_armor → diamant) une fois 4/4.
      // Phase diamant (24/10) : le rôle est FINI, on part miner les 3 piles (pas l'objectif d'avant).
      to = why === 'unarmored' ? 'iron_armor' : (why === 'team_diamond' ? 'diamond' : (st.lumberjackPrev || 'iron_armor'));
      _ljResignCleanup();
    }
    setObjective(world, { type: to, status: 'in_progress' });
    saveWorld(worldFile, world);
    emit({ type: toLumberjack ? 'lumberjack_elected' : 'lumberjack_resigned', from, to, why });
    // Le bûcheron travaille en SURFACE : s'il était au fond, il rentre à la base (même voie que la
    // remontée de migration : `/home safe`, pas la pioche).
    if (toLumberjack) {
      const p = bot.entity && bot.entity.position;
      if (p && p.y < SAFE_HOME_MIN_Y) { try { await safeWarpHome(HOME_SAFE, { ctx: 'lumberjack_surface' }); } catch (e) {} }
    }
    try { if (_beatNow) _beatNow(); } catch (e) {}
    if (tok.cancelled) return false;
    startAutonomous(null).catch((e) => emit({ type: 'error', message: String((e && e.message) || e) }));
    return true;
  } finally { _ljSwitching = false; }
}

/** Rôle rendu : oublie l'objectif d'avant (mémo FUSIONNÉ), le spot de coupe, la livraison et le cadeau
 *  réservés. Partagé par switchLumberjack et startAutonomous (régression au démarrage, objectiveForStart). */
function _ljResignCleanup() {
  const st = Object.assign({}, loadBaseState() || {});
  delete st.lumberjackPrev;
  saveBaseState(st);
  _workSet = false;                                          // `work` pointe le spot de coupe, pas une mine
  if (_ljTarget) { try { if (_teamClaims) _teamClaims.release('wood:' + _ljTarget.to); } catch (e) {} _ljTarget = null; }
  _ljReleaseGift();                                          // le cartographe réservé redevient libre pour les ouvriers
}

// ── PHASE D'ÉQUIPE (Massii 24/10) ────────────────────────────────────────────────────────────────
// miners_armor → mappers_armor → diamond (teamwork.teamPhase, pur). Tick 60 s : `team_phase` émis au
// changement, `diamond_progress {have, target}` toutes les 2 min sur l'objectif diamant, et le RETOUR
// diamant → mapper_armor : la chaîne diamant ne « finit » jamais (192), donc sans ce tick un mineur parti
// au diamant pendant qu'un coéquipier tenait la réservation du cartographe ne revenait jamais l'armer
// (vécu 23-24/10 : bûcheron seul à livrer, bottes + casque, mineurs au diamant).
// ⚠️ NIVEAU MODULE (piège #56) : variables lues par le timer.
const TEAM_PHASE_TICK_MS = 60000;
const DIAMOND_PROGRESS_EVERY_MS = 120000;
const TEAM_SWITCH_COOLDOWN_MS = 180000;   // anti va-et-vient diamant ↔ mapper_armor
let _teamPhaseLast = null;
// CLIQUET (fix 24/10 soir, teamwork.latchedTeamPhase) : {at} — une fois `diamond` atteint la phase ne
// redescend plus à cause de l'usure. Persisté dans le mémo base `teamLatch: {at, last}` (survit au
// respawn : pas de `team_phase from:null` à chaque process), propagé par le heartbeat (`phaseLatched`).
let _teamLatch = null;
let _teamLatchLoaded = false;
// DÉTOUR FER D'UN MINEUR NU (diamondPhase.latchedMinerObjective) : début du dernier détour, persisté dans le
// mémo base `ironDetour: {at}` (le self-healing relance le bot à chaque mort). NIVEAU MODULE (#56).
let _ironDetourAt = null;
let _ironDetourLoaded = false;
// Récolte de fer `not_found` (fenêtre 10 min, diamondPhase.ironGatherPlan). NIVEAU MODULE.
let _ironGatherFails = [];
// PIOCHE DIAMANT (goals.wantsDiamondPick) : diamants dépensés en pioches + amélioration fer→diamant déjà
// faite, persistés dans le mémo base `diamondPick: {spent, upgraded}`. NIVEAU MODULE (#56).
let _diaPick = null;
let _diamondProgressAt = 0;
let _teamSwitchAt = 0;
let _objSwitching = false;

/** Bascule d'objectif PRÉEMPTANTE (même mécanique que switchLumberjack). true si faite. */
async function switchObjective(to, why) {
  const active = taskCtl.active;
  const block = ljSwitchBlock({ active, migrating: _migrating, switching: _ljSwitching || _objSwitching,
    inProgress: !!(world.objective && world.objective.status === 'in_progress') });
  if (block) { emit({ type: 'objective_switch_refused', to, why, block, active: active || null }); return false; }
  _objSwitching = true;
  try {
    const from = world.objective.type;
    const tok = taskCtl.begin('objective_switch', stopMotion);
    const w0 = Date.now();
    while ((_skillInFlight > 0 || _autoRunners > 0) && !tok.cancelled && Date.now() - w0 < MIGRATION_PREEMPT_WAIT_MS) {
      await sleep(250);
    }
    if (tok.cancelled) { emit({ type: 'objective_switch_refused', to, why, block: 'preempted' }); return false; }
    taskToken = tok;
    setObjective(world, { type: to, status: 'in_progress' });
    saveWorld(worldFile, world);
    emit({ type: 'objective_switch', from, to, why });
    startAutonomous(null).catch((e) => emit({ type: 'error', message: String((e && e.message) || e) }));
    return true;
  } finally { _objSwitching = false; }
}

/** Début du détour fer en cours/récent (mémo base, relu une fois par process). */
function _loadIronDetour() {
  if (_ironDetourLoaded) return _ironDetourAt;
  _ironDetourLoaded = true;
  try {
    const d = (loadBaseState() || {}).ironDetour;
    const at = d ? Number(d.at) : NaN;
    if (Number.isFinite(at)) _ironDetourAt = at;
  } catch (e) { /* best-effort */ }
  return _ironDetourAt;
}

/** Pose le début du détour (null = aucun) et le persiste (mémo FUSIONNÉ, piège #73d). */
function _setIronDetour(at) {
  const v = Number.isFinite(at) ? at : null;
  _ironDetourLoaded = true;
  if (v === _ironDetourAt) return;
  _ironDetourAt = v;
  try {
    const st = Object.assign({}, loadBaseState() || {});
    st.ironDetour = { at: v };
    saveBaseState(st);
  } catch (e) { /* best-effort */ }
}

/** État pioche diamant {spent, upgraded} (mémo base, relu une fois par process). */
function _diaPickState() {
  if (_diaPick) return _diaPick;
  _diaPick = { spent: 0, upgraded: false, armor: 0 };
  try {
    const d = (loadBaseState() || {}).diamondPick;
    // `armor` (24/10 soir) = la part de `spent` passée en armure diamant (suivi), `spent` reste le TOTAL.
    if (d) _diaPick = { spent: Math.max(0, Number(d.spent) || 0), upgraded: !!d.upgraded, armor: Math.max(0, Number(d.armor) || 0) };
  } catch (e) { /* best-effort */ }
  return _diaPick;
}

/** Persiste l'état pioche/armure diamant (mémo FUSIONNÉ, piège #73d). */
function _saveDiaPick() {
  try { const b = Object.assign({}, loadBaseState() || {}); b.diamondPick = _diaPick; saveBaseState(b); } catch (e) { /* best-effort */ }
}

/** Pièces d'armure SAINES en poche (noms). */
function _pocketArmorGood() {
  const out = [];
  for (const it of (bot && bot.inventory && bot.inventory.items()) || []) {
    if (!it || !it.name || !/_(helmet|chestplate|leggings|boots)$/.test(it.name)) continue;
    if (!isNearlyBroken(it)) out.push(it.name);
  }
  return out;
}

/** Épées SAINES en poche (noms, main comprise : la main est un slot de l'inventaire). */
function _swordsGood() {
  const out = [];
  for (const it of (bot && bot.inventory && bot.inventory.items()) || []) {
    if (!it || !it.name || !/_sword$/.test(it.name)) continue;
    if (!isNearlyBroken(it)) out.push(it.name);
  }
  return out;
}

/** But `sword` (sword.js) : craft de l'épée (diamant / fer / pierre) + mise en main hors minage.
 *  Diamants dépensés → `diamond_progress.spent` (comme la pioche et l'armure diamant). Event `sword_crafted`. */
async function craftSwordGoal() {
  const ctx = Object.assign({ inv: buildCtxInv(bot) }, ctxExtra());
  const plan = swordPlanOf(ctx);
  if (!plan) return { ok: true };                                 // plus rien à faire (état changé)
  const inv0 = buildCtxInv(bot);
  const r = await craftSmart({ name: plan.name, count: 1 });
  const inv1 = buildCtxInv(bot);
  if ((inv1[plan.name] || 0) <= (inv0[plan.name] || 0)) {
    return (r && r.ok === false) ? r : { ok: false, reason: 'craft_no_effect' };
  }
  const used = Math.max(0, (inv0.diamond || 0) - (inv1.diamond || 0));
  if (used > 0) {
    const st = _diaPickState();
    _diaPick = { spent: st.spent + used, upgraded: st.upgraded, armor: st.armor || 0 };
    _saveDiaPick();
  }
  // En main tout de suite si rien ne se mine (un dig en cours garde son outil — l'aura ressortira l'épée).
  try {
    if (!bot.targetDigBlock) {
      const it = ((bot.inventory && bot.inventory.items()) || []).find((i) => i.name === plan.name);
      if (it) await bot.equip(it, 'hand');
    }
  } catch (e) { /* best-effort */ }
  emit({ type: 'sword_crafted', tier: plan.tier, used, upgrade: !!plan.upgrade,
    spent: used > 0 ? _diaPick.spent : undefined, have: inv1.diamond || 0 });
  return { ok: true };
}

/** But `dia_armor` : enfile une pièce diamant saine de la poche, ou forge la suivante (ordre plastron →
 *  jambières → casque → bottes, cf. diaArmor.js) et l'enfile. Diamants dépensés → `spent` (+ `armor`). */
async function craftDiamondArmorPiece() {
  const ctx = Object.assign({ inv: buildCtxInv(bot) }, ctxExtra());
  const plan = diamondArmorPlanOf(ctx);
  if (!plan) return { ok: true };                                 // plus rien à faire (état changé)
  const dest = ARMOR_SLOTS[plan.slot];
  const equipGood = async (name) => {
    const it = ((bot.inventory && bot.inventory.items()) || []).find((i) => i.name === name && !isNearlyBroken(i));
    if (!it) return false;
    try { await bot.equip(it, dest); } catch (e) {
      emit({ type: 'diamond_armor_equip_failed', item: name, reason: String((e && e.message) || e).slice(0, 80) });
      return false;
    }
    return _wornArmor().has(name);
  };
  if (plan.act === 'equip') {
    const ok = await equipGood(plan.name);
    if (ok) emit({ type: 'diamond_armor_equipped', item: plan.name, worn: diaWornCount([..._wornArmor()]) });
    return ok ? { ok: true } : { ok: false, reason: 'equip_failed' };
  }
  const inv0 = buildCtxInv(bot);
  const r = await craftSmart({ name: plan.name, count: 1 });
  const inv1 = buildCtxInv(bot);
  if ((inv1[plan.name] || 0) <= (inv0[plan.name] || 0)) {
    return (r && r.ok === false) ? r : { ok: false, reason: 'craft_no_effect' };
  }
  const used = Math.max(0, (inv0.diamond || 0) - (inv1.diamond || 0));
  _noteArmorCraft(plan.slot);   // jamais deux fois la même pièce en 10 min (armorWear)
  const st = _diaPickState();
  _diaPick = { spent: st.spent + used, upgraded: st.upgraded, armor: (st.armor || 0) + used };
  _saveDiaPick();
  // Le fer remplacé atterrit dans la poche (échange de slot) : rechange, ou don à un cartographe nu.
  await equipGood(plan.name);
  const worn = diaWornCount([..._wornArmor()]);
  emit({ type: 'diamond_armor_crafted', item: plan.name, used, worn, spent: _diaPick.spent,
    armorDiamonds: _diaPick.armor, have: inv1.diamond || 0 });
  return { ok: true };
}

/** But `dia_pick` : craft de la pioche diamant + comptabilité des 3 diamants (progression). */
async function craftDiamondPick(goal) {
  const inv0 = buildCtxInv(bot);
  const hadIron = (inv0.iron_pickaxe || 0) >= 1;
  const r = await craftSmart(goal.args);
  const inv1 = buildCtxInv(bot);
  if ((inv1.diamond_pickaxe || 0) > (inv0.diamond_pickaxe || 0)) {
    const used = Math.max(0, (inv0.diamond || 0) - (inv1.diamond || 0));
    const st = _diaPickState();
    _diaPick = { spent: st.spent + used, upgraded: st.upgraded || hadIron, armor: st.armor || 0 };
    _saveDiaPick();
    emit({ type: 'diamond_pick_crafted', used, had_iron_pick: hadIron, spent: _diaPick.spent, have: inv1.diamond || 0 });
    return { ok: true };
  }
  return (r && r.ok === false) ? r : { ok: false, reason: 'craft_no_effect' };
}

/** Ce mineur peut-il céder son ancienne armure de fer (diaArmor.isIronDonor) ? */
function _ironDonorNow(diamonds) {
  return isIronDonor({ diaWorn: diaWornCount([..._wornArmor()]), diamonds, spareIron: _giftPocket().good.length });
}

/** Décision cliquet pour CE bot (null = pas concernée). Ne touche à rien. */
function latchedObjectiveNow(objective, fromSpawn) {
  let latched = false;
  try { latched = _teamLatchActive(); } catch (e) { latched = false; }
  if (!latched) return null;
  let worn = 0;
  try { worn = wornIronCount([..._wornArmor()]); } catch (e) { worn = 0; }
  return latchedMinerObjective({ objective, latched, isMapper: !!IS_MAPPER, worn,
    detourAt: _loadIronDetour(), now: Date.now(), fromSpawn: !!fromSpawn });
}

/** Relit le cliquet du mémo base (une fois par process). */
function _loadTeamLatch() {
  if (_teamLatchLoaded) return;
  _teamLatchLoaded = true;
  try {
    const tl = (loadBaseState() || {}).teamLatch;
    if (tl && Number.isFinite(Number(tl.at)) && tl.at !== null) _teamLatch = { at: Number(tl.at) };
    if (_teamPhaseLast === null && tl && typeof tl.last === 'string') _teamPhaseLast = tl.last;
  } catch (e) { /* best-effort */ }
}

/** Cliquet actif (non périmé) — lu par le heartbeat et _giftContext. */
function _teamLatchActive() {
  _loadTeamLatch();
  if (!_teamLatch || !Number.isFinite(_teamLatch.at)) return false;
  const age = Date.now() - _teamLatch.at;
  return age >= 0 && age <= TEAM_LATCH_STALE_MS;
}

/** Mémo base FUSIONNÉ (piège #73d) : {at, last}. */
function _saveTeamLatch() {
  try {
    const st = Object.assign({}, loadBaseState() || {});
    st.teamLatch = { at: _teamLatch ? _teamLatch.at : null, last: _teamPhaseLast };
    saveBaseState(st);
  } catch (e) { /* best-effort */ }
}

/** Phase EFFECTIVE (brute + cliquet). Met à jour `_teamLatch` ; la persistance est faite par le tick. */
function currentTeamPhase(mates, selfWorn, now) {
  _loadTeamLatch();
  const selfRole = IS_MAPPER ? 'mapper' : 'worker';
  const raw = teamPhase({ selfName: bot.username, selfRole, selfWorn, mates, now });
  const eff = latchedTeamPhase({ raw, latch: _teamLatch, mates, selfName: bot.username, selfRole, selfWorn, now });
  _teamLatch = eff.latch;
  return Object.assign({}, raw, eff);
}

async function teamPhaseTick() {
  if (!presence || !bot || !bot.entity) return null;
  const now = Date.now();
  let mates = [];
  try { mates = presence.list(); } catch (e) { mates = []; }
  const selfWorn = wornIronCount([..._wornArmor()]);
  const ph = currentTeamPhase(mates, selfWorn, now);
  if (ph.phase !== _teamPhaseLast) {          // VRAI changement seulement (le dernier est persisté)
    emit({ type: 'team_phase', phase: ph.phase, from: _teamPhaseLast, raw: ph.raw, latched: ph.latched,
      miners: ph.minersArmored + '/' + ph.miners, mappers: ph.mappersServed + '/' + ph.mappers });
    _teamPhaseLast = ph.phase;
  }
  _saveTeamLatch();
  let objT = world.objective && world.objective.type;
  // CLIQUET DIAMANT : un mineur sous le cliquet est au diamant (iron_armor/iron_help re-seedés au respawn,
  // pièces usées) — sauf détour fer borné s'il est vraiment nu ; détour fini ou ≥ 2 pièces → diamant.
  if (!IS_MAPPER && ph.latched && world.objective && world.objective.status === 'in_progress'
      && (objT === 'diamond' || objT === 'iron_armor' || objT === 'iron_help')) {
    const lat = latchedObjectiveNow(objT, false);
    if (lat && lat.objective !== objT) {
      const ok = await switchObjective(lat.objective, 'latched_' + lat.why);
      if (ok) {
        _setIronDetour(lat.detourAt);
        emit({ type: 'objective_latched', from: objT, to: lat.objective, why: lat.why, worn: selfWorn, at: 'tick' });
        objT = lat.objective;
      }
    }
  }
  if (objT === 'diamond' && now - _diamondProgressAt >= DIAMOND_PROGRESS_EVERY_MS) {
    _diamondProgressAt = now;
    const _have = buildCtxInv(bot).diamond || 0;
    let _spent = 0, _armorDia = 0;
    try { _spent = _diaPickState().spent; _armorDia = _diaPickState().armor || 0; } catch (e) { _spent = 0; _armorDia = 0; }
    // have = en poche (l'objectif) ; spent = dépensés (pioches + armure) ; mined = have + spent (tout ce
    // qui a été miné) ; armorDiamonds = la part de spent passée en armure diamant.
    emit({ type: 'diamond_progress', have: _have, target: diamondTargetOf(world.objective), spent: _spent,
      mined: _have + _spent, armorDiamonds: _armorDia });
  }
  if (IS_MAPPER || objT !== 'diamond') return ph.phase;
  // Cliquet posé : seul un cartographe VRAIMENT nu rappelle un mineur ; une pièce usée ne rappelle personne.
  const wantArm = ph.latched ? !!ph.nakedMapper : ph.phase === 'mappers_armor';
  if (!wantArm) return ph.phase;
  if (now - _teamSwitchAt < TEAM_SWITCH_COOLDOWN_MS) return ph.phase;
  if (!isAllowed('/tpa x', whitelist)) return ph.phase;        // personne ne peut être servi
  // UN mineur, celui qui a le MOINS de diamants (le meilleur n'est jamais détourné).
  let selfDia = 0;
  try { selfDia = buildCtxInv(bot).diamond || 0; } catch (e) { selfDia = 0; }
  let selfDonor = false;
  try { selfDonor = _ironDonorNow(selfDia); } catch (e) { selfDonor = false; }
  // Pièces de fer SAINES en poche (24/10) : celui qui peut DONNER passe avant celui qui irait miner.
  let selfSpare = 0;
  try { selfSpare = _giftPocket().good.length; } catch (e) { selfSpare = 0; }
  if (pickDivertedMiner({ selfName: bot.username, selfDiamonds: selfDia, selfWorn, selfDonor, selfSpare, mates, now }) !== bot.username) return ph.phase;
  const target = freshGiftTarget();                             // 4/4 soi-même + réservation `marmor:`
  if (!target) return ph.phase;
  _teamSwitchAt = now;
  const ok = await switchObjective('mapper_armor', 'team_mappers_armor');
  if (!ok) releaseGiftTarget(target);
  else emit({ type: 'team_mapper_armor_return', to: target, naked: ph.nakedMapper || null, diamonds: selfDia });
  return ph.phase;
}

/** Tick d'élection (30 s). Rend le verdict (pour les tests / l'observation). */
async function lumberjackTick() {
  if (IS_MAPPER || !presence || !_teamClaims || _ljSwitching) return null;
  if (!isAllowed('/tpa x', whitelist)) return null;           // sans /tpa, aucune livraison possible
  if (!(world.objective && world.objective.status === 'in_progress')) return null;
  const amLj = isLumberjackObjective();
  // Un bot en mode quota (`resource`) n'a pas de planner à chaînes : il ne devient pas bûcheron.
  if (!amLj && world.objective.type === 'resource') return null;
  const now = Date.now();
  let selfArmor = 0;
  let selfWorn = 0;
  try {
    const worn = [..._wornArmor()];
    selfArmor = teamStatus(buildCtxInv(bot), worn).armor;
    selfWorn = wornIronCount(worn);
  } catch (e) { selfArmor = 0; selfWorn = 0; }
  // ÉLIGIBILITÉ (21/10) : bûcheron = armure de fer 4/4 PORTÉE, sinon pas de rôle (cf. lumberjack.js).
  const selfEligible = selfWorn >= LUMBERJACK_MIN_WORN;
  let mates = [];
  try { mates = presence.list(); } catch (e) { mates = []; }
  // PHASE DIAMANT (Massii 24/10) : mineurs + cartographes 4/4 portés → le bûcheron finit son stock puis
  // rend le rôle et part au diamant ; personne ne le reprend tant que la phase dure (lumberjack.js).
  let selfDiamonds = 0;
  try { selfDiamonds = buildCtxInv(bot).diamond || 0; } catch (e) { selfDiamonds = 0; }
  try {
    // Phase EFFECTIVE (cliquet 24/10 soir) : l'usure d'une pièce ne rouvre plus l'élection.
    const ph = currentTeamPhase(mates, selfWorn, now).phase;
    const ret = lumberjackRetireForDiamond({ phase: ph, amLumberjack: amLj, logs: logCount(buildCtxInv(bot)) });
    if (ret.retire) {
      try { _teamClaims.release(LJ_CLAIM); } catch (e) {}
      await switchLumberjack(false, 'team_diamond');
      return 'release';
    }
    if (ret.block && !amLj) return 'follower';
  } catch (e) { /* best-effort : élection historique */ }
  const preferred = preferredLumberjack({ selfName: bot.username, selfArmor, selfWorn, selfDiamonds, mates, now });
  const holder = _teamClaims.peek(LJ_CLAIM);
  const v = lumberjackVerdict({ selfName: bot.username, holder, preferred, amLumberjack: amLj, selfEligible });
  if (v === 'keep' || v === 'claim') {
    const ok = (v === 'keep' && _teamClaims.refresh(LJ_CLAIM)) || _teamClaims.tryClaim(LJ_CLAIM);
    if (ok && !amLj) await switchLumberjack(true, v === 'keep' ? 'claim_held' : 'elected');
    return v;
  }
  if (v === 'release') {
    try { _teamClaims.release(LJ_CLAIM); } catch (e) {}
    if (amLj) await switchLumberjack(false, selfEligible ? 'alone' : 'unarmored');
    return v;
  }
  if (amLj) await switchLumberjack(false, 'claim_lost');
  return v;
}

// ── ARMURE DU BÛCHERON (20/10 soir) ─────────────────────────────────────────────────────────────
// Mesure 1 h : cartographes nus = 20 morts sur 36 — le bûcheron élu (le mieux armé, celui qui forgeait
// leurs armures en mapper_armor) avait abandonné cette chaîne ; et l'usure l'avait fait passer de 4 à
// 2 pièces sans qu'il les refasse (`lumberjack` n'est pas dans le timer d'armure). Décisions pures dans
// lumberjack.js ; ici : contexte (SES pièces > un cartographe), réservation `marmor:` (la même que les
// ouvriers en mapper_armor : on ne forge jamais deux fois pour le même cartographe), skills.
const LJ_FORGE_HOLD_MS = 600000;     // forge/équipement raté → 10 min sans réessayer (pas de boucle)
const LJ_GIFT_FAIL_TTL_MS = 300000;  // /tpa raté vers un cartographe (destination dangereuse…) → 5 min
const _LJ_ARMOR_RE = /_(helmet|chestplate|leggings|boots)$/;
let _ljGift = null;                  // { to, armor, pieces, ingots } — cartographe RÉSERVÉ (`marmor:<to>`)
let _ljGiftAt = 0;
let _ljForgeHoldUntil = 0;
const _ljGiftFailed = new Map();     // nom → instant du /tpa raté
let _ljStockFails = [];              // instants des échecs `lj_stock` (persistés : survivent aux morts)
let _ljStockFailsLoaded = false;
let _ljNotFound = [];                // instants des `lj_stock not_found` (persistés) → migration bois au 3ᵉ (23/10)

/** Poche : pièces d'armure SAINES / USÉES (noms), lingots, tous les noms. */
function _ljPocketArmor() {
  const good = [], broken = [], names = [];
  let ingots = 0;
  for (const it of (bot.inventory && bot.inventory.items()) || []) {
    if (!it || !it.name) continue;
    names.push(it.name);
    if (it.name === 'iron_ingot') ingots += it.count || 0;
    if (_LJ_ARMOR_RE.test(it.name)) (isNearlyBroken(it) ? broken : good).push(it.name);
  }
  return { good, broken, names, ingots };
}

function _ljReleaseGift() {
  if (_ljGift) { try { releaseGiftTarget(_ljGift.to); } catch (e) { /* best-effort */ } }
  _ljGift = null;
}

/**
 * Contexte armure du bûcheron : { own, gift }. `own` = ownArmorAction (prime sur tout : un bûcheron nu
 * meurt et ne livre plus rien) ; `gift` = { to, pieces, ready } pour gift_craft/gift_deliver.
 * Le choix du cartographe est mis en cache 15 s (presence.list() prend un verrou) ; `ready` est relu.
 */
function _ljArmorContext() {
  const none = { own: null, gift: null };
  try {
    const now = Date.now();
    if (now < _ljForgeHoldUntil) { _ljReleaseGift(); return none; }
    const pk = _ljPocketArmor();
    const own = ownArmorAction({ worn: [..._wornArmor()], pocket: pk.good, ingots: pk.ingots });
    if (own) { _ljReleaseGift(); return { own, gift: null }; }
    if (!presence || !isAllowed('/tpa x', whitelist)) { _ljReleaseGift(); return none; }
    if (now - _ljGiftAt >= GIFT_CACHE_MS) {
      _ljGiftAt = now;
      for (const [n, at] of _giftDone) { if (now - at > GIFT_DONE_TTL_MS) _giftDone.delete(n); }
      for (const [n, at] of _ljGiftFailed) { if (now - at > LJ_GIFT_FAIL_TTL_MS) _ljGiftFailed.delete(n); }
      const mates = presence.list();
      const skip = new Set([..._giftDone.keys(), ..._ljGiftFailed.keys()]);
      let pick = null;
      // MINEURS D'ABORD (23/10) : un mineur < 4 pièces portées passe avant tout cartographe, et bloque
      // les cartographes même quand on ne peut pas encore le servir (cf. lumberjack.pickArmorTargetForLumberjack).
      for (let i = 0; i < 6; i++) {                  // descend la liste des cibles déjà réservées
        const p = pickArmorTargetForLumberjack({ mates, selfName: bot.username, now, ingots: pk.ingots,
          pocket: pk.good, brokenPocket: pk.broken, skip });
        if (!p) break;
        if (!_teamClaims || _teamClaims.tryClaim('marmor:' + p.to)) { pick = p; break; }
        skip.add(p.to);
      }
      if (!pick) _ljReleaseGift();
      else {
        if (_ljGift && _ljGift.to !== pick.to) _ljReleaseGift();
        _ljGift = pick;
      }
    }
    if (!_ljGift) return none;
    _giftTarget = _ljGift.to;                        // deliverMapperArmor (réutilisé) lit _giftTarget
    return { own: null, gift: { to: _ljGift.to, pieces: _ljGift.pieces.slice(), ready: ljGiftReady(_ljGift.pieces, pk.good) } };
  } catch (e) { return none; }
}

/** Pièces à remettre à `to` : le plan partiel du bûcheron, sinon null (le set complet historique). */
function ljGiftPiecesFor(to) {
  return (isLumberjackObjective() && _ljGift && _ljGift.to === to) ? _ljGift.pieces.slice() : null;
}

/** Après une livraison (ou un /tpa raté) vers `to` : on oublie le plan ; un échec écarte `to` 5 min. */
function ljAfterGift(to, given) {
  if (!isLumberjackObjective()) return;
  if (!(given > 0)) _ljGiftFailed.set(to, Date.now());
  if (_ljGift && _ljGift.to === to) _ljGift = null;
  _ljGiftAt = 0;
}

/** Jette les pièces d'armure USÉES de la poche (sorties de leur slot au remplacement) : elles fausseraient
 *  le plan de forge (armorPlan les voit « en poche ») et partiraient avec un don (giveItem jette tout le nom). */
async function _ljTossWornArmor() {
  for (const it of ((bot.inventory && bot.inventory.items()) || []).slice()) {
    if (!it || !it.name || !_LJ_ARMOR_RE.test(it.name) || !isNearlyBroken(it)) continue;
    try { await bot.tossStack(it); emit({ type: 'armor_worn_tossed', item: it.name }); } catch (e) { /* suivant */ }
  }
}

/** Skill `lumberjackArmor` : enfiler / forger SA pièce manquante (ensureArmor, jugé sur le progrès). */
async function lumberjackArmorSkill() {
  const ctx = _ljArmorContext();
  if (!ctx.own) return { ok: true };
  await _ljTossWornArmor();
  const r = await runGoalSkill({ name: 'lj_own_armor', skill: 'ensureArmor', args: {} });
  const ok = !!(r && r.ok);
  emit({ type: 'lumberjack_armor', act: ctx.own.act, piece: ctx.own.piece, ok });
  if (!ok) _ljForgeHoldUntil = Date.now() + LJ_FORGE_HOLD_MS;
  return r || { ok: false, reason: 'error' };
}

/** craftGiftSet du bûcheron : forge les pièces PRÉVUES qui ne sont pas encore en poche. */
async function ljCraftGiftSkill() {
  const g = _ljGift;
  if (!g) return { ok: true };
  await _ljTossWornArmor();
  const have = new Set(_ljPocketArmor().good);
  let progressed = false;
  for (const piece of g.pieces) {
    if (have.has(piece)) continue;
    const r = await craftSmart({ name: piece, count: 1 });
    if (r && r.ok) { progressed = true; emit({ type: 'gift_craft', item: piece, to: g.to, by: 'lumberjack', role: g.role || null }); }
  }
  if (!progressed && !ljGiftReady(g.pieces, _ljPocketArmor().good)) {
    _ljForgeHoldUntil = Date.now() + LJ_FORGE_HOLD_MS;
    _ljReleaseGift();
    return { ok: false, reason: 'gift_craft_failed' };
  }
  return { ok: true };
}

/** craftGiftSet d'un LOT (20/10) : forge les pièces du lot pas encore en poche. Rend la raison du craft
 *  (ex. `no_table:unknown_item`) : c'est elle qui déclenche la demande de bois si la table manque. */
async function giftBatchCraftSkill() {
  const b = _giftBatch;
  if (!b) return { ok: true };
  const have = new Set(_giftPocket().good);
  let progressed = false;
  let lastReason = null;
  for (const piece of b.pieces) {
    if (have.has(piece)) continue;
    const r = await craftSmart({ name: piece, count: 1 });
    if (r && r.ok) { progressed = true; emit({ type: 'gift_craft', item: piece, to: b.to, batch: true }); }
    else lastReason = (r && r.reason) || lastReason;
  }
  if (progressed || ljGiftReady(b.pieces, _giftPocket().good)) return { ok: true };
  return { ok: false, reason: 'gift_batch_craft:' + (lastReason || 'failed') };
}

// ── EXPÉDITION FORESTIÈRE DU BÛCHERON (20/10 soir) ──────────────────────────────────────────────
// Mesure : `lj_stock` timeout ×6, `logs not_found` ×10, 19 `unstuck` sur une session — il s'acharnait
// sur le même coin (bouleaux géants dont le haut est hors d'atteinte). Au 2e échec en 10 min il marche
// vers la forêt CONNUE la plus proche (même marche par jambes que l'expédition vers le gibier, et même
// verrou `_foodTripBusy` : le confine et le squad ne le rappellent pas en route) et y pose `work`.
function _ljLoadStockFails() {
  if (_ljStockFailsLoaded) return;
  _ljStockFailsLoaded = true;
  try { _ljStockFails = stockFailsPrune((loadBaseState() || {}).ljStockFails, Date.now()); } catch (e) { _ljStockFails = []; }
  try { _ljNotFound = stockFailsPrune((loadBaseState() || {}).ljNotFound, Date.now()); } catch (e) { _ljNotFound = []; }
}
function _ljSaveStockFails() {
  try { saveBaseState(Object.assign({}, loadBaseState() || {}, { ljStockFails: _ljStockFails, ljNotFound: _ljNotFound })); } catch (e) { /* best-effort */ }
}

/** Appelé par le planner après chaque but raté : compte les échecs `lj_stock` (timeout / not_found). */
function noteLumberjackStockFail(goalName, reason) {
  if (goalName !== 'lj_stock' || (reason !== 'timeout' && reason !== 'not_found')) return;
  _ljLoadStockFails();
  _ljStockFails = stockFailsAdd(_ljStockFails, Date.now());
  // `not_found` compté À PART (23/10) : 3 en 10 min → migration bois vers une forêt connue (checkZoneVerdict).
  // L'expédition `lj_forest` consomme _ljStockFails ; ces instants-là, non.
  if (reason === 'not_found') _ljNotFound = stockFailsAdd(_ljNotFound, Date.now());
  _ljSaveStockFails();
  emit({ type: 'lumberjack_stock_fail', reason, fails: _ljStockFails.length });
}

/** ctx `ljForestTrip` : 2 échecs en 10 min et le stock n'est pas fait. */
function _ljForestNeeded() {
  try {
    _ljLoadStockFails();
    if (!needsForestTrip(_ljStockFails, Date.now())) return false;
    // Pas de marche de 120 s de nuit : la discipline de nuit possède la surface (les échecs restent comptés).
    if (bot.time && bot.time.timeOfDay != null && cautionNightNow()) return false;   // diamant complet : pas de nuit (freeRoam)
    return logCount(buildCtxInv(bot)) < LUMBERJACK_STOCK;
  } catch (e) { return false; }
}

/** Skill `lumberjackForestTrip` : marche bornée (120 s) vers la forêt connue la plus proche, puis `work`. */
async function lumberjackForestTripSkill() {
  const tok = taskToken;                             // CAPTURÉ (cf. huntCookGoal) : une migration ne nous le vole pas
  _ljLoadStockFails();                               // charge aussi _ljNotFound : la sauvegarde ci-dessous ne doit pas l'écraser
  _ljStockFails = [];                                // consommés : réussie ou non, on ne repart pas en boucle
  _ljStockFailsLoaded = true;
  _ljSaveStockFails();
  const p = bot.entity && bot.entity.position;
  if (!p) return { ok: true };
  const from = { x: p.x, z: p.z };                   // COPIE : entity.position est muté sur place
  const now = Date.now();
  const cells = loadWorldCells();
  const cell = pickForestCell({ from, anchor: currentAnchor(), biomes: cells.biomes, depleted: cells.depleted,
    avoid: (loadBaseState() || {}).ljForestTried, now });
  if (!cell) { emit({ type: 'lumberjack_forest_trip', to: null, dist: null, ok: false, reason: 'no_forest' }); return { ok: true }; }
  if (!foodTripLock()) { emit({ type: 'lumberjack_forest_trip', to: { x: cell.x, z: cell.z }, dist: cell.dist, ok: false, reason: 'busy' }); return { ok: true }; }
  let r = null;
  try { r = await foodTripWalk({ cell, ms: LJ_FOREST_TRIP_MS, token: tok }); } catch (e) { r = null; } finally { foodTripUnlock(); }
  const ok = !!(r && r.arrived);
  if (ok) bookmarkCuttingSpot('lumberjack_forest');  // le nouveau coin de coupe : on y revient après chaque livraison
  else {
    try {
      const st = loadBaseState() || {};
      saveBaseState(Object.assign({}, st, { ljForestTried: forestTriedAdd(st.ljForestTried, cell, Date.now()) }));
    } catch (e) { /* best-effort */ }
  }
  emit({ type: 'lumberjack_forest_trip', to: { x: cell.x, z: cell.z }, biome: cell.biome, dist: cell.dist, ok,
    moved: r ? r.moved : 0, legs: r ? r.legs : 0 });
  return { ok: true };
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

const RECLAIM_COLLECT_MS = 20000;   // borne d'une reprise (collectBlock) — niveau module

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
      // four perdu en boucle). collectBlock passe bien par mineflayer-tool (equipForBlock, cf. toolGuard.js) ;
      // on garde l'équipement explicite d'avant, il ne coûte rien.
      const tool = bestToolFor(bot, b);
      if (tool) { try { await bot.equip(tool, 'hand'); } catch (e) {} }
      // BORNÉ (22/10, NethBot3 session 246 : `crafting_table` timeout ×4 = 6 min) — collectBlock
      // pathfinde SANS limite vers un bloc hors d'atteinte (table 38 blocs plus haut) et gelait le but.
      const res = await withTimeout(bot.collectBlock.collect(b), RECLAIM_COLLECT_MS, () => {
        try { if (bot.collectBlock.cancelTask) bot.collectBlock.cancelTask(); } catch (e) {}
        try { stopMotion(); } catch (e) {}
      });
      if (res && res.ok === false) {
        if (res.reason === 'timeout') break;       // inatteignable : ne pas re-tenter à l'aveugle
        continue;
      }
      return;                                      // repris
    } catch (e) { /* retry une fois */ }
  }
  // Échec de reprise = un bloc ABANDONNÉ sur le terrain. C'était silencieux, donc invisible dans
  // les journaux : c'est ainsi qu'une vingtaine de tables se sont accumulées au spawn sans qu'aucun
  // event ne le signale. On l'émet désormais (le bot n'a rien de mieux à faire, mais on le SAIT).
  try { emit({ type: 'reclaim_failed', block: blockName, x: pos && pos.x, y: pos && pos.y, z: pos && pos.z }); } catch (e) {}
}

// TABLES INUTILISABLES — liste noire à OUBLI (30 min). Run du 17-18/08 (216 sessions) :
// `reclaim_failed` ×11 565 et `table_recycled` ×11 440, quasi 1:1. Une table INATTEIGNABLE (dans le
// tunnel/la grotte d'un autre, derrière un mur, au-dessus d'un vide) était re-vue à CHAQUE craft :
// marche de 30 s, reprise ratée, table neuve semée — puis rebelote au craft suivant, à l'infini
// (~30-60 s perdues par craft). Dès qu'on a la PREUVE qu'une table est inutilisable (on ne l'a pas
// atteinte / on n'a pas pu la reprendre), `withCraftingTable` ne la cherche plus. TTL fini : le
// terrain change (un coéquipier ouvre un passage, la table finit reprise par un autre).
// ⚠️ NIVEAU MODULE, comme `_smeltOppBusy`/`panicInFlight` : un état lu par plusieurs appels doit
// survivre à chacun (déclaré dans `onSpawn` = ReferenceError en prod alors que les tests passent,
// piège #56). Il survit aux respawns d'un même process, pas à un process neuf.
const _badTables = createExpiringSet({ ttlMs: 30 * 60 * 1000 });

// Garantit une table à portée le temps d'exécuter fn (un craft), puis reprend la table si on l'a posée.
// ⚠️ findBlock(6) > portée d'interaction (~4.5) : une table « proche » peut être INATTEIGNABLE (jungle :
// posée sous la canopée pendant que le bot est dans l'arbre) → on s'en APPROCHE d'abord ; si le craft
// échoue quand même, on pose une table portable en fallback (vu live MapT1 : stall wooden_pickaxe ×4).
/**
 * Table ABANDONNÉE en vue (≤ TABLE_SEEK, hors liste noire) : aller la REPRENDRE. Rend true/false = table
 * en poche après la tentative, null = aucune table candidate. `blacklist(pos, why)` marque une reprise
 * ratée. Partagé par withCraftingTable (branche `recycle`) et par le but `crafting_table` (21/10).
 */
async function recycleNearbyTable(blacklist) {
  const litter = _nearestTable(bot, TABLE_SEEK, { exclude: _badTables });
  if (!litter) return null;
  // Autre étage (22/10, NethBot3 : bot y 15-20, table abandonnée y 53) : aller la chercher = remonter
  // une colline de 38 blocs ou un autre tunnel. Liste noire (TTL 30 min) → fabrication sur place.
  if (!recycleWorthIt(bot.entity.position, litter.position)) {
    blacklist(litter.position, 'other_level');
    return null;
  }
  try {
    if (bot.entity.position.distanceTo(litter.position) > 3) {
      await withTimeout(
        bot.pathfinder.goto(new pfGoals.GoalNear(litter.position.x, litter.position.y, litter.position.z, 2)),
        30000, () => { try { stopMotion(); } catch (e) {} }
      );
    }
    // `withTimeout` RÉSOUT au timeout : seule la distance dit si on est arrivé. Pas arrivé → la reprise
    // (collectBlock) re-pathfinderait sans fin vers la même table : liste noire, pas de reprise.
    if (bot.entity.position.distanceTo(litter.position) > TABLE_REACH - 1) {
      blacklist(litter.position, 'unreachable');
      emit({ type: 'table_recycled', ok: false, why: 'unreachable' });
      return false;
    }
    await reclaimBlock(litter.position);
  } catch (e) { /* pas de chemin → on retombe sur la fabrication */ }
  // `reclaimBlock` ne LÈVE jamais (il avale ses échecs et n'émet que `reclaim_failed`) : le seul
  // moyen de savoir que la reprise a raté est de regarder si la table est TOUJOURS là. Si oui elle
  // est inutilisable (hors de portée, incassable…) → liste noire, sinon on la retenterait — 30 s de
  // marche + 2 reprises ratées — à chaque craft suivant.
  try {
    const left = bot.blockAt(litter.position);
    if (left && left.name === 'crafting_table') blacklist(litter.position, 'reclaim_failed');
  } catch (e) { /* best-effort */ }
  const ok = ((bot.inventory && bot.inventory.items()) || []).some((i) => i.name === 'crafting_table');
  emit({ type: 'table_recycled', ok });
  return ok;
}

/** Liste noire des tables inutilisables (un event par table). Niveau module : partagé. */
function blacklistBadTable(pos, why) {
  try {
    if (!pos || _badTables.has(tableKey(pos))) return;
    _badTables.add(tableKey(pos));
    emit({ type: 'table_blacklisted', why, x: pos.x, y: pos.y, z: pos.z });
  } catch (e) { /* best-effort : l'observabilité ne doit jamais casser un craft */ }
}

// ÉCHECS DE POSE PAR ENDROIT (22/10) — niveau module (piège #56) : survit d'un but au suivant, c'est
// précisément la boucle `spare_picks` → `no_space` → `spare_picks` qu'il doit casser.
const _noSpaceMemo = createNoSpaceMemo();
const STEP_ASIDE_GOTO_MS = 10000;

/** Se décaler de 2-4 blocs en ligne droite (tunnel : avancer ou reculer), bornée. true = déplacé. */
async function stepAsideForTable() {
  const tok = taskToken;
  let cells = [];
  try {
    const base = bot.entity.position.floored();
    cells = stepAsideCells(base, (x, y, z) => bot.blockAt(vec3Lib(x, y, z)));
  } catch (e) { cells = []; }
  for (const c of cells.slice(0, 3)) {
    if (tok && tok.cancelled) break;
    await withTimeout(bot.pathfinder.goto(new pfGoals.GoalBlock(c.x, c.y, c.z)), STEP_ASIDE_GOTO_MS,
      () => { try { stopMotion(); } catch (e) {} });
    const p = bot.entity.position;
    if (Math.hypot(p.x - (c.x + 0.5), p.z - (c.z + 0.5)) <= 1.2 && Math.abs(p.y - c.y) < 1.5) {
      emit({ type: 'table_step_aside', ok: true, dist: c.dist, x: c.x, y: c.y, z: c.z });
      return true;
    }
  }
  emit({ type: 'table_step_aside', ok: false, candidates: cells.length });
  return false;
}

// `opts.inPlace` (22/10, crafts DANS l'abri de nuit) : ne JAMAIS marcher — ni vers une table lointaine,
// ni pour en reprendre une abandonnée, ni vers un sol dégagé si la pose rate. Seule une table À PORTÉE
// compte ; sinon la table de poche est posée ICI (paroi du puits) puis reprise.
// TABLE PERDUE EN PHASE DIAMANT (25/10, NethBot1 session 679 : pioche diamant cassée, 61 diamants, aucune
// table → remontée chercher du bois). La pose libère la case de la table… que le PRODUIT du craft reprend
// aussitôt : poche à 0 case (`craft_fail_ctx … empty:0`, 110-180 cobble chez les mineurs) → collectBlock
// casse la table mais ne peut pas la ramasser → `reclaim_failed` + `table_abandoned` (×6 dans les sessions
// 676-682). Avant la reprise, on jette UNE pile de déchet (pickJunkToToss : jamais l'outil, garde cobble et
// remblai) si la table n'a nulle part où aller (needsRoomFor, PUR). Best-effort, jamais de throw.
async function makeRoomForTableReclaim() {
  try {
    const inv = bot.inventory;
    if (!inv || typeof inv.emptySlotCount !== 'function' || typeof bot.tossStack !== 'function') return;
    const items = inv.items();
    if (!needsRoomFor({ emptySlots: inv.emptySlotCount(), items, product: 'crafting_table', need: 1 })) return;
    const junk = pickJunkToToss(items, { exclude: ['crafting_table'] });
    if (!junk) { emit({ type: 'table_reclaim_no_room' }); return; }
    await bot.tossStack(junk);
    emit({ type: 'table_reclaim_room', tossed: junk.name + ':' + junk.count, empty: inv.emptySlotCount() });
  } catch (e) { /* best-effort */ }
}

async function withCraftingTable(fn, opts = {}) {
  const inPlace = !!(opts && opts.inPlace);
  // On CHERCHE loin (TABLE_SEEK) puis on marche jusqu'à la table : réutiliser une table déjà
  // posée évite d'en semer une nouvelle à chaque craft. Avec l'ancien rayon de 6, une table à
  // 10 blocs était invisible → une vingtaine de tables accumulées au spawn (signalé par Massii).
  let lastFail = null;   // dernier échec de fn() — propagé dans la raison (le libellé nu
                         // `table_present` a fait pointer 3 h de logs vers la table alors que
                         // la vraie cause était `no_recipe`, run world_mn14)
  // Marque une table INUTILISABLE : liste noire + UN event par table (pas un par tentative).
  const blacklistTable = blacklistBadTable;
  const t = _nearestTable(bot, inPlace ? TABLE_REACH : TABLE_SEEK, { exclude: _badTables });
  if (t) {
    try {
      if (!inPlace && bot.entity.position.distanceTo(t.position) > 3) {
        await withTimeout(
          bot.pathfinder.goto(new pfGoals.GoalNear(t.position.x, t.position.y, t.position.z, 2)),
          30000, () => { try { stopMotion(); } catch (e) {} }
        );
      }
      // ⚠️ `withTimeout` ne REJETTE jamais (timeout comme erreur, il RÉSOUT `{ ok:false, reason }`) :
      // le catch ci-dessous ne voit donc PAS un goto raté. Seule la DISTANCE dit si on est arrivé.
      // Resté trop loin pour crafter (> TABLE_REACH - 1) = inatteignable → plus jamais re-tentée.
      if (bot.entity.position.distanceTo(t.position) > TABLE_REACH - 1) blacklistTable(t.position, 'unreachable');
    } catch (e) { /* pas de chemin → on tentera la table portable */ }
    const r0 = await fn();
    if (r0.ok) return r0;                          // table existante atteinte → craft passé
    lastFail = r0;
  }
  // Barreau manquant de l'échelle (vécu V2Res1 en crash-loop) : table PERDUE (kick avant
  // reclaim) → placeBlockNear échouait 'unknown_item' pour toujours. Une table se re-craft
  // en 2×2 SANS table (4 planks) → on la re-fabrique avant de la poser.
  let hasTableItem = ((bot.inventory && bot.inventory.items()) || []).some((i) => i.name === 'crafting_table');
  // Les tables en liste noire sont INVISIBLES pour le plan : une table inatteignable « en vue »
  // déclenchait `recycle` à chaque craft, une autre à portée de vue mais inutilisable faisait
  // conclure `use_existing` (donc ne rien poser) alors qu'on ne pouvait pas s'en servir.
  const plan = tablePlan({
    tableInReach: !!_nearestTable(bot, TABLE_REACH, { exclude: _badTables }),
    tableSeen: !inPlace && !!_nearestTable(bot, TABLE_SEEK, { exclude: _badTables }),
    hasTableItem,
  });
  // Une table est DÉJÀ à portée de craft : en poser une seconde ne peut RIEN changer (l'échec
  // vient des matériaux). C'était la branche qui semait une table par craft raté — des traînées
  // de tables sur tout le parcours des bots (photo Massii 26/07).
  if (plan === 'use_existing') {
    const inner = lastFail && lastFail.reason ? ':' + lastFail.reason : '';
    return { ok: false, reason: 'craft_failed:table_present' + inner };
  }
  // Table ABANDONNÉE en vue (une mort ou un timeout a coupé le cycle avant la reprise) : aller
  // la REPRENDRE plutôt que d'en fabriquer une neuve → le terrain se nettoie au lieu de se joncher.
  if (plan === 'recycle') {
    const got = await recycleNearbyTable(blacklistTable);
    if (got !== null) hasTableItem = got;
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
    // Toujours pas de table en poche : placeBlockNear rendrait `unknown_item` (« objet absent de la
    // poche »), lu pendant des semaines comme « objet inconnu ». On dit la vraie cause.
    if (!((bot.inventory && bot.inventory.items()) || []).some((i) => i.name === 'crafting_table')) {
      return { ok: false, reason: 'no_table:no_wood_for_table' };
    }
  }
  let place = await placeBlockNear(bot, 'crafting_table');
  if (!place.ok && place.reason === 'no_space' && !place.unloaded) {
    // JAMAIS DEUX FOIS LA MÊME CASE (22/10) : 2 échecs `no_space` au même endroit → se décaler de 2-4
    // blocs dans le tunnel (avancer/reculer) avant de re-tenter, comme un joueur.
    const here = bot.entity.position;
    _noSpaceMemo.note(here, Date.now());
    if (!inPlace && _noSpaceMemo.shouldShift(here, Date.now()) && await stepAsideForTable()) {
      place = await placeBlockNear(bot, 'crafting_table');
    }
  }
  if (!place.ok) {
    // sol encombré (feuillage jungle, pente) → se déplacer vers un sol dégagé proche et re-tenter
    // UNE fois (vu live MapT4 : stall wooden_pickaxe avec table+planks+sticks en poche, pose impossible).
    const spot = inPlace ? null : findLandTarget(bot, 24);
    if (spot) {
      try {
        await withTimeout(bot.pathfinder.goto(new pfGoals.GoalNear(spot.x, spot.y + 1, spot.z, 1)),
          30000, () => { try { stopMotion(); } catch (e) {} });
      } catch (e) {}
      place = await placeBlockNear(bot, 'crafting_table');
    }
    if (!place.ok) {
      // `no_table:no_space` seul ne dit rien du terrain : around/under = les 4 voisins et les 4 sols
      // voisins (cf. placeBlockNear) → on voit ENFIN ce qui bloque la pose dans les logs de session.
      emit({ type: 'table_place_failed', reason: place.reason, around: place.around, under: place.under });
      return { ok: false, reason: 'no_table:' + (place.reason || '?') }; // sous-raison (diagnostic live)
    }
  }
  const tableSeen = await waitForBlock(place.pos, 'crafting_table'); // #3 : ne pas ouvrir la table avant qu'elle existe
  await sleep(300);                                // settle pose→ouverture (serveur + humanisation)
  let r = await fn();
  // `no_recipe` brut juste après une pose « réussie » (×6 le 20/10, MapBot1, alors que pierre + bâtons +
  // table étaient en poche) : la table n'est jamais apparue côté client, ou le bot a été emporté hors de
  // portée pendant le craft (le cartographe bouge en parallèle). On le dit au lieu de « pas de recette ».
  if (r && !r.ok && r.reason === 'no_recipe') {
    let far = null;
    try { far = place.pos ? Math.round(bot.entity.position.distanceTo(place.pos) * 10) / 10 : null; } catch (e) { far = null; }
    if (!tableSeen) r = Object.assign({}, r, { reason: 'no_recipe:table_unconfirmed' });
    else if (far != null && far > TABLE_REACH - 1) r = Object.assign({}, r, { reason: 'no_recipe:table_out_of_reach' });
  }
  await sleep(250);                                // craft 100% terminé AVANT de casser la table
  await makeRoomForTableReclaim();                 // poche pleine = table jamais ramassée (cf. ci-dessous)
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
// ── INTERMÉDIAIRES D'ABORD (fix 20/10, craftPlan.js) ─────────────────────────────────────────────
// Avant un craft CONNU : bûches → planches (même essence) → bâtons → table, puis la recette demandée.
// S'il manque une matière première, on le dit tout de suite (`no_wood:table`, `no_coal`…) au lieu de
// marcher vers une table puis d'échouer `no_table:unknown_item` (= « pas de table en poche ET pas assez
// de bois pour en faire une », 107× en 2 h). Re-planifié après CHAQUE étape sur l'inventaire réel :
// mineflayer choisit lui-même l'essence d'une recette de bâtons, le plan s'y adapte. Borné à 8 étapes.
// Rend null = rien à faire / objet inconnu → chemin historique ; {ok:false, reason} = arrêt.
const CRAFT_PLAN_MAX_STEPS = 8;
async function _craftPrereqs(args) {
  const name = args && args.name;
  if (!name || args._noPlan) return null;
  let announced = false;
  for (let i = 0; i < CRAFT_PLAN_MAX_STEPS; i++) {
    const items = (bot.inventory && typeof bot.inventory.items === 'function') ? bot.inventory.items() : [];
    const tableAvailable = items.some((it) => it && it.name === 'crafting_table')
      || !!_nearestTable(bot, args._inPlace ? TABLE_REACH : TABLE_SEEK, { exclude: _badTables });
    const plan = planIntermediates(name, items, { count: args.count || 1, tableAvailable });
    if (!plan.known) return null;
    if (!plan.ok) return { ok: false, reason: plan.reason };
    if (!plan.steps.length) return null;
    if (!announced) { announced = true; emit({ type: 'craft_plan', item: name, steps: plan.steps }); }
    const st = plan.steps[0];
    const r = await craftItem(bot, { name: st.name, count: st.count });
    if (!r || !r.ok) return { ok: false, reason: 'intermediate:' + st.name + ':' + ((r && r.reason) || 'failed') };
  }
  return null;
}

async function _craftSmartRaw(args) {
  // TABLE : en reprendre une posée AVANT d'en fabriquer une (21/10, NethBot2 : table du four abandonnée
  // à 1-2 blocs — `reclaim_failed` — puis le but `crafting_table` re-crafte en boucle sans effet). Le
  // but veut une table EN POCHE : une table posée et reprenable la donne sans planche ni craft.
  const inPlace = !!(args && args._inPlace);
  if (args && args.name === 'crafting_table' && !inPlace
      && !((bot.inventory && bot.inventory.items()) || []).some((i) => i.name === 'crafting_table')) {
    const got = await recycleNearbyTable(blacklistBadTable);
    if (got) return { ok: true, recycled: true };
  }
  // FOURNÉES SUR PLUSIEURS ESSENCES (23/10) : 4 fournées de bâtons avec birch 6 + oak 2 → une seule
  // (craftPlan.woodCountFallback) au lieu de `no_wood:planks` en boucle avec 8 planches en poche.
  if (args && args.name && Number(args.count) > 1) {
    try {
      const items0 = (bot.inventory && bot.inventory.items()) || [];
      const n = woodCountFallback(args.name, items0, { count: args.count,
        tableAvailable: items0.some((it) => it && it.name === 'crafting_table') || !!_nearestTable(bot, inPlace ? TABLE_REACH : TABLE_SEEK, { exclude: _badTables }) });
      if (n < args.count) { emit({ type: 'craft_count_reduced', item: args.name, from: args.count, to: n }); args = Object.assign({}, args, { count: n }); }
    } catch (e) { /* best-effort : chemin historique */ }
  }
  const pre = await _craftPrereqs(args);
  if (pre) return pre;
  const r = await craftItem(bot, args);
  if (r.ok) return r;
  if (r.reason === 'no_recipe' || r.reason === 'craft_failed') return withCraftingTable(() => craftItem(bot, args), { inPlace });
  return r;
}

// ── UN CRAFT À LA FOIS, ET PAS EN PLEIN COMBAT (fix 20/10) ───────────────────────────────────────
// Mesuré (run 20/10, NethBot2, session 278) : `t1_sword` craft_failed ×2 puis craft_no_effect ×2 et
// `crafting_table` craft_no_effect, TOUS au milieu d'un combat (`survival fight zombie`, `aura_hit`,
// `team_assist`) ou juste après un `/tpa` de squad tiré PENDANT le craft (`squad_join` → téléporté à
// 100 blocs de la table qu'il venait de poser → `table_abandoned`). Mécanisme (mineflayer) : un craft
// à la table ouvre une FENÊTRE ; pendant qu'elle est ouverte, l'aura et mineflayer-pvp changent l'objet
// en main (`bot.equip` = clics d'inventaire envoyés… sur la mauvaise fenêtre) → le serveur rejette ou
// désynchronise, le produit n'arrive jamais. Et ~25 appelants de craftSmart (planner, filets pioche/
// armure/bouclier/torches à minuterie) pouvaient crafter EN MÊME TEMPS.
// Donc : (1) une FILE — un craft attend la fin du précédent (borné : jamais plus de 20 s, un craft
// coincé ne gèle pas les autres) ; (2) un hostile à ≤ 5 blocs ou un combat pvp en cours → on attend
// qu'il soit réglé (borné 8 s, `craft_deferred`) ; (3) pendant le craft, `_craftDepth > 0` coupe l'aura
// (equip/coup) et le /tpa de squad. ⚠️ NIVEAU MODULE (piège #56).
const CRAFT_QUEUE_MAX_WAIT_MS = 20000;
const CRAFT_COMBAT_WAIT_MS = 8000;
const CRAFT_COMBAT_RADIUS = 5;
let _craftTail = Promise.resolve();
let _craftDepth = 0;

/** Combat en cours à portée de craft ? (pvp actif, ou hostile non neutre à ≤ 5 blocs). Jamais de throw. */
function craftCombatNow() {
  try {
    if (bot.pvp && bot.pvp.target) return true;
    const p = bot.entity && bot.entity.position;
    if (!p) return false;
    for (const e of Object.values(bot.entities || {})) {
      if (!e || e.isValid === false || !e.position) continue;
      if (!isFleeHostile(e) || NEUTRAL_NO_PROVOKE.has(e.name)) continue;
      if (Math.hypot(e.position.x - p.x, e.position.y - p.y, e.position.z - p.z) <= CRAFT_COMBAT_RADIUS) return true;
    }
  } catch (e) { /* lecture ratée → pas de combat */ }
  return false;
}

/** Matière de craft en poche (planches/bûches PAR ESSENCE, bâtons, pierres par type, cases vides). */
function craftMatterSummary() {
  const mat = {};
  let empty = null;
  try {
    for (const it of ((bot.inventory && bot.inventory.items()) || [])) {
      if (!it || !it.name) continue;
      if (/_planks$|_log$|^stick$|^cobblestone$|^cobbled_deepslate$|^blackstone$|^iron_ingot$|^crafting_table$/.test(it.name)) {
        mat[it.name] = (mat[it.name] || 0) + (it.count || 0);
      }
    }
    if (bot.inventory && typeof bot.inventory.emptySlotCount === 'function') empty = bot.inventory.emptySlotCount();
  } catch (e) { /* best-effort */ }
  return { mat, empty, combat: craftCombatNow() };
}

// ── PV CRITIQUES : RÉCUPÉRER AU LIEU DE RÉESSAYER (22/10, cf. lowhp.js) ─────────────────────────
// Niveau MODULE (piège #56) : lu par craftSmart (planner ET timers) et par recoverLowHp.
let _lowHpFoodRunAt = 0;       // dernière sortie nourriture lancée PAR une récupération
let _lowHpRecoverBusy = false;

/** Signaux de lowhp.lowHpStep, lus sur le bot. Jamais de throw. */
function lowHpSignals() {
  let hasFood = false;
  let threatDist = null;
  try {
    const items = (bot.inventory && bot.inventory.items()) || [];
    hasFood = items.some((i) => i && (FOODS.has(i.name) || EMERGENCY_FOODS.has(i.name)));
  } catch (e) { /* inventaire pas livré → rien à manger */ }
  try {
    const p = bot.entity && bot.entity.position;
    if (p) {
      for (const e of Object.values(bot.entities || {})) {
        if (!e || e.isValid === false || !e.position) continue;
        if (!isFleeHostile(e) || NEUTRAL_NO_PROVOKE.has(e.name)) continue;
        const d = Math.hypot(e.position.x - p.x, e.position.y - p.y, e.position.z - p.z);
        if (threatDist == null || d < threatDist) threatDist = d;
      }
      if (bot.pvp && bot.pvp.target && threatDist == null) threatDist = 0;
    }
  } catch (e) { /* lecture ratée → aucune menace connue */ }
  return {
    health: bot.health, food: bot.food, hasFood, threatDist,
    foodRunTriedRecently: _lowHpFoodRunAt > 0 && Date.now() - _lowHpFoodRunAt < LOWHP_FOOD_RUN_TTL_MS,
  };
}

/** Garde de craftSmart : refuser le craft tant que la récupération a quelque chose à faire. */
function craftLowHpBlocked() {
  return craftBlockedAtLowHp(lowHpSignals());
}

/**
 * Récupération à PV critiques, BORNÉE (LOWHP_RECOVERY_BUDGET_MS) : manger → se murer si un hostile est
 * collé → sortie nourriture si la faim coupe la régénération → sinon rester immobile jusqu'à PV > seuil.
 * Rend { outcome } : healed | no_regen (rien à gagner à attendre) | timeout | cancelled | dead | busy.
 */
const LOWHP_PROCEED_PAUSE_MS = 15000;
// PAS DE RÉGÉNÉRATION POSSIBLE (25/10, NethBot1 : faim 3, 4 PV, aucune nourriture, sortie nourriture vide) :
// la garde PV des grottes (< 12) refusait le minage, la récupération rendait `no_regen`, et le bot restait
// immobile une heure (la faim ne tombait jamais à 0 pour le tuer). Après un `no_regen`, pendant 5 min, on
// mine quand même au-dessus de 4 PV — attendre ne rapporte rien. Niveau MODULE (piège #56).
let _noRegenAt = 0;
const NO_REGEN_MINE_MS = 5 * 60000;
const NO_REGEN_MINE_MIN_HP = 4;
function caveHpAllowed() {
  const hp = bot && bot.health;
  if (caveIronPick.caveHpOk(hp)) return true;
  return _noRegenAt > 0 && Date.now() - _noRegenAt < NO_REGEN_MINE_MS && Number(hp) >= NO_REGEN_MINE_MIN_HP;
}   // garde de skill sans issue : pause avant la relance du but
async function recoverLowHp(goalName, opts = {}) {
  if (_lowHpRecoverBusy) { await sleep(2000); return { outcome: 'busy' }; }
  // `targetHp` (24/10) : garde PV d'un skill (caveHunt `low_hp` < 12) → récupérer jusqu'à elle.
  const targetHp = Number.isFinite(opts.targetHp) ? opts.targetHp : undefined;
  _lowHpRecoverBusy = true;
  const t0 = Date.now();
  let sealed = false;
  let eats = 0;
  let eatFails = 0;
  let outcome = 'timeout';
  emit({ type: 'low_hp_recover', goal: goalName, hp: bot.health, food: bot.food, target: targetHp });
  try {
    while (Date.now() - t0 < LOWHP_RECOVERY_BUDGET_MS) {
      if (taskToken.cancelled || migrationOwnsBot()) { outcome = 'cancelled'; break; }
      if (!bot.entity || bot.health === 0) { outcome = 'dead'; break; }
      const step = lowHpStep(Object.assign(lowHpSignals(), { sealed, eatFails, targetHp }));
      if (step === 'ok') { outcome = 'healed'; break; }
      if (step === 'proceed') {
        // Garde de skill (pas critique) sans rien à manger ni sortie possible : la relance immédiate du but
        // retomberait sur le même refus en quelques ms (×12 en 10 min, NethBot1 24/10) — on laisse respirer.
        if (targetHp !== undefined) await sleep(LOWHP_PROCEED_PAUSE_MS);
        outcome = 'no_regen'; break;
      }
      if (step === 'eat') {
        // 24/10 : le filet (hungerNetTick) mange jusqu'à faim ≥ 18, accepte le cru blessé, VÉRIFIE la bouchée
        // (consume() peut rendre sans manger) et émet ate/heal_eat/eat_failed lui-même. Muré (`sealed`) :
        // l'hostile derrière la paroi n'empêche pas de manger ; lowHpStep fait se murer AVANT de manger.
        const ate = await hungerNetTick('low_hp_recover', { sealed });
        if (ate === true) eats++;
        else { eatFails++; await sleep(1000); }
      } else if (step === 'seal') {
        sealed = true;
        try { stopMotion(); } catch (e) {}
        const n = await withTimeout(nightSeal(), 10000, () => {});
        emit({ type: 'low_hp_seal', placed: typeof n === 'number' ? n : 0, hp: bot.health });
      } else if (step === 'food_run') {
        _lowHpFoodRunAt = Date.now();
        try { await foodRunTick(); } catch (e) { /* best-effort : ses propres portes décident */ }
      } else {
        await sleep(1000);                                // 'wait' : immobile, l'aura défend
      }
    }
  } finally {
    _lowHpRecoverBusy = false;
    if (outcome === 'no_regen') { try { _noRegenAt = Date.now(); } catch (e) { /* bac à sable de test */ } }
    emit({ type: 'low_hp_recover_done', goal: goalName, outcome, hp: bot.health, food: bot.food, eats, sealed, took_ms: Date.now() - t0 });
  }
  return { outcome };
}

async function craftSmart(args) {
  const prev = _craftTail;
  let release = () => {};
  const mine = new Promise((r) => { release = r; });
  _craftTail = mine;
  let qTimer = null;
  await Promise.race([prev, new Promise((r) => { qTimer = setTimeout(r, CRAFT_QUEUE_MAX_WAIT_MS); })]);
  clearTimeout(qTimer);
  _craftDepth++;
  try {
    const t0 = Date.now();
    let deferred = false;
    while (craftCombatNow() && !homewarp.isCriticalHealth(bot.health) && Date.now() - t0 < CRAFT_COMBAT_WAIT_MS) {
      deferred = true; await sleep(500);
    }
    // PV CRITIQUES (fix 21/10, veille autonome) : `_craftDepth > 0` COUPE l'aura/équipement
    // (index.js:10059, « coupe l'aura (equip/coup) ») — crafter désarme le bot pile quand il en a
    // le plus besoin. Mesuré NethBot3 session-94 : craft torche déféré 2,5 s pendant un combat à
    // 4,33 PV, exécuté dès que le combat redevient momentanément faux, mort ~500 ms après. Vérifié
    // avant ET après le différé (les PV peuvent chuter PENDANT l'attente).
    // 22/10 : la garde est désormais lowhp.craftBlockedAtLowHp — même seuil, même refus tant qu'il y
    // a une menace en vue, de quoi manger, une régénération en cours ou une sortie nourriture à
    // tenter ; elle laisse passer le seul cas où attendre ne rend AUCUN PV (rien à manger, faim < 18,
    // sortie déjà tentée, personne à 16 blocs). Le refus est rattrapé par runSkillWithTelemetry, qui
    // RÉCUPÈRE (recoverLowHp) au lieu de laisser le planner relancer le craft en boucle.
    if (craftLowHpBlocked()) {
      _auraEmit('craft_skipped_low_hp', { name: args && args.name, health: bot.health, waited_ms: deferred ? Date.now() - t0 : 0 });
      return { ok: false, reason: 'low_hp_skip' };
    }
    if (deferred) _auraEmit('craft_deferred', { name: args && args.name, waited_ms: Date.now() - t0, combat: craftCombatNow() });
    const r = await _craftSmartRaw(args);
    // Échec : dire POURQUOI avec la matière en poche (les logs du 20/10 n'avaient que `no_recipe` /
    // `craft_no_effect`, sans l'inventaire — impossible de trancher entre essences mélangées, pierres
    // mélangées, poche pleine ou désync). Throttlé (≤ 1 / 10 s).
    if (r && !r.ok) _auraEmit('craft_fail_ctx', Object.assign({ name: args && args.name, reason: r.reason, err: r.err }, craftMatterSummary()));
    return r;
  } finally {
    _craftDepth = Math.max(0, _craftDepth - 1);
    release();
  }
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
// `opts.maxMs` : plafond du poll du four (défaut de smelt : 3 min). La cuisson de VIANDE le réduit à
// ce que le budget « nourriture » peut payer (10 s la pièce) — cf. food.cookPlan.
async function smeltWithFurnace(input, output, count, fuelOverride, opts = {}) {
  // Un four de mine en cours (fondre en minant) : jamais un 2e four à côté. Le planner le ramasse AVANT
  // tout but de fonte (runSkillWithTelemetry → finishFurnaceJob) ; un appelant hors planner (timer
  // d'armure, équipement au ramassage) ne marche pas vers lui en plein branch-mine : il réessaiera.
  // Four de mine LOIN (22/10, NethBot1 : 14 min de `furnace_job_running` avec le four 40 blocs plus bas) :
  // il ne bloque plus les autres fours — seul un four de mine à portée de retour garde la priorité.
  if (_furnaceJob && furnaceJobNear()) return { ok: false, reason: 'furnace_job_running' };
  _stillBusy = true;    // immobilité LÉGITIME (poll du four ≤3 min) — le desync-watchdog ne doit pas tirer
  // RAISON TOUJOURS RENSEIGNÉE (vu en session vivante : `armor_smelt ok:false reason:"?"`, un échec
  // à la cause PERDUE sur le chemin qui fabrique l'armure). Le trou est dans `smelt` lui-même
  // (skills/smelt.js) qui rend `{ok: got >= want, got}` — donc SANS `reason` dès qu'il fond moins
  // que demandé. On normalise ICI, point de passage UNIQUE de tous les appelants ; les raisons
  // amont (no_furnace/no_fuel/no_input/open_failed…) ne sont jamais écrasées.
  try { return normalizeSmeltResult(await _smeltWithFurnaceInner(input, output, count, fuelOverride, opts), count); }
  finally { _stillBusy = false; }
}
async function _smeltWithFurnaceInner(input, output, count, fuelOverride, opts = {}) {
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
  const r = await smelt(bot, { input, output, count, fuel: fuelOverride || fuelNames(), maxMs: opts.maxMs }, taskToken);
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
// huntCook = UNE vague de chasse ≤ 45 s + cuisson + pêche locale, le tout dans un budget de 60 s
// (food.js, 19/10 : « la VITESSE ») — 90 s de garde-fou, plus les 8 min des 3 vagues de 120 s ;
// smeltCharcoal = gather bûches éventuel + fonte (180s de smelt max).
// gather/gatherLog : 8 min — un trajet DIRIGÉ légitime peut faire ≤1500 blocs (mémoire de monde) ;
// sûr car chaque goto interne d'explore est borné individuellement (directed 240s / waypoint 90s).
// gatherLog 180s (phase 3) : une chasse au bois honnête (biais dirigé + anneaux ≤128) tient en
// <3 min — au-delà la zone est déforestée et le kit-relocate forêt est plus rentable que d'insister
// (vécu V3Res1/4 : 480s × 4 tentatives = 32 min d'anneaux stériles avant le stall).
// huntCook + FOOD_TRIP_MS (75 s) : l'EXPÉDITION vers le gibier (marche vers la cellule à animaux la plus
// proche connue) a son propre plafond, hors du budget de 60 s — un garde-fou de 90 s la couperait en route.
const SKILL_TIMEOUTS = { descendDiagonal: 900000, branchMine: 900000, caveHunt: 900000, caveIron: 600000, huntCook: 90000 + FOOD_TRIP_MS + FOOD_TRIP_LONG_EXTRA_MS + COOK_LOT_HARD_MS, ensureBed: 240000, smeltCharcoal: 300000, gather: 480000, gatherLog: 180000, ensurePick: 480000, fish: 300000, deliverWood: 120000, lumberjackIdle: 330000, lumberjackArmor: 160000, lumberjackForestTrip: LJ_FOREST_TRIP_MS + 20000, deliverMapperArmor: 180000 };   // /tpa 20 s + remise prouvée ≤ 2 × ~40 s (24/10)
function timeoutFor(skill) { return SKILL_TIMEOUTS[skill] || SKILL_TIMEOUT_MS; }
/** Champs « pourquoi » d'un résultat takeCover pour l'event `take_cover` (22/10 : `placed:0 ok:false`
 *  sans raison, session 155 — on ne savait pas si rien n'était posable, refusé, ou expiré). */
function coverWhy(r) {
  const o = {};
  if (r && r.reason) o.reason = r.reason;
  if (r && Array.isArray(r.cells) && r.cells.length) o.cells = r.cells;
  if (r && r.error) o.error = r.error;
  if (r && r.joined) o.joined = true;
  return o;
}

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

// ─── CUIRE LA VIANDE COMME UN JOUEUR (23/10, cookMeat.js) ─────────────────────────────────────────
// Live 6 h (NethBot1-3) : 288 viandes CRUES mangées pour 8 cuites, 102 chasses sur 103 à `cooked:0`.
// Un joueur qui rentre avec 3 pièces et un four les cuit : ici le câblage — après la chasse
// (foodRun dep `cookLot`), entre deux buts (runSkillWithTelemetry), dans le hook du branch-mine, et le
// filet anti-faim qui préfère cuire que d'avaler du cru. Le combustible réservé au fer n'est jamais pris.
// ⚠️ NIVEAU MODULE (piège #56) : lus par le timer du filet.
let _cookBusy = false;
let _cookFailUntil = 0;           // cuisson ratée → 3 min sans retenter (le cru redevient mangeable)
let _rawDeferSince = 0;           // le filet diffère le cru depuis… (0 = pas en attente)

/** Où cuire ? 'pocket' (four en poche, posé à côté), 'placed' (four posé ≤ 24 blocs, ≤ 4 sans marcher), null. */
function meatCookAccess({ walk = true } = {}) {
  try {
    if (!bot.inventory || !bot.registry) return null;
    // Un four de mine en cours à portée : smeltWithFurnace refuse tout autre four (furnace_job_running).
    if (_furnaceJob && furnaceJobNear()) return null;
    if (_invTotal((i) => i.name === 'furnace') > 0) return 'pocket';
    const fdef = bot.registry.blocksByName && bot.registry.blocksByName.furnace;
    if (!fdef || typeof bot.findBlocks !== 'function') return null;
    const job = _furnaceJob && _furnaceJob.pos;
    const found = bot.findBlocks({ matching: [fdef.id], maxDistance: walk ? 24 : 4, count: 4 }) || [];
    const ok = found.some((p) => !(job && p.x === job.x && p.y === job.y && p.z === job.z));
    return ok ? 'placed' : null;
  } catch (e) { return null; }
}

/** Le plan de cuisson pour l'instant présent (combustible au-delà de la réserve du fer). */
function meatCookPlanNow({ walk = true } = {}) {
  let items = [];
  try { items = bot.inventory.items().map((i) => ({ name: i.name, count: i.count })); } catch (e) { items = []; }
  let fuel = 0;
  try { fuel = fuelUnits(bot.inventory.items(), fuelNames()); } catch (e) { fuel = 0; }
  let need = 0;
  try {
    need = Math.max(0, armorNeed({ inv: buildCtxInv(bot), worn: [..._wornArmor()] }, 3)
      - _invTotal((i) => i.name === 'iron_ingot'));
  } catch (e) { need = 0; }
  const rawIron = items.reduce((s, i) => s + (i.name === 'raw_iron' ? i.count : 0), 0);
  return cookLotPlan({
    items, furnace: meatCookAccess({ walk }), fuelUnits: fuel,
    reserveUnits: ironFuelReserve({ rawIron, smeltNeed: need }),
  });
}

/** Entre deux buts : attendre la fin d'une cuisson lancée par le filet, puis cuire le lot s'il y en a un. */
async function cookBetweenGoals(g) {
  const w0 = Date.now();
  while (_cookBusy && Date.now() - w0 < COOK_LOT_HARD_MS) await sleep(500);
  if (g && g.skill === 'huntCook') return;                   // la chasse cuit son propre lot
  try { await cookMeatLot('goal'); } catch (e) { /* best-effort */ }
}

/** Le filet peut-il cuire (sans marcher) plutôt que d'avaler du cru ? */
function netMeatCookable() {
  if (Date.now() < _cookFailUntil) return false;
  try { return meatCookPlanNow({ walk: false }).go === true; } catch (e) { return false; }
}

/** Le bot est-il libre pour une cuisson lancée depuis un TIMER (rien d'autre ne tient le pathfinder) ? */
function netCookFree() {
  if (_cookBusy || _furnaceJobBusy || _skillInFlight > 0) return false;
  try { if (bot.pvp && bot.pvp.target) return false; } catch (e) {}
  try { if (bot.pathfinder && typeof bot.pathfinder.isMoving === 'function' && bot.pathfinder.isMoving()) return false; } catch (e) {}
  return true;
}

/**
 * Cuit le lot de viande crue (≥ 3 pièces), borné ~45 s (dur : COOK_LOT_HARD_MS). Rend le nombre cuit.
 * Toujours tracé (`meat_cooked`), jamais de throw. Un four OUVERT bloque le reste : on borne tout.
 */
async function cookMeatLot(tag = 'goal', { walk = true } = {}) {
  if (_cookBusy) return 0;
  if (Date.now() < _cookFailUntil) return 0;
  let plan = null;
  try { plan = meatCookPlanNow({ walk }); } catch (e) { plan = null; }
  if (!plan || !plan.go) return 0;
  _cookBusy = true;
  const t0 = Date.now();
  let got = 0;
  let reason = null;
  try {
    const work = (async () => {
      for (const lot of plan.lots) {
        if (taskToken && taskToken.cancelled) { reason = 'cancelled'; break; }
        const left = COOK_LOT_MAX_MS - (Date.now() - t0);
        const n = Math.min(lot.count, Math.floor((left - 2000) / 10000));
        if (n < 1) break;
        const r = await smeltWithFurnace(lot.name, lot.out, n, undefined, { maxMs: n * 10000 + 3000 });
        const g = Number(r && (r.got != null ? r.got : (r.ok ? n : 0))) || 0;
        got += g;
        if (!g) { reason = (r && r.reason) || 'no_output'; break; }
      }
    })();
    const res = await withTimeout(work, COOK_LOT_HARD_MS, () => { try { stopMotion(); } catch (e) {} });
    if (res && res.reason === 'timeout' && !reason) reason = 'timeout';
  } catch (e) { reason = 'error'; }
  finally { _cookBusy = false; }
  if (!got) _cookFailUntil = Date.now() + COOK_FAIL_COOLDOWN_MS;
  const ev = { type: 'meat_cooked', count: got, took_ms: Date.now() - t0, via: tag, planned: plan.pieces };
  if (!got && reason) ev.reason = reason;
  emit(ev);
  return got;
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

// ── EXPÉDITION VERS LE GIBIER (Massii 19/10 : « l'important c'est la VITESSE… et dans le pire des cas il
// y a la viande de zombie »). Mesure live : TOUS les bots à 0 point de nourriture, `hunt_cook_done
// reason:no_prey:no_passive` à chaque sortie — aucun animal à ≤ 32 blocs du spawn (forêt dense), des
// PLAINES à ~140 blocs. À vraie faim (< 6 points), de jour, en surface et sans gibier en vue : UNE
// marche vers la cellule à animaux la plus proche CONNUE de la carte du groupe (≤ 75 s, hors budget),
// puis la chasse habituelle sur place. La décision (foodTrip.shouldFoodTrip) et l'ordre des phases
// (foodRun.runHuntCook) sont purs et testés avec des dépendances fausses ; ici, le câblage sur le bot.
// `_foodTripBusy` (tête de fichier) couvre la marche ET la chasse sur place : lue par le confine et le squad.

/** L'état du monde que lit la décision pure `shouldFoodTrip`. */
function foodTripState() {
  const p = bot.entity && bot.entity.position;
  let inWater = false;
  try { inWater = isInWater(bot); } catch (e) { inWater = false; }
  const owner = taskCtl.active;      // 'autonomous' (planner ET mappeur) ou rien ; tout autre nom = un ORDRE direct (follow, guard, take…) ou la migration
  return {
    // `bot.time` peut manquer juste après un spawn : null = heure inconnue → la décision ne part PAS,
    // plutôt que de conclure « il fait jour » et marcher 75 s au crépuscule.
    isDay: (bot.time && bot.time.timeOfDay != null) ? !cautionNightNow() : null,   // diamant complet : jour permanent (freeRoam)
    y: p ? p.y : NaN,
    migrating: _migrating,
    ordered: isOrderOwner(owner),   // 'food_run' (sortie qui a préempté le planner) n'est pas un ordre
    // Mêmes gardes que le ramassage après combat (lootAfterCombat) : la survie passe devant, et un
    // combat en cours (bot.pvp.target) n'est pas le moment de partir marcher.
    busy: !!(_imminentBusy || panicInFlight || _armorBusy || _baseBusy || _escaping || _deathDebtBusy || inWater
      || (bot.pvp && bot.pvp.target)),
    tripBusy: _foodTripBusy,
    // SORTIE LONGUE due (24/10, foodTrip.longTripDue) : poche à 0 et une sortie courte ratée il y a < 30 min
    // (mémo de base : survit aux morts — la mémoire de process est perdue à chaque respawn).
    longDue: (() => {
      try {
        const now = Date.now();
        const lt = longTripLoad(loadBaseState() || {}, now);
        return longTripDue({ points: foodPoints(buildCtxInv(bot)), shortFailAt: lt.shortFailAt, longAt: lt.longAt, now });
      } catch (e) { return false; }
    })(),
    // Serveur de test (bot OP) : ensureFood se /give à manger en dernier recours — instantané, alors que
    // marcher 75 s ne ferait que le retarder. L'expédition est pour les bots SANS /give.
    canGive: !NO_GIVE,
  };
}

/** La cellule à gibier la plus proche CONNUE (carte du groupe), hors cellules ratées depuis < 20 min. */
function foodTripCell(o = {}) {
  const p = bot.entity && bot.entity.position;
  if (!p) return null;
  const now = Date.now();
  const st = loadBaseState();
  const avoid = triedCellsLoad(st, now);
  // Sortie LONGUE (24/10) : portée élargie (≤ 400 blocs). Les troupeaux arrivés-bredouilles sont déjà
  // oubliés (foodTripMark → herdsForget) et les cibles ratées écartées 20 min (mémo de base).
  const herdOpts = { avoid, now };
  if (o.long && Number.isFinite(o.maxDist)) herdOpts.maxDist = o.maxDist;
  // Un troupeau VU (herdScanTick) bat une cellule de biome où il y a « probablement » des bêtes.
  const herd = pickHerd(herdsLoad(st, now), { x: p.x, z: p.z }, herdOpts);
  if (herd) return herd;
  const cellOpts = { from: { x: p.x, z: p.z }, biomes: loadWorldCells().biomes, avoid, now };
  if (o.long && Number.isFinite(o.maxDist)) cellOpts.maxDist = o.maxDist;
  return pickGrazingCell(cellOpts);
}

/** Bilan d'expédition → mémo de base (sortie longue : `shortFailAt` / `longAt`, foodTrip.longTripRecord). Fusion. */
function foodTripOutcome(o) {
  const now = Date.now();
  const st = loadBaseState() || {};
  const next = longTripRecord(st[FOOD_TRIP_LONG_MEMO_KEY], o, now);
  // Arrivé bredouille (25/10) : noté pour la porte de descente (foodGate, surface stérile).
  const barrenAt = herdBarrenRecord(st[HERD_BARREN_MEMO_KEY], o, now);
  saveBaseState(Object.assign({}, st, { [FOOD_TRIP_LONG_MEMO_KEY]: next, [HERD_BARREN_MEMO_KEY]: barrenAt }));
}

/** Verrou de l'expédition (niveau MODULE) : true = pris ; false = une autre expédition est déjà en vol. */
function foodTripLock() {
  if (_foodTripBusy) return false;
  _foodTripBusy = true;
  return true;
}
function foodTripUnlock() { _foodTripBusy = false; }

/**
 * Le planner CÈDE le pathfinder pendant l'expédition. Le timer de nourriture tourne EN PARALLÈLE du planner :
 * un nouveau but de celui-ci (explore, gather, craft…) volerait la jambe en cours (GoalChanged), et la marche
 * — qui se ré-arme à chaque jambe — lui volerait la sienne en retour : ping-pong sans progrès, 2 jambes sur
 * place et l'expédition abandonne. Seuls les NOUVEAUX buts attendent (les buts déjà en vol sont bornés et
 * finissent), au plus FOOD_TRIP_YIELD_MAX_MS, et dès que la tâche est annulée (mort, migration). Hors
 * expédition : un test de booléen, rien d'autre. `taskToken` est lu À CHAQUE tour (global, voulu ici).
 */
async function foodTripYield() {
  const t0 = Date.now();
  // + FOOD_TRIP_LONG_EXTRA_MS : la sortie longue (4 min) et le plein sur place (24/10).
  while ((_foodTripBusy || _huntCookBusy > 0) && !taskToken.cancelled && Date.now() - t0 < FOOD_TRIP_YIELD_MAX_MS + FOOD_TRIP_LONG_EXTRA_MS) await sleep(500);
}

/**
 * Écarte une cellule ratée pendant 20 min — dans le MÉMO DE BASE, pas en mémoire de process : le
 * self-healing relance le bot toutes les quelques minutes, et une liste gardée en variable repartait
 * de zéro à chaque respawn (la cellule qui venait d'échouer était alors re-visée aussitôt — pièges #52/#66a).
 * Fusion sur l'état COURANT, jamais un objet neuf : la base, la dette de mort et la zone y vivent aussi.
 */
function foodTripMark(cell) {
  const now = Date.now();
  const st = loadBaseState() || {};
  const patch = { [FOOD_TRIP_MEMO_KEY]: triedCellsAdd(triedCellsLoad(st, now), cell, now) };
  // Troupeau visé, ARRIVÉ sur place, rien tué : il n'y est plus — on l'oublie (pas arrivé = il y est
  // peut-être encore : la cellule ratée suffit à ne pas y retourner pendant 20 min).
  const p = bot.entity && bot.entity.position;
  if (cell && cell.herd && p && Math.hypot(p.x - cell.x, p.z - cell.z) <= FOOD_TRIP_ARRIVED) {
    patch[HERD_MEMO_KEY] = herdsForget(herdsLoad(st, now), cell);
  }
  saveBaseState(Object.assign({}, st, patch));
}

/**
 * Chasse ratée sur une bête VUE (23/10) : la cellule de troupeau la plus proche à < 64 blocs est marquée
 * ratée (mémo de base, fusion) — l'expédition et la porte de descente visent alors le suivant.
 * → le troupeau marqué | null.
 */
function foodTripMarkNearHerd() {
  const p = bot.entity && bot.entity.position;
  if (!p) return null;
  const now = Date.now();
  const st = loadBaseState() || {};
  const avoid = triedCellsLoad(st, now);
  const h = herdToMarkAfterFail(herdsLoad(st, now), { x: p.x, z: p.z }, { avoid, now });
  if (!h) return null;
  saveBaseState(Object.assign({}, st, { [FOOD_TRIP_MEMO_KEY]: triedCellsAdd(avoid, h, now) }));
  return h;
}

// ── TROUPEAUX VUS (22/10) : le serveur envoie les animaux jusqu'à 96 blocs ; un bot qui passe près d'un
// pré le NOTE, comme un joueur qui se souvient « il y avait des vaches derrière la colline ». Écrit dans
// le mémo de base (fusion, jamais un objet neuf) : survit aux morts et aux relances du self-healing.
// Écriture seulement si la liste a changé (cellule apparue/oubliée, effectif), au plus toutes les 30 s.
// Niveau MODULE (piège #56) : lu par le timer.
let _herdSavedAt = 0;
const HERD_SCAN_MS = 15000;
const HERD_SAVE_MIN_MS = 30000;
const HERD_REFRESH_MS = 10 * 60000;
function herdScanTick() {
  try {
    const p = bot.entity && bot.entity.position;
    if (!p || !bot.entities) return;
    const now = Date.now();
    if (now - _herdSavedAt < HERD_SAVE_MIN_MS) return;
    const seen = herdSightings(bot.entities, p);
    const st = loadBaseState() || {};
    const prev = herdsLoad(st, now);
    if (!seen.length && !prev.length) return;
    const next = herdsObserve(prev, seen, { x: p.x, z: p.z }, now);
    // Inchangé : on rafraîchit quand même les dates toutes les 10 min (sinon un pré sous nos yeux
    // expirerait au bout d'1 h de TTL).
    if (!herdsChanged(prev, next) && !(seen.length && now - _herdSavedAt >= HERD_REFRESH_MS)) return;
    _herdSavedAt = now;
    saveBaseState(Object.assign({}, loadBaseState() || {}, { [HERD_MEMO_KEY]: next }));
    emit({ type: 'herds_seen', cells: next.length, animals: seen.reduce((n, s) => n + s.n, 0) });
  } catch (e) { /* watchdog : ne crash jamais */ }
}

/**
 * La MARCHE vers la cellule : droit devant, par JAMBES de 64 blocs. Le pathfinder ne voit pas au-delà
 * des chunks chargés (view-distance 6 = 96 blocs) : un `goto` direct vers un but à 140 blocs rend NoPath
 * en quelques secondes (mesuré sur la migration de zone : `hop_failed moved:8`). `GoalNearXZ` rayon 16
 * (l'altitude est libre : un `GoalNear` 3D vers un point lointain = NoPath instantané en terrain vallonné)
 * et `canDig:false` (le bot suit la surface, il ne plonge ni dans une grotte ni dans une colline).
 *
 * BORNÉE de bout en bout : chaque jambe ≤ min(30 s, ce qui reste des `ms`) ET la boucle s'arrête dès
 * qu'il reste < 3 s — un plafond qui n'est pas appliqué est un plafond qui ment. Le jeton dérivé que
 * donne runHuntCook (tâche annulée / gibier en vue / but atteint) est relu entre deux jambes ET à 2 Hz
 * pendant une jambe : sans ce second point, un troupeau repéré à mi-jambe serait laissé derrière nous
 * avant que la jambe ne finisse. Une jambe qui n'avance pas dévie le cap (zone.legHeading) ; 2 de suite → on renonce.
 */
async function foodTripWalk({ cell, ms, token, maxLegs = FOOD_TRIP_MAX_LEGS }) {
  const t0 = Date.now();
  const left = () => ms - (Date.now() - t0);
  const p0 = bot.entity && bot.entity.position;
  const start = p0 ? { x: p0.x, z: p0.z } : null;
  let legs = 0;
  let stuck = 0;
  const watch = setInterval(() => {
    try { if (token.cancelled) stopMotion(); } catch (e) { /* watcher : ne crash jamais */ }
  }, 500);
  try {
    await withTempMovements(bot, Movements, { canDig: false }, async () => {
      while (!token.cancelled && legs < maxLegs && stuck < FOOD_TRIP_STUCK_MAX && left() > FOOD_TRIP_LEG_MIN_MS) {
        const p = bot.entity && bot.entity.position;
        if (!p) break;
        // COPIE des coordonnées AVANT la jambe : la référence `entity.position` n'est PAS fiable — la physique la
        // REMPLACE à chaque tick, mais le paquet `position` du serveur (téléport, rubber-band) la MUTE sur place
        // (Vec3.set). Comparer `pn` à un `p` gardé donnerait alors `moved` = 0 : la jambe passerait pour « sur
        // place » et 2 jambes suffiraient à abandonner la marche, quoi qu'il arrive (piège #61).
        const from = { x: p.x, z: p.z };
        const leg = foodTripLeg({ from, to: cell, stuck });
        if (!leg) break;                                              // arrivé
        legs++;
        const legMs = Math.min(FOOD_TRIP_LEG_MS, left());             // calculé AVANT le goto : le plafond d'une jambe ne dépend pas de ce que le goto fait
        await withTimeout(
          bot.pathfinder.goto(new pfGoals.GoalNearXZ(leg.x, leg.z, FOOD_TRIP_NEAR)),
          legMs, () => { try { stopMotion(); } catch (e) {} });
        const pn = bot.entity && bot.entity.position;
        const moved = pn ? Math.hypot(pn.x - from.x, pn.z - from.z) : 0;
        stuck = moved < LEG_STUCK_MIN ? stuck + 1 : 0;                // jambe sur place → cap dévié à la suivante
      }
    });
  } finally { clearInterval(watch); }
  const pe = bot.entity && bot.entity.position;
  const remaining = pe ? Math.hypot(pe.x - cell.x, pe.z - cell.z) : Infinity;
  const moved = (pe && start) ? Math.hypot(pe.x - start.x, pe.z - start.z) : 0;
  return { ok: true, arrived: remaining <= FOOD_TRIP_ARRIVED, legs, moved: Math.round(moved) };
}

// Stock de nourriture : chasse (UNE vague ≤ 45 s, SEULEMENT si une proie est EN VUE) → cuisson (four EN
// POCHE, ≥ 2 crus, du temps) → pêche locale (canne EN POCHE, eau ≤ 16 blocs, ≤ 40 s), le tout dans UN
// budget de 60 s. Massii 19/10 : « l'important c'est la VITESSE : pas de choix qui font trop durer, et
// dans le pire des cas il y a la viande de zombie ». L'enchaînement (quoi, dans quel ordre, sous quel
// plafond) vit dans foodRun.runHuntCook, testé avec des dépendances fausses ; ici, le câblage sur le
// vrai bot.
//
// RETIRÉ de cette chaîne (trop long pour ce qu'ils rapportent) : les 3 vagues de 120 s, le trajet vers
// l'eau connue (`fishTry` / `fishAtKnownWater`, jusqu'à 300 s ×2) et la chasse à la ficelle
// (`huntSpidersGoal`, 90 s). Ces fonctions restent définies plus bas, testées, simplement plus appelées
// d'ici (réutilisables pour un mode « expédition »). La ficelle vient désormais du ramassage
// opportuniste APRÈS un combat contre une araignée (cf. wireCombatLoot).
// 22/10 (pêche DURABLE, cf. food.js §4) : la canne FABRICABLE compte, la ficelle se prend à une araignée
// EN VUE (≤ 30 s dans le budget), et une chasse bredouille ouvre une séance de pêche de 75 s (hors
// budget, jamais avec l'expédition : même plafond, mêmes garde-fous `+ FOOD_TRIP_MS`).
//
// SEUL trajet lointain conservé : l'EXPÉDITION vers le gibier (foodTrip*, juste au-dessus) — à vraie
// faim (< 6 points), de jour, en surface, quand AUCUN passif n'est à ≤ 32 blocs. Sans elle la chasse ne
// part jamais (rien en vue) et le bot reste à 0 point. Plafond propre de 75 s, HORS du budget de 60 s
// (les garde-fous des appelants portent donc `+ FOOD_TRIP_MS`).
//
// `opts` : { budget?, budgetMs?, waves=1, huntMs=45000, goalPoints? }. `waves` reste réglable pour qui
// veut EXPLICITEMENT davantage ; aucun appelant actuel (kit, hook de descente, démarrage mappeur,
// ensureFood) n'a jamais justifié les 3 vagues par un commentaire → tous passent à 1.
async function huntCookGoal(target, opts = {}) {
  // JETON CAPTURÉ à l'entrée (fix 18/08) : `taskToken` est un GLOBAL relu tard. Si une migration prend
  // la main pendant la chasse, le relire donnerait le jeton VIVANT de la migration — et la chasse
  // repartirait par-dessus ses jambes.
  const tok = taskToken;
  _huntCookBusy++;
  try {
    return await runHuntCook({
      token: tok,
      inventory: () => buildCtxInv(bot),
      passiveInView: () => { try { return !!nearestPassive(bot, HUNT_SIGHT_RADIUS); } catch (e) { return false; } },
      // Le plafond est RÉEL : à l'expiration `cancel()` coupe le jeton dérivé que huntPassive relit à
      // chaque proie (withTimeout seul rend la main mais laisse la chasse tourner en fond).
      hunt: ({ count, token, ms, cancel }) => withTimeout(
        huntPassive(bot, { count, maxDistance: HUNT_SIGHT_RADIUS }, token),
        ms, () => { try { cancel(); } catch (e) {} try { stopMotion(); } catch (e) {} }),
      // Piles de viande crue, la plus abondante d'abord : le four se pose (puis se reprend) une fois par
      // TYPE de viande, on cuit donc le plus gros tas en premier.
      rawStacks: () => Object.entries(RAW2COOKED)
        .map(([name, out]) => ({ name, out, count: _invTotal((i) => i.name === name) }))
        .filter((st) => st.count > 0)
        .sort((a, b) => b.count - a.count),
      // Cuisson du LOT (23/10, cookMeat.js) : remplace l'étape « cuire pour atteindre le but » — on cuit
      // ≥ 3 crus quel que soit le but, hors du budget de 60 s (plafond propre ~45 s).
      cookLot: () => cookMeatLot('hunt'),
      hasFurnace: () => _invTotal((i) => i.name === 'furnace') > 0,
      cook: async ({ name, out, count, maxMs }) => {
        // Sans combustible, la fonte est impossible : ne pas poser puis reprendre un four (~5-8 s) pour
        // rien. Même mesure que `smelt` (fuelUnits : charbon 8, bois 1,5).
        let fuel = 0;
        try { fuel = fuelUnits(bot.inventory.items(), fuelNames()); } catch (e) { fuel = 0; }
        if (!(fuel >= 1)) return 0;
        const r = await smeltWithFurnace(name, out, count, undefined, { maxMs });
        return (r && (r.got || (r.ok ? count : 0))) || 0;
      },
      hasRod: () => _invTotal((i) => i.name === 'fishing_rod') > 0,
      // PÊCHE DURABLE (22/10, cf. food.js §4) : une canne FABRICABLE compte (fishCatch la fabrique avec
      // craftSmart), la ficelle se prend à une araignée EN VUE (≤ 24 blocs, ≤ 30 s), et une chasse
      // bredouille ouvre une SÉANCE de 75 s jusqu'à 48 blocs de berge.
      canCraftRod: () => { try { return rodPlan(bot.inventory.items()).craft === true; } catch (e) { return false; } },
      fishSession: true,
      spiderInView: () => { try { return !!nearestSpider(bot, STRING_HUNT_RADIUS); } catch (e) { return false; } },
      stringCount: () => _invTotal((i) => i.name === 'string'),
      health: () => bot.health,
      huntString: ({ ms, token, cancel }) => withTimeout(
        huntSpidersGoal({ token, totalMs: ms, maxDistance: STRING_HUNT_RADIUS, count: 2 }),
        ms + 3000, () => { try { cancel(); } catch (e) {} try { stopMotion(); } catch (e) {} }),
      // Pêche d'appoint LOCALE : eau à ≤ FISH_RADIUS (sinon `no_water` aussitôt, sans voyage), trajet vers
      // la berge ≤ 12 s, une prise ≤ 20 s, le tout ≤ ms. En SÉANCE : berge ≤ 48 blocs (≤ 20 s de marche,
      // décomptés de la séance), une touche ≤ 32 s (vanilla : 30 s au plus), 3 lancers morts avant d'abandonner.
      fish: ({ ms, token, cancel, session, target }) => withTimeout(
        fishGoal(session ? (target || FISH_TARGET) : FISH_TARGET, session
          ? { token, maxDistance: FISH_SESSION_RADIUS, totalMs: Math.max(FISH_MIN_MS, ms - FISH_SESSION_GOTO_MS),
            perCatchMs: FISH_SESSION_CATCH_MS, gotoMs: FISH_SESSION_GOTO_MS, maxMisses: FISH_SESSION_MISSES }
          : { token, maxDistance: FISH_RADIUS, totalMs: ms, perCatchMs: 20000, gotoMs: 12000 }),
        ms + 3000, () => { try { cancel(); } catch (e) {} try { stopMotion(); } catch (e) {} }),
      // EXPÉDITION VERS LE GIBIER (cf. foodTrip* plus haut) : aucun passif à ≤ 32 blocs + vraie faim +
      // jour + surface → une marche vers la cellule à animaux la plus proche connue, puis la chasse
      // ci-dessus rejoue sur place. Toujours câblée : TOUS les appelants (timer, kit, descente, mappeur) y passent.
      tripState: () => foodTripState(),
      grazingCell: (o) => foodTripCell(o),
      tripLock: () => foodTripLock(),
      tripUnlock: () => foodTripUnlock(),
      tripWalk: (o) => foodTripWalk(o),
      tripTried: (cell) => foodTripMark(cell),
      huntFailed: () => foodTripMarkNearHerd(),
      tripOutcome: (o) => foodTripOutcome(o),
      // Arrivé au troupeau : faire le PLEIN (≥ 20 points, 3 vagues), pas un repas (24/10).
      tripFill: true,
      emit,
    }, target, opts);
  } finally { _huntCookBusy--; }
}

// PÊCHE — plan B nourriture quand la zone est vidée de ses proies (20+ « starved to death » en 3 h
// de run réel : huntCook était le SEUL plan et échoue à 100 % une fois le gibier épuisé). Le poisson
// ne s'épuise pas, mord la nuit, ne rend pas les coups. Borné/annulable (#47d).
// `o` : options de fishCatch qui surchargent les défauts (rayon, durées, jeton) — la sortie
// « nourriture » les resserre (eau ≤ 16 blocs, ≤ 40 s) ; le skill `fish` garde les défauts.
async function fishGoal(target = 4, o = {}) {
  return fishCatch(bot, {
    craft: (a) => craftSmart(a),
    goto: (p) => bot.pathfinder.goto(new pfGoals.GoalNear(p.x, p.y, p.z, 1)),
    emit,
    sleep,
  }, Object.assign({ target, token: taskToken }, o));
}

// ═══ LES TROIS MAILLONS CI-DESSOUS (`fishTry`, `fishAtKnownWater`, `huntSpidersGoal`) NE SONT PLUS
// APPELÉS depuis le 19/10 (Massii : « l'important c'est la VITESSE : pas de choix qui font trop durer »).
// Dans la sortie nourriture ils coûtaient jusqu'à 300 s (pêche) + 300 s (trajet vers l'eau connue) +
// 90 s (chasse à la ficelle) pour un bot qui ne travaille pas ; la chaîne actuelle (huntCookGoal) ne
// pêche plus que LOCALEMENT, avec une canne déjà en poche. Gardés ici — testés via leurs modules purs
// (skills/huntSpiders.js, waterfind.js, caution.js) — pour un éventuel mode « expédition » : si on les
// rebranche, la mémoire des zones sans araignée (spiderHuntStreak) devra vivre au NIVEAU MODULE
// (piège #56/#52a : un back-off dans une variable locale ne se déclenche jamais).
// ── PLAN B-bis (v7) — PÊCHER, ET SI L'EAU MANQUE, ALLER LÀ OÙ ELLE EST.
// Le plan B a été appelé 737 fois sur le run world_mn15 pour ZÉRO poisson : `fishCatch` ne cherche
// l'eau qu'à 24 blocs, et un puits de mine n'est presque jamais au bord d'une rivière (`no_water`).
// Le mécanisme tournait donc à vide — alors que la flotte SAIT où est l'eau, les cartographes
// peignant les cellules océan/rivière dans la carte partagée (#52b).
// UN SEUL point d'entrée pour toute la chaîne nourriture : les DEUX endroits qui pêchent (le plan B
// et la reprise après la chasse à la ficelle) passent par ici, sinon l'un des deux se refermerait
// sur `no_water` sans jamais tenter le voyage — le trou qu'on répare, reproduit à l'identique.
// `no_water` implique que la canne était en main (fishCatch la vérifie AVANT l'eau) : rien à
// redoubler. Un échec de voyage ne casse rien : on rend le résultat de la pêche d'origine.
async function fishTry(target) {
  const here = await withTimeout(fishGoal(target), 300000, () => { try { stopMotion(); } catch (e) {} });
  if (taskToken.cancelled || !here || here.reason !== 'no_water') return here;
  const away = await withTimeout(fishAtKnownWater(target), 300000, () => { try { stopMotion(); } catch (e) {} });
  if (taskToken.cancelled) return here;
  // `withTimeout` rend `{ok:false, reason:'timeout'}` : on ne remplace le résultat que par un VRAI
  // retour de fishCatch (celui-là seul porte `caught`), jamais par un verdict d'horloge.
  return (away && away.caught != null) ? away : here;
}

// v7 — ALLER À L'EAU CONNUE. Le trajet, puis la ligne, une seule fois et borné de bout en bout.
// La carte du groupe porte les cellules de biome peintes par les cartographes (océan/rivière
// compris depuis #52b) : `nearestWater` en tire un point où marcher, on y va, on relance la pêche
// avec un rayon ÉLARGI — on arrive dans la CELLULE, pas sur la berge, et 24 blocs ne suffisent pas
// à la retrouver. 48 = la portée du cache client (view-distance 6 → 96 blocs), donc de la vraie
// donnée, pas une extrapolation.
// ⚠️ LE BOT N'ENTRE JAMAIS DANS L'EAU (la noyade est le premier tueur du projet) : c'est
// `pickFishingSpot` qui élit la berge, et si le trajet nous a posés dedans on se dégage d'abord —
// même réflexe qu'en tête de `runGoalSkill`.
async function fishAtKnownWater(target = 4) {
  const me = bot.entity && bot.entity.position;
  if (!me) return null;
  // JAMAIS depuis le fond : `GoalNearXZ` laisse l'altitude libre (le pathfinder plonge volontiers,
  // cf. la note de migrationLegTo) et une rivière visée depuis y=12 se marche EN SOUS-SOL. Sous
  // terre, c'est `surfaceTripNeeded` qui fait remonter d'abord — un warp, pas un trek.
  if (me.y < FOOD_SURFACE_Y) {
    emit({ type: 'fish_travel', ok: false, reason: 'underground', y: Math.round(me.y) });
    return null;
  }
  const mem = (args['wm-live'] && args['world-memory']) ? loadMemory(args['world-memory']) : bot._worldMemory;
  const spot = nearestWater({ memory: mem, worldKey: bot._worldKey, pos: me, maxDist: WATER_TRIP_MAX });
  if (!spot) { emit({ type: 'fish_travel', ok: false, reason: 'no_known_water' }); return null; }
  const dist = Math.round(spot.dist);
  emit({ type: 'fish_travel', x: spot.x, z: spot.z, dist, biome: spot.biome });
  if (dist > 2) {   // déjà dans la cellule : le voyage est un no-op, seul le rayon élargi compte
    const trip = await withTimeout(
      bot.pathfinder.goto(new pfGoals.GoalNearXZ(spot.x, spot.z, 8)),
      120000, () => { try { stopMotion(); } catch (e) {} });
    if (taskToken.cancelled) return null;
    // Un trajet raté ne fait pas tomber la tentative : on a pu s'approcher assez pour voir l'eau.
    if (trip && trip.ok === false) emit({ type: 'fish_travel', ok: false, reason: trip.reason, dist });
  }
  try { if (isInWater(bot)) await escapeWater(bot, { emit }); } catch (e) { /* best-effort */ }
  if (taskToken.cancelled) return null;
  return fishCatch(bot, {
    craft: (a) => craftSmart(a),
    goto: (p) => bot.pathfinder.goto(new pfGoals.GoalNear(p.x, p.y, p.z, 1)),
    emit,
    sleep,
  }, { target, token: taskToken, maxDistance: 48, totalMs: 120000 });
}

// FICELLE — le maillon qui manquait entre « la chasse ne donne plus rien » et « la pêche ne peut
// pas démarrer ». `lootNearby` est branché en balayage de butin : sans lui la ficelle reste au sol
// et l'araignée aura été tuée pour rien (c'est exactement ce qui laissait `no_rod` éternel).
async function huntSpidersGoal(opts = {}) {
  return huntSpiders(bot, {
    loot: (o) => lootNearby(o),
    goto: (p) => bot.pathfinder.goto(new pfGoals.GoalNear(p.x, p.y, p.z, 1)),
    emit,
    sleep,
  }, Object.assign({ token: taskToken }, opts));
}

// Déclencheur du TRAJET BOIS de runGoalSkill (/home safe vers la surface), extrait pour être testé
// par extraction (discipline de nuit, 19/10 soir). Conditions d'origine inchangées : sans-give, but de
// bois (ou besoin de bois prouvé), sous la surface (y < 62), au plus un aller-retour par 2 min.
// DISCIPLINE DE NUIT : nu de nuit, pas de téléport vers la SURFACE — le skill est tenté sur place (sous
// terre le planner ne lance déjà plus `gatherLog`, cf. caution.NIGHT_SURFACE_SKILLS ; restent les
// crafts de bois, qui marchent si les bûches sont en poche). Cooldown NON consommé : à l'aube le
// trajet part au premier but de bois.
function woodTripWanted(goal) {
  if (!NO_GIVE || !goal) return false;
  if (!(WOOD_GOALS.has(goal.name) || _needsWoodTrip)) return false;
  // LATCH ≠ BUT DE MINAGE (world_oct23 24/10, NethBot2/NethBot3) : un échec bois ancien laissait le latch
  // armé et le trajet partait pour `iron_deep` → /home safe en surface → branchMine `wrong_depth` (startY
  // 67/80, targetY 16) → latch effacé sans bûche → /home work. Le minage ne consomme pas de bois : on reste
  // au fond, le latch reste armé pour le prochain but qui en exige (craft, pioche…).
  if (!WOOD_GOALS.has(goal.name) && goal.skill && WOOD_TRIP_NEVER_SKILLS.has(goal.skill)) return false;
  const p = bot.entity && bot.entity.position;
  if (!p || !(p.y < 62)) return false;
  if ((Date.now() - _lastWoodTripAt) <= 120000) return false;
  if (nightLockdownNow()) { nightGateNote('wood_trip', { goal: goal.name }); return false; }
  return true;
}

// Dispatch d'un but de la chaîne vers le skill réel (0 token).
// ─── PIERRE « COMME UN JOUEUR » (21/10, cf. stoneDig.js) ─────────────────────────────────────────
// 1) ESCALIER : avec une pioche, on creuse un escalier 1×2 (descendDiagonal) jusqu'à avoir le LOT en
//    poche — chaque palier mine la marche et la tête, la pierre tombe devant et se ramasse en avançant.
//    Plus de collectBlock vers une pierre à 60 blocs dans une colline, plus d'exploration de surface.
// 2) REPLI (eau/lave/vide devant, pas de pioche, déjà au fond) : l'ancien chemin, pour ce qui manque.
async function gatherStone(goal) {
  const tok = taskToken;                                   // CAPTURÉ (une préemption ne nous le vole pas)
  const items = () => (bot.inventory && bot.inventory.items()) || [];
  const cobble = () => items().reduce((n, i) => n + (i && i.name === 'cobblestone' ? i.count : 0), 0);
  const count = Number(goal.args && goal.args.count) || 1;
  const tier = pickTier(items());
  const have0 = cobble();
  const want = stoneBatchWant({ count, have: have0, tier, isMapper: IS_MAPPER });
  const p = bot.entity && bot.entity.position;
  const plan = stoneStairPlan({ y: p ? p.y : undefined, tier });
  let got = 0;
  if (plan) {
    const t0 = Date.now();
    let rs = null;
    try {
      rs = await descendDiagonal(bot, Object.assign({}, plan, {
        stopWhen: () => cobble() - have0 >= want,
        // Survie LÉGÈRE seulement (combat/fuite/manger) : ni torches (miner du charbon désaligne
        // l'escalier, cf. descendDiagonal) ni tossJunk (il jetterait le cobble qu'on vient chercher).
        onSurvivalTick: async () => {
          try { await survivalTick(bot, { fleeFrom: skeletonFirstFlee, emit, ...fightGateDeps() }); } catch (e) {}
          try { await eat(bot); } catch (e) {}
        },
        survivalEvery: 4,
      }), tok);
    } catch (e) { rs = { ok: false, reason: 'error' }; }
    got = Math.max(0, cobble() - have0);
    emit({ type: 'stone_stair', goal: goal.name, want, got, ok: !!(rs && rs.ok), reason: (rs && rs.reason) || null,
      stopped: !!(rs && rs.stopped), took_ms: Date.now() - t0 });
    if (tok.cancelled) return { ok: got > 0, got, cancelled: true };
    if (got >= Math.min(want, count)) return { ok: true, got };
  }
  // Repli historique : pas de pierre visible ≤ 32 → creuser 4 blocs puis miner sur place.
  const def = bot.registry.blocksByName.stone;
  if (def && !bot.findBlock({ matching: [def.id], maxDistance: 32 })) {
    await mineDown(bot, { count: 4, land: true }, tok);   // `count` (pas `depth`, ignoré : 1 seul bloc creusé) + atterrissage entre deux coups
    if (tok.cancelled) return { ok: false, reason: 'cancelled' };
  }
  const r = await gather(bot, { ...goal.args, count: Math.max(1, count - got), explore: true }, tok);
  if (got > 0 && r && r.ok === false) return { ok: true, got };   // le lot partiel de l'escalier compte
  return r;
}

/** Repli du but « minerai de fer » (diamondPhase.ironGatherPlan) : descente à Y16 si besoin, puis
 *  branch-mine qui s'arrête dès que le fer manquant (pioche fer : 3 bruts) est ramassé. Passe par
 *  runGoalSkill (mêmes pré-hooks : /home work, armure-avant-profondeur, four de mine, lacets…). */
async function ironGatherBranch(goal, plan, gen) {
  const _gen = gen != null ? gen : _lifeGen;
  emit({ type: 'iron_gather_fallback', goal: goal.name, action: plan.action, fails: plan.fails,
    y: bot.entity && bot.entity.position ? Math.round(bot.entity.position.y) : null });
  if (plan.action === 'descend_then_branch') {
    const rD = await runGoalSkill({ name: goal.name, skill: 'descendDiagonal', args: plan.descendArgs }, _gen);
    if (lifeStale(_gen) || taskToken.cancelled) return rD;
    const yy = bot.entity && bot.entity.position ? bot.entity.position.y : 99;
    if (!(yy <= plan.branchArgs.targetY + 2)) return (rD && rD.ok === false) ? rD : { ok: false, reason: 'wrong_depth' };
  }
  let left = 3;
  try { left = Math.max(1, 3 - (buildCtxInv(bot).raw_iron || 0)); } catch (e) { left = 3; }
  const args = Object.assign({}, plan.branchArgs, { stopOre: { items: ['raw_iron'], count: left } });
  return runGoalSkill({ name: goal.name, skill: 'branchMine', args }, _gen);
}

async function runGoalSkill(goal, gen) {
  const _gen = gen != null ? gen : _lifeGen;   // vie du lancement (cf. _lifeGen, runSkillWithTelemetry)
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
  // HOME CAMPÉ (19/10) : le bois est en surface, mais pas dans le camp qui vient de nous tuer — campé
  // de nuit ou avec un hostile signalé là-haut, pas de trajet (ni signet de chantier) : on tente le
  // skill sur place, et le besoin de bois reste armé pour la prochaine passe (cooldown 2 min).
  if (woodTripWanted(goal)) {
    _lastWoodTripAt = Date.now();
    if (!safeHomeVeto('wood_trip')) {
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
        await safeWarpHome('safe', { ctx: 'wood_trip' });   // surface : c'est là qu'il y a des arbres et de quoi crafter
      } catch (e) { /* best-effort : à défaut on tente le skill sur place, comportement d'avant */ }
    }
  }
  // ARMURE-AVANT-PROFONDEUR pour le chemin planner (chaîne diamant + kit mappeur, hole A §1.3) :
  // avant une descente/branche, tente armure+bouclier (best-effort, borné, idempotent si déjà armé).
  if (goal.skill === 'descendDiagonal' || goal.skill === 'branchMine' || goal.skill === 'caveIron') {
    try { await withTimeout(armorUp(), 120000, () => { try { stopMotion(); } catch (e) {} }); } catch (e) {}
    // TORCHES AVANT DE DESCENDRE : sans charbon, une bûche au four (cf. ensureTorches). En surface seulement.
    if (goal.skill === 'descendDiagonal') {
      const _yT = bot.entity && bot.entity.position ? bot.entity.position.y : 0;
      if (_yT >= 45) { try { await withTimeout(ensureTorches({ charcoal: true }), 45000, () => { try { stopMotion(); } catch (e) {} }); } catch (e) {} }
    }
    // Sans-give : chasse best-effort AVANT la descente (bornée à 70 s, jamais bloquante — cf. goals.js,
    // le but food_stock bloquant stallait à vie sur no_prey). Surface seulement. Compté en POINTS
    // (cru et chair putréfiée comprises) : 12 points en poche, on descend sans chasser. Et sans proie
    // en vue, huntCookGoal rend la main aussitôt (il ne lance plus de pêche ni de trajet lointain) —
    // SAUF à vraie faim (< 6 points), de jour : l'EXPÉDITION vers le gibier (≤ 75 s de marche en plus,
    // d'où `+ FOOD_TRIP_MS` : sous terre il n'y a plus un seul animal, c'est ICI ou jamais).
    if (NO_GIVE && goal.skill === 'descendDiagonal') {
      const _y = bot.entity && bot.entity.position ? bot.entity.position.y : 0;
      let _hunt = null;
      if (_y >= 45 && foodPoints(buildCtxInv(bot)) < STOCK_POINTS) {
        try { _hunt = await withTimeout(huntCookGoal(4), HUNT_COOK_TIMEOUT_MS + FOOD_TRIP_MS + FOOD_TRIP_LONG_EXTRA_MS + COOK_LOT_HARD_MS, () => { try { stopMotion(); } catch (e) {} }); } catch (e) {}
      }
      // PORTE NOURRITURE (run 20/10 : 4 « starved to death », toujours `hunt_cook_done before:0`) :
      // la chasse ci-dessus a eu sa chance ; sans DESCENT_MIN_POINTS en poche on ne descend pas
      // encore — au plus 2 refus / 10 min (persistés), ensuite on descend quand même (cf. foodGate.js).
      // Chasse qui n'a vu AUCUNE proie (`no_prey:no_passive`, run 21/10 : 12 refus sur 17) → refuser ne
      // rapporterait rien, on descend tout de suite.
      if (!descentFoodGateCheck({ noPrey: huntSawNoPrey(_hunt) })) return { ok: false, reason: 'food_gate' };
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
        // Et on ne se relogue JAMAIS sur un chantier déjà banni (noyade OU mort répétée, cf.
        // deathspots.js) : on repousse jusqu'à sortir.
        for (let k = 0; k < 6 && (isDrownedNear(_drownedSites, { x: _tx, z: _tz }, Date.now()) || deathSpots.isBanned(_tx, _tz)); k++) {
          _drownedOffsetSeed += 1;
          const alt = offsetFromDrowned({ x: _tx, z: _tz }, _drownedOffsetSeed);
          _tx = alt.x; _tz = alt.z;
        }
        emit({ type: 'descend_relocate', x: _tx, z: _tz, fails: _descendWaterFails });
        // GoalNearXZ, PAS GoalNear à l'altitude courante (piège #72b) : en terrain vallonné le but 3D
        // était insatisfiable → NoPath instantané → le bot ne bougeait pas (vécu 21/10 : `descend_relocate`
        // puis `unjam` au MÊME point (298,63,334), et le puits suivant re-percé au même endroit).
        try { await withTimeout(bot.pathfinder.goto(new pfGoals.GoalNearXZ(_tx, _tz, 3)), 60000, () => { try { stopMotion(); } catch (e) {} }); } catch (e) {}
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
    // Bois SANS MOURIR (run 10) : repli à l'abri si un hostile menace un bot nu, exploration courte.
    // collectTimeoutMs (bûcheron, 20/10) : une bûche hors d'atteinte gelait le collect 90 s ×2 = tout le budget.
    const _ct = Number(goal.args && goal.args.collectTimeoutMs) > 0 ? { collectTimeoutMs: Number(goal.args.collectTimeoutMs) } : {};
    return gatherWoodSafely(Object.assign({ name: logNames.length ? logNames : 'oak_log', count: _count, explore: true }, _ct));
  }
  // explore:true sur les gather de la chaîne autonome (bois/pierre/minerai) → le bot va chercher
  // la ressource si elle n'est pas dans le voisinage. (Les gather opportunistes internes — branchMine
  // maxDistance:6 — appellent gather() directement SANS explore → pas de roaming en plein tunnel.)
  if (goal.skill === 'gather') {
    // PIERRE : inutile de roamer (timeouts ×3 vécus Surv6) — la couche de pierre est à 3-5 blocs
    // sous l'herbe PARTOUT → pas de pierre visible ≤32 ? on creuse 4 blocs et on mine sur place.
    if (goal.args.name === 'stone') return gatherStone(goal);
    // FER INTROUVABLE (24/10 soir, NethBot3 à y -53 : `iron_ore not_found` ×21 en 10 min) : au 3e not_found
    // de la fenêtre, on CREUSE (branch-mine, descente à Y16 d'abord si plus haut) au lieu d'explorer.
    if (isIronOreGather(goal)) {
      // FER VISIBLE D'ABORD (24/10) : le fer exposé VU (ou mappé) à ≤ 64 blocs avant la récolte en
      // exploration et avant le branch-mine de repli — un mineur à -54 prend le deepslate_iron_ore de la grotte.
      const _rc = await ironCaveBeforeGather(goal);
      if (_rc) return _rc;
      if (lifeStale(_gen) || taskToken.cancelled) return { ok: false, reason: 'cancelled' };
      const _y = bot.entity && bot.entity.position ? bot.entity.position.y : undefined;
      const plan = ironGatherPlan({ times: _ironGatherFails, now: Date.now(), y: _y });
      if (plan) return await ironGatherBranch(goal, plan, _gen);
    }
    _exploreBusy = true;
    let _gr;
    try { _gr = await gather(bot, { ...goal.args, explore: true }, taskToken); }
    finally { _exploreBusy = false; }
    if (isIronOreGather(goal) && _gr && _gr.ok === false && _gr.reason === 'not_found') {
      _ironGatherFails = noteIronGatherFail(_ironGatherFails, Date.now());
    }
    return _gr;
  }
  if (goal.skill === 'craftPlanks') {
    // logBase exclut les bûches écorcées (stripped_*) : minecraft-data n'a aucune recette
    // stripped_X_log → X_planks, les nommer ainsi crafte un item INEXISTANT (unknown_item,
    // boucle infinie — vécu live MapBot2 session-113/108, cf. craftPlan.test.js).
    const log = bot.inventory.items().find((i) => logBase(i.name));
    if (!log) return { ok: false, reason: 'not_found' };
    // ne pas sur-demander : convertir au plus le nb de bûches de cette essence (sinon bot.craft throw)
    const same = bot.inventory.items().filter((i) => i.name === log.name).reduce((s, i) => s + i.count, 0);
    return craftItem(bot, { name: logBase(log.name) + '_planks', count: Math.min(goal.args.count || 1, same) });
  }
  if (goal.skill === 'craft') {
    // torches : adapter le nb de lots au charbon disponible (1 charbon → 1 lot de 4 au lieu d'un
    // craft_failed ; le but torches reste unmet → la chaîne refait du charbon puis le 2e lot).
    if (goal.name === 'dia_pick') return craftDiamondPick(goal);
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
  if (goal.skill === 'ensureBed') return ensureBedGoal();
  if (goal.skill === 'fish') return fishGoal(goal.args.target || 4);
  if (goal.skill === 'descendDiagonal') {
    // FIX churn re-descente (NO_GIVE) : un chantier profond SEC est mémorisé → y retourner par
    // /home work (1 tp) plutôt que re-creuser ~52 blocs (chaque re-descente cassait une pioche pierre
    // → no_pickaxe → le fer ne s'accumulait jamais). water_rescue ramenait en SURFACE, forçant cette
    // re-descente : c'est LE moteur du churn. Garde : si le tp atterrit dans l'eau, le chantier est noyé
    // → on l'oublie et on re-creuse (qui relocalise au sec via _descendWaterFails).
    // Mort pendant les pré-hooks (chasse, armure…) : pas de /home work vers le chantier de l'autre vie.
    if (lifeStale(_gen)) return dropStaleTask('descendDiagonal', _gen);
    // CHANTIER DE DIAMANT PERSISTÉ (deepWork.js, 24/10) : survit à la mort, contrairement à `_workSet`.
    // Profond, récent, pas un camp de mort → /home work AVANT tout escalier.
    if (NO_GIVE && bot.entity && bot.entity.position) {
      const _dw = _loadDeepWork();
      const _p0 = bot.entity.position;
      let _deaths = [];
      try { _deaths = _recentDeathPositions(); } catch (e) { _deaths = []; }
      const plan = deepWorkWarpPlan({ deepWork: _dw, pos: { x: _p0.x, y: _p0.y, z: _p0.z }, now: Date.now(), deaths: _deaths });
      if (plan.warp) {
        emit({ type: 'descend_via_deep_work', x: _dw.x, y: _dw.y, z: _dw.z, from_y: Math.round(_p0.y) });
        _stairDepth++;
        try {
          try { homewarp.goHome(bot, HOME_WORK); } catch (e) {}
          await awaitWarp({ maxMs: 8000 });
          await sleep(1200);
        } finally { _stairDepth = Math.max(0, _stairDepth - 1); }
        if (lifeStale(_gen)) return dropStaleTask('descendDiagonal', _gen);
        const _pl = bot.entity && bot.entity.position;
        const landed = _pl ? { x: _pl.x, y: _pl.y, z: _pl.z } : null;
        let _wet = false;
        try { _wet = isInWater(bot); } catch (e) { _wet = false; }
        if (landed && deepWorkLanded(_dw, landed) && !_wet) {
          _workSet = true; _workPos = _botXZ();
          emit({ type: 'deep_work_landed', y: Math.round(landed.y) });
          return { ok: true, viaHome: true };
        }
        // Pas arrivé au chantier (TP refusé, home déplacé, atterrissage mouillé) : on l'oublie, escalier.
        _forgetDeepWork(_wet ? 'landed_wet' : 'not_landed');
        if (_wet) { try { await escapeWater(bot, { emit }); } catch (e) {} }
      } else if (plan.why === 'camped') {
        emit({ type: 'deep_work_camped', x: _dw.x, y: _dw.y, z: _dw.z });
      }
    }
    if (NO_GIVE && _workSet && bot.entity && bot.entity.position && bot.entity.position.y > 30) {
      emit({ type: 'descend_via_home_work' });
      // Pendant l'attente du TP + le settle (jusqu'à ~9 s), l'escalier compte déjà comme en cours : le
      // ramassage opportuniste ne part pas marcher/creuser le charbon du chantier (cf. _stairDepth).
      _stairDepth++;
      try {
        try { homewarp.goHome(bot, HOME_WORK); } catch (e) {}
        await awaitWarp({ maxMs: 8000 }); // atterrissage OU warmup teleport-delay couvert (remplace le sleep aveugle)
        await sleep(1200);                // settle chunks post-tp
      } finally { _stairDepth = Math.max(0, _stairDepth - 1); }
      const _py = (bot.entity && bot.entity.position) ? bot.entity.position.y : 99;
      if (isInWater(bot)) { _workSet = false; _forgetDeepWork('landed_wet'); try { await escapeWater(bot, { emit }); } catch (e) {} }
      else if (_py <= 20) return { ok: true, viaHome: true };  // arrivé profond & sec → pas de re-creusage
    }
    // Cap imposé par un `drop_ahead` répété (descendDiagonal prend son cap dans le yaw) : appliqué ICI,
    // juste avant l'appel — les pré-hooks (armure, chasse, steering) ont pu tourner la tête entre-temps.
    await applyDescendHeading();
    let r = await descendDiagonal(bot, goal.args || {}, taskToken);
    // Mort pendant la descente : rien de ce qui suit (bookmark `work` AU POINT DE RÉAPPARITION, cap, échecs).
    if (lifeStale(_gen)) return dropStaleTask('descendDiagonal', _gen);
    // Pioche cassée dans l'escalier : la refaire SUR PLACE et reprendre la descente (21/10).
    if (r && r.ok === false && r.reason === 'no_pickaxe' && !taskToken.cancelled && await rebuildPickHere('descend')) {
      r = await descendDiagonal(bot, goal.args || {}, taskToken);
      if (lifeStale(_gen)) return dropStaleTask('descendDiagonal', _gen);
    }
    // Pioche absente ET irremplaçable (23/10, NethBot1 : 55 min de descend_y16 en boucle) : le dire, une
    // raison distincte (le planner ne relance pas la même descente comme si c'était un accident de terrain).
    if (r && r.ok === false && r.reason === 'no_pickaxe' && !taskToken.cancelled) {
      const why = noPickStuckWhy();
      if (Date.now() - _noPickStuckAt >= 60000) { _noPickStuckAt = Date.now(); emit({ type: 'no_pick_stuck', why, goal: goal.name }); }
      return { ok: false, reason: 'no_pick_stuck', why };
    }
    // `drop_ahead` (vide devant, pont impossible) : relancer du même point avec le même regard = même
    // échec garanti (vécu ×4 en 5 ms). Au 2e au même endroit on tourne, au 4e on se décale (dropAhead.js).
    // `no_progress` / `max_depth` (21/10, NethBot3 : `max_depth` ×19 au même endroit en 10-20 s chacun —
    // surplace, cf. descendDiagonal) sont POSITIONNELS comme `drop_ahead` : même règle de cap/décalage.
    if (r && r.ok === false && DESCEND_POSITIONAL_RE.test(String(r.reason || ''))) await onDropAhead(r.reason);
    // suivi des échecs EAU → le pré-hook ci-dessus décale le prochain essai (anti re-perçage d'aquifère)
    if (r && r.ok === false && /water|flood|drown/i.test(String(r.reason || ''))) _descendWaterFails++;
    else if (r && r.ok) {
      _descendHeading = null;
      _descendWaterFails = 0;
      _workStuckTimes = [];
      // chantier profond atteint & SEC → mémoriser (les re-descentes suivantes = /home work, pas de creusage)
      if (NO_GIVE && !isInWater(bot)) { try { homewarp.bookmark(bot, HOME_WORK); } catch (e) {} _workSet = true; _workPos = _botXZ(); _workDrownTimes = []; emit({ type: 'work_bookmarked' }); }
    } else if (NO_GIVE && _workSet && r && r.ok === false && /drop_ahead|max_depth|no_progress|air_at_y|lava_ahead/i.test(String(r.reason || ''))) {
      // Le chantier mène en boucle à une impasse SÈCHE (grotte/vide/lave minée autour du puits) : miroir
      // SEC de workDrown (live NethBot4 world_mn9 : 15× descend_via_home_work→drop_ahead, 0 minerai).
      // Au seuil, on OUBLIE le chantier + on ARME le relocate (_descendWaterFails) → la re-descente creuse
      // un puits FRAIS 30-50 blocs plus loin au lieu de /home work → même drop_ahead.
      const s = recordWorkStuck(_workStuckTimes, Date.now());
      _workStuckTimes = s.times;
      if (s.abandon) { _workSet = false; _forgetDeepWork('stuck'); _descendWaterFails++; emit({ type: 'work_abandoned_stuck', reason: r.reason }); }
    }
    return r;
  }
  // CAVE-FIRST (Massii, live 26/07). On chasse le diamant DANS LES GROTTES : uniquement des
  // minerais mappés, EXPOSÉS et SECS (`caveHunt` impose exposedOnly + excludeWet). Le creusement
  // n'est plus la stratégie mais le TRAJET : quand plus aucune cible n'est visible, on enchaîne un
  // tunnel COURT (16 blocs, 4 galeries) vers la zone suivante — pas le strip de 48 × 16 d'avant.
  // FER EN GROTTE (Massii 20/10) : cf. runCaveIron (niveau module) et caveIron.js.
  if (goal.skill === 'caveIron') return await runCaveIron();
  if (goal.skill === 'caveHunt') {
    const memCH = (args['wm-live'] && args['world-memory']) ? loadMemory(args['world-memory']) : bot._worldMemory;
    const _count = (name) => ((bot.inventory && bot.inventory.items()) || [])
      .reduce((s, i) => s + (i.name === name ? i.count : 0), 0);
    const tokCH = taskToken;                   // CAPTURÉ : une préemption ne nous le vole pas
    let rCH;
    _diamondHuntBusy = true;                   // le détour du ramassage ne repose plus son but sur notre approche
    try {
      rCH = await caveHunt(bot, Object.assign({
        emit,
        memory: memCH,
        world: String(bot._worldKey || 'overworld'),
        // Inatteignables mémorisées ENTRE deux reprises du but (TTL 20 min, 24/10 : 203 cave_unreachable
        // pour 91 cibles distinctes, les mêmes retentées à chaque reprise) — par GRAPPE (rayon 4).
        skipStore: caveHuntSkip,
        // Approche « joueur » bornée (diamondCaveGoto) : coupure (réflexe, TP) ≠ inatteignable.
        goTo: (t) => diamondCaveGoto(t, tokCH),
        settle: () => _caveSettle(tokCH),
        hpOk: () => caveHpAllowed(),
        // CASSE VÉRIFIÉE (25/10, `empty nothing_mined` ×30 en 30 min avec le diamant TOUJOURS LÀ) : se
        // placer à portée et en vue, murer la lave, équiper la pioche qui récolte, casser, ramasser, puis
        // le filon — chaque refus a sa raison (cf. skills/diamondDig.js). Remplace floodFillVein seul.
        mineTarget: (t) => _digDiamondAt(t, tokCH),
        // Cible relue AVANT le départ : un minerai déjà cassé (la carte ne l'oubliait pas) est sauté.
        oreState: (t) => { try { return diamondOreStateOf(bot.blockAt(vec3Lib(t.x, t.y, t.z))); } catch (e) { return 'unknown'; } },
        // 2 refus sur la même case → écartée 10 min (partagé entre reprises du but).
        strikeStore: caveHuntStrikes,
      }, goal.args || {}), tokCH);
    } finally { _diamondHuntBusy = false; }
    if (rCH && rCH.reason === 'no_cave_target') {
      emit({ type: 'cave_travel', reason: 'no_cave_target' });
      return await branchMine(bot, Object.assign(
        { torchEvery: TORCH_EVERY, onSurvivalTick: branchSurvivalTick, survivalEvery: 4,
          onNoPickaxe: () => rebuildPickHere('branch') },
        { targetY: (goal.args && goal.args.targetY) || -54, mainLength: 16, branchSpacing: 4, branchLength: 4 },
        lifeGuardOpts('branchMine', _gen)),
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
    // mapper_armor (24/10) : on remonte dès que le fer des pièces MANQUANTES du cartographe est réuni.
    if (!stopOre && _obj === 'mapper_armor' && Number.isFinite(_giftNeed) && _giftNeed > 0) {
      try {
        const inv0 = buildCtxInv(bot);
        const left = _giftNeed - (inv0.raw_iron || 0) - (inv0.iron_ingot || 0);
        if (left > 0) stopOre = { items: ['raw_iron', 'iron_ingot'], count: Math.min(left, 16) };
      } catch (e) { /* best-effort */ }
    }
    // iron_help (24/10) : on remonte fondre dès que le stock d'entraide est réuni (et non « au 1er diamant »,
    // l'ancien défaut de branchMine qui sortait sans creuser quand le bot portait déjà des diamants).
    if (!stopOre && _obj === 'iron_help') {
      try {
        const inv0 = buildCtxInv(bot);
        const left = HELP_STOCK - (inv0.raw_iron || 0) - (inv0.iron_ingot || 0);
        if (left > 0) stopOre = { items: ['raw_iron', 'iron_ingot'], count: Math.min(left, 16) };
      } catch (e) { /* best-effort */ }
    }
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
    // LACETS (22/10) : le tracé reprend au FRONT mémorisé (même cap, même phase), cf. ironLawnStart.
    const _lawnState = (goal.args && goal.args.lawn) ? ironLawnStart() : null;
    const rBM = await branchMine(bot, Object.assign(
      { torchEvery: TORCH_EVERY, onSurvivalTick: branchSurvivalTick, survivalEvery: 4,
        onNoPickaxe: () => rebuildPickHere('branch') },
      goal.args || {}, stopOre ? { stopOre } : {}, _lawnState ? { lawnState: _lawnState } : {},
      lifeGuardOpts('branchMine', _gen)), taskToken);
    // Mort dans la galerie : ni front mémorisé (ce serait le point de réapparition), ni four du fond, ni
    // décalage — la nouvelle vie repart de zéro. (branchMine a déjà dit stale_task_dropped s'il l'a vu.)
    if (lifeStale(_gen)) return (rBM && rBM.stale) ? { ok: false, reason: 'cancelled', stale: true } : dropStaleTask('branchMine', _gen);
    if (goal.args && goal.args.lawn) { try { ironLawnEnd(rBM); } catch (e) { /* best-effort */ } }
    // Le four laissé en bas (fondre en minant) : on repasse prendre les lingots avant de quitter la mine.
    try { await finishFurnaceJob('branch_end'); } catch (e) { /* best-effort */ }
    // Fix n°2 water-wall (NO_GIVE) : aquifère VERROUILLANT (waterlocked = toutes directions
    // mouillées + scellement inopérant) ou stall → se DÉCALER à pied 30-50 blocs À PROFONDEUR
    // (pathfinder creuse son chemin) avant que le planner ne retente iron_deep au même endroit.
    // Le chantier noyé est oublié / re-marqué au sec (sinon /home work ramènerait dans la nappe).
    if (NO_GIVE && rBM && rBM.ok === false && (rBM.reason === 'waterlocked' || rBM.reason === 'stalled' || rBM.reason === 'crash_spot')
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
      if (isInWater(bot)) { _workSet = false; _forgetDeepWork('landed_wet'); try { await escapeWater(bot, { emit }); } catch (e) {} }
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
    if (isLumberjackObjective()) return ljCraftGiftSkill();   // plan PARTIEL (lingots du bûcheron)
    if (_giftBatch && _giftBatch.to === _giftTarget) return giftBatchCraftSkill();   // LOT (20/10)
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
  if (goal.skill === 'deliverWood') return deliverWoodSkill();
  if (goal.skill === 'lumberjackIdle') return lumberjackIdleSkill();
  if (goal.skill === 'lumberjackArmor') return lumberjackArmorSkill();
  if (goal.skill === 'lumberjackForestTrip') return lumberjackForestTripSkill();
  if (goal.skill === 'deliverMapperArmor') {
    const to = _giftTarget;
    if (!to) { if (isLumberjackObjective()) _ljGift = null; return { ok: true }; }   // plus personne à servir
    // Bûcheron : seulement les pièces de SON plan (il porte les siennes ; le reste de sa poche n'est pas un don).
    const _batch = (_giftBatch && _giftBatch.to === to) ? _giftBatch : null;   // LOT (20/10) : ses pièces seulement
    const _pieces = ljGiftPiecesFor(to) || (_batch ? _batch.pieces.slice() : null) || GIFT_PIECES;
    if (!isAllowed('/tpa ' + to, whitelist)) {
      // /tpa pas coché dans le profil serveur. Défense en profondeur (la cible est déjà gatée à la
      // source dans _giftContext) : on nettoie COMME l'échec de TP ci-dessous — sinon une whitelist
      // qui change en cours de session laisserait la réservation `marmor:` et `_giftTarget` posés.
      try { if (_teamClaims) _teamClaims.release('marmor:' + to); } catch (e) {}
      _giftTarget = null; _giftAt = 0;
      ljAfterGift(to, 0);
      emit({ type: 'gift_blocked', to });
      return { ok: false, reason: 'tpa_not_whitelisted' };
    }
    emit({ type: 'gift_tpa', to });
    try { stopMotion(); } catch (e) {}
    // Poser le chantier AVANT de partir : sans ça le worker livrait son armure et reprenait sa
    // chaîne à l'endroit du cartographe, à l'autre bout de la carte (son puits de mine abandonné).
    markWorkBeforeTrip('gift_tpa');
    try { bot.chat('/tpa ' + to); } catch (e) { ljAfterGift(to, 0); return { ok: false, reason: 'chat_failed' }; }
    const w = await awaitWarp({ maxMs: 20000 });
    if (!w.warped) {
      // Échec de TP : on RELÂCHE la réservation pour qu'un autre worker (peut-être plus proche
      // ou moins malchanceux) puisse servir ce cartographe. Le set reste en poche, rien n'est perdu.
      try { if (_teamClaims) _teamClaims.release('marmor:' + to); } catch (e) {}
      _giftTarget = null; _giftAt = 0;
      ljAfterGift(to, 0);
      emit({ type: 'gift_tpa_failed', to });
      return { ok: false, reason: 'tpa_failed' };
    }
    // Remise en main propre (24/10, handoff.js) : approche ≤ 2 blocs, regard, jet, puis PREUVE de
    // ramassage — sinon on reprend ses objets et on réessaie. `gift_delivered` n'est émis QUE prouvé.
    const ho = await handOffPieces(to, _pieces.filter((p) => _pocketCount([p]) > 0));
    const given = ho.given;
    if (given <= 0) {
      // Non prouvé : rien n'est marqué livré. Les pièces reprises restent en poche (le lot se recalcule),
      // la réservation est rendue pour qu'un coéquipier ou nous-mêmes réessayions plus tard.
      emit({ type: 'gift_unconfirmed', to, tries: ho.tries, reason: ho.reason || null, back: _pocketCount(_pieces) });
      try { if (_teamClaims) _teamClaims.release('marmor:' + to); } catch (e) {}
      // 90 s de répit pour CE receveur (pas de /tpa en rafale), puis il redevient servable.
      _giftDone.set(to, Date.now() - (GIFT_DONE_TTL_MS - GIFT_BATCH_REDO_MS));
      _giftTarget = null; _giftAt = 0;
      ljAfterGift(to, 0);
      await returnToWork('gift_unconfirmed');
      return { ok: false, reason: 'gift_unconfirmed' };
    }
    emit({ type: 'gift_delivered', to, pieces: given, by: ho.by });
    // Lot partiel : le cartographe reste à finir → re-servable après son prochain heartbeat (90 s) au
    // lieu des 5 min d'un set complet. Le heartbeat le publiera avec ses NOUVELLES pièces manquantes.
    _giftDone.set(to, _batch && given > 0 ? Date.now() - (GIFT_DONE_TTL_MS - GIFT_BATCH_REDO_MS) : Date.now());
    if (_batch) {
      emit({ type: 'gift_batch', to, pieces: _batch.pieces.slice(), ingots: _batch.ingots, phase: 'delivered', given });
      _giftBatch = null;
    }
    try { if (_teamClaims) _teamClaims.release('marmor:' + to); } catch (e) {}
    _giftTarget = null; _giftAt = 0;
    ljAfterGift(to, given);
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
  if (goal.skill === 'diaArmor') return craftDiamondArmorPiece();
  if (goal.skill === 'sword') return craftSwordGoal();
  if (goal.skill === 'craftDiamondArmor') {
    const itemsOf = () => ((bot.inventory && bot.inventory.items()) || []).map((i) => ({ name: i.name, count: i.count }));
    let progressed = false;
    const _pw = ((bot.inventory && bot.inventory.items()) || []).map((i) => ({ name: i.name, broken: isNearlyBroken(i) }));
    for (const piece of armorEquipPlan(_pw, _armorOccupants())) {
      const it = ((bot.inventory && bot.inventory.items()) || []).find((i) => i.name === piece.name && !isNearlyBroken(i));
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
    const action = await survivalTick(bot, { fleeFrom: skeletonFirstFlee, emit, holdPosition: shelterHoldNow, strikeInPlace, ...fightGateDeps() });
    if (!action) return;
    await sleep(1500);
  }
}

// Exécute un skill de but avec timeout + TÉLÉMÉTRIE d'échec : sans la raison dans les logs live,
// un stall est indiagnosticable à distance (vécu Surv2 : stone_sword ×5 sans explication).
let lastShelterT = 0; // anti re-trigger : 1 abri par nuit max (heure de DÉBUT du dernier abri)

// ─── DISCIPLINE DE NUIT (19/10 soir, run « de zéro » world_oct9) — état et prédicat COMMUNS ─────
// 33 morts en 35 min, l'essentiel LA NUIT, flotte partie de zéro (personne n'a d'armure). L'abri
// existait ; ce qui tuait, c'est tout ce qui en TIRAIT le bot nu — mesuré dans les sessions :
//   - NethBot3 : l'abri lancé par le timer de squad (regroupNightGuard) creusait son trou pendant que
//     le planner, lui, repartait couper du bois à côté (shelter dig_in 701 s → goal logs 763 s → aube
//     1197 s : ~8 min de nuit au travail, nu) ; et l'entraide de combat l'envoyait dans la bagarre d'un
//     coéquipier (team_assist:spider ×3 > team_assist:creeper > … mort) ;
//   - NethBot1 : abri raté AU RESPAWN (chunks pas encore chargés → `void_below`) → écart « 1 abri /
//     10 min » armé → retour au travail en pleine nuit, 4 morts d'affilée en reprenant `logs`.
// `nightLockdownNow()` est le prédicat unique (caution.nightLockdown sur l'état réel) que consultent :
// le planner (holdForNight), l'entraide (teamAssistTick), la quête de nourriture (foodRunTick), le
// trajet bois (woodTripWanted), le /tpa vers un cartographe (tryTpToMapper), la chasse au démarrage
// du cartographe. Le squad/regroupement passe déjà par regroupCaution (plus large : test-pinné).
// ⚠️ NIVEAU MODULE (piège #56) : tout ceci est lu par des timers ET par le planner.
let _mapperHomeShelterFailedAt = 0;   // abri RATÉ au home safe (mapperNight) — l'état du process suffit : il survit aux respawns
let _shelterInFlight = null;   // promesse de l'abri EN COURS — un seul trou à la fois, les autres appelants le rejoignent
let _shelterTok = null;        // jeton PROPRE de l'abri en cours (dérivé du jeton de tâche) — annulable par sa borne et le watchdog
let _shelterStartedAt = 0;     // début de l'abri en cours (watchdog du planner : un abri n'est légitime que borné)
// BOUCLE D'ANNULATIONS (live 22/10, NethBot1 session 152) : série d'abris finis `cancelled` (cf.
// shelterToken.shelterCancelLoopNote) et, après une boucle, « le prochain abri prend un jeton NEUF ».
let _shelterCancelLoop = null;
let _shelterFreshNext = false;
// Borne DURE d'un abri de nuit (inchangée : 13 min de nuit + l'attente d'aube) — désormais elle ANNULE.
const SHELTER_HARD_MAX_MS = 13 * 60 * 1000 + Math.max(DAWN_WAIT_MAX_MS, DAWN_SAFE_EXIT_MAX_MS);
let _lastGoalAt = 0;           // dernier event `goal` du planner (watchdog) — lu par un timer : niveau module
let _plannerWatchdogAt = 0;    // dernière relance du watchdog (1 / 6 min)
let _plannerWatchdogBusy = false;
let _plannerOrphanSince = 0;   // planner orphelin observé depuis (plannerRevive) — lu par un timer : niveau module
let _plannerReviveAt = 0;      // dernière relance « orphelin »
let _plannerParked = false;    // stop/afk/guard/follow/pvp d'un JOUEUR : le planner reste éteint jusqu'au prochain départ
// Un COMPTEUR et pas un booléen (même raison que _skillInFlight/_autoRunners) : un vieux planner qui finit
// sa retenue (jeton annulé au respawn) ne doit pas déclarer « plus retenu » pendant que le nouveau l'est encore.
let _nightHold = 0;            // planners retenus par la discipline de nuit : immobilité LÉGITIME (desync, confine)
let _lockdownShelters = null;  // comptabilité des abris de la nuit (caution.lockdownShelterNote → `shelter_reenter`)
const _nightGateAt = {};       // throttle des events `night_gate` : 1×/min par routine retenue
let _preShelterGoal = null;    // but que le planner va lancer (lu par maybeNightShelter, freeRoam.diamondNightPlan)
let _freeRoamNoteAt = 0;       // throttle de `night_free_roam` (diamant complet, pas d'abri) : 1×/10 min
const NIGHT_HOLD_POLL_MS = 2000;            // pas de re-décision du planner retenu
const NIGHT_HOLD_MAX_MS = 15 * 60 * 1000;   // garde-fou : une nuit MC ≈ 8,7 min (+ 2 min d'aube) — jamais retenu à vie sur une heure figée

/** Discipline de nuit MAINTENANT ? Nu (< 2 pièces PORTÉES, usées exclues) + nuit CONNUE. `bot.time`
 *  absent (juste après un spawn) → heure inconnue → false (convention de caution.nightLockdown). */
function nightLockdownNow() {
  if (diamondFreeNow()) return false;   // armure diamant complète : libre la nuit (freeRoam, Massii 24/10)
  let worn = 0;
  try { worn = _wornArmor().size; } catch (e) { worn = 0; }   // inventaire illisible → 0 = prudent
  const known = !!(bot && bot.time && bot.time.timeOfDay != null);
  return nightLockdown({ isNight: known ? isNight(bot) : null, worn });
}

/** Armure diamant complète PORTÉE (pièces usées exclues) ? → libre en surface, la nuit comprise (freeRoam). */
function diamondFreeNow() {
  try { return diamondFree([..._wornArmor()]); } catch (e) { return false; }
}

/** La nuit vue par les gardes de prudence : false pour le diamant complet, sinon isNight. Heure inconnue →
 *  l'appelant décide (il teste bot.time avant). */
function cautionNightNow() {
  try { return !!cautionNight(isNight(bot), [..._wornArmor()]); } catch (e) { return false; }
}

/** Trace qu'une routine a été RETENUE par la discipline de nuit (1×/min par routine) : sans elle, un
 *  gate muet est indiscernable d'une fonctionnalité morte (#55a). */
function nightGateNote(what, extra) {
  const now = Date.now();
  if (now - (_nightGateAt[what] || 0) < 60000) return false;
  _nightGateAt[what] = now;
  emit(Object.assign({ type: 'night_gate', what }, extra || {}));
  return true;
}

// Abri nocturne PARTAGÉ (kit + roaming mappeur, hole §1.4) : nuit + (mort récente OU PV ≤10) + pas
// d'abri depuis 10 min → trou couvert jusqu'à l'aube (borné 13 min). Retourne true si on s'est abrité.
// `proactive=true` (mappeurs en roaming, fix fable1) : la nuit SUFFIT — attendre une mort pour
// s'abriter, c'est déjà avoir perdu (MapperBot1+2 sniped par squelettes la 1re nuit du monde neuf).
// `opts.force` (cartographe NU, cf. mapperNightGuard) : relâche le cooldown « 1 abri / 10 min ».
// Ce cooldown laissait passer EXACTEMENT le cas mortel — mourir pendant l'abri, respawner en pleine
// nuit, et repartir marcher parce que le cooldown venait d'être armé (le compteur vit dans le
// process, il survit à la mort). Un mappeur nu de nuit s'abrite, cooldown ou pas ; l'espacement
// minimal de 60 s reste, lui, pour qu'un abri qui ÉCHOUE (impossible de creuser/se murer) ne
// devienne pas une boucle chaude.
// DISCIPLINE DE NUIT (19/10 soir) — deux règles de plus, pour TOUS les appelants :
//   1. UN SEUL ABRI À LA FOIS. Un 2e appelant (planner, squad, regroupement, cartographe…) REJOINT
//      l'abri en cours — il attend sa fin et rend true — au lieu de repartir travailler à côté du trou
//      (vu NethBot3) ou d'en creuser un second.
//   2. En lockdown (nu + nuit connue, HORS de l'eau), l'écart tombe à 20 s (NIGHT_SHELTER_GAP_MS) quel
//      que soit l'appelant : un abri raté ou interrompu se reprend tout de suite. Dans l'eau, l'écart
//      historique reste (on ne creuse pas de trou en pleine eau, le sauvetage garde la main).
const FORCED_SHELTER_MIN_GAP_MS = 60 * 1000;

// ─── TENIR SA CASE (live 22/10, NethBot1 session 206 : 5 morts en 85 s au point de réapparition) ──────
// `dig_in → reflex fight skeleton → teleported dist:6 → reflex flee → teleported dist:8 → walled_in
// after:teleported → flee → mort` : la riposte pvp (qui POURSUIT sa cible) et les fuites (réflexe, tick
// de survie du planner concurrent) tiraient le bot hors du trou qu'il creusait. Une fois enterré (≥ ~1 bloc
// dans sa colonne) ou muré, on TIENT la case : rien ne le fait fuir, ce qui est au contact est frappé sur
// place. ⚠️ NIVEAU MODULE (piège #56) : lu par les réflexes et le tick de survie.
/**
 * MORT = FIN DE L'ABRI (live 22/10, NethBot1 session 206 : `walled_in after:no_fall` à 826301 pour un
 * `dig_in` de 807870 — l'abri de la vie précédente creusait encore au respawn, et les onSpawn suivants le
 * REJOIGNAIENT). Annule son jeton (le creusage borné s'arrête au prochain relevé), libère le verrou
 * `_shelterInFlight`/`_shelterTok`, et oublie la case tenue et la sortie différée. Jamais de throw.
 */
function abortShelterOnDeath() {
  try {
    const had = !!_shelterInFlight;
    if (_shelterTok) { try { _shelterTok.cancelled = true; } catch (e) {} }
    _shelterInFlight = null;
    _shelterTok = null;
    _stillBusy = false;
    if (bot) { bot._mcaShelterCell = null; bot._mcaShelterPending = null; }
    if (had) emit({ type: 'shelter', action: 'death_abort' });
  } catch (e) { /* best-effort */ }
}

function shelterHoldNow() {
  try {
    // Perché sur le pilier anti-mêlée : on TIENT la case comme dans un abri (ni fuite, ni poursuite pvp
    // qui le feraient sauter dans la grappe) — ce qui est à portée est frappé sur place.
    if (_meleePillar) return true;
    if (!_shelterInFlight || !bot || !bot.entity) return false;
    return shelterHold(bot._mcaShelterCell, bot.entity.position);
  } catch (e) { return false; }
}

/** Frappe SUR PLACE (sans poursuite pvp, sans but pathfinder). Jamais de throw. */
function strikeInPlace(foe) {
  try {
    if (!foe || !foe.position || !bot.entity) return;
    if (bot.pvp && bot.pvp.target) { try { bot.pvp.stop(); } catch (e) {} }
    const h = Number.isFinite(foe.height) ? foe.height * 0.8 : 1.4;
    try { Promise.resolve(bot.lookAt(foe.position.offset(0, h, 0), true)).catch(() => {}); } catch (e) {}
    bot.attack(foe);
    _auraLastHitAt = Date.now();   // l'aura respecte le cooldown de ce coup
  } catch (e) { /* best-effort */ }
}
async function maybeNightShelter(proactive = false, opts = {}) {
  if (_shelterInFlight) {
    try { await _shelterInFlight; } catch (e) { /* l'abri en cours a ses propres garde-fous */ }
    return true;
  }
  // ARMURE DIAMANT COMPLÈTE (Massii 24/10) : sous terre il travaille, sans abri. EN SURFACE la nuit
  // (correctif 24/10 soir — morts de nuit et à l'aube en surface, squelettes/creepers) : il n'y reste que
  // pour un VRAI besoin (nourriture critique, bois indispensable), sinon il redescend au chantier
  // (/home work, deepWork) ; sans chantier connu, l'abri de surface historique (freeRoam.diamondNightPlan).
  let _diaForceNaked = false;
  if (diamondFreeNow()) {
    let plan = 'work';
    let _dwPlan = null;
    try {
      const known = !!(bot.time && bot.time.timeOfDay != null);
      const p = bot.entity && bot.entity.position;
      const g = opts.goal || _curGoal || _preShelterGoal || null;
      let foodCritical = false;
      try { foodCritical = (bot.food != null && bot.food <= 6) && foodPoints(buildCtxInv(bot)) < 6; } catch (e) { foodCritical = false; }
      let underground = false;
      try { underground = !!nightUndergroundNow(); } catch (e) { underground = !!(p && p.y < 45); }
      if (known && isNight(bot) && !underground && NO_GIVE && p) {
        let _deaths = [];
        try { _deaths = _recentDeathPositions(); } catch (e) { _deaths = []; }
        try { _dwPlan = deepWorkWarpPlan({ deepWork: _loadDeepWork(), pos: { x: p.x, y: p.y, z: p.z }, now: Date.now(), deaths: _deaths }); } catch (e) { _dwPlan = null; }
      }
      plan = diamondNightPlan({ free: true, night: known ? isNight(bot) : null, underground,
        goalName: g && g.name, goalSkill: g && g.skill, foodCritical, deepWorkWarp: !!(_dwPlan && _dwPlan.warp) });
    } catch (e) { plan = 'work'; }
    if (plan === 'work' || plan === 'need') {
      if (bot.time && bot.time.timeOfDay != null && isNight(bot) && Date.now() - _freeRoamNoteAt >= 10 * 60 * 1000) {
        _freeRoamNoteAt = Date.now();
        emit({ type: 'night_free_roam', why: plan, y: bot.entity && bot.entity.position ? Math.round(bot.entity.position.y) : null });
      }
      return false;
    }
    if (plan === 'go_deep') {
      const dw = _loadDeepWork();
      emit({ type: 'night_go_deep', x: dw && dw.x, y: dw && dw.y, z: dw && dw.z,
        from_y: bot.entity && bot.entity.position ? Math.round(bot.entity.position.y) : null });
      _stairDepth++;
      try {
        try { homewarp.goHome(bot, HOME_WORK); } catch (e) {}
        await awaitWarp({ maxMs: 8000 });
        await sleep(1200);
      } finally { _stairDepth = Math.max(0, _stairDepth - 1); }
      const _pl = bot.entity && bot.entity.position;
      let _wet = false;
      try { _wet = isInWater(bot); } catch (e) { _wet = false; }
      if (_pl && dw && deepWorkLanded(dw, { x: _pl.x, y: _pl.y, z: _pl.z }) && !_wet) {
        _workSet = true; _workPos = _botXZ();
        emit({ type: 'deep_work_landed', y: Math.round(_pl.y), ctx: 'night' });
        return true;   // a bougé : l'appelant re-dérive son but
      }
      _forgetDeepWork(_wet ? 'landed_wet' : 'not_landed');
      if (_wet) { try { await escapeWater(bot, { emit }); } catch (e) {} }
      // pas arrivé : abri de surface ci-dessous
    }
    _diaForceNaked = true;   // 'shelter' (ou go_deep raté) : traité comme un bot à armure incomplète
  }
  const deathsRecent = deathTimes.filter((t) => Date.now() - t < 10 * 60 * 1000).length;
  // Décision d'abri déléguée à shouldShelter (skills/shelter) : sensible à l'OBSCURITÉ (lightLevel
  // ≤7) en plus de la nuit — un bot dans une grotte sombre / à l'ombre profonde de jour se terre
  // aussi. Robuste au lightLevel inconnu (mineflayer ne le livre pas toujours → retombe sur hostiles).
  const _pp = bot.entity && bot.entity.position;
  // « nu » au sens de l'abri = armure INCOMPLÈTE, pas « zéro pièce ». Une seule botte suffisait à
  // désactiver l'abri nocturne, alors qu'en hard un zombie tue un bot à 3 pièces presque aussi vite
  // qu'un bot nu. Les porteurs de set complet (mappeurs via /kit) restent libres de travailler.
  const naked = _diaForceNaked || _wornArmor().size < 4;
  let lightLevel = null;
  try { const b = _pp && bot.blockAt(_pp.floored()); if (b && typeof b.light === 'number') lightLevel = b.light; } catch (e) {}
  const hostilesNear = (() => { try { const e = bot.nearestEntity((x) => x && x.kind === 'Hostile mobs'); return !!(e && bot.entity && e.position.distanceTo(bot.entity.position) <= 8); } catch (e) { return false; } })();
  // Sous terre (y<45, seuil historique) : pas d'abri du tout — un mineur s'enterrait en boucle
  // dans sa propre mine (dark permanent + nu en chaîne armure), 10-13 min perdues par cycle.
  // `nightUndergroundNow` : y < 45 OU descendu et scellé par la nuit au travail (21/10).
  const sig = { night: isNight(bot), lightLevel, naked, lowHp: (bot.health != null && bot.health <= 10), hostilesNear, proactive, underground: nightUndergroundNow() };
  let inWater = false;
  try { inWater = isInWater(bot); } catch (e) { inWater = false; }
  const lockdown = !inWater && nightLockdownNow();
  const _shelterGap = lockdown ? NIGHT_SHELTER_GAP_MS : (opts.force ? FORCED_SHELTER_MIN_GAP_MS : 10 * 60 * 1000);
  if (shouldShelter(sig).shelter && Date.now() - lastShelterT > _shelterGap) {
    lastShelterT = Date.now();
    // RÉ-ABRI (2e abri ou plus de la même nuit) = un abri INTERROMPU : le compteur à lire en live.
    if (lockdown) {
      const note = lockdownShelterNote(_lockdownShelters, { night: bot.time ? bot.time.day : null, now: lastShelterT });
      _lockdownShelters = note.state;
      if (note.emit) emit({ type: 'shelter_reenter', count: note.count });
    }
    // JETON DÉRIVÉ (21/10) : `withTimeout` n'annule rien — sans jeton propre, un abri dont la borne expire
    // continuait derrière (creusage gelé compris). Annulé par : le jeton de tâche (mort, ordre), la borne
    // ci-dessous, le watchdog du planner.
    // ⚠️ JAMAIS NÉ ANNULÉ (live 22/10, NethBot1 session 152) : `fleeDeathCamp` avait fait `taskCtl.cancel()`,
    // plus rien ne re-posait de jeton vivant, et chaque abri dérivé de ce jeton MORT sortait en 0-2 ms
    // (`sealed:false why:cancelled depth:0`) toutes les 20 s, toute la nuit. shelterToken suit le parent
    // s'il est vivant ; sinon il ne voit que les préemptions POSTÉRIEURES (génération de taskCtl).
    const shTok = shelterToken(taskToken, () => taskCtl.generation, { fresh: _shelterFreshNext });
    _shelterFreshNext = false;
    if (shTok.inherited !== 'live') emit({ type: 'shelter_token', inherited: shTok.inherited });
    _shelterTok = shTok;
    _shelterStartedAt = lastShelterT;
    const run = (async () => {
      // MAPPEUR (Massii 2026-07-15) : d'abord REVENIR au home 'safe' de surface (/home safe, visible),
      // puis se terrer là — plutôt que de creuser un trou au hasard là où la nuit l'a surpris.
      // ⚠️ HOME CAMPÉ (live 19/10) : c'était le 1ᵉʳ maillon de la boucle mortelle de MapBot2
      // (mapper_home_return > safe_warp > fight > dig_in > flee > mort, 8 fois en 3 min). goHome passe par
      // le veto : campé la nuit, le /home ne part pas et on se terre LÀ où la nuit nous a surpris.
      // NUIT DU CARTOGRAPHE (21/10, mapperNight) : home douteux (1 mort récente, hostile vu, abri déjà
      // raté là-bas) → on se terre ICI au lieu d'être renvoyé dans le même trou raté.
      let wentHome = false;
      if (IS_MAPPER) {
        let plan = { go: false, why: 'no_home' };
        try {
          const now = Date.now();
          plan = mapperNightPlan({
            homeSet: !!_safeHomeSet,
            deathsNearHome: _safeHomePos ? deathsNear(_safeHomePos, _recentDeathPositions(), now) : 0,
            hostileNearHome: hostileSeenRecently(noteHostileNearSafeHome(now), now),
            homeShelterFailedAt: _mapperHomeShelterFailedAt, now,
          });
        } catch (e) { /* lecture ratée → chemin historique ci-dessous */ plan = { go: !!_safeHomeSet, why: 'home' }; }
        emit({ type: 'mapper_night', phase: 'dusk', where: plan.go ? 'home' : 'here', why: plan.why });
        if (plan.go) {
          try {
            if (homewarp.goHome(bot, HOME_SAFE, { ctx: 'mapper_night' })) {
              wentHome = true;
              emit({ type: 'mapper_home_return', home: 'safe' });
              await sleep(4000);
            }
          } catch (e) {}
        }
      }
      _stillBusy = true;    // terré jusqu'à l'aube (≤13 min immobile) : immobilité légitime, pas un desync
      try {
        // LIT (20/10) : à ≤ 16 blocs de son lit, on y dort au lieu de creuser un trou. Nuit passée au lit
        // → fini ; « monstres à proximité », lit disparu ou réveillé de nuit → l'abri historique ci-dessous.
        if (!IS_MAPPER && await trySleepInBedTonight(shTok)) return;
        // `hostilesNear` + `worn` : l'attente des monstres à l'AUBE (shelter étape 3bis, live 19/10 —
        // 14 morts sur 17 « shot by Skeleton » juste après la sortie d'abri, sous une canopée où ils ne
        // brûlent pas). SANS ce branchement l'attente n'existe pas et rien ne le dit : tests verts, bot
        // qui ressort droit dans l'arc des squelettes (piège #61). Le garde-fou extérieur lui laisse sa borne.
        // `endWhenDisplaced` (discipline de nuit, 19/10 soir) : en lockdown, un bot DÉLOGÉ de son trou
        // termine l'abri au lieu d'« attendre l'aube » debout dehors — la discipline le ré-abrite 20 s plus
        // tard. Relu AU MOMENT du délogement (un abri ouvert au crépuscule, avant que `isNight` ne bascule,
        // est couvert aussi). Armé : toujours faux, l'abri attend l'aube comme avant.
        const sres = await withTimeout(shelterUntilDawn(bot, shTok, {
          emit, hostilesNear: hostilesNearNow, worn: () => _wornArmor().size,
          exitThreats: dawnExitThreatsNow, onExit: exitAwayFromThreats,   // sortie sûre (fix 20/10)
          endWhenDisplaced: () => nightLockdownNow(),
          whileSealed: shelterWhileSealed,                                  // crafter dans le trou (22/10)
        }), SHELTER_HARD_MAX_MS,
        () => { shTok.cancelled = true; emit({ type: 'shelter', action: 'hard_timeout' }); try { stopMotion({ arm: true }); } catch (e) {} });
        // GARDE (22/10) : 3 abris `cancelled` d'affilée en < 2 min = un jeton qui naît/meurt aussitôt,
        // quelle qu'en soit la cause → tracé, et le prochain abri part sur un jeton NEUF tout de suite.
        try {
          const cl = shelterCancelLoopNote(_shelterCancelLoop, { reason: (sres && sres.ok) ? null : (sres && sres.reason) || null, now: Date.now() });
          _shelterCancelLoop = cl.state;
          if (cl.loop) {
            emit({ type: 'shelter_cancel_loop', count: cl.count, inherited: shTok.inherited });
            _shelterFreshNext = true;
            lastShelterT = 0;
          }
        } catch (e) { /* comptabilité best-effort */ }
        // PIOCHE FAITE DANS LE TROU (22/10) : l'abri rend la main SANS sortie (toit intact) → la nuit au
        // travail descend en escalier depuis le fond du puits. Encore dans `_shelterInFlight` : aucun timer
        // ne vole le bot entre les deux. Ratée → le bot reste au fond de son trou ; la discipline de nuit
        // le ré-abrite là (20 s plus tard), sans jamais ouvrir vers la surface.
        if (sres && sres.handoff === 'night_work' && !shTok.cancelled && !taskToken.cancelled) {
          const ho = (_shelterCraft && _shelterCraft.handoff) || { cellMode: sres.mode };
          if (_shelterCraft) _shelterCraft.handoff = null;
          try { await tryNightWork({ fromShelter: ho }); } catch (e) { /* best-effort */ }
        }
        if (IS_MAPPER) {
          const reason = (sres && sres.reason) || null;
          // borne de 13 min atteinte = nuit passée terré ; tâche annulée (mort, ordre) ≠ trou raté
          const ok = !!(sres && sres.ok) || reason === 'timeout';
          if (!ok && wentHome && reason !== 'cancelled') _mapperHomeShelterFailedAt = Date.now();   // ce home ne vaut rien cette nuit
          emit({ type: 'mapper_night', phase: ok ? 'dawn' : 'shelter_failed', where: wentHome ? 'home' : 'here', reason });
        }
      } finally { _stillBusy = false; }
    })();
    // Posé SANS await intermédiaire depuis la décision : un appelant concurrent voit l'abri en cours.
    _shelterInFlight = run;
    try { await run; } finally {
      if (_shelterInFlight === run) _shelterInFlight = null;
      if (_shelterTok === shTok) _shelterTok = null;
    }
    return true;
  }
  return false;
}

// ─── LIT : RÉAPPARAÎTRE CHEZ SOI ET DORMIR (20/10) ──────────────────────────────────────────────
// Mesure live : 17 morts sur 37 < 30 s après la réapparition, de nuit, au spawn du monde campé. Les
// bots sont non-op (pas de /spawnpoint) : le LIT est le seul moyen « joueur » de déplacer le point de
// réapparition. Logique pure dans bed.js ; ici, uniquement la glue sur le vrai bot.
// ⚠️ NIVEAU MODULE (piège #56) : lus par ctxExtra (chaque pas du planner), le handler `messagestr`,
// maybeNightShelter et les timers.
let _bedLastSheep = null;        // dernier mouton VU { x, z, at } — « entités vues » (la carte ne liste pas les animaux)
let _bedLastMsg = null;          // dernier message serveur lié au lit { kind, at } (cf. bed.parseBedMessage)
let _bedSleeping = false;        // couché en ce moment (dédoublonne les appels de nuit concurrents)
const BED_SHEEP_HUNT_RADIUS = 48;      // rayon de chasse au mouton (≈ la portée de suivi des entités)
const BED_HOME_NEAR = 48;              // plus loin que ça de la base, on rentre par /home safe pour poser le lit
const BED_SPAWN_MSG_WAIT_MS = 2500;    // attente du « Respawn point set » après le clic
const BED_SLEEP_MAX_MS = 13 * 60 * 1000;   // une nuit MC ≈ 8,7 min (+ marge) : jamais couché à vie

/** Contexte « lit » pour les prédicats du planner (but `bed`). Jamais de throw. */
function bedCtxNow() {
  const now = Date.now();
  let seenNow = false;
  const pos = bot && bot.entity && bot.entity.position;
  try {
    const e = bot.nearestEntity((x) => x && x.name === 'sheep' && x.position && x.isValid !== false);
    if (e && pos && e.position.distanceTo(pos) <= BED_SHEEP_HUNT_RADIUS) {
      seenNow = true;
      _bedLastSheep = { x: e.position.x, z: e.position.z, at: now };
    }
  } catch (err) { seenNow = false; }
  let memo = null;
  try { memo = loadBaseState(); } catch (err) { memo = null; }
  return {
    bedPlaced: !!bedOf(memo),
    bedRetryLater: bedRetryActive(memo, now),
    nightLockdown: (() => { try { return !!nightLockdownNow(); } catch (err) { return false; } })(),
    sheepNear: sheepKnown({ seenNow, last: _bedLastSheep, pos: pos ? { x: pos.x, z: pos.z } : null, now }),
  };
}

/** Un essai raté : on ne le retente pas avant BED_RETRY_MS (persisté : un bot meurt toutes les 3 min). */
function bedFail(reason) {
  try { saveBaseState(bedRetryMemo(loadBaseState(), Date.now())); } catch (e) { /* best-effort */ }
  emit({ type: 'bed_failed', reason });
  return { ok: false, reason: 'bed:' + reason };
}

/** Le lit mémorisé n'existe plus (message serveur ou bloc vérifié) → on l'oublie, le but `bed` re-pose. */
function noteBedMissing(why) {
  let memo = null;
  try { memo = loadBaseState(); } catch (e) { memo = null; }
  const had = bedOf(memo);
  if (had) { try { saveBaseState(bedMemoCleared(memo)); } catch (e) { /* best-effort */ } }
  emit({ type: 'bed_missing', why, had: had ? { x: had.x, y: had.y, z: had.z } : null });
}

/** Handler `messagestr` : trace les messages du lit (à confirmer en live) et réagit au lit disparu. */
function onBedMessage(msg) {
  const kind = parseBedMessage(msg);
  if (!kind) return null;
  _bedLastMsg = { kind, at: Date.now() };
  emit({ type: 'bed_msg', kind, text: String(msg).slice(0, 120) });
  if (kind === 'spawn_missing') noteBedMissing('server_message');
  return kind;
}

/** Fixe la réapparition au lit SANS dormir : clic droit (de jour, MC 1.21 dit « Respawn point set »). */
async function setSpawnAtBed(block, how = 'activate') {
  const t0 = Date.now();
  try { await bot.activateBlock(block); } catch (e) { emit({ type: 'spawn_set', how, ok: false, why: 'activate_error' }); return false; }
  // De nuit le clic COUCHE le bot (le spawn est fixé quand même) : on se relève, le planner a la main.
  if (bot.isSleeping) { try { await bot.wake(); } catch (e) { /* best-effort */ } }
  while (Date.now() - t0 < BED_SPAWN_MSG_WAIT_MS) {
    if (_bedLastMsg && _bedLastMsg.at >= t0) break;
    await sleep(250);
  }
  const msg = (_bedLastMsg && _bedLastMsg.at >= t0) ? _bedLastMsg.kind : null;
  const confirmed = msg === 'spawn_set';
  emit({ type: 'spawn_set', how, ok: msg !== 'spawn_missing' && msg !== 'obstructed', confirmed, msg });
  return confirmed || msg === null || msg === 'day';
}

/** Pose le lit en poche à côté du bot. → { ok, pos } */
async function placeBedNear(itemName) {
  const pos = bot.entity && bot.entity.position;
  if (!pos) return { ok: false, reason: 'no_pos' };
  const feet = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) };
  const plan = bedSpotPlan((x, y, z) => { try { return bot.blockAt(new vec3Lib.Vec3(x, y, z)); } catch (e) { return null; } }, feet);
  if (!plan.length) return { ok: false, reason: 'no_space' };
  for (const spot of plan) {
    const item = bot.inventory.items().find((i) => i.name === itemName);
    if (!item) return { ok: false, reason: 'no_item' };
    try {
      await bot.equip(item, 'hand');
      const ref = bot.blockAt(new vec3Lib.Vec3(spot.ref.x, spot.ref.y, spot.ref.z));
      if (!ref) continue;
      await bot.placeBlock(ref, new vec3Lib.Vec3(0, 1, 0));
    } catch (e) { /* mineflayer rejette parfois alors que le bloc est posé : on vérifie ci-dessous */ }
    for (const p of [spot.foot, spot.head]) {
      const b = bot.blockAt(new vec3Lib.Vec3(p.x, p.y, p.z));
      if (b && isBedName(b.name)) return { ok: true, pos: spot.foot, block: b };
    }
  }
  return { ok: false, reason: 'place_failed' };
}

/** Skill du but `bed` : laine (moutons) → lit → retour base → pose → réapparition fixée. */
async function ensureBedGoal() {
  const tok = taskToken;
  let inv = buildCtxInv(bot);
  let bedName = bedItemIn(inv);
  if (!bedName) {
    let tries = 0;
    const huntT0 = Date.now();
    while (woolMissing(inv) > 0 && tries < 6) {
      if (tok.cancelled) return { ok: false, reason: 'cancelled' };
      if (Date.now() - huntT0 > BED_HUNT_BUDGET_MS) break;    // budget épuisé → no_wool, retry dans 10 min
      tries++;
      const r = await huntPassive(bot, { count: 1, maxDistance: BED_SHEEP_HUNT_RADIUS, names: ['sheep'] }, tok);
      if (!r || !r.kills) break;
      inv = buildCtxInv(bot);
    }
    const recipe = bedRecipeName(inv);
    if (!recipe) return bedFail('no_wool');
    const c = await craftSmart({ name: recipe, count: 1 });
    if (!c || c.ok === false) return bedFail('craft:' + String((c && c.reason) || 'failed'));
    bedName = bedItemIn(buildCtxInv(bot));
    if (!bedName) return bedFail('craft_no_effect');
    emit({ type: 'bed_crafted', item: bedName });
  }
  if (tok.cancelled) return { ok: false, reason: 'cancelled' };
  // À la base (près du home `safe`) : c'est là que l'abri de nuit se creuse et que le bot retravaille.
  const memo = loadBaseState() || {};
  const p = bot.entity && bot.entity.position;
  if (memo.base && p && Math.hypot(memo.base.x - p.x, memo.base.z - p.z) > BED_HOME_NEAR && _safeHomeSet) {
    try {
      if (homewarp.goHome(bot, HOME_SAFE, { ctx: 'bed' })) { await awaitWarp({ maxMs: 9000 }); await sleep(1200); }
    } catch (e) { /* home campé/refusé : on pose où l'on est — un lit ailleurs vaut mieux que le spawn campé */ }
  }
  // Pas de lit au milieu d'un point de réapparition campé (respawnCamp) : on y renaîtrait dans le camp.
  try {
    const pp = bot.entity && bot.entity.position;
    if (respawnCamp.campedNear(loadBaseState(), pp ? { x: pp.x, z: pp.z } : null, Date.now())) return bedFail('camped_spot');
  } catch (e) { /* best-effort */ }
  const placed = await placeBedNear(bedName);
  if (!placed.ok) return bedFail('place:' + placed.reason);
  try { saveBaseState(bedMemoWith(loadBaseState(), placed.pos, Date.now())); } catch (e) { /* best-effort */ }
  emit({ type: 'bed_placed', x: placed.pos.x, y: placed.pos.y, z: placed.pos.z });
  await setSpawnAtBed(placed.block, 'activate');
  return { ok: true };
}

/**
 * La nuit, à ≤ 16 blocs de son lit : y dormir au lieu de creuser un trou. true = la nuit est passée au
 * lit (réveil de jour) ; false = rien fait ou réveillé de nuit → l'appelant s'abrite comme avant.
 */
async function trySleepInBedTonight(tok) {
  if (_bedSleeping) return false;
  let memo = null;
  try { memo = loadBaseState(); } catch (e) { memo = null; }
  const bed = bedOf(memo);
  const pos = bot.entity && bot.entity.position;
  const night = (bot.time && bot.time.timeOfDay != null) ? isNight(bot) : null;
  const d = sleepDecision({ bed, pos: pos ? { x: pos.x, y: pos.y, z: pos.z } : null, night });
  if (!d.sleep) return false;
  let block = null;
  try { block = bot.blockAt(new vec3Lib.Vec3(bed.x, bed.y, bed.z)); } catch (e) { block = null; }
  if (!block) return false;                                   // chunk pas chargé : on ne conclut rien
  if (!isBedName(block.name)) { noteBedMissing('block_gone'); return false; }
  _bedSleeping = true;
  try {
    try {
      await withTimeout(bot.pathfinder.goto(new pfGoals.GoalNear(bed.x, bed.y, bed.z, 2)), 15000,
        () => { try { stopMotion(); } catch (e) {} });
    } catch (e) { /* on tente le lit quand même : bot.sleep dira « too far » */ }
    try { await bot.sleep(block); } catch (e) {
      emit({ type: 'bed_sleep', ok: false, why: sleepErrorReason(e) });
      return false;
    }
    emit({ type: 'bed_sleep', ok: true, why: 'asleep', dist: d.dist });
    emit({ type: 'spawn_set', how: 'sleep', ok: true });
    const t0 = Date.now();
    let woke = false;
    const onWake = () => { woke = true; };
    bot.once('wake', onWake);
    try {
      while (!woke && bot.isSleeping && Date.now() - t0 < BED_SLEEP_MAX_MS) {
        if (tok && tok.cancelled) break;
        await sleep(1000);
      }
    } finally { try { bot.removeListener('wake', onWake); } catch (e) {} }
    if (bot.isSleeping) { try { await bot.wake(); } catch (e) {} }
    const stillNight = (bot.time && bot.time.timeOfDay != null) ? isNight(bot) : false;
    emit({ type: 'bed_sleep', ok: !stillNight, why: stillNight ? 'woken_at_night' : 'dawn', slept_s: Math.round((Date.now() - t0) / 1000) });
    return !stillNight;
  } finally { _bedSleeping = false; }
}

// Échecs EAU consécutifs de descendDiagonal (anti re-perçage d'aquifère — cf. pré-hook descend).
let _descendWaterFails = 0;

// ─── COMPTEURS DE ZONE (feature « migration autonome », Massii 27/07) ───────────────────────────
// Remis à ZÉRO à chaque ré-ancrage : ils jugent la zone COURANTE, pas la carrière du bot.
// Ce sont les entrées de zone.zoneVerdict — cf. zone.js pour les seuils et leur justification.
let _zoneAnchoredAt = 0;      // instant du dernier ancrage/migration (0 = pas encore ancré)
let _zoneWaterFails = 0;      // échecs eau (descente noyée, sauvetages) dans la zone — CUMUL
let _zoneLogsNotFound = 0;    // `logs`/bois introuvable → la zone est rasée — CUMUL (verrou noWood)
let _zoneIronMined = 0;       // fers récoltés dans la zone — CUMUL (publié en `ironZone`, cf. regroup)
let _zoneMiningMs = 0;        // temps de minage effectif dans la zone (chronomètre, pas événement)

// ⚠️ CE QUE LIT LE VERDICT, ce sont ces FENÊTRES GLISSANTES (20 min), pas les cumuls ci-dessus.
// Bug mesuré sur world_mn14 : un bot à 221 min sur place avec 150 fers EN CUMUL mais 0 récemment
// (miningMinutes 2 !) et 23 cellules épuisées autour votait « rester », parce que le cumul passait
// la garde « le filon produit encore ». Un cumul dit « ce bot a DÉJÀ produit ici » ; le verdict
// demande « cette zone produit-elle ENCORE ». Les cumuls restent pour leurs autres consommateurs
// (`ironZone` → regroup.squadLeader, `noWood` → plank_buffer non bloquant) — cf. zone.js.
// ⚠️ Déclarées AU NIVEAU MODULE comme leurs sœurs : une garde lue par plusieurs fonctions mais
// déclarée dans `onSpawn` compile, passe les tests, et tue le bot en prod (piège #56).
let _zoneWaterWin = [];       // échecs eau des ZONE_WINDOW_MS dernières minutes
let _zoneLogsWin = [];        // échecs bois de la fenêtre
let _zoneIronWin = [];        // fers récoltés dans la fenêtre = LE rendement courant
let _lastMigrationAt = 0;     // cooldown anti-nomadisme
// MÉMOIRE D'ÉCHEC DE MIGRATION (fix 18/08 : 917 `zone_migration_start` → 72 `zone_migrated`).
// Persistée dans le mémo de base avec le reste de l'état de zone (le bot meurt toutes les 3 min).
let _lastMigrationFailed = false; // dernière migration ratée → cooldown 5 min au lieu de 20
let _failedTargets = [];          // cibles ratées [{x,z,at}] : écartées 45 min (la cible est déterministe)
let _lastMigrationReason = null;  // motif de la dernière migration RÉUSSIE (persisté) : `wood` + arrivée sans arbres = urgence (23/10)
let _lastZoneVerdictReason = null; // dedup télémétrie : dernière raison de verdict tracée
// Délai de grâce du confine après un long trek qui n'a pas pu ancrer (zone.migrationConfineGraceMs).
// ⚠️ NIVEAU MODULE : lu par le timer d'enforcement (piège #56).
let _confineGraceUntil = 0;
let _migrating = false;       // marche de migration en cours → l'enforcement confine est SUSPENDU
let _migrationLegs = 0;       // jambes déjà parcourues (marche à l'aveugle)
// Cible de la migration EN COURS (lue par fleeDeathCamp : la fuite cède à la migration si sa cible est
// hors du camp) et reprise d'une migration INTERROMPUE par une urgence ({reason, at}, lue par le timer
// de reprise). ⚠️ NIVEAU MODULE : lues par des timers et par fleeDeathCamp (piège #56).
let _migrationTarget = null;
let _migrationResume = null;
let _migrationInterrupts = 0;  // interruptions consécutives de la migration en cours (zone.MIGRATION_MAX_INTERRUPTS)
// Migrations (leur jeton `tok`) qui ont déjà émis `zone_migration_leg_dig` : l'event dit « cette
// migration a dû creuser pour sortir », une fois, pas à chaque jambe. WeakSet : un jeton par migration,
// libéré avec elle. Niveau MODULE (lu par migrationLegTo, piège #56).
const _legDigEmitted = new WeakSet();
// MIGRATION EXCLUSIVE (fix 18/08) — gardes lues par migrateZone, écrites ailleurs : niveau MODULE
// obligatoire (piège #56 : un `let` dans onSpawn compile, passe les tests, et tue le bot en prod).
// Des COMPTEURS et non des booléens : deux exécutions peuvent se chevaucher (un skill expiré par
// withTimeout continue de tourner en fond ; une vieille startAutonomous finit de se dérouler
// pendant que la nouvelle démarre) — un booléen remis à false par la première mentirait.
let _skillInFlight = 0;       // runGoalSkill en cours (cf. runSkillWithTelemetry)
let _autoRunners = 0;         // startAutonomous en cours (planner, ressource, récup post-mort)
// GÉNÉRATION DE VIE (23/10, logs Omen NethBot1 13:45 / NethBot2 13:56 UTC) : la mort n'annulait rien — le
// runner autonome survivait (`autonomous_dup_skipped runners:1`) et son serpentin re-pathait depuis le point
// de réapparition vers la galerie qui venait de le tuer (`bm_approach` à ~120 blocs, re-mort 40 s-2 min
// plus tard) ; une chasse d'avant la mort enchaînait sur `/home work` vers l'ancien chantier. Avancé à
// chaque MORT (endLifeTasks) et à chaque SPAWN ; un skill capture la génération à son départ et s'arrête
// dès qu'elle a changé — le global `taskToken` ne suffit pas : après le respawn il porte le jeton VIVANT
// du runner suivant. ⚠️ NIVEAU MODULE (piège #56 : lu par des timers et par les skills).
let _lifeGen = 0;
const MIGRATION_PREEMPT_WAIT_MS = 30000;   // attente max que le planner rende la main

/** La vie qui a capturé `gen` est-elle finie ? Sans génération capturée (appels historiques) : jamais. */
function lifeStale(gen) { return gen != null && gen !== _lifeGen; }

/** Un skill d'une vie finie rend la main : `cancelled` (ni échec du but, ni verdict sur la zone). */
function dropStaleTask(task, gen, why) {
  emit({ type: 'stale_task_dropped', task, gen, now: _lifeGen, why: why || 'life_changed' });
  return { ok: false, reason: 'cancelled', stale: true };
}

/** Options de garde pour skills/branchMine.js (isStale relu à chaque pas et dans approach). */
function lifeGuardOpts(task, gen) {
  return {
    isStale: () => lifeStale(gen),
    onStale: (why) => { emit({ type: 'stale_task_dropped', task, gen, now: _lifeGen, why: why || 'life_changed' }); },
  };
}

/** Fin d'une vie : génération +1 et la tâche longue active est ANNULÉE (son cleanup = stopMotion). Le
 *  planner repart de zéro au spawn (dette de mort / home work décident d'un retour s'il est sûr) ; une
 *  migration annulée ici est reprise (zone.migrationCancelEffect : `by` null → resume). → nom de la tâche. */
function endLifeTasks(why) {
  const gen = _lifeGen;
  _lifeGen++;
  const task = taskCtl.active;
  if (!task) return null;
  taskCtl.cancel();
  emit({ type: 'stale_task_dropped', task, gen, now: _lifeGen, why });
  return task;
}
// FILET ANTI-BOUCLE À VIDE (fix 18/08) : { objectif → instant du dernier run fini SANS AUCUN skill }.
// Écrit et relu par runAutonomousBody à chaque `done` (décision pure : goals.chainAfterDone). En
// mémoire de process VOLONTAIREMENT : la boucle mesurée tournait dans UN process (1 cycle / 1,5 s) ;
// après un respawn, au pire un cycle à vide de plus avant que le filet ne re-mémorise.
let _emptyDoneAt = {};

/** Applique un état de zone (pur → variables de module). */
function _applyZoneState(s) {
  _zoneAnchoredAt = s.anchoredAt;
  _zoneWaterFails = s.waterFails;
  _zoneLogsNotFound = s.logsNotFound;
  _zoneIronMined = s.ironMined;
  _zoneMiningMs = s.miningMs;
  _lastMigrationAt = s.lastMigrationAt;
  _zoneWaterWin = s.waterFailsWin || [];
  _zoneLogsWin = s.logsNotFoundWin || [];
  _zoneIronWin = s.ironMinedWin || [];
  // ⚠️ Aller-retour complet (piège #61) : lus ICI, réécrits par _zoneStateNow, relus par zoneStateLoad.
  _lastMigrationFailed = s.lastMigrationFailed === true;
  _failedTargets = Array.isArray(s.failedTargets) ? s.failedTargets : [];
  _lastMigrationReason = typeof s.lastMigrationReason === 'string' ? s.lastMigrationReason : null;
}

/** Sérialise l'état de zone courant pour le mémo de base.
 *  Les fenêtres y vont ÉLAGUÉES : bornées (≤21 seaux), elles ne font pas enfler le mémo — et elles
 *  DOIVENT y aller, sinon un bot qui meurt toutes les 3 min réapprend la zone à chaque respawn
 *  (la mémoire d'échec par process, pièges #52 et #63b). */
function _zoneStateNow() {
  const now = Date.now();
  return {
    anchoredAt: _zoneAnchoredAt, waterFails: _zoneWaterFails, logsNotFound: _zoneLogsNotFound,
    ironMined: _zoneIronMined, miningMs: _zoneMiningMs, lastMigrationAt: _lastMigrationAt,
    waterFailsWin: windowPrune(_zoneWaterWin, now),
    logsNotFoundWin: windowPrune(_zoneLogsWin, now),
    ironMinedWin: windowPrune(_zoneIronWin, now),
    lastMigrationFailed: _lastMigrationFailed,
    failedTargets: pruneFailedTargets(_failedTargets, now),
    lastMigrationReason: _lastMigrationReason,
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
  // Un `timeout` de récolte de bois (logs, lj_stock…) pèse plus qu'un `not_found` (zone.zoneFailureWeight).
  const w = zoneFailureWeight(goalName, reason) || 1;
  const now = Date.now();
  // Chaque échec alimente DEUX compteurs : le cumul de zone (verrou `noWood`, qui doit tenir
  // jusqu'à la migration) et la fenêtre glissante (le verdict, qui juge un DÉBIT).
  if (kind === 'water') { _zoneWaterFails += 1; _zoneWaterWin = windowAdd(_zoneWaterWin, 1, now); }
  else if (kind === 'wood') {
    _zoneLogsNotFound += w;
    _zoneLogsWin = windowAdd(_zoneLogsWin, w, now);
    _needsWoodTrip = true;
  }
}

// Rendement fer : mesuré par ÉCHANTILLONNAGE de l'inventaire (branchMine n'émet pas par minerai,
// et un event par bloc serait un emballement). On ne compte que les HAUSSES : un dépôt à la base
// fait baisser le stock sans que la zone y soit pour rien.
// ⚠️ SEULE SOURCE du fer de zone (fix 19/10) : le ramassage opportuniste ajoutait aussi +1 par
// minerai cassé, puis cet échantillon recomptait le même brut arrivé en poche — chaque fer ramassé
// comptait DOUBLE (rendement gonflé, verdict `exhausted` retardé). Décision pure : zone.ironSampleGain.
let _lastIronSample = null;
function sampleZoneIron() {
  try {
    const r = ironSampleGain(_lastIronSample, ironUnits(buildCtxInv(bot)));
    if (r.gained > 0) {
      _zoneIronMined += r.gained;
      _zoneIronWin = windowAdd(_zoneIronWin, r.gained, Date.now());   // le RENDEMENT courant
    }
    _lastIronSample = r.last;
  } catch (e) { /* best-effort */ }
}

/** Cellules de biome + cellules épuisées de la carte partagée du groupe (ou {} si illisible). */
function loadWorldCells() {
  try {
    const mem = args['world-memory'] ? loadMemory(String(args['world-memory'])) : null;
    const w = (mem && mem.worlds && mem.worlds[bot._worldKey || worldKey(bot, args['world-label'])]) || {};
    return { biomes: w.biomes || [], depleted: w.depleted || [], ores: w.ores || [], finds: w.finds || [] };
  } catch (e) { return { biomes: [], depleted: [], ores: [], finds: [] }; }
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
 *
 * ⚠️ MIGRATION EXCLUSIVE (fix 18/08 — 360 sessions des 17-18/08 : 917 `zone_migration_start` pour
 * 72 `zone_migrated`, l'écrasante majorité des échecs à `moved: 0..27`). Lancée par le timer, elle
 * tournait EN PARALLÈLE du planner : pendant ses jambes, celui-ci exécutait ses buts
 * (`explore_waypoint` ×13, `help_pick`/`pick_recovery` → /home safe, `work_return` → /home work =
 * retour au VIEUX chantier). Le pathfinder n'a qu'un but : chaque but posé annulait la jambe, chaque
 * /home ramenait le bot en arrière. Elle PRÉEMPTE donc le planner (taskCtl), attend qu'il ait rendu
 * la main, marche seule, puis le relance.
 */
// ─── WATCHDOG DU PLANNER (live 21/10, NethBot3 session 48) ───────────────────────────────────────
// `shelter dig_in` puis plus UN event pendant 10+ min, jour levé : le planner attendait un abri dont le
// creusage ne rendait jamais la main. Les bornes locales (digBound, étapes de l'abri) traitent la cause ;
// ce filet traite le SYMPTÔME, quelle qu'en soit la cause future : plus aucun `goal` depuis 6 min hors
// immobilité légitime BORNÉE (plannerWatchdogVerdict) → `planner_watchdog`, abri en cours annulé,
// creusage coupé, puis relance de startAutonomous selon le patron de migrateZone (jeton capturé,
// attente que le skill / le runner en vol rende la main, ≤ MIGRATION_PREEMPT_WAIT_MS).
function plannerWatchdogState(at) {
  const now = Number.isFinite(at) ? at : Date.now();
  const objType = world.objective && world.objective.type;
  return {
    now,
    // planner à CHAÎNE seulement (mapper/resource n'émettent pas de `goal`)
    active: taskCtl.active === 'autonomous' && !!(world.objective && world.objective.status === 'in_progress')
      && objType !== 'mapper' && objType !== 'resource' && _autoRunners > 0,
    lastGoalAt: _lastGoalAt, lastFireAt: _plannerWatchdogAt,
    migrating: _migrating || _ljSwitching,
    shelterSince: _shelterInFlight ? _shelterStartedAt : 0,
    sleeping: !!bot.isSleeping, nightHold: _nightHold, skillInFlight: _skillInFlight,
  };
}
async function plannerWatchdogTick(at) {
  if (_plannerWatchdogBusy) return null;
  const now = Number.isFinite(at) ? at : Date.now();
  const v = plannerWatchdogVerdict(plannerWatchdogState(now));
  if (!v.fire) return v;
  _plannerWatchdogBusy = true;
  _plannerWatchdogAt = now;
  try {
    emit({ type: 'planner_watchdog', why: v.why, idle_s: v.idleS, shelter: !!_shelterInFlight,
      skills: _skillInFlight, runners: _autoRunners, digging: !!bot.targetDigBlock });
    if (_shelterTok) _shelterTok.cancelled = true;      // l'abri en cours (jeton propre) s'arrête
    const tok = taskCtl.begin('planner_watchdog', () => { try { stopMotion({ arm: true }); } catch (e) {} });
    const w0 = Date.now();
    while ((_skillInFlight > 0 || _autoRunners > 0) && !tok.cancelled && Date.now() - w0 < MIGRATION_PREEMPT_WAIT_MS) {
      await sleep(250);
    }
    if (tok.cancelled) return v;                        // préempté (mort, ordre) : celui qui a la main gère
    if (_autoRunners > 0 || _shelterInFlight) {
      // Le runner gelé n'a pas rendu la main : on ne le REJOINT pas (maybeNightShelter rejoindrait l'abri zombie).
      emit({ type: 'planner_watchdog_zombie', runners: _autoRunners, shelter: !!_shelterInFlight });
      _shelterInFlight = null; _shelterTok = null; _stillBusy = false;
    }
    taskToken = tok;
    startAutonomous(null).catch((e) => emit({ type: 'error', message: String((e && e.message) || e) }));
    return v;
  } finally { _plannerWatchdogBusy = false; }
}
setInterval(() => { plannerWatchdogTick().catch(() => {}); }, 30000);

// ─── PLANNER ORPHELIN (live 24/10, NethBot1 s599 : 18 min sans `goal` après deux charges squelette
// enchaînées) : objectif à chaîne en cours, bot vivant, AUCUN runner, rien de légitime ne le retient, plus un
// `goal` depuis 3 min → relance `planner_revived`. Le watchdog ci-dessus ne voit pas ce cas : il exige un
// runner vivant sous `taskCtl.active === 'autonomous'` (planner GELÉ), ici le planner est MORT.
function plannerOrphanState(at) {
  const now = Number.isFinite(at) ? at : Date.now();
  const objType = world.objective && world.objective.type;
  return {
    now,
    chain: !!(world.objective && world.objective.status === 'in_progress') && objType !== 'mapper' && objType !== 'resource',
    alive: !!(bot.entity && bot.health > 0),
    runners: _autoRunners, owner: taskCtl.active, parked: _plannerParked,
    lastGoalAt: _lastGoalAt, orphanSince: _plannerOrphanSince, lastFireAt: _plannerReviveAt,
    migrating: _migrating || _ljSwitching, shelter: !!_shelterInFlight, sleeping: !!bot.isSleeping,
    nightHold: _nightHold, skillInFlight: _skillInFlight,
    survivalBusy: _skelRushBusy || _escaping || _foodTripBusy || _huntCookBusy > 0 || _imminentBusy || _stillBusy || _plannerWatchdogBusy || _baseBusy,
  };
}
function plannerOrphanTick(at) {
  const now = Number.isFinite(at) ? at : Date.now();
  const v = plannerOrphanVerdict(plannerOrphanState(now));
  if (!v.orphan) _plannerOrphanSince = 0;
  else if (!_plannerOrphanSince) _plannerOrphanSince = now;
  if (!v.fire) return v;
  _plannerReviveAt = now;
  _plannerOrphanSince = 0;
  emit({ type: 'planner_revived', idle_s: v.idleS, owner: taskCtl.active || null, objective: world.objective && world.objective.type });
  try {
    startAutonomous(null).catch((e) => emit({ type: 'error', message: String((e && e.message) || e) }));
  } catch (e) { /* best-effort */ }
  return v;
}
setInterval(() => { try { plannerOrphanTick(); } catch (e) { /* best-effort */ } }, 15000);

async function migrateZone(reason) {
  if (_migrating) return;
  // Uniquement par-dessus le planner AUTONOME : jamais par-dessus un ordre joueur (follow/guard/…)
  // ni sur un bot sans tâche — dans ces cas ni migration ni cooldown. Et pas sans objectif en cours :
  // un planner FINI (objectif soldé) n'a rien à relancer derrière nous.
  if (taskCtl.active !== 'autonomous') return;
  if (!(world.objective && world.objective.status === 'in_progress')) return;
  const from = currentAnchor();
  if (!from) return;
  _migrating = true;
  _migrationLegs = 0;
  _migrationResume = null;      // une migration (re)part : la reprise en attente est consommée
  _migrationTarget = null;
  const t0 = Date.now();
  // PRÉEMPTION : `begin` annule le jeton du planner (cleanup = stopMotion) et nous rend le NÔTRE,
  // capturé LOCALEMENT. On ne lit JAMAIS le global : une tâche lancée pendant la migration (mort →
  // onSpawn → startAutonomous, ordre joueur, évasion) annule `tok`, et la migration doit alors
  // s'arrêter — pas continuer en parallèle sous le jeton neuf (classe du « jeton de génération »).
  const tok = taskCtl.begin('migration', stopMotion);
  let target = null;
  try {
    // ATTENDRE QUE LE PLANNER RENDE LA MAIN avant de marcher (≤30 s). Pendant cette attente le global
    // `taskToken` reste VOLONTAIREMENT sur le jeton annulé du planner : le code en vol qui le relit
    // entre deux étapes d'un skill (`if (taskToken.cancelled)` de huntCook, de la descente, de
    // startResource…) voit l'annulation et sort, au lieu de repartir sous le jeton VIVANT de la
    // migration (la descente reprendrait 600 s de creusage pendant qu'on essaie de marcher).
    const w0 = Date.now();
    while ((_skillInFlight > 0 || _autoRunners > 0) && !tok.cancelled
        && Date.now() - w0 < MIGRATION_PREEMPT_WAIT_MS) {
      await sleep(250);
    }
    if (tok.cancelled) {
      // Préemptés AVANT d'avoir fait un pas (mort, ordre) : ce n'est pas un échec du trek → pas de
      // cooldown ; une urgence → reprise dès que le planner a de nouveau la main.
      const eff = migrationCancelEffect({ preemptedBy: taskCtl.active, interrupts: _migrationInterrupts });
      if (eff.resume) { _migrationResume = { reason, at: Date.now() }; _migrationInterrupts += 1; }
      else { _migrationInterrupts = 0; if (eff.armCooldown) noteMigrationFailed(null); }
      emit({ type: 'zone_migration_aborted', reason, phase: 'preempt_wait', waited_ms: Date.now() - w0,
        by: taskCtl.active || null, resume: eff.resume });
      return;
    }
    const waitedMs = Date.now() - w0;
    const waitTimeout = _skillInFlight > 0 || _autoRunners > 0;   // un skill zombie traîne encore
    // La migration possède le bot : le global la suit (watchdog PV, secureSpot de safeWarpHome…).
    taskToken = tok;
    // SCELLÉ PAR UN ABRI ENCORE EN ATTENTE (live 21/10, NethBot1) : shelterUntilDawn a pu laisser le
    // bot muré après une annulation précédente (« le nouveau maître décide », cf. skills/shelter.js) —
    // sans ça, les jambes ci-dessous rendent `moved:0` en boucle (canDig:false sur les jambes de
    // migration) jusqu'à ce que le watchdog jam_loop abandonne, plusieurs minutes plus tard. On l'en
    // fait sortir ICI, avant le premier pas. No-op si rien n'est en attente.
    try { await exitPendingShelter(bot, tok, { emit, sleep }); } catch (e) { /* best-effort */ }
    const cells = loadWorldCells();
    // « Si une zone a été vidée de ses minerais, il s'éloigne de BEAUCOUP » (Massii) : pour un
    // épuisement, la cellule d'à côté est le même sous-sol déjà fouillé → plancher bien plus haut.
    const minDist = minDistFor(reason);
    // `avoid` : les cibles RATÉES depuis < 45 min — la cible est déterministe, sans ça le re-essai
    // visait exactement la cellule qui venait d'échouer (fix 18/08).
    // BOIS (23/10) : la cible est une forêt CONNUE (biome boisé ou bûches vues), choisie depuis la
    // position RÉELLE du bot s'il est en surface ; une 2ᵉ migration bois écarte la zone d'arrivée pelée.
    const pickFrom = migrationOrigin({ reason, anchor: from, pos: bot.entity && bot.entity.position, surfaceMinY: SAFE_HOME_MIN_Y }) || from;
    target = pickMigrationTarget({
      from: pickFrom, biomes: cells.biomes, depleted: cells.depleted, finds: cells.finds, minDist, reason,
      avoid: woodRetryAvoid({ avoid: _failedTargets, reason, lastReason: _lastMigrationReason, anchor: from, now: Date.now() }),
      now: Date.now(),
    });
    // Claim PARTAGÉ : si un coéquipier a déjà fixé la cible, on adopte la sienne — l'escouade doit
    // atterrir au MÊME endroit même si les cartes divergent d'un bot à l'autre.
    _migrationTarget = target ? { x: target.x, z: target.z } : null;
    if (target && _teamClaims) {
      const key = 'migration:' + Math.round(target.x / 128) + ',' + Math.round(target.z / 128);
      try { _teamClaims.tryClaim(key); } catch (e) { /* best-effort */ }
    }
    emit({
      type: 'zone_migration_start', reason,
      fromX: Math.round(from.x), fromZ: Math.round(from.z),
      toX: target ? target.x : null, toZ: target ? target.z : null,
      source: target ? target.source : 'blind', biome: target ? target.biome : null,
      waited_ms: waitedMs, wait_timeout: waitTimeout,
    });

    let travelFrom = { x: from.x, z: from.z };   // origine RÉELLE du voyage (mise à jour après la remontée)
    let yRef = SAFE_HOME_MIN_Y + 4;              // altitude de référence du voyage : la SURFACE
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
      if (pUp && pUp.y < SAFE_HOME_MIN_Y && !tok.cancelled) {
        emit({ type: 'zone_migration_surfacing', from_y: Math.round(pUp.y), via: 'home_safe' });
        try {
          await safeWarpHome(HOME_SAFE, { ctx: 'migration_surfacing' });
        } catch (e) { /* best-effort */ }
        // Repli : si le home a ete refuse (teleport-safety) — ou s'il est CAMPÉ (veto, 19/10) — on
        // tente quand meme la remontee a pied.
        const pAfterWarp = bot.entity && bot.entity.position;
        if (pAfterWarp && pAfterWarp.y < SAFE_HOME_MIN_Y && !tok.cancelled) {
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
      if (pT) { travelFrom = { x: pT.x, z: pT.z }; yRef = Math.round(pT.y); }
    }
    // NUIT EN ROUTE (fix 18/08) : le verdict ne LANCE plus de migration la nuit, mais un trek de
    // 600-1200 blocs commencé au crépuscule finit en pleine nuit — un bot à < 2 pièces qui continue
    // de marcher en hard meurt, et sa mort fait échouer la migration. On s'arrête PROPREMENT avant la
    // jambe suivante : l'arrivée est jugée telle quelle (migrationArrivalOk tranche succès/échec),
    // puis le planner relancé reprend la main — abri de nuit compris. Décision : caution.migrationCaution.
    let nightStopped = false;
    const nightStop = () => {
      if (nightStopped) return true;
      let worn = 0;
      try { worn = _wornArmor().size; } catch (e) { /* inventaire pas livré → 0 = prudent */ }
      const night = (bot.time && bot.time.timeOfDay != null) ? isNight(bot) : null;
      if (migrationCaution({ worn, isNight: night }) !== 'stop') return false;
      nightStopped = true;
      emit({ type: 'zone_migration_night_stop', reason, legs: _migrationLegs, worn });
      return true;
    };
    if (target) {
      // ⚠️ UNE CIBLE HORS DES CHUNKS CHARGES EST INVISIBLE DU PATHFINDER (view-distance 6 = 96
      // blocs, verifie sur le serveur). Un goto direct vers 250+ blocs rend NoPath en quelques
      // secondes — c'est ce qui donnait `hop_failed moved:8` a chaque migration bois. Au-dela du
      // rayon charge on part DIRECTEMENT par jambes de 64 blocs, chacune dans le champ de vision.
      const dFar = Math.hypot(target.x - travelFrom.x, target.z - travelFrom.z);
      const hops = dFar > LOADED_RADIUS ? 0 : 6;
      if (!hops) emit({ type: 'zone_migration_legs', dist: Math.round(dFar), reason: 'beyond_loaded' });
      // Trajet borné et découpé : un goto unique de 1500 blocs ne rend jamais la main proprement.
      for (let hop = 0; hop < hops && !tok.cancelled; hop++) {
        if (nightStop()) break;
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
      if (moved < MIGRATE_MIN_PROGRESS && !nightStopped) {
        if (hops) emit({ type: 'zone_migration_hop_failed', moved: Math.round(moved), toX: target.x, toZ: target.z });
        // ⚠️ CONTOURNEMENT D'OBSTACLE (cause racine mesuree world_mn12, 28/07 : `moved:1/9`
        // underground:false en 24 jambes = NoPath en boucle). La jambe vise `GoalNearXZ`+`canDig=false` ;
        // sur terrain vallonne/obstrue le pathfinder rend NoPath INSTANTANE, le bot ne bouge pas, et la
        // jambe suivante — au MEME cap depuis la MEME position — re-vise le MEME point inatteignable.
        // On compte les jambes qui n'avancent pas (`stuck`) et on DEVIE le cap pour contourner
        // (`legHeading`) au lieu de re-percuter l'obstacle. Le cap de base est re-calcule vers la
        // cible a chaque jambe : des qu'on progresse, `stuck` retombe a 0 et on repointe droit dessus.
        let stuck = 0;
        for (let i = 0; i < MAX_LEGS && !tok.cancelled; i++) {
          if (nightStop()) break;
          const pl = bot.entity && bot.entity.position;
          const base = pl ? { x: pl.x, z: pl.z } : from;
          const heading = legHeading(Math.atan2(target.z - base.z, target.x - base.x), stuck);
          const leg = migrationLeg({ from: base, heading, legs: i });
          if (!leg) break;
          await migrationLegTo(leg, yRef, tok);
          _migrationLegs = i + 1;
          const pn = bot.entity && bot.entity.position;
          const legMoved = (base && pn) ? Math.hypot(pn.x - base.x, pn.z - base.z) : 0;
          stuck = legMoved < LEG_STUCK_MIN ? stuck + 1 : 0;   // jambe sur place → on deviera au prochain tour
          if (pn && Math.hypot(pn.x - target.x, pn.z - target.z) <= 48) break;   // arrivé
          // ⚠️ « le terrain est bon ici » ne peut sortir de la boucle QU APRES avoir vraiment
          // bouge (mesure live : `zone_migration_legs dist:297` puis `moved: 0`). Au point de
          // depart le bot est a sa base, souvent avec des arbres en vue → `legIsGood` etait vrai
          // des la premiere iteration et cassait la marche AVANT le moindre pas. Or la zone vient
          // precisement d etre jugee sans bois : ce qu il voit ne suffit pas, il doit partir.
          // ⚠️ ET LE PLANCHER DÉPEND DU MOTIF (fix 18/08 : les 43 `depleted` « réussies » ont dist
          // 50-250) : un épuisement (plancher 600) ne s'arrête plus au premier bosquet à 64 blocs —
          // c'était déménager dans le même secteur vidé. Le bois, lui, garde ses 64 blocs.
          const gone = pn ? Math.hypot(pn.x - travelFrom.x, pn.z - travelFrom.z) : 0;
          const distToTarget = pn ? Math.hypot(pn.x - target.x, pn.z - target.z) : Infinity;
          if (pn && migrationEarlyExitOk({ reason, gone, minDist, distToTarget })
              && legIsGood(probeTerrain())) break;
        }
      }
    } else {
      // MARCHE À L'AVEUGLE : on continue tant que le terrain n'est pas bon, cap total borné.
      // Même contournement d'obstacle qu'en migration ciblée : une jambe qui NoPath ne doit pas
      // re-percuter le même point — on dévie le cap (`legHeading`) tant qu'on n'avance pas.
      const heading0 = basecamp.headingForName(bot.username, 3);
      let stuck = 0;
      for (let i = 0; i < MAX_LEGS && !tok.cancelled; i++) {
        if (nightStop()) break;
        const p = bot.entity && bot.entity.position;
        const base = p ? { x: p.x, z: p.z } : from;
        const heading = legHeading(heading0, stuck);
        const leg = migrationLeg({ from: base, heading, legs: i });
        if (!leg) break;
        await migrationLegTo(leg, yRef, tok);
        _migrationLegs = i + 1;
        const pn = bot.entity && bot.entity.position;
        const legMoved = (base && pn) ? Math.hypot(pn.x - base.x, pn.z - base.z) : 0;
        stuck = legMoved < LEG_STUCK_MIN ? stuck + 1 : 0;
        // Même règle que la marche ciblée (fix 18/08) : ce test cassait SANS AUCUN plancher — au
        // départ, à la base, dès la 1re jambe s'il y avait un arbre en vue. Pas de cible ici :
        // seule la distance parcourue compte (distToTarget infini).
        const gone = pn ? Math.hypot(pn.x - travelFrom.x, pn.z - travelFrom.z) : 0;
        if (pn && migrationEarlyExitOk({ reason, gone, minDist, distToTarget: Infinity })
            && legIsGood(probeTerrain())) break;      // « le bon endroit » : arbres, au sec, pas d'océan
      }
    }

    // JAMBES SUPPLÉMENTAIRES (fix run10) : les 55 `still_depleted` avaient abandonné à 72-448 blocs,
    // jambes épuisées, alors que le plancher en demande 600. Avant de juger, on continue dans la
    // MÊME direction tant que l'arrivée serait ratée (ou les pieds dans l'eau), borné à
    // MIGRATION_EXTRA_LEGS jambes et jamais de nuit ni préemptés. Décision : zone.migrationKeepWalking.
    {
      let extraLegs = 0;
      let stuckX = 0;
      while (!tok.cancelled && !nightStopped) {
        const pc = bot.entity && bot.entity.position;
        if (!pc) break;
        const cur = { x: pc.x, z: pc.z };   // copie : bot.entity.position est muté en place
        const goneC = Math.hypot(cur.x - travelFrom.x, cur.z - travelFrom.z);
        const wetC = (function () { try { return isInWater(bot); } catch (e) { return false; } })();
        const verdictC = migrationArrivalOk({
          reason, minDist, gone: goneC,
          distToTarget: target ? Math.hypot(cur.x - target.x, cur.z - target.z) : Infinity,
          arrival: cur, depleted: depletedForZone(loadWorldCells().depleted, Date.now()),
        });
        if (!migrationKeepWalking({
          reason, gone: goneC, minDist, arrivalOk: verdictC.ok, arrivalWhy: verdictC.why, wet: wetC, extraLegs,
          distToTarget: target ? Math.hypot(cur.x - target.x, cur.z - target.z) : Infinity,
        })) break;
        if (nightStop()) break;
        // Cap : la direction effectivement suivie depuis le départ (on prolonge la marche) ; si on n'a
        // presque pas bougé, vers la cible, sinon le cap assigné au bot (même que la marche à l'aveugle).
        let baseHeading;
        if (reason === 'wood' && target) baseHeading = Math.atan2(target.z - cur.z, target.x - cur.x);   // vers la forêt visée
        else if (goneC >= LEG_STUCK_MIN) baseHeading = Math.atan2(cur.z - travelFrom.z, cur.x - travelFrom.x);
        else if (target) baseHeading = Math.atan2(target.z - cur.z, target.x - cur.x);
        else baseHeading = basecamp.headingForName(bot.username, 3);
        const leg = migrationLeg({ from: cur, heading: legHeading(baseHeading, stuckX), legs: 0 });
        if (!leg) break;
        if (extraLegs === 0) emit({ type: 'zone_migration_extend', reason, gone: Math.round(goneC), why: verdictC.why, wet: wetC });
        await migrationLegTo(leg, yRef, tok);
        extraLegs += 1;
        _migrationLegs += 1;
        const pn = bot.entity && bot.entity.position;
        const legMoved = pn ? Math.hypot(pn.x - cur.x, pn.z - cur.z) : 0;
        stuckX = legMoved < LEG_STUCK_MIN ? stuckX + 1 : 0;
      }
    }

    // ARRIVÉE : la nouvelle zone devient LA base. `safe` bouge, le confine se ré-ancre, et le memo
    // persisté fait que tout respawn (self-healing compris) repartira d'ICI — c'est la pièce qui
    // manquait aux deux tentatives précédentes (split-brain confine).
    // ⚠️ REMONTER AUSSI À L'ARRIVÉE (mesure live 02:30 : 8 échecs de migration sur 12 sont
    // `underground:true`). La remontée d'avant le voyage marche, mais les jambes visent en X/Z
    // (`GoalNearXZ`) — l'altitude est libre, donc le pathfinder plonge volontiers dans une grotte
    // ou un ravin pour atteindre le point, et le bot ARRIVE sous terre. On ne peut pas utiliser
    // `/home safe` ici (il ramènerait à l'ANCIENNE base et annulerait le déménagement) : on
    // remonte À PIED, ce qui est possible maintenant que les chunks locaux sont chargés.
    {
      const pArr = bot.entity && bot.entity.position;
      if (pArr && pArr.y < SAFE_HOME_MIN_Y && !tok.cancelled) {
        emit({ type: 'zone_migration_surfacing', from_y: Math.round(pArr.y), via: 'walk_arrival' });
        try {
          await withTimeout(bot.pathfinder.goto(new pfGoals.GoalY(SAFE_HOME_MIN_Y + 4)),
            60000, () => { try { stopMotion(); } catch (e) {} });
        } catch (e) { /* best-effort : on juge l'arrivée telle qu'elle est */ }
      }
    }
    // PRÉEMPTÉS EN ROUTE (mort → onSpawn, ordre joueur, évasion) : la position n'est plus le fruit
    // de notre marche (respawn au spawnpoint, TP) — surtout ne rien ancrer, ne rien re-pathfinder
    // par-dessus la tâche qui a pris la main. C'est un échec du trek (les morts en route faisaient
    // échouer la migration, fix 18/08) : cooldown court + cible écartée, comme les autres échecs.
    if (tok.cancelled) {
      onMigrationCancelled(reason, target, 'walk');
      return;
    }
    const p2 = bot.entity && bot.entity.position;
    const p2wet = !!(p2 && isInWater(bot));
    // On n'ancre une NOUVELLE base que si on a réellement déménagé : sans ça un goto raté
    // re-posait la base à 2 blocs et consommait le cooldown (bug mesuré sur world_mn11).
    // ⚠️ « Réellement » DÉPEND DU MOTIF (fix 18/08) : pour une zone vidée (depleted/exhausted,
    // plancher 600), 64 blocs ne suffisent plus — des jambes épuisées à 100-250 blocs ré-ancraient
    // la base dans le même secteur fouillé. Succès = 3/4 du plancher, OU cible atteinte, OU terrain
    // frais (aucune cellule épuisée à ≤ 160 blocs, carte RElue : les coéquipiers ont pu en marquer).
    const arrivalCells = loadWorldCells();
    const arrival = migrationArrivalOk({
      reason, minDist,
      gone: p2 ? Math.hypot(p2.x - travelFrom.x, p2.z - travelFrom.z) : NaN,
      distToTarget: (p2 && target) ? Math.hypot(p2.x - target.x, p2.z - target.z) : Infinity,
      arrival: p2 ? { x: p2.x, z: p2.z } : null,
      depleted: depletedForZone(arrivalCells.depleted, Date.now()),
    });
    const reallyMoved = arrival.ok;
    // ⚠️ SURFACE OBLIGATOIRE (bugfix world_mn10, 27/07) : `safe`/base/spawnpoint ne s'ancrent QUE
    // sur une vraie surface sèche. Une « migration » à l'aveugle (cible null → aucun déplacement,
    // dist ~11 blocs) laissait le mineur À SA POSITION SOUTERRAINE (y=-7) ; l'ancienne garde ne
    // testait que `!isInWater` → base sous terre → /home safe noyé → jamais de bois → `logs
    // not_found` 98.9 %, done figé à 0. Sous terre on traite la migration comme NON aboutie (le
    // bot garde son safe de surface précédent) — cf. isSurfaceSpot dans homes.js.
    // ANTI-VIDE (22/10) : l'arrivée de migration ancre base + safe + spawnpoint — jamais au-dessus d'un vide
    // (NethBot3 : base posée là où il a ensuite percé son puits). stepToSafeGround marche jusqu'au sol sûr.
    if (p2 && reallyMoved && isSurfaceSpot({ y: p2.y, inWater: p2wet }) && (await stepToSafeGround('migration'))) {
      // « Il enlève leur vieux home et il le remet au nouveau safe place » (Massii, 27/07).
      // Le `work` DOIT partir : il pointe sur le chantier de la zone qu'on vient d'abandonner —
      // le laisser en place, c'est garder un `/home work` qui re-téléporte à des centaines de
      // blocs en arrière, dans la zone qu'on a jugée morte. Puis on retire explicitement l'ancien
      // `safe` et on le repose ICI (l'ordre compte : on a déjà vérifié qu'on est au sec, donc le
      // re-sethome qui suit ne peut pas échouer sur une destination noyée).
      try { homewarp.delhome(bot, HOME_WORK); } catch (e) { /* best-effort */ }
      try { homewarp.delhome(bot, HOME_SAFE); } catch (e) { /* best-effort */ }
      if (homewarp.bookmark(bot, HOME_SAFE)) noteSafeHome(p2, 'migration');   // sol déjà vérifié : ne refuse pas en pratique   // état du process + `safeHome` persisté (le process suivant doit le savoir)
      anchorSpawnpoint('migration');   // jamais dans un camp (homeSafety.spawnpointVeto)
      const base = { x: Math.round(p2.x), y: Math.round(p2.y), z: Math.round(p2.z) };
      const st = loadBaseState() || {};
      saveBaseState(Object.assign({}, st, { base, personal: true }));
      _confineDyn = { x: base.x, z: base.z, radius: (CONFINE && CONFINE.radius) || DEFAULT_CONFINE_RADIUS };
      if (CONFINE) CONFINE = { x: base.x, z: base.z, radius: CONFINE.radius };
      _anchorSet = true;
      bot._mcaExploreBounds = { x: base.x, z: base.z, radius: Math.max(_confineDyn.radius * 2, 128) };
      _workSet = false; _forgetDeepWork('migrated');                            // l'ancien chantier est à l'autre bout du monde
      // `_zoneStateNow()` en 2e argument : les cibles RATÉES survivent au déménagement (45 min).
      _migrationInterrupts = 0;
      _applyZoneState(zoneStateAfterMigration(Date.now(), _zoneStateNow(), reason));
      _descendWaterFails = 0;
      persistZoneState();
      emit({
        type: 'zone_migrated', reason,
        fromX: Math.round(from.x), fromZ: Math.round(from.z),
        toX: base.x, toZ: base.z, legs: _migrationLegs,
        dist: Math.round(Math.hypot(base.x - from.x, base.z - from.z)),
        took_s: Math.round((Date.now() - t0) / 1000),
        arrival: arrival.why, night_stop: nightStopped,
      });
    } else {
      // Arrivée dans l'eau, SOUS TERRE, ou position illisible : on NE pose PAS la base (un home
      // mouillé/souterrain rend `/home safe` mortel). Le cooldown court quand même — on ne relance
      // pas un trek dans la foulée, et le bot garde son safe de surface précédent. Mais COURT
      // (5 min, fix 18/08) et vers une AUTRE cible : 20 min puis la même cellule = re-échec garanti.
      // Exception : un arrêt de NUIT ne prouve rien contre la cible (on s'est arrêté, on n'a pas
      // échoué à l'atteindre) → cooldown court, mais pas de mise à l'écart de 45 min.
      _migrationInterrupts = 0;
      noteMigrationFailed(nightStopped ? null : target);
      const goneFail = p2 ? Math.hypot(p2.x - travelFrom.x, p2.z - travelFrom.z) : NaN;
      const graceMs = migrationConfineGraceMs({ reason, gone: goneFail, minDist, anchored: false });
      if (graceMs > 0) {
        _confineGraceUntil = Date.now() + graceMs;
        emit({ type: 'zone_migration_confine_grace', reason, gone: Math.round(goneFail), grace_s: Math.round(graceMs / 1000) });
      }
      emit({
        type: 'zone_migration_failed', reason, wet: p2wet,
        underground: !!(p2 && !p2wet && p2.y < SAFE_HOME_MIN_Y),
        moved: p2 ? Math.round(Math.hypot(p2.x - travelFrom.x, p2.z - travelFrom.z)) : 0,
        toX: target ? target.x : null, toZ: target ? target.z : null,
        arrival: arrival.why, night_stop: nightStopped,
      });
    }
  } catch (e) {
    _migrationInterrupts = 0;
    noteMigrationFailed(target);
    emit({
      type: 'zone_migration_failed', reason, error: String((e && e.message) || e),
      toX: target ? target.x : null, toZ: target ? target.z : null,
    });
  } finally {
    _migrating = false;
    _migrationTarget = null;
    // RELANCE DU PLANNER : la migration l'a préempté, c'est donc à elle de le rallumer (succès comme
    // échec) — SAUF si une autre tâche nous a préemptés à notre tour (mort → onSpawn, ordre, évasion) :
    // celle-là gère la suite. Re-vérifié au déclenchement : on peut être préemptés pendant les 500 ms.
    if (!tok.cancelled) {
      setTimeout(() => {
        if (tok.cancelled) return;
        if (!(world.objective && world.objective.status === 'in_progress')) return;
        try {
          startAutonomous(null).catch((e) => emit({ type: 'error', message: String((e && e.message) || e) }));
        } catch (e) { /* best-effort */ }
      }, 500);
    }
  }
}

/**
 * Migration ANNULÉE en route par une autre tâche (live 23/10, NethBot1 session 397 : fuite de camp
 * de mort 658 ms après le départ). Ce n'est PAS un verdict sur la zone ni sur la cible : ni cooldown ni
 * mise à l'écart (avant : noteMigrationFailed → `stay cooldown` puis la nuit, cible bannie 45 min).
 * Urgence vitale / respawn / évasion → reprise dès que le planner a de nouveau la main
 * (maybeResumeMigration) ; ordre joueur → abandon (le joueur décide). Décision : zone.migrationCancelEffect.
 */
function onMigrationCancelled(reason, target, phase) {
  const by = taskCtl.active || null;
  const eff = migrationCancelEffect({ preemptedBy: by, interrupts: _migrationInterrupts });
  if (eff.resume) { _migrationResume = { reason, at: Date.now() }; _migrationInterrupts += 1; }
  else { _migrationResume = null; _migrationInterrupts = 0; }
  if (eff.armCooldown) noteMigrationFailed(target);   // interrompue encore et encore : le trek tue le bot
  emit({
    type: 'zone_migration_failed', reason, cancelled: true, legs: _migrationLegs, phase,
    by, resume: eff.resume, interrupts: _migrationInterrupts, gave_up: eff.armCooldown,
    toX: target ? target.x : null, toZ: target ? target.z : null,
  });
}

/** Reprise d'une migration interrompue (timer 10 s + verdict de zone). Bypass VOLONTAIRE du verdict :
 *  il a déjà tranché « migrer », l'interruption n'a rien prouvé. Décision : zone.migrationResumeDecision. */
function maybeResumeMigration() {
  const pending = _migrationResume;
  const night = (bot && bot.time && bot.time.timeOfDay != null) ? cautionNightNow() : null;   // freeRoam
  const d = migrationResumeDecision({ pending, now: Date.now(), activeTask: taskCtl.active, isNight: night, migrating: _migrating });
  if (d === 'drop') {
    _migrationResume = null;
    emit({ type: 'zone_migration_resume_dropped', reason: pending && pending.reason });
  } else if (d === 'resume') {
    _migrationResume = null;
    emit({ type: 'zone_migration_resume', reason: pending.reason, after_s: Math.round((Date.now() - pending.at) / 1000) });
    migrateZone(pending.reason).catch(() => {});
  }
  return d;
}
setInterval(() => { try { if (!IS_MAPPER) maybeResumeMigration(); } catch (e) { /* watchdog : ne crash jamais */ } }, 10000);

/** Migration ratée : cooldown COURT, cible écartée 45 min, horloge de zone intacte — persisté. */
function noteMigrationFailed(target) {
  _applyZoneState(zoneStateAfterFailedMigration(_zoneStateNow(), Date.now(), target));
  persistZoneState();
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

/**
 * Une JAMBE de migration, en restant EN SURFACE. (cause racine mesuree le 28/07 : 21 migrations,
 * 0 aboutie, majorite d echecs `underground:true` — et 61 remontees pour 21 migrations.)
 *
 * `GoalNearXZ` ne contraint que X/Z : l altitude est LIBRE, donc le pathfinder plonge volontiers
 * dans une grotte ou un ravin quand c est le chemin le moins cher, et le bot arrive sous terre.
 * On vise donc en 3D (`GoalNear`) a l altitude de reference — celle a laquelle on a demarre le
 * voyage, c est-a-dire la surface — ce qui rend les descentes couteuses sans les interdire.
 * Puis on RE-REMONTE apres chaque jambe si on a quand meme fini sous terre : court (30 s) et
 * local, au lieu des 50 blocs de roche a percer une fois arrive au bout.
 */
async function migrationLegTo(leg, yRef, tok) {
  // `tok` = jeton LOCAL de la migration (fix 18/08) : préemptés (mort, ordre), on ne pose plus aucun
  // but pathfinder — il écraserait celui de la tâche qui vient de prendre la main.
  if (tok && tok.cancelled) return;
  // ⚠️ `GoalNear(leg.x, yRef, leg.z, 16)` NE MARCHE PAS SUR DU TERRAIN VALLONNE (mesure live
  // world_mn12, 28/07 : les migrations longues echouent `moved:0 underground:false wet:false`
  // en 7-19 events = NoPath INSTANTANE, pas un timeout). Un yRef FIGE + rayon 16 est inatteignable
  // des que la surface a 64 blocs differe de plus de 16 blocs (la moindre colline/vallee) : aucun
  // noeud standable n'entre dans le rayon 3D → le pathfinder rend NoPath tout de suite, `withTimeout`
  // l'avale en silence (il resout `{ok:false}` au lieu de throw), et le bot ne bouge JAMAIS. C'est
  // le regression introduite par 18321c3 : il a bien tue l'arrivee-sous-terre (`underground` est
  // desormais false) mais l'a echangee contre un blocage total.
  //
  // Le chemin COURT (dist < 96, `hops`) utilise deja `GoalNearXZ` avec succes (mesure : `zone_migrated
  // dist:68`, arrivee en surface). On aligne donc les JAMBES dessus : `GoalNearXZ` est atteignable a
  // n'importe quelle altitude de surface. Pour empecher le plongeon-en-grotte que `GoalNearXZ` seul
  // autorisait (le vrai probleme que 18321c3 visait), on marche avec `canDig=false` : le bot suit la
  // surface sans pouvoir creuser vers le bas. Belt-and-suspenders : la remontee par jambe ci-dessous
  // rattrape le rare cas ou il finit quand meme sous terre.
  const p0 = bot.entity && bot.entity.position;
  const legFrom = p0 ? { x: p0.x, z: p0.z } : null;
  const walkLeg = async () => {
    try {
      await withTimeout(
        bot.pathfinder.goto(new pfGoals.GoalNearXZ(leg.x, leg.z, 16)),
        90000, () => { try { stopMotion(); } catch (e) {} });
    } catch (e) { /* best-effort : la jambe suivante retentera */ }
  };
  await withTempMovements(bot, Movements, { canDig: false }, walkLeg);
  if (tok && tok.cancelled) return;   // préemptés PENDANT la jambe : pas de remontée par-dessus
  // ⚠️ ENFERMÉ DANS SON ABRI / SON TUNNEL (mesure live 19/10, 3/3 bots à l'aube) : la migration part
  // au lever du jour pendant que le bot est encore dans son abri de nuit (creusé, emmuré, couvert) ou
  // au fond de son tunnel (y=50, `/home safe` refusé). `canDig:false` + enfermé = NoPath instantané,
  // les 24 jambes « s'exécutaient » en 1-2 s → `zone_migration_failed moved:1..2 arrival:too_short`.
  // Jambe sans progrès → on retente la MÊME jambe une fois EN CREUSANT (zone.legDigRetry) : le bot
  // casse le mur de son abri ou perce son tunnel, puis la re-remontée ci-dessous s'applique comme avant.
  {
    const p1 = bot.entity && bot.entity.position;
    const moved = (legFrom && p1) ? Math.hypot(p1.x - legFrom.x, p1.z - legFrom.z) : NaN;
    if (legDigRetry({ moved, cancelled: !!(tok && tok.cancelled) })) {
      // UNE fois par migration (pas par jambe) : le jeton est propre à chaque migration.
      if (!tok || !_legDigEmitted.has(tok)) {
        if (tok) _legDigEmitted.add(tok);
        emit({
          type: 'zone_migration_leg_dig', moved: Math.round(moved),
          y: p1 ? Math.round(p1.y) : null, legX: leg.x, legZ: leg.z,
        });
      }
      await withTempMovements(bot, Movements, { canDig: true }, walkLeg);
      if (tok && tok.cancelled) return;
    }
  }
  const p = bot.entity && bot.entity.position;
  if (p && p.y < SAFE_HOME_MIN_Y) {
    try {
      await withTimeout(bot.pathfinder.goto(new pfGoals.GoalY(SAFE_HOME_MIN_Y + 4)),
        30000, () => { try { stopMotion(); } catch (e) {} });
    } catch (e) { /* best-effort : la jambe suivante retentera */ }
  }
}

/** Le verdict de zone, évalué périodiquement. Migre si la zone ne vaut plus le temps qu'on y passe. */
function checkZoneVerdict() {
  if (_migrating || taskToken.cancelled || IS_MAPPER) return;   // les cartographes DOIVENT bouger, ils ne migrent pas
  // MIGRATION EXCLUSIVE (fix 18/08) : on ne juge — donc ne migre — que pendant le planner autonome.
  // Un ordre joueur (follow/guard/…) ou un bot sans tâche ne doit ni migrer ni armer de cooldown.
  if (taskCtl.active !== 'autonomous') return;
  // ⚠️ NE PAS exiger `_anchorSet` : sur une zone rasée le bot ne s'ancre jamais (pickAnchorNow
  // refusait sans arbre) — exiger l'ancre rendait donc la migration IMPOSSIBLE précisément dans
  // le cas qu'elle doit résoudre. L'horloge de zone démarre au spawn, pas à l'ancrage.
  if (!_zoneAnchoredAt) return;
  sampleZoneIron();
  const now = Date.now();
  // BÛCHERON SANS ARBRES (23/10) : 3 `lj_stock not_found` en 10 min → migration bois vers une forêt
  // CONNUE, sans attendre l'hystérésis de zone (pensée pour le minerai) — cf. lumberjack.ljWoodMigrationDue.
  if (isLumberjackObjective()) {
    try {
      _ljLoadStockFails();
      const night = (bot.time && bot.time.timeOfDay != null) ? cautionNightNow() : !diamondFreeNow();   // heure inconnue → prudence (sauf diamant complet)
      if (ljWoodMigrationDue({ notFound: _ljNotFound, now, isNight: night, lastMigrationAt: _lastMigrationAt, migrating: _migrating })) {
        emit({ type: 'lumberjack_wood_migration', not_found: _ljNotFound.length });
        _ljNotFound = [];
        _ljSaveStockFails();
        migrateZone('wood').catch(() => {});
        return;
      }
    } catch (e) { /* best-effort : le verdict normal suit */ }
  }
  const cells = loadWorldCells();
  const from = currentAnchor();
  // Une cellule sèche mappée à portée est une meilleure réponse qu'un trek : le code sait déjà y aller.
  let dryCellKnown = false;
  try {
    dryCellKnown = !!(from && driestCell(cells.ores, {
      base: from, range: 224, cellSize: 128, minOres: 12,
    }));
  } catch (e) { dryCellKnown = false; }
  // ⚠️ MINERAI ET RÉCENT SEULEMENT (fix run10) : les 31 cellules de la carte venaient de recherches
  // de BOIS et dataient de 82-888 min → `migrate depleted` (plancher 600) en boucle sur une zone dont
  // le seul vrai manque était le bois (que le verdict `wood` traite, lui, avec la forêt la plus proche).
  const depletedNear = depletedForZone(cells.depleted, now).filter((d) => from
    && Math.hypot(d.x - from.x, d.z - from.z) <= 160).length;
  // ⚠️ FENÊTRE, PAS CUMUL (fix world_mn14) : les compteurs d'ÉVÉNEMENTS entrent dans le verdict par
  // leur somme sur les 20 dernières minutes. Avec les cumuls, un bot au passé productif ne migrait
  // JAMAIS d'une zone morte — 150 fers cumulés / 0 récent / 23 cellules épuisées autour → `stay`.
  const waterFailsRecent = windowSum(_zoneWaterWin, now);
  const logsNotFoundRecent = windowSum(_zoneLogsWin, now);
  const ironMinedRecent = windowSum(_zoneIronWin, now);
  const v = zoneVerdict({
    minutesInZone: (now - _zoneAnchoredAt) / 60000,   // hystérésis : cumulée, c'est sa raison d'être
    waterFails: waterFailsRecent,
    logsNotFound: logsNotFoundRecent,
    ironMined: ironMinedRecent,
    miningMinutes: _zoneMiningMs / 60000,             // chronomètre d'effort, pas un flux d'événements
    depletedNear,
    dryCellKnown,
    lastMigrationAt: _lastMigrationAt,
    lastMigrationFailed: _lastMigrationFailed,   // échec → cooldown 5 min au lieu de 20 (fix 18/08)
    lastMigrationReason: _lastMigrationReason,   // `wood` + arrivée sans arbres → seuils d'urgence (23/10)
    // Pas de trek de nuit (fix 18/08). `bot.time` peut manquer juste après un spawn : `null` =
    // heure inconnue → pas de gate (comme mapperNightGuard), plutôt que de conclure « il fait jour ».
    isNight: (bot.time && bot.time.timeOfDay != null) ? cautionNightNow() : null,   // diamant complet : migre de nuit (freeRoam)
    now,
  });
  // TRACE : sans elle, un 'stay' est muet → on ne peut pas voir QUELLE porte bloque la migration
  // (trop tôt / cooldown / cellule sèche connue). Dédup au changement de raison (anti-emballement).
  const tel = verdictTelemetry(v, _lastZoneVerdictReason);
  _lastZoneVerdictReason = tel.reason;
  // Les champs sans suffixe sont CE QUE LE VERDICT A VU (la fenêtre) ; les `*Total` sont le cumul
  // de zone. C'est la comparaison des deux qui a permis de trouver le bug — sans elle, un
  // `ironMined: 150` sur un bot qui ne mine plus depuis des heures reste indéchiffrable.
  if (tel.log) emit({
    type: 'zone_verdict', verdict: v.verdict, reason: v.reason,
    minutesInZone: Math.round((now - _zoneAnchoredAt) / 60000),
    windowMin: Math.round(ZONE_WINDOW_MS / 60000),
    waterFails: waterFailsRecent, logsNotFound: logsNotFoundRecent, ironMined: ironMinedRecent,
    waterFailsTotal: _zoneWaterFails, logsNotFoundTotal: _zoneLogsNotFound, ironMinedTotal: _zoneIronMined,
    miningMinutes: Math.round(_zoneMiningMs / 60000),
    depletedNear, dryCellKnown,
    lastMigrationFailed: _lastMigrationFailed, failedTargets: _failedTargets.length,
  });
  persistZoneState();          // les compteurs accumulés doivent survivre au prochain respawn
  if (v.verdict === 'migrate') migrateZone(v.reason).catch(() => {});
}

// MIGRATION EXCLUSIVE (fix 18/08) : aucun pas de planner ne DÉMARRE pendant une migration. Dès
// qu'elle possède le bot, le global `taskToken` est le SIEN (vivant) : un planner en retard qui
// arrive dans runSkillWithTelemetry n'y verrait pas d'annulation et repartirait (combat de
// settleSurvivalKit, skill) par-dessus les jambes de migration.
// ⚠️ `taskCtl.active`, PAS `_migrating` : une migration préemptée à son tour (mort → onSpawn →
// nouveau planner) garde `_migrating` vrai le temps de se dérouler (safeWarpHome : plusieurs s).
// Le NOUVEAU planner recevrait alors {ok:false} en rafale instantanée → failStreak 4 → stalled.
function migrationOwnsBot() { return taskCtl.active === 'migration'; }

// ─── NUIT AU TRAVAIL (21/10, nightWork.js) ───────────────────────────────────────────────────────
// Mesure (run de zéro du 21/10) : NethBot3 zéro → 4 pièces de fer en 53 min, dont ~17 min de nuit
// passées dans un trou à attendre l'aube. Un joueur nu, la nuit, descend en escalier, rebouche derrière
// lui, pose une torche et mine : la nuit ne change rien sous terre. À la place de l'abri (holdForNight,
// pas 'shelter') : si le bot a une pioche, descente (descendDiagonal) jusqu'à 12 blocs sous la surface ou
// y < 45, sceau des cases ouvertes autour de lui, torche, puis le planner reprend — les buts de surface
// (bois, chasse, lit…) sont DIFFÉRÉS à l'aube (nightSkipGoal), le reste (pierre, charbon, fer, crafts,
// fonte) continue. Sans pioche, ou si la descente échoue : l'abri historique (une tentative par nuit).
// ⚠️ NIVEAU MODULE (piège #56) : lu par le planner, maybeNightShelter et les timers.
let _nightWork = null;            // { surfaceY, night, at } — relevé de la descente de cette nuit
let _nightWorkTriedNight = null;  // nuit (bot.time.day) de la dernière tentative : une seule par nuit
const _nightDeferAt = {};         // throttle des events `night_defer` : 1×/min par but
const _nightDeferReturnAt = {};   // holdForNight : dernière main rendue au planner pour un but différé
const NIGHT_DEFER_RETURN_MS = 30000;
const NIGHT_WORK_DESCENT_MS = 180000;   // ~12 paliers ≈ 30 s ; le garde-fou couvre une descente lente
const { cellBlockItem: _nightCellItem } = require('./skills/shelter');

function _nightId() { return (bot && bot.time && bot.time.day != null) ? bot.time.day : null; }

/** Le bot est-il « sous terre » pour la discipline de nuit ? y < 45, ou descendu et scellé cette nuit. */
function nightUndergroundNow() {
  const p = bot && bot.entity && bot.entity.position;
  // Ciel au-dessus ? (24/10) seulement dans la frange 45-50 où il départage grotte et vallée : ≥ 2 blocs pleins
  // (hors feuillage) dans les 24 au-dessus de la tête = sous roche.
  let covered = false;
  try {
    if (p && p.y >= 45 && p.y < 50) {
      let solid = 0;
      for (let dy = 2; dy <= 24 && solid < 2; dy++) {
        const b = bot.blockAt(p.floored().offset(0, dy, 0));
        if (b && b.boundingBox === 'block' && !/leaves$/.test(b.name)) solid++;
      }
      covered = solid >= 2;
    }
  } catch (e) { covered = false; }
  return nightUnderground(_nightWork, { y: p ? p.y : null, night: _nightId(), now: Date.now(), covered });
}

/** Planner (opts.skip) : but de surface différé à l'aube quand le bot travaille sous terre de nuit. */
// ── BUTS OPTIONNELS (24/10, pioche de rechange de la chaîne diamant) ─────────────────────────────
// Un but `optional:true` qui échoue est mis de côté OPTIONAL_GOAL_HOLD_MS : firstUnmet passe au suivant
// (diamond_caves) au lieu de laisser le planner caler dessus (stall → retry 90 s → même échec, à vie).
// ⚠️ NIVEAU MODULE (piège #56) : lu par le skip du planner.
const OPTIONAL_GOAL_HOLD_MS = 10 * 60 * 1000;
const _optionalFailAt = new Map();
function optionalGoalHeld(g) {
  if (!g || !g.optional) return false;
  const at = _optionalFailAt.get(g.name);
  return !!at && Date.now() - at < OPTIONAL_GOAL_HOLD_MS;
}
function noteOptionalGoalResult(g, r) {
  if (!g || !g.optional) return;
  if (r && r.ok === false) {
    _optionalFailAt.set(g.name, Date.now());
    emit({ type: 'optional_goal_held', goal: g.name, reason: (r && r.reason) || null, for_s: OPTIONAL_GOAL_HOLD_MS / 1000 });
  } else if (r && r.ok) _optionalFailAt.delete(g.name);
}

function nightSkipGoal(g) {
  let lockdown = false;
  try { lockdown = nightLockdownNow(); } catch (e) { lockdown = false; }
  if (!lockdown) return false;
  const d = nightDeferGoal({ lockdown, underground: nightUndergroundNow(), skill: g && g.skill });
  if (d) {
    const now = Date.now();
    const k = (g && g.name) || '?';
    if (now - (_nightDeferAt[k] || 0) >= 60000) { _nightDeferAt[k] = now; emit({ type: 'night_defer', goal: k }); }
  }
  return d;
}

/** Distance du plus proche hostile à craindre (null si aucun). Jamais de throw. */
function _nearestThreatDist() {
  try {
    const p = bot.entity && bot.entity.position;
    if (!p) return null;
    let best = null;
    for (const t of respawnThreatsNow()) {
      const d = Math.hypot(t.x - p.x, t.y - p.y, t.z - p.z);
      if (best == null || d < best) best = d;
    }
    return best;
  } catch (e) { return null; }
}

/** Pose un bloc de remblai dans `cell` contre une face pleine voisine. true si posé. Jamais de throw. */
async function _nightFill(cell) {
  try {
    const it = _nightCellItem(bot);
    if (!it) return false;
    for (const [dx, dy, dz] of [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) {
      const ref = bot.blockAt(vec3Lib(cell.x + dx, cell.y + dy, cell.z + dz));
      if (!ref || ref.boundingBox !== 'block') continue;
      try {
        await bot.equip(it, 'hand');
        await bot.placeBlock(ref, vec3Lib(-dx, -dy, -dz));
        return true;
      } catch (e) { /* autre face */ }
    }
  } catch (e) { /* best-effort */ }
  return false;
}

/** Bouche les cases ouvertes autour du bot (pieds, tête, dessus). → nb de blocs posés. */
async function nightSeal() {
  const p = bot.entity && bot.entity.position;
  if (!p) return 0;
  const isOpen = (c) => {
    const b = bot.blockAt(vec3Lib(c.x, c.y, c.z));
    return !!b && b.boundingBox === 'empty' && !/water|lava/.test(b.name || '');
  };
  let n = 0;
  for (const c of nightSealCells({ x: p.x, y: p.y, z: p.z }, isOpen)) {
    if (await _nightFill(c)) n++;
  }
  return n;
}

/** Torche au sol, sous les pieds (même geste que _caveTorch, sans son rationnement). */
async function nightTorch() {
  try {
    const p = bot.entity && bot.entity.position;
    const torch = ((bot.inventory && bot.inventory.items()) || []).find((i) => i.name === 'torch');
    if (!p || !torch) return false;
    // Une torche à ≤ 11 blocs éclaire déjà la cachette (rationnement 24/10) : on n'en rajoute pas.
    const near = nearestTorchDist(bot, { x: p.x, y: p.y, z: p.z });
    if (near != null && near <= 11) return false;
    const ref = bot.blockAt(p.floored().offset(0, -1, 0));
    if (!ref || ref.boundingBox !== 'block') return false;
    await bot.equip(torch, 'hand');
    await bot.placeBlock(ref, vec3Lib(0, 1, 0));
    try { sharedTorchRegistry.note({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }); } catch (e) { /* best-effort */ }
    return true;
  } catch (e) { return false; }
}

/**
 * La tombée de la nuit, bot nu en surface : descendre travailler au lieu d'attendre l'aube.
 * true = le bot est maintenant sous terre et scellé (le planner reprend) ; false = l'abri historique.
 */
async function tryNightWork(opts = {}) {
  const fromShelter = (opts && opts.fromShelter) || null;   // { surfaceY, cellMode } : départ du fond de l'abri
  const night = _nightId();
  const p0 = bot.entity && bot.entity.position;
  if (!p0) return false;
  let inWater = false;
  try { inWater = isInWater(bot); } catch (e) { inWater = false; }
  const items = (bot.inventory && bot.inventory.items()) || [];
  const sig = () => {
    const q = bot.entity.position;
    return {
      y: q.y, hasPick: items.some((i) => i && /_pickaxe$/.test(i.name)), inWater,
      hostileDist: _nearestThreatDist(), isMapper: IS_MAPPER, isLumberjack: isLumberjackObjective(),
      triedThisNight: night != null && _nightWorkTriedNight === night,
      fromShelter: !!fromShelter, cellMode: fromShelter ? (fromShelter.cellMode || 'pit') : undefined,
      surfaceY: fromShelter ? fromShelter.surfaceY : undefined,
    };
  };
  let plan = nightWorkPlan(sig());
  if (plan.action === 'flee') {
    try { await fleeBeforeHide('night_work'); } catch (e) { /* best-effort */ }
    if (taskToken.cancelled) return false;
    plan = nightWorkPlan(Object.assign(sig(), { hostileDist: _nearestThreatDist() }));
    if (plan.action === 'flee') return false;           // toujours serré : l'abri (et sa propre fuite)
  }
  if (plan.action !== 'descend') return false;
  _nightWorkTriedNight = night;
  emit({ type: 'night_work', phase: fromShelter ? 'from_shelter' : 'descend', y: Math.round(p0.y), target: plan.targetY });
  const r = await withTimeout(descendDiagonal(bot, { targetY: plan.targetY, maxDepth: 60, onSurvivalTick: descentSurvivalTick }, taskToken),
    NIGHT_WORK_DESCENT_MS, () => { try { stopMotion(); } catch (e) {} });
  if (taskToken.cancelled) return false;
  const q = bot.entity && bot.entity.position;
  if (!q || q.y > plan.targetY + 1.5) {
    emit({ type: 'night_work', phase: 'failed', y: q ? Math.round(q.y) : null, reason: (r && r.reason) || 'unknown' });
    return false;
  }
  _nightWork = { surfaceY: plan.surfaceY, night, at: Date.now() };
  let sealed = 0;
  try { sealed = await nightSeal(); } catch (e) { sealed = 0; }
  const torch = await nightTorch();
  emit({ type: 'night_work', phase: 'sealed', y: Math.round(q.y), sealed, torch });
  return true;
}

// ─── CRAFTER DANS LE TROU (22/10, nightWork.shelterCraftNext) ────────────────────────────────────
// Chrono « zéro → armure de fer » : 9 min de `night_hold` à la 1re nuit avec des bûches en poche, sans
// pioche (la nuit au travail l'exige). Un joueur, dans son trou fermé, fabrique planches, bâtons, table
// (posée dans la paroi du puits, reprise aussitôt), pioche en bois — puis descend en escalier. Appelé par
// shelterUntilDawn (`whileSealed`) à chaque pas de l'attente : UN craft par pas, jamais de marche
// (`_inPlace`), toit jamais touché. Pioche en main → 'leave_down' : l'abri rend la main sans sortir et
// maybeNightShelter enchaîne tryNightWork({ fromShelter }).
// ⚠️ NIVEAU MODULE (piège #56) : lu par le hook (appelé depuis l'abri) et par maybeNightShelter.
let _shelterCraft = null;          // { night, failed: Set, handoff: { surfaceY, cellMode } | null }
const SHELTER_CRAFT_MS = 45000;    // un craft (file d'attente comprise) ; withTimeout n'annule rien → stopMotion

/** Le craft a pu pousser le bot d'un bloc (ramassage) : le ramener sur sa case d'abri. Jamais de throw. */
async function _shelterRecenter(anchor) {
  try {
    const p = bot.entity && bot.entity.position;
    if (!anchor || !p || Math.hypot(p.x - anchor.x, p.z - anchor.z) < 0.7) return;
    await withTimeout(bot.pathfinder.goto(new pfGoals.GoalBlock(Math.floor(anchor.x), Math.floor(anchor.y), Math.floor(anchor.z))),
      8000, () => { try { stopMotion(); } catch (e) {} });
  } catch (e) { /* best-effort */ }
}

/** Hook `whileSealed` de l'abri : → null (rester) | 'leave_down' (pioche en main, descendre). */
async function shelterWhileSealed(info) {
  if (IS_MAPPER || !info) return null;
  try { if (!nightLockdownNow()) return null; } catch (e) { return null; }
  if (taskToken.cancelled || migrationOwnsBot()) return null;
  let wet = false;
  try { wet = isInWater(bot); } catch (e) { wet = false; }
  if (wet) return null;
  const night = _nightId();
  if (!_shelterCraft || _shelterCraft.night !== night) _shelterCraft = { night, failed: new Set(), handoff: null, lowHpSkipAt: 0 };
  const st = _shelterCraft;
  // MANGER AVANT TOUT (22/10, NethBot3 : PV bas dans son abri, faim < 18, de quoi manger, et 56
  // `night_craft torch low_hp_skip` — la garde refusait le craft « parce qu'il y a à manger » et rien
  // ne mangeait). Muré : on mange même avec un zombie derrière la paroi.
  try { if (await hungerNetTick('shelter', { sealed: true })) return null; } catch (e) { /* best-effort */ }
  const items = (bot.inventory && bot.inventory.items()) || [];
  const inv = items.map((i) => ({ name: i.name, count: i.count }));
  const next = shelterCraftNext(inv, { cellMode: info.mode, skip: st.failed });
  if (next) {
    // PV critiques : un craft refusé n'est retenté qu'une fois par minute (lowhp.shelterCraftThrottled).
    let blocked = false;
    try { blocked = craftLowHpBlocked(); } catch (e) { blocked = false; }
    if (shelterCraftThrottled({ blocked, lastSkipAt: st.lowHpSkipAt, now: Date.now() })) return null;
    const r = await withTimeout(craftSmart({ name: next.name, count: next.count, _inPlace: true }), SHELTER_CRAFT_MS,
      () => { try { stopMotion(); } catch (e) {} });
    const ok = !!(r && r.ok);
    if (r && r.reason === 'low_hp_skip') st.lowHpSkipAt = Date.now();
    // PV critiques : refus passager, pas un verdict sur la recette (on retentera dans une minute).
    if (!ok && !(r && r.reason === 'low_hp_skip')) st.failed.add(next.name);
    emit({ type: 'night_craft', goal: next.name, count: next.count, ok, reason: ok ? null : ((r && r.reason) || 'unknown'), mode: info.mode });
    await _shelterRecenter(info.anchor);
    return null;
  }
  const p = bot.entity && bot.entity.position;
  if (!p) return null;
  const a = info.anchor;
  const plan = nightWorkPlan({
    y: p.y, hasPick: items.some((i) => i && /_pickaxe$/.test(i.name)), inWater: false,
    isMapper: IS_MAPPER, isLumberjack: isLumberjackObjective(),
    triedThisNight: night != null && _nightWorkTriedNight === night,
    fromShelter: true, cellMode: info.mode,
    surfaceY: a && Number.isFinite(a.y) ? a.y + (Number(info.depth) || 0) : null,
  });
  if (plan.action !== 'descend') return null;
  st.handoff = { surfaceY: plan.surfaceY, cellMode: info.mode };
  return 'leave_down';
}

// ─── PIOCHE CASSÉE EN BAS (21/10, NethBot2 : 6 `no_pickaxe` en 37 min d'iron_deep) ──────────────
// Le branch-mine abandonnait à chaque casse ; un timer (pickFixPass) refaisait la pioche à côté, puis le
// planner relançait un couloir neuf. Un joueur sort sa table et refait une pioche pierre sur place.
/** Re-crafte une pioche pierre ICI (table portable). true si le bot a une pioche en sortant. */
// Raison du dernier échec de rebuildPickHere (lue par la branche descendDiagonal → no_pick_stuck). Niveau MODULE.
let _lastPickRebuildWhy = null;
let _noPickStuckAt = 0;
async function rebuildPickHere(where) {
  _lastPickRebuildWhy = null;
  const items = () => (bot.inventory && bot.inventory.items()) || [];
  const has = () => items().some((i) => i && /_pickaxe$/.test(i.name));
  const n = (re) => items().reduce((s, i) => s + (i && re.test(i.name) ? i.count : 0), 0);
  if (has()) return true;
  try {
    if (n(/^stick$/) < 2 && (n(/_planks$/) >= 2 || n(/_log$/) >= 1)) {
      await withTimeout(craftSmart({ name: 'stick', count: 1 }), 30000, () => {});
    }
    if (n(/^(cobblestone|cobbled_deepslate)$/) < 3 || n(/^stick$/) < 2) {
      emit({ type: 'pick_rebuild_failed', where, reason: 'no_matter', cobble: n(/^(cobblestone|cobbled_deepslate)$/), sticks: n(/^stick$/) });
      _lastPickRebuildWhy = 'no_matter';
      return false;
    }
    const r = await withTimeout(craftSmart({ name: 'stone_pickaxe', count: 1 }), 45000, () => {});
    if (has()) { emit({ type: 'pick_rebuilt', where }); return true; }
    emit({ type: 'pick_rebuild_failed', where, reason: (r && r.reason) || 'craft_failed' });
    _lastPickRebuildWhy = (r && r.reason) || 'craft_failed';
  } catch (e) { _lastPickRebuildWhy = 'error'; }
  return false;
}

// ─── FONDRE EN MINANT (21/10, furnaceJob.js) ─────────────────────────────────────────────────────
// Le four portable est POSÉ au fond de la mine, chargé (fer + charbon), et le bot CONTINUE de creuser ;
// il repasse prendre ses lingots quand c'est cuit (hook de survie du branch-mine), en fin de but, ou
// avant toute fonte / tout but qui n'est pas du minage. ⚠️ NIVEAU MODULE : lu par le timer de fonte.
let _furnaceJob = null;           // { pos, count, at, readyAt }
let _furnaceJobBusy = false;
const FURNACE_JOB_KEEP_SKILLS = new Set(['branchMine', 'descendDiagonal', 'caveIron', 'gather']);

function _furnaceDist() {
  const p = bot.entity && bot.entity.position;
  if (!_furnaceJob || !p) return null;
  const j = _furnaceJob.pos;
  return Math.hypot(p.x - j.x, p.y - j.y, p.z - j.z);
}

/** Le four de mine est-il à portée de retour (≤ SMELT_JOB_COLLECT_DIST, ou distance inconnue) ? */
function furnaceJobNear() {
  const d = _furnaceDist();
  return d == null || d <= SMELT_JOB_COLLECT_DIST;
}

// PERSISTÉ (22/10 : NethBot3 a laissé 13 minerais dans un four à la relance du process de 11:11, puis a
// manqué ses 8 lingots de plastron pendant une heure) — le four et son fer survivent au process, le
// souvenir du four doit survivre aussi. Mémo base FUSIONNÉ (on n'écrase jamais le reste).
function setFurnaceJob(j) {
  _furnaceJob = j || null;
  try {
    const next = Object.assign({}, loadBaseState() || {});
    if (_furnaceJob) next.furnaceJob = _furnaceJob; else delete next.furnaceJob;
    saveBaseState(next);
  } catch (e) { /* best-effort */ }
}

/** Relit le four de mine du process précédent (une fois par process, au spawn). */
let _furnaceJobRestored = false;
function restoreFurnaceJob() {
  if (_furnaceJobRestored) return;
  _furnaceJobRestored = true;
  if (_furnaceJob) return;
  try {
    const j = furnaceJobRestore(loadBaseState(), Date.now());
    if (j) { _furnaceJob = j; emit({ type: 'smelt_while_mining', phase: 'restored', count: j.count, x: j.pos.x, y: j.pos.y, z: j.pos.z }); }
  } catch (e) { /* best-effort */ }
}

/** Ouverture impossible (four inaccessible, chunk pas chargé, trop loin) : job GARDÉ, nouvel essai dans 3 min. */
function deferFurnaceJob(reason, why) {
  if (!_furnaceJob) return;
  setFurnaceJob(Object.assign({}, _furnaceJob, { retryAt: Date.now() + FURNACE_RETRY_MS }));
  emit({ type: 'smelt_while_mining', phase: 'open_failed', why, reason });
}

async function startFurnaceJob(count) {
  const items = () => (bot.inventory && bot.inventory.items()) || [];
  const fuel = fuelLoadPlan(items().map((i) => ({ name: i.name, count: i.count })), count);
  if (!fuel.loads.length || fuel.smeltable < 1) return false;
  const place = await placeBlockNear(bot, 'furnace');
  if (!place || !place.ok || !place.pos) return false;
  const pos = { x: place.pos.x, y: place.pos.y, z: place.pos.z };
  await waitForBlock(place.pos, 'furnace');
  await sleep(300);
  const fb = bot.blockAt(vec3Lib(pos.x, pos.y, pos.z));
  let f = null;
  try { f = fb ? await bot.openFurnace(fb) : null; } catch (e) { f = null; }
  if (!f) { await reclaimBlock(pos, 'furnace'); return false; }
  const id = (name) => bot.registry.itemsByName[name] && bot.registry.itemsByName[name].id;
  let ok = false;
  try {
    await f.putFuel(id(fuel.loads[0].name), null, fuel.loads[0].qty);
    await f.putInput(id('raw_iron'), null, fuel.smeltable);
    ok = true;
  } catch (e) { ok = false; }
  try { f.close(); } catch (e) {}
  const now = Date.now();
  setFurnaceJob({ pos, count: fuel.smeltable, at: now, readyAt: jobReadyAt(now, fuel.smeltable) });
  emit({ type: 'smelt_while_mining', phase: 'start', raw: fuel.smeltable, fuel: `${fuel.loads[0].name}x${fuel.loads[0].qty}`, ok });
  if (!ok) await collectFurnaceJob('load_failed');   // rien ne doit rester coincé dans le four
  return ok;
}

async function collectFurnaceJob(why) {
  const j = _furnaceJob;
  if (!j) return false;
  if (j.retryAt && Date.now() < j.retryAt) return false;      // ouverture ratée il y a < 3 min
  // ROUTE (22/10, furnaceCollectRoute) : un four 40 blocs sous la surface ne se rejoint pas en 40 s de
  // pathfinder depuis le /home safe ; le chantier `work` posé à côté du four, si.
  const p0 = bot.entity && bot.entity.position;
  let inWater = false;
  try { inWater = isInWater(bot); } catch (e) { inWater = false; }
  const route = furnaceCollectRoute({
    dist: _furnaceDist(), dy: p0 ? p0.y - j.pos.y : 0, inWater,
    workDist: (_workSet && _workPos) ? Math.hypot(_workPos.x - j.pos.x, _workPos.z - j.pos.z) : null,
  });
  if (route === 'later') return false;                        // trop loin, pas de raccourci : il attendra
  if (route === 'warp_work') {
    emit({ type: 'smelt_while_mining', phase: 'warp_work', why });
    try { homewarp.goWork(bot); } catch (e) {}
    await awaitWarp({ maxMs: 12000 });
    await sleep(1200);                                        // chunks d'arrivée
  }
  if ((_furnaceDist() || 0) > 3.5) {
    try {
      await withTimeout(bot.pathfinder.goto(new pfGoals.GoalNear(j.pos.x, j.pos.y, j.pos.z, 2)), 40000,
        () => { try { stopMotion(); } catch (e) {} });
    } catch (e) { /* on essaie quand même d'ouvrir */ }
  }
  const fb = bot.blockAt(vec3Lib(j.pos.x, j.pos.y, j.pos.z));
  // Chunk pas chargé (TP, mort, loin) : le four n'est PAS perdu — on ne peut juste pas le voir d'ici.
  if (!fb) { deferFurnaceJob('unloaded', why); return false; }
  if (fb.name !== 'furnace') {
    setFurnaceJob(null);
    emit({ type: 'smelt_while_mining', phase: 'lost', why });
    return false;
  }
  if ((_furnaceDist() || 0) > 5) { deferFurnaceJob('out_of_reach', why); return false; }   // ouvrir d'ici échouerait
  const before = ((bot.inventory && bot.inventory.items()) || []).reduce((s, i) => s + (i.name === 'iron_ingot' ? i.count : 0), 0);
  let f = null;
  try { f = await bot.openFurnace(fb); } catch (e) { f = null; }
  if (!f) { deferFurnaceJob('open_failed', why); return false; }   // job gardé : on repassera
  try { if (f.outputItem && f.outputItem()) await f.takeOutput(); } catch (e) {}
  try { if (f.inputItem && f.inputItem()) await f.takeInput(); } catch (e) {}
  try { if (f.fuelItem && f.fuelItem()) await f.takeFuel(); } catch (e) {}
  try { f.close(); } catch (e) {}
  setFurnaceJob(null);
  await sleep(250);
  await reclaimBlock(j.pos, 'furnace');
  const after = ((bot.inventory && bot.inventory.items()) || []).reduce((s, i) => s + (i.name === 'iron_ingot' ? i.count : 0), 0);
  emit({ type: 'smelt_while_mining', phase: 'collect', why, ingots: after - before, waited_s: Math.round((Date.now() - j.at) / 1000) });
  return true;
}

/** Hook du branch-mine : lancer / ramasser / abandonner le four de mine. Jamais de throw. */
async function furnaceJobTick() {
  if (_furnaceJobBusy) return;
  _furnaceJobBusy = true;
  try {
    const p = bot.entity && bot.entity.position;
    if (!p || !bot.inventory) return;
    const items = bot.inventory.items().map((i) => ({ name: i.name, count: i.count }));
    const cnt = (n) => items.reduce((s, i) => s + (i.name === n ? i.count : 0), 0);
    const plan = furnaceJobPlan({ job: _furnaceJob, raw: cnt('raw_iron'), hasFurnace: cnt('furnace') > 0,
      items, now: Date.now(), dist: _furnaceDist() });
    if (plan.act === 'start') {
      let wet = false;
      try { wet = isInWater(bot); } catch (e) { wet = false; }
      if (p.y > 30 || wet || !(bot.entity && bot.entity.onGround)) return;   // au fond de la mine, au sec
      await startFurnaceJob(plan.count);
    } else if (plan.act === 'collect') {
      await collectFurnaceJob('ready');
    } else if (plan.act === 'abandon') {
      emit({ type: 'smelt_while_mining', phase: 'abandon', why: plan.why, count: _furnaceJob && _furnaceJob.count });
      setFurnaceJob(null);
    }
  } catch (e) { /* best-effort */ }
  finally { _furnaceJobBusy = false; }
}

/** Ramasser le four de mine maintenant (attente bornée de la fin de cuisson). Jamais de throw. */
async function finishFurnaceJob(why, maxWaitMs = 90000) {
  const j = _furnaceJob;
  if (!j || _furnaceJobBusy) return;
  _furnaceJobBusy = true;
  try {
    // Loin, on ne l'OUBLIE plus (22/10 : 44 minerais perdus ainsi par NethBot1) — collectFurnaceJob choisit
    // la route (/home work à côté du four) ou attend le retour. On n'attend la cuisson que près du four :
    // loin, il ne cuit pas (hors simulation) et l'on reprend aussi l'entrée.
    const d = _furnaceDist();
    const near = d == null || d <= SMELT_JOB_COLLECT_DIST;
    const wait = near ? Math.min(maxWaitMs, (j.readyAt || 0) - Date.now()) : 0;
    if (wait > 0) await sleep(wait);
    await collectFurnaceJob(why);
  } catch (e) { /* best-effort */ }
  finally { _furnaceJobBusy = false; }
}

// ─── DISCIPLINE DE NUIT — LE PLANNER (19/10 soir) ────────────────────────────────────────────────
// AVANT chaque skill : nu + nuit connue → le planner NE LANCE RIEN (caution.nightPlannerStep). En
// surface il s'abrite — ou rejoint l'abri qu'un timer vient d'ouvrir (squad/regroupement), au lieu de
// repartir couper du bois à côté (NethBot3) — et s'y remet 20 s après une interruption (fuite,
// sauvetage, combat, abri raté au respawn : NethBot1). Sous terre il mine (la nuit n'y change rien),
// sauf les buts qui le ramèneraient dehors (bois, chasse, pioche, livraison). Il rend la main à l'aube
// ou dès qu'il porte 2 pièces. Réflexes de fuite, sauvetage d'eau et watchdog PV tournent à part :
// rien de vital n'est retenu ici. Hors abri et hors de l'eau, la survie du kit tourne comme avant
// chaque skill (riposte, fuite, manger) ; dans l'abri, rien ne doit l'en faire sortir.
// → { held: le planner a été retenu, cancelled }
async function holdForNight(g) {
  const t0 = Date.now();
  let held = false;
  let reason = null;
  try {
    for (;;) {
      if (taskToken.cancelled || migrationOwnsBot()) { reason = 'cancelled'; return { held, cancelled: true }; }
      if (!nightLockdownNow()) {
        reason = (bot.time && bot.time.timeOfDay != null && isNight(bot)) ? 'armored' : 'dawn';
        break;
      }
      if (Date.now() - t0 > NIGHT_HOLD_MAX_MS) { reason = 'max'; break; }
      const p = bot.entity && bot.entity.position;
      let inWater = false;
      try { inWater = isInWater(bot); } catch (e) { inWater = false; }
      const step = nightPlannerStep({
        lockdown: true, y: p ? p.y : null, skill: g && g.skill, underground: nightUndergroundNow(),
        shelterBusy: !!_shelterInFlight, inWater, sinceShelterMs: Date.now() - lastShelterT,
      });
      if (step === 'run') { reason = 'underground'; break; }
      if (!held) {
        held = true;
        _nightHold++;
        emit({ type: 'night_hold', goal: g && g.name, skill: g && g.skill, y: p ? Math.round(p.y) : null, step });
      }
      // NUIT AU TRAVAIL (21/10) : but de surface sous terre → rendre la main au planner, qui le DIFFÈRE
      // (nightSkipGoal) et passe au suivant faisable. Une fois par but et par 30 s : si tout le reste est
      // différé aussi, le planner revient ici et on attend l'aube sur place, comme avant (pas de boucle chaude).
      if (step === 'wait' && g && nightDeferGoal({ lockdown: true, underground: nightUndergroundNow(), skill: g.skill })
          && Date.now() - (_nightDeferReturnAt[g.name] || 0) > NIGHT_DEFER_RETURN_MS) {
        _nightDeferReturnAt[g.name] = Date.now();
        reason = 'defer';
        break;
      }
      if (step === 'shelter') {
        // NUIT AU TRAVAIL (21/10) : avec une pioche, descendre en escalier, sceller et MINER plutôt
        // qu'attendre l'aube dans un trou. Réussi → le tour suivant voit le bot « sous terre » ('run').
        if (await tryNightWork()) continue;
        // false = refusé à la marge (écart à la ms près, sous-sol tout juste atteint) : on re-décide.
        if (!(await maybeNightShelter(true, { force: true }))) await sleep(NIGHT_HOLD_POLL_MS);
        continue;
      }
      if (!_shelterInFlight && !inWater) await settleSurvivalKit();
      await sleep(NIGHT_HOLD_POLL_MS);
    }
  } finally {
    if (held) {
      _nightHold = Math.max(0, _nightHold - 1);
      emit({ type: 'night_hold_end', goal: g && g.name, reason, held_s: Math.round((Date.now() - t0) / 1000) });
    }
  }
  return { held, cancelled: false };
}

async function runSkillWithTelemetry(g) {
  // Vie du lancement (cf. _lifeGen) : les « taskToken.cancelled » ci-dessous lisent le GLOBAL, qui après un
  // respawn porte le jeton vivant du runner suivant — la génération, elle, ne ment pas.
  const _gen = _lifeGen;
  if (migrationOwnsBot()) return { ok: false, reason: 'cancelled' };
  await foodTripYield();                                      // expédition vers le gibier en cours : on n'y vole pas le pathfinder
  await settleSurvivalKit();                                  // survie d'abord, le craft ensuite
  if (taskToken.cancelled || lifeStale(_gen) || migrationOwnsBot()) return { ok: false, reason: 'cancelled' };
  // DISCIPLINE DE NUIT : nu + nuit connue → l'abri AU LIEU du skill (cf. holdForNight). Retenu, on rend
  // la main SANS lancer le skill : à l'aube le planner re-dérive son but sur l'état du matin. Pas de
  // `ok` dans ce retour → ni échec (failStreak) ni succès : une nuit n'est pas un verdict sur le but.
  const _night = await holdForNight(g);
  if (_night.cancelled || taskToken.cancelled || lifeStale(_gen) || migrationOwnsBot()) return { ok: false, reason: 'cancelled' };
  if (_night.held) return { held: 'night' };
  // NUIT + (mort récente OU PV bas) pendant le kit → ABRI jusqu'à l'aube (vécu Surv4 : 7 morts
  // nocturnes en boucle ; un trou couvert coûte 2 blocs et sauve le kit).
  try { _preShelterGoal = g; } catch (e) { /* bacs à sable de test */ }   // lu par maybeNightShelter (nuit du mineur diamant)
  if (await maybeNightShelter() && (taskToken.cancelled || lifeStale(_gen))) return { ok: false, reason: 'cancelled' };
  if (migrationOwnsBot()) return { ok: false, reason: 'cancelled' };   // l'abri peut durer : re-vérifier
  // BÛCHERON D'ÉQUIPE : un but bois → demander au bûcheron et attendre AU CHANTIER (≤ 4 min) au lieu
  // de remonter explorer une zone rasée. null = comportement historique (le skill tourne ci-dessous).
  // ENTRAIDE BOIS SANS BÛCHERON (23/10) : entre deux buts, un coéquipier qui a du stock dépanne la
  // demande la plus ancienne (/tpa + toss + retour au chantier), dans le contexte du planner — aucun
  // conflit de pathfinder avec un but en cours.
  await peerWoodGiftStep(_gen);
  if (taskToken.cancelled || lifeStale(_gen) || migrationOwnsBot()) return { ok: false, reason: 'cancelled' };
  const _wood = (await woodWaitStep(g)) || (await woodGoalRequestStep(g));
  if (_wood) return _wood;
  // Personne pour livrer et pas de bois ici : /tpa vers le coéquipier le plus proche qui est dans une
  // zone boisée connue, puis le skill coupe LÀ-BAS.
  await woodMateTpaStep(g, _gen);
  if (taskToken.cancelled || lifeStale(_gen) || migrationOwnsBot()) return { ok: false, reason: 'cancelled' };
  // Four de mine en cours et but qui n'est pas du minage : ramasser les lingots d'abord (21/10).
  if (_furnaceJob && !FURNACE_JOB_KEEP_SKILLS.has(g.skill)) { try { await finishFurnaceJob('goal'); } catch (e) {} }
  if (taskToken.cancelled || lifeStale(_gen) || migrationOwnsBot()) return { ok: false, reason: 'cancelled' };
  // VIANDE CRUE en poche (≥ 3) entre deux buts : on la cuit comme un joueur (23/10, cookMeat.js). Une
  // cuisson lancée par le filet (timer) se termine d'abord : un four ouvert ne survit pas à un départ.
  await cookBetweenGoals(g);
  if (taskToken.cancelled || lifeStale(_gen) || migrationOwnsBot()) return { ok: false, reason: 'cancelled' };
  const _t0 = Date.now();
  // `_skillInFlight` encadre l'exécution RÉELLE du skill, à l'intérieur du withTimeout : un skill
  // expiré continue de tourner en fond (withTimeout ne l'annule pas), et migrateZone doit attendre
  // qu'il ait vraiment rendu la main avant de marcher.
  const run = (async () => {
    _skillInFlight++;
    const _cg = { name: g.name, skill: g.skill, at: _t0 };
    _curGoal = _cg;                                           // lu par trySquad (squadHold)
    try { return await runGoalSkill(g, _gen); } finally { _skillInFlight--; if (_curGoal === _cg) _curGoal = null; }
  })();
  const r = await withTimeout(run, timeoutFor(g.skill), () => { try { stopMotion(); } catch (e) {} });
  // Temps de MINAGE effectif : c'est le dénominateur du rendement de la zone (verdict 'exhausted').
  if (MINING_GOALS.has(g.name)) _zoneMiningMs += (Date.now() - _t0);
  // Le bot est mort pendant le skill : son résultat appartient à une vie finie (ni goal_failed, ni verdict
  // de zone, ni suite du but). Le planner de cette vie, jeton annulé par endLifeTasks, rend la main.
  if (lifeStale(_gen)) return (r && r.stale) ? { ok: false, reason: 'cancelled', stale: true } : dropStaleTask(g.skill, _gen);
  // PV CRITIQUES (22/10) : un craft refusé (`low_hp_skip`, ou PRÉFIXÉ par un skill qui enchaîne les crafts,
  // `gift_batch_craft:low_hp_skip` — 24/10, lowhp.isLowHpSkip) n'est PAS un échec du but — ni goal_failed,
  // ni noteZoneFailure, ni demande de bois. On RÉCUPÈRE (manger / se murer / sortie nourriture /
  // attendre, ≤ 60 s) puis on rend `wait:true` : le planner ne le compte ni dans failStreak ni dans le
  // fingerprint, et re-dérive le but au tour suivant (cf. planner.js MAX_WAIT_TURNS).
  if (r && r.ok === false && isLowHpSkip(r.reason)) {
    if (taskToken.cancelled || lifeStale(_gen) || migrationOwnsBot()) return { ok: false, reason: 'cancelled' };
    const rec = await recoverLowHp(g.name, { targetHp: lowHpTargetFor(r.reason) || undefined });
    if (taskToken.cancelled || lifeStale(_gen) || migrationOwnsBot()) return { ok: false, reason: 'cancelled' };
    return { ok: false, reason: 'recovering', wait: true, outcome: rec.outcome };
  }
  if (!r || r.ok === false) {
    emit(Object.assign({ type: 'goal_failed', name: g.name, reason: (r && r.reason) || 'unknown' }, (r && r.err) ? { err: String(r.err).slice(0, 80) } : {}));
    noteZoneFailure(g.name, r && r.reason);
    noteLumberjackStockFail(g.name, r && r.reason);      // bûcheron : 2 échecs en 10 min → forêt connue
    // Manque de bois pour un craft (bâtons/planches/table) → demande au bûcheron + attente (20/10).
    if (!taskToken.cancelled && !migrationOwnsBot()) {
      const _ww = await woodRequestOnShortage(g, r && r.reason);
      if (_ww) return _ww;
    }
  }
  return r;
}

// Boucle cartographe (objectif `mapper`) : mini-kit pierre via planner → upgrade best-effort →
// cartographie CONTINUE (ne « finit » jamais — seule l'annulation/stop l'arrête).
async function startMapper() {
  // ── UNE SEULE boucle de cartographie vivante par bot (mesuré le 17/08 : `mapper_started` = 23,
  // 15 et 9 dans UN SEUL process pour MapBot1/3/2). CHAQUE respawn ré-entre ici (onSpawn →
  // startAutonomous → startMapper) et les instances s'EMPILENT : `taskCtl.begin()` n'annule que le
  // token de la génération précédente, or `taskToken` est une variable GLOBALE lue TARD (au moment
  // de l'appel) — une vieille instance encore dans sa phase kit repart donc avec le token NEUF et
  // survit. Résultat vu en clair dans les logs : 4 compteurs `failStreak` indépendants qui avancent
  // en parallèle (1222, 733, 330, 975 → 1223, 734, 331, 976 …), N boucles qui se disputent le
  // pathfinder (20 327 `mapper_turn` sur un seul run).
  // Jeton de GÉNÉRATION : une nouvelle entrée périme immédiatement toutes les précédentes, sans
  // jamais laisser le bot sans mappeur (à l'inverse d'un « refuse si déjà actif », qui figerait la
  // flotte si l'ancienne boucle traînait à sortir). `cancelled` est un GETTER : il est ré-évalué à
  // chaque tour de boucle, et le setter reste dispo pour un consommateur qui voudrait l'armer.
  const gen = (bot._mapperGen = (bot._mapperGen || 0) + 1);
  let mapperCancelled = false;
  const mapperToken = {
    get cancelled() { return mapperCancelled || taskToken.cancelled || bot._mapperGen !== gen; },
    set cancelled(v) { mapperCancelled = !!v; },
  };
  installPickupEquip();    // une pièce reçue d'un coéquipier est PORTÉE dans la foulée (cf. plus haut)
  // ── PRUDENCE TANT QU'IL EST NU (18/08) : un cartographe SANS armure ne voyage plus de nuit.
  // Verdict PUR/testé (caution.mapperCaution) : < 2 pièces portées + nuit → il se terre et attend
  // l'aube ; le matin, ou dès qu'il porte 2 pièces, il repart. L'abri réutilise l'existant
  // (maybeNightShelter → shelterUntilDawn), mais en FORÇANT : le cooldown « 1 abri / 10 min » vit
  // dans le process et survit à la mort, donc un mappeur tué pendant son abri repartait marcher au
  // respawn, en pleine nuit, nu — la boucle exacte des 92 morts de MapBot1.
  // L'épisode est tracé UNE fois (pas une par jambe) : le drapeau vit sur `bot` pour survivre aux
  // ré-entrées de startMapper (chaque respawn en ouvre une nouvelle).
  const mapperNightGuard = async () => {
    let worn = 0;
    try { worn = _wornArmor().size; } catch (e) { /* inventaire pas encore livré → 0 = prudent */ }
    // `bot.time` peut ne pas être livré juste après un spawn/une reconnexion — c'est-à-dire
    // exactement quand le bot est nu : on passe alors `null` (inconnu) et mapperCaution retombe
    // honnêtement sur la présence d'hostiles, au lieu de conclure « il fait jour ».
    const nightKnown = !!(bot && bot.time && bot.time.timeOfDay != null);
    let hostilesNear = false;
    try {
      const h = bot.nearestEntity((x) => x && x.kind === 'Hostile mobs');
      hostilesNear = !!(h && bot.entity && h.position.distanceTo(bot.entity.position) <= 8);
    } catch (e) { /* best-effort */ }
    const decision = mapperCaution({ worn, isNight: nightKnown ? isNight(bot) : null, hostilesNear });
    if (decision === 'shelter') {
      if (!bot._mapperCautionEpisode) { bot._mapperCautionEpisode = true; emit({ type: 'mapper_caution', worn }); }
      // DANS L'EAU on ne force rien : on ne creuse pas de trou au milieu d'un océan, et le
      // sauvetage d'eau (escapeWater / watchdog) doit garder la main → chemin historique.
      let inWater = false;
      try { inWater = isInWater(bot); } catch (e) { /* best-effort */ }
      return maybeNightShelter(true, inWater ? {} : { force: true });
    }
    bot._mapperCautionEpisode = false;   // aube OU 2+ pièces portées → l'épisode est clos
    return maybeNightShelter(true);
  };
  await survivalKitUp();   // /kit + équipement (si configuré) — AVANT le mini-kit pierre
  if (mapperToken.cancelled) return;
  const kitChain = chainFor('mapper');
  const runKit = () => runPlanner(bot, {
    chain: kitChain,
    runSkill: (g) => runSkillWithTelemetry(g),
    ctxExtra,
    onStep: (g) => { _lastGoalAt = Date.now(); emit({ type: 'goal', name: g.name }); },
  }, mapperToken);
  const res = await runKit();
  if (mapperToken.cancelled) return;
  if (res.stalled) emit({ type: 'mapper_kit_stalled', goal: res.goal }); // on cartographie quand même (dégradé)
  else await tryKitUpgrade();
  if (mapperToken.cancelled) return;
  // filet survie : buffer de terre pour sceller l'abri + bouffe pour régén PV (best-effort, bornés)
  try { if (needDirtBuffer(bot.inventory.items(), 8)) await gather(bot, { name: ['dirt', 'grass_block', 'gravel'], count: 8, maxDistance: 48 }, mapperToken); } catch (e) {}
  // BORNÉ (19/10 : ce démarrage — qui se rejoue à CHAQUE respawn — pouvait durer des minutes entre
  // 3 vagues de chasse et la pêche) : ≤ 70 s au pire, immédiat s'il y a déjà de quoi manger ou aucune
  // proie en vue — sauf à vraie faim (< 6 points) de jour : l'expédition vers le gibier ajoute au plus
  // FOOD_TRIP_MS (75 s) de marche, qui a son propre plafond hors du budget de 60 s.
  // DISCIPLINE DE NUIT (19/10 soir) : cartographe nu de nuit → pas de chasse (mapperNightGuard le terre
  // juste après) ; la faim attendra l'aube, ou la chair de zombie ramassée après un combat.
  if (nightLockdownNow()) nightGateNote('mapper_start_hunt');
  else { try { await withTimeout(huntCookGoal(6), HUNT_COOK_TIMEOUT_MS + FOOD_TRIP_MS + FOOD_TRIP_LONG_EXTRA_MS + COOK_LOT_HARD_MS, () => { try { stopMotion(); } catch (e) {} }); } catch (e) {} }
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
    // fix fable1 bis : se terrer AVANT chaque départ de nuit — et depuis le 18/08, se terrer
    // COÛTE QUE COÛTE tant que le cartographe est nu (mapperNightGuard, verdict pur ci-dessus).
    // Le hook est appelé en TÊTE de boucle : quand il s'abrite, aucune jambe ne part.
    nightShelter: () => mapperNightGuard(),
    hold: () => endermanHoldWait(),   // muré face à un enderman en colère (21/10) : la boucle attend

    // kit incomplet (stall terrain au départ) → re-tenté discrètement toutes les ~10 arrivées :
    // le terrain a changé (le bot a bougé), la pose de table a souvent une 2e chance ailleurs.
    onPeriodic: async () => {
      const ctx = Object.assign({ inv: buildCtxInv(bot) }, ctxExtra());
      if (firstUnmet(kitChain, ctx)) { emit({ type: 'mapper_kit_retry' }); await runKit(); }
      try { await armorUp(0); } catch (e) { /* best-effort */ }   // hole A : le mappeur s'arme aussi
      try { if (needDirtBuffer(bot.inventory.items(), 4)) await gather(bot, { name: ['dirt', 'grass_block', 'gravel'], count: 8, maxDistance: 48 }, mapperToken); } catch (e) {}
      try { await mapperNightGuard(); } catch (e) {}              // hole §1.4 : abri nocturne en roaming
    },
    // CHASSE OPPORTUNISTE (vécu Surv1 : le retry périodique coïncide rarement avec des proies à
    // portée → stock jamais constitué) : à chaque arrivée, si la réserve est basse ET qu'une proie
    // passe à ≤24 blocs → on la tue MAINTENANT (cru en poche : il se mange, la cuisson se fait au retry
    // du kit). Réserve comptée en POINTS DE FAIM (19/10 : cru et chair putréfiée comptent), chasse ≤ 45 s
    // dont le jeton s'arrête DÈS que le seuil est atteint.
    onArrive: async () => {
      // Fix fable1 : abri nocturne PROACTIF à CHAQUE arrivée (onPeriodic = 1/10 arrivées, trop rare —
      // les mappeurs se faisaient sniper en surface la nuit avant le prochain check). No-op le jour.
      if (await mapperNightGuard()) return; // aube : on reprend au prochain cycle (pas de chasse de nuit)
      if (foodPoints(buildCtxInv(bot)) >= STOCK_POINTS) return;
      if (!nearestPassive(bot, 24)) return;
      const ctl = boundedToken(mapperToken, () => foodPoints(buildCtxInv(bot)) >= STOCK_POINTS);
      const r = await withTimeout(huntPassive(bot, { count: 2, maxDistance: 24 }, ctl.token),
        HUNT_WAVE_MS, () => { ctl.cancel(); try { stopMotion(); } catch (e) {} });
      ctl.cancel();                                         // rien ne court en fond après la vague
      if (r && r.kills) emit({ type: 'opportunistic_hunt', kills: r.kills });
    },
    // chaque jambe bornée (anti-freeze pathfinder, cf. withTimeout) ; timeout → virage + jambe suivante.
    // 45s : une jambe fait 8-64 blocs à pied — si ce n'est pas atteint en 45s, c'est inatteignable
    // (vu live MapT7B : 120s × jambes ratées en jungle dense = mapper figé de longues minutes).
    goto: async (wp) => {
      // stop-pour-répondre : pas de nouvelle jambe tant que le bot « tape » sa réponse.
      while (Date.now() < _convoPauseUntil) await sleep(250);
      // MÊME RÈGLE que le goto par défaut de mapper.js : y ABSENT = altitude libre → but XZ (le y des
      // jambes n'était que l'altitude COURANTE du bot → NoPath instantané sur terrain vallonné, mesuré
      // sur world_ax5) ; y PRÉSENT = altitude réelle (remontée en surface) → but 3D.
      const goal = wp.y == null
        ? new pfGoals.GoalNearXZ(wp.x, wp.z, 8)
        : new pfGoals.GoalNear(wp.x, wp.y, wp.z, 8);
      const r = await withTimeout(
        bot.pathfinder.goto(goal),
        45000, () => { try { stopMotion(); } catch (e) {} });
      if (r && r.ok === false) throw new Error(r.reason || 'goto_failed');
    },
  }, mapperToken);
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

// JETER DERRIÈRE SOI (22/10, chrono world_oct22). `toss` lance l'objet dans le REGARD du bot ; au fond
// de la mine, le regard est sur le front de taille → le junk tombait sur les cases que le bot allait
// fouler au pas suivant, et il le RAMASSAIT : NethBot3 = 35 `branch_cleanup` en 64 min, dont 11 d'affilée
// en une minute avec exactement le même nombre de cases libres après chaque tri (22) — il retriait
// sans fin la même pile. Un joueur jette son cobble derrière lui. On se retourne, on jette, on remet
// le regard (le coup de pioche suivant le refixe de toute façon).
async function tossJunkBehind(b) {
  const e = b && b.entity;
  const yaw = (e && Number.isFinite(e.yaw)) ? e.yaw : 0;
  const pitch = (e && Number.isFinite(e.pitch)) ? e.pitch : 0;
  let turned = false;
  if (typeof b.look === 'function') {
    try { await b.look(yaw + Math.PI, 0, true); turned = true; } catch (err) { /* on jette quand même */ }
  }
  try { await tossJunk(b); }
  finally {
    if (turned) { try { await b.look(yaw, pitch, true); } catch (err) { /* best-effort */ } }
  }
}

// POCHE TOUJOURS RESPIRABLE (25/10) : 0-2 cases libres, 110-180 cobble + 60-130 deepslate chez les 3 mineurs
// en phase diamant → la viande des chasses (`kills:4, after:0`), la ficelle de la canne et des diamants
// (`drop_lost`) restaient par terre. Toutes les 20 s, sous 4 cases libres, on jette du déchet (pickJunkToToss :
// garde 32 cobble et 64 de remblai) jusqu'à 6 cases libres. Garde de NIVEAU MODULE (piège #56).
let _roomBusy = false;
setInterval(async () => {
  if (_roomBusy || !bot || !bot.inventory || !bot.entity || typeof bot.inventory.emptySlotCount !== 'function') return;
  if (bot.inventory.emptySlotCount() >= 4 || bot.targetDigBlock) return;
  _roomBusy = true;
  const tossed = [];
  try {
    for (let i = 0; i < 6 && bot.inventory.emptySlotCount() < 6; i++) {
      const junk = pickJunkToToss(bot.inventory.items(), { exclude: [] });
      if (!junk) break;
      await bot.tossStack(junk);
      tossed.push(junk.name + ':' + junk.count);
    }
  } catch (e) { /* best-effort */ }
  finally { _roomBusy = false; }
  if (tossed.length) emit({ type: 'room_freed', tossed, empty: bot.inventory.emptySlotCount() });
}, 20000);

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

// Rend true si le fichier est écrit, false sinon. Les écrivains historiques ignorent ce retour
// (best-effort) ; l'historique de morts, lui, DOIT savoir : sa raison d'être est de survivre au process.
function saveBaseState(st) {
  _baseState = st;
  try {
    const tmp = baseFile + '.tmp';                // write+rename = atomique (cf. saveBanked)
    fs.writeFileSync(tmp, JSON.stringify(st));
    fs.renameSync(tmp, baseFile);
    return true;
  } catch (e) {
    /* best-effort : sans le fichier, le bot re-marchera, il ne casse rien */
    return false;
  }
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

// ─── FER EN GROTTE (Massii 20/10) ─────────────────────────────────────────────────────────────
// « Aller plus vite vers l'armure de fer sans tricher, comme un humain » : on va chercher le fer
// VISIBLE sur les parois des grottes (minerais `exposed` notés par les cartographes — avec
// l'anti-xray ce sont les seuls que le client reçoit) au lieu du strip-mine aveugle à Y16.
// Choix de la grappe : caveIron.js (PUR). Exécution : skills/caveIron.js. Ici, la glue.
// ⚠️ NIVEAU MODULE (piège #56) : lus par ctxExtra à chaque pas du planner.
// Les essais (ratés ou terminés) sont PERSISTÉS dans le mémo base (`caveFails`, 30 min) : le
// self-healing relance le bot après chaque mort, un Set de process re-ciblerait la même grotte morte.
const IRON_CAVE_CACHE_MS = 30000;    // ctxExtra tourne à chaque pas : on ne relit pas 8 Mo de carte à chaque fois
let _ironCaveCache = { at: 0, cave: null };
let _caveCooldownEmitted = 0;        // `until` déjà annoncé : un event par entrée en cooldown
let _caveDisabledEmitted = 0;        // idem pour la désactivation 2 h (escalade, 21/10)
let _caveTorchAt = 0;
let _caveTorchPos = null;
// BUDGET DE GROTTES + PORTÉE (23/10, cf. caveIron.caveBudget* / caveInReach). Niveau MODULE (piège #56) :
// lus par ironCaveCtx à chaque pas du planner. L'état du budget vit dans le mémo base (`caveBudget`).
let _caveLastRawIron = -1;           // -1 = pas encore lu : la 1re lecture calibre, elle ne « gagne » rien
let _caveTooFarEmitAt = 0;

function _caveRawIron() {
  return ((bot && bot.inventory && bot.inventory.items()) || [])
    .reduce((s, i) => s + (i.name === 'raw_iron' ? i.count : 0), 0);
}

/**
 * Budget de grottes : du fer gagné depuis la dernière lecture (n'importe quelle source) remet l'horloge
 * « sans fer » à zéro ; coupure active ou budget épuisé → true (pas de grotte, branch-mine Y16).
 * Persiste dans le mémo base en FUSIONNANT (saveBaseState n'en fait rien lui-même).
 */
function _caveBudgetBlocks(now) {
  const st = loadBaseState() || {};
  let b = st.caveBudget;
  let dirty = false;
  const raw = _caveRawIron();
  if (_caveLastRawIron >= 0 && raw > _caveLastRawIron) { b = caveIronPick.caveBudgetNoteIron(b, now); dirty = true; }
  _caveLastRawIron = raw;
  let blocked = !!caveIronPick.caveBudgetUntil(b, now);
  if (!blocked) {
    const v = caveIronPick.caveBudgetCheck(b, now);
    if (v) {
      b = caveIronPick.caveBudgetTrip(b, v);
      dirty = true;
      blocked = true;
      emit({ type: 'cave_budget_exhausted', fails: v.fails, minutesNoIron: v.minutesNoIron, until: v.until });
    }
  }
  if (dirty) saveBaseState(Object.assign({}, loadBaseState() || {}, { caveBudget: b }));
  return blocked;
}

/** Fin d'un essai `iron_cave` → budget (mémo base, fusion). Jamais de throw. */
function _caveBudgetRecord(r) {
  try {
    if (!r) return;
    const now = Date.now();
    const st = loadBaseState() || {};
    const why = r.ok ? 'done' : String(r.reason || 'failed');
    const iron = Number(r.iron_got != null ? r.iron_got : r.mined) || 0;
    const b = caveIronPick.caveBudgetRecord(st.caveBudget, { why, iron, took_s: r.took_s }, now);
    saveBaseState(Object.assign({}, st, { caveBudget: b }));
    _caveLastRawIron = _caveRawIron();         // ce fer-là est déjà compté par l'essai
  } catch (e) { /* best-effort */ }
}
// INTERRUPTIONS (22/10, chrono world_oct22) : sur 9 `cave_failed unreachable` de NethBot2/3, la plupart
// n'étaient PAS des grappes inatteignables mais des trajets coupés — /tpa de regroupement en route,
// fuite d'un squelette, exploration fantôme qui changeait le but du pathfinder (« The goal was changed »,
// échec en 0 s à 6 blocs de la grappe). Chaque faux `unreachable` nourrissait le disjoncteur, qui a
// coupé `iron_cave` 2 h à NethBot3 à la 22e minute — pendant que NethBot1 vidait des grappes à 20 blocs
// de lui. Un trajet coupé rend `interrupted` : ce n'est pas un verdict sur la grotte (pas de disjoncteur),
// et la grappe n'est mise de côté qu'à la 2e coupure en 10 min (sinon le planner la reprendrait en boucle).
let _tpCount = 0;                    // téléportations vues (onTeleport) — lu pendant le trajet (niveau module, piège #56)
let _diamondHuntBusy = false;        // chasse au diamant de grotte en cours — lu par le timer du ramassage (oregrab.grabScope)
let _caveTripBusy = false;           // trajet/minage de grotte en cours — lu par trySquad / tryRegroup (timers)
let _caveInterrupts = {};            // key de grappe → [instants des coupures]
const CAVE_INTERRUPT_WINDOW_MS = 10 * 60 * 1000;
const CAVE_PULLED_AWAY = 8;          // le bot finit ≥ 8 blocs PLUS LOIN qu'au départ = on l'a emmené ailleurs
// Chaînes armure + chaînes d'équipe (mapper_armor, iron_help — 24/10) : cf. caveIron.IRON_CAVE_OBJECTIVES.
const IRON_CAVE_OBJECTIVES = caveIronPick.IRON_CAVE_OBJECTIVES;

function _caveInvTier() {
  const t = { stone_pickaxe: 2, iron_pickaxe: 3, diamond_pickaxe: 4, netherite_pickaxe: 5 };
  let best = 0;
  for (const it of ((bot && bot.inventory && bot.inventory.items()) || [])) {
    if (t[it.name] && t[it.name] > best) best = t[it.name];
  }
  return best;
}

/**
 * Le fer que le bot VOIT (24/10) : scan ciblé fer des chunks chargés (comme le diamant, 8e161ef9 — le fer
 * d'une grotte à 25 blocs n'entrait pas dans les 40 minerais les plus proches tous types confondus), mis
 * à la forme mémoire. La carte partagée ne connaît que ce que les cartographes ont vu en surface : à -54,
 * c'est la seule source. Jamais de throw.
 */
function _caveLiveIronScan() {
  try {
    const raw = oresScan.scanExposedOres(bot, { maxDistance: caveIronPick.LIVE_IRON_SCAN_DIST,
      count: caveIronPick.LIVE_IRON_SCAN_COUNT, names: [...caveIronPick.IRON_ORES] });
    return caveIronPick.liveIronOres(raw, (p) => oresScan.isWaterAdjacent(bot, p));
  } catch (e) { return []; }
}

/** Entrée `worlds.<w>` de la mémoire partagée pour le monde courant (même résolution de clé que le dry-steer). */
function _caveWorld() {
  const mem = args['world-memory'] ? loadMemory(String(args['world-memory'])) : bot._worldMemory;
  const wk = String(bot._worldKey || 'overworld');
  return (mem && mem.worlds && (mem.worlds[wk] || mem.worlds[wk.replace(/^minecraft:/, '')])) || null;
}

/** Ores de la mémoire partagée pour le monde courant. */
function _caveWorldOres() {
  const w = _caveWorld();
  return (w && Array.isArray(w.ores)) ? w.ores : [];
}

function loadCaveFails(now) {
  const st = loadBaseState() || {};
  return caveIronPick.caveFailsPrune(st.caveFails, now);
}

/** Mémorise un essai de grappe (fusionne dans le mémo base, cf. saveBaseState). */
function noteCaveTried(cave, why) {
  try {
    const st = loadBaseState() || {};
    saveBaseState(Object.assign({}, st, { caveFails: caveIronPick.caveFailsAdd(st.caveFails, cave, why, Date.now()) }));
  } catch (e) { /* best-effort */ }
  _ironCaveCache = { at: 0, cave: null };
}

// PV : pas de grotte blessé (caveIron.caveHpOk). Niveau MODULE : lu par le ctx du planner à chaque pas.
let _caveLowHpEmitAt = 0;
/** La grappe visée par le but `iron_cave`, ou null sous CAVE_MIN_HP (event throttlé ≤ 1 / min). */
function ironCaveForPlanner() {
  const hp = bot && bot.health;
  if (!caveIronPick.caveHpOk(hp)) {
    const now = Date.now();
    if (now - _caveLowHpEmitAt >= 60000 || now < _caveLowHpEmitAt) {
      _caveLowHpEmitAt = now;
      emit({ type: 'cave_skipped_low_hp', hp, food: bot && bot.food });
    }
    return null;
  }
  return ironCaveCtx();
}

/**
 * La grappe de fer exposé à viser, ou null. Chaînes armure + chaînes d'équipe (IRON_CAVE_OBJECTIVES) ;
 * `opts.force` pour un autre objectif (récolte de fer de la chaîne diamant). Pioche pierre+ en poche.
 * Sources (24/10) : la carte partagée ET le fer VU par le bot (_caveLiveIronScan) — la plus rentable.
 */
function ironCaveCtx(opts = {}) {
  const objT = world && world.objective && world.objective.type;
  if (!caveIronPick.ironCaveObjectiveOk(objT, opts)) return null;
  const now = Date.now();
  if (now - _ironCaveCache.at < IRON_CAVE_CACHE_MS) return _ironCaveCache.cave;
  let cave = null;
  try {
    const p = bot && bot.entity && bot.entity.position;
    if (p && _caveInvTier() >= 2) {
      const fails = loadCaveFails(now);
      const until = caveIronPick.caveCooldownUntil(fails, now);
      if (until && until !== _caveCooldownEmitted) {
        _caveCooldownEmitted = until;
        emit({ type: 'cave_cooldown', fails: fails.filter((f) => f.why === 'unreachable').length, until });
      }
      // ESCALADE (21/10) : chaque repos du disjoncteur est PERSISTÉ (mémo base, fusion) ; au 2e en 2 h,
      // iron_cave est coupé 2 h — cf. caveIron.caveBreakerNote/caveDisabledUntil.
      const st = loadBaseState() || {};
      let breaks = Array.isArray(st.caveBreaks) ? st.caveBreaks : [];
      if (until) {
        const next = caveIronPick.caveBreakerNote(breaks, until, now);
        if (JSON.stringify(next) !== JSON.stringify(breaks)) {
          breaks = next;
          saveBaseState(Object.assign({}, st, { caveBreaks: breaks }));
        }
      }
      const off = caveIronPick.caveDisabledUntil(breaks, now);
      if (off) {
        if (off !== _caveDisabledEmitted) {
          _caveDisabledEmitted = off;
          emit({ type: 'cave_disabled', until: off, breaks: breaks.length });
        }
      } else if (!_caveBudgetBlocks(now)) {
        const w = _caveWorld();
        const from = { x: p.x, y: p.y, z: p.z };   // COPIE : bot.entity.position est muté en place
        const ranked = caveIronPick.rankIronCaves((w && Array.isArray(w.ores)) ? w.ores : [], from, {
          now,
          fails,
          isClaimed: (k) => { const c = _teamClaims && _teamClaims.peek(k); return !!(c && c.by !== bot.username); },
          confine: CONFINE || _confineDyn,
          // Entrées de grotte notées par les cartographes (worlds.<w>.caves {x,y,z,at,flooded}) :
          // une grappe à > 24 blocs en vertical n'est visée que si une entrée ouverte mène à elle.
          caves: (w && Array.isArray(w.caves)) ? w.caves : [],
        });
        // PORTÉE (23/10) : ≤ 48 blocs 3D (≤ 64 si ≥ 6 minerais) — au-delà, le branch-mine local paie mieux.
        const pick = caveIronPick.pickReachableCave(ranked, from);
        // FER VU (24/10) : mêmes exclusions (ratées, claimées, confine, noyées) ; à score égal, celle qu'on voit.
        const live = caveIronPick.pickLiveIronCave(_caveLiveIronScan(), from, {
          now, fails,
          isClaimed: (k) => { const c = _teamClaims && _teamClaims.peek(k); return !!(c && c.by !== bot.username); },
          confine: CONFINE || _confineDyn,
        });
        cave = caveIronPick.chooseIronCave(pick.cave ? Object.assign({}, pick.cave, { src: 'map' }) : null, live);
        if (pick.tooFar && (now - _caveTooFarEmitAt >= 60000 || now < _caveTooFarEmitAt)) {
          _caveTooFarEmitAt = now;
          const f = pick.tooFar;
          emit({ type: 'cave_too_far', x: f.x, y: f.y, z: f.z, ores: f.count,
            dist3d: Math.round(Math.hypot(f.x - from.x, f.y - from.y, f.z - from.z)), fallback: !!cave });
        }
      }
    }
  } catch (e) { cave = null; }
  _ironCaveCache = { at: now, cave };
  return cave;
}

async function _caveTorch() {
  try {
    const pT = bot.entity && bot.entity.position;
    if (!pT) return;
    const items = (bot.inventory && bot.inventory.items()) || [];
    const torch = items.find((i) => i.name === 'torch');
    if (!torch) return;
    let light = null;
    try { const b = bot.blockAt(pT.floored()); if (b && typeof b.light === 'number') light = b.light; } catch (e) {}
    if (!shouldPlaceTorch({
      y: pT.y, lightLevel: light, torches: torch.count, now: Date.now(),
      lastAt: _caveTorchAt, pos: { x: pT.x, z: pT.z }, lastPos: _caveTorchPos,
      nearestTorch: nearestTorchDist(bot, { x: pT.x, y: pT.y, z: pT.z }),
    })) return;
    const ref = bot.blockAt(pT.floored().offset(0, -1, 0));
    if (!ref || ref.boundingBox !== 'block') return;
    await bot.equip(torch, 'hand');
    await bot.placeBlock(ref, vec3Lib(0, 1, 0));
    _caveTorchAt = Date.now();
    _caveTorchPos = { x: pT.x, z: pT.z };
    try { sharedTorchRegistry.note({ x: Math.floor(pT.x), y: Math.floor(pT.y), z: Math.floor(pT.z) }); } catch (e) { /* best-effort */ }
    emit({ type: 'torch_placed', from: 'caveIron', y: Math.round(pT.y), light });
  } catch (e) { /* best-effort */ }
}

/**
 * APPROCHE D'UN DIAMANT VISIBLE (24/10, session-601/602 : 70 cibles en 50 min pour +7 diamants, verdicts
 * `cave_unreachable` en 0,5-8 s). Ce que fait un joueur pour un diamant vu à 25 blocs : y aller par
 * l'ouverture, sinon CREUSER jusqu'à lui — en montant comme en descendant. Budget caveApproachBudgetMs
 * (45-90 s selon la distance) :
 *   1. plus bas de > 4 blocs → escalier dirigé (_caveStairTo) ;
 *   2. _caveGotoOre : ouverture (canDig:false) puis en creusant (canDig:true), chacune ≤ la moitié du reste ;
 *   3. toujours pas là et pas coupé → JAMBES de 8 blocs en creusant (_caveLegsTo) : un but unique lointain
 *      rend NoPath dans la roche pleine (A* borné), des jambes courtes non — montée en escalier comprise.
 * Une COUPURE (TP, GoalChanged, PathStopped d'un réflexe, bot emmené plus loin) n'est PAS un verdict
 * (caveTravelVerdict) : { interrupted:true } → caveHunt retente la même grappe après _caveSettle.
 * @returns {Promise<{reached:boolean, interrupted?:boolean, why:string|null}>}
 */
async function diamondCaveGoto(t, tok) {
  const t0 = Date.now();
  const pos = () => bot.entity && bot.entity.position;
  const dist = () => { const p = pos(); return p ? Math.hypot(p.x - t.x, p.y - t.y, p.z - t.z) : null; };
  const near = () => { const d = dist(); return d != null && d <= 6; };
  const d0 = dist();
  const deadline = t0 + caveApproachBudgetMs(d0);
  const left = () => deadline - Date.now();
  const errs = [];
  const tp0 = _tpCount;
  const ok = (why) => ({ reached: true, interrupted: false, why });
  const fail = (why) => {
    const v = caveTravelVerdict({ teleported: _tpCount !== tp0, errs, d0, d1: dist() });
    if (v === 'interrupted') {
      // QUI a coupé (25/10 : 32 `interrupted` en 30 min, coupable inconnu) : la cause lue dans les erreurs
      // du pathfinder, et le dernier appelant de setGoal qui a INTERROMPU un but depuis notre départ.
      const by = (() => { try { return _goalTrace.lastInterrupter(t0); } catch (e) { return null; } })();
      const cause = _tpCount !== tp0 ? 'teleported' : caveInterruptCause(errs, d0, dist());
      return Object.assign({ reached: false, interrupted: true, why: cause }, by ? { by } : {});
    }
    return { reached: false, interrupted: false, why };
  };
  const cut = () => tok.cancelled || _tpCount !== tp0 || caveTravelVerdict({ errs, d0, d1: dist() }) === 'interrupted';
  if (near()) return ok('near');
  try {
    const p0 = pos();
    if (p0 && p0.y - t.y > 4) {
      const st = await _caveStairTo(t, tok);
      if (st && st.teleported) return { reached: false, interrupted: true, why: 'teleported' };
      if (near()) return ok('stair');
    }
    if (tok.cancelled) return { reached: false, interrupted: false, why: 'cancelled' };
    if (left() > 3000 && await _caveGotoOre(t, tok, errs, Math.max(3000, Math.floor(left() / 3)))) return ok('path');
    if (near()) return ok('path');
    if (cut()) return fail('interrupted');
    if (left() > 3000 && await _caveLegsTo(t, tok, errs, deadline)) return ok('legs');
  } catch (e) { errs.push(e); }
  if (near()) return ok('legs');
  if (tok.cancelled) return { reached: false, interrupted: false, why: 'cancelled' };
  const nopath = errs.some((e) => /NoPath|no path/i.test(String((e && e.name) || '') + ' ' + String((e && e.message) || '')));
  return fail(left() <= 3000 ? 'timeout' : (nopath ? 'nopath' : 'no_progress'));
}

/**
 * Jambes de 8 blocs vers le minerai, EN CREUSANT (canDig:true, lavaGuard/bridgeGuard de la nominale
 * hérités par withTempMovements). y RÉEL interpolé (caveLegWaypoint) → GoalNear 3D. Arrêt : arrivé,
 * coupé (TP / but volé), deux jambes sans progrès (< 1,5 bloc), ou échéance. → true si à ≤ 6 blocs.
 */
async function _caveLegsTo(t, tok, errs, deadline) {
  const pos = () => bot.entity && bot.entity.position;
  const dist = () => { const p = pos(); return p ? Math.hypot(p.x - t.x, p.y - t.y, p.z - t.z) : Infinity; };
  const tp0 = _tpCount;
  let stalls = 0;
  emit({ type: 'cave_legs', x: t.x, y: t.y, z: t.z, d: Math.round(dist()) });
  while (!tok.cancelled && _tpCount === tp0 && Date.now() < deadline - 1000) {
    const before = dist();
    if (before <= 6) return true;
    const wp = caveLegWaypoint(pos(), t, 8);
    if (!wp) break;
    const n0 = errs.length;
    const ms = Math.max(1000, Math.min(20000, deadline - Date.now()));
    await withTempMovements(bot, Movements, { canDig: true }, async () => {
      try {
        await withTimeout(Promise.resolve(bot.pathfinder.goto(new pfGoals.GoalNear(wp.x, wp.y, wp.z, wp.last ? 2 : 1)))
          .catch((e) => { errs.push(e); throw e; }), ms, () => { errs.push({ name: 'OwnTimeout' }); try { stopMotion(); } catch (e) {} });
      } catch (e) { /* verdict par la distance */ }
    });
    const fresh = errs.slice(n0);
    if (fresh.some((e) => e && (e.name === 'GoalChanged' || /goal was changed/i.test(String(e.message || ''))))) return false;
    if (dist() > before - 1.5) { if (++stalls >= 2) break; } else stalls = 0;
  }
  return dist() <= 6;
}

/**
 * Attendre que le pathfinder se libère après une COUPURE (fuite, couvert, détour, rush) avant de reposer
 * notre but — sinon on lui vole le pathfinder à notre tour. Borné 12 s. NIVEAU MODULE.
 */
async function _caveSettle(tok, maxMs = 12000) {
  const t0 = Date.now();
  await sleep(500);
  while (!tok.cancelled && Date.now() - t0 < maxMs) {
    let moving = false;
    try { moving = !!(bot.pathfinder && typeof bot.pathfinder.isMoving === 'function' && bot.pathfinder.isMoving()); } catch (e) { moving = false; }
    if (!moving && !_skelRushBusy && !panicInFlight && !_imminentBusy && !_escaping) return true;
    await sleep(250);
  }
  return false;
}

/**
 * Déplacement vers un minerai de grotte : par l'OUVERTURE d'abord (canDig:false, le chemin d'un
 * joueur), en creusant ensuite (canDig:true) si la grotte n'est pas reliée. y RÉEL connu → 3D.
 */
async function _caveGotoOre(t, tok, errs = null, ms = 60000) {
  const note = (e) => { if (errs) errs.push(e); };
  const near = () => {
    const p = bot.entity && bot.entity.position;
    return !!(p && Math.hypot(p.x - (t.x + 0.5), p.y - t.y, p.z - (t.z + 0.5)) <= 4.5);
  };
  if (near()) return true;
  const air = openNeighborOf(t);
  const goal = air ? new pfGoals.GoalNear(air.x, air.y, air.z, 1) : new pfGoals.GoalNear(t.x, t.y, t.z, 2);
  // ⚠️ withTimeout AVALE les rejets (il résout {ok:false}) : sans ce .catch, l'erreur du pathfinder
  // (GoalChanged / PathStopped / NoPath) n'arrivait jamais au verdict (22/10). Notre propre échéance est
  // marquée `OwnTimeout` : le PathStopped qu'elle provoque n'est pas une coupure venue d'ailleurs.
  const go = (g) => withTimeout(Promise.resolve(bot.pathfinder.goto(g)).catch((e) => { note(e); throw e; }), ms,
    () => { note({ name: 'OwnTimeout' }); try { stopMotion(); } catch (e) {} });
  await withTempMovements(bot, Movements, { canDig: false }, async () => {
    try { await go(goal); } catch (e) { /* NoPath → phase 2 */ }
  });
  if (near() || tok.cancelled) return near();
  await withTempMovements(bot, Movements, { canDig: true }, async () => {
    try { await go(goal); } catch (e) { /* inatteignable */ }
  });
  return near();
}

/**
 * CASSE VÉRIFIÉE D'UN DIAMANT DE GROTTE (25/10). Câblage des effets de skills/diamondDig.digVisibleOre :
 * diamondCaveGoto rend « arrivé » à ≤ 6 blocs, mais on ne casse qu'à ≤ 4,5 de l'œil ET en ligne de vue
 * — l'ancien chemin (floodFillVein → collectBlock.collect) refaisait un trajet GoalLookAtBlock avec les
 * Movements du plugin sous un catch muet de 30 s : 30 `empty nothing_mined` en 30 min, diamant intact.
 * NIVEAU MODULE (lit _goalTrace, taskToken capturé par l'appelant).
 * @returns {Promise<{outcome:string, why:string|null, mined:number, broken:boolean}>}
 */
const _DIA_FACES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
function _diamondFaceVisible(t) {
  try {
    const b = bot.blockAt(vec3Lib(t.x, t.y, t.z));
    if (!b) return false;
    try { if (typeof bot.canSeeBlock === 'function' && bot.canSeeBlock(b)) return true; } catch (e) { /* raycast ci-dessous */ }
    // canSeeBlock ne vise que le CENTRE : un rayon qui frôle l'arête d'un bloc voisin le rend aveugle
    // alors qu'une face est bien visible. On essaie le centre de chaque face (ce que fait dig 'raycast').
    const p = bot.entity && bot.entity.position;
    if (!p || !bot.world || typeof bot.world.raycast !== 'function') return false;
    const eye = p.offset(0, 1.62, 0);
    for (const [dx, dy, dz] of _DIA_FACES) {
      const target = vec3Lib(t.x + 0.5 + dx * 0.5, t.y + 0.5 + dy * 0.5, t.z + 0.5 + dz * 0.5);
      const v = target.minus(eye);
      const len = v.norm();
      if (!(len > 0) || len > 5.5) continue;
      const hit = bot.world.raycast(eye, v.scaled(1 / len), len + 0.6);
      if (hit && hit.position && hit.position.x === t.x && hit.position.y === t.y && hit.position.z === t.z) return true;
    }
  } catch (e) { /* inconnu = non visible */ }
  return false;
}
async function _digDiamondAt(t, tok) {
  const at = vec3Lib(t.x, t.y, t.z);
  const stop = () => { try { stopMotion(); } catch (e) {} };
  const diamonds = () => ((bot.inventory && bot.inventory.items()) || []).reduce((s, i) => s + (i.name === 'diamond' ? i.count : 0), 0);
  return digVisibleOre(t, {
    cancelled: () => !!(tok && tok.cancelled),
    blockAt: () => bot.blockAt(at),
    eye: () => { const p = bot.entity && bot.entity.position; return p ? { x: p.x, y: p.y + 1.62, z: p.z } : null; },
    canSee: () => _diamondFaceVisible(t),
    // Se placer d'où la face est à portée ET en vue — NOS Movements (lavaGuard/bridgeGuard), creuser permis.
    approachLook: async () => {
      await withTempMovements(bot, Movements, { canDig: true }, async () => {
        try { await withTimeout(bot.pathfinder.goto(new pfGoals.GoalLookAtBlock(at, bot.world, { reach: 4.3 })), 20000, stop); } catch (e) { /* on relit l'état */ }
      });
    },
    clearLava: async () => {
      let left = bmNeighborsHaveLava(bot, t);
      for (let pass = 0; left && pass < 6; pass++) {
        if (!(await bmWallLava(bot, left.ahead))) break;
        left = bmNeighborsHaveLava(bot, t);
      }
      if (left) { try { emit({ type: 'lava_avoided', where: 'diamond_cave', x: t.x, y: t.y, z: t.z }); } catch (e) {} }
      return !left;
    },
    equipPick: async (block) => {
      const tool = bestToolFor(bot, block);
      if (tool && !(bot.heldItem && bot.heldItem.name === tool.name)) { try { await bot.equip(tool, 'hand'); } catch (e) { /* le verdict lit la main */ } }
      return (bot.heldItem && bot.heldItem.name) || null;
    },
    dig: async (block) => {
      let err = null;
      try { stopMotion(); } catch (e) {}
      await withTimeout(Promise.resolve(bot.dig(block, true, 'raycast')).catch((e) => { err = e; }), 15000,
        () => { err = { name: 'DigTimeout' }; try { bot.stopDigging(); } catch (e) {} });
      if (err) throw err;
    },
    // Le drop tombe parfois d'un ou deux blocs (plancher de grotte) : on va le chercher, borné.
    pickup: async () => {
      const n0 = diamonds();
      await sleep(400);
      if (diamonds() > n0) return;
      let drop = null, best = Infinity;
      try {
        for (const e of Object.values(bot.entities || {})) {
          if (!e || !e.position || (e.name !== 'item' && e.objectType !== 'Item')) continue;
          const d = e.position.distanceTo(at.offset(0.5, 0.5, 0.5));
          if (d < 4 && d < best) { best = d; drop = e; }
        }
      } catch (e) { drop = null; }
      const goal = drop ? new pfGoals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 1)
        : new pfGoals.GoalNear(t.x, t.y, t.z, 1);
      await withTempMovements(bot, Movements, { canDig: false }, async () => {
        try { await withTimeout(bot.pathfinder.goto(goal), 6000, stop); } catch (e) { /* le compte tranche */ }
      });
      for (let i = 0; i < 6 && diamonds() <= n0; i++) await sleep(250);
    },
    // Le reste du filon (voisins par les FACES, anti x-ray), floodFillVein garde lave + outil récoltant.
    vein: async () => {
      for (const [dx, dy, dz] of _DIA_FACES) {
        if (tok && tok.cancelled) return;
        const q = { x: t.x + dx, y: t.y + dy, z: t.z + dz };
        let b = null;
        try { b = bot.blockAt(vec3Lib(q.x, q.y, q.z)); } catch (e) { b = null; }
        if (!b || !DIAMOND_ORES.has(b.name)) continue;
        await withTimeout(floodFillVein(bot, q, tok), 60000, stop);
      }
    },
    count: diamonds,
  });
}

/**
 * ESCALIER DIRIGÉ vers un minerai de grotte plus bas que le bot (22/10). Plan PUR (caveIron.stairPlan) :
 * marcher jusqu'au point de départ (sans creuser, borné), se tourner vers la grappe, descendre l'escalier
 * de descendDiagonal (1 bloc en avant par bloc descendu : eau/lave/vide devant → il s'arrête net).
 * ARRÊT relu à CHAQUE marche (caveIron.stairArrived) : pieds à la couche de la grappe (± 1) ou à ≤ 4 blocs
 * d'elle — et sur toute téléportation (mort, /home, /tpa : l'escalier ne continue pas ailleurs).
 * Eau/lave/vide/surplace → autre cap, on reprend d'où l'on est. Trop bas (dépassement) → on remonte vers
 * la grappe en creusant (GoalNear canDig:true).
 * @returns {{tried:boolean, reached?:boolean, overshot?:boolean, teleported?:boolean}}
 */
async function _caveStairTo(t, tok) {
  const p0 = bot.entity && bot.entity.position;
  const plan = p0 ? caveIronPick.stairPlan(p0, t) : null;
  if (!plan) return { tried: false };
  const tp0 = _tpCount;
  const teleported = () => _tpCount !== tp0;
  const pos = () => bot.entity && bot.entity.position;
  const arrived = () => caveIronPick.stairArrived(pos(), t);
  const stop = () => { try { stopMotion(); } catch (e) {} };
  emit({ type: 'cave_stair', x: t.x, y: t.y, z: t.z, drop: plan.drop, dx: plan.dir.dx, dz: plan.dir.dz });
  if (Math.hypot(p0.x - plan.start.x, p0.z - plan.start.z) > 3) {
    await withTempMovements(bot, Movements, { canDig: false }, async () => {
      try { await withTimeout(bot.pathfinder.goto(new pfGoals.GoalNearXZ(plan.start.x, plan.start.z, 2)), 90000, stop); } catch (e) { /* on descend d'où l'on est */ }
    });
  }
  const yStart = pos() ? pos().y : p0.y;
  const perp = { dx: plan.dir.dz, dz: plan.dir.dx };
  const dirs = [plan.dir, perp, { dx: -perp.dx, dz: -perp.dz }];
  let last = null;
  for (let i = 0; i < dirs.length && !tok.cancelled && !teleported() && !arrived(); i++) {
    const p = pos();
    if (!p || caveIronPick.stairOvershot(p, t)) break;
    try { await bot.look(caveIronPick.yawOf(dirs[i]), 0, true); } catch (e) { /* le cap reste celui du regard */ }
    // Jeton DÉRIVÉ : withTimeout n'annule rien — sans lui l'escalier continuerait de creuser après l'échéance.
    const sub = { cut: false };
    const subTok = { get cancelled() { return !!(tok.cancelled || sub.cut); } };
    last = await withTimeout(descendDiagonal(bot, {
      targetY: t.y - 1, maxDepth: Math.ceil(p.y - t.y) + 12, onSurvivalTick: descentSurvivalTick,
      stopWhen: () => teleported() || arrived(),
    }, subTok), 240000, () => { sub.cut = true; stop(); });
    if (last && last.ok) break;
    if (!(last && /water|lava|drop|no_progress|air_at|dig_failed|timeout/.test(String(last.reason || 'timeout')))) break;
  }
  const tpd = teleported();
  let overshot = !tpd && !tok.cancelled && caveIronPick.stairOvershot(pos(), t);
  if (overshot) {
    // Descendu sous la grappe : on REMONTE vers elle en creusant (pas d'échec sec en 1 s).
    await withTempMovements(bot, Movements, { canDig: true }, async () => {
      try { await withTimeout(bot.pathfinder.goto(new pfGoals.GoalNear(t.x, t.y, t.z, 2)), 60000, stop); } catch (e) { /* l'approche fine prend le relais */ }
    });
  }
  const yEnd = pos() ? pos().y : yStart;
  const reached = !tpd && !!arrived();
  emit({ type: 'cave_stair_done', reached, overshot, teleported: tpd, y: Math.round(yEnd),
    dropped: Math.round(yStart - yEnd), reason: (last && last.reason) || null });
  return { tried: true, reached, overshot, teleported: tpd };
}

/**
 * FER VISIBLE AVANT LA RÉCOLTE / LA GALERIE (24/10). Pour un but de récolte de fer HORS chaîne armure
 * (chaîne diamant : pioche fer à refaire à -54 ; chaîne pioche fer) : la grappe exposée la plus rentable,
 * vue ou mappée, à ≤ 64 blocs (ironCaveCtx forcé), sous la garde PV des grottes. Rend le résultat d'un essai
 * RÉUSSI ; null sinon (rien en vue, blessé, essai raté) → récolte / branch-mine habituels.
 */
async function ironCaveBeforeGather(goal) {
  try {
    if (!caveIronPick.caveHpOk(bot && bot.health)) return null;
    const cave = ironCaveCtx({ force: true });
    if (!cave) return null;
    emit({ type: 'iron_cave_first', goal: goal && goal.name, src: cave.src || 'map', ores: cave.count, dist: cave.dist });
    const r = await runCaveIron({ force: true });
    return (r && r.ok) ? r : null;
  } catch (e) { return null; }
}

async function runCaveIron(opts = {}) {
  _ironCaveCache = { at: 0, cave: null };          // relire la carte : un coéquipier a pu passer
  const cave = ironCaveCtx(opts);
  _ironCaveCache = { at: 0, cave: null };
  if (!cave) return { ok: false, reason: 'no_cave_target' };
  if (_teamClaims && !_teamClaims.tryClaim(cave.key)) {
    emit({ type: 'cave_failed', why: 'claimed', x: cave.x, y: cave.y, z: cave.z, took_s: 0, travel_s: 0, mine_s: 0, iron_got: 0 });
    return { ok: false, reason: 'claimed' };
  }
  const tok = taskToken;                            // CAPTURÉ : une préemption ne nous le vole pas
  const wkey = String(bot._worldKey || 'overworld');
  const stop = () => { try { stopMotion(); } catch (e) {} };
  const rawIron = () => ((bot.inventory && bot.inventory.items()) || [])
    .reduce((s, i) => s + (i.name === 'raw_iron' ? i.count : 0), 0);
  let r = null;
  _caveTripBusy = true;
  try {
    r = await caveIronSkill({
      cave, world: wkey, emit,
      // y du minerai deviné-par-carte mais réel : approche XZ d'abord (sans creuser), puis 3D.
      // Échec du trajet : `interrupted` si on nous a coupés (TP, but pathfinder changé par un autre,
      // bot emmené plus loin qu'au départ), `false` (= unreachable) sinon — cf. caveTravelVerdict.
      travel: async (c) => {
        const e = c.ores[0];
        const errs = [];
        const tp0 = _tpCount;
        const p0 = bot.entity && bot.entity.position;
        const d0 = p0 ? Math.hypot(p0.x - e.x, p0.y - e.y, p0.z - e.z) : null;
        // Grappe plus basse de > 4 blocs : pas de marche XZ jusqu'au-dessus d'elle — l'escalier part
        // `drop` blocs AVANT elle (stairPlan) et y marche lui-même.
        if (p0 && Math.hypot(p0.x - e.x, p0.z - e.z) > 24 && !caveIronPick.stairPlan(p0, e)) {
          await withTempMovements(bot, Movements, { canDig: false }, async () => {
            try { await withTimeout(bot.pathfinder.goto(new pfGoals.GoalNearXZ(e.x, e.z, 8)), 150000, stop); } catch (err) { errs.push(err); }
          });
          if (tok.cancelled) return false;
        }
        // Grappe plus BASSE de > 4 blocs : on y descend en ESCALIER dirigé (un pathfinder générique
        // rend NoPath dans la roche pleine), puis l'approche fine ci-dessous finit le trajet.
        let stair = { tried: false };
        if (!tok.cancelled) { try { stair = await _caveStairTo(e, tok); } catch (err) { errs.push(err); } }
        if (tok.cancelled) return false;
        if (stair && stair.teleported) return 'interrupted';   // mort / TP en plein escalier : pas de verdict
        const ok = await _caveGotoOre(e, tok, errs);
        if (ok) return true;
        const p1 = bot.entity && bot.entity.position;
        const d1 = p1 ? Math.hypot(p1.x - e.x, p1.y - e.y, p1.z - e.z) : null;
        return caveTravelVerdict({ teleported: _tpCount > tp0, errs, d0, d1, stairMissed: !!(stair && stair.tried && !stair.reached) });
      },
      oreState: (o) => {
        const b = bot.blockAt(vec3Lib(o.x, o.y, o.z));
        if (!b) return 'unknown';
        return caveIronPick.isIronOre(b.name) ? 'ore' : 'gone';
      },
      approach: (o) => _caveGotoOre(o, tok),
      // Même garde que le ramassage opportuniste : jamais à travers la paroi (anti « x-ray »).
      canSee: (o) => {
        const b = bot.blockAt(vec3Lib(o.x, o.y, o.z));
        if (!b) return false;
        return typeof bot.canSeeBlock === 'function' ? !!bot.canSeeBlock(b) : true;
      },
      mineVein: async (o) => {
        if (isInWater(bot)) { try { await escapeWater(bot, { emit }); } catch (e) {} if (isInWater(bot)) return 0; }
        const before = rawIron();
        await withTimeout(floodFillVein(bot, o, tok), 120000, stop);
        return Math.max(0, rawIron() - before);
      },
      survivalTick: () => branchSurvivalTick(),
      placeTorch: () => _caveTorch(),
      // Le chantier EST la grotte : après une mort, `/home work` ramène ici (dette de mort à part).
      markWork: () => {
        // Le bûcheron garde `work` sur son coin de coupe : une tranche de fer ne le déplace pas.
        if (isLumberjackObjective()) return false;
        if (isInWater(bot)) return false;
        if (!homewarp.bookmark(bot, HOME_WORK)) return false;
        _workSet = true; _workPos = _botXZ();
        emit({ type: 'work_bookmarked', why: 'iron_cave' });
        return true;
      },
      refreshClaim: () => { if (_teamClaims) _teamClaims.refresh(cave.key); },
    }, tok);
  } finally {
    _caveTripBusy = false;
    try { if (_teamClaims) _teamClaims.release(cave.key); } catch (e) {}
  }
  // BUDGET (23/10) : tout essai sauf cancelled compte (interrupted compris : ses minutes sont perdues
  // aussi) — cf. caveIron.caveBudgetRecord. Le verdict est rendu au prochain ironCaveCtx (cache vidé).
  _caveBudgetRecord(r);
  _ironCaveCache = { at: 0, cave: null };
  // Une préemption (migration, combat, nuit) n'est pas un verdict sur la grotte.
  if (r && r.reason === 'interrupted') {
    const now = Date.now();
    const recent = (_caveInterrupts[cave.key] || []).filter((t) => now - t < CAVE_INTERRUPT_WINDOW_MS).concat([now]);
    _caveInterrupts[cave.key] = recent;
    if (recent.length >= 2) noteCaveTried(cave, 'interrupted');   // mise de côté 30 min, hors disjoncteur
  } else if (r && r.reason !== 'cancelled') noteCaveTried(cave, r.ok ? 'done' : r.reason);
  return r;
}

/**
 * PUR — verdict d'un trajet de grotte RATÉ : 'interrupted' (on nous a coupés) ou false (= unreachable).
 * teleported : un TP a eu lieu pendant le trajet · errs : erreurs du pathfinder (GoalChanged = un autre
 * a posé son but) · d0/d1 : distance à la cible au départ / à l'arrêt (fuite, /tpa, poussée).
 */
function caveTravelVerdict({ teleported, errs, d0, d1, stairMissed } = {}) {
  if (teleported) return 'interrupted';
  const list = Array.isArray(errs) ? errs : [];
  const own = list.some((e) => e && e.name === 'OwnTimeout');
  for (const e of list) {
    const name = String((e && e.name) || '');
    const msg = String((e && e.message) || e || '');
    if (name === 'GoalChanged' || /goal was changed/i.test(msg)) return 'interrupted';
    // PathStopped SANS notre échéance = quelqu'un d'autre a coupé le pathfinder (réflexe de combat,
    // couvert, fuite) — mesuré 22/10 : 2 grappes « unreachable » en 1-2 s pendant un take_cover.
    if (!own && (name === 'PathStopped' || /path was stopped/i.test(msg))) return 'interrupted';
  }
  if (Number.isFinite(d0) && Number.isFinite(d1) && d1 >= d0 + CAVE_PULLED_AWAY) return 'interrupted';
  // L'escalier n'a pas atteint la couche : c'est l'ESCALIER qui a raté, pas la grotte qui est hors
  // d'atteinte → raison propre, mise de côté 30 min, hors disjoncteur `unreachable`.
  if (stairMissed) return 'stair_missed';
  return false;
}

/**
 * PUR — la cause d'une coupure de trajet, pour le log : 'goal_changed' (un autre a posé son but),
 * 'path_stopped' (quelqu'un a arrêté le pathfinder), 'pulled_away' (bot emmené plus loin), sinon
 * 'interrupted'. Même lecture que caveTravelVerdict (notre propre échéance n'est pas une coupure).
 */
function caveInterruptCause(errs, d0, d1) {
  const list = Array.isArray(errs) ? errs : [];
  const own = list.some((e) => e && e.name === 'OwnTimeout');
  for (const e of list) {
    const name = String((e && e.name) || '');
    const msg = String((e && e.message) || e || '');
    if (name === 'GoalChanged' || /goal was changed/i.test(msg)) return 'goal_changed';
    if (!own && (name === 'PathStopped' || /path was stopped/i.test(msg))) return 'path_stopped';
  }
  if (Number.isFinite(d0) && Number.isFinite(d1) && d1 >= d0 + CAVE_PULLED_AWAY) return 'pulled_away';
  return 'interrupted';
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

// ─── HISTORIQUE DE MORTS PERSISTÉ (live 19/10, MapBot1) ─────────────────────────────────────────
// Même schéma que la dette de mort et l'état de zone : champ `deaths` du mémo de base, élagué au
// chargement (fenêtre 10 min, cap 10), mémo d'ancien format sans le champ → historique vide.
// La logique est PURE (unstuck.js : deathTimesLoad / deathMemoWith / escapeArmed) ; ici, la seule glue.

/**
 * Relit les morts des process précédents — UNE fois par process (appelée par le handler `spawn`, et
 * par `death` au cas où). Si l'historique hérité dit que ce spawn est campé, ARME l'évasion tout de
 * suite : `_escapeOnSpawn` armé à la 5ᵉ mort mourait avec le process (process.exit(2)), d'où 2-3 vies
 * perdues à chaque génération avant de seulement penser à fuir.
 */
function loadDeathHistory() {
  if (_deathHistoryLoaded) return;
  _deathHistoryLoaded = true;
  try {
    const now = Date.now();
    const inherited = deathTimesLoad(loadBaseState(), now);
    // Fusion avec ce que ce process aurait DÉJÀ enregistré : on ne perd jamais une mort.
    deathTimes = deathTimesPrune(inherited.concat(deathTimes), now);
    if (inherited.length) {
      const armed = escapeArmed(deathTimes, now);
      if (armed) _escapeOnSpawn = true;
      emit({ type: 'death_history_loaded', count: inherited.length, armed });
    }
  } catch (e) { /* best-effort : sans l'historique on retombe sur le comportement d'avant */ }
}

/**
 * Écrit l'historique dans le mémo en PRÉSERVANT le reste (base, dette, zone : fusion sur l'état
 * COURANT, jamais un objet neuf). Rend false — et le DIT — si le fichier n'a pas pu être écrit :
 * c'est la seule façon de savoir que la prochaine relance repartira de zéro.
 */
function persistDeathHistory() {
  try {
    const ok = saveBaseState(deathMemoWith(loadBaseState(), deathTimes, Date.now()));
    if (ok === false) { emit({ type: 'death_history_save_failed' }); return false; }
    return true;
  } catch (e) { return false; }
}

// ─── HOME `safe` CAMPÉ (live 19/10, monde neuf : spawn sous la canopée d'une vieille forêt de bouleaux) ─
// Le home `safe` est posé au spawn et c'est la destination de secours de TOUT le code. Or le spawn était
// CAMPÉ (zombies/squelettes/creepers qui ne brûlent pas sous la canopée) : MapBot2 y est mort 8 fois en
// 3 min, chaque « secours » le ramenant au camp — 12 morts en 5 min sur la flotte, dont 6 creepers.
// Décisions PURES dans homeSafety.js ; ici, la seule glue :
//   - les POSITIONS de mort, persistées (champ `deathPos` du mémo) : le death_loop fait process.exit(2) et
//     le process neuf respawne au même camp — il DOIT savoir que son home y est ;
//   - safeHomeVeto : LE point de décision, consulté par homewarp.goHome (bot._mcaSafeVeto, posé après
//     createBot) pour TOUT /home safe, et par safeWarpHome avant de se murer ;
//   - noteSafeHome : TOUT /sethome safe est mémorisé (état + mémo `safeHome`) — sans ça le veto jugerait
//     un autre endroit que celui où /home safe téléporte vraiment ;
//   - maybeMoveCampedSafeHome : de jour, au calme, en surface, loin du camp → le home DÉMÉNAGE (timer 5 s) ;
//   - poseSafeHomeAtSpawn : un process neuf ne re-pose plus `safe` DANS le camp.

/** Relit les positions de mort des process précédents — UNE fois par process (lazy : le 1er besoin). */
function loadDeathPositions() {
  if (_deathPosLoaded) return;
  _deathPosLoaded = true;
  try {
    const now = Date.now();
    // Fusion avec ce que ce process aurait déjà noté : on ne perd jamais une mort.
    _deathPos = deathPosPrune(deathPosLoad(loadBaseState(), now).concat(_deathPos), now);
  } catch (e) { /* best-effort : sans l'historique, aucun home n'est jugé campé (comportement d'avant) */ }
}

/** Positions de mort récentes, chargées au besoin. */
function _recentDeathPositions() {
  loadDeathPositions();
  return _deathPos;
}

/** Ce point est-il CAMPÉ (≥ 2 morts récentes à ≤ 24 blocs) ? */
function _campedAt(p) {
  try { return homeCamped({ home: p, deaths: _recentDeathPositions(), now: Date.now() }); } catch (e) { return false; }
}

/**
 * Note la POSITION d'une mort et la PERSISTE (fusion sur le mémo COURANT, piège #61). Appelée par le
 * handler `death` AVANT tout process.exit(2) : c'est elle qui dira au process suivant que son home est
 * campé. Rend false — et le DIT — si l'écriture échoue (la relance ne verrait pas cette mort).
 */
function recordDeathPosition(p) {
  try {
    loadDeathPositions();
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.z)) return false;
    const now = Date.now();
    _deathPos = deathPosPrune(_deathPos.concat([{ x: p.x, y: p.y, z: p.z, at: now }]), now);
    const ok = saveBaseState(deathPosMemoWith(loadBaseState(), _deathPos, now));
    if (ok === false) { emit({ type: 'death_pos_save_failed' }); return false; }
    return true;
  } catch (e) { return false; }
}

/**
 * Mémorise le home `safe` qu'on VIENT de poser (/sethome safe envoyé) : état du process ET mémo de base
 * (`safeHome`, relu au spawn d'un process neuf). Un test de câblage exige un appel après CHAQUE
 * /sethome safe : un seul oubli, et le veto jugerait un autre endroit que celui où /home téléporte.
 */
function noteSafeHome(p, why) {
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.z)) return false;
  _safeHomeSet = true;
  _safeHomeSurface = Number.isFinite(p.y) && p.y >= SAFE_HOME_MIN_Y;
  _safeHomePos = { x: p.x, y: p.y, z: p.z };   // COPIE : bot.entity.position est muté en place
  _hostileNearHomeAt = 0;                       // les hostiles vus près de l'ANCIEN home ne campent pas celui-ci
  // Home qui n'existait plus côté serveur (20/10) : ce /sethome safe le RECRÉE — on lève la note et on le dit.
  if (_homeMissingAt[HOME_SAFE]) {
    delete _homeMissingAt[HOME_SAFE];
    emit({ type: 'home_set_recovered', name: HOME_SAFE, why, x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) });
  }
  try {
    const memo = safeHomeMemoWith(loadBaseState(), _safeHomePos, Date.now(), why);
    delete memo[SAFE_MISSING_MEMO_KEY];
    return saveBaseState(memo) !== false;
  } catch (e) { return false; }
}

/** Hostile « vrai » : même prédicat que spawnDangerNow (kind OU nom listé), moins les neutres (enderman). */
function _isFoe(e) {
  return !!e && e.isValid !== false && isFleeHostile(e) && !NEUTRAL_NO_PROVOKE.has(e.name);
}

/**
 * Note un hostile vu près du HOME (pas du bot) et rend l'instant de la dernière observation. Le client ne
 * voit que les entités à portée de suivi : loin du home on ne voit rien, et la mémoire (5 min,
 * homeSafety.HOSTILE_SEEN_MS) prend le relais.
 */
function noteHostileNearSafeHome(now) {
  try {
    if (_safeHomePos && hostileNearHome({
      home: _safeHomePos, entities: Object.values(bot.entities || {}), isHostile: _isFoe,
    })) _hostileNearHomeAt = now;
  } catch (e) { /* best-effort */ }
  return _hostileNearHomeAt;
}

// ── MORT IMMINENTE : signaux + verdict (niveau MODULE, piège #56 — lus par le watchdog 1 s) ─────
/** Signaux du watchdog PV, lus sur le bot. Jamais de throw. `armorPieces` = pièces portées non usées. */
function imminentState() {
  return {
    health: bot.health,
    inWater: (function () { try { return isInWater(bot); } catch (e) { return false; } })(),
    oxygen: bot.oxygenLevel,
    lavaNear: (function () { try { return lavaNearby(bot, 2); } catch (e) { return false; } })(),
    nearbyHostiles: (function () { try { return nearbyHostiles(bot, 6).length; } catch (e) { return 0; } })(),
    armorPieces: (function () { try { return _wornArmor().size; } catch (e) { return null; } })(),
  };
}

/**
 * Verdict du watchdog PV : classifyImminent, puis dégradation si le /home safe vient d'être refusé
 * (re-spammer un TP qui ne part pas a zombifié NethBot2 ; keepInventory ON : mieux vaut mourir qu'un
 * stall à 1,8 PV) ou si le home est campé (live 19/10, MapBot2 renvoyé dans le camp où il venait de
 * mourir). Bande essaim 6-10 PV (`early`, chrono 22/10) : seul un VRAI départ compte — dégradée, elle
 * rend null (s'immobiliser à 9 PV entre deux mobs serait pire que de laisser la survie se battre ou fuir).
 */
function imminentVerdictNow(s) {
  const early = !!(s && typeof s.health === 'number' && s.health > homewarp.IMMINENT_HP);
  let verdict = homewarp.effectiveVerdict(homewarp.classifyImminent(s), _homeRefusedAt.safe, Date.now());
  if (verdict === 'escape' && safeHomeVeto('imminent')) verdict = 'escape_no_warp';
  if (early && verdict !== 'escape') verdict = null;
  return { verdict, early };
}

/**
 * LE point de décision unique : un warp de SECOURS vers `safe` doit-il être refusé ?
 * null = on y va ; sinon le verdict de homeSafety.rescueWarpVeto (`home_safe_camped` tracé, 1×/min max).
 * Jamais de throw : une lecture ratée ne bloque JAMAIS un secours. `ctx` = qui demande (télémétrie).
 * Un /home safe tapé sur ORDRE (commande LLM/joueur) ne passe pas par ici : il n'est jamais bloqué.
 */
function safeHomeVeto(ctx) {
  try {
    if (!_safeHomePos) return null;
    const now = Date.now();
    const v = rescueWarpVeto({
      home: _safeHomePos, deaths: _recentDeathPositions(), now,
      night: (bot.time && bot.time.timeOfDay != null) ? isNight(bot) : null,   // inconnu → pas de garde-fou nuit
      hostilesNearHomeSeen: noteHostileNearSafeHome(now),
    });
    if (!v.veto) return null;
    if (now - _homeCampedEventAt >= CAMPED_EVENT_EVERY_MS) {
      _homeCampedEventAt = now;
      emit({ type: 'home_safe_camped', why: v.why, deaths: v.deaths, ctx: ctx || null });
    }
    return v;
  } catch (e) { return null; }
}

/**
 * RE-POSE du home `safe` hors du camp (timer 5 s). Conditions : homeSafety.safeHomeMove (surface au sec,
 * pieds au sol, JOUR su, aucun hostile à ≤ 24 blocs, loin du camp, 1×/5 min — cooldown relu du mémo,
 * il traverse les relances). LA BASE SUIT, avec la partie utile du chemin `zone_migrated` : /sethome
 * safe ICI, /spawnpoint, base persistée (ouvriers — un cartographe n'en a pas), confine et borne
 * d'exploration ré-ancrés. PAS le reste : ni /delhome work (le chantier est à deux pas), ni remise à zéro
 * des compteurs de zone (c'est la même zone). Schéma 3 homes intact : on ÉCRASE `safe` (Essentials
 * remplace un home du même nom), aucun nom de plus, aucun /delhome (pas une seconde sans home).
 */
function maybeMoveCampedSafeHome() {
  try {
    const home = _safeHomePos;
    const ent = bot.entity;
    const p = ent && ent.position;
    if (!home || !p || bot.isAlive === false) return null;   // mort : la position est celle du cadavre
    const now = Date.now();
    noteHostileNearSafeHome(now);   // un hostile vu près du home est NOTÉ même sans warp en vue
    // Une autre tâche possède le bot ou re-pose `safe` elle-même (migration, installation de base,
    // fuite, sauvetage, abri) : on ne lui coupe pas l'herbe sous le pied.
    if (_migrating || _escaping || _baseBusy || _imminentBusy || _stillBusy || _skelRushBusy) return null;
    const foe = nearestHostile({ pos: p, entities: Object.values(bot.entities || {}), isHostile: _isFoe });
    const persisted = safeHomeLoad(loadBaseState());
    const lastMovedAt = Math.max(_safeHomeMovedAt, (persisted && persisted.why === 'camped') ? persisted.at : 0);
    const d = safeHomeMove({
      home, here: { x: p.x, y: p.y, z: p.z }, deaths: _recentDeathPositions(), now,
      inWater: (function () { try { return isInWater(bot); } catch (e) { return true; } })(),   // illisible → prudent
      onGround: !!ent.onGround,
      night: (bot.time && bot.time.timeOfDay != null) ? isNight(bot) : null,
      nearestHostileDist: foe ? foe.dist : null,
      lastMovedAt,
    });
    if (!d.move) return d;
    if (!homewarp.bookmark(bot, HOME_SAFE)) return { move: false, reason: 'sethome_failed', deaths: d.deaths };
    const from = { x: Math.round(home.x), y: Math.round(home.y), z: Math.round(home.z) };
    noteSafeHome(p, 'camped');
    _safeHomeMovedAt = now;
    const to = { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) };
    anchorSpawnpoint('camped_move');   // les respawns aussi quittent le camp (op seulement ; veto si l'arrivée est campée)
    if (!IS_MAPPER) saveBaseState(Object.assign({}, loadBaseState() || {}, { base: to }));
    if (CONFINE) CONFINE = { x: to.x, z: to.z, radius: CONFINE.radius };
    if (_confineDyn) _confineDyn = { x: to.x, z: to.z, radius: _confineDyn.radius };
    const conf = CONFINE || _confineDyn;
    if (conf) bot._mcaExploreBounds = { x: conf.x, z: conf.z, radius: Math.max(conf.radius * 2, 128) };
    emit({ type: 'home_safe_moved', from, to, deaths: d.deaths });
    return d;
  } catch (e) { return null; }
}

/**
 * Home `safe` au spawn — extrait de onSpawn, + la garde « home campé » (homeSafety.spawnSafeHomeAction).
 * 'safe' = cible de goSpawn. On le pose TOUJOURS (fallback = position de spawn courante, même
 * souterraine → goSpawn a toujours une cible valide) puis on l'UPGRADE dès qu'on spawne à une
 * vraie surface (y≥58, sèche). Sans ça un bot qui respawne toujours sous terre n'avait pas de
 * 'safe' → /home safe échouait (vécu bot1 : spawn direct y15, jamais de safe_home_set).
 * ⚠️ JAMAIS les pieds dans l'eau (vécu world_ax2 03:00 : reconnexion dans une rivière → safe
 * posé DANS l'eau → tous les /home safe morts (teleport-safety) → reflex surface ×190, bots
 * qui sautillent sur place à l'infini). Pas de pose mouillée ; le watchdog 1 s re-pose dès
 * la première surface sèche (condition élargie à !_safeHomeSet).
 * ⚠️ HOME CAMPÉ (live 19/10) : un process NEUF (`_safeHomeSet` repart à false) respawne après un
 * death_loop… au camp, et y re-posait `safe` — le déménagement du process précédent était annulé. Spawn
 * campé + home persisté sain → on l'ADOPTE (rien n'est re-posé) ; un safe déjà en main ne déménage pas
 * dans le camp ; sans rien d'autre, on pose quand même (un home connu, même campé, est mis sous veto).
 */
function poseSafeHomeAtSpawn() {
  const p = bot.entity && bot.entity.position;
  const wet = (function () { try { return isInWater(bot); } catch (e) { return false; } })();
  if (!p || wet) return;
  const atSurface = p.y >= SAFE_HOME_MIN_Y;
  if (_safeHomeSet && (_safeHomeSurface || !atSurface)) return;   // rien à poser ni à améliorer
  const act = spawnSafeHomeAction({
    here: p, deaths: _recentDeathPositions(), now: Date.now(), hasSafe: _safeHomeSet,
    persisted: safeHomeLoad(loadBaseState()),
  });
  if (act.act === 'keep') {
    emit({ type: 'safe_home_kept', camped: true, x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) });
    return;
  }
  if (act.act === 'adopt') {
    const h = act.home;
    _safeHomeSet = true;
    _safeHomeSurface = h.y >= SAFE_HOME_MIN_Y;
    _safeHomePos = { x: h.x, y: h.y, z: h.z };
    _hostileNearHomeAt = 0;
    emit({ type: 'safe_home_adopted', why: 'spawn_camped', x: h.x, y: h.y, z: h.z });
    // L'ANCRE SUIT le home adopté. Sans ça l'auto-ancrage NO_GIVE (`!_anchorSet`, watchdog 1 s) poserait
    // `safe` à la 1ʳᵉ position stable — à deux pas du camp que l'on fuit — et annulerait l'adoption.
    // Même effet que `confine_anchored`, sans re-poser de home. Jamais sur un confine STATIQUE (arène).
    if (NO_GIVE && !_anchorSet && !CONFINE && world.objective && world.objective.status === 'in_progress') {
      _anchorSet = true;
      if (!IS_MAPPER) {   // cartographe : l'ancre (anti re-pose dans le camp) oui, la poche non
        _confineDyn = { x: Math.round(h.x), z: Math.round(h.z), radius: DEFAULT_CONFINE_RADIUS };
        bot._mcaExploreBounds = { x: _confineDyn.x, z: _confineDyn.z, radius: Math.max(_confineDyn.radius * 2, 128) };
        emit({ type: 'confine_anchored', x: _confineDyn.x, z: _confineDyn.z, radius: _confineDyn.radius, static: false, adopted: true });
      }
    }
    return;
  }
  if (!homewarp.bookmark(bot, 'safe')) return;   // refusé (vide sous les pieds) : jamais noté comme posé
  noteSafeHome(p, 'spawn');
  emit({
    type: 'safe_home_set', surface: atSurface, x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z),
    ...(act.camped ? { camped: true } : {}),
  });
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

// Dette DIFFÉRÉE (de nuit, bot nu : cf. homes.debtAction → 'defer') : on ne se téléporte PAS au lieu de
// mort — là où les monstres viennent de nous tuer — et on re-décide 60 s plus tard (aube levée, armure
// trouvée, ou TTL de despawn → dette levée : la boucle est bornée par les 5 min de la dette).
// ⚠️ GARDES DE NIVEAU MODULE, comme `_deathDebtBusy` (l.~267) : le timer les lit HORS de tout onSpawn.
// Déclarées dans onSpawn, elles lèveraient un ReferenceError au premier tir et TUERAIENT le process
// alors que les tests passent (piège #56, vécu avec `panicInFlight`).
let _deathDebtRetryTimer = null;   // UNE seule relance en attente à la fois
let _deathDebtDeferredAt = null;   // `at` de la dette dont le report est déjà tracé → UNE trace par dette
const DEATH_DEBT_RETRY_MS = 60000;

/** Diffère la récupération : trace UNE fois par dette, arme UNE relance (jamais deux en attente). */
function deferDeathDebt(debt, reason) {
  if (_deathDebtDeferredAt !== debt.at) {
    _deathDebtDeferredAt = debt.at;
    emit({ type: 'death_debt_deferred', reason });
  }
  if (_deathDebtRetryTimer) return;
  _deathDebtRetryTimer = setTimeout(() => {
    _deathDebtRetryTimer = null;
    // Mort entre-temps : le prochain `spawn` relance de toute façon (onSpawn relit la dette persistée).
    if (bot.isAlive === false) return;
    // `.catch` OBLIGATOIRE : un rejet non géré tue le process (Node ≥ 15).
    recoverDeathDebt().catch(() => { /* best-effort : la dette reste, le TTL la lèvera */ });
  }, DEATH_DEBT_RETRY_MS);
}

/**
 * Récupération post-respawn : /home death → tuer tout ce qui traîne → ramasser → ne lever la dette
 * QUE s'il ne reste plus rien au sol. Sinon la dette reste et le prochain respawn y revient.
 * Prioritaire sur la reprise de chaîne ; les réflexes de survie restent armés pendant toute la manœuvre.
 * DE NUIT et NU (< 2 pièces portées) on ne part pas : la dette est différée (deferDeathDebt). Sinon le
 * bot est arraché à son abri et renvoyé là où il vient de mourir — 9 morts en 4 min (run de référence).
 */
async function recoverDeathDebt() {
  if (_deathDebtBusy) return;
  const debt0 = loadDeathDebt();
  // Heure + armure relues à CHAQUE décision (la première, puis le re-contrôle après l'attente plus bas).
  // `bot.time` peut manquer juste après un spawn/une reconnexion : `null` = inconnu → pas de garde-fou
  // (même convention que mapperNightGuard / regroupNightGuard).
  const decide = () => {
    let worn = 0;
    try { worn = _wornArmor().size; } catch (e) { /* inventaire pas encore livré → 0 = prudent */ }
    // keepInventory ON → l'inventaire est revenu avec le bot : rien au sol, la dette se lève SANS
    // se téléporter au camp. Sous keepInventory OFF il revient vide → faux → comportement d'origine.
    let keptInventory = false;
    try { keptInventory = inventoryKept({ before: _invAtDeath, after: _invTotal(() => true) }); } catch (e) { keptInventory = false; }
    return debtAction({
      debt: debt0, now: Date.now(), worn, keptInventory,
      night: (bot.time && bot.time.timeOfDay != null) ? isNight(bot) : null,
    });
  };
  const first = decide();
  if (first.act === 'none') return;
  if (first.act === 'settle') { settleDeathDebt(first.reason); return; }
  if (first.act === 'defer') { deferDeathDebt(debt0, first.reason); return; }
  _deathDebtBusy = true;
  try {
    await sleep(1500);
    // Re-contrôle : au spawn d'un process fraîchement relancé (self-healing après death_loop) l'heure
    // n'est parfois pas encore livrée → la 1re décision a pu passer faute de savoir. Après l'attente
    // elle l'est : nuit + nu → on diffère au lieu de se téléporter. (`return` → le finally lève la garde.)
    const again = decide();
    if (again.act === 'defer') { deferDeathDebt(debt0, again.reason); return; }
    // L'inventaire n'est souvent livré qu'APRÈS la 1re décision (paquets post-spawn) : c'est ici que
    // keepInventory se voit — on lève la dette au lieu de partir (`return` → le finally lève la garde).
    if (again.act === 'settle') { settleDeathDebt(again.reason); return; }
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
// Seuil d'engagement : un bot NU (< 2 pièces portées — le même « nu » que homes.DEBT_MIN_WORN et
// caution.CAUTION_MIN_WORN) ET à ≤ 5 cœurs n'a pas les moyens de « tuer tout » : un coup de
// squelette ou de creeper le finit.
const DEATH_CLEAR_MIN_WORN = 2;
const DEATH_CLEAR_MIN_HP = 10;

/** Engage les hostiles proches du lieu de mort (borné) : « le but est de tuer tout, pas de fuir ».
 *  … SAUF nu ET blessé (< 2 pièces, PV ≤ 10) : on cesse d'engager et les réflexes de fuite existants
 *  prennent le relais. Le cas armuré est inchangé. Relu à chaque tour : les PV baissent en combattant. */
async function clearHostilesAround() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    let target = null;
    try {
      const list = nearbyHostiles(bot, DEATH_CLEAR_RADIUS);
      target = list && list.length ? list[0] : null;
    } catch (e) { target = null; }
    if (!target) return;
    let worn = 0;
    try { worn = _wornArmor().size; } catch (e) { /* inventaire pas encore livré → 0 = prudent */ }
    if (worn < DEATH_CLEAR_MIN_WORN && bot.health != null && bot.health <= DEATH_CLEAR_MIN_HP) {
      try { bot.pvp && bot.pvp.stop(); } catch (e) {}
      emit({ type: 'death_clear_aborted', reason: 'naked_low_hp', health: bot.health, worn });
      return;
    }
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
    // ANTI-VIDE (22/10) : jamais une base au-dessus d'un vide — on marche d'abord jusqu'au sol sûr.
    if (!(await stepToSafeGround('base'))) { emit({ type: 'base_establish_failed', reason: 'void_below', y: Math.round(p.y) }); return; }
    if (!homewarp.bookmark(bot, 'safe')) { emit({ type: 'base_establish_failed', reason: 'sethome_refused', y: Math.round(p.y) }); return; }
    noteSafeHome(p, 'base');   // état du process + `safeHome` persisté (relu par le process suivant)
    // « mettre un home pour l'utiliser comme spawn » : /spawnpoint ancre le respawn ICI, donc une
    // mort ne renvoie plus au spawn du monde partagé (précédent : /spawnpoint post-kit des bots
    // ressource, cf. 'kit_done'). Jamais dans un camp (veto homeSafety.spawnpointVeto).
    anchorSpawnpoint('base');
    const base = { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) };
    // FUSION sur l'état COURANT du mémo (relu ICI, pas `st` pris avant les gotos de 90 s). Un objet
    // neuf effaçait `deaths`, `deathDebt` et `zone` à chaque établissement de base : l'aller-retour du
    // mémo est cassé dès qu'UN écrivain oublie les champs des autres (piège #61). Tout écrivain du
    // mémo fusionne — un test interdit le littéral neuf.
    saveBaseState(Object.assign({}, loadBaseState() || {}, { base, worldSpawn: wspawn, personal: personal || !!st.personal }));
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
    // + 10 min de silence par pièce (boucle d'usure 24/10 : la pièce entrait/sortait du slot et
    // ré-émettait à chaque transition — 294 gear_worn_out dans une session).
    const _nowW = Date.now();
    for (const name of wr.toEmit) {
      if (_nowW - (_wornOutAt[name] || 0) < 10 * 60 * 1000) continue;
      _wornOutAt[name] = _nowW;
      emit({ type: 'gear_worn_out', item: name, slot: 'armor' });
    }
  } catch (e) {}
  return worn;
}
// Dernier ré-essai d'équipement FORCÉ (arrêt + 1,5 s) — rationne l'immobilisation quand un
// équipement échoue durablement. ⚠️ AU NIVEAU MODULE comme ses sœurs (_armorBusy, _stillBusy…) :
// une garde déclarée dans une fonction et lue ailleurs compile, passe les tests, et tue le bot en
// prod (piège #56).
let _lastEquipRetryAt = 0;
async function ensureArmor(opts = {}) {
  installPickupEquip();   // idempotent — posé ici : TOUS les rôles passent par ensureArmor
  const items = () => ((bot.inventory && bot.inventory.items()) || []).map((i) => ({ name: i.name, count: i.count }));
  const cnt = (n) => items().filter((i) => i.name === n).reduce((a, i) => a + i.count, 0);
  const worn = _wornArmor();
  // ⚠️ ÉQUIPEMENT INSTRUMENTÉ + RÉ-ESSAI (18/08, cause n°1 des cartographes nus) : l'échec de
  // `bot.equip` partait dans un `catch (e) {}` MUET — invisible dans les events et jamais re-tenté.
  // MapBot1 porte `picked_up: iron_chestplate 1, iron_helmet 1` dans ses stats vanilla (pièces
  // reçues d'un coéquipier) pendant que la présence le donne `armor:0` : il ne PORTE pas ce qu'il a
  // en poche, 92 morts. Or `equip` échoue surtout EN MOUVEMENT (le serveur refuse le changement de
  // slot pendant un déplacement/dig) → on ÉMET (#55a « le silence est un bug »), on coupe le
  // mouvement, on souffle ~1,5 s et on re-tente UNE fois (caution.equipRetryPlan, pur/testé).
  // Déclaré AVANT la garde « déjà 4 pièces » : le bouclier ci-dessous doit être équipé même par un
  // bot en set complet, et les chemins de craft plus bas passent par le même helper.
  const equipFails = [];
  const equipOnce = async (name, dest, isRetry) => {
    const _all = ((bot.inventory && bot.inventory.items()) || []).filter((i) => i.name === name);
    const it = _all.find((i) => !isNearlyBroken(i)) || _all[0];   // la pièce SAINE d'abord (armorWear)
    if (!it) return { ok: false, reason: 'gone' };   // consommé/perdu entre-temps : rien à signaler
    try {
      await bot.equip(it, dest);
      worn.add(name);
      // Toujours émis (24/10) : sans lui, impossible de voir dans les logs qu'une pièce reçue a été enfilée.
      emit({ type: 'armor_equipped', slot: dest, item: name, piece: name, dest, retry: !!isRetry });
      try { if (_beatNow && /_(helmet|chestplate|leggings|boots)$/.test(name)) _beatNow(); } catch (e) {}
      return { ok: true };
    } catch (e) {
      const reason = (e && e.message) ? String(e.message).slice(0, 80) : 'error';
      emit({ type: 'armor_equip_failed', piece: name, dest, reason, retry: !!isRetry });
      return { ok: false, reason };
    }
  };
  const noteFail = (name, dest, r) => {
    if (!r.ok && r.reason !== 'gone') equipFails.push({ piece: name, dest, reason: r.reason });
  };
  // BOUCLIER DÉJÀ EN POCHE mais pas en main secondaire : personne ne l'équipait — le plan de craft
  // (§3 plus bas) compte le SAC dans `hasShield`, donc `shieldPlan` ne rend rien et le bouclier
  // dormait. Un bouclier dans le sac n'arrête aucune flèche, et le squelette est le tueur n°1 des
  // cartographes (25 morts sur les 92 de MapBot1).
  const _offhandName = () => {
    try { const s = bot.inventory && bot.inventory.slots && bot.inventory.slots[45]; return s && s.name; }
    catch (e) { return null; }
  };
  if (_offhandName() !== 'shield' && items().some((i) => i.name === 'shield')) {
    noteFail('shield', 'off-hand', await equipOnce('shield', 'off-hand', false));
  }
  // Ré-essai UNIQUE, à l'arrêt (politique pure). Appelé aux DEUX sorties : le bot en set complet
  // repart tout de suite plus bas, il ne doit pas perdre son ré-essai de bouclier au passage.
  const flushEquipRetry = async () => {
    const plan = equipRetryPlan(equipFails.splice(0),
      { attempt: 1, now: Date.now(), lastRetryAt: _lastEquipRetryAt });
    if (!plan.retry) return;
    _lastEquipRetryAt = Date.now();
    if (plan.stopFirst) { try { stopMotion(); } catch (e) {} }
    await sleep(plan.waitMs);
    for (const f of plan.pieces) await equipOnce(f.piece, f.dest, true);
  };
  // bug #4 : déjà 4 pièces d'armure (TOUTE matière — ex. diamant du kit OP) → ne RIEN faire. Sinon le
  // craft ci-dessous re-fabriquerait du FER et l'équiperait PAR-DESSUS le diamant (downgrade). Slot-agnostique.
  const _SLOT_SUF = ['_helmet', '_chestplate', '_leggings', '_boots'];
  if (_SLOT_SUF.filter((suf) => [...worn].some((w) => String(w).endsWith(suf))).length >= 4) {
    await flushEquipRetry();
    return;
  }
  // 1) Équiper la MEILLEURE pièce d'armure en poche par slot (TOUTE matière, jamais downgrade).
  //    ⚠️ L'ancienne boucle ne connaissait QUE ARMOR_PIECES (fer) → un kit DIAMANT fourni restait en
  //    poche, le bot combattait NON ARMURÉ → morts en boucle (vécu live cette nuit : ResBot2 0 armure).
  //    bestArmorToEquip (pur, testé) couvre diamant/netherite/fer/… → on équipe le kit donné.
  //    BOUCLE D'USURE (24/10, armorWear.equipPlan) : la poche est lue AVEC la durabilité et les slots
  //    AVEC leurs pièces usées — jamais une pièce usée ré-enfilée, jamais de fer par-dessus un diamant
  //    usé, jamais de re-équipement d'une pièce déjà en place (586 armor_equipped dans une session).
  const _pocketWithWear = ((bot.inventory && bot.inventory.items()) || [])
    .filter((i) => i && i.name).map((i) => ({ name: i.name, broken: isNearlyBroken(i) }));
  const _occ = _armorOccupants();
  for (const piece of armorEquipPlan(_pocketWithWear, _occ)) {
    const dest = ARMOR_SLOTS[piece.slot];
    noteFail(piece.name, dest, await equipOnce(piece.name, dest, false));
  }
  await flushEquipRetry();
  // Slots où forger du FER est interdit : occupés par du diamant (même usé — la chaîne diamant le
  // reforge en diamant), ou reforgés il y a < 10 min. On les déclare « couverts » pour la forge fer.
  {
    const _now = Date.now(); const _cmap = _armorCraftMap();
    for (const pc of ARMOR_PIECES) {
      const occ = _occ.find((o) => ARMOR_SLOTS[pc.slot] && new RegExp('_' + pc.name.split('_')[1] + '$').test(o.name));
      if ((occ && ironCraftBlocked(occ.name)) || armorRecraftCooling(_cmap, pc.slot, _now)) worn.add(pc.name);
    }
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
        try { sm = await smeltWithFurnace('raw_iron', 'iron_ingot', need); }
        catch (e) { sm = { ok: false, reason: 'threw:' + ((e && e.message) ? String(e.message).slice(0, 60) : 'error') }; }
        // `smeltWithFurnace` normalise désormais son retour (caution.normalizeSmeltResult) et le
        // catch nomme l'exception : le fameux `reason:"?"` (vu en session vivante) n'a plus de
        // chemin pour sortir. Le `|| 'no_result'` reste comme dernier filet, jamais comme point
        // d'interrogation. `got` dit si le four a produit QUELQUE CHOSE (partial vs no_output).
        if (!sm || !sm.ok) emit({ type: 'armor_smelt', ok: false, reason: (sm && sm.reason) || 'no_result', got: (sm && sm.got) || 0, want: need });
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
        _noteArmorCraft(plan.slot);   // jamais deux fois la même pièce en 10 min (armorWear)
        // même helper instrumenté : une pièce FRAÎCHEMENT forgée qui ne s'équipe pas est le même
        // bug (le bot la trimballe au lieu de la porter), et l'échec était muet ici aussi.
        noteFail(plan.craft, ARMOR_SLOTS[plan.slot], await equipOnce(plan.craft, ARMOR_SLOTS[plan.slot], false));
        emit({ type: 'gear_craft', item: plan.craft, ok: true, why: 'armor' });
      }
    } catch (e) {}
    await flushEquipRetry();   // no-op si rien n'a raté
  }
  // 3) Bouclier (anti-projectile) : craft + garde en off-hand.
  const hasShield = ((bot.inventory && bot.inventory.items()) || []).some((i) => i.name === 'shield')
    || worn.has('shield') || (bot.inventory && bot.inventory.slots && bot.inventory.slots[45] && bot.inventory.slots[45].name === 'shield');
  const planks = items().filter((i) => i.name.endsWith('_planks')).reduce((a, i) => a + i.count, 0);
  if (shieldPlan(items(), hasShield)) {
    try {
      const r = await craftSmart({ name: 'shield', count: 1 });
      if (r && r.ok) {
        // idem : équipement instrumenté (un bouclier forgé puis laissé dans le sac = 0 protection).
        const eq = await equipOnce('shield', 'off-hand', false);
        if (eq.ok) emit({ type: 'gear_craft', item: 'shield', ok: true, why: 'armor' });
        else { noteFail('shield', 'off-hand', eq); await flushEquipRetry(); }
      }
    } catch (e) {}
  }
}

// ── Phase B : stock de torches (mob-aware) PROACTIF (hole B — éclairer = moins de mobs = moins de
// morts). Manque de charbon → mine le charbon EXPOSÉ tout proche (≤24, JAMAIS de roaming en plein
// tunnel) ; manque de sticks → en craft depuis les planches du kit. Best-effort, jamais bloquant.
async function ensureTorches(opts = {}) {
  const inv = () => (bot.inventory && bot.inventory.items()) || [];
  const count = (n) => inv().filter((i) => i.name === n).reduce((a, i) => a + i.count, 0);
  if (count('torch') >= 8) return;
  if ((count('coal') + count('charcoal')) < 1) {
    const coalDefs = ['coal_ore', 'deepslate_coal_ore'].map((n) => bot.registry.blocksByName[n]).filter(Boolean);
    if (coalDefs.length && bot.findBlock({ matching: coalDefs.map((b) => b.id), maxDistance: 24 })) {
      try { await gather(bot, { name: ['coal_ore', 'deepslate_coal_ore'], count: 3, explore: false }, taskToken); } catch (e) { /* best-effort */ }
    }
  }
  // CHARBON DE BOIS (run 21/10 soir : 36 poses de torche ratées sur 82 dans le branch-mine, et des tunnels
  // à `light: 0`). Un joueur sans charbon fond UNE bûche avant de descendre : 1 bûche = 1 charbon de bois
  // = 4 torches. Seulement à la demande de l'appelant (hook de descente, en surface) — jamais pendant le
  // tunnel (la fonte immobilise ~10 s) —, avec un four DÉJÀ en poche (on n'en fabrique pas pour ça) et
  // en gardant une bûche pour les planches de combustible.
  if (opts.charcoal && (count('coal') + count('charcoal')) < 1 && count('torch') < 4 && count('furnace') > 0) {
    const logs = {};
    for (const i of inv()) if (i && logBase(i.name)) logs[i.name] = (logs[i.name] || 0) + i.count;
    const top = Object.entries(logs).sort((a, b) => b[1] - a[1])[0];
    if (top && top[1] >= 2) {
      try {
        const r = await smeltWithFurnace(top[0], 'charcoal', 1, undefined, { maxMs: 30000 });
        emit({ type: 'torch_charcoal', log: top[0], ok: !!(r && r.ok), reason: (r && r.reason) || null });
      } catch (e) { /* best-effort */ }
    }
  }
  if (count('stick') < 1) {
    const planks = inv().find((i) => i.name.endsWith('_planks'));
    if (planks) { try { await craftSmart({ name: 'stick', count: 4 }); } catch (e) {} }
  }
  const coalAvail = count('coal') + count('charcoal');
  if (coalAvail < 1 || count('stick') < 1) return; // toujours rien → on mine sans
  // ⚠️ NE JAMAIS demander plus que le charbon dispo (veille 21/10) : la recette veut 1 charbon PAR
  // torche — avec 1-7 charbons (le cas courant en branch-mine, le charbon n'arrive pas par lot de 8),
  // `count: 8` en dur échouait SYSTÉMATIQUEMENT (`no_coal`) et se refaisait à chaque survivalTick
  // (toutes les ~4 paliers) jusqu'à ce que le charbon atteigne 8 — des centaines de craft_fail_ctx
  // inutiles par session de minage. Même borne que le but planner équivalent (index.js, `coalHave`).
  try {
    const r = await craftSmart({ name: 'torch', count: Math.min(8, coalAvail) });
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

// ── ÉQUIPEMENT ÉCLAIR AU RAMASSAGE (cause n°3 des cartographes nus) ─────────────────────────────
// Une pièce donnée par un coéquipier (worker qui lance un plastron au mappeur) tombe au sol
// N'IMPORTE QUAND. Or le bot ne tentait de s'habiller qu'au kit (spawn + 2,5 s) et à l'onPeriodic
// du mappeur (1 arrivée sur 10) : MapBot1 mourait souvent AVANT — d'où `picked_up: iron_chestplate`
// dans ses stats et `armor:0` à la présence. On équipe désormais dans la foulée du ramassage,
// DÉBOUNCÉ (un mineur ramasse des centaines d'items ; une rafale = une seule passe).
let _pickupEquipTimer = null;
function schedulePickupEquip(delayMs = PICKUP_EQUIP_DELAY_MS) {
  if (_pickupEquipTimer) return;                         // débounce : une passe par rafale
  _pickupEquipTimer = setTimeout(() => {
    _pickupEquipTimer = null;
    // ironKeep 0 : s'habiller PRIME sur le buffer fer (l'armure survit aux morts, pas le bot).
    Promise.resolve(ensureArmor({ ironKeep: 0 })).catch(() => {});
  }, delayMs);
  if (_pickupEquipTimer.unref) _pickupEquipTimer.unref();  // ne retient jamais le process
}
/** Pourquoi la pioche ne peut pas être refaite ici (cf. noPick.js). Jamais de throw. */
function noPickStuckWhy() {
  try {
    const items = (bot.inventory && bot.inventory.items()) || [];
    const n = (re) => items.reduce((s, i) => s + (i && re.test(i.name) ? i.count : 0), 0);
    const empty = (bot.inventory && typeof bot.inventory.emptySlotCount === 'function') ? bot.inventory.emptySlotCount() : null;
    return noPickWhy({
      cobble: n(/^(cobblestone|cobbled_deepslate)$/), sticks: n(/^stick$/), planks: n(/_planks$/),
      logs: n(/_log$/), emptySlots: empty, rebuildReason: _lastPickRebuildWhy,
    });
  } catch (e) { return 'unknown'; }
}

// ─── PLAFOND DE REMBLAI (23/10, cf. fillCap.js) ──────────────────────────────────────────────────
// Au ramassage, au-delà de 3 piles de remblai on jette l'excédent vers une case OUVERTE (≤ 1 passe / 20 s).
// ⚠️ NIVEAU MODULE (piège #56) : lus par le handler de ramassage et le timer différé.
let _fillCapAt = 0;
let _fillCapBusy = false;
let _fillCapTimer = null;
let _fillCapDeferAt = 0;   // dernier event fill_cap_deferred (≤ 1 / min)
async function capFillStacks() {
  if (_fillCapBusy || !bot || !bot.inventory) return;
  if (!fillCapDue(Date.now(), _fillCapAt)) return;
  // Jamais au milieu d'un craft (inventaire en cours de manipulation), fenêtre ouverte (four, coffre)
  // ni d'un coup de pioche (se retourner fausserait la face visée → dig_failed) : on attend le suivant.
  if (_craftDepth > 0 || bot.currentWindow || bot.targetDigBlock) return;
  try { if (craftCombatNow()) return; } catch (err) { /* inconnu → on tente */ }   // ne pas tourner le dos à un mob
  // MURÉ DANS SON ABRI (23/10, session 420 : la même liste jetée deux fois à 9 min d'écart) : jeté contre
  // la paroi d'un trou 1×1, l'excédent retombe sur le bot et il le re-ramasse. On attend la sortie (le
  // prochain ramassage relance la passe ; _fillCapAt n'est pas touché pour ne pas la retarder de 20 s).
  if (_shelterInFlight) return;
  const out = fillOverflow(bot.inventory.items() || []);
  if (!out.length) return;
  const e = bot.entity;
  // Jeter VERS une case ouverte sur 2 blocs (fillCap.tossTarget), jamais contre un mur : sinon l'objet
  // rebondit à portée de ramassage. Espace fermé (puits, tunnel 1×1 muré) → on attend d'en sortir.
  let aim = null;
  try {
    aim = tossTarget(e && e.position, (q) => bot.blockAt(vec3Lib(q.x, q.y, q.z)));
  } catch (err) { aim = null; }
  if (!aim) {
    if (Date.now() - _fillCapDeferAt >= 60000) { _fillCapDeferAt = Date.now(); emit({ type: 'fill_cap_deferred', why: 'enclosed' }); }
    return;
  }
  _fillCapBusy = true;
  _fillCapAt = Date.now();
  const yaw = (e && Number.isFinite(e.yaw)) ? e.yaw : 0;
  const pitch = (e && Number.isFinite(e.pitch)) ? e.pitch : 0;
  let turned = false;
  const tossed = [];
  try {
    if (typeof bot.lookAt === 'function') { try { await bot.lookAt(vec3Lib(aim.x, aim.y, aim.z), true); turned = true; } catch (err) {} }
    if (!turned) return;   // sans viser la case libre, jeter = au hasard (contre un mur) : on attend
    for (const it of out) {
      try {
        if (typeof bot.tossStack === 'function') await bot.tossStack(it);
        else await bot.toss(it.type, null, it.count);
        tossed.push(it.name + ':' + it.count);
      } catch (err) { break; }   // case bougée : on reprendra au prochain ramassage
    }
  } finally {
    if (turned) { try { await bot.look(yaw, pitch, true); } catch (err) {} }
    _fillCapBusy = false;
  }
  if (tossed.length) emit({ type: 'fill_capped', tossed, at: { x: Math.round(aim.x), z: Math.round(aim.z) } });
}
function installFillCap() {
  if (!bot || bot._fillCapInstalled) return;
  bot._fillCapInstalled = true;
  bot.on('playerCollect', (collector) => {
    try {
      if (!collector || !bot.entity || collector.id !== bot.entity.id) return;
      if (_fillCapTimer) return;                         // une passe par rafale de ramassages
      _fillCapTimer = setTimeout(() => {
        _fillCapTimer = null;
        Promise.resolve(capFillStacks()).catch(() => {});
      }, 500);
      if (_fillCapTimer.unref) _fillCapTimer.unref();
    } catch (err) { /* un ramassage ne doit JAMAIS casser la boucle du bot */ }
  });
}

function installPickupEquip() {
  if (!bot || bot._pickupEquipInstalled) return;          // idempotent : appelé à chaque ensureArmor
  bot._pickupEquipInstalled = true;                       // et à chaque entrée de startMapper
  bot.on('playerCollect', (collector, collected) => {
    try {
      if (!collector || !bot.entity || collector.id !== bot.entity.id) return;  // ramassage d'un AUTRE joueur
      let name = null;
      try { const it = collected && collected.getDroppedItem && collected.getDroppedItem(); name = it && it.name; }
      catch (e) { /* métadonnées absentes selon la version → fallback ci-dessous */ }
      // Nom indisponible → on pose la question qui compte vraiment, et qui ne coûte qu'un scan
      // d'inventaire : reste-t-il en poche une pièce MEILLEURE que celle portée ?
      const worthIt = name != null
        ? isEquipPickup(name)
        : (() => {
          try {
            const inv = ((bot.inventory && bot.inventory.items()) || []).map((i) => ({ name: i.name, count: i.count, broken: isNearlyBroken(i) }));
            if (armorEquipPlan(inv, _armorOccupants()).length > 0) return true;
            const off = bot.inventory && bot.inventory.slots && bot.inventory.slots[45];
            return !!(inv.some((i) => i.name === 'shield') && (!off || off.name !== 'shield'));
          } catch (e) { return false; }
        })();
      if (worthIt) schedulePickupEquip();
    } catch (e) { /* un ramassage ne doit JAMAIS casser la boucle du bot */ }
  });
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
// Depuis le 19/10 : borné à 60 s au total et compté en points de faim — cf. ensureFood plus bas.
// Stock de COMESTIBLES en poche (FOODS ∪ EMERGENCY_FOODS) — la mesure que lisent le déclencheur de
// quête, la décision de remontée et le back-off stérile. UNE seule définition : trois lectures
// divergentes du même mot (« a-t-il de quoi manger ? ») finiraient par se contredire.
function foodStock() {
  let n = 0;
  try {
    for (const i of ((bot.inventory && bot.inventory.items()) || [])) {
      if (i && (FOODS.has(i.name) || EMERGENCY_FOODS.has(i.name))) n += (i.count || 0);
    }
  } catch (e) { /* best-effort : un inventaire illisible se lit « vide », côté prudent */ }
  return n;
}

// v7 — une seule remontée à la fois (deux appels concurrents d'ensureFood ne doivent pas déclencher
// deux warps). Niveau MODULE, comme `_baseBusy`/`_armorBusy` (piège #56).
let _surfaceTripBusy = false;
let _foodSurfaceTripAt = 0;   // dernière remontée nourriture (lue par foodRunTick pour le retour /home work)
const SURFACE_TRIP_SETTLE_MS = 1500;   // après le warp /home safe, avant la chasse (cf. surfaceTrip)

// ensureFood — ravitaillement BORNÉ À 60 s AU TOTAL (Massii 19/10 : « l'important c'est la VITESSE »).
// Avant : balayage de butin 20 s + remontée 90 s + 3 vagues de 120 s + cuisson + pêche jusqu'à 300 s
// = ~6 min d'un bot qui ne travaille pas. Maintenant (enchaînement dans foodRun.runEnsureFood, testé) :
// sortie anticipée dès 20 points → butin (rayon 10, ≤ 8 s) → remontée /home safe SEULEMENT si sous
// terre, affamé et à sec (< 6 points) → chasse avec ce qui reste du budget (une vague ≤ 45 s, seulement
// si une proie est en vue) → /give hors sans-give. Tout est compté en POINTS DE FAIM (cru et chair
// putréfiée comprises) : un bot qui a 10 chairs ne repart plus chasser.
async function ensureFood() {
  try {
    await runEnsureFood({
      inventory: () => buildCtxInv(bot),
      y: () => (bot.entity && bot.entity.position ? bot.entity.position.y : 64),
      hunger: () => bot.food,
      foodItems: () => foodStock(),
      loot: (o) => lootNearby(o),
      // Une seule remontée à la fois : un appel concurrent ne déclenche pas un 2e warp (il continue
      // simplement vers la chasse avec l'altitude du moment).
      surfaceTrip: async ({ ms, y, food }) => {
        if (_surfaceTripBusy) return;
        _surfaceTripBusy = true;
        try {
          emit({ type: 'food_surface_trip', y: Math.round(y), food });
          // Signet du chantier AVANT de remonter : foodRunTick y renvoie le bot une fois nourri (/home work).
          markWorkBeforeTrip('food');
          _foodSurfaceTripAt = Date.now();
          await withTimeout(safeWarpHome(HOME_SAFE), ms, () => { try { stopMotion(); } catch (e) {} });
          // Laisser arriver le paquet de position du warp : la détection de TP (onTeleport → stopMotion)
          // tombait sinon PENDANT le premier goto de la chasse et l'annulait (`hunt_failed` en 300 ms, 23/10).
          await sleep(SURFACE_TRIP_SETTLE_MS);
        } finally { _surfaceTripBusy = false; }
      },
      hunt: ({ budget }) => huntCookGoal(6, { budget, goalPoints: ENSURE_SKIP_POINTS }),   // même seuil que la sortie anticipée
      canGive: !NO_GIVE,
      give: () => {
        bot.chat('/give ' + bot.username + ' cooked_beef 32');
        emit({ type: 'food_resupply', via: 'give' });
      },
      emit,
    });
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
/**
 * Fuite « tunnel-aware » (module, piège #56 : lue par les réflexes ET les ticks de survie). Dans un couloir
 * souterrain : tenir (armé) ou se murer (tunnelGuard) ; partout ailleurs : fleeFrom, inchangé.
 */
function tunnelAwareFlee(b) {
  if (skeletonAwareFlee(b, 'tunnel_flee')) return true;
  return tunnelFlee(b || bot, { fleeFrom, emit, stopMotion: () => stopMotion(), eat, withTimeout });
}

// ─── RÉPONSE AU SQUELETTE (22/10, skeletonResponse.js) ─────────────────────────────────────────────
// Mesure live (chrono « de zéro », Hard) : 4 morts de mineurs sur 6 en 12 min = « shot by Skeleton ».
// Signatures : `aura_hit {skeleton, dist:2.8}` → `fight_refused low_hp` → `reflex flee` → mort ;
// `take_cover ok` → `survival flee` → mort ; `death_camp_flee via:foot` à 1,5 PV. Toute fuite d'un
// mineur passe désormais par skeletonAwareFlee : face à un tireur en vue sans mêlée collée, on fonce
// (rush, zigzag) ou on casse la ligne de vue (cover = un pas derrière un coin, block = muret) et on
// RESTE derrière ; la fuite (ranged-aware de fleeFrom) n'est plus qu'un dernier recours.
// État lu par les réflexes, les ticks de survie et le disjoncteur → NIVEAU MODULE (piège #56).
const SKEL_HOLD_MS = 3000;        // après un couvert réussi : on ne se laisse pas tirer hors de l'abri
const SKEL_RUSH_MS = 6000;        // charge bornée (le disjoncteur est suspendu pendant ce temps)
const SKEL_COVER_GOTO_MS = 2500;
const SKEL_RANGE = 16;
let _skelBusy = false;            // une seule réponse à la fois
let _skelHoldUntil = 0;           // fin de la tenue derrière le couvert
let _pvpAttackRaw = null;         // pvp.attack d'origine (avant la porte du disjoncteur)
let _skelHurtAt = -Infinity;      // dernier PV perdu avec un squelette à portée (démenti d'un « caché »)
let _skelHurtWired = false;
let _skelLastHp = null;
let _skelHpDropAt = -Infinity;    // dernière baisse de PV, quelle qu'en soit la source (verrou de repas)
let _skelEatDeferredAt = -Infinity;
const SKEL_HURT_MS = 2500;

/** Un item est-il de la nourriture ? (le verrou de repas ne touche jamais une arme, un bloc, un bouclier) */
function _skelIsFood(item) {
  const n = item && item.name;
  return !!n && (FOODS.has(n) || EMERGENCY_FOODS.has(n));
}

/**
 * VERROU DE REPAS PENDANT LA CHARGE (23/10 : 3 `reflex eat` en 3,5 s de rush, épée rengainée, 9 PV
 * perdus, squelette vivant). Tous les mangeurs (réflexe, filet de faim, survie, low_hp_recover, skills)
 * passent par `bot.equip(nourriture, 'hand')` : c'est là qu'on diffère, une seule fois pour tous.
 * Rend true si l'equip est permis.
 */
function skeletonEquipAllowed(item, dest) {
  // OUTIL / TORCHE d'un autre timer pendant la charge (24/10, `rearmed: 13`) : chaque changement d'objet en
  // main remet le délai d'attaque à zéro — refusé tant que la charge court (les blocs de survie passent).
  if (_skelRushBusy && rushEquipBlocked({ rushing: true, itemName: item && item.name, dest: dest || 'hand', weaponName: _skelRushWeapon })) {
    const now = Date.now();
    if (now - _skelRushEquipBlockedAt >= 2000) {
      _skelRushEquipBlockedAt = now;
      let by = null;
      try { by = callerFromStack(new Error().stack, ['skeletonEquipAllowed', 'skeletonGuardedEquip']); } catch (e) { by = null; }
      emit({ type: 'rush_equip_blocked', item: item && item.name, by });
    }
    return false;
  }
  if (!_skelRushBusy || dest !== 'hand' || !_skelIsFood(item)) return true;
  const now = Date.now();
  const hpFalling = now >= _skelHpDropAt && now - _skelHpDropAt < SKEL_HURT_MS;
  if (eatDuringRush({ rushing: true, food: bot.food, hpFalling })) return true;
  if (now - _skelEatDeferredAt >= 2000) {
    _skelEatDeferredAt = now;
    emit({ type: 'eat_deferred', why: 'skeleton_rush', food: bot.food, hp: Math.round((bot.health || 0) * 10) / 10, hpFalling });
  }
  return false;
}

/** blockAt du monde pour shooterSees/findCoverCell (bloc mineflayer : boundingBox + shapes). */
function _skelBlockAt(q) { return bot.blockAt(vec3Lib(q.x, q.y, q.z)); }

/** Le tireur voit-il le bot ? Collider précis, depuis SON œil ; erreur → vu (jamais un faux « caché »). */
function skeletonSees(shooter) {
  const me = bot.entity && bot.entity.position;
  if (!me || !shooter || !shooter.position) return true;
  return shooterSees({ shooter: { x: shooter.position.x, y: shooter.position.y, z: shooter.position.z },
    target: { x: me.x, y: me.y, z: me.z }, blockAt: _skelBlockAt });
}

/** Une flèche vient-elle de démentir le couvert ? (PV perdus il y a < 2,5 s, squelette à portée) */
function skeletonHurtRecently(now) {
  const t = Number.isFinite(now) ? now : Date.now();
  return t >= _skelHurtAt && t - _skelHurtAt < SKEL_HURT_MS;
}

/** Écoute `health` une fois par process : une baisse de PV avec un tireur à ≤ 16 blocs date le « touché ». */
function wireSkeletonHurt() {
  if (_skelHurtWired) return false;
  _skelHurtWired = true;
  _skelLastHp = bot.health;
  bot.on('health', () => {
    try {
      const hp = bot.health;
      const dropped = typeof hp === 'number' && typeof _skelLastHp === 'number' && hp < _skelLastHp;
      _skelLastHp = hp;
      if (!dropped) return;
      _skelHpDropAt = Date.now();
      const me = bot.entity && bot.entity.position;
      if (!me) return;
      const near = Object.values(bot.entities || {}).some((e) => e && e.position && RANGED.has(e.name)
        && Math.hypot(e.position.x - me.x, e.position.y - me.y, e.position.z - me.z) <= SKEL_RANGE);
      if (near) _skelHurtAt = Date.now();
    } catch (e) { /* diag : jamais bloquant */ }
  });
  if (typeof bot.equip === 'function') {
    const origEquip = bot.equip;
    bot.equip = function skeletonGuardedEquip(item, dest) {
      let ok = true;
      try { ok = skeletonEquipAllowed(item, dest); } catch (e) { ok = true; }
      if (!ok) return Promise.reject(new Error(_skelIsFood(item) ? 'eat_deferred:skeleton_rush' : 'equip_blocked:skeleton_rush'));
      return origEquip.apply(this, arguments);
    };
  }
  // Rengainer l'arme (equipCached sans outil adapté fait `unequip('hand')`) pendant la charge : même refus.
  if (typeof bot.unequip === 'function') {
    const origUnequip = bot.unequip;
    bot.unequip = function skeletonGuardedUnequip(dest) {
      if (_skelRushBusy && (dest || 'hand') === 'hand') return Promise.reject(new Error('equip_blocked:skeleton_rush'));
      return origUnequip.apply(this, arguments);
    };
  }
  return true;
}

/**
 * Un chemin de survie VITAL reprend la main (23/10) : la charge sur squelette est annulée SUR-LE-CHAMP
 * (garde levée, verrou de but rendu, combat coupé) — sa boucle conclura `preempted` par `by`.
 * Rend true si une charge courait.
 */
function skeletonRushYield(by) {
  if (!_skelRushBusy) return false;
  _skelRushYieldBy = by || 'vital';
  _skelRushBusy = false;
  try { if (_creeperHold.owner === 'skeleton_rush') releaseGoalHold(_creeperHold); } catch (e) {}
  try { if (bot.pvp && bot.pvp.target) bot.pvp.stop(); } catch (e) {}
  return true;
}

/** Danger vital qui prime sur tout squelette : 'lava' (dedans ou à ≤ 2 blocs) | 'fire' | null. */
function skeletonVitalHazard() {
  const ent = bot.entity;
  if (!ent) return null;
  if (ent.isInLava) return 'lava';
  try {
    const flags = ent.metadata && ent.metadata[0];
    if (typeof flags === 'number' && (flags & 0x01)) return 'fire';
  } catch (e) {}
  try { if (lavaNearby(bot, 2)) return 'lava'; } catch (e) {}
  return null;
}

/** escapeWater (noyade, aquifère) : chemin vital — annule une charge sur squelette, puis nage. */
function escapeWater(b, o) {
  skeletonRushYield('escape_water');
  return _escapeWaterRaw(b, o);
}

/** Situation « squelette » : tireur en portée sans mêlée collée ni creeper proche. null sinon. */
function skeletonSituation(hint) {
  if (IS_MAPPER) return null;     // les cartographes gardent leur fuite par défaut (preferFlee)
  if (skeletonVitalHazard()) return null;   // lave / feu : la fuite de survie historique garde la main
  const me = bot.entity && bot.entity.position;
  if (!me) return null;
  const self = { x: me.x, y: me.y, z: me.z };   // position MUTÉE en place : copie
  const d = (e) => Math.hypot(e.position.x - self.x, e.position.y - self.y, e.position.z - self.z);
  let shooter = null, shooters = 0, meleeOthers = 0, creeper = false;
  for (const e of Object.values(bot.entities || {})) {
    if (!e || !e.position || e === bot.entity) continue;
    if (e.type !== 'mob' && e.type !== 'hostile') continue;
    const dist = d(e);
    if (!Number.isFinite(dist)) continue;
    if (RANGED.has(e.name)) {
      if (dist > SKEL_RANGE) continue;
      shooters++;
      if (!shooter || dist < d(shooter)) shooter = e;
    } else if (e.name === 'creeper') {
      if (dist <= 7) creeper = true;
    } else if (isFleeHostile(e) && dist <= 5) {
      meleeOthers++;
    }
  }
  if (hint && hint.position && RANGED.has(hint.name) && d(hint) <= SKEL_RANGE) shooter = hint;
  if (!shooter || creeper) return null;
  return { shooter, dist: d(shooter), los: skeletonSees(shooter), shooters, meleeOthers, self };
}

function _skelWeapon() {
  try { return bestWeapon(bot); } catch (e) { return null; }
}
function _skelShield() {
  return ((bot.inventory && bot.inventory.items()) || []).find((i) => i.name === 'shield') || null;
}
async function _skelShieldUp(shooter, ms) {
  const sh = _skelShield();
  if (!sh) return false;
  try {
    const off = bot.inventory && bot.inventory.slots && bot.inventory.slots[45];
    if (!off || off.name !== 'shield') await bot.equip(sh, 'off-hand');
    if (shooter && shooter.position) {
      await bot.lookAt(shooter.position.offset(0, 1.5, 0), true);
    }
    bot.activateItem(true);
    setTimeout(() => { try { bot.deactivateItem(); } catch (e) {} }, ms);
    return true;
  } catch (e) { emit({ type: 'skeleton_shield_failed', err: String((e && e.message) || e).slice(0, 120) }); return false; }
}

async function _skelRush(shooter) {
  const raw = _pvpAttackRaw || (bot.pvp && bot.pvp.attack && bot.pvp.attack.bind(bot.pvp));
  if (!raw) return false;
  const t0 = Date.now();
  try { _fightBreaker.grant({ t: t0, ms: SKEL_RUSH_MS }); } catch (e) {}
  // PRÉEMPTION PROPRE (23/10) : la charge prend le jeton de tâche — le skill du planner en vol voit
  // `token.cancelled` et rend la main au lieu de relancer un goto/stopMotion qui coupe le combat ; le
  // planner est relancé à la fin (même patron que fleeDeathCamp).
  const prevTask = taskCtl.active;
  // CHARGES ENCHAÎNÉES (24/10) : la charge précédente attend encore de relancer le planner (son jeton va
  // être annulé par notre begin) → on hérite de sa dette, sinon plus personne ne le rallume.
  const owesPlanner = rushResumesPlanner({ prevTask, outerOwes: _skelRushOwesPlanner || _skelPlannerPending });
  if (prevTask === 'skeleton_rush') emit({ type: 'skeleton_rush_chained', owes: owesPlanner });
  _skelRushOwesPlanner = owesPlanner;
  let tok = null;
  try { tok = taskCtl.begin('skeleton_rush', () => {}); } catch (e) { tok = null; }
  _skelRushBusy = true;
  _skelRushYieldBy = null;
  _skelRushBlocked = { stops: 0, by: null };
  _skelPlannerPending = false;
  let lostBy = null;
  const pvp = bot.pvp;
  const origStop = pvp && pvp.stop;
  const origForce = pvp && pvp.forceStop;
  // Qui coupe le combat ? (diag `by`) — on laisse passer l'appel, on note l'appelant.
  if (pvp && typeof origStop === 'function') {
    pvp.stop = function () { if (!lostBy) lostBy = callerFromStack(new Error().stack, ['pvp.stop', 'Object.stop', 'PVP.']) || 'pvp.stop'; return origStop.apply(this, arguments); };
  }
  if (pvp && typeof origForce === 'function') {
    pvp.forceStop = function () { if (!lostBy) lostBy = callerFromStack(new Error().stack, ['forceStop', 'PVP.']) || 'pvp.forceStop'; return origForce.apply(this, arguments); };
  }
  let side = null;
  let zz = null;
  let endReason = 'timeout';
  let rearmed = 0;
  let lastRearmAt = -Infinity;
  const w = _skelWeapon();
  _skelRushWeapon = w ? w.name : null;
  try {
    const sh = _skelShield();
    if (sh) { try { const off = bot.inventory.slots[45]; if (!off || off.name !== 'shield') await bot.equip(sh, 'off-hand'); } catch (e) {} }
    if (w) { try { await bot.equip(w, 'hand'); } catch (e) {} }
    try { await raw(shooter); }
    catch (e) { emit({ type: 'skeleton_rush_failed', err: String((e && e.message) || e).slice(0, 120) }); endReason = 'target_lost'; lostBy = 'attack_failed'; return false; }
    // Le GoalFollow de pvp est posé : verrou de but (le planner, un goto ou un setGoal(null) étranger
    // sont ignorés jusqu'à la fin de la charge — goalHold, même mécanisme que la fuite creeper).
    try { holdGoal(_creeperHold, t0 + SKEL_RUSH_MS, 'skeleton_rush'); } catch (e) {}
    // ZIGZAG : un squelette vise la position COURANTE — un pas latéral alterné à l'approche fait rater
    // la flèche en vol. Seulement tant qu'on n'est pas au contact (au contact, on frappe droit).
    zz = setInterval(() => {
      try {
        const me = bot.entity && bot.entity.position;
        const alive = shooter && shooter.isValid !== false && bot.entities && bot.entities[shooter.id];
        if (!alive || !me || Date.now() - t0 > SKEL_RUSH_MS) return;
        const far = Math.hypot(shooter.position.x - me.x, shooter.position.z - me.z) > 3;
        let want = far && bot.entity.onGround ? zigzagSide(Date.now() - t0, 400) : null;
        // ⚠️ PAS LATÉRAL DANS LA LAVE (23/10 : « tried to swim in lava to escape Skeleton ») : le pas de
        // zigzag est un contrôle brut, sans pathfinder — rien ne l'empêchait de sortir du couloir vers
        // une mare. Case latérale (ou son sol, ou ce qu'il y a sous un sol vide) en lave/feu → pas de pas,
        // on charge droit (le GoalFollow de pvp, lui, passe par la Movements gardée).
        if (want) {
          let hz = null;
          try { hz = lavaGuard.lateralHazard((q) => bot.blockAt(q), me, bot.entity.yaw, want); } catch (e) { hz = null; }
          if (hz) { lavaAvoided('zigzag', me, { hazard: hz, side: want }); want = null; }
        }
        if (want !== side) {
          if (side) bot.setControlState(side, false);
          if (want) bot.setControlState(want, true);
          side = want;
        }
      } catch (e) { /* best-effort */ }
    }, 100);
    for (;;) {
      await sleep(250);
      const me = bot.entity && bot.entity.position;
      const alive = !!(shooter && shooter.isValid !== false && bot.entities && bot.entities[shooter.id]);
      const dist = (me && shooter && shooter.position)
        ? Math.hypot(shooter.position.x - me.x, shooter.position.y - me.y, shooter.position.z - me.z) : null;
      if (_skelRushYieldBy) { endReason = 'preempted'; break; }
      const hazard = skeletonVitalHazard();
      if (hazard) { skeletonRushYield(hazard); endReason = 'preempted'; break; }
      const why = rushStopReason({ elapsedMs: Date.now() - t0, maxMs: SKEL_RUSH_MS, alive,
        targetOurs: !!(bot.pvp && bot.pvp.target === shooter), cancelled: !!(tok && tok.cancelled),
        hp: bot.health, dist });
      if (why) { endReason = why; break; }
      // Un creeper ou une mêlée arrive pendant la charge : elle cède la main (stopMotion n'est
      // bloqué que tant qu'elle court — la fuite creeper / la logique de mêlée doivent pouvoir agir).
      if (alive) {
        let sit = null;
        try { sit = skeletonSituation(shooter); } catch (e) { sit = null; }
        if (!sit || sit.meleeOthers > 0) { endReason = 'preempted'; lostBy = sit ? 'melee_mix' : 'creeper'; break; }
      }
      // ÉPÉE EN MAIN : un repas (permis) ou un equip étranger l'a rengainée → on la remet. L'Item est RELU
      // (son `slot` change quand l'equip le déplace en barre rapide ; l'objet capturé au départ ferait
      // basculer en main ce qui occupe son ANCIEN slot — ping-pong `rearmed: 13`, 24/10) et au plus 1×/s.
      if (w && rushRearmWanted({ heldName: bot.heldItem ? bot.heldItem.name : null, weaponName: w.name,
        usingHeldItem: !!bot.usingHeldItem, now: Date.now(), lastRearmAt })) {
        lastRearmAt = Date.now();
        const wNow = ((bot.inventory && bot.inventory.items()) || []).find((i) => i && i.name === w.name);
        if (wNow) { try { await bot.equip(wNow, 'hand'); rearmed++; } catch (e) {} }
      }
    }
  } finally {
    if (zz) clearInterval(zz);
    _skelRushWeapon = null;
    try { if (side) bot.setControlState(side, false); } catch (e) {}
    if (pvp) { if (origStop) pvp.stop = origStop; if (origForce) pvp.forceStop = origForce; }
    try { if (_creeperHold.owner === 'skeleton_rush') releaseGoalHold(_creeperHold); } catch (e) {}
    _skelRushBusy = false;
    try { if (bot.pvp && bot.pvp.target === shooter) bot.pvp.stop(); } catch (e) {}
    let by;
    if (endReason === 'preempted') {
      by = _skelRushYieldBy || ((lostBy === 'creeper' || lostBy === 'melee_mix') ? lostBy : (taskCtl.active || 'cancel'));
    }
    else if (endReason === 'target_lost') by = lostBy || 'pvp_range';
    _skelRushYieldBy = null;
    const ev = { type: 'skeleton_rush_done', killed: endReason === 'killed', endReason, took_ms: Date.now() - t0,
      hp: Math.round((bot.health || 0) * 10) / 10 };
    if (by) ev.by = by;
    if (_skelRushBlocked.stops) { ev.blocked_stops = _skelRushBlocked.stops; ev.blocked_by = _skelRushBlocked.by; }
    if (rearmed) ev.rearmed = rearmed;
    emit(ev);
    // Rendre la main : relancer le planner qu'on a préempté (ou qui a voulu repartir pendant la charge).
    if (tok && !tok.cancelled) {
      const wasPlanner = owesPlanner || _skelPlannerPending;   // migration coupée : le planner la reprendra
      _skelPlannerPending = false;
      if (wasPlanner) {
        _skelRushOwesPlanner = true;   // jusqu'à la relance effective (restartPlannerAfterFlee l'éteint)
        restartPlannerAfterFlee(tok, 'autonomous', 'skeleton_rush_planner_restart')
          .then((ok) => { if (!ok && !tok.cancelled) { try { taskCtl.cancel(); } catch (e) {} } })
          .catch((e) => emit({ type: 'error', message: String((e && e.message) || e) }));
      } else {
        _skelRushOwesPlanner = false;
        try { taskCtl.cancel(); } catch (e) {}
      }
    }
  }
  return true;
}

async function _skelCover(cell, shooter) {
  try { stopMotion(); } catch (e) {}
  if (cell) {
    try {
      await withTimeout(bot.pathfinder.goto(new pfGoals.GoalBlock(cell.x, cell.y, cell.z)), SKEL_COVER_GOTO_MS,
        () => { try { stopMotion(); } catch (e) {} });
    } catch (e) { /* vérifié ci-dessous par la ligne de vue */ }
  }
  _skelHoldUntil = Date.now() + SKEL_HOLD_MS;
  await _skelShieldUp(shooter, 2000);
  return !skeletonSees(shooter);
}

/**
 * Réponse au squelette (fire-and-forget). `from` = qui appelle (flee | riposte | ranged | defensive |
 * survival | fight_refused | fight_abort | death_camp | tunnel_flee). Rend la décision prise (ou null).
 */
function skeletonRespond(hint, from) {
  const sit = skeletonSituation(hint);
  if (!sit) return null;
  if (sit.meleeOthers > 0) {
    // mêlée collée (zombie, araignée…) : la logique historique (tunnel, disjoncteur, fuite) garde la
    // main — et une charge en cours sur le squelette est lâchée, sinon elle tirerait le bot dans ses bras.
    if (_skelBusy) { try { if (bot.pvp && bot.pvp.target === sit.shooter) bot.pvp.stop(); } catch (e) {} }
    return null;
  }
  if (_skelBusy) return { action: 'busy' };
  const hurt = skeletonHurtRecently();
  // déjà caché : on ne bouge pas — sauf si une flèche vient de prouver le contraire, ou s'il est collé
  if (Date.now() < _skelHoldUntil && !sit.los && !hurt && sit.dist > 3.5) return { action: 'hold' };
  let inWater = false;
  try { inWater = isInWater(bot); } catch (e) {}
  const cell = (!inWater && (sit.los || hurt)) ? findCoverCell({
    from: sit.self, shooter: sit.shooter.position,
    isSolid: (x, y, z) => { const b = bot.blockAt(vec3Lib(x, y, z)); return !!(b && b.boundingBox === 'block'); },
    blockAt: _skelBlockAt,
  }) : null;
  const dec = decideSkeletonResponse({
    dist: sit.dist, los: sit.los, health: bot.health,
    armorPoints: armorPoints(bot), attackDamage: attackDamage(bot), hasShield: !!_skelShield(),
    hasBlock: !!pickCoverBlock(bot), meleeOthers: sit.meleeOthers, shooters: sit.shooters,
    inWater, coverCell: !!cell, hurt,
  });
  emit({ type: 'skeleton_response', action: dec.action, reason: dec.reason, from, mob: sit.shooter.name,
    hp: Math.round((bot.health || 0) * 10) / 10, dist: Math.round(sit.dist * 10) / 10, los: !!sit.los,
    hurt, shooters: sit.shooters });
  if (dec.action === 'flee') {
    try { fleeFrom(bot); } catch (e) { emit({ type: 'skeleton_flee_failed', err: String((e && e.message) || e).slice(0, 120) }); }
    return dec;
  }
  _skelBusy = true;
  (async () => {
    const shooter = sit.shooter;
    if (dec.action === 'rush') {
      await _skelRush(shooter);
    } else if (dec.action === 'cover') {
      if (dec.reason === 'no_los') {
        // déjà hors de vue : s'arrêter là (la fuite nous ferait ressortir dans son champ)
        try { stopMotion(); } catch (e) {}
        _skelHoldUntil = Date.now() + SKEL_HOLD_MS;
      } else {
        const hidden = await _skelCover(cell, shooter);
        if (!hidden) {
          // la case n'a pas suffi (il a bougé, chemin raté) → muret sur place
          const r = await withTimeout(takeCover(bot, shooter), 3000, () => { try { stopMotion(); } catch (e) {} });
          emit({ type: 'take_cover', mob: shooter.name, from: 'skeleton_cover', placed: (r && r.placed) || 0, ok: !!(r && r.ok), ...coverWhy(r) });
          if (r && r.ok) _skelHoldUntil = Date.now() + SKEL_HOLD_MS;
        }
      }
    } else if (dec.action === 'block') {
      try { stopMotion(); } catch (e) {}
      const r = await withTimeout(takeCover(bot, shooter), 3000, () => { try { stopMotion(); } catch (e) {} });
      emit({ type: 'take_cover', mob: shooter.name, from: 'skeleton_block', placed: (r && r.placed) || 0, ok: !!(r && r.ok), ...coverWhy(r) });
      if (r && r.ok) {
        _skelHoldUntil = Date.now() + SKEL_HOLD_MS;
        await _skelShieldUp(shooter, 2000);
      } else {
        // rien à poser / refusé : le rush reste meilleur que courir devant lui s'il est proche
        const again = decideSkeletonResponse({ dist: sit.dist, los: true, health: bot.health,
          armorPoints: armorPoints(bot), attackDamage: attackDamage(bot), hasShield: !!_skelShield(),
          hasBlock: false, meleeOthers: 0, shooters: sit.shooters, inWater: false, coverCell: false });
        emit({ type: 'skeleton_response', action: again.action, reason: 'block_failed', from, mob: shooter.name,
          hp: Math.round((bot.health || 0) * 10) / 10, dist: Math.round(sit.dist * 10) / 10, los: true, shooters: sit.shooters });
        if (again.action === 'rush') await _skelRush(shooter);
        else { try { fleeFrom(bot); } catch (e) {} }
      }
    }
  })().catch((e) => emit({ type: 'skeleton_response_error', err: String((e && e.message) || e).slice(0, 160) }))
    .finally(() => { _skelBusy = false; });
  return dec;
}

/**
 * Porte de toute fuite d'un mineur : face à un squelette, la réponse squelette prend la main (rend
 * true, la fuite est « traitée ») ; sinon false et l'appelant fuit comme avant.
 */
function skeletonAwareFlee(b, from) {
  if (b && b !== bot) return false;
  let dec = null;
  try { dec = skeletonRespond(null, from || 'flee'); }
  catch (e) { emit({ type: 'skeleton_response_error', err: String((e && e.message) || e).slice(0, 160) }); return false; }
  if (!dec) return false;
  return true;   // y compris 'flee' : fleeFrom (ranged-aware) a déjà été lancé par skeletonRespond
}

/** fleeFrom avec la porte squelette devant (survie, disjoncteur). Même contrat : true si une fuite/réponse part. */
function skeletonFirstFlee(b, from = 'survival') {
  if (skeletonAwareFlee(b, from)) return true;
  return fleeFrom(b || bot);
}

// ─── BRANCH-MINE FER EN LACETS : reprise au FRONT (22/10, chrono world_oct22) ──────────────────────
// Mesure : NethBot3, 10 appels d'iron_deep en 29 min, TOUS repartis à < 25 blocs du même point (le
// home work posé en bas de l'escalier) avec un cap tiré du regard → il re-creusait sa propre zone.
// Un joueur revient au BOUT de sa mine. À la fin de chaque appel qui a avancé : l'état des lacets et
// la position du front vont dans le mémo base (fusion, survit aux morts/process neufs), et le home
// work est re-posé AU FRONT (sec, profond, déplacé de ≥ 8 blocs). Au départ suivant, si le bot est au
// front (lawnResume : ≤ 8 blocs, même couche, < 6 h), le tracé reprend là où il s'était arrêté.
const IRON_LAWN_WORK_MOVE = 8;

/** État des lacets à reprendre (ou null = nouveau tracé depuis le regard). */
function ironLawnStart() {
  try {
    const p = bot.entity && bot.entity.position;
    if (!p) return null;
    const st = loadBaseState() || {};
    return lawnMine.lawnResume(st.ironLawn, { x: p.x, y: p.y, z: p.z }, Date.now());
  } catch (e) { return null; }
}

/** Fin d'un appel : mémorise front + état ; re-pose `work` au front s'il a bougé. */
function ironLawnEnd(r) {
  const p = bot.entity && bot.entity.position;
  if (!p || !r || !r.lawn) return false;
  const front = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
  const st = loadBaseState() || {};
  saveBaseState(Object.assign({}, st, { ironLawn: { state: r.lawn, x: front.x, y: front.y, z: front.z, at: Date.now() } }));
  if (!NO_GIVE || !r.ok || isLumberjackObjective() || front.y > 20) return true;
  try { if (isInWater(bot)) return true; } catch (e) { return true; }
  const moved = !_workPos || Math.hypot(front.x - _workPos.x, front.z - _workPos.z) >= IRON_LAWN_WORK_MOVE;
  if (moved && homewarp.bookmark(bot, HOME_WORK)) {
    _workSet = true; _workPos = _botXZ();
    emit({ type: 'work_bookmarked', ctx: 'lawn_front', x: front.x, y: front.y, z: front.z });
  }
  return true;
}

async function branchSurvivalTick() {
  try { await survivalTick(bot, { fleeFrom: tunnelAwareFlee, emit, ...fightGateDeps() }); } catch (e) {}
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
      await tossJunkBehind(bot);
      emit({ type: 'branch_cleanup', empty: bot.inventory.emptySlotCount() });
    }
  } catch (e) { /* best-effort : jamais bloquer la branche */ }
  // ensureTorches mine du charbon proche (gather/collectBlock) → borné, sinon il pourrait geler
  // la branche (le hook tourne DANS la boucle, hors de la détection de stall en tête de boucle).
  try { await withTimeout(ensureTorches(), 30000, () => { try { stopMotion(); } catch (e) {} }); } catch (e) {}
  // FONDRE EN MINANT (21/10) : poser le four, le charger, continuer de creuser, repasser au retour.
  try { await withTimeout(furnaceJobTick(), 60000, () => { try { stopMotion(); } catch (e) {} }); } catch (e) {}
  // CUIRE LA VIANDE au fond de la mine (23/10) — APRÈS le four de fer : s'il vient de partir avec le four,
  // la viande attend (la fonte du fer est prioritaire). Sans marcher (four en poche ou ≤ 4 blocs).
  try { await cookMeatLot('mine', { walk: false }); } catch (e) {}
}

// Survie LÉGÈRE pendant la DESCENTE diagonale (bug review #7) : combat/fuite + manger UNIQUEMENT —
// SURTOUT PAS ensureTorches (miner du charbon via gather déplacerait le bot et désalignerait
// l'escalier 1×2 → digs hors range au palier suivant). La descente Y64→-58 dure plusieurs minutes
// pendant lesquelles seuls les réflexes event-driven protégeaient le bot.
async function descentSurvivalTick() {
  try { await survivalTick(bot, { fleeFrom: tunnelAwareFlee, emit, ...fightGateDeps() }); } catch (e) {}
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
let _pickRecoveryRun = null;   // la promesse de l'expédition EN VOL (partagée par les appels concurrents)
// BOUCLE CHAUDE `gift_pick unknown` ×3-4 dans la même ms (20/10, NethBot2 sessions 288/295/306/312) :
// après une mort, l'expédition de la vie précédente tourne encore (explore_waypoint continue) ; le planner
// neuf appelait recoverPickaxe, la garde rendait {ok:false} SANS raison en < 1 ms → `unknown`, et la garde
// anti-boucle-chaude du planner ne freine qu'à partir du 3e tour instantané. On ATTEND désormais
// l'expédition en vol (son vrai résultat, sa vraie raison) au lieu de rendre un échec muet.
async function recoverPickaxe() {
  if (_pickRecovering && _pickRecoveryRun) {
    emit({ type: 'pick_recovery_join' });
    try {
      const r = await _pickRecoveryRun;
      if (bestPickTier() >= 0) return { ok: true };
      return (r && r.reason) ? r : { ok: false, reason: 'pick_recovery:in_flight_failed' };
    } catch (e) { return { ok: false, reason: 'pick_recovery:in_flight_error' }; }
  }
  if (_pickRecovering) return bestPickTier() >= 0 ? { ok: true } : { ok: false, reason: 'pick_recovery:in_flight' };
  _pickRecovering = true;
  _pickRecoveryRun = _recoverPickaxeInner();
  try {
    return await _pickRecoveryRun;
  } finally { _pickRecovering = false; _pickRecoveryRun = null; }
}

/** Planches → bâtons → pioche avec ce qui est en poche (après une livraison du bûcheron). */
async function _craftPickFromPocket() {
  try {
    const log = ((bot.inventory && bot.inventory.items()) || []).find((i) => i.name.endsWith('_log'));
    if (log) await craftItem(bot, { name: log.name.replace('_log', '_planks'), count: 3 });
    await craftSmart({ name: 'stick', count: 4 });
    await craftSmart({ name: 'stone_pickaxe', count: 1 });
    if (bestPickTier() < 0) await craftSmart({ name: 'wooden_pickaxe', count: 1 });
  } catch (e) { /* best-effort */ }
  return bestPickTier() >= 0;
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
  // BÛCHERON D'ÉQUIPE (20/10) : bois insuffisant pour bâtons + table → le demander et attendre AU CHANTIER
  // (≤ 4 min) au lieu de remonter explorer une zone rasée. null = pas de bûcheron / timeout → expédition.
  {
    const iv = _invAt();
    const short = woodShortForFailure({ reason: 'no_sticks', goalName: 'stone_pickaxe',
      inv: buildCtxInv(bot), hasTable: !!_nearestTable(bot) });
    if (short && !IS_MAPPER && !isLumberjackObjective()) {
      const w = await woodWaitStep({ name: 'pick_recovery', skill: 'gatherLog', args: { count: 16 } }, 'pick_recovery');
      if (w && w.ok === false && w.reason === 'cancelled') return { ok: false, reason: 'cancelled' };
      if (w && w.ok && await _craftPickFromPocket()) return { ok: true };
      if (taskToken.cancelled) return { ok: false, reason: 'cancelled' };
      if (w) emit({ type: 'pick_recovery_wood_short', logs: iv.logs, planks: iv.planks });
    }
  }
  const pp = bot.entity && bot.entity.position;
  const p0 = pp ? { x: Math.floor(pp.x), y: Math.floor(pp.y), z: Math.floor(pp.z) } : null;
  emit({ type: 'pick_recovery_trip', from: p0 });
  // SANS-GIVE : /spreadplayers (relocateToRegion) est BLOQUÉ → on marque le chantier puis on monte au
  // spawn sûr (surface avec arbres) par /home safe. Retour au chantier par /home work (cf. plus bas).
  if (NO_GIVE) {
    if (p0) { homewarp.bookmark(bot, HOME_WORK); emit({ type: 'work_bookmarked', ctx: 'pick_recovery', x: p0.x, y: p0.y, z: p0.z }); }
    // Home campé (veto, 19/10) → pas de /home : on cherche le bois depuis ici (gather explore).
    if (homewarp.goSpawn(bot, { ctx: 'pick_recovery' })) await sleep(3500);
  } else {
    await relocateToRegion({ forest: true });
  }
  if (taskToken.cancelled) return { ok: false };
  const logNames = Object.keys((bot.registry && bot.registry.blocksByName) || {}).filter((n) => n.endsWith('_log'));
  // `danger` (21/10, NethBot2+MapBot2) : sans lui explore() ne peut jamais couper tôt — les réflexes
  // de survie (fleeFrom/creeperTick) coupent son pathfinder en boucle ("goal was changed before it
  // could be completed!" sur les 6 waypoints en <100ms, explore_summary stuck:true) au lieu de laisser
  // le bot se cacher, comme gatherWoodSafely le fait déjà pour le chemin gatherLog normal.
  try { await withTimeout(gather(bot, { name: logNames, count: 4, explore: true, danger: () => !!woodThreatNow() }, taskToken), 240000, () => { try { stopMotion(); } catch (e) {} }); } catch (e) {}
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
      if (why === 'lava_ahead' || why === 'water_ahead' || why === 'air_at_y_-50' || why === 'drop_ahead' || why === 'no_progress') {
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
    torchEvery: TORCH_EVERY,                // 24/10 : l'espacement (torches.js) décide, plus la cadence 4
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
// ── ESCALIER DE REPLI (20/10, NethBot1 emmuré à (-43,40,-340) sans home, jam_loop de session en session) ─
// Quand aucun /home ne sort le bot (home absent, campé, ou posé dans la poche elle-même), il creuse un
// escalier 1×2 vers la surface (skills/digOut.js : outil adapté, fluide → autre direction, 4 directions,
// borné 90 s). Préempte le planner comme switchLumberjack (jeton CAPTURÉ, attente du skill en vol) puis
// le relance. Sous terre seulement : en surface sans home, le watchdog NO_GIVE re-pose `safe` tout seul.
let _digOutBusy = false;      // lu par le jam-watchdog (timer) → niveau module (piège #56)
let _digOutFailAt = 0;        // dernier échec : pas de re-tentative en rafale à chaque relocate
const DIG_OUT_RETRY_MS = 180000;

/** Lance l'escalier si le bot est SOUS TERRE et pas dehors (fire-and-forget). true si lancé. */
function kickDigOut(why) {
  try {
    const p = bot.entity && bot.entity.position;
    if (!p || _digOutBusy || _migrating) return false;
    if (!(p.y < SAFE_HOME_MIN_Y)) return false;
    if (why !== 'jam_loop_repeat' && Date.now() - _digOutFailAt < DIG_OUT_RETRY_MS) return false;
    try { if (isInWater(bot)) return false; } catch (e) { /* lecture ratée : on tente */ }
    const pos = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
    const read = (x, y, z) => { try { return bot.blockAt(vec3Lib(x, y, z)); } catch (e) { return null; } };
    if (digOutIsOutside(read, pos, { minY: SAFE_HOME_MIN_Y })) return false;
    digOutAndResume(why).catch((e) => emit({ type: 'error', message: String((e && e.message) || e) }));
    return true;
  } catch (e) { return false; }
}

async function digOutAndResume(why) {
  if (_digOutBusy || _migrating) return null;
  _digOutBusy = true;
  const t0 = Date.now();
  try {
    const tok = taskCtl.begin('dig_out', stopMotion);
    const w0 = Date.now();
    while ((_skillInFlight > 0 || _autoRunners > 0) && !tok.cancelled && Date.now() - w0 < MIGRATION_PREEMPT_WAIT_MS) {
      await sleep(250);
    }
    if (tok.cancelled) return null;
    taskToken = tok;
    try { stopMotion(); } catch (e) {}
    const p0 = bot.entity && bot.entity.position;
    const from = p0 ? { x: Math.round(p0.x), y: Math.round(p0.y), z: Math.round(p0.z) } : null;
    const r = await digOutSkill(bot, { maxMs: DIG_OUT_MAX_MS, minY: SAFE_HOME_MIN_Y }, tok);
    emit({ type: 'dig_out', ok: !!r.ok, why, dir: r.dir || null, steps: r.steps || 0,
      took_s: Math.round((Date.now() - t0) / 1000), reason: r.ok ? undefined : r.reason, from });
    if (r.ok) {
      _jamEsc = null; _jamSample = null;
      try { saveBaseState(jamLoopCleared(loadBaseState())); } catch (e) { /* best-effort */ }
    } else {
      _digOutFailAt = Date.now();
    }
    if (!tok.cancelled && world.objective && world.objective.status === 'in_progress') {
      startAutonomous(null).catch((e) => emit({ type: 'error', message: String((e && e.message) || e) }));
    }
    return r;
  } finally { _digOutBusy = false; }
}

// ── SORTIE DE PUITS (live 25/10, NethBot3 : 15+ min au fond de son abri, 4 côtés pleins sur 2 de haut,
// unjam / unjam_relocate en boucle au même endroit, chasses `arrived:false`). Le pathfinder ne sort pas
// d'un trou fermé : au 1er jam ESCALADÉ (3e unjam au même endroit) et si le bot est bien au fond d'un
// puits, on joue la même sortie que l'abri (skills/shelter.escapePit : pilier retenté puis escalier),
// au lieu du relocate. 2 échecs d'affilée → l'escalade d'origine reprend la main (relocate, jam_loop).
let _pitEscapeBusy = false;   // lu par le jam-watchdog (timer) → niveau module (piège #56)
let _pitEscapeFails = 0;      // échecs consécutifs : au-delà de PIT_ESCAPE_MAX_FAILS on rend la main
const PIT_ESCAPE_MAX_FAILS = 2;

/** Le bot est-il au fond d'un trou fermé sur 4 côtés et 2 de haut ? (lecture best-effort) */
function stuckInPitNow() {
  try {
    const p = bot.entity && bot.entity.position;
    if (!p) return false;
    const feet = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
    const read = (x, y, z) => { try { return bot.blockAt(vec3Lib(x, y, z)); } catch (e) { return null; } };
    return shelterInPit(read, feet);
  } catch (e) { return false; }
}

async function pitEscapeAndResume(why) {
  if (_pitEscapeBusy || _digOutBusy || _migrating) return null;
  _pitEscapeBusy = true;
  const t0 = Date.now();
  try {
    const tok = taskCtl.begin('pit_escape', stopMotion);
    const w0 = Date.now();
    while ((_skillInFlight > 0 || _autoRunners > 0) && !tok.cancelled && Date.now() - w0 < MIGRATION_PREEMPT_WAIT_MS) {
      await sleep(250);
    }
    if (tok.cancelled) return null;
    taskToken = tok;
    try { stopMotion(); } catch (e) {}
    const p0 = bot.entity && bot.entity.position;
    const from = p0 ? { x: Math.floor(p0.x), y: Math.floor(p0.y), z: Math.floor(p0.z) } : null;
    const r = await escapePit(bot, tok, { emit, sleep });
    emit({ type: 'pit_escape', why, ok: !!r.escaped, escaped: !!r.escaped, placed: r.placed || 0,
      pillars: r.pillars || 0, stairs: r.stairs || 0, reason: r.escaped ? undefined : r.reason, from,
      took_s: Math.round((Date.now() - t0) / 1000) });
    if (r.escaped) { _pitEscapeFails = 0; _jamEsc = null; _jamSample = null; }
    else _pitEscapeFails += 1;
    if (!tok.cancelled && world.objective && world.objective.status === 'in_progress') {
      startAutonomous(null).catch((e) => emit({ type: 'error', message: String((e && e.message) || e) }));
    }
    return r;
  } finally { _pitEscapeBusy = false; }
}

let _relocSeq = Math.floor(Math.random() * 997);   // graine par process : pas la même 1re cellule à chaque respawn
async function relocateToRegion(opts = {}) {
  // SANS-GIVE (catch-all) : relocateToRegion est PUREMENT /spreadplayers → BLOQUÉ par nogive →
  // no-op silencieux = bot FIGÉ (death_camp, floating_relocate, kit-forest…). On route TOUS les
  // modes vers /home safe (surface sûre). Perd le ciblage forêt/cluster (inopérant en sans-give de
  // toute façon) mais un bot à la surface sèche >>> un bot gelé. Les appelants water/pick gèrent
  // déjà leur propre goSpawn en amont (ce guard couvre le reste).
  if (NO_GIVE) {
    // HOME CAMPÉ (19/10) : pas d'aller simple vers le camp — on reste sur place (le veto le trace).
    // 20/10 : « rester sur place » emmuré, c'est la boucle jam_loop de NethBot1 → escalier de repli.
    if (safeHomeVeto('relocate')) { kickDigOut('home_camped'); return; }
    // Home `safe` inexistant côté serveur (20/10) : le /home ne partira nulle part — escalier direct.
    if (safeHomeKnownMissing()) { kickDigOut('no_home'); return; }
    emit({ type: 'relocate_home_safe', mode: opts.forest ? 'forest' : (opts.nearSpawn ? 'near_spawn' : 'default') });
    try { stopMotion(); } catch (e) {}
    const _rp = bot.entity && bot.entity.position;
    const _from = _rp ? { x: _rp.x, y: _rp.y, z: _rp.z } : null;   // COPIE : position mutée en place
    if (homewarp.goSpawn(bot, { ctx: 'relocate' })) await sleep(3000);
    // Le /home n'a sorti le bot de nulle part (home absent, refusé, ou posé dans la poche elle-même) :
    // un relocate qui ne déplace pas est un échec → escalier vers la surface.
    const _rp2 = bot.entity && bot.entity.position;
    if (_from && _rp2 && Math.hypot(_rp2.x - _from.x, _rp2.y - _from.y, _rp2.z - _from.z) < 8) {
      kickDigOut(safeHomeKnownMissing() ? 'no_home' : 'relocate_no_move');
    }
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
    if (NO_GIVE && _anchorSet) { await safeWarpHome(CONFINE_HOME, { ctx: 'relocate_confine' }); return; }
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
        // `wet` reste INCONDITIONNEL (anti-noyade) ; l'exigence « exposé » tombe sous --xray 1 :
        // un cluster de diamants ENTERRÉS devient une destination de relocate valable.
        if (!o || (!XRAY && !o.exposed) || o.wet || !String(o.material || '').includes('diamond')) continue;  // jamais un cluster NOYÉ (H7+)
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

// ─── ÉVASION D'UN SPAWNPOINT CAMPÉ (anti-camping, refonte sans-give) ─────────────────────────────
// Vécu world_mn15 (NethBot3, 02:50→02:51) : un squelette campe le point de réapparition ; le bot
// respawne, est abattu avant d'avoir agi, ré-ancre son /spawnpoint AU MÊME ENDROIT, recommence —
// 4 morts en 36 s, 26 sur la session.
//
// L'ancien secours faisait `relocateToRegion()` PUIS `/spawnpoint`. Or relocateToRegion est
// PUREMENT un `/spreadplayers`, BLOQUÉ par nogive : en sans-give le déplacement était un no-op
// silencieux et il ne restait que le ré-ancrage… qui CIMENTAIT le piège à chaque tour.
//
// Fallback « vrai joueur » : on COURT (30-60 blocs, à l'opposé du campeur), et on ne repose le
// respawn QUE si on est effectivement arrivé au calme. Fuite ratée ⇒ aucun ré-ancrage (garder
// l'ancien spawnpoint est moins pire que d'en poser un neuf sous le nez d'un archer).
// ⚠️ Fonction de NIVEAU MODULE (piège #56 : une garde déclarée dans onSpawn et lue ailleurs
// compile, passe les tests, et tue le process au 1er tick).
const ESCAPE_WALK_TIMEOUT_MS = 20000;   // la fuite est prioritaire mais BORNÉE : le planner attend
const ESCAPE_THREAT_POLL_MS = 500;      // relevé du danger pendant la course (cf. « MENACE EN ROUTE »)
const CAMP_ESCAPE_WALK_TIMEOUT_MS = 30000;   // 48-64 blocs au sprint ≈ 10-15 s (+ obstacles)
async function escapeDeathCamp(opts = {}) {
  // MODE CAMP DE RÉAPPARITION (23/10, respawnEscape.js) : ≥ 48 blocs, on ne s'arrête PAS au premier zombie
  // (le camp en a toujours un à 4 blocs : s'arrêter = se terrer DANS le camp), et le /spawnpoint n'est
  // reposé que par le tick de ré-ancrage (campReanchorTick), loin du camp, au sol plein, au calme.
  const campMode = !!(opts && opts.camp && Number.isFinite(opts.camp.x));
  const p0 = bot.entity && bot.entity.position;
  // ⚠️ COPIE IMMÉDIATE : `bot.entity.position` est un Vec3 MUTÉ EN PLACE par mineflayer — garder la
  // référence ferait « bouger » le point de départ avec le bot, et la distance parcourue mesurée
  // après la fuite vaudrait toujours 0 (fuite réussie jugée ratée, jamais de ré-ancrage).
  const start = p0 ? { x: p0.x, y: p0.y, z: p0.z } : null;
  const threat = (() => {
    try { return bot.nearestEntity((e) => e && e.position && isFleeHostile(e)); } catch (e) { return null; }
  })();
  const plan = escapePlan({
    noGive: NO_GIVE,
    pos: start,
    hostile: threat && threat.position,
    ...(campMode ? { minDist: respawnEscape.CAMP_ESCAPE_MIN_DIST, maxDist: respawnEscape.CAMP_ESCAPE_MAX_DIST } : {}),
  });
  if (!plan) { emit({ type: 'death_camp_escape', mode: 'none' }); return { escaped: false }; }

  if (plan.mode === 'warp') {
    // ADMIN (mappeurs, serveurs de test) : /spreadplayers marche vraiment → comportement HISTORIQUE.
    emit({ type: 'death_camp_escape', mode: 'warp' });
    try { await relocateToRegion(); } catch (e) { /* best-effort */ }
    anchorSpawnpoint('camp_warp');       // veto si l'arrivée est elle-même campée
    return { escaped: true };
  }

  emit({
    type: 'death_camp_escape', mode: 'walk',
    x: plan.x, z: plan.z, dist: Math.round(plan.dist), hostile: !!threat,
  });
  // La fuite PRIME : on coupe ce qui traîne (une tâche de la vie précédente peut encore tenir le
  // pathfinder) et on part. Les réflexes de survie, eux, restent branchés (timers indépendants) —
  // seuls les TP automatiques (confine, squad) sont suspendus le temps de la course.
  const gen = ++_escapeGen;
  _escaping = true;
  try { taskCtl.cancel(); } catch (e) {}
  try { stopMotion(); } catch (e) {}
  // GoalNearXZ : l'altitude est libre — n'importe quelle sortie fait l'affaire quand on fuit
  // (et un but concret a une heuristique positive/décroissante : A* fini, borné par
  // applyPathfinderBounds — JAMAIS de GoalInvert ici, piège #48/OOM du 25/07).
  // MENACE EN ROUTE (run 10, 20/10) : 168 fuites ratées sur 181 — le bot nu courait 40-50 blocs sous les
  // flèches jusqu'au bout. Un danger qui surgit pendant la course (nu + hostile ≤ 12, spawnDangerNow)
  // COUPE la fuite : l'appelant (guardSpawn) se terre aussitôt. Armuré : spawnDangerNow rend null → inchangé.
  let enRoute = null;
  const watch = setInterval(() => {
    if (enRoute || campMode) return;   // camp : courir est la réponse, pas se terrer sur place
    const d = spawnDangerNow();
    if (d) { enRoute = d; try { stopMotion(); } catch (e) {} }
  }, ESCAPE_THREAT_POLL_MS);
  try {
    try { if (campMode && typeof bot.setControlState === 'function') bot.setControlState('sprint', true); } catch (e) {}
    await withTimeout(bot.pathfinder.goto(new pfGoals.GoalNearXZ(plan.x, plan.z, 4)),
      campMode ? CAMP_ESCAPE_WALK_TIMEOUT_MS : ESCAPE_WALK_TIMEOUT_MS, () => { try { stopMotion(); } catch (e) {} });
  } catch (e) { /* NoPath/annulation : c'est la distance PARCOURUE qui tranche, pas ce retour */ }
  // JAMAIS coincé à true (un flag busy figé gèlerait les 2 TP) — mais on ne relâche que si
  // personne n'a pris la main entre-temps, sinon on éteindrait la garde d'une fuite VIVANTE.
  finally { clearInterval(watch); if (gen === _escapeGen) _escaping = false; }
  if (gen !== _escapeGen) { emit({ type: 'death_camp_escape_superseded' }); return { escaped: false }; }
  if (enRoute) {
    emit({ type: 'death_camp_escape_threat', mob: enRoute.mob, dist: Math.round(enRoute.dist * 10) / 10 });
    return { escaped: false, threat: enRoute };
  }

  const p1 = bot.entity && bot.entity.position;
  if (campMode) {
    const camp = opts.camp;
    const d = p1 ? Math.hypot(p1.x - camp.x, p1.z - camp.z) : 0;
    const out = d >= respawnEscape.CAMP_ESCAPE_MIN_DIST;
    emit({ type: 'respawn_camp_escape', via: 'foot', escaped: out, dist: Math.round(d), camp: { x: camp.x, z: camp.z } });
    return { escaped: out, campMode: true };
  }
  const escaped = escapeReached(start, p1 && { x: p1.x, y: p1.y, z: p1.z });
  let nearestHostileDist = null;
  try {
    const near = nearbyHostiles(bot, ESCAPE_SAFE_RADIUS);
    if (near.length && p1) {
      nearestHostileDist = near.reduce((m, e) => Math.min(m, e.position.distanceTo(p1)), Infinity);
    }
  } catch (e) { nearestHostileDist = null; }

  if (canReanchorSpawn({ escaped, nearestHostileDist })) {
    if (anchorSpawnpoint('camp_escape')) emit({ type: 'death_camp_reanchor', x: Math.round(p1.x), z: Math.round(p1.z) });
  } else {
    // Pas d'ancrage : on ne fige RIEN dans une zone qu'on n'a pas su quitter proprement.
    emit({
      type: 'death_camp_escape_failed', escaped,
      hostileDist: nearestHostileDist == null ? null : Math.round(nearestHostileDist),
    });
  }
  return { escaped };
}

// ─── FUITE DÈS LE SPAWN, SANS ATTENDRE DE MOURIR (live 19/10, MapBot1) ───────────────────────────
// Journal serveur MESURÉ (cartographe non-op, sans lit) : login 17:47:20 sous la canopée du spawn
// (les zombies n'y brûlent pas de jour) → mort à :25, :32, :37, :54 → death_loop → relance → même
// spawn → 4 morts de plus. L'évasion ci-dessus ne s'armait QU'APRÈS des morts : chaque génération en
// perdait 2-3 avant de seulement penser à courir. Un humain VOIT les zombies au login et part.
// La décision est PURE (unstuck.spawnDanger : nu + hostile ≤ 12 blocs) ; ici, la seule glue.
// ⚠️ Fonctions de NIVEAU MODULE (piège #56), comme escapeDeathCamp.

/**
 * LE prédicat « hostile à craindre » — UNE définition pour la fuite au spawn (spawnDangerNow) ET
 * l'attente de l'aube dans l'abri (hostilesNearNow) : deux lectures du même mot finiraient par se
 * contredire. MÊME prédicat que `escapeDeathCamp` (isFleeHostile : kind OU nom listé), MOINS les
 * neutres (enderman : jamais une raison de fuir tant qu'on ne le regarde pas — cf. nearbyHostiles)
 * et les entités retirées du monde (isValid:false).
 */
function isThreatHostile(e) {
  if (!e || e.isValid === false || !isFleeHostile(e) || NEUTRAL_NO_PROVOKE.has(e.name)) return false;
  if (e.name !== 'creeper') return true;
  // CREEPER (AltoClef, 20/10) : une menace SEULEMENT s'il gonfle à ≤ 7 blocs (creeper.js) — un creeper
  // calme n'est pas une raison de fuir, se terrer ou lâcher un but (le tick creeper l'écarte s'il colle).
  const p = bot && bot.entity && bot.entity.position;
  return creeperIsThreat(e, p ? { x: p.x, y: p.y, z: p.z } : null);
}

/**
 * Le bot est-il en danger visible MAINTENANT ? null sinon, la décision de spawnDanger sinon.
 * Jamais de throw : on est dans le chemin du spawn.
 */
function spawnDangerNow() {
  try {
    const pos = bot.entity && bot.entity.position;
    if (!pos) return null;
    const d = spawnDanger({
      worn: _wornArmor().size,   // pièces PORTÉES (usées exclues) : 0 si l'inventaire n'est pas encore livré → prudent
      pos,
      entities: Object.values(bot.entities || {}),
      isHostile: isThreatHostile,
    });
    return d.flee ? d : null;
  } catch (e) { return null; }
}

/**
 * Combien d'hostiles à craindre à ≤ 12 blocs (SPAWN_DANGER_RADIUS, 3D) ? C'est le relevé que l'abri
 * (shelterUntilDawn, étape 3bis) relit toutes les 3 s pendant qu'il attend la fin des monstres de la
 * nuit. Relu à chaque appel, jamais mis en cache. Jamais de throw : un relevé qui plante vaut « 0 »
 * (le bot ne reste pas coincé dans son trou sur une erreur de lecture).
 */
function hostilesNearNow() {
  try {
    const pos = bot.entity && bot.entity.position;
    if (!pos) return 0;
    return hostilesWithin({
      pos,
      entities: Object.values(bot.entities || {}),
      isHostile: isThreatHostile,
    }).length;
  } catch (e) { return 0; }
}

// ─── SORTIE D'ABRI SÛRE (fix 20/10 — 9 morts juste après `shelter:out` en 1 h) ─────────────────────
// La décision est PURE (skills/shelter.dawnExitPlan : heure ∈ [0, 11500], aucun hostile non-creeper EN VUE
// à ≤ 16, aucun creeper à ≤ 10 ; tranches de 10 s, borne 180 s). Ici, la glue : le relevé injecté
// (`exitThreats`) et le geste à la sortie (`onExit` : s'éloigner d'abord des hostiles en vue — sous une
// canopée, zombies et squelettes ne brûlent pas). ⚠️ NIVEAU MODULE (piège #56).
const DAWN_EXIT_HOSTILE_RADIUS = 16;
const DAWN_EXIT_CREEPER_RADIUS = 10;
const DAWN_EXIT_AWAY_KEEP = 16;        // à la sortie : se placer à 16 blocs du barycentre des menaces
const DAWN_EXIT_AWAY_HOLD_MS = 5000;   // le planner ne reprend la main qu'après 5 s (goalHold)

/**
 * Point de vue de la SORTIE de l'abri : le bot est au fond de sa cellule, d'où il ne voit rien (toit,
 * parois) — on lit la ligne de vue depuis le dessus du toit (1er bloc plein surmonté d'air, 2 à 5 blocs
 * au-dessus des pieds), sinon depuis ses yeux. Plus haut = voit PLUS = prudent.
 */
function _shelterExitEye(self) {
  const x = Math.floor(self.x), z = Math.floor(self.z), y0 = Math.floor(self.y);
  try {
    for (let dy = 2; dy <= 5; dy++) {
      const b = bot.blockAt(vec3Lib(x, y0 + dy, z));
      const a = bot.blockAt(vec3Lib(x, y0 + dy + 1, z));
      if (b && b.boundingBox === 'block' && (!a || a.boundingBox !== 'block')) return { x: self.x, y: y0 + dy + 1 + 1.62, z: self.z };
    }
  } catch (e) { /* lecture ratée → yeux du bot */ }
  return { x: self.x, y: self.y + 1.62, z: self.z };
}

/** Menaces de sortie vues depuis `eye` : hostiles non-creeper en vue à ≤ 16, creepers à ≤ 10 (vus ou non). */
function _exitThreatList(self, eye) {
  const out = [];
  for (const e of Object.values(bot.entities || {})) {
    if (!e || e.isValid === false || !e.position) continue;
    if (!isFleeHostile(e) || NEUTRAL_NO_PROVOKE.has(e.name)) continue;
    const d = Math.hypot(e.position.x - self.x, e.position.y - self.y, e.position.z - self.z);
    if (e.name === 'creeper') { if (d <= DAWN_EXIT_CREEPER_RADIUS) out.push({ e, d, creeper: true }); continue; }
    if (d > DAWN_EXIT_HOSTILE_RADIUS) continue;
    const h = Number.isFinite(e.height) ? e.height * 0.8 : 1.5;
    const to = { x: e.position.x, y: e.position.y + h, z: e.position.z };
    if (hasLineOfSight(eye, to, (q) => bot.blockAt(vec3Lib(q.x, q.y, q.z)))) out.push({ e, d, creeper: false });
  }
  return out;
}

/** Relevé injecté dans shelterUntilDawn (`exitThreats`). Jamais de throw : 0/0 sur erreur. */
function dawnExitThreatsNow() {
  try {
    const p = bot.entity && bot.entity.position;
    if (!p) return { hostiles: 0, creepers: 0 };
    const self = { x: p.x, y: p.y, z: p.z };   // COPIE (Vec3 muté en place)
    const list = _exitThreatList(self, _shelterExitEye(self));
    return { hostiles: list.filter((t) => !t.creeper).length, creepers: list.filter((t) => t.creeper).length };
  } catch (e) { return { hostiles: 0, creepers: 0 }; }
}

/** À la sortie (`onExit`) : menaces en vue → s'en éloigner d'abord, but verrouillé 5 s. Jamais de throw. */
function exitAwayFromThreats() {
  try {
    const p = bot.entity && bot.entity.position;
    if (!p) return;
    const self = { x: p.x, y: p.y, z: p.z };
    const list = _exitThreatList(self, { x: self.x, y: self.y + 1.62, z: self.z });
    if (!list.length) return;
    const c = { x: 0, z: 0 };
    for (const t of list) { c.x += t.e.position.x / list.length; c.z += t.e.position.z / list.length; }
    const dest = creeperAwayPoint(self, { x: c.x, y: self.y, z: c.z }, DAWN_EXIT_AWAY_KEEP);
    if (!dest) return;
    holdGoal(_creeperHold, Date.now() + DAWN_EXIT_AWAY_HOLD_MS, 'dawn_exit');
    holdSetGoal(bot.pathfinder, _creeperHold, new pfGoals.GoalNearXZ(dest.x, dest.z, 2), false);
    emit({ type: 'dawn_exit_away', n: list.length, nearest: Math.round(Math.min(...list.map((t) => t.d)) * 10) / 10 });
  } catch (e) { /* best-effort */ }
}

// ─── LES PREMIÈRES SECONDES APRÈS UN RESPAWN : SE TERRER, PAS COURIR (run 10, 20/10) ──────────────
// Mesuré (10 h, 263 vies d'ouvrier) : 74 morts < 30 s après un respawn, dont 58 après une fuite À PIED
// (168 fuites ratées sur 181, 93 %) ; les vies où la cellule d'abri s'est fermée vivent 600 s en médiane
// (1 mort < 30 s sur 102). Et `spawn_danger_flee` n'a JAMAIS été émis : à l'event `spawn` les entités ne
// sont pas encore arrivées (1re réaction à un hostile : < 1 s dans 5 vies, < 4 s dans 98) — d'où une
// courte FENÊTRE d'observation, puis la règle pure unstuck.spawnGuardPlan :
//   'hide'   → s'enterrer TOUT DE SUITE (puits de 3 + toit, ~3-6 s) et attendre que la zone se vide
//              (borné 90 s ; de nuit, l'abri attend l'aube comme la discipline de nuit) ;
//   'escape' → la fuite à pied d'avant (de jour, rien en vue) — désormais COUPÉE dès qu'un danger surgit
//              en route, et suivie d'un abri ;
//   'none'   → rien.
// ⚠️ Fonctions et constantes de NIVEAU MODULE (piège #56), comme escapeDeathCamp.
const SPAWN_SENSE_MS = 4000;          // fenêtre d'observation après le spawn (98/263 menaces vues < 4 s)
const SPAWN_SENSE_STEP_MS = 400;
const THREAT_HIDE_MAX_MS = 90000;     // borne de l'attente « zone vide » (règle de vitesse du propriétaire)
const WOOD_HIDE_MAX_MS = 60000;       // bois : on attend moins, la récolte reprend vite
const WOOD_HIDE_WINDOW_MS = 90000;    // …et plus AUCUN repli commencé après 90 s : un abri dure ≤ ~80 s, on finit
                                      // donc avant le garde-fou du skill (SKILL_TIMEOUTS.gatherLog = 180 s) — sinon
                                      // le planner enchaînerait une autre tâche pendant que le bot est au fond du trou.

// ─── FUIR D'ABORD, CREUSER ENSUITE (fix 20/10, respawnFlee.js) ───────────────────────────────────
// 14 morts < 30 s après un respawn en 2 h 30, 11 de NethBot3 en boucle : spawn_guard hide avec un zombie
// à 0,3-6 blocs → `shelter dig_in` → immobile 3-10 s → mort avant la fin du puits (no_fall/void_below).
// hideFromThreat sprinte donc d'abord (but XZ verrouillé par goalHold, jamais 3D — piège #72b) tant qu'un
// hostile est à ≤ 8 blocs, au plus 2 jambes de 8 s, puis creuse. Pendant la fuite l'aura ne frappe que si
// le bot est COINCÉ (un coup casse le sprint). ⚠️ NIVEAU MODULE (piège #56) : lu par auraTick.
let _respawnFlee = null;   // { stuck } pendant une fuite d'avant-abri

/** Positions (COPIES) des hostiles à craindre. Jamais de throw. */
function respawnThreatsNow() {
  const out = [];
  try {
    for (const e of Object.values(bot.entities || {})) {
      if (!e || !e.position || !isThreatHostile(e)) continue;
      out.push({ x: e.position.x, y: e.position.y, z: e.position.z, ranged: RANGED.has(e.name) });
    }
  } catch (e) { /* lecture ratée → rien */ }
  return out;
}

/** Sprinte loin des menaces proches avant de se terrer. Rend true si une fuite a eu lieu. Jamais de throw. */
async function fleeBeforeHide(why) {
  let fled = false;
  try {
    for (let leg = 0; leg < RESPAWN_FLEE_LEGS; leg++) {
      if (_meleePillar) break;          // le timer du pilier a pris la main (grappe au contact)
      const p = bot.entity && bot.entity.position;
      if (!p) break;
      const plan = respawnFleePlan({ self: { x: p.x, y: p.y, z: p.z }, threats: respawnThreatsNow() });
      if (!plan) break;
      fled = true;
      emit({ type: 'respawn_flee', why, hostiles: plan.hostiles, dist: plan.dist, leg: leg + 1, to: plan.dest });
      _respawnFlee = { stuck: false };
      try { if (bot.pvp && typeof bot.pvp.stop === 'function') bot.pvp.stop(); } catch (e) {}
      const t0 = Date.now();
      holdGoal(_creeperHold, t0 + RESPAWN_FLEE_LEG_MS, 'respawn_flee');
      holdSetGoal(bot.pathfinder, _creeperHold, new pfGoals.GoalNearXZ(plan.dest.x, plan.dest.z, 2), false);
      try { if (typeof bot.setControlState === 'function') bot.setControlState('sprint', true); } catch (e) {}
      let sample = { x: p.x, z: p.z, t: t0 };
      while (Date.now() - t0 < RESPAWN_FLEE_LEG_MS) {
        await sleep(300);
        const q = bot.entity && bot.entity.position;
        if (!q || bot.health == null || bot.health <= 0) break;
        if (_meleePillar) break;
        if (Math.hypot(q.x - plan.dest.x, q.z - plan.dest.z) <= 3) break;
        if (!respawnFleePlan({ self: { x: q.x, y: q.y, z: q.z }, threats: respawnThreatsNow() })) break;
        const now = Date.now();
        _respawnFlee.stuck = fleeStuck(sample, q, now);
        if (now - sample.t >= RESPAWN_STUCK_MS) sample = { x: q.x, z: q.z, t: now };
      }
      if (_creeperHold.owner === 'respawn_flee') releaseGoalHold(_creeperHold);
    }
  } catch (e) { /* best-effort : on se terre de toute façon */ }
  finally {
    _respawnFlee = null;
    if (_creeperHold.owner === 'respawn_flee') releaseGoalHold(_creeperHold);
  }
  if (fled) {
    const left = (() => { try { const q = bot.entity.position; return respawnFleePlan({ self: { x: q.x, y: q.y, z: q.z }, threats: respawnThreatsNow() }); } catch (e) { return null; } })();
    emit({ type: 'respawn_flee_done', why, clear: !left, dist: left ? left.dist : null });
  }
  return fled;
}

/** Observe le danger pendant SPAWN_SENSE_MS (sort dès qu'il est vu). null si rien. Jamais de throw. */
async function senseSpawnDanger() {
  const t0 = Date.now();
  for (;;) {
    const d = spawnDangerNow();
    if (d) return d;
    if (Date.now() - t0 >= SPAWN_SENSE_MS) return null;
    await sleep(SPAWN_SENSE_STEP_MS);
  }
}

/**
 * S'enterrer face à une menace (puits de 3 + toit) et attendre que la zone se vide, BORNÉ. Réutilise
 * shelterUntilDawn : de jour la boucle de nuit est sautée et seule l'attente « hostiles ≤ 12 blocs »
 * (étape 3bis, borne `maxWaitMs`) tient le bot dans son trou ; de nuit il attend l'aube (discipline de
 * nuit, bot nu). UN SEUL abri à la fois : un abri en cours est REJOINT (comme maybeNightShelter).
 * Jeton PROPRE (le global taskToken peut être celui, annulé, de la vie précédente) ; `withTimeout`
 * n'annulant rien, le dépassement ANNULE ce jeton lui-même.
 * @returns {{ok:boolean, reason?:string, joined?:boolean}}
 */
async function hideFromThreat(why, danger, opts = {}) {
  if (_shelterInFlight) {
    try { await _shelterInFlight; } catch (e) { /* l'abri en cours a ses propres garde-fous */ }
    return { ok: true, joined: true };
  }
  const maxWaitMs = Number.isFinite(opts.maxWaitMs) ? opts.maxWaitMs : THREAT_HIDE_MAX_MS;
  // GRAPPE DE MÊLÉE AU CONTACT (live 22/10, NethBot3 : 4 zombies à 0,5-1,7 bloc) : ni la fuite (coincé) ni
  // le puits (pas le temps de le creuser) — le pilier, tout de suite. Raté (pas de bloc, pose ratée) → l'abri d'avant.
  if (!opts.noPillar) {
    const pp = meleePillarPlanNow();
    if (pp.act === 'pillar') {
      const r = await meleePillarRun(why, pp);
      if (r.ok) return { ok: true, pillar: true };
      danger = spawnDangerNow() || danger;
    }
  }
  // Un hostile à ≤ 8 blocs : creuser sur place = mourir pendant le creusage. On sprinte d'abord.
  if (!opts.noFlee && await fleeBeforeHide(why)) {
    if (_shelterInFlight) {             // un abri a démarré pendant la fuite → on le rejoint
      try { await _shelterInFlight; } catch (e) {}
      return { ok: true, joined: true };
    }
    danger = spawnDangerNow() || danger;
  }
  const night = !!(bot.time && bot.time.timeOfDay != null && isNight(bot));
  const t0 = Date.now();
  const tok = { cancelled: false };
  _shelterTok = tok;              // watchdog du planner : cet abri-là aussi est annulable
  _shelterStartedAt = t0;
  emit({
    type: 'threat_hide', why, night,
    mob: (danger && danger.mob) || null,
    dist: (danger && Number.isFinite(danger.dist)) ? Math.round(danger.dist * 10) / 10 : null,
  });
  lastShelterT = t0;      // l'abri nocturne ne relance pas un 2e trou dans la foulée
  let res = null;
  const run = (async () => {
    _stillBusy = true;    // terré : immobilité légitime (pas un desync)
    try {
      res = await withTimeout(shelterUntilDawn(bot, tok, {
        emit, hostilesNear: hostilesNearNow, worn: () => _wornArmor().size,
        exitThreats: dawnExitThreatsNow, onExit: exitAwayFromThreats,   // sortie sûre (fix 20/10)
        dawnWaitMaxMs: maxWaitMs, endWhenDisplaced: () => nightLockdownNow(),
      }), (night ? 13 * 60 * 1000 : 0) + maxWaitMs + 20000,
      () => { tok.cancelled = true; try { stopMotion(); } catch (e) {} });
    } finally { _stillBusy = false; }
  })();
  _shelterInFlight = run;
  try { await run; } finally {
    if (_shelterInFlight === run) _shelterInFlight = null;
    if (_shelterTok === tok) _shelterTok = null;
  }
  const out = res || { ok: false, reason: 'error' };
  emit({ type: 'threat_hide_done', why, ok: !!out.ok, reason: out.reason || null, took_s: Math.round((Date.now() - t0) / 1000) });
  return out;
}

/**
 * Au spawn : observe, décide (spawnGuardPlan), agit. UNE décision par spawn : `_escapeOnSpawn` est
 * CONSOMMÉ ici quelle que soit la branche (une nouvelle rafale de morts le ré-armera).
 * Attendu (await) par onSpawn : base, dette de mort, regroupement et planner attendent sa fin — sinon le
 * bot repartirait travailler à portée d'arc.
 */
async function guardSpawn() {
  // POINT DE RÉAPPARITION CAMPÉ (23/10) : /tpa chez un coéquipier armé AVANT tout le reste (pas
  // d'observation de 4 s, pas d'abri dans le camp). Personne → fuite à pied ≥ 48 blocs, sans abri d'abord.
  const rescue = await respawnCampRescue();
  if (rescue && rescue.via === 'tpa') {
    _escapeOnSpawn = false;
    return { act: 'tpa', reason: 'respawn_camped', campRescue: true };
  }
  if (rescue && rescue.via === 'foot') {
    _escapeOnSpawn = false;
    emit({ type: 'spawn_guard', act: 'escape', reason: 'respawn_camped', armed: true, worn: (() => { try { return _wornArmor().size; } catch (e) { return 0; } })() });
    let rf = null;
    try { rf = await escapeDeathCamp({ camp: rescue.camp }); } catch (e) { rf = null; }
    if (!(rf && rf.escaped)) {
      const d = spawnDangerNow();
      if (d) await hideFromThreat('escape', d);
    }
    return { act: 'escape', reason: 'respawn_camped', campRescue: !!(rf && rf.escaped) };
  }
  let danger = null;
  try { danger = await senseSpawnDanger(); } catch (e) { danger = null; }
  const armed = _escapeOnSpawn;
  _escapeOnSpawn = false;
  const wornNow = () => { try { return _wornArmor().size; } catch (e) { return 0; } };
  const nightNow = () => ((bot.time && bot.time.timeOfDay != null) ? isNight(bot) : null);
  const plan = spawnGuardPlan({ danger: !!danger, escapeArmed: armed, night: nightNow(), worn: wornNow() });
  if (plan.act === 'none') return plan;
  emit({
    type: 'spawn_guard', act: plan.act, reason: plan.reason, armed, worn: wornNow(),
    mob: danger ? danger.mob : null, dist: danger ? Math.round(danger.dist * 10) / 10 : null,
  });
  if (plan.act === 'hide') {
    // La vie précédente peut encore tenir le pathfinder : on coupe, puis on se terre.
    try { taskCtl.cancel(); } catch (e) {}
    try { stopMotion(); } catch (e) {}
    const h = await hideFromThreat('spawn', danger);
    // Camp armé : la fuite n'est retentée QU'AU CALME et de jour (la même règle pure re-tranche).
    // Abri raté (pas de sol où creuser, cellule impossible) : idem — mieux vaut la fuite que rester planté.
    if (!armed) return plan;
    const again = spawnGuardPlan({ danger: !!spawnDangerNow(), escapeArmed: true, night: nightNow(), worn: wornNow() });
    if (again.act !== 'escape') return plan;
    emit({ type: 'spawn_guard', act: 'escape', reason: (h && h.ok) ? 'camp_after_hide' : 'camp_hide_failed', armed, worn: wornNow() });
  }
  let r = null;
  try { r = await escapeDeathCamp(); } catch (e) { r = null; /* best-effort : jamais bloquer le respawn */ }
  if (r && r.threat) await hideFromThreat('escape', r.threat);
  return plan;
}

// ─── PILIER ANTI-MÊLÉE (live 22/10, world_oct22) ─────────────────────────────────────────────────
// NethBot3 : 9 morts « slain by Zombie » en 2 min 27 s, EN PLEIN JOUR, au point de réapparition — lisière
// de forêt (zombies à l'ombre de la canopée, ils ne brûlent pas), 2-4 zombies à 0,5-1,7 bloc à chaque vie.
// `spawn_guard hide` → `respawn_flee` → coincé → `reflex fight` (nu) → mort avant que le puits soit creusé.
// Un joueur saute sur 3 blocs de terre, frappe vers le bas, attend, redescend. Décisions PURES dans
// meleePillar.js ; ici la glue. Le pilier se déclare COMME un abri (`_shelterInFlight`/`_shelterTok`) :
// les autres abris le rejoignent, la mort l'annule (abortShelterOnDeath), le tick creeper et le ramassage
// opportuniste le respectent, le watchdog du planner le voit. Le but pathfinder est VERROUILLÉ (goalHold,
// propriétaire 'melee_pillar') : le planner, un goto ou mineflayer-pvp ne le font pas redescendre.
// ⚠️ NIVEAU MODULE (piège #56) : lu par le timer et par hideFromThreat.
let _meleePillar = null;        // { t0, why, placed } pendant un pilier
let _meleePillarFailAt = 0;     // dernier pilier raté (cooldown : pas de rafale d'essais sans bloc posable)
const PILLAR_UP_MAX_MS = 12000;     // montée bornée (withTimeout n'annule rien : l'expiration annule le jeton)
const PILLAR_POLL_MS = 400;
const PILLAR_HIT_EVERY_MS = 650;    // ≈ cooldown d'une épée
const PILLAR_TICK_MS = 500;

/** Entrées de meleePillarPlan relevées sur le vrai bot. Jamais de throw (→ plan 'none'). */
function meleePillarPlanNow() {
  try {
    const p = bot.entity && bot.entity.position;
    if (!p || bot.health == null || bot.health <= 0) return { act: 'none', reason: 'no_position' };
    const self = { x: p.x, y: p.y, z: p.z };   // COPIE (Vec3 muté en place)
    const entities = Object.values(bot.entities || {});
    const near = meleePillar.meleeNear(self, entities);
    let fightAdvised = false;
    try {
      fightAdvised = boldFightAdvised({
        health: bot.health, fightCount: near.length,
        canDealWith: canDealWith(armorPoints(bot), attackDamage(bot)),
        food: bot.food, night: (bot.time && bot.time.timeOfDay != null) ? isNight(bot) : null,
      });
    } catch (e) { fightAdvised = false; }
    let inWater = false;
    try { inWater = isInWater(bot); } catch (e) { inWater = false; }
    let headroom = true;
    try {
      const f = p.floored();
      headroom = meleePillar.headroomOk([2, 3, 4].map((dy) => { const b = bot.blockAt(f.offset(0, dy, 0)); return b ? b.name : null; }));
    } catch (e) { headroom = true; }
    return meleePillar.meleePillarPlan({
      self, entities, fightAdvised, inWater, headroom,
      blocks: meleePillar.scaffoldCount(bot.inventory.items(), SCAFFOLD),
      busy: !!_meleePillar || !!bot.vehicle || !!_creeperFlee,   // fuite creeper en cours : elle tient le verrou de but
      now: Date.now(), lastFailAt: _meleePillarFailAt,
    });
  } catch (e) { return { act: 'none', reason: 'error' }; }
}

/** Redescendre en cassant SES blocs de pilier (au plus `placed`, seulement des blocs sacrifiables). */
async function pillarDescend(placed, tok) {
  for (let i = 0; i < placed; i++) {
    if (tok.cancelled || bot.health == null || bot.health <= 0) return;
    const p = bot.entity && bot.entity.position;
    if (!p) return;
    const below = bot.blockAt(p.floored().offset(0, -1, 0));
    if (!below || !SCAFFOLD.includes(below.name)) return;   // ce n'est plus notre pilier : on ne creuse pas plus bas
    try { const tool = bestToolFor(bot, below); if (tool) await boundedEquip(bot, tool, 'hand'); } catch (e) {}
    try { await boundedDig(bot, below, { token: tok }); } catch (e) { return; }
    await sleep(450);                                       // retomber sur l'étage suivant
  }
}

/**
 * Monter en pilier, tenir (frapper vers le bas) tant que la grappe de mêlée est là (≤ 90 s), redescendre.
 * @returns {{ok:boolean, placed:number, why:string|null}}  ok = le pilier a tenu (≥ 2 étages).
 */
async function meleePillarRun(why, plan) {
  if (_meleePillar || _shelterInFlight) return { ok: false, placed: 0, why: 'busy' };
  const tok = { cancelled: false };
  const t0 = Date.now();
  const st = { t0, why, placed: 0 };
  _meleePillar = st;
  let res = { ok: false, placed: 0, why: null };
  const run = (async () => {
    _stillBusy = true;
    let placed = 0, endWhy = null, melee = plan.mobs;
    try {
      try { if (bot.pvp && bot.pvp.target) bot.pvp.stop(); } catch (e) {}
      try { if (bot.targetDigBlock && typeof bot.stopDigging === 'function') bot.stopDigging(); } catch (e) {}
      holdGoal(_creeperHold, t0 + PILLAR_UP_MAX_MS + 5000, 'melee_pillar');
      try { holdSetGoal(bot.pathfinder, _creeperHold, null, false); } catch (e) {}
      try { if (typeof bot.clearControlStates === 'function') bot.clearControlStates(); } catch (e) {}
      emit({ type: 'melee_pillar', phase: 'up', why, mobs: plan.mobs, h: plan.height, nearest: plan.nearest });
      const up = await withTimeout(pillarUp(bot, { height: plan.height }, tok, { bestToolFor }), PILLAR_UP_MAX_MS,
        () => { tok.cancelled = true; });
      placed = (up && up.placed) || 0;
      st.placed = placed;
      if (placed < meleePillar.PILLAR_MIN_HEIGHT || tok.cancelled) {
        _meleePillarFailAt = Date.now();
        endWhy = tok.cancelled ? 'cancelled' : 'failed';
        emit({ type: 'melee_pillar', phase: 'failed', why, mobs: plan.mobs, h: placed, reason: (up && up.reason) || endWhy });
      } else {
        emit({ type: 'melee_pillar', phase: 'hold', why, mobs: plan.mobs, h: placed });
        for (;;) {
          if (tok.cancelled || bot.health == null || bot.health <= 0) { endWhy = 'cancelled'; break; }
          const q = bot.entity && bot.entity.position;
          if (!q) { endWhy = 'cancelled'; break; }
          const self = { x: q.x, y: q.y, z: q.z };
          const ents = Object.values(bot.entities || {});
          const now = Date.now();
          const s = meleePillar.pillarHoldStatus({ self, entities: ents, t0, now });
          melee = s.melee;
          if (s.done) { endWhy = s.why; break; }
          holdGoal(_creeperHold, now + PILLAR_POLL_MS * 4, 'melee_pillar');   // verrou PROLONGÉ, jamais figé
          const foe = meleePillar.pillarStrikeTarget(self, ents);
          if (foe && now - _auraLastHitAt >= PILLAR_HIT_EVERY_MS) strikeInPlace(foe);
          await sleep(PILLAR_POLL_MS);
        }
        if (endWhy !== 'cancelled') {
          holdGoal(_creeperHold, Date.now() + 20000, 'melee_pillar');   // descente : 3 casses à la main au pire
          await pillarDescend(placed, tok);
        }
      }
    } catch (e) { endWhy = endWhy || 'error'; }
    finally {
      _stillBusy = false;
      if (_creeperHold.owner === 'melee_pillar') releaseGoalHold(_creeperHold);
      emit({ type: 'melee_pillar', phase: 'down', why: endWhy, mobs: melee, h: placed, took_s: Math.round((Date.now() - t0) / 1000) });
    }
    res = { ok: placed >= meleePillar.PILLAR_MIN_HEIGHT && endWhy !== 'failed', placed, why: endWhy };
  })();
  _shelterInFlight = run;
  _shelterTok = tok;
  _shelterStartedAt = t0;
  try { await run; } finally {
    if (_shelterInFlight === run) _shelterInFlight = null;
    if (_shelterTok === tok) _shelterTok = null;
    if (_meleePillar === st) _meleePillar = null;
  }
  return res;
}

/** Le timer : partout (travail, fuite, réapparition), sauf déjà terré/perché. Jamais de throw. */
function meleePillarTick() {
  try {
    if (_meleePillar || _shelterInFlight) return;   // terré : une cellule fermée a des zombies sur le toit, à ≤ 4 blocs
    const plan = meleePillarPlanNow();
    if (plan.act !== 'pillar') return;
    meleePillarRun('tick', plan).catch(() => {});
  } catch (e) { /* best-effort */ }
}

// ─── POINT DE RÉAPPARITION CAMPÉ (live 22/10) ───────────────────────────────────────────────────
// L'anti-camping jugeait l'endroit de la MORT (death_spot_banned 94,-59) et la cadence des morts, jamais
// le point de RÉAPPARITION (93,64,-50) — le vrai camp. Mémoire des vies persistée (respawnCamp.js) ; le
// verdict ARME l'évasion (fuite à pied puis `/spawnpoint` au calme, escapeDeathCamp), retient le camp
// (veto du lit) et, si la réapparition se fait à SON lit, l'abandonne. ⚠️ NIVEAU MODULE (piège #56).
let _respawnCampedLast = null;  // dernier camp signalé { x, z } — un event par camp (± 8 blocs), pas par mort

/** Une vie commence ici. Jamais de throw. */
function noteRespawnLife(pos) {
  try {
    const now = Date.now();
    const memo = loadBaseState();
    saveBaseState(respawnCamp.livesMemoWith(memo, respawnCamp.livesNoteSpawn(respawnCamp.livesLoad(memo, now), pos, now), now));
  } catch (e) { /* best-effort */ }
}

/**
 * La vie en cours s'achève. Si le point de réapparition est campé : event, évasion armée, camp retenu,
 * lit abandonné s'il EST ce point. Rend le camp (ou null). Jamais de throw.
 */
function noteRespawnDeath() {
  try {
    const now = Date.now();
    let memo = loadBaseState();
    const lives = respawnCamp.livesNoteDeath(respawnCamp.livesLoad(memo, now), now);
    memo = respawnCamp.livesMemoWith(memo, lives, now);
    const camp = respawnCamp.campedRespawn(lives, now);
    if (camp) {
      _escapeOnSpawn = true;
      memo = respawnCamp.campedMemoWith(memo, camp, now);
      const last = _respawnCampedLast;
      if (!last || Math.hypot(last.x - camp.x, last.z - camp.z) > respawnCamp.RESPAWN_CAMP_RADIUS) {
        _respawnCampedLast = { x: camp.x, z: camp.z };
        emit({ type: 'respawn_camped', x: camp.x, z: camp.z, deaths: camp.deaths });
      }
      const bed = bedOf(memo);
      if (respawnCamp.bedIsCampedPoint(bed, camp)) {
        memo = bedRetryMemo(bedMemoCleared(memo), now);
        emit({ type: 'bed_abandoned', why: 'respawn_camped', x: bed.x, y: bed.y, z: bed.z });
      }
    }
    saveBaseState(memo);
    return camp;
  } catch (e) { return null; }
}


// ─── ANTI-VIDE (live 22/10, NethBot3 : 17 morts « fell from a high place » en 40 min) ────────────
// Preuve : base + /spawnpoint + home `safe` posés en (-343,75,359) à l'arrivée d'une migration, puis
// une tranche 'mine' partie de CE point (/home safe → descente) creuse un puits VERTICAL y74→y44 sous
// la base (branchMine:enter à x/z identiques, y43.9). Chaque respawn tombe alors 32 blocs, et le
// respawn suivant re-posait `safe` en plein vol (safe_home_set y59). Trois gardes, toutes ici (niveau
// MODULE, lues par des timers/handlers — piège #56) : (1) jamais de home/spawnpoint sans 2 pleins
// sous les pieds (homewarp.bookmark + anchorSpawnpoint), (2) jamais de descente dans la colonne d'une
// ancre, (3) rattrapage après un TP au-dessus du vide + invalidation du home/base condamné.
let _voidRescueBusy = false;     // un seul rattrapage post-TP à la fois
let _spawnOverVoidAt = 0;        // dernier respawn/TP arrivé au-dessus du vide (→ ré-ancrer ailleurs, au sol)
let _spawnOverVoidPos = null;    // {x,z} de ce vide : le ré-ancrage ne se fait qu'à ≤ 24 blocs de lui
let _fallDeaths = [];            // [{x,y,z,at}] morts de CHUTE de ce bot (message serveur) — boucle par chute
let _lastSpawnAt = 0;            // instant du dernier `spawn` (pour attribuer un TP au respawn)

/** Sol sous les pieds du bot (voidGuard.groundCheck). Jamais de throw ; illisible → {ok:null}. */
function _groundHere(need = 2) {
  try {
    const p = bot.entity && bot.entity.position;
    if (!p || typeof bot.blockAt !== 'function') return { ok: null };
    return voidGuard.groundCheck((q) => bot.blockAt(new vec3Lib.Vec3(q.x, q.y, q.z)), p, need);
  } catch (e) { return { ok: null }; }
}

/** Le chunk sous les pieds est-il reçu ? (un bloc nommé juste dessous). Jamais de throw. */
function _chunkLoadedBelow() {
  try {
    const p = bot.entity && bot.entity.position;
    if (!p) return false;
    const b = _vgBlockAt({ x: Math.floor(p.x), y: Math.floor(p.y) - 1, z: Math.floor(p.z) });
    return !!(b && b.name);
  } catch (e) { return false; }
}

/** Lecture de blocs pure pour voidGuard (coordonnées entières → Vec3). */
function _vgBlockAt(q) {
  try { return bot.blockAt(new vec3Lib.Vec3(q.x, q.y, q.z)); } catch (e) { return null; }
}

/**
 * Avant de poser un home/base/spawnpoint : si la colonne sous les pieds n'a pas 2 pleins, marcher
 * jusqu'à la case sûre la plus proche (rayon 4). Rend true si l'on est (désormais) sur un sol sûr ou
 * illisible (comportement d'avant), false sinon — l'appelant ne pose alors RIEN.
 */
async function stepToSafeGround(ctx) {
  const g = _groundHere();
  if (g.ok !== false) return true;
  const p = bot.entity && bot.entity.position;
  const spot = p ? voidGuard.nearestSafeStand(_vgBlockAt, p, 4) : null;
  if (!spot) { emit({ type: 'safe_ground_none', ctx }); return false; }
  try {
    await withTimeout(bot.pathfinder.goto(new pfGoals.GoalBlock(spot.x, spot.y, spot.z)), 8000,
      () => { try { stopMotion(); } catch (e) {} });
  } catch (e) { /* jugé sur le résultat ci-dessous */ }
  const ok = _groundHere().ok !== false;
  emit({ type: 'safe_ground_step', ctx, ok, x: spot.x, y: spot.y, z: spot.z });
  return ok;
}

/** Ancres dont la colonne ne doit JAMAIS être percée : base persistée, home safe, point de respawn. */
function _voidAnchors() {
  const out = [];
  try { const st = loadBaseState(); if (st && st.base) out.push(st.base); } catch (e) {}
  if (_safeHomePos) out.push(_safeHomePos);
  try { const sp = bot.spawnPoint; if (sp && Number.isFinite(sp.x)) out.push({ x: sp.x, y: sp.y, z: sp.z }); } catch (e) {}
  return out;
}

/**
 * Garde de descente : partir d'ici percerait la colonne d'une ancre (≤ 3 blocs) → on se décale de ~7
 * blocs avant de creuser. Rend true si la descente peut partir, false sinon (event `descent_blocked_base`).
 */
async function moveOffAnchorsBeforeDescent(ctx) {
  try {
    const p = bot.entity && bot.entity.position;
    if (!p) return true;
    const anchors = _voidAnchors();
    const a = voidGuard.anchorAbove(p, anchors, 3);
    if (!a) return true;
    const off = voidGuard.descentOffset(p, anchors, 3, 7);
    if (off && bot.pathfinder && pfGoals.GoalNearXZ) {
      try {
        await withTimeout(bot.pathfinder.goto(new pfGoals.GoalNearXZ(off.x, off.z, 1)), 15000,
          () => { try { stopMotion(); } catch (e) {} });
      } catch (e) { /* jugé ci-dessous */ }
    }
    const q = bot.entity && bot.entity.position;
    const still = q ? voidGuard.anchorAbove(q, _voidAnchors(), 3) : null;
    emit({ type: still ? 'descent_blocked_base' : 'descent_offset', ctx,
      anchor: { x: Math.round(a.x), y: Number.isFinite(a.y) ? Math.round(a.y) : null, z: Math.round(a.z) },
      ...(q ? { x: Math.round(q.x), z: Math.round(q.z) } : {}) });
    return !still;
  } catch (e) { return true; }
}

/** descendDiagonal gardé : jamais un escalier/puits qui part dans la colonne de la base. */
let _stairDepth = 0;   // NIVEAU MODULE (piège #56) : lu par le timer du ramassage opportuniste
// `_stairDepth` (23/10, NethBot1 session 408 : dig_failed ×8) : > 0 pendant une descente en escalier →
// le ramassage opportuniste reste à portée de bras (oregrab.grabScope `stair`) : entre deux paliers
// l'escalier n'a aucun but posé, le timer se croyait libre et lançait son dig, qui avortait le nôtre.
async function descendDiagonal(b, opts, token) {
  _stairDepth++;
  try {
    if (!(await moveOffAnchorsBeforeDescent('descend'))) {
      const y = b && b.entity && b.entity.position ? b.entity.position.y : 0;
      return { ok: false, reachedY: y, reason: 'near_base' };
    }
    return await _descendDiagonalRaw(b, opts, token);
  } finally { _stairDepth = Math.max(0, _stairDepth - 1); }
}

/** Persiste la marque de position du branch-mine (mémo base, FUSION). `force` ignore le throttle. */
function _bmPersistMark(phase, force) {
  try {
    const now = Date.now();
    if (!force && !heapGuard.shouldPersistMark(_bmMarkWriteAt, now)) return;
    const m = heapGuard.bmMark(bot.entity && bot.entity.position, now, phase);
    if (!m) return;
    if (_bmCrashHits) m.hits = _bmCrashHits;
    _bmMarkWriteAt = now;
    saveBaseState(Object.assign({}, loadBaseState() || {}, { [heapGuard.BM_MARK_KEY]: m }));
  } catch (e) { /* best-effort : sans marque, le disjoncteur ne voit rien, rien ne casse */ }
}
function _bmClearMark() {
  try {
    const st = loadBaseState();
    if (!st || !st[heapGuard.BM_MARK_KEY]) return;
    const next = Object.assign({}, st);
    delete next[heapGuard.BM_MARK_KEY];
    saveBaseState(next);
  } catch (e) { /* best-effort */ }
}

/**
 * Contrôle « crash au même endroit » (1re entrée en branch-mine du process). La marque n'est effacée
 * qu'à la sortie NORMALE de branchMine : si elle est là, récente et à ≤ 4 blocs, le process précédent
 * est mort en plein branch-mine ici. On décale alors le départ (8-12 blocs perpendiculairement, nouveau
 * cap, tracé en lacets oublié). Au 3e crash d'affilée au même endroit → on n'y mine plus (`crash_spot`),
 * l'appelant se décale à pied comme pour un aquifère.
 * Rend { skip:bool } ; modifie `o` (heading / lawnState) en place.
 */
async function _bmCrashGuard(o) {
  if (_bmCrashChecked) return { skip: false };
  _bmCrashChecked = true;
  let saved = null;
  try { const st = loadBaseState(); saved = st && st[heapGuard.BM_MARK_KEY]; } catch (e) { saved = null; }
  const p = bot.entity && bot.entity.position;
  const pos = p ? { x: p.x, y: p.y, z: p.z } : null;
  if (!heapGuard.isCrashSpot(saved, pos, Date.now())) return { skip: false };
  _bmCrashHits = ((saved && Number(saved.hits)) || 0) + 1;
  const t = heapGuard.crashShiftTarget(pos, o.heading || bot._branchHeading || null);
  emit({ type: 'bm_crash_spot', hits: _bmCrashHits, mark: { x: saved.x, y: saved.y, z: saved.z, phase: saved.phase || null },
    ageMs: Date.now() - saved.at, x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z),
    shift: t ? { x: t.x, y: t.y, z: t.z, dist: t.dist } : null });
  // La marque est ré-écrite AVANT le décalage (avec le compteur) : si c'est le déplacement lui-même qui
  // tue le process, la relance suivante le compte aussi.
  _bmPersistMark('crash_guard', true);
  if (_bmCrashHits >= 3) return { skip: true };
  if (t) {
    try {
      await withTimeout(bot.pathfinder.goto(new pfGoals.GoalNear(t.x, t.y, t.z, 2)), 15000,
        () => { try { stopMotion(); } catch (e) {} });
    } catch (e) { /* jugé ci-dessous */ }
    const q = bot.entity && bot.entity.position;
    emit({ type: 'bm_crash_shift', moved: q ? Math.round(Math.hypot(q.x - pos.x, q.z - pos.z)) : null,
      heading: t.heading });
    o.heading = t.heading;
    bot._branchHeading = t.heading;
    o.lawnState = null;          // le front en lacets mémorisé EST la case qui a tué le process
  }
  return { skip: false };
}

/**
 * branchMine gardé (OOM 23/10) : phase courante pour `heap_high`, marque de position persistée pendant
 * le tunnel, effacée à la sortie normale, et disjoncteur « crash au même endroit » au 1er appel du process.
 */
async function branchMine(b, opts, token) {
  const o = Object.assign({}, opts || {});
  const userOnPhase = o.onPhase;
  o.onPhase = (name, extra) => {
    _bmPhase = name;
    if (name === 'enter') _bmPersistMark(name, true);
    else if (name === 'approach' || name === 'dig' || name === 'seal') _bmPersistMark(name, false);
    if (typeof userOnPhase === 'function') { try { userOnPhase(name, extra); } catch (e) {} }
  };
  try {
    const g = await _bmCrashGuard(o);
    if (g.skip) {
      emit({ type: 'bm_crash_skip', hits: _bmCrashHits });
      _bmCrashHits = 0;
      _bmClearMark();            // la relance suivante (ailleurs) repart d'un compteur propre
      return { ok: false, reason: 'crash_spot' };
    }
  } catch (e) { emit({ type: 'bm_crash_guard_error', err: String((e && e.message) || e).slice(0, 160) }); }
  try {
    const r = await _branchMineRaw(b, o, token);
    // RETOUR VIDE (24/10) : aucun coup de pioche, aucun minerai → `bm_bail {reason}` et, hors jeton
    // annulé, un ÉCHEC pour le planner (goal_failed + failStreak) au lieu d'un ok:true silencieux qui
    // relançait le même but ×4 en 300 ms puis retry 90 s, à vie (NethBot2/NethBot3 en iron_help).
    const v = bmBail(r);
    if (v.bail) {
      const q = b && b.entity && b.entity.position;
      emit({ type: 'bm_bail', reason: v.bail, objective: (world.objective && world.objective.type) || null,
        targetY: o.targetY !== undefined ? o.targetY : null, stopOre: o.stopOre || null,
        x: q ? Math.round(q.x) : null, y: q ? Math.round(q.y) : null, z: q ? Math.round(q.z) : null });
    }
    return v.result;
  } finally {
    _bmPhase = null;
    _bmCrashHits = 0;
    _bmClearMark();
  }
}

/** mineDown gardé (même règle). */
async function mineDown(b, opts, token) {
  if (!(await moveOffAnchorsBeforeDescent('mine_down'))) return { ok: false, reason: 'near_base' };
  return _mineDownRaw(b, opts, token);
}

/** Bloc de remblai en poche (jamais gravier/sable : ils tombent). */
const VOID_FILLERS = ['dirt', 'cobblestone', 'cobbled_deepslate', 'netherrack', 'stone', 'andesite', 'diorite',
  'granite', 'tuff', 'deepslate', 'coarse_dirt', 'oak_planks', 'spruce_planks', 'birch_planks'];
function _voidFiller() {
  const items = (bot.inventory && bot.inventory.items()) || [];
  for (const n of VOID_FILLERS) { const it = items.find((i) => i && i.name === n); if (it) return it; }
  return null;
}

/**
 * Juste après un TÉLÉPORT (respawn, /home, /tpa) : sol à > 3 blocs sous les pieds → on GÈLE la
 * physique client (le serveur n'applique pas de gravité au joueur : il ne tombe pas tant qu'on ne bouge
 * pas — allow-flight=true sur nos serveurs), on pose un bloc de remblai sous soi, puis on dégèle. Le
 * home/respawn qui nous a amenés là est condamné : `/delhome` + `home_invalidated_void` (le respawn,
 * lui, sera ré-ancré au sol dès que possible). Jamais de throw ; la physique est TOUJOURS rétablie.
 */
async function rescueVoidAfterTeleport() {
  if (_voidRescueBusy) return;
  const p0 = bot.entity && bot.entity.position;
  if (!p0 || typeof bot.blockAt !== 'function') return;
  let drop = voidGuard.dropDepth(_vgBlockAt, p0, 40);
  // ≤ 4 blocs au-dessus d'un plein (feuilles, petite marche) n'est PAS du vide (live 23/10, NethBot1 :
  // réapparition à 4 blocs du sol → `/delhome safe` à chaque vie). voidGuard.dangerousDrop tranche.
  if (drop !== null && !voidGuard.dangerousDrop(drop)) return;   // cas normal : rend la main sans rien toucher
  _voidRescueBusy = true;
  const hadPhysics = bot.physicsEnabled !== false;
  const now = Date.now();
  const lastHome = bot._mcaLastHome && now - bot._mcaLastHome.at < 10000 ? bot._mcaLastHome.name : null;
  const viaRespawn = !lastHome && now - _lastSpawnAt < 10000;
  let placed = false; let why = null; let at = null;
  try {
    // GEL PRÉVENTIF : chunk pas encore reçu (drop null) ou vide sous les pieds → on ne bouge plus.
    bot.physicsEnabled = false;
    const t0 = Date.now();
    while (drop === null && Date.now() - t0 < 3000) {
      await sleep(50);
      const q = bot.entity && bot.entity.position;
      drop = q ? voidGuard.dropDepth(_vgBlockAt, q, 40) : null;
    }
    // Toujours illisible : vide seulement si le chunk sous les pieds EST chargé (sinon : pas de verdict).
    if (drop === null && !voidGuard.dangerousDrop(null, { chunkLoaded: _chunkLoadedBelow() })) return;
    if (drop !== null && !voidGuard.dangerousDrop(drop)) return;   // sol sain : dégel au finally
    const p = bot.entity.position;
    at = { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) };
    const filler = _voidFiller();
    const plan = voidGuard.catchBlockPlan(_vgBlockAt, p);
    if (!filler) why = 'no_block';
    else if (!plan) why = 'no_ref';
    else {
      try {
        await bot.equip(filler, 'hand');
        const ref = bot.blockAt(new vec3Lib.Vec3(plan.ref.x, plan.ref.y, plan.ref.z));
        await withTimeout(bot.placeBlock(ref, new vec3Lib.Vec3(plan.face.x, plan.face.y, plan.face.z)), 2500, () => {});
        placed = voidGuard.isSolid(bot.blockAt(new vec3Lib.Vec3(plan.target.x, plan.target.y, plan.target.z))) === true;
        if (!placed) why = 'not_placed';
      } catch (e) { why = 'place_failed'; }
    }
  } finally {
    try { bot.physicsEnabled = hadPhysics; } catch (e) {}
    _voidRescueBusy = false;
  }
  if (!at) return;
  emit({ type: 'tp_void_landing', drop, placed, ...(why ? { why } : {}), via: lastHome ? 'home:' + lastHome : (viaRespawn ? 'respawn' : 'tp'), ...at });
  if (lastHome === HOME_SAFE || lastHome === HOME_WORK) invalidateVoidHome(lastHome, at, 'tp_over_void');
  if (viaRespawn || lastHome === HOME_SAFE) { _spawnOverVoidAt = now; _spawnOverVoidPos = { x: at.x, z: at.z }; }
}

/**
 * Home condamné (au-dessus d'un vide connu) : `/delhome` + état du process oublié + event
 * `home_invalidated_void`. Le safe sera re-posé par le watchdog à la prochaine surface sèche AU SOL
 * (la garde de homewarp.bookmark refuse toute pose au-dessus du vide).
 */
function invalidateVoidHome(name, at, reason) {
  try { homewarp.delhome(bot, name); } catch (e) {}
  if (name === HOME_SAFE) {
    _safeHomeSet = false; _safeHomeSurface = false; _safeHomePos = null;
    try {
      const st = Object.assign({}, loadBaseState() || {});
      delete st.safeHome;
      saveBaseState(st);
    } catch (e) {}
  }
  if (name === HOME_WORK) { _workSet = false; _forgetDeepWork('delhome'); _workPos = null; }
  emit({ type: 'home_invalidated_void', name, reason, ...(at || {}) });
}

/**
 * Mort par CHUTE (message serveur) : (a) un home/base dans la MÊME colonne, au-dessus de la mort, est
 * condamné tout de suite (on ne re-téléporte JAMAIS vers lui) ; (b) ≥ 2 chutes à ≤ 6 blocs en 2 min =
 * boucle → la base persistée dans cette colonne est oubliée et le respawn sera ré-ancré au sol.
 */
function noteFallDeath(pos) {
  if (!pos || !Number.isFinite(pos.x)) return;
  const now = Date.now();
  const d = { x: pos.x, y: pos.y, z: pos.z, at: now };
  _fallDeaths = _fallDeaths.filter((f) => now - f.at <= 600000).concat([d]);
  if (_safeHomePos && voidGuard.deathBelowAnchor(d, _safeHomePos)) invalidateVoidHome(HOME_SAFE, { x: Math.round(d.x), z: Math.round(d.z) }, 'fall_death_below');
  const loop = voidGuard.fallDeathLoop(_fallDeaths, now);
  let st = null;
  try { st = loadBaseState(); } catch (e) { st = null; }
  const baseHit = st && st.base && (voidGuard.deathBelowAnchor(d, st.base) || (loop.loop && Math.hypot(st.base.x - loop.x, st.base.z - loop.z) <= 6));
  if (baseHit) {
    const old = st.base;
    try {
      const nx = Object.assign({}, st, { voidBase: { x: old.x, y: old.y, z: old.z, at: now } });
      delete nx.base;
      saveBaseState(nx);
    } catch (e) {}
    emit({ type: 'base_invalidated_void', x: old.x, y: old.y, z: old.z, loop: !!loop.loop });
  }
  if (loop.loop || baseHit) { _spawnOverVoidAt = now; _spawnOverVoidPos = { x: d.x, z: d.z }; }
  emit({ type: 'fall_death', x: Math.round(d.x), y: Math.round(d.y), z: Math.round(d.z), loop: !!loop.loop, count: loop.count || 1 });
}

/**
 * Respawn arrivé au-dessus du vide (ou boucle de chute) : dès qu'on est debout et au calme, marcher
 * jusqu'à une case SÛRE et y ré-ancrer /spawnpoint + base (la base reste celle d'avant si elle est saine).
 * Appelé par un timer (niveau module) ; best-effort.
 */
let _voidReanchorBusy = false;
async function reanchorAfterVoid() {
  if (!_spawnOverVoidAt || _voidReanchorBusy || _voidRescueBusy) return;
  if (Date.now() - _spawnOverVoidAt > 10 * 60000) { _spawnOverVoidAt = 0; return; }
  if (!bot.entity || !bot.entity.onGround) return;
  _voidReanchorBusy = true;
  try {
    const p = bot.entity.position;
    // Loin du vide (le bot est reparti travailler) : on ne pose PAS un respawn au hasard, on attend la
    // prochaine arrivée au-dessus du vide (le gel + remblai le garde en vie d'ici là).
    if (_spawnOverVoidPos && Math.hypot(p.x - _spawnOverVoidPos.x, p.z - _spawnOverVoidPos.z) > 24) { _spawnOverVoidAt = 0; return; }
    // CAMPÉ ICI (live 23/10, NethBot1 session 477 : 100+ `spawnpoint_vetoed camped why:void_reanchor`,
    // une toutes les 3 s pendant 5 min) : le veto a raison, mais réessayer sur place ne mène nulle part.
    // On passe la main au ré-ancrage HORS du camp (campReanchorTick) et on lâche ce rattrapage-ci.
    if (_campedAt({ x: p.x, y: p.y, z: p.z })) {
      if (!_campReanchor) _campReanchor = { x: Math.round(p.x), z: Math.round(p.z), at: Date.now(), via: 'void' };
      _spawnOverVoidAt = 0; _spawnOverVoidPos = null;
      emit({ type: 'void_reanchor_deferred', reason: 'camped', x: Math.round(p.x), z: Math.round(p.z) });
      return;
    }
    if (!(await stepToSafeGround('void_reanchor'))) return;
    if (!anchorSpawnpoint('void_reanchor')) return;
    const st = loadBaseState() || {};
    if (!IS_MAPPER && (!st.base || voidGuard.deathBelowAnchor({ x: p.x, y: -1e9, z: p.z }, st.base))) {
      saveBaseState(Object.assign({}, st, { base: { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) } }));
    }
    _spawnOverVoidAt = 0; _spawnOverVoidPos = null;
    emit({ type: 'void_reanchored', x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) });
  } catch (e) { /* best-effort */ } finally { _voidReanchorBusy = false; }
}
setInterval(() => { reanchorAfterVoid().catch(() => {}); }, 3000);

/**
 * Pose le /spawnpoint ICI — SAUF dans une zone campée (homeSafety.spawnpointVeto, ≥ 2 morts récentes à
 * ≤ 24 blocs) ou position illisible. Run 10 : 39 `/spawnpoint` posés pour 67 `home_safe_camped` — le
 * point de réapparition devenait le camp lui-même. TOUS les ancrages du respawn passent par ici.
 * @returns true si la commande est partie.
 */
function anchorSpawnpoint(reason) {
  const p0 = bot.entity && bot.entity.position;
  const pos = p0 ? { x: p0.x, y: p0.y, z: p0.z } : null;   // COPIE (Vec3 muté en place)
  let v;
  try { v = spawnpointVeto({ pos, deaths: _recentDeathPositions(), now: Date.now() }); }
  catch (e) { v = { veto: true, reason: 'error' }; }
  if (!v.veto && _groundHere().ok === false) v = { veto: true, reason: 'void_below' };   // anti-vide (22/10)
  if (v.veto) {
    // 1 event par (raison, appelant, endroit) et par minute : la session 477 en a émis 100+ (un toutes les 3 s).
    const now = Date.now();
    const last = _spawnVetoLast;
    const same = last && last.reason === v.reason && last.why === reason && pos && last.x != null
      && Math.hypot(pos.x - last.x, pos.z - last.z) <= 8 && now - last.at < SPAWN_VETO_EVENT_EVERY_MS;
    if (!same) {
      _spawnVetoLast = { reason: v.reason, why: reason, x: pos ? pos.x : null, z: pos ? pos.z : null, at: now };
      emit({ type: 'spawnpoint_vetoed', reason: v.reason, why: reason, deaths: v.deaths != null ? v.deaths : null,
        x: pos ? Math.round(pos.x) : null, z: pos ? Math.round(pos.z) : null });
    }
    // Camp : le veto dit « pas ici » — on note qu'il faudra le poser AILLEURS (campReanchorTick).
    if (v.reason === 'camped' && pos && !_campReanchor) _campReanchor = { x: Math.round(pos.x), z: Math.round(pos.z), at: now, via: 'veto' };
    return false;
  }
  try { bot.chat('/spawnpoint'); } catch (e) { return false; }
  emit({ type: 'command', command: '/spawnpoint', reason });
  // Un /spawnpoint posé LOIN du camp en attente règle l'attente, quel que soit l'appelant.
  const pend = _campReanchor;
  if (pend && pos) {
    const d = Math.hypot(pos.x - pend.x, pos.z - pend.z);
    if (d >= respawnEscape.CAMP_ESCAPE_MIN_DIST) {
      _campReanchor = null;
      emit({ type: 'spawn_reanchored', why: reason, x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z),
        camp: { x: pend.x, z: pend.z }, dist: Math.round(d), via: pend.via || null });
      // 'camped_move' (maybeMoveCampedSafeHome) déplace déjà base + safe lui-même.
      if (reason !== 'camped_move') moveBaseOutOfCamp(pos, pend);
    }
  }
  return true;
}

/**
 * Le point de réapparition vient de quitter un camp : si la BASE persistée y est restée (≤ 24 blocs d'un
 * camp, ou campée/bannie), elle suit — base + home `safe` + confine + bornes d'exploration — sinon le rappel
 * du confine (/home safe) renvoie le bot au camp. Ouvriers seulement (un cartographe n'a pas de base).
 * Fusion du mémo (saveBaseState FUSIONNE, piège #61). Jamais de throw. Rend true si la base a bougé.
 */
function moveBaseOutOfCamp(to, camp) {
  try {
    if (IS_MAPPER || !to || !Number.isFinite(to.x)) return false;
    const now = Date.now();
    const st = loadBaseState() || {};
    const base = st.base;
    if (!base || !Number.isFinite(base.x)) return false;
    let flagged = false;
    try { flagged = _campedAt(base) || deathSpots.isBanned(base.x, base.z) || deathzones.isBanned(_dzones, base.x, base.z, now); } catch (e) { flagged = false; }
    const camps = [camp].concat(respawnCamp.campedList(st, now));
    if (!respawnEscape.baseInCamp({ base, camps, flagged })) return false;
    const nb = { x: Math.round(to.x), y: Math.round(to.y), z: Math.round(to.z) };
    saveBaseState(Object.assign({}, loadBaseState() || {}, { base: nb }));
    let safeMoved = false;
    try { if (homewarp.bookmark(bot, HOME_SAFE)) safeMoved = noteSafeHome(to, 'camped') !== false; } catch (e) { safeMoved = false; }
    if (CONFINE) CONFINE = { x: nb.x, z: nb.z, radius: CONFINE.radius };
    if (_confineDyn) _confineDyn = { x: nb.x, z: nb.z, radius: _confineDyn.radius };
    const conf = CONFINE || _confineDyn;
    if (conf) bot._mcaExploreBounds = { x: conf.x, z: conf.z, radius: Math.max(conf.radius * 2, 128) };
    emit({ type: 'base_moved_from_camp', from: { x: base.x, y: base.y, z: base.z }, to: nb, camp: { x: camp.x, z: camp.z }, safe: safeMoved, flagged });
    return true;
  } catch (e) { return false; }
}

// ─── RÉ-ANCRAGE HORS D'UN CAMP DE RÉAPPARITION (23/10, respawnEscape.js) ────────────────────────────
// ⚠️ NIVEAU MODULE (piège #56) : lus par le timer ci-dessous, par anchorSpawnpoint et par guardSpawn.
let _campReanchor = null;        // { x, z, at, via } : le point de réapparition est un camp, à reposer ailleurs
let _spawnVetoLast = null;       // dédup de `spawnpoint_vetoed`
const SPAWN_VETO_EVENT_EVERY_MS = 60000;
const CAMP_TPA_WAIT_MS = 12000;  // acceptation (~2 s) + éventuel teleport-delay
const CAMP_REANCHOR_TICK_MS = 4000;
let _campReanchorWhy = null;     // dernière raison d'attente tracée (dédup)

/**
 * Au spawn : ce point de réapparition est-il un camp ? Si oui, l'attente de ré-ancrage est posée, puis
 * /tpa chez un coéquipier vivant, mineur, armé, loin du camp. Rend null (pas de camp), { via:'tpa' }
 * (téléporté), { via:'foot', camp } (personne, ou /tpa raté : fuir à pied) ou { via:'dead' }. Jamais de throw.
 */
async function respawnCampRescue() {
  try {
    const p0 = bot.entity && bot.entity.position;
    if (!p0) return null;
    const pos = { x: p0.x, y: p0.y, z: p0.z };   // COPIE (Vec3 muté en place)
    const now = Date.now();
    let shortLives = null;
    try { shortLives = respawnCamp.campedRespawn(respawnCamp.livesLoad(loadBaseState(), now), now); } catch (e) { shortLives = null; }
    const verdict = respawnEscape.respawnCampVerdict({ spawn: pos, deathPos: _recentDeathPositions(), shortLives, now });
    if (!verdict) return null;
    const camp = { x: verdict.x, z: verdict.z };
    _campReanchor = { x: camp.x, z: camp.z, at: now, via: 'respawn' };
    const gen = _lifeGen;
    let mate = null;
    try {
      mate = presence ? respawnEscape.pickRescueMate({ camp, self: pos, selfName: bot.username, mates: presence.list(), now }) : null;
    } catch (e) { mate = null; }
    if (mate && !isAllowed('/tpa ' + mate.name, whitelist)) { emit({ type: 'respawn_camp_tpa_blocked', to: mate.name }); mate = null; }
    if (mate) {
      emit({ type: 'respawn_camp_tpa', to: mate.name, dist: mate.dist, worn: mate.worn, deaths: verdict.deaths, why: verdict.why });
      try { taskCtl.cancel(); } catch (e) {}
      try { stopMotion(); } catch (e) {}
      let r = null;
      try { bot.chat('/tpa ' + mate.name); r = await awaitWarp({ maxMs: CAMP_TPA_WAIT_MS }); } catch (e) { r = null; }
      if (gen !== _lifeGen) return { via: 'dead', camp };   // mort pendant l'attente : la vie suivante décide
      if (r && r.warped) {
        const t = Date.now();
        _lastRegroupAt = t; _lastSquadAt = t;            // déjà avec l'équipe : pas de /tpa dans la foulée
        _confineGraceUntil = Math.max(_confineGraceUntil, t + 10 * 60000);   // pas de rappel /home vers la base (souvent DANS le camp)
        emit({ type: 'respawn_camp_escape', via: 'tpa', to: mate.name, dist: mate.dist, camp, deaths: verdict.deaths });
        return { via: 'tpa', camp, to: mate.name };
      }
      emit({ type: 'respawn_camp_tpa_failed', to: mate.name, cancelled: !!(r && r.cancelled) });
    }
    return { via: 'foot', camp };
  } catch (e) { return null; }
}

/** Le timer : sorti du camp, au calme, au sol plein, éclairé → /spawnpoint ICI. Jamais de throw. */
function campReanchorTick() {
  try {
    const pend = _campReanchor;
    if (!pend) return;
    const p = bot.entity && bot.entity.position;
    if (!p || bot.health == null || bot.health <= 0) return;
    const pos = { x: p.x, y: p.y, z: p.z };
    const now = Date.now();
    let hostileDist = null;
    try {
      const near = nearbyHostiles(bot, respawnEscape.REANCHOR_CALM_RADIUS);
      if (near.length) hostileDist = near.reduce((m, e) => Math.min(m, e.position.distanceTo(p)), Infinity);
    } catch (e) { hostileDist = null; }
    let camped = false;
    try { camped = spawnpointVeto({ pos, deaths: _recentDeathPositions(), now }).veto === true; } catch (e) { camped = true; }
    let blockLight = null, skyLight = null;
    try {
      const b = bot.blockAt(p.floored ? p.floored() : new vec3Lib.Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)));
      if (b) { blockLight = Number.isFinite(b.light) ? b.light : null; skyLight = Number.isFinite(b.skyLight) ? b.skyLight : null; }
    } catch (e) { /* illisible → ne bloque pas */ }
    let inWater = false;
    try { inWater = isInWater(bot); } catch (e) { inWater = false; }
    const busy = !!_escaping || !!_shelterInFlight || !!_meleePillar || !!_voidRescueBusy || !!_voidReanchorBusy || !!bot.vehicle;
    const r = respawnEscape.reanchorReady({
      pending: pend, pos, now, busy, inWater,
      onGround: bot.entity.onGround !== false, groundOk: _groundHere().ok,
      hostileDist, camped, blockLight, skyLight,
      night: (bot.time && bot.time.timeOfDay != null) ? isNight(bot) : null,
    });
    if (r.expired) { _campReanchor = null; emit({ type: 'spawn_reanchor_expired', camp: { x: pend.x, z: pend.z } }); return; }
    if (!r.ok) {
      if (r.reason !== _campReanchorWhy && r.reason !== 'too_close') {
        _campReanchorWhy = r.reason;
        emit({ type: 'spawn_reanchor_wait', reason: r.reason, dist: r.dist != null ? Math.round(r.dist) : null });
      }
      return;
    }
    _campReanchorWhy = null;
    anchorSpawnpoint('respawn_camp');   // pose + `spawn_reanchored` (qui vide l'attente) ; veto ultime inclus
  } catch (e) { /* best-effort */ }
}
setInterval(campReanchorTick, CAMP_REANCHOR_TICK_MS);

/**
 * Bois sans mourir : un bot NU a-t-il une menace RÉELLE à ≤ 16 blocs MAINTENANT ? (même prédicat
 * « hostile à craindre » que le spawn, + ligne de vue ou ≤ 6 blocs — threatgate). Jamais de throw.
 */
// Noyade : le dernier warp /home safe pour noyade (NIVEAU MODULE, piège #56 — lu par le réflexe).
const DROWN_WARP_RETRY_MS = 60000;
let _lastDrownWarpAt = 0;
const WOOD_DANGER_RADIUS = 16;
// Séquence de buts `logs` (run 12) : cachettes faites + menaces statiques ignorées. NIVEAU MODULE (piège
// #56) : le planner rappelle gatherWoodSafely à chaque tentative — un compteur local repartait de zéro
// et NethBot1 s'est caché 6 fois de suite du même squelette immobile. Oubliée après 10 min (threatgate).
let _woodHide = null;
/** La menace RÉELLE la plus proche (bot NU, ≤ 16 blocs, ligne de vue OU ≤ 6 blocs), hors `ignore`. */
function woodThreatNow(ignore) {
  try {
    const pos = bot.entity && bot.entity.position;
    if (!pos) return null;
    if (_wornArmor().size >= SPAWN_DANGER_MIN_WORN) return null;
    const p = { x: pos.x, y: pos.y, z: pos.z };   // COPIE (Vec3 muté en place)
    return realThreat({
      pos: p, radius: WOOD_DANGER_RADIUS, entities: Object.values(bot.entities || {}),
      isHostile: isThreatHostile, ignore: ignore || [],
      blockAt: (q) => bot.blockAt(vec3Lib(q.x, q.y, q.z)),
    });
  } catch (e) { return null; }
}
/** Compat : `{dist, mob}` d'une menace réelle (stash, dépôt) — null sinon. Jamais de throw. */
function woodDangerNow() {
  const t = woodThreatNow(_woodHide ? _woodHide.ignore : []);
  return t ? Object.assign({ flee: true, reason: 'naked_hostile_near' }, t) : null;
}

/**
 * Récolte de bois SANS MOURIR — et sans se terrer en boucle (run 12). Nu :
 *   - menace RÉELLE (threatgate.realThreat : ligne de vue ou ≤ 6 blocs) avant/pendant la récolte →
 *     on se terre (≤ 60 s) puis on reprend ;
 *   - la MÊME menace, toujours là sans s'être approchée après une cachette (squelette derrière un mur,
 *     sous la canopée) → on ne se recache PAS : elle est ignorée et on récolte (`threat_hide_skipped`) ;
 *   - au plus 2 cachettes par séquence `logs` (module, 10 min), puis on récolte malgré tout.
 * Armuré : aucune menace (woodThreatNow → null), un seul passage. Borné par SKILL_TIMEOUTS.gatherLog.
 */
async function gatherWoodSafely(gargs) {
  const t0 = Date.now();
  const worn = (() => { try { return _wornArmor().size; } catch (e) { return 0; } })();
  const shape = woodExploreShape({ worn });
  _woodHide = woodHideStateAt(_woodHide, Date.now());
  const st = _woodHide;
  // De NUIT la discipline de nuit possède le trou : ici on rend seulement la main.
  const night = () => !!(bot.time && bot.time.timeOfDay != null && isNight(bot));
  const canHide = () => Date.now() - t0 < WOOD_HIDE_WINDOW_MS;
  const threat = () => woodThreatNow(st.ignore);
  // Décide face à une menace : true = s'est caché, false = on continue (menace ignorée désormais).
  const react = async (t) => {
    const plan = woodHidePlan({ threat: t, hides: st.hides, last: st.last });
    if (plan.act !== 'hide' || !canHide()) {
      const why = plan.act === 'hide' ? 'window' : plan.why;
      emit({ type: 'threat_hide_skipped', why, mob: t.mob, dist: Math.round(t.dist * 10) / 10, hides: st.hides });
      st.ignore.push({ id: t.id, x: t.x, y: t.y, z: t.z, dist: t.dist });
      if (st.ignore.length > 8) st.ignore.shift();
      return false;
    }
    st.hides++;
    await hideFromThreat('wood', t, { maxWaitMs: WOOD_HIDE_MAX_MS });
    st.last = { id: t.id, x: t.x, y: t.y, z: t.z, dist: t.dist };
    return true;
  };
  let r = null;
  _exploreBusy = true;
  try {
    for (let guard = 0; guard < 12; guard++) {
      if (taskToken.cancelled) return { ok: false, reason: 'cancelled' };
      const d = threat();
      if (d && night()) return r || { ok: false, got: 0, reason: 'danger' };
      if (d) { await react(d); continue; }   // caché OU ignorée : re-lire (la suivante est peut-être réelle)
      r = await gather(bot, Object.assign({}, gargs, shape ? { exploreShape: shape } : {},
        { danger: () => !!threat() }), taskToken);
      if (r && r.ok && r.got > 0) _woodHide = null;   // séquence réussie : compteur remis à zéro
      if (!(r && r.reason === 'danger')) return r;
      if (r.ok) return r;                    // lot partiel déjà en poche : le planner re-dérive
      if (night()) return r;
    }
    return r || { ok: false, got: 0, reason: 'danger' };
  } finally { _exploreBusy = false; }
}

// ─── KIT DE SECOURS EN COFFRE (run 10, 20/10) ─────────────────────────────────────────────────────
// Décisions PURES dans stash.js (depositPlan / restorePlan) ; ici la glue. Le coffre est rangé dans le
// mémo de base (`stash: {x,y,z,at,items}`, écrit en FUSION — piège #61). Dépôt : à la base ou au point de
// respawn, de jour, au calme, une fois les outils de pierre + le four obtenus, et seulement du SURPLUS.
// Retrait : au respawn, si le bot a tout perdu (pas de pioche pierre — sous keepInventory ON il la garde :
// rien ne se passe), à ≤ 48 blocs, zone du coffre non campée. Events `stash_deposit` / `stash_restore`.
// ⚠️ Gardes de NIVEAU MODULE (piège #56) : lues par le hook du planner, hors de onSpawn.
const STASH_CHECK_EVERY_MS = 60000;   // le hook du planner ne relit l'état qu'une fois par minute
const STASH_WALK_MS = 30000;          // ≤ 48 blocs : 30 s suffisent, au-delà on renonce (vitesse)
let _stashCheckedAt = 0;
let _stashBusy = false;
let _lastRespawnPos = null;           // COPIE de la position au dernier `spawn` (là où l'on revient en mourant)

function _invSnapshot() {
  return ((bot.inventory && bot.inventory.items()) || []).map((i) => ({ name: i.name, count: i.count }));
}

/** Ce qui a VRAIMENT quitté l'inventaire (avant − après), restreint aux noms prévus. */
function _stashedDiff(before, after, planned) {
  const tot = (list) => { const m = {}; for (const i of list || []) m[i.name] = (m[i.name] || 0) + i.count; return m; };
  const b = tot(before), a = tot(after);
  const names = new Set((planned || []).map((i) => i.name));
  const out = [];
  for (const n of names) { const d = (b[n] || 0) - (a[n] || 0); if (d > 0) out.push({ name: n, count: d }); }
  return out;
}

/** Hook du planner (avant chaque but) : dépose le kit quand c'est le moment. Jamais de throw. */
async function stashKitIfReady() {
  if (!NO_GIVE || IS_MAPPER || _stashBusy) return null;
  const now = Date.now();
  if (now - _stashCheckedAt < STASH_CHECK_EVERY_MS) return null;
  _stashCheckedAt = now;
  const st = loadBaseState() || {};
  const p0 = bot.entity && bot.entity.position;
  const p = p0 ? { x: p0.x, y: p0.y, z: p0.z } : null;
  const ref = (st.base && Number.isFinite(st.base.x)) ? st.base : _lastRespawnPos;
  const nearBase = !!(p && ref && Math.hypot(p.x - ref.x, p.z - ref.z) <= STASH_NEAR_BASE);
  const inv = _invSnapshot();
  const night = !!(bot.time && bot.time.timeOfDay != null && isNight(bot));
  const safe = !!p && p.y >= SAFE_HOME_MIN_Y && !night && !woodDangerNow();
  const plan = depositPlan({ inv, hasFurnace: inv.some((i) => i.name === 'furnace'), stash: st.stash || null, nearBase, safe });
  if (plan.act !== 'deposit') return plan;
  _stashBusy = true;
  try {
    if (plan.craftSparePick) { try { await craftSmart({ name: 'stone_pickaxe', count: 1 }); } catch (e) { /* la rechange reste optionnelle */ } }
    let r;
    try { r = await bankDeposit(plan.items); } catch (e) { r = { ok: false, reason: 'exception' }; }
    if (!r || !r.ok) { emit({ type: 'stash_failed', reason: (r && r.reason) || 'error' }); return plan; }
    const items = _stashedDiff(r.before, r.after, plan.items);
    if (!items.length) { emit({ type: 'stash_failed', reason: 'nothing_stored' }); return plan; }
    const pos = { x: Math.round(r.pos.x), y: Math.round(r.pos.y), z: Math.round(r.pos.z) };
    saveBaseState(Object.assign({}, loadBaseState() || {}, { stash: Object.assign({}, pos, { at: Date.now(), items }) }));
    emit(Object.assign({ type: 'stash_deposit' }, pos, { items }));
    return plan;
  } finally { _stashBusy = false; }
}

/** Au respawn : reprendre le kit au lieu de recommencer au bois. Jamais de throw. */
async function restoreStashIfUseful() {
  if (!NO_GIVE || IS_MAPPER) return null;
  const st = loadBaseState() || {};
  const stash = st.stash || null;
  if (!stash) return null;
  const p0 = bot.entity && bot.entity.position;
  const pos = p0 ? { x: p0.x, y: p0.y, z: p0.z } : null;
  const camped = (() => { try { return _campedAt({ x: stash.x, y: stash.y, z: stash.z }); } catch (e) { return false; } })();
  const plan = restorePlan({ stash, pos, inv: _invSnapshot(), camped });
  if (plan.act !== 'restore') {
    if (plan.reason !== 'has_pickaxe') emit({ type: 'stash_skip', reason: plan.reason, dist: plan.dist != null ? Math.round(plan.dist) : null });
    return plan;
  }
  const done = (o) => { emit(Object.assign({ type: 'stash_restore' }, o)); return plan; };
  try {
    await gotoWithTimeout(bot, new pfGoals.GoalNear(stash.x, stash.y, stash.z, 2), STASH_WALK_MS, () => !!woodDangerNow());
  } catch (e) {
    return done({ ok: false, reason: (e && e.message === 'goto_danger') ? 'danger' : 'unreachable' });
  }
  const blk = (() => { try { return bot.blockAt(vec3Lib(stash.x, stash.y, stash.z)); } catch (e) { return null; } })();
  if (!blk || blk.name !== 'chest') {
    // Coffre détruit/pillé : on oublie ce kit (sinon chaque respawn y marcherait pour rien).
    saveBaseState(Object.assign({}, loadBaseState() || {}, { stash: null }));
    return done({ ok: false, reason: 'chest_missing' });
  }
  let chest;
  try { chest = await bot.openContainer(blk); } catch (e) { return done({ ok: false, reason: 'open_failed' }); }
  const got = [];
  let left = [];
  try {
    for (const it of chest.containerItems()) {
      try { await chest.withdraw(it.type, null, it.count); got.push({ name: it.name, count: it.count }); } catch (e) { /* inventaire plein/désync */ }
    }
    left = chest.containerItems().map((i) => ({ name: i.name, count: i.count }));
  } finally { try { chest.close(); } catch (e) {} }
  // Coffre vidé → plus de kit (un nouveau dépôt redeviendra possible une fois les outils refaits).
  saveBaseState(Object.assign({}, loadBaseState() || {}, { stash: left.length ? Object.assign({}, stash, { items: left }) : null }));
  return done({ ok: true, items: got, left: left.length });
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
        onStep: (g) => { _lastGoalAt = Date.now(); emit({ type: 'goal', name: g.name }); },
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
  anchorSpawnpoint('kit_done');   // trace `command` reason kit_done (ou `spawnpoint_vetoed` si campé)
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
    // --xray 1 (run où le x-ray est autorisé) DÉBRIDE ce filtre : le bot cible alors AUSSI les
    // minerais mappés enterrés (comportement pré-water-wall). `wet` reste exclu (anti-noyade).
    exposedOnly: NO_GIVE && !XRAY,
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
        // CAVE-FIRST (bug #3 Massii). Phase 1 : rejoindre la grotte SANS creuser (canDig=false) — le
        // chemin le plus humain (on entre par l'ouverture). Phase 2 (clarif #3) : pas walkable → creuser
        // POUR ATTEINDRE est AUTORISÉ (ne PAS sacrifier le diamant), MAIS le tunnel doit SERPENTER (un
        // tunnel parfaitement droit vers une grotte est AUSSI un tell X-ray) → on creuse via un point
        // intermédiaire décalé LATÉRALEMENT (coude aléatoire), pas en ligne droite.
        let r = null;
        await withTempMovements(bot, Movements, { canDig: false }, async () => {
          try {
            r = await withTimeout(bot.pathfinder.goto(goal), 60000, () => { try { stopMotion(); } catch (e) {} });
          } catch (e) { r = { ok: false }; }
        });
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
// ⚠️ NIVEAU MODULE (piège #56) : le dernier runner démarré — lu par startAutonomous (idempotence).
let _autoLive = null;   // { tok, objective }
/** PUR : ce démarrage serait-il un DOUBLON d'un runner vivant ? */
function autonomousDupStart({ runners, live, active, objective } = {}) {
  return runners > 0 && !!live && !!live.tok && !live.tok.cancelled && active === 'autonomous'
    && live.objective === objective;
}

async function startAutonomous(sender, opts) {
  // Charge sur squelette en cours : le planner attend la fin (la charge le relance elle-même).
  if (_skelRushBusy) {
    _skelPlannerPending = true;
    emit({ type: 'autonomous_deferred', why: 'skeleton_rush' });
    return null;
  }
  // objectif : depuis le world (seedé par le backend/launch), sinon --objective, sinon pioche pierre.
  let objType = (world.objective && world.objective.type) || args.objective || 'stone_pickaxe';
  // CLIQUET DIAMANT (24/10 soir) : le backend relance chaque mort avec l'objectif du LANCEMENT (iron_armor)
  // → sous le cliquet, un mineur repart au diamant (détour fer borné s'il est vraiment nu). Prime sur
  // objectiveForStart (qui ramènerait iron_help/mapper_armor à iron_armor faute d'armure couverte).
  let _latchedStart = false;
  try {
    const lat = latchedObjectiveNow(objType, !!(opts && opts.fromSpawn));
    if (lat) {
      _latchedStart = true;
      _setIronDetour(lat.detourAt);
      if (lat.objective !== objType) {
        if (objType === 'mapper_armor') { try { if (_giftTarget) releaseGiftTarget(_giftTarget); } catch (e) { /* best-effort */ } }
        emit({ type: 'objective_latched', from: objType, to: lat.objective, why: lat.why, at: 'start' });
        objType = lat.objective;
      }
    }
  } catch (e) { /* best-effort : chemin historique */ }
  // Objectif persisté d'APRÈS l'armure (iron_help, mapper_armor) mais armure disparue (inventaire vidé,
  // pièces cassées) → on repart sur iron_armor et sa chaîne de démarrage (21/10, cf. goals.objectiveForStart).
  if (!_latchedStart) try {
    const back = objectiveForStart(objType, { inv: buildCtxInv(bot), worn: [..._wornArmor()] });
    if (back !== objType) {
      emit({ type: 'objective_regressed', from: objType, to: back });
      // Bûcheron sans 4/4 portées (inventaire vidé, 22/10) : le rôle est rendu ICI, avant tout but de coupe.
      if (objType === 'lumberjack') {
        try { _ljResignCleanup(); } catch (e) { /* best-effort */ }
        try { if (_teamClaims) _teamClaims.release(LJ_CLAIM); } catch (e) { /* best-effort */ }
        emit({ type: 'lumberjack_resigned', from: 'lumberjack', to: back, why: 'unarmored', at: 'start' });
      }
      objType = back;
    }
  } catch (e) { /* best-effort : objectif inchangé */ }
  // UN SEUL RUNNER (live 22/10, NethBot1 session 206 : deux `autonomous_resume`/`autonomous_start` à 4 ms —
  // deux onSpawn de deux vies successives, tous deux en attente du MÊME abri, reprenaient ensemble ; le 2e
  // `taskCtl.begin` annulait l'abri que le 1er venait d'ouvrir, `sealed:false why:cancelled` en 68 ms).
  // Un runner vivant (jeton non annulé, toujours autonomous) pour le même objectif → ce 2e appel ne fait rien.
  // Qui veut VRAIMENT relancer (watchdog, migration, fuite) préempte d'abord par taskCtl.begin/cancel.
  if (autonomousDupStart({ runners: _autoRunners, live: _autoLive, active: taskCtl.active, objective: objType })) {
    emit({ type: 'autonomous_dup_skipped', objective: objType, runners: _autoRunners });
    return null;
  }
  setObjective(world, { type: objType, status: 'in_progress' });
  saveWorld(worldFile, world);
  taskToken = taskCtl.begin('autonomous', stopMotion);
  // ⚠️ JETON CAPTURÉ (fix 18/08) : `taskToken` est un GLOBAL relu TARD. Si une autre tâche fait
  // `taskCtl.begin()` pendant qu'on attend (pause de retry NO_GIVE, récupération post-mort), le
  // global pointe sur le jeton NEUF, non annulé : ce vieux planner le prenait pour le sien et
  // repartait EN PARALLÈLE (runChain passait le global à runPlanner). Même classe que le « jeton de
  // génération » de startMapper. Plus AUCUNE lecture du global après cette ligne : myTok.
  const myTok = taskToken;
  _autoLive = { tok: myTok, objective: objType };
  // Ce runner est vivant jusqu'à son dernier await : migrateZone attend qu'il ait rendu la main
  // avant de marcher — sinon un startResource en retard, relisant le global, prendrait le jeton
  // VIVANT de la migration pour le sien (et irait jusqu'à clearObjective + resource_idle).
  _autoRunners++;
  try { return await runAutonomousBody(sender, objType, myTok); } finally { _autoRunners--; }
}

/** Corps de startAutonomous, séparé pour que `_autoRunners` l'encadre de bout en bout.
 *  Ne lit JAMAIS le global `taskToken` : uniquement `myTok`, le jeton de CE runner. */
async function runAutonomousBody(sender, objType, myTok) {
  _lastGoalAt = Date.now();   // watchdog : le compteur repart à chaque démarrage du planner
  _plannerParked = false;     // un planner repart : plus de « stop » joueur en vigueur
  _skelRushOwesPlanner = false;   // dette soldée
  _plannerOrphanSince = 0;
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
    if (!warped && !myTok.cancelled) {   // préemptés pendant le /back : pas de marche par-dessus
      await withTimeout(
        bot.pathfinder.goto(new pfGoals.GoalNear(d.x, d.y, d.z, 1)),
        90000, () => { try { stopMotion(); } catch (e) {} });
    }
    await sleep(1500); // laisser le pickup aspirer les items au sol
  } else if (lastDeath) {
    lastDeath = null; // inventaire conservé (keepInventory) → reprise directe
  }
  // Préemptés pendant la récupération (migration, ordre, nouveau spawn) : ne lancer AUCUN runner —
  // celui qui a pris la main gère la suite (startMapper/startResource relisent le global).
  if (myTok.cancelled) return;
  if (objType === 'mapper') return startMapper(); // rôle continu : jamais « done »
  if (objType === 'resource') return startResource(); // mine les ores EXPOSÉS de la carte du groupe
  // Cible diamant (24/10) : 192 par défaut, surchargée par l'objectif persisté (`target`).
  const chain = chainFor(objType, { diamondTarget: diamondTargetOf(world.objective) });
  const runChain = () => runPlanner(bot, {
    chain,
    // NUIT AU TRAVAIL : les buts de surface attendent l'aube, la chaîne continue.
    // + buts `optional` (pioche de rechange du diamant) ratés < 10 min : sautés, jamais un stall.
    skip: (g, ctx) => optionalGoalHeld(g) || nightSkipGoal(g, ctx),
    // Avant chaque but : déposer le kit de secours si c'est le moment (1 relevé/min, jamais de throw).
    runSkill: async (g) => {
      try { await stashKitIfReady(); } catch (e) { /* best-effort */ }
      const r = await runSkillWithTelemetry(g);
      noteOptionalGoalResult(g, r);
      return r;
    },
    ctxExtra,
    onStep: (g) => { _lastGoalAt = Date.now(); emit({ type: 'goal', name: g.name }); },
  }, myTok);
  let res = await runChain();
  // Run nether (mode sans-give uniquement, rétro-compat) : un stall (not_found passager, zone
  // momentanément stérile, proie absente) ne doit PAS figer le bot à vie — pause 90 s puis le
  // planner re-dérive depuis l'état RÉEL. Les morts/exits restent couverts par le self-healing.
  while (NO_GIVE && res && res.stalled && !myTok.cancelled) {
    emit({ type: 'autonomous_retry', goal: res.goal, in_s: 90 });
    // Pause INTERRUPTIBLE (fix 18/08) : une préemption pendant ces 90 s (migration, ordre) doit
    // libérer le runner tout de suite — migrateZone attend qu'il ait rendu la main pour marcher.
    for (let s = 0; s < 90 && !myTok.cancelled; s++) await sleep(1000);
    if (myTok.cancelled) return;
    res = await runChain();
  }
  if (myTok.cancelled) return; // préempté par une commande
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
    // `canGift` = MÊME test que le gate de `_giftContext` : sans /tpa dans la whitelist, aucun
    // cartographe ne peut être servi → un mappeur nu ne doit plus router vers `mapper_armor`,
    // sinon start → done → chain(mapper_armor→mapper_armor) → start… (48 cycles mesurés en live).
    // ⚠️ ET AVEC /tpa il faut une cible RÉELLE pour CE bot (fix 18/08 : ×47 791 cycles à vide —
    // mappeurs nus déjà réservés par des coéquipiers, livrés < 5 min, ou bot pas 4/4). Le routage
    // ET le filet anti-boucle (run à 0 skill qui reproposerait une chaîne à vide) vivent dans
    // goals.chainAfterDone (pur, testé) ; ici on ne fait qu'exécuter sa décision.
    const canTp = isAllowed('/tpa x', whitelist);
    const giftTarget = canTp ? freshGiftTarget() : null;
    const dec = chainAfterDone({
      objective: objType, steps: res.steps, mates: presence ? presence.list() : [],
      canTp, giftTarget, emptyDoneAt: _emptyDoneAt, now: Date.now(),
      latched: (() => { try { return _teamLatchActive(); } catch (e) { return false; } })(),
    });
    _emptyDoneAt = dec.emptyDoneAt;
    if (dec.releaseGift) releaseGiftTarget(giftTarget);   // on ne part pas l'armer : un coéquipier le pourra
    if (dec.skip) {
      emit({ type: 'autonomous_chain_skip', from: dec.skip.from, proposed: dec.skip.proposed,
        to: dec.skip.to, why: dec.skip.why, delay_s: Math.round(dec.delayMs / 1000) });
    }
    const nextObj = dec.next;
    if (nextObj) {
      setObjective(world, { type: nextObj, status: 'in_progress' });
      saveWorld(worldFile, world);
      emit({ type: 'autonomous_chain', from: objType, to: nextObj, steps: res.steps });
      // RELANCER LE MOTEUR : poser l'objectif ne suffit pas, la boucle du planner vient de se
      // terminer sur ce `done` et rien ne la rallume avant le prochain spawn. Mesuré live
      // (Massii : « neth 1 4 5 sont toujours immobiles ») : `autonomous_chain` émis, objectif
      // en poche, et 0 bloc parcouru en 45 s. setTimeout plutôt qu'un appel direct = pile
      // d'appels neuve ; la chaîne s'arrête d'elle-même (nextObjectiveAfter('diamond') → null).
      // Délai = 1,5 s, ou 60 s quand TOUT finirait à vide (backoff du filet). INTERRUPTIBLE : une
      // préemption pendant l'attente (migration, ordre, respawn) annule `myTok` → pas de relance
      // par-dessus — celui qui a pris la main gère la suite (avant ce fix, la relance l'écrasait).
      setTimeout(() => {
        if (myTok.cancelled) return;
        try {
          startAutonomous(null).catch((e) => emit({ type: 'error', message: String((e && e.message) || e) }));
        } catch (e) { /* best-effort */ }
      }, dec.delayMs);
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

// Génération du spawn (NIVEAU MODULE, piège #56) : un onSpawn d'une vie PASSÉE (encore en attente d'un
// abri, d'une fuite, de la base…) ne relance pas le planner par-dessus celui de la vie courante (22/10).
let _spawnGen = 0;
async function onSpawn() {
  const spawnGen = ++_spawnGen;
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
        const _objT = world.objective && world.objective.type;
        const role = _objT === 'mapper' ? 'mapper' : (_objT === 'lumberjack' ? 'lumberjack' : 'worker');
        // On publie AUSSI son état d'équipement : c'est ce qui permet aux coéquipiers de voir qui
        // a besoin d'aide (et de savoir quand tout le monde est équipé → séparation).
        // Les CARTOGRAPHES publient leur état eux aussi (26/07) : c'est la seule façon pour un
        // worker de savoir lesquels sont encore nus — et donc à qui porter une armure, puis quand
        // tout le monde est couvert et qu'on peut passer au diamant. Sans ça, `armor` était
        // absent des entrées mappeur et un mappeur équipé restait indistinguable d'un mappeur nu.
        // Aucun risque de régression : pickDonation et allArmored écartent déjà `role === 'mapper'`.
        let st = null;
        // Demande de bois (bûcheron d'équipe) : publiée tant qu'elle court ; retirée ici dès que les
        // bûches sont en poche (le bûcheron lit ce heartbeat pour savoir qui servir).
        try {
          loadWoodRequest();
          const invB = buildCtxInv(bot);
          if (_woodReq && woodEquiv(invB) >= _woodReq.want) {
            _woodReq = null;
            const nb = Object.assign({}, loadBaseState() || {}); delete nb.woodRequest; saveBaseState(nb);
          }
          st = teamStatus(invB, [..._wornArmor()], _woodReq);
          // QUELLES pièces manquent (pas seulement combien) : le bûcheron forge des pièces à l'unité
          // pour un cartographe (20/10 soir) — sans ce champ il lui forgerait un 2e casque.
          if (st) st.missing = missingIronPieces(invB, [..._wornArmor()]);
          // `worn` = pièces fer (ou mieux) PORTÉES (21/10) : critère d'éligibilité au rôle de bûcheron.
          // `armor` ne suffit pas — il compte aussi les pièces en poche.
          if (st) st.worn = wornIronCount([..._wornArmor()]);
          // `woodStock` (23/10) : bûches-équivalent en poche — le demandeur sait qu'un coéquipier peut le
          // dépanner quand aucun bûcheron n'est élu (lumberjack.peerWoodSupplier).
          if (st) st.woodStock = woodEquiv(invB);
          // Armure diamant (24/10 soir) : palier porté (diamant/mixte/fer/nu), pièces diamant portées, pièces
          // fer SAINES en poche, et « donneur » (armure diamant complète + ≥ 24 💎 + fer à céder) — lu par
          // pickDivertedMiner pour envoyer en priorité ce mineur armer un cartographe nu.
          if (st) {
            const _w = [..._wornArmor()];
            st.armorTier = armorTier(_w);
            st.diaWorn = diaWornCount(_w);
            st.spareIron = _giftPocket().good.length;
            st.ironDonor = isIronDonor({ diaWorn: st.diaWorn, diamonds: invB.diamond || 0, spareIron: st.spareIron });
          }
        } catch (e) {}
        // `y` + `ironZone` : c'est ce qui permet de distinguer un MINEUR AU TRAVAIL d'un bot qui
        // traîne en surface. Sans eux, `squadLeader` ne pouvait trancher qu'à l'alphabet — et si
        // le premier dans l'alphabet flânait, toute la squad remontait le rejoindre au lieu de
        // descendre miner (Massii, 27/07 : « ils se tp aux bots en surface donc ils ne descendent
        // jamais »). Ajoutés APRÈS le spread de `st` pour qu'ils ne puissent pas être écrasés.
        let _dia = 0;
        try { _dia = buildCtxInv(bot).diamond || 0; } catch (e) { _dia = 0; }
        presence.beat(Math.round(pB.x), Math.round(pB.z), role,
          Object.assign({}, st || {}, { y: Math.round(pB.y), ironZone: _zoneIronMined, diamonds: _dia,
            phaseLatched: _teamLatchActive() }));
      } catch (e) { /* best-effort */ }
    };
    _beatNow = _beat;
    _beat();
    setInterval(_beat, 60000);
    // BÛCHERON D'ÉQUIPE : élection / maintien de la claim `lumberjack` (cf. lumberjackTick).
    if (!IS_MAPPER && _teamClaims) setInterval(() => { lumberjackTick().catch(() => {}); }, LJ_TICK_MS);
    // PHASE D'ÉQUIPE (24/10) : team_phase / diamond_progress / retour diamant → mapper_armor.
    setInterval(() => { teamPhaseTick().catch(() => {}); }, TEAM_PHASE_TICK_MS);

    // ── ÉCLAIRAGE (capture réelle 26/07) : les humains posent 3-5 torches/min sous terre, le bot
    // n'éclairait que son tunnel de branch-mine. Or block-light 0 est la condition EXACTE
    // d'apparition des mobs : chaque couloir sombre qu'il laisse derrière lui devient un spawner.
    // Tick léger (8 s), 100 % local, best-effort — jamais bloquant.
    {
      let _torchLastAt = 0;
      let _torchLastPos = null;
      let _torchBusy = false;
      let _torchDarkSince = null;   // début de l'obscurité CONTINUE (escalier : torche seulement si elle dure)
      setInterval(async () => {
        if (_torchBusy || _stillBusy || _imminentBusy || _skelRushBusy || bot.targetDigBlock) return;
        const pT = bot.entity && bot.entity.position;
        if (!pT) return;
        try {
          const items = (bot.inventory && bot.inventory.items()) || [];
          const torches = items.filter((i) => i.name === 'torch').reduce((a, i) => a + i.count, 0);
          let light = null;
          try { const b = bot.blockAt(pT.floored()); if (b && typeof b.light === 'number') light = b.light; } catch (e) {}
          const _now = Date.now();
          if (light == null || light <= 3) { if (_torchDarkSince == null) _torchDarkSince = _now; }
          else _torchDarkSince = null;
          // RATIONNEMENT (Massii 24/10, « moins de torches ») : pas de torche à ≤ 11 blocs d'une autre
          // (galerie comprise — ce tick en reposait une 0,5 s après celle de branchMine), et pas
          // d'escalier jalonné : pendant une descente, seulement après 45 s de noir continu.
          if (!shouldPlaceTorch({
            y: pT.y, lightLevel: light, torches, now: _now,
            lastAt: _torchLastAt, pos: { x: pT.x, z: pT.z }, lastPos: _torchLastPos,
            nearestTorch: nearestTorchDist(bot, { x: pT.x, y: pT.y, z: pT.z }),
            stair: _stairDepth > 0, darkForMs: _torchDarkSince == null ? null : _now - _torchDarkSince,
          })) return;
          _torchBusy = true;
          const torch = items.find((i) => i.name === 'torch');
          const ref = bot.blockAt(pT.floored().offset(0, -1, 0));
          if (torch && ref && ref.boundingBox === 'block') {
            await bot.equip(torch, 'hand');
            await bot.placeBlock(ref, vec3Lib(0, 1, 0));
            _torchLastAt = Date.now();
            _torchLastPos = { x: pT.x, z: pT.z };
            try { sharedTorchRegistry.note({ x: Math.floor(pT.x), y: Math.floor(pT.y), z: Math.floor(pT.z) }); } catch (e) { /* best-effort */ }
            emit({ type: 'torch_placed', from: 'ambient', y: Math.round(pT.y), light, stair: _stairDepth > 0 });
          }
        } catch (e) { /* best-effort : sol impossible, pas grave */ }
        finally { _torchBusy = false; }
      }, 8000);
    }

    // ── DÉFENSE MUTUELLE : voler au secours d'un coéquipier attaqué (corps : teamAssistTick, au
    // niveau MODULE depuis la discipline de nuit du 19/10 — testé par extraction, piège #56).
    if (REGROUP && !IS_MAPPER) setInterval(() => { teamAssistTick(); }, 4000);

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
          // ⚠️ world_mn12 (28/07) : si CE worker assemble un set d'armure de cartographe
          // (`_giftTarget` réservé), son fer est EARMARKÉ — sans ça le team_gift le vidait vers les
          // stragglers avant qu'il réunisse les 24 lingots → mappeurs jamais armés (mesuré : 21
          // lingots drainés depuis mapper_armor, 0 set livré de toute la nuit). Le straggler
          // wood-softlock ne peut de toute façon pas forger ce fer (pas de table sans bois).
          const gift = pickDonation({
            self: { x: p.x, z: p.z }, selfName: bot.username, selfStatus: me,
            mates, now: Date.now(),
            opts: { reserve: _giftTarget ? GIFT_SET_INGOTS : 0 },
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
          await tryRegroup({ periodic: true });
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
    // PONTS ÉNORMES EN SURFACE (Massii 19/10 : « évite que les bots créent des ponts énormes en
    // surface, ça ne sert à rien »). Ce n'est PAS `placeCost` qu'on remonte (cf. plus haut : poser
    // trop cher partout a figé les bots, world_ax5) : on interdit la pose UNIQUEMENT là où elle ne
    // sert qu'à ponter — au-dessus d'un vide ≥ 3 blocs en surface, au-dessus de l'eau partout — via
    // `exclusionAreasPlace`, le crochet par bloc de la lib. Les TOURS 1×1 sont exemptées (l'A* voit
    // encore de l'air sous une tour en cours : sans exemption elle plafonnerait à 3 blocs, cf.
    // bridges.installBridgeGuard). withTempMovements recopie le garde-fou dans ses temporaires.
    // ⚠️ ET les Movements des PLUGINS : `collectBlock.collect` et `pvp.attack` posent LEUR Movements
    // d'usine (placeCost 1, eau `replaceable`) et ne rendent jamais la nôtre — sans garde-fou chez
    // eux, chaque collecte ou combat rouvrait la porte aux passerelles, sur l'eau comprise.
    {
      const bridgeAt = (p) => bot.blockAt(p, false);   // comme la lib : sans les extras (peintures)
      const on = {};
      for (const [who, m] of [
        ['nominal', moves],
        ['collectBlock', bot.collectBlock && bot.collectBlock.movements],
        ['pvp', bot.pvp && bot.pvp.movements],
      ]) {
        try { on[who] = installBridgeGuard(m, bridgeAt); } catch (e) { on[who] = false; }
      }
      emit(Object.assign({ type: 'bridge_guard_on' }, on));
      // LAVE (23/10 : 5 morts de mineurs en 30 min) : pas de pas au bord de la lave (pénalité, stricte en
      // fuite) et `safeToBreak` qui refuse de casser un bloc qui la retient — y compris dans la Movements de
      // collectBlock, qui remet `dontCreateFlow` à false à chaque collect. Mêmes 3 Movements que les ponts.
      const lavaOn = {};
      for (const [who, m] of [
        ['nominal', moves],
        ['collectBlock', bot.collectBlock && bot.collectBlock.movements],
        ['pvp', bot.pvp && bot.pvp.movements],
      ]) {
        try { lavaOn[who] = lavaGuard.installLavaGuard(m, bridgeAt); } catch (e) { lavaOn[who] = false; }
      }
      emit(Object.assign({ type: 'lava_guard_on' }, lavaOn));
    }
    // LA FUITE DE MOVEMENTS (19/10, décision : on la corrige) : `collectBlock.collect` et `pvp.attack`
    // posent LEUR Movements d'usine et ne rendent JAMAIS la nôtre — après la 1re récolte, tous les
    // trajets suivants partaient à placeCost 1 (probablement LA cause des ponts). Deux parades :
    //   1. nos réglages de sécurité RECOPIÉS dans leurs Movements (placeCost, liquidCost, replaceables
    //      sans eau/lave, échafaudage, blocs à éviter, chute max, parkour, tour, canDig) — copies
    //      profondes, aucun Set/tableau partagé : collectBlock remet dontCreateFlow /
    //      dontMineUnderFallingBlock à false chez LUI à chaque collect, ça ne touche pas la nominale ;
    //   2. la nominale RENDUE à la fin de chaque usage (collect enveloppé, `stoppedAttacking`), jamais
    //      pendant qu'un autre collect ou combat court. `_mcaMoves` = la Movements active légitime,
    //      fenêtre withTempMovements comprise : pas de conflit avec elle.
    // Le garde-fou anti-pont reste posé sur les trois (ci-dessus).
    if (!_pluginMovesInstalled) {
      _pluginMovesInstalled = true;
      const copied = {};
      try { copied.collectBlock = copySafetySettings(moves, bot.collectBlock && bot.collectBlock.movements).length; } catch (e) { copied.collectBlock = 0; }
      try { copied.pvp = copySafetySettings(moves, bot.pvp && bot.pvp.movements).length; } catch (e) { copied.pvp = 0; }
      let collect = false;
      let pvpWatch = false;
      try {
        _movesKeeper = createMovesKeeper({ bot, emit });
        collect = _movesKeeper.wrapCollect(bot.collectBlock);
        pvpWatch = _movesKeeper.watchPvp(bot);
      } catch (e) { /* best-effort : sans gardien, on retombe sur l'ancien comportement */ }
      emit({ type: 'moves_keeper_on', collect, pvp: pvpWatch, copied });
    }
    // OOM 23/10 (toolGuard.js) : collectBlock fait `bot.tool.equipForBlock(…, { getFromChest: true })` à
    // chaque bloc ; sans outil récoltant ET sans coffre, mineflayer-tool se rappelle à l'infini en
    // microtâches → tas plein en ~10 s, aucun timer, aucun event, process tué. La garde le fait lever NoItem.
    // `bot.tool` est créé par collectBlock (setTimeout 0 après l'injection) : présent au spawn. Idempotent.
    if (bot.tool && !_toolGuardSaid) {
      let ok = false;
      try { ok = installToolGuard(bot.tool, { onCapped: (i) => _capReport.report(i.where, { reason: i.reason, block: i.block }) }); } catch (e) { ok = false; }
      if (ok) { _toolGuardSaid = true; emit({ type: 'tool_guard_on', ok }); }
    }
    // BUTIN APRÈS COMBAT : posé APRÈS le gardien de Movements (watchPvp ci-dessus) — les écouteurs d'un
    // même event s'exécutent dans l'ordre d'enregistrement, la nominale est donc déjà rendue quand on
    // lance lootNearby. Une seule fois par process (garde de NIVEAU MODULE `_combatLootWired`).
    try { wireCombatLoot(); } catch (e) { /* best-effort : sans ça, comportement d'avant */ }
    try { wireFoodDropSweep(); } catch (e) { /* best-effort */ }
    // DISJONCTEUR DE COMBAT (22/10) : mineurs seulement — les cartographes gardent leur fuite par défaut.
    if (!IS_MAPPER) {
      try { wireFightBreaker(); } catch (e) { emit({ type: 'fight_breaker_wire_failed', err: String(e && e.message || e) }); }
    }
    bot.pathfinder.setMovements(moves);
    // ANTI-OOM (crash live 25/07 : NethBot2 → 2 Go de heap en 38 s → FATAL heap out of memory,
    // juste après `survival:flee`). mineflayer-pathfinder livre `searchRadius = -1` = espace de
    // recherche ILLIMITÉ ; couplé au GoalInvert de fleeFrom (heuristique négative → s'éloigner
    // fait TOUJOURS baisser f), un but insatisfiable (bot acculé) fait exploser l'A* jusqu'à
    // l'OOM. Le think-timeout de 5 s ne protège pas : 5 s suffisent à allouer des Go.
    // Budget de détour, pas rayon absolu (cf. movement.js) → les longs trajets restent intacts.
    applyPathfinderBounds(bot.pathfinder);
    // DIAG GoalChanged (cf. goalTrace.js) : on compte QUI appelle setGoal et si l'appel INTERROMPT un but
    // actif. Une seule fois par process (garde de NIVEAU MODULE, la 1re tentative suffit). `goal_trace_on`
    // dit si le wrapper est réellement posé : sans lui, l'absence d'event `goal_trace` serait ambiguë
    // (aucun setGoal posé vs instrumentation absente).
    if (!_goalTraceInstalled) {
      _goalTraceInstalled = true;
      let traced = false;
      try { traced = installGoalTrace(bot.pathfinder, _goalTrace); } catch (e) { /* diag : jamais bloquant */ }
      emit({ type: 'goal_trace_on', ok: traced });
    }
    // VERROU DE BUT (fuite creeper, 20/10) : posé PAR-DESSUS goalTrace → un appel ignoré pendant une
    // fuite n'est pas compté comme une interruption. Une fois par process (pathfinder persistant).
    if (!_goalHoldInstalled) {
      _goalHoldInstalled = true;
      let held = false;
      try { held = installGoalHold(bot.pathfinder, _creeperHold); } catch (e) { /* jamais bloquant */ }
      emit({ type: 'goal_hold_on', ok: held });
    }
    // SPRINT « vrai joueur » (Massii 2026-06-22) : `allowSprinting` laisse pathfinder sprinter
    // SEULEMENT sur de longs trajets droits → en minage (déplacements courts) le bot ne sprintait
    // quasi jamais (lent + tell). Garde tick : on FORCE le sprint dès qu'on avance sur la terre
    // ferme (faim ok, pas minage/eau/sneak). Décision pure dans movement.js (testée), état lu ici.
    // Dans le bloc bootDone → 1 seul interval par connexion (pas de fuite au respawn).
    //
    // RÉSERVE DE FAIM (Massii 18/08, suite directe — caution.sprintAllowed) : `shouldSprint`
    // ci-dessous ne coupe qu'au plancher DUR du serveur (6/7) — trop tard, la réserve nécessaire à
    // la régén de PV (hard, faim≥18) est déjà vide (mesure world_mn15 : sprint_one_cm = 2,2 à 2,5
    // millions de cm/bot, walk_one_cm ~10× moindre → morts « starved to death » en série). On coupe
    // donc PROACTIVEMENT dès 12 (hystérésis +2, reprise à 14).
    // Forcer `setControlState('sprint', false)` ICI NE SUFFIT PAS : mineflayer-pathfinder a son
    // PROPRE handler sur 'physicsTick' (monitorMovement, node_modules/mineflayer-pathfinder/
    // index.js:614) qui RALLUME le sprint tout seul dès qu'il voit une ligne droite ET que
    // `Movements.allowSprinting` est vrai — indépendant de la faim, et physicsTick (~50ms) est PLUS
    // FRÉQUENT que ce tick (150ms) : notre `false` était donc écrasé avant le tour suivant, ce qui
    // explique que le sprint ne s'arrêtait quasi jamais malgré `shouldSprint`. On coupe donc AUSSI
    // `bot._mcaMoves.allowSprinting` le temps de l'épisode (état d'origine mémorisé pour la
    // restauration exacte — certains rôles pourraient l'avoir différent de `true`).
    // Pas d'exemption fuite : `fleeFrom` (skills/fleeFrom.js) ne pose qu'un but pathfinder, aucun
    // flag identifiable côté bot pour distinguer « fuit un hostile » d'un trajet normal — donc une
    // fuite en cours reste sprint-coupée sous 12 de faim. Accepté : la plupart des hostiles de
    // mêlée (zombie, squelette) se déplacent à la vitesse de MARCHE d'un joueur, pas plus vite ;
    // perdre le sprint réduit la marge mais ne cloue pas le bot sur place, et le plancher dur
    // vanilla (6/7) aurait de toute façon coupé cette même fuite un peu plus tard.
    setInterval(() => {
      try {
        const ent = bot.entity;
        if (!ent) return;
        const wasCurbed = !!bot._sprintCurbEpisode;
        const foodOk = sprintAllowed({ food: bot.food, curbed: wasCurbed });
        if (!foodOk) {
          if (!wasCurbed) {
            bot._sprintCurbEpisode = true;
            // état d'origine mémorisé AVANT de l'écraser (certains rôles pourraient l'avoir à false)
            bot._sprintCurbOrigAllow = bot._mcaMoves ? bot._mcaMoves.allowSprinting : true;
            if (bot._mcaMoves) bot._mcaMoves.allowSprinting = false;
            emit({ type: 'sprint_curbed', food: bot.food });
          }
          if (bot.getControlState('sprint')) bot.setControlState('sprint', false);
          return;
        }
        if (wasCurbed) {
          bot._sprintCurbEpisode = false;
          if (bot._mcaMoves) bot._mcaMoves.allowSprinting = bot._sprintCurbOrigAllow;
          emit({ type: 'sprint_restored', food: bot.food });
        }
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
    const _reflexHooks = {
      emit,
      // Sous terre dans un couloir : tenir/murer au lieu de courir dans le noir (tunnelAwareFlee).
      fleeFrom: tunnelAwareFlee,
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
                   placed: (r && r.placed) || 0, ok: !!(r && r.ok), ...coverWhy(r) });
            if (!r || !r.ok) { try { fleeFrom(bot); } catch (e) {} }
          } catch (e) { try { fleeFrom(bot); } catch (e2) {} }
        })();
      },
      // RÉPONSE AU SQUELETTE (22/10) : mineurs seulement. Situation non confirmée (creeper, mêlée arrivée
      // entre-temps) → repli sur le comportement d'avant (fuite tunnel-aware / riposte / tir à distance).
      onSkeleton: IS_MAPPER ? undefined : (foe, from) => {
        let dec = null;
        try { dec = skeletonRespond(foe, from); } catch (e) { dec = null; }
        if (dec) return;
        try {
          if (from === 'riposte' && _reflexHooks.attack) _reflexHooks.attack(foe);
          else if (from === 'ranged' && _reflexHooks.onRanged) _reflexHooks.onRanged(foe);
          else tunnelAwareFlee(bot);
        } catch (e) { emit({ type: 'skeleton_fallback_failed', from, err: String((e && e.message) || e).slice(0, 120) }); }
      },
      // MAPPEUR (Massii live 2026-07-15) : riposte mêlée à portée de coup only (3) ; canardé → fuit.
      meleeRadius: IS_MAPPER ? 3 : undefined,
      preferFlee: IS_MAPPER,
      // Enterré dans l'abri : ni fuite ni poursuite, frappe sur place (live 22/10, NethBot1 session 206).
      holdPosition: shelterHoldNow,
      strikeInPlace,
      // DISJONCTEUR (22/10) : la riposte réflexe passe par la même porte que tout engagement (mineurs).
      canEngage: () => { const d = fightGateDeps(); return d.canEngage ? d.canEngage() : { ok: true }; },
      onFlee: (r) => { const d = fightGateDeps(); if (d.onFlee) d.onFlee(r); },
      // DUEL CONTRE UN ZOMBIE (23/10) : mineurs seulement (le cartographe garde sa fuite par défaut).
      isDuel: () => !IS_MAPPER && _fightBreakerWired && _fightSituation().duel,
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
        // Sur le pilier anti-mêlée : pas de mur autour d'un perchoir (et pas de stopMotion) — manger seulement.
        if (_meleePillar) { Promise.resolve().then(() => eat(bot)).catch(() => {}); return; }
        panicInFlight = true;
        (async () => {
          // DANS L'EAU : « si ils sont en train de suffoquer ça sert à rien de se faire un box en
          // pierre, ils doivent nager vers le haut » (Massii 2026-07-26). onPanic ne regardait pas
          // l'eau : à PV critiques en train de se noyer, le bot se murait — d'où les « box en pierre
          // à des moments aléatoires » vus à l'écran. Un mur ne rend pas d'oxygène.
          let wet = false;
          try { wet = isInWater(bot); } catch (e) {}
          if (wet) {
            skeletonRushYield('panic_swim');
            emit({ type: 'panic_swim_up' });
            try { bot.setControlState('jump', true); } catch (e) {}   // remonter TOUT DE SUITE
            try { await withTimeout(escapeWater(bot, { emit }), 8000, () => {}); } catch (e) {}
            try { await withTimeout(eat(bot), 2500, () => {}); } catch (e) {}
            return;
          }
          try { stopMotion({ force: true, vital: 'panic_wall' }); } catch (e) {}
          // panicWall (module dédié, hole C) : mur ROBUSTE même en grotte ouverte (pontage sur le
          // bloc-sol du bot) — l'ancien inline échouait en silence là où les mobs essaiment.
          try { await withTimeout(panicWall(bot), 3000, () => { try { stopMotion({ force: true, vital: 'panic_wall' }); } catch (e) {} }); } catch (e) { /* best-effort */ }
          try { await withTimeout(eat(bot), 2500, () => {}); } catch (e) {}
        })().finally(() => { panicInFlight = false; });
      },
      // POSTURE DÉFENSIVE à ~10 PV (hole C — AVANT le seuil critique) : équipe + lève le bouclier
      // brièvement (réduit les dégâts entrants). La riposte mêlée et onRanged gèrent l'agresseur.
      onDefensive: (threat) => {
        // Squelette : la réponse dédiée (rush / cover / block) remplace muret + bouclier génériques.
        if (!IS_MAPPER && threat && RANGED.has(threat.name)) {
          try { if (skeletonRespond(threat, 'defensive')) return; } catch (e) {}
        }
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
                       dist: Math.round(dist), placed: (rc && rc.placed) || 0, ok: !!(rc && rc.ok), ...coverWhy(rc) });
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
                     placed: (r && r.placed) || 0, ok: !!(r && r.ok), ...coverWhy(r) });
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
          // MIGRATION EN COURS (fix 18/08) : nager oui — c'est vital —, warper NON. /home safe (ou le
          // relocate admin) ramènerait le marcheur à l'ANCIENNE base, la zone qu'on vient de juger
          // morte : le trek serait perdu (`moved: 0`) et la migration jugée en échec.
          if (_migrating) {
            emit({ type: 'water_rescue_no_warp', ctx: 'migration', drowning });
            try { await escapeWater(bot, { emit }); } catch (e) { /* best-effort */ }
            return;
          }
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
              // HOME CAMPÉ (live 19/10, MapBot2 : water_rescue_warp:drowning > water_rescue_home_safe > … >
              // mort) : se sauver de la noyade en se téléportant dans le camp qui vient de nous tuer n'est
              // pas un sauvetage. Le repli reste celui d'un safe refusé : NAGER vers la rive.
              if (safeHomeVeto('drowning')) {
                emit({ type: 'water_rescue_no_warp', ctx: 'camped' });
                try { await escapeWater(bot, { emit }); } catch (e) {}
                return;
              }
              // WARP FUTILE (run 12, NethBot2 : water_rescue_warp:drowning toutes les 3-10 s, /home safe le
              // ramenait dans la MÊME eau) : un warp de noyade il y a < 60 s n'a pas sorti le bot → NAGER
              // (escapeWater : rive, sinon pilier) au lieu de re-warper au même endroit.
              if (Date.now() - _lastDrownWarpAt < DROWN_WARP_RETRY_MS) {
                emit({ type: 'water_rescue_no_warp', ctx: 'warp_futile' });
                try { await escapeWater(bot, { emit, timeoutMs: 20000 }); } catch (e) {}
                return;
              }
              _lastDrownWarpAt = Date.now();
              emit({ type: 'water_rescue_home_safe' });
              abandonWorkIfDrowned();                     // chantier noyé ? → l'oublier (sinon /home work y ramène)
              await safeWarpHome('safe', { ctx: 'drowning' });   // float+immobile pendant l'éventuel warmup
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
                else if (safeHomeVeto('water_rescue')) { emit({ type: 'water_rescue_no_warp', ctx: 'camped' }); try { await escapeWater(bot, { emit }); } catch (e) {} }
                else { emit({ type: 'water_rescue_home_safe' }); abandonWorkIfDrowned(); await safeWarpHome('safe', { ctx: 'water_rescue' }); }
              } else await relocateToRegion({ nearSpawn: true });   // bug #4 : vers le SEC near-spawn (admin)
            }
          } else {
            waterEscapeFails = 0;   // sortie réussie → on reste au fond, pas de warp
          }
        })()
          .catch(() => {})
          .finally(() => { waterRescue = null; });
      },
    };
    installReflexes(bot, _reflexHooks);
    installFillCap();   // plafond de remblai : jamais 10 piles de cobble en poche (23/10)
    try { wireEatLock(); } catch (e) { emit({ type: 'eat_lock_wire_failed', err: String((e && e.message) || e) }); }
    if (!IS_MAPPER) { try { wireSkeletonHurt(); } catch (e) { emit({ type: 'skeleton_hurt_wire_failed', err: String((e && e.message) || e) }); } }
    // TÉLÉPORTATION (#10) : détecte tout TP (admin /tp, /home, portail, respawn) → émet
    // teleport_detected{from,to} + ABANDONNE le goal pathfinder (il visait l'ancienne position —
    // jamais y retourner à pied). Le mapper consomme le pending pour se ré-ancrer (mapper.js).
    tpWatch.anchor(bot.entity && bot.entity.position);
    wireTeleportDetection(bot, tpWatch, {
      emit,
      onTeleport: () => { try { stopMotion(); } catch (e) {} _floatSettleUntil = Date.now() + 15000; _tpCount++; },
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
            // HOME CAMPÉ (19/10) : l'ancre EST le home `safe` (CONFINE_HOME) — jamais posée dans un camp
            // (≥ 2 morts récentes à ≤ 24 blocs) : ce /sethome DÉPLACERAIT un home qui marche dans le piège.
            // Le watchdog repasse chaque seconde : on s'ancrera dès la première position stable hors du camp.
            if (nearStatic && !_campedAt(pA) && homewarp.bookmark(bot, CONFINE_HOME)) {
              _anchorSet = true;
              noteSafeHome(pA, 'anchor');   // le /sethome safe ci-dessus DÉPLACE le home : le veto doit le savoir
              if (!CONFINE && !IS_MAPPER) _confineDyn = { x: Math.round(pA.x), z: Math.round(pA.z), radius: DEFAULT_CONFINE_RADIUS };   // cartographe : le home oui, la poche non
              const eff = CONFINE || _confineDyn;
              if (eff) {   // null pour un cartographe (pas de poche) : home posé, ni borne ni confine
                bot._mcaExploreBounds = { x: eff.x, z: eff.z, radius: Math.max(eff.radius * 2, 128) };  // borne explore = poche confine (#54)
                emit({ type: 'confine_anchored', x: eff.x, z: eff.z, radius: eff.radius, static: !!CONFINE });
              }
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
            const okR = homewarp.bookmark(bot, 'safe');
            const pR = bot.entity.position;
            if (okR) delete _homeRefusedAt.safe;
            if (okR) noteSafeHome(pR, 'reset');   // y ≥ 58 vérifié ci-dessus → safe de surface
            emit({ type: 'safe_home_reset', x: Math.round(pR.x), y: Math.round(pR.y), z: Math.round(pR.z) });
          }
          const s = imminentState();
          // Verdict DÉGRADÉ si le /home safe vient d'être refusé ou si le home est campé : cf.
          // imminentVerdictNow (niveau module). `early` = bande essaim 6-10 PV (homewarp.swarmEscapeEarly).
          const { verdict, early } = imminentVerdictNow(s);
          if (!verdict) return;
          _imminentBusy = true;
          // CAMP DE MORT (piste n°2) : ≥2 alertes espacées dans la même zone 64 → bannie + FUITE
          // active (vécu Bot2 : 25× imminent au même spot, il RESTAIT sous les coups des mobs armés).
          // La bande essaim (early) n'est pas une alerte « à une seconde de mourir » : elle ne compte pas.
          if (!early) {
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
            emit({ type: 'imminent_escape', hp: s.health, inWater: s.inWater, lava: s.lavaNear, hostiles: s.nearbyHostiles,
                   ...(early ? { early: true, armor: s.armorPieces } : {}) });
            try { stopMotion({ force: true, vital: s.lavaNear ? 'lava_escape' : (s.inWater ? 'drown_escape' : 'imminent_escape') }); } catch (e) {}
            safeWarpHome('safe', { ctx: 'imminent' }).catch(() => {});
            setTimeout(() => { _imminentBusy = false; }, 12000); // secure (≤6 s) + warmup (≤9 s), anti-spam
          } else if (verdict === 'escape_no_warp') {
            emit({ type: 'imminent_escape_no_warp', hp: s.health, inWater: s.inWater });
            try { stopMotion({ force: true, vital: s.inWater ? 'drown_escape' : 'imminent_escape' }); } catch (e) {}
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
  // reprendre. AWAIT volontaire et placé EN TÊTE : tout ce qui suit dans onSpawn (base, dette de
  // mort, /tpa de regroupement, planner autonome) attend la fin de la fuite — sinon le bot
  // repartirait travailler à portée d'arc du campeur. Voir escapeDeathCamp : en sans-give c'est
  // une fuite À PIED, et le /spawnpoint n'est reposé qu'une fois au calme.
  // + PREMIÈRES SECONDES (run 10, 20/10) : nu ET un hostile à ≤ 12 blocs dans les 4 s qui suivent le
  // spawn → on se TERRE (puits + toit) au lieu de courir ; de nuit, nu, un camp ne se fuit plus à
  // découvert non plus. guardSpawn observe, décide (unstuck.spawnGuardPlan) et CONSOMME `_escapeOnSpawn`
  // — une seule décision par spawn, quelle que soit la raison (rafale, historique hérité, danger vu).
  let _guard = null;
  try { _guard = await guardSpawn(); } catch (e) { /* best-effort : jamais bloquer le respawn */ }
  // Sorti d'un camp de réapparition (tpa/fuite) : la base est presque toujours DANS ce camp (NethBot1 23/10 :
  // base 24,-604, camp 5,-605) — le /home safe du retour de base l'y renverrait aussitôt.
  const _campRescued = !!(_guard && _guard.campRescue);
  // KIT DE SECOURS (run 10) : nu, près de son coffre, zone saine → reprendre le kit AVANT la base, la
  // dette et le planner (qui sinon repartirait au bois). No-op sous keepInventory ON (pioche gardée).
  try { await restoreStashIfUseful(); } catch (e) { /* best-effort */ }
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
      // ⚠️ Pas d'adoption si le serveur a dit que `safe` n'existe pas (20/10, NethBot1) : adopter un home
      // fantôme, c'est compter sur un filet qui n'existe pas — le watchdog le re-posera à la 1re surface.
      const _safeGone = !!(st0 && Number.isFinite(st0[SAFE_MISSING_MEMO_KEY]));
      if (_safeGone && !_homeMissingAt[HOME_SAFE]) _homeMissingAt[HOME_SAFE] = st0[SAFE_MISSING_MEMO_KEY];
      if (st0 && st0.base && Number.isFinite(st0.base.x) && !_safeHomeSet && !_safeGone) {
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
    // 'safe' = cible de goSpawn : posé TOUJOURS (jamais mouillé), amélioré dès une vraie surface — et
    // jamais re-posé DANS un camp (home campé, live 19/10). Détail et historique : poseSafeHomeAtSpawn.
    poseSafeHomeAtSpawn();
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
      if (act === 'return' && _campRescued) {
        emit({ type: 'base_return_skipped', reason: 'respawn_camp_rescue' });
      } else if (act === 'return') {
        // goHome passe par le veto du home campé (19/10) : base campée la nuit → on reste où l'on a respawné.
        // ATTENDRE l'atterrissage (live 21/10, NethBot3 session 48) : sans lui le planner partait dans la
        // milliseconde, l'abri de nuit commençait à creuser AU SPAWN, et le téléport 29 ms plus tard laissait
        // `bot.dig` attendre pour toujours un bloc resté à 400 blocs (10+ min de gel, cf. digBound).
        if (homewarp.goHome(bot, HOME_SAFE, { ctx: 'base_return' })) {
          emit({ type: 'base_return' });
          try { await awaitWarp({ maxMs: 6000 }); } catch (e) { /* best-effort : l'abri sait aussi sortir d'un téléport */ }
        }
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
  if (spawnGen !== _spawnGen) {   // une vie plus récente a son propre onSpawn : elle reprend, pas nous
    emit({ type: 'spawn_superseded', gen: spawnGen, current: _spawnGen });
    return;
  }
  if (world.objective && world.objective.status === 'in_progress') {
    emit({ type: 'autonomous_resume', objective: world.objective.type });
    // jam_loop RÉPÉTÉ au même endroit (20/10, NethBot1 : 4 sessions emmuré à y 40) : escalier d'abord,
    // le planner repart à la sortie (digOutAndResume le relance, succès ou échec).
    if (!digOutAtSpawnIfLooping()) startAutonomous(null, { fromSpawn: true });
  }
}

/** Au spawn : 2e jam_loop récent à ≤ 4 blocs d'ici (mémo de base) → escalier. true si lancé. */
function digOutAtSpawnIfLooping() {
  try {
    const p = bot.entity && bot.entity.position;
    if (!p || !jamLoopAtStart(loadBaseState(), { x: p.x, y: p.y, z: p.z }, Date.now())) return false;
    emit({ type: 'jam_loop_repeat', x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
    return kickDigOut('jam_loop_repeat');
  } catch (e) { return false; }
}

// Ramasse les items tombés autour de la position courante. Borné (temps + nb) pour ne pas geler.
// Le goto de CHAQUE objet est rogné par ce qui reste du budget (19/10 : un balayage de 8 s dont le
// dernier goto pouvait durer 15 s n'était pas borné à 8 s).
// `opts.abortOnFail` (défaut FAUX = comportement historique) : un goto qui ÉCHOUE (inatteignable, ou un
// autre système a pris le pathfinder) abandonne le ramassage. `withTimeout` ne rejette jamais, le
// `catch` d'origine ne servait donc à rien et on re-tentait le MÊME objet (toujours le plus proche)
// jusqu'à maxItems fois. Les appels BUDGÉTÉS de la sortie nourriture (balayage, butin après combat)
// l'activent : s'acharner sur un objet inatteignable y mange tout le budget, et se battre pour le
// pathfinder avec un autre système est exactement le bug de classe n°1 du 19/10. La récupération des
// objets de mort garde l'ancien comportement : un échec passager n'y doit pas abandonner le butin.
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
      const gotoMs = Math.max(1500, Math.min(15000, deadline - Date.now()));
      let r;
      try {
        r = await withTimeout(
          bot.pathfinder.goto(new pfGoals.GoalNear(e.position.x, e.position.y, e.position.z, 1)),
          gotoMs, () => { try { stopMotion(); } catch (er) {} });
      } catch (er) { break; }   // inatteignable → on abandonne le ramassage (best-effort)
      if (opts.abortOnFail && r && r.ok === false) break;
      await sleep(600);          // laisse la collecte auto (proximité) opérer
      got++;
    }
  } catch (e) { /* best-effort */ }
  return got;
}

// ── BUTIN APRÈS UN COMBAT (Massii 19/10 : « dans le pire des cas, il y a la viande de zombie »).
// `bot.pvp` ne ramasse RIEN : la chair putréfiée d'un zombie (2 points de faim, de quoi tenir) et la
// ficelle d'une araignée (la canne qui débloque la pêche) restaient au sol. À la fin d'un combat contre
// un HOSTILE, si la voie est libre, on ramasse ce qui est tombé autour (≤ 6 blocs, 4 objets, 5 s).
// La décision « maintenant ? » est PURE et testée (food.shouldLootAfterCombat). Le pathfinder n'a qu'UN
// but : poser le nôtre vole le trajet en cours (GoalChanged, la classe de bug n°1 du 19/10), d'où
// les gardes — jamais pendant une migration, jamais avec un hostile à ≤ 8 blocs, et si un AUTRE trajet
// est en cours seulement pour un objet à ≤ 4 blocs. Seul un HOSTILE tué ouvre la porte : le gibier
// chassé a déjà son propre ramassage (huntPassive), lui faire concurrence = deux goto qui se volent la
// place. NB : `stoppedAttacking` part aussi de stopMotion() — la cible relevée à `startedAttacking`
// (et non lue à l'arrivée de l'event : mineflayer-pvp l'a déjà vidée) dit de QUEL combat il s'agit.
function wireCombatLoot() {
  if (_combatLootWired) return false;
  _combatLootWired = true;
  bot.on('startedAttacking', () => {
    try {
      const t = bot.pvp && bot.pvp.target;
      _combatTarget = t ? { name: t.name, kind: t.kind, type: t.type } : null;
    } catch (e) { _combatTarget = null; }
  });
  bot.on('stoppedAttacking', () => {
    const target = _combatTarget;
    _combatTarget = null;
    lootAfterCombat(target).catch(() => { /* best-effort */ });
  });
  return true;
}

/** Rattrapage (25/10) : la chair d'un zombie tué pendant qu'un autre était encore là n'était jamais reprise. Une fois par process. */
function wireFoodDropSweep() {
  if (_foodDropSweepWired) return false;
  _foodDropSweepWired = true;
  const t = setInterval(() => { sweepFoodDrop().catch(() => { /* best-effort */ }); }, 4000);
  if (t && t.unref) t.unref();
  return true;
}

/**
 * Balayage des drops COMESTIBLES (chair de zombie, viande, ficelle) laissés au sol (food.pickFoodDrop).
 * Mêmes gardes que le butin post-combat (shouldLootAfterCombat, cible « hostile » implicite) + jamais
 * pendant une casse de bloc ni un combat : il ne vole un trajet en cours que pour un objet à ≤ 4 blocs.
 */
async function sweepFoodDrop() {
  if (_combatLootBusy || Date.now() - _foodDropSweepAt < 4000) return;
  const me = bot.entity && bot.entity.position;
  if (!me || bot.isAlive === false || bot.targetDigBlock) return;
  let drops = [];
  try {
    drops = homewarp.dropsWithin(bot.entities, me, FOOD_DROP_RADIUS).map((d) => {
      let name = null;
      try { const it = d.entity.getDroppedItem && d.entity.getDroppedItem(); name = it ? it.name : null; } catch (e) { name = null; }
      return { name, dist: d.dist, entity: d.entity };
    }).filter((d) => !(d.entity && d.entity._mcaSweepTried));   // une tentative par objet : jamais de boucle sur un drop inatteignable
  } catch (e) { drops = []; }
  const pick = pickFoodDrop(drops);
  if (!pick) return;
  let hostilesNear = false;
  try { hostilesNear = nearbyHostiles(bot, COMBAT_LOOT_HOSTILE_RADIUS).length > 0; } catch (e) { hostilesNear = true; }
  let inWater = false;
  try { inWater = isInWater(bot); } catch (e) { inWater = false; }
  const owner = taskCtl.active;
  const verdict = shouldLootAfterCombat({
    target: { kind: 'Hostile mobs' },
    hostilesNear,
    migrating: _migrating,
    busy: !!(_imminentBusy || panicInFlight || _armorBusy || _baseBusy || _escaping || _deathDebtBusy || inWater
      || (bot.pvp && bot.pvp.target) || (owner && owner !== 'autonomous')),
    goalActive: !!(bot.pathfinder && bot.pathfinder.goal),
    dropDist: pick.dist,
  });
  if (!verdict.go) return;
  const ent = (drops.find((d) => d.name === pick.name && d.dist === pick.dist) || {}).entity;
  if (!ent || !ent.position) return;
  _combatLootBusy = true;
  _foodDropSweepAt = Date.now();
  try { ent._mcaSweepTried = true; } catch (e) {}
  try {
    await withTimeout(bot.pathfinder.goto(new pfGoals.GoalNear(ent.position.x, ent.position.y, ent.position.z, 1)),
      4000, () => { try { stopMotion(); } catch (e) {} });
    await sleep(400);
    emit({ type: 'food_drop_swept', item: pick.name, dist: Math.round(pick.dist) });
  } catch (e) { /* inatteignable : tant pis */ } finally { _combatLootBusy = false; }
}

// ─── DISJONCTEUR DE COMBAT (22/10, cf. fightBreaker.js) ─────────────────────────────────────────────
// Mesure live : `fight_chosen {hostiles:2, health:14.12}` → `imminent_bookmark_death hp:1.3` 3 s plus
// tard ; une fois engagé, plus rien ne regardait les PV fondre. Trois points d'appui, UN état :
//   1. event `health` + `startedAttacking` : chute ≥ 6 PV en 4 s ou PV < 10 pendant un combat contre un
//      HOSTILE → pvp.stop + fuite + event `fight_aborted` ;
//   2. `bot.pvp.attack` enveloppé : TOUT engagement (réflexes, ticks de survie, planner, tunnelGuard,
//      combats de skills) passe par `canEngage` — refus (abandon < 8 s, PV trop bas pour le nombre) →
//      pas d'attaque, fuite ; acculé (la fuite n'avance pas, mob collé) → le combat est permis ;
//   3. `fightGateDeps()` pour les ticks de survie : le refus y devient une fuite étiquetée.
// Le gibier (vache, cochon…) n'est jamais concerné : seuls les hostiles (isFleeHostile) le sont.
function _fightSituation() {
  let hostiles = 0;
  let nearestDist = null;
  const names = [];
  try {
    const list = nearbyHostiles(bot, 10);
    const me = bot.entity && bot.entity.position;
    for (const h of list) {
      if (!h || !h.position) continue;
      names.push(h.name);
      if (h.name !== 'creeper') hostiles++;
      if (me) {
        const d = Math.hypot(h.position.x - me.x, h.position.y - me.y, h.position.z - me.z);
        if (Number.isFinite(d) && (nearestDist == null || d < nearestDist)) nearestDist = d;
      }
    }
  } catch (e) { /* lecture best-effort */ }
  // DUEL CONTRE UN ZOMBIE (23/10, fightBreaker.isZombieDuel) : un seul hostile (creeper compris), de la
  // famille zombie, arme ≥ épée de pierre → engagement jusqu'à 6 PV et pas de coupure sur la chute.
  let duel = false;
  try { duel = isZombieDuel({ names, attackDamage: attackDamage(bot) }); } catch (e) { duel = false; }
  return { hostiles, nearestDist, duel };
}

function _fightCanEngage() {
  const sit = _fightSituation();
  const p = bot.entity && bot.entity.position;
  return _fightBreaker.canEngage({ t: Date.now(), pos: p ? { x: p.x, y: p.y, z: p.z } : null, health: bot.health, hostiles: sit.hostiles, nearestDist: sit.nearestDist, duel: sit.duel });
}

function _fightNoteFlee(ok) {
  const p = bot.entity && bot.entity.position;
  _fightBreaker.noteFlee({ t: Date.now(), pos: p ? { x: p.x, y: p.y, z: p.z } : null, fleeOk: ok !== false, health: bot.health });
}

/** Dépendances du disjoncteur pour survivalTick (vide pour un cartographe : comportement inchangé). */
function fightGateDeps() {
  if (IS_MAPPER || !_fightBreakerWired) return {};
  return {
    canEngage: () => { try { return _fightCanEngage(); } catch (e) { return { ok: true }; } },
    onFlee: (r) => { try { _fightNoteFlee(r && r.ok); } catch (e) {} },
  };
}

function _fightInProgress() {
  try {
    const t = bot.pvp && bot.pvp.target;
    return !!(t && isFleeHostile(t));
  } catch (e) { return false; }
}

function _fightBreakerCheck() {
  if (!_fightInProgress()) return;
  const t = Date.now();
  const sit = _fightSituation();
  const r = _fightBreaker.check({ inFight: true, health: bot.health, t, duel: sit.duel });
  if (!r.abort) return;
  try { if (bot.pvp && typeof bot.pvp.stop === 'function') bot.pvp.stop(); }
  catch (e) { emit({ type: 'fight_abort_stop_failed', err: String(e && e.message || e) }); }
  let fleeOk = false;
  try { fleeOk = skeletonFirstFlee(bot, 'fight_abort') !== false; }
  catch (e) { fleeOk = false; emit({ type: 'fight_abort_flee_failed', err: String(e && e.message || e) }); }
  const p = bot.entity && bot.entity.position;
  _fightBreaker.noteAbort({ t, pos: p ? { x: p.x, y: p.y, z: p.z } : null, fleeOk, health: bot.health });
  emit({ type: 'fight_aborted', hp: Math.round((bot.health || 0) * 10) / 10, drop: Math.round(r.drop * 10) / 10,
    hostiles: sit.hostiles, reason: r.reason, flee: fleeOk, y: p ? Math.round(p.y) : null, duel: sit.duel });
}

function wireFightBreaker() {
  if (_fightBreakerWired) return false;
  if (!bot.pvp || typeof bot.pvp.attack !== 'function') return false;
  _fightBreakerWired = true;
  try { _fightBreaker.sample(bot.health, Date.now()); } catch (e) {}
  bot.on('health', () => {
    try { _fightBreaker.sample(bot.health, Date.now()); _fightBreakerCheck(); }
    catch (e) { emit({ type: 'fight_breaker_error', err: String(e && e.message || e) }); }
  });
  bot.on('startedAttacking', () => {
    try { _fightBreakerCheck(); } catch (e) { emit({ type: 'fight_breaker_error', err: String(e && e.message || e) }); }
  });
  const origAttack = bot.pvp.attack.bind(bot.pvp);
  _pvpAttackRaw = origAttack;   // la charge sur un squelette (skeletonRespond) a déjà pesé l'engagement
  bot.pvp.attack = function gatedAttack(target, ...rest) {
    let g = null;
    if (target && isFleeHostile(target)) {
      try { g = _fightCanEngage(); } catch (e) { g = null; }
    }
    if (!g || g.ok !== false) return origAttack(target, ...rest);
    const t = Date.now();
    let fleeOk = null;
    if (t < _fightRefuseFleeAt || t - _fightRefuseFleeAt >= 1500) {
      _fightRefuseFleeAt = t;
      try { if (bot.pvp.target) bot.pvp.stop(); } catch (e) {}
      try { fleeOk = skeletonFirstFlee(bot, 'fight_refused') !== false; }
      catch (e) { fleeOk = false; emit({ type: 'fight_refuse_flee_failed', err: String(e && e.message || e) }); }
      _fightNoteFlee(fleeOk);
    }
    if (t < _fightRefusedAt || t - _fightRefusedAt >= 3000) {
      _fightRefusedAt = t;
      emit({ type: 'fight_refused', reason: g.reason, mob: target.name, hp: Math.round((bot.health || 0) * 10) / 10, flee: fleeOk });
    }
    return undefined;
  };
  return true;
}

async function lootAfterCombat(target) {
  if (_combatLootBusy) return;
  _combatLootBusy = true;                       // posé AVANT l'attente : deux fins de combat rapprochées n'en lancent qu'un
  try {
    // Court délai : les objets du mort sont arrivés, le gardien de Movements a rendu la nominale, et
    // l'appelant qui possédait le combat (huntSpiders, recoverDeathDebt…) a déjà posé son propre but
    // s'il en avait un — `goalActive` reflète alors la réalité.
    await sleep(COMBAT_LOOT_SETTLE_MS);
    const me = bot.entity && bot.entity.position;
    if (!me || bot.isAlive === false) return;            // mort pendant l'attente : la dette de mort ramassera
    let drops = [];
    try { drops = homewarp.dropsWithin(bot.entities, me, COMBAT_LOOT_RADIUS); } catch (e) { drops = []; }
    let hostilesNear = false;
    try { hostilesNear = nearbyHostiles(bot, COMBAT_LOOT_HOSTILE_RADIUS).length > 0; } catch (e) { hostilesNear = true; }   // illisible → prudence
    let inWater = false;
    try { inWater = isInWater(bot); } catch (e) { inWater = false; }
    const owner = taskCtl.active;               // 'autonomous' (planner ET mappeur) ou rien ; les ordres directs (follow, guard…) gardent la main
    const verdict = shouldLootAfterCombat({
      target,
      hostilesNear,
      migrating: _migrating,
      busy: !!(_imminentBusy || panicInFlight || _armorBusy || _baseBusy || _escaping || _deathDebtBusy || inWater
        || (bot.pvp && bot.pvp.target)                   // un NOUVEAU combat a déjà commencé (attack() enchaîne stop puis start)
        || (owner && owner !== 'autonomous')),
      goalActive: !!(bot.pathfinder && bot.pathfinder.goal),
      dropDist: drops.length ? drops[0].dist : null,
    });
    if (!verdict.go) return;
    const got = await lootNearby({ radius: COMBAT_LOOT_RADIUS, maxItems: COMBAT_LOOT_ITEMS, budgetMs: COMBAT_LOOT_MS, abortOnFail: true });
    if (got) emit({ type: 'combat_loot', items: got, target: target && target.name });
  } finally { _combatLootBusy = false; }
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
  // Chemin de survie VITAL (`vital` = son nom) : il annule la charge en cours avant de couper le mouvement.
  if (opts.vital) skeletonRushYield(opts.vital);
  // Pendant une charge sur squelette, personne (skill du planner, timer) ne coupe le combat : la
  // charge est bornée (6 s) et s'arrête elle-même (`force` pour l'arrêt d'urgence explicite).
  if (_skelRushBusy && !opts.force) {
    _skelRushBlocked.stops++;
    if (!_skelRushBlocked.by) _skelRushBlocked.by = callerFromStack(new Error().stack, ['stopMotion']);
    return;
  }
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
// Version protocole FORCÉE (--mc-version, résolue du profil serveur). Sans elle, mineflayer
// auto-détecte la version par un status-ping — que certains proxys (Aternos) COUPENT : le ping
// meurt en ECONNRESET et le bot ne se connecte jamais. Fournie, la détection est court-circuitée.
if (args['mc-version']) botOpts.version = String(args['mc-version']);
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
// Garde d'oxygène : mineflayer écrit bot.oxygenLevel pour toute entité (zombie noyé…) → fausses noyades.
let _oxyForeignAt = 0; // niveau module : lu par le callback ci-dessous
installOxygenGuard(bot, { onForeign: () => {
  const t = Date.now();
  if (t - _oxyForeignAt < 60000) return;
  _oxyForeignAt = t;
  emit({ type: 'oxygen_foreign_ignored' });
} });
bot.once('spawn', () => emit({ type: 'oxygen_guard_on' }));
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
// HOME `safe` CAMPÉ (live 19/10) : TOUT /home safe passe par homewarp.goHome, qui consulte ce veto avant
// d'envoyer la commande (point d'entrée unique : goSpawn, safeWarpHome et les appels directs).
bot._mcaSafeVeto = (ctx) => !!safeHomeVeto(ctx);
// ANTI-VIDE (22/10) : homewarp.bookmark refuse un home au-dessus du vide — on le DIT (jamais en silence).
bot._mcaOnBookmarked = (i) => _onBookmarked(i);   // mémo deepWork (un /sethome work ailleurs remplace le chantier)
bot._mcaOnBookmarkRefused = (i) => { try { emit({ type: 'sethome_refused_void', name: i.name, reason: i.reason, solid: i.solid, x: i.x, y: i.y, z: i.z }); } catch (e) {} };
// Mort par CHUTE annoncée par le serveur → home/base de la même colonne condamnés, boucle détectée.
bot.on('messagestr', (msg) => {
  try {
    if (!voidGuard.isFallDeathMessage(msg, bot.username)) return;
    const p = (lastDeath && Date.now() - lastDeath.t < 5000) ? lastDeath : (bot.entity && bot.entity.position);
    if (p) noteFallDeath({ x: p.x, y: p.y, z: p.z });
  } catch (e) { emit({ type: 'error', message: 'fall_death_note: ' + String((e && e.message) || e) }); }
});

bot.on('spawn', () => {
  _lifeGen++;   // une vie commence : tout skill d'une vie antérieure s'arrête à son prochain pas
  _floatSettleUntil = Date.now() + 15000;
  // Là où l'on revient en mourant (COPIE : Vec3 muté en place) — référence du dépôt du kit de secours.
  try { const sp = bot.entity && bot.entity.position; if (sp) _lastRespawnPos = { x: sp.x, y: sp.y, z: sp.z }; } catch (e) {}
  // Une VIE commence ici (point de réapparition campé : respawnCamp.js) — persistée, survit au death_loop.
  try { if (_lastRespawnPos) noteRespawnLife(_lastRespawnPos); } catch (e) {}
  // L'état de zone est REPRIS du mémo, jamais réinitialisé : son horloge doit traverser les
  // respawns, sinon l'hystérésis de 15 min n'est jamais atteinte (le bot respawn plus souvent).
  if (!_zoneAnchoredAt) loadZoneState();
  // Les morts des process précédents, AVANT onSpawn : s'il y a eu une rafale, l'évasion est déjà
  // armée quand onSpawn teste `_escapeOnSpawn` (UNE fois par process — garde de niveau module).
  loadDeathHistory();
  restoreFurnaceJob();    // four de mine du process précédent (22/10) : son fer attend au fond
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
  // Un joueur éteint le planner (stop/afk/guard/follow/pvp) : le filet « orphelin » ne doit pas le rallumer.
  if (['stop', 'afk', 'guard', 'follow', 'pvp'].includes(order.verb)) _plannerParked = true;
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
// LIT : « Respawn point set », « You have no home bed… » (lit détruit → re-pose). Cf. onBedMessage.
bot.on('messagestr', (msg) => { try { onBedMessage(msg); } catch (e) { /* best-effort */ } });

bot.on('messagestr', (msg) => {
  // RC3 : un /home vient d'être REFUSÉ par la teleport-safety Essentials → le bot n'a PAS bougé.
  // On invalide le home concerné pour que les filets de secours arrêtent de compter dessus :
  // chantier → re-creuser (pas re-TP) ; safe → sauvetage à pied + re-pose à la prochaine surface sèche.
  const refusedH = homewarp.refusedHome(bot, msg);
  // 20/10 : « Player has not set a home. » → le home demandé N'EXISTE PAS côté serveur (≠ refus).
  const missingH = refusedH ? null : homewarp.missingHome(bot, msg);
  if (missingH) noteHomeMissing(missingH);
  if (refusedH) {
    _homeRefusedAt[refusedH] = Date.now();
    emit({ type: 'home_tp_refused', name: refusedH });
    if (refusedH === HOME_WORK) { _workSet = false; _forgetDeepWork('tp_refused'); }
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
    // LIVRAISON qui me vise (le demandeur tient `marmor:<moi>`) : je m'arrête et je ramasse (24/10).
    try {
      const claim = _teamClaims ? _teamClaims.peek('marmor:' + bot.username) : null;
      if (isGiftForMe({ claim, me: bot.username, requester: tpWho })) receiveGiftFrom(tpWho).catch(() => {});
    } catch (e) { /* best-effort */ }
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
  abortShelterOnDeath();
  try { endLifeTasks('death'); } catch (e) { /* ce handler persiste l'historique : jamais de throw */ }
  // Relevé AVANT que le serveur ne vide l'inventaire (keepInventory OFF) : à l'event `death`, les slots
  // sont encore ceux de la vie qui s'achève. Jamais de throw dans ce handler (il persiste l'historique).
  try { _invAtDeath = _invTotal(() => true); } catch (e) { _invAtDeath = -1; }
  const p = bot.entity && bot.entity.position;
  if (p) lastDeath = { x: p.x, y: p.y, z: p.z, t: Date.now() };
  // LIEUX DE MORT RÉPÉTÉE (deathspots.js, toute cause confondue — chutes/ravins compris, ≠
  // deathzones.js qui ne voit que les alertes PRÉ-mortem mobs). 2 morts au même endroit en
  // <15 min → le spot est banni ; si le chantier courant est dedans, on cesse d'y retourner.
  if (p) {
    const ds = deathSpots.noteDeath(p.x, p.y, p.z);
    if (ds && ds.newlyBanned) {
      emit({ type: 'death_spot_banned', x: ds.x, z: ds.z });
      abandonWorkIfDeathSpot(ds.x, ds.z);
    }
  }
  // HISTORIQUE DE MORTS PERSISTÉ (live 19/10, MapBot1 : « 4 morts de plus » à CHAQUE génération de
  // process, parce que le death_loop relançait un process à mémoire vide). Relu si ce n'est pas déjà
  // fait (jamais une mort écrite sur un historique pas encore relu), puis écrit TOUT DE SUITE —
  // avant l'évasion, avant le garde-fou : le process.exit(2) plus bas ne doit rien emporter.
  loadDeathHistory();
  const nowD = Date.now();
  deathTimes = deathTimesPrune(deathTimes.concat([nowD]), nowD);
  persistDeathHistory();
  // HOME CAMPÉ (live 19/10) : la POSITION de cette mort, persistée elle aussi AVANT tout process.exit(2)
  // — c'est elle qui dira au process suivant (et à celui-ci) que son home `safe` est un camp.
  recordDeathPosition(p);
  // ANTI-CAMPING (phase B, vécu V3Res1 : zombie campé sur le spawnpoint = 6 morts en 51 s,
  // et l'ancienne pause à 3 morts le laissait IDLE en punching-ball) : 2 morts en <60 s →
  // au prochain spawn on s'ARRACHE de la zone (escapeDeathCamp) avant toute autre activité.
  // ⚠️ Le secours historique (warp /spreadplayers + ré-ancrage) est un NO-OP en sans-give — le
  // warp est bloqué par nogive (asymétrie pinnée dans test/nogive.test.js : /spreadplayers
  // interdit, /spawnpoint autorisé) et seul le ré-ancrage passait, CIMENTANT le camping
  // (world_mn15, NethBot3 : 4 morts en 36 s en alternance shot/spawnpoint).
  // Fix fable1 ter : le camping LENT (zombie sur le spawnpoint, morts espacées 2-7 min — MapperBot2
  // 5 morts/22 min) passait sous le radar du burst <60 s. 3 morts en 10 min = même endroit pourri
  // → warp d'évasion aussi (le shelter post-respawn fait le reste).
  // (Le jugement vit dans unstuck.escapeArmed — le MÊME que celui de loadDeathHistory au démarrage.)
  if (escapeArmed(deathTimes, nowD)) _escapeOnSpawn = true;
  // POINT DE RÉAPPARITION CAMPÉ (live 22/10) : ≥ 2 vies de < 60 s au même point → évasion armée, camp
  // retenu, lit abandonné s'il EST ce point. Persisté AVANT le garde-fou death_loop (process.exit) ci-dessous.
  noteRespawnDeath();
  // Garde-fou ultime (relevé 3→5 : le warp anti-camping gère les boucles courtes) :
  // 5 morts / 10 min → on SORT du process (miroir du starved l.1172) pour laisser le self-healing
  // backend respawner avec un world.json FRAIS (status=in_progress) en ~15 s — inventaire + quota
  // du compte persistent (keepInventory). L'ancienne pause (status='paused' + process VIVANT) était
  // une IMPASSE : le manager ne respawne que sur mort du process → bot idle à vie, quota jamais
  // atteint (bug review #2). NE PAS persister 'paused' avant l'exit (le manager réécrit un world.json
  // frais au respawn ; saveWorld 'paused' empêcherait onSpawn de relancer l'objectif).
  // ⚠️ Ne compte que les morts de CE process (`_bootAt`), pas celles héritées du mémo : avec elles,
  // 5 héritées + 1 = sortie à la 1ʳᵉ mort de CHAQUE relance → vies < 15 s → le backend (3 vies < 15 s
  // d'affilée = crash_on_spawn) abandonnerait le bot pour de bon. Les héritées arment l'évasion, point.
  if (deathLoopTripped(deathTimes, { bootAt: _bootAt, now: nowD })) {
    // DERNIÈRE ÉCRITURE AVANT LA SORTIE — c'est ici que la relance, mémoire vide, ne relira que ce
    // fichier. Déjà écrit plus haut ; ré-affirmé ici pour que la garantie se lise à côté du exit.
    persistDeathHistory();
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
// à côté du fer mais ne le prennent pas »). Ce qui est à portée de bras (≤4,2 blocs) est miné SANS
// bouger, la tâche en cours est juste ponctuée. MAIS ce timer sait aussi MARCHER — détour vers un
// minerai rare, quelques pas vers du fer visible ('walk'), ramassage d'un drop de valeur, approche
// d'un bloc derrière une paroi — et chacun de ces gestes POSE UN BUT PATHFINDER, qui fait rejeter
// le `goto` en cours (GoalChanged). Mesure goal_trace du 19/10 : le PREMIER interrupteur des trajets
// du planner était ce timer (`Timeout._onTimeout@index.js:6083`, la marche 'walk'). D'où
// `oregrab.grabScope` : pendant une migration, RIEN ; si un autre trajet est en cours, portée de
// bras seulement (le détour vers du rare reste permis : il vaut l'interruption) ; sinon, tout.
// Et on vérifie l'OUTIL : miner du fer à la pioche de bois casse le bloc et ne donne rien du tout
// (`oregrab.canHarvest`).
let _oreGrabBusy = false;
let _oreGrabIds = null;
let _oreDetourIds = null;   // ids des minerais RARES qui valent un detour (cf. oregrab)
// Détours sans issue (21/10, NethBot3 : 112 détours vers le MÊME diamant en 8,7 min d'iron_deep) :
// { [case]: { tries, at } } — au 2e détour vers une case, elle est ignorée 10 min (oregrab.detourAllowed).
let _oreDetourMemo = {};
// Dernier but posé PAR le ramassage : son reliquat (NoPath / chemin vide → la lib ne remet pas
// `goal` à null) n'est pas « un autre trajet » — sinon un minerai inatteignable une fois mettrait le
// timer en portée de bras jusqu'au prochain trajet de quelqu'un d'autre. Niveau MODULE : lu par le timer.
let _oreGrabGoal = null;
/** Goto du ramassage : borné, et mémorise le but pour que grabScope le reconnaisse comme le nôtre. */
function oreGrabGoto(goal, ms) {
  _oreGrabGoal = goal;
  return withTimeout(bot.pathfinder.goto(goal), ms, () => { try { stopMotion(); } catch (er) {} });
}
setInterval(async () => {
  if (_oreGrabBusy) return;
  try {
    if (!bot.entity || !bot.entity.position || !bot.registry) return;
    // Relu juste avant CHAQUE geste (marche, approche, dig) : entre deux `await` (equip, goto) le
    // planner a pu poser son but, une migration a pu démarrer — on décide sur l'état du moment.
    const scopeNow = () => oregrab.grabScope({
      migrating: _migrating,
      goal: bot.pathfinder ? bot.pathfinder.goal : null,
      ownGoal: _oreGrabGoal,
      stair: _stairDepth > 0,
      rareHunt: _diamondHuntBusy,     // caveHunt vise déjà le diamant : pas de détour par-dessus son approche
    });
    let scope = scopeNow();
    if (!scope.run) return;   // migration EXCLUSIVE : ni but posé, ni dig lancé sous ses jambes
    const hostile = (() => {
      try {
        const e = bot.nearestEntity((x) => x && x.position && isFleeHostile(x)
          && x.position.distanceTo(bot.entity.position) <= 10
          && (x.name !== 'creeper' || creeperPlan(x, bot.entity.position) !== 'ignore'));   // creeper calme au loin : pas un frein
        return !!e;
      } catch (e) { return false; }
    })();
    const ok = oregrab.shouldGrab({
      // `_shelterInFlight` (discipline de nuit, 19/10 soir) : terré, on ne marche pas vers un minerai et
      // on ne creuse pas la paroi de son propre abri pour un bloc de fer.
      // La chasse / l'expédition possèdent le pathfinder (23/10) : un détour vers un minerai annulait leur goto.
      busy: _imminentBusy || panicInFlight || _armorBusy || _smeltOppBusy || _baseBusy || !!_shelterInFlight || _huntCookBusy > 0 || _foodTripBusy || _skelRushBusy,
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
      if (scope.detour && _oreDetourIds.length) {
        // VISIBLE seulement (24/10 : 376 `ore_detour` diamant pour 28 `ore_grabbed` en 6 sessions) : findBlocks
        // rend aussi les diamants ENTERRÉS (chunks chargés = la vérité du serveur) — on marchait vers de la
        // roche pleine, NoPath, 2e essai, puis le suivant (et c'est un tell X-ray). Un joueur ne se
        // détourne que pour ce qu'il voit : face à l'air.
        const rare = bot.findBlocks({ matching: _oreDetourIds, maxDistance: 20, count: 6 }) || [];
        const rp = rare.find((q) => { try { return require('./ores').isExposed(bot, q); } catch (e) { return false; } });
        if (rp) {
          const rb = bot.blockAt(rp);
          const d = rb && rb.position.distanceTo(bot.entity.position);
          // ⚠️ Tester le MEILLEUR outil DISPONIBLE, pas celui qui traîne en main. Massii a filmé
          // un bot passant a cote d'un diamant avec un BOUCLIER en main : la pioche etait dans
          // l'inventaire, mais le test portait sur `bot.heldItem` — donc faux, donc aucun detour.
          const _best = bestToolFor(bot, rb);
          const _dk = oregrab.detourKey(rp);
          if (rb && d > 4.2 && oregrab.detourAllowed(_oreDetourMemo, _dk, Date.now())
              && oregrab.canHarvest(rb, _best ? _best.type : (bot.heldItem && bot.heldItem.type))) {
            if (_best) { try { await bot.equip(_best, 'hand'); } catch (e) { /* best-effort */ } }
            if (!scopeNow().detour) return;    // une migration a démarré pendant l'equip
            _oreGrabBusy = true;
            _oreDetourMemo = oregrab.noteDetour(_oreDetourMemo, _dk, Date.now());
            emit({ type: 'ore_detour', ore: rb.name, d: Math.round(d), tries: _oreDetourMemo[_dk].tries });
            await oreGrabGoto(new pfGoals.GoalNear(rp.x, rp.y, rp.z, 2), 25000);
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
    // loop (piège #43a). Quand un autre trajet est en cours (portée de bras seulement), le scan se
    // réduit d'autant : `scope.scan` (cf. oregrab.grabScope).
    const hits = bot.findBlocks({ matching: _oreGrabIds, maxDistance: scope.scan, count: 4 });
    // RAMASSAGE AU SOL (Massii, live 26/07 : « si il y a des item qui leur servent (genre diamant)
    // ils doivent les prendre »). Un minerai miné hors du rayon de ramassage automatique tombe et
    // reste là. On ne se détourne QUE pour ce qui fait avancer la chaîne (cf. oregrab.isValuableDrop)
    // et seulement quand il n'y a pas de minerai à portée — le minage garde la priorité.
    if (!hits || !hits.length) {
      if (!scope.drops) return;            // marcher vers un item = poser un but : pas sur le trajet d'un autre
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
          await oreGrabGoto(new pfGoals.GoalNear(e.position.x, e.position.y, e.position.z, 1), 10000);
          await sleep(400);   // laisse la collecte automatique par proximité opérer
        }
      } catch (e) { /* best-effort : jamais bloquant */ }
      return;
    }
    _oreGrabBusy = true;
    for (const pos of hits) {
      scope = scopeNow();                  // l'itération précédente a pu attendre (equip, goto, dig)
      if (!scope.run) break;
      const blk = bot.blockAt(pos);
      if (!blk || !oregrab.isWantedOre(blk.name)) continue;
      // QUELQUES PAS pour du minerai visible (Massii 27/07, photo de 3 veines de fer intactes
      // dans les parois d'une salle creusée par les bots). L'ancien contrat — « portée de bras
      // stricte, aucun déplacement » — expliquait exactement ce qu'il voyait : dans une salle,
      // le fer est dans les PAROIS à 5-10 blocs, jamais à 4,2. Un joueur fait les trois pas.
      // `maxDist` = portée autorisée : ORE_REACH quand un autre trajet est en cours → jamais 'walk'.
      const plan = oregrab.oreStepPlan({
        name: blk.name, dist: blk.position.distanceTo(bot.entity.position), maxDist: scope.maxDist,
      });
      if (!plan) continue;
      if (plan === 'walk') {
        try {
          await oreGrabGoto(new pfGoals.GoalNear(blk.position.x, blk.position.y, blk.position.z, 1), 12000);
        } catch (e) { continue; }               // inatteignable → on laisse, sans insister
        // Portée de RAMASSAGE (PICKUP_REACH), pas portée de MINAGE (ORE_REACH) : miner depuis plus
        // loin détruit le bloc mais abandonne le drop au sol (mesure 21/10 : coal jamais ramassé).
        if (blk.position.distanceTo(bot.entity.position) > oregrab.PICKUP_REACH) continue;
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
        // S'approcher = poser un but : pendant le trajet d'un autre, seulement pour du rare.
        if (!oregrab.mayApproach(scopeNow(), blk.name)) continue;
        try {
          await oreGrabGoto(new pfGoals.GoalGetToBlock(blk.position.x, blk.position.y, blk.position.z), 12000);
        } catch (e) { continue; }
        if (!_reachable()) continue;                     // inatteignable : on ne le gaspille pas
      }
      if (!scopeNow().run) break;                        // migration lancée pendant l'equip : pas de dig sous ses jambes
      // ⚠️ JAMAIS UN MINERAI QUI RETIENT LA LAVE (23/10, NethBot2 : `ore_grabbed` coal à y=13 puis brûlé
      // 0,3 s plus tard). Le casser ouvre la poche : la lave coule sur le bot. On le laisse en place —
      // le serpentin, lui, sait murer avant de creuser.
      if (lavaGuard.lavaAdjacent((q) => bot.blockAt(q), blk.position)) { lavaAvoided('ore_grab', blk.position, { ore: blk.name }); continue; }
      // Un autre a commencé à creuser pendant nos `await` (escalier, abri…) : lancer le nôtre AVORTERAIT
      // le sien (mineflayer : un seul dig, cf. oregrab.mayStartDig — dig_failed ×8 du 23/10).
      if (!oregrab.mayStartDig(bot.targetDigBlock)) break;
      try {
        await withTimeout(bot.dig(blk), 12000, () => { try { bot.stopDigging(); } catch (e) {} });
        // ⚠️ withTimeout ne rejette JAMAIS : un dig raté (sorti de portée, interrompu) rendait {ok:false}
        // en silence et l'event tombait quand même. On relit le bloc (fix 19/10). Le fer, lui, ne se
        // compte plus ici : sampleZoneIron le voit arriver dans l'inventaire (une seule source).
        if (oregrab.oreGone(blk, bot.blockAt(blk.position))) {
          emit({ type: 'ore_grabbed', ore: blk.name, y: Math.round(blk.position.y) });
        }
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
// 22/10 (chrono de 61 min : PV bas qui ne remontaient pas, faim 13-17, nourriture en poche, 4 `ate` en
// 1 h pour 3 bots) : le filet ne regardait que la faim ≤ 8. Or sous 18 la régénération vanilla est
// COUPÉE — un bot blessé à faim 14 ne remonte jamais. Il mange donc aussi blessé (≤ 14 PV) sous 18
// (reflexes.eatWanted), et choisit le poulet cru / la chair en dernier (reflexes.pickFood).
// Extrait en fonction de NIVEAU MODULE : le trou de nuit l'appelle aussi, avant tout craft.
let _hungerBusy = false;
// 24/10 (eatSafe.js) : 51 % des `ate` du filet étaient FACTICES (withTimeout ne lève jamais → `ate` émis
// même quand consume() échouait ou rendait SANS manger). Chaque bouchée est désormais VÉRIFIÉE (faim
// montée ou objet consommé) ; les ratés d'affilée espacent les essais. NIVEAU MODULE (piège #56).
let _eatNoEffectStreak = 0;
let _eatBackoffUntil = 0;

/**
 * UNE bouchée, sous verrou (bot._eatLockUntil : equip/dig étrangers attendent, cf. wireEatLock), VÉRIFIÉE.
 * Rend true seulement si elle a eu lieu. Émet ate (+ heal_eat si blessé) ou eat_failed.
 */
async function eatBite(food, tag) {
  const foodBefore = bot.food;
  const hpBefore = bot.health;
  const hurt = healEatWanted({ health: bot.health, food: bot.food });
  let countBefore = null;
  try { countBefore = itemCount(bot.inventory.items() || [], food.name); } catch (e) { countBefore = null; }
  try { bot.stopDigging(); } catch (e) {}               // libère la main (la cause du silence)
  bot._eatLockUntil = Date.now() + EAT_LOCK_MS;
  let res;
  try {
    res = await withTimeout((async () => {
      try {
        // Objet RELU à l'instant (piège : un `item.slot` périmé fait échouer equip après un tri/ramassage).
        const fresh = (bot.inventory.items() || []).find((i) => i.name === food.name) || food;
        await bot.equip(fresh, 'hand');
        await bot.consume();
        return 'done';
      } catch (e) { return { reason: 'error:' + String((e && e.message) || e).slice(0, 60) }; }
    })(), 8000, () => {});
  } catch (e) { res = { reason: String((e && e.message) || e).slice(0, 60) }; }
  finally { bot._eatLockUntil = 0; }
  const fail = (reason) => {
    _eatNoEffectStreak++;
    _eatBackoffUntil = Date.now() + noEffectBackoffMs(_eatNoEffectStreak);
    emit({ type: 'eat_failed', item: food.name, food: bot.food, hp: bot.health, via: tag, reason, streak: _eatNoEffectStreak });
    return false;
  };
  // withTimeout ne lève jamais : erreur → {ok:false, reason:'error'}, délai → {reason:'timeout'}.
  if (res !== 'done') return fail((res && res.reason) || 'error');
  await sleep(250);                                     // update_health suit le statut « fini de manger »
  let countAfter = null;
  try { countAfter = itemCount(bot.inventory.items() || [], food.name); } catch (e) { countAfter = null; }
  if (!eatEffective({ foodBefore, foodAfter: bot.food, countBefore, countAfter })) return fail('no_effect');
  _eatNoEffectStreak = 0;
  _eatBackoffUntil = 0;
  emit(Object.assign({ type: 'ate', item: food.name, food: bot.food, hp: bot.health, via: tag }, ateFields(food.name)));
  if (hurt) emit({ type: 'heal_eat', hp: hpBefore, food_before: foodBefore, food_after: bot.food, item: food.name, via: tag });
  return true;
}

async function hungerNetTick(tag = 'net', { sealed = false } = {}) {
  if (_hungerBusy) return false;
  let ate = false;
  try {
    if (!bot.inventory || bot.food == null) return false;
    // Le cas « blessé, faim < 18 » attend la fin du corps-à-corps : manger rengaine l'épée 1,6 s. La
    // vraie faim (≤ 8), elle, n'attend pas (historique). Muré dans l'abri (`sealed`) : le zombie
    // derrière la paroi ne frappe pas, on mange.
    const starving = bot.food <= 8;
    if (!starving && Date.now() < _eatBackoffUntil) return false;   // bouchées sans effet : on espace
    if (!starving) {
      if (!eatWanted({ food: bot.food, health: bot.health })) return false;
      if (bot.pvp && bot.pvp.target) return false;
    }
    if (!starving && !sealed) {
      let td = null;
      try { td = _nearestThreatDist(); } catch (e) { td = null; }
      if (typeof td === 'number' && td <= 6) return false;
    }
    // BLESSÉ (24/10) : un joueur mange jusqu'à 18 pour se soigner — on enchaîne les bouchées (≤ 4) tant
    // que les PV sont sous 16 et la faim sous 18. Indemne : une bouchée par tick, comme avant.
    for (let bite = 0; bite < MAX_HEAL_BITES; bite++) {
      if (bite > 0 && !healEatWanted({ health: bot.health, food: bot.food })) break;
      let food = pickFood(bot.inventory.items() || []);
      if (!food) break;                                  // vraiment rien à manger : ensureFood s'en occupe
      // CRU (23/10, cookMeat.js) : pickFood prend déjà le cuit d'abord ; indemne, le cru n'est mangé qu'à
      // faim ≤ 6, s'il est impossible de cuire, ou après 90 s d'attente sans occasion. BLESSÉ (24/10) : le
      // cru tout de suite — sauf bot libre, cuisson possible et PV ≥ 10 (cuire d'abord ne coûte rien).
      if (isRawMeat(food.name)) {
        const hurt = healEatWanted({ health: bot.health, food: bot.food });
        const deferredMs = _rawDeferSince ? Date.now() - _rawDeferSince : 0;
        const canCook = bite === 0 && !sealed && netMeatCookable();
        const free = canCook && netCookFree();
        const cookFirst = hurt && cookFirstWhenHurt({ health: bot.health, canCook, free });
        if (cookFirst || !rawEatAllowed({ food: bot.food, canCook, deferredMs, hurt })) {
          if (!free) { if (!_rawDeferSince) _rawDeferSince = Date.now(); break; }
          _hungerBusy = true;
          await cookMeatLot('net', { walk: false });
          food = pickFood(bot.inventory.items() || []);
          if (!food) break;
          // cuisson ratée → cooldown armé : netMeatCookable devient faux, le cru se mange tout de suite
          if (isRawMeat(food.name) && !rawEatAllowed({ food: bot.food, canCook: netMeatCookable(), deferredMs, hurt })) break;
        }
      }
      _rawDeferSince = 0;
      _hungerBusy = true;
      if (!(await eatBite(food, tag))) break;
      ate = true;
    }
  } catch (e) { /* watchdog : ne crash jamais */ }
  finally { _hungerBusy = false; }
  return ate;
}

// ── VERROU DE BOUCHÉE (24/10, eatSafe.eatLockWaitMs) ──────────────────────────────────────────────
// mineflayer termine consume() SANS manger dès que l'objet en main change (heldItemChanged) — le
// branch-mine ré-équipait sa pioche, l'aura son épée, pendant la bouchée. `bot.usingHeldItem` ne suffit
// pas à les retenir : mineflayer le remet à faux sur N'IMPORTE quel paquet entity_status. Pendant le
// verrou (≤ 2,6 s), un equip/unequip/dig étranger ATTEND ; un equip de nourriture (le repas) passe.
// Une fois par process ; NIVEAU MODULE (piège #56).
let _eatLockWired = false;
function eatLockActive() {
  try { return !!(bot && typeof bot._eatLockUntil === 'number' && bot._eatLockUntil > Date.now()); } catch (e) { return false; }
}
function _eatLockIsFood(item) {
  const nm = item && typeof item === 'object' ? item.name : null;
  return !!nm && (FOODS.has(nm) || EMERGENCY_FOODS.has(nm));
}
async function _eatLockGate() {
  const t0 = Date.now();
  let w = eatLockWaitMs({ lockUntil: bot._eatLockUntil, now: Date.now() });
  while (w > 0 && Date.now() - t0 < EAT_LOCK_MS) {
    await sleep(Math.min(w, 150));
    w = eatLockWaitMs({ lockUntil: bot._eatLockUntil, now: Date.now() });
  }
}
function wireEatLock() {
  if (_eatLockWired) return false;
  _eatLockWired = true;
  for (const m of ['equip', 'unequip', 'dig']) {
    if (typeof bot[m] !== 'function') continue;
    const orig = bot[m];
    bot[m] = function eatLocked(item) {
      const self = this; const args = arguments;
      if (!eatLockActive() || (m === 'equip' && _eatLockIsFood(item))) return orig.apply(self, args);
      return _eatLockGate().then(() => orig.apply(self, args));
    };
  }
  return true;
}
setInterval(() => { hungerNetTick().catch(() => {}); }, 5000);

// ── FAIM : PARTIR CHERCHER À MANGER AVANT LE POINT DE NON-RETOUR (run world_mn15, 18/08 — la
// famine est devenue la cause de mort DOMINANTE : 5 « starved to death » en 10 min sur des bots
// pourtant BLINDÉS). Le filet ci-dessus ne sait que MANGER ce qu'on a ; quand il n'y a plus RIEN
// en poche il se contente de sortir, et `ensureFood` (butin → chasse → pêche → ficelle) n'était
// appelé qu'au montage du kit, jamais en cours de vie. Le déclencher au seuil d'urgence serait de
// toute façon trop tard pour une EXPÉDITION : sous 18 la régénération est coupée, le bot part
// chasser à moitié mort et meurt en route. On part donc dès 14 (FOOD_RUN_HUNGER) et le ventre
// vide, au plus une fois toutes les 3 minutes — une zone vidée de gibier ne se repeuple pas en
// trente secondes, et une quête mobilise le bot plusieurs minutes.
let _foodRunBusy = false;
let _lastFoodRunAt = 0;
// v7 — RATIONNEMENT ADAPTATIF. 392 quêtes sur le run, quasi toutes stériles, relancées toutes les
// 3 minutes : du churn pur (CPU, déplacement, et un bot qui ne travaille pas). Une passe qui ne
// rapporte RIEN dit quelque chose de la ZONE, pas de l'instant — on passe donc en sourdine (15 min)
// jusqu'au premier gain, qui rétablit le régime nerveux. Niveau MODULE (piège #56).
let _foodRunCooldownMs = FOOD_RUN_COOLDOWN_MS;
// Corps du timer extrait en fonction de NIVEAU MODULE (discipline de nuit, 19/10 soir) : testé par
// extraction comme le reste de la glue.
// DISCIPLINE DE NUIT : nu de nuit, PAS de quête — elle chasse en surface, warpe un mineur affamé au
// /home safe et marche vers le gibier : tout ce qui sort un bot nu de son trou. La faim de la nuit se
// gère avec ce qu'on a en poche (filet « manger » ci-dessus) ou la chair de zombie ramassée après un
// combat (wireCombatLoot). Le rationnement n'est PAS consommé : à l'aube la quête part au 1er tick.
async function foodRunTick() {
  if (_foodRunBusy) return;
  if (_imminentBusy || panicInFlight || _armorBusy || _baseBusy) return;   // la survie passe devant
  // Une chasse déjà en vol (hook de descente du planner, kit…) : pas de 2e sortie par-dessus — elles se
  // voleraient le pathfinder l'une l'autre (23/10).
  if (_huntCookBusy > 0) return;
  let _foodTok = null;   // jeton de la sortie quand elle a PRÉEMPTÉ le planner (cf. foodRun.foodRunPreempt)
  try {
    if (!bot.inventory || !bot.entity) return;
    const stock = foodStock();
    // SOUS TERRE, affamé et à sec (run 20/10, NethBot3 : `food_run_done gained:0 next_min:15` puis
    // famine) : la sourdine de 15 min juge une ZONE vidée de gibier — la remontée /home safe emmène le
    // mineur AILLEURS. Elle part donc malgré la sourdine, avec son propre cooldown persisté (foodGate.js).
    const _fgSt = loadBaseState() || {};
    const _py = bot.entity.position ? bot.entity.position.y : NaN;
    const underDue = undergroundFoodTripDue({
      y: _py, food: bot.food, foodItems: stock, now: Date.now(), lastTripAt: foodGateLoad(_fgSt).lastUnderTripAt,
    });
    if (!underDue && !foodRunNeeded({
      food: bot.food, health: bot.health, foodItems: stock, now: Date.now(), lastRunAt: _lastFoodRunAt,
      cooldownMs: _foodRunCooldownMs,
    })) return;
    if (nightLockdownNow()) { nightGateNote('food_run', { food: bot.food }); return; }
    _foodRunBusy = true;
    _lastFoodRunAt = Date.now();
    const runStartedAt = Date.now();
    if (underDue) {
      saveBaseState(Object.assign({}, _fgSt, { foodGate: Object.assign({}, _fgSt.foodGate || {}, { lastUnderTripAt: runStartedAt }) }));
    }
    emit({
      type: 'food_run', food: bot.food,
      y: bot.entity.position ? Math.round(bot.entity.position.y) : null,
      wait_min: Math.round(_foodRunCooldownMs / 60000),
    });
    // LA SORTIE POSSÈDE LE PATHFINDER (23/10) : le planner minait EN PARALLÈLE de la chasse — 36 des 42
    // `hunt_failed` de 6 h = la marche vers la bête annulée par collectBlock / branchMine / descendDiagonal
    // (GoalChanged, 14 échecs en < 2 s). Même remède que la migration (piège #72a) : on prend la tâche, on
    // attend (borné) que le skill en vol rende la main, la chasse tourne sous NOTRE jeton (huntCookGoal le
    // capture), puis le planner est rallumé dans le `finally`.
    _foodTok = await foodRunTakeover();
    if (_foodTok && _foodTok.cancelled) return;          // un autre maître a pris la main pendant l'attente
    // 70 s (19/10 : « la VITESSE ») et non plus 240 s : ensureFood tient dans un budget de 60 s dont
    // chaque phase est rognée, ces 10 s de marge ne sont qu'un garde-fou d'exécution. + FOOD_TRIP_MS :
    // l'EXPÉDITION vers le gibier (aucun passif en vue, vraie faim, jour) a son propre plafond de 75 s,
    // HORS du budget — le garde-fou de 70 s la couperait en route et laisserait le reste tourner en fond.
    await withTimeout(ensureFood(), FOOD_RUN_TIMEOUT_MS + FOOD_TRIP_MS + FOOD_TRIP_LONG_EXTRA_MS + COOK_LOT_HARD_MS, () => { try { stopMotion(); } catch (e) {} });
    // Le VERDICT de la passe : ce qu'on a RAMENÉ, pas ce qu'on a tenté. Tracé, parce qu'un
    // rationnement muet est indistinguable d'un mécanisme mort (#55a). `points` (réserve en points
    // de faim après la passe) et `took_ms` MESURENT la vitesse en live.
    const after = foodStock();
    _foodRunCooldownMs = foodRunCooldownAfter({ before: stock, after });
    emit({
      type: 'food_run_done', before: stock, after, gained: after - stock,
      points: foodPoints(buildCtxInv(bot)), took_ms: Date.now() - runStartedAt,
      next_min: Math.round(_foodRunCooldownMs / 60000),
    });
    // Remonté manger : une fois quelque chose en poche, retour au chantier (/home work, posé par la
    // remontée). Rien trouvé là-haut → on reste en surface : la porte de descente décidera (pas de yo-yo).
    if (_foodSurfaceTripAt >= runStartedAt && foodPoints(buildCtxInv(bot)) > 0) await returnToWork('food');
  } catch (e) { /* watchdog : ne crash jamais */ }
  finally {
    _foodRunBusy = false;
    foodRunRelease(_foodTok);
  }
}

/**
 * Prend la main sur le PLANNER pour la sortie nourriture (foodRun.foodRunPreempt) : tâche `food_run`,
 * attente bornée que le skill en vol rende la main, jeton global remplacé (huntCookGoal le capture).
 * → le jeton (éventuellement annulé si un autre maître est passé entre-temps) | null (pas de préemption).
 */
async function foodRunTakeover() {
  const inProgress = !!(world.objective && world.objective.status === 'in_progress');
  if (!foodRunPreempt({ active: taskCtl.active, inProgress, migrating: _migrating, switching: _ljSwitching, huntBusy: _huntCookBusy > 0 })) return null;
  const tok = taskCtl.begin('food_run', stopMotion);
  const w0 = Date.now();
  while ((_skillInFlight > 0 || _autoRunners > 0) && !tok.cancelled && Date.now() - w0 < MIGRATION_PREEMPT_WAIT_MS) {
    await sleep(250);
  }
  if (tok.cancelled) return tok;
  taskToken = tok;
  emit({ type: 'food_run_preempt', waited_ms: Date.now() - w0 });
  return tok;
}

/** Fin de sortie : planner préempté et personne d'autre n'a pris la main depuis → on le rallume. */
function foodRunRelease(tok) {
  if (!tok || tok.cancelled || taskCtl.active !== 'food_run') return false;
  if (!(world.objective && world.objective.status === 'in_progress')) return false;
  try { startAutonomous(null).catch((e) => emit({ type: 'error', message: String((e && e.message) || e) })); } catch (e) { return false; }
  return true;
}
setInterval(() => { foodRunTick().catch(() => {}); }, 30000);
setInterval(() => { herdScanTick(); }, HERD_SCAN_MS);

// ── RUN 20/10 : ENDERMAN, PORTE NOURRITURE, DROP_AHEAD ───────────────────────────────────────────
// Logique PURE dans enderman.js / foodGate.js / dropAhead.js ; ici la glue. ⚠️ TOUT l'état est de
// NIVEAU MODULE (piège #56 : ces fonctions sont appelées par des timers et par runGoalSkill).
const ENDER_EVENT_EVERY_MS = 10000;   // enderman_look_avoided / enderman_flee / enderman_fight : ≤ 1 / 10 s par type
const ENDER_SCAN_RADIUS = 16;         // au-delà, un enderman en colère n'est pas une urgence
const ENDER_ACT_MS = 4000;            // une réaction posée : pas de nouvelle décision pendant 4 s
const DESCEND_HEADING_TTL_MS = 10 * 60 * 1000;
let _enderBusy = false;
let _enderBusyUntil = 0;
let _enderEvAt = {};
let _enderCreepyIdx = null;           // index de la métadonnée « creepy » (lu une fois dans minecraft-data)
let _enderHurtAt = 0;                 // dernier coup reçu avec un enderman collé (repli sans métadonnée)
let _enderHurtId = null;
let _enderHoldUntil = 0;              // cartographe muré face à un enderman en colère : la boucle de mapping attend
const ENDER_HOLD_MS = 25000;          // la colère vanilla dure 20-39 s ; muré, on laisse passer le gros de l'orage
let _dropSites = [];                  // derniers drop_ahead {x,z,t} (dropAhead.noteDropAhead)
let _dropShiftSeed = 0;               // fait tourner le cap du décalage 30-50 blocs
let _descendHeading = null;           // { yaw, at } : cap imposé à la prochaine descente
let _foodGateEvAt = 0;                // throttle de food_gate quand la porte est « dépensée »
const GATE_ANIMAL_SIGHT = 64;         // porte de descente : « un animal en vue » (surface stérile, 25/10)
const GATE_ANIMAL_NAMES = new Set(['cow', 'pig', 'chicken', 'sheep', 'rabbit', 'mooshroom']);

/** emit throttlé (≤ 1 / ENDER_EVENT_EVERY_MS par type). */
function _enderEmit(type, payload) {
  const t = Date.now();
  if (_enderEvAt[type] && t - _enderEvAt[type] < ENDER_EVENT_EVERY_MS) return;
  _enderEvAt[type] = t;
  emit(Object.assign({ type }, payload || {}));
}

/** Position des yeux du bot (copie : entity.position est muté en place). */
function enderEye() {
  const e = bot.entity;
  if (!e || !e.position) return null;
  return { x: e.position.x, y: e.position.y + (e.eyeHeight || 1.62), z: e.position.z };
}

/**
 * Enveloppe bot.look : AUCUNE visée (pathfinder pitch 0, bruit idle humanize, lookAt de combat ou de
 * dig) ne se pose sur la tête d'un enderman — même yaw, yeux vers le sol. Seule exception : on combat
 * l'enderman exprès (bot.pvp.target), il est déjà en colère. Idempotent (inject_allowed + spawn).
 */
function installEndermanGuard() {
  wrapLook(bot, {
    entities: () => bot.entities,
    eye: () => enderEye(),
    allow: () => !!(bot.pvp && bot.pvp.target && bot.pvp.target.name === 'enderman'),
    onAvoid: (s) => {
      const me = enderEye();
      const p = s.enderman && s.enderman.position;
      _enderEmit('enderman_look_avoided', { dist: (me && p) ? Math.round(Math.hypot(p.x - me.x, p.y - me.y, p.z - me.z)) : null });
    },
  });
}

/**
 * Le bot vient d'encaisser un coup : `source` = l'entité responsable (damage_event 1.20+). Seul un
 * enderman SOURCE est coupable ; sans source, un enderman collé l'est s'il est le seul hostile collé
 * (enderman.hurtCulprit — live 21/10 : un coup de zombie mis sur le dos d'un enderman → provoqué → mort).
 */
function noteEndermanHurt(source) {
  const me = bot.entity && bot.entity.position;
  if (!me) return;
  const e = hurtCulprit(source || null, Object.values(bot.entities || {}), { x: me.x, y: me.y, z: me.z });
  if (e) { _enderHurtAt = Date.now(); _enderHurtId = e.id; }
}

/**
 * Cartographe muré face à un enderman en colère (réaction 'hide') : la boucle de mapping ATTEND ici
 * au lieu de repartir à pied à travers le mur. Borné par ENDER_HOLD_MS ; fin anticipée dès qu'aucun
 * enderman en colère n'est à ≤ 16 blocs.
 */
async function endermanHoldWait() {
  let n = 0;
  while (Date.now() < _enderHoldUntil && n++ < 80) {
    const ent = bot.entity;
    if (!ent || !ent.position) break;
    const self = { x: ent.position.x, y: ent.position.y, z: ent.position.z };
    if (_enderCreepyIdx == null) _enderCreepyIdx = creepyIndex(bot.registry);
    const hurt = Date.now() - _enderHurtAt < 5000;
    const angry = Object.values(bot.entities || {}).some((e) => e && e.name === 'enderman' && e.position
      && Math.hypot(e.position.x - self.x, e.position.y - self.y, e.position.z - self.z) <= ENDER_SCAN_RADIUS
      && angerReason(e, { creepyIdx: _enderCreepyIdx, selfPos: self, hurtBy: hurt && e.id === _enderHurtId }));
    if (!angry) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  _enderHoldUntil = 0;
}

/**
 * Tick 500 ms : (a) regard immobile posé sur une tête → corrigé (aucun bot.look n'arrive quand le bot
 * est figé) ; (b) enderman EN COLÈRE à ≤ 16 blocs → eau proche, combat si canDealWith le permet
 * (l'enderman compte double), sinon fuite. Les autres chemins l'ignorent (NEUTRAL_NO_PROVOKE) : sans
 * ce tick, un enderman qui frappe ne déclenchait RIEN.
 */
async function endermanTick() {
  if (_enderBusy) return;
  _enderBusy = true;
  try {
    const ent = bot.entity;
    if (!ent || !ent.position) return;
    const fighting = !!(bot.pvp && bot.pvp.target && bot.pvp.target.name === 'enderman');
    if (!fighting && lookIsUnsafe(ent.yaw, ent.pitch, enderEye(), bot.entities)) {
      try { await bot.look(ent.yaw, ent.pitch, true); } catch (e) { /* la garde corrige le pitch */ }
    }
    if (Date.now() < _enderBusyUntil || fighting) return;
    const self = { x: ent.position.x, y: ent.position.y, z: ent.position.z };
    if (_enderCreepyIdx == null) _enderCreepyIdx = creepyIndex(bot.registry);
    const hurt = Date.now() - _enderHurtAt < 5000;
    let target = null;
    let why = null;
    let best = Infinity;
    for (const e of Object.values(bot.entities || {})) {
      if (!e || e.name !== 'enderman' || !e.position) continue;
      const d = Math.hypot(e.position.x - self.x, e.position.y - self.y, e.position.z - self.z);
      if (d > ENDER_SCAN_RADIUS) continue;
      const r = angerReason(e, { creepyIdx: _enderCreepyIdx, selfPos: self, hurtBy: hurt && e.id === _enderHurtId });
      if (!r) continue;
      if (d < best) { best = d; target = e; why = r; }
    }
    if (!target) return;
    let water = null;
    try {
      const ids = ['water'].map((n) => bot.registry.blocksByName[n]).filter(Boolean).map((b) => b.id);
      water = ids.length ? bot.findBlock({ matching: ids, maxDistance: 6 }) : null;
    } catch (e) { water = null; }
    const wd = (water && water.position) ? Math.hypot(water.position.x - self.x, water.position.y - self.y, water.position.z - self.z) : null;
    let hasBlock = false;
    try { hasBlock = bot.inventory.items().some((i) => SCAFFOLD.includes(i.name)); } catch (e) { hasBlock = false; }
    // Un cartographe (preferFlee) ne frappe JAMAIS un enderman, un bot nu non plus (live 21/10 : 3/3
    // cartographes nus morts juste après un `enderman_fight` qu'ils avaient choisi).
    const act = endermanResponse({
      waterDist: wd, health: bot.health, food: bot.food,
      canDealWith: canDealWith(armorPoints(bot), attackDamage(bot)), boldFightAdvised,
      preferFlee: IS_MAPPER, naked: armorPoints(bot) <= 0, hasBlock,
    });
    _enderBusyUntil = Date.now() + ENDER_ACT_MS;
    const dist = Math.round(best * 10) / 10;
    if (act === 'hide') {
      // Se murer SUR PLACE (2 de haut, 4 côtés) : l'enderman (2,9 de haut) ne peut ni entrer ni frapper.
      // Le hold est posé AVANT l'arrêt : la boucle de mapping, interrompue, attend au lieu de repartir.
      _enderHoldUntil = Date.now() + ENDER_HOLD_MS;
      _enderBusyUntil = _enderHoldUntil;
      try { stopMotion(); } catch (e) {}
      let r = null;
      try { r = await withTimeout(secureSpot(bot, 'seal', {}), 5000, () => { try { stopMotion(); } catch (e) {} }); } catch (e) { r = null; }
      _enderEmit('enderman_hide', { dist, why, ok: !!(r && r.ok), placed: (r && r.placed) || 0 });
      if (!r || !r.ok) {
        _enderHoldUntil = 0; _enderBusyUntil = Date.now() + ENDER_ACT_MS;
        const dest = fleeTarget(self, target.position);
        if (dest) bot.pathfinder.setGoal(new pfGoals.GoalNearXZ(dest.x, dest.z, 3), false);
        _enderEmit('enderman_flee', { to: 'away', dist, why });
      }
    } else if (act === 'water') {
      const w = water.position;
      bot.pathfinder.setGoal(new pfGoals.GoalNear(w.x, w.y, w.z, 0));
      _enderEmit('enderman_flee', { to: 'water', dist, why });
    } else if (act === 'fight') {
      const w = bestWeapon(bot);
      if (w) { try { await bot.equip(w, 'hand'); } catch (e) {} }
      try { bot.pvp.attack(target); } catch (e) {}
      _enderEmit('enderman_fight', { dist, health: bot.health, why });
    } else {
      const dest = fleeTarget(self, target.position);
      if (dest) bot.pathfinder.setGoal(new pfGoals.GoalNearXZ(dest.x, dest.z, 3), false);
      _enderEmit('enderman_flee', { to: 'away', dist, why });
    }
  } catch (e) { /* watchdog : ne crash jamais */ }
  finally { _enderBusy = false; }
}
bot.once('inject_allowed', () => { try { installEndermanGuard(); } catch (e) {} });
bot.on('spawn', () => { try { installEndermanGuard(); } catch (e) {} });
// ANTI-VIDE (22/10) : instant du respawn (attribue un TP au-dessus du vide au point de respawn) et, à
// CHAQUE position imposée par le serveur (respawn, /home, /tpa, correction), rattrapage si le sol est à
// > 3 blocs : physique gelée + remblai sous soi (rescueVoidAfterTeleport, rend la main aussitôt sinon).
bot.on('spawn', () => { _lastSpawnAt = Date.now(); });
bot.on('forcedMove', () => {
  rescueVoidAfterTeleport().catch((e) => emit({ type: 'error', message: 'void_rescue: ' + String((e && e.message) || e) }));
});
bot.on('entityHurt', (e, source) => { try { if (e && bot.entity && e === bot.entity) noteEndermanHurt(source); } catch (err) {} });
setInterval(() => { endermanTick().catch(() => {}); }, 500);

/**
 * PORTE NOURRITURE avant une descente (foodGate.descentFoodGate). Rend true pour descendre.
 * Refus PERSISTÉS dans le mémo de base (le self-healing relance souvent : un compteur de process
 * repartirait à zéro et la porte ne se « dépenserait » jamais en zone sans gibier).
 */
function descentFoodGateCheck(opts = {}) {
  const st = loadBaseState() || {};
  const p = bot.entity && bot.entity.position;
  const points = foodPoints(buildCtxInv(bot));
  // Troupeau CONNU à ≤ 200 blocs (mémo de base, hors cellules ratées) : à 0 point, la porte ne se dépense pas (23/10).
  // Le troupeau le plus proche est lu SANS les cellules ratées : s'il est raté, la porte le dit (herdTried →
  // herd_gate_spent) au lieu de chercher plus loin un troupeau que l'expédition ne visera pas forcément.
  let herd = null;
  let herdTried = false;
  try {
    if (p) {
      const now = Date.now();
      herd = knownHerdNear(herdsLoad(st, now), { x: p.x, z: p.z }, { now });
      if (herd) herdTried = triedCellsLoad(st, now).some((a) => Math.hypot(a.x - herd.x, a.z - herd.z) <= HERD_CELL);   // même règle que pickHerd({avoid})
    }
  } catch (e) { herd = null; herdTried = false; }
  let longTripAt = 0;
  try { longTripAt = longTripLoad(st, Date.now()).longAt; } catch (e) { longTripAt = 0; }
  // SURFACE STÉRILE (25/10) : un animal (n'importe lequel, falaise comprise) à ≤ 64 blocs ? Illisible = inconnu.
  let animalsInView;
  try {
    if (p && typeof bot.nearestEntity === 'function') {
      const a = bot.nearestEntity((x) => x && GATE_ANIMAL_NAMES.has(x.name) && x.position && x.isValid !== false);
      animalsInView = !!(a && a.position.distanceTo && a.position.distanceTo(p) <= GATE_ANIMAL_SIGHT);
    }
  } catch (e) { animalsInView = undefined; }
  let herdBarren = false;
  try { herdBarren = herdBarrenRecent(st[HERD_BARREN_MEMO_KEY], Date.now()); } catch (e) { herdBarren = false; }
  const r = descentFoodGate({ points, y: p ? p.y : NaN, refusals: foodGateLoad(st).refusals, now: Date.now(), noPrey: !!opts.noPrey, herdNear: !!herd, herdTried,
    hunger: bot.food, longTripAt, animalsInView, herdBarren });
  if (!r.allow) {
    saveBaseState(Object.assign({}, st, { foodGate: Object.assign({}, st.foodGate || {}, { refusals: r.refusals }) }));
    emit({ type: 'food_gate', need: r.need, points, allow: false, refusals: r.refusals.length, reason: r.reason, animals: animalsInView, herd_barren: herdBarren,
      herd: herd ? { x: herd.x, z: herd.z, dist: Math.round(herd.dist) } : undefined });
  } else if ((r.reason === 'gate_spent' || r.reason === 'no_prey' || r.reason === 'some_food' || r.reason === 'gate_long_spent' || r.reason === 'starving_spent' || r.reason === 'barren_surface') && Date.now() - _foodGateEvAt >= 60000) {
    _foodGateEvAt = Date.now();
    emit({ type: 'food_gate', need: r.need, points, allow: true, reason: r.reason });
  }
  return r.allow;
}

/** La chasse du hook de descente n'a vu AUCUNE proie (rien en vue, expédition stérile comprise). Pur. */
function huntSawNoPrey(res) {
  return !!(res && res.ok === false && typeof res.reason === 'string' && /^no_prey:no_passive/.test(res.reason));
}

/** Échecs de descente POSITIONNELS : relancer du même point dans le même cap = même échec garanti. */
const DESCEND_POSITIONAL_RE = /^(drop_ahead|no_progress|max_depth)$/;

/** Un échec positionnel de descente (`drop_ahead`, `no_progress`, `max_depth`) vient d'arriver :
 *  2e au même endroit → +90°, 4e → décalage 30-50 blocs à pied (dropAhead.js). */
async function onDropAhead(reason = 'drop_ahead') {
  const p = bot.entity && bot.entity.position;
  if (!p) return;
  const here = { x: p.x, z: p.z };
  const n = noteDropAhead(_dropSites, here, Date.now());
  _dropSites = n.sites;
  if (n.action === 'none') return;
  if (reason !== 'drop_ahead') {
    emit({ type: 'descend_loop_break', reason, action: n.action, count: n.count, x: Math.round(here.x), z: Math.round(here.z) });
  }
  if (n.action === 'turn') {
    const from = (_descendHeading && Date.now() - _descendHeading.at < DESCEND_HEADING_TTL_MS)
      ? _descendHeading.yaw : (bot.entity.yaw || 0);
    const yaw = turnYaw(from);
    _descendHeading = { yaw, at: Date.now() };
    emit({ type: 'drop_ahead_turn', mode: 'turn', count: n.count, x: Math.round(here.x), z: Math.round(here.z), yaw: Math.round(yaw * 100) / 100 });
    return;
  }
  _dropShiftSeed += 1;
  const t = shiftTarget(here, _dropShiftSeed);
  emit({ type: 'drop_ahead_turn', mode: 'shift', count: n.count, x: Math.round(here.x), z: Math.round(here.z), toX: t.x, toZ: t.z });
  try {
    await withTimeout(bot.pathfinder.goto(new pfGoals.GoalNearXZ(t.x, t.z, 3)), 30000, () => { try { stopMotion(); } catch (e) {} });
  } catch (e) { /* best-effort : on redescend d'où l'on est */ }
  _descendHeading = { yaw: t.yaw, at: Date.now() };
}

/** Avant une descente : regarder dans le cap imposé par un drop_ahead récent (descendDiagonal lit le yaw). */
async function applyDescendHeading() {
  if (!_descendHeading || Date.now() - _descendHeading.at >= DESCEND_HEADING_TTL_MS) return;
  try { await bot.look(_descendHeading.yaw, 0, true); } catch (e) { /* best-effort */ }
}

// ── FRAPPE PASSIVE + CREEPER (AltoClef MobDefenseChain, 20/10) ───────────────────────────────────
// 63 % des morts arrivent pendant le but `logs`, 43 % dans les 2 min après un respawn. Deux gestes
// d'un joueur humain qui manquaient :
//   1. AURA : un hostile (pas un creeper, pas un neutre) à portée de coup et VISIBLE → un coup d'épée
//      au cooldown 1.9+, SANS annuler la tâche ni poser de but pathfinder (aura.js, pur) ;
//   2. CREEPER : ne fuir que s'il GONFLE (≤ 7 blocs → se placer à 10) ; calme et collé (≤ 4) → s'écarter
//      à 6 ; calme plus loin → l'ignorer (creeper.js, pur). Jamais de mêlée sur un creeper.
// ⚠️ TOUT l'état est de NIVEAU MODULE (piège #56 : un `let` dans onSpawn lu par ce timer = ReferenceError).
const AURA_TICK_MS = 250;
const AURA_EVENT_EVERY_MS = 10000;     // aura_hit / creeper_ignored / creeper_avoid : ≤ 1 / 10 s par type
const CREEPER_SCAN_RADIUS = 12;
const CREEPER_FLEE_MAX_MS = 6000;      // une fuite verrouille le pathfinder 6 s AU PLUS (puis relâche)
const CREEPER_REPLAN_MS = 1000;        // re-viser le point de fuite (le creeper suit)
let _auraLastHitAt = 0;                // dernier coup OU dernier changement d'arme (remet le cooldown à zéro)
let _auraBusy = false;                 // un equip est en vol
let _auraReadyAt = 0;                  // dernière arme sortie « à l'approche » (aura.auraReadyPlan, anti ping-pong)
let _auraEvAt = {};                    // throttle des events par type
let _creeperFlee = null;               // fuite en cours : { startedAt, lastSetAt, fusing } | null
const _creeperHold = createHoldState();   // verrou de but pendant la fuite (goalHold.js)

/** emit throttlé (≤ 1 / AURA_EVENT_EVERY_MS par type). */
function _auraEmit(type, payload) {
  const t = Date.now();
  const last = _auraEvAt[type];
  if (last != null && t >= last && t - last < AURA_EVENT_EVERY_MS) return;
  _auraEvAt[type] = t;
  emit(Object.assign({ type }, payload));
}

/** Ligne de vue des yeux du bot vers le haut du corps de l'entité (threatgate). Jamais de throw → false. */
function canSeeEntityNow(e) {
  try {
    const p = bot.entity && bot.entity.position;
    if (!p || !e || !e.position) return false;
    const eye = { x: p.x, y: p.y + 1.62, z: p.z };
    const h = Number.isFinite(e.height) ? e.height * 0.8 : 1.5;
    const to = { x: e.position.x, y: e.position.y + h, z: e.position.z };
    return hasLineOfSight(eye, to, (q) => bot.blockAt(vec3Lib(q.x, q.y, q.z)));
  } catch (err) { return false; }
}

/** Un tick de frappe passive. Jamais de throw ; ne touche jamais au pathfinder ni au jeton de tâche. */
function auraTick() {
  if (_auraBusy) return;
  if (_craftDepth > 0) return;   // fenêtre de craft ouverte : un equip/coup la désynchronise (craftSmart)
  if (_respawnFlee && !_respawnFlee.stuck) return;   // fuite d'avant-abri : un coup casse le sprint (sauf coincé)
  try {
    const p = bot.entity && bot.entity.position;
    if (!p || bot.health == null || bot.health <= 0) return;
    const self = { x: p.x, y: p.y, z: p.z };   // COPIE (Vec3 muté en place)
    const _ents = Object.values(bot.entities || {});
    const target = auraTarget(_ents, self, { canSee: canSeeEntityNow });
    if (!target) {
      // Rien au contact : un hostile qui APPROCHE (≤ 6 blocs, visible) → l'épée en main avant le contact
      // (aura.auraReadyPlan — Massii 24/10, « terre en main »). Abri / pilier en cours = pose de blocs : on
      // ne leur vole pas la main.
      const nearFoe = auraTarget(_ents, self, { reach: AURA_READY_REACH, canSee: canSeeEntityNow });
      if (!nearFoe) return;
      const wr = bestWeapon(bot);
      const nowR = Date.now();
      const rp = auraReadyPlan({
        near: true, weapon: wr ? wr.name : null, held: bot.heldItem ? bot.heldItem.name : null,
        digging: !!bot.targetDigBlock, eating: !!bot.usingHeldItem || eatLockActive(),
        pvpTarget: bot.pvp ? bot.pvp.target : null, busy: !!_shelterInFlight || !!_meleePillar,
        lastReadyAt: _auraReadyAt, now: nowR,
      });
      if (rp.act !== 'equip') return;
      _auraBusy = true;
      _auraReadyAt = nowR;
      _auraLastHitAt = nowR;   // changer d'objet remet le cooldown 1.9+ à zéro
      Promise.resolve().then(() => bot.equip(wr, 'hand')).catch(() => {}).then(() => { _auraBusy = false; });
      _auraEmit('aura_ready', { mob: nearFoe.name, weapon: wr.name });
      return;
    }
    const w = bestWeapon(bot);
    const now = Date.now();
    const plan = auraPlan({
      target, weapon: w ? w.name : null, held: bot.heldItem ? bot.heldItem.name : null,
      digging: !!bot.targetDigBlock, eating: !!bot.usingHeldItem || eatLockActive(),
      pvpTarget: bot.pvp ? bot.pvp.target : null, lastHitAt: _auraLastHitAt, now,
    });
    if (plan.act === 'equip') {
      _auraBusy = true;
      _auraLastHitAt = now;   // changer d'objet remet le cooldown 1.9+ à zéro
      Promise.resolve().then(() => bot.equip(w, 'hand')).catch(() => {}).then(() => { _auraBusy = false; });
      return;
    }
    if (plan.act !== 'hit') return;
    _auraLastHitAt = now;
    bot.attack(target);
    const tp = target.position;
    _auraEmit('aura_hit', { mob: target.name, dist: Math.round(Math.hypot(tp.x - self.x, tp.y - self.y, tp.z - self.z) * 10) / 10 });
  } catch (e) { /* best-effort : jamais crasher le bot sur un coup */ }
}

/**
 * Un tick creeper (fix 20/10 — 11 morts « blown up by Creeper » en 1 h). Tout creeper à ≤ 4,5 blocs, ou
 * qui gonfle à ≤ 7, déclenche une FUITE FRANCHE jusqu'à ≥ 8 blocs (creeper.fleeDone), réévaluée à CHAQUE
 * tick (l'ancien verrou de 3 s après un « petit pas » rendait la mèche invisible pendant qu'elle brûlait),
 * en VERROUILLANT le pathfinder (goalHold) : le planner, un goto, mineflayer-pvp ou un stopMotion ne
 * peuvent plus reposer leur but par-dessus — mesuré : `explore_waypoint` posé la même milliseconde que
 * le but de fuite. Le minage en cours est interrompu, le combat pvp arrêté. Jamais de mêlée sur un creeper.
 * Jamais de throw.
 */
function creeperTick() {
  try {
    const now = Date.now();
    const p = bot.entity && bot.entity.position;
    if (!p) return;
    const self = { x: p.x, y: p.y, z: p.z };   // COPIE (Vec3 muté en place)
    let best = null, bestD = Infinity;
    for (const e of Object.values(bot.entities || {})) {
      if (!e || e.name !== 'creeper' || e.isValid === false || !e.position) continue;
      const d = Math.hypot(e.position.x - self.x, e.position.y - self.y, e.position.z - self.z);
      if (d <= CREEPER_SCAN_RADIUS && d < bestD) { best = e; bestD = d; }
    }
    const dist = best ? Math.round(bestD * 10) / 10 : null;
    if (_creeperFlee) {
      const took = now - _creeperFlee.startedAt;
      const done = creeperFleeDone(best, self);
      if (done || took >= CREEPER_FLEE_MAX_MS) {
        const dropped = releaseGoalHold(_creeperHold);
        _creeperFlee = null;
        _auraEmit('creeper_flee_end', { dist, took_ms: took, dropped, why: done ? 'safe' : 'max' });
        return;
      }
      if (best && isCreeperFusing(best)) _creeperFlee.fusing = true;
      if (now - _creeperFlee.lastSetAt < CREEPER_REPLAN_MS) return;
      const dest2 = creeperAwayPoint(self, best.position, CREEPER_FLEE_KEEP);
      if (!dest2) return;
      lavaGuard.strictFor(CREEPER_REPLAN_MS + 1000, now);
      holdSetGoal(bot.pathfinder, _creeperHold, new pfGoals.GoalNearXZ(dest2.x, dest2.z, 1), false);
      _creeperFlee.lastSetAt = now;
      return;
    }
    if (_shelterInFlight) return;   // terré dans l'abri : on ne sort pas du trou
    if (!best) return;
    const plan = creeperPlan(best, self);
    const fusing = isCreeperFusing(best);
    if (plan === 'ignore') { _auraEmit('creeper_ignored', { dist, fusing }); return; }
    const dest = creeperAwayPoint(self, best.position, CREEPER_FLEE_KEEP);
    if (!dest) return;
    skeletonRushYield('creeper_flee');
    if (bot.pvp && bot.pvp.target) { try { bot.pvp.stop(); } catch (e) {} }
    if (bot.targetDigBlock && typeof bot.stopDigging === 'function') { try { bot.stopDigging(); } catch (e) {} }
    holdGoal(_creeperHold, now + CREEPER_FLEE_MAX_MS, 'creeper');
    // Fuite : la lave bordière devient un DERNIER recours dans l'A* (23/10 : creeper_flee puis la lave 0,5 s
    // après, NethBot2 ×2). Un sprint au bord d'une mare finit dedans au moindre écart.
    lavaGuard.strictFor(CREEPER_FLEE_MAX_MS + 1000, now);
    // But XZ (jamais 3D à l'altitude courante, piège #72b), figé (dynamic=false), POSÉ À TRAVERS le verrou.
    holdSetGoal(bot.pathfinder, _creeperHold, new pfGoals.GoalNearXZ(dest.x, dest.z, 1), false);
    try { if (typeof bot.setControlState === 'function') bot.setControlState('sprint', true); } catch (e) {}
    _creeperFlee = { startedAt: now, lastSetAt: now, fusing };
    _auraEmit('creeper_flee', { dist, fusing });
  } catch (e) { /* best-effort */ }
}
setInterval(() => { auraTick(); creeperTick(); }, AURA_TICK_MS);
setInterval(() => { try { deepWorkTick(); } catch (e) { /* best-effort */ } }, 15000);   // chantier de diamant (deepWork.js)
// CARTOGRAPHIE EN PASSANT (survey.js, Massii 24/10 : plus de cartographes, les MINEURS nourrissent la carte) :
// biomes en surface, minerais des chunks chargés sous terre. Throttlé 45 s dans le module ; jamais pendant un
// combat, un dig, un craft, un abri, une fuite de creeper ou un pilier. ⚠️ NIVEAU MODULE (piège #56).
const _survey = createSurvey({ worldKey: () => (bot && bot._worldKey) || 'overworld', emit: (e) => emit(e) });
function surveyBusyNow() {
  try {
    if (!bot || !bot.entity) return true;
    if (bot.targetDigBlock || (bot.pvp && bot.pvp.target) || _craftDepth > 0 || _shelterInFlight || _creeperFlee || _meleePillar) return true;
    if (bot.health == null || bot.health < 8) return true;
    const h = bot.nearestEntity((x) => x && x.kind === 'Hostile mobs');
    return !!(h && h.position && h.position.distanceTo(bot.entity.position) <= 8);
  } catch (e) { return true; }
}
setInterval(() => { try { if (!IS_MAPPER) _survey.tick(bot, { busy: surveyBusyNow() }); } catch (e) { /* best-effort */ } }, 15000);
setInterval(meleePillarTick, PILLAR_TICK_MS);   // pilier anti-mêlée (glue près de guardSpawn)

// ── PLUS DE PIOCHE → EN REFAIRE UNE (Massii 2026-07-26 : « si ils n'ont plus de pioche ils doivent
// en faire une »). La capacité existait (`recoverPickaxe`, buts wooden_pickaxe/stone_pickaxe) mais
// n'était déclenchée QUE depuis le branch-mine, et dans la chaîne armure les buts pioche sont
// court-circuités dès que l'armure est complète (`withFinal(g, IA)`) : un bot équipé mais désarmé
// de sa pioche ne la refaisait jamais. Filet indépendant de la tâche, borné, silencieux s'il manque
// la matière (le planner, lui, ira chercher le bois/cobble).
// ⚠️ MATIÈRE EN POCHE OBLIGATOIRE (fix 18/08 — mesuré en live : `pickaxe_missing` ~300/h). Sans
// regarder la poche, chaque passe (20 s) lançait craftSmart pierre puis bois ; chaque appel passait
// par withCraftingTable → pathfinder.goto vers une table jusqu'à 30 s, ce qui ANNULAIT le but
// pathfinder du planner (explore/gather) — la même classe de bug que la migration en parallèle.
// Sans matière il n'y a rien à crafter : on ne fait rien, c'est le planner qui ira chercher bois et
// pierre (décision pure gear.pickaxeRecraftPlan). L'event reste, mais au plus 1 par minute.
let _pickFixBusy = false;
let _lastPickMissingAt = 0;
const PICK_MISSING_EMIT_MS = 60000;
// BACKOFF (fix 20/10) : MapBot2, session 318 — stone_pickaxe puis wooden_pickaxe relancés toutes les
// 20 s pendant 30 min (89 `no_table:unknown_item`) avec EXACTEMENT la même poche (930 cobble, 3 planches,
// 8 bâtons). Un craft raté n'est retenté qu'après 40 s, 80 s, 160 s… (≤ 10 min) tant que la matière de
// craft (craftSignature) et la raison restent les mêmes ; la moindre bûche ramassée lève l'attente.
const _pickBackoff = createCraftBackoff();
async function pickFixPass(plan, hasPick) {
  for (const name of plan) {
    const sig = craftSignature(bot.inventory.items());
    if (_pickBackoff.blocked(name, sig, Date.now())) continue;
    let r = null;
    try { r = await withTimeout(craftSmart({ name, count: 1 }), 60000, () => {}); } catch (e) { r = null; }
    if (hasPick()) { _pickBackoff.ok(name); emit({ type: 'pickaxe_recrafted', name }); return true; }
    const reason = (r && r.reason) || 'failed';
    const wait = _pickBackoff.fail(name, reason, sig, Date.now());
    emit({ type: 'craft_backoff', item: name, reason, wait_s: Math.round(wait / 1000) });
  }
  return false;
}
setInterval(async () => {
  if (_pickFixBusy) return;
  const hasPick = () => ((bot.inventory && bot.inventory.items()) || [])
    .some((i) => i.name && i.name.endsWith('_pickaxe'));
  try {
    if (!bot.inventory || !bot.entity) return;
    if (hasPick()) return;
    // `_migrating` (fix 18/08) : la table qu'on irait chercher volerait le pathfinder à la jambe.
    // `_shelterInFlight` (discipline de nuit, 19/10 soir) : le craft va chercher une table jusqu'à 48 blocs
    // (withCraftingTable) — pas question de sortir du trou pour ça, la pioche attendra l'aube.
    if (_imminentBusy || panicInFlight || _armorBusy || _baseBusy || _migrating || _shelterInFlight) return;
    const plan = pickaxeRecraftPlan(bot.inventory.items());
    const now = Date.now();
    if (now - _lastPickMissingAt >= PICK_MISSING_EMIT_MS) {
      _lastPickMissingAt = now;
      emit({ type: 'pickaxe_missing', craftable: plan });
    }
    if (!plan.length) return;
    _pickFixBusy = true;
    await pickFixPass(plan, hasPick);
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
    if (_digOutBusy) { _jamSample = null; return; }                      // l'escalier creuse : ce n'est pas un jam
    if (_pitEscapeBusy) { _jamSample = null; return; }                   // sortie de puits en cours : idem
    const p = bot.entity.position;
    const digging = !!bot.targetDigBlock;
    const hasGoal = !!(bot.pathfinder && bot.pathfinder.goal);
    const now = Date.now();
    if (!hasGoal || digging) { _jamSample = null; return; }
    if (!_jamSample) { _jamSample = { x: p.x, y: p.y, z: p.z, t: now }; return; }
    // 3D (25/10) : monter/descendre dans une grotte est un progrès — en XZ seul, un bot qui grimpe vers un
    // diamant passait pour coincé et le watchdog coupait son trajet (6 `interrupted` sur 16).
    const d = Math.sqrt((p.x - _jamSample.x) ** 2 + ((p.y - (_jamSample.y ?? p.y))) ** 2 + (p.z - _jamSample.z) ** 2);
    if (d >= 0.8) { _jamSample = { x: p.x, y: p.y, z: p.z, t: now }; return; }   // ça avance → resample
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
    // MIGRATION EN COURS (fix 18/08) : saut + dig ci-dessus oui (ils débloquent la jambe), escalade
    // NON — sous NO_GIVE `relocateToRegion` = /home safe = retour à l'ANCIENNE base, la zone qu'on
    // vient de juger morte (une des causes des `moved: 0`). Les jambes ont leur propre contournement
    // (legHeading) ; on ne compte même pas ces jams, sinon le giveUp tuerait le process en plein trek.
    if (_migrating) return;
    // ESCALADE : si le dig de l'unjam ne libère pas (jams répétés au MÊME endroit), le bot reboucle
    // droit dans l'obstacle (live 22/06 SOIR ResBot2 : unjam×12 à 381,65,395, 0 descente). Comme les
    // watchdogs flottant/océan, au 3e unjam ~même spot → relocate FORCÉ vers une cellule terre fraîche.
    const _je = recordJam(_jamEsc, p.x, p.z, now);
    _jamEsc = _je.state;
    // AU FOND D'UN PUITS (25/10, NethBot3) : relocate et re-path ne l'en sortent pas — on remonte.
    const _inPit = _je.escalate && stuckInPitNow();
    if (_je.escalate && !_inPit) _pitEscapeFails = 0;                  // jam ailleurs qu'au fond d'un trou : compteur neuf
    if (_inPit && _pitEscapeFails < PIT_ESCAPE_MAX_FAILS) {
      emit({ type: 'unjam_pit', x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z), fails: _pitEscapeFails });
      pitEscapeAndResume('unjam').catch((e) => emit({ type: 'error', message: String((e && e.message) || e) }));
      return;
    }
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
      // 3e TIER (20/10, NethBot1) : le respawn se refait AU MÊME ENDROIT — le compteur survit au process
      // (mémo de base, fusion) ; au 2e jam_loop ici, le process suivant creuse l'escalier dès le démarrage.
      let _jl = null;
      try {
        const m = jamLoopMemoWith(loadBaseState(), { x: p.x, y: p.y, z: p.z }, now);
        _jl = m.jamLoop;
        saveBaseState(m);
      } catch (e) { /* best-effort */ }
      emit({ type: 'autonomous_stalled', reason: 'jam_loop', x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z),
        repeat: _jl ? _jl.count : null });
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
        // MIGRATION EN COURS (fix 18/08) : la récupération ci-dessus (relâcher, dégager, retomber)
        // reste, le relocate NON — sous NO_GIVE c'est un /home safe vers l'ANCIENNE base, qui ruine
        // le trek. Le dernier recours (exit à 6 échecs) reste : un bot coincé à vie ne migrera pas.
        if (_floatFails === 3 && _migrating) {
          emit({ type: 'unstuck', cause: 'floating_relocate_skipped', ctx: 'migration' });
        } else if (_floatFails === 3) {
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
      // MIGRATION EN COURS (fix 18/08) : l'escapade à la nage ci-dessus suffit — pas de warp, qui
      // ramènerait le marcheur à l'ANCIENNE base (/home safe sous NO_GIVE) et ruinerait le trek.
      if (_migrating) {
        if (isInWater(bot)) emit({ type: 'water_rescue_no_warp', ctx: 'ocean_migration' });
      } else if (isInWater(bot) || _esc.forceRelocate) {                   // noyé OU baie persistante → terre ferme
        _floatSettleUntil = Date.now() + 15000;
        emit({ type: 'water_rescue_warp', reason: isInWater(bot) ? 'ocean_oscillation' : 'ocean_persistent' });
        try { stopMotion(); } catch (e) {}
        if (NO_GIVE) {
          if (safeWarpDown()) { emit({ type: 'water_rescue_no_warp', ctx: 'ocean' }); try { await escapeWater(bot, { emit }); } catch (e) {} }
          else if (safeHomeVeto('ocean')) { emit({ type: 'water_rescue_no_warp', ctx: 'ocean_camped' }); try { await escapeWater(bot, { emit }); } catch (e) {} }
          else { emit({ type: 'water_rescue_home_safe', ctx: 'ocean' }); await safeWarpHome('safe', { ctx: 'ocean' }); }
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
  // HORS du try (fix 19/10) : un `return` DANS le try passait par le finally, qui remettait
  // `_armorBusy` à false pendant que l'invocation précédente tournait encore (ensureArmor ≤150 s
  // pour un tick de 90 s) → deux forges en parallèle qui se disputent table, four et pathfinder.
  if (_armorBusy) return;
  try {
    // MIGRATION EN COURS (fix 18/08) : forger pose puis REPREND une table/un four (collectBlock =
    // un but pathfinder) → la jambe de migration est annulée. La prochaine passe (90 s) suffit.
    if (_migrating) return;
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
    const _wornBefore = [...worn];
    await withTimeout(ensureArmor({ ironKeep }), 150000, () => { try { stopMotion(); } catch (e) {} });
    // RÉPARATION (24/10 soir) : en phase diamant c'est ce timer qui reforge la pièce usée — sans changer
    // l'objectif des autres ni la phase. Event pour suivre.
    try {
      if (objType === 'diamond' || _teamLatchActive()) {
        for (const r of armorRepairs(_wornBefore, [..._wornArmor()])) emit({ type: 'armor_repair', slot: r.slot, item: r.item, objective: objType });
      }
    } catch (e) { /* best-effort */ }
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
  if (_smeltOppBusy) return;   // HORS du try : même piège que le timer d'armure (fonte ≤200 s, tick 60 s)
  try {
    if (_smeltOppBusy || _armorBusy || _stillBusy || _imminentBusy) return;   // jamais pendant un sauvetage PV
    if (_furnaceJob || _furnaceJobBusy) return;              // le four de mine cuit déjà (fondre en minant)
    if (_migrating) return;   // fix 18/08 : poser/reprendre le four volerait le pathfinder à la jambe de migration
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
    // `_nightHold` (discipline de nuit, 19/10 soir) : le planner retenu attend l'aube SANS bouger
    // (abri d'un autre appelant, eau, but de surface sous terre) — immobilité légitime, pas un desync.
    if (_stillBusy || _smeltOppBusy || _armorBusy || _nightHold) { _posSamples = []; return; }
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
          if (NO_GIVE) await safeWarpHome('safe', { ctx: 'desync_escape' });
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
