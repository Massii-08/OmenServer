# OmenCapture — mod de capture consentie (Phase 1b.1)

Enregistre tes inputs/déplacements/chat en jeu pour l'entraînement de la modération OmenServer.
**Consentement** : OFF au lancement (`REC-off`). **F8** démarre/arrête (`● REC` rouge à l'écran).
Rien n'est envoyé automatiquement — le fichier reste local, tu l'uploades via le dashboard.

## Build (machine de dev, Java 21)

    cd mc-capture-mod
    ./gradlew build

Le jar est dans `build/libs/mc-capture-<version>.jar`.

> Si `./gradlew` n'existe pas (wrapper non commité), génère-le une fois avec un Gradle ≥ 8.10 :
> `gradle wrapper --gradle-version 8.12` puis `./gradlew build`.

### Tester juste la logique pure (sans télécharger Fabric/MC)

Les classes `SessionWriter` / `Recorder` / `TickRecord` n'ont **aucune** dépendance Minecraft.
On peut les tester avec le seul JDK + le jar JUnit console standalone :

    javac -cp junit-console.jar -d out \
      src/main/java/org/omen/capture/*.java src/test/java/org/omen/capture/*.java
    java -jar junit-console.jar execute -cp out --scan-classpath

## Install (client du joueur)

1. Installer **Fabric Loader** pour la version MC qui correspond (https://fabricmc.net/use/installer/).
2. Installer **Fabric API** (jar) dans `.minecraft/mods/`.
3. Copier `mc-capture-<version>.jar` dans `.minecraft/mods/`.
4. Lancer MC avec le profil Fabric → en jeu, **F8** pour enregistrer.
5. Les captures sont dans `.minecraft/mc-capture/session-*.jsonl`.
6. Uploader le fichier dans le dashboard → MC Agent → Captures.

## Multi-version

Le mod n'a aucun code Minecraft-version-specific (APIs Fabric/MC ultra-stables :
`KeyBindingHelper`, `ClientTickEvents`, `player.getX()`, etc.). On builde donc le MÊME
code source pour N versions Fabric, en changeant juste `gradle.properties` à chaque pass.

### Builder toutes les versions d'un coup

    ./build-all-versions.sh                # builde toute la matrice (7 versions)
    ./build-all-versions.sh 1.21.1         # builde une seule version
    ./build-all-versions.sh 1.20.1 1.21    # builde plusieurs versions ciblées

Le script restaure `gradle.properties` à la fin (trap EXIT) et liste les jars produits.
Les builds déjà présents dans `dist/` sont skippés (supprimer le jar pour rebuild).

### Matrice des versions supportées (juin 2026)

| MC version | Java | yarn_mappings   | loader  | fabric_version  |
|-----------:|:----:|:----------------|:--------|:----------------|
| 1.20.1     | 17   | 1.20.1+build.10 | 0.16.10 | 0.92.6+1.20.1   |
| 1.20.4     | 17   | 1.20.4+build.3  | 0.16.10 | 0.97.8+1.20.4   |
| 1.20.6     | 21   | 1.20.6+build.3  | 0.16.10 | 0.100.8+1.20.6  |
| 1.21       | 21   | 1.21+build.9    | 0.16.10 | 0.102.0+1.21    |
| 1.21.1     | 21   | 1.21.1+build.3  | 0.16.10 | 0.115.5+1.21.1  |
| 1.21.4     | 21   | 1.21.4+build.8  | 0.16.10 | 0.119.4+1.21.4  |
| 1.21.5     | 21   | 1.21.5+build.1  | 0.16.10 | 0.124.0+1.21.5  |

Pour ajouter une version : éditer `VERSION_MATRIX` dans `build-all-versions.sh` ET
ajouter l'entrée dans `_MOD_JARS` (`backend/bots/mc_capture_router.py`). Les valeurs
exactes (yarn build, fabric-api) sont sur https://fabricmc.net/develop. Si un build
échoue avec "Could not resolve dependency", c'est qu'une de ces valeurs a bougé.

### Builder une seule version (manuel)

Si tu veux pinner le `gradle.properties` sur une version pour du dev IDE :

    # 1.20.1 (Java 17)
    sed -i '' \
      -e 's/^minecraft_version=.*/minecraft_version=1.20.1/' \
      -e 's/^yarn_mappings=.*/yarn_mappings=1.20.1+build.10/' \
      -e 's/^fabric_version=.*/fabric_version=0.92.6+1.20.1/' \
      gradle.properties
    ./gradlew build -Pjava_version=17

(sur Linux, retirer le `''` après `-i`)
