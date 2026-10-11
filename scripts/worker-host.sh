#!/usr/bin/env bash
#
# worker-host.sh — run the ASF worker on THIS host (M10 WP5, host-worker mode).
#
# This is the ExecStart target for the launchd/systemd unit that scripts/setup.sh
# installs (see scripts/host-worker.sh). It is also safe to run by hand:
#
#   scripts/worker-host.sh
#
# Why a host worker: the container worker can't do an interactive `claude login`
# and can't see the host's Google ADC. Running the worker here lets the agent use
# those host-only credentials while postgres/registry/api stay in containers.
#
# It builds the worker from this checkout, then execs it pointed at the loopback
# endpoints the host-worker compose overlay publishes (registry 127.0.0.1:8788,
# api 127.0.0.1:$ASF_PORT). Per-host overrides come from ~/.asf/worker.env only —
# never a shell profile (~/.zshrc etc.), so a login shell's state can't leak in.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

# shellcheck source=scripts/lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

ENV_FILE="$ROOT/.env"

# --- per-host overrides (PATH, WORKTREE_ROOT, RUN_DATA_ROOT, ...) ------------
# launchd/systemd start us with a bare environment, so this file is where the
# operator's PATH (node/pnpm/claude) and data roots live. Never ~/.zshrc.
WORKER_ENV="${ASF_WORKER_ENV:-$HOME/.asf/worker.env}"
if [ -f "$WORKER_ENV" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$WORKER_ENV"
  set +a
fi

# --- endpoints: loopback only ----------------------------------------------
# The registry is published on 127.0.0.1:8788 and the api on 127.0.0.1:$ASF_PORT
# by docker-compose.host-worker.yml. Force them here so a stray REGISTRY_URL in
# .env (which points at the compose-network name) can't send us to nowhere.
ASF_PORT="${ASF_PORT:-$(read_env_key "$ENV_FILE" ASF_PORT)}"
ASF_PORT="${ASF_PORT:-8787}"
export REGISTRY_URL="http://127.0.0.1:8788"
export BFF_URL="http://127.0.0.1:${ASF_PORT}"

# --- the agent CLI must be on PATH -----------------------------------------
# The whole point of a host worker is host-side Claude auth; without the CLI the
# worker registers but every task fails. Fail fast with an install hint instead.
if ! command -v claude >/dev/null 2>&1; then
  die "claude CLI not found on PATH — install it and, if needed, add its dir to PATH in ${WORKER_ENV}
      install:  npm i -g @anthropic-ai/claude-code   (then run 'claude login' or 'claude setup-token')
      PATH:     echo 'PATH=\$HOME/.local/bin:\$PATH' >> ${WORKER_ENV}"
fi

# --- build from this checkout ----------------------------------------------
# shared is imported by the worker, so it must be built first.
info "worker-host: installing dependencies (pnpm install)"
pnpm install
info "worker-host: building @asf/shared and @asf/worker"
pnpm --filter @asf/shared build
pnpm --filter @asf/worker build

# --- run --------------------------------------------------------------------
# --env-file-if-exists loads .env without failing when it's absent; anything we
# already exported above (REGISTRY_URL/BFF_URL) still wins over the file.
info "worker-host: starting (registry ${REGISTRY_URL}, api ${BFF_URL})"
exec node --env-file-if-exists="$ENV_FILE" apps/worker/dist/index.js
