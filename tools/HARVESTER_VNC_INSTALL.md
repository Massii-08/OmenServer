# Install vue live CAPTCHA (x11vnc) — one-shot sur l'Omen

Prérequis : Xvfb `:100` déjà actif (le harvester stealth tourne dessus). Le service
omenserver hérite déjà de `DISPLAY=:100`.

1. Installer x11vnc :
   ```bash
   sudo apt-get update && sudo apt-get install -y x11vnc
   ```

2. Adapter l'unit : remplacer `<OMEN_USER>` par le user du service omenserver
   (vérifier avec `systemctl show -p User omenserver.service`), puis :
   ```bash
   sudo cp ~/Projet\ serveur/tools/omen-harvester-vnc.service \
           /etc/systemd/system/omen-harvester-vnc.service
   sudo sed -i 's/<OMEN_USER>/<le_user_reel>/g' \
           /etc/systemd/system/omen-harvester-vnc.service
   sudo systemctl daemon-reload
   sudo systemctl enable --now omen-harvester-vnc.service
   ```

3. Vérifier :
   ```bash
   systemctl status omen-harvester-vnc.service
   ls -l /run/omen-harvester-vnc/vnc.sock     # doit exister, owner = OMEN_USER
   ```

Sécurité : aucun port TCP ouvert (socket Unix only). Accès gouverné par les perms
du socket (user omenserver) + le JWT admin du bridge `/api/bots/harvester/vnc/`.
Le bridge refuse toute connexion hors d'un job en `awaiting_solve`.

Override possible du chemin via `HARVESTER_VNC_SOCK` (env du service omenserver).
