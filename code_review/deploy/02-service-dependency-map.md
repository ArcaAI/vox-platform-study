# 02 — Service Dependency Map & Deployment Order

This document maps which services depend on which, and gives the correct order
to bring them up so each service starts successfully.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────┐
│                    External World                            │
└──────────────────────┬───────────────────────────────────────┘
                       │ (REST / WebSocket)
              ┌────────▼────────┐
              │   hope-api      │  ← API Gateway (the only public entry point)
              │   port 8868     │
              └──┬──┬──┬──┬──┬─┘
                 │  │  │  │  │   (internal HTTP calls)
    ┌────────────┘  │  │  │  └────────────┐
    │               │  │  │               │
    ▼               ▼  ▼  ▼               ▼
hope-stt-v2   hope-smr  hope-nlp  hope-guardrail  hope-harness
 (8861)        (8862)    (8864)     (8863)          (8866)
    │                                               │
    ▼                                               ▼
hope-stt-v2-worker                        hope-harness-worker
(background jobs)                         (Temporal worker)

hope-tts (8865)  ←─ called by hope-api for text-to-speech

┌──────────────────────────────────┐
│       Backing Infrastructure     │
│  PostgreSQL  Redis  MinIO        │
│  Qdrant      Vault  Temporal     │
│  LM Studio (out-of-cluster)      │
└──────────────────────────────────┘
```

---

## Dependency Table

| Service | Depends On (must be healthy first) | Optional deps |
|---------|-----------------------------------|---------------|
| **PostgreSQL** | nothing | — |
| **Redis** | nothing | — |
| **MinIO** | nothing | — |
| **Vault** | nothing (stores state on disk) | — |
| **Qdrant** | nothing | MinIO (for S3 snapshots — leave unset to skip) |
| **Temporal** | PostgreSQL | — |
| **LM Studio** | nothing (runs outside cluster on host machine) | — |
| **hope-db-migrate** | PostgreSQL, MinIO (for buckets) | — |
| **hope-qdrant-init** | Qdrant | — |
| **hope-vault** (in-cluster) | nothing (PVC for storage) | — |
| **hope-vault-init** | hope-vault (must be unsealed) | — |
| **hope-stt-v2** | PostgreSQL, MinIO, Redis, Qdrant | GPU (NVIDIA) |
| **hope-stt-v2-worker** | PostgreSQL, MinIO, Redis, hope-stt-v2 | GPU (NVIDIA) |
| **hope-smr** | Redis, LM Studio | Azure OpenAI (fallback) |
| **hope-guardrail** | LM Studio | — |
| **hope-nlp** | nothing at startup (loads models on first request) | — |
| **hope-tts** | nothing (Azure Speech or local Kokoro) | Azure Speech key |
| **hope-harness** | PostgreSQL, Redis, Temporal, Qdrant, hope-api | — |
| **hope-harness-worker** | Temporal, hope-api | — |
| **hope-api** | PostgreSQL, Redis, MinIO, **Vault**, hope-stt-v2, hope-smr, hope-nlp, hope-guardrail, hope-tts, hope-harness | — |
| **hope-admin-console** | hope-api | — |
| **hope-compat-playground** | hope-api | — |

---

## Why This Order Matters

- **`hope-api` will refuse to start** if Vault is sealed or unreachable — it
  does a blocking AppRole login and secret warmup before any request is served.
- **`hope-smr` will stay unready** if LM Studio is not running and reachable on
  the network. `hope-api` cannot finish its readiness checks if SMR is unready.
- **`hope-harness-worker` will crash** (`CreateContainerConfigError`) if the
  `HARNESS_INTERNAL_SERVICE_TOKEN` key is missing from the `hope-secrets` Secret.
- **Loki and Tempo will crash** if the MinIO buckets `hope-loki-logs` and
  `hope-tempo-traces` do not exist before they start.

---

## Correct Deployment Order

Follow this order when deploying for the first time:

### Phase 0 — Out-of-cluster prerequisites (do these BEFORE touching Kubernetes)

```
1. PostgreSQL server is running and accessible
   - Check: psql -h <host> -U <user> -d <database>

2. Redis server is running
   - Check: redis-cli -h <host> ping  → should return PONG

3. MinIO is running and the following buckets exist:
   - hope-audio
   - hope-audio-chunks
   - hope-loki-logs
   - hope-tempo-traces
   - mlflow, recordings, generated-audio, documents, backups
   - Create: mc mb myminio/hope-audio  (repeat for each)

4. LM Studio is running on the host machine
   - Must have "Serve on Local Network" enabled
   - Must be reachable at http://10.10.1.10:1234 from inside the cluster
   - Model loaded: gemma-4-e2b-it-qat

5. Temporal is running externally at 10.10.1.10:7233
```

### Phase 1 — Kubernetes Secrets (do these before ArgoCD syncs anything)

```
6. Create the image pull secret:
   kubectl create namespace hope-v2-dev

   kubectl -n hope-v2-dev create secret docker-registry hope-registry-creds \
     --docker-server=registry.taphuynh.dev \
     --docker-username=<username> \
     --docker-password=<password>

7. Create the hope-secrets Secret:
   kubectl apply -n hope-v2-dev -f arca-deployment-template/deployment/secrets.dev.yaml
   # (fill all values first — see 05-vault-secrets-setup.md for what to put where)
```

### Phase 2 — Infrastructure services (in order)

```
8.  Vault              → hope-vault StatefulSet
9.  Vault init         → hope-vault-init Job (initialises + unseals Vault)
    ⚠ SAVE THE UNSEAL KEYS from the init job logs — without them you cannot
      unseal Vault after a restart
10. Qdrant             → hope-qdrant StatefulSet
11. Qdrant init        → hope-qdrant-init Job (creates vector collections)
12. Temporal (in-cluster) → hope-temporal Deployment (only if not using external)
13. Database migrate   → hope-db-migrate Job (runs Prisma migrations)
    ⚠ Runs ONCE and is idempotent. See 07-known-deployment-errors.md §DB-MIGRATE
      if this fails with "schema is not empty"
```

### Phase 3 — AI/ML services (can start in parallel)

```
14. hope-nlp           → no hard deps, loads models lazily
15. hope-guardrail     → needs LM Studio reachable
16. hope-tts           → needs Azure Speech key OR local Kokoro
17. hope-stt-v2        → needs GPU, MinIO, PostgreSQL, Redis
18. hope-stt-v2-worker → needs hope-stt-v2 + MinIO + Redis
19. hope-smr           → needs Redis + LM Studio (blocks until LLM is reachable)
```

### Phase 4 — Application layer

```
20. hope-harness       → needs PostgreSQL, Redis, Temporal, Qdrant, hope-api
21. hope-harness-worker → needs Temporal + inter-service token in hope-secrets
22. hope-api           → LAST main service — depends on all of Phase 3 + Vault
```

### Phase 5 — Frontend

```
23. hope-admin-console → needs hope-api
24. hope-compat-playground → needs hope-api
```

### Phase 6 — Observability (can deploy anytime, does not block other services)

```
25. Prometheus
26. Grafana            → needs hope-loki-logs bucket in MinIO
27. Loki               → needs hope-loki-logs bucket in MinIO
28. Tempo              → needs hope-tempo-traces bucket in MinIO
29. Alertmanager
30. OpenTelemetry Collector (otel-collector)
31. Alloy (log shipper DaemonSet)
```

---

## Service Health Check Endpoints

Once running, verify each service with these health endpoints:

| Service | Health endpoint | Expected response |
|---------|----------------|-------------------|
| hope-api | `GET :8868/api/v1/health/ready` | `{"status":"ok"}` |
| hope-api startup | `GET :8868/api/v1/health/startup` | `{"status":"ok"}` |
| hope-stt-v2 | `GET :8861/health` | `{"status":"ok"}` |
| hope-smr | `GET :8862/api/v1/health/ready` | `{"status":"ok"}` |
| hope-guardrail | `GET :8863/health` | `{"status":"ok"}` |
| hope-nlp | `GET :8864/health` | `{"status":"ok"}` |
| hope-harness | `GET :8866/health` | `{"status":"ok"}` |
| hope-tts | `GET :8865/health` | `{"status":"ok"}` |
| Vault | `GET :8200/v1/sys/health` | `{"sealed":false,...}` |
| Qdrant | `GET :6333/healthz` | `{"title":"qdrant - ..."}` |

---

## NodePort Access (from outside the cluster)

The following services are reachable via NodePort (no Ingress needed):

| Service | NodePort | Access URL |
|---------|----------|-----------|
| hope-api | 30088 | `http://<node-ip>:30088` |
| hope-admin-console | 30081 | `http://<node-ip>:30081` |
| hope-compat-playground | 30082 | `http://<node-ip>:30082` |
| Grafana | via Ingress | `https://grafana-dev.taphuynh.dev` |
