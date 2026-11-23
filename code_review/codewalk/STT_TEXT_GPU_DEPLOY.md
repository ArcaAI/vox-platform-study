# STT + TEXT Deployment — GPU Server + k3s Infrastructure

This runbook brings up **STT** (GPU) and **TEXT** so they serve the **API Gateway** APIs,
in a topology where:

- **GPU server** (Docker host, NVIDIA GPU, separate machine) runs the STT inference API and the STT batch-transcription worker.
- **k3s cluster** (CPU-only nodes) hosts the infra: PostgreSQL, Redis, MinIO ("Silos"), Vault, API Gateway, Guardrail, NLP, Harness — **and TEXT**.

Everything below was verified against source in `project-hope/`:

- `apps/stt/docker/Dockerfile` (build targets `runtime` / `ml-runtime` / `worker`)
- `apps/stt/src/stt/core/config/settings.py` (full env surface)
- `apps/stt/src/stt/core/api_client/gateway.py` (STT→gateway callbacks)
- `apps/text/Dockerfile`, `apps/text/src/text/core/config.py`, `apps/text/.env.prod`
- `apps/api/.env.prod`, `apps/api/docs/04-deployment-guide.md` (gateway `STT_URL`/`TEXT_URL`)
- `infrastructure/docker/docker-compose.yml` (infra ports, MinIO bucket provisioning)

The per-service **Deployment/Service manifests** for the k3s fleet live in the separate
`arca/hope-v2-deployment` repository (`deployment/k8s/base/*.yaml`), referenced from the
STT Dockerfile comments. That repo does **not** exist inside `project-hope`; the sections
here that touch k3s give the YAML/env that must be wired into those manifests.

---

## 1. Decisions (confirmed with DevOps)

| # | Decision | Value |
|---|----------|-------|
| D1 | Where STT runs | GPU server (Docker): `stt:ml-runtime` API container + `stt:worker` batch container, both on the same cards |
| D2 | Where TEXT runs | **k3s cluster** (TEXT is a CPU-only provider proxy — no CUDA layer in its image) |
| D3 | GPU | NVIDIA **RTX 6000 Ada Generation**, compute capability **sm_89** (CUDA UMD 13.3 driver) → `CUDA_ARCHITECTURES` must cover `89` |
| D4 | Registry | Private container registry shared by k3s and the GPU host |
| D5 | Secrets on GPU host | Mounted **env file** (systemd `EnvironmentFile=` / `--env-file`); credentials are `vault-kv` `minio.accessKey`/`minio.secretKey` + shared `INTERNAL_ACCESS_TOKEN` + a registered gateway `ApiKey` |
| D6 | GPU→k3s connectivity | **NodePort Services** on the k3s nodes (Traefik cannot proxy raw TCP Redis; see §4) |
| D7 | STT worker | Runs on the GPU server beside the API container (Dramatiq; needs Redis + MinIO + gateway) |

> **Misconception resolved:** the original premise was "STT **and** TEXT need GPU". Only
> STT does. `apps/text/Dockerfile` has a single CPU-only `production` target; TEXT selects
> providers per request from the control plane and holds no local engine. TEXT only ever
> touches a GPU if a local LLM engine (vLLM etc.) is added later and TEXT routes to its
> `baseUrl` — out of scope here.

---

## 2. Topology

```
                                                              ┌──────────────────────────────┐
                                                              │ k3s cluster (CPU-only nodes) │
    ┌─────────────────────────┐                                │                              │
    │ GPU server (Docker)     │                                │  api-gateway    :8868        │
    │                         │   ┌──────────► redis  ◄──┐    │  text (TEXT)    :8862        │
    │  stt:ml-runtime  :8861  │   │   (NodePort 6379)    │    │  guardrail      :8863        │
    │   - realtime streaming  │   │      (NodePort 9000) │    │  nlp            :8864        │
    │   - rest transcribe     │   │   ┌────────► minio ◄─┤    │  harness        :8866        │
    │   - /metrics, health    │   │   │   (Silos object  │    │  postgres       :5432        │
    │                         │   │   │    store)        │    │  vault          :8200        │
    │  stt:worker    no port  │   │   │                  │    │  redis          :6379        │
    │   - dramatiq batch jobs │   │   │                  │    │  minio          :9000        │
    │                         │   │   │                  │    └───────┬──────────────────────┘
    │  mounted env file       │   │   │                  │            │  gateway → STT
    │  /models (weights RO)   │   │   │                  └────────────┼── http(s)://<gpu-ip>:8861
    └────────────┬────────────┘   │                                  │  (also WebSocket,
                 │                │                                  │   same host:port)
                 │  STT → gateway │  STT → MinIO (audio chunks)     │
                 │  http://<k3s-node>:<NP>/api/v1                    │
                 └────────────────────────┴──────────────────────────┘
```

**Direction of traffic and what each hop needs:**

| From | To | Purpose | Path |
|---|---|---|---|
| GPU host (STT) | Redis | Dramatiq broker, streaming state, pub/sub | `redis://<k3s-node-ip>:<redis-nodeport>/0` |
| GPU host (STT) | MinIO | job audio read, chunk/audio upload | `MINIO_ENDPOINT=<k3s-node-ip>:<minio-nodeport>` |
| GPU host (STT) | API Gateway | job lifecycle + transcript callbacks (`/internal/stt/*`) | `API_GATEWAY_URL=http://<k3s-node-ip>:<gw-nodeport>/api/v1` |
| GPU host (STT) | MinIO (`hope-models`) | model weights → HF cache (read-only) | s3fs / `mc mirror` onto host (D4/D7) |
| k3s (gateway) | GPU host STT | REST + WebSocket streaming, health | `STT_URL=http://<gpu-ip>:8861` (ws derived) |
| k3s (TEXT) | gateway / redis / guardrail | PULL config, task state, moderation peer | in-cluster ClusterIP DNS — **no exposure needed** |
| k3s (gateway) | k3s TEXT | generate/summary proxy + health | `TEXT_URL=http://text:8862` (in-cluster) |

**Not needed across the boundary:** Postgres (gateway only; STT DB is OFF by default —
`STT_DATABASE_ENABLED=false`, TASK-861), Vault (GPU-host secrets come from the env file).

---

## 3. Component inventory

### 3.1 Ports

| Service | Port | Listener | Binding |
|---|---|---|---|
| STT API (ml-runtime) | 8861 | HTTP + WebSocket + health | GPU host 0.0.0.0 |
| STT worker | — | none (Dramatiq consumer) | GPU host |
| TEXT | 8862 | HTTP | k3s pod |
| API Gateway | 8868 | HTTP | k3s pod |
| Redis | 6379 | TCP | k3s pod → NodePort |
| MinIO S3 API | 9000 | TCP/HTTP | k3s pod → NodePort |
| Postgres | 5432 | TCP | k3s pod (internal only) |
| Vault | 8200 | HTTP | k3s pod (internal only) |

### 3.2 STT → external deps (both containers)

Both `stt:ml-runtime` and `stt:worker` are built from the **same** image family and share
env requirements. Differences are only the entrypoint.

| Dependency | Env var | Notes |
|---|---|---|
| Redis | `REDIS_URL` | **Required.** Dramatiq broker + streaming streams/results + pub/sub + worker heartbeats |
| MinIO | `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, `MINIO_SECURE`, `MINIO_CERT_CHECK` | **Required.** Object store ("Silos"). Creds are `vault-kv` `minio.accessKey`/`minio.secretKey` |
| API Gateway | `API_GATEWAY_URL`, `API_GATEWAY_KEY`, `API_GATEWAY_TIMEOUT` | **Required.** Outbound writes via `X-Internal-Service-Key` |
| Shared internal token | `INTERNAL_ACCESS_TOKEN` | **Required (prod).** Inbound `X-Service-Token` accepted from the gateway |
| Postgres | (none) | Read-only DB is **OFF by default**; only needed for deprecated paths (`STT_DATABASE_ENABLED=true`) |
| Model weights | `HF_HOME`, `HUGGINGFACE_CACHE_DIR`, `HF_HUB_OFFLINE=1` | Read-only cache, mirrored from `hope-models` bucket |
| OTLP collector | `OTEL_EXPORTER_OTLP_ENDPOINT` | Optional; presence enables export |
| Prometheus | `METRICS_ENABLED=true` | `/metrics` on 8861 (API container) |

### 3.3 TEXT → external deps (k3s)

| Dependency | Env var | Notes |
|---|---|---|
| Gateway (control plane) | `TEXT_GATEWAY_URL=http://hope-api:8868/api/v1` | PULL channel (effective-config) + per-request PUSH |
| Redis | `TEXT_REDIS_URL=redis://hope-redis:6379/0` | Task state + config invalidation |
| Guardrail | `TEXT_EXTERNAL_GUARDRAIL_BASE_URL=http://hope-guardrail:8863` | moderation peer (address only — posture is control-plane) |
| Shared internal token | `INTERNAL_ACCESS_TOKEN` | `X-Service-Token` in/out |
| Telemetry | `TEXT_OTEL_EXPORTER_ENDPOINT` | empty = disabled |

---

## 4. Connectivity: NodePorts vs Traefik

**Recommendation: NodePort Services for GPU host → k3s.** Reasons:

1. **Redis and (potentially) Postgres are raw TCP.** k3s's default Traefik forward routes
   HTTP(S); supporting TCP needs the `TCPIngressRoute` CR and a Traefik build with the TCP
   plugin enabled. NodePort just works for everything.
2. The GPU host is an **external Docker host**, not a k8s node — it cannot resolve cluster
   service DNS unless it joins the pod network (overlay). NodePort gives it a plain
   `k3s-node-ip:port` target.
3. Only **three** services need to cross the boundary (Redis, MinIO, Gateway); NodePort's
   operational cost is minimal.

**For k3s → GPU host (gateway → STT):** no ingress is involved. STT binds `0.0.0.0:8861`
on the GPU host; the gateway simply sets `STT_URL=http://<gpu-ip>:8861`. Open 8861 (and
redis/minio/gateway nodeports) in the host firewalls. If you later want TLS on the
gateway→STT hop, put a reverse proxy/Traefik **on the GPU host** in front of 8861 and point
`STT_URL` at it — but the container itself only listens plain HTTP.

> Traefik is still the right answer for **HTTP-only** cluster-boundary routes that the
> browser or gateway already front (public API ingress). It is not the tool for the three
> TCP/TCP+HTTP links above.

Minimal NodePort services to add in the k3s `hope` namespace (patch the existing
`redis`/`minio`/`hope-api` Services — do **not** add duplicates):

```yaml
apiVersion: v1
kind: Service
metadata:
  name: redis
  namespace: hope
spec:
  type: NodePort
  selector:
    app: redis            # match your redis deployment's labels
  ports:
    - port: 6379
      targetPort: 6379
      nodePort: 36379     # pick ports from your k3s nodePort range (default 30000-32767)
---
apiVersion: v1
kind: Service
metadata:
  name: minio
  namespace: hope
spec:
  type: NodePort
  selector:
    app: minio
  ports:
    - port: 9000
      targetPort: 9000
      nodePort: 39000     # S3 API; console 9001 can stay ClusterIP
---
apiVersion: v1
kind: Service
metadata:
  name: hope-api
  namespace: hope
spec:
  type: NodePort
  selector:
    app: api-gateway
  ports:
    - port: 8868
      targetPort: 8868
      nodePort: 38868     # required so STT on the GPU host can POST /internal/stt/*
```

Record the chosen `k3s-node-ip` (one node, or round-robin across nodes) and open the
firewall: ingress to `36379/39000/38868` from the GPU host, and egress from k3s nodes to
`<gpu-ip>:8861`. If k3s uses default **Flannel** CNI, NetworkPolicies are not enforced
(§ network-policy.yaml comment); with Calico/Cilium, add ingress allows for these
NodePorts.

---

## 5. Prerequisites

### 5.1 GPU host
- Ubuntu 22.04+ (image base is `nvidia/cuda:12.8.1-*ubuntu22.04`)
- NVIDIA driver for **RTX 6000 Ada (sm_89)**. Driver UMD 13.3 is newer than the CUDA 12.8
  runtime in the image — fine (drivers are backward-compatible; the container runtime
  injects `libcuda.so.1`).
- **Docker Engine** + **nvidia-container-toolkit** installed and configured as the default
  runtime so `--gpus all` and `/dev/nvidiactl` work:
  ```bash
  sudo apt-get install -y nvidia-container-toolkit
  sudo nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker
  docker run --rm --gpus all nvidia/cuda:12.8.1-runtime-ubuntu22.04 nvidia-smi   # sanity
  ```
- Port 8861 open (`0.0.0.0`), plus outbound to the three k3s NodePorts.
- `minio/mc` (or `s3fs`) available for the model-weight sync (§7.2).

### 5.2 k3s cluster (infra)
- Redis, MinIO, API Gateway, Guardrail, NLP, Harness, Postgres, Vault already running.
- The **three NodePort services** from §4 applied.
- MinIO buckets present (provisioned by the platform's `minio-setup`): `hope-audio`,
  `hope-audio-chunks` (STT), plus `hope-models` holding the STT weight tree, `recordings`,
  `generated-audio`, `documents`. The STT buckets are the defaults baked into
  `settings.py` (`minio_audio_bucket="hope-audio"`, `minio_chunk_bucket="hope-audio-chunks"`).

### 5.3 Platform credentials (needed before first boot)
1. **`INTERNAL_ACCESS_TOKEN`** — the ONE shared internal token, identical across every HOPE
   service (owner decision D-D). The gateway presents it as `X-Service-Token`; STT/TEXT
   accept it (budget `stt.core.service_auth`) and present it on outbound peer calls.
2. **`API_GATEWAY_KEY`** (STT only) — the value of a **registered `ApiKey` row** used
   outbound with `X-Internal-Service-Key`. Provision it like any internal platform key;
   stt has **no** legacy `STT_SERVICE_TOKEN` fallback (`settings.py` §D-D).
3. **`MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY`** — the platform `minio.accessKey` /
   `minio.secretKey` values from `vault-kv` (`platform-secrets.descriptors.ts`). Empty
   defaults are deliberately NOT working; an empty credential silently kills every
   object-store call.
4. **TEXT/Gateway**: TEXT itself needs only `INTERNAL_ACCESS_TOKEN` (all provider creds are
   `AiProviderConnection` rows already in the DB).

These go into the GPU host env file (§6.3) and the TEXT manifest (§8.2).

---

## 6. Build & registry

All builds run from the **git repo root** (Dockerfiles copy `uv.lock` / workspace members).

### 6.1 Base image (required first)
```bash
docker build -t hope-python-base:latest infrastructure/docker/python-base/
docker tag hope-python-base:latest <registry>/hope/hope-python-base:3.11
docker push <registry>/hope/hope-python-base:3.11
```

### 6.2 STT images (GPU host / registry)
`ml-runtime` and `worker` both `FROM nvidia/cuda:12.8.1-cudnn-runtime-ubuntu22.04` (devel
builder has `nvcc`). **RTX 6000 Ada = sm_89** → override the arch list to the recommended
set (default `86-real;89-real;89-virtual` also works, just builds more kernels):

```bash
ARCH="89-real;89-virtual"                      # RTX 6000 Ada (sm_89) + PTX for newer
R=<registry>/hope
BASE=<registry>/hope/hope-python-base:3.11

# API/inference image
docker build -f apps/stt/docker/Dockerfile \
  --target ml-runtime --build-arg BASE_IMAGE="$BASE" \
  --build-arg CUDA_ARCHITECTURES="$ARCH" \
  --build-arg BUILD_SERVICE=stt-ml-runtime \
  --build-arg BUILD_VERSION=<rel> --build-arg BUILD_RELEASE_TAG=<tag> \
  --build-arg BUILD_GIT_BRANCH=<branch> --build-arg BUILD_GIT_SHA=<sha> \
  --build-arg BUILD_AT=<iso> --build-arg BUILD_CI_PIPELINE_ID=<id> \
  --build-arg BUILD_CI_PIPELINE_URL=<url> \
  -t "$R/stt-ml-runtime:<tag>" .
docker push "$R/stt-ml-runtime:<tag>"

# Worker image (extends ml-runtime; overrides CMD + HEALTHCHECK)
docker build -f apps/stt/docker/Dockerfile \
  --target worker --build-arg BASE_IMAGE="$BASE" \
  --build-arg CUDA_ARCHITECTURES="$ARCH" \
  --build-arg BUILD_SERVICE=stt-worker \
  --build-arg BUILD_VERSION=<rel> --build-arg BUILD_RELEASE_TAG=<tag> \
  --build-arg BUILD_GIT_BRANCH=<branch> --build-arg BUILD_GIT_SHA=<sha> \
  --build-arg BUILD_AT=<iso> --build-arg BUILD_CI_PIPELINE_ID=<id> \
  --build-arg BUILD_CI_PIPELINE_URL=<url> \
  -t "$R/stt-worker:<tag>" .
docker push "$R/stt-worker:<tag>"
```

Build notes:
- `BUILD_*` args are **required** for ml-runtime/worker (baked into `/app/build-info.json`)
  unless you run only the dev target `runtime` (CPU, not used here).
- The GPU build is **not** covered by `uv sync --frozen`; it must be validated on a runner
  that has GPU access, or at least beyond the `ldd`/`cuobjdump` gates in the Dockerfile.
- `pywhispercpp v1.5.0` is compiled from source with `GGML_CUDA=1`. The **cache must not
  be reused across arch changes** (uv keys on source, not on `CMAKE_ARGS`) — the Dockerfile
  already drops the uv cache for that step.
- There is no dedicated CUDA/gpu image for TEXT (CPU proxy → see §8).

### 6.3 TEXT image (k3s)
```bash
docker build -f apps/text/Dockerfile --target production -t "$R/text:<tag>" .
docker push "$R/text:<tag>"
```
`production` is the only target; the image has no GPU layer.

---

## 7. Deploy STT on the GPU server

### 7.1 Secret/settings file
The container is configured entirely via environment. Create
`/etc/hope/stt.env` (chmod 600), shared by both containers:

```bash
# --- identity / logging ---
LOG_LEVEL=INFO
HOST=0.0.0.0
PORT=8861

# --- shared internal credential (D-D) ---
INTERNAL_ACCESS_TOKEN=<shared-token>          # gateway presents this as X-Service-Token

# --- Redis (k3s NodePort) — REQUIRED ---
REDIS_URL=redis://<k3s-node-ip>:36379/0

# --- MinIO / Silos (k3s NodePort) — REQUIRED ---
MINIO_ENDPOINT=<k3s-node-ip>:39000            # host:port form
MINIO_ACCESS_KEY=<minio-access-key>
MINIO_SECRET_KEY=<minio-secret-key>
MINIO_SECURE=false                            # plain HTTP for the exposed Silos endpoint
MINIO_CERT_CHECK=false                        # keep false while no CA; set true once CA lands

# --- API Gateway (STT→gateway callbacks) — REQUIRED ---
API_GATEWAY_URL=http://<k3s-node-ip>:38868/api/v1
API_GATEWAY_KEY=<registered-apikey-value>
API_GATEWAY_TIMEOUT=30

# --- database: OFF (selection arrives from gateway as ResolvedAsrSpec) ---
STT_DATABASE_ENABLED=false

# --- model cache (mounted read-only from hope-models, see 7.2) ---
HF_HOME=/models/hf-cache
HUGGINGFACE_CACHE_DIR=/models/hf-cache/hub
HF_HUB_OFFLINE=1

# --- optional observability ---
METRICS_ENABLED=true
# OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4317   # presence enables export
```

`MINIO_ENDPOINT` must be **bare `host:port`** (the settings validator only turns an empty
string back to the default). `MINIO_SECURE=true` is only correct if the exposed MinIO
endpoint serves TLS; for a plain NodePort S3 API keep `false`.

### 7.2 Model weights (hope-models → host)
Production mounts the MinIO `hope-models` bucket **read-only** and sets `HF_HUB_OFFLINE=1`
so a missing weight is a loud failure, never a silent download. Mirror that here.

Option A (recommended, matches k8s): s3fs read-only mount at boot.
```bash
sudo apt-get install -y s3fs
# /etc/fstab or a systemd unit:
# s3fs hope-models /srv/hope/models -o url=http://<k3s-node-ip>:39000 -o passwd_file=/etc/hope/minio.s3fs -o ro -o umask=022
```
Option B: snapshot the bucket once (blocked `mc mirror`):
```bash
mc alias set hminio http://<k3s-node-ip>:39000 <key> <secret>
mc mirror --overwrite hminio/hope-models /srv/hope/models
```

Then run the containers with:
```bash
-v /srv/hope/models:/models:ro
```
`/models` is created and owned by uid 1001 (`hope`) in the image; a read-only bind mount
plus `HF_HUB_OFFLINE=1` reproduces the failure posture exactly. `HUGGINGFACE_CACHE_DIR`
is the var `apps/stt` actually reads.

### 7.3 Run the STT API (realtime + REST)
```bash
docker run -d --name stt-api --restart unless-stopped \
  --gpus all \
  -p 8861:8861 \
  --env-file /etc/hope/stt.env \
  -v /srv/hope/models:/models:ro \
  <registry>/hope/stt-ml-runtime:<tag>
```
Boot sequence to watch:
```text
cuda-preflight: no GPU allocated (/dev/nvidiactl absent) — continuing on CPU   ← ONLY if you forgot --gpus all
cuda-preflight: CUDA driver up; sm_89 covered by 89-real;89-virtual            ← expected
INFO:     Uvicorn running on http://0.0.0.0:8861
```
The preflight exits **non-zero** (container fails to start) if the driver cannot init or a
visible GPU's compute capability is not in `STT_CUDA_ARCHITECTURES` (baked from
`CUDA_ARCHITECTURES`). sm_89 is covered by the recommended build.

### 7.4 Run the STT worker (Dramatiq batch)
```bash
docker run -d --name stt-worker --restart unless-stopped \
  --gpus all \
  --env-file /etc/hope/stt.env \
  -v /srv/hope/models:/models:ro \
  <registry>/hope/stt-worker:<tag>
```
- Entrypoint: `/opt/venv/bin/python -m dramatiq stt.worker --processes 1 --threads 4`.
  `--processes 1` is load-bearing (one CUDA context per pod; the pool is time-sliced);
  `--threads 4` matches the `stt.workers.concurrency` control-plane default.
- No HTTP port. Health = per-process **heartbeat files** under `/tmp/stt-worker-heartbeat`
  (all must be < 1 min old). Check:
  ```bash
  docker exec stt-worker sh -c 'ls -la /tmp/stt-worker-heartbeat/'
  ```
- The worker CLAIMS jobs via the gateway (`PATCH /internal/stt/jobs/{id}/start`),
  downloads the audio from MinIO, transcribes, and writes back
  `/internal/stt/jobs/{id}/complete` + `/internal/stt/transcripts` — Redis, MinIO and the
  gateway must all be reachable.

### 7.5 Verify STT locally
```bash
curl -s http://localhost:8861/api/v1/health | python3 -m json.tool
curl -s http://localhost:8861/metrics | head          # prometheus metrics
```
Health is what the gateway polls over `STT_URL`.

---

## 8. Deploy TEXT on k3s

TEXT is deployed in the cluster next to the gateway; only its image tag changes for a new
release. Env below mirrors `apps/text/.env.prod`.

### 8.1 Manifest (ConfigMap + Deployment + Service)
```yaml
apiVersion: v1
kind: ConfigMap
metadata: { name: text-env, namespace: hope }
data:
  NODE_ENV: production
  OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: "NO_CONTENT"
  TEXT_PORT: "8862"
  TEXT_LOG_LEVEL: info
  TEXT_GATEWAY_URL: http://hope-api:8868/api/v1
  TEXT_REDIS_URL: redis://hope-redis:6379/0
  TEXT_EXTERNAL_GUARDRAIL_BASE_URL: http://hope-guardrail:8863
  # TEXT_OTEL_EXPORTER_ENDPOINT: ""   # empty = export disabled
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: text, namespace: hope }
spec:
  replicas: 2
  selector: { matchLabels: { app: text } }
  template:
    metadata: { labels: { app: text } }
    spec:
      containers:
        - name: text
          image: <registry>/hope/text:<tag>
          ports: [{ containerPort: 8862, name: http }]
          env:
            - name: INTERNAL_ACCESS_TOKEN
              valueFrom: { secretKeyRef: { name: hope-shared-secrets, key: INTERNAL_ACCESS_TOKEN } }
          envFrom:
            - configMapRef: { name: text-env }
          livenessProbe:
            httpGet: { path: /api/v1/health/live, port: 8862 }
            initialDelaySeconds: 15
          readinessProbe:
            httpGet: { path: /api/v1/health/ready, port: 8862 }
            initialDelaySeconds: 5
          resources:
            requests: { cpu: 250m, memory: 256Mi }
            limits:   { cpu: "2", memory: 1Gi }
---
apiVersion: v1
kind: Service
metadata: { name: text, namespace: hope }
spec:
  type: ClusterIP
  selector: { app: text }
  ports: [{ port: 8862, targetPort: 8862, name: http }]
```
(`/api/v1/health` is the detailed always-200 route; `/api/v1/health/live|ready` are the
probe routes — verified against `apps/text/src/text/tests/integration/test_full_lifecycle.py`
and `stt/core/middleware/auth.py`. Match the `hope-v2-deployment` `text.yaml` for final
probe settings.)

### 8.2 Verify TEXT
```bash
kubectl exec deploy/text -n hope -- sh -c 'wget -qO- http://localhost:8862/api/v1/health'
```

---

## 9. Gateway wiring

In the k3s `hope-api` Deployment env (from `apps/api/.env.prod` + the deployment guide):

```bash
STT_URL=http://<gpu-host-ip>:8861        # points at the GPU server (http+ws target)
TEXT_URL=http://text:8862                # in-cluster Service DNS
# (STT_PORT=8861, TEXT_PORT=8862 for the health registry)
```

- The gateway **resolves `STT_URL`/`TEXT_URL` once at bootstrap**; restart the API
  Deployment after changing them (confirmed by `apps/api` e2e specs' comments).
- The gateway's STT streaming path upgrades to a WebSocket on the same `STT_URL`
  host:port (`/ws/stt/stream?sessionId=...&ticket=...`) — so `<gpu-host-ip>:8861` must
  accept both HTTP and WS, and the STT audio bridge writes `stt:audio` into the in-cluster
  Redis (no extra exposure).
- Restart and check the gateway's readiness/service health reports `stt: <gpu-ip>:8861`
  and `text: http://text:8862` (the `AdminHealthServicesController` reads these keys).

---

## 10. End-to-end smoke test

1. **Gateway ready** — `GET http://<gateway>/api/v1/health/ready` → 200, services list
   includes `stt` and `text`.
2. **Realtime** — open gateway WS `/ws/stt/stream` (via the frontend or a script); speak;
   confirm partials arrive and final transcript persists (`/internal/stt/transcripts`).
3. **Batch** — create a `TranscriptionJob` through the API; watch it go
   `QUEUED → PROCESSING → COMPLETED` in the admin console. Confirm the worker claimed it:
   ```bash
   docker logs -f stt-worker | grep -i 'claim\|start\|complete'
   ```
4. **Generate** — POST a gateway generation/summary route; confirm it proxies to TEXT and
   returns 200.
5. **Gpu actually used** — in `stt-api` logs the streaming engine resolves to a CUDA
   device (`device=cuda` in completed-job payloads → priced as `GPU_SECOND`), and
   `nvidia-smi` on the host shows both containers holding context:
   ```bash
   docker run --rm --gpus all nvidia/cuda:12.8.1-runtime-ubuntu22.04 nvidia-smi
   ```

---

## 11. Failure modes

| Symptom | Cause → fix |
|---|---|
| STT container start prints `FATAL: this image has no runnable kernels for sm_XX` | Wrong `CUDA_ARCHITECTURES`. RTX 6000 Ada is sm_89 → rebuild with `89-real;89-virtual` (or the default). |
| `cuda-preflight: no GPU allocated` | Container ran without `--gpus all` / nvidia runtime not configured on host. |
| MinIO calls fail / job audio missing | Empty or wrong `MINIO_ACCESS_KEY/SECRET_KEY`, or buckets `hope-audio*` not created. Empty creds are silent-by-design. |
| STT→gateway callbacks 401 | `API_GATEWAY_KEY` is not a registered `ApiKey`, or `API_GATEWAY_URL` port/path wrong. `INTERNAL_ACCESS_TOKEN` mismatch on either side also 401s inbound. |
| Gateway `STT_URL` 503 on health/ready | GPU host port 8861 not open to k3s node egress; or gateway not restarted after env change (`STT_URL` resolved once at bootstrap). |
| Worker unhealthy (heartbeat files stale) | Redis unreachable → Dramatiq broker down. Check `REDIS_URL` NodePort. |
| Whisper decode at CPU speed (`use gpu = 1` fallback) | pywhispercpp arch mismatch → decode on CPU. Rebuild; preflight now blocks this at boot. |
| Missing weight at load → named failure | `HF_HUB_OFFLINE=1` with an empty/partial `/models` — re-sync `hope-models` (§7.2). |
| TEXT won't boot in prod | `NODE_ENV=production` requires `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=NO_CONTENT` or `Settings()` raises. |

---

## 12. Checklist (bring-up order)

- [ ] GPU driver + nvidia-container-toolkit verified (`nvidia-smi` in a `--gpus all` container)
- [ ] `hope-python-base` built/pushed for all images
- [ ] `stt-ml-runtime:<tag>`, `stt-worker:<tag>`, `text:<tag>` built + pushed
- [ ] k3s NodePort Services for Redis (36379), MinIO (39000), gateway (38868); firewall opened both directions
- [ ] MinIO buckets present (`hope-audio`, `hope-audio-chunks`, `hope-models`, …)
- [ ] `hope-models` synced/mounted to `/srv/hope/models` on the GPU host
- [ ] `/etc/hope/stt.env` written (INTERNAL_ACCESS_TOKEN, API_GATEWAY_KEY, MINIO_*)
- [ ] `stt-api` container up; `cuda-preflight` log line shows sm_89 covered; `/api/v1/health` 200
- [ ] `stt-worker` container up; heartbeat files fresh
- [ ] TEXT deployed on k3s; `/health` 200
- [ ] Gateway `STT_URL=http://<gpu-ip>:8861`, `TEXT_URL=http://text:8862` applied + restarted
- [ ] Gateway `/api/v1/health/ready` lists `stt` and `text` healthy
- [ ] Smoke: realtime WS, batch job, generate route all green