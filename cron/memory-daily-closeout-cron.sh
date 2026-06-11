#!/usr/bin/env bash
# Memory Daily Closeout — deterministic cron wrapper.
#
# Appends a compact closeout to the alert workspace daily memory file without
# asking the LLM to edit files. The OpenClaw cron agent should only execute
# this script and paste stdout.
set -u

TZ_NAME="America/Port_of_Spain"
TODAY="$(TZ="$TZ_NAME" date +%Y-%m-%d)"
TARGET="/home/clawd/.openclaw/workspace/memory/${TODAY}.md"
STATUS="appended"

mkdir -p "$(dirname "$TARGET")"

if [ ! -f "$TARGET" ]; then
  {
    printf '# %s\n\n' "$TODAY"
    printf '## Index\n'
    printf '| # | Type | Summary |\n'
    printf '|---|------|---------|\n'
  } > "$TARGET"
fi

if grep -q '^## Cierre automático$' "$TARGET"; then
  STATUS="already-present"
else
  INDEX_ROWS="$(awk '/^\| [0-9]+ /{print}' "$TARGET" | head -3 || true)"
  if [ -n "${INDEX_ROWS// /}" ]; then
    SUMMARY_LINES="$(printf '%s\n' "$INDEX_ROWS" | awk -F'|' '{
      gsub(/^[ \t]+|[ \t]+$/, "", $4);
      if ($4 != "") print "- " $4;
    }' | head -3)"
  else
    SUMMARY_LINES="- Sin actividad cross-workspace registrada en el índice diario."
  fi

  {
    printf '\n## Cierre automático\n\n'
    printf -- '- Fecha local: %s (%s).\n' "$TODAY" "$TZ_NAME"
    printf -- '- Cierre generado por wrapper determinístico; sin edición manual del modelo.\n'
    printf '%s\n' "$SUMMARY_LINES"
  } >> "$TARGET"
fi

bytes="$(wc -c < "$TARGET" | tr -d ' ')"
index_rows="$(awk '/^\| [0-9]+ /{n++} END{print n+0}' "$TARGET")"

printf 'Estado: %s\n' "$STATUS"
printf 'Archivo: %s\n' "$TARGET"
printf 'Fecha: %s\n' "$TODAY"
printf 'Resumen:\n'
if [ "$STATUS" = "already-present" ]; then
  printf -- '- Marker `## Cierre automático` ya presente; no se duplicó.\n'
else
  printf -- '- Cierre automático agregado sin depender de edición LLM.\n'
fi
printf -- '- index_rows=%s bytes=%s\n' "$index_rows" "$bytes"
