# Prompt — Lancer le run MC-Agent `world_ax5` (monde neuf, anti-xray, mappeurs puis ressources)

> À coller tel quel dans une nouvelle discussion Claude Code, depuis
> `/Users/massimiliano/omenserver Project/Projet serveur`.

---

Lance un nouveau run du MC-Agent sur un **monde neuf avec anti-xray**, en reprenant le dispositif
habituel : **les cartographes d'abord** pour cartographier, **les bots ressource ensuite**.

## Ce que tu dois savoir avant de commencer

**Ce run valide 14 correctifs écrits les 25-26 juillet dont AUCUN n'a jamais tourné en conditions
réelles** (l'Omen dormait pendant leur écriture). Le rapport d'analyse du run précédent est dans
`.mc-ax4-report.md` — lis-le, il contient les causes racines et les chiffres de référence. Les
pièges #48 à #54 du `CLAUDE.md` documentent tout le reste.

**Le run précédent en une phrase** : le palier T1 (armure de fer) a été atteint pour la première
fois (3 pièces portées + bouclier), puis a plafonné — non pas à cause du combat ou de la fonte,
mais parce que la récolte de bois échouait à **93 %** (les bots retournaient 2036 fois sur la même
cellule qu'ils avaient rasée) et que l'armure cassait d'usure sans être remplacée.

### Accès

- **SSH** : `ssh -i ~/.ssh/omen_mc_agent massii08@192.168.4.64`
  ⚠️ IP **LAN** — elle peut changer (DHCP). Tailscale (`100.108.50.70`) était instable le 25/07
  (l'Omen est passé en WiFi, `eno1` down, ~83 % de perte). Si Tailscale te dit « Connected » mais
  que rien ne passe, lis le piège dans la page vault *Accès distant Tailscale* : `… status --json`
  donne l'IP LAN réelle dans `CurAddr`. **Un ping raté ne prouve pas que la machine est morte** —
  SSH passe malgré 80 % de perte, pas ICMP.
- **Scripts déjà en place sur l'Omen** : `~/mca-fleet.sh [stop|start|recycle]` (arrête/relance la
  flotte complète) et `~/mca-status.sh <sid…>` (état + derniers events). ⚠️ `mca-fleet.sh` lance
  les ouvriers avec `"regroup": true` — garde-le.
- **JWT** : à frapper côté serveur, jamais stocké :
  ```
  TOKEN=$(venv/bin/python -c 'from backend.auth.utils import create_access_token; print(create_access_token({"sub": "Massii08"}))')
  ```
- **API** : `http://127.0.0.1:8000/api/mc-agent/…` (`/run`, `/active`, `/stop/{sid}`,
  `/servers/{gid}/mappers/start`).

### Le serveur MC

- Conteneur `omen-minecraft-trusted-test`, Paper **1.21.4**, port hôte **25566**, `online-mode=false`.
- Volume Docker : `1f8107c15289df7da2a008c2a826720ea2662a442269ed36d7e58a8407ca5385`
  (le lire/écrire via un conteneur jetable :
  `docker run --rm -v <vol>:/data --entrypoint sh itzg/minecraft-server:latest -c '…'`).
- ⚠️ `sudo` n'est PAS NOPASSWD pour `apt`/l'écriture de fichiers (seuls systemctl/reboot/shutdown/
  rtcwake le sont) → passe par Docker, pas par sudo.
- **Groupe MC-Agent `943e2c`** (« neth-run »), host `127.0.0.1:25566` :
  ouvriers `NethBot1`=493453, `NethBot2`=1fae21, `NethBot3`=8ac2b7 ; cartographes `MapBot1`, `MapBot2`.

## Procédure

### 1. Monde neuf `world_ax5`

Dans `server.properties` du volume : `level-name=world_ax5`, `level-seed=` (vide), garder
`difficulty=hard`, `allow-flight=true` (obligatoire, sinon kick « Flying is not enabled »),
`online-mode=false`, `spawn-protection=0`. Puis démarrer le conteneur.

**L'anti-xray est déjà configuré** dans `config/paper-world-defaults.yml`
(`anticheat: anti-xray: enabled:true, engine-mode:1`) et un monde neuf en hérite **au boot**.
⚠️ Piège historique : Paper ne lit cette config qu'AU DÉMARRAGE — si tu la modifies, il faut
redémarrer le conteneur, sinon elle n'est jamais chargée.

Après génération : `gamerule keepInventory true` et `gamerule doDaylightCycle true`.

**Choisis le spawn avec soin** — c'est ce qui a plombé le run précédent. Sonde le terrain via RCON
(`docker exec … rcon-cli`) :
- `locate biome minecraft:forest` / `taiga` / `ocean` — on veut une **forêt dense proche** et un
  **océan loin** (≥ 800 blocs ; le run ax4 avait l'océan à 1468, c'était excellent).
- Compter les arbres : `fill <boîte ≤31³> oak_log replace oak_log` = **compteur non destructif**.
  ⚠️ Deux pièges : la boîte Y doit **couvrir le sol** (une boîte trop haute ne voit que la canopée
  et rend « 0 bûche » alors qu'il y a 960 feuilles), et `fill` plafonne à 32768 blocs.
  **Valide toujours ta méthode avec un bloc-témoin** (`grass_block`) avant de conclure à une absence.
- `setworldspawn <x> <y> <z>` en **lisière de forêt dense** : le bois est le goulot n°1, et
  l'auto-ancrage du bot exige une zone boisée.
- ⚠️ Essentials intercepte `/time` → utiliser `minecraft:time set day`.

### 2. Purger la carte

`data/mc_agent_world_memory/943e2c.json` porte la carte du monde PRÉCÉDENT (coordonnées périmées).
**Archive-la** (`mv …json …json.bak-ax4-<date>`) avant de lancer quoi que ce soit.
Vider aussi `data/mc_agent_runs/positions-943e2c.json`.

⚠️ La clé de monde est la **dimension** (`overworld`), pas le nom du monde : sans purge, l'ancienne
carte pollue le monde neuf. Ne mets PAS de `world_label` au lancement (les cartographes n'en
passent pas — un label sur les ouvriers seuls scinderait la carte en deux).

### 3. Cartographes d'abord

`POST /servers/943e2c/mappers/start {"count": 2}`. Laisse-les prendre de l'avance (~10 min), le
temps qu'ils peuplent biomes et minerais exposés.

**Vérifie l'anti-xray sur la carte fraîche** — la métrique honnête est le pourcentage de minerais
**cachés ET SECS sous Y64** (les « mouillés » sont envoyés légitimement par Paper) :
`0-3 % = anti-xray effectif` · `~20 % = obfuscation morte`.

### 4. Ouvriers ensuite

Les 3 ouvriers en `objective: "iron_armor"`, `autonomous: true`, `no_give: true`, `humanize: true`,
`regroup: true` — c'est exactement ce que fait `~/mca-fleet.sh start`.

### 5. Veille

Le planning d'extinction est **actif** (01:00 → 06:00). Pour un run de nuit, demande à Massii s'il
veut le désactiver (`PUT /api/power/schedule {"enabled": false}`).

## Ce qu'il faut MESURER (c'est le but du run)

Les 14 correctifs à valider, avec l'event qui le prouve :

| Correctif | Signal à guetter |
|---|---|
| Cellules épuisées persistantes | `directed_exhausted` puis **plus de retour** sur la même cellule |
| Anti-boucle bateau | `mapper_boat_failed` doit s'effondrer (115 138 au run précédent !) |
| Tunnel éclairé + survie proactive | `torch_placed`, et pas de mort en série pendant `iron_deep` |
| Charbon sous terre | but `t1_coal` atteint, `armor_fuel` qui ne renvoie plus en surface |
| Épée / hache | buts `t1_sword`, `t1_axe` |
| Bouclier | but `shield`, puis `take_cover` moins fréquent |
| Usure | `gear_worn_out` (l'armure doit être REFORGÉE, pas perdue) |
| Bûches → planches | `logs_to_planks` |
| Arrêt sur compte de fer | `branchMine` qui rend la main avant les 15 min |
| Équipe | `regroup_tpa`, `team_assist`, `team_gift`, `team_split` |
| Abri « se murer » | `walled_in` |

**Chiffres de référence du run précédent** (6 h 36) : **235 morts** (squelette 127, zombie 65,
creeper 17) ; `logs` 2001 tentatives / 1853 échecs ; **4 fontes** ; 134 sessions.

**Mon principal doute** : la liste d'avant-descente a grossi (24 planches, 8 blocs posables,
3 pioches, épée, hache). Tout ça est du **temps en surface**, et la surface la nuit est mortelle.
**Surveille le délai avant `descend_y16`** — s'il explose, il faudra rendre une partie de cette
liste opportuniste au lieu de bloquante.

## Pièges de méthode — ils m'ont coûté cher

1. **Ne fais JAMAIS confiance à RCON pour lire un inventaire.** `data get entity <joueur> Inventory`
   est **tronqué** sur Paper ; la requête ciblée `Inventory[{id:"…"}]` rend **vide si le bot est
   déconnecté** (une session en respawn ⇒ « tout a disparu ») ; `clear <joueur> <item> 0` ne renvoie
   **rien** ; le NBT playerdata mélange l'inventaire et le **livre de recettes**. La seule source
   fiable est ce que le bot publie lui-même (`kit_equipped.worn`, `teamStatus`, events de craft).
   J'ai crié trois fois à la perte d'items, je me suis trompé deux fois sur trois.
2. **Mesure avant de coder.** Deux « bugs évidents » se sont révélés faux (4065 réflexes de noyade =
   cumul multi-sessions normal des cartographes ; « plus aucun arbre » = boîte de mesure mal placée).
3. **Les deploys ne tuent plus la flotte** — le drop-in `KillMode=process` est posé et prouvé
   (`systemctl show omenserver -p KillMode`). Tu peux pusher pendant un run. **Mais un bot déjà
   lancé garde son ancien code** : recycle après chaque déploiement que tu veux tester.
4. **Recycler coûte cher.** Chaque recyclage interrompt une progression. Groupe tes correctifs et
   laisse des fenêtres franches d'au moins 40 min avant de conclure quoi que ce soit.
5. **Les erreurs de câblage dans `index.js` ne sont PAS couvertes par les tests.** Trois bugs de ce
   type en une nuit (signature de fonction, variable hors portée, `Vec3` inexistant), tous avalés
   par un `try`. Après chaque câblage : `node -e "new Function(require('fs').readFileSync('index.js','utf8'))"`
   au minimum, et un test à blanc de la fonction si elle est critique.

## Ce qui reste ouvert (à ne PAS coder sans données)

- **Replantage de pousses** : volontairement écarté tant qu'il reste des forêts vierges connues.
- **`allowDeeper`** : autorise le branch-mine du fer jusqu'à y=-59, en pleine bande de lave. Ça a
  été ajouté pour casser un blocage réel — à trancher avec des mesures, pas au feeling.
- **Les lits ne fonctionnent pas sur ce serveur** (Massii) : le point de réapparition est le spawn
  du monde. C'est le regroupement `/tpa` qui absorbe le trajet retour.

## Convention de travail

TDD, français dans le code et les commits, `git push origin HEAD:main` (l'auto-deploy tire toutes
les minutes). Tests : `cd mc-agent && npm test` (1103) et `python -m pytest backend/bots/tests -q`
(656). Rapport de fin dans `.mc-ax5-report.md`, et mise à jour du vault Obsidian + Mission Control.
