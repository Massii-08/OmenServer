#!/bin/bash
# OmenServer Agent Auto-Setup Script

if [ -z "$1" ]; then
    echo "❌ Erreur: Il manque la clé API."
    echo "Usage: curl -sL https://raw.githubusercontent.com/Massii-08/OmenServer/main/tools/setup_omen_agent.sh | sudo bash -s -- TA_CLE_API"
    exit 1
fi

API_KEY="$1"
USER_NAME=${SUDO_USER:-$USER}
USER_HOME=$(eval echo ~$USER_NAME)

echo "🚀 Installation de l'agent OmenServer pour l'utilisateur $USER_NAME..."

# 1. Dépendances
echo "📦 Installation des dépendances..."
apt update && apt install -y python3 python3-pip curl
sudo -u $USER_NAME pip3 install psutil requests --break-system-packages 2>/dev/null || sudo -u $USER_NAME pip3 install psutil requests

# 2. Téléchargement de l'agent
echo "📥 Téléchargement de l'agent..."
curl -sL -o $USER_HOME/omen_agent.py https://raw.githubusercontent.com/Massii-08/OmenServer/main/tools/omen_agent.py
chown $USER_NAME:$USER_NAME $USER_HOME/omen_agent.py

# 3. Configuration de la clé API
echo "🔑 Configuration de la clé API..."
sed -i "s/API_KEY = .*/API_KEY = \"$API_KEY\"/" $USER_HOME/omen_agent.py

# 4. Autoriser reboot/shutdown sans mot de passe
echo "🛡️ Configuration des permissions sudo..."
echo "$USER_NAME ALL=(ALL) NOPASSWD: /sbin/reboot, /sbin/shutdown" > /etc/sudoers.d/omen-agent
chmod 0440 /etc/sudoers.d/omen-agent

# 5. Service Systemd
echo "⚙️ Création du service en arrière-plan..."
cat << SERVICE > /etc/systemd/system/omen-agent.service
[Unit]
Description=OmenServer Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER_NAME
ExecStart=/usr/bin/python3 $USER_HOME/omen_agent.py
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable omen-agent
systemctl restart omen-agent

# 6. Configuration du capot (Lid Switch)
echo "💻 Configuration du capot (ordinateur portable)..."
sed -i 's/#HandleLidSwitch=suspend/HandleLidSwitch=ignore/' /etc/systemd/logind.conf
sed -i 's/#HandleLidSwitchExternalPower=suspend/HandleLidSwitchExternalPower=ignore/' /etc/systemd/logind.conf
systemctl restart systemd-logind

# 7. Horaires de réveil/extinction (Cron)
echo "⏰ Configuration des horaires (Extinction 1h, Allumage 6h)..."
crontab -l 2>/dev/null | grep -v 'rtcwake' > /tmp/current_cron
echo '0 1 * * * /usr/sbin/rtcwake -m off -l -t $(date -d "tomorrow 06:00" +\%s)' >> /tmp/current_cron
crontab /tmp/current_cron
rm /tmp/current_cron

echo "✅ Terminé ! L'agent tourne et le PC est configuré."
echo "👉 Vérifie sur le dashboard: https://omenserver.org"
