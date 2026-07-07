# TASK-435 — Playground: My DNA Writing Style (frame 53)

- **Status**: Review
- **Type**: feature — screen `/playground/dna-writing-style` in `apps/admin-console`
- **Created**: 2026-07-06
- **Parent**: TASK-420 row 37 (matrix + approved frame `53 - My DNA Writing Style`); foundation TASK-431

## Requirement Analysis

Self/doctor DNA writing-style plane (the tenant-admin grid is `/dna-writing-styles`, tier 30–49 — this is the SELF view):

- **My-style card**: `GET /dna-writing-styles/my-style` (404 = empty state), report list `GET /dna-writing-styles/mine` with set-default (`PATCH :reportId/default`), version timeline (`GET :reportId/versions`).
- **ETag-aware edit**: `PATCH :reportId` with `If-Match` from the read ETag (missing → 428, drift → 412 — reuse `patchWithEtag`/`versionFromEtag` from `@/shared/api`).
- **Generate pane**: `POST /dna-writing-styles/generate` → `{ jobId, status }`, SSE job progress via `useEventStream` (path `dna-writing-styles/jobs/:jobId/stream`, events `status/progress/result/error` — reuse the existing `dnaJobStreamPath` pattern from `src/features/dna-writing-styles`).
- **DNA on/off toggle**: `GET/PUT /dna-writing-styles/settings` (`{ doctorToggle, tenantEnabled, effective, version }`, OCC 412).
- **Impersonation gate (designed state, not an error)**: `generate` + `PUT settings` return 403 (`assertActingAsDoctor`) for a non-impersonating, non-clinical admin — render the prominent "Act as a doctor" GATE panel per the frame.
- Working tenant required for elevated admins (`<WorkingTenantGate>`). State variants: loading/empty/error/NoTenant/403-gate; light + dark.

## Implementation Plan

1. Failing tests: api client paths (incl. If-Match), 403-gate rendering, generate + SSE wiring.
2. Feature `src/features/playground-dna-style/` api layer + components over `ScreenTemplate`; routes under `(playground)/playground/dna-writing-style/`.
3. Verify: `pnpm --filter @arcaai/admin-console test lint`; axe 0 violations; both themes.

### Detailed plan (2026-07-06, after exploration)

Endpoint shapes verified against `apps/api/src/modules/dna-writing-style/dna-writing-style.controller.ts` (self controller, `@Controller('dna-writing-styles')`, class `@Authorize()`) and the `@arcaai/applications` DTOs (`DnaSettingsResponse`, `UpdateDnaSettingsRequest`). Canonical console patterns replicated (never imported) from `src/features/dna-writing-styles` (frame 33 admin feature).

| Step | Files | Verify |
|---|---|---|
| 1. Failing api tests | `api/__tests__/dna-style-api.test.ts` (exact `METHOD /api/hope/dna-writing-styles/...` strings, If-Match + `expectedVersion` on PATCH report / PUT settings, param escaping, key stability) | RED run |
| 2. Failing SSE-hook tests | `api/__tests__/use-dna-job-progress.test.tsx` (FakeEventSource: `dna_job:<id>` ticket mint, event folding, terminal close, 2s poll fallback after retry budget, latest-wins merge, job-id reset) | RED run |
| 3. Failing screen tests | `components/__tests__/playground-dna-style-screen.test.tsx` (NoTenant, my-style 404 empty state, proactive 403 gate panel, acting-as-doctor state, If-Match PATCH edit + 412 conflict, settings PUT If-Match + 412, reactive 403 gate on generate, generate → SSE progress → toast, set-default) | RED run |
| 4. API layer | `api/{types,keys,client,hooks,index}.ts` — paths WITHOUT `admin/` prefix; `getWithEtag` my-style; `patchWithEtag` report; PUT settings with If-Match derived from `version` (>=1) | tests 1–2 GREEN |
| 5. Components | `components/{playground-dna-style-screen,acting-gate-card,my-style-card,my-reports-card,dna-settings-card,generate-card}.tsx` — `'use client'` screen over `ScreenTemplate` + `PageHeader` + `StatusFooter`, body in `<WorkingTenantGate>` | test 3 GREEN |
| 6. Route | `app/(console)/(playground)/playground/dna-writing-style/{page,loading}.tsx` — thin server page + skeleton mirror | lint/types |
| 7. Evidence | test + lint + check-types output into this README | all green |

**Gate-detection contract** (impersonation gate = designed state): `actingAsDoctor = impersonatingUserId !== null || roles ∩ {DOCTOR, SPECIALIST, CONSULTANT} ≠ ∅` (mirrors the controller's `DNA_DOCTOR_ROLES`, TASK-331 doc-07 F1) — shows the GATE 403 panel proactively; additionally any 403 from `POST generate` / `PUT settings` trips the panel reactively with the server message. Read surfaces (my-style / mine / versions / settings GET) always render.

## Implementation Summary

Implemented TDD (RED → GREEN): the three test suites below were written first against the verified controller contracts, then the api layer + components were built to satisfy them.

### Files created

| File | Purpose |
|---|---|
| `src/features/playground-dna-style/api/types.ts` | Self-plane wire types (`DnaReport`, `DnaVersion`, `DnaSettings`, `DnaJob(Status)`, request DTOs) — declared locally, never imported from the admin feature (rule 13) |
| `src/features/playground-dna-style/api/keys.ts` | Query keys under the `playground-dna-style` namespace (`myStyle/reports/versions/settings/job`) |
| `src/features/playground-dna-style/api/client.ts` | Typed client over `@/shared/api`: `getMyStyle` (`getWithEtag`), `listMyReports`, `updateMyReport` (`patchWithEtag` + body `expectedVersion` from `versionFromEtag`), `setDefaultReport`, `listMyVersions`, `generateMyStyle`, `getDnaSettings`, `updateDnaSettings` (If-Match + `expectedVersion` only once the DOCTOR row exists, `version >= 1`), `getDnaJobStatus`, `dnaJobStreamPath` |
| `src/features/playground-dna-style/api/hooks.ts` | TanStack Query hooks + `useDnaJobProgress` (SSE primary via `useEventStream`, scope `dna_job:<jobId>`, 2s poll fallback only after the stream exhausts retries, terminal-wins merge, root invalidation on completion) |
| `src/features/playground-dna-style/api/index.ts` | Barrel |
| `src/features/playground-dna-style/components/my-dna-style-screen.tsx` | Screen: `WorkingTenantGate` → `ScreenTemplate` + `PageHeader` + `StatusFooter`; owns the gate state (proactive from `useSession` — `impersonatingUserId === null` and no `DOCTOR/SPECIALIST/CONSULTANT` role — plus reactive on any 403) and the generate → job-progress flow |
| `src/features/playground-dna-style/components/impersonation-gate-panel.tsx` | Frame-53 GATE 403 panel (designed state): warning chip, `assertActingAsDoctor` explainer, "Act as a doctor" link → `/users`; flips to a "Doctor context ACTIVE" confirmation when acting as a doctor |
| `src/features/playground-dna-style/components/my-style-card.tsx` | `GET /my-style` card: styleText/reportData, `v<currentVersionNumber>` + Default badges, DNA ON/OFF chip from settings `effective`; 404 → designed "No DNA style yet" empty state with generate CTA; inline ETag editor (Style text + Change reason) with `OccConflictAlert` (412 keeps the draft, "Reload latest" refetches) |
| `src/features/playground-dna-style/components/my-reports-card.tsx` | `GET /mine` rows (selection re-targets the DnaVersion timeline, `aria-label="Version timeline"`, newest first) + set-default action on non-default rows |
| `src/features/playground-dna-style/components/generate-pane.tsx` | Labeled "Text samples" textarea (blank-line blocks → `textSamples[]`, empty = server-side gathering), generate action, job progress strip (Progress bar + Live/Polling/Done transport badge + `aria-live` percent) |
| `src/features/playground-dna-style/components/dna-settings-card.tsx` | "Use my DNA style" Switch bound to `doctorToggle` (null = implicit opt-in), Tenant/Effective chips, locked when `tenantEnabled` false or gated; PUT carries the OCC version; 403 → gate, 412 → `OccConflictAlert` |
| `src/app/(console)/(playground)/playground/dna-writing-style/page.tsx` | Thin server page (metadata + screen) |
| `src/app/(console)/(playground)/playground/dna-writing-style/loading.tsx` | Route skeleton mirroring the 3-column frame layout |
| `src/features/playground-dna-style/api/__tests__/dna-style-api.test.ts` | 13 tests — exact `METHOD /api/hope/dna-writing-styles/...` assertions, If-Match/expectedVersion contracts (incl. first-write-without-precondition), param escaping, key stability |
| `src/features/playground-dna-style/api/__tests__/use-dna-job-progress.test.tsx` | 4 tests — ticket mint scope `dna_job:<id>`, SSE folding + terminal close, poll fallback only after retry budget, latest-wins merge, job-id reset |
| `src/features/playground-dna-style/components/__tests__/my-dna-style-screen.test.tsx` | 11 tests — NoTenant, session skeleton, full render (style + reports + timeline + DNA chip), my-style 404 empty state, proactive GATE 403 panel (+ disabled mutations, live reads), reactive 403 on generate (no toast), If-Match PATCH edit, 412 conflict notice + reload, set-default + timeline re-target, generate → SSE progress → invalidation, settings toggle PUT |

### Evidence (2026-07-06)

`npx vitest run src/features/playground-dna-style` (from `apps/admin-console`; the pnpm `test -- <path>` form does not forward the filter, see Deviations):

```
 Test Files  3 passed (3)
      Tests  28 passed (28)
   Duration  4.49s
```

`npx eslint 'src/features/playground-dna-style/**' 'src/app/(console)/(playground)/playground/dna-writing-style/**' --max-warnings 0` → exit 0, no output.

`pnpm --filter @arcaai/admin-console check-types` → all `playground-dna-style` files compile. Remaining failures are **unrelated in-flight parallel tickets** (TS2307 missing screens referenced by their tests): `playground-consultation` (TASK-432), `playground-live-transcription` (TASK-433), `playground-llm` (TASK-436).

### Deviations / notes

- Component file names differ from the plan sketch (`my-dna-style-screen` / `impersonation-gate-panel` / `generate-pane` instead of `playground-dna-style-screen` / `acting-gate-card` / `generate-card`) — same responsibilities, one file per frame region.
- `pnpm --filter @arcaai/admin-console test -- src/...` runs the whole app suite (vitest arg forwarding); evidence above uses `npx vitest run <path>` from `apps/admin-console`, which is the same runner scoped correctly.
- `PUT /settings` OCC: the controller accepts optional If-Match / `expectedVersion`; the client sends both only when the GET reported `version >= 1` (a DOCTOR-scope row exists) — the first-ever write goes without a precondition, matching the row-creation semantics.
- **Blocked shared change (documented, feature-local workaround shipped)**: the SELF controller's SSE route `GET dna-writing-styles/jobs/:jobId/stream` (`apps/api/src/modules/dna-writing-style/dna-writing-style.controller.ts`) is missing `@StreamScope({ namespace: 'dna_job', param: 'jobId' })` — its ADMIN twin got the decorator in TASK-419 item 6. Without it, `JwtAuthGuard` rejects the console's single-use `dna_job:<jobId>` tickets with 401 on this route, so at runtime the stream errors out and `useDnaJobProgress` lands on its documented 2s poll fallback (`GET dna-writing-styles/jobs/:jobId`), surfaced as the "Polling" transport badge in the progress strip. `apps/api` is outside this ticket's file-ownership boundary; once the decorator is added the stream authenticates with zero frontend changes.
- No other shared/foundation changes were required (TASK-431 route group, guard and sidebar entry already cover this route).

## Change History

| Date | Change |
|---|---|
| 2026-07-06 | Ticket created from TASK-420 (frames approved 2026-07-06). |
| 2026-07-06 | Implemented feature + route + tests (TDD); 28/28 tests green, lint clean, types clean for owned files; status → Review. |
| 2026-07-06 | Hardening pass: screen test now also asserts the If-Match header on the settings PUT; settings card aligned to the client's `(body, currentVersion)` OCC signature; documented the missing `@StreamScope` on the SELF SSE route as a blocked shared change (2s poll fallback covers it at runtime). |
