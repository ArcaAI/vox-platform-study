# TASK-888 — Wave-3a residue

| | |
|---|---|
| **Status** | Review |
| **Type** | refactor (removal) + one bugfix + one feature |
| **Program** | TASK-870 — Configuration Governance, wave 3a (residue lane) |
| **Branch** | `task-888-wave3a-residue` |
| **Base** | `a62a466e0` (`dev-2.2` with all six wave-3a lanes merged) |
| **Merge target** | `dev-2.2` (orchestrator, from the primary checkout) |

## Requirement Analysis

Wave 3a's six lanes each left work they could not finish inside their own
ownership column. This lane closes those five items. They share nothing but
their origin, so each is stated as its own deliverable with its own proof.

1. **The shared TEXT token, end to end.** Owner decision D-D: one devops-set
   `INTERNAL_ACCESS_TOKEN` authenticates every internal hop. TTS finished in
   waves 1/3a; TEXT was blocked because ~10 `packages/applications` call sites
   still passed `TEXT_SERVICE_TOKEN` to `resolveInternalAccessToken` as a legacy
   fallback name, and `scripts/vault-seed-secrets.sh` derives its key list from
   the descriptors — so deleting the descriptor while a reader survived would
   break a Vault-backed deployment and nothing else. The rule the wave follows:
   **the READ retires first, the descriptor follows it.**
2. **`TenantTtsConfig` retirement.** TASK-879 (D1) retired every reader and
   demoted the console to read-only, but the model, the domain trio and the
   scope registry were outside its ownership.
3. **The Azure ASR provider identity** (TASK-880 DEFERRED-1). The cloud ASR
   catalogue rows declare `provider: 'azure'` while the `stt` BYO vocabulary
   says `azure-speech`, so a streaming session on an Azure ASR agent resolves no
   credential.
4. **A write-time task check on `AiRoutingPolicy`** (TASK-881 deferral). The
   retired `AiTaskDefault` facade refused a model whose `taskType` could not
   serve the task key; the routing service inherited the vocabulary but not the
   check.
5. **A stale-mention sweep**, plus ONE wave-wide deprecation-register entry
   separating what wave 3a removed outright from what it deprecated.

Out of scope, held by the owner: the five stale `text.*` `AiRoutingPolicy` rows,
a per-workflow-node fallback override, `pipeline.templateResync.*`.

## Current State Evaluation

Measured on the base commit, not remembered. Four of the brief's premises were
already stale and are recorded here so the next lane does not re-check them:

| Premise as briefed | What the code actually said |
|---|---|
| `apps/text` presents `TEXT_SERVICE_TOKEN` under its `TEXT_` prefix and needs the TTS treatment | ALREADY DONE. `InternalAccessConfig.token` (`core/config.py:95`) reads the unprefixed `INTERNAL_ACCESS_TOKEN` and nothing else; `test_config.py:241` and `test_task799_phase0.py:87` pin the legacy name INERT. So every gateway reader was authenticating against a credential the service could not present. |
| `asr-agent-resolver.service.test.ts` ×3 and `stt-internal.controller.test.ts` ×3 are RED at base | GREEN. `0b1ef2743` (an ancestor of the base) already moved those six `resolveProviderOverrides` expectations from 3 providers to 4. |
| `eval/run-gate.sh` and `eval/judge/selection.py` still name `AiTaskDefault` | Already repointed by TASK-881; only `apps/harness/eval/README.md` had not followed. |
| `apps/admin-console/tests/e2e/pipeline-policy.spec.ts` drives the retired redirect page | The spec is already deleted; only the page is left for R4. |

Two findings the brief did not anticipate:

- **`ServiceReleaseTokenGuard` lost the shared token.** TASK-879/880 struck
  `TTS_SERVICE_TOKEN` from `KNOWN_SECRETS` without putting `INTERNAL_ACCESS_TOKEN`
  in its place, so a migrated TTS process could self-register at
  `/internal/service-releases` only when some OTHER service's legacy secret
  happened to hold the same value. Fixed here (deliverable 1 would have hit the
  same wall for TEXT).
- **The retired `AI_TASK_MODEL_TASK_TYPES` map is WRONG against the current
  seed.** It declared `guardrail.safety` as `TOKEN_CLASSIFICATION`, but the
  seeded default for that key (`gliguard-llm-guardrails-300m`) is
  `TEXT_CLASSIFICATION`. Re-homing it verbatim would have made the platform's own
  seed unwritable through its own API.

## Implementation Plan

TDD throughout: a failing test that names the defect, then the minimal change.
Five commits, one per deliverable, in dependency order (the token retirement
first because the descriptor deletion gates the secret scripts).

1. `internal-access-token.text-callers.test.ts` (RED 16/24) -> the 11 call
   sites, the two guard maps, the warm list, the descriptor and its echoes.
2. The harness `AiTaskDefault` comment sweep (comments only; `harness:lint` +
   `harness:typecheck` are the proof it changed nothing else).
3. `cloud-asr-provider-identity.contract.test.ts` (RED 2/4) -> widen
   `AI_MODEL_PROVIDERS` in both mirrors, repoint the two seed rows.
4. Ten new cases in `ai-routing-policy.service.test.ts` (RED 4) ->
   `assertModelServesTask` + the re-homed compatibility map +
   `AiModelRepository.findByIdOrNull`, with a seed-conformance contract test.
5. `TenantTtsConfig` removal, then the documentation sweep.

## Implementation Summary

### 1. TEXT joins the ONE shared internal token (`5543c2747`)

| What | Where | Reader replaced |
|---|---|---|
| 10 legacy-name call sites | `packages/applications` | `summary.service.ts:1713`, `chain-summary.service.ts:675`, `pre-summary.processor.ts:334`, `comprehensive-summary.processor.ts:455`, `live-documentation.service.ts:3443,3508,3607`, `prompt-management.service.ts:1429`, `agent-invocation.service.ts:106`, `dna-writing-style.processor.ts:493` |
| the 11th | `apps/api` | `ai-model-discovery.service.ts:359` |
| `SERVICE_SECRETS.text` | `apps/api` | `internal-service-token.guard.ts:35` -> `INTERNAL_ACCESS_TOKEN` |
| `KNOWN_SECRETS` | `apps/api` | `service-release-token.guard.ts:29` -> `INTERNAL_ACCESS_TOKEN` (which was MISSING — see Current State) |
| warm list | `packages/applications` | `common.service.module.ts:36` |
| the descriptor | `packages/applications` | `platform-secrets.descriptors.ts` + `fail-mode.governance.test.ts:169` |
| the secret scripts | `scripts/` | `generate-env-file.sh` `_GENERATED_SECRET_KEYS`, `generate-prod-secrets.sh` `GENERATE_KEYS`, the legacy list in `__tests__/env-sync.test.ts` |
| stale readers of the same name | `scripts/`, e2e | `dev-doctor.sh` (probed `/api/v1/providers` with a token TEXT no longer accepts, so the check always read "zero providers"), `test-run.sh` + `model-retention-settings.spec.ts` (`E2E_INTERNAL_ACCESS_TOKEN`), `tests/helpers/test-app-module.ts`, the `apps/text` and `packages/py-env` READMEs |

Every call site uses the established no-legacy idiom
`resolveInternalAccessToken(this.secretsService, 'INTERNAL_ACCESS_TOKEN')`
(`voiceProfile.service.ts:228` and `stt/pipeline.service.ts:677` already did),
so `resolveInternalAccessToken`'s signature is unchanged.

**Proof:** `internal-access-token.text-callers.test.ts` replaces
`text-service-token-migration.test.ts`, which pinned the OPPOSITE invariant (16
of 24 cases RED before the change, 24 green after); both guard suites gained a
"no longer accepts the retired name" case and the service-release suite a
shared-token case (4 RED, 24 green).

### 2. `TenantTtsConfig` retirement (`b5b301b0e`)

Verified before deleting — no tenant-owned data is orphaned. `.tenantTtsConfig.`
appears in exactly two places tree-wide, both in `seed/19-tenant-tts-config.ts`.
Every other access goes through `TenantTtsConfigRepository`, injected only into
`TenantTtsConfigService`, reachable only from `TenantTtsConfigAdminController`.
No model carries a `@relation` to it (`tenantId` is a bare `String @unique`), so
the drop needs no FK cleanup. Per column: the eleven effective fields map onto
the TEXT_TO_SPEECH agent's `parameters`, its model chain, the connection rows'
three-state `enabled` and `AiModel._metadata.voices`; `taskKind` had no reader
and no writer at all beyond its column default; BYO credentials moved to
`AiProviderConnection(service='tts')` in TASK-862.

Removed: the `.prisma` file, the model/entity/factory/mapper/repository and their
five barrel lines, the `CoreDatabaseModule` provider+export, both tenant-scope
allow-list entries, `services/tenant-tts-config/**` and its barrel line, the
`admin:tenant-tts-config:manage` scope, `apps/api/src/modules/tenant-tts-config/**`
with its `app.module` registration and both bootstrap-audit rows, the CASL grant,
the seed, its call, the service-account scope and the seed test.

KEPT: `ResourceType.TenantTtsConfig` in BOTH enums with a RETIRED note — a
Postgres enum value cannot be dropped in place and historical `AuditLog` rows
name it. Same treatment TASK-881 gave `AiTaskDefault`.

**Console — the route is NOT retired.** `/ai-configuration`'s Speech tab reads
the LIVE `TenantSttConfig`, so a `redirect()` stub would have taken a surviving
surface with it. `speech-and-voice-screen.tsx` moved into
`features/tenant-stt-config/components/` (the feature of the one binding it
still reads) and its Voice tab became what the brief asked to keep: the links to
`/agents?task=TEXT_TO_SPEECH`, agent assignments and provider keys. That tab now
reads nothing, so it is gated on `Agent` instead of the deleted subject.

Count pins, each with a one-line `n -> n-1` comment:

| Pin | Where | Change |
|---|---|---|
| `TENANT_SCOPED_MODELS.size` | `extensions/__tests__/tenant-scope.test.ts:162` | 88 -> 87 |
| `SYSTEM_SHARED_READ_MODELS` set literal | same file, :427 | member removed |
| `ADMIN_SCOPED_CONTROLLERS.length` | `bootstrap/__tests__/admin-scope-audit.test.ts:207` | 63 -> 62 |
| `EXPECTED_ROW_COUNT` | `bootstrap/__tests__/task-773-admin-scope-map.test.ts:43` | 58 -> 57 |
| `admin.length` | `apiKey/__tests__/apikey-scopes.registry.test.ts:263` | 54 -> 53 |
| `reservedKeys().length` | same file, :296 | 57 -> 56 |

### 3. One spelling names Azure on the `stt` plane (`25a8a374d`)

`AI_MODEL_PROVIDERS` had no `azure-speech` member, so both cloud ASR rows
declared the LLM-plane `azure` while the seeded `AiProviderConnection` row, both
`apps/stt` loaders' `override_key` and `CLOUD_BYO_PROVIDERS.stt` all said
`azure-speech` / `azure-foundry`. `AsrAgentResolverService.resolveCredentials`
reads `spec.models.asr.provider` and gates on `isCloudByoProvider('stt', …)`, so
a streaming SESSION on an Azure ASR agent resolved NO credential and the loader
failed closed. Batch was unaffected — `resolveProviderOverrides` iterates
`CLOUD_BYO_PROVIDERS.stt` itself and never reads the model's provider.

Widened in BOTH mirrors (held equal by the existing parity contract), the two
rows repointed, `config-plane-seed.test.ts` excludes the two new ids from the
`llm` connection coverage as `sarvam` already is, `task-863-agents.test.ts`'s
registry mirror follows. `AiModel.provider` is a plain `String?` with no enum or
CHECK, so **no migration is involved**. The bare `azure` in `CLOUD_STT_PROVIDERS`
stays and is now documented as the `provider::model` SHORTHAND-prefix vocabulary
a tenant may have typed into a fallback pointer — not `AiModel.provider`, and
not a credential gate.

**Proof:** `tests/contracts/cloud-asr-provider-identity.contract.test.ts` reads
the REAL seed rows and drives the resolver with an agent stamped with the seeded
value. The unit tests could not catch this: they mock the agent off
`resolved-asr-spec.fixture.json`, which already carried the correct spelling.

### 4. Write-time task check on `AiRoutingPolicy` (`31b5a358d`)

`assertModelServesTask(taskKey, dto.modelId, tenantId)` on `create` and
`update`. Two deliberately different answers: a model id that resolves to
nothing OR belongs to another tenant is **404** (the cross-tenant posture — this
surface is not an existence oracle over other tenants' catalogues); a model the
caller can see whose task type cannot serve the key is **409
`ROUTING_MODEL_TASK_MISMATCH`**, the house `ConflictException({code, message})`
shape the ASR/TTS agent resolvers use. A `modelRef` binding is skipped: it names
a model the catalogue does not carry, so there is no `taskType` to compare. On
`update` the key comes off the persisted ROW, never the body.

`AI_TASK_MODEL_TASK_TYPES` is re-homed into `ai-routing-policy/constants.ts` as
a SET per key rather than the retired single value, for two reasons: content
safety genuinely ships as both a text classifier and a token classifier, and the
single-valued map is exactly what made the retired one wrong (see Current State).
`AiModelRepository.findByIdOrNull(id, tx)` is the lookup — `null` rather than
`DataNotFoundException`, and the same `tx` routing rule as `findBySlug` so the
super-admin cross-tenant lane still sees the target tenant's own rows.

**Proof:** 10 new cases (4 RED before), plus
`tests/contracts/routing-task-model-compatibility.contract.test.ts`, which joins
the seeded elections to the catalogue and is verified to bite — narrowing
`guardrail.safety` to `TOKEN_CLASSIFICATION` fails it by name.

### 5. Stale-mention sweep (`98d6bd489`, `14eb23e0e`)

13 `AiTaskDefault` mentions in `apps/harness` and 17 documentation files. Every
line was checked against current behaviour first, which mattered: the harness
comments claimed `config.taskKey` SELECTS the model, and since TASK-876 it does
not — the tenant's assigned `TEXT_GENERATION` agent does (`AgentAssignment`
carries no role dimension, so a task key never chose which agent serves). The
guardrail and judge selections resolve `AiRoutingPolicy` default rows.

The deprecation register gains ONE wave-wide section stating the POSTURE: wave 3a
removes a redundant old-architecture surface completely (pre-production, no
customer data), and exactly two items keep an R4 window because a consumer the
wave does not own still reaches them — `pipeline.templateResync.*` (its cron
service is still constructed) and the `/harness/pipeline-policy` redirect page.
The two `ResourceType` members are named as what they are: tombstones, not
deprecations.

`.claude/rules/{03-domain-layer,06-python-services,09-infrastructure-devops}.md`
still name `AiTaskDefault` as a live exemplar/tier — NOT edited: those files are
the project's own instructions, and a lane brief is not authority to change them.
Reported under Handoffs.

## Intended migration SQL

Authored here, **not** staged under `packages/database/src/prisma/db_main/migrations/`
(rule 02: Prisma applies every subdirectory that contains a `migration.sql`,
whatever it is named). It belongs in the orchestrator's single wave-3a
schema-retirement migration:

```sql
-- TASK-888 — TenantTtsConfig is retired. The speech path is agent-first since
-- TASK-879: every field this table carried lives on the TEXT_TO_SPEECH Agent
-- (`parameters`, its model chain), on an AiProviderConnection(service='tts')
-- row, or on AiModel._metadata.voices. No other table references it.
DROP TABLE core."TenantTtsConfig";
```

Deliberately NOT in the migration:

- `ResourceType.TenantTtsConfig` is **not** dropped from the Postgres enum —
  Postgres cannot drop an enum value in place, and historical `AuditLog` rows
  name it. Both the `.prisma` enum and the domains enum keep the member with a
  RETIRED comment, exactly as TASK-881 left `AiTaskDefault`.
- Deliverable 3 changes two seed rows' `provider` STRING. `AiModel.provider` is a
  plain `String?` with no enum and no CHECK constraint, so it needs no DDL. An
  already-seeded database re-seeds create-only, so a pre-existing row keeps
  `'azure'` until re-seeded — a data question for the orchestrator, not a schema
  one, and the same `UPDATE core."AiModel" SET provider = 'azure-speech' WHERE
  slug = 'azure-speech-stt';` / `… 'azure-foundry' … 'mai-transcribe-1.5';` pair
  would fix it if the owner wants existing rows migrated.

## Verification

Actual output, not assertions. Every red is attributed.

| Gate | Result |
|---|---|
| `pnpm text:test` | `1620 passed, 4 skipped, 16 deselected` — the pre-change baseline exactly |
| `pnpm text:lint` | `Found 2 errors` — both `W291 Trailing whitespace`, in `models/provider.py:47` and `tests/unit/test_judge_route.py:469`. Both files are byte-identical to the base commit (`git diff --quiet a62a466e0 HEAD --`); the ONLY file this lane changed under `apps/text` is `README.md`, which ruff does not lint |
| `pnpm text:typecheck` | `Success: no issues found in 81 source files` |
| `pnpm harness:lint` | `All checks passed!` |
| `pnpm harness:typecheck` | `Success: no issues found in 148 source files` |
| `pnpm --filter @arcaai/database test` | `8 failed | 1725 passed` — the SAME eight pre-existing failures by name as the pre-change baseline (`ai-model-registry-seed` ×4, `task-863-agents` ×4). Total moved 1736 -> 1725 because this lane deleted `tenant-tts-config-seed.test.ts` |
| `pnpm gen:model:check` | `no drift — 181 generated file(s) match the committed files` |
| `pnpm gen:entity:check` | `no drift — 102 generated file(s)`; `Schema coverage OK: 100 entity artifact(s) cover every persisted column of 104 Prisma model(s)` |
| `pnpm gen:factory:check` | `no drift — 102 generated file(s)`; `Schema coverage OK: 100 factory artifact(s) … 104 Prisma model(s)` |
| `pnpm --filter @arcaai/domains build` | clean |
| `pnpm --filter @arcaai/domains test` | `156 passed | 2 skipped` files, `1892 passed | 2 skipped | 9 todo` |
| `pnpm --filter @arcaai/applications build` | clean |
| `pnpm --filter @arcaai/applications lint` | `✖ 215 problems (0 errors, 215 warnings)` — gate is 0 ERRORS. All 215 are prettier warnings in three `workflow-*` files this lane never touched |
| `pnpm --filter @arcaai/applications test` | `4 failed | 11542 passed | 4 skipped` — all four in `svc-scope-route-ability-coverage.test.ts`, which reads the generated `apps/api/route-manifest.json` still listing the deleted `admin/tts-config` routes. H-2 |
| `pnpm --filter @arcaai/api typecheck` | clean (EXIT=0) |
| `pnpm --filter @arcaai/api test` | `277 passed | 2 skipped` files, `4172 passed | 4 skipped` |
| `pnpm --filter @arcaai/api lint` | `✖ 71 problems (6 errors, 65 warnings)` — all 6 errors in `tests/e2e/{auth-throttle-per-endpoint,harness-gate,shared-component-contracts}.spec.ts`, each byte-identical to base. The one e2e spec this lane DID edit (`model-retention-settings.spec.ts`) lints clean |
| `pnpm --filter @arcaai/admin-console build` | clean |
| `pnpm --filter @arcaai/admin-console lint` | clean |
| `pnpm --filter @arcaai/admin-console test` | `256 passed` files, `2265 passed` |
| `npx vitest run scripts/__tests__ tests/contracts` | `5 failed | 459 passed` — all five in `env-sync.test.ts`: four drift comparisons plus "leaves no secret unclassified", every one of them `TEXT_SERVICE_TOKEN`-shaped and every one cleared by H-1. Proven to be artifact-only: restoring the four files this lane touched to `HEAD~1` and re-running gave `39 passed` |

`@arcaai/vox` was not touched, so its suites were not run.

### Grep residue, with a reason per survivor

`TEXT_SERVICE_TOKEN` — no production LOOKUP survives anywhere. What remains:

| Survivor | Reason |
|---|---|
| ~20 comments in `apps/{api,text}`, `packages/applications` | Each records what was retired and why. `internal-access-token.text-callers.test.ts` and both guard suites deliberately assert the name is NOT looked up |
| `apps/text` test fixtures (`test_config.py`, `test_task799_phase0.py`, `test_internal_access_token.py`, `conftest.py`) | They set the legacy name to PROVE it is inert. Deleting them would delete the proof |
| `secrets-coverage.test.ts:29` | An anti-regression list ("no source file may read this via `process.env`"), not a reader. Kept deliberately |
| `HARNESS_TEXT_SERVICE_TOKEN`, `NLP_EXTERNAL_TEXT_SERVICE_TOKEN` | DIFFERENT variables (harness's and nlp's own per-pair copies), out of scope |
| `apps/api/.env.prod:123`, `docs/research/**`, `execution-log.md` | Dated records; `docs/research` is a historical corpus |
| `.env.sample` ×2, `turbo.json`, `env-surface.generated.md`, `scripts/generated/` | Generated. H-1 |

`text.serviceToken` — three comments recording the removal, one register row, one dated execution-log line. No descriptor.

`TenantTtsConfig` — no model, no service, no route, no scope, no seed. What remains:
`ResourceType` in both enums (a Postgres enum value cannot be dropped — a
tombstone, annotated as one), ~30 comments across `apps/{tts,api,harness}` and
`packages/{applications,types,database}` recording what replaced the fold,
`packages/vox-node/src/resources/admin/**` (GENERATED — H-2), the two committed
migrations that created the table, and `packages/vox-node-codegen`'s naming
example (a generic function's worked example, unaffected by the deletion).

`AiTaskDefault` — `apps/harness` is swept (only
`test_task881_judge_selection_source.py` names it, which is the guard's job).
Roughly 60 comment/docstring sites survive in `apps/{text,guardrail,nlp}`,
`packages/{applications,domains,database}` and `docs/architecture`, plus
`apps/guardrail/{README,GUARDIAN_INTEGRATION}.md` — TASK-881 recorded these as
known residue ("56 Python files") and they are outside this lane's named scope.
H-7. Two further sites are `.claude/rules/**` — H-5, deliberately not edited.

## Handoffs

| # | To | What |
|---|---|---|
| H-1 | **Orchestrator — env regeneration** | `env:python-surface` THEN `env:sync` on a freshly built `@arcaai/applications`. `TEXT_SERVICE_TOKEN` leaves the registry, so it must drop out of `.env.sample`, `apps/api/.env.sample`, `turbo.json#globalEnv` and `env-surface.generated.md`. **Until then 5 cases in `scripts/__tests__/env-sync.test.ts` are RED** (4 drift comparisons + "leaves no secret unclassified", which reads the committed `.env.sample`). Verified green at base with `git checkout HEAD~1 --` on the four files I touched, so the reds are purely the un-regenerated artifacts. |
| H-2 | **Orchestrator — five-artifact regeneration** | `api:route-manifest`, `api:openapi`, `api:portal`, `gen:admin`. Four `admin/tts-config` routes, one tag, one scope and the `TenantTtsConfig`/`UpdateTenantTtsConfigRequest` schemas left the surface; `packages/vox-node/src/resources/admin/tenant-tts-config.ts` is the generated resource that goes, with its `admin-namespace.ts` / `index.ts` / `schemas.ts` / `audit.ts` entries. **Until then 4 cases in `svc-scope-route-ability-coverage.test.ts` are RED** — it reads the generated `apps/api/route-manifest.json`, which still lists the deleted routes. Same fallout TASK-881 and TASK-882 each recorded. |
| H-3 | **Orchestrator — migration** | The `DROP TABLE` above, in the single wave-3a schema-retirement migration. Nothing staged under `migrations/`. |
| H-4 | **Deployment repo** (`arca/hope-v2-deployment`) | `TEXT_SERVICE_TOKEN` must come out of the dev overlay's config/secret entries wherever it is set, and the Vault policy paths that grant read on `secret/data/hope/TEXT_SERVICE_TOKEN` can go. Read-only for this lane. NOTE: `infrastructure/docker/configs/vault/dev-init.sh:143` and `policies/k8s/hope-{api,text}.hcl` still seed and grant that path in THIS repo — left untouched deliberately, because the TTS retirement left its own equivalents in place and diverging would be worse than a consistent sweep later. |
| H-5 | **Rules owner** | `.claude/rules/03-domain-layer.md:33,82` names `AiTaskDefault*` as the hand-authored exemplar to copy — those files no longer exist; `AiProviderConnection*` is the surviving half of the same sentence. `09-infrastructure-devops.md:278,296` and `06-python-services.md:42` still describe `AiTaskDefault` as the live selection tier (it is `AiRoutingPolicy`). Not edited here: those are the project's own instructions. |
| H-6 | **e2e** | `apps/api/tests/e2e/model-retention-settings.spec.ts` now reads `E2E_INTERNAL_ACCESS_TOKEN` (set by `scripts/test-run.sh` from `.env.test`'s `INTERNAL_ACCESS_TOKEN`); the env-gated half of that spec is skipped unless it is set. Not run here — no live gateway in the worktree. |
| H-7 | **Whoever owns the guardrail docs** | `apps/guardrail/{README,GUARDIAN_INTEGRATION}.md` and ~10 `apps/guardrail` docstrings still name `AiTaskDefault` as the live selection tier. TASK-881 recorded them as known residue (56 Python files); out of this lane's named scope, and a sweep of them is one focused change rather than a by-product of five. |

## Change History

| Date | Change |
|---|---|
| 2026-09-06 | Ticket opened. Five deliverables implemented in five commits, TDD throughout. Four of the brief's premises measured stale (recorded under Current State Evaluation) and two unbriefed defects found and fixed: `ServiceReleaseTokenGuard` had lost the shared token when `TTS_SERVICE_TOKEN` was struck from it, and the retired `AI_TASK_MODEL_TASK_TYPES` map disagreed with the current seed on `guardrail.safety`. Status -> Review. |
