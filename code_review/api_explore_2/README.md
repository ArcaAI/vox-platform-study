# HOPE API Gateway Exploration & Developer Troubleshooting Documentation

**Target Codebase:** [`/Users/apple/repos/VOX/project-hope/apps/api`](file:///Users/apple/repos/VOX/project-hope/apps/api)  
**Output Documentation:** `/Users/apple/repos/VOX/review/api_explore_2` (completely isolated; existing files unchanged)  
**Scope:** Architecture, Endpoint Catalog, Controller Handlers, Hierarchical Call Trees, and Developer Troubleshooting Runbooks.

---

## Executive Overview: The Three Questions Answered

This documentation suite was specifically created to provide immediate, actionable answers to three core questions:

### 1. What are the APIs?
The HOPE Gateway exposes **818 distinct API endpoints** across **77 feature modules** under the global prefix `/api/v1/` (plus `/metrics` and `/ws/stt/stream`). They are organized into **5 core capability planes**:
1. **Clinical & Consultation Plane:** Clinical sessions, SOAP summaries, live running notes, attachments, telemetry.
2. **Speech & Audio Plane:** High-speed WebSocket live audio streaming, batch transcription jobs, voice profiles.
3. **AI Models, Prompts & Guardrails Plane:** LLM proxying, safety checks, prompt management, DNA writing styles.
4. **Agentic, Workflow & Harness Plane:** Temporal workflow orchestration, agent assignments, MCP tools, RAG knowledge.
5. **Platform Administration & Tenancy Plane:** Tenants, users, RBAC permissions, API keys, service accounts, billing, rate limits.
👉 **Full Details:** [01-WHAT-ARE-THE-APIS.md](file:///Users/apple/repos/VOX/review/api_explore_2/01-WHAT-ARE-THE-APIS.md)

---

### 2. What code is handling those APIs?
All endpoints are handled by **148 NestJS Controllers** in [`apps/api/src/modules/`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules).  
- **Architecture Invariant:** The gateway holds **no direct Prisma database queries and no business domain rules**.
- Controllers parse DTOs, enforce validation pipes, check access decorators, and delegate directly to Application Services in [`packages/applications`](file:///Users/apple/repos/VOX/project-hope/packages/applications).
👉 **Full Details:** [02-API-CONTROLLERS-AND-CALL-TREES.md](file:///Users/apple/repos/VOX/review/api_explore_2/02-API-CONTROLLERS-AND-CALL-TREES.md)

---

### 3. What other APIs or Services does that handler call in a tree manner?
Every controller method dispatches calls through a structured tree hierarchy:
```text
[HTTP Request: POST /api/v1/consultations/:id/summary]
  └── Controller: ConsultationController.generateSummaryAsync()
        ├── Step 1: verifyConsultationOwnership()
        ├── Step 2: consultationJobService.runIdempotent() -> Redis Lock
        └── Step 3: noteGenerationService.generate() [@arcaai/applications]
              └── calls: Temporal Client -> Launches "HarnessLoopWorkflow"
                    ├── Calls: Python Text Service (Port 8862) -> LLM generation
                    ├── Calls: Python Guardrail Service -> Safety check
                    └── Calls: ConsultationRepository -> Postgres Prisma DB
```
👉 **Full Details & Deep Dives:** [02-API-CONTROLLERS-AND-CALL-TREES.md](file:///Users/apple/repos/VOX/review/api_explore_2/02-API-CONTROLLERS-AND-CALL-TREES.md)  
👉 **Full 9,500+ Line Module Call-Tree Reference:** [inventory/call-trees-by-module.md](file:///Users/apple/repos/VOX/review/api_explore_2/inventory/call-trees-by-module.md)

---

## Complete Documentation Index

### Section A: API Catalog & Call Trees
| Document | Purpose |
|---|---|
| [**01-WHAT-ARE-THE-APIS.md**](file:///Users/apple/repos/VOX/review/api_explore_2/01-WHAT-ARE-THE-APIS.md) | Comprehensive catalog of routes across the 5 capability planes, HTTP verbs, and auth models. |
| [**02-API-CONTROLLERS-AND-CALL-TREES.md**](file:///Users/apple/repos/VOX/review/api_explore_2/02-API-CONTROLLERS-AND-CALL-TREES.md) | Detailed walkthrough of how controllers handle requests and hierarchical call trees for all core workflows. |
| [**03-DOWNSTREAM-SERVICES-AND-INTEGRATIONS.md**](file:///Users/apple/repos/VOX/review/api_explore_2/03-DOWNSTREAM-SERVICES-AND-INTEGRATIONS.md) | Technical reference of downstream Python microservices (STT, Text, TTS, NLP, Guardrail), Redis, S3, Vault, and Temporal. |
| [**inventory/call-trees-by-module.md**](file:///Users/apple/repos/VOX/review/api_explore_2/inventory/call-trees-by-module.md) | Exhaustive, per-module markdown reference (9,500+ lines) mapping all 818 routes to handlers and injected service calls. |
| [**inventory/api-route-call-tree-catalog.json**](file:///Users/apple/repos/VOX/review/api_explore_2/inventory/api-route-call-tree-catalog.json) | Complete machine-readable JSON inventory containing all routes, controllers, parameters, and call trees. |
| [**inventory/api-catalog.csv**](file:///Users/apple/repos/VOX/review/api_explore_2/inventory/api-catalog.csv) | CSV export for rapid spreadsheet filtering, sorting by module, and auditing. |
| [**09-CODE-WALKTHROUGH-BOOT-TO-HANDLER.md**](file:///Users/apple/repos/VOX/review/api_explore_2/09-CODE-WALKTHROUGH-BOOT-TO-HANDLER.md) | Line-anchored walkthrough: process start → `main.ts` → `AppModule` → request pipeline → four concrete handler traces, plus a recipe for tracing any route. |
| [**database_encryption.md**](file:///Users/apple/repos/VOX/review/api_explore_2/database_encryption.md) | PostgreSQL encryption: app-layer Vault Transit field encryption, encrypted-vs-plaintext inventory, `AuditLog`/`GlobalSetting`/WORM dual-write exceptions, disk/backup caveats, and verification steps. |

### Section B: Developer Troubleshooting & Runbooks
| Document | Purpose |
|---|---|
| [**04-TROUBLESHOOTING-ERRORS.md**](file:///Users/apple/repos/VOX/review/api_explore_2/04-TROUBLESHOOTING-ERRORS.md) | Complete dictionary of error codes (`DOMAIN.CONSENT_DENIED`, `PERSISTENCE.CONCURRENCY_CONFLICT`, etc.), 404-over-403 defense, and boot audit errors. |
| [**05-TROUBLESHOOTING-RUNBOOKS.md**](file:///Users/apple/repos/VOX/review/api_explore_2/05-TROUBLESHOOTING-RUNBOOKS.md) | Incident decision trees for 401/403 denials, 404 cross-tenant checks, 412/428 OCC conflicts, startup crashes, and stuck note generation. |
| [**06-OBSERVABILITY-AND-LOG-TRACING.md**](file:///Users/apple/repos/VOX/review/api_explore_2/06-OBSERVABILITY-AND-LOG-TRACING.md) | Request correlation ID propagation, production grep regex patterns, Prometheus metrics on `/metrics`, and OTel tracing. |
| [**07-DEPENDENCY-FAILURE-MODES.md**](file:///Users/apple/repos/VOX/review/api_explore_2/07-DEPENDENCY-FAILURE-MODES.md) | Failure modes and graceful degradation behaviors when Python STT/Text, Redis, Postgres, Vault, or Temporal fail. |
| [**08-LOCAL-DEBUGGING-PLAYBOOK.md**](file:///Users/apple/repos/VOX/review/api_explore_2/08-LOCAL-DEBUGGING-PLAYBOOK.md) | Practical developer guide for running the gateway locally, attaching VS Code/WebStorm debuggers, running targeted tests, and fixing contract drift. |

---

## Key Numbers at a Glance

| Metric | Count | Source File |
|---|---|---|
| **Total Routes** | **818** | [`route-manifest.json`](file:///Users/apple/repos/VOX/project-hope/apps/api/route-manifest.json) |
| **Total Controllers** | **148** | [`apps/api/src/modules/`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules) |
| **Feature Modules** | **77** | [`apps/api/src/modules/`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules) |
| **OpenAPI Documented Paths** | **607** | [`openapi.json`](file:///Users/apple/repos/VOX/project-hope/apps/api/openapi.json) |
| **Public Routes** | **62** | Routes with `@Public()` decorator |
| **OCC Version-Gated Routes** | **69** | Routes requiring `If-Match` header (ETag precondition) |
| **Downstream Python Services** | **6** | STT (8861), Text (8862), TTS (8865), NLP (8864), Guardrail, Harness |

---

## Key Architectural Rules to Remember

1. **Three Credential Classes:**
   - **Bearer JWT:** Clinicians & Admin Console users. Enforces CASL permissions and tenant tenancy.
   - **API Keys:** Server-to-server integrators. Declared via `@RequiredScopes(...)`. Strictly forbidden from admin routes (`@ForbidApiKey()`).
   - **Service Accounts:** Internal workers and Python services. Declared via `@RequiredSvcScopes(...)`.
2. **Fail-Fast Startup Audits:**
   - Boot audits in [`apps/api/src/bootstrap/`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/bootstrap) verify route permissions, consent decorators, and scope isolation before the app can start. If an audit fails, the process exits.
3. **Cross-Tenant Security (404-over-403):**
   - Accessing another tenant's resource always returns **404 Not Found** (never 403 Forbidden) to prevent tenant enumeration.
4. **Optimistic Concurrency Control (OCC):**
   - Mutating routes on versioned resources enforce `@RequiresIfMatch()`. The client must supply the strong `If-Match` ETag (matching entity `_version`), preventing lost updates and race conditions (returns 412 on conflict, 428 if header missing).
