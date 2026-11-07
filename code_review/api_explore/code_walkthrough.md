# API Gateway Code Walkthrough

**Target:** `apps/api` (NestJS 11) in `/Users/apple/repos/VOX/project-hope`  
**Documentation:** `/Users/apple/repos/VOX/review/api_explore/`  
**Audience:** Developers new to the gateway  
**Time:** ~2.5 - 3.5 hours (can split over two sessions)

## Goal

This walkthrough is designed as a vertical slice - trace a real request end-to-end rather than reading every controller. Use the existing documentation as scaffolding and drop into the actual code to prove the points.

## Prep (Before the Walkthrough)

Before starting, review the following to set the context quickly:

| Item | Why | Where to use |
| :-- | :-- | :-- |
| System context + internals diagram | Set the mental model instantly | `diagrams/api-system-context.html` and `diagrams/api-gateway-internals-deep-dive.html` |
| Route oracle | Pick a concrete route to trace (don't pick a random file) | `apps/api/route-manifest.json`, `inventory/routes.json`, `inventory/routes-by-module.md` |
| Auth matrix | To answer "can I call this?" questions in real time | `docs/18-authorization-matrix.md` |
| E2E flows | Great for showing the "weird" parts (WS, OCC, internal callbacks) | `docs/25-end-to-end-data-flows.md` |

**Tip:** Pick *one* representative protected REST route (e.g. something from `consultation` or `user`) and *one* streaming route (e.g. `SttWsGateway`) to trace for the whole session. This will cover ~90% of the gateway's patterns.

## Walkthrough Sequence

| Block | Time | Goal | What to cover (docs + code) | Exercise for developers |
| :-- | :-- | :-- | :-- | :-- |
| **1) Big Picture** | 10-15m | "What is this gateway?" | `docs/12-api-gateway-overview.md`, `codebase/ARCHITECTURE.md`. Show the diagram and explain proxy vs orchestration. Call out that it has no Prisma/domain logic, only authz, tenancy, routing and cross-cutting concerns. | List 3 things the gateway does vs a downstream service based off of the diagram. |
| **2) Bootstrap & Fail-closed Rails** | 15-20m | How it starts safely | `apps/api/src/main.ts` (crash handlers -> loadEnv -> OTel -> create app -> global prefix -> pipes/interceptors -> boot audits -> listen). Walk through `docs/20-boot-time-audits.md`. Emphasize that it *refuses to boot* on route/permission/scope/WS ownership/CASL drift. | Find which audit would fail if a new controller was added without auth decorators. (Hint: `auditAdminRoutePermissions`). |
| **3) Request Lifecycle (The Spine)** | 25-35m | The most important block | `docs/04-request-lifecycle.md`, `apps/api/src/app.module.ts` (guard/interceptor/filter registration order). Walk the 8-guard pipeline in order and *why* order matters (e.g. throttling before auth, consent after auth, OCC guard last). Look at `ETagInterceptor` in `main.ts`. | Trace their picked REST route through the table. For each guard, answer "allow/deny/transform/context" and point to its class. |
| **4) AuthN/AuthZ** | 25-35m | Credentials, scopes, 404-over-403 | `docs/02-authentication.md`, `docs/03-authorization.md`, `docs/18-authorization-matrix.md`. Read `packages/applications/src/authorization/unified-auth.guard.ts` focusing on public opt-out, ambiguity rejection, API key vs JWT vs service account, and conjunctive scope checks. Show `@Public()`, `@RequiredScopes()`, and class-level `@CanManage`. | Take a route from the matrix and predict its authz behavior (API key allowed? needs scopes? would be 404 vs 403 on cross-tenant?). Then verify against `route-manifest.json`. |
| **5) Tenancy, Consent, OCC** | 15-20m | The footguns | `docs/07-cross-cutting-concerns.md`, `apps/api/src/guards/patient-consent.guard.ts`, `apps/api/src/guards/origin-tenant-binding.guard.ts`, `apps/api/src/guards/tenant-lock.guard.ts`. Show CLS usage, tenant scope extension, `TenantOwnedResourceSseGuard`, and the ETag/If-Match flow (`@RequiresIfMatch` + `OptimisticConcurrencyException` -> 412). | For a PUT that should be versioned, trace header -> interceptor -> guard -> repository call and when 412 vs 428 vs 409 would fire. |
| **6) Routing to Modules & Downstreams** | 25-35m | Find code for a real endpoint | `docs/13-api-catalog.md`, `docs/14-gateway-to-downstream-overview.md`, `docs/15-gateway-to-downstream-per-controller.md`. Pick the concrete route, go to its controller in `apps/api/src/modules/*/*.controller.ts`, see if it's a direct handler or proxied (e.g. `text-proxy.controller.ts`, `speech-proxy.controller.ts`), and see how it calls downstreams/internal clients. | Live search: `grep -rn "Method('...')" apps/api/src/modules/<module>` or use the route from inventory to jump to the controller method. Have them map route -> controller -> service/client. |
| **7) Advanced Surfaces (WS, Internal, Errors, Jobs)** | 20-25m | The non-REST parts | `docs/19-websocket-gateways.md`, `docs/21-internal-service-auth.md`, `docs/24-error-handling-and-downstream-failures.md`, `docs/22-async-queues-and-jobs.md`. Look at `stt-ws.gateway.ts` (auth via stream tickets/JWT), `internal-service-token.guard.ts`, `HttpExceptionEnvelopeFilter`, and a BullMQ processor. | Compare REST guard pipeline vs WS auth (when guards run, when tickets are used, ownership checks). Show how a downstream failure is normalized by filters/interceptors. |
| **8) Guided End-to-End Trace (Capstone)** | 30-45m | Put it all together | Re-trace the picked REST route *and* the WS flow using all of the above. Use `route-manifest.json` to read its exact flags (`public`, `scopes`, `apiKeyAllowed`, `requiresIfMatch`, etc.), step through each guard, hit the controller, note downstream calls, and predict the error cases. | Have the developers do this themselves with a *different* route (assigned) and present: guards passed/blocked, authz reason, tenancy checks, and what would make it 404-over-403 vs 401/403. |

**Total:** ~2.5 - 3.5 hours for a single sitting, or split over two sessions. The capstone (block 8) is the most valuable and should not be skipped.

## Tips to Make it Effective

- **Diagram first, code second.** Spend 3 minutes on the HTML diagram before opening `main.ts`. It's clickable and has source references which pairs extremely well with this walkthrough.
- **Use the oracle.** Don't guess authz, pull it from `route-manifest.json` for the traced route. The boot audits exist specifically to keep this manifest in sync, so calling that out is a great teaching point.
- **Show the "deny by default" philosophy.** The order of `UnifiedAuthGuard` (#3) and the fact that almost everything is gated, plus all of the fail-closed audits, is the core security story of this gateway.
- **Don't read packages deeply.** Reference `@arcaai/applications` and `@arcaai/domains` for *contracts* (decorators, enums) but keep the walkthrough in `apps/api` unless there's a specific guard/service that lives there (e.g. `UnifiedAuthGuard` is in packages but critical to show).
- **Use tests as breadcrumbs.** If you're stuck on a route's behavior, `grep` for it in `apps/api/tests` or look at its coverage in `docs/06a-COVERAGE-BY-AREA.md`. The `inventory/` folder was built specifically to do this cross-referencing.
- **Call out the sharp edges.** Explicitly mention: 404-over-403, API-key vs service-account split, stream tickets for WS, OCC warn-only audit, unused `base-proxy.controller.ts`, and that e2e needs live infra (from `apps/api/README.md`). These are the things that will trip up new devs.
- **Timebox module diving.** If someone asks "what does this entire controller do", answer by tracing one method through the pipeline rather than reading every method.

## Suggested Reading Order for Self-Study (After Walkthrough)

For deeper self-study after the session, read in this order:

1. `00-README.md` 
2. `01-getting-started.md`
3. `04-request-lifecycle.md`
4. `02-authentication.md`
5. `03-authorization.md`
6. `12-api-gateway-overview.md`
7. `18-authorization-matrix.md`
8. `25-end-to-end-data-flows.md`
9. `24-error-handling-and-downstream-failures.md`

This mirrors the sequence above and makes full use of the documentation already completed.
