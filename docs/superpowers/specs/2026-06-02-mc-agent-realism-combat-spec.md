# MC Agent — Spec réalisme/anti-détection & combat avancé (purple-team)

> **Provenance** : recherche multi-agents (12 angles + synthèse), 02/06/2026, MC Java 1.21.x. Chiffres vérifiés Wiki + docs anti-cheat (Grim/NCP/Vulcan/Matrix) + docs mineflayer.
> **5e document de la série planner MC Agent** — le plus aligné sur la mission **PURPLE-TEAM**. Companions :
> `…-diamond-planner-spec.md` · `…-diamond-netherite-deep-research.md` · `…-resources-crafting-spec.md` · `…-xp-enchanting-spec.md`
>
> Couvre : détection anti-cheat (seuils exacts), signatures des cheats, imitation humaine (mouvement/visée/chat → clone 1b), combat/PvP (armes, **Mace**, crits, bouclier, totem), navigation/structures, fermes auto, villages/commerce, API mineflayer + **humanisation**, et déterministe vs LLM.
> **Insight clé : les DEUX FRONTS** — (1) passer la prédiction de Grim = déterministe (ne jamais sortir des bornes physiques vanilla) ; (2) battre le jugement humain = réinjecter l'imperfection (jitter/overshoot/latence). *L'absence d'imperfection est elle-même la signature.*

---

# PARTIE I — Realisme & anti-detection (le coeur de la mission)

> **Modele mental directeur (le fil rouge de toute la PARTIE I).** Les anti-cheats modernes (Grim surtout) **rejouent ta physique tick par tick** et te flaggent si tu **dépasses** un optimum mathematique. La detection comportementale (modos, ML killaura) te flagge si tu **conformes trop** a cet optimum. Donc un bot purple-team a **deux fronts** :
> - **FRONT 1 — passer la prediction (déterministe)** : ne jamais sortir des bornes physiques vanilla. C'est binaire, c'est du 0-token (cf. PARTIE IV).
> - **FRONT 2 — battre le jugement humain (réaliste)** : reinjecter l'imperfection humaine (jitter, overshoot, latence variable, erreurs). C'est ÇA le coeur de la mission, et c'est ce qu'on enseigne aux modos.
>
> **Principe unique :** *l'absence d'imperfection est elle-même la signature.* Grim ne cherche pas "trop rapide", il cherche "trop conforme". Un bot fonctionnellement legal (passe Grim) mais comportementalement robotique reste repérable a l'oeil entraine.

---

## A. Detection anti-cheat (mouvement + combat) : seuils exacts

### A.0 Constantes physiques vanilla (le bot DOIT les respecter — FRONT 1)

Serveur = **20 TPS = 50 ms/tick**. Toute action est quantisee au tick.

| Grandeur | Valeur exacte | Note |
|---|---|---|
| Marche | **4.317 b/s** (0.2158 b/tick) | base attribute 0.1 |
| Sprint | **5.612 b/s** (+30 %) | |
| Sprint-jump (vitesse moy.) | **7.127 b/s** | le vrai "deplacement rapide" legit |
| Sneak | ~1.295 b/s (~30 % marche) | |
| NoSlow (manger/bloquer) | vanilla reduit a **~1.17 b/s** | garder la vitesse sprint en mangeant = flag |
| Friction sol | **×0.91** × slipperiness du bloc | glace ≈ 0.98 |
| Gravite (chute) | **+0.08 b/tick²** vers le bas | |
| Drag vertical | **×0.98 / tick** | applique apres gravite |
| Saut (velocite initiale) | **0.42 b/tick** ; sprint-jump +0.2 horizontal | |
| Hauteur de saut | **1.252 bloc**, dure ~12 ticks | un saut "1.5 bloc" = fly |
| Terminal velocity (chute) | **≈3.92 b/tick (~78.4 b/s)** | au-dela = vol/no-gravity |
| Step (montee sans saut) | max **0.6 bloc** | monter >0.6 sans saut = flag Step |

### A.1 Checks anti-cheat & seuils (Grim / NCP / Vulcan / Matrix)

**Grim** = prediction 1:1 "unbypassable", un seul moteur couvre Fly/Speed/Motion/Timer/NoFall/GroundSpoof/Phase/Strafe/Elytra. Seuils annonces par le repo officiel :

| Check | Seuil | Tell humain vs bot |
|---|---|---|
| **Speed / Simulation** | ecart **> 0.01 %** vs position predite | Bot : acceleration instantanee 0→max en 1 tick. Humain : rampe via friction ×0.91 sur 3-5 ticks |
| **Timer** | **> 1.005×** le debit de packets attendu | Bot : envoie trop de move-packets/s (jouer plus vite que 20 TPS). Humain : ≤ 1.005× |
| **Reach (combat)** | **> 3.0–3.01 blocs** (tolerance lag ≤3.5 config laxiste) | Bot : reach 3.4 constant. Humain : 3.0 max, rate parfois pour latence |
| **Antiknockback** | bloque **99.99 %** | Bot : ignore un knockback (= mort instantanee du deguisement). Humain : subit le KB |
| **NoFall** | flag `onGround` mensonger apres chute >3 blocs sans degats | Bot : ment "au sol". Humain : subit les degats de chute |
| **GroundSpoof** | `onGround=true` alors que prediction dit "en l'air" | idem |
| **Phase** | presence dans un bloc solide (collision violee) | impossible humainement |
| **Step** | montee >0.6 bloc sans saut | Bot : monte tout droit. Humain : saute |
| **NoSlow** | vitesse sprint conservee en mangeant/bloquant (vanilla → ~1.17 b/s) | Bot : full speed en mangeant. Humain : ralenti |
| **Jesus** | velocite Y stable au-dessus d'un liquide | Bot : marche sur l'eau. Humain : nage/coule |

### A.2 Checks COMBAT (rotation/CPS) & seuils

| Check | Seuil | Tell humain vs bot |
|---|---|---|
| **GCD rotation** (le check #1) | deltas yaw/pitch d'un humain = **multiples d'un GCD** derive de la sensibilite souris ; bot pose `yaw=atan2()` exact → deltas **non-multiples** | Bot : angles arbitraires hors-grille → flag quasi-certain. Humain : grille de sensibilite |
| **Snap rotation** | rotation **>~35°/tick** = cible acquise en 1 tick | Bot : snap instantane A→B. Humain : rotation progressive multi-ticks + easing |
| **Multi-target / multi-aura** | 2+ entites touchees en intervalle trop court, ou cible hors-FOV (dans le dos) | Bot : `nearestEntity` 360°. Humain : mono-cible, FOV ~±60° |
| **Smoothness / entropy** | rotation trop lisse (courbe parfaite) OU variance d'aim nulle | Bot : zero wobble. Humain : jitter + micro-corrections + overshoot |
| **CPS — packets/tick** | **3+ packets/tick (>60 CPS)** = flag immediat ; 2/tick (~20 CPS) tolere | Bot : peut spammer. Humain : 8-14 CPS |
| **CPS — statistique** | ecart-type ≈ 0 (ex. "15 CPS pile 2h") = flag ; AC moderne calcule **σ, skewness, kurtosis** | Bot : meme un random uniforme naif est trop symetrique. Humain : asymetrie naturelle + bursts + micro-pauses |
| **Pitch clamp** | **[-90°, +90°]** strict | depasser = impossible legitimement |

### A.3 Pitfalls de detection a connaitre

- **Bouclier mal compris** : un AC verifie que tu ne "bloques" pas ce qui est imbloquable (lingering, sonic boom Warden, fleche Piercing) — un bot qui croit bloquer reste expose.
- **Crit invalide au sol** : critter sans etre en chute (vy<0) = etat impossible → flag AutoCrit. Voir D.2.
- **Sweep/sprint contradictoire** : sweep exige sol+non-sprint ; crit exige chute+non-sprint ; sprint-KB exige sprint. Les 3 sont mutuellement exclusifs → une machine d'etat incoherente se trahit.

---

## B. Signatures des cheats connus (le 'tell' observable de chacun)

> Double usage : **reproduire** (pour un tricheur credible) ET **grille de lecture modo** (pour reperer). Regle de reproduction : un humain-tricheur garde un **defaut residuel** — snap mais pas parfait, reach 3.0 pas 3.5, totem rapide mais pas 1-tick.

| Cheat | Tell visuel (ce que le modo voit) | Pourquoi (déterministe vs humain) | Reproduction credible |
|---|---|---|---|
| **Killaura** | Frappe une cible **derriere / a cote / a travers un mur** sans tourner la tete ; **rotation snap** puis retour ; attaque **plusieurs mobs au meme tick** (multi-aura) ; hits parfaitement cadences | Snap = teleportation angulaire (souris impossible) ; humain a une courbe + overshoot + tremblement | `lookAt` AVANT `attack`, FOV ≤90°, rotation finie + easing, jamais 2 cibles/tick, respecter cooldown 12 ticks, CPS bruite |
| **Baritone (pathfinding)** | Trajectoires **diagonales parfaites**, jamais perdu, jamais d'hesitation, vire pile aux angles, parkour millimetre | A* déterministe → chemin optimal reproductible ; humain hesite, recule, sous-optimal | OK d'etre efficace mais garder micro-pauses, regard non aligne au vecteur de deplacement, sous-optimalite occasionnelle |
| **Scaffold / tower** | Pose des blocs **en marche arriere** sous soi sans regarder le sol, **god-bridge instantane**, pose en plein air / angle impossible, tete figee | Pose server-side sans rotation tete vers le bloc ; humain doit regarder le bloc | Orienter la tete vers la face de pose, cadence realiste |
| **X-ray** | **Tunnels droits qui debouchent pile sur un filon**, taux diamant anormal, ignore la pierre, **zigzag direct d'ore en ore** | Connaissance d'info cachee → pas d'explo aveugle ni de tunnels steriles | Creuser vers des ores "comme par hasard" MAIS garder des tunnels steriles + explo ratee (AC : *Mine Pattern* cap-vers-diamant + *Mine Sight* villageois-invoque) |
| **Autototem** | Totem **re-equipe en main gauche en ~1-3 ticks** apres pop, jamais de fenetre sans totem | Re-equipe via InventoryClick <150 ms, infaillible ; humain ~200-400 ms et rate parfois | Delai variable >150 ms + echecs occasionnels |
| **Fast-break / Nuker** | Blocs casses **plus vite que le hardness** ; Nuker = plusieurs blocs/tick autour de soi sans viser chaque bloc | Casse < temps minier theorique ; humain casse 1 bloc a la fois en le regardant | Respecter break-time vanilla + viser chaque bloc |
| **Fly / Glide** | Reste en l'air **sans support**, **vitesse Y constante** (pas de gravite), pas de fall-damage, hover parfait | Mouvement Y non balistique ; humain subit gravite | Mouvement uniquement via skills physiques mineflayer (jump), jamais de Y artificiel |
| **Speed / Timer** | Deplacement > vitesses A.0, ou actions plus rapides que 20 TPS | depasse la simulation Grim | Ne jamais depasser 7.127 b/s sprint-jump ; ≤1.005× packets |
| **NoSlow** | Garde vitesse sprint en mangeant / tirant a l'arc / bloquant | vanilla ralentit a ~1.17 b/s | Subir le ralentissement |

---

## C. Imiter l'humain (mouvement, visee, chat) + lien clone 1b

### C.1 Chiffres humains de reference (tout est ALÉATOIRE, jamais constant)

| Signal humain | Valeur | Nature |
|---|---|---|
| **Temps de reaction visuel simple** | moy. **~250 ms** (gamers entraines 200-250 ; <200 = exceptionnel ; **plancher dur ~120-150 ms**) | ex-gaussienne (gaussienne + queue exponentielle a droite) |
| Dispersion du RT | **σ croit ~lineairement avec la moyenne** (RT longs = plus disperses) | asymetrique, jamais symetrique |
| Reaction de **choix** (cible parmi plusieurs) | **+50-150 ms** vs reaction simple | aleatoire |
| **Profil de vitesse souris** (Fitts) | accel → **pic a ~40-50 % du trajet** → decel (balistique puis correction) | semi-déterministe (forme) + bruit |
| **Overshoot + correction** | depasse la cible puis sous-mouvement correctif oppose (surtout cibles petites/lointaines) | aleatoire (presence + amplitude) |
| **Micro-jitter camera** | oscillations permanentes (±0.3°, tremblement main) meme cible verrouillee | aleatoire continu |
| **CPS PvP** | moy. **5-8 CPS** (combat soutenu) ; jitter/butterfly **12-25 CPS** ; record ~25 | aleatoire, rythme monte/descend |
| Intervalle inter-clic | jamais constant + **micro-pauses** | variance elevee |
| **GCD rotation** | yaw/pitch quantifies par la sensibilite : pas ≈ `(sens·0.6+0.2)` puis `×8.0` (ordre **~10⁻³ deg**) | déterministe chez l'humain (grille) — poser des angles arbitraires CASSE la grille |
| **Frappe chat** | adulte **38-40 WPM** ; gamer **55-70** ; competitif **70-90** | aleatoire |
| Latence reponse chat | **3-5 s** echange vif ; **<1 s = tell #1** ; >4 s sans signal = QoE baisse | variable selon complexite |

### C.2 Mouvement & visee — FAIRE vs TRAHIT

**FAIRE (realisme) :**
- **`look-then-act`** : toujours tourner la camera AVANT d'attaquer/miner/poser, avec delai tire d'une **ex-gaussienne (~250 ms, queue droite, min 120 ms)** — jamais fixe.
- **Rotation interpolee** sur plusieurs ticks : profil accel→pic ~45 %→decel, **overshoot 5-15 % puis correction** sur cibles lointaines, **micro-jitter permanent** ±0.3°.
- **Respecter la grille GCD** : quantifier chaque `bot.look()` sur le pas d'une souris virtuelle (sensibilite tiree par profil) → deltas multiples d'un pas commun comme un vrai client.
- **CPS** : intervalles d'une distribution centree 5-10 CPS, variance + micro-pauses + bursts ; jamais 20 CPS pile.

**TRAHIT (a eviter, ou injecter par intermittence pour rester "attrapable" par les modos) :**
- Rotation snap 1 tick ; courbes trop lisses/rectilignes sans wobble ; **GCD casse** ; reaction <150 ms ou variance nulle ; CPS constant (σ≈0) ; visee parfaite sans overshoot ; aim qui suit a travers les murs.

### C.3 Chat humain — FAIRE vs TRAHIT

**FAIRE (post-traiter la sortie LLM) :**
1. **Delai simule** = `latence_lecture (0.8-2.5 s) + longueur_char / WPM_tire`. WPM ~ N(55, 12) borne 35-90 selon profil. **Plancher ~1.2 s, jamais <1 s.**
2. **Style** : forcer lowercase, retirer ponctuation finale, cap ~8-12 mots, injecter abreviations (`you→u`, `are→r`, `good game→gg`). Argot haute frequence : `gg`, `wp`, `ez`, `ggwp`, `lol`, `idk`, `idc`, `np`, `thx`/`ty`, `ik`/`ikr`, `brb`, `afk`, `gtg`, `wdym`, `rip`, `nice`.
3. **Bruit de frappe** : p≈5-10 % typo (transposition/touche voisine) ; p≈2 % message de correction `mot*`.
4. **Ne pas tout repondre** : p≈15-30 % ignorer un message non adresse ; se taire pendant combat/tache longue (deja gere par `tasks.js`).
5. **Calibrer par profil** : "evident" = rapide + grammaire propre + toxicite `ez` (suspect = pedagogique) ; "expert" = max variabilite + silences.

**TRAHIT :** latence fixe, grammaire/ponctuation parfaite, majuscules, listes formatees, sur-explication (mini-essay), reponse systematique a 100 %, ton constant 24/7, reponse <1 s. *Differenciateur le plus robuste = la **variabilite temporelle/comportementale** (jitter latence + silences + AFK), pas le contenu.*

### C.4 Lien avec le clone 1b (capture → `derivedParams`)

`style.json` doit stocker, **par contexte**, des **distributions** (pas des moyennes nues) :

| Capture (`style.json`) | Mappe sur (mineflayer) |
|---|---|
| histogramme RT (moy + σ + skew) | µ/σ du `setTimeout` avant chaque action (normale tronquee) |
| CPS moy/var | base + jitter gaussien de l'intervalle d'attaque |
| amplitude jitter motricite | amplitude micro-jitter `bot.look` + σ intervalle CPS |
| taux/amplitude overshoot | overshoot de la rotation interpolee |
| **sensibilite souris implicite** (pas de rotation) | **pas du GCD** a respecter dans l'interpolation finale |
| pauses/idle | frequence micro-pauses + `loiter` |

`derivedParams` = **re-echantillonner ces distributions a l'execution** (RNG injectable, comme le `RateLimiter` du piege #40) plutot que rejouer des constantes. `movementJitter` (deja present, `loiter`) est l'amorce ; l'etendre a **latence de reaction** et **profil de vitesse de rotation**. Un seul tirage aleatoire par action, cale sur les params humains, casse a la fois le snap, le GCD parfait et la variance nulle.

---

# PARTIE II — Combat & survie avancee

## D. Armes & coups critiques

### D.1 Cooldown & degats par arme (DÉTERMINISTE)

`cooldown_ticks = 20 / attack_speed`. Multiplicateur de charge `p` (0→1) : **`0.2 + 0.8·p²`**. Frapper trop tot = plancher **20 %**. Plein degat a 100 % ; **crit/sweep/sprint-KB exigent charge ≥84.8 %**.

| Arme (palier) | Degats (HP, ½cœur) | Atk speed | Cooldown | DPS full-charge |
|---|---|---|---|---|
| Epee bois/or | 4 | 1.6 | 0.625 s | |
| Epee pierre | 5 | 1.6 | 0.625 s | |
| Epee fer | 6 | 1.6 | 0.625 s | |
| Epee diamant | 7 | 1.6 | 0.625 s | |
| **Epee netherite** | **8** | 1.6 | 0.625 s (12 ticks) | **≈12.8 (le + haut)** |
| Hache bois/or | 7 | 0.8 | 1.25 s (25 ticks) | |
| Hache pierre | 9 | 0.8 | 1.25 s | |
| Hache fer | 9 | 0.9 | 1.111 s (22 ticks) | |
| Hache diamant | 9 | 1.05 | 0.952 s | |
| **Hache netherite** | **10** | 1.05 | 0.952 s | **≈10.5 (burst)** |
| **Masse (Mace)** tous paliers | **6** (au sol) | 0.6 | 1.667 s | ≈3.6 (au sol, nulle) |

→ **Epee = DPS soutenu** ; **hache = burst + disable bouclier** ; **masse = niche chute** (voir D.3).

### D.2 Coup critique (+50 %, DÉTERMINISTE)

Multiplie les degats **de base ×1.5** (AVANT enchants, APRES effets). Conditions **TOUTES** requises : en **chute** (vy<0, pas au sol), **pas sprint**, charge **≥84.8 %**, **pas** dans l'eau, **pas** echelle/liane, **pas** Slow Falling/Blindness/Levitation, pas monte/vol. Technique humaine = **jump-crit** (sauter → frapper en descente). Le sprint annule le crit → un humain alterne sprint(approche) → relache → saut → crit.

**Sweep attack (epee, exclusif du crit)** : charge ≥84.8 % + **au sol** + non-sprint + pas crit + vitesse sous seuil → touche entites dans **3 blocs** pour **1 HP** + Sweeping Edge I/II/III = **+50/67/75 %** des degats de base. Sprint↔crit↔sweep = **3 etats distincts mutuellement exclusifs** (cohérence machine d'etat obligatoire).

### D.3 Masse (Mace) — mecanique chute

- **Smash** declenche apres chute **≥1.5 bloc**, **ignore le cooldown**.
- Bonus degats : **+4 HP/bloc** (3 premiers) → **+2 HP/bloc** (5 suivants) → **+1 HP/bloc** (au-dela), **illimite**.
- **Annule les degats de chute** si le coup touche. Knockback 2.5 blocs. Durabilite 500. Craft : **Heavy Core** (7.5 % ominous vault) + **Breeze Rod**.
- Enchants : **Density** (max V, +0.5 HP/niv/bloc), **Breach** (max IV, −15 % armure/niv), **Wind Burst** (max III, propulse +8 blocs/niv → **relance un smash** = combo).

### D.4 A-distance

- **Arc** : full-draw **1 s** = 9 HP (×crit aleatoire jusqu'a ~11.5). Maintien → relache.
- **Arbalete** : charge **1.25 s** ; **Multishot** (3 fleches), **Piercing** (traverse + ignore bouclier).
- **Trident** : 9 HP melee/lance ; Loyalty (revient), Riptide (propulse sous pluie/eau), Channeling (foudre).

### D.5 LOGIQUE de choix d'arme (varier, pas spammer) — LLM

| Contexte | Arme | Raison |
|---|---|---|
| Foule de mobs groupes | **Epee** (sweep) | touche tout dans 3 blocs |
| Adversaire avec **bouclier** | **Hache** | desactive le bouclier 5 s |
| Adversaire **en contrebas** / je tombe sur lui | **Masse** (+ Wind-combo) | +4 HP/bloc, ignore cooldown |
| 1v1 DPS soutenu | **Epee netherite** | 12.8 DPS, le + haut |
| Cible a distance / kiting | **Arc / arbalete** | ne pas s'exposer |
| Adversaire qui **bloque** beaucoup | switch epee→hache | casser la garde |

**Le bot DOIT varier** : taper a l'epee en permanence est sous-optimal ET un tell (un humain switch selon le contexte). Le choix est **contextuel = LLM** (cf. PARTIE IV) ; l'execution du coup (cooldown, crit-jump) est déterministe.

---

## E. Defense

### E.1 Bouclier (DÉTERMINISTE)

| Parametre | Valeur exacte | Note |
|---|---|---|
| Activation (clic-droit → actif) | **5 ticks = 0.25 s** | aucun degat bloque avant ce delai |
| Couverture | demi-cylindre **frontal 180°** (sens horizontal regarde) | attaque dans le dos passe |
| **Bloque** | melee, fleches normales/tippees/spectrales, fireballs, boules de neige, œufs, trident lance, **toutes explosions** (Java), shulker bullets, llama spit, wither skulls, ravager | degats → 0, knockback → 0 |
| **NE bloque PAS** | fleche **arbalete Piercing**, foudre, **effets** potions splash/lingering, evoker fangs, souffle dragon, **sonic boom Warden**, degats de chute | piege : ne pas "croire" bloquer |
| **Disable par hache** | **5 s** (tous boucliers du joueur), 1 attaque bloquee avant | pas de degat du disable lui-meme |
| Durabilite | degat = force attaque (arrondi sup.) **si ≥3 HP** | sinon 0 usure |

### E.2 Totem of Undying (DÉTERMINISTE + jitter humain)

- En **main ou offhand** (pas hotbar non-selectionne). A la mort : **+1 HP**, **purge tous effets**, puis **Regen II 45 s** (≈0.4 HP/s), **Fire Res I 40 s**, **Absorption II 5 s** (4 cœurs jaunes). Pas de cooldown, consomme.
- **Totem-popping** : re-equiper un totem dans la meme fraction de seconde. Re-totem en **0 tick parfait** = signature non-humaine → injecter delai **≈100-250 ms variable + echecs occasionnels**.

### E.3 Gapples (heal/kiting)

- **Gapple normale** : Absorption I (2 cœurs) + Regen II 5 s.
- **Enchanted gapple** : **Regen II 20 s** (≈8 HP), **Absorption IV 2 min** (8 cœurs), **Resistance V 5 min**, **Fire Res 5 min**. Eat ≈ **1.6 s**. Usage : manger en reculant/kiting, jamais a decouvert.

### E.4 Mouvement de combat (DÉTERMINISTE + humanisation)

| Mecanique | Chiffre | Note |
|---|---|---|
| **Crit-jump / jump-reset** | sauter pour retomber pile au moment du hit | seul moyen de critter (vy<0) |
| **Sprint-KB** | sprint au moment du hit → KB renforce, annule le sprint | base du **w-tapping** (relacher/re-sprint pour reset KB chaque coup) |
| **Strafe** | arcs A/D irreguliers, vitesse variable | tell bot = rayon/vitesse angulaire constants |
| **Ender pearl** | **5 HP (2.5 cœurs)** a l'arrivee (reduit par Prot/Feather Fall) ; cooldown lancer **1 s** | fuite/repositionnement |

### E.5 Armure + enchants (DÉTERMINISTE)

- **Armor point = 4 %** reduction max ; sans toughness, **−2 pts/HP** de degat entrant. **Toughness netherite** (4 pieces) ramene a **≈0.8 %/HP** → bien meilleur sur gros coups.
- **Protection** : 4 %/niv → **Prot IV full ≈64 %** effectif (cap interne EPF 80 %).
- **Projectile Protection** : **8 %/niv → IV = 32 %** vs fleches/tridents/fireballs (pas explosions).
- Combo PvP standard : **Netherite + Prot IV** partout.

### E.6 Defense — FAIRE vs TRAHIT

- ✅ Lever bouclier **≥250 ms avant** impact prevu ; lacher si l'adversaire sort une **hache** (sinon 5 s sans defense). ⚠️ Ne pas "bloquer" lingering/sonic boom/Piercing.
- ✅ Re-totem instantane pour la survie MAIS ⚠️ injecter jitter (latence variable + rates) sinon timing inhumain.
- ✅ Respecter le **84.8 %** avant chaque coup ; caler crits via jump-reset (~40-70 % de crits, **pas 100 %**). ⚠️ Jamais d'intervalle fixe parfait ni snap 0-tick (LE tell killaura/autoclicker que Vulcan/Hawk cherchent : regularite d'attaque, rotation-then-hit, crits invalides au sol).
- ✅ Strafe = randomiser rayon/vitesse/jitter d'aim ; pearl a **5 HP** pres des limites de vie. ⚠️ aim-snap derriere un mur / hit hors-FOV = flag.

---

## F. Navigation & structures

### F.1 Limites de `mineflayer-pathfinder` (DÉTERMINISTE)

| Limite | Valeur / comportement |
|---|---|
| Crash chunks non charges | cible "trop loin" → tente d'acceder a des chunks non charges → **crash** (issue #39) |
| Seuil pratique grille fine | couteux/irrealiste **au-dela de ~64 blocs** sur terrain inconnu |
| Coarse-grid (PR non mergee) | nœuds espaces de **16 blocs** (1/chunk) pour >64 blocs ; segments <10 ms ; permettrait 10 000+ blocs |
| Bloc incassable sur le chemin | **hang indefini** (bedrock, obsidienne hors-portee) — issues #222 |
| Memory leak | chunks ne se dechargent pas → fuite sur longues sessions (issue #1123) |
| Distance de simulation serveur | le bot ne "voit" que **2-10 chunks** → `findBlock` aveugle au-dela |

**FAIRE** : jamais de `GoalBlock` distant brut → decouper en **hops ≤64-128 blocs** vers un waypoint, `bot.waitForChunksToLoad`, recalculer. Tres longue distance : `GoalXZ` + sprint ligne droite (creuse/contourne), pas A* complet. Purger/recycler periodiquement (memory leak).

### F.2 Localisation des structures (Y / biome / methode) — DÉTERMINISTE

| Structure | Y (Java) | Biome | Espacement / methode |
|---|---|---|---|
| **Village** | surface | plaines, savane, desert, taiga, neige | spacing **34** ch / sep **8** |
| **Pillager outpost** | surface | memes biomes village (souvent ≤ qq centaines de blocs d'un village) | spacing **32** / sep **8** |
| **Nether fortress** | ~Y 30-90 | tous biomes Nether | region ~**27 chunks** (alterne avec bastion) |
| **Bastion remnant** | ~Y 30-90 | tous sauf Basalt Deltas | meme region (~27), **2/3** vs 1/3 fortress |
| **Ancient city** | sol a **Y=−51** | **Deep Dark** uniquement | rare, sous montagnes/faible erosion |
| **Stronghold** | tout Y, surtout souterrain | tous | **128 strongholds, 8 anneaux** ; anneau 1 = **3** a **1 280-2 816 blocs** de l'origine |
| **Trial chambers** | **Y −52 a 30** | tout Overworld sauf Deep Dark | grille **34×34 chunks**, 1/region |
| **Ocean monument** | ~Y 39-61 | Deep Ocean (adjacent) | spacing **32** / sep **5** |
| **Woodland mansion** | surface | **Dark Forest / Pale Garden** | spacing **80** / sep **20** → tres loin du spawn (souvent >1 000-10 000 blocs) |

**Methodes de recherche :**
- **`/locate structure <id>`** (op/cheat) = instantane, exact → utile au bot MAIS **TRAHIT** (aucun humain ne tape `/locate` puis fonce en ligne droite a la coord exacte sans explorer).
- **Exploration** : village/outpost/monument/mansion en parcourant le bon biome. Mansion = necessite **woodland explorer map** (cartographe villageois — un humain en achete une).
- **Stronghold = triangulation Eyes of Ender** : lancer 1 eye, lire **X,Z + yaw (F3)** ; se deplacer **≥200 blocs (ideal ≥500, ~90°)**, relancer, intersecter les 2 rayons → coord du portail. mineflayer : `bot.entity.yaw`, traquer l'entite `ender_eye`, resoudre l'intersection de 2 droites.

### F.3 Waypoints & retour base (DÉTERMINISTE côté bot)

- Stocker `home = {x,y,z,dimension}` a la connexion ; retour = `GoalNear(x,y,z,range)` par hops.
- **Boussole** = pointe le world spawn (ou `/spawnpoint`), pas la base. **Lodestone + boussole** = point fixe (un humain cree ça ; le bot garde juste les coords en RAM).
- **Carte/map** = repere visuel humain ; le bot lit F3 → **absence de carte dans l'inventaire** d'un "navigateur parfait" est un tell faible mais reel.

### F.4 Navigation — TRAHIT

Ligne droite parfaite vers une coord jamais visitee (= baritone/pathfinder) ; precision au bloc pres sans hesitation ; vitesse constante au tick ; **0 temps mort** entre "je dois aller a X" et l'arrivee ; snap de yaw vers le prochain nœud ; saut au tick exact sur obstacle repete. **Imiter** : bruit de trajet (deviations ±, pauses, demi-tours), throws ratés en triangulation, notes de coords dans le chat avec erreurs ±qq blocs, se perdre brievement.

---

## G. Fermes automatiques (faisabilite-bot)

| Ferme | Mecanique cœur | Rendement | Redstone ? | Faisable par bot ? |
|---|---|---|---|---|
| **Iron farm** | 3+ villageois en *panic* (zombie ≤8 blocs) → golem **toutes les 5 s** (Java) ; golem drop **3-5 lingots**, 100 HP | **200-450 fer/h** | **Non** (piston-feeder optionnel) | Oui mais transport/cage zombie + hoppers orientes = chaines de pose precises (un hopper mal oriente = ferme morte → tell de bot maladroit) |
| **Gold farm (portal)** | blocs portail random-tick → zombified piglin pousses en Overworld | lent mais simple | **Non** (purement spatial) | **Oui** |
| **Gold farm (Nether-roof natural)** | spawn naturel piglin **light ≤11**, nether wastes, sous le toit | tres haut debit (best Java) | **Non** mais build lourd | Oui (gros placement) |
| **Mob/XP farm** | dark room **light niveau 0** (post-1.18), spawn rayon **128 blocs**, mob cap **~70 hostiles**, chute **23-24 blocs** (1-coup zombie/squelette) | variable, pic si AFK bon spot | **Non** (water + gravite suffisent) | **Oui** |
| **Crop farm (villageois fermier)** | fermier replante/recolte ; 2e villageois capte via hoppers | passif, modere | **Non** | **Oui** |
| **Crop farm (observer/piston)** | observer detecte maturite → eau/piston flush ; recolte ~80 % mur (≈31 min wheat) | burst eleve | **OUI — timing complexe** | **Eviter** : observer/piston/dust + timing tres fragile, 1 bloc mal aligne casse tout silencieusement |

Notes Java vs Bedrock : Java valide lit/workstation sur interaction **momentanee** → fermes compactes fiables. Bedrock : iron farm `1/700 tick` ≈ 35 s/attempt + cap +1 golem / 10 villageois.

**Recommandation MC Agent** : le bot doit *reconnaitre* les 6 types (vocabulaire modo) mais ne *construire* que **les fermes sans-redstone** (mob, gold-portal, crop-villageois prioritaires), avec **bruit comportemental injecte**. La construction redstone-timing est hors-portee realiste ET serait elle-meme un tell.

**Ce qui TRAHIT (construction/farming) :** pose pixel-perfect sans hesitation ; cadence constante (1 bloc/200 ms pile → mettre 150-600 ms variable + pauses) ; pas de "scaffold-and-mine" (erreurs de hauteur, sauts, manger au mauvais moment) ; **AFK farming immobile des heures au spot optimal** (signal fort modo) → imiter micro-mouvements + deconnexions + regard qui derive ; redstone "trop propre" du premier coup.

---

## H. Villages & commerce (acquisition deterministe)

### H.1 Metiers (13 professions → bloc de travail)

| Profession | Bloc | Profession | Bloc |
|---|---|---|---|
| Farmer | Composter | Librarian | **Lectern** |
| Fisherman | Barrel | Cartographer | Cartography Table |
| Shepherd | Loom | Leatherworker | Cauldron |
| Fletcher | Fletching Table | Butcher | Smoker |
| Cleric | Brewing Stand | Mason | Stonecutter |
| Weaponsmith | Grindstone | Armorer | Blast Furnace |
| Toolsmith | Smithing Table | Nitwit | aucun, **ne trade pas** |

Villageois sans emploi cherche un bloc libre dans une **sphere de 48 blocs** ; doit s'approcher a **≤2 blocs** pour le claim plein (sinon relache apres 60 s). Tant que **Novice et jamais trade**, il peut changer de metier (casser+reposer le bloc). **Des le 1er trade, metier verrouille a vie.**

### H.2 Niveaux de trade (XP cumules)

| Niveau | Badge | XP cumule | Trades |
|---|---|---|---|
| Novice | Pierre | 0 | debut |
| Apprentice | Fer | **10** | +2 max |
| Journeyman | Or | **70** | +2 max |
| Expert | Emeraude | **150** | +2 max |
| Master | Diamant | **250** | +2 (max 10 total) |

XP/trade : **3-6** (normal), **8-11** si *willing*.

### H.3 Restock & prix (DÉTERMINISTE)

- Restock **≤2×/jour**, UNIQUEMENT si le villageois **atteint son workstation** (sinon trades locked).
- Demande trackee par item : sold-out a chaque restock → prix **monte** ; non epuise → prix **baisse**.
- Formule prix : `Final = clamp( ⌊p·(m·max(0,d)+1)⌋ − ⌊m·r⌋ − sign(h)·max(1,⌊p·(0.3+0.0625·(h−1))⌋), 1, StackSize )` (p=prix base, m=multiplicateur, d=demande, r=reputation gossip, h=niveau Hero). **Plancher = 1 emeraude.**

### H.4 Reductions (les exploits majeurs)

- **Soigner un zombie-villageois** : (1) **Splash Potion of Weakness** sur le zombie-villageois → (2) clic-droit **Golden Apple normale** (pas enchantee). Cure = **3-5 min** (le garder a l'abri soleil/degats). Donne **major_positive reputation permanent** → prix souvent → **1 emeraude**. Gossip se **propage aux voisins** ; multi-cures empilent (1 cure pour le permanent, jusqu'a ~8 pour le temporaire).
- **Hero of the Village** (apres raid gagne, ~40 min) : **−30 % du prix de base** (amplifier 1), **+6.25 %/niveau** au-dessus, arrondi bas, **min 1**. Cumulable avec la cure.

### H.5 Breeder / trade hall

- Reproduction = **willingness** via **3 pains OU 12 carottes OU 12 patates OU 12 betteraves** dans un slot d'inventaire du villageois + **lit libre** atteignable (2 blocs d'air au-dessus). Bebe → adulte en **20 min**.
- Iron golem : **3 villageois paniques groupes** OU **5 en gossip** ; re-spawn si pas de golem dans 16 blocs sous 30 s.

### H.6 Commerce — FAIRE vs TRAHIT

**FAIRE (acquisition deterministe) :** pipeline canne-a-sucre/papier → **Librarian (lectern)** = source d'emeraudes la + fiable ; **Farmer** = sortie emeraude via cultures ; **cure-discount** scriptable (potion → apple → attendre → trade a 1 emeraude) ; forcer restock = **pathfind vers le workstation** entre deux vagues. Trade-hall : caler position bot ↔ comptoir, acheter jusqu'a lock, attendre restock.

**TRAHIT :** cadence d'achat parfaite (vider un trade pile a la limite, en boucle reguliere) → injecter latence aleatoire + abandons + ouvrir/fermer le GUI plusieurs fois ; restock-cycling au tick pres 2×/jour pile → jitter + trajets sous-optimaux ; curing en chaine sans erreur ni degat → rater parfois la fenetre Weakness ; selection de trade par index fixe (toujours slot 0) → scroller/varier ; rotation tete instantanee vers le PNJ → smoother les `lookAt`.

---

# PARTIE III — Implementation mineflayer

## I. API combat + humanisation + limites + exemples open-source

### I.1 `mineflayer-pvp` (PrismarineJS) — API officielle

| Methode / propriete | Role | Defaut |
|---|---|---|
| `bot.pvp.attack(entity)` | engage (gere pathfinding + swing) | — |
| `bot.pvp.stop()` | arret propre (laisse le pathfinder finir) | — |
| `bot.pvp.forceStop()` | stoppe ET coupe le pathfinder | — |
| `bot.pvp.target` | cible courante (read-only) | `null` |
| `bot.pvp.followRange` | distance de poursuite | `2` |
| `bot.pvp.viewDistance` | au-dela → desengage | `128` |
| `bot.pvp.attackRange` | portee d'attaque max | `3` |
| `bot.pvp.meleeAttackRate` | objet `Cooldown` qui cadence les coups | tick-based |
| events | `startedAttacking` / `stoppedAttacking` / `attackedTarget` | — |

- **Cooldown 1.9 : OUI respecte** (`meleeAttackRate` attend la recharge, n'attaque pas en burst).
- **Crit (saut+attaque) : NON implemente** (issue #9, toujours ouverte) → `bot.pvp` ne saute jamais → **tous ses coups non-critiques**. Pour critter : piloter `bot.setControlState('jump', true)` qq ticks avant le swing, puis attaquer en phase de chute.

### I.2 Attaque bas-niveau & items

- `bot.attack(entity, swing=true)` — coup brut, **ne gere PAS le cooldown** → spam = degats ridicules (issue #791). A gater manuellement.
- **Bouclier** : `bot.activateItem(true)` (offhand) pour bloquer, `bot.deactivateItem()` pour relacher.
- **Switch d'arme** : `bot.equip(item, 'hand')` selon la cible (cf. tools.js : palier netherite>diamant>fer>… ; epee>hache).
- **Arc/trident** : `bot.activateItem()` (maintenu) → attendre la charge → `bot.deactivateItem()` relache.
- **Targeting** : `bot.nearestEntity(e => e.type==='player' && ...)` filtre par kind/distance — ⚠️ brut = 360°, a restreindre au FOV.

### I.3 Humanisation concrete (les leviers)

| Levier | Comment |
|---|---|
| **Visee interpolee** | JAMAIS `bot.look(yaw,pitch,true)` en combat (`force=true` = snap 1 paquet, 0 interpolation → DETECTABLE). `force=false` (defaut) = lisse sur plusieurs ticks |
| **Plugin smooth-look** | `@nxg-org/mineflayer-smooth-look` : `smoothLook.lookAt(target,{duration,function,goodEnoughDot})` — `function`=courbe easing, `duration`(ms) repartit sur N ticks, `goodEnoughDot`=ne tween pas si deja assez aligne (evite micro-corrections robotiques). Peut monkey-patch `bot.look` |
| **A la main** | par tick `yaw += (target-yaw)·ease(t)` + **overshoot 2-5°** puis recorrection + **micro-jitter ±0.3°** ; snapper la rotation finale sur un **pas GCD** (sensibilite simulee) pour rester coherent |
| **Delai de reaction** | `setTimeout(act, randNormal(µ≈250, σ≈80, min 120))` avant attaque/reponse — **normale tronquee, jamais uniforme ni constante** |
| **CPS variable** | intervalle = `base + jitter` gaussien (8-12 CPS → 80-125 ms ± bruit) + derive lente + pauses ; **jamais `setInterval` fixe** |
| **Pitch clamp** | rester strictement **[-90°,+90°]** |
| **Pathfinder pas-parfait** | ajouter sur-tirs, pas lateraux, pauses, regards alentour (`loiter`), legere desync look↔move |
| **Crit-rate** | viser **~40-70 %** de crits via jump-reset, jamais 100 % |

### I.4 Limites connues

- **Conflit pathfinder ↔ pvp** : les deux ecrivent les control states → `forceStop()` avant tout `pathfinder.goto()` (sinon telescopage).
- **Cibles rapides** : latence d'un tick reseau → decroche sur joueurs qui strafe.
- **Pas de crit / strafe / counter-shield** dans `mineflayer-pvp` de base.

### I.5 Exemples open-source

- **`@nxg-org/mineflayer-custom-pvp`** (`SwordPvP`) : crits 80-100 % (modes `hop`/`packet`/`reactive`), strafe (`circle`/`random`), w-tap, switch-vers-hache si l'adversaire bloque, aim-prediction d'arc, option `cps` (~20). ⚠️ Son crit-rate 80-100 % et CPS ~20 constant sont **eux-memes des tells** → re-randomiser par-dessus.
- **`@nxg-org/mineflayer-smooth-look`** : visee lissee (cf. I.3).
- **`aesthetic0001/mineflayer-anticheat`** (fork v3.18, bypass-oriented) : **catalogue de ce que les AC checkent** — utile comme reference de detection a contrer.
- **`mineflayer-pathfinder`** : navigation (limites en F.1).

---

# PARTIE IV — Deterministe (0-token) vs observation/jugement (LLM)

> Regle de partage : **reflexes / seuils / timings / mecaniques de jeu = 0-token (déterministe)**. **Choix tactiques contextuels = LLM**. Cohérent avec le piege #40 (commandes directes zero-LLM) et l'architecture `reflexes.js` / `humanize.js` / `tasks.js`. Cible #1 : ne pas griller la cle sur ce qui n'a pas besoin de jugement.

## IV.1 DÉTERMINISTE (0-token) — reflexes, seuils, timings, humanisation

Tout ce qui est une **constante de jeu**, une **borne anti-cheat**, un **timing**, ou un **tirage aleatoire d'humanisation** :

| Categorie | Elements 0-token |
|---|---|
| **Bornes physiques (FRONT 1)** | vitesses A.0 (≤7.127 b/s), gravite 0.08 / drag 0.98 / friction 0.91, Step ≤0.6, ≤1.005× packets, terminal velocity, subir KB & fall-damage |
| **Bornes combat** | reach **≤3.0** (hard cap), pitch [-90,+90], FOV ±60° mono-cible, cooldown par arme (epee 12 ticks…), charge ≥84.8 % avant un coup, scaling `0.2+0.8p²`, crit ×1.5 conditions, sweep/sprint-KB machine d'etat |
| **Reflexes survie** | manger sous seuil de faim, fuir/defendre si hostile ≤4 blocs (reflexes.js), totem-pop, lever bouclier ≥250 ms avant impact prevu, lacher bouclier si hache detectee, pearl a ~5 HP, crit-jump timing |
| **Humanisation (FRONT 2)** | jitter rotation ±0.3°, overshoot+correction, rampe d'acceleration, delai de reaction ex-gaussien (~250 ms, min 120), CPS gaussien (8-14, σ>0, bursts), grille GCD, latence chat (≥1.2 s), typos chat, micro-pauses/loiter, jitter de cadence de pose (150-600 ms) |
| **Mecaniques fixes** | structures Y/biome/espacement (table F.2), cooldown/restock villageois, trade XP paliers, recettes de farm, durabilites, mecanique masse (+4/+2/+1 HP/bloc) |
| **Execution navigation** | hops ≤64-128 blocs, `waitForChunksToLoad`, `GoalNear`/`GoalXZ`, triangulation eye-of-ender (resolution geometrique), retour `home` |
| **Commandes directes** | les 16 ordres /msg (piege #40) — parsing + execution, **0 token** |

## IV.2 LLM (observation / jugement contextuel)

Tout ce qui demande **lire la situation et choisir** parmi des options non-triviales :

| Categorie | Decisions LLM |
|---|---|
| **Tactique combat** | **fuir ou combattre ?** (HP, nombre d'ennemis, equipement) ; **quelle arme** (D.5 : epee/hache/masse/arc selon bouclier/foule/contrebas/distance) ; quand kite, quand pearl, quand gapple, cibler qui en multi-ennemis |
| **Tactique navigation** | **quelle structure viser** selon l'objectif (besoin d'emeraudes → village ; de loot → trial chamber/bastion) ; `/locate` vs explorer vs triangulation ; quand rentrer a la base |
| **Economie** | quel metier de villageois farmer, quels trades prioriser, quand lancer un cycle de cure-discount, quelle farm construire selon les ressources dispo |
| **Social / chat** | **quoi repondre** a une question (le contenu) ; engager ou ignorer ; doser la toxicite selon le profil ; gerer une accusation de cheat |
| **Meta-strategie** | sequencer les objectifs (miner puis crafter puis trade), reagir a un evenement imprevu (raid, joueur hostile), decider de varier le comportement pour rester credible |

> **Synthese :** le LLM **decide QUOI faire** (cible, arme, structure, reponse) ; le moteur déterministe **execute COMMENT** (cooldown, reach, crit-jump, jitter, GCD, hops) et **garantit la credibilite** (toute l'humanisation est 0-token). Le contenu du chat passe par le LLM **seulement si** ce n'est pas une commande directe (#40) et que le bot est nomme/adresse — sinon, silence ou ack déterministe en whisper. Ce decoupage protege la cle (FRONT 1 + reflexes + humanisation ne consomment jamais de token) tout en gardant un comportement tactiquement credible (FRONT 2 cognitif via LLM).

---

## Sources

**Anti-cheat (moteurs & checks)**
- [Grim Anticheat — GitHub (3.01 reach, 1.005 timer, 0.01 % speed, 99.99 % antikb, simulation 1:1)](https://github.com/GrimAnticheat/Grim)
- [Grim Anticheat — site officiel](https://grim.ac/)
- [Matrix AntiCheat — SpigotMC (familles Timer/Step/NoSlow/Spider/NoFall)](https://www.spigotmc.org/resources/matrix-anticheat-advanced-cheat-detection-1-8-1-12-1-13-1-14-1-15.64635/)
- [Vulcan Anti-Cheat — SpigotMC (scaffold tower/angle/speed)](https://www.spigotmc.org/resources/vulcan-anti-cheat-advanced-cheat-detection-1-8-1-21-11-folia-supported.83626/)
- [Hawk Anticheat](https://hawkanticheat.github.io/)
- [MX Anticheat — ML Killaura/Aim detection 1.8–1.21 (smooth/constant/GCD) — SpigotMC](https://www.spigotmc.org/resources/mx-anticheat-ml-killaura-aim-detection-1-8-1-21.123341/)
- [Shadow Anticheat 2.0 (KillAura 5-layer) — SpigotMC](https://www.spigotmc.org/resources/shadow-anticheat.131182/update?update=622889)
- [X-Ray Detector (Mine Pattern / Mine Sight) — SpigotMC](https://www.spigotmc.org/resources/x-ray-detector.98131/)
- [How to Develop a Minecraft Anti-Cheat (gist, Snowiiii) — GCD/rotation/CPS/pitch clamp](https://gist.github.com/Snowiiii/2c306f3e8926bc7fb8acaaa8c3c105d7)
- [Minecraft Anticheat #6 — Rotation/Aim GCD Check (YouTube)](https://www.youtube.com/watch?v=m96DqAzS8CI)
- [LiquidBounce PR #328 — rotation fix / GCD bypass](https://github.com/CCBlueX/LiquidBounce/pull/328)
- [AutoClicker Detection Tutorial (server side) — Hypixel Forums](https://hypixel.net/threads/autoclicker-detection-tutorial-server-side.5483042/)

**Physique & mecaniques du jeu (Minecraft Wiki + analyses)**
- [Walking — Minecraft Wiki (4.317 b/s, attribute 0.1, slipperiness)](https://minecraft.wiki/w/Walking)
- [Sprinting — Minecraft Wiki (5.612 b/s, sprint-jump 7.127 b/s)](https://minecraft.wiki/w/Sprinting)
- [Minecraft Physics: Steve in Drag (gravite 0.08, drag 0.98, friction 0.91)](https://blog.benw.xyz/2014/01/minecraft-physics-steve-in-drag/)
- [TrueCraft Wiki — Entity Movement and Physics (jump 0.42)](https://github.com/ddevault/TrueCraft/wiki/Entity-Movement-And-Physics)
- [Minecraft Parkour Wiki — Horizontal Movement Formulas](https://www.mcpk.wiki/wiki/Horizontal_Movement_Formulas)
- [Melee attack — Minecraft Wiki (cooldown, 84.8 %, formule 0.2+0.8p², reach, sweep)](https://minecraft.wiki/w/Melee_attack)
- [Damage — Minecraft Wiki (crit ×1.5)](https://minecraft.wiki/w/Damage)
- [Mace — Minecraft Wiki](https://minecraft.wiki/w/Mace)
- [Calculators/Mace damage — Minecraft Wiki](https://minecraft.wiki/w/Calculators/Mace_damage)
- [Attack reach / Interaction range — Minecraft Wiki](https://minecraft.wiki/w/Interaction_range)
- [Shield — Minecraft Wiki](https://minecraft.wiki/w/Shield)
- [Blocking — Minecraft Wiki](https://minecraft.wiki/w/Blocking)
- [Totem of Undying — Minecraft Wiki](https://minecraft.wiki/w/Totem_of_Undying)
- [Enchanted Golden Apple — Minecraft Wiki](https://minecraft.wiki/w/Enchanted_Golden_Apple)
- [Ender Pearl — Minecraft Wiki](https://minecraft.wiki/w/Ender_Pearl)
- [Armor — Minecraft Wiki](https://minecraft.wiki/w/Armor)
- [Projectile Protection — Minecraft Wiki](https://minecraft.wiki/w/Projectile_Protection)

**Cheats (signatures / reference)**
- [KillauraLegit — Wurst Wiki](https://wurst.wiki/killauralegit)
- [AutoTotem — Wurst Wiki](https://wurst.wiki/autototem)
- [Autototem mod — Modrinth](https://modrinth.com/mod/autototem)
- [Baritone pathfinding (A*) — DeepWiki](https://deepwiki.com/cabaletta/baritone/4-pathfinding-system)
- [Does this look like someone who used X-Ray? — Minecraft Forum](https://www.minecraftforum.net/forums/minecraft-java-edition/discussion/2775935-does-this-look-like-someone-who-used-x-ray)

**Comportement humain (reaction / visee / chat)**
- [What is the average human reaction time? — Human Benchmark](https://humanbenchmark.now/cognitive-tests-faq/what-is-the-average-human-reaction-time/)
- [Reaction time distributions: an interactive overview (ex-gaussian, σ∝mean)](https://lindeloev.github.io/shiny-rt/)
- [Speed/accuracy trade-offs in target-directed movements (Fitts) — Lehigh CSE](https://www.cse.lehigh.edu/prr/Biometrics/Archive/Papers/SpeedAccuracy.pdf)
- [Emulating Human-Like Mouse Movement Using Bezier Curves (overshoot, micro-jitter)](https://ijirt.org/publishedpaper/IJIRT183343_PAPER.pdf)
- [Aim Low, Shoot High: Evading Aimbot Detectors by Mimicking User Behavior (arXiv 2004.12183)](https://arxiv.org/pdf/2004.12183)
- [Auto Clicker Speed Test — Bot Detection (CPS humain vs auto-clicker)](https://cpsmeter.com/auto-clicker-speed-test/)
- [Springer — Opposing Effects of Response Time in Human–Chatbot Interaction](https://link.springer.com/article/10.1007/s12599-022-00755-x)
- [humanornot.so — How AI Gives Itself Away in Conversation](https://humanornot.so/blog/human-or-bot-ai-conversation-patterns)
- [TypingTest — What is a good typing speed for a gamer?](https://typingtest.now/faq/typing-speed-for-gamers/)
- [Viber — Text Message Response Times](https://www.viber.com/en/blog/2017-11-06/text-message-response-times/)
- [Oxford JCMC — Interactivity in Online Chat: Response Latency](https://academic.oup.com/jcmc/article/23/4/201/5033037)
- [AndroidPolice — 8 telltale signs you're chatting with an AI chatbot](https://www.androidpolice.com/chatting-with-ai-chatbot-clues/)
- [Planet Minecraft — Minecraft Slang Terms](https://www.planetminecraft.com/blog/minecraft-slang-terms/)
- [Minecraft Wiki — Tutorial:Glossary](https://minecraft.wiki/w/Tutorial:Glossary)

**Structures & navigation**
- [Structure — Minecraft Wiki](https://minecraft.wiki/w/Structure)
- [Trial Chambers — Minecraft Wiki](https://minecraft.wiki/w/Trial_Chambers)
- [Stronghold — Minecraft Wiki](https://minecraft.wiki/w/Stronghold)
- [Ancient City — Minecraft Wiki](https://minecraft.wiki/w/Ancient_City)
- [Woodland Mansion — Minecraft Wiki](https://minecraft.wiki/w/Woodland_Mansion)
- [mineflayer-pathfinder Issue #39 — Long Distance Travel System](https://github.com/PrismarineJS/mineflayer-pathfinder/issues/39)
- [mineflayer-pathfinder Issue #222 — hangs on unbreakable block](https://github.com/PrismarineJS/mineflayer-pathfinder/issues/222)
- [mineflayer Issue #1123 — chunks don't unload / memory leak](https://github.com/PrismarineJS/mineflayer/issues/1123)
- [mineflayer-pathfinder — GitHub](https://github.com/PrismarineJS/mineflayer-pathfinder)

**Fermes & commerce**
- [Iron Golem — Minecraft Wiki (spawning, drops, HP)](https://minecraft.wiki/w/Iron_Golem)
- [Tutorial:Crop farming — Minecraft Wiki](https://minecraft.wiki/w/Tutorial:Crop_farming)
- [Tutorial:Zombified Piglin farming — Minecraft Wiki](https://minecraft.wiki/w/Tutorial:Zombified_Piglin_farming)
- [Tutorial:Mob farm — Minecraft Wiki (spawn radius, no-redstone)](https://minecraft.wiki/w/Tutorial:Mob_farm)
- [Tutorials/Iron golem farming — Minecraft Fandom (panic/8-block, rates)](https://minecraft.fandom.com/wiki/Tutorials/Iron_golem_farming)
- [Trading — Minecraft Wiki](https://minecraft.wiki/w/Trading)
- [Villager — Minecraft Wiki](https://minecraft.wiki/w/Villager)
- [Tutorials/Curing a zombie villager — Minecraft Fandom](https://minecraft.fandom.com/wiki/Tutorials/Curing_a_zombie_villager)

**Mineflayer combat API & humanisation**
- [mineflayer-pvp — docs/api.md (PrismarineJS)](https://github.com/PrismarineJS/mineflayer-pvp/blob/master/docs/api.md)
- [mineflayer-pvp — README](https://github.com/PrismarineJS/mineflayer-pvp/blob/master/README.md)
- [mineflayer-pvp Issue #9 — Add jumping when attacking (crit non implemente)](https://github.com/PrismarineJS/mineflayer-pvp/issues/9)
- [mineflayer Issue #791 — bot.attack ne fait pas les degats pleins (cooldown)](https://github.com/PrismarineJS/mineflayer/issues/791)
- [@nxg-org/mineflayer-custom-pvp (npm)](https://www.npmjs.com/package/@nxg-org/mineflayer-custom-pvp)
- [@nxg-org/mineflayer-smooth-look (npm)](https://www.npmjs.com/package/@nxg-org/mineflayer-smooth-look)
- [PrismarineJS/mineflayer — GitHub](https://github.com/prismarinejs/mineflayer)
- [mineflayer-anticheat (fork bypass) — aesthetic0001](https://github.com/aesthetic0001/mineflayer-anticheat)
