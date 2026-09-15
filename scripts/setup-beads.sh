#!/usr/bin/env bash

set -Eeuo pipefail

# Keep the bootstrap path independent of the clone's absolute location. The
# embedded Dolt database belongs under this checkout's ignored .beads/ tree;
# the tracked JSONL export is the portable seed.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

die() {
  printf '[beads] error: %s\n' "$*" >&2
  exit 1
}

command -v bd >/dev/null 2>&1 || die "bd is required. Install Beads, then run npm run beads:setup again."
[[ -d .beads ]] || die "could not find .beads in $REPO_ROOT"
[[ -f .beads/issues.jsonl ]] || die "could not find the tracked .beads/issues.jsonl seed"

if ! bd bootstrap --help >/dev/null 2>&1; then
  die "this bd does not support 'bd bootstrap'; install bd 1.2.2 or newer and retry"
fi

printf '[beads] bootstrapping the repository-local database\n'
bd bootstrap --yes

printf '[beads] verifying issue status\n'
bd status
