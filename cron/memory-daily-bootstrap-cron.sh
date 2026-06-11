#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=/dev/null
source "$(dirname "$0")/cron-notify.sh"

today="$(date -u +%Y-%m-%d)"
yesterday="$(date -u -d 'yesterday' +%Y-%m-%d)"

created=0
changes=()

WS_ALL=( /home/clawd/.openclaw/workspace/ /home/clawd/.openclaw/workspace-*/ )
for ws in "${WS_ALL[@]}"; do
  [[ -d "$ws" ]] || continue
  memdir="${ws}memory"
  mkdir -p "$memdir"

  for d in "$today" "$yesterday"; do
    f="${memdir}/${d}.md"
    if [[ ! -f "$f" ]]; then
      cat > "$f" <<EOF
# ${d}

## Index
| # | Type | Summary |
|---|------|---------|
EOF
      created=$((created + 1))
      changes+=("$(basename "$ws"):${d}")
    fi
  done
done

if [[ "$created" -eq 0 ]]; then
  exit 0
fi

# Count unique workspaces and dates
ws_count=$(printf '%s\n' "${changes[@]}" | cut -d: -f1 | sort -u | wc -l)
dates_created=$(printf '%s\n' "${changes[@]}" | cut -d: -f2 | sort -u | paste -sd', ')

msg="✅ ${created} archivos de memoria diaria creados para ${ws_count} workspaces (${dates_created})"

send_cron_notify "Memory Daily Bootstrap" "$msg"
