# HOPE API Gateway — step-by-step debug guide (local dev)

**Purpose:** Developer procedure to stop/start local services, configure environment, start dependencies, debug HOPE API Gateway (`project-hope/apps/api`, `:8868`) in VS Code, and hit consultation-related endpoints with `curl` (including token generation).

**Scope:** HOPE API Gateway debugging. Consultation flow testing may also involve **streaming module** (`/api/v1/audio/transcription-jobs/*`, separate module) and downstream services (STT, etc.). ALaaS (`audio-stream-svc`, `web_ui`, `mmr_agent`) is optional for direct API debugging but required for full UI/mic consultation flow.

**Date:** 2026-11-15  
**Workspace:** `/Users/apple/repos/VOX`  
**Logs (workspace convention):** append terminal output to `review/ALaaSv3/deploy_console_20261114.log` when running commands for this workflow.

> **DEV ONLY / SECRETS:** Local `.env` files and token docs may contain secrets. Do **not** commit them or share tokens/credentials. See `review/ALaaSv3/hope-auth-tokens-dev.md` (dev-only).

---

## 0. Quick references

- **HOPE repo:** `/Users/apple/repos/VOX/project-hope`
- **ALaaS repo:** `/Users/apple/repos/VOX/ALaaSv3.0` (branch/work may be `sks_local_laptop`)
- **HOPE API:** `http://localhost:8868` (health: `GET /api/v1/health`)
- **HOPE STT:** `http://localhost:8861` (health: `GET /api/v1/health`)
- **VS Code debugger:** `project-hope/.vscode/launch.json` → **`Attach: HOPE API (9229)`** (inspector `127.0.0.1:9229`)
- **Consultation API + breakpoints:** `review/ALaaSv3/consultation-api-curl-and-breakpoints.md`
- **Auth/token details (dev):** `review/ALaaSv3/hope-auth-tokens-dev.md`
- **Helper script (token + curl):** `review/ALaaSv3/scripts/hope-debug-api.sh`

---

## 1. Stop all services (if any) and confirm

### 1.1 Stop HOPE app processes (API/STT/etc.)
Check listeners/processes, then stop HOPE dev processes:

```bash
# Inspect common HOPE ports (API 8868, STT 8861, inspector 9229, others as needed)
lsof -nP -iTCP:8868,8861,9229,8862,8864,8865 -sTCP:LISTEN || true
ps -ef | grep -E "pnpm api:dev|pnpm stt:dev|nest start|uvicorn stt.main:app|turbo run dev --filter=@arcaai/api" | grep -v grep || true

# Stop HOPE API/STT dev chains (adjust if you use other services)
pkill -f "uvicorn stt.main:app" || true
pkill -f "pnpm stt:dev" || true
pkill -f "nest start --debug 127.0.0.1:9229 --watch" || true
pkill -f "pnpm api:dev" || true
pkill -f "turbo run dev --filter=@arcaai/api" || true
sleep 2
```

### 1.2 Stop ALaaS app processes (optional, if running)
```bash
lsof -nP -iTCP:4000,5001,5173 -sTCP:LISTEN || true
ps -ef | grep -E "audio-stream-svc|mmr_agent|audio_agent.py|vite|npm run dev|npm run start:dev" | grep -v grep || true
# Stop specific PIDs/processes as needed (avoid killing unrelated projects)
```

### 1.3 Stop Docker containers (HOPE + ALaaS dev stores)
```bash
# HOPE infra (if running)
docker stop hope-temporal-ui hope-temporal-namespace hope-temporal hope-qdrant-init hope-minio-setup \
  hope-vault-init hope-temporal-admin-tools hope-redis hope-qdrant hope-minio hope-vault hope-reranker hope-postgres 2>/dev/null || true

# ALaaS dev stores (if running)
docker stop alaas-dev-redis alaas-dev-postgres 2>/dev/null || true
```
> If you prefer compose-managed teardown for HOPE: `cd /Users/apple/repos/VOX/project-hope && pnpm infra:dev:down` (when compose/config is available).

### 1.4 Confirm everything is stopped
```bash
# App ports should be free (or show only unrelated processes)
lsof -nP -iTCP:4000,5001,5173,5433,6380,8868,8861,9229 -sTCP:LISTEN || echo "No target listeners"

# Containers should be exited/stopped
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
```
**Expected:** no HOPE/ALaaS app listeners on target ports; no `hope-*`/`alaas-dev-*` containers in running state (unless intentionally left up).

---

## 2. Setup required environment variables

### 2.1 HOPE (`project-hope/.env.dev`) — verify before starting
Primary local env file: `project-hope/.env.dev` (do not commit). Ensure at least:

| Variable | Expected/local guidance | Notes |
|---|---|---|
| `DATABASE_URL` / PG vars | `postgresql://postgres:postgres@localhost:5432/hope` / `PG_HOST=localhost`, `PG_PORT=5432`, `PG_DATABASE=hope_main` (as configured) | HOPE Postgres container port mapping |
| `REDIS_HOST`/`REDIS_PORT`/`REDIS_URL` | `localhost:6379` | HOPE Redis |
| `JWT_SECRET_KEY` | present in `.env.dev` | Required by API auth and dev token generation tooling |
| `HF_HOME` | `/Users/apple/.cache/huggingface` (this laptop) | Needed for local `Systran/faster-whisper-small` STT model resolution/cache |
| Vault/AppRole vars | configured by local infra/setup (`VAULT_*`, AppRole creds, etc.) | `pnpm infra:dev:up` reconciles Vault/AppRole in dev flow; if auth/Vault errors occur, follow `review/ALaaSv3/debug-alaas-triggered-hope-api-gateway-procedure.md` |
| `NODE_ENV` / service ports | `development`, API default `8868`, STT `8861` (as configured) | Confirm per app/service config |

Quick checks:
```bash
cd /Users/apple/repos/VOX/project-hope
grep -n '^HF_HOME=' .env.dev
grep -n '^DATABASE_URL=' .env.dev
grep -n '^REDIS_HOST=\|^REDIS_PORT=' .env.dev
grep -n '^JWT_SECRET_KEY=' .env.dev | wc -l   # should be 1 (do not print secret)
```

> If `HF_HOME` points to a non-existent path (e.g. external volume), set it to `/Users/apple/.cache/huggingface` for this machine so STT can load the downloaded model.

### 2.2 ALaaS backend (`ALaaSv3.0/apps/audio-stream-svc/.env`) — for ALaaS/consultation integration tests
Verify local values (separate from HOPE stores):

| Variable | Local dev value (typical) |
|---|---|
| `PORT` | `4000` |
| `CLIENT_BASE_URL` / `FRONTEND_ORIGIN` | `http://localhost:5173` |
| `API_KEY` / `VITE_API_KEY` | same shared local dev key used by `web_ui` |
| `PG_HOST`/`PG_PORT`/`DATABASE_*` | `localhost:5433`, ALaaS DB/user/pass/db (e.g. `alaas` / `alaas_dev_only` / `alaas`) |
| `REDIS_HOST`/`REDIS_PORT` | `localhost:6380` |
| `HOPE_API_URL` | `http://localhost:8868` |
| `HOPE_SVC_CLIENT_ID` / `HOPE_SVC_CLIENT_SECRET` | local seeded HOPE service account (secret; see `review/ALaaSv3/hope-auth-tokens-dev.md`) |
| `HOPE_WORKING_TENANT_ID` | `50000000-0000-0000-0000-000000000001` (verify locally) |
| `ALAAS_HOPE_MAPPING` | `config/alaas-hope-mapping.json` |

### 2.3 ALaaS web UI (`ALaaSv3.0/apps/web_ui/.env`)
| Variable | Local dev value (typical) |
|---|---|
| `VITE_API_BASE_URL` | `http://localhost:4000` |
| `VITE_API_KEY` | same as `audio-stream-svc` `API_KEY` |
| `VITE_AUDIO_AGENT_BASE_URL` | `http://localhost:5001` |
| `VITE_SDK_API_ENDPOINT` / `VITE_SDK_WEBSOCKET_URL` | `http://localhost:8868` / `ws://localhost:8868` (if used) |

### 2.4 ALaaS mmr_agent (`ALaaSv3.0/apps/mmr_agent`)
- Use venv at `ALaaSv3.0/apps/mmr_agent/.venv` and local config `audio_agent_config.ini` (CORS/origin includes `http://localhost:5173`, port `5001`).
- See `review/ALaaSv3/mmr_agent-local-setup.md` for setup and known `bcrypt<4` workaround in local venv.

---

## 3. Start all dependencies (step by step)

### Step 3.1 — Start HOPE infrastructure (Docker + Vault/AppRole reconciliation)
```bash
LOG="/Users/apple/repos/VOX/review/ALaaSv3/deploy_console_20261114.log"
cd /Users/apple/repos/VOX/project-hope
pnpm infra:dev:up 2>&1 | tee -a "$LOG"
```
Wait until Postgres/Redis/Vault/MinIO/Qdrant/Temporal (and reranker if configured) are healthy/started.

**Confirm:**
```bash
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" | grep hope || true
```

### Step 3.2 — (Optional but recommended for consultation flow) Start ALaaS dev stores
```bash
LOG="/Users/apple/repos/VOX/review/ALaaSv3/deploy_console_20261114.log"
docker start alaas-dev-postgres alaas-dev-redis 2>&1 | tee -a "$LOG" || true
# If containers don't exist, create them (see review/ALaaSv3/start-alaas-locally-prerequisites-and-steps.md)
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" | grep alaas-dev || true
```
**Expected:** `alaas-dev-postgres` on `5433`, `alaas-dev-redis` on `6380`.

### Step 3.3 — Start HOPE STT (required for realtime transcription debugging)
In a separate terminal (or background, logged):
```bash
LOG="/Users/apple/repos/VOX/review/ALaaSv3/deploy_console_20261114.log"
cd /Users/apple/repos/VOX/project-hope
HF_HOME=/Users/apple/.cache/huggingface pnpm stt:dev 2>&1 | tee -a "$LOG"
```
**Confirm:**
```bash
lsof -nP -iTCP:8861 -sTCP:LISTEN
curl -sS http://localhost:8861/api/v1/health
```

### Step 3.4 — Start HOPE API Gateway (debug target)
In a separate terminal (or background, logged):
```bash
LOG="/Users/apple/repos/VOX/review/ALaaSv3/deploy_console_20261114.log"
cd /Users/apple/repos/VOX/project-hope
pnpm api:dev 2>&1 | tee -a "$LOG"
```
`api:dev` starts Nest with inspector (`--debug 127.0.0.1:9229`) and watch mode.

**Confirm:**
```bash
lsof -nP -iTCP:8868,9229 -sTCP:LISTEN
curl -sS http://localhost:8868/api/v1/health
```

### Step 3.5 — (Optional) Start additional HOPE services for full consultation/summary
Depending on scenario (summary generation, NLP/guardrail/harness/text/tts/workers), start required services (e.g. `pnpm text:dev`, `pnpm nlp:dev`, `pnpm guardrail:dev`, `pnpm stt:worker:dev`, `pnpm harness:dev`, `pnpm worker:dev`, etc.). Use `pnpm dev:doctor` / `stack:dev:doctor` in `project-hope` as guidance.

### Step 3.6 — (Optional) Start ALaaS apps + mmr_agent for end-to-end mic/consultation flow
```bash
LOG="/Users/apple/repos/VOX/review/ALaaSv3/deploy_console_20261114.log"

# mmr_agent (:5001)
cd /Users/apple/repos/VOX/ALaaSv3.0/apps/mmr_agent
source .venv/bin/activate
python src/audio_agent.py 2>&1 | tee -a "$LOG"

# audio-stream-svc (:4000) - separate terminal
cd /Users/apple/repos/VOX/ALaaSv3.0/apps/audio-stream-svc
npm run start:dev 2>&1 | tee -a "$LOG"

# web_ui (:5173) - separate terminal
cd /Users/apple/repos/VOX/ALaaSv3.0/apps/web_ui
npm run dev 2>&1 | tee -a "$LOG"
```
**Confirm:** `http://localhost:5001/health`, `/list_mics`, `http://localhost:4000/health`, `http://localhost:5173/`.

---

## 4. Breakpoints for consultation-related APIs (HOPE API Gateway)

Open `project-hope` in VS Code and set breakpoints in source. Line numbers are approximate (search by method/route name if drifted).

### 4.1 Consultation module (`apps/api/src/modules/consultation/consultation.controller.ts`, base `/api/v1/consultations`)

| API | Typical route | Controller method / breakpoint target | What to inspect |
|---|---|---|---|
| Open/get-or-create consultation | `POST /api/v1/consultations/open` | `open(...)` (~744) | request body (`patientId`, `context`, `clinicianUserId`, `departmentId`, `workflowDefinitionSlug`, `languageMode`), tenant/principal, acting clinician resolution, refusal codes |
| List selectable workflows | `GET /api/v1/consultations/workflows` | `listSelectableWorkflows()` (~804) | caller abilities/scopes, tenant-scoped workflow selection |
| Get consultation | `GET /api/v1/consultations/:id` | `getById(...)` (~817) | access checks, consultation state/version |
| Update consultation (OCC) | `PATCH /api/v1/consultations/:id` | `update(...)` (~959) | `If-Match`/expected version, `languageMode` validation, ownership checks |
| Start capture | `POST /api/v1/consultations/:id/start` | `start(...)` (~999) | lifecycle transition, `sessionId` binding, live doc/start side effects |
| Pause capture | `POST /api/v1/consultations/:id/pause` | `pause(...)` (~1017) | capture state transition |
| Stop capture | `POST /api/v1/consultations/:id/stop` | `stop(...)` (~1037) | finalize/waitForFinal behavior, snapshot/proposals inputs |
| Approve | `POST /api/v1/consultations/:id/approve` | `approve(...)` (~1090) | `If-Match`, processing/safety gates, attribution |
| Close | `POST /api/v1/consultations/:id/close` | `close(...)` (~1266) | `If-Match`, caller attribution (`clinicianUserId` rules for human vs service/API key) |
| Reopen | `POST /api/v1/consultations/:id/reopen` | `reopen(...)` (~1322) | `If-Match`, reason/permissions |
| Get context items | `GET /api/v1/consultations/:id/context-items` | `getContextItems(...)` (~1695) | context read path, tenant/consultation access |
| Add context item | `POST /api/v1/consultations/:id/context-items` | `addContext(...)` (~1678) | schema/version validation, payload, context service call |
| Generate summary (async) | `POST /api/v1/consultations/:id/.../generate*` (see controller) | `generateSummaryAsync` (~2355), `startHarnessSummaryJob` (~2378) | job creation, harness inputs, downstream dependencies |

**Related controllers (same consultation domain):**
- Attachments: `apps/api/src/modules/consultation/consultation-attachment.controller.ts`
- Feedback: `apps/api/src/modules/consultation/consultation-feedback.controller.ts`
- Consultation jobs: `apps/api/src/modules/consultation/consultation-job.controller.ts`

### 4.2 Streaming/STT session module used by consultation recording (separate module)
`apps/api/src/modules/streaming/transcription-job.controller.ts` (base `/api/v1/audio/transcription-jobs`)

| API | Route | Breakpoint target | What to inspect |
|---|---|---|---|
| Create realtime stream session | `POST /api/v1/audio/transcription-jobs/stream/session` | `createStreamSession(...)` (~963), payload assembly (~1081), `sessionService.createSession(...)` call (~1083) | consultation/agent resolution, resolved ASR model/spec, language/fallbacks, response/session ticket/ws info |
| Refresh stream ticket | `POST .../stream/session/:sessionId/refresh-ticket` | `refreshStreamTicket(...)` (~1328) | session binding/ownership, ticket issuance |
| Close stream session | `DELETE .../stream/session/:sessionId` | `closeStreamSession(...)` (~1303) | teardown path |
| Switch ASR engine | `POST .../switch-to-fallback`, `POST .../switch-to-primary` | ~1364, ~1408 | engine switch behavior/errors |
| Batch/list/job inspection | `POST /batch`, `GET /:id`, `GET /consultation/:consultationId`, etc. | corresponding methods in controller | job creation/status/limits/language modes |

**Step into application service (critical for STT failures):**
- `packages/applications/src/services/stt/streaming/streamingSession.service.ts` → `createSession(...)` (~340): inspect outbound request to STT, body/spec/model, timeout, HTTP status/response, parsing/error mapping.

**ASR resolution debugging (if wrong model/agent selected):**
- Search `packages/applications/src` for `AsrAgentResolverService` / `stt.asr_agent_resolved` and set breakpoints where agent/spec/fallback/language are resolved.

### 4.3 Downstream STT (if request reaches STT but fails there)
- `project-hope/apps/stt/src/stt/...` (realtime session creation, model/engine loading, faster-whisper). Run STT with debugger/debugpy config as needed (separate from Nest attach).

---

## 5. Start debugging in VS Code

1. **Start dependencies and HOPE API** as in Section 3 (ensure `:8868` and `:9229` are listening).
2. Open folder/workspace: **`/Users/apple/repos/VOX/project-hope`**.
3. Open **Run and Debug** (`Cmd+Shift+D`).
4. Select **`Attach: HOPE API (9229)`**.
5. Click **Start Debugging** (F5).
6. Set breakpoints in target files (Section 4). Confirm breakpoints bind (red/verified) to the running TS source/watch process.
7. Keep terminals/logs visible: API/STT output and `review/ALaaSv3/deploy_console_20261114.log` for correlation IDs/errors.

**Tips:**
- If breakpoint is unbound, ensure API was started via `pnpm api:dev` in `project-hope` (debug enabled) and source maps/dist are in sync (watch rebuild active).
- To debug a fresh launch under debugger control, stop current API and run with a VS Code launch/task config that starts Nest with inspect; otherwise use attach (recommended here).

---

## 6. Initiate requests to API Gateway using curl (with token generation)

### 6.1 Generate tokens (prerequisite API calls)

#### A. Human JWT via login (good for manual consultation endpoint testing)
```bash
HOPE_BASE_URL="http://localhost:8868"

# super_admin global login (local seeded dev default password: password123)
curl -sS -X POST "$HOPE_BASE_URL/api/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"username":"super_admin","password":"password123"}'
```
Extract `.token` (JWT) and use as `Authorization: Bearer <JWT>`.
- `tenantKey` is optional for `super_admin`; if used, it must be tenant **key** (e.g. `ARCAAI`), not UUID.

#### B. Issue a service account — obtain `clientId` + `clientSecret` (SUPER_ADMIN only)

The credentials are **created, not fetched**: no read endpoint returns the secret. Use the JWT from **A** (the caller must be a `SUPER_ADMIN`; API keys and other service accounts are refused). The `201` response contains `clientId` and `clientSecret`; the secret is returned **exactly once** — save it before continuing to C and before configuring ALaaS.

```bash
HOPE_BASE_URL="http://localhost:8868"
ADMIN_JWT="<JWT from A>"

curl -sS -X POST "$HOPE_BASE_URL/api/v1/admin/service-accounts" \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -H "X-Tenant-Id: 50000000-0000-0000-0000-000000000001" \
  -H 'Content-Type: application/json' \
  -d '{
    "displayName": "alaas-local-dev",
    "description": "Local ALaaS audio-stream-svc integration",
    "scopes": ["svc:consultation:session:read", "svc:consultation:session:write"],
    "tokenTtlSeconds": 900
  }'
```

Response fields to capture: `.clientId`, `.clientSecret` (also `.credentialsRef` / `.provisionAt` show where to store it). Copy them into `ALaaSv3.0/apps/audio-stream-svc/.env` as `HOPE_SVC_CLIENT_ID` / `HOPE_SVC_CLIENT_SECRET`, with `HOPE_WORKING_TENANT_ID` = `50000000-0000-0000-0000-000000000001`.

- **Do NOT put `tenantId` in the body.** The DTO validates it with `@IsUUID()` (RFC-4122); the seeded tenant id above has version/variant nibbles of `0` and fails with `400 tenantId must be a UUID`. Instead the `X-Tenant-Id` header elevates the SUPER_ADMIN's working tenant (it only checks the 8-4-4-4-12 hex shape), and omitting `tenantId` makes the account bind to that CLS tenant. Without the header the account lands on the SYSTEM tenant.
- `scopes` must be registered `svc:*` values — list them with `curl -sS "$HOPE_BASE_URL/api/v1/admin/service-accounts/scopes" -H "Authorization: Bearer $ADMIN_JWT"`; `admin:*` is never valid here.
- **Lost secret:** there is no read-back. Rotate with `POST "$HOPE_BASE_URL/api/v1/admin/service-accounts/<id>/rotate"` (same JWT); a new secret is returned once, with a short overlap where both old and new still work.
- Alternative on a freshly seeded DB: set `BOOTSTRAP_SERVICE_ACCOUNT_SECRET` (≥32 chars) before `pnpm db:seed`. The seeded client ID is `hope_svc_a4ca1a11ad3141b0c0de0001`. This is create-only — re-seeding will not reset an existing account's secret.

#### C. Service-account opaque token via exchange (for machine/service-scoped calls)
```bash
HOPE_BASE_URL="http://localhost:8868"
CLIENT_ID="<clientId from B>"
CLIENT_SECRET="<clientSecret from B>"

curl -sS -X POST "$HOPE_BASE_URL/api/v1/auth/service-token" \
  -H 'Content-Type: application/json' \
  -d "{\"clientId\":\"$CLIENT_ID\",\"clientSecret\":\"$CLIENT_SECRET\",\"workingTenantId\":\"50000000-0000-0000-0000-000000000001\"}" | jq
```
Extract `.accessToken` and use as `X-Service-Account-Token: <ACCESS_TOKEN>`.
- Use **double quotes** around `-d` so `$CLIENT_ID` / `$CLIENT_SECRET` expand. With single quotes the server receives the literal `$…` strings. Make sure the closing `}` is followed only by a newline or `|` — a stray character (e.g. `.`) makes the body invalid JSON (`HTTP.BAD_REQUEST`).
- Use the `clientId`/`clientSecret` issued in **B**. Once stored, local dev values can be re-read from `ALaaSv3.0/apps/audio-stream-svc/.env` (`HOPE_SVC_CLIENT_ID`, `HOPE_SVC_CLIENT_SECRET`, `HOPE_WORKING_TENANT_ID`). Do not paste secrets into shared docs/commits.

#### D. Dev JWT tool (alternative)
```bash
cd /Users/apple/repos/VOX/project-hope
JWT_SECRET_KEY="$(grep '^JWT_SECRET_KEY=' .env.dev | head -1 | cut -d= -f2-)" \
  pnpm -s gen:token -u super_admin -e 24h -p
```

### 6.2 Call consultation-related API endpoints (curl examples)

> Replace `<JWT>`, `<SERVICE_TOKEN>`, `<CONSULTATION_ID>`, `<VERSION>`, `<SESSION_ID>` as needed. Some endpoints require `If-Match: "<VERSION>"` (consultation/context `_version`) and specific scopes/abilities.

```bash
HOPE_BASE_URL="http://localhost:8868"
JWT="<JWT>"

# Health (no auth)
curl -sS "$HOPE_BASE_URL/api/v1/health"

# List selectable workflows (example; requires caller to be allowed to open consultations)
curl -sS "$HOPE_BASE_URL/api/v1/consultations/workflows" \
  -H "Authorization: Bearer $JWT"

# Open/get-or-create consultation (request shape may require clinician/context fields for service-account callers)
curl -sS -X POST "$HOPE_BASE_URL/api/v1/consultations/open" \
  -H "Authorization: Bearer $JWT" \
  -H 'Content-Type: application/json' \
  -d '{
    "patientId": "debug-patient-001",
    "context": {}
  }'

# Get consultation
curl -sS "$HOPE_BASE_URL/api/v1/consultations/<CONSULTATION_ID>" \
  -H "Authorization: Bearer $JWT"

# Start / stop capture lifecycle
curl -sS -X POST "$HOPE_BASE_URL/api/v1/consultations/<CONSULTATION_ID>/start" \
  -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' -d '{}'

curl -sS -X POST "$HOPE_BASE_URL/api/v1/consultations/<CONSULTATION_ID>/stop" \
  -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' -d '{"waitForFinal": true}'

# Streaming module (separate): create realtime stream session (used by consultation recording flow)
curl -sS -X POST "$HOPE_BASE_URL/api/v1/audio/transcription-jobs/stream/session" \
  -H "Authorization: Bearer $JWT" \
  -H 'Content-Type: application/json' \
  -d '{"consultationId":"<CONSULTATION_ID>","languageMode":"en"}'

# Streaming module: inspect/list
curl -sS "$HOPE_BASE_URL/api/v1/audio/transcription-jobs/language-modes" -H "Authorization: Bearer $JWT"
curl -sS "$HOPE_BASE_URL/api/v1/audio/transcription-jobs/consultation/<CONSULTATION_ID>" -H "Authorization: Bearer $JWT"
```

For full endpoint list/payload nuances and breakpoint mapping, use `review/ALaaSv3/consultation-api-curl-and-breakpoints.md` and generated OpenAPI if needed.

### 6.3 One-command/scripted flow (generate token + call API)
Use the helper script:
```bash
# Ensure executable (once)
chmod +x /Users/apple/repos/VOX/review/ALaaSv3/scripts/hope-debug-api.sh

# 1) Generate JWT (prints response; also prints JWT_TOKEN=... to stderr if jq available)
./review/ALaaSv3/scripts/hope-debug-api.sh login

# 2) Generate service token (reads HOPE_SVC_* from ALaaS .env by default)
./review/ALaaSv3/scripts/hope-debug-api.sh service-token

# 3) Login + call endpoint in one step
./review/ALaaSv3/scripts/hope-debug-api.sh call --mode login \
  --method GET --path /api/v1/consultations/workflows

# 4) Service-token + call endpoint in one step
./review/ALaaSv3/scripts/hope-debug-api.sh call --mode service-token \
  --method GET --path /api/v1/audio/transcription-jobs/language-modes

# 5) Open consultation (requires jq for robust JSON building)
JWT="<JWT>"
./review/ALaaSv3/scripts/hope-debug-api.sh open-consultation --jwt "$JWT" --patient-id "debug-patient-001"

# 6) Create stream session for a consultation
./review/ALaaSv3/scripts/hope-debug-api.sh stream-session --jwt "$JWT" --consultation-id "<CONSULTATION_ID>" --language-mode en
```

**Script notes:**
- Reads service-account creds from `ALaaSv3.0/apps/audio-stream-svc/.env` by default (`HOPE_SVC_CLIENT_ID/SECRET/WORKING_TENANT_ID`). Override with args or env vars.
- Uses `jq` when available for parsing/pretty output and JSON construction (recommended: `brew install jq`).
- Prints tokens/responses (dev-only). Redirect/capture carefully and do not commit outputs containing secrets.

---

## 7. Example end-to-end debug session (consultation stream-session issue)

1. **Stop & confirm** services (Section 1).
2. **Verify env**: `project-hope/.env.dev` has correct DB/Redis/Vault config and `HF_HOME=/Users/apple/.cache/huggingface` (Section 2).
3. **Start dependencies**: `pnpm infra:dev:up`, start HOPE STT, start HOPE API (Section 3).
4. **Attach debugger** in VS Code to `127.0.0.1:9229` (Section 5).
5. **Set breakpoints**:
   - `apps/api/src/modules/streaming/transcription-job.controller.ts` → `createStreamSession`
   - `packages/applications/src/services/stt/streaming/streamingSession.service.ts` → `createSession`
   - (optional) consultation `open/start` in `consultation.controller.ts`
6. **Get token** (`login` or `service-token`) (Section 6.1 / script).
7. **Open consultation** and/or **create stream session** with curl/script (Section 6.2/6.3).
8. **Inspect in debugger**: resolved ASR agent/model (`realtime-transcription` / `faster-whisper-small`), request payload to STT, STT response/error; correlate with `review/ALaaSv3/deploy_console_20261114.log`.
9. If STT is involved, verify `curl -sS http://localhost:8861/api/v1/health` and STT logs/model cache (`HF_HOME`).

---

## 8. Troubleshooting

- **401 Unauthorized / `Invalid credentials`:** wrong username/password, wrong token type, expired token, or wrong `tenantKey` format (use tenant key string, not UUID; seeded default password is `password123` in local dev seed).
- **403 Forbidden:** missing scopes/role/ability for endpoint.
- **409/412/428:** lifecycle conflicts, optimistic concurrency (`If-Match` missing/stale), or precondition violations.
- **400 with consultation refusal codes:** `CLINICIAN_REQUIRED`, `CONTEXT_SCHEMA_VIOLATION`, `DEPARTMENT_*`, `LANGUAGE_MODE_UNKNOWN`, etc. (see API response and consultation controller/service logic).
- **Stream session fails / “Transcription returned an invalid response”:** debug HOPE API `createStreamSession` → `StreamingSessionService.createSession` → STT `/health` and STT logs; confirm ASR model/config (`faster-whisper-small`) and `HF_HOME`.
- **API won’t start / Vault auth errors:** ensure `pnpm infra:dev:up` completed, Vault/AppRole reconciled, and env timeouts/config as per prior debug docs.
- **Breakpoints not hit:** confirm attached to PID listening on `9229`, correct route/method called, and code path matches (controller vs internal/other module).

---

## 9. Related documents

- `review/ALaaSv3/consultation-api-curl-and-breakpoints.md` — consultation + streaming curl and breakpoint map
- `review/ALaaSv3/hope-auth-tokens-dev.md` — dev auth/token discovery and examples (**sensitive/dev-only**)
- `review/ALaaSv3/start-alaas-locally-prerequisites-and-steps.md` — ALaaS local startup
- `review/ALaaSv3/mmr_agent-local-setup.md` — mmr_agent setup/troubleshooting
- `review/ALaaSv3/debug-alaas-triggered-hope-api-gateway-procedure.md` — prior ALaaS→HOPE debug notes
- `review/ALaaSv3/deploy_console_20261114.log` — terminal log for this debug session
