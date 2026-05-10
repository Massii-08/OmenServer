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

# 1. Étendre le disque principal (LVM)
echo "💾 Extension du disque principal..."
if lvs /dev/ubuntu-vg/ubuntu-lv >/dev/null 2>&1; then
    lvextend -l +100%FREE /dev/ubuntu-vg/ubuntu-lv
    resize2fs /dev/ubuntu-vg/ubuntu-lv
    echo "✅ Disque principal étendu au maximum."
else
    echo "ℹ️ Pas de partition LVM standard détectée, ignoré."
fi

# 2. Dépendances
echo "📦 Installation des dépendances..."
apt update && apt install -y python3 python3-pip curl parted
sudo -u $USER_NAME pip3 install psutil requests --break-system-packages 2>/dev/null || sudo -u $USER_NAME pip3 install psutil requests

# 3. Téléchargement de l'agent
echo "📥 Téléchargement de l'agent..."
curl -sL -o $USER_HOME/omen_agent.py https://raw.githubusercontent.com/Massii-08/OmenServer/main/tools/omen_agent.py
chown $USER_NAME:$USER_NAME $USER_HOME/omen_agent.py

# 4. Configuration de la clé API
echo "🔑 Configuration de la clé API..."
sed -i "s/API_KEY = .*/API_KEY = \"$API_KEY\"/" $USER_HOME/omen_agent.py

# 5. Autoriser reboot/shutdown sans mot de passe
echo "🛡️ Configuration des permissions sudo..."
echo "$USER_NAME ALL=(ALL) NOPASSWD: /sbin/reboot, /sbin/shutdown" > /etc/sudoers.d/omen-agent
chmod 0440 /etc/sudoers.d/omen-agent

# 6. Service Systemd
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

# 7. Configuration du capot (Lid Switch)
echo "💻 Configuration du capot (ordinateur portable)..."
sed -i 's/#HandleLidSwitch=suspend/HandleLidSwitch=ignore/' /etc/systemd/logind.conf
sed -i 's/#HandleLidSwitchExternalPower=suspend/HandleLidSwitchExternalPower=ignore/' /etc/systemd/logind.conf
systemctl restart systemd-logind

# 8. Horaires de réveil/extinction (Cron)
echo "⏰ Configuration des horaires (Extinction 1h, Allumage 6h)..."
crontab -l 2>/dev/null | grep -v 'rtcwake' > /tmp/current_cron
echo '0 1 * * * /usr/sbin/rtcwake -m off -l -t $(date -d "tomorrow 06:00" +\%s)' >> /tmp/current_cron
crontab /tmp/current_cron
rm /tmp/current_cron

echo ""
echo "✅ Terminé ! L'agent tourne et le PC est configuré."

# 9. Option de formatage d'un disque supplémentaire
echo ""
echo "⚠️  ATTENTION: As-tu un deuxième disque (SSD/HDD) que tu veux effacer et utiliser comme stockage ?"
echo "Toutes les données dessus seront DÉTRUITES."
read -p "Voulez-vous formater un disque supplémentaire ? (y/N): " format_disk < /dev/tty

if [[ "$format_disk" =~ ^[Yy]$ ]]; then
    echo "Disques disponibles :"
    lsblk -d -o NAME,SIZE,MODEL | grep -v "loop"
    read -p "Entrez le nom du disque à formater (ex: sdb ou nvme0n1) : " disk_name < /dev/tty
    
    if [ -b "/dev/$disk_name" ]; then
        echo "💣 FORMATAGE DE /dev/$disk_name EN COURS..."
        wipefs -a /dev/$disk_name
        parted /dev/$disk_name --script mklabel gpt mkpart primary ext4 0% 100%
        mkfs.ext4 -F -L "DataDisk" /dev/${disk_name}1 2>/dev/null || mkfs.ext4 -F -L "DataDisk" /dev/${disk_name}p1 2>/dev/null
        
        # Trouver la partition créée
        part="/dev/${disk_name}1"
        [ -b "/dev/${disk_name}p1" ] && part="/dev/${disk_name}p1"
        
        mkdir -p /mnt/data
        mount $part /mnt/data
        echo "UUID=$(blkid -s UUID -o value $part) /mnt/data ext4 defaults 0 2" >> /etc/fstab
        echo "✅ Disque formaté et monté sur /mnt/data !"
    else
        echo "❌ Disque /dev/$disk_name introuvable. Annulé."
    fi
fi

echo "👉 Vérifie sur le dashboard: https://omenserver.org"
