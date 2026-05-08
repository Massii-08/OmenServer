#!/bin/bash
# ============================================================
# OmenServer Watchdog — Surveille et redémarre les services
# 
# Ce script vérifie toutes les 30 secondes que :
#   1. uvicorn (backend) tourne
#   2. cloudflared (tunnel Cloudflare) tourne
#
# Si un des deux est mort, il le relance automatiquement.
#
# Utilisation :
#   chmod +x watchdog.sh
#   ./watchdog.sh &          ← Lance en arrière-plan
#   nohup ./watchdog.sh &    ← Survit à la fermeture du terminal
# ============================================================

PROJECT_DIR="/Users/massimiliano/Projet serveur"
CLOUDFLARED_BIN="$PROJECT_DIR/cloudflared"
LOG_FILE="$PROJECT_DIR/watchdog.log"
CHECK_INTERVAL=30  # secondes entre chaque vérification

log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') | $1" | tee -a "$LOG_FILE"
}

start_uvicorn() {
    log "🔄 Relance de uvicorn..."
    cd "$PROJECT_DIR"
    source venv/bin/activate 2>/dev/null
    nohup python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000 >> "$PROJECT_DIR/uvicorn.log" 2>&1 &
    log "✅ uvicorn relancé (PID: $!)"
}

start_cloudflared() {
    log "🔄 Relance de cloudflared..."
    nohup "$CLOUDFLARED_BIN" tunnel run >> "$PROJECT_DIR/cloudflared.log" 2>&1 &
    log "✅ cloudflared relancé (PID: $!)"
}

log "🐕 Watchdog démarré — surveillance toutes les ${CHECK_INTERVAL}s"

while true; do
    # Vérifier uvicorn
    if ! pgrep -f "uvicorn backend.main:app" > /dev/null 2>&1; then
        log "❌ uvicorn est DOWN !"
        start_uvicorn
        sleep 5  # Attendre que uvicorn démarre avant de vérifier cloudflared
    fi

    # Vérifier cloudflared
    if ! pgrep -f "cloudflared tunnel run" > /dev/null 2>&1; then
        log "❌ cloudflared est DOWN !"
        start_cloudflared
    fi

    sleep "$CHECK_INTERVAL"
done
