#!/bin/bash
# ⚠️  DEPRECATED — Ce script ne fonctionne PAS sur Ubuntu 26.04+
# 
# Raison : systemd-sleep ne supporte plus les scripts shell dans
#          /etc/systemd/system-sleep/ sur les versions récentes de systemd.
#
# REMPLACÉ PAR :
#   - /usr/local/bin/omen-post-wake.sh  (le nouveau script)
#   - /etc/systemd/system/omen-resume.service (le service systemd)
#
# Le nouveau système utilise un service systemd qui se déclenche via
# WantedBy=suspend.target, ce qui est la méthode officielle et fiable.
#
# Voir : tools/omen-post-wake.sh + tools/omen-resume.service
#
# Ce fichier est conservé uniquement comme référence historique.
# NE PAS installer dans /etc/systemd/system-sleep/

echo "⚠️  Ce script est deprecated. Utilisez omen-resume.service."
exit 1
