# Debug HOPE API Gateway with consultations triggered from ALaaSv3.0 — procedure

**Date:** 2026-11-14 (snapshot/status captured during local debug session)  
**Workspace:** `/Users/apple/repos/VOX`  
**Objective:** Run ALaaSv3.0 locally so consultations can be triggered from the ALaaS UI, and debug the **HOPE API Gateway** (`project-hope/apps/api`, NestJS, port `8868`) in VS Code when those requests reach HOPE.

> **Safety:** Do not commit `.env` files, tokens, certs, or secrets. Prefer logging command output to `review/ALaaSv3/deploy_console_YYYYMMDD.log` when running steps interactively.

---

## 1) Current status of services

**2026-11-15 update (local debug session, `ALaaSv3.0` branch `sks_local_laptop`):** ALaaS local prep progressed — separate ALaaS datastores started (`alaas-dev-postgres:5433`, `alaas-dev-redis:6380`), ALaaS envs updated/backed up for local HOPE, and ALaaS apps started on the new branch. `mmr_agent` is now running on `:5001` (venv + deps installed; `bcrypt<4` workaround applied for passlib/bcrypt compatibility) and returns `/health` + `/list_mics`. See **`review/ALaaSv3/mmr_agent-local-setup.md`** for setup/start/verify/troubleshooting and `deploy_console_20261114.log` for command output. HOPE API remains healthy/debaggable on `:8868` (`Attach: HOPE API (9229)`); HOPE downstream service/provider gaps noted in 2026-11-14 snapshot still apply unless separately resolved.

### 1.1 Running / healthy (latest known)

| Component | Status | Evidence / endpoint | Notes |
|---|---|---|---|
| **HOPE infrastructure (Docker)** | Running (2026-11-14 snapshot) | `docker ps` showed core containers up | `hope-postgres` (5432), `hope-redis` (6379), `hope-vault` (8200), `hope-minio` (9000-9001), `hope-qdrant` (6333-6334), `hope-temporal` (7233), `hope-temporal-ui` (8233), `hope-reranker` (8870) |
| **HOPE API Gateway** | **Running, healthy, debuggable** (2026-11-14 snapshot) | `GET http://localhost:8868/api/v1/health` → `200` `{"status":"healthy","service":"api",...}` | Started via `pnpm api:dev` (launcher PID `19132`), app PID `20102` (`--inspect=127.0.0.1:9229`), listening on `*:8868` |
| **ALaaS PostgreSQL** | Running | `docker ps` / container `alaas-dev-postgres` | Separate from HOPE; exposed on `5433` |
| **ALaaS Redis** | Running | `docker ps` / container `alaas-dev-redis` | Separate from HOPE; exposed on `6380` |
| **ALaaS `audio-stream-svc`** | Running | `http://localhost:4000/health` → `{"status":"ok",...}`; protocol `200` | Started on `sks_local_laptop` with local HOPE/ALaaS env config |
| **ALaaS `web_ui`** | Running | `http://localhost:5173/` → `200` (Vite) | Started on `sks_local_laptop` |
| **ALaaS `mmr_agent`** | Running | `http://localhost:5001/health` healthy; `/list_mics` returns mics | Python `.venv` in `apps/mmr_agent`; PortAudio present; `bcrypt<4` pinned in venv for passlib compatibility. See `review/ALaaSv3/mmr_agent-local-setup.md`. |

### 1.2 Not running / not ready or needs verification (relevant to end-to-end consultation flow)

| Component | Status | Why it matters | Blocker / prerequisite |
|---|---|---|---|
| **HOPE STT** (`8861`) | Not verified/running per 2026-11-14 snapshot | Realtime/batch transcription flows | Python env/`conda` per HOPE setup; start `pnpm stt:dev` (recheck current state) |
| **HOPE STT worker** (`stt-worker`) | Not started (batch out of scope noted earlier) | Batch/queued STT completion | Start `pnpm stt:worker:dev` if needed |
| **HOPE Text** (`8862`) | Not ready for full generation in prior checks | Text generation/summarization | `pnpm dev:doctor` previously reported LM Studio unreachable / `text providers registered: none` |
| **HOPE Guardrail** (`8863`) | Started by user in earlier session (verify) | Guardrail checks | Recheck health/provider readiness |
| **HOPE NLP** (`8864`) | Started by user in earlier session (verify) | NLP/NER/classification flows | Recheck health |
| **HOPE Harness** (`8866`) + worker | Started/detected in earlier session (verify) | Harness service/workflows | Temporal up; verify harness/worker health for summary flows |
| **ALaaS↔HOPE end-to-end consultation** | Ready to validate from UI | Confirm requests reach HOPE API and downstream flow works | Trigger from `http://localhost:5173` with debugger attached; failures may be creds/mapping or HOPE downstream/provider readiness |

### 1.3 Configuration state (important)

| Item | Current state | Action needed before end-to-end ALaaS→HOPE run |
|---|---|---|
| `ALaaSv3.0/apps/audio-stream-svc/.env` | Still lab-oriented (e.g. `HOPE_API_URL` lab, lab creds/tenant, shared ports observed earlier) | Update to local HOPE (`http://localhost:8868`), local HOPE service-account/tenant, local ALaaS DB/Redis, valid `ALAAS_HOPE_MAPPING` (see run guide §4.1) |
| `ALaaSv3.0/apps/web_ui/.env` | Lab/local alignment not verified for this flow | Point to local ALaaS backend (`:4000`), mmr_agent (`:5001`), matching `VITE_API_KEY`, local HOPE/SDK endpoints if used (run guide §4.2) |
| Local HOPE service-account / tenant / mapping for ALaaS | Not collected in this session | Collect from local seeded HOPE (admin console/seed/config), not lab (run guide Step 2.7) |
| `conda` on laptop | **Missing** (prereq check 2026-11-13) | Install conda (Miniconda/Miniforge) and run `pnpm setup:python` in `project-hope` before HOPE Python services/workers |

---

## 2) Procedure docs followed to reach this stage

| Doc | Path | How it was used | Outcome |
|---|---|---|---|
| **HOPE API Vault auth fix (primary for current stage)** | `review/ALaaSv3/fix-hope-api-vault-auth.md` | Step 1/2: `pnpm infra:dev:up` (infra up + AppRole refresh + kv-v2 reconcile). Step 3: verified `SECRETS_PROVIDER`, `VAULT_ADDR`, `VAULT_REQUEST_TIMEOUT_MS`, role/secret vars. Step 4: timeout already `30000`. Step 5: started `pnpm api:dev` (background) and observed successful boot. Step 6: verified `GET /api/v1/health` = 200. | **Completed**; HOPE API running/healthy. |
| **Local run/debug step-by-step guide** | `review/ALaaSv3/run-alaas-and-hope-locally-step-by-step.md` | Context for prerequisites, `.env.dev`/Vault secret seeding behavior, HOPE service startup modes (Step 2.5), verification (Step 2.6), ALaaS DB/Redis/env/startup (Steps 3–5), VS Code workflow (Step 6), troubleshooting. Earlier execution (2026-11-13) followed parts of Steps 2.1–2.4 (`pnpm install`, `pnpm setup:dev` with explicit consent rerun, `pnpm infra:dev:up`) per log. | Partially completed; HOPE API now up, remaining HOPE services and ALaaS bring-up pending. |
| **Dependent services matrix / gotchas** | `review/ALaaSv3/dependent-services-to-run-locally.md` | Used to identify which HOPE services are needed for consultation/summary flows (API, stt/stt-worker, text/guardrail/nlp, harness/worker), ports, env changes, and known issues (Vault skips on `CHANGE_ME`, port conflicts, workers required). | Reference for next steps. |
| **Execution logs** | `review/ALaaSv3/deploy_console_20261113.log`, `review/ALaaSv3/deploy_console_20261114.log` | Evidence of commands run, failures (DB reset guard, stack reranker bind issue, Vault auth timeout), recovery, infra up, API startup, and health verification. | Current state grounded in logs. |
| **Agent task log** | `review/ALaaSv3/agent_log/20261114-alaas-hope-debug-session.md` | Session summary, resume point, blockers/reminders. | Continuity for this task. |
| **Related context docs (earlier work)** | `ALaaSv3.0/docs/LOCAL_DEV_WITH_HOPE.md`, `project-hope/docs/development-guide.md`, `project-hope/README.md` (as referenced by above docs) | Source guidance for cross-repo local bring-up, scripts, and service topology. | Consult when details are needed. |

---

## 3) How to check current state before proceeding

Run from appropriate directories (project-hope commands from `/Users/apple/repos/VOX/project-hope` unless noted). Capture output to a log if desired.

### 3.1 HOPE infrastructure and Vault

```bash
cd /Users/apple/repos/VOX/project-hope

# Docker containers
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

# Vault reachable
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8200/v1/sys/health
docker exec hope-vault vault status || true

# Key Vault env vars present (do not paste secret values into shared logs)
grep -n "^SECRETS_PROVIDER=\|^VAULT_ADDR=\|^VAULT_REQUEST_TIMEOUT_MS=\|^VAULT_ROLE_ID=\|^VAULT_SECRET_ID=\|^VAULT_WRAPPED_SECRET_ID=" .env.dev
```

**Expected now:** core HOPE containers up (including `hope-vault`, `hope-temporal`, `hope-redis`, `hope-postgres`, `hope-reranker`), Vault health `200`, vars set as in §1.1.

### 3.2 HOPE API Gateway (debug target)

```bash
# Process and ports
ps -ef | grep -E "pnpm api:dev|apps/api/dist/main|nest start" | grep -v grep
lsof -nP -iTCP:8868 -sTCP:LISTEN
lsof -nP -iTCP:9229 -sTCP:LISTEN   # Node inspector (attach target)

# Health
curl -sS http://localhost:8868/api/v1/health; echo

# Optional: readiness/readiness-like checks if available in your environment
# curl -sS http://localhost:8868/api/v1/health/ready || true
```

**Expected now:** API process listening on `8868`, inspector on `9229`, health returns JSON with `"status":"healthy"`.

### 3.3 HOPE downstream app services (needed for consultation flows)

```bash
# Listening ports (empty means not running)
for p in 8861 8862 8863 8864 8866; do echo "--- $p ---"; lsof -nP -iTCP:$p -sTCP:LISTEN || true; done

# Health checks (expect failures/no response if not running)
cd /Users/apple/repos/VOX/project-hope
curl -sS --max-time 3 http://localhost:8861/health || true; echo
curl -sS --max-time 3 http://localhost:8862/health || true; echo
curl -sS --max-time 3 http://localhost:8863/health || true; echo
curl -sS --max-time 3 http://localhost:8864/health || true; echo
curl -sS --max-time 3 http://localhost:8866/health || true; echo

# Stack doctor (if stack supervisor/services used)
pnpm stack:dev:doctor || true
```

**Expected now:** `8861-8864,8866` not listening / no healthy responses (not started). `conda` missing may prevent starting Python services.

### 3.4 ALaaS components

```bash
# Ports
lsof -nP -iTCP:4000 -sTCP:LISTEN || true   # audio-stream-svc
lsof -nP -iTCP:5173 -sTCP:LISTEN || true   # web_ui
lsof -nP -iTCP:5001 -sTCP:LISTEN || true   # mmr_agent

# If running later:
# curl -sS http://localhost:4000/health; echo
# curl -sS -o /dev/null -w "%{http_code}\n" http://localhost:4000/api/v1/consultation/protocol
# curl -sS http://localhost:5001/health; echo
```

**Expected now:** no ALaaS services listening.

### 3.5 Prerequisites / blockers to confirm

```bash
node -v; npm -v; pnpm -v; docker --version; uv --version 2>&1 || true
conda --version 2>&1 || echo "conda: missing"
```

**Known now:** `conda` missing (blocks HOPE Python services/workers and `pnpm setup:python`).

---

## 4) Before proceeding — decisions and cautions

1. **Do not disrupt the debug target unintentionally:** HOPE API is currently running in background (PID `20102`). If you need to restart it under VS Code’s debugger/Debug Terminal, stop the existing process first to free `8868`/`9229`.
2. **End-to-end consultation needs more than API:** Depending on flow, ALaaS consultations require HOPE consultation APIs plus STT/STT-worker, text/guardrail/NLP, and/or harness+Temporal worker. Plan service startup accordingly (see Step 2 below and `dependent-services-to-run-locally.md` §5).
3. **`conda` required for HOPE Python services:** Install/configure before expecting `stt`, `text`, `guardrail`, `nlp`, `harness`, `worker`, `stt-worker` to run.
4. **Local HOPE identity/config must match local seed:** lab `HOPE_SVC_*`, tenant IDs, and mappings will not work against local HOPE. Collect local values (Step 3).
5. **Isolate ALaaS data stores from HOPE:** use separate Postgres/Redis ports/instances for ALaaS to avoid collisions and data confusion.
6. **Secrets/env:** never commit `.env` files or paste secret values into docs/logs.

---

## 5) Procedure to execute the next steps

The steps below align with the 5-step plan: (1) API debug hookup in VS Code, (2) start HOPE services needed for consultations, (3) collect local HOPE values for ALaaS, (4) prepare ALaaS local Postgres/Redis and update envs, (5) start ALaaS and trigger consultation to debug API Gateway.

### Step 1 — API Gateway debug hookup in VS Code (`project-hope/apps/api`)

**Goal:** attach breakpoints in HOPE API Gateway while it serves requests on `8868`.

#### Option 1A (recommended now): Attach to the already-running API (no restart)
- The API is already running with `--inspect=127.0.0.1:9229` (PID `20102`).
- In VS Code, open workspace/folder **`/Users/apple/repos/VOX/project-hope`**.
- Use **Run and Debug → Attach to Node Process** and select PID `20102` (port `9229`), **or** add this launch configuration to `/Users/apple/repos/VOX/project-hope/.vscode/launch.json` under `"configurations"`:

```json
{
  "name": "Attach: HOPE API (9229)",
  "type": "node",
  "request": "attach",
  "address": "127.0.0.1",
  "port": 9229,
  "restart": true,
  "localRoot": "${workspaceFolder}",
  "remoteRoot": "${workspaceFolder}",
  "skipFiles": ["<node_internals>/**"]
}
```

- Set breakpoints in `apps/api/src/**/*.ts` (e.g. consultation controllers/services, auth/middleware, harness internal endpoints).
- If breakpoints are unverified, ensure source maps are available (API started with `--enable-source-maps`) and try rebuilding/restarting with watch if needed (`pnpm --filter @arcaai/api build` or `pnpm api:dev`).

#### Option 1B: Restart API under VS Code-controlled debugging
Use this if you want cleaner TS/watch/debug control.

1. **Stop the current background API** (frees `8868`/`9229`):
   ```bash
   # inspect tree if needed, then stop the dev process group/process
   ps -p 19132,20102 -o pid,ppid,command
   kill 19132 20102 2>/dev/null || true
   # verify ports free
   lsof -nP -iTCP:8868 -sTCP:LISTEN || true
   lsof -nP -iTCP:9229 -sTCP:LISTEN || true
   ```
   (If child processes remain, stop them explicitly; be careful not to kill unrelated node processes.)

2. **Start API in a debug-friendly way** from `/Users/apple/repos/VOX/project-hope`:
   - VS Code **JavaScript Debug Terminal**: run `pnpm api:dev` (auto-attaches in many setups), or
   - Terminal: `pnpm api:dev` (uses nest start `--debug ${API_INSPECT_HOSTPORT:-127.0.0.1:9229} --watch`) and attach via Option 1A.

3. **Verify:**
   ```bash
   curl -sS http://localhost:8868/api/v1/health; echo
   lsof -nP -iTCP:8868 -sTCP:LISTEN
   lsof -nP -iTCP:9229 -sTCP:LISTEN
   ```

**Exit criteria for Step 1:** VS Code debugger attached/ready and HOPE API healthy on `8868`.

---

### Step 2 — Start HOPE services needed for ALaaS-triggered consultations

**Goal:** run enough HOPE services behind the gateway so ALaaS consultation requests can progress beyond API-only failures.

#### 2.1 Prerequisite for Python services/workers (if needed)
- **Install `conda` if missing (macOS/darwin).** Choose one option:

  **Option A — Homebrew (recommended if `brew` is installed):**
  ```bash
  brew install --cask miniforge
  # then initialize/reload shell (one-time)
  conda init zsh
  exec zsh
  conda --version
  ```

  **Option B — Miniforge installer (no Homebrew):**
  ```bash
  # Apple Silicon (arm64)
  curl -L -O "https://github.com/conda-forge/miniforge/releases/latest/download/Miniforge3-MacOSX-arm64.sh"
  bash Miniforge3-MacOSX-arm64.sh
  # Intel (x86_64): use Miniforge3-MacOSX-x86_64.sh instead
  # then restart terminal or: source ~/.zshrc
  conda --version
  ```

  **Option C — Miniconda installer:**
  ```bash
  # Apple Silicon (arm64)
  curl -L -O "https://repo.anaconda.com/miniconda/Miniconda3-latest-MacOSX-arm64.sh"
  bash Miniconda3-latest-MacOSX-arm64.sh
  # Intel (x86_64): use Miniconda3-latest-MacOSX-x86_64.sh instead
  # then restart terminal or: source ~/.zshrc
  conda --version
  ```

  > After install, open a new terminal (or `source ~/.zshrc` / `exec zsh`) so `conda` is on `PATH`. Accept license/prompts as required by the installer; default install location is usually fine.

- **Set up HOPE Python environment** from `/Users/apple/repos/VOX/project-hope`:
  ```bash
  cd /Users/apple/repos/VOX/project-hope
  pnpm setup:python        # or :apple / :cpu / :gpu as appropriate for this machine
  # pnpm setup:python:check  # optional verification, if available in your setup
  ```
- Ensure required local model/runtime dependencies are available (e.g. LM Studio for text/guardrail if your local setup requires it).

#### 2.2 Choose startup mode

**Option 2A — Targeted services for consultation/summary (separate terminals, easier to debug):**
```bash
cd /Users/apple/repos/VOX/project-hope
# API already running/attached from Step 1; start others as needed
pnpm stt:dev
pnpm stt:worker:dev
pnpm text:dev
pnpm guardrail:dev
pnpm nlp:dev
pnpm harness:dev
pnpm worker:dev   # Temporal harness worker (required for harness/summary workflows)
```

**Option 2B — Targeted subset via stack supervisor (after API is in desired state):**
```bash
cd /Users/apple/repos/VOX/project-hope
pnpm stack:dev -- api stt stt-worker text guardrail nlp harness worker
```
> If using stack and you want VS Code-attached API control, prefer running API separately and starting the rest individually (Option 2A) to avoid supervisor restarts/conflicts.

**Option 2C — Full dev stack (end-to-end, heavier):**
```bash
pnpm stack:dev
```
> Previous run (2026-11-13) saw reranker `8870` bind race during `stack:dev`; ensure `hope-reranker` is stable first (`docker ps -a --filter name=hope-reranker`, `lsof -nP -iTCP:8870 -sTCP:LISTEN`).

#### 2.3 Verify
```bash
cd /Users/apple/repos/VOX/project-hope
pnpm stack:dev:doctor || true
curl -sS http://localhost:8868/api/v1/health; echo
for p in 8861 8862 8863 8864 8866; do
  echo "--- $p ---"; curl -sS --max-time 3 http://localhost:$p/health || true; echo
done
```
- Check Temporal UI `http://localhost:8233` if harness workflows are involved.
- If a service fails due to missing Vault secrets, ensure required values in `.env.dev` are not `CHANGE_ME`/empty and rerun `pnpm infra:dev:up` (reconcile/seed), then restart affected services.

**Scenario guidance (from dependency docs):**
- Basic connectivity/open consultation lifecycle: API + often `stt,text,guardrail,nlp` (+ `stt-worker` recommended)
- Live recording/transcripts: add `mmr_agent` (ALaaS) + `stt` + `stt-worker`
- Generate summary/harness workflows: add `harness` + `worker` + Temporal (already up)
- Approve/close (copy-to-EMR): API + consultation state/services as applicable

**Exit criteria for Step 2:** required HOPE services for your test scenario are running and health checks are acceptable.

---

### Step 3 — Collect local HOPE values needed by ALaaS

**Goal:** obtain **local** (not lab) credentials/config so ALaaS can authenticate and call local HOPE correctly.

Collect and record securely (do not commit):
- `HOPE_API_URL=http://localhost:8868`
- `HOPE_SVC_CLIENT_ID` / `HOPE_SVC_CLIENT_SECRET` valid in local HOPE (service account/client for realtime/consultation integration)
- `HOPE_WORKING_TENANT_ID` (and `HOPE_NER_TENANT_ID` if required by your flow)
- `ALAAS_HOPE_MAPPING` file/path and content valid for local tenant/departments/users/clinicians (regenerate if local seed differs)

**Where to obtain:** local HOPE seed outputs, admin console (`http://localhost:5176` if running), project-hope dev/setup docs/scripts, or environment-specific local config. If local HOPE DB was reseeded/reset, re-collect values and re-verify mappings.

**Exit criteria for Step 3:** all required local HOPE values and mapping are known and validated against local HOPE.

---

### Step 4 — Prepare ALaaS local Postgres/Redis and update ALaaS `.env` files

**Goal:** run ALaaS against its own local datastores and point ALaaS integration to local HOPE.

#### 4.1 Start/prepare ALaaS data stores (separate from HOPE)
- Start **ALaaS PostgreSQL** and **ALaaS Redis** on ports not conflicting with HOPE defaults (`5432`, `6379`) unless you intentionally reconfigured HOPE.
  - Example (choose your own): ALaaS PG `5433`, ALaaS Redis `6380`.
- Create DB/user/password/database for ALaaS and apply any required ALaaS schema/bootstrap (check `ALaaSv3.0` app docs/scripts if startup fails).

#### 4.2 Update `ALaaSv3.0/apps/audio-stream-svc/.env` (edit active file; backups `.env.indumati` exist)
Minimum/local-debug keys to review and set:

```ini
# HOPE (local)
HOPE_API_URL=http://localhost:8868
HOPE_SVC_CLIENT_ID=<local_hope_service_account_client_id>
HOPE_SVC_CLIENT_SECRET=<local_hope_service_account_client_secret>
HOPE_WORKING_TENANT_ID=<local_tenant_uuid>
# HOPE_NER_TENANT_ID=<local_ner_tenant_uuid_if_required>
HOPE_REALTIME_ADAPTER=vox-node
ALAAS_HOPE_MAPPING=config/alaas-hope-mapping.json

# ALaaS backend
PORT=4000
CLIENT_BASE_URL=http://localhost:5173
API_KEY=<dev value matching web_ui VITE_API_KEY>

# ALaaS DB (separate from HOPE DB)
PG_HOST=localhost
PG_PORT=<alaas_postgres_port>
DATABASE_HOST=localhost
DATABASE_PORT=<alaas_postgres_port>
DATABASE_USER=<alaas_db_user>
DATABASE_PASSWORD=<alaas_db_password>
DATABASE_NAME=<alaas_db_name>

# ALaaS Redis (separate from HOPE Redis)
REDIS_HOST=localhost
REDIS_PORT=<alaas_redis_port>
REDIS_PASSWORD=
REDIS_DB=0
```

Also review/replace lab-specific values as needed for your debug path (e.g. `WHISPER_STT_URL`, `AGENTIC_SDK_API_URL`, Azure/external EMR endpoints/tokens); avoid unintentionally using lab secrets/endpoints.

#### 4.3 Update `ALaaSv3.0/apps/web_ui/.env`
```ini
VITE_API_BASE_URL=http://localhost:4000
VITE_API_KEY=<same as audio-stream-svc API_KEY>
VITE_AUDIO_AGENT_BASE_URL=http://localhost:5001
VITE_AUDIO_AGENT_USERNAME=admin
VITE_AUDIO_AGENT_PASSWORD=admin

# HOPE/SDK endpoints for local (if used by web_ui flows)
VITE_SDK_API_ENDPOINT=http://localhost:8868
VITE_SDK_WEBSOCKET_URL=ws://localhost:8868
VITE_SDK_API_KEY=<local_or_required_value_for_your_setup>
```
Review lab-specific flags/endpoints/tokens and adjust for local debug.

#### 4.4 Restart affected processes
After editing `.env` files, restart `audio-stream-svc`, `web_ui`, and any related ALaaS processes so changes take effect.

**Exit criteria for Step 4:** ALaaS DB/Redis reachable, ALaaS `.env` files point to local HOPE and local ALaaS dependencies with correct local creds/mapping.

---

### Step 5 — Start ALaaS, trigger consultation, and debug HOPE API Gateway

**Goal:** trigger consultation requests from ALaaS UI and observe/debug them in HOPE API Gateway.

#### 5.1 Start ALaaS components (separate terminals recommended)

**(Optional, for live mic/recording) `mmr_agent`:**
```bash
cd /Users/apple/repos/VOX/ALaaSv3.0/apps/mmr_agent
# activate Python env as per app README
pip install -r requirements.txt
# pip install numpy slowapi python-jose passlib bcrypt websockets  # if needed
python src/audio_agent.py
# or: uvicorn src.audio_agent:app --reload --host 127.0.0.1 --port 5001
```
Verify: `curl -sS http://localhost:5001/health` and `curl -sS http://localhost:5001/list_mics`

**`audio-stream-svc`:**
```bash
cd /Users/apple/repos/VOX/ALaaSv3.0/apps/audio-stream-svc
lsof -ti :4000 | xargs kill -9 2>/dev/null || true
npm install
npm run build
npm run start:dev
```
Verify: `curl -sS http://localhost:4000/health` and protocol endpoint as applicable.

**`web_ui`:**
```bash
cd /Users/apple/repos/VOX/ALaaSv3.0/apps/web_ui
npm install
npm run dev
```
Open `http://localhost:5173`.

#### 5.2 Trigger consultation and debug
1. Ensure **HOPE API debugger is attached** in VS Code (Step 1) with breakpoints in relevant `apps/api/src` paths (consultation lifecycle, auth/service-token, internal harness callbacks, etc.).
2. From ALaaS UI, perform the scenario you need (e.g. open/start consultation, start/stop recording if `mmr_agent` running, generate summary, approve/close as applicable).
3. Observe request flow in VS Code debugger, HOPE API logs, and dependent HOPE service logs/workers.
4. If requests fail downstream, use `pnpm stack:dev:doctor`, service health endpoints, Temporal UI (`8233`), and service logs to isolate whether the issue is in API gateway, HOPE downstream services, or ALaaS config/mapping.

#### 5.3 Useful debug checkpoints
- **ALaaS:** consultation start/stop/generate-summary/approve handlers, HOPE adapter/client (`@arcaai/vox-node`) calls, mapping resolution.
- **HOPE API:** consultation endpoints, orchestration, `/api/v1/internal/harness/*`, auth/service-account validation, tenant/context handling.
- **HOPE harness/worker:** workflow execution and callback publishing when summary/harness is involved.

**Exit criteria for Step 5:** consultation requests from ALaaS reach HOPE API and can be inspected/debugged in VS Code; downstream flow works for the chosen scenario or failures are localized with evidence.

---

## 6) Quick rollback / restore notes

- ALaaS `.env` backups: `ALaaSv3.0/apps/audio-stream-svc/.env.indumati`, `ALaaSv3.0/apps/web_ui/.env.indumati` (restore by copying back if needed; restart services).
- Stop HOPE app services: `pnpm stack:dev:down` (if supervisor used) or stop individual terminals/processes; stop infra with `pnpm infra:dev:down` when done.
- Stop background HOPE API started in this session if needed: terminate PID `19132`/`20102` (and children) after confirming no other work depends on it.

---

## 7) Related files

- `review/ALaaSv3/fix-hope-api-vault-auth.md`
- `review/ALaaSv3/run-alaas-and-hope-locally-step-by-step.md`
- `review/ALaaSv3/dependent-services-to-run-locally.md`
- `review/ALaaSv3/deploy_console_20261113.log`
- `review/ALaaSv3/deploy_console_20261114.log`
- `review/ALaaSv3/agent_log/20261114-alaas-hope-debug-session.md`
- `ALaaSv3.0/docs/LOCAL_DEV_WITH_HOPE.md`
- `project-hope/docs/development-guide.md`, `project-hope/README.md`, `project-hope/.vscode/launch.json`
