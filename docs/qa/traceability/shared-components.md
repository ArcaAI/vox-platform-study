> _Relocated from `docs/implementation/TASK-372-Shared-Component-System/TRACEABILITY-MATRIX.md` (TASK-385 docs alignment)._

# TASK-372 — Shared Component System Traceability Matrix

> **What this is:** an **acceptance-criterion → component/sub-part → consuming surface → test** map for the three flagship `@arcaai/ui` components. Unlike the TASK-371 matrix (use-case → backend API), these are **design-system components** that are *transport-agnostic* (decision D5) — so the trace is **component public API → consumer → test**, with the few real **backend dependencies** (the D7 cursor contract and the D8 settings namespace) called out as their own rows in [§3](#3-backend--sdk-follow-up-dependencies-d7--d8--d9--d10).
>
> **How to read:** §1 traces the ten acceptance criteria ([README §1.4](../../implementation/TASK-372-Shared-Component-System/README.md#14-acceptance-criteria)). §2 drills each component into its sub-parts. §3 is the backend/SDK follow-up ledger (D7/D8/D9/D10 — **all resolved**). Paths/`file:line` verified live 2026-06-30.

| | |
|---|---|
| **Ticket** | [TASK-372](../../implementation/TASK-372-Shared-Component-System/README.md) |
| **Created** | 2026-06-30 |
| **Status** | Components **built & verified** (443 unit tests — [README §4.7](../../implementation/TASK-372-Shared-Component-System/README.md#47-verification-evidence-actual-output)); admin integration **done** ([TASK-374](../../implementation/TASK-374-Admin-App-Integration/README.md), D10); backend deps **landed** ([TASK-373](../../implementation/TASK-373-Cursor-Pagination-DTO/README.md), D7 + `ui.data-grid` namespace, D8) |
| **Sources** | Components = `packages/ui/src/{lib/shared,components/{shared,data-grid,timeline,live-transcript}}`; Consumers = `apps/admin/src`; Tests = `packages/ui/src/**/__tests__` (Vitest) + `apps/admin/e2e` & `apps/api/tests/e2e` (Playwright) |

## Legend

| Symbol | Meaning |
|---|---|
| 🟢 | **Built & automated-tested** end-to-end (unit and/or E2E) |
| 🟡 | **Built, partial test** — exists in code but only unit (mocked) or only one layer |
| 🔴 | **Gap** — designed but not built / not tested |
| 🎯 | **Target** — design-only / inert (no backend yet, intentional) |
| 🔒 | endpoint is **strictly super-admin-only** |

**Conventions (apply to every row):**

- Component paths are under `packages/ui/src/`; consumer paths under `apps/admin/src/`.
- Backend API cells use the global prefix **`/api/v1`** (`apps/api/src/main.ts`).
- `@arcaai/ui` is **transport-agnostic** (D5): it never fetches — consumers wire the SDK (`@arcaai/vox`) and pass `data`/`AsyncCollection`/`PageResult`. So most rows have **no** backend cell; the genuine backend deps are isolated in §3.
- The timeline + live-transcript have **no admin route as a data-grid** — they bind to clinical consultation surfaces (`/history`, `/live`); their E2E coverage is the `@arcaai/ui` Vitest suites + the manual checklist ([MANUAL-E2E-TESTS.md](../manual-tests/03-shared-components.md)), **not** the admin grid E2E.

## Coverage snapshot

- **10 / 10 acceptance criteria built & tested** (🟢). The component system shipped with **443 Vitest tests** across 221 files (README §4.7).
- **VirtualizedDataGrid** is additionally covered by a **full-stack admin E2E** ([`apps/admin/e2e/task-372-shared-components.spec.ts`](../../../apps/admin/e2e/task-372-shared-components.spec.ts), 10 cases × 3 viewport tiers) on the **Tenants** surface (sort / faceted filter / global search / View / density / mobile card-list).
- The **D7 cursor contract** has a dedicated backend E2E ([`apps/api/tests/e2e/task-372-shared-components.spec.ts`](../../../apps/api/tests/e2e/task-372-shared-components.spec.ts)); **D8 persistence** is covered by [`task-375-admin-features.spec.ts`](../../../apps/api/tests/e2e/task-375-admin-features.spec.ts) (referenced, **not** duplicated).
- **Backend follow-ups D7 / D8 = landed** ([TASK-373](../../implementation/TASK-373-Cursor-Pagination-DTO/README.md)); **D10 admin integration = done** ([TASK-374](../../implementation/TASK-374-Admin-App-Integration/README.md)); **D9 word timings = both source paths available**. No open backend gaps remain for this ticket.

---

## 1. Acceptance criteria (A1–A10)

| ID | Acceptance criterion | Component · sub-part (`packages/ui/src/…`) | Consuming surface (`apps/admin/src/…`) | Test | Status |
|---|---|---|---|---|---|
| A1 | Shared-interfaces module (pagination / sort / filter / async-collection / density-surface) reused by all three | `lib/shared/{pagination,query-state,async-collection,surface}.ts` + `index.ts` | `routes/_authenticated/users.tsx` (`toPaginatedQuery`, `DataQueryState`); `features/data-grid/*` | `lib/shared/__tests__/{pagination,query-state,use-expansion}.vitest.ts` | 🟢 |
| A2 | Each component has a complete public TS API (generics, controlled/uncontrolled, slots, callbacks) | `components/data-grid/types.ts`; `components/timeline/types.ts`; `components/live-transcript/types.ts` | Tenants/Users grids; `/history`; `/live` | the three component Vitest suites (§2) | 🟢 |
| A3 | Token-driven (no hex), light/dark + Comfortable/Compact, WCAG 2.2 AA roles (`grid`/`feed`/`log`) | `components/shared/{density-provider,status-badge}.tsx` + each component's ARIA | density/theme toggles (topbar); `StatusBadge` in `users.tsx`/`tenants/index.tsx` | `components/shared/__tests__/shared-primitives.vitest.tsx`; a11y asserts in each suite; **E2E** density toggle (`task-372` FE) | 🟢 |
| A4 | `VirtualizedDataGrid` virtualizes ≥10k rows; faceted+global search, column reorder/resize/visibility/pinning, sort, selection, density, **offset (primary)** + inert cursor (D7) | `components/data-grid/{virtualized-data-grid,use-data-grid,data-grid-toolbar,data-grid-faceted-filter,data-grid-column-header,data-grid-pagination,data-grid-skeleton}.tsx` | `routes/_authenticated/{tenants/index,users}.tsx` via `features/data-grid/responsive-data-grid.tsx` | `components/data-grid/__tests__/data-grid.vitest.tsx`; **E2E** `task-372` FE (sort/filter/search/View/density/mobile) | 🟢 |
| A5 | `HistoryTimelineList` per-content-type (markdown/pdf/image+lightbox/audio/file/mixed), virtualized, lazy media | `components/timeline/{history-timeline-list,use-timeline,timeline-item}.tsx` + `renderers/{markdown,pdf,image-grid,audio,file,mixed,fallback}-renderer.tsx` | `routes/_authenticated/history.tsx` + `features/history/map-context-item.ts` (`mapContextItem`) | `components/timeline/__tests__/timeline.vitest.tsx` | 🟢 (unit; no admin-grid E2E — clinical surface) |
| A6 | `LiveTranscript` infinite-scroll, skeleton, **inline Lexical edit (D4)**, interim vs final, speakers+timestamps, autoscroll+pause+jump-to-live, ambient pulse | `components/live-transcript/{live-transcript,use-live-transcript,transcript-segment,segment-editor,jump-to-live,listening-pulse}.tsx` | `routes/_authenticated/live.tsx` + `features/live/map-segment.ts` (`mapTranscriptSegment`) | `components/live-transcript/__tests__/live-transcript.vitest.tsx` | 🟢 (unit; clinical surface) |
| A7 | Consolidated dependency table (package · version · purpose · risk; installed-vs-new) | [README §3.3](../../implementation/TASK-372-Shared-Component-System/README.md#33-consolidated-dependency-table-versions-verified-2026-06-27-via-npm--context7); `packages/ui/package.json` (`react-pdf`, `pdfjs-dist` new) | — (library build) | build evidence ([README §4.7](../../implementation/TASK-372-Shared-Component-System/README.md#47-verification-evidence-actual-output)) | 🟢 |
| A8 | TDD test lists (Vitest, behavior-focused) per component + sub-component | [README §3.4.7/§3.5.7/§3.6.7](../../implementation/TASK-372-Shared-Component-System/README.md#347-tdd-test-list); shipped suites | — | 443 tests / 221 files (README §4.7) | 🟢 |
| A9 | Per-user grid layout persists **server-side via `useUserSettings`** (load-on-mount + debounced save + graceful fallback) — **D8** | `components/data-grid/use-grid-layout.ts` (injectable adapter port) | `features/data-grid/{use-grid-persistence,grid-layout-adapter}.ts`; `persistence` prop in `tenants/index.tsx`+`users.tsx` | data-grid suite (persistence cases); **backend** `task-375` D8 (referenced) | 🟢 |
| A10 | Word-level timestamps + **click-to-seek** wired to the audio player — **D9** | `components/live-transcript/{transcript-word,use-live-transcript}.tsx`; `components/timeline/renderers/audio-renderer.tsx` | `/live` (+ `/history` audio items); `mapTranscriptSegment` | live-transcript suite (word-seek cases); timeline suite (audio word-seek) | 🟢 |

---

## 2. Per-component public API → surface → test

### 2.A `VirtualizedDataGrid` — design `02 · DataGrid 60:745` + `04 · Full-Screen Table 59:155`

| ID | Feature / sub-part | Component file | Consuming surface | Test | Status |
|---|---|---|---|---|---|
| G1 | Row virtualization (≥ tens of thousands) | `virtualized-data-grid.tsx` (`@tanstack/react-virtual`) | Users / Audit grids | data-grid vitest (bounded DOM nodes) | 🟢 |
| G2 | Headless controller (sort/filter/visibility/pin/order/size/selection) | `use-data-grid.ts` (`useReactTable` v8) | all grids | data-grid vitest | 🟢 |
| G3 | Toolbar: global search + density toggle + View (column visibility) | `data-grid-toolbar.tsx` | Tenants/Users | **E2E** `task-372` FE (search, density, View) | 🟢 |
| G4 | Faceted filters (text/number/date/select/multiSelect) | `data-grid-faceted-filter.tsx` + `types/data-table.ts` | Tenants `resourceStatus`; Users `resourceStatus`/`isServiceAccount` | **E2E** `task-372` FE (Status facet → Reset) | 🟢 |
| G5 | Column header: sort + pin + hide + dnd reorder | `data-grid-column-header.tsx` | all grids | **E2E** `task-372` FE (`aria-sort`); data-grid vitest | 🟢 |
| G6 | Offset pagination (primary) | `data-grid-pagination.tsx` | Users (`manual.pagination`, `rowCount`) | data-grid vitest; backend `task-375` Users paging (referenced) | 🟢 |
| G7 | **Cursor pagination (D7)** — inert in the lib until a server cursor exists; now **live** for Audit | `data-grid-pagination.tsx` (cursor prev/next); `lib/shared/pagination.ts` (`CursorPageRequest`/`nextCursor`) | `routes/_authenticated/audit-log.tsx` via `features/audit-log/use-audit-log-cursor.ts` (`useAuditLogCursor` → `useAuditLog().listByCursor`) | data-grid vitest; **backend** `task-372` BE (`/admin/audit-logs/cursor`) | 🟢 |
| G8 | Layout persistence (order/size/visibility/pinning/density) — **D8** | `use-grid-layout.ts` | `features/data-grid/use-grid-persistence.ts` (`useUserSettings`) | data-grid vitest; backend `task-375` D8 (referenced) | 🟢 |
| G9 | Responsive: desktop grid → tablet condensed → mobile card-list + FAB | `virtualized-data-grid.tsx` + app `responsive-data-grid.tsx` | Tenants/Users | **E2E** `task-372` FE (grid vs card-list across 3 tiers) | 🟢 |

> **Cross-link (TASK-371 matrix):** F1 (Tenants grid `13 · Tenant Management 69:1416`), U1 (Users grid `20u · Data Grid 120:9015`), AU1 (Audit viewer `12 · Audit Log 70:1843`) — all now consume `VirtualizedDataGrid`.

### 2.B `HistoryTimelineList` — design-system component (foundations; clinical context)

| ID | Feature / sub-part | Component file | Consuming surface | Test | Status |
|---|---|---|---|---|---|
| T1 | Reverse-chron feed + virtualization + infinite scroll | `history-timeline-list.tsx` + `use-timeline.ts` | `/history` | timeline vitest | 🟢 |
| T2 | Content-type renderer registry | `renderers/{markdown,pdf,image-grid,audio,file,mixed,fallback}-renderer.tsx` + `registry.ts` | `mapContextItem` (`ContextItem` → `TimelineItemModel`) | timeline vitest (variant selection) | 🟢 |
| T3 | PDF viewer (lazy `react-pdf`, bundled worker) — **D3** | `renderers/pdf-renderer.tsx` + `pdf-document.tsx` | `/history` (ATTACHMENT pdf) | timeline vitest (lazy mount) | 🟢 |
| T4 | Image grid + lightbox (full-res `zoomSrc`) | `renderers/image-grid-renderer.tsx` + `tool-ui/image-gallery` | `/history` (image attachments) | timeline vitest (lightbox swap) | 🟢 |
| T5 | Audio renderer + word-seek (**D9**) | `renderers/audio-renderer.tsx` | `/history` (AUDIO_RECORDING) | timeline vitest | 🟢 |
| T6 | Expansion model + a11y (`role="feed"`, `aria-expanded`) | `timeline-item.tsx` | `/history` | timeline vitest (a11y) | 🟢 |

### 2.C `LiveTranscript` — design-system component (`role="log"`)

| ID | Feature / sub-part | Component file | Consuming surface | Test | Status |
|---|---|---|---|---|---|
| L1 | Final/interim segments + `stableChars` + virtualization | `live-transcript.tsx` + `transcript-segment.tsx` + `use-live-transcript.ts` | `/live` | live-transcript vitest | 🟢 |
| L2 | Autoscroll + pause-on-scroll-up + jump-to-live | `use-live-transcript.ts` (`use-stick-to-bottom`) + `jump-to-live.tsx` | `/live` | live-transcript vitest | 🟢 |
| L3 | Inline **Lexical** editor (lazy) — **D4** | `segment-editor.tsx` | `/live` (`onEditSegment` → `context.updateItem`) | live-transcript vitest (lazy mount, save→plain text, revert) | 🟢 |
| L4 | Word tokens + click-to-seek + active highlight — **D9** | `transcript-word.tsx` + `use-live-transcript.ts` | `/live`; `audioController.seek` | live-transcript vitest (word click/seek/aria-current) | 🟢 |
| L5 | Speaker diarization (text+color, never color-only) + listening pulse | `transcript-segment.tsx` + `listening-pulse.tsx` | `/live` | live-transcript vitest | 🟢 |
| L6 | a11y `role="log"` `aria-live` policy (interim off; off-while-editing) | `live-transcript.tsx` | `/live` | live-transcript vitest (a11y) | 🟢 |

---

## 3. Backend / SDK follow-up dependencies (D7 · D8 · D9 · D10)

The three follow-ups flagged by [README §1 status](../../implementation/TASK-372-Shared-Component-System/README.md) + [§4.8](../../implementation/TASK-372-Shared-Component-System/README.md#48-follow-ups-explicitly-out-of-scope-here). **All resolved** — verified against live source 2026-06-30.

| # | Dependency | Backend / SDK (`/api/v1…` · `file:line`) | Test | Status |
|---|---|---|---|---|
| **D7** | Generic **cursor (keyset) pagination** contract → `{ data, nextCursor, hasMore, limit }`; reference consumer = Audit Log | 🔒 `GET /admin/audit-logs/cursor` `apps/api/src/modules/audit-log/audit-log.controller.ts:132` (`fetchByCursor`) → `CursorPaginatedResponse<T>` `packages/applications/src/common/dto/cursorPaginated.response.ts`; engine `packages/applications/src/common/cursorPagination.ts`; SDK `useAuditLog().listByCursor` + `extractCursorPaginated` (`@arcaai/vox`) | **backend** [`task-372` BE](../../../apps/api/tests/e2e/task-372-shared-components.spec.ts) (envelope/limit/keyset-paging/terminal/400/401/filters); engine+service unit ([TASK-373 §4.1](../../implementation/TASK-373-Cursor-Pagination-DTO/README.md)) | 🟢 **Landed** ([TASK-373](../../implementation/TASK-373-Cursor-Pagination-DTO/README.md) = Completed) |
| **D8** | Per-user grid-layout persistence under the **`ui.data-grid`** user-settings namespace (no new schema) | `PATCH/GET /user/me/settings[/:ns/:key]` `apps/api/src/modules/user/controllers/user-settings.controller.ts:53` + namespace `…/userSettings/userSettings.namespaces.ts:26` (`UI_DATA_GRID`) + `validateUiDataGridValue :56` (JSON string ≤ 16 KiB) | **backend** [`task-375` D8](../../../apps/api/tests/e2e/task-375-admin-features.spec.ts) (PATCH/GET round-trip, upsert, **object-value 400**) — *referenced, not duplicated* | 🟢 **Landed** (endpoint stays open; `ui.data-grid` recognized + value-validated) |
| **D9** | Word-level timings reach the component (`WsTranscriptResult.wordTimestamps`) | SDK: `SttV2WebSocketClient.onTranscript` **and** store `audio.transcriptSegments[].words` (Option A + Option B, `@arcaai/vox`) | live-transcript + timeline vitest (A10) | 🟢 **Both paths available** (README Change History 2026-06-27) |
| **D10** | Admin-console **consumer** of the three components | `apps/admin` (`@arcaai/admin`, port 5174) — Tenants/Users grids, `/history` timeline, `/live` transcript, `/audit-log` cursor grid | **FE E2E** [`task-372`](../../../apps/admin/e2e/task-372-shared-components.spec.ts); admin Vitest + live full-stack E2E ([TASK-374 §5.6](../../implementation/TASK-374-Admin-App-Integration/README.md)) | 🟢 **Done** ([TASK-374](../../implementation/TASK-374-Admin-App-Integration/README.md) = Completed) |
| D1 | Teal token migration of `@arcaai/ui/styles/globals.css` | `packages/ui/src/styles/globals.css` (names preserved, values → TASK-371 teal) | build + visual smoke | 🟢 Done (README §4.1) |
| D3 | PDF render dep (`react-pdf` + pinned `pdfjs-dist`) | `packages/ui/package.json` (both `external`) | build (README §4.2/§4.7) | 🟢 Done |

> **Net:** the component library (A1–A10) is 🟢 across the board, the admin integration (D10) is 🟢, and the two backend deps (D7 cursor, D8 namespace) are 🟢 landed. There are **no open 🔴 backend gaps** for TASK-372 — the remaining work tracked elsewhere is feature breadth on the admin surfaces (TASK-374 follow-ups), not anything this component system blocks on.
