# API Gateway B08a — Billing, Usage & Misc

Companion explainer for `api-gateway-b08a-billing-admin-misc.html`.

## Scope
`B08a` (part of B08-billing-internal-misc, reconciled): `billing` (13/3), `admin-usage` (6/2), `governed-prompt` (1/1), `pstudio` (1/2) — **21 routes / 8 controllers**. Repo @ `8cb2e5e8e6bbddf5ee7c676782ebb5ad683c23a0`.

## Endpoint groups

| Group | Modules/routes | Controllers | Key services | Downstream |
|---|---|---|---|---|
| Billing & admin usage | admin invoices/usage + `/tenants/me` billing/usage | `BillingAdminController` (`billing-admin.controller.ts:40`), `MyBillingController` (`my-billing.controller.ts:34`), `AdminUsageController` (`admin-usage.controller.ts:41`), `MyUsageController` (`my-usage.controller.ts:26`) | `BillingService` (`billing.service.ts:117`); admin-usage service wiring verify | Billing/usage data |
| Governed prompt internal | `POST /internal/governed-prompts` (service-to-service) | `GovernedPromptInternalController` (`governed-prompt-internal.controller.ts:80,81`) | `GovernedPromptRegistryService` (`governed-prompt-registry.service.ts:161`) | Governed prompt registry/state |
| Prisma Studio admin | `/admin/pstudio`, `/admin/pstudio/status` | `PrismaStudioController` (`pstudio.controller.ts:32`), `PrismaStudioStatusController` (`pstudio-status.controller.ts:30`) | `PrismaStudioService` (`pstudio.service.ts:30`) | Admin DB/runtime target (sensitive) |

## Example input/output (representative)
- **Billing/usage:** admin invoice/usage and tenant self billing/usage requests -> billing/invoice/usage responses. Verify exact DTOs and billing provider integration.
- **Governed prompt internal:** verification request payload -> verification/registry response (service-to-service; verify DTO/idempotency/security).
- **Prisma Studio:** admin status/start/proxy requests -> studio status/proxy behavior. **Sensitive admin-only DB tooling**; verify RBAC, environment restrictions, and audit controls.

## Security / validation / limitations
- **Governed prompt internal:** `@Public`/`@ApiExcludeController` with `HarnessServiceTokenGuard` + `InternalTenantLockGuard` (evidenced).
- Archify finalize **pass** (`validate/deliver/check/browser-check`). Browser evidence pass; visual review not requested.
- Limitations: grouped endpoint nodes (21 routes/8 controllers); admin-usage service implementation path not separately verified; reconcile exact route/DTO contracts, RBAC, and operational safeguards with OpenAPI/implementation.
