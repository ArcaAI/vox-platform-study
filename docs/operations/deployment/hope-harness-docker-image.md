till 

# Harness Service Docker Build & Deployment Runbook

## Overview

- **Service**: HOPE Clinical Documentation Harness (`hope-harness`)
- **Port**: `8866`
- **Target Platform**: `linux/amd64`
- **Target Stage**: `production` (FastAPI HTTP API)
- **Base Image**: `hope-python-base:latest`
- **Context Root**: Repository root (`.`)
- **Cluster Registry**: `192.168.112.13:5000`
- **Namespace**: `project-hope-vox`
- **Infra Namespace**: `project-hope-vox-infra`

---

## 1. Prerequisites: Base Image (`hope-python-base`)

The Harness Dockerfile requires `hope-python-base:latest`, which provides `uv`, core system packages, and the unprivileged `hope` runtime user.

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

## 2. Docker Image Build (`hope-harness`)

Build from the **repository root**. The Dockerfile enforces build identity metadata via `set -eu` to write `/app/build-info.json`. We target `--target production` for the HTTP service (the Temporal worker uses `--target worker`).

```bash
docker build \
  --platform linux/amd64 \
  --target production \
  -f apps/harness/Dockerfile \
  -t hope-harness:latest \
  -t 192.168.112.13:5000/hope-harness:latest \
  -t 192.168.112.13:5000/harness:latest \
  --build-arg BASE_IMAGE=hope-python-base:latest \
  --build-arg BUILD_SERVICE=harness \
  --build-arg BUILD_VERSION=0.1.0 \
  --build-arg BUILD_GIT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main") \
  --build-arg BUILD_GIT_SHA=$(git rev-parse HEAD 2>/dev/null || echo "local") \
  --build-arg BUILD_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ) \
  .
```

---

## 3. Push to Cluster Registry

Push the tagged images to the local Kubernetes cluster registry:

```bash
docker push 192.168.112.13:5000/hope-harness:latest
docker push 192.168.112.13:5000/harness:latest
```

Verify catalog availability:

```bash
curl -s http://192.168.112.13:5000/v2/_catalog | jq .
```

---

## 4. Kubernetes Workload Configuration (Cluster UI)

When creating or editing the `hope-harness` deployment in the Kubernetes Management UI, configure the following:

### 4.1 General Settings

| UI Field                 | Value                                       | Notes                                |
| ------------------------ | ------------------------------------------- | ------------------------------------ |
| **Workload Type**  | **Deployment**                        | Stateless service                    |
| **Workload Name**  | `hope-harness`                            |                                      |
| **Namespace**      | `project-hope-vox`                        | Main applications namespace          |
| **Image**          | `192.168.112.13:5000/hope-harness:latest` |                                      |
| **Replicas**       | `1`                                       |                                      |
| **Container Port** | `8866`                                    | Listening port for FastAPI / Uvicorn |

### 4.2 Command & Arguments (CRITICAL)

| UI Field          | Value                 | Reason                                                                                          |
| ----------------- | --------------------- | ----------------------------------------------------------------------------------------------- |
| **Command** | **LEAVE EMPTY** | ⚠️ The image has`ENTRYPOINT ["python", "-m", "uvicorn", "harness.main:app", ...]` baked in. |
| **Args**    | **LEAVE EMPTY** | ⚠️ Overriding command/args breaks Uvicorn startup.                                            |

---

## 5. Environment Variables & Secrets Reference

Configure these environment variables in the container deployment:

### 5.1 Required Cluster Topology & Auth Variables

| Variable Name                  | Production Cluster Value                                                                  | Notes / Description                                                                      |
| ------------------------------ | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `HARNESS_PORT`               | `8866`                                                                                  | Container listening port                                                                 |
| `HARNESS_ENVIRONMENT`        | `production`                                                                            | Deployment mode                                                                          |
| `TEMPORAL_ADDRESS`           | `temporal-svc.project-hope-vox-infra.svc.cluster.local:7233`                            | Temporal gRPC frontend service                                                           |
| `TEMPORAL_NAMESPACE`         | `default`                                                                               | Temporal namespace                                                                       |
| `INTERNAL_ACCESS_TOKEN`      | `J5ZP2P21KiM+sLNSsbdV5n0iR+ndY2Qer0vPzbYbTfo=`                                          | **Shared Service Token** (required for `POST /api/v1/internal/service-releases`) |
| `HARNESS_SERVICE_TOKEN`      | `J5ZP2P21KiM+sLNSsbdV5n0iR+ndY2Qer0vPzbYbTfo=`                                          | Harness inbound secret guard                                                             |
| `HARNESS_API_BASE_URL`       | `http://hope-api-gateway-svc:8866`                                                      | API Gateway internal service                                                             |
| `HARNESS_REDIS_URL`          | `redis://:<REDIS_PASS>@redis-store-svc.project-hope-vox-infra.svc.cluster.local:6379/0` | Cache invalidation Pub/Sub                                                               |
| `HARNESS_TEXT_BASE_URL`      | `http://hope-text-svc:8862`                                                             | Text generation service                                                                  |
| `HARNESS_NLP_BASE_URL`       | `http://hope-nlp-svc:8864`                                                              | Medical NLP service                                                                      |
| `HARNESS_GUARDRAIL_BASE_URL` | `http://hope-guardrail-svc:8863`                                                        | Guardrail service                                                                        |

### 5.2 Claim-Check (MinIO / S3 Storage) Settings

If MinIO / S3 is available for offloading large payloads:

| Variable Name                        | Value                                                                    | Description                            |
| ------------------------------------ | ------------------------------------------------------------------------ | -------------------------------------- |
| `HARNESS_CLAIM_CHECK_ENABLED`      | `true` (or `false` if bypassing)                                     | Enable out-of-band payload storage     |
| `HARNESS_CLAIM_CHECK_STORE`        | `s3`                                                                   | Must be`s3` in production            |
| `HARNESS_CLAIM_CHECK_ENDPOINT_URL` | `http://minio-store-svc.project-hope-vox-infra.svc.cluster.local:9000` | MinIO / S3 endpoint                    |
| `HARNESS_CLAIM_CHECK_BUCKET`       | `harness-claim-check`                                                  | Bucket name (must exist in S3)         |
| `HARNESS_CLAIM_CHECK_ACCESS_KEY`   | `<storage-access-key>`                                                 | Storage Access Key                     |
| `HARNESS_CLAIM_CHECK_SECRET_KEY`   | `<storage-secret-key>`                                                 | Storage Secret Key                     |
| `HARNESS_CLAIM_CHECK_REGION`       | `us-east-1`                                                            | Default S3 region                      |
| `HARNESS_CLAIM_CHECK_SECURE`       | `false`                                                                | `false` for HTTP, `true` for HTTPS |
| `MINIO_CERT_CHECK`                 | `false`                                                                | Skips self-signed TLS cert validation  |

> **Note**: If S3 credentials or bucket are not yet provisioned, set `HARNESS_CLAIM_CHECK_ENABLED=false` to avoid startup validation failure.

---

## 6. How Secrets Were Retrieved

### 6.1 Querying `INTERNAL_ACCESS_TOKEN` from HashiCorp Vault

The cluster stores shared secrets in Vault under the `secret/hope/` KV v2 path. To inspect or retrieve it from `master-node-1`:

```bash
kubectl exec -it vault-store-7877b7d766-tfb5x -n project-hope-vox-infra -- sh -c \
  'export VAULT_ADDR="http://127.0.0.1:8200"; vault kv get secret/hope/INTERNAL_ACCESS_TOKEN'
```

**Output:**

```
==== Data ====
Key      Value
---      -----
value    J5ZP2P21KiM+sLNSsbdV5n0iR+ndY2Qer0vPzbYbTfo=
```

### 6.2 Discovering Cluster Service DNS

To find the exact internal DNS names across namespaces:

```bash
# Temporal service:
kubectl get svc -A | grep -iE "temporal|workflow"
# Output: project-hope-vox-infra  temporal-svc  ClusterIP  10.101.61.163  <none>  7233/TCP
# Resolved DNS: temporal-svc.project-hope-vox-infra.svc.cluster.local:7233

# Redis service:
kubectl get svc -A | grep -i redis
# Resolved DNS: redis-store-svc.project-hope-vox-infra.svc.cluster.local:6379

# Gateway service:
kubectl get svc -A | grep -i gateway
# Resolved DNS: hope-api-gateway-svc.project-hope-vox.svc.cluster.local:8866
```

---

## 7. Verification & Health Probes

Test the service from your local workstation or the master node:

```bash
# General health check (informational, process liveness):
curl -i http://192.168.112.6:<NODEPORT>/api/v1/health

# Kubernetes Liveness probe:
curl -i http://192.168.112.6:<NODEPORT>/api/v1/health/live

# Kubernetes Readiness probe (verifies Temporal connection):
curl -i http://192.168.112.6:<NODEPORT>/api/v1/health/ready
```

**Expected `/health/ready` Response (`200 OK`):**

```json
{
  "status": "healthy",
  "checks": {
    "temporal": {
      "status": "healthy",
      "address": "temporal-svc.project-hope-vox-infra.svc.cluster.local:7233"
    }
  }
}
```

---

## 8. Harness Worker (`hope-harness-worker`) Deployment

The Temporal worker is built from the same Dockerfile using `--target worker`. Unlike the HTTP service, the worker has **no incoming HTTP port** and runs as a pure background consumer polling Temporal.

### 8.1 Build & Push

```bash
docker build \
  --platform linux/amd64 \
  --target worker \
  -f apps/harness/Dockerfile \
  -t hope-harness-worker:latest \
  -t 192.168.112.13:5000/hope-harness-worker:latest \
  -t 192.168.112.13:5000/harness-worker:latest \
  --build-arg BASE_IMAGE=hope-python-base:latest \
  --build-arg BUILD_SERVICE=harness-worker \
  --build-arg BUILD_VERSION=0.1.0 \
  --build-arg BUILD_GIT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main") \
  --build-arg BUILD_GIT_SHA=$(git rev-parse HEAD 2>/dev/null || echo "local") \
  --build-arg BUILD_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ) \
  .

docker push 192.168.112.13:5000/hope-harness-worker:latest
docker push 192.168.112.13:5000/harness-worker:latest
```

### 8.2 Kubernetes Workload Deployment (UI)

- **Name**: `hope-harness-worker`
- **Namespace**: `project-hope-vox`
- **Image**: `192.168.112.13:5000/hope-harness-worker:latest`
- **Command & Args**: **LEAVE EMPTY** (baked entrypoint: `python -m harness.temporal.worker`)
- **Container Port / Service**: None required (outbound polling only).
- **Probes**: **Disable HTTP Liveness & Readiness Probes** (the worker does not listen on HTTP).

### 8.3 Temporal Namespace Creation

If the `default` namespace is not registered in Temporal, run this on `master-node-1`:

```bash
kubectl exec -it temporal-578746569f-pz5t7 -n project-hope-vox-infra -- \
  temporal operator namespace create --address temporal-svc.project-hope-vox-infra.svc.cluster.local:7233 default
```

### 8.4 Verifying the Worker Pollers

Query Temporal API to confirm the worker is actively polling `harness-task-queue`:

```bash
curl -s "http://192.168.112.6:31888/api/v1/namespaces/default/task-queues/harness-task-queue?taskQueueType=1" | jq .
```

Expected output:

```json
{
  "pollers": [
    {
      "identity": "1@hope-harness-worker-69f87fc49f-d9wqf",
      "ratePerSecond": 100000
    }
  ]
}
```

---

## 9. Troubleshooting Reference

| Symptom / Log                                                                               | Root Cause                                                           | Resolution                                                                                                              |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `503 Service Unavailable` on `/health/readytonic::transport::ConnectError("dns error")` | `TEMPORAL_ADDRESS` defaulted to `temporal:7233` or wrong DNS.    | Set`TEMPORAL_ADDRESS=temporal-svc.project-hope-vox-infra.svc.cluster.local:7233`.                                     |
| `POST .../internal/service-releases "HTTP/1.1 401 Unauthorized"`                          | Missing`INTERNAL_ACCESS_TOKEN` in container env.                   | Set`INTERNAL_ACCESS_TOKEN=J5ZP2P21KiM+sLNSsbdV5n0iR+ndY2Qer0vPzbYbTfo=`.                                              |
| `Namespace default is not found`                                                          | Temporal`default` namespace was not registered.                    | Run`temporal operator namespace create --address temporal-svc.project-hope-vox-infra.svc.cluster.local:7233 default`. |
| Worker pollers query returns`{}`                                                          | Worker pod was started before`default` namespace existed.          | Run`kubectl rollout restart deployment/hope-harness-worker -n project-hope-vox`.                                      |
| `ValueError: claim-check offload is enabled with the in-memory store in 'production'`     | `HARNESS_ENVIRONMENT=production` rejects `store="memory"`.       | Either set`HARNESS_CLAIM_CHECK_STORE=s3` with MinIO config, or set `HARNESS_CLAIM_CHECK_ENABLED=false`.             |
| `vault: command not found` on `master-node-1`                                           | `vault` CLI is installed inside the Vault container, not the host. | Run commands inside the pod via`kubectl exec -it <vault-pod> -n project-hope-vox-infra -- sh`.                        |
| Container exits immediately with code 0 or error                                            | UI deployment had custom command or args filled in.                  | Clear**Command** and **Args** fields completely in the UI.                                                  |
