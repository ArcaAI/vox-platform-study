# TTS (Text-to-Speech) Service Docker Build & Deployment Runbook

## Overview

- **Service**: HOPE Text-to-Speech Service (`hope-tts`)
- **Port**: `8865`
- **Target Platform**: `linux/amd64`
- **Target Stage**: `production`
- **Base Image**: `hope-python-base:latest`
- **Context Root**: Repository root (`.`)
- **Cluster Registry**: `192.168.112.13:5000`
- **Namespace**: `project-hope-vox`
- **Infra Namespace**: `project-hope-vox-infra`

---

## 1. Prerequisites: Base Image (`hope-python-base`)

The TTS Dockerfile inherits from `hope-python-base:latest`, which supplies `uv`, core system packages, and the unprivileged `hope` runtime user.

If not already built locally:

```bash
docker build --platform linux/amd64 \
  -t hope-python-base:latest \
  infrastructure/docker/python-base/
```

Verify presence:
```bash
docker images | grep hope-python-base
```

---

## 2. Docker Image Build (`hope-tts`)

Build from the **repository root**. The Dockerfile bakes build identity metadata into `/app/build-info.json` and installs the default Kokoro CPU engine:

```bash
docker build \
  --platform linux/amd64 \
  --target production \
  -f apps/tts/Dockerfile \
  -t hope-tts:latest \
  -t 192.168.112.13:5000/hope-tts:latest \
  -t 192.168.112.13:5000/tts:latest \
  --build-arg BASE_IMAGE=hope-python-base:latest \
  --build-arg BUILD_SERVICE=tts \
  --build-arg BUILD_VERSION=0.1.0 \
  --build-arg BUILD_GIT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main") \
  --build-arg BUILD_GIT_SHA=$(git rev-parse HEAD 2>/dev/null || echo "local") \
  --build-arg BUILD_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ) \
  .
```

---

## 3. Push to Cluster Registry

Push the tagged images to the local cluster registry:

```bash
docker push 192.168.112.13:5000/hope-tts:latest
docker push 192.168.112.13:5000/tts:latest
```

Verify in the registry catalog:
```bash
curl -s http://192.168.112.13:5000/v2/_catalog | jq .
```

---

## 4. Kubernetes Workload Configuration (Cluster UI)

When creating the `hope-tts` workload in the cluster web dashboard, enter the following:

### 4.1 General Settings

| UI Field | Value | Notes |
|---|---|---|
| **Workload Type** | **Deployment** | Stateless service |
| **Workload Name** | `hope-tts` | Container and deployment name |
| **Namespace** | `project-hope-vox` | Applications namespace |
| **Image** | `192.168.112.13:5000/hope-tts:latest` | |
| **Replicas** | `1` | |
| **Container Port** | `8865` | Service listening port |

### 4.2 Command & Arguments (CRITICAL)

| UI Field | Value | Reason |
|---|---|---|
| **Command** | **LEAVE EMPTY** | ⚠️ The image has `ENTRYPOINT ["python", "-m", "uvicorn", "tts.main:app", ...]` baked in. |
| **Args** | **LEAVE EMPTY** | ⚠️ Overriding command/args breaks Uvicorn startup. |

### 4.3 Health Probes

| Probe Type | Path | Port | Initial Delay | Timeout |
|---|---|---|---|---|
| **Liveness Probe** | `/api/v1/health/live` | `8865` | 30s | 5s |
| **Readiness Probe** | `/api/v1/health/ready` | `8865` | 10s | 5s |

### 4.4 Volume / Storage Mount (Optional but Recommended)

Kokoro downloads weights (`hexgrad/Kokoro-82M`, ~327 MB) on first synthesis. To persist these across pod restarts:
- **Mount Path**: `/app/.cache/huggingface`
- **Volume Type**: PVC or hostPath

---

## 5. Environment Variables & Secrets Reference

Configure these environment variables in the `hope-tts` container:

| Variable Name | Production Cluster Value | Description |
|---|---|---|
| `TTS_PORT` | `8865` | Listening port for FastAPI |
| `INTERNAL_ACCESS_TOKEN` | `J5ZP2P21KiM+sLNSsbdV5n0iR+ndY2Qer0vPzbYbTfo=` | **Shared Service Token** (inter-service authentication) |
| `TTS_GATEWAY_URL` | `http://hope-api-gateway-svc:8866/api/v1` | API Gateway internal endpoint |
| `TTS_REDIS_URL` | `redis://redis-store-svc.project-hope-vox-infra.svc.cluster.local:6379/0` | Cache invalidation Pub/Sub |
| `HF_HOME` | `/app/.cache/huggingface` | Hugging Face model cache directory |

---

## 6. Service Exposure & Networking

Create a Kubernetes Service to expose `hope-tts`:
* **Service Name**: `hope-tts-svc`
* **Namespace**: `project-hope-vox`
* **Type**: `ClusterIP` (or `NodePort` for external testing)
* **Port / TargetPort**: `8865` / `8865`

### Internal DNS Resolution:
* **Short DNS**: `http://hope-tts-svc:8865`
* **Full FQDN**: `http://hope-tts-svc.project-hope-vox.svc.cluster.local:8865`

---

## 7. Update API Gateway (`hope-api-gateway`)

To resolve the periodic `connect ECONNREFUSED ::1:8865; servedBy: tts` warning in the gateway, update the gateway's environment variables:

```env
TTS_URL=http://hope-tts-svc:8865
```

### Complete Gateway Service URLs Reference (`project-hope-vox`):

```env
TEXT_URL=http://hope-text-svc:8862
NLP_URL=http://hope-nlp-svc:8864
TTS_URL=http://hope-tts-svc:8865
HARNESS_URL=http://hope-harness-svc:8866
GUARDRAIL_URL=http://hope-guardrail-svc:8863
```

*(Or using full FQDN syntax if desired):*
```env
TEXT_URL=http://hope-text-svc.project-hope-vox.svc.cluster.local:8862
NLP_URL=http://hope-nlp-svc.project-hope-vox.svc.cluster.local:8864
TTS_URL=http://hope-tts-svc.project-hope-vox.svc.cluster.local:8865
HARNESS_URL=http://hope-harness-svc.project-hope-vox.svc.cluster.local:8866
GUARDRAIL_URL=http://hope-guardrail-svc.project-hope-vox.svc.cluster.local:8863
```

---

## 8. Verification & Health Probes

Test from your workstation or node:

```bash
# General health check (informational)
curl -i http://<node-ip>:<nodeport>/api/v1/health

# Liveness probe (process is alive)
curl -i http://<node-ip>:<nodeport>/api/v1/health/live

# Readiness probe (ready to synthesize)
curl -i http://<node-ip>:<nodeport>/api/v1/health/ready
```

**Expected `/health/ready` Response (`200 OK`):**
```json
{
  "status": "healthy",
  "checks": {
    "engine": {
      "status": "healthy"
    }
  }
}
```

---

## 9. Troubleshooting Reference

| Symptom / Log | Root Cause | Resolution |
|---|---|---|
| `connect ECONNREFUSED ::1:8865` in gateway | Gateway `TTS_URL` points to localhost instead of Kubernetes service. | Set `TTS_URL=http://hope-tts-svc:8865` in `hope-api-gateway`. |
| `HTTP 401 Unauthorized` on gateway calls | Missing or mismatched `INTERNAL_ACCESS_TOKEN`. | Set `INTERNAL_ACCESS_TOKEN=J5ZP2P21KiM+sLNSsbdV5n0iR+ndY2Qer0vPzbYbTfo=`. |
| `Permission denied: '/home/hope/.cache'` | Default `$HOME` was used instead of `/app/.cache`. | Set `HF_HOME=/app/.cache/huggingface`. |
| Container exits immediately upon deploy | UI deployment had custom command or args filled in. | Clear **Command** and **Args** fields completely in the UI. |
