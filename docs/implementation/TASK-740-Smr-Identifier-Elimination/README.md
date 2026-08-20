# TASK-740 — Eliminate the `smr` identifier; fix the task-key plane defects

| | |
|---|---|
| **Status** | Review — core delivered and verified; one bounded chunk deliberately deferred (§6) |
| **Wave** | 2 · **Size** | L |
| **Epic slug** | `smr-identifier-elimination` |
| **Depends on** | — (reverses the frozen-identifier position of TASK-707) |
| **Design refs** | [owner-decisions-2026-08-17.md](../../programs/agentic-workflow-platform/owner-decisions-2026-08-17.md) §3b decision 3 + its carve-out; D-A, D-B, D-E, D-F |
| **Findings closed** | D-1, D-2, D-3, D-4, D-5, D-6, D-7 from [smr-task-key-findings.md](../../programs/agentic-workflow-platform/smr-task-key-findings.md) |

## 1. Requirement Analysis

Owner directive, 2026-08-17: *"`smr` was renamed to `text`. Do NOT use `smr` anymore!"*

This **reverses** TASK-707's "frozen identifiers" position. In scope, and previously frozen:
DB-persisted `AiTaskDefault.taskKey` values, the `HarnessPolicy.smrProvider`/`smrModel` columns,
the Python `smr_*` fields and `SmrClient`, the `HARNESS_SMR_*` env names, structlog event names,
Prometheus metric names, and Redis key prefixes.

Alongside the rename, this ticket closes the seven producer/consumer defects the findings doc
recorded — chiefly **D-1**, which had left the `AiTaskDefault` plane *partially inert*.

### The one carve-out — NOT renamed

The external wire route `@Controller('api/smr/api/v1')` and vox-node's matching v1-compat paths
are a **published API contract**, preserved deliberately by owner decision 704. Renaming them
breaks every existing SDK consumer. Four production sites keep the literal, unchanged:

- `packages/vox-node/src/core/url.ts:26` (`PREFIX_EXEMPT_PATHS`, an exact-match set — a rename here
  fails silently by falling through to the `api/v1`-prefixed branch and 404ing)
- `packages/vox-node/src/resources/summarization.ts:24,26`
- `packages/agentic-sdk-v2/src/compat/useText.ts` (the two URL builders)
- `apps/api/src/modules/text-compat/text-compat.controller.ts` (the controller prefix itself)

### Out of scope

- Historical ticket READMEs under `docs/implementation/**` and `docs/archive/**` — they are records
  of what things were called at the time; rewriting them would falsify the history.
- `HarnessPolicyChange.beforeJson`/`afterJson` WORM audit snapshots (see §4, migration).
- The service-identity token `smr` — see §6, deferred with reasons.

## 2. Current State Evaluation

Verified against the live tree at the start of work:

- **Surface size.** 618 non-doc tracked files carried `smr`/`Smr`/`SMR`, ~706 distinct tokens —
  substantially larger than the "~50 call sites" the owner-decision note estimated.
- **D-1.** `apps/harness/.../interpreter/nodes/text_generate.py` validated `config.taskKey` against
  `{smr.finalize, smr.live, smr.test}` and then resolved the model from `policy.smr_provider` /
  `smr_model` — the `HarnessPolicy` columns, never the `AiTaskDefault` row for that key.
  `getEffectivePolicy` overlaid `judgeProvider`/`judgeModel` from `harness.judge` but had **no
  equivalent overlay for text**; the AiTaskDefault-first path lived only in `resolveSmrSelection`,
  which `/internal/harness/policy` never called. Every `generate.text` node therefore resolved the
  same model regardless of task key, and the three seeded rows were inert on the Python path. The
  node's own docstring claimed the opposite.
- **D-2.** `text.test` seeded and backend-live, absent from the console mirror (11 keys vs the
  backend's 15), while its resolver is fail-closed.
- **D-3.** `smrProvider`/`smrModel` rendered tenant-editable in two console places while the backend
  `SUPER_ADMIN_ONLY_POLICY_KEYS` 403s them.
- **D-4.** `'smr.test.fallback'` — an unregistered, unseeded literal existing only to satisfy a
  `Record<TextRoutingTask, string>` exhaustiveness check.
- **D-5.** Two comments describing a `smr.test → smr.finalize` fallback hop the implementation had
  deliberately removed.
- **D-6.** SDK config paths pointed at `GlobalSetting` rows the seed actively retires.
- **D-7.** Dead alias `defaultSmrProvider`/`defaultSmrModel` — read in `summary/text-generate.ts`,
  written nowhere.

## 3. Knowledge & Best Practices

- **Rule 02** §Migration Workflow — shadow-DB recipe, and the `@@unique` `map:` trap. The dev DB is
  `db push`-managed with **no** `_prisma_migrations` ledger, so migrations are authored against a
  throwaway shadow.
- **Rule 03** §Generated Code Discipline — **`pnpm gen:mapper` was never run** (destructive).
- **Rule 06** §Temporal — workflow changes must keep **replay compatibility**. This bit hard; see §4.
- **Rule 04** — `broadcastSysEvent`, 404-over-403, DTO discipline.
- Pitfall this ticket was explicitly warned about, and hit: **a wide mechanical rename collapses
  deprecated aliases into self-referential declarations.** TASK-707 shipped exactly that bug
  (`SMR_ENDPOINTS` aliased to itself). Six such declarations were produced here and caught by an
  explicit post-sweep grep before any test run — see §4.

## 4. Implementation Plan (as executed)

### Wave 1 — DB-persisted task keys
`smr.live` / `smr.finalize` / `smr.test` (+ the two `.fallback` variants) → `text.*` across 48
files: `AI_TASK_KEYS`, `AI_TASK_MODEL_TASK_TYPES`, the `models.<taskKey>` settings descriptors,
`seed/16-ai-task-default.ts`, the console mirror, the Python `_ALLOWED_TASK_KEYS`, and all tests.

### Wave 2 — `smrProvider`/`smrModel` → `textProvider`/`textModel`
86 files: `harness.prisma`, the hand-authored domain trio (`HarnessPolicyEntity` / `Factory` /
`Model`), `HarnessPolicyKnobs`, `SUPER_ADMIN_ONLY_POLICY_KEYS`, DTOs, gateway, console, SDK, and the
Python `data.get("smrProvider")` remap + the `alias=` fields on the two internal request models.

### Wave 3 — Python harness plane
`SmrClient`→`TextClient`, `SmrServiceError`→`TextServiceError`,
`SmrGenerationResult`→`TextGenerationResult`, `_SmrResponseLost`→`_TextResponseLost`,
`smr_client.py`→`text_client.py`, `_smr_client`→`_text_client`, `smr_provider`/`smr_model`/
`smr_base_url`/`smr_service_token`/`smr_timeout_s` → `text_*`, `HARNESS_SMR_*`→`HARNESS_TEXT_*`,
the `ApplicationError(type="SmrResponseLost")` Temporal error type, and the structured error codes
`no_smr_selection`/`smr_generate_failed`.

### Wave 4 — apps/text observability + keying
- **Prometheus metric names** — all 18 `smr_*` → `text_*` in `core/metrics.py`, moved **together
  with** their consumers: 5 Grafana dashboards (`text-resilience`, `text-cache-friendliness`,
  `text-overview`, `text-security`, `agentic-trajectory`) and the metric-name assertions.
- **structlog** event and logger names — `"smr.*"` → `"text.*"`.
- **Redis key prefixes** — `smr:task:` / `smr:stream:` / `smr:idem:` / `smr:workerpool:` →
  `text:*`, moved together with the TS consumer (`text-stream-consumer.service.ts`) and the
  `async-contract` / `py-async-contract` idempotency helpers (`smrChunk`/`smr_chunk` → `text*`).
- `SmrError` → `TextError` (the root of the whole apps/text exception hierarchy).

> **Redis cutover.** Renaming these prefixes **strands any in-flight keys** written under the old
> names. Stated explicitly rather than left implicit: per owner decision **D-A there is no
> production data**, so this is a clean cutover, not a migration. Local/dev Redis may hold orphaned
> `smr:*` keys until it is flushed; nothing reads them.

### Wave 5 — D-1 (the highest-value fix)

1. `HarnessPolicyService.getEffectivePolicy(tenantId, { consultationId, **taskKey** })` — when a
   task key is supplied, `textProvider`/`textModel` are overlaid from the `AiTaskDefault` row for
   **that key**, tenant → SYSTEM, on all three return paths. Mirrors the existing judge overlay
   exactly; best-effort, so an unresolved key leaves the policy columns in place.
2. New private `resolveTextSelectionForKey(taskKey, tenantId)` — now the **single** place a task key
   becomes a model. `resolveTextSelection` (fail-closed) and `resolveTextFallbackSelection`
   (fail-open) both funnel through it, so the `azure → azure-openai` runtime alias and the
   "needs BOTH provider and sourceUri" rule cannot drift between the three call sites.
3. `GET /internal/harness/policy` accepts `taskKey`; `ApiClient.get_policy` forwards it.
4. `text_generate.py` passes `task_key=task_key`, and its **docstring was corrected** — it had
   documented behaviour the node did not have.

### Wave 6 — remaining defects
D-2 (console mirror + a real `text.test` surface), D-3 (both console places made honest),
D-4 (`text.test.fallback` deleted by narrowing the key type, so the map *cannot* name an
unregistered key again), D-5 (both comments corrected), D-6/D-7 (retired-row reads removed).

## 5. Implementation Summary

### Migration — `20260817170254_task_740_smr_to_text_identifier`

```sql
ALTER TABLE "core"."HarnessPolicy" RENAME COLUMN "smrProvider" TO "textProvider";
ALTER TABLE "core"."HarnessPolicy" RENAME COLUMN "smrModel"    TO "textModel";

UPDATE "core"."AiTaskDefault"
SET "taskKey" = 'text.' || substring("taskKey" FROM 5)
WHERE "taskKey" LIKE 'smr.%';
```

Both statements are **renames, never DROP+ADD** — the columns and keys carry admin-managed tenant
configuration, and re-creating them would silently reset every tenant to the platform default.

`HarnessPolicyChange.beforeJson`/`afterJson` are **deliberately not rewritten**: they are WORM audit
snapshots of what a policy looked like when it was edited. Rewriting a historical record so it uses
today's field names would falsify the audit trail. They keep their `smrProvider`/`smrModel` keys.

#### Shadow-DB empty-diff proof

```
$ npx prisma migrate diff --from-config-datasource --to-schema src/prisma/db_main --script
Loaded Prisma config from prisma.config.ts.

-- This is an empty migration.

--exit-code = 0  (0 = empty diff)
```

The datasource is `hope_shadow`, a throwaway DB with the full ledger replayed onto it
(`init … task_740`). Verified directly rather than trusted:

```
$ select migration_name from _prisma_migrations order by finished_at desc limit 2
20260817180000_rename_changelog_audience_global_admin_to_super_admin
20260817170254_task_740_smr_to_text_identifier

$ select column_name from information_schema.columns
  where table_schema='core' and table_name='HarnessPolicy' ...
safetyModel | safetyProvider | textModel | textProvider
```

**Negative control** (the same diff against the un-migrated dev DB) correctly reports drift, proving
the empty result is a real signal and not a mis-pointed tool:

```
-- AlterTable
ALTER TABLE "core"."HarnessPolicy" DROP COLUMN "smrModel",
DROP COLUMN "smrProvider",
ADD COLUMN     "textModel" TEXT,
ADD COLUMN     "textProvider" TEXT;
```

Dev DB (`hope`) migrated in place — `ALTER TABLE, ALTER TABLE, UPDATE 3` — and verified:
`taskKey` now reads `text.finalize / text.live / text.test`; columns `textProvider / textModel`.

> ⚠ Two process notes recorded honestly:
> 1. **The wide sweep initially edited the committed init migration**
>    (`20260817000000_init/migration.sql`), which rule 02 forbids. Caught during the shadow-DB
>    proof — the "empty" diff was a false positive caused by it. The file was restored surgically
>    with `git show HEAD:<path> > <path>` (never a bulk `checkout`/`restore`/`reset`), confirmed
>    byte-identical to HEAD, and the proof re-run.
> 2. **The isolated test Postgres on :5433 was DOWN**, contrary to owner decision D-F. The test DB
>    could not be migrated. Dev (:5432) was.

### Temporal replay compatibility — the significant find

Renaming `smr_provider`/`smr_model` on the workflow dataclasses **broke replay of every recorded
history**: 18 tests in `test_replay_compat.py` and `test_gating_consolidation_replay.py` failed with
`Failed decoding arguments`. The frozen fixtures carry `"smr_provider":null,"smr_model":null` in the
recorded workflow-start payload, and `HarnessDocWorkflowInput` is `extra="forbid"`.

Fixed the correct way — **not** by re-capturing the fixtures, which would have erased the guard:

```python
text_provider: str | None = Field(
    default=None, validation_alias=AliasChoices("text_provider", "smr_provider")
)
```

applied at all three declaration sites. The legacy key is a **validation alias only** — nothing
serializes it, so new histories record `text_provider` and only old ones are read through it. The
`extra="ignore"` `HarnessPolicy` model got the alias too: there it would not have thrown, it would
have *silently dropped the selection* on replay, which is worse. Marked for removal once no pre-740
history can still be replayed.

### Self-referential aliases (the TASK-707 bug class), caught and deleted

The sweep collapsed six deprecated one-release aliases into declarations of themselves:

| File | After sweep |
|---|---|
| `compat/useSMR.ts:18-19` | `export { useText as useText }` |
| `compat/types.ts:376` | `export type TextJobStatus = TextJobStatus;` |
| `compat/types.ts:477` | `export type TextRequest = TextRequest;` |
| `core/constants.ts:1042` | `export const TEXT_ENDPOINTS = TEXT_ENDPOINTS;` |
| `utils/errorUtils.ts:157` | `export const classifyTextError = classifyTextError;` |

Each already had a `text`-named canonical, so all five were **deleted** (and `compat/useSMR.ts` +
its alias test removed entirely) rather than renamed, with the duplicated barrel entries in
`core.ts` / `utils/index.ts` / `core/index.ts` / `compat.ts` de-duplicated. This removes the
deprecated `useSMR` / `SMRRequest` / `SMRJobStatus` / `SMR_ENDPOINTS` / `classifySmrError` exports
from `@arcaai/vox` — a **breaking SDK change**, flagged for the owner.

### Another silent-breakage catch

`READ_ONLY_TASK_KEYS` filtered on the bare prefix `startsWith('smr.')`. Wave 1 renamed the three key
literals but not that predicate, which would have left it matching nothing and leaking every
tenant-editable `text.*` key into the read-only table. Fixed to `startsWith('text.')`.

### Files changed (principal)

Schema/migration: `harness.prisma`, `migrations/20260817170254_task_740_.../migration.sql` ·
Domain: `HarnessPolicyEntity/Factory/Model` · Applications: `harness-policy.service.ts`,
`ai-task-default/constants.ts`, `model-defaults.descriptors.ts`, `prompt-management.service.ts`,
`summary/text-generate.ts` · Gateway: `harness-internal.controller.ts` · Seed:
`16-ai-task-default.ts` · Python: `text_client.py` (renamed), `activities.py`, `workflows.py`,
`models.py`, `text_generate.py`, `api_client.py`, `core/config.py`, `apps/text/**` (metrics,
structlog, Redis, exceptions) · Console: `ai-task-defaults/api/types.ts`, `text-models-section.tsx`,
`policy-fields.ts`, `harness-policy-summary-types.ts` · SDK: `ConfigSchema.ts`, `types/config.ts`,
`compat.ts`, `compat/types.ts`, `core/constants.ts`, `utils/errorUtils.ts` · Infra: 5 Grafana
dashboards.

## 6. Deliberately deferred — the service-identity cluster

The token `smr` **as the service's registry key** is one atomic cross-cutting cluster, and renaming
it partially is precisely how silent breakage happens. It was NOT renamed. It comprises:

| Surface | Site |
|---|---|
| Service registry key | `SERVICE_NAME = "smr"` (`apps/text/core/metrics.py:147`), `_SERVICE_NAME` (`api/endpoints/health.py:32`) |
| Effective-config contract | `GET /internal/effective-config?service=smr`; the gateway derives `` `${service}.modelCache.ttlSeconds` `` — so `smr.modelCache.ttlSeconds` and its `GlobalSetting` row are bound to it |
| Prometheus | `job_name: smr` + the `service=smr` relabel in `infrastructure/docker/configs/prometheus/prometheus.yml` |
| OTel | `service_name` / tracer-name defaults, `otel_service_name` |
| BullMQ queues | `smr`, `smr-summaries` |
| Vault | policy path `hope-smr` |
| **Release tags** | the `SMR-` prefix in the tag grammar (`packages/utils/src/version-grammar.ts`) — digest-pinned promotion depends on it |
| Deployment | compose/k8s service names in the **separate** `arca/hope-v2-deployment` repo |

Two of these — the release-tag grammar and the deployment-repo manifests — are outside this repo or
constitute a published versioning contract, so moving them unilaterally would break CI and deploys
that TASK-730 has not yet reached. **This needs an owner decision and its own ticket**, sequenced
with 730.

Also deferred, and reported rather than changed:

- **`~2000 residual occurrences`** in non-doc files, of which ~847 are pure prose in
  comments/docstrings/test names and ~251 are the service-identity cluster above. The remainder are
  lower-value symbols (`createAxiosSmrResponse`, `_StatsSmr`, `BaseSmrUser`, `remap_smr_alias`,
  `SmrSyncSummaryRequestSchema`, the `smr-v1` prompt-template seed tags, `smr-compat` file names,
  the `smr_task` SSE ticket namespace shared with the gateway's `@StreamScope`).
- **An extension of D-6 found in passing:** `packages/applications/src/services/tenant/tenant.service.ts:1449,1450,1545`
  still reads the `default-smr-provider` / `default-smr-model` `GlobalSetting` keys, which
  `seed/11-global-setting.ts` lists in `RETIRED_GLOBAL_SETTING_KEYS` and sweeps to `DELETED`. That
  is the same defect D-6 describes, in a second place. Removing the read changes tenant
  provider-switching behaviour, so it was reported rather than fixed blind.
- **`apps/harness` still rejects `ollama`** in `_SAFETY_PROVIDERS`, `local_providers` and
  `JudgeProvider`. Left untouched deliberately — it interacts with the owner's revised TASK-736
  scope (Ollama provider logic stays available) and with TASK-735 routing judgement through
  `apps/text`. Needs an owner call, not a unilateral fix.

## 7. Verification

All commands run through the shared test mutex. Real output:

| Gate | Result |
|---|---|
| `pnpm --filter @arcaai/applications build` | **exit 0** |
| `pnpm --filter @arcaai/applications test` | **9225 passed**, 3 failed — all pre-existing/sibling-owned (see below). Baseline before this ticket: **17 failed** |
| `pnpm --filter @arcaai/domains test` | **exit 0** — 1793 passed, 145 files |
| `pnpm --filter @arcaai/database test` | **exit 0** — 1278 passed, 53 files |
| `pnpm typecheck` | **exit 0** — 43 successful, 43 total |
| `CI=true pnpm harness:test` | **exit 0** — **1360 passed** (incl. all 18 replay-compat tests) |
| `CI=true pnpm text:test` | **exit 0** — **1186 passed** (incl. the corrected `test_lifespan` title assertion) |
| `ruff check` (harness, text, py-*) | **All checks passed!** |
| `pnpm lint` | **exit 0** — 38 successful, 38 total; **0 errors** (standing `only-warn` architecture warnings unchanged: domains 13, applications 185, api 65) |
| `pnpm test:unit` | **17983 passed**, 5 failed — 4 sibling-owned (below) + the env-sync cap, also sibling-owned |
| `pnpm env:sync` | exit 0 — `HARNESS_SMR_*` → `HARNESS_TEXT_*` regenerated into `.env.sample` + `env-surface.generated.md`; the drift assertion now passes |
| `pnpm --filter @arcaai/vox test` | **4185 passed**, 1 failed — sibling-owned (below) |
| `pnpm db:generate` | exit 0 — client regenerated with `textProvider`/`textModel` |

The 3 remaining `@arcaai/applications` failures are **not from this ticket** — each was failing at
baseline or is owned by a concurrent session:

1. `dna-writing-style.processor.test.ts` — a sibling session's TASK-737 `X-Tenant-Id` header change.
2. `fail-mode.governance.test.ts` — a sibling session's TASK-738 `internal.accessToken` descriptor
   with no `EXPECTED` env-name entry.
3. `task-724-stt-realtime-untouched.grep-gate.test.ts` — a grep gate that trips on a sibling's
   untracked file under `apps/api/src/modules/streaming/**`.
4. `scripts/__tests__/env-sync.test.ts` — *"declares at most ~144 distinct keys: expected 149 to be
   less than or equal to 148"*. **Evidenced as not this ticket's**: `git diff env-surface.generated.md`
   shows exactly **one** key added (`INTERNAL_ACCESS_TOKEN`) and **zero** removed, and that key comes
   from a +17-line uncommitted addition to `platform-secrets.descriptors.ts` (a sibling's TASK-738
   work). `HARNESS_SMR_*` was never part of the declared surface (`git show HEAD:env-surface.generated.md`
   → 0 matches), so a 1-for-1 rename could not move the count. The env-sync **drift** assertion, which
   *was* this ticket's to fix, now passes.

5. `@arcaai/vox` `constants.ws4.test.ts` — *"DNA_STYLE_ENDPOINTS should have exactly 16 keys: got 18"*.
   The two extra keys are `RESET_MY_STYLE` and `DELETE_REPORT`, from a sibling's uncommitted DNA-erasure
   addition to `core/constants.ts`; this ticket's diff in that file touches only the `TEXT_ENDPOINTS` alias.

> **Note on suite coverage.** `pnpm test:unit` does **not** run the `@arcaai/vox` suite — it has its
> own runner. Running it separately caught two genuine misses this ticket had introduced and that
> `test:unit` would never have surfaced: a stale `'smr.provider'`/`'smr.model'` expectation in
> `ConfigSchema.test.ts`, and a conformance predicate in `task-635-conformance.test.ts` that hunted
> for `SMR`/`Summar` and so silently matched nothing once `useSMR` was deleted. Both are fixed.

Not run: `pnpm test:e2e` and the integration suites — the isolated test stack on :5433 is down.

### Files edited that this ticket does not own

Four untracked files belonging to concurrent sessions referenced symbols renamed here and would
otherwise have failed to import (`test_mandatory_tenant_header.py` blocked the entire harness suite
from collecting). Only the mechanical rename was applied — no logic changed:
`apps/harness/.../test_mandatory_tenant_header.py`,
`packages/applications/.../nlp-egress-redacted.grep-gate.test.ts`,
`packages/eslint-plugin-arcaai-internal/__tests__/require-internal-tenant-header.test.js`.
Additionally `apps/text/.../test_lifespan.py` had its title assertion corrected to the shipped
`"Text — Text Generation Service"` (TASK-707 rename debt, flagged by the coordinator).

## 8. Acceptance Criteria

- [x] `AiTaskDefault` task keys renamed in code, descriptors, seed **and** the database
- [x] `HarnessPolicy.smrProvider`/`smrModel` renamed with a data-preserving migration
- [x] Shadow-DB empty-diff proof captured, with a negative control
- [x] D-1 fixed: the task key actually selects the model, tenant → SYSTEM; docstring corrected
- [x] D-2 … D-7 closed
- [x] `pnpm gen:mapper` never run
- [x] Replay compatibility preserved (1360 harness tests green)
- [x] `typecheck` clean repo-wide
- [x] `pnpm lint` clean (exit 0, 0 errors); `pnpm env:sync` regenerated, drift assertion green
- [ ] Service-identity cluster (§6) — deferred, needs an owner decision
- [ ] e2e / integration — test stack :5433 down

## 9. Change History

| Date | Change |
|---|---|
| 2026-08-17 | Ticket created and executed. Waves 1–6 applied; migration authored and proven; D-1…D-7 closed; service-identity cluster deferred with reasons (§6). |
| 2026-08-20 | D-740-2 follow-up: removed the dead `validateProviderModel` cluster from `tenant.service.ts` (both TEXT/SMR and Guardrail domains together) plus the orphaned `loadCatalog`/`getCurrentProvider`/`loadSmrCatalog`/`getCurrentSmrProvider`/`loadGuardrailCatalog`/`getCurrentGuardrailProvider` helpers, its call site in `updateTenantConfigs`, and the six provider/model validation tests. Behaviour-preserving: every key involved is in `RETIRED_GLOBAL_SETTING_KEYS`, and selection is validated by `AiTaskDefault` + the `AiModel` registry (Wave 5). The locked-setting enforcement test was kept and rehomed under a `locked setting enforcement` describe. |
