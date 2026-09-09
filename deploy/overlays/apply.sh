#!/usr/bin/env bash
# Apply the local overlays to the working tree.
#
# The overlays exist so this repository can carry fixes to upstream-tracked files
# WITHOUT committing changes to them. Committed state stays byte-identical to
# upstream, so `git merge upstream/main` can never conflict; the patches are
# applied on a copy at image-build time, or temporarily during local dev.
#
#   ./deploy/overlays/apply.sh              apply every overlay
#   ./deploy/overlays/apply.sh --check      report status, change nothing
#   ./deploy/overlays/apply.sh --revert     restore the pristine upstream files
#   ./deploy/overlays/apply.sh --only 001   act on a single overlay by prefix
#
# Idempotent: applying twice is a no-op, not an error.
#
# Uses `git apply` when available and falls back to `patch`, so the same script
# runs both in a checkout and inside a container image that has no git.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
MODE=apply
ONLY=""

while [ $# -gt 0 ]; do
  case "$1" in
    --check)  MODE=check ;;
    --revert) MODE=revert ;;
    --only)   ONLY="${2:-}"; shift ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

cd "$ROOT"

if command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  BACKEND=git
elif command -v patch >/dev/null 2>&1; then
  BACKEND=patch
else
  echo "need either git or patch on PATH" >&2
  exit 1
fi

# Which files does this patch target, and are any of them present here?
# Images copy only part of the tree (no docs/, no CLAUDE.md), so a patch whose
# targets are all absent is not a conflict — it simply does not apply to this
# context and is skipped. A patch whose targets exist but will not apply IS a
# conflict, and must stop the build.
targets_present() {
  local f present=1
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    present=0
    [ -e "$f" ] && return 0
  done < <(sed -n 's|^+++ b/||p' "$1")
  [ $present -eq 1 ] && return 0   # no parsable targets: let the backend decide
  return 1
}

is_applied() { # patch already in the tree?
  case $BACKEND in
    git)   git apply --reverse --check "$1" >/dev/null 2>&1 ;;
    patch) patch -p1 -R --dry-run -s -f -i "$1" >/dev/null 2>&1 ;;
  esac
}
is_pending() { # patch applies cleanly?
  case $BACKEND in
    git)   git apply --check "$1" >/dev/null 2>&1 ;;
    patch) patch -p1 --dry-run -s -f -i "$1" >/dev/null 2>&1 ;;
  esac
}
do_apply()  { case $BACKEND in git) git apply "$1" ;; patch) patch -p1 -s -i "$1" ;; esac; }
do_revert() { case $BACKEND in git) git apply --reverse "$1" ;; patch) patch -p1 -R -s -i "$1" ;; esac; }

shopt -s nullglob
patches=("$DIR"/*.patch)
[ ${#patches[@]} -gt 0 ] || { echo "no overlays found in $DIR" >&2; exit 1; }

rc=0
for p in "${patches[@]}"; do
  name="$(basename "$p")"
  [ -n "$ONLY" ] && [[ "$name" != "$ONLY"* ]] && continue

  if   ! targets_present "$p"; then state=skipped
  elif is_applied "$p";        then state=applied
  elif is_pending "$p";        then state=pending
  else                              state=conflict
  fi

  case "$MODE:$state" in
    check:*)          printf '  %-11s %s\n' "$state" "$name" ;;
    *:skipped)        printf '  skipped     %s  (targets not in this tree)\n' "$name" ;;
    apply:applied)    printf '  already     %s\n' "$name" ;;
    apply:pending)    do_apply  "$p" && printf '  applied     %s\n' "$name" ;;
    revert:applied)   do_revert "$p" && printf '  reverted    %s\n' "$name" ;;
    revert:pending)   printf '  not applied %s\n' "$name" ;;
    *:conflict)
      # Upstream moved under the patch. Do not guess — a half-applied overlay is
      # worse than none.
      printf '  CONFLICT    %s  (upstream changed; regenerate this patch)\n' "$name" >&2
      rc=1 ;;
  esac
done
exit $rc
