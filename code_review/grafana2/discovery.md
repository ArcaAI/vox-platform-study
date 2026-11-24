# Grafana / alerting discovery — `192.168.112.6:30300`

Date: 2026-11-23  
Cluster context from this laptop: `kubernetes-admin@kubernetes`  
Workspace log folder: `review/grafana2/`  
No dashboards, alerts, or cluster objects were changed. This is discovery only.

## 1. What is running on `http://192.168.112.6:30300/alerting`

It is the **Grafana 13.1.2 Alerting UI** for the newer `project-hope-vox-apps-v2` estate.

- Unauthenticated `GET /alerting` returns `302 Found` → `/login?redirectTo=%2Falerting`.
- Anonymous access is disabled (`GF_AUTH_ANONYMOUS_ENABLED=false`).
- Admin signup disabled; default theme dark; root URL `http://192.168.112.6:30300`.
- Grafana health from `/api/health`: `database: ok`, `version: 13.1.2`, commit `7f247b37a4e51a1ed33904ec63ac6c6087bf7f48`.

`30300` is **not** the legacy monitoring Grafana:

| Port / service | Namespace | Notes |
|---|---|---|
| `30300` (`svc/grafana`, `3000:30300/TCP`) | `project-hope-vox-apps-v2` | This URL. Pod `grafana-...`, image `grafana/grafana:13.1.2`. |
| `32121` (`svc/grafana-svc`) | `arcafabric` | Older ArcaFabric Grafana. |
| `32090` (`svc/prometheus-service`) | `monitoring` | Older Prometheus/Grafana stack. |
| ClusterIP only | `project-hope-vox-infra` | Older HOPE infra Grafana, no external NodePort in this check. |

Grafana admin credentials were read from `secret/hope-secrets` only to query the API. The password was **not** written to any file in this folder.

## 2. Grafana contents

Datasources:

| Name | Type | UID | URL | Default |
|---|---|---|---|---|
| Prometheus | prometheus | `prometheus` | `http://prometheus:9090` | yes |
| Loki | loki | `loki` | `http://loki:3100` | no |
| Tempo | tempo | `tempo` | `http://tempo:3200` | no |

Single folder: **HOPE** (`fg55iamkl37y8d`). Nine existing dashboards:

| UID | Title | Coverage |
|---|---|---|
| `hope-dependencies` | HOPE — Data-tier Dependencies | Postgres, Redis, MinIO, Vault |
| `hope-gpu` | HOPE — GPU (DCGM) | DCGM utilisation, memory, thermals, power, PCIe |
| `hope-infra-overview` | HOPE — Infrastructure Overview | Targets up/down, alerts, node resources, dependency health |
| `hope-k8s-workloads` | HOPE — Kubernetes Workloads & Events | Pod phases, restarts, waiting reasons, evictions, requests |
| `hope-model-residency` | HOPE — Model Residency | Resident bytes, instances, load time, evictions, admission |
| `hope-node-system` | HOPE — Node & System Activity | CPU, memory/PSI, OOM, sockets, disk, network |
| `hope-platform` | HOPE — Platform (Application Plane) | API gateway, STT realtime, text/guardrail/NLP, BullMQ |
| `hope-sdk-clients` | HOPE — SDK Clients | SDK error rates, latency, versions, logs |
| `hope-vllm` | HOPE — vLLM Inference | Requests, latency, ASR RTF, KV cache, scaling |

The GraphQL/alert search API call `GET /api/search?type=alert&limit=500` returned HTTP 500. Prometheus alert rules were queried directly instead and are reliable.

## 3. Prometheus state

24 scrape jobs, 50 active targets. Jobs: `alertmanager`, `alloy`, `api-gateway`, `cadvisor`, `dcgm-exporter`, `grafana`, `guardrail`, `harness`, `kube-state-metrics`, `loki`, `minio`, `nlp`, `node-exporter`, `patroni`, `pgbouncer`, `postgres`, `prometheus`, `redis`, `smr`, `stt-v2`, `tempo`, `temporal`, `tts`, `vault`.

### Down targets (17)

| Job | Down targets |
|---|---:|
| `minio` | 1 |
| `patroni` | 3 |
| `pgbouncer` | 3 |
| `postgres` | 3 |
| `redis` | 2 |
| `smr` | 1 |
| `temporal` | 1 |
| `vault` | 3 |

Most application jobs are up (`api-gateway`, `guardrail`, `harness`, `nlp`, `stt-v2`, `tts`, etc.).

### Alert rules

9 groups / 35 rules. Currently firing or pending:

| Rule | State | Severity |
|---|---|---|
| `TargetDown` | firing | ticket |
| `ExpectedTargetCountMismatch` | firing | ticket |
| `TemporalDown` | firing | page |
| `ContainerWaitingOnError` | firing | ticket |
| `DeploymentReplicasUnavailable` | firing | ticket |
| `PodEvicted` | firing | ticket |
| `PodCrashLooping` | pending | page |

This is consistent with the down targets above and with workload problems visible in `kube-state-metrics`. The data-tier dependency dashboard may be showing healthy Postgres/Redis/Vault panels even though their scrape targets are down — worth checking collector/target wiring.

## 4. Microservices observed in `project-hope-vox-apps-v2`

Runtime language was confirmed from PID 1 / process inspection where possible.

| Deployment | Runtime | Evidence / image |
|---|---|---|
| `hope-api` | **NestJS / Node.js** | PID 1: `dumb-init -- node --import ./apps/api/dist/instrumentation.js apps/api/dist/main.js`; metrics `hope_api_nodejs_*`, `hope_api_http_*` |
| `hope-model-publisher` | **Node.js (same API package)** | PID 1: `node --import ./apps/api/dist/instrumentation.js ./apps/api/dist/model-publisher.main.js` |
| `hope-admin-console` | Node / Next.js | PID 1: `next-server (v1...)` |
| `hope-guardrail` | **Python** | `python -m guardrail.main`; `guardrail_*` metrics |
| `hope-harness` | **Python** | `python`; `harness_*` |
| `hope-harness-worker` | **Python** | worker image; Temporal worker |
| `hope-nlp` | **Python** | `python`; `nlp_*` metrics |
| `hope-text` | **Python / FastAPI** | `python -m uvicorn text.main:app --host 0.0.0.0 --port 8862`; `text_*` metrics |
| `hope-tts` | **Python** | `python`; `tts_model_loaded`, model metrics |
| `hope-stt-v2` | **Python** | `python`; `stt_*` metrics |
| `hope-stt-v2-worker` | **Python** | batch worker image |
| `hope-vllm`, `hope-vllm-asr` | Python inference runtime | vLLM images; `hope_vllm_*`, `vllm:*`, `DCGM_*` |

Supporting platform pods in the same namespace: `alertmanager`, `prometheus`, `grafana`, `loki`, `tempo`, `otel-collector` (2), `alloy-logs` DaemonSet, `kube-state-metrics`, `cadvisor`, `node-exporter`, `dcgm-exporter`.

## 5. Existing coverage vs likely gaps

Already well covered: infrastructure, nodes/PSI, Kubernetes workload events, GPUs/DCGM, vLLM inference/scaling, model residency, SDK clients, data-tier dependencies, and a broad application-plane dashboard.

Gaps worth filling:

1. The **NestJS API runtime** is only lightly covered in `hope-platform` (request rate, latency, event-loop lag, heap). GC, handles/requests/resources, heap spaces, FDs, process CPU/RSS, and dependency traces deserve a dedicated view.
2. **Python services** have domain metrics but no uniform per-service golden-signals/runtime dashboard.
3. **Guardrail** has rich decision/outbox/circuit-breaker metrics but only two panels today.
4. **NLP queue wait / batch size / rejections** are mostly absent.
5. **STT batch worker and Temporal workflows** have alerts but no dedicated deep dive.
6. **Text generation quality** (language repair, Malayalam character ratios, TTFT/token throughput) is mostly Loki queries inside the platform dashboard.
7. **TTS model load/eviction/cold-start** behaviour is mixed into model residency.
8. **Alertmanager / alert fatigue** has no dashboard despite several firing rules.
9. **Observability self-monitoring** is missing; Grafana alert search already returned a 500.

## 6. Suggested dashboards — monitor what and why

| # | Dashboard | Monitor what | Why / key signals |
|---|---|---|---|
| 1 | **NestJS API runtime deep dive** | `hope_api_http_requests_total`, duration buckets, responses by status, `hope_api_nodejs_eventloop_lag_*`, GC, heap spaces, active handles/requests/resources, `hope_api_process_*`, FDs, Tempo dependency spans | Catch event-loop blocking, memory leaks, FD exhaustion, and slow downstream calls before gateway SLOs break. |
| 2 | **Python FastAPI golden signals (templated by service)** | For `guardrail`, `harness`, `nlp`, `text`, `tts`, `stt-v2`: `http_requests_total`, request duration, `fastapi_inprogress`, `process_resident_memory_bytes`, `process_open_fds`, `python_gc_*`, `python_info`, restarts | One repeatable RED + runtime view for the thin services; currently only scattered domain panels exist. |
| 3 | **Guardrail decisions & outbox health** | `guardrail_screening_decisions_total`, `guardrail_queue_depth`, `guardrail_inflight_requests`, `guardrail_admission_wait_seconds`, `guardrail_circuit_breaker_state`, `guardrail_peer_failures_total`, `guardrail_peer_request_seconds`, `guardrail_evaluation_outbox_*`, `guardrail_evaluation_missing_total`, config-cache events | Detect fail-open/fail-closed drift, peer degradation, and lost/missed audit evaluations. |
| 4 | **NLP inference & queue health** | `nlp_inference_queue_depth`, queue wait p50/p95, `nlp_inference_batch_size`, `nlp_inference_rejections_total`, `nlp_documents_processed_total`, `nlp_entities_total`, `nlp_ner_windows_total`, `nlp_process_rss_bytes` | Queue wait and rejections are the earliest user-visible degradation; correlate with GPU/vLLM saturation. |
| 5 | **STT realtime + batch worker SLO** | Realtime: sessions active, RTF, first-partial, commit latency, ingest lag, dropped audio, provider switches, `stt_vllm_slot_wait_seconds`. Batch: queue backlog, job failure rate, worker up, Temporal task failures | Existing alerts (`STTBatchWorkerDown`, `STTBatchQueueBacklog`, `STTBatchJobFailureRate`, `TemporalWorkerTaskFailures`) need a drill-down. |
| 6 | **Text generation & language quality** | `text_generation_total`, `text_time_to_first_token_seconds`, `text_tokens_per_second`, `text_provider_health`, circuit breakers, Loki language-repair outcomes, mixed-language notes, `text_output_language_indic_chars` | Product-specific quality regressions will not appear as HTTP 5xx; Malayalam repair needs its own view. |
| 7 | **TTS / model cold-start & residency** | `tts_model_loaded`, `model_load_seconds`, `model_load_failures_total`, `model_cache_*`, `model_evictions_total`, `model_resident_bytes`, framebuffer used | Cold starts and evictions dominate TTS latency; existing residency dashboard is generic. |
| 8 | **Temporal / Harness workflow health** | Workflow/task failure rate, task queue backlog, retry rate, workflow duration, worker pod restarts, `harness_regen_total`, `PodCrashLooping`, `ContainerWaitingOnError` | `TemporalDown` is firing and workflow-backed clinical flows depend on it. |
| 9 | **Alertmanager & alert-fatigue triage** | `ALERTS{alertstate=~"firing|pending"}`, alerts by rule/severity/namespace, `alertmanager_notifications_failed_total`, silences, inhibition, TargetDown by job, MTTR | 35 rules and several firing alerts; need one place to decide what to page on vs ticket. |
| 10 | **Observability self-monitoring** | Grafana API/dataproxy/alerting latency and status, Prometheus TSDB/compaction, Loki ingest/query, Tempo ingest, Alloy queue sizes, datasource proxy errors | The monitoring stack itself needs an SLO; the Grafana alert-search 500 is an early signal. |

Suggested priority:

- **P0 now:** #9 alert triage + fix/confirm the 17 down targets, especially Temporal, data tier, and Vault.
- **P1 next:** #1 NestJS runtime, #2 Python golden signals, #3 Guardrail, #5 STT batch/Temporal.
- **P2 follow-up:** #4 NLP, #6 Text quality, #7 TTS cold start, #8 workflows, #10 self-monitoring.

## 7. Loki log discovery (follow-up)

Yes — Loki was checked in a separate pass. Full findings are in `review/grafana2/loki/discovery.md`.

Headlines:

- Loki indexes only four labels: `service_name`, `k8s_namespace_name`, `k8s_container_name`, `deployment_environment_name`. Correlation IDs, pod/node, and `detected_level` are structured metadata and need `| field="value"` filters.
- Retention is 30 days; chunks live in the `hope-loki-logs` bucket. OTel Collector performs PHI redaction before Loki ingest.
- Logs are present for `hope-api`, `hope-guardrail`, `hope-harness`, `hope-harness-worker`, `hope-model-publisher`, `hope-text`, `hope-tts`, plus platform self-logs.
- Corrected after a 24-hour re-check: `hope-nlp`, `hope-stt-v2`, `hope-vllm`, `hope-vllm-asr`, and `hope-admin-console` **do** have logs in Loki (app-level OTLP export). The initial 1-hour sample was too narrow.
- The only true gap is `hope-stt-v2-worker`: its last log line is from `2026-11-21T07:35Z`, suggesting a stalled/silent worker rather than a collection failure.
- Alloy still excludes `node-type=gpu-node`, so raw stdout tracebacks on `ai-ml-worker-1` are not captured. Adding a GPU-node Alloy DaemonSet is hardening, not required for the five working services.
- Existing error signals worth dashboards: `guardrail.judge.undetermined`, `hope-api` S3 upload/list errors, `Unknown variable in policy rule`, `judge.failed`, `tts.effective_config.fetch_error`, Grafana Tempo TraceQL failures and `/api/search` 500.

## 8. Namespace scope clarification

The service list in this report is scoped to `project-hope-vox-apps-v2`, because that is the namespace of the Grafana on port `30300`. It is not the whole HOPE estate.

There is also:

- `project-hope-vox` — older app services with similar names
- `project-hope-vox-infra` — older data tier plus its own Grafana/Loki/Prometheus/Promtail
- `project-hope-vox-infra-v2` — newer data tier (Postgres, Redis, Temporal, Vault, Qdrant, MinIO/Silo)

There are **two separate Loki instances**. The apps-v2 Loki only sees `project-hope-vox-apps-v2`; the old infra Loki sees `project-hope-vox`, `project-hope-vox-infra`, `project-hope-vox-infra-v2`, and many other namespaces. The `HOPE` dashboards on port `30300` use only the new Loki datasource.

Full namespace/Loki scope evidence: `review/grafana2/namespace-scope.md`.

## 9. Endpoint inventory

The user-supplied service-layer and infrastructure-layer endpoints were verified and mapped back to Kubernetes services:

- Service layer (Guardrail, Text, NLP, LM Studio) → `project-hope-vox-apps-v2`
- Infrastructure layer (PostgreSQL, Temporal UI, Silo Console, Qdrant REST/gRPC, Vault) → `project-hope-vox-infra-v2`
- Grafana `30300` → `project-hope-vox-apps-v2`

See `review/grafana2/endpoint-inventory.md` for the full table and verification results.

## 10. Consolidated handover documents

All findings have been consolidated into four beginner-friendly documents:

| File | Use it for |
|---|---|
| `observability_discovery.md` | Complete findings: estate map, Grafana, endpoints, workloads, Prometheus, Loki, dashboards, security notes |
| `observability_recommendation.md` | Prioritised dashboard, alert, logging, and hardening recommendations |
| `observability_procedures.md` | Step-by-step checks a new engineer can follow, plus clearly marked **CHANGE** steps |
| `observability_troubleshoot.md` | Step-by-step dashboard/log troubleshooting by symptom |

## 11. Evidence index in `review/grafana2/`

- `observability_discovery.md`, `observability_recommendation.md`, `observability_procedures.md`, `observability_troubleshoot.md` — consolidated handover documents; start here.
- `00-initial-probe.console.txt` — curl redirect + kubectl context/cluster info.
- `curl-30300-alerting.headers.txt`, `curl-30300-alerting.body.html` — raw unauthenticated response.
- `curl-30300-alerting-follow.headers.txt`, `curl-30300-alerting-follow.body.html` — redirect-followed response.
- `kubectl-current-context.txt`, `kubectl-cluster-info.txt`, `kubectl-namespaces.txt`, `kubectl-nodes.txt`.
- `kubectl-services-all.txt`, `kubectl-pods-all.txt`, `kubectl-deployments-all.txt`, `kubectl-statefulsets-all.txt`, `kubectl-daemonsets-all.txt`, `kubectl-ingresses-all.txt`.
- `01-kubectl-inventory.console.txt` — NodePort `30300` match, Grafana service/pod matches.
- `02-grafana-apps-v2.console.txt`, `grafana-apps-v2-deployment.describe.txt`, `grafana-apps-v2-service.describe.txt`, `grafana-apps-v2-image-and-env-names.txt`, `grafana-apps-v2-env-values.txt`.
- `03-api-discovery.console.txt` — API HTTP status codes.
- `grafana-api-health.json`, `grafana-api-datasources.json`, `grafana-api-folders.json`, `grafana-api-dashboards-search.json`, `grafana-api-alert-rules-search.json`.
- `prometheus-api-targets.json`, `prometheus-api-rules.json`, `prometheus-api-jobs.json`, `prometheus-api-config.json`, `prometheus-api-metric-names.json`.
- `04-api-summary.console.txt` — datasources, dashboards, jobs, target health, alert rules.
- `05-workload-images-and-metrics.console.txt`, `06-metric-name-summary.console.txt`.
- `grafana-dashboard-<uid>.json` — all nine dashboard definitions.
- `07-dashboard-definitions.console.txt`, `08-dashboard-panel-summary.console.txt`.
- `09-runtime-language-check.console.txt`, `10-pid1-comm-by-deployment.console.txt`, `11-pid1-cmdline-selected.console.txt`.
- `loki/` — Loki API, config, volume/error queries, and root-cause evidence; see `loki/discovery.md`.
- `14-namespace-scope-*`, `15-namespace-and-loki-scope.console.txt`, `16-loki-infra-*`, `17-loki-infra-service-coverage.console.txt` — namespace and two-Loki scope evidence; see `namespace-scope.md`.
- `18-endpoint-verification.console.txt`, `18-endpoint-svc-mapping.txt`, `http-body-*.txt` — endpoint reachability and service mapping; see `endpoint-inventory.md`.
