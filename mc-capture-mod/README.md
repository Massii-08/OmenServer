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

Cible validée : **1.21.x** (épinglée dans `gradle.properties` : MC 1.21.4, yarn `1.21.4+build.8`,
loader `0.16.10`, fabric-api `0.119.4+1.21.4`, loom `1.9.2`). Pour 1.20.x : changer
`minecraft_version` / `yarn_mappings` / `loader_version` / `fabric_version` (voir https://fabricmc.net/develop)
et rebuild.
