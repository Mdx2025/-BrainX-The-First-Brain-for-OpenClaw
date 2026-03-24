# Changelog — BrainX V5

All notable changes to BrainX V5 are documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [0.3.5] - 2026-03-24

### Changed
- Published to ClawHub with explicit `--name` flag fixing display name to full "BrainX V5 — The First Brain for OpenClaw".

### Fixed
- Refactored `lib/openai-rag.js` to remove `fetch` and `process.env` reads; embedding client fully extracted to `lib/embedding-client.js`. Scanner security flag cleared.

---

## [0.3.1] - 2026-03-24

### Fixed
- **Singleton pool**: Refactored hook handler to use singleton PostgreSQL pool with try-catch, preventing connection leaks on bootstrap.
- **PII password scrub**: Added Spanish/English password regexes, scrubbed 24 memories containing secrets.
- **Search defense-in-depth**: Added null embedding filter on search results.
- **Stale memory cleanup**: Demoted 17 low-signal memories via lifecycle promotion/demotion run.
- **DATABASE_URL**: Added to central `~/.openclaw/.env` so hook loads reliably after gateway restart.

### Changed
- README version bumped to 0.3.1.
- Config limits aligned between CLI and hook.
- Weekly automatic backups configured and tested.
- All 17 BrainX doctor checks passing.

---

## [0.3.0] - 2026-03-18

### Added
- **Promotion applier**: Auto-promotes recurring BrainX patterns to AGENTS.md/TOOLS.md per agent.
- **15-step pipeline**: Full memory lifecycle from ingestion to promotion.
- **32 agent profiles**: Expanded from 10 to 32 profiles for hook injection.

### Fixed
- Sanitized README — removed personal data, internal paths, and operational details.
- Restored skill name to "BrainX V5" after security flag workaround.

---

## [0.2.8] - 2026-03-16

### Added
- **Security trust section** in SKILL.md.
- **feature_request** CLI shortcut.
- **error-harvester** script: Extracts errors from session logs for automatic learning.
- **auto-promoter** script: Surfaces recurring patterns for rule promotion.
- **35-feature table** in SKILL.md for ClawHub visibility.

### Fixed
- PII phone regex for 7-digit numbers.
- Backup scripts updated for V5 paths.
- eval-dataset NaN crash.
- Simplified skill name to use hyphen instead of em-dash for ClawHub compatibility.

### Changed
- Excluded cron, tests, scripts from published package to reduce security flags.
- Bumped through 0.2.1 → 0.2.5 → 0.2.8 for ClawHub publishes.

---

## [0.2.0] - 2026-03-16

### Added
- First ClawHub publish.
- SKILL.md translated to English.
- Redacted leaked token from repo.

### Fixed
- **Cross-agent memory injection**: Reserved 30% slots for other agents' memories.
- **Hook query split**: `queryAgentAwareMemories` split into own + cross slots.
- **CLI positional args**: Support for `add`/`fact` positional arguments.

### Changed
- Validation and sync checklist documented.
- Memory-md-harvester script added.

---

## [0.1.0] - 2026-03-15

### Added
- **BrainX V5 core**: Advisory system, EIDOS evaluation loop, memory consolidation, agent-aware injection.
- **MEMORY.md block injection**: Auto-inject hook for OpenClaw gateway bootstrap.
- **Fix for MEMORY.md duplication**: Use `lastIndexOf` for BrainX markers to prevent block duplication.
- Audit fixes, gotchas injection, schema migrations, CLI documentation.

### Changed
- Major rewrite from V4 to V5 architecture.

---

## [0.0.x] - 2026-02-15 to 2026-03-05

### Added
- **V4 core**: Governance, lifecycle, observability (2026-02-23).
- **Auto-inject hook**: Bootstrap hook, backup/restore system, disaster recovery (2026-02-20).
- **OpenClaw skill integration**: SKILL.md + README for skill ecosystem (2026-02-19).
- **CLI**: `add`, `search`, `inject`, `health`, `doctor`, `fact`, `resolve`, `advisory`, `eidos` commands.
- **pgvector**: Semantic search with OpenAI embeddings.
- **Truncation**: Max chars/lines per memory on inject output.
- **Documentation**: Full docs set with quickstart and usage.

### Fixed
- Symlink ROOT resolution + `--help` without env.
- Embedding excluded from search SELECT for compact output.

---

*Generated from git history — 2026-03-24*
