#!/bin/sh
# ══════════════════════════════════════════════════════════════════════════════
# Digest promotion — TASK-616 Appendix F (component-design-cicd-promotion.md)
# §F1-F3, F9.
#
# Copies each service's already-built `sha-<sha8>` image to an environment
# tag with ZERO rebuild (docker buildx imagetools create), then pins the
# hope-v2-deployment overlay to the resolved sha256 digest and pushes to
# `main` (the branch Argo CD actually reads).
#
# Replaces:
#   - the Argo CD Image Updater (§F2 — wrong tag regex, wrong write-back
#     branch, stale image names, and a Git-write PAT it holds in plaintext
#     alongside registry creds; decommissioned, see deployment/argocd/).
#   - the old `deploy-staging` job, which edited a Helm-values layout
#     (`apps/<svc>/values-staging.yaml`) in a `hope-deployments` repo that
#     never existed. The real repo is `arca/hope-v2-deployment`, pure
#     Kustomize.
#
# Required env (set by the calling job):
#   DEPLOY_ENV       dev | staging | prod
#   OVERLAY_PATH     deployment/k8s/overlays/<env>  (relative to repo root)
#   REGISTRY, CI_PROJECT_PATH, CI_COMMIT_SHA        — GitLab/pipeline-provided
#   CI_COMMIT_TAG                                    — required when DEPLOY_ENV=prod
#   DEPLOY_REPO_URL, DEPLOY_TOKEN                    — from Vault (deploy/DEPLOY_TOKEN)
#
# Digest resolution assumes the commit being promoted was ALREADY built with
# a `sha-<sha8>` tag earlier in this same pipeline (dev-*/staging-* branches,
# where `.build-common-rules` still builds unconditionally) OR in an earlier
# pipeline on the same commit (prod: a `vX.Y.Z` tag does not move the commit,
# so `$CI_COMMIT_SHA` is identical to the staging pipeline that already built
# it — see §F11). If no such tag exists, `imagetools inspect` fails cleanly
# instead of silently rebuilding.
# ══════════════════════════════════════════════════════════════════════════════
set -eu

: "${DEPLOY_ENV:?DEPLOY_ENV is required (dev|staging|prod)}"
: "${OVERLAY_PATH:?OVERLAY_PATH is required}"
: "${REGISTRY:?REGISTRY is required}"
: "${CI_PROJECT_PATH:?CI_PROJECT_PATH is required}"
: "${CI_COMMIT_SHA:?CI_COMMIT_SHA is required}"
: "${DEPLOY_REPO_URL:?DEPLOY_REPO_URL is required}"
: "${DEPLOY_TOKEN:?DEPLOY_TOKEN is required (Vault deploy/DEPLOY_TOKEN, see vault.yml)}"

SHORT_SHA=$(echo "$CI_COMMIT_SHA" | cut -c1-8)
SOURCE_TAG="sha-${SHORT_SHA}"

case "$DEPLOY_ENV" in
  dev|staging)
    ENV_TAG="${DEPLOY_ENV}-${SHORT_SHA}"
    ;;
  prod)
    : "${CI_COMMIT_TAG:?promote-prod must run on a vX.Y.Z tag pipeline (PIPELINE_TYPE=tag_release, see .gitlab-ci.yml + F11)}"
    ENV_TAG="$CI_COMMIT_TAG"
    ;;
  *)
    echo "Unknown DEPLOY_ENV: $DEPLOY_ENV (expected dev|staging|prod)" >&2
    exit 1
    ;;
esac

echo "── Promoting ${SOURCE_TAG} → ${DEPLOY_ENV} (env tag: ${ENV_TAG}) ──"

# §F9 — the canonical 11-service list, plus the two job images: `database`
# (the migration Job) and `qdrant-init` (the Argo PreSync collection-bootstrap
# Job). Both are built by build.yml and referenced by the deployment repo's
# base/, so both must be pinned or they deploy as an unresolvable
# `hope-v2/<name>:latest`. `harness-worker` graduated from placeholder to a
# real build job (build.yml `build-harness-worker`) + manifest
# (base/harness-worker.yaml).
#
# Every name here MUST equal the `SERVICE_NAME` of its build job — that is what
# forms `$REGISTRY/$CI_PROJECT_PATH/<name>` — and the `hope-v2/<name>` key the
# overlays use. A name with no matching `sha-<sha8>` tag is skipped with a
# warning rather than failing the whole promotion.
SERVICES="api stt-ml-runtime stt-worker smr guardrail harness harness-worker nlp tts admin-console compat-playground database qdrant-init"

PROMOTED=""
for svc in $SERVICES; do
  image_repo="$REGISTRY/$CI_PROJECT_PATH/$svc"
  source_ref="${image_repo}:${SOURCE_TAG}"

  digest=$(docker buildx imagetools inspect "$source_ref" 2>/dev/null | awk '/^Digest:/ {print $2; exit}') || digest=""
  if [ -z "$digest" ]; then
    echo "  SKIP  ${svc} — no ${source_ref} found (not built this pipeline, or the build job doesn't exist yet — e.g. harness-worker, §F9)"
    continue
  fi

  echo "  COPY  ${svc}  ${source_ref} (${digest}) → ${image_repo}:${ENV_TAG}"
  docker buildx imagetools create --tag "${image_repo}:${ENV_TAG}" "${image_repo}@${digest}"

  PROMOTED="${PROMOTED} ${svc}=${digest}"
done

if [ -z "$PROMOTED" ]; then
  echo "No images were promoted (zero sha-${SHORT_SHA} tags found) — refusing to push an empty promotion." >&2
  exit 1
fi

# ── Pin the deployment repo overlay to the resolved digests ────────────────
# kustomize's `name:` for every service in this repo is `hope-v2/<svc>`
# (see deployment/k8s/overlays/*/kustomization.yaml `images:` blocks) —
# independent of CI_PROJECT_PATH, which is the *build-side* registry path.
KUSTOMIZE_IMAGE_PREFIX="hope-v2"
PUBLIC_REGISTRY_HOST="registry.taphuynh.dev"

DEPLOY_AUTH_URL=$(echo "$DEPLOY_REPO_URL" | sed \
  -e "s|https://|https://gitlab-ci-token:${DEPLOY_TOKEN}@|" \
  -e "s|http://|http://gitlab-ci-token:${DEPLOY_TOKEN}@|")

rm -rf /tmp/deploy
git clone --depth 1 "$DEPLOY_AUTH_URL" /tmp/deploy
cd "/tmp/deploy/${OVERLAY_PATH}"

for pair in $PROMOTED; do
  svc="${pair%%=*}"
  digest="${pair#*=}"
  kustomize edit set image \
    "${KUSTOMIZE_IMAGE_PREFIX}/${svc}=${PUBLIC_REGISTRY_HOST}/${CI_PROJECT_PATH}/${svc}@${digest}"
done

cd /tmp/deploy
if git diff --quiet; then
  echo "No changes to the overlay (digests unchanged) — nothing to push."
  exit 0
fi

git add -A
git commit \
  -m "promote(${DEPLOY_ENV}): ${ENV_TAG} from pipeline #${CI_PIPELINE_IID:-unknown}" \
  -m "Source: ${CI_PROJECT_URL:-unknown}/-/commit/${CI_COMMIT_SHA}" \
  -m "Pipeline: ${CI_PIPELINE_URL:-unknown}"
git push origin main
echo "Deployment repo updated (main). Argo CD Application hope-v2-${DEPLOY_ENV} will reconcile."
