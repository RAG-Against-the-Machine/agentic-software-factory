#!/usr/bin/env bash
# Tests for scripts/next-version.sh, each on a throwaway git repo.
#
# Run directly:  bash scripts/next-version.test.sh
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NEXT="$REPO_ROOT/scripts/next-version.sh"

PASS=0
FAIL=0
fail() { printf 'FAIL: %s\n' "$1" >&2; FAIL=$((FAIL + 1)); }
assert_eq() { # $1=actual $2=expected $3=message
  [ "$1" = "$2" ] && PASS=$((PASS + 1)) || fail "$3 (got '$1', want '$2')"
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t

# fresh <name>: a new repo with one commit tagged v1.2.3; cd into it
fresh() {
  mkdir "$TMP/$1" && cd "$TMP/$1" && git init -q -b main . \
    && git commit -q --allow-empty -m 'init' && git tag v1.2.3
}
commit() { git commit -q --allow-empty -m "$1"; }

fresh patch; commit 'fix: ASF-1 a bug'; commit 'chore: ASF-2 tidy'
assert_eq "$(bash "$NEXT")" v1.2.4 'fix/chore -> patch'

fresh untyped; commit 'ASF-3: agent delivery'
assert_eq "$(bash "$NEXT")" v1.2.4 'an untyped commit -> patch'

fresh minor; commit 'fix: ASF-1 a bug'; commit 'feat: ASF-2 a widget'
assert_eq "$(bash "$NEXT")" v1.3.0 'feat -> minor'

fresh scoped; commit 'feat(api): ASF-2 a widget'
assert_eq "$(bash "$NEXT")" v1.3.0 'feat(scope) -> minor'

fresh bang; commit 'feat: ASF-1 a widget'; commit 'feat!: ASF-2 drop v1'
assert_eq "$(bash "$NEXT")" v2.0.0 'feat! -> major'

fresh footer; commit "$(printf 'fix: ASF-1 rename\n\nBREAKING CHANGE: the old name is gone\nTicket: ASF-1')"
assert_eq "$(bash "$NEXT")" v2.0.0 'a BREAKING CHANGE footer -> major'

fresh reuse; commit 'feat: ASF-1 a widget'; git tag v1.3.0
assert_eq "$(bash "$NEXT")" v1.3.0 'HEAD already tagged -> that tag'

fresh rc; commit 'fix: ASF-1 a bug'; git tag v9.0.0-rc1; git tag latest
assert_eq "$(bash "$NEXT")" v1.2.4 'pre-release and non-semver tags are ignored'

fresh highest; git tag v1.10.0; commit 'fix: ASF-1 a bug'
assert_eq "$(bash "$NEXT")" v1.10.1 'counts from the highest tag, numerically'

mkdir "$TMP/none" && cd "$TMP/none" && git init -q -b main . && git commit -q --allow-empty -m 'feat: first'
assert_eq "$(bash "$NEXT")" v0.1.0 'no tags -> v0.1.0'

printf 'next-version.test.sh: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
