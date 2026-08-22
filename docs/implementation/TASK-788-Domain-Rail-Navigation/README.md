# TASK-788 — Domain Rail Navigation

| Field | Value |
|---|---|
| **Status** | Pending |
| **Type** | refactor |
| **Branch** | TBD (branch off the current active branch — confirm with owner, do not assume `dev`) |
| **Opened** | 2026-08-22 |
| **Surface** | `apps/admin-console` |
| **Follows** | [TASK-787](../TASK-787-Sarvam-Tatva-Identity-Migration/README.md) (Phase 6, split out per OD-5) |
| **Closes** | **HOPE-16**, deferred by [TASK-765](../TASK-765-Design-System-Conformance/README.md) |
| **Reference** | Sarvam "Indus" pattern P1 — two-tier rail + scoped sidebar (`04-patterns.md`) |

---

## Requirement Analysis

Replace the single 56-route `collapsible="icon"` sidebar with Sarvam's two-tier navigation: a 56px
icon **domain rail** plus a 248px **scoped sidebar** showing only the selected domain's routes.

### The problem, stated precisely

TASK-765 deferred HOPE-16 with a reason that has since gotten worse:

> *"53 routes in one `collapsible="icon"` sidebar; collapsed, that is 53 unlabelled icons. An IA
> decision, not a conformance fix. Worth designing before the route count grows again."*

It has grown to **56**. Collapsed, the sidebar is 56 unlabelled icons in a single scrolling column —
the `NavEntry.icon` doc comment already concedes the constraint this places on the design
(*"the icon-collapsed rail shows it alone (unique per entry)"*), which is why every entry must carry
a distinct icon. That is a workaround for an IA problem, not a solution to it.

### Owner decisions

| # | Decision | Date |
|---|---|---|
| **OD-1** | Adopt the two-tier rail + scoped sidebar. | 2026-08-22 |
| **OD-2** | **Rail groups by capability DOMAIN, not audience tier.** | 2026-08-22 |
| **OD-3** | Route groups `(global)`/`(shared)`/`(tenant)` and the `NavTier` guard system **do not move**. Tier answers *who may open a screen*; domain answers *where a user looks for it*. They are orthogonal and both are kept. | 2026-08-22 |
| **OD-4** | Design/Figma gates skipped (inherited from TASK-787 OD-4). | 2026-08-22 |

### Why domain and not tier

Splitting the rail by the existing four tiers yields buckets of **21 / 8 / 21 / 6** — the two large
ones are barely better than the 55 they replace, and a rail of four entries wastes the pattern.
Sarvam's rail carries **6 products**; the shape it is built for is ~6–10 peers of ~5–10 children each.
Capability domains give exactly that.

Critically, this is **purely additive to the data model**. `NavEntry` already carries `tier` and
`required`; adding `domain` changes no guard, no route group, and no permission check.

### Acceptance criteria

- **AC-1** `NavEntry` gains a `domain` field; `tier`, `required`, `implemented` and every route
  string are unchanged.
- **AC-2** No route group moves. No `layout.tsx` tier guard is modified. No ability pair changes.
- **AC-3** A domain appears in the rail **only if the caller can see at least one of its routes** —
  computed from the existing `required` OR-logic, not hardcoded.
- **AC-4** Every rail item has an accessible name. The collapse control has an accessible name.
  (Sarvam's does not — `08-a11y.md` logs it as a 4.1.2 failure. Do not reproduce it.)
- **AC-5** The active rail item and active sidebar item each carry **two** state signals, not one.
  (Sarvam's active nav is fill-only at 1.14:1 — EX-12. Do not reproduce it.)
- **AC-6** URL remains the source of truth. The selected domain is **derived from the current route**,
  never held as independent state.
- **AC-7** Below `md` (768px) both rail and sidebar leave the layout flow and become an off-canvas
  drawer behind a named trigger.
- **AC-8** Keyboard: rail and sidebar are each a single tab stop with arrow-key traversal; focus is
  never trapped; the drawer manages focus.
- **AC-9** All gates green — `pnpm --filter @arcaai/admin-console lint typecheck test build` — plus
  an axe pass on the new shell in both themes.

---

## Current State Evaluation

Measured 2026-08-22 against `dev-2.2`, from `apps/admin-console/src/shared/navigation/nav-config.ts`
(565 lines) and `apps/admin-console/src/app/(console)/layout.tsx`.

| Aspect | State |
|---|---|
| Routes in nav | **56** entries in one flat `NAV_ENTRIES` array |
| Grouping | 4 `NAV_SECTIONS` by `NavTier` — Platform (22) / Administration (8) / Tenant (20) / Playground (6) |
| Shell | `SidebarProvider` → `AppSidebar` + `SidebarInset`; inset is `h-svh overflow-hidden` with a pinned `shrink-0` chrome group and one scroll container below. **This model is correct and stays.** |
| Collapse | shadcn `collapsible="icon"` — the 55-unlabelled-icon state |
| Gating | Per-entry `required: ReadonlyArray<readonly [string, string]>`, visible when ANY pair is granted. Tier `50-59` uses `required: []` and is gated by a nav-level role check. |
| Hidden entries | `implemented: false` entries are not rendered |

### What must not regress

The shell's inner-scroll model (`11-ux-ui-principles.md` §1) is already correct and is **not** in
scope: the inset owns the viewport height, chrome is pinned `shrink-0`, only the content region
scrolls, and `z-chrome` orders it under portaled overlays. The rail and sidebar become part of that
pinned frame — they do not introduce a second scroll container on the page.

---

## Domain Model

**9 rail domains covering 54 routes. 2 routes leave the rail entirely.**

| # | Domain | Routes | Members |
|---|---|---|---|
| 1 | **Overview** | 3 | `/dashboard` · `/monitoring` · `/releases` |
| 2 | **Tenancy** | 6 | `/tenants` · `/tenants/storage` · `/entitlements` · `/billing` · `/tenant-profile` · `/departments` |
| 3 | **AI Platform** | 10 | `/ai-models` · `/ai-task-defaults` · `/ai-services` · `/agentic-policy` · `/ai-configuration` · `/tools-mcp` · `/ai-operations/runs` · `/ai-operations/metrics` · `/ai-operations/consumption` · `/ai-operations/reconciliation` |
| 4 | **Knowledge & Agents** | 5 | `/agents` · `/prompt-templates` · `/context-schemas` · `/knowledge` · `/dna-writing-styles` |
| 5 | **Clinical** | 3 | `/consultations` · `/audio/pipelines` · `/audio/transcription-jobs` |
| 6 | **Workflow & Harness** | 7 | `/harness/policy` · `/harness/observability` · `/harness/workflows` · `/harness/pipeline-policy` · `/workflow-runs` · `/workflow-studio` · `/workflow-studio/assignments` |
| 7 | **Identity & Access** | 7 | `/users` · `/rbac/roles` · `/rbac/policies` · `/api-keys` · `/identity-providers` · `/allowed-origins` · `/security-policy` |
| 8 | **Platform Ops** | 7 | `/queues` · `/schedulers` · `/audit-logs` · `/db-studio` · `/rate-limits` · `/settings` · `/storage` |
| 9 | **Playground** | 6 | `/playground/consultation` · `/playground/live-transcription` · `/playground/voice-profiles` · `/playground/dna-writing-style` · `/playground/llm` · `/playground/workbench` |

Sizes: 3 · 6 · 10 · 5 · 3 · 7 · 7 · 7 · 6 — every domain within the 3–10 band the pattern supports.

### The two routes that leave the rail

`/developer` and `/account` are **personal**, not domain work — one is API documentation, the other
is the signed-in user's own profile. They move to the **user menu in the topbar**, which is where
Sarvam puts its equivalent chrome. This removes the two entries that fit no domain rather than
forcing an awkward ninth bucket.

### Domain assignments that warranted a call

| Route | Domain | Why |
|---|---|---|
| `/storage` (Storage browser) | Platform Ops | Tenant-scoped, but it is an operational browsing tool. `/tenants/storage` (the *configuration* surface) stays in Tenancy. The two are deliberately separated. |
| `/billing` | Tenancy | Billing is a property of a tenant relationship, not a platform-ops concern. |
| `/rate-limits` | Platform Ops | A throttling control, not an AI-service setting, despite gating AI traffic. |
| `/ai-configuration` | AI Platform | Tenant-tier (30-49) but unambiguously AI. Demonstrates domain ≠ tier — this is the point of OD-2. |
| AI Operations (4 routes) | folded into **AI Platform** | Kept as one domain at 10 rather than split config-vs-observability into 6+4. Revisit if AI Platform grows past 12. |

---

## Implementation Plan

### Sequencing against TASK-787 — must be strictly serial

**TASK-788 starts only after TASK-787 Phase 5 has merged.** TASK-787's console sweep writes broadly
across `apps/admin-console/src/**` (2,517 type call sites), and this ticket rewrites the shell and
`nav-config.ts`. Running them concurrently violates one-writer-per-file. Do not partition around it
— serialise.

### Phase A — data model (no visual change)

1. Add `NavDomain` type and a `domain` field to `NavEntry`. Add `NAV_DOMAINS` (id, label, icon,
   order) alongside the existing `NAV_SECTIONS`, which stays.
2. Assign `domain` to all 56 entries per the table above.
3. Remove `/developer` and `/account` from `NAV_ENTRIES`; add them to the user-menu config.
4. **Tests first.** Assert: every entry has a domain; every domain has ≥1 entry; no route string
   changed; no `required` pair changed; no `tier` changed. This is the regression guard that proves
   AC-2 mechanically.

Ships green with the old sidebar still rendering. Nothing visual moves.

### Phase B — rail + scoped sidebar

1. `DomainRail` — 56px, 12px radius, 8px margin, 36px items (per TASK-787's Geometry Contract).
   Each item is an icon **plus an accessible name** (AC-4).
2. `AppSidebar` renders only the selected domain's entries, grouped by `NavSection` **within** the
   domain where a domain spans tiers (AI Platform and Platform Ops both do). The tier labels remain
   useful as sub-headers — they tell a super admin which rows are cross-tenant.
3. Selected domain is **derived from `usePathname()`** (AC-6). No independent state, no
   localStorage for selection. Sidebar *collapsed* state may persist; *selection* may not.
4. Domain visibility = `entries.some(e => e.implemented && hasAnyAbility(e.required))` (AC-3).
   Playground keeps its existing nav-level role check.
5. Active states carry two signals each (AC-5): fill **plus** `font-weight: 500` **plus** a 2px
   `--foreground` left rule. This is TASK-787's J-11 resolution — EX-12's own ≥3:1 fill guardrail is
   unachievable with an achromatic palette on a white sidebar, so the fill cannot be the only signal.
6. Below `md`: both tiers leave the flow into an off-canvas drawer behind a named trigger (AC-7).

### Phase C — verification

- Axe pass, both themes, on the new shell.
- Manual keyboard pass: rail and sidebar are each one tab stop with arrow traversal; drawer focus
  management; no traps (AC-8).
- 200%-zoom / reflow check at 320px.
- Confirm no route group, tier guard or ability pair changed — the Phase A test suite proves this,
  but re-run it after the shell lands.

---

## Anti-Patterns From the Reference — do not port these

Sarvam's own investigation grades its navigation, and three findings are explicit failures. The
geometry is worth taking; these are not.

| Ref | Defect | Our requirement |
|---|---|---|
| **EX-12** | Active nav item signalled by fill alone, **1.14:1** — nearly invisible | AC-5: two signals minimum |
| **4.1.2** (`08-a11y.md`) | The sidebar collapse toggle has **no accessible name** | AC-4: named |
| **EX-11** | Inert tabs keep `tabindex="0"` and `cursor:pointer` under `pointer-events:none` — affordance without function | Any unavailable rail item is either **hidden** (AC-3) or genuinely `disabled`/`aria-disabled`, never inert-but-focusable |
| **P2** | Tab selection swaps content **without changing the URL** — the one non-addressable state in the system | AC-6: URL is the source of truth |

---

## Open Question — carry into Phase B, do not block Phase A

**What does the rail show when a domain has exactly one visible route?** Two reasonable behaviours:
navigate straight to it on rail click (skip the sidebar), or always show the sidebar for
consistency. A tenant admin with narrow abilities will hit this often. Recommend: navigate directly,
and render the sidebar with the single entry still selected — consistent frame, no dead click.
Decide during Phase B with a real permission fixture rather than in the abstract.

---

## Team Execution Practices

Same as TASK-787 §Team Execution Practices. Two additions specific to this ticket:

1. **Phase A must land and merge before Phase B starts** — they touch the same file
   (`nav-config.ts`), so they are one writer, serially, not two agents.
2. **Do not let a sweep agent near this ticket's files while TASK-787 Phase 5 is in flight.**
   The serialisation above is the whole mitigation; there is no safe partition.

---

## Implementation Summary

_Not started. Populate per phase as work lands._

---

## Change History

| Date | Change |
|---|---|
| 2026-08-22 | Ticket opened, split from TASK-787 Phase 6 per its OD-5. Owner selected the domain-rail axis (OD-2). All 55 nav routes inventoried from `nav-config.ts` and partitioned into 9 domains of 3–10 routes; `/developer` and `/account` moved out of the rail to the user menu. Four reference anti-patterns recorded as explicit non-goals. Status: Pending. |
| 2026-08-22 | **Renumbered TASK-786 → TASK-788.** `TASK-786` was already taken by a concurrent workstream (`TASK-786-Generated-Secret-Policy-Governance`, status *Completed*). Caught before any commit. Parent renumbered TASK-785 → TASK-787 in the same pass; all cross-references updated and verified clean. |
| 2026-08-22 | **Re-measured against `f8c8e1b4a`** (two commits landed mid-session: TASK-785 tiered rate-limits, TASK-786 credential policy). Nav entries **55 → 56**; pages **72 → 73**. The new `/security-policy` ("Credential policy", tier 10-19) is assigned to **Identity & Access**, taking it 6 → 7. Rail totals 54 routes across 9 domains; sizes 3·6·10·5·3·7·7·7·6, all still inside the 3–10 band. No domain boundary needed redrawing — evidence the partition is stable under growth. |
