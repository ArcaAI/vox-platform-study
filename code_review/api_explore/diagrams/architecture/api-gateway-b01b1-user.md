# API Gateway B01b1 — User Management

Companion explainer for `api-gateway-b01b1-user.html`.

## Scope
`B01b1` covers `user` module (~33 routes est.), part of B01 identity split (`B01b1` user, `B01b2` rbac/security-policy/tenant-idp-config).

Repository: `https://github.com/ArcaAI/project-hope.git` @ `8cb2e5e8e6bbddf5ee7c676782ebb5ad683c23a0`.

## Endpoint groups

| Group | Example routes | Controllers | Services |
|---|---|---|---|
| Admin user | `/admin/users` export/bulk-actions/profile/settings/reset-password/roles/departments/voice-profiles sub-resources | `UserController` (`user.controller.ts:88`), `UserDepartmentsController` (`controllers/user-departments.controller.ts:34`) | `UserService` (`packages/applications/.../user.service.ts:47`), `UserDepartmentService` `:36`, `UserRoleAssignmentService` `:46` |
| Self-service `/users/me*` + role view | `/users/me/preferences`, `/users/me/settings[/:namespace/:key]`, `/users/me/departments`, `/users/:id/roles` | `UserPreferencesController` (`user-preferences.controller.ts:29`), `UserSettingsController` (`user-settings.controller.ts:40`), `UserDepartmentsMeController` (`user-departments-me.controller.ts:34`), `UserRolesController` (`user-roles.controller.ts:41`) | `UserSettingsService` (`userSettings.service.ts:14`), `UserDepartmentService`, `UserRoleAssignmentService` |
| Password/reset | `POST forgot-password`, `POST /users/password-reset/complete` | `ForgotPasswordController` (`forgot-password.controller.ts:22`), `PasswordResetController` (`password-reset.controller.ts:16`) | `UserService` / reset flow services (verify implementation) |

## Example input/output (representative)
- Admin profile/settings: PATCH user/profile/settings DTOs -> user/profile/settings responses.
- Self-service settings: GET/PATCH `/users/me/settings` or `/:namespace/:key` -> effective setting values.
- Department/role assignments: POST/PATCH/DELETE assignment payloads -> assignment records.
- Password reset: forgot-password accepts identifier/email DTO; reset complete accepts token/new password DTO (verify exact contracts and side effects).

## Validation / limitations
- Archify finalize: **pass** (`validate/deliver/check/browser-check`). Browser evidence pass; visual review not requested. Advisory crossings/detours reported.
- Limitations: grouped endpoint nodes; route-level details/examples in cards; `eg_me` source refs trimmed to 3 due to schema `maxItems` (UserRolesController still represented in sublabel/card/context). Downstream shown as identity/user data store; password-reset infrastructure may include additional token/email components — verify implementation. Reconcile route count with catalog/inventory for strict 1:1 coverage.
