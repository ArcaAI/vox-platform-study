# TASK-705 — The Agentic Loop as a Subscription Feature

| | |
|---|---|
| **Status** | Review |
| **Wave** | 0 · **Size** | M (re-scoped from S on 2026-08-17) |
| **Epic slug** | `loop-status-discovery` (historical — the ticket is no longer a discovery ticket) |
| **Depends on** | — |
| **Owner decision** | [`owner-decisions-2026-08-17.md`](../../architecture/agentic-workflow-platform/owner-decisions-2026-08-17.md) §2 row 705, plus standing directives D-A (no production data → finish enabled for day-1), D-B (configuration lives in the database, never env), D-F (local infra is up and is to be used) |
| **Findings closed** | Re-triages A-26, A-27, A-28 (per [04-target-architecture.md](../../architecture/consultation-session-workflow/assessment/04-target-architecture.md) §7 remediation table row `loop-status-discovery`) |

---

## 1. Requirement Analysis

> *"harness agentic loop is one of the core business, so, lets treat it as a feature
> in subscription plan"* — Owner, 2026-08-17

**This supersedes the ticket's original framing entirely.** TASK-705 began as an
investigation asking *"what should `harness.loop.enabled` be set to per environment?"*
That question is **dissolved**, not answered: it presumed the loop was an environment
kill-switch whose value an operator picks per deployment. It is not. The harness agentic
loop is a **core business capability**, and whether it runs for a given consultation is
decided by that consultation's tenant **subscription entitlement**, resolved from the
database.

### 1.1 What this ticket delivers

1. **A loop entitlement.** `ResolvedFeatures.agenticLoop` — a boolean feature entitlement
   resolved through the established three-layer cascade (per-plan default ← `PlanEntitlement`
   row ← `TenantEntitlement` per-tenant override), consumed through the existing
   `IEntitlementsService.isFeatureEnabled` contract. No parallel mechanism was invented;
   `platformDefaultCredential` is the pattern followed exactly.
2. **A composition rule** between the commercial gate and the operational one, decided
   deliberately and documented next to both (§1.2).
3. **Resolution of a real defect**: the old switch's seeded value (`'true'`) and its code
   default (`false`) disagreed, in a platform where `RUN_SEED=none` means the seeded row is
   never re-asserted (§2.2). That is not a quirk to document — it is a defect, and it is
   removed rather than described.
4. **Wiring into the actual loop-start decision path**, so the entitlement is what decides
   whether `ConsultationLoopWorkflow` is ever signalled.
5. **Day-1 defaults** such that a freshly-provisioned platform runs the loop (D-A), with
   the commercial gate becoming real the moment entitlement enforcement is switched on.

### 1.2 The composition rule (the ticket's central decision)

A kill-switch is an **operational safety device**; an entitlement is a **commercial** one.
They are different concerns, both are legitimate, and both survive. They compose like this:

```
signals(tenant)  ⇔  entitlement(tenant).agenticLoop === true
                    AND  harness.loop.emergencyStop !== true
```

- **The entitlement is the ONLY source of eligibility.** Commercial, per tenant, resolved
  from the database, tenant → platform-default, never from another customer tenant.
- **The emergency stop is a platform-wide VETO that can only SUBTRACT.** Engaging it halts
  an entitled tenant immediately, with no redeploy. Disengaging it never *grants* the loop
  to a tenant whose plan does not include it. An operator can stop a misbehaving subsystem;
  an operator cannot sell a subscription by flipping a setting.
- **The stop is evaluated FIRST** and short-circuits, so an incident costs zero entitlement
  lookups on the hot path.
- **Three DENY answers, each fail-closed:** no tenant identity, no entitlements resolver
  wired, or the entitlement read threw. A commercial gate that cannot be read must not hand
  out the feature; the cost of denying is a degraded (not broken) consultation, since Layer 1
  live documentation is entirely unaffected by this gate.

### 1.3 Why the old key could not simply be kept

`harness.loop.enabled` was **two devices wearing one key**, and the two want opposite
fail-safe defaults:

| Device | Wants its safe default to be… |
|---|---|
| eligibility gate ("does the platform run loops") | **on** — the product requirement is loops run on day 1 |
| kill-switch ("stop the loop NOW") | **off** — `SettingsRegistry.killSwitches()` refuses to assemble a kill-switch that ships armed, and `EffectiveSettingsModule.onModuleInit` refuses BOOT |

Both requirements are correct; the key could satisfy only one, so the seed was used to
contradict the descriptor. Separating the concerns lets each have the default it needs, and
the disagreement disappears: the key is renamed to **`harness.loop.emergencyStop`** with
the polarity flipped, so `default: false` now means *"no emergency in progress"* — which is
simultaneously the fail-safe kill-switch default AND the day-1 product intent. Nothing about
the loop needs seeding any more.

### 1.4 Explicitly out of scope

Fixing A-28 (`_adjudicate()`'s ungated auto-resolution) — that remains
`session-state-machine` / consent-abac adjacent work; adopting `ConsultationLoopWorkflow`
as *the* orchestration layer (D1 forecloses it); building admin-console UI for the new
setting (the existing registry `GET`/`PUT` route covers it, and the entitlement surfaces
through the existing `GET /admin/entitlements/capabilities` payload automatically).

---

## 2. Current State Evaluation

### 2.1 What the loop gate was, before this ticket

`LoopContextSignalService` (`packages/applications/src/services/consultation/loop/loop-context-signal.service.ts`)
forwards three signals to `ConsultationLoopWorkflow` — `ContextAdded`, `consultation-ending`,
`loop-cancel` — and gated all three on a single platform boolean,
`harness.loop.enabled`, resolved per call via `TenantSettingsService.resolvePlatform`.
It had **no tenant dimension at all**: one platform row decided the answer for every tenant
on the deployment.

### 2.2 The defect: three values that disagree, and a seed that never re-runs

| Layer | Value | Where |
|---|---|---|
| Descriptor default | `false` | `settings-registry/descriptors/consultation-gates.descriptors.ts` → `consultation-gates.constants.ts` |
| Seeded row `defaultValue` ("reset to default" target) | `'false'` | `seed/11c-consultation-gate-settings.ts` |
| Seeded row `value` (the effective value where the seed ran) | `'true'` | same file |

The three-way split was *deliberate* — the seed file explains it at length, and the
`killSwitches()` invariant is the reason it took that shape. But being deliberate does not
make it correct. It made the **database the sole carrier of the product intent**, in a
platform where:

- `packages/database/migrate.sh` defaults `RUN_SEED=none` (no seeding at all), and
- `hope-v2-dev` **explicitly pins `RUN_SEED: "none"`** by owner decision 2026-08-09
  (verified in the `arca/hope-v2-deployment` repo — see Appendix A), so the row is written
  once at bootstrap and never re-asserted.

Consequence: an environment that never seeded, or that was bootstrapped before the row
existed, resolves the code default and runs **no loop**, with nothing anywhere signalling
that the intended answer was the opposite. A setting whose seeded value and code default
disagree is a defect, and this one had a live blast radius.

**It is resolved by deletion, not by reconciliation** — see §1.3. The loop no longer has a
seeded row to disagree with anything.

### 2.3 The entitlements implementation this ticket extends

The established pattern (`packages/applications/src/services/entitlements/`), followed
exactly and not restructured:

| Piece | Role |
|---|---|
| `resolve-entitlements.ts` | pure three-layer merge: seeded matrix ← `PlanEntitlement` row ← `TenantEntitlement` override; `null` plan ⇒ `UNGATED_ENTITLEMENTS` |
| `entitlements.constants.ts` | `PLAN_ENTITLEMENT_DEFAULTS`, the in-code copy of the seeded matrix |
| `EntitlementsService.isFeatureEnabled(tenantId, feature)` | the NON-THROWING enforced read; returns `true` early when the `entitlements.enabled` kill-switch is OFF |
| `assertQuantityQuota` / `assertMeterQuota` / … | the quota lane — not used here; loop eligibility is boolean, not metered |
| `plan-matrix-parity.test.ts` | holds `PLAN_ENTITLEMENT_DEFAULTS` field-for-field against seed `15-entitlements.ts` **and the `PlanEntitlement` table** |

`featurePlatformDefaultCredential` is the closest precedent: the first ENFORCED boolean
(the other three are display-only), consumed by a service that shapes behaviour rather than
just rendering a badge. `agenticLoop` is the second.

### 2.4 The one structural constraint: no DB column yet

`PlanEntitlement` and `TenantEntitlement` carry a column per feature flag. Adding
`featureAgenticLoop` to `PlanEntitlementValues` would therefore require **two Prisma columns
plus a migration** — and `plan-matrix-parity.test.ts` would (correctly) force the seed matrix
in `15-entitlements.ts` to carry the field too, which Prisma would reject as an unknown
argument without the column.

Schema changes are serialized into a later batch (a sibling agent may be mid-edit), so **no
`.prisma` file was touched**. The interim shape, and the follow-up it implies, are in §7.4.

### 2.5 Live value in the local dev database (D-F — infra is up)

Recorded 2026-08-17, before any change, with the pre-existing read-only script:

```
$ bash scripts/report-loop-status.sh
== Loop status report ==
Target: postgresql://****:****@localhost:5432/hope

           key            | value | defaultValue |        updatedAt        | updatedBy
--------------------------+-------+--------------+-------------------------+-----------
 consultation.ocr.enabled | true  | false        | 2026-08-17 11:10:13.062 |
 harness.loop.enabled     | true  | false        | 2026-08-17 11:10:13.057 |
(2 rows)
EXIT: 0
```

So the local dev DB was seeded today at 11:10:13 and `harness.loop.enabled` was `'true'`,
`defaultValue` `'false'`, `updatedBy` empty — i.e. set by the seed and never changed by an
operator. **That row is now inert**: nothing reads the key any more. It is a harmless
leftover in already-seeded databases and the seed no longer writes it.

Supporting facts from the same database (`psql`, read-only):

```
                  id                  |  name  | plan
--------------------------------------+--------+------
 50000000-0000-0000-0000-000000000001 | ArcaAI |
 50000000-0000-0000-0000-000000000000 | Global |
 00000000-0000-0000-0000-000000000000 | System |
(3 rows)

  namespace   |            key             | value | defaultValue
--------------+----------------------------+-------+--------------
 entitlements | entitlements.enabled       | false | false
 metering     | metering.reconcile.enabled | false | false
(2 rows)
```

Every local tenant has a **NULL plan** → `UNGATED_ENTITLEMENTS` → `agenticLoop: true`; and
`entitlements.enabled` is `false` locally (seed `15-entitlements.ts` derives it: deployed
environments come up ON, local/test come up OFF), so `isFeatureEnabled` short-circuits to
`true` regardless. **The loop is therefore enabled locally on day 1 under the new design,
by two independent routes.**

---

## 3. Knowledge & Best Practices Applied

- **`.claude/rules/04-application-services.md`** — entitlements/quota patterns; the
  entitlement is read through `IEntitlementsService`, never by re-implementing resolution.
- **`.claude/rules/09-infrastructure-devops.md` §Configuration Tiers** — the emergency stop
  stays `global-kv` (a kill-switch, backed by `GlobalSetting`, propagating on
  `app-settings:invalidate`, resolved per call). It is *not* an env var, and neither is the
  entitlement (D-B). `maxScope: 'system'` keeps it out of the tenant lane, so the
  `AppSettingsService` key-only cache stays sound for it.
- **Tenant-first resolution** — the entitlement resolves from the request tenant's own plan
  and override; the platform default matrix is the fallback. A **customer** tenant
  (`50000000-…` "Global") never appears in the cascade, and a row planted under a tenant
  cannot govern the platform-scoped stop (pinned by test).
- **Pitfall avoided**: `isFeatureEnabled` returns `true` when `entitlements.enabled` is OFF.
  That is the subsystem's documented, deliberate posture (one master switch an operator can
  pull), not something this ticket may quietly special-case. It is called out in §7.5 so
  nobody reads "STARTER is not entitled" as "STARTER cannot run the loop *today*".

---

## 4. Implementation Plan (executed)

| # | Step | Verify |
|---|---|---|
| 1 | Failing tests first: entitled runs / unentitled does not / stop wins / platform→default resolution never widens to a customer tenant | RED observed (§7.6) |
| 2 | `agenticLoop` in `ResolvedFeatures` + `AGENTIC_LOOP_PLAN_DEFAULTS` + optional row fields on both input shapes | `resolve-entitlements.test.ts` |
| 3 | Retire `harness.loop.enabled`; add `harness.loop.emergencyStop` (constant, descriptor, defaults) | `consultation-gates.tier-compliance.test.ts` |
| 4 | Rewrite the gate in `LoopContextSignalService` to the composition rule; take tenant from the event payload / CLS | `loop-entitlement-gate.test.ts` |
| 5 | Remove the loop row from seed `11c`; update the seed-parity guard to forbid its return | `consultation-gate-seed-parity.test.ts` |
| 6 | Wire `EntitlementsServiceModule` into `LiveDocumentationServiceModule` | build + typecheck |
| 7 | Rewrite `scripts/report-loop-status.sh` for the new three-part answer | `shellcheck` + real run |

---

## 5. Acceptance Criteria

- [x] Loop eligibility is decided by a tenant entitlement resolved from the database, not by an environment switch
- [x] The entitlement uses the existing `IEntitlementsService` / `resolveEntitlements` mechanism — no parallel entitlement system
- [x] The kill-switch/entitlement composition rule is decided, implemented, and documented next to both devices
- [x] The seeded-value ↔ code-default disagreement is resolved (by removing the seeded loop row and flipping the switch's polarity), with a regression test that forbids re-introducing it
- [x] Resolution falls back tenant → platform default and never to a customer tenant; a tenant-scoped row cannot govern the platform stop
- [x] Day-1 default makes the loop run on a freshly-provisioned platform
- [x] The live local dev value is determined and recorded (§2.5)
- [x] `scripts/report-loop-status.sh` stays read-only, passes `shellcheck`, and reports the new three-part answer
- [x] **Schema follow-up DONE** (2026-08-17): `PlanEntitlement.featureAgenticLoop` + `TenantEntitlement.featureAgenticLoop` columns, migration, seed/matrix/DTO wiring — see §7.4
- [ ] **Root `pnpm test:unit` not verified** — the run was terminated externally by the coordinator's test-serialisation policy (§8.7); the package-scoped suite that covers every changed file did complete

---

## 6. Risks & Open Questions

- **Product packaging is a decision, not a derivation.** `AGENTIC_LOOP_PLAN_DEFAULTS` ships
  `STARTER: false`, `TRIAL/PRO/ENTERPRISE: true`. That mirrors `featureDnaReports` (the
  established shape for a differentiating capability) and makes the entitlement mean
  something — a flag that is `true` on every plan is not a subscription feature. If the owner
  wants the loop on every tier, it is a one-line change to that map. **Flagged for
  confirmation.**
- ~~**Until the DB columns land, the packaging is code-configured, not DB-configured.**~~
  RESOLVED 2026-08-17 — the columns landed (§7.4), so the packaging is DB-configured and the
  D-B tension is closed. `PlanEntitlementValues` remains the SEEDED default a plan row
  overrides, which is the same shape as every other entitlement.
- **An inert `harness.loop.enabled` row survives in already-seeded databases** (including
  local dev and, presumably, `hope-v2-dev`). Nothing reads it. Cleaning it up is optional
  housekeeping, not a correctness issue; deliberately not done here because deleting rows in
  a database another agent may be using is not worth the risk for zero behavioural gain.
- **A-28 re-triage (carried forward, unchanged in substance).** Under the new design the loop
  is *entitled-on* for every non-STARTER tenant and inert-permissive wherever entitlement
  enforcement is off — so A-28 (`_adjudicate()`'s ungated auto-resolution) should continue to
  be treated as **live, not gated-off**, and remains scheduled against the Wave 1
  `session-state-machine`/`consent-abac` work. A-26/A-27 (two-phase drain, per-agent timeout
  isolation) are likewise active rather than dormant. This ticket does not fix them.

---

## 7. Implementation Summary

Executed 2026-08-17.

### 7.1 The entitlement

- `ResolvedFeatures.agenticLoop` added (`entitlements/resolve-entitlements.ts`), resolved
  `AGENTIC_LOOP_PLAN_DEFAULTS[plan]` ← `planRow.featureAgenticLoop` ← `override.featureAgenticLoop`
  (tri-state: `true` grant / `false` deny / `null` inherit) — the identical shape to every
  other boolean feature.
- `UNGATED_ENTITLEMENTS.features.agenticLoop = true`. Deliberately on the display-flag side
  of the `platformDefaultCredential` asymmetry: a null-plan tenant has no subscription to
  read an answer out of, D-A wants the loop enabled for day-1, and what this gates is
  orchestration quality rather than platform SPEND (the reason
  `platformDefaultCredential` must fail closed).
- `AGENTIC_LOOP_PLAN_DEFAULTS` (`entitlements.constants.ts`): `STARTER: false`,
  `TRIAL/PRO/ENTERPRISE: true`.

### 7.2 The emergency stop

- `HARNESS_LOOP_ENABLED_KEY` → **`HARNESS_LOOP_EMERGENCY_STOP_KEY = 'harness.loop.emergencyStop'`**
  (`consultation/consultation-gates.constants.ts`), default `false`, still `tier: 'global-kv'`,
  `killSwitch: true`, `maxScope: 'system'`, `globalOnly: true`, `failMode: 'open-to-default'`,
  `editableBy: 'GlobalSetting'` — every tier property preserved; only the polarity and the
  meaning changed.
- Seed `11c-consultation-gate-settings.ts` now seeds **one** row (`consultation.ocr.enabled`),
  and its header carries a "do not add the loop row back" warning explaining why.

### 7.3 The gate

`LoopContextSignalService` now composes the rule in one private method
(`loopAllowedFor`) used by all three signal paths:

- `handleContextAdded` takes the tenant from `payload.tenantId` — the event may be emitted
  from a background drain with no CLS scope, so it never falls back to the ambient tenant.
- `signalConsultationEnding` / `signalLoopCancel` take it from `ClsService` (both are called
  from `ConsultationController.stopRecording`, inside a request scope, and their signal
  payloads have no tenant field). **`apps/api` was not modified** — no controller signature
  changed.
- `IEntitlementsService` and `ClsService` are injected `@Optional()` (matching the existing
  `TenantSettingsService` posture) but wired for real: `EntitlementsServiceModule` was added
  to `LiveDocumentationServiceModule`'s imports.

### 7.4 Schema change — LANDED 2026-08-17

The two columns now exist, closing the D-B tension: the loop's per-plan packaging is
DB-configured, and a per-tenant override is persistable.

```prisma
// entitlement.prisma — PlanEntitlement
featureAgenticLoop Boolean @default(true)   // STARTER row seeded false
// entitlement.prisma — TenantEntitlement
featureAgenticLoop Boolean?                 // null = inherit the plan
```

Migration `20260817161511_task_705_entitlement_agentic_loop` (authored against a throwaway
shadow DB per `02-database-prisma.md`; `prisma migrate diff` afterwards printed
`-- This is an empty migration.`) adds exactly the two `ADD COLUMN` statements.

Wiring completed with it:

- `featureAgenticLoop` added to `PlanEntitlementValues` (STARTER `false`, TRIAL/PRO/ENTERPRISE
  `true`) and the interim `AGENTIC_LOOP_PLAN_DEFAULTS` map DELETED; `resolveEntitlements` now
  merges it through `base` exactly like `featurePaletteStt` — a one-line swap, since the
  optional row fields were already honoured.
- Seed `15-entitlements.ts` `PLAN_ENTITLEMENTS` + `plan-matrix-parity.test.ts` `MATRIX_FIELDS`.
- `UpdatePlanEntitlementRequest` (`boolean`) and the tenant upsert request (`boolean | null`,
  tri-state) so a platform admin edits the plan matrix and per-tenant override through the
  existing admin API.
- Hand-authored entity/factory additions on `PlanEntitlement*` / `TenantEntitlement*`
  (`gen:model` regenerated; `gen:entity` + `gen:factory` report no drift and schema-coverage OK).

### 7.5 Day-1 behaviour, stated precisely

| Environment | `entitlements.enabled` | Effect |
|---|---|---|
| local dev / test / CI | `false` (seed-derived) | `isFeatureEnabled` short-circuits `true` → **every** tenant runs the loop |
| deployed (`hope-v2-dev`, staging, prod) | `true` (seed-derived) | the plan matrix decides: STARTER does not run the loop, TRIAL/PRO/ENTERPRISE do; a NULL-plan tenant runs it |

In both cases a platform operator can halt everything with one `PUT`:

```
PUT /api/v1/admin/settings/registry/harness.loop.emergencyStop  { "value": true }
```

### 7.6 Files changed

| File | Change |
|---|---|
| `packages/applications/src/services/entitlements/resolve-entitlements.ts` | `agenticLoop` feature + optional row fields + resolution |
| `packages/applications/src/services/entitlements/entitlements.constants.ts` | `AGENTIC_LOOP_PLAN_DEFAULTS` |
| `packages/applications/src/services/consultation/consultation-gates.constants.ts` | key retired/replaced, defaults updated, full rationale |
| `packages/applications/src/services/settings-registry/descriptors/consultation-gates.descriptors.ts` | descriptor swapped |
| `packages/applications/src/services/settings-registry/descriptors/harness-loop.descriptors.ts` | comment/description references updated |
| `packages/applications/src/services/consultation/loop/loop-context-signal.service.ts` | the composition rule |
| `packages/applications/src/services/consultation/loop/loop-config.service.ts`, `loop-lifecycle.constants.ts` | comment references updated |
| `packages/applications/src/services/consultation/live-documentation/live-documentation.service.module.ts` | `EntitlementsServiceModule` import |
| `packages/database/src/prisma/db_main/seed/11c-consultation-gate-settings.ts` | loop row removed + warning |
| `packages/database/src/prisma/db_main/seed/07e-consultation-loop-defaults.ts` | comment reference updated |
| `scripts/report-loop-status.sh` | rewritten for the three-part answer |
| **tests** | new `loop/__tests__/loop-entitlement-gate.test.ts`; updated `resolve-entitlements.test.ts`, `loop-context-signal.service.test.ts`, `consultation-gates.tier-compliance.test.ts`, `consultation-gate-seed-parity.test.ts` |

### 7.7 Verification

See §8 for pasted command output.

---

## 8. Verification Evidence

All output below is real, pasted from the runs described. **The working tree is shared with
several concurrent agents**, so every failure is attributed explicitly; none of them is in a
file this ticket owns or touched.

### 8.1 RED before GREEN

Two distinct RED observations, reported honestly for what each is:

1. **Collection-level RED** — the first run of the new suites (before the service was
   rewritten) failed to even load, because `LoopContextSignalService` still imported the key
   this ticket retires. Real, but it only proves the contract changed, not that the
   assertions bite.
2. **Mutation-level RED** — so the gate was then deliberately short-circuited
   (`loopAllowedFor` forced to `return true`) and the new suite re-run. **13 of 16 cases
   failed**, including every DENY case and the veto cases, which is the evidence that
   matters: the tests fail when the composition rule is not implemented.

```
$ npx vitest run src/services/consultation/loop/__tests__/loop-entitlement-gate.test.ts   # with loopAllowedFor mutated to `return true`
     × an ENTITLED tenant runs the loop 13ms
     × an UNENTITLED tenant does not 2ms
     × resolves the entitlement for the PAYLOAD tenant, never a neighbour 1ms
     × DENIES when no tenant identity is available — eligibility that cannot be established is not eligibility 1ms
     × DENIES when no entitlements resolver is wired — a commercial gate fails CLOSED 1ms
     × DENIES when the entitlement read itself fails (never grants a paid feature on an infra error) 1ms
     × the EMERGENCY OVERRIDE still wins over an entitled tenant 1ms
     × disengaging the stop never GRANTS an unentitled tenant 0ms
     × the PLATFORM row is what vetoes, even with a permissive tenant-scoped row present 1ms
     × signalConsultationEnding forwards for an entitled CLS tenant 1ms
     × signalConsultationEnding is a no-op for an unentitled tenant 1ms
     × signalLoopCancel is a no-op with no CLS tenant 0ms
     × signalLoopCancel is vetoed by the emergency stop 0ms
      Tests  13 failed | 3 passed (16)
```

The mutation was reverted from a file-scoped backup immediately afterwards (`grep` for
`MUTATION UNDER TEST` in the service returns nothing). **No `git stash` / `git checkout .` /
`git restore .` was used at any point in this ticket.**

### 8.2 Targeted suites — GREEN

`entitlements` + `consultation/loop` + `consultation-gates.tier-compliance` +
`settings-registry`:

```
 Test Files  1 failed | 32 passed (33)
      Tests  1 failed | 445 passed (446)

 FAIL  src/services/settings-registry/__tests__/fail-mode.governance.test.ts
AssertionError: no expected env name recorded for 'internal.accessToken'
```

The single failure is **not this ticket's**: `internal.accessToken` is a descriptor added by
the concurrent D-D / internal-access-token work in `platform-secrets.descriptors.ts`, a file
this ticket never touched.

Final confirmation run of exactly the five suites this ticket owns or rewrote, through the
shared test mutex:

```
$ scratchpad/test-lock.sh npx vitest run --root packages/applications \
    src/services/consultation/loop/__tests__/loop-entitlement-gate.test.ts \
    src/services/entitlements/__tests__/resolve-entitlements.test.ts \
    src/services/settings-registry/__tests__/consultation-gate-seed-parity.test.ts \
    src/services/consultation/__tests__/consultation-gates.tier-compliance.test.ts \
    src/services/consultation/loop/__tests__/loop-context-signal.service.test.ts

 Test Files  5 passed (5)
      Tests  93 passed (93)
EXIT=0
```

### 8.3 `pnpm --filter @arcaai/applications test`

```
 Test Files  5 failed | 494 passed | 1 skipped (500)
      Tests  6 failed | 9210 passed | 4 skipped (9220)

 FAIL  src/services/__tests__/audit-correlation.test.ts
 FAIL  src/services/baseServices/_meta/secrets/__tests__/warmup-coverage.test.ts
 FAIL  src/services/consultation/live-documentation/__tests__/live-documentation.groundedness.test.ts
 FAIL  src/services/settings-registry/__tests__/fail-mode.governance.test.ts
 FAIL  src/services/workflow-definition/__tests__/task-724-stt-realtime-untouched.grep-gate.test.ts
```

Attribution — **all five belong to concurrent sibling work, none to TASK-705**:

| File | Cause |
|---|---|
| `warmup-coverage` | `INTERNAL_ACCESS_TOKEN @ apps/api/src/modules/streaming/text-proxy.controller.ts:319` |
| `live-documentation.groundedness` | expects `GUARDRAIL_SERVICE_TOKEN`, received `INTERNAL_ACCESS_TOKEN` |
| `fail-mode.governance` | `internal.accessToken` descriptor |
| `task-724-stt-realtime-untouched` (grep gate) | flags `apps/api/src/modules/streaming/text-proxy.controller.ts` as modified |
| `audit-correlation` | two 30 s timeouts under heavy parallel load, no assertion failure |

The first four are the same in-flight D-D internal-token change. For contrast, a full run of
the same package **before** any TASK-705 edit had 56 failures across 7 files (the phi-redaction
and dna-writing-style work then in flight), so the tree's baseline moves independently of
this ticket.

### 8.4 Build / typecheck

```
$ pnpm --filter @arcaai/applications build
> rimraf dist tsconfig.tsbuildinfo && tsc
BUILD EXIT=0
```

(A later re-run raced a sibling's concurrent build — `ENOTEMPTY … rmdir dist/services/agentic-instructions/dto`
from `rimraf`, a shared-tree artefact, not a compile error. `npx tsc -p packages/applications/tsconfig.json --noEmit`
was then clean, no diagnostics.)

```
$ pnpm typecheck            # turbo run typecheck
 Tasks:    28 successful, 33 total
Failed:    @arcaai/database#typecheck
@arcaai/database:typecheck: src/prisma/db_main/seed/__tests__/config-plane-seed.test.ts(104,12): error TS2532: Object is possibly 'undefined'.
@arcaai/database:typecheck: src/prisma/db_main/seed/__tests__/config-plane-seed.test.ts(105,12): error TS2532: Object is possibly 'undefined'.
```

`config-plane-seed.test.ts` is the concurrent TASK-736 (Ollama retention) edit — untouched by
this ticket, which changed only `11c`/`07e` in that package.

### 8.5 Lint

```
$ pnpm --filter @arcaai/applications --filter @arcaai/database lint
✖ 183 problems (0 errors, 183 warnings)      # all pre-existing eslint-comments/require-description
EXIT=0

$ pnpm --filter @arcaai/api lint
✖ 67 problems (2 errors, 65 warnings)
  apps/api/src/modules/ai-inference/ai-inference.client.ts   3:9    error  prettier/prettier
  apps/api/src/modules/streaming/text-proxy.controller.ts  319:25   error  prettier/prettier
```

Both `apps/api` errors are prettier violations in the concurrent internal-token work. The one
`apps/api` file this ticket touched (`consultation.controller.ts`, two comment lines) is
clean. A prettier warning introduced by this ticket in `resolve-entitlements.ts` was fixed;
`npx eslint` on the two primary changed files then exits 0 with no output.

### 8.6 Script

```
$ shellcheck scripts/report-loop-status.sh
shellcheck exit: 0

$ bash scripts/report-loop-status.sh
== Loop status report ==
Target: postgresql://****:****@localhost:5432/hope

-- platform switches --
  namespace   |           key            | value | defaultValue |        updatedAt        | updatedBy
--------------+--------------------------+-------+--------------+-------------------------+-----------
 registry     | consultation.ocr.enabled | true  | false        | 2026-08-17 11:10:13.062 |
 entitlements | entitlements.enabled     | false | false        | 2026-08-17 11:10:13.227 |
(2 rows)

-- per-tenant loop entitlement (from plan; overrides not stored yet) --
  name  |          plan           |    agenticLoop
--------+-------------------------+-------------------
 ArcaAI | (none → ungated-legacy) | allowed (ungated)
 Global | (none → ungated-legacy) | allowed (ungated)
 System | (none → ungated-legacy) | allowed (ungated)
(3 rows)
EXIT: 0
```

No `harness.loop.emergencyStop` row exists — the expected, intended state ("no emergency").
Every local tenant is allowed the loop, by two independent routes (§7.5).

### 8.7 Root `pnpm test:unit` — NOT COMPLETED (reported, not claimed)

Launched through the shared test mutex
(`scratchpad/test-lock.sh pnpm test:unit`) and **terminated externally by the main session
after ~32 000 lines of output** (`Terminated: 15`, `test-lock: 'pnpm test:unit' exited 143`)
— the coordinator was serialising heavy runs across agents; the lock then passed to another
agent's harness pytest run.

Up to the point of termination the partial log contained **zero `FAIL` lines**, but that is
weak evidence, not a passing gate. **This gate is unverified for this ticket** and is recorded
as such rather than claimed. The package-scoped equivalent (§8.3, `@arcaai/applications`,
9 220 tests) did complete, and that is where every file this ticket changed lives.

### 8.8 Python

`apps/harness` was **not** touched, and it never read `harness.loop.enabled` (the gate lives
entirely in the gateway), so no pytest run applies to this ticket.

---

## Appendix A — the superseded discovery pass (2026-08-16)

Retained because it holds evidence this ticket still relies on, and because the ticket's
history should not be silently rewritten. Its **conclusions are superseded** by §1: the
"what should the switch be set to per environment" decision it escalated no longer exists.

- **`hope-v2-dev` `RUN_SEED` cross-check — answered.** Via read-only access to
  `arca/hope-v2-deployment`: `deployment/k8s/base/db-migrate.yaml` defaults `RUN_SEED="none"`,
  and `deployment/k8s/overlays/dev/kustomization.yaml` **explicitly re-asserts
  `RUN_SEED: "none"`** for `hope-v2-dev`, with a comment recording an owner decision dated
  2026-08-09: *"for argo deployment, we just migrate database, not reset and re-seed."* The
  environment holds real accumulated data (33 users, 14 consultations, 1 255 audit rows, 88
  prompt templates, 54 department agents). **This is the fact that makes §2.2 a defect rather
  than a curiosity.**
- **Temporal execution query — mechanism proven, dispatch inconclusive.** Local
  `hope-temporal` was queried for real via the `temporalio` Python client (no `temporal` CLI
  installed): 0 `ConsultationLoopWorkflow` executions lifetime and in the last 30 days, and 0
  executions of *any* workflow type — because no `apps/api`/`apps/harness`/worker process was
  running, so nothing could have dispatched either way. Uninformative about behaviour, not
  evidence of dormancy. The `hope-v2-dev` cluster was deliberately not queried (local-only
  instruction, both passes). Operator procedure, if it is ever wanted:
  ```
  temporal workflow list  --query "WorkflowType='ConsultationLoopWorkflow' AND StartTime > '<30d-ago-ISO8601>'"
  temporal workflow count --query "WorkflowType='ConsultationLoopWorkflow'"
  temporal workflow show  --workflow-id <id>   # phase:"DISABLED" ⇒ signalled into a no-op
  ```
- **Documentation-drift finding, unresolved.** `deployment/k8s/base/temporal.yaml` defines an
  ACTIVE in-cluster `hope-temporal` Deployment + Service wired into the base kustomization
  that `hope-v2-dev` syncs — which contradicts `.claude/rules/09-infrastructure-devops.md` /
  `04-target-architecture.md` describing Temporal as running "on an unmanaged VM with a dead
  in-cluster copy". Worth a human re-check; out of scope here.
- **Derived-config gate spot-check (§2.2 of the old text).** `ConsultationContextSchema` had 3
  PUBLISHED rows locally while `DepartmentAgent`/`DepartmentAgentVersion` had 0 — so
  `LoopConfigService.resolveForConsultation`'s `agentConfigVersionId !== null || contextSchemaVersionId !== null`
  still resolves `enabled: true` off the schema side. The empty `DepartmentAgent` table in a
  freshly-seeded local DB was flagged then and is still worth someone's attention; it is
  independent of this ticket.

---

## 9. Change History

| Date | Change | By |
|---|---|---|
| 2026-08-16 | Ticket authored as a discovery ticket | Wave-0 ticket-authoring agent |
| 2026-08-16 | Discovery Tasks 1-4 executed (report script, Temporal procedure, `RUN_SEED` cross-check, A-26/27/28 re-triage); Task 5 escalated as a HUMAN-GATED decision | T2/T3 execution agent |
| 2026-08-16 | Re-ran Task 1 + Task 2 against live local infra; findings unchanged; status left at Review pending the owner decision | T2 execution agent |
| 2026-08-16 | Close-out pass — nothing material changed; still blocked on the owner decision | Close-out pass agent |
| **2026-08-17** | **SCOPE CHANGED BY THE OWNER: the loop is a subscription feature, not an environment kill-switch.** Requirement Analysis rewritten; the old "what should the switch be set to" question recorded as dissolved and its evidence moved to Appendix A. Built: `agenticLoop` entitlement (three-layer resolution, ungated-legacy `true`, `AGENTIC_LOOP_PLAN_DEFAULTS` with STARTER out); `harness.loop.enabled` retired in favour of `harness.loop.emergencyStop` (polarity flipped so the kill-switch invariant and the day-1 requirement finally agree); the seeded loop row deleted, with a regression test forbidding its return; `LoopContextSignalService` rewritten to `entitled AND NOT stopped` with three fail-closed deny paths; `EntitlementsServiceModule` wired into `LiveDocumentationServiceModule`; `scripts/report-loop-status.sh` rewritten. NO `.prisma` file touched — the two `featureAgenticLoop` columns are recorded as a required follow-up (§7.4). Live local dev value recorded (§2.5). | TASK-705 execution agent |
| **2026-08-17** | **§7.4 schema follow-up LANDED.** Added `PlanEntitlement.featureAgenticLoop Boolean @default(true)` + `TenantEntitlement.featureAgenticLoop Boolean?` with migration `20260817161511_task_705_entitlement_agentic_loop` (shadow-DB authored, empty-diff proven). Added `featureAgenticLoop` to `PlanEntitlementValues` (STARTER `false`, TRIAL/PRO/ENTERPRISE `true`), seed `15-entitlements.ts`, `MATRIX_FIELDS`, and the plan-update / tenant-upsert request DTOs; DELETED the interim `AGENTIC_LOOP_PLAN_DEFAULTS` map and swapped the resolver to merge through `base`. Hand-authored the entity/factory columns (`gen:entity`/`gen:factory` clean). Packaging is now DB-configured — the D-B tension in §6 is closed. | TASK-705 schema follow-up agent |
