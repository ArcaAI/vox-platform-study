# TASK-1024: Model publisher uses the platform storage credential; `hope-models` joins `hope-platform-rw`

**Status:** Review — code + deployment-repo change done locally, not pushed; cluster re-run of `minio-bootstrap` pending
**Type:** refactor (+ one latent bugfix, see C-3)
**Branch:** `dev-2.2` (hope-v2) · `main` (hope-v2-deployment)
**Related:** TASK-1019 (introduced the dedicated publisher key pair, D-2 / C3), TASK-1023 (unregister / purge), TASK-847 (`hope-platform` identity), TASK-1025 (tenant bucket gaps, found while scoping this)

## Requirement Analysis

Owner request (2026-09-30): drop the dedicated `MODEL_STORE_PUBLISHER_ACCESS_KEY_ID` / `MODEL_STORE_PUBLISHER_SECRET_KEY` pair and let the model-publisher worker use the platform credential (`MINIO_*` / `S3_*`). On the cluster, add `hope-models` to the `hope-platform-rw` MinIO policy with full read / write / delete.

**Trade-off, accepted by the owner:** every workload that holds `MINIO_*` (hope-api, the Python services, the seed and publish jobs) can now overwrite or delete model weights. The remaining protection is the bucket's versioning, the 30-day non-current ILM rule and object lock.

## Current State Evaluation

| # | Finding |
|---|---|
| C-1 | `ModelStoreFactory` read the publisher pair from env only; if it was absent, the job failed with `MODEL_STORE_CREDENTIAL_MISSING`. `pnpm setup:dev` left the pair as `CHANGE_ME` (it was not classified in `generate-env-file.sh`), so local publish/unregister always failed. |
| C-2 | `hope-platform-rw` had no statement on `hope-models`. |
| C-3 | The retired `hope-models-publisher` policy had **no `s3:DeleteObject` / `DeleteObjectVersion`**, so TASK-1023 unregister/purge would have been refused on the cluster. The new grant includes both. |
| C-4 | No publisher Deployment exists in the deployment repo yet (the TASK-1019 rollout is pending). The only cluster consumer of the old Secret was the hand-run `out-of-band/hope-models-publish.yaml` Job. |

## Implementation Plan

1. TDD: rewrite the `ModelStoreFactory` tests to expect the platform credential. RED: 6 failing.
2. `ModelStoreFactory` resolves the key pair through `loadPlatformStorageCredentials` (now exported from `platform-storage-credential.ts`), which is the same order `BlobStorageProviderFactory` uses: the SYSTEM row `credentialsRef`, then the `S3_ACCESS_KEY` / `S3_SECRET_KEY` secrets. It still fails closed.
3. Remove the pair: settings descriptors, `READ_BY_MODEL_PUBLISHER_ONLY` (gateway env schema + `env-sync.mts`), tests, `turbo.json`, samples and `env-surface.generated.md` (via `pnpm env:sync`), and the `dev-service.sh` comment.
4. Deployment repo: add `hope-models` statements to `hope-platform-rw`, remove the `hope-models-publisher` policy/identity/mint/Secret write/RBAC name, point `hope-models-publish.yaml` at `hope-secrets` `MINIO_*`, update `bootstrap-cluster.sh` gates and docs.

## Implementation Summary

**hope-v2**
- `packages/applications/src/services/ai-model/publish/model-store.ts`: `SecretsService` injected; credential from the platform storage cascade.
- `packages/applications/src/services/ai-provider-connection/platform-storage-credential.ts`: `loadPlatformStorageCredentials` exported.
- `packages/applications/src/services/settings-registry/descriptors/bootstrap-env.descriptors.ts`: two descriptors removed.
- `apps/api/src/config/env.schema.ts`, `scripts/env-sync.mts`: `READ_BY_MODEL_PUBLISHER_ONLY` removed.
- Tests: `model-store.test.ts`, `fail-mode.governance.test.ts`, `env.schema.test.ts`.
- Generated: `.env.sample`, `apps/api/.env.sample`, `turbo.json`, `env-surface.generated.md`.
- `scripts/dev-service.sh`: comment.

**hope-v2-deployment**
- `deployment/k8s/out-of-band/minio-bootstrap.yaml`: `ModelsBucket` + `ModelsObjects` statements on `hope-platform-rw`; publisher policy, identity, credential, Secret write and RBAC name removed.
- `deployment/k8s/out-of-band/hope-models-publish.yaml`: reads `hope-secrets` `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY`.
- `scripts/bootstrap-cluster.sh`, `deployment/secrets.dev.yaml.example`, `docs/{model-bucket-and-serving,deploying-to-any-kubernetes,mlflow-database}.md`, `docs/aws-eks/{08-runbook,day-1-checklist}.md`.

**Migrations / API changes:** none. Two env vars retired.

### Rollout (cluster)

1. Merge and push the deployment repo change.
2. Re-run `out-of-band/minio-bootstrap.yaml` (`kubectl delete job hope-minio-bootstrap` first; the Job is immutable). This updates `hope-platform-rw` and **rotates** every key it mints, so roll the consumers it prints.
3. Optional cleanup: `mc admin user remove hope hope-models-publisher` and `kubectl delete secret hope-models-publisher`. The bootstrap deliberately does not delete them.

### Evidence

- RED: `model-store.test.ts` 6 failed / 13 passed before the implementation.
- GREEN:
  - `@arcaai/applications` ai-model + settings-registry + ai-provider-connection suites: 135 files, 1516 tests passed after the governance test update.
  - `apps/api` config + model-publisher: 3 files, 24 tests passed.
- `scripts/__tests__/env-sync.test.ts`: 53 passed / 1 failed. The failure is the bootstrap-floor ≤ 60 lines check (64 lines), which also fails without this change.
- The `@arcaai/applications` build is clean, and `apps/api` `tsc --noEmit` is clean.
- ESLint on the touched files: 0 errors; the 4 warnings are on untouched lines.
- Deployment repo:
  - `kubectl kustomize deployment/k8s/overlays/dev` renders.
  - All policy JSON in `minio-bootstrap.yaml` parses.
  - `bash -n scripts/bootstrap-cluster.sh` passes.

## Change History

| Date | Change |
|---|---|
| 2026-09-30 | Created and implemented (owner decision: platform principal carries `hope-models`; publisher pair retired). |
