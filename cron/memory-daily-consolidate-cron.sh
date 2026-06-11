#!/usr/bin/env bash
set -euo pipefail

# Memory Daily Consolidate
# ------------------------
# Consolida actividad de TODOS los workspaces (workspace/, workspace-*/) en
# /home/clawd/.openclaw/workspace/memory/<today>.md, ANTES de que el cron
# Memory Daily Closeout (23:55 AST) lea ese archivo.
#
# Sin esta consolidación, el closeout solo ve actividad de `alert` (workspace
# genérico) y reporta "Sin actividad" aunque raider/blade/echo/coder/xefora/
# venus/reasoning/etc tuvieron sesiones intensas en sus workspaces.
#
# Timezone: TODO usa America/Port_of_Spain (AST, UTC-4 fijo, sin DST).
# Bootstrap, Consolidate y Closeout comparten esta TZ → mismo archivo <today>.md
# para todo el ciclo de un día humano.

export TZ='America/Port_of_Spain'

today="$(date +%Y-%m-%d)"
target="/home/clawd/.openclaw/workspace/memory/${today}.md"
marker="<!-- consolidated:${today} -->"

mkdir -p "$(dirname "$target")"

# Bootstrap target si no existe (defensivo: el cron Bootstrap debió crearlo a las 00:05)
if [[ ! -f "$target" ]]; then
  cat > "$target" <<EOF
# ${today}

## Index
| # | Type | Summary |
|---|------|---------|
EOF
fi

# Idempotencia: skip si ya consolidamos hoy
if grep -qF "$marker" "$target"; then
  cat <<JSON
{"status":"already-consolidated","target":"${target}","today":"${today}"}
JSON
  exit 0
fi

# Construir consolidación en tmpfile
tmpfile="$(mktemp)"
trap 'rm -f "$tmpfile"' EXIT

{
  echo ""
  echo "## Cross-workspace activity (consolidated ${today})"
  echo ""
  echo "${marker}"
  echo ""
} >> "$tmpfile"

workspaces_with_activity=()
total_events=0
total_index_rows=0
total_closeouts=0

for ws in /home/clawd/.openclaw/workspace-*/; do
  [[ -d "$ws" ]] || continue
  agent="$(basename "$ws" | sed 's/^workspace-//')"
  src="${ws}memory/${today}.md"
  [[ -f "$src" ]] || continue

  # Index entries (rows tipo `| 1 | type | summary |`, no header, no separator)
  index_rows=$(awk '/^## Index/{flag=1;next} /^## /{flag=0} flag && /^\|/ && !/^\| #/ && !/^\|---/' "$src" 2>/dev/null || true)

  # Session continuity events (### timestamps)
  session_events=$(grep -cE "^### 20[0-9]{2}-[0-9]{2}-[0-9]{2}T" "$src" 2>/dev/null) || session_events=0

  # Cierre automático bullets
  cierre_bullets=$(awk '/^## Cierre automático/{flag=1;next} /^## /{flag=0} flag && /^- /' "$src" 2>/dev/null || true)

  has_content=0
  ws_section="$(mktemp)"

  if [[ -n "$index_rows" ]]; then
    rows_count=$(printf '%s\n' "$index_rows" | grep -c '^|' || true)
    {
      echo "### ${agent} — index (${rows_count} entries)"
      echo "$index_rows"
      echo ""
    } >> "$ws_section"
    has_content=1
    total_index_rows=$((total_index_rows + rows_count))
  fi

  if [[ "$session_events" -gt 0 ]]; then
    {
      echo "### ${agent} — sessions"
      echo "- ${session_events} session continuity events"
      echo ""
    } >> "$ws_section"
    has_content=1
    total_events=$((total_events + session_events))
  fi

  if [[ -n "$cierre_bullets" ]]; then
    {
      echo "### ${agent} — closeout"
      echo "$cierre_bullets"
      echo ""
    } >> "$ws_section"
    has_content=1
    total_closeouts=$((total_closeouts + 1))
  fi

  if [[ "$has_content" -eq 1 ]]; then
    cat "$ws_section" >> "$tmpfile"
    workspaces_with_activity+=("$agent")
  fi
  rm -f "$ws_section"
done

ws_count=${#workspaces_with_activity[@]}

if [[ "$ws_count" -eq 0 ]]; then
  echo "" >> "$target"
  echo "${marker} (no cross-workspace activity)" >> "$target"
  cat <<JSON
{"status":"noop","reason":"no-cross-workspace-activity","target":"${target}","today":"${today}"}
JSON
  exit 0
fi

# Append al target
cat "$tmpfile" >> "$target"

# Build JSON output
ws_list_json=$(printf '%s\n' "${workspaces_with_activity[@]}" | python3 -c "import sys,json; print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))")

cat <<JSON
{"status":"ok","target":"${target}","today":"${today}","workspaces_count":${ws_count},"workspaces":${ws_list_json},"total_session_events":${total_events},"total_index_rows":${total_index_rows},"total_closeouts":${total_closeouts}}
JSON
