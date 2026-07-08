# TASK-442 — Playground Redesign: Minimalist Impersonation Canvas + Renames

- **Status**: Pending
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

- [ ] Persona/impersonation control present and functional on every playground page; "under {admin}" always shown.
- [ ] Minimal chrome — no admin sidebar/filters; centered/split canvas; fluid on mobile (5i).
- [ ] Both renames applied in nav + titles; routes unchanged.
- [ ] Agent Playground exposes Text generation / Guardrails / NER tabs.

## Current State Evaluation

Verified 2026-07-08:

- **Chrome**: `(console)/(playground)/layout.tsx` is a pure guard (`notFound()` unless `isElevated || TENANT_ADMIN`) returning children — every playground page renders inside the **full console chrome** (`(console)/layout.tsx`: `AppSidebar`, `SiteHeader`, banners). The opposite of "minimal".
- **Pages** (all `ScreenTemplate` + `PageHeader` + `StatusFooter`, dense multi-column grids at xl):
  - consultation: `playground-consultation/…/consultation-demo-screen.tsx` — WorkingTenantGate → `AgenticProvider` (@arcaai/vox); 3-col; STT WS + SSE summary + stream tickets.
  - live-transcription: split streaming/batch tabs; WS `/ws/stt-v2/stream` via `use-live-stt-session`.
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

_Pending._

## Change History

| Date | Change |
|---|---|
| 2026-07-08 | Ticket created from build spec §8 + artboards 4a/5i; current-state map of playground group; GLOBAL_ADMIN-only impersonation constraint + NER/Guardrails client gap recorded. Status: Pending (awaiting plan approval). |
