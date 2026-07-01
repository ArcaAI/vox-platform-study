# Admin Console Redesign (TASK-371 → TASK-384) — Open / Remaining Items Review

**Date:** 2026-07-01
**Scope:** TASK-371 through TASK-384 — the Admin Console Redesign epic and its sub-tickets.
**Method:** Read-only review of every ticket doc (`README.md`, `DESIGN-SPEC.md`, `TRACEABILITY-MATRIX.md`, `MANUAL-E2E-TESTS.md`, and the TASK-371 `PHASE-2/3-PLAN.md` + `UNBUILT-SURFACES-DESIGN.md`), plus light code cross-checks where docs were ambiguous.
**Note on doc layout:** Many in-folder `DESIGN-SPEC` / `TRACEABILITY-MATRIX` / `MANUAL-E2E-TESTS` files are now **"Moved" stubs** (under TASK-385 docs alignment) that redirect to central homes at `docs/designs/admin/`, `docs/qa/traceability/`, and `docs/qa/manual-tests/`. Those central targets were read; items below cite the **effective** source.

> This is a **review artifact, not a development ticket** — it is intentionally placed outside `docs/implementation/`.

---

## 1. Status at a glance

| Ticket | Name | Documented status | Open items? | Headline remaining work |
|---|---|---|---|---|
| **371** | Admin Console Redesign (epic) | **In Progress** | **Yes — large** | Design-only epic: many unbuilt surfaces, backend TARGET gaps, heavy backend-E2E test debt; Phase-2/3 plans still "Proposed – awaiting approval" |
| **372** | Shared Component System (`@arcaai/ui`) | **In Progress** | **Yes — small** | Code done + 443 unit tests green; **live E2E not yet run** (no stack); D10 status worded inconsistently |
| **373** | Cursor Pagination DTO | Completed | Minor | Deferred SDK normalizer (since delivered under 372); only Audit Log migrated to cursor mode |
| **374** | Admin App Integration | Completed | Minor | Backend thumbnail follow-ups (real thumbnails, `sharp` binary) — mostly closed by 375/376 |
| **375** | Admin Backend Enhancements | Completed | Minor | Flagged deferrals: paginated context-item enrichment, enum/JSON-path validation, model-aware coercion for other resources |
| **376** | Media Seed & Backfill | Completed | Minor / none | 2 non-blocking fixture follow-ups |
| **377** | Shared Metrics Components | Completed | Minor | Out-of-scope app follow-ups (compose dashboards, migrate `system-health`, fix shadcn `Progress`) |
| **378** | Collection Foundations | **Completed** | **None** | Fully complete per docs |
| **379** | Tenant Detail Pages | **Review** | **Yes** | E2E authored-but-unrun; many TARGET/backend gaps; OCC 428 contract to verify live |
| **380** | Tenant Dashboard | Completed | **Yes** | **Live E2E `TD3` returns 400**; TARGET telemetry tiles; super-admin-only telemetry gap; FE E2E not run |
| **381** | Users Management | **Review** | **Yes** | V1/V2 resolved + validated; FE browser-E2E selector defects open; multiple TARGETs; manual suite unrun |
| **382** | Agent Management | **Review** | **Yes — largest functional remainder** | Client-side-only version diff, unreachable pre-summary slot, 2 TARGET gaps, 7 deferred frames, suites unrun, **stale QA docs vs AG-W fix** |
| **383** | Platform Dashboard + Monitoring | Completed | **Yes** | **R1** route guard, **T1** platform-metrics backend, FE E2E not run, **stale F-NAV1** QA docs |
| **384** | Responsive Admin Surfaces | Completed | **Yes** | **D6** long-tail dialogs, impersonation **T5**, visual-QA sweep, FE E2E run pending |

**Truly "done" (no meaningful open work):** TASK-378 only.
**Done with non-blocking follow-ups:** 373, 374, 375, 376, 377.
**Substantively open:** 371 (epic), 372, 379, 380, 381, 382, 383, 384.

---

## 2. Key conclusions

1. **The epic is design-first, not shipped.** Most of TASK-371's "built" claims refer to **Figma frames**, not application code. The actual app build was split into the downstream tickets. The epic still carries the bulk of the remaining scope.
2. **The single biggest blocker is missing backend.** A large share of frontend surfaces are drawn as **TARGET** (disabled/empty) because the backend endpoints/columns don't exist yet. See the consolidated **Backend backlog** in §3.
3. **Verification debt is pervasive.** Every manual E2E suite is **Not Run**, and most Playwright specs are **authored-but-unrun** pending a seeded Docker stack. Two live findings already exist (TASK-380 `TD3` 400; TASK-381 FE selector defects).
4. **Several QA docs are stale relative to code.** Fixes that landed (AG-W, F-NAV1, V1/V2) are not reflected in their traceability/manual docs — these will mislead testers and understate completion. See §4.
5. **Responsive / dark-mode / icon polish is broadly deferred** across the feature tickets (long tail of tablet/mobile Figma frames, Lucide icon swap, per-screen dark mode).

---

## 3. Consolidated cross-cutting backlogs (rollups)

### 3a. Backend backlog — missing endpoints / columns (the gap behind most TARGET tiles)

| # | Item | Surfaced in |
|---|---|---|
| 1 | Tenant lifecycle status `SUSPENDED` / `ARCHIVED` (F6) | 371, 379 |
| 2 | Tenant `tags` field + endpoint (F9) | 371, 379 |
| 3 | Tenant `plan` field (Enterprise/Pro/Trial/Starter) | 371 |
| 4 | Tenant usage roll-ups endpoint `GET /admin/tenants/:id/usage` (`getUsageStats`) (F7) | 371, 379 |
| 5 | Storage quota/usage on `TenantBucket` + objects/size (S3) | 371, 379 |
| 6 | Department → users reverse listing `GET /admin/departments/:id/users` (D2) | 371, 379 |
| 7 | Per-department DNA writing-style default slot (`dnaWritingStylePromptId` column) (D3/U10/AG13) | 371, 379, 381, 382 |
| 8 | Reset-password endpoint — both flows (emailed link + admin temp password) (U5) | 371, 379, 381 |
| 9 | Server-side bulk user actions endpoint (U6) — currently a client `Promise.allSettled` loop | 371, 381 |
| 10 | User export Excel / PDF (U7) — CSV-only near term | 371, 381 |
| 11 | Admin editing **another** user's preferences — UI wiring (backend GET/PATCH already exist) (U8) | 371, 381 |
| 12 | Per-user prompt scope (`USER_PERSONAL` / `ownerUserId`) (U9) | 381 |
| 13 | DNA reports + versions endpoint / cross-user DNA generate (self-scoped today, 403 for others) (U10/U12) | 371, 381 |
| 14 | Prompt `compareVersions` **server diff** endpoint (today client-side) (A3/AG8) | 371, 382 |
| 15 | Test sub-metrics on SDK `PromptTestResult` (map backend `PromptTestMetrics`) (A5/AG12) | 382 |
| 16 | **Platform runtime metrics backend** (P95, requests/min, error rate, sockets, running models, avg latency, transcription-min, summaries-24h, storage used, consultation aggregation) — **= TASK-371 backlog #14**, the gap behind every platform TARGET tile (T1) | 371, 380, 383 |
| 17 | Open-sockets count endpoint | 371, 380 |
| 18 | Consumption / quota roll-up endpoint | 371, 380 |
| 19 | Per-model audio-stream metrics | 371, 380 |
| 20 | Consultation range aggregation / date-bucketing endpoint (charts under-count long ranges) | 380 |
| 21 | **Tenant-scoped** sessions/health read (so tenant-admins see telemetry; `GET /monitoring/sessions` + `GET /health/services` are `manage all`-gated) | 380 |
| 22 | CASL policy-rules editing — `policies.controller.ts` (R3) | 371 |
| 23 | API-key rotate endpoint (K5) | 371 |
| 24 | Global-settings CRUD `admin/global-settings` (ST1) | 371 |
| 25 | Audit-trail Excel / PDF export (AU2) — CSV only today | 371 |

### 3b. Unbuilt super-admin frontend surfaces (legacy routes predate the redesign)

- `01 · Components` library page
- Roles & Policies (+ CASL policy builder)
- API Keys
- `05 · System Health` (redesigned)
- Settings
- Rate Limits (14), Queues & Jobs (15), Prisma Studio (16)
- Tenant-admin tail: Stores detail, Ambience-listening → Audio processing, Agent Jobs, Harness
- Playground tier (50–59): Clinical Consultation, Live Transcription, Voice profile, DNA Writing style, Summarization

### 3c. QA / verification debt

- **All manual E2E suites are 100% Not Run** (372, 379, 380, 381, 382, 383, 384).
- **Most Playwright specs are authored-but-unrun** pending a seeded stack (`docker:test:up` + `dev:api:test` + `test:db:seed`). `localhost:8868` returned `000` in several passes.
- Partial live runs that did execute:
  - **TASK-374:** live E2E 7 passed / 1 skipped (skip = media, now resolved by 376).
  - **TASK-376:** media check now passes (10 passed).
  - **TASK-380:** backend run exposed **`TD3` → HTTP 400** (super_admin `GET /admin/consultations` with no tenant scope) — deferred to spec owner.
  - **TASK-381:** backend run passed incl. V1/V2; **FE browser run partial — 6 passed, remaining are selector defects** in the FE spec (recorded for follow-up).
  - **TASK-383:** backend E2E 7/7 green; **frontend** Playwright only `--list`-verified (not run live).
- **OCC contract to verify on first live run (TASK-379):** `PATCH /admin/tenants/:id` is `@RequiresIfMatch()` → **428** if `If-Match` missing; confirm the SDK echoes the GET `ETag`.

### 3d. Stale QA docs / doc-vs-code discrepancies (cleanup needed)

| Item | Code reality | Stale doc |
|---|---|---|
| **TASK-382 AG-W** slot-assign contract | **Resolved + live-validated** — `usePrompts.ts:173-177` sends `expectedVersion` → 200 | `traceability/agent-management.md` still marks AG-W 🔴 "contract gap"; `manual-tests/07` still tells QA to "log a defect if it 400s" |
| **TASK-383 F-NAV1** Monitoring nav guard | **Resolved** — `nav.ts:58` sets `requireSuperAdmin: true` | `manual-tests/08` (PDM-03.3 + Findings) + design §4 + traceability R1 still describe Monitoring as ungated / tenant-admin-visible |
| **TASK-381 V1/V2** email-on-create + dept bulk PATCH | **Resolved + validated** (backend E2E passes) | Traceability matrix + manual suite still list V1/V2 as open runtime caveats |
| **TASK-372 D10** admin-console target | Header/§4.8 say resolved via TASK-374 | §3.8.1 still lists D10 as "Open" (internally inconsistent) |
| **TASK-380** status | README header says "Completed" | Traceability header still "Review"; manual suite "Not Run"; live `TD3` 400 open |
| **TASK-371** undrawn surfaces | Central matrix says Roles/Policy-builder, API Keys, Rate Limits, Queues, Settings **designed (v2, 2026-06-30)** under TASK-385 | README §5.16 still lists them as undrawn |

### 3e. Deferred design polish (recurring across 371, 379–384)

- **Lucide icon swap** — placeholder squares/glyphs across all built frames (deferred to implementation).
- **Per-screen dark-mode variants** — only token system + one dark proof exist.
- **Charts/quota bars are illustrative rectangles** — real series wired only at implementation.
- **Tablet/Mobile Figma frames** — a long tail of "Still deferred" variants for tenant-detail, tenant-dashboard, users, agent-management, platform-dashboard, and responsive (mobile `Select` sub-nav, card-list grids, full-screen dialogs, FABs, nav drawer, impersonation frames).

---

## 4. Per-ticket detail

### TASK-371 — Admin Console Redesign (the parent EPIC)

**Status:** `In Progress`. `PHASE-2-PLAN.md` and `PHASE-3-PLAN.md` are both **"Proposed — awaiting approval"** ("Plans only. No feature code, no Figma edits, no commits."). The in-folder `UNBUILT-SURFACES-DESIGN.md` and `TRACEABILITY-MATRIX.md` are now **stubs** pointing to `docs/designs/admin/` and `docs/qa/traceability/`.

**A. Figma file persistence (recurring blocker)**
- Save `HOPE-Admin-Console` so frames stop rotating, then re-create Pass-1/Pass-2 surfaces alongside Pass-3/4 frames in one document (§5.16). The file is still `unsaved-…` with a rotating fileKey; **save before product-tier build-out** (§5.5).
- Lost Pass-1/Pass-2 frames to recreate: `02 · App Shell — Tenants`, `04 · Users`, `06 · Login`, `07 · Consultation History`, `08 · Live Session` (§5.4).

**B. Surfaces not yet drawn** — see §3b above (Components library, Roles & Policies + policy builder, API Keys, System Health, Settings, Rate Limits/Queues/Prisma Studio, tenant-admin tail, Playground tier).

**C. Cross-cutting design debt (explicitly Deferred)** — Lucide icon swap; per-screen dark mode; illustrative chart/quota rects; responsive specs only cover shell/full-screen-table/blade (extend to roles/policy-builder, system health, settings…).

**D. Recorded polish follow-ups** — tenant-admin dashboard variant inherits super-admin sidebar `Platform › Tenants` active state (resolve in shared shell); confirm whether to promote sockets/audio into the dashboard headline 4th tile (§5.14.2).

**E. Backend gaps drawn as TARGET (no backend yet)** — see §3a (dashboard sockets/consumption/per-model audio; users reset-password/export/bulk/admin-edit-prefs; per-dept DNA default; tenant plan; storage quota; aggregate counts).

**F. PHASE-2-PLAN — proposed, not approved/built** — TASK-377 (metrics components), TASK-378 (collection foundations), TASK-379 (originally blade interface, since superseded by page model). Open Questions Q1–Q6 unresolved (frame numbering, real `/dashboard` route, metrics endpoint, tenant plan backing, storage quota, working-tenant vs impersonation).

**G. PHASE-3-PLAN — proposed, plans-only** — design portion largely executed in §5.14, but backend TARGET items remain (sockets, reset-password, export, bulk endpoint, admin-edit-other prefs, consumption/quota roll-ups, per-dept DNA). Open questions Q1–Q6 listed.

**H. Traceability-matrix gaps (master matrix at `docs/qa/traceability/`)** — flagged rows include:
- F4 Edit tenant 🔴 (401 only, no happy-path E2E); F5 enable/disable 🔴 test; F6 archive 🔴 (no SUSPENDED/ARCHIVED; `DEF-ADM-002` system-tenant-unprotected open; `MT-04` not run); F9 tags 🎯.
- O1/O3 tenant dashboard live metrics / audio strip 🎯.
- U2 create user 🔴 (manual only); U4 enable/disable 🔴; U5 reset-password 🔴 (no endpoint); U6 bulk 🔴; U7 export 🎯; U8 admin-edit-prefs ⚠️ TARGET; U10 per-dept DNA slot 🎯; U12 DNA reports 🎯.
- D2 dept→users reverse listing 🔴; D3 default agents per dept 🎯.
- S2 provision system buckets 🔴 (no test); S3 storage quota 🎯.
- A1/A2 agent mgmt 🔴 (no backend E2E); A3 version diff 🔴 (no `compareVersions` endpoint); A5 playground eval score 🎯.
- AU2 export audit trail 🟡 (CSV only).
- **Super-admin tier frontends mostly NOT built:** Roles & Policies (R1–R4), API Keys (K1–K5), Rate Limits (RL1–RL5), Queues & Jobs (Q1–Q3), Settings (ST1–ST3); specific backend gaps R3 (policy editing), K5 (key rotate), ST1 (global settings).
- Coverage snapshot: only ~8 requirements have solid automated backend E2E; biggest debt is **mutations** (tenant update happy-path, tenant lifecycle, all user/department/prompt write flows have no backend E2E). A 14-item "Backlog rollup (gaps → tickets)" is enumerated in the matrix.

**Notes:** Downstream app build lives in TASK-374 and TASK-383/384/385 (385 not in this review's scope). Mild README-vs-matrix inconsistency on which surfaces are "drawn."

---

### TASK-372 — Shared Component System (`@arcaai/ui`)

**Status:** `In Progress` — component system **Completed & verified** (build + 443 unit tests + lint green); **Remaining: execute the new E2E against a running stack.**

- **Live E2E not run** — `curl localhost:8868/api/v1/health` returned `000`; the two new Playwright specs (`apps/api/tests/e2e/task-372-shared-components.spec.ts`, `apps/admin/e2e/task-372-shared-components.spec.ts`) are authored but unexecuted. Status stays In Progress.
- **D10 inconsistency** — §3.8.1 still lists D10 as "Open," while header/§4.8 say it's resolved via TASK-374.
- **D8 backend namespace** — whitelist/recognize the `ui.data-grid` settings namespace (now "recognized + value-validated"; adapter degrades gracefully).
- **Deferred hygiene (non-blocking):** `.js` dynamic-import specifiers + `as unknown as` casts (`pdf-renderer.tsx`/`transcript-segment.tsx`); one `@ts-expect-error` on pdf-worker `import.meta.url`; four names kept off the root barrel (`StatusBadge`, `TranscriptSegment`, `TranscriptWord`, `TimelineItem`); two `@deprecated`-but-kept components (`tool-ui/data-table` `DataTable`, `custom/transcript-viewer.tsx`).
- **DESIGN-SPEC** notes "Figma frames to create later."

---

### TASK-373 — Generic Cursor Pagination DTO (Backend)

**Status:** `Completed`
- Deferred SDK normalizer (`@arcaai/vox` `extractCursorPaginated`) was out of scope here — **since delivered under TASK-372** (the ticket doc still records it as a follow-up).
- Only the **Audit Log** consumer migrated to cursor mode; other append-mostly datasets (consultation/context-item history) remain offset-only (acceptable — cursor is opt-in).

---

### TASK-374 — `apps/admin` + `@arcaai/ui` Integration

**Status:** `Completed`. Live E2E ran 7 passed / 1 skipped (skip = media/DEFECT-M1, since resolved). DEFECT-Q1/D8/P1/F1 all FIXED.
- **D8 backend** — whitelist `ui.data-grid` settings namespace for full round-trip (unit-verified only).
- **Real downscaled thumbnails** — `thumbnailUrl === url` today, so zoom swap is a no-op until true thumbnails ship (backend generation gap).
- **`sharp` native binary** — ensure installed in the API container, else thumbnails degrade to full-size.
- **Media seed + thumbnail backfill** — needed for live verification (addressed by TASK-376).
- **D9 Option B** — SDK store plumbing of `wordTimestamps` through `audio.transcriptSegments` (since implemented in TASK-372; doc still lists it).
- **Live transcript** — inline edits are local; click-to-seek inert during live capture (documented limitation).
- **Pre-existing hygiene (not addressed):** repo-wide `prettier/prettier` whitespace warnings (admin `lint` exits 0 with ~4050 warnings); `bg-gradient-to-b` → `bg-linear-to-b` nit in `login.tsx:62`. Suggested one-shot prettier pass in a separate ticket.

---

### TASK-375 — Admin Backend Enhancements

**Status:** `Completed`. Core items (users default sort, media URLs, D8 service-level validation, DEFECT-F1 boolean fix, model-aware coercion) shipped green.
- `getContextItemsPaginated` **not enriched** — if the admin timeline ever uses the paginated route, it should call the same `attachMediaUrls` enrichment.
- **Thumbnail backfill** for pre-existing images (handled by TASK-376).
- **Enum member validation deferred** to Prisma (flagged).
- **Structured JSON-path filtering deferred** (JSON columns recognized but left as strings; flagged).
- **Model-aware coercion not yet adopted** by other list resources (tenant, media, role, permission, tag, webhook, notification…) — trivial, deferred to stay surgical.

---

### TASK-376 — Media Seed & Thumbnail Backfill

**Status:** `Completed` (DEFECT-M1 resolved; seed + backfill verified idempotent + MinIO-absent-guarded; media Playwright check now passes, 10 passed; CI wired).
- **Audio fixture** is a plain `audio/wav` attachment — if the timeline later needs full recording/transcription playback, seed a recording-shaped fixture too.
- **Generalize the media test owner** — currently hardcoded to seeded `doctor`/`__GLOBAL__`; parameterize username/tenantKey via env if `E2E_CONSULTATION_ID` points elsewhere.

---

### TASK-377 — Shared Metrics / Reporting / Chart Components

**Status:** `Completed` (suite 561/561, build + lint green; all acceptance criteria met).
- **Follow-up (out of scope — app tickets):** build the Dashboard (frame 10) + Service Monitoring (frame 11) screens composing these primitives.
- **Follow-up:** migrate `apps/admin/system-health.tsx` onto `StatCard`/`ServiceStatusBar` (import from `@arcaai/ui/components/metrics`); then retire legacy `custom/service-status-bar.tsx` and dissolve the root-barrel collision.
- **Follow-up (optional):** fix shadcn `Progress` to forward `value` to the Radix root so the call-site `aria-valuenow` workaround can be dropped.
- **Standing tech-debt:** canonical `ServiceStatusBar` deliberately not root-barrel-exported until the app migrates off the legacy bar.

---

### TASK-378 — Collection Foundations (Card-Grid · Item-List · Scroll-Spy Timeline)

**Status:** `Completed` — **No open items found; fully complete per docs.** Every §4a requirement ✅; all acceptance checklists satisfied; `useTimeline` refactor API-stable; suite 488/488; build + lint clean. "Known non-issues" are Edge-Tools editor false positives only.

---

### TASK-379 — Page-based Tenant Detail + App-Shell Upgrades

**Status:** `Review` — implementation shipped & green; design/traceability/E2E artifacts added (**E2E authored; run pending a seeded stack**).
- **E2E not executed (blocked on stack):** `task-379-tenant-detail.spec.ts` (24 backend + 5 FE × 3 viewports) LIST-only; live gate `⏸ NO_STACK (HTTP 000)`.
- **OCC contract to verify live:** `PATCH /admin/tenants/:id` is `@RequiresIfMatch()` → 428 if `If-Match` missing; confirm SDK echoes GET `ETag` (no code change made this pass).
- **TARGET fields (drawn disabled/empty):** Overview "Pipelines" KPI + aggregate roll-ups (no `getUsageStats` hook); Users "Add member" + reset-password/export/bulk; Storage usage/quota, per-bucket Objects & Size, "Rotate keys", "Manage provider"; tenant `tags`, `SUSPENDED`/`ARCHIVED`.
- **Deviations / follow-ups:** expose `GET /admin/tenants/:id/usage` as a `useTenants` method; SDK `useTenants` methods don't accept `expectedVersion`; department members derived client-side (no `listByDepartment` — server endpoint is the scale follow-up).
- **Traceability gaps:** F2/F3 🟡; F4 🟡 (was 🔴); F5 🟡; F6 🎯+🟡; F7 🎯; F9 🔴/🎯; F8/SH1–SH5 🟡; C1 🟡; S2 🟡+🔴; S3 🎯; D1 🟡; D2 🟡+🔴; D3 🟡+🎯; D4 🟡.
- **Manual E2E suite entirely Not Run** (TD-01…TD-08, 49 cases, all Status `—`). Carry-forward defects to re-verify: `DEF-ADM-001` (case-insensitive key), `DEF-ADM-002` (backend DELETE must also block system tenant).
- **Deferred Figma frames:** Tablet variants of `18p/20p/22p/37p/34p/36p`; Mobile variants (tab→Select, grid→card-list, FAB, full-screen dialogs); `37p · Storage` mobile card-list; `Dlg · Disable Tenant` mobile full-screen; `Dlg · Add Tenant` Tags + Initial-status (TARGET); Overview empty/error/loading frames.
- **Lint:** ~5,709 `prettier/prettier` + `react-hooks/exhaustive-deps` warnings (0 errors), pre-existing/project-wide.
- **Discrepancy:** §4.7's OCC wording ("If-Match isn't possible") is flagged imprecise but deliberately not corrected.

---

### TASK-380 — Tenant Dashboard (frame 18d)

**Status:** `Completed` — review pass done; feasible gates green; live E2E authored (run pending stack), with one live finding.
- **Live E2E finding — `TD3` FAILS:** `GET /admin/consultations` for a super_admin with no tenant scope → **400**; flagged as a spec/contract nuance for the spec owner (no dashboard product change needed).
- **Frontend E2E not executed** (no stack; FE `task-380` spec = 15 tests, authored).
- **TARGET tiles (no backend):** open sockets, consumption, per-model audio-stream counts, full server-side range aggregation (charts under-count long ranges).
- **🔒 Super-admin-only telemetry gap:** `GET /monitoring/sessions` + `GET /health/services` are `manage all`-gated, so tenant-admin Running-sessions / Services-healthy / audio-pipeline tiles degrade to em-dash/Unknown — needs a tenant-scoped read.
- **Non-blocking:** `rangeWindow` exported + unit-tested but **not consumed** by `overview.tsx` (harmless dead export); `ConsultationChartRow` index signature added for `MetricChart` typing.
- **Backlog rollup (5 candidate backend tickets):** tenant-scoped live telemetry; open-sockets endpoint; consumption/usage roll-up; per-model audio counts; consultation range aggregation.
- **Traceability:** TD1 🟡🔒, TD2 🟡🎯, TD3 🟡🎯, TD5 🟡🔒🎯, TD6 🟡 (only TD4/TD7 🟢); cross-links P1 🟡, P3 🎯, M1 🟡🔒 (for TASK-383).
- **Manual E2E suite entirely Not Run** (TDB-01…TDB-07).
- **Deferred Figma frames:** `18d` Tablet + Mobile; tenant-admin degraded-telemetry state; partial-failure state; DateRangeSelector/TenantFilter open-states; per-tier dark-mode; TARGET-annotation legend.
- **Discrepancy:** README "Completed" vs traceability "Review" + manual "Not Run" + the actual `TD3` 400 open.

---

### TASK-381 — Users Management (frames 20u + 38u)

**Status:** `Review` — V1 + V2 backlog gaps **RESOLVED + live-validated (2026-06-30)**.
- **Frontend browser E2E — partial:** 6 passed; remaining are **selector defects** in the never-run subagent FE spec (e.g. non-`exact` `getByText`) — unrelated to V1/V2, recorded for follow-up.
- **TARGET capabilities (drawn disabled, no backend):** profile name/phone/specialty edit; preferences-for-another-user UI (backend GET/PATCH exist); per-user-scoped agent instructions (`USER_PERSONAL`/`ownerUserId`); DNA writing-style edit + cross-user generate; reset-password; Excel/PDF export; server-side bulk endpoint.
- **Deviations:** "Last active" column omitted (TARGET); Roles column best-effort; DNA report generation disabled for other users.
- **Traceability rows not 🟢:** U2 🟡, U6 🟡🎯, U7 🟡🎯, U8 🟡, U9 🟡🎯, U10 🟡🎯, U12 🟡🎯, U2b 🟡🔴, X6 🟡; U5 🎯.
- **Contract corrections to verify live:** U12/U10 DNA `getByDoctor`/`getVersions` are self-only (403 for another doctor) → panels degrade to empty for another clinician; `getVersionDiff` composed client-side; U8 admin settings endpoints exist but SDK/UI doesn't wire them.
- **Manual E2E suite Not Run** (all `T381-*` Status `—`); several pre-marked NA/Target (G.11 reset-password, G.14 Excel/PDF, Pb.1 preferences, Pc.2 per-user scope, Pd.3/Pf.2 DNA). Caveats to verify: C.6 (email-on-create — V1), G.17/C.8 (dept PATCH — V2).
- **Deferred Figma frames:** `20u` Tablet + Mobile card-list/FAB; `Dlg · Create User` mobile full-screen; `38u` mobile `Select` tab switcher + tablet scrollable tabs; panels a–g mobile single-column; `38u-d`/`38u-f` other-user empty-state; `Dlg · Assign Departments` single-row + bulk + mobile full-screen.
- **Discrepancy:** V1/V2 confirmed resolved in code but still listed as open caveats in the current traceability matrix + manual suite (stale).

---

### TASK-382 — Agent Management by Department (frames 30–33)

**Status:** `Review` (the **only** feature ticket not marked Completed) — AG-W contract gap **RESOLVED + live-validated**.
- **Pre-summary slot unreachable from frame 30:** `assign-department` ignores pre-summary (only `prompt-config` sets it); UI routes all slots through `assign-department`. AG-W fix wired new-patient/revisit + `expectedVersion`, but pre-summary routing is not confirmed closed.
- **Version diff client-side only (AG8/A3 🟡):** no server diff endpoint; SDK `compareVersions` GETs both versions and diffs client-side.
- **DNA writing-style default slot is TARGET (AG13/D3/U10 🎯):** no `dnaWritingStylePromptId` column — drawn + flagged, never wired.
- **Test sub-metrics TARGET (AG12/A5 🟡🎯):** backend `PromptTestResultResponse.metrics?` exists but SDK `PromptTestResult` omits it; admin expects a different shape — map `PromptTestMetrics` to the display shape.
- **Playground headline score/run partially tested (AG10/AG11 🟡):** OCC tested; SMR run env-dependent (200-path only against a seeded stack).
- **E2E run pending a seeded stack** (SMR-dependent AG10 + full FE journey).
- **Entire manual suite unrun** (T382-A/C/E/V/T/X all Status `—`); the "requirement available at current stage?" gate is entirely unchecked (8 rows `☐`). Note A.slot.1/.2 still expect a 400 defect log (pre-fix doc).
- **7 deferred Figma frames:** Tablet+Mobile of `30`; Mobile `31`/`32`/`33`; workspace sub-tabs → mobile `Select` (TASK-384 follow-up); `Dlg · New Agent Instruction` mobile full-screen; DNA slot wired state. Screenshots/pixel alignment deferred (no Figma file connected).
- **Discrepancy (stale QA docs):** README says AG-W RESOLVED and code matches (`usePrompts.ts:173-177`), but `traceability/agent-management.md` still marks AG-W 🔴 and `manual-tests/07` still tells QA to log a defect on 400.

---

### TASK-383 — Platform Dashboard + Monitoring (frames 10 & 11)

**Status:** `Completed` — feasible gates green; **backend E2E 7/7 green**; F-NAV1 resolved. Named follow-ups: R1, T1.
- **R1 — no route-level super-admin guard** on `/dashboard` or `/system-health` (nav-hide + API-403 only); add a role-aware route `beforeLoad` guard once router context carries roles (tracked vs shell / TASK-384).
- **T1 — platform runtime metrics backend missing** (the gap behind every TARGET tile): transcription-min, summaries-24h, storage used; server-side consultation aggregation/date-bucketing; requests/min, error rate, sockets/min, total sockets + request-volume series; per-service P95; per-model Running + avg latency; plus omitted deltas/breakdowns. **= TASK-371 backlog #14.**
- **REAL rows 🟡 pending live-stack run** (P1, P2-users, M1, G1); **frontend** Playwright only `--list`-verified (not run live; admin dev server wasn't listening).
- **Manual suite entirely unchecked** (PDM-01…PDM-04).
- **Mobile `MetricTable` is horizontal-scroll only** — card-list/stacked variant is backlog (TASK-384).
- **7 deferred Figma frames:** `10a/10b/10c`, `11a/11b/11c` (tablet/mobile/states), `10/11 TARGET annotations`.
- **Export / Configure-alerts** are info-toast placeholders (TARGET).
- **Deviation:** global footer `ServiceStatusBar` intentionally not added (shared chrome outside this ticket's file set).
- **Discrepancy (stale QA docs):** F-NAV1 resolved in code (`nav.ts:58` `requireSuperAdmin: true`) but `manual-tests/08` (PDM-03.3 + Findings) + design §4 + traceability R1 still describe Monitoring as ungated.

---

### TASK-384 — Responsive Admin Surfaces

**Status:** `Completed` — all responsive primitives built; pure-logic unit-tested 🟢; transforms covered by authored FE E2E (run pending a seeded stack) 🟡. (No backend by design.)
- **§7 Backlog — long-tail dialogs not full-screen on mobile (D6 🔴):** not yet applied to `agent-instruction-dialog`, `policy-form-dialog`, `AlertDialog`-based confirms (`confirm-delete.tsx` needs its own `AlertDialogContent` fragment), and any agent/role sheets (pattern is ready — apply `MOBILE_DIALOG_CONTENT` + footer fragment).
- **§7 — dialog body touch targets:** footer buttons 44px on mobile, but in-form `Input`/`Select` triggers keep default `h-9`.
- **§7 — tenant-detail inner tables** rely on shadcn `Table` horizontal-scroll fallback (no card-list).
- **§7 — global Departments card-list:** currently horizontal-scroll; a mobile card-list would match other grids.
- **§7 — Visual QA not performed:** manual device/emulator sweep (or Playwright viewport snapshots) against `foundation-16-responsive.png` recommended before sign-off.
- **Impersonation (T5 🎯):** "Impersonate user" action + indigo `--ai` mode banner not built (remains a TASK-371 backlog item).
- **FE E2E authored but not run live:** only pure-logic rows 🟢 (G2, G6, D1, L1–L3); shell (S1–S5), switcher (W1–W3), grids, tabs (T1–T4), dialogs (D2–D5), KPI reflow (K1–K3) all 🟡.
- **Entire manual / Visual-QA suite unrun** (RSP-01…RSP-06), incl. known-gap RSP-04.7 (`AlertDialog` confirms not full-screen).
- **8 deferred Figma frames:** Tenants list Tablet/Mobile; Tenant Users mobile card-list (kebab + bulk-bar); Tenant Detail mobile `Select` sub-nav; User Detail mobile `Select` (7 panels); Platform Dashboard/Monitoring tablet+mobile reflow; Dialog mobile full-screen; Mobile nav drawer production-nav; Impersonation responsive frames.
- **Documented deviations (not defects):** plan §3.7 `overflow-x-auto` not added (shadcn `Table` already wraps); dialog full-screen boundary is `sm` (640), one step tighter than the `md` (768) shell/grid boundary (intentional; flagged so QA doesn't file the 640–767 band).

---

## 5. Suggested triage order

1. **Stand up the seeded test stack and run all authored E2E + manual suites** (372, 379, 380, 381, 382, 383, 384). This converts a large amount of "🟡 authored" debt into pass/fail signal, and will surface real defects (the `TD3` 400 and FE selector defects are already known).
2. **Refresh the stale QA docs** (§3d) so AG-W (382), F-NAV1 (383), and V1/V2 (381) reflect the landed fixes; reconcile D10 (372) and TASK-380's status header.
3. **Prioritise the backend backlog (§3a)** — it unblocks the majority of TARGET surfaces in 379/380/381/382/383. The platform-metrics backend (#16, T1) is the highest-leverage single item.
4. **Decide Phase-2/3 approval (371)** and the open product questions (working-tenant vs impersonation, tenant plan, storage quota, export formats, reset-password flow).
5. **Schedule the deferred responsive/design polish** (tablet/mobile frames, Lucide icons, dark mode, D6 dialogs, impersonation) as a dedicated pass.
