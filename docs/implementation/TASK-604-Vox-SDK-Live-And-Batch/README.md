# TASK-604 — Vox SDK: native live provider switch + batch transcription

| Field                       | Value                                                                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**                  | Review (code complete, gates green; live-stack pass outstanding)                                                                                              |
| **Type**                    | feature                                                                                                                                                       |
| **Branch**                  | `dev-2.1`                                                                                                                                                     |
| **Packages**                | `@arcaai/vox` (core + plugins entries — **NOT** `compat`), `@arcaai/applications`, `apps/api`                                                                 |
| **Depends on**              | TASK-567 (STT fallback + BYOK), TASK-586 (runtime provider switch), TASK-587 (language modes), TASK-603 (compat batch upload — reference implementation only) |
| **Explicitly out of scope** | `packages/agentic-sdk-v2/src/compat/**` and `apps/compat-playground` — untouched                                                                              |

## Requirement Analysis

Two end-user capabilities must be reachable from the **native** (non-compat) SDK surface:

1. **Live transcription** — the user MUST be able to switch between the selected pipeline
   and the default fallback STT provider, mid-session, to get high-quality transcription.
2. **Batch transcription** — the user MUST be able to upload **up to 5 recordings**, each
   **at most 60 minutes**, and MUST be able to monitor each job and collect its result.

Owner decisions taken before planning (2026-08-03):

| Decision                               | Answer                                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------------------ |
| Ticket                                 | TASK-604                                                                                   |
| Where the 5-file / 60-minute caps live | **SDK caps + backend admin-configurable settings + gateway enforcement of file duration**  |
| Native ↔ compat code sharing           | Extract a shared engine into `src/core/`; the compat hook is **not** edited in this ticket |
| Fallback-provider discovery            | **In scope** — the toggle must be able to name the default provider                        |

## Current State Evaluation

### Use case 1 — live provider switch: **already shipped natively; polish + discovery missing**

| Piece                    | Location                                                                                                                         | State                                                                                 |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `useSttProviderToggle()` | `src/hooks/useSttProviderToggle.ts`                                                                                              | Works. `switchToPipeline()` / `switchToDefault()`, idempotent both ways, 9 unit tests |
| Transport                | `StreamingSessionManager.switchProvider` (`:295`) → `SWITCH_TO_PRIMARY` / `SWITCH_TO_FALLBACK` (`core/constants.ts:392`, `:399`) | Both directions native (no compat shim)                                               |
| Gateway                  | `transcription-job.controller.ts:549` (fallback), `:597` (primary)                                                               | Present; fallback direction 409s when the tenant has no fallback configured           |
| Exports                  | `core.ts:65`, `plugins.ts:61`, `hooks/index.ts:103`                                                                              | Present                                                                               |

Gaps:

1. **Stale docstring** — `useArcaAudio.ts:851` still says `target: 'primary'` "requires compat mode".
   The native primary route landed afterwards; the comment now misdirects SDK consumers.
2. **No error surface** — `switchStatus` latches (never returns to `idle`) and the only failure
   signal is the rejected promise, so every consumer must `try/catch` to render a reason.
3. **"Default" cannot be named** — nothing native reads the tenant's configured fallback pipeline,
   so a UI can only render an opaque "Default" label, and _no fallback configured_ is discovered
   only by attempting the switch and taking a 409 **mid-consultation**. The data already exists
   server-side (`ITenantSttConfigService.getEffective(tenantId).fallbackPipelineId`, used by the
   fail-closed guard at `transcription-job.controller.ts:562`); it is simply not exposed to a
   non-admin caller.
4. **No docs** — `docs/API-Reference.md` has no section for the toggle; README names it once.

### Use case 2 — batch transcription: **not available natively, and neither cap is enforced anywhere**

| Concern                         | State                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Native React hook               | **None.** Only the raw class `FileTranscriptionService` is exported (`core.ts:677`)                                                                                                                                                                                                                                                                                                  |
| Monitoring                      | Consumer must hand-roll SSE and will hit both known traps: the 3-arg `new SSEClient(scope, apiClient, logger)` form, and the per-job scope `transcription_job:<jobId>` required by `@StreamScope` (`transcription-job.controller.ts:642`). The deprecated `apps/ui-playground/src/hooks/use-file-transcription.ts:101` gets both wrong, which is why its batch stream never connects |
| 5-file cap                      | **Not enforced** — client or server                                                                                                                                                                                                                                                                                                                                                  |
| 60-minute cap                   | **Not enforced** — client or server                                                                                                                                                                                                                                                                                                                                                  |
| What the gateway _does_ enforce | `MAX_FILE_SIZE = 100 MB` (`dto/transcription-job.dto.ts:5`) + a MIME allowlist                                                                                                                                                                                                                                                                                                       |

The size-only cap **inverts the requirement**: a valid 60-minute 16 kHz mono WAV (~115 MB) is
rejected, while a 3-hour 64 kbps MP3 (~86 MB) is accepted. Duration is the requirement; size is
a proxy that does not track it.

A working queue exists **only** in `src/compat/useArcaBatchTranscription.ts` (TASK-603) — entry-isolated
(`@arcaai/vox/compat` is its own tsup entry with `splitting: false`, so its React context does not
cross bundles) and out of scope here.

## Implementation Plan

Five lanes, in dependency order. TDD throughout (RED → GREEN → refactor).

### Lane A — Settings: admin-configurable batch limits (`@arcaai/applications`)

New descriptor file `settings-registry/descriptors/batch-transcription.descriptors.ts`, code
defaults as the single source of truth (precedent: `agentic-context.descriptors.ts`):

| Key                              | Tier        | Default | failMode          | Meaning                                                                                   |
| -------------------------------- | ----------- | ------- | ----------------- | ----------------------------------------------------------------------------------------- |
| `stt.batch.maxFilesPerBatch`     | `global-kv` | `5`     | `open-to-default` | Files a client may submit as one batch                                                    |
| `stt.batch.maxDurationMinutes`   | `global-kv` | `60`    | `open-to-default` | Per-recording duration ceiling                                                            |
| `stt.batch.maxFileSizeMb`        | `global-kv` | `250`   | `open-to-default` | Raised from 100 MB so a 60-min WAV fits the duration ceiling                              |
| `stt.batch.maxActiveJobsPerUser` | `global-kv` | `5`     | `open-to-default` | Server-side counterpart of "5 recordings" — in-flight (QUEUED/PROCESSING) jobs per caller |

Tier rationale: these are platform capacity knobs, not per-tenant secrets or selection, so
`global-kv` (`GlobalSetting`, global-admin editable, invalidation-propagated) is the declared
tier. A per-tenant override would need a new config table + descriptor scope and is **deferred**
— noted here so the deferral is a recorded decision, not an omission.

Resolved per request through `EffectiveSettingsService`, so a `PUT /admin/settings/registry/:key`
governs a running gateway with no redeploy.

### Lane B — Gateway enforcement + read surfaces (`apps/api`)

1. **`POST /audio/transcription-jobs/transcribe`** — before any storage I/O:
   - resolve the four limits;
   - **duration probe** on the uploaded buffer via a new dependency `music-metadata` (pure JS,
     parses WAV/MP3/M4A/OGG/FLAC/WebM headers — covers every entry of `ALLOWED_AUDIO_MIMES`);
     over the ceiling → `400` naming the measured and allowed durations;
   - **unreadable duration → `400`** (fail-closed, owner decision 2026-08-03). "Each recording at
     most 60 minutes" is enforced strictly: audio whose duration the parser cannot establish is
     rejected with a message naming the cause, rather than admitted unmeasured. The trade-off
     accepted here is that a legitimate recording in a container without a readable duration
     header is refused with no client-side workaround.
   - size check against the resolved `maxFileSizeMb`; the `FileInterceptor` `limits.fileSize` is
     static at decoration time, so it becomes a **hard ceiling** (the largest configurable value)
     with the resolved value enforced in the handler;
   - **active-job cap** per caller → `429` when at `maxActiveJobsPerUser`.
2. **`GET /audio/transcription-jobs/limits`** (new, read-only, class-level auth — precedent:
   `language-modes` at `:352`) → `{ maxFilesPerBatch, maxDurationMinutes, maxFileSizeBytes, maxActiveJobsPerUser, allowedMimeTypes }`.
   Lets the SDK enforce the same numbers client-side instead of hardcoding them.
3. **`GET /audio/transcription-jobs/fallback`** (new, read-only) → `{ configured, pipelineId, pipelineName }`
   from `sttConfig.getEffective(tenantId)`. Non-admin readable; no credential material.
4. Tests: controller unit tests for each rejection path, plus e2e (including cross-tenant 404
   posture on the two new GETs).

### Lane C — SDK core: shared, framework-free engine (`@arcaai/vox`)

| File                                  | Content                                                                                                                                                                                                              |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/BatchTranscriptionQueue.ts` | **NEW.** Upload-with-progress → per-job SSE (3-arg `SSEClient`, scope `transcription_job:<id>`) → authoritative terminal read-back; cancel / retry / remove / clear; concurrency slot held for upload **and** stream |
| `src/core/audioDuration.ts`           | **NEW.** Browser duration probe (`HTMLAudioElement` + object URL, always revoked); resolves `null` when the browser cannot read it                                                                                   |
| `src/core/constants.ts`               | Endpoints for `limits` and `fallback`                                                                                                                                                                                |

Compat is **not** edited; the existing compat hook keeps its own copy until a later ticket
converges it onto this engine.

### Lane D — SDK hooks

| File                                 | Change                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/hooks/useBatchTranscription.ts` | **NEW.** Native queue hook over the Lane C engine. Fetches `/limits` on mount; **server-resolved limits win** over hook props, which win over the code defaults (5 / 60). Files rejected by a cap land as `failed` rows carrying a named reason (`too_many`, `too_long`, `too_large`, `unsupported_type`) — never silently dropped |
| `src/hooks/useSttProviderToggle.ts`  | Add `switchError`, `resetSwitchStatus()`, and `fallback: { configured, pipelineId, name } \| null` + `canSwitchToDefault` from the Lane B read                                                                                                                                                                                     |
| `src/hooks/useArcaAudio.ts`          | Fix the stale `switchProvider` docstring (comment only)                                                                                                                                                                                                                                                                            |
| `src/types/stt.ts`                   | Batch queue item / limits / fallback types                                                                                                                                                                                                                                                                                         |
| `src/core.ts`, `src/hooks/index.ts`  | Export the new hook + types                                                                                                                                                                                                                                                                                                        |

### Lane E — Documentation

- `packages/agentic-sdk-v2/docs/API-Reference.md` — new sections for the live provider toggle and
  batch transcription; core-class table row for the queue.
- `packages/agentic-sdk-v2/README.md` — entry-point table.
- This README — Implementation Summary + Change History.

## Verification Criteria

```
pnpm --filter @arcaai/vox test typecheck lint build
pnpm --filter @arcaai/applications test build
pnpm test:unit                      # apps/api controller + guard tests
pnpm test:up:api && pnpm test:e2e   # new GETs incl. cross-tenant
pnpm lint
```

Plus the behavioural gates: a 61-minute file is rejected by the gateway with a duration message;
a 6th queued file never reaches the network; both switch directions still work against a live
session.

## Implementation Summary

Built on branch `task-604` in a git worktree (`.claude/worktrees/task-604`), branched from
`dev-2.1` after the uncommitted TASK-598…603 work was committed as `ac750a59`.

### Lane A — settings (`@arcaai/applications`)

| File                                                               | Change                                                                                                                                                                                                                |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `settings-registry/descriptors/batch-transcription.descriptors.ts` | **NEW.** `stt.batch.maxFilesPerBatch` (5), `maxDurationMinutes` (60), `maxFileSizeMb` (250), `maxActiveJobsPerUser` (5) — `global-kv`, `globalOnly`, `maxScope: 'system'`, all `open-to-default`                      |
| `settings-registry/registry.ts`, `settings-registry/index.ts`      | Registered + exported (the gateway reads `BATCH_TRANSCRIPTION_DEFAULTS` as its unwired fallback)                                                                                                                      |
| `stt/job/batch-transcription-limits.service.ts`                    | **NEW.** Resolves the four knobs through `EffectiveSettingsService`, failing open **per knob** — one unreadable value never discards the others. Non-numeric/non-positive values are refused; fractional values floor |
| `stt/job/transcriptionJob.service.module.ts`                       | Provides/exports the resolver; imports `EffectiveSettingsModule`                                                                                                                                                      |

### Lane B — gateway (`apps/api`)

| File                                        | Change                                                                                                                                                                                                                                                         |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `streaming/audio-duration.ts`               | **NEW.** Dependency-free container-header duration probe: WAV, FLAC, MP4/M4A, Ogg (Vorbis/Opus), WebM/Matroska, MP3 (Xing/VBRI + CBR), ADTS AAC. Dispatches on **magic bytes**, never the client MIME type; bounds-checked, returns `null` instead of throwing |
| `streaming/transcription-job.controller.ts` | `transcribeFile` resolves the ceilings, then checks size → duration → in-flight jobs, **all before storage I/O and the worker dispatch**. New `GET /limits` and `GET /fallback`, declared before `@Get(':id')`                                                 |
| `streaming/dto/transcription-job.dto.ts`    | `MAX_FILE_SIZE` (100 MB) → `MAX_UPLOAD_HARD_CEILING` (1 GB, static multipart guard only); `BatchTranscriptionLimitsResponse` + `SttFallbackProviderResponse`                                                                                                   |

`music-metadata` was evaluated and rejected: it is ESM-only from v8 (`"type": "module"`) and
`apps/api` compiles to CommonJS; the last CJS line (7.x) is years unmaintained. The probe reads
one field, so a self-contained parser costs less than either workaround.

### Lane C/D — SDK (`@arcaai/vox`, non-compat)

| File                                         | Change                                                                                                                                                                                                                                   |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core/BatchTranscriptionQueue.ts`            | **NEW.** Framework-free engine: upload-with-progress → per-job SSE → authoritative read-back; cancel/retry/remove/clear; a concurrency slot held for **upload and stream**. Enforces the caps and adopts the gateway's resolved ceilings |
| `core/audioDuration.ts`                      | **NEW.** Browser duration probe (detached `<audio>`, always revokes the object URL, times out)                                                                                                                                           |
| `hooks/useBatchTranscription.ts`             | **NEW.** React seam: `useSyncExternalStore` over the engine, fetches `GET .../limits`, disposes on unmount                                                                                                                               |
| `hooks/useSttProviderToggle.ts`              | Adds `switchError`, `resetSwitchStatus()`, `fallback`, `canSwitchToDefault`, `refreshFallback()`                                                                                                                                         |
| `hooks/useArcaAudio.ts`                      | Stale docstring corrected (primary-direction switching has not required compat mode since TASK-586 Lane H)                                                                                                                               |
| `core/constants.ts`                          | `STT_ENDPOINTS.BATCH_LIMITS` + `.FALLBACK_PROVIDER`                                                                                                                                                                                      |
| `core.ts`, `core/index.ts`, `hooks/index.ts` | Exports for the hook, the engine, the probe and their types                                                                                                                                                                              |

`packages/agentic-sdk-v2/src/compat/**` was **not touched**, as scoped. The compat hook keeps its
own queue implementation; converging it onto this engine is a follow-up.

### Lane E — docs

`docs/API-Reference.md` (two new §2 sections with worked examples + member tables, and a core-class
row), `README.md` (entry-point table), this README.

## Verification

```
pnpm --filter @arcaai/vox test        → 231 files, 3898 tests passed
pnpm --filter @arcaai/vox typecheck   → clean
pnpm --filter @arcaai/vox lint        → 0 errors (5 pre-existing warnings)
pnpm --filter @arcaai/vox build       → ok

pnpm --filter @arcaai/applications test  → 371 files, 7195 passed / 4 skipped
pnpm --filter @arcaai/applications build → ok
pnpm --filter @arcaai/applications lint  → 0 errors

apps/api streaming suites             → 13 files, 316 tests passed
pnpm api:build                        → ok
pnpm --filter @arcaai/api lint        → 4 errors, ALL pre-existing in
                                        modules/smr-compat/summary-schemas.ts (untouched here)
```

New tests: 6 descriptor, 6 limits-resolver, 14 duration-probe (API), 16 controller, 7 duration-probe
(SDK), 26 engine, 12 hook, 9 toggle — 96 in total.

### Not verified

Runtime verification against a live stack (upload a real 61-minute file, watch a real
`provider_switched` frame) was **not** run — it needs the Docker stack, an STT worker and audio
fixtures. Every layer is covered by unit tests against the real contracts, but a live pass is the
remaining gate before this is called done.

## Change History

| Date       | Change                                                                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-08-03 | Ticket opened; review of the native SDK completed, plan written, owner decisions recorded.                                                              |
| 2026-08-03 | Lanes A–E implemented TDD in the `task-604` worktree. Owner decision recorded mid-flight: an unreadable duration fails **closed** (400) at the gateway. |
