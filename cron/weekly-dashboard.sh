#!/bin/bash
set -euo pipefail

ROOT="/home/clawd/.openclaw/skills/brainx-v3"
cd "$ROOT"

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

METRICS_7D=$(./brainx-v3 metrics --days 7 --json)

TREND=$(psql "$DATABASE_URL" -t -A -F '|' -c "
SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
       query_kind,
       ROUND(AVG(COALESCE(duration_ms,0))::numeric,2) AS avg_ms,
       COUNT(*) AS calls
FROM brainx_query_log
WHERE created_at >= NOW() - INTERVAL '7 days'
GROUP BY 1,2
ORDER BY 1 DESC,2;
" 2>/dev/null || true)

echo "Dashboard semanal BrainX (7d)"
echo "- estado metrics: $(echo "$METRICS_7D" | jq -r '.ok')"
echo "- top patrones:"
echo "$METRICS_7D" | jq -r '.top_recurring_patterns[0:5][]? | "  - \(.pattern_key // "(sin-key)"): recurrence=\(.recurrence_count)"'

echo "- performance query (promedio 7d):"
echo "$METRICS_7D" | jq -r '.query_performance[]? | "  - \(.query_kind): calls=\(.calls), avg_ms=\(.avg_duration_ms), avg_top_sim=\(.avg_top_similarity // "n/a")"'

echo "- tendencia diaria (últimos 7 días):"
if [ -z "$TREND" ]; then
  echo "  - sin datos"
else
  while IFS='|' read -r day kind avg calls; do
    [ -z "$day" ] && continue
    echo "  - ${day} ${kind}: calls=${calls}, avg_ms=${avg}"
  done <<< "$TREND"
fi
