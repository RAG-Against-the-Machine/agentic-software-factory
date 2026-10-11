#!/usr/bin/env bash
# Bring the self-hosted factory up (or refresh it after a git pull).
#   scripts/self-host.sh up        # build + start, restart-always
#   scripts/self-host.sh down      # stop (volumes kept)
#   scripts/self-host.sh logs      # follow registry/api/worker
#   scripts/self-host.sh status
#
# Agent auth and your tracker/SCM credentials are normally set in the UI
# (Admin → Agent authentication / providers) and left empty here.
#
# OPTIONAL: if GITHUB_TOKEN or JIRA_API_TOKEN are already exported in your
# shell, they are passed through to compose (never written to .env). Leave them
# unset to configure providers in the UI instead.
#   GITHUB_TOKEN=ghp_... scripts/self-host.sh up
set -euo pipefail
cd "$(dirname "$0")/.."
export GITHUB_TOKEN="${GITHUB_TOKEN:-}"
export JIRA_API_TOKEN="${JIRA_API_TOKEN:-}"
COMPOSE=(docker compose -f docker-compose.self-host.yml)
case "${1:-up}" in
  up)     "${COMPOSE[@]}" up -d --build ;;
  down)   "${COMPOSE[@]}" down ;;
  logs)   "${COMPOSE[@]}" logs -f --tail=100 registry api worker ;;
  status) "${COMPOSE[@]}" ps ;;
  *) echo "usage: $0 up|down|logs|status" >&2; exit 2 ;;
esac
