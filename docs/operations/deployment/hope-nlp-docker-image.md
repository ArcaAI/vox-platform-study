# NLP Service Docker Build & Deployment Runbook

## Overview

- **Service**: HOPE Medical NLP Service (`hope-nlp`)
- **Port**: `8864`
- **Target Platform**: `linux/amd64`
- **Base Image**: `hope-python-base:latest`
- **Context Root**: Repository root (`.`)
- **Cluster Registry**: `192.168.112.13:5000`

---

## 1. Build Base Image (`hope-python-base`)

The NLP Dockerfile inherits from `hope-python-base:latest`, which supplies `uv`, PyTorch runtime dependencies (`libgomp1`), and the non-root `hope` runtime user.

Run once from the repository root:

```bash
docker build --platform linux/amd64 \
  -t hope-python-base:latest \
  infrastructure/docker/python-base/
```

Verify local presence:

```bash
docker images | grep hope-python-base
```

---

## 2. Service Image Build

Build from the **repository root**. The Dockerfile enforces build identity metadata via `set -eu` to generate `/app/build-info.json`.

```bash
docker build --platform linux/amd64 \
  -f apps/nlp/Dockerfile \
  --build-arg BASE_IMAGE="hope-python-base:latest" \
  --build-arg BUILD_SERVICE=nlp \
  --build-arg BUILD_VERSION="dev" \
  --build-arg BUILD_GIT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main") \
  --build-arg BUILD_GIT_SHA=$(git rev-parse HEAD 2>/dev/null || echo "local") \
  --build-arg BUILD_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ) \
  -t nlp:dev .
```

---

## 3. Local Verification & Smoke Testing

### 3.1 Verify Embedded Build Metadata

```bash
docker run --rm nlp:dev cat /app/build-info.json
```

### 3.2 Run the Container Locally

```bash
docker run -d \
  --name hope-nlp \
  -p 8864:8864 \
  nlp:dev
```

### 3.3 Check Logs

```bash
docker logs -f hope-nlp
```

### 3.4 Smoke Test Endpoints

```bash
# Root endpoint
curl -s http://localhost:8864/ | jq .

# Detailed health check
curl -s http://localhost:8864/api/v1/health | jq .

# Kubernetes Liveness probe
curl -s http://localhost:8864/api/v1/health/live

# Kubernetes Readiness probe
curl -s http://localhost:8864/api/v1/health/ready
```

### 3.5 Stop and Remove Test Container

```bash
docker stop hope-nlp && docker rm hope-nlp
```

---

## 4. Tag & Push to Docker Registry

```bash
# Tag for cluster registry
docker tag nlp:dev 192.168.112.13:5000/nlp:latest
docker tag nlp:dev 192.168.112.13:5000/hope-nlp:latest

# Push to registry
docker push 192.168.112.13:5000/nlp:latest
docker push 192.168.112.13:5000/hope-nlp:latest
```

---

## 5. Deploy Workload via Kubernetes Cluster UI

When deploying through the cluster management web dashboard (Deploy Workload form), enter the following configuration:

### 5.1 General Settings

| UI Field                 | Value                              | Notes / Instructions                |
| ------------------------ | ---------------------------------- | ----------------------------------- |
| **Target Cluster** | *(Select your active cluster)*   | Choose target k8s/k3s cluster       |
| **Workload Type**  | **Deployment**               | Stateless app with rolling updates  |
| **Container Name** | `hope-nlp`                       | Name of the container               |
| **Namespace**      | `hope` *(or `default`)*      | Target namespace where services run |
| **Image**          | `192.168.112.13:5000/nlp:latest` | Registry image path                 |
| **Replicas**       | `1`                              | Start with 1 replica                |
| **Container Port** | `8864`                           | Service listening port              |

### 5.2 Command & Arguments (CRITICAL)

| UI Field          | Value                 | Warning                                                                                 |
| ----------------- | --------------------- | --------------------------------------------------------------------------------------- |
| **Command** | **LEAVE EMPTY** | ⚠️**Do NOT enter `/bin/sh, -c`**. Uvicorn ENTRYPOINT is baked into the image. |
| **Args**    | **LEAVE EMPTY** | ⚠️**Do NOT enter `echo hello`**.                                              |

### 5.3 Environment Variables

Add the following key-value pairs under **Environment Variables**:

| Variable Name             | Value                        | Purpose                       |
| ------------------------- | ---------------------------- | ----------------------------- |
| `NLP_PORT`              | `8864`                     | Listening port for FastAPI    |
| `HF_HOME`               | `/app/.cache/huggingface`  | Hugging Face model cache path |
| `INTERNAL_ACCESS_TOKEN` | *(cluster internal token)* | Inter-service auth token      |

### 5.4 Resource Allocation

| UI Field                 | Recommended Value            | Notes                                      |
| ------------------------ | ---------------------------- | ------------------------------------------ |
| **CPU Request**    | `500m` *(or `1000m`)*  | Baseline guaranteed CPU                    |
| **CPU Limit**      | `2000m` *(or `4000m`)* | Torch multi-threaded inference ceiling     |
| **Memory Request** | `1Gi` *(or `1024Mi`)*  | Baseline memory reservation                |
| **Memory Limit**   | `4Gi` *(or `4096Mi`)*  | Required headroom for PyTorch & embeddings |

### 5.5 Strategy & Policies

| UI Field                  | Value                   |
| ------------------------- | ----------------------- |
| **Update Strategy** | **RollingUpdate** |
| **Restart Policy**  | **Always**        |
| **Service Account** | `default`             |

### 5.6 Storage / Volume Mounts (Optional but Recommended)

To prevent models from re-downloading on every pod restart:

- **Enable PVC**: Checked
- **Mount Path**: `/app/.cache/huggingface`

---

## 6. Post-Deployment Verification

Once deployed via the UI:

1. Check pod status:
   ```bash
   kubectl get pods -l app=hope-nlp -n default
   ```
2. Verify logs:
   ```bash
   kubectl logs -f deployment/hope-nlp -n default
   ```
3. Test health check from within cluster or via port-forward:
   ```bash
   kubectl port-forward deployment/hope-nlp 8864:8864 -n default &
   curl -s http://localhost:8864/api/v1/health | jq .
   ```

---

## Troubleshooting Reference

| Issue                                            | Cause                                                              | Resolution                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `uv: not found`                                | Standard`python:3.11-slim` used instead of `hope-python-base`. | Use`--build-arg BASE_IMAGE="hope-python-base:latest"`.           |
| `no match for platform in manifest: not found` | Apple Silicon Mac defaults to`arm64`, base is `amd64`.         | Add`--platform linux/amd64` to build command.                    |
| `BUILD_GIT_BRANCH: parameter not set`          | Missing build identity args in`set -eu` block.                   | Pass`BUILD_GIT_BRANCH`, `BUILD_GIT_SHA`, and `BUILD_AT`.     |
| Container exits immediately after UI deploy      | Custom Command (`/bin/sh -c echo hello`) was entered.            | Clear**Command** and **Args** fields completely in UI. |
| Pod OOMKilled                                    | Memory limit is lower than Torch memory usage.                     | Increase Memory Limit to`4Gi` (4096Mi).                          |
