# Audio Transcription Defaults, SDK Local-Model URL Fix & Pipeline Versions 400

| Field | Value |
|---|---|
| **Ticket** | TASK-364 |
| **Created** | 2026-06-16 |
| **Updated** | 2026-06-17 |
| **Status** | Review |
| **Type** | bugfix + infrastructure |

Umbrella ticket covering three related defects discovered while validating the
live-transcription / audio-pipeline path. Split into two implementation streams
(Backend, SDK) dispatched as parallel agents over disjoint file trees.

---

## 1. Requirement Analysis

### 1A — Default live transcription / audio pipeline = "backend"
The platform must default the **live transcription + audio processing** path to
the **backend** (server-side STT-v2 over WebSocket), not browser-side local
models. A freshly seeded environment must have working, production-ready
pipelines on day-1.

**Acceptance**
- Effective default transcription mode resolves to `BACKEND` end-to-end (server
  tenant default + SDK fallback when `transcriptionMode` is absent).
- Seeded default pipeline(s) resolve their models (no placeholder) and are
  enabled per tenant; exactly one default per tenant.
- Playground no longer silently falls back to a cross-tenant SYSTEM pipeline.

### 1B — Production-ready pipelines at day-1
Ensure the seeded catalog gives every customer-facing tenant a small, working
catalog with one resolvable backend default (extend only if a gap exists).

### 2 — SDK local-model "Invalid URL"
Opting into local models throws `TypeError: Invalid URL` from both RNNoise and
the Whisper worker. Local-model audio (noise filter + Whisper worker) must
initialize without URL errors when a consumer opts into `provider: 'local'`.

### 3 — HTTP 400 on `GET /admin/audio/pipelines/:id/versions`
Listing pipeline config-version snapshots returns `400 VALIDATION_ERROR`. The
endpoint must return the version list (newest first), `[]` for a
foreign/missing pipeline, and never a Prisma-validation 400.

---

## 2. Current State Evaluation (root cause, with evidence)

### Issue 2 — `import.meta.url` lost during SDK bundling
Sources are correct (`packages/noise-filter/src/wasmAsset.ts:28`,
`packages/stt/src/engines/WhisperWorkerEngine.ts:176` both use
`new URL(relative, import.meta.url)`), but `@arcaai/vox` bundles `@arcaai/stt` +
`@arcaai/noise-filter` (`tsup.config.ts` `noExternal`/`bundledDependencies`).
esbuild wraps those ESM modules in lazy `__esm()` initializers and **shims
`import.meta` to `{}`**, so in `packages/agentic-sdk-v2/dist/index.mjs`:
- `import_meta2 = {}` → `new URL("../assets/rnnoise.wasm", import_meta2.url)` → `undefined` base
- `import_meta3 = {}` → `new URL("./workers/whisper.worker.mjs", import_meta3.url)` → `undefined` base

`new URL(relative, undefined)` → `TypeError: Invalid URL`. **Second layer:** the
SDK `dist/` has **no `workers/` or `assets/`** dir — those files only exist in
the sub-package dists. Bundling these packages fundamentally breaks asset
resolution. (`@ricky0123/vad-web` + `onnxruntime-web` are already `external` for
the same class of reason.)

**Chosen fix:** externalize `@arcaai/stt` + `@arcaai/noise-filter` (and any
transitive asset-owning deps, e.g. `@arcaai/room` if needed) from the SDK bundle
so they resolve from their own dist where `import.meta.url` + the worker/wasm
assets exist.

### Issue 1 — backend default
- Server tenant default is already correct: `tenant.prisma:60`
  `transcriptionMode TranscriptionMode @default(BACKEND)`.
- SDK default is `local`: `ConfigSchema.ts:40`
  `provider: v.optional(v.picklist(['local','backend','auto']), 'local')` — so
  when the server `transcriptionMode` is absent, the SDK falls back to local
  (which triggered the Issue 2 errors). `TranscriptionPipeline.resolveSTTRuntimeProvider()`
  honors `stt.transcriptionMode` first, then `provider`/`location`, finally
  `sttSocket ? remote : local`.
- Playground footgun: `apps/ui-playground/src/features/audio/constants.ts:1`
  `DEFAULT_TRANSCRIPTION_PIPELINE_ID = '81000000-…-0002'` is a SYSTEM-tenant
  pipeline used as a silent fallback (cross-tenant 404 risk).
- Seed (`seed/06-stt.ts`) already has system + per-tenant catalogs with
  `production-whisper-large-v3` as the resolvable default (TASK-361), and the
  Global tenant `default-stt-pipeline` GlobalSetting → `…0401` (`seed/91-user.ts`).

### Issue 3 — versions 400 is a Prisma-validation error
The bare body `{statusCode:400, error:"Bad Request", correlationId}` (no
`message`) is only produced by the Prisma branches of
`apps/api/src/interceptors/exception.interceptor.ts:87-110`. The controller +
`pipeline.service.listVersions` + `AsrPipelineVersionRepository.findByPipeline`
are all correct (the original `as any`-filter hypothesis was a **red herring** —
the generic filter→`where` builder handles it fine).

**Actual root cause (confirmed by the backend stream):** the **soft-delete
Prisma extension** injects `where: { resourceStatus: { not: 'DELETED' } }` into
every `findMany`, but `AsrPipelineVersion` (TASK-328 A6) is an immutable
config-snapshot history table with **no `resourceStatus` column** and was missing
from `MODELS_WITHOUT_SOFT_DELETE` (`packages/database/src/client.ts`). Prisma
rejected the unknown column → `PrismaClientValidationError` → bare 400. This
affected *all* version reads of that table (`findByPipeline`,
`getNextVersionNumber`), not just the one endpoint. The sibling version tables
(`ContextItemVersion`, `PromptVersion`, `DnaWritingStyleVersion`) were already
exempted — `AsrPipelineVersion` had simply been omitted.

---

## 3. Implementation Plan (TDD; layer order)

### Stream A — Backend (Issue 1 seed/defaults + Issue 3 versions)
Trees: `packages/database`, `packages/domains`, `packages/applications`, `apps/api`.
1. **Issue 3 (RED→GREEN):** reproduce the 400 via a focused repository/service
   test; fix `findByPipeline` (use a valid filter/where or raw query consistent
   with `getNextVersionNumber`, tenant-scope aware); confirm `[]` for
   foreign/missing pipeline. Add/adjust controller e2e if present.
2. **Issue 1 (backend):** verify/ensure tenant `transcriptionMode` default
   `BACKEND` is applied to seeded + existing tenants; confirm the seeded default
   pipelines resolve + are enabled per tenant; ensure exactly one default per
   tenant. Extend the catalog only if a real gap exists.
3. Verify: affected unit tests, seed tests, `apps/api` build, lint.

### Stream B — SDK (Issue 2 URL bug + Issue 1 SDK backend-default)
Trees: `packages/agentic-sdk-v2`, `packages/stt`, `packages/noise-filter`, `apps/ui-playground`.
1. **Issue 2:** externalize `@arcaai/stt` + `@arcaai/noise-filter` from the SDK
   tsup bundle (move out of `noExternal`/`bundledDependencies` into `external`);
   verify `dist/index.mjs` no longer emits `import_meta* = {}` shims for them and
   that worker/wasm resolve from the sub-package dists. Rebuild + add a guard
   test.
2. **Issue 1 (SDK):** make the effective default `backend` — change
   `ConfigSchema` provider default and/or `resolveSTTRuntimeProvider()` final
   fallback so an absent `transcriptionMode` resolves to backend/remote; remove
   the playground silent SYSTEM-pipeline fallback (guard "config loading / not
   configured" instead).
3. Verify: SDK unit tests (ConfigSchema, TranscriptionPipeline), `pnpm build`
   for `@arcaai/vox`, lint; sanity-check the playground.

### Constraints
- TDD (RED before GREEN); surgical changes only.
- No destructive SQL (no DELETE/DROP/TRUNCATE); follow the Prisma migration
  workflow if a schema change is required.
- Do **not** commit or push (await explicit instruction).

---

## 4. Implementation Summary

### Issue 3 — versions 400 (Backend stream)
- **`packages/database/src/client.ts`** — added `'AsrPipelineVersion'` to
  `MODELS_WITHOUT_SOFT_DELETE`, alongside the sibling `*Version` tables. The
  soft-delete extension no longer injects `resourceStatus` into reads of this
  column-less table → no more `PrismaClientValidationError` → endpoint returns
  the snapshot list (newest-first) and `[]` for a foreign/missing pipeline.
- **`packages/database/src/__tests__/soft-delete-extension.test.ts`** — RED→GREEN
  regression test: `modelHasSoftDelete('AsrPipelineVersion')===false` and the
  `findMany` handler injects no `resourceStatus` for it.
- The controller / service / repository were left untouched (correct as-is).

### Issue 1 — backend default + day-1 pipelines
- **Backend: no code changes — already correct.** Verified the full `BACKEND`
  default chain (`tenant.prisma` `@default(BACKEND)`, the TASK-356 migration
  backfilling existing `TenantFrontendConfig` rows NOT NULL DEFAULT 'BACKEND',
  factory default, and `userPreferences.service.resolveEffectiveTranscriptionMode`
  falling back to `BACKEND` when a tenant has no config row), plus the seed
  invariants (one resolvable `production-whisper-large-v3` default per tenant, no
  `MODEL_REPO_PLACEHOLDER` in any default, pipelines ENABLED, Global
  `default-stt-pipeline` → `…0401`) — all covered by existing passing tests.
- **SDK: made backend the effective default.**
  - `packages/agentic-sdk-v2/src/core/ConfigSchema.ts` — `stt.provider` default
    `'local' → 'backend'`.
  - `packages/agentic-sdk-v2/src/core/TranscriptionPipeline.ts` —
    `resolveSTTRuntimeProvider()` final fallback is now `streamingTransport`-aware
    (`sttSocket || streamingTransport ? 'remote' : 'local'`). This was the real
    "dragged into local" cause: the backend workflow injects a `streamingTransport`
    (its own WS) but no `sttSocket`, so the old `sttSocket`-only check resolved
    backend consumers to local when the server left `transcriptionMode` absent.
    Explicit `provider:'local'` / `location:'browser'` / `transcriptionMode:'LOCAL'`
    opt-ins still short-circuit; a truly-empty no-backend config stays `local`.
  - Tests added/updated in `ConfigSchema.test.ts` + `TranscriptionPipeline.test.ts`.
- **Playground footgun removed** — deleted the silent SYSTEM-tenant
  `DEFAULT_TRANSCRIPTION_PIPELINE_ID` fallback (cross-tenant 404 risk) and replaced
  it with explicit "pipeline not configured / select a pipeline" guards
  (`toast.error`) in `transcript-panel.tsx`, `batch.tsx`, and
  `consultation-recording-panel.tsx` (+ test update).

### Issue 2 — SDK local-model "Invalid URL" (SDK stream)
- **`packages/agentic-sdk-v2/tsup.config.ts`** — externalized `@arcaai/stt` +
  `@arcaai/noise-filter` (moved out of `noExternal`/`bundledDependencies` into
  `external` for the `index`, `plugins`, `e2e-bundle` builds). They now load as
  their own ESM modules where `import.meta.url` is preserved and the worker/wasm
  assets live; `@arcaai/room` stays bundled (no `import.meta.url` asset
  resolution). Both remain in `package.json` `dependencies`.
- Result: the `import_meta2/3 = {}` shims + inlined `new URL(rel, undefined)`
  patterns are gone; the bundle now `import('@arcaai/stt')` /
  `import('@arcaai/noise-filter')` dynamically. `index.mjs` 2.67 MB → 644 KB.
- **`packages/agentic-sdk-v2/src/__tests__/bundle-externals.task364.test.ts`** —
  new guard test asserting the built ESM entries don't inline the wasm/worker URL
  resolution and keep both packages as dynamic imports.

### Verification evidence
- Backend: `pnpm build:api` 8/8 green; `@arcaai/database` 442/442 (soft-delete +
  seed); `@arcaai/domains` 1197 passed; `@arcaai/applications` 5227 passed; lint
  clean on edited files.
- SDK: `@arcaai/vox` 3379 tests passed + `build` success (dist `import_meta` check
  clean); `@arcaai/ui-playground` 1345 tests passed; lint 0 errors (pre-existing
  warnings only).
- Combined working tree: 13 modified + 2 untracked files; backend and SDK trees
  are disjoint (no conflicts). Changes left **uncommitted** per instructions.

### Follow-up (2026-06-17) — Global still resolved to LOCAL + `whisper-large-v3` 401

After the TASK-364 SDK default flip, impersonating a **Global-tenant doctor**
*still* ran the local pipeline and failed with
`Unauthorized access … huggingface.co/whisper-large-v3/…/config.json` →
`PROVIDER_INIT_FAILED`. Two **data + default** causes the code-only fix did not
cover:

1. **Effective mode is data-driven, not code-driven.** The Global tenant's
   `TenantFrontendConfig` was `BACKEND` but **unlocked**, and the seeded Global
   doctors had `workflowMode='local'`. Per
   `userPreferences.service.resolveEffectiveTranscriptionMode`, an *unlocked*
   tenant lets the user's `workflowMode` win → `LOCAL`. The SDK `provider`
   default never applied because the resolved server `transcriptionMode` was
   present (`LOCAL`).
2. **`whisper-large-v3` is not browser-loadable.** It is neither a recognized
   Whisper size nor a namespaced repo, so `LocalSTTProvider` forwarded it
   verbatim → the worker requested `huggingface.co/whisper-large-v3` (401). Even
   the namespaced `onnx-community/whisper-large-v3` is **gated (HTTP 401)** —
   verified via the HF API; `onnx-community/whisper-{tiny,base,small}` +
   `_timestamped` variants return 200. Browser-loadable Whisper = `tiny/base/small`.

**Fix (chosen: C — lock + seed remote default; and make local loadable):**
- **Lock Global → BACKEND.** `seed/05-tenant.ts` Global `TenantFrontendConfig`
  → `transcriptionMode: BACKEND` + `transcriptionModeLocked: true` (other tenants
  stay unlocked; local stays opt-in). Live DB synced via `UPDATE` (1 row).
- **Remote as the sane default.** `seed/91-user.ts` all seeded `workflowMode`
  `'local' → 'remote'` (11 rows; per-user `localConfig` retained so local is a
  working opt-in); SDK `DEFAULT_PERSONALIZATION_CONFIG.defaults.workflowMode`
  `'local' → 'remote'`. Live DB synced (11 rows).
- **Make local loadable (defense-in-depth).** New `resolveLocalWhisperModel()`
  (`packages/stt/src/types/index.ts`): browser-viable size → use it; namespaced
  HF repo → trust as `modelPath`; anything else (e.g. `whisper-large-v3`, or
  `medium`/`large`) → fall back to `base` + `console.warn`, **never** a
  bare/gated repo. Wired into `LocalSTTProvider.init`. SDK
  `DEFAULT_LOCAL_CONFIG.stt.modelId` + seeded `localConfig.stt.modelId`
  `'whisper-large-v3' → 'whisper-base'` (live DB synced, 2 rows).

**Verification:** `@arcaai/stt` build + 406 tests (incl. `resolveLocalWhisperModel`
RED→GREEN, 5 new); `@arcaai/vox` build + 70 affected tests (PersonalizationManager,
config.task225, AgenticProvider.transcriptionMode.task356); `@arcaai/database`
`tsc` build + seed 327 tests; lint clean on all edited files. Live DB verified:
`global_locked=true`, 0 `workflowMode='local'` remaining (18 remote), 0
`localConfig` with `whisper-large-v3`. Rebuilt `@arcaai/stt` + `@arcaai/vox` dist
(consumed by the playground). Changes left **uncommitted** per instructions.

## 5. Change History
| Date | Change | Files |
|---|---|---|
| 2026-06-16 | Ticket opened; root-caused all three issues with file:line evidence; chose externalization for Issue 2; dispatched Backend + SDK streams. | _(docs only)_ |
| 2026-06-17 | **Implemented all three (TDD, parallel streams).** Issue 3: soft-delete exemption for `AsrPipelineVersion` (root cause was the extension, NOT the `as any` filter — corrected §2). Issue 1: SDK default `local→backend` + `streamingTransport`-aware resolver + playground guard; backend default chain verified already-correct. Issue 2: externalized stt + noise-filter from the vox bundle. All verified; left uncommitted. | `client.ts`, `soft-delete-extension.test.ts`, `agentic-sdk-v2/{tsup.config.ts,core/ConfigSchema.ts,core/TranscriptionPipeline.ts,+tests,__tests__/bundle-externals.task364.test.ts}`, `ui-playground/.../audio/{constants.ts,batch.tsx,components/transcript-panel.tsx}`, `ui-playground/.../consultation/components/consultation-recording-panel.tsx` (+test) |
| 2026-06-17 | **Follow-up:** Global tenant still resolved to LOCAL (unlocked `TenantFrontendConfig` + seeded `workflowMode='local'`) and `whisper-large-v3` is browser-ungated/non-loadable (401, verified via HF API). Chose **lock Global + seed remote default + make local loadable**: new `resolveLocalWhisperModel()` guard (browser-viable size / namespaced repo / safe `base` fallback), SDK defaults `workflowMode local→remote` + local model `whisper-large-v3→whisper-base`, seed lock + workflowMode flips + model fix, and synced the running DB (1 lock + 11 workflowMode + 2 localConfig `UPDATE`s). Rebuilt stt + vox dist. Verified (stt 406, vox 70, database 327, lint clean); uncommitted. | `stt/src/types/index.ts` (`resolveLocalWhisperModel`, `DEFAULT_LOCAL_WHISPER_SIZE`), `stt/src/providers/LocalSTTProvider.ts`, `stt/src/__tests__/types.test.ts`, `agentic-sdk-v2/src/types/config.ts`, `database/.../seed/05-tenant.ts`, `database/.../seed/91-user.ts`; live DB `UPDATE`s (non-destructive) |
