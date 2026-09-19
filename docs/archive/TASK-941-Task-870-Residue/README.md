# TASK-941 — TASK-870 Residue

| | |
|---|---|
| **Status** | **Completed** 2026-09-10 — all four done; owner answered R1/R2 and asked for R3/R4 |
| **Type** | refactor / docs |
| **Branch** | `dev-2.2` |
| **Base** | `0d7ed352f` (the TASK-870 close-out) |
| **Parent** | [TASK-870 Configuration Governance Program](../TASK-870-Configuration-Governance-Program/README.md) — Completed 2026-09-10; §Close-out carries the full 12-item disposition |
| **Owner decisions** | 2, both answered 2026-09-10: R1 soft-retire, R2 keep-as-confirmed — §4 |

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

All four landed. Owner answers (2026-09-10): **R1 soft-retire**, **R2 keep as confirmed**,
**R3 and R4 do them**.

| Ref | Commit | Outcome |
|---|---|---|
| R2, R3 | `99aa2103d` | the rule confirmed in place; three per-target tokens retired |
| R4 | `90daf0b04` | 72 mentions repointed, 4 kept as history |
| R1 | (this commit) | `20260910053048_task_941_soft_retire_stale_text_routing_rows` |

### R1 — soft-retire, proven on a shadow

Authored in a NEW migration (never by editing the committed one), against a throwaway
`hope_shadow` with all 39 ledger entries replayed, per `02-database-prisma.md`:

- two `text.*` rows seeded `ENABLED` plus a `guardrail.validate` control → after apply the
  two are `DELETED` at `_version` 2 with `resourceStatusUpdatedAt` stamped, and the control
  is untouched at `_version` 1;
- re-running the statement returns **`UPDATE 0`** — idempotent by construction, because it
  excludes rows already `DELETED`, so a replay cannot double-bump `_version`;
- `prisma migrate diff --from-config-datasource --to-schema` printed **"This is an empty
  migration."** — no schema drift;
- shadow dropped.

**No local data change was needed**: the dev DB carries none of the five keys (it was reset
2026-09-06 and the seed stopped writing them), so this migration exists for environments
deployed before TASK-881.

**The commented original is deliberately NOT deleted**, which reverses this ticket's own plan
step. `02-database-prisma.md` forbids editing a committed migration, and Prisma stores a
SHA-256 of each in `_prisma_migrations`. I measured the actual behaviour rather than assuming
it: on Prisma 7 **neither `migrate deploy` nor `migrate status` flags a comment-only edit** to
an applied migration, so the hazard I had assumed is latent, not immediate. That is a reason
to respect a categorical rule rather than to test it for a cosmetic gain — so the block stays,
its sentence ("recorded here and NOT run") stays true of that file, and the execution is
recorded in `docs/operations/deprecation-register.md` §"Data retirements applied by migration",
which is where a reader looks. **If you would rather the comment go, say so — it is a
one-line change and the measurement says it is safe today.**

### R2 — confirmed, zero code change

`assertBothDirectionsCovered` stays exactly as shipped. The confirmation is recorded on the
function's own docblock so the rule and its authority live together rather than the authority
living only in a ticket, and TASK-886's H6 handoff row is closed.

### R3 — smaller and safer than this ticket projected

Two scope corrections, both from checking rather than trusting §2:

1. **`service_token` is NOT retirable and was excluded.** §2 grouped it with the three
   per-target fields. It is harness's own INBOUND guard (`accepted_service_tokens`) *and* the
   token the api_client presents to apps/api, and the cluster still sets
   `HARNESS_SERVICE_TOKEN`. Deleting it would break inbound auth. Only the three per-TARGET
   copies went; `peer_service_token`'s parameter became optional rather than being removed.
2. **No deployment-repo commit was needed.** §2 projected one. That repo sets none of the
   three names — `HARNESS_{TEXT,NLP,GUARDRAIL}_SERVICE_TOKEN` appear in zero manifests — and
   they were empty-valued in `.env.dev`, while all three targets accept the shared token. So
   `first_real_secret(shared, legacy)` already returned the shared token at every site and the
   removal is behaviour-neutral.

Also caught by reading the generated output: the tombstone comment sat contiguous with the
next field, and `python-env-surface.py` harvests the preceding `#` block as a field's
DESCRIPTION — so it was about to ship as `guardrail_base_url`'s documentation in an
operator-facing `.env.sample`. A blank line separates them, with a comment saying why it is
load-bearing.

### R4 — not the pure prose sweep §2 described

Two corrections, both found by reading the hits:

1. **Some are user-visible.** `medical.py` returned `"provider": "AiTaskDefault (tenant →
   SYSTEM)"` as a VALUE in its policy-report response; four `dependencies.py` HTTP 503
   `detail` strings and two Sarvam errors named it in operator-ACTIONABLE guidance
   ("configure an AiTaskDefault for the translate task"). No test asserts any of them
   (checked), so repointing was safe — and it fixes an operator-facing surface, not prose.
2. **The successor differs by service.** guardrail and nlp are non-agent tasks →
   `AiRoutingPolicy` (28 files, mechanical). `apps/text` is agent-first since TASK-876, and
   its provider adapters genuinely do not know which mechanism chose the model — they receive
   it on the request — so those say "the gateway's resolved selection", while its judge and
   translation paths say `AiRoutingPolicy`. 17 hand edits. A single blanket rename would have
   been wrong in 11 places.

**Scope stated, not silently narrowed.** TASK-870 item 9 scoped R4 to
`apps/{text,guardrail,nlp}`, and that is what was swept. The same staleness exists in
**`apps/api` and the generated `openapi.json` — 242 further mentions**, several of them in
live comments (`text-proxy.controller.ts` ×4, `ai-inference.controller.ts` ×2,
`ai-routing-policy-admin.controller.ts` ×2) plus one `@ApiProperty` description that ships
in the public OpenAPI document ("absorbed from `AiTaskDefault.configJson`"). Those are
deliberately out of this ticket and are now **[TASK-942](../TASK-942-AiTaskDefault-Prose-Retirement/README.md)**.

**Two corrections to this paragraph, found while filing that ticket.** The count above is the
`apps/api` subset only — the TypeScript total is **238 hits across 134 files**, because
`packages/` carries 215 more. And I recommended fixing the OpenAPI one FIRST; on reading it,
it says "absorbed from `AiTaskDefault.configJson`", which is PROVENANCE of exactly the shape
R4 deliberately kept in guardrail, so it should probably not be changed at all. TASK-942 puts
that to the owner as its OD-1 and prioritises the 14 `apps/api` comments instead — those are
the ones that describe current behaviour through a dropped table. Note also
`apps/harness/.../test_task881_judge_selection_source.py`, which asserts
`"AiTaskDefault" not in sql` — that name must STAY, because there it is the assertion.

Four hits kept as accurate HISTORY rather than stale description (`tenant_config.py:8`,
`:308`, `:325`, `test_tenant_config.py:597`) — rewriting those deletes the record of the
migration instead of completing it. Three sentences also named `AiRuntimeProfile`, removed by
TASK-862; correcting half a two-item list would leave a newly misleading sentence, so those
became `Agent.parameters` in the same edit.

### One self-cleaning follow-on inside R3

`scripts/generate-env-file.sh`'s `_SUPERSEDED_KEYS` held exactly the three retired token
names, to blank them rather than write `CHANGE_ME`. With the pydantic fields gone the names
no longer appear in any `.env.sample`, so those entries matched nothing — dead members of a
hand-maintained list beside a generated one, which is the precise shape of the
`_CARRY_FORWARD_KEYS` drift TASK-870's change history records. The array is now declared and
EMPTY rather than deleted, because `env-sync.test.ts` reads it by name when it proves every
declared secret is classified; deleting it would break that check instead of simplifying it.
`shellcheck` clean, `bash -n` clean, env-sync suite 52/52.

### Verification

```
R1  shadow: 2 rows ENABLED→DELETED at _version 2, control row untouched
    re-run: UPDATE 0 (idempotent) · migrate diff: "This is an empty migration."
R2  guardrail-availability 39/39
R3  harness 2329 passed · harness:typecheck 150 files · harness:lint clean
    env:python-surface:check OK (350 names) · env:sync:check OK (497 globalEnv)
    env:python-dead OK (360 fields, every one read)
R4  text 1664 passed/4 skipped · guardrail 520 passed · nlp 657 passed
    lint: all three "All checks passed" · typecheck: 81 / 45 / 64 files clean
```

**Two pre-existing failures recorded, neither caused here.** `nlp:test` fails
`test_metrics_endpoint_task636` (×2, `/metrics` 404) — proved pre-existing by stashing and
re-running: identical 2 failed / 657 passed without my changes, and the nlp diff touches no
metrics or wiring file. And `pnpm env:python-surface:check` was ALREADY failing on `dev-2.2`
before R3: the committed manifest carried three `STT_BENCH_*` bare reads whose source was
deleted without regenerating, and `apps/nlp/.env.sample` was stale against its own source
comment. Regenerating for R3 fixed both, which is why the `globalEnv` delta is 503 → 497 —
3 entries this ticket's, 3 that drift's.

## 6. Change History

| Date | Change |
|---|---|
| 2026-09-10 | Filed from TASK-870's close-out at the owner's request, carrying the four residual items (TASK-870 items 3, 5, 8, 9) out of a Completed program. Every claim re-verified by inspection on `0d7ed352f`: R1's commented SQL located at `…_task_870_wave3a_schema_retirement/migration.sql:77-82`; R2's rule at `policy-catalogue.ts:278-291`; R3 measured at 3 legacy fields + 8 call sites in `apps/harness` and 3 env names still set across `hope-v2-deployment/deployment/k8s/**`; R4 measured at 76 mentions across 44 files, 14 of them tests — and no hit anywhere is a compared value (checked), so every one is prose, a docstring or an assertion failure message. No code changed. |
| 2026-09-10 | **All four complete.** Owner answers: R1 soft-retire, R2 keep-as-confirmed, R3+R4 do them. Four corrections to this ticket's own §2 recorded in §5: `service_token` is not retirable (inbound guard) and was excluded from R3; no deployment-repo commit was needed; R4's hits include user-visible response values and operator guidance, not only prose; and R4's successor differs by service, so a blanket rename would have been wrong in 11 places. R1's plan step "delete the commented block" was NOT followed — `02-database-prisma.md` forbids editing a committed migration; measured that Prisma 7 flags a comment-only edit on neither `migrate deploy` nor `migrate status`, so the hazard is latent, and the execution is recorded in the deprecation register instead. Offered back to the owner as a one-line change. |
| 2026-09-10 | R4's out-of-scope remainder filed as **TASK-942**. Measuring it for that ticket corrected this one's §5 twice: the TypeScript total is 238 hits / 134 files (the "~25" was the `apps/api` subset), and the OpenAPI `@ApiProperty` I had recommended fixing first is provenance that should likely be kept — now TASK-942 OD-1. |
