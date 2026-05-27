#!/usr/bin/env bash
# ============================================================================
# setup_macos.sh — Installation one-shot du Diagnostic Agent sur macOS
#
# Installe l'agent comme LaunchAgent macOS (équivalent du service Windows) :
#   - Auto-démarre au login
#   - Redémarre tout seul si crash
#   - Tourne en arrière-plan, pas de fenêtre Terminal qui reste ouverte
#   - Logs persistés dans logs/
#
# Usage :
#   ./setup_macos.sh         # install / reconfigure
#   ./setup_macos.sh start   # démarrer le service maintenant
#   ./setup_macos.sh stop    # arrêter le service
#   ./setup_macos.sh status  # voir si tourne + dernières logs
#   ./setup_macos.sh logs    # tail les logs en live
#   ./setup_macos.sh uninstall  # désinstaller complètement
# ============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

LABEL="org.omenserver.diagnostic-agent"
PLIST_PATH="$HOME/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="$SCRIPT_DIR/logs"
ENV_FILE="$SCRIPT_DIR/.env"

# --- Helpers ----------------------------------------------------------------

color()  { printf "\033[%sm%s\033[0m\n" "$1" "$2"; }
ok()     { color "32" "✅ $*"; }
warn()   { color "33" "⚠️  $*"; }
err()    { color "31" "❌ $*"; }
info()   { color "36" "ℹ️  $*"; }

ensure_python() {
    if ! command -v python3 >/dev/null 2>&1; then
        err "Python 3 introuvable. Install via : brew install python3"
        exit 1
    fi
    info "Python $(python3 --version) détecté"
}

ensure_venv() {
    if [ ! -d "venv" ]; then
        info "Création du venv local..."
        python3 -m venv venv
    fi
    info "Installation des dépendances..."
    ./venv/bin/pip install --quiet --upgrade pip
    ./venv/bin/pip install --quiet -r requirements.txt
    ok "Dépendances installées"
}

prompt_config() {
    echo
    color "1" "═══════ Configuration ═══════"
    echo
    echo "  1. Username OmenServer (sur prod c'est probablement Massii08)"
    echo "  2. URL hub WebSocket (laisse défaut pour la prod omenserver.org)"
    echo "  3. SECRET_KEY JWT (à récupérer depuis l'Omen — voir ci-dessous)"
    echo

    read -rp "Username OmenServer : " OMEN_USER
    if [ -z "$OMEN_USER" ]; then err "Username vide"; exit 1; fi

    read -rp "URL hub [wss://omenserver.org/ws/sysdoc] : " OMEN_HUB
    OMEN_HUB="${OMEN_HUB:-wss://omenserver.org/ws/sysdoc}"

    echo
    echo "Pour le SECRET_KEY, depuis ce terminal :"
    color "33" "  ssh massii08@<ip-omen> \"grep '^SECRET_KEY=' '/home/massii08/Projet serveur/.env' | cut -d= -f2-\""
    echo "  (IP de l'Omen visible dans le module Réseau d'omenserver.org)"
    echo
    read -rsp "SECRET_KEY : " OMEN_SECRET
    echo
    if [ -z "$OMEN_SECRET" ]; then err "SECRET_KEY vide"; exit 1; fi

    # Écrire .env (avec permissions strictes)
    cat > "$ENV_FILE" <<EOF
# Diagnostic Agent config — généré par setup_macos.sh
# NE PAS commiter (déjà dans .gitignore du repo OmenServer)
OMEN_AGENT_USERNAME=$OMEN_USER
OMEN_HUB_URL=$OMEN_HUB
OMEN_JWT_SECRET=$OMEN_SECRET
EOF
    chmod 600 "$ENV_FILE"
    ok "Config écrite dans .env (mode 600)"
}

generate_plist() {
    mkdir -p "$LOG_DIR"
    mkdir -p "$(dirname "$PLIST_PATH")"

    cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${SCRIPT_DIR}/venv/bin/python</string>
        <string>-u</string>
        <string>${SCRIPT_DIR}/main.py</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${SCRIPT_DIR}</string>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>

    <key>ThrottleInterval</key>
    <integer>10</integer>

    <key>StandardOutPath</key>
    <string>${LOG_DIR}/agent.log</string>

    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/agent.err.log</string>

    <key>ProcessType</key>
    <string>Background</string>
</dict>
</plist>
EOF
    ok "LaunchAgent plist écrit : $PLIST_PATH"
}

load_agent() {
    # Unload silencieux si déjà chargé (cas reconfiguration)
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
    launchctl load "$PLIST_PATH"
    sleep 1
    if launchctl list | grep -q "$LABEL"; then
        ok "Agent démarré et actif"
    else
        err "Échec du démarrage. Voir $LOG_DIR/agent.err.log"
        exit 1
    fi
}

show_status() {
    echo
    color "1" "═══════ État de l'agent ═══════"
    if launchctl list | grep -q "$LABEL"; then
        local pid status
        pid=$(launchctl list | grep "$LABEL" | awk '{print $1}')
        status=$(launchctl list | grep "$LABEL" | awk '{print $2}')
        if [ "$pid" = "-" ]; then
            warn "Chargé mais pas tourné (dernier exit status: $status)"
        else
            ok "RUNNING — PID $pid"
        fi
    else
        warn "Pas chargé (faut faire ./setup_macos.sh d'abord)"
    fi
    echo
    if [ -f "$LOG_DIR/agent.log" ]; then
        info "Dernières lignes du log :"
        tail -10 "$LOG_DIR/agent.log"
    fi
}

show_logs() {
    if [ ! -f "$LOG_DIR/agent.log" ]; then
        warn "Pas de log encore — l'agent n'a peut-être pas démarré"
        exit 1
    fi
    info "Tail des logs (Ctrl+C pour quitter)..."
    tail -f "$LOG_DIR/agent.log" "$LOG_DIR/agent.err.log"
}

uninstall_agent() {
    color "1" "═══════ Désinstallation ═══════"
    launchctl unload "$PLIST_PATH" 2>/dev/null && ok "Unloaded" || warn "Pas chargé"
    rm -f "$PLIST_PATH" && ok "plist supprimé" || warn "plist déjà absent"
    echo
    info "Pour supprimer la config (.env, venv, logs) : rm -rf $ENV_FILE venv $LOG_DIR"
}

print_help() {
    cat <<EOF
Diagnostic Agent — gestion macOS

  setup_macos.sh                Installation / reconfiguration interactive
  setup_macos.sh start          Démarrer l'agent
  setup_macos.sh stop           Arrêter l'agent
  setup_macos.sh restart        Redémarrer
  setup_macos.sh status         Voir si tourne + dernières lignes log
  setup_macos.sh logs           Tail live des logs
  setup_macos.sh uninstall      Désinstaller (garde .env et venv)
  setup_macos.sh enable-dns-flush   Autoriser l'agent à flush DNS sans password (sudoers)
  setup_macos.sh disable-dns-flush  Retirer l'autorisation flush DNS
EOF
}

# Helpers pour la règle sudoers "flush DNS sans password"
SUDOERS_FILE="/etc/sudoers.d/omen-diagnostic-agent"

enable_dns_flush() {
    color "1" "═══════ Autoriser le flush DNS sans password ═══════"
    echo
    info "Cette commande va créer une règle sudoers très restrictive :"
    echo "  - Utilisateur : $(whoami)"
    echo "  - Commande autorisée : /usr/bin/killall -HUP mDNSResponder"
    echo "  - Sans password (NOPASSWD)"
    echo
    warn "Tu vas devoir taper ton mot de passe macOS UNE SEULE FOIS."
    echo "  Après ça, l'agent peut flush DNS tout seul, à vie."
    echo "  Désactivable via : ./setup_macos.sh disable-dns-flush"
    echo
    read -rp "Continuer ? [y/N] " confirm
    if [[ "${confirm,,}" != "y" && "${confirm,,}" != "yes" ]]; then
        info "Annulé"
        exit 0
    fi

    local user="$(whoami)"
    # Trouver le path absolu de killall (varie selon macOS)
    local killall_path
    killall_path="$(which killall)"
    if [ -z "$killall_path" ]; then
        err "killall introuvable"
        exit 1
    fi

    local rule="${user} ALL=(root) NOPASSWD: ${killall_path} -HUP mDNSResponder"

    # Écrire d'abord dans /tmp puis valider syntaxe avant de déposer dans sudoers.d
    local tmp="$(mktemp)"
    cat > "$tmp" <<EOF
# OmenServer Diagnostic Agent — autorisation flush DNS sans password
# Géré par setup_macos.sh (enable-dns-flush / disable-dns-flush)
${rule}
EOF

    info "Validation de la syntaxe sudoers..."
    if ! sudo visudo -cf "$tmp"; then
        err "Syntaxe sudoers invalide — install annulée"
        rm -f "$tmp"
        exit 1
    fi
    ok "Syntaxe OK"

    info "Installation dans $SUDOERS_FILE (sudo requis)..."
    sudo install -m 0440 -o root -g wheel "$tmp" "$SUDOERS_FILE"
    rm -f "$tmp"
    ok "Règle sudoers installée"

    # Test : essayer la commande sans password
    info "Test : flush DNS via sudo -n..."
    if sudo -n "$killall_path" -HUP mDNSResponder 2>/dev/null; then
        ok "Cache DNS vidé avec succès — l'agent peut maintenant le faire en autonomie"
    else
        warn "Le test a échoué. Vérifie le fichier $SUDOERS_FILE manuellement."
    fi
    echo
    info "Redémarre l'agent pour qu'il prenne en compte : ./setup_macos.sh restart"
}

disable_dns_flush() {
    if [ ! -f "$SUDOERS_FILE" ]; then
        warn "Aucune règle installée ($SUDOERS_FILE n'existe pas)"
        exit 0
    fi
    info "Suppression de $SUDOERS_FILE (sudo requis)..."
    sudo rm -f "$SUDOERS_FILE"
    ok "Règle supprimée — l'agent ne peut plus flush DNS sans password"
}

# --- Dispatch ---------------------------------------------------------------

case "${1:-install}" in
    install|"")
        ensure_python
        ensure_venv
        prompt_config
        generate_plist
        load_agent
        echo
        color "1" "═══════ Installation terminée ═══════"
        echo
        info "Logs en live :          ./setup_macos.sh logs"
        info "État de l'agent :       ./setup_macos.sh status"
        info "Arrêter temporairement : ./setup_macos.sh stop"
        info "Désinstaller :          ./setup_macos.sh uninstall"
        echo
        info "Va sur https://omenserver.org/#sysdoc — le pill devrait passer en vert dans ~5s."
        ;;
    start)
        launchctl load "$PLIST_PATH" 2>/dev/null || launchctl start "$LABEL"
        sleep 1
        show_status
        ;;
    stop)
        launchctl unload "$PLIST_PATH" 2>/dev/null && ok "Stopped" || warn "Pas chargé"
        ;;
    restart)
        launchctl unload "$PLIST_PATH" 2>/dev/null || true
        sleep 1
        launchctl load "$PLIST_PATH"
        sleep 1
        show_status
        ;;
    status)
        show_status
        ;;
    logs)
        show_logs
        ;;
    uninstall)
        uninstall_agent
        ;;
    enable-dns-flush)
        enable_dns_flush
        ;;
    disable-dns-flush)
        disable_dns_flush
        ;;
    -h|--help|help)
        print_help
        ;;
    *)
        err "Commande inconnue : $1"
        print_help
        exit 1
        ;;
esac
