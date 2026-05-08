#!/bin/bash
# ============================================================
# OmenServer — Script d'installation automatique pour Linux
#
# Usage :
#   sudo bash tools/setup_omen.sh
#
# Ce script fait tout automatiquement :
#   1. Detecte l'utilisateur et les chemins
#   2. Cree le fichier .env si necessaire
#   3. Cree un script de lancement (evite les problemes d'espaces)
#   4. Installe les services systemd
#   5. Configure sudo sans mot de passe (rtcwake, shutdown, reboot)
#   6. Active et demarre OmenServer
#   7. Verifie que tout marche
# ============================================================

set -e

# === Couleurs pour les messages ===
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_ok()   { echo -e "${GREEN}[OK]${NC} $1"; }
log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_err()  { echo -e "${RED}[ERREUR]${NC} $1"; }

# === Verification: doit etre lance avec sudo ===
if [ "$EUID" -ne 0 ]; then
    log_err "Ce script doit etre lance avec sudo !"
    echo "Usage : sudo bash tools/setup_omen.sh"
    exit 1
fi

# === Detection de l'utilisateur reel (pas root) ===
REAL_USER="${SUDO_USER:-$USER}"
if [ "$REAL_USER" = "root" ]; then
    log_err "Ne lance pas ce script en tant que root directement."
    echo "Usage : sudo bash tools/setup_omen.sh"
    exit 1
fi
REAL_HOME=$(eval echo "~$REAL_USER")

# === Detection du dossier du projet ===
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Verifier que c'est bien le bon dossier
if [ ! -f "$PROJECT_DIR/requirements.txt" ]; then
    log_err "Impossible de trouver le projet OmenServer !"
    log_err "Dossier detecte : $PROJECT_DIR"
    exit 1
fi

VENV_PYTHON="$PROJECT_DIR/venv/bin/python"

echo ""
echo "========================================"
echo "   OmenServer — Installation Linux"
echo "========================================"
echo ""
log_info "Utilisateur : $REAL_USER"
log_info "Home        : $REAL_HOME"
log_info "Projet      : $PROJECT_DIR"
log_info "Python      : $VENV_PYTHON"
echo ""

# === Etape 1 : Verifier le venv Python ===
echo "--- Etape 1/7 : Verification Python ---"
if [ ! -f "$VENV_PYTHON" ]; then
    log_err "Le virtualenv Python n'existe pas !"
    log_err "Lance d'abord : python3 -m venv venv && source venv/bin/activate && pip install -r requirements.txt"
    exit 1
fi
log_ok "Virtualenv Python trouve"

# === Etape 2 : Creer le .env si necessaire ===
echo ""
echo "--- Etape 2/7 : Configuration .env ---"
if [ ! -f "$PROJECT_DIR/.env" ]; then
    if [ -f "$PROJECT_DIR/.env.example" ]; then
        cp "$PROJECT_DIR/.env.example" "$PROJECT_DIR/.env"
        # Generer une cle secrete aleatoire
        SECRET_KEY=$("$VENV_PYTHON" -c "import secrets; print(secrets.token_hex(32))")
        sed -i "s/change-moi-en-production-stp/$SECRET_KEY/" "$PROJECT_DIR/.env"
        chown "$REAL_USER:$REAL_USER" "$PROJECT_DIR/.env"
        log_ok "Fichier .env cree avec cle secrete generee"
    else
        log_err "Fichier .env.example introuvable !"
        exit 1
    fi
else
    log_ok "Fichier .env deja present"
fi

# === Etape 3 : Creer les scripts de lancement ===
# (systemd ne supporte pas les espaces dans les chemins ExecStart)
echo ""
echo "--- Etape 3/7 : Scripts de lancement ---"

# Script de lancement principal
LAUNCHER="/usr/local/bin/omenserver-start"
cat > "$LAUNCHER" << SCRIPT
#!/bin/bash
cd "$PROJECT_DIR"
exec "$VENV_PYTHON" -m uvicorn backend.main:app --host 0.0.0.0 --port 8000
SCRIPT
chmod +x "$LAUNCHER"
log_ok "Script de lancement cree : $LAUNCHER"

# Script watchdog
WATCHDOG_LAUNCHER="/usr/local/bin/omenserver-watchdog"
cat > "$WATCHDOG_LAUNCHER" << SCRIPT
#!/bin/bash
exec /bin/bash "$PROJECT_DIR/watchdog.sh"
SCRIPT
chmod +x "$WATCHDOG_LAUNCHER"
log_ok "Script watchdog cree : $WATCHDOG_LAUNCHER"

# Script cloudflared (si present)
if [ -f "$PROJECT_DIR/cloudflared" ]; then
    TUNNEL_LAUNCHER="/usr/local/bin/omenserver-tunnel"
    cat > "$TUNNEL_LAUNCHER" << SCRIPT
#!/bin/bash
exec "$PROJECT_DIR/cloudflared" tunnel run
SCRIPT
    chmod +x "$TUNNEL_LAUNCHER"
    log_ok "Script tunnel cree : $TUNNEL_LAUNCHER"
fi

# === Etape 4 : Creer les services systemd ===
echo ""
echo "--- Etape 4/7 : Services systemd ---"

# Arreter les anciens services si ils tournent
systemctl stop omenserver 2>/dev/null || true
systemctl stop omenserver-watchdog 2>/dev/null || true
systemctl stop cloudflared-tunnel 2>/dev/null || true

# Service OmenServer principal
cat > /etc/systemd/system/omenserver.service << EOF
[Unit]
Description=OmenServer Backend
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=$REAL_USER
WorkingDirectory=$REAL_HOME
ExecStart=/usr/local/bin/omenserver-start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
log_ok "Service omenserver.service cree"

# Service Watchdog
cat > /etc/systemd/system/omenserver-watchdog.service << EOF
[Unit]
Description=OmenServer Watchdog
After=omenserver.service

[Service]
Type=simple
User=$REAL_USER
ExecStart=/usr/local/bin/omenserver-watchdog
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF
log_ok "Service omenserver-watchdog.service cree"

# Service Cloudflared (optionnel, pour plus tard)
if [ -f "$PROJECT_DIR/cloudflared" ]; then
    cat > /etc/systemd/system/cloudflared-tunnel.service << EOF
[Unit]
Description=Cloudflare Tunnel for OmenServer
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$REAL_USER
ExecStart=/usr/local/bin/omenserver-tunnel
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF
    log_ok "Service cloudflared-tunnel.service cree"
else
    log_warn "cloudflared non trouve, service tunnel non cree"
fi

# === Etape 5 : Mettre a jour watchdog.sh avec les bons chemins ===
echo ""
echo "--- Etape 5/7 : Mise a jour watchdog.sh ---"
if [ -f "$PROJECT_DIR/watchdog.sh" ]; then
    sed -i "s|PROJECT_DIR=.*|PROJECT_DIR=\"$PROJECT_DIR\"|" "$PROJECT_DIR/watchdog.sh"
    sed -i "s|CLOUDFLARED_BIN=.*|CLOUDFLARED_BIN=\"\$PROJECT_DIR/cloudflared\"|" "$PROJECT_DIR/watchdog.sh"
    chmod +x "$PROJECT_DIR/watchdog.sh"
    log_ok "watchdog.sh mis a jour avec les chemins Linux"
else
    log_warn "watchdog.sh non trouve"
fi

# === Etape 6 : Configurer sudo sans mot de passe ===
echo ""
echo "--- Etape 6/7 : Configuration sudo ---"
SUDOERS_FILE="/etc/sudoers.d/omenserver"
cat > "$SUDOERS_FILE" << EOF
# OmenServer — Permissions sudo sans mot de passe
# Pour l'extinction automatique et les commandes a distance
$REAL_USER ALL=(ALL) NOPASSWD: /usr/sbin/rtcwake
$REAL_USER ALL=(ALL) NOPASSWD: /sbin/shutdown
$REAL_USER ALL=(ALL) NOPASSWD: /sbin/reboot
$REAL_USER ALL=(ALL) NOPASSWD: /usr/sbin/shutdown
$REAL_USER ALL=(ALL) NOPASSWD: /usr/sbin/reboot
$REAL_USER ALL=(ALL) NOPASSWD: /usr/bin/rtcwake
$REAL_USER ALL=(ALL) NOPASSWD: /usr/bin/shutdown
$REAL_USER ALL=(ALL) NOPASSWD: /usr/bin/reboot
EOF
chmod 440 "$SUDOERS_FILE"
log_ok "Sudo configure pour rtcwake, shutdown, reboot"

# === Etape 7 : Activer et demarrer les services ===
echo ""
echo "--- Etape 7/7 : Demarrage des services ---"

# Recharger systemd
systemctl daemon-reload
log_ok "systemd recharge"

# Activer au demarrage
systemctl enable omenserver
log_ok "omenserver active au demarrage"

# Demarrer OmenServer
systemctl start omenserver
log_ok "omenserver demarre"

# Attendre que le serveur soit pret
echo ""
log_info "Attente du demarrage du serveur (10 secondes)..."
sleep 10

# === Verification finale ===
echo ""
echo "========================================"
echo "   Verification finale"
echo "========================================"
echo ""

# Verifier le service
if systemctl is-active --quiet omenserver; then
    log_ok "Service omenserver : ACTIF"
else
    log_err "Service omenserver : INACTIF"
    echo "Voir les logs : sudo journalctl -u omenserver -n 30"
fi

# Verifier l'API
HEALTH=$(curl -s http://localhost:8000/api/health 2>/dev/null || echo "ERREUR")
if echo "$HEALTH" | grep -q "ok"; then
    log_ok "API health check : OK"
else
    log_err "API health check : ECHEC ($HEALTH)"
    echo "Voir les logs : sudo journalctl -u omenserver -n 30"
fi

# Afficher l'IP locale
echo ""
echo "========================================"
echo "   Installation terminee !"
echo "========================================"
echo ""
IP_ADDR=$(hostname -I | awk '{print $1}')
log_ok "Panel accessible sur : http://$IP_ADDR:8000"
log_info "Cree ton compte admin en te connectant pour la premiere fois"
echo ""
log_info "Commandes utiles :"
echo "  sudo systemctl status omenserver      — Voir le statut"
echo "  sudo systemctl restart omenserver     — Redemarrer"
echo "  sudo journalctl -u omenserver -f      — Voir les logs en direct"
echo ""
