# Diagrams

Two standalone Archify HTML diagrams document the API gateway. Open either file directly in a browser; no server or network connection is required. Node focus opens the Semantic Passport, which lists the upstream/downstream relationships, the node's role, and clickable source evidence pinned to the analyzed revision.

| Diagram | Level | Best for |
|---|---|---|
| [api-system-context.html](./api-system-context.html) | System context | Seeing the gateway's boundary, clients, auth, data stores, and the STT/text/TTS side services. |
| [api-gateway-internals-deep-dive.html](./api-gateway-internals-deep-dive.html) | Component/internals | Seeing the actual bootstrap, guard/interceptor/filter order, auth/tenancy services, domain modules, data/infra, workers, and boot audits. |

## What the deep dive shows

The deep dive is deliberately organized as a request-to-data map rather than a flat list of folders:

1. **Bootstrap and configuration** — `main.ts` boot sequence, `AppModule` composition, validated environment, and boot audits.
2. **Global guards (order 1–8)** — `TieredThrottlerGuard` → `ClsGuard` → `UnifiedAuthGuard` → `TenantLockGuard` → `PatientConsentGuard` → `TenantOwnedResourceSSEGuard` → `OriginTenantBindingGuard` → `RequiresIfMatchGuard`.
3. **Global interceptors** — metrics, rate-limit headers, request context, exception normalization, maintenance mode, impersonation audit, and ETag.
4. **Global exception filters** — catch-all, error envelope, data-not-found, and consent filters. Nest consults the last-registered matching filter first.
5. **AuthN/AuthZ and tenancy services** — `AuthService`, `AuthorizationGuard`, API keys, service accounts, consent, and the origin registry.
6. **Domain feature modules** — clinical core, agent/workflows, AI platform, tenancy/identity, storage/media, and ops.
7. **Data and infrastructure** — tenant-scoped Prisma, Postgres, Redis, BullMQ, S3/MinIO, and Vault.
8. **Background platform** — schedulers/workers, the separate checkpoint worker, streaming gateways, and ops/observability.
9. **External services and telemetry** — STT, TTS, text service, AI providers, and OpenTelemetry.

## What each node gives you

- **Label** — the class, module, or component name.
- **Sublabel** — a one-line statement of what that code does.
- **Source badge** — click a node, then use the source links in the passport. Each link opens the exact file and line in `ArcaAI/project-hope` at the analyzed revision.
- **Cards** — below the canvas, the cards explain cross-cutting rules (guard order, deny-by-default auth, tenant isolation, queues/workers, boot audits) that a single node cannot convey.

## Evidence and reproducibility

- Candidate JSON:
  - [api-system-context.candidate.json](./api-system-context.candidate.json)
  - [api-gateway-internals-deep-dive.candidate.json](./api-gateway-internals-deep-dive.candidate.json)
- Finalize receipt: [api-gateway-internals-deep-dive.finalize-summary.json](./api-gateway-internals-deep-dive.finalize-summary.json)
- Browser evidence: [api-gateway-internals-deep-dive.browser-check.json](./api-gateway-internals-deep-dive.browser-check.json)
- Build log: [../logs/03-diagrams.log](../logs/03-diagrams.log)

The diagrams were finalized with:

```bash
node ~/.agents/skills/archify/bin/archify.mjs finalize architecture \
  diagrams/api-gateway-internals-deep-dive.candidate.json \
  api-gateway-internals-deep-dive.html \
  --repo-root /Users/apple/repos/VOX/project-hope \
  --quality showcase --json
```

All four gates passed: `validate`, `deliver`, `check`, and `browser-check`.

## Read this with

- [../codebase/ARCHITECTURE.md](../codebase/ARCHITECTURE.md) — narrative version of the request pipeline and module layout.
- [../codebase/CONCERNS.md](../codebase/CONCERNS.md) — known gaps and untested areas.
- [../docs/06a-COVERAGE-BY-AREA.md](../docs/06a-COVERAGE-BY-AREA.md) — coverage by area and lowest-covered files.
- [../inventory/summary.json](../inventory/summary.json) — route/controller/module counts used by the diagram.
