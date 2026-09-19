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
# Optional env:
#   PROMOTE_ALLOW_STALE=true   — override the freshness guard below. Deliberate,
#                                human-set, per-run. See §FRESHNESS GUARD.
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

# Captured BEFORE any `cd`: the freshness guard answers an ancestry question
# about the SOURCE repo, so it must run git in this checkout, not in the
# deployment-repo clone under /tmp/deploy.
SOURCE_DIR="${CI_PROJECT_DIR:-$(pwd)}"

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

# ══════════════════════════════════════════════════════════════════════════════
# FRESHNESS GUARD — refuse to pin an image older than the one already pinned
# ══════════════════════════════════════════════════════════════════════════════
#
# WHY THIS EXISTS (TASK-990 D-12 / owner item O-4, closed 2026-09-19)
#
# This script used to write UNCONDITIONALLY. Whichever promotion finished LAST
# won, regardless of which commit it carried, and the push-retry loop at the
# bottom actively converted a losing race into a successful overwrite: on a
# rejected push it resets onto the new tip and REPLAYS ITS OWN (older) pins.
# "The edits are declarative, so replaying converges" — it converges, but on
# the older value.
#
# The failure is silent in every signal a human looks at. The overtaken
# pipeline goes green (it did everything it was asked to), the overtaking
# pipeline already went green, Argo reports Synced/Healthy because the
# manifests and the cluster agree — and the cluster is running a build behind
# the branch. `verify-dev` does NOT catch it: it polls for its OWN sha, so the
# job belonging to the stale promotion passes precisely because the stale
# promotion won.
#
# Three reachable paths, in descending order of how easy they are to hit:
#
#   1. JOB RETRY, unbounded in time. `promote-dev` on ANY past pipeline can be
#      retried from the UI or the API and will re-pin that pipeline's digests
#      over whatever is current. Nothing checked the age of the commit — and
#      this script's own "re-running this job is safe" message invited it.
#   2. CROSS-BRANCH. Every `dev-*` branch resolves to PIPELINE_TYPE == "dev"
#      and every one of them writes overlays/dev. `workflow:auto_cancel` is
#      per-ref, so dev-2.1 and dev-2.2 never cancel each other. Dormant today;
#      live the moment a dev-2.3 cutover overlaps.
#   3. CONCURRENT PIPELINES, narrow but real. `.promote-base` is
#      `interruptible: false`, and `auto_cancel: on_new_commit: interruptible`
#      by definition never cancels a job that has already STARTED. (A promote
#      that has NOT started IS cancelled with its pipeline — verified on
#      pipeline 1247, job 19971. So the window is the job's own runtime,
#      measured at 62 s on pipeline #914, not the whole build.)
#
# THE RULE: the deployment repo records which SOURCE COMMIT it was last
# promoted from. A promotion is allowed only when its own commit is that
# commit, or a descendant of it — i.e. a fast-forward in source lineage.
# Anything else (strictly older, or an unrelated lineage, or a stamp whose
# commit this repo no longer contains) is REFUSED with a non-zero exit, so the
# pipeline goes RED. A deploy that did not happen must never look green; that
# is the entire defect being fixed, and an `exit 0` with a warning would
# reproduce it.
#
# Ordering matters: the guard runs BEFORE the registry re-tag, so a refusal
# leaves the registry untouched as well as the manifests.
#
# WHAT IT DOES NOT COVER:
#   - It orders by SOURCE-COMMIT ancestry, not by wall clock or pipeline id.
#     Two commits on unrelated branches are incomparable, so the guard refuses
#     rather than guessing — that is deliberate (fail closed) but it means a
#     genuine branch switch needs PROMOTE_ALLOW_STALE once.
#   - It does not serialise anything by itself. `resource_group` on the
#     promote jobs (deploy.yml) does that; the guard is what makes the
#     serialised order SAFE rather than merely orderly.
#   - It cannot see a rollback that a human makes by hand-editing the overlay.
#     A hand edit leaves the stamp naming a commit the overlay no longer
#     pins, and the next promotion will fast-forward straight over it.
#   - It says nothing about whether Argo applied the result. That is
#     `verify-dev`'s job.
#
# ROLLBACK is a real need and stays possible: re-run with the pipeline
# variable PROMOTE_ALLOW_STALE=true. The override is logged at the top of the
# job and recorded in the deployment-repo commit message, so a deliberate
# rollback is distinguishable from an accident forever after.
#
# The stamp lives OUTSIDE deployment/k8s/overlays/ on purpose: it is not a
# manifest, kustomize must never walk it, and the deployment repo's
# `patch-hygiene` gate greps overlays/ recursively.
STATE_PATH="deployment/k8s/promotion-state/${DEPLOY_ENV}.state"

# Read one `key: value` line out of the stamp. The stamp comes from ANOTHER
# repository, so it is parsed, never sourced — this job holds DEPLOY_TOKEN and
# a `.` of attacker-influenced content would hand it over.
read_state_field() {
  sed -n "s/^${1}: *//p" "$2" 2>/dev/null | head -1 | tr -d '\r'
}

is_sha40() {
  [ -n "$1" ] || return 1
  case "$1" in *[!0-9a-f]*) return 1 ;; esac
  [ "${#1}" -eq 40 ]
}

# Exits non-zero (loudly) unless this promotion is a fast-forward of the one
# the deployment repo already records. CWD must be the deployment-repo clone.
assert_promotion_is_fresh() {
  if [ ! -f "$STATE_PATH" ]; then
    echo "── freshness guard: no ${STATE_PATH} yet — BOOTSTRAPPING ──"
    echo "   This environment has never recorded a promotion source. Accepting"
    echo "   this one and writing the stamp. Every later promotion is checked"
    echo "   against it. If you did not expect a bootstrap here, the stamp was"
    echo "   deleted — check the deployment repo's history before trusting this."
    return 0
  fi

  prev_sha="$(read_state_field sourceCommit "$STATE_PATH")"
  prev_ref="$(read_state_field sourceRef "$STATE_PATH")"
  prev_pipeline="$(read_state_field pipelineUrl "$STATE_PATH")"

  if ! is_sha40 "$prev_sha"; then
    guard_refuse "the recorded sourceCommit is not a 40-hex commit id" \
      "${STATE_PATH} contains sourceCommit: '${prev_sha}'." \
      "The stamp is corrupt or hand-edited. Fix it in the deployment repo."
    return 0   # only reached under PROMOTE_ALLOW_STALE; guard_refuse exits otherwise
  fi

  if [ "$prev_sha" = "$CI_COMMIT_SHA" ]; then
    echo "── freshness guard: OK — re-promoting the commit already recorded ──"
    echo "   ${prev_sha} (${prev_ref:-unknown ref})"
    return 0
  fi

  # Ancestry is a question about the SOURCE repo.
  if ! ( cd "$SOURCE_DIR" && git cat-file -e "${prev_sha}^{commit}" 2>/dev/null ); then
    guard_refuse "the recorded source commit is not in this checkout" \
      "${STATE_PATH} names ${prev_sha}, which ${CI_PROJECT_PATH} does not contain here." \
      "Either the branch was rewritten (force-push) and that commit is gone, or the clone is too shallow — .promote-base sets GIT_DEPTH: 0 for exactly this reason."
    return 0   # only reached under PROMOTE_ALLOW_STALE
  fi

  if ( cd "$SOURCE_DIR" && git merge-base --is-ancestor "$prev_sha" "$CI_COMMIT_SHA" ); then
    echo "── freshness guard: OK — this commit is a descendant of the pinned one ──"
    echo "   pinned:  ${prev_sha} (${prev_ref:-unknown ref})"
    echo "   this:    ${CI_COMMIT_SHA} (${CI_COMMIT_REF_NAME:-unknown ref})"
    return 0
  fi

  if ( cd "$SOURCE_DIR" && git merge-base --is-ancestor "$CI_COMMIT_SHA" "$prev_sha" ); then
    behind="$( cd "$SOURCE_DIR" && git rev-list --count "${CI_COMMIT_SHA}..${prev_sha}" 2>/dev/null || echo '?' )"
    guard_refuse "this commit is OLDER than what ${DEPLOY_ENV} already runs" \
      "${CI_COMMIT_SHA} is an ancestor of the pinned ${prev_sha} — ${behind} commit(s) behind." \
      "Promoting would roll ${DEPLOY_ENV} BACKWARDS while this pipeline reported success. This is usually a retried job from an older pipeline (${prev_pipeline:-the current pin} is newer)."
    return 0   # only reached under PROMOTE_ALLOW_STALE
  fi

  guard_refuse "this commit and the pinned one are on unrelated lineages" \
    "Neither ${CI_COMMIT_SHA} nor the pinned ${prev_sha} (${prev_ref:-unknown ref}) is an ancestor of the other." \
    "Two different branches are promoting into the same overlay — every dev-* branch resolves to PIPELINE_TYPE=dev and writes overlays/dev. Decide which branch owns ${DEPLOY_ENV} before promoting."
}

# One shape for every refusal, so the trace is greppable and the remedy is
# never missing. Exits 1.
guard_refuse() {
  if [ "${PROMOTE_ALLOW_STALE:-}" = "true" ]; then
    echo ""
    echo "################################################################################"
    echo "##  PROMOTION FRESHNESS GUARD OVERRIDDEN  (PROMOTE_ALLOW_STALE=true)"
    echo "##  Would have refused: $1"
    echo "##  $2"
    echo "##  Proceeding anyway because a human set PROMOTE_ALLOW_STALE on this run."
    echo "################################################################################"
    echo ""
    GUARD_OVERRIDDEN="yes"
    return 0
  fi

  echo "" >&2
  echo "################################################################################" >&2
  echo "##" >&2
  echo "##  PROMOTION REFUSED — $1" >&2
  echo "##" >&2
  echo "##  Environment:     ${DEPLOY_ENV}  (${OVERLAY_PATH})" >&2
  echo "##  This pipeline:   ${CI_PIPELINE_URL:-unknown}" >&2
  echo "##  This commit:     ${CI_COMMIT_SHA}  (${CI_COMMIT_REF_NAME:-unknown ref})" >&2
  echo "##  Already pinned:  see ${STATE_PATH} in ${DEPLOY_REPO_URL}" >&2
  echo "##" >&2
  echo "##  $2" >&2
  echo "##" >&2
  echo "##  $3" >&2
  echo "##" >&2
  # Be exact about the blast radius. The guard normally runs before anything is
  # touched; on the push-retry path it runs AFTER the registry re-tag, and
  # claiming "nothing changed" there would be the same false reassurance this
  # guard exists to remove.
  if [ "${IMAGES_RETAGGED:-no}" = "yes" ]; then
    echo "##  NO MANIFEST WAS PINNED and nothing was pushed to the deployment repo," >&2
    echo "##  so ${DEPLOY_ENV} still runs what it ran before. The registry tag" >&2
    echo "##  ${ENV_TAG} WAS already moved onto this commit's images before the" >&2
    echo "##  race was detected. For dev/staging that tag is sha-specific and" >&2
    echo "##  unreferenced, so it is inert; for prod it is the release tag and" >&2
    echo "##  you should check where it points before retrying." >&2
  else
    echo "##  NOTHING WAS CHANGED. No image was re-tagged, no manifest was pinned," >&2
    echo "##  nothing was pushed to the deployment repo. ${DEPLOY_ENV} is untouched." >&2
  fi
  echo "##" >&2
  echo "##  To proceed anyway — e.g. a DELIBERATE rollback — re-run this job with" >&2
  echo "##  the pipeline variable:  PROMOTE_ALLOW_STALE=true" >&2
  echo "##  (CI/CD → Run pipeline → Variables, or 'Run job again' with a variable.)" >&2
  echo "##  The override is recorded in the deployment-repo commit message." >&2
  echo "##" >&2
  echo "##  Why this guard exists: .gitlab/ci/promote.sh §FRESHNESS GUARD" >&2
  echo "##                         docs/implementation/TASK-990-*/README.md D-12" >&2
  echo "################################################################################" >&2
  echo "" >&2
  exit 1
}

GUARD_OVERRIDDEN="no"
# Set once the imagetools re-tag loop has run, so a refusal on the push-retry
# path can describe the blast radius honestly (see guard_refuse).
IMAGES_RETAGGED="no"

# ── Clone the deployment repo FIRST, so the guard can refuse for free ──────
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

rm -rf /tmp/deploy
# `--branch main` states the dependency instead of inheriting it: the push
# target below is hardcoded to main (the branch Argo CD tracks), so relying on
# the remote's default-branch setting to land us there is a silent coupling.
git clone --depth 1 --branch main "$DEPLOY_AUTH_URL" /tmp/deploy
cd /tmp/deploy

assert_promotion_is_fresh

# ── Re-tag the already-built images (zero rebuild) ─────────────────────────
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
SERVICES="api lmstudio stt-ml-runtime stt-worker text guardrail harness harness-worker nlp tts admin-console database qdrant-init"

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
IMAGES_RETAGGED="yes"

# ── Pin the deployment repo overlay to the resolved digests ────────────────
# kustomize's `name:` for every service in this repo is `hope-v2/<svc>`
# (see deployment/k8s/overlays/*/kustomization.yaml `images:` blocks) —
# independent of CI_PROJECT_PATH, which is the *build-side* registry path.
KUSTOMIZE_IMAGE_PREFIX="hope-v2"
PUBLIC_REGISTRY_HOST="registry.taphuynh.dev"

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

# Written in the SAME commit as the pins, so the stamp and the digests can
# never disagree about which source commit this overlay came from.
write_promotion_state() {
  mkdir -p "$(dirname "/tmp/deploy/${STATE_PATH}")"
  cat > "/tmp/deploy/${STATE_PATH}" <<EOF
# Which source commit ${DEPLOY_ENV} was last promoted from.
#
# Written by arca/hope-v2 .gitlab/ci/promote.sh, in the same commit as the
# digest pins. Read by the NEXT promotion, which refuses unless its own commit
# is this one or a descendant of it (§FRESHNESS GUARD in that script).
#
# Parsed with sed, never sourced. Do not hand-edit except to recover from a
# rewritten source branch — and say so in the commit message if you do.
sourceProject: ${CI_PROJECT_PATH}
sourceRef: ${CI_COMMIT_REF_NAME:-unknown}
sourceCommit: ${CI_COMMIT_SHA}
envTag: ${ENV_TAG}
pipelineIid: ${CI_PIPELINE_IID:-unknown}
pipelineUrl: ${CI_PIPELINE_URL:-unknown}
promotedAt: $(date -u +%Y-%m-%dT%H:%M:%SZ)
staleOverride: ${GUARD_OVERRIDDEN}
EOF
}

# The promote-* jobs are serialised per environment by `resource_group`
# (deploy.yml), but `main` can still move between the clone and the push —
# a human commit, or the deployment repo's own automation. Failing there is
# the worst possible moment: the registry re-tag above has ALREADY happened,
# so the job would leave the images promoted and the manifests unpinned.
# Instead, reset onto the new tip and replay the pins — the edits are
# declarative, so replaying converges.
#
# The freshness guard is RE-RUN after every reset. Replaying pins onto a tip
# that someone else advanced is exactly the move that used to turn a lost race
# into a silent rollback; re-checking makes the replay safe instead of merely
# convergent.
MAX_PUSH_ATTEMPTS=5
attempt=1
while :; do
  apply_image_pins

  # `git status --porcelain` rather than `git diff --quiet`: the latter is
  # blind to untracked files, and a newly added overlay entry would read as
  # "nothing to push".
  #
  # The stamp is written AFTER this test, not before: it carries a timestamp,
  # so writing it first would make the tree dirty on every run and turn a
  # genuine no-op re-promotion into an empty commit + an Argo poll. The
  # short-circuit therefore requires BOTH that the pins are unchanged and that
  # the stamp already names this commit — a fast-forward whose images happen
  # to resolve to identical digests still advances the stamp, which is what
  # keeps the lineage record precise.
  if [ -z "$(git status --porcelain)" ] \
     && [ "$(read_state_field sourceCommit "$STATE_PATH")" = "$CI_COMMIT_SHA" ]; then
    echo "No changes to the overlay (already pinned to these digests) and the promotion stamp already records ${CI_COMMIT_SHA} — nothing to push."
    exit 0
  fi

  write_promotion_state
  git add -A
  if [ "$GUARD_OVERRIDDEN" = "yes" ]; then
    git commit \
      -m "promote(${DEPLOY_ENV}): ${ENV_TAG} from pipeline #${CI_PIPELINE_IID:-unknown} [STALE OVERRIDE]" \
      -m "Freshness guard overridden with PROMOTE_ALLOW_STALE=true." \
      -m "Source: ${CI_PROJECT_URL:-unknown}/-/commit/${CI_COMMIT_SHA}" \
      -m "Pipeline: ${CI_PIPELINE_URL:-unknown}"
  else
    git commit \
      -m "promote(${DEPLOY_ENV}): ${ENV_TAG} from pipeline #${CI_PIPELINE_IID:-unknown}" \
      -m "Source: ${CI_PROJECT_URL:-unknown}/-/commit/${CI_COMMIT_SHA}" \
      -m "Pipeline: ${CI_PIPELINE_URL:-unknown}"
  fi

  if git push origin HEAD:main; then
    echo "Deployment repo updated (main). Argo CD Application hope-v2-${DEPLOY_ENV} will reconcile."
    exit 0
  fi

  if [ "$attempt" -ge "$MAX_PUSH_ATTEMPTS" ]; then
    echo "Push to main rejected ${MAX_PUSH_ATTEMPTS} times — giving up. The registry tags for ${ENV_TAG} ARE already promoted; only the manifest pin is missing, so re-running this job is safe PROVIDED the freshness guard still passes (it re-checks on every run — a newer promotion having landed meanwhile is exactly when re-running is NOT safe, and it will refuse)." >&2
    exit 1
  fi

  echo "  push rejected — main moved since the clone; re-checking freshness and re-applying pins onto the new tip (attempt ${attempt}/${MAX_PUSH_ATTEMPTS})"
  git fetch --depth 1 origin main
  git reset --hard FETCH_HEAD
  assert_promotion_is_fresh
  attempt=$((attempt + 1))
  sleep 3
done
