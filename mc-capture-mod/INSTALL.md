# Installer OmenCapture — guide REC-testeur

OmenCapture enregistre TES déplacements, clics et messages en jeu, pour entraîner l'équipe
de modération d'OmenServer à reconnaître les bots. **Tu contrôles tout** : rien n'est enregistré
sans que tu appuies sur la touche, et rien n'est envoyé sans que tu uploades le fichier toi-même.

## 1. Quelle version ?

Regarde la version de ton Minecraft (écran d'accueil, en bas à gauche) :
- **1.21.x** → prends `mc-capture-0.1.0-mc1.21.4.jar`
- **1.20.x** → prends `mc-capture-0.1.0-mc1.20.1.jar`

Les deux se téléchargent depuis le dashboard (Bots → MC Agent → Télécharger le mod).

## 2. Installer Fabric Loader (une seule fois)

1. Va sur **https://fabricmc.net/use/installer/** et télécharge l'installeur.
2. Lance-le. Onglet **« Client »** :
   - **Game Version** : choisis ta version (1.21.x ou 1.20.x).
   - Laisse **Loader Version** par défaut.
   - Coche **« Create profile »**.
3. Clique **Install**.
4. Au lancement du launcher Minecraft, choisis le profil **« fabric-loader-… »** en bas à gauche.

## 3. Installer Fabric API + OmenCapture

1. Ouvre le dossier `mods` de Minecraft :
   - **Windows** : touche Windows + R → tape `%appdata%\.minecraft\mods` → Entrée (crée le dossier `mods` s'il n'existe pas).
   - **macOS** : Finder → Aller → Aller au dossier… → `~/Library/Application Support/minecraft/mods`.
2. Télécharge **Fabric API** pour ta version sur https://modrinth.com/mod/fabric-api → mets le `.jar` dans `mods`.
3. Mets aussi **`mc-capture-….jar`** (téléchargé au point 1) dans `mods`.

## 4. Enregistrer

1. Lance Minecraft avec le profil Fabric, rejoins le serveur.
2. En haut à gauche tu vois **`REC-off`** (gris) → rien n'est enregistré.
3. Appuie sur **F8** → un message de consentement s'affiche, puis **`● REC`** (rouge) → ça enregistre.
4. Joue normalement.
5. Appuie sur **F8** pour arrêter (`REC-off` revient).
6. Ton fichier est dans le dossier `mc-capture` de Minecraft (à côté de `mods`), nommé `session-….jsonl`.

## 5. Déposer ta capture

Dashboard → **Bots → MC Agent → Mes captures → Importer** → choisis ton `session-….jsonl`.
C'est tout. Tu peux en déposer autant que tu veux. L'admin te dira quand il les récupère.

> Changer la touche F8 : Échap → Options → Commandes → cherche « OmenCapture ».
