# BrainX — Cobertura de agentes

Documento canónico para interpretar "cuántos agentes usa BrainX" y evitar leer
tráfico corto-plazo como una foto del plenario.

## Regla de oro

> Todos los entries del roster son **agentes**. Tráfico bajo en una ventana
> (24h, 7d) no convierte a un agente en "idle" ni lo descuenta del análisis.
> Los sub-entries con sufijo `-d-<channelId>` son agentes per-canal Discord;
> los entries con sufijo `-cli` son adaptaciones CLI del mismo rol; siguen
> siendo agentes.

Antes de afirmar "N agentes activos", cruzar tres fuentes:

1. `brainx_pilot_log` — todo agente que BrainX ha visto alguna vez
   (histórico, 52 distintos al 2026-04-21).
2. `brainx_runtime_injections` — quién ha recibido inyección bajo el plugin
   nuevo (17 distintos en últimos 30d al 2026-04-21).
3. `brainx_memories.agent` — quién ha escrito memorias (55 distintos al
   2026-04-21).

La unión de las tres es el roster efectivo. La intersección con `openclaw.json`
(`agents.*`, `acpx.agents.*`, `channels.*`) confirma configuración.

## Clases de agente vistas

| Clase | Ejemplos | Dónde viven |
|---|---|---|
| Rol primario | `raider`, `reasoning`, `writer`, `coder`, `blade`, `artemis`, `echo`, `bill`, `karl`, `monitor`, `alert`, `kron`, `matrix`, `sonnet`, `main`, `venus`, `ghost`, `clawma`, `max`, `support`, `animus`, `researcher` | `~/.openclaw/workspace-<agent>/` |
| Sub-agente per-canal Discord | `writer-d-<channelId>`, `monitor-d-<channelId>`, `coder-d-<channelId>` | instancias de rol primario bindeadas a un canal específico |
| Adaptación CLI | `kimi-cli`, `codex-cli`, `gemini-cli`, `claude-cli`, `opencode-cli` | mismo rol, transporte CLI |
| Publicación/filtro | `-public`, `-private`, `*-emails`, `*-social-media` | facetas de un rol |
| Sistema | `knowledge-base`, `system`, `unknown`, `heartbeat`, `channel` | productores no humanos |

No descontar ninguna clase al medir cobertura. El ruido/noise-rate se calcula
sobre el **conjunto completo** del roster, no sobre los que hablaron hoy.

## Hit-rate — lectura correcta

El cron **BrainX Injection Health** (07:30 Caracas) imprime un corte de últimas
24h. Ese corte **solo lista agentes con tráfico en esa ventana** — no es el
roster. Si un agente no aparece en ese output, puede:

- Haber recibido inyecciones en ventanas anteriores (ver `runtime_injections`
  con ventanas 7d/30d), o
- No haber consumido ACP/Discord en esa ventana (p.ej. `artemis` estuvo con
  286 inyecciones acumuladas y 0 en las últimas 24h del corte del 2026-04-21).

## Cómo recomputar el roster en vivo

```sql
-- Agentes alguna vez vistos por BrainX
SELECT agent, COUNT(*) events, MAX(injected_at) last_seen
FROM brainx_pilot_log
WHERE agent IS NOT NULL
GROUP BY agent
ORDER BY events DESC;

-- Inyecciones por agente, ventanas
SELECT agent,
  COUNT(*) FILTER (WHERE injected_at > NOW() - INTERVAL '24 hours') w24h,
  COUNT(*) FILTER (WHERE injected_at > NOW() - INTERVAL '7 days')   w7d,
  COUNT(*) FILTER (WHERE injected_at > NOW() - INTERVAL '30 days')  w30d,
  COUNT(*) total
FROM brainx_runtime_injections
GROUP BY agent
ORDER BY total DESC;

-- Autores de memorias
SELECT agent, COUNT(*) mems, MAX(created_at) last_write
FROM brainx_memories
WHERE agent IS NOT NULL
GROUP BY agent
ORDER BY mems DESC;
```

## Snapshot al 2026-04-21

- 52 agentes en `pilot_log` histórico.
- 17 agentes con inyecciones en últimos 30d.
- 55 agentes autores de memorias (55 distintos alguna vez).

Top-17 agentes con inyecciones recientes, orden por total 30d:

```
artemis, blade, monitor, raider, reasoning, coder, echo, alert,
karl, kron, main, sonnet, matrix, raider-private, venus, clawma, writer
```
