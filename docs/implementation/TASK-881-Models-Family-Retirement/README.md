# TASK-881 — `models.*` family retirement: the `AiTaskDefault` facade goes, `AiRoutingPolicy` is the only selection surface

| | |
|---|---|
| **Status** | Review |
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

Thirteen commits on `task-881-models-family-retirement`, base `1e81c4966`. Every reader of the
facade now calls `IAiRoutingPolicyService.resolveDefault` directly; the SYSTEM-only keys pass
`{ systemOnly: true }` explicitly at each site (the facade's `isSuperAdminOnlyTaskKey` pin, made
visible). Nothing is dual-homed: the descriptor family, the facade, its routes, scope, CASL grant,
domain trio, table and seed rows are gone in the same change.

### Per key / per surface — what went where, and the test that proves it

| What | Where it went / why it is gone | Proof |
|---|---|---|
| `models.guardrail.{validate,safety,groundedness,pii}`, `models.nlp.{ner,diagnosis}`, `models.harness.judge` (7 descriptors) | GONE. The readers never resolved the setting — they resolved the facade, which resolved the SYSTEM routing election. The election rows stay; the settings projection had no reader of its own. | `ai-routing-policy/__tests__/task-key-vocabulary.test.ts` ("the models.* settings family is gone" — each key asserted absent, no `models.` prefix survives); `settings-registry.test.ts` ("registers no models.* descriptor"); `fail-mode.governance.test.ts` |
| `models.text.{live,finalize,test}`, `models.text.{live,finalize}.fallback` (5 descriptors) | GONE — unread since TASK-876 (text selects through the assigned agent). | same three tests |
| The `EffectiveSettingsService` `models.*` lane + `effectiveResolverLane('models')` | GONE (with the facade injection in the constructor and `AiTaskDefaultServiceModule` in the module). A `models.<key>` read is now an unknown key. | `effective-settings.service.test.ts` ("models.* (retired) — %s is an unknown key") |
| `AI_TASK_KEYS`, `AiTaskKey`, `AI_TASK_KIND_BY_TASK_KEY`, `resolveAiTaskKind`, `SUPER_ADMIN_ONLY_TASK_PREFIXES`, `SUPER_ADMIN_ONLY_TASK_KEYS`, `isSuperAdminOnlyTaskKey` | RE-HOMED to `ai-routing-policy/constants.ts`, exported from the routing-policy barrel. `AI_TASK_KEYS` is the routing vocabulary MINUS the five text keys (12 keys: 5 guardrail, 5 nlp, `harness.judge`, `vlm.extract`). | `task-key-vocabulary.test.ts` (exact set, text keys absent, governance predicate), `ai-task-kind.test.ts` (migration parity over the surviving keys; the five retired arms named explicitly) |
| `AI_TASK_MODEL_TASK_TYPES`, `GUARDRAIL_TASK_PREFIX` / `isGuardrailTaskKey`, `SUPER_ADMIN_ONLY_TASK_PREFIX` | GONE — facade-only write checks with no other reader (see Deferred for the taskType-compatibility gap). | grep residue (below) |
| `AiTaskDefaultService`, `IAiTaskDefaultService`, module, DTOs (`AiTaskDefaultResponse`, `EffectiveAiTaskDefaultResponse`, `AiTaskModelSummary`, `UpsertAiTaskDefaultRequest`), mapper | GONE (`services/ai-task-default/**`, the `services/index.ts` barrel line). `upsertRow` — the only non-super-admin `AiRoutingPolicy` write — retires with it. | `pnpm --filter @arcaai/applications build` clean; grep residue |
| `resolveNerModelInjection` (+ `summary.service.ts`, `live-documentation.service.ts`, `live-tool-registry.ts`, both modules) | Repointed: `routingPolicies.resolveDefault(SYSTEM, 'nlp.ner', { systemOnly: true })` inside the SYSTEM-pinned CLS scope; reads `model.sourceUri` and `model.metaData.clinicalTaxonomy` off the `AiModelEntity`. | `resolveNerModelSelection.test.ts`, `resolveNerClinicalTaxonomy.test.ts`, `live-documentation.service.test.ts` ("nlp.ner routing-election model injection"), `live-tool-registry.test.ts`, `summary.service.test.ts` |
| `HarnessPolicyService.resolveJudgeSelection` (`harness.judge`) | Repointed: `resolveDefault(tenantId ?? SYSTEM, 'harness.judge', { systemOnly: true })`; a `TaskSelectionVetoedError` still propagates, a lookup failure still degrades to `{null,null}`. | `harness-policy.service.test.ts` ("resolves harness.judge from the SYSTEM routing election …", "leaves judge null (fail-safe) …") |
| `EffectiveConfigService.resolveModelWeights` | Repointed: `resolveDefault(SYSTEM, key, { systemOnly: true })` → `model.slug`; the `harness → guardrail.groundedness` cross-service entry is untouched. | `effective-config.model-weights.test.ts` |
| `apps/api` `AiInferenceController` (`nlp.ner`, `nlp.diagnosis`) | Repointed: `resolveDefault(SYSTEM_TENANT_ID, key, { systemOnly: true })`; fail-closed 503s keep naming the key. | `ai-inference.controller.test.ts`, `ai-inference-model-path.controller.test.ts` |
| `apps/api` `TextProxyController.getGuardrailProviders` (`guardrail.validate` default marking) | Repointed: `resolveDefault(tenantId, 'guardrail.validate', { systemOnly: true })`, still fail-open for a listing decoration. `StreamingModule` imports `AiRoutingPolicyServiceModule`. | `text-proxy.controller.test.ts` (guardrail providers block) |
| `GET/PUT admin/ai-task-defaults{,/row,/options}` + `AiTaskDefaultAdminController`, `AiTaskDefaultModule`, `admin-ai-task-defaults` OpenAPI tag, `admin-scope-audit` row, `task-773-admin-scope-map` row | GONE. | `admin-scope-audit.test.ts` (64 controllers), `task-773-admin-scope-map.test.ts` (59 rows), `tags.test.ts` |
| `admin:ai-task-default:manage` (API-key registry) / `svc:admin:ai-task-default:manage` (service-account seed) | GONE. | `apikey-scopes.registry.test.ts` (55 admin / 58 reserved), `service-account-seed.test.ts` |
| CASL `AiTaskDefault` grant in `tenant-full-access` (`seed/01-policy.ts`) | GONE — no route declares the subject; `AiRoutingPolicy` writes are super-admin-only. | `ai-model-consolidation-seed.test.ts` ("grants tenant admins NOTHING on the retired AiTaskDefault subject"), `tenant-admin-authority.test.ts` |
| `AiTaskDefault` Prisma model, `AiTaskDefaultEntity/Factory/EntityMapper/Model/Repository` (+3 tests), barrels, `CoreDatabaseModule` registration, `TENANT_SCOPED_MODELS` + `SYSTEM_SHARED_READ_MODELS` entries | GONE. | `gen:model:check` (184, no drift), `gen:entity:check` / `gen:factory:check` (105, no drift, coverage OK), `tenant-scope.test.ts` (90 tenant-scoped models) |
| `ResourceType.AiTaskDefault` (domains enum + `audit.prisma`) | KEPT, marked retired in both — a Postgres enum value cannot be dropped in place; historical `AuditLog` rows still name it. | — |
| `seed/16-ai-routing-policy.ts` | The three `text.*` SYSTEM elections (`…004`, `…005`, `…010`), the two `.fallback` exemptions and the five text kind entries are gone; nine elections remain. | `ai-model-consolidation-seed.test.ts` (nine, deterministic ids, no `text.*`), `task-858-text-generation-defaults.test.ts` |
| `HarnessPolicy.textProvider` / `textModel` | Columns GONE (`harness.prisma`); entity/factory/model fields, `HarnessPolicyKnobs`, `SUPER_ADMIN_ONLY_POLICY_KEYS`, `entityToKnobs`, the PATCH DTO fields and the console GLOBAL-tab controls + tenant lock entries go with them. The RESPONSE keeps `textProvider`/`textModel`, documented as derived from the assigned agent's primary (`apps/harness` reads them unchanged). | `harness-policy.service.test.ts` ("serves no policy-row text selection …"), `harness-policy.agent-first-text.task876.test.ts`, console `policy-fields.test.ts` + `harness-policy-screen.test.tsx` |
| `seed/13-harness-policy.ts` | Rewritten to "ensure the SYSTEM row exists" — create-only, WORM entry on creation, no text default; `SYSTEM_HARNESS_POLICY_TEXT_DEFAULTS` gone. | `seed.test.ts` (create-only block), `ai-model-consolidation-seed.test.ts` |
| Console `shared/catalog/ai-task-keys.ts` + lockstep test | GONE — zero consumers besides its own test. | `pnpm --filter @arcaai/admin-console build lint test` |
| `apps/api/tests/e2e/ai-task-defaults-cross-tenant.spec.ts` | GONE with the route. | — |
| Six cross-lane e2e specs (`task-615-*` ×4, `task-729`, `task-779`) | The "tenant discovery" read moved to `GET /admin/nlp-task-instructions/row?taskKey=nlp.topic` (same tenant-scoped placeholder shape); `task-729`'s sentiment/toxicity block and `task-779`'s two-tier walk over the retired surface are removed with a pointer to the unit pins; `task-779`'s tenant-admin 403 probe now targets the instructions surface. NOT runnable in this lane (needs the live gateway) — see Handoffs. | — |
| `packages/vox-node/src/resources/admin/admin-resource.ts` | References nothing retired; untouched. The generated `ai-task-default.ts` resource under `src/resources/admin/**` drifts until `gen:admin`. | — |

### Findings worth recording

- **A live SQL reader of the dropped table survives outside this lane:**
  `apps/harness/src/harness/eval/judge/selection.py:75` (`_SELECT_SQL`, `resolve_eval_judge_selection`,
  used by the `apps/harness/eval/run-gate.sh` CI eval gate) selects the judge from
  `core."AiTaskDefault" ⋈ core."AiModel" ON m.slug = d."modelSlug"`. TASK-862's "nothing reads
  this table" missed it. It has been answering from stale seed leftovers since TASK-862 (no writer
  touched the table after the facade write-through ended) and errors outright once the migration
  drops the table. Replacement query in Handoffs.
- **The facade's write-time `taskType` compatibility check retires with it.** `upsertRow` refused a
  slug whose `AiModel.taskType` disagreed with `AI_TASK_MODEL_TASK_TYPES[taskKey]`;
  `AiRoutingPolicyService.create/update` never had that check (super-admin writes were always
  unguarded on this axis). Recorded under Deferred with the seam.
- **`providerConfigRef.taskKey` on `core.agent` nodes** resolves generation capabilities through
  `AI_TASK_KEYS` (`resolveConfigurationRow`); a node still naming a retired text key now answers
  UNKNOWN capabilities — the same fail-safe an unknown key always took (`supportedGenerationParams`
  undefined). The schema property is a free string, so no contract change.
- **`text.live` / `text.finalize` / `text.test` strings are not residue** where they survive:
  `packages/workflow-contract` node schemas, `apps/harness` interpreter nodes,
  `prompt-resolution.service.ts` and the live-documentation `task_key` stat all use them as a
  workflow-node prompt-binding / telemetry key (TASK-876), never as a routing selector.
- **The committed `route-manifest.json` still lists the four deleted routes**, so
  `svc-scope-route-ability-coverage.test.ts` reports exactly those four pairs red
  (`AiTaskDefaultAdminController.{getEffective,getOptions,getRow,upsertRow}` "is reachable holding
  only svc:admin:ai-task-default:manage") until the orchestrator regenerates the manifest. Keeping
  a dead scope in the registry to hide that would have been the dual-homing the brief forbids.
- The `/ai-task-defaults` console redirect stub had already been deleted in TASK-862 (register
  row: "removed"); there was no route left to give a one-release `redirect()`.

### Gate evidence (this worktree, HEAD `9e2e01bf6` unless noted)

```
pnpm --filter @arcaai/database test          Test Files  2 failed | 77 passed (79)   Tests  8 failed | 1755 passed (1763)
   the 8 = ai-model-registry-seed.test.ts ×4 + task-863-agents.test.ts ×4 (pre-attributed: TASK-869's 36th catalogue row)
pnpm gen:model:check                          check: no drift — 184 generated file(s) match the committed files.   (185 → 184: AiTaskDefaultModel)
pnpm gen:entity:check                         check: no drift — 105 generated file(s) … Schema coverage OK: 103 entity artifact(s) cover every persisted column of 107 Prisma model(s)
pnpm gen:factory:check                        check: no drift — 105 generated file(s) … Schema coverage OK: 103 factory artifact(s) … 107 Prisma model(s)
pnpm --filter @arcaai/domains build           tsc — BUILD_EXIT=0
pnpm --filter @arcaai/domains test            Test Files  158 passed | 2 skipped (160)   Tests  1907 passed | 2 skipped | 9 todo (1918)
pnpm --filter @arcaai/applications build      BUILD_EXIT=0
pnpm --filter @arcaai/applications lint       ✖ 216 problems (0 errors, 216 warnings)   — none of the warnings is on a line this lane wrote
                                              (the only two on new lines, harness-policy.response.ts:58/61, were fixed in 9e2e01bf6; summary.service.ts:587 predates the lane)
pnpm --filter @arcaai/applications test       (full run at a390c7be9^, before the three count-pin fixes)
                                              Test Files  4 failed | 658 passed | 1 skipped (663)   Tests  10 failed | 11614 passed | 4 skipped (11628)
                                              10 = 4 expected (svc-scope-route-ability-coverage: the four deleted-route manifest pairs)
                                                 + 2 count pins fixed since (apikey-scopes.registry: 55 admin / 58 reserved — re-run 35/35 green)
                                                 + 3 asr-agent-resolver.service.test.ts + 1 vault-kv-coverage.test.ts — pre-existing at base
                                                   (azure-foundry in CLOUD_BYO_PROVIDERS.stt and the tts.serviceToken descriptor removal both land in
                                                    1e50834d7; `git diff 1e81c4966..HEAD --stat` over those areas is empty)
pnpm --filter @arcaai/applications test (HEAD) Test Files  3 failed | 659 passed | 1 skipped (663)   Tests  8 failed | 11616 passed | 4 skipped (11628)
                                              8 = the 4 manifest-drift pairs (svc-scope-route-ability-coverage) + asr-agent-resolver ×3 + vault-kv-coverage ×1 (pre-existing at base)
pnpm --filter @arcaai/api typecheck           TYPECHECK_EXIT=0
pnpm --filter @arcaai/api test  (HEAD)        Test Files  1 failed | 278 passed | 2 skipped (281)   Tests  3 failed | 4197 passed | 4 skipped (4204)
                                              3 = stt-internal.controller.test.ts (azure-foundry — pre-existing at base, same commit as above)
pnpm --filter @arcaai/api lint                ✖ 70 problems (5 errors, 65 warnings) — the 5 errors are the pre-attributed TASK-869/875 ones in
                                              auth-throttle-per-endpoint.spec.ts ×3, harness-gate.spec.ts, shared-component-contracts.spec.ts (all untouched by this lane)
pnpm --filter @arcaai/admin-console build     BUILD_EXIT=0 (0 `error TS`; the "Ecmascript file had an error" lines are the pre-existing instrumentation.ts Edge-runtime warnings)
pnpm --filter @arcaai/admin-console lint      eslint src --max-warnings 0 — LINT_EXIT=0
pnpm --filter @arcaai/admin-console test      Test Files  257 passed (257)   Tests  2271 passed (2271)
pnpm harness:test                             NOT RUN — nothing the harness reads changed (the policy RESPONSE shape is unchanged; only the PATCH DTO lost two fields).
```

### Count reconciliation

The base was not re-measured in this worktree (batch-1's recorded totals were taken on the primary
at other points), so the reconciliation is derived from this lane's diff against `1e81c4966`
(`git diff --name-status` over `*.test.ts(x)`, `it`/`test` cases counted with `.each` expanded):

| Package | Test files | Cases | Detail |
|---|---|---|---|
| `@arcaai/applications` | −6 +2 (`ai-task-default/__tests__/*` gone; `task-key-vocabulary.test.ts` new, `ai-task-kind.test.ts` moved) | −52 +40 = **−12** | removed: facade service 23, kind 9, sentiment/toxicity 4×2, PII 6, text keys 4, vlm 4, effective-settings `models.*` 5, settings-registry 4, text-test-routing 3, fail-mode 1 (then 1 re-added), … ; added: vocabulary 4 + 33 `each` cases, kind 10, unknown-key 4, … |
| `@arcaai/domains` | −3 | **−12** | the two `AiTaskDefaultRepository` tests + the mapper test |
| `@arcaai/database` | 0 | **−6** | seedHarnessPolicy 4 → 2, consolidation seed −2 +1, task-858 −1 +1, … (count pins 91→90, 12→9 ×3 changed values, not cases) |
| `@arcaai/api` | −1 | **−17** | `ai-task-default-admin.controller.test.ts` deleted; the routing-controller test keys switched `text.finalize` → `harness.judge` (no case change) |
| `@arcaai/admin-console` | −1 | +5 −4 = **+1** | lockstep test −2; `policy-fields` RETIRED_KEYS 2→4 (+4) and the Generation-group test (+1); screen LOCKED 5→3 (−2); measured 2271 |

### Residue (grep `models\.` / `AiTaskDefault` / `aiTaskDefault` over `apps packages tests`, excluding dist / generated / docs)

Live references — exactly two, both intentional:

- `packages/domains/src/enums/generated/ResourceType.ts:52` (+ `audit.prisma`) — the retained enum member, marked retired.
- `packages/applications/src/services/ai-routing-policy/__tests__/task-key-vocabulary.test.ts` /
  `effective-settings.service.test.ts` / `platform-storage-settings.resolver.test.ts:61` — the
  `models.*` strings are ABSENCE assertions.

Comment- or description-only mentions that describe history accurately and stay (outside this lane
or not worth the churn): `ai-routing-policy.service.ts`, `IAiRoutingPolicyService.ts`,
`AiRoutingPolicyEntity.ts` / `Repository.ts` (the absorption story), `ai-routing-policy.prisma`,
`tenant-nlp-task-instructions*`, `tenant-scope.ts` precedent references, ~25 `*EntityMapper.ts`
headers naming `AiTaskDefaultEntityMapper` as the OCC-strip exemplar, `mcp-server-admin.service.*`,
`rbac/role.service.ts`, `settings-registry-write.service.ts`, `entitlements.descriptors.ts`,
`harness-sensor.descriptors.ts`, `seed/11-global-setting.ts`, `seed/index.ts`, `seed/ai-models/*`,
`enums.prisma`, `stt.prisma`, `mcp-server.prisma`, `usage-ledger.prisma`, `ai-model.prisma`,
console `nav-config.test.ts` / `retired-route-redirects.test.tsx` / `speech-and-voice-screen*`,
`apps/api` `mcp-admin.controller.ts` / `ai-model-discovery.controller.ts` /
`nlp-task-instructions-admin.controller.ts`, e2e `task-635` / `task-641` comments, and 56 Python
files (docstrings and comments; `apps/guardrail` has read `AiRoutingPolicy` since TASK-862).

Stale DESCRIPTIONS in files other lanes own (each a one-line handoff below):
`prompt-management/dto/test-prompt-template.request.ts:47`,
`packages/workflow-contract/src/node-config-schemas.ts:734,1005,2172`,
`packages/agentic-sdk-v2/src/types/liveSummary.ts:12`,
`apps/api/src/modules/consultation/harness-internal.controller.ts:375`,
`consultation/harness/dto/realtime-delivery.dto.ts:134`, `consultation/shared/nerUsageEvent.ts:33`.

### Deferred (with seams)

| Item | Seam |
|---|---|
| Write-time `AiModel.taskType` ↔ task-key compatibility on `AiRoutingPolicy` writes (the facade's `upsertRow` check; the routing service never had it) | `AiRoutingPolicyService.create` / `update` (`ai-routing-policy.service.ts`, the block that resolves `dto.modelId`) — add an `assertModelServesTask(taskKey, model)` keyed on a re-homed `taskKey → ModelTaskType` map; the deleted map's content is in `1e81c4966:packages/applications/src/services/ai-task-default/constants.ts`. |
| Data cleanup of the five retired `text.*` `AiRoutingPolicy` rows on existing databases | Owner decision + the soft-retire `UPDATE` recorded under Implementation Plan; the seed no longer writes them. |
| The e2e specs this lane edited were not executed (no live gateway in the worktree) | Orchestrator's e2e run at close; the four repointed discovery reads rely on `GET /admin/nlp-task-instructions/row` echoing `tenantId` for a super admin with a working tenant, which `task-729` already exercised. |

## Handoffs

| To | What | Why it matters |
|---|---|---|
| **Orchestrator — migration** | The SQL under Implementation Plan: `DROP TABLE core."AiTaskDefault"`, two `ALTER TABLE core."HarnessPolicy" DROP COLUMN`. Nothing staged under `migrations/`. | Rule 02; the enum member is deliberately NOT dropped (Postgres cannot). |
| **Lane D / `apps/harness` owner — BEFORE the migration lands** | `apps/harness/src/harness/eval/judge/selection.py` `_SELECT_SQL` still reads `core."AiTaskDefault"`. Replace with:<br>`SELECT m.provider AS provider, m."sourceUri" AS model_id, m.slug AS model_slug FROM core."AiRoutingPolicy" p JOIN core."AiModel" m ON m.id = p."modelId" WHERE p."taskKey" = $1 AND p."tenantId" = $2 AND p."isDefault" = true AND p.enabled = true AND p.status = 'ACTIVE' AND p."resourceStatus" = 'ENABLED' AND m."resourceStatus" = 'ENABLED' LIMIT 1` (the `ORDER BY (m."tenantId" = $2)` tie-break is unnecessary — the FK names one row). `apps/harness/eval/run-gate.sh:69,78` messages name the old table too. | The CI eval gate fails closed ("judge selection unavailable") today on any DB seeded after TASK-862, and raises a missing-relation error after the drop. |
| **Orchestrator — five-artifact regeneration** | `api:route-manifest`, `openapi`, `portal`, `gen:admin` after this merge: four routes, one tag (`admin-ai-task-defaults`), one scope, the `UpdateHarnessPolicyRequest` fields and three DTO classes left the surface; `packages/vox-node/src/resources/admin/ai-task-default.ts` is the generated resource that goes. | Until then `svc-scope-route-ability-coverage.test.ts` reports the four deleted-route pairs red (see gates). |
| **Orchestrator — e2e** | `ai-task-defaults-cross-tenant.spec.ts` deleted; `task-615-{usage-ledger,usage-analytics-cross-tenant,invoice-lifecycle,billing-cross-tenant}`, `task-729`, `task-779` edited (details in the table above). Not run here. | The route-authz matrix regenerates from the manifest; these depth specs need one live run. |
| **Lane D** | Cross-lane edits made because the deleted token forced them (minimal, mechanical): `consultation/summary/summary.service.ts` (+ module, + the NER doubles in its tests), `prompt-management/__tests__/text-test-routing.test.ts` (imports + the retired `text.test` describe). Stale descriptions left for D: `test-prompt-template.request.ts:47` ("resolve the `text.test` AiTaskDefault" — the bench is agent-first), `node-config-schemas.ts:734,1005,2172`, `harness-internal.controller.ts:375`, `realtime-delivery.dto.ts:134`, `nerUsageEvent.ts:33`. | The first two would not compile/load otherwise; the descriptions are OpenAPI/schema text that now names a retired tier. |
| **Whoever owns `packages/agentic-sdk-v2`** | `src/types/liveSummary.ts:12` doc comment still calls `task_key` "the resolved AiTaskDefault key". | Comment only. |
| **Reviewers** | Seven pre-existing reds at base, none in this lane's files: `asr-agent-resolver.service.test.ts` ×3, `stt-internal.controller.test.ts` ×3 (azure-foundry joined `CLOUD_BYO_PROVIDERS.stt` in `1e50834d7` without those tests moving), `vault-kv-coverage.test.ts` ×1 (`TTS_SERVICE_TOKEN` still read at `agent.controller.ts:250`, `harness-tts-internal.controller.ts:242` after the descriptor was removed in the same commit). | Batch-1 handoff fallout, not this ticket's. |

## Change History

| Date | Change |
|---|---|
| 2026-09-06 | Ticket opened in the batch-2 worktree; plan written after mapping every reader of the facade, the vocabulary, the descriptors and the two columns. |
| 2026-09-06 | Implemented in thirteen commits: vocabulary re-homed + descriptors deleted (`bf54d974c`), NER path repointed (`e43c1b2fc`), judge + modelWeights (`b789ff2ad`), gateway readers (`bd4c96432`), facade/routes/scope/CASL/e2e removal (`e805a48ee`), schema + domain trio (`46ec97987`), HarnessPolicy columns + seeds (`bbe7e0ce5`), console catalogue + register (`e7f9012ce`), count pins (`a390c7be9`), style (`9e2e01bf6`). Gates as recorded above; the harness eval judge SQL found still reading the table and handed off. Final full `@arcaai/applications` run at HEAD: 659/663 files, 11616 passed, 8 failed (4 manifest-drift + 4 pre-existing), 4 skipped. |
