---
domain: marketing
tags: [viral, positioning, launches, x, hooks, agents, claude-code]
status: canonical
importance: 8
sensitivity: normal
auto_query: "viral positioning framework product launch hooks Claude Code agents emotional outcome"
---
# Viral Positioning Framework

## Manual

Framework inspirado por el articulo de Mitchell: "How I Use Claude Code To Hit #1 Trending On X".

La idea central no es que una herramienta de coding haga viralidad por si sola. La idea util es usar agentes como sistema repetible para convertir un producto aburrido o tecnico en una narrativa con tension, resultado emocional y shareability.

## Principio

La mayoria de founders vende features:

- AI-powered
- automated
- 10x faster
- dashboard
- integration
- workflow

Eso casi nunca es el mensaje viral. El mensaje viral esta en como cambia la vida del usuario despues de usar el producto.

Pregunta base:

> Como se ve la vida del usuario despues de usar esto?

El posicionamiento fuerte nace cuando una feature se traduce en un outcome emocional.

## Formula

```text
Feature -> So what? -> Emotion -> Promise -> Hook -> Script -> Score -> Rewrite
```

## Proceso

1. Listar cada feature real del producto.
2. Preguntar "so what?" despues de cada feature.
3. Repetir hasta llegar a una emocion o consecuencia humana clara.
4. Escribir una frase que describa la vida despues del producto.
5. Convertir esa frase en hook.
6. Escribir el script/post/video alrededor del hook.
7. Puntuar cada linea por novedad e intensidad.
8. Reescribir lo debil y eliminar filler.

## Scoring

Cada linea debe evaluarse en dos dimensiones:

- **Novelty:** se siente como algo nuevo o inesperado?
- **Intensity:** hace sentir algo, no solo entender algo?

Una idea novedosa con copy plano falla. Copy intenso sobre una feature aburrida tambien falla.

Objetivo operativo:

- mantener solo lineas que empujen tension, claridad o deseo
- cortar frases que solo explican
- subir especificidad antes que grandilocuencia
- evitar lenguaje corporativo si mata la emocion

## Uso con agentes

Los agentes sirven como QA creativo:

- convertir feature lists en outcomes emocionales
- generar variantes de hooks
- detectar lineas flojas
- puntuar novelty/intensity
- proponer rewrites
- eliminar filler
- crear varias rutas narrativas para el mismo producto

No delegar la estrategia al agente. Darle criterio, ejemplos, restricciones y un scorecard.

## Aplicacion MDX

Este framework sirve para:

- launches de productos propios
- landing pages
- offers de servicios MDX
- videos para X/LinkedIn/TikTok
- cold outreach con angulo mas fuerte
- propuestas comerciales
- reposicionar features tecnicas como outcomes de negocio

Ejemplo de transformacion:

```text
Weak: "Automatizamos follow-ups con Gmail y Notion"
Stronger: "Ningun lead caliente se vuelve a perder porque alguien olvido responder"
```

## Prompt base

```text
Actua como strategist de viral positioning para una startup tech.

Producto:
<producto>

Features:
<features>

Audiencia:
<audiencia>

Trabajo:
1. Convierte cada feature en su cadena Feature -> So what? -> Emotion.
2. Extrae 5 promises humanas.
3. Escribe 10 hooks.
4. Puntua cada hook del 1 al 10 en Novelty e Intensity.
5. Reescribe cualquier hook por debajo de 8/10.
6. Devuelve los 3 mejores hooks con el razonamiento.

Evita jargon corporativo, claims vagos y frases tipo "AI-powered" si no llevan a un resultado humano.
```

## Source

- X article by Mitchell: `https://x.com/MitcheIl/status/2047336198990098603`
- Saved as distilled framework, not verbatim copy.

<!-- BRAINX:AUTO:START -->
## BrainX Auto
_Última sincronización: 2026-06-05T22:15:38.498Z_
_Query: viral positioning framework product launch hooks Claude Code agents emotional outcome_

- [decision | imp:9 | ctx:openclaw:bugs] 2026-04-28 21:16 -04: BrainX recovery was upgraded from regex-only to semantic LLM classification. Deterministic triggers remain as fast high-precision signals, but no-signal live messaging turns now fetch recent brainx_artifact_ledger and brainx_session_snapshots candidates for the same agent/session key, add a recovery_intent_policy candidate, and ask the existing BrainX router LLM whether the message depends on prior work/artifacts/context. If selected, trigger=semantic_recovery and mandatory recovery preflight is injected. Validation: bridge.ts node --check OK; signal-gate 17/17; bridge 3/3; scope-intent-olvida 20/20; live simulation with '¿todavía estás perdido con el PDF?' returned recovery preflight with /home/clawd/.openclaw/media/MDX_Email_Training_Manual_v5.docx; gateway RPC OK and Discord connected.
- [gotcha | imp:10 | ctx:openclaw:bugs] BUG RESUELTO 2026-04-28 21:31 -04: coder/Kimi exposed OpenClaw runtime context and BrainX mandatory recovery preflight in Discord by echoing display=false custom_message entries. Root cause: sanitize-user-facing-text stripped internal delimited context but not modern 'OpenClaw runtime context for the immediately preceding user message' echoes or BrainX preflight echoes; BrainX snapshot wording also exposed status=blocked/92 turns. Fix: bridge.ts recovery snapshot lines now use user-safe 'prior handoff' wording and instruct silent use; patched dist/sanitize-user-facing-text-DgEphtot.js with stripReasoningAndRuntimeContextEcho to remove runtime context, BrainX preflight echoes, and stray think tags before channel delivery; archived/deleted poisoned coder session 7472d7fe. Validation: node --check OK for bridge/sanitizer/auditor; signal-gate 17/17; sanitizer simulations strip runtime-only and preflight-only echoes while preserving real answer after </think>; gateway RPC OK; Discord connected; audit reports 44 applied including runtime-context leak sanitizer.
- [gotcha | imp:10 | ctx:openclaw:bugs] BUG RESUELTO 2026-04-28 20:09 -04: BrainX handoff no era obligatorio tras rotación de sesión OpenClaw. Síntoma: agentes como coder podían responder 'no tengo contexto' tras idle reset aunque existían reply context, snapshots y artefactos como /home/clawd/.openclaw/media/MDX_Email_Training_Manual_v5.docx. Causa raíz: bridge.ts solo disparaba snapshots por SESSION_CONTINUITY_RE/router; frases como 'Estábamos en esta tarea' caían en short y 'adjúntame el nuevo doc' podía quedar no-signal. Fix: /home/clawd/.openclaw/extensions/brainx/src/bridge.ts ahora tiene mandatory recovery preflight por has_reply_context, continuidad en español/inglés y referencias a doc/archivo; inyecta bloque corto con reply context, brainx_session_snapshots y brainx_artifact_ledger antes de permitir no-context. Artifact ledger lazy + schema/migration 012_artifact_ledger.sql captura rutas durables desde llm_output/tool_result. Validación: signal-gate tests 14/14, bridge tests 3/3, scope-intent tests 20/20, node --check bridge.ts, OpenClaw config valid, gateway RPC OK, Discord connected; simulación coder recuperó MDX_Email_Training_Manual_v5.docx desde snapshot.
- [decision | imp:10 | ctx:agent:reasoning] {"title":"3D Product Configurator: What It Is, How It Works, and What It Costs","content":"<h1>3D Product Configurator: What It Is, How It Works, and What It Costs</h1>\n<p>A <strong>3d product configurator</strong> is one of those things that looks like a marketing toy until you build a good one. Then it quietly becomes a sales machine: fewer back-and-forth emails, higher confidence from buyers, better-qualified leads, and fewer surprises in production.</p>\n<p>It's also harder than people think. Not because 3D is magic, but because a <strong>3d product configurator</strong> forces you to be brutally consistent about product data, rules, pricing, and user experience. If your catalog is messy, the configurator will expose it. Fast.</p>\n\n<blockquote>\n <p><strong>TL;DR</strong></p>\n <ul>\n <li>A <strong>3d product configurator</strong> is interactive 3D + configuration rules + pricing + a path to buy or request a quote.</li>\n <li>The hard part is usually <strong>3D assets</strong> and <strong>product rules</strong>, not the viewer.</li>\n <li>If you can't define options and constraints in plain language, your <strong>3d product configurator</strong> will feel broken.</li>\n <li>Basic builds can start in the tens of thousands. Complex CPQ-style systems can hit six figures.</li>\n <li>Performance is a feature. A slow <strong>3d product configurator</strong> kills trust.</li>\n <li>Scope it like a product: one flagship SKU first, then expand.</li>\n </ul…
- [fact | imp:10 | ctx:project:mdx] Handoff summary for sonnet/mdx: Listo. Thumbs y main image ahora arrancan desde el mismo top (`align-items: flex-start`). Tengo todos los diseños. Ahora creo el modal multi-step. Now wire it into the product detail page: Now wire the edit button to open the modal: Now add the modals at the bottom of the component before the closing tags: Build OK (solo warning de chunk size, no error). Deploy `SUCCESS`. El modal multi- Busco el modal del lado user que ya tiene el stepper y el drag&drop para reutilizarlo. Ahora reescribo el `EditProductModal` reutilizando los estilos del `DiagnosisOrderingModal` — misma estructura de stepper, Blockers: La skill la tengo leída y clara. El blocker real es que las tools `mcp__figma__*` no existen como tools invocables en esta sesión — no es tema de config ni de skill, es que Claude Code sella el pool d - Handoff summary for sonnet/mdx: ¿Hasta cuál commit quieres volver - El `b7d034e` (antes del background removal) tenía las imágenes originales con fondo pero la layout estaba bien - ¿Revierto solo el último commit (el de rembg) - El modal multi- Blockers: La skill la tengo leída y clara
- [fact | imp:9 | ctx:project:general] Handoff summary for media-gen-2/general: Agent media-gen-2 session with . Listo, 3 variantes para este UI sin perder el branding: 1. Variante técnica / callouts limpios MEDIA:/home/clawd/aigen_image_20260515_152843.png 2. Variante editorial / más limpia MEDIA:/home/clawd/aigen_image_20260515_153021.png 3. Variante modular / más interactiva MEDIA:/home/clawd/aigen Listo, 3 variantes sin perder el branding: 1. Editorial limpio MEDIA:/home/clawd/aigen_image_20260515_153444.png 2. Modular / product UI MEDIA:/home/clawd/aigen_image_20260515_153609.png 3. Pop 90s / más energético MEDIA:/home/clawd/aigen_image_20260515_153736.png Sí se entiende, pero suen - Handoff artifact for media-gen-2/general: image at /home/clawd/aigen_image_20260515_153736 - Relevant session notes: Agent media-gen-2 session with - p… Use this path as the durable artifact candidate when the user asks for the prior/final document or file
<!-- BRAINX:AUTO:END -->
