# HOPE API auth tokens — how to find/generate (LOCAL DEV ONLY)

**Date:** 2026-11-15 (Asia/Calcutta)  
**Environment:** local development (`project-hope` API on `http://localhost:8868`, local DB/infra running)  
**⚠️ DEV-ONLY / SENSITIVE:** This document contains **real local-dev credentials/tokens** discovered/exchanged during debugging. **Do not commit, share, or use outside this local dev environment.** Rotate/reseed secrets if exposed.

---

## 1. Token types and where to use them

| Token type | How obtained | Use in requests | Typical use |
|---|---|---|---|
| **Human JWT (access token)** | `POST /api/v1/auth/login` or `pnpm gen:token` (dev tool) | `Authorization: Bearer <JWT>` | Consultation/business APIs as an authenticated user (subject to roles/abilities/tenant context) |
| **Service-account opaque token** | `POST /api/v1/auth/service-token` (exchange `clientId` + `clientSecret`) | `X-Service-Account-Token: <accessToken>` (per service-account token controller) | Machine/service-account scoped API calls (scopes + working tenant bound in token) |
| **API key** | `pnpm gen:api-key` (tool) / admin flows | Depends on endpoint auth guard (check OpenAPI/decorators) | Endpoints that accept API-key auth (some endpoints forbid it) |
| **Refresh token** | Returned by login | `POST /api/v1/auth/refresh` (body/contract per API) | Obtain new access token without re-login |
| **Browser/devtools token** | Capture from local UI network/storage | Same as token type captured | Quick manual debugging |

Related procedure doc (consultation curl + breakpoints): `review/ALaaSv3/consultation-api-curl-and-breakpoints.md`

---

## 2. How to find credentials/sources locally (dev)

### 2.1 ALaaS → HOPE service-account credentials (used by local ALaaS)
**File:** `ALaaSv3.0/apps/audio-stream-svc/.env` (local, do not commit)
- `HOPE_API_URL=http://localhost:8868`
- `HOPE_SVC_CLIENT_ID=...`
- `HOPE_SVC_CLIENT_SECRET=...` *(secret)*
- `HOPE_WORKING_TENANT_ID=...`

These match the seeded dev fixture in HOPE DB/seed constants (`project-hope/packages/database/src/prisma/db_main/seed/00-constants.ts`: `SEED_SERVICE_ACCOUNT_CLIENT_IDS.ARCAAI_ADMIN`, `SEED_SERVICE_ACCOUNT_DEV_SECRETS.ARCAAI_ADMIN`, tenant commonly `50000000-0000-0000-0000-000000000001`).

**Values found locally (DEV ONLY):**
- `HOPE_API_URL=http://localhost:8868`
- `HOPE_SVC_CLIENT_ID=hope_svc_a4ca1a11ad3141b0c0de0001`
- `HOPE_SVC_CLIENT_SECRET=hope_svcsec_test_4f0b1d7a2e6c48b39a15d0c7e2f83b6104d9a7c5e18f2b6039d4c8a71e0b5f2d`
- `HOPE_WORKING_TENANT_ID=50000000-0000-0000-0000-000000000001`

### 2.2 HOPE JWT signing secret for dev token tool
`project-hope` dev token generator (`pnpm gen:token`) requires `JWT_SECRET_KEY` in environment. In this local setup it is present in `project-hope/.env.dev` as `JWT_SECRET_KEY=...` (secret; do not commit/share). The tool run below was executed with `JWT_SECRET_KEY` sourced from `.env.dev`.

### 2.3 Seeded dev users (discovered)
Command executed in `project-hope`:
```bash
pnpm -s gen:token --list
```
**Result:**
- `super_admin`
- `admin`
- `user`

---

## 3. Executed token discovery/generation (2026-11-15)

Terminal output logged to: `review/ALaaSv3/deploy_console_20261114.log`

### 3.1 Service-account token exchange (executed successfully)
**Command executed:**
```bash
curl -sS -X POST 'http://localhost:8868/api/v1/auth/service-token' \
  -H 'Content-Type: application/json' \
  -d '{
    "clientId":"hope_svc_a4ca1a11ad3141b0c0de0001",
    "clientSecret":"hope_svcsec_test_4f0b1d7a2e6c48b39a15d0c7e2f83b6104d9a7c5e18f2b6039d4c8a71e0b5f2d",
    "workingTenantId":"50000000-0000-0000-0000-000000000001"
  }'
```

**Response (DEV ONLY, short-lived opaque token; TTL ~900s at issue time):**
```json
{
  "accessToken": "WLeSDM7xlrsdrnfli1TNQAqyaXTUJh54T2W5Pr1BSaU",
  "tokenType": "Bearer",
  "expiresIn": 900,
  "scopes": [
    "svc:admin:user:read","svc:admin:user:write","svc:admin:apikey:read","svc:admin:apikey:write",
    "svc:admin:role:read","svc:admin:tenant:read","svc:admin:audit:read","svc:admin:department:manage",
    "svc:admin:agent-promotion:manage","svc:admin:prompt-template:manage","svc:admin:consultation-context-schema:manage",
    "svc:admin:document-template:manage","svc:admin:dna-writing-style:manage","svc:admin:knowledge:manage",
    "svc:admin:consultation-admin:manage","svc:admin:harness:manage","svc:admin:agentic:manage",
    "svc:admin:agent-trajectory:read","svc:stt:transcription:write","svc:consultation:report:write",
    "svc:admin:transcription-job:read","svc:admin:ai-provider:manage","svc:admin:settings:manage",
    "svc:admin:nlp-task-instructions:manage","svc:admin:allowed-origin:manage","svc:admin:tenant-frontend-config:manage",
    "svc:admin:tenant-idp-config:manage","svc:admin:mcp-server:manage","svc:admin:notification:manage",
    "svc:admin:resource-subscription:manage","svc:admin:service-release:manage","svc:admin:workflow-definition:manage",
    "svc:admin:workflow-node:read","svc:admin:workflow-run:read","svc:admin:workflow-test-fixture:manage",
    "svc:agent:definition:read","svc:agent:invocation:write","svc:workflow:definition:read","svc:workflow:run:read",
    "svc:workflow:run:write","svc:consultation:session:write","svc:consultation:session:read","svc:consultation:report:read",
    "svc:tenant:context-schema:read","svc:workflows:execute","svc:dna-writing-style:ingest"
  ],
  "tenantId": "50000000-0000-0000-0000-000000000001"
}
```

**Usage (service-account token):**
```bash
curl -sS 'http://localhost:8868/api/v1/<endpoint>' \
  -H 'X-Service-Account-Token: WLeSDM7xlrsdrnfli1TNQAqyaXTUJh54T2W5Pr1BSaU'
```
> Note: token is short-lived; re-exchange when expired.

### 3.2 Human dev JWT (super_admin) generated via tool (executed successfully)
**Command executed (with `JWT_SECRET_KEY` sourced from `project-hope/.env.dev`):**
```bash
cd /Users/apple/repos/VOX/project-hope
JWT_SECRET_KEY="$(grep '^JWT_SECRET_KEY=' .env.dev | head -1 | cut -d= -f2-)" pnpm -s gen:token -u super_admin -e 24h -p
```

**Generated JWT (DEV ONLY):**
```text
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI3MDAwMDAwMC0wMDAwLTAwMDAtMDAwMC0wMDAwMDAwMDAwMDEiLCJ1c2VybmFtZSI6InN1cGVyX2FkbWluIiwiZW1haWwiOiJzdXBlci5hZG1pbkBleGFtcGxlLmNvbSIsImZpcnN0TmFtZSI6IlN1cGVyIiwibGFzdE5hbWUiOiJBZG1pbiIsInRlbmFudElkIjpudWxsLCJyb2xlcyI6WyJTVVBFUl9BRE1JTiJdLCJpc1NlcnZpY2VBY2NvdW50IjpmYWxzZSwiaWF0IjoxNzk0NzM3ODAwLCJleHAiOjE3OTQ4MjQyMDB9.f5oFJKrAwkBgiV9aAulPLTHVzFABz1aLyv-3XB6CzE4
```

**Decoded payload (as printed):**
```json
{
  "sub": "70000000-0000-0000-0000-000000000001",
  "username": "super_admin",
  "email": "super.admin@example.com",
  "firstName": "Super",
  "lastName": "Admin",
  "tenantId": null,
  "roles": ["SUPER_ADMIN"],
  "isServiceAccount": false,
  "iat": 1794737800,
  "exp": 1794824200
}
```
- Summary from tool: user `super_admin`, global (no tenant), expires `16/11/2026, 3:46:40 pm` (local tool output).

**Usage (JWT):**
```bash
curl -sS 'http://localhost:8868/api/v1/<endpoint>' \
  -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI3MDAwMDAwMC0wMDAwLTAwMDAtMDAwMC0wMDAwMDAwMDAwMDEiLCJ1c2VybmFtZSI6InN1cGVyX2FkbWluIiwiZW1haWwiOiJzdXBlci5hZG1pbkBleGFtcGxlLmNvbSIsImZpcnN0TmFtZSI6IlN1cGVyIiwibGFzdE5hbWUiOiJBZG1pbiIsInRlbmFudElkIjpudWxsLCJyb2xlcyI6WyJTVVBFUl9BRE1JTiJdLCJpc1NlcnZpY2VBY2NvdW50IjpmYWxzZSwiaWF0IjoxNzk0NzM3ODAwLCJleHAiOjE3OTQ4MjQyMDB9.f5oFJKrAwkBgiV9aAulPLTHVzFABz1aLyv-3XB6CzE4'
```

### 3.3 Initial tool attempt (failed, then fixed)
Running `pnpm -s gen:token -u super_admin -e 24h -p` without `JWT_SECRET_KEY` in the tool process environment failed with:
- `❌ Error: JWT_SECRET_KEY not found in environment variables. Please ensure your .env file in the workspace root contains JWT_SECRET_KEY.`
Fix: run with `JWT_SECRET_KEY` sourced from `project-hope/.env.dev` (as shown in 3.2).

---

## 4. Other ways to obtain tokens (not all executed)

### 4.1 Login endpoint (human JWT)
`POST /api/v1/auth/login` with JSON `{ "username", "password", "tenantKey"? }` returns `{ token, refreshToken, user, ... }`.
- Source: `project-hope/apps/api/src/modules/auth/auth.controller.ts`, DTOs `login.request.ts` / `login.response.ts`.
- **Seeded dev default password (local dev DB/seed):** `password123` (see `project-hope/packages/database/src/prisma/db_main/seed/91-user.ts`, default hash applied when seeding users; passwords are not reset on re-seed update path).
- **`tenantKey` semantics:** this is the tenant **key** string (e.g. `arcaai`), **not** the tenant UUID. For `super_admin`, `tenantKey` is optional (global access when omitted; can be provided to scope to a tenant). For non-super-admin users, `tenantKey` is required and the user must have active role+department membership in that tenant.

**Working example (executed 2026-11-15, super_admin/global):**
```bash
curl -sS -X POST 'http://localhost:8868/api/v1/auth/login' \
  -H 'Content-Type: application/json' \
  -d '{"username":"super_admin","password":"password123"}'
```
Response included `token` (JWT), `refreshToken`, and user info (`roles: ["SUPER_ADMIN"]`, `tenantId: ""`).

**Common 401 causes:** wrong password, wrong username, or invalid/mismatched `tenantKey`/tenant access. Example failure: passing tenant UUID in `tenantKey` and/or wrong password returns `401 {"message":"Invalid credentials",...}`.

### 4.2 API key generation
```bash
cd /Users/apple/repos/VOX/project-hope
pnpm gen:api-key --help
```
Use only for endpoints that accept API-key auth.

### 4.3 Browser/devtools
Log into local UI (HOPE admin console / ALaaS web UI), inspect Network request headers or app storage for `Authorization: Bearer ...` / token values.

---

## 5. Security notes
- Tokens above are **local-dev artifacts** captured on 2026-11-15; the service-account token is short-lived and may already be expired when read later. JWT/login tokens also expire; regenerate/exchange as needed.
- Do **not** commit this file or any `.env`/secret-bearing files. Prefer storing tokens only in memory/clipboard during debugging.
- If secrets/tokens are exposed beyond local machine, rotate service-account secrets and reseed/reconfigure dev credentials as appropriate.
- Successful login test (2026-11-15): `super_admin` / `password123` without `tenantKey` returned a valid JWT+refresh token. Passing tenant UUID as `tenantKey` (instead of tenant key string) and/or wrong password yields `401 Invalid credentials`.
