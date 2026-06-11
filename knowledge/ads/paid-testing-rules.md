---
domain: ads
tags: [ads, testing, creative]
status: canonical
importance: 7
sensitivity: normal
auto_query: "ads testing rules creative targeting iterations"
---
# Paid Testing Rules

## Manual
Reglas para correr tests de paid media con mas aprendizaje y menos ruido.

## Reglas
- Testear una variable principal a la vez cuando el volumen lo permita.
- Separar claramente hipotesis de oferta, mensaje, audiencia y creativo.
- No matar una idea antes de entender si fallo por angulo, ejecucion o targeting.

## Notas
- Testing desordenado produce actividad, no conocimiento.
- La consistencia de naming y lectura ahorra dinero y tiempo.

<!-- BRAINX:AUTO:START -->
## BrainX Auto
_Última sincronización: 2026-06-05T22:15:30.279Z_
_Query: ads testing rules creative targeting iterations_

- [gotcha | imp:10 | ctx:openclaw:brainx] BrainX gotcha: doctor check 'Sensitivity calibration' (lib/doctor.js:476) fails when any memory has sensitivity='normal' AND tag 'pii:redacted' (excepting credit_card-only with no financial keywords in content). The canonical write path (lib/cli.js:cmdAdd -> lib/openai-rag.js:storeMemory line 239) ALWAYS calls deriveSensitivity before INSERT/upsert, so if a row drifts into this failure bucket it means SOME OTHER PATH UPDATED the row's tags post-insert WITHOUT recalculating sensitivity. Confirmed via manual repro: deriveSensitivity with tags including pii:redacted+pii:password_inline correctly returns 'restricted'. Suspect callers (not all confirmed): scripts/contradiction-detector.js:211 (UPDATE tags), scripts/cross-agent-learning.js:113 (UPDATE tags), unidentified hooks. Resolution is trivial: 'brainx fix' step Sensitivity calibration (lib/fix.js:280 recalibrateSensitivity) re-scans all sensitivity=normal rows and reapplies deriveSensitivity — idempotent, safe to run repeatedly. Doctor will catch any future regression. Architectural fix would be enforcing deriveSensitivity in any UPDATE-tags path or adding a DB trigger on tags column, but not justified for one-off occurrences. First observed 2026-05-07 (m_1778164057971_c0d3af66). Cross-agent value: any agent that writes brainx memories should know this gotcha because misattributing to a 'add path bug' wastes investigation time when canonical path is correct.
<!-- BRAINX:AUTO:END -->
