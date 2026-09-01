#!/bin/sh
# ══════════════════════════════════════════════════════════════════════════════
# Digest promotion (component-design-cicd-promotion.md).
#
# Copies each service's already-built `sha-<sha8>` image to an environment
# tag with ZERO rebuild (docker buildx imagetools create), then pins the
# hope-v2-deployment overlay to the resolved sha256 digest and pushes to
# `main` (the branch Argo CD actually reads).
#
# Replaces:
#   - the Argo CD Image Updater (wrong tag regex, wrong write-back
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
# it — see the tag_release / promote-prod workflow). If no such tag exists, `imagetools inspect` fails cleanly
# instead of silently rebuilding.
#
# Prod is promotion-only — this script's
# existing CI_COMMIT_SHA-keyed digest resolution (above) is exactly the
# mechanism that invariant depends on:
#   - A `v*` promote-prod pipeline BUILDS NOTHING (`.build-common-rules` in
#     build.yml has no clause matching `PIPELINE_TYPE == "tag_release"`), so
#     there is no tag-derived release identity to key on in that pipeline —
#     only CI_COMMIT_SHA, which is what SOURCE_TAG is built from below.
#   - The ServiceRelease row for that commit was created earlier by the
#     dev-*/staging-* pipeline that actually built `sha-<sha8>` (via the
#     self-registration path) and is looked up by
#     (serviceName, gitCommitSha, releaseTag) — the SAME key this script's
#     SOURCE_TAG is derived from.
#   - This script has ZERO database access and creates NO release row for any
#     environment — it only re-tags an already-pushed digest and pins the
#     deployment overlay. Digest attachment to the release row happens
#     through the internal service-release API once it exists,
#     keyed the same way. Promoting twice is therefore idempotent by
#     construction: same CI_COMMIT_SHA in, same digest out, no second row.
# ══════════════════════════════════════════════════════════════════════════════
set -eu

: "${DEPLOY_ENV:?DEPLOY_ENV is required (dev|staging|prod)}"
: "${OVERLAY_PATH:?OVERLAY_PATH is required}"
: "${REGISTRY:?REGISTRY is required}"
: "${CI_PROJECT_PATH:?CI_PROJECT_PATH is required}"
: "${CI_COMMIT_SHA:?CI_COMMIT_SHA is required}"
: "${DEPLOY_REPO_URL:?DEPLOY_REPO_URL is required}"
: "${DEPLOY_TOKEN:?DEPLOY_TOKEN is required — a masked CI variable holding a token with write_repository on the deployment repo, or Vault deploy/DEPLOY_TOKEN once VAULT_ADDR is set (see vault.yml)}"

# The username half of the HTTPS basic-auth pair. GitLab accepts ANY non-empty
# username alongside a personal or project access token, which is why the
# `gitlab-ci-token` default works for those. A DEPLOY TOKEN is different: its
# username is assigned by GitLab at creation and the pair is rejected if it
# doesn't match. Override this variable in that case rather than editing here.
DEPLOY_TOKEN_USERNAME="${DEPLOY_TOKEN_USERNAME:-gitlab-ci-token}"

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

# The canonical 11-service list, plus the two job images: `database`
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
SERVICES="api lmstudio stt-ml-runtime stt-worker text guardrail harness harness-worker nlp tts admin-console compat-playground database qdrant-init"

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

# Injecting the credential by shell expansion rather than `sed`: a token is
# opaque bytes, and sed would treat `&`, `|` or `\` inside it as replacement
# metacharacters — silently producing a MANGLED password and a 401 that looks
# like "wrong token" rather than "wrong parsing". The `case` also names the
# scheme assumption out loud: an ssh:// URL used to pass through the sed
# unchanged and then fail at `git clone` with an error about keys, not config.
case "$DEPLOY_REPO_URL" in
  https://*) DEPLOY_AUTH_URL="https://${DEPLOY_TOKEN_USERNAME}:${DEPLOY_TOKEN}@${DEPLOY_REPO_URL#https://}" ;;
  http://*)  DEPLOY_AUTH_URL="http://${DEPLOY_TOKEN_USERNAME}:${DEPLOY_TOKEN}@${DEPLOY_REPO_URL#http://}" ;;
  *)
    echo "DEPLOY_REPO_URL must be an http(s) URL (token auth is HTTPS basic-auth): $DEPLOY_REPO_URL" >&2
    exit 1
    ;;
esac

# Re-applying the pins is a pure function of $PROMOTED, so it can be replayed
# on a moved tip — that is what makes the push retry below safe.
apply_image_pins() {
  cd "/tmp/deploy/${OVERLAY_PATH}"
  for pair in $PROMOTED; do
    svc="${pair%%=*}"
    digest="${pair#*=}"
    kustomize edit set image \
      "${KUSTOMIZE_IMAGE_PREFIX}/${svc}=${PUBLIC_REGISTRY_HOST}/${CI_PROJECT_PATH}/${svc}@${digest}"
  done
  cd /tmp/deploy
}

rm -rf /tmp/deploy
# `--branch main` states the dependency instead of inheriting it: the push
# target below is hardcoded to main (the branch Argo CD tracks), so relying on
# the remote's default-branch setting to land us there is a silent coupling.
git clone --depth 1 --branch main "$DEPLOY_AUTH_URL" /tmp/deploy
cd /tmp/deploy

# The promote-* jobs are not serialized against each other, against a human
# commit, or against the deployment repo's own automation, so `main` can move
# between the clone and the push. Failing there is the worst possible moment:
# the registry re-tag above has ALREADY happened, so the job would leave the
# images promoted and the manifests unpinned. Instead, reset onto the new tip
# and replay the pins — the edits are declarative, so replaying converges.
MAX_PUSH_ATTEMPTS=5
attempt=1
while :; do
  apply_image_pins

  # `git status --porcelain` rather than `git diff --quiet`: the latter is
  # blind to untracked files, and a newly added overlay entry would read as
  # "nothing to push".
  if [ -z "$(git status --porcelain)" ]; then
    echo "No changes to the overlay (already pinned to these digests) — nothing to push."
    exit 0
  fi

  git add -A
  git commit \
    -m "promote(${DEPLOY_ENV}): ${ENV_TAG} from pipeline #${CI_PIPELINE_IID:-unknown}" \
    -m "Source: ${CI_PROJECT_URL:-unknown}/-/commit/${CI_COMMIT_SHA}" \
    -m "Pipeline: ${CI_PIPELINE_URL:-unknown}"

  if git push origin HEAD:main; then
    echo "Deployment repo updated (main). Argo CD Application hope-v2-${DEPLOY_ENV} will reconcile."
    exit 0
  fi

  if [ "$attempt" -ge "$MAX_PUSH_ATTEMPTS" ]; then
    echo "Push to main rejected ${MAX_PUSH_ATTEMPTS} times — giving up. The registry tags for ${ENV_TAG} ARE already promoted; only the manifest pin is missing, so re-running this job is safe." >&2
    exit 1
  fi

  echo "  push rejected — main moved since the clone; re-applying pins onto the new tip (attempt ${attempt}/${MAX_PUSH_ATTEMPTS})"
  git fetch --depth 1 origin main
  git reset --hard FETCH_HEAD
  attempt=$((attempt + 1))
  sleep 3
done
