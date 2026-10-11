#!/usr/bin/env bash
# Tests for scripts/install.sh (M10 WP7).
#
# Run directly:  bash scripts/install.test.sh
#
# No network/real git remote is used: a fake `git` is put on PATH that logs
# its invocations and materializes a minimal checkout (scripts/setup.sh is a
# stub that records how it was invoked) instead of actually cloning.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_SH="$REPO_ROOT/scripts/install.sh"

PASS=0
FAIL=0

fail() { printf 'FAIL: %s\n' "$1" >&2; FAIL=$((FAIL + 1)); }
pass() { PASS=$((PASS + 1)); }

assert_contains() { # $1=haystack $2=needle $3=message
  case "$1" in *"$2"*) pass ;; *) fail "$3 (expected to find: $2)" ;; esac
}
assert_eq() { # $1=actual $2=expected $3=message
  [ "$1" = "$2" ] && pass || fail "$3 (got '$1', want '$2')"
}

FAKE_BIN="$(mktemp -d)"
FAKE_ASF_HOME="$(mktemp -d)/asf-home"
cleanup() { rm -rf "$FAKE_BIN" "$(dirname "$FAKE_ASF_HOME")"; }
trap cleanup EXIT

# fake git: logs every call, materializes scripts/setup.sh (a stub) on clone
GIT_LOG="$FAKE_BIN/git.log"
: > "$GIT_LOG"
cat > "$FAKE_BIN/git" <<EOF
#!/usr/bin/env bash
echo "\$@" >> "$GIT_LOG"
case "\$1" in
  clone)
    dest="\${@: -1}"
    mkdir -p "\$dest/.git" "\$dest/scripts"
    cat > "\$dest/scripts/setup.sh" <<'STUB'
#!/usr/bin/env bash
echo "setup.sh called with: \$*"
STUB
    chmod +x "\$dest/scripts/setup.sh"
    exit 0
    ;;
  -C)
    exit 0
    ;;
esac
exit 0
EOF
chmod +x "$FAKE_BIN/git"

run_install() {
  ( ASF_HOME="$FAKE_ASF_HOME" PATH="$FAKE_BIN:$PATH" bash "$INSTALL_SH" "$@" )
}

# --- fresh install: clones into ASF_HOME and hands off to setup.sh ------
rm -rf "$FAKE_ASF_HOME"
out="$(run_install --non-interactive --no-up 2>&1)"; code=$?
assert_eq "$code" "0" "fresh install exits 0"
assert_contains "$out" "Cloning" "fresh install clones (checkout not present)"
assert_contains "$(cat "$GIT_LOG")" "clone" "fresh install invokes git clone"
assert_contains "$out" "$FAKE_ASF_HOME" "fresh install reports the checkout path"
assert_contains "$out" "setup.sh called with: --non-interactive --no-up" "fresh install hands off to setup.sh with args passed through"

# --- existing checkout: updates instead of cloning -----------------------
: > "$GIT_LOG"
out="$(run_install --non-interactive --no-up 2>&1)"; code=$?
assert_eq "$code" "0" "update path exits 0"
assert_contains "$out" "Updating existing checkout" "existing checkout is updated, not re-cloned"
assert_contains "$(cat "$GIT_LOG")" "fetch" "update path fetches"
[ "$(grep -c '^clone' "$GIT_LOG")" -eq 0 ] && pass || fail "update path does not re-clone"

# --- missing git => clear failure, exit 1 --------------------------------
rm -rf "$FAKE_ASF_HOME"
NO_GIT_BIN="$(mktemp -d)"
out="$(ASF_HOME="$FAKE_ASF_HOME" PATH="$NO_GIT_BIN" "$(command -v bash)" "$INSTALL_SH" 2>&1)"; code=$?
assert_eq "$code" "1" "missing git => exit 1"
assert_contains "$out" "git is required" "missing git => clear failure message"
rm -rf "$NO_GIT_BIN"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
