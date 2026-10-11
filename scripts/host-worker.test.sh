#!/usr/bin/env bash
# Tests for scripts/host-worker.sh (M10 WP5).
#
# Run directly:  bash scripts/host-worker.test.sh
#
# No real launchd/systemd: these cover the "not installed" guard and the
# logs/usage/dispatch paths, which don't require a live supervisor. The
# live launchd/systemd behaviour is exercised manually per the ticket.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST_WORKER="$REPO_ROOT/scripts/host-worker.sh"

PASS=0
FAIL=0
fail() { printf 'FAIL: %s\n' "$1" >&2; FAIL=$((FAIL + 1)); }
pass() { PASS=$((PASS + 1)); }

assert_contains() { case "$1" in *"$2"*) pass ;; *) fail "$3 (expected to find: $2)" ;; esac; }
assert_eq()       { [ "$1" = "$2" ] && pass || fail "$3 (got '$1', want '$2')"; }

# --- isolated fake $HOME: no plist/unit installed ---------------------------
FAKE_HOME="$(mktemp -d)"
cleanup() { rm -rf "$FAKE_HOME"; }
trap cleanup EXIT

run_host_worker() { HOME="$FAKE_HOME" "$HOST_WORKER" "$@"; }

# --- help / no args ----------------------------------------------------------
out="$(run_host_worker help 2>&1)"
assert_contains "$out" "Usage: scripts/host-worker.sh" "help shows usage"

out="$(run_host_worker 2>&1)"
assert_contains "$out" "Usage: scripts/host-worker.sh" "no args shows usage"

# --- unknown command ----------------------------------------------------------
out="$(run_host_worker bogus 2>&1)"; code=$?
assert_eq "$code" "2" "unknown command exits 2"
assert_contains "$out" "unknown command: bogus" "unknown command message"

# --- not installed: up/down guard (no plist/unit under FAKE_HOME) ----------
for cmd in up down; do
  out="$(run_host_worker "$cmd" 2>&1)"; code=$?
  assert_eq "$code" "1" "$cmd exits 1 when not installed"
  assert_contains "$out" "not installed" "$cmd reports not installed"
  assert_contains "$out" "scripts/setup.sh --mode 2" "$cmd points at setup.sh --mode 2"
done

# --- logs: no log file yet ---------------------------------------------------
out="$(run_host_worker logs 2>&1)"; code=$?
assert_eq "$code" "0" "logs exits 0 when no log file"
assert_contains "$out" "no worker log yet" "logs reports missing log file"

# --- logs: tails an existing log file ---------------------------------------
mkdir -p "$FAKE_HOME/.asf/logs"
printf 'line1\nline2\n' > "$FAKE_HOME/.asf/logs/worker.log"
out="$(run_host_worker logs 2>&1)"
assert_contains "$out" "line1" "logs shows log contents (1)"
assert_contains "$out" "line2" "logs shows log contents (2)"

# --- summary ------------------------------------------------------------------
printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
