# Observability discovery — HOPE / VOX platform

Date: 2026-11-23  
Scope: this file consolidates all findings gathered so far. Raw evidence remains in `review/grafana2/`.  
Companion documents:

- `observability_recommendation.md`
- `observability_procedures.md`
- `observability_troubleshoot.md`

No dashboards, alerts, users, or cluster objects were changed during discovery.

---

## 1. Executive summary

- `http://192.168.112.6:30300/alerting` is **Grafana 13.1.2** in namespace `project-hope-vox-apps-v2`. It is the newer HOPE estate. Anonymous access is disabled; the UI redirects to `/login?redirectTo=%2Falerting`.
- The Grafana `HOPE` folder contains **9 dashboards** and uses three datasources: **Prometheus** (default), **Loki**, and **Tempo**.
- Prometheus has **24 scrape jobs**, **50 active targets**, and **35 alert rules in 9 groups**. Several alerts are currently firing: `TargetDown`, `ExpectedTargetCountMismatch`, `TemporalDown`, `ContainerWaitingOnError`, `DeploymentReplicasUnavailable`, `PodEvicted`; `PodCrashLooping` is pending.
- There are **two separate Loki instances**:
  - new apps-v2 Loki → only `project-hope-vox-apps-v2`
  - old infra Loki → cluster-wide, including `project-hope-vox`, `project-hope-vox-infra`, `project-hope-vox-infra-v2`, and other namespaces
- The apps-v2 Loki indexes only **four labels** and stores everything else as structured metadata. Its OTel pipeline performs PHI redaction before ingest.
- The service endpoints supplied by the user all map to `project-hope-vox-apps-v2`; the infrastructure endpoints all map to `project-hope-vox-infra-v2`.
- The only real log-coverage gap found is `hope-stt-v2-worker`, which has not emitted logs since `2026-11-21T07:35Z`. Five other services that initially looked missing were quiet during the first 1-hour sample but do have 24-hour coverage.
- A Grafana admin credential supplied in chat works, but is exposed and must be rotated.

---

## 2. Namespace and estate map

| Namespace | Pods | Services | Meaning |
|---|---:|---:|---|
| `project-hope-vox-apps-v2` | 36 | 24 | Newer app plane; Grafana `30300`, Prometheus, Tempo, OTel Collector, Alloy, app microservices |
| `project-hope-vox` | 18 | 19 | Older HOPE app plane with similarly named services (`hope-api-gateway`, `hope-nlp`, `hope-stt`, etc.) |
| `project-hope-vox-infra` | 26 | 20 | Older data tier plus its own Grafana/Loki/Prometheus/Promtail; postgres, redis, qdrant, silo, temporal, vault |
| `project-hope-vox-infra-v2` | 7 | 8 | Newer data tier: `postgres`, `redis`, `temporal`, `hope-vault`, `qdrant`, `silo` |
| `monitoring` | 7 | 2 | Older Prometheus/Grafana |
| `arcafabric` | 27 | 37 | Separate ArcaFabric stack |

Earlier service lists were scoped to `project-hope-vox-apps-v2`; they are not the whole estate.

---

## 3. Grafana on port 30300

### 3.1 Identity

| Item | Value |
|---|---|
| Namespace | `project-hope-vox-apps-v2` |
| Service | `svc/grafana` |
| Port mapping | `3000:30300/TCP` |
| Image | `grafana/grafana:13.1.2` |
| Root URL | `http://192.168.112.6:30300` |
| Anonymous access | disabled |
| Theme | dark |
| Health | `/api/health` → `database: ok`, version `13.1.2`, commit `7f247b37a4e51a1ed33904ec63ac6c6087bf7f48` |

### 3.2 Datasources

| Name | Type | UID | URL | Default |
|---|---|---|---|---|
| Prometheus | prometheus | `prometheus` | `http://prometheus:9090` | yes |
| Loki | loki | `loki` | `http://loki:3100` | no |
| Tempo | tempo | `tempo` | `http://tempo:3200` | no |

These URLs resolve inside `project-hope-vox-apps-v2`. The Grafana instance currently has no datasource for the old infra Loki.

### 3.3 HOPE folder dashboards

| UID | Title | Main coverage |
|---|---|---|
| `hope-dependencies` | HOPE — Data-tier Dependencies | Postgres, Redis, MinIO, Vault |
| `hope-gpu` | HOPE — GPU (DCGM) | GPU utilisation, memory, thermals, power, PCIe |
| `hope-infra-overview` | HOPE — Infrastructure Overview | Targets up/down, alerts, node resources, dependency health |
| `hope-k8s-workloads` | HOPE — Kubernetes Workloads & Events | Pod phases, restarts, waiting reasons, evictions |
| `hope-model-residency` | HOPE — Model Residency | Resident bytes, instances, load time, evictions, admission |
| `hope-node-system` | HOPE — Node & System Activity | CPU, memory/PSI, OOM, sockets, disk, network |
| `hope-platform` | HOPE — Platform (Application Plane) | API gateway, STT realtime, text/guardrail/NLP, BullMQ |
| `hope-sdk-clients` | HOPE — SDK Clients | SDK error rates, latency, versions |
| `hope-vllm` | HOPE — vLLM Inference | Requests, latency, ASR RTF, KV cache, scaling |

The Grafana API call `/api/search?type=alert&limit=500` returned HTTP 500; Prometheus alert rules were queried directly instead.

---

## 4. Verified endpoints

### 4.1 Service layer — `project-hope-vox-apps-v2`

| Endpoint | Service | Port mapping | Result |
|---|---|---|---|
| `http://192.168.112.6:30863` | `svc/hope-guardrail` | `8863:30863` | HTTP 401 — auth required, reachable |
| `http://192.168.112.6:30862` | `svc/hope-text` | `8862:30862` | HTTP 401 — auth required, reachable |
| `http://192.168.112.6:30864` | `svc/hope-nlp` | `8864:30864` | HTTP 200 |
| `http://192.168.112.6:31234` | `svc/hope-lmstudio` | `1234:31234` | HTTP 200; service has no selector |

### 4.2 Infrastructure layer — `project-hope-vox-infra-v2`

| Endpoint | Service | Port mapping | Result |
|---|---|---|---|
| `192.168.112.6:30543` | `svc/postgres` | `5432:30543` | TCP OPEN |
| `http://192.168.112.6:30880` | `svc/temporal-ui` | `8080:30880` | HTTP 200 |
| `http://192.168.112.6:30901` | `svc/silo-console` | `9001:30901` | HTTP 200 |
| `http://192.168.112.6:30633` | `svc/qdrant` | `6333:30633` | HTTP 200 — REST |
| `192.168.112.6:30634` | `svc/qdrant` | `6334:30634` | TCP OPEN — gRPC |
| `http://192.168.112.6:30820` | `svc/hope-vault` | `8200:30820` | HTTP 200 after redirect to `/ui/`; page is large |

### 4.3 Owners supplied

- Service layer: Indumati Vastrad
- Infrastructure layer: Karan Mohan, Rijna Shameen

---

## 5. Application workloads and languages

| Deployment | Runtime | Evidence |
|---|---|---|
| `hope-api` | NestJS / Node.js | PID 1: `dumb-init -- node ... apps/api/dist/main.js`; metrics `hope_api_nodejs_*`, `hope_api_http_*` |
| `hope-model-publisher` | Node.js, same API package | PID 1: `node ... model-publisher.main.js` |
| `hope-admin-console` | Next.js | PID 1: `next-server` |
| `hope-guardrail` | Python | `python -m guardrail.main`; `guardrail_*` metrics |
| `hope-harness` | Python | PID 1 `python`; `harness_*` |
| `hope-harness-worker` | Python | worker image |
| `hope-nlp` | Python | PID 1 `python`; `nlp_*` metrics |
| `hope-text` | Python / FastAPI | `python -m uvicorn text.main:app ...`; `text_*` |
| `hope-tts` | Python | PID 1 `python`; `tts_model_loaded` |
| `hope-stt-v2` | Python | PID 1 `python`; `stt_*` metrics |
| `hope-stt-v2-worker` | Python | worker image |
| `hope-vllm`, `hope-vllm-asr` | Python inference | vLLM images; `hope_vllm_*`, `vllm:*`, `DCGM_*` |

Supporting platform pods: `alertmanager`, `prometheus`, `grafana`, `loki`, `tempo`, `otel-collector` (2), `alloy-logs` (6), `kube-state-metrics`, `cadvisor`, `node-exporter`, `dcgm-exporter`.

---

## 6. Prometheus state

### 6.1 Jobs

`alertmanager`, `alloy`, `api-gateway`, `cadvisor`, `dcgm-exporter`, `grafana`, `guardrail`, `harness`, `kube-state-metrics`, `loki`, `minio`, `nlp`, `node-exporter`, `patroni`, `pgbouncer`, `postgres`, `prometheus`, `redis`, `smr`, `stt-v2`, `tempo`, `temporal`, `tts`, `vault`.

### 6.2 Down targets

| Job | Down |
|---|---:|
| `minio` | 1 |
| `patroni` | 3 |
| `pgbouncer` | 3 |
| `postgres` | 3 |
| `redis` | 2 |
| `smr` | 1 |
| `temporal` | 1 |
| `vault` | 3 |

Total: 17 of 50 targets down. Most application jobs are up.

### 6.3 Alert rules

9 groups / 35 rules. Current firing/pending:

| Rule | State | Severity |
|---|---|---|
| `TargetDown` | firing | ticket |
| `ExpectedTargetCountMismatch` | firing | ticket |
| `TemporalDown` | firing | page |
| `ContainerWaitingOnError` | firing | ticket |
| `DeploymentReplicasUnavailable` | firing | ticket |
| `PodEvicted` | firing | ticket |
| `PodCrashLooping` | pending | page |

Rule groups: `coverage`, `gpu`, `node`, `postgres`, `redis`, `temporal`, `vault_storage`, `workers`, `workloads`.

---

## 7. Loki findings

### 7.1 Two Loki instances

| Instance | Namespace | Pipeline | Labels | Scope |
|---|---|---|---|---|
| New | `project-hope-vox-apps-v2` | Alloy → OTel Collector → Loki `/otlp` | `service_name`, `k8s_namespace_name`, `k8s_container_name`, `deployment_environment_name` | Only apps-v2 namespace |
| Old | `project-hope-vox-infra` | Promtail → Loki | `namespace`, `job`, `pod`, `container`, `service_name`, `stream`, `filename`, `node` | Cluster-wide |

24-hour volume in the old Loki includes `project-hope-vox` (438k), `project-hope-vox-infra` (371k), `project-hope-vox-apps-v2` (91k), `project-hope-vox-infra-v2` (13k), `kube-system`, `arcafabric`, `argocd`, `monitoring`, and others.

### 7.2 New Loki pipeline

- Alloy DaemonSet `grafana/alloy:v1.7.1`, 6 pods, one per non-GPU node.
- Alloy uses `POD_NAMESPACE=metadata.namespace`, so it only tails apps-v2 pods.
- Alloy has node affinity `node-type NotIn gpu-node`; `ai-ml-worker-1` is skipped.
- OTel Collector maps the HOPE JSON log contract, redacts PHI, and exports to `http://loki:3100/otlp`.
- Loki retention is 30 days (`720h`). Chunks are stored in `hope-loki-logs`.
- Only four labels are indexed; correlation fields (`hope_request_id`, `enduser.id`, `k8s_pod_name`, `detected_level`, etc.) are structured metadata and require `| field="value"` filters.

### 7.3 New Loki coverage (24h)

| Service | Lines |
|---|---:|
| `hope-vllm` | 1552 |
| `hope-vllm-asr` | 1106 |
| `hope-nlp` | 1961 |
| `hope-stt-v2` | 2116 |
| `hope-admin-console` | 11 |
| `hope-stt-v2-worker` | 0 |

The GPU services are reached via app-level OTLP export, which includes pod/node/container metadata, despite Alloy skipping the GPU node. Raw stdout tracebacks outside the OTLP logger would still be missed there.

Error signals seen:

- `guardrail.judge.undetermined` — 6
- `hope-api` S3 upload/list errors — 5
- `Unknown variable in policy rule` — 92 warns from `PolicyEngine`
- `judge.failed` — `hope-text`
- `tts.effective_config.fetch_error` — warn-level
- Grafana Tempo TraceQL failures and `/api/search` 500

`hope-stt-v2-worker` last emitted logs at `2026-11-21T07:35Z`; recent `kubectl logs --since=24h` is empty. This looks like a stalled/silent worker, not an ingestion failure.

---

## 8. Existing dashboard coverage vs gaps

Covered: infrastructure, nodes/PSI, Kubernetes workload events, GPUs/DCGM, vLLM inference/scaling, model residency, SDK clients, data-tier dependencies, broad application plane.

Main gaps:

1. Dedicated NestJS API runtime deep dive
2. Uniform Python FastAPI golden signals
3. Guardrail decision/outbox health
4. NLP inference queue health
5. STT realtime + batch worker SLO
6. Text generation and language quality
7. TTS model cold-start/residency
8. Temporal / Harness workflow health
9. Alertmanager / alert-fatigue triage
10. Observability self-monitoring and log-coverage

---

## 9. Security notes

- The Grafana admin credential shared in chat works but is exposed. Rotate it and use a service account/token for automation. It was not written to any file.
- Earlier root/user passwords used during server access are also exposed and should be rotated.
- Loki ingest performs PHI redaction; do not bypass the OTel pipeline or add high-cardinality/patient-identifying labels.
- Do not paste raw application logs into tickets without review.

---

## 10. Raw evidence index

Key files in `review/grafana2/`:

- `discovery.md` — original consolidated discovery
- `namespace-scope.md` — namespace and two-Loki scope
- `endpoint-inventory.md` — endpoint verification
- `grafana-api-*.json`, `prometheus-api-*.json`, `grafana-dashboard-*.json`
- `loki/` — Loki API, config, queries, errors, root-cause evidence
- `14-namespace-scope-*`, `15-namespace-and-loki-scope.console.txt`, `16-loki-infra-*`, `17-loki-infra-service-coverage.console.txt`
- `18-endpoint-verification.console.txt`, `18-endpoint-svc-mapping.txt`, `http-body-*.txt`
