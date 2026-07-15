#!/bin/bash
# Run MC-Agent — mission autonome T1→T4 (armure fer → diamant → Nether → netherite), sans /give.
# Modèle : OPUS 4.8. RELANCE AUTO à chaque fin de session (coupure tokens / limite 5h / fin de
#          tour / crash) → le run continue tout seul jusqu'à la deadline.
#
# Usage (mode caféiné — MacBook Air : branché + écran OUVERT) :
#     caffeinate -dims bash "tools/mc-t1t4-overnight.sh"
#
# Réglages : MAX_HOURS = durée max du run (défaut 12 h). Éditable ci-dessous ou via env :
#     MAX_HOURS=16 caffeinate -dims bash "tools/mc-t1t4-overnight.sh"
set -u

PROJECT_DIR="/Users/massimiliano/omenserver Project/Projet serveur"
PROMPT_FILE="$PROJECT_DIR/docs/mc-agent-t1-t4-overnight-prompt.md"
LOG="$HOME/mc-t1t4-runner.log"
MODEL="claude-opus-4-8"
MAX_HOURS="${MAX_HOURS:-12}"
RETRY_SLEEP="${RETRY_SLEEP:-600}"   # 10 min entre deux relances

cd "$PROJECT_DIR" || exit 1
ts() { date '+%Y-%m-%d %H:%M:%S'; }
DEADLINE=$(( $(date +%s) + MAX_HOURS * 3600 ))

# Une session : initiale (lit le prompt) ou --continue (reprend §RESUME). Sortie tee'd dans le log.
run_session() {
  if [ "$1" = "initial" ]; then
    echo "$(ts) — session initiale (model=$MODEL)" | tee -a "$LOG"
    claude --model "$MODEL" --dangerously-skip-permissions -p < "$PROMPT_FILE" 2>&1 | tee -a "$LOG"
  else
    echo "$(ts) — relance --continue (model=$MODEL)" | tee -a "$LOG"
    claude --model "$MODEL" --dangerously-skip-permissions -c \
      -p "Relance automatique du runner (coupure tokens/fin de tour). Relis docs/mc-agent-t1-t4-overnight-prompt.md et .mc-t1t4-overnight-report.md, puis REPRENDS la mission au prochain blocage réel (§RESUME). S'il est ≥ la deadline du runner, exécute la §CLÔTURE (RÉACTIVE le power schedule de l'Omen) puis termine." \
      2>&1 | tee -a "$LOG"
  fi
  echo "$(ts) — session terminée (exit ${PIPESTATUS[0]})" | tee -a "$LOG"
}

echo "$(ts) — runner T1→T4 démarré (pid $$) — modèle $MODEL — deadline $(date -r "$DEADLINE" '+%Y-%m-%d %H:%M') (${MAX_HOURS} h)" | tee -a "$LOG"

first=1
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  if [ $first -eq 1 ]; then run_session initial; first=0; else run_session continue; fi
  [ "$(date +%s)" -ge "$DEADLINE" ] && break
  echo "$(ts) — pause ${RETRY_SLEEP}s avant relance auto" | tee -a "$LOG"
  sleep "$RETRY_SLEEP"
done

# Clôture GARANTIE : réactiver le power schedule + rapport, même si tokens limités (on ré-essaie).
echo "$(ts) — deadline atteinte → session de CLÔTURE" | tee -a "$LOG"
for attempt in 1 2 3 4 5 6; do
  claude --model "$MODEL" --dangerously-skip-permissions -c \
    -p "Deadline du runner atteinte — exécute la §CLÔTURE de docs/mc-agent-t1-t4-overnight-prompt.md : bilan honnête des paliers réellement portés, RÉACTIVE le power schedule de l'Omen (PUT /api/power/schedule enabled:true, vérifie par GET), écris .mc-t1t4-overnight-report.md, MAJ mémoire + Daily note Obsidian, puis termine." \
    2>&1 | tee -a "$LOG"
  ec=${PIPESTATUS[0]}
  echo "$(ts) — clôture tentative $attempt (exit $ec)" | tee -a "$LOG"
  [ $ec -eq 0 ] && break
  sleep 900
done
echo "$(ts) — runner fini." | tee -a "$LOG"
