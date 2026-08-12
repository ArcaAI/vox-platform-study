# TASK-684 — Enable the consultation loop on day 1, in every environment

| | |
|---|---|
| **Status** | Review |
| **Type** | infrastructure (configuration / seed) |
| **Branch** | `task-684-enable-consultation-loop`, based on `dev-2.1` @ `3e666e29c` |
| **Depends on** | TASK-660 (loop event plane), TASK-662 (loop workflow), TASK-670 (signal payload), TASK-679 (config-tier compliance) |

---

## 1. Requirement Analysis

Owner requirement:

> "consultation loop must be enabled now, on day 1, even in any local development environments"

### 1.1 The constraint that shapes the solution

TASK-679 moved `harness.loop.enabled` out of `process.env` into the settings registry as a
**kill-switch** (`tier: 'global-kv'`, `killSwitch: true`). `SettingsRegistry.killSwitches()`
(`packages/applications/src/services/settings-registry/settings-registry.ts:86-90`) throws at
assembly if any kill-switch declares `default === true`, and
`EffectiveSettingsModule.onModuleInit` calls it at boot. So flipping the descriptor default is
not an option — it would refuse to start the gateway.

**The correct shape is a seeded row, not a changed default.** This is not a workaround; the
repo already does exactly this twice, and `11-global-setting.ts` spells out the reasoning:

> "The sweep's registry descriptor is a KILL-SWITCH, and the settings registry refuses at
> assembly to register a kill-switch that defaults ON (fail-safe governance …). So the sweep is
> enabled the sanctioned way: the descriptor default stays OFF and this platform VALUE turns it
> on. `defaultValue` stays 'false' so a reset reverts to the fail-safe."

| | Value | Consequence |
|---|---|---|
| descriptor `default` | `false` | An unseeded or half-provisioned deployment resolves OFF — fail-safe, invariant intact |
| seeded row `value` | `'true'` | Every seeded environment comes up with the loop enabled |
| seeded row `defaultValue` | `'false'` | "Reset to default" reverts to the fail-safe |
| seeded row `locked` | `true` | Only `GLOBAL_ADMIN` may flip it, including via the legacy `GlobalSetting` CRUD path |

### 1.2 Why this path had never executed

TASK-679's audit found `HARNESS_LOOP_ENABLED` was absent from both `.env.sample` and
`turbo.json#globalEnv`, and `.env.dev` / `.env.test` are generated from `.env.sample`. The flag
was therefore never settable through the supported config path, and `LoopContextSignalService`
has been **dead code in every generated environment** since it was written. Its unit tests pass;
the wired path had never run.

This ticket was treated accordingly — as switching on new code, not as flipping a proven flag.
Everything in §5 was verified against a running stack, not inferred.

---

## 2. Current State Evaluation

### 2.1 The signalling chain (what this ticket switches on)

```
ContextService.addContext / OcrEnrichmentProcessor re-emit
  └─ EventEmitter2 'ContextAdded'
      └─ LoopContextSignalService.handleContextAdded        [gate: harness.loop.enabled, per call]
          └─ HarnessGatewayService.signalContextAdded
              └─ POST {HARNESS_URL}/api/v1/internal/workflows/{id}/signal/context-added
                  └─ internal.py signal_context_added  →  client.start_workflow(start_signal=…)
                      └─ ConsultationLoopWorkflow  (workflow id "consultation-loop-{id}")

POST /api/v1/consultations/:id/recording/stop
  └─ ConsultationController.stopRecording
      └─ LoopContextSignalService.signalConsultationEnding  [same gate, best-effort]
          └─ POST .../signal/consultation-ending
```

The gate is read **per call**, never cached on the instance
(`loop-context-signal.service.ts:65-68`), so an operator flip takes effect with no restart.

### 2.2 Where the value physically lives

`harness.loop.enabled` is `tier: 'global-kv'` → the **`GlobalSetting` Postgres table**, not Redis.
No descriptor in the registry uses `redis-flag`; `global-kv` already has instant fan-out via the
`app-settings:invalidate` channel, with the 45s cron as a backstop.

`TenantSettingsService.resolvePlatform` is synchronous and reads the in-memory
`AppSettingsService` cache; absence → `applyDeclaredFailMode` → `descriptor.default` (`false`).

### 2.3 Row identity is load-bearing — the trap this ticket had to avoid

`SettingsRegistryWriteService` resolves an existing row by
`(key, namespace='registry', tenantId=GLOBAL)` and, failing that, **creates one named
`descriptor.label ?? key`** (`settings-registry-write.service.ts:324`). `GlobalSetting` is unique
on `(tenantId, name, key)`.

So a seed that wrote a different tenant, namespace or name would leave an operator's first `PUT`
creating a **second** platform row for the same key — and `AppSettingsService.cacheAppSettings`
**refuses to boot** on a duplicate platform key (`appSettings.service.ts:344-365`).

The seed therefore writes `SEED_TENANT_ID` (`50000000-…`) / `namespace: 'registry'` / names
copied verbatim from the descriptor labels. This is verified live in §5.4, and pinned by a
parity test because `packages/database` must not import `@arcaai/applications`.

Note the two existing seeded kill-switches (`pipeline.templateResync.enabled`,
`departmentAgent.templateResync.enabled`) sit on `SYSTEM_TENANT_ID` under non-registry
namespaces. That is safe for them (the duplicate-key invariant only counts `GLOBAL_TENANT_ID`
rows, and `platformRank` ranks GLOBAL above SYSTEM) but it is **not** the right target for a key
the registry write lane owns.

---

## 3. The OCR decision — and why

TASK-679 also moved `OCR_ENABLED` → `consultation.ocr.enabled` and, **forced by the same
kill-switch invariant**, changed it from effectively-ON to default-OFF. Its own descriptor says so:

> "NOW DEFAULTS OFF: the `OCR_ENABLED` env flag it replaces defaulted ON, which violated the
> kill-switch defaults-OFF invariant."

**Decision: seed `consultation.ocr.enabled = true` as well.**

This is a behaviour decision, not a mechanical one, so the reasoning is stated explicitly:

1. **It restores intent, it does not introduce it.** The default-OFF flip was a *mandated side
   effect* of a tier-compliance refactor, not a product decision. TASK-344 shipped OCR
   enrichment default-ON. Leaving it off silently ships a regression that no one chose.
2. **It is the same shape as the loop gate**, so both keys are governed identically and an
   operator sees one consistent story rather than two keys with different day-1 postures.
3. **The PHI posture is unchanged.** Bytes stay in-cluster (PyMuPDF + RapidOCR); there is no
   third-party egress. This was the only argument that could have counted against it, and it
   does not apply.
4. **Failure is already graceful.** With OCR off, a scanned attachment degrades to its filename
   label — which is exactly what a *failed* OCR pass already does. So turning it on cannot
   introduce a new failure mode, only a better result.
5. **It remains instantly reversible** via the same one-line disable as the loop gate, and the
   kill-switch invariant is untouched.

No evidence was found against it. The one cost is load on the NLP service when scanned
attachments arrive; that is precisely what the kill-switch exists to shed, without a redeploy.

---

## 4. Implementation

### 4.1 Files

| File | Change |
|---|---|
| `packages/database/src/prisma/db_main/seed/11c-consultation-gate-settings.ts` | **New.** Seeds both gate rows ON, idempotently. |
| `packages/database/src/prisma/db_main/seed/index.ts` | Registers the phase in Phase 4, after `seedPlatformKnobSettings`. |
| `packages/applications/src/services/settings-registry/__tests__/consultation-gate-seed-parity.test.ts` | **New.** Seed ↔ registry parity + gate-resolution tests. |

No migration. A seed is not a schema change; `GlobalSetting` already exists.
No env var was reintroduced — that is exactly what TASK-679 removed.
No descriptor default was changed — the kill-switch invariant is intact.

### 4.2 Idempotency

`update:` carries only code-owned metadata (`defaultValue`, `dataType`, `description`,
`namespace`, `locked`). `value` is **create-only**, so a re-seed never reverts an operator who
turned a switch back off. This is enforced repo-wide by
`seed/__tests__/seed-idempotency.test.ts`, which scans every `NN-name.ts` phase file.

**Proven, not assumed.** The guard was confirmed to actually cover the new file by temporarily
adding `value: gate.value` to the `update:` payload and watching it fail:

```
+ [
+   "11c-consultation-gate-settings.ts:100",
+ ]
 Test Files  1 failed (1)
      Tests  1 failed | 3 passed (4)
```

The probe was reverted; the guard then passed 4/4.

### 4.3 TDD

Test file written first, run against a non-existent seed file — **6 failed / 3 passed**. The 3
that passed assert pre-existing invariants (the kill-switch governance rule and the two
resolution cases), which is correct: they should hold before and after. After the seed landed:
**9 passed**.

---

## 5. Live end-to-end evidence

Nothing of the HOPE stack was running at session start, so no dev stack was disturbed. What was
started, and torn down afterwards:

| Component | How it was run | Torn down |
|---|---|---|
| Test infra (PG 5433, Redis 6380, MinIO 9002, Qdrant 6335) | `pnpm infra:test:up` | `pnpm infra:test:down` ✅ |
| Temporal | **isolated** `temporalio/temporal` dev server, in-memory, port **7234** (not the dev 7233) | `docker rm -f hope-684-temporal` ✅ |
| Harness API | `uvicorn harness.main:app` :8966, `PYTHONPATH` pinned to this worktree | killed ✅ |
| Harness Temporal worker | `python -m harness.temporal.worker`, `HARNESS_API_BASE_URL=http://localhost:8968` | killed ✅ |
| API gateway | `node apps/api/dist/main.js`, `NODE_ENV=test`, `SECRETS_PROVIDER=env` | killed ✅ |

Final container state was the two pre-existing non-HOPE containers only.

> `PYTHONPATH` was pinned because `arcaenv`'s editable install
> (`__editable__.harness-0.1.0.pth`) points at the MAIN checkout, so a worktree run would
> otherwise import main-tree Python source.

### 5.1 The seeded row resolves ON through the running gateway

```
harness.loop.enabled     -> {"key":"harness.loop.enabled","tier":"global-kv","value":true,"sourceScope":"system","version":2}
consultation.ocr.enabled -> {"key":"consultation.ocr.enabled","tier":"global-kv","value":true,"sourceScope":"system","version":1}
```

`sourceScope: "system"` is the point: the value came from the seeded `GlobalSetting` row, not
from `code-default`.

### 5.2 A real `context.added` starts the workflow

Opened a consultation, started recording, posted a `WORKNOTE` through
`POST /api/v1/consultations/:id/context`. Temporal, queried directly:

```
   Status                          WorkflowId                                  Type              StartTime
  Completed  consultation-loop-019ff544-5516-76b8-b21b-61c5850a43ff  ConsultationLoopWorkflow  6 seconds ago
```

Workflow state query:

```json
{"config_pinned":true,"consultation_id":"019ff544-5516-76b8-b21b-61c5850a43ff","degraded":false,
 "enabled":false,"events_processed":1,"phase":"DISABLED","pending":1, ...}
```

Memo carries the tenant: `tenantId:"50000000-0000-0000-0000-000000000000"`.

**So the chain works end to end**: seeded row → AppSettings cache → `resolvePlatform` → gate ON →
`LoopContextSignalService` → `HarnessGatewayService` → harness FastAPI → signal-with-start →
`ConsultationLoopWorkflow` created on Temporal, with `events_processed: 1`.

`recording/stop` then delivered the `consultation-ending` signal over the same path.

**But read `phase: "DISABLED"` carefully — see §6.1. It is the most important finding in this
ticket.**

> A first run showed `degraded: true`. That was **my own misconfiguration**, not a defect: the
> worker defaults `HARNESS_API_BASE_URL` to `:8868` while the test gateway runs on `:8968`, so
> `fetch_loop_config` exhausted its retries. Fixed and re-run; the second run shows
> `degraded: false, config_pinned: true`. Recorded because the two runs look identical at the
> "workflow started" level and only the state query distinguishes them.

### 5.3 Idempotency, against a real database

Set `harness.loop.enabled` to `false` in Postgres (simulating an operator), then re-seeded:

```
           key            | value | defaultValue | _version
--------------------------+-------+--------------+----------
 harness.loop.enabled     | false | false        |        2      ← operator's choice survived
 consultation.ocr.enabled | true  | false        |        1
```

The row was not touched — value still `false`, `_version` still 2. The untouched key stayed `true`.

### 5.4 The one-line disable updates the SEEDED row, and only it

This is the check that validates §2.3.

```
-- before --  {"key":"harness.loop.enabled","value":true,"sourceScope":"system","version":2}
-- PUT value=false with If-Match: "2" --
              {"key":"harness.loop.enabled","value":false,"scope":"system","version":3}
-- after --   {"key":"harness.loop.enabled","value":false,"sourceScope":"system","version":3}
```

And in the database afterwards:

```
 rows_for_key |                tenant                |             name             |    ns    | value | ver
--------------+--------------------------------------+------------------------------+----------+-------+-----
            1 | 50000000-0000-0000-0000-000000000000 | Consultation loop signalling | registry | false |   3
```

**Exactly one row**, updated in place. Had the seed used the SYSTEM tenant, a different
namespace, or a name that did not match `descriptor.label`, there would now be two rows for this
key — and the next boot would have refused to start.

### 5.5 Safety — a developer with no Temporal

Temporal, the worker **and** the harness were all stopped, with the loop gate left ON. Full
consultation lifecycle:

```
== NO-TEMPORAL-NO-HARNESS — 1. open consultation ==   OK  consultationId=019ff547-1c17-...
== 2. start recording ==                              HTTP 201  in 0.007380s
== 3. add work note ==                                HTTP 201  in 0.008650s
== 4. add case note ==                                HTTP 201  in 0.008688s
== 5. context persisted? ==                           context items persisted: 2
                                                        - WORKNOTE  019ff547-1c4a-...
                                                        - CASE_NOTE 019ff547-1c5a-...
== 6. stop recording ==                               HTTP 201  in 0.019956s
== 7. consultation still readable ==                  status: OPEN | id: 019ff547-1c17-...
== 8. close consultation ==                           HTTP 201  in 0.008921s

NO-TEMPORAL-NO-HARNESS: full lifecycle wall time 1s
```

Crucially, the signals were **attempted and swallowed** — this is not a pass by accident of the
gate being off. `.env.test` pins `LOG_LEVEL=error`, which hid the evidence on the first attempt;
re-run with `LOG_LEVEL=debug`:

```
warn  LoopContextSignalService  {"message":"Failed to signal loop of new context (best-effort)","consultationId":"019ff548-5840-…","contextItemId":"019ff548-587d-…"}
warn  LoopContextSignalService  {"message":"Failed to signal loop of new context (best-effort)","consultationId":"019ff548-5840-…","contextItemId":"019ff548-588e-…"}
warn  LoopContextSignalService  {"message":"Failed to signal loop consultation-ending (best-effort)","consultationId":"019ff548-5840-…"}
```

Three signals attempted, three failed, three swallowed, zero impact on the consultation. **The
safety requirement holds: the seed is safe to land.**

Minor observability wart noted, not fixed (out of scope): the warning's `"error"` field came
through empty, so an operator sees the failure but not its cause.

---

## 6. Known limitations — read these before calling the loop "working"

### 6.1 ⚠ `harness.loop.enabled` is the SIGNALLING gate. There is a second, independent gate.

The workflow starts and then immediately completes with `phase: "DISABLED"`, because
`ConsultationLoopWorkflow.run` short-circuits on its own pinned config:

```python
config = self._config
if config is None or not config.enabled:
    self._phase = "DISABLED"
    return self._result()
```

That `enabled` is **derived, never stored and never seeded**
(`packages/applications/src/services/consultation/loop/loop-config.service.ts:156`):

```ts
const enabled = agentConfigVersionId !== null || contextSchemaVersionId !== null;
```

It becomes true only when a tenant has **either**:

- a `DepartmentAgentVersion` for the department's default agent — written only by
  `DepartmentAgentService.writeLoopConfigVersionIfNeeded`, which no-ops unless the agent
  actually sets loop-config fields (`role`, `subscribedKinds`, `writeScope`, `goal`,
  `guardrailProfile`, `alwaysActions`, `neverActions`); **or**
- a servable `ConsultationContextSchemaVersion` — a default, `ENABLED`,
  `PUBLISHED`/`APPROVED` schema with a non-null `pinnedVersionNumber`.

**No seed creates either.** `07a-agent-golden-library.ts` seeds `DepartmentAgent` rows, but its
`AgentSeedRow` carries none of the seven loop-config fields, so no version row is ever written.

This is **deliberate**, not a gap in this ticket: TASK-654 K7 states "a consultation with no loop
configured behaves EXACTLY as it does today", and TASK-658 frames context schemas as
tenant-authored through the API/console (its only seed work was the RBAC grant).

**Therefore, precisely:**

| | Status after this ticket |
|---|---|
| The loop signalling plane | **Live on day 1** in every seeded environment |
| `ConsultationLoopWorkflow` starting per consultation | **Yes**, verified |
| The loop actually *doing* anything | **No**, until a tenant publishes a default context schema or sets loop-config fields on the department's default agent |

Seeding a default context schema was deliberately **not** done here. It would amount to defining
the platform's default clinical context taxonomy and arming real agent actions
(`livedoc.start`, `harness.finalize`) on every consultation in every fresh install — a product
decision well outside "turn the switch on", and one the two console surfaces
(TASK-666, TASK-667) exist to let tenants make. **It needs its own ticket and an owner decision.**

### 6.2 Real STT transcripts still never enter the cascade

`sttInternal.service.ts` emits only `TranscriptionCreated`, never `ContextAdded`
(see `docs/implementation/TASK-676-STT-Cascade-Bridge-Investigation/README.md`). So with the loop
enabled it reacts to **work notes, case notes and attachments — but not to transcripts**.

Do not read "enabled" as "E2 works".

### 6.3 `signalLoopCancel` has no production caller

The cancel leg exists end to end (service method, gateway method, harness route, workflow signal
handler) but nothing calls it. Pre-existing; noted, not fixed.

### 6.4 Stale comments

`apps/api/src/modules/consultation/consultation.controller.ts:179` and `:509` still describe the
gate as `HARNESS_LOOP_ENABLED`. Pre-existing TASK-679 leftovers; left alone as out of scope.

---

## 7. How to operate it

**Fresh clone / local dev** — `pnpm setup:dev` runs `RUN_SEED=all NODE_ENV=development pnpm db:all`
(`scripts/dev-setup.sh:111`), so the rows are created and the loop signalling plane comes up
enabled. Verified end to end in §5.

**Production / staging day-1 bootstrap** — the phase is **not** in
`SEED_PHASES_EXCLUDED_FROM_SAFE`, so `RUN_SEED=safe` seeds it too. Verified:

```
Seed mode: safe
Seeding consultation-gate Global Settings (2 platform rows, namespace='registry')...
  registry/harness.loop.enabled → true on create (default false; existing value preserved)
  registry/consultation.ocr.enabled → true on create (default false; existing value preserved)
```

**A bare `pnpm db:seed` with `RUN_SEED` unset seeds NOTHING** — `resolveSeedMode` returns `none`
and the seed opens no connection. That is pre-existing, deliberate TASK-616 behaviour
("permission is never inferred from an absent variable"), not something this ticket changes. Use
`RUN_SEED=safe` (or `all` in dev/test).

**Disabling, without a redeploy** — the gate is re-read on every signal:

```http
PUT /api/v1/admin/settings/registry/harness.loop.enabled
If-Match: "<version>"
Content-Type: application/json

{ "value": false }
```

`GLOBAL_ADMIN` only (`globalOnly: true` on the descriptor, plus `locked: true` on the row).
`If-Match` is mandatory once a row exists — omitting it is refused with 428, and a stale version
gets 412. Same for `consultation.ocr.enabled`. Verified in §5.4.

---

## 8. Gate evidence

Baseline measured on this worktree at `3e666e29c` **after** the build order in
`execution-plan.md` §1.1b (`pnpm install` → `db:generate` → database → domains → applications,
plus `@arcaai/json-schema-subset`, which is also required and is not listed there — without it
`applications` fails with three `TS2307`s).

| Gate | Baseline | After | Verdict |
|---|---|---|---|
| `pnpm --filter @arcaai/database build` | pass | pass | — |
| `pnpm --filter @arcaai/database test` | 1177 passed (47 files) | 1177 passed (47 files) | unchanged |
| `pnpm --filter @arcaai/applications build` | pass | pass | — |
| `pnpm --filter @arcaai/applications test` | 8927 passed / 4 skipped | 8936 passed / 4 skipped | **+9** = the new parity file |
| `pnpm api:build` | 10/10 successful | 10/10 successful | unchanged |
| `pnpm test:unit` | not measured pre-change | 1 failed (`env-sync`), 16851 passed | pre-existing, unrelated — see below |
| `pnpm lint` | 34/34 successful | 34/34 successful | my files 0 warnings |

### Actual output

```
$ pnpm --filter @arcaai/database test
 Test Files  47 passed (47)
      Tests  1177 passed (1177)

$ pnpm --filter @arcaai/applications test        # baseline, before the change
 Test Files  475 passed | 1 skipped (476)
      Tests  8927 passed | 4 skipped (8931)

$ pnpm exec vitest run …/consultation-gate-seed-parity.test.ts    # RED, before the seed existed
 Test Files  1 failed (1)
      Tests  6 failed | 3 passed (9)
Error: ENOENT: no such file or directory, open '…/seed/11c-consultation-gate-settings.ts'

$ pnpm exec vitest run …/consultation-gate-seed-parity.test.ts    # GREEN
 Test Files  1 passed (1)
      Tests  9 passed (9)

$ pnpm api:build
 Tasks:    10 successful, 10 total
  Time:    18.834s

$ pnpm test:unit
 Test Files  1 failed | 994 passed | 2 skipped (997)
      Tests  1 failed | 16851 passed | 4 skipped | 9 todo (16865)
```

The single `test:unit` failure is `scripts/__tests__/env-sync.test.ts`, asserting
`turbo.json#globalEnv entries | 160` vs a generated `158`.

**Honest caveat: `test:unit` was run only AFTER the change, so this is not a measured
before/after.** The attribution is by argument, not by baseline: `env-sync` reads the settings
descriptors, `turbo.json` and `.env.sample`, and never reads the seed tree
(`grep seed scripts/env-sync.mts` returns only an unrelated comment). This ticket adds no
descriptor and no env var — adding one would have contradicted TASK-679 — and the assertion that
fails is a count of `turbo.json#globalEnv` entries, which is untouched. It also matches the
known-pre-existing failure recorded for this branch point.

```
$ pnpm lint
 Tasks:    34 successful, 34 total

$ pnpm exec turbo run lint --filter=@arcaai/database --filter=@arcaai/applications --force
 Tasks:    9 successful, 9 total
@arcaai/applications:lint: ✖ 194 problems (0 errors, 194 warnings)   # all pre-existing
```

Forced (uncached) because the first `pnpm lint` replayed cache entries produced in a different
worktree. Grepping that forced run for the three changed files returns nothing — they contribute
zero warnings.

---

## 9. Change History

| Date | Change |
|---|---|
| 2026-08-12 | Ticket opened. TDD RED (6/9 failing) → seed authored → GREEN (9/9). Seed idempotency guard verified by deliberate violation. Live end-to-end proof on isolated test infra + an isolated Temporal on :7234: gate resolves ON through the running gateway, `ConsultationLoopWorkflow` starts from a real `context.added`, `consultation-ending` delivered via `recording/stop`. No-Temporal safety proven with the swallowed-signal warnings as evidence. One-line disable proven to update the seeded row in place (still exactly one row). All started infrastructure torn down. **Discovered and documented §6.1: `harness.loop.enabled` is only the signalling gate; the loop's own `enabled` is derived from tenant-authored config that no seed creates, so the workflow starts and immediately completes DISABLED on a fresh database.** Commits `1e3774cf1`, `86e0ed33a`. |
