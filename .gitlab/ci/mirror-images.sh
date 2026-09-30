#!/bin/sh
# ══════════════════════════════════════════════════════════════════════════════
# mirror-images.sh — copy pinned third-party images into our own registry
# ══════════════════════════════════════════════════════════════════════════════
#
# Run by the `mirror-images` job (.gitlab/ci/mirror.yml) inside the crane debug
# image (busybox sh — keep this POSIX). Reads .gitlab/ci/mirror-images.list.
#
# For each `<name> <src>@sha256:<digest>` line:
#   dest = $REGISTRY/$CI_PROJECT_PATH/mirror/<name>:<tag-from-src>
#   - dest already resolves to <digest>      -> skip (idempotent)
#   - otherwise `crane copy src dest` (keeps the digest) and re-check it
# Never rebuilds, never re-tags a different digest; a mismatch is a red job.
#
# Env:
#   REGISTRY, CI_PROJECT_PATH            destination (same host the build jobs push to)
#   CI_REGISTRY_USER, CI_REGISTRY_PASSWORD   registry credentials (GitLab-provided)
#   MIRROR_LIST      list file (default .gitlab/ci/mirror-images.list)
#   MIRROR_DEST_BASE destination prefix (default $REGISTRY/$CI_PROJECT_PATH/mirror)
#   DRY_RUN=true     resolve and check the SOURCE digests only; no login, no push
set -eu

LIST="${MIRROR_LIST:-.gitlab/ci/mirror-images.list}"
DRY_RUN="${DRY_RUN:-false}"
DEST_BASE="${MIRROR_DEST_BASE:-${REGISTRY:-}/${CI_PROJECT_PATH:-}/mirror}"

if [ "$DRY_RUN" != "true" ]; then
  : "${REGISTRY:?REGISTRY is required}" "${CI_PROJECT_PATH:?CI_PROJECT_PATH is required}"
  : "${CI_REGISTRY_USER:?CI_REGISTRY_USER is required}" "${CI_REGISTRY_PASSWORD:?CI_REGISTRY_PASSWORD is required}"
  echo "$CI_REGISTRY_PASSWORD" | crane auth login "$REGISTRY" -u "$CI_REGISTRY_USER" --password-stdin
fi

fail=0
count=0
while read -r name src _rest; do
  case "$name" in ''|'#'*) continue ;; esac
  count=$((count + 1))

  case "$src" in
    *:*@sha256:????????????????????????????????????????????????????????????????) ;;
    *) echo "FATAL: '$name': '$src' must be <repo>:<tag>@sha256:<64 hex> (an unpinned source is refused)" >&2
       fail=1; continue ;;
  esac
  want="${src##*@}"
  tag="${src%@*}"; tag="${tag##*:}"
  dest="$DEST_BASE/$name:$tag"

  # The source must really be the digest the list claims, or the list is stale.
  have_src="$(crane digest "$src")"
  if [ "$have_src" != "$want" ]; then
    echo "FATAL: '$name': $src resolves to $have_src, list says $want" >&2
    fail=1; continue
  fi

  if [ "$DRY_RUN" = "true" ]; then
    echo "DRY-RUN  $name  $src -> $dest  (source digest verified: $want)"
    continue
  fi

  have_dest="$(crane digest "$dest" 2>/dev/null || true)"
  if [ "$have_dest" = "$want" ]; then
    echo "SKIP     $name  $dest already at $want"
    continue
  fi

  echo "COPY     $name  $src -> $dest"
  crane copy "$src" "$dest"
  got="$(crane digest "$dest")"
  if [ "$got" != "$want" ]; then
    echo "FATAL: '$name': $dest is $got after copy, expected $want" >&2
    fail=1; continue
  fi
  echo "OK       $name  $dest@$want"
done < "$LIST"

[ "$count" -gt 0 ] || { echo "FATAL: no images listed in $LIST" >&2; exit 1; }
exit "$fail"
