# MC-Agent — Mission autonome T1 → T4 (sans /give)

> Tu es Claude Code lancé en autonomie (Opus 4.8) via `tools/mc-t1t4-overnight.sh`, avec
> **relance auto** à chaque coupure de tokens (limite 5h / fin de tour / crash). Chaque relance
> te redonne CE fichier — reprends la mission là où elle en est (voir **§RESUME**).
> `--dangerously-skip-permissions` est actif : lance tes commandes Bash toi-même, ne délègue pas.

---

## 🎯 Mission

Amener la flotte de bots MC-Agent (compte non-triche, **mode sans-give**) de zéro jusqu'au
**palier 4**, entièrement en autonomie, en **corrigeant le code au fil de l'eau** quand un bot bloque.

**Definition of Done — les 4 paliers, PORTÉS (pas juste en poche) :**
- **T1** — armure **FER** complète portée (`iron_armor` / prédicat `IA_WORN`)
- **T2** — armure **DIAMANT** complète portée (`diamond_armor` / `DA_WORN`)
- **T3** — atteindre le **NETHER** (construire + franchir un portail obsidienne)
- **T4** — armure **NETHERITE** complète portée

⚠️ **T1 et T2 ont des chaînes qui EXISTENT** (`goals.js` : `IRON_ARMOR_CHAIN`, `DIAMOND_ARMOR_CHAIN`).
**T3 (portail nether) et T4 (netherite) N'ONT PAS de skills écrits** — c'est le gros du chantier :
il faut les BÂTIR en TDD (creuser obsidienne à la lave+eau OU miner à la pioche diamant, allumer
le portail, franchir ; puis nether → ancient_debris Y≤15 → netherite_scrap → smelt → netherite_ingot
→ smithing template + upgrade armure diamant→netherite). Chaîne `NETHERITE_ARMOR_CHAIN` +
`objective: 'nether'`/`'netherite_armor'` à créer, câblés dans `chainFor` + backend `RESPAWN_OBJECTIVES`.

**But réaliste par nuit** : verrouiller T1+T2 solides sur les 3 bots, puis construire et valider T3
(le portail), puis attaquer T4. Ne PAS survendre : si T4 n'est pas bouclé, un T3 franchi + les
skills T4 écrits/testés est déjà un livrable énorme.

---

## 🗺️ État actuel (posé par la session interactive, nuit 15→16 juillet)

- **Monde `world_ax2`** (neuf, SEC, hard, keepInventory=true). Spawn déplacé sur sol sec à
  (-435,83,-294) après avoir découvert que le spawn d'origine était une mare (piège).
- **Groupe `943e2c`** : `NethBot1`/`NethBot2`/`NethBot3` (rôle worker, objectif armure, no_give) +
  `MapBot1` (mapper — carte partagée + heartbeat présence). MapBot2 en réserve (ne PAS lancer 2
  mappers : freeze serveur, cf. pièges).
- **Les 3 bots ressource tournent sur l'objectif `diamond_armor`** (T2). 2 d'entre eux ont reçu
  une armure fer par accident (via `/kit`, maintenant bloqué) → ils l'utilisent comme AVANCE et
  minent déjà les diamants à y-54 ; le 3e (nu) gagne le fer légitimement d'abord. C'est OK — la
  chaîne `diamond_armor` inclut tout le fer en préfixe.
- **Serveur MC** : conteneur docker `omen-minecraft-trusted-test` sur l'Omen. Anti-xray actif
  (niché sous `anticheat:` du paper config, hérité au boot). Les bots sont OP (commandes joueur
  Essentials) ; `nogive.js` est la vraie frontière anti-triche.
- **Tout le code de la nuit est déployé sur `main`** (HEAD ~`bc6e248`+). Node 926 tests verts.
- **Power schedule de l'Omen : DÉSACTIVÉ** (`enabled:false`) pour que le run tourne la nuit. **À
  RÉACTIVER en clôture** (sinon l'Omen ne s'éteint plus la nuit → conso).

---

## 🔧 Comment travailler

### Accès Omen / serveur
- SSH : `ssh omen` (Tailscale, IP stable — `Host omen` dans `~/.ssh/config`). Le pkill peut
  couper ta session ssh (exit 255) → sépare `pkill` et la relance en DEUX connexions ssh.
- **JWT admin côté serveur** (ne jamais stocker, minter à la volée) :
  ```bash
  ssh omen 'cd ~/"Projet serveur" && ./venv/bin/python -c "from backend.auth.utils import create_access_token; print(create_access_token({\"sub\":\"Massii08\"}))"'
  ```
  puis `curl -H "Authorization: Bearer <jwt>" http://127.0.0.1:8000/api/mc-agent/...`
- **Poller d'état** (déjà installé) : `ssh omen 'cd ~/"Projet serveur" && ./venv/bin/python /tmp/mc_poll.py'`
  → une ligne `maxProgress=… smeltOK=… woodFound=… waterResc=… stall=… desync=…`. Recrée-le s'il
  a disparu (voir son contenu dans l'historique / le report).
- API bot : `/api/mc-agent/active`, `/events/{sid}`, `/run` (POST `{server_id,bot_id,autonomous,objective,no_give,humanize}`),
  `/stop/{sid}`, `/servers/943e2c/mappers/start` (POST `{count:1}`).

### Boucle de correction (à répéter)
1. **Observe** : poller + `/events/{sid}` (compte les types d'events, regarde `last8`). Positions
   réelles via RCON `data get entity <bot> Pos`.
2. **Diagnostique la cause RACINE** (skill `systematic-debugging`) — ne pas patcher un symptôme.
3. **Corrige en TDD** (skill `test-driven-development`) : test rouge → code → vert. Décisions PURES
   dans des helpers testables ; le câblage `index.js` reste mince.
4. **Suites** : `cd mc-agent && node --test` (viser 0 fail) + `./venv/bin/python -m pytest backend/ -q` si backend touché.
5. **Déploie** : `git add … && git commit && git push origin HEAD:main` (+ `HEAD:feat/mc-agent-water-wall`).
   L'auto-deploy de l'Omen pull en ~1 min. **⚠️ Le deploy ne met PAS à jour les bots en cours** (subprocess
   Node détachés, chargent index.js au lancement) → après CHAQUE fix : `pkill -f "node.*mc-agent/index.js"`
   (2e connexion ssh) PUIS relance la flotte.
6. **Vérifie** l'effet en prod (events du bot recyclé).
7. **Journalise** : append au report `.mc-t1t4-overnight-report.md` (crée-le au 1er cycle).

### Relance de la flotte (après un fix)
```bash
# 1 mapper + 3 bots ressource sur l'objectif courant (diamond_armor tant que T2 pas bouclé)
curl -X POST -H "$H" -H 'Content-Type: application/json' -d '{"count":1}' .../servers/943e2c/mappers/start
for bid in 493453 1fae21 8ac2b7; do curl -X POST -H "$H" -H 'Content-Type: application/json' \
  -d '{"server_id":"943e2c","bot_id":"'$bid'","autonomous":true,"objective":"diamond_armor","no_give":true,"humanize":true}' .../run; sleep 6; done
```
(bot_ids : NethBot1=493453, NethBot2=1fae21, NethBot3=8ac2b7. Passe `objective` à `netherite_armor`
quand tu auras écrit la chaîne T4.)

---

## ⚠️ Pièges DÉJÀ appris cette nuit (ne les redécouvre pas)

1. **`/kit` = give déguisé** → bloqué dans `nogive.js`. Le kit Essentials 'mapper' donne l'armure
   fer complète ; ne le débloque pas pour les bots ressource.
2. **RCON `data get entity <bot>` / manip d'inventaire = NON FIABLE** (stale, offline-limité). La
   vérité = la vue du bot (events `autonomous_done_ctx`, `_wornArmor()`). Ne conclus pas « il a X »
   sur un `data get` seul.
3. **L'EAU neutralise chaque mécanisme différemment** — déjà fermé pour : la marche (`liquidCost`
   45), les waypoints d'explore (skip si mouillé), l'abri, le home 'safe' (jamais posé dans l'eau).
   Si un NOUVEAU symptôme d'eau apparaît, cherche QUEL mécanisme précis l'eau casse cette fois.
4. **Pas d'abri nocturne SOUS TERRE** (`shouldShelter({underground})` → false). Un mineur ne se
   terre jamais.
5. **Piégeage physique (îlot/bateau raté) ≠ desync** mais même signature → le watchdog fait
   évasion (warp) AVANT l'exit(3). Un bot vraiment coincé : `spreadplayers` inland en dépannage.
6. **Repositionner un bot bloqué** : `spreadplayers <x> <z> 8 25 false <@a-selector>` (sélecteur,
   PAS une liste de noms) + `execute at <bot> run spawnpoint <bot>` pour ancrer le respawn au sec.
   JAMAIS sonder un spawn colonne-par-colonne (chunks non générés « mentent »).
7. **Frame d'une vidéo/photo user** : `qlmanage -t -s 1280 -o <dir> <fichier>` ; HEIC → `sips -s format jpeg`.
8. **`autonomous_done` précoce = TOUJOURS un raccourci d'inventaire** (kit/armure héritée), pas une
   prouesse → dumpé par l'event `autonomous_done_ctx` (worn/inv/y).
9. **Ne JAMAIS pusher pendant un grind sans recycler après** : restart uvicorn de l'auto-deploy tue
   les process bots ET le dict self-healing.

Les pièges historiques MC-Agent sont dans `CLAUDE.md` (#41-47) — lis-les si tu touches au minage
profond, à l'anti-xray, ou aux warps.

---

## 🔁 §RESUME (à chaque relance auto)

1. Lis CE fichier + `.mc-t1t4-overnight-report.md` (dernier état).
2. `git -C "/Users/massimiliano/omenserver Project/Projet serveur" fetch && git log --oneline -3 origin/main`
   pour voir où en est le code déployé.
3. Poller + `/active` : où en sont les 3 bots ? (maxProgress, done, idle, morts ?)
4. Reprends la boucle de correction sur le prochain blocage réel. Priorité : (a) débloquer un bot
   idle/mort ; (b) fiabiliser T1/T2 ; (c) construire T3 puis T4.
5. Si tout roule et rien à corriger : observe 10-20 min (poll), puis boucle.

---

## 🏁 §CLÔTURE (quand la mission est finie OU la deadline atteinte)

1. **Bilan honnête** : quels paliers réellement PORTÉS par quels bots (via events/NBT playerdata,
   pas `data get`). Ne survends pas.
2. **RÉACTIVE le power schedule de l'Omen** :
   `curl -X PUT -H "$H" -H 'Content-Type: application/json' -d '{"enabled":true}' http://127.0.0.1:8000/api/power/schedule`
   puis VÉRIFIE par `GET` que `enabled:true`. (C'était OFF pour le run — critique de le remettre.)
3. Laisse la flotte tourner OU stoppe-la proprement selon l'état (si stable et productive, laisse ;
   si elle churne, stoppe via `/stop`).
4. Écris le **rapport final** dans `.mc-t1t4-overnight-report.md` (paliers, fixes, pièges neufs,
   pistes restantes T3/T4).
5. MAJ **mémoire** (`~/.claude/projects/.../memory/`) + **Daily note Obsidian** du jour.
6. Termine.

---

## Décisions de Massii (cadre)
- **Sans-give strict** : le bot gagne tout à la sueur (nogive.js = frontière). Pas de raccourci.
- **T1→T4 est le but**, dans l'ordre, portés. L'armure fer héritée par accident sert d'avance,
  pas la peine de la re-gagner — la priorité est d'AVANCER vers T4.
- **Voyager loin pour le bois** quand le spawn est déboisé (pas grappiller les miettes).
- **Corrige, ne contemple pas** : chaque bot idle/bloqué > 10 min = un bug à root-causer + fixer.
