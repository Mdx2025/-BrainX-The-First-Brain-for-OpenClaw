# Knowledge Base

Esta carpeta es la base documental canónica de BrainX.

## Modelo simple

- `knowledge/<dominio>/...`
  Aquí vive el contenido canónico que editas tú.
- Cada archivo de tema tiene dos zonas:
  - manual
  - auto, delimitada por `<!-- BRAINX:AUTO:START --> ... <!-- BRAINX:AUTO:END -->`
- BrainX solo actualiza el bloque auto. Tu contenido manual no se toca.

## Categorías actuales

### Founder / Agency

- `agency/`
- `strategy/`
- `operaciones/`
- `management/`
- `ventas/`
- `propuestas/`
- `clientes/`
- `correos/`
- `partnerships/`
- `hiring/`

### Growth / Market

- `marketing/`
- `seo/`
- `contenido/`
- `copywriting/`
- `ads/`
- `social-media/`
- `branding/`
- `growth/`
- `research/`
- `analytics/`

### Product / Delivery

- `development/`
- `automatizacion/`
- `emailbot/`
- `ui-ux/`
- `product/`
- `design-systems/`

### Finance / Life

- `finanzas/`
- `economia/`
- `trading/`
- `legal/`
- `personal/`
- `ideas-negocios/`

## Regla operativa

BrainX no debe editar tu contenido manual. Solo puede escribir dentro del bloque auto.

- Sincronización automática:
  hay un cron de BrainX que revisa `knowledge/` periódicamente. En la práctica, editas el `.md` y BrainX lo termina absorbiendo solo.
- Localizar docs canónicos por tarea:
  `brainx knowledge-locate --query "<tarea>"`
- Crear un tópico nuevo:
  `./brainx knowledge-new --category development --name nextjs-server-actions`
- Sincronización manual rápida:
  `./brainx knowledge-sync`
- Refrescar bloques auto:
  `./brainx knowledge-auto-sync`

## Frontmatter recomendado

```md
---
domain: development
tags: [nextjs, server-actions]
status: canonical
importance: 8
sensitivity: normal
auto_query: "nextjs server actions auth boundaries"
---
```

## Patrón de archivo recomendado

```md
# Next.js Server Actions

## Manual
Escribe aquí tu contenido manual.

## Reglas
- ...

<!-- BRAINX:AUTO:START -->
## BrainX Auto
_Aún no sincronizado._
<!-- BRAINX:AUTO:END -->
```

Importante:

- `README.md`, `INDEX.md` y archivos prefijados con `_` no se indexan.
- El importer excluye el bloque auto para evitar loops.
- `coding/` queda como carpeta legacy; para nuevos tópicos usa `development/`.
