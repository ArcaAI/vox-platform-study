# HOPE API Gateway debug — corrected API-only procedure after the 2026-11-15 fresh pull

**Date:** 2026-11-16
**Applies to:** `project-hope` HEAD `b1929a98f` (pulled 2026-11-15/16)
**Supersedes for API work:** `debug-hope-api-gateway-step-by-step.md` (commands in §3.5, §4, §5, §6 no longer match this version)
**Scope:** HOPE API Gateway debugging only. ALaaS client (`audio-stream-svc`, `web_ui`, `mmr_agent`) is deliberately out of scope.
**Constraint:** No edits to the `project-hope` repo (all fixes below are build/runtime steps or files under `review/alaaSv3/`).

**Logs for this investigation:**
- Agent console: `review/alaaSv3/agent_log/20261116-api-debug-investigation.md`
- Investigation console: `review/alaaSv3/investigate_console_20261116.log`

---

## 0. TL;DR — what broke and the one-line fix for each

| # | Symptom | Cause | Fix |
|---|---|---|---|
| 1 | `pnpm api:dev` never starts; **366 × `error TS`** (`@arcaai/applications has no exported member …`) | Workspace package `dist/` folders are stale after the pull; API source now expects new exports | `pnpm build:packages` **before** `pnpm api:dev` |
| 2 | Tenant-scoped curls return `400 Tenant ID is required` | `super_admin` login without `tenantKey` now mints a token with `tenantId: ""` | Add `"tenantKey": "ARCAAI"` to the login body (or `--tenant-key ARCAAI` for the script) |
| 3 | `POST /consultations/open` returns generic `404` even with a tenant-scoped `super_admin` token | `open` now requires a **clinician** caller; super-admin is not a clinician in the tenant | Log in as `arcaai_doctor` / `password123` / `tenantKey: ARCAAI` (or use a service token with `clinicianUserId`) |
| 4 | `GET /audio/transcription-jobs/language-modes` → `400 P2022` (`t0.limitedToPlans does not exist`) | Local `hope` DB schema is stale; also missing `providerType`, `isDefault` | `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION=1 RUN_SEED=all NODE_ENV=development pnpm db:all` (force-reset + reseed) |
| 5 | VS Code **`Attach: HOPE API (9229)`** missing | `.vscode/launch.json` is tracked and was reverted by the pull (now only a `Text` debugpy config) | Open the repo-free workspace file `review/alaaSv3/hope-api-attach.code-workspace` (provided) |
| 6 | `pnpm dev:doctor` → command not found | Script renamed | Use `pnpm stack:dev:doctor` |
| 7 | All §4 breakpoint line numbers stale; `@Post('open')` / `@Get(':id')` not found by grep | Routes are now declared through a custom `@ApiEndpoint({ method, path })` decorator; files grew | Use the refreshed breakpoint map in §5 below |

> Steps 1 and 4 assume a fresh pull when local `dist/` and the local `hope` DB were built from the previous version. If you always run `pnpm setup:dev` after a pull, they are already covered.

---

## 1. Preconditions (verified on 2026-11-16)

- Docker infra already up: `hope-postgres :5432`, `hope-redis :6379`, `hope-vault :8200`, MinIO, Qdrant, Temporal, reranker.
- STT already running on `:8861` (`python3.1`, started before this session) and healthy.
- `.env.dev` survived the pull (untracked) with `HF_HOME=/Users/apple/.cache/huggingface`, DB/Redis/Vault/JWT keys present.
- Ports `:8868` (API) and `:9229` (inspector) free before start.

Confirm quickly:

```bash
lsof -nP -iTCP:8868,8861,9229,8200 -sTCP:LISTEN || true
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" | grep hope
cd /Users/apple/repos/VOX/project-hope
grep -n '^HF_HOME=' .env.dev
```

---

## 2. Corrected startup order (API only)

Run in `project-hope`. Log to `review/alaaSv3/investigate_console_20261116.log` with `2>&1 | tee -a "$LOG"`.

```bash
LOG="/Users/apple/repos/VOX/review/alaaSv3/investigate_console_20261116.log"
cd /Users/apple/repos/VOX/project-hope

# 2.1 (NEW, required after a pull) rebuild workspace packages — fixes the 366 TS errors
pnpm build:packages 2>&1 | tee -a "$LOG"     # turbo: 18/18 tasks; ~2 min

# 2.2 (NEW, required if local DB predates the pull) reset + reseed local dev DB
#     DESTRUCTIVE: wipes the local `hope` DB. prisma db push refuses without it,
#     and migrations are unusable (this DB has no _prisma_migrations history).
PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION=1 RUN_SEED=all NODE_ENV=development \
  pnpm db:all 2>&1 | tee -a "$LOG"

# 2.3 infra (skip if already up as in §1)
pnpm infra:dev:up 2>&1 | tee -a "$LOG"

# 2.4 STT (skip if already listening on :8861)
HF_HOME=/Users/apple/.cache/huggingface pnpm stt:dev 2>&1 | tee -a "$LOG"

# 2.5 API (watch mode + inspector on 127.0.0.1:9229)
nohup pnpm api:dev >> "$LOG" 2>&1 &
echo $!    # launcher PID
```

Wait and confirm:

```bash
for i in $(seq 1 36); do
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 http://localhost:8868/api/v1/health || true)
  [ "$code" = "200" ] && { echo "API healthy after ${i} polls"; break; }
  sleep 5
done
lsof -nP -iTCP:8868,9229 -sTCP:LISTEN
curl -sS http://localhost:8868/api/v1/health
curl -sS http://localhost:8861/api/v1/health
pnpm stack:dev:doctor          # NOT pnpm dev:doctor
```

**Verified result:** health `200`, body `{"status":"healthy","service":"api","version":"0.0.0-main.b1929a98",…}`, inspector on `127.0.0.1:9229`, zero TS errors.

---

## 3. VS Code debugging without editing `project-hope`

The tracked `project-hope/.vscode/launch.json` no longer contains the attach configuration. Do **not** re-add it (repo must stay unchanged). Instead open the provided workspace file:

```
open /Users/apple/repos/VOX/review/alaaSv3/hope-api-attach.code-workspace
```

It defines **`Attach: HOPE API (9229)`** (`type: node`, `request: attach`, `127.0.0.1:9229`, `sourceMaps: true`) pointing at the repo folder. Then:

1. Cmd+Shift+D → select **`Attach: HOPE API (9229)`** → F5.
2. Set breakpoints from §5; confirm they bind (red dots).
3. Trigger requests with §6 curls; correlate with `$LOG` (all API/STT output is tee'd there).

If a breakpoint is unbound: confirm `pnpm api:dev` is the process listening on `9229`, and that watch rebuild finished (`rimraf dist … && nest start --debug … --watch`).

---

## 4. Auth — corrected calls

### 4.1 Human JWT (for consultation endpoints)

```bash
B="http://localhost:8868/api/v1"

# Clinician account (required for POST /consultations/open)
curl -sS -X POST "$B/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"arcaai_doctor","password":"password123","tenantKey":"ARCAAI"}'
```

Extract `.token` → `Authorization: Bearer $JWT`.
- `tenantKey` is the **key** `ARCAAI`, not the tenant UUID. Without it: `400 Tenant ID is required`.
- `super_admin` + `tenantKey: ARCAAI` works for read-only/config calls (`workflows`, `language-modes`) but `open` returns `404` because the caller is not a clinician.
- Other seeded clinician logins with tenant `ARCAAI`: `arcaai_doctor_surg`, `arcaai_doctor_derm`, etc. (all `password123`). `doctor` (unscoped) is NOT in tenant ARCAAI → `401 User does not have access to the specified tenant`.

### 4.2 Service-account opaque token

```bash
curl -sS -X POST "$B/auth/service-token" -H 'Content-Type: application/json' \
  -d '{"clientId":"<HOPE_SVC_CLIENT_ID>","clientSecret":"<HOPE_SVC_CLIENT_SECRET>","workingTenantId":"50000000-0000-0000-0000-000000000001"}'
```

Use `.accessToken` as `X-Service-Account-Token: …`. Verified `200`; route moved to `service-account-token.controller.ts` but path is unchanged. For `open`, a service-account caller must name the clinician via `clinicianUserId` or a staff id in `context`.

### 4.3 Dev JWT tool (still works)

```bash
JWT_SECRET_KEY="$(grep '^JWT_SECRET_KEY=' .env.dev | head -1 | cut -d= -f2-)" \
  pnpm -s gen:token -u super_admin -e 24h -p
```

### 4.4 Helper script (needs the new tenant flag)

```bash
TENANT_KEY=ARCAAI ./review/alaaSv3/scripts/hope-debug-api.sh login
# or: … login --username arcaai_doctor --tenant-key ARCAAI
```

The script already supports `TENANT_KEY` / `--tenant-key`; without it its `login` and `call --mode login` produce tenant-less tokens and fail with `400`.

---

## 5. Refreshed breakpoint map (line numbers at HEAD b1929a98f)

`apps/api/src/modules/consultation/consultation.controller.ts` (base `/api/v1/consultations`):

| API | Method / line |
|---|---|
| Open (get-or-create) | `open()` **820** |
| List selectable workflows | `listSelectableWorkflows()` **911** |
| Get consultation | `getById()` **928** |
| Update (OCC) | `update()` **1196** |
| Start capture | `start()` **1239** |
| Pause | `pause()` **1291** |
| Stop | `stop()` **1315** |
| Approve | `approve()` **1362** |
| Close | `close()` **1497** |
| Reopen | `reopen()` **1553** |
| Add context | `addContext()` **1963** |
| Get context items | `getContextItems()` **1980** |
| Generate summary (async) | `generateSummaryAsync()` **2749**, `startHarnessSummaryJob()` **2786** |

Routes here are declared with `@ApiEndpoint({ method, path })` — searching for `@Post('open')` / `@Get(':id')` will find nothing. Search by method name instead.

`apps/api/src/modules/streaming/transcription-job.controller.ts` (base `/api/v1/audio/transcription-jobs`):

| API | Method / line |
|---|---|
| Language modes | `getLanguageModes()` **932** |
| Create stream session | `createStreamSession()` **987** |
| Close stream session | `closeStreamSession()` **1412** |
| Refresh ticket | `refreshStreamTicket()` **1437** |
| Switch to fallback / primary | routes at ~1466 / ~1510 (search `switch-to-fallback` / `switch-to-primary`) |

Application service (critical for STT failures):
- `packages/applications/src/services/stt/streaming/streamingSession.service.ts` → `createSession()` **360**
- `packages/applications/src/services/stt/agent-resolver/asr-agent-resolver.service.ts` → `resolvePrimary()` **492**, `resolveChainFormats()` **434**
- Search `stt.asr_agent_resolved` in API logs to see resolved agent (`realtime-transcription-en` was selected in this session, source `tenant`).

> Line numbers drift with every pull — re-run `grep -n "async <method>" <file>` after each pull.

---

## 6. Verified request sequence (with clinician JWT)

All responses below were observed live after steps 2 and 4; tokens are redacted here.

```bash
B="http://localhost:8868/api/v1"
JWT="<arcaai_doctor token>"

# Health — 200
curl -sS "$B/health"

# Workflows — 200
curl -sS "$B/consultations/workflows" -H "Authorization: Bearer $JWT"
# {"data":[{"slug":"arcaai-gen-consultation", … "isTenantDefault":true}]}

# Language modes — 200 (was 400 P2022 before DB reset)
curl -sS "$B/audio/transcription-jobs/language-modes" -H "Authorization: Bearer $JWT"

# Open — 201
curl -sS -X POST "$B/consultations/open" -H "Authorization: Bearer $JWT" \
  -H 'Content-Type: application/json' \
  -d '{"patientId":"debug-patient-o-001","context":{}}'
# {"id":"01a1e437-…","status":"OPEN","department":{"code":"GEN",…},…}

CID="<id from open>"

# Get — 200
curl -sS "$B/consultations/$CID" -H "Authorization: Bearer $JWT"

# Start — 200 → {"status":"RECORDING", "version":3}
curl -sS -X POST "$B/consultations/$CID/start" -H "Authorization: Bearer $JWT" \
  -H 'Content-Type: application/json' -d '{}'

# Stop — 200 → {"status":"DRAINING", "lifecycle.status":"STOPPED", "version":4}
curl -sS -X POST "$B/consultations/$CID/stop" -H "Authorization: Bearer $JWT" \
  -H 'Content-Type: application/json' -d '{"waitForFinal":true}'

# Consultation jobs — 200 []
curl -sS "$B/audio/transcription-jobs/consultation/$CID" -H "Authorization: Bearer $JWT"

# Stream session — currently 502 (see §7)
curl -sS -X POST "$B/audio/transcription-jobs/stream/session" -H "Authorization: Bearer $JWT" \
  -H 'Content-Type: application/json' \
  -d "{\"consultationId\":\"$CID\",\"languageMode\":\"en\"}"
```

---

## 7. Remaining known issue — stream session 502 (downstream, not an API-code bug)

`POST /api/v1/audio/transcription-jobs/stream/session` → **502 `GATEWAY.DOWNSTREAM_UNAVAILABLE`**, `"Transcription returned an invalid response."`

Evidence from the investigation console:
- `StreamingSessionService` → `Failed to create streaming session`, `Request failed with status code 500`, `upstreamStatus: 500`, `causeType: AxiosError` (`ERR_BAD_RESPONSE`).
- STT `GET /api/v1/health` is `200` (minio/redis/streaming/processors healthy) — health is not sufficient to prove session creation works.
- Immediately before the failure: `GET /api/v1/internal/stt/model-registry-credential` → **401 `Invalid API key`** (`keyPrefix bab62d61b91d`) from the STT callback into HOPE API.
- Warning: `ASR model 'arcaai-whisper-large-ml-en-gguf' declares _metadata.asr members this runtime ignored: decoding.beamSize …`.
- Resolved agent logged as `stt.asr_agent_resolved` → `realtime-transcription-en`, source `tenant`.

Debug path (outside this API-only session): breakpoints at `createStreamSession` **987** → `StreamingSessionService.createSession` **360** → inspect outbound request/response to STT; then STT logs for the 500 and the `model-registry-credential` API-key mismatch (STT's configured `API_GATEWAY_KEY` vs the freshly reseeded HOPE API key).

---

## 8. Troubleshooting quick reference

| Code / message | Meaning | Action |
|---|---|---|
| 366 × `error TS` on `pnpm api:dev` | stale workspace `dist` | `pnpm build:packages`, then restart API |
| `Tenant ID is required` / `Tenant context is required` | tenant-less JWT | add `tenantKey: ARCAAI` to login |
| `User does not have access to the specified tenant` (401) | user not in that tenant | use a user seeded for ARCAAI (e.g. `arcaai_doctor`) |
| generic `404 Resource not found` on `open` | caller is not a clinician / no clinician resolved | use a doctor account, or service token + `clinicianUserId` |
| `400 P2022 … column does not exist` | stale DB schema | `pnpm db:all` (destructive) or `pnpm setup:dev` |
| `pnpm dev:doctor` not found | renamed script | `pnpm stack:dev:doctor` |
| breakpoint not bound | attach config/process mismatch | use the supplied `.code-workspace`; confirm PID on `9229` |
| `502 GATEWAY.DOWNSTREAM_UNAVAILABLE` on stream session | STT returned 500; see §7 | debug STT session creation + `model-registry-credential` API key |

---

## 9. Files produced by this investigation (all under `review/alaaSv3/`)

- `debug-hope-api-gateway-fresh-pull-20261116.md` — this corrected API-only guide
- `hope-api-attach.code-workspace` — VS Code attach config without touching `project-hope`
- `agent_log/20261116-api-debug-investigation.md` — agent console log
- `investigate_console_20261116.log` — full investigation/verification console output
