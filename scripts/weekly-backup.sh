#!/bin/bash
# BrainX V5 Weekly Backup
# Retention: keep the last RETENTION_COUNT weekly backups (~5 weeks given weekly cadence)
# Credentials sourced from ~/.pgpass (mode 0600)
set -euo pipefail

BACKUP_DIR="/home/clawd/.openclaw/skills/brainx/backups"
RETENTION_COUNT=1
DATE=$(date +%Y%m%d_%H%M)
FILE="$BACKUP_DIR/brainx_backup_${DATE}.sql"

pg_dump -h 127.0.0.1 -p 5432 -U brainx -d brainx > "$FILE"

# Retention — matches current and legacy naming (brainx_backup_*, brainx_v4_backup_*, brainx_v5_backup_*)
ls -1t "$BACKUP_DIR"/brainx*backup_*.sql | tail -n +$((RETENTION_COUNT + 1)) | xargs -r rm

echo "Backup created: $(basename "$FILE") ($(du -h "$FILE" | cut -f1))"
