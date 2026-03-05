#!/bin/bash
# BrainX V4 Health Check Cron Job
# Runs every 30 minutes to verify BrainX V4 status

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRAINX_DIR="$(dirname "$SCRIPT_DIR")"
LOG_FILE="/home/clawd/.openclaw/skills/brainx-v4/cron/health.log"
LOCK_FILE="/tmp/brainx-health-check.lock"

# Prevent concurrent runs
if [ -f "$LOCK_FILE" ]; then
    PID=$(cat "$LOCK_FILE" 2>/dev/null || echo "")
    if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
        echo "$(date): Health check already running (PID: $PID), skipping..." >> "$LOG_FILE"
        exit 0
    fi
fi

echo $$ > "$LOCK_FILE"
trap "rm -f $LOCK_FILE" EXIT

# Function to log with timestamp
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

# Check if BrainX CLI exists
if [ ! -f "$BRAINX_DIR/brainx-v4" ]; then
    log "ERROR: brainx-v4 CLI not found at $BRAINX_DIR/brainx-v4"
    exit 1
fi

# Load environment
if [ -f "$BRAINX_DIR/.env" ]; then
    export $(grep -v '^#' "$BRAINX_DIR/.env" | xargs) 2>/dev/null || true
fi

# Run health check
log "Starting BrainX V4 health check..."

if "$BRAINX_DIR/brainx-v4" health > /tmp/brainx-health-output.txt 2>&1; then
    STATUS="OK"
    DETAILS=$(cat /tmp/brainx-health-output.txt)
    log "Health check PASSED: $DETAILS"
    
    # Count memories
    MEM_COUNT=$(psql "$DATABASE_URL" -t -c "SELECT COUNT(*) FROM brainx_memories;" 2>/dev/null | xargs || echo "0")
    log "Total memories: $MEM_COUNT"
    
    # Check recent memories
    RECENT=$(psql "$DATABASE_URL" -t -c "SELECT COUNT(*) FROM brainx_memories WHERE created_at > NOW() - INTERVAL '24 hours';" 2>/dev/null | xargs || echo "0")
    log "Last 24h: $RECENT memories"
    
else
    STATUS="FAILED"
    ERROR=$(cat /tmp/brainx-health-output.txt 2>/dev/null || echo "Unknown error")
    log "Health check FAILED: $ERROR"
fi

# Cleanup old logs (keep last 1000 lines)
if [ -f "$LOG_FILE" ]; then
    tail -n 1000 "$LOG_FILE" > "$LOG_FILE.tmp" 2>/dev/null && mv "$LOG_FILE.tmp" "$LOG_FILE" || true
fi

log "Completed. Status: $STATUS"
exit 0
