#!/usr/bin/env bash
# Tests for scripts/asf (M10 WP3).
#
# Run directly:  bash scripts/asf.test.sh
#
# No real Docker: these cover argument handling only (help, unknown command,
# and `doctor` when docker is absent). The live-stack behaviour is exercised
# manually per the ticket.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ASF="$REPO_ROOT/scripts/asf"

PASS=0
FAIL=0
fail() { printf 'FAIL: %s\n' "$1" >&2; FAIL=$((FAIL + 1)); }
pass() { PASS=$((PASS + 1)); }

assert_contains() { case "$1" in *"$2"*) pass ;; *) fail "$3 (expected to find: $2)" ;; esac; }
assert_eq()       { [ "$1" = "$2" ] && pass || fail "$3 (got '$1', want '$2')"; }

# --- an isolated fake checkout: asf + common.sh + compose file --------------
FAKE_ROOT="$(mktemp -d)"
EMPTY_BIN="$(mktemp -d)"   # a PATH with no docker on it
cleanup() { rm -rf "$FAKE_ROOT" "$EMPTY_BIN"; }
trap cleanup EXIT

mkdir -p "$FAKE_ROOT/scripts/lib"
cp "$ASF" "$FAKE_ROOT/scripts/asf"
cp "$REPO_ROOT/scripts/host-worker.sh" "$FAKE_ROOT/scripts/host-worker.sh"
cp "$REPO_ROOT/scripts/lib/common.sh" "$FAKE_ROOT/scripts/lib/common.sh"
cp "$REPO_ROOT/docker-compose.self-host.yml" "$FAKE_ROOT/docker-compose.self-host.yml"
cp "$REPO_ROOT/docker-compose.host-worker.yml" "$FAKE_ROOT/docker-compose.host-worker.yml"
chmod +x "$FAKE_ROOT/scripts/asf" "$FAKE_ROOT/scripts/host-worker.sh"

# core utilities doctor calls (df/awk/stat/basename) live in /usr/bin:/bin
run_asf() { ( cd "$FAKE_ROOT" && PATH="$EMPTY_BIN:/usr/bin:/bin" NO_COLOR=1 "$FAKE_ROOT/scripts/asf" "$@" ); }

# --- help -------------------------------------------------------------------
out="$(run_asf help 2>&1)"; code=$?
assert_eq "$code" "0" "help exits 0"
assert_contains "$out" "Usage: scripts/asf" "help prints usage"
assert_contains "$out" "doctor" "help lists the doctor command"

# default (no args) also shows help and exits 0
out="$(run_asf 2>&1)"; code=$?
assert_eq "$code" "0" "no args exits 0"
assert_contains "$out" "Usage: scripts/asf" "no args prints usage"

# --- unknown command --------------------------------------------------------
out="$(run_asf bogus 2>&1)"; code=$?
assert_eq "$code" "2" "unknown command exits 2"
assert_contains "$out" "unknown command: bogus" "unknown command names itself"

# --- doctor never calls worker-only (X-Run-Secret) api routes -------------------
# It has no run secret, so a gated route answers 401 and the check misreports.
gated="$(grep -oE "api_check /api/(agent-auth|runs/[^ ]*/(context|events|cancel-requested))" "$ASF" || true)"
assert_eq "$gated" "" "doctor does not query secret-gated api routes"

# --- doctor with no docker: reports the docker ✗ and exits non-zero ---------
out="$(run_asf doctor 2>&1)"; code=$?
assert_eq "$code" "1" "doctor exits 1 when checks fail"
assert_contains "$out" "docker daemon not reachable" "doctor flags a missing docker daemon"
assert_contains "$out" ".env missing" "doctor flags the missing .env in the fake checkout"
assert_contains "$out" "Summary" "doctor prints a summary section"
# with docker absent it must not have tried to talk to containers
assert_contains "$out" "check(s) failed" "doctor summary reports the failure count"

# --- update defaults to pulling prebuilt images, not building ---------------
# No docker on PATH, so the compose call itself fails after printing its
# intent — enough to confirm cmd_update picks the pull path by default.
out="$(run_asf update 2>&1)"; code=$?
assert_contains "$out" "docker compose pull" "update (default) pulls prebuilt images"
[ "${out#*"docker compose up -d --build"}" = "$out" ] && pass || fail "update (default) must not build locally"

# --- update --from-source takes the git-pull path, not the image pull path --
# (the fake checkout isn't a git repo, so it fails before reaching compose —
# enough to confirm --from-source never calls `docker compose pull`.)
out="$(run_asf update --from-source 2>&1)"; code=$?
assert_contains "$out" "git pull --ff-only" "update --from-source pulls the repo"
[ "${out#*"docker compose pull"}" = "$out" ] && pass || fail "update --from-source must not pull prebuilt images"

# --- update rejects an unrecognized option -----------------------------------
out="$(run_asf update --bogus 2>&1)"; code=$?
assert_eq "$code" "1" "update with an unknown option exits 1"
assert_contains "$out" "unknown update option" "update names the bad option"

# --- restore with no file: clear usage error, exit 1 ------------------------
out="$(run_asf restore 2>&1)"; code=$?
assert_eq "$code" "1" "restore without a file exits 1"
assert_contains "$out" "usage: asf restore" "restore explains it needs a file"

# --- reset without --yes: refuses ------------------------------------------
out="$(run_asf reset 2>&1)"; code=$?
assert_eq "$code" "1" "reset without --yes exits 1"
assert_contains "$out" "pass --yes" "reset without --yes explains the guard"

# --- host-worker mode (ASF_MODE=2): worker subcommands route to the host supervisor
FAKE_HOME="$(mktemp -d)"
printf 'ASF_MODE=2\nASF_PORT=8787\n' > "$FAKE_ROOT/.env"
run_asf_m2() { ( cd "$FAKE_ROOT" && HOME="$FAKE_HOME" PATH="$EMPTY_BIN:/usr/bin:/bin" NO_COLOR=1 "$FAKE_ROOT/scripts/asf" "$@" ); }

# `asf logs worker` tails the host worker log instead of docker (no container in mode 2)
out="$(run_asf_m2 logs worker 2>&1)"; code=$?
assert_eq "$code" "0" "mode 2: logs worker exits 0"
assert_contains "$out" "no worker log yet" "mode 2: logs worker routes to the host supervisor"

# `asf down worker` with no unit installed => the launcher's clear install hint
out="$(run_asf_m2 down worker 2>&1)"; code=$?
assert_eq "$code" "1" "mode 2: down worker without a unit exits 1"
assert_contains "$out" "host worker not installed" "mode 2: down worker routes to the host supervisor"

rm -rf "$FAKE_HOME"; rm -f "$FAKE_ROOT/.env"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
