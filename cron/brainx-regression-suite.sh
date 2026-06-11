#!/usr/bin/env bash
set -euo pipefail

if [ -f /home/clawd/.openclaw/skills/brainx/.env ]; then
  set -a
  . /home/clawd/.openclaw/skills/brainx/.env
  set +a
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
RUNNER="${SCRIPT_DIR}/brainx-regression-suite.mjs"

if [ ! -f "$RUNNER" ]; then
  RUNNER="/home/clawd/.openclaw/workspace/scripts/brainx-regression-suite.mjs"
fi

if [ ! -f "$RUNNER" ]; then
  echo "BrainX regression suite runner not found" >&2
  exit 1
fi

node "$RUNNER"
