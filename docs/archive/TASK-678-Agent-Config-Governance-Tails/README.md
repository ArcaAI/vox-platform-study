# TASK-678 — Agent-Config Governance Tails

- **Status:** Completed
- **Base commit:** `62cb2d174` (`dev-2.1`, "docs(TASK-654): programme complete — status, open items, exclusion resolved")
- **Type:** bugfix / governance-gap closure

## 1. Requirement Analysis

TASK-654's programme closed with two deliberately-flagged open items (§6.4a) — two places
where the current state *implies* a guarantee that does not actually hold:

- **OP-6** — TASK-667's console renders the `harnessOverrides` "Budgets" subset
  (`maxRegen`, `gateSlaSeconds`, `gateEscalationSeconds`) **disabled** for a non-elevated
  (tenant admin) caller, with a "Global admins only" hint. The server's
  `validateHarnessOverrides`/`TENANT_TIER_HARNESS_OVERRIDE_KEYS` allow-list does **not**
  distinguish caller role for these three keys — a direct API PATCH from a tenant admin
  is accepted today. TASK-667's own README (§4.4) flagged this explicitly as "a decision
  worth flagging for review" rather than resolving it, since it was out of that ticket's
  console-only scope.
- **OP-4** — `AgentTemplateResyncService` (the nightly cron that fast-forwards pristine
  locked clones across every tenant from the SYSTEM agent golden library) does not
  propagate the seven TASK-659 loop-config fields (`role`, `subscribedKinds`,
  `writeScope`, `goal`, `guardrailProfile`, `alwaysActions`, `neverActions`). TASK-663
  left this deliberately — unattended cross-tenant propagation could manufacture exactly
  the broken state promotion's validation blocks on. That reasoning held when no console
  form existed to author these fields; TASK-667 shipped that form, so the gap is now live
  and silent.

Both are **403 privilege boundaries / silent-gap risks**, never the 404-over-403
cross-tenant posture (`05-nestjs-api.md`) — a cross-tenant id still 404s throughout this
change.

### 1.1 Constraints honored

- One-PRIMARY-per-department invariant: never weakened.
- `SYSTEM_SHARED_READ_MODELS`: never widened.
- `packages/domains/src/common/repository.ts` and `services/agentPromotion/**`: **not
  touched** (TASK-677 owns those in a parallel worktree).
- `apps/harness/**`, `packages/agentic-sdk-v2/**`: not touched.
- No Prisma migration: none needed — no schema change, only application-layer logic
  (resync propagation) and a console UI change (removing a client-side disabled state).

## 2. Current State Evaluation

- `packages/applications/src/services/departmentAgent/constants.ts` —
  `TENANT_TIER_HARNESS_OVERRIDE_KEYS` already lists `maxRegen`/`gateSlaSeconds`/
  `gateEscalationSeconds`/`toolAllowlist` as the "4 pipeline-shape knobs" a tenant admin
  may set on an agent's `harnessOverrides` (alongside the 5 assurance-sensor
  thresholds) — a TASK-546 design decision reused unmodified by TASK-550's read-side
  overlay in `harness-policy.service.ts` (`TENANT_TIER_OVERRIDE_KEY_SET`).
- On the **separate** `HarnessPolicy` resource, the SAME three keys are confirmed
  tenant-writable: `GLOBAL_ADMIN_ONLY_POLICY_KEYS` in `harness-policy.service.ts` does
  **not** include `maxRegen`/`gateSlaSeconds`/`gateEscalationSeconds`. The console's OWN
  `harness-policy` tenant tab (`TENANT_LOCKED_POLICY_KEYS`,
  `apps/admin-console/src/features/harness-policy/components/policy-fields.ts`) locks a
  **different** key set — `safetyEnabled`/`phiEnabled`/`phiFailClosed`/`safetyProvider`/
  `safetyModel` — never these three.
- `packages/applications/src/services/departmentAgent/agent-template-resync.service.ts`
  (TASK-548) implements 4 conservative rules (clone-missing / fast-forward-pristine /
  never-touch-unlocked / skip-drifted) over PromptTemplate **content** only; the seven
  TASK-659 fields are entirely absent from both the clone and fast-forward code paths.
- `packages/applications/src/services/agentPromotion/agentPromotion.service.ts`
  (TASK-663, untouched by this ticket) already validates a cross-tenant loop-config write
  against the target department's resolved context schema
  (`assertContextKindsDeclaredInTarget`) and the one-PRIMARY invariant
  (`assertPrimaryRoleAvailable`) — the pattern this ticket's resync propagation mirrors.

## 3. Decisions

### OP-6 — Budgets are tenant-writable; the console lock is removed (not the server tightened)

**Chosen: remove the console lock (Option B).**

The evidence is one-sided once compared directly: `TENANT_TIER_HARNESS_OVERRIDE_KEYS`
(TASK-546) explicitly documents these three keys as tenant-tier — "a tenant admin editing
an agent may only nudge the tenant-tier knobs (the 5 assurance-sensor thresholds + the 4
pipeline-shape knobs)" — and that allow-list is reused verbatim by TASK-550's read-side
overlay a full ticket later. The SAME three fields are tenant-writable on the sibling
`HarnessPolicy` resource. TASK-667's lock was reasoning from the wrong precedent: it
applied the `TENANT_LOCKED_POLICY_KEYS` UX pattern (correct for `HarnessPolicy`'s
`safetyEnabled`/`phiEnabled`/`phiFailClosed`/`safetyProvider`/`safetyModel`) to a
DIFFERENT key set on a DIFFERENT resource that was never in that locked set to begin
with. Its own README flagged the mismatch and punted the decision — this ticket is that
decision.

Tightening the server instead (Option A) would have meant reversing a deliberate,
twice-reused (TASK-546 write-side, TASK-550 read-side), well-documented design decision
on the strength of a UI author's momentary uncertainty — the wrong direction for the
evidence. It would also desynchronize `DepartmentAgent.harnessOverrides` from
`HarnessPolicy`, where the same three keys stay tenant-writable, producing a new
inconsistency instead of resolving one.

**Change:** `apps/admin-console/src/features/agents/components/agent-loop-config-tab.tsx`
— `BudgetsSection` no longer takes `isElevated`; the three `Input`s are never disabled and
the "Global admins only" hint is gone. `buildPatch()` always includes the merged
`harnessOverrides` patch (previously gated behind `session.isElevated`). `useSession` is
no longer imported (its only use was this gate). `agent-loop-config-fields.ts` — the
`AGENT_BUDGET_FIELDS` doc comment is corrected to explain the tenant-tier status instead
of asserting "global-admin-tier"; the now-unused `LOCKED_FIELD_HINT` export is removed
(nothing else in `features/agents/**` consumed it — `harness-policy`'s own
`LOCKED_FIELD_HINT` constant is a separate, still-correct copy for its own resource).

No `packages/applications` change was needed for OP-6: the server already behaved as the
corrected console now claims.

### OP-4 — Resync propagates loop config at its existing sync points, validated like promotion, and always observable

**Chosen: propagate with the same cross-schema + PRIMARY validation promotion uses,
tied to resync's EXISTING two proven-safe sync points (clone-on-miss, content
fast-forward) rather than on an independent timeline — and never silently.**

Weighed against the two other options named in the brief:

- *Propagate only fields that cannot reference tenant-specific state* — every one of the
  seven fields except `role` can reference tenant state (`subscribedKinds`/`writeScope`
  name context kinds; `role: PRIMARY` competes for a department-scoped slot;
  `guardrailProfile`/`alwaysActions`/`neverActions`/`goal` are tenant-agnostic strings but
  splitting the seven into "safe" vs. "needs validation" subsets is more surface area than
  just validating all seven the same way promotion already does.
- *Keep not propagating, make it visible* — satisfies "never silent" but leaves the gap
  open indefinitely with no path to close it; the ticket brief was explicit that TASK-667
  shipping the console form makes the STATUS QUO (not propagating) the thing that is now
  wrong, not merely under-signaled.

**Why tied to the existing sync points rather than an independent config-only trigger:**
a LOCKED row is API-immutable — `DepartmentAgentService.update()` calls
`assertNotTemplateLocked()` unconditionally, before any field (including the seven) is
touched. That means, unlike template CONTENT (which needs the pristine/drift machinery in
rules ii/iv specifically because an out-of-band DB edit is the only way it can diverge), a
locked row's loop config can only ever be exactly what resync itself last set it to, or
its untouched factory defaults. There is no "customized by the tenant" risk to guard
against for config the way there is for content. The one real risk is a golden config
that does not RESOLVE in the target tenant — validated below — not accidental clobbering.

Given that, introducing a second, independent staleness anchor (mirroring
`metaData.sourceTemplateVersionNumber` but for config) to detect "golden config changed
without a content change" was assessed as unwarranted complexity for a currently-inert
case: every SYSTEM golden agent has all seven fields at their defaults today, so this is
new plumbing with zero present-day payoff. The documented, deliberate limitation: **a
golden agent's loop-config-only change (no content change) will not propagate until the
next content change.** This is called out in the class doc comment and is a bounded,
honest scope choice, not a silent gap.

**Validation (mirrors `AgentPromotionService`, reimplemented locally):**
`AgentTemplateResyncService.loopConfigProblemsForTenant` — new private method — checks
(a) `role: PRIMARY` against `DepartmentAgentRepository.findPrimaryForDepartment(tenantId,
departmentId, excludeAgentId)` (the SAME repository method promotion and TASK-659's own
create/update path use — never a new invariant-check mechanism), and (b)
`subscribedKinds`/`writeScope` kind keys against the target department's resolved,
PUBLISHED/APPROVED, pinned context schema version (`ConsultationContextSchemaRepository`
+ `ConsultationContextSchemaVersionRepository`, injected as two new constructor
dependencies — both already registered in `CoreDatabaseModule`, which
`DepartmentAgentServiceModule` already imports, so no module wiring changed).
`extractDeclaredContextKeys` is a small pure function copied locally (the THIRD copy in
the codebase — `DepartmentAgentService` and `AgentPromotionService` each already keep
their own) rather than imported, deliberately, so this service and `AgentPromotionService`
(owned by TASK-677 in a parallel worktree) can evolve independently without either PR's
review needing to reason about the other's changes to a shared file.

**Never silent:** `AgentTemplateResyncSummary` gains two new counters —
`configPropagated` and `configBlocked` — surfaced directly in the existing
`POST admin/department-agents/resync` response and the nightly cron's aggregate log line
(`agent-template-resync.cron.service.ts#resyncAllTenants`). Every block is ALSO logged
per-row (`this.logger.warn(...)`) with the specific validation problem(s) named (e.g.
"role PRIMARY would conflict with the existing PRIMARY agent 'x'" or "subscribes to
undeclared kind(s): y"). A blocked row keeps its current config and is retried on every
subsequent run — never permanently stuck, never silently dropped.

**One-PRIMARY invariant, explicitly protected, not just "not weakened":** the PRIMARY
check runs BEFORE any write, using the same repository method the rest of the codebase
already trusts for this invariant, and EXCLUDES the row being fast-forwarded from its own
conflict check (verified by a dedicated test — "findPrimaryForDepartment excludes the row
being fast-forwarded itself").

## 4. Implementation Summary

### 4.1 Files changed

| File | Change |
|---|---|
| `packages/applications/src/services/departmentAgent/agent-template-resync.service.ts` | OP-4: two new constructor deps (`ConsultationContextSchemaRepository`, `ConsultationContextSchemaVersionRepository`); `AgentTemplateResyncSummary` gains `configPropagated`/`configBlocked`; `cloneGoldenIntoTenant` and `fastForwardIfPristine` now propagate the seven loop-config fields (validated, logged, counted); new private `loopConfigProblemsForTenant`/`resolveServableContextDefinition` methods; new module-level `extractDeclaredContextKeys` |
| `packages/applications/src/services/departmentAgent/agent-template-resync.cron.service.ts` | `resyncAllTenants` totals now aggregate `configPropagated`/`configBlocked` |
| `packages/applications/src/services/departmentAgent/__tests__/agent-template-resync.service.test.ts` | Fixtures (`goldenAgent`/`tenantAgent`) now default the seven fields to "nothing configured" (matching real entity defaults); all existing summary assertions updated for the two new fields; 7 new tests for OP-4 (propagate on clone, block on PRIMARY conflict at clone, block on undeclared kind at clone, propagate on fast-forward, block on PRIMARY conflict at fast-forward — content still advances, exclude-self on the PRIMARY check, config-already-matching is a no-op) |
| `apps/admin-console/src/features/agents/components/agent-loop-config-tab.tsx` | OP-6: `BudgetsSection` no longer gated by `isElevated`; `buildPatch()` always includes `harnessOverrides`; `useSession` import removed (dead after the gate's removal) |
| `apps/admin-console/src/features/agents/components/agent-loop-config-fields.ts` | OP-6: `AGENT_BUDGET_FIELDS` doc corrected (tenant-tier, not global-admin-tier); unused `LOCKED_FIELD_HINT` removed |
| `apps/admin-console/src/features/agents/components/__tests__/agent-loop-config-tab.test.tsx` | OP-6: the "locks Budgets" test now asserts the OPPOSITE (not locked, no hint) for a tenant admin; the "cannot change Budgets" test now asserts a tenant admin's PATCH DOES carry `harnessOverrides`; global-admin test kept, retitled |

### 4.2 How server and console were made to agree (OP-6)

Before: server accepted `maxRegen`/`gateSlaSeconds`/`gateEscalationSeconds` from any
caller; console disabled the inputs for a non-elevated caller. After: server behavior is
UNCHANGED (it was already correct); the console no longer disables the inputs and no
longer shows a hint implying a restriction that was never real. Both a tenant admin and a
global admin session now reach identical, un-gated behavior in the Loop config tab's
Budgets section — proven by three tests: a tenant-admin session sees the fields enabled
with no lock hint, a tenant-admin's save PATCH carries `harnessOverrides`, and a
global-admin's save PATCH carries the same shape merged into existing overrides.

### 4.3 How resync propagation became observable (OP-4)

Three independent signals, all wired through the SAME code path so they cannot drift
apart:

1. **Structured logs** — every blocked propagation logs `this.logger.warn({ message,
   tenantId, agentId/goldenAgentSlug, slug, problems })` with the exact validation
   failure(s) named.
2. **Sys-events** — the existing `ResourceCreated`/`ResourceUpdated` broadcasts on clone
   and fast-forward now carry `configPropagated`/`configBlocked` booleans in their `data`
   payload, so anything already consuming these events (audit log, webhooks) sees the
   outcome without a new event type.
3. **The API response / cron aggregate** — `AgentTemplateResyncSummary` (the direct
   response body of `POST admin/department-agents/resync`, and the nightly cron's logged
   totals) now reports `configPropagated`/`configBlocked` counts alongside the pre-existing
   `added`/`fastForwarded`/`skipped`. A global admin triggering a resync, or reading the
   cron's log line, sees at a glance whether any row's config could not be brought into
   line — a number, not a silence.

## 5. Verification Evidence

Baselines in the ticket brief (applications 8,868 / admin-console 1,436) did not match
this worktree; **measured own baseline** by stashing this ticket's changes and re-running
each suite before restoring them (git stash / stash pop, no commits created in between).
True baselines for this worktree: **applications 8,865 passed** (0 skipped-relevant
difference), **admin-console 1,418 passed**.

### `pnpm --filter @arcaai/applications build`

```
> @arcaai/applications@0.0.1 build
> rimraf dist tsconfig.tsbuildinfo && tsc
(exit 0, no output — clean build)
```

### `pnpm --filter @arcaai/applications test`

```
 Test Files  470 passed | 1 skipped (471)
      Tests  8872 passed | 4 skipped (8876)
```

Baseline (this worktree, changes stashed): 8865 passed. Delta: **+7**, matching the 7 new
OP-4 tests added (18 tests in `agent-template-resync.service.test.ts`, up from 11) — zero
regressions, zero unexpected deltas.

### `pnpm api:build` (via `npx turbo run build --filter=@arcaai/api...`)

```
 Tasks:    10 successful, 10 total
```

### `pnpm --filter @arcaai/admin-console build` (via `npx turbo run build --filter=@arcaai/admin-console...`)

```
 Tasks:    9 successful, 9 total
```

### `pnpm --filter @arcaai/admin-console test`

```
 Test Files  178 passed (178)
      Tests  1418 passed (1418)
```

Baseline (this worktree, changes stashed): 1418 passed. Delta: **0** — the Budgets test
block still holds 3 tests (one renamed/inverted, one renamed, one retitled); no tests
added or removed.

### `pnpm test:unit` (root, full workspace)

```
 Test Files  2 failed | 985 passed | 2 skipped (989)
      Tests  3 failed | 16751 passed | 10 skipped | 9 todo (16773)
```

The 3 failures are **pre-existing and unrelated** to this ticket:
- `scripts/__tests__/env-sync.test.ts` — `turbo.json#globalEnv` entry count drift
  (158 vs. 160 in the checked-in generated doc); unrelated to `departmentAgent`/
  `agent-loop-config` — no env vars were added or removed by this ticket.
- `apps/api/src/modules/consultation/__tests__/harness-internal.controller.test.ts` (×2)
  — `LiveDocumentationService` undefined in `HarnessInternalController`'s
  live-documentation start/stop handlers; unrelated to this ticket (harness-internal
  controller, TASK-662 territory — not touched here, and `apps/harness/**` is explicitly
  out of scope for this ticket).

Neither failure touches a file this ticket modified. No test files under
`services/departmentAgent/**`, `services/agentPromotion/**`, or
`features/agents/**` regressed.

### `pnpm lint`

```
 Tasks:    34 successful, 34 total
```

0 errors. `apps/applications` and `apps/api` report only pre-existing
`eslint-comments/require-description` warnings (65 in `apps/api`, matching the stated
baseline) — none introduced by this change; `apps/admin-console` and
`apps/compat-playground` run with `--max-warnings 0` and passed clean.

## 6. Change History

- Initial implementation: OP-6 console lock removed (server already correct); OP-4
  resync propagation added with promotion-style validation, tied to the existing
  clone/fast-forward sync points, made observable via two new summary counters +
  structured logs + sys-event payload fields. 18 tests in
  `agent-template-resync.service.test.ts` (7 new), 3 tests in
  `agent-loop-config-tab.test.tsx` (revised for the un-locked behavior). No Prisma
  migration. `packages/domains/src/common/repository.ts` and `services/agentPromotion/**`
  not touched (TASK-677 scope).
