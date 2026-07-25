# TASK-558 — Environment Configuration Refactor

| Field | Value |
|---|---|
| **Status** | Review |
| **Type** | refactor (+ infrastructure, security-hygiene) |
| **Branch** | `fix/2605-review` (current) |
| **Owner** | Tap Huynh |
| **Created** | 2026-07-25 |
| **Sub-tickets** | 558-A … 558-G (parallel agent lanes, §7) |
| **Related** | TASK-002 (Environment Loading Refactor, archived), TASK-504 (Settings-control architecture), TASK-496 (per-tenant TTS config), TASK-506 (model registry), TASK-557 (script/port taxonomy) |

---

## 1. Requirement Analysis

Refactor the monorepo's environment-variable declaration and consumption to current best practice. Five explicit requirements from the owner:

- **R1** — Review whether centralizing env vars in one file is best practice.
- **R2** — Identify redundant and unused variables.
- **R3** — Recommend which KEYS move to **database** or **Vault** (e.g. `MINIO_*` → DB, managed by global/super admin as the default storage configuration).
- **R4** — Recommend best-practice patterns for **reading / fetching / refreshing** keys and values from database or Vault.
- **R5** — Propose a **simple, maintainable KEY/VALUE scheme** for the remaining dotenv files, replacing the current mesh.

Out of scope (explicit owner decision, 2026-07-25): **credential rotation is deferred** — the project is pre-production. See §6 Residual Risk.

---

## 2. Current State Evaluation

### 2.1 Inventory (measured 2026-07-25)

**21 `.env*` files in the working tree · 561 distinct keys · 4 independent loading mechanisms.**

| File | Keys | Lines | Tracked | Actually read by |
|---|---:|---:|---|---|
| `.env.example` | 284 | 905 | yes | nothing at runtime — but `scripts/dev-infra.sh:47` **copies it to `.env`** |
| `.env.dev` | 168 | 506 | **yes (committed)** | TS only, via `loadEnv()` |
| `.env` | 129 | 335 | no | docker compose **and every Python service** |
| `.env.archive` | 124 | 288 | yes | nothing (dead) |
| `.env.production` | 65 | 170 | yes | reference only |
| `.env.test` | 58 | 189 | yes | all test suites, via `dotenv-cli` |
| 15 per-app `.env*` | ~500 | — | mixed | mostly nothing |

### 2.2 Six loaders that disagree

> **Corrected during wave 3 (lane G).** This section originally said FOUR loaders and misdiagnosed the boot-ordering defect. Both corrections are recorded inline below rather than silently edited away, because the wrong version was the basis for the lane split.

| # | Loader | Reads | Notes |
|---|---|---|---|
| 1 | `loadEnv()` — `packages/applications/src/common/env/index.ts` | `NODE_ENV` → `.env.dev` / `.env.test` / `.env.production` | The **intended** canonical path (TASK-002). Reached only via `ConfigService`. |
| 2 | `prisma.config.ts:30` (root) | same map, **duplicated** | Independent copy of the NODE_ENV→file table. |
| 3 | `packages/database/prisma.config.ts` | same map, **third copy** | Found in wave 2. |
| 4 | **`packages/database/src/env.ts`** | own map, **module-scope auto-load** | Found in wave 2 (lane B). The most consequential one: importing `@arcaai/database` loads env as a SIDE EFFECT, which made it the FIRST loader to run in `apps/api`. |
| 5 | **`packages/tools/src/prisma-commander/index.ts`** | own inline copy | Found in wave 2 (lane B). |
| 6 | `_load_dotenv_into_environ()` | **`.env` only — never `.env.dev`** | Copy-pasted into `apps/{smr,harness,guardrail,tts}/…/config.py` (4 near-identical bodies), plus two bare `dotenv.load_dotenv()` calls in `nlp`. |

(`scripts/dev-service.sh` was counted as a loader in the original draft. It is not one — it supplies shell DEFAULTS via `: "${VAR:=default}"`, which is a different failure mode: they outrank nothing but silently substitute for config the service should have read itself. Lane C removed the application-config ones.)

**Consequence (the core defect):** TS services and Python services read *different files* in dev. Editing `.env.dev` changes the gateway and has **zero effect** on STT/SMR/guardrail/harness/TTS, which are configured by `.env` (a stale copy of `.env.example`) plus shell defaults. `.env.example`'s own header calls `.env` "deprecated (backwards compatibility)" — yet it is the only file half the platform reads.

**Secondary defect — boot ordering. The original diagnosis was WRONG.** This section claimed the four pre-bootstrap `process.env` reads in `apps/api/src/main.ts` (`PORT` :62, `LOG_LEVEL` :44, `CORS_ALLOWED_ORIGINS` :194, `SHUTDOWN_TIMEOUT_MS` :136) "see host env only". Lane B proved otherwise: `process.env` was **already populated** at that point, because importing `@arcaai/applications` transitively imports `@arcaai/database`, whose `src/env.ts` loads the env file at MODULE SCOPE (loader #4). The values were correct.

The real defect is subtler and worse: **correctness depended on an undeclared import side effect.** Nothing in `main.ts` said "an import populates my environment", no test pinned it, and the ordering would have broken silently the moment someone reordered imports, made the database import lazy, or dropped the module-scope load. Lane B made the load EXPLICIT in `main.ts` and left a marked seam for lane D's schema. Loader #4 survives deliberately — `@arcaai/applications` depends on `@arcaai/database`, so importing the canonical module there would be a circular package edge — but it is now a documented mirror pinned by `packages/database/src/__tests__/env.test.ts`.

### 2.3 Redundancy and dead keys (R2)

> **Corrected during waves 1 and 3.** The "76 dead keys" figure below was wrong. Lane A's verification pass found **65** genuinely dead keys — 11 of the original 76 are ALIVE, read through pydantic `Settings` classes whose fields carry no prefix, so the naive prefix-based scan missed them. Of those 65, **56 actually existed in a file** and were deleted; the rest were `turbo.json#globalEnv` entries with no file declaration. Lane D's D7 then added 4 more. The prose below is the original scan and is kept for the reasoning, not the number.

- **76 keys** are declared in env files and read by **no** code, compose file, manifest, or CI job. Whole dead subsystems: `LANGFLOW_*` (6), `FEDL_*` (8), `PERMIT_*` (3), `LANGFUSE_*` (3), `MLFLOW_*` (3), `AZURE_OPENAI_{TEMPERATURE,TOP_P,MAX_TOKENS,FREQUENCY_PENALTY,PRESENCE_PENALTY}`, `SUMMARY_AGENT_*`, `JWT_REFRESH_SECRET`, `JWT_REFRESH_EXPIRES_IN`, `DATABASE_URL_DIRECT`, `DEBUG_PRISMA`, `DEBUG_MODE`, `SKIP_SEED`, `MODEL_CACHE_*`, `WORKER_CONCURRENCY`, `TRANSCRIPTION_{CHUNK,STRIDE}_LENGTH_S`, `VOICE_PROFILE_MIN_SIMILARITY`, `TTS_{AUDIO_CACHE_MAX_SIZE,BATCH_JOBS_MAX_SIZE,MINIO_BUCKET}`, `AZURE_TTS_*`.
- **9 legacy shims**: `SMR_V2_*` (8) + `STT_V2_URL`, alive only through `_promote_legacy_smr_v2_env()` (`apps/smr/…/config.py:356`), a "one transition window" bridge from the `stt-v2`→`stt` rename.
- **`.env.archive`** — 124 keys, tracked, referenced only by two archived docs. Delete.
- **Shadowed keys**: bare `QDRANT_URL`, `QDRANT_TIMEOUT`, `QDRANT_POOL_SIZE`, `QDRANT_COLLECTION_*` are dead — harness reads them under the `HARNESS_RETRIEVAL_` pydantic prefix. The un-prefixed copies look authoritative and configure nothing.
- **Duplicate keys inside one file** (silent last-wins): `QDRANT_URL` twice in `.env`, `.env.dev` and `.env.example`; `MLFLOW_TRACKING_URI` twice in `.env` and `.env.example`.
- **`turbo.json#globalEnv` drift**: 198 entries, 29 of which do not exist in `.env.example`; conversely several vars the code reads are unregistered, so Turbo's cache key misses them.
- **Undeclared but read**: `DIRECT_URL` (required by `packages/database/src/migration-url.ts` for every production migration) appears in **no** env file.

### 2.4 Tracked credentials

`.env.dev` is committed at HEAD containing `VAULT_ROLE_ID`, `VAULT_SECRET_ID`, `VAULT_DB_ADMIN_PASS`, `API_KEY_PEPPER`, `QDRANT_API_KEY`, `TTS_SARVAM_API_KEY`, `AZURE_OPENAI_API_KEY`, `MINIO_SECRET_KEY`, `POSTGRES_PASSWORD`.

**Root cause — a typo in `.gitignore:86-92`:**

```
.env
.dev.dev            ← intended .env.dev
.dev.development    ← intended .env.development
.dev.test           ← intended .env.test
.dev.staging        ← .env.staging
.dev.prod           ← .env.prod
.dev.production     ← .env.production
```

`.env.` was typed as `.dev.` on six consecutive lines, so none of the environment files were ever ignored. `.gitleaks.toml` does not allowlist `.env.dev` either — the values simply never matched a rule.

### 2.5 What already exists (do NOT rebuild)

TASK-504/496/506 delivered most of the target architecture. The refactor is largely **classification and convergence**, not new infrastructure:

| Component | Path | State |
|---|---|---|
| `SettingDescriptor` + 7-tier taxonomy | `services/settings-registry/registry.types.ts` | Built. Tiers: `vault-kv`, `db-secret`, `db-config`, `global-kv`, `redis-flag`, `entitlement`, `env` |
| Scope cascade (`system→tenant→department→doctor`) + max-scope clamp | `settings-registry/scope-cascade.ts` | Built |
| `EffectiveSettingsService` (read facade) | `settings-registry/effective-settings.service.ts` | Built |
| `SettingsRegistryWriteService` (OCC writes) | `settings-registry/settings-registry-write.service.ts` | Built |
| `GlobalSetting` KV with Vault-Transit `encryptedValue` + `keyVersion` | `db_main/globalSetting.prisma` | Built |
| `SecretsService` — LRU + per-entry TTL, `invalidate()`, `boot({warmupKeys})`, **Redis pub/sub cross-node eviction** | `baseServices/_meta/secrets/SecretsService.ts` | Built |
| Vault lease renewal + rotation worker | `secrets/vault-lease-renewer.ts`, `vault-rotation-worker.ts` | Built |
| `TenantStorageConfig` with `credentialsRef` → SecretsService | `db_main/tenant-bucket.prisma:122` | Built — **but the global/platform default row is not implemented**; the model comment defers it to "global/shared config (env / AppSettings)" |
| `AiProviderConnection` / `AiRuntimeProfile` / `AiTaskDefault` | TASK-506 | Built |

**The gap is coverage, not capability.** The original text here read *"only 15 descriptors exist (19 `global-kv`, 3 `db-config`, 1 `db-secret`, 1 `entitlement`)"* — **both numbers were wrong, and they contradicted each other**: the breakdown sums to 24, not 15. The measured figure at the pre-558 baseline (`780a7bee`) was **62**. The conclusion — the framework is built but idle relative to 561 keys — was correct; only the magnitude was misstated.

After lane F the registry holds **137 descriptors**, measured at wave-2 HEAD by enumerating `HOPE_SETTINGS_REGISTRY.list()`:

| Tier | Count |
|---|---:|
| `global-kv` | 50 |
| `env` | 37 |
| `vault-kv` | 25 |
| `db-config` | 20 |
| `entitlement` | 3 |
| `db-secret` | 2 |
| **total** | **137** |

### 2.6 Divergent read paths (R4 problem statement)

Four different ways a service obtains admin-controlled config today:

| Service | Mechanism | Cache |
|---|---|---|
| API gateway | `EffectiveSettingsService` cascade (in-process) | per-request |
| TTS | **Gateway resolves and injects** into a stateless service (TASK-496) | n/a |
| Guardrail | **Direct SQL** (`AiTaskDefault ⋈ AiModel ⋈ AiRuntimeProfile`) via SQLAlchemy+asyncpg | hand-rolled 60 s TTL + negative caching |
| STT | Its own read-only DB access | separate |

`apps/guardrail/src/guardrail/core/tenant_config.py:24` states the divergence outright: *"Guardrail deliberately keeps this SQL resolver rather than adopting the HTTP effective-config client the other services use."* Each path invented its own TTL, its own fail-open/fail-closed choice, and its own invalidation story (mostly: none).

> **Corrected during wave 3 (lane G).** Two of those three charges do not survive verification:
>
> - **"invented its own TTL"** — guardrail's TTL is not a hardcoded 60. It is declared config: `settings.db.config_cache_ttl_s` (env `GUARDRAIL_V2_DB_CONFIG_CACHE_TTL_S`), passed in at construction in `main.py`. The 60 is a default, not a magic number.
> - **"its own fail-open/fail-closed choice"** — guardrail is fail-CLOSED on provider/model selection (503 in `core/dependencies.py`, no env fallback) and fail-safe to env on tuning. That is exactly the split lane F generalised as `SettingDescriptor.failMode`, so it is the policy, not a deviation from it.
>
> **"no invalidation" is the one charge that stands** — and only for guardrail. See the correction under §4 B2 for the TS side, and §7 lane G for the verdict on keeping the SQL resolver.
>
> STT is also mischaracterised as a divergent cached reader. `pipeline/config_reader.py` (the actual DB-reading config path — not `core/config/`, which is pydantic/env only) holds **no cache at all**: every call queries, and every query is tenant-filtered. It has no TTL to converge and no cache to invalidate.

---

## 3. Answers to R1 / R3 / R5

### 3.1 R1 — One file? No. One *schema*, many small files.

Best practice for a monorepo of this size:

1. **The source of truth is a typed schema, not a file.** One good instance exists — `apps/admin-console/src/config/env.ts` (zod, fail-fast, lazily validated). `apps/api` has no equivalent.
2. **One `.env.example` per deployable**, generated from that deployable's schema. A 284-key root example forces every developer and CI job to carry config for services they never run, and is precisely why 76 keys rotted unnoticed.
3. **One loader implementation**, imported everywhere (currently four).
4. **Committed files contain no secrets** — only non-secret defaults and `<CHANGE_ME>` placeholders.

So: centralize the **contract**, decentralize the **files**.

### 3.2 R3 — Which keys move to DB / Vault

**The governing principle — the bootstrap floor:**

> A variable MUST stay in env if it is required *to reach* the database or *to authenticate* to Vault. Everything else is a candidate for DB or Vault.

This is objective, testable, and settles every case without debate.

**Tier assignment (target; `SettingDescriptor.tier` values):**

| Tier | Moves there | Examples |
|---|---|---|
| **`env`** (stays) — bootstrap floor, ~55 keys/deployable | connection identity + topology + process identity | `NODE_ENV`, `DATABASE_URL`, `DIRECT_URL`, `PRISMA_PG_MAX`, `PG_*`, `REDIS_{HOST,PORT,URL}`, `VAULT_ADDR`, `VAULT_ROLE_ID`, `VAULT_{SECRET_ID,WRAPPED_SECRET_ID}`, `SECRETS_PROVIDER`, all `*_PORT`, all `*_URL` service endpoints, `OTEL_*`, `LOG_FILE_*`, `SERVICE_NAME`, `HOSTNAME`, `CI` |
| **`vault-kv`** — platform secrets, operator-set | every shared credential | `JWT_SECRET_KEY`, `SESSION_SECRET_KEY`, `API_KEY_PEPPER`, `{STT,SMR,NLP,GUARDRAIL,HARNESS,TTS}_SERVICE_TOKEN`, `REDIS_PASS`, `MQTT_PASS`, `MINIO_{ACCESS,SECRET}_KEY`, `QDRANT_API_KEY`, `AZURE_*_KEY`, `TTS_SARVAM_API_KEY`, `GUARDRAIL_VLLM_API_KEY`, `HARNESS_JUDGE_OPENAI_COMPAT_API_KEY`, `HARNESS_CLAIM_CHECK_{ACCESS,SECRET}_KEY`, `VAULT_DB_ADMIN_PASS` |
| **`db-secret`** — per-tenant secret, Transit ciphertext in a DB column | BYO tenant credentials | `TenantStorageConfig.credentialsRef` (DEDICATED topology), `TenantTtsProviderCredential` (already built) |
| **`db-config`** — non-secret typed config, dedicated table + cascade | anything an admin tunes per tenant | storage endpoint/region/TLS/prefix, provider tuning (`SMR_VLLM_*`, `GUARDRAIL_VLLM_*` model/timeout/concurrency → `AiRuntimeProfile`), retention windows |
| **`global-kv`** — platform KV, `GlobalSetting` | platform-wide non-secret knobs | `RATE_LIMIT_*`, `API_KEY_MAX_LIFETIME_DAYS`, `API_KEY_ALLOW_QUERY_PARAM`, `REFRESH_TOKEN_TTL_SECONDS`, `CORS_ALLOWED_ORIGINS`, `LOG_LEVEL`, `SHUTDOWN_{TIMEOUT,DRAIN_DELAY}_MS` |
| **`redis-flag`** — instant fan-out kill-switch (must default OFF) | feature gates | `ENTITLEMENTS_ENABLED_DEFAULT`, `TENANT_IDP_ENABLED`, `REGISTRATION_SELF_SIGNUP_ENABLED`, `*_GROUNDEDNESS_ENABLED`, `SMR_EXTERNAL_GUARDRAIL_ENABLED`, `HARNESS_{WARM_START,NER_PRIORS,ATOMIC_FACT,CLAIM_CHECK}_ENABLED`, `SEMANTIC_ENDPOINT_ENABLED` |
| **delete** | 76 dead + 9 `*_V2_*` shims | §2.3 |

**The `MINIO_*` case specifically (the owner's example) — no new table needed.**

`TenantStorageConfig` already models everything (`provider`, `topology`, `endpoint`, `region`, `forcePathStyle`, `containerPrefix`, `credentialsRef`), and its resolution order already reads *"bucket-specific row → tenant default row → global/shared config"*. Implement the missing third step as a **SYSTEM-tenant row with `bucketId = NULL`**:

```
core."TenantStorageConfig"
  tenantId = 00000000-0000-0000-0000-000000000000   (SYSTEM)
  bucketId = NULL
  provider = MINIO, topology = SHARED
  endpoint, region, forcePathStyle, containerPrefix   ← ex-MINIO_* env vars
  credentialsRef = 'platform/storage/minio'           ← Vault kv-v2, NOT a DB column
```

Gated `globalOnly: true` in the descriptor → GLOBAL_ADMIN only, per the imperative-privilege pattern of rule 05. `MINIO_ENDPOINT`/`REGION`/`USE_SSL` become env-tier **fallbacks used only when the SYSTEM row is absent** (first boot / seed ordering), then are removed one release later. Credentials never enter the database — that is the model's existing, correct contract.

### 3.3 R5 — KEY/VALUE naming scheme

**One setting, one predictable name in both worlds:**

```
DB / descriptor key   storage.minio.endpoint        (dotted, lowerCamel segments)
Env var               STORAGE_MINIO_ENDPOINT        (SCREAMING_SNAKE, mechanical 1:1)
Python pydantic       env_prefix="STORAGE_"  field  minio_endpoint
```

Rules:

1. **`<DOMAIN>_<CONCERN>[_<DETAIL>]`.** The `<DOMAIN>` prefix is fixed per deployable and **must equal** that service's pydantic `env_prefix` — no exceptions, so a reader never has to guess whether `QDRANT_URL` or `HARNESS_RETRIEVAL_QDRANT_URL` is live.
2. **No un-prefixed duplicates.** If a service reads it under a prefix, the bare name must not exist.
3. **No version suffixes.** `SMR_V2_*`, `STT_V2_URL`, `GUARDRAIL_V2_*` are deleted, not aliased.
4. **Booleans are `true`/`false`; durations carry a unit suffix** (`_MS`, `_S`, `_SECONDS`, `_DAYS`); lists are comma-separated with no spaces.
5. **One declaration per key per file** — CI rejects duplicates.
6. **Every key is declared in exactly one schema**, which generates the example file, the `turbo.json#globalEnv` entry, and the docs row.

**Target file layout (the "no mesh" answer):**

| File | Committed | Contents |
|---|---|---|
| `.env.dev` | **no** (gitignored) | local dev overrides — bootstrap floor only, ~55 lines |
| `.env.test` | yes | test bootstrap only, ~55 lines, no real secrets |
| `.env.production` | yes | reference template, placeholders only |
| `.env.example` | yes, **generated** | root bootstrap floor only |
| `apps/*/.env.example` | yes, **generated** | that app's schema |
| `.env` | **deleted** | compose gets a generated `.env.docker` (~15 interpolation vars) |
| `.env.archive` | **deleted** | dead |

Net effect: **561 declared keys → ~120**, largest file **905 lines → ~60**.

---

## 4. R4 — Read / fetch / refresh best practices

**B1 — One resolution contract per consumer class.**
- TS in-process → `EffectiveSettingsService` (cascade + clamp).
- Python request-scoped → **gateway-resolved and injected** (the TASK-496 TTS pattern). Stateless services do not open their own DB connection.
- Direct SQL resolvers (`guardrail/core/tenant_config.py`, STT's reader) are converged onto the effective-config client. Any remaining exception must be justified in a descriptor comment, not a docstring.

**B2 — TTL is a floor, invalidation is the mechanism.** `SecretsService` already has a Redis pub/sub eviction channel used by the rotation worker. Extend the same channel to settings: a `GlobalSetting`/`db-config` write publishes an eviction; every node drops the entry. TTL becomes a safety net (60–300 s), not the propagation path. Today each consumer invented its own TTL and none invalidate.

> **Corrected during wave 3 (lane G) — the premise was stale, and the prescription would have been a regression.**
>
> "None invalidate" is false for the `global-kv` tier. A dedicated settings channel already exists (F-007): `AppSettingsService` publishes on **`app-settings:invalidate`** after a `GlobalSetting` write and subscribes to it on `onModuleInit`, so peers converge on push. The full chain — `SettingsRegistryWriteService.write()` → `broadcastSysEvent(ResourceUpdated)` → `handleGlobalSettingUpdated` → local refresh + publish → peer refresh — was already wired; what was missing was a test proving it end to end, now added (`settings-registry/__tests__/settings-write-invalidation.test.ts`). The 45s refresh cron is already the backstop, not the mechanism.
>
> Moving settings onto the **`arca:secrets:invalidate`** channel as literally instructed was therefore **rejected**: it would have replaced a working, purpose-built channel with one whose payload contract is per-key SECRET eviction (`{key}` / `{all}`), conflating two different concerns and coupling the settings cache to the secret-rotation worker's message schema. Two channels for two lifecycles is the correct design; `SecretsService` needed no extension.
>
> The genuine remaining gap is **guardrail**, whose per-tenant SQL cache still converges only on TTL. Closing it requires a PUBLISHER on the gateway side for `AiTaskDefault` / `AiModel` writes; a subscriber in guardrail without one would be dead code, so it was deliberately not added. Recorded as follow-up work, not silently shipped half-wired.

**B3 — Failure mode is declared, not decided at the call site.** Add to `SettingDescriptor`:

```ts
/** What happens when the value cannot be resolved. */
failMode: 'closed' | 'open-to-default';
```

- Secrets and provider/model **selection** → `closed` (guardrail's fail-closed posture is correct — promote it to policy).
- Tuning knobs and feature flags → `open-to-default`, falling back to `descriptor.default`.
- Negative caching for one TTL window on backend errors — already implemented in guardrail, generalize it.

**B4 — Startup contract, three severities.**
- Missing **env-tier** var → **fail fast** at boot (zod, before `NestFactory.create`).
- Missing **secret** → fail closed at first use; `boot({warmupKeys})` surfaces it at startup as a WARN, not a crash (existing behavior, keep).
- Missing **db-config / global-kv** → resolve to `descriptor.default`, log once.

**B5 — Never read config at module scope.** All four pre-bootstrap `process.env` reads in `apps/api/src/main.ts` move behind the validated schema. Secrets are reached only via `SecretsService.getSecret()` (async, cached) or the pre-warmed sync accessor.

**B6 — Dynamic credentials by default.** `vault-lease-renewer.ts` and `PG_DYNAMIC_CREDS` exist but are opt-in. Make dynamic DB credentials the documented default for deployed environments; static `DATABASE_URL` credentials become the dev-only path.

**B7 — Rotation-safe keys.** `API_KEY_PEPPER` invalidates every API key when changed. It moves to `vault-kv` **with `keyVersion`**, mirroring `GlobalSetting.encryptedValue`/`keyVersion`, so a rotation can be staged rather than being a cliff.

**B8 — Auditability.** Every `db-config`/`global-kv` write already flows through `SettingsRegistryWriteService` with OCC + sys-events. Vault writes get the same treatment via `VAULT_AUDIT_LOG_PATH`. No configuration change should be invisible.

---

## 5. Implementation Plan

Five phases, mapped to the parallel lanes in §7.

**Phase 0 — Hygiene (lane A, blocking).** Fix the six `.gitignore` typos; `git rm --cached .env.dev`; delete `.env.archive`; add a gitleaks rule that fires on any tracked `.env.*` that is not `*.example`; delete the 76 dead keys and 9 `*_V2_*` shims; de-duplicate `QDRANT_URL` / `MLFLOW_TRACKING_URI`; add the missing `DIRECT_URL`.
*Verify:* `git ls-files | grep '\.env'` returns only `*.example` + `.env.production`; `pnpm verify` green.

**Phase 1 — One loader (lanes B + C, parallel).** `loadEnv()` becomes the single TS implementation (`prisma.config.ts` imports it). One shared Python env module replaces the four copies **and learns the `NODE_ENV`→`.env.dev`/`.env.test` map**, ending the split-brain.
*Verify:* a value changed only in `.env.dev` is observed by SMR, guardrail, harness and TTS; `pnpm stack:dev:doctor` green.

**Phase 2 — Retire `.env` (lane B tail).** Reduce to a generated `.env.docker` of the ~15 keys compose interpolates; `dev-infra.sh` generates it from `.env.dev` instead of copying the 905-line example.
*Verify:* `pnpm infra:dev:up` + `infra:dev:status` green from a clean tree.

**Phase 3 — Schema + generation + gate (lane D).** zod schema per TS deployable; `pnpm env:sync` generates every `.env.example`, `turbo.json#globalEnv`, and the docs table; `env-drift-check` CI job in `.gitlab/ci/validate.yml` mirroring the existing `generate-*-check` gates.
*Verify:* `pnpm env:sync --check` reports no drift; CI job red on a deliberate edit.

**Phase 4 — Tier migration (lanes E + F, parallel).** Storage config to DB/Vault (SYSTEM-tenant row + admin surface + seed); descriptors authored for the ~80 admin-controllable keys; platform secrets seeded into Vault kv-v2.
*Verify:* changing the SYSTEM storage row alters upload behavior with no redeploy; `settings-registry` catalog test asserts descriptor coverage.

**Phase 5 — Read-path convergence + docs (lane G).** Guardrail/STT SQL resolvers → effective-config client; settings eviction over the existing Redis channel; `failMode` added and honored; rules `00`/`01`/`09` and `docs/development-guide.md` updated.
*Verify:* full gate sweep; a `GlobalSetting` write propagates to all nodes without a TTL wait.

---

## 6. Residual Risk (owner-accepted)

Credential rotation is **deferred by owner decision (2026-07-25)**. Accepted consequences, to be discharged before any production/public exposure:

- The credentials in §2.4 remain in git history even after `git rm --cached`; untracking prevents *future* commits, not past disclosure.
- Rotation list when the time comes: Vault AppRole (`VAULT_ROLE_ID` + `VAULT_SECRET_ID`), `VAULT_DB_ADMIN_PASS`, `API_KEY_PEPPER` (invalidates all API keys — stage via `keyVersion`, see B7), MinIO root + access keys, `POSTGRES_PASSWORD`, `QDRANT_API_KEY`, `TTS_SARVAM_API_KEY`, `AZURE_OPENAI_API_KEY`.
- Still open from the 2026-07-24 CI work: **GitLab OAuth client secret + API token rotation**.
- History rewrite vs. rotate-and-move-forward is an open owner decision.

---

## 7. Sub-tickets — parallel agent lanes

**File ownership is disjoint by design.** A prior session in this tree destroyed unstaged work (see project memory); every lane **stages its own files (`git add`) at each milestone** and touches only the paths listed.

| Lane | Title | Owns (files/dirs) | Depends on | Size |
|---|---|---|---|---|
| **558-A** | Hygiene & dead-key removal | `.gitignore`, `.gitleaks.toml`, all `.env*` files, delete `.env.archive` | — | S |
| **558-B** | Unified TS loader + retire `.env` | `packages/applications/src/common/env/**`, `prisma.config.ts`, `packages/tools/src/utils/loadEnv.ts`, `scripts/dev-infra.sh` | A | M |
| **558-C** | Unified Python loader | new shared env module, `apps/{smr,harness,guardrail,tts,stt,nlp}/**/config.py`, `scripts/dev-service.sh` | A | M |
| **558-D** | Schema, `env:sync` generator, CI drift gate | `apps/api/src/config/**`, `apps/admin-console/src/config/**`, `scripts/env-sync.*`, `turbo.json`, `.gitlab/ci/validate.yml` | B, C | L |
| **558-E** | Storage config → DB + Vault | `services/tenant-storage-config/**`, `settings-registry/descriptors/storage.descriptors.ts`, `apps/api/src/modules/tenant-storage-config/**`, seed | A | M |
| **558-F** | Descriptor coverage + Vault seeding | `settings-registry/registry.types.ts` (`failMode`), `descriptors/*.ts` (new), Vault kv-v2 seed script | A | L |
| **558-G** | Read-path convergence + docs | `apps/guardrail/**/tenant_config.py`, STT config reader, `SecretsService` eviction channel extension, `.claude/rules/*`, `docs/development-guide.md` | E, F | M |

**Wave schedule** — Wave 1: **A** alone (touches every env file). Wave 2: **B, C, E, F** in parallel (4 agents). Wave 3: **D, G**. Wave 4: verification + closure.

**Every lane's definition of done:** its own tests pass with pasted output; `pnpm lint` clean (including `only-warn` warnings in `packages/*`); affected packages build; a Change History entry appended to this README; files staged.

---

## 8. Verification Criteria (ticket-level)

- [ ] `git ls-files | grep '\.env'` → only `*.example` and `.env.production`
- [ ] A value set only in `.env.dev` is observed by **both** the gateway and every Python service
- [ ] `pnpm env:sync --check` reports no drift; the `env-drift-check` CI job fails on a deliberate edit
- [ ] `.env.example` ≤ ~60 lines; total declared keys ≤ ~120
- [ ] Zero keys declared-but-unread (the §2.3 scan re-run returns empty)
- [ ] Changing the SYSTEM `TenantStorageConfig` row changes upload behavior with **no redeploy**, and is GLOBAL_ADMIN-gated
- [ ] `pnpm verify`, `pnpm lint:all`, `pnpm typecheck:all` and each `<svc>:test` green (output pasted)
- [ ] Clean-clone `pnpm setup:dev` succeeds end to end

---

## 9. SOTA Best Practices — the standard this refactor is held to

Validated against current external guidance (July 2026) and reconciled with what HOPE already has. Sources in §12.

### 9.1 Dotenv files — apps, services, workers, infra

| # | Practice | HOPE status |
|---|---|---|
| D1 | **Schema is the source of truth; example files are generated.** Define the schema once per deployable and reuse it (zod / pydantic-settings) — never hand-maintain a key list. | Only `admin-console` complies. Lane D. |
| D2 | **One `.env.example` per deployable**, not one monolith. Scope-per-service keeps CI images and developer setup minimal and makes rot visible. | Violated (905-line root). Lane D. |
| D3 | **Committed files carry no secrets** — placeholders only. Enforced by gitignore + gitleaks + a CI check, not by convention. | Violated (`.env.dev` committed). Lane A. |
| D4 | **Identical precedence in every language runtime**: host env > env file > schema default. A key must resolve the same way in TS and Python. | Violated (Python never reads `.env.dev`). Lanes B/C. |
| D5 | **Workers inherit their service's schema**, never a private copy. The harness Temporal worker and the STT Dramatiq worker are the same config surface as their FastAPI app. | Partially — `dev-service.sh` re-declares defaults. Lane C. |
| D6 | **Infra interpolation ≠ app config.** Compose's `.env` (variable substitution at parse time) is a distinct concern from application configuration; conflating them is precisely how `.env` became a second, divergent app-config file here. | Violated. Lane B (generated `.env.docker`). |
| D7 | **No file loading in CI or production** — host env only. | Already correct (`loadEnv()` honors `CI`/production). |
| D8 | **Exactly one declaration per key per file**; duplicates are a CI failure, not a lint warning. | Violated (`QDRANT_URL`, `MLFLOW_TRACKING_URI`). Lanes A/D. |

### 9.2 Environment-variable lifecycle

**L1 — The rule that dissolves most of the current mesh:** *environment variables are immutable for the lifetime of the process.* Anything that must change without a restart is **not** an env var — it belongs in DB or Vault. Applying this test alone reclassifies ~80 of HOPE's keys.

**L2 — Validate before the framework boots.** Parse and validate the env-tier schema *before* `NestFactory.create()` / `create_app()`. Fail fast with the full list of problems, not the first one. (Directly fixes the four pre-bootstrap `process.env` reads in `apps/api/src/main.ts`.)

**L3 — Validate once, inject thereafter.** Schemas are defined at module initialization and reused; no re-parsing per request, no `process.env` at call sites. Typed config is injected.

**L4 — Refresh is push, not poll.** TTL is a bounded-staleness safety net; the propagation mechanism is explicit invalidation (HOPE's existing Redis pub/sub eviction channel). A 60 s TTL with no invalidation, as guardrail has today, means a config change silently takes up to a minute and no operator can tell when it landed.

**L5 — Prefer dynamic, short-lived credentials to static ones.** HOPE already has Vault AppRole + `PG_DYNAMIC_CREDS` + `vault-lease-renewer.ts`; make it the deployed default rather than opt-in.

**L6 — Rotation is staged, never a cliff.** Versioned key material (`keyVersion`, already on `GlobalSetting`) lets a rotation overlap old and new. Critical for `API_KEY_PEPPER`, which otherwise invalidates every API key at the instant it changes.

**L7 — In-cluster secret delivery: Vault-side injection over materialized k8s Secrets.** External Secrets Operator is simpler, but it writes plaintext into Kubernetes `Secret` objects (etcd). For a PHI platform already running Vault HA with AppRole and dynamic DB credentials, Vault Agent / Vault Secrets Operator injection is the stronger posture; ESO is acceptable only for non-PHI, periodically-rotated values. Recorded here as the standard for `deployment/k3s/**`.

**L8 — Every fallback is observable.** A resolved value should be able to say which tier supplied it. HOPE has `ConfigResolutionSource` in the pipeline resolver — generalize it to all tiers and log once per fallback.

### 9.3 Multi-tenant configuration and runtime loading

**M1 — Hierarchical resolution, most-specific-wins.** Industry guidance describes four levels (global → plan/tier → tenant → user). HOPE's cascade is `system → tenant → department → doctor` — deeper and better suited to a clinical org chart. Keep it.

**M2 — Entitlements are a *ceiling*, not a cascade level.** Plan/tier entitlements bound what a tenant **may** set; they do not supply values. HOPE already models this correctly (separate `entitlement` tier + the `maxScope` clamp) — this is a deliberate improvement on the common 4-level pattern and must be documented as such so a future contributor doesn't "fix" it into the cascade.

**M3 — Tenant resolution is tied to authentication.** Every request carries a trusted tenant identity; config resolution derives tenant from that context, never from a client-supplied field. HOPE does this via CLS + JWT.

**M4 — `tenantId` MUST be part of every config cache key.** A per-process settings cache keyed only by setting name is a cross-tenant data leak. **Audit item for lane G**: guardrail's and STT's hand-rolled TTL caches must be verified tenant-keyed.

> **AUDIT COMPLETED — wave 3, lane G.** The audit was pointed at the wrong services: guardrail and STT were both clean. The leak was in the TypeScript gateway.
>
> | Cache | Keyed by | Verdict |
> |---|---|---|
> | guardrail `TenantConfigResolver._cache` | `f"{task_key}::{tenant_id}"` | ✅ tenant-keyed |
> | STT `PipelineConfigReader` / `ModelRegistryReader` | no cache; every query tenant-filtered | ✅ N/A |
> | STT `get_settings()` / `get_api_client()` (`@lru_cache`) | zero-arg; process env only | ✅ platform-scoped by construction |
> | `EffectiveSettingsService` | holds no cache; delegates per tier | ✅ N/A |
> | `BlobStorageProviderFactory.tenantProviderCache` (lane E) | `${tenantId}::${bucketName}` | ✅ tenant-keyed |
> | `SecretsService.cache` | full secret key/path; per-tenant secrets addressed by a tenant-scoped `credentialsRef` | ✅ tenant-distinct by path |
> | **`AppSettingsService._cachedAppSettings`** | **setting KEY ALONE, loaded across ALL tenants** | ❌ **LEAK — fixed** |
>
> **The leak.** `cacheAppSettings()` calls `findAll({})` with no CLS tenant, so the tenant-scope extension passes through and the cache ingests every tenant's `GlobalSetting` rows into a `Map<key, entity>`. `TenantService.provisionTenantConfigs` clones the entire platform setting set into every new tenant, so this is the normal steady state, not an edge case. Every reader of that cache is platform-scoped and passes no tenant: JWT/impersonation TTLs, OIDC + SAML config, rate limits, password policy, cron schedules, storage endpoints, and the `global-kv` lane of `EffectiveSettingsService`.
>
> TASK-403 had added platform-row precedence, which fixed the case where a platform row for the key exists. It explicitly left two cases as *"unchanged behavior"*, and those are the leak: a key with **no surviving platform row** resolved to a CUSTOMER tenant's row (last-row-wins, so which tenant won depended on repository ordering). Reachable by soft-deleting a platform row — `cacheAppSettings()` filters DELETED rows, and the tenant clones then become authoritative platform-wide.
>
> Two distinct failure shapes, both pinned by failing tests before the fix (`appSettings.service.tenant-key-leak.test.ts`):
> - **read** — tenant A's `JWT_EXPIRES_IN` becomes the platform-wide token lifetime (observed: `'99h'` served where the platform default `'1h'` was expected);
> - **write** — `EntitlementsService.writeSetting` / `RateLimitAdminService.writeSetting` resolve their UPDATE target with `getFromCache(key)`, so a platform-admin write mutates a TENANT's row (the 404 symptom TASK-403 originally chased).
>
> **Fix.** The cache now admits only the two platform-reserved tenants (`PLATFORM_TENANT_IDS` = default `50000000-…`, SYSTEM `00000000-…` — both are needed: seed 11 puts capability rows on SYSTEM and everything else on the default tenant), and resolves a collision between them by declared precedence rather than row order. A key-only cache is sound only when its contents are platform-only. The two superseded TASK-403 assertions were updated in place with a supersession note.

**M5 — Fail-closed on *selection*, fail-open on *tuning*.** Provider/model selection must never silently fall back to another tenant's or a global value (guardrail's existing posture — promote to policy). Tuning knobs may fall back to the descriptor default. Encoded as `failMode` on the descriptor (§4 B3).

**M6 — Resolution respects the 404-over-403 posture.** A config read for a tenant the caller cannot see is "not found", never "forbidden".

**M7 — Prefer gateway-resolved injection over per-service DB reads** for stateless services: one authority, fewer DB connections, tenant context travels with the request, and no service can drift into its own resolution order. This is the TASK-496 TTS pattern; guardrail and STT are the outliers.

**M8 — Config writes are audited, versioned, and concurrency-safe.** OCC via ETag/If-Match, sys-events on mutation, audit log entries. Already built in `SettingsRegistryWriteService` — every new descriptor inherits it for free.

**M9 — Kill-switches default OFF and fan out instantly** (fail-safe rollout). The registry already asserts this at assembly; keep the assertion as new descriptors land.

**M10 — Per-tenant secrets never sit in a DB column as plaintext.** They are Vault-Transit ciphertext (`db-secret`) or a `credentialsRef` into Vault kv-v2. `TenantStorageConfig` and `TenantTtsProviderCredential` already follow this — the platform-default storage row (lane E) must too.

---

## 10. Agent allocation

Model/effort mapping used for dispatch (the effort tiers available to the orchestrator are `low | medium | high | xhigh | max`):

| Requested tier | Dispatched as | Assigned lanes |
|---|---|---|
| `sonnet-5-extra` (simple) | model `sonnet`, effort `high` | **558-A** |
| `opus-5-high` (low/mid complexity) | model `opus`, effort `high` | **558-B**, **558-C**, **558-E**, **558-G** |
| `opus-5-xhigh` (high/very complex) | model `opus`, effort `xhigh` | **558-D**, **558-F** |

Rationale: A is mechanical deletion against an explicit key list. B/C/E/G are contained refactors with a known target shape. D (schema + generator + CI gate spanning TS and Python) and F (descriptor taxonomy for ~80 keys plus `failMode` semantics and Vault seeding) carry the design risk.

**Execution protocol**

1. Each lane runs in a **dedicated git worktree**, and **must first run `git reset --hard fix/2605-review`** — agent worktrees are created off the repository's default branch (`dev`/`main`), not the current branch. Skipping this silently bases the lane on the wrong tree.
2. Lanes touch **only** the paths in their §7 row and stage their work (`git add`) at each milestone.
3. Waves are merged into `fix/2605-review` at the root project **between** waves, so each wave starts from its predecessor's output:
   - **Wave 1** — A → merge
   - **Wave 2** — B, C, E, F (parallel) → merge
   - **Wave 3** — D, G → merge
   - **Wave 4** — full verification sweep + ticket closure
4. No lane commits to `fix/2605-review` directly; integration happens at the root.

---

## 11. Change History

| Date | Change |
|---|---|
| 2026-07-25 | Ticket created. Full env inventory (21 files, 561 keys, 4 loaders), redundancy scan (76 dead keys, 9 legacy shims), tracked-credential root cause (`.gitignore` `.dev.`/`.env.` typos), tier-assignment proposal (R3), read/refresh contract (R4), naming scheme + target file layout (R5). Owner decisions recorded: ticket number 558; credential rotation deferred; work split into 7 parallel lanes. |
| 2026-07-25 | Added §9 SOTA best-practices standard (D1–D8 dotenv, L1–L8 lifecycle, M1–M10 multi-tenancy) validated against July-2026 external guidance; §10 agent allocation (model/effort mapping, worktree protocol, 4-wave merge schedule). New audit item **M4** (tenant-keyed config caches) assigned to lane G. Status **In Progress** — Wave 1 dispatched. |
| 2026-07-25 | **558-A (hygiene & dead-key removal) complete.** A1: fixed the six `.dev.*` → `.env.*` typos in `.gitignore` lines 87-92, added negations (`!.env.example`, `!**/.env.example`, `!.env.production`, `!apps/*/.env.production`, `!.env.test`) so the three sanctioned templates stay tracked while every other env file is now genuinely ignored. A2: `git rm --cached .env.dev` (local copy untouched on disk, no values altered — rotation stays deferred per §6). A3: `git rm .env.archive` (124 dead keys). A4: added gitleaks rule `hope-committed-env-file` (path-pattern `(^|/)\.env\.[A-Za-z0-9_-]+$` with a per-rule allowlist for `*.example`/`.env.production`/`.env.test`); verified live — staged a scratch `.env.staging` with a fake secret, `gitleaks protect --staged` flagged it (`RuleID: hope-committed-env-file`, exit 1), then removed the scratch file and confirmed `gitleaks protect --staged` returns clean (exit 0) on the real change set. A5/A6/A7/A8: see Implementation Summary below for the full key-count reconciliation, the 11 classification corrections (keys the ticket listed as dead that are actually read — verified against each Python service's pydantic-settings `env_prefix`), the legacy-shim removal, the `QDRANT_URL`/`MLFLOW_TRACKING_URI` de-duplication, and the new `DIRECT_URL` declarations. Verification evidence: `git ls-files \| grep env` shows only `*.example`/`.env.production`/`.env.test`; `pnpm typecheck` (33/33 tasks) and `pnpm lint` (29/29 tasks) green; `pnpm typecheck:py` shows three PRE-EXISTING failures (SMR `bedrock.py` boto3 typing, NLP `dependencies.py` dict-item typing, TTS missing optional ML stubs) confirmed via `git diff --stat` to be untouched by this lane — none reference environment variables. Staged, not committed. Status remains **In Progress** (Wave 1 → Wave 2 handoff). |

| 2026-07-26 | **558-D (typed schema, generated example files, CI drift gate) complete.** **D1** — `apps/api/src/config/` is new: `env.schema.ts` BUILDS a zod schema from `BOOTSTRAP_ENV_SETTINGS` + `PLATFORM_KNOB_SETTINGS` + `FEATURE_FLAG_SETTINGS` + a new gateway-local `env.descriptors.ts` (topology / ports / process identity / OTel / Vault client / data plane / streaming — 51 declarations, each transcribed from a verified reader), names via `toEnvVarName()`, `failMode: 'closed'` → required. Wired into lane B's marked seam in `main.ts`; the four pre-bootstrap `process.env` reads (`LOG_LEVEL`, `PORT`, `SHUTDOWN_TIMEOUT_MS`, `SHUTDOWN_DRAIN_DELAY_MS`, `CORS_ALLOWED_ORIGINS`) now read the validated object (plan §4 B5). **Correction to lane F's `failMode` mapping:** `VAULT_SECRET_ID` + `VAULT_WRAPPED_SECRET_ID` are both `closed` only because the registry forces `closed` on secrets — requiring both is unsatisfiable (they are alternatives) and neither is needed under `SECRETS_PROVIDER=env`; `VAULT_DB_ADMIN_PASS` has zero TS readers (Vault provisioning only). Handled by two exported exception sets, honoured identically by the validator and the generator. **D2/D3** — `pnpm env:sync` (`scripts/env-sync.mts`) generates `.env.example` (bootstrap floor, **60 lines**, 16 keys), `apps/api/.env.example`, a new `apps/admin-console/.env.example`, `packages/tools/.env.example`, `turbo.json#globalEnv` and `env-surface.generated.md`; `--check` exits non-zero with a set-difference drift report. **130 distinct declared keys** (from 488 across the committed templates). `globalEnv` 198 → 142, regenerated as *declared surface ∪ a comment-stripped, write-excluding scan of every non-test `process.env` read* — which also closed 4 pre-existing `turbo/no-undeclared-env-vars` warnings. **D4** — `env-drift-check` in `.gitlab/ci/validate.yml` + `.rules-env-declarations`; proven RED twice (a hand-edited `turbo.json`; a descriptor added without regenerating → 3 artifacts flagged) and GREEN after revert. **D5** — removed the confirmed-dead CI job variables `DATABASE_URL_DIRECT`, `JWT_REFRESH_SECRET`, `JWT_REFRESH_EXPIRES_IN`, `DEBUG_PRISMA`, `SKIP_SEED` (no reader in any TS/Python/shell source). **D6** — rewrote `env-port-standardization.test.ts` (26 failing at HEAD): it asserted DEV ports against `.env.test`, which commit d84f538e moved to DEV+100, and it hard-read the now-untracked `.env.dev` (12 ENOENT crashes that would also fail in CI). It now reads the DEV map from the descriptors, asserts `.env.test = DEV + 100`, and treats `.env.dev` as optional — 85 pass, 2 skipped. **D7** — `TENANT_IDP_ENABLED` / `AZURE_OPENAI_API_KEY` dropped by regeneration (and `TENANT_IDP_ENABLED` from `globalEnv`); `SMR_OPENAI_COMPAT_ENABLED` removed from `apps/smr/.env.example` (proved: `OpenAICompatConfig.model_fields` has no `enabled`). `QDRANT_API_KEY` is NOT dead as claimed — `infrastructure/docker/scripts/init-qdrant-collections.py:23` reads it; it is simply not part of the declared surface. **Deliberate scope boundary:** the six Python services' `.env.example` files stay hand-maintained — their pydantic surface is ~500 fields (vs the §8 ~120-key target) and the drift gate cannot import them in CI. Evidence: `pnpm env:sync --check` OK · `pnpm --filter @arcaai/api test` 2144 pass / 0 fail (was 26 fail) · `pnpm --filter @arcaai/admin-console test` 1215 pass · `pnpm api:build` 8/8 · `pnpm typecheck` 33/33 · `pnpm lint` 29/29, **0 errors**, warnings 492 vs the 496 HEAD baseline (−4, all `turbo/no-undeclared-env-vars`) · booting the built gateway with an invalid env fails before `NestFactory.create()` listing all 7 problems at once · `gitleaks protect --staged` clean. Staged, not committed. |
| 2026-07-25 | **558-C (unified Python loader) complete.** New uv-workspace package `packages/py-env` (dist `hope-env`, module `hope_env`, one dependency: `python-dotenv`, already required by all six services) implements the D4/D7 contract — `NODE_ENV` → `.env.dev`/`.env.test`/`.env.staging`, host env always wins (including an explicit empty value), no file read when `CI` is truthy or `NODE_ENV=production`, monorepo root found by walking up for the `package.json` named `hope-monorepo` (no fixed parent count). 20 contract tests, TDD (RED captured). C1: the four copied `_load_dotenv_into_environ()` bodies (smr/harness/guardrail/tts) and the two bare `dotenv.load_dotenv()` calls (nlp `core/config.py` + `utils.py`) are gone; stt gained the loader in `get_settings()` and keeps `apps/stt/.env` as a pydantic overlay that the root file now outranks. C3: `_promote_legacy_smr_v2_env()` deleted (repo-wide grep confirms zero `SMR_V2_*` declarations survive Wave 1); `SMR_GATEWAY_URL` verified resolving from `.env.dev` instead of its hardcoded default. C4: `dev-service.sh` no longer supplies application config — `SMR_OPENAI_COMPAT_{ENABLED,BASE_URL}`, `SMR_EXTERNAL_GUARDRAIL_ENABLED`, `HARNESS_{SMR,NLP,API}_BASE_URL`, `HARNESS_RETRIEVAL_ENABLED` and the `sed` of `.env.dev` for `HARNESS_SERVICE_TOKEN` were all removed; the `apps/stt/.env` `grep` was replaced by a preflight that resolves the key through the real loader. Kept deliberately: loopback bind, per-service port overrides, `--print`/`--check-stt-key`/`DRY_RUN`, and the LM Studio model pairing (machine-specific, differs from the pydantic default, no env-file home yet — lane D). **Headline proof:** a value declared ONLY in `.env.dev` is observed by all six services' real settings objects (smr/guardrail/harness/tts/nlp/stt) and by the harness worker's governor; the same probes are NOT observed under `CI=true` or `NODE_ENV=production`, and a host export beats the file. Gates: `py-env` 20 · smr 957 · guardrail 174 · nlp 184 · stt 2740 · harness 1023 · tts 178 pass; ruff clean on all seven; mypy clean for py-env/stt/guardrail/harness, with the three PRE-EXISTING failures (smr `providers/bedrock.py`, nlp `dependencies.py`, tts's 7 ML-stub files) unchanged — none appears in this lane's diff. Staged, not committed. |

| 2026-07-26 | **558-G (read-path convergence + docs) complete — wave 3.** **G1 (M4 audit, the security item):** audited all six config/settings caches (table under §9.3 M4). Guardrail and STT — the two the ticket suspected — are clean; the leak was `AppSettingsService`, whose key-only `Map` ingests every tenant's `GlobalSetting` rows. Two failure shapes (cross-tenant READ of platform values; cross-tenant WRITE via `getFromCache(key)` → `update(row.id)`) captured as failing tests first, then fixed by restricting the cache to the two platform-reserved tenants. Superseded two TASK-403 assertions that had pinned the leak as "unchanged behavior". **G2:** guardrail's SQL resolver is KEPT — justification re-verified and strengthened with two grounds the docstring omitted (its callers are peer services forwarding only `X-Tenant-Id`, so gateway injection is structurally unavailable; an HTTP pull would put the gateway on guardrail's safety-critical path and close a `gateway → SMR → guardrail → gateway` cycle). Two of §2.6's three charges against it were disproved (TTL is declared config; fail-closed selection IS the policy). **G3:** the `global-kv` propagation path already existed (F-007's `app-settings:invalidate`); moving it onto the secrets channel was rejected as a regression, and the missing end-to-end two-instance proof was added instead. **G4:** confirmed the plaintext `S3_ACCESS_KEY`/`S3_SECRET_KEY` seed rows (§9.3 M10 violation) and removed them; the trap the brief warned about was real — credential VALUES already came from `SecretsService`, but `S3Service.hasRequiredConfiguration()` still gated readiness on the rows' PRESENCE, so deleting them alone would have silently disabled storage on every correctly-configured box. Gate now reads `SecretsService`; added an idempotent scrub that OVERWRITES the value before retiring the row (soft delete alone leaves the secret readable) for databases already seeded. **G5/G6:** rules 00/06/09, `scripts/README.md`, `docs/development-guide.md`, `docs/development-patterns-and-standards.md` §5.7 updated; §2.2 (four→six loaders + the boot-ordering misdiagnosis), §2.3 (76→65 dead keys), §2.5 (15/24→62 baseline, 137 now), §2.6, §4 B2 and §9.3 M4 corrected in place with the reasoning preserved. Evidence: `@arcaai/applications` 7017 passed / 0 failed (353 files); guardrail 174 passed; STT 2740 passed, 9 skipped, 3 xfailed (both pinned with `PYTHONPATH` to this worktree); ruff clean on the touched Python; `pnpm typecheck` 33/33 and `pnpm lint` 29/29 green. Status → **Review**. Staged, not committed. |

---

## 12. Sources (external guidance, July 2026)

- [5 Strategies for Tenant Configuration in SaaS — Antler Digital](https://antler.digital/blog/5-strategies-for-tenant-configuration-in-saas) — tier-based configuration hierarchy, most-specific-wins resolution
- [Multi-Tenant SaaS Architecture Guide: 2026 Best Practices — Mallary](https://mallary.ai/blog/multi-tenant-saas-architecture) — tenant resolution tied to auth/authz context
- [The developer's guide to SaaS multi-tenant architecture — WorkOS](https://workos.com/blog/developers-guide-saas-multi-tenant-architecture) — tenant resolution, isolation, per-tenant context
- [Kubernetes Secrets Management in 2026: Vault vs External Secrets Operator vs Infisical — rkssh](https://rkssh.com/blog/kubernetes-secrets-management-vault-eso-infisical) — ESO materializes secrets into k8s Secret objects; Vault preferred for short-lived, workload-scoped credentials
- [Kubernetes Vault integration: Sidecar Agent Injector vs. Vault Secrets Operator vs. CSI provider — HashiCorp](https://www.hashicorp.com/en/blog/kubernetes-vault-integration-via-sidecar-agent-injector-vs-csi-provider) — injection modes, automatic renewal/rotation
- [Best Practices with Zod — Steve Kinney](https://stevekinney.com/courses/full-stack-typescript/zod-best-practices) — define schemas once at module init, reuse; avoid redundant validation
- [Sharing Types and Validations with Zod Across a Monorepo — Leapcell](https://leapcell.io/blog/sharing-types-and-validations-with-zod-across-a-monorepo) — shared schema packages across a monorepo
- [vite-plugin-validate-env](https://github.com/Julien-R44/vite-plugin-validate-env) — fail-fast env validation at build/dev time
