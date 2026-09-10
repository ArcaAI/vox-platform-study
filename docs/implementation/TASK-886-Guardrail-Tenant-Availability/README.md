# TASK-886 — Guardrail Per-Tenant Availability

| | |
|---|---|
| **Status** | Review |
| **Type** | feature |
| **Program** | TASK-870 — Configuration Governance, wave 3b lane H |
| **Branch** | `task-886-guardrail-tenant-availability` |
| **Base** | `3227be8d6` (`dev-2.2` with waves 1–3a and the residue lane) |
| **Merge target** | `dev-2.2` (orchestrator merges from the primary checkout) |

## Requirement Analysis

### The owner's decision (TASK-870 §Requirement Analysis, target-model item 5; decision #3)

> Guardrail is built-in and platform-only: ONLY the platform admin manages safety
> policies and per-tenant availability; it must check ALL requests before send and ALL
> responses after receive, for built-in AND BYO providers; no tenant admin manages any
> guardrail config.

### The assumption this lane builds on (carried from the orchestrator, NOT weakened)

**"Availability" means POLICY SELECTION — which safety policies (and which strictness)
apply to a tenant — never removing or bypassing the gate.** A tenant with no row gets
the SYSTEM default set; a platform admin may narrow or widen it per tenant.

Three consequences follow, and each is enforced in code rather than remembered:

1. **There is no "off".** An absent row, an empty selection and an all-disabled
   selection are the same statement — "no opinion" — and all three resolve to the
   SYSTEM set. Both resolvers collapse them
   (`policy-catalogue.ts::resolveAvailability`, `availability.py::from_blob`), and the
   Python loader returns `{}` for an all-disabled row so the cascade widens.
2. **The strictest set always exists in code.** An unseeded SYSTEM row, and a
   guardrail node that cannot reach the config DB, both fall back to
   `PLATFORM_DEFAULT_*`, which turns every declared check on. There is no configuration
   state in which the gate is empty.
3. **A de-selected check stays on the record.** The screener emits
   `outcome: "skipped", reason: "not_selected_for_tenant"` rather than omitting the
   check, because a check that vanishes reads as "passed" on a dashboard and makes a
   narrowed tenant indistinguishable from a broken one.

### One rule derived from the owner's words, stated so it can be relaxed

The decision says guardrail "must check ALL requests before send and ALL responses
after receive". A selection that enables only outbound checks would leave every request
ungated — a direction switched off, not a narrowing. The write lane therefore REFUSES a
non-empty selection that does not cover both directions (400,
`assertBothDirectionsCovered`). `jailbreak_detection` runs on both, so the minimal legal
narrowing is one policy; the rule constrains the surface without closing the use case it
exists for. **If the owner wants a direction to be switchable off, deleting that one
function call is the whole change.**

### Cascade

Request tenant → SYSTEM, two tiers, widening on **ABSENCE ONLY**. `50000000-…`
("Global") is a CUSTOMER tenant and never appears
(`.claude/rules/00-project-context.md` §"The two reserved tenants are NOT two config
tiers").

## Current State Evaluation

Verified at `3227be8d6`:

- `Screener` (`apps/guardrail/src/guardrail/services/screening.py`) declares exactly
  eight checks in `_DECLARED_FAIL_MODES`: `jailbreak_detection`, `prompt_safety`,
  `prompt_toxicity` (inbound), `response_safety`, `response_toxicity`,
  `response_refusal`, `jailbreak_detection` (outbound), plus `pii_leak` and
  `containment_echo`. Six of them ride ONE delegated `classify` call under the single
  `guardrail.safety` task key.
- Both screens are constructed by `dependencies.build_screener`, so a change made there
  reaches the pre-send and post-receive gate together.
- `TenantConfigResolver` already implements the two-tier cascade, a tenant-keyed TTL
  cache (`f"{task_key}::{tenant_id}"`), single-flight, a cached veto and
  `invalidate()`. It has no invalidation PUBLISHER — a gateway-side change lands within
  one TTL window (unchanged by this ticket; see Handoffs).
- `GuardrailPolicy` (`core/policy.py`) resolves ONE blob as a unit from the winning
  `AiModel._metadata.policy` row. `piiLeakMinScore` defaults to 0.5 there.
- `injectionScreeningCriteria` was declared `FAIL_CLOSED` in `_SPECS` with **no reader
  anywhere in the tree** (recorded as an open gap by TASK-777 and again by TASK-878).
- There was no gateway guardrail admin module and no guardrail table.

## Implementation Plan (executed)

Layer order per rule 01: database → domain → applications → API, then the Python
runtime, then the console.

## Implementation Summary

### 1. The model — `TenantGuardrailPolicy`

**ONE row per tenant (`tenantId @unique`), not one per `(tenantId, taskKey)`.** The
reasoning, recorded in the `.prisma` header:

1. The checks this row selects are **not task keys**. `guardrail.validate` / `.safety` /
   `.pii` / `.groundedness` are the SELECTION plane (which MODEL runs), already owned by
   `AiRoutingPolicy`; six of the eight checks ride one call under `guardrail.safety`, so
   a `(tenantId, taskKey)` unique cannot even name them.
2. `GuardrailPolicy`, the plane this sits beside, is likewise one blob resolved as a
   unit. Selecting a set is a single decision; splitting it across rows would make "is
   this tenant's set narrower than SYSTEM's?" a multi-row diff instead of one comparison.

`policies` is `{ "<checkName>": { "enabled": bool, "<threshold>": number } }`. `reason`
records why a tenant's set differs from the platform default — availability is a
platform admin acting on a customer's safety posture, so the reason belongs next to the
row a reviewer reads.

### 2. The catalogue, and its membership rule

`GUARDRAIL_POLICY_CATALOGUE` declares exactly the eight check names in
`_DECLARED_FAIL_MODES`. **A policy is selectable if, and only if, a screening check
reads the selection** — declaring one with no reader is precisely the
`injectionScreeningCriteria` defect this same ticket removed.

Only `pii_leak` carries a strictness (`minScore`, lower-is-stricter), because only it
has a reader (`Screener._pii_leak_min_score`). The classification threshold the other
six would share is a property of the safety TAXONOMY, resolved per model row, not a
per-check knob.

Pinned across three readers by one artifact —
`apps/guardrail/src/guardrail/tests/contracts/availability-catalogue.json` — the
`ResolvedAsrSpec` precedent: the TS catalogue, the Python runtime, and the SYSTEM seed
each have a test against it.

### 3. Tighten-only, enforced twice

- **Write lane (admin-facing):** `assertSelectionTightensOnly` DELEGATES to the settings
  registry's own `assertTightenOnlyFloor`, so one comparison and one refusal message
  (`SettingFloorViolation`, a 403 naming the requested value and the floor) govern every
  tighten-only key in the monorepo. Never a silent clamp.
- **Runtime (structural):** `GuardrailAvailability.tighten` composes the tenant value
  with the model row's in the STRICT direction, so a row written by raw SQL or an older
  seed still cannot loosen the gate.

The ENABLED SET is deliberately not floor-checked: narrowing which policies apply is the
surface's purpose, and only a platform admin can do it.

### 4. The admin surface — SUPER_ADMIN only

`GET catalogue` · `GET` (list) · `GET :tenantId` · `PUT :tenantId` under
`admin/guardrail/availability`, with ETag/`If-Match` OCC per rule 05.

The class-level `@CanManage('Tenant')` deliberately **understates** the gate (marked
with the standardized `// AUTH-NOTE:`): a tenant admin holds `manage:Tenant` for its own
tenant and passes the decorator, then meets `assertSuperAdmin`'s 403 — including on its
own tenant's row, which is exactly what the owner ruled out. A **403 privilege
boundary**, not the 404-over-403 cross-tenant posture: the answer is "you may not
administer guardrail", which a 404 would misdescribe as "no such tenant". Because the
gate is privilege-FIRST, the split-gate ordering rule (existence, then privilege) does
not apply — no caller gets past it, so no id-space oracle exists.

A tenant with no row answers **`version: 0`**, not 404: "no selection" is a fully
resolved state that inherits the platform set, and 404 would say the tenant has no
availability — the one thing that can never be true. `If-Match: "0"` creates the row.

No `@RequiredSvcScopes` is declared, deliberately: an undeclared scope is a
deny-by-default 403 for BOTH machine credential classes (rule 05 §API Test Standard),
which is the right posture for a surface only a human super administrator may reach.
The controller is therefore **not** added to `task-773-admin-scope-map.ts` — that
fixture is a transcription of the `admin:*` scopes commit `276f96a32` removed, not a
registry of admin controllers.

### 5. The runtime read

`tenant_config.py` gains the `guardrail.availability` **pseudo task key**, routed in
`_load_from_db` to `_load_availability`. It rides the existing machinery rather than
growing a second cache beside it: same TTL, same mandatory `task_key::tenant_id` key,
same single-flight, same `invalidate()`.

`build_screener` resolves availability and passes it to `Screener`, so **both** the
pre-send and post-receive screens honour it structurally rather than by two call sites
remembering to.

**An unresolvable availability screens EVERYTHING rather than 503.** That is deliberately
unlike `_resolve_selection`, which raises: an unresolved model SELECTION means there is
nothing to run at all, whereas an unresolved AVAILABILITY has a strictest answer
available in code. More screening is the safe direction; 503-ing a request whose gate
could have run is worse than both. The fallback is logged
(`guardrail.availability.unavailable`) so "every check ran" stays distinguishable from
"we could not read which checks to run".

`X-Tenant-Id` remains mandatory — unchanged; the availability read goes through the same
`resolve()` that already treats a blank tenant as SYSTEM-only and recognises the
declared `tenantless:` marker.

### 6. Metering / attribution

`GuardrailDecision` gains `availability_source_tenant_id`, surfaced on both screen routes
as `availability_source_tenant_id` / `availabilitySourceTenantId`. It is **distinct from**
`policy_source_tenant_id`: the policy blob rides the selected model's registry row while
the availability set is its own row, so the two cascades can legitimately answer from
different tiers, and a verdict needs both to be reconstructible.

### 7. `injectionScreeningCriteria` — it goes

"Gets its reader or goes." There is no lane that consumes injection criteria text:
`injection_defense.py` is deterministic, and `jailbreak_detection` classifies through the
model taxonomy. It is REMOVED from `_SPECS`. A fail-closed key **without a reader** is
unreviewed policy advertising a control an admin cannot move; a fail-closed key without a
seeded VALUE is at least an honest, visible 503. The seed assertion that it is never
seeded is kept (with its rationale rewritten) so a re-introduction must come with its
reader.

### 8. The console

`features/security-policy` becomes two platform-security surfaces under one h1
("Security policy"): the existing **Credential policy** tab and a new **Guardrail
availability** tab. The tab is controlled rather than `defaultValue` because the pinned
header's actions belong to the credential form alone — a "Save policy" button pinned
above the guardrail panel would act on a form the reader cannot see.

`WorkingTenantGate` wraps the guardrail panel per rule 13's sub-pattern: the TIER answers
who may open the screen (SUPER_ADMIN, tier 10–19), the gate answers whose rows the panel
reads.

The draft seeds from the **EFFECTIVE** set, not the tenant's own — a tenant with no row
must not render as "nothing is screened". Both gateway refusals are mirrored as a
**disabled Save with a programmatically associated reason** (rule 11 §5): a loosening
threshold, and a selection that would leave a direction ungated. The gateway stays
authoritative and re-checks both.

## Intended migration SQL (the orchestrator authors it on a shadow DB)

Rule 02: **no folder was created under `packages/database/src/prisma/db_main/migrations/`**
— Prisma applies every subdirectory that contains a `migration.sql` regardless of name, so
a prepared-but-unapplied folder reaches every environment.

```sql
-- AlterEnum
ALTER TYPE "core"."ResourceType" ADD VALUE 'TenantGuardrailPolicy';

-- CreateTable
CREATE TABLE "core"."TenantGuardrailPolicy" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "policies" JSONB NOT NULL,
    "reason" TEXT,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantGuardrailPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TenantGuardrailPolicy_tenantId_key" ON "core"."TenantGuardrailPolicy"("tenantId");

-- CreateIndex
CREATE INDEX "TenantGuardrailPolicy_tenantId_idx" ON "core"."TenantGuardrailPolicy"("tenantId");
```

Suggested folder name: `<timestamp>_task_886_tenant_guardrail_policy`. The `ADD VALUE`
must precede the `CREATE TABLE` (the `WorkflowAssignment` precedent). `id` has no DB
default: Prisma 7's `uuid(7)` is generated client-side.

## Per-deliverable evidence

| Deliverable | Route / behaviour → file:line | Test that proves it | Rule it enforces |
|---|---|---|---|
| The model | `packages/database/src/prisma/db_main/guardrail-availability.prisma:63` | `gen:entity:check` schema coverage OK | 02 §Standard Model Field Template |
| Domain trio hand-authored | `packages/domains/src/{entities,factories,mappers,repositories}/generated/core/TenantGuardrailPolicy*.ts` | `gen:entity:check` / `gen:factory:check` no drift | 03 §Generated Code Discipline |
| Mapper strips `_version` | `.../mappers/generated/core/TenantGuardrailPolicyEntityMapper.ts:13` | `pnpm --filter @arcaai/domains test` (1892) | 03 §NEVER |
| `ResourceType` in BOTH enums | `audit.prisma:229`, `enums/generated/ResourceType.ts:214` | `resourceType.enum-parity.test.ts` 10 passed | 03 §Checklist step 4 |
| Repository registered | `core.database.module.ts:221` | domains build | 03 §Checklist step 5 |
| Tenant-scope allow-list 87 → 88 | `extensions/tenant-scope.ts:178` | `tenant-scope.test.ts` count pin | 02 §Client Access Tiers |
| Seeded SYSTEM row | `seed/18-guardrail-availability.ts:53` | `task-886-guardrail-availability-seed.test.ts` 5 passed | 02 §Seeds |
| Cascade: absence → SYSTEM | `policy-catalogue.ts::resolveAvailability` | `policy-catalogue.test.ts` "serves the SYSTEM set to a tenant with no row" | 00 §Tenant-first resolution |
| Presence → tenant set | same | "serves the tenant set when the tenant selected something" | 00 §Tenant-first resolution |
| Empty selection still gated | same + `availability.py::from_blob` | TS "an EMPTY selection is not an off switch"; PY `test_empty_selection_is_not_an_off_switch`, `test_the_gate_still_runs_when_nothing_is_selected_for_a_direction` | owner decision #3 |
| Cold DB still screens | `resolveAvailability` fallback / `PLATFORM_DEFAULT_AVAILABILITY` | TS "falls back to the built-in platform default when even SYSTEM has no set" | owner decision #3 |
| Tighten-only refusal (403) | `policy-catalogue.ts::assertSelectionTightensOnly` → `assertTightenOnlyFloor` | "REFUSES a looser threshold with a 403 naming both values"; service "REFUSES a loosening threshold with 403" | 09 §Configuration Tiers (`floorDirection`) |
| Tighten-only, structurally | `availability.py::tighten` | `test_tighten_never_loosens_even_if_the_row_says_so` | 09 §Configuration Tiers |
| Both directions stay gated | `policy-catalogue.ts::assertBothDirectionsCovered` | 5 catalogue cases + service "refuses a selection that would leave a direction ungated (400)" | owner decision #3 (verbatim) |
| SUPER_ADMIN-only, 403 on own tenant | `guardrail-availability.service.ts::assertSuperAdmin` | service "refuses a tenant admin reading/writing its OWN tenant row" ×3 | 05 §Imperative Privilege Checks |
| `GET /admin/guardrail/availability/:tenantId` | `guardrail-availability.controller.ts` `getForTenant` | controller test "delegates every route to the service" | 05 §Controllers |
| `PUT …/:tenantId` OCC | controller `putForTenant` + `@RequiresIfMatch` | "lets the If-Match header WIN over a body expectedVersion"; service "refuses to create without If-Match 0" / "CASes an existing row" | 05 §Optimistic Concurrency |
| `GET /admin/guardrail/availability` (list) | controller `list` | controller test | 05 §Controllers |
| Route documentation | controller `@ApiTags('admin-guardrail-availability')` + summaries + 4xx | `tags.test.ts` (closed tag set) | 05 §Documentation Surface |
| Admin plane JWT-only | `@ForbidApiKey()` + `admin-scope-audit.ts:167` | `admin-scope-audit.test.ts` count 62 → 63; controller test "is API-key FORBIDDEN" | 05 policy A2 |
| Runtime read, tenant-keyed cache | `tenant_config.py::_load_availability`, `TASK_KEY_GUARDRAIL_AVAILABILITY` | `test_the_availability_cache_key_is_tenant_keyed` | 06 §Per-tenant config (cache key MUST stay `task_key::tenant_id`) |
| Only selected policies run | `screening.py::_classify` | `test_inbound_runs_only_the_selected_checks` | owner decision #3 |
| De-selected check stays visible | `screening.py::_not_selected` | same test (asserts `skipped` / `not_selected_for_tenant`) | 06 (a gate that silently stops working) |
| BOTH screens honour it | `dependencies.py::build_screener` | `test_both_screen_routes_report_the_availability_tier` | owner decision #3 |
| Attribution on the decision | `screening.py::GuardrailDecision.availability_source_tenant_id`; `screen.py::ScreenResponse` | `test_the_decision_names_the_tier_that_supplied_the_selection` + the route test | 00 §Tenant identity is mandatory |
| Unresolvable ⇒ strictest, not 503 | `dependencies.py::_resolve_availability` | `test_unresolvable_availability_screens_EVERYTHING_rather_than_503` | 09 §`failMode` (declared, not decided at the call site) |
| `injectionScreeningCriteria` removed | `core/policy.py:58` | `test_injection_screening_criteria_is_gone` | 09 §No hardcoded configuration (inverse: no unread knob) |
| Console tab, tighten-only surfaced | `guardrail-availability-tab.tsx::refusalReason` | "surfaces the tighten-only rule as a disabled Save with a visible reason" | 11 §5 |
| Console working-tenant gate | `security-policy-screen.tsx` `<WorkingTenantGate>` | screen test (tabs present) | 13 §Routing sub-pattern |
| Console a11y | tab component | "has no axe violations" | 11 §11 |

## Gate output

```
pnpm guardrail:test                              483 passed in 10.35s        (baseline 458 + 25)
pnpm guardrail:lint                              All checks passed!
pnpm guardrail:typecheck                         Success: no issues found in 45 source files

pnpm --filter @arcaai/database test               Test Files  2 failed | 77 passed (79)
                                                  Tests  8 failed | 1731 passed (1739)
                                                  — exactly the 8 pre-existing failures in
                                                    ai-model-registry-seed.test.ts (4) and
                                                    task-863-agents.test.ts (4)
pnpm gen:model:check                              check: no drift — 182 generated file(s) match
pnpm gen:entity:check                             check: no drift — 103 …; Schema coverage OK: 101
                                                  entity artifact(s) cover every persisted column
                                                  of 105 Prisma model(s)
pnpm gen:factory:check                            check: no drift — 103 …; Schema coverage OK: 101
resourceType.enum-parity.test.ts                  Test Files 1 passed; Tests 10 passed

pnpm --filter @arcaai/domains build               tsc (clean)
pnpm --filter @arcaai/domains test                Test Files 156 passed | 2 skipped (158)
                                                  Tests 1892 passed | 2 skipped | 9 todo (1903)

pnpm --filter @arcaai/applications build          rimraf dist && tsc (clean)
pnpm --filter @arcaai/applications test           Test Files 657 passed | 1 skipped (658)
                                                  Tests 11581 passed | 4 skipped (11585)
pnpm --filter @arcaai/applications lint           228 problems (0 errors, 228 warnings)

pnpm --filter @arcaai/api typecheck               tsc --noEmit (clean)
pnpm --filter @arcaai/api test                    Test Files 278 passed | 2 skipped (280)
                                                  Tests 4177 passed | 4 skipped (4181)
pnpm --filter @arcaai/api lint                    70 problems (5 errors, 65 warnings)
                                                  — all 5 errors are the pre-existing
                                                    tests/e2e/*.spec.ts prettier/unused-var errors
                                                    (auth-throttle-per-endpoint ×3, harness-gate ×1,
                                                    shared-component-contracts ×1); none in src/

pnpm --filter @arcaai/admin-console build         compiled successfully
pnpm --filter @arcaai/admin-console lint          eslint src --max-warnings 0 (clean)
pnpm --filter @arcaai/admin-console test          Test Files 257 passed (257); Tests 2271 passed
```

### Reconciled counts

| Pin | Before | After | Why |
|---|---|---|---|
| `TENANT_SCOPED_MODELS.size` | 87 | 88 | `TenantGuardrailPolicy` |
| `ADMIN_SCOPED_CONTROLLERS.length` | 62 | 63 | `GuardrailAvailabilityController` |
| guardrail pytest | 458 | 483 | +25 in `test_task886_availability.py` |
| applications tests | 11542 | 11581 | +39 (catalogue 25, service 14) |
| api tests | 4172 | 4177 | +5 controller cases |
| admin-console tests | 2265 | 2271 | +6 (tab 6; screen test +2 assertions in an existing case) |
| domains tests | 1892 | 1892 | no new domain cases (drift + coverage checks cover the trio) |
| database tests | 1734 | 1739 | +5 seed cases |
| gen:entity / gen:factory artifacts | 102 | 103 | the new entity/factory |
| gen:model artifacts | 181 | 182 | the new model |
| Prisma models covered | 104 | 105 | `TenantGuardrailPolicy` |

## Handoffs

| # | Owner | What |
|---|---|---|
| H1 | **orchestrator** | Author the migration above on a shadow database (rule 02 recipe) and sync the dev DB. No folder was created under `migrations/`. |
| H2 | **orchestrator** | Regenerate the five API artifacts after merge — `api:route-manifest`, `api:openapi`, `api:portal`, `gen:admin` — for the four new `admin/guardrail/availability` routes. `gen:admin` will add a `hope.admin.*` area; the routes declare no `svcScopes`, so confirm the generator's handling of a scope-less admin area before assuming a new namespace appears. |
| H3 | **orchestrator** | Run the e2e route-authz matrix (`task-776-route-authz-matrix.spec.ts`) once the manifest is regenerated: the four routes are `apiKeyForbidden: true` with `requiredPermissions: [{manage, Tenant}]` and no machine scopes. |
| H4 | **owner** | `nav-config.ts:262` still labels `/security-policy` "Credential policy" while the screen's h1 is now "Security policy" with two tabs. One-line label change; NOT made here because `shared/navigation/nav-config.ts` is outside this lane's ownership column and wave-3b lanes F/G may touch the same file. |
| H5 | **owner** | **`medical_validation` and `groundedness` are NOT in the catalogue.** They are separately-invoked routes (`POST /api/medical/validate`, the groundedness route), not the request/response gate, so "not selected" there would have to mean "this route refuses" — a caller-visible contract change for `apps/text`. Adding a catalogue entry with no reader would repeat the `injectionScreeningCriteria` defect this ticket removed. Deciding whether those two become selectable, and what a de-selected one answers, is an owner decision. |
| H6 | ~~**owner**~~ **CLOSED 2026-09-10** | The both-directions rule (§Requirement Analysis) was DERIVED from the decision's wording, not stated by the owner. **The owner CONFIRMED it on 2026-09-10** (TASK-941 R2 / OD-2): a tenant may not switch a screening direction off, and that is a deliberate limit on what availability expresses rather than an inference awaiting review. `assertBothDirectionsCovered` stays; the confirmation is recorded on the function's own docblock so a future reader meets it where the rule is enforced, not only in a ticket. Reversing it is still the one-line change this row always described. |
| H7 | **`apps/text` lane** | **No seam was needed.** `apps/text` calls guardrail's screen routes and guardrail reads availability itself through its sanctioned SQL exception, so availability never has to travel on the request. Should that exception ever be retired in favour of gateway injection, the resolved set becomes a field the gateway injects — the same shape as `ResolvedAsrSpec`. |
| H8 | **future** | Cache INVALIDATION is unchanged: a gateway-side write lands within one TTL window (`GUARDRAIL_V2_DB_CONFIG_CACHE_TTL_S`, ~60 s). The resolver's `invalidate()` accepts a `task_key`, so a publisher on `admin/guardrail/availability` writes would close it; a subscriber without a publisher would be dead code, so none was added (the reasoning already recorded in `tenant_config.py`'s module docstring). |

### Disclosed, outside the strict ownership column

- `pnpm db:generate` and `pnpm gen:model` / `gen:entity` / `gen:factory` were run in this
  worktree. Both are pure codegen — no database was contacted (the lane-C wave-1
  precedent). `gen:mapper` and `gen:repository` were NOT run.
- `packages/database/src/prisma/db_main/seed/ai-models/llm.ts` — a comment-only edit
  (7 lines) that described `injectionScreeningCriteria` as "declared in `core/policy.py`
  but unused"; that sentence became false when the declaration was removed.
- `packages/database/src/prisma/db_main/seed/__tests__/task-777-guardrail-policy-seed.test.ts`
  — the same key's test title and rationale.
- `apps/api/src/openapi/tags.ts` — one new tag (declared in the ownership column).
- `apps/admin-console/.../security-policy/components/__tests__/security-policy-screen.test.tsx`
  — the h1 assertion, now "Security policy" plus the two tab roles.

## Change History

| Date | Change |
|---|---|
| 2026-09-06 | Initial implementation. `TenantGuardrailPolicy` + hand-authored domain trio + SYSTEM seed; `GuardrailAvailabilityService` with the catalogue, the two-tier cascade, the delegated tighten-only floor and the both-directions rule; `admin/guardrail/availability` (SUPER_ADMIN-only, OCC); `apps/guardrail` resolves the selection through the existing resolver as a pseudo task key and both screens honour it, always gating; `injectionScreeningCriteria` removed; console "Guardrail availability" tab. |
| 2026-09-10 | **H6 closed.** The owner confirmed the derived both-directions rule (TASK-941 R2 / OD-2). No code change — `assertBothDirectionsCovered` stays exactly as shipped; the confirmation is recorded on its docblock so the rule and its authority live together. |
