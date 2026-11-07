# API Gateway B01a — Auth & Credentials

Companion explainer for `api-gateway-b01a-auth-credentials.html`.

## Scope
`B01a` covers core authn/credential modules: `auth`, `api-key`, `service-account` (~32 routes est.). `B01` is split into `B01a` (this batch) and `B01b` (user, rbac, security-policy, tenant-idp-config). `tenant-idp-config` is assigned to B01/B01b (excluded from B02).

Repository evidence pinned to `https://github.com/ArcaAI/project-hope.git` @ `8cb2e5e8e6bbddf5ee7c676782ebb5ad683c23a0`.

## Endpoint groups

| Group | Routes | Controller(s) | Service(s) | Downstream/data |
|---|---|---|---|---|
| Auth session | `POST /auth/login`, `logout`, `refresh`, `impersonate`, `revoke-impersonation`, `stream-ticket`; `GET /auth/me`; `POST /auth/register`, `/auth/register/verify` | `AuthController` (`apps/api/src/modules/auth/auth.controller.ts:98,184,470,536,611,847,968,1418`), `RegisterController` (`register.controller.ts:36,63,75`) | `AuthService` (`packages/applications/src/services/auth/auth.service.ts:16`) | Identity DB, token/session/stream-ticket state |
| SSO/SAML | `POST /auth/sso/start`, `GET /auth/sso/callback`, `GET /auth/sso/saml/:tenantKey/metadata`, `POST /auth/sso/saml/:tenantKey/start`, `POST /auth/sso/saml/:tenantKey/acs` | `AuthSsoController` (`auth-sso.controller.ts:35,70,86,107,118,131`) | `AuthService` / SSO integration | External IdP (OIDC/SAML), identity DB, session issuance |
| Admin API keys (9) | `GET/POST /admin/api-keys`, `GET scopes`, `GET/PATCH/DELETE /:id`, `POST /:id/revoke`, `POST /:id/rotate`, `GET /:id/usage` | `ApiKeyController` (`api-key.controller.ts:96,98`; routes through class) | `ApiKeyService` (`packages/applications/src/services/apiKey/apikey.service.ts:76`) | Identity DB; scope ceiling enforced in service (see controller AUTH-NOTE `:118`) |
| Service accounts (8+1) | `GET scopes`, `POST/GET /admin/service-accounts`, `GET/PATCH/DELETE /:id`, `POST /:id/rotate`; `POST /auth/service-token` | `ServiceAccountController` (`service-account.controller.ts:53`), `ServiceAccountTokenController` (`service-account-token.controller.ts:35,39`) | `ServiceAccountService` (`packages/applications/src/services/serviceAccount/service-account.service.ts:115`) | Identity DB; opaque token state (service-token notes revocation via Redis delete, `service-account-token.controller.ts:30`) |

## Example input/output (representative)
- **Login** (`POST /auth/login`): credentials/tenant context DTO -> session/JWT/refresh response or challenge (verify DTO).
- **Stream ticket** (`POST /auth/stream-ticket`): authenticated request -> scoped stream ticket for WS/stream access.
- **API key create** (`POST /admin/api-keys`): `CreateApiKeyRequest` -> `CreateApiKeyResponse {apiKey, rawKey}`; raw key returned once. Scope ceiling/refusal rules apply in service.
- **Service token exchange** (`POST /auth/service-token`): `ServiceAccountTokenRequest` (client id/secret) -> `ServiceAccountTokenResponse` with opaque bearer token (default ~15 min) via `X-Service-Account-Token`; unknown client/bad secret indistinguishable (401), rate limited.

## Validation / evidence
- Archify finalize: **pass** (`validate`, `deliver`, `check`, `browser-check`). Browser evidence pass; visual review not requested.
- Advisory: route-readability crossings/detours reported; gates pass.
- Limitations: grouped endpoint nodes for readability; example I/O summarized from controller/DTO contracts; token/session internals represented at architecture level (deepen with Redis/JWT/store implementation sources in follow-up if needed).
