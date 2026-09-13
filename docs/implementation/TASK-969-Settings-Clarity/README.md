# TASK-969 — Configuration & Settings Clarity

| Field | Value |
|---|---|
| **Status** | `Pending` — owner decisions answered 2026-09-13 (§4); WS-2 DROPPED; awaiting approval to implement WS-1 / WS-3 / WS-4 |
| **Type** | `feature` (UX + governance), with three `bugfix` workstreams folded in |
| **Branch** | `dev-2.2` |
| **Raised** | 2026-09-13, from a live debugging session on the LLM playground |
| **Owner ask** | *"I WANT every configuration, settings to be CLEAR, EASY TO UNDERSTAND, for both platform admin to manage global-wide and tenant, and for tenant admin to manage his tenant."* |

---

## 1. Requirement Analysis

Two audiences, one registry. The requirement is that each can answer three
questions about any setting they are shown, without reading source:

1. **What does this control, and what happens if I change it?**
2. **Who does my change affect** — just my tenant, or every tenant?
3. **Did my change take effect?** And if not, *why not*.

Today the platform answers (1) well (descriptions are thorough), answers (2)
ambiguously for one key family, and can answer (3) with a confirmed success for
a write that has no reader. For tenant admins, question (2) is mostly moot
because they can see 9 of 242 settings.

**Scope.** The settings-registry surface end to end: descriptors, the write and
read lanes, the console screens that render them, the errors raised when a
governed value cannot be resolved, and the seed rows that establish defaults.
NOT in scope: adding new settings, or re-tiering existing ones from `global-kv`
to `db-config`.

### Origin — the session that raised this

A `"hello"` prompt in the LLM playground returned `422` rendered as
*"No model resolved for this tenant."* The actual cause was the guardrail's
medical-relevance gate rejecting a non-clinical prompt. The owner then set
`text.guardrailPolicy.requireMedical = false`, received a `200 OK`, re-read the
value as `false` — and the prompt still failed. Every layer reported something
true and nothing reported the cause. That is the failure mode this ticket exists
to remove.

---

## 2. Current State Evaluation

Measured 2026-09-13 against the running dev stack and `registry.list()`
(242 descriptors).

### F-1 — The twin-key trap: a write that succeeds and is never read

`requireMedical` and `includeReasoning` each exist as TWO keys, split by
delivery channel:

| Key | `maxScope` | `consumedBy` | Channel | A SYSTEM row means |
|---|---|---|---|---|
| `text.externalGuardrail.<f>` | `system` | `['text']` | PULL, one cached snapshot per process | the platform default every tenant inherits |
| `text.guardrailPolicy.<f>` | `tenant` | *(none)* | PUSH, per request | **nothing — no reader** |

The split is correct and deliberate (`registry.types.ts`: a `maxScope: 'tenant'`
descriptor must not declare `consumedBy`, or one cached snapshot becomes one per
tenant). The defect is everything built on top of it:

1. **The console offers the dead scope.** `governance.ts::writableScopes` is
   `if (isElevated) scopes.push('system')` — unconditional. The picker renders
   *"Platform default (SYSTEM) | ArcaAI override"* on the tenant-half key, where
   the SYSTEM option is a no-op.
2. **The read-back confirms it.** `GET .../registry/:key` returns
   `{value: false, sourceScope: "system"}` — faithful to the generic cascade,
   indistinguishable from a setting that took effect.
3. **This is an EXCEPTION, which is why it misleads.** For an ordinary
   `maxScope: 'tenant'` key the SYSTEM row *is* the platform fallback —
   `EffectiveSettingsService.resolveEffective` widens
   `tenant → system → code-default`. This family's only consumer,
   `TextRequestEnrichmentService.applyTenantGuardrailPolicy`, refuses everything
   but `sourceScope === 'tenant'` so `apps/text` can keep "tenant chose it"
   distinct from "no opinion" (its field is `bool | None`). Correct at the
   service layer; invisible at every layer above it.
4. **Nothing declares it.** No descriptor field can say *"my SYSTEM row has no
   reader; my platform tier is `<other key>`"*, so neither the picker nor the
   write lane can refuse.

**Evidence.** With only the SYSTEM row present, `requireMedical=false` ⇒ `"hello"`
still `422`. With `text.externalGuardrail.requireMedical=false` at SYSTEM and no
tenant row anywhere, `"hello"` ⇒ `200` for BOTH ArcaAI and Global — the tier
works exactly as documented, on the key that owns it.

Affected keys: `text.guardrailPolicy.requireMedical`,
`text.guardrailPolicy.includeReasoning`. A registry-wide leaf-name scan found no
third instance.

### F-2 — A tenant admin can edit 9 settings out of 242

`isTenantVisibleSetting` = `maxScope !== 'system' AND NOT globalOnly`:

| Population | Count |
|---|---|
| Total descriptors | **242** |
| `maxScope: 'system'` (no tenant row possible) | 220 |
| `maxScope != 'system'` | **22** |
| …of those, `globalOnly: true` (per-tenant value, platform-admin-only) | **13** |
| …**visible and editable by a tenant admin** | **9** |

The 9: `rateLimit.{enabled,maxRequests,windowMs}`,
`identity.autoProvision.{enabled,roleId,departmentId}`,
`apiKey.maxLifetimeDays`, `refreshToken.ttlSeconds`,
`metering.compute.deviceByProvider`.

The 13 locked per-tenant values: `text.guardrailPolicy.{requireMedical,includeReasoning}`,
`entitlements.featurePlatformDefaultCredential`, `workflowExposure.enabled`,
`liveDoc.groundedness.enabled`, `consultation.realtime.graphExecutor.enabled`,
`enable-consultation-sharing`, `tenantIdp.{googleDirectory,msGraph}.enabled`,
and the four `console.*` feature gates.

Several of these are deliberate — owner decision #3 (2026-09-05) made the whole
guardrail family platform-only, and the `console.*` gates are rollout controls by
design. But the owner ask above says tenant admins should manage their tenant,
and today that surface is 9 keys. **Which of the 13 open up is an owner decision,
not an engineering one** — see §4.

### F-3 — Errors name a cause that is not the cause

| Layer | Shows | Actual |
|---|---|---|
| `playground-llm-screen.tsx:250` | every `422` ⇒ `kind: 'fail-closed'` ⇒ *"No model resolved for this tenant"* | ≥5 distinct causes: `ModelNotSelected`, `ContentBlocked`, `InputValidation`, `VisionNotSupported`, provider 4xx |
| `TextProxyController.buildUpstreamException` | status preserved, body replaced with *"TEXT service unavailable"* | a `422` that reads like a `503` |

The gateway's redaction is **correct** — a guardrail reason can quote the prompt
(PHI). The gap is that `apps/text` raises this one as a bare `HTTPException` with
no `error_code`, so there is no non-PHI token the gateway could safely relay.

### F-4 — The platform defaults are invisible, not merely unseeded

Of the six guardrail-posture keys, exactly **one** is seeded:
`text.externalGuardrail.enabled` (`seed/11-global-setting.ts:507`, id
`00000000-0000-0000-0002-000000000004`, `value: true`, `defaultValue: false`,
`locked`). It needs a seed row because its descriptor is a `killSwitch` and the
registry refuses to register a kill-switch defaulting ON — so without the row
both gate halves were inert on every deployment.

The other five `text.externalGuardrail.*` keys resolve to `code-default`, which
means **a platform admin cannot see or edit the value that is actually in force**
without first creating a row by guessing the key.

> **CORRECTION (2026-09-13).** An earlier draft justified this as "an operator's
> override is erased by the next re-seed". That is true but seeding does NOT fix
> it. The wipe observed at 11:24 was `pnpm db:all`, which runs
> `db push --force-reset` and drops the schema; the seed itself is idempotent
> `upsert` and its only delete is `retireSupersededGlobalSettings`, a targeted
> sweep of NAMED retired keys. So nothing hand-written survives `db:all`,
> seeded or not, and seeding a PLATFORM key would not protect a TENANT row in
> any case. What seeding actually buys is (a) the platform default becomes a
> visible, editable row instead of an invisible code-default, and (b) a
> deliberate flip survives a plain `pnpm db:seed`. Both are on-ticket for
> clarity; the durability claim was not correct and is withdrawn.

---

## 3. Implementation Plan

Four workstreams. WS-1 and WS-3 are independent; WS-2 is gated on §4.

### WS-1 — One setting, one row, a scope picker that means what it says (fixes F-1)

**Upgraded by OD-2.** The original plan was to hide the dead SYSTEM scope on the
tenant-half key. With the owner ruling that `text.guardrailPolicy.*` stays
platform-admin-only, a better fix is available: **both** keys in each pair are
`globalOnly: true`, so both have exactly one audience — the platform admin. The
two-key split exists for TRANSPORT reasons (PULL snapshot vs PUSH per request)
and has no business surfacing in the UI at all.

So collapse each pair into ONE console row whose scope picker chooses the KEY:

| Picker option | Writes |
|---|---|
| *Platform default (every tenant)* | `text.externalGuardrail.<f>` at `system` |
| *«Tenant» override* | `text.guardrailPolicy.<f>` at `tenant` |

That is precisely the mental model the owner expected when the trap was hit, and
it is now safe to build because there is no second audience to consider.

1. **Registry** — add a descriptor field pairing the two halves:
   ```ts
   /** This key is the TENANT half of `<key>`; the pair renders as one row. */
   platformTierKey?: string;
   ```
   Declared on the two `text.guardrailPolicy.*` descriptors, with an
   assembly-time assertion that the named key exists, is `maxScope: 'system'`,
   and matches on `dataType` + `globalOnly`.
2. **Write lane** — `scope: 'system'` on a key declaring `platformTierKey` is a
   `400` naming the twin, in the shape the DELETE lane already uses. This stays
   as the backstop even though the console will no longer offer it: the API is
   reachable without the console.
3. **Read lane** — one call returns both halves (platform value + tenant value +
   which one is in force), so the drawer can show *"ArcaAI: off · platform: on"*
   without the caller knowing there are two keys.
4. **Console** — the paired row renders once, in the `Guardrail Policy` category,
   with the picker above. The two raw keys no longer appear as separate entries.

**Verify:** unit — the write 400s at system scope and the assembly assertion
catches a mispaired declaration; component — the picker renders two options and
routes each to the right key; e2e — write the tenant option, assert the row lands
on the tenant and `sourceScope: 'tenant'`; manual — the original repro, i.e. set
the tenant option to off and `"hello"` generates, with no reachable path to a
dead write.

### WS-2 — ~~Widen the tenant-admin surface~~ **DROPPED** (OD-1 / OD-2 / OD-3)

The owner declined to reverse the standing locks. The 13 `globalOnly` per-tenant
settings stay platform-admin-only and the tenant-visible surface stays at 9 keys.
No code. See §4 for the residual question on 7 keys OD-2/OD-3 did not name.

### WS-3 — Say the real reason (fixes F-3)

1. **`apps/text`** — raise the guardrail rejection as a typed `ContentBlockedError`
   carrying `error_code: 'CONTENT_BLOCKED_NOT_MEDICAL'` (a fixed vocabulary token,
   never the free-text reason, which can quote the prompt).
2. **`apps/api`** — `buildUpstreamException` relays `error_code` when it is in an
   allow-list of known non-PHI tokens; body stays redacted otherwise.
3. **Console** — the playground panel renders per code; the existing "no model
   resolved" copy becomes the `MODEL_NOT_SELECTED` branch only, with a generic
   fallback for unknown codes.

**Verify:** pytest that the 422 carries the code and never the prompt text; a
gateway unit test that an unknown code is still redacted; component test per branch.

### WS-4 — Make the platform defaults visible (fixes F-4)

Seed the **five** unseeded `text.externalGuardrail.*` keys at their current
code-default values, create-only on `value` like the `enabled` row, so a platform
admin sees and edits real rows rather than invisible code-defaults.

> **HAZARD — do NOT seed `text.guardrailPolicy.*`.** Those are the TENANT half.
> A SYSTEM row for either of them is exactly the dead row WS-1 is making illegal,
> and seeding one would ship the bug this ticket exists to remove. Five rows,
> `externalGuardrail` only.

Three further details are load-bearing, each already documented at the `enabled`
row: `namespace: 'registry'` (any other namespace makes the first governed write
create a SECOND SYSTEM row for the same key, tripping `AppSettingsService`'s
boot-time duplicate-key invariant and refusing gateway startup); `name` must
equal `descriptor.label`; and the id belongs in the same `00000000-0000-0000-0002-…`
SYSTEM block.

**Verify:** `pnpm db:seed` twice; assert the five rows exist, that a hand-flipped
`value` is not reverted by the second run, and that no `text.guardrailPolicy.*`
row is created. **The seed runs are the ORCHESTRATOR's to execute** (§7) — the
database is a shared surface.

### Layer order

`registry descriptors → applications (write/read lanes) → apps/api → admin-console`,
with `apps/text` (WS-3.1) and the seed (WS-4) independent.

---

## 4. Owner Decisions — ANSWERED 2026-09-13

| # | Question | Answer |
|---|---|---|
| **OD-1** | Which of the 13 `globalOnly` per-tenant settings should a tenant admin manage? | **None — do not reverse the prior owner decisions.** The 13 stay platform-admin-only. *(Read back from "Reverses prior owner decisions", consistent with OD-2/3/4; see the residual question below.)* |
| **OD-2** | Open `text.guardrailPolicy.*` to tenant admins? | **NO.** Owner decision #3 (2026-09-05) stands: guardrail is built-in and platform-only. A tenant's clinical-enforcement stance is set by a platform admin on that tenant's behalf. |
| **OD-3** | Open the four `console.*` feature gates? | **NO.** They stay platform rollout controls. |
| **OD-4** | Make `maxScope: 'system'` keys visible read-only to tenant admins? | **NO — show no platform settings at all.** TASK-932 D-5 stands unchanged; the 404 existence-hiding posture is retained. |

### Consequences

1. **WS-2 is dropped.** The tenant-visible surface stays at **9 of 242** keys.
2. **The settings registry is a PLATFORM-ADMIN tool.** That is now an explicit
   posture rather than an accident. A tenant admin's real self-service surface is
   the domain screens — agents, prompt templates, workflows, AI provider
   connections, models — none of which are settings-registry keys. The owner ask
   ("tenant admin manages his tenant") is served there, not here.
3. **"Clarity" therefore means clarity FOR THE PLATFORM ADMIN**, who manages both
   the global-wide value and each tenant's override from the same screen. That is
   exactly what WS-1's paired row delivers, and it is why OD-2 makes WS-1 better
   rather than smaller.

### Residual question — NOT blocking

OD-2 and OD-3 named 6 of the 13 locked keys. Seven were not named:

`entitlements.featurePlatformDefaultCredential`, `workflowExposure.enabled`,
`liveDoc.groundedness.enabled`, `consultation.realtime.graphExecutor.enabled`,
`enable-consultation-sharing`, `tenantIdp.googleDirectory.enabled`,
`tenantIdp.msGraph.enabled`.

Under the OD-1 reading above these stay locked, which is the safe default and the
current behaviour — opening one later is a one-line descriptor change. Flagged so
the silence is on the record rather than assumed away. `tenantIdp.*` is the one
worth a second look: directory integration is normally the tenant's own IT
decision, and it carries the tenant's own credentials.

## 5. Implementation Summary

*(pending — nothing implemented yet)*

---

## 6. Change History

| Date | Change |
|---|---|
| 2026-09-13 | Ticket raised from a live LLM-playground debugging session. F-1…F-4 measured against the running dev stack; plan and owner decisions drafted. Status `Pending`. |
| 2026-09-13 | F-4 CORRECTED: the `db:all` force-reset (not the seed) wiped the rows; the seed is idempotent upsert, so the durability justification was withdrawn and WS-4 re-based on visibility. §7 execution plan added — 4 disjoint lanes, tiers, shared surfaces, pre-written L1↔L2 contract. |
| 2026-09-13 | OD-1…OD-4 answered by the owner: no tenant-admin widening, no guardrail devolution, no console-gate devolution, no platform-setting visibility. **WS-2 dropped.** WS-1 UPGRADED — with both halves of each pair confirmed platform-admin-only, the pair collapses into one console row with a scope picker instead of merely hiding the dead scope. Residual: 7 unnamed keys recorded in §4, non-blocking. |

---

## 7. Execution Plan — lane partition, tiers, shared surfaces

Per `.claude/rules/14-multi-agent-worktrees.md`. Four WRITE lanes, path-disjoint,
all four runnable in parallel.

### 7.1 Partition — verified disjoint

| Lane | Owns EXCLUSIVELY | Tier | Effort |
|---|---|---|---|
| **L1 — registry + API** | `packages/applications/src/services/settings-registry/**`, `apps/api/src/modules/settings-catalog/**` | `opus-5` | `high` |
| **L2 — console (settings)** | `apps/admin-console/src/features/settings-registry/**` | `opus-5` | `medium` |
| **L3 — error codes** | `apps/text/src/text/{core/exceptions.py,api/endpoints/generate.py}`, `apps/api/src/modules/streaming/text-proxy.controller.ts`, `apps/admin-console/src/features/playground-llm/**` | `sonnet-5` | `medium` |
| **L4 — seed** | `packages/database/src/prisma/db_main/seed/11-global-setting.ts` | `sonnet-5` | `low` |

Overlap audit (2026-09-13): L1/L3 both touch `apps/api` but different MODULES
(`settings-catalog` vs `streaming`); L2/L3 both touch `apps/admin-console` but
different FEATURES, and features never import each other (rule 13). No file is
claimed twice. `shared/api/http.ts` is NOT touched by any lane — `GatewayError`
already carries `code` and `details` (`http.ts:41,47`), so L3 needs no change
there. No schema change, so no migration and no lane touches `packages/database`
except L4's seed file.

### 7.2 Tier rationale

- **L1 `opus-5/high`** — it defines the contract every other lane and the whole
  fix depend on. Rule §1: never downshift the stage whose verdict you act on.
- **L2 `opus-5/medium`** — the owner's requirement ("CLEAR, EASY TO UNDERSTAND")
  is a UX outcome and L2 owns the surface that delivers it. Contract handed down
  by §7.3, so `medium` rather than `high`.
- **L3 `sonnet-5/medium`** — mechanical once the PHI-safe token allow-list is
  fixed. That safety judgement is NOT delegated: the orchestrator specifies the
  allow-list in the brief, so no lane decides what may cross the boundary.
- **L4 `sonnet-5/low`** — pattern-following against an existing exemplar. Not
  `haiku` because a wrong `namespace` creates a duplicate SYSTEM row that refuses
  gateway startup; the brief names all four hazards explicitly.

### 7.3 The contract — written BEFORE spawning, so L1 and L2 run in parallel

Descriptor field (L1 declares, L2 consumes):

```ts
/** This key is the TENANT half of `<key>`; the pair renders as one console row. */
platformTierKey?: string;
```

Read lane — `GET admin/settings/registry/:key` gains, for a key declaring it:

```jsonc
{
  "key": "text.guardrailPolicy.requireMedical",
  "value": false, "sourceScope": "tenant", "version": 3,
  "pair": {
    "platformTierKey": "text.externalGuardrail.requireMedical",
    "platformValue": true,
    "platformVersion": 2,
    "inForce": "tenant"          // "tenant" | "platform"
  }
}
```

Write lane — `PUT` with `scope: "system"` on a key declaring `platformTierKey`:
`400`, `code: GENERIC.ARGUMENT_INVALID`, message naming the twin.

### 7.4 Shared surfaces — ORCHESTRATOR ONLY (rule §3)

No lane may run any of these; a lane that believes it needs one reports back
instead:

| Surface | Why |
|---|---|
| `pnpm install` in each worktree | fresh worktrees have no `node_modules` (rule §4) |
| `pnpm db:seed` / `db:push` / `db:all` / `test:db:reset` | one shared dev DB; `db:all` force-resets and would destroy sibling lanes' state |
| The running dev stack (gateway 8868, text 8862, guardrail 8863) | single shared process set; the live `"hello"` repro is run once, by the orchestrator |
| `hope_shadow` | shared across sessions |
| Every merge into `dev-2.2` | rule §5 |

Lanes run **unit and component tests only**. Integration verification — the
original repro, the double-seed check, the paired-row click-through — is the
orchestrator's, after merge.

### 7.5 Worktrees and merge order

`../hope-v2-t969-{registry,console,errors,seed}` on branches
`task-969-{registry,console,errors,seed}`, all branched from `dev-2.2` AFTER this
README is committed (rule §3: commit before spawning). Each needs `.env.dev` and
`.env.test` copied in — gitignored files do not follow a worktree (rule §4).

Merge order **L1 → L2 → L3 → L4**, re-running affected gates AFTER each merge
(a clean merge is not a passing build). L3 and L4 are independent of L1/L2 and may
merge in any order relative to each other. Worktrees are removed only after their
branch is merged (rule §5) — never before.

L3 touches `apps/text`, so the Python worktree guard applies; `apps/text` carries
both halves (`pythonpath` + `conftest` `assert_source_tree`), re-proven
2026-09-12, so `pnpm text:test` from the worktree tests worktree source.

### 7.6 Return contract — every lane

Branch · commit sha · files changed · the exact commands run with **pasted
output** · anything left undone. A report asserting "tests pass" without output
is not a result (rule §2).

---
