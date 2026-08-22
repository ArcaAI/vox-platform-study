# TASK-794 — Admin-Console E2E Suite Triage

| Field | Value |
|---|---|
| **Status** | Review |
| **Type** | bugfix |
| **Branch** | `dev-2.2` |
| **Opened** | 2026-08-22 |
| **Surface** | `apps/admin-console/tests/e2e`, `apps/admin-console/playwright.config.ts`, `apps/api/src/workers` |
| **Trigger** | 27 failures in the 40-spec admin-console Playwright suite while verifying [TASK-787](../TASK-787-Sarvam-Tatva-Identity-Migration/README.md) / [TASK-788](../TASK-788-Domain-Rail-Navigation/README.md) |
| **Not** | [TASK-772](../TASK-772-E2E-Suite-Triage/README.md), which triaged the **API** suite (`test:e2e:managed`) — a different suite with different causes |

## Requirement Analysis

The admin-console e2e suite is the only place `color-contrast` runs in a real
browser (the ~50 `vitest-axe` files run in happy-dom, where axe skips it). It was
reported as "non-deterministic" and therefore unusable as a verification gate.
It is not non-deterministic. It has four distinct, diagnosable causes.

## Current State Evaluation

Baseline: **212 passed / 128 skipped / 27 failed**. All 27 diagnosed; **26 predate
this sprint's UI work.**

| # | Cause | Specs |
|---|---|---|
| 1 | Only the gateway was running; the skip-gate never probed past it | harness-workflows 6, pipeline-policy 4, workbench 3, transcription-jobs 1 |
| 2 | `VaultRotationWorkerService` crashed at boot | settings-rotate 2, schedulers 3, tenant-profile, settings, tenant-storage |
| 3 | Parallel-load contention against `next dev` | 33 timeouts (varies by run) |
| 4 | Ambiguous locators | consultations 1, dna-writing-styles 2 |
| 5 | **Ours** — TASK-788 changed nav scoping | workbench 1 |

### 1 — the skip-gate stopped at the gateway

`helpers/stack.ts` states specs "must skip — with an actionable message — when
[the stack] is not there." It probed the console and the gateway only. **The
gateway answers 200 while a service it PROXIES is down**, so specs driving
harness or STT failed on locators that were never going to resolve.

`pipeline-policy.spec.ts` had **no stack gate at all** — the only spec skipping
the house pattern, which is why it failed even on a bare checkout.

### 2 — a crashed worker, cascading

`VaultRotationWorkerService: ENOENT ./temp/vault.log`. `.env.dev` ships that path
and nothing creates it. Creating the file and restarting took those five specs
from **8 failures to 1**.

### 3 — the "non-determinism", explained

Playwright defaulted to `cpus/2` workers — **8 on this 16-core box** — against a
single `next dev` that compiles routes on first visit. Measured:

| Condition | Result |
|---|---|
| `tenants.spec.ts` in the full parallel run | 8 timeouts |
| `tenants.spec.ts` alone | **15/15 passed** |
| 4 worst specs, default workers | 33 timeouts |
| Same 4 specs, `--workers=2` | **52 passed / 1 failed** |

Two earlier runs of the same command giving 11-passed and 1-passed were this,
plus a stack that had been killed by a concurrent `next build` clobbering the
`.next` directory the dev server was serving from.

## Implementation Summary

Landed in `c38b76263`.

| Fix | Detail |
|---|---|
| `serviceAvailable()` / `serviceDownMessage()` in `helpers/stack.ts` | Probes STT/text/guardrail/NLP/harness directly; the four service-dependent specs now SKIP with an actionable message |
| `pipeline-policy.spec.ts` gated | Full house pattern + the harness service it drives |
| Worker noops on a missing audit log | It already noop'd on an UNSET path; now also on a MISSING one, **before** taking a leader lock it could not use. Test updated (it deliberately used a non-existent path) + a new test for the absence case |
| `workers: isCI ? 1 : 3` | `PLAYWRIGHT_WORKERS` overrides. CI keeps 1 against a production build |
| 3 locators disambiguated | `'Signed'` also matched `'Signed note'` (name matching is substring by default); three buttons named `Clear filters` on one page; a `getByText` union also matched Next's persistent `#__next-route-announcer__` |
| `workbench` nav test rewritten **and moved** | TASK-788 scopes the sidebar to the active domain. Moved to `app-shell.spec.ts` — gating a nav/IA test behind the harness service would silently drop the coverage guarding that change |

**Result: 293 passed / 50 skipped / 11 failed** (from 212 / 128 / 27).

## The remaining 11 — cleared 2026-08-22 (`08337beb5`)

Run against a live stack. **27 → 1**, and the one left passed 11/11 in isolation
(flaky, not a defect). Every fix removed a cause; none relaxed an assertion.

| Was failing | Real cause | Fix |
|---|---|---|
| `queues` ×5 | **The fixture leaked** — `cleanupQueueFixture` removed jobs by id, but the fixture's own `Worker` moves them to completed/failed and `findEmptyQueue` counts those states. Each run permanently burned one of five candidate queues until none was empty | Cleanup drains every counted state. Safe because `findEmptyQueue` verified the queue EMPTY at acquisition, so anything left is the fixture's. Proven by **three consecutive 11/11 runs** |
| `monitoring` ×1 | The spec mocked `**/api/hope/health/services`, but **TASK-759 moved it to `admin/health/services`**. The mock never matched, so the test asserted against the real response | Corrected the route pattern |
| `departments` ×1 | Hardcoded **"Cardiology"**, which the seed defines only as a PROMPT TEMPLATE and never as a Department — it could not pass against any seeded database | Derives the target from the rendered hierarchy |
| `tenant-storage` ×1 | Same class — hardcoded the **"Audio"** purpose, which no seeded bucket carries, so the facet option never rendered and the click timed out | Derives the purpose from the facet |
| `account` ×1 | Asserted the admin-locked badge unconditionally, though it renders only when the tenant sets `preferences.transcriptionModeLocked` | Asks the API: *not configured* SKIPS with an actionable message, *configured but not rendered* still FAILS |
| `settings-rotate` ×2 | The Vault audit-log crash (cause 2 above) | Already fixed; confirmed passing |

### Worker count — the measurement that settled it

The local default drops from 3 to **1**, matching CI:

| Workers | Timeouts, same suite |
|---|---|
| Playwright default (~8 on 16 cores) | 33 |
| 3 | 6 |
| 2 | 4 |
| **1** | **0** |

Raising the per-test budget to 45s did **not** help — that is the tell. The
constraint is contention on the single `next dev` process, not test duration, so
the budget stays at 30s and the parallelism comes down. `PLAYWRIGHT_WORKERS`
overrides when you know the specs you are running are light.

**Final: 302 passed / 51 skipped / 1 flaky** (from 212 / 128 / 27).

### Not attempted: running against a production build

`next start` sets `NODE_ENV=production`, and this repo's contract is that
production reads **no env file — host env only**. `ADMIN_SESSION_SECRET` is
therefore unset and login fails. That is the same blocker as the CI job's missing
`CI_ADMIN_SESSION_SECRET`, and it is why the local suite runs against `next dev`
at one worker instead.

## Two traps worth carrying forward

1. **Never run `next build` while `next dev` serves the same app** — it clobbers
   `.next` and kills the dev server. This is what made the suite look flaky.
2. **`packages/ui` must be rebuilt for the console to see component changes** —
   the barrel export resolves to `dist/`, not source. A stale `dist` made an
   already-fixed contrast violation appear to persist.

Both cost real time during TASK-787 verification.

## Change History

| Date | Change |
|---|---|
| 2026-08-22 | **Renumbered TASK-789 → TASK-794** — `TASK-789` was taken by a concurrent session (`TASK-789-Agentic-Loop-Coherence-Review`, committed in `6b066dd0f` alongside 790–793) between this ticket being written and committed. Caught immediately after; the fix commit `c38b76263` predates the collision and its message still says "TASK-789" for this work — noted here rather than rewritten, since the history is shared. |
| 2026-08-22 | Opened during TASK-787/788 verification. All 27 failures diagnosed, 16 fixed, four root causes recorded. 26 of 27 predate this sprint's UI work; the one that did not was TASK-788's nav scoping. Suite 212/128/27 → 293/50/11. Status → Review. |
| 2026-08-22 | **The remaining 11 cleared (`08337beb5`).** All were causes, not flakiness: a leaking queue fixture that permanently burned its own candidate queues, a route mock stale since TASK-759, two tests hardcoding seed values the seed never creates ("Cardiology" as a Department, an "Audio" bucket purpose), and one asserting tenant config it could not create. Local worker default dropped 3 → 1 on measured evidence (33/6/4/0 timeouts at ~8/3/2/1 workers; a 45s budget did not help, proving contention rather than duration). Suite **212/128/27 → 302/51/1**, the one remainder passing 11/11 in isolation. |
