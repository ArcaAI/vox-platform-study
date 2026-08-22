# TASK-789 — Admin-Console E2E Suite Triage

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

## Remaining 11 — all environmental, none product defects

| Spec | Needs |
|---|---|
| `queues` ×5 | An empty BullMQ queue. The fixture says so itself: *"No empty BullMQ queue is available for the queues E2E fixture"* |
| `settings-rotate` ×2, `tenant-storage` ×1 | Vault rotation + MinIO round-trips slower than the 30s budget |
| `account`, `departments`, `monitoring` | Seeded data the dev DB lacks — a locked transcription mode, a seeded root department, an unhealthy service probe |

To clear these, run against the full stack (`pnpm stack:dev`) with a seeded DB
rather than gateway + console alone.

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
| 2026-08-22 | Opened during TASK-787/788 verification. All 27 failures diagnosed, 16 fixed, four root causes recorded. 26 of 27 predate this sprint's UI work; the one that did not was TASK-788's nav scoping. Suite 212/128/27 → 293/50/11. Status → Review. |
