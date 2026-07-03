# TASK-372 — HOPE Shared Component System (Design-System Components)

| | |
|---|---|
| **Ticket** | TASK-372 |
| **Type** | Feature / Design System |
| **Created** | 2026-06-27 |
| **Updated** | 2026-06-30 (Documentation + test review pass — DESIGN-SPEC, TRACEABILITY-MATRIX, MANUAL-E2E + admin/api E2E specs added; D7/D8/D10 follow-ups confirmed landed) |
| **Status** | **In Progress** — `@arcaai/ui` component system **Completed & verified** (build + 443 unit tests + lint green). **Follow-ups confirmed landed (2026-06-30):** D7 backend cursor DTO = **[TASK-373](../TASK-373-Cursor-Pagination-DTO/README.md) Completed** (`GET /admin/audit-logs/cursor` → `CursorPaginatedResponse`); D8 `ui.data-grid` settings namespace = **recognized + value-validated** in `userSettings.namespaces.ts` (the endpoint stays open — this is a recognition/validation registry, **not** a strict allow-list); D10 `apps/admin` integration = **[TASK-374](../TASK-374-Admin-App-Integration/README.md) Completed**. **QA-pass artifacts added:** [DESIGN-SPEC](../../designs/admin/shared-components.md) · [TRACEABILITY-MATRIX](../../qa/traceability/shared-components.md) · [MANUAL-E2E-TESTS](../../qa/manual-tests/03-shared-components.md) + admin/api Playwright specs. **Remaining:** execute the new E2E against a running stack. |
| **Owner** | Frontend / Design System |
| **Depends on** | [TASK-371 — Admin Console Redesign](../TASK-371-Admin-Console-Redesign/README.md) (Calm Clinical Teal tokens), [TASK-249 — Context Item Type Enhancements](../TASK-249-Context-Item-Type-Enhancements/README.md) (context-item model) |
| **Spawns** | [TASK-373 — Generic Cursor Pagination DTO](../TASK-373-Cursor-Pagination-DTO/README.md) (backend, decision D7) |

> **§1–§3 are the approved PLAN; §4 is the IMPLEMENTATION.** The plan defines architecture, public TypeScript interfaces, sub-component decomposition, dependencies (with verified versions), accessibility/perf strategy, and per-component TDD test lists, all grounded in the actual HOPE codebase. **Phase 4 is now implemented and verified in `@arcaai/ui`** — see the **[Implementation Summary (§4)](#4-implementation-summary)** for what shipped, deviations, and build/test/lint evidence.

> **Decisions ratified 2026-06-27.** All nine open decisions (D1–D9) are resolved — see the **[Resolved Decisions log (§3.8)](#38-resolved-decisions-log)**. Three (D4 Lexical editor, D8 server-persisted grid layout, D9 word-level timestamps + click-to-seek) **override** the earlier recommendation and have been propagated into the affected specs, dependency table, build order, integration map, and TDD lists below. D10 (admin-console target) was **not** in scope of this ratification; it was **resolved post-ratification** — the consumer is the redesigned `apps/admin`, integrated under [TASK-374](../TASK-374-Admin-App-Integration/README.md) (Completed). See §3.8.1.

> **Karpathy note (simplicity first):** The single most important finding of the current-state audit is that **`@arcaai/ui` already ships almost every dependency and primitive these three components need** — TanStack Table v8 + TanStack Virtual, dnd-kit, react-markdown/streamdown, `media-chrome`, `react-medium-image-zoom`, Lexical, `use-stick-to-bottom`, a faceted-filter type system, a `diceui/data-table` registry, an image gallery + lightbox, an audio player, and two transcript viewers. **This plan is therefore framed as consolidation + composition, not green-field construction.** Only one genuinely new third-party dependency is required (PDF rendering). The biggest "build" cost is contract design, virtualization, token migration, and a11y — not pulling in libraries.

---

## 1. Requirement Analysis

### 1.1 Description

Establish a cohesive, **token-driven, reusable shared-component system** in `@arcaai/ui` so that pages across the platform share components **and interfaces** (common TypeScript prop/data contracts, composition patterns, a `cva` variant system, and a headless-logic-vs-presentational split). On top of that foundation, design three flagship components and their sub-components:

1. **`VirtualizedDataGrid`** — massive, configurable, virtualized datagrid for admin lists.
2. **`HistoryTimelineList`** — reverse-chronological, expandable, content-type-aware timeline for consultation history + context items.
3. **`LiveTranscript`** — realtime, editable, infinite-scroll transcript view for live consultations.

### 1.2 Business context

HOPE is a multi-tenant healthcare AI platform. Two operator/clinician surfaces drive these components:

- **Admin Console** (TASK-371): Tenants, Users & Access, Audit Log — large, diverse tabular data under strict tenant isolation (404-over-403), soft-delete, and full auditability (X1–X8 in TASK-371 §1.4). → **VirtualizedDataGrid**.
- **Clinical Workspace / Consultation** (the `@arcaai/vox` SDK surface): a live consultation produces a realtime transcript and accumulates **context items** (audio, transcripts, summaries, worknotes, named entities, attachments). → **LiveTranscript** (live) + **HistoryTimelineList** (history).

All components MUST consume the **Calm Clinical Teal** design system ([`../TASK-371-Admin-Console-Redesign/theme.css`](../TASK-371-Admin-Console-Redesign/theme.css)): semantic tokens only (no hardcoded colors), light + dark, two densities (Comfortable/Compact), border-first elevation, "status never color-only", WCAG 2.2 AA, calm motion (150/200/250ms) with an ambient "breathing" pulse for live states.

### 1.3 Scope

- **In scope:** Architecture + interfaces + per-component plans + TDD test lists + dependency table + build order, all in `@arcaai/ui`. Token/density/dark-mode plumbing. A shared "interfaces" module.
- **Out of scope (this ticket):** Writing the components; rebuilding the admin console pages (TASK-371 owns surfaces); backend/DTO changes; PDF generation. Consuming-app wiring is described as an integration map but implemented under the respective feature tickets.
- **Assumptions (see Resolved Decisions §3.8; D10 resolved post-ratification):**
  1. The redesigned admin console (TASK-371) will consume these components; the current `apps/ui-playground` admin console is slated for removal (TASK-371 scope note) but its consultation feature components are still the canonical reference for context-item rendering. **(D10 — which app is the real consumer — resolved: the redesigned `apps/admin`, integrated under [TASK-374](../TASK-374-Admin-App-Integration/README.md).)**
  2. Server-side list endpoints keep the existing `Paginated<T>`/`PaginatedQuery` offset contract; cursor pagination is added per-endpoint only when [TASK-373](../TASK-373-Cursor-Pagination-DTO/README.md) lands (D7). The grid is built **offset-first**; cursor mode is inert until then.
  3. Live transcript data is consumed **through the SDK** (`@arcaai/vox`), not by the component opening raw WebSockets — but **for the rich data D9 needs (word-level timings), the consumer wires `SttV2WebSocketClient.onTranscript` → `WsTranscriptResult`** (the store path `audio.transcriptSegments` drops word timings; see §2.5 + D9).
  4. Per-user grid layout persists **server-side via `useUserSettings`** (D8), not browser localStorage.

### 1.4 Acceptance criteria

| ID | Criterion |
|---|---|
| A1 | A documented shared-interfaces module exists (pagination, sorting, filtering, async-collection, density/surface props) reused by all three components. |
| A2 | Each component has a complete public TypeScript API (generics, controlled/uncontrolled, render-prop/slot extension points, event callbacks). |
| A3 | Each component is token-driven (no hardcoded colors), supports light/dark + Comfortable/Compact, and targets WCAG 2.2 AA (correct ARIA roles: `grid`, `feed`/`list`, `log`). |
| A4 | `VirtualizedDataGrid` virtualizes ≥ tens of thousands of rows; supports faceted + global/column search, column reorder/resize/visibility/pinning, sorting, row selection, density, and **offset pagination (primary)** with an inert cursor mode reserved for [TASK-373](../TASK-373-Cursor-Pagination-DTO/README.md). |
| A5 | `HistoryTimelineList` renders per-content-type (markdown / PDF / image-grid+lightbox / audio / file / mixed), is virtualized, and lazy-loads heavy media. |
| A6 | `LiveTranscript` is infinite-scroll, skeleton-loading, **inline-editable via a Lexical editor (D4)** with save, distinguishes interim vs final, supports speaker labels + timestamps, autoscroll-with-pause + jump-to-live, and an ambient listening pulse. |
| A7 | A consolidated dependency table lists every package + version + purpose + risk, marking installed-vs-new. |
| A8 | TDD test lists (Vitest, behavior-focused) exist for every component and sub-component, per [`.cursor/rules/01-development-workflow.mdc`](../../../.cursor/rules/01-development-workflow.mdc). |
| A9 | Per-user grid layout (column order/size/visibility/pinning + density) **persists server-side via `useUserSettings`** with load-on-mount + debounced save and graceful fallback to defaults (D8). |
| A10 | `LiveTranscript` (and `HistoryTimelineList` audio items) expose **word-level timestamps with click-to-seek** wired to the audio player (D9), consuming `WsTranscriptResult.wordTimestamps`. |

---

## 2. Current State Evaluation

> Grounded by direct reads of `packages/ui`, `packages/applications`, `packages/agentic-sdk-v2`, `packages/types`, the knowledge docs, and TASK-249/TASK-371. File paths are cited inline.

### 2.1 `@arcaai/ui` library shape

Per [`.cursor/rules/07-react-ui.mdc`](../../../.cursor/rules/07-react-ui.mdc) and [`knowledge/ui/README.md`](../../../knowledge/ui/README.md):

```
packages/ui/src/
├── components/
│   ├── shadcn/        # 56+ base components (Radix + cva)
│   ├── custom/        # HOPE domain components (TranscriptViewer, AudioMeter, ServiceStatusBar, …)
│   ├── elevenlabs/    # audio/voice UI (audio-player, scrub-bar, waveform, transcript-viewer, response, …)
│   └── registries/    # third-party collections (diceui, tool-ui, prompt-kit, kibo-ui, ai-elements, magicui, …)
├── hooks/             # use-mobile, use-scribe, use-transcript-viewer
├── lib/               # utils.ts (cn, sleep), data-table.ts
├── config/            # data-table.ts (filter operator config)
├── types/             # data-table.ts (FilterVariant, FilterOperator, ExtendedColumnFilter)
└── styles/globals.css # Tailwind v4 base + theme variables
```

**Patterns (canonical, from rule 07 + `button` source):** `cva` for variants, `cn()` (clsx + tailwind-merge) from `lib/utils.ts`, `data-slot` attributes, `asChild` polymorphism via Radix `Slot.Root`, `VariantProps<typeof xVariants>` for prop typing. Build via `tsup` (CJS+ESM) + Tailwind CLI. Barrel: `packages/ui/src/index.ts` (named re-exports per component file).

**Primitive inventory (already present, relevant subset):** Accordion, AlertDialog, AspectRatio, Avatar, Badge, Button, Card, Checkbox, Collapsible, Command (cmdk), ContextMenu, Dialog, Drawer (vaul), DropdownMenu, Empty, Field, HoverCard, Input, InputGroup, Item, Kbd, Label, Pagination, Popover, Progress, RadioGroup, Resizable (`react-resizable-panels`), ScrollArea, Select, Separator, Sheet, Skeleton, Slider, Sonner (toast), Spinner, Switch, Table, Tabs, Textarea, Toggle/ToggleGroup, Tooltip.

### 2.2 Existing data-grid infrastructure (⚠️ partially built, not virtualized, not exported)

| Asset | Path | What it provides | Gap |
|---|---|---|---|
| `DataTable<TData>` | `packages/ui/src/components/registries/diceui/data-table/data-table.tsx` | Presentational table over a **TanStack `table` instance**; renders header groups, column pinning styles, selection state, `actionBar`, empty state | **No row/column virtualization** (plain `<table>`); **not exported** from `index.ts` |
| `DataTable*` sub-parts | `…/diceui/data-table/{data-table-pagination,data-table-toolbar,data-table-column-header,data-table-view-options,data-table-faceted-filter,data-table-date-filter,data-table-slider-filter,data-table-skeleton}.tsx` | **Full toolbar + faceted/date/slider filters + sortable column header + view-options + skeleton already exist** | Offset-only pagination; none virtualized |
| `use-data-table` hook | `packages/ui/src/hooks/use-data-table.ts` | Wires `useReactTable` + **`nuqs` URL-state** | — |
| Filter type system | `packages/ui/src/types/data-table.ts` | `FilterVariant` (`text\|number\|range\|date\|dateRange\|boolean\|select\|multiSelect`), `FilterOperator`, `ExtendedColumnFilter<TData>` | — |
| Filter helpers + parsers | `packages/ui/src/lib/data-table.ts`, `packages/ui/src/lib/parsers.ts` | `getColumnPinningStyle`, `getFilterOperators`, `getDefaultFilterOperator`, `getValidFilters` + URL parsers | — |
| Operator config | `packages/ui/src/config/data-table.ts` | text/numeric/date/boolean/select/multiSelect operator maps | — |
| Second variant | `packages/ui/src/components/registries/tool-ui/data-table/{data-table,formatters}.tsx` | Alternate table + cell formatters | Duplicate of diceui; pick one (D6) |
| App reference impl | `apps/ui-playground/src/features/admin/components/admin-data-table.tsx` | `AdminDataTable<TData>` — `useReactTable` + **`manualPagination` + `rowCount`** + row-selection + skeleton + custom pager (uses `DEFAULT_PAGE_SIZE`/`PAGE_SIZE_OPTIONS` from `@arcaai/vox`) | The de-facto server-paginated grid today; the new component should supersede it |

> **Implication (revised down further):** Almost the *entire* grid surface already exists in the diceui registry — `DataTable`, toolbar, faceted/date/slider filters, sortable column header, view-options, skeleton, and a `use-data-table` hook (with `nuqs`). `VirtualizedDataGrid` = **promote diceui out of the registry into a first-class `@arcaai/ui` export + add TanStack Virtual + dnd-kit column reorder + token/density wiring + offset/cursor pagination adapter**, modeled on the existing app `AdminDataTable`. This is consolidation, not construction.

### 2.3 Existing transcript infrastructure (⚠️ duplicated, not editable, autoscroll-only)

| Asset | Path | Provides | Gap vs LiveTranscript reqs |
|---|---|---|---|
| `TranscriptViewer` (custom) | `packages/ui/src/components/custom/transcript-viewer.tsx` | `TranscriptEntry {id,text,timestamp?,speaker?,isFinal}`; ScrollArea, interim italic+opacity, ping pulse for `currentTranscript`, `scrollIntoView` autoscroll | No virtualization; no editing; autoscroll **never pauses**; no jump-to-live; no diarization colors |
| `TranscriptViewer` (elevenlabs) | `packages/ui/src/components/elevenlabs/transcript-viewer.tsx` + `hooks/use-transcript-viewer.ts` | Word-level transcript w/ audio sync + scrubbing; `TranscriptSegment`, `TranscriptWord` | Built for ElevenLabs playback, not live STT |
| `useScribe` | `packages/ui/src/hooks/use-scribe.ts` | ElevenLabs realtime STT | Vendor-specific |
| `use-stick-to-bottom` | dep `^1.1.3` | Autoscroll-with-pause-on-scroll-up primitive | Not yet used by transcript viewers |

> **Implication:** `LiveTranscript` is the **canonical** transcript component and consolidates the two viewers (D6): it supersedes `custom/transcript-viewer.tsx` (marked `@deprecated`, not deleted) and reuses the elevenlabs word-sync ideas. It is driven by the SDK segment data, adds `use-stick-to-bottom` (pause + jump-to-live), **inline editing via a Lexical editor (D4 — overrides the earlier Textarea recommendation)**, word-level timestamps + click-to-seek (D9), and virtualization.

### 2.4 Existing media / markdown / image infrastructure (for HistoryTimelineList)

| Need | Existing asset | Path |
|---|---|---|
| Markdown render | `Markdown`, `ResponseStream`, `CodeBlock` (prompt-kit); `Response` (elevenlabs); `streamdown` | `registries/prompt-kit/*` (exported), `elevenlabs/response.tsx`, dep `streamdown ^2.5.0`, `react-markdown ^10.1.0`. App reference renderer: `apps/ui-playground/src/features/doc-panel/components/doc-content.tsx` |
| Image grid + lightbox | `GalleryGrid` + `useImageGallery()` (`openLightbox`, `registerImage`), lazy `loading="lazy"`, a11y `role=list/listitem`, focus ring | `registries/tool-ui/image-gallery/{gallery-grid,_adapter,context}.tsx`; dep `react-medium-image-zoom ^5.4.1` |
| Audio player | `AudioPlayer`, `ScrubBar` (exported) — custom `<audio>` + Radix slider, **no WaveSurfer** | `elevenlabs/audio-player.tsx`, `elevenlabs/scrub-bar.tsx`; dep `media-chrome ^4.18.2` |
| File / attachment upload | `react-dropzone ^15.0.0`, `@better-upload/client`, `kibo-ui/dropzone`, `better-upload/upload-dropzone` | registries |
| PDF **render** | **NONE in `packages/ui`** (needs `react-pdf`) | ⚠️ only genuine new render dependency. **But `pdfjs-dist ^6.0.227` is already used in the app** for text extraction (`apps/ui-playground/src/features/clinical-workspace/lib/extract-text.ts`) — the PDF.js engine + version are already proven in-repo. |

### 2.5 Real data contracts (the "interfaces to reuse")

**Offset pagination (backend, NestJS):**

```51:59:packages/applications/src/common/dto/paginated.query.ts
  filters?: string;   // CSV "name:John,phoneNumber:123456"
  sort?: string;      // CSV "name:asc,phoneNumber:desc"
```

- Request `PaginatedQuery` — `page?` (0-based), `limit?`, `search?`, `searchFields?` (CSV), `filters?` (CSV `field:value`), `sort?` (CSV `field:asc|desc`). (`packages/applications/src/common/dto/paginated.query.ts`)
- Response `Paginated<T> / PaginatedResponse<T>` — `count`, `limit`, `page`, `data[]`. (`packages/applications/src/common/dto/paginated.response.ts`)

**The actual envelope is consistent across the backend:** every list response is `{ data: T[]; count: number; page: number; limit: number }` — both the abstract `PaginatedResponse<T>` (Tenant/User/AuditLog/most) and the bespoke standalone classes (`PaginatedContextItemResponse`, `PaginatedConsultationResponse`). **No `total`, `totalPages`, `hasNextPage`, or cursor fields anywhere.**

**⚠️ Two normalizations the grid adapter must handle:**
1. **Page-base mismatch:** `PaginatedQuery.page` is **0-based**, but `ContextFiltersDto.page` / `PaginatedContextItemResponse.page` are **1-based**.
2. **SDK already normalizes for the client.** `@arcaai/vox` maps the server `{data,count,page,limit}` → `{ data, total, page, limit, totalPages, hasMore }` via `extractPaginated()` (`packages/agentic-sdk-v2/src/utils/responseUtils.ts`), where `totalPages`/`hasMore` are **computed client-side**. The frontend `packages/types/src/common.ts` `PaginatedResponse<T> { items[]; total; page; pageSize; hasMore }` is a third, *unused-by-the-SDK* shape. **The grid's `PageResult<T>` should align with the SDK's `extractPaginated` output** (`data/total/page/limit/totalPages/hasMore`), since that is what consuming hooks actually return.

**⚠️ Cursor pagination does NOT exist server-side** — verified: no `nextCursor`/`hasNextPage`/`endCursor` DTO anywhere. The grid will still *support* a cursor mode in its API (forward-looking), but **today every real consumer is offset-only**; cursor support is inert until a backend ticket adds it (D7). Do not over-build cursor UI.

**Admin list row models (grid columns):** all extend `BaseResponse` (`packages/applications/src/common/dto/base.response.ts`): `id`, `projectId`, `createdAt`, `updatedAt`, `resourceStatus` (`ResourceStatusType` — Active/Archived/…), `resourceStatusUpdatedAt/By`, `createdBy`, `updatedBy`.

| Consumer | DTO | Distinct fields |
|---|---|---|
| Tenants | `TenantResponse` | `name`, `key` (mono), `description?`, `version` (optimistic concurrency / `If-Match`) — `…/tenant/dto/tenant.response.ts` |
| Users & Access | `UserResponse` | `username`, `lastLoginAt?`, `lastActiveAt?`, `externalId?`, `isServiceAccount`, `UserRoleAssignments?[]` (role badges) — `…/user/user/dto/user.response.ts` |
| Audit Log | `AuditLogResponse` | `action` (`AuditAction`), `resourceType` (`ResourceType`), `resourceId?`, `eventType?`, `success?`, `responsibleUser{id,displayName,email}`, `responsibleIp`, `data`/`previousData` (before→after diff JSON), `metadata` — `…/auditLog/dto/auditLog.response.ts` |

**Consultation context items (timeline rows):** SDK `ContextItem` (`packages/agentic-sdk-v2/src/types/context.ts`):

```16:48:packages/agentic-sdk-v2/src/types/context.ts
export interface ContextItem {
  id: string;
  consultationId: string;
  type: ContextItemType | string;
  content: string;
  structuredData?: Record<string, unknown>;   // transcription segments / entities
  source: ContextSource;                       // 'USER'|'SYSTEM'|'TRANSCRIPTION'|'AI'
  isSummary; isTranscript; isAiGenerated;
  isCaseNote; isWorknote; isNamedEntity; isAttachment; isFinalSummary; isPreSummary; isMediaType;
  createdAt: string; updatedAt: string;
}
```

- **The "consultation session" is `ConsultationEntity`** (`packages/domains/src/entities/generated/core/ConsultationEntity.ts`) — there is **no** `ConsultationSession` type. History chains via `parentConsultationId` (re-visit/follow-up; `isNewVisit`/`isRevisit` getters). Its timeline items are `ContextItemEntity` (→ `ContextItemResponse`).
- `ContextItemType` is now **10** values (the generated enum `packages/domains/src/enums/generated/ContextItemType.ts` adds **`SIGNED_NOTE`** beyond TASK-249's 9): `CASE_NOTE | TRANSCRIPT | RAW_SUMMARY | MODIFIED_SUMMARY | PRE_SUMMARY | AUDIO_RECORDING | WORKNOTE | NAMED_ENTITY | ATTACHMENT | SIGNED_NOTE`. The renderer registry must cover `SIGNED_NOTE` (treat as markdown/signed-doc).
- **Media is not uniformly expanded.** `ContextItemResponse` exposes `mediaId` only; `mimeType`/`uri`/`size`/`extension` live on `MediaEntity` and must be resolved via a storage lookup for `ATTACHMENT`/`SIGNED_NOTE` (PDF/image/file). **Audio is the exception** — pre-expanded into `audioRecordings[]` (`AudioRecordingResponse`: mediaId, duration, format, sampleRate, recordedAt). Summary provenance is in `summaryMeta` (`SummaryMetaResponse`); entities in `namedEntities[]`; version history in `versions[]` (`ContextItemVersionResponse`: versionNumber, content, contentDiff, changeReason, changedBy).
- **Two timeline backing contracts exist:** (a) `ContextItemResponse[]` (full content, offset-paginated via `ContextFiltersDto` → `PaginatedContextItemResponse`); (b) a dedicated **event-stream** `ConsultationTimelineResponse { events: TimelineEventResponse[]; totalEvents; scope: 'single'|'chain'; sources[] }` (non-paginated; event types `consultation_opened`, `context_added`, `summary_generated`, …). The timeline component should accept either via its `mapItem` adapter.
- SDK selectors via `ContextState { items, transcriptions, caseNotes, summaries, worknotes, attachments, entities, sharedContext, isLoading, error }` and `ContextActions { getItems(filters?), updateItem(id, content), addContext, … }`. Consumed through `useArca()` / `useArcaStore(selector)` (per-provider store; never the singleton) — [`.cursor/rules/08-vox-sdk.mdc`](../../../.cursor/rules/08-vox-sdk.mdc). The SDK is the **only** data layer (no react-query/generated SDK) — list fetches use `appendPagination`/`appendFilters`/`extractPaginated`.
- Current reference rendering: `apps/ui-playground/src/features/consultation/components/{consultation-workspace,context-item-list,version-detail-panel,case-note-form}.tsx`.

**Live transcript segment — two shapes, pick deliberately:**

1. **Store-level `TranscriptSegment`** (`packages/agentic-sdk-v2/src/types/audio.ts`) — what the store keeps: `{ text; startTime; endTime; isFinal; speakerLabel?; confidence?; language? }`. Exposed as `audio.transcriptSegments` + `audio.currentTranscript` (interim string) via `useArca().audio` / `useArcaAudio()` / `useArcaStore(s => s.transcriptSegments)`.
2. **Rich wire `WsTranscriptResult`** (`packages/agentic-sdk-v2/src/types/stt-v2.ts`) — the full segment: `{ text; startTime; endTime; isFinal; stableChars?; utteranceIndex?; resultType?('segment'|'gloss'); seq?; englishText?; speakerId?; speakerLabel?; speakerConfidence?; wordTimestamps?[{word,start,end,confidence}]; inference? }`. Origin: stt-v2 `SegmentResult` (`apps/stt-v2/src/stt_v2/streaming/schemas.py`).

- **Partial-vs-final = `isFinal`.** Partials additionally carry **`stableChars`** (LocalAgreement-2 committed-prefix length: chars `< stableChars` are stable, the tail is tentative). Finals omit it. A `resultType:'gloss'` follow-up (English translation for code-switching) may arrive after a final with the same `utteranceIndex`.
- **⚠️ Critical gotcha (drives D4-adjacent design):** the store path **only keeps finals** and, on the **backend/remote** STT path, **drops `wordTimestamps`/`speakerLabel`/`stableChars` and falls back `startTime/endTime` to `Date.now()`** (`packages/stt/src/providers/StreamingBackendSTTProvider.ts`). So for rich live rendering (interim text, `stableChars`, word timings, speaker labels, gloss) the component should be able to consume **`SttV2WebSocketClient.onTranscript(cb: (r: WsTranscriptResult)=>void)`** directly (exported from `@arcaai/vox` core), not only the store. The component's `LiveTranscriptSegment` is a superset so it works with either source.
- Transport is a single gateway-proxied WebSocket (stt-v2 uses Redis Streams internally). Server→client events: `transcript | status | error | resumed | resume_failed`; client→server: binary PCM / `audio | stop | close | resume`. Reconnect/backpressure/resume (`lastSeq`) are the SDK's responsibility.

### 2.6 Theming reality check (blocking decision — see §3.8 D1)

`packages/ui/src/styles/globals.css` currently ships the **legacy green OKLCH** theme (per `knowledge/ui/README.md`: Vega style, green theme, radius 0.45rem, Tabler icons, Public Sans). TASK-371 defines the **new teal theme** (`theme.css`: Inter, radius 0.625rem, `--primary` teal, plus custom `--ai`/`--hope`/`--success`/`--warning` roles + sidebar tokens). **For new components to be token-driven and on-brand, the TASK-371 tokens must become the `@arcaai/ui` source of truth.** This is a prerequisite, not part of any single component.

> **✅ Resolved D1 (as recommended): migrate first, coordinated with TASK-371.** Replacing `globals.css` tokens with TASK-371's `theme.css` is **build step 0** — a hard prerequisite for every component below (none can be "token-driven/on-brand" until it lands). **Coordination note:** TASK-371 owns the canonical `theme.css`; this ticket only *adopts* it into `@arcaai/ui` (no fork). Because `@arcaai/ui` is shared, the migration is a potentially breaking visual change for **all** current consumers (green→teal, radius, font) — sequence it with the TASK-371 rollout and smoke-test existing surfaces. A back-reference line is added to TASK-371's Change History recording this dependency.

### 2.7 Gaps summary

1. No virtualization anywhere (grid or lists).
2. Data-table registry not exported; two competing table variants.
3. Two transcript viewers; neither is live-editable, paused-autoscroll, or virtualized.
4. No PDF rendering.
5. No shared cross-component interfaces (pagination/sort/filter/async-collection) — each surface re-derives.
6. Token drift: legacy green theme vs TASK-371 teal → **resolved by D1** (migrate `globals.css` to `theme.css`, build step 0).
7. Icon mix: Tabler (shadcn/custom, `@tabler/icons-react ^3.40.0`) and Lucide (elevenlabs, `lucide-react ^1.0.1`) both ship in `@arcaai/ui` → **resolved by D2 (override): both are allowed** in new shared components (peer-level), with a one-set-per-component/surface consistency guideline (see §3.1.3). No forced single-library refactor.

---

## 3. Implementation Plan

### 3.1 Shared-component architecture

#### 3.1.1 Directory layout (new + touched)

```
packages/ui/src/
├── lib/
│   └── shared/                         # NEW — cross-component contracts (headless, framework-agnostic)
│       ├── pagination.ts               # OffsetPageRequest, CursorPageRequest, PageResult<T>, normalizers
│       ├── query-state.ts              # SortRule, FilterRule, DataQueryState, default reducers
│       ├── async-collection.ts         # AsyncCollection<T> envelope (transport-agnostic)
│       ├── surface.ts                  # Density, DensityProps, BaseSurfaceProps, AsyncStateProps
│       └── index.ts
├── components/
│   ├── data-grid/                      # NEW — VirtualizedDataGrid (compound); canonical (D6)
│   │   ├── virtualized-data-grid.tsx   # presentational shell (virtualized rows/cols)
│   │   ├── use-data-grid.ts            # headless controller (wraps useReactTable)
│   │   ├── use-grid-layout.ts          # NEW (D8) — load/save layout via useUserSettings (debounced)
│   │   ├── data-grid-toolbar.tsx       # global search + faceted filters + view options + density
│   │   ├── data-grid-faceted-filter.tsx
│   │   ├── data-grid-column-header.tsx # sort + pin + hide + (drag handle)
│   │   ├── data-grid-pagination.tsx    # offset (primary) + inert cursor controls
│   │   ├── data-grid-skeleton.tsx
│   │   └── index.ts
│   ├── timeline/                       # NEW — HistoryTimelineList (compound)
│   │   ├── history-timeline-list.tsx
│   │   ├── use-timeline.ts             # headless: ordering, expansion, async-collection
│   │   ├── timeline-item.tsx           # expand/collapse shell + header
│   │   ├── renderers/                  # content-type renderers (registry)
│   │   │   ├── markdown-renderer.tsx   # wraps prompt-kit Markdown
│   │   │   ├── pdf-renderer.tsx        # NEW dep (react-pdf)
│   │   │   ├── image-grid-renderer.tsx # wraps tool-ui GalleryGrid + lightbox
│   │   │   ├── audio-renderer.tsx      # wraps elevenlabs AudioPlayer
│   │   │   ├── file-renderer.tsx
│   │   │   └── mixed-renderer.tsx
│   │   └── index.ts
│   └── live-transcript/                # NEW — LiveTranscript (compound); canonical (D6)
│       ├── live-transcript.tsx
│       ├── use-live-transcript.ts      # headless: segments, autoscroll/pause, edit buffer
│       ├── transcript-segment.tsx      # interim/final, speaker, timestamp, word tokens (D9)
│       ├── segment-editor.tsx          # NEW (D4) — Lexical inline editor (lazy-loaded)
│       ├── transcript-word.tsx         # NEW (D9) — clickable word token → seek
│       ├── jump-to-live.tsx
│       ├── listening-pulse.tsx         # ambient breathing pulse (reduced-motion aware)
│       └── index.ts
└── styles/globals.css                  # TOUCHED — migrate to TASK-371 tokens (D1, build step 0)
```

#### 3.1.2 Headless-vs-presentational & compound patterns

- **Headless controllers** (`use-*.ts`) own state + behavior (table model, virtualization math, ordering, edit buffer, autoscroll). They are framework-UI-agnostic and unit-testable in isolation.
- **Presentational shells** render tokens/density and wire ARIA. They accept the controller's return value, so consumers can use the controller alone for custom UIs.
- **Compound components** expose sub-parts (e.g. `<VirtualizedDataGrid.Toolbar/>`, `.Pagination`) for layout flexibility, with a batteries-included default export for the common case.
- **Extension points:** render-props/slots everywhere heavy customization is expected — column `cell`/`header` renderers (native TanStack `columnDef`), `renderItem`/per-type renderer registry for the timeline, `renderSegment`/`renderSpeaker` for the transcript, plus `emptyState`/`errorState`/`loadingState` slots on all three.

#### 3.1.3 Variants, tokens, density, dark mode

- All variants via `cva`; typed with `VariantProps`. Every component takes a `density?: 'comfortable' | 'compact'` prop (default from a `DensityProvider` context; falls back to `comfortable`) → drives row height, padding, font-size tokens.
- **Tokens only:** colors via semantic utilities (`bg-card`, `text-muted-foreground`, `border-border`, `ring-ring`, `bg-primary`, plus HOPE roles `bg-ai`, `bg-success`, `bg-warning`, `text-hope`). No hex. Dark mode is automatic via the `.dark` variable swap in `theme.css`.
- **Status never color-only:** every status badge = icon + label + color (reuse `Badge` + an icon); applies to `resourceStatus`, audit `success`, transcript `isFinal`, service health.
- **Icons — both libraries allowed (D2, overrides the earlier Lucide-only recommendation):** new shared components may use **either `lucide-react` (`^1.0.1`) or `@tabler/icons-react` (`^3.40.0`)** — both are already installed and treated as first-class. **Consistency guideline (not a hard rule):** pick **one set per component/surface** (don't mix icon families within a single component) so a screen reads as one visual language; both expose the same `size`/`stroke`/`className` ergonomics so swapping is mechanical. No mass refactor of existing components.
- **Motion:** 150/200/250ms ease-out; ambient "breathing" pulse class reserved for live states; all motion gated behind `prefers-reduced-motion` (the `listening-pulse` degrades to a static dot).

#### 3.1.4 Shared interfaces module (the reusable "interfaces")

```ts
// lib/shared/pagination.ts
export interface OffsetPageRequest { mode: 'offset'; page: number; limit: number; }     // page 0-based to match PaginatedQuery
export interface CursorPageRequest { mode: 'cursor'; cursor: string | null; limit: number; }
export type PageRequest = OffsetPageRequest | CursorPageRequest;

export interface PageResult<T> {
  rows: T[];               // ← SDK extractPaginated `data`
  total?: number;          // offset mode (server `count`)
  page?: number; limit?: number; totalPages?: number;
  hasMore?: boolean;       // computed client-side by the SDK
  nextCursor?: string | null;  // cursor mode (INERT today — no server support, D7)
}
// Primary normalizer aligns with the SDK's extractPaginated output (the shape hooks actually return):
export function fromSdkPaginated<T>(r: { data: T[]; total: number; page: number; limit: number; totalPages: number; hasMore: boolean }): PageResult<T>;
// Raw-server fallback (when bypassing the SDK): { data, count, page, limit } → PageResult<T>
export function fromServerPaginated<T>(r: { data: T[]; count: number; page: number; limit: number }): PageResult<T>;
// NOTE: PaginatedQuery.page is 0-based; ContextFiltersDto/PaginatedContextItemResponse.page is 1-based — normalize here.

// lib/shared/query-state.ts
export interface SortRule { id: string; desc: boolean; }
export interface FilterRule<T = unknown> { id: string; operator: FilterOperator; value: T; variant: FilterVariant; }
export interface DataQueryState {
  pagination: PageRequest;
  sorting: SortRule[];
  filters: FilterRule[];
  globalSearch?: string;
}
export function toPaginatedQuery(s: DataQueryState): Record<string,string>; // serializes filters/sort → CSV per PaginatedQuery

// lib/shared/async-collection.ts  (transport-agnostic; works with TanStack Query, SDK hooks, or plain fetch)
export interface AsyncCollection<T> {
  data: T[];
  isLoading: boolean;
  isFetchingNextPage?: boolean;
  error: Error | null;
  hasNextPage?: boolean;
  fetchNextPage?: () => void;
  refetch?: () => void;
  total?: number;
}

// lib/shared/surface.ts
export type Density = 'comfortable' | 'compact';
export interface DensityProps { density?: Density; }
export interface AsyncStateProps {
  isLoading?: boolean;
  error?: Error | null;
  emptyState?: React.ReactNode;
  errorState?: (error: Error) => React.ReactNode;
}
export interface BaseSurfaceProps extends DensityProps { className?: string; }
```

> These four files are the literal "shared interfaces the user wants reused": the grid, timeline, and transcript all accept `BaseSurfaceProps` + `AsyncStateProps`, and the grid + timeline both speak `DataQueryState` / `PageRequest` / `AsyncCollection<T>`.

### 3.2 Existing-vs-new inventory, dependency graph, build order

**Primitive inventory:**

| Building block | Status | Source |
|---|---|---|
| ScrollArea, Skeleton, Tooltip, Popover, DropdownMenu, Command, Dialog, Sheet, Badge, Checkbox, Input, Table, Tabs, Resizable, Collapsible, Separator, Avatar, Progress, Pagination | ✅ exists | `components/shadcn/*` |
| `DataTable` + pagination + view-options + filter type-system/config/helpers | ✅ exists (extend) | `registries/diceui/data-table/*`, `lib/data-table.ts`, `config/data-table.ts`, `types/data-table.ts` |
| Markdown / ResponseStream / CodeBlock | ✅ exists | `registries/prompt-kit/*` |
| Image grid + lightbox | ✅ exists | `registries/tool-ui/image-gallery/*` |
| AudioPlayer / ScrubBar | ✅ exists | `elevenlabs/*` |
| TranscriptViewer (custom + elevenlabs), `use-transcript-viewer`, `use-scribe` | ✅ exists (consolidate) | `custom/`, `elevenlabs/`, `hooks/` |
| Dropzone / upload | ✅ exists | `react-dropzone`, `kibo-ui/dropzone`, `better-upload` |
| `lib/shared/*` interfaces | 🆕 NEW | this ticket |
| `VirtualizedDataGrid` + sub-parts | 🆕 NEW (composes diceui + TanStack Virtual + dnd-kit) | this ticket |
| `HistoryTimelineList` + renderers | 🆕 NEW (composes markdown/image/audio + PDF) | this ticket |
| `LiveTranscript` + sub-parts | 🆕 NEW (consolidates viewers + stick-to-bottom + edit) | this ticket |
| `PdfRenderer` | 🆕 NEW (react-pdf) | this ticket |
| Token migration (globals.css → TASK-371) | 🆕 NEW (prerequisite) | this ticket / TASK-371 |

**Dependency graph (build order, decisions folded in):**

```
0. ⛳ Token migration (globals.css ← TASK-371 theme.css)   ┐ HARD PREREQUISITE (D1)
                                                          │   coordinate w/ TASK-371; smoke-test existing surfaces
1. lib/shared/* interfaces (pagination/query/async/surface) │
2. DensityProvider + status-badge helper (icon: Lucide|Tabler, D2) ┘ foundation
        │
        ├── 3. VirtualizedDataGrid
        │        use-data-grid → shell → toolbar/filters/header/pagination(offset) → skeleton
        │        → use-grid-layout (D8: load/save via useUserSettings, debounced, fallback)
        ├── 4. HistoryTimelineList
        │        use-timeline → item shell → renderers: markdown, image, audio(+word-seek D9), file → pdf(react-pdf, D3) → mixed
        └── 5. LiveTranscript
                 use-live-transcript → segment(+word tokens, D9) → autoscroll/jump-to-live
                 → segment-editor (D4: Lexical, lazy) → click-to-seek wiring (D9) → listening-pulse
6. Consolidation/deprecation (D6): mark losers @deprecated (NOT deleted)
     - data-table: tool-ui variant → @deprecated; diceui promoted into data-grid (canonical)
     - transcript: custom/transcript-viewer → @deprecated; LiveTranscript canonical
7. Barrel exports + Storybook stories + a11y (vitest-axe) gates
```

Order rationale: token migration (D1) is a hard prerequisite for everything; shared interfaces unblock all three components; grid first (highest reuse + most existing scaffolding); timeline second (renderer composition incl. the one new dep, react-pdf); transcript last (most bespoke realtime/edit behavior — now Lexical + word-seek). Deprecation (D6) happens **after** the canonical components exist so consumers have a migration target.

**Consolidation map (D6 — name the canonical, deprecate the duplicate; keep, do NOT delete):**

| Overlap | ✅ Canonical (new/keep) | ⚠️ Marked `@deprecated` (retained) | Migration note |
|---|---|---|---|
| Data table | `@arcaai/ui` `data-grid/VirtualizedDataGrid` (promotes `registries/diceui/data-table`) | `registries/tool-ui/data-table/*` | Point consumers at `VirtualizedDataGrid`; tool-ui formatters can be salvaged as cell renderers |
| Data table (app) | `VirtualizedDataGrid` | `apps/ui-playground/.../admin-data-table.tsx` (reference only) | Superseded once the redesigned console adopts the shared grid |
| Transcript viewer | `@arcaai/ui` `live-transcript/LiveTranscript` | `components/custom/transcript-viewer.tsx` | Re-export a thin shim if needed; deprecate `use-transcript-viewer` only if unused |

> Deprecation = JSDoc `@deprecated` tag + a console-safe note pointing to the canonical component. No file deletions in this ticket (Karpathy: surgical).

### 3.3 Consolidated dependency table (versions verified 2026-06-27 via npm + Context7)

| Package | Installed / Target | Status | Used by | Purpose | Risk |
|---|---|---|---|---|---|
| `@tanstack/react-table` | `^8.21.3` | ✅ installed | Grid | Headless table model (sort/filter/pin/resize/visibility/selection) | Low. Use **v8 stable** `useReactTable`+`getCoreRowModel()` API. v9 (`tableFeatures`/`useTable`) is beta — **defer**. |
| `@tanstack/react-virtual` | `^3.13.23` (latest 3.14.4) | ✅ installed | Grid, Timeline, Transcript | Row (+ optional column) virtualization | Low. Dynamic row measurement; Firefox `measureElement` caveat. |
| `@dnd-kit/core` `/sortable` `/modifiers` `/utilities` | `^6.3.1 / ^10 / ^9 / ^3.2.2` | ✅ installed | Grid | Column reorder (drag handles) | Low. `restrictToHorizontalAxis` + `arrayMove` + `table.setColumnOrder`. |
| `react-markdown` | `^10.1.0` | ✅ installed | Timeline | Markdown rendering (via prompt-kit) | Low. **Do not enable `rehype-raw`**; keep XSS-safe default. |
| `remark-gfm` / `remark-breaks` | `^4.0.1 / ^4.0.0` | ✅ installed | Timeline | GFM tables/strikethrough + line breaks | Low |
| `streamdown` | `^2.5.0` | ✅ installed | Timeline/Transcript | Streaming markdown (for incremental summaries) | Low |
| `shiki` | `^4.0.2` | ✅ installed | Timeline | Code highlighting in markdown | Med (bundle/async highlighter — lazy load) |
| `media-chrome` | `^4.18.2` | ✅ installed | Timeline | Accessible audio player chrome | Low |
| `react-medium-image-zoom` | `^5.4.1` | ✅ installed | Timeline | Image zoom/lightbox | Low |
| `lexical` + `@lexical/*` (`react`, `rich-text`, `markdown`, `selection`, `utils`, …) | `^0.42.0` | ✅ installed | Transcript (edit) | **✅ SELECTED inline segment editor (D4, override)** | Med — heavy core (~tens of KB). **Mitigation:** `segment-editor.tsx` is `React.lazy` + mounted only while a segment is being edited; serialize to plain text on save. |
| `use-stick-to-bottom` | `^1.1.3` | ✅ installed | Transcript | Autoscroll + pause-on-scroll-up + jump-to-live | Low |
| `react-dropzone` | `^15.0.0` | ✅ installed | Timeline (attach) | File upload | Low |
| `framer-motion` / `motion` | `^12.38.0` | ✅ installed | All | Calm motion + breathing pulse | Low (respect reduced-motion) |
| `next-themes` | `^0.4.6` | ✅ installed | All | Dark mode | Low |
| `nuqs` | `^2.8.9` | ✅ installed | Grid | URL-synced query state (optional) | Low |
| `class-variance-authority` / `clsx` / `tailwind-merge` | `^0.7.1 / ^2.1.1 / ^3.5.0` | ✅ installed | All | Variants + `cn()` | Low |
| `lucide-react` | `^1.0.1` | ✅ installed | All (new) | Icon set — **allowed (D2)** | Low |
| `@tabler/icons-react` | `^3.40.0` | ✅ installed | All (new) | Icon set — **also allowed (D2, override)**; one set per component/surface | Low |
| `date-fns` | `^3.6.0` | ✅ installed | Grid/Timeline | Relative timestamps | Low |
| **`react-pdf`** | **`^10.4.1`** | **🆕 NEW — ✅ confirmed (D3)** | Timeline | PDF rendering (viewer) | **Med-High** — see below; lazy + bundled worker |
| **`pdfjs-dist`** | **`^6.0.227`** (peer of react-pdf) | **🆕 NEW — ✅ confirmed (D3)** | Timeline | PDF.js engine + worker (version already proven in-app) | **Med-High** |
| `rehype-sanitize` / `dompurify` | `^6.0.0 / ^3.4.11` | ⚪ optional | Timeline | Only if raw-HTML markdown ever enabled | Add only if needed |
| `@tanstack/react-query` | (consumer apps only) | ⚪ consumer-side — **confirmed NOT a `@arcaai/ui` dep (D5)** | Grid/Timeline | Server-state for paginated fetch | `@arcaai/ui` stays **transport-agnostic** (accept `AsyncCollection`/`PageResult`); apps wire react-query or SDK hooks. Do **not** add to the library. |

**react-pdf / pdf.js risk notes (the one real new dependency):**
- **Worker:** pdf.js needs a web worker (`pdfjs-dist/build/pdf.worker`). Must configure `GlobalWorkerOptions.workerSrc` for Vite (and tsup output) — bundle the worker as an asset, do not CDN-load (offline/self-hosted + HIPAA).
- **SSR:** pdf.js is browser-only → lazy-load `PdfRenderer` with `React.lazy` + Suspense; never import at module top-level in shared barrel.
- **Bundle size:** pdf.js is large (~hundreds of KB). Code-split so the grid/transcript never pull it; only the timeline's PDF renderer loads on demand.
- **Alternatives considered:** native `<iframe>`/`<embed>` (no zoom/page control, inconsistent), `@react-pdf/renderer` (that's a *generator*, not a viewer — wrong tool). **✅ Decided (D3): `react-pdf` + `pdfjs-dist`, lazy-loaded, worker bundled as an asset.** Align `pdfjs-dist` with the version already used in-app (`^6.0.227`, `apps/ui-playground/.../extract-text.ts`) to avoid two PDF.js copies.

### 3.4 Component 1 — `VirtualizedDataGrid`

#### 3.4.1 Purpose + real consumers
A massive, configurable, virtualized datagrid for admin lists. Real consumers + their row models (§2.5):
- **Tenants** → `TenantResponse` (name, mono `key`, `resourceStatus` badge incl. protected system-tenant, `version`); needs search/filter/pagination (closes TASK-371 gap #7).
- **Users & Access** → `UserResponse` (username, role badges from `UserRoleAssignments`, `isServiceAccount`, `lastActiveAt`).
- **Audit Log** → `AuditLogResponse` (action, resourceType, `responsibleUser.displayName`, `responsibleIp`, `success`, before→after `data`/`previousData`); compact density; tens of thousands of rows → virtualization mandatory.

#### 3.4.2 Public API
```ts
export interface VirtualizedDataGridProps<TData> extends BaseSurfaceProps, AsyncStateProps {
  data: TData[];
  columns: ColumnDef<TData>[];                 // native TanStack columnDef (cell/header render props)
  getRowId?: (row: TData) => string;

  // server vs client
  manual?: { sorting?: boolean; filtering?: boolean; pagination?: boolean }; // true → server owns it
  rowCount?: number;                            // required when manual.pagination (offset)
  pageMode?: 'offset' | 'cursor';

  // controlled/uncontrolled query state (all optional → uncontrolled)
  queryState?: DataQueryState;
  defaultQueryState?: Partial<DataQueryState>;
  onQueryStateChange?: (next: DataQueryState) => void;

  // feature toggles
  features?: {
    globalSearch?: boolean; columnSearch?: boolean; facetedFilters?: boolean;
    columnReorder?: boolean; columnResize?: boolean; columnVisibility?: boolean; columnPinning?: boolean;
    rowSelection?: boolean; sorting?: boolean; columnVirtualization?: boolean;
  };

  // selection
  selection?: { value?: RowSelectionState; onChange?: (s: RowSelectionState) => void };

  // pagination
  pageSizeOptions?: number[];                   // default [10,20,50]
  onPaginate?: (req: PageRequest) => void;

  // events
  onRowClick?: (row: TData) => void;
  onColumnChange?: (state: GridLayoutState) => void;

  // layout persistence (D8 — server-persisted via useUserSettings)
  persistence?: {
    key: string;                                // grid instance id, e.g. 'tenants' | 'users' | 'audit-log'
    namespace?: string;                         // default 'ui.data-grid'
    enabled?: boolean;                          // default true; false → in-memory only
    adapter?: GridLayoutPersistenceAdapter;     // default: useUserSettings-backed; injectable for tests/SSR
  };

  // slots
  toolbar?: React.ReactNode;
  actionBar?: React.ReactNode;                  // bulk actions over selection (reuse diceui actionBar)
  estimateRowHeight?: number;                   // virtualization
}

// Persisted layout shape (D8):
export interface GridLayoutState {
  order: string[];                              // ColumnOrderState
  sizing: ColumnSizingState;
  visibility: VisibilityState;
  pinning: ColumnPinningState;
  density: Density;
}
// Transport-agnostic persistence port (default impl wraps useUserSettings; D5 keeps the lib fetch-free):
export interface GridLayoutPersistenceAdapter {
  load: (namespace: string, key: string) => Promise<GridLayoutState | null>;
  save: (namespace: string, key: string, state: GridLayoutState) => Promise<void>;
}

// Headless controller for custom UIs:
export function useDataGrid<TData>(props): { table: Table<TData>; rowVirtualizer; queryState; setQueryState; layout: GridLayoutState; isLayoutReady: boolean };
```
**Compound parts:** `VirtualizedDataGrid.Toolbar`, `.FacetedFilter`, `.ColumnHeader`, `.Pagination`, `.Skeleton`.

#### 3.4.3 Sub-components & deps

| Sub-component | New/Existing | Notes |
|---|---|---|
| `use-data-grid` | 🆕 | wraps `useReactTable` (v8) + `useVirtualizer`; merges `features`; maps `DataQueryState`↔TanStack state |
| grid shell | 🆕 | evolves `diceui/data-table.tsx` to `display:grid` + absolute virtual rows; keeps `getColumnPinningStyle` |
| toolbar | 🆕 | global search (Input + Command), density toggle, view-options |
| faceted filter | 🆕 | reuses `getFilterOperators`/`ExtendedColumnFilter` + Popover + Command |
| column header | 🆕 | sort (DropdownMenu) + pin + hide + dnd drag handle |
| pagination | 🆕 | offset (extends `DataTablePagination`) + cursor (prev/next by `nextCursor`) |
| skeleton | 🆕 | row skeletons per `10-skeleton-loading.mdc` |
| Popover, DropdownMenu, Command, Checkbox, Button, Input, Badge, Tooltip, ScrollArea | ✅ | shadcn |

#### 3.4.4 State, performance, realtime
- TanStack Table holds sort/filter/visibility/pin/order/size/selection; `useVirtualizer` for rows; optional column virtualization for very wide audit rows.
- `manual: true` → server owns sort/filter/paginate; serialize via `toPaginatedQuery` (CSV `filters`/`sort`) → `PaginatedQuery`; normalize response via `fromSdkPaginated` (SDK `extractPaginated` shape) or `fromServerPaginated` (raw `{data,count,page,limit}`).
- Memoize `columns` + cell renderers; stable `getRowId`; `keepPreviousData` semantics on the consumer side to avoid flicker.
- Cursor mode disables jump-to-arbitrary-page (prev/next + "load more") since the server contract is forward-only — **inert until [TASK-373](../TASK-373-Cursor-Pagination-DTO/README.md)** (D7); offset is the only live mode today.

#### 3.4.5 Accessibility, responsive, density
- `role="grid"` with `rowgroup/row/columnheader/gridcell`, `aria-sort`, `aria-selected`, `aria-rowcount`/`aria-rowindex` (virtualization-aware so SR sees true totals).
- Full keyboard: arrow navigation, Home/End, Space/Enter selection, `Ctrl/Cmd+A`, header Enter to sort; drag-reorder has a keyboard alternative (move-left/right in column menu — dnd-kit keyboard sensor).
- 2px visible focus ring (`ring-ring`), 44px min targets (Comfortable). Compact reduces row height but keeps targets ≥ 32px (rule 11). Horizontal scroll with pinned first column on small screens.

#### 3.4.6 States & edge cases
- Loading → `Skeleton` rows; Empty → icon+title+description (`Empty`); Error → `errorState` slot + retry.
- Edge: 0 columns; all columns hidden (force ≥1); pinned col wider than viewport; tens-of-thousands rows scroll perf; rapid filter changes (debounce server search ~300ms); selection persistence across pages (selection by id, not index); RTL (DirectionProvider exists); column resize below min width.

#### 3.4.8 Layout persistence (D8 — server-persisted via `useUserSettings`, overrides earlier localStorage rec)
**Backing API (verified):** `@arcaai/vox` `useUserSettings()` (`packages/agentic-sdk-v2/src/hooks/useUserSettings.ts`) exposes exactly:
- `list(pagination?) → Promise<UserSetting[]>` → `GET /user/me/settings`
- `updateByKey(namespace, key, value) → Promise<UserSetting>` → `PATCH /user/me/settings/:namespace/:key` with body `{ value }`

**Settings key + shape:**
- `namespace = 'ui.data-grid'`, `key = <persistence.key>` (the grid instance id, e.g. `'tenants'`/`'users'`/`'audit-log'`).
- `value = GridLayoutState` → `{ order, sizing, visibility, pinning, density }` (arbitrary JSON; the endpoint's `value` is typed `unknown`).

**Flow (in `use-grid-layout.ts`, behind the default `GridLayoutPersistenceAdapter`):**
1. **Load-on-mount:** call `list()` once, find the entry matching `namespace`+`key`, apply its `value` as initial TanStack state. Until resolved, render with `defaults` and `isLayoutReady=false` (grid is usable immediately — no blocking spinner).
2. **Debounced save:** on any layout change (`onColumnChange` / density toggle) debounce ~500–800ms, then `updateByKey('ui.data-grid', key, nextLayout)`. Coalesce rapid drags/resizes into one PATCH.
3. **Graceful fallback (required):** if settings are unavailable (not authenticated, `error`, endpoint 404, or `enabled:false`) → fall back to **in-memory defaults** (optionally a localStorage cache as a *transient* mirror), never throw, never block the grid. Persistence is best-effort.
4. **Decoupling:** the adapter is injectable (`persistence.adapter`) so `@arcaai/ui` itself stays fetch-free (D5) — the default adapter lives where `@arcaai/vox` is available (app/composition layer), tests pass a fake.

> **⚠️ Backend/SDK dependency flagged (D8):** persistence reuses **existing** endpoints (`GET /user/me/settings`, `PATCH /user/me/settings/:ns/:key`) — **no new schema/migration needed**. The only open item: confirm the user-settings service accepts an **arbitrary `ui.data-grid` namespace + arbitrary `key` + a JSON-object `value`**. If namespaces/keys are server-whitelisted, register `ui.data-grid` (minor config). This does **not** fold into TASK-373 (that's pagination); if a whitelist change is needed, it's a tiny separate backend chore — flag to the backend owner during Phase 4, not a blocker for the grid build.

#### 3.4.7 TDD test list (Vitest; behavior-focused)
- renders rows from `data`; renders empty state when `data=[]` and not loading.
- shows skeleton when `isLoading`; shows error + retry when `error`.
- sorting: clicking header toggles asc→desc→none; emits `onQueryStateChange` with `SortRule`.
- global search updates `globalSearch` in query state (debounced) and, in manual mode, calls consumer not local filter.
- faceted filter: selecting operator+value produces correct `FilterRule`; `getValidFilters` drops empties.
- pagination offset: page/limit change emits `onPaginate({mode:'offset'})`; respects `rowCount`.
- pagination cursor: next uses `nextCursor`; disables "next" when `hasMore=false`; hides numbered pages.
- column visibility toggle hides/shows; cannot hide last visible column.
- column pinning applies sticky style (`getColumnPinningStyle`); pinned header/cell share offset.
- column reorder via keyboard sensor updates order and emits `onColumnChange`.
- row selection by id persists across page change; `Ctrl/Cmd+A` selects filtered set; `actionBar` shows only when selection > 0.
- virtualization: with 50k rows, only a bounded number of row nodes are in the DOM; scroll updates window.
- density prop changes row height token; controlled vs uncontrolled `queryState` both work.
- a11y: `role=grid`, `aria-sort` reflects sort, `aria-rowcount` = true total (vitest-axe: no violations).
- normalizers: `fromSdkPaginated` (SDK `extractPaginated` shape) and `fromServerPaginated` (raw `{data,count,page,limit}`) both map to `PageResult` correctly; 0-based vs 1-based `page` normalized.
- **layout persistence (D8):** on mount, `adapter.load(ns,key)` result is applied to column order/size/visibility/pinning/density; while loading, defaults render and grid is interactive (`isLayoutReady=false`).
- **layout persistence (D8):** a column reorder/resize/visibility/pin/density change triggers a **debounced** single `adapter.save(ns,key, layout)` (rapid changes coalesce to one call).
- **layout persistence (D8):** when the adapter rejects/throws or `enabled:false`, the grid falls back to defaults without throwing and remains usable (best-effort).

### 3.5 Component 2 — `HistoryTimelineList`

#### 3.5.1 Purpose + real consumers
Reverse-chronological, expandable/collapsible, content-type-aware, virtualized history. Real consumer: consultation history + **context items** timeline. Row model = SDK `ContextItem` (§2.5); current reference UI = `apps/ui-playground/src/features/consultation/components/{context-item-list,consultation-workspace,version-detail-panel}.tsx`. Content variants derive from `ContextItemType` (**10**, incl. `SIGNED_NOTE`) + derived booleans (`isMediaType`, `isAiGenerated`, `isAttachment`, …) and `structuredData`.

Content-type → renderer mapping:
| Variant | ContextItemType / signal | Renderer |
|---|---|---|
| markdown | `RAW_SUMMARY`/`MODIFIED_SUMMARY`/`PRE_SUMMARY`/`CASE_NOTE`/`WORKNOTE` (`content`) | `markdown-renderer` (prompt-kit `Markdown`) |
| audio | `AUDIO_RECORDING` (pre-expanded `audioRecordings[]`) | `audio-renderer` (elevenlabs `AudioPlayer`) — **+ optional word-level transcript w/ click-to-seek (D9)** when a paired `TRANSCRIPT` with `wordTimestamps` exists |
| image grid | `ATTACHMENT` images / `structuredData` | `image-grid-renderer` (tool-ui `GalleryGrid` + lightbox) |
| pdf | `ATTACHMENT` pdf mime | `pdf-renderer` (🆕 react-pdf) |
| file | `ATTACHMENT` other | `file-renderer` (icon + name + size + download) |
| transcript | `TRANSCRIPT` (`structuredData` segments) | markdown/plain (or embed read-only `LiveTranscript`) |
| signed note | `SIGNED_NOTE` (`content` markdown or `mediaId` PDF) | markdown-renderer or pdf-renderer + signed/attestation badge |
| named entity | `NAMED_ENTITY` (`namedEntities[]`) | chips (reuse entity rendering) |
| mixed | item with audio+images+files+text | `mixed-renderer` (composes the above) |

> **Media resolution:** `ATTACHMENT`/`SIGNED_NOTE` expose only `mediaId` → resolve to `MediaEntity` (`mimeType`/`uri`/`extension`/`size`) via a storage lookup to pick the right renderer (pdf vs image vs file). `AUDIO_RECORDING` is pre-expanded into `audioRecordings[]` (no extra lookup). The `mapItem` adapter owns this resolution.

#### 3.5.2 Public API
```ts
export interface TimelineItemModel {
  id: string;
  timestamp: string | Date;                 // ContextItem.createdAt
  title?: React.ReactNode;
  variant: TimelineContentVariant;          // 'markdown'|'pdf'|'image'|'audio'|'file'|'mixed'|'custom'
  content: TimelineContent;                  // discriminated union per variant
  badges?: TimelineBadge[];                  // AI / type / status (icon+label+color)
  defaultExpanded?: boolean;
  meta?: Record<string, unknown>;            // passthrough (e.g. source ContextItem)
}

export interface HistoryTimelineListProps<TItem = TimelineItemModel> extends BaseSurfaceProps, AsyncStateProps {
  items: TItem[];                            // newest-first (component does not reorder by default)
  order?: 'desc' | 'asc';                    // default 'desc' (reverse-chron)
  mapItem?: (raw: TItem) => TimelineItemModel; // adapter from ContextItem → model
  collection?: AsyncCollection<TItem>;       // infinite scroll source (fetchNextPage)
  renderers?: Partial<Record<TimelineContentVariant, TimelineRenderer>>; // override/extend
  expansion?: { value?: string[]; onChange?: (ids: string[]) => void; mode?: 'single' | 'multiple' };
  onItemExpand?: (id: string, expanded: boolean) => void;
  onMediaOpen?: (itemId: string, mediaIndex: number) => void;
  estimateItemHeight?: number;
  lazyMedia?: boolean;                        // default true
}

export function useTimeline<TItem>(props): { items; expandedIds; toggle; virtualizer; onEndReached };
```

#### 3.5.3 Sub-components & deps

| Sub-component | New/Existing |
|---|---|
| `use-timeline` (ordering, expansion, virtualizer, infinite onEndReached) | 🆕 |
| `timeline-item` (Collapsible shell + header: timestamp via `date-fns`, badges, expand affordance) | 🆕 (uses `Collapsible`, `Badge`) |
| `markdown-renderer` | 🆕 thin wrapper over prompt-kit `Markdown` ✅ |
| `image-grid-renderer` | 🆕 thin wrapper over tool-ui `GalleryGrid`/`useImageGallery` ✅ |
| `audio-renderer` | 🆕 wrapper over elevenlabs `AudioPlayer`/`ScrubBar` ✅ — **D9: when a paired transcript carries `wordTimestamps`, render clickable word tokens → `useAudioPlayer().seek(word.start)`** (reuses `transcript-word.tsx`) |
| `pdf-renderer` | 🆕 + **react-pdf** (lazy/Suspense) |
| `file-renderer` | 🆕 (icon + name + size + download) |
| `mixed-renderer` | 🆕 (composition) |
| Collapsible, ScrollArea, Skeleton, Badge, Dialog (lightbox), AspectRatio | ✅ |

#### 3.5.4 State, performance, realtime
- Virtualize with `useVirtualizer` (dynamic measurement — items vary wildly: a 1-line worknote vs a 20-image grid vs a PDF). Expanded items re-measure.
- **Lazy media:** images `loading="lazy"` (already in `GalleryGrid`); audio loads metadata only until played; **PDF renderer is `React.lazy` + only mounts when its item expands**; lightbox image full-res only on open.
- Infinite scroll via `collection.fetchNextPage()` when a sentinel near the end becomes visible (IntersectionObserver or virtualizer range); `isFetchingNextPage` → bottom skeleton.
- Optimistic edit not in scope here (edits happen in `version-detail-panel`); timeline reflects updated `ContextItem` on refetch.

#### 3.5.5 Accessibility, responsive, density
- `role="feed"` with each item `role="article"` + `aria-expanded` + `aria-labelledby` (feed pattern suits lazily-loaded reverse-chron history). Expand/collapse keyboard operable; expansion state announced.
- Lightbox = focus-trapped `Dialog`, ESC closes, arrow keys navigate, focus restored to the triggering thumbnail (the `GalleryGrid` button already manages focus rings).
- Audio/PDF controls keyboard reachable; PDF page nav has labels.
- Density adjusts item padding + header size; responsive image grid columns (`@container` already in `GalleryGrid`). Reduced-motion disables expand animation.

#### 3.5.6 States & edge cases
- Loading (initial) → skeleton items; Empty → "No history yet"; Error → retry; per-item media error → inline error (image `onError` exists; PDF load failure → fallback download link; audio src 404 → message).
- Edge: huge image grids (cap initial render, "show all"); very long markdown (clamp collapsed preview ~200 chars per rule 11 §8, full on expand); mixed item ordering of sub-media; unknown `ContextItemType` → `file`/generic fallback; PDF with hundreds of pages (render visible page only); time-zone/relative-time formatting.

#### 3.5.7 TDD test list
- renders items newest-first; respects `order='asc'`.
- selects correct renderer per `variant`; unknown variant → fallback renderer.
- `mapItem` adapts a `ContextItem` (with derived booleans) to the right variant.
- expand/collapse toggles content; `mode:'single'` collapses others; emits `onItemExpand`.
- image renderer opens lightbox on click; `onMediaOpen` fires with index; ESC closes + restores focus.
- pdf renderer is not mounted until item expanded (lazy); shows fallback on load error.
- audio renderer mounts player; does not autoplay.
- infinite scroll: reaching end calls `collection.fetchNextPage`; bottom skeleton while `isFetchingNextPage`; stops when `hasNextPage=false`.
- virtualization bounds DOM nodes for long histories; expanded item re-measures.
- markdown renderer does not execute raw HTML/script (XSS-safe).
- **audio word-seek (D9):** when an audio item has a paired transcript with `wordTimestamps`, clicking a word calls `seek(word.start)`; with no word data the plain player still renders (no crash).
- a11y: `role=feed`/`article`, `aria-expanded` correct (vitest-axe clean).
- density + dark mode render without hardcoded colors (token classes present).

### 3.6 Component 3 — `LiveTranscript`

#### 3.6.1 Purpose + real consumers
Realtime captioning view for a live consultation, with **inline editing (Lexical, D4)** and **word-level timestamps + click-to-seek (D9)**. Data via `@arcaai/vox` — `audio.transcriptSegments: TranscriptSegment[]` + `audio.currentTranscript` + `audio.isCapturing/isSpeaking` (`useArca().audio`/`useArcaAudio()`). Consumers: `transcription-local`/`transcription-remote`, `basic-consultation.tsx`, `transcription.tsx`, `dev/stt-v2.tsx` (per knowledge doc §7). This is the **canonical** transcript component (D6); `custom/transcript-viewer.tsx` is marked `@deprecated` (kept).

> **⚠️ Word-level data source (D9 verification, see §2.5):** word timings are **emitted on the wire** as `WsTranscriptResult.wordTimestamps?: { word; start; end; confidence }[]` (origin: stt-v2 `SegmentResult.word_timestamps`), but the store path `audio.transcriptSegments` (`TranscriptSegment`) and the `onTranscription` callback (`TranscriptionResult` → segment-level `TranscriptionSegment {start,end,text,speaker?}`) **drop them**. So to deliver D9 the consumer must feed the component from **`SttV2WebSocketClient.onTranscript`** (rich `WsTranscriptResult`), OR the SDK must be extended to carry words through the store (flagged below). `confidence` is `null` for the Whisper engine — render words even when confidence is absent.

#### 3.6.2 Public API
```ts
export interface LiveTranscriptSegment {           // superset of store TranscriptSegment AND wire WsTranscriptResult
  id: string;                                       // derive from seq/utteranceIndex when present
  text: string;
  startTime?: number; endTime?: number;
  isFinal: boolean;                                 // interim vs final styling
  stableChars?: number;                             // committed-prefix length on partials (render tail tentatively)
  speakerLabel?: string;                            // diarization (Doctor/Patient/Speaker N)
  speakerConfidence?: number; confidence?: number; language?: string;
  englishText?: string;                             // code-switching gloss
  resultType?: 'segment' | 'gloss';
  wordTimestamps?: { word: string; start: number; end: number; confidence: number }[];
}

export interface LiveTranscriptProps extends BaseSurfaceProps, AsyncStateProps {
  segments: LiveTranscriptSegment[];               // final/committed segments
  interim?: string;                                 // audio.currentTranscript (live partial)
  isListening?: boolean;                            // drives ambient pulse
  // editing (D4 — Lexical inline editor)
  editable?: boolean;
  onEditSegment?: (id: string, text: string) => void | Promise<void>;  // persists via context.updateItem
  editingPolicy?: 'final-only' | 'all';            // default final-only (interim not editable)
  // word-level timestamps + click-to-seek (D9)
  showWords?: boolean;                              // render per-word tokens when wordTimestamps present
  audioController?: { seek: (seconds: number) => void; currentTime?: number };  // e.g. useAudioPlayer()
  onWordClick?: (seg: LiveTranscriptSegment, word: { word: string; start: number; end: number }) => void;
  // diarization
  speakers?: Record<string, { label: string; colorRole?: 'ai'|'success'|'warning'|'primary'|'info' }>;
  showTimestamps?: boolean; showSpeakers?: boolean; showConfidence?: boolean;
  // scrolling
  autoScroll?: boolean;                             // default true (with pause-on-scroll-up)
  // infinite history (older segments)
  collection?: AsyncCollection<LiveTranscriptSegment>;  // load older on scroll-up
  // slots / render props
  renderSegment?: (seg: LiveTranscriptSegment, ctx: { isEditing: boolean }) => React.ReactNode;
  emptyState?: React.ReactNode;
  estimateSegmentHeight?: number;
}

export function useLiveTranscript(props): {
  virtualizer; scrollRef; isPinnedToBottom; jumpToLive;
  editingId; beginEdit; cancelEdit; saveEdit;          // saveEdit serializes Lexical editor → plain text
  activeWord?: { segmentId: string; index: number };   // highlight word at audioController.currentTime (D9)
  seekToWord: (seg: LiveTranscriptSegment, wordIndex: number) => void;
};
```
**Compound parts:** `LiveTranscript.Segment`, `.JumpToLive`, `.ListeningPulse`.

#### 3.6.3 Sub-components & deps

| Sub-component | New/Existing |
|---|---|
| `use-live-transcript` (segments buffer, `use-stick-to-bottom` integration, edit buffer, virtualizer, active-word tracking) | 🆕 + `use-stick-to-bottom` ✅ |
| `transcript-segment` (speaker badge, timestamp, interim italic/muted vs final, word tokens, edit affordance) | 🆕 |
| `segment-editor` (**D4 — Lexical** `LexicalComposer` + `PlainTextPlugin`/`RichTextPlugin` + `OnChangePlugin`; save/cancel; **`React.lazy`**) | 🆕 + `lexical`/`@lexical/react` ✅ |
| `transcript-word` (**D9** — clickable per-word token; active highlight; calls `seekToWord`) | 🆕 |
| `jump-to-live` (floating button when scrolled up; appears with new content) | 🆕 (Button) |
| `listening-pulse` (ambient breathing dot; reduced-motion → static) | 🆕 (reuses TASK-371 pulse) |
| ScrollArea, Badge, Button, Skeleton, Tooltip | ✅ |

#### 3.6.4 State, performance, realtime
- Append-mostly buffer keyed by segment `id`; interim segment is a single live row replaced on finalization (avoid list churn → stable keys).
- Virtualize for long sessions; **autoscroll via `use-stick-to-bottom`**: stays pinned to bottom while at bottom; **pauses when user scrolls up**; `jump-to-live` re-pins. New-content indicator when paused.
- **Edit-state model (D4 — Lexical, overrides Textarea):** non-editing rows render as **plain text/word tokens** (no editor mounted — keeps virtualized rows light). On `beginEdit(id)`: lazy-load `segment-editor` (`React.lazy` + Suspense), mount **one** Lexical instance seeded with the segment's text via an initial `EditorState`, autofocus. `OnChangePlugin` holds the draft in the controller's edit buffer; **`saveEdit` serializes the editor to plain text** (`$getRoot().getTextContent()`), calls `onEditSegment(id, text)`; `cancelEdit`/Esc discards and unmounts. Only one segment editable at a time. Editing disabled for interim segments by default (`editingPolicy='final-only'`). **Rationale:** Lexical gives a robust, accessible, controlled contentEditable (IME/paste-safe) and a path to richer editing later; cost is mitigated by lazy-mounting only the row under edit.
- **Optimistic edit:** on save, update local segment immediately; on failure, revert + `toast.error` (rule 11 §5).
- **Word-level + click-to-seek (D9):** when `showWords` and a segment has `wordTimestamps`, render each word via `transcript-word`. Clicking a word calls `seekToWord` → `audioController.seek(word.start)` (the elevenlabs player's `useAudioPlayer().seek(seconds)`; verified API) and fires `onWordClick`. When `audioController.currentTime` is provided, the controller derives `activeWord` (binary-search words by `[start,end)`) to highlight the spoken word during playback (karaoke-style). **No audio attached → words still render but are non-interactive (no seek);** live capture has no seekable file, so click-to-seek is primarily for review/playback (and `HistoryTimelineList` audio items). **Timebase caveat:** `word.start` is **session-relative seconds**; the seekable source's `currentTime` must share that origin — for a single continuous recording this holds; for multi-clip sessions map the word to the correct recording first.
- Backpressure/reconnection are the **SDK's** responsibility (per assumption A3/§1.3); the component only reacts to prop changes. Document that high-frequency interim updates should be throttled by the consumer/SDK (~10–20/s) to avoid re-render storms; component memoizes finalized rows + word tokens.
- Skeleton loading while initial segments load; older-history infinite scroll via `collection.fetchNextPage` on scroll-up (prepend without losing scroll position).

#### 3.6.5 Accessibility, responsive, density
- Container `role="log"` `aria-live="polite"` `aria-relevant="additions"` so SRs announce new final segments (interim NOT announced to avoid spam — `aria-live="off"` on the interim row).
- **Editing (D4/Lexical):** the Lexical `ContentEditable` exposes `role="textbox"` `aria-multiline="true"` + an `aria-label` ("Edit transcript segment"); Save/Cancel buttons labelled; **Esc cancels, ⌘/Ctrl+Enter saves**; focus moves into the editor on open and returns to the segment on close. The live region is paused/`aria-live="off"` while a segment is being edited to avoid announcement churn.
- **Words (D9):** each `transcript-word` is a real `<button>` (keyboard focusable, Enter/Space seeks) with `aria-label` like "Jump to 00:12 — \"hello\""; the active word gets `aria-current="true"`. When no `audioController` is present, words render as non-interactive `<span>`s (no fake buttons).
- Speaker labels are text + color (never color-only); confidence shown as text/badge, not color alone.
- `jump-to-live` keyboard reachable; focus not stolen during autoscroll. Reduced-motion: pulse static, autoscroll instant (no smooth).
- Density adjusts line spacing/segment padding; responsive full-height panel.

#### 3.6.6 States & edge cases
- Empty → "No transcript yet. Start recording…" (matches knowledge doc §3.5). Not-listening vs listening (pulse). Paused-autoscroll with backlog. Editing a segment while new segments arrive (don't scroll away from the edit; keep edit focus). Very long single segment. Missing speaker/timestamp/confidence (graceful). Save failure (revert + toast). Interim → final transition must not duplicate a row. Network drop (SDK sets error → show inline banner, keep existing transcript).
- **D4 (Lexical):** editor chunk still loading → show the static text + a small spinner on the row until the lazy editor mounts (never block the list). Lexical must mount/unmount per edit without leaking listeners. Paste into the editor is normalized to plain text on save.
- **D9 (words):** segment without `wordTimestamps` → render plain text (no tokens). `wordTimestamps` present but no `audioController` → words render non-interactive. `word.confidence === null` (Whisper) → still render (no confidence styling). Word/seek timebase mismatch (multi-recording) → resolve target clip before seeking; if unresolved, disable seek for that segment.

#### 3.6.7 TDD test list
- renders final segments; interim text shows in italic/muted distinct from final.
- when `stableChars` is set on a partial, the committed prefix renders settled and only the tail renders tentative.
- a `resultType:'gloss'` result attaches/links to its final by `utteranceIndex` rather than appending a duplicate row.
- new final segment appended; interim replaced (not duplicated) on finalization.
- autoscroll pinned at bottom on new content; **pauses when scrolled up**; `jump-to-live` appears and re-pins.
- editable=false hides edit affordance; final-only policy blocks editing interim.
- **edit (D4/Lexical):** non-editing rows mount **no** Lexical instance; `beginEdit` lazy-mounts the editor seeded with the segment text and autofocuses; only one editor at a time.
- **edit (D4/Lexical):** `saveEdit` serializes the Lexical editor to **plain text** and calls `onEditSegment(id, text)`; optimistic update shown immediately; revert + error on rejection; Esc cancels (no call), ⌘/Ctrl+Enter saves.
- **words (D9):** segments with `wordTimestamps` render clickable word tokens; clicking a word calls `audioController.seek(word.start)` and `onWordClick`.
- **words (D9):** with `audioController.currentTime` advancing, the matching word gets the active highlight (`aria-current`); without `audioController`, words render as non-interactive spans (no seek).
- **words (D9):** a segment without `wordTimestamps` renders plain text and does not crash; `confidence:null` words still render.
- speaker labels render with text + color role; timestamps render when `showTimestamps`.
- skeleton shown when `isLoading`; empty state when no segments and not listening.
- listening pulse present when `isListening`; static under reduced-motion.
- older-history scroll-up triggers `collection.fetchNextPage`; scroll position preserved on prepend.
- virtualization bounds DOM nodes for thousands of segments.
- a11y: `role=log` + `aria-live=polite`; interim row not in live region; Lexical editor is `role=textbox`/labelled; word buttons labelled; live region paused during edit (vitest-axe clean).

### 3.7 Integration map (binding to real data)

| Component | Real source | Binding |
|---|---|---|
| VirtualizedDataGrid — Tenants | `TenantResponse` via `GET /api/v1/tenants` (`Paginated<T>`) + SDK `useTenants` | columns from `BaseResponse`+Tenant fields; `manual` server mode; `toPaginatedQuery`→`PaginatedQuery`; `fromSdkPaginated`→`PageResult`; protected system-tenant row (TASK-371 X4); **layout persists via `useUserSettings` (`ui.data-grid`/`tenants`, D8)**. |
| VirtualizedDataGrid — Users | `UserResponse` (+`UserRoleAssignments`) via `useUsers` | role badges (icon+label+color); `isServiceAccount` badge; `lastActiveAt` relative time. |
| VirtualizedDataGrid — Audit | `AuditLogResponse` via `useAuditLog` | compact density; `responsibleUser.displayName`; `success` status badge; before→after from `data`/`previousData` in a detail panel/expand. |
| HistoryTimelineList | `ContextItemResponse[]` via `useArca().context` (`getItems`/`getContextItemsPaginated`), or `ConsultationTimelineResponse` events; consultation = `ConsultationEntity` (chain via `parentConsultationId`) | `mapItem` → variant by `type` (10, incl. `SIGNED_NOTE`)/derived `is*` booleans; resolve `mediaId`→`MediaEntity` for PDF/image/file; audio pre-expanded in `audioRecordings[]`; versions from `versions[]`. |
| LiveTranscript | **Rich path required for D9:** `SttV2WebSocketClient.onTranscript` → `WsTranscriptResult` (stableChars/`wordTimestamps`/speakerLabel/gloss). Simple path (`audio.transcriptSegments` + `currentTranscript`) works but has **no word timings**. | `segments`/`interim`/`isListening` props; **Lexical** inline edit persists via `context.updateItem` (D4); **word click-to-seek** wired to `useAudioPlayer().seek` (D9); per-provider store (`useArcaStore`); reconnect/backpressure owned by SDK. |

> Cross-cutting: TASK-371 X1 (404-over-403), X2 (soft-delete = `resourceStatus`), X6 (audit) are enforced server-side; the grid simply renders `resourceStatus` and audit rows. The grid/timeline must not assume cross-tenant data (SDK store is per-tenant, defense-in-depth per rule 08).

#### 3.7.1 Backend / SDK dependencies flagged by the ratified decisions

| From | Dependency | Status | Action / Owner |
|---|---|---|---|
| **D7** | Generic **cursor pagination** DTO + endpoint (server) | **Missing** — no cursor contract exists | New ticket **[TASK-373](../TASK-373-Cursor-Pagination-DTO/README.md)** (Pending). Grid ships offset-first; cursor mode inert until it lands. |
| **D9** | **Word-level timings reach the component.** Backend **already emits** them (`WsTranscriptResult.wordTimestamps`; stt-v2 `SegmentResult.word_timestamps`). | **Resolved** — wire ✅, store ✅ (2026-06-27) | **Option A (no backend change):** consumer feeds the component from `SttV2WebSocketClient.onTranscript`. **Option B (✅ implemented 2026-06-27):** extended `TranscriptionResult` + `StreamingBackendSTTProvider.normalizeTranscript` + store `TranscriptSegment` (+ new `TranscriptWord`/`WordTimestamp`) + the `useArcaAudio` `onTranscription` bridge to carry `wordTimestamps` so `audio.transcriptSegments[].words` exposes words. Owner: SDK (`@arcaai/vox`). See Change History. |
| **D9** | **Whisper `confidence`** is `null` per word | Known | Component renders words without confidence styling when null. No action. |
| **D8** | **Per-user grid layout** persistence | **Available** — `GET /user/me/settings`, `PATCH /user/me/settings/:ns/:key` exist | **No new schema.** Only confirm the settings service permits namespace `ui.data-grid` + arbitrary key + JSON value; if whitelisted, add the namespace (tiny backend config). **Not** part of TASK-373; flag to backend owner in Phase 4. |
| **D1** | **Teal token migration** of `@arcaai/ui/styles/globals.css` | Cross-ticket | Coordinate with **TASK-371** (owns `theme.css`); build step 0; smoke-test all existing `@arcaai/ui` consumers (breaking visual change). |

### 3.8 Resolved Decisions log

All nine decisions ratified **2026-06-27**. Three (**D4, D8, D9**) override the original recommendation — the specs above have been adjusted, not just annotated.

| # | Decision | ✅ Choice (2026-06-27) | Rationale | Downstream impact (where propagated) |
|---|---|---|---|---|
| **D1** | Token migration of `@arcaai/ui/styles/globals.css` (legacy green → TASK-371 teal) | **YES — migrate first**, as recommended; single token source, coordinated with TASK-371 | Prerequisite for "token-driven/on-brand"; one source of truth avoids drift | **Build step 0** (§3.2); coordination note (§2.6); TASK-371 Change History back-reference; §3.7.1 dep row |
| **D2** | Icon library for new components | **BOTH Lucide and Tabler allowed** *(override — was Lucide-only)* | Both already installed + first-class; forcing one creates needless churn | §3.1.3 icon guideline (one set per surface); §2.7 gap #7; dep table adds `@tabler/icons-react` |
| **D3** | PDF rendering library | **`react-pdf` + `pdfjs-dist`**, lazy, bundled worker, as recommended | Real viewer (zoom/pages); PDF.js version already proven in-app; offline/HIPAA-safe | Dep table (confirmed); `PdfRenderer` risk notes (§3.3); timeline renderer (§3.5) |
| **D4** | Transcript inline editor | **LEXICAL** *(override — was lightweight Textarea)* | Robust controlled contentEditable (IME/paste/a11y) + path to richer editing; cost mitigated by lazy-mount | `LiveTranscript` editable spec (§3.6.1–3.6.6); `segment-editor.tsx` (§3.1.1, §3.6.3); dep table Lexical row; TDD §3.6.7; A6 |
| **D5** | Server-state lib in `@arcaai/ui` | **Transport-agnostic** (no `react-query` dep), as recommended | Keep the library fetch-free; apps own data fetching | Dep table react-query row; `AsyncCollection`/`PageResult` contracts; D8 persistence adapter is injectable (§3.4.8) |
| **D6** | Consolidate duplicates | **Deprecate (keep, not delete)**, as recommended; canonical named | One blessed component per surface; surgical (no deletions) | Consolidation map (§3.2); build step 6; `LiveTranscript`/`VirtualizedDataGrid` marked canonical (§3.6.1, §3.1.1) |
| **D7** | Cursor pagination contract (server) | **Open a backend ticket**, as recommended | No server cursor contract exists; don't over-build UI | **[TASK-373](../TASK-373-Cursor-Pagination-DTO/README.md)** created (stub, Pending); cross-linked header + §2.5 + §3.4.4 + §3.7.1; cursor mode inert |
| **D8** | Per-user grid layout persistence | **Server-persisted via `useUserSettings`** *(override — was localStorage)* | Layout follows the user across devices; reuses existing settings endpoints | New §3.4.8 persistence spec; `persistence`/`GridLayoutState`/adapter API (§3.4.2); `use-grid-layout.ts` (§3.1.1); TDD §3.4.7; A9; §3.7.1 dep row |
| **D9** | Word-level timestamps + click-to-seek | **BUILD NOW** *(override — was defer)* | Backend already emits word timings; high clinician value (US 25) | `LiveTranscript` word spec (§3.6.1/2/4/5/6); `transcript-word.tsx` (§3.1.1, §3.6.3); audio renderer (§3.5); TDD §3.6.7 + §3.5.7; A10; **SDK plumbing flagged** (§3.7.1) |

**D9 verification (required by the decision):** word-level timings **are emitted** — `WsTranscriptResult.wordTimestamps?: { word; start; end; confidence }[]` (`packages/agentic-sdk-v2/src/types/stt-v2.ts`), sourced from stt-v2 `SegmentResult.word_timestamps` (`apps/stt-v2/src/stt_v2/streaming/schemas.py`). **However** the store path (`audio.transcriptSegments` → `TranscriptSegment`) and the `onTranscription` callback (`TranscriptionResult` → segment-level `TranscriptionSegment`) **do not carry them**, and `StreamingBackendSTTProvider.normalizeTranscript` drops them. **→ Concrete dependency (flagged §3.7.1):** consume `SttV2WebSocketClient.onTranscript` directly (no backend change), or extend the SDK store path to plumb `wordTimestamps`. The audio player's `useAudioPlayer().seek(seconds)` (`packages/ui/src/components/elevenlabs/audio-player.tsx`) is verified for click-to-seek.

#### 3.8.1 D10 — resolved post-ratification (admin-console target)

| # | Question | Status |
|---|---|---|
| **D10** | **Admin-console target.** `.cursor/rules/07-react-ui.mdc` lists a standalone `apps/admin` (Ant Design/Jotai, port 5174); `knowledge/playground/README.md` says the live console is embedded in `apps/ui-playground` (`src/features/admin/*`). Which app actually consumes `VirtualizedDataGrid`? | **🟢 Resolved (post-ratification, 2026-06-30)** — the real consumer is the **redesigned `apps/admin`** TanStack-Router console (`@arcaai/admin`), which adopts all three components via `features/data-grid/responsive-data-grid.tsx` (Tenants/Users grids), the `/audit-log` cursor grid, `/history` timeline, and `/live` transcript. Integration delivered under **[TASK-374](../TASK-374-Admin-App-Integration/README.md) (Completed)**; the legacy `apps/ui-playground` admin tables are the superseded reference. |

---

## 4. Implementation Summary

Phase 4 implemented the full shared-component system in `@arcaai/ui` via TDD (tests first → RED → GREEN → refactor), in the planned build order. **48 new files** were created and **6 existing files** modified.

### 4.1 What was built (by build-order step)

**Step 0 — Token migration (D1).** `src/styles/globals.css` migrated from the legacy green OKLCH theme to TASK-371's **Calm Clinical Teal** tokens (light + dark), preserving every CSS-variable **name** so existing consumers don't break (values changed, contract stable). magicui `--color-1..5` and existing animations retained.

**Step 1 — Shared contracts (`src/lib/shared/*`) + `src/components/shared/*`.**
- `pagination.ts` — `OffsetPageRequest`/`CursorPageRequest`/`PageRequest`/`PageResult<T>` + `fromSdkPaginated`/`fromServerPaginated` normalizers (the 3 server shapes).
- `query-state.ts` — `SortRule`/`FilterRule`/`DataQueryState` + `toPaginatedQuery` (serializes sort/filters to the backend CSV `PaginatedQuery`).
- `async-collection.ts` — transport-agnostic `AsyncCollection<T>` (works with TanStack Query, SDK hooks, or plain fetch — **no `react-query` dep**, D5).
- `surface.ts` — `Density`/`DensityProps`/`AsyncStateProps`/`BaseSurfaceProps` + `DENSITY_ROW_HEIGHT`/`DENSITY_PADDING_Y`.
- `components/shared/` — `DensityProvider`/`useDensity` + a shared `StatusBadge` (label-always, icon-optional; "status never color-only").

**Step 2 — The three flagship components** (each = headless `use-*` controller + presentational shell + sub-parts):
- **`VirtualizedDataGrid`** (`components/data-grid/`) — TanStack Table v8 + TanStack Virtual + dnd-kit column reorder; sorting, faceted/global filter, column resize/visibility/pinning, row selection, density, skeleton, offset pagination (+ inert cursor path, D7). **D8**: `use-grid-layout.ts` persistence adapter (load-on-mount, debounced save, graceful fallback) over an injectable settings port.
- **`HistoryTimelineList`** (`components/timeline/`) — reverse-chronological, virtualized, content-type-aware feed with a renderer registry: markdown, **PDF (D3, lazy `react-pdf` + bundled worker)**, image grid, audio (with word-seek, D9), file, mixed, custom, fallback. Infinite scroll via `AsyncCollection`.
- **`LiveTranscript`** (`components/live-transcript/`) — realtime final/interim segments, `stableChars` partials, virtualization, autoscroll + jump-to-live, speaker diarization, **inline Lexical editor (D4, lazy-mounted)** with optimistic update + revert-on-reject toast, **word-level timestamps + click-to-seek (D9)** via `transcript-word.tsx` and an injected `AudioController.seek`.

**Step 3 — D6 consolidation + barrel.** Canonical components named; duplicates marked `@deprecated` (kept, not deleted) pointing to the canonical; `src/index.ts` exports the new surface.

### 4.2 New dependencies

| Package | Version | Why | Bundling |
|---|---|---|---|
| `react-pdf` | `^10.4.1` | PDF rendering (D3) | **external** in `tsup.config.ts` (consumer code-splits) |
| `pdfjs-dist` | `5.4.296` (pinned) | pdf.js engine; **pinned to match `react-pdf@10.4.1`'s internal pdfjs** to avoid a worker/API version mismatch | **external** in `tsup.config.ts` |

`@tabler/icons-react` (D2), `lexical`/`@lexical/react` (D4), `use-stick-to-bottom`, and `sonner` were **already installed** — no new install needed; this pass simply consumes them.

### 4.3 D9 SDK status — **no SDK change required (Option A)**

Verified the SDK already surfaces word timings end-to-end: `SttV2WebSocketClient.onTranscript(cb: (r: WsTranscriptResult) => void)` (`packages/agentic-sdk-v2/src/core/SttV2WebSocketClient.ts:439`), normalized at `:721–743`, emitted at `:813`; `WsTranscriptResult.wordTimestamps` (`…/types/stt-v2.ts:242`). The new components accept word data **through their interfaces** (`LiveTranscriptSegment.wordTimestamps`, `TimelineTranscriptSegment.words`) and wire click-to-seek to an injected `AudioController.seek(seconds)`. Per §3.7.1 **Option A (recommended)**, the consumer feeds the component from `onTranscript` — so **no SDK/store plumbing was needed in this pass** (Option B, extending `normalizeTranscript`/the store, remained an optional SDK follow-up only if a consumer must read words from `audio.transcriptSegments`).

> **Update (2026-06-27): Option B has since been implemented in `@arcaai/vox`.** Word timings now also flow through the SDK store path — `audio.transcriptSegments[].words` (new optional `TranscriptWord[]`) carries them via `StreamingBackendSTTProvider.normalizeTranscript` → the `useArcaAudio` final-segment bridge. Both options are now available (socket *or* store); fully back-compatible. See the Change History entry for files, tests, and verification.

### 4.4 D8 settings-namespace status

The `use-grid-layout` persistence adapter is **fully implemented** (debounced save, load-on-mount, graceful no-op fallback) and is **injectable/transport-agnostic** (D5) — it takes a settings port rather than importing a fetcher. **Flagged backend follow-up:** confirm the `useUserSettings` service whitelists the `ui.data-grid` namespace (`GET /user/me/settings`, `PATCH /user/me/settings/:ns/:key`). Until then the adapter degrades gracefully (in-memory only), so the grid is fully functional without persistence.

### 4.5 Deviations from the plan (all surgical; no behavior change)

1. **Lazy dynamic imports use a `.js` specifier + an `as unknown as` cast** (`pdf-renderer.tsx`, `transcript-segment.tsx`). The package builds to **CJS+ESM under `moduleResolution: NodeNext`**; tsup's dts bundler leaves un-inlined `import()` calls for `tsc`, which (a) requires an explicit extension on relative dynamic imports and (b) views the default export under CJS interop. esbuild rewrites `.js`→`.tsx` and resolves `.default` correctly for both bundles at runtime, so this is types-only.
2. **`pdf-document.tsx` worker line carries one documented `@ts-expect-error`** — `new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url)` is the canonical bundled-worker pattern (D3, offline/HIPAA-safe, no CDN), but `import.meta` is a hard error under the package's CJS dts target (TS1470). esbuild handles it for both bundles; the directive has a description so it passes `ban-ts-comment`.
3. **Four new names are intentionally NOT re-exported from the root barrel** to avoid collisions with pre-existing exports (still importable via their component subpath barrels): shared `StatusBadge` (collides with the tool-ui formatter `StatusBadge`), `TranscriptSegment` & `TranscriptWord` components (collide with `use-transcript-viewer` **type** exports), and `TimelineItem` (collides with the diceui `TimelineItem`).

### 4.6 D6 consolidation applied

| Overlap | Canonical (new) | Marked `@deprecated` (kept) |
|---|---|---|
| Data table | `VirtualizedDataGrid` | `components/registries/tool-ui/data-table` → `DataTable` JSDoc `@deprecated` → `VirtualizedDataGrid` |
| Transcript viewer | `LiveTranscript` | `components/custom/transcript-viewer.tsx` → `TranscriptViewer` JSDoc `@deprecated` → `LiveTranscript` |

`use-transcript-viewer` was **not** deprecated — it is still used by `elevenlabs/transcript-viewer` (the consolidation map only deprecates it "if unused").

> **Update (2026-07-03, TASK-410 P2-4):** both deprecated losers have now been **removed** after grep-proof of zero remaining usages (in-repo consumers: none; only their own tests/stories). The tool-ui `data-table/` module (component + formatters + schema + types + utilities) and `custom/transcript-viewer.tsx` were deleted with their tests/stories; the shared `StatusBadge` (whose name collided with the removed tool-ui formatter) is now exported from the **root barrel** as well as the `components/shared` subpath. The remaining §4.5 items were re-verified and retained: `.js` dynamic-import specifiers + casts (TS2835/TS2322 still enforced by the NodeNext CJS dts target) and the pdf-worker `@ts-expect-error` (TS1470 still enforced). `TranscriptSegment`/`TranscriptWord` (collide with `use-transcript-viewer` type exports) and `TimelineItem` (collides with diceui) stay off-barrel. See [TASK-410](../TASK-410-Closeout-Prettier-Hygiene-Verify/README.md).

### 4.7 Verification evidence (actual output)

- **Build** — `pnpm build --filter @arcaai/ui`: ✅ `ESM dist/index.mjs 2.22 MB`, `CJS dist/index.js 2.33 MB`, `DTS dist/index.d.ts 493.80 KB`, CSS emitted. (Remaining log lines are pre-existing warnings in unrelated registry files.)
- **Unit tests** — `pnpm --filter @arcaai/ui exec vitest run`: ✅ **221 files / 443 tests passed, 0 failed** (includes the new shared/data-grid/timeline/live-transcript suites and the two D6-touched suites).
- **Lint** — `eslint … --max-warnings 0` over all new/changed files: ✅ **0 errors, 0 warnings**. (The Microsoft Edge Tools editor extension reports pre-existing a11y/inline-style findings in the two deprecated files, unrelated to these edits and not part of the ESLint gate.)

### 4.8 Follow-ups (explicitly out of scope here)

- ~~**`apps/admin` integration (D10)** — bind the components to real SDK/REST data per §3.7 (consume `onTranscript` for D9 words; wire `useUserSettings` for D8). The components are consumer-agnostic and ready.~~ **✅ Done — [TASK-374](../TASK-374-Admin-App-Integration/README.md) (Completed)**: the redesigned `apps/admin` consumes all three components (Tenants/Users grids via `responsive-data-grid.tsx`, `/audit-log` cursor grid, `/history`, `/live`). D10 resolved — see §3.8.1.
- **[TASK-373](../TASK-373-Cursor-Pagination-DTO/README.md) backend cursor DTO (D7)** — the grid's cursor mode stays inert until the server contract lands.
- **D8 backend** — whitelist the `ui.data-grid` settings namespace.
- ~~**Optional SDK (D9 Option B)** — only if a consumer needs `wordTimestamps` from the store path rather than `onTranscript`.~~ **✅ Done 2026-06-27** — implemented in `@arcaai/vox`; `audio.transcriptSegments[].words` now carries word timings (see Change History).

## 5. Change History

| Date | Change | Files |
|---|---|---|
| 2026-06-27 | Ticket created; design-system shared-component plan authored (architecture, shared interfaces, 3 flagship component specs + TDD lists, dependency table, inventory, integration map, open questions). Status = Review. | `README.md` |
| 2026-06-27 | **Decisions D1–D9 ratified & propagated.** D4 (Lexical editor), D8 (server-persisted grid layout via `useUserSettings`), D9 (word-level timestamps + click-to-seek) **override** prior recs and are folded into the specs. Converted Open Questions → **Resolved Decisions log** (§3.8); D10 kept open (§3.8.1). Added §3.4.8 (D8 persistence), §3.7.1 (backend/SDK dependencies). Refreshed dependency table, build order + consolidation map (D6), integration map, and TDD lists. Spawned **[TASK-373](../TASK-373-Cursor-Pagination-DTO/README.md)** (D7). **Status → Approved — Ready to Implement** (no code written; awaiting go-ahead for Phase 4). | `README.md`, `../TASK-373-Cursor-Pagination-DTO/README.md` |
| 2026-06-27 | **Phase 4 implemented (TDD).** Built the full `@arcaai/ui` shared-component system: token migration (D1); shared contracts `lib/shared/*` + `components/shared/*`; **`VirtualizedDataGrid`** (+ D8 `use-grid-layout` adapter), **`HistoryTimelineList`** (+ renderer registry incl. lazy `react-pdf` `PdfRenderer`, D3), **`LiveTranscript`** (+ lazy Lexical `segment-editor`, D4; word-seek, D9). D6 consolidation (tool-ui `DataTable` + custom `TranscriptViewer` → `@deprecated`, kept); root barrel updated. **48 new files, 6 modified.** New deps: `react-pdf@^10.4.1`, `pdfjs-dist@5.4.296` (pinned, both `external`). **D9 = no SDK change** (Option A via `SttV2WebSocketClient.onTranscript`). **D8** adapter built; `ui.data-grid` namespace whitelist flagged to backend. Deviations: `.js` dynamic-import specifiers + cast and one `@ts-expect-error` on the pdf-worker `import.meta.url` (NodeNext CJS dts; runtime-correct via esbuild); 4 names kept off the root barrel to avoid collisions (§4.5). **Verified:** build ✅ (ESM 2.22 MB / CJS 2.33 MB / DTS 493.80 KB), `vitest run` ✅ **443/443**, ESLint ✅ 0/0. **Status → In Progress** (component system Completed & verified; follow-ups: `apps/admin` D10, TASK-373 D7, D8 namespace). | `packages/ui/src/{lib/shared,components/{shared,data-grid,timeline,live-transcript}}/**` (48 new), `packages/ui/src/{index.ts,styles/globals.css}`, `packages/ui/{package.json,tsup.config.ts}`, `packages/ui/src/components/{registries/tool-ui/data-table/data-table.tsx,custom/transcript-viewer.tsx}` |
| 2026-06-27 | **Three `@arcaai/vox` client-SDK enhancements (unblock `apps/admin`; TDD, additive/back-compatible).** **(1) `extractCursorPaginated` normalizer** — the [TASK-373](../TASK-373-Cursor-Pagination-DTO/README.md) AC-5 client follow-up (deferred by that backend ticket). Maps a server `CursorPaginatedResponse<T>` (`{ data, nextCursor, hasMore, limit }`, e.g. `GET /admin/audit-logs/cursor`) → the client `PageResult<T>` cursor shape (`{ rows, nextCursor, hasMore, limit }`) from `lib/shared/pagination.ts`. Lives beside the offset `extractPaginated` and is equally defensive (tolerates raw-array/`items`/`results`; derives `hasMore` from `nextCursor` when absent; `DEFAULT_PAGE_SIZE` fallback). To keep the SDK decoupled from `@arcaai/ui` (neither package depends on the other), the return type is a **local** `CursorPageResult<T>` that is structurally assignable to `PageResult<T>`. Exported publicly from `core.ts`. **(2) `useUsers().listPaginated` forwards the full query** — previously page/limit only; now forwards the backend `PaginatedQuery` (CSV `filters` + `sort` + `search` + `searchFields`) built exactly like the offset audit-log query (`appendPagination(appendFilters(...))`). New optional `UserListQuery` (extends `PaginationParams`); page/limit-only (or no-arg) callers produce byte-identical URLs (back-compat). Conforms to the parallel **TASK-375** backend Users-endpoint extension. **(3) Focused hooks exported** — `useArcaContext` + `useArcaAudio` now re-exported from the public barrel (`core.ts`), resolving [TASK-374 §5.3.2](../TASK-374-Admin-App-Integration/README.md) (they were hooks-barrel-only; the `UseArcaContext`/`UseArcaAudio` types were already public). Additive — `useArca()` aggregate untouched. **TDD (RED→GREEN):** new cursor suite (9), `listPaginated` query-forwarding suite (9), focused-hook export suite (3). **Verified (real output):** `@arcaai/vox` full suite **3404 passed** (183 files; +21 new) · `pnpm --filter @arcaai/vox build` ✅ (ESM+CJS index/core/plugins; DTS off by config) · `tsc --noEmit` — only the 2 **pre-existing** errors in untouched files (`bundle-externals.task364.test.ts`, `SttV2WebSocketClient.test.ts`); none in changed files · ESLint **0 errors** (introduced prettier nit fixed; remaining warnings pre-existing on untouched lines). No `@arcaai/stt` change. | `packages/agentic-sdk-v2/src/utils/responseUtils.ts` (`extractCursorPaginated` + `CursorPageResult`), `packages/agentic-sdk-v2/src/utils/index.ts`, `packages/agentic-sdk-v2/src/core.ts` (public exports), `packages/agentic-sdk-v2/src/hooks/useUsers.ts` (`listPaginated` + `UserListQuery` + `toListFilterQuery`), `packages/agentic-sdk-v2/src/hooks/index.ts`, + tests `packages/agentic-sdk-v2/src/{utils/__tests__/responseUtils.test.ts,hooks/__tests__/useUsers.listPaginated.test.ts,__tests__/exports.focusedHooks.test.ts}` |
| 2026-06-27 | **D9 Option B implemented in `@arcaai/vox` (SDK store now carries word-level timestamps).** Closes the §3.7.1/§3.8 D9 gap where word timings were emitted on the wire (`WsTranscriptResult.wordTimestamps`) but dropped on the SDK store path — so consumers can now read words from `audio.transcriptSegments[].words` (not only the raw `SttV2WebSocketClient.onTranscript` socket). Surgical, fully back-compatible (all new fields optional; no consumer changes required). **Types:** new `TranscriptWord` + `words?: TranscriptWord[]` on `TranscriptSegment` & `TranscriptionResult` (`@arcaai/vox`); new `WordTimestamp` + `words?` on `@arcaai/stt` `TranscriptionResult`; `wordTimestamps?` added to the duck-typed `StreamingTranscriptPayload`. **Mapping:** `StreamingBackendSTTProvider.normalizeTranscript` copies `payload.wordTimestamps → result.words` (guarded; ignores empty); the `useArcaAudio` final-segment bridge copies `result.words → segment.words`. **Exports:** `TranscriptWord` (+ store `TranscriptSegment`) from `@arcaai/vox` `core.ts`/`types/index.ts`; `WordTimestamp` from `@arcaai/stt` `index.ts`. **TDD (RED→GREEN):** `StreamingBackendSTTProvider.test.ts` (normalizeTranscript carries words; back-compat undefined; ignores empty array), `useArca.audio-pipeline.test.ts` (bridge maps words → stored segment; back-compat), `useArca.audioSegments.test.ts` (optional `words` type + store exposure). **Verified (real output):** `@arcaai/stt` **409/409** + `@arcaai/vox` **3383/3383** tests pass; both packages build incl. DTS; `tsc --noEmit` + ESLint clean on all changed files (the 2 pre-existing vox typecheck errors & prettier nits live in untouched files — proven pre-existing via `git stash`). **D9 status → Done (both options available):** Option A (`onTranscript`) remains; Option B now lets consumers read words from the store. | `packages/agentic-sdk-v2/src/{types/audio.ts,types/index.ts,core.ts,hooks/useArcaAudio.ts}`, `packages/agentic-sdk-v2/src/hooks/__tests__/{useArca.audio-pipeline.test.ts,useArca.audioSegments.test.ts}`, `packages/stt/src/{types/index.ts,providers/StreamingBackendSTTProvider.ts,index.ts}`, `packages/stt/src/providers/__tests__/StreamingBackendSTTProvider.test.ts` |
| 2026-06-27 | **`TimelineImage` full-resolution zoom source (additive `@arcaai/ui` enhancement; TDD, back-compatible).** Closes the [TASK-374 §4.5](../TASK-374-Admin-App-Integration/README.md) gap where `TimelineImage` exposed a **single `src`** reused by the zoom lightbox, so zoom showed the (320px) thumbnail. Added an **optional `zoomSrc`** to `TimelineImage` (`components/timeline/types.ts`) and the `ImageGalleryItemSchema` (`registries/tool-ui/image-gallery/schema.ts`). Because the `ImageGallery` physically **moves** the same `<img>` node into the lightbox, the provider now imperatively **swaps `img.src → zoomSrc` on open and restores the thumbnail `src` on close**, synchronized with the existing `withViewTransition` (open/close) so the morph still animates; when `zoomSrc` is absent the lightbox keeps `src` (**no-op, fully back-compatible**). This lets a consumer bind grid `src = thumbnail` and `zoomSrc = full-res url` (which `apps/admin`'s `map-context-item.ts` now does). **TDD (RED→GREEN):** 2 new timeline tests — lightbox swaps to `zoomSrc` on open + restores the thumbnail on close; falls back to `src` when no `zoomSrc`. **Verified (real output):** `pnpm build --filter @arcaai/ui` ✅ (Turbo `8/8`, builds clean incl. DTS) · `pnpm --filter @arcaai/ui test timeline` ✅ **Test Files 2 passed · Tests 21 passed** · `ReadLints` + scoped ESLint (`--max-warnings 0`) on the changed files **0 problems**. Only `@arcaai/ui` change permitted by the TASK-374 Round-4 brief; everything else that round was `apps/admin`-only. | `packages/ui/src/components/timeline/types.ts` (`zoomSrc?`), `packages/ui/src/components/registries/tool-ui/image-gallery/{schema.ts,context.tsx}` (schema + open/close `src`↔`zoomSrc` swap), `packages/ui/src/components/timeline/__tests__/timeline.vitest.tsx` (+2 tests) |
| 2026-06-27 | **First-class audit-logs cursor method in `@arcaai/vox` (removes `apps/admin`'s local cursor path constant; TDD, additive/back-compatible).** Completes the SDK side of the cursor surface started by `extractCursorPaginated`: the offset audit-log path had a `useAuditLog().list()` method but there was **no cursor entry**, which forced the [TASK-374](../TASK-374-Admin-App-Integration/README.md) admin audit grid to hardcode a local `AUDIT_LOG_CURSOR_ENDPOINT` constant and call the raw `apiClient`. **(1) Endpoint** — added `AUDIT_LOG_ENDPOINTS.CURSOR = '/admin/audit-logs/cursor'` (the [TASK-373](../TASK-373-Cursor-Pagination-DTO/README.md) server contract `GET /admin/audit-logs/cursor` → `CursorPaginatedResponse<T>`); like `EXPORT` it is a static segment that must precede the `/:id` param route. **(2) Method** — `useAuditLog().listByCursor(query?)`: a keyset sibling of the offset `list()` that builds the URL with the **same `appendFilters` helper** the offset path uses, mirroring the server `CursorQuery` (opaque `cursor` token + `limit`, `cursor` omitted on the first page / `limit` defaulting to `DEFAULT_PAGE_SIZE`) **plus the same A8 filters** (`from`/`to`/`action`/`resourceType`/`userId`). It returns the server response normalized via **`extractCursorPaginated`** into `CursorPageResult<AuditLogEntry>` (`{ rows, nextCursor, hasMore, limit }`), which is **structurally assignable to `@arcaai/ui`'s `PageResult<T>`** (`lib/shared/pagination.ts`) — keeping `@arcaai/vox` decoupled from `@arcaai/ui`. New optional `AuditLogCursorParams` type, exported publicly from `core.ts`/the hooks barrel. **Back-compat:** the offset `list()` is byte-for-byte untouched; `listByCursor` deliberately does **not** mutate the offset `entries`/`count` state (cursor consumers accumulate rows themselves), matching `getById`/`byResource`/`byUser`. **TDD (RED→GREEN):** new 9-test cursor suite (endpoint path present; default-limit + cursor + filters URL building as one query string; `extractCursorPaginated` normalization; PageResult-shaped result; offset-state untouched) + 1 added guard assertion in the QA-003 constants suite (CURSOR key/path). **Verified (real output):** `@arcaai/vox` full suite **3414 passed** (184 files; +10 vs prior, +1 file) · `pnpm --filter @arcaai/vox build` ✅ (ESM+CJS index/core/plugins) · `tsc --noEmit` — only the 2 **pre-existing** errors in untouched files (`bundle-externals.task364.test.ts`, `SttV2WebSocketClient.test.ts`); none in changed files · ESLint **0 errors** (`ReadLints` clean on changed files; remaining prettier warnings pre-existing on untouched lines). **Follow-up (out of scope here):** `apps/admin` can now swap its local `audit-cursor-query.ts` path constant + raw `apiClient` call for `useAuditLog().listByCursor(query)`. | `packages/agentic-sdk-v2/src/core/constants.ts` (`AUDIT_LOG_ENDPOINTS.CURSOR`), `packages/agentic-sdk-v2/src/hooks/useAuditLog.ts` (`listByCursor` + `AuditLogCursorParams` + `toCursorFilterQuery`), `packages/agentic-sdk-v2/src/hooks/index.ts`, `packages/agentic-sdk-v2/src/core.ts` (public exports), + tests `packages/agentic-sdk-v2/src/hooks/__tests__/useAuditLog.cursor.test.ts` (new), `packages/agentic-sdk-v2/src/core/__tests__/constants.qa003.test.ts` (guard) |
| 2026-06-27 | **Packaged the `components/shared` subpath types (additive, back-compatible — unblocks the [TASK-374](../TASK-374-Admin-App-Integration/README.md) admin `tsc`).** `StatusBadge` + `StatusColorRole` are intentionally **kept off the root barrel** (the shared `StatusBadge` collides with the tool-ui formatter — §4.5), so consumers import them from the **`@arcaai/ui/components/shared`** subpath. The package shipped JS for that subpath but **no matching `.d.ts`**, so type-only consumers (e.g. `apps/admin`, 11 files) couldn't resolve the names under `tsc` (which reads `dist` types, not source). Fixed by making the subpath a **first-class packaged entry**: (1) added `src/components/shared/index.ts` as a second **`tsup`** entry → now emits `dist/components/shared/index.{js,mjs,**d.ts,d.mts**}`; (2) added an **`"./components/shared"`** conditional `exports` entry (`types`/`import`/`require`) to `package.json`. **Purely additive** — the root barrel (`.`), the `"./*": "./src/*.tsx"` source fallback, and all existing component behavior are untouched (no API/visual change; runtime imports already worked). **Verified (real output):** `pnpm --filter @arcaai/ui build` ✅ — `DTS dist/components/shared/index.d.ts 1.10 KB` (+ `.d.mts`) emitted beside the root `dist/index.d.ts`; `vitest run` ✅ **445/445** (221 files); `ReadLints` on `tsup.config.ts` clean. Consumed by TASK-374 §4.7 (admin `tsc --noEmit` → 0 errors). | `packages/ui/tsup.config.ts` (second entry `src/components/shared/index.ts`), `packages/ui/package.json` (`exports["./components/shared"]`) |
| 2026-06-30 | **Documentation + test review pass (QA artifacts only — no `packages/ui` / app / SDK code touched).** Added the design-system **[DESIGN-SPEC.md](../../designs/admin/shared-components.md)** (Desktop/Tablet/Mobile behavior for all three components — grid full→condensed→card-list+FAB, timeline reflow + full-screen lightbox + lazy media, transcript reflow + Lexical edit + autoscroll/jump-to-live + word-seek; token-driven, light/dark, two densities, WCAG 2.2 AA `grid`/`feed`/`log`; ends with "Figma frames to create later"), the **[TRACEABILITY-MATRIX.md](../../qa/traceability/shared-components.md)** (A1–A10 → component sub-part `packages/ui` file → consuming `apps/admin` surface → unit/E2E test, mirroring the TASK-371 legend, + per-component drilldowns and a D7/D8/D9/D10 backend/SDK follow-up ledger with live `file:line`), and the **[MANUAL-E2E-TESTS.md](../../qa/manual-tests/03-shared-components.md)** component QA checklist (D/T/M × light/dark × Comfortable/Compact × keyboard a11y, with a sign-off grid). Authored two Playwright specs: **backend** `apps/api/tests/e2e/task-372-shared-components.spec.ts` (7 tests — the **D7** cursor contract `GET /admin/audit-logs/cursor` → `{ data, nextCursor, hasMore, limit }`: envelope-not-offset, `limit` honoured, disjoint keyset paging, terminal `hasMore=false`+`nextCursor=null`, malformed-cursor `400`, `401`, A8 `action` filter; **references** TASK-375 for D8 persistence rather than duplicating it) and **frontend** `apps/admin/e2e/task-372-shared-components.spec.ts` (10 cases × desktop/tablet/mobile — `VirtualizedDataGrid` on `/tenants`: accessible roles+rows, global search→empty→recover, header sort `aria-sort=descending`, faceted Status filter→Reset, View column-hide, density→compact, mobile card-list+FAB+search+tap-through). **Follow-up status confirmed against live source:** **D7** = TASK-373 **Completed** (`audit-log.controller.ts:132` `@Get('cursor')`); **D8** `ui.data-grid` = **recognized + value-validated** (`userSettings.namespaces.ts:26/:56`, `user-settings.controller.ts:53/:88`) — the settings endpoint stays open (recognition/validation registry, **not** a strict allow-list); **D10** = TASK-374 **Completed** (admin consumes all three). **Gates (real output):** `@arcaai/admin type-check` ✅ 0 errors · `@arcaai/admin test` ✅ **215/215** (30 files) · `playwright --list` (admin) ✅ **30** (2 files) · `playwright --list` (api `task-372`) ✅ **7** (1 file) · `@arcaai/ui vitest run` ✅ **561/561** (235 files — suite has grown past the 443 snapshot; unmodified here). Live E2E **not run** — `curl localhost:8868/api/v1/health` returned `000` (no stack) → **authored, run pending a running stack**. **Status stays In Progress** (all three follow-ups landed; only the live E2E execution remains). | `docs/implementation/TASK-372-Shared-Component-System/{DESIGN-SPEC,TRACEABILITY-MATRIX,MANUAL-E2E-TESTS}.md` (new), `apps/api/tests/e2e/task-372-shared-components.spec.ts` (new), `apps/admin/e2e/task-372-shared-components.spec.ts` (new), `README.md` (§1 status + this row) |
| 2026-07-03 | **TASK-410 P2-4 deferred hygiene executed.** (1) **Removed the two `@deprecated` D6 losers** after grep-proving zero remaining usages across `apps/**` + `packages/**`: deleted `components/registries/tool-ui/data-table/` (whole module: `DataTable` + `useDataTable` + formatters incl. the colliding `StatusBadge` + schema/types/utilities/_adapter/README) and `components/custom/transcript-viewer.tsx`, plus their own tests/stories/fixtures (`__tests__/registries/tool-ui/data-table.vitest.tsx`, `__stories__/registries/tool-ui/data-table.stories.tsx`, `__tests__/custom/transcript-viewer.test.tsx`, `__tests__/fixtures/custom/transcript-viewer-fixtures.tsx`, `__stories__/custom/transcript-viewer.stories.tsx`); updated the `tool-ui` barrel + root barrel. (2) **Promoted the shared `StatusBadge` onto the root barrel** (`+ StatusBadgeProps`, `StatusColorRole`) — its name-collision partner (the tool-ui formatter) is gone; the `components/shared` subpath continues to export it. (3) **Re-verified the §4.5(1)/(2) deviations still bind** under tsc 5.9 (removal attempt → TS2835/TS2322/TS1470) — `.js` specifiers + casts and the pdf-worker `@ts-expect-error` retained with updated comments. (4) D10 wording: already reconciled 2026-07-01 — re-checked by grep, no "open" phrasing remains. **Verified (real output):** `pnpm --filter @arcaai/ui build` ✅ (dts emitted incl. shared/metrics subpaths) · `vitest run` ✅ **564/564** (235 files; −2 files vs prior for the deleted suites) · `check-types` 34 errors — all **pre-existing** in untouched stories/tests (baseline unchanged; 0 in touched files) · scoped ESLint `--max-warnings 0` ✅ · `@arcaai/admin` `type-check` ✅ 0 errors + `build` ✅. | `packages/ui/src/{index.ts,components/registries/tool-ui/index.ts,components/timeline/renderers/{pdf-renderer,pdf-document}.tsx,components/live-transcript/transcript-segment.tsx}`; deleted `packages/ui/src/components/{registries/tool-ui/data-table/**,custom/transcript-viewer.tsx,__tests__/{registries/tool-ui/data-table.vitest.tsx,custom/transcript-viewer.test.tsx,fixtures/custom/transcript-viewer-fixtures.tsx},__stories__/{registries/tool-ui/data-table.stories.tsx,custom/transcript-viewer.stories.tsx}}` |
| 2026-07-01 | **D10 internal-consistency reconciliation (docs only — no code touched).** The header (§1), §4.7-adjacent §4.8, and the Change History already recorded **D10 = [TASK-374](../TASK-374-Admin-App-Integration/README.md) Completed**, but three earlier passages still framed D10 as **"open"** — verified the real consumer in code (`apps/admin/src/features/data-grid/responsive-data-grid.tsx`, `routes/_authenticated/audit-log.tsx`) then reconciled them: §3.8.1 heading + D10 row (**Open → 🟢 Resolved**, naming the redesigned `apps/admin` consumer + TASK-374), the §1.2 ratification note (line 16), the §1.5 Assumptions note ("D10 still open" → resolved), and the §4.8 follow-up bullet (struck through + **✅ Done** via TASK-374, matching the existing D9 strikethrough pattern). `docs/qa/traceability/shared-components.md` already marked D10 🟢 — left unchanged. | `README.md` |
