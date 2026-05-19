#!/bin/bash
# OmenServer — Script de reboot après réveil (suspend-to-RAM)
# Déclenché par omen-resume.service via systemd
#
# Ce script force un reboot complet après chaque réveil pour :
# - Vider la RAM (garbage accumulé)
# - Relancer proprement tous les services
# - Obtenir un uptime frais
#
# Protection anti-boucle :
# - Un flag /var/tmp/omen-wake-reboot marque qu'on vient de rebooter
# - Le flag est posé AVANT le reboot et effacé au prochain cycle suspend
# - /var/tmp (pas /tmp) persiste entre les reboots sur Ubuntu 26.04

REBOOT_FLAG="/var/tmp/omen-wake-reboot"
LOG_TAG="omen-resume"

logger -t "$LOG_TAG" "=== Post-wake hook triggered ==="

# Si le flag existe → on vient DÉJÀ d'un reboot post-wake
# Ne PAS reboucler ! Juste redémarrer les services.
if [ -f "$REBOOT_FLAG" ]; then
    logger -t "$LOG_TAG" "Flag found — this is a post-reboot boot. Restarting services only."
    rm -f "$REBOOT_FLAG"
    
    # Attendre que le réseau soit up
    sleep 10
    
    # Redémarrer cloudflared pour reconnecter le tunnel Cloudflare
    systemctl restart cloudflared.service 2>/dev/null
    logger -t "$LOG_TAG" "cloudflared restarted"
    
    # Attendre que cloudflared soit connecté
    sleep 5
    
    # Redémarrer omenserver pour reset le scheduler
    systemctl restart omenserver.service 2>/dev/null
    logger -t "$LOG_TAG" "omenserver restarted — all services up ✅"
    exit 0
fi

# Pas de flag → on revient d'un vrai suspend → REBOOT !
logger -t "$LOG_TAG" "No flag — woke from suspend. Initiating full reboot for fresh start (RAM clear)."

# Poser le flag AVANT le reboot (il survivra car /var/tmp persiste)
touch "$REBOOT_FLAG"

# Petit délai pour laisser le système se stabiliser
sleep 5

logger -t "$LOG_TAG" "Rebooting NOW..."
/usr/sbin/reboot
