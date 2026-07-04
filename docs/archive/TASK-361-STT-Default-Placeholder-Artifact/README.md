# TASK-361 — STT Default Pipeline Points at a Non-Resolving Placeholder Artifact

| Field | Value |
|---|---|
| **Ticket** | TASK-361 |
| **Short name** | STT-Default-Placeholder-Artifact |
| **Type** | bugfix (TASK-356 Phase 2 follow-up) |
| **Severity** | **High** |
| **Status** | Completed |
| **Created** | 2026-06-15 |
| **Updated** | 2026-06-16 |
| **Discovered by** | TASK-356 audit (2026-06-15) — see [`TASK-356 README §8B`](../TASK-356-Admin-Managed-Models-Workflows/README.md) (Phase 2 defaults wiring) |
| **Owner** | TBD |
| **Resolution** | Option (a) + AC-3 cleanup — restored the resolvable `production-whisper-large-v3` pipeline as the effective default; CT2 int8 pipeline + model remain registered but non-default and untagged `production`/`recommended` until the D-4 artifact lands. Runtime fallback (option c) tracked as a future follow-up. |

---

## 1. Requirement Analysis

### Description

TASK-356 **Phase 2 (Defaults wiring)** switched the system default ASR pipeline to a new
faster-whisper CTranslate2 (CT2) int8 pipeline whose backing `AiModel` row carries a
**deliberately non-resolving placeholder `sourceUri`** (`MODEL_REPO_PLACEHOLDER/…`, pending the
D-4 artifact publish), and **demoted** the previously-default `production-whisper-large-v3`
pipeline to `isDefault: false`. The placeholder `AiModel` is nonetheless tagged `production` and
`recommended`.

The net effect on a **freshly seeded database**: the system default STT pipeline resolves to a
model artifact that **cannot load at runtime** (the placeholder URI does not point at a real
artifact), and the prior working default has been demoted. No conservative runtime fallback to a
resolvable pipeline was located, so the primary clinical-workspace transcription path can fail to
initialise its default model until engineers publish the real CT2 int8 artifact (D-4).

This was a **known, intentional placeholder** in Phase 2 (the TODOs say so), but it ships as the
**live, `production`/`recommended`-tagged default** — which is the gap this ticket tracks.

### Business context

STT is on the primary clinical-workspace path. A default pipeline that cannot resolve its model
means a freshly provisioned environment (new install, new tenant via clone-on-create, CI/seed-based
environments) has **no working default transcription** until the artifact is published and the
placeholder is replaced. Tagging a non-resolving artifact `production`/`recommended` also misleads
admins choosing a model from the catalog. TASK-356 AC-5 explicitly requires the defaults to be
"registered and **effective** on the primary clinical-workspace path **with conservative fallback if
a model is unavailable**" — which the placeholder default does not currently satisfy.

### Acceptance criteria

- [x] The **system default STT pipeline resolves to a real, loadable artifact at runtime** — met via
  option (a): the resolvable `production-whisper-large-v3` pipeline (loads `whisper-large-v3-turbo`,
  safetensor) is the effective default for every tenant until the CT2 int8 artifact is published.
- [ ] **OR** a documented **conservative runtime fallback** exists: when a default pipeline's model
  cannot resolve, the system falls back to a known-good pipeline (per TASK-356 AC-5 / R-1) rather
  than failing the default transcription path. _(Deferred — not needed once AC-1 holds; tracked as a
  future follow-up for defense-in-depth; see §5.)_
- [x] **No `production`/`recommended`-tagged placeholder ships as the live default** — the CT2
  placeholder `AiModel` + pipeline are de-tagged (`production`/`recommended` removed) and demoted to
  `isDefault: false`; they stay registered/catalog-visible only.
- [x] Seed + clone-per-tenant remain idempotent and preserve the one-default-per-tenant invariant
  (no double-default), and continue to **respect an admin-chosen default** — `switchDefaultSttPipeline`
  was reversed to reconcile back to the resolvable default while respecting an admin's resolvable pick;
  the non-resolving CT2 is never left as a default.

---

## 2. Current State Evaluation

### Evidence (git-confirmed; file:line)

**Placeholder `AiModel` shipped as the default, tagged production/recommended:**

- `packages/database/src/prisma/db_main/seed/06-stt.ts:201` —
  `sourceUri: 'MODEL_REPO_PLACEHOLDER/faster-whisper-large-v3-turbo-ct2'` (the non-resolving URI).
- `:206` — `tags: ['multilingual', 'faster-whisper', 'ctranslate2', 'int8', 'production', 'recommended']`
  (a non-resolving artifact tagged **`production`** + **`recommended`**).
- `:184–191` — the `AiModel` row's `TODO(D-4)` comment: engineers must run
  `ct2-transformers-converter … --quantization int8` and publish the artifact, then **replace
  `MODEL_REPO_PLACEHOLDER`** — "Until then this row intentionally does **NOT** resolve at runtime."

**The matching pipeline YAML carries the same placeholder:**

- `:1142–1156` — `PIPELINE_CONFIGS.faster_whisper_turbo_int8` `TODO(D-4)` + the ASR block
  `hf_model_id: "MODEL_REPO_PLACEHOLDER/faster-whisper-large-v3-turbo-ct2"` (`engine: faster_whisper`,
  `compute_type: int8`).

**The prior working default was demoted:**

- `:1639–1646` — `production-whisper-large-v3` (`PIPELINE_CONFIGS.production`) now
  `isDefault: false`, with a comment noting it was "demoted from system default in favour of the
  faster-whisper CT2 int8 pipeline … Existing DBs are migrated by `switchDefaultSttPipeline`".

**Default-switch logic (respects admin override, no double-default):**

- `:2368–2424` — `switchDefaultSttPipeline()` reconciles existing DBs: promotes the CT2 pipeline as
  the sole default when no admin override exists, demotes stale OLD-slug defaults, and **respects an
  admin-chosen default** (only demotes the freshly-seeded CT2 when an operator already picked
  something else). It is idempotent. It does **not**, however, guard against the CT2 model itself
  being non-resolvable — it reconciles `isDefault`, not artifact availability.

### Why no fallback today

The TASK-356 design calls for a conservative fallback (§4.8 / R-1: "Mitigate via catalog
`downloadStatus` + conservative fallback"), and AC-5 requires it, but the Phase 2 implementation set
the placeholder as the default **without** a located runtime fallback to a resolvable pipeline when
the default's model can't load. The placeholder is `source: LOCAL` with `downloadStatus` unset to a
ready state, so a `downloadStatus`-aware guard is the natural hook but is not wired to the default
selection path.

### Dependencies & impact areas

| Area | Path | Impact |
|---|---|---|
| STT seed (default + catalog) | `packages/database/src/prisma/db_main/seed/06-stt.ts` | Source of the placeholder default + demotion + reconcile |
| STT GlobalSetting | `packages/database/src/prisma/db_main/seed/91-user.ts` (`default-stt-pipeline`) | Points the runtime default at the CT2 pipeline |
| Clone-per-tenant | `packages/applications/src/services/tenant/tenant.service.ts` (`provisionTenantPipelineCatalog`) | Propagates the default pipeline to new tenants |
| STT runtime loader | `apps/stt-v2` (`FasterWhisperLoader`) | Where a non-resolving `sourceUri`/`hf_model_id` fails to load |
| Artifact publish (D-4) | model repo / registry | The real CT2 int8 artifact that must replace the placeholder |

---

## 3. Implementation Plan (APPROVED — option (a) + AC-3 cleanup)

> Phase 2 (explore) was run via three parallel read-only agents (seed/reconcile, `stt-v2` runtime
> resolution, default selection/propagation). Phase 3 plan approved on 2026-06-16: **option (a)** —
> restore the resolvable `production-whisper-large-v3` pipeline as the effective default + clean up
> the misleading tags (AC-3). Options (b) publish-artifact and (c) runtime-fallback were considered:
> (b) depends on the external D-4 artifact (out of repo scope now); (c) is a larger runtime change
> that, on its own, does **not** satisfy AC-3 — tracked as a future follow-up (§5).

### Why option (a)

The previously-demoted `production-whisper-large-v3` pipeline (`PIPELINE_CONFIGS.production`) loads a
fully-resolvable artifact (`openai/whisper-large-v3-turbo`, `safetensor`) and is already seeded for
every tenant. It is the lowest-risk, fully-in-our-control fix, satisfies AC-1/AC-3/AC-4, and reverses
trivially once the D-4 artifact is published. The runtime resolver
(`userPreferences.service.ts` `resolveRemoteConfig`) selects the default by `AsrPipeline.isDefault`
(tier 2) then the `default-stt-pipeline` GlobalSetting (tier 3) with **no artifact-availability check**,
so pointing both at the resolvable pipeline restores a working default end-to-end.

### Changes (all seed/config — no schema, no migration)

| # | File | Change |
|---|---|---|
| 1 | `seed/06-stt.ts` | Demote all 5 CT2 pipelines (`…0008/0103/0203/0303/0403`) to `isDefault: false`; promote all 5 `production-whisper-large-v3` rows (`…0001/0101/0201/0301/0401`) to `isDefault: true`. |
| 2 | `seed/06-stt.ts` | AC-3: strip `production`/`recommended` tags from the placeholder `AiModel` (`…0007`) and all 5 CT2 pipeline rows (kept registered/catalog-visible). |
| 3 | `seed/06-stt.ts` | `DEFAULT_STT_SETTINGS` `batch_pipeline_slug` + `streaming_pipeline_slug` → `production-whisper-large-v3`. |
| 4 | `seed/06-stt.ts` | Reverse `switchDefaultSttPipeline()`: reconcile EXISTING DBs back to the resolvable default, demote the non-resolving CT2 out of the default slot, still respect an admin-chosen **resolvable** default, still one-default-per-tenant + idempotent. Renamed constants → `STT_DEFAULT_PIPELINE_SLUG` / `STT_PLACEHOLDER_PIPELINE_SLUG`. |
| 5 | `seed/91-user.ts` | `default-stt-pipeline` GlobalSetting → Global resolvable pipeline id `…0401` (was CT2 `…0403`). |
| 6 | `__tests__/seed.test.ts` | New TASK-361 guard block (no `isDefault` pipeline references `MODEL_REPO_PLACEHOLDER`; placeholder registered but not `production`/`recommended`); inverted the CT2-default-pinning tests + the `switchDefaultSttPipeline` backfill tests to the reversed spec. |

### Verification (evidence captured)

- `vitest run src/__tests__/seed.test.ts` → **327 passed** (was 323 + 4 new TASK-361 guards). RED first confirmed the 4 guards failed against the unfixed seed.
- Tenant clone-per-tenant unit tests (`tenant.service.test.ts`) → **99 passed** (decoupled from seed; mock-based).
- No `.prisma` / migration files changed → schema/migration state unchanged (no `migrate diff` drift).
- `ReadLints` on the 3 edited files → clean. `tsc` reports only **pre-existing** errors in unrelated files (`13-harness-policy.ts`, `14-pipeline-policy.ts`, `api-key-pepper.test.ts`) — none in the STT files.
- Pre-existing unrelated failure `extensions/__tests__/tenant-scope.test.ts` (PipelinePolicy tenant-scope drift) confirmed via stash-and-rerun to fail identically without these changes.

---

## 4. Follow-ups (out of scope for this ticket)

- **D-4 artifact publish (option b):** when engineers convert + publish the real CT2 int8 artifact,
  replace `MODEL_REPO_PLACEHOLDER` in the `AiModel.sourceUri` (`06-stt.ts`) **and** the pipeline
  `hf_model_id`, restore the `production`/`recommended` tags, and re-promote CT2 to the default (the
  `STT_DEFAULT_PIPELINE_SLUG` / `STT_PLACEHOLDER_PIPELINE_SLUG` constants + reversed reconcile make
  this a small, symmetric flip). Note: re-promoting CT2 also restores its diarization + int8 capability
  that whisper-large-v3 does not carry.
- **Runtime conservative fallback (option c):** for defense-in-depth per TASK-356 AC-5 / R-1, gate the
  `stt-v2` load path on artifact availability and fall back to a known-good model. Natural hook:
  `ModelCache.get_or_load` (`apps/stt-v2/.../models/cache.py`), using the already-present-but-unused
  `AiModelConfig.is_downloaded` / `ModelRegistryReader.get_downloaded_models` signals.

---

## 5. Change History

| Date | Description | Files |
|---|---|---|
| 2026-06-15 | Ticket opened from the TASK-356 audit. Documented (with git-confirmed file:line evidence) that TASK-356 Phase 2 set the default STT pipeline to a non-resolving placeholder `AiModel` tagged `production`/`recommended` (`06-stt.ts:201,206`, TODO `:184–191`/`:1142–1156`), demoted the prior `production-whisper-large-v3` default (`:1639–1646`), with no located conservative fallback (`switchDefaultSttPipeline` `:2368–2424` reconciles `isDefault`, not artifact availability). Proposed three DRAFT remediation options (needs approval). No code changed. | _(docs only)_ |
| 2026-06-16 | **Implemented option (a) + AC-3 cleanup (TDD).** Restored `production-whisper-large-v3` as the effective default across all 5 tenants (`isDefault` flips), de-tagged + demoted the CT2 placeholder model + pipelines (kept registered), repointed `DEFAULT_STT_SETTINGS` batch/streaming slugs + the `default-stt-pipeline` GlobalSetting (`…0403`→`…0401`), and **reversed `switchDefaultSttPipeline`** to reconcile existing DBs back to the resolvable default (respects admin-chosen resolvable picks; never leaves the non-resolving CT2 as default). Added TASK-361 guard tests + inverted the CT2-pinning/backfill tests. Verified: 327 seed tests + 99 tenant tests pass; no schema/migration change; lints clean; new TS/test failures are pre-existing + unrelated. | `seed/06-stt.ts`, `seed/91-user.ts`, `__tests__/seed.test.ts` |
