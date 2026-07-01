# TASK-386 — Platform Runtime Metrics Backend

| Field | Value |
|---|---|
| **Ticket** | TASK-386 |
| **Name** | Platform Runtime Metrics Backend (= §3a item **#16 / T1** = TASK‑371 backlog **#14**) |
| **Type** | `feature` (backend, cross-service) |
| **Status** | **Completed** (TS half — DB→Domain→Applications→API→SDK→FE; verified) |
| **Created** | 2026‑07‑01 |
| **Updated** | 2026‑07‑01 |
| **Owner** | Backend / Platform |
| **Source review** | `docs/admin-console-open-items-review.md` §3a (read-only reference) |
| **Unblocks** | TASK‑380 (Tenant Dashboard), TASK‑383 (Platform Dashboard + Monitoring), TASK‑379 (Tenant Detail overview roll-ups) |

> **Ticket-number check:** `docs/implementation/` highest existing ticket is **TASK‑385** (`TASK-385-Admin-Docs-Alignment`); no `TASK-386` existed, so **TASK‑386** is the next free number (confirmed by directory listing on 2026‑07‑01).

> ✅ **Implemented (2026‑07‑01).** The plan below was approved and built layer-by-layer (DB → Domain → Applications → API → SDK → Frontend) with TDD. §5 records the resolved decisions; §6 is the Implementation Summary; §7 the Change History. The eight approved decisions in §5 superseded the open questions.

---

## 1. Requirement Analysis

### 1.1 Description

A large share of the Admin Console's "platform" surfaces are drawn as **TARGET** (disabled / em-dash) because **no backend exists to feed them**. The frontend view-models already exist and explicitly mark these numbers as TARGET — e.g. P95 is "drawn by the page" and per-model running/avg-latency render as em-dashes:

```19:27:apps/admin/src/features/platform-dashboard/models.ts
/** Real deployed models, in the frame-11 display order. */
export const PLATFORM_MODELS: readonly PlatformModel[] = [
    { id: 'whisper-large-v3-turbo', name: 'whisper-large-v3-turbo', service: 'STT' },
    { id: 'silero-vad-v5', name: 'silero-vad-v5', service: 'STT' },
    { id: 'gemma-4-e4b', name: 'gemma-4-e4b', service: 'SMR' },
    { id: 'granite-guardian-4.1-8b', name: 'granite-guardian-4.1-8b', service: 'Guardrail' },
    { id: 'Medical-NER', name: 'Medical-NER', service: 'NLP' },
    { id: 'symps-disease-bert', name: 'symps-disease-bert', service: 'NLP' },
] as const;
```

This ticket builds the **backend read APIs** that turn those TARGET tiles into real data. It is the umbrella for §3a items **#16, #17, #18, #19, #20, #21** and the storage/usage halves of **#4, #5**.

### 1.2 Business context

- **TASK‑383 T1** (Platform Dashboard + Monitoring) names this exact gap as a blocking follow-up: "platform runtime metrics backend missing (the gap behind every TARGET tile)… **= TASK‑371 backlog #14**".
- **TASK‑380** degrades the tenant-admin dashboard to em-dash/Unknown because `GET /monitoring/sessions` + `GET /health/services` are `manage all`-gated (#21), and its consultation chart **under-counts long ranges** because there is no server-side aggregation (#20).
- The review's own triage (`docs/admin-console-open-items-review.md` §5.3) concludes: *"The platform-metrics backend (#16, T1) is the highest-leverage single item."*

### 1.3 Acceptance criteria (feature-level, for the eventual build)

1. A super-admin can read **platform runtime metrics** (requests/min, error rate, per-service P95, open sockets, running models + per-model avg latency, request-volume series) from a documented REST surface.
2. **Open-sockets** count (#17) is real (sourced from the live socket registry), not a zeros stub.
3. A **consumption / usage roll-up** (#18) returns transcription-minutes, summaries-24h, storage-used, and consultation counts — platform-wide (super-admin) and per-tenant.
4. A **consultation range-aggregation** endpoint (#20) returns server-side date-bucketed new/revisit counts that do **not** under-count long ranges.
5. **Tenant-scoped telemetry** (#21): a tenant-admin can read their own tenant's sessions/health/telemetry without `manage all`.
6. `GET /admin/tenants/:id/usage` (#4) is extended with storage-used + clinical counts; **storage quota/usage** (#5) is exposed.
7. Every new endpoint is CASL-gated, tenant-isolated, DTO-typed (`@ApiProperty`), and covered by unit + Playwright E2E tests (RED-first).

---

## 2. Current State Evaluation

### 2.1 What already exists (so this is lower-risk than it looks)

| Capability | Where it lives today | Status for #16 |
|---|---|---|
| API `/metrics` Prometheus endpoint (prom-client) | `packages/applications/src/services/baseServices/observability/observability.module.ts:15` | **EXISTS** |
| HTTP request counter + latency histogram (`http_requests_total`, `http_request_duration_seconds`) fed by a global interceptor | `apps/api/src/interceptors/metrics.interceptor.ts:30`; `packages/applications/src/services/baseServices/observability/simplified-monitoring.service.ts:332` | **EXISTS** (raw signal → P95 / req-rate / error-rate derivable) |
| Live WebSocket session registry + count getter | `apps/api/src/modules/streaming/stt-ws.gateway.ts:524` (`getActiveSessionCount()`) | **EXISTS in-process** (not yet exposed) |
| BullMQ queue stats (counts, workers, paused) | `packages/applications/src/services/queue-admin/queue-admin.service.ts:11` | **EXISTS** |
| Service uptime / heartbeats (Redis, 30s cron) | `packages/applications/src/services/baseServices/serviceHealth/serviceHealthMonitoring.service.ts:113,228` | **EXISTS** |
| Per-service `/metrics` + `/health` on all 5 Python services; SMR domain metrics wired; STT `/internal/sessions` + `/internal/cache/stats` | `apps/{stt-v2,smr,nlp,guardrail,harness}` (`main.py`, `stt_v2/health/api/routes.py:396`, `smr_v2/core/metrics.py`) | **EXISTS** |
| Prisma models for aggregation (Consultation, AudioRecording.duration, SummaryMeta.generatedAt, Media.size) with tenant-leading indexes | `packages/database/src/prisma/db_main/{consultation,media}.prisma` | **EXISTS** (queries are BUILD) |
| Tenant usage roll-up (`getUsageStats`) + endpoint | `packages/applications/src/services/tenant/tenant.service.ts:898`; `apps/api/src/modules/tenant/tenant.controller.ts:151` | **EXISTS** (needs extension for storage/clinical) |
| Tenant-scoped admin read precedent (`?tenantId=` override; tenant-admin pinned to CLS) | `apps/api/src/modules/dna-writing-style/dna-writing-style-admin.controller.ts:50` | **EXISTS** (template for #21) |

### 2.2 What is missing / stubbed (the BUILD list)

| Gap | Evidence |
|---|---|
| `GET /monitoring/sessions` returns hard-coded zeros | `serviceHealthMonitoring.service.ts:270` (`getSessionCounts()` → all `{ active: 0 }`) |
| System gauges `active_connections_count` / queue-length return 0 | `simplified-monitoring.service.ts:178` (`getQueueLength()`/`getActiveConnections()` → `return 0`) |
| STT domain metrics (`stt_v2_transcription_*`, `stt_v2_streaming_sessions_active`) defined but **never incremented** | `apps/stt-v2/src/stt_v2/core/metrics.py` (imported nowhere) |
| No Prometheus/Grafana in dev compose (prod-only config under TASK‑251) | `infrastructure/docker/docker-compose.yml` (only postgres/redis/minio); `infrastructure/docker/docker-compose.dev.yml` (no `prometheus`/`grafana`) |
| No REST endpoint returns pre-computed P95 / req-rate / error-rate / time-series | (no controller; FE draws these as TARGET — `task-383-platform-dashboard.spec.ts:26-29` explicitly excludes them) |
| No server-side consultation aggregation; FE buckets a single page client-side | `apps/admin/src/features/tenant-dashboard/chart.ts:9-12` ("LIMITATION… buckets the most-recent page client-side") |
| No storage **quota** column anywhere | `packages/database/src/prisma/db_main/tenant-bucket.prisma` (no quota field); `TenantStorageConfig` has none |
| Monitoring + health admin reads are super-admin-only (`manage all`) | `apps/api/src/modules/monitoring/monitoring.controller.ts:14`; `apps/api/src/modules/health/health.controller.ts:182` |
| SDK monitoring types drift from backend DTOs | `packages/agentic-sdk-v2/src/types/monitoring.ts:15` (`SessionCounts` shape ≠ `SessionsResponse`) |

### 2.3 Conventions this plan will follow

- **DDD layer chain**: Database (Prisma) → Domain (`packages/domains`) → Application service + DTO (`packages/applications`) → API controller (`apps/api`). Read-only aggregation may read `this.databaseService.client` directly inside the application service — this is the **house precedent** (`tenant.service.ts:898` `getUsageStats` uses `this.databaseService.client.userRoleAssignment.findMany(...)`).
- **Generators**: `pnpm gen:service` / `pnpm gen:controller` scaffold the new module folders (templates in `packages/tools/src/generate-service-module/` and `generate-controller/`).
- **Auth**: CASL via `@CanManage('X')` / `@CanAny([...])` decorators (`packages/applications/src/authorization/decorators.ts:195,210`), enforced by the global `UnifiedAuthGuard` reading metadata; policies seeded in `packages/database/src/prisma/db_main/seed/01-policy.ts` (GLOBAL `system-full-access` = `manage:all`; TENANT `tenant-full-access` = `manage:<subject>` conditioned on `${context.tenantId}`).
- **DTOs**: `@ApiProperty()` response classes (plain DTOs like `apps/api/src/modules/tenant/dto/tenant-usage.response.ts` for non-entity aggregates; `@Expose()` + `BaseResponse` for entity rows).
- **SysEvent**: read-only metrics endpoints typically broadcast nothing; if we record a `ResourceViewed` audit it uses `this.broadcastSysEvent(...)` from `BaseService` (`packages/applications/src/common/base.service.ts:43`).
- **Tenant scoping**: super-admin (`isSuperAdmin(user)`) bypasses; tenant-admin pinned to `this.cls.get('user').tenantId` / `this.tenantId`; cross-tenant `?tenantId=` override allowed for super-admin only (mirrors `dna-writing-style-admin.controller.ts:59` + per-row guard `tenant.controller.ts:63` `assertTenantInScope`).

---

## 3. §3a Backend Backlog Prioritisation (all 25 items)

**Legend** — Effort: **S** ≤1d, **M** 2–4d, **L** ≥1wk. Seq: dependency-ordered build sequence (1 = first). "Cluster" = TASK‑386 (this ticket).

### Group A — Platform-metrics cluster (TASK‑386 — do first)

| Seq | # | Item | Leverage (TARGET surfaces unblocked) | Effort | Depends on |
|---|---|---|---|---|---|
| 1 | **16** | **Platform runtime metrics backend** (umbrella) | 383 P1/P3/M1 + every platform TARGET tile; 380 TD2/TD5 | **L** | sources mostly exist (§2.1) |
| 1 | **17** | Open-sockets count endpoint | 380 sockets tile; 383 total-sockets / sockets-min | **S** | `SttWsGateway.getActiveSessionCount()` (exists) |
| 1 | **21** | Tenant-scoped sessions/health read | 380 TD1/TD5 tenant-admin telemetry (currently em-dash) | **M** | new CASL subject `TenantTelemetry` |
| 2 | **20** | Consultation range aggregation / date-bucketing | 380 consultation chart (TD2, under-count); 379 overview | **M** | Postgres groupBy (models exist) |
| 2 | **4** | Tenant usage roll-ups `GET /admin/tenants/:id/usage` | 379 Overview KPIs / "Pipelines" tile | **S** (extend `getUsageStats`) | #5 for storage figure |
| 2 | **5** | Storage quota/usage on `TenantBucket` | 379 Storage tile (used/quota, objects/size); 380 consumption | **M** | **schema decision (quota column?)** |
| 3 | **18** | Consumption / quota roll-up endpoint | 380 consumption tile | **M** | #5, #20 |
| 3 | **19** | Per-model audio-stream metrics | 380 per-model audio counts; 383 per-model running + avg-latency | **L** | Python `/internal` + `/providers` fan-out; #16 |

**Why #16/T1 is sequenced first (the case):**

1. **Widest leverage.** It is the single backend item cited by the most tickets (371, 380, 383) and the only one behind *every* platform TARGET tile across two whole dashboards. The review names it the highest-leverage single item (§5.3).
2. **Data sources already exist** (§2.1) — Prometheus client + request histograms, a live socket registry, BullMQ stats, and tenant-indexed Prisma models. The principal BUILD is the **read-API layer**, not new telemetry plumbing, so the effort/leverage ratio is unusually favourable.
3. **It is a prerequisite** for the rest of the cluster: #17/#19 are facets of #16's response; #18 composes #5+#20; #21 is the auth-scoping variant of the same read. Building #16 first lets #17–#21 land as thin extensions rather than parallel one-offs.
4. **It converts the most "🟡 authored / 🎯 TARGET" debt into shippable signal** — TASK‑380/383 FE view-models are already written against these shapes (`platform-dashboard/service-table.ts`, `tenant-dashboard/service-health.ts`), so wiring is fast once the endpoints exist.

### Group B — Tenant data-model (TASK‑379-heavy) — do after the metrics cluster

| Seq | # | Item | Leverage | Effort | Depends on |
|---|---|---|---|---|---|
| 4 | 1 | Tenant lifecycle `SUSPENDED`/`ARCHIVED` (F6) | 379 lifecycle actions; 371 | S | schema (enum) |
| 4 | 2 | Tenant `tags` field + endpoint (F9) | 379 tags; 371 | S | schema |
| 4 | 3 | Tenant `plan` field | 371 plan badge | S | schema + product decision |
| 5 | 6 | Dept→users reverse listing `GET /admin/departments/:id/users` (D2) | 379 department members (scale) | S | — |
| 5 | 7 | Per-dept DNA writing-style default slot (`dnaWritingStylePromptId`) (D3/U10/AG13) | 379/381/382 default-agent slot | M | schema |

### Group C — Users (TASK‑381-heavy)

| Seq | # | Item | Leverage | Effort | Depends on |
|---|---|---|---|---|---|
| 6 | 8 | Reset-password endpoint (link + admin temp pw) (U5) | 381 reset-password | M | email infra (exists) |
| 6 | 9 | Server-side bulk user actions (U6) | 381 bulk bar | M | — |
| 7 | 10 | User export Excel/PDF (U7) | 381 export | M | export lib |
| 7 | 11 | Admin-edit another user's prefs — **UI wiring only** (backend exists) (U8) | 381 preferences-for-another | S | — |
| 8 | 12 | Per-user prompt scope (`USER_PERSONAL`/`ownerUserId`) (U9) | 381 per-user agents | M | schema |
| 8 | 13 | DNA reports/versions cross-user generate (U10/U12) | 381 DNA panels for others | M | PHI policy decision |

### Group D — Agents (TASK‑382)

| Seq | # | Item | Leverage | Effort | Depends on |
|---|---|---|---|---|---|
| 9 | 14 | Prompt `compareVersions` **server diff** endpoint (A3/AG8) | 382 version diff (today client-side) | M | — |
| 9 | 15 | Test sub-metrics on SDK `PromptTestResult` (map `PromptTestMetrics`) (A5/AG12) | 382 playground eval score | S | — |

### Group E — Super-admin tier (TASK‑371 surfaces, mostly unbuilt FE too)

| Seq | # | Item | Leverage | Effort | Depends on |
|---|---|---|---|---|---|
| 10 | 22 | CASL policy-rules editing `policies.controller.ts` (R3) | 371 Roles & Policies builder | M | — |
| 10 | 23 | API-key rotate endpoint (K5) | 371 API Keys | S | — |
| 11 | 24 | Global-settings CRUD `admin/global-settings` (ST1) | 371 Settings | M | — |
| 11 | 25 | Audit-trail Excel/PDF export (AU2) | 371 Audit export | S | export lib (shared w/ #10) |

> **Cross-cutting note:** #3/#1/#2/#7/#12 require Prisma schema additions → each carries a migration gate. #10 and #25 share an Excel/PDF export utility — build once. #11 is **frontend-only** (backend GET/PATCH already exist per the review), so it is the cheapest win in Group C.

---

## 4. Detailed #16 / T1 Implementation Plan

### 4.1 Per-metric source-of-truth decision

| Metric (FE tile) | Recommended source | Status | Notes / risk |
|---|---|---|---|
| **Open sockets** (#17), total sockets | In-process `SttWsGateway.getActiveSessionCount()` (`stt-ws.gateway.ts:524`) + wire into `active_connections_count` gauge | EXISTS | Single-instance accurate. Multi-instance needs Redis aggregation (open Q4). |
| **Requests/min**, **error rate**, **per-service P95** | **MVP:** read the in-process prom-client registry (`http_requests_total`, `http_request_duration_seconds`) and compute (rate = counter delta vs a stored snapshot; P95 ≈ histogram-bucket interpolation). **Prod:** swap a `PrometheusQueryService` behind the same interface. | Raw signal EXISTS; readout = BUILD | Counters are cumulative since process start → store previous snapshot (in-memory/Redis) for the per-minute delta. Histogram P95 is an approximation. **Open Q1.** |
| **Sockets/min**, **request-volume time-series** | Time-series store: **MVP** Redis ring-buffer of periodic snapshots, OR Prometheus `rate()` range query (prod) | BUILD | True time-series wants Prometheus; MVP can serve a short Redis-backed window. **Open Q1.** |
| **Running models count**, **per-model avg latency** (#19) | Fan-out (cached, short TTL): STT `/internal/sessions` + `/internal/cache/stats` (`stt_v2/health/api/routes.py:396,251`), SMR `/providers` + `smr_v2_*` `/metrics`; static inventory = FE `PLATFORM_MODELS` | Python endpoints EXIST; aggregation = BUILD | Per-request fan-out is slow/coupled → cache. Alternative: wire dead `stt_v2/core/metrics.py` + scrape. **Open Q5.** |
| **Transcription-minutes** | Postgres `SUM(AudioRecording.duration)/60000` grouped by tenant over `createdAt` (`consultation.prisma` `AudioRecording`, `duration Int? // ms`) | BUILD (fields exist) | `duration` is nullable → `COALESCE`. |
| **Summaries-24h** | Postgres `COUNT(SummaryMeta WHERE generatedAt >= now-24h)` (`SummaryMeta.generatedAt`, indexed) | BUILD | Index `@@index([generatedAt])` exists. |
| **Storage used** (#5) | Postgres `SUM(Media.size)` grouped by `tenantId`/`bucketId` (`media.prisma`) | BUILD | DB-side accounting field; true bytes live in MinIO (acceptable). |
| **Storage quota** (#5) | **No column today** — decide: add `TenantBucket.quotaBytes BigInt?` vs source from `GlobalSetting`/`TenantStorageConfig` | DATA MISSING | Schema change ⇒ migration gate. **Open Q2.** |
| **Consultation range aggregation** (#20) | Postgres `GROUP BY date_trunc(granularity, createdAt)` with new/revisit split via `parentConsultationId IS NULL`, zero-filled | BUILD | Mirror FE `chart.ts` bucket keys (`yyyy-MM-dd` / `yyyy-MM`). |
| **Consumption / quota roll-up** (#18) | Composition of storage-used + transcription-min + summaries-24h + consultation counts vs quota | BUILD | Depends on #5, #20. |
| **Active tenants / total users** (383 P1/P2) | Already real: `GET /admin/tenants`, `GET /admin/users` | EXISTS | No change (already green in `task-383-*.spec.ts`). |
| **Service health / uptime** (383 M1) | Already real: `GET /health/services`, `GET /monitoring/uptime` | EXISTS | #21 widens *who* can read (tenant-scope), not the source. |

### 4.2 New / changed endpoints (method · path · DTO)

All under the global `/api/v1` prefix. Super-admin = `@CanManage('PlatformMetrics')` (or reuse `@Authorize(['manage','all'])` like the existing monitoring controller); tenant-scoped = `@CanAny(['manage','all'], ['read','TenantTelemetry'])`.

**E1 — Platform runtime metrics (super-admin)**
`GET /admin/platform/metrics`
```ts
class PlatformMetricsResponse {
  requestsPerMinute: number;       // from http_requests_total delta
  errorRatePct: number;            // 5xx / total over window
  p95LatencyMs: number;            // overall, histogram_quantile(0.95)
  openSockets: number;             // SttWsGateway count (#17)
  socketsPerMinute: number;        // delta (#16/#17)
  services: Array<{ key: string; p95LatencyMs: number | null; requestsPerMinute: number | null; errorRatePct: number | null }>;
  models: { running: number; perModel: Array<{ id: string; service: string; running: number | null; avgLatencyMs: number | null }> }; // (#19)
  requestVolumeSeries: Array<{ t: string; requests: number; sockets: number }>; // time-series
  refreshedAt: string;
}
```

**E2 — Open sockets (super-admin)** — thin tile source for #17
`GET /admin/platform/sockets` → `{ open: number; perMinute: number; total: number; refreshedAt: string }`
*(May be folded into E1; kept separate so the 380/383 "sockets" tile can poll cheaply.)*

**E3 — Consumption / usage roll-up (#18)** — super-admin platform-wide, `?tenantId=` to scope
`GET /admin/platform/consumption`
```ts
class ConsumptionRollupResponse {
  transcriptionMinutes: number;
  summaries24h: number;
  storageUsedBytes: number;
  storageQuotaBytes: number | null;   // null until #5 quota source decided
  consultations: { total: number; today: number };
  refreshedAt: string;
}
```

**E4 — Consultation range aggregation (#20)** — tenant-scoped read
`GET /admin/consultations/aggregate?from=&to=&granularity=day|month&tenantId=`
```ts
class ConsultationAggregateResponse {
  buckets: Array<{ key: string; label: string; start: string; end: string; newVisits: number; revisits: number; total: number }>;
  totals: { total: number; newVisits: number; revisits: number };
  granularity: 'day' | 'month';
  refreshedAt: string;
}
```
*Placement:* extend `apps/api/src/modules/consultation/admin-consultation.controller.ts` (already `@CanManage('Consultation')`, tenant-isolated by `tenantScopeFilter`).

**E5 — Extend tenant usage (#4 + #5)**
`GET /admin/tenants/:id/usage` — extend existing `TenantUsageResponse` (`apps/api/src/modules/tenant/dto/tenant-usage.response.ts`):
```ts
class TenantUsageResponse {
  totalUsers: number; totalDepartments: number; totalPromptTemplates: number; totalPipelines: number; // EXISTING
  storageUsedBytes: number;        // NEW (#5)
  storageQuotaBytes: number | null;// NEW (#5)
  transcriptionMinutes: number;    // NEW (#16)
  summaries24h: number;            // NEW (#16)
  totalConsultations: number;      // NEW (#16)
}
```

**E6 — Tenant-scoped telemetry (#21)** — tenant-admin sees own telemetry
- **Recommended:** new `GET /admin/telemetry/sessions` + `GET /admin/telemetry/health` (tenant-scoped, `@CanAny(['manage','all'], ['read','TenantTelemetry'])`), service pins non-super to CLS tenant and filters the socket registry / health set to that tenant.
- **Alternative (lighter):** widen the existing `MonitoringController` / `ApiHealthController` gates to `@CanAny(...)` and add per-row tenant filtering. Rejected as default because those controllers are deliberately platform-ops surfaces (`monitoring.controller.ts:10-14`). **Open Q3.**

### 4.3 Layer-by-layer change list

**Database (`packages/database`)** — *gated; no change in this plan*
- **Only if Q2 = "add column":** `TenantBucket.quotaBytes BigInt?` (or `TenantStorageConfig.quotaBytes`) → migration `add_tenant_bucket_quota`. Follow `02-database-prisma.mdc` field ordering; regenerate client. *No other new columns are required — every aggregate reads existing models.*
- **Only if Q1 = "DB-backed time-series":** a `MetricSnapshot` table (tenantId?, capturedAt, json payload). Rejected for MVP in favour of Redis ring-buffer; listed for completeness.

**Domain (`packages/domains`)** — *minimal*
- If a quota column is added → regenerate `TenantBucket` entity/factory/mapper/model/repository via `gen:*` and update barrels (`02-database-prisma.mdc` §"After Schema Changes").
- Otherwise **no new entities**: aggregation is read-only and uses `databaseService.client` inside the application service (house precedent `tenant.service.ts:898`).

**Application (`packages/applications/src/services/platform-metrics/`)** — new folder via `pnpm gen:service`
- `IPlatformMetricsService` (Symbol token).
- `platform-metrics.service.ts` extends `BaseService`; methods: `getPlatformMetrics()`, `getOpenSockets()`, `getConsumptionRollup(tenantId?)`, `getTenantTelemetry(tenantId?)`. Reads: prom-client registry, `QueueAdminService`, `databaseService.client` aggregates, Python fan-out client.
- `MetricsReadoutService` (or `PrometheusQueryService` behind an interface) — computes rate/P95/error-rate from the registry; encapsulates the snapshot-delta logic.
- `PlatformPythonStatsClient` — cached fan-out to STT `/internal/*` + SMR `/providers`/`/metrics` (#19).
- DTOs in `dto/`: `PlatformMetricsResponse`, `OpenSocketsResponse`, `ConsumptionRollupResponse` (+ extend `TenantUsageResponse`, `ConsultationAggregateResponse`). All `@ApiProperty()`.
- `platform-metrics.dto.mapper.ts` if entity mapping is needed (mostly plain DTOs).
- `platform-metrics.service.module.ts` (imports `CommonServiceModule`, `CoreDatabaseModule`); export from `@arcaai/applications` barrel.
- Extend `ConsultationService` with `aggregateConsultationsForTenant({ from, to, granularity, tenantId? })` (#20) and `getUsageStats` (in `TenantService`) with storage/clinical counts (#4/#5).

**API (`apps/api/src/modules/platform-metrics/`)** — new module via `pnpm gen:controller`
- `platform-metrics.controller.ts` `@Controller('admin/platform')` — E1/E2/E3 (+ E6 if folded here), CASL-gated; injects `IPlatformMetricsService` **and** `SttWsGateway` (for the live count — see Q4) or a socket-registry provider token.
- `platform-metrics.module.ts` → register in `app.module.ts` `featureModules` (`apps/api/src/app.module.ts:229`).
- Extend `admin-consultation.controller.ts` with E4 (`GET aggregate`).
- Extend `tenant.controller.ts` `getUsage` response (E5) — DTO change only.
- #21: new `telemetry.controller.ts` `@Controller('admin/telemetry')` (or gate-widen `monitoring`/`health`).

**Auth / CASL (`packages/database/src/prisma/db_main/seed/01-policy.ts`)** — *gated*
- New subject **`PlatformMetrics`** — GLOBAL only; already covered by `system-full-access` (`manage:all`). Controller uses `@CanManage('PlatformMetrics')` (explicit) or reuse `@Authorize(['manage','all'])`.
- New subject **`TenantTelemetry`** (#21) — add to `tenant-full-access`: `{ action: 'read', subject: 'TenantTelemetry', conditions: { tenantId: '${context.tenantId}' } }` (after `01-policy.ts:130`). Super-admin via `manage:all`. Re-seed required (gated — confirm before running).
- Service-layer scope: `isSuperAdmin(user)` bypass; else pin to `this.tenantId`; `?tenantId=` honoured only for super-admin (mirrors `dna-writing-style-admin.controller.ts:59` + `tenant.controller.ts:63`).

**SDK (`packages/agentic-sdk-v2`)** — part of the feature (FE consumes it)
- `usePlatformMetrics` hook + `types/platform-metrics.ts`; endpoint constants in `core/constants.ts`.
- Realign `types/monitoring.ts` `SessionCounts` with backend `SessionsResponse` (drift noted in §2.2).

### 4.4 TDD RED test list (author these FIRST — they must fail before any impl)

> Per `01-development-workflow.mdc` TDD: write the failing test, confirm it fails for the right reason, then minimal GREEN. **The test files are described here but NOT created in this plan.**

**Unit — application services (Vitest, `packages/applications/src/services/platform-metrics/__tests__/`)**
1. `platform-metrics.service.test.ts`
   - `getPlatformMetrics` computes **requests/min** as a delta of `http_requests_total` between two snapshots (not the cumulative total).
   - **error rate** = 5xx ÷ total over the window; 0 total → 0%, no divide-by-zero.
   - **P95** picks the correct histogram bucket boundary for a known distribution.
   - **openSockets** reflects the injected socket-registry count (mocked `getActiveSessionCount`).
   - `models.running` / `perModel` merges the static inventory with the (mocked) Python fan-out; missing service → `null` (not `0`).
2. `consumption-rollup.test.ts`
   - transcription-minutes = `SUM(duration)/60000` with `COALESCE` over nullable durations.
   - summaries-24h counts only rows with `generatedAt >= now−24h`.
   - storageUsedBytes = `SUM(Media.size)`; quota = `null` until source decided.
3. `tenant-telemetry.scope.test.ts`
   - super-admin may target `?tenantId=`; tenant-admin's supplied `tenantId` is **ignored** and pinned to CLS tenant; missing tenant for non-super → `Forbidden`.

**Unit — consultation aggregation (Vitest, `packages/applications/src/services/consultation/__tests__/`)**
4. `consultation-aggregate.test.ts`
   - daily granularity returns **zero-filled** buckets across the whole range (no gaps); `sum(buckets.total) === totals.total`.
   - >70-day custom range switches to monthly granularity (mirror FE `chart.ts:64`).
   - new-vs-revisit split keys off `parentConsultationId IS NULL`.
   - bucket `key`/`label` match FE format (`yyyy-MM-dd` / `MMM d`).

**Unit — API controllers (Vitest, `apps/api/src/modules/platform-metrics/__tests__/`)**
5. `platform-metrics.controller.test.ts`
   - super-admin CLS → service called, DTO returned.
   - tenant-admin CLS → platform routes reject (no `PlatformMetrics`/`manage:all`).
6. `telemetry.controller.test.ts` (#21)
   - tenant-admin CLS → returns own-tenant telemetry; `?tenantId=other` ignored.

**E2E — Playwright (`apps/api/tests/e2e/task-386-platform-metrics.spec.ts`)** — mirror `task-383-platform-dashboard.spec.ts` auth (`loginUser(SEEDED_USERS.superAdmin…)` without tenantKey; doctor/admin with `DEFAULT_TENANT_KEY`)
7. `PM1` super_admin `GET /admin/platform/metrics` → 200; shape carries `requestsPerMinute`, `errorRatePct`, `p95LatencyMs`, `openSockets`, `services[]`, `models.perModel[]`, `refreshedAt`.
8. `PM2` super_admin `GET /admin/platform/sockets` → 200; `open` is a non-negative integer (#17).
9. `PM3` super_admin `GET /admin/platform/consumption` → 200; numeric `transcriptionMinutes`/`summaries24h`/`storageUsedBytes` (#18).
10. `PM4` super_admin `GET /admin/consultations/aggregate?from&to&granularity=day` → 200; buckets zero-filled; `Σ buckets = totals.total` (#20).
11. `PM5` `GET /admin/tenants/:id/usage` → 200; extended fields present (`storageUsedBytes`, `transcriptionMinutes`, `summaries24h`, `totalConsultations`) (#4/#5).
12. `PM6` (#21 scope) tenant_admin `GET /admin/telemetry/sessions` → 200 own-tenant; **doctor → 403**; tenant_admin cannot read another tenant via `?tenantId=`.
13. `PM7` (regression for TASK‑380 `TD3`) define + assert the agreed contract for super_admin `GET /admin/consultations` with no tenant scope (currently **400** at `admin-consultation.controller.ts` → `listConsultationsForTenant`) — see Open Q7.

---

## 5. Decisions — RESOLVED (approved 2026‑07‑01, all implemented)

> The eight open questions below were resolved by the approved decision set and are now built. Each line records the decision **and** where it landed in code.

1. **Metrics source = Prometheus.** ✅ `PrometheusQueryService` (behind `IPrometheusQueryService`, env `PROMETHEUS_URL`, default `http://localhost:9090`) issues PromQL from `METRIC-CONTRACT.md` for requests/min, error-rate, per-service P95, per-model running + avg-latency. Mockable in unit tests; **graceful degradation** → returns `null`/`[]` on any Prometheus error (never throws). When Prometheus is absent the tiles render em-dash, not an error.
2. **Storage quota = real column.** ✅ Added `TenantBucket.quotaBytes BigInt?` (nullable, additive) + migration `20260701000000_task_386_add_tenant_bucket_quota`; regenerated Prisma client + `TenantBucket` domain entity/factory/mapper/model/repository + barrels. `bigint` → `number` for JSON.
3. **Tenant-scoped telemetry (#21) = widen existing gates.** ✅ No new subject/controller. Widened `MonitoringController` + `ApiHealthController` with `@CanAny([manage:all] OR [read:TenantTelemetry])`; super-admin may target `?tenantId=`, non-super is pinned to the CLS tenant (mirrors `dna-writing-style-admin.controller.ts:59`). Added the `read:TenantTelemetry` rule to `01-policy.ts` (tenant-admin role) and re-seeded the **TEST** DB only.
4. **TD3 / DEF-1 = cross-tenant for super-admin.** ✅ `admin-consultation.controller.ts` + `listConsultationsForTenant(...)` now return **cross-tenant** data for a super-admin with no tenant scope (was HTTP 400). Tenant-admins stay pinned. Regression covered by `PM7` (E2E) + the un-`fixme`'d frame-10 FE cases. **DEF-1 is fixed.**
5. **Open sockets (#17) = multi-instance via Redis.** ✅ `SttWsGateway` publishes its per-instance `active_connections_count` to Redis on connect/disconnect + a 20 s heartbeat (`ISocketRegistryService`); `GET /admin/platform/sockets` reads the **aggregate** across instances.
6. **Per-model running + avg-latency (#19) = Prometheus scrape.** ✅ Read via `PrometheusQueryService` (no per-request Python fan-out); static inventory merged with scraped values, missing service → `null`.
7. **Endpoints = per-tile + Redis cache (~12 s TTL).** ✅ E1 `/admin/platform/metrics`, E2 `/admin/platform/sockets`, E3 `/admin/platform/consumption`, E4 `/admin/consultations/aggregate`, E5 `/admin/tenants/:id/usage` (extended), E6 widened monitoring/health. FE polls ~15 s.
8. **No audit on reads.** ✅ These metric reads emit **no** `ResourceViewed`/SysEvent.

> Decisions #1 and #6 depend on the parallel Python worker's `METRIC-CONTRACT.md` for exact metric names/labels. The `PrometheusQueryService` is built against that contract behind a mockable interface; any name drift is a contract-only change (see §6 "Reconcile").

---

## 6. Implementation Summary

Built layer-by-layer (DB → Domain → Applications → API → SDK → Frontend), TDD RED→GREEN→REFACTOR. The TypeScript half is complete and verified; the Prometheus-derived metric **values** depend on the parallel Python worker's scrape + `METRIC-CONTRACT.md` (the read path is built behind a mockable interface and degrades to em-dash when Prometheus is absent).

### 6.1 Files by layer

**Database (`packages/database`)**
- `src/prisma/db_main/tenant-bucket.prisma` — added nullable `quotaBytes BigInt?` to `TenantBucket` (decision #2).
- `src/prisma/db_main/migrations/20260701000000_task_386_add_tenant_bucket_quota/migration.sql` — **additive only** (`ALTER TABLE "core"."TenantBucket" ADD COLUMN "quotaBytes" BIGINT;`). No drops/deletes.
- `src/prisma/db_main/seed/01-policy.ts` — added the `read:TenantTelemetry` rule to the tenant-admin role (decision #3).
- Regenerated Prisma client.

**Domain (`packages/domains`)** — regenerated `TenantBucket` entity/factory/mapper/model/repository for `quotaBytes` (+ barrels). No new entities (read aggregates run through `databaseService.client`, house precedent `tenant.service.ts:898`).

**Applications (`packages/applications/src/services/platform-metrics/`)** — new module:
- `prometheus-query.service.ts` (+ `IPrometheusQueryService`) — PromQL over `PROMETHEUS_URL`; null/[]-on-error.
- `socket-registry.service.ts` (+ `ISocketRegistryService`) — Redis publish/aggregate of per-instance `active_connections_count` (decision #5).
- `platform-metrics.service.ts` (+ `IPlatformMetricsService`) — E1/E2/E3 with a ~12 s Redis cache.
- `dto/` — `platform-metrics.response.ts`, `open-sockets.response.ts`, `consumption-rollup.response.ts` (all `@ApiProperty()`).
- `platform-metrics.service.module.ts` + `index.ts`; registered in the `@arcaai/applications` barrel.
- **Consultation aggregation (#20):** `consultation/consultation.service.ts` + `IConsultationService.ts` gained `aggregateConsultationsForTenant(...)` (zero-filled day/month buckets, new-vs-revisit via `parentConsultationId IS NULL`, mirrors FE `chart.ts`); DTO `dto/consultation-aggregate.response.ts`. **TD3:** `listConsultationsForTenant` now returns cross-tenant data for a super-admin with no tenant scope (decision #4).
- **Tenant usage (#4/#5):** `TenantService.getUsageStats` extended with `storageUsedBytes`/`storageQuotaBytes` + clinical counts.

**API (`apps/api/src/modules/`)**
- `platform-metrics/` — new `platform-metrics.controller.ts` (`@Controller('admin/platform')`, E1/E2/E3, `manage:all`) + `platform-metrics.module.ts` + `index.ts`; registered in `app.module.ts`.
- `consultation/admin-consultation.controller.ts` — E4 `GET /admin/consultations/aggregate` + the TD3 cross-tenant change.
- `tenant/tenant.controller.ts` — E5 extended `/admin/tenants/:id/usage` DTO.
- `monitoring/monitoring.controller.ts` + `health/health.controller.ts` — widened with `@CanAny([manage:all] OR [read:TenantTelemetry])`, super-admin `?tenantId=` honoured, non-super pinned to CLS tenant (decision #3, E6).

**SDK (`packages/agentic-sdk-v2/src/`)**
- `hooks/usePlatformMetrics.ts` (+ test) — E1/E2/E3 + tenant-usage hook.
- `types/platform-metrics.ts` — response types.
- `core/constants.ts` — platform + `TENANT_ENDPOINTS.USAGE` constants.
- `hooks/useMonitoring.ts` + `types/monitoring.ts` — realigned `SessionCounts`/`normalizeSessionCounts` with the backend `SessionsResponse` (services map).

**Frontend (`apps/admin/src/`)**
- `features/platform-dashboard/format.ts` — `formatBytes` (+ `formatCount`).
- `routes/_authenticated/dashboard.tsx` — platform KPIs (transcription minutes, summaries/24h, storage used/quota) via `usePlatformMetrics`.
- `routes/_authenticated/system-health.tsx` — headline KPIs + per-service P95 + per-model running/avg-latency tables (E1).
- `routes/_authenticated/tenants/$tenantId/{overview,storage}.tsx` — tenant usage roll-ups (E5) incl. storage quota progress bar.
- **DEF-1 fixed:** the cross-tenant Platform Dashboard now renders real data (depends on the TD3 super-admin change).

**Tests**
- Unit: `platform-metrics/__tests__/{platform-metrics.service,consumption-rollup,socket-registry.service,tenant-telemetry.scope}.test.ts`; `consultation/__tests__/consultation-aggregate.test.ts`; `apps/api/.../platform-metrics/__tests__/platform-metrics.controller.test.ts` (+ updated monitoring/health controller specs).
- E2E: `apps/api/tests/e2e/task-386-platform-metrics.spec.ts` (PM1–PM7).
- Un-`fixme`'d the 9 DEF-1 cases in `apps/admin/e2e/task-383-platform-dashboard.spec.ts`.

### 6.2 Endpoints

| ID | Method + path | Auth | Source |
|---|---|---|---|
| E1 | `GET /admin/platform/metrics` | `manage:all` | Prometheus (env-dependent values) |
| E2 | `GET /admin/platform/sockets` | `manage:all` | Redis socket aggregate (#17) |
| E3 | `GET /admin/platform/consumption` | `manage:all` | Postgres roll-up (#18) |
| E4 | `GET /admin/consultations/aggregate` | `manage:all` / tenant | Postgres, zero-filled buckets (#20) |
| E5 | `GET /admin/tenants/:id/usage` | `manage:all` / tenant | Postgres + `quotaBytes` (#4/#5) |
| E6 | `GET /monitoring/sessions`, `/health/services` | `manage:all` **OR** `read:TenantTelemetry` | widened, tenant-scoped (#21) |

### 6.3 Verification evidence

- **Unit — applications (my new suites):** `4 files, 22 passed` (platform-metrics + consultation-aggregate). Full `@arcaai/applications`: `5443 passed`, `1 failed` — the single failure is **pre-existing, unrelated**: `secrets-coverage.test.ts` flags `packages/applications/scripts/task-376-storage.ts:43-44` reading `MINIO_ACCESS_KEY`/`MINIO_SECRET_KEY` (committed `94907243`, 2026‑06‑29, before TASK‑386). Not in this changeset; left untouched per surgical-change/ownership rules.
- **Unit — API:** `1827 passed, 4 skipped` (all green). My targeted API suites (`platform-metrics` + widened `monitoring`/`health`): `3 files, 46 passed`.
- **Build:** `pnpm build:api` → `8 successful, 8 total`. `apps/admin type-check` (`tsc --noEmit`) → clean (exit 0).
- **Backend E2E:** `task-386-platform-metrics.spec.ts` PM1–PM7 → `10/10 passed`. DB-aggregation endpoints (E3/E4/E5, quota) + TD3 cross-tenant are live-tested against Postgres; E1/E2 Prometheus **values** asserted as shape/type (env-dependent — noted).
- **Frontend E2E:** full admin Playwright suite `93 passed, 0 failed` (incl. the un-`fixme`'d DEF-1 frame-10 cases in `task-383` + the `task-379`/`task-380` overview/storage surfaces I touched). NB: running `pnpm build:api` (`rimraf dist && nest build`) while `dev:api:test` is live will crash the test backend (it serves from `dist` via `nest start --watch`) — run builds **before** starting the test server, or restart it after.
- **Lint:** `ReadLints` on all changed source files → no errors.

### 6.4 METRIC-CONTRACT reconcile

`PrometheusQueryService` is built against the plan's metric names behind `IPrometheusQueryService`. If the parallel Python worker's `METRIC-CONTRACT.md` finalises different metric/label names, the only change required is the PromQL string constants (and matching mocks) — no controller/DTO/FE changes. Verify the contract's names for: `http_requests_total`, 5xx counter, request-duration histogram (P95), per-model running/latency gauges, and `active_connections_count`.

> **Reconcile verified (2026-07-01).** The canonical PromQL lives in the `PROMQL` constant in `platform-metrics.service.ts` (the consumer of the thin `prometheus-query.service.ts` transport client, which itself holds **no** metric names — it just executes the query strings handed to it). All constants were checked against the finalised `METRIC-CONTRACT.md` and **already match**, so **no code change was needed**:
> - per-service **P95 / rate / error** use `http_request_duration_seconds` + `http_requests_total{status=~"5.."}` with the API gateway's own `service` label (contract §9);
> - per-model **running / avg-latency** use `model_running_instances` + `model_inference_latency_seconds` keyed `{service, model}` (contract §3/§11);
> - **sockets** use `active_connections_count` (contract §9).
>
> The contract's **`job` vs `service`** collision guidance is honoured — the constants only key `http_*` by the API gateway's own `service` label and never query a Python service's `http_*` by `job`, so no `exported_service` rename risk. Scoped unit tests (which mock `IPrometheusQueryService`) stay green: `pnpm --filter @arcaai/applications test:unit src/services/platform-metrics` → **4 files, 22 passed**.

## 7. Change History

| Date | Change | Files |
|---|---|---|
| 2026‑07‑01 | Initial plan authored (exploration + research + prioritisation + #16/T1 plan). PLAN ONLY. | this README |
| 2026‑07‑01 | **Implemented the TypeScript half** (decisions #1–#8). DB column + additive migration + seed rule; regenerated `TenantBucket` domain; new `platform-metrics` application module (Prometheus/Redis-socket/cache services + DTOs); consultation aggregation + TD3 cross-tenant fix; extended tenant usage; new `admin/platform` controller + widened monitoring/health + E4/E5; SDK `usePlatformMetrics` + monitoring realign; FE wiring of platform/tenant/tenant-detail tiles (DEF-1 fixed). Unit/build/E2E green; 1 pre-existing unrelated secrets-coverage failure flagged. | DB/Domain/Applications/API/SDK/FE per §6.1; `task-386-platform-metrics.spec.ts`; un-`fixme` `task-383-*.spec.ts` |
| 2026‑07‑01 | **METRIC-CONTRACT reconcile verified — PromQL constants already match (no code change).** Compared the `PROMQL` string constants in `platform-metrics.service.ts` (consumer of the thin `prometheus-query.service.ts` client) against the authoritative `METRIC-CONTRACT.md`: per-service P95/rate/error (`http_request_duration_seconds` / `http_requests_total`, API `service` label), per-model running/avg-latency (`model_running_instances` + `model_inference_latency_seconds` `{service,model}`), and sockets (`active_connections_count`) all match — incl. the `job` vs `service` guidance. Scoped unit tests green (`test:unit src/services/platform-metrics` → 4 files / 22 passed). Docs-only; no product code touched (§6.4). | `README.md` (§6.4 + this row) |
