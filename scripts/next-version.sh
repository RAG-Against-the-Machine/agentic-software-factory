#!/usr/bin/env bash
# Print the release version for HEAD (vX.Y.Z), from the Conventional Commits since
# the highest strict vX.Y.Z tag in HEAD's history (images.yml tags the release).
#
#   a `type!:` subject or a `BREAKING CHANGE:` footer  -> major
#   any `feat:` (or `feat(scope):`)                     -> minor
#   anything else (fix, chore, docs, untyped, ...)      -> patch
#
# HEAD already carries a strict tag: that tag (a re-run releases the same number).
# No strict tag yet: v0.1.0. Pre-releases like v1.2.0-rc1 are ignored.
#
# Usage: scripts/next-version.sh   (run inside the repo; needs the full history + tags)
set -euo pipefail

STRICT='^v[0-9]+\.[0-9]+\.[0-9]+$'

at_head="$(git tag --points-at HEAD | grep -E "$STRICT" | sort -V | tail -n1 || true)"
if [ -n "$at_head" ]; then echo "$at_head"; exit 0; fi

last="$(git tag --merged HEAD | grep -E "$STRICT" | sort -V | tail -n1 || true)"
if [ -z "$last" ]; then echo "v0.1.0"; exit 0; fi

IFS=. read -r major minor patch <<<"${last#v}"

# Here-strings, not `git log | grep -q`: grep exiting early would SIGPIPE git log and,
# under pipefail, read as "no match".
log="$(git log --format='%s%n%b' "$last..HEAD")"
subjects="$(git log --format='%s' "$last..HEAD")"
if grep -qE '^[a-zA-Z]+(\([^)]*\))?!:|^BREAKING[ -]CHANGE:' <<<"$log"; then
  echo "v$((major + 1)).0.0"
elif grep -qE '^feat(\([^)]*\))?:' <<<"$subjects"; then
  echo "v$major.$((minor + 1)).0"
else
  echo "v$major.$minor.$((patch + 1))"
fi
