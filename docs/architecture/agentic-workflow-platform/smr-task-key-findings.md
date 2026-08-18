# `smr.*` task-key plane — consistency findings

| | |
|---|---|
| **Date** | 2026-08-17 |
| **Origin** | TASK-707 closing verification of the deliberately FROZEN `smr.*` identifiers |
| **Scope** | `AiTaskDefault.taskKey` values `smr.*`, and the `HarnessPolicy.smrProvider` / `smrModel` columns |
| **Proposed follow-up** | TASK-740 (number free; needs owner confirmation before work starts) |

**No renames are proposed.** Per the owner's 2026-08-17 decision the `smr.*` DB-persisted identifiers
stay frozen. Everything below is a producer/consumer *consistency* defect that exists independently
of naming.

## Seeded surface (complete)

`seed/16-ai-task-default.ts` is the only `AiTaskDefault` writer in the repo. It seeds exactly three
keys: `smr.live` (:89), `smr.finalize` (:95), `smr.test` (:110). The two fallback keys
(`smr.live.fallback`, `smr.finalize.fallback`) are deliberately unseeded — an opt-in contract stated
in four places and fail-OPEN by design. That part is correct and consistent.

## Actionable defects

| # | Severity | Finding |
|---|---|---|
| **D-1** | High | **`generate.text` validates `taskKey`, then ignores it.** `apps/harness/.../interpreter/nodes/text_generate.py:91-99` checks `config.taskKey` against `{smr.finalize, smr.live, smr.test}`, then `:123` resolves the model from `policy.smr_provider`/`smr_model` — the `HarnessPolicy` columns, never the `AiTaskDefault` row for that key. `getEffectivePolicy` (`harness-policy.service.ts:374-426`) overlays `judgeProvider`/`judgeModel` from the `harness.judge` default but has **no equivalent overlay for smr**; the AiTaskDefault-first path lives only in `resolveSmrSelection` (:538-567), which `/internal/harness/policy` never calls. Consequence: every workflow `generate.text` node resolves the same model regardless of its taskKey, and the three seeded rows are inert on the Python path (they ARE honored on the TS path). The node's own docstring claims the opposite. |
| **D-2** | High | **`smr.test` is seeded and backend-live but invisible in the console.** The console mirror `apps/admin-console/src/features/ai-task-defaults/api/types.ts` lists 11 keys vs the backend's 15 and omits `smr.test`; `READ_ONLY_TASK_KEYS` filters out everything starting `smr.`, and the primary/fallback lists don't include it. So no console surface shows it, while `resolveTestSmrTarget` is fail-closed — an unconfigured tenant gets a `BadRequestException` for a value it cannot set. The file's own docstring warns against exactly this drift. |
| **D-3** | High | **Console renders `smrProvider`/`smrModel` as tenant-editable; the backend 403s them.** Both are in `SUPER_ADMIN_ONLY_POLICY_KEYS` and the tenant `PATCH` path rejects them, but `harness-policy/components/policy-fields.ts:80-81` renders them unlocked with no super-admin hint, mounted on the tenant route. Because the patch is sparse, the 403 fires precisely when a tenant admin edits either field. Same defect in a second place: `ai-task-defaults/api/harness-policy-summary-types.ts:66-67` labels both `controlledBy: 'tenant'`. |
| **D-6** | High | **SDK config paths point at retired rows.** `packages/agentic-sdk-v2/src/core/ConfigSchema.ts:140-141` maps `smr.provider`/`smr.model` to `GlobalSetting` rows that `seed/11-global-setting.ts:571-574` actively lists in `RETIRED_GLOBAL_SETTING_KEYS` and sweeps to `DELETED`, superseded by `AiTaskDefault`. Note this is the `GlobalSetting` namespace, not a task key — the dotted form invites misreading. |
| **D-7** | Medium | **Dead alias.** `summary/text-generate.ts:101,107` reads a three-name chain ending in `defaultSmrProvider`/`defaultSmrModel`; nothing in the monorepo writes those two. The first two aliases are live. |
| **D-4** | Low | `'smr.test.fallback'` (`harness-policy.service.ts:56`) is an unregistered, unseeded literal. Currently unreachable — no caller passes `'test'`, and the resolver is fail-open — but it is a live literal outside `AI_TASK_KEYS`. |
| **D-5** | Low | Two comments (`ai-task-default/constants.ts:19-20`, `model-defaults.descriptors.ts:85`) still describe an `smr.test → smr.finalize` fallback that the implementation deliberately removed. Runtime is correct; the docs mislead. |

## Verified as benign (recorded so they are not re-investigated)

TS camelCase ↔ Python snake_case at the harness boundary is explicitly aliased and test-asserted ·
`stats.task_key` snake_case in the live-summary payload is a different payload with no shared consumer ·
`HarnessPolicy.smrModel` (provider-native id) vs `AiTaskDefault.modelSlug` (catalog slug) are two
intentional naming domains with a seed test asserting the link · `llmOverrides` using bare
`live`/`finalize` is intentional and documented · `smrProvider` is correctly excluded from agent
overrides on both the write and read sides · Prometheus `smr_provider_health`, structlog `smr.*`
event names and the Redis `smr:task:` prefix are unrelated namespaces.

## Why this matters beyond tidiness

D-1 and D-2 together mean the `AiTaskDefault` plane — the platform's declared mechanism for
tenant-first model selection — is **partially inert**: honored on the TypeScript path, bypassed on
the workflow path, and unmanageable for one of its three seeded keys. That undercuts the
tenant → SYSTEM resolution rule in `00-project-context.md` §Configuration Principles, so it should be
fixed before more palettes are built on `generate.text`.
