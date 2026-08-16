# TASK-705 — Loop Status Discovery

| | |
|---|---|
| **Status** | Review |
| **Wave** | 0 · **Size** | S |
| **Epic slug** | `loop-status-discovery` |
| **Depends on** | — |
| **Design refs** | D1 ("`ConsultationLoopWorkflow` never adopted; superseded by the interpreter" — this ticket determines whether that decision has an active-in-production consequence to manage during the transition) |
| **Findings closed** | Re-triages A-26, A-27, A-28 (per [04-target-architecture.md](../../architecture/consultation-session-workflow/assessment/04-target-architecture.md) §7 remediation table row `loop-status-discovery`) |

## 1. Requirement Analysis

`ConsultationLoopWorkflow` (`apps/harness/src/harness/temporal/workflows.py:1877-2116`) is a
signal-driven, per-consultation dispatcher gated by a single kill-switch,
`harness.loop.enabled`. The switch's **code default is `false`**, but every environment that runs
the platform's own seed carries a `GlobalSetting` row that sets it to **`'true'`**
(`packages/database/src/prisma/db_main/seed/11c-consultation-gate-settings.ts:63-70`). Whether the
loop is actually dispatching workflows in any given deployment today is therefore not answerable
from the code alone — it depends on whether that environment's database was ever seeded, which
depends on a deploy-time gate (`RUN_SEED`) this repository does not fully control (the k3s
manifests live in a separate GitLab project, `arca/hope-v2-deployment`, per
`.claude/rules/09-infrastructure-devops.md`).

This matters because of `_adjudicate()` (`apps/harness/src/harness/temporal/workflows.py:2653-2716`):
when the loop dispatches, it reconciles multiple specialist agents' findings with no clinician
gate between reconciliation and persistence (A-28 in the conformance matrix). If the loop is
dormant everywhere, A-28 is a latent code-level finding to fix before Wave 4 migration. If the
loop is actually signalling and dispatching in a live environment today, A-28 is a **live defect**
requiring its own re-triage and possibly an out-of-band mitigation before this program's Wave 1
lands `session-state-machine`/`consent-abac`.

This ticket delivers:
1. A **procedure and the exact queries** to determine harness.loop.enabled's EFFECTIVE value —
   distinguishing the `GlobalSetting` row's stored value, the code default, and the
   settings-registry descriptor's declared default — per environment (local dev, and whichever
   deployed environments exist; today only `hope-v2-dev` per
   `.claude/rules/09-infrastructure-devops.md` §Cluster Deploys).
2. A **Temporal-side query procedure** to determine whether `ConsultationLoopWorkflow` executions
   have actually started in the last 30 days in any reachable environment — the `GlobalSetting`
   row only proves the *signal* is armed, not that anything has *dispatched* (see §2.2 — dispatch
   also requires derived per-tenant loop config to resolve non-null).
3. An **inventory of what changes when the loop is on** (§2.3), so the decision this ticket
   surfaces is informed, not abstract.
4. A single **HUMAN-GATED decision task** (§4, Task 5): given the findings, what should
   `harness.loop.enabled`'s value be, explicitly, in each environment — and setting it explicitly
   (never left to seed-vs-code-default ambiguity) via the existing write path.

**Explicitly out of scope**: fixing A-28 itself (that is `session-state-machine`/a future
consent-abac-adjacent epic, not this ticket); adopting `ConsultationLoopWorkflow` as the
orchestration layer (D1 already forecloses this — "never adopted; superseded by the interpreter");
building any new admin-console UI for this setting (the existing `GET/PUT
/admin/settings/registry/harness.loop.enabled` route already covers read+write, see §2.4).

## 2. Current State Evaluation

### 2.1 The three values, and why they disagree by design

| Layer | Value | Evidence |
|---|---|---|
| Code default (the descriptor's `default`) | `false` | `packages/applications/src/services/settings-registry/descriptors/consultation-gates.descriptors.ts:29-38` — `default: CONSULTATION_GATE_DEFAULTS[HARNESS_LOOP_ENABLED_KEY]`, itself `false` at `packages/applications/src/services/consultation/consultation-gates.constants.ts:47` |
| `defaultValue` column on the seeded `GlobalSetting` row (what "reset to default" reverts to) | `'false'` | `seed/11c-consultation-gate-settings.ts:66` |
| `value` column on the seeded `GlobalSetting` row (the effective value in any environment that ran this seed) | `'true'` | `seed/11c-consultation-gate-settings.ts:65`, comment at `:70`: *"Enabled on day 1 in every environment... Locked — only GLOBAL_ADMIN may change it."* |

This three-way split is **deliberate, not drift** — the seed file's own header comment
(`seed/11c-consultation-gate-settings.ts:1-42`) explains why: `SettingsRegistry.killSwitches()`
throws at assembly for any kill-switch whose descriptor `default === true` (a governance
invariant — no kill-switch may ship pre-armed at the code level), so the *only* sanctioned way to
have a kill-switch land ON in a seeded environment is a seeded row, with the descriptor default
staying OFF as the fail-safe answer for any deployment that never seeds. The parity between the
seed's literal key/label/namespace/tenant coordinates and the registry descriptor is itself
enforced by an existing test:
`packages/applications/src/services/settings-registry/__tests__/consultation-gate-seed-parity.test.ts`,
whose own header states the product requirement in plain language: *"the consultation loop is
enabled on day 1, in every environment including local development."*

**This means the premise "is the loop accidentally on" is likely wrong.** The code itself
documents this as an intentional owner decision. What this ticket actually needs to determine is
narrower and more operational: (a) does every environment that should have received this seeded
intent actually have it (i.e., did `RUN_SEED` run there), (b) does the signal being armed
translate into the workflow actually *doing* anything (§2.2), and (c) given that the loop's
`_adjudicate()` auto-resolution (A-28) was apparently not part of the reasoning captured in the
seed comment, does the owner still want this once A-28 is named explicitly.

### 2.2 Signal armed ≠ workflow dispatching — the derived-config gate

`harness.loop.enabled` only governs whether `LoopContextSignalService` forwards `ContextAdded` /
`consultation-ending` / `loop-cancel` events as Temporal signals
(`packages/applications/src/services/consultation/loop/loop-context-signal.service.ts:44-70`,
resolved fresh on every call via `TenantSettingsService.resolvePlatform`, never cached on the
instance — comment at `:55-63`). Whether `ConsultationLoopWorkflow` then does anything meaningful
once signalled depends on a **second, derived** condition documented in
`packages/database/src/prisma/db_main/seed/07e-consultation-loop-defaults.ts:1-20`:

```
const enabled = agentConfigVersionId !== null || contextSchemaVersionId !== null;
```

(`packages/applications/src/services/consultation/loop/loop-config.service.ts`). Before
`07e-consultation-loop-defaults.ts` existed, a signalled workflow completed with `phase:
"DISABLED"` because neither value existed on a fresh install — i.e., the signal fired but the
loop did nothing. `07e` now seeds both a default `ConsultationContextSchema` and, via
`07a-agent-golden-library.ts`, a matching `DAY1_AGENT_LOOP_CONFIG` on every seeded default agent —
so in any environment that has run **both** `11c` and `07e`/`07a`, the loop is armed **and**
resolves non-trivially, meaning it is plausible the workflow is genuinely dispatching, not merely
signalled into a no-op. This is the fact that turns "check one `GlobalSetting` row" into "check
the row, then separately confirm via Temporal whether executions exist" (§4 Task 2).

### 2.3 What the loop changes when it dispatches (inventory, from the evidence base)

Read from `docs/architecture/consultation-session-workflow/assessment/evidence/orchestration.md`
(already-verified wave-1 evidence, re-cited here rather than re-derived since this ticket's job is
discovery/decision, not re-auditing orchestration):

- **Layer 1 (always live)**: `LiveDocumentationService` drives the ephemeral running work-note;
  `HarnessDocWorkflow` runs once per consultation at STT-finalize time via
  `ConsultationEventHandler.handleTranscriptionCreated` — unaffected by this switch either way.
- **Layer 2 (this switch)**: when armed and dispatching, `ConsultationLoopWorkflow` additionally
  runs a genuinely different multi-agent-aware drain sequence
  (`workflows.py:2099-2110`, two-phase: await in-flight agents, force-stop on timeout), per-agent
  timeout isolation via `SpecialistWorkflow` child workflows (5-minute bound, `max_attempts=1`,
  degrades the parent rather than retrying — `workflows.py:1784-1787`), explicit
  `continue_as_new` checkpointing (`workflows.py:2724-2774`), and — the safety-relevant part —
  `_adjudicate()` (`workflows.py:2653-2716`), which reconciles specialist findings against each
  agent's `writeScope` (write-scope enforcement is real and tested — `LoopAgentSpec.may_write()`,
  `models.py:1087-1093`) but auto-resolves the reconciled record with **no clinician gate** before
  handing off to `harness.finalize`, which starts `HarnessDocWorkflow` as an unmodified child.
- **Net delta if dispatching**: the loop does not duplicate note synthesis (it composes the same
  `HarnessDocWorkflow`) and does not race `LiveDocumentationService` (both are idempotent no-ops on
  a second start/stop call). The delta is entirely in **orchestration behavior between agents** —
  drain semantics, per-agent isolation, checkpointing, and the ungated adjudication step.

### 2.4 The read/write path this ticket's procedure uses

- `GET /api/v1/admin/settings/registry/harness.loop.enabled` — read the descriptor metadata plus
  the effective value and cascade trace (`apps/api/src/modules/settings-catalog/settings-registry-write.controller.ts:47-` — route decorated `@CanRead('GlobalSetting')`). Accepts `tenantId`/`scope`
  query params for platform admins.
- `GET /api/v1/admin/settings/effective` — the broader effective-settings surface
  (`apps/api/src/modules/settings-catalog/settings-catalog.controller.ts:55`).
- `PUT /api/v1/admin/settings/registry/harness.loop.enabled` — the write path the seed file's own
  comment names as the intended way to change this (`seed/11c-consultation-gate-settings.ts:41-42`,
  `PUT ... { "value": false }`), enforced by `SettingsRegistryWriteService` (the single enforcement
  point for `globalOnly`/`editableBy`, per `settings-registry-write.controller.ts:17-29`).
- Direct DB read (no code change needed): `SELECT value, "defaultValue", "updatedAt", "updatedBy"
  FROM core."GlobalSetting" WHERE namespace = 'registry' AND name = 'Consultation loop signalling'
  AND "tenantId" = '50000000-0000-0000-0000-000000000000';` — the exact row coordinates the seed
  writes (`SEED_TENANT_ID`, namespace `'registry'`, name copied verbatim from the descriptor label
  — `seed/11c-consultation-gate-settings.ts:30-38,62-64`; `SEED_TENANT_ID` confirmed at
  `packages/database/src/prisma/db_main/seed/00-constants.ts:111`).
- `RUN_SEED` gating (`packages/database/migrate.sh:33-45`) defaults to `none` — no seeding, no DB
  connection opened — and is only raised to `all`/`safe` per-environment by the **deployment
  repo's** overlay Kustomize patches, which live in `arca/hope-v2-deployment`, not this repository
  (`.claude/rules/09-infrastructure-devops.md` §Cluster Deploys: only the `hope-v2-dev` namespace
  currently exists). This repo cannot answer "did `RUN_SEED` run in each environment" by itself —
  that is one of this ticket's procedure steps, not something derivable from a grep here.
- **Temporal-side query**: no existing gateway route lists workflow executions by type — only
  `POST /admin/harness/workflows/:id/{cancel,terminate,signal}` exist
  (`apps/api/src/modules/harness-admin/harness-admin.controller.ts:465-485`), which require
  knowing an id in advance. The procedure in §4 Task 2 therefore uses Temporal's own tooling
  directly (`temporal workflow list --query "WorkflowType='ConsultationLoopWorkflow'"` against the
  cluster's Temporal frontend, or the equivalent Python `client.list_workflows()` call) — this is
  an operational/investigative step, not new code.

## 3. Knowledge & Best Practices

- `.claude/rules/09-infrastructure-devops.md` §Configuration Tiers — `harness.loop.enabled` is
  correctly `global-kv` (a kill-switch, must default OFF, backed by `GlobalSetting`, propagates via
  `app-settings:invalidate` — all already true here; this ticket does not change the tier).
  §Config caches rule 1: "`tenantId` MUST be part of every config cache key... sound only because
  it admits platform-reserved tenants exclusively" — this key qualifies (`maxScope: 'system'`,
  `globalOnly: true`), so `AppSettingsService`'s key-only cache is safe for it; this ticket does
  not touch caching.
- `.claude/rules/01-development-workflow.md` — this is explicitly a **discovery** ticket (S size);
  its "implementation" is a written procedure plus one HUMAN-GATED decision task, not new
  application code, so the TDD Red-Green-Refactor cadence in §01 applies only to the one small
  reporting script this ticket may produce (Task 1), not to a feature build.
- **Pitfall**: do not conflate "the row says `true`" with "the loop is dispatching." §2.2 is the
  reason this ticket has two separate verification steps (`GlobalSetting` row, then Temporal
  workflow-execution query) rather than one.
- **Pitfall**: do not re-open or re-implement A-28 in this ticket. Re-triaging it (updating its
  severity/urgency given this ticket's findings) is in scope; fixing it is not.

## 4. Implementation Plan

### Task 1 — Per-environment effective-value report (procedure + one script)
- **Agent:** T2 · sonnet-5 · low
- **Files:** `scripts/report-loop-status.sh` (new, read-only)
- **Approach:** A read-only script that, given `DATABASE_URL` (or reusing the existing env-file
  resolution the rest of the repo uses), runs the exact query from §2.4 against `core.GlobalSetting`
  and prints `value`, `defaultValue`, `updatedAt`, `updatedBy` for the `harness.loop.enabled` row,
  plus a companion query for `consultation.ocr.enabled` (the sibling kill-switch seeded by the same
  file, useful cross-check that the seed ran at all). Follow the shape of existing read-only
  reporting scripts under `scripts/` (e.g. `scripts/env-consumer-inventory.py` for the "read config,
  print a report" pattern) rather than inventing a new script style. No writes.
- **Verify:** Run against local dev DB (`pnpm infra:dev:up` already up): script prints the seeded
  `'true'` row exactly as documented in `seed/11c-consultation-gate-settings.ts`.

### Task 2 — Temporal workflow-execution query procedure (written procedure, no code)
- **Agent:** T2 · sonnet-5 · low
- **Files:** none (documented directly in this ticket's Implementation Summary once run)
- **Approach:** Document and, where reachable, execute the exact Temporal CLI query:
  `temporal workflow list --query "WorkflowType='ConsultationLoopWorkflow' AND StartTime > '<30-days-ago>'"`
  against each reachable Temporal frontend (local dev's `infrastructure/docker/docker-compose.dev.yml`
  `temporal` profile at minimum; the cluster's Temporal endpoint if credentials/access exist —
  note per `.claude/rules/09-infrastructure-devops.md` that Temporal today "runs on an unmanaged VM
  with a dead in-cluster copy," so this may require locating that VM's endpoint out-of-band, which
  is itself a finding to record if it cannot be located). Also run
  `temporal workflow count --query "WorkflowType='ConsultationLoopWorkflow'"` for a lifetime total,
  and separately query for `phase = "DISABLED"` completions (via `workflow show` on a sample of
  results) to distinguish "dispatched and did something" from "signalled into the §2.2 no-op."
- **Verify:** A dated result — either "N executions found, [sample ids]" or "endpoint unreachable,
  documented as an open question" for each environment attempted.

### Task 3 — Re-triage A-28 given confirmed dispatch status
- **Agent:** T3 · sonnet-5 · medium
- **Files:** none (written finding, feeds Task 5's decision)
- **Approach:** Using Task 1 + Task 2's results, write a short, explicit finding: for each
  environment where the loop is confirmed dispatching (armed row + non-DISABLED executions found),
  state that A-28 (`_adjudicate()`'s ungated auto-resolution, `workflows.py:2653-2716`) is a **live**
  defect there, not a gated-off one, per the design brief's framing. Cross-reference A-26/A-27 (the
  two-phase-drain and per-agent-timeout findings from §2.3) the same way — confirm whether their
  "PARTIAL — exists only in the dormant loop layer" verdict
  (`docs/architecture/consultation-session-workflow/assessment/evidence/orchestration.md:141`)
  should be upgraded given this ticket's findings.
- **Verify:** N/A — a written artifact, reviewed by the same agent tier as `harness-eval-gate`/
  `session-state-machine` (Wave 1) since they consume this re-triage.

### Task 4 — Cluster/deployment-repo cross-check (documented limitation if unreachable)
- **Agent:** T2 · sonnet-5 · low
- **Files:** none
- **Approach:** Attempt to determine `RUN_SEED`'s configured value for `hope-v2-dev` (the only
  cluster namespace that exists per `.claude/rules/09-infrastructure-devops.md`) by inspecting the
  `deployment/k8s/base/db-migrate.yaml` and `deployment/k8s/overlays/dev/kustomization.yaml`
  equivalents in the separate `arca/hope-v2-deployment` GitLab project (out of this repo — requires
  access to that project; if unavailable in this ticket's execution context, record that as an
  explicit open question rather than guessing). This closes the "cluster `RUN_SEED` gating unknown"
  gap named directly in the design brief.
- **Verify:** Either a confirmed `RUN_SEED` value for `hope-v2-dev`, or an explicit "could not
  access `arca/hope-v2-deployment` from this execution context" note carried into §6.

### Task 5 — HUMAN-GATED: decide and set the intended value per environment
- **Agent:** T2 · sonnet-5 · low (execution of the decision only — the decision itself is human)
- **Files:** none (a `PUT` API call per environment, or a follow-up seed/ops change if the decision
  changes what should be seeded)
- **Approach:** Present Tasks 1-4's findings to the product/engineering owner: the loop is
  documented in-code as an intentional day-1-on decision (§2.1); this ticket has now surfaced A-28
  as a concrete consequence of that decision (§2.3/Task 3) that was not named in the original
  seed-comment reasoning. Ask explicitly, per environment: stay on, given A-28 is scheduled for
  Wave 1 remediation (`consent-abac`/`session-state-machine` adjacency) — or turn off now via the
  documented `PUT` until A-28 lands. Whatever is decided, **set it explicitly** via `PUT
  /api/v1/admin/settings/registry/harness.loop.enabled` in every environment rather than leaving
  any environment's effective value implicit — this closes the "determine... AND set it explicitly
  everywhere" deliverable from the design brief.
- **Verify:** Task 1's report script re-run post-decision shows the intended value with a
  `updatedBy` matching the operator who made the call, in every environment reached.

## 5. Acceptance Criteria

- [ ] `scripts/report-loop-status.sh` runs cleanly against local dev
      (`pnpm infra:dev:up` running) and prints the `harness.loop.enabled` /
      `consultation.ocr.enabled` `GlobalSetting` rows' `value`/`defaultValue`/`updatedAt`/`updatedBy`
- [ ] A dated Temporal workflow-execution report exists for every reachable environment (local dev
      at minimum), stating either a confirmed execution count in the last 30 days or an explicit
      "endpoint unreachable" finding
- [ ] A-28 (and A-26/A-27) re-triage is written and explicitly states, per environment, whether the
      finding is live or gated-off, based on this ticket's evidence — not carried forward unchanged
      from the original assessment
- [ ] The `hope-v2-dev` `RUN_SEED` cross-check is either answered or explicitly recorded as
      inaccessible from this execution context
- [ ] **HUMAN-GATED** decision recorded in this ticket's Implementation Summary: the intended value
      of `harness.loop.enabled` per environment, with the operator's name/date
- [ ] The decided value is set explicitly (not left implicit) via the documented `PUT` route in
      every environment reached by Task 4/5, re-verified by Task 1's report script
- [ ] No application code changed other than the one new read-only reporting script — `pnpm lint`
      on `scripts/` if it has a lint target, otherwise `shellcheck scripts/report-loop-status.sh`
      passes clean

## 6. Risks & Open Questions

- **HUMAN-GATED (the ticket's core deliverable, restated)**: what should `harness.loop.enabled` be,
  per environment, now that A-28 is named as a concrete consequence? This is not a technical
  question this ticket can answer on its own.
- **The cluster Temporal endpoint may be unreachable from this ticket's execution context** —
  `.claude/rules/09-infrastructure-devops.md` already documents Temporal as running on "an
  unmanaged VM with a dead in-cluster copy." If Task 2 cannot reach it, the ticket's honest output
  for the cluster environment is "cannot confirm dispatch status," which itself is a finding worth
  escalating (an operationally unmonitorable kill-switch is a gap independent of this ticket's
  scope).
- **The deployment repo (`arca/hope-v2-deployment`) is outside this repository** — Task 4 may be
  blocked entirely depending on execution-context access. If blocked, that itself should be
  reported rather than assumed away.
- **`consultation-gate-seed-parity.test.ts`'s stated product requirement** ("enabled on day 1, in
  every environment") may itself need revisiting depending on the owner's Task 5 decision — if the
  decision is "turn off pending A-28," that test's assumption becomes stale and a follow-up ticket
  (not this one) would need to update it and the seed file's `value` together, per the seed file's
  own `defaultValue`/`value` mechanism (§2.1).

## 7. Implementation Summary

Executed 2026-08-16, in two passes. First pass: Tasks 1-4 completed to the extent that
execution context allowed (local infra was down; local DB unseeded; Task 1 proved via an
isolated throwaway container; Task 2 documented but not run anywhere; Task 4 answered via
read-only deployment-repo access). **Second pass (this update, same date): local infra is now
up and the local DB is freshly seeded** — Task 1 was re-run for real against the actual local
dev DB (confirms the central finding: a fresh seed run arms `harness.loop.enabled = 'true'`
with no extra step), and Task 2 was executed for real against local Temporal (confirms the
query mechanism works; returns 0 executions of any kind because no app/worker process was
running locally to generate any — an honest, uninformative-for-dispatch-status result, not a
"loop is dormant" finding). The `hope-v2-dev` cluster was **not** queried in either pass, per
explicit instruction each time ("local only" / cluster exec deliberately declined) — that
remains the one genuinely open confirmation. Task 5 is recorded as a HUMAN-GATED decision, not
made or executed here.

### Task 1 — `scripts/report-loop-status.sh`

Delivered `scripts/report-loop-status.sh` (read-only, no writes). It resolves `DATABASE_URL`
the same way the rest of the repo does (host env wins, falls back to the literal
`DATABASE_URL=` line in `.env.dev`), then runs the exact query from §2.4 against
`core."GlobalSetting"` for both `harness.loop.enabled` and `consultation.ocr.enabled`
(namespace `registry`, `tenantId = '50000000-0000-0000-0000-000000000000'`), printing
`key, value, defaultValue, updatedAt, updatedBy`. Exits 1 with a clear message if
`DATABASE_URL` can't be resolved, `psql` is missing, or the query itself fails (unreachable DB,
missing schema) — all treated as reportable findings, not silent failures.

**Verification performed (UPDATED 2026-08-16, local infra now up — see §8):**
- `shellcheck scripts/report-loop-status.sh` → clean, no warnings (see pasted output below).
- **Local dev DB is now up and reachable** (`hope-postgres` healthy, DB freshly reset with
  current schema per this session's operating state). Ran the script for real, no
  workarounds, against the actual `.env.dev` `DATABASE_URL`
  (`postgresql://postgres:postgres@localhost:5432/hope`). This supersedes the prior session's
  throwaway-container proof (kept below for the record) — acceptance criterion 1 is now
  genuinely closed, not just logic-proven.
- **Result: both rows exist and both are `value = 'true'`, `defaultValue = 'false'`**,
  `updatedAt` timestamped to this session's seed run (`2026-08-16 04:04:07`), `updatedBy` empty
  (i.e. set by the seed's `createdBy` default, never subsequently `PUT`-changed by an operator —
  consistent with §2.1's "seed sets it, no manual override yet" reading). This is the ticket's
  central finding **confirmed locally, for real, against a database that was seeded moments
  before this session started**: a fresh seed run arms `harness.loop.enabled = 'true'`
  automatically, with no extra step — exactly as `seed/11c-consultation-gate-settings.ts`'s
  header comment documents, and exactly as Task 4's `hope-v2-dev` `RUN_SEED` finding implies
  happened there too, at that environment's original bootstrap (before `RUN_SEED` was turned to
  `"none"` on 2026-08-09).

Pasted output (real local dev DB, this session):
```
$ grep -m1 '^DATABASE_URL=' .env.dev
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/hope

$ bash scripts/report-loop-status.sh; echo "EXIT: $?"
== Loop status report ==
Target: postgresql://****:****@localhost:5432/hope

           key            | value | defaultValue |        updatedAt        | updatedBy
--------------------------+-------+--------------+-------------------------+-----------
 consultation.ocr.enabled | true  | false        | 2026-08-16 04:04:07.803 |
 harness.loop.enabled     | true  | false        | 2026-08-16 04:04:07.801 |
(2 rows)

No row for harness.loop.enabled above means: this database was never seeded
(seed/11c-consultation-gate-settings.ts never ran here), so the EFFECTIVE
value falls back to the settings-registry descriptor default ('false').
See docs/implementation/TASK-705-Loop-Status-Discovery/README.md §2.1.
EXIT: 0

$ shellcheck scripts/report-loop-status.sh; echo "exit: $?"
exit: 0
```

**§2.2 derived-config gate — spot-checked in the same DB (informational, not a new AC):**
`core."ConsultationContextSchema"` has 3 rows, all `status = PUBLISHED` (so
`contextSchemaVersionId` can resolve non-null for a matching department/tenant). However
`core."DepartmentAgent"` and `core."DepartmentAgentVersion"` both have **0 rows** in this
freshly-seeded local DB, despite `core."Department"` having 29 rows — so `agentConfigVersionId`
resolves `null` for every consultation locally. `resolveForConsultation`'s condition is
`agentConfigVersionId !== null || contextSchemaVersionId !== null` (OR), so the derived gate can
still resolve `enabled: true` purely off the context-schema side, but the agent-roster half of
`07a-agent-golden-library.ts` appears not to have populated `DepartmentAgent` rows in this local
seed run. Not investigated further — root-causing the golden-agent-library seed gap is outside
this discovery ticket's scope (it does not gate `harness.loop.enabled` itself), but it is a
data point worth flagging for whoever next depends on `DepartmentAgent` seed data locally.

<details>
<summary>Prior session's throwaway-container proof (kept for the record; local dev DB was down at that time)</summary>

```
$ shellcheck scripts/report-loop-status.sh; echo "exit: $?"
exit: 0

$ DATABASE_URL="postgresql://postgres:postgres@localhost:15432/hope" bash scripts/report-loop-status.sh
== Loop status report ==
Target: postgresql://****:****@localhost:15432/hope

           key            | value | defaultValue |           updatedAt           | updatedBy
--------------------------+-------+--------------+-------------------------------+-----------
 consultation.ocr.enabled | true  | false        | 2026-08-15 18:41:48.958519+00 |
 harness.loop.enabled     | true  | false        | 2026-08-15 18:41:48.958519+00 |
(2 rows)

No row for harness.loop.enabled above means: this database was never seeded ...
EXIT=0

$ bash scripts/report-loop-status.sh   # against the real (down) local .env.dev target
== Loop status report ==
Target: postgresql://****:****@localhost:5432/hope
psql: error: connection to server ... Connection refused ...
FAIL: query failed — database unreachable, schema missing, or connection refused
EXIT=1
```
</details>

### Task 2 — Temporal workflow-execution query procedure

**UPDATED 2026-08-16 — executed for real against LOCAL Temporal (see §8). The cluster half is
still deliberately not executed, per this session's explicit instruction: local only.**

- **Local dev — executed.** `hope-temporal` is up and healthy (`docker ps`:
  `0.0.0.0:7233->7233/tcp`, `(healthy)`). No `temporal` CLI binary is installed
  (`command -v temporal` → not found), but the `temporalio` Python package IS present in the
  `arcaenv` conda env (`~/miniconda3/envs/arcaenv/bin/python -c "import temporalio"` succeeds),
  so the query was run via `temporalio.client.Client.connect("localhost:7233",
  namespace="default")` + `list_workflows(query=...)` — the SDK-native equivalent of the
  `temporal workflow list`/`count` CLI, connecting to the same gRPC frontend, read-only (no
  signal/cancel/terminate/start calls). Namespace `"default"` and task queue
  `"harness-task-queue"` confirmed from `.env.dev` (`TEMPORAL_NAMESPACE`, `TEMPORAL_TASK_QUEUE`)
  and `apps/harness/src/harness/core/config.py`. Script:
  `/private/tmp/.../scratchpad/query_loop_workflows.py` (scratchpad, not committed — this
  ticket's only committed file remains `scripts/report-loop-status.sh` per AC7).

  **Result: zero workflow executions of any kind in this namespace** — lifetime
  `ConsultationLoopWorkflow` count 0, last-30-days count 0, `HarnessDocWorkflow` lifetime count
  0, and an unfiltered `list_workflows()` (no query) also returns 0 total executions across every
  workflow type. This is **not** evidence the loop is dormant-by-design; it is evidence that
  **nothing has been signalled through this local Temporal instance at all**, consultation loop
  or otherwise. Checked why: neither `apps/api` (8868) nor `apps/harness` (8866) nor a Temporal
  worker process (`ps aux` — no `worker.py`/harness-worker process found; `lsof` on the app
  ports — none listening) is running in this session; only the Docker infra layer
  (Postgres/Redis/Temporal/Vault/MinIO/Qdrant) is up per this ticket's stated starting state. No
  app server means no `LoopContextSignalService` calls, no STT-finalize events, no
  `ConsultationLoopWorkflow` starts — so a 0 count here is the expected, uninformative result of
  "the pipes exist but nothing has been poured through them yet," not a finding about whether
  the loop dispatches when actually driven end-to-end. Starting the full app stack + running a
  real consultation through STT-finalize to produce a genuine local execution sample was judged
  out of scope for a discovery ticket and was not attempted.

  Pasted output:
  ```
  $ docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' | grep hope-temporal
  hope-temporal-ui   Up 2 hours             0.0.0.0:8233->8080/tcp
  hope-temporal      Up 2 hours (healthy)   0.0.0.0:7233->7233/tcp

  $ command -v temporal || echo "no temporal cli"
  no temporal cli

  $ ~/miniconda3/envs/arcaenv/bin/python -c "import temporalio; print(temporalio.__file__)"
  /Users/.../envs/arcaenv/lib/python3.11/site-packages/temporalio/__init__.py

  $ CI=true ~/miniconda3/envs/arcaenv/bin/python query_loop_workflows.py
  == Connected: localhost:7233 namespace=default ==

  -- list_workflows(query="WorkflowType='ConsultationLoopWorkflow'") --
  lifetime total ConsultationLoopWorkflow executions: 0

  -- list_workflows(query="WorkflowType='ConsultationLoopWorkflow' AND StartTime > '2026-07-17T05:52:28Z'") --
  last-30-days ConsultationLoopWorkflow executions: 0

  -- list_workflows(query=None) -- (sanity: any workflow executions at all) --
  total workflow executions of ANY type in this namespace: 0

  -- list_workflows(query="WorkflowType='HarnessDocWorkflow'") --
  lifetime total HarnessDocWorkflow executions: 0
  ```

- **`hope-v2-dev` cluster — still deliberately not queried**, per this session's explicit
  instruction ("Do NOT query or write to the hope-v2-dev CLUSTER — local only"), unchanged from
  the prior session's own independent decision to decline cluster exec. **Still an open
  question**, carried forward unresolved: whether `ConsultationLoopWorkflow` has actually
  dispatched in `hope-v2-dev` cannot be answered from this execution context under either
  session's operating constraints — it requires an operator with cluster access to run the
  documented procedure below.
- **Deployment-repo evidence from the prior session** (read-only `git`/GitLab reads of
  `arca/hope-v2-deployment`, not cluster execution — unchanged, not re-verified this session):
  `deployment/k8s/base/temporal.yaml` defines an ACTIVE `hope-temporal` Deployment + Service
  (grpc :7233, http :8233, metrics :9090) and a `hope-temporal-ui` Deployment + Service, both
  listed as ordinary resources in `deployment/k8s/base/kustomization.yaml` and included
  unmodified by `deployment/k8s/overlays/dev/kustomization.yaml`. **This appears to contradict**
  `.claude/rules/09-infrastructure-devops.md` / `04-target-architecture.md`'s characterization of
  Temporal as running "on an unmanaged VM with a dead in-cluster copy" — the in-cluster
  Deployment is real and wired into the base kustomization that `hope-v2-dev` syncs. Whether the
  live pod is actually healthy (vs. crash-looping / never synced) could not be confirmed without
  cluster exec, which both sessions declined to do. **Flagging as a documentation-drift finding
  worth a human re-check**, not resolving it here.

**Documented procedure for an operator to run against `hope-v2-dev`** (against the in-cluster
`hope-temporal:7233` frontend, e.g. via `kubectl -n hope-v2-dev exec` into a pod with the
`temporal` CLI, or a port-forward to a local `temporal` CLI — now also proven runnable via the
`temporalio` Python client shown above, as an alternative to needing the CLI binary installed):
```
temporal workflow list --query "WorkflowType='ConsultationLoopWorkflow' AND StartTime > '<30-days-ago-ISO8601>'"
temporal workflow count --query "WorkflowType='ConsultationLoopWorkflow'"
# then, on a sample of results:
temporal workflow show --workflow-id <id>   # inspect for phase:"DISABLED" (signalled-but-no-op, §2.2)
#                                              vs. a real multi-agent drain (genuinely dispatching)
```

### Task 3 — Re-triage of A-26/A-27/A-28

**UPDATED 2026-08-16**: Task 2 was now executed for real against local Temporal (§Task 2 above),
strengthening the *mechanism* confirmation (a fresh local seed run demonstrably arms
`harness.loop.enabled = 'true'` with zero extra steps — real evidence, not inference) while
leaving the *dispatch-in-`hope-v2-dev`* question exactly where the prior session left it: local
Temporal's 0-execution result is uninformative for that question (no app/worker was running
locally to generate executions either way — see Task 2), and the cluster itself was, per this
session's explicit instruction, still not queried. So this re-triage remains a **best-evidence
strengthening**, not a confirmed live/gated-off determination — stated honestly rather than
overclaimed:

- The seed comment's own framing ("Enabled on day 1 in every environment") plus the
  `hope-v2-dev` `RUN_SEED=none` finding (Task 4) together imply the `harness.loop.enabled` row
  in `hope-v2-dev`'s actual database was very likely set to `'true'` at the environment's
  **original bootstrap** (when `RUN_SEED` was presumably `all` or `safe`, before the 2026-08-09
  owner decision recorded in `deployment/k8s/overlays/dev/kustomization.yaml` to stop
  seeding/reset that database — its own comment there says the DB now holds "33 users, 14
  consultations, 1 255 audit rows, 88 prompt templates and 54 department agents", i.e. it has
  clearly been seeded and evolved, not left empty). Seed `11c` is CREATE-ONLY for `value`
  (never re-clobbers an operator's change), so even if seeding *did* run again since, it would
  not have reset an already-`'true'` row back — meaning once armed, it plausibly stays armed
  across subsequent migrate-only ArgoCD syncs.
- §2.2's derived-config gate (`07e-consultation-loop-defaults.ts` + `07a-agent-golden-library.ts`
  seeding a default `ConsultationContextSchema` and `DAY1_AGENT_LOOP_CONFIG`) is the same seed
  family as `11c` — if `11c` ran at bootstrap, `07e`/`07a` plausibly did too, which is the
  condition under which the signal does something rather than completing `phase: "DISABLED"`.
- **Recommended re-triage, pending an operator running Task 2's procedure to confirm/deny:**
  - **A-28** (`_adjudicate()` ungated auto-resolution): upgrade from "GATED-OFF +
    VIOLATED-in-scope" to **"LIKELY LIVE in `hope-v2-dev`, pending confirmation"** — treat it as
    an active-in-production consequence to manage during the Wave 1 transition
    (`session-state-machine`/`consent-abac` adjacency), not a purely latent finding.
  - **A-26** (two-phase drain) and **A-27** (per-agent timeout isolation): same upgrade — from
    "PARTIAL — exists only in the dormant loop layer" to **"LIKELY ACTIVE in `hope-v2-dev`,
    pending confirmation"**. Unlike A-28 these are not safety-negative findings on their own
    (they are the *presence* of correct isolation/drain behavior), so the upgrade mainly affects
    how the original assessment's "conditional on `harness.loop.enabled` staying false" caveat
    (`orchestration.md`) should be read for `hope-v2-dev` specifically.
  - **Local dev**: the effective value depends entirely on whether `pnpm setup:dev`/`db:seed`
    has ever been run against that developer's own database — not knowable in general. **This
    execution context's own local DB now IS seeded** (Task 1, updated 2026-08-16) and confirms
    `harness.loop.enabled = 'true'` — but no app server or Temporal worker was running in this
    session, so the signal was never armed against a live workflow and zero executions exist
    (Task 2, updated). Still no blanket re-triage for "local dev" as a class; it remains
    developer-instance-specific (whether a given developer's local stack is fully running, not
    just seeded, determines whether the loop is genuinely live on their machine).

### Task 4 — `hope-v2-dev` `RUN_SEED` cross-check

**Answered — accessed `arca/hope-v2-deployment` via the `gitlab` MCP** (read-only file
reads, not cluster execution):

- `deployment/k8s/base/db-migrate.yaml`: the base `hope-db-migrate` Job's `RUN_SEED` env var
  defaults to `"none"`.
- `deployment/k8s/overlays/dev/kustomization.yaml`: a strategic-merge patch on that same Job
  **explicitly re-asserts `RUN_SEED: "none"`** for `hope-v2-dev`, with an extensive comment
  trail explaining why: the Job used to carry `RUN_SEED=all` (seed-on-every-sync), but that
  "expired the day this database stopped being disposable" — it now holds real accumulated data
  (33 users, 14 consultations, 1 255 audit rows, 88 prompt templates, 54 department agents), and
  `all` would also re-enable `SEED_DEMO_DATA`, writing demo API keys with raw secrets on every
  sync. The comment records this as an explicit **owner decision dated 2026-08-09**: *"for argo
  deployment, we just migrate database, not reset and re-seed."*

**Conclusion: `hope-v2-dev` runs migrate-only on every ArgoCD sync today.** It does NOT run
`packages/database/src/prisma/db_main/seed/11c-consultation-gate-settings.ts` (or any seed file)
on an ongoing basis. Whatever `harness.loop.enabled`'s value is in that database today is
whatever it was left at by the last time seeding *did* run there (pre-2026-08-09, presumably at
initial environment bootstrap) or by a manual `PUT` since — not something this ongoing pipeline
re-asserts. This is exactly the ambiguity §1 of this ticket named, now resolved to "not
re-seeded, so check the live row directly" rather than "seeding runs, so the row is definitely
`'true'`."

### Task 5 — HUMAN-GATED decision

**Not executed. No `PUT` call was made, no environment's value was changed.** Per §4 of this
ticket and this execution's operating constraints, the decision below is presented to the
product/engineering owner for a decision, not made autonomously.

**Findings presented to the owner:**
1. The code-level intent (seed comment, `consultation-gate-seed-parity.test.ts`) is that
   `harness.loop.enabled` is `true` in every seeded environment, by design.
2. That intent did not, at the time it was written, explicitly account for A-28
   (`_adjudicate()`'s ungated auto-resolution) as a **named** consequence — Task 3 makes that
   consequence explicit.
3. `hope-v2-dev`'s `GlobalSetting` row was almost certainly seeded `'true'` at some point in the
   past (before seeding was turned off there), and current ArgoCD syncs do not re-seed or
   otherwise touch it — so absent a manual change, it is very likely still `'true'` today. This
   was not directly confirmed by a live query in this session (Task 2).
4. Local dev environments vary per developer machine and are not addressed by a single decision.

**Options for the owner, per environment:**
- **(A) Stay on** (`harness.loop.enabled = true`) — accept that A-28 is a live defect in any
  environment where the row is `'true'`, and schedule its fix explicitly against the Wave 1
  `session-state-machine`/`consent-abac` work already planned, rather than leaving it implicit.
- **(B) Turn off now** (`harness.loop.enabled = false`, via
  `PUT /api/v1/admin/settings/registry/harness.loop.enabled { "value": false }`) in every
  environment where it is currently `'true'`, until A-28 lands — trading away A-26/A-27's
  benefits (real drain/timeout isolation) along with A-28's risk, since they share one
  kill-switch. Requires a follow-up ticket to also update
  `consultation-gate-seed-parity.test.ts`'s "enabled on day 1" assumption and the seed file's
  `value` together (§6), so a future `db:seed`/environment bootstrap doesn't silently re-arm it.
- **(C) Split the switch** (not evaluated in depth here, out of this ticket's scope per §1, but
  worth naming): if A-26/A-27's isolation/drain behavior is independently valuable and A-28 is
  the only unacceptable part, a future ticket could gate `_adjudicate()`'s auto-resolution
  separately from the rest of the loop, letting the owner keep drain/timeout benefits without
  A-28's risk. This ticket does not recommend for or against this without the owner weighing in
  — it is a design change to `ConsultationLoopWorkflow`, not a discovery-ticket deliverable.

**This ticket's recommendation, offered for the owner's judgment, not a decision made here:**
given A-28 is scheduled for Wave 1 remediation adjacency already (`session-state-machine`/
`consent-abac`), and A-28's actual blast radius per the original matrix is narrow ("Multi-specialist
path only (lowest-priority use case)", `02-conformance-matrix.md:11`), **Option A (stay on, fix
on schedule)** appears lower-risk than a switch-flip that also reverts A-26/A-27's benefits and
requires a same-day test/seed update — but this is exactly the kind of tradeoff the ticket
explicitly reserves for the human owner, not this agent.

**No value was set in any environment.** Re-running `scripts/report-loop-status.sh` after the
owner's decision, in every environment reached, is how acceptance criterion 6 gets closed —
that re-run has not happened yet.

### Close-out pass (2026-08-16) — re-verified, nothing material changed, decision still owner-side

Re-checked this ticket as part of a three-ticket close-out pass (TASK-708,
TASK-704, TASK-705). Local dev infra (Postgres/Redis/Temporal/Vault/MinIO/Qdrant)
is up; re-ran Task 1's report script against the live local dev DB:

```
$ bash scripts/report-loop-status.sh
           key            | value | defaultValue |        updatedAt        | updatedBy
--------------------------+-------+--------------+-------------------------+-----------
 consultation.ocr.enabled | true  | false        | 2026-08-16 04:04:07.803 |
 harness.loop.enabled     | true  | false        | 2026-08-16 04:04:07.801 |
```

Identical `updatedAt` timestamp to the prior pass's result — the dev DB has
not been re-seeded since, so this is confirmation of stability, not new
information. Checked for a running app/worker process (`lsof` on
8868/8866/worker ports, `docker ps`/`ps aux`) to see whether Task 2's local
Temporal query could now produce an informative (non-zero) result: none is
running — same state as both prior passes, so re-running the Temporal
`list_workflows` query would reproduce the same uninformative 0-execution
result already recorded above and was not repeated. Per this close-out's own
instructions, cluster access remains **not** attempted (local only).

**Nothing in this ticket needed a code or documentation correction.** The two
prior passes' findings and honesty about what is/isn't confirmed hold up
under re-verification. The single remaining blocker is unchanged and is
squarely human-side: **Task 5's decision (stay on / turn off / split the
switch) has still not been made by a product/engineering owner, and no `PUT`
call has been issued in any environment.** This is not something a close-out
verification pass can resolve — per this program's own instructions ("if
something cannot be closed, say precisely why and leave the status at Review
with the reason"), Status remains **Review**, blocked exclusively on that
owner decision (§4 Task 5 / §6).

### Acceptance criteria — status

- [x] `scripts/report-loop-status.sh` exists, is executable, passes `shellcheck` clean, and was
      run for real against the actual local dev DB (now up, freshly seeded): both rows print
      `value = 'true'`, `defaultValue = 'false'` — **AC now genuinely closed**, superseding the
      prior session's throwaway-container-only proof.
- [x] A dated Temporal workflow-execution report exists — for local dev, executed for real
      against the live local `hope-temporal` (2026-08-16): 0 `ConsultationLoopWorkflow`
      executions lifetime/30-day, 0 of any workflow type, explained (no app/worker running
      locally this session, so nothing could have dispatched either way). For the cluster:
      still an explicit "not queried, local only per instruction" finding, plus the
      documented procedure and the deployment-repo evidence finding (hope-temporal IS an active
      in-cluster resource, contra the "dead in-cluster copy" doc claim) carried from the prior
      pass.
- [x] A-28 (and A-26/A-27) re-triage written — upgraded to "LIKELY LIVE / LIKELY ACTIVE in
      `hope-v2-dev`, pending confirmation" rather than left as "GATED-OFF", with the evidence
      chain strengthened by the real local mechanism-confirmation and the explicit caveat that
      live cluster confirmation is still pending an operator running Task 2's procedure there.
- [x] `hope-v2-dev` `RUN_SEED` cross-check answered directly (`"none"`, explicit owner decision
      2026-08-09) via read-only access to `arca/hope-v2-deployment`.
- [x] **HUMAN-GATED** decision recorded as **not yet made** — options and this ticket's
      non-binding recommendation presented above; owner's name/date to be filled in once decided.
- [ ] Decided value not yet set anywhere (blocked on the human decision above).
- [x] No application code changed other than the one new read-only reporting script;
      `shellcheck scripts/report-loop-status.sh` passes clean (pasted above). The Task 2
      Temporal-query script lives in this session's scratchpad only, never added to the repo.

## 8. Change History

| Date | Change | By |
|---|---|---|
| 2026-08-16 | Ticket authored | Wave-0 ticket-authoring agent |
| 2026-08-16 | Tasks 1-4 executed: delivered `scripts/report-loop-status.sh` (verified via shellcheck + an isolated throwaway Postgres, since local dev infra was not running in this execution context); documented the Temporal query procedure (not executed against any live Temporal frontend — none reachable locally, cluster execution deliberately declined); answered the `hope-v2-dev` `RUN_SEED` cross-check via read-only `arca/hope-v2-deployment` access (`RUN_SEED="none"`, explicit 2026-08-09 owner decision); re-triaged A-26/A-27/A-28 to "likely live/active in `hope-v2-dev`, pending confirmation". Task 5 (the value decision + `PUT`) presented as options for the human owner, not executed. Status set to Review pending that decision. | T2/T3 sonnet-5 execution agent |
| 2026-08-16 | Local infra came up (Postgres/Redis/Temporal/Vault/MinIO/Qdrant) with a freshly-reset, freshly-seeded DB. Re-ran Task 1 for real against the live local dev DB: confirms `harness.loop.enabled` and `consultation.ocr.enabled` both `value='true'`/`defaultValue='false'` — the central finding now proven locally, not just logic-tested. Ran Task 2 for real against local `hope-temporal` (namespace `default`, via the `temporalio` Python client — no `temporal` CLI installed): 0 `ConsultationLoopWorkflow` executions lifetime/30-day and 0 workflow executions of any type, explained (no `apps/api`/`apps/harness`/worker process was running locally this session, so nothing could have dispatched regardless of the loop's real behavior) — an honest, dispatch-inconclusive local result. `hope-v2-dev` cluster deliberately NOT queried or written to, per explicit instruction this session (local only) — that remains the sole open confirmation carried forward. Task 3's re-triage and the AC checklist updated to reflect the strengthened-but-still-cluster-unconfirmed evidence. Task 5 (the value decision) still not made; no `PUT` calls issued anywhere. Status remains Review. | T2 sonnet-5 execution agent |
| 2026-08-16 | **CLOSE-OUT PASS.** Re-verified Task 1 against the live local dev DB (identical result, same `updatedAt` as the prior pass — confirms stability, not new information) and confirmed no app/worker process is running locally (so a Task 2 Temporal re-query would reproduce the same uninformative 0-execution result already recorded — not repeated). Cluster access again not attempted (local only, per instruction). No code or documentation correction was needed — both prior passes' findings and honesty hold up. Status remains Review: the sole blocker is Task 5's HUMAN-GATED decision (§4/§6), which this pass cannot make. | Close-out pass agent |
