# TASK-881 — `models.*` family retirement: the `AiTaskDefault` facade goes, `AiRoutingPolicy` is the only selection surface

| | |
|---|---|
| **Status** | In Progress |
| **Type** | refactor |
| **Program** | TASK-870 Configuration Governance — wave 3a, lane C (second batch) |
| **Branch** | `task-881-models-family-retirement` (worktree `hope-v2-task-881`) |
| **Base** | `1e81c4966` (= `dev-2.2` after wave-3a batch 1: TASK-879/880/883) |
| **Merge target** | `dev-2.2` (orchestrator merges from the primary checkout) |

## Requirement Analysis

Selection is never a settings key. Text generation selects through the assigned `TEXT_GENERATION`
agent (TASK-876). Guardrail, NLP and the harness judge select through
`AiRoutingPolicy.resolveDefault(taskKey)` on the SYSTEM row, super-admin-only (owner decision #3:
guardrail is built-in and platform-only). Everything that still expressed selection as a
`models.<taskKey>` setting, or as a row of the retired `AiTaskDefault` table, is removed
completely — never dual-homed.

Five deliverables:

1. **The 12 `models.*` descriptors go** — `models.guardrail.{validate,safety,groundedness,pii}`,
   `models.nlp.{ner,diagnosis}`, `models.harness.judge` (their readers already resolve through
   `AiRoutingPolicy.resolveDefault`; the SYSTEM routing-policy rows stay as the catalogue rows) and
   `models.text.{live,finalize,test}` + `models.text.{live,finalize}.fallback` (unread since
   TASK-876). Each is asserted absent from `HOPE_SETTINGS_REGISTRY`; no absolute registry total is
   pinned (sibling lanes remove keys in parallel).
2. **The facade and its table go** — `AiTaskDefaultService` (a `@deprecated` facade over
   `AiRoutingPolicy` since TASK-862), its module, DTOs, mapper, constants, the
   `admin/ai-task-defaults` routes and their scope, the `AiTaskDefault` domain trio + repository +
   `CoreDatabaseModule` registration, the Prisma model, the seed rows / CASL ability rows / scopes,
   and every reader — repointed to `IAiRoutingPolicyService.resolveDefault`. `upsertRow` was the
   only non-super-admin `AiRoutingPolicy` write; it retires with the facade.
3. **`HarnessPolicy.textProvider` / `textModel` columns go.** TASK-876 already derives the
   response's `textProvider` / `textModel` from the assigned agent's primary and reads nothing
   from the columns; they are dead storage. The RESPONSE fields stay (derived).
4. **Console readers** are cleaned; there is no console route left to redirect (the
   `/ai-task-defaults` stub's one-release window closed in TASK-862, per the deprecation register).
5. `packages/vox-node`: only `admin-resource.ts` is hand-authored; it references nothing retired.
   The generated `src/resources/admin/**` drifts until the orchestrator regenerates it.

## Current State Evaluation

Verified at `1e81c4966`:

- `AiRoutingPolicyService.resolveDefault` has **no caller outside the facade** — every "default
  model for task X" read in the platform still went through `AiTaskDefaultService.getEffective`:
  `resolveNerModelSelection.ts` (and its three callers: `summary.service.ts`,
  `live-tool-registry.ts` via `live-documentation.service.ts`), `harness-policy.service.ts`
  (`harness.judge`), `effective-config.service.ts` (`modelWeights`), `effective-settings.service.ts`
  (the `models.*` lane), `apps/api` `ai-inference.controller.ts` (`nlp.ner` / `nlp.diagnosis`) and
  `text-proxy.controller.ts` (`guardrail.validate` default marking).
- The facade's `upsertRow` performed a `model.taskType === AI_TASK_MODEL_TASK_TYPES[taskKey]`
  write-time check that `AiRoutingPolicyService.create/update` never had. It retires with the
  facade; the gap is recorded under Deferred.
- `AI_TASK_KEYS` is also the routing service's own vocabulary (`assertKnownTaskKey`,
  `resolveConfigurationRow`) and taxonomy (`AI_TASK_KIND_BY_TASK_KEY`), so the vocabulary is
  re-homed into `ai-routing-policy/constants.ts` minus the five text keys. `text.live` /
  `text.finalize` / `text.test` survive elsewhere ONLY as workflow-node `taskKey` config
  (`packages/workflow-contract`, `apps/harness`, `prompt-resolution.service.ts`) — a prompt-binding
  and telemetry role since TASK-876, not a routing selector; those files belong to lane D and are
  untouched.
- `providerConfigRef.taskKey` on `core.agent` nodes is a free string resolved through
  `AI_TASK_KEYS` for generation CAPABILITIES only; a node naming a retired text key now answers
  UNKNOWN capabilities (the documented fail-safe), exactly as an unknown key already did.
- The console catalogue `shared/catalog/ai-task-keys.ts` has **zero consumers** besides its own
  lockstep test.
- `seed/11-global-setting.ts` seeds no `models.*` row (comments only). `seed/13-harness-policy.ts`
  exists solely to write the two text columns onto the SYSTEM `HarnessPolicy` row.
- `packages/applications`' `svc-scope-route-ability-coverage.test.ts` walks the COMMITTED
  `apps/api/route-manifest.json`; the four `AiTaskDefaultAdminController` pairs in it go red the
  moment the scope leaves the registry and stay red until the orchestrator regenerates the manifest
  (expected, reported under gates).
- Six e2e specs outside this lane used `GET /admin/ai-task-defaults/row` as a "tenant discovery"
  trick or exercised the retired governance surface directly (`task-615-*` ×4, `task-729`,
  `task-779`); the route's own spec is `ai-task-defaults-cross-tenant.spec.ts`.

## Implementation Plan

TDD per surface, layer order database → domains → applications → api → console, one commit per
step, gates per package.

1. **Vocabulary re-home** (`packages/applications`): new `ai-routing-policy/constants.ts`
   (`AI_TASK_KEYS` minus text keys, `AiTaskKey`, `AI_TASK_KIND_BY_TASK_KEY`, `resolveAiTaskKind`,
   `SUPER_ADMIN_ONLY_TASK_PREFIXES`, `SUPER_ADMIN_ONLY_TASK_KEYS`, `isSuperAdminOnlyTaskKey`);
   tests moved from `ai-task-default/__tests__` and re-anchored (text keys asserted ABSENT; the
   migration-parity test compares the surviving keys and names the retired ones).
2. **Descriptors**: delete `model-defaults.descriptors.ts`, the `registry.ts` spread and the
   `settings-registry/index.ts` export; drop the `models.*` lane from `EffectiveSettingsService`
   and `effectiveResolverLane`; registry test asserts the 12 keys absent.
3. **Readers → `resolveDefault`**: `resolveNerModelSelection` (+ 3 callers), harness judge,
   effective-config `modelWeights`, `ai-inference`, `text-proxy`; SYSTEM-only keys pass
   `{ systemOnly: true }` (the facade's `isSuperAdminOnlyTaskKey` pin, made explicit at each site).
4. **Facade removal**: `services/ai-task-default/**`, `apps/api/src/modules/ai-task-default/**`,
   bootstrap audits, the OpenAPI tag, `admin:ai-task-default:manage` (registry + seed + tests),
   the `AiTaskDefault` CASL rule (+ tests), the route's e2e spec; the six cross-lane e2e specs
   repointed to `GET /admin/nlp-task-instructions/row?taskKey=nlp.topic` for tenant discovery, the
   retired-surface tests removed.
5. **Schema + domain**: delete `ai-task-default.prisma`; drop `textProvider`/`textModel` from
   `harness.prisma`; `pnpm db:generate` + `pnpm gen:model`; delete the `AiTaskDefault*` trio +
   repository + tests + barrel lines + `CoreDatabaseModule` registration; remove the model from
   `TENANT_SCOPED_MODELS` / `SYSTEM_SHARED_READ_MODELS`; `HarnessPolicy` entity/factory lose the
   two fields; `gen:entity:check` / `gen:factory:check` no drift. `ResourceType.AiTaskDefault`
   STAYS in both enums (a Postgres enum value cannot be dropped in place) — documented below.
6. **Seeds**: `16-ai-routing-policy.ts` loses the 3 text elections + 2 fallback exemptions + 5
   kind entries; `13-harness-policy.ts` becomes "ensure the SYSTEM row exists (create-only)";
   seed tests re-anchored.
7. **Harness-policy**: `HarnessPolicyKnobs`, `SUPER_ADMIN_ONLY_POLICY_KEYS`, `entityToKnobs`,
   `UpdateHarnessPolicyRequest` drop the two fields; `HarnessPolicyResponse` keeps them, documented
   as derived; console `policy-fields.ts` drops the two GLOBAL-tab controls (the
   `safetyProvider`/`safetyModel` precedent) and `api/types.ts` drops them from the update type.
8. **Console + docs**: the dead catalogue + lockstep test deleted; comment-only mentions updated
   in the eight named files; deprecation register rows closed; this README.

### Intended migration SQL (orchestrator-authored, after the wave merges)

```sql
-- TASK-881 — schema retirement (authored on the shadow DB per rule 02)
DROP TABLE IF EXISTS "core"."AiTaskDefault";
ALTER TABLE "core"."HarnessPolicy" DROP COLUMN IF EXISTS "textProvider";
ALTER TABLE "core"."HarnessPolicy" DROP COLUMN IF EXISTS "textModel";
```

SQL this lane would NOT run without an owner decision (data, not schema):

```sql
-- The five retired text task keys keep their AiRoutingPolicy rows on an existing database
-- (the seed no longer writes them; nothing resolves them). Soft-retire, if wanted:
UPDATE "core"."AiRoutingPolicy"
   SET "resourceStatus" = 'DELETED', "resourceStatusUpdatedAt" = now(), "_version" = "_version" + 1
 WHERE "taskKey" IN ('text.live', 'text.finalize', 'text.test', 'text.live.fallback', 'text.finalize.fallback');
-- NOT possible in place: dropping the enum member (Postgres cannot DROP VALUE from an enum;
-- the member is retained in audit.prisma + ResourceType.ts and documented as retired).
-- ALTER TYPE "core"."ResourceType" DROP VALUE 'AiTaskDefault';  -- unsupported by Postgres
```

## Implementation Summary

_(filled in as the steps land)_

## Handoffs

_(filled in at close)_

## Change History

| Date | Change |
|---|---|
| 2026-09-06 | Ticket opened in the batch-2 worktree; plan written after mapping every reader of the facade, the vocabulary, the descriptors and the two columns. |
