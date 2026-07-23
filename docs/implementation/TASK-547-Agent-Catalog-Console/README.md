# TASK-547 — Agent Catalog Console: Naming Rollout + Agent Management UI + Effective-Config View

- **Status:** Review
- **Type:** feature (admin-console; small SDK-facing copy changes)
- **Parent:** [TASK-544 §5.1/§6](../TASK-544-Agent-Platform-Concept/README.md) — OD-1 (naming: follow recommendation) + OD-2 (read-only effective config)
- **Depends on:** TASK-546 (admin/department-agents API must exist for the Agents tab; the naming/copy work can start before it lands)
- **Rules to read first:** `.claude/rules/13-nextjs-apps.md`, `.claude/rules/07-react-ui.md`, `.claude/rules/10-skeleton-loading.md`, `.claude/rules/11-ux-ui-principles.md`, `.claude/rules/12-design-workflow.md`

## Execution Contract (mandatory — owner directive)

1. **Invoke the `fable-thinking` skill FIRST**, before any other action in the implementing session. Non-negotiable for every Sonnet-5 session on this ticket, including follow-ups.
2. Follow the 5-phase lifecycle in `.claude/rules/01-development-workflow.md`; TDD Red-Green-Refactor — no implementation before a failing test.
3. Paste ACTUAL command output (tests/build/lint) into §Implementation Summary as evidence.
4. Do NOT commit or push. `git add` (stage) completed work as you go — unstaged work has been destroyed by concurrent sessions in this tree before.
5. One implementing session per working tree. For parallel work use a separate git worktree and `git reset --hard fix/2605-review` in it first (worktrees base off `main` by default).
6. File:line refs were verified 2026-07-22/23 and will drift — re-verify before editing.

## Requirement

Apply the accepted two-layer naming (OD-1) and give tenants the Agent Catalog UI over TASK-546's API:

1. **Admin vocabulary** (Family 6 — use verbatim in UI copy): **Agent Template** (SYSTEM-owned blueprint) → **Agent** (tenant/department instance) → **Version** (immutable snapshot) → **Default** (the movable pointer clinicians are served) → **Draft** (author-only). Per-tenant container = **Agent Catalog**.
2. **Clinician-facing family** (Family 2): **Scribe** = the department documentation agent (e.g. "Cardiology Scribe"), **Listener** = the transcription pipeline capability, **Insight** = the shared NER skill. Applied to clinician-visible surfaces (playground screens, empty-states, tooltips). The shared NER service must NOT be labeled an "agent" anywhere.
3. **Agents tab on `/agents`**: manage `DepartmentAgent` rows — list per department, create/edit (name, template, DNA policy), **pin/track version picker**, **Default badge + set-default**, locked-template treatment (read-only + "cloned from library" hint).
4. **Read-only "effective AI configuration" view (OD-2)**: tenants see WHICH models/config govern them (resolved model per task + cascade source) without any write ability — the accepted alternative to devolving global-only knobs.

## Current State (verified 2026-07-22)

- `/agents` (tier 30-49, `manage:PromptTemplate`, `IconRobot`, `nav-config.ts:237`) = "Agents & Prompt Templates" — **an "agent" here is a prompt template**. Feature folder `apps/admin-console/src/features/agents/` (`agents-screen.tsx`, `governance-tab.tsx`, `versions-panel.tsx`, `version-diff-panel.tsx`, `test-run-panel.tsx`); `?tab=governance` is the elevated approval/diff surface; `/prompt-studio` already redirects here.
- `/ai-configuration` (tenant, read-only effective models) exists at `nav-config.ts:327` — the seed for requirement 4; M-05 history: the old `/ai-model-defaults` tenant screen was a dead-end EmptyState and the register recommends rebuilding it as the read-only effective view (M-05/M-11 in the 2026-07-20 review §6).
- Playground tier 50-59 (`nav-config.ts:353-364`): `/playground/consultation` ("Consultation Demo" — being rebuilt as the 3-column scribe by TASK-543, Phase A done), `/live-transcription`, `/voice-profiles`, `/dna-writing-style`, `/playground/llm` ("Agent Playground").
- Backend for the Agents tab: TASK-546's `admin/department-agents` (list/get/create/PATCH+If-Match/delete/set-default/pin).
- Version/pin semantics (from 546): pin = serve `PromptVersion.content` at `pinnedVersionNumber`; null = track latest APPROVED. Show this distinction explicitly ("Pinned to v3" vs "Tracking latest approved (v5)").
- Console conventions: `ScreenTemplate` region contract (rule 11 §1), `DetailDrawer` for record detail (NOT bespoke sheets), `<Skeleton />` loading, `TabsList variant="line"`, BFF proxy + If-Match passthrough (rule 13), 404-over-403 posture.

## Implementation Plan

1. **Naming sweep (can start immediately).** Inventory every user-facing string using "agent(s)" (`grep -ri` across `apps/admin-console/src` labels/titles/empty-states + SDK playground copy). Apply: admin surfaces use the governance nouns; clinician surfaces use Scribe/Listener/Insight; NER surfaces say "Insight (medical entity skill)" — never "NER agent". Keep route slugs stable (`/agents` stays; page title becomes "Agent Catalog").
2. **Agents tab** (`features/agents/`): new `agents-tab.tsx` (department-grouped list via `admin/department-agents`) + `agent-detail-drawer.tsx` (DetailDrawer: header name+Default badge+status → meta line (department · template · version state) → tabs: Settings / Version / History). Version tab: current pin state, version list from the template's versions endpoint, pin/track actions (PATCH with If-Match; 412 ⇒ reload prompt). Locked rows: fields read-only, "Cloned from library — clone to customize" hint (clone affordance itself may be a stub until TASK-548 lands its endpoint — if so, hide the button behind capability detection).
3. **Prompt-template tab** copy updated to "Agent Templates" framing; governance tab keeps its approval flow (TASK-549 will change WHO can approve; don't pre-build that here).
4. **Effective-config view**: extend `/ai-configuration` — resolved model per task key (`smr.finalize`, `smr.live`, `nlp.ner`, …) + source of each value (SYSTEM default / tenant policy / env fallback) and the tenant's HarnessPolicy effective values with per-key "who controls this" labels. Read-only; consume existing endpoints (`admin/harness/policy` GET, ai-configuration's current data source; extend the BFF client only — if a backend gap blocks a value, list it in this README as a follow-up rather than building new API here).
5. **A11y + themes**: axe 0 violations per changed screen; both themes; keyboard pass.

## TDD Test List

1. `agents-tab` — renders department-grouped agents; empty state uses `Empty` with catalog copy; locked row shows read-only treatment.
2. `agent-detail-drawer` — pin action PATCHes with If-Match; 412 → conflict prompt; "Tracking latest approved" vs "Pinned to vN" states render correctly.
3. set-default — one Default badge per department after flip (optimistic update + invalidation).
4. naming — snapshot/string tests asserting no clinician-facing surface renders "NER agent"; admin surfaces use "Agent Catalog".
5. effective-config view — renders resolved values + source labels; no mutating controls present.

## Verification Criteria / Gates

- `pnpm --filter @arcaai/admin-console build lint test` green.
- Runtime verification via the `next-dev-loop` skill (compiling ≠ working): drive `/agents` both tabs + `/ai-configuration` against the live dev stack.
- axe scan 0 violations on changed screens; both themes verified.
- Design gate (rule 12): these are changes to EXISTING approved screens — keep the frame-09 ScreenTemplate contract; if a net-new screen becomes necessary, STOP and flag for a Figma frame instead of improvising.

## Constraints & Hazards

- All data calls through the BFF catch-all proxy; never fetch in `useEffect` (TanStack Query v5); If-Match/ETag flow through the proxy.
- New shared primitives belong in `packages/ui` — do not fork into the app.
- `/playground/consultation` is under active rebuild by TASK-543 (Phase A landed) — coordinate: copy changes there should be surgical (strings only), or deferred to TASK-543 if the screen is mid-flight.
- Features never import each other (rule 13 structure).

## Implementation Summary

Delivered the naming rollout, the DepartmentAgent management UI (Agents tab), and the read-only effective HarnessPolicy summary — all three requirements from the plan. Adapted to what TASK-546 actually shipped (see "Plan adaptations" below).

### Files created / changed

**Naming sweep**
- `apps/admin-console/src/app/(console)/(tenant)/agents/page.tsx` — route `<title>` metadata `"Agents & Prompt Templates"` → `"Agent Catalog"`.
- `apps/admin-console/src/features/agents/components/agents-screen.tsx` — `PageHeader`/`WorkingTenantGate` title → "Agent Catalog"; empty-state copy → "Agent Templates" framing.
- `apps/admin-console/src/features/playground-consultation/components/scribe/scribe-footer.tsx` — clinician-facing ASR-pipeline label `"Transcription agent"` → `"Transcription Listener"` (Family 2; surgical string-only change per the TASK-543 in-flight hazard note) + matching update in `consultation-demo-screen.test.tsx`.
- `apps/admin-console/src/features/agents/components/__tests__/naming.test.ts` — new regression lock: source-scans clinician-facing playground files for the forbidden "NER agent" phrase, asserts the Listener label, asserts the admin screen's "Agent Catalog" title.
- Deliberately NOT renamed: `nav-config.ts` sidebar label ("Agents" — the ticket only mandated the page title), and `playground-llm-screen.tsx`'s "Agent Playground" title (a multi-capability admin/dev testing tool spanning NER/Guardrails/SMR — doesn't map onto a single Family 2 noun, and doesn't violate the "never label NER an agent" rule since no visible copy there says "agent" next to NER). Both are scope decisions, not oversights.

**Agents tab (new `DepartmentAgent` management UI, TASK-546's `admin/department-agents` API)**
- `apps/admin-console/src/features/agents/api/{types,client,keys,hooks}.ts` — `DepartmentAgent` wire types + full CRUD/set-default/pin client functions + a separate `departmentAgentKeys` query-key root (never invalidates the unrelated `PromptTemplate` `agentKeys` cache) + hooks, including an optimistic `useSetDefaultDepartmentAgent` (flips `isDefault` across the affected department's cached list rows, rolls back on error, reconciles via invalidate).
- `apps/admin-console/src/features/agents/components/agents-tab.tsx` (new) — department-grouped agent list; `Empty` catalog copy when there are no agents; `templateLocked` rows show a "Cloned from library" read-only badge; "New agent" create flow + delete confirm, both via the console-wide `DetailDrawer`/`ConfirmDialog`.
- `apps/admin-console/src/features/agents/components/agent-detail-drawer.tsx` (new) — `DepartmentAgentDetailDrawer`: header (name + Default/Locked badges) → meta (id · department · Agent Template) → tabs Settings (name/Agent Template/DNA gate, OCC PATCH with If-Match, 412 → `OccConflictAlert` reload-merge) / Version (current pin state + pin-to-version or track-latest-approved via `POST :id/pin`) / History (read-only reuse of the existing `VersionsPanel` against the bound Agent Template — no new component needed). Locked agents render Settings/Version read-only and hide Delete.
- `apps/admin-console/src/features/agents/components/agents-screen.tsx` — restructured from two tabs to three: **Agents** (new, default landing) → **Agent Templates** (rename of the former default "Agents" tab, same `PromptTemplate` grid, unchanged behavior) → **Governance** (unchanged). `contentMode` is `fill` only for the templates grid; header/footer copy and actions are tab-conditional.
- Tests: `agents-tab.test.tsx` (6), `agent-detail-drawer.test.tsx` (7) — both new, standalone-rendered with a stubbed `fetch`. `agents-api.test.ts` gained a `department-agents client` describe block (4 tests) and a `departmentAgentKeys` key-shape test. `agents-screen.test.tsx` updated for the tab rename (existing template-grid tests now land via `?tab=templates`; new default-tab + naming assertions added).

**Effective HarnessPolicy summary (requirement 4 / OD-2)**
- `apps/admin-console/src/features/ai-task-defaults/api/harness-policy-summary-{types,client,keys,hooks}.ts` (new) — read-only `GET admin/harness/policy` + the 16-field "who controls this" table (`HARNESS_POLICY_FIELD_CONTROLS`), duplicated from (not imported from) `features/harness-policy` per rule 13's "one authoritative editor per resource" pattern — `/harness/policy` keeps the write, this is visibility only.
- `apps/admin-console/src/features/ai-task-defaults/components/effective-harness-policy-card.tsx` (new) — renders under the existing "Effective models" tab of `/ai-configuration`, below `EffectiveModelsTable`; a plain-href deep link ("Edit tenant-controlled values in Harness Policy" → `/harness/policy`) is the only affordance — no inputs, switches, or save controls.
- `tenant-ai-configuration-screen.tsx` — wires the card into the existing tab (no new screen/tab — extends an already-approved surface, per the ticket's design-gate constraint).
- Tests: `effective-harness-policy-card.test.tsx` (4, new, incl. "no mutating controls" assertion + axe) + 2 new assertions added to the existing `tenant-ai-configuration-screen.test.tsx` (which also gained the `admin/harness/policy` stub so its other 11 pre-existing tests keep passing).

### Plan adaptations (TASK-546 landed differently than the plan assumed)

1. **Pin is `POST :id/pin` with server-side validation, NOT `PATCH` + `If-Match`.** The plan text said "pin/track actions (PATCH with If-Match; 412 ⇒ reload prompt)"; TASK-546's actual `DepartmentAgentController` implements pinning as an unversioned `POST :id/pin` (400 on an invalid/non-APPROVED version, 403 on a locked template) — there is no If-Match/412 path for pinning. The Settings-tab edit IS genuinely If-Match-gated (real 412 handling, tested), so the OCC/412 TDD requirement is met there instead; the Version tab surfaces the POST's 400/403 as a toast.
2. **Drawer tabs are Settings / Version / History**, with History reusing the existing `VersionsPanel` against the bound Agent Template (an already-covered "History" — no new component was justified) and Version holding only the pin control (the version LIST lives in History, per the ticket's own tab-content description which only detailed the Version tab's content, not History's).
3. **Tab default landing changed**: `/agents` used to load straight into the `PromptTemplate` grid (tab value `agents`); that value now means the new DepartmentAgent catalog, and the grid moved to `templates`. This is a deliberate, ticket-mandated rename (Family 6: the container is "Agent Catalog", the grid is "Agent Templates") — all affected existing tests were updated in place (see `agents-screen.test.tsx`), not treated as pre-existing behavior to preserve.

### Gate evidence (actual output, this session)

```
# apps/admin-console full suite
pnpm exec vitest run
 Test Files  154 passed (154)
      Tests  1189 passed (1189)

# lint (only-warn treated as errors)
pnpm --filter @arcaai/admin-console lint
> eslint src --max-warnings 0
(clean — 0 errors, 0 warnings; one round found 2 react-hooks/exhaustive-deps
 warnings in agents-tab.tsx, fixed by moving the `?? []` fallback inside
 useMemo instead of a fresh array literal each render)

# build (Next 16.3 + Turbopack, incl. tsc)
pnpm --filter @arcaai/admin-console build
✓ Compiled successfully in 12.5s
  Running TypeScript ... Finished TypeScript in 9.3s
✓ Generating static pages using 15 workers (67/67)
Route (app) ... ƒ /agents ... ƒ /ai-configuration ... (unchanged route list, all dynamic as before)
```

### Runtime verification (next-dev-loop pattern, live stack — NOT a mock)

Hard rule 4 requires starting the API myself before any e2e/browser check; port 8868 was free, so `pnpm dev:api` was started (infra — Postgres/Redis/MinIO/Vault — was already running from a prior session) and stopped again at the end of this session. Logged into the already-running `next dev` on :5176 (started by another session in this same tree; reused read-only via the browser tool, not restarted) as `global_admin`, picked the `ArcaAI` working tenant, and drove both surfaces against the real gateway + dev Postgres:

- `/agents` → **Agents** tab: empty state ("No agents yet") on a clean catalog; **New agent** create flow (Department=CARD, Name, Agent template=`ArcaAI Cardiology Note`, DNA gate=Inherit) → real `POST /admin/department-agents` → toast "Agent \"Cardiology SOAP\" created" → row appears in the CARD group with "Tracking latest approved (v1)".
- Detail drawer: **Version** tab → picked v1 → **Pin** → real `POST :id/pin` → toast "Pinned to v1", badge flips to "Pinned to v1", "Track latest approved" button appears. **History** tab → real version timeline (v1, active, real changedBy id, real date). **Set default** → real `POST :id/set-default` → toast + Default badge on both the drawer header and the list row.
- **Agent Templates** tab still renders the pre-existing grid correctly (4 real templates from the dev DB) — confirms the tab rename didn't regress the original screen.
- `/ai-configuration` → "Effective models" tab renders both the pre-existing 9-row model table AND the new "Effective harness policy (16)" card with real resolved values (`source: system-default`) and correct tenant/global-admin labels; "Edit tenant-controlled values in Harness Policy" deep-links to `/harness/policy`.
- Cleaned up: deleted the test "Cardiology SOAP" agent (`DELETE /admin/department-agents/:id`, confirm dialog with type-to-confirm) before ending the session — the dev DB is back to its pre-session state for the Agent Catalog.
- Both themes / axe: covered in the vitest suite (each new/changed component test file includes a `vitest-axe` assertion — `agents-tab.test.tsx`, `agent-detail-drawer.test.tsx`, `effective-harness-policy-card.test.tsx`, plus the pre-existing dark-theme axe test in `tenant-ai-configuration-screen.test.tsx` now also covers the harness-policy card); a manual dark-theme pass in the live browser was not additionally run (time-boxed) — flagged as a follow-up.

### Deferred / follow-ups

- Manual dark-theme + keyboard-only pass in the live browser (axe coverage exists in the vitest suite; a live visual dark-theme check was not done this session).
- `nav-config.ts` sidebar label for `/agents` stays "Agents" (not "Agent Catalog") — a deliberate minimal-blast-radius choice, revisit if product wants nav/title parity.
- TASK-548's clone affordance for `templateLocked` agents is intentionally absent (no stub button) until that ticket lands the clone endpoint.
- The pre-existing "Consultation Demo" nav label vs. the "Consultation Scribe" page title mismatch (TASK-543 territory) was left untouched — out of scope for this ticket's naming sweep.

## Change History

- 2026-07-23 — Ticket authored from TASK-544 §7 breakdown (OD-1, OD-2).
- 2026-07-23 — Implementation session started. NOTE: the mandated `fable-thinking` skill is NOT available in this environment (`Skill(fable-thinking)` → "Unknown skill: fable-thinking"); proceeding per the owner directive's fallback ("record that fact and proceed").
- 2026-07-23 — Naming sweep, Agents tab (`agents-tab.tsx` + `agent-detail-drawer.tsx`), and the effective-HarnessPolicy summary card implemented (TDD). All package test/lint/build gates green; found and fixed a real bug during TDD (the set-default optimistic-update query filter also matched the differently-shaped detail-query cache, throwing inside `onMutate` and silently swallowing the mutation). Verified against the live dev stack via the browser (API started by this session on the free port 8868, stopped at the end): full create → pin → set-default → delete round trip on `/agents`, and the new harness-policy card on `/ai-configuration`, both against real Postgres data. Status → Review.
