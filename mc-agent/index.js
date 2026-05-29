'use strict';
// Point d'entrée de l'agent Minecraft. Lancé par le backend Python en subprocess.
const mineflayer = require('mineflayer');
const { pathfinder, Movements } = require('mineflayer-pathfinder');
const Anthropic = require('@anthropic-ai/sdk');
const { emit, onCommand } = require('./io');
const { snapshot } = require('./state');
const { think, RateLimiter } = require('./brain');
const { say } = require('./skills/say');
const { follow } = require('./skills/follow');
const { goto } = require('./skills/goto');

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { o[argv[i].slice(2)] = argv[i + 1]; i++; }
  }
  return o;
}

const args = parseArgs(process.argv.slice(2));
const model = args.model || 'claude-haiku-4-5-20251001';
const limiter = new RateLimiter(Number(args.maxCalls || 20), 60000);
const client = new Anthropic(); // lit ANTHROPIC_API_KEY depuis l'environnement

const bot = mineflayer.createBot({
  host: args.host,
  port: Number(args.port || 25565),
  username: args.user || 'TrainBot',
  auth: 'offline',
});
bot.loadPlugin(pathfinder);

bot.once('spawn', () => {
  bot.pathfinder.setMovements(new Movements(bot));
  emit({ type: 'status', state: 'spawned', username: bot.username });
});

async function runAction(decision) {
  if (decision.action === 'follow') {
    follow(bot, decision.args);
    emit({ type: 'action', skill: 'follow', args: decision.args });
  } else if (decision.action === 'goto') {
    await goto(bot, decision.args);
    emit({ type: 'action', skill: 'goto', args: decision.args });
  }
}

bot.on('chat', async (username, message) => {
  if (username === bot.username) return;
  emit({ type: 'chat', from: username, message });
  try {
    const decision = await think(client, { state: snapshot(bot), message, model, limiter });
    if (!decision) { emit({ type: 'info', message: 'rate-limited' }); return; }
    if (decision.reply) { await say(bot, decision.reply); emit({ type: 'say', message: decision.reply }); }
    await runAction(decision);
  } catch (e) {
    emit({ type: 'error', message: String((e && e.message) || e) });
  }
});

bot.on('death', () => emit({ type: 'status', state: 'dead' }));
bot.on('kicked', (reason) => emit({ type: 'error', message: 'kicked: ' + reason }));
bot.on('error', (e) => emit({ type: 'error', message: String((e && e.message) || e) }));
bot.on('end', () => { emit({ type: 'status', state: 'disconnected' }); process.exit(0); });

// Commandes envoyées par le backend (stdin)
onCommand((cmd) => {
  if (cmd.type === 'say') say(bot, cmd.message);
  else if (cmd.type === 'quit') bot.quit();
});
