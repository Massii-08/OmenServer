#!/bin/bash
# OmenServer — Script de reprise après suspend/hibernate
# Placé dans /etc/systemd/system-sleep/ pour exécution automatique
# $1 = "pre" ou "post", $2 = "suspend"/"hibernate"/etc.

case "$1" in
    post)
        logger -t omen-resume "System resumed from suspend - restarting services..."

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
        ;;
esac
