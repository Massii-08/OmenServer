'use strict';
// Boucle RESSOURCE (objectif `resource`, role worker) : lit worlds[<monde>].ores de la mémoire de
// monde du groupe (positions 3D EXACTES de minerais notés par les cartographes), choisit les
// cibles (priorité diamant>fer>… + proximité, cf. ores.js), navigue, mine avec la bonne pioche, et
// MET À JOUR LA CARTE : `ore_mined` (miné) / `ore_gone` (constaté absent) sont routés par le manager
// vers la store du groupe (remove_ore) → l'ore disparaît du fichier mémoire et de la carte.
// Une cible INATTEIGNABLE n'est PAS retirée (elle existe peut-être encore) — juste skippée localement.
//
// MODE QUOTA (opts.quota) : compteur par TYPE (quota.js, ex. 15💎/15 or/64 redstone/64 lapis/64 fer) —
//  - ne vise QUE les types encore manquants (allowTypes), s'arrête quand tout est atteint (quota_done) ;
//  - claims anti-collision entre bots (opts.claims, fichier partagé TTL) : une ore claimée par un
//    autre bot est re-éligible après 30 s (sa claim peut expirer) ;
//  - mémoire LIVE (opts.reloadMemory) : carte vide/épuisée → attente active (resource_waiting) +
//    re-lecture (les cartographes ajoutent encore) ; au-delà de maxIdleMs sans cible → starved ;
//  - inventaire plein → opts.cleanup (toss du junk de creusage — sous terre il n'y a pas de coffre,
//    et le deposit legacy jetterait AUSSI la pioche) ; sinon deposit legacy + noteBanked.
const { nextOreTarget, oreKey, listOres, isWaterAdjacent } = require('../ores');
const { bestToolFor } = require('../tools');
const { isOre } = require('../worldMemory');
const { createQuotaTracker } = require('../quota');
const { planBank } = require('../bank');
const { TIER_FOR, mostLackingType } = require('../gear');

let vec3; try { vec3 = require('vec3'); } catch (e) { vec3 = null; }
function _pos(t) { return vec3 ? vec3(t.x, t.y, t.z) : { x: t.x, y: t.y, z: t.z }; }

const BUSY_RETRY_MS = 30000;   // ore claimée par un autre : re-tentée après ce délai

// Coupe le mouvement résiduel (même garde-fou que gather : collectBlock peut laisser son goal actif).
function _stopResidual(bot) {
  try { bot.pathfinder && bot.pathfinder.setGoal && bot.pathfinder.setGoal(null); } catch (e) {}
  try {
    if (bot.setControlState) ['forward', 'back', 'left', 'right', 'sneak', 'jump'].forEach((c) => bot.setControlState(c, false));
  } catch (e) {}
}

function _items(bot) {
  try { return ((bot.inventory && bot.inventory.items()) || []).map((i) => ({ name: i.name, count: i.count })); }
  catch (e) { return []; }
}

/**
 * runResource(bot, opts, token) → {ok:true, mined[, done]} | {ok:true, mined, cancelled}
 *                               | {ok:false, reason, mined}
 *  memory/worldKey : mémoire de monde + clé (sinon bot._worldMemory/_worldKey)
 *  emit      : hook events (resource_* / ore_mined / ore_gone / quota_*)
 *  goto      : async (target) => void — navigation BORNÉE vers (x,y,z), throw si inatteignable
 *              (injectée par index.js : withTimeout + persistance par progrès ; identité dans les tests)
 *  onTarget  : hook async avant chaque cible (survie : settleSurvivalKit/escapeWater)
 *  pickTier  : () => number — meilleur palier de pioche en poche (filtre les cibles inminables)
 *  deposit   : async (bot) => {ok} — dépôt coffre legacy (inventaire plein, hors mode quota)
 *  quota     : {type: n} — active le mode quota (cf. en-tête)
 *  claims    : {tryClaim(key), refresh(key), release(key)} — anti-collision multi-bots
 *  reloadMemory : () => memory — re-lecture de la carte live (mode quota)
 *  cleanup   : async (bot) => void — toss du junk quand l'inventaire est plein (mode quota)
 *  mineFor   : async (type) => {ok} — phase 2 anti-xray : BRANCH-MINE au Y optimal du type
 *              quand la carte n'a aucune cible (minage réel > attente passive)
 *  relocate  : async () => void — self-warp vers une zone fraîche (auto-récupération starvation)
 *  ensureGear: async (neededTypes) => void — maintenance pioches (craft stone/iron pick)
 *  sleep/now/waitMs/maxIdleMs/collectTimeoutMs : injectables (tests)
 */
async function runResource(bot, opts = {}, token = null) {
  const emit = opts.emit || (() => {});
  let memory = opts.memory || bot._worldMemory || null;
  const wkey = opts.worldKey || bot._worldKey || null;
  const doGoto = opts.goto;
  const onTarget = opts.onTarget || null;
  const deposit = opts.deposit || null;
  const cleanup = opts.cleanup || null;
  const pickTier = opts.pickTier || null;
  const claims = opts.claims || null;
  const reload = opts.reloadMemory || null;
  const tracker = opts.quota ? createQuotaTracker(opts.quota) : null;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const clock = opts.now || Date.now;
  const waitMs = opts.waitMs != null ? opts.waitMs : 5000;
  const maxIdleMs = opts.maxIdleMs != null ? opts.maxIdleMs : 600000;
  // collectBlock peut geler INDÉFINIMENT (cible inminable après l'approche : lave, désync —
  // vécu live ResBot1 figé 25 min). Même garde-fou que le planner (piège #41d) : borne dure.
  const collectTimeoutMs = opts.collectTimeoutMs != null ? opts.collectTimeoutMs : 90000;
  const collectBounded = (block) => new Promise((resolve, reject) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; _stopResidual(bot); reject(new Error('collect_timeout')); } }, collectTimeoutMs);
    bot.collectBlock.collect(block).then(
      (v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } },
      (e) => { if (!done) { done = true; clearTimeout(t); reject(e); } });
  });

  const mineFor = opts.mineFor || null;
  const relocate = opts.relocate || null;
  const ensureGear = opts.ensureGear || null;
  // BANK-EN-PLACE (no-keepInventory) : pose un coffre + dépose les LIVRABLES (diamant/redstone/lapis/
  // lingots) quand on en porte trop → une mort n'efface plus la progression (vécu live ResBot3 :
  // 5💎+23🔴 perdus à une noyade). opts.bank(depositList) pose+dépose et retourne {ok,before,after} ;
  // ICI on décide QUAND (planBank, pur+testé) et on crédite le compte (tracker.noteBanked).
  const bank = opts.bank || null;
  const bankOpts = opts.bankOpts || {};
  let bankFailAt = 0;            // backoff : un bank raté (pas de coffre/sol) n'est pas re-tenté en boucle
  const maxRelocations = opts.maxRelocations != null ? opts.maxRelocations : 8;
  const maxTargetDist = opts.maxTargetDist != null ? opts.maxTargetDist : 2000;
  // DEEP-FIRST : en mode quota, on ignore les cibles mappées au-dessus de ce Y (couches aquifères
  // 1.18, y>0 = noyade/floating mortels live) → descente forcée vers le deepslate SEC (diamants inclus).
  const deepQuotaY = opts.deepQuotaY != null ? opts.deepQuotaY : 0;
  const mineExposed = opts.mineExposed || null;   // G-bis : minage en grotte des diamants EXPOSÉS
  const failRelocateAt = opts.failRelocateAt != null ? opts.failRelocateAt : 2;  // un échec ≈ 8-12 min (vécu) — fuir vite les zones d'eau

  const skip = new Set();        // cibles traitées (minées/absentes/ratées) : on ne re-vise jamais 2×
  const busyUntil = new Map();   // oreKey → ts : claimée par un autre bot, re-éligible après
  let mined = 0;
  let idleSince = null;
  let relocations = 0;
  let failStreak = 0;            // unreachable consécutifs : zone pourrie (lac…) → relocate
  let ironBootstraps = 0;        // mineFor('iron') de bootstrap consécutifs SANS gain de palier
  let mineForFails = 0;          // mineFor ratés consécutifs : relocate seulement à ≥3 (phase 3 —
                                 // un timeout de descente N'EST PAS une zone pourrie : le warp
                                 // surface détruisait la progression de descente, vécu V3Res4 ×5)
  let noPickSince = null;        // depuis quand on attend SANS pioche (tier<2) : starved rapide
  const noPickMaxMs = opts.noPickMaxMs != null ? opts.noPickMaxMs : 120000;
  let fullStreak = 0;           // H4 : cleanups SUR PLACE consécutifs sur inv plein (cap pour éviter de figer)
  const invFull = () => !!(bot.inventory && typeof bot.inventory.emptySlotCount === 'function'
    && bot.inventory.emptySlotCount() <= 1);  // H4 : ne JAMAIS warper surface tant que l'inv est plein
  let zeroYield = 0;             // branches mineFor "ok" mais 0 GAIN du type cherché = épuisé local
                                 // → relocate (DoD : dia figé car branchMine -58 vide "réussit", vécu live)
  let lastProgress = '';

  function emitProgress() {
    if (!tracker) return;
    const counts = tracker.progress(_items(bot));
    const j = JSON.stringify(counts);
    if (j !== lastProgress) { lastProgress = j; emit({ type: 'quota_progress', counts }); }
  }

  emit({ type: 'resource_start', world: wkey, ores: listOres(memory, wkey).length,
         quota: tracker ? tracker.target : null });
  emitProgress();

  while (true) {
    if (token && token.cancelled) return { ok: true, mined, cancelled: true };

    // Quota atteint ? (vérifié en tête : un bot peut démarrer déjà servi)
    if (tracker && tracker.met(_items(bot))) {
      emitProgress();
      emit({ type: 'quota_done', mined });
      emit({ type: 'resource_done', mined });
      return { ok: true, mined, done: true };
    }

    // BANK-EN-PLACE : on porte trop de livrables → dépose-les en coffre sur place (anti-perte à la mort).
    // Décision PURE (planBank) ; backoff 2 min sur échec (pas de coffre item / sol impossible).
    if (bank && tracker && clock() - bankFailAt > 120000) {
      const plan = planBank(_items(bot), tracker.target, bankOpts);
      if (plan.shouldBank) {
        try {
          const r = await bank(plan.deposit);
          if (r && r.ok) {
            tracker.noteBanked(r.before, r.after);
            emit({ type: 'resource_bank', ok: true, deposited: plan.deposit, pos: r.pos || null });
            emitProgress();
          } else {
            bankFailAt = clock();
            emit({ type: 'resource_bank', ok: false, reason: (r && r.reason) || 'unknown' });
          }
        } catch (e) { bankFailAt = clock(); emit({ type: 'resource_bank', ok: false, reason: 'exception' }); }
        if (token && token.cancelled) return { ok: true, mined, cancelled: true };
      }
    }

    const from = bot.entity && bot.entity.position;
    if (!from) return { ok: false, reason: 'no_pos', mined };
    // Maintenance d'outillage (phase 2) : pioche d'avance / palier requis — AVANT de viser.
    if (ensureGear && tracker) {
      try { await ensureGear(tracker.remainingTypes(_items(bot))); } catch (e) { /* best-effort */ }
      if (token && token.cancelled) return { ok: true, mined, cancelled: true };
    }
    const tier = typeof pickTier === 'function' ? pickTier() : pickTier;

    // Exclusions du tour : déjà traitées + claimées par d'autres (re-éligibles après délai).
    const now = clock();
    const skipNow = new Set(skip);
    for (const [k, until] of busyUntil) {
      if (until > now) skipNow.add(k); else busyUntil.delete(k);
    }
    const allowTypes = tracker ? tracker.remainingTypes(_items(bot)) : undefined;
    // BUG PRIO 3.1 (résolution Massii 16/06 — débit diamant) : le diamant est le GOULOT de la DoD
    // (64) ; les autres types se remplissent vite + le minage profond serpentin en récolte AUSSI au
    // passage (redstone/fer/lapis du deepslate). Tant que le quota diamant manque, le diamant passe
    // DEVANT (priority:['diamond']) → exposé visé→cave-first, enterré→deep serpentine. Sinon le
    // nearest-first laissait le bot rafler le fer exposé proche sans JAMAIS viser le diamant profond
    // (vécu live : 0💎 en 1h40). Quota diamant REMPLI → on revient au PLUS PROCHE (réduit le voyage).
    // Le deep-serpentine évite le « long tunnel par diamant » que le nearest-first (#42a) craignait.
    const _wantsDiamond = !!allowTypes && (allowTypes instanceof Set
      ? allowTypes.has('diamond') : (Array.isArray(allowTypes) && allowTypes.includes('diamond')));
    let target = nextOreTarget(memory, wkey, from, {
      skip: skipNow, allowTypes,
      priority: tracker ? (_wantsDiamond ? ['diamond'] : []) : undefined,
      maxDist: tracker ? maxTargetDist : undefined,   // phase 2 : miner LOCAL, pas traverser la carte
      pickTier: (typeof tier === 'number' ? tier : undefined),
    });
    // DEEP-FIRST (anti-aquifère §1.5 + DoD diamant) : en mode quota, ignorer une cible mappée SHALLOW
    // (y > deepQuotaY = couches pleines d'eau en 1.18) → tomber dans mineFor qui DESCEND vers le
    // deepslate sec. Évite le barbotage/noyade/floating mortels (vécu live : reflex surface en boucle).
    // G-bis : on N'ANNULE PAS une cible EXPOSÉE même shallow (y>deepQuotaY) — un diamant exposé en
    // grotte est visible/minable direct (cible prioritaire), pas une couche d'eau à fuir. Seuls les
    // ores ENTERRÉS shallow sont nulls → mineFor descend vers le deepslate sec.
    if (tracker && target && typeof target.y === 'number' && target.y > deepQuotaY && mineFor && !target.exposed) target = null;

    if (!target) {
      if (!reload && !mineFor) break;                  // legacy : carte épuisée → done
      // ── Phase 2 (anti-xray) : pas de cible mappée → MINER POUR DE VRAI. Branch-mine au Y
      // optimal du type LE PLUS manquant minable avec la pioche courante ; si le manque exige
      // un palier qu'on n'a pas (diamant sans pioche fer) → miner du FER d'abord (bootstrap).
      if (mineFor && tracker) {
        const prog = tracker.progress(_items(bot));
        let mtype = null;
        const ranked = Object.entries(prog)
          .filter(([, v]) => v.have < v.target)
          .sort((a, b) => ((b[1].target - b[1].have) / b[1].target) - ((a[1].target - a[1].have) / a[1].target))
          .map(([t]) => t);
        const tierNow = typeof tier === 'number' ? tier : -1;
        mtype = ranked.find((t) => (TIER_FOR[t] || 0) <= tierNow) || null;
        // Phase 3 : tant qu'on n'a PAS la pioche fer, le FER passe devant tout (il débloque
        // diamant/or/redstone, Y=16 est peu profond et peu laveux) — bootstrap PAR DESIGN.
        // (Avant : l'ordre des ratios faisait miner du lapis à Y=0 avec la pioche pierre.)
        if (tierNow >= 2 && tierNow < 3 && ranked.includes('iron')) mtype = 'iron';
        // NB : PAS de forçage mtype='diamond' — il bloquait le bot à y-58 (diamant rare) en ne
        // collectant QUE le redstone en opportunisme (red plein vite, mais lapis/iron JAMAIS car pas
        // à y-58) → quota_done IMPOSSIBLE (lap/iro=0, vécu live run #16). Le ranked.find (ratio) ci-dessus
        // mine le type LE PLUS MANQUANT à son Y optimal (lapis y0, iron y16, diamant y-58) → tous les
        // types se complètent (nearest-first du brief §2).
        let isBootstrap = false;
        if (!mtype && ranked.length && tierNow >= 2) { mtype = 'iron'; isBootstrap = true; }  // bootstrap palier fer
        // bug #1 (Massii, soir) : le DIAMANT ne se GRID-MINE JAMAIS. Si le fallback visait le diamant
        // (carte sans diamant exposé reachable) → RELOCALISER vers un cluster EXPOSÉ (cave-hop, grotte
        // suivante) au lieu de strip-miner en grille. Plus de relocations → on rabat sur un AUTRE type
        // minable (fer/lapis), jamais le diamant en grille ; sinon mtype=null (attente, pas de grid).
        if (mtype === 'diamond') {
          // Cave-hop UNIQUEMENT s'il existe des clusters de diamants EXPOSÉS mappés (grottes) à drainer.
          // Sinon (carte vide / grottes épuisées) → on NE relocate PAS : on laisse le MINAGE PROFOND
          // SERPENTIN ci-dessous descendre à y≈-58 (BUG PRIO 3.1 live 16/06 : les diamants enterrés ne
          // sont PAS dans les grottes ; le cave-hop bouclait en surface sans JAMAIS descendre, vécu ResBot1).
          const _hasCaveDiamond = listOres(memory, wkey).some(
            (o) => o && o.exposed && !o.wet && String(o.material || '').includes('diamond'));
          if (_hasCaveDiamond && relocate && relocations < maxRelocations) {
            relocations++;
            emit({ type: 'resource_relocate', n: relocations, cause: 'cavehop_diamond' });
            try { await relocate({ diamondCluster: true }); } catch (e) { /* best-effort */ }
            skip.clear(); busyUntil.clear();
            if (reload) memory = reload() || memory;
            continue;
          }
          // pas de grotte à diamants exploitable → minage profond SERPENTIN direct (mtype reste 'diamond',
          // flow vers le bloc de minage ci-dessous avec l'option serpentine ; JAMAIS de grille).
        }
        // SANS pioche pierre (kit raté), RIEN n'est minable : attendre 10 min × 8 relocations
        // était une éternité passive (vécu V3Res1 : resource_waiting ×178). Starved RAPIDE →
        // exit → respawn backend → kit re-tenté depuis un état frais.
        if (!mtype && ranked.length && tierNow < 2) {
          if (noPickSince == null) noPickSince = clock();
          if (clock() - noPickSince > noPickMaxMs) {
            emit({ type: 'resource_starved', mined, why: 'no_pickaxe' });
            return { ok: false, reason: 'starved', mined };
          }
        } else {
          noPickSince = null;
        }
        // Impasse de bootstrap : miner du fer ne sert à rien sans STICKS pour crafter la pioche
        // (vécu : ×50 mineFor('iron') ok sans jamais progresser — il faut du BOIS = surface =
        // le kit complet). 3 bootstraps sans gain de palier → sortie starved → respawn → kit.
        if (isBootstrap) {
          ironBootstraps++;
          if (ironBootstraps > 3) {
            emit({ type: 'resource_starved', mined, why: 'bootstrap_dead_end' });
            return { ok: false, reason: 'starved', mined };
          }
        } else {
          ironBootstraps = 0;
        }
        if (mtype) {
          // Phase 3 : on passe AUSSI le manque restant → branchMine s'arrête sur le DELTA récolté
          // (l'ancien stop absolu `diamond>=1` rendait branchMine inopérant dès le 1er diamant).
          const needed = Math.max(1, (prog[mtype] ? prog[mtype].target - prog[mtype].have : 1));
          const _serp = (mtype === 'diamond');   // diamant enterré (Path B) → galerie SERPENTINE anti-grille (anti-tell X-ray)
          if (_serp) emit({ type: 'resource_deep_serpentine', material: mtype, fallback: 'no_mapped_cave' });
          emit({ type: 'resource_mine_for', material: mtype, needed });
          let r = null;
          try { r = await mineFor(mtype, needed, _serp ? { serpentine: true } : undefined); }
          catch (e) { r = { ok: false, reason: 'error', detail: String((e && e.message) || e).slice(0, 120) }; }
          emit({ type: 'resource_mine_for_done', material: mtype, ok: !!(r && r.ok),
                 reason: (r && r.reason) || null, detail: (r && r.detail) || undefined });
          if (token && token.cancelled) return { ok: true, mined, cancelled: true };
          if (reload) memory = reload() || memory;
          if (r && r.ok) {
            idleSince = null;
            mineForFails = 0;
            // RELOCATE sur ÉPUISEMENT LOCAL (DoD diamant) : mineFor "réussit" (branche complétée) mais
            // 0 GAIN du type cherché → le minerai est épuisé localement. Sans ça, le bot branch-mine du
            // -58 vide EN BOUCLE sans jamais relocaliser (la branche "réussit" → idle jamais armé →
            // dia figé, vécu live ResBot2 dia:27 figé ~45 min). 3 branches sans gain → terrain frais.
            const haveBefore = (prog[mtype] && prog[mtype].have) || 0;
            const progAfter = tracker.progress(_items(bot));
            const haveAfter = (progAfter[mtype] && progAfter[mtype].have) || 0;
            if (haveAfter <= haveBefore) {
              zeroYield++;
              if (zeroYield >= 3 && relocate && relocations < maxRelocations) {
                relocations++; zeroYield = 0;
                emit({ type: 'resource_relocate', n: relocations, cause: 'local_depleted', material: mtype });
                try { await relocate({ diamondCluster: mtype === 'diamond' }); } catch (e) { /* best-effort */ }
                skip.clear(); busyUntil.clear();
                if (reload) memory = reload() || memory;
              }
            } else { zeroYield = 0; }
          } else {
            // Échec : pause + comptabilité d'inactivité — un mineFor qui throw en boucle
            // SPINNAIT à l'infini une fois le cap de relocalisations épuisé (vécu : ×100
            // events/min). starved → return → l'auto-respawn backend redonne un état frais.
            // Phase 3 : relocate seulement après 3 échecs CONSÉCUTIFS — un timeout de descente
            // a fait du PROGRÈS (y a baissé) ; le warp surface le détruisait (vécu V3Res4 :
            // 5 timeouts → 5 warps → starved sans avoir jamais atteint Y-58).
            mineForFails++;
            if (mineForFails >= 3 && relocate && relocations < maxRelocations) {
              relocations++;
              mineForFails = 0;
              emit({ type: 'resource_relocate', n: relocations, cause: 'mine_for_fails' });
              try { await relocate(); } catch (e) { /* best-effort */ }
              skip.clear(); busyUntil.clear();
              if (token && token.cancelled) return { ok: true, mined, cancelled: true };
            }
            if (idleSince == null) idleSince = clock();
            if (clock() - idleSince > maxIdleMs) {
              emit({ type: 'resource_starved', mined, idleMs: clock() - idleSince });
              return { ok: false, reason: 'starved', mined };
            }
            await sleep(waitMs);
            if (token && token.cancelled) return { ok: true, mined, cancelled: true };
          }
          continue;
        }
      }
      if (!reload) break;
      if (idleSince == null) idleSince = now;
      if (now - idleSince > maxIdleMs) {
        // ── Auto-récupération (phase 2) : starvation → self-warp zone fraîche + reset des
        // exclusions locales (les claims/échecs d'ici ne valent rien là-bas), puis on repart.
        if (relocate && relocations < maxRelocations) {
          relocations++;
          emit({ type: 'resource_relocate', n: relocations });
          try { await relocate(); } catch (e) { /* best-effort */ }
          skip.clear(); busyUntil.clear();
          idleSince = null;
          if (token && token.cancelled) return { ok: true, mined, cancelled: true };
          if (reload) memory = reload() || memory;
          continue;
        }
        emit({ type: 'resource_starved', mined, idleMs: now - idleSince });
        return { ok: false, reason: 'starved', mined };
      }
      emit({ type: 'resource_waiting', world: wkey });
      await sleep(waitMs);
      if (token && token.cancelled) return { ok: true, mined, cancelled: true };
      memory = reload() || memory;                     // les cartographes ajoutent encore
      continue;
    }
    idleSince = null;
    const key = oreKey(target);

    // Claim anti-collision : un autre bot la tient → skip temporaire (sa claim peut expirer).
    if (claims && !claims.tryClaim(key)) {
      busyUntil.set(key, now + BUSY_RETRY_MS);
      continue;
    }
    skip.add(key);
    emit({ type: 'resource_target', material: target.material, x: target.x, y: target.y, z: target.z });
    // Survie d'abord (settleSurvivalKit/escapeWater injectés) : on règle les menaces AVANT le trajet.
    if (onTarget) { try { await onTarget(); } catch (e) {} }
    if (token && token.cancelled) return { ok: true, mined, cancelled: true };

    // Inventaire plein → tri AVANT d'aller miner. Mode quota : toss du junk (cleanup) — pas de
    // coffre sous terre et le deposit legacy jetterait la pioche. Legacy : dépôt coffre (≤12 blocs).
    if (bot.inventory && typeof bot.inventory.emptySlotCount === 'function'
        && bot.inventory.emptySlotCount() <= 1) {
      if (cleanup) {
        try { await cleanup(bot); } catch (e) {}
        emit({ type: 'resource_cleanup' });
      } else if (deposit) {
        const before = _items(bot);
        let d = null;
        try { d = await deposit(bot); } catch (e) {}
        if (tracker) tracker.noteBanked(before, _items(bot));  // le dépôt ne fait pas perdre le compte
        emit({ type: 'resource_deposit', ok: !!(d && d.ok) });
      }
      if (token && token.cancelled) return { ok: true, mined, cancelled: true };
    }

    // §3.G — MINAGE HUMAIN (mode quota, exigence Massii §1.6) : la cible mappée = CAP/région, JAMAIS un
    // beeline X-ray sur le bloc. On strip-mine VERS sa région (mineFor DIRIGÉ au Y optimal via heading) ;
    // le flood-fill (branchMine) vide les veines découvertes. Le bot ne fonce jamais pile sur le bloc —
    // il le « découvre » en creusant. (Mode legacy SANS mineFor : beeline direct ci-dessous, inchangé.)
    if (mineFor) {
      // RÈGLE EAU DURE en MODE QUOTA (point #3 — la version legacy ~l.480 est INATTEIGNABLE ici : elle
      // vit APRÈS le `continue` de ce bloc). Re-vérif LIVE autour de la cible (si chunk chargé) : eau à
      // ≤2 blocs → on ABANDONNE la veine entière (skip + voisins), jamais l'eau même pour un diamant
      // (anti stale-memory / flag wet manquant). target.wet couvre le flag mappé ; isWaterAdjacent le live.
      if (target.wet || isWaterAdjacent(bot, target)) {
        if (claims) claims.release(key);
        for (const o of listOres(memory, wkey)) {
          if (Math.abs(o.x - target.x) <= 4 && Math.abs(o.y - target.y) <= 4 && Math.abs(o.z - target.z) <= 4) skip.add(oreKey(o));
        }
        emit({ type: 'ore_wet', world: wkey, x: target.x, y: target.y, z: target.z });
        continue;
      }
      const _from = bot.entity && bot.entity.position;
      const heading = _from
        ? { dx: Math.sign(Math.round(target.x - _from.x)), dz: Math.sign(Math.round(target.z - _from.z)) }
        : null;
      const _prog = tracker ? tracker.progress(_items(bot)) : null;
      const _needed = _prog && _prog[target.material] ? Math.max(1, _prog[target.material].target - _prog[target.material].have) : 1;
      const _haveBefore = _prog && _prog[target.material] ? _prog[target.material].have : 0;
      let _rr = null;
      const _isDiamond = String(target.material || '').includes('diamond');
      // DIAMANT (bug #1 Massii soir + BUG PRIO 3.1 résolution 16/06) : JAMAIS de strip-mine en GRILLE.
      //  - EXPOSÉ (visible en grotte) → CAVE-FIRST prioritaire : mineExposed marche/creuse-SERPENTE
      //    jusqu'à la grotte ; ÉCHEC (trop profond/pas de chemin) → REPLI minage profond SERPENTIN
      //    (au lieu de boucler/relocate-surface qui détruisait la descente, vécu live) ;
      //  - ENTERRÉ (hors-grotte) → MINAGE PROFOND SERPENTIN direct à y≈-58 (résolution 16/06 : on
      //    creuse les diamants au volume en ondulant — anti-tell X-ray, eau scellée par branchMine).
      // Les AUTRES ores (fer/lapis/…) gardent le cave-first si exposé, sinon le strip-mining dirigé.
      const _deepSerpentine = async (fallback) => {
        emit({ type: 'resource_deep_serpentine', material: target.material, x: target.x, y: target.y, z: target.z, ...(fallback ? { fallback } : {}) });
        try { return await mineFor(target.material, _needed, { serpentine: true }); }
        catch (e) { return { ok: false, reason: 'error', detail: String((e && e.message) || e).slice(0, 120) }; }
      };
      if (_isDiamond && target.exposed && !target.wet && mineExposed) {  // diamant exposé : cave-first PUIS repli profond
        emit({ type: 'resource_cave', material: target.material, x: target.x, y: target.y, z: target.z });
        try { await mineExposed(target); _rr = { ok: true }; }
        catch (e) { _rr = await _deepSerpentine('cave_failed'); }       // grotte inatteignable → minage profond
      } else if (_isDiamond) {
        _rr = await _deepSerpentine(null);                              // diamant enterré → minage profond serpentin
      } else if (target.exposed && !target.wet && mineExposed) {        // autres ores exposés → cave-first (inchangé)
        emit({ type: 'resource_cave', material: target.material, x: target.x, y: target.y, z: target.z });
        try { await mineExposed(target); _rr = { ok: true }; }
        catch (e) { _rr = { ok: false, reason: 'error', detail: String((e && e.message) || e).slice(0, 120) }; }
      } else {
        // AUTRES ores enterrés (fer/lapis/…) → strip-mining DIRIGÉ vers la région (heading), pas beeline.
        emit({ type: 'resource_region', material: target.material, toward: { x: target.x, y: target.y, z: target.z }, heading });
        try { _rr = await mineFor(target.material, _needed, { heading }); }
        catch (e) { _rr = { ok: false, reason: 'error', detail: String((e && e.message) || e).slice(0, 120) }; }
      }
      if (claims) claims.release(key);
      if (token && token.cancelled) return { ok: true, mined, cancelled: true };
      if (reload) memory = reload() || memory;
      const _haveAfter = tracker ? (tracker.progress(_items(bot))[target.material] || { have: 0 }).have : 0;
      if (_haveAfter > _haveBefore) { mined += (_haveAfter - _haveBefore); emit({ type: 'ore_mined', world: wkey, material: target.material }); emitProgress(); }
      if (_rr && _rr.ok) {
        idleSince = null; mineForFails = 0; failStreak = 0;
        // §3.G ANTI-STAGNATION (vécu live : ResBot2 figé à 38, ~20 blocs en 20 min) : branche OK mais
        // 0 diamant gagné = on re-mine une zone -58 ÉPUISÉE en re-ciblant des diamants mappés SHALLOW
        // (cave-exposés y>-40, JAMAIS atteints à -58 où on mine). Les diamants -58 ENFOUIS ne sont pas
        // mappés (non exposés) → on les trouve au VOLUME en couvrant du terrain -58 FRAIS. 3 branches
        // dirigées sans gain → relocate (sortir de la zone re-minée).
        if (_haveAfter <= _haveBefore) {
          // H4 : 0 gain car inventaire PLEIN (diamants minés tombés au sol, pas ramassés) = PAS un
          // épuisement → nettoyer SUR PLACE (toss junk + creuse devant) + re-tenter la MÊME zone,
          // JAMAIS warper en surface (vécu : ResBot2 trouvait des diamants puis se TP sans les prendre).
          if (invFull() && cleanup && fullStreak < 5) {
            fullStreak++;
            try { await cleanup(bot); } catch (e) { /* best-effort */ }
            emit({ type: 'resource_cleanup', reason: 'full_after_mine' });
            continue;
          }
          zeroYield++;
          if (zeroYield >= 3 && relocate && relocations < maxRelocations) {
            relocations++; zeroYield = 0;
            emit({ type: 'resource_relocate', n: relocations, cause: 'region_depleted', material: target.material });
            // G-bis : si on chasse le diamant, viser un CLUSTER de diamants EXPOSÉS (grotte) pour
            // atterrir à reach courte, pas une case biome au hasard.
            try { await relocate({ diamondCluster: String(target.material || '').includes('diamond') }); } catch (e) { /* best-effort */ }
            skip.clear(); busyUntil.clear();
            if (reload) memory = reload() || memory;
          }
        } else { zeroYield = 0; fullStreak = 0; }
      }
      else {
        mineForFails++;
        if (mineForFails >= 3 && relocate && relocations < maxRelocations) {
          relocations++; mineForFails = 0;
          emit({ type: 'resource_relocate', n: relocations, cause: 'region_mine_fails' });
          try { await relocate(); } catch (e) { /* best-effort */ }
          skip.clear(); busyUntil.clear();
          if (token && token.cancelled) return { ok: true, mined, cancelled: true };
          if (reload) memory = reload() || memory;
        }
        if (idleSince == null) idleSince = clock();
        if (clock() - idleSince > maxIdleMs) { emit({ type: 'resource_starved', mined, idleMs: clock() - idleSince }); return { ok: false, reason: 'starved', mined }; }
        await sleep(waitMs);
        if (token && token.cancelled) return { ok: true, mined, cancelled: true };
      }
      continue;
    }

    // Navigation bornée vers la position exacte. Throw = inatteignable → skip local SANS retirer
    // de la carte + release de la claim (un autre bot — mieux placé/équipé — pourra retenter).
    try { await doGoto(target); }
    catch (e) {
      _stopResidual(bot);
      if (claims) claims.release(key);
      // Skip aussi les voisins de la MÊME veine (≤4 blocs) : ils partagent le même barrage
      // (lave/inaccessible) — sinon on re-paie l'approche ratée pour chaque bloc de la veine.
      for (const o of listOres(memory, wkey)) {
        if (Math.abs(o.x - target.x) <= 4 && Math.abs(o.y - target.y) <= 4 && Math.abs(o.z - target.z) <= 4) {
          skip.add(oreKey(o));
        }
      }
      emit({ type: 'resource_unreachable', x: target.x, y: target.y, z: target.z });
      // Série d'échecs = zone POURRIE (lac/aquifère — vécu live : 3 bots en boucle d'eau 35 min,
      // jamais affamés car il restait toujours « une cible suivante » dans la même zone) →
      // relocalisation FRANCHE vers la région du bot + reset des exclusions locales.
      failStreak++;
      if (failStreak >= failRelocateAt && relocate && relocations < maxRelocations) {
        relocations++;
        failStreak = 0;
        emit({ type: 'resource_relocate', n: relocations, cause: 'fail_streak' });
        try { await relocate(); } catch (e2) { /* best-effort */ }
        skip.clear(); busyUntil.clear();
        if (token && token.cancelled) return { ok: true, mined, cancelled: true };
        if (reload) memory = reload() || memory;
      }
      continue;
    }
    if (token && token.cancelled) return { ok: true, mined, cancelled: true };

    // Le minerai est-il toujours là ? (déjà miné par un joueur/bot, ou jamais existé → carte MAJ)
    // N'importe quel minerai à la position notée est bon à prendre (le cartographe a pu noter la
    // variante stone et le bloc être deepslate — position exacte = vérité).
    const block = bot.blockAt ? bot.blockAt(_pos(target)) : null;
    if (!block || !isOre(block.name)) {
      if (claims) claims.release(key);
      emit({ type: 'ore_gone', world: wkey, x: target.x, y: target.y, z: target.z });
      continue;
    }
    // RÈGLE EAU DURE (Massii, vécu V3Res2) : un ore DANS l'eau ou en caverne inondée (eau dans
    // les 6 voisins) n'est JAMAIS une cible — même un diamant. Skip + toute la veine, comme un
    // barrage (le bot ne plonge plus dans les aquifères pour une cible).
    {
      const WATER = new Set(['water', 'flowing_water', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass']);
      let wet = WATER.has(block.name);
      if (!wet && bot.blockAt) {
        for (const [dx, dy, dz] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]) {
          const nb = bot.blockAt(_pos({ x: target.x + dx, y: target.y + dy, z: target.z + dz }));
          if (nb && WATER.has(nb.name)) { wet = true; break; }
        }
      }
      if (wet) {
        if (claims) claims.release(key);
        for (const o of listOres(memory, wkey)) {
          if (Math.abs(o.x - target.x) <= 4 && Math.abs(o.y - target.y) <= 4 && Math.abs(o.z - target.z) <= 4) {
            skip.add(oreKey(o));
          }
        }
        emit({ type: 'ore_wet', world: wkey, x: target.x, y: target.y, z: target.z });
        continue;
      }
    }

    // Équipe la bonne pioche puis mine. collectBlock gère l'approche fine + le ramassage du drop.
    // Re-équipe + retente UNE fois (dig interrompu par aggro/désync, pattern gather).
    // refresh post-goto : un tunnel d'approche >120 s faisait EXPIRER la claim en route
    // (tryClaim au départ seulement) → un autre bot pouvait viser la même ore.
    if (claims) claims.refresh(key) || claims.tryClaim(key);
    const tool = bestToolFor(bot, block);
    if (tool) { try { await bot.equip(tool, 'hand'); } catch (e) {} }
    let okMine = false;
    try { await collectBounded(block); okMine = true; }
    catch (e) {
      try {
        const tool2 = bestToolFor(bot, block);
        if (tool2) { try { await bot.equip(tool2, 'hand'); } catch (e2) {} }
        await collectBounded(block); okMine = true;
      } catch (e2) { _stopResidual(bot); }
    }
    if (claims) claims.release(key);                   // minée OU ratée : claim libérée
    if (token && token.cancelled) return { ok: true, mined, cancelled: true };

    if (okMine) {
      mined++;
      failStreak = 0;
      emit({ type: 'ore_mined', world: wkey, material: target.material, x: target.x, y: target.y, z: target.z });
      emitProgress();
    } else {
      // échec de minage (≠ absent) : on ne retire PAS de la carte — le bloc est encore là.
      emit({ type: 'resource_failed', x: target.x, y: target.y, z: target.z });
    }
  }

  emit({ type: 'resource_done', mined });
  return { ok: true, mined };
}

module.exports = { runResource };
