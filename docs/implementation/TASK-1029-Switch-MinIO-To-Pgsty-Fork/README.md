# TASK-1029: Switch MinIO to the pgsty community fork (both repos) and pin/mirror the image

**Status:** Review — both lanes merged locally (hope-v2 `92e030d35`, deployment `526d1c7`); not pushed. The cluster rollout is forward-only and waits on the owner (backup first, see deployment `docs/deployment-runbook.md` §2).
**Type:** infrastructure
**Branch:** `dev-2.2` (hope-v2) · `main` (hope-v2-deployment)
**Related:** TASK-1024 / TASK-1025 (the MinIO policy work that surfaced the problem), `e166603` + `4929e2f` in hope-v2-deployment (the `minio/mc` stop-gap). TASK-1028 is reserved by another session ("Replace MinIO with Alarik", empty directory as of 2026-10-01), so this ticket is not TASK-1028.

## Requirement Analysis

Owner request (2026-10-01): open a ticket to switch to `pgsty/minio`, migrate both `hope-v2` and `hope-v2-deployment`, and update all documentation.

Our blob-store expectations, which the fork must keep meeting:
1. Full S3 compatibility.
2. The s3fs sidecar keeps working.
3. A console GUI for bucket management and access control.

### Why

Upstream MinIO Community Edition is dead:

| Date | Event |
|---|---|
| May 2025 | The community console is reduced to an object browser (admin features moved to paid AIStor). |
| Oct 2025 | Binaries and Docker images are no longer published. |
| 2025-12-03 | Maintenance mode. |
| 2026-04-25 | Repository archived. |

Our cluster runs `RELEASE.2025-04-22T22-12-26Z` (verified in `hope-minio-0`, 2026-10-01).
- **Console:** still the full one, because this release predates the reduction.
- **CVEs:** unpatched ones published since, including an OIDC JWT algorithm confusion flaw and a signature verification bypass; those fixes ship only in AIStor or the forks.
- **Images:** we can no longer pull them. The pinned `minio/mc` digest already fails ("repository does not exist"), and the local-dev compose pins both `minio/minio` and `minio/mc` by tag.

`pgsty/minio` (AGPL-3.0, <https://github.com/pgsty/minio>) is the only option that is a drop-in:
- the same on-disk format and admin API, so `mc admin`, `mc quota` and `minio-policy-sync` keep working;
- the full console restored;
- CVE backports;
- published images.

Its known risk is that it has a single maintainer and ships no new features. A trial of a real successor (SeaweedFS, RustFS) is a separate follow-up.

### Verified facts about the image (2026-10-01, `crane`)

| Item | Value |
|---|---|
| Release pinned | `pgsty/minio:RELEASE.2026-08-04T00-00-00Z` (newest tag; `latest` points to it) |
| OCI index digest | `sha256:b6bfe7239bfc83fb90d31612d9704d86039dd714f7904b3f1ad68f211e602372` (amd64 + arm64) |
| linux/amd64 manifest | `sha256:2b36182f3479c58b5cba920f20479738ee85ce218de0596a244f9a1368268db9` |
| Base / entrypoint | UBI9-micro. `/usr/bin/docker-entrypoint.sh`, default cmd `minio`, same semantics as upstream. |
| Bundled tools | `/usr/bin/minio`, **`/usr/bin/mc`**, `sh`, `bash`, `od`, `head`, `tr`, `sleep`, `curl`. This covers every `mc` script in the deployment repo, so one image replaces both `minio/minio` and `minio/mc`. |
| Separate client image | `pgsty/mc:RELEASE.2026-09-16T00-00-00Z` exists (`sha256:cfc83108…`), but is not needed. |

## Decisions (orchestrator defaults, taken to keep the migration moving; owner may override)

| # | Decision |
|---|---|
| D-1 | **One image for server and `mc` steps:** `pgsty/minio@sha256:b6bfe723…` (index digest, so it resolves per architecture). Tag comments name the release. No `minio/minio` or `minio/mc` reference is left anywhere, in either repo, outside history and docs that explain the switch. |
| D-2 | **Mirror into our registry, by CI:** a hope-v2 GitLab CI job copies the pinned index (`crane copy`, which keeps the digest) to `${CI_REGISTRY_IMAGE}/mirror/minio`. The local registry token is dead, so this cannot be done by hand. Whether the dev overlay pulls from the mirror or from Docker Hub is decided by the deployment lane after reading `promote.sh` (the `images:` transformer is CI-owned for hope images). Default: base pins the public digest, which is portable; the mirror is insurance, and the lane documents how to repoint. |
| D-3 | **Local dev and test compose** use the same pinned image for the server and for the bucket-init container (`mc` is inside). |
| D-4 | **No data migration:** the fork reads the existing data directory. The upgrade is forward-only (a newer MinIO rewrites metadata), so the cluster rollout needs a backup of the MinIO PVC or a recent `hope-backups` object copy first. That is an owner-run rollout step, not a lane task. |
| D-5 | **`minio` Python client (`minio>=7.2.20` in apps/stt):** out of scope. It is a pure S3 client and still works against the fork. The lane only reports whether upstream `minio-py` is archived. |

## Implementation Plan

Two lanes in parallel, in disjoint repositories. The orchestrator merges both, runs the gates and handles the rollout.

**Lane H — hope-v2** (worktree `../hope-v2-task-1029`, branch `task-1029-pgsty-minio`)
1. Local-dev and test infra:
   - `infrastructure/docker/docker-compose.yml`: replace `minio/minio` and `minio/mc`;
   - `tests/docker-compose.test.yml` and any other compose file or script that pulls a MinIO image.
2. The CI mirror job from D-2 in `.gitlab/ci/*.yml`: manual or scheduled, idempotent, uses `crane` or `skopeo`, and pins its own tool image by digest. It runs `pnpm`-free and never rebuilds.
3. Documentation: every doc that names the image, describes the console or states MinIO's licence or support status. That covers `infrastructure/README.md`, `docs/**` (excluding `docs/archive/**`), `.claude/rules/00-project-context.md` and `09-infrastructure-devops.md` (the "MinIO" data-plane lines), `.cursor/rules/*` where they mirror those rules, and `packages/applications/src/services/baseServices/storage/s3/*.md`.
4. Proof: `docker compose config` on each changed compose file; `validate_ci_lint` if available, otherwise YAML parse.

**Lane D — hope-v2-deployment** (worktree `../hope-v2-deployment-task-1029`, branch `task-1029-pgsty-minio`)
1. `deployment/k8s/base/minio.yaml`: image switched to the D-1 digest. Check that args, env, UID 1000, probes and the console port 9001 still hold for the fork.
2. Out-of-band manifests: every `mc` step (`minio-bootstrap.yaml`, `hope-models-publish.yaml`, `pgbackrest-bootstrap.yaml`, `minio-policy-sync.yaml`) moves to the same digest. Replace the `e166603` stop-gap comment with the TASK-1029 rationale.
3. D-2 overlay decision, then make CI hygiene gates (`image-hygiene` etc.) accept the pin.
4. Documentation: README, `docs/model-bucket-and-serving.md`, `docs/deploying-to-any-kubernetes.md`, `docs/aws-eks/*`, `docs/database-backup-restore.md`, and any runbook that names the image or the console. Add a rollout runbook section: back up, bump, verify console + `mc admin info` + s3fs sidecars + policy sync.
5. Proof: `kubectl kustomize deployment/k8s/overlays/dev` (and the other overlays) renders, YAML parse of `out-of-band/*`, `bash -n` on scripts, and `git grep` shows no remaining `minio/minio` or `minio/mc` pins.

**Orchestrator after merge:**
1. Merge each lane into its repo's active branch.
2. Run the gates.
3. Ask the owner before pushing: pushing the deployment repo makes Argo roll MinIO.
4. Rollout per the runbook (backup first), then verify:
   - the console is reachable with user/policy pages;
   - `mc admin info` works;
   - the s3fs sidecars in `stt`, `nlp`, `tts-v2`, `lmstudio` and `vllm` remount;
   - an app upload and a presigned GET work.

## Implementation Summary

### Orchestrator summary (2026-10-01)

**Pin change during implementation.** The fork was renamed: `github.com/pgsty/minio` now redirects to `pgsty/silo` ("SILO"). Docker Hub `pgsty/minio` is frozen at `RELEASE.2026-08-04`, and the `RELEASE.2026-09-16` security release (auth, policy and IAM revocation fixes) exists only as `pgsty/silo`. Both repos therefore pin **`pgsty/silo:RELEASE.2026-09-16T00-00-00Z@sha256:635197cb9f36d01bee221d34d1c7d7960f6a95c48b0b6c01d99cd13bdae51a46`** (OCI index, amd64 + arm64). This supersedes the `pgsty/minio` digest named in the plan above; D-1 to D-5 otherwise stand.

The server binary is `/usr/bin/silo` (there is no `minio` binary). The entrypoint maps `minio …` and `server …` to `silo …`, so any manifest that runs `minio` directly with `command:` must say `silo`. `MINIO_*` env vars, `/minio/health/*`, `/minio/v2/metrics` and `--console-address` are unchanged. `mc` is bundled.

**Live image check (orchestrator, local OrbStack, `silo` running as uid 1000 on a writable `/data`):**
- The banner reads `Version: RELEASE.2026-09-16T00-00-00Z`; `/minio/health/live` returns 200 and the console on `:9001` returns 200.
- `mc admin info` works.
- Bucket features: `mb --with-lock` (versioning enabled), `quota set 1GiB`, `ilm rule add --noncurrent-expire-days 30 --expire-delete-marker` and `retention info`.
- IAM: `admin user add`, `admin policy attach`, `admin user svcacct add`, then `svcacct edit --secret-key` (rotation).
- Objects: `cp` (PUT) and `share download` (presigned URL).

Every `mc` operation the deployment bootstrap, policy-sync and publish scripts use works against the pinned image. The image has no `grep`, `sed`, `awk` or `jq`, which the scripts already avoid.

**Lane H (hope-v2):** `9f7003564`, `6e50a90b2`, `211f43d65`, `0eb8ec24b`, `a988d28e8`, `08f43e8f5`. Details are in the Lane H subsection.

**Lane D (hope-v2-deployment):** `8d89f10`, `ad17f1f`, `481c92a`, `cc5b202`.
- Pins: `base/minio.yaml` plus every out-of-band `mc` step (`minio-bootstrap`, `minio-policy-sync`, `pgbackrest-bootstrap`, and the `hope-models-publish` probe and publish steps).
- D-2 mirror repoint: documented, not applied. The mirror is not populated yet, and an unresolvable ref on a single-replica StatefulSet would take the object store down.
- Rollout runbook: `docs/deployment-runbook.md` §2 (back up → deploy → verify → rollback caveat).
- Reversed decision: `docs/aws-eks/07` recorded an owner decision to FREEZE the MinIO image; it is now marked superseded by TASK-1029.

**Post-merge gates (orchestrator):**

| Repo | Gate | Result |
|---|---|---|
| hope-v2 | `docker compose config -q` on `infrastructure/docker/docker-compose.yml`, on it plus `docker-compose.dev.yml` with every profile, and on `tests/docker-compose.test.yml` | exit 0, exit 0, exit 0 |
| hope-v2 | CI YAML parse (`.gitlab-ci.yml`, `.gitlab/ci/mirror.yml`) | ok |
| hope-v2 | `sh -n .gitlab/ci/mirror-images.sh` | ok |
| hope-v2 | `py_compile apps/stt/tests/e2e/conftest.py` | ok |
| hope-v2 | `tsc --noEmit -p packages/applications` | ok |
| hope-v2 | any `image:` line naming `minio/minio` or `minio/mc` | none |
| deployment | `kubectl kustomize`: dev / staging / prod / standalone / `eks/overlays/aws-dev` / `eks/overlays/aws-prod` | 0 each; each renders only `pgsty/silo@sha256:635197cb…` |
| deployment | YAML parse of every `out-of-band/*.yaml` | ok |

**Owner rollout (not done; forward-only):**
1. **Back up first.** Take a cold PVC copy or a Proxmox snapshot of VM 200's MinIO data, or `mc mirror` the non-regenerable buckets to storage OUTSIDE this MinIO; `hope-backups` lives on the same server and does not count.
2. **Keep the rollback image cached.** Docker Hub now refuses anonymous pulls of `minio/minio` as well, so rollback is only possible while VM 200's image cache still holds the old digest. Do not prune it until the rollout is verified.
3. **Run the mirror (optional).** Play the hope-v2 `mirror-images` job to populate `registry.taphuynh.dev/arca/hope-v2/mirror/silo`. Repointing the dev overlay to the mirror (runbook §2) is best done in the same commit as the image bump, to avoid a second restart.
4. **Deploy.** Push `hope-v2-deployment` and Argo rolls MinIO.
5. **Verify** per runbook §2 (c):
   - the console's Users, Policies and Access Keys pages;
   - `mc admin info`;
   - a `minio-policy-sync` run;
   - the s3fs sidecars in `stt`, `stt-worker`, `nlp`, `tts-v2`, `lmstudio` and `vllm`;
   - an app upload plus a presigned GET;
   - fresh `minio_*` metrics.

**Follow-ups:**
- `minio-py` is not archived, but has had no release since 7.2.20 (2025-11-27); keep watching it.
- Trial a real successor (SeaweedFS or RustFS): the fork has a single maintainer.
- Deployment `README.md:99` wrongly says `components/data-tier` holds MinIO (it is Redis only).

_In progress._

### Lane H — hope-v2 (branch `task-1029-pgsty-minio`)

**Pin (re-pinned after the first pass).** The fork was renamed: `github.com/pgsty/minio` redirects to `github.com/pgsty/silo` ("SILO"), and Docker Hub `pgsty/minio` is frozen at `RELEASE.2026-08-04`. Lane H therefore pins `pgsty/silo:RELEASE.2026-09-16T00-00-00Z@sha256:635197cb…` (OCI index, amd64 + arm64), the 2026-09-16 security and correctness release. Verified facts (orchestrator, `crane`): the server binary is `/usr/bin/silo` (no `/usr/bin/minio`); `/usr/bin/mc`, `sh`, `bash`, `od`, `head`, `tr`, `sleep` and `curl` are present; the entrypoint rewrites `minio ...` / `server ...` / `-*` arguments to `silo ...`; `MINIO_*` env vars, `/minio/health/*`, `/minio/v2/metrics` and `--console-address` are unchanged. I also confirmed the amd64 binary still contains the legacy `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` names that testcontainers' `MinioContainer` sets.

**Images.** Every `minio/minio`, `minio/mc` and `pgsty/minio` image reference is now the pin above:
- `infrastructure/docker/docker-compose.yml`: `minio` and `minio-setup` (the init container overrides `entrypoint`, bypassing the image entrypoint, and uses `/usr/bin/mc`).
- `tests/docker-compose.test.yml`: `minio-test` and `minio-createbuckets`.
- `apps/stt/tests/e2e/conftest.py`: the testcontainers `MinioContainer`. Checked against testcontainers 4.15.0: it runs `server /data --address :9000` (through the entrypoint, so no override is needed) and waits on `/minio/health/live`.
- No compose file or script execs the `minio` binary directly; the healthchecks are `curl` against `/minio/health/live`, unchanged.
- Docs and snippets that pinned the old tag: `packages/applications/src/services/baseServices/storage/s3/{MINIO,SETUP}.md` (the Kubernetes example now calls `silo server`, since a `command:` bypasses the entrypoint), `examples/minio-example.ts`, `docs/research/configs/minio/docker-compose.yml`, `docs/research/deployments/deploy-vm402-minio.md`.
- `docker-compose.dev.yml` has no MinIO image, so it is unchanged.

**CI mirror (D-2).** Job `mirror-images` (`.gitlab/ci/mirror.yml`, included from `.gitlab-ci.yml`; logic in `.gitlab/ci/mirror-images.sh`; the list is `.gitlab/ci/mirror-images.list`, one line per image):
- Never runs on a plain push, tag or MR. It is `when: manual` (`allow_failure: true`) on `dev|staging|main|cicd` branch pipelines, or runs on a pipeline schedule that sets `MIRROR_IMAGES=true`. To run it: CI/CD, Pipelines, open the branch pipeline, play `mirror-images`.
- Copies to `$REGISTRY/$CI_PROJECT_PATH/mirror/silo:RELEASE.2026-09-16T00-00-00Z` with `crane copy` (digest preserved, verified after the copy), skips when the destination already has the digest, and refuses a list line without `@sha256:`.
- Tool image: `gcr.io/go-containerregistry/crane:debug@sha256:e78770b3…`. Auth: `crane auth login "$REGISTRY"` with `$CI_REGISTRY_USER` / `$CI_REGISTRY_PASSWORD`.
- The destination follows the repo convention (`$REGISTRY/$CI_PROJECT_PATH/…`, the LAN registry the build jobs push to), not the public `${CI_REGISTRY_IMAGE}` host. Same registry, different host name.
- Untested against the real registry: only `DRY_RUN=true` (source-digest check) was run locally, and the runner must be able to pull `gcr.io` and read Docker Hub.

**Docs.** SILO, why, the pinned release, the `silo` binary, the bundled `mc`, the restored console and the mirror job are stated in `.claude/rules/00-project-context.md` and `09-infrastructure-devops.md` (new "Object store image" section), their `.cursor/rules` mirrors, `README.md`, `infrastructure/README.md`, `infrastructure/docker/{README.md,minio/README.md}`, `docs/architecture/overview.md`, `docs/development-guide.md`, `docs/operations/testing/environment-setup.md`, `docs/operations/storage/minio-phi-backup.md` (release row annotated; the audit itself is dated evidence), `scripts/README.md`, `tests/README.md`. `docs/archive/**` untouched.

**Other finding (D-5).** Upstream `minio-py` is NOT archived (pushed 2026-09-28) but has had no release since 7.2.20 (2025-11-27). No dependency change was made.

## Change History

| Date | Change |
|---|---|
| 2026-10-01 | Ticket opened after the MinIO fitness research (upstream CE archived; `pgsty/minio` chosen as the drop-in bridge). Image facts verified with `crane`; lanes H and D planned. |
| 2026-10-01 | Lane H (hope-v2): all MinIO images moved to the pinned pgsty/minio digest; `mirror-images` CI job added; docs updated. Found that the fork repo was renamed to `pgsty/silo` and Docker Hub `pgsty/minio` is frozen at the pinned release. |
| 2026-10-01 | Lane H follow-up: re-pinned from `pgsty/minio` (frozen at 2026-08-04) to `pgsty/silo:RELEASE.2026-09-16T00-00-00Z@sha256:635197cb…`; mirror name is now `silo`; docs updated (binary is `silo`, `mc` bundled). |
| 2026-10-01 | Re-pinned to `pgsty/silo` RELEASE.2026-09-16 (fork renamed); lanes H and D merged locally (hope-v2 `92e030d35`, deployment `526d1c7`); live `mc` check against the pinned image; post-merge gates green; status Review, awaiting the owner's backup and rollout. |
