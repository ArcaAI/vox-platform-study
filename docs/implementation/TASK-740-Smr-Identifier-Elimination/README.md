# TASK-740 — Eliminate the `smr` identifier; fix the task-key plane defects

| | |
|---|---|
| **Status** | Review — core delivered and verified; the deferred service-identity cluster is now DONE under owner decision D-740-1 (§6). Only the separate deployment repo remains (§6.4) |
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
## 6. The service-identity cluster — RESOLVED by owner decision D-740-1

> **D-740-1 (owner, 2026-08-20, made knowing it touches published contracts):** rename the
> service-identity cluster `smr` → `text` NOW. In scope: the Prometheus job name, the OTel
> service name, the BullMQ queue names, the Vault policy path `hope-smr`, the `SMR-` release-tag
> prefix, and every residual occurrence.

This supersedes the deferral recorded here previously. **2,162 lines across 463 files** were
changed; the repo now holds **zero** `smr` occurrences outside the six classified carve-outs
in §6.2 and the historical records in §6.5.

### 6.1 What was renamed

| Surface | Site | Note |
|---|---|---|
| Prometheus job + label | `infrastructure/docker/configs/prometheus/prometheus.yml` — `job_name: text`, `service` relabel `replacement: text` | Dev scrape config only; the cluster's lives in the deployment repo (§6.4) |
| Grafana dashboards | `uid`/`tags` on `text-{overview,resilience,security,cache-friendliness}` | Metric NAMES were already `text_*` (Wave 4); no PromQL used a `service="smr"` selector, so nothing was left dangling |
| Release-tag grammar | `SERVICE_TAG_PREFIXES` `SMR`→`TEXT` (`packages/utils/src/version-grammar.ts`) **plus every** `$CI_COMMIT_TAG` rule in `.gitlab-ci.yml`, `.gitlab/ci/{build,publish,rules,validate}.yml`, and `.github/services.json` | Moved atomically — see §6.3. The rule doc (`09-infrastructure-devops.md`) already documented `TEXT`, so this closes a doc↔code drift rather than opening one |
| Vault policy path | `hope-smr` → `hope-text` in `apps/text/README.md`, `deployment/vault-agent/README.md`, `apps/text/docker-compose.yml`, dev bootstrap | In-repo these are docs + local compose; the real policy is created in the deployment repo (§6.4) |
| Service registry / OTel | already `text` in code; only prose and `.env.sample` comments moved | No env VAR NAME changed, so `turbo.json#globalEnv` is untouched |
| GlobalSetting key | `smr/smr-azure-deployment` → `text/text-azure-deployment` | Seed-written, **no runtime reader**. The old row is now swept by `RETIRED_GLOBAL_SETTING_KEYS` — see §6.3 |
| Prompt-template tag | `smr-v1` → `text-v1` (seeds + `PRE_SUMMARY_SURFACE_TAG.v1`) | Behaviourally INERT: OD-7(b) made the `'v1'` surface a NEGATIVE match on `dept-free`, so `PRE_SUMMARY_SURFACE_TAG.v1` is a dead value no query reads. Verified before renaming |
| Everything else | ~2,000 residual symbols, private methods, file names, test names, docstrings, prose | 2 files renamed: `summary.service.smr-fallback.task635.test.ts`, `tests/fixtures/smr-compat.fixture.ts` |

**The BullMQ item in the original deferral list was wrong.** There is no queue named `smr` or
`smr-summaries`. Queue names come from the `JobQueue` enum (`packages/domains/src/enums/JobQueue.enum.ts`),
which contains no such member; the summarization queues are `GeneratePreSummary` /
`GenerateComprehensiveSummary` / `GenerateSummary`. `smr-summaries` exists only as fixture data in
one admin-console test. **No queue cutover was required** — see §6.3 for why that mattered.

### 6.2 What was deliberately NOT renamed (six carve-outs, 184 occurrences)

Each of these is a value some *external or already-persisted* thing knows, not an identifier this
codebase is free to choose. A blanket rename broke three of them; all six now carry an in-code
comment saying why a future sweep must leave them alone.

| # | Site | Why it must stay `smr` |
|---|---|---|
| 1 | `api/smr/api/v1` (~110 occurrences) | The frozen v1 wire contract (owner decision 704). Masked with a sentinel during the sweep and restored byte-identically |
| 2 | `apps/harness/.../temporal/models.py` — `AliasChoices("text_provider", "smr_provider")` ×6 | The legacy key that lets **pre-740 recorded Temporal histories** decode on replay. The sweep collapsed it to `AliasChoices("text_provider","text_provider")`, which broke 18 replay-compat tests |
| 3 | `RETIRED_GLOBAL_SETTING_KEYS` (`seed/11-global-setting.ts`) | Names `GlobalSetting` rows that **exist in deployed databases**. Renaming them points the retirement sweep at rows that do not exist, leaving the real `smr` rows ENABLED forever |
| 4 | `apps/api/src/filters/downstream-error.ts` — `/\/api\/smr\b/` | The capability matcher for carve-out #1. Renamed, it stops recognising the frozen path |
| 5 | `scripts/__tests__/text-service-cli-token.test.ts` | A grep-gate whose `smr` literals are the thing being **forbidden**. Renamed, every `not.toMatch` became a tautology that can never fail |
| 6 | `tests/helpers/__tests__/db.helper.test.ts` | Same class as #5 (`smr.main:app`, `DEBUG_SMR`) |

> **The general lesson, beyond the `export const X = X` bug class TASK-707 recorded.** A rename is
> unsafe wherever the old and new name appear *together on purpose* — a legacy alias, a
> retirement list, a negative assertion. Collapsing that pair produces code that still compiles,
> still reads plausibly, and silently does nothing. A `git grep` for the new token cannot find it;
> only running the suites can. Three of the six were caught by tests, one by a duplicate-pair
> detector run over the diff.

### 6.3 Cutover classification (running-system state)

| State | Classification | Action taken |
|---|---|---|
| **BullMQ queues** | **N/A — no such queue exists** (see §6.1) | Nothing. Had one existed, the choice would have been *drain*: pause the producer, let the old queue empty, then deploy the renamed consumer — dual-read doubles the consumer surface for no benefit when the rename is a single atomic deploy |
| **Redis key prefixes** | Already renamed in Wave 4 — **accept-loss** | Unchanged. Per owner decision D-A there is no production data; a real deployment would drain in-flight `smr:task:*` / `smr:stream:*` keys before the cut, since these carry SSE resume state whose loss surfaces as a stalled stream, not a crash |
| **`GlobalSetting` rows** | **Persisted state — retire-and-recreate** | `smr/smr-azure-deployment` added to `RETIRED_GLOBAL_SETTING_KEYS`, so the seed sweeps the old row to `DELETED` while the new `text/text-azure-deployment` row is created. Any value a tenant had set is NOT migrated (D-A: no production data) |
| **Prompt-template `smr-v1` tag** | **Persisted but inert** | Renamed. No query reads it (verified). An already-seeded DB keeps `smr-v1` rows until reseeded; nothing behaves differently either way |
| **Prometheus job/label** | **Observability continuity** | Renamed. Historical `job="smr"` series do not merge with `job="text"` — Grafana panels show a discontinuity at the cut. Acceptable in dev; the cluster's Prometheus is in the deployment repo (§6.4) |
| **Grafana dashboard `uid`** | **Stored identifier** | Renamed. A `uid` change breaks saved links and any provisioning reference — see the deployment checklist |
| **Vault policy path** | **Live secret-engine state** | In-repo docs/compose renamed. The live policy needs the create-then-swap procedure in §6.4 — a rename is NOT atomic in Vault |
| **Release-tag prefix** | **Published grammar** | Renamed atomically with every consumer. `TEXT-x.y.z` now builds `apps/text`; **`SMR-x.y.z` no longer matches anything and triggers no pipeline** |

### 6.4 Deployment-repo checklist — `arca/hope-v2-deployment`

**Not touched here, by instruction.** That repo is not checked out in this worktree and the owner
deploys it personally. Ordered relative to merging this branch:

**Before merge (safe to do early — additive only):**

1. **Vault**: create policy `hope-text` with the *same* rules as `hope-smr`, and bind the existing
   AppRole to **both**. Do not delete `hope-smr` yet — a running pod holds a token issued against
   it. (Vault has no policy rename; this create-then-swap is the only non-disruptive path.)
2. **Prometheus** (cluster scrape config): add a `text` job alongside `smr`, scraping the same
   target, with the `service` relabel set to `text`. Both series exist during the overlap, which is
   what lets a dashboard bridge the discontinuity.
3. **Grafana**: if dashboards are provisioned from that repo, add the new `uid`s **as new files**;
   keep the old ones until step 8.

**At merge (must be simultaneous with this branch landing):**

4. Nothing in the deployment repo is required for the app to boot — the rename is internal. The one
   hard coupling is the release tag: **stop tagging `SMR-x.y.z`. Use `TEXT-x.y.z`.** A `SMR-` tag
   pushed after this merge triggers **no pipeline at all** (silent no-op, not an error).
5. The image name is unaffected — it was already `text` (`SERVICE_NAME: text` in
   `.gitlab/ci/build.yml`), so **no manifest image path changes** and digest-pinned promotion is
   unaffected.

**After the new revision is running and healthy:**

6. Point the Deployment's Vault annotations at `hope-text`; roll the pods.
7. Remove the `hope-smr` binding, then delete the policy.
8. Remove the old Prometheus `smr` job and the old Grafana dashboard files.

**Do NOT** delete `hope-smr` or the `smr` scrape job in the same change that lands this branch —
a rollback would then have no policy to authenticate against and no metrics to alert on.

### 6.5 Still out of scope (historical records — deliberately untouched)

`docs/implementation/**`, `docs/archive/**`, `docs/research/**` (Proxmox VM inventories naming real
`smr-v1` hosts), `**/CHANGELOG.md`, the committed migrations (rule 02 forbids editing them, and the
folder `20260817170254_task_740_smr_to_text_identifier` is a ledger entry), `apps/nlp/data/dictionaries/**`
(the English unigram list contains `smriti` and `smrt`), and `wasmResult` in `packages/noise-filter`
(a false positive — w-a-**s**-**m**-**R**esult).

### 6.6 D-740-2 — the retired `default-smr-*` reads in `tenant.service.ts`

**Finding.** `validateProviderModel` (`packages/applications/src/services/tenant/tenant.service.ts:1466-1490`)
declares a TEXT domain keyed on `default-smr-provider` / `default-smr-model` and validates a
submitted provider/model against the `ux-constants/smr-provider-models` catalog. **All three keys
are in `RETIRED_GLOBAL_SETTING_KEYS`** and are swept to `DELETED` by every seed run.

**What removing them would change: nothing observable.** The code path is already inert, in two
independent ways:

1. The keys are retired, so `validateProviderModel` never matches `settingKey` and returns at the
   `if (!domain) return;` guard.
2. Even if a key did match, `loadTextCatalog` reads the retired `smr-provider-models` row, gets
   nothing, and the `if (!catalog || catalog.length === 0) return;` guard exits before any
   validation runs.

So the TEXT half of this validator cannot reject anything today. The **Guardrail half of the same
function is in exactly the same position** — `default-guardrail-provider`, `default-guardrail-model`
and the whole `guardrail` namespace are retired too. The function's only live behaviour is its
early return.

**Recommendation — remove the TEXT and Guardrail domains together, in their own ticket; do NOT
remove them here.** Reasons:

- The honest fix deletes the whole `validateProviderModel` mechanism plus `loadTextCatalog`,
  `getCurrentTextProvider`, `loadGuardrailCatalog`, `getCurrentGuardrailProvider` and their tests —
  a behaviour-preserving deletion, but a substantial one, and outside a rename ticket's remit.
- Deleting only the TEXT half would leave a two-entry table with one dead entry, which reads as an
  oversight rather than a decision.
- The replacement is already live: provider/model selection is validated by `AiTaskDefault` +
  the `AiModel` registry (`resolveTextSelectionForKey`, Wave 5), which is fail-closed. Nothing
  regresses by removing the dead validator, but nothing improves either — this is debt cleanup,
  not a defect fix.

**Renamed, not removed, in this ticket:** the literals now read `default-text-provider` /
`default-text-model`, which are equally non-existent keys — the code is exactly as inert as before,
with no `smr` left in it. That preserves D-740-1 without making an unreviewed behavioural change.

### 6.7 Defect found and fixed while classifying — the effective-config contract was BROKEN

Not a rename side effect; a live bug the rename repaired.

`apps/text` polls `GET /internal/effective-config?service=text` (`core/effective_config.py:119`,
`service: str = "text"`). The gateway's `EFFECTIVE_CONFIG_SERVICES` still listed **`smr`**, so
`isKnownService('text')` was false and **every poll returned 400**. The Python client's negative
cache absorbed the failure, so `apps/text` silently ran on its bootstrap env value forever and the
admin control plane for text was inert.

The same partial rename had left `resolveRetention('smr')` building the registry key
`smr.modelCache.ttlSeconds`, while `SERVICE_RUNTIME_DEFAULTS` had already been renamed to
`text.modelCache.ttlSeconds` — so even a well-formed request resolved `undefined`. The `as
ServiceRuntimeKey` cast hid the mismatch from the compiler, and the unit test asked for
`resolveForService('smr')`, so it agreed with the bug rather than catching it.

Renaming the reader to `text` closes both halves. The suite reflects it: the baseline run has
`EffectiveConfigService … serves smr runtimeProfiles plus the engine-retention TTL` **failing**;
after the rename its `text` counterpart passes.

## 7. Verification

### 7.0 D-740-1 verification (2026-08-20)

Run in an isolated worktree. **Two environment hazards were confirmed and neutralised before any
result was trusted** — both would otherwise have produced meaningless green:

1. The worktree branched from a **2026-05-25 `dev` commit, 1,993 commits behind `feat/loop`**
   (9,428 files differing). A 2,000-occurrence rename authored there would have been unmergeable
   and would have missed everything added since May. Reset onto `feat/loop@f69e3598f` first.
2. `node_modules` was **absent**, and the conda env's editable installs resolve `text`/`harness`
   to the **MAIN checkout**, not this worktree. Verified with `importlib.util.find_spec`, then
   overridden with `PYTHONPATH` and re-verified that each package resolved inside the worktree.
   Every Python figure below was produced against **this** tree.

| Gate | Result |
|---|---|
| `pnpm turbo typecheck --continue` | **40 of 45 tasks pass; ZERO new errors.** All failures are pre-existing sibling breakage — `WorkflowInvariantRule*`/`WorkflowRule*` (domains), `phi-audit-scrub`/`cloud-provider-guard` (applications), and 7 test-arity errors in apps/api. Proven pre-existing: none of the 8 failing files appear in this change's file list, and each missing module is absent from `HEAD` (`git ls-tree`) |
| `pnpm turbo lint --continue` | **0 errors** in every package (domains 17, applications 183, api 63 standing `only-warn` warnings). One real prettier error the rename reflowed was fixed |
| `pnpm test:unit` — **baseline vs after**, JSON reporter, set-differenced | baseline **892** failures → after **891**. **Zero new failures; one genuine fix.** The single "new" entry is the same pre-existing `Cannot find module './WorkflowRulePredicateType'` file-level failure under the renamed filename; the fix is `EffectiveConfigService … engine-retention TTL`, which **fails at baseline and passes after** — direct evidence for §6.7 |
| `CI=true pytest` — `apps/harness` | **1479 passed, 0 failed** (all replay-compat tests green after restoring the legacy `smr_provider` alias) |
| `CI=true pytest` — `apps/text` | **1212 passed, 2 failed.** Both are `test_wired_provider_queue.py` rate-limit timing (429 vs 200). **Not this change**: `apps/text/src/text` is byte-identical to the main checkout except one prose-only test file, and the failure **reproduces on unmodified main** under the same `PYTHONPATH` invocation |
| `CI=true pytest` — `apps/guardrail` | **251 passed** |
| `CI=true pytest` — `apps/nlp` | **358 passed** |
| `ruff check` (project lint scope) | **All checks passed!** (the 14 errors a wider sweep shows are in `apps/{stt,harness}/scripts/**`, outside every `<svc>:lint` scope and untouched here) |
| `pnpm --filter @arcaai/vox test` | **4206 passed, 0 failed** — `test:unit` does not cover this suite, and it is the one that exercises the `api/smr/api/v1` carve-out |
| `pnpm --filter @arcaai/vox-node test` | **233 passed, 0 failed** |
| Carve-out integrity | `api/smr/api/v1` present at all 5 production sites; **184 residual `smr` occurrences across exactly the 6 classified carve-out files**, nothing else |
| `package.json` | parses with **no duplicate keys** (the sweep had created one) |

Not run: `pnpm test:e2e` and the integration suites — the isolated test stack on :5433 is still down.

### 7.1 Original ticket verification (2026-08-17)

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
- [x] Service-identity cluster (§6) — **DONE** under D-740-1; only the separate deployment repo remains (§6.4 checklist)
- [x] Release-tag grammar moved atomically with every CI consumer (§6.1)
- [x] Six carve-outs classified, commented in code, and proven to still hold (§6.2)
- [x] D-740-2 analysed and reported with a recommendation; deliberately NOT removed (§6.6)
- [ ] e2e / integration — test stack :5433 down (unchanged)
- [ ] Deployment repo `arca/hope-v2-deployment` — owner-executed, §6.4

## 9. Change History

| Date | Change |
|---|---|
| 2026-08-17 | Ticket created and executed. Waves 1–6 applied; migration authored and proven; D-1…D-7 closed; service-identity cluster deferred with reasons (§6). |
| 2026-08-20 | **D-740-1 RESOLVED.** §6 rewritten from "deferred" to delivered: renamed the service-identity cluster across 463 files / 2,162 lines — Prometheus job + relabel, Grafana dashboard uids, the `SMR-`→`TEXT-` release-tag prefix (version-grammar **plus** every `$CI_COMMIT_TAG` rule and `.github/services.json`), the `hope-smr` Vault policy path, the `smr-azure-deployment` GlobalSetting key (with a retirement entry for the old row), the `smr-v1` prompt tag, and all residual symbols/prose. Corrected the deferral's claim that BullMQ queues `smr`/`smr-summaries` exist — they do not (§6.1), so no queue cutover was needed. Six carve-outs identified and commented (§6.2); three of them (Temporal replay aliases, `RETIRED_GLOBAL_SETTING_KEYS`, the `api/smr` capability matcher) were **broken by the sweep and restored**, and two grep-gates that the sweep had inverted into tautologies were repaired and hardened. Removed the now-pointless `smr` CLI remap from five launcher scripts plus the `test:up:smr` alias (and the duplicate `package.json` key the sweep created). Fixed an unrelated **live defect found while classifying**: `EFFECTIVE_CONFIG_SERVICES` still said `smr` while `apps/text` polls `?service=text`, so every effective-config pull 400'd and `text.modelCache.ttlSeconds` was inert (§6.7). D-740-2 analysed, recommendation recorded, deliberately not actioned (§6.6). Deployment-repo work specified as an ordered checklist (§6.4) rather than attempted. |
| 2026-08-20 | **D-740-2 RESOLVED.** Removed the dead `validateProviderModel` cluster from `tenant.service.ts`: the function, its call site in the `updateTenantConfigs` transaction loop, the generic `loadCatalog`/`getCurrentProvider` primitives, and all four per-domain wrappers (`loadTextCatalog`/`getCurrentTextProvider`/`loadGuardrailCatalog`/`getCurrentGuardrailProvider`), plus the six provider/model validation tests. Both domains removed together — deleting only the TEXT half would leave a one-entry table with a dead row. Inert twice over: `default-text-*`/`default-guardrail-*` are unseeded/retired (the guardrail pair via `RETIRED_GLOBAL_SETTING_KEYS`), so `settingKey` never matched a domain, and the catalog read returned nothing regardless. Behaviour-preserving debt cleanup, not a defect fix — selection is validated fail-closed by `AiTaskDefault` + the `AiModel` registry via `resolveTextSelectionForKey` (Wave 5). The `locked` + super-admin enforcement test was NOT dead and is kept, rehomed under a `locked setting enforcement` describe. |
