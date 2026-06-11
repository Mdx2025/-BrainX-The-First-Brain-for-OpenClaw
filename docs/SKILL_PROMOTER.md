# BrainX Skill Promoter

skill-promoter is the BrainX bridge for Hermes-style procedural learning.

It turns repeated, high-signal BrainX evidence into reviewable skill
candidates. Apply mode can create a new `brainx-created` skill or patch an
existing skill, but only through explicit CLI flags, validation, audit, and
rollback. Scheduled production uses a Hermes-style split: Background Review
promotes skills near the event, while Skill Curator handles weekly lifecycle.

Production scheduling uses `brainx-reviewer` as the single BrainX owner:

- `BrainX Background Review` runs every 2h and calls
  `brainx-background-review-cron.sh`. That wrapper runs auto-patch for
  registered existing skills and auto-create for high-confidence new skills
  under one cron job.
- `BrainX Skill Curator` runs weekly and calls
  `brainx-skill-curator-cron.sh`. It manages only `brainx-created` skills via
  the lifecycle sidecar, with snapshot-before-transition and pinned protection.
- The old daily light dry-run is disabled. The old weekly auto-create job was
  repurposed into the curator so BrainX matches Hermes' two-loop model.
- Do not split this into a second BrainX cron agent. `brainx-reviewer` is the
  only BrainX owner for these jobs; generic non-BrainX OpenClaw cron jobs use
  `alert` by default.
- Manual broad writes still require `--apply` with an explicit selector.
  Scheduled auto-patch is allowed to patch registered non-authorization-only
  skills only after evidence and low-risk gates pass.
- Scheduled auto-patch never accepts `--allow-existing-patch`; it enables the
  internal existing-skill patch path only after the auto-patch gate and
  low-risk classifier pass.

## Pipeline

1. Read recurring brainx_patterns and high-use brainx_memories.
   With `--hybrid`, also read recent OpenClaw session JSONL transcripts and
   extract direct procedural instructions from real user/assistant messages.
2. Score procedural signal from type, category, recurrence, access count, tags,
   source kind, and workflow keywords.
3. Reject unsafe or low-signal inputs:
   - restricted memories
   - secret-like text
   - one-off reports, commits, dated deploy notes, and article/draft noise
   - project-specific implementation notes that mention bug-fix wording plus
     concrete code/function identifiers
   - synthetic transcript envelopes such as AGENTS.md, developer prompts,
     assembled reply context, and quoted conversation history
4. Infer the target skill:
   - extend an existing skill when the OpenClaw runtime registry confirms it exists
   - propose a new skill name when no existing skill fits
5. In hybrid mode, keep raw-session evidence only when it is confirmed by
   BrainX memory/pattern signal or grouped with BrainX evidence for the same skill.
6. Emit a draft SKILL.md plus source IDs and confidence.
7. Optional --save: store the draft as a BrainX memory tagged skill-candidate
   and brainx-skill-promoter.
8. Optional --auto-create: create only high-confidence `create_new_skill`
   candidates. The gate requires confidence, recurrence, source count,
   raw-session evidence, BrainX confirmation, and no similar existing skill.
9. Optional --auto-patch: patch only high-confidence existing-skill candidates
   that classify as low risk. It requires confidence, recurrence, source count,
   raw-session evidence, BrainX confirmation, an existing registered skill,
   and a low-risk append-only patch. Authorization-only skills are blocked:
   `agent-core`, `brainx`, `gws`, and `openclaw-runtime`.
10. Optional --apply: write through the Hermes-style applier:
   - new skills are written to `~/.openclaw/skills/<slug>/SKILL.md`
   - existing skills are patched only with `--allow-existing-patch`
   - new skills are marked in `.brainx-skill-usage.json` as `brainx-created`
   - agent-core registry regen runs before `openclaw skills check`
   - validation confirms the skill appears in the OpenClaw skill check output
   - successful writes store an apply audit JSON under the skills root
   - failures rollback the skill file/sidecar change

Existing skill detection follows agent-core's registration model and now merges
runtime discovery with filesystem slugs. Runtime visibility is still verified
with `openclaw skills check` during apply, but candidate classification can
recognize local skill directories such as `brainx`.

Use `--per-agent` for broad test runs across a busy fleet. It keeps the global
scan, then gives each active agent a bounded row budget so high-volume agents do
not fully crowd out smaller but active workspaces.

Use `--hybrid` when testing Hermes-style raw conversation learning. The scan
still starts with BrainX memories/patterns, then walks recent
`~/.openclaw/agents/*/sessions/**/*.jsonl` files, extracts actionable
instructions, groups them by inferred skill, and reports `sessionCoverage`
including sessions, messages, extracted instructions, and confirmed raw rows.

## Commands

    ./brainx skill-promoter --days 60 --min-recurrence 4
    ./brainx skill-promoter --json
    ./brainx skill-promoter --per-agent --days 90 --min-recurrence 2 --agent-limit 80 --per-agent-limit 20 --json
    ./brainx skill-promoter --hybrid --days 14 --session-limit 120 --per-agent-session-limit 8 --json
    ./brainx skill-promoter --emit-dir /tmp/brainx-skill-candidates
    ./brainx skill-promoter --auto-create --dry-run
    ./brainx skill-promoter --auto-create --auto-create-min-confidence 0.9
    ./brainx skill-promoter --auto-patch --dry-run
    ./brainx skill-promoter --auto-patch --auto-patch-min-confidence 0.95
    ./brainx skill-promoter --apply --skill <candidate-slug>
    ./brainx skill-promoter --apply --candidate-file /tmp/brainx-skill-candidates/<slug>.candidate.md
    ./brainx skill-promoter --apply --all --dry-run

Manual/single-profile wrapper:

    bash /home/clawd/.openclaw/skills/brainx/cron/brainx-skill-promoter-cron.sh

Scheduled Background Review wrapper:

    bash /home/clawd/.openclaw/skills/brainx/cron/brainx-background-review-cron.sh

Scheduled Skill Curator wrapper:

    bash /home/clawd/.openclaw/skills/brainx/cron/brainx-skill-curator-cron.sh

--save is intentionally separate from detection. It writes only to
brainx_memories.

--apply refuses to run without an explicit selector: `--skill`, `--candidate-file`,
or `--all`.

--auto-create refuses existing-skill patches by design. It selects only
`create_new_skill` candidates that pass the high-confidence gate and then uses
the same applier path: create folder, mark `brainx-created`, regenerate
agent-core registry references, run `openclaw skills check`, write audit, or
rollback on failure.

The scheduled Background Review gate is tuned to two strong signals: confidence
thresholds still apply, but auto-create and auto-patch both default to
recurrence >= 2 and sourceCount >= 2, plus raw-session evidence and BrainX
confirmation.

--auto-patch is the narrower Hermes-like autopatcher for existing skills. It
enables `allowExistingPatch` internally only after the candidate passes its
gate and `classifyPatchRisk` returns low risk. It is intentionally append-only:
the applier adds a bounded `BrainX-Promoted Workflow` block with source
markers, validates with the normal apply path, writes audit JSON including the
patch-risk result, and rolls back on failure. Critical operational skills are
blocked even when the candidate has high confidence.

The Background Review wrapper replaces separate daily/near-event/weekly
promoter profiles. It runs auto-patch and auto-create as separate internal
profiles so `skill-promoter` keeps its one-write-mode invariant, but OpenClaw
has only one near-event learning cron.

Manual existing-skill patches still require `--allow-existing-patch`.
Scheduled auto-patch is the only non-manual existing-skill patch exception,
and it is limited to the internal gate described above. By Marcelo's policy,
manual and upstream skills are patchable by default when the evidence and
low-risk gates pass; only `agent-core`, `brainx`, `gws`, and
`openclaw-runtime` require explicit authorization.

## Skill Curator

BrainX now has a Hermes-like lifecycle command for BrainX-owned skills:

    ./brainx skill-curator status
    ./brainx skill-curator list
    ./brainx skill-curator pin <skill>
    ./brainx skill-curator unpin <skill>
    ./brainx skill-curator archive <skill>
    ./brainx skill-curator restore <skill>
    ./brainx skill-curator list-archived
    ./brainx skill-curator prune --days 90 --dry-run
    ./brainx skill-curator prune --days 90 --yes
    ./brainx skill-curator run

Lifecycle state lives in `~/.openclaw/skills/.brainx-skill-usage.json`, not in
`SKILL.md`. Archives are moved to `~/.openclaw/skills/.brainx-archive/` and are
recoverable with `restore`.

## Apply Gate

Every real apply must satisfy this checklist:

- load `agent-core` and log the review intent
- inspect candidate evidence
- remove private host/project details
- merge into an existing skill when possible
- create a new skill only when reuse is clear
- refresh agent-core registry evidence with:
  `~/.openclaw/skills/agent-core/scripts/regen-references.sh skills --apply`
- verify registration with `openclaw skills check` or `openclaw skills list --json`
- store apply audit evidence for successful writes
- validate with the skill's own tests or a realistic workflow

`SKILLS_REGISTRY.md` is agent-core documentation/drift evidence, not the source
that registers a skill. The runtime registry is the source of truth.

## Non-Goals

- No uncontrolled edits to the OpenClaw skills directory
- No auto-patching critical, medium-risk, high-risk, or unregistered skills
- No destructive deletion; archive/restore is the maximum lifecycle action
- No automatic consolidation of unrelated skills
- No project-specific runbook migration into global skills
- No use of restricted/private memories as reusable skill source material
