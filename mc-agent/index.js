'use strict';
// Point d'entrée de l'agent Minecraft. Lancé par le backend Python en subprocess.
const mineflayer = require('mineflayer');
const { pathfinder, Movements } = require('mineflayer-pathfinder');
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
const { bestWeapon } = require('./tools');
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
const { MVP_CHAIN } = require('./goals');
const { loadWorld, saveWorld, setObjective, clearObjective } = require('./worldModel');
const { _nearestTable } = require('./skills/craft'); // craftItem déjà importé plus haut
const { placeBlockNear } = require('./skills/placeBlockNear');
const { classifyAuthPrompt, genPassword } = require('./auth');

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

function ctxExtra() { return { hasTable: !!_nearestTable(bot) }; }

// Dispatch d'un but de la chaîne vers le skill réel (0 token).
async function runGoalSkill(goal) {
  if (goal.skill === 'gatherLog') {
    const logName = Object.keys(bot.registry.blocksByName).find((n) => n.endsWith('_log')) || 'oak_log';
    return gather(bot, { name: logName, count: goal.args.count }, taskToken);
  }
  if (goal.skill === 'gather') return gather(bot, goal.args, taskToken);
  if (goal.skill === 'craftPlanks') {
    const log = bot.inventory.items().find((i) => i.name.endsWith('_log'));
    if (!log) return { ok: false, reason: 'not_found' };
    return craftItem(bot, { name: log.name.replace('_log', '_planks'), count: goal.args.count });
  }
  if (goal.skill === 'craft') return craftItem(bot, goal.args);
  if (goal.skill === 'placeTable') return placeBlockNear(bot, 'crafting_table');
  return { ok: false, reason: 'unknown_skill' };
}

// Lance (ou relance) la boucle autonome ; le planner re-dérive depuis l'état courant.
async function startAutonomous(sender) {
  setObjective(world, { type: 'stone_pickaxe', status: 'in_progress' });
  saveWorld(worldFile, world);
  taskToken = taskCtl.begin('autonomous', stopMotion);
  emit({ type: 'autonomous_start', objective: 'stone_pickaxe' });
  const res = await runPlanner(bot, {
    chain: MVP_CHAIN, runSkill: runGoalSkill, ctxExtra,
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
  emit({ type: 'status', state: 'spawned', username: bot.username, profile: profile ? profile.id : null });
  if (!bootDone) {
    // une seule fois par connexion : sinon 'spawn' (respawn) ré-ajoute des listeners (fuite, MaxListeners)
    bot.pathfinder.setMovements(new Movements(bot));
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

bot.on('death', () => {
  emit({ type: 'status', state: 'dead' });
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
});
