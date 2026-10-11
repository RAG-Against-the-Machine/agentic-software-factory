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
assert_contains "$out" "secret-key" "help lists the secret-key command"

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

# --- secret-key (#9) against a fake docker --------------------------------------
# The fake answers `compose exec registry node …` (the /health secrets probe) from
# a queue of states, reports every container healthy, and logs every call.
FAKE_DOCKER_BIN="$(mktemp -d)"
cat > "$FAKE_DOCKER_BIN/docker" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "$FAKE_LOG"
case "$*" in
  *" exec -T registry node "*)
    line="$(head -1 "$FAKE_STATES")"; rest="$(tail -n +2 "$FAKE_STATES")"
    [ -n "$rest" ] && printf '%s\n' "$rest" > "$FAKE_STATES"
    printf '%s' "$line" ;;
  *" ps -q "*) echo cid123 ;;
  inspect*) echo healthy ;;
esac
exit 0
EOF
chmod +x "$FAKE_DOCKER_BIN/docker"
run_asf_fd() { ( cd "$FAKE_ROOT" && PATH="$FAKE_DOCKER_BIN:/usr/bin:/bin" NO_COLOR=1 FAKE_LOG="$FAKE_ROOT/docker.log" FAKE_STATES="$FAKE_ROOT/states" "$FAKE_ROOT/scripts/asf" "$@" ); }
envget() { awk -F= -v k="$1" '$1==k{print substr($0, length(k)+2)}' "$FAKE_ROOT/.env" | tail -1; }

out="$(run_asf_fd secret-key 2>&1)"; code=$?
assert_eq "$code" "1" "secret-key without .env fails"
assert_contains "$out" ".env missing" "secret-key names the missing .env"

printf 'ASF_PORT=8787\nRUN_EVENT_SECRET=abc\nASF_SECRET_KEY=\n' > "$FAKE_ROOT/.env"; chmod 644 "$FAKE_ROOT/.env"
printf 'encrypted|1a2b3c4d|3|0|0\n' > "$FAKE_ROOT/states"; : > "$FAKE_ROOT/docker.log"
out="$(run_asf_fd secret-key 2>&1)"; code=$?
assert_eq "$code" "0" "secret-key succeeds"
k1="$(envget ASF_SECRET_KEY)"
assert_eq "${#k1}" "64" "secret-key writes a 64-hex ASF_SECRET_KEY"
assert_eq "$(envget RUN_EVENT_SECRET)" "abc" "secret-key leaves other keys alone"
perm="$(stat -c '%a' "$FAKE_ROOT/.env" 2>/dev/null || stat -f '%Lp' "$FAKE_ROOT/.env")"
assert_eq "$perm" "600" "secret-key leaves .env chmod 600"
assert_contains "$(cat "$FAKE_ROOT/docker.log")" "up -d --no-deps registry" "secret-key recreates only the registry"
assert_contains "$out" "3 encrypted at rest (key 1a2b3c4d)" "secret-key reports the encrypted tokens"
case "$out" in *"$k1"*) fail "secret-key must not print the key" ;; *) pass ;; esac

out="$(run_asf_fd secret-key 2>&1)"; code=$?
assert_eq "$(envget ASF_SECRET_KEY)" "$k1" "secret-key never replaces an existing key"
assert_contains "$out" "keeping it" "secret-key says it kept the key"

printf 'encrypted|99aa88bb|3|0|0\n' > "$FAKE_ROOT/states"; : > "$FAKE_ROOT/docker.log"
out="$(run_asf_fd secret-key --rotate 2>&1)"; code=$?
assert_eq "$code" "0" "rotate succeeds"
k2="$(envget ASF_SECRET_KEY)"
[ "$k2" != "$k1" ] && [ "${#k2}" = "64" ] && pass || fail "rotate writes a fresh key"
assert_eq "$(envget ASF_SECRET_KEY_PREVIOUS)" "" "rotate removes the previous key once the registry proves it unneeded"
assert_eq "$(grep -c 'up -d --no-deps registry' "$FAKE_ROOT/docker.log")" "2" "rotate restarts the registry twice (move, then prove)"
assert_contains "$out" "every saved token is on the new key" "rotate reports success"

# rotate where the proof fails: the old key goes back as PREVIOUS, nothing is lost
printf 'encrypted|11112222|3|0|0\nencrypted|11112222|3|0|0\nkey-mismatch|11112222|3|0|1\n' > "$FAKE_ROOT/states"
out="$(run_asf_fd secret-key --rotate 2>&1)"; code=$?
assert_eq "$code" "1" "rotate fails when a token still needs the old key"
assert_eq "$(envget ASF_SECRET_KEY_PREVIOUS)" "$k2" "the old key is restored as ASF_SECRET_KEY_PREVIOUS"

printf 'ASF_PORT=8787\nRUN_EVENT_SECRET=abc\nASF_SECRET_KEY=x\nASF_SECRET_KEY_PREVIOUS=y\n' > "$FAKE_ROOT/.env"
out="$(run_asf_fd secret-key --rotate 2>&1)"; code=$?
assert_eq "$code" "1" "rotate refuses while a previous rotation is unfinished"
rm -f "$FAKE_ROOT/.env" "$FAKE_ROOT/states" "$FAKE_ROOT/docker.log" "$FAKE_ROOT/.env.bak"; rm -rf "$FAKE_DOCKER_BIN"

# --- restore (#9): key pre-check against .env, post-check against /health -------
FAKE_DOCKER_BIN="$(mktemp -d)"
cat > "$FAKE_DOCKER_BIN/docker" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "$FAKE_LOG"
case "$*" in
  *" exec -T registry node "*) head -1 "$FAKE_STATES" | tr -d '\n' ;;
  *" exec -T backup "*) cat >/dev/null ;;
  *" ps -q "*) echo cid123 ;;
  inspect*) echo healthy ;;
esac
exit 0
EOF
chmod +x "$FAKE_DOCKER_BIN/docker"
keyid() { { printf 'asf-org-secret-key-id:'; printf "$(printf '%s' "$1" | sed 's/../\\x&/g')"; } | openssl dgst -sha256 | sed 's/^.*= *//' | cut -c1-8; }
K1="$(openssl rand -hex 32)"; K2="$(openssl rand -hex 32)"
ID1="$(keyid "$K1")"; ID2="$(keyid "$K2")"
printf 'COPY public.org_secret (name, value) FROM stdin;\nGITHUB_TOKEN\tplain\n\\.\n' | gzip > "$FAKE_ROOT/plain.sql.gz"
printf 'COPY public.org_secret (name, value) FROM stdin;\nGITHUB_TOKEN\tenc:v1:%s:aXY=:dGFn:Y3Q=\n\\.\n' "$ID1" | gzip > "$FAKE_ROOT/k1.sql.gz"
printf 'not gzip' > "$FAKE_ROOT/bad.sql.gz"

printf 'ASF_PORT=8787\nASF_SECRET_KEY=%s\n' "$K1" > "$FAKE_ROOT/.env"; chmod 600 "$FAKE_ROOT/.env"
printf 'plaintext|%s|1|1|0\n' "$ID1" > "$FAKE_ROOT/states"; : > "$FAKE_ROOT/docker.log"
out="$(run_asf_fd restore plain.sql.gz </dev/null 2>&1)"; code=$?
assert_eq "$code" "0" "restore of a pre-#9 (plaintext) dump succeeds"
assert_contains "$(cat "$FAKE_ROOT/docker.log")" "exec -T backup" "restore actually loads a plaintext dump"
assert_contains "$out" "saved tokens are in plaintext" "restore points a plaintext restore at asf secret-key"

printf 'encrypted|%s|1|0|0\n' "$ID1" > "$FAKE_ROOT/states"
out="$(run_asf_fd restore k1.sql.gz </dev/null 2>&1)"; code=$?
assert_eq "$code" "0" "restore with the matching key succeeds"
case "$out" in *"not the ASF_SECRET_KEY"*) fail "matching key must not warn" ;; *) pass ;; esac

printf 'ASF_PORT=8787\nASF_SECRET_KEY=%s\nASF_SECRET_KEY_PREVIOUS=%s\n' "$K2" "$K1" > "$FAKE_ROOT/.env"
out="$(run_asf_fd restore k1.sql.gz </dev/null 2>&1)"; code=$?
case "$out" in *"not the ASF_SECRET_KEY"*) fail "a key in ASF_SECRET_KEY_PREVIOUS counts as present" ;; *) pass ;; esac

printf 'ASF_PORT=8787\nASF_SECRET_KEY=%s\n' "$K2" > "$FAKE_ROOT/.env"
printf 'key-mismatch|%s|1|0|1\n' "$ID2" > "$FAKE_ROOT/states"
out="$(run_asf_fd restore k1.sql.gz </dev/null 2>&1)"; code=$?
assert_contains "$out" "encrypted with key ${ID1}, which is not the ASF_SECRET_KEY in .env (key ${ID2})" "restore names both keys before replacing anything"
assert_eq "$code" "1" "restore fails loudly when restored tokens can't be decrypted"
assert_contains "$out" "can't be decrypted" "restore explains the post-check failure"
case "$out" in *"$K1"*|*"$K2"*) fail "restore must never print a key" ;; *) pass ;; esac

: > "$FAKE_ROOT/docker.log"
out="$(run_asf_fd restore bad.sql.gz </dev/null 2>&1)"; code=$?
assert_eq "$code" "1" "restore refuses a corrupt dump"
assert_eq "$(cat "$FAKE_ROOT/docker.log")" "" "a corrupt dump touches nothing"
rm -f "$FAKE_ROOT"/*.sql.gz "$FAKE_ROOT/.env" "$FAKE_ROOT/states" "$FAKE_ROOT/docker.log"; rm -rf "$FAKE_DOCKER_BIN"

# --- doctor flags an empty ASF_SECRET_KEY (even with docker absent) ------------
printf 'ASF_PORT=8787\nRUN_EVENT_SECRET=abc\nASF_SECRET_KEY=\n' > "$FAKE_ROOT/.env"; chmod 600 "$FAKE_ROOT/.env"
out="$(run_asf doctor 2>&1)"
assert_contains "$out" "ASF_SECRET_KEY is empty" "doctor warns about plaintext saved tokens"
assert_contains "$out" "asf secret-key" "doctor's fix points at asf secret-key"
rm -f "$FAKE_ROOT/.env"

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
