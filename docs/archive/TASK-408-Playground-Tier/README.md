# TASK-408 — Playground Tier (screens 50–59) in the Admin Console

| | |
|---|---|
| **Ticket** | TASK-408 |
| **Type** | feature (frontend-only — `apps/admin` + FE E2E; **no backend, no SDK, no DB**) |
| **Created** | 2026-07-02 |
| **Updated** | 2026-07-02 |
| **Status** | Completed |
| **Design source** | Figma layer taxonomy `.cursor/rules/12-design-workflow.mdc` §3 (band **50–59 · Playground — "admins exploring the apps"**); TASK-371 README §4.2/§5.5 (tier list; **no 50–59 frames drawn**); `docs/designs/admin/README.md` (50–59 "_not yet specced here_"); legacy behaviour reference `knowledge/playground/*` + `apps/ui-playground` (read-only) |
| **Backlog** | `docs/qa/OPEN-ITEMS-BACKLOG-2026-07-01.md` **P2-2** / review §3b — "Playground tier (50–59): Clinical Consultation, Live Transcription, Voice profile, DNA Writing style, Summarization" |

> **Ticket-number check (2026-07-02):** `docs/implementation/` highest existing is **TASK-406**; a sibling worker created **TASK-407** this wave (not yet on disk when checked). **TASK-408 is the next free number** — confirmed by directory listing + parent brief.

---

## 1. Requirement Analysis

Build the **Playground tier (screens 50–59)** in the admin console (`apps/admin`). The playground tier is the design taxonomy's last product band: surfaces where **admins explore the clinical apps' capabilities** (the consultation lifecycle, live STT, voice enrollment, DNA writing style, summarization) through the same `@arcaai/vox` SDK the clinical apps use — without touching backend code.

### 1.1 What the design says (scope discovery)

The 50–59 band is **named but never drawn**: no Figma frames exist (TASK-371 §5.5 "Gap to taxonomy"; §5.16 lost-frames note; `docs/designs/admin/README.md` lists 50–59 as "_not yet specced here_"). The only normative design inputs are:

1. **The taxonomy** (`12-design-workflow.mdc` §3): `50–59 · Playground (admins exploring the apps) — Clinical Consultation, Live Transcription, Voice profile, DNA Writing style, Summarization`. Five screens; "the admin app's routes, menu visibility, and role guards must mirror these tiers."
2. **The design contract** every admin surface inherits (`unbuilt-super-admin-surfaces.md` §2): tokens-only, dot+label status, `tabular-nums`/`font-mono`, skeleton/empty/error states, ≥44 px targets, responsive degrade.
3. **The legacy behaviour reference**: `apps/ui-playground` (`knowledge/playground/01–05`) shows what each screen *does* — consultation CRUD + context + summaries (gated on doctor identity), live transcription capture, voice-profile enrollment, DNA style generate/browse, pre-summary/summary generation.

Per the brief: screens that are spec-only get their **unambiguous core** built to the established admin patterns, with the rest flagged.

### 1.2 Derived 50–59 screen mapping (the scope decision)

| # | Screen (taxonomy) | Decision | Admin route | Backing SDK (all pre-existing) |
|---|---|---|---|---|
| **50** | Clinical Consultation | **BUILT (new)** — consultation-lifecycle explorer: tenant-wide list → detail (fields · context items · summaries split out of `contextItems`), sandbox "Start consultation" gated on doctor identity | `/playground/consultation` | `useAdminConsultations` (`list` + `get` — the admin GET; the end-user GET is owner-scoped and denies admins) + `useArca().session.open` (start) |
| **51** | Live Transcription | **COVERED by the existing `/live` route** ("Live Session", Clinical Operations nav) — the same `LiveTranscript`-over-capture surface the playground tier describes. **Not rebuilt** (additive-nav constraint; see §3 flag F7) | `/live` (existing) | `useArca().audio` |
| **52** | Voice profile | **BUILT (new)** — enrollment lifecycle: enroll ≤3 audio samples + label, list, activate/deactivate, delete | `/playground/voice-profile` | `useVoiceEmbedding` |
| **53** | DNA Writing style | **BUILT (new)** — My style (attributes + versions + generate w/ job polling) · All reports (admin, tenant-scoped) | `/playground/dna-style` | `useDnaStyle` |
| **54** | Summarization | **BUILT (new)** — SMR sandbox over a selected consultation: summaries (summary-type context items with `summaryMeta` model/latency/tokens) + generate summary / pre-summary, generation honestly gated on the doctor-scoped SDK session | `/playground/summarization` | `useAdminConsultations` (read) + `useArca().session.load` (generation gate) + `useArcaSummary` (generate) |
| 55–59 | — | **Unassigned in the design** (the taxonomy names only 5 screens). Flagged as free band | — | — |

**Stays in `apps/ui-playground` (not rebuilt in admin):** the *developer-facing SDK playground* — installation/introduction/doc-panel pages, the prompts sub-app, clinical-workspace, audio batch tools, the local (in-browser) voice-embedding demo, and API-base-URL/impersonation-token plumbing. Those are SDK developer tools, not "admins exploring the apps"; the admin console gets the five admin-exploration surfaces only. `apps/ui-playground` is untouched.

### 1.3 Tier gating

The taxonomy audience is "**admins** exploring the apps" → nav entries are `requireAdmin: true` (tenant-admin + super-admin), exactly the shared-tier (`20–29`) gating pattern already used for API Keys / Audit Log. **No route-level `beforeLoad` guard** — mirrors the API Keys precedent (`requireAdmin` surfaces are nav-gated; the server's CASL stays the source of truth), and every playground API call is self- or tenant-scoped, so a direct URL hit by a doctor leaks nothing (the admin-list calls 403 server-side). `requireSuperAdmin` would be wrong here — the design reserves that for the 10–19 band.

### Acceptance criteria

- Nav shows a **Playground** section (Clinical Consultation · Voice Profile · DNA Writing Style · Summarization) to super-admins and tenant-admins; hidden from doctors. Existing sections (incl. TASK-403's Operations + Developer) preserved.
- All four routes render with honest loading/empty/error states; every affordance is backed by a real SDK method or explicitly disabled with an explanation (TARGET honesty).
- Sandbox mutations only: start-consultation is doctor-identity-gated (matches the legacy playground's access rule); voice-profile delete is confirm-guarded; summary/DNA generation are additive operations labelled as sandbox actions.
- `pnpm --filter @arcaai/admin type-check` + `build` green; unit tests for the pure helpers green; no new lint errors.
- Playwright spec `apps/admin/e2e/task-408-playground-tier.spec.ts` authored (nav visibility per tier, each screen renders, honest states); one live-run attempt against the shared stack (never restarting it).

---

## 2. Current State Evaluation

- `apps/admin` has **no playground routes/features**; nav (`lib/nav.ts`) has no Playground section. `/history` + `/live` (Clinical Operations) already exercise the timeline + live-transcript shared components (TASK-374) — `/live` **is** screen 51's surface.
- **SDK (`@arcaai/vox`) already ships every hook needed** (nothing to add): `useAdminConsultations` (tenant-wide list, admin-gated), `useArca().session.load/open` + `.context.items`, `useArcaSummary` (loadSummaries/generateSummary/generatePreSummary), `useVoiceEmbedding` (enroll/list/activate/deactivate/delete), `useDnaStyle` (getMyStyle/getMyReports/getVersions/generate/pollJobStatus + `adminListReports` tenant-scoped).
- Established admin patterns to reuse: `PageHeader`, `StatusBadge` (dot+label), `ConfirmDelete`, `MOBILE_DIALOG_CONTENT`/`MOBILE_DIALOG_FOOTER` (TASK-384/399), skeleton-loading rule, feature-folder pure helpers with unit tests (TASK-403 style).
- TASK-401 impersonation swaps the whole admin session to the target user — so the doctor-identity gate on start-consultation derives from the **current** `user.roles` (an admin impersonating a doctor passes it).

## 3. Implementation Plan (TDD)

| # | Step | Test first | Then |
|---|---|---|---|
| 1 | Pure helpers `features/playground/playground-format.ts` (status→role maps, consultation labels, DNA attribute extraction, doctor-identity gate, ms formatting) | `features/playground/__tests__/playground-format.test.ts` (RED) | implement (GREEN) |
| 2 | Feature components: `enroll-voice-dialog.tsx`, `generate-dna-dialog.tsx`, `start-consultation-dialog.tsx` | covered by FE E2E + helper tests | build to the shared dialog pattern |
| 3 | Routes `routes/_authenticated/playground/{consultation,voice-profile,dna-style,summarization}.tsx` | covered by FE E2E | build to the design contract |
| 4 | `lib/nav.ts` — add **Playground** section (additive; preserve Operations/Developer) | task-391 nav spec unchanged | 4 entries, `requireAdmin: true` |
| 5 | Author `apps/admin/e2e/task-408-playground-tier.spec.ts` | `--list` compile gate | live attempt per §5 protocol |
| 6 | Static gates: admin unit tests, `type-check`, `build`, ReadLints | — | capture evidence |
| 7 | Screenshots of representative screens → `.uxu-verify/task-408-*` | — | reference here |

**Verification protocol (shared stack — not owned):** poll `http://localhost:8868/api/v1/health` → 200 before the live FE E2E; if the API bounces mid-run (TASK-407 owns `:8868`), retry once, else mark **authored-and-deferred**. Never restart/rebuild `:8868` or `:5174`.

### FLAGGED gaps (→ backlog)

| # | Flag |
|---|---|
| F1 | **No Figma frames for 50–59** — built to the taxonomy + design contract + legacy behaviour; frames should be drawn back from the build (same debt every unbuilt-surface ticket carries). |
| F2 | **Start consultation requires doctor identity** — `POST /consultations` creates doctor-owned records, so the affordance is disabled for plain admins with an explanatory caption (enabled under TASK-401 impersonation of a doctor, or for a doctor session). Product decision "admin-owned sandbox consultations" = backend backlog. |
| F3 | **DNA "All reports" is tenant-scoped even for SUPER_ADMIN** (backend/SDK constraint on `adminListReports`, TASK-388 #13) — captioned honestly; cross-tenant browse = backlog. |
| F4 | **Voice-profile sample playback/download** — no endpoint (metadata only); no player rendered. |
| F5 | **Per-metric summary evaluation** — same TARGET as the agents test-playground (backend `PromptTestMetrics` mapping gap, review §3a #15); summarization shows the real `summaryMeta` (model · latency · tokens) and never fabricates a metric breakdown. |
| F6 | **55–59 unassigned** — the taxonomy names only five playground screens; band left free. |
| F7 | **Screen 51 placement** — `/live` ("Live Session") stays under Clinical Operations: the brief requires additive nav changes, and moving/renaming the entry would churn QA docs + specs that reference it. If the design later wants it listed under Playground, it's a 2-line `nav.ts` move. |
| F8 | **`docs/designs/admin/README.md` tier table** still says 50–59 "not yet specced here" — that index is outside this ticket's file set (docs-alignment follow-up). |
| F9 | **Cross-tenant super-admin cannot read consultation detail** — `getByIdWithRelations` hard-requires a CLS tenant, and the tenant-less `super_admin` session gets 400 "Tenant ID is required" (the known TASK-331 #1 platform gap; the admin LIST works because `listConsultationsForTenant` branches on empty tenant). The detail panes surface the honest scope error with remediation ("sign in with a workspace key, or impersonate") instead of spinning. Backend fix = TASK-331 backlog. |
| F10 | **Summary generation is doctor-ownership-scoped server-side** — `POST` summary/pre-summary passes only for the owning doctor (or an impersonated doctor). The Summarization screen mirrors the rule: generate unlocks only when the doctor-scoped SDK `session.load` succeeds; admins keep full read access via the admin surface. Product decision "admins can trigger regeneration" = backend backlog. |

## 4. Implementation Summary

Four new admin routes under a new **Playground** nav section (`requireAdmin`), all FE-only over pre-existing `@arcaai/vox` hooks. No backend, SDK, schema or `apps/ui-playground` changes.

### Files created

| File | Purpose |
|---|---|
| `apps/admin/src/features/playground/playground-format.ts` | Pure helpers: status→role map, consultation option labels, doctor-identity gate, voice-profile state badge, DNA attribute extraction, ms formatting, summary-context-type split (`splitPlaygroundContext`), context-type labels |
| `apps/admin/src/features/playground/__tests__/playground-format.test.ts` | Unit tests for every helper (TDD — written RED first) |
| `apps/admin/src/features/playground/start-consultation-dialog.tsx` | Sandbox start/resume dialog (patientId + appointmentDate), mobile-responsive |
| `apps/admin/src/features/playground/enroll-voice-dialog.tsx` | ≤3 audio samples + optional label enrollment dialog |
| `apps/admin/src/features/playground/generate-dna-dialog.tsx` | Writing-samples textarea → `splitTextSamples` → generate; closes on queue (job polls on the page) |
| `apps/admin/src/routes/_authenticated/playground/consultation.tsx` | Screen 50 — master-detail explorer over the ADMIN consultation surface; summaries split from `contextItems`; start gated on doctor identity; honest tenant-scope error state (F9) |
| `apps/admin/src/routes/_authenticated/playground/voice-profile.tsx` | Screen 52 — enrollment status card (fail-closed caption), profile table, activate/deactivate, confirm-guarded delete |
| `apps/admin/src/routes/_authenticated/playground/dna-style.tsx` | Screen 53 — My style (attribute chips + versions + generate with `pollJobStatus`) · All reports (tenant-scoped admin list, paginated) |
| `apps/admin/src/routes/_authenticated/playground/summarization.tsx` | Screen 54 — summaries with `summaryMeta` (model · latency · tokens); generation gated on the doctor-scoped SDK session (F10) |
| `apps/admin/e2e/task-408-playground-tier.spec.ts` | FE E2E — nav per tier × screens render × honest states (27 tests across desktop/tablet/mobile) |

### Files modified

| File | Change |
|---|---|
| `apps/admin/src/lib/nav.ts` | **Additive**: Playground section (4 entries, `requireAdmin: true`) between Settings and Developer; Operations + Developer (TASK-403) untouched; icon imports extended |
| `apps/admin/src/routeTree.gen.ts` | Regenerated (`pnpm --filter @arcaai/admin generate-routes`) |

### Key decisions

- **Reads go through the ADMIN consultation surface** (`/admin/consultations`, `@CanManage('Consultation')`): the end-user GET is owner-scoped (`verifyConsultationAccess`) and rejected the tenant-admin in the first live run. Summaries render from summary-type context items (`RAW/MODIFIED/PRE_SUMMARY` + `summaryMeta`) — same data, admin-readable.
- **Honest gates over faked capability**: start-consultation disabled without a doctor identity (caption explains impersonation path); generation disabled unless the doctor-scoped `session.load` succeeds; super-admin detail reads surface the F9 tenant-scope error with remediation.
- The SDK's `AdminDnaReportPage` isn't barrel-exported — derived locally via `Awaited<ReturnType<UseDnaStyleReturn['adminListReports']>>` (no SDK edit).

## 5. Verification Evidence (2026-07-02)

| Gate | Result |
|---|---|
| Unit tests | `pnpm --filter @arcaai/admin test -- run src/features/playground` → suite green: **51 files / 395 tests passed** (playground-format tests included) |
| Type-check | `pnpm --filter @arcaai/admin type-check` → clean for all TASK-408 files. ⚠ Final repo-wide run shows **pre-existing errors in TASK-407's uncommitted files** (`tenants/$tenantId/route.tsx`, `tenants/$tenantId/storage/$bucketId.tsx` — sibling's lane, mid-flight); zero errors in playground/nav/e2e files |
| Build | `pnpm --filter @arcaai/admin build` → `✓ built in 9.83s` (chunk-size warnings pre-existing) |
| Lints | ReadLints on all created/edited files → no errors |
| Spec gate | `playwright test task-408 --list` → 27 tests discovered |
| **Live E2E** | API health `:8868/api/v1/health` → 200 before run. `SKIP_DB_PRECHECK=true pnpm exec playwright test --config apps/admin/playwright.config.ts task-408` → **27 passed (13.8s)** — desktop + tablet + mobile |

### Screenshots (`.uxu-verify/`)

| File | Shows |
|---|---|
| `task-408-consultation-detail.png` | Screen 50, tenant_admin desktop — list + loaded detail (fields, 4 context items, summaries empty state), start-consultation honestly disabled with gate caption |
| `task-408-voice-profile.png` | Screen 52, super_admin desktop — "No active profile" fail-closed status card, empty table, enroll CTA, F4 caption |
| `task-408-dna-style.png` | Screen 53, super_admin desktop — My style / All reports tabs, honest empty state, Playground nav section visible |
| `task-408-summarization-mobile.png` | Screen 54, tenant_admin @ 390px — wrapped generate actions (disabled + gate caption), summaries empty state, F5 footnote |

## 6. Change History

| Date | Change |
|---|---|
| 2026-07-02 | Ticket created; 50–59 mapping derived from taxonomy + legacy playground (no Figma frames exist); plan per parent brief (FE-only, additive nav, shared-stack verify protocol). |
| 2026-07-02 | Implementation complete. Live-run findings folded in: detail reads moved to the admin consultation surface (end-user GET is owner-scoped), F9 (super-admin tenant-scope 400) and F10 (doctor-scoped generation) flagged with honest UI states. All 27 E2E tests green on the shared stack. Status → Completed. |
