# TASK-679 — Configuration Tier Compliance

| Field | Value |
|---|---|
| **Status** | Review |
| **Type** | `refactor` (+ one deliberate `bugfix` to the test-env secret path) |
| **Branch base** | `dev-2.1` @ `baeb7d49b` |
| **Commits** | `4417fd17e`, `4d589e413`, `208cf62f1` |
| **Owner directive** | No configuration may be managed via env vars. Everything belongs in Vault (global) or the database (tenant-specific). |
| **Authority** | `.claude/rules/09-infrastructure-devops.md` §Configuration Tiers |

> ⚠️ **This ticket ships one deliberate behaviour change.** Server-side OCR
> enrichment (`OCR_ENABLED`, now `consultation.ocr.enabled`) **defaulted ON and
> now defaults OFF.** It is mandated by the kill-switches-default-OFF rule and
> is described in full in §5. Nothing else changes effective behaviour.

---

## 1. Requirement Analysis

The policy already exists; this ticket **enforces** it. Its two load-bearing
statements:

> **The bootstrap floor decides:** a variable stays in env only if it is required
> *to reach the database* or *to authenticate to Vault*. Everything else is DB-
> or Vault-tier.
>
> **env vars are immutable for the process lifetime** — anything that must change
> without a restart is not an env var.

Scope, as assigned:

1. Audit every env var read at runtime across `packages/applications`,
   `apps/api`, `apps/harness`; classify each against the tier table (§3).
2. Fix the two known violations — `HARNESS_LOOP_ENABLED`, `OCR_ENABLED` (§4/§5).
3. Fix everything else clearly in scope; record larger independent changes as
   follow-ups with a tier verdict (§7).
4. Resolve `.env.test`'s `HARNESS_SERVICE_TOKEN` properly (§6).

**Bootstrap-floor items are explicitly NOT to be "fixed"** — `DATABASE_URL`,
`DIRECT_URL`, `VAULT_ADDR`, ports and `*_URL` topology stay in env, because
nothing can boot without them.

---

## 2. Current State Evaluation

The settings-registry mechanism already existed and was already the sanctioned
path (`packages/applications/src/services/settings-registry/`). TASK-558 lanes
F/I had done most of the classification work and migrated ten platform knobs.
What this ticket found is that the *migration* stalled at exactly the surfaces
added since — and that two of them were never even reachable.

Three findings shaped the fix:

**F-1 — The two known violations were never declared anywhere.** `OCR_ENABLED`
and `HARNESS_LOOP_ENABLED` appear in **neither `.env.sample` nor
`turbo.json#globalEnv`**:

```
$ grep -c "OCR_ENABLED" .env.sample turbo.json          →  0, 0
$ grep -c "HARNESS_LOOP_ENABLED" .env.sample turbo.json →  0, 0
```

Because `.env.dev` / `.env.test` are *generated from `.env.sample`* by
`scripts/generate-env-file.sh`, neither variable could be set through the
supported config path in any HOPE environment. The practical consequences were
worse than "a flag in the wrong tier":

- **OCR was unconditionally ON and could not be turned off** — the reader treated
  unset as enabled.
- **The TASK-660/662/670 consultation loop was unconditionally OFF and could not
  be turned on** — `LoopContextSignalService` was, in effect, dead code in every
  generated environment.

This removes the usual migration constraint: there is no operator configuration
to preserve, because none could exist.

**F-2 — TASK-660 explicitly copied the violating precedent.** The
`LoopContextSignalService` doc comment said the gate "mirrors `OCR_ENABLED`'s
plain env-flag posture". That precedent *is* the violation, so it propagated.

**F-3 — `.env.test`'s `HARNESS_SERVICE_TOKEN` is a shared-slot collision, not a
dead key.** See §6; the brief's premise was half right and the real mechanism is
broader.

---

## 3. The Audit

Method: every `process.env.*` read and every `ConfigService.get*(...)` /
`IConfigService.getConfigValue(...)` call site in `packages/applications/src`,
`apps/api/src` and `apps/harness/src`, deduplicated by variable, then classified
against the §Configuration Tiers table. Verdicts use the tier vocabulary of
`registry.types.ts`.

### 3.1 Bootstrap floor — correctly `env`, do not move

These are required to reach the database or authenticate to Vault, or are process
topology/identity. All are already cataloged by `BOOTSTRAP_ENV_SETTINGS`.

| Variable(s) | Read by | Verdict | Why it stays |
|---|---|---|---|
| `DATABASE_URL`, `DIRECT_URL`, `PRISMA_PG_MAX` | applications, api, database | `env` ✅ | Reaching the DB *is* the floor. |
| `VAULT_ADDR`, `VAULT_ROLE_ID`, `VAULT_SECRET_ID`, `VAULT_WRAPPED_SECRET_ID`, `VAULT_NAMESPACE`, `VAULT_KV_MOUNT`, `VAULT_KV_PREFIX`, `VAULT_TRANSIT_MOUNT`, `VAULT_TRANSIT_KEY`, `VAULT_TRANSIT_KEY_PHI`, `VAULT_REQUEST_TIMEOUT_MS`, `VAULT_AUDIT_LOG_PATH` | `SecretsService`, `VaultSecretsProvider` | `env` ✅ | Authenticating to Vault *is* the floor. A Vault-tier Vault address is circular. |
| `SECRETS_PROVIDER` | applications, api | `env` ✅ | Selects the secrets backend; must be known before any backend is reachable. |
| `NODE_ENV`, `CI`, `PORT`, `SERVICE_NAME`, `HOSTNAME` | everywhere | `env` ✅ | Process identity. |
| `SMR_URL`, `STT_URL`, `STT_V2_URL`, `NLP_URL`, `GUARDRAIL_URL`, `HARNESS_URL`, `HARNESS_BASE_URL`, `TTS_URL`, `PROMETHEUS_URL`, `*_PORT` | api, applications | `env` ✅ | Topology. The tier table names `*_URL` explicitly. |
| `REDIS_HOST/PORT/PASS/URL`, `MQTT_HOST/PORT/USER/PASS` | applications | `env` ✅ | Connection identity for the data plane. |
| `OTEL_*` (`SERVICE_NAME`, `SERVICE_VERSION`, `EXPORTER_OTLP_ENDPOINT`, `SDK_DISABLED`, `TRACES_ENABLED`, `METRICS_ENABLED`, `DEBUG`) | api, applications | `env` ✅ | Named in the tier table; consumed before the module graph exists. |
| `LOG_LEVEL`, `LOG_FILE_*` | logger, api `main.ts` | `env` (bootstrap) ✅ | `logLevel` is *also* `global-kv` (already migrated); the env value seeds the pre-Nest logger. |
| `PG_DYNAMIC_CREDS`, `PG_VAULT_ROLE`, `PG_VAULT_MAX_TTL_SEC` | api database module | `env` ✅ | Decides *how* the DB connection is obtained. |
| `ENV_FILE_PATH`, `DEBUG`, `NEST_DEBUG`, `NO_COLOR`, `VITEST`, `ENABLE_PRISMA_STUDIO` | tooling | `env` ✅ | Dev/tooling only, not runtime product config. |
| `TEMPORAL_*`, `HARNESS_CLAIM_CHECK_*` endpoints, `HARNESS_MCP_*` endpoints (apps/harness) | harness `core/config.py` | `env` ✅ | Topology + bootstrap for the worker process. |

### 3.2 Already migrated or already governed — no action

| Key | Tier today | Note |
|---|---|---|
| `logLevel`, `shutdown.*`, `rateLimit.*`, `apiKey.maxLifetimeDays`, `apiKey.allowQueryParam`, `refreshToken.ttlSeconds` | `global-kv` | TASK-558 lane I. Env demoted to documented bootstrap fallback. |
| `rate-limit.enabled`, `rate-limit.tier.*` | `global-kv` | Resolved per request by `RateLimitSettingsService`. |
| `entitlements.enabled`, `metering.*`, `audit-retention.*`, `agentic.trajectory.*` | `global-kv` | Live control planes. |
| `agentic.context.*` (incl. `AGENTIC_CONTEXT_TRANSCRIPT_MODE`) | `global-kv` | Resolved per flush via `EffectiveSettingsService`; env override loses to a stored value. |
| `models.*` | `db-config` | `AiTaskDefaultService`, fail-closed. |
| `storage.platformDefault.*` | `db-config` / `vault-kv` | TASK-558 lane E cascade. |
| `stt.fallback.*`, `tts.*` | `db-config` / `db-secret` | Per-tenant BYOK. |
| `JWT_SECRET_KEY`, `API_KEY_PEPPER`, `SESSION_SECRET_KEY`, `*_SERVICE_TOKEN`, `STORAGE_ACCESS_KEY_PEPPER`, storage credentials | `vault-kv` | `PLATFORM_SECRET_SETTINGS`; all `failMode: 'closed'`. |

### 3.3 Violations

| Variable | Read by | Correct tier | Severity | Disposition |
|---|---|---|---|---|
| **`OCR_ENABLED`** | `ocr-enrichment.processor.ts:80` (constructor) | **`global-kv` kill-switch, default OFF** | **High** — kill-switch, defaults ON, immutable, undeclared | **FIXED** → `consultation.ocr.enabled` (§5) |
| **`HARNESS_LOOP_ENABLED`** | `loop-context-signal.service.ts:45` (per-call getter over `ConfigService`) | **`global-kv` kill-switch, default OFF** | **High** — kill-switch, immutable, undeclared | **FIXED** → `harness.loop.enabled` (§5) |
| `LIVE_DOC_GROUNDEDNESS_ENABLED` | `live-documentation.service.ts:469` (constructor) | `global-kv` kill-switch | High — already cataloged `killSwitch: true` yet needs a restart | Follow-up **FU-1** (§7) |
| `LIVE_DOC_ENABLED` | `live-documentation.service.ts:449` (constructor) | `global-kv` | High — the live-documentation master gate, immutable | Follow-up **FU-1** |
| `LIVE_DOC_SMR_PROVIDER`, `LIVE_DOC_SMR_MODEL` | `live-documentation.service.ts:457-458` | `db-config`, `failMode: 'closed'` | High — **provider/model SELECTION in env**, which the policy says is fail-closed DB-tier | Follow-up **FU-2** |
| `LIVE_DOC_MIN_INTERVAL_MS`, `LIVE_DOC_HEARTBEAT_MS`, `LIVE_DOC_DURABLE_SNAPSHOT_MS`, `LIVE_DOC_SMR_MAX_TOKENS`, `LIVE_DOC_SMR_TIMEOUT_MS`, `LIVE_DOC_STATS_TTL_SEC`, `LIVE_DOC_GROUNDEDNESS_TIMEOUT_MS`, `LIVE_DOC_GROUNDEDNESS_MAX_RETRIES`, `LIVE_DOC_GROUNDEDNESS_RETRY_BACKOFF_MS` | `live-documentation.service.ts:447-472` | `global-kv` tuning knobs | Medium — immutable tuning | Follow-up **FU-1** |
| `TENANT_IDP_MS_GRAPH_ENABLED`, `TENANT_IDP_GOOGLE_DIRECTORY_ENABLED` | `ms-graph-directory.provider.ts:40` + sibling (constructor) | `global-kv` kill-switch, default OFF | Medium — provider kill-switches needing a restart | Follow-up **FU-3** |
| `REGISTRATION_SELF_SIGNUP_ENABLED` | api `RegisterController`, applications | `global-kv` (`registration.selfSignupEnabled`) | Medium — cataloged `tier: 'env'`, `targetTier` pending; reader not moved | Follow-up **FU-4** |
| `guardrailV2.groundedness.enabled`, `smr.externalGuardrail.enabled`, `harness.nerPriorsEnabled`, `harness.atomicFactEnabled`, `semanticEndpoint.enabled`, `harness.warmStartEnabled`, `harness.claimCheck.enabled` | pydantic-settings in the Python services | `global-kv` via `/internal/effective-config` | Medium | Follow-up **FU-5** (Python-loader lane; cataloged, `targetTier` recorded) |
| `entitlements.enabledDefault`, `metering.reconcile.enabledDefault` | `seed/15-entitlements.ts` | none — **delete** | Low | Follow-up **FU-6**; their own descriptors already say the migration path is DELETION once seeding reads the descriptor default. |
| `TENANT_IDP_ENABLED` | **nobody** | dead key | Low | Already on the §2.3 dead-key list; no reader exists. Left as-is. |
| `APP_SETTINGS_BOOT_INVARIANT`, `API_KEY_MAX_LIFETIME_DAYS`, `API_KEY_ALLOW_QUERY_PARAM`, `REFRESH_TOKEN_TTL_SECONDS` | applications | `env` (bootstrap fallback) ✅ | — | No action: already `global-kv` with env demoted to a documented first-boot fallback. |

`apps/harness` produced **no new violations** beyond FU-5: its per-request
knobs already route through `core/effective_config.py` (TTL + negative cache +
single-flight), and the rest of its `env_prefix` surface is bootstrap/topology
or `SecretStr` material that resolves from Vault.

---

## 4. Implementation Plan (as executed)

| # | Step | Verify |
|---|---|---|
| 1 | Author `consultation-gates.constants.ts` — keys + defaults as the single source of truth shared by descriptor and reader (the `metering.constants.ts` precedent) | compiles |
| 2 | Author `consultation-gates.descriptors.ts`; spread into `HOPE_SETTINGS_REGISTRY` | registry assembles; `killSwitches()` does not throw |
| 3 | **RED** — write `consultation-gates.tier-compliance.test.ts` covering runtime flip / default-OFF / failMode / regression | see it fail |
| 4 | **GREEN** — move both readers to call-time `TenantSettingsService.resolvePlatform` | tests pass |
| 5 | Update the two pre-existing fixtures to the new tier | consultation suite green |
| 6 | Fix the `.env.test` secret path in `start-test-app.sh`; retire the e2e workaround | `bash -n` + `shellcheck` clean |
| 7 | Gates | §8 |

No Prisma migration was needed: `global-kv` values live in the existing
`GlobalSetting` table, and both keys resolve from their descriptor default until
an operator writes a row.

---

## 5. Implementation Summary

### 5.1 The two kill-switches (`4417fd17e`)

| | Before | After |
|---|---|---|
| Key | `HARNESS_LOOP_ENABLED` (env) | `harness.loop.enabled` (`global-kv`) |
| Key | `OCR_ENABLED` (env) | `consultation.ocr.enabled` (`global-kv`) |
| Read | once in constructor / via `ConfigService` | per call, `TenantSettingsService.resolvePlatform` |
| Propagation | redeploy | `app-settings:invalidate` push (45s cron = backstop) |
| `failMode` | undeclared | `open-to-default`, declared on the descriptor |
| `killSwitch` | not modelled | `true` — assembly *and* boot refuse a default-ON switch |

Both are `maxScope: 'system'` + `globalOnly: true`: the gates decide whether *this
deployment* runs the capability. Per-tenant/per-consultation loop **policy**
remains a separate concern (`ILoopConfigService`), not a cascade level of the
switch.

**No env bootstrap fallback is kept**, deliberately diverging from
`platform-knobs.descriptors.ts`. That file keeps `<KEY>` as a first-boot fallback
because its knobs have non-trivial defaults a fresh database would lose. These
two do not — absence resolves OFF, which is both the safe answer and the declared
default — and per **F-1** there was no operator configuration to preserve. Keeping
a vestigial env read would have re-created exactly the "config that looks live and
isn't" problem §6 exists to remove.

The `redis-flag` tier was **not** used, following the settled decision recorded in
`feature-flags.descriptors.ts`: the only property `redis-flag` was wanted for is
instant fan-out, and `global-kv` already has it. A second flag store would be new
infrastructure bought with no new capability.

### 5.2 ⚠️ Behaviour change — OCR now defaults OFF

`OCR_ENABLED` defaulted **ENABLED**: `this.ocrEnabled = !this.isFalsey(get('OCR_ENABLED'))`,
i.e. only an explicit `false|0|no|off` disabled it. A kill-switch **must** default
OFF (§9.3 M9), and the invariant is mechanically enforced —
`SettingsRegistry.killSwitches()` throws on a default-ON switch and
`EffectiveSettingsModule.onModuleInit` calls it, so a default-ON kill-switch
cannot even boot. There was no way to model this key honestly *and* keep it on.

**What changes operationally:** server-side OCR enrichment of scanned attachments
is now opt-in. With the gate off, an attachment whose browser-side text-layer
extraction found nothing keeps its **filename label** — precisely the degradation
a failed OCR pass already produced, and the path the processor was already
designed to fall back to. PHI posture is unchanged (bytes stay in-cluster; no
third-party egress).

**To restore the previous behaviour**, an operator writes the row:

```
PUT /api/v1/admin/settings/registry/consultation.ocr.enabled   { "value": true, "scope": "system" }
```

…which takes effect immediately, with no redeploy — something that was not
possible before this ticket.

`harness.loop.enabled` already defaulted OFF, so **its effective state is
unchanged**.

### 5.3 Files changed

| File | Change |
|---|---|
| `packages/applications/src/services/consultation/consultation-gates.constants.ts` | **new** — keys + defaults + the rationale |
| `packages/applications/src/services/settings-registry/descriptors/consultation-gates.descriptors.ts` | **new** — the two descriptors |
| `packages/applications/src/services/settings-registry/registry.ts` | spread `CONSULTATION_GATE_SETTINGS` |
| `packages/applications/src/services/consultation/loop/loop-context-signal.service.ts` | `ConfigService` → `@Optional() TenantSettingsService`; call-time gate |
| `packages/applications/src/services/consultation/ocr/ocr-enrichment.processor.ts` | constructor-frozen `ocrEnabled` field → call-time getter; `isFalsey` removed (orphaned by this change) |
| `.../consultation/__tests__/consultation-gates.tier-compliance.test.ts` | **new** — 21 tests |
| `.../loop/__tests__/loop-context-signal.service.test.ts` | fixture re-tiered |
| `.../ocr/__tests__/ocr-enrichment.processor.test.ts` | fixture re-tiered (gate ON explicitly) |
| `scripts/start-test-app.sh` | provision Vault before launch (§6) |
| `apps/api/tests/e2e/task-660-loop-stream.spec.ts` | retire the `E2E_HARNESS_SERVICE_TOKEN` workaround |

No module wiring was needed: `LiveDocumentationServiceModule` is the sole
provider of both classes and already imports `EffectiveSettingsModule`, which
exports `TenantSettingsService`.

---

## 6. `.env.test`'s `HARNESS_SERVICE_TOKEN` (`4d589e413`)

**The brief's premise was half right.** The guard does resolve from Vault:

```ts
// apps/api/src/modules/consultation/harness-service-token.guard.ts
const expected = await this.secretsService?.getSecretOptional('HARNESS_SERVICE_TOKEN');
```

But `.env.test`'s value is not merely ignored — `scripts/test-setup.sh` Step 6 and
`scripts/ensure-test-vault-creds.sh` **both seed Vault from `.env.test`**, so the
env file is the intended *seed input*. The real defect is a **shared-slot
collision**:

| Fact | Evidence |
|---|---|
| The test infra runs **no Vault of its own** | `tests/docker-compose.test.yml` defines only postgres/redis/minio/qdrant |
| Test uses the **shared dev Vault** | `ensure-test-vault-creds.sh`: `CONTAINER="${VAULT_CONTAINER:-hope-vault}"`, and its header says "the shared dev Vault (hope-vault)" |
| Both env files address the **same kv path** | `.env.dev` and `.env.test` both: `VAULT_ADDR=http://localhost:8200`, `VAULT_KV_MOUNT=secret`, `VAULT_KV_PREFIX=hope` |
| …with **different values** | `.env.dev` `HARNESS_SERVICE_TOKEN=7d12dfc3…` vs `.env.test` `…=fd111a85…` |
| Both setups write that path | `dev-setup.sh:124` and `test-setup.sh:161` each call `vault-seed-secrets.sh --env-file <their own>` |

So `secret/hope/HARNESS_SERVICE_TOKEN` has **two owners and last-writer-wins**.
This affects *every* `vault-kv` secret — `API_KEY_PEPPER`, `JWT_SECRET_KEY`, the
storage credentials — not just the harness token. (`test-setup.sh`'s own comment
acknowledges it, describing the seed as necessary so the API does not read "stale"
values.)

**Why not split the kv prefix.** The obvious fix — `VAULT_KV_PREFIX=hope-test` —
is wrong here: the `hope-app` AppRole policy is pinned to `secret/data/hope/*`
and `infrastructure/docker/configs/vault/policies/hope-app.hcl` is deliberately
mirrored from the production blueprint so a policy bug surfaces on a laptop.
Widening it for test convenience would trade away exactly the parity the file
exists to provide.

**The fix taken** is option (a) of the brief — *seed the test Vault so the guard
finds a known token* — applied at the point where it was actually missing.
`pnpm test:e2e:managed` already self-healed (`test-run.sh` Step 2 calls
`ensure-test-vault-creds.sh`, which re-seeds Vault from `.env.test`). The
**documented two-terminal flow** (`pnpm test:up:api` + `pnpm test:e2e` — the flow
`.claude/rules/01` and `05` prescribe) did **not**. `scripts/start-test-app.sh`
now makes the same call before launching, and re-reads `.env.test` afterwards
because the script rewrites `VAULT_ROLE_ID`/`VAULT_SECRET_ID` into it.

The key is therefore **kept, not deleted**: it is live config with a real
consumer, and the tier arrangement (env file = seed input, Vault = runtime
authority) is the policy's own. `E2E_HARNESS_SERVICE_TOKEN` is demoted from
"required workaround" to "override for a stack started outside these scripts";
`task-660-loop-stream.spec.ts` now falls back to the real `HARNESS_SERVICE_TOKEN`
and its skip message names the supported path.

---

## 7. Deliberately left — follow-ups with tier verdicts

Each is a coherent change of its own, larger than this ticket, and half-doing it
would be worse than recording it.

| ID | Scope | Tier verdict | Why deferred |
|---|---|---|---|
| **FU-1** | The `LIVE_DOC_*` family (11 vars): `LIVE_DOC_ENABLED`, `LIVE_DOC_GROUNDEDNESS_ENABLED` + its 3 retry knobs, `MIN_INTERVAL_MS`, `HEARTBEAT_MS`, `DURABLE_SNAPSHOT_MS`, `SMR_MAX_TOKENS`, `SMR_TIMEOUT_MS`, `STATS_TTL_SEC` | `global-kv`; the two `*_ENABLED` are kill-switches (`liveDoc.groundedness.enabled` is *already* cataloged `killSwitch: true` while still needing a restart) | All eleven are captured as `readonly` fields in one ~2,000-line service's constructor, and several feed `LiveToolRegistry` **construction** (`envDefaults`), so the tool-plan resolution path has to move with them. It is one focused ticket, not a side-effect of this one. |
| **FU-2** | `LIVE_DOC_SMR_PROVIDER` / `LIVE_DOC_SMR_MODEL` | `db-config`, **`failMode: 'closed'`** | This is provider/model **SELECTION** sitting in env, which the policy singles out as fail-closed and never env-substituted. It should fold into the existing `AiTaskDefault` selection plane rather than becoming two more `global-kv` strings — a design decision, not a mechanical move. |
| **FU-3** | `TENANT_IDP_MS_GRAPH_ENABLED`, `TENANT_IDP_GOOGLE_DIRECTORY_ENABLED` | `global-kv` kill-switches, default OFF | Mechanically identical to what this ticket did, but in the directory-sync module, which has its own provider-registration and `BadRequestException` messaging to update. Low risk, clean standalone. |
| **FU-4** | `REGISTRATION_SELF_SIGNUP_ENABLED` | `global-kv` (`registration.selfSignupEnabled`, already cataloged with `targetTier`) | The reader is `RegisterController`'s 404-over-403 gate plus an admin-console proxy allowlist that mirrors it; both must move together or the console and gateway disagree about whether the route exists. |
| **FU-5** | The six Python-service flags (`guardrailV2.groundedness.enabled`, `smr.externalGuardrail.enabled`, `harness.nerPriorsEnabled`, `harness.atomicFactEnabled`, `semanticEndpoint.enabled`, `harness.warmStartEnabled`) | `global-kv` via `/api/v1/internal/effective-config` | Already cataloged with `targetTier: 'global-kv'`. Each needs a gateway route + a change in that service's `config.py` — the Python-loader lane, which owns files outside this ticket. `feature-flags.descriptors.ts` states this explicitly. |
| **FU-6** | `entitlements.enabledDefault`, `metering.reconcile.enabledDefault` | **delete** | Seed-time-only. Their own descriptors already record that the migration is DELETION once `seed/15-entitlements.ts` takes its default from the descriptor. Requires touching the seed's contract. |
| **FU-7** | `harness.claimCheck.enabled` (defaults ON) | `global-kv`, **not** `killSwitch` | Correctly a PROTECTION, not an enforcement gate (same polarity as `rate-limit.enabled`), so it may keep its ON default. Migration is still owed; grouped with FU-5. |

**Not a violation, left alone:** `TENANT_IDP_ENABLED` (no reader exists anywhere
— already on the §2.3 dead-key list; cataloging it would enshrine a flag that
gates nothing).

---

## 8. Gate Evidence

**Baseline measured on this worktree at `baeb7d49b`**, after
`pnpm install` → `pnpm db:generate` → `@arcaai/database` → `@arcaai/domains` →
`@arcaai/applications` build (execution-plan §1.1b — without this the run reports
a false red; the first attempt showed *366 failed test files / 1,546 passing
tests*, the stale-dist signature).

### 8.1 `pnpm --filter @arcaai/applications build && … test`

Baseline:
```
 Test Files  474 passed | 1 skipped (475)
      Tests  8906 passed | 4 skipped (8910)
```

After:
```
> @arcaai/applications@0.0.1 build
> rimraf dist tsconfig.tsbuildinfo && tsc

 Test Files  475 passed | 1 skipped (476)
      Tests  8927 passed | 4 skipped (8931)
```

**+21 tests, +1 file — exactly the new suite. Zero regressions.**

### 8.2 `pnpm api:build`

Baseline and after are identical:
```
 Tasks:    10 successful, 10 total
Cached:    0 cached, 10 total
```

### 8.3 `pnpm test:unit`

```
 Test Files  1 failed | 992 passed | 2 skipped (995)
      Tests  1 failed | 16826 passed | 4 skipped | 9 todo (16840)
```

The single failure is **`scripts/__tests__/env-sync.test.ts`**, and it is
**pre-existing**. Proof — the same test run on an untouched checkout fails
identically, with the same one-line diff:

```
 Test Files  1 failed (1)
      Tests  1 failed | 24 passed (25)
- | `turbo.json#globalEnv` entries | 160 |
+ | `turbo.json#globalEnv` entries | 158 |
```

It is a stale count row in a generated markdown artifact. This ticket's diff
touches neither `turbo.json`, nor that artifact, nor any `env`-tier descriptor
(`git diff --stat baeb7d49b..HEAD` — 10 files, all listed in §5.3), and both new
keys are `global-kv`, which the generator does not emit into `globalEnv`.
Deliberately **not** regenerated here: `turbo.json` is machine-generated by
`pnpm env:sync`, and regenerating would sweep an unrelated pending change into
this ticket's commits.

### 8.4 `pnpm lint`

```
@arcaai/vox:lint:          ✖ 3 problems (0 errors, 3 warnings)
@arcaai/domains:lint:      ✖ 13 problems (0 errors, 13 warnings)
@arcaai/applications:lint: ✖ 195 problems (0 errors, 195 warnings)
@arcaai/api:lint:          ✖ 65 problems (0 errors, 65 warnings)

 Tasks:    34 successful, 34 total
```

**0 errors**, and `apps/api` sits at exactly the expected 65 pre-existing
warnings. Lint of only the changed files is clean:

```
$ npx eslint <the 6 changed source files>
✖ 0 problems
```

(One `prettier/prettier` warning on the new descriptor's import was fixed in
`208cf62f1`.)

### 8.5 Shell

```
$ bash -n scripts/start-test-app.sh   → start-test-app.sh syntax OK
$ shellcheck -S error scripts/start-test-app.sh → shellcheck OK
```

### 8.6 TDD evidence — RED before GREEN

The new suite was written before either reader moved, and failed 10/21 for the
right reasons (constructor-frozen reads; OCR defaulting ON):

```
× harness.loop.enabled starts OFF and begins signalling once the stored value flips
× harness.loop.enabled stops flipped back OFF … (etc.)
× consultation.ocr.enabled starts OFF and begins enriching once the stored value flips
   AssertionError: expected "vi.fn()" to not be called at all, but actually been called 1 times
× reads the gate on EVERY event rather than caching it on the instance
× OCR with the gate OFF short-circuits before establishing CLS scope
   AssertionError: expected "vi.fn()" to not be called at all, but actually been called 1 times
× neither gate is read from process.env any more
 Test Files  1 failed (1)
      Tests  10 failed | 11 passed (21)
```

After moving the readers: `Tests 21 passed (21)`.

The 11 that passed in RED are the declarative half (descriptor/registry
assertions), green because the descriptors were authored first.

---

## 9. Operational Notes

1. **OCR is off until an operator turns it on.** See §5.2 for the one-call
   restore. This is the only behaviour change in the ticket.
2. **The consultation loop can now be turned on at all.** Before this ticket
   `HARNESS_LOOP_ENABLED` was unreachable through the supported config path, so
   `LoopContextSignalService` never signalled in any generated environment.
   `harness.loop.enabled` is a real, writable control plane.
3. **`turbo.json` needs no change** — both keys are `global-kv`, not `env`. No
   new runtime env var was introduced by this ticket.
4. **Branch base.** `dev-2.1` advanced to `23381550a` (`merge(TASK-683)`) during
   this ticket. This work stays based on the mandated `baeb7d49b`; a rebase onto
   the new tip is the integrator's call.

---

## 10. Change History

| Date | Commit | Change |
|---|---|---|
| 2026-08-12 | `4417fd17e` | Migrated `HARNESS_LOOP_ENABLED` → `harness.loop.enabled` and `OCR_ENABLED` → `consultation.ocr.enabled`: `global-kv` kill-switches, default OFF, resolved per call. Includes the deliberate OCR default-ON → default-OFF behaviour change. |
| 2026-08-12 | `4d589e413` | `scripts/start-test-app.sh` provisions Vault before launch, so `.env.test`'s platform secrets are live on the two-terminal test path; retired the `E2E_HARNESS_SERVICE_TOKEN` workaround in `task-660-loop-stream.spec.ts`. |
| 2026-08-12 | `208cf62f1` | Prettier fix on the new descriptor import. |
