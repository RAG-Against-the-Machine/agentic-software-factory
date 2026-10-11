#!/usr/bin/env bash
#
# host-worker.sh — control the host worker's OS supervisor (M10 WP5).
#
#   scripts/host-worker.sh up | down | status | logs [-f]
#
# scripts/asf calls this in host-worker mode (ASF_MODE=2). It drives the
# launchd LaunchAgent (macOS) or the systemd --user service (Linux) that
# scripts/setup.sh installs; it does not build or run the worker itself — that
# is worker-host.sh, which the unit's ExecStart points at.
#
# Install the unit first with `scripts/setup.sh --mode 2`. If it isn't installed,
# every subcommand prints how to install it and exits non-zero.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

# shellcheck source=scripts/lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

OS="$(uname -s)"
LABEL="com.asf.worker"                                   # macOS launchd label
SERVICE="asf-worker.service"                             # Linux systemd unit
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
UNIT="$HOME/.config/systemd/user/${SERVICE}"
LOG="$HOME/.asf/logs/worker.log"

usage() {
  cat <<EOF
host-worker — control the host worker supervisor.

Usage: scripts/host-worker.sh <command>

  up               load + (re)start the worker (launchd/systemd)
  down             stop the worker (kept installed; comes back at next login)
  status           is the supervisor loaded and the worker registered
  logs [-f]        show the worker log ($LOG); -f to follow
EOF
}

not_installed() { # $1 = path we looked for
  die "host worker not installed ($1 missing) — run: scripts/setup.sh --mode 2"
}

# --- macOS (launchd) --------------------------------------------------------
mac_domain() { printf 'gui/%s' "$(id -u)"; }

mac_up() {
  [ -f "$PLIST" ] || not_installed "$PLIST"
  # bootstrap is a no-op-with-error if already loaded, so ignore that and always
  # kickstart -k (start, restarting if already running) to pick up new code.
  launchctl bootstrap "$(mac_domain)" "$PLIST" 2>/dev/null || true
  launchctl kickstart -k "$(mac_domain)/${LABEL}"
  ok "host worker started (launchd ${LABEL})"
}

mac_down() {
  [ -f "$PLIST" ] || not_installed "$PLIST"
  launchctl bootout "$(mac_domain)/${LABEL}" 2>/dev/null \
    || launchctl bootout "$(mac_domain)" "$PLIST" 2>/dev/null || true
  ok "host worker stopped"
}

mac_status() {
  if launchctl print "$(mac_domain)/${LABEL}" >/dev/null 2>&1; then
    ok "launchd agent ${LABEL} loaded"
  else
    bad "launchd agent ${LABEL} not loaded" "scripts/host-worker.sh up"
  fi
}

# --- Linux (systemd --user) -------------------------------------------------
linux_up() {
  [ -f "$UNIT" ] || not_installed "$UNIT"
  systemctl --user daemon-reload 2>/dev/null || true
  systemctl --user restart "$SERVICE"
  ok "host worker started (systemd ${SERVICE})"
}

linux_down() {
  [ -f "$UNIT" ] || not_installed "$UNIT"
  systemctl --user stop "$SERVICE" || true
  ok "host worker stopped"
}

linux_status() {
  if systemctl --user is-active --quiet "$SERVICE"; then
    ok "systemd ${SERVICE} active"
  else
    bad "systemd ${SERVICE} not active" "scripts/host-worker.sh up"
  fi
}

# --- logs (both platforms tail the same file) -------------------------------
cmd_logs() {
  local follow=0
  case "${1:-}" in -f|--follow) follow=1 ;; esac
  if [ ! -f "$LOG" ]; then
    warn "no worker log yet at $LOG" "start it: scripts/host-worker.sh up"
    return 0
  fi
  if [ "$follow" -eq 1 ]; then tail -f "$LOG"; else tail -n 200 "$LOG"; fi
}

# --- dispatch ---------------------------------------------------------------
cmd="${1:-}"
[ $# -gt 0 ] && shift || true
case "$cmd" in
  up)     case "$OS" in Darwin) mac_up ;; Linux) linux_up ;; *) die "unsupported OS: $OS" ;; esac ;;
  down)   case "$OS" in Darwin) mac_down ;; Linux) linux_down ;; *) die "unsupported OS: $OS" ;; esac ;;
  status) case "$OS" in Darwin) mac_status ;; Linux) linux_status ;; *) die "unsupported OS: $OS" ;; esac ;;
  logs)   cmd_logs "$@" ;;
  help|-h|--help|"") usage ;;
  *) printf 'unknown command: %s\n\n' "$cmd" >&2; usage >&2; exit 2 ;;
esac
