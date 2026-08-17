# Traceability — Platform Operations

Cross-cutting platform operations: audit logging + sys-events, the raw global-settings /
secrets store, rate limiting, metrics / monitoring / health, queue & scheduler administration,
the dev-only embedded DB browser, AI-service status/config, and the notification / webhook /
resource-subscription fan-out plane. Migrates legacy matrix rows **28**, **30**, **31**, **32**,
**33**, **34**, **34a**, and **corrects the factually-stale row 29** (which claimed
notifications/webhooks/subscriptions had "no public controller" — all three now ship full CRUD
controllers; split into PO8/PO9/PO10). Legacy row **34d** (MCP registry + agent-trajectory RBAC)
is split across two already-migrated files — see PO11.

Route paths are relative to the global prefix `/api/v1`. Test shorthand is defined in
[`index.md`](./index.md#test-location-shorthand). `—` means verified-absent.

## Capabilities

### PO1 — Audit logging & sys-events — legacy row 28

| Field | Value |
|---|---|
| App / service | `apps/api` |
| Key modules | `apps/api/src/modules/audit-log` (`audit-log.controller.ts`); `packages/applications/src/services/{sysEvent,auditLog,audit-retention}` |
| Prisma models | `AuditLog` (`db_main/audit.prisma`) |
| Key API endpoints | `@Controller('admin/audit-logs')` (class `@CanRead('AuditLog')`): `GET ''` (fetchAll), `GET export` (CSV), `GET cursor` (keyset), `GET :id`, `GET resource/:resourceType/:resourceId`, `GET user/:userId` |
| Tests | unit(app): `auditLog/__tests__/*` (`auditLog.service`, `auditLog.service.cursor`, `auditLog.processor`, `auditLog-encryption.service`, `auditLog.service.task541`, `auditLog.service.task328`), `sysEvent/__tests__/{sysEvent.service,event-throttle.service}.test.ts`, `audit-retention/__tests__/audit-retention.service.test.ts`; unit(console): `audit-logs/components/__tests__/audit-logs-screen.test.tsx`; e2e: `audit-log.spec.ts`, `auth-revocation-audit.spec.ts` |
| Console | `apps/admin-console` feature `audit-logs` (`audit-logs-screen`, `audit-log-detail-sheet`, `audit-result-indicator`); route `/audit-logs` (tier 10–19, global) |

### PO2 — Global settings & secrets store — legacy row 30

The raw key/value + secrets store. The TASK-504 **typed control plane** over it
(`settings-catalog` / registry / effective-config) is migrated in
[`tenancy-provisioning.md`](./tenancy-provisioning.md) (TP6) — both mount on `/admin/settings`.

| Field | Value |
|---|---|
| App / service | `apps/api` + Vault |
| Key modules | `apps/api/src/modules/global-setting` (`global-setting.controller.ts`); `packages/applications/src/services/globalSetting`, `packages/applications/src/services/security` (`SecretsService`, crypto) |
| Prisma models | `GlobalSetting` (`db_main/globalSetting.prisma`) |
| Key API endpoints | `@Controller('admin/settings')` (class `@CanManage('GlobalSetting')`): `POST ''` (`@CanCreate`), `GET ''` (`@CanRead`), `GET tenant/:tenantId` (`@CanRead`), `GET :id` (`@CanRead`), `PATCH :id` (`@CanUpdate`, `@RequiresIfMatch()` → 428/412), `DELETE :id` (`@CanDelete`), `POST :id/reveal`, `POST :id/rotate` (`@RequiresIfMatch()`). **AUTH-NOTE:** `reveal`/`rotate` are SUPER_ADMIN-only — the method-level `@Authorize(['manage','all'])` overrides the class `@CanManage('GlobalSetting')` (rule 05) |
| Tests | unit(app): `globalSetting/__tests__/*` (`globalSetting.service`, `globalSetting.service.list`, `globalSetting.service.rotate`, `globalSetting.service.task402`, `globalSetting.dto.mapper`); e2e: `super-admin-backend-backlog.spec.ts`, `password-hash-settings.spec.ts`, `settings-list-faceting.spec.ts` |

### PO3 — Rate limiting & throttling — legacy row 31

| Field | Value |
|---|---|
| App / service | `apps/api` + Redis |
| Key modules | `apps/api/src/modules/throttle` (`tiered-throttler.guard.ts`, `rate-limit-config.service.ts`), `apps/api/src/modules/admin-rate-limit` (`rate-limit-admin.controller.ts`); `packages/applications/src/services/rate-limit` |
| Prisma models | `GlobalSetting` (persisted limits/tiers) |
| Key API endpoints | `@Controller('admin/rate-limit')` (class `@Authorize(['manage','all'])`): `GET ''`, `PUT enabled`, `PUT tiers/:tier`, `PUT routes/:routeId` |
| Console | `apps/admin-console` feature `rate-limits` (`rate-limits-screen`); route `/rate-limits` (tier 10–19, global) |
| Tests | unit(app): `rate-limit/__tests__/{rate-limit-admin.service,rate-limit-settings.service}.test.ts`; unit(console): `rate-limits/components/__tests__/rate-limits-screen.test.tsx`; e2e: `auth-throttle-per-endpoint.spec.ts` |

### PO4 — Platform metrics, monitoring & health — legacy row 32

| Field | Value |
|---|---|
| App / service | `apps/api` + Prometheus |
| Key modules | `apps/api/src/modules/{monitoring,platform-metrics,health}`; `packages/applications/src/services/platform-metrics` |
| Prisma models | — (Prometheus / Redis-backed telemetry) |
| Key API endpoints | `@Controller('monitoring')` (`@CanAny(['manage','all'],['read','TenantTelemetry'])`): `GET uptime`, `GET uptime/:service`, `GET heartbeats/:service`, `GET sessions`. `@Controller('admin/platform')` (`@CanManage('PlatformMetrics')`): `GET metrics`, `GET sockets`, `GET consumption`. `@Controller('health')`: `GET live`/`ready`/`startup`/`''` (`@Public()`), `GET services`, `GET services/:serviceKey` (`@CanAny(['manage','all'],['read','TenantTelemetry'])`). Prometheus `GET /metrics` (unprefixed — the only global-prefix exclusion) |
| Console | `apps/admin-console` features `monitoring` (`monitoring-screen`, `dev-service-down-hint`; route `/monitoring`) and `platform` (`platform-dashboard`; route `(global)/dashboard`), both tier 10–19 global |
| Tests | unit(app): `platform-metrics/__tests__/*` (`platform-metrics.service`, `consumption-rollup`, `socket-registry.service`, `tenant-telemetry.scope`); unit(console): `monitoring/components/__tests__/{monitoring-screen,dev-service-down-hint}.test.tsx`; e2e: `health.spec.ts`, `monitoring.spec.ts`, `platform-runtime-metrics.spec.ts`, `platform-dashboard-monitoring.spec.ts` |

### PO5 — Queue & scheduler administration — legacy row 33

| Field | Value |
|---|---|
| App / service | `apps/api` (BullMQ / Redis) |
| Key modules | `apps/api/src/modules/queue-admin` (`queue-admin.controller.ts`, `scheduler-admin.controller.ts`); `packages/applications/src/services/queue-admin` |
| Prisma models | — (BullMQ state in Redis) |
| Key API endpoints | `@Controller('admin/queues')` (class `@Authorize(['manage','all'])`): `GET ''`, `GET health/redis`, `GET :queueName`, `POST :queueName/{pause,resume,clean}`, `GET :queueName/jobs`, `POST :queueName/jobs/bulk`, `GET :queueName/jobs/:jobId`, `POST :queueName/jobs/:jobId/{retry,promote}`, `DELETE :queueName/jobs/:jobId`. `@Controller('admin/schedulers')` (`@Authorize(['manage','all'])`): `GET ''`, `POST :name/{pause,resume}`, `PATCH :name/{cron,toggle}` |
| Console | `apps/admin-console` feature `queues` (`queues-screen`, `queue-detail-screen`, `schedulers-screen`, `job-detail-sheet`, dialogs); routes `/queues`, `/queues/[name]`, `/schedulers` (tier 10–19, global) |
| Tests | unit(app): `queue-admin/__tests__/*` (`queue-admin.service`, `job-admin.service`, `job-data-redactor.service`, `queue-events.service`, `scheduler-admin.service`); unit(console): `queues/components/__tests__/{queues-screen,queue-detail-screen,schedulers-screen}.test.tsx`; e2e: `super-admin-ops-surfaces.spec.ts` (partial) |

### PO6 — Embedded DB browser (dev only) — legacy row 34

| Field | Value |
|---|---|
| App / service | `apps/api` + `apps/admin-console` |
| Key modules | `apps/api/src/modules/pstudio` (`pstudio.controller.ts`, `pstudio-status.controller.ts`, `pstudio.html.ts` — fail-closed: dev + flag gated); `packages/applications/src/services/pstudio` |
| Prisma models | — |
| Key API endpoints | `@Controller('admin/pstudio')` (`@CanManage('PrismaStudio')`): `GET ''`, `POST ''` (`@Authorize(['manage','PrismaStudio'])`). `@Controller('admin/pstudio/status')` (`@Authorize(['manage','PrismaStudio'])`): `GET ''`. The gateway paths are deliberately unchanged; only the console route was renamed |
| Console | `apps/admin-console` feature `db-studio` (`db-studio-screen`); route `/db-studio` (tier 10–19, global). TASK-532 M-08 — renamed from `/pstudio`, which now `redirect()`s for one release |
| Tests | unit(api): `pstudio/__tests__/{pstudio.controller,pstudio-status.controller,pstudio.html}.test.ts`; unit(console): `db-studio/components/__tests__/db-studio-screen.test.tsx`, `app/(console)/(global)/__tests__/retired-route-redirects.test.tsx`; e2e: `super-admin-ops-surfaces.spec.ts` (partial) |

### PO7 — AI service status & config (guardrail / NLP / agentic instructions) — legacy row 34a

| Field | Value |
|---|---|
| App / service | `apps/api` + `apps/admin-console` |
| Key modules | `apps/api/src/modules/ai-service-admin` (`ai-service-admin.controller.ts`, `ai-service-proxy.client.ts`), `apps/api/src/modules/agentic-admin` (`agentic-admin.controller.ts`); `packages/applications/src/services/agentic-instructions` |
| Prisma models | — (proxied upstream reads; `HarnessPolicy` aggregate for instructions) |
| Key API endpoints | `@Controller('admin/ai-services')` (class `@Authorize(['manage','all'])`): `GET guardrail/status`, `GET guardrail/config`, `GET nlp/status`. `@Controller('admin/agentic')` (class `@Authorize()`): `GET instructions` (`@CanManage('HarnessPolicy')` — deliberately borrows the `HarnessPolicy` subject) |
| Console | `apps/admin-console` feature `ai-services` (`ai-services-screen`, `guardrail-panel`, `nlp-panel`, `instructions-panel`); route `/ai-services` (tier 10–19, global). Guardrail/NLP payloads are upstream-owned and rendered defensively (unknown-shape degradation) |
| Tests | unit(api): `ai-service-admin/__tests__/*`, `agentic-admin/__tests__/*`; unit(app): `agentic-instructions/__tests__/agentic-instructions.service.test.ts`; unit(console): `ai-services/components/__tests__/ai-services-screen.test.tsx` (incl. axe + degradation) |

### PO8 — Notifications — legacy row 29 (split; the "no controller" note is stale)

| Field | Value |
|---|---|
| App / service | `apps/api` |
| Key modules | `apps/api/src/modules/notification` (`notification.controller.ts`); `packages/applications/src/services/notification` |
| Prisma models | `Notification` (`db_main/notification.prisma`) |
| Key API endpoints | `@Controller('admin/notifications')` (class `@CanManage('Notification')`): `GET ''`, `GET :id`, `PATCH :id`, `DELETE :id` |
| Tests | unit(app): `notification/__tests__/{notification.service,notification.service.encryption}.test.ts`; e2e: `—` |

### PO9 — Webhooks — legacy row 29 (split)

| Field | Value |
|---|---|
| App / service | `apps/api` |
| Key modules | `apps/api/src/modules/webhook` (`webhook.controller.ts`); `packages/applications/src/services/webhook` |
| Prisma models | `Webhook`, `WebhookRunHistory` (`db_main/webhook.prisma`) |
| Key API endpoints | `@Controller('admin/webhooks')` (class `@CanManage('Webhook')`): `POST ''`, `GET ''`, `GET :id`, `GET :id/deliveries` (`@Authorize(['read','WebhookRunHistory'])`), `PATCH :id`, `DELETE :id` |
| Tests | unit(app): `webhook/__tests__/webhook.service.test.ts`; e2e: `—` |

### PO10 — Resource subscriptions — legacy row 29 (split)

| Field | Value |
|---|---|
| App / service | `apps/api` |
| Key modules | `apps/api/src/modules/resource-subscription` (`resource-subscription.controller.ts`); `packages/applications/src/services/resourceSubscription` |
| Prisma models | `ResourceSubscription` (`db_main/notification.prisma`) |
| Key API endpoints | `@Controller('admin/resource-subscriptions')` (class `@CanManage('ResourceSubscription')`): `POST ''`, `GET ''`, `GET :id`, `PATCH :id`, `POST :id/toggle`, `DELETE :id` |
| Tests | unit(app): `resourceSubscription/__tests__/{resourceSubscription.service,resourceSubscription.dto.mapper}.test.ts`; e2e: `—` |

### PO11 — MCP registry & agent-trajectory RBAC — legacy row 34d (migrated elsewhere)

Legacy row 34d is split across two already-migrated domain files; it is **not** re-owned here:

- **MCP tool registry** (`mcp-admin` module, `McpServer` model, `admin/mcp-servers*` routes, console `tools-mcp`) → [`harness.md`](./harness.md) (H7).
- **Agent-trajectory observability + RBAC subject** (`agent-trajectory` module, `AgentTrajectoryStep` model, `admin/agent-trajectory/*` routes, AI-operations console) → [`ai-models-providers.md`](./ai-models-providers.md) (M7).

## Honest notes / gaps

- **Row 29 was stale.** The legacy matrix claimed notifications/webhooks/resource-subscriptions had "no public controller yet; fan-out consumed from `JobQueue.SysEvent`". All three now ship full CRUD controllers (PO8/PO9/PO10) with dedicated RBAC subjects; the fan-out path still exists but is no longer the only surface.
- **No e2e for the fan-out plane.** PO8/PO9/PO10 have unit(app) coverage only — there is no `apps/api/tests/e2e` spec exercising the notification/webhook/subscription CRUD against a live stack.
- **`/admin/settings` is shared.** PO2 (`global-setting`, raw store) and TP6 (`settings-catalog`, typed control plane, in [`tenancy-provisioning.md`](./tenancy-provisioning.md)) mount on the same base — see the disambiguation there.
- **The `(global)/dashboard` route is its own feature.** PO4's `admin/platform/*` metrics feed both the `monitoring` feature and the `platform` feature (`features/platform/components/platform-dashboard.tsx`), which backs the `(global)/dashboard` route; both are inventoried in [`admin-console.md`](./admin-console.md).
- **Ops e2e is partial.** PO5/PO6 lean on `super-admin-ops-surfaces.spec.ts` (marked partial in the legacy matrix) plus unit coverage.

Last verified: 2026-07-22
