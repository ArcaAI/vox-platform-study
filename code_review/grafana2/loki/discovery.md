# Loki log discovery — `project-hope-vox-apps-v2`

Date: 2026-11-23  
Parent discovery: `review/grafana2/discovery.md`  
**Scope note:** this file is about the **new apps-v2 Loki** only. There is a separate old Loki in `project-hope-vox-infra`; see `review/grafana2/namespace-scope.md`.  
Loki service: `svc/loki` (`3100`), image `grafana/loki:3.7.8`; Grafana datasource UID `loki` → `http://loki:3100`  
Evidence folder: `review/grafana2/loki/`  
No Loki/Alloy/OTel configuration was changed.

## 1. Pipeline

```
container stdout
  → kubelet /var/log/pods
  → Alloy DaemonSet (grafana/alloy:v1.7.1) — tail + CRI unwrap + k8s metadata
  → OTel Collector (otel/opentelemetry-collector-contrib:0.149.0)
      logs pipeline: memory_limiter → transform/logs_contract → resource
                     → redaction/phi_logs → batch → otlphttp/loki
  → Loki /otlp
```

Key config facts from `cm/alloy-logs-config`, `cm/loki-config`, and `cm/otel-collector-config`:

- The apps-v2 Loki indexes exactly **four labels**: `service_name`, `k8s_namespace_name`, `k8s_container_name`, `deployment_environment_name`. The old infra Loki uses a different schema (`namespace`, `job`, `pod`, `container`, `service_name`).
- Everything else (`hope_request_id`, `enduser.id`, `k8s_pod_name`, `k8s_node_name`, `scope_name`, `service_version`, `detected_level`, etc.) is **structured metadata**, filterable with `| field="value"`, not `{field="value"}`.
- Retention: **30 days** (`720h`), same as Prometheus TSDB.
- Chunks/index stored in S3-compatible `hope-loki-logs` bucket via `silo.project-hope-vox-infra-v2.svc.cluster.local:9000`; TLS verification is disabled by config (self-signed cert).
- PHI redaction is enforced in the OTel Collector: JSON log-contract mapping, deny-list for clinical/identity/content keys, hashed patient/consultation IDs only, JWT/bearer/e-mail scrubbing, and blob/base64 value blanking.
- Loki has its own ruler (`enable_api: true`) sending alerts to `http://alertmanager:9093`.

## 2. What is actually being collected

Sampled last hour at discovery time. `service_name` values seen with non-zero volume:

| Service | Lines/1h | Note |
|---|---:|---|
| `loki` | 4802 | Self-logs; 4 errors were query-scheduler cancellations from our own API queries |
| `hope-api` | 659 | 5 error-level lines; 92 warn lines = `Unknown variable in policy rule` from `PolicyEngine` |
| `grafana` | 471 | 3 errors: Tempo TraceQL query failures and the `/api/search` 500 we saw |
| `tempo` | 74 | |
| `hope-tts` | 68 | 56 lines contain "error" but they are warn-level `tts.effective_config.fetch_error`, not fatal |
| `hope-text` | 19 | 3 errors: `judge.failed` |
| `alloy-logs` | 12 | Self-telemetry |
| `hope-guardrail` | 12 | 6 errors: `guardrail.judge.undetermined` |
| `alertmanager` | 10 | Self-telemetry |
| `hope-harness` | 8 | |
| `hope-harness-worker` | 5 | |
| `hope-model-publisher` | 4 | |
| `otel-collector` | 1 | Self-telemetry |

Error-level counts by service (structured `detected_level=~"error|fatal"`):

`hope-guardrail: 6`, `hope-api: 5`, `loki: 4`, `grafana: 3`, `hope-model-publisher: 3`, `hope-text: 3`.

Observed error messages:

- `guardrail.judge.undetermined` — guardrail external text client
- `Error uploading file to S3` / `Error listing files from S3` — `hope-api` `S3Service`
- `judge.failed` — `hope-text` judge endpoint
- Grafana: `Failed to execute TraceQL query`, `Error processing TraceQL query`, `/api/search status=500 bad type request`
- Loki: only query-scheduler context-cancel/EOF errors during our queries

## 3. Correction: the 1-hour sample was misleading

The initial 1-hour query suggested the six services in question had no logs. A 24-hour re-check (`11-24h-coverage-check.console.txt`) shows that five of them **are** being collected:

| Service | Lines in 24h | Status |
|---|---:|---|
| `hope-vllm` | 1552 | Collected |
| `hope-vllm-asr` | 1106 | Collected |
| `hope-nlp` | 1961 | Collected |
| `hope-stt-v2` | 2116 | Collected |
| `hope-admin-console` | 11 | Collected, very low traffic |
| `hope-stt-v2-worker` | 0 | **No recent logs** |

Sample streams for `hope-vllm`, `hope-nlp`, and `hope-admin-console` all carry `service_name`, `k8s_container_name`, `k8s_pod_name`, `k8s_node_name`, and `deployment_environment_name` (`12-sample-stream-labels.console.txt`). The GPU-node services are therefore reaching Loki via **app-level OTLP export**, not via the node-level Alloy agent.

Why the one-hour query was empty: those services were simply quiet in that window. `count_over_time` correctly returns no series when the count is zero.

### The Alloy GPU-node exclusion is real but not the current blocker

The Alloy DaemonSet deliberately excludes `ai-ml-worker-1` via node affinity:

```yaml
nodeAffinity:
  requiredDuringSchedulingIgnoredDuringExecution:
    nodeSelectorTerms:
    - matchExpressions:
      - key: node-type
        operator: NotIn
        values: [gpu-node]
```

DaemonSet status: `desired=6 ready=6`. This means raw stdout tracebacks that bypass an app's OTLP logger are not captured on the GPU node. Adding a GPU-node Alloy DaemonSet is still worthwhile hardening, but it is **not** required to restore the five working services.

### The only true gap: `hope-stt-v2-worker`

`kubectl logs deploy/hope-stt-v2-worker --tail=12` shows its last emitted lines are from `2026-11-21T07:35Z` — roughly two days before this discovery. Recent lines are startup + `stt.effective_config.fetch_error` / `service_registration.request_failed` warnings, then silence. This looks like a silent/stalled worker process, not a Loki ingestion failure.

Recommended actions:

1. Confirm with `kubectl logs deploy/hope-stt-v2-worker --since=24h` (expected empty).
2. Check liveness/heartbeat and queue backlog (`stt.worker.heartbeat_started`, `STTBatchWorkerDown`, `STTBatchQueueBacklog`).
3. Restart the worker (`kubectl rollout restart deploy/hope-stt-v2-worker`) and watch for fresh logs.
4. Optionally add raw-stdout coverage on the GPU node with a dedicated Alloy DaemonSet so tracebacks outside the OTLP logger are still captured.

## 4. Dashboard/query implications for the HOPE folder

Because only four labels are indexed, dashboards in the `HOPE` folder should:

- Use label selectors for `{service_name=...}`, `{k8s_namespace_name=...}`, `{k8s_container_name=...}`, `{deployment_environment_name=...}`.
- Use structured-metadata filters for everything else, e.g.
  - `{service_name="hope-api"} | detected_level="warn"`
  - `{service_name="hope-api"} | hope_request_id="..."`
  - `{service_name="hope-api"} | k8s_pod_name="..."`
- Avoid adding high-cardinality fields as new index labels; the config explicitly limits them to four.
- Add a **Log coverage / pipeline health** dashboard: log lines per service, error/warn rate by service, missing-service alert (expected vs actual `service_name`), Alloy files active, OTel queue saturation, Loki ingest/flush errors.
- Add Loki panels to the proposed service dashboards:
  - Guardrail: `guardrail.judge.undetermined`
  - API: `S3Service` upload/list errors, `Unknown variable in policy rule`
  - Text: `judge.failed`
  - TTS: `tts.effective_config.fetch_error`
  - Grafana/Tempo: TraceQL failures and `/api/search` 500

## 5. Evidence index in `review/grafana2/loki/`

- `00-loki-api-discovery.console.txt` — port-forward and API status codes.
- `loki-api-labels.json`, `loki-api-label-*-values.json` — indexed labels and values.
- `loki-api-index-stats.json`, `loki-api-sample-logs.json` — raw index/sample responses.
- `01-loki-label-summary.console.txt` — parsed label/value summary.
- `02-loki-query-discovery.console.txt`, `query-*.json`, `03-loki-query-summary.console.txt` — volume/error queries.
- `04-alloy-config-discovery.console.txt`, `alloy-logs-config` ConfigMap dump, `alloy-daemonset.describe.txt` — collector config.
- `05-loki-error-query-discovery.console.txt`, `06-loki-error-samples.console.txt` — service error samples.
- `07-loki-and-otel-config-highlights.console.txt`, `loki-configmap.yaml`, `otel-collector-configmap.yaml` — retention, labels, PHI redaction, storage.
- `08-loki-self-errors.console.txt` — Loki self-errors and flush confirmation.
- `09-loki-container-and-missing-services.console.txt` — container label values and zero-count proof.
- `10-alloy-scheduling-root-cause.console.txt`, `alloy-daemonset.yaml` — `NotIn gpu-node` affinity and node labels/taints.
- `11-24h-coverage-check.console.txt`, `query-24h-*.json` — corrected 24-hour coverage check.
- `12-sample-stream-labels.console.txt`, `query-sample24h-*.json` — stream labels proving app-level OTLP metadata.
