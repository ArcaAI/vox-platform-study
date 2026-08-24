<!-- GENERATED FILE — DO NOT EDIT BY HAND. Produced by `pnpm env:sync`. -->

# TASK-558 — The declared environment surface

Generated from the settings registry plus each TypeScript deployable’s own
schema, AND — since TASK-799 Phase 1.5 — the six Python services’
pydantic-settings declarations via `scripts/generated/python-env-surface.json`.
`pnpm env:sync --check` (CI job `env-drift-check`) fails when this file,
the `.env.sample` files (root consolidated / per-app), or `turbo.json#globalEnv`
disagree with those declarations.

## Summary

| Metric | Value |
|---|---:|
| Declared keys (distinct) | 136 |
| … of which required (`failMode: closed`) | 30 |
| … of which secret | 29 |
| … tier `env` | 102 |
| … tier `global-kv` | 9 |
| … tier `vault-kv` | 25 |
| Python declared fields | 356 |
| … distinct Python names (incl. aliases + `os.environ` reads) | 405 |
| `turbo.json#globalEnv` entries | 534 |

## Variables — the TypeScript platform surface

| Variable | Tier | Required | Default | Read by | Purpose |
|---|---|---|---|---|---|
| `ADMIN_CONSOLE_URL` | `env` | no | `http://localhost:5176` | `apps/api` | Origin of the Next.js admin console; used by the gateway e2e harness and CORS guidance. |
| `ADMIN_PORT` | `env` | no | `5176` | `apps/admin-console` | Port the dev (5176) or test (5276) console binds — read by `scripts/dev-stack.sh` and `scripts/start-test-app.sh`, not by application code. |
| `ADMIN_SESSION_SECRET` | `env` | yes | `CHANGE_ME` | `apps/admin-console` | Secret the encrypted session cookie (jose JWE, dir + A256GCM) is keyed from; the 32-byte AES key is derived via SHA-256 in `src/server/session.ts`. Minimum 32 characters — the console refuses to start without it. |
| `API_GATEWAY_KEY` | `vault-kv` | yes | `CHANGE_ME` | `apps/api` | The credential STT presents to the gateway. STT is the one service that authenticates with `X-Internal-Service-Key` rather than `X-Service-Token`, reusing this key instead of minting a second STT credential (`InternalServiceTokenGuard.SERVICE_SECRETS.stt`). There is no `STT_SERVICE_TOKEN`. NOT a free-form shared secret like the `*_SERVICE_TOKEN` values: `X-Internal-Service-Key` is also read by the GLOBAL `UnifiedAuthGuard` (`ApiKeyService.extractApiKeyFromRequest`), so this MUST be the RAW value of a registered ACTIVE SERVICE_ACCOUNT ApiKey row — a random secret with no matching row 401s every `/internal/stt/*` callback (BUG-013). Dev uses the seeded fixture; provision one with `pnpm gen:api-key`. |
| `API_INSPECT_HOSTPORT` | `env` | no | `127.0.0.1:9229` | `apps/api` | Inspector endpoint for `nest start --debug`, so a test gateway can be debugged alongside a dev one (test: 127.0.0.1:9329). |
| `API_KEY_ALLOW_QUERY_PARAM` | `global-kv` | no | `false` | `apps/api` | When true, an API key may be presented as a query parameter. PLATFORM-ONLY by construction: the only reader is the ANONYMOUS credential-extraction step, which runs before the caller — and therefore the tenant — is known, so there is no tenant scope to resolve it at. Query strings land in access logs and referrers: keep OFF unless a specific integration forces it. `API_KEY_ALLOW_QUERY_PARAM` remains the bootstrap fallback. |
| `API_KEY_MAX_LIFETIME_DAYS` | `global-kv` | no | — | `apps/api` | Ceiling on a requested API-key expiry, resolved for the KEY'S TENANT at issue time. UNSET MEANS UNLIMITED — `apikey.service.ts` skips the clamp when no value resolves. A tenant may SHORTEN its own ceiling (or set one where the platform has none) but never lengthen it past the platform value (`tenant-clamp.ts`: lower-is-stricter). `API_KEY_MAX_LIFETIME_DAYS` remains the bootstrap fallback. |
| `API_KEY_PEPPER` | `vault-kv` | yes | `CHANGE_ME` | `apps/api` | Server-side pepper mixed into every API-key hash. CHANGING IT INVALIDATES EVERY ISSUED API KEY AT THE INSTANT IT CHANGES — a stored hash computed under pepper vN can never be verified under vN+1. ROTATION IS THEREFORE STAGED, NEVER SWAPPED, and is keyVersion-aware in exactly the way `GlobalSetting` already models secret material (`encryptedValue` + `keyVersion`): (1) write the NEW pepper as a new Vault kv-v2 version — kv-v2 keeps prior versions, so vN stays readable; (2) verification reads the keyVersion recorded on the ApiKey row and verifies under THAT pepper, so vN and vN+1 keys are both valid during the overlap; (3) newly issued and re-hashed keys are stamped with the new keyVersion; (4) once no row still references vN — or the announced overlap window closes — retire vN. Skipping the overlap is an outage for every integration at once. Vault kv-v2 versioning is the mechanism; the keyVersion column is what makes it staged rather than a coin flip. STATUS (lane J): step (2)’s READ PATH now exists — `SecretFetchOptions.version` addresses a specific kv-v2 version through `SecretsService.getSecret(key, { version })`, cached per (key, version) and evicted together by `invalidate(key)`. What is still MISSING is the per-row half: `ApiKey` has no pepper-version column, so nothing records which pepper produced a stored hash, and `ApiKeyService.verify` has nothing to pass. Until that column, its migration, its domain trio and the issue/verify stamping land, a pepper change remains a cliff — the read path alone does not make the rotation staged. |
| `API_PORT` | `env` | no | `8868` | `apps/api` | Port the dev/test supervisor expects the gateway on; the gateway itself binds `PORT`. |
| `API_URL` | `env` | no | `http://localhost:8868` | `apps/admin-console` | Origin the BFF proxy (`src/app/api/hope/[...path]/route.ts`) forwards to. Server-side only — never reaches the client bundle. |
| `APP_SETTINGS_BOOT_INVARIANT` | `env` | no | — | `apps/api` | Set to `skip` (development only) to bypass the AppSettings boot invariant (`appSettings.service.ts`). |
| `AZURE_FOUNDRY_API_KEY` | `vault-kv` | yes | `CHANGE_ME` | `apps/api` | Azure AI Foundry credential used by the STT Foundry model loader. |
| `AZURE_STORAGE_ACCOUNT_KEY` | `vault-kv` | yes | `CHANGE_ME` | `apps/api` | Azure Storage shared account key — the alternative to `AZURE_STORAGE_CONNECTION_STRING` when the endpoint is composed from `accountName` + `endpointSuffix` on the storage config row. |
| `AZURE_STORAGE_CONNECTION_STRING` | `vault-kv` | yes | `CHANGE_ME` | `apps/api` | Full Azure Storage connection string (carries the account key) for the AZURE storage provider. Read by `BlobStorageProviderFactory.buildAzureProvider` AFTER the SYSTEM row’s `credentialsRef`, i.e. it is the env/kv fallback of the same two-step order as `S3_ACCESS_KEY`. Preferred over `AZURE_STORAGE_ACCOUNT_KEY`. |
| `DATABASE_URL` | `env` | yes | — | `apps/api` | Primary PostgreSQL connection string (PgBouncer transaction mode in production). Cannot come from the database or from Vault — this IS the credential that reaches them. No fallback exists: absence is a hard boot error. |
| `DEBUG` | `env` | no | `false` | `apps/api` | Enables verbose config/service debug logging. |
| `DIRECT_URL` | `env` | no | — | `apps/api` | Migrations-only, un-pooled PostgreSQL endpoint (`packages/database/src/migration-url.ts`). Falls back to `DATABASE_URL` when unset, which is correct in dev but wrong behind a transaction-mode pooler — production must set it explicitly. |
| `ENABLE_PRISMA_STUDIO` | `env` | no | `false` | `apps/api` | Mounts the Prisma Studio module (`app.module.ts`). ON in this dev-shaped sample so `pnpm setup:dev` leaves /db-studio working with no extra step; access still requires the dedicated `manage:PrismaStudio` ability (SUPER_ADMIN policy set). Deployed environments read host env only and leave it unset, which keeps the module off. |
| `ENTITLEMENTS_ENABLED_DEFAULT` | `env` | no | `false` | `apps/api` | SEED-TIME ONLY, and the only key in this file that is not a runtime gate: `seed/15-entitlements.ts` reads it to decide the value of the `entitlements.enabled` GlobalSetting row on a FRESH database. POLICY (TASK-638): quota enforcement is ON in every DEPLOYED environment (hope-v2-dev, staging, production) — each sets ENTITLEMENTS_ENABLED_DEFAULT=true in its host env / deploy overlay — and OFF only in LOCAL development (this committed default) and test/CI (never set), so a developer never fights quota locally and the shared E2E baseline stays deterministic. Keep this LOCAL default false; an operator flips it live via `PUT /admin/entitlements/enabled`. The live control plane is `entitlements.enabled` (already cataloged, tier `global-kv`, kill-switch). Its migration is therefore NOT to redis-flag but DELETION, once seeding takes its default from the descriptor instead of the environment. |
| `ENV_FILE_PATH` | `env` | no | — | `apps/api` | Overrides the NODE_ENV→file map used by `loadEnv()`. Unset in every normal deployment. |
| `GUARDRAIL_PORT` | `env` | no | `8863` | `apps/guardrail` | Port apps/guardrail binds (test: 8963). |
| `GUARDRAIL_SERVICE_TOKEN` | `vault-kv` | yes | `CHANGE_ME` | `apps/api` | Shared secret on the gateway↔guardrail hop (`X-Service-Token`). |
| `GUARDRAIL_URL` | `env` | no | `http://localhost:8863` | `apps/api` | Safety-engine base URL (apps/guardrail, port 8863). |
| `GUARDRAIL_V2_GROUNDEDNESS_ENABLED` | `env` | no | `false` | `apps/guardrail` | Gates the guardrail NLI groundedness gate (`GUARDRAIL_V2_GROUNDEDNESS_` prefix). OFF is the dev/hermetic-CI bypass: the gate answers honestly with `unverified` and never loads a model. Fail posture is FAIL-CLOSED throughout — a disabled gate, an un-staged model and a scoring error all degrade to `unverified`, and no path yields `grounded` without the model actually entailing the segment. Turning it ON requires the self-hosted MiniCheck-class model staged on the host (no cloud PHI). |
| `HARNESS_ATOMIC_FACT_ENABLED` | `env` | no | `false` | `apps/harness` | Gates the `run_inferential_sensors` atomic-fact path. Same policy-overrides-env shape as the NER-priors flag. |
| `HARNESS_CLAIM_CHECK_ACCESS_KEY` | `vault-kv` | yes | `CHANGE_ME` | `apps/harness` | S3/MinIO access key for the harness claim-check blob store. The offloaded payloads are clinical content, so the store is SELF-HOSTED by contract — this credential must never address a cloud bucket. |
| `HARNESS_CLAIM_CHECK_ENABLED` | `env` | no | `true` | `apps/harness` | Moves large clinical blobs OUT of Temporal workflow history into a self-hosted content-addressed store, protecting the ~50 MB history budget. DEFAULTS **ON**, and is therefore NOT marked `killSwitch` — it is a PROTECTION, so turning it off REMOVES a safeguard (unbounded history growth) rather than disabling an enforcement path. Marking it a kill-switch would violate the defaults-OFF invariant and fail registry assembly. Same polarity as `rate-limit.enabled`. Turning it off is a deliberate acceptance of unbounded Temporal history, exactly as the harness startup validator states. |
| `HARNESS_CLAIM_CHECK_SECRET_KEY` | `vault-kv` | yes | `CHANGE_ME` | `apps/harness` | S3/MinIO secret key for the harness claim-check blob store (self-hosted only; PHI must not egress). |
| `HARNESS_INTERNAL_SERVICE_TOKEN` | `vault-kv` | yes | `CHANGE_ME` | `apps/api` | SECOND, SEPARATE harness credential — NOT an alias of `HARNESS_SERVICE_TOKEN`. It gates the knowledge-ingest endpoint only (`apps/harness/.../api/endpoints/knowledge.py`, pydantic field `internal_service_token` under the `HARNESS_` prefix) and is resolved by `KnowledgeIngestClient` for the outbound `X-Service-Token`. Added by lane J: it was read through SecretsService but had no descriptor, so `vault-seed-secrets.sh` never seeded it and every ingest call would 401 on a Vault-backed deployment. |
| `HARNESS_NER_PRIORS_ENABLED` | `env` | no | `false` | `apps/harness` | Gates reuse of already-persisted CODED NER priors inside harness activities. A workflow-policy value may override it per run; this is the fallback when the policy says nothing. |
| `HARNESS_PORT` | `env` | no | `8866` | `apps/harness` | Port apps/harness binds (test: 8966). |
| `HARNESS_SERVICE_TOKEN` | `vault-kv` | yes | `CHANGE_ME` | `apps/api` | Shared secret on the gateway↔harness hop. Fetched on demand (not a warmup key) by `HarnessOpsClient` / `HarnessGatewayService` / `HarnessServiceTokenGuard`. It MUST equal the harness process’s own `HARNESS_SERVICE_TOKEN`, or every `/api/v1/internal/harness/*` call 401s. |
| `HARNESS_URL` | `env` | no | `http://localhost:8866` | `apps/api` | Clinical Documentation Harness base URL (apps/harness, port 8866). |
| `HARNESS_WARM_START_ENABLED` | `env` | no | `false` | `apps/harness` | Env FALLBACK for harness warm-start; `HarnessInternalService` treats the DB/policy value as the authority and consults this only when that is absent. Being a fallback for a policy value is itself an argument for moving it out of env. |
| `INTERNAL_ACCESS_TOKEN` | `vault-kv` | yes | `CHANGE_ME` | `apps/api` | THE canonical internal service-to-service credential (owner decision D-D, 2026-08-17): **one** shared access token, identical across every service, set by the DevOps engineer, internal use only. It is presented and accepted as `X-Service-Token` on every internal hop — gateway↔text/nlp/guardrail/harness/tts and every peer-to-peer hop (harness→text/nlp/guardrail, text→guardrail, nlp→text). There is deliberately NO per-service and NO per-pair token in the target state: the `*_SERVICE_TOKEN` family below (`TEXT_`, `NLP_`, `GUARDRAIL_`, `HARNESS_`, `TTS_`, and harness’s outbound `HARNESS_TEXT_`/`HARNESS_NLP_`) is retained ONLY as a zero-cost backward-compatibility fallback — every inbound middleware accepts EITHER this token or its own legacy secret, and every outbound client PREFERS this token and falls back to its legacy per-target secret when unset. Set this one variable and the legacy family can all be dropped. This is the sanctioned env-var exception to D-B (configuration lives in the DB) — it is bootstrap-floor auth material, delivered from Vault in deployed environments. NOT the same thing as `HARNESS_INTERNAL_SERVICE_TOKEN`, which gates the harness knowledge-ingest endpoint only, nor `API_GATEWAY_KEY`, which must be a real ApiKey row (see below). |
| `JWT_SECRET_KEY` | `vault-kv` | yes | `CHANGE_ME` | `apps/api` | HS256 signing secret for gateway-issued access tokens. Warmed at boot; `apps/api/src/main.ts` refuses to start when it is still a placeholder. Rotating it invalidates every outstanding access token immediately (they are short-lived, so the blast radius is one token TTL). |
| `LIVE_DOC_GROUNDEDNESS_ENABLED` | `env` | no | `false` | `apps/api` | Gates the output-side groundedness check on the live-documentation path. Read once in the `LiveDocumentationService` constructor as `=== "true"`, so a change needs a restart — the clearest instant-fan-out candidate in this file. |
| `LOG_FILE_DATE_PATTERN` | `env` | no | `yyyy-MM-dd` | `apps/api` | Date pattern in rotated log file names. |
| `LOG_FILE_ENABLED` | `env` | no | `false` | `apps/api` | Writes rotating log files in addition to stdout. |
| `LOG_FILE_MAX_FILES` | `env` | no | `1000` | `apps/api` | Number of rotated log files kept. |
| `LOG_FILE_MAX_SIZE` | `env` | no | `10m` | `apps/api` | Rotate after this much data (winston-daily-rotate-file syntax). |
| `LOG_FILE_PATH` | `env` | no | `./logs` | `apps/api` | Directory rotating log files are written to. |
| `LOG_FILE_SEPARATE_ERROR` | `env` | no | `false` | `apps/api` | Writes errors to their own file in addition to the combined log. |
| `LOG_LEVEL` | `global-kv` | no | `info` | `apps/api` | Gateway log level, applied live by `PlatformKnobsBinder` through `ILoggingService.setLevel` whenever the settings cache refreshes — so an operator can raise verbosity during an incident with no redeploy. `LOG_LEVEL` remains the BOOTSTRAP value: it is read pre-bootstrap in `apps/api/src/main.ts` (before the Nest module graph, therefore before any DB) to seed the Nest logger. |
| `LOG_REDACT_FIELDS` | `env` | no | — | `apps/api` | Comma-separated field names redacted from every log entry, on top of the built-in PHI key list. Matching is case-insensitive and ignores _ and -. |
| `LOKI_ENABLED` | `env` | no | `false` | `apps/api` | Pushes logs to Loki in addition to stdout. Requires `LOKI_HOST`. |
| `LOKI_HOST` | `env` | no | — | `apps/api` | Loki base URL; the transport appends `/loki/api/v1/push`. Unset disables the transport. |
| `LOKI_LABELS` | `env` | no | — | `apps/api` | Comma-separated `key=value` pairs merged into every stream label set. Keep LOW-cardinality — never a tenant, user, or request id. |
| `METERING_RECONCILE_ENABLED_DEFAULT` | `env` | no | `false` | `apps/api` | SEED-TIME ONLY, and not itself a runtime gate: `seed/15-entitlements.ts` reads it to decide the value of the `metering.reconcile.enabled` GlobalSetting row on a FRESH database. POLICY (TASK-638): reconcile is ON in every DEPLOYED environment (hope-v2-dev, staging, production) — each sets METERING_RECONCILE_ENABLED_DEFAULT=true in its host env / deploy overlay — and OFF only in LOCAL development (this committed default) and test/CI (never set). Keep this LOCAL default false so a developer laptop never runs the sweep; flip live via the admin control plane. The live control plane is `metering.reconcile.enabled` (already cataloged above, tier `global-kv`, kill-switch). Mirrors `entitlements.enabledDefault` exactly; its migration is DELETION, once seeding takes its default from the descriptor instead of the environment. |
| `METRICS_COLLECT_INTERVAL` | `env` | no | `15000` | `apps/api` | Interval of the simplified monitoring collector. |
| `METRICS_PREFIX` | `env` | no | — | `apps/api` | Prefix for Prometheus metric names; defaults to the sanitized service name. |
| `MINIO_ACCESS_KEY` | `vault-kv` | yes | `CHANGE_ME` | `apps/api` | MinIO/S3 access key for platform object storage. NOTE: the per-tenant / platform-default STORAGE CONFIG (endpoint, region, path style, prefix) is a separate concern owned by `TenantStorageConfig`; only the credential lives here, referenced by `credentialsRef`. |
| `MINIO_ENDPOINT` | `env` | no | — | `apps/api` | Deploy-time fallback used ONLY before the SYSTEM storage row exists (first boot / pre-seed). Scheduled for removal one release after the SYSTEM row ships; a WARN is logged whenever it is the tier that supplied the value. |
| `MINIO_REGION` | `env` | no | `us-east-1` | `apps/api` | Region passed to the S3-compatible client. |
| `MINIO_SECRET_KEY` | `vault-kv` | yes | `CHANGE_ME` | `apps/api` | MinIO/S3 secret key for platform object storage. |
| `MINIO_USE_SSL` | `env` | no | `false` | `apps/api` | Whether the object-storage endpoint is reached over TLS. |
| `MQTT_HOST` | `env` | no | `localhost` | `apps/api` | MQTT broker host. |
| `MQTT_PASS` | `vault-kv` | yes | `CHANGE_ME` | `apps/api` | MQTT broker password, consumed by `MqttService` via `ConfigService`. |
| `MQTT_PORT` | `env` | no | `1883` | `apps/api` | MQTT broker port. |
| `MQTT_USER` | `env` | no | — | `apps/api` | MQTT broker username. The password is a `vault-kv` secret (`MQTT_PASS`). |
| `NEST_DEBUG` | `env` | no | `false` | `apps/api` | Enables NestJS-internal debug logging. |
| `NEXT_PUBLIC_API_HOST` | `env` | no | `http://localhost:8868` | `apps/admin-console` | Origin the BROWSER connects to directly for SSE/WS streams (authenticated with single-use stream tickets). Inlined into the client bundle by Next.js, so it must be non-secret (`src/config/public-env.ts`). |
| `NLP_PORT` | `env` | no | `8864` | `apps/nlp` | Port apps/nlp binds. |
| `NLP_SERVICE_TOKEN` | `vault-kv` | yes | `CHANGE_ME` | `apps/api` | Shared secret on the gateway↔NLP hop (`X-Service-Token`). |
| `NLP_URL` | `env` | no | `http://localhost:8864` | `apps/api` | Medical-NLP base URL (apps/nlp, port 8864). |
| `NODE_ENV` | `env` | no | `development` | `apps/api` | Selects the env file `loadEnv()` reads (`.env.dev` / `.env.test` / `.env.production`); CI and production load NO file and use host env only. |
| `OTEL_DEBUG` | `env` | no | `false` | `apps/api` | Enables the OpenTelemetry diagnostic logger. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `env` | no | — | `apps/api` | gRPC OTLP collector endpoint. Unset disables the exporters. |
| `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` | `env` | no | — | `apps/api` | Pins the OTel GenAI instrumentation-library content-capture switch off, so prompt/completion text (PHI) is never stamped onto spans. Boot-time audit refuses to start in production unless this is exactly NO_CONTENT. |
| `OTEL_METRICS_ENABLED` | `env` | no | `false` | `apps/api` | Turns on the OpenTelemetry metrics pipeline. |
| `OTEL_SDK_DISABLED` | `env` | no | `false` | `apps/api` | Skips OpenTelemetry SDK start-up entirely. |
| `OTEL_SERVICE_NAME` | `env` | no | `api-gateway` | `apps/api` | Value of the `service.name` resource attribute. |
| `OTEL_SERVICE_VERSION` | `env` | no | `1.0.0` | `apps/api` | Value of the `service.version` resource attribute. |
| `OTEL_TRACES_ENABLED` | `env` | no | `false` | `apps/api` | Turns on the OpenTelemetry tracing pipeline. |
| `OUTPUT_PATH` | `env` | no | `..` | `packages/tools` | Base path the domain-layer generators write to, relative to `packages/tools` (`generate-data-model`, `generate-data-entity`, `generate-factory`). |
| `PASSWORD_RESET_BASE_URL` | `env` | no | `http://localhost:5176` | `apps/api` | Base URL embedded in password-reset emails (`IPasswordResetMailer.DEFAULT_PASSWORD_RESET_BASE_URL`). |
| `PG_DATABASE` | `env` | no | `hope_main` | `apps/api` | Database used when assembling a dynamic-credential connection. |
| `PG_DYNAMIC_CREDS` | `env` | no | `false` | `apps/api` | Opt in to Vault-issued, short-lived PostgreSQL credentials (plan §4 B6). |
| `PG_HOST` | `env` | no | `localhost` | `apps/api` | Host used when assembling a dynamic-credential connection (`vault-client.ts`). |
| `PG_PORT` | `env` | no | `5432` | `apps/api` | Port used when assembling a dynamic-credential connection. |
| `PG_VAULT_MAX_TTL_SEC` | `env` | no | — | `apps/api` | Upper bound applied to a Vault-issued credential lease. |
| `PG_VAULT_ROLE` | `env` | no | `hope-app-role` | `apps/api` | Vault database-engine role that mints the dynamic credentials. |
| `PORT` | `env` | no | `8868` | `apps/api` | HTTP listen port for the NestJS gateway. |
| `PRISMA_PG_MAX` | `env` | no | `5` | `apps/api` | Driver-adapter connection-pool size. The Prisma v6 `connection_limit` URL parameter is ignored. Budget rule: `pods × PRISMA_PG_MAX ≤ 0.7 × PG max_connections`. A non-positive-integer value is a hard error, not a silent fallback. |
| `PROMETHEUS_URL` | `env` | no | `http://localhost:9090` | `apps/api` | Prometheus query endpoint for the platform-metrics service (`prometheus-query.service.ts`). |
| `RATE_LIMIT_ENABLED` | `global-kv` | no | `true` | `apps/api` | Whether throttling is enforced. A tenant may only move this towards the STRICT end (`tenant-clamp.ts`: true-is-stricter), so a tenant admin can switch throttling ON for itself but can never switch off a protection the platform has enabled. `RATE_LIMIT_ENABLED` remains the module-bootstrap baseline read by `RateLimitConfigService` (`!== "false"`), which only decides whether the throttler is WIRED at boot. |
| `RATE_LIMIT_MAX_REQUESTS` | `global-kv` | no | `100` | `apps/api` | Requests per window for the always-on `default` throttler tier, resolved PER TENANT on the hot path by `TieredThrottlerGuard`. A tenant may only LOWER it, and never above its plan entitlement (the entitlement ceiling). `RATE_LIMIT_MAX_REQUESTS` remains the module-bootstrap baseline. |
| `RATE_LIMIT_WINDOW_MS` | `global-kv` | no | `60000` | `apps/api` | Window length for the always-on `default` throttler tier, resolved per tenant with `rateLimit.maxRequests`. A LONGER window over the same limit is a TIGHTER budget, so this is the one knob where a tenant may only raise the number (`tenant-clamp.ts`: higher-is-stricter) — otherwise a tenant could set a 1 ms window and make its limit meaningless. `RATE_LIMIT_WINDOW_MS` remains the module-bootstrap baseline. |
| `REDIS_HOST` | `env` | no | `localhost` | `apps/api` | Redis host, used when `REDIS_URL` is unset. |
| `REDIS_PASS` | `vault-kv` | yes | `CHANGE_ME` | `apps/api` | Redis AUTH password. Resolved through SecretsService and layered over the env value by `ConfigService.applySecretOverrides`. |
| `REDIS_PORT` | `env` | no | `6379` | `apps/api` | Redis port, used when `REDIS_URL` is unset. |
| `REDIS_URL` | `env` | no | — | `apps/api` | Full Redis connection URL; when set it wins over the host/port pair. |
| `REFRESH_TOKEN_TTL_SECONDS` | `global-kv` | no | `604800` | `apps/api` | Refresh-token lifetime, resolved for the ISSUING tenant on every `issue()` — previously read once in the `RefreshTokenService` constructor, so a change needed a restart. A tenant may only SHORTEN it (`tenant-clamp.ts`: lower-is-stricter). A non-finite or non-positive resolved value falls back to the 7-day default. `REFRESH_TOKEN_TTL_SECONDS` remains the bootstrap fallback. |
| `REGISTRATION_SELF_SIGNUP_ENABLED` | `env` | no | `false` | `apps/api` | Gates the public self-signup routes: `RegisterController` returns 404 (not 403) when off, so the endpoint's existence is not disclosed. Read via `ConfigService.getConfigValue`, which parses it as `=== "true"` — anything else is off. The admin-console proxy allowlist mirrors this gate. |
| `S3_ACCESS_KEY` | `vault-kv` | yes | `CHANGE_ME` | `apps/api` | S3-protocol access key read by `S3Service`. In local dev this aliases the MinIO credential (HOPE speaks S3 to MinIO); in a deployed environment it may name a distinct S3 principal. |
| `S3_SECRET_KEY` | `vault-kv` | yes | `CHANGE_ME` | `apps/api` | S3-protocol secret key read by `S3Service`. |
| `SECRETS_LRU_MAX` | `env` | no | `200` | `apps/api` | Maximum entries in the SecretsService LRU cache. |
| `SECRETS_PROVIDER` | `env` | no | `env` | `apps/api` | Selects the secrets backend (`env` \| `vault` \| …). It decides where every `vault-kv` descriptor is actually read from, so it necessarily precedes all of them. |
| `SECRETS_REWARM_INTERVAL_SEC` | `env` | no | `0` | `apps/api` | How often the SecretsService re-warms its boot warmup set so the cache-only getSecretSync path (TEXT/TTS X-Service-Token) never expires cold. Unset/<=0 derives max(30, TTL/2). |
| `SECRETS_TTL_SEC` | `env` | no | `300` | `apps/api` | Per-entry TTL of the SecretsService LRU cache. |
| `SEMANTIC_ENDPOINT_ENABLED` | `env` | no | `false` | `apps/api` | Gates content-driven semantic end-of-utterance detection on the STT streaming hot path. NOTE the naming exception: the STT `Settings` class carries NO `env_prefix`, so this is the BARE `SEMANTIC_ENDPOINT_ENABLED`, not `STT_SEMANTIC_ENDPOINT_ENABLED` — one of the plan §3.3 rule-1 violations (prefix must equal the service prefix) that a later rename has to fix. Default OFF until measured against the accuracy/latency scorecard. |
| `SERVICE_NAME` | `env` | no | `hope-api` | `apps/api` | Logical service name stamped on logs and metrics. |
| `SESSION_SECRET_KEY` | `vault-kv` | yes | `CHANGE_ME` | `apps/api` | Signing/encryption secret for server-side session material. Rotating it invalidates existing sessions; users re-authenticate. |
| `SHUTDOWN_DRAIN_DELAY_MS` | `global-kv` | no | `5000` | `apps/api` | Delay between failing readiness and closing the server, so a load balancer stops routing before connections drop. Resolved at drain time (see `shutdown.timeoutMs`). `SHUTDOWN_DRAIN_DELAY_MS` remains the bootstrap fallback. |
| `SHUTDOWN_TIMEOUT_MS` | `global-kv` | no | `30000` | `apps/api` | Upper bound on graceful shutdown before the process is forced down. `GracefulShutdownService` resolves it at SHUTDOWN time, not construction time, so a change applies to the next drain without a restart. `SHUTDOWN_TIMEOUT_MS` remains the bootstrap fallback. |
| `STORAGE_ACCESS_KEY_PEPPER` | `vault-kv` | yes | `CHANGE_ME` | `apps/api` | HMAC pepper for hashing tenant STORAGE access-key secrets (`StorageAccessKeyService.hashSecretForStorage`). Falls back to the shared `API_KEY_PEPPER` when unset, then to un-peppered SHA-256 — so it inherits `API_KEY_PEPPER`’s rotation cliff: changing it invalidates every stored storage access key. Stage a rotation the same way (see `api.keyPepper`). |
| `STORAGE_PLATFORM_DEFAULT_CREDENTIALS` | `vault-kv` | yes | `CHANGE_ME` | `apps/api` | Operator-set JSON `{ accessKeyId, secretAccessKey }` at the Vault path recorded in the SYSTEM row's `credentialsRef` (default `platform/storage/minio`). Never stored in the database and never returned by any API. |
| `STT_PORT` | `env` | no | `8861` | `apps/stt` | Port apps/stt binds (test: 8961). |
| `STT_URL` | `env` | no | `http://localhost:8861` | `apps/api` | Speech-to-text service base URL (apps/stt, port 8861). |
| `STT_WS_EGRESS_HIGH_WATERMARK_BYTES` | `env` | no | `524288` | `apps/stt` | Buffered-amount threshold above which partial transcripts are dropped. |
| `STT_WS_RESUME_GRACE_MS` | `env` | no | `15000` | `apps/stt` | Window a disconnected STT session is held open for reconnect. |
| `TEXT_PORT` | `env` | no | `8862` | `apps/text` | Port apps/text binds; the gateway keeps it only to build health-probe URLs. |
| `TEXT_SERVICE_TOKEN` | `vault-kv` | yes | `CHANGE_ME` | `apps/api` | Shared secret on the gateway↔TEXT hop. TEXT reads it as `settings.service_token` under its `TEXT_` pydantic prefix; the gateway resolves the same name for outbound proxying and for `InternalServiceTokenGuard`'s inbound check. |
| `TEXT_URL` | `env` | no | `http://localhost:8862` | `apps/api` | Text service base URL (apps/text, port 8862). |
| `TTS_PORT` | `env` | no | `8865` | `apps/tts` | Port apps/tts binds. |
| `TTS_SERVICE_TOKEN` | `vault-kv` | yes | `CHANGE_ME` | `apps/api` | Shared secret on the gateway↔TTS hop (`X-Service-Token`). |
| `TTS_URL` | `env` | no | `http://localhost:8865` | `apps/api` | Text-to-speech base URL (apps/tts, port 8865). |
| `TTS_WS_EGRESS_HIGH_WATERMARK_BYTES` | `env` | no | `524288` | `apps/tts` | Buffered-amount threshold above which TTS audio frames are dropped. |
| `URL` | `env` | no | `http://localhost` | `apps/api` | Public base URL the gateway advertises for itself. |
| `VAULT_ADDR` | `env` | no | `http://localhost:8200` | `apps/api` | Vault API address. Required when `SECRETS_PROVIDER=vault`. |
| `VAULT_AUDIT_LOG_PATH` | `env` | no | — | `apps/api` | File the rotation worker tails for Vault audit events. Unset disables the worker. |
| `VAULT_DB_ADMIN_PASS` | `env` | yes | `CHANGE_ME` | `apps/api` | Password for the `vault_admin` PostgreSQL role that VAULT ITSELF uses to mint short-lived DB credentials. CLASSIFIED `env`, NOT `vault-kv`, DELIBERATELY: it is consumed at Vault PROVISIONING time by `infrastructure/docker/configs/vault/dev-init.sh`, `scripts/setup-dev-vault-db.sh` and docker-compose — before any Vault kv-v2 read is possible. Storing it in Vault would be circular. It is a real credential and belongs on the §6 rotation list; the bootstrap floor is where it has to live. |
| `VAULT_DEV_ROOT_TOKEN` | `env` | no | — | `apps/api` | Root token of the LOCAL dev Vault; used by seeds. Never set in a deployed environment. |
| `VAULT_KV_MOUNT` | `env` | no | `secret` | `apps/api` | Mount path of the kv-v2 engine. Final secret path: `<mount>/data/<prefix>/<NAME>`. |
| `VAULT_KV_PREFIX` | `env` | no | `hope` | `apps/api` | Prefix beneath the kv-v2 mount under which every platform secret is stored. |
| `VAULT_NAMESPACE` | `env` | no | — | `apps/api` | Vault Enterprise namespace. Unset on OSS Vault. |
| `VAULT_REQUEST_TIMEOUT_MS` | `env` | no | `5000` | `apps/api` | Per-request timeout of the Vault HTTP client. |
| `VAULT_ROLE_ID` | `env` | no | — | `apps/api` | AppRole role_id. Non-secret by Vault design (it is the public half of the AppRole pair) and useless without a secret_id, so it is classified `internal`, not `secret`. |
| `VAULT_SECRET_ID` | `env` | yes | `CHANGE_ME` | `apps/api` | RAW, reusable AppRole secret_id — the DEV path (`scripts/refresh-vault-creds.sh`; `secret_id_num_uses=0`, `secret_id_ttl=720h`), because a response-wrapped token is single-use and dies on the first watch-mode restart. This is genuine credential material, but it CANNOT live in Vault: it is what authenticates TO Vault. |
| `VAULT_TOKEN` | `env` | no | — | `apps/api` | Direct Vault token. Operator/CLI path only — services authenticate with AppRole. |
| `VAULT_TRANSIT_KEY` | `env` | no | `hope-globalsetting` | `apps/api` | Transit key that wraps `GlobalSetting.encryptedValue`. |
| `VAULT_TRANSIT_KEY_PHI` | `env` | no | `hope-phi` | `apps/api` | Transit key that wraps PHI columns. |
| `VAULT_TRANSIT_MOUNT` | `env` | no | `transit` | `apps/api` | Mount path of the Transit engine used for envelope encryption. |
| `VAULT_WRAPPED_SECRET_ID` | `env` | yes | `CHANGE_ME` | `apps/api` | PRODUCTION path: a single-use response-wrapping token unwrapped once per process start. Blank in dev so the raw path is taken. Same bootstrap exemption as `VAULT_SECRET_ID`. |
| `WEBHOOK_SECRET_PEPPER` | `vault-kv` | yes | `CHANGE_ME` | `apps/api` | Key-derivation material for the REVERSIBLE AES-256-GCM encryption `WebhookService` applies to every server-generated webhook signing secret before storage (`WebhookService.encryptSecretForStorage`). NOT an HMAC pepper like `api.keyPepper` — webhook signing requires the platform to recover the RAW secret at delivery time (to compute an HMAC the receiver, who only ever saw the raw secret once, can independently verify), so the stored form must be decryptable, not a one-way hash. See `WebhookService`'s class doc for the full rationale. DELIBERATELY A SEPARATE VAULT SECRET FROM `API_KEY_PEPPER` — reusing the API-key pepper would couple two independent rotation lifecycles: rotating one to respond to an API-key compromise would silently invalidate every webhook signature (and vice versa), and a caller with no legitimate reason to hold both credentials would need only one to attack both surfaces. Unset ⇒ falls back to a fixed local key-derivation string (no cross-credential fallback chain), matching `ApiKeyService`’s own legacy/no-SecretsService fallback — NOT a security posture to rely on in a Vault-backed deployment. Rotation is a bigger event than `api.keyPepper`'s stage-and-overlap pattern: changing this key makes every EXISTING stored ciphertext undecryptable (there is no keyVersion column here either), so a rotation must re-encrypt every `Webhook.hashedSecret` row under the new key in the same operation — a re-encryption migration, not a Vault kv-v2 version bump alone. |
| `WORKFLOW_EXPOSURE_ENABLED` | `env` | no | `false` | `apps/api` | R-1 kill-switch for the whole `/api/v1/workflows/:slug/…` public-invoke surface (TASK-722). Design.md's precondition: TASK-708's API-key scope enforcement must be verified end-to-end before this ships enabled; Temporal is also not yet production-ready (R-2). Read via `ConfigService.getConfigValue('WORKFLOW_EXPOSURE_ENABLED')`, `=== "true"` — a 404 (existence not disclosed) while off, same posture as `registration.selfSignupEnabled`. |

## Variables — the Python services

Introspected from each service’s pydantic-settings classes. **In file** says
whether the generated `.env.sample` emits the line LIVE (a secret, a field with
no code default, or a declared local-dev override) or commented out at its code
default — see `renderPythonExample()` in `scripts/env-sync.mts`.

| Variable | Service | Required | Secret | Default | In file | Also accepted |
|---|---|---|---|---|---|---|
| `API_GATEWAY_KEY` | `apps/stt` | no | yes | `CHANGE_ME` | live | — |
| `API_GATEWAY_TIMEOUT__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `30` | commented | — |
| `API_GATEWAY_URL` | `apps/stt` | no | no | `http://localhost:8868/api/v1` | commented | — |
| `APP_NAME__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `stt` | commented | — |
| `APP_VERSION__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `2.0.0` | commented | — |
| `AZURE_FOUNDRY_ENABLED__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `false` | commented | — |
| `AZURE_FOUNDRY_ENDPOINT__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | — | commented | — |
| `AZURE_SPEECH_REGION__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | — | commented | — |
| `AZURE_STORAGE_ACCOUNT` | `apps/stt` | no | no | `` | commented | — |
| `AZURE_STORAGE_ACCOUNT_KEY` | `apps/stt` | no | yes | `CHANGE_ME` | live | — |
| `AZURE_STORAGE_CONNECTION_STRING` | `apps/stt` | no | yes | `CHANGE_ME` | live | — |
| `AZURE_STORAGE_ENDPOINT_SUFFIX` | `apps/stt` | no | no | `core.windows.net` | commented | — |
| `CORS_ORIGINS` | `apps/stt` | no | no | `[]` | commented | — |
| `DATABASE_MAX_OVERFLOW` | `apps/stt` | no | no | `10` | commented | — |
| `DATABASE_POOL_SIZE` | `apps/stt` | no | no | `5` | commented | — |
| `DATABASE_URL` | `apps/stt` | no | no | `postgresql+asyncpg://postgres:postgres@localhost:5432/hope` | commented | — |
| `DIARIZATION_DEVICE__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `auto` | commented | — |
| `DIARIZATION_HF_MODEL_ID__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `pyannote/wespeaker-voxceleb-resnet34-LM` | commented | — |
| `GUARDRAIL_CONFIG_CACHE_TTL_S` | `apps/guardrail` | no | no | `60` | commented | — |
| `GUARDRAIL_DATABASE_URL` | `apps/guardrail` | no | no | `postgresql+asyncpg://postgres:postgres@localhost:5432/hope` | commented | — |
| `GUARDRAIL_MAX_OVERFLOW` | `apps/guardrail` | no | no | `10` | commented | — |
| `GUARDRAIL_POOL_SIZE` | `apps/guardrail` | no | no | `5` | commented | — |
| `GUARDRAIL_PORT` | `apps/guardrail` | no | no | `8863` | commented | `GUARDRAIL_V2_PORT` |
| `GUARDRAIL_REDIS_URL` | `apps/guardrail` | no | no | `redis://localhost:6379/0` | commented | `GUARDRAIL_REDIS_REDIS_URL` |
| `GUARDRAIL_SERVICE_TOKEN` | `apps/guardrail` | no | yes | `CHANGE_ME` | live | — |
| `GUARDRAIL_V2_CORS_ORIGINS` | `apps/guardrail` | no | no | `[]` | commented | — |
| `GUARDRAIL_V2_DEBUG` | `apps/guardrail` | no | no | `false` | commented | — |
| `GUARDRAIL_V2_GATEWAY_URL` | `apps/guardrail` | no | no | `http://localhost:8868/api/v1` | commented | — |
| `GUARDRAIL_V2_HOST` | `apps/guardrail` | no | no | `0.0.0.0` | commented | — |
| `GUARDRAIL_V2_LOG_LEVEL` | `apps/guardrail` | no | no | `info` | commented | — |
| `GUARDRAIL_V2_METRICS_ENABLED` | `apps/guardrail` | no | no | `true` | commented | — |
| `GUARDRAIL_V2_OTEL_ENABLED` | `apps/guardrail` | no | no | `false` | commented | — |
| `GUARDRAIL_V2_OTEL_EXPORTER_ENDPOINT` | `apps/guardrail` | no | no | `http://localhost:4317` | commented | — |
| `GUARDRAIL_V2_OTEL_SERVICE_NAME` | `apps/guardrail` | no | no | `guardrail` | commented | — |
| `GUARDRAIL_V2_QUEUE_MAX_CONCURRENT` | `apps/guardrail` | no | no | `4` | commented | — |
| `HARNESS_API_BASE_URL` | `apps/harness` | no | no | `http://localhost:8868` | commented | — |
| `HARNESS_API_INTERNAL_PREFIX` | `apps/harness` | no | no | `/api/v1/internal/harness` | commented | — |
| `HARNESS_API_TIMEOUT_S` | `apps/harness` | no | no | `30` | commented | — |
| `HARNESS_ATOMIC_FACT_ENABLED` | `apps/harness` | no | no | `false` | commented | — |
| `HARNESS_ATOMIC_FACT_ENTAIL_THRESHOLD` | `apps/harness` | no | no | `0.5` | commented | — |
| `HARNESS_ATOMIC_FACT_MODEL_CACHE_DIR` | `apps/harness` | no | no | `/models/harness-cache` | commented | — |
| `HARNESS_ATOMIC_FACT_MODEL_ID` | `apps/harness` | no | no | `nvhf/MiniCheck-Flan-T5-Large-Q6_K-GGUF` | commented | — |
| `HARNESS_ATOMIC_FACT_MODEL_PATH` | `apps/harness` | no | no | — | commented | — |
| `HARNESS_ATOMIC_FACT_N_CTX` | `apps/harness` | no | no | `512` | commented | — |
| `HARNESS_ATOMIC_FACT_N_GPU_LAYERS` | `apps/harness` | no | no | `0` | commented | — |
| `HARNESS_ATOMIC_FACT_N_THREADS` | `apps/harness` | no | no | — | commented | — |
| `HARNESS_CLAIM_CHECK_ACCESS_KEY` | `apps/harness` | no | yes | `CHANGE_ME` | live | — |
| `HARNESS_CLAIM_CHECK_BUCKET` | `apps/harness` | no | no | `harness-claim-check` | commented | — |
| `HARNESS_CLAIM_CHECK_ENABLED` | `apps/harness` | no | no | `true` | commented | — |
| `HARNESS_CLAIM_CHECK_ENDPOINT_URL` | `apps/harness` | no | no | `http://localhost:9000` | commented | — |
| `HARNESS_CLAIM_CHECK_MIN_BYTES` | `apps/harness` | no | no | `65536` | commented | — |
| `HARNESS_CLAIM_CHECK_REGION` | `apps/harness` | no | no | `us-east-1` | commented | — |
| `HARNESS_CLAIM_CHECK_SECRET_KEY` | `apps/harness` | no | yes | `CHANGE_ME` | live | — |
| `HARNESS_CLAIM_CHECK_SECURE` | `apps/harness` | no | no | `false` | commented | — |
| `HARNESS_CLAIM_CHECK_STORE` | `apps/harness` | no | no | `memory` | commented | — |
| `HARNESS_CONSENT_CACHE_TTL_SECONDS` | `apps/harness` | no | no | `30` | commented | — |
| `HARNESS_CONSENT_INTERNAL_PREFIX` | `apps/harness` | no | no | `/api/v1/internal/consent` | commented | — |
| `HARNESS_CONVERSATION_LANGUAGE` | `apps/harness` | no | no | `en` | commented | — |
| `HARNESS_CORS_ENABLED` | `apps/harness` | no | no | `false` | commented | — |
| `HARNESS_CORS_ORIGINS` | `apps/harness` | no | no | `[]` | commented | — |
| `HARNESS_DEBUG` | `apps/harness` | no | no | `false` | commented | — |
| `HARNESS_ENVIRONMENT` | `apps/harness` | no | no | `development` | commented | — |
| `HARNESS_EVAL_CASE_CONCURRENCY` | `apps/harness` | no | no | `1` | commented | — |
| `HARNESS_EVAL_FAITHFULNESS_THRESHOLD` | `apps/harness` | no | no | `0.85` | commented | — |
| `HARNESS_EVAL_GOLDEN_SET_VERSION` | `apps/harness` | no | no | `synthetic-v0.1.0` | commented | — |
| `HARNESS_EVAL_ICC_GATE_ENABLED` | `apps/harness` | no | no | `true` | commented | — |
| `HARNESS_EVAL_ICC_THRESHOLD` | `apps/harness` | no | no | `0.73` | commented | — |
| `HARNESS_EVAL_MAX_CASES_PER_RUN` | `apps/harness` | no | no | `50` | commented | — |
| `HARNESS_EVAL_PDSQI_ACCURATE_THRESHOLD` | `apps/harness` | no | no | `4` | commented | — |
| `HARNESS_EVAL_PDSQI_MEAN_THRESHOLD` | `apps/harness` | no | no | `4` | commented | — |
| `HARNESS_EVAL_PDSQI_THOROUGH_THRESHOLD` | `apps/harness` | no | no | `4` | commented | — |
| `HARNESS_GATE_ESCALATION_SECONDS` | `apps/harness` | no | no | `43200` | commented | — |
| `HARNESS_GATE_SLA_SECONDS` | `apps/harness` | no | no | `86400` | commented | — |
| `HARNESS_GUARDRAIL_BASE_URL` | `apps/harness` | no | no | `http://localhost:8863` | commented | — |
| `HARNESS_GUARDRAIL_SERVICE_TOKEN` | `apps/harness` | no | yes | `CHANGE_ME` | live | — |
| `HARNESS_GUARDRAIL_TIMEOUT_S` | `apps/harness` | no | no | `30` | commented | — |
| `HARNESS_HOST` | `apps/harness` | no | no | `0.0.0.0` | commented | — |
| `HARNESS_INTERNAL_SERVICE_TOKEN` | `apps/harness` | no | yes | `CHANGE_ME` | live | — |
| `HARNESS_JUDGE_ANCHORED` | `apps/harness` | no | no | `false` | commented | — |
| `HARNESS_JUDGE_AZURE_API_VERSION` | `apps/harness` | no | no | `2024-12-01-preview` | commented | — |
| `HARNESS_JUDGE_AZURE_DEPLOYMENT` | `apps/harness` | no | no | `` | commented | — |
| `HARNESS_JUDGE_AZURE_ENDPOINT` | `apps/harness` | no | no | `` | commented | — |
| `HARNESS_JUDGE_BEDROCK_REGION` | `apps/harness` | no | no | `us-east-1` | commented | — |
| `HARNESS_JUDGE_ENTAILMENT_BATCH_SIZE` | `apps/harness` | no | no | `1` | commented | — |
| `HARNESS_JUDGE_EXTRA_BODY` | `apps/harness` | no | no | — | commented | — |
| `HARNESS_JUDGE_MAX_RETRIES` | `apps/harness` | no | no | `2` | commented | — |
| `HARNESS_JUDGE_MAX_TOKENS` | `apps/harness` | no | no | `8192` | commented | — |
| `HARNESS_JUDGE_MODEL` | `apps/harness` | no | no | `gemma-4-e2b-it-qat` | commented | — |
| `HARNESS_JUDGE_OPENAI_COMPAT_BASE_URL` | `apps/harness` | no | no | `http://localhost:1234/v1` | commented | — |
| `HARNESS_JUDGE_OPENAI_COMPAT_JSON_RESPONSE_FORMAT` | `apps/harness` | no | no | `json_object` | live | — |
| `HARNESS_JUDGE_OPENAI_COMPAT_ORGANIZATION` | `apps/harness` | no | no | — | commented | — |
| `HARNESS_JUDGE_OUTPUT_MODE` | `apps/harness` | no | no | `with_explanation` | commented | — |
| `HARNESS_JUDGE_PROVIDER` | `apps/harness` | no | no | `openai_compat` | commented | — |
| `HARNESS_JUDGE_REASONING_MODE` | `apps/harness` | no | no | `auto` | commented | — |
| `HARNESS_JUDGE_SC_TEMPERATURE` | `apps/harness` | no | no | `0.2` | commented | — |
| `HARNESS_JUDGE_SEED` | `apps/harness` | no | no | — | commented | — |
| `HARNESS_JUDGE_SELF_CONSISTENCY` | `apps/harness` | no | no | `1` | commented | — |
| `HARNESS_JUDGE_SUPPRESS_REASONING` | `apps/harness` | no | no | `false` | commented | — |
| `HARNESS_JUDGE_TEMPERATURE` | `apps/harness` | no | no | `0` | commented | — |
| `HARNESS_JUDGE_TIMEOUT_S` | `apps/harness` | no | no | `300` | commented | — |
| `HARNESS_JUDGE_TRANSIENT_RETRIES` | `apps/harness` | no | no | `3` | commented | — |
| `HARNESS_JUDGE_TRANSIENT_RETRY_BACKOFF_S` | `apps/harness` | no | no | `12` | commented | — |
| `HARNESS_LOG_LEVEL` | `apps/harness` | no | no | `info` | commented | — |
| `HARNESS_MAX_CONCURRENT_ACTIVITIES` | `apps/harness` | no | no | `8` | commented | — |
| `HARNESS_MAX_REGEN` | `apps/harness` | no | no | `2` | commented | — |
| `HARNESS_MCP_MAX_ATTEMPTS` | `apps/harness` | no | no | `2` | commented | — |
| `HARNESS_MCP_MAX_RESULT_BYTES` | `apps/harness` | no | no | `65536` | commented | — |
| `HARNESS_MCP_TIMEOUT_S` | `apps/harness` | no | no | `20` | commented | — |
| `HARNESS_METRICS_ENABLED` | `apps/harness` | no | no | `true` | commented | — |
| `HARNESS_MODEL_CACHE_MAX_MODELS` | `apps/harness` | no | no | `1` | commented | — |
| `HARNESS_MODEL_CACHE_TTL_SECONDS` | `apps/harness` | no | no | `600` | commented | — |
| `HARNESS_NER_PRIORS_ENABLED` | `apps/harness` | no | no | `false` | commented | — |
| `HARNESS_NLP_BASE_URL` | `apps/harness` | no | no | `http://localhost:8864` | commented | — |
| `HARNESS_NLP_SERVICE_TOKEN` | `apps/harness` | no | yes | `CHANGE_ME` | live | — |
| `HARNESS_NLP_TIMEOUT_S` | `apps/harness` | no | no | `30` | commented | — |
| `HARNESS_OPTIMISTIC_DELIVERY_ENABLED` | `apps/harness` | no | no | `false` | commented | — |
| `HARNESS_OTEL_DEPLOYMENT_ENVIRONMENT` | `apps/harness` | no | no | `development` | commented | — |
| `HARNESS_OTEL_ENABLED` | `apps/harness` | no | no | `false` | commented | — |
| `HARNESS_OTEL_EXPORTER_ENDPOINT` | `apps/harness` | no | no | `` | commented | — |
| `HARNESS_OTEL_INSECURE` | `apps/harness` | no | no | `true` | commented | — |
| `HARNESS_OTEL_SERVICE_NAME` | `apps/harness` | no | no | `harness` | commented | — |
| `HARNESS_OTEL_SERVICE_NAMESPACE` | `apps/harness` | no | no | `hope` | commented | — |
| `HARNESS_PHI_ENABLED` | `apps/harness` | no | no | `true` | commented | — |
| `HARNESS_PHI_FAIL_CLOSED` | `apps/harness` | no | no | `true` | commented | — |
| `HARNESS_PHI_LOCAL_PROVIDERS` | `apps/harness` | no | no | `["lm-studio", "openai_compat", "ollama", "vllm", "llama-cpp"]` | commented | — |
| `HARNESS_PORT` | `apps/harness` | no | no | `8866` | commented | — |
| `HARNESS_PROMPT_SIZE_WARN_CHARS` | `apps/harness` | no | no | `400000` | commented | — |
| `HARNESS_REDIS_URL` | `apps/harness` | no | no | `redis://localhost:6379/0` | commented | — |
| `HARNESS_RETRIEVAL_COLLECTION` | `apps/harness` | no | no | `knowledge_chunks` | commented | — |
| `HARNESS_RETRIEVAL_EMBEDDINGS_BASE_URL` | `apps/harness` | no | no | `http://localhost:1234/v1` | commented | — |
| `HARNESS_RETRIEVAL_EMBEDDINGS_DIM` | `apps/harness` | no | no | `1024` | commented | — |
| `HARNESS_RETRIEVAL_EMBEDDINGS_MODEL` | `apps/harness` | no | no | `text-embedding-bge-m3` | commented | — |
| `HARNESS_RETRIEVAL_EMBEDDINGS_TIMEOUT_S` | `apps/harness` | no | no | `30` | commented | — |
| `HARNESS_RETRIEVAL_ENABLED` | `apps/harness` | no | no | `false` | commented | — |
| `HARNESS_RETRIEVAL_QDRANT_TIMEOUT_S` | `apps/harness` | no | no | `10` | commented | — |
| `HARNESS_RETRIEVAL_QDRANT_URL` | `apps/harness` | no | no | `http://localhost:6333` | commented | — |
| `HARNESS_RETRIEVAL_RERANKER_BASE_URL` | `apps/harness` | no | no | `http://localhost:8870` | commented | — |
| `HARNESS_RETRIEVAL_RERANKER_TIMEOUT_S` | `apps/harness` | no | no | `30` | commented | — |
| `HARNESS_RETRIEVAL_TOP_K_RERANK` | `apps/harness` | no | no | `5` | commented | — |
| `HARNESS_RETRIEVAL_TOP_K_RETRIEVAL` | `apps/harness` | no | no | `20` | commented | — |
| `HARNESS_SENSOR_ATOMIC_FACT_THRESHOLD` | `apps/harness` | no | no | `0.8` | commented | — |
| `HARNESS_SENSOR_CITATION_PRESENCE_THRESHOLD` | `apps/harness` | no | no | `1` | commented | — |
| `HARNESS_SENSOR_CITATION_VERIFY_THRESHOLD` | `apps/harness` | no | no | `0.8` | commented | — |
| `HARNESS_SENSOR_COVERAGE_THRESHOLD` | `apps/harness` | no | no | `0.8` | commented | — |
| `HARNESS_SENSOR_ENTITY_FAITHFULNESS_THRESHOLD` | `apps/harness` | no | no | `1` | commented | — |
| `HARNESS_SENSOR_GROUNDEDNESS_THRESHOLD` | `apps/harness` | no | no | `0.8` | commented | — |
| `HARNESS_SENSOR_NUMERIC_DOSE_THRESHOLD` | `apps/harness` | no | no | `1` | commented | — |
| `HARNESS_SERVICE_TOKEN` | `apps/harness` | no | yes | `CHANGE_ME` | live | — |
| `HARNESS_TEMPORAL_METRICS_HOST` | `apps/harness` | no | no | `127.0.0.1` | commented | — |
| `HARNESS_TEMPORAL_METRICS_PORT` | `apps/harness` | no | no | `9464` | commented | — |
| `HARNESS_TEXT_BASE_URL` | `apps/harness` | no | no | `http://localhost:8862` | commented | — |
| `HARNESS_TEXT_MODEL` | `apps/harness` | no | no | — | commented | — |
| `HARNESS_TEXT_PROVIDER` | `apps/harness` | no | no | — | commented | — |
| `HARNESS_TEXT_SERVICE_TOKEN` | `apps/harness` | no | yes | `CHANGE_ME` | live | — |
| `HARNESS_TEXT_TIMEOUT_S` | `apps/harness` | no | no | `120` | commented | — |
| `HF_HOME` | `apps/nlp` | no | no | `` | live | `NLP_HF_HOME` |
| `HUGGINGFACE_CACHE_DIR` | `apps/stt` | no | no | `<home>/.cache/huggingface/hub` | commented | — |
| `HUGGINGFACE_TOKEN` | `apps/stt` | no | yes | `CHANGE_ME` | live | — |
| `INTERNAL_ACCESS_TOKEN` | `apps/guardrail` | no | yes | `CHANGE_ME` | live | — |
| `INTERNAL_ACCESS_TOKEN` | `apps/harness` | no | yes | `CHANGE_ME` | live | — |
| `INTERNAL_ACCESS_TOKEN` | `apps/nlp` | no | yes | `CHANGE_ME` | live | `NLP_INTERNAL_ACCESS_TOKEN` |
| `INTERNAL_ACCESS_TOKEN` | `apps/stt` | no | yes | `CHANGE_ME` | live | — |
| `INTERNAL_ACCESS_TOKEN` | `apps/text` | no | yes | `CHANGE_ME` | live | `TOKEN` |
| `INTERNAL_ACCESS_TOKEN` | `apps/tts` | no | yes | `CHANGE_ME` | live | — |
| `MEDICAL_SUGGESTER_USE_GPU` | `apps/nlp` | no | no | `true` | commented | — |
| `METRICS_ENABLED` | `apps/stt` | no | no | `true` | commented | — |
| `MINIO_ACCESS_KEY` | `apps/stt` | no | yes | `CHANGE_ME` | live | — |
| `MINIO_AUDIO_BUCKET` | `apps/stt` | no | no | `hope-audio` | commented | — |
| `MINIO_CERT_CHECK` | `apps/stt` | no | no | `true` | commented | — |
| `MINIO_CHUNK_BUCKET` | `apps/stt` | no | no | `hope-audio-chunks` | commented | — |
| `MINIO_ENDPOINT` | `apps/stt` | no | no | `localhost:9000` | commented | — |
| `MINIO_SECRET_KEY` | `apps/stt` | no | yes | `CHANGE_ME` | live | — |
| `MINIO_SECURE` | `apps/stt` | no | no | `false` | commented | — |
| `MODEL_CACHE_MAX_MODELS__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `5` | commented | — |
| `MODEL_CACHE_TTL_SECONDS__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `3600` | commented | — |
| `NLP_ENVIRONMENT` | `apps/nlp` | no | no | `development` | commented | — |
| `NLP_EXTERNAL_TEXT_MAX_RETRIES` | `apps/nlp` | no | no | `2` | commented | — |
| `NLP_EXTERNAL_TEXT_RETRY_BACKOFF_MS` | `apps/nlp` | no | no | `100` | commented | — |
| `NLP_EXTERNAL_TEXT_TIMEOUT_S` | `apps/nlp` | no | no | `30` | commented | — |
| `NLP_GATEWAY_URL` | `apps/nlp` | no | no | `http://localhost:8868/api/v1` | commented | — |
| `NLP_HOST` | `apps/nlp` | no | no | `0.0.0.0` | commented | `HOST` |
| `NLP_INFERENCE_BATCH_LINGER_MS` | `apps/nlp` | no | no | `5` | commented | — |
| `NLP_INFERENCE_BATCH_MAX_SIZE` | `apps/nlp` | no | no | `8` | commented | — |
| `NLP_INFERENCE_DEVICE` | `apps/nlp` | no | no | `cpu` | commented | — |
| `NLP_INFERENCE_DEVICE_CPU_ONLY_MODULES` | `apps/nlp` | no | no | `count_embed.gru` | commented | — |
| `NLP_INFERENCE_INTERACTIVE_BATCH_LINGER_MS` | `apps/nlp` | no | no | `2` | commented | — |
| `NLP_INFERENCE_INTERACTIVE_BATCH_MAX_SIZE` | `apps/nlp` | no | no | `2` | commented | — |
| `NLP_INFERENCE_INTERACTIVE_QUEUE_MAX_DEPTH` | `apps/nlp` | no | no | `64` | commented | — |
| `NLP_INFERENCE_INTERACTIVE_QUEUE_MAX_WAIT_SECONDS` | `apps/nlp` | no | no | `2` | commented | — |
| `NLP_INFERENCE_MAX_CONCURRENT` | `apps/nlp` | no | no | `4` | commented | — |
| `NLP_INFERENCE_MAX_INFLIGHT_BATCHES` | `apps/nlp` | no | no | `2` | commented | — |
| `NLP_INFERENCE_QUEUE_MAX_DEPTH` | `apps/nlp` | no | no | `256` | commented | — |
| `NLP_INFERENCE_QUEUE_MAX_WAIT_SECONDS` | `apps/nlp` | no | no | `20` | commented | — |
| `NLP_LOG_LEVEL` | `apps/nlp` | no | no | `20` | commented | — |
| `NLP_METRICS_ENABLED` | `apps/nlp` | no | no | `true` | commented | `OTEL_METRICS_ENABLED` |
| `NLP_MODEL_CACHE_MAX_MODELS` | `apps/nlp` | no | no | `3` | commented | — |
| `NLP_MODEL_CACHE_TTL_SECONDS` | `apps/nlp` | no | no | `600` | commented | — |
| `NLP_OTEL_ENABLED` | `apps/nlp` | no | no | `false` | commented | — |
| `NLP_OTEL_RESOURCE_ATTRIBUTES` | `apps/nlp` | no | no | — | commented | `OTEL_RESOURCE_ATTRIBUTES`, `NLP_RESOURCE_ATTRIBUTES_RAW` |
| `NLP_OTLP_ENDPOINT` | `apps/nlp` | no | no | — | commented | `OTEL_EXPORTER_OTLP_ENDPOINT` |
| `NLP_PEER_CALL_MAX_CONCURRENT` | `apps/nlp` | no | no | `8` | commented | — |
| `NLP_PORT` | `apps/nlp` | no | no | `8864` | commented | `PORT` |
| `NLP_REDIS_URL` | `apps/nlp` | no | no | `redis://localhost:6379/0` | commented | — |
| `NLP_SERVICE_NAME` | `apps/nlp` | no | no | `nlp` | commented | `OTEL_SERVICE_NAME`, `SERVICE_NAME`, `NLP_NAME` |
| `NLP_SERVICE_VERSION` | `apps/nlp` | no | no | `0.1.0` | commented | `OTEL_SERVICE_VERSION`, `SERVICE_VERSION`, `NLP_VERSION` |
| `NLP_TRACES_ENABLED` | `apps/nlp` | no | no | `true` | commented | `OTEL_TRACES_ENABLED` |
| `NLP_URL` | `apps/guardrail` | no | no | `http://localhost:8864` | commented | `GUARDRAIL_V2_NLP_URL` |
| `NLP_WORKERS` | `apps/nlp` | no | no | `1` | commented | `WORKERS` |
| `NODE_ENV` | `apps/text` | no | no | `development` | commented | — |
| `ONNX_NUM_THREADS__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `0` | commented | — |
| `OPENAI_BASE_URL__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `https://api.openai.com/v1` | commented | — |
| `OTEL_ENABLED` | `apps/stt` | no | no | `false` | commented | — |
| `OTEL_EXPORTER_ENDPOINT` | `apps/stt` | no | no | `http://localhost:4317` | commented | — |
| `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` | `apps/text` | no | no | `` | live | `GENAI_CAPTURE_MESSAGE_CONTENT` |
| `PARAKEET_CPP_LIBRARY_PATH__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | — | commented | — |
| `PARAKEET_CPP_NUM_THREADS__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `4` | commented | — |
| `PUBSUB_CHANNEL_PREFIX__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `stt:transcription:` | commented | — |
| `PUBSUB_ENABLED__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `true` | commented | — |
| `PUNCTUATION_DEVICE__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `auto` | commented | — |
| `PUNCTUATION_ENABLED__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `false` | commented | — |
| `PUNCTUATION_MAX_LENGTH__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `300` | commented | — |
| `PUNCTUATION_MODEL_CACHE_DIR__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | — | commented | — |
| `PUNCTUATION_MODEL_NAME__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `Cadence` | commented | — |
| `REDIS_URL` | `apps/stt` | no | no | `redis://localhost:6379/0` | commented | — |
| `SARVAM_BASE_URL__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `https://api.sarvam.ai` | commented | — |
| `SECURITY_CORS_ALLOW_CREDENTIALS` | `apps/nlp` | no | no | `false` | commented | — |
| `SECURITY_CORS_METHODS` | `apps/nlp` | no | no | `["GET", "POST", "PUT", "DELETE", "OPTIONS"]` | commented | — |
| `SECURITY_CORS_ORIGINS` | `apps/nlp` | no | no | `["*"]` | commented | — |
| `SEGMENT_MERGE_GAP_THRESHOLD_S__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `2` | commented | — |
| `SEMANTIC_ENDPOINT_CONFIDENCE_THRESHOLD__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `0.85` | commented | — |
| `SEMANTIC_ENDPOINT_ENABLED__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `false` | commented | — |
| `SEMANTIC_ENDPOINT_MAX_SILENCE_MS__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `500` | commented | — |
| `SEMANTIC_ENDPOINT_MIN_SILENCE_MS__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `200` | commented | — |
| `SEMANTIC_ENDPOINT_MIN_WORDS__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `3` | commented | — |
| `SEMANTIC_ENDPOINT_MODEL_ID__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `` | commented | — |
| `SPELLING_CORRECTOR_DICTIONARY_PATH` | `apps/nlp` | no | no | `<repo>/apps/nlp/data/dictionaries` | commented | — |
| `SPELLING_CORRECTOR_SYMSPELL_IGNORE_NON_WORDS` | `apps/nlp` | no | no | `true` | commented | — |
| `SPELLING_CORRECTOR_SYMSPELL_IGNORE_TERM_WITH_DIGITS` | `apps/nlp` | no | no | `true` | commented | — |
| `SPELLING_CORRECTOR_SYMSPELL_MAX_EDIT_DISTANCE` | `apps/nlp` | no | no | `2` | commented | — |
| `SPELLING_CORRECTOR_SYMSPELL_PREFIX_LENGTH` | `apps/nlp` | no | no | `7` | commented | — |
| `SPELLING_CORRECTOR_SYMSPELL_PRESERVE_CASE` | `apps/nlp` | no | no | `true` | commented | — |
| `STORAGE_PROVIDER__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `minio` | commented | — |
| `STREAMING_AUDIO_IDLE_TIMEOUT_S__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `300` | commented | — |
| `STREAMING_AUDIO_STREAM_MAXLEN__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `10000` | commented | — |
| `STREAMING_AUDIO_TRIM_INTERVAL_S__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `30` | commented | — |
| `STREAMING_BATCH_WAIT_MS__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `0` | commented | — |
| `STREAMING_EMBEDDING_DEVICE__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `auto` | commented | — |
| `STREAMING_EXTRA_FILLER_PATTERNS__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `` | commented | — |
| `STREAMING_INFERENCE_DRAIN_TIMEOUT_S__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `60` | commented | — |
| `STREAMING_INFERENCE_QUEUE_MAXSIZE__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `64` | commented | — |
| `STREAMING_INFERENCE_STOP_TIMEOUT_S__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `30` | commented | — |
| `STREAMING_MAX_AUDIO_BUFFER_BYTES__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `500000000` | commented | — |
| `STREAMING_MAX_BATCH_SIZE__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `0` | commented | — |
| `STREAMING_MAX_CONCURRENT__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `0` | commented | — |
| `STREAMING_MULTI_GPU_STRATEGY__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `auto` | commented | — |
| `STREAMING_PARTIAL_INTERVAL_S__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `0.4` | commented | — |
| `STREAMING_PARTIAL_WINDOW_S__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `6` | commented | — |
| `STREAMING_PUNCTUATION_TIMEOUT_S__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `0.4` | commented | — |
| `STREAMING_REAPER_INTERVAL_S__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `300` | commented | — |
| `STREAMING_RESULT_STREAM_EXPIRE_S__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `3600` | commented | — |
| `STREAMING_RESULT_STREAM_MAXLEN__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `10000` | commented | — |
| `STREAMING_SESSION_METADATA_EXPIRE_S__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `86400` | commented | — |
| `STREAMING_SESSION_PERSIST_INTERVAL_S__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `5` | commented | — |
| `STREAMING_SESSION_TIMEOUT_S__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `60` | commented | — |
| `STREAMING_SNAPSHOT_INTERVAL_S__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `30` | commented | — |
| `STREAMING_TRANSCRIPT_OUTBOX_MAX_ATTEMPTS__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `10` | commented | — |
| `STREAMING_TRANSCRIPT_PERSIST_BACKOFF_S__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `0.5` | commented | — |
| `STREAMING_TRANSCRIPT_PERSIST_MAX_ATTEMPTS__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `3` | commented | — |
| `STREAMING_WORKER_HEARTBEAT_S__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `10` | commented | — |
| `STREAMING_WORKER_HEARTBEAT_TTL_S__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `30` | commented | — |
| `STT_DEBUG` | `apps/stt` | no | no | `false` | commented | `DEBUG` |
| `STT_HOST` | `apps/stt` | no | no | `0.0.0.0` | commented | `HOST` |
| `STT_LOG_LEVEL` | `apps/stt` | no | no | `INFO` | commented | `LOG_LEVEL` |
| `STT_MODEL_S3_ACCESS_KEY` | `apps/stt` | no | yes | `CHANGE_ME` | live | — |
| `STT_MODEL_S3_ENDPOINT` | `apps/stt` | no | no | — | commented | — |
| `STT_MODEL_S3_SECRET_KEY` | `apps/stt` | no | yes | `CHANGE_ME` | live | — |
| `STT_MODEL_S3_SECURE` | `apps/stt` | no | no | `true` | commented | — |
| `STT_OTEL_SERVICE_NAME` | `apps/stt` | no | no | `stt` | commented | `OTEL_SERVICE_NAME` |
| `STT_PORT` | `apps/stt` | no | no | `8861` | commented | `PORT` |
| `TEMPORAL_ADDRESS` | `apps/harness` | no | no | `localhost:7233` | commented | — |
| `TEMPORAL_CONNECT_TIMEOUT_S` | `apps/harness` | no | no | `5` | commented | — |
| `TEMPORAL_GRACEFUL_SHUTDOWN_TIMEOUT_S` | `apps/harness` | no | no | `30` | commented | — |
| `TEMPORAL_NAMESPACE` | `apps/harness` | no | no | `default` | commented | — |
| `TEMPORAL_TASK_QUEUE` | `apps/harness` | no | no | `harness-task-queue` | commented | — |
| `TEXT_CLASSIFIER_USE_GPU` | `apps/nlp` | no | no | `true` | commented | — |
| `TEXT_EXTERNAL_GUARDRAIL_BASE_URL` | `apps/text` | no | no | `http://localhost:8863` | commented | — |
| `TEXT_GATEWAY_URL` | `apps/text` | no | no | `http://localhost:8868/api/v1` | commented | — |
| `TEXT_LOG_LEVEL` | `apps/text` | no | no | `info` | commented | — |
| `TEXT_OTEL_EXPORTER_ENDPOINT` | `apps/text` | no | no | `` | commented | — |
| `TEXT_PORT` | `apps/text` | no | no | `8862` | commented | — |
| `TEXT_REDIS_URL` | `apps/text` | no | no | `redis://localhost:6379/0` | commented | — |
| `TEXT_URL` | `apps/guardrail` | no | no | `http://localhost:8862` | commented | `GUARDRAIL_V2_TEXT_URL` |
| `TEXT_URL` | `apps/nlp` | no | no | `http://localhost:8862` | commented | `NLP_EXTERNAL_TEXT_BASE_URL` |
| `TOKEN_CLASSIFIER_USE_GPU` | `apps/nlp` | no | no | `true` | commented | — |
| `TORCH_NUM_INTEROP_THREADS__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `1` | commented | — |
| `TORCH_NUM_THREADS__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `0` | commented | — |
| `TRANSCRIPTION_CHUNK_LENGTH_S__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `15` | commented | — |
| `TRANSCRIPTION_STRIDE_LENGTH_S__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `4,2` | commented | — |
| `TRANSCRIPTION_TIMEOUT_SECONDS__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `600` | commented | — |
| `TTS_AZURE_ENABLED` | `apps/tts` | no | no | `false` | commented | — |
| `TTS_AZURE_MAX_CONCURRENT__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/tts` | no | no | `10` | commented | — |
| `TTS_AZURE_REGION__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/tts` | no | no | `eastus` | commented | — |
| `TTS_AZURE_TIMEOUT_S__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/tts` | no | no | `30` | commented | — |
| `TTS_CORS_ENABLED` | `apps/tts` | no | no | `false` | commented | — |
| `TTS_CORS_ORIGINS` | `apps/tts` | no | no | `[]` | commented | — |
| `TTS_DEBUG` | `apps/tts` | no | no | `false` | commented | — |
| `TTS_DEFAULT_FORMAT__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/tts` | no | no | `pcm` | commented | — |
| `TTS_GATEWAY_URL` | `apps/tts` | no | no | `http://localhost:8868/api/v1` | commented | — |
| `TTS_HOST` | `apps/tts` | no | no | `0.0.0.0` | commented | — |
| `TTS_INDICF5_DEVICE__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/tts` | no | no | `cpu` | commented | — |
| `TTS_INDICF5_ENABLED` | `apps/tts` | no | no | `false` | commented | — |
| `TTS_INDICF5_HF_MODEL__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/tts` | no | no | `ai4bharat/IndicF5` | commented | — |
| `TTS_INDICF5_MODEL_PATH__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/tts` | no | no | `` | commented | — |
| `TTS_INDICF5_REF_AUDIO_PATH__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/tts` | no | no | `` | commented | — |
| `TTS_INDICF5_REF_TEXT__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/tts` | no | no | `` | commented | — |
| `TTS_KOKORO_DEVICE__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/tts` | no | no | `cpu` | commented | — |
| `TTS_KOKORO_ENABLED` | `apps/tts` | no | no | `false` | live | — |
| `TTS_LOG_LEVEL` | `apps/tts` | no | no | `info` | commented | — |
| `TTS_MAX_INPUT_CHARS__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/tts` | no | no | `4096` | commented | — |
| `TTS_METRICS_ENABLED` | `apps/tts` | no | no | `true` | commented | — |
| `TTS_MODEL_CACHE_TTL_SECONDS__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/tts` | no | no | `600` | commented | — |
| `TTS_OTEL_DEPLOYMENT_ENVIRONMENT` | `apps/tts` | no | no | `development` | commented | — |
| `TTS_OTEL_ENABLED` | `apps/tts` | no | no | `false` | commented | — |
| `TTS_OTEL_EXPORTER_ENDPOINT` | `apps/tts` | no | no | `` | commented | — |
| `TTS_OTEL_INSECURE` | `apps/tts` | no | no | `true` | commented | — |
| `TTS_OTEL_LOGS_ENABLED` | `apps/tts` | no | no | `true` | commented | — |
| `TTS_OTEL_SERVICE_NAME` | `apps/tts` | no | no | `tts` | commented | — |
| `TTS_OTEL_SERVICE_NAMESPACE` | `apps/tts` | no | no | `hope` | commented | — |
| `TTS_PARLER_DESC_ENCODER_PATH__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/tts` | no | no | `` | commented | — |
| `TTS_PARLER_DEVICE__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/tts` | no | no | `cpu` | commented | — |
| `TTS_PARLER_ENABLED` | `apps/tts` | no | no | `false` | commented | — |
| `TTS_PARLER_HF_MODEL__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/tts` | no | no | `ai4bharat/indic-parler-tts` | commented | — |
| `TTS_PARLER_MODEL_PATH__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/tts` | no | no | `` | commented | — |
| `TTS_PORT` | `apps/tts` | no | no | `8865` | commented | — |
| `TTS_REDIS_URL` | `apps/tts` | no | no | `redis://localhost:6379/0` | commented | — |
| `TTS_SAMPLE_RATE__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/tts` | no | no | `24000` | commented | — |
| `TTS_SARVAM_BASE_URL__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/tts` | no | no | `https://api.sarvam.ai` | commented | — |
| `TTS_SARVAM_ENABLED` | `apps/tts` | no | no | `false` | commented | — |
| `TTS_SARVAM_MAX_CONCURRENT__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/tts` | no | no | `4` | commented | — |
| `TTS_SARVAM_MODEL__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/tts` | no | no | `bulbul:v3` | commented | — |
| `TTS_SARVAM_SAMPLE_RATE__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/tts` | no | no | `24000` | commented | — |
| `TTS_SARVAM_TIMEOUT_S__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/tts` | no | no | `30` | commented | — |
| `TTS_SARVAM_USE_STREAMING__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/tts` | no | no | `false` | commented | — |
| `TTS_WARMUP_ENABLED__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/tts` | no | no | `false` | commented | — |
| `VAD_MIN_SILENCE_DURATION_MS__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `500` | commented | — |
| `VAD_MIN_SPEECH_DURATION_MS__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `100` | commented | — |
| `VAD_MODEL_PATH__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | — | commented | — |
| `VAD_SPEECH_PAD_MS__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `200` | commented | — |
| `VAD_THRESHOLD__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `0.5` | commented | — |
| `VOICE_PROFILE_MIN_SIMILARITY__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `0.6` | commented | — |
| `WHISPER_CPP_CONSULTATION_PROMPT_ENABLED__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `false` | commented | — |
| `WHISPER_CPP_MAX_AUDIO_SECONDS__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `7` | commented | — |
| `WHISPER_CPP_NUM_THREADS__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `8` | commented | — |
| `WORKER_MAX_RETRIES__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `3` | commented | — |
| `WORKER_POLL_TIMEOUT_MS__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `1000` | commented | — |
| `WORKER_THREADS__MOVED_TO_CONTROL_PLANE_TASK_799` | `apps/stt` | no | no | `4` | commented | — |

## Python reads OUTSIDE pydantic-settings

Direct `os.environ` / `os.getenv` reads, including those through a one-line
helper. They are declared in `turbo.json#globalEnv` but belong to no settings
class, so no service validates them at startup — each one is a candidate for
promotion into its service’s `BaseSettings`.

| Variable | Read by |
|---|---|
| `DEPLOYMENT_ENVIRONMENT` | `apps/guardrail/src/guardrail/main.py`, `apps/harness/src/harness/core/config.py`, `apps/stt/src/stt/core/service_auth.py`, `apps/stt/src/stt/core/telemetry.py`, `apps/stt/src/stt/main.py`, `apps/stt/src/stt/worker.py`, `apps/tts/src/tts/core/config.py`, `apps/tts/src/tts/core/service_auth.py` |
| `HARNESS_GOLDEN_SET_PATH` | `apps/harness/eval/promptfoo/tests.py` |
| `HARNESS_LLM_BACKOFF_BASE_S` | `apps/harness/src/harness/core/llm_concurrency.py` |
| `HARNESS_LLM_BACKOFF_JITTER_S` | `apps/harness/src/harness/core/llm_concurrency.py` |
| `HARNESS_LLM_BACKOFF_MAX_S` | `apps/harness/src/harness/core/llm_concurrency.py` |
| `HARNESS_LLM_MAX_ATTEMPTS` | `apps/harness/src/harness/core/llm_concurrency.py` |
| `HARNESS_LLM_MAX_CONCURRENCY` | `apps/harness/src/harness/core/llm_concurrency.py` |
| `HARNESS_LLM_REQUEST_TIMEOUT_S` | `apps/harness/src/harness/core/llm_concurrency.py` |
| `HARNESS_PROMPTFOO_API_KEY` | `apps/harness/eval/promptfoo/provider.py` |
| `HARNESS_PROMPTFOO_BASE_URL` | `apps/harness/eval/promptfoo/provider.py` |
| `HARNESS_PROMPTFOO_MODEL` | `apps/harness/eval/promptfoo/provider.py` |
| `HARNESS_VERDICT_CACHE_HMAC_KEY` | `apps/harness/src/harness/sensors/inferential/verdict_cache.py` |
| `HF_HUB_OFFLINE` | `apps/harness/src/harness/models/source_resolver.py`, `apps/stt/src/stt/models/source_resolver.py` |
| `HOPE_SECRETS_DIR` | `packages/py-env/src/hope_env/settings_sources.py` |
| `HOSTNAME` | `packages/py-env/src/hope_env/service_registration.py` |
| `LOG_FILE_PATH` | `apps/nlp/src/nlp/core/logging.py` |
| `NLP_MODEL_LOCAL_ROOTS` | `apps/nlp/src/nlp/core/guard_model_reference.py` |
| `OMP_NUM_THREADS` | `apps/stt/src/stt/main.py` |
| `OPENAI_API_KEY` | `apps/harness/eval/promptfoo/provider.py` |
| `OPENAI_BASE_URL` | `apps/harness/eval/promptfoo/provider.py` |
| `QDRANT_API_KEY` | `infrastructure/docker/scripts/init-qdrant-collections.py` |
| `QDRANT_HOST` | `infrastructure/docker/scripts/init-qdrant-collections.py` |
| `QDRANT_KNOWLEDGE_COLLECTION` | `infrastructure/docker/scripts/init-qdrant-collections.py` |
| `QDRANT_KNOWLEDGE_DIM` | `infrastructure/docker/scripts/init-qdrant-collections.py` |
| `QDRANT_PORT` | `infrastructure/docker/scripts/init-qdrant-collections.py` |
| `STT_BENCH_CORPUS` | `apps/stt/scripts/benchmark_pipelines.py` |
| `STT_BENCH_PIPELINES` | `apps/stt/scripts/benchmark_pipelines.py` |
| `STT_BENCH_REFERENCE_DIR` | `apps/stt/scripts/benchmark_pipelines.py` |
| `WHISPER_CPP_MAX_AUDIO_SECONDS` | `apps/stt/scripts/mlen_scorecard.py` |
| `WHISPER_MLEN_GGUF` | `apps/stt/scripts/mlen_scorecard.py` |
