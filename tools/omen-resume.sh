#!/bin/bash
# OmenServer — Script de reprise après suspend/hibernate
# Placé dans /etc/systemd/system-sleep/ pour exécution automatique
# $1 = "pre" ou "post", $2 = "suspend"/"hibernate"/etc.
#
# Après un réveil (suspend), le script déclenche un reboot complet
# pour vider la RAM et repartir frais. Un fichier flag empêche
# les boucles de reboot infinies.

REBOOT_FLAG="/tmp/omen-post-suspend-reboot"

case "$1" in
    pre)
        # Avant le suspend : poser le flag pour savoir qu'on revient d'un suspend
        if [ "$2" = "suspend" ] || [ "$2" = "hibernate" ]; then
            touch "$REBOOT_FLAG"
            logger -t omen-resume "Pre-suspend: flag set for post-wake reboot"
        fi
        ;;
    post)
        logger -t omen-resume "System resumed from $2"

        # Vérifier si on revient d'un suspend (flag présent)
        if [ -f "$REBOOT_FLAG" ]; then
            rm -f "$REBOOT_FLAG"
            logger -t omen-resume "Post-suspend: initiating full reboot for fresh start (RAM clear)"

            # Petit délai pour laisser le système se stabiliser
            sleep 5

            # Reboot complet → RAM vidée, tous les services relancés proprement
            /usr/sbin/reboot
        else
            # Pas de flag = on revient d'un reboot normal, juste relancer les services
            logger -t omen-resume "Post-reboot: restarting services..."

            # Attendre que le réseau soit up
            sleep 10

            # Redémarrer cloudflared pour reconnecter le tunnel Cloudflare
            systemctl restart cloudflared.service
            logger -t omen-resume "cloudflared restarted"

            # Attendre que cloudflared soit connecté
            sleep 5

            # Redémarrer omenserver pour reset le scheduler (évite les jobs missed)
            systemctl restart omenserver.service
            logger -t omen-resume "omenserver restarted - all services up"
        fi
        ;;
esac
