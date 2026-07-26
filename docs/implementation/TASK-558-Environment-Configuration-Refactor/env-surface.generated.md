<!-- GENERATED FILE — DO NOT EDIT BY HAND. Produced by `pnpm env:sync`. -->

# TASK-558 — The declared environment surface

Generated from the settings registry plus each TypeScript deployable’s own
schema. `pnpm env:sync --check` (CI job `env-drift-check`) fails when this file,
the `.env.example` files or `turbo.json#globalEnv` disagree with those
declarations.

## Summary

| Metric | Value |
|---|---:|
| Declared keys (distinct) | 134 |
| … of which required (`failMode: closed`) | 34 |
| … of which secret | 33 |
| … tier `env` | 105 |
| … tier `vault-kv` | 29 |
| `turbo.json#globalEnv` entries | 146 |

## Variables

| Variable | Tier | Required | Default | Read by | Purpose |
|---|---|---|---|---|---|
| `ADMIN_CONSOLE_URL` | `env` | no | `http://localhost:5176` | `apps/api` | Origin of the Next.js admin console; used by the gateway e2e harness and CORS guidance. |
| `ADMIN_PORT` | `env` | no | `5176` | `apps/admin-console` | Port the dev (5176) or test (5276) console binds — read by `scripts/dev-stack.sh` and `scripts/start-test-app.sh`, not by application code. |
| `ADMIN_SESSION_SECRET` | `env` | yes | `<CHANGE_ME>` | `apps/admin-console` | Secret the encrypted session cookie (jose JWE, dir + A256GCM) is keyed from; the 32-byte AES key is derived via SHA-256 in `src/server/session.ts`. Minimum 32 characters — the console refuses to start without it. |
| `API_GATEWAY_KEY` | `vault-kv` | yes | `<CHANGE_ME>` | `apps/api` | The credential STT presents to the gateway. STT is the one service that authenticates with `X-Internal-Service-Key` rather than `X-Service-Token`, reusing this key instead of minting a second STT credential (`InternalServiceTokenGuard.SERVICE_SECRETS.stt`). There is no `STT_SERVICE_TOKEN`. |
| `API_INSPECT_HOSTPORT` | `env` | no | `127.0.0.1:9229` | `apps/api` | Inspector endpoint for `nest start --debug`, so a test gateway can be debugged alongside a dev one (test: 127.0.0.1:9329). |
| `API_KEY_ALLOW_QUERY_PARAM` | `env` | no | `false` | `apps/api` | When true, an API key may be presented as a query parameter (compared strictly against `"true"`, so anything else is false). Query strings land in access logs and referrers — keep OFF unless a specific integration forces it. |
| `API_KEY_MAX_LIFETIME_DAYS` | `env` | no | — | `apps/api` | Ceiling on a requested API-key expiry. UNSET MEANS UNLIMITED — `apikey.service.ts` parses it to `null` and skips the clamp. A security ceiling with an unbounded default is precisely the kind of policy an admin should be able to set live. |
| `API_KEY_PEPPER` | `vault-kv` | yes | `<CHANGE_ME>` | `apps/api` | Server-side pepper mixed into every API-key hash. CHANGING IT INVALIDATES EVERY ISSUED API KEY AT THE INSTANT IT CHANGES — a stored hash computed under pepper vN can never be verified under vN+1. ROTATION IS THEREFORE STAGED, NEVER SWAPPED, and is keyVersion-aware in exactly the way `GlobalSetting` already models secret material (`encryptedValue` + `keyVersion`): (1) write the NEW pepper as a new Vault kv-v2 version — kv-v2 keeps prior versions, so vN stays readable; (2) verification reads the keyVersion recorded on the ApiKey row and verifies under THAT pepper, so vN and vN+1 keys are both valid during the overlap; (3) newly issued and re-hashed keys are stamped with the new keyVersion; (4) once no row still references vN — or the announced overlap window closes — retire vN. Skipping the overlap is an outage for every integration at once. Vault kv-v2 versioning is the mechanism; the keyVersion column is what makes it staged rather than a coin flip. STATUS (lane J): step (2)’s READ PATH now exists — `SecretFetchOptions.version` addresses a specific kv-v2 version through `SecretsService.getSecret(key, { version })`, cached per (key, version) and evicted together by `invalidate(key)`. What is still MISSING is the per-row half: `ApiKey` has no pepper-version column, so nothing records which pepper produced a stored hash, and `ApiKeyService.verify` has nothing to pass. Until that column, its migration, its domain trio and the issue/verify stamping land, a pepper change remains a cliff — the read path alone does not make the rotation staged. |
| `API_PORT` | `env` | no | `8868` | `apps/api` | Port the dev/test supervisor expects the gateway on; the gateway itself binds `PORT`. |
| `API_URL` | `env` | no | `http://localhost:8868` | `apps/admin-console` | Origin the BFF proxy (`src/app/api/hope/[...path]/route.ts`) forwards to. Server-side only — never reaches the client bundle. |
| `APP_SETTINGS_BOOT_INVARIANT` | `env` | no | — | `apps/api` | Set to `skip` (development only) to bypass the AppSettings boot invariant (`appSettings.service.ts`). |
| `AZURE_FOUNDRY_API_KEY` | `vault-kv` | yes | `<CHANGE_ME>` | `apps/api` | Azure AI Foundry credential used by the STT Foundry model loader. |
| `AZURE_SPEECH_KEY` | `vault-kv` | yes | `<CHANGE_ME>` | `apps/api` | Azure Cognitive Services Speech credential. Shared by STT (`azure_speech_loader`) and TTS, which accepts it as the fallback alias for `TTS_AZURE_API_KEY`. |
| `AZURE_STORAGE_ACCOUNT_KEY` | `vault-kv` | yes | `<CHANGE_ME>` | `apps/api` | Azure Storage shared account key — the alternative to `AZURE_STORAGE_CONNECTION_STRING` when the endpoint is composed from `accountName` + `endpointSuffix` on the storage config row. |
| `AZURE_STORAGE_CONNECTION_STRING` | `vault-kv` | yes | `<CHANGE_ME>` | `apps/api` | Full Azure Storage connection string (carries the account key) for the AZURE storage provider. Read by `BlobStorageProviderFactory.buildAzureProvider` AFTER the SYSTEM row’s `credentialsRef`, i.e. it is the env/kv fallback of the same two-step order as `S3_ACCESS_KEY`. Preferred over `AZURE_STORAGE_ACCOUNT_KEY`. |
| `CORS_ALLOWED_ORIGINS` | `env` | no | — | `apps/api` | Comma-separated allowed origins. Also a pre-bootstrap read in `main.ts` + `cors.config.ts`. A security-relevant list an operator should be able to tighten without a redeploy — the clearest §9.2 L1 case in this file. |
| `DATABASE_URL` | `env` | yes | — | `apps/api` | Primary PostgreSQL connection string (PgBouncer transaction mode in production). Cannot come from the database or from Vault — this IS the credential that reaches them. No fallback exists: absence is a hard boot error. |
| `DEBUG` | `env` | no | `false` | `apps/api` | Enables verbose config/service debug logging. |
| `DIRECT_URL` | `env` | no | — | `apps/api` | Migrations-only, un-pooled PostgreSQL endpoint (`packages/database/src/migration-url.ts`). Falls back to `DATABASE_URL` when unset, which is correct in dev but wrong behind a transaction-mode pooler — production must set it explicitly. |
| `ENABLE_PRISMA_STUDIO` | `env` | no | `false` | `apps/api` | Development-only: mounts the Prisma Studio module (`app.module.ts`). |
| `ENTITLEMENTS_ENABLED_DEFAULT` | `env` | no | `false` | `apps/api` | SEED-TIME ONLY, and the only key in this file that is not a runtime gate: `seed/15-entitlements.ts` reads it to decide the value of the `entitlements.enabled` GlobalSetting row on a FRESH database. The live control plane is `entitlements.enabled` (already cataloged, tier `global-kv`, kill-switch). Its migration is therefore NOT to redis-flag but DELETION, once seeding takes its default from the descriptor instead of the environment. |
| `ENV_FILE_PATH` | `env` | no | — | `apps/api` | Overrides the NODE_ENV→file map used by `loadEnv()`. Unset in every normal deployment. |
| `GUARDRAIL_PORT` | `env` | no | `8863` | `apps/guardrail` | Port apps/guardrail binds (test: 8963). |
| `GUARDRAIL_SERVICE_TOKEN` | `vault-kv` | yes | `<CHANGE_ME>` | `apps/api` | Shared secret on the gateway↔guardrail hop (`X-Service-Token`). |
| `GUARDRAIL_URL` | `env` | no | `http://localhost:8863` | `apps/api` | Safety-engine base URL (apps/guardrail, port 8863). |
| `GUARDRAIL_V2_GROUNDEDNESS_ENABLED` | `env` | no | `false` | `apps/guardrail` | Gates the guardrail NLI groundedness gate (`GUARDRAIL_V2_GROUNDEDNESS_` prefix). OFF is the dev/hermetic-CI bypass: the gate answers honestly with `unverified` and never loads a model. Fail posture is FAIL-CLOSED throughout — a disabled gate, an un-staged model and a scoring error all degrade to `unverified`, and no path yields `grounded` without the model actually entailing the segment. Turning it ON requires the self-hosted MiniCheck-class model staged on the host (no cloud PHI). |
| `GUARDRAIL_VLLM_API_KEY` | `vault-kv` | yes | `<CHANGE_ME>` | `apps/guardrail` | Bearer credential for guardrail's vLLM OpenAI-compatible endpoint (`GUARDRAIL_VLLM_` prefix). Self-hosted endpoints commonly accept a placeholder, but it is still a credential and is classified as one. |
| `HARNESS_ATOMIC_FACT_ENABLED` | `env` | no | `false` | `apps/harness` | Gates the `run_inferential_sensors` atomic-fact path. Same policy-overrides-env shape as the NER-priors flag. |
| `HARNESS_CLAIM_CHECK_ACCESS_KEY` | `vault-kv` | yes | `<CHANGE_ME>` | `apps/harness` | S3/MinIO access key for the harness claim-check blob store. The offloaded payloads are clinical content, so the store is SELF-HOSTED by contract — this credential must never address a cloud bucket. |
| `HARNESS_CLAIM_CHECK_ENABLED` | `env` | no | `true` | `apps/harness` | Moves large clinical blobs OUT of Temporal workflow history into a self-hosted content-addressed store, protecting the ~50 MB history budget. DEFAULTS **ON**, and is therefore NOT marked `killSwitch` — it is a PROTECTION, so turning it off REMOVES a safeguard (unbounded history growth) rather than disabling an enforcement path. Marking it a kill-switch would violate the defaults-OFF invariant and fail registry assembly. Same polarity as `rate-limit.enabled`. Turning it off is a deliberate acceptance of unbounded Temporal history, exactly as the harness startup validator states. |
| `HARNESS_CLAIM_CHECK_SECRET_KEY` | `vault-kv` | yes | `<CHANGE_ME>` | `apps/harness` | S3/MinIO secret key for the harness claim-check blob store (self-hosted only; PHI must not egress). |
| `HARNESS_INTERNAL_SERVICE_TOKEN` | `vault-kv` | yes | `<CHANGE_ME>` | `apps/api` | SECOND, SEPARATE harness credential — NOT an alias of `HARNESS_SERVICE_TOKEN`. It gates the knowledge-ingest endpoint only (`apps/harness/.../api/endpoints/knowledge.py`, pydantic field `internal_service_token` under the `HARNESS_` prefix) and is resolved by `KnowledgeIngestClient` for the outbound `X-Service-Token`. Added by lane J: it was read through SecretsService but had no descriptor, so `vault-seed-secrets.sh` never seeded it and every ingest call would 401 on a Vault-backed deployment. |
| `HARNESS_JUDGE_OPENAI_COMPAT_API_KEY` | `vault-kv` | yes | `<CHANGE_ME>` | `apps/harness` | Bearer credential for the harness LLM-as-judge OpenAI-compatible endpoint (`HARNESS_JUDGE_OPENAI_COMPAT_` prefix). Connection config only — WHICH judge model runs is `models.harness.judge`, a fail-closed db-config selection. |
| `HARNESS_NER_PRIORS_ENABLED` | `env` | no | `false` | `apps/harness` | Gates reuse of already-persisted CODED NER priors inside harness activities. A workflow-policy value may override it per run; this is the fallback when the policy says nothing. |
| `HARNESS_PORT` | `env` | no | `8866` | `apps/harness` | Port apps/harness binds (test: 8966). |
| `HARNESS_SERVICE_TOKEN` | `vault-kv` | yes | `<CHANGE_ME>` | `apps/api` | Shared secret on the gateway↔harness hop. Fetched on demand (not a warmup key) by `HarnessOpsClient` / `HarnessGatewayService` / `HarnessServiceTokenGuard`. It MUST equal the harness process’s own `HARNESS_SERVICE_TOKEN`, or every `/api/v1/internal/harness/*` call 401s. |
| `HARNESS_URL` | `env` | no | `http://localhost:8866` | `apps/api` | Clinical Documentation Harness base URL (apps/harness, port 8866). |
| `HARNESS_WARM_START_ENABLED` | `env` | no | `false` | `apps/harness` | Env FALLBACK for harness warm-start; `HarnessInternalService` treats the DB/policy value as the authority and consults this only when that is absent. Being a fallback for a policy value is itself an argument for moving it out of env. |
| `JWT_SECRET_KEY` | `vault-kv` | yes | `<CHANGE_ME>` | `apps/api` | HS256 signing secret for gateway-issued access tokens. Warmed at boot; `apps/api/src/main.ts` refuses to start when it is still a placeholder. Rotating it invalidates every outstanding access token immediately (they are short-lived, so the blast radius is one token TTL). |
| `LIVE_DOC_GROUNDEDNESS_ENABLED` | `env` | no | `false` | `apps/api` | Gates the output-side groundedness check on the live-documentation path. Read once in the `LiveDocumentationService` constructor as `=== "true"`, so a change needs a restart — the clearest instant-fan-out candidate in this file. |
| `LOG_FILE_DATE_PATTERN` | `env` | no | `yyyy-MM-dd` | `apps/api` | Date pattern in rotated log file names. |
| `LOG_FILE_ENABLED` | `env` | no | `false` | `apps/api` | Writes rotating log files in addition to stdout. |
| `LOG_FILE_MAX_FILES` | `env` | no | `1000` | `apps/api` | Number of rotated log files kept. |
| `LOG_FILE_MAX_SIZE` | `env` | no | `10m` | `apps/api` | Rotate after this much data (winston-daily-rotate-file syntax). |
| `LOG_FILE_PATH` | `env` | no | `./logs` | `apps/api` | Directory rotating log files are written to. |
| `LOG_FILE_SEPARATE_ERROR` | `env` | no | `false` | `apps/api` | Writes errors to their own file in addition to the combined log. |
| `LOG_LEVEL` | `env` | no | `info` | `apps/api` | Gateway log level. Read PRE-BOOTSTRAP in `apps/api/src/main.ts` (before the Nest module graph, therefore before `loadEnv()` has read `.env.dev`), so today it sees HOST env only — plan §2.2 secondary defect, fixed by lane B/D. Migration also has to move that read behind the validated schema (plan §4 B5). |
| `METRICS_COLLECT_INTERVAL` | `env` | no | `15000` | `apps/api` | Interval of the simplified monitoring collector. |
| `METRICS_PREFIX` | `env` | no | — | `apps/api` | Prefix for Prometheus metric names; defaults to the sanitized service name. |
| `MINIO_ACCESS_KEY` | `vault-kv` | yes | `<CHANGE_ME>` | `apps/api` | MinIO/S3 access key for platform object storage. NOTE: the per-tenant / platform-default STORAGE CONFIG (endpoint, region, path style, prefix) is a separate concern owned by `TenantStorageConfig`; only the credential lives here, referenced by `credentialsRef`. |
| `MINIO_ENDPOINT` | `env` | no | — | `apps/api` | Deploy-time fallback used ONLY before the SYSTEM storage row exists (first boot / pre-seed). Scheduled for removal one release after the SYSTEM row ships; a WARN is logged whenever it is the tier that supplied the value. |
| `MINIO_REGION` | `env` | no | `us-east-1` | `apps/api` | Region passed to the S3-compatible client. |
| `MINIO_SECRET_KEY` | `vault-kv` | yes | `<CHANGE_ME>` | `apps/api` | MinIO/S3 secret key for platform object storage. |
| `MINIO_USE_SSL` | `env` | no | `false` | `apps/api` | Whether the object-storage endpoint is reached over TLS. |
| `MQTT_HOST` | `env` | no | `localhost` | `apps/api` | MQTT broker host. |
| `MQTT_PASS` | `vault-kv` | yes | `<CHANGE_ME>` | `apps/api` | MQTT broker password, consumed by `MqttService` via `ConfigService`. |
| `MQTT_PORT` | `env` | no | `1883` | `apps/api` | MQTT broker port. |
| `MQTT_USER` | `env` | no | — | `apps/api` | MQTT broker username. The password is a `vault-kv` secret (`MQTT_PASS`). |
| `NEST_DEBUG` | `env` | no | `false` | `apps/api` | Enables NestJS-internal debug logging. |
| `NEXT_PUBLIC_API_HOST` | `env` | no | `http://localhost:8868` | `apps/admin-console` | Origin the BROWSER connects to directly for SSE/WS streams (authenticated with single-use stream tickets). Inlined into the client bundle by Next.js, so it must be non-secret (`src/config/public-env.ts`). |
| `NLP_PORT` | `env` | no | `8864` | `apps/nlp` | Port apps/nlp binds. |
| `NLP_SERVICE_TOKEN` | `vault-kv` | yes | `<CHANGE_ME>` | `apps/api` | Shared secret on the gateway↔NLP hop (`X-Service-Token`). |
| `NLP_URL` | `env` | no | `http://localhost:8864` | `apps/api` | Medical-NLP base URL (apps/nlp, port 8864). |
| `NODE_ENV` | `env` | no | `development` | `apps/api` | Selects the env file `loadEnv()` reads (`.env.dev` / `.env.test` / `.env.production`); CI and production load NO file and use host env only. |
| `OIDC_CLIENT_SECRET` | `vault-kv` | yes | `<CHANGE_ME>` | `apps/api` | Client secret for the platform OIDC relying-party registration. Absent ⇒ OIDC authentication is disabled (a logged WARN, not a crash) — see `auth.service.module.ts`. |
| `OTEL_DEBUG` | `env` | no | `false` | `apps/api` | Enables the OpenTelemetry diagnostic logger. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `env` | no | — | `apps/api` | gRPC OTLP collector endpoint. Unset disables the exporters. |
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
| `RATE_LIMIT_ENABLED` | `env` | no | `true` | `apps/api` | Module-bootstrap switch read by `RateLimitConfigService` as `!== "false"`, so anything other than the literal string `false` leaves throttling ON. The LIVE control plane is the already-cataloged `rate-limit.enabled` global-kv key; this env var only decides whether the throttler is wired at boot. |
| `RATE_LIMIT_MAX_REQUESTS` | `env` | no | `100` | `apps/api` | Requests per window for the `default` throttler tier at module bootstrap. Superseded at request time by the `rate-limit.tier.default.limit` global-kv key below. |
| `RATE_LIMIT_WINDOW_MS` | `env` | no | `60000` | `apps/api` | Window length for the `default` throttler tier at module bootstrap. Superseded at request time by the `rate-limit.tier.default.ttl` global-kv key below. |
| `REDIS_HOST` | `env` | no | `localhost` | `apps/api` | Redis host, used when `REDIS_URL` is unset. |
| `REDIS_PASS` | `vault-kv` | yes | `<CHANGE_ME>` | `apps/api` | Redis AUTH password. Resolved through SecretsService and layered over the env value by `ConfigService.applySecretOverrides`. |
| `REDIS_PORT` | `env` | no | `6379` | `apps/api` | Redis port, used when `REDIS_URL` is unset. |
| `REDIS_URL` | `env` | no | — | `apps/api` | Full Redis connection URL; when set it wins over the host/port pair. |
| `REFRESH_TOKEN_TTL_SECONDS` | `env` | no | `604800` | `apps/api` | Refresh-token lifetime. Read ONCE in the `RefreshTokenService` constructor, so a change needs a restart today; a non-finite or non-positive value silently falls back to the 7-day default. |
| `REGISTRATION_SELF_SIGNUP_ENABLED` | `env` | no | `false` | `apps/api` | Gates the public self-signup routes: `RegisterController` returns 404 (not 403) when off, so the endpoint's existence is not disclosed. Read via `ConfigService.getConfigValue`, which parses it as `=== "true"` — anything else is off. The admin-console proxy allowlist mirrors this gate. |
| `S3_ACCESS_KEY` | `vault-kv` | yes | `<CHANGE_ME>` | `apps/api` | S3-protocol access key read by `S3Service`. In local dev this aliases the MinIO credential (HOPE speaks S3 to MinIO); in a deployed environment it may name a distinct S3 principal. |
| `S3_SECRET_KEY` | `vault-kv` | yes | `<CHANGE_ME>` | `apps/api` | S3-protocol secret key read by `S3Service`. |
| `SECRETS_LRU_MAX` | `env` | no | `200` | `apps/api` | Maximum entries in the SecretsService LRU cache. |
| `SECRETS_PROVIDER` | `env` | no | `env` | `apps/api` | Selects the secrets backend (`env` \| `vault` \| …). It decides where every `vault-kv` descriptor is actually read from, so it necessarily precedes all of them. |
| `SECRETS_TTL_SEC` | `env` | no | `300` | `apps/api` | Per-entry TTL of the SecretsService LRU cache. |
| `SEMANTIC_ENDPOINT_ENABLED` | `env` | no | `false` | `apps/api` | Gates content-driven semantic end-of-utterance detection on the STT streaming hot path. NOTE the naming exception: the STT `Settings` class carries NO `env_prefix`, so this is the BARE `SEMANTIC_ENDPOINT_ENABLED`, not `STT_SEMANTIC_ENDPOINT_ENABLED` — one of the plan §3.3 rule-1 violations (prefix must equal the service prefix) that a later rename has to fix. Default OFF until measured against the accuracy/latency scorecard. |
| `SERVICE_NAME` | `env` | no | `hope-api` | `apps/api` | Logical service name stamped on logs and metrics. |
| `SESSION_SECRET_KEY` | `vault-kv` | yes | `<CHANGE_ME>` | `apps/api` | Signing/encryption secret for server-side session material. Rotating it invalidates existing sessions; users re-authenticate. |
| `SHUTDOWN_DRAIN_DELAY_MS` | `env` | no | `5000` | `apps/api` | Delay between failing readiness and closing the server, so a load balancer stops routing before connections drop. |
| `SHUTDOWN_TIMEOUT_MS` | `env` | no | `30000` | `apps/api` | Upper bound on graceful shutdown before the process is forced down (`GracefulShutdownService`). |
| `SMR_AZURE_API_KEY` | `vault-kv` | yes | `<CHANGE_ME>` | `apps/smr` | SMR's Azure OpenAI credential (`SMR_AZURE_` pydantic prefix, typed `SecretStr`). |
| `SMR_EXTERNAL_GUARDRAIL_ENABLED` | `env` | no | `false` | `apps/smr` | Gates input moderation on SMR `/generate` (`SMR_EXTERNAL_GUARDRAIL_` prefix). OFF is the dev/CI bypass so local runs need no guardrail service. When ON the posture is fail-CLOSED by construction: a transient error is absorbed by a bounded retry, a sustained outage rejects, and an errored guardrail NEVER allows — there is deliberately no `fail_open` option. |
| `SMR_PORT` | `env` | no | `8862` | `apps/smr` | Port apps/smr binds; the gateway keeps it only to build health-probe URLs. |
| `SMR_SERVICE_TOKEN` | `vault-kv` | yes | `<CHANGE_ME>` | `apps/api` | Shared secret on the gateway↔SMR hop. SMR reads it as `settings.service_token` under its `SMR_` pydantic prefix; the gateway resolves the same name for outbound proxying and for `InternalServiceTokenGuard`'s inbound check. |
| `SMR_URL` | `env` | no | `http://localhost:8862` | `apps/api` | Summarization service base URL (apps/smr, port 8862). |
| `STORAGE_ACCESS_KEY_PEPPER` | `vault-kv` | yes | `<CHANGE_ME>` | `apps/api` | HMAC pepper for hashing tenant STORAGE access-key secrets (`StorageAccessKeyService.hashSecretForStorage`). Falls back to the shared `API_KEY_PEPPER` when unset, then to un-peppered SHA-256 — so it inherits `API_KEY_PEPPER`’s rotation cliff: changing it invalidates every stored storage access key. Stage a rotation the same way (see `api.keyPepper`). |
| `STORAGE_PLATFORM_DEFAULT_CREDENTIALS` | `vault-kv` | yes | `<CHANGE_ME>` | `apps/api` | Operator-set JSON `{ accessKeyId, secretAccessKey }` at the Vault path recorded in the SYSTEM row's `credentialsRef` (default `platform/storage/minio`). Never stored in the database and never returned by any API. |
| `STT_PORT` | `env` | no | `8861` | `apps/stt` | Port apps/stt binds (test: 8961). |
| `STT_URL` | `env` | no | `http://localhost:8861` | `apps/api` | Speech-to-text service base URL (apps/stt, port 8861). |
| `STT_WS_EGRESS_HIGH_WATERMARK_BYTES` | `env` | no | `524288` | `apps/stt` | Buffered-amount threshold above which partial transcripts are dropped. |
| `STT_WS_RESUME_GRACE_MS` | `env` | no | `15000` | `apps/stt` | Window a disconnected STT session is held open for reconnect. |
| `TTS_PORT` | `env` | no | `8865` | `apps/tts` | Port apps/tts binds. |
| `TTS_SARVAM_API_KEY` | `vault-kv` | yes | `<CHANGE_ME>` | `apps/tts` | PLATFORM-level Sarvam credential (`TTS_SARVAM_` prefix). A TENANT-supplied Sarvam key is a different data class entirely — `tts.credential.sarvam`, tier `db-secret` — and must never be stored here. |
| `TTS_SERVICE_TOKEN` | `vault-kv` | yes | `<CHANGE_ME>` | `apps/api` | Shared secret on the gateway↔TTS hop (`X-Service-Token`). |
| `TTS_URL` | `env` | no | `http://localhost:8865` | `apps/api` | Text-to-speech base URL (apps/tts, port 8865). |
| `TTS_WS_EGRESS_HIGH_WATERMARK_BYTES` | `env` | no | `524288` | `apps/tts` | Buffered-amount threshold above which TTS audio frames are dropped. |
| `URL` | `env` | no | `http://localhost` | `apps/api` | Public base URL the gateway advertises for itself. |
| `VAULT_ADDR` | `env` | no | `http://localhost:8200` | `apps/api` | Vault API address. Required when `SECRETS_PROVIDER=vault`. |
| `VAULT_AUDIT_LOG_PATH` | `env` | no | — | `apps/api` | File the rotation worker tails for Vault audit events. Unset disables the worker. |
| `VAULT_DB_ADMIN_PASS` | `env` | yes | `<CHANGE_ME>` | `apps/api` | Password for the `vault_admin` PostgreSQL role that VAULT ITSELF uses to mint short-lived DB credentials. CLASSIFIED `env`, NOT `vault-kv`, DELIBERATELY: it is consumed at Vault PROVISIONING time by `infrastructure/docker/configs/vault/dev-init.sh`, `scripts/setup-dev-vault-db.sh` and docker-compose — before any Vault kv-v2 read is possible. Storing it in Vault would be circular. It is a real credential and belongs on the §6 rotation list; the bootstrap floor is where it has to live. |
| `VAULT_DEV_ROOT_TOKEN` | `env` | no | — | `apps/api` | Root token of the LOCAL dev Vault; used by seeds. Never set in a deployed environment. |
| `VAULT_KV_MOUNT` | `env` | no | `secret` | `apps/api` | Mount path of the kv-v2 engine. Final secret path: `<mount>/data/<prefix>/<NAME>`. |
| `VAULT_KV_PREFIX` | `env` | no | `hope` | `apps/api` | Prefix beneath the kv-v2 mount under which every platform secret is stored. |
| `VAULT_NAMESPACE` | `env` | no | — | `apps/api` | Vault Enterprise namespace. Unset on OSS Vault. |
| `VAULT_REQUEST_TIMEOUT_MS` | `env` | no | `5000` | `apps/api` | Per-request timeout of the Vault HTTP client. |
| `VAULT_ROLE_ID` | `env` | no | — | `apps/api` | AppRole role_id. Non-secret by Vault design (it is the public half of the AppRole pair) and useless without a secret_id, so it is classified `internal`, not `secret`. |
| `VAULT_SECRET_ID` | `env` | yes | `<CHANGE_ME>` | `apps/api` | RAW, reusable AppRole secret_id — the DEV path (`scripts/refresh-vault-creds.sh`; `secret_id_num_uses=0`, `secret_id_ttl=720h`), because a response-wrapped token is single-use and dies on the first watch-mode restart. This is genuine credential material, but it CANNOT live in Vault: it is what authenticates TO Vault. |
| `VAULT_TOKEN` | `env` | no | — | `apps/api` | Direct Vault token. Operator/CLI path only — services authenticate with AppRole. |
| `VAULT_TRANSIT_KEY` | `env` | no | `hope-globalsetting` | `apps/api` | Transit key that wraps `GlobalSetting.encryptedValue`. |
| `VAULT_TRANSIT_KEY_PHI` | `env` | no | `hope-phi` | `apps/api` | Transit key that wraps PHI columns. |
| `VAULT_TRANSIT_MOUNT` | `env` | no | `transit` | `apps/api` | Mount path of the Transit engine used for envelope encryption. |
| `VAULT_WRAPPED_SECRET_ID` | `env` | yes | `<CHANGE_ME>` | `apps/api` | PRODUCTION path: a single-use response-wrapping token unwrapped once per process start. Blank in dev so the raw path is taken. Same bootstrap exemption as `VAULT_SECRET_ID`. |
