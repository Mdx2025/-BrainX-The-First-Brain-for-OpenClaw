#!/usr/bin/env node
/**
 * BrainX V5 — Knowledge Seed Library
 *
 * Creates realistic seed topics for every non-legacy knowledge category.
 * Safe by default: skips existing files unless --force is used.
 *
 * Usage:
 *   node scripts/seed-knowledge-library.js
 *   node scripts/seed-knowledge-library.js --dry-run
 *   node scripts/seed-knowledge-library.js --force
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { TAXONOMY } = require('../lib/knowledge-taxonomy');

const ROOT = path.join(__dirname, '..');
const KNOWLEDGE_DIR = path.join(ROOT, 'knowledge');

const SEEDS = [
  {
    category: 'agency',
    slug: 'service-packaging',
    title: 'Service Packaging',
    tags: ['offers', 'services', 'positioning'],
    query: 'agency service packaging offers scope positioning',
    importance: 9,
    intro: 'Principios para empaquetar servicios de agencia de forma clara, vendible y entregable.',
    rules: [
      'Vender resultados y cambios percibidos, no listas largas de tareas.',
      'Mantener pocas ofertas principales para evitar confusion comercial y operativa.',
      'Cada oferta debe tener limites visibles: alcance, exclusiones, tiempos y formato de entrega.',
    ],
    notes: [
      'Una buena oferta reduce friccion de venta y tambien reduce retrabajo en delivery.',
      'Si el cliente no entiende donde termina el servicio, la propuesta esta mal empaquetada.',
    ],
  },
  {
    category: 'strategy',
    slug: 'focus-doctrine',
    title: 'Focus Doctrine',
    tags: ['focus', 'priorities', 'decision-making'],
    query: 'founder strategy focus priorities tradeoffs execution',
    importance: 9,
    intro: 'Reglas para decidir que merece foco real y que debe esperar.',
    rules: [
      'Priorizar apuestas que aumenten capacidad, reputacion o cashflow; evitar trabajo que solo genere actividad.',
      'No abrir una linea nueva si la actual todavia no tiene una narrativa, oferta y proceso claros.',
      'Si dos prioridades compiten por la misma energia del founder, casi siempre solo una es real.',
    ],
    notes: [
      'La estrategia se degrada cuando todo parece importante al mismo tiempo.',
      'Una prioridad sin sacrificio explicito es solo una preferencia, no una decision.',
    ],
  },
  {
    category: 'operaciones',
    slug: 'project-intake',
    title: 'Project Intake',
    tags: ['ops', 'handoff', 'delivery'],
    query: 'operations project intake scope handoff delivery',
    importance: 8,
    intro: 'Base para abrir proyectos con menos caos, menos huecos y mejor alineacion.',
    rules: [
      'No iniciar trabajo sin objetivo, alcance, owner y criterio de terminado.',
      'Toda entrega debe nacer con dependencias, riesgos y siguiente paso visibles.',
      'Si el inicio del proyecto depende de contexto disperso en chats, el intake aun no esta hecho.',
    ],
    notes: [
      'Un buen intake ahorra mas tiempo que cualquier reactividad heroica posterior.',
      'El handoff correcto convierte claridad comercial en claridad operativa.',
    ],
  },
  {
    category: 'management',
    slug: 'manager-operating-rules',
    title: 'Manager Operating Rules',
    tags: ['leadership', 'accountability', 'team'],
    query: 'management leadership accountability delegation standards',
    importance: 8,
    intro: 'Principios de gestion para mantener autonomia con responsabilidad.',
    rules: [
      'Delegar resultados esperados y criterios de calidad, no solo tareas aisladas.',
      'Corregir problemas de claridad antes de atribuirlos a actitud o compromiso.',
      'La accountability mejora cuando hay ownership y definicion, no solo presion.',
    ],
    notes: [
      'Si una persona depende siempre del founder para avanzar, el sistema esta mal calibrado.',
      'La gestion efectiva reduce friccion de coordinacion sin infantilizar al equipo.',
    ],
  },
  {
    category: 'ventas',
    slug: 'discovery-discipline',
    title: 'Discovery Discipline',
    tags: ['sales', 'discovery', 'closing'],
    query: 'sales discovery qualification closing discipline',
    importance: 8,
    intro: 'Reglas para que discovery descubra decision, urgencia y fit real.',
    rules: [
      'Discovery debe encontrar problema de negocio, no solo preferencias esteticas.',
      'No presentar solucion completa si aun no esta claro el costo de no actuar.',
      'Una oportunidad sin owner, urgencia y criterio de compra no esta calificada.',
    ],
    notes: [
      'La venta se cae mas por diagnostico pobre que por falta de persuasion final.',
      'Discovery bien hecha hace que el cierre parezca una conclusion natural.',
    ],
  },
  {
    category: 'propuestas',
    slug: 'proposal-architecture',
    title: 'Proposal Architecture',
    tags: ['proposals', 'scope', 'pricing'],
    query: 'proposal structure scope pricing narrative deliverables',
    importance: 8,
    intro: 'Como estructurar propuestas para que se entiendan rapido y sostengan el precio.',
    rules: [
      'Abrir con contexto, problema y cambio esperado antes de mostrar entregables.',
      'Separar claramente estrategia, ejecucion y soporte para no licuar valor.',
      'El precio debe estar amarrado a resultado, complejidad y responsabilidad asumida.',
    ],
    notes: [
      'Una propuesta fuerte es una herramienta de venta y tambien de alineacion.',
      'Cuando todo se presenta al mismo nivel, el cliente negocia por confusion.',
    ],
  },
  {
    category: 'clientes',
    slug: 'client-context-template',
    title: 'Client Context Template',
    tags: ['clients', 'context', 'relationships'],
    query: 'client context expectations communication tone constraints',
    importance: 7,
    intro: 'Plantilla mental para guardar contexto duradero de cada cliente.',
    rules: [
      'Documentar tono, tolerancia al riesgo, velocidad esperada y formato preferido de comunicacion.',
      'Separar hechos del cliente de interpretaciones del equipo.',
      'Actualizar solo lo estable; no convertir el archivo en changelog de mensajes.',
    ],
    notes: [
      'La memoria de cliente sirve para continuidad, no para acumular ruido temporal.',
      'Conocer el estilo de decision del cliente evita friccion innecesaria.',
    ],
  },
  {
    category: 'correos',
    slug: 'followup-logic',
    title: 'Followup Logic',
    tags: ['emails', 'followups', 'outreach'],
    query: 'email followup sequence tone timing objections',
    importance: 8,
    intro: 'Reglas para followups que empujan la conversacion sin sonar desesperados.',
    rules: [
      'Cada followup debe agregar contexto, claridad o una nueva razon para responder.',
      'No repetir el mismo mensaje con palabras distintas; cambiar angulo o utilidad.',
      'La insistencia sin valor deteriora marca y reduce respuesta futura.',
    ],
    notes: [
      'Un followup bueno se siente facil de contestar.',
      'La secuencia debe respetar timing, energia del lead y friccion percibida.',
    ],
  },
  {
    category: 'partnerships',
    slug: 'partner-fit',
    title: 'Partner Fit',
    tags: ['partnerships', 'alliances', 'referrals'],
    query: 'partnership fit referrals collaboration leverage',
    importance: 7,
    intro: 'Como evaluar si una alianza realmente agrega apalancamiento mutuo.',
    rules: [
      'Buscar partners con audiencia, credibilidad o distribucion complementaria, no redundante.',
      'Definir intercambio de valor antes de hablar de colaboracion recurrente.',
      'Una partnership sin ownership y sin flujo claro de oportunidades se enfria rapido.',
    ],
    notes: [
      'Las alianzas buenas simplifican adquisicion o ejecucion; las malas solo agregan coordinacion.',
      'El fit importa mas que el entusiasmo inicial.',
    ],
  },
  {
    category: 'hiring',
    slug: 'hiring-scorecard',
    title: 'Hiring Scorecard',
    tags: ['hiring', 'team', 'evaluation'],
    query: 'hiring scorecard talent evaluation role fit',
    importance: 7,
    intro: 'Principios para evaluar talento sin improvisacion ni sesgo excesivo.',
    rules: [
      'Definir primero resultados esperados del rol y luego evaluar capacidad de producirlos.',
      'Separar skills tecnicos, criterio, comunicacion y ownership en la evaluacion.',
      'No contratar solo por simpatia, velocidad o desesperacion operativa.',
    ],
    notes: [
      'Cada mala contratacion castiga dos veces: por costo directo y por complejidad de correccion.',
      'Una scorecard buena reduce debates vagos despues de la entrevista.',
    ],
  },
  {
    category: 'marketing',
    slug: 'funnel-angles',
    title: 'Funnel Angles',
    tags: ['marketing', 'funnels', 'offers'],
    query: 'marketing funnel angles positioning conversion offers',
    importance: 8,
    intro: 'Angulos de funnel que convierten mejor cuando conectan mensaje con dolor real.',
    rules: [
      'Abrir con problema de negocio y no solo con promesa aspiracional.',
      'Cada funnel necesita una tension clara entre estado actual y estado deseado.',
      'La oferta debe sentirse especifica para alguien, no acceptable para todos.',
    ],
    notes: [
      'Los mejores angulos suelen combinar claridad, consecuencia y deseo tangible.',
      'Marketing flojo habla de valor; marketing fuerte lo hace visible.',
    ],
  },
  {
    category: 'seo',
    slug: 'technical-audit',
    title: 'Technical Audit',
    tags: ['seo', 'technical', 'audits'],
    query: 'seo technical audit indexing crawling performance',
    importance: 8,
    intro: 'Criterios base para auditorias SEO tecnicas con foco en impacto real.',
    rules: [
      'Revisar primero indexacion, crawling y rendering antes de entrar a ajustes menores.',
      'Separar blockers de rendimiento de mejoras incrementales para priorizar mejor.',
      'No mezclar hallazgos tecnicos con estrategia editorial dentro del mismo bloque de accion.',
    ],
    notes: [
      'El audit tecnico debe ayudar a decidir, no solo listar problemas.',
      'Priorizar visibilidad y accesibilidad del contenido antes de refinamientos cosmeticos.',
    ],
  },
  {
    category: 'contenido',
    slug: 'editorial-principles',
    title: 'Editorial Principles',
    tags: ['content', 'editorial', 'quality'],
    query: 'content editorial principles quality differentiation',
    importance: 7,
    intro: 'Principios para producir contenido util, legible y con identidad.',
    rules: [
      'Escribir para claridad y decision, no para relleno o volumen vacio.',
      'Cada pieza debe tener una idea central defendible y un lector claro.',
      'La calidad editorial mejora cuando el contenido resuelve una tension concreta.',
    ],
    notes: [
      'Buen contenido combina criterio, estructura y ritmo.',
      'Publicar mucho sin voz propia erosiona la marca en lugar de fortalecerla.',
    ],
  },
  {
    category: 'copywriting',
    slug: 'offer-messaging',
    title: 'Offer Messaging',
    tags: ['copy', 'offers', 'messaging'],
    query: 'copywriting offer messaging differentiation belief shift',
    importance: 8,
    intro: 'Como escribir mensajes de oferta que muevan percepcion y accion.',
    rules: [
      'El mensaje debe cambiar una creencia o aclarar una confusion, no solo adornar.',
      'La especificidad vende mejor que la grandilocuencia.',
      'Titular, subcopy y CTA deben empujar la misma idea, no competir entre si.',
    ],
    notes: [
      'Copys buenos reducen esfuerzo mental y aumentan confianza.',
      'La mejor persuasion suele venir de claridad mas que de agresividad.',
    ],
  },
  {
    category: 'ads',
    slug: 'paid-testing-rules',
    title: 'Paid Testing Rules',
    tags: ['ads', 'testing', 'creative'],
    query: 'ads testing rules creative targeting iterations',
    importance: 7,
    intro: 'Reglas para correr tests de paid media con mas aprendizaje y menos ruido.',
    rules: [
      'Testear una variable principal a la vez cuando el volumen lo permita.',
      'Separar claramente hipotesis de oferta, mensaje, audiencia y creativo.',
      'No matar una idea antes de entender si fallo por angulo, ejecucion o targeting.',
    ],
    notes: [
      'Testing desordenado produce actividad, no conocimiento.',
      'La consistencia de naming y lectura ahorra dinero y tiempo.',
    ],
  },
  {
    category: 'social-media',
    slug: 'channel-role',
    title: 'Channel Role',
    tags: ['social', 'distribution', 'platforms'],
    query: 'social media channel role content distribution positioning',
    importance: 6,
    intro: 'Cada canal debe tener una funcion clara dentro del sistema de contenido.',
    rules: [
      'No publicar lo mismo en todas las plataformas sin adaptar contexto y formato.',
      'Asignar a cada canal un trabajo: awareness, autoridad, relacion o conversion.',
      'La distribucion debe seguir la estrategia, no reemplazarla.',
    ],
    notes: [
      'Canales sin rol definido se convierten en mantenimiento vacio.',
      'La constancia importa mas cuando hay coherencia entre formato y objetivo.',
    ],
  },
  {
    category: 'branding',
    slug: 'brand-voice',
    title: 'Brand Voice',
    tags: ['branding', 'voice', 'positioning'],
    query: 'brand voice positioning tone identity trust',
    importance: 8,
    intro: 'Criterios para una voz de marca clara, confiable y con personalidad.',
    rules: [
      'La voz debe sonar segura y precisa, no inflada ni generica.',
      'Toda comunicacion de marca debe aumentar claridad y confianza.',
      'El tono puede variar por contexto, pero la personalidad central debe sostenerse.',
    ],
    notes: [
      'Marca fuerte se reconoce por consistencia de criterio, no por adornos.',
      'Una voz premium suele ser simple, sobria y consciente de lo que no necesita decir.',
    ],
  },
  {
    category: 'growth',
    slug: 'growth-loop-thinking',
    title: 'Growth Loop Thinking',
    tags: ['growth', 'loops', 'retention'],
    query: 'growth loops acquisition retention referrals compounding',
    importance: 7,
    intro: 'Como pensar growth mas alla de hacks aislados.',
    rules: [
      'Buscar mecanismos que se refuercen solos, no solo empujes tacticos puntuales.',
      'Medir el loop completo: adquisicion, activacion, retorno y referral si aplica.',
      'Growth util conecta distribucion con valor real del producto o servicio.',
    ],
    notes: [
      'Los mejores loops reducen dependencia de impulso manual constante.',
      'Escalar una friccion solo hace que la friccion crezca.',
    ],
  },
  {
    category: 'research',
    slug: 'research-synthesis',
    title: 'Research Synthesis',
    tags: ['research', 'synthesis', 'insights'],
    query: 'research synthesis comparisons insights durable knowledge',
    importance: 6,
    intro: 'Principios para convertir investigacion en conocimiento reusable.',
    rules: [
      'Sintetizar hallazgos en criterios y no solo en recopilacion de links o citas.',
      'Separar observaciones, inferencias y decisiones recomendadas.',
      'La investigacion se vuelve util cuando cambia una accion o una prioridad.',
    ],
    notes: [
      'Research sin sintesis se acumula; no compite por foco.',
      'Una buena nota de research reduce re-trabajo cognitivo futuro.',
    ],
  },
  {
    category: 'analytics',
    slug: 'kpi-hierarchy',
    title: 'KPI Hierarchy',
    tags: ['analytics', 'kpis', 'reporting'],
    query: 'analytics KPI hierarchy reporting decision making',
    importance: 7,
    intro: 'Jerarquia de metricas para no perderse en dashboards llenos de numeros.',
    rules: [
      'Definir primero metricas de resultado y luego metricas de diagnostico.',
      'No presentar mas indicadores de los que el equipo realmente usa para decidir.',
      'Toda metrica debe tener owner, formula y accion asociada cuando se desvia.',
    ],
    notes: [
      'Medir sin jerarquia produce ansiedad, no insight.',
      'Un dashboard bueno responde preguntas; uno malo solo impresiona.',
    ],
  },
  {
    category: 'development',
    slug: 'architecture-principles',
    title: 'Architecture Principles',
    tags: ['architecture', 'systems', 'code'],
    query: 'development architecture principles boundaries maintainability',
    importance: 8,
    intro: 'Principios para tomar decisiones tecnicas que resistan cambios y velocidad.',
    rules: [
      'Separar modulos por responsabilidad y cambio esperado, no solo por conveniencia actual.',
      'Las integraciones delicadas merecen superficies pequenas y observables.',
      'Optimizar primero claridad y recuperacion operativa antes de complejidad elegante.',
    ],
    notes: [
      'La arquitectura buena hace faciles los cambios frecuentes y visibles los riesgos.',
      'Si un sistema solo lo entiende quien lo construyo, esta subdocumentado o sobremoldeado.',
    ],
  },
  {
    category: 'automatizacion',
    slug: 'automation-safety',
    title: 'Automation Safety',
    tags: ['automation', 'agents', 'safety'],
    query: 'automation safety guardrails idempotency rollback',
    importance: 8,
    intro: 'Reglas para automatizar sin multiplicar errores silenciosos.',
    rules: [
      'Toda automatizacion que toca clientes, dinero o produccion necesita guardrails claros.',
      'Diseñar acciones para ser idempotentes o para fallar con rollback visible.',
      'La observabilidad no es opcional cuando el sistema opera sin supervision constante.',
    ],
    notes: [
      'Automatizar una mala decision solo la vuelve mas rapida y mas costosa.',
      'Buen automation ops reduce trabajo manual sin quitar control.',
    ],
  },
  {
    category: 'ui-ux',
    slug: 'landing-heuristics',
    title: 'Landing Heuristics',
    tags: ['ux', 'conversion', 'interfaces'],
    query: 'ui ux landing heuristics trust clarity conversion',
    importance: 8,
    intro: 'Heuristicas para interfaces que orientan, convencen y reducen friccion.',
    rules: [
      'El primer viewport debe responder que es, para quien es y por que importa.',
      'La jerarquia visual debe mostrar que leer primero, no pedirlo.',
      'Cada pantalla debe tener una accion primaria evidente.',
    ],
    notes: [
      'La buena UX reduce esfuerzo de interpretacion antes de pedir decision.',
      'Una interfaz bonita pero ambigua sigue siendo mala interfaz.',
    ],
  },
  {
    category: 'product',
    slug: 'prioritization-doctrine',
    title: 'Prioritization Doctrine',
    tags: ['product', 'prioritization', 'roadmaps'],
    query: 'product prioritization impact confidence complexity',
    importance: 7,
    intro: 'Como priorizar producto sin caer en listas infinitas o capricho reactivo.',
    rules: [
      'Priorizar por impacto sobre usuario y negocio, no por volumen de opiniones.',
      'Cada iniciativa debe explicitar costo de oportunidad y complejidad oculta.',
      'Roadmap sin criterios de descarte se convierte en backlog decorado.',
    ],
    notes: [
      'Priorizar tambien es decidir que no se hace ahora.',
      'La claridad de producto mejora cuando el scope cabe en una explicacion corta.',
    ],
  },
  {
    category: 'design-systems',
    slug: 'component-governance',
    title: 'Component Governance',
    tags: ['design-systems', 'components', 'consistency'],
    query: 'design system component governance tokens consistency',
    importance: 7,
    intro: 'Reglas para que un design system mantenga consistencia sin volverse burocracia.',
    rules: [
      'Un componente entra al sistema cuando resuelve recurrencia real, no por entusiasmo puntual.',
      'Definir variaciones por necesidad observable y no por cubrir todas las posibilidades teoricas.',
      'Tokens, nomenclatura y documentacion deben reducir ambiguedad entre diseño y codigo.',
    ],
    notes: [
      'El sistema de diseño existe para acelerar criterio compartido, no para congelarlo.',
      'Consistencia util no significa rigidez ciega.',
    ],
  },
  {
    category: 'finanzas',
    slug: 'cash-discipline',
    title: 'Cash Discipline',
    tags: ['cashflow', 'budget', 'finance'],
    query: 'finance cash discipline runway budgeting founder',
    importance: 8,
    intro: 'Principios para cuidar caja con mentalidad operativa, no solo contable.',
    rules: [
      'Tratar caja como capacidad de decision futura, no solo como saldo actual.',
      'Diferenciar gasto que compra apalancamiento de gasto que solo compra alivio momentaneo.',
      'Mantener visibilidad de runway y compromisos recurrentes antes de tomar nuevas obligaciones.',
    ],
    notes: [
      'Disciplina de caja amplia margen para estrategia.',
      'Los buenos meses no deben esconder estructura fragil.',
    ],
  },
  {
    category: 'economia',
    slug: 'macro-scenarios',
    title: 'Macro Scenarios',
    tags: ['economy', 'macro', 'scenarios'],
    query: 'economy macro scenarios inflation rates demand',
    importance: 6,
    intro: 'Marco simple para leer contexto macro sin caer en ruido constante.',
    rules: [
      'Pensar en escenarios y probabilidades, no en certezas teatrales.',
      'Traducir contexto macro a decisiones concretas de pricing, demanda y riesgo.',
      'Consumir menos opinion y mas consecuencias operativas.',
    ],
    notes: [
      'Lo importante del contexto economico no es predecir perfecto, sino ajustar a tiempo.',
      'Cuando todo parece urgente en macro, filtrar por impacto real sobre tu sistema.',
    ],
  },
  {
    category: 'trading',
    slug: 'risk-model',
    title: 'Risk Model',
    tags: ['trading', 'risk', 'execution'],
    query: 'trading risk model execution discipline position sizing',
    importance: 9,
    intro: 'Modelo base para proteger capital y sostener consistencia operativa.',
    rules: [
      'Definir riesgo antes de entrar y respetarlo despues de entrar.',
      'No subir size para recuperar emocionalmente una perdida.',
      'Si la tesis no cabe en dos lineas claras, el trade aun no esta listo.',
    ],
    notes: [
      'El edge real suele morir por mala ejecucion antes que por mala idea.',
      'Sobrevivir y repetir importa mas que ganar una operacion aislada.',
    ],
  },
  {
    category: 'legal',
    slug: 'contract-hygiene',
    title: 'Contract Hygiene',
    tags: ['legal', 'contracts', 'risk'],
    query: 'legal contract hygiene scope liability payment terms',
    importance: 7,
    intro: 'Criterios minimos para contratos claros y menos expuestos a friccion.',
    rules: [
      'Toda relacion comercial debe dejar claro alcance, pagos, tiempos y ownership.',
      'La ambiguedad contractual casi siempre termina como costo operativo.',
      'Las promesas comerciales deben poder sostenerse dentro del lenguaje contractual.',
    ],
    notes: [
      'Buen contrato no reemplaza confianza, pero protege cuando la confianza cambia.',
      'La higiene legal reduce malentendidos y mejora negociacion.',
    ],
  },
  {
    category: 'personal',
    slug: 'founder-energy-management',
    title: 'Founder Energy Management',
    tags: ['personal', 'energy', 'founder'],
    query: 'founder energy management focus routines recovery',
    importance: 7,
    intro: 'Reglas para sostener rendimiento sin quemar criterio ni presencia.',
    rules: [
      'No poner trabajo profundo en horarios donde solo hay capacidad reactiva.',
      'Proteger energia estrategica como si fuera un recurso financiero escaso.',
      'Las decisiones importantes empeoran cuando se toman ya drenado.',
    ],
    notes: [
      'Gestionar energia no es suavidad; es capacidad de rendimiento sostenido.',
      'El multitasking cobra caro cuando la mente entra y sale de contextos complejos sin cierre.',
    ],
  },
  {
    category: 'ideas-negocios',
    slug: 'idea-validation',
    title: 'Idea Validation',
    tags: ['ideas', 'validation', 'opportunities'],
    query: 'business idea validation demand pain willingness to pay',
    importance: 7,
    intro: 'Como validar ideas sin enamorarse de escenarios imaginarios.',
    rules: [
      'Validar dolor, urgencia y disposicion de pago antes de pensar en sofisticacion.',
      'Una idea mejora cuando se vuelve mas concreta y mas facil de vender.',
      'Buscar evidencia de comportamiento, no solo entusiasmo verbal.',
    ],
    notes: [
      'La velocidad de validacion importa mas que la perfeccion del deck inicial.',
      'Ideas buenas se fortalecen al tocar realidad; ideas fragiles dependen de fantasia.',
    ],
  },
  {
    category: 'marketing',
    slug: 'campaign-briefing',
    title: 'Campaign Briefing',
    tags: ['marketing', 'campaigns', 'brief'],
    query: 'marketing campaign brief offer audience message constraints',
    importance: 7,
    intro: 'Checklist mental para arrancar campañas con menos caos y mejor alineacion.',
    rules: [
      'Toda campaña debe declarar objetivo, audiencia, oferta, mensaje y criterio de exito.',
      'No lanzar piezas si no esta clara la promesa principal y la accion esperada.',
      'La claridad del brief ahorra iteraciones inutiles en creativo y distribucion.',
    ],
    notes: [
      'Cuando una campaña sale confusa, normalmente el problema estaba en el briefing.',
      'El brief bueno concentra tension, limite y objetivo en pocas lineas.',
    ],
  },
];

function usage() {
  console.log(`Usage:
  node scripts/seed-knowledge-library.js [--dry-run] [--force]
`);
}

function parseArgs(argv) {
  return {
    dryRun: argv.includes('--dry-run'),
    force: argv.includes('--force'),
  };
}

function yamlList(items) {
  return `[${items.join(', ')}]`;
}

function renderSeed(seed) {
  const autoQueryLine = seed.query ? `auto_query: "${seed.query.replace(/"/g, '\\"')}"\n` : '';
  const rules = seed.rules.map((line) => `- ${line}`).join('\n');
  const notes = seed.notes.map((line) => `- ${line}`).join('\n');
  return `---
domain: ${seed.category}
tags: ${yamlList(seed.tags)}
status: canonical
importance: ${seed.importance}
sensitivity: normal
${autoQueryLine}---
# ${seed.title}

## Manual
${seed.intro}

## Reglas
${rules}

## Notas
${notes}

<!-- BRAINX:AUTO:START -->
## BrainX Auto
_Aun no sincronizado._
<!-- BRAINX:AUTO:END -->
`;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    usage();
    return;
  }

  const args = parseArgs(argv);
  const validCategories = new Set(TAXONOMY.filter((item) => !item.legacy).map((item) => item.id));
  const summary = {
    totalSeeds: SEEDS.length,
    created: 0,
    skippedExisting: 0,
    dryRun: args.dryRun,
    files: [],
    errors: [],
  };

  for (const seed of SEEDS) {
    if (!validCategories.has(seed.category)) {
      summary.errors.push({ category: seed.category, slug: seed.slug, message: 'unknown category' });
      continue;
    }

    const dir = path.join(KNOWLEDGE_DIR, seed.category);
    const filePath = path.join(dir, `${seed.slug}.md`);

    if (fs.existsSync(filePath) && !args.force) {
      summary.skippedExisting++;
      summary.files.push({ filePath, status: 'skipped_existing' });
      continue;
    }

    if (!args.dryRun) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, renderSeed(seed), 'utf8');
    }

    summary.created++;
    summary.files.push({ filePath, status: args.dryRun ? 'dry_run' : 'created' });
  }

  console.log(JSON.stringify(summary, null, 2));
}

main();
