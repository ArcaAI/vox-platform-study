#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════════════
# Download the images a GitLab CI pipeline built, as docker-archive tarballs.
#
# Mirrors the pipeline's naming contract by READING the same sources of truth,
# so there is no second copy of the service list or the tag grammar here:
#
#   image repo $REGISTRY/$CI_PROJECT_PATH/<SERVICE_NAME>
#                (.gitlab/ci/templates.yml → .build-template)
#   service set .github/services.json (the single source of
#                truth the services-manifest contract test enforces)
#   tag sha-<sha8> — the immutable audit tag EVERY build pushes, on
#                every branch and every release tag. Env tags (dev-/staging-/
#                prod-/<branch>-<sha8>) point at the same manifest; this is the
#                one that always exists, which is why .gitlab/ci/promote.sh
#                promotes from it and why it is the default here.
#
# "Latest" = the newest SUCCESSFUL pipeline on a ref, resolved through the
# GitLab API — not whatever tag happens to sort highest in the registry.
#
# Portable to bash 3.2 (stock macOS): no arrays, no mapfile.
# ══════════════════════════════════════════════════════════════════════════════
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

GITLAB_API_URL="${GITLAB_API_URL:-https://git.taphuynh.dev/api/v4}"
PROJECT_PATH="${CI_PROJECT_PATH:-arca/hope-v2}"
# Empty = auto-detect below. The pipeline itself always uses the LAN address
# (REGISTRY in .gitlab-ci.yml); the deployment overlays pull through the
# Cloudflare tunnel hostname. Same registry, two routes — which one works
# depends on where this script is run from.
REGISTRY="${REGISTRY:-}"
REGISTRY_LAN="10.10.1.110:5050"          # plain HTTP, LAN only, what CI uses
REGISTRY_TUNNEL="registry.taphuynh.dev"  # HTTPS via cloudflared, works anywhere

REF=""; TAG=""; STATUS="success"; OUT_DIR=""
INCLUDE_BASE=0; GZIP=0; LIST_ONLY=0; SERVICES=""

die()  { printf '\033[31merror\033[0m %s\n' "$*" >&2; exit 1; }
info() { printf '\033[36m%-10s\033[0m %s\n' "$1" "${*:2}"; }

usage() {
  cat <<'USAGE'
Usage: scripts/fetch-images.sh [options] [service ...]

  -r, --ref REF      git ref whose latest successful pipeline to use
                     (default: the current branch)
  -t, --tag TAG      use this image tag verbatim; skips the GitLab API entirely
                     (e.g. sha-a4b1c2d3, dev-a4b1c2d3, ALL-2.1.0)
      --status S pipeline status to match (default: success)
  -o, --out DIR      output directory (default: ./image-bundles/<tag>)
      --registry H registry host (default: auto — 10.10.1.110:5050 when the
                     LAN is reachable, else registry.taphuynh.dev)
      --include-base also fetch hope-python-base (promotable:false, build-time only)
      --gzip gzip each tarball after saving
      --list resolve and print what would be fetched, download nothing
  -h, --help

  With no service names, every promotable service in .github/services.json.

Environment:
  GITLAB_TOKEN                     PAT with read_api (pipeline lookup) AND
                                   read_registry (the pull). Doubles as the
                                   registry password unless REGISTRY_PASSWORD is set.
  GITLAB_API_URL                   default https://git.taphuynh.dev/api/v4
  REGISTRY                         pin the registry host, skipping auto-detection
  REGISTRY_USER / REGISTRY_PASSWORD
                                   override the registry credentials — needed for a
                                   DEPLOY token, whose username GitLab does check

Examples:
  scripts/fetch-images.sh                        # latest success on this branch
  scripts/fetch-images.sh -r dev-2.2 --list
  scripts/fetch-images.sh -t ALL-2.1.0 --gzip
  scripts/fetch-images.sh api text harness
USAGE
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    -r|--ref)       REF="$2"; shift 2 ;;
    -t|--tag)       TAG="$2"; shift 2 ;;
    -o|--out)       OUT_DIR="$2"; shift 2 ;;
    --status) STATUS="$2"; shift 2 ;;
    --registry) REGISTRY="$2"; shift 2 ;;
    --include-base) INCLUDE_BASE=1; shift ;;
    --gzip) GZIP=1; shift ;;
    --list) LIST_ONLY=1; shift ;;
    -h|--help)      usage 0 ;;
    -*)             die "unknown flag: $1 (see --help)" ;;
    *)              SERVICES="$SERVICES $1"; shift ;;
  esac
done

command -v jq >/dev/null 2>&1 || die "jq is required"

# ── Pick a route to the registry ────────────────────────────────────────────
# A live registry answers /v2/ with 200 or 401 (401 = alive, needs auth), so
# any HTTP status counts as reachable; curl reports 000 when it never connected.
registry_alive() {
  code=$(curl -s -o /dev/null -m "${2:-4}" -w '%{http_code}' "$1/v2/" 2>/dev/null || true)
  [ -n "$code" ] && [ "$code" != "000" ]
}

if [ -z "$REGISTRY" ]; then
  if registry_alive "http://$REGISTRY_LAN" 3; then
    REGISTRY="$REGISTRY_LAN"
  elif registry_alive "https://$REGISTRY_TUNNEL" 8; then
    REGISTRY="$REGISTRY_TUNNEL"
    # Measured: multi-GB pulls through the tunnel run at tens to hundreds of
    # KB/s. Fine for api/text; painful for stt-ml-runtime and lmstudio.
    printf '\033[33mnote\033[0m      LAN registry unreachable — pulling through the Cloudflare tunnel (slow for large images)\n'
  else
    die "no route to the registry: neither http://$REGISTRY_LAN nor https://$REGISTRY_TUNNEL answered /v2/"
  fi
fi

# ── Resolve the tag ─────────────────────────────────────────────────────────
PIPELINE_ID=""; COMMIT_SHA=""

if [ -z "$TAG" ]; then
  [ -n "${GITLAB_TOKEN:-}" ] || die "GITLAB_TOKEN is required to resolve the latest pipeline (or pass --tag)"
  REF="${REF:-$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)}"

  enc_project=$(printf '%s' "$PROJECT_PATH" | sed 's|/|%2F|g')
  resp=$(curl -sS --fail-with-body \
    -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
    "$GITLAB_API_URL/projects/$enc_project/pipelines?ref=$REF&status=$STATUS&per_page=1") \
    || die "GitLab API call failed — check GITLAB_TOKEN and that $GITLAB_API_URL is reachable"

  PIPELINE_ID=$(printf '%s' "$resp" | jq -r '.[0].id // empty')
  COMMIT_SHA=$(printf '%s' "$resp" | jq -r '.[0].sha // empty')
  [ -n "$COMMIT_SHA" ] || die "no '$STATUS' pipeline found for ref '$REF'"

  TAG="sha-$(printf '%s' "$COMMIT_SHA" | cut -c1-8)"
  info "pipeline" "#$PIPELINE_ID  ref=$REF  commit=$(printf '%s' "$COMMIT_SHA" | cut -c1-8)"
else
  info "source" "explicit --tag, no pipeline lookup"
fi

OUT_DIR="${OUT_DIR:-$REPO_ROOT/image-bundles/$TAG}"

# ── Resolve the service list from the manifest ──────────────────────────────
MANIFEST="$REPO_ROOT/.github/services.json"
[ -f "$MANIFEST" ] || die "missing $MANIFEST"
ALL_NAMES=$(jq -r '[.services[].name] | join(" ")' "$MANIFEST")

if [ -z "$SERVICES" ]; then
  if [ "$INCLUDE_BASE" = 1 ]; then
    SERVICES=$(jq -r '[.services[].name] | join(" ")' "$MANIFEST")
  else
    SERVICES=$(jq -r '[.services[] | select(.promotable) | .name] | join(" ")' "$MANIFEST")
  fi
else
  for svc in $SERVICES; do
    jq -e --arg n "$svc" '.services[] | select(.name == $n)' "$MANIFEST" >/dev/null \
      || die "'$svc' is not in .github/services.json (valid: $ALL_NAMES)"
  done
fi

platform_of() {
  jq -r --arg n "$1" '.services[] | select(.name==$n) | .platforms[0] // "linux/amd64"' "$MANIFEST"
}

info "registry" "$REGISTRY/$PROJECT_PATH"
info "tag"      "$TAG"
info "services" "$(printf '%s' "$SERVICES" | wc -w | tr -d ' ') —$SERVICES"
info "output"   "$OUT_DIR"

if [ "$LIST_ONLY" = 1 ]; then
  echo
  for svc in $SERVICES; do
    printf '  %s/%s/%s:%s  (%s)\n' "$REGISTRY" "$PROJECT_PATH" "$svc" "$TAG" "$(platform_of "$svc")"
  done
  exit 0
fi

# ── Pick a transport ────────────────────────────────────────────────────────
# skopeo is preferred: it copies registry → docker-archive with no daemon, and
# takes the plain-HTTP registry via a flag rather than needing the host's
# docker daemon reconfigured with `insecure-registries` (the registry IS plain
# HTTP — see the buildkitd.toml written by .buildx-registry-login).
if command -v skopeo >/dev/null 2>&1; then
  TRANSPORT=skopeo
elif command -v docker >/dev/null 2>&1; then
  TRANSPORT=docker
  docker info >/dev/null 2>&1 || die "docker is installed but its daemon is not reachable"
else
  die "need either skopeo (preferred: brew install skopeo) or docker"
fi
info "transport" "$TRANSPORT"

# ── Registry credentials ────────────────────────────────────────────────────
# A GitLab PAT authenticates the container registry as well as the API, so the
# GITLAB_TOKEN already needed for the pipeline lookup covers the pull too — it
# just needs the read_registry scope alongside read_api.
#
# The username half is NOT checked for a personal access token (verified
# against this instance's /jwt/auth: `tap`, `gitlab-ci-token` and a nonsense
# value all minted the same pull-scoped JWT). A DEPLOY token is different — its
# username is assigned by GitLab and the pair is rejected if it does not match,
# which is why REGISTRY_USER stays overridable.
if [ -z "${REGISTRY_PASSWORD:-}" ] && [ -n "${GITLAB_TOKEN:-}" ]; then
  REGISTRY_PASSWORD="$GITLAB_TOKEN"
  REGISTRY_USER="${REGISTRY_USER:-gitlab-ci-token}"
fi

# skopeo takes creds per-invocation (see the helpers below); the docker daemon
# has to be logged in, and without this it pulls anonymously and every service
# fails with `denied: access forbidden`.
if [ "$TRANSPORT" = docker ] && [ -n "${REGISTRY_USER:-}" ]; then
  printf '%s' "${REGISTRY_PASSWORD:-}" \
    | docker login -u "$REGISTRY_USER" --password-stdin "$REGISTRY" >/dev/null 2>&1 \
    || die "docker login to $REGISTRY failed as '$REGISTRY_USER' — is the token's read_registry scope set?"
  info "auth" "docker login ok ($REGISTRY_USER)"
fi

skopeo_digest() {
  if [ -n "${REGISTRY_USER:-}" ]; then
    skopeo inspect --tls-verify=false --creds "$REGISTRY_USER:${REGISTRY_PASSWORD:-}" \
      --format '{{.Digest}}' "docker://$1"
  else
    skopeo inspect --tls-verify=false --format '{{.Digest}}' "docker://$1"
  fi
}

skopeo_copy() {
  img="$1"; dest="$2"; os="$3"; arch="$4"
  if [ -n "${REGISTRY_USER:-}" ]; then
    skopeo copy --src-tls-verify=false --src-creds "$REGISTRY_USER:${REGISTRY_PASSWORD:-}" \
      --override-os "$os" --override-arch "$arch" \
      "docker://$img" "docker-archive:$dest:$img"
  else
    skopeo copy --src-tls-verify=false \
      --override-os "$os" --override-arch "$arch" \
      "docker://$img" "docker-archive:$dest:$img"
  fi
}

mkdir -p "$OUT_DIR"
DIGEST_LINES="$OUT_DIR/.digests.jsonl"
: > "$DIGEST_LINES"
PULLED=""; SKIPPED=""

for svc in $SERVICES; do
  image="$REGISTRY/$PROJECT_PATH/$svc:$TAG"
  platform="$(platform_of "$svc")"
  tarball="$OUT_DIR/$svc.tar"

  printf '\n\033[1m── %s\033[0m  %s\n' "$svc" "$image"

  digest=""
  if [ "$TRANSPORT" = skopeo ]; then
    digest=$(skopeo_digest "$image" 2>/dev/null) || digest=""
    if [ -z "$digest" ]; then
      # Same posture as promote.sh: a missing tag is a skip with a warning, not
      # a failure of the whole run — some images only build on ALL-/tag pipelines.
      echo "  SKIP — not present in the registry at this tag"
      SKIPPED="$SKIPPED $svc"; continue
    fi
    skopeo_copy "$image" "$tarball" "${platform%%/*}" "${platform##*/}"
  else
    docker pull --platform "$platform" "$image" \
      || { echo "  SKIP — pull failed"; SKIPPED="$SKIPPED $svc"; continue; }
    digest=$(docker image inspect --format '{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}' "$image" | sed 's/.*@//')
    docker save -o "$tarball" "$image"
  fi

  if [ "$GZIP" = 1 ]; then
    gzip -f "$tarball"
    tarball="$tarball.gz"
  fi

  printf '  OK  %s  %s  %s\n' "$(basename "$tarball")" "$(du -h "$tarball" | cut -f1 | tr -d ' ')" "${digest:-<no digest>}"
  jq -nc --arg s "$svc" --arg i "$image" --arg d "$digest" --arg f "$(basename "$tarball")" \
    '{service:$s, image:$i, digest:$d, file:$f}' >> "$DIGEST_LINES"
  PULLED="$PULLED $svc"
done

# ── Bundle manifest + checksums ─────────────────────────────────────────────
# bundle.json carries the sha256 digests, so a bundle carried to another
# cluster can be checked against the digest the overlay was pinned to.
jq -n \
  --arg tag "$TAG" --arg ref "${REF:-}" --arg pipeline "$PIPELINE_ID" \
  --arg commit "$COMMIT_SHA" --arg registry "$REGISTRY/$PROJECT_PATH" \
  --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --slurpfile images "$DIGEST_LINES" \
  '{tag:$tag, ref:$ref, pipelineId:$pipeline, commitSha:$commit,
    registry:$registry, fetchedAt:$at, images:$images}' \
  > "$OUT_DIR/bundle.json"
rm -f "$DIGEST_LINES"

( cd "$OUT_DIR" && shasum -a 256 ./*.tar ./*.tar.gz > SHA256SUMS 2>/dev/null || true )

n_pulled=$(printf '%s' "$PULLED" | wc -w | tr -d ' ')

# Nothing at all came down: that is an access/route problem, not 14 missing
# images. Fail loudly rather than leaving an empty bundle that looks like a
# successful run.
if [ "$n_pulled" = 0 ]; then
  printf '\n\033[31mfailed\033[0m    nothing was downloaded (skipped:%s)\n' "$SKIPPED" >&2
  printf '           if every service was skipped it is almost certainly credentials — give the\n' >&2
  printf '           script a GITLAB_TOKEN carrying read_registry (not just read_api), or set\n' >&2
  printf '           REGISTRY_USER / REGISTRY_PASSWORD, or `docker login %s`.\n' "$REGISTRY" >&2
  exit 1
fi

printf '\n\033[32mdone\033[0m      %s image(s) → %s\n' "$n_pulled" "$OUT_DIR"
[ -z "$SKIPPED" ] || printf '\033[33mskipped\033[0m  %s\n' "$SKIPPED"
printf 'load with:  for f in %s/*.tar*; do docker load -i "$f"; done\n' "$OUT_DIR"
