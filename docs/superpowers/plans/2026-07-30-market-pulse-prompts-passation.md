# Market Pulse — les deux prompts à coller

> Écrit le 2026-07-30, à la fin de la session qui a livré le moteur de la phase D.
> État à ce moment : **292 tests moteur + 939 backend**, 25 commits, `HEAD = origin/main`.
> Copie le bloc 1 dans une session neuve. Le bloc 2 se colle **après**, dans une session séparée.

---

## Bloc 1 — Finir la phase D

```
Lis dans l'ordre :
  docs/superpowers/specs/2026-07-29-market-pulse-phase-d-design.md
  docs/superpowers/plans/2026-07-29-market-pulse-phase-d.md
  docs/superpowers/specs/2026-07-29-market-pulse-sources-locales.md
Puis termine la phase D de Market Pulse.

Travaille dans le worktree :
  /Users/massimiliano/omenserver Project/Projet serveur/.claude/worktrees/market-opening-analysis-bot-38483c
branche claude/market-opening-analysis-bot-38483c, actuellement = origin/main.
Python : "/Users/massimiliano/omenserver Project/Projet serveur/venv/bin/python" (jamais python3 nu).

── CE QUI EST DÉJÀ FAIT, NE PAS REFAIRE ──
Moteur market-pulse/ COMPLET et vérifié en réel (292 tests) : exchanges (10 places,
5 ouvertures), social (Reddit/Bluesky/X), events (tri « qui a fait quoi »),
discover + resolve (nouveaux titres, règle anti-homonyme), briefing, analyst
(synthèse italienne par le CLI Claude), vault (note Obsidian), prefs (config JSON).
Backend phase B : market_router.py (/run /status /active /stop /snapshot /download
/report /schedule) + market_schedule.py (rattrapage matinal). 939 tests backend.
Frontend : market_module.js + 168 clés i18n (vue phase B : horloge, gaps, rapport).

Commande qui marche aujourd'hui :
  cd market-pulse && ../venv/bin/python main.py --briefings --prefs <fichier> --vault <racine>

── CE QU'IL RESTE (2 tâches) ──
1. BACKEND — brancher la phase D dans le router :
   - GET/POST /api/bots/market/prefs → lire/écrire data/market_pulse/prefs.json
     via pulse.prefs (load/save/validate). Lecture admin+money, écriture admin.
   - GET /api/bots/market/briefings → le dernier briefings.json du run le plus récent.
   - market_schedule.register_exchange_jobs(scheduler, run_fn, prefs) : UN job par
     GROUPE d'ouverture (pulse.exchanges.opening_groups → 5 groupes, pas 10),
     à `opens_at − 15 min`, timezone= EXPLICITE, misfire_grace_time + coalesce.
     Rattrapage PAR GROUPE : should_catch_up existe déjà, il faut une date de
     dernier run par groupe dans meta.json.
   - /run doit accepter --briefings.
2. FRONTEND — un bloc par bourse dans market_module.js, TOUT sous le nom de la
   bourse : état → indice → comparaison → agenda → notizie (faits d'abord) →
   titoli seguiti → nuovi titoli → sintesi. Plus un sélecteur de bourses et de
   titres (cases à cocher) qui écrit dans /prefs. Clés i18n market.* à créer en
   FR/EN/IT. Vanilla JS, esc() sur TOUTE donnée, Auth.apiCall jamais fetch().

── RÈGLES DU DÉPÔT, NON NÉGOCIABLES ──
- TDD : le test qui échoue AVANT le code. Tests hors ligne, tout injecté.
- Python 3.9 (les tests tournent dessus) : pas de match, pas de X | Y.
- ZÉRO nouvelle dépendance Python.
- LIGNE ROUGE : aucune recommandation, aucun objectif de cours, aucune prévision
  de direction. Un fait daté OUI, un conseil NON. Des tests le verrouillent déjà
  (test_report FORBIDDEN, test_briefing sérialise et cherche les mots interdits,
  analyst.check_synthesis jette la synthèse). Ne les affaiblis pas.
- Cache-bust : bumper le ?v= de CHAQUE JS modifié dans index.html + CACHE_NAME
  de sw.js, AU-DESSUS des valeurs d'origin/main au moment du push.
- Déploiement = push sur origin/main (cron 1 min sur l'Omen).
- ⚠️ NE JAMAIS sonder une URL versionnée AVANT que le déploiement soit arrivé :
  Cloudflare met le 404 en cache contre cette URL exacte et le déploiement
  réussi reste invisible. Vécu (commit 5c8102f).
- Vérifier l'UI toi-même via Chrome MCP après déploiement. Ne jamais demander à
  Massii de tester.

── LES PIÈGES QUI ONT COÛTÉ DU TEMPS, DÉJÀ PAYÉS ──
- Un 429 que tu provoques toi-même ne prouve rien : espace ≥ 60 s avant de
  conclure qu'une source est morte.
- « HTTP 200 » ne prouve pas qu'un flux est vivant : lis la DATE du premier item
  (un flux MarketWatch rendait 200 avec des titres de 13 mois).
- Avant de publier une métrique dérivée d'un champ, mesure que le champ VARIE
  (^FTSE : 94,8 % de gaps nuls, on affichait « gap 0,00 % » chaque matin).
- `claude -p` lancé depuis le dépôt HÉRITE du CLAUDE.md et du contexte : il faut
  l'exécuter depuis un dossier temporaire vide (déjà fait dans analyst._claude).
- Un test qui INJECTE une dépendance ne vérifie pas qu'on la BRANCHE : l'option
  « scoperte » ne produisait rien parce que main.py appelait discover() sans
  résolveur, et 281 tests verts ne l'ont pas vu. Lance TOUJOURS la commande réelle.

── FIN ──
Quand c'est fini : run réel complet, push, vérification en prod via Chrome MCP,
puis mets à jour CLAUDE.md (ligne d'historique + tout nouveau piège) et
~/mission-control/omen.seed.json (tâche fin-mp-phased → done, bump rev,
`node build.js omen.seed.json > /tmp/b.html` puis remplacer, `node tests/smoke.js`).
```

---

## Bloc 2 — L'audit (session séparée, après le bloc 1)

```
Audit de Market Pulse — cherche ce qui manque et ce qui est cassé. NE CODE RIEN
avant d'avoir rendu tes conclusions.

Worktree : /Users/massimiliano/omenserver Project/Projet serveur/.claude/worktrees/market-opening-analysis-bot-38483c
Python : "/Users/massimiliano/omenserver Project/Projet serveur/venv/bin/python"
Contexte : docs/superpowers/specs/2026-07-29-market-pulse-phase-d-design.md

1. LANCE TOUT, ne te contente pas de lire.
   cd market-pulse && <venv>/bin/python -m pytest tests -q
   <venv>/bin/python -m pytest backend -q
   cd market-pulse && <venv>/bin/python main.py --briefings --out /tmp/audit \
     --prefs /tmp/audit-prefs.json --vault /tmp/audit-vault
   Puis LIS les notes produites dans /tmp/audit-vault et les briefings.json.
   Le défaut le plus grave de ce projet a toujours été une section VIDE ou un
   chiffre FAUX qui a l'air normal — ça ne se voit qu'en regardant la sortie.

2. CHERCHE LES BRANCHES MORTES. C'est la classe de bug qui revient sans cesse
   ici : le code s'exécute, les tests passent, et la fonctionnalité ne fait rien.
   - une dépendance injectable qu'on oublie de brancher au vrai appel
   - un champ de config qui traverse plusieurs couches et se fait stripper
   - un try/except qui avale une erreur vitale
   - un test dont l'assertion est toujours vraie
   Méthode qui marche : ne lis pas le code, lis le FICHIER QUE LE CODE PRODUIT
   et compare-le à ce que le consommateur attend.

3. VÉRIFIE LES CHIFFRES eux-mêmes, un par un, contre la source. Un chiffre
   plausible mais faux est le pire défaut : le lecteur est un investisseur âgé
   qui n'a aucun moyen de vérifier. Recoupe au moins 5 valeurs du briefing avec
   un appel direct à l'API.

4. VÉRIFIE LA LIGNE ROUGE. Sérialise un briefing complet et cherche : conseil,
   recommandation, objectif de cours, prévision de direction, note, score. Rien
   de tel ne doit pouvoir atteindre le lecteur, ni depuis le LLM, ni depuis un
   titre de presse recopié.

5. CE QUI MANQUE, par rapport à la spec : le calendrier macro au-delà des
   banques centrales, le watchdog de l'alarme XSerializationChanged, la vue
   dashboard connectée (jamais vérifiée : le JWT était expiré).

Rends : (a) les bugs CONFIRMÉS avec la commande qui les reproduit, (b) ce qui
manque par rapport à la spec, (c) ce que tu as vérifié et qui est SAIN — sois
aussi précis sur ce point que sur les défauts. Distingue ce que tu as MESURÉ de
ce que tu SUPPOSES.
```

---

## Les points faibles connus, à ne pas redécouvrir

Trois choses que je sais imparfaites au moment d'écrire ces prompts :

1. **`analyst.check_synthesis` vérifie qu'un chiffre EXISTE dans les données, pas
   qu'il est attaché au bon marché.** Une synthèse qui donnerait la variation de
   Tokyo à Hong Kong passerait. Un contrôle sémantique demanderait un second
   appel LLM.
2. **`main.py --briefings` appelle `collect_news` une fois PAR PLACE.** CNBC
   apparaît dans `nyse` et dans `nasdaq` : le même flux est donc récupéré deux
   fois. Sans conséquence à trois places, à surveiller à dix.
3. **La vue dashboard connectée n'a jamais été vue.** Le JWT avait expiré et je
   n'entre pas de mot de passe. Tout le reste est vérifié en prod (assets servis,
   API 401, module chargé comme objet réel, i18n complète).
