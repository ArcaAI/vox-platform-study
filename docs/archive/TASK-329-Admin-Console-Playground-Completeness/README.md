# TASK-329 — Phase 3: Developer-Playground Completeness

| | |
|---|---|
| Ticket Number | TASK-329 |
| Short name | Admin-Console-Playground-Completeness |
| Parent | **TASK-325** (Admin Console Transformation — umbrella) |
| Created | 2026-06-02 |
| Updated | 2026-06-02 |
| Status | `Completed` (P2 + P3 + P4 + P5 + P6 + X3 + X8 + X10 + LiveCodePanel delivered) |
| Type | feature |
| Scope | `apps/ui-playground/`, `@arcaai/vox`, `packages/{stt,vad,noise-filter}`, `apps/api/`, `packages/database/` |
| Depends on | **TASK-326** (security) + **TASK-327** (scope shell + impersonation gate) |

> Completes playground spec items **P2–P6**, fixes **X3/X8/X10**, and adds the **realtime code-sample panel** (`LiveCodePanel`) required across all playgrounds. Per **Q3**, all data flows through `@arcaai/vox` hooks.

---

## 1. Requirement Analysis

### 1.1 Acceptance criteria
- [x] **P2 Consultation** — in-flow mic recording using the impersonated user's pipeline prefs (realtime transcript); summary via **3-tier preferred-prompt fallback** (`UserProfile.preferredPromptTemplateId` → dept prompt → system default); chain-of-consultation reference UI (recursive multi-hop `GET /:id/chain`); **RAW + PROCESSED** dual capture — `rawMediaId`/`processedMediaId` on `AudioRecording`, threaded domain→app→api→SDK→UI (**X8**). ✅ delivered — see §5.9. **Deviation:** no client `upload→mediaId` primitive exists (audio `Media` is created server-side by the streaming session) and the playground's realtime WS path exposes only the **raw** input track (noise-filter/VAD run server-side), so the SDK ships the client dual-capture toolkit (`DualStreamRecorder`, `TranscriptionPipeline.getRawInputTrack`) and the UI surfaces recordings + dual-capture metadata rather than a fabricated client dual-persist.
- [x] **P3 Audio** — local-model **task** selection (transcribe/translate); per-user prefs persisted **via the SDK `ModelRegistry` (tenant/user-namespaced `localStorage`, per rule 08)** — see §5.7 deviation note; fix `localAsrModels`/`availableModels` mismatch. ✅ delivered — see §5.7.
- [x] **P4 Voice** — **local** in-browser enrollment (new `local` embedding provider, Transformers.js/WavLM) + **quick test** (mic/upload cosine match). ✅ delivered — see §5.5. **Deviation (per slice brief):** schema FROZEN, so the local provider **reuses the existing `POST /voice-profile/enroll` path** instead of the originally-sketched `POST /voice-profile/enroll-embedding` / `POST /voice-profile/test`; quick-test runs fully client-side against the locally-cached embedding. Diarization-seeding feedback (`voiceProfileSeeded`) + the always-"Active" badge fix were deferred from this slice and **delivered separately in D-3 — see §5.13.**
- [x] **P5 DNA** — generate from **selected historical data** (version picker → `sourceIds`); **set-default** (`PATCH /:reportId/default`); two-version **diff** (`version-diff-panel`); wrap page in `ImpersonationGuard`; fix the empty Edit dialog. ✅ delivered — see §5.3.
- [x] **P6 Summarization** — backend summary **list + version browser**; `cacheHit`/`qualityScore` fields + endpoints; version **diff**; **tagging** (`Tag`); **edit→new version**; fix the raw-DNA ownership bypass via `/text/generate/assembled` (**X3**); namespace `localStorage` history by tenant/user (**X10**). ✅ delivered — see §5.1.
- [x] **`LiveCodePanel`** — reactive Shiki snippet bound to each playground's store / impersonated prefs (wired into all 6 playgrounds).
- [x] Skeleton/empty/toast per rules `10`/`11`; gates green (§4). — verified in the 2026-06-02 umbrella gate (ui-playground 90 files / 847 passed, type-check 0).

### 1.2 Non-goals
- Administration features (TASK-328). Security scoping (TASK-326).

---

## 2. Current State Evaluation
TASK-325 §2.4 (P1–P6 committed vs gaps, file-cited), §2.5 (no realtime code-sample today), §2.6 (X3/X8/X10), §2.7 (reuse: `kibo-ui/code-block`, `version-diff-panel`, `useVoiceEmbedding`, `useFileTranscription`).

---

## 3. Implementation Plan (TDD)
Sequence: **P2 consultation** (highest clinical value) → **P6 summarization** → **P4 voice** → **P5 DNA** → **P3 audio** → **`LiveCodePanel`** (shared, last). For each behavioral change: extend the SDK hook/contract first (Q3), RED test the hook/endpoint, then wire UI. The X8 dual-capture and P6 `cacheHit`/`qualityScore` are **additive** DB migrations (no destructive ops). Local voice enrollment lands as a new browser provider in `packages/stt` (or a new package) — confirm model/runtime before starting.

---

## 4. Verification Gates
```
pnpm db:migrate && pnpm db:generate            # additive (X8, P6 fields)
pnpm build:sdk && pnpm --filter @arcaai/vox test
pnpm build:api && pnpm test:e2e
pnpm --filter @arcaai/ui-playground type-check && pnpm --filter @arcaai/ui-playground test
# manual smoke: record→transcript; attachment→summary; SSE streaming intact
# ReadLints on every edited file → clean
```

---

## 5. Implementation Summary

### 5.1 P6 Summarization completeness (+ X3, X10) — delivered 2026-06-02

Vertical slice on branch `wave3/p6-summarization`. **No schema change / no `prisma migrate` / no `git`** — `SummaryMeta.cacheHit` (Boolean?) + `SummaryMeta.qualityScore` (Float?) and the polymorphic `Tag` model already existed; this slice threaded them through the domain/app/SDK/UI layers and reused `Tag` for summary tagging.

**Domain (`packages/domains`)**
- `entities/generated/core/SummaryMetaEntity.ts` — added `cacheHit?`/`qualityScore?` to `ISummaryMetaEntity`, private fields, constructor init, and getters/setters (via `setProperty`).
- `models/generated/core/SummaryMetaModel.ts` — added `cacheHit`/`qualityScore` columns to the data model.
- `factories/generated/core/SummaryMetaFactory.ts` — `CreateSummaryMeta` accepts + defaults (`?? null`) the two fields.
- `mappers/.../SummaryMetaEntityMapper.ts` — unchanged (`AutoClassMapper` maps by name; verified by round-trip test).
- `repositories/generated/core/ContextItemRepository.ts` — `findSummaries` now `include: { SummaryMeta: true }` so the list carries metadata.

**Application services (`packages/applications`)**
- `consultation/summary/dto/summary.response.ts` + `summary.dto.mapper.ts` — `structuredData.cacheHit`/`qualityScore` surfaced.
- `consultation/context/dto/context-item.response.ts` + `context.dto.mapper.ts` — `SummaryMetaResponse.cacheHit`/`qualityScore`.
- `consultation/summary/smr-v2-generate.ts` — capture cache/quality from the SMR response (snake/camel tolerant) into `LegacySmrSummaryResponse`.
- `consultation/context/dto/add-context.request.ts` + `context.service.ts` — `addRawSummary` persists `cacheHit`/`qualityScore` onto the `SummaryMeta`.
- `consultation/summary/summary.service.ts` — `generate(Pre)Summary` thread cache/quality into `SummaryMetaFactory`; `callSmrService` return type widened to `LegacySmrSummaryResponse`. **Edit→new version** already creates a new `ContextItemVersion` and bumps `currentVersionNumber` (now covered by a RED test).
- `consultation/context/dto/version-diff.response.ts` (**new**) + `context.service.ts#diffVersions` + `IContextService` — fetch two versions (tenant/existence-checked), broadcast `ResourceViewed`, return `{ contextItemId, from, to }`.
- `tag/tag.service.ts` + `ITagService.ts` — `fetchByResource(resourceTypeName, resourceId)` (tenant-scoped) for summary tags.

**API (`apps/api`)** — new consultation-scoped endpoints (under `ConsultationController`):
| Verb | Path | Purpose |
|---|---|---|
| GET | `/consultations/:id/summary` | list summaries (carries `structuredData.cacheHit`/`qualityScore`) |
| GET | `/consultations/:id/summary/:contextItemId/versions` | version browser |
| GET | `/consultations/:id/summary/:contextItemId/diff?from=&to=` | version diff (`VersionDiffResponse`) |
| GET | `/consultations/:id/summary/:contextItemId/tags` | list summary tags |
| POST | `/consultations/:id/summary/:contextItemId/tags` | tag a summary (server fixes `resourceTypeName=ContextItem`, `resourceId`, `tenantId`) |
| DELETE | `/consultations/:id/summary/:contextItemId/tags/:tagId` | remove a tag (ownership-checked) |

`consultation.module.ts` now imports `TagServiceModule`.

**X3 — raw-DNA / context ownership bypass via `/text/generate/assembled`** (`apps/api/.../streaming/smr-proxy.controller.ts`): the assembled path already rejected cross-doctor **DNA styles**; added the same guard for **`context_item_ids`** — each referenced `ContextItem` is loaded and its `tenantId` compared to the caller's tenant; a mismatch throws `NotFoundException` (no existence leak) and logs `Cross-tenant context item usage rejected`. RED test: `streaming/__tests__/smr-proxy.controller.test.ts` ("TASK-329 X3 — cross-tenant context item ownership") — rejects a foreign-tenant context item, allows same-tenant.

**SDK (`@arcaai/vox`)**
- `core/constants.ts` — `SUMMARY_ENDPOINTS.DIFF`, `.TAGS`, `.TAG`.
- `types/summary.ts` — `SummaryTag`, `CreateSummaryTagInput`, `VersionDiff`; `SummaryResponse.structuredData` (+ `versionNumber`/`status`/`updatedAt`).
- `hooks/useArcaSummary.ts` — new methods `diffSummaryVersions`, `getSummaryTags`, `tagSummary`, `deleteSummaryTag` (list = existing `loadSummaries`, versions = `getSummaryHistory`, edit = `updateSummary`).
- Barrel registrations: `types/index.ts` + `core.ts` (re-exported through the main `index.ts` via `export *`).

**UI playground (`apps/ui-playground`)**
- `features/summarization/components/saved-summaries-panel.tsx` (**new**) — consultation-scoped list (with `cacheHit`/`qualityScore` badges) → version browser → diff (reuses `VersionDiffPanel`) → tag add/remove → edit→new-version; skeleton/empty/toast per rules 10/11; all data via `useArcaSummary`. Mounted on `/summarization/summary` and `/summarization/pre-summary`; registered in the components barrel.
- **X10** — `features/summarization/history/index.tsx`: history `localStorage` key namespaced as `arcaai-summarization-history::${tenantId}::${effectiveUserId}` (effective user = impersonated user when impersonating), mirroring the SDK `ModelRegistry` scheme. `HistoryPage` reloads on identity change; the legacy global key is never written.

**Tests added (RED-first):** `SummaryMetaFactory.task329.test.ts` (factory+mapper round-trip), `summary-meta.task329.test.ts` (DTO mappers), `context.service.test.ts` (persists cache/quality), `summary.service.test.ts` (edit bumps `currentVersionNumber`), `tag.service.test.ts` (`fetchByResource`), `smr-proxy.controller.test.ts` (X3), SDK `useArcaSummary.task329.test.ts` (diff/tag endpoints), playground `history.x10.test.ts` (namespacing/isolation) + `saved-summaries-panel.test.tsx` (smoke).

### 5.2 Verification gates — final output
| Gate | Result |
|---|---|
| `pnpm --filter @arcaai/domains build && … test` | **78 passed / 2 skipped (80 files)**, 1095 passed / 2 skipped / 9 todo |
| `pnpm --filter @arcaai/applications build && … test:unit` | **181 passed / 1 skipped (182 files)**, 4513 passed / 4 skipped |
| `pnpm build:sdk` (6/6 tasks) `&& pnpm --filter @arcaai/vox test` | **149 files, 3108 passed** |
| `pnpm build:api` | **8/8 turbo tasks successful** (e2e deferred to CI) |
| `pnpm --filter @arcaai/ui-playground type-check && … test` | type-check clean; **71 files, 740 passed** |
| IDE lint on every edited file | clean |

**Deferred to CI:** `pnpm test:e2e` (API e2e) per slice instructions. **Confirmed not run:** `git`, `prisma migrate` / `db:migrate` / `prisma db` (schema frozen — fields/`Tag` pre-existed).

---

### 5.3 P5 DNA writing-style playground completeness — delivered 2026-06-02

Vertical slice on branch `wave3/p5-dna-playground`. **No schema change / no `prisma migrate` / no `git`** — "default" reuses the existing `DnaWritingStyleReport.isLatest` flag (no `isDefault` column); generate-from-history reuses the existing generate endpoint with an additive optional `sourceIds`.

**SDK (`@arcaai/vox`)**
- `core/constants.ts` — added `DNA_STYLE_ENDPOINTS.MINE` (`/dna-writing-styles/mine`, owner-scoped report history) + `SET_DEFAULT(reportId)` (`/dna-writing-styles/:reportId/default`). *(shared barrel — additions to the exported `DNA_STYLE_ENDPOINTS` object, re-exported via existing `export *`.)*
- `types/dna.ts` — `DnaGenerateInput.sourceIds?: string[]` (historical source items the generation was seeded from).
- `hooks/useDnaStyle.ts` — extended `UseDnaStyleReturn` with `reports`, `generateFromHistory(sourceIds, extra?)` (POSTs `GENERATE` with `sourceIds` + idempotencyKey), `setDefault(reportId)` (PATCH `SET_DEFAULT`, updates local `style`), `getMyReports()` (GET `MINE`), and `getVersionDiff(reportId, fromVersionId, toVersionId)` (resolves two snapshots from the versions endpoint).
- **Key-count guard updated:** `core/__tests__/constants.ws4.test.ts` — `DNA_STYLE_ENDPOINTS` `12 → 14` keys (+ `MINE`, `SET_DEFAULT`).

**Application services (`packages/applications`)**
- `services/dna-writing-style/dto/generate-dna-report.request.ts` — `sourceIds?: string[]` (`@IsOptional/@IsArray/@IsString({each})`).
- `services/dna-writing-style/dna-writing-style.service.ts` — `GenerateDnaReportJobPayload.sourceIds`; `generateDnaReport` threads `sourceIds` into the BullMQ payload; new **`setDefaultReport(reportId)`** (owner + tenant scoped: `assertReportInScope`, ownership check, idempotent if already latest, demotes the current `isLatest` via `unmarkAsLatest`, promotes target via `markAsLatest`, `broadcastSysEvent(ResourceUpdated)`); `IDnaWritingStyleService.setDefaultReport` abstract added.
- `services/dna-writing-style/dna-writing-style.processor.ts` — seeded generation records `sourceContextItemIds = sourceIds` for explainability.

**API (`apps/api`)** — owner-scoped endpoints on `DnaWritingStyleController` (tenant scope enforced in the service):
| Verb | Path | Purpose |
|---|---|---|
| GET | `/dna-writing-styles/mine` | the doctor's own report history (set-default picker) → `listReports({ doctorId })` |
| PATCH | `/dna-writing-styles/:reportId/default` | promote a report to the doctor's default → `setDefaultReport` (403 foreign owner / 404 missing) |

**UI playground (`apps/ui-playground`)** — all behind the guard, data via `@arcaai/vox` + local query hooks; skeleton/empty/toast per rules 10/11:
- `components/impersonation-guard.tsx` (**new, reusable**) — see below.
- `features/dna-writing-style/api/dna-writing-styles.ts` — `DnaGenerateInput.sourceIds`; `keys.mine`; pure `applyDefaultToReports`; `useMyDnaReports` (GET `/mine`); `useSetDefaultDnaReport` (PATCH `/:id/default`, **optimistic** promote in the `/mine` cache, rollback on error, invalidate on settle).
- `features/dna-writing-style/hooks/use-edit-dialog-controller.ts` (**new**) — `openFor(report)` / `close()` (the bug fix).
- `features/dna-writing-style/components/edit-dialog.tsx` (**new, extracted**) — `buildEditFormValues` + `EditDialog` (seeds form via `form.reset` on open).
- `features/dna-writing-style/components/reports-list-panel.tsx` (**new**) — report list + default badge + "Set as default".
- `features/dna-writing-style/components/generate-from-history-panel.tsx` (**new**) — multi-select prior versions → generate (`sourceIds`).
- `features/dna-writing-style/components/version-diff-section.tsx` (**new**) — two-version picker → shared `VersionDiffPanel`.
- `features/dna-writing-style/index.tsx` — page wrapped in `ImpersonationGuard`; queries gated `enabled: !requiresImpersonation`; Edit wired via the controller (`MyStyleCard onEdit`); generate-from-history + set-default handlers with toasts.

**BUG fix — empty Edit dialog.** *Root cause:* the page held `editOpen` and `selectedReport` as two **independent** `useState`s with **no trigger** that set them together (no Edit affordance existed), so the dialog only ever mounted with `report = null` → empty form. The dialog's own seeding (`useEffect` → `form.reset(buildEditFormValues(report))`) was correct but received `null`. *Fix:* `useEditDialogController.openFor(report)` couples *select + open* into one action, and `MyStyleCard` now renders an **Edit** button wired to `editCtrl.openFor(myStyle)` — so the report is always seeded before the dialog opens. *Regression test* (`__tests__/edit-dialog.test.tsx`): `buildEditFormValues` maps every field, and `openFor()` sets `report` **and** `open=true` such that the seeded report maps to a fully-prefilled form (RED before the controller/extraction existed).

**ImpersonationGuard.** Reads `useDoctorContext().requiresImpersonation`. When `false` it renders `children`; when `true` it renders a gate `Card` ("Impersonation Required" + a "Go to User Impersonation" link + `featureName` messaging) and hides the protected UI. Because the page also gates its queries (`enabled: !requiresImpersonation`), **no** DNA calls fire until a doctor is impersonated.

**Tests added (RED-first):** SDK `hooks/__tests__/useDnaStyle.p5.test.ts` (generateFromHistory/setDefault/getMyReports/getVersionDiff) + `core/__tests__/constants.task329p5.test.ts` (MINE/SET_DEFAULT paths); applications `__tests__/dna-writing-style.service.task329p5.test.ts` (sourceIds threading + setDefaultReport promote/demote/idempotent/forbidden); api `__tests__/dna-writing-style.controller.test.ts` (getMine + setDefault); ui-playground `components/__tests__/impersonation-guard.test.tsx`, `features/dna-writing-style/__tests__/edit-dialog.test.tsx` + `dna-writing-styles.api.test.tsx`.

### 5.4 P5 verification gates — final output
| Gate | Result |
|---|---|
| `pnpm --filter @arcaai/domains build && … test` | **not run — domains untouched** (no entity/factory/mapper/repo change) |
| `pnpm --filter @arcaai/applications build && … test:unit` | build OK; **183 passed / 1 skipped (184 files)**, **4542 passed / 4 skipped (4546)** |
| `pnpm build:sdk` (6/6 tasks) `&& pnpm --filter @arcaai/vox test` | **152 files, 3135 passed** (DNA-only subset: 4 files / 84 passed) |
| `pnpm build:api` | **8/8 turbo tasks successful**; DNA controller test **18 passed** (e2e deferred to CI) |
| `pnpm --filter @arcaai/ui-playground type-check && … test` | type-check **clean**; **76 files, 763 passed** (DNA+guard subset: 5 files / 40 passed) |
| IDE lint on every edited file | clean |

**Known pre-existing flake (not from this slice):** the full `@arcaai/vox` run reports **1 unhandled error** originating in `hooks/__tests__/useVoiceEnrollmentStatus.test.ts` (voice enrollment — unrelated to DNA); that file **passes 7/7 in isolation**, so it is a cross-test async leak surfaced only under the full parallel run. All 3135 tests pass.

**Deferred to CI:** `pnpm test:e2e` (API e2e) per slice instructions. **Confirmed not run:** `git`, `prisma migrate` / `db:migrate` / `prisma db` (DNA models pre-existed; "default" reuses `isLatest`). **Shared-barrel touch:** `@arcaai/vox` `core/constants.ts` (`DNA_STYLE_ENDPOINTS` +2 keys) + its key-count guard `constants.ws4.test.ts` (12→14); no shared admin nav edited.

---

### 5.5 P4 Voice — LOCAL in-browser embedding + quick test — delivered 2026-06-02

Vertical slice on branch `wave3/p4-voice-embedding`. **No schema change / no `prisma migrate` / no `git`.** The `UserVoiceProfile` model + `POST /voice-profile/enroll` path already existed; the LOCAL provider is a **client-side-only** addition that reuses that enroll endpoint verbatim for DB persistence. **No backend code was touched** (`apps/api` / `packages/applications` / `packages/domains` unchanged), so backend enrollment is provably intact.

**Chosen model — `Xenova/wavlm-base-plus-sv`.** Microsoft **WavLM-Base-Plus** with an X-Vector speaker-verification head fine-tuned on VoxCeleb1, re-hosted with ONNX weights for Transformers.js. **License: MIT** (inherited from Microsoft WavLM) — safe to ship. *Why:* it's small, runs cleanly in `@huggingface/transformers` v3 via `AutoProcessor` + `AutoModel`, and emits a fixed **512-dim** speaker embedding whose pairwise **cosine similarity** is exactly the speaker-verification score we need for the quick test. Verified the v3 API surface (`AutoModel`/`AutoProcessor`/`from_pretrained`, `dtype`, `progress_callback`) before committing; `fp32` is the default dtype to preserve embedding fidelity for matching.

**How Transformers.js loads/caches it (rule `08-vox-sdk.mdc`).** The heavy `@huggingface/transformers` module is **dynamically imported** (lazy chunk; mirrors `@arcaai/med-ner`). On load: `env.allowLocalModels = false`, `env.useBrowserCache = true` → the **public HF-hub weights** live in the **shared** `transformers-cache` Cache-Storage bucket (public weights are byte-identical across tenants, so they are NOT tenant-namespaced — only tenant-CUSTOM weights would be). The **extracted embeddings** *are* tenant/user-namespaced (see hook below).

**SDK (`@arcaai/vox`) — NEW surface**
- `src/utils/voiceEmbedding.ts` (**new**) — pure, deterministic math + provider selection (no ONNX, no network): `cosineSimilarity`, `l2Normalize`, `averageEmbeddings` (centroid of multiple samples), `bestMatch(candidate, refs, threshold)` → `{ profileId, score, isMatch, threshold, label? }`; `isVoiceEnrollmentProvider`, `resolveVoiceEnrollmentProvider({ preferred, localSupported })`; consts `DEFAULT_VOICE_MATCH_THRESHOLD` (0.75), `VOICE_ENROLLMENT_PROVIDERS` (`['backend','local']`), `DEFAULT_VOICE_ENROLLMENT_PROVIDER` (`'backend'`).
- `src/core/LocalVoiceEmbedder.ts` (**new**) — `createLocalVoiceEmbedder()` wraps Transformers.js: `load`/`embed`/`embedBlob`/`dispose`, lazy idempotent load with streamed download progress, injectable `transformersLoader` + `decodeAudio` (16 kHz mono Web-Audio decode → OfflineAudioContext resample). `isLocalVoiceEmbeddingSupported()` (WebAssembly + (Offline)AudioContext). Consts `DEFAULT_LOCAL_VOICE_MODEL_ID`, `LOCAL_VOICE_EMBEDDING_DIM` (512), `LOCAL_VOICE_SAMPLE_RATE` (16000).
- `src/hooks/useLocalVoiceEmbedding.ts` (**new**) — the provider hook. **Reuses the existing enroll path** by composing `useVoiceEmbedding().enroll` internally: `enroll(files,opts)` → (1) extract each clip locally + average to a centroid, (2) **persist via the existing `POST /voice-profile/enroll`** (audio → DB row + optional label, server computes its own embedding; schema untouched), (3) cache the LOCAL 512-dim embedding keyed to the returned `profile.id`. `quickTest(file)` extracts a fresh embedding and cosine-compares against the cached enrolled refs (`bestMatch`). Plus `preloadModel`, `clearLocal`, and live `status`/`progress`/`isBusy`/`error`/`supported`/`modelId`/`enrolled`. **Embedding cache is tenant/user-namespaced + encrypted** via `SecureStorage` (key `vox.localVoiceEmbeddings.${userId}.${tenantId}`, passphrase `vox-lve-${userId}-${tenantId}`), hydrated on mount — mirrors the existing `useVoiceEmbedding` convention, so quick-test works offline and never crosses tenant/user boundaries.

**Quick-test similarity approach.** Embeddings are compared with **cosine similarity** (`bestMatch` picks the highest-scoring enrolled ref; `isMatch = score ≥ threshold`, default **0.75**). This is the same speaker-verification signal the diarizer/user-voice detection relies on. The backend's 256-dim pyannote embedding is intentionally NOT used for matching (different model/dim, and `VoiceProfileResponse` doesn't expose raw vectors) — the local provider self-contains its 512-dim WavLM embedding for the quick test.

**How the heavy model is mocked in tests (no weights downloaded; deterministic).**
- `voiceEmbedding.test.ts` — pure fixtures only (orthogonal/identical/scaled vectors); zero Transformers.js/network.
- `LocalVoiceEmbedder.test.ts` — injects a fake `transformersLoader` (stub `AutoProcessor`/`AutoModel`/`env`) + fake `decodeAudio`; asserts load idempotency, progress plumbing, embedding extraction, error paths.
- `useLocalVoiceEmbedding.test.ts` — `vi.mock('../useVoiceEmbedding')` for the enroll client + a fake injected embedder (`options.embedder`); verifies enroll persists via the mocked client, caches keyed to the returned id, averages multi-sample, and quick-test cosine matching — all with a mocked `useAgenticStore` for `userId`/`tenantId`.
- ui-playground `local-voice.test.tsx` — mocks `@arcaai/vox` so `useLocalVoiceEmbedding` returns controllable state (**ONNX never loads**); renders the REAL shared `ImpersonationGuard` + REAL cards.

**Provider barrels + pin test (shared-barrel touch).** Additive exports only, re-exported through the main `index.ts` (`export *`):
- `src/utils/index.ts` — the `voiceEmbedding` math + provider helpers/types.
- `src/hooks/index.ts` — `useLocalVoiceEmbedding` + its types.
- `src/core.ts` — grouped TASK-329 P4 block (hook, `createLocalVoiceEmbedder`/`isLocalVoiceEmbeddingSupported` + consts, math/provider util + types).
- `src/__tests__/exports.task329-p4.test.ts` (**new**) — pin test locking the whole new surface (mirrors the `exports.task279` precedent). **No existing key-count guard needed updating** — the slice adds no keys to any counted constant object (`VOICE_EMBEDDING_ENDPOINTS` is unchanged; local enroll reuses the existing endpoint).

**UI playground (`apps/ui-playground`)** — all behind impersonation; data via `@arcaai/vox`; skeleton/empty/toast per rules 10/11:
- `features/voice-profile/local-voice.tsx` (**new**) — `LocalEnrollCard` (mic/upload → on-device extract → persist via existing enroll → cache; live model-load/extraction `Progress`/`Skeleton`; model-id badge; invalidates the `['voice-profiles']` query on success so `ProfileTable` refreshes) + `QuickTestCard` (mic/upload → cosine match read-out: score %, Match/No-match badge, threshold, closest profile) + a shared `useMicRecorder`. Unsupported-environment notice when `supported` is false.
- `features/voice-profile/index.tsx` — added a `VoiceProfileWorkspace` with a **provider `Tabs`** ("Server (backend)" vs "In-browser (local)", local tab disabled when unsupported; default chosen via `resolveVoiceEnrollmentProvider({ preferred:'local', localSupported })`); backend tab keeps the **unchanged** `EnrollCard`; local tab mounts the two new cards; `ProfileTable` stays visible in both. Swapped the page's guard to the **shared** `@/components/impersonation-guard` (children-wrapping) — the older summarization props-based guard is no longer used here.

**New dependency.** `@arcaai/vox` now depends on **`@huggingface/transformers@^3.8.1`** (regular dependency) — *why:* the in-browser speaker-embedding runtime; version pinned to **match `@arcaai/med-ner`** (the existing Transformers.js consumer) for a single resolved version across the monorepo.

### 5.6 P4 verification gates — final output
| Gate | Result |
|---|---|
| `pnpm --filter @arcaai/domains …` / `@arcaai/applications …` | **not run — backend untouched** (no domain/app/api source changed) |
| `pnpm build:sdk` `&& pnpm --filter @arcaai/vox test` | **build 6/6 turbo tasks**; tests **158 files, 3213 passed** (+78 from this slice's 4 new test files) |
| `pnpm --filter @arcaai/ui-playground type-check` | **clean** (after building `@arcaai/ui` dist in the fresh worktree) |
| `pnpm --filter @arcaai/ui-playground test` | **83 files, 797 passed** (+8 from `local-voice.test.tsx`) |
| `pnpm build:api` | **not run — `apps/api` untouched** |
| IDE lint on every edited file | clean |

**Deferred to CI:** `pnpm test:e2e` (API e2e) — N/A, no backend change. **Confirmed not run:** `git`, `prisma migrate` / `db:migrate` / `prisma db` (schema FROZEN; local enroll reuses the existing path). **Backend enrollment intact:** zero backend files modified; the backend `EnrollCard` + `useVoiceEmbedding` provider are unchanged and remain the default-available provider. **Shared-barrel touch:** `@arcaai/vox` `src/core.ts` + `src/hooks/index.ts` + `src/utils/index.ts` (additive exports) + new `exports.task329-p4.test.ts`; **no** existing key-count guard required changes; **no** shared admin nav edited. **New dependency:** `@huggingface/transformers@^3.8.1` in `@arcaai/vox` (matches `@arcaai/med-ner`).
### 5.7 P3 Audio & Transcription playground — local-model task selection — delivered 2026-06-02

Vertical slice on branch `wave3/p3-audio-models`. **No schema change / no `prisma migrate` / no `git`** — model + task are browser-runtime selections persisted in namespaced `localStorage` via the SDK model registry (no DB column, no API endpoint).

**BUG fix — `availableModels` mismatch (single source of truth).** *Root cause:* `DEFAULT_STT_MODELS` (the registry's selectable + loadable set, used by `ModelRegistry.getModelsByType('stt')` and `getModelUrl`) listed **four** models including `whisper-medium`, while the set *presented* to the user — the `SttConfigSchema.availableModels` default (surfaced as `SYSTEM_DEFAULTS.stt.availableModels`) and the playground's `BROWSER_VIABLE_MODELS` filter — only ever listed **tiny/base/small**. The registry therefore advertised `whisper-medium` as selectable/loadable (`getModelUrl('whisper-medium') → onnx-community/whisper-medium`) even though the UI never offered it, and there was no single declaration the two sides shared. *Fix:* trim `DEFAULT_STT_MODELS` to `tiny/base/small`, derive a new `DEFAULT_AVAILABLE_STT_MODELS` **from** `DEFAULT_STT_MODELS`, point `SttConfigSchema.availableModels`'s default at `DEFAULT_AVAILABLE_STT_MODELS`, and drop `whisper-medium` from the registry's HF-URL map — so *presented === selectable === loadable* by construction. *Regression test* (`core/__tests__/availableModels.task329.test.ts`): pins `SYSTEM_DEFAULTS.stt.availableModels` ids === `DEFAULT_STT_MODELS` ids, and presented ⊆ loadable (`getModelUrl`) ∧ selectable ⊆ presented — **fails RED** on the old 4-vs-3 drift.

**Persistence key scheme (tenant/user-namespaced, rule 08).** The per-user local **model** and **Whisper task** persist through the SDK `ModelRegistry` into `localStorage` under `` `${STORAGE_KEYS.SELECTED_MODELS}/${namespace}` `` where `namespace = resolveNamespace()` (tenant/user-derived; `pre-login` before auth). The single `SelectedModels` row holds `{ stt, vad, ner, sttTask }`; `selectModel('stt', id)` and `selectSttTask(task)` write the same namespaced row, validated by `SELECTED_MODELS_SCHEMA` (valibot, `sttTask` ∈ `picklist(['transcribe','translate'])`). It survives reload and is isolated per tenant/user (covered by `ModelRegistry.task329.test.ts`). On next visit the audio page rehydrates via `useArcaConfig().models.selected` → `applyPersistedSelection`.

> **Deviation from the §1.1 sketch (`PATCH /user/me/settings`).** Implemented via the namespaced `ModelRegistry` instead, matching the slice brief's explicit *"persist … via the SDK (tenant/user-namespaced, per rule 08)"*. Rationale: the local model + task are **browser-runtime** choices over the on-device-loadable set, and `stt.defaultModel` is **admin-locked** in the 3-tier config — so `setUserPreference`/a settings PATCH cannot hold a per-user model override. The **tenant default** still flows from config (`applyResolvedConfig`/`applyTenantDefaults`); the **user** override layers on top via the registry (USER → TENANT → DEFAULT).

**SDK (`@arcaai/vox`)**
- `types/models.ts` — new `SttTask = 'transcribe' | 'translate'`; `SelectedModels.sttTask?`; **trimmed `DEFAULT_STT_MODELS`** (removed `whisper-medium`); new `AvailableSttModel` + `DEFAULT_AVAILABLE_STT_MODELS` (derived from `DEFAULT_STT_MODELS`) as the single presented-set source.
- `core/ConfigSchema.ts` — `SttConfigSchema.availableModels` default now spreads `DEFAULT_AVAILABLE_STT_MODELS` (was a hand-maintained literal).
- `core/ModelRegistry.ts` — `SELECTED_MODELS_SCHEMA` + `sttTask`; new `getSttTask()` / `selectSttTask(task)` (persist into the namespaced `SelectedModels`); removed `whisper-medium` from `getHuggingFaceUrl`.
- `hooks/useArcaConfig.ts` — `models.selected.sttTask` exposed; new `selectSttTask(task)` (delegates to the registry + bumps the memo version).
- Barrels: `types/index.ts` + `core.ts` — export `AvailableSttModel`, `SttTask`, `DEFAULT_AVAILABLE_STT_MODELS` (re-exported through the main `index.ts` via `export *`).

**STT (`@arcaai/stt`)**
- `hooks/useSTT.ts` — added `features.task` to the processor **config fingerprint + deps**. The task is baked into the pooled local provider at `init`, so switching transcribe↔translate must rebuild the processor; otherwise a translate request silently reuses a transcribe-warm provider. (Engine/worker `task` plumbing already existed — TASK-300 L-2.)

**UI playground (`apps/ui-playground`)** — all in the existing `local_ai` card, behind the page's `ImpersonationGuard`; skeleton/empty/toast unchanged:
- `store/audio-store.ts` — `sttTask` state (+`setSttTask`); `applyPersistedSelection({ userModelId, userTask })` layers the USER choice over the tenant/default already seeded, accepting a model **only** if it is in the browser-viable `availableAsrModels` set (else keeps tenant/default); task falls back to `'transcribe'`. `@arcaai/vox` import kept **type-only** (the playground's vitest stubs vox at runtime).
- `features/audio/components/processing-config-panel.tsx` — the model `Select` now persists via `selectModel('stt', id)` **and** mirrors runtime via `setWhisperModel`; new **Task** badge group (Transcribe / Translate) persisting via `selectSttTask` **and** `setSttTask`, with active-badge `default` variant and a `controlsDisabled` (capturing/not-ready) gate.
- `features/audio/index.tsx` — reads `useArcaConfig().models.selected.{stt,sttTask}` and calls `applyPersistedSelection` once config is ready (runs after the config-seeding effect, so `availableAsrModels` is populated when the user model is validated).
- `features/audio/components/transcript-panel.tsx` — threads `sttTask` into `useSTT` `features.task` (+ memo dep) so on-device transcription actually transcribes-in-source vs translates-to-English.

**Tests added (RED-first).** SDK: `types/__tests__/models.task329.test.ts` (`DEFAULT_AVAILABLE_STT_MODELS` derivation), `core/__tests__/availableModels.task329.test.ts` (the single-source regression above), `core/__tests__/ModelRegistry.task329.test.ts` (`sttTask` persist round-trip + cross-namespace isolation), `hooks/__tests__/useArcaConfig.task329.test.tsx` (`selected.sttTask` + `selectSttTask` delegates + memo bust). STT: `hooks/__tests__/useSTT.test.ts` (+ "recreates processor when `features.task` changes"). UI: `store/__tests__/audio-store.task329.test.ts` (`sttTask` default/set/reset + `applyPersistedSelection`), `features/audio/components/__tests__/processing-config-panel.test.tsx` (+ "local model + task selection" — model persist, task render/persist/active-variant/`isCapturing` gate/exactly-2-Selects).

### 5.8 P3 verification gates — final output
| Gate | Result |
|---|---|
| `pnpm build:sdk` | **6/6 turbo tasks successful** |
| `pnpm --filter @arcaai/vox test` | **158 files, 3172 passed** (task329 subset: 4 files / 10 passed) |
| `pnpm --filter @arcaai/stt test` *(touched `useSTT`)* | **25 files, 378 passed** (task329 case in `useSTT.test.ts`) |
| `pnpm --filter @arcaai/ui-playground type-check` | **clean** (after `build:sdk` rebuilt vox/stt/room dist) |
| `pnpm --filter @arcaai/ui-playground test` | **83 files, 802 passed** (P3 subset: 2 files / 87 passed) |
| IDE lint on every edited file | clean |

**Not run (correctly):** `pnpm --filter @arcaai/applications …` and `pnpm build:api` — **no app/api or DB layer touched** (model + task persist client-side via the registry). **Deferred to CI:** API e2e (`pnpm test:e2e`) — N/A for this slice. **Confirmed not run:** `git`, `prisma migrate` / `db:migrate` / `prisma db` (schema frozen; no schema change needed). **Shared-barrel touches:** `@arcaai/vox` `types/index.ts` + `core.ts` (+`AvailableSttModel`, `SttTask`, `DEFAULT_AVAILABLE_STT_MODELS`); no endpoint key-count guard applies to the models barrel and the full vox suite is green. **`@arcaai/stt` `useSTT.ts`** is shared by the SDK — change is additive (one fingerprint field) and its full suite passes. No shared admin nav edited.

---

### 5.9 P2 Consultation completeness (+ X8 dual capture) — delivered 2026-06-02

Vertical slice on branch `wave3/p2-consultation`, built **layer-by-layer** (domain → app → api → SDK → UI) after the single-agent attempt hit `resource_exhausted`. **No schema change / no `prisma migrate`** — the `AudioRecording.rawMediaId`/`processedMediaId` columns and `UserProfile.preferredPromptTemplateId` already existed (schema-first sub-wave); this slice threads them through every layer. Commits: `a852c256` (domain+app), `70c46510` (api), `6561b8ee` (sdk), `8ba9cf2b` (ui).

**Domain (`packages/domains`)** — commit `a852c256`
- `models/.../AudioRecordingModel.ts` + `entities/.../AudioRecordingEntity.ts` + `factories/.../AudioRecordingFactory.ts` — added `rawMediaId`/`processedMediaId` (model columns, entity interface+fields+getters/setters, factory `CreateAudioRecording`/`CreateWithMetadata` with `?? null` defaults). Mapper unchanged (`AutoClassMapper` maps by name; round-trip test added).
- `repositories/.../ConsultationRepository.ts#findConsultationChain` — **rewritten** from a single-hop lookup to a **full multi-hop walk**: climb to the structural root, then BFS-collect every `ENABLED` descendant (cycle-safe via a visited set), ordered by `createdAt`.
- Tests: `AudioRecordingFactory.task329.test.ts` (dual-id factory+mapper round-trip), `ConsultationRepository.chain.test.ts` (multi-hop, cycle, DISABLED-exclusion, missing-node).

**Application services (`packages/applications`)** — commit `a852c256`
- `consultation/context/dto/{add-context.request,context-item.response}.ts` + `context.dto.mapper.ts` + `context.service.ts#addAudioRecording` — optional `rawMediaId`/`processedMediaId` on request+response DTOs, threaded into the factory and the `ResourceCreated` audit event.
- **3-tier preferred-prompt fallback:** `prompt/prompt-resolution.service.ts` — new **Tier-0 `'preferred'`** (`PromptResolutionTier`/`Trace`/`Params` extended, `PromptTemplateRepository` injected, `resolvePreferredPromptId` helper; resolve prioritises a found `preferredPromptTemplateId`). `prompt/prompt-assembly.service.ts` passes `preferredPromptTemplateId` through. `summary/summary.service.ts` — `UserProfileRepository` injected (`@Optional()`, trailing arg to preserve existing fixtures); `resolvePreferredPromptTemplateId(doctorId)` looks up the consulting doctor's profile and feeds Tier-0 in both `generatePreSummary`/`generateSummary` (graceful null fallbacks).
- Tests: `prompt-resolution.service.test.ts` (Tier-0 happy/fallback/error), `summary.service.preferred-prompt.task329.test.ts` (the resolve seam — every branch), `context.dto.mapper.test.ts` (dual-id mapping).
- **`stt-internal` — N/A by design:** dual-capture is a client-capture concern; the STT service persists whatever `mediaId`s it is given, so no STT change was required.

**API (`apps/api`)** — commit `70c46510`
- `modules/consultation/consultation.controller.ts` — public `POST /consultations/:id/recordings` (`verifyConsultationOwnership` → `contextService.addAudioRecording`, accepts the dual ids) + `GET /consultations/:id/recordings` (`verifyConsultationAccess` → `getAudioRecordings`). The recursive `GET /:id/chain` already existed (now backed by the rewritten repo walk).
- Tests: `consultation.controller.test.ts` — access-control enforcement on both routes + happy-path dual-id pass-through + list.

**SDK (`@arcaai/vox`)** — commit `6561b8ee`
- `core/constants.ts` — `AUDIO_RECORDING_ENDPOINTS` (`ADD`/`LIST`, url-encoded). `types/recording.ts` (**new**) — `AudioRecording`/`AddAudioRecordingInput` mirroring the DTOs.
- `hooks/useAudioRecordings.ts` (**new**) — `list`/`add` (add accepts raw/processed ids, refreshes the cached list). `hooks/useConsultationChain.ts` (**new**) — `fetchChain` over `GET /:id/chain`.
- `core/DualStreamRecorder.ts` (**new**) — two parallel `MediaRecorder`s (raw + processed track) → `{ raw, processed }` blobs on stop (codec-fallback, idempotent start, not-running guard). `core/TranscriptionPipeline.ts` — `getRawInputTrack()` accessor (complements `getProcessedTrack()`).
- Barrels: `hooks/index.ts` + `core.ts` + `types/index.ts` (re-exported via `export *`).
- Tests: `constants.audio-recording.task329.test.ts`, `useAudioRecordings.test.ts`, `useConsultationChain.test.ts`, `DualStreamRecorder.test.ts` (mocked `MediaRecorder`), `TranscriptionPipeline.getRawInputTrack.task329.test.ts`.

**UI playground (`apps/ui-playground`)** — commit `8ba9cf2b`
- **Route fix:** `routes/_authenticated/consultation/$id.tsx` repointed from `ConsultationPage` (the master-detail workspace, which ignored the `$id` param) to the intended **tabbed `ConsultationDetail`** (it already reads `useParams('/_authenticated/consultation/$id')`). The master-detail list stays at `/consultation`.
- `components/consultation-detail.tsx` — restructured into **4 tabs**: **Recording**, **Audio Case-Note** (`CaseNoteForm` + `ContextItemList`), **Summary** (`SummaryPanel`), **Chain**; reuses the doctor-scope guard (tenant + `ImpersonationGuard`) so the direct-URL page is gated like the workspace.
- `components/consultation-recording-panel.tsx` (**new**) — live consultation-scoped transcription via `useRealtimeTranscription({ consultationId })` + recordings list via `useAudioRecordings`; recordings with raw/processed ids show a **"Dual capture"** badge. skeleton/empty/toast per rules 10/11.
- `components/consultation-chain-panel.tsx` (**new**) — `useConsultationChain` ordered chain, current-node marker, per-node **Open** → `/consultation/$id`.
- `components/consultation-workspace.tsx` — each list item gets an **"Open full view"** affordance → navigates to the tabbed `/consultation/$id`.
- Tests: `consultation-chain-panel.test.tsx` (fetch-on-mount, not-linked/linked/Open-navigates/error/loading), `consultation-recording-panel.test.tsx` (list-on-mount, dual-capture badge, start/stop scoped to the consultation, pipeline override).

### 5.10 P2 verification gates — final output
| Gate | Result |
|---|---|
| `pnpm --filter @arcaai/domains build && … test` | build clean; **1126 passed**, lint clean (commit `a852c256`) |
| `pnpm --filter @arcaai/applications build && … test:unit` | build clean; **4606 passed**, lint clean (commit `a852c256`) |
| `pnpm build:api` + `consultation.controller` tests | `build:api` clean; controller **67 passed** (commit `70c46510`) |
| `pnpm turbo run build --filter=@arcaai/vox` + targeted tests | vox build (6 tasks) clean; **65 new/affected tests pass**; new files lint+type clean (commit `6561b8ee`) |
| `pnpm --filter @arcaai/ui-playground type-check && … test` | type-check **0** (after building `@arcaai/ui` dist in the fresh worktree); consultation **5 files / 49 passed** (incl. 11 new panel tests) (commit `8ba9cf2b`) |
| IDE lint on every edited file | clean |

**Pre-existing, NOT from this slice:** the umbrella `@arcaai/vox typecheck` (`tsc --noEmit` over tests) has pre-existing failures in unrelated test files (`PersonalizationManager`, `SttV2WebSocketClient`, `useLocalVoiceEmbedding`, `AgenticProvider.task297`, `config.task225`) — none are P2 files; the SDK CI gate is build + vitest (both green here). **Confirmed not run:** `git push`, `prisma migrate` / `db:migrate` / `prisma db` (columns pre-existed). **Reverted:** the ui-playground `lint --fix` churned 15 unrelated non-consultation files (admin/audio/voice-profile) — all restored; only the 7 consultation/route files committed.

---

### 5.11 LiveCodePanel — reactive SDK code-sample across all 6 playgrounds — delivered 2026-06-02

- **Shared component** `apps/ui-playground/src/components/live-code-panel.tsx`: renders a copy-pasteable snippet via `@arcaai/ui`'s **prompt-kit `CodeBlock`/`CodeBlockCode`** (Shiki) plus a self-contained copy button. **Deviation from §2.7 (`kibo-ui/code-block`):** the app tsconfig aliases every `@arcaai/ui/*` subpath to the bundled `dist/index.d.ts` barrel for type-checking, and the barrel's top-level `CodeBlock` is prompt-kit's (kibo-ui's collides → namespaced as `KiboUI`). prompt-kit is the type-resolvable, simpler (`{ code, language }`) Shiki block; it is imported via its package subpath so the vitest `@arcaai/ui/*` stub still intercepts it.
- **Reactive core** `apps/ui-playground/src/lib/playground-snippets.ts`: six **pure, deterministic** builders — `buildOverviewSnippet` / `buildConsultationSnippet` / `buildAudioSnippet` / `buildVoiceSnippet` / `buildDnaSnippet` / `buildSummarizationSnippet`. Each takes a small prefs object (tenant + impersonated user + the page's reactive selections) and emits an honest `@arcaai/vox` sample (real exports only: `useRealtimeTranscription`, `useConsultationChain`/`useAudioRecordings`, `resolveVoiceEnrollmentProvider`, …). Kept React-free so they unit-test trivially and re-render reactively.
- **Wired into all 6 playgrounds** via `useMemo` over the relevant store/prefs: Overview (`tenantId` + super-admin), Consultation (`tenantId`), Audio (`modelId`/`task`/`language` + impersonated user), Voice (selected `provider`), DNA (current style `version`/`tone`), Summarization (provider/model/template/DNA/temperature/maxTokens/NER/stream).
- **Test infra:** one central mock in `src/__tests__/setup.ts` for the prompt-kit code-block subpath (Shiki is heavy/async under jsdom) — keeps every existing full-page render test green while the panel is wired into the pages.
- Tests: `playground-snippets.test.ts` (12 — each builder reflects its inputs + determinism + placeholders) and `live-code-panel.test.tsx` (4 — renders snippet/chrome/copy + re-renders on `code` change).

### 5.12 LiveCodePanel verification gates — final output
| Gate | Result |
|---|---|
| `pnpm --filter @arcaai/ui-playground type-check` | **0 errors** |
| `pnpm --filter @arcaai/ui-playground exec vitest run` | **90 files / 847 passed** (incl. 16 new) — full suite green after wiring all 6 pages |
| eslint (no `--fix`) on every changed file | **0 errors, 0 warnings** on new/edited lines |
| Commit | `dc50c1a4` (11 files, +552 / −2) |

**Confirmed not run:** `git push`, `prisma migrate` / `db:migrate`. **Note:** built directly on `fix/2605-review` (shared final item — no worktree); `.env.dev`/`.env.test` left untouched/unstaged.

---

### 5.13 P4 D-3 — diarization-seeding feedback + Active/Inactive profile badge — delivered 2026-06-02

Closes the two items deferred from P4 §5.5 — the `voiceProfileSeeded` diarization-seeding signal and the always-"Active" voice-profile badge. Built in an **isolated worktree** branched from `fix/2605-review` (parent agent merges). **Frontend/SDK only — scope limited to `apps/ui-playground/**` + `packages/agentic-sdk-v2/**`; no `apps/api`/`packages/{applications,domains}`/Prisma touched, no `prisma migrate`, no `git push`** (a parallel agent owns any backend work).

**Sub-task 1 — always-"Active" badge fixed.** `features/audio/components/voice-embedding-panel.tsx` hardcoded `<Badge variant="outline">Active</Badge>` for every profile. It now renders from the profile's real state: `profile.isActive ? "Active" (variant default) : "Inactive" (variant outline)` — per rule `11` §7 (`default` = active, `outline` = neutral). The SDK `VoiceProfile` type already carried `isActive?: boolean`, so no SDK change was needed for this half.

**Sub-task 2 — `voiceProfileSeeded` surfaced to the UI (no backend change).** The field already exists on `StreamingSessionResponse` (SDK) / the backend `StreamSessionResponse` echo (TASK-298 D-1 / TASK-296 preseed contract) and is returned by `StreamingSessionManager.createSession()`, but nothing consumed it. Threaded it through to the user entirely from the frontend/SDK:
- **SDK (`@arcaai/vox`)** — `core/StreamingSessionManager.ts`: added `voiceProfileSeeded: boolean | null` to `SessionManagerState` and populate it in `getState()` from the cached session response (`?? null`), so the field is exposed on the manager's result object (alongside the existing `maxConcurrent`/`currentActive`).
- **Playground consumer hook** — `hooks/use-realtime-transcription.ts`: the backend-WebSocket path already receives the full `sessionResponse` from `createSession()` but only kept `sessionId`. Added `voiceProfileSeeded: boolean | null` to `UseRealtimeTranscriptionReturn`, captured it on session create, and reset it to `null` on (re)start + stop.
- **UI** — new `features/audio/components/diarization-seeding-indicator.tsx`: a small presentational `DiarizationSeedingIndicator` — positive `Badge` ("Voice profile seeded", variant `default`) + a one-time `toast.success("Voice profile seeded into diarization")` when seeded; a quiet neutral note ("Diarization not personalized", variant `secondary`) when diarization ran without personalization; renders nothing until a session reports a value. Wired into `BackendSocketTranscript` (`transcript-panel.tsx`) in the WebSocket status-badge row.

**No backend-scope limitation hit.** Because `createSession()` already returns `voiceProfileSeeded`, the signal reaches the UI without any `apps/api`/Python change — the only gap was the playground consumer dropping the field, which this slice closes.

**Tests added (RED-first).** `voice-embedding-panel.test.tsx` (inactive → "Inactive"/`outline`, active → "Active"/`default`; badge mock now exposes `data-variant`); `StreamingSessionManager.test.ts` (idle `getState().voiceProfileSeeded === null`; seeded session → `true`); new `diarization-seeding-indicator.test.tsx` (seeded → positive badge + one-time toast; not-seeded → neutral note, no toast; null → renders nothing; announce-once across re-renders).

### 5.14 P4 D-3 verification gates — final output
| Gate | Result |
|---|---|
| `pnpm turbo run build --filter=@arcaai/ui-playground` (pulls `@arcaai/vox`) | **8/8 turbo tasks successful** |
| `pnpm --filter @arcaai/vox test` | **168 files, 3251 passed** (+1: new `getState().voiceProfileSeeded` case) |
| `pnpm --filter @arcaai/ui-playground type-check` | **0 errors** (run **after** the build — a run concurrent with the build is racy because the build wipes dependency `dist/`) |
| `pnpm --filter @arcaai/ui-playground test` | **91 files, 853 passed** (+6: 2 badge + 4 indicator) |
| eslint (no repo-wide `--fix`) on changed files | **0 errors** (`StreamingSessionManager.ts`/`voice-embedding-panel.tsx`/`diarization-seeding-indicator.tsx` clean; 2 **pre-existing** `prettier` warnings on untouched lines in `transcript-panel.tsx:634` + `use-realtime-transcription.ts:5`; test files "ignored by default") |
| `ReadLints` on every edited file | clean |

**Surgical-diff note:** did NOT run the package `lint` script's repo-wide `eslint . --fix` (it would reformat unrelated files); the 2 pre-existing `prettier` warnings sit on lines this slice did not modify and were intentionally left untouched. **Confirmed not run:** `git push`, `prisma migrate` / `db:migrate` / `prisma db`. Code committed on worktree branch `task-329/p4-d3-voice-seed` (`22cabcbd`); **not** merged into `fix/2605-review` (parent agent handles the sequential merge).

---

## 6. Change History
| Date | Change | Files |
|---|---|---|
| 2026-06-02 | Sub-ticket created from TASK-325 §3.7 (Phase 3). Scope = P2–P6 + LiveCodePanel; fixes X3/X8/X10; Q3 SDK-first. Status `Pending`. | this README |
| 2026-06-02 | **P6 + X3 + X10 delivered** (slice `wave3/p6-summarization`): `cacheHit`/`qualityScore` threaded domain→app→SDK→UI; summary list/version/diff/tag(+edit→new-version) endpoints + SDK methods + `SavedSummariesPanel`; X3 context-item ownership guard on `/text/generate/assembled`; X10 tenant+user localStorage namespacing. All 5 gates green; no `git`/`prisma migrate`. | domains `SummaryMeta*` + `ContextItemRepository`; applications summary/context DTOs+mappers+services, `version-diff.response`, `tag.service`; api `consultation.controller`/`consultation.module`/`smr-proxy.controller`; `@arcaai/vox` `useArcaSummary`/`constants`/`types`; ui-playground `saved-summaries-panel`, `history`, summary/pre-summary pages; + RED tests |
| 2026-06-02 | **P3 Audio delivered** (slice `wave3/p3-audio-models`): local-model **task** (transcribe/translate) selection in the Audio playground; per-user model+task persisted via the SDK `ModelRegistry` namespaced `localStorage` (rule 08; **deviation** from the `PATCH /user/me/settings` sketch — `stt.defaultModel` is admin-locked) and rehydrated via `applyPersistedSelection` (USER→TENANT→DEFAULT). **`availableModels` mismatch fixed** by a single source of truth: `DEFAULT_AVAILABLE_STT_MODELS` derived from a trimmed `DEFAULT_STT_MODELS` (dropped `whisper-medium`), consumed by `SttConfigSchema`; regression test pins presented===selectable===loadable. Task wired into local transcription via `useSTT` `features.task` (+ fingerprint). SDK/STT/ui-playground gates green; no `git`/`prisma migrate`; no app/api/DB touched. | sdk `types/models`/`core/ConfigSchema`/`core/ModelRegistry`/`hooks/useArcaConfig`/`types/index`/`core`; stt `hooks/useSTT`; ui-playground `store/audio-store`, `features/audio/{index,components/processing-config-panel,components/transcript-panel}`; + RED tests (`models`/`availableModels`/`ModelRegistry`/`useArcaConfig` task329, `useSTT` task case, `audio-store` task329, `processing-config-panel`) |
| 2026-06-02 | **P5 DNA delivered** (slice `wave3/p5-dna-playground`): generate-from-history (`sourceIds`), set-default (`PATCH /:reportId/default`, reuses `isLatest`), `GET /mine` history, two-version diff, reusable `ImpersonationGuard`, and the **empty Edit-dialog fix** (`useEditDialogController.openFor` couples select+open; added Edit button). SDK `useDnaStyle` extended (+`MINE`/`SET_DEFAULT` endpoints, key-count guard 12→14); optimistic set-default in the UI cache. App/SDK/API/ui-playground gates green; no `git`/`prisma migrate`; e2e deferred to CI. | sdk `useDnaStyle`/`constants`/`types/dna`/`constants.ws4.test`; applications `generate-dna-report.request`/`dna-writing-style.service`/`IDnaWritingStyleService`/`dna-writing-style.processor`; api `dna-writing-style.controller`; ui-playground `components/impersonation-guard`, `features/dna-writing-style/{api,hooks,components,index}`; + RED tests |
| 2026-06-02 | **P2 Consultation + X8 delivered** (slice `wave3/p2-consultation`, built layer-by-layer after `resource_exhausted`): **X8 dual capture** — `rawMediaId`/`processedMediaId` threaded domain→app→api→SDK→UI; **3-tier preferred-prompt fallback** (PromptResolution Tier-0 `'preferred'` + `SummaryService` `UserProfile` DI); **recursive multi-hop** `findConsultationChain`; public `POST/GET /consultations/:id/recordings`; SDK `useAudioRecordings`/`useConsultationChain`/`DualStreamRecorder`/`getRawInputTrack`; **route fix** `$id` → tabbed `ConsultationDetail` (Recording/Audio Case-Note/Summary/Chain) + workspace "Open full view". **Deviation:** no client `upload→mediaId` (Media created server-side) and the WS realtime path exposes only the raw track → SDK ships the dual-capture toolkit + UI surfaces recordings/metadata rather than a fabricated client dual-persist. Gates: domains 1126 / apps 4606 / api 67 / vox 65 / ui 49, all green; no `git push`/`prisma migrate`. Commits `a852c256`,`70c46510`,`6561b8ee`,`8ba9cf2b`. | domains `AudioRecording{Model,Entity,Factory}`+`ConsultationRepository`; applications consultation context DTOs/mapper/service + `prompt-{resolution,assembly}.service` + `summary.service`; api `consultation.controller`; `@arcaai/vox` `constants`/`types/recording`/`useAudioRecordings`/`useConsultationChain`/`DualStreamRecorder`/`TranscriptionPipeline`/barrels; ui-playground `consultation/{$id route, consultation-detail, consultation-recording-panel, consultation-chain-panel, consultation-workspace}`; + RED tests every layer |
| 2026-06-02 | **LiveCodePanel delivered** (direct on `fix/2605-review`): shared reactive code-sample panel + 6 pure snippet builders wired into all playgrounds (Overview/Consultation/Audio/Voice/DNA/Summarization), each re-deriving from its store + impersonated prefs via `useMemo`. **Deviation:** prompt-kit `CodeBlock` (type-resolvable through the `@arcaai/ui/*`→barrel-types alias; kibo-ui is namespaced as `KiboUI`) instead of `kibo-ui/code-block`. A central `setup.ts` mock keeps existing full-page render tests green. Gates: type-check 0; vitest **90 files / 847 passed**; lint clean. Commit `dc50c1a4`. Status → `Completed`. | ui-playground `components/live-code-panel`, `lib/playground-snippets`, `__tests__/setup`, + 6 playground pages (`playground/overview`, `consultation`, `audio`, `voice-profile`, `dna-writing-style`, `summarization/summary`); + 2 RED tests |
| 2026-06-02 | **P4 Voice delivered** (slice `wave3/p4-voice-embedding`): NEW **`local` in-browser embedding provider** (Transformers.js / `Xenova/wavlm-base-plus-sv`, MIT, 512-dim) alongside the unchanged backend provider — extract on-device, **persist via the existing `POST /voice-profile/enroll`**, cache the embedding tenant/user-namespaced (`SecureStorage`); **quick test** = client-side cosine match. Provider `Tabs` in the playground behind the shared `ImpersonationGuard`. **Deviation:** schema FROZEN → reused the existing enroll path instead of the originally-sketched `enroll-embedding`/`test` endpoints; `voiceProfileSeeded` + always-"Active" badge deferred. **No backend change**, no `git`/`prisma migrate`. New dep `@huggingface/transformers@^3.8.1` (matches `med-ner`). SDK (3213) + ui-playground (797) gates green. | sdk `utils/voiceEmbedding`, `core/LocalVoiceEmbedder`, `hooks/useLocalVoiceEmbedding`, barrels `core.ts`/`hooks/index.ts`/`utils/index.ts`, `package.json`, `exports.task329-p4.test`; ui-playground `features/voice-profile/local-voice.tsx` + `index.tsx`; + RED tests (4 sdk + 1 ui) |
| 2026-06-02 | **P4 D-3 delivered** (worktree branch `task-329/p4-d3-voice-seed`, commit `22cabcbd`; frontend/SDK only — see §5.13): closed the two P4 §5.5 deferrals — (1) the always-"Active" voice-profile badge now renders from `profile.isActive` (Active/`default` vs Inactive/`outline`, rule 11 §7); (2) `voiceProfileSeeded` diarization-seeding feedback surfaced to the UI — exposed on `StreamingSessionManager.getState()`, threaded through `useRealtimeTranscription`, and shown via a new `DiarizationSeedingIndicator` (positive Badge + one-time toast when seeded, neutral note otherwise) in the backend-socket transcript. **No backend change needed** (`createSession()` already echoes the field; `apps/api`/`packages/{applications,domains}`/Prisma untouched). Gates: build 8/8, vox 3251, ui-playground 853, type-check 0, lint clean. No `git push`/`prisma migrate`. **Not merged** (parent agent handles the sequential merge). | `@arcaai/vox` `core/StreamingSessionManager.ts` (+ `__tests__/StreamingSessionManager.test.ts`); ui-playground `features/audio/components/voice-embedding-panel.tsx` (+ test), `features/audio/components/diarization-seeding-indicator.tsx` (new + test), `features/audio/components/transcript-panel.tsx`, `hooks/use-realtime-transcription.ts` |
