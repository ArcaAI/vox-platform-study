# API Gateway B01b2 — RBAC, Security Policy, Tenant IdP

Companion explainer for `api-gateway-b01b2-rbac-security-idp.html`.

## Scope
`B01b2` completes `B01` (auth/identity): `rbac` (~22 routes est.), `security-policy` (2), `tenant-idp-config` (8). Repository @ `8cb2e5e8e6bbddf5ee7c676782ebb5ad683c23a0`.

## Endpoint groups

| Group | Routes | Controllers | Services | Downstream |
|---|---|---|---|---|
| RBAC | `/admin/rbac/roles` CRUD/clone/members/policy links; `/admin/rbac/policies` CRUD/validate; `/users/me/permission-checks` POST; `/users/:id/permission-checks` POST/bulk | `RolesController` (`rbac/roles.controller.ts:75`), `PoliciesController` (`rbac/policies.controller.ts:31`), `PermissionCheck` controllers (`rbac/permission-check.controller.ts:24,86`) | `RbacRoleService` (`packages/applications/.../rbac/role/role.service.ts:72`), `PolicyService` (`.../rbac/policy/policy.service.ts:59`) | AuthZ/config data store |
| Security policy | `GET/PUT /admin/security/policy` | `SecurityPolicyController` (`security-policy/security-policy.controller.ts:30`) | `SecurityPolicyService` (`packages/applications/.../security/secretPolicy/security-policy.service.ts:46`) | Policy/config data store |
| Tenant IdP config | CRUD + `POST :id/test`, `PUT :id/directory-credentials`, `POST :id/sync` (`/admin/tenant-idp-config`) | `TenantIdpConfigAdminController` (`tenant-idp-config/tenant-idp-config-admin.controller.ts:30`) | `TenantIdpConfigService` (`packages/applications/.../tenant-idp-config.service.ts:49`) | Config store; external IdP/directory for test/sync |

## Example input/output (representative)
- RBAC role/policy: create/update DTOs -> role/policy responses; clone creates derived role; permission-check returns allow/deny (or bulk results).
- Security policy: GET effective policy; PUT policy payload -> updated policy.
- Tenant IdP config: IdP config/credentials DTOs -> config responses; test/sync return operation results.

## Validation / limitations
- Archify finalize: **pass** (`validate/deliver/check/browser-check`). Browser evidence pass; visual review not requested. Advisory detours only.
- Limitations: grouped endpoint nodes; example I/O summarized from route contracts; CASL internals and directory sync protocols are implementation-specific — verify for strict contracts.
