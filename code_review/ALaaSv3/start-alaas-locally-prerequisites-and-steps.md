# Start ALaaSv3.0 locally (prerequisites and step-by-step)

**Purpose:** Start ALaaSv3.0 components on your laptop against locally running HOPE services so you can trigger consultations from the ALaaS UI and debug the HOPE API Gateway (`project-hope/apps/api`, `:8868`) in VS Code.

**Date/context:** Written 2026-11-15 based on local debug progress in `review/ALaaSv3/` (HOPE infra/API up; Step 1 debug attach configured). Adapt paths/ports/credentials to your environment.

**Repositories**
- ALaaS: `/Users/apple/repos/VOX/ALaaSv3.0` (demo branch)
- HOPE (backend): `/Users/apple/repos/VOX/project-hope`

> **Do not commit `.env` files, tokens, certs, or secrets.** Keep local credentials/mappings out of git. Backups already exist for ALaaS envs: `ALaaSv3.0/apps/audio-stream-svc/.env.indumati`, `ALaaSv3.0/apps/web_ui/.env.indumati`.

---

## 1) Prerequisites

### 1.1 HOPE must be running and reachable (local)
| Prerequisite | Why | How to check (examples) |
|---|---|---|
| HOPE infra (Docker) up: Postgres, Redis, Vault, Temporal, MinIO, Qdrant, reranker as configured | Persistence, queues, workflows, secrets, storage/retrieval | `cd /Users/apple/repos/VOX/project-hope && docker ps` |
| HOPE API Gateway healthy on `8868` | ALaaS calls HOPE via `HOPE_API_URL` | `curl -sS http://localhost:8868/api/v1/health` |
| HOPE consultation-related services ready for your scenario | Realtime/summary/harness flows depend on downstream services | `cd /Users/apple/repos/VOX/project-hope && pnpm dev:doctor` and service health checks |
| Local HOPE seeded/configured | ALaaS needs valid local tenant, service account, and mapping | Local HOPE admin/seed/config (not lab) |

**Scenario guidance (minimum):**
- Debug requests reaching HOPE API: **API** must be up (already sufficient to attach/debug gateway).
- Open/start consultation and basic realtime flows: often **API + stt + text + guardrail + nlp** (+ workers as needed).
- Summary/harness workflows: add **harness + Temporal worker** (Temporal infra running) and required AI services.
- **Batch STT** is out of scope for some debug sessions, but if used you need **`stt-worker`** (`pnpm stt:worker:dev`).

**Known current-state notes (2026-11-14):** HOPE API/infra and several HOPE services were up, but `pnpm dev:doctor` reported `stt` batch worker not running, LM Studio unreachable with `text providers registered: none`, and reranker restarting (optional). Resolve provider/runtime issues for flows that depend on them.

### 1.2 Local HOPE values required by ALaaS (collect before starting ALaaS)
Collect from your **local** HOPE seed/admin/config (not lab). Reseeding can invalidate these.

| Value | Purpose | Typical local dev source |
|---|---|---|
| `HOPE_API_URL` | HOPE gateway base URL | `http://localhost:8868` |
| `HOPE_SVC_CLIENT_ID` | HOPE service account client ID | Local seeded `ARCAAI_ADMIN` service account (see HOPE seed/constants, e.g. `project-hope/packages/database/src/prisma/db_main/seed/00-constants.*` → `SEED_SERVICE_ACCOUNT_CLIENT_IDS.ARCAAI_ADMIN`) |
| `HOPE_SVC_CLIENT_SECRET` | HOPE service account secret | Local seeded dev secret for `ARCAAI_ADMIN` (`SEED_SERVICE_ACCOUNT_DEV_SECRETS.ARCAAI_ADMIN` in HOPE seed/constants). **Treat as secret.** |
| `HOPE_WORKING_TENANT_ID` | HOPE tenant for ALaaS integration | Common local ArcaAI tenant: `50000000-0000-0000-0000-000000000001` (verify against your local seed) |
| `HOPE_NER_TENANT_ID` | NER tenant (if required by your flow) | Local HOPE config/seed (set only if needed) |
| `ALAAS_HOPE_MAPPING` | ALaaS↔HOPE identity mapping (departments/clinicians/users) | `ALaaSv3.0/apps/audio-stream-svc/config/alaas-hope-mapping.json` (verify matches local tenant/seed; regenerate if needed) |

### 1.3 ALaaS local datastores (separate from HOPE)
HOPE uses Postgres `5432` and Redis `6379` by default. **Run ALaaS on separate ports/instances** to avoid collisions/data confusion.

| Store | Recommended local port | Notes |
|---|---:|---|
| ALaaS PostgreSQL | `5433` | Create ALaaS DB/user/password for `audio-stream-svc` |
| ALaaS Redis | `6380` | Used by ALaaS queues/cache/session (as configured) |

### 1.4 Tools and access
- **Node.js >= 22** and npm/pnpm as required by ALaaS apps (`audio-stream-svc` requires Node >= 22).
- **Docker + Docker Compose** (to run ALaaS Postgres/Redis containers).
- **Python env** for `ALaaSv3.0/apps/mmr_agent` if you need live microphone capture/recording in UI.
- **`GITHUB_TOKEN` with `read:packages`** may be required to install `@arcaai/*` packages in ALaaS (export before `pnpm install`/`npm install`).
- **VS Code** (optional but recommended) for debugging HOPE API Gateway (`Attach: HOPE API (9229)` configured in `project-hope/.vscode/launch.json` if Step 1 completed).

### 1.5 ALaaS env/config readiness
- `ALaaSv3.0/apps/audio-stream-svc/.env` must point to **local HOPE** (`http://localhost:8868`), valid **local HOPE service account/tenant**, correct **ALaaS DB/Redis** ports, and valid **`ALAAS_HOPE_MAPPING`**.
- `ALaaSv3.0/apps/web_ui/.env` must point to local ALaaS backend (`http://localhost:4000`), matching `VITE_API_KEY`/backend `API_KEY`, and local `mmr_agent` (`http://localhost:5001`) if used.
- Lab endpoints/credentials in ALaaS envs should be reviewed/adjusted so you do not unintentionally call lab systems during local debug.

---

## 2) Start ALaaS locally — step-by-step

### Step 2.1 — Verify HOPE is ready
```bash
# HOPE API
curl -sS http://localhost:8868/api/v1/health; echo

# HOPE overall (optional but recommended)
cd /Users/apple/repos/VOX/project-hope
pnpm dev:doctor || true
```
Ensure the HOPE services required for your consultation scenario are running/healthy (see §1.1). Keep HOPE API running (and debugger attached if debugging `apps/api`).

### Step 2.2 — Start ALaaS PostgreSQL and Redis (separate ports)
```bash
# ALaaS Postgres (5433)
docker run -d --name alaas-dev-postgres -p 5433:5432 \
  -e POSTGRES_USER=alaas -e POSTGRES_PASSWORD=alaas_dev_only -e POSTGRES_DB=alaas \
  -v alaas-dev-pgdata:/var/lib/postgresql/data postgres:15

# ALaaS Redis (6380)
docker run -d --name alaas-dev-redis -p 6380:6379 redis:7-alpine
```

If containers already exist later:
```bash
docker start alaas-dev-postgres alaas-dev-redis
```

Verify:
```bash
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" | grep alaas-dev
```

> Prefer these containers over `ALaaSv3.0/docker-compose.yml` for local dev if it collides with HOPE Redis (`6379`).

### Step 2.3 — Configure `ALaaSv3.0/apps/audio-stream-svc/.env`
Edit the active `.env` (not `.env.indumati`). Set/review at minimum:

```ini
NODE_ENV=development
PORT=4000
CLIENT_BASE_URL=http://localhost:5173

# HOPE (local)
HOPE_API_URL=http://localhost:8868
HOPE_SVC_CLIENT_ID=<local_hope_service_account_client_id>
HOPE_SVC_CLIENT_SECRET=<local_hope_service_account_client_secret>
HOPE_WORKING_TENANT_ID=<local_tenant_uuid>
# HOPE_NER_TENANT_ID=<local_ner_tenant_uuid_if_required>
HOPE_REALTIME_ADAPTER=vox-node
# HOPE_CONSULTATION_ADAPTER=vox-node5  # if used by your app version/config
ALAAS_HOPE_MAPPING=config/alaas-hope-mapping.json

# ALaaS auth (must match web_ui VITE_API_KEY)
API_KEY=<local_dev_value>

# ALaaS DB (separate from HOPE 5432)
PG_HOST=localhost
PG_PORT=5433
DATABASE_HOST=localhost
DATABASE_PORT=5433
DATABASE_USER=alaas
DATABASE_PASSWORD=alaas_dev_only
DATABASE_NAME=alaas

# ALaaS Redis (separate from HOPE 6379)
REDIS_HOST=localhost
REDIS_PORT=6380
REDIS_PASSWORD=
REDIS_DB=0
# ALAAS_SESSION_STORE=memory
```

Also review and adjust lab/external settings for your debug path as needed (e.g. `WHISPER_STT_URL`, `AGENTIC_SDK_API_URL`, Azure/OpenAI/external EMR endpoints/keys). Do not commit real secrets.

> Notes: `audio-stream-svc` uses `API_KEY` for REST auth (not `AUTH_KEY`); keep `VITE_API_KEY` in `web_ui` identical. Confirm any app-specific env precedence/required keys against `ALaaSv3.0/apps/audio-stream-svc/.env.example` and app code/docs.

### Step 2.4 — Configure `ALaaSv3.0/apps/web_ui/.env`
```ini
VITE_API_BASE_URL=http://localhost:4000
VITE_API_KEY=<same as audio-stream-svc API_KEY>
VITE_AUDIO_AGENT_BASE_URL=http://localhost:5001
VITE_AUDIO_AGENT_USERNAME=admin
VITE_AUDIO_AGENT_PASSWORD=admin

# HOPE/SDK endpoints for local (if used by web_ui flows)
VITE_SDK_API_ENDPOINT=http://localhost:8868
VITE_SDK_WEBSOCKET_URL=ws://localhost:8868
# VITE_SDK_API_KEY=<local_or_required_value_for_your_setup>
```

Review and replace lab-specific URLs/tokens/flags (`OPENAI_API_BASE`, external EMR endpoints, mock flags, etc.) as appropriate for local debugging.

### Step 2.5 — (Optional) Validate/regenerate ALaaS↔HOPE mapping and codegen
If local HOPE tenant/departments/clinicians differ from the committed mapping, regenerate/check (from `ALaaSv3.0/apps/audio-stream-svc`):

```bash
cd /Users/apple/repos/VOX/ALaaSv3.0/apps/audio-stream-svc
export GITHUB_TOKEN=<pat-with-read:packages>   # if needed

node scripts/generate-hope-mapping.mjs
# node scripts/generate-hope-mapping.mjs --check

npm run hope:codegen:check
# npm run hope:codegen  # if drift/regeneration needed
```

See `ALaaSv3.0/docs/LOCAL_DEV_WITH_HOPE.md` §2.4 for local codegen binary caveats and follow-up (`KNOWN_CONTEXT_KINDS`/generated types) if you regenerate.

### Step 2.6 — Start `mmr_agent` (optional, required for live mic/recording)
Run in a separate terminal:
```bash
cd /Users/apple/repos/VOX/ALaaSv3.0/apps/mmr_agent
# activate the Python env for this app as per its README
pip install -r requirements.txt
# pip install numpy slowapi python-jose passlib bcrypt websockets  # if required by README/runtime
python src/audio_agent.py
# or: uvicorn src.audio_agent:app --reload --host 127.0.0.1 --port 5001
```

Verify:
```bash
curl -sS http://localhost:5001/health; echo
curl -sS http://localhost:5001/list_mics; echo
```

**Detailed local setup/troubleshooting (this laptop, `sks_local_laptop`):** see [`mmr_agent-local-setup.md`](./mmr_agent-local-setup.md) (venv in `apps/mmr_agent/.venv`, PortAudio, extra deps, `bcrypt<4` workaround for passlib/bcrypt compatibility, CORS/auth/config notes, and observed verification).

### Step 2.7 — Start `audio-stream-svc` (ALaaS backend)
Run in a separate terminal:
```bash
cd /Users/apple/repos/VOX/ALaaSv3.0/apps/audio-stream-svc
export GITHUB_TOKEN=<pat-with-read:packages>   # if needed for @arcaai/* install

pnpm install   # or npm install
npm run build
npm run start:dev
```

Expected: `http://localhost:4000`

Verify:
```bash
curl -sS http://localhost:4000/health; echo
curl -sS -o /dev/null -w "%{http_code}\n" http://localhost:4000/api/v1/consultation/protocol; echo
```

> After any `.env` change, restart `audio-stream-svc`.

### Step 2.8 — Start `web_ui` (ALaaS frontend)
Run in a separate terminal:
```bash
cd /Users/apple/repos/VOX/ALaaSv3.0/apps/web_ui
npm install
npm run dev
```

Expected: `http://localhost:5173`

Open the app and navigate to the consultation/recording flow as required by your setup (ALaaS docs note the recording page may require query params such as `?openTab=recording&role=admin&sessionId=<n>&eventId=<n>&patientId=<x>`; mock-data modes may derive visit type from mock patient data).

### Step 2.9 — Trigger consultation and debug HOPE API Gateway
1. Ensure HOPE API is running and VS Code is attached to `127.0.0.1:9229` (`Attach: HOPE API (9229)` in `project-hope/.vscode/launch.json`).
2. Set breakpoints in `project-hope/apps/api/src/**` (consultation lifecycle, auth/service-account/tenant handling, internal harness endpoints as relevant).
3. From ALaaS UI, trigger consultation actions (open/start/stop/generate summary/approve-close depending on scenario and available HOPE services).
4. If requests fail, inspect ALaaS backend logs, HOPE API debugger/logs, and downstream HOPE services (`pnpm dev:doctor`, service logs, Temporal UI `http://localhost:8233` for harness flows).

---

## 3) Quick verification checklist

| Check | Command / URL | Expected |
|---|---|---|
| HOPE API | `curl -sS http://localhost:8868/api/v1/health` | healthy JSON / 200 |
| HOPE services (as needed) | `cd /Users/apple/repos/VOX/project-hope && pnpm dev:doctor` | required services healthy for your scenario |
| ALaaS Postgres/Redis containers | `docker ps \| grep alaas-dev` | running on `5433`, `6380` |
| ALaaS backend | `curl -sS http://localhost:4000/health` | healthy |
| ALaaS consultation protocol | `curl -sS -o /dev/null -w "%{http_code}\n" http://localhost:4000/api/v1/consultation/protocol` | `200` |
| mmr_agent (if used) | `curl -sS http://localhost:5001/health` | healthy |
| ALaaS UI | `http://localhost:5173` | loads; can reach local backend |

---

## 4) Common issues

| Symptom | Likely cause | Fix |
|---|---|---|
| ALaaS `audio-stream-svc` fails at boot with HOPE auth/401/identity errors | Lab/wrong `HOPE_SVC_CLIENT_ID/SECRET`, wrong `HOPE_WORKING_TENANT_ID`, or mapping mismatch | Use **local** HOPE service account/tenant; verify `ALAAS_HOPE_MAPPING` matches local HOPE seed/departments/users; reseeded HOPE invalidates old creds |
| Cannot connect to DB/Redis from ALaaS | Wrong ports or HOPE/ALaaS store collision | Use ALaaS Postgres `5433` / Redis `6380` (or chosen ports) and update `PG_*`/`DATABASE_*`/`REDIS_*` |
| Port `4000`/`5173`/`5001` already in use | Existing process/container | Stop conflicting process or change port consistently in envs/clients |
| `npm install`/`pnpm install` fails for `@arcaai/*` | Missing `GITHUB_TOKEN` with `read:packages` | Export token in shell before install |
| Requests reach HOPE API but flow fails downstream | Required HOPE services/workers/model runtime not ready | Check `pnpm dev:doctor`, start needed services (`stt/text/guardrail/nlp/harness/worker`), ensure LLM/provider config (e.g. LM Studio/Ollama) and Temporal as needed |
| `mmr_agent` mic/recording issues | Agent not running, wrong `VITE_AUDIO_AGENT_BASE_URL`, device permissions | Start `mmr_agent`, verify `/health`/`/list_mics`, check browser permissions and web_ui env |
| Env changes not applied | Processes not restarted | Restart affected ALaaS/HOPE services after `.env` updates |

---

## 5) References

- `review/ALaaSv3/debug-alaas-triggered-hope-api-gateway-procedure.md` (end-to-end debug procedure incl. HOPE API attach + ALaaS Steps 3–5)
- `review/ALaaSv3/run-alaas-and-hope-locally-step-by-step.md`
- `review/ALaaSv3/dependent-services-to-run-locally.md`
- `ALaaSv3.0/docs/LOCAL_DEV_WITH_HOPE.md` (primary cross-repo bring-up guide)
- `ALaaSv3.0/apps/audio-stream-svc/README.md`
- `ALaaSv3.0/apps/audio-stream-svc/.env.example`
- `ALaaSv3.0/apps/web_ui/.env.example`
- `project-hope/docs/development-guide.md`, `project-hope/README.md`, `project-hope/scripts/dev-doctor.sh` / `pnpm dev:doctor`


