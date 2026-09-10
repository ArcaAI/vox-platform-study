# TASK-941 — TASK-870 Residue

| | |
|---|---|
| **Status** | Pending — R1/R2 await an owner decision; R3/R4 are work-ready on a go |
| **Type** | refactor / docs |
| **Branch** | `dev-2.2` |
| **Base** | `0d7ed352f` (the TASK-870 close-out) |
| **Parent** | [TASK-870 Configuration Governance Program](../TASK-870-Configuration-Governance-Program/README.md) — Completed 2026-09-10; §Close-out carries the full 12-item disposition |
| **Owner decisions** | 2 open (R1, R2) — §4 |

## 1. Requirement Analysis

TASK-870 closed with twelve post-close owner items, eight of them resolved. This ticket is the
other four, lifted out so that archiving a Completed program cannot take them with it.

**None of these is leftover program work.** Two are decisions the program could not make for
itself, one is a coordination across two repositories, and one is a prose sweep. They are grouped
here because they share exactly one property — each was *recorded* rather than *done*, for a
stated reason — and not because they belong to one subsystem. Expect to run them as four
independent changes, in any order.

| Ref | TASK-870 item | Kind | Blocks anything? |
|---|---|---|---|
| **R1** | 3 | owner decision + a one-statement data step | no — the rows are inert |
| **R2** | 5 | owner decision (keep or drop a derived rule) | no — the rule is live and conservative |
| **R3** | 8 | two-repo coordination (code + `hope-v2-deployment`) | no — the fallback works |
| **R4** | 9 | documentation sweep, 76 mentions | no — prose only |

## 2. Current State Evaluation

Every claim below was verified by inspection on 2026-09-10, on `0d7ed352f`.

### R1 — five inert `AiRoutingPolicy` rows, and SQL that is written but not run

TASK-881 retired the `text.*` task keys. The seed no longer writes them and nothing resolves
them, but any database that was deployed before that still carries the rows. The soft-retire
statement exists, commented, in the wave-3a migration — and its own comment says why:

`packages/database/src/prisma/db_main/migrations/20260905192057_task_870_wave3a_schema_retirement/migration.sql:77-82`

```sql
-- TASK-881 — the five retired text task keys keep their AiRoutingPolicy rows on an existing database
-- (the seed no longer writes them; nothing resolves them). Soft-retire is an OWNER decision, so it is
-- recorded here and NOT run:
-- UPDATE "core"."AiRoutingPolicy"
--    SET "resourceStatus" = 'DELETED', "resourceStatusUpdatedAt" = now(), "_version" = "_version" + 1
--  WHERE "taskKey" IN ('text.live', 'text.finalize', 'text.test', 'text.live.fallback', 'text.finalize.fallback');
```

Two things make this a decision rather than a task. Changing data is never the program's call
(`02-database-prisma.md`: no `DROP`/`DELETE`/`TRUNCATE` without explicit approval, and this is the
soft-delete equivalent). And a *commented* statement in a committed migration is itself a small
liability: it reads as a pending action forever, so whichever way the decision goes, the comment
should stop saying "not run".

### R2 — a rule lane H derived from the owner's words, never confirmed

`assertBothDirectionsCovered` (`guardrail-availability/policy-catalogue.ts:278-291`) refuses a
guardrail selection that would leave one screening direction ungated:

```ts
export function assertBothDirectionsCovered(policies: GuardrailPolicySelectionSet): void {
  if (!hasEnabledPolicy(policies)) return;           // an empty selection inherits SYSTEM — untouched
  …
  const missing = (['inbound', 'outbound'] as const).filter((d) => !covered.has(d));
  if (missing.length > 0) throw new GuardrailPolicySelectionError(…);   // → 400
}
```

Lane H *derived* this from the owner's "every text-generation request before send and every
response after receive", flagged it at the wave close as a derived rule needing confirmation, and
it was never answered. It is conservative (it only ever refuses a narrower selection, and an empty
selection still inherits the platform set), so leaving it is safe — but an unconfirmed derived rule
is a guess that now has the force of a 400, which is exactly the thing worth resolving rather than
inheriting.

Callers: `guardrail-availability.service.ts`; covered by `__tests__/policy-catalogue.test.ts`.

### R3 — the legacy per-service tokens are a LIVE fallback, in two repositories

Owner decision D-D (2026-08-17) made `INTERNAL_ACCESS_TOKEN` the one token every outbound hop
presents, with the per-target secrets kept "only as the fallback for an environment that has not
been migrated yet". That fallback is genuinely consulted:

`apps/harness/src/harness/core/config.py:432-437`

```python
def peer_service_token(self, legacy: SecretStr) -> str:
    """Token to PRESENT on an outbound peer call: shared first, legacy fallback."""
    return first_real_secret(self.internal_access_token, legacy)
```

Three legacy fields survive — `text_service_token` (:468), `nlp_service_token` (:469),
`guardrail_service_token` (:474) — plus the generic `service_token` (:412), and there are
**eight call sites** passing one of them: `temporal/activities.py:272` (nlp), `:290` (text),
`:299`, `:391`, `main.py:71`, `api/endpoints/knowledge.py:112`,
`eval/inferential_corpus_eval.py:312`.

And the other repository still sets them: `hope-v2-deployment/deployment/k8s/**` carries
`GUARDRAIL_SERVICE_TOKEN` (2), `HARNESS_SERVICE_TOKEN` (4) and `HARNESS_INTERNAL_SERVICE_TOKEN`
(4). `TEXT_SERVICE_TOKEN` is not set there at all — which is why TASK-870's item 10 collapsed into
this one.

So this is not a code tidy. Deleting the fields before every overlay presents
`INTERNAL_ACCESS_TOKEN` first turns every internal hop into a 401 — the exact failure
`first_real_secret` was introduced to prevent (a `CHANGE_ME` sentinel is non-empty, so a plain
truthiness chain never reached the fallback).

### R4 — 76 stale `AiTaskDefault` mentions, across 44 files

TASK-881 removed the table, the service, the routes, the domain trio and the `models.*` descriptor
family. What remains is prose: comments and docs in the three Python services that still explain
behaviour in terms of a facade that no longer exists.

| Service | Mentions | Heaviest files |
|---|---|---|
| `apps/guardrail` | 38 | `core/dependencies.py` (6), `README.md` (6), `core/{tenant_config,config}.py` + `api/endpoints/medical.py` + `GUARDIAN_INTEGRATION.md` (3 each) |
| `apps/text` | 19 | `translation/sarvam.py` (3), then singles across `providers/*`, `core/config.py`, `api/endpoints/judge.py` |
| `apps/nlp` | 19 | `core/config.py`, `dependencies.py`, `schemas/classification.py`, `core/guard_model_reference.py` (2 each) |

No reader, no behaviour, no gate — which is precisely why nothing catches it and why it survived
the program. `pnpm env:python-dead` checks declared-vs-read env fields; it has nothing to say about
a stale noun in a comment.

**Where the hits are, checked before writing this:** 14 of the 44 files are tests, and **no hit
anywhere is a compared value** — `git grep` over `assert` / `==` / `in [` lines returns nothing, so
a replace cannot flip a test's truth value. Every occurrence is a docstring, a comment, or an
assertion FAILURE MESSAGE.

That makes the sweep safe but not mechanical, because some of those messages are guidance a
developer reads at the moment something breaks, and they currently point at a facade that no longer
exists. The clearest example is `apps/text/.../test_task799_config_surface.py:70-75`, whose failure
text tells you where each kind of value belongs — "a model in `AiTaskDefault`, capacity/hyperparameters
in `AiRuntimeProfile`" — and both of those were retired (TASK-881, TASK-862). A developer following
that advice today would look for two things that are gone. Repoint the guidance; do not merely
delete the noun.

## 3. Implementation Plan (on go)

Four independent changes. R3 and R4 need no decision and can start immediately; R1 and R2 wait on §4.

| Ref | Steps | Verification |
|---|---|---|
| **R1** | On "soft-retire": author a new migration carrying the `UPDATE` (never edit the committed one — `02-database-prisma.md`), prove it on a throwaway shadow with an empty `migrate diff`, and delete the commented block with a line saying it was executed in `<migration>`. On "leave inert": delete the commented block and say so, so it stops reading as pending | `prisma migrate diff` empty; the five rows report `resourceStatus = DELETED` on a synced dev DB |
| **R2** | On "keep": delete the flag note in TASK-886's README and leave code untouched. On "drop": remove `assertBothDirectionsCovered`, its call in `guardrail-availability.service.ts`, and its cases in `__tests__/policy-catalogue.test.ts` | `pnpm --filter @arcaai/applications test` green; a selection covering one direction behaves as decided |
| **R3** | 1. Audit `hope-v2-deployment/deployment/k8s/overlays/*` and confirm **every** deployable sets `INTERNAL_ACCESS_TOKEN`. 2. Only then: drop the three legacy fields, simplify `peer_service_token` to take no `legacy` argument, update the eight call sites, and retire the Vault policy paths. 3. A deployment-repo commit removing the three env names. Order is not negotiable — step 2 before step 1 is an outage | `harness:test` + `harness:typecheck`; `env:python-surface:check` + `env:sync:check` (the names leave `globalEnv`); `kustomize build` of the touched overlay; a live internal hop still authenticates |
| **R4** | Read each of the 44 files; repoint every explanatory mention to `AiRoutingPolicy.resolveDefault` (non-agent task defaults) or `Agent.modelId`. Failure messages get the same treatment — they are guidance, and two of them still route a developer to `AiTaskDefault` and `AiRuntimeProfile`, both retired | `pnpm {text,guardrail,nlp}:test` + `:lint` at baseline; `git grep -c AiTaskDefault -- apps/` reaches 0 outside deliberate historical notes |

No migration, schema change or route change in R2/R3/R4. R1's is a data statement only.

## 4. Owner Decisions (open)

| Id | Question | Recommendation |
|---|---|---|
| **OD-1 (R1)** | Soft-retire the five stale `text.*` `AiRoutingPolicy` rows, or leave them inert permanently? | **Soft-retire.** They are unreachable either way, so this is about the catalogue telling the truth: a platform admin listing routing policies currently sees five rows that no resolver can ever consult. Either way the commented block must go — a committed migration that describes an action it does not take is a standing invitation to run it by hand |
| **OD-2 (R2)** | Keep `assertBothDirectionsCovered` (a non-empty guardrail selection must gate BOTH directions, else 400), or drop it? | **Keep, and record it as confirmed.** It cannot weaken a gate — it only refuses a selection that would leave one direction unscreened, and an empty selection still inherits the platform set. The cost of keeping it is that a tenant cannot express "screen requests only"; if that is a configuration you want to allow, drop it instead. Worth one sentence from you either way, because right now its status is "nobody said no" |

## 5. Implementation Summary

Not started.

## 6. Change History

| Date | Change |
|---|---|
| 2026-09-10 | Filed from TASK-870's close-out at the owner's request, carrying the four residual items (TASK-870 items 3, 5, 8, 9) out of a Completed program. Every claim re-verified by inspection on `0d7ed352f`: R1's commented SQL located at `…_task_870_wave3a_schema_retirement/migration.sql:77-82`; R2's rule at `policy-catalogue.ts:278-291`; R3 measured at 3 legacy fields + 8 call sites in `apps/harness` and 3 env names still set across `hope-v2-deployment/deployment/k8s/**`; R4 measured at 76 mentions across 44 files, 14 of them tests — and no hit anywhere is a compared value (checked), so every one is prose, a docstring or an assertion failure message. No code changed. |
