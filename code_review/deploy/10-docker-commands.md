# 10 — Docker Commands (Local Stack Reference)

Quick-reference cheat sheet for the local `test-hope-*` Docker stack.
All commands run from your Mac terminal (`/Users/apple/repos/VOX`).
`docker exec -it <container> <cmd>` = run a command **inside** the container
interactively; the "internal" commands below are what you type once you're in.

---

## Stack inventory (current containers)

| Container        | Image                    | Host port(s)        | Role                              |
|------------------|--------------------------|---------------------|-----------------------------------|
| hope-postgres    | timescaledb-ha:pg18      | 5432                | Postgres + TimescaleDB (main DB)  |
| hope-redis       | redis:8-alpine           | 6379                | Redis (SMR queue, sessions, etc.) |
| hope-minio       | minio/minio              | 9000 (API) / 9001 (UI) | Object storage (S3 buckets)     |
| hope-lmstudio    | ollama/ollama            | 1234→11434          | "LM Studio" emulation (Ollama)    |
| test-hope-api    | hope-v2/api:local        | 8868                | Gateway (auth + proxies)          |
| test-hope-smr    | hope-v2/smr:local        | 8862                | LLM generation (stateless)        |
| test-hope-stt    | hope-v2/stt:local        | 8861                | Speech-to-text                    |
| test-hope-tts    | hope-v2/tts:local        | 8865                | Text-to-speech                    |
| test-hope-nlp    | hope-v2/nlp:local        | 8864                | Clinical NLP                      |
| test-hope-guardrail | hope-v2/guardrail:local | 8863             | Guardrails                        |
| test-hope-harness | hope-v2/harness:local   | 8866                | Task orchestration                |
| test-hope-admin  | hope-v2/admin-console:local | 3000             | Admin web console                 |

```
docker ps                             # list running containers + ports
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Ports}}'
docker logs -f test-hope-smr          # tail container logs
docker logs --tail 50 test-hope-smr   # last N lines
```

---

## 1. Postgres (`hope-postgres`)

DB name: `hope` · user: `postgres` · schema (tables live here): **`core`**

```
# Interactive psql
docker exec -it hope-postgres psql -U postgres -d hope

# One-off query (no interactive mode)
docker exec hope-postgres psql -U postgres -d hope -c 'SELECT 1;'
```

### Useful psql queries (type these inside psql)

```sql
-- list tables in the core schema
\d core.*
\dt core.*

-- SMR default model selection (the DB layer that decides the LLM provider/model)
SELECT "taskKey", "modelSlug", "tenantId"
  FROM core."AiTaskDefault"
 WHERE "taskKey" LIKE 'smr.%'
 ORDER BY "taskKey";

-- how a model slug resolves to provider + source model id
SELECT slug, provider, "sourceUri", "resourceStatus", "taskType"
  FROM core."AiModel"
 WHERE slug = 'lms-gemma-4-e2b-it-qat';

-- tenants
SELECT id, name, key FROM core."Tenant";
--   System __SYSTEM__  /  Global __GLOBAL__  /  ArcaAI ARCAAI

-- STT pipeline selection (Azure/local whisper varies per pipeline row)
SELECT id, name, loader, "isDefault"
  FROM core."Pipeline"
 WHERE "name" LIKE '%stt%' OR "name" LIKE '%speech%';
```

Updates are the same thing with `UPDATE`:

```sql
UPDATE core."AiTaskDefault"
   SET "modelSlug" = 'lms-gemma-4-e2b-it-qat'
 WHERE "taskKey" IN ('smr.live','smr.finalize','smr.test')
   AND "tenantId" = '00000000-0000-0000-0000-000000000000';
```

---

## 2. MinIO / S3 buckets (`hope-minio`)

The server image ships the `mc` client. Credentials: `minio_admin` / `minio_admin`.
API on port 9000, web console on 9001.

```
# Set up the alias once, then list
docker exec -it hope-minio sh -c 'mc alias set local http://localhost:9000 minio_admin minio_admin && mc ls local'
```

Known buckets: `backups`, `documents`, `generated-audio`, `hope-audio`,
`hope-audio-chunks`, `mlflow`, `recordings`.

```sh
# Inside the container (interactive shell):
mc ls local                              # list buckets
mc ls local/hope-audio/                  # list objects in a bucket
mc find local/hope-audio --name '*.wav'  # find objects
mc cp local/hope-audio/my.wav ./         # download an object
mc cp ./my.wav local/documents/          # upload an object
mc rm local/hope-audio/old.wav           # remove an object
mc admin info local                      # server health / disk usage
```

GUI alternative: open http://localhost:9001 and log in with the same creds.

---

## 3. Redis (`hope-redis`)

No password locally. Used by SMR (queues, task state), sessions, etc.

```
docker exec -it hope-redis redis-cli          # interactive
docker exec hope-redis redis-cli ping         # → PONG (health)
```

```sh
# Inside redis-cli:
KEYS *                # list all keys (pipe to grep if huge)
DBSIZE                # count of keys
TTL <key>             # remaining expiry
INFO memory           # memory stats
MONITOR               # live stream of commands (careful, noisy)
FLUSHDB               # wipe current DB — ONLY for a throwaway dev state
```

---

## 4. Ollama — the "LM Studio" emulation (`hope-lmstudio`)

**Not** the LM Studio desktop app. It is Ollama mapped to host port 1234 so SMR's
default OpenAI-compatible provider works. The "model configured in (emulated) LM
Studio" = an ollama alias tag mapping a DB model id to physical weights in the
shared store (`~/.ollama` on host → `/root/.ollama` in container).

```
docker exec -it hope-lmstudio ollama list     # tags + real sizes
docker exec -it hope-lmstudio ollama ps       # models currently loaded in RAM
docker exec -it hope-lmstudio ollama show gemma-4-e2b-it-qat --modelfile
#   → shows "FROM qwen2.5:3b" — the real weights behind the alias
```

```sh
# Create / re-point a model id to local weights (the "pick a model in LM Studio" action)
docker exec -it hope-lmstudio sh -c 'printf "FROM qwen2.5:3b\n" > /tmp/Modelfile \
  && ollama create gemma-4-e2b-it-qat -f /tmp/Modelfile'

# Interactive chat with a model
docker exec -it hope-lmstudio ollama run qwen2.5:3b "Respond with exactly: FAST OK"

# OpenAI-compatible check (same thing the smr lm-studio provider calls):
curl -s -X POST http://localhost:1234/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"gemma-4-e2b-it-qat","messages":[{"role":"user","content":"say OK"}],"max_tokens":16}'
```

Current mapping on this box: `gemma-4-e2b-it-qat` (SMR default, provider
`lm-studio`) → **qwen2.5:3b** weights (fast, ~4 tok/s). `llama3` (slow ~0.7 tok/s)
is still in the store, not aliased.

---

## 5. Service containers (test-hope-*)

All app services: exec a shell (`sh` works in the python and node images).

```
docker exec -it test-hope-smr sh        # shell inside SMR
docker exec -it test-hope-smr cat /proc/1/cmdline   # show how the process launched
docker logs -f test-hope-smr           # follow logs from host
```

Common one-liners:

```
docker exec test-hope-smr env | grep SMR_          # SMR env config
docker logs --tail 100 test-hope-api               # gateway logs
docker exec -it test-hope-api sh                   # shell in the gateway
```

---

## 6. Health checks + the SMR→LLM verification chain (from host)

```
# per-service liveness/readiness
curl -s http://localhost:8862/api/v1/health/ready   # SMR → {"status":"healthy"}
curl -s http://localhost:8862/api/v1/health/live
curl -s http://localhost:8862/api/v1/providers      # all providers + probes

# full health incl. per-component checks (who is reported in the admin portal)
curl -s http://localhost:8862/api/v1/health         # SMR → healthy/degraded/unhealthy + checks
curl -s http://localhost:8861/api/v1/health         # STT → healthy when REDIS_URL is set
```

SMR `/health` semantics: providers registered WITHOUT a connection config report
`"not-configured"` (BYO clouds azure/openai/anthropic/vertex/bedrock + the
optional vLLM/llama.cpp until `base_url` is pointed at a server). They are listed
for diagnostics but EXCLUDED from the aggregate — the overall status only reflects
configured providers (`redis` + `lm-studio`/`openai_compat` + `ollama` here). So
`degraded` no longer appears just because the cloud BYO engines have no platform
credentials. `/health/ready` is liveness+config and stays healthy.

STT health gotcha: `stt.core.config.settings.Settings` has NO env prefix, so the
`redis_url` field reads env var `REDIS_URL` (NOT `STT_REDIS_URL`). The container
MUST be run with `-e REDIS_URL=redis://host.docker.internal:6379/0`, or the redis
check hits `localhost:6379` and `/health` reports `unhealthy`.

```
# gateway fan-out: what the admin portal actually shows
TOKEN=$(curl -s -X POST http://localhost:8868/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"super_admin","password":"password123"}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")
curl -s http://localhost:8868/api/v1/health/services -H "Authorization: Bearer $TOKEN"
#   → {"status":"healthy","services":{"smr":"healthy","stt":"healthy",...}}
#     (gateway mirrors each upstream's status verbatim)

# full gateway chain (DB-default resolution):
# 1) login as a tenant-bound user (GLOBAL_ADMIN has NO tenant id → default path 400s)
TOKEN=$(curl -s -X POST http://localhost:8868/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"arcaai_admin","password":"password123","tenantKey":"ARCAAI"}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")

# 2) generate with NO model — gateway resolves smr.live default from the DB
curl -s -X POST http://localhost:8868/api/v1/text/generate \
  -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" \
  -d '{"prompt":"Respond with exactly: FAST OK"}'
```

Seeded login accounts (password `password123`): `super_admin` (GLOBAL_ADMIN,
no tenant), `global_admin`, `tenant_admin`, `arcaai_admin` (tenant `ARCAAI`),
plus clinical users (`arcaai_doctor`, `arcaai_nurse`, …).

---

## Quick palette — one-liners

```sh
docker ps -a                                    # all containers incl. stopped
docker inspect test-hope-smr --format '{{range .Config.Env}}{{println .}}{{end}}'
docker rm -f test-hope-smr                      # remove & recreate (see note below)
docker network ls
```

**Recreating a service container** (e.g. SMR after an env change): the `hope-v2/*`
images bake their own entrypoint, so `docker run` with a trailing command
**overrides** it — do NOT repeat the command, or you get
`Usage: python -m uvicorn ... No such option: -m`. Just pass env vars + ports.