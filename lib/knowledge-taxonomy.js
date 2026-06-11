'use strict';

const TAXONOMY = [
  { id: 'agency', group: 'Founder / Business', label: 'Agency', dbCategory: 'business', description: 'Oferta, estructura de agencia, servicios, posicionamiento y SOPs de alto nivel.' },
  { id: 'strategy', group: 'Founder / Business', label: 'Strategy', dbCategory: 'business', description: 'Tesis, dirección general, prioridades y marcos de decisión del fundador.' },
  { id: 'operaciones', group: 'Founder / Business', label: 'Operaciones', dbCategory: 'business', description: 'Procesos, coordinación, handoffs, SOPs y reglas operativas diarias.' },
  { id: 'management', group: 'Founder / Business', label: 'Management', dbCategory: 'business', description: 'Gestión de personas, accountability, seguimiento y liderazgo.' },
  { id: 'ventas', group: 'Founder / Business', label: 'Ventas', dbCategory: 'business', description: 'Prospección, discovery, cierres, pricing y estrategia comercial.' },
  { id: 'propuestas', group: 'Founder / Business', label: 'Propuestas', dbCategory: 'business', description: 'Estructuras de propuesta, alcance, entregables y narrativa comercial.' },
  { id: 'clientes', group: 'Founder / Business', label: 'Clientes', dbCategory: 'client', description: 'Contexto canónico por cliente: tono, restricciones, entregables y notas estables.' },
  { id: 'correos', group: 'Founder / Business', label: 'Correos', dbCategory: 'business', description: 'Plantillas, followups, tono y playbooks de correo.' },
  { id: 'partnerships', group: 'Founder / Business', label: 'Partnerships', dbCategory: 'business', description: 'Alianzas, referrals, colaboraciones y relaciones estratégicas.' },
  { id: 'hiring', group: 'Founder / Business', label: 'Hiring', dbCategory: 'business', description: 'Contratación, perfiles, scorecards y evaluación de talento.' },

  { id: 'marketing', group: 'Growth / Market', label: 'Marketing', dbCategory: 'business', description: 'Go-to-market, campañas, posicionamiento, funnels y estrategia de adquisición.' },
  { id: 'seo', group: 'Growth / Market', label: 'SEO', dbCategory: 'business', description: 'Playbooks, technical SEO, on-page, linking y criterios de ranking.' },
  { id: 'contenido', group: 'Growth / Market', label: 'Contenido', dbCategory: 'business', description: 'Ángulos editoriales, formatos, calendario, distribución y criterios de calidad.' },
  { id: 'copywriting', group: 'Growth / Market', label: 'Copywriting', dbCategory: 'business', description: 'Mensajes, hooks, estructuras de copy, titulares y persuasión.' },
  { id: 'ads', group: 'Growth / Market', label: 'Ads', dbCategory: 'business', description: 'Paid media, tests, anuncios, creativos, targeting y optimización.' },
  { id: 'social-media', group: 'Growth / Market', label: 'Social Media', dbCategory: 'business', description: 'Redes sociales, distribución, calendario y formatos por plataforma.' },
  { id: 'branding', group: 'Growth / Market', label: 'Branding', dbCategory: 'business', description: 'Voz, tono, identidad, posicionamiento y criterios de marca.' },
  { id: 'growth', group: 'Growth / Market', label: 'Growth', dbCategory: 'business', description: 'Experimentos, loops, conversiones, activación y escalamiento.' },
  { id: 'research', group: 'Growth / Market', label: 'Research', dbCategory: 'context', description: 'Investigación, síntesis, comparativos y hallazgos reutilizables.' },
  { id: 'analytics', group: 'Growth / Market', label: 'Analytics', dbCategory: 'business', description: 'Métricas, reporting, dashboards, eventos y análisis de rendimiento.' },

  { id: 'development', group: 'Product / Delivery', label: 'Development', dbCategory: 'infrastructure', description: 'Arquitectura, código, deploys, debugging, librerías y decisiones técnicas.' },
  { id: 'automatizacion', group: 'Product / Delivery', label: 'Automatizacion', dbCategory: 'infrastructure', description: 'Bots, integraciones, scraping, flujos automáticos y operación asistida.' },
  { id: 'ui-ux', group: 'Product / Delivery', label: 'UI UX', dbCategory: 'business', description: 'Sistema visual, UX, layout, heurísticas, copy de interfaz y diseño.' },
  { id: 'product', group: 'Product / Delivery', label: 'Product', dbCategory: 'business', description: 'Roadmaps, priorización, discovery, requisitos y decisiones de producto.' },
  { id: 'design-systems', group: 'Product / Delivery', label: 'Design Systems', dbCategory: 'business', description: 'Tokens, componentes, patrones y reglas del sistema de diseño.' },

  { id: 'finanzas', group: 'Finance / Life', label: 'Finanzas', dbCategory: 'financial', description: 'Caja, cuentas, presupuesto, pricing financiero y manejo operativo del dinero.' },
  { id: 'economia', group: 'Finance / Life', label: 'Economia', dbCategory: 'financial', description: 'Macro, inflación, tasas, contexto económico y escenarios.' },
  { id: 'trading', group: 'Finance / Life', label: 'Trading', dbCategory: 'financial', description: 'Tesis, setups, gestión de riesgo, ejecución y journaling de trading.' },
  { id: 'legal', group: 'Finance / Life', label: 'Legal', dbCategory: 'business', description: 'Contratos, términos, riesgos, compliance y notas legales operativas.' },
  { id: 'personal', group: 'Finance / Life', label: 'Personal', dbCategory: 'personal', description: 'Rutinas, preferencias, contexto de vida y reglas personales duraderas.' },
  { id: 'ideas-negocios', group: 'Finance / Life', label: 'Ideas Negocios', dbCategory: 'business', description: 'Ideas de negocio, oportunidades, tesis y modelos de ingreso.' },

  { id: 'coding', group: 'Legacy', label: 'Coding', dbCategory: 'infrastructure', description: 'Carpeta legacy; usar development para temas nuevos.', legacy: true },
];

const CATEGORY_IDS = TAXONOMY.map((item) => item.id);
const DOMAIN_CATEGORY = Object.fromEntries(TAXONOMY.map((item) => [item.id, item.dbCategory]));

function getCategoryMeta(id) {
  return TAXONOMY.find((item) => item.id === id) || null;
}

function getGroupedTaxonomy() {
  const groups = new Map();
  for (const item of TAXONOMY) {
    if (item.legacy) continue;
    if (!groups.has(item.group)) groups.set(item.group, []);
    groups.get(item.group).push(item);
  }
  return [...groups.entries()].map(([group, items]) => ({ group, items }));
}

module.exports = {
  TAXONOMY,
  CATEGORY_IDS,
  DOMAIN_CATEGORY,
  getCategoryMeta,
  getGroupedTaxonomy,
};
