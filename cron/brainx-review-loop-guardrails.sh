#!/usr/bin/env bash
# BrainX Review Loop guardrail wrapper.
set -euo pipefail

set -a
# shellcheck disable=SC1091
source /home/clawd/.openclaw/gateway.env
set +a

node /home/clawd/.openclaw/skills/brainx/scripts/review-loop-guardrails.js \
  --hours "${BRAINX_REVIEW_LOOP_GUARDRAIL_HOURS:-2}" \
  --amnesia-hours "${BRAINX_REVIEW_LOOP_GUARDRAIL_AMNESIA_HOURS:-6}" \
  --limit "${BRAINX_REVIEW_LOOP_GUARDRAIL_LIMIT:-250}" \
  --recall-noise-min "${BRAINX_REVIEW_LOOP_RECALL_NOISE_MIN:-3}" \
  --apply \
  --json
