# TASK-773 — Parallel Execution Model

How a team of agents delivers this ticket concurrently without corrupting each other's work or
each other's evidence. Companion to `README.md` (the plan); this file is the *how we run it*.

**Worktree:** `.claude/worktrees/task-773-svc-admin`, branch `worktree-task-773-svc-admin`.

> **Base-ref correction, recorded because it nearly cost the whole run.** `EnterWorktree` defaults
> to `worktree.baseRef: fresh` — it branched from `origin/dev`, which does **not** contain
> TASK-757/762/766/767. The entire foundation this ticket builds on (`serviceAccount/` services,
> the third `UnifiedAuthGuard` branch, the `svc:*` registry, the boot audits) lives only on
> `feat/loop`. Three agents launched into that worktree would have found no service-account code
> at all and produced confident nonsense. The branch was reset to `feat/loop` before any agent
> started. **Verify the base ref carries your dependencies before spawning anyone.**

---

## 1. The two rules that make this safe

### Rule 1 — One worktree, disjoint file ownership

Agents are NOT given a worktree each. Per-agent worktrees cost setup plus a merge step, and they
only pay for themselves when agents must write the *same* file. Here the work shards cleanly by
file, so a single shared worktree is faster and has no merge phase at all.

The invariant that replaces isolation: **no two concurrently-running agents may write the same
file.** Ownership is assigned up front (§3) and stated inside each agent's prompt, including an
explicit "do NOT touch X, another agent owns it right now" clause. Where two units of work need
the same file, they are placed in different waves rather than run together.

### Rule 2 — The mechanical verifier lands BEFORE the sharded sweep

Phase A2 is the security surface of this ticket: it makes 67 administration areas machine-reachable.
Sharding it across agents to go fast is exactly the setup where one controller silently gets the
wrong scope, or none.

So the order is inverted from the obvious one. **Boot audit H (A4) is written first**, against the
A1 fixture, and observed **RED** against all 67 undeclared controllers. Only then do the sweep
shards run, each turning part of it GREEN. The audit is the acceptance test for every shard, so a
sharding mistake fails the boot rather than shipping.

This is TDD at fleet level, and it is what earns the right to parallelize a security change:

```
A1 fixture (evidence)  →  A4 audit RED  →  6 shards in parallel  →  audit GREEN
```

Precedent for why this matters in this repo: TASK-757's *hand-transcribed* audit list silently
policed 63 of 65 controllers, and TASK-760's blast-radius table was incomplete twice. Derived
verification is the house answer to exactly this failure mode.

---

## 2. Model tiering

Applying the owner's tier table, with one standing amendment.

**Amendment — tier by blast radius, not only by mechanics.** A task whose *mechanics* are trivial
but whose *silent-error consequence* is severe goes up one tier. A1 is pure extraction (the table
says haiku) but a wrong row mis-scopes an administration route, so it runs on sonnet-5 at high
effort. Cheap mechanical work with a loud failure mode stays at its natural tier.

| Unit | Work | Tier | Effort | Why this tier |
|---|---|---|---|---|
| A1 | Extract controller→scope fixture from `276f96a32` | sonnet-5 | high | Extraction (→haiku) **tiered up**: a wrong row mis-scopes an admin route, and nothing downstream re-derives it. |
| A4 | Boot audit H + strengthen G | opus-5 | high | Security invariant over Nest metadata; must be right or the whole sweep is unverified. |
| A2×6 | Decorator sweep, ~11 controllers per shard | sonnet-5 | low | Mechanical edit, fully specified by the fixture, mechanically verified by A4. Cheapest tier that can follow a spec. |
| A5/A6 | CASL per-route assertion, reachability tests | sonnet-5 | medium | Standard test authoring against an established pattern. |
| B1 | OpenAPI export script | sonnet-5 | medium | Standard coding task. |
| B2 | Fidelity spike + GO/NO-GO | opus-5 | low | Analysis with a tradeoff and a decision attached. |
| C | Service-account credential + token lifecycle | opus-5 | high | Single-flight refresh, revocation-mid-flight retry, skew margin, redaction. Genuine concurrency design. |
| D1 | Codegen from cross-checked manifest | opus-5 | high | Novel, open-ended, two authoritative sources to reconcile. |
| D2 | `AdminResource` base | opus-5 | medium | Pagination + OCC + error-mapping semantics; small but load-bearing. |
| D3 | Run the generator | haiku-4-5 | default | Mechanical execution of a finished tool. |
| E1 | README / rule updates | sonnet-5 | medium | Drafting against known facts. |
| E3 | E2E spec | sonnet-5 | medium | Standard test authoring. |

---

## 3. File-ownership map

Ownership is exclusive **for the duration of a wave**. A file may change owner between waves.

| Owner | Files |
|---|---|
| **A1** | `apps/api/src/bootstrap/__tests__/fixtures/task-773-admin-scope-map.ts` (new) + its test (new) |
| **A4** | `apps/api/src/bootstrap/service-account-surface-audit.ts` + `apps/api/src/bootstrap/__tests__/service-account-surface-audit.test.ts` |
| **A2 shards** | Disjoint sets of `apps/api/src/modules/**/*.controller.ts` — ~11 controllers each, assigned by explicit file list, never by pattern |
| **B1/B2** | `apps/api/scripts/emit-openapi.ts` (new), `apps/api/package.json`, `openapi-fidelity.md` (new) |
| **C** | `packages/vox-node/src/core/service-account-token.ts` (new), `core/transport.ts`, `client.ts`, `core/redact.ts`, `core/index.ts` |
| **D1** | `packages/vox-node-codegen/**` (new package) |
| **D2/D3** | `packages/vox-node/src/resources/admin/**` (new) |

**Contended files, deliberately single-owner:**
- `apps/api/src/bootstrap/service-account-surface-audit.ts` — A3, A4 and A5 all target it, so ONE
  agent does all three rather than three agents racing one file.
- `apps/api/src/main.ts` — audit registration only; the last wave touches it, once.
- `docs/implementation/TASK-773-*/README.md` — the **orchestrator only**. Agents report findings
  back and the orchestrator records them; agents never write the ticket doc concurrently.

---

## 4. Waves

```
WAVE 0  (3 agents, no dependencies, zero shared files)          ← running
  A1  fixture extraction                     sonnet-5 / high
  B1+B2  OpenAPI export + fidelity spike     sonnet-5 / medium → opus for the call
  C   SDK credential + token lifecycle       opus-5 / high

WAVE 1  (needs A1)
  A4  audit H written against the fixture, observed RED         opus-5 / high

WAVE 2  (needs A4 RED; 6 agents in parallel)
  A2 shards 1-6, ~11 controllers each        sonnet-5 / low
  → audit H goes GREEN incrementally; a shard is DONE only when its slice passes

WAVE 3  (needs A2 GREEN)
  A3+A5  strengthen G to every-route form, per-route CASL   opus-5 / high   [audit file owner]
  A6  reachability tests per area                           sonnet-5 / medium
  D1  generator                                             opus-5 / high
  D2  AdminResource base                                    opus-5 / medium

WAVE 4
  D3 generate · D4 drift gate · E1 docs · E3 e2e · E2 changeset
```

C is on the critical path for the SDK half and depends on nothing in the API half, which is why it
starts in Wave 0 rather than waiting for the plane to open.

---

## 5. Prompt contract

Every agent prompt carries, without exception:

1. **The worktree path**, and "work ONLY there".
2. **Wire facts inline**, with source-file citations — verified before launch, so no agent burns
   context re-deriving what is already known, and none of them silently re-derives it *wrong*.
3. **Explicit file ownership**, including the negative list ("do NOT touch X — another agent owns
   it right now").
4. **The verify commands to run**, with instructions to find the working invocation rather than
   guess at one.
5. **A report-back contract naming specific numbers** — row counts, coverage percentages, test
   output. Numbers are checkable; "done" is not.
6. **Scope fences** — e.g. B2 measures Swagger coverage and is explicitly forbidden from
   *improving* it, because poor coverage is the finding.

---

## 6. Integration

- Each wave is verified by the orchestrator against the reported numbers before the next launches.
- Commits are per-unit, not per-wave, so a bad shard is revertible on its own.
- `pnpm --filter @arcaai/api test` + `pnpm api:build` + the vox-node four (`test typecheck lint
  build`) gate the wave boundaries.
- The gateway must BOOT — the audits are boot-time, so a green unit-test run proves less here than
  a successful start. That is the real gate for Phases A and the last one before E.
