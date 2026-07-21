# TASK-539 — Continuous Quality Re-Assessment Program

| | |
|---|---|
| **Status** | In Progress (Phase 0 baseline COMPLETE; cycle 1 defined, gated on owner actions below) |
| **Type** | assessment / research (standing program, not a one-shot ticket) |
| **Program** | Release Readiness (TASK-536 comments · TASK-537 docs · TASK-538 traceability · TASK-539 quality) |
| **Execution agents** | Fable 5, reasoning effort **xhigh** (assessments & synthesis); deep-research fan-out for SOTA research |
| **Created** | 2026-07-21 |
| **Ticket number** | Provisional — next after TASK-535; confirm before merge |

## Requirement Analysis

A standing program that repeatedly re-evaluates the **quality, completion, and performance** of all implementations using Fable 5 at xhigh effort, and turns findings into: (1) detailed findings documents, (2) researched SOTA best-practice documents, (3) concrete implementation/fix/improvement plans (new TASK tickets). Continues the SOTA-Track practice as a structured cycle.

## Assessment rubric (applied to every subsystem, every cycle)

| Dimension | Questions | Evidence required |
|---|---|---|
| **Correctness** | Does it do what the ticket/spec claims? Edge cases? Concurrency/OCC? Tenancy posture (404-over-403)? | Failing-scenario analysis, targeted test runs, adversarially-verified findings |
| **Completeness** | Ticket tails done? Env-gated paths exercised? Admitted gaps closed? | Ticket README cross-check, gap list with status |
| **Performance** | Latency/throughput hot paths, N+1s, streaming backpressure, model-serving efficiency | Measured evidence where feasible; static analysis where not |
| **Security & PHI** | AuthZ boundaries, secret handling, PHI exposure, injection | Boundary tests, config review |
| **Test posture** | Coverage shape (unit-only vs e2e-backed), flake risk, hermeticity | Suite inventory vs TASK-538 matrix |
| **SOTA delta** | What would best-in-class do differently? | Cited research |

Scoring: per dimension `strong / adequate / at-risk / deficient` + one-line justification with evidence pointers. **Program doctrine (from the Phase-0 baseline): "Review" status means "statically green, runtime-unproven"** — every assessment MUST include a runtime-evidence section, because the entire TASK-523..535 wave deferred exactly that.

## Cycle structure (repeatable)

Artifacts live under `docs/implementation/SOTA-Track/`:
1. **Scope selection** — 2-4 subsystems from the risk-ranked queue (re-ranked each cycle). Off-cycle triggers: big merge lands, RC cuts, TASK-538 flags a coverage hole.
2. **Deep assessment** (Fable 5 xhigh, 1 agent per subsystem + adversarial verifiers): rubric applied; every material finding independently refuted-or-confirmed. Output: `SOTA-Track/assessment-<subsystem>-<date>.md` with severity-ranked findings, evidence, failure scenario, remediation size.
3. **SOTA research** (deep-research fan-out per confirmed gap): best practices with citations + HOPE-applicability (multi-tenant PHI, on-prem/k3s, local + cloud models). Output: `SOTA-Track/research-<topic>-<date>.md`. Build on, don't duplicate: prompt caching, critique-fed regen, negation, evidence links, keyterm biasing, NS-hurts-ASR.
4. **Planning** — accepted findings become `TASK-54x+` tickets; small fixes batch into a defect-clearance ticket (precedent: TASK-523).

Living documents: `SOTA-Track/findings-register.md` (every confirmed finding, status, owning ticket) and `SOTA-Track/assessment-queue.md` (risk ranking, re-scored per cycle). Cadence: one full cycle before first release cut, then one per milestone.

## Current State Evaluation — Phase-0 baseline (2026-07-21, Fable-5-xhigh agent, workflow `wf_e0632a48-a69`)

**Headline:** the TASK-523..535 agentic-platform program is essentially **code-complete but almost entirely runtime-unverified**. Status roll-up: 2 Completed · 9 Review · 1 In Progress (533, sub-scope B) · 1 Pending (534 — the E2E gate everything defers to). Static gates are green at record levels (~16.8k TS unit tests, harness 935, stt-v2 2455, admin-console 1081), so the dominant risk is **runtime correctness + E2E coverage, not code quality**. ~65 authored-but-unexecuted API e2e specs await TASK-534.

**Top risk-ranked assessment targets (P0 first):**
1. **Config plane** (TASK-524/525/526) — largest never-runtime-verified surface: migration not applied to test DB, no Vault-live round-trip for `encryptedApiKey`, no live-DB boot, BYO azure/bedrock→SMR path never exercised end-to-end.
2. **Harness agentic loop** (TASK-533) — D-22 segment→citation chain never proven on a live streamed consultation; console-toggle-without-redeploy unproven; 3 of 6 `agentic.context` knobs resolve but govern nothing until 533-B3/B4; settings convergence is eventual-only (45s cron; `ResourceUpdated` broadcast has **zero subscribers** — `settings-registry-write.service.ts:117`).
3. **E2E debt** (TASK-534) — highest-leverage single action: converts 9 Review tickets' claims into evidence in one run. Pre-flight: `lsof -i :8868` (known port collision), test infra up, apply S3-enum + task_524 migrations to test DB.
4. **Admin-console governance wave** — 81 uncommitted paths; several screens built under design WAIVERS with no Figma reference and no headed-browser pass (526 explicitly; 528's authenticated hub never driven).
5. **stt-v2 segment producers** — contract-locked but never produced rows in a live streamed consultation; S3 enum migration dev-only.
6. **Security/tenancy governance (OD-2)** — five safety toggles force-locked to global-admin with SYSTEM overlay; blast-radius query ran on **dev only**, production run + tenant comms outstanding.
7. **Model lifecycle/retention** (529/530/535) — VRAM probe never run on GPU (pynvml extra omitted); LM Studio `ttl` + Ollama `keep_alive` live behavior unverified; OD-5 600s default awaits sign-off.
8. **Clinical eval / golden set** — CI gate still `allow_failure: true`; 18 synthetic cases vs spec'd N≥132; SME literally "unassigned" — blocks every accuracy claim; process problem, not engineering.
9. **MiniCheck/GGUF gate wiring** (P2) — `_make_llama_logit_fn` (ctypes + `llama_cpp._internals`, 2 mirrored sites) has zero real coverage; breaks on llama-cpp-python upgrade.
10. **Dormant-feature enablement matrix** (533-C, P2) — large shipped-but-OFF inventory gated on the hardware-tier decision; own cycle once decided.

**Working-tree findings needing owner attention:**
- **OD-7 recurred**: 185 uncommitted paths (81 admin-console, 34 applications, 12 harness, 10 api, 9 stt-v2, …).
- **17 unstaged DELETIONS of `docs/research/security/*`** — the entire prior security-audit corpus; looks accidental/unratified; decide commit-or-restore explicitly.
- Unstaged `.env.dev` modification; untracked `.mcp.json`.

**Open owner decisions (8):** OD-7 commit checkpoint · OD-2 prod blast-radius + comms · the multi-ticket runtime-verification pass · golden-set SME assignment · hardware-tier selection · llama_cpp `_internals` rewrite decision · OD-5 retention-default sign-off · security-report deletion ratification.

**Quick wins identified:** sys-event subscriber to invalidate the AppSettingsService snapshot (closes the 45s staleness, ~one-liner) · add the `pynvml` optional extra (one line) · re-run `gen:entity:check`/`gen:factory:check` to confirm the schema-coverage gates went green (523 §9.8 item 3) · fix the recorded black drift in one stt-v2 test · replace the NUL byte at `live-documentation.service.ts:1424` (ripgrep silently skips the file).

**Cycle 2+ seeds:** TASK-499 SAML — the real signed-assertion tampered/expired/replayed/XSW matrix was never built (top security-dimension candidate outside the current program).

## Implementation Plan

### Phase 0 — Baseline ✅ COMPLETE (2026-07-21)
Risk queue + owner-decision register above; full report in workflow `wf_e0632a48-a69` output. **Cycle 1 OPENED 2026-07-21**: `SOTA-Track/findings-register.md` (F-001..F-021) and `SOTA-Track/assessment-queue.md` materialized; step 0 (commit checkpoint) done at `c6c44de2`; F-001/002/003 fixed by TASK-541 (pending e2e re-verification); next queue item: TASK-534 E2E execution.

### Phase 1 — Cycle 1 (first release gate; order per baseline)
0. **Owner gate:** commit checkpoint (OD-7) incl. explicit ratify-or-restore of the security-report deletions — every assessment before this is against unlanded work.
1. **TASK-534 E2E execution** as the opening deep assessment (with the pre-flight list above).
2. **Config-plane runtime assessment** — live-DB boot, Vault-Transit round-trip, BYO override live, per-service effective-config `source` diagnostics.
3. **Harness loop runtime assessment** — one live streamed consultation proving segment→citation; toggle-without-redeploy for D-23/24/26; replay-fixture re-verification.
4. **Admin-console headed-browser sweep** of the waiver-built screens + axe on live DOM + retired-route redirect checks.
5. **Governance/security** — affected-tenants.sql on production, OD-2 comms, cross-tenant suite re-run.
6. **Retention/VRAM on a GPU host** (env-gated live-engine suite; LM Studio ttl + Ollama keep_alive acceptance).
7. **Clinical-eval process** — SME assignment, eval-gate hard-fail preconditions.
Plus: land the quick-wins list as a small defect-clearance ticket; regression-check a sample of the TASK-505 review-cycle fixes (19+12+16 findings).

### Phase 2 — Steady state
Repeat cycles per cadence; maintain the two living documents; dormant-feature enablement matrix runs as its own measurement-gated cycle after the hardware-tier decision; TASK-499 SAML assertion matrix enters cycle 2.

### Interaction with the other workstreams
- TASK-538's SOTA backlog merges into this program's research/planning track (single backlog).
- TASK-537's rebuilt docs are assessment inputs; assessment findings flag doc drift back to its checker.
- TASK-536's TODO harvest feeds the findings register (the auth token-revocation/HIPAA TODOs are findings #1 and #2 of the register).

### Verification criteria (per cycle)
- [ ] Every published finding adversarially verified with evidence pointers
- [ ] Every assessment includes a runtime-evidence section (doctrine above)
- [ ] Research docs cite sources + HOPE-applicability
- [ ] Accepted findings have owning tickets; register + queue updated
- [ ] Owner sign-off recorded per cycle

## Implementation Summary

_(cycle records accumulate here)_

### Findings-register seeds — stale E2E specs (TASK-534 gate, pre-cycle-1)

Carry these into `findings-register.md` when it is materialized at cycle-1 start. All four were found by pulling one thread: a single stale `beforeAll` in `apps/api/tests/e2e/authorization.spec.ts`.

| # | Finding | Evidence | Status |
|---|---|---|---|
| S-1 | The spec's `beforeAll` asserted `service_account` could log in interactively, contradicting TASK-430 (commit `c8850f4f`), which made service accounts API-key-only principals (`auth.controller.ts` throws `UnauthorizedException('Service accounts cannot sign in interactively')`; locked by `auth.service-account.task430.test.ts`). The stale `beforeAll` failed and cascaded into every test in the file. | Verified against a running test API. | **Fixed** — the principal now authenticates with `SEEDED_API_KEY_SERVICE_ACCOUNT` (new export in `tests/helpers/e2e.helper.ts`). |
| S-2 | The same spec targeted three RBAC routes that **do not exist**: `GET /rbac/permissions/effective`, `POST /rbac/permissions/check-bulk`, `POST /rbac/permissions/check`. The real controller is `@Controller('rbac/check')` → `rbac/check`, `rbac/check/bulk`, `rbac/check/my-permissions`. Every assertion behind them sat inside `if (status === 200)`, so ~9 tests passed **vacuously** against a 404. | `curl` probe returned 404; no `permissions/effective` match anywhere in `apps/api/src`. | **Fixed** — routes repointed, all status-guards replaced with hard assertions. Non-vacuity mutation-proven. |
| S-2a | Surfaced by fixing S-2: `getMyPermissions` collapses multi-action CASL rules into a comma-joined string (`{ action: 'read,list', subject: 'Consultation' }`). The spec's exact-equality matching (`p.action === 'read'`) misses **every** multi-action rule — so even once repointed, the assertions would have been wrong-but-green. | Live probe: nurse returns `"action":"read,list"` for Consultation. | **Fixed** spec-side via a `hasPermission()` helper that splits on `,`. **Open design question:** the API should arguably return `string[]`; the joined form is a trap for every consumer, not just this spec. |
| S-3 | **API-key authentication was entirely broken platform-wide** — all 9 seeded keys returned 401. **Root cause:** `ApiKey` was in `TENANT_SCOPED_MODELS`, but API-key auth must read that table by `keyHash` *before* any principal — and therefore any tenant — exists. Inside an HTTP request CLS is active but empty, giving `tenantId === undefined` **and** `isSuperAdmin() === false` — the exact combination `makeReadHandler` throws on ([tenant-scope.ts:379](packages/database/src/extensions/tenant-scope.ts:379)). `getByKeyHash`'s bare `catch { return null }` then converted that infrastructure fault into a credential rejection. Chicken-and-egg: a model read *in order to authenticate* can never carry tenant context. `User`/`Tenant` are unscoped for exactly this reason — which is why password login worked while API keys did not. | Environment ruled out (`ps eww`: NODE_ENV=test + correct pepper; `lsof`: test DB :5433). Pepper ruled out by a discriminating experiment: a key created **through the API's own write path** stored `HMAC(pepper, raw)` correctly **and still 401'd**. Then reproduced directly: no provider → FOUND; `tenantId=undef, super=F` → `THROWS: TenantScope: tenant context required for model ApiKey operation findFirst`; `super=T` → FOUND. | **Fixed** — `ApiKey` moved to `INTENTIONALLY_UNSCOPED` (following the `TenantEntitlement` pre-auth-throttler precedent), `getByKeyHash` now returns `null` only for `DataNotFoundException` and rethrows+logs anything else. |

**Isolation argument for unscoping `ApiKey`** (reviewed before the change): `apikey.service.ts` already enforces tenancy independently on every read path — list paths go through `buildTenantWhere`, `fetchAllByTenantId` rejects a foreign `tenantId` unless GLOBAL_ADMIN (TASK-305 D.5.2 / audit M-1, added precisely to stop cross-tenant key enumeration), and every `findById` is followed by `assertKeyAccess`. The only unguarded read is `getByKeyHash` — the authentication lookup itself, which matches on a unique cryptographically random secret and whose result *establishes* the tenant context.

**Verification (2026-07-21, live test API):**

| Check | Result |
|---|---|
| `authorization.spec.ts` + `auth-guard-behavior.spec.ts` | **50 passed, 0 skipped** (previously: 8 failing + ~9 vacuous + 4 silently skipped) |
| Valid seeded keys (SDK_DOCTOR, SERVICE_ACCOUNT) | 200 |
| Revoked / expired / garbage keys | 401 (negative controls hold) |
| Cross-tenant isolation | tenant_admin sees only its own 7 of 9 keys; explicit foreign `tenantId` → 400 |
| `@arcaai/database` · `@arcaai/applications` · `@arcaai/api` unit suites | 846 · 6649 · 2389 passed |

**Class-level lessons for the TASK-534 pre-flight:**
1. The ~65 authored-but-unexecuted e2e specs must be audited for *staleness* — routes and auth flows that shipped away underneath them — not merely executed.
2. **Grep the suite for `if (…status() === 200)` and `test.skip()` before trusting any pass count.** All four findings hid behind those two constructs. A lint rule or review gate banning bare status-guards around e2e assertions would have caught every one.
3. S-3 is the cautionary case: a skip-on-probe pattern (`apiKeyWorks = …; if (!apiKeyWorks) test.skip()`) masked a **total outage of an authentication mechanism** while reporting green. Probes must assert or be `fixme`, never silently skip — `auth-guard-behavior.spec.ts` has been converted accordingly, with a comment forbidding reintroduction.
4. Any model that must be read *to authenticate* cannot be tenant-scoped. Worth a one-off audit of `TENANT_SCOPED_MODELS` against every pre-auth read path (the throttler and API-key lookups are the two known cases).

## Change History

- 2026-07-21 — Program created; Phase-0 baseline launched.
- 2026-07-21 — Phase 0 complete (Fable-5-xhigh baseline). Risk queue, owner-decision register, quick wins, and cycle-1 order recorded; "Review = runtime-unproven" doctrine adopted; security-report deletion + OD-7 recurrence flagged to owner.
- 2026-07-21 — Findings-register seeds S-1, S-2, S-2a, S-3 recorded and **all fixed** under the TASK-534 E2E gate. S-3 was a live platform defect, not test staleness: API-key authentication was broken for every key because `ApiKey` was tenant-scoped despite being read pre-auth. Fix follows the existing `TenantEntitlement` precedent; isolation re-verified live. One open design question carried forward (S-2a: `my-permissions` should return `action: string[]`).
