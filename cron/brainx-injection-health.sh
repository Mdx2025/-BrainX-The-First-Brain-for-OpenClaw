#!/usr/bin/env bash
# BrainX Injection Health Report
# Lee brainx_runtime_injections (últimas 24h) y reporta hit-rate por agent x surface.
# Stdout es el cuerpo que el cron envía a Discord.
set -u

# brainx/.env carries the canonical DATABASE_URL (the gateway.env copy has a
# legacy `brainx_v5` drift that points to a DB that does not exist). Load it
# unconditionally first; fall back to gateway.env only if missing.
unset DATABASE_URL
if [ -f /home/clawd/.openclaw/skills/brainx/.env ]; then
  # shellcheck disable=SC1091
  set -a; . /home/clawd/.openclaw/skills/brainx/.env; set +a
fi
if [ -z "${DATABASE_URL:-}" ] && [ -f /home/clawd/.openclaw/gateway.env ]; then
  # shellcheck disable=SC1091
  set -a; . /home/clawd/.openclaw/gateway.env; set +a
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "Estado: error"
  echo "Resumen:"
  echo "- DATABASE_URL no disponible en /home/clawd/.openclaw/skills/brainx/.env ni /home/clawd/.openclaw/gateway.env"
  exit 1
fi

RUN_TS="$(date +%Y%m%d-%H%M%S)"
LOG_DIR="/home/clawd/.openclaw/cron/runs"
mkdir -p "$LOG_DIR"
LOG_FILE="${LOG_DIR}/brainx-injection-health-${RUN_TS}.log"
DETAIL_LIMIT="${BRAINX_INJECTION_HEALTH_TOP:-6}"
WARN_LIMIT="${BRAINX_INJECTION_HEALTH_WARN_TOP:-4}"
FINALIZE_STALE="${BRAINX_INJECTION_HEALTH_FINALIZE_STALE:-1}"
SQL_RETRIES="${BRAINX_INJECTION_HEALTH_SQL_RETRIES:-3}"
export PGCONNECT_TIMEOUT="${PGCONNECT_TIMEOUT:-10}"
export PGOPTIONS="${PGOPTIONS:--c statement_timeout=30000}"

LOCK_DIR="/home/clawd/.openclaw/state/cron/locks"
LOCK_FILE="${LOCK_DIR}/brainx-injection-health.lock"
mkdir -p "$LOCK_DIR"
exec 9>"$LOCK_FILE"
if command -v flock >/dev/null 2>&1; then
  if ! flock -n 9; then
    echo "Estado: noop"
    echo "Resumen:"
    echo "- Otro brainx-injection-health ya está corriendo; se evita overlap."
    echo ""
    echo "Evidencia:"
    echo "- log=$LOG_FILE"
    echo "- ts=${RUN_TS}"
    exit 0
  fi
fi

# Mirror the human-readable cron report into the evidence log. Historically the
# log only received psql stderr, so successful runs produced a 0B .log while
# stdout carried the real report.
if [ "${BRAINX_INJECTION_HEALTH_MIRROR_LOG:-1}" = "1" ] && command -v tee >/dev/null 2>&1; then
  exec > >(tee "$LOG_FILE") 2>>"$LOG_FILE"
else
  exec 2>>"$LOG_FILE"
fi

# Operational monitors produce high-volume, low-semantic prompts. Runtime JIT
# recall is disabled for them in openclaw.json, but the health window is 24h;
# exclude already-denylisted pairs from the alert condition so historical
# telemetry does not keep the check in warn after the fix is applied.
LOW_HIT_EXCLUSION_SQL="
   AND NOT (surface = 'jit_recall' AND COALESCE(agent,'') IN ('monitor','monitor-public'))"

# Total agregado
TOTALS_SQL="
SELECT
  COUNT(*) AS total_events,
  SUM((selected_count > 0)::int) AS inject_turns,
  SUM(selected_count) AS total_selected,
  SUM(COALESCE(referenced_count,0)) AS total_referenced,
  SUM(COALESCE(soft_referenced_count,0)) AS total_soft_referenced,
  SUM((scored_at IS NULL)::int) AS total_unscored,
  ROUND(AVG(latency_ms)::numeric, 1) AS avg_latency_ms
FROM brainx_runtime_injections
WHERE injected_at > NOW() - INTERVAL '24 hours';"

# Por agent x surface
BY_SURFACE_SQL="
SELECT
  COALESCE(agent,'(null)') AS agent,
  surface,
  COUNT(*) AS n,
  SUM((selected_count > 0)::int) AS injected,
  SUM(selected_count) AS sel,
  SUM(COALESCE(referenced_count,0)) AS ref,
  SUM(COALESCE(soft_referenced_count,0)) AS soft_ref,
  SUM((scored_at IS NULL)::int) AS unscored,
  ROUND(CASE WHEN SUM(selected_count) > 0
    THEN SUM(COALESCE(referenced_count,0))::numeric / SUM(selected_count)::numeric
    ELSE 0 END, 3) AS hit_rate,
  ROUND(CASE WHEN SUM(selected_count) > 0
    THEN SUM(COALESCE(soft_referenced_count,0))::numeric / SUM(selected_count)::numeric
    ELSE 0 END, 3) AS soft_hit_rate
FROM brainx_runtime_injections
WHERE injected_at > NOW() - INTERVAL '24 hours'
GROUP BY 1,2
HAVING COUNT(*) >= 1
ORDER BY n DESC
LIMIT ${DETAIL_LIMIT};"

# Surfaces con hit_rate bajo (signal de ruido)
LOW_HIT_SQL="
SELECT
  COALESCE(agent,'(null)') AS agent,
  surface,
  COUNT(*) AS n,
  SUM(selected_count) AS selected,
  SUM(COALESCE(referenced_count,0)) AS ref,
  SUM(COALESCE(soft_referenced_count,0)) AS soft_ref,
  ROUND(CASE WHEN SUM(selected_count) > 0
    THEN SUM(COALESCE(referenced_count,0))::numeric / SUM(selected_count)::numeric
    ELSE 0 END, 3) AS hit_rate,
  ROUND(CASE WHEN SUM(selected_count) > 0
    THEN SUM(COALESCE(soft_referenced_count,0))::numeric / SUM(selected_count)::numeric
    ELSE 0 END, 3) AS soft_hit_rate
FROM brainx_runtime_injections
WHERE injected_at > NOW() - INTERVAL '24 hours'
  AND surface NOT IN ('recovery_preflight')
  ${LOW_HIT_EXCLUSION_SQL}
GROUP BY 1,2
HAVING COUNT(*) >= 20
   AND SUM(selected_count) > 0
   AND (SUM(COALESCE(soft_referenced_count,0))::numeric / SUM(selected_count)::numeric) < 0.25
ORDER BY soft_hit_rate ASC;"

UNSCORED_SQL="
SELECT
  COALESCE(agent,'(null)') AS agent,
  surface,
  COUNT(*) AS n,
  SUM(selected_count) AS selected,
  SUM((scored_at IS NULL)::int) AS unscored,
  ROUND((SUM((scored_at IS NULL)::int)::numeric / COUNT(*)::numeric), 3) AS unscored_rate
FROM brainx_runtime_injections
WHERE injected_at > NOW() - INTERVAL '24 hours'
GROUP BY 1,2
HAVING COUNT(*) >= 20
   AND SUM((scored_at IS NULL)::int) > 0
   AND (SUM((scored_at IS NULL)::int)::numeric / COUNT(*)::numeric) > 0.25
ORDER BY unscored_rate DESC;"

FINALIZE_STALE_SELECTED_SQL="
WITH stale AS (
  SELECT id
    FROM brainx_runtime_injections
   WHERE injected_at > NOW() - INTERVAL '24 hours'
     AND injected_at < NOW() - INTERVAL '20 minutes'
     AND selected_count > 0
     AND scored_at IS NULL
     AND COALESCE(agent,'') NOT IN ('alert','monitor','monitor-public')
),
updated AS (
  UPDATE brainx_runtime_injections ri
     SET referenced_count = 0,
         referenced_ids = '{}'::text[],
         soft_referenced_count = 0,
         soft_referenced_ids = '{}'::text[],
         response_sha = LEFT(md5('brainx-stale-no-response:' || ri.id::text), 16),
         scored_at = NOW(),
         decision_summary = COALESCE(ri.decision_summary, '{}'::jsonb) ||
           jsonb_build_object(
             'scoring_fallback',
             jsonb_build_object(
               'reason', 'expired_no_response',
               'closed_by', 'brainx-injection-health',
               'closed_at', NOW()
             )
           )
    FROM stale
   WHERE ri.id = stale.id
   RETURNING ri.id
)
SELECT COUNT(*) FROM updated;"

STALE_UNSCORED_SELECTED_SQL="
SELECT COUNT(*)
  FROM brainx_runtime_injections
 WHERE injected_at > NOW() - INTERVAL '24 hours'
   AND injected_at < NOW() - INTERVAL '20 minutes'
   AND selected_count > 0
   AND scored_at IS NULL
   AND COALESCE(agent,'') NOT IN ('alert','monitor','monitor-public');"

run_sql() {
  local query="$1"
  local attempt=1
  local out=""
  local code=0

  while [ "$attempt" -le "$SQL_RETRIES" ]; do
    out="$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -A -t -F '|' -c "$query" 2>>"$LOG_FILE")"
    code=$?
    if [ "$code" -eq 0 ]; then
      printf '%s' "$out"
      return 0
    fi
    echo "[run_sql] attempt=${attempt}/${SQL_RETRIES} code=${code}" >>"$LOG_FILE"
    sleep $((attempt * 2))
    attempt=$((attempt + 1))
  done

  return "$code"
}

FINALIZER_ERROR=0
FINALIZED_STALE=0
if [ "$FINALIZE_STALE" = "1" ]; then
  FINALIZED_STALE="$(run_sql "$FINALIZE_STALE_SELECTED_SQL")"
  if [ -z "${FINALIZED_STALE// /}" ]; then
    FINALIZER_ERROR=1
    FINALIZED_STALE=0
  fi
fi

TOTALS="$(run_sql "$TOTALS_SQL")"
BY_SURFACE="$(run_sql "$BY_SURFACE_SQL")"
LOW_HIT="$(run_sql "$LOW_HIT_SQL")"
UNSCORED="$(run_sql "$UNSCORED_SQL")"
STALE_UNSCORED_SELECTED="$(run_sql "$STALE_UNSCORED_SELECTED_SQL")"

if [ -z "$TOTALS" ]; then
  echo "Estado: error"
  echo "Resumen:"
  echo "- psql failed. Ver $LOG_FILE"
  exit 1
fi
if [ -z "${STALE_UNSCORED_SELECTED// /}" ]; then
  FINALIZER_ERROR=1
  STALE_UNSCORED_SELECTED=0
fi

IFS='|' read -r TOTAL_EVENTS INJECT_TURNS TOTAL_SEL TOTAL_REF TOTAL_SOFT_REF TOTAL_UNSCORED AVG_LAT <<< "$TOTALS"
TOTAL_EVENTS=${TOTAL_EVENTS:-0}
INJECT_TURNS=${INJECT_TURNS:-0}
TOTAL_SEL=${TOTAL_SEL:-0}
TOTAL_REF=${TOTAL_REF:-0}
TOTAL_SOFT_REF=${TOTAL_SOFT_REF:-0}
TOTAL_UNSCORED=${TOTAL_UNSCORED:-0}
AVG_LAT=${AVG_LAT:-0}

# Calcular hit-rate global
if [ "${TOTAL_SEL:-0}" -gt 0 ] 2>/dev/null; then
  GLOBAL_HIT=$(awk -v r="${TOTAL_REF:-0}" -v s="${TOTAL_SEL:-0}" 'BEGIN{ if (s+0>0) printf "%.1f", (r/s)*100; else print "0.0" }')
else
  GLOBAL_HIT="0.0"
fi
if [ "${TOTAL_SEL:-0}" -gt 0 ] 2>/dev/null; then
  GLOBAL_SOFT_HIT=$(awk -v r="${TOTAL_SOFT_REF:-0}" -v s="${TOTAL_SEL:-0}" 'BEGIN{ if (s+0>0) printf "%.1f", (r/s)*100; else print "0.0" }')
else
  GLOBAL_SOFT_HIT="0.0"
fi
if [ "${TOTAL_EVENTS:-0}" -gt 0 ] 2>/dev/null; then
  GLOBAL_UNSCORED=$(awk -v u="${TOTAL_UNSCORED:-0}" -v n="${TOTAL_EVENTS:-0}" 'BEGIN{ if (n+0>0) printf "%.1f", (u/n)*100; else print "0.0" }')
else
  GLOBAL_UNSCORED="0.0"
fi

# Decidir estado
STATE="ok"
EXIT_STATUS=0
if [ "${TOTAL_EVENTS:-0}" = "0" ]; then
  STATE="noop"
fi
if [ -n "${LOW_HIT// /}" ]; then
  STATE="warn"
fi
if [ -n "${UNSCORED// /}" ]; then
  STATE="warn"
fi
if [ "$FINALIZER_ERROR" = "1" ]; then
  STATE="error"
  EXIT_STATUS=1
fi
if [ "${STALE_UNSCORED_SELECTED:-0}" -gt 0 ] 2>/dev/null; then
  STATE="error"
  EXIT_STATUS=1
fi

TS_LOCAL=$(TZ='America/Port_of_Spain' date '+%Y-%m-%d %I:%M %p AST')
case "$STATE" in
  ok)    HEADER_EMOJI="✅"; STATE_HUMAN="todo dentro de los umbrales" ;;
  noop)  HEADER_EMOJI="ℹ️"; STATE_HUMAN="sin actividad en las últimas 24h" ;;
  warn)  HEADER_EMOJI="⚠️"; STATE_HUMAN="hay surfaces con métricas degradadas — revisar abajo" ;;
  error) HEADER_EMOJI="🚨"; STATE_HUMAN="errores activos — revisar detalle y arreglar" ;;
  *)     HEADER_EMOJI="ℹ️"; STATE_HUMAN="$STATE" ;;
esac

echo "$HEADER_EMOJI Salud de inyección de BrainX — $TS_LOCAL"
echo "Estado: $STATE_HUMAN"
echo "Resumen últimas 24h:"
echo "  • Eventos totales: ${TOTAL_EVENTS}"
echo "  • Turnos con inyección: ${INJECT_TURNS}"
echo "  • Memorias seleccionadas: ${TOTAL_SEL}"
echo "  • Hit-rate estricto: ${GLOBAL_HIT}% (referencias: ${TOTAL_REF})"
echo "  • Hit-rate suave: ${GLOBAL_SOFT_HIT}% (referencias: ${TOTAL_SOFT_REF})"
echo "  • Eventos sin scoring: ${TOTAL_UNSCORED} (${GLOBAL_UNSCORED}%)"
echo "  • Selected stale auto-finalizados: ${FINALIZED_STALE}"
echo "  • Selected stale sin scoring: ${STALE_UNSCORED_SELECTED}"
echo "  • Latencia promedio: ${AVG_LAT}ms"

if [ -n "${BY_SURFACE// /}" ]; then
  echo ""
  echo "Detalle por agent × surface (top ${DETAIL_LIMIT}):"
  echo "$BY_SURFACE" | while IFS='|' read -r agent surface n injected sel ref soft_ref unscored hit soft_hit; do
    [ -z "$agent" ] && continue
    echo "- ${agent}/${surface}: n=${n} inj=${injected} sel=${sel} ref=${ref} soft=${soft_ref} unscored=${unscored} hit=${hit} soft_hit=${soft_hit}"
  done
fi

if [ -n "${LOW_HIT// /}" ]; then
  echo ""
  echo "⚠️ Estas surfaces tienen hit-rate suave bajo 25% con suficiente muestra (n≥20). → Endurecer los gates de inyección o revisar cómo se generan estas memorias:"
  echo "$LOW_HIT" | head -n "$WARN_LIMIT" | while IFS='|' read -r agent surface n selected ref soft_ref hit soft_hit; do
    [ -z "$agent" ] && continue
    echo "  • ${agent}/${surface}: ${n} eventos, hit_estricto=${hit}%, hit_suave=${soft_hit}%"
  done
fi

if [ -n "${UNSCORED// /}" ]; then
  echo ""
  echo "⚠️ Estas surfaces tienen más del 25% de eventos sin scoring (n≥20). → Revisar el finalizer de scoring:"
  echo "$UNSCORED" | head -n "$WARN_LIMIT" | while IFS='|' read -r agent surface n selected unscored rate; do
    [ -z "$agent" ] && continue
    echo "  • ${agent}/${surface}: ${n} eventos, sin scoring=${unscored} (${rate}%)"
  done
fi

echo ""
echo "Log: $LOG_FILE"
exit "$EXIT_STATUS"
