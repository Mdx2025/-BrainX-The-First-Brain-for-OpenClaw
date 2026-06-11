#!/usr/bin/env node
/**
 * Fase 0.1: Reclassify existing memories
 * Sets category + recalculates importance for uncategorized memories
 * Uses heuristic rules (no LLM needed for this batch)
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const db = require('../lib/db');

// RECLASSIFY_EXPAND_20260419: category rules extended to cover the 33 knowledge
// domains in use (finanzas, marketing, legal, clientes, propuestas, etc.). Rules
// are evaluated in order; most specific first so broader ones don't swallow
// domain matches. Keep regex conservative — false positives pollute category
// stats, so prefer domain-specific nouns/verbs rather than generic words.
const CATEGORY_RULES = [
  // --- Domain rules (specific) ---
  { match: /\b(factura|facturaci[oó]n|invoice|billing|pago|cobro|cobranza|ingreso|egreso|gasto|cuenta\s*bancaria|banco|transferencia|stripe|paypal|mercadopago|wise|impuesto|iva|comisi[oó]n|presupuesto|budget|payment|tax|n[oó]mina|payroll|saldo|deuda|cr[eé]dito|d[eé]bito|finanzas|financiero|trading|inversi[oó]n|investment|mercado|stock|crypto|cripto|bitcoin)\b/i, category: 'financial', typeHint: 'fact' },
  { match: /\b(cliente|customer|prospect|lead|propuesta|cotizaci[oó]n|oferta|venta|sales|deal|negociaci[oó]n|pipeline|crm|onboarding|renovaci[oó]n|upsell|downsell|churn|partnership|partner|alianza|vendor|proveedor)\b/i, category: 'client', typeHint: 'fact' },
  { match: /\b(seo|sem|marketing|campa[nñ]a|campaign|keyword|ranking|backlink|analytics\s*(de|para)|conversi[oó]n|funnel|landing\s*page|lead\s*magnet|brand|branding|marca|logo|identidad|email\s*marketing|newsletter|audiencia|target|buyer\s*persona|tr[aá]fico|impresiones|ctr|cpa|cpc|roi|roas|influencer)\b/i, category: 'marketing', typeHint: 'fact' },
  { match: /\b(figma|dise[nñ]o|design|ui|ux|mockup|prototipo|prototype|wireframe|sistema\s*de\s*dise[nñ]o|design\s*system|usabilidad|usability|user\s*flow|journey|component|componente|tipograf[ií]a|palette|paleta|color\s*scheme)\b/i, category: 'design', typeHint: 'fact' },
  { match: /\b(contrato|contract|acuerdo|nda|t[eé]rminos|cl[aá]usula|legal|ley|law|normativa|compliance|regulaci[oó]n|propiedad\s*intelectual|copyright|trademark|privacidad|privacy|gdpr|licencia|license)\b/i, category: 'legal', typeHint: 'fact' },
  { match: /\b(correo|email|mail|inbox|bandeja|respuesta\s*(a|del?)\s*correo|reply|newsletter|boletin|suscripci[oó]n|suscriptor|llamada|call\s*(con|de|para)|reuni[oó]n|meeting|zoom|google\s*meet|agenda|calendario|cita|appointment)\b/i, category: 'communication', typeHint: 'fact' },
  { match: /\b(producto|product\s*(road|feat|launch)|roadmap|feature(?:s|\s)|release\s*(plan|note)|mvp|beta|stakeholder|backlog)\b/i, category: 'product', typeHint: 'fact' },
  { match: /\b(workflow|kanban|trello|notion|asana|automatizaci[oó]n|automation|plantilla|template|checklist|sop|procedimiento|contrataci[oó]n|hiring|empleado|empleada|freelancer|equipo\s*(de|para)|manager|l[ií]der|delegaci[oó]n|delivery|deadline|vencimiento|entrega)\b/i, category: 'operations', typeHint: 'fact' },
  { match: /\b(contenido|content|post|art[ií]culo|article|blog|video|reel|historia|story|shorts|caption|hook|gui[oó]n|copy|copywriting|publicaci[oó]n|draft|borrador|thread|tweet|tuit|instagram|twitter|tiktok|linkedin|youtube|pinterest|medium|substack|redes\s*sociales|social\s*media|feed|perfil|bio)\b/i, category: 'content', typeHint: 'fact' },
  { match: /\b(research|investigaci[oó]n|an[aá]lisis|analysis|estudio|estudios|paper|informe|reporte|datos|data|estad[ií]stica|statistic|survey|encuesta|m[eé]trica|kpi|dashboard)\b/i, category: 'research', typeHint: 'fact' },
  { match: /\b(deploy|deployment|rollback|migration|hotfix|release|ci\/cd|railway|vercel|systemd|docker|kubernetes|pipeline|build\s*(failed|ok)|integration|production|prod)\b/i, category: 'infrastructure', typeHint: 'fact' },
  // --- Generic rules (fallback, original set) ---
  { match: /error|fail|crash|bug|broke|fix|wrong|issue/i, category: 'error', typeHint: 'learning' },
  { match: /learn|realiz|discover|found out|turns out|actually/i, category: 'learning', typeHint: 'learning' },
  { match: /decid|chose|decision|switch|migrat|adopt|use.*instead/i, category: null, typeHint: 'decision' },
  { match: /gotcha|careful|watch out|trap|caveat|warning|don't|avoid/i, category: 'correction', typeHint: 'gotcha' },
  { match: /feature|request|want|need|wish|should add/i, category: 'feature_request', typeHint: 'feature_request' },
  { match: /best practice|pattern|convention|always|never|rule/i, category: 'best_practice', typeHint: 'note' },
  { match: /gap|missing|didn't know|unknown|unclear/i, category: 'knowledge_gap', typeHint: 'learning' },
];

function classifyContent(content, type) {
  for (const rule of CATEGORY_RULES) {
    if (rule.match.test(content)) {
      return { category: rule.category, suggestedType: rule.typeHint };
    }
  }
  return { category: null, suggestedType: type };
}

function scoreImportance(content, tier, accessCount) {
  let score = 5;
  // Length bonus: detailed memories are more valuable
  if (content.length > 500) score += 1;
  if (content.length > 1000) score += 1;
  // Tier bonus
  if (tier === 'hot') score += 1;
  // Access bonus
  if (accessCount > 3) score += 1;
  if (accessCount > 10) score += 1;
  // Cap at 10
  return Math.min(10, Math.max(1, score));
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  
  const result = await db.query(`
    SELECT id, type, content, context, tier, importance, access_count, category, status
    FROM brainx_memories
    WHERE superseded_by IS NULL
    ORDER BY created_at ASC
  `);

  let updated = 0;
  let skipped = 0;
  const stats = { categories: {}, types: {} };

  for (const row of result.rows) {
    const { category, suggestedType } = classifyContent(row.content, row.type);
    const newImportance = scoreImportance(row.content, row.tier, row.access_count || 0);
    
    const needsUpdate = (
      (!row.category && category) ||
      row.status === 'pending' ||
      row.importance !== newImportance
    );

    if (!needsUpdate) {
      skipped++;
      continue;
    }

    const finalCategory = row.category || category; // don't overwrite existing
    stats.categories[finalCategory || 'uncategorized'] = (stats.categories[finalCategory || 'uncategorized'] || 0) + 1;
    stats.types[suggestedType] = (stats.types[suggestedType] || 0) + 1;

    if (!dryRun) {
      await db.query(`
        UPDATE brainx_memories
        SET category = COALESCE($2, category),
            importance = $3,
            status = CASE WHEN status = 'pending' THEN 'promoted' ELSE status END
        WHERE id = $1
      `, [row.id, finalCategory, newImportance]);
    }
    updated++;
  }

  console.log(JSON.stringify({
    ok: true,
    dryRun,
    total: result.rows.length,
    updated,
    skipped,
    stats
  }, null, 2));

  process.exit(0);
}

main().catch(e => { console.error(e.message); process.exit(1); });
