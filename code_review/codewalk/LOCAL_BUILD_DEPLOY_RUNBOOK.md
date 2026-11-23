# HOPE Deployment Runbook — Step by Step — ALL 20 MICROSERVICES

Deploys the complete HOPE platform from source. **14 app images** are built from the
monorepo on a build host and pushed to a private registry; **6 infra servers** use upstream
images; then **11 CPU app services** are deployed to the k3s cluster, while the **2 GPU
services (STT)** run as Docker containers on a separate NVIDIA GPU server.

Follow the steps **in order**. Each step is one concrete action with commands, the expected
result, and what to do on failure. Do **not** skip ahead: a later step's success depends on
an earlier step's verification.

---

## 0. The 20 microservices

| # | Workload (k8s/base manifest) | Image | Port | Runs where | Deploy step |
|---|---|---|---|---|---|
| 1 | `hope-api` (`api.yaml`) | `hope-v2/api` | 8868 | k3s (CPU) | 20a |
| 2 | `text`/`hope-smr` (`smr.yaml` — stale name) | `hope-v2/text` | 8862 | k3s (CPU) | 20b |
| 3 | `hope-stt-v2` (`stt-v2.yaml`) | `hope-v2/stt-ml-runtime` | 8861 | **GPU server (docker)** | 26–27 |
| 4 | `hope-stt-v2-worker` (`stt-v2-worker.yaml`) | `hope-v2/stt-worker` | — | **GPU server (docker)** | 28 |
| 5 | `hope-guardrail` (`guardrail.yaml`) | `hope-v2/guardrail` | 8863 | k3s (CPU) | 20d |
| 6 | `hope-nlp` (`nlp.yaml`) | `hope-v2/nlp` | 8864 | k3s (CPU) | 20e |
| 7 | `hope-harness` (`harness.yaml`) | `hope-v2/harness` | 8866 | k3s (CPU) | 20f |
| 8 | `hope-harness-worker` (`harness-worker.yaml`) | `hope-v2/harness-worker` | — | k3s (CPU) | 20g |
| 9 | `hope-tts` (`tts-v2.yaml`) | `hope-v2/tts` | 8865 | k3s (CPU) | 20h |
| 10 | `hope-admin-console` (`admin-console.yaml`) | `hope-v2/admin-console` | 3000 | k3s (CPU) | 20i |
| 11 | `hope-compat-playground` (`compat-playground.yaml`) | `hope-v2/compat-playground`¹ | 3000 | k3s (CPU) | 20j |
| 12 | `hope-postgres` (`postgres.yaml`) | `timescale/timescaledb-ha:pg18-all` | 5432 | k3s (stateful) | 15a |
| 13 | `hope-redis` (`redis.yaml`) | `redis:8-alpine` | 6379 | k3s (stateful) | 15b |
| 14 | `hope-minio` (`minio.yaml`) | `minio/minio:…Z` | 9000/9001 | k3s (stateful) | 15c |
| 15 | `hope-vault` (+`hope-vault-init` Job) (`vault.yaml`) | `hashicorp/vault:1.18.3` | 8200 | k3s (stateful) | 16 |
| 16 | `hope-temporal` (+`hope-temporal-ui`) (`temporal.yaml`) | `temporalio/auto-setup:1.25.1` | 7233/8233 | k3s | 17 |
| 17 | `hope-qdrant` (`qdrant.yaml`) | `qdrant/qdrant:v1.16` | 6333/6334 | k3s (stateful) | 18 |
| 18 | `hope-db-migrate` (Job) (`db-migrate.yaml`) | `hope-v2/database` | — | k3s (Job) | 19 |
| 19 | `hope-qdrant-init` (Job) (`qdrant-init.yaml`) | `hope-v2/qdrant-init` | — | k3s (Job) | 18b |
| 20 | `hope-smoke-test` (Job) (`smoke-test.yaml`) | `curlimages/curl:8.11.1` | — | k3s (Job) | 31 |

¹ `compat-playground` has **no build job** in `services.json` — if you don't have the image
from CI, skip it (Step 20j). Everything else builds from the monorepo.

Not counted above: `hope-python-base` (build-time base, never deployed), `lmstudio`
(out-of-band Endpoints service, parked at replicas:0 — build optional, Step 10), and the
Observability stack (`prometheus`, `grafana`, `loki`, `tempo`, `alloy`, etc.) which is part
of the same kustomize base and comes along for free in Step 14.

### Quality gate (contract test)

The list of buildable images is **enforced by a contract test**:
`tests/contracts/services-manifest.contract.test.ts` fails if `services.json`,
`.gitlab/ci/build.yml`, `promote.sh` `SERVICES=`, or `version-grammar.ts` `SERVICE_TAG_PREFIXES`
drift. Any image you build locally should match `services.json` exactly (Step 6–10 use it).

---

## Before you start — what you need

| Thing | Value / where from |
|---|---|
| Monorepo | `/Users/apple/repos/VOX/project-hope` — build everything from here |
| Deployment repo | `/Users/apple/repos/VOX/arca-deployment-template` — k8s manifests |
| k3s cluster | Ready nodes; `kubectl` works; single shared node is fine (all base anti-affinity is soft) |
| GPU server | Separate Ubuntu 22.04+ host, **NVIDIA RTX 6000 Ada (sm_89)**, Docker + NVIDIA toolkit |
| Build host | Linux/amd64 with Docker; can be the k3s node or a separate box (`linux/amd64` is all that's built) |
| Shared service token | One `INTERNAL_ACCESS_TOKEN` used by service-to-service calls (decision D-D) |
| MinIO credentials | access/secret key pair used by every service |
| Private registry | `registry.taphuynh.dev` in CI, or `10.10.1.110:5050` locally, or Step 2 |

> **Terminology check.** TEXT is the **new name of SMR** (user-confirmed). Everywhere in your
> own images and manifests it is `text` / `hope-v2/text`. The `arca-deployment-template` repo
> still names it **`smr`** — Step 14 removes that stale file so you never use it.

---

## STEP 1 — Set the environment variables (edit once, use everywhere)

Run on the build host. Replace `<angle brackets>` with real values, then export:

```bash
export REGISTRY=10.10.1.110:5050                 # host:port of your private registry
export R="$REGISTRY/arca/hope-v2"                # image namespace (== k8s image keys hope-v2/<name>)
export TAG=2.1.0-local                           # your release tag for these images
export BASE="$R/hope-python-base:latest"         # build-time base image tag

export K3S_NODE_IP=<k3s-node-ip>                 # an IP of a k3s node (used for NodePorts)
export GPU_HOST_IP=<gpu-server-ip>               # the GPU server's LAN IP
export NS=hope                                    # namespace everything lands in
```

**Verify:** `echo $REGISTRY $R $TAG $NS` prints non-empty values.

**If it fails:** you missed an export — re-run the block. Keep this shell alive through Step 14
(or re-export in each new terminal).

---

## STEP 2 — Start the private registry (if you are not reusing one)

Only if you are not reusing `10.10.1.110:5050` or `registry.taphuynh.dev`:

```bash
docker run -d --name registry --restart=always -p 5050:5000 registry:2
```

**Verify:**
```bash
curl -s http://localhost:5050/v2/
```
**Expected:** `{}`.
**If it fails:** port 5050 busy (`docker ps`, rename/stop old), or `registry:2` unpullable
(check proxy/DNS).

---

## STEP 3 — Make Docker trust the registry on every Docker host that pulls

**On the GPU server** (it pulls via Docker in Step 26/28):

```bash
sudo tee /etc/docker/daemon.json >/dev/null <<EOF
{ "insecure-registries": ["$REGISTRY"] }
EOF
sudo systemctl restart docker
```

**Verify:**
```bash
docker pull hello-world && docker run --rm hello-world
```
**If it fails:** invalid JSON in daemon.json (`docker info | grep -A2 insecure`), or the
registry isn't reachable from this host.

---

## STEP 4 — Make k3s (containerd) trust the registry

**On every k3s node** (k3s pulls all `hope-*` images via containerd):

```bash
sudo mkdir -p /etc/rancher/k3s
sudo tee /etc/rancher/k3s/registries.yaml >/dev/null <<EOF
mirrors:
  "$REGISTRY":
    endpoint:
      - "http://$REGISTRY"
EOF
sudo systemctl restart k3s
```

**Verify (after 30 s):**
```bash
sudo journalctl -u k3s | grep -i "registries.yaml" | tail -3
kubectl get nodes
```
**Expected:** no `failed to load registries.yaml`, nodes Ready.
**If it fails:** check indentation (exactly 2 spaces under `mirrors:`), restart again.

---

## STEP 5 — Build the shared base image `hope-python-base`

From the repo root:

```bash
cd /Users/apple/repos/VOX/project-hope
docker build -t "$BASE" infrastructure/docker/python-base/
```

**Source:** `infrastructure/docker/python-base/Dockerfile`.

Every `pythonBase: true` service (text, guardrail, nlp, harness, harness-worker, tts) needs
this base and receives it as `--build-arg BASE_IMAGE`.

**Verify:**
```bash
docker images "$BASE"
```
**Expected:** one `hope-python-base:latest` image.
**If it fails:** Docker down, or no network for base-package installs. Fix Docker (Step 3) and
re-run.

---

## STEP 6 — Build the NON-Python images first

`api`, `admin-console`, `database`, `qdrant-init` do **not** use the Python base. From the
repo root (`cd /Users/apple/repos/VOX/project-hope` after `$TAG` is set):

```bash
# 6a. API gateway (NestJS; payload always contains the DB/migration packages)
docker build -f apps/api/Dockerfile \
  --build-arg BUILD_VERSION=$(echo "$TAG" | sed 's/^[A-Z]*-*//') \
  --build-arg BUILD_GIT_SHA=$(git rev-parse HEAD) \
  -t "$R/api:$TAG" .

# 6b. Admin console (Next.js; NEXT_PUBLIC_API_HOST is baked at build time)
docker build -f apps/admin-console/Dockerfile \
  --build-arg NEXT_PUBLIC_API_HOST=$NEXT_PUBLIC_API_HOST \
  --build-arg BUILD_VERSION=$(echo "$TAG" | sed 's/^[A-Z]*-*//') \
  --build-arg BUILD_GIT_SHA=$(git rev-parse HEAD) \
  -t "$R/admin-console:$TAG" .

# 6c. Database migration image (db-migrate Job) — packages/database/Dockerfile
docker build -f packages/database/Dockerfile \
  --build-arg BUILD_VERSION=$(echo "$TAG" | sed 's/^[A-Z]*-*//') \
  --build-arg BUILD_GIT_SHA=$(git rev-parse HEAD) \
  -t "$R/database:$TAG" .

# 6d. Qdrant collection prober (qdrant-init Job)
docker build -f infrastructure/docker/qdrant-init/Dockerfile \
  -t "$R/qdrant-init:$TAG" .
```

`NEXT_PUBLIC_API_HOST` must be the origin clients will hit for the API. For a LAN deployment
that is `http://$K3S_NODE_IP:38868` (the gateway NodePort created in Step 21). Export it before
6b:

```bash
export NEXT_PUBLIC_API_HOST=http://$K3S_NODE_IP:38868
```

**Verify:**
```bash
docker images "$R/api:$TAG" "$R/admin-console:$TAG" "$R/database:$TAG" "$R/qdrant-init:$TAG"
```
**If it fails:** the `BUILD_*` args are baked by the LAST layer into `/app/build-info.json`
(the version shown at `/health`) — the image builds either way, but an empty value shows up as
an **unlabelled artifact** in health/version endpoints, so keep them set. There is no separate
build gate for them. For admin-console failures confirm `NEXT_PUBLIC_API_HOST` is set
(Next.js bakes it into the browser bundle at build time; changing it later requires a rebuild).

> **Note on `$TAG`:** the `$(echo "$TAG" | sed 's/^[A-Z]*-*//')` one-liner strips a leading tag
> prefix, so `TAG=2.1.0-local` → `2.1.0-local`; `TAG=TEXT-1.0.0` → `1.0.0`. It only affects the
> version string baked into `build-info.json` — leave it as-is.

---

## STEP 7 — Build TEXT (CPU)

```bash
docker build -f apps/text/Dockerfile --target production \
  --build-arg BASE_IMAGE="$BASE" \
  --build-arg BUILD_SERVICE=text \
  --build-arg BUILD_VERSION=$(echo "$TAG" | sed 's/^[A-Z]*-*//') \
  --build-arg BUILD_GIT_SHA=$(git rev-parse HEAD) \
  -t "$R/text:$TAG" .
```

**Source:** `apps/text/Dockerfile` (`builder` → `production`, port 8862, healthcheck
`/api/v1/health/live`).

**Verify:**
```bash
docker run --rm "$R/text:$TAG" cat /app/build-info.json
```
**Expected:** JSON with `"service":"text"`.
**If it fails:** build context must be the repo root (`COPY failed: no source files` = wrong
directory). Re-run from `cd /Users/apple/repos/VOX/project-hope`.

---

## STEP 8 — Build the other Python CPU services

All six use the Python base, all from repo root. Build them **after** Step 5 (they need
`$BASE`):

```bash
# guardrail
docker build -f apps/guardrail/Dockerfile --target production \
  --build-arg BASE_IMAGE="$BASE" \
  --build-arg BUILD_SERVICE=guardrail \
  --build-arg BUILD_VERSION=$(echo "$TAG" | sed 's/^[A-Z]*-*//') \
  --build-arg BUILD_GIT_SHA=$(git rev-parse HEAD) \
  -t "$R/guardrail:$TAG" .

# nlp
docker build -f apps/nlp/Dockerfile \
  --build-arg BASE_IMAGE="$BASE" \
  --build-arg BUILD_SERVICE=nlp \
  --build-arg BUILD_VERSION=$(echo "$TAG" | sed 's/^[A-Z]*-*//') \
  --build-arg BUILD_GIT_SHA=$(git rev-parse HEAD) \
  -t "$R/nlp:$TAG" .

# harness (HTTP app)
docker build -f apps/harness/Dockerfile --target production \
  --build-arg BASE_IMAGE="$BASE" \
  --build-arg BUILD_SERVICE=harness \
  --build-arg BUILD_VERSION=$(echo "$TAG" | sed 's/^[A-Z]*-*//') \
  --build-arg BUILD_GIT_SHA=$(git rev-parse HEAD) \
  -t "$R/harness:$TAG" .

# harness-worker (Temporal worker, same Dockerfile, target=worker)
docker build -f apps/harness/Dockerfile --target worker \
  --build-arg BASE_IMAGE="$BASE" \
  --build-arg BUILD_SERVICE=harness-worker \
  --build-arg BUILD_VERSION=$(echo "$TAG" | sed 's/^[A-Z]*-*//') \
  --build-arg BUILD_GIT_SHA=$(git rev-parse HEAD) \
  -t "$R/harness-worker:$TAG" .

# tts (Kokoro English engine ships in the image; no model files)
docker build -f apps/tts/Dockerfile --target production \
  --build-arg BASE_IMAGE="$BASE" \
  --build-arg BUILD_SERVICE=tts \
  --build-arg BUILD_VERSION=$(echo "$TAG" | sed 's/^[A-Z]*-*//') \
  --build-arg BUILD_GIT_SHA=$(git rev-parse HEAD) \
  -t "$R/tts:$TAG" .
```

**Verify:**
```bash
docker images "$R/guardrail:$TAG" "$R/nlp:$TAG" "$R/harness:$TAG" \
              "$R/harness-worker:$TAG" "$R/tts:$TAG"
```
**If it fails:** same rules as Step 7 (repo-root context, all `BUILD_*` args present, `$BASE`
built in Step 5 before these runs).

---

## STEP 9 — Build the STT images (GPU): `stt-ml-runtime` and `stt-worker`

Both build from `apps/stt/docker/Dockerfile`. The card is **RTX 6000 Ada = sm_89**, so kernels
are compiled for `89-real;89-virtual`. **Never reuse docker cache across a
`CUDA_ARCHITECTURES` change** — pywhispercpp compiles from source, a changed arch silently
re-links against stale `sm_XX` blobs.

```bash
# 9a. STT inference API container
docker build -f apps/stt/docker/Dockerfile --target ml-runtime \
  --build-arg CUDA_ARCHITECTURES="89-real;89-virtual" \
  --build-arg BUILD_SERVICE=stt-ml-runtime \
  --build-arg BUILD_VERSION=$(echo "$TAG" | sed 's/^[A-Z]*-*//') \
  --build-arg BUILD_GIT_SHA=$(git rev-parse HEAD) \
  -t "$R/stt-ml-runtime:$TAG" .

# 9b. STT batch worker container (FROM ml-runtime)
docker build -f apps/stt/docker/Dockerfile --target worker \
  --build-arg CUDA_ARCHITECTURES="89-real;89-virtual" \
  --build-arg BUILD_SERVICE=stt-worker \
  --build-arg BUILD_VERSION=$(echo "$TAG" | sed 's/^[A-Z]*-*//') \
  --build-arg BUILD_GIT_SHA=$(git rev-parse HEAD) \
  -t "$R/stt-worker:$TAG" .
```

**Verify:**
```bash
docker images "$R/stt-ml-runtime:$TAG" "$R/stt-worker:$TAG"
```
**Expected:** both present after a **multi-minute** build (torch wheel + pywhispercpp from
source). Building on a host with no GPU is fine — the container's CUDA preflight validates the
GPU at start (Step 26) — only the kernel arch strings must match the card.

**If it fails:** a missing `BUILD_*` arg does NOT fail the build — it bakes an empty service
name into `/app/build-info.json` (the value `/health` reports), so keep them set for correct
identity. A `uv` download timeout — just re-run the identical command once (the 846.9 MiB
torch wheel link is slow).

---

## STEP 10 — (Optional) Build LM Studio, the out-of-band LLM engine

`lmstudio` is the local LLM backend (OpenAI-compatible). In the deployment repo it is an
out-of-band Service/Endpoints pair (not in the kustomize base) pointing at a host-run
`lmstudio-server.service`, and `services.json` marks it `promotable: false` (parked). A
containerized `/v1` at `http://hope-lmstudio:1234` is reachable by text/guardrail via that
Service. Build only if you plan to host it in-cluster/on the GPU box:

```bash
docker build -f infrastructure/docker/lmstudio/Dockerfile -t "$R/lmstudio:$TAG" .
```
Otherwise skip this step — text/guardrail fail-closed to the engine you did configure.

---

## STEP 11 — Push all images to the private registry

```bash
docker login "$REGISTRY"
docker push "$BASE"
docker push "$R/api:$TAG"            "$R/admin-console:$TAG"
docker push "$R/database:$TAG"       "$R/qdrant-init:$TAG"
docker push "$R/text:$TAG"
docker push "$R/guardrail:$TAG"      "$R/nlp:$TAG"
docker push "$R/harness:$TAG"        "$R/harness-worker:$TAG"
docker push "$R/tts:$TAG"
docker push "$R/stt-ml-runtime:$TAG" "$R/stt-worker:$TAG"
# (docker push "$R/lmstudio:$TAG"   if you built it)
```

**Verify:**
```bash
curl -s "$REGISTRY/v2/_catalog" | python3 -m json.tool
```
**Expected:** `arca/hope-v2` repositories for every image above.
**If it fails:** HTTP 401 → `docker login` again; HTTP 500 → disk full or tag collision —
push a new `$TAG`.

---

## STEP 12 — Pre-flight the k3s cluster

```bash
kubectl get nodes
kubectl get ns $NS || kubectl create ns $NS
```

**Expected:** nodes Ready; namespace exists (or is created).
**If it fails:** kubeconfig wrong or cluster down — fix before continuing.

---

## STEP 13 — Create the four secrets

The base manifests read from 4 Secrets. Create them once (values from your vault/dev env;
placeholders shown). Every key is used by the manifests:

```bash
# 13a. hope-postgres-auth (postgres StatefulSet)
kubectl -n $NS create secret generic hope-postgres-auth \
  --from-literal=POSTGRES_USER=hope \
  --from-literal=POSTGRES_PASSWORD=<postgres-password> \
  --from-literal=POSTGRES_DB=arcaai_hope \
  --dry-run=client -o yaml | kubectl apply -f -

# 13b. hope-redis-auth (redis StatefulSet)
kubectl -n $NS create secret generic hope-redis-auth \
  --from-literal=REDIS_PASSWORD=<redis-password> \
  --dry-run=client -o yaml | kubectl apply -f -

# 13c. hope-minio-auth (minio StatefulSet + provision Job)
kubectl -n $NS create secret generic hope-minio-auth \
  --from-literal=MINIO_ROOT_USER=<minio-access-key> \
  --from-literal=MINIO_ROOT_PASSWORD=<minio-secret-key> \
  --dry-run=client -o yaml | kubectl apply -f -

# 13d. hope-secrets (every app service; keys mirror the secretKeyRefs in base/*.yaml)
kubectl -n $NS create secret generic hope-secrets \
  --from-literal=DATABASE_URL="postgresql://hope:<postgres-password>@hope-postgres:5432/arcaai_hope" \
  --from-literal=REDIS_HOST=hope-redis \
  --from-literal=REDIS_PORT=6379 \
  --from-literal=REDIS_PASS=<redis-password> \
  --from-literal=MINIO_ENDPOINT=hope-minio:9000 \
  --from-literal=MINIO_ACCESS_KEY=<minio-access-key> \
  --from-literal=MINIO_SECRET_KEY=<minio-secret-key> \
  --from-literal=JWT_SECRET_KEY=<random-32-byte-string> \
  --from-literal=ADMIN_SESSION_SECRET=<random-32-byte-string> \
  --from-literal=HARNESS_SERVICE_TOKEN=<shared-token> \
  --from-literal=GUARDRAIL_SERVICE_TOKEN=<shared-token> \
  --from-literal=HARNESS_INTERNAL_SERVICE_TOKEN=<shared-token> \
  --from-literal=VAULT_ROLE_ID=<from-vault> \
  --from-literal=VAULT_SECRET_ID=<from-vault> \
  --from-literal=TEMPORAL_DB_HOST=hope-postgres \
  --from-literal=TEMPORAL_DB_USER=hope \
  --from-literal=TEMPORAL_DB_PASSWORD=<postgres-password> \
  --dry-run=client -o yaml | kubectl apply -f -
```

> `VAULT_ROLE_ID`/`VAULT_SECRET_ID` come from Step 16 (vault-init). If you don't want Vault
> as the secrets backend for this local deploy, set the gateway's `SECRETS_PROVIDER=env`
> (Step 20a) and leave these empty — the platform chain is `env → vault → …`.

**Verify:**
```bash
kubectl -n $NS get secrets hope-postgres-auth hope-redis-auth hope-minio-auth hope-secrets
```
**If it fails:** secret names contain typos — manifests reference these exact names.

---

## STEP 14 — Fix the stale deployment repo, then build the fleet manifest

The `arca-deployment-template` base predates two platform changes. Fix once, then all of the
remaining deploy steps ride the same kustomize output.

### 14.1 Remove the stale SMR (TEXT) manifest

`base/smr.yaml` still deploys `hope-v2/smr` with `hope-smr-config` and `SMR_*` env. It is
superseded by `hope-v2/text`. Comment it out of the kustomization so it never applies, and you
will use the independent `text.yaml` in Step 20b:

```bash
cd /Users/apple/repos/VOX/arca-deployment-template/deployment/k8s/base
sed -i '' 's/^  - smr.yaml/#  - smr.yaml (renamed to text; use Step 20b/' kustomization.yaml
```

### 14.2 Repoint every image to your local registry + tag

The base (`overlays/dev/kustomization.yaml`) still pins the old **ECR** images
(`539792720148.dkr.ecr…`). The base itself also carries bare `hope-v2/<name>:latest` refs. Set
the local registry+tag directly on the base (this rewrites the `images:` field — it wins over
the bare base refs; do this in `base/`, not the overlay):

```bash
kustomize edit set image \
  hope-v2/api="$R/api:$TAG",\
hope-v2/text="$R/text:$TAG",\
hope-v2/guardrail="$R/guardrail:$TAG",\
hope-v2/nlp="$R/nlp:$TAG",\
hope-v2/harness="$R/harness:$TAG",\
hope-v2/harness-worker="$R/harness-worker:$TAG",\
hope-v2/tts="$R/tts:$TAG",\
hope-v2/admin-console="$R/admin-console:$TAG",\
hope-v2/compat-playground="$R/compat-playground:$TAG",\
hope-v2/stt-ml-runtime="$R/stt-ml-runtime:$TAG",\
hope-v2/stt-worker="$R/stt-worker:$TAG",\
hope-v2/qdrant-init="$R/qdrant-init:$TAG",\
hope-v2/database="$R/database:$TAG"
```

### 14.3 Build the fleet manifest

```bash
mkdir -p /tmp/hope-deploy
kustomize build . > /tmp/hope-deploy/fleet.yaml
wc -l /tmp/hope-deploy/fleet.yaml
```

**Expected:** `> 1500` lines (StatefulSets, Deployments, Jobs, ConfigMaps from the generators,
Services, Ingresses, PVCs).
**If it fails:** `error: image … not found` → the key/name doesn't match a manifest image
(compare `.github/services.json` names). `configMapGenerator` errors → a `config/*.env` has a
bare `KEY` with no `=` — fix the env file.

> The base bakes in `replicas: 0` for **every** workload by design (scale-on-demand). The
> steps below scale each one to its steady-state size after apply — that is the intended
> operating model, not a bug.

---

## STEP 15 — Deploy the stateful data core: Postgres, Redis, MinIO

These three must be **Ready** before anything else (everything depends on one of them). Apply
the fleet once, then bring each stateful server up in order and verify it.

### 15a. Apply the fleet (creates ALL namespaced objects at replicas: 0)

```bash
kubectl -n $NS apply --server-side -f /tmp/hope-deploy/fleet.yaml
kubectl -n $NS get statefulset,deploy,job
```

**Expected:** every workload present with `0/0` ready.
**If it fails:** a malformed Ingress (`namespace: hope-v2-dev` hardcoded in base) — patch or
ignore; the Ingresses are optional for this LAN deploy. Note `hope-db-migrate` /
`hope-qdrant-init` may briefly run and fail here (Postgres/Qdrant not ready) — that is fine;
Steps 19/18b re-run them cleanly.

### 15b. Postgres

```bash
kubectl -n $NS scale statefulset hope-postgres --replicas=1
kubectl -n $NS rollout status statefulset/hope-postgres
```
**Verify probe:** `kubectl -n $NS exec hope-postgres-0 -c postgres -- pg_isready -U hope -d arcaai_hope`
**Expected:** `… accepting connections`.
**If it fails:** `CrashLoop` → read `kubectl -n $NS logs hope-postgres-0`. Missing
`hope-postgres-auth` secret (Step 13a) = `role "…" does not exist`. The PVC `arca-db`
`storageClassName` must exist (`kubectl get sc`), else pods stay Pending.

### 15c. Redis

```bash
kubectl -n $NS scale statefulset hope-redis --replicas=1
kubectl -n $NS rollout status statefulset/hope-redis
```
**Verify probe:** `kubectl -n $NS exec hope-redis-0 -- redis-cli -a $REDIS_PASSWORD ping` →
`PONG`.
**If it fails:** missing `hope-redis-auth` (Step 13b) → `no password is set`; PVC issue →
Pending, check `kubectl -n $NS describe pod hope-redis-0`.

### 15d. MinIO (+ bucket provision Job)

```bash
kubectl -n $NS scale statefulset hope-minio --replicas=1
kubectl -n $NS rollout status statefulset/hope-minio
# bucket `arcaai-hope-dev` + `anon=none` (hope-minio-provision Job is a PostSync hook;
# re-run it explicitly now that MinIO answers)
kubectl -n $NS delete job hope-minio-provision --ignore-not-found
kubectl -n $NS apply -f /tmp/hope-deploy/fleet.yaml
kubectl -n $NS wait --for=condition=complete job/hope-minio-provision --timeout=60s
```
**Verify:** `curl -s http://$K3S_NODE_IP:39000/minio/health/ready` (NodePort from Step 21) or
in-cluster `kubectl -n $NS run mc --rm -it --image=minio/mc -- mc alias set loc
http://hope-minio:9000 <user> <pass> && mc ls loc`
**If it fails:** Job fails → `MINIO_ROOT_USER/PASSWORD` mismatch with `hope-minio-auth`
(Step 13c).

---

## STEP 16 — Deploy Vault (+ auto-init Job)

Vault backs the gateway's secrets and PHI transit. It must be Healthy **and initialized**
before the gateway starts.

```bash
kubectl -n $NS scale statefulset hope-vault --replicas=1
kubectl -n $NS rollout status statefulset/hope-vault
kubectl -n $NS wait --for=condition=complete job/hope-vault-init --timeout=120s
kubectl -n $NS get secret hope-vault-init -o jsonpath='{.data.root_token}' | base64 -d
```
**Expected:** vault pod Ready; the init Job completes (it initializes with 5 shares/threshold 3
and unseals with the first 3); the printed token is the Vault root token.
**If it fails:** Job CrashLoop → `alpine/kubectl` image pull blocked (mirror needed), or
`hope-vault` not ready when the Job's `until … sleep 3` loop starts (it self-waits, so give it
`60s`). If a second run says `"initialized":true`, the init already succeeded — the Job exits 0
by design.
**Get an AppRole for the gateway** (so Step 13d's `VAULT_ROLE_ID`/`VAULT_SECRET_ID` are real):
follow `docs/operations/vault/README.md` in the monorepo (enable `approle`, write
`secret/hope/*`, create a role, `read` its role-id, `secret-id`). For a quick env-backend
deploy you can instead set `SECRETS_PROVIDER=env` in Step 20a and keep these empty.

---

## STEP 17 — Deploy Temporal (+ UI)

Temporal powers the Harness durable workflows (Step 20f/20g). It needs the Postgres creds
from `hope-secrets` (`TEMPORAL_DB_HOST/USER/PASSWORD`) and waits for Postgres in an
initContainer.

```bash
kubectl -n $NS scale deploy hope-temporal --replicas=1
kubectl -n $NS rollout status deploy/hope-temporal
kubectl -n $NS scale deploy hope-temporal-ui --replicas=1
kubectl -n $NS rollout status deploy/hope-temporal-ui
```
**Verify:**
```bash
kubectl -n $NS run tctl --rm -it --restart=Never --image=alpine:3.20 -- \
  sh -c 'apk add -q curl && curl -fsS http://hope-temporal:7233/health'
```
**Expected:** Temporal API `/health` 200 and the UI routes on `hope-temporal-ui:8080`.
**If it fails:** initContainer `wait-for-postgres` loops → `TEMPORAL_DB_HOST` wrong or
Postgres not ready (Step 15b). `DB_PORT` is hardcoded `5000` in the manifest while Postgres is
`5432` — if you see `could not connect… 5000`, patch the Deployment:
`kubectl -n $NS set env deploy/hope-temporal DB_PORT=5432` then `scale --replicas=0/1`.

> **Note:** the auto-setup image auto-creates the `temporal`/`temporal_visibility` databases
> inside `arcaai_hope` (or its own `DBNAME`) on first boot.

---

## STEP 18 — Deploy Qdrant (+ collection-init Job)

Qdrant backs the Harness institutional-RAG retriever. **Auth defaults off** until
`QDRANT_API_KEY`/`QDRANT_READ_ONLY_API_KEY` populate `hope-secrets`.

```bash
kubectl -n $NS scale statefulset hope-qdrant --replicas=1
kubectl -n $NS rollout status statefulset/hope-qdrant
kubectl -n $NS delete job hope-qdrant-init --ignore-not-found
kubectl -n $NS apply -f /tmp/hope-deploy/fleet.yaml
kubectl -n $NS wait --for=condition=complete job/hope-qdrant-init --timeout=120s
```
**Verify:**
```bash
kubectl -n $NS run qcheck --rm -it --restart=Never --image=curlimages/curl:8.11.1 -- \
  sh -c 'curl -fsS http://hope-qdrant:6333/readyz && echo '
kubectl -n $NS logs job/hope-qdrant-init
```
**Expected:** `/readyz` 200; init Job logs confirm `knowledge_chunks` collection exists
(`create_collection` is idempotent — existing collection left untouched).
**If it fails:** Job never completes → Qdrant wasn't ready when it started (wait for rollout,
re-run the delete+apply); Job's S3 snapshot section: if any `QDRANT_SNAPSHOTS_S3_*` key lands
in `hope-secrets` without all four, Qdrant crash-loops (`missing configuration field
…s3_config.bucket`) — don't add those keys unless you add all four.

---

## STEP 19 — Run the database migrations (hope-db-migrate Job)

Migrations run **after** Postgres, before any app. It is an Argo `PreSync` hook (`sync-wave:
-1`); `kubectl apply` doesn't honour hooks, so run it explicitly:

```bash
kubectl -n $NS delete job hope-db-migrate --ignore-not-found
kubectl -n $NS apply -f /tmp/hope-deploy/fleet.yaml
kubectl -n $NS wait --for=condition=complete job/hope-db-migrate --timeout=300s
kubectl -n $NS logs job/hope-db-migrate
```
**Expected:** Job completes; logs show `prisma migrate` / schema applications. The manifest
sets `RUN_SEED=none` (no demo credentials, no synthetic PHI) and `NODE_ENV=production`
(from `hope-platform-config`) so migrations use the recorded-migration path, not `db push`.
**If it fails:** `DATABASE_URL` from `hope-secrets` wrong (Step 13d) — the Job only reads the
secret, no init wait. Fix the secret and `delete`+`apply` again (the Job has
`ttlSecondsAfterFinished: 3600`).

---

## STEP 20 — Deploy the CPU app services to k3s

All eleven are already applied (replicas: 0) by Step 15a. Bring each up **in dependency
order**, verify its probe, then move on. Steady-state sizes: `hope-api` 1 (2 in prod),
`hope-text` 2, everything else 1. All base HPAs/PDBs are commented out — scaling below is the
manual operating mode this runbook uses.

### 20a. API gateway — `hope-api` (:8868)

```bash
kubectl -n $NS scale deploy hope-api --replicas=1
kubectl -n $NS rollout status deploy/hope-api
```
**Env source:** `hope-platform-config` + `hope-api-config` (ConfigMaps) + `hope-secrets`.
Explicit env in the manifest: `SECRETS_PROVIDER=vault`, `VAULT_ADDR=http://hope-vault:8200`,
`PORT=8868`, `ENABLE_SWAGGER=true`, `STT_V2_URL`/`SMR_URL`/`NLP_URL` from ConfigMap. Probes:
startup `/api/v1/health/startup`, readiness `/api/v1/health/ready`, liveness
`/api/v1/health/live`.

**Verify:**
```bash
kubectl -n $NS exec deploy/hope-api -- wget -qO- http://localhost:8868/api/v1/health/ready
```
**If it fails:** `1/3 Running` then `CrashLoop` → Vault not up (Step 16) or
`VAULT_ROLE_ID/SECRET_ID` empty — either finish AppRole setup or set
`kubectl -n $NS set env deploy/hope-api SECRETS_PROVIDER=env` and roll over. Missing
`DATABASE_URL`/`JWT_SECRET_KEY` → re-check Step 13d.

> After Step 22/23 (NodePorts + GPU) you will restart this Deployment with `STT_URL`/`TEXT_URL`
> — Step 29.

### 20b. TEXT — `text` (:8862) — replaces the stale `hope-smr`

The base `smr.yaml` is excluded (Step 14.1). Install TEXT with its own manifest (namespace
`$NS`), tagged with your `$TAG`:

```bash
cat <<YAML | sed "s#__TAG__#$TAG#g" | kubectl -n "$NS" apply -f -
apiVersion: v1
kind: ConfigMap
metadata: { name: text-env, namespace: $NS }
data:
  NODE_ENV: production
  OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: "NO_CONTENT"
  TEXT_PORT: "8862"
  TEXT_LOG_LEVEL: info
  TEXT_GATEWAY_URL: http://hope-api:8868/api/v1
  TEXT_REDIS_URL: redis://hope-redis:6379/0
  TEXT_EXTERNAL_GUARDRAIL_BASE_URL: http://hope-guardrail:8863
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: text, namespace: $NS }
spec:
  replicas: 2
  selector: { matchLabels: { app: text } }
  template:
    metadata: { labels: { app: text } }
    spec:
      containers:
        - name: text
          image: $R/text:__TAG__
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
metadata: { name: text, namespace: $NS }
spec:
  type: ClusterIP
  selector: { app: text }
  ports: [{ port: 8862, targetPort: 8862, name: http }]
YAML
```
First create the shared token it references:
```bash
kubectl -n $NS create secret generic hope-shared-secrets \
  --from-literal=INTERNAL_ACCESS_TOKEN=<shared-token> --dry-run=client -o yaml | kubectl apply -f -
kubectl -n $NS rollout status deploy/text
```
**Verify:** `kubectl -n $NS get pods -l app=text` → 2/2 Ready.
**If it fails:** `ImagePullBackOff` → `kubectl -n $NS describe pod -l app=text` for `403`
(add an `imagePullSecret` for the registry) or a tag typo. `CrashLoop` → `logs deploy/text
--tail=50`; a `Settings` exception near the top means missing env
(`INTERNAL_ACCESS_TOKEN` / `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=NO_CONTENT`).

### 20c. Guardrail — `hope-guardrail` (:8863)

```bash
kubectl -n $NS scale deploy hope-guardrail --replicas=1
kubectl -n $NS rollout status deploy/hope-guardrail
```
**Env source:** `hope-platform-config` + `hope-secrets`. Explicit: `GUARDRAIL_V2_PORT=8863`,
`GUARDRAIL_V2_GATEWAY_URL=http://hope-api:8868/api/v1`,
`GUARDRAIL_OPENAI_COMPAT_BASE_URL=http://hope-lmstudio:1234/v1`,
`GUARDRAIL_OPENAI_COMPAT_GUARDRAIL_MODEL=granite-guardian-4.1-8b`,
`GUARDRAIL_SERVICE_TOKEN=<from hope-secrets>`. Probes: **startup/readiness/liveness on
`/api/health/live` / `/api/health/ready` — note NO `/v1` prefix** (this differs from every
other service). Mounts a RWO PVC `guardrail-hf-cache` (1 Gi, `arca-db`) — scale beyond 1 would
need that cache off RWO.

**Verify:**
```bash
kubectl -n $NS exec deploy/hope-guardrail -- wget -qO- http://localhost:8863/api/health/ready
```
**If it fails:** `ErrImagePull` → your `$R/guardrail:$TAG` didn't build/push (Step 8/11).
CrashLoop → `GUARDRAIL_SERVICE_TOKEN` absent is tolerated (optional) but the LM-Studio model
name must match what the engine serves.

### 20d. NLP — `hope-nlp` (:8864)

```bash
kubectl -n $NS scale deploy hope-nlp --replicas=1
kubectl -n $NS rollout status deploy/hope-nlp
```
**Env source:** `hope-platform-config` + `hope-secrets`; explicit `PORT=8864`.
Probes: startup `/api/v1/health`, readiness `/api/v1/health/ready`, liveness
`/api/v1/health/live`. Sets `imagePullSecrets: hope-registry-creds` — create that secret if
your registry is auth'd: `kubectl -n $NS create secret docker-registry hope-registry-creds
--docker-server=$REGISTRY --docker-username=<u> --docker-password=<p>`
**Verify:** `kubectl -n $NS exec deploy/hope-nlp -- wget -qO- http://localhost:8864/api/v1/health`
**If it fails:** model download at first run is heavy (HuggingFace) — give the pod `5–10 min`
on cold start; watch `logs deploy/hope-nlp` for the transformer download.

### 20e. Harness — `hope-harness` (:8866)

```bash
kubectl -n $NS scale deploy hope-harness --replicas=1
kubectl -n $NS rollout status deploy/hope-harness
```
**Env source:** `hope-platform-config` + `hope-harness-config` + `hope-secrets`. Explicit:
`HARNESS_HOST=0.0.0.0`, `HARNESS_PORT=8866`, `HARNESS_ENVIRONMENT=production`,
`HARNESS_API_BASE_URL=http://hope-api:8868` (**this is a non-optional ref; absent → harness
calls itself**, `config.py:341`), `TEMPORAL_ADDRESS=hope-temporal:7233`,
`TEMPORAL_NAMESPACE=default`, `TEMPORAL_TASK_QUEUE=harness-task-queue`,
`HARNESS_SERVICE_TOKEN`, optional `HARNESS_INTERNAL_SERVICE_TOKEN` (absent = documented
dev-mode bypass, supported).
**Verify:**
```bash
kubectl -n $NS exec deploy/hope-harness -- wget -qO- http://localhost:8866/api/v1/health/ready
```
**If it fails:** `HARNESS_API_BASE_URL` missing → check `hope-harness-config` ConfigMap
generated in Step 14.3 (key must exist).

### 20f. Harness worker — `hope-harness-worker` (Temporal consumer)

```bash
kubectl -n $NS scale deploy hope-harness-worker --replicas=1
kubectl -n $NS rollout status deploy/hope-harness-worker
```
**Env source:** same as harness + `HARNESS_CLAIM_CHECK_ENDPOINT_URL/ACCESS_KEY/SECRET_KEY`
mapped from `hope-secrets` **`MINIO_ENDPOINT`/`MINIO_ACCESS_KEY`/`MINIO_SECRET_KEY`** (the
prefix differs! `HARNESS_CLAIM_CHECK_*` ← MinIO keys). `HARNESS_ENVIRONMENT=production`
enables the claim-check guard. **Liveness = heartbeat file** (`/tmp/harness-worker-heartbeat`,
`-mmin -1`), startupProbe tests the file exists — no HTTP probes, nothing routes to it. Runs as
uid/gid 1001 (`runAsUser: 1001`, requires `hope-python-base`'s `USER hope`).
**Verify:** heartbeat file fresh:
```bash
kubectl -n $NS exec deploy/hope-harness-worker -- sh -c 'find /tmp/harness-worker-heartbeat -mmin -1 | grep -q . && echo HEARTBEAT_OK'
```
**If it fails:** `CreateContainerConfigError` → a key is missing (`HARNESS_CLAIM_CHECK_SECRET_KEY`,
or `MINIO_*` absent from `hope-secrets`), or `HARNESS_INTERNAL_SERVICE_TOKEN` was added to one
side of the pair but not the other. Worker also needs Temporal healthy (Step 17) to register.

### 20g. TTS — `hope-tts` (:8865)

```bash
kubectl -n $NS scale deploy hope-tts --replicas=1
kubectl -n $NS rollout status deploy/hope-tts
```
**Env source:** `hope-platform-config` + `hope-secrets`. Explicit: `TTS_HOST=0.0.0.0`,
`TTS_PORT=8865`, `TTS_AZURE_ENABLED=true` (keyless — Azure is BYOK per-request), `TTS_KOKORO_ENABLED=true`,
`TTS_SARVAM_ENABLED=false`, `HF_HUB_CACHE=/mnt/models-cache` (shared hostPath
`/mnt/data/models-cache`, same as STT), `OMP/MKL/TORCH_NUM_THREADS=2`. An initContainer
`init-hf-cache` chowns the cache (uid 1001) only when needed. Probes: startup/readiness/liveness on
`/api/v1/health/live` `/api/v1/health/ready` with `timeoutSeconds: 5` (a cold synth under
CPU throttle can push a probe past the 1 s default).
**Verify:**
```bash
kubectl -n $NS exec deploy/hope-tts -- wget -qO- http://localhost:8865/api/v1/health/ready
```
**If it fails:** first synth on an empty cache pulls Kokoro weights (~327 MB) — keep the pod
up; the read-through cache self-heals (it is NOT `HF_HUB_OFFLINE`). Resource `1536Mi/4Gi`
requests — tiny limits → OOMKill on first synth (check `kubectl -n $NS describe pod` for
`OOMKilled`).

### 20h. Admin console — `hope-admin-console` (:3000)

```bash
kubectl -n $NS scale deploy hope-admin-console --replicas=1
kubectl -n $NS rollout status deploy/hope-admin-console
```
**Env source:** `hope-admin-console-config` (ConfigMap) + `hope-secrets`. Explicit keys:
`PORT=3000`, `HOSTNAME=0.0.0.0`, `API_URL=http://hope-api:8868`, `NEXT_PUBLIC_API_HOST`, and
**`ADMIN_SESSION_SECRET`** from `hope-secrets` (missing → 500 on login). Probes: `/login`.
**Verify:**
```bash
kubectl -n $NS exec deploy/hope-admin-console -- wget -qO- http://localhost:3000/login
```
**If it fails:** HTTP 500 on `/login` → create `ADMIN_SESSION_SECRET` in `hope-secrets`
(Step 13d) and restart the Deployment with `kubectl -n $NS rollout restart deploy/hope-admin-console`.

### 20i. Compat playground — `hope-compat-playground` (:3000)

Only if you have the image (it has no build job). NodePort `30082` in the base.

```bash
kubectl -n $NS scale deploy hope-compat-playground --replicas=1 || echo "skip: image unavailable"
kubectl -n $NS rollout status deploy/hope-compat-playground || echo "skip: image unavailable"
```
**If it fails:** no `hope-v2/compat-playground` in your registry (`ErrImagePull`) — leave at
`replicas: 0`; it is a dev-only compat page and nothing depends on it.

---

## STEP 21 — Expose Redis, MinIO and the gateway as NodePorts (for the GPU host)

The GPU server cannot resolve in-cluster DNS; it reaches Redis/MinIO/Gateway through
NodePorts. Patch the existing Services (do not create duplicates):

```bash
kubectl -n $NS patch svc hope-redis --type=merge -p \
  '{"spec":{"type":"NodePort","ports":[{"port":6379,"targetPort":6379,"nodePort":36379}]}}'
kubectl -n $NS patch svc hope-minio --type=merge -p \
  '{"spec":{"type":"NodePort","ports":[{"port":9000,"targetPort":9000,"nodePort":39000}]}}'
kubectl -n $NS patch svc hope-api   --type=merge -p \
  '{"spec":{"type":"NodePort","ports":[{"port":8868,"targetPort":8868,"nodePort":38868}]}}'
```
**Verify:**
```bash
kubectl -n $NS get svc hope-redis hope-minio hope-api
```
**Expected:** all three `NodePort` with nodePorts 36379 / 39000 / 38868.
**If it fails:** a nodePort is out of k3s range (30000–32767) or taken — pick another and
re-patch.

---

## STEP 22 — Verify the NodePorts are reachable from the GPU server

Run **on the GPU server**:

```bash
nc -vz "$K3S_NODE_IP" 36379 && echo "redis OK"
nc -vz "$K3S_NODE_IP" 39000 && echo "minio OK"
curl -s "http://$K3S_NODE_IP:38868/api/v1/health" | python3 -m json.tool
```
**Expected:** all three pass; gateway answers.
**If it fails:** firewall — open `36379,39000,38868/tcp` inbound on the k3s node
(`firewall-cmd --add-port=…` and make permanent), re-test. Do **not** proceed — STT needs
these at Step 26.

---

## STEP 23 — Prepare the GPU server (Docker + NVIDIA)

```bash
# 23a. NVIDIA container toolkit (once)
sudo apt-get update && sudo apt-get install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker

# 23b. Prove the GPU works in a container
docker run --rm --gpus all nvidia/cuda:12.8.1-runtime-ubuntu22.04 nvidia-smi
```
**Expected (23b):** `RTX 6000 Ada Generation` and a CUDA driver version.
**If it fails:** `could not select device driver` → toolkit not configured (re-run 23a);
`nvidia-smi` shows no card → host driver missing (fallback is CPU-only decode — not what this
runbook wants).

---

## STEP 24 — Sync the model weights (`hope-models` → `/srv/hope/models`)

Produce a read-only `/models` tree on the GPU host; `HF_HUB_OFFLINE=1` makes a missing weight
a loud failure, never a silent download.

Option A — snapshot (simplest):
```bash
sudo mkdir -p /srv/hope/models
mc alias set hminio "http://$K3S_NODE_IP:39000" <minio-access-key> <minio-secret-key>
mc mirror --overwrite hminio/hope-models /srv/hope/models
```
Option B — live read-only mount:
```bash
sudo apt-get install -y s3fs
echo "<minio-access-key>:<minio-secret-key>" | sudo tee /etc/hope/minio.s3fs && sudo chmod 600 /etc/hope/minio.s3fs
# fstab: s3fs#hope-models /srv/hope/models fuse.s3fs url=http://$K3S_NODE_IP:39000,passwd_file=/etc/hope/minio.s3fs,ro,umask=022 0 0
sudo mount /srv/hope/models
```
**Verify:** `ls /srv/hope/models` shows the weight tree (e.g. `whisper-*`).
**If it fails:** the `hope-models` bucket doesn't exist — create it (`mc mb hminio/hope-models`
or on the k3s side), then re-run.

---

## STEP 25 — Create the STT secrets file `/etc/hope/stt.env`

Two containers (`stt-api`, `stt-worker`) share this file. Fill the `<values>`; keep the key
names:

```bash
sudo mkdir -p /etc/hope
sudo tee /etc/hope/stt.env >/dev/null <<EOF
LOG_LEVEL=INFO
HOST=0.0.0.0
PORT=8861

INTERNAL_ACCESS_TOKEN=<shared-token>

REDIS_URL=redis://$K3S_NODE_IP:36379/0

MINIO_ENDPOINT=$K3S_NODE_IP:39000
MINIO_ACCESS_KEY=<minio-access-key>
MINIO_SECRET_KEY=<minio-secret-key>
MINIO_SECURE=false
MINIO_CERT_CHECK=false

API_GATEWAY_URL=http://$K3S_NODE_IP:38868/api/v1
API_GATEWAY_KEY=<registered-apikey-value>
API_GATEWAY_TIMEOUT=30

STT_DATABASE_ENABLED=false

HF_HOME=/models/hf-cache
HUGGINGFACE_CACHE_DIR=/models/hf-cache/hub
HF_HUB_OFFLINE=1

METRICS_ENABLED=true
EOF
sudo chmod 600 /etc/hope/stt.env
```
**Verify:** `sudo cat /etc/hope/stt.env | grep -c '='` > 0, and `MINIO_ENDPOINT` is a bare
`host:port` (no scheme).
**If it fails:** any required value empty — the ENV is the whole config; an empty
MinIO/Redis value fails silently at runtime (see `STT_TEXT_GPU_DEPLOY.md` §11).

---

## STEP 26 — Start the STT API container (`stt-ml-runtime`)

```bash
docker run -d --name stt-api --restart unless-stopped \
  --gpus all \
  -p 8861:8861 \
  --env-file /etc/hope/stt.env \
  -v /srv/hope/models:/models:ro \
  "$R/stt-ml-runtime:$TAG"
```
Wait ~30–60 s, watch the boot log:
```bash
docker logs -f stt-api
```
**Expected boot sequence:**
```text
cuda-preflight: CUDA driver up; sm_89 covered by 89-real;89-virtual
INFO:     Uvicorn running on http://0.0.0.0:8861
```
**If it fails:**
- `no GPU allocated (/dev/nvidiactl absent) — continuing on CPU` → no `--gpus all` or toolkit
  not the default runtime (Step 23).
- `FATAL: this image has no runnable kernels for sm_XX` → wrong `CUDA_ARCHITECTURES`; rebuild
  with `89-real;89-virtual` (Step 9).
- exits immediately → `docker logs stt-api`; usually an empty/invalid key in
  `/etc/hope/stt.env` (Step 25) or missing `/models` (Step 24).

---

## STEP 27 — Verify the STT API

Run on the GPU server:
```bash
curl -s http://localhost:8861/api/v1/health | python3 -m json.tool
docker logs stt-api | grep -c 'cuda-preflight'
```
**Expected:** health 200; the preflight grep returns > 0 and has **no** `no GPU allocated`.
**If it fails:** see Step 26's failure lines. Do not start the worker until the API is healthy
— they share failures and you want them visible one at a time.

---

## STEP 28 — Start the STT worker container (`stt-worker`)

```bash
docker run -d --name stt-worker --restart unless-stopped \
  --gpus all \
  --env-file /etc/hope/stt.env \
  -v /srv/hope/models:/models:ro \
  "$R/stt-worker:$TAG"
```
30 s later, check the Dramatiq heartbeat files (must be < 1 min old):
```bash
docker exec stt-worker sh -c 'ls -la /tmp/stt-worker-heartbeat/'
```
**Expected:** a `*.heartbeat` file whose timestamp is < 60 s old.
**If it fails:** no heartbeat → Redis unreachable (`nc -vz "$K3S_NODE_IP" 36379`); if Redis is
fine, read `docker logs stt-worker` for the broker error.

---

## STEP 29 — Wire the gateway to STT and TEXT, then restart it

Run on a machine with `kubectl`. `STT_URL`/`TEXT_URL` are resolved **once** at gateway
bootstrap, so the Deployment must restart:

```bash
kubectl -n $NS set env deploy/hope-api \
  STT_URL=http://$GPU_HOST_IP:8861 \
  TEXT_URL=http://text:8862
kubectl -n $NS rollout restart deploy/hope-api
kubectl -n $NS rollout status deploy/hope-api
```
**Expected:** `deployment "hope-api" successfully rolled out`.
**If it fails:** env names differ in your cluster (some manifests use `STT_V2_*`) — inspect
`kubectl -n $NS set env --list deploy/hope-api`; roll back with
`kubectl -n $NS rollout undo deploy/hope-api` and fix the names. Also ensure the k3s node
can reach the GPU host on `8861` (open inbound on the GPU server).

---

## STEP 30 — Final validation (gateway service health)

```bash
curl -s http://$K3S_NODE_IP:38868/api/v1/health/ready | python3 -m json.tool
```
**Expected:** HTTP 200, and the services list contains `stt: http://<gpu-ip>:8861` and
`text: http://text:8862` (plus the other routes the gateway tracks).
**If it fails:** `stt` 503 → Step 29's `STT_URL` didn't take (restart incomplete) or GPU host
firewall blocks `8861` from k3s nodes. `text` 503 → `text` Deployment not Ready yet (Step 20b).

---

## STEP 31 — End-to-end smoke test

### 31a. The automated fleet smoke Job (`hope-smoke-test`)

It checks the **same readiness path the kubelet trusts** for every HTTP service (paths
verified against base manifests), so it is a faithful fleet gate:

| check | URL |
|---|---|
| api | `http://hope-api:8868/api/v1/health/ready` |
| text | `http://hope-smr:8862/api/v1/health/ready` (host name is stale `hope-smr` — see note) |
| guardrail | `http://hope-guardrail:8863/api/health/ready` |
| harness | `http://hope-harness:8866/api/v1/health/ready` |
| nlp | `http://hope-nlp:8864/api/v1/health/ready` |
| tts | `http://hope-tts:8865/api/v1/health/ready` |
| stt | `http://hope-stt-v2:8861/api/v1/health` |
| admin-console | `http://hope-admin-console:3000/login` |
| compat-playground | `http://hope-compat-playground:3000/` |

Run it (it is a `PostSync` hook; explicit run):
```bash
kubectl -n $NS delete job hope-smoke-test --ignore-not-found
kubectl -n $NS apply -f /tmp/hope-deploy/fleet.yaml
kubectl -n $NS wait --for=condition=complete job/hope-smoke-test --timeout=300s
kubectl -n $NS logs job/hope-smoke-test
```
**Expected:** all nine lines print `OK`.
**If it fails / stale hostnames:** the Job predates two topology changes in this runbook:
- TEXT was renamed `smr` → `text`. Patch the check to `http://text:8862/api/v1/health/ready`
  before relying on it.
- STT (`hope-stt-v2`) runs **in Docker on the GPU server**, not in-cluster, in this topology.
  The `stt` line will always `FAILED` here — that's expected; STT's real check is Step 27/30.
  Either patch the Job to `http://$GPU_HOST_IP:8861/api/v1/health` (needs network AUTH from the
  pod) or accept this single known-failing line and validate STT at Step 27/30 instead.

Fix the Job (replaces both hostnames), then re-run:
```bash
# Patch the manifest BEFORE building the fleet (paths relative to deployment repo base):
sed -i '' 's#http://hope-smr:8862#http://text:8862#' \
         -e 's#http://hope-stt-v2:8861#http://'"$GPU_HOST_IP"':8861#' \
         base/smoke-test.yaml
# Re-generate the fleet and re-run the Job:
cd /Users/apple/repos/VOX/arca-deployment-template/deployment/k8s/base
kustomize build . > /tmp/hope-deploy/fleet.yaml
kubectl -n $NS delete job hope-smoke-test --ignore-not-found
kubectl -n $NS apply -f /tmp/hope-deploy/fleet.yaml
kubectl -n $NS wait --for=condition=complete job/hope-smoke-test --timeout=300s
kubectl -n $NS logs job/hope-smoke-test
```

### 31b. Functional E2E on the deployed stack

1. **Realtime STT:** open the gateway WebSocket `/ws/stt/stream`; speak; partials arrive and
   the final transcript persists (`/internal/stt/transcripts`).
2. **Batch STT:** create a `TranscriptionJob` through the API; watch `QUEUED →
   PROCESSING → COMPLETED`; the worker claims it — `docker logs -f stt-worker | grep -i
   'claim\|start\|complete'`.
3. **Generation:**

   ```bash
   curl -s http://$K3S_NODE_IP:38868/api/v1/text-generations/generate -X POST \
     -H 'Authorization: Bearer <token>' -H 'Content-Type: application/json' \
     -d '{"text":"Summarise: warm and normal.","tenantId":"<tenant>"}' \
     | python3 -m json.tool
   ```
   Expect 200 (proxied to TEXT; TEXT validates through Guardrail).
4. **GPU actually used:** completed jobs report `device=cuda`; on the GPU host:
   ```bash
   docker ps | grep -E 'stt-(api|worker)'
   nvidia-smi   # both containers hold context
   ```

All four passing = deployment complete.

---

## Appendix

### §A1. File reference index (used to write this runbook)

| File (absolute path) | Role |
|---|---|
| `/Users/apple/repos/VOX/project-hope/.github/services.json` | Single source of truth: image names, dockerfile, target, `pythonBase` (drives Steps 6–10) |
| `/Users/apple/repos/VOX/project-hope/tests/contracts/services-manifest.contract.test.ts` | Enforces services.json ↔ build.yml ↔ promote.sh ↔ version-grammar agreement |
| `/Users/apple/repos/VOX/project-hope/.gitlab/ci/build.yml` | CI build jobs (trigger model, per-service build) |
| `/Users/apple/repos/VOX/project-hope/.gitlab/ci/deploy.yml` | CI `promote-*` digest-promotion jobs |
| `/Users/apple/repos/VOX/project-hope/.gitlab/ci/promote.sh` | Digest promotion + kustomize pin + Argo push (the CI twin of Step 14.2) |
| `/Users/apple/repos/VOX/project-hope/infrastructure/docker/python-base/Dockerfile` | `hope-python-base` build-time base (Step 5) |
| `/Users/apple/repos/VOX/project-hope/apps/{api,text,guardrail,nlp,harness,tts}/Dockerfile` | Service images (Steps 6–8) |
| `/Users/apple/repos/VOX/project-hope/apps/admin-console/Dockerfile` | Next.js admin console image (Step 6b) |
| `/Users/apple/repos/VOX/project-hope/apps/stt/docker/Dockerfile` | STT `ml-runtime`/`worker` targets, `CUDA_ARCHITECTURES` (Step 9) |
| `/Users/apple/repos/VOX/project-hope/packages/database/Dockerfile` | `database` migration image (Step 6c, db-migrate Job) |
| `/Users/apple/repos/VOX/project-hope/infrastructure/docker/qdrant-init/Dockerfile` | `qdrant-init` Job image (Step 6d) |
| `/Users/apple/repos/VOX/project-hope/infrastructure/docker/lmstudio/Dockerfile` | LM Studio engine image (optional Step 10) |
| `/Users/apple/repos/VOX/arca-deployment-template/deployment/k8s/base/kustomization.yaml` | Fleet inventory + configMapGenerator (Step 14) |
| `/Users/apple/repos/VOX/arca-deployment-template/deployment/k8s/base/{api,guardrail,nlp,harness,harness-worker,tts-v2,admin-console,compat-playground}.yaml` | CPU app manifests (Step 20) |
| `/Users/apple/repos/VOX/arca-deployment-template/deployment/k8s/base/{postgres,redis,minio,vault,temporal,qdrant,qdrant-init,db-migrate,smoke-test}.yaml` | Infra + Job manifests (Steps 15–19, 31) |
| `/Users/apple/repos/VOX/arca-deployment-template/deployment/k8s/base/stt-v2.yaml` | Reference GPU pod env/probes (Star of Steps 25–28) |
| `/Users/apple/repos/VOX/arca-deployment-template/deployment/k8s/base/stt-v2-worker.yaml` | Reference STT worker pod |
| `/Users/apple/repos/VOX/arca-deployment-template/deployment/k8s/base/smr.yaml` | **Stale pre-rename TEXT** — excluded via Step 14.1; do not use |
| `/Users/apple/repos/VOX/arca-deployment-template/deployment/k8s/base/gpu-time-slicing.yaml` | GPU time-slicing policy (out-of-band, not in kustomization) |
| `/Users/apple/repos/VOX/arca-deployment-template/deployment/k8s/base/config/*.env` | Per-service ConfigMap sources (`hope-platform-config`, `hope-api-config`, `hope-stt-config`, `hope-harness-config`, `hope-admin-console-config`, …) |
| `/Users/apple/repos/VOX/arca-deployment-template/deployment/k8s/overlays/dev/kustomization.yaml` | Dev overlay with the stale ECR `images:` pins (bypassed by Step 14.2) |
| `/Users/apple/repos/VOX/arca-deployment-template/docs/deployment-runbook.md` | Operating guide: GPU slicing, Argo, failure patterns |
| `/Users/apple/repos/VOX/review/codewalk/STT_TEXT_GPU_DEPLOY.md` | Topology + wiring this runbook executes |

### §A2. Build-time facts (from `services.json`)

| Service | dockerfile | context | target | pythonBase | BUILD_* needed |
|---|---|---|---|---|---|
| `admin-console` | `apps/admin-console/Dockerfile` | `.` | — | false | NEXT_PUBLIC_API_HOST |
| `api` | `apps/api/Dockerfile` | `.` | — | false | yes |
| `database` | `packages/database/Dockerfile` | `.` | — | false | yes |
| `guardrail` | `apps/guardrail/Dockerfile` | `.` | `production` | true | yes |
| `harness` | `apps/harness/Dockerfile` | `.` | `production` | true | yes |
| `harness-worker` | `apps/harness/Dockerfile` | `.` | `worker` | true | yes |
| `hope-python-base` | `infrastructure/docker/python-base/Dockerfile` | `infrastructure/docker/python-base/` | — | false | — |
| `lmstudio` | `infrastructure/docker/lmstudio/Dockerfile` | `infrastructure/docker/lmstudio/` | — | false | — |
| `nlp` | `apps/nlp/Dockerfile` | `.` | — | true | yes |
| `qdrant-init` | `infrastructure/docker/qdrant-init/Dockerfile` | `.` | — | false | — |
| `stt-ml-runtime` | `apps/stt/docker/Dockerfile` | `.` | `ml-runtime` | false | CUDA_ARCHITECTURES |
| `stt-worker` | `apps/stt/docker/Dockerfile` | `.` | `worker` | false | CUDA_ARCHITECTURES |
| `text` | `apps/text/Dockerfile` | `.` | — | true | yes |
| `tts` | `apps/tts/Dockerfile` | `.` | `production` | true | yes |

(`compat-playground` has **no** entry — no build job exists for it.)

### §A3. Deployment sequence (dependency summary)

```
registry (2) → trust (3,4) → base (5) → builds (6–10) → push (11)
→ secrets (13) → fleet manifest (14)
→ postgres (15b) → redis (15c) → minio (15d)
→ vault + init (16) → temporal + ui (17) → qdrant + init (18)
→ db-migrate (19)
→ api (20a) → text (20b) → guardrail (20c) → nlp (20d)
→ harness (20e) → harness-worker (20f) → tts (20g)
→ admin-console (20h) → compat-playground (20i)
→ NodePorts (21) → GPU reachability (22)
→ GPU prep (23) → models (24) → stt.env (25)
→ stt-api (26) → verify (27) → stt-worker (28)
→ gateway wiring STT/TEXT (29) → final health (30) → smoke (31)
```

### §A4. On the CI/Argo twin

In production this exact topology is deployed by GitLab + Argo CD, not by hand:

- Branch push to `dev-*/staging-*/prod-*/cicd` builds **all** images env-tagged in CI; a git
  tag `<SVC>-<ver>` builds one service; `ALL-<ver>` builds everything.
- `promote.sh` (`.gitlab/ci/promote.sh`) does the equivalent of Step 14.2 with **digest pins**
  (`hope-v2/<name>@sha256:…` via `docker buildx imagetools create`), commits the overlay in
  the `arca/hope-v2-deployment` repo, and Argo CD syncs it onto the cluster. There is no
  `latest` for app services — only `hope-python-base:latest` (build-time).
- The GPU STT design is kept in `review/codewalk/STT_TEXT_GPU_DEPLOY.md`; the k3s `stt-v2.yaml`
  works equivalently but its pod runs on a `nodepool: gpu` node with `runtimeClassName: nvidia`,
  toleration `nvidia.com/gpu`, and `NVIDIA_DRIVER_CAPABILITIES=compute,utility`. This runbook's
  Docker-containers-on-the-GPU-server path is the equivalent without a GPU node label.
```