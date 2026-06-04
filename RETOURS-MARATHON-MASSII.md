# 🔴 Retours live de Massii — session MARATHON (append-only, PRIORITÉ)

> Massii regarde le bot marathon tourner EN DIRECT. Applique les retours non encore traités SANS
> t'arrêter (intègre-les dans la boucle test→améliore). Relis ce fichier à CHAQUE itération.
> Le + récent en bas. Marque `[traité]` une fois intégré + testé + commité.

## 2026-06-04 ~12:15 — Réserves AVANT descente : viser GROS, pas « pas vide »

**Constat de Massii (en observant le bot en jeu)** : avant de descendre en cave/mine, le bot doit
emporter **BEAUCOUP** de nourriture ET de ressources de surface (bois surtout) — assez pour
(a) tenir une **LONGUE** session sous terre sans remonter, et (b) **se refabriquer plusieurs outils
en bas** depuis sa réserve. Le bois n'est PAS en cave : une fois en profondeur sans bois → plus de
bâtons → plus de pioche de rechange → bloqué / remontées incessantes.

**Ce qui existe déjà (NE PAS refaire)** : P8 gate déjà la descente sur un restock food+bois. Le
problème n'est PAS l'absence de gate — c'est que les **SEUILS sont trop bas** (« pas vide » au lieu
de « beaucoup »), et qu'il n'y a pas de **réparation/recraft d'outil sous terre**.

**À faire (refinement, pas de refonte)** :
1. **Monter FORTEMENT les seuils « prêt à descendre »** (le gate de descente exige tout ça AVANT de
   creuser) :
   - **Nourriture cuite** : grosse réserve (≥ ~16, viser vers un stack) → ne PAS remonter pour la
     faim pendant une longue session de minage.
   - **Bois** : ≥ ~1 stack de bûches (ou planches équivalentes) → de quoi : table de craft + beaucoup
     de bâtons + **plusieurs reconstructions de pioche** + torches.
   - **Torches** : bonne réserve (≥ ~1 stack) pour éclairer un long branch-mine en sécurité.
   - **Pioches de secours** : pré-crafter ≥2-3 (fer/diamant) AVANT de descendre.
2. **Recraft SOUS TERRE** : le bot garde **table + bois + cobble** en poche → quand une pioche casse
   en bas, il **recrafte sur place** depuis sa réserve (zéro remontée). C'est tout l'intérêt
   d'emporter beaucoup de bois.
3. **Gate strict** : si UNE de ces réserves est sous le seuil → **supply run de surface D'ABORD**
   (récolte bois en masse, chasse+cuit la nourriture, crafte spares+torches), puis descente seulement
   une fois **PLEINEMENT** chargé.
4. **Philosophie** (l'intention de Massii) : **un gros chargement initial > beaucoup d'allers-retours**.
   Chaque remontée est longue et dangereuse → on minimise en partant lourd.

**Critère de validation (live)** : un run où le bot descend AVEC une grosse réserve, mine longtemps,
**casse une pioche en bas et en recrafte une SANS remonter**, et ne remonte que rarement (réserve
réellement épuisée). + test offline des seuils (gate) et du recraft souterrain.
