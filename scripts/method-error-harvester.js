#!/usr/bin/env node
/**
 * method-error-harvester.js — captura ERRORES DE MÉTODO / DIAGNÓSTICO.
 *
 * Detecta el patrón que ningún otro loop ve: el agente afirma una hipótesis o
 * propone un fix, luego lo corrige tras pushback del usuario o al descubrir la
 * causa real. NO produce fallo de comando/tool, por eso error-harvester
 * (command failures) no lo captura. Lo guarda en BrainX como `gotcha` para que
 * el próximo agente reciba la corrección vía jitRecall ANTES de repetirla.
 *
 * Dos pasadas (precisión):
 *   Pass 1 — heurística regex barata (alto recall) encuentra episodios candidatos.
 *   Pass 2 — confirmación LLM por el gateway agent (cost-0, gpt-5.5 OAuth vía
 *            lib/agent-llm.js): confirma que es real y extrae un gotcha
 *            estructurado, a nivel de método y síntoma-primero (para que el
 *            embedding matchee tareas análogas, no solo la misma plataforma).
 *
 * Modos:
 *   --shadow   (DEFAULT) escanea + confirma + REPORTA, no escribe a BrainX.
 *   --capture            escribe los gotchas confirmados (single-shot, recurrence=1).
 *
 * Seguridad:
 *   - type=gotcha: SOLO fact/decision/gotcha son inyectables (bridge.ts:77).
 *   - tier por defecto `cold` (staged, NO inyectado) hasta que confíes; luego
 *     `--tier warm`/`hot` para que cruce el signal gate (importance>=7, sim>=0.72).
 *   - dedup vs gotchas existentes + ledger por-episodio (no re-procesa).
 *   - gate de confianza LLM (--min-confidence).
 *
 * Uso:
 *   node method-error-harvester.js [--days 2] [--agent X] [--top 12]
 *        [--shadow|--capture] [--tier cold|warm|hot] [--min-confidence 0.75]
 *        [--max-write 8] [--json]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const BRAINX_DIR = path.join(__dirname, '..');
const BRAINX_CLI = path.join(BRAINX_DIR, 'brainx');
const DATA_DIR = path.join(BRAINX_DIR, 'data');
const SEEN_FILE = path.join(DATA_DIR, 'method-errors-seen.json');
const HOME = process.env.HOME || '/home/clawd';
const AGENTS_DIR = path.join(HOME, '.openclaw', 'agents');
const { callAgentLLM, extractJson } = require(path.join(BRAINX_DIR, 'lib', 'agent-llm'));

function parseArgs(argv) {
  const a = { days: 2, agent: null, top: 12, json: false, capture: false, tier: 'cold', minConfidence: 0.75, maxWrite: 8 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--days') a.days = parseInt(argv[++i], 10) || 2;
    else if (k === '--agent') a.agent = argv[++i];
    else if (k === '--top') a.top = parseInt(argv[++i], 10) || 12;
    else if (k === '--json') a.json = true;
    else if (k === '--capture') a.capture = true;
    else if (k === '--shadow') a.capture = false;
    else if (k === '--tier') a.tier = argv[++i];
    else if (k === '--min-confidence') a.minConfidence = parseFloat(argv[++i]) || 0.75;
    else if (k === '--max-write') a.maxWrite = parseInt(argv[++i], 10) || 8;
  }
  return a;
}
const args = parseArgs(process.argv.slice(2));
const SINCE = Date.now() - args.days * 86400_000;

// ── Léxico de auto-corrección (Pass 1, igual que el prototipo calibrado) ──
const SELF_CORRECTION = [
  /\bme equivoqu[ée]\b/i, /\bestaba (?:equivocad|mal\b)/i, /\bmi error (?:fue|estuvo|es)\b/i,
  /\bsalt[ée] a (?:la )?conclusi/i, /\bme sobrepas[ée]\b/i, /\bdije de m[áa]s\b/i,
  /\bten[íi]as raz[óo]n\b/i, /\bno era .{0,40}\bsino\b/i, /\bel (?:problema|error|fallo|tema) real\b/i,
  /\bresulta que (?:no|el|la|s[íi])/i, /\ben realidad (?:el|la|no|s[íi]|era)\b/i,
  /\bcorrijo\b/i, /\bperd[óo]n,? (?:era|es|el|la|me)/i,
  /\bi was wrong\b/i, /\bmy mistake\b/i, /\bi jumped to\b/i, /\bi assumed\b.{0,60}\b(but|however)\b/i,
  /\byou(?:'re| were| are) right\b/i, /\bthe real (?:issue|cause|problem|reason)\b/i,
  /\bturns out (?:it|the|that)\b/i, /\bactually,? (?:it|the|that) .{0,40}\bwas\b/i,
  /\bi overclaimed\b/i, /\bi should have\b/i,
];
const HYPOTHESIS = [
  /\bes (?:porque|por que|debido)/i, /\bel problema es\b/i, /\bseguramente\b/i, /\bdebe ser\b/i,
  /\bhay que (?:cambiar|setear|configurar|darle acceso|habilitar)/i, /\bpedir(?:te|le)? que\b/i,
  /\bnecesitas (?:cambiar|configurar|darle|habilitar)/i,
  /\bit'?s (?:because|due to)\b/i, /\byou need to (?:change|set|configure|grant|enable)/i,
];
const USER_PUSHBACK = [
  /\bno\b.{0,30}\b(es|era|fue|eso)\b/i, /\beso ya (?:estaba|est[áa])\b/i, /\bte equivoc/i,
  /\best  ?as? equivocad/i, /\bno es eso\b/i, /\bpero (?:eso|no)\b/i, /\brevisa\b/i,
  /\bthat'?s (?:wrong|not)\b/i, /\bno,? (?:it|that|the)\b/i, /\bbut (?:that|it) (?:was|is) (?:fine|ok|already)\b/i,
];
const matchAny = (pats, t) => pats.some((re) => re.test(t));

function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
  }
  return '';
}
function loadSession(file) {
  const msgs = [];
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return msgs; }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'message' || !o.message) continue;
    const role = o.message.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const text = extractText(o.message.content);
    if (!text.trim()) continue;
    msgs.push({ role, text, ts: o.timestamp });
  }
  return msgs;
}
const isNoise = (t) => /responde\s+(?:solo|exactly|con)\b|FUNCIONA|HEARTBEAT_OK|NO_REPLY|^🔔/i.test(t.slice(0, 60));

function scoreEpisode(msgs, i) {
  const cur = msgs[i].text;
  let score = 0; const reasons = [];
  if (matchAny(SELF_CORRECTION, cur)) { score += 2; reasons.push('self_correction_admission'); }
  if (/\bno era .{0,40}\bsino\b/i.test(cur) || /\bthe real (?:issue|cause|problem)\b/i.test(cur)) { score += 1; reasons.push('root_cause_revision'); }
  for (let j = Math.max(0, i - 6); j < i; j++) {
    if (msgs[j].role === 'assistant' && matchAny(HYPOTHESIS, msgs[j].text)) { score += 1; reasons.push('prior_firm_hypothesis'); break; }
  }
  for (let j = Math.max(0, i - 3); j < i; j++) {
    if (msgs[j].role === 'user' && matchAny(USER_PUSHBACK, msgs[j].text)) { score += 1; reasons.push('user_pushback'); break; }
  }
  return { score, reasons };
}
function episodeExcerpt(msgs, i, maxChars = 3500) {
  const from = Math.max(0, i - 6);
  const out = [];
  for (let j = from; j <= i; j++) {
    const m = msgs[j];
    out.push(`${m.role === 'user' ? 'USER' : 'ASSISTANT'}: ${m.text.replace(/\s+/g, ' ').trim()}`);
  }
  let s = out.join('\n\n');
  if (s.length > maxChars) s = s.slice(s.length - maxChars); // conservar el final (la corrección)
  return s;
}

// ── Ledger de episodios ya procesados ──
function loadSeen() { try { return JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')); } catch { return {}; } }
function saveSeen(o) { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(SEEN_FILE, JSON.stringify(o, null, 2)); } catch {} }

// ── Pass 2: confirmación + extracción LLM (cost-0 vía gateway agent) ──
const CONFIRM_PROMPT = `Eres un revisor senior de METODOLOGÍA de agentes de IA. Te paso un extracto de transcript donde un agente PUEDE haber cometido un error de MÉTODO/DIAGNÓSTICO: afirmó una hipótesis o propuso un fix equivocado, y luego lo corrigió tras pushback del usuario o al descubrir la causa real.

Tu trabajo: decidir si es un error de método GENUINO y REUTILIZABLE que valga la pena recordar para que otro agente no lo repita, y extraer un gotcha.

Responde SOLO un objeto JSON (sin prosa, sin fences), con este schema exacto:
{
  "is_method_error": boolean,        // false si es una explicación normal, Q&A trivial, o el agente nunca estuvo equivocado
  "confidence": number,              // 0-1, qué tan seguro estás de que es un error de método real
  "severity": "low"|"medium"|"high",
  "wrong_assumption": string,        // qué asumió mal el agente
  "real_root_cause": string,         // cuál era la causa real
  "correct_method": string,          // la regla general de método para no repetirlo
  "gotcha_content": string,          // EL texto a guardar. SÍNTOMA-PRIMERO y GENERALIZABLE: un agente futuro ante un síntoma parecido debe reconocerlo. En español, 1-3 frases, sin secretos ni datos específicos de cuenta/credencial. Generaliza la plataforma (no "en dokploy X" sino "ante <síntoma>, no asumir <X>; verificar <Y>").
  "method_tags": string[],           // 2-4 tags de MÉTODO en kebab-case, ej: ["verify-before-assume","flag-no-implica-estado"]
  "importance": number               // 1-10. Errores de método de alto impacto suelen ser 7-9.
}

Si NO es un error de método real, devuelve {"is_method_error": false, "confidence": <n>} y nada más obligatorio.`;

async function confirmWithLLM(excerpt) {
  const { text } = await callAgentLLM({ system: CONFIRM_PROMPT, user: `Extracto:\n${excerpt}`, label: 'method-error' });
  return extractJson(text);
}

// ── dedup vs gotchas existentes ──
function alreadyKnown(query) {
  try {
    const out = execFileSync(BRAINX_CLI, ['search', '--query', query.slice(0, 300), '--limit', '3', '--minSimilarity', '0.85', '--json'], { encoding: 'utf8', timeout: 30000 });
    const parsed = JSON.parse(out);
    return Array.isArray(parsed.results) && parsed.results.length > 0;
  } catch { return false; }
}

function writeGotcha(c, agent) {
  // Para que el plugin REALMENTE lo recall (bridge.ts decideRecallRow):
  //  - verification_state=verified — 2720 rechaza cualquier otro estado.
  //  - source_kind=agent_inference (SECONDARY) — pasa isVerifiedInferenceRowAllowed
  //    porque category=error califica (bridge.ts:2112) y la fila es reciente.
  //  - tag `cross-agent` — para que OTRO agente pueda recall (bridge.ts:2660).
  //  - tier hot/warm + importance>=7 — cruza el signal gate.
  // Honesto: es una inferencia de agente confirmada por un 2º pase LLM.
  const conf = Math.max(0, Math.min(1, Number(c.confidence) || 0));
  const tags = ['method-error', 'cross-agent', ...(Array.isArray(c.method_tags) ? c.method_tags : [])].slice(0, 7).join(',');
  const imp = Math.max(1, Math.min(10, parseInt(c.importance, 10) || 7));
  execFileSync(BRAINX_CLI, [
    'add', '--type', 'gotcha', '--context', 'brainx:method-errors',
    '--tier', args.tier, '--importance', String(imp), '--tags', tags,
    '--agent', agent, '--content', String(c.gotcha_content || '').slice(0, 1200),
    '--category', 'error', '--sourceKind', 'agent_inference',
    '--verificationState', 'verified', '--confidence', String(conf),
    '--recurrenceCount', '1',
  ], { encoding: 'utf8', timeout: 30000 });
}

// ── Scan (Pass 1) ──
const rawCandidates = [];
let sessionsScanned = 0;
let agents = [];
try { agents = fs.readdirSync(AGENTS_DIR); } catch {}
for (const ag of agents) {
  if (args.agent && ag !== args.agent) continue;
  const sdir = path.join(AGENTS_DIR, ag, 'sessions');
  let files = []; try { files = fs.readdirSync(sdir); } catch { continue; }
  for (const f of files) {
    if (!f.endsWith('.jsonl') || f.endsWith('.trajectory.jsonl')) continue;
    const fp = path.join(sdir, f);
    let st; try { st = fs.statSync(fp); } catch { continue; }
    if (st.mtimeMs < SINCE) continue;
    sessionsScanned++;
    const msgs = loadSession(fp);
    for (let i = 0; i < msgs.length; i++) {
      if (msgs[i].role !== 'assistant') continue;
      if (isNoise(msgs[i].text) || msgs[i].text.length < 150) continue;
      if (!matchAny(SELF_CORRECTION, msgs[i].text)) continue;
      const { score, reasons } = scoreEpisode(msgs, i);
      if (score < 3) continue;
      rawCandidates.push({ agent: ag, session: f.replace('.jsonl', ''), ts: msgs[i].ts, score, reasons, excerpt: episodeExcerpt(msgs, i) });
    }
  }
}
rawCandidates.sort((a, b) => b.score - a.score || String(b.ts).localeCompare(String(a.ts)));

// ── Pass 2 + write ──
(async () => {
  const seen = loadSeen();
  const fresh = rawCandidates.filter((c) => !seen[`${c.agent}:${c.session}:${c.ts}`]);
  const confirmed = [];
  const rejected = [];
  let written = 0, skippedDup = 0, llmErrors = 0;

  for (const c of fresh.slice(0, args.top)) {
    let verdict;
    try { verdict = await confirmWithLLM(c.excerpt); }
    catch (e) { llmErrors++; continue; }
    const key = `${c.agent}:${c.session}:${c.ts}`;
    seen[key] = { at: Date.now(), confidence: verdict?.confidence ?? null };

    if (!verdict?.is_method_error || (verdict.confidence ?? 0) < args.minConfidence) {
      rejected.push({ agent: c.agent, confidence: verdict?.confidence ?? 0, reason: verdict?.is_method_error ? 'low_confidence' : 'not_method_error' });
      continue;
    }
    const rec = { agent: c.agent, session: c.session, ts: c.ts, score: c.score, ...verdict };
    confirmed.push(rec);

    if (args.capture && written < args.maxWrite) {
      const dupQuery = `${verdict.gotcha_content} ${(verdict.method_tags || []).join(' ')}`;
      if (alreadyKnown(dupQuery)) { skippedDup++; rec.action = 'skipped_dup'; continue; }
      try { writeGotcha(verdict, c.agent); written++; rec.action = `written:${args.tier}`; }
      catch (e) { rec.action = `write_error:${(e.message || '').slice(0, 80)}`; }
    } else {
      rec.action = args.capture ? 'skipped_maxwrite' : 'shadow';
    }
  }
  // Solo persistir el ledger cuando capturamos. En SHADOW no se consume: así
  // los mismos episodios siguen frescos para el run real de --capture (si no,
  // la semana de shadow "quemaría" candidatos que nunca se escribieron).
  if (args.capture) saveSeen(seen);

  const summary = {
    mode: args.capture ? `CAPTURE (tier=${args.tier})` : 'SHADOW (no escribe)',
    windowDays: args.days, sessionsScanned,
    candidatesPass1: rawCandidates.length, freshEvaluated: Math.min(fresh.length, args.top),
    confirmed: confirmed.length, rejected: rejected.length,
    written, skippedDup, llmErrors, minConfidence: args.minConfidence,
  };

  if (args.json) {
    console.log(JSON.stringify({ summary, confirmed }, null, 2));
  } else {
    console.log('═══ BrainX Method-Error Harvester ═══');
    console.log(JSON.stringify(summary, null, 2));
    if (confirmed.length) {
      console.log('\n─── Errores de método confirmados ───\n');
      for (const c of confirmed) {
        console.log(`• [${c.agent}] conf=${c.confidence} sev=${c.severity} imp=${c.importance}  → ${c.action || 'shadow'}`);
        console.log(`  gotcha: ${c.gotcha_content}`);
        console.log(`  tags: ${(c.method_tags || []).join(', ')}\n`);
      }
    }
    if (!args.capture) console.log('(SHADOW: nada escrito. Para capturar: --capture [--tier warm])');
  }
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
