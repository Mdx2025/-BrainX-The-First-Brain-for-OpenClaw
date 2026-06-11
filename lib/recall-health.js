const DEFAULT_DAYS = 7;

const DEFAULT_THRESHOLDS = {
  minCalls: 5,
  zeroResultRateWarn: 40,
  zeroSelectedRateWarn: 50,
  selectedNoSignalRateWarn: 50,
  staleSelectedWarn: 1,
  lowSoftSignalWarn: 10,
  contradictionAlwaysZeroMinCalls: 3,
};

// Self-calibrating layer. Instead of judging every surface against the fixed
// numbers above (which drift and demand constant manual re-tuning as the fleet
// changes), we compare the current window against each surface's OWN prior
// baseline and warn only on a real regression. The fixed thresholds become a
// cold-start fallback (when there is not enough baseline history) plus an
// absolute "broken regardless" backstop (hardCap). Stable surfaces stop warning
// no matter their absolute level; the learning loop (degrade/promote crons)
// lowers the baseline over time. No human knob to keep calibrating.
const DEFAULT_BASELINE_DAYS = 30;
const ADAPTIVE = {
  enabled: true,
  minBaselineCalls: 30, // need enough prior history before we trust the baseline
  relTolerance: 0.4,    // current must exceed baseline by ≥40% (relative) ...
  absFloor: 12,         // ... and by ≥12 percentage points (absolute), to avoid noise
  // Absolute backstops: warn regardless of baseline above these (genuine breakage).
  hardCap: {
    zero_result_rate_pct: 90,
    zero_selected_rate_pct: 95,
    selected_no_signal_rate_pct: 85,
  },
  softFloorRel: 0.5,    // soft signal: regression if current < baseline*0.5
};

// Ceiling for a "higher is worse" rate. Returns the rate at/above which the
// surface is anomalous vs its own baseline; falls back to the fixed threshold
// on cold start. Result also carries why, for transparent output.
function adaptiveCeiling(metricKey, baseline, fixedFallback) {
  if (!ADAPTIVE.enabled) return { ceiling: fixedFallback, mode: 'fixed' };
  const baseCalls = baseline ? toNumber(baseline.calls) : 0;
  if (baseCalls < ADAPTIVE.minBaselineCalls) {
    return { ceiling: fixedFallback, mode: 'fixed_cold_start', baselineCalls: baseCalls };
  }
  const baseRate = toNumber(baseline[metricKey]);
  const adaptive = baseRate + Math.max(ADAPTIVE.absFloor, baseRate * ADAPTIVE.relTolerance);
  const cap = ADAPTIVE.hardCap[metricKey] ?? 100;
  return { ceiling: Math.round(Math.min(adaptive, cap) * 10) / 10, mode: 'adaptive', baseline: baseRate, hardCap: cap };
}

// Floor for soft_signal_rate (lower is worse).
function adaptiveSoftFloor(baseline, fixedFallback) {
  if (!ADAPTIVE.enabled) return { floor: fixedFallback, mode: 'fixed' };
  const baseCalls = baseline ? toNumber(baseline.selected_total) : 0;
  if (baseCalls < ADAPTIVE.minBaselineCalls) {
    return { floor: fixedFallback, mode: 'fixed_cold_start' };
  }
  const baseRate = toNumber(baseline.soft_signal_rate_pct);
  return { floor: Math.round(baseRate * ADAPTIVE.softFloorRel * 10) / 10, mode: 'adaptive', baseline: baseRate };
}

const EXPECTED_SURFACES = [
  'jit_recall',
  'inject',
  'contradiction_check',
  'recovery_preflight',
  'project_ground',
];

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function pct(part, total) {
  const denominator = toNumber(total);
  if (!denominator) return 0;
  return Number(((toNumber(part) / denominator) * 100).toFixed(1));
}

function parseInteger(value, fallback) {
  if (value === undefined || value === null || value === '' || value === true) return fallback;
  const n = parseInt(String(value), 10);
  if (Number.isNaN(n)) throw new Error('Invalid integer: ' + value);
  return n;
}

function parseThresholds(args = {}) {
  return {
    minCalls: parseInteger(args.minCalls ?? args['min-calls'], DEFAULT_THRESHOLDS.minCalls),
    zeroResultRateWarn: parseInteger(args.zeroResultRateWarn ?? args['zero-result-warn'], DEFAULT_THRESHOLDS.zeroResultRateWarn),
    zeroSelectedRateWarn: parseInteger(args.zeroSelectedRateWarn ?? args['zero-selected-warn'], DEFAULT_THRESHOLDS.zeroSelectedRateWarn),
    selectedNoSignalRateWarn: parseInteger(args.selectedNoSignalRateWarn ?? args['no-signal-warn'], DEFAULT_THRESHOLDS.selectedNoSignalRateWarn),
    staleSelectedWarn: parseInteger(args.staleSelectedWarn ?? args['stale-selected-warn'], DEFAULT_THRESHOLDS.staleSelectedWarn),
    lowSoftSignalWarn: parseInteger(args.lowSoftSignalWarn ?? args['low-soft-signal-warn'], DEFAULT_THRESHOLDS.lowSoftSignalWarn),
    contradictionAlwaysZeroMinCalls: parseInteger(args.contradictionAlwaysZeroMinCalls ?? args['contradiction-always-zero-min-calls'], DEFAULT_THRESHOLDS.contradictionAlwaysZeroMinCalls),
  };
}

function classifySurface(row, thresholds = DEFAULT_THRESHOLDS, baseline = null) {
  const surface = row.surface;
  const calls = toNumber(row.calls);
  const selected = toNumber(row.selected_total);
  const zeroResults = toNumber(row.zero_result_calls);
  const zeroSelected = toNumber(row.zero_selected_calls);
  const selectedNoSignal = toNumber(row.selected_no_signal_calls);
  const noScorableOutput = toNumber(row.no_scorable_output_calls);
  const softReferenced = toNumber(row.soft_referenced_total);
  const staleSelected = toNumber(row.stale_selected_unscored);

  const metrics = {
    zero_result_rate_pct: pct(zeroResults, calls),
    zero_selected_rate_pct: pct(zeroSelected, calls),
    selected_no_signal_rate_pct: pct(selectedNoSignal, calls),
    soft_signal_rate_pct: pct(softReferenced, selected),
  };

  const warnings = [];
  const notes = [];
  const hasEnoughCalls = calls >= thresholds.minCalls;
  // Self-calibrating ceilings/floor: each surface vs its own baseline (or fixed on cold start).
  const zrCeil = adaptiveCeiling('zero_result_rate_pct', baseline, thresholds.zeroResultRateWarn);
  const zsCeil = adaptiveCeiling('zero_selected_rate_pct', baseline, thresholds.zeroSelectedRateWarn);
  const snsCeil = adaptiveCeiling('selected_no_signal_rate_pct', baseline, thresholds.selectedNoSignalRateWarn);
  const softFloor = adaptiveSoftFloor(baseline, thresholds.lowSoftSignalWarn);
  const calibration = {
    mode: zrCeil.mode,
    zero_result_ceiling: zrCeil.ceiling,
    zero_selected_ceiling: zsCeil.ceiling,
    selected_no_signal_ceiling: snsCeil.ceiling,
    soft_signal_floor: softFloor.floor,
    baseline_calls: baseline ? toNumber(baseline.calls) : 0,
  };
  if (zrCeil.mode === 'adaptive') notes.push('self_calibrated_vs_baseline');
  else if (zrCeil.mode === 'fixed_cold_start') notes.push('fixed_threshold_cold_start');
  const highZeroResults = hasEnoughCalls && metrics.zero_result_rate_pct >= zrCeil.ceiling;
  const highZeroSelected = hasEnoughCalls && metrics.zero_selected_rate_pct >= zsCeil.ceiling;
  const highSelectedNoSignal = hasEnoughCalls && metrics.selected_no_signal_rate_pct >= snsCeil.ceiling;

  if (surface === 'project_ground') {
    notes.push('preventive_anchor_surface');
    if (noScorableOutput > 0) notes.push('no_scorable_output_excluded');
    if (staleSelected >= thresholds.staleSelectedWarn) {
      warnings.push('stale_selected_unscored');
    }
    return {
      status: warnings.length ? 'warn' : 'ok',
      warnings,
      notes,
      metrics,
      calibration,
    };
  }

  if (surface === 'working_memory') {
    notes.push('stateful_surface_empty_result_can_be_healthy');
    if (noScorableOutput > 0) notes.push('no_scorable_output_excluded');
    if (highSelectedNoSignal) {
      warnings.push('high_selected_no_signal_rate');
    }
    if (selected > 0 && metrics.soft_signal_rate_pct < softFloor.floor) {
      warnings.push('low_soft_signal');
    }
    if (staleSelected >= thresholds.staleSelectedWarn) {
      warnings.push('stale_selected_unscored');
    }
    return {
      status: warnings.length ? 'warn' : 'ok',
      warnings,
      notes,
      metrics,
      calibration,
    };
  }

  if (highZeroResults) {
    warnings.push('high_zero_result_rate');
  }
  if (noScorableOutput > 0) notes.push('no_scorable_output_excluded');
  if (surface === 'contradiction_check' && calls >= thresholds.contradictionAlwaysZeroMinCalls && metrics.zero_result_rate_pct === 100) {
    // 100% zero-result here means "no contradictions found" = healthy, not a fault.
    notes.push('contradiction_check_no_contradictions_healthy');
  }
  if (highZeroSelected) {
    if (surface === 'jit_recall' && !highZeroResults && !highSelectedNoSignal) {
      notes.push('high_zero_selected_treated_as_intent_gate_or_router_empty');
    } else {
      warnings.push('high_zero_selected_rate');
    }
  }
  if (highSelectedNoSignal) {
    warnings.push('high_selected_no_signal_rate');
  }
  if (selected > 0 && metrics.soft_signal_rate_pct < thresholds.lowSoftSignalWarn) {
    warnings.push('low_soft_signal');
  }
  if (staleSelected >= thresholds.staleSelectedWarn) {
    warnings.push('stale_selected_unscored');
  }

  return {
    status: warnings.length ? 'warn' : 'ok',
    warnings,
    notes,
    metrics,
    calibration,
  };
}

async function tableExists(db, tableName) {
  const res = await db.query(
    `SELECT to_regclass($1) AS regclass`,
    [tableName]
  );
  return Boolean(res.rows?.[0]?.regclass);
}

function buildWindow(args = {}) {
  const days = parseInteger(args.days, DEFAULT_DAYS);
  return { days };
}

async function collectRecallHealth(db, args = {}) {
  const thresholds = parseThresholds(args);
  const { days } = buildWindow(args);
  const baselineDays = parseInteger(args.baselineDays ?? args['baseline-days'], DEFAULT_BASELINE_DAYS);

  const [hasRuntimeTable, hasQueryLogTable] = await Promise.all([
    tableExists(db, 'brainx_runtime_injections'),
    tableExists(db, 'brainx_query_log'),
  ]);
  if (!hasRuntimeTable) {
    return {
      ok: false,
      status: 'fail',
      generated_at: new Date().toISOString(),
      window_days: days,
      thresholds,
      summary: {
        surfaces_checked: 0,
        warning_count: 0,
        failure_count: 1,
      },
      surfaces: [],
      outliers: [],
      warnings: ['missing_brainx_runtime_injections'],
    };
  }

  const [surfaceRes, agentSurfaceRes, queryLogRes] = await Promise.all([
    db.query(
      `SELECT
         surface,
         COUNT(*)::int AS calls,
         COUNT(*) FILTER (WHERE COALESCE(raw_count, 0) = 0)::int AS zero_result_calls,
         COUNT(*) FILTER (WHERE COALESCE(selected_count, 0) = 0)::int AS zero_selected_calls,
         COUNT(*) FILTER (
           WHERE COALESCE(selected_count, 0) > 0
             AND COALESCE(referenced_count, 0) = 0
             AND COALESCE(soft_referenced_count, 0) = 0
             AND COALESCE(decision_summary #>> '{scoring_fallback,reason}', '')
                 NOT IN ('expired_no_response', 'maintenance_expired_no_response')
             AND scored_at IS NOT NULL
         )::int AS selected_no_signal_calls,
         COUNT(*) FILTER (
           WHERE COALESCE(selected_count, 0) > 0
             AND COALESCE(decision_summary #>> '{scoring_fallback,reason}', '')
                 IN ('expired_no_response', 'maintenance_expired_no_response')
         )::int AS no_scorable_output_calls,
         COUNT(*) FILTER (
           WHERE COALESCE(selected_count, 0) > 0
             AND scored_at IS NULL
             AND injected_at < NOW() - INTERVAL '6 hours'
         )::int AS stale_selected_unscored,
         COALESCE(SUM(selected_count), 0)::int AS selected_total,
         COALESCE(SUM(referenced_count), 0)::int AS hard_referenced_total,
         COALESCE(SUM(soft_referenced_count), 0)::int AS soft_referenced_total,
         ROUND(AVG(latency_ms)::numeric, 1) AS avg_latency_ms,
         MAX(injected_at) AS last_seen_at
       FROM brainx_runtime_injections
       WHERE injected_at >= NOW() - make_interval(days => $1)
       GROUP BY surface
       ORDER BY calls DESC, surface ASC`,
      [days]
    ),
    db.query(
      `SELECT
         COALESCE(agent, '(unknown)') AS agent,
         surface,
         COUNT(*)::int AS calls,
         COUNT(*) FILTER (WHERE COALESCE(raw_count, 0) = 0)::int AS zero_result_calls,
         COUNT(*) FILTER (WHERE COALESCE(selected_count, 0) = 0)::int AS zero_selected_calls,
         COUNT(*) FILTER (
           WHERE COALESCE(selected_count, 0) > 0
             AND COALESCE(referenced_count, 0) = 0
             AND COALESCE(soft_referenced_count, 0) = 0
             AND COALESCE(decision_summary #>> '{scoring_fallback,reason}', '')
                 NOT IN ('expired_no_response', 'maintenance_expired_no_response')
             AND scored_at IS NOT NULL
         )::int AS selected_no_signal_calls,
         COUNT(*) FILTER (
           WHERE COALESCE(selected_count, 0) > 0
             AND COALESCE(decision_summary #>> '{scoring_fallback,reason}', '')
                 IN ('expired_no_response', 'maintenance_expired_no_response')
         )::int AS no_scorable_output_calls,
         COALESCE(SUM(selected_count), 0)::int AS selected_total,
         COALESCE(SUM(soft_referenced_count), 0)::int AS soft_referenced_total,
         MAX(injected_at) AS last_seen_at
       FROM brainx_runtime_injections
       WHERE injected_at >= NOW() - make_interval(days => $1)
       GROUP BY 1, 2
       HAVING COUNT(*) >= $2
       ORDER BY zero_selected_calls DESC, selected_no_signal_calls DESC, calls DESC
       LIMIT 25`,
      [days, thresholds.minCalls]
    ),
    hasQueryLogTable
      ? db.query(
        `SELECT
           query_kind AS surface,
           COUNT(*)::int AS calls,
           COUNT(*) FILTER (WHERE COALESCE(results_count, 0) = 0)::int AS zero_result_calls,
           COALESCE(SUM(results_count), 0)::int AS result_total,
           ROUND(AVG(duration_ms)::numeric, 1) AS avg_latency_ms,
           MAX(created_at) AS last_seen_at
         FROM brainx_query_log
         WHERE created_at >= NOW() - make_interval(days => $1)
           AND query_kind IN ('inject', 'contradiction_check')
         GROUP BY query_kind
         ORDER BY calls DESC`,
        [days]
      )
      : { rows: [] },
  ]);

  // AGENT_ATTRIBUTION_20260601: per-agent breakdown of the query_log surfaces
  // (inject). Now that brainx_query_log records `agent`, recall-health can flag a
  // single agent whose inject recall regressed even when the aggregate looks fine —
  // the same per-agent outlier detection runtime_injections already had. Rows with a
  // null agent (pre-attribution history or unattributed CLI calls) are skipped.
  const agentQueryLogRes = hasQueryLogTable
    ? await db.query(
      `SELECT
         agent,
         query_kind AS surface,
         COUNT(*)::int AS calls,
         COUNT(*) FILTER (WHERE COALESCE(results_count, 0) = 0)::int AS zero_result_calls,
         COALESCE(SUM(results_count), 0)::int AS result_total,
         MAX(created_at) AS last_seen_at
       FROM brainx_query_log
       WHERE created_at >= NOW() - make_interval(days => $1)
         AND query_kind IN ('inject', 'contradiction_check')
         AND agent IS NOT NULL
       GROUP BY agent, query_kind
       HAVING COUNT(*) >= $2
       ORDER BY zero_result_calls DESC, calls DESC
       LIMIT 25`,
      [days, thresholds.minCalls]
    )
    : { rows: [] };

  // Baseline window = the period BEFORE the current window (from baselineDays ago
  // to `days` ago). Each surface is judged against its own prior norm so the
  // thermometer self-calibrates instead of relying on hand-tuned fixed numbers.
  const baselineRes = ADAPTIVE.enabled
    ? await db.query(
      `SELECT
         surface,
         COUNT(*)::int AS calls,
         COUNT(*) FILTER (WHERE COALESCE(raw_count, 0) = 0)::int AS zero_result_calls,
         COUNT(*) FILTER (WHERE COALESCE(selected_count, 0) = 0)::int AS zero_selected_calls,
         COUNT(*) FILTER (
           WHERE COALESCE(selected_count, 0) > 0
             AND COALESCE(referenced_count, 0) = 0
             AND COALESCE(soft_referenced_count, 0) = 0
             AND COALESCE(decision_summary #>> '{scoring_fallback,reason}', '')
                 NOT IN ('expired_no_response', 'maintenance_expired_no_response')
             AND scored_at IS NOT NULL
         )::int AS selected_no_signal_calls,
         COALESCE(SUM(selected_count), 0)::int AS selected_total,
         COALESCE(SUM(soft_referenced_count), 0)::int AS soft_referenced_total
       FROM brainx_runtime_injections
       WHERE injected_at >= NOW() - make_interval(days => $1)
         AND injected_at < NOW() - make_interval(days => $2)
       GROUP BY surface`,
      [baselineDays, days]
    )
    : { rows: [] };

  const baselineBySurface = new Map();
  for (const r of baselineRes.rows || []) {
    baselineBySurface.set(r.surface, {
      calls: toNumber(r.calls),
      selected_total: toNumber(r.selected_total),
      zero_result_rate_pct: pct(r.zero_result_calls, r.calls),
      zero_selected_rate_pct: pct(r.zero_selected_calls, r.calls),
      selected_no_signal_rate_pct: pct(r.selected_no_signal_calls, r.calls),
      soft_signal_rate_pct: pct(r.soft_referenced_total, r.selected_total),
    });
  }

  // QUERY_LOG_ADAPTIVE_BASELINE_20260601: surfaces that only live in brainx_query_log
  // (inject, contradiction_check) never had a prior-window baseline, so they were
  // stuck on the fixed cold-start threshold forever — the one surface that could not
  // self-calibrate. Build their baseline from the same prior window so they join the
  // adaptive thermometer and only warn on a genuine regression vs their own norm.
  // Self-test traffic (query_kind=inject_selftest) is already excluded by construction.
  const baselineQueryLogRes = (ADAPTIVE.enabled && hasQueryLogTable)
    ? await db.query(
      `SELECT
         query_kind AS surface,
         COUNT(*)::int AS calls,
         COUNT(*) FILTER (WHERE COALESCE(results_count, 0) = 0)::int AS zero_result_calls
       FROM brainx_query_log
       WHERE created_at >= NOW() - make_interval(days => $1)
         AND created_at < NOW() - make_interval(days => $2)
         AND query_kind IN ('inject', 'contradiction_check')
       GROUP BY query_kind`,
      [baselineDays, days]
    )
    : { rows: [] };
  for (const r of baselineQueryLogRes.rows || []) {
    // Only fill if a runtime_injections baseline did not already claim this surface.
    if (baselineBySurface.has(r.surface)) continue;
    const zr = pct(r.zero_result_calls, r.calls);
    baselineBySurface.set(r.surface, {
      calls: toNumber(r.calls),
      selected_total: 0,
      zero_result_rate_pct: zr,
      // query_log path mirrors zero_selected onto zero_result (no selection signal there).
      zero_selected_rate_pct: zr,
      selected_no_signal_rate_pct: 0,
      soft_signal_rate_pct: 0,
    });
  }

  const bySurface = new Map(surfaceRes.rows.map((row) => [row.surface, row]));
  for (const row of queryLogRes.rows || []) {
    const existing = bySurface.get(row.surface);
    if (existing && toNumber(existing.calls) > 0) {
      existing.query_log = {
        calls: toNumber(row.calls),
        zero_result_calls: toNumber(row.zero_result_calls),
        zero_result_rate_pct: pct(row.zero_result_calls, row.calls),
        result_total: toNumber(row.result_total),
        avg_latency_ms: row.avg_latency_ms === null || row.avg_latency_ms === undefined ? null : Number(row.avg_latency_ms),
        last_seen_at: row.last_seen_at || null,
      };
      continue;
    }
    bySurface.set(row.surface, {
      surface: row.surface,
      calls: toNumber(row.calls),
      zero_result_calls: toNumber(row.zero_result_calls),
      zero_selected_calls: toNumber(row.zero_result_calls),
      selected_no_signal_calls: 0,
      no_scorable_output_calls: 0,
      stale_selected_unscored: 0,
      selected_total: toNumber(row.result_total),
      hard_referenced_total: 0,
      soft_referenced_total: toNumber(row.result_total),
      avg_latency_ms: row.avg_latency_ms,
      last_seen_at: row.last_seen_at || null,
      source: 'query_log',
      query_log: {
        calls: toNumber(row.calls),
        zero_result_calls: toNumber(row.zero_result_calls),
        zero_result_rate_pct: pct(row.zero_result_calls, row.calls),
        result_total: toNumber(row.result_total),
        avg_latency_ms: row.avg_latency_ms === null || row.avg_latency_ms === undefined ? null : Number(row.avg_latency_ms),
        last_seen_at: row.last_seen_at || null,
      },
    });
  }
  for (const surface of EXPECTED_SURFACES) {
    if (!bySurface.has(surface)) {
      bySurface.set(surface, {
        surface,
        calls: 0,
        zero_result_calls: 0,
        zero_selected_calls: 0,
        selected_no_signal_calls: 0,
        no_scorable_output_calls: 0,
        stale_selected_unscored: 0,
        selected_total: 0,
        hard_referenced_total: 0,
        soft_referenced_total: 0,
        avg_latency_ms: null,
        last_seen_at: null,
      });
    }
  }

  const surfaces = Array.from(bySurface.values())
    .map((row) => {
      const classified = classifySurface(row, thresholds, baselineBySurface.get(row.surface));
      return {
        surface: row.surface,
        status: classified.status,
        warnings: classified.warnings,
        notes: classified.notes,
        calls: toNumber(row.calls),
        zero_result_calls: toNumber(row.zero_result_calls),
        zero_selected_calls: toNumber(row.zero_selected_calls),
        selected_no_signal_calls: toNumber(row.selected_no_signal_calls),
        no_scorable_output_calls: toNumber(row.no_scorable_output_calls),
        stale_selected_unscored: toNumber(row.stale_selected_unscored),
        selected_total: toNumber(row.selected_total),
        hard_referenced_total: toNumber(row.hard_referenced_total),
        soft_referenced_total: toNumber(row.soft_referenced_total),
        avg_latency_ms: row.avg_latency_ms === null || row.avg_latency_ms === undefined ? null : Number(row.avg_latency_ms),
        last_seen_at: row.last_seen_at || null,
        source: row.source || 'runtime_injections',
        query_log: row.query_log || null,
        calibration: classified.calibration || null,
        ...classified.metrics,
      };
    })
    .sort((a, b) => b.calls - a.calls || a.surface.localeCompare(b.surface));

  // AGENT_ATTRIBUTION_20260601: query_log per-agent rows expose only a zero-result
  // signal, so map zero_selected onto zero_result (no selection telemetry in that
  // path) and judge each agent against the aggregate surface baseline, consistent
  // with how runtime_injections outliers are classified above.
  const agentQueryLogRows = (agentQueryLogRes.rows || []).map((row) => ({
    agent: row.agent,
    surface: row.surface,
    calls: toNumber(row.calls),
    zero_result_calls: toNumber(row.zero_result_calls),
    zero_selected_calls: toNumber(row.zero_result_calls),
    selected_no_signal_calls: 0,
    no_scorable_output_calls: 0,
    selected_total: toNumber(row.result_total),
    soft_referenced_total: toNumber(row.result_total),
    last_seen_at: row.last_seen_at || null,
  }));

  const outliers = [...agentSurfaceRes.rows, ...agentQueryLogRows]
    .map((row) => {
      const classified = classifySurface(row, thresholds, baselineBySurface.get(row.surface));
      return {
        agent: row.agent,
        surface: row.surface,
        status: classified.status,
        warnings: classified.warnings,
        notes: classified.notes,
        calls: toNumber(row.calls),
        zero_result_rate_pct: classified.metrics.zero_result_rate_pct,
        zero_selected_rate_pct: classified.metrics.zero_selected_rate_pct,
        selected_no_signal_rate_pct: classified.metrics.selected_no_signal_rate_pct,
        no_scorable_output_calls: toNumber(row.no_scorable_output_calls),
        soft_signal_rate_pct: classified.metrics.soft_signal_rate_pct,
        selected_total: toNumber(row.selected_total),
        soft_referenced_total: toNumber(row.soft_referenced_total),
        last_seen_at: row.last_seen_at || null,
      };
    })
    .filter((row) => row.warnings.length > 0)
    .sort((a, b) => b.zero_result_rate_pct - a.zero_result_rate_pct || b.calls - a.calls)
    .slice(0, 12);

  const warningSurfaces = surfaces.filter((row) => row.status === 'warn');
  return {
    ok: warningSurfaces.length === 0,
    status: warningSurfaces.length ? 'warn' : 'ok',
    generated_at: new Date().toISOString(),
    window_days: days,
    baseline_days: baselineDays,
    calibration_mode: ADAPTIVE.enabled ? 'adaptive_baseline' : 'fixed',
    thresholds,
    summary: {
      surfaces_checked: surfaces.length,
      warning_count: warningSurfaces.length,
      failure_count: 0,
      outlier_count: outliers.length,
    },
    surfaces,
    outliers,
    warnings: warningSurfaces.map((row) => ({
      surface: row.surface,
      warnings: row.warnings,
      notes: row.notes,
      calls: row.calls,
      zero_result_rate_pct: row.zero_result_rate_pct,
      zero_selected_rate_pct: row.zero_selected_rate_pct,
      selected_no_signal_rate_pct: row.selected_no_signal_rate_pct,
      no_scorable_output_calls: row.no_scorable_output_calls,
      soft_signal_rate_pct: row.soft_signal_rate_pct,
      stale_selected_unscored: row.stale_selected_unscored,
    })),
  };
}

function formatRecallHealth(payload) {
  const lines = [];
  lines.push(`BrainX Recall Health — ${payload.window_days}d`);
  lines.push(`status=${payload.status} warnings=${payload.summary.warning_count} outliers=${payload.summary.outlier_count || 0}`);
  lines.push('');
  lines.push('Surfaces:');
  for (const row of payload.surfaces) {
    const warn = row.warnings.length ? ` warnings=${row.warnings.join(',')}` : '';
    const notes = row.notes?.length ? ` notes=${row.notes.join(',')}` : '';
    lines.push(`- ${row.surface}: calls=${row.calls} zero_result=${row.zero_result_rate_pct}% zero_selected=${row.zero_selected_rate_pct}% selected_no_signal=${row.selected_no_signal_rate_pct}% no_scorable=${row.no_scorable_output_calls || 0} soft_signal=${row.soft_signal_rate_pct}% stale=${row.stale_selected_unscored}${warn}${notes}`);
  }
  if (payload.outliers.length) {
    lines.push('');
    lines.push('Outliers:');
    for (const row of payload.outliers) {
      lines.push(`- ${row.agent} / ${row.surface}: calls=${row.calls} zero_selected=${row.zero_selected_rate_pct}% selected_no_signal=${row.selected_no_signal_rate_pct}% soft_signal=${row.soft_signal_rate_pct}% warnings=${row.warnings.join(',')}`);
    }
  }
  return lines.join('\n');
}

module.exports = {
  DEFAULT_DAYS,
  DEFAULT_THRESHOLDS,
  EXPECTED_SURFACES,
  classifySurface,
  collectRecallHealth,
  formatRecallHealth,
  parseThresholds,
};
