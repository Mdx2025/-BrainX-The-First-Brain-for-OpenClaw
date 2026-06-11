---
domain: emailbot
tags: [emailbot, gmail, followups, drafts, leads, notion]
status: canonical
importance: 9
sensitivity: normal
auto_query: "Emailbot Gmail drafts followups leads Notion sequence protocol"
---
# Emailbot Email Protocol

## Manual
Documentacion canonica para reglas de correo que pertenecen al producto Emailbot.

Este contenido no es una skill global. Solo debe entrar cuando la tarea trate sobre Emailbot, Gmail automation, followups, leads, drafts, sequences o integraciones de Notion del producto.

## Scope
- Mantener aqui reglas de producto, endpoints, guardrails y comportamiento esperado de Emailbot.
- Mantener en `knowledge/correos/` el tono general de MDX para escribir correos.
- Mantener en `knowledge/propuestas/` la arquitectura comercial de propuestas.
- No promover estas reglas como `email-protocol` global en `~/.openclaw/skills/`.

## Routing
- Si la tarea menciona Emailbot mas correo/Gmail/followup/draft/lead/sequence, usar este doc.
- Si la tarea solo pide redactar un correo MDX, usar `knowledge/correos/mdx-email-playbook.md`.
- Si la tarea pide una propuesta o cotizacion, complementar con `knowledge/propuestas/mdx-proposal-playbook.md`.

## Reglas operativas
- Leer el contexto real del lead antes de generar o corregir drafts.
- No mandar correos; Emailbot prepara drafts o acciones de followup, pero el envio requiere una accion explicita.
- Preservar guardrails de leads respondidos: una secuencia solo se reinicia con accion explicita de restart.
- Validar que cualquier fix de draft preserve estructura HTML, firma y preguntas obligatorias.
- Separar bugs de producto de preferencias globales de escritura.

<!-- BRAINX:AUTO:START -->
## BrainX Auto
_Última sincronización: 2026-06-05T22:15:35.638Z_
_Query: Emailbot Gmail drafts followups leads Notion sequence protocol_

- [fact | imp:7 | ctx:project_registry:email_management] Los patrones detectados en EMAILS.md incluyen: 40% respuestas a leads de desarrollo web, 25% follow-ups, 20% colaboraciones/sponsorships, 10% propuestas formales y 5% coordinación interna.
- [fact | imp:10 | ctx:project:brainx] Handoff summary for animus/brainx: Ahora sí. Antes no estaba completamente registrado dentro de la skill; estaba en `/tmp` y memoria. Ya lo corregí: - `recruiter/references/reviewed-candidates.json` - **147 candidatos reales registrados** - con fecha de review, fuente (`x_dm` / `notion`), portfolio URL, bucket final y razón - Listo. Procesé los **47** que estaban en `needs_deeper_review`. Resultado de esta segunda pasada: - **4 aprobados nuevos:** Supratik Saha, moyinthegrait, Amna, CRISTINA PAGNOTTA - **18 segunda ronda** - **23 rechazados/basic** - **2 bloqueados/no inspeccionables** También quedó registrado para f Errors: error ya no es de nuestros envs. Es X rechazando la autorización **antes** de devolver el `code`.; error mío, no de X ni tuyo. Blockers: Sí, correcto. Ese `12d9...` es el **Notion recruiter real**, y sí lo usé para los candidatos. La confusión fue con el ot… - Handoff summary for animus/brainx: En candidatos recruiter reales - - **X inbox:** 75 nuevos / **75 necesitan revisión** - - **Notion recruiter:** 74 nuevos únicos / **72 necesitan revisión** - - 2 ya estaban en failed-ledger - Total candidatos nuevos reales: **149** - Total candidatos que necesitan revisión: **147**
- [fact | imp:7 | ctx:project_registry:email_management] Patrones comunes en correos: aperturas con 'Thanks for reaching out and for the kind words about the work!', cierres con 'Best, Marcelo' o 'Quedo pendiente', y links recurrentes a Calendly, Google Docs y portafolio (ai-robots.ai, eatnaked.co).
<!-- BRAINX:AUTO:END -->
