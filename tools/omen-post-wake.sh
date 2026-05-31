#!/bin/bash
# OmenServer — Script de reboot après réveil (suspend-to-RAM)
# Déclenché par omen-resume.service via systemd (WantedBy=suspend.target)
#
# Le service ne fire QU'AU WAKE FROM SUSPEND (pas au boot normal).
# Donc UNE SEULE invocation par cycle suspend→wake = un seul reboot.
# Pas de boucle infinie possible, pas besoin de logique anti-boucle.
#
# === Historique ===
# v3 (2026-05-31) — Simplifié : logique flag retirée.
#   Avant v3, le script utilisait un flag /var/tmp/omen-wake-reboot pour
#   détecter "post-reboot" et éviter une re-reboot. MAIS le service ne fire
#   pas au boot (WantedBy=suspend.target uniquement), donc la branche
#   "Flag found" était triggered au wake SUIVANT (1 jour plus tard) →
#   reboot tous les 2 jours seulement au lieu de chaque matin.
#   Le flag posé par le reboot survivait jusqu'au wake J+1 → skip reboot J+1
#   → reboot J+2 → flag reposé → skip J+3 → cycle dégénéré.
#
# v2 (2026-05-19) — Service systemd au lieu de hook system-sleep deprecated.
# v1 (~2026-05-15) — Hook /etc/systemd/system-sleep/ (deprecated Ubuntu 26.04+).

LOG_TAG="omen-resume"

logger -t "$LOG_TAG" "=== Post-wake hook triggered (v3 — always reboot) ==="
logger -t "$LOG_TAG" "Initiating full reboot for fresh start (RAM clear)."

# Cleanup défensif du vieux flag s'il traîne (héritage v2). N'a plus aucun rôle.
rm -f /var/tmp/omen-wake-reboot 2>/dev/null

# Petit délai pour laisser le système se stabiliser après le wake
sleep 5

logger -t "$LOG_TAG" "Rebooting NOW..."
/usr/sbin/reboot
