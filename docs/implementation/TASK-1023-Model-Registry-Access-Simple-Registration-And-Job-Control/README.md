# TASK-1023: Model registry — tenant read-only access + management toggle, three-source simple registration, download-job control

**Status:** Review — merged into `dev-2.2` and live-proven on the local stack; deployment branch (models-mount CI check) not pushed
**Type:** feature (+ one latent bugfix, see §Current State C-7)
**Branch:** `dev-2.2` (lanes in worktrees off `dev-2.2`, merged by the orchestrator)
**Base commit at planning:** `9da0206aa`
**Related:** TASK-1019 (registry HF publish / unregister / lifecycle — this ticket builds on it), TASK-1021 (vLLM serving facts `vramGiB`), TASK-932 (Feature Availability matrix), TASK-934/994 (ASR profile precedence), TASK-960 (bucket-relative prefix), TASK-890 (derived `localPath`, inventory)

## Requirement Analysis

Owner request (2026-09-30):

| # | Requirement |
|---|---|
| R1 | Only a **platform admin** manages the registry (incl. registering). A **tenant admin** sees the registered models **read-only**. |
| R2 | An **on/off configuration** lets a platform admin allow (or disallow) tenant admins to manage registered models "in the future". |
| R3 | The HF access token is platform-admin-managed **now**; if tenant management is enabled it must be **tenant-scoped**. |
| R4 | A **simple registration form** with three sources: (a) **Hugging Face** — admin gives only the repo id; (b) **internal MLflow** — shown, marked "not available yet"; (c) **local path** on the model-bucket mount, picked from storage management, with **one mount path across services/apps**. |
| R5 | **No hyperparameter inputs at registration.** Defaults exist; runtime hyperparameters are managed on tenant **Agents and workflows**. Best-practice recommendation required. |
| R6 | Admins **manage download jobs**; **cancelling/destroying a job updates the status** shown in the registry view. |

"Platform admin" = `SUPER_ADMIN` with no working tenant (`lifecycle/platform-admin.ts:14-25`), as in TASK-1019.

## Current State Evaluation (review 2026-09-30, three read-only discovery agents; key claims re-verified by hand)

| # | Area | Today | Gap vs requirement |
|---|---|---|---|
| C-1 | Write access (R1) | Every `admin/ai-models/**` route: class `@Authorize(['manage','all'])` (`ai-model-admin.controller.ts:55`) + imperative gate — `assertPlatformRegistryAdmin` (super admin, **no** working tenant) on operations/download/inventory, but `AiModelService.assertPlatformAdmin` (`aiModel.service.ts:1094`) checks super admin **only**. | Two different gates for one resource; the toggle (R2) has no seam to plug into. |
| C-2 | Tenant read (R1) | Tenant admin reaches only `GET admin/ai-models/catalogue` (`read:AiModel`; readiness/usable, **no** lifecycle/availability/size). Console `/ai-models` lives in `(global)` → 404 for tenant admins. The lifecycle join reads the residency catalogue, which is itself platform-gated (`model-residency.service.ts:845`). | No read-only registry view for tenant admins at all. |
| C-3 | Toggle (R2) | Feature Availability descriptors (`feature-availability.descriptors.ts:118-259`) give `global-kv`, `globalOnly`, per-tenant override via `maxScope:'tenant'`, super-admin-only matrix writes. Server-enforced precedent: `workflowExposure.enabled`. | No `modelRegistry.*` management key. |
| C-4 | HF token (R3) | SYSTEM `AiProviderConnection('model-registry','huggingface')`; `CLOUD_BYO_PROVIDERS['model-registry'] = []` (`ai-provider-connection/constants.ts:116`); HF client pins `resolveCredential(..., SYSTEM_TENANT_ID)` (`huggingface-model-source.client.ts:223`). | Correct for "platform-only now"; not tenant-capable. |
| C-5 | Registration UX (R4, R5) | Two forms. `ModelFormSheet` (1 020 lines): **26 inputs always, 39 with the ASR profile** (13 decode knobs). `RegisterFromHubSheet`: repo id + revision, then 6 more editable inputs after preview. Source enum offers `HUGGINGFACE/GITHUB/MLFLOW/LOCAL/S3` with no MLflow handling anywhere. | Too many inputs; MLflow is a dead option; GITHUB/S3 are noise. |
| C-6 | Local path (R4c) | Supported only as `POST admin/ai-models` with `source=LOCAL` + `bucketPrefix` (+ `primaryObject` for single-file libraries); inventory's "In bucket, not registered" drawer pre-fills it. `localPath` is derived (`constants.ts:166`, `HOPE_MODELS_MOUNT = '/mnt/models-bucket'`), never stored. A **pasted mount path passes the validator** and derives `/mnt/models-bucket/mnt/models-bucket/…` (`BucketRelativePrefixConstraint` rejects only `s3://` and a leading `hope-models/`). | No path picker; no normaliser; mount root duplicated in the console (`model-meta.ts:213`). |
| C-7 | One mount path (R4c) | Gateway sends an absolute `localPath`; stt, stt-worker, nlp, tts-v2, vllm-pool, lmstudio all mount the s3fs sidecar at `/mnt/models-bucket` (deployment repo). **But** nlp/tts pass `HF_HOME` (`/mnt/models-bucket/hf`) straight into `snapshot_download(cache_dir=…)` (`nlp/models/source_resolver.py:135-140,369`), while the publisher writes `hf/hub/models--*` — the hub-id fallback path misses the cache (stt avoids it with `HUGGINGFACE_CACHE_DIR=…/hf/hub`). *Plausible from reading; not yet executed.* Harness/text/guardrail do not mount the bucket (harness MiniCheck falls through to `sourceUri`). | Latent layout bug; no check that every manifest keeps the same mountPath. |
| C-8 | Hyperparameters (R5) | Registration DTO (`register-from-hub`) already carries none. The **console** puts the ASR decode profile (13 fields) plus compute type/memory/architecture on the model form. `_metadata.serving` holds vLLM engine facts (`vramGiB` **required** — else `SERVING_FACTS_MISSING`, `build-resolved-serving-spec.ts:31-56`) and the LM Studio load profile. Runtime generation params already live on `Agent.parameters.generation` + workflow `core.agent` `overrides.generation`; ASR precedence is agent → model profile → engine default. | The UI asks for knobs that are not registration facts; a freshly registered vLLM model is unservable until someone PATCHes `vramGiB`. |
| C-9 | Job control (R6) | BullMQ `DownloadAiModel`, concurrency 1, consumed by the model-publisher worker; state in `_metadata.download` / `_metadata.unregister`. **No cancel/abort/remove anywhere**; the only abort is the HF byte-idle watchdog. A removed download job derives `DOWNLOAD_FAILED/STALLED` after the stale window; a removed **unregister** job leaves the row `UNREGISTERING` forever (no stale rule). `jobId` is returned by three routes but never shown. | Everything. |
| C-10 | Tests | No API e2e for hub/preview, register-from-hub, unregister, download-missing. Console `tests/e2e/ai-models.spec.ts` is **stale** vs TASK-1019 (clicks "Retire", fills a Radix Select as text). | Rewrite with this ticket. |

## Best-practice recommendation — hyperparameters (R5)

Registration records **what the model is**, never **how to run it**. Four layers, each owned by one surface:

| Layer | What | Owner / surface | Set when |
|---|---|---|---|
| 1. Identity & provenance | source, repo id / path, **pinned commit sha**, checksum, bucket prefix, license, gated | Registry (platform admin) | Registration — **auto-derived**, immutable afterwards |
| 2. Classification | task, library, format, served-by, architecture, dtype/compute type | Registry | Registration — **auto-derived** from the Hub card / `config.json` / file extensions; admin sees a read-only summary with one "Override" disclosure for the rare ambiguous repo |
| 3. Engine sizing (serving facts) | `vramGiB`, `maxNumSeqs`, `enforceEager`, LM Studio load profile | Platform (not tenants) | **Auto-derived default at download/registration** (weights bytes × overhead), editable later on the model's *Serving* tab |
| 4. Behaviour (hyperparameters) | temperature, top-p, max tokens, beam size, decode thresholds, windows, hotwords, prompts | **Tenant Agent** `parameters` → **workflow node** `overrides` | Runtime. Precedence: workflow override → agent version → model default profile → engine default |

Rules that follow:
- A model's **default profile** (today `_metadata.asr`, and HF's own `generation_config.json` where present) is a *fallback*, not a form. It is imported automatically when available and edited only under an "Advanced defaults" section of the edit drawer (platform admin), never at registration.
- Pin the **commit sha**, never a moving branch, so a registered model is reproducible; "revision" is an advanced option, default = latest `main` resolved to its sha.
- Derive, don't ask: every field a machine can read from the artifact is read from the artifact. An input remains only when the artifact is genuinely ambiguous — and then it is one override, not a form.
- Hyperparameters are **versioned where they are used** (agent versions, workflow versions), so a tuning change is auditable and rollback-able per tenant without touching the shared registry row.

## Proposed design

### D-A Access: one policy seam + tenant read-only view (R1, R2)

- **One write gate:** every registry write goes through `assertPlatformRegistryAdmin` (SUPER_ADMIN, no working tenant). `AiModelService.assertPlatformAdmin` (super admin only, no tenantless check) is folded into it, so create/update/delete/platform-default get the same gate as the operations. Write routes keep `@Authorize(['manage','all'])` (only SUPER_ADMIN holds it) — with management disabled for all tenants (OD-1) the guard and the service agree.
- Toggle `modelRegistry.tenantManagement.enabled` — a Feature Availability descriptor (`global-kv`, boolean, **default false**, `globalOnly` write, `maxScope:'tenant'`). Read by `ModelRegistryAccessService` and surfaced in `GET admin/ai-models/access`; it **grants no write in this ticket** (OD-1) — the seam FU-1 flips.
- Read routes (`GET list`, `GET :id`, `GET slug/:slug`, `GET access`) move to `@Authorize(['read','AiModel'])` + `@RequiredSvcScopes('svc:admin:ai-model:read','svc:admin:ai-model:manage')` (the catalogue's shape); a platform admin gets the full row, anyone else the redacted row.
- Tenant read response is **redacted**: status word, task, library, format, served-by, license, gated, size, languages, updated. **Not** returned to a tenant: per-service residency detail (device/bytes/requests), `usage` referrers (cross-tenant), job errors, bucket prefix. The lifecycle join reads residency through a new ungated internal method (status only), never through the platform-gated catalogue route.
- Console: `/ai-models` moves `(global)` → `(shared)` (tier 20-29, `read:AiModel`); write controls render only when the effective policy says `canManage` (from a small `GET admin/ai-models/access` → `{ canManage, tenantManagementEnabled }`). Retired `(global)` path keeps a `redirect()` for one release.

### D-B Three-source registration (R4)

One **Register model** sheet, source chosen by tabs:

| Tab | Admin enters | Server does |
|---|---|---|
| **Hugging Face** | Repo id (e.g. `openai/whisper-large-v3`). "Advanced" (collapsed): revision, name, slug, served-by override | `hub/preview` (existing) → read-only summary card (task, library, format, served-by, size, license, gated, pinned sha) → `register-from-hub` with `{repoId}` only; name/slug from the preview. 422 `HF_TOKEN_REQUIRED` links to AI providers. |
| **MLflow** | nothing — tab visible, disabled, text "Registering from the internal MLflow registry is not available yet." | — |
| **Local path** | Pick a folder/file in the model bucket (shared `BucketPathPicker` over `storage/buckets/hope-models/files?prefix=`, with the inventory's "in bucket, not registered" prefixes as suggestions); shows the path as `/mnt/models-bucket/<prefix>` | New `GET admin/ai-models/local/preview?path=` normalises (strips a leading `/mnt/models-bucket/`, `hope-models/`, `s3://hope-models/`), lists the prefix, reads `config.json` / `generation_config.json` / `manifest.json` / extensions / HF snapshot sha → the same summary card; new `POST admin/ai-models/register-from-path` creates `source=LOCAL` with derived `bucketPrefix`/`primaryObject`/classification. |

- The old 26-field `ModelFormSheet` becomes the **edit** drawer only, reduced to: name, description, tags, enabled, platform-default (editable); identity/classification (read-only); *Serving* tab (engine facts, platform admin); *Advanced defaults* tab (collapsed ASR/generation default profile, platform admin). `GITHUB`/`S3` disappear from the console source list (enum untouched — seeds use them).
- **Mount path, one declaration:** `HOPE_MODELS_MOUNT` / `HOPE_MODELS_BUCKET` move to `@arcaai/types` (consumed by gateway + console; console duplicate deleted), mirrored by a parity fixture in `tests/contracts/`; a deployment-repo CI check asserts every `models-bucket` volumeMount uses that path.
- **Serving facts default:** on download completion (and on `register-from-path`) the gateway writes `_metadata.serving.vramGiB` when absent, derived from measured weight bytes (formula in the lane brief, D-5 below), so a new vLLM-served model is servable without a manual PATCH.

### D-C Download-job control (R6)

- New publish status **`CANCELLED`** (`_metadata.download.cancelledAt/cancelledBy`, `error.code = 'CANCELLED'`) → new lifecycle status **`DOWNLOAD_CANCELLED`** placed right after `DOWNLOAD_FAILED` in the D-9 order. Distinct from a failure, one word in the grid.
- Routes (policy-gated manage): `GET admin/ai-models/jobs` (recent download + unregister jobs: model, kind, state, progress, started by/at, error), `POST admin/ai-models/:id/download/cancel` `{ removeRegistration?: false }`.
- Cancel mechanics: **waiting/delayed** job → `job.remove()` + bookkeeping; **active** job → cooperative cancel: the gateway sets `model-publisher:cancel:<jobId>` in Redis, the worker checks it at every heartbeat/file boundary, aborts via an `AbortSignal` threaded through the HF fetch, staging write and multipart upload (`AbortMultipartUpload`), wipes the staging dir, deletes partial objects under the prefix, records `CANCELLED`, and exits the job **without retry** (`UnrecoverableError`). Cancel is idempotent; a cancel on a finished job is 409 `JOB_NOT_ACTIVE`.
- `removeRegistration: true` → after the job is cancelled the row is soft-deleted (reusing the unregister job with `deleteWeights: true`).
- Closes the stuck-`UNREGISTERING` gap: an unregister whose bookkeeping is older than the stale window with no live job derives `UNREGISTER_FAILED`… (**see OD-6**) and can be retried.
- Console: a **Jobs** drawer (header button with an active-count badge) listing jobs with progress + Cancel; row action "Cancel download" while `DOWNLOADING`; cancel confirmation dialog (checkbox "Also remove the registration", default off); the grid status updates on the existing 5 s transient poll.

### D-D HF token tiering, prepared but dormant (R3)

- `CLOUD_BYO_PROVIDERS['model-registry']` stays `[]`: tenants cannot hold an HF token yet (OD-1).
- The HF client resolves the credential for the **job's tenant** and, per OD-3, **never falls back to the SYSTEM token for a non-SYSTEM job** (tenant row or anonymous). Platform registrations are SYSTEM jobs — exactly today's behaviour. A test pins the no-fallback rule so FU-1 cannot cascade by accident.

## Owner decisions (resolved 2026-09-30)

| Id | Decision |
|---|---|
| **OD-1** | **For now the registry and registered-model management are disabled for every tenant.** Only a platform admin manages. **Every tenant admin can see the list** of registered models (read-only). The toggle ships, default OFF; turning it on grants nothing yet — tenant-owned management is follow-up FU-1. |
| **OD-2** | Toggle = platform-wide default **plus per-tenant override** (Feature Availability matrix, `maxScope:'tenant'`). |
| **OD-3** | **No** — a tenant's private-repo download never falls back to the platform HF token (tenant token or anonymous only). Deliberate exception to tenant → SYSTEM, owner ruling. |
| OD-4…OD-10 | Recommendations accepted (★ below). |

### Options as presented (★ = accepted recommendation)

| Id | Question | Options |
|---|---|---|
| **OD-1** | What does "tenant admins may manage" do when the toggle is ON, in *this* ticket? | ★ **(a)** Ship the toggle, the policy seam and the tenant-scoped token plumbing now; with the toggle ON a tenant admin can manage the registry **UI-wise nothing more yet** (routes answer 403 `TENANT_MODEL_MANAGEMENT_NOT_AVAILABLE`) — tenant-owned self-hosted models (bucket isolation `tenants/<id>/…`, quotas, residency ownership) become a follow-up ticket. **(b)** Full tenant-owned self-hosted registration now (≈ doubles the ticket: tenant bucket namespace, quota, residency/serving ownership, cross-tenant serving isolation). |
| **OD-2** | Toggle granularity | ★ Platform-wide default **off** + per-tenant override in the Feature Availability matrix (`maxScope:'tenant'`). / Platform-wide only. |
| **OD-3** | With tenant management ON, may a tenant's private-repo download use the **platform** HF token when the tenant has none? | ★ **No** — tenant token or anonymous only (the platform token can reach repos the platform licensed; cascading it would leak access). This is a deliberate exception to "tenant → SYSTEM" and needs your ruling. / Yes, normal cascade. |
| **OD-4** | Tenant read-only view contents | ★ Status word + descriptive columns only; no per-service residency detail, no usage referrers, no bucket paths, no job errors (§D-A). / Same view as the platform admin minus write buttons. |
| **OD-5** | Cancel semantics | ★ Cancel keeps the row as `DOWNLOAD_CANCELLED` with Retry / Unregister, optional "Also remove the registration". / Cancel always removes the registration. |
| **OD-6** | Partial weights after cancel, and a stuck unregister | ★ Delete partial objects on cancel (no resume); a stale unregister derives `UNREGISTER_FAILED` and offers Retry. / Keep partials for resume. |
| **OD-7** | Model default profiles (ASR decode profile, LM Studio load profile) in the UI | ★ Keep, but only as a collapsed **Advanced defaults** tab on the edit drawer (platform admin) — seeded tuned values (TASK-994) stay editable; nothing at registration. / Remove the UI entirely (DB/seed only). |
| **OD-8** | Where the mount root is declared | ★ One contract constant in `@arcaai/types` + parity fixture + deployment CI check (it is topology the manifests must match, not a runtime knob). / An env-tier bootstrap var read by gateway and console. |
| **OD-9** | Auto-derived `vramGiB` default | ★ `ceil(weightsGiB × 1.25 + 1)`, written only when absent, flagged `derived: true` so the Serving tab shows it as an estimate. / Leave unset (model stays `SERVING_FACTS_MISSING` until a platform admin sets it). |
| **OD-10** | Fix the nlp/tts `HF_HOME` → `cache_dir` layout mismatch (C-7) in this ticket? | ★ Yes, as a small lane with a RED test proving the miss first. / Separate ticket. |

## Implementation Plan (on go)

### Shared contract (committed by the orchestrator before any lane starts)

```ts
// packages/types/src/model-registry.ts
export const HOPE_MODELS_BUCKET = 'hope-models';
export const HOPE_MODELS_MOUNT = '/mnt/models-bucket';
export type ModelRegistrySource = 'HUGGINGFACE' | 'MLFLOW' | 'LOCAL';        // console-facing subset
export interface RegistryAccess { canManage: boolean; tenantManagementEnabled: boolean }
export type PublisherJobState = 'waiting' | 'active' | 'completed' | 'failed' | 'cancelled';
export interface PublisherJobView {
  jobId: string; kind: 'download' | 'unregister'; aiModelId: string; modelSlug: string;
  state: PublisherJobState; bytesDone: number | null; bytesTotal: number | null;
  startedAt: string; finishedAt: string | null; startedBy: string | null; error: { code: string; message: string } | null;
}
// lifecycle: + 'DOWNLOAD_CANCELLED' (after DOWNLOAD_FAILED), + 'UNREGISTER_FAILED' (after UNREGISTERING) — pending OD-6
```

Routes (new/changed, all under `admin/ai-models`):

| Route | Gate | Purpose |
|---|---|---|
| `GET access` | read | `{ canManage, tenantManagementEnabled }` for the caller |
| `GET list`, `GET :id`, `GET slug/:slug` | read (redacted for non-managers) | registry rows + lifecycle status |
| `GET local/preview?path=` | manage | normalise + inspect a bucket path |
| `POST register-from-path` | manage | create `source=LOCAL` row from the preview |
| `POST register-from-hub` | manage | now accepts `{ repoId }` alone (name/slug derived) |
| `GET jobs` | manage | recent publisher jobs |
| `POST :id/download/cancel` | manage | cancel the active/queued download (`{ removeRegistration? }`) |

### Lanes (disjoint file ownership; each in its own worktree off `dev-2.2`)

| Lane | Owns | Tier |
|---|---|---|
| **A** access + toggle + tenant read | new `ai-model/access/**` (`ModelRegistryAccessService`: `GET access`, toggle read), `aiModel.service.ts` (fold `assertPlatformAdmin` into `assertPlatformRegistryAdmin`; redacted read path for non-managers), `aiModel.dto.mapper.ts` + a redacted response DTO, `lifecycle/model-lifecycle.service.ts` (status-only residency read), `model-residency.service.ts` (new ungated status-only method), `feature-availability.descriptors.ts` (new key), `ai-model-admin.controller.ts` (per-route read/write decorators, `GET access`), `apps/admin-console/src/server/hope-proxy.ts` platform-wide list only if needed (tenant reads must be tenant-scoped) | opus |
| **B** registration sources + serving default | `lifecycle/hub-preview.util.ts`, `lifecycle/model-registry-operations.service.ts` (register-from-hub with `{repoId}` alone + `vramGiB` default from preview size), new `lifecycle/local-preview.*` + `lifecycle/model-path-registration.service.ts`, `dto/` new local-path DTOs, prefix normaliser in `constants.ts` + `BucketRelativePrefixConstraint`, `aiModel.service.module.ts` (provider), `ai-model-registration.controller.ts` (routes), parity test in `tests/contracts/` | opus |
| **J** job control + HF tenant credential | `publish/**` (cancel flag, `AbortSignal` through the HF client / staging / multipart, partial cleanup, `CANCELLED` bookkeeping, HF credential for the job tenant with no SYSTEM fallback), `lifecycle/model-lifecycle.derive.ts` (`DOWNLOAD_CANCELLED`, `UNREGISTER_FAILED`), new jobs service in `publish/`, `ai-model-jobs.controller.ts` (routes) | opus |
| **C** console | `features/ai-models/**` (Register sheet with three tabs + summary card, Jobs drawer, cancel dialog, slimmed edit drawer with Serving / Advanced-defaults tabs, read-only grid when `canManage` is false, new lifecycle statuses), new `src/shared/bucket-path-picker/`, route move `(global)/ai-models` → `(shared)/ai-models` + redirect, `nav-config.ts` + its pinned test, rewrite `tests/e2e/ai-models.spec.ts` | sonnet (UI), opus reviews |
| **P** python + deployment consistency | `apps/nlp` / `apps/tts` `source_resolver.py` hub-cache dir + tests; deployment repo (`../hope-v2-deployment-task-1023`, branch `task-1023/models-mount`): CI check for the models-bucket mountPath, refresh stale manifest comments | sonnet |
| **Orchestrator** | contract commit (`@arcaai/types` `model-registry.ts`, the two new lifecycle statuses, the mount constants re-exported from `@arcaai/types`, two empty controllers registered before the admin controller so B and J never touch the admin controller or the module); merges; the five API artifacts; env/turbo untouched (no new env var under OD-8 ★); docs (`docs/operations/` registry runbook section); the single post-merge gate; live proof | — |

Merge order: contract → A, B, J, C, P in parallel (disjoint files) → merge A → B → J → C → P → artifacts → gate.

### TDD test list (RED first; each lane runs ONLY its own test files — owner rule: no gates before the full merge)

**Lane A**
- A1 access: super admin + no working tenant → `canManage:true`; super admin + working tenant → false; tenant admin → false with the toggle off AND on (OD-1); toggle read error → `tenantManagementEnabled:false`.
- A2 every `AiModelService` write (create, update, delete, platform-default) is 403 for a super admin WITH a working tenant (previously allowed) and for a tenant admin.
- A3 tenant `GET list` returns SYSTEM rows with lifecycle status and **none** of: `services[]`, bucketPrefix, download error, usage.
- A4 tenant admin `GET :id` / `slug/:slug` of a SYSTEM row → 200 redacted; of a tenant BYO row of another tenant → 404.
- A5 descriptor: default false, platform-only write, tenant override honoured, appears in the features matrix.
- A6 (moved to Lane J as J7).
- A7 e2e: tenant admin JWT → `GET admin/ai-models/list` 200 redacted, `POST register-from-hub` 403; route-authz matrix green.

**Lane B**
- B1 normaliser: `/mnt/models-bucket/x/`, `hope-models/x/`, `s3://hope-models/x/`, `x` → `x/`; `..` segments refused.
- B2 local preview: HF snapshot dir → task/library from `config.json`, sha from path; flat GGUF prefix → `llama.cpp`, `primaryObject` = the `.gguf`; `ggml-*.bin` → `whisper.cpp`; empty prefix → 404 `PATH_EMPTY`.
- B3 `register-from-path` creates `source=LOCAL`, `deploymentKind=SELF_HOSTED`, derived `sourceUri`; slug collision 409.
- B4 `register-from-hub {repoId}` alone succeeds (name/slug from preview).
- B5 `vramGiB` derived when absent, untouched when present, marked `derived: true`; vLLM serving spec then resolves.
- B6 contract parity: gateway + console + fixture agree on the mount root.

**Lane J**
- J1 cancel of a waiting job → `job.remove()`, bookkeeping `CANCELLED`, lifecycle `DOWNLOAD_CANCELLED`.
- J2 cancel of an active job → flag set; worker (mocked streams) aborts within one heartbeat, aborts the multipart upload, wipes staging, deletes partial keys, no retry.
- J3 cancel on a finished job → 409 `JOB_NOT_ACTIVE`; double cancel idempotent.
- J4 `removeRegistration: true` → unregister job enqueued with `deleteWeights: true`.
- J5 `GET jobs` merges BullMQ state with `_metadata` bookkeeping; a superseded job is shown as such.
- J6 stale unregister (no live job, past the window) → `UNREGISTER_FAILED` (per OD-6), retry allowed.
- J7 HF credential: a SYSTEM job resolves the SYSTEM token; a non-SYSTEM job with no tenant token sends NO `Authorization` header (never the SYSTEM token, OD-3).

**Lane C** (Vitest + RTL)
- C1 Register sheet: HF tab — typing a repo id shows the summary card, submit posts `{repoId}` only; MLflow tab disabled with the "not available yet" text; Local tab — picker selection shows `/mnt/models-bucket/<prefix>`, preview card, posts `register-from-path`.
- C2 tenant admin (`canManage:false`) sees the grid with no write buttons, no Jobs drawer, no row actions.
- C3 Jobs drawer lists jobs with progress; Cancel opens the dialog; "Also remove the registration" off by default; grid shows `Download cancelled` after the poll.
- C4 edit drawer: identity read-only; Serving + Advanced defaults tabs visible only to a manager.
- C5 nav-config pinned table updated (`/ai-models` in `(shared)` 20-29); redirect from the retired path.
- C6 axe 0 violations on sheet, drawer, dialog, grid — both themes.

**Lane P** (if OD-10 yes)
- P1 nlp/tts: with `HF_HOME=<tmp>/hf` and a snapshot under `<tmp>/hf/hub/models--o--n/…`, offline resolution of `o/n` finds it (RED today).
- P2 deployment CI: a manifest with a models-bucket mount at another path fails the new check.

### Verification (after all lanes are merged — the one gate)

1. `pnpm --filter @arcaai/applications build test`, `pnpm --filter @arcaai/types build`, `pnpm api:build`, `pnpm test:unit`, `pnpm --filter @arcaai/admin-console build lint test`, `pnpm nlp:test`, `pnpm tts:test` (Lane P), `pnpm lint:all`, `pnpm typecheck:all` — output pasted here.
2. The five artifacts regenerated (`api:build`, `api:route-manifest`, `api:openapi`, `api:portal`, `vox-node gen:admin`) and their checks green; `task-776-route-authz-matrix.spec.ts` green.
3. `RESET_DB=false` e2e: A7 + the rewritten console `ai-models.spec.ts`.
4. **Live proof, local stack** (`pnpm stack:dev` + `pnpm publisher:dev`): platform admin registers a small public HF repo by repo id only → Jobs drawer shows progress → cancel mid-download → grid `Download cancelled`, no objects left under the prefix → retry → `DOWNLOADED`; register a local path picked in the bucket browser → row with derived classification; MLflow tab shows "not available yet"; tenant admin sees the read-only grid, no write controls, write API 403; toggle ON for one tenant in `/features` → `GET access` reports it, that tenant's admin still cannot write (OD-1). Screenshots, both themes.

### Follow-ups (out of scope)
- FU-1 Tenant-owned self-hosted models (if OD-1 a): tenant bucket namespace, quotas, residency/serving ownership, tenant HF token UI.
- FU-2 MLflow registration: resolve `models:/<name>@<alias>` → artifact URI → publish into `hope-models`.
- FU-3 Import HF `generation_config.json` into a model default profile shown on the Advanced defaults tab.
- FU-4 Harness/guardrail/text bucket mounts (harness MiniCheck currently falls through to `sourceUri`).
- FU-5 An unregister has no heartbeat: a purge running longer than the stale window reads `UNREGISTER_FAILED` while still running (retry is idempotent).
- FU-6 "Also remove the registration" on a RUNNING cancel runs the unregister in the worker without the residency unload the route does (the worker still re-checks referrers).
- FU-7 Jobs drawer shows the starter as a user id; an old unregister job whose row was hard-removed shows no model name.
- FU-8 The model publisher treats a `CHANGE_ME` key pair as a real credential (MinIO rejects it as `UnknownError`, three retries); it should fail closed as `MODEL_STORE_CREDENTIAL_MISSING`.
- FU-9 `getById` for a tenantless super admin does not pin `tenantId = SYSTEM` (can read a tenant BYO row by id) — pre-existing, found by Lane A.
- FU-10 The inventory lists `hf/hub/models--ai4bharat--Cadence-Fast/…` (objects from 2026-09-13) as "in bucket, not registered" while the `cadence-fast` row has no `bucketPrefix` — link it with `register-from-path` or PATCH its prefix.

## Implementation Summary

| Req | What now exists |
|---|---|
| R1 platform-only management, tenant read-only list | One write gate for the whole registry: every `AiModelService` write and platform read now goes through `assertPlatformRegistryAdmin` (super admin, NO working tenant — previously create/update/delete/platform-default/reads checked super admin only). New `GET admin/ai-models/access` (`{ canManage, tenantManagementEnabled }`) and `GET admin/ai-models/registry` (redacted, paginated: descriptive columns + one-word `lifecycleStatus`, filter/search/sort only on those columns) — both `read:AiModel` + `svc:admin:ai-model:read|manage`, on the catalogue controller. Status comes from a new ungated status-only residency read. Console `/ai-models` moved to `(shared)` (tier 20-29, `read:AiModel`); a non-manager sees the read-only grid only. |
| R2 toggle | Feature Availability key `modelRegistry.tenantManagement.enabled` (default off, platform-only write, per-tenant override in the `/features` matrix). Reported by `GET access`; grants nothing yet (OD-1). |
| R3 HF token | Still SYSTEM-only (`'model-registry': []`). The HF client now resolves the credential for the JOB's tenant and never falls back to the SYSTEM token for a non-SYSTEM job (OD-3, pinned by test). |
| R4 simple registration | One **Register model** sheet: *Hugging Face* (repository id only; derived summary card; "Advanced" with revision/name/slug/served-by, auto-opened when served-by cannot be inferred), *MLflow* ("not available yet"), *Local path* (shared `BucketPathPicker` over `hope-models` + "in the bucket, not registered" suggestions → `GET local/preview` → `POST register-from-path`). A pasted `/mnt/models-bucket/…`, `hope-models/…` or `s3://hope-models/…` path is normalised; the prefix validator now rejects a mount-qualified prefix. Mount root + bucket declared once in `@arcaai/types` (`HOPE_MODELS_MOUNT`, `HOPE_MODELS_BUCKET`), parity-tested; deployment CI job `models-mount` checks every manifest. Registration fields: 26 always / 39 with ASR before → Hugging Face 1 (+4 optional), Local path 0 typed (+6 optional). |
| R5 no hyperparameters | Registration carries none. vLLM-served rows get a derived `serving.vramGiB = ceil(weightsGiB × 1.25 + 1)` flagged `derived` (dropped when an admin sets it). Edit drawer: name/description/tags editable, identity read-only, *Serving* tab (engine facts), *Advanced defaults* tab (ASR defaults, ASR models only, "tenants tune these per Agent"). |
| R6 job control | `GET admin/ai-models/jobs`, `POST admin/ai-models/:id/download/cancel {removeRegistration?}`. Queued → removed now; running → Redis flag + row request, the worker aborts (AbortSignal through fetch/staging/multipart), wipes staging, deletes only the keys it uploaded, records `CANCELLED`, no retry. New lifecycle `DOWNLOAD_CANCELLED`, `UNREGISTER_FAILED` (stale unregister, retryable). Console Jobs drawer + cancel dialog + row action. |
| C-7 | nlp/tts resolve the HF hub cache as `HF_HUB_CACHE` → `HF_HOME/hub` → default (previously `HF_HOME` itself — wrong on the cluster, where it is `/mnt/models-bucket/hf`). |

No Prisma schema change, no migration, no new env var.

### Deviations from the plan
- `GET registry` is a NEW route rather than opening `GET list/:id/slug` to tenants — the platform routes and their authz stay untouched.
- `access`/`registry` live on `AiModelCatalogueController`, not the admin controller: the boot audit `auditAdminControllersDeclareCorrectSvcScope` admits the `:read`+`:manage` service-account pair only for `:write` twins, so the gateway refused to start (caught by the live boot, not by unit tests; now pinned by a unit test over every admin-controller route).
- The unregister-after-cancel for a RUNNING job runs in the worker (Lane J), not as a separate queued job.

### Defects found and fixed during verification
| Found by | Defect | Fix |
|---|---|---|
| Lane B report, verified | `download-missing` queued LOCAL rows with an `s3://hope-models/…` source (fetcher refuses → `DOWNLOAD_FAILED`) | `95d4317a2` |
| post-merge gate | console hook order (`close` used `hf`/`local` before declaration), unused helpers, controller test arity, prettier | `3624a177e` |
| orchestrator review | console read `suggestedServedBy` / `serving` — the gateway returns `suggested.servedBy` / `servingFacts` | `df34a37e6` |
| live boot | svc read+manage pair refused on the admin controller → gateway would not start | `a8ed45f20` |
| live proof | an earlier cancelled run read `failed` once a retry replaced the bookkeeping | `d7bb49dc7` |
| live proof | HF snapshot with an `onnx/` export derived as onnxruntime + ONNX (also `formatFor` in the Hub preview) | `1d60ca5dc` |
| live proof | re-registering an unregistered repo → raw `PERSISTENCE.UNIQUE_CONSTRAINT_VIOLATION` (slug unique over deleted/disabled rows; pre-check saw ENABLED only) | `2217f7610` — suggested slugs step to `<slug>-<n>`, a named taken slug is `SLUG_TAKEN` |
| e2e | registry-view spec matched `metaData` inside a seeded description | `7441a6f94` |

### Evidence
**Gate 1** (after all five lanes merged, `df34a37e6`): build + the five artifacts + drift checks green; applications **15 965 passed**, api **4 716 passed**, console **3 821 passed**, contracts **386 passed**, vox-node green; applications lint/typecheck 0 errors; console build green. Pre-existing, out of scope: nlp `test_metrics_endpoint_task636.py` ×2 (fails on plain `dev-2.2` since TASK-1019), black on `nlp/api/v1/rest/diagnosis.py` and `tts/tests/test_otel_tracing_task636.py` (untouched). Lane P: nlp 22 passed, tts 25 passed (RED shown first).

**Gate 2** (after the verification fixes, `a186f35d9`): applications **15 978 passed**, api **4 725 passed**, console **3 821 passed**, contracts **386 passed**; lint 0 errors (applications, api, console — the warnings are pre-existing; none in this ticket's files); typecheck 0 (applications, api, console, vox-node); `api:openapi:check`, `api:portal:check`, `gen:admin:check` green.

**e2e (local dev stack, `RESET_DB=false`)**: console `tests/e2e/ai-models.spec.ts` **18/18** (platform admin: registry, HF register by repo id → jobs drawer, MLflow tab, Local path tab, jobs drawer, slim edit, search, sort, axe light+dark on grid/sheet/drawer; tenant admin: read-only grid, nav entry, axe light+dark). API `task-1023-model-registry-access.spec.ts` **5/5** (run with `SKIP_DB_PRECHECK=true` against the dev gateway; one test re-run alone after the login throttle). `task-890-byo-models.spec.ts` (403 expectation changed) and the route-authz matrix need the isolated test stack — **not run**.

**Live proof (local stack, 2026-09-30)**:
- Tenant admin: `access` → `{canManage:false, tenantManagementEnabled:false}`; `registry` → 34 SYSTEM rows, exactly the 18 view keys, no hidden field; `list`/`inventory`/`jobs`/`local/preview`/`register-from-hub`/`cancel` → 403; `catalogue` → 200.
- Platform admin (tenantless): `access.canManage:true`; `register-from-hub {repoId:"distilbert/distilbert-base-uncased"}` alone → 202 (FILL_MASK, transformers, nlp, pinned `12040acc…`); **cancel while running → 202 `cancelling`, lifecycle `DOWNLOAD_CANCELLED` within 3 s**; second cancel → same 202; cancel after finish → 409 `JOB_NOT_ACTIVE`; no staging dir or bucket object left; retry → `DOWNLOADING`; cancel with `removeRegistration` → row gone in 3 s.
- `hf-internal-testing/tiny-random-bert` (no pipeline tag → 400 `SERVED_BY_REQUIRED`, then with `servedBy`) → `DOWNLOADED`, `AVAILABLE`; `local/preview` of the pasted `/mnt/models-bucket/hf/hub/…/snapshots/f171d7ba…/` → normalised prefix, `hf-cache`, sha revision, (after `1d60ca5dc`) transformers + SAFETENSOR; bad path → 400 `PATH_INVALID`; empty → 404 `PATH_EMPTY`; taken slug → 409 `SLUG_TAKEN`; `register-from-path` → 201 `source=LOCAL`, SELF_HOSTED, derived `localPath`; `download-missing` skipped it (`SOURCE_NOT_FETCHABLE`).
- Cleanup: the LOCAL row unregistered `kept-shared`; the Hub row unregistered with purge → 0 versions under its prefix.
- Screenshots (headless Playwright): platform grid, Register sheet (HF / MLflow / Local), Download jobs drawer, tenant read-only grid (dark).

**Local environment notes (not code)**: `.env.dev` was rewritten on 2026-09-30 11:44 with `MODEL_STORE_PUBLISHER_*=CHANGE_ME` (MinIO rejects the placeholder); the proof ran the publisher with the local MinIO platform key as host env (the file was not edited). The dev API's login throttle trips on repeated e2e logins. Next dev blocks `127.0.0.1` for its dev resources — use `localhost` for console e2e.

## Change History

| Date | Change |
|---|---|
| 2026-09-30 | Ticket opened as TASK-1023 (highest existing: TASK-1022 across `dev-2.2`, all branches and every worktree). Three read-only discovery agents (sonnet: backend, console, mount/runtime-params); key claims re-verified by hand (`@Authorize(['manage','all'])` at controller :55, `HOPE_MODELS_MOUNT` constant, `vramGiB` required by the serving spec, `'model-registry': []`, SYSTEM-pinned HF credential, no cancel path, nlp `HF_HOME`→`cache_dir`). Plan + OD-1…OD-10 written. Status Pending — awaiting owner decisions and go. |
| 2026-09-30 | Owner: TASK-1023 confirmed; OD-1 management disabled for all tenants, every tenant sees the list; OD-2 platform default + per-tenant override; OD-3 no platform-token fallback; OD-4…OD-10 recommendations. Plan refined: one write gate (`assertPlatformRegistryAdmin`) instead of a new policy class, toggle grants nothing yet, HF credential rule moved to Lane J, two empty controllers in the contract so lanes never share a file. Status In Progress. |
| 2026-09-30 | Lanes A (opus), B (opus), J (opus), C (sonnet), P (sonnet) ran in `../hope-v2-task-1023-{acc,reg,job,con,py}` + `../hope-v2-deployment-task-1023`. A, J, C and P each stalled once (stream watchdog, before writing) and were resumed with the smaller-steps brief. Merged into `dev-2.2`: A `9e900a5ea`, B `16779ac8c`, orchestrator wiring `95d4317a2`, P `3f4f9ac29`, J `ec85a6cb9`, C `1b9674c65`. Gate 1, the live proof and the fixes in "Defects found and fixed" followed. |
| 2026-09-30 | Side effect during the live proof: one `download-missing` call queued 22 seeded models (multi-GB); all were cancelled within a minute through the new cancel route (21 removed while queued, `cadence-fast` stopped while running, no objects written). Those 22 seeded rows now read `DOWNLOAD_CANCELLED` in the LOCAL dev DB (was `NOT_DOWNLOADED`); Retry re-downloads any of them. |
