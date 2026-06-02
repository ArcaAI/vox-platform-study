# TASK-329 — Phase 3: Developer-Playground Completeness

| | |
|---|---|
| Ticket Number | TASK-329 |
| Short name | Admin-Console-Playground-Completeness |
| Parent | **TASK-325** (Admin Console Transformation — umbrella) |
| Created | 2026-06-02 |
| Updated | 2026-06-02 |
| Status | `In Progress` (P6 + X3 + X10 delivered; P2–P5 + LiveCodePanel pending) |
| Type | feature |
| Scope | `apps/ui-playground/`, `@arcaai/vox`, `packages/{stt,vad,noise-filter}`, `apps/api/`, `packages/database/` |
| Depends on | **TASK-326** (security) + **TASK-327** (scope shell + impersonation gate) |

> Completes playground spec items **P2–P6**, fixes **X3/X8/X10**, and adds the **realtime code-sample panel** (`LiveCodePanel`) required across all playgrounds. Per **Q3**, all data flows through `@arcaai/vox` hooks.

---

## 1. Requirement Analysis

### 1.1 Acceptance criteria
- [ ] **P2 Consultation** — in-flow mic recording using the impersonated user's pipeline prefs (realtime transcript); batch-transcription + SSE wired into the audio case-note tab (`useFileTranscription`); summary via preferred dept prompt **with fallback**; chain-of-consultation reference UI (`GET /:id/chain`); **RAW + PROCESSED** dual capture — add `rawMediaId`/`processedMediaId` to `AudioRecording` and save both streams (**X8**).
- [ ] **P3 Audio** — local-model **task** selection (transcribe/translate); per-user prefs persisted via `PATCH /user/me/settings`; fix `localAsrModels`/`availableModels` mismatch.
- [ ] **P4 Voice** — **local** in-browser enrollment (new local embedding provider + `POST /voice-profile/enroll-embedding`); **quick test** (mic/upload match + `POST /voice-profile/test`); diarization seeding feedback (`voiceProfileSeeded`); fix the always-"Active" badge.
- [ ] **P5 DNA** — generate from **selected historical data** (context-item picker); **set-default** (`POST /:reportId/set-default`); two-version **diff** (`version-diff-panel`); wrap page in `ImpersonationGuard`; fix the empty Edit dialog.
- [x] **P6 Summarization** — backend summary **list + version browser**; `cacheHit`/`qualityScore` fields + endpoints; version **diff**; **tagging** (`Tag`); **edit→new version**; fix the raw-DNA ownership bypass via `/text/generate/assembled` (**X3**); namespace `localStorage` history by tenant/user (**X10**). ✅ delivered — see §5.1.
- [ ] **`LiveCodePanel`** — reactive Shiki snippet (`kibo-ui/code-block`) bound to each playground's store / impersonated prefs.
- [ ] Skeleton/empty/toast per rules `10`/`11`; gates green (§4).

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

## 6. Change History
| Date | Change | Files |
|---|---|---|
| 2026-06-02 | Sub-ticket created from TASK-325 §3.7 (Phase 3). Scope = P2–P6 + LiveCodePanel; fixes X3/X8/X10; Q3 SDK-first. Status `Pending`. | this README |
| 2026-06-02 | **P6 + X3 + X10 delivered** (slice `wave3/p6-summarization`): `cacheHit`/`qualityScore` threaded domain→app→SDK→UI; summary list/version/diff/tag(+edit→new-version) endpoints + SDK methods + `SavedSummariesPanel`; X3 context-item ownership guard on `/text/generate/assembled`; X10 tenant+user localStorage namespacing. All 5 gates green; no `git`/`prisma migrate`. | domains `SummaryMeta*` + `ContextItemRepository`; applications summary/context DTOs+mappers+services, `version-diff.response`, `tag.service`; api `consultation.controller`/`consultation.module`/`smr-proxy.controller`; `@arcaai/vox` `useArcaSummary`/`constants`/`types`; ui-playground `saved-summaries-panel`, `history`, summary/pre-summary pages; + RED tests |
