#!/usr/bin/env bash
# Cleanup BrainX orphan files left in workspaces by the legacy auto-inject hook.
# Default: dry-run. Pass --apply to actually delete.
# Pass --backup-dir PATH to archive removed files before delete.

set -euo pipefail

MODE="dry-run"
BACKUP_DIR=""
ROOT="/home/clawd/.openclaw"

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) MODE="apply"; shift ;;
    --backup-dir) BACKUP_DIR="$2"; shift 2 ;;
    --root) ROOT="$2"; shift 2 ;;
    *) echo "unknown flag: $1"; exit 2 ;;
  esac
done

if [ "$MODE" = "apply" ] && [ -z "$BACKUP_DIR" ]; then
  BACKUP_DIR="$ROOT/backups/workspace-orphans-$(date -u +%Y%m%d-%H%M%S)"
fi

if [ "$MODE" = "apply" ]; then
  mkdir -p "$BACKUP_DIR"
  echo "Mode: APPLY (files will be moved to $BACKUP_DIR)"
else
  echo "Mode: DRY-RUN (no files will be touched; pass --apply to execute)"
fi
echo "Scanning: $ROOT/workspace-*"
echo

total_files=0
total_dirs=0
total_memory_blocks=0
affected_ws=0

for ws in "$ROOT"/workspace-*; do
  [ -d "$ws" ] || continue
  ws_name="$(basename "$ws")"
  changed=0

  # Orphan file: BRAINX_CONTEXT.md
  if [ -f "$ws/BRAINX_CONTEXT.md" ]; then
    echo "  [$ws_name] BRAINX_CONTEXT.md"
    total_files=$((total_files + 1))
    if [ "$MODE" = "apply" ]; then
      mkdir -p "$BACKUP_DIR/$ws_name"
      mv "$ws/BRAINX_CONTEXT.md" "$BACKUP_DIR/$ws_name/"
    fi
    changed=1
  fi

  # Orphan dir: brainx-topics/
  if [ -d "$ws/brainx-topics" ]; then
    topic_count=$(find "$ws/brainx-topics" -maxdepth 1 -name "*.md" 2>/dev/null | wc -l)
    echo "  [$ws_name] brainx-topics/ ($topic_count .md files)"
    total_dirs=$((total_dirs + 1))
    if [ "$MODE" = "apply" ]; then
      mkdir -p "$BACKUP_DIR/$ws_name"
      mv "$ws/brainx-topics" "$BACKUP_DIR/$ws_name/"
    fi
    changed=1
  fi

  # BRAINX block in MEMORY.md
  if [ -f "$ws/MEMORY.md" ]; then
    if grep -q "BRAINX:START" "$ws/MEMORY.md" 2>/dev/null; then
      echo "  [$ws_name] MEMORY.md contains BRAINX:START/END block"
      total_memory_blocks=$((total_memory_blocks + 1))
      if [ "$MODE" = "apply" ]; then
        mkdir -p "$BACKUP_DIR/$ws_name"
        cp "$ws/MEMORY.md" "$BACKUP_DIR/$ws_name/MEMORY.md.bak"
        # Delete everything between BRAINX:START and BRAINX:END markers (inclusive)
        awk '/<!-- BRAINX:START/{skip=1} !skip{print} /<!-- BRAINX:END/{skip=0}' \
          "$ws/MEMORY.md" > "$ws/MEMORY.md.tmp"
        mv "$ws/MEMORY.md.tmp" "$ws/MEMORY.md"
      fi
      changed=1
    fi
  fi

  [ "$changed" = 1 ] && affected_ws=$((affected_ws + 1))
done

echo
echo "Summary:"
echo "  Workspaces affected: $affected_ws"
echo "  BRAINX_CONTEXT.md files: $total_files"
echo "  brainx-topics/ dirs:     $total_dirs"
echo "  MEMORY.md blocks:        $total_memory_blocks"
if [ "$MODE" = "apply" ]; then
  echo "  Backup location:         $BACKUP_DIR"
else
  echo
  echo "  To apply: $(basename "$0") --apply"
fi
