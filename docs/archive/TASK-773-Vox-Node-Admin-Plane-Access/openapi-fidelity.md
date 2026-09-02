# TASK-773 Phase B — OpenAPI Fidelity Spike

Status: **Complete** (B1 + B2). Recommendation: **GO**.

Produced by `apps/api/scripts/emit-openapi.ts` (root script `pnpm api:openapi`), which builds the
Swagger document via `SwaggerModule.createDocument()` offline (no listener, no live DB/Redis/Vault)
and writes `apps/api/openapi.json`. See §B1 for how it was verified to match the live route surface.

## B1 — offline emission

- **Command**: `pnpm api:openapi` (root) → `pnpm api:build && pnpm --filter @arcaai/api openapi`.
- **What it does**: `NestFactory.create(AppModule, { logger: false, abortOnError: false })`,
  `app.setGlobalPrefix(API_GLOBAL_PREFIX, API_GLOBAL_PREFIX_OPTIONS)` (imported from the new
  `apps/api/src/global-prefix.config.ts`, which `main.ts` now also imports — one source, so the
  emitted document cannot drift from the prefix/exclude list the live gateway applies),
  `SwaggerModule.createDocument(app, buildSwaggerConfig().build())` (the existing
  `swagger.config.ts` — unchanged), write pretty JSON with deep-sorted keys to
  `apps/api/openapi.json`, bounded `app.close()`, `process.exit(0)`.
- **Fidelity requirement honored**: it runs against the compiled `nest build` output
  (`dist/scripts/emit-openapi.js`), not `ts-node`/`tsx`. `nest-cli.json` registers the
  `@nestjs/swagger` compiler plugin (`introspectComments`, implicit `@ApiProperty`/response-type
  inference); that plugin only runs through Nest's own compiler, so anything run via `ts-node`
  would under-report type coverage relative to what `/api/v1/docs` actually serves.
- **No live infra required.** Verified empirically: the script was run with `DATABASE_URL`,
  `DIRECT_URL`, `REDIS_HOST`/`REDIS_PORT` all pointed at unreachable addresses (`127.0.0.1:1` /
  a closed port) and still produced a byte-correct, complete `openapi.json` and exited 0. What was
  needed and why:
  - `JWT_SECRET_KEY` must be a non-empty, non-placeholder string — `JwtStrategy`'s constructor
    (a DI-time check, not a lifecycle hook) throws otherwise. A dev-only placeholder string
    satisfies it; nothing reads it as a real secret in this codepath.
  - `DATABASE_URL`/`DIRECT_URL` must be *present and well-formed* — `CoreDatabaseService`
    constructs a `PrismaClient` at DI time but Prisma does not connect eagerly.
  - `REDIS_HOST`/`REDIS_PORT` must be present — `BullModule.forRootAsync`'s factory
    (`RedisServiceModule.register`) throws synchronously during `NestFactory.create()` if unset
    (it only checks presence). Reachability is never required; ioredis dials in the background.
  - `NestFactory.create()`'s **default** `abortOnError: true` calls `process.exit(1)` internally
    on any bootstrap error, silently (its logger was disabled) and bypassing any `try`/`catch`.
    Passing `abortOnError: false` was required to get an actual diagnosable error out of the
    script during development — documented in the script since it is easy to reintroduce and
    turns every future failure back into a silent, unexplained exit code 1.
  - One harmless side effect: `AppSettingsService`'s constructor fires an unawaited cache
    warm-up query ("Initialize cache immediately but don't wait for it"). It always loses the
    race against `writeFileSync` and surfaces afterwards as stderr noise (a Prisma connection
    error) with no effect on the emitted file or the exit code. Not fixed — it is pre-existing
    application behavior, out of scope for a measurement script.
  - `NODE_ENV=production` is used for the script invocation specifically so no `.env.*` file is
    read at all (host env only, per the repo's env-loading contract) — fully deterministic,
    independent of what a given machine happens to have in `.env.dev`.
- **`.gitignore`**: `apps/api/openapi.json` was **not** added — it should be committed. Two
  reasons, one direct and one by repo convention: (1) this ticket's own plan (§5, Phase D1)
  already settles it — *"Generator runs offline against the checked-in `openapi.json`"* — Phase
  D's `vox-node-codegen` package needs a stable, checked-in input to diff against without booting
  the whole gateway in its own CI job. (2) Convention check on generated-artifact handling in this
  repo shows it is NOT one-size-fits-all: `packages/database/src/generated/` (the raw Prisma
  client — pure mechanical output of `prisma generate`, TRUE generation, never hand-touched) IS
  gitignored (`packages/database/.gitignore`), but `packages/domains/src/entities/generated/core/*`
  (despite the same folder name) IS committed, because per `03-domain-layer.md` those files are
  reconciled/checked, not regenerated from scratch — "the committed files on disk are the source
  of truth." `openapi.json` sits in the same position as the domains files for THIS repo's actual
  intent: a checked-in artifact a drift gate diffs against (mirroring `generate-*-check`), not a
  disposable local build byproduct. Decision: **commit it**, regenerate via `pnpm api:openapi`
  whenever routes/DTOs change.
- **Route-count verification**: the document contains **451 paths** / **579 operations** total.
  Cross-checked against a live walk of `AppModule`'s actual mounted Express route table
  (`app.getHttpAdapter().getInstance()._router.stack`, honoring the same `api/v1` prefix +
  exclude list): the gateway registers **647** distinct (method, path) route pairs. The gap
  (647 − 579 = 68) is fully accounted for: **0** operations in `openapi.json` are absent from the
  live route table (no drift — the document is a strict subset), and all 68 extra live routes
  carry `@ApiExcludeEndpoint()`/`@ApiExcludeController()` by design — 308-ish TASK-760 v1→v2
  redirect shims collapsed into far fewer distinct routes plus internal service-to-service
  controllers (`stt-internal`, `harness-internal`, `consent-internal`, `effective-config`,
  `service-release-internal`, `text-proxy`, `pstudio`) that are deliberately not part of the
  public-facing API surface. Confirms the emitted document matches what the live gateway serves,
  modulo the routes it is intentionally told to hide from Swagger.

## B2 — fidelity spike over `/api/v1/admin/**`

Scope: every operation whose path starts with `/api/v1/admin/`.

| # | Metric | Count | % |
|---|---|---:|---:|
| 1 | **Total admin operations** | **401** | — |
| 2 | Typed request body (all 401 ops as denominator) | **132** | 32.9% |
| 2b | — of which, POST/PUT/PATCH (body-bearing) ops only: 159 ops, typed | **128** | **80.5%** |
| 3 | Typed 2xx response schema | **342** | **85.3%** |
| 4 | Neither typed request nor typed response (strict, any op) | **44** | 11.0% |

**Definition of "typed"** (applied uniformly to both request and response schemas): a `$ref` to a
named component schema, or an inline `object` with non-empty `properties`, or a typed
`array`/`allOf`/`oneOf`/`anyOf` composition thereof, or a `string` `enum` (a closed value set is
real shape). **Not typed**: no schema at all, `{}`, a bare `{"type":"object"}` with no properties
and no meaningful `additionalProperties`, or a bare primitive (`{"type":"string"}` etc. with no
enum) — the "we know a request/response exists but not its shape" case this spike exists to catch.

Row 2's 401-denominator number (32.9%) is not the meaningful figure on its own — GET and DELETE
routes structurally carry no request body (242 of the 401 ops), so they can never be "typed"
on that axis. The useful number is **2b: 80.5% of the 159 POST/PUT/PATCH admin operations have a
real typed request schema.**

### Breakdown of the untyped cases

| Untyped request reason | Count |
|---|---:|
| No request body declared at all (`no-request-body`) | 268 (242 are GET/DELETE by design; **31 are POST/PUT/PATCH missing a typed body**) |
| Declared but only a bare array-of-string | 1 |

| Untyped response reason | Count |
|---|---:|
| No 2xx response body/content declared (`no-2xx-body`) | 50 |
| Response declared but only a bare inline object (no properties) | 8 |
| Response declared as an array of bare inline objects | 1 |

Of the 159 body-bearing ops: **31** lack a typed request and **17** lack a typed response.
Of the 242 GET/DELETE ops: **42** lack a typed response (the only axis that applies to them).

### 10 worst offenders

Ranked: (1) a body-bearing op (POST/PUT/PATCH) missing **both** a typed request and a typed
response — the true worst case; (2) any op with an untyped response — the one defect every
operation can have, since every operation returns *something*; (3) a body-bearing op missing only
its request shape. "Missing request" alone is **not** automatically a defect — many
parameterless action routes (`:id/revoke`, `:id/rotate`) legitimately take no body; spot-checked
`ApiKeyController.revoke(@Param('id') id: string)` against source to confirm this is real, not a
Swagger-annotation gap.

| # | Verb | Path | Missing |
|---|---|---|---|
| 1 | POST | `/api/v1/admin/entitlements/trial-expiry/run` | request (no body declared), response (bare inline object, no properties) |
| 2 | POST | `/api/v1/admin/service-accounts/{id}/rotate` | request (no body declared), response (no 2xx content) |
| 3 | POST | `/api/v1/admin/tenants/storage/buckets/provision/{tenantId}` | request (no body declared), response (no 2xx content) |
| 4 | POST | `/api/v1/admin/tenants/{id}/pipelines/resync` | request (no body declared), response (no 2xx content) |
| 5 | POST | `/api/v1/admin/usage/reconciliation/run` | request (no body declared), response (no 2xx content) |
| 6 | DELETE | `/api/v1/admin/ai-providers/{provider}` | response (no 2xx content) |
| 7 | GET | `/api/v1/admin/ai-runtime-profiles/resolve` | response (no 2xx content — union return type, only a text description) |
| 8 | DELETE | `/api/v1/admin/ai-runtime-profiles/row` | response (no 2xx content) |
| 9 | GET | `/api/v1/admin/ai-services/guardrail/config` | response (no 2xx content) |
| 10 | GET | `/api/v1/admin/ai-services/guardrail/status` | response (no 2xx content) |

(Rows 1–5 are genuine "we don't know what this returns" gaps, not the harmless
no-request-body-by-design pattern — they pair a missing request with a missing response, so
there is nothing for a generator to type on either side.)

## Recommendation: GO

**Threshold used**: generate typed methods from OpenAPI (GO) when (a) ≥ 70% of body-bearing
(POST/PUT/PATCH) admin operations carry a typed request schema, **and** (b) ≥ 70% of all admin
operations carry a typed 2xx response schema. Below 70% on either axis, NO-GO — fall back to
Nest-metadata-only route shape with `unknown` payload types and hand-type the highest-value areas
per §3.1's fallback plan.

**Why 70%**: below that bar, the generator would be emitting `unknown` (or worse, a wrong guess)
for close to a third or more of the surface, which is no longer "generate with a documented
minority of gaps" — it is "generate a skeleton and hand-type most of it," at which point the
Nest-metadata-only fallback is simpler and more honest about what it delivers.

**Measured**: 80.5% typed request (body-bearing ops), 85.3% typed response (all ops). Both clear
the bar comfortably.

**Consequence for Phase D**: generate `hope.admin.<area>` methods from the OpenAPI schemas as
planned (§3.1/§3.2). The uncovered minority — 31 body-bearing ops with an untyped request, 59
ops (17 body-bearing + 42 GET/DELETE) with an untyped response — should generate with an
`unknown` payload type at that specific call site rather than blocking the whole generator, per
§3.1's stated fallback granularity ("hand-type the highest-value areas" — apply that per-operation,
not per-generator-run). The 5 rows in the worst-offenders table missing *both* dimensions (all
action-trigger endpoints: trial-expiry run, service-account rotate, bucket provision, pipeline
resync, usage reconciliation run) are reasonable Phase-D hand-typing candidates given their
operational significance.

## Change History

| Date | Change |
|---|---|
| 2026-08-19 | Phase B1 implemented (`apps/api/src/scripts/emit-openapi.ts`, `apps/api/src/global-prefix.config.ts` extracted from and now imported by `main.ts`, root `api:openapi` script). Phase B2 spike run over the emitted `apps/api/openapi.json`. Recommendation recorded: **GO**, threshold 70%/70%, measured 80.5%/85.3%. |
