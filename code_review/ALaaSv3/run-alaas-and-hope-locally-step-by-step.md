# Run ALaaSv3.0 + dependent HOPE locally (laptop) — step-by-step for VS Code debugging

**Goal:** Run `ALaaSv3.0` (demo branch) and its dependent `project-hope` backend services on your laptop so you can debug code in VS Code (instead of using lab/server dependencies).

**Repositories**
- ALaaS: `/Users/apple/repos/VOX/ALaaSv3.0` (branch: `demo-branch`)
- HOPE (backend dependencies): `/Users/apple/repos/VOX/project-hope`

**Already done (as requested)**
- `.env` backups created:
  - `/Users/apple/repos/VOX/ALaaSv3.0/apps/audio-stream-svc/.env.indumati`
  - `/Users/apple/repos/VOX/ALaaSv3.0/apps/web_ui/.env.indumati`

> **Do not commit `.env` files, tokens, certs, or secrets.**  
> This guide is documentation only (no commands executed by the agent).

---

## 0) What you are running locally (high level)

| Stack | Component | Why needed | Typical local endpoint/port |
|---|---|---|---:|
| HOPE infra | Postgres, Redis, Temporal (+UI), Vault, MinIO, Qdrant, reranker | HOPE persistence, queues/cache, workflows, secrets, storage, retrieval | 5432, 6379, 7233/8233, 8200, 9000-9001, 6333-6334, 8870 |
| HOPE apps | API gateway | ALaaS talks to HOPE through this (`HOPE_API_URL`) | `http://localhost:8868` |
| HOPE apps | STT + stt-worker | Realtime/batch transcription flows | 8861 + Dramatiq worker |
| HOPE apps | Text | LLM/text generation/summarization | 8862 |
| HOPE apps | Guardrail | Safety/guardrail checks | 8863 |
| HOPE apps | NLP | Medical NLP/NER/classification | 8864 |
| HOPE apps | Harness + worker | Clinical documentation workflows / summary-related harness execution | 8866 + Temporal worker |
| ALaaS | PostgreSQL + Redis | ALaaS app DB/Bull queues/cache | separate ports recommended if HOPE also local |
| ALaaS | `apps/mmr_agent` | Live mic capture/audio stream to browser UI | `http://localhost:5001` |
| ALaaS | `apps/audio-stream-svc` | ALaaS backend (NestJS) | `http://localhost:4000` |
| ALaaS | `apps/web_ui` | ALaaS frontend (Vite) | `http://localhost:5173` |

**Primary integration:** `ALaaS audio-stream-svc` → `HOPE_API_URL` (local `http://localhost:8868`) via `@arcaai/vox-node` / HOPE APIs. Local HOPE must be seeded/configured with valid local tenant/service-account/mapping data.

---

## 1) Prerequisites (install/prepare once)

### 1.1 Tools
- **Node.js >= 22** and **npm** (ALaaS `audio-stream-svc` requires Node >= 22)
- **pnpm 10** (project-hope), **Node >= 22.12** (per HOPE docs)
- **Docker + Docker Compose** (HOPE infra)
- **conda** + **uv** and Python env setup for HOPE Python services (see `project-hope/docs/development-guide.md`)
  - **Install conda if missing (macOS):** `brew install --cask miniforge && conda init zsh && exec zsh` (if Homebrew available), or download/run a Miniforge/Miniconda installer for your arch (`arm64`/`x86_64`) from conda-forge/anaconda, then restart terminal and verify with `conda --version`.
  - **After conda is installed:** `cd /Users/apple/repos/VOX/project-hope && pnpm setup:python` (or `:apple`/`:cpu`/`:gpu` as appropriate).
- **Python env for ALaaS `mmr_agent`** (if you need live microphone capture)
- **LM Studio** (or compatible local LLM runtime) if HOPE text/guardrail flows require it in your local setup (commonly `http://localhost:1234`)
- **VS Code**

> **Execution prereq check (2026-11-13, `deploy_console_20261113.log`):** `node v24.15.0`, `npm 12.1.0`, `pnpm 12.18.0`, `docker 29.8.0`/compose `v5.5.1`, `python3 3.14.7`, `uv 0.11.21` available; **`conda` not found** (`command not found`). Missing conda blocks `pnpm setup:python`/`arcaenv` and will prevent HOPE Python services/workers (`stt`, `stt-worker`, `text`, `guardrail`, `nlp`, `harness`, `worker`) from starting via `dev-service.sh`/`stack:dev` as documented. Install conda and run `pnpm setup:python` before debugging Python services.

### 1.2 Credentials/package access
- `GITHUB_TOKEN` with `read:packages` may be required for `@arcaai/*` npm packages in ALaaS/project-hope (export in your shell before installs).
- Have local HOPE seed/service-account credentials ready (lab credentials usually **will not** work against local HOPE).

### 1.3 Avoid port conflicts (important)
HOPE and ALaaS both use PostgreSQL/Redis by default. Run them on **separate instances/ports** and point each app to the correct one.
- **Recommended:** keep HOPE infra on defaults (PG 5432, Redis 6379) and run ALaaS DB/Redis on different ports (example: PG 5433, Redis 6380), **or** vice versa.
- If you keep ALaaS on `5432/6379`, then move HOPE infra ports and update HOPE env/config accordingly (more work). Prefer separate ALaaS DB/Redis ports.

---

## 2) Prepare and start `project-hope` (dependent backend)

Open a terminal in `/Users/apple/repos/VOX/project-hope`.

### Step 2.1 — Install dependencies (first time / as needed)
```bash
cd /Users/apple/repos/VOX/project-hope
pnpm install
# Python deps/env as per project-hope docs (example):
# pnpm setup:python
```
(If `@arcaai/*` packages are needed, ensure `GITHUB_TOKEN` with `read:packages` is exported first.)

### Step 2.2 — Bootstrap `.env.dev` and local environment (recommended first-time path)
```bash
cd /Users/apple/repos/VOX/project-hope
pnpm setup:dev
```
What `setup:dev` does (per `scripts/dev-setup.sh` / docs): creates/overwrites `.env.dev` from `.env.sample`, starts infra, waits for Postgres/Vault, applies DB schema/seed, refreshes Vault AppRole creds, bootstraps Vault dynamic DB creds, reconciles Vault kv-v2 secrets with `.env.dev`.

> **If you do not run `setup:dev` end-to-end**, you must still ensure `.env.dev` exists, infra is up, DB is migrated/seeded, **required secrets are defined/populated in `.env.dev` (not `CHANGE_ME`/empty for needed flows)**, and Vault is reconciled/seeded.

> **Execution note (2026-11-13, local run logged to `review/ALaaSv3/deploy_console_20261113.log`):** First `pnpm setup:dev` run progressed through `.env.dev` rebuild, infra startup, and Postgres/Vault readiness, but **failed at Step 3/6 (`pnpm db:all` → `prisma db push --schema=packages/database/src/prisma/db_main --force-reset --accept-data-loss`)** because Prisma refused the destructive reset when invoked from OpenCode (AI agent guard). Target: local dev Postgres `localhost:5432`, database `hope` (schemas `core, public`) in `hope-postgres` (development DB; reset is destructive).
>
> After explicit user consent, reran successfully with:
> ```bash
> cd /Users/apple/repos/VOX/project-hope
> PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION="<explicit consent message>" pnpm setup:dev
> ```
> Result: **EXIT_CODE=0**. DB schema force-pushed/reset, Prisma client generated, DB seeded, Temporal orphans terminated, Vault AppRole creds refreshed, Vault dynamic DB creds bootstrapped, and Vault kv-v2 secrets reconciled (**19 written, 0 unchanged, 3 skipped**: `AZURE_STORAGE_CONNECTION_STRING`, `AZURE_STORAGE_ACCOUNT_KEY`, `LM_STUDIO_API_TOKEN` left absent/not set). `setup:dev` rebuilt `.env.dev` from `.env.sample` while carrying forward existing secret/credential values.

### Step 2.3 — Define and populate required secrets in `.env.dev` (required step)

> **Do not skip this step.** HOPE uses Vault kv-v2 for registered secrets in dev (reconciled from `.env.dev`). `scripts/vault-seed-secrets.sh` (run during `setup:dev` and `infra:dev:up`) **skips any secret that is empty or exactly `CHANGE_ME`** and leaves it **absent** in Vault (not written as empty). Fail-closed consumers will fail until required secrets are set and seeded.

**2.3.1 — Generate/build `.env.dev` and auto-fill local secrets (if needed)**
```bash
cd /Users/apple/repos/VOX/project-hope
# creates/rebuilds .env.dev from .env.sample and carries forward existing secret/credential values
./scripts/generate-env-file.sh .env.dev dev
```
- This auto-generates many **local/synthesizable** secrets (signing keys, peppers, internal/service tokens, aligned local storage creds, etc.) when still `CHANGE_ME`.
- Do **not** use `FRESH_SECRETS=1` unless you intentionally want rotation (can invalidate tokens/sessions/hashes/peppers and require restarts/reseed).
- `pnpm setup:dev` also builds `.env.dev` (Step 0) and later refreshes Vault AppRole creds and reconciles Vault secrets; you may still need to manually define/fill remaining values after bootstrap.

**2.3.2 — Review `.env.dev` and fill remaining secrets (manual/operator-supplied)**
Open `/Users/apple/repos/VOX/project-hope/.env.dev` and replace `CHANGE_ME` / required empty values:

| Secret type | What to do | Examples (non-exhaustive) |
|---|---|---|
| **Auto-generated local secrets** | Usually filled by `generate-env-file.sh` / setup; verify not `CHANGE_ME` | `JWT_SECRET_KEY`, `SESSION_SECRET_KEY`, `API_KEY_PEPPER`, `INTERNAL_ACCESS_TOKEN`, `HARNESS_*_TOKEN`, peppers, local MinIO/S3/Redis/MQTT aligned creds (as applicable) |
| **Minted by later setup steps** | Let setup/refresh scripts manage (do not paste placeholders) | `VAULT_SECRET_ID`, dynamic DB creds flow/AppRole-related values refreshed by `refresh-vault-creds.sh` / `setup-dev-vault-db.sh` |
| **External/provider credentials** | Provide real keys/connection details only if that integration is used; otherwise leave unset/`CHANGE_ME` and expect related features to remain unavailable/fail-closed | `AZURE_STORAGE_CONNECTION_STRING`, `AZURE_STORAGE_ACCOUNT_KEY`, `LM_STUDIO_API_TOKEN` (if LM Studio auth enabled), cloud/provider API keys |
| **Infrastructure/system-matched credentials** | Must match the actual local/provisioned services (or consistent local defaults) | Redis/MinIO/MQTT/DB credentials and endpoints as required by your environment |

> `generate-env-file.sh` reports remaining placeholders at the end (and distinguishes external/minted/unclassified cases). Use that output to decide what must be filled now vs what can remain unset for your debug scenario.

**2.3.3 — Reseed/reconcile secrets into Vault and verify**
```bash
cd /Users/apple/repos/VOX/project-hope
pnpm infra:dev:up
```
- This reconciles Vault AppRole creds and kv-v2 secrets from `.env.dev`.
- Check the seeding summary: required secrets should be `write` / `update` / `unchanged`, not `SKIP (not set in environment)`.
- If any required secret is still `SKIP`, set a real value in `.env.dev` and rerun the command.
- If HOPE services were already running, **restart them** after reseeding (and recheck `pnpm stack:dev:doctor` / health endpoints).

**2.3.4 — (Optional) Verify values in `.env.dev` before seeding**
```bash
cd /Users/apple/repos/VOX/project-hope
grep -n "CHANGE_ME" .env.dev | head -40
```
(Expect only intentionally unused external/provider secrets to remain, depending on your setup.)

### Step 2.4 — Ensure HOPE infra is up
```bash
cd /Users/apple/repos/VOX/project-hope
pnpm infra:dev:up
```
This starts/reconciles infra (Postgres/Redis/Temporal/Vault/MinIO/Qdrant/reranker profiles as configured) and performs Vault reconciliation.

### Step 2.5 — Start HOPE services (choose one mode)

#### Option A (recommended for end-to-end debug): full app stack
```bash
cd /Users/apple/repos/VOX/project-hope
pnpm stack:dev
```
Default stack typically includes: `api, stt, stt-worker, text, guardrail, nlp, harness, worker, checkpoint-worker, admin`.

#### Option B (targeted, faster): start only services needed for ALaaS consultation/summary
```bash
cd /Users/apple/repos/VOX/project-hope
pnpm stack:dev -- api stt stt-worker text guardrail nlp harness worker
```

#### Option C (best for VS Code debugging): run services in separate terminals
Run each in its own terminal (easy to stop/restart/attach debugger/logs):
```bash
cd /Users/apple/repos/VOX/project-hope
pnpm api:dev
pnpm stt:dev
pnpm stt:worker:dev
pnpm text:dev
pnpm guardrail:dev
pnpm nlp:dev
pnpm harness:dev
pnpm worker:dev
# optional
pnpm admin:dev
```
> **Note:** `worker` is the Temporal harness worker (required for harness/summary workflows). `stt-worker` is separate from STT API. If LM Studio is used by text/guardrail in your setup, start/load the model before testing those flows.

> **Execution note (2026-11-13, `deploy_console_20261113.log`):** Attempted `pnpm stack:dev` in background (`STEP 2.5`) but it exited/failing during infra ensure with `Error response from daemon: ports are not available ... 0.0.0.0:8870 ... bind: address already in use` (reranker). At that time `hope-reranker` container was restarting; later diagnostics showed reranker container up and port 8870 bound by Docker (`hope-reranker` running, `docker logs` showed model warmup/start). **Workaround:** ensure reranker is healthy/stable before running `stack:dev` (e.g. `docker ps -a --filter name=hope-reranker`, restart/wait if needed), or start app services separately after infra is stable.
>
> Manual recovery attempt: started `pnpm api:dev` in background, but API failed to boot with `VaultSecretsProvider.boot() FATAL: cannot authenticate to Vault (http://localhost:8200) — timeout of 5000ms exceeded` (Vault container/health endpoint were reachable: `http://localhost:8200/v1/sys/health` returned 200, `vault status` unsealed). `.env.dev` had `SECRETS_PROVIDER=vault`, `VAULT_ADDR=http://localhost:8200`, `VAULT_REQUEST_TIMEOUT_MS=5000`, `PG_DYNAMIC_CREDS=false`, and `VAULT_ROLE_ID/VAULT_SECRET_ID` set. **Needs investigation/fix before HOPE API can start:** verify AppRole creds are valid/current (rerun `./scripts/refresh-vault-creds.sh` or `pnpm infra:dev:up`), consider increasing `VAULT_REQUEST_TIMEOUT_MS`, and inspect `apps/api`/Vault provider logs. Python HOPE services were not started due to missing `conda`/`arcaenv` on this machine.

### Step 2.6 — Verify HOPE is ready
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
(Optional UI checks): Temporal UI `http://localhost:8233`, Vault UI `http://localhost:8200`, Admin console `http://localhost:5176` (if started).

### Step 2.7 — Collect local HOPE values needed by ALaaS
From your **local** HOPE environment (seed output/admin console/config, not lab), collect:
- `HOPE_API_URL` = `http://localhost:8868`
- Local HOPE service account/client credentials for realtime/consultation integration (`HOPE_SVC_CLIENT_ID`, `HOPE_SVC_CLIENT_SECRET`) valid in **local** HOPE
- Local working tenant ID (`HOPE_WORKING_TENANT_ID`) and any NER tenant ID required by your setup
- A valid ALaaS↔HOPE mapping file/content for local tenant/departments/users (`ALAAS_HOPE_MAPPING`), or regenerate mapping if your local seed differs

> **Important:** Reseeding/resetting HOPE can invalidate credentials, tenant data, mappings, and provider/config state. Re-verify ALaaS env and mapping after reseed.

---

## 3) Prepare ALaaS local data stores (separate from HOPE)

ALaaS `audio-stream-svc` uses its own PostgreSQL and Redis (`PG_*`, `DATABASE_*`, `REDIS_*` in `apps/audio-stream-svc/.env`).

1. Start a PostgreSQL instance and Redis instance for **ALaaS** (separate ports from HOPE if HOPE uses defaults).
2. Create/configure ALaaS DB credentials/database (match values you will set in ALaaS `.env`).
3. Ensure ALaaS can connect (migrations/schema bootstrap may be required depending on ALaaS app behavior; check `ALaaSv3.0` app docs/scripts if startup fails on DB).

**Example local target values (choose your own):**
- ALaaS Postgres: `localhost:5433`, db/user/password as configured
- ALaaS Redis: `localhost:6380`

---

## 4) Update ALaaSv3.0 `.env` files to use local HOPE and local ALaaS dependencies

Backups already exist (`.env.indumati`). Edit the active `.env` files (not the backups).

### Step 4.1 — `ALaaSv3.0/apps/audio-stream-svc/.env`

Update at minimum (adapt to your local setup):
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

# ALaaS DB (point to ALaaS DB instance, not HOPE DB)
PG_HOST=localhost
PG_PORT=<alaas_postgres_port>
DATABASE_HOST=localhost
DATABASE_PORT=<alaas_postgres_port>
DATABASE_USER=<alaas_db_user>
DATABASE_PASSWORD=<alaas_db_password>
DATABASE_NAME=<alaas_db_name>

# ALaaS Redis (point to ALaaS Redis instance)
REDIS_HOST=localhost
REDIS_PORT=<alaas_redis_port>
REDIS_PASSWORD=
REDIS_DB=0
```

**Also review/change lab-specific values if they affect your debug path:**
- `WHISPER_STT_URL` / `WHISPER_STT_MODEL` (currently lab endpoints)
- `AGENTIC_SDK_API_URL`, `VITE_SDK_*`, `OPENAI_API_BASE`, Azure keys/endpoints, external EMR URLs/tokens (set only what you need; avoid using lab secrets/endpoints unintentionally)
- Keep/remove unused lab integrations disabled for local debug where possible.

### Step 4.2 — `ALaaSv3.0/apps/web_ui/.env`

Ensure frontend points to local backend and local audio agent:
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

Review lab-specific values (`OPENAI_API_BASE`, external EMR, tokens, mock flags) and adjust for your local debug scenario.

> After editing `.env` files, restart the corresponding service(s).

---

## 5) Start ALaaSv3.0 services (after HOPE is ready)

Open separate terminals (recommended for debugging).

### Step 5.1 — (Optional but needed for live mic) Start `mmr_agent`
```bash
cd /Users/apple/repos/VOX/ALaaSv3.0/apps/mmr_agent
# activate your Python env first (conda/venv) as per app README
pip install -r requirements.txt
# if needed per README:
# pip install numpy slowapi python-jose passlib bcrypt websockets
python src/audio_agent.py
# or: uvicorn src.audio_agent:app --reload --host 127.0.0.1 --port 5001
```
Verify:
```bash
curl -s http://localhost:5001/health
curl -s http://localhost:5001/list_mics
```

### Step 5.2 — Start ALaaS backend (`audio-stream-svc`)
```bash
cd /Users/apple/repos/VOX/ALaaSv3.0/apps/audio-stream-svc

# Free port 4000 if already in use
lsof -ti :4000 | xargs kill -9 2>/dev/null

# Install dependencies and build
npm install
npm run build

# Start dev server
npm run start:dev
```
Expected: `http://localhost:4000`

Verify:
```bash
curl -s http://localhost:4000/health
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:4000/api/v1/consultation/protocol
```

### Step 5.3 — Start ALaaS frontend (`web_ui`)
```bash
cd /Users/apple/repos/VOX/ALaaSv3.0/apps/web_ui
npm install
npm run dev
```
Expected: `http://localhost:5173`

---

## 6) VS Code debugging workflow (practical)

### 6.1 Recommended layout
- Open one VS Code window (or workspace) at `/Users/apple/repos/VOX/ALaaSv3.0` for ALaaS debugging.
- Open another VS Code window at `/Users/apple/repos/VOX/project-hope` for HOPE service debugging (especially `apps/api`, `apps/harness`, Python services/workers).
- Run infra and long-running workers in terminals; debug the specific service you are editing.

### 6.2 Debug strategy
- **ALaaS (`audio-stream-svc`, NestJS):** run `npm run start:dev` in a VS Code terminal or use a Node/Nest debug launch config if available in that repo. Set breakpoints in ALaaS controllers/services that call HOPE.
- **HOPE API (`apps/api`, NestJS):** run `pnpm api:dev` (or start via stack) and attach VS Code Node debugger to that process, or create/use a launch config in `project-hope` for `apps/api`.
- **HOPE Python services (`stt/text/guardrail/nlp/harness`):** use Python debug configurations in VS Code (FastAPI/uvicorn/module run) or run service normally and attach if your setup supports it. Run `stt-worker` / harness `worker` in separate terminals when debugging queue/workflow issues.
- **Frontend (`web_ui`):** use browser DevTools + VS Code JS debugger (Chrome/Edge attach) if needed.

### 6.3 What to debug for the consultation flow (typical breakpoints)
- **ALaaS:** consultation start/stop/generate summary/approve endpoints, HOPE client/adapter integration (`@arcaai/vox-node` usage), mapping resolution, request/response mapping.
- **HOPE API:** consultation lifecycle endpoints, summary generation orchestration, `/api/v1/internal/harness/*` callbacks, auth/service-token validation.
- **HOPE Harness/worker:** `HarnessDocWorkflow` execution path, callback publishing to API internal endpoints.
- **STT/Text/Guardrail/NLP:** only if debugging model/transcript/NLP/guardrail stages.

---

## 7) End-to-end verification checklist (local)

### 7.1 HOPE
```bash
cd /Users/apple/repos/VOX/project-hope
pnpm stack:dev:doctor
curl -s http://localhost:8868/api/v1/health
```
(Optionally check 8861/8862/8863/8864/8866 health endpoints.)

> **Execution result (2026-11-13):** `pnpm stack:dev:doctor` failed with required checks failing (app services not running; LM Studio unavailable; STT `API_GATEWAY_KEY` placeholder/missing; reranker warning at check time). Health curls for 8868/8861/8862/8863/8864/8866 returned no response because services were not up.

### 7.2 ALaaS
```bash
curl -s http://localhost:4000/health
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:4000/api/v1/consultation/protocol
curl -s http://localhost:5001/health   # if mmr_agent running
```
Open `http://localhost:5173` and test: login/open consult → start recording (needs `mmr_agent`) → stop → generate summary → approve/save-copy flow.

> **Execution status (2026-11-13):** Not executed in this run. Steps 3–5 (ALaaS DB/Redis separation and startup, ALaaS `.env` changes to local HOPE/local stores, `mmr_agent`/`audio-stream-svc`/`web_ui` startup) were blocked pending a working local HOPE stack and local ALaaS datastore/env configuration (including local HOPE service-account/tenant/mapping values). Existing ALaaS `.env` files still point to lab HOPE endpoints/credentials and shared local ports as observed earlier.

---

## 8) Common issues and fixes

| Symptom | Likely cause | Fix |
|---|---|---|
| `pnpm infra:dev:up` shows many Vault secrets `SKIP (not set in environment)` | `.env.dev` values are empty or `CHANGE_ME`; `vault-seed-secrets.sh` leaves them absent (fail-closed) | Set real/generated values in `project-hope/.env.dev`, rerun `pnpm infra:dev:up` (or seed step), confirm `write/update/unchanged`, restart HOPE services |
| HOPE services fail on auth/secret-dependent behavior after infra up | Vault kv-v2 secrets not actually seeded; AppRole creds stale | Reconcile Vault (`pnpm infra:dev:up`), refresh Vault creds/setup as per `setup:dev`, restart services |
| `pnpm stack:dev` exits with `ports are not available ... 8870 ... bind: address already in use` | Reranker container restarting/port race while stack ensures infra | Check `docker ps -a --filter name=hope-reranker`, `lsof -nP -iTCP:8870 -sTCP:LISTEN`, and reranker logs; wait for `hope-reranker` to stabilize or restart it, then rerun `stack:dev` or start app services separately (observed 2026-11-13) |
| HOPE API fails with `VaultSecretsProvider.boot() FATAL: cannot authenticate to Vault ... timeout` | AppRole auth/creds issue, Vault request timeout, or provider/env mismatch even if Vault is healthy | Verify Vault reachable (`curl http://localhost:8200/v1/sys/health`, `vault status`), refresh AppRole creds (`./scripts/refresh-vault-creds.sh` / `pnpm infra:dev:up`), confirm `VAULT_ROLE_ID/VAULT_SECRET_ID` in `.env.dev`, consider increasing `VAULT_REQUEST_TIMEOUT_MS`, restart API and inspect logs (observed 2026-11-13) |
| HOPE Python services/workers cannot start (`conda`/`arcaenv` missing) | conda not installed or Python env not bootstrapped | Install conda (Miniconda/Miniforge), run `pnpm setup:python` (and service-specific setup if needed), then start `stt/text/guardrail/nlp/harness` and `stt-worker`/`worker` |
| ALaaS cannot reach HOPE / 401/403/tenant errors | `HOPE_API_URL` still lab, or local HOPE creds/tenant/mapping don’t match local seed | Set `HOPE_API_URL=http://localhost:8868`, use local service account/client secret, local `HOPE_WORKING_TENANT_ID`, and correct `ALAAS_HOPE_MAPPING` |
| Summary/harness flow stuck pending/queued | `harness` app or Temporal `worker` not running (or Temporal infra unavailable) | Start `harness` + `worker` + Temporal; check Temporal UI/logs and service health |
| Transcripts/batch jobs not progressing | `stt-worker` not running (separate from STT API) | Start `pnpm stt:worker:dev` |
| Port conflicts / wrong DB data | HOPE and ALaaS sharing same Postgres/Redis ports/instances | Use separate ALaaS DB/Redis ports and update ALaaS `PG_*`/`DATABASE_*`/`REDIS_*` |
| Text/guardrail failures in local HOPE | LM Studio/model runtime not running/configured as expected | Start/configure LM Studio (or local runtime) and restart affected HOPE services |
| `npm install` fails for `@arcaai/*` | Missing `GITHUB_TOKEN` with `read:packages` | Export token in shell before install/build |
| ALaaS backend starts but consultation/stream issues occur | `mmr_agent` not running, env mismatch (`VITE_API_BASE_URL`, `API_KEY`), HOPE deps not ready | Verify `mmr_agent` health, env alignment, and HOPE `stack:dev:doctor`/service health |
| After changing `.env` | Process still using old values | Restart the affected service(s) (Nest/Vite/Python workers/watchers as needed) |

---

## 9) Suggested startup/shutdown order

**Startup**
1. HOPE infra + Vault reconciliation (`pnpm infra:dev:up`) and ensure `.env.dev` secrets are seeded (not `CHANGE_ME`)
2. HOPE app services (`pnpm stack:dev` or targeted subset; include `harness` + `worker` for summary flows)
3. ALaaS PostgreSQL + Redis (separate from HOPE)
4. ALaaS `mmr_agent` (if live recording)
5. ALaaS `audio-stream-svc`
6. ALaaS `web_ui`

**Shutdown** (reverse)
1. `web_ui`
2. `audio-stream-svc`
3. `mmr_agent`
4. ALaaS Redis/Postgres (if you started them manually)
5. HOPE app services (`pnpm stack:dev:down` if using supervisor)
6. HOPE infra (`pnpm infra:dev:down` when done)

---

## 10) Related docs in this folder
- `review/ALaaSv3/run-alaas-demo-branch.md` (quick-start commands provided earlier)
- `review/ALaaSv3/dependent-services-to-run-locally.md` (dependency matrix, ports, env changes, gotchas)
- `review/ALaaSv3/console_infra_up.txt` (example showing Vault secrets skipped due to `CHANGE_ME` placeholders)
- `review/ALaaSv3/deploy_console_20261113.log` (console output log from attempted step-by-step execution on 2026-11-13)

**Primary source docs/code**
- `ALaaSv3.0/docs/LOCAL_DEV_WITH_HOPE.md`
- `project-hope/docs/development-guide.md`, `project-hope/README.md`, `project-hope/scripts/README.md`
- `project-hope/scripts/dev-setup.sh`, `dev-infra.sh`, `generate-env-file.sh`, `vault-seed-secrets.sh`, `dev-stack.sh`
