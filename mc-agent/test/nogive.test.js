'use strict';
// Mode SANS-GIVE (run nether 2026-07-13) : AUCUNE commande de triche ne doit sortir du bot —
// le garde-fou dur est un filtre sur bot.chat (défense en profondeur, en plus des guards
// provisionStartKit/ensureFood). isForbiddenCheat est PUR (testable sans serveur).
const { test } = require('node:test');
const assert = require('node:assert');
const { isForbiddenCheat } = require('../nogive');

test('nogive: /give bloqué sous toutes ses formes', () => {
  assert.ok(isForbiddenCheat('/give NethBot1 diamond_pickaxe 1'));
  assert.ok(isForbiddenCheat('/give NethBot1 cooked_beef 32'));
  assert.ok(isForbiddenCheat('/GIVE bob dirt'));           // insensible à la casse
  assert.ok(isForbiddenCheat('  /give bob dirt'));         // espaces de tête
});

test('nogive: cheats équipement/soin/déplacement bloqués', () => {
  for (const cmd of [
    '/effect give @s regeneration 60 1',
    '/enchant @s sharpness',
    '/xp add @s 100 levels',
    '/experience add @s 100',
    '/tp @s 10 64 10',
    '/teleport @s 10 64 10',
    '/spreadplayers 0 0 0 48 false NethBot1',
    '/gamemode creative',
    '/summon iron_golem',
    '/kill @e[type=zombie]',
    '/setblock 0 64 0 obsidian',
    '/fill 0 64 0 4 68 4 stone',
  ]) assert.ok(isForbiddenCheat(cmd), cmd + ' devrait être bloqué');
});

test('nogive: commandes serveur légitimes + chat normal passent', () => {
  for (const msg of [
    '/tpa Massii', '/tpaccept', '/tpdeny',          // ⚠️ préfixe "/tp" mais LÉGITIMES (Essentials)
    '/home', '/sethome', '/spawn', '/back',
    '/msg Bob salut', '/r ok', '/afk',
    '/login secret', '/register a b',
    '/spawnpoint',                                   // ancre de respawn : pas d'item, pas de soin
    '/locate structure minecraft:fortress',          // lecture seule
    'bonjour tout le monde',                         // chat pur
    'je vais /give rien du tout',                    // "/give" pas en tête = chat
  ]) assert.ok(!isForbiddenCheat(msg), msg + ' devrait passer');
});
