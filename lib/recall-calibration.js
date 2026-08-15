// recall-calibration.js — BRAINX_RECALL_AUTOCALIBRATION_20260629
//
// Self-calibrating, provider-relative similarity normalization. The recall thresholds
// scattered across cli.js / the plugin (0.55, 0.58, 0.68, 0.82, 0.45, trigger 0.6, ...)
// were hand-tuned against OpenAI text-embedding-3-small's cosine distribution. A different
// embedding model (e.g. Gemini gemini-embedding-001) has a SHIFTED distribution (its noise
// floor sits where OpenAI's signal sits), so those constants silently break on a provider
// swap — and nobody should ever hand-retune them again.
//
// Fix: map the active provider's similarity onto the canonical OpenAI ("reference") range
// with a monotonic affine transform  sim_norm = clamp(raw*scale + offset, 0, 1). Monotonic
// => ranking is preserved (the better model still ranks better); range-matched => every
// downstream threshold keeps meaning what it meant for OpenAI. scale/offset are MEASURED
// automatically by scripts/calibrate-recall.js (noise floor from random pairs, signal
// ceiling from real-query top-1) and written to the JSON below. Default = identity
// (scale 1 / offset 0) => OpenAI behavior is byte-for-byte unchanged until a non-identity
// calibration exists for the active provider.

const fs = require('fs');
const path = require('path');

const CALIB_PATH = process.env.BRAINX_RECALL_CALIBRATION_PATH ||
  path.join(process.env.HOME || require('os').homedir(), '.openclaw', 'state', 'brainx', 'recall-calibration.json');

let _cache = null;

function _load() {
  if (_cache) return _cache;
  let json = {};
  try { json = JSON.parse(fs.readFileSync(CALIB_PATH, 'utf8')); } catch (_) { json = {}; }
  _cache = json;
  return json;
}

function activeProvider() {
  return (process.env.BRAINX_EMBED_PROVIDER || 'openai').toLowerCase();
}

// Physical column holding the ACTIVE provider's vectors. Column-select (vs renaming) makes
// a provider cutover restart-timing-independent and never inconsistent: the old process keeps
// reading openai's `embedding` until it restarts into the new provider's column. Default
// 'embedding' => OpenAI behavior unchanged. Override via BRAINX_EMBED_COLUMN or config.columns.
function activeColumn() {
  const env = process.env.BRAINX_EMBED_COLUMN;
  if (env && /^[a-z_][a-z0-9_]*$/i.test(env)) return env;
  const json = _load();
  const p = activeProvider();
  const c = json.columns && json.columns[p];
  if (c && /^[a-z_][a-z0-9_]*$/i.test(c)) return c;
  return 'embedding';
}

// Returns { scale, offset } for the active provider; identity if uncalibrated/disabled.
function getActiveCalibration() {
  if (/^(0|false|off|no)$/i.test(String(process.env.BRAINX_RECALL_AUTOCALIBRATION ?? '1').trim())) {
    return { scale: 1, offset: 0, identity: true };
  }
  const json = _load();
  const p = activeProvider();
  const entry = json.providers && json.providers[p];
  if (!entry || typeof entry.scale !== 'number' || typeof entry.offset !== 'number') {
    return { scale: 1, offset: 0, identity: true };
  }
  const identity = Math.abs(entry.scale - 1) < 1e-9 && Math.abs(entry.offset) < 1e-9;
  return { scale: entry.scale, offset: entry.offset, identity };
}

// SQL fragment computing the (normalized) cosine similarity for use in SELECT/score.
// Identity calibration emits the ORIGINAL expression verbatim (zero behavior change).
function similaritySql(embeddingCol, qParam = '$1') {
  const cal = getActiveCalibration();
  const raw = `1 - (${embeddingCol} <=> ${qParam}::vector)`;
  if (cal.identity) return raw;
  return `LEAST(1, GREATEST(0, (${raw}) * ${cal.scale} + (${cal.offset})))`;
}

module.exports = { getActiveCalibration, similaritySql, activeColumn, CALIB_PATH, activeProvider, _resetCache: () => { _cache = null; } };
