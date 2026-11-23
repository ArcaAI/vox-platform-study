# ALaaSv3.0 local debugging — dependent backend services to run from laptop (project-hope)

**Goal:** Debug `ALaaSv3.0` (demo branch) in VS Code while running dependent backend services locally from laptop instead of using lab/server-side dependencies.

**Code locations**
- ALaaS app: `/Users/apple/repos/VOX/ALaaSv3.0`
- Dependent backend/services code: `/Users/apple/repos/VOX/project-hope`

> **Important:** ALaaS currently has lab endpoints in `.env` (you already backed up `.env` as `.env.indumati` in both `apps/audio-stream-svc` and `apps/web_ui`). To debug against local services, you must update ALaaS `.env` values to point to local services (examples below).

---

## 1) Which dependencies ALaaSv3.0 interacts with

Based on `ALaaSv3.0/apps/audio-stream-svc/.env`, `docs/LOCAL_DEV_WITH_HOPE.md`, and HOPE integration code/docs:

| Dependency | Used by ALaaS for | Current/lab example in ALaaS env | Local target (typical) |
|---|---|---|---|
| **HOPE API Gateway** (`HOPE_API_URL`) | Consultation open/start/stop/approve/close, summaries, streams, STT session orchestration via `@arcaai/vox-node` | `http://192.168.112.6:32458` | `http://localhost:8868` |
| **HOPE STT service** | Realtime/batch transcription (routed through HOPE flows; also STT worker/batch jobs in HOPE) | via HOPE; ALaaS also has `WHISPER_STT_URL=http://192.168.112.2:9000/...` (separate/legacy path, verify usage) | `8861` (HOPE STT) + `stt-worker` |
| **HOPE Text service** | LLM text generation/summarization/final note related flows | via HOPE workflows/services | `8862` |
| **HOPE Guardrail service** | Safety/guardrail checks in clinical documentation flows | via HOPE workflows/services | `8863` |
| **HOPE NLP service** | Medical NLP/NER/entity extraction used by workflows | via HOPE workflows/services | `8864` |
| **HOPE Harness service + Temporal worker** | Durable clinical documentation workflows (`HarnessDocWorkflow`), callbacks to API internal harness endpoints | via HOPE workflow runtime | `8866` (harness app) + `worker` (Temporal task queue consumer) |
| **HOPE infrastructure** | DB, cache/queues, workflow engine, storage/vector/search/secrets depending on flow | external/lab | Postgres 5432, Redis 6379, Temporal 7233, Vault 8200, MinIO 9000-9001, Qdrant 6333-6334, reranker 8870 (per HOPE local dev docs/scripts) |
| **ALaaS PostgreSQL** | ALaaS app data (`PG_HOST`, `PG_PORT`, `DATABASE_*`) | `localhost:5432` in current `.env` (may be lab/local depending machine) | Local ALaaS DB instance (often separate from HOPE DB; local-dev docs suggest offset ports when running both stacks) |
| **ALaaS Redis** | Bull queues/session store/cache in ALaaS | `localhost:6379` | Local ALaaS Redis (separate instance/port recommended if HOPE Redis also local) |
| **mmr_agent (ALaaS sidecar)** | Browser mic capture/live audio stream to ALaaS UI (`ws://localhost:5001/audio_stream`) | local sidecar | `http://localhost:5001` (run from ALaaS repo, not project-hope) |

**Primary ALaaS → HOPE dependency:** ALaaS `audio-stream-svc` integrates with HOPE through `HOPE_API_URL` (and derived WS/base URLs) using `@arcaai/vox-node`. Most clinical workflow behavior (STT orchestration, live documentation, summary generation, harness workflows) is executed by HOPE services behind the gateway.

---

## 2) project-hope services you will likely need to run locally

### A. Minimum for basic HOPE connectivity / health / API reachability
Run from `/Users/apple/repos/VOX/project-hope`:

| Service | Why needed | Local port (default) | Start command |
|---|---|---:|---|
| **Infra containers (core)** | HOPE DB/cache/workflow/storage dependencies | 5432, 6379, 7233/8233, 8200, 9000-9001, 6333-6334, 8870 etc. | `pnpm infra:dev:up` |
| **API gateway (`apps/api`)** | ALaaS talks to HOPE via gateway | 8868 | `pnpm api:dev` (or included in `pnpm stack:dev`) |

**Verify:**
```bash
curl -s http://localhost:8868/api/v1/health
```

### B. For realtime consultation recording/streaming (typical debug case)
Add these HOPE services:

| Service | Why needed | Port | Start command |
|---|---|---:|---|
| **STT** | Speech-to-text service | 8861 | `pnpm stt:dev` |
| **STT worker** (`stt-worker`) | Batch/queued STT processing (Dramatiq) | n/a | `pnpm stt:worker:dev` |
| **Text** | LLM/text generation endpoints used by clinical flows | 8862 | `pnpm text:dev` |
| **Guardrail** | Safety/guardrail checks | 8863 | `pnpm guardrail:dev` |
| **NLP** | Medical NER/NLP extraction/classification | 8864 | `pnpm nlp:dev` |

### C. For summary generation / clinical documentation harness workflows
Add these (important for "Generate Summary", live doc/harness-driven processing):

| Service | Why needed | Port | Start command |
|---|---|---:|---|
| **Harness app** | Harness API/service (FastAPI, workflow-related endpoints/admin/health) | 8866 | `pnpm harness:dev` |
| **Harness Temporal worker** (`worker`) | Executes Temporal workflows/activities (e.g. `HarnessDocWorkflow`) | n/a | `pnpm worker:dev` |
| **Temporal (infra)** | Workflow orchestration backend | 7233 (+ UI 8233) | included by `pnpm infra:dev:up` (temporal profile) |

### D. Optional but often useful
| Service | Why | Port/notes | Start command |
|---|---|---|---|
| **Admin console** | Inspect/administer HOPE config/workflows/agents/tenants | 5176 | `pnpm admin:dev` |
| **TTS** | Only if TTS features are exercised | 8865 | `pnpm tts:dev` |
| **Publisher/checkpoint workers** | Only if model publish/checkpoint flows are exercised | n/a | `pnpm publisher:dev`, `pnpm checkpoint:dev` |
| **LM Studio / local LLM runtime** | Required by HOPE text/guardrail in local setups (per HOPE docs) | typically 1234 | external app/runtime |

---

## 3) Recommended local startup sequence (project-hope)

From `/Users/apple/repos/VOX/project-hope` (after dependencies installed and `.env.dev`/Python env prepared as per project-hope setup):

### Prerequisite: `project-hope` `.env.dev` and Vault kv-v2 secrets (important)

`pnpm infra:dev:up` (`scripts/dev-infra.sh up`) reconciles Vault with `.env.dev` after containers start (AppRole creds + Vault kv-v2 secrets via `scripts/vault-seed-secrets.sh`).

- `vault-seed-secrets.sh` sources `.env.dev` and derives the vault-kv secret list from the settings registry.
- **It skips a secret (reported as `SKIP (not set in environment)`) if the value is empty or exactly `CHANGE_ME`**. Skipped secrets are left **absent** in Vault (not written as empty strings); consumers with failMode `closed` will fail closed until set.
- Example from a real run (`review/ALaaSv3/console_infra_up.txt`): `JWT_SECRET_KEY`, `SESSION_SECRET_KEY`, `API_KEY_PEPPER`, `INTERNAL_ACCESS_TOKEN`, `GUARDRAIL_*`, `HARNESS_*`, `API_GATEWAY_KEY`, `REDIS_PASS`, `MINIO_*`, `S3_*`, `AZURE_STORAGE_*`, peppers, etc. were all `SKIP` because `.env.dev` still had placeholders (e.g. `JWT_SECRET_KEY=CHANGE_ME`, `SESSION_SECRET_KEY=CHANGE_ME`, `API_KEY_PEPPER=CHANGE_ME`).

**Before relying on HOPE services locally:**
1. Bootstrap/populate `.env.dev` as per project-hope setup (typically `pnpm setup:dev`, which creates `.env.dev` from `.env.sample` and runs infra/db/Vault steps). If `.env.dev` already exists, verify required values.
2. Replace `CHANGE_ME` / empty values for required secrets in `/Users/apple/repos/VOX/project-hope/.env.dev` with real/generated values for your local environment.
3. Rerun Vault reconciliation/seeding so values are written to `secret/data/hope/<NAME>` in Vault kv-v2 (e.g. `pnpm infra:dev:up` again, or the project-hope vault seed/setup step you use).
4. Confirm the seed summary shows the needed secrets as `write`/`update`/`unchanged` instead of `SKIP`, then restart affected HOPE services if they were already running.

### Option 1 — Start full dev stack (easiest for debugging end-to-end)
```bash
cd /Users/apple/repos/VOX/project-hope
pnpm infra:dev:up
pnpm stack:dev
```

`stack:dev` (default) starts: **api, stt, stt-worker, text, guardrail, nlp, harness, worker, checkpoint-worker, admin** (and ensures infra; may preload LM Studio model if available).

Check status/health:
```bash
pnpm stack:dev:doctor
```

### Option 2 — Start a targeted subset (faster, if you know the flow)
Examples:
```bash
cd /Users/apple/repos/VOX/project-hope
pnpm infra:dev:up

# Core consultation + realtime AI services
pnpm stack:dev -- api stt stt-worker text guardrail nlp

# Add harness workflow execution (for summary/generate flows)
pnpm stack:dev -- api stt stt-worker text guardrail nlp harness worker
```

You can also run services in separate terminals for easier debugging:
```bash
pnpm api:dev
pnpm stt:dev
pnpm stt:worker:dev
pnpm text:dev
pnpm guardrail:dev
pnpm nlp:dev
pnpm harness:dev
pnpm worker:dev
# pnpm admin:dev (optional)
```

> Use `pnpm stack:dev:down` to stop services started by the stack supervisor (infra remains unless you stop it separately).

---

## 4) ALaaSv3.0 env changes needed to point to local project-hope services

Update `ALaaSv3.0/apps/audio-stream-svc/.env` (after backups) for local debugging. Key values to review/change:

### Must/likely change
```ini
# HOPE gateway (ALaaS -> HOPE)
HOPE_API_URL=http://localhost:8868

# HOPE credentials/tenant for LOCAL HOPE (must match local seeded/dev config; lab creds may not work locally)
HOPE_SVC_CLIENT_ID=<local_hope_service_account_client_id>
HOPE_SVC_CLIENT_SECRET=<local_hope_service_account_client_secret>
HOPE_WORKING_TENANT_ID=<local_tenant_uuid>

# ALaaS app DB/Redis (point to the instances you intend ALaaS to use locally)
PG_HOST=localhost
PG_PORT=<alaas_postgres_port>
DATABASE_USER=<alaas_db_user>
DATABASE_PASSWORD=<alaas_db_password>
DATABASE_NAME=<alaas_db_name>
REDIS_HOST=localhost
REDIS_PORT=<alaas_redis_port>

# If used by your flow, point to local STT endpoint instead of lab
WHISPER_STT_URL=<local_whisper_or_stt_endpoint_if_applicable>
WHISPER_STT_MODEL=<local_model_if_applicable>
```

### Keep/verify
- `HOPE_REALTIME_ADAPTER=vox-node` (for real HOPE integration)
- `ALAAS_HOPE_MAPPING` path is valid for local HOPE tenant/departments/users
- `API_KEY`, `PORT`, `CLIENT_BASE_URL` align with web_ui and local backend port

### web_ui (`ALaaSv3.0/apps/web_ui/.env`)
Ensure it points to local ALaaS backend and local mmr_agent:
```ini
VITE_API_BASE_URL=http://localhost:4000   # or your audio-stream-svc PORT
VITE_AUDIO_AGENT_BASE_URL=http://localhost:5001
VITE_API_KEY=<same_as_audio-stream-svc_API_KEY>
```

> **Note:** Running HOPE locally may require local seed data, tenant/users/departments, mapping regeneration, and valid local HOPE service-account credentials (see `ALaaSv3.0/docs/LOCAL_DEV_WITH_HOPE.md` and project-hope dev setup docs).

---

## 5) Practical "what to run" by ALaaS debugging scenario

| Debug scenario in ALaaSv3.0 | Run locally (minimum) |
|---|---|
| UI/backend boot, auth/config, HOPE connectivity checks | ALaaS `audio-stream-svc` + `web_ui`; project-hope `infra:dev:up` + `api` |
| Start/open consultation, basic lifecycle calls | Above + HOPE `stt`, `text`, `guardrail`, `nlp` (and `stt-worker` recommended) |
| Live recording/streaming/transcripts | Above + `mmr_agent` (ALaaS repo) + HOPE `stt` + `stt-worker` + API reachable |
| Stop/finalize + generate summary + harness workflows | Above + HOPE `harness` + `worker` + Temporal (infra) + `text/guardrail/nlp/stt` |
| Approve/close (Copy to EMR sign-off path) | HOPE `api` + consultation services/data state (usually full stack recommended) |

---

## 6) Quick local verification checklist

### project-hope
```bash
cd /Users/apple/repos/VOX/project-hope
pnpm stack:dev:doctor
curl -s http://localhost:8868/api/v1/health
curl -s http://localhost:8861/health || true
curl -s http://localhost:8862/health || true
curl -s http://localhost:8863/health || true
curl -s http://localhost:8864/health || true
curl -s http://localhost:8866/health || true
```

### ALaaS
```bash
# audio-stream-svc
curl -s http://localhost:4000/health
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:4000/api/v1/consultation/protocol

# mmr_agent (if used)
curl -s http://localhost:5001/health
```

---

## 7) Gotchas (important for local debug)

- **Vault secrets skipped when `CHANGE_ME`/empty in `.env.dev`:** `pnpm infra:dev:up` reconciles Vault kv-v2 from `project-hope/.env.dev`, but `scripts/vault-seed-secrets.sh` treats empty values and the `CHANGE_ME` sentinel as "not set" and leaves those secrets **absent** in Vault (fail-closed). This can look like setup succeeded while auth/service-token/guardrail/harness/storage/Redis/MinIO-dependent flows fail later. Populate required values in `.env.dev` and rerun reconciliation/seeding (see section 3 prerequisite).
- **Different credentials for local HOPE:** lab `HOPE_SVC_CLIENT_ID/SECRET` and tenant IDs usually will not work against a fresh local HOPE DB/seed.
- **Port collisions:** HOPE and ALaaS both use Postgres/Redis; run them on separate ports/instances and point each app to the correct one.
- **Temporal/harness workers required:** summary/harness flows may appear stuck in queued/pending states if `worker` (Temporal harness worker) is not running.
- **STT batch worker required:** `stt-worker` (Dramatiq) is separate from STT API; batch jobs can queue but never complete without it.
- **LM Studio/model dependencies:** HOPE text/guardrail flows may fail closed if local LLM runtime/model is not available/configured as expected.
- **Mapping/config drift:** `ALAAS_HOPE_MAPPING` and HOPE tenant/department/clinician IDs must match the local HOPE environment.
- **`.env` precedence/restarts:** after changing `.env` files, restart affected services/processes (Nest/Vite/Python dev servers may need restart depending on watcher behavior).

---

## 8) References (code/docs)
- `ALaaSv3.0/docs/LOCAL_DEV_WITH_HOPE.md` (cross-repo local bring-up, port map, service order)
- `ALaaSv3.0/apps/audio-stream-svc/.env` (current dependency endpoints/credentials placeholders)
- `ALaaSv3.0/apps/audio-stream-svc/README.md`, `HOPE_INTEGRATION.md`
- `project-hope/README.md` (stack commands, ports, services)
- `project-hope/scripts/dev-stack.sh` (default services started by `pnpm stack:dev`)
- `project-hope/scripts/dev-setup.sh`, `project-hope/scripts/dev-infra.sh`, `project-hope/scripts/vault-seed-secrets.sh` (env bootstrap and Vault kv-v2 reconciliation/seeding behavior)
- `review/ALaaSv3/console_infra_up.txt` (example run showing `CHANGE_ME`/unset secrets skipped as absent in Vault)
- `project-hope/docs/architecture/overview.md` (service topology and ports) if deeper trace needed
