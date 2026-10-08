# Text Generation & Summarization Service — Kubernetes Deployment Plan

**Service:** `apps/text` (`text`)  
**Port:** `8862`  
**Target Environment:** Linux Kubernetes Cluster (v1.28+)  
**Document Revision:** 1.0 (dev-2.2)  
**Status:** Approved for Implementation  

---

## 1. Executive Summary & Architecture Context

The **Text Service** (`apps/text`) is the HOPE platform's multi-provider LLM generation and clinical summarization engine. It orchestrates clinical SOAP note generation, Server-Sent Events (SSE) token streaming, automated clinical judging, and HuggingFace TEI vector embeddings.

### Core Architectural Guarantees & Constraints
- **Stateless Orchestration:** The service holds no persistent business state and zero direct SQL database access. All tenant BYOK credentials, model IDs, and routing policies are injected per-request by the API Gateway ([`apps/api`](../../apps/api)).
- **In-Process Worker & Task Management:** There is no separate Celery/RabbitMQ worker daemon for summarization. In-flight token streaming and task queueing run in-process through Redis Streams (DB 3).
- **Graceful Stream Drain:** The service implements `GenerationHub`, where socket disconnects do not terminate generation; active streams are buffered into Redis Streams with a 45-second graceful shutdown drain window.
- **Fail-Closed Safety Posture:** Calls are moderated through the Guardrail service (`:8863`). If Guardrail is unreachable after bounded retries, requests fail with a typed 503 rather than leaking raw, unmoderated clinical summaries.

```
                    ┌────────────────────────────────────────────────────────┐
                    │                   Kubernetes Cluster                   │
                    │                                                        │
┌──────────────┐    │   ┌──────────────────┐        ┌──────────────────┐     │
│   Web / SDK  ├───┼──►│   API Gateway    ├───────►│   Text Service   │     │
│   Clients    │    │   │ (apps/api :8868) │ HTTP   │ (apps/text :8862)│     │
└──────────────┘    │   └──────────────────┘        └────────┬─────────┘     │
                    │                                        │               │
                    │             ┌──────────────────────────┼───────────────┤
                    │             │                          │               │
                    │             ▼                          ▼               │
                    │     ┌──────────────┐           ┌──────────────┐        │
                    │     │   Redis 8    │           │  Guardrail   │        │
                    │     │  (Stream/DB3)│           │Service :8863 │        │
                    │     └──────────────┘           └──────────────┘        │
                    │                                        │               │
                    └────────────────────────────────────────┼───────────────┘
                                                             │
                              ┌──────────────────────────────┴───────────────┐
                              ▼                                              ▼
                    ┌──────────────────┐                           ┌──────────────────┐
                    │ In-Cluster vLLM  │ (or External Host)       │ Cloud LLMs (BYOK)│
                    │ (GPU Node :8000) │                           │  Azure / Bedrock │
                    └──────────────────┘                           └──────────────────┘
```

---

## 2. Infrastructure Prerequisites

| Component | Minimum Specification | Recommended Production | Notes |
|---|---|---|---|
| **K8s Nodes** | 2 Nodes, 4 vCPU, 8 GB RAM | 3+ Nodes, 8 vCPU, 16 GB RAM | Linux AMD64 or ARM64 |
| **Redis** | Redis 7.2+ or 8.0 Alpine | Redis Cluster or Sentinel (DB 0-3) | Used for task state and SSE streaming ring buffers |
| **GPU (Optional)** | 1x NVIDIA T4 / A10G (16GB VRAM) | 1x NVIDIA A100 / L40S (24GB+ VRAM) | Only required if hosting vLLM/Ollama in-cluster |
| **Network CNI** | Calico / Cilium / Flannel | Any standard CNI | Must permit Pod-to-Pod HTTP/1.1 & HTTP/2 |
| **Ingress** | N/A (Internal Service) | N/A | Must **not** be exposed to public ingress |

---

## 3. Phase 1: Container Image Build & Distribution

Because the repository uses a unified `uv` workspace lock file (`/uv.lock`), images must be built from the monorepo root context using the two-stage pipeline.

### 3.1 Build Shared Base Image
```bash
# Set your target container registry
export REGISTRY="harbor.internal.net/hope"
export VERSION="2.0.0"

# Step 1: Build the shared Python runtime base
docker build \
  -t hope-python-base:latest \
  infrastructure/docker/python-base/
```

### 3.2 Build & Push Text Service
```bash
# Step 2: Build the production target for apps/text
docker build \
  -f apps/text/Dockerfile \
  --target production \
  -t ${REGISTRY}/text:${VERSION} \
  -t ${REGISTRY}/text:latest \
  .

# Step 3: Authenticate and push to your Linux cluster's registry
docker push ${REGISTRY}/text:${VERSION}
docker push ${REGISTRY}/text:latest
```

---

## 4. Phase 2: Complete Kubernetes Manifests

Create a dedicated directory or single release manifest `text-service-k8s.yaml`:

```yaml
---
apiVersion: v1
kind: Namespace
metadata:
  name: hope
  labels:
    name: hope
    app.kubernetes.io/part-of: hope-platform

---
# ------------------------------------------------------------------------------
# 1. Secret Configuration (Shared Service Tokens & Keys)
# ------------------------------------------------------------------------------
apiVersion: v1
kind: Secret
metadata:
  name: text-secrets
  namespace: hope
type: Opaque
stringData:
  # Shared constant-time access token authenticated by ServiceAuthMiddleware
  INTERNAL_ACCESS_TOKEN: "replace-with-cryptographically-random-token-minimum-32-chars"

---
# ------------------------------------------------------------------------------
# 2. ConfigMap (Environment & Feature Settings)
# ------------------------------------------------------------------------------
apiVersion: v1
kind: ConfigMap
metadata:
  name: text-config
  namespace: hope
data:
  TEXT_HOST: "0.0.0.0"
  TEXT_PORT: "8862"
  TEXT_LOG_LEVEL: "info"
  NODE_ENV: "production"
  # Enforce PHI safe logging: payload contents are never sent to OpenTelemetry
  OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: "NO_CONTENT"
  # Redis connection string for TaskManager & SSE streams
  TEXT_REDIS_URL: "redis://hope-redis:6379/0"
  # Gateway registration endpoint
  TEXT_GATEWAY_URL: "http://hope-api-service:8868/api/v1"
  # External Guardrail service endpoint
  TEXT_EXTERNAL_GUARDRAIL_BASE_URL: "http://hope-guardrail-service:8863"
  # OpenTelemetry collector endpoint (leave blank if disabled)
  TEXT_OTEL_EXPORTER_ENDPOINT: ""

---
# ------------------------------------------------------------------------------
# 3. Redis Task Cache & Stream Buffer (Standalone Deployment)
# (Skip if using an existing managed Redis instance or Bitnami Redis chart)
# ------------------------------------------------------------------------------
apiVersion: apps/v1
kind: Deployment
metadata:
  name: hope-redis
  namespace: hope
  labels:
    app: hope-redis
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app: hope-redis
  template:
    metadata:
      labels:
        app: hope-redis
    spec:
      containers:
        - name: redis
          image: redis:8-alpine
          command:
            - redis-server
            - "--appendonly"
            - "yes"
            - "--maxmemory"
            - "1024mb"
            - "--maxmemory-policy"
            - "volatile-lru"
          ports:
            - containerPort: 6379
              name: redis
          resources:
            requests:
              cpu: "200m"
              memory: "256Mi"
            limits:
              cpu: "1000m"
              memory: "1536Mi"
          readinessProbe:
            exec:
              command: ["redis-cli", "ping"]
            initialDelaySeconds: 5
            periodSeconds: 5
          volumeMounts:
            - name: redis-data
              mountPath: /data
      volumes:
        - name: redis-data
          emptyDir: {}
---
apiVersion: v1
kind: Service
metadata:
  name: hope-redis
  namespace: hope
spec:
  ports:
    - port: 6379
      targetPort: 6379
      name: redis
  selector:
    app: hope-redis

---
# ------------------------------------------------------------------------------
# 4. Text Generation Service Deployment
# ------------------------------------------------------------------------------
apiVersion: apps/v1
kind: Deployment
metadata:
  name: hope-text
  namespace: hope
  labels:
    app: hope-text
    service: text
    app.kubernetes.io/name: hope-text
spec:
  replicas: 2
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  selector:
    matchLabels:
      app: hope-text
  template:
    metadata:
      labels:
        app: hope-text
        service: text
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "8862"
        prometheus.io/path: "/metrics"
    spec:
      # CRITICAL: Allows GenerationHub to flush pending SSE tokens and drain in-flight jobs
      terminationGracePeriodSeconds: 45
      containers:
        - name: text
          image: harbor.internal.net/hope/text:2.0.0
          imagePullPolicy: IfNotPresent
          ports:
            - name: http
              containerPort: 8862
              protocol: TCP
          envFrom:
            - configMapRef:
                name: text-config
            - secretRef:
                name: text-secrets
          resources:
            requests:
              cpu: "1000m"
              memory: "1Gi"
            limits:
              cpu: "4000m"
              memory: "4Gi"
          # Startup Probe: Wait for lifespan initialization to register provider factories
          startupProbe:
            httpGet:
              path: /api/v1/health/startup
              port: 8862
            initialDelaySeconds: 5
            periodSeconds: 3
            timeoutSeconds: 2
            failureThreshold: 15
          # Liveness Probe: Process responsiveness check
          livenessProbe:
            httpGet:
              path: /api/v1/health/live
              port: 8862
            initialDelaySeconds: 10
            periodSeconds: 10
            timeoutSeconds: 3
            failureThreshold: 3
          # Readiness Probe: Requires Redis connected + at least one operational provider
          readinessProbe:
            httpGet:
              path: /api/v1/health/ready
              port: 8862
            initialDelaySeconds: 5
            periodSeconds: 10
            timeoutSeconds: 5
            failureThreshold: 3

---
# ------------------------------------------------------------------------------
# 5. Internal ClusterIP Service
# ------------------------------------------------------------------------------
apiVersion: v1
kind: Service
metadata:
  name: hope-text-service
  namespace: hope
  labels:
    app: hope-text
spec:
  type: ClusterIP
  ports:
    - port: 8862
      targetPort: 8862
      name: http
      protocol: TCP
  selector:
    app: hope-text
```

---

## 5. Phase 3: LLM Inference Backend Topology Options

The Text service is an orchestration pipeline that connects to external or in-cluster inference engines. Choose the model backend that matches your infrastructure:

### Topology A: In-Cluster GPU Deployment with vLLM (Recommended for On-Prem Linux K8s)

If your Linux cluster has GPU nodes with NVIDIA drivers and the NVIDIA GPU Operator installed:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: vllm-engine
  namespace: hope
spec:
  replicas: 1
  selector:
    matchLabels:
      app: vllm-engine
  template:
    metadata:
      labels:
        app: vllm-engine
    spec:
      containers:
        - name: vllm
          image: vllm/vllm-openai:v0.6.3
          args:
            - "--model"
            - "meta-llama/Meta-Llama-3.1-8B-Instruct"
            - "--port"
            - "8000"
            - "--gpu-memory-utilization"
            - "0.90"
            - "--max-model-len"
            - "8192"
          env:
            - name: HUGGING_FACE_HUB_TOKEN
              valueFrom:
                secretKeyRef:
                  name: hf-secrets
                  key: HF_TOKEN
                  optional: true
          resources:
            limits:
              nvidia.com/gpu: 1
              memory: 24Gi
              cpu: "8"
            requests:
              nvidia.com/gpu: 1
              memory: 16Gi
              cpu: "4"
          ports:
            - containerPort: 8000
              name: http
          readinessProbe:
            httpGet:
              path: /health
              port: 8000
            initialDelaySeconds: 60
            periodSeconds: 10
---
apiVersion: v1
kind: Service
metadata:
  name: vllm-service
  namespace: hope
spec:
  ports:
    - port: 8000
      targetPort: 8000
      name: http
  selector:
    app: vllm-engine
```
*DNS inside the cluster: `http://vllm-service.hope.svc.cluster.local:8000/v1`.*

---

### Topology B: External Host or Bare-Metal Linux GPU Server

If your LLM engine (Ollama, LM Studio, or vLLM) runs on a physical bare-metal host outside Kubernetes (e.g. at IP `192.168.1.150` on port `11434` or `1234`):

```yaml
apiVersion: v1
kind: Service
metadata:
  name: external-llm-host
  namespace: hope
spec:
  type: ExternalName
  externalName: 192.168.1.150
---
# Or via static Endpoints:
apiVersion: v1
kind: Endpoints
metadata:
  name: external-llm-engine
  namespace: hope
subsets:
  - addresses:
      - ip: 192.168.1.150
    ports:
      - port: 1234
        name: http
---
apiVersion: v1
kind: Service
metadata:
  name: external-llm-engine
  namespace: hope
spec:
  ports:
    - port: 1234
      targetPort: 1234
```
*`hope-text` can connect directly to `http://external-llm-engine:1234/v1`.*

---

### Topology C: Managed Cloud LLM APIs (Azure OpenAI / AWS Bedrock / Vertex)

No GPU nodes or local servers required. The image includes native cloud SDK adapters. The API Gateway injects the tenant credentials at runtime in the `provider_overrides` payload. Ensure pods have egress internet access on port `443` to reach endpoints (e.g., `openai.azure.com`, `bedrock-runtime.amazonaws.com`).

---

## 6. Phase 4: Step-by-Step Deployment Runbook

### 6.1 Apply Manifests
```bash
# 1. Apply all resources in namespace hope
kubectl apply -f text-service-k8s.yaml

# 2. Monitor rollout status
kubectl rollout status deployment/hope-text -n hope --timeout=120s
```

### 6.2 Verify Pods and Services
```bash
kubectl get pods,svc,endpoints -n hope -l app=hope-text
```
Expected output:
```text
NAME                             READY   STATUS    RESTARTS   AGE
pod/hope-text-7848c484f-7q2b5    1/1     Running   0          45s
pod/hope-text-7848c484f-w9s12    1/1     Running   0          45s

NAME                        TYPE        CLUSTER-IP      EXTERNAL-IP   PORT(S)    AGE
service/hope-text-service   ClusterIP   10.96.142.81    <none>        8862/TCP   45s
```

---

## 7. Phase 5: Verification & End-to-End Testing

### 7.1 Port-Forward to Test Workstation
```bash
kubectl port-forward svc/hope-text-service -n hope 8862:8862
```

### 7.2 Run Component Health Check
```bash
curl -s http://localhost:8862/api/v1/health | jq .
```
Verify that `"redis"` reports `"status": "healthy"`.

### 7.3 Test Synchronous SOAP Clinical Note Generation
```bash
curl -X POST http://localhost:8862/api/v1/generate \
  -H "Content-Type: application/json" \
  -H "X-Service-Token: replace-with-cryptographically-random-token-minimum-32-chars" \
  -H "X-Tenant-Id: k8s-verification-tenant" \
  -d '{
    "prompt": "Doctor: Patient reports dry cough and 101F fever for 3 days. Denies shortness of breath.",
    "system_prompt": "You are a clinical scribe. Generate a brief SOAP note.",
    "provider": "lm-studio",
    "model": "meta-llama-3.1-8b-instruct",
    "temperature": 0.1,
    "max_tokens": 400,
    "guardrail_policy": {
      "enabled": false
    }
  }' | jq .
```

### 7.4 Test Live Server-Sent Events (SSE) Token Streaming
```bash
curl -N -X POST http://localhost:8862/api/v1/generate \
  -H "Content-Type: application/json" \
  -H "X-Service-Token: replace-with-cryptographically-random-token-minimum-32-chars" \
  -H "X-Tenant-Id: k8s-verification-tenant" \
  -d '{
    "prompt": "Explain asthma pathophysiology in 2 sentences.",
    "provider": "lm-studio",
    "model": "meta-llama-3.1-8b-instruct",
    "stream": true,
    "guardrail_policy": {
      "enabled": false
    }
  }'
```

---

## 8. Phase 6: Monitoring, Alerting & Day-2 Operations

### 8.1 Prometheus Metrics Scrape Target
`apps/text` provides native Prometheus metrics on `/metrics`. If using Prometheus Operator, deploy a `ServiceMonitor`:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: hope-text-monitor
  namespace: hope
  labels:
    release: prometheus
spec:
  selector:
    matchLabels:
      app: hope-text
  endpoints:
    - port: http
      path: /metrics
      interval: 15s
```

### 8.2 Key Production Alerting Thresholds

| Metric | Condition | Severity | Meaning & Action |
|---|---|---|---|
| `text_circuit_breaker_state == 1` | `> 0` for 1m | **Critical** | Circuit breaker is OPEN. Target LLM provider is down or failing requests. |
| `text_generation_errors_total` | Rate `> 5%` over 5m | **Warning** | Elevated failure rate. Check downstream provider timeouts or rate limits. |
| `text_queue_size` | `> 50` for 2m | **Warning** | Request queue saturation. Increase pod replicas or provider concurrency ceiling. |
| `text_replay_deltas_total` | Stalled | **Warning** | Redis stream buffer write failures. Check Redis capacity. |

### 8.3 Common Troubleshooting Runbook

1. **Readiness Probe Fails (HTTP 503):**
   - Check Redis connectivity: `kubectl exec -it deployment/hope-text -n hope -- redis-cli -u redis://hope-redis:6379 ping`.
   - Inspect provider health: `curl http://localhost:8862/api/v1/health | jq .checks`. If all providers report `unhealthy`, the readiness probe intentionally fails to prevent traffic routing.
2. **Output Rejected (HTTP 422 or 503):**
   - If Guardrail service `:8863` is offline and `"guardrail_policy": {"enabled": true}`, the service fail-closes. Check `kubectl logs deployment/hope-guardrail -n hope`.
3. **Rolling Updates Dropping Tokens:**
   - Ensure `terminationGracePeriodSeconds` is set to **at least 45s**. Lowering this causes Kubernetes to prematurely SIGKILL pods before `GenerationHub.drain()` can complete active token generation.
