# TASK-442 — Playground Redesign: Minimalist Impersonation Canvas + Renames

- **Status**: Superseded by **TASK-502** (2026-07-12) — product reversed the no-shell decision; playground now renders inside the console shell. Original delivery (2026-07-09) kept below for history.
- **Type**: feature (UX/UI redesign — `/playground/*`)
- **Owner**: admin-console
- **Design source**: project "ARCAAI Hope Admin console" (`https://claude.ai/design/p/6a582386-939b-47d3-8c19-cd9338b34814`) — build spec §8; artboards `4a` (canvas), `4b`–`4h` (per-page), `5i` (mobile).
- **Related**: **depends on TASK-437** (tiers; tokens). TASK-420/431–436 (playground build-out), TASK-417 (GLOBAL_ADMIN consolidation).

## Requirement Analysis

Routes `/playground/*`, tier 50–59 (role-gated GLOBAL_ADMIN or TENANT_ADMIN). A deliberately minimal, focused layout where the admin **impersonates an end-user** to test features under their own account.

- **Chrome**: slim top bar only — "Playground / {page}" · **persona control** ("ACTING AS {doctor} · {dept} ▾") · "under {admin}" · **Exit**. No admin sidebar, no dense filters.
- **Canvas**: one centered work column (max ~760px): configure → run → result. Split (input / live-output) for realtime tools; "end-user preview" framing for the consultation demo.
- **Pages + renames** (routes unchanged): Consultation demo · Live transcription · **My Voice Enrollment & Profiles** (was "Voice profiles") · My DNA Writing Style · **Agent Playground** (was "LLM playground") with feature tabs **Text generation · Guardrails · NER**. Renames apply to `nav-config.ts` labels, breadcrumbs, titles.
- **Behaviour**: end-user planes run under the caller's account (backend `@Authorize()`; visibility role-gated). Streaming via SSE/WS with connection + progress chips. Persona picker switches the impersonated end-user (drives that user's effective config/entitlements).

### Acceptance criteria (spec §8)

- [x] Persona/impersonation control present and functional on every playground page (shared top bar); "under {admin}" always shown.
- [x] Minimal chrome — no admin sidebar/filters; centered/split canvas; fluid on mobile (canvas is full-width below its cap).
- [x] Both renames applied in nav + titles; routes unchanged.
- [x] Agent Playground exposes Text generation / Guardrails / NER tabs (Guardrails/NER as documented API gaps — no user-plane gateway route yet).

## Current State Evaluation

Verified 2026-07-08:

- **Chrome**: `(console)/(playground)/layout.tsx` is a pure guard (`notFound()` unless `isElevated || TENANT_ADMIN`) returning children — every playground page renders inside the **full console chrome** (`(console)/layout.tsx`: `AppSidebar`, `SiteHeader`, banners). The opposite of "minimal".
- **Pages** (all `ScreenTemplate` + `PageHeader` + `StatusFooter`, dense multi-column grids at xl):
  - consultation: `playground-consultation/…/consultation-demo-screen.tsx` — WorkingTenantGate → `AgenticProvider` (@arcaai/vox); 3-col; STT WS + SSE summary + stream tickets.
  - live-transcription: split streaming/batch tabs; WS `/ws/stt/stream` via `use-live-stt-session`.
  - voice-profiles: 2-col enrollment + profile list; **no** WorkingTenantGate (user-owned biometrics); REST only.
  - dna-writing-style: 3-col; SSE generation; **already impersonation-aware** — `impersonation-gate-panel.tsx` mirrors the gateway's `assertActingAsDoctor` 403 and links to `/users` to "Act as a doctor".
  - llm: 3-col prompt/output/providers; BFF-proxied SSE `text/tasks/:id/stream`; **no Guardrails/NER tabs** — text generation only.
- **Impersonation**: BFF routes exist and work — `POST /api/auth/impersonate` (**GLOBAL_ADMIN-only**, proxies `POST /admin/users/:id/impersonate`, swaps bearer, session gains `impersonation` block) and `POST /api/auth/revoke-impersonation`. Started today from the Users screen dialog; global destructive-tinted `ImpersonationBanner` with Revoke.
- **Nav** (`shared/navigation/nav-config.ts` lines 126–130, tier '50-59'): labels "Consultation demo" / "Live transcription" / "Voice profiles" / "My DNA style" / "LLM playground". Breadcrumbs derive from these labels; per-page `metadata.title` differs in places (e.g. "LLM Playground").
- **Constraint (recorded)**: impersonation is GLOBAL_ADMIN-only at the BFF *and* gateway. TENANT_ADMINs can enter the playground but cannot impersonate — the persona control must degrade for them (shows self, picker hidden/disabled with reason) unless/until a tenant-scoped impersonation endpoint ships (separate API ticket if the product owner wants it; not assumed here).
- **NER/Guardrails backends**: gateway fronts NLP (8864) and Guardrail (8863); admin-console has no client for either today — Agent Playground tabs need thin clients over existing gateway endpoints (confirm exact paths in `apps/api` modules during build; if a gateway surface is missing, that tab ships disabled with an API-gap note + follow-up ticket).

## Implementation Plan

TDD; order: layout split → persona control → canvas primitives → per-page migration → renames → e2e.

### 1. Own layout for the playground (minimal chrome)

Move the route group **out of** `(console)`: `src/app/(playground)/playground/…` with its own `layout.tsx` (URLs unchanged — route groups don't affect paths):

- Server guard preserved verbatim (`isElevated || TENANT_ADMIN` → else `notFound()`).
- Renders `PlaygroundTopBar` + centered content region (own scroll container, `h-svh` inner-scroll model per rule 11 §1); **no** `AppSidebar`/`SiteHeader`. Theme toggle + user menu kept minimal in the bar's right cluster.
- "Exit" → `/dashboard`.
- Risk check: confirm nothing in `(console)/layout.tsx` besides chrome is load-bearing for these pages (providers live in root layout — verified; `BreadcrumbStore` usage drops with the breadcrumbs).
- Tests: guard behaviour (404 for plain roles), bar renders, no sidebar landmark.

### 2. Persona (impersonation) control

`src/features/playground-shared/components/persona-control.tsx` (+ `playground-shared` feature module for cross-playground pieces; features must not import each other):

- Reads session: when impersonating → "ACTING AS {name} · {dept} ▾ · under {admin}"; otherwise "ACTING AS yourself".
- Picker (GLOBAL_ADMIN): user search popover (reuse `features/users` search client) → `POST /api/auth/impersonate`; switch = revoke + impersonate; "Stop acting" → revoke. Session invalidation refetches all queries (bearer swap) — invalidate the query cache on switch.
- TENANT_ADMIN degrade: picker hidden; tooltip/label "impersonation requires global admin" (per recorded constraint).
- The global destructive `ImpersonationBanner` stays functional console-wide; inside the playground the top bar itself is the affordance (banner suppressed in the playground layout to avoid double chrome — Revoke lives in the persona menu).
- DNA page's `impersonation-gate-panel` simplifies to consume the shared control state (gate logic `assertActingAsDoctor` mirror unchanged).
- Tests first: render states (self / acting-as / under-admin always shown), switch flow calls impersonate+invalidates, tenant-admin degrade, revoke path.

### 3. Canvas primitives

`features/playground-shared/components/`:

- `PlaygroundCanvas` — centered column `max-w-[760px]`, `gap-6`, fluid < 768 (5i).
- `SplitCanvas` — two-pane input/live-output (lg+), stacking below.
- `RunBar` — primary Run/Stop + status chips (connection: connecting/live/closed; progress; duration) standardizing the SSE/WS state displays already present per page.
- Tests: layout snapshots, chip states from mocked stream states.

### 4. Page migrations (each: screen test updated first, then layout swap; logic/hooks untouched)

- **Consultation demo** → "end-user preview" framing: single centered flow (record → live transcript → summary) instead of 3-col; keep `WorkingTenantGate`, provider, WS/SSE logic.
- **Live transcription** → `SplitCanvas` (capture | transcript); batch tab keeps a simple centered form.
- **Voice profiles** → centered stack (enroll card → profile list).
- **DNA writing style** → centered flow: gate/status → current style → generate → history.
- **Agent Playground** → `Tabs variant="line"`: **Text generation** (existing prompt/output/providers condensed into the canvas; providers collapse into a settings popover per artboard 4a "Agent … ▾ / temp / max tokens"), **Guardrails** (input → safety verdict panel), **NER** (input → entity list panel) — thin clients per Current-State note; tabs ship disabled with note if a gateway surface is missing.
- Per page: `PageHeader` replaced by the slim bar title ("Playground / {page}"); `StatusFooter` dropped (footer is not part of the 4a frame) — run/connection state lives in `RunBar`.

### 5. Renames

- `nav-config.ts`: "Voice profiles" → **"My Voice Enrollment & Profiles"**; "LLM playground" → **"Agent Playground"**; reconcile the other three nav labels with page titles ("Consultation Demo", "Live Transcription", "My DNA Writing Style") so nav = breadcrumb = `metadata.title`.
- Update each `page.tsx` `metadata.title` + top-bar titles; grep for stale strings ("LLM playground", "Voice profiles") across app + e2e specs.
- Tests: nav-config label assertions; sidebar (console) shows new labels.

### 6. Verification & evidence

- [ ] `pnpm --filter @arcaai/admin-console build lint test` green (paste output)
- [ ] axe 0 violations: top bar + each migrated page
- [ ] AC evidence: persona control on all 5 pages incl. "under {admin}"; no sidebar; renames in nav/titles; Agent Playground 3 tabs — screenshots vs 4a/5i via `next-dev-loop`, both themes
- [ ] Streaming regression pass: live transcription WS, consultation SSE summary, LLM task stream still function (manual headed pass; note evidence)
- [ ] Playwright e2e: new `tests/e2e/playground.spec.ts` — guard (role 404), page shells render, renamed labels

## Implementation Summary

Delivered on branch `fix/2605-review` (per user direction). TDD throughout; all
unit suites green.

**1. Own minimal layout.** Moved the route group out of `(console)` →
`src/app/(playground)/` (URLs unchanged). New `(playground)/layout.tsx` owns
what `(console)` provided for the rest of the app — the login-redirect gate,
the client `<Providers>` (they live in the console layout, NOT the root layout
— the plan's note was corrected), and the tier guard (`isElevated ||
TENANT_ADMIN` → else `notFound()`). Renders `PlaygroundTopBar` + a single
inner-scroll canvas region (`h-svh overflow-hidden`); no `AppSidebar`/
`SiteHeader`. Deleted `(console)/(playground)/layout.tsx`.

**2. Persona control** — `features/playground-shared/components/persona-control.tsx`
(+ `playground-top-bar.tsx`). Reads the session: "Acting as «{doctor}»" when
impersonating else "Acting as yourself", always with "under {admin}". GLOBAL_ADMIN
gets a user-search popover (self-contained `getJson('admin/users', …)` over the
BFF — features never import each other, so it does NOT import `features/users`)
→ `POST /api/auth/impersonate`; "Stop acting" → `POST /api/auth/revoke-impersonation`;
both invalidate the whole query cache + `router.refresh()` (bearer swap).
TENANT_ADMIN degrades to "yourself" with the "requires global admin" reason
(impersonation is GLOBAL_ADMIN-only at BFF + gateway). Tests: 5.

**3. Canvas primitives** — `playground-canvas.tsx` (`CanvasHeader` [one h1/page],
`PlaygroundCanvas` [centered ≤760px], `SplitCanvas`) and `run-bar.tsx` (`RunBar`:
Run/Stop + connection/progress chips, colour never the only signal). Tests: 6.

**4. Page migrations** (logic/hooks untouched — layout-only swaps of
`ScreenTemplate`/`PageHeader`/`StatusFooter`/`PlaygroundBanner` → the canvas):
- Consultation → one centered end-user-preview flow (setup → capture → transcript
  → live summary → document); `WorkingTenantGate` + `AgenticProvider` + WS/SSE kept.
- Live transcription → wide centered canvas keeping the streaming/batch tabs and
  pipeline picker. (`StreamingTab` isn't structured as separable capture/transcript
  panes, so `SplitCanvas` was NOT forced — that would have refactored its streaming
  logic; a centered canvas satisfies the "centered/split canvas" AC safely.)
- Voice profiles → centered stack (enroll → profile list).
- DNA writing style → centered flow (gate/status → settings → current style →
  generate → history); `ImpersonationGatePanel` gate logic unchanged.
- **Agent Playground** (was LLM) → `Tabs variant="line"`: **Text generation**
  (existing prompt/output/providers), **Guardrails**, **NER**.

**5. Renames** — nav-config labels reconciled to page titles (nav = breadcrumb =
`metadata.title` = h1): "Voice profiles" → **"My Voice Enrollment & Profiles"**,
"LLM playground" → **"Agent Playground"**, plus Title-Case on the other three.
`metadata.title` + the top-bar label follow from these. Routes unchanged.

### API gap (RESOLVED by TASK-446)

> **Update (2026-07-08):** the gateway routes below shipped in **TASK-446** — the
> Guardrails and NER tabs now proxy the Guardrail/NLP services through user-plane
> `ai/*` routes and are no longer disabled. Original gap analysis retained below.



The Agent Playground **Guardrails** and **NER** tabs ship **disabled with an
in-tab API-gap note**: the gateway exposes **no browser/user-plane inference
route** for either — Guardrail (`POST /api/guardrail/analyze`, :8863) and NLP
token-classification (:8864) are unproxied; the only `apps/api` surface over them
is the GLOBAL_ADMIN-only read-only `admin/ai-services/*` status/config plane. The
SMR text pattern to mirror is `SmrProxyController` (`@Controller('text')`,
`@Authorize()` user-plane). Enabling the tabs is an `apps/api` change (new
`@Authorize()` proxy routes) — out of scope for this admin-console ticket, per
the Current-State fallback. Follow-up ticket to be filed.

### Known limitation

The persona control shows "Acting as «{doctor}»" but not the doctor's department
(artboard 4a shows "· {dept}") — `SafeSession`/`ImpersonationState` carry only the
target username, not department. Adding it needs a BFF session-projection change;
deferred (username conveys the impersonation clearly).

### Verification evidence

- Unit: **full admin-console suite 827 passing (108 files)**; playground + nav +
  layout subset 191 passing (23 files). New/updated tests: persona-control (5),
  canvas (6), and the 5 migrated screen suites updated for the dropped
  banner/footer regions.
- Lint: `pnpm lint` clean (`eslint src --max-warnings 0`).
- Typecheck: migrated/new files clean under `tsc --noEmit`. Pre-existing,
  UNRELATED failures remain in two untouched test files
  (`rbac/…/permission-matrix.test.tsx`, `shared/detail/…/detail-drawer.test.tsx`:
  `toHaveNoViolations` axe-matcher typing) — present on the branch before this
  ticket; `next build`'s type gate will trip on them until fixed separately.
- **e2e (2026-07-09, live `next dev` :5176 + gateway :8868, seeded DB):**
  `tests/e2e/playground.spec.ts` — **6/6 pass** (minimal chrome + persona control
  + no admin sidebar; renamed nav labels; Agent Playground Text generation /
  Guardrails / NER tabs; axe WCAG 2.2 AA light + dark). Surfaced and fixed the
  missing-`TenantSwitcher` dead-end (see Change History 2026-07-09).
- **Not exercised here (environment limit, not a code gap):** the streaming WS/SSE
  regression for consultation/live-transcription needs the STT (:8861) and SMR
  (:8862) Python services, whose first-run model downloads stall on rate-limited
  HuggingFace in this environment. Covered by the per-screen unit suites (mocked
  transports) meanwhile.

### Orphaned by this change

`src/shared/page/playground-banner.tsx` (+ its test) is now unused — the "runs
under your own account" framing moved to the top-bar persona control. Left in
place (shared/page module); remove in a follow-up if not repurposed.

## Change History

| Date | Change |
|---|---|
| 2026-07-08 | Ticket created from build spec §8 + artboards 4a/5i; current-state map of playground group; GLOBAL_ADMIN-only impersonation constraint + NER/Guardrails client gap recorded. Status: Pending (awaiting plan approval). |
| 2026-07-08 | Implemented steps 1–5 (layout split, persona control, canvas primitives, 5 page migrations, renames) on `fix/2605-review`. Guardrails/NER tabs ship as documented API gaps (no user-plane gateway route). Unit 827 pass, lint clean, migrated files typecheck clean. e2e spec written (needs running stack). Corrected plan note: `<Providers>` lives in the console layout, not root. Status: In Progress → Review (streaming regression + e2e pending on the local stack). |
| 2026-07-09 | **Ran the browser e2e against the live app + gateway — 6/6 `playground.spec.ts` pass** (minimal chrome + persona control + no admin sidebar; renamed nav labels; Agent Playground 3 tabs; axe WCAG 2.2 AA light + dark). **Bug found + fixed during e2e:** the tenant-scoped playground pages (consultation/live-transcription/dna/llm) use `WorkingTenantGate`, but the minimal top bar dropped the `TenantSwitcher` — a GLOBAL_ADMIN entering the playground fresh had no way to pick a working tenant and was dead-ended (the gate even said "pick from the switcher in the top bar"). Restored `<TenantSwitcher>` to the playground top bar for elevated users (`playground-top-bar.tsx`). Full admin-console unit suite still 833 pass; lint clean. Status: Review → **Completed**. |
| 2026-07-12 | **Superseded by TASK-502.** Manual test (impersonating `doctor2`) showed the missing sidebar was confusing during real use — product reversed the "minimalist impersonation canvas" decision: playground routes moved from the standalone `(playground)` route group back under `(console)/(tenant)/playground/*`, so they render with the full `AppSidebar` + `SiteHeader` like every other admin screen. `(playground)/layout.tsx` and `playground-top-bar.tsx` were deleted; the persona/impersonation control (`persona-control.tsx`, unchanged) now mounts via a content-level `PlaygroundPersonaBar` (self-fetching, `(console)/(tenant)/playground/layout.tsx`) instead of replacement chrome — the `TenantSwitcher` fix above is superseded by the console `SiteHeader`'s own switcher. This ticket's `Implementation Summary` above (steps 1–5, the no-shell layout) describes design that no longer exists in code; see TASK-502 for the current shell + BUG-005 content fix. Status: Completed → **Superseded**. |
