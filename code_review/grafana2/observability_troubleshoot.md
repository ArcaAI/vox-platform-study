# Observability troubleshooting — step by step dashboard and log checks

Date: 2026-11-23  
Companion documents: `observability_discovery.md`, `observability_recommendation.md`, `observability_procedures.md`

Use this runbook when something is slow, failing, silent, or alerting. Start at the top, then jump to the section that matches the symptom.

**Ground rules**

- These are read-only checks unless a step explicitly says **CHANGE**. Get approval before changing production.
- The Grafana on `192.168.112.6:30300` is the **newer apps-v2 estate**. Do not confuse it with the older Grafana on `32090` or `32121`.
- Do not paste raw logs, patient data, request IDs, or credentials into tickets. The new Loki performs PHI redaction, but use judgement.
- If you save command output, file it under `review/grafana2/` or a subdirectory such as `review/grafana2/troubleshoot-runs/`.
- Findings during discovery were: 17/50 Prometheus targets down, several alerts firing, two Loki instances, and one silent worker. Current state may have changed; always verify live.

---

## 0. Ten-minute first pass

Do these before deep debugging.

1. Open `http://192.168.112.6:30300` and log in.
2. Set the time range to **Last 1 hour**, then repeat with **Last 24 hours** if empty. Many quiet services only log every few hours.
3. Open **Dashboards → HOPE → HOPE — Infrastructure Overview**.
   - Are there firing alerts?
   - How many targets are down?
4. Open **HOPE — Kubernetes Workloads & Events**.
   - Any `ContainerWaitingOnError`, `PodCrashLooping`, `PodEvicted`, or restarts?
5. Open **HOPE — Platform (Application Plane)**.
   - Is request rate zero, error rate high, or latency spiking?
6. Open **Explore → Prometheus** and run:

   ```promql
   ALERTS{alertstate="firing"}
   ```

   ```promql
   sum by (job) (up == 0)
   ```

7. Open **Explore → Loki** and run:

   ```logql
   sum by (service_name) (
     count_over_time({k8s_namespace_name="project-hope-vox-apps-v2"} [1h])
   )
   ```

8. If a service is missing, jump to **Section 4**. If a target is down, jump to **Section 3**. If the user reports slowness/errors, jump to **Section 2**.

---

## 1. Quick symptom map

| Symptom | First dashboard | First query | Then |
|---|---|---|---|
| API slow / 5xx | Platform, SDK Clients, K8s Workloads | `hope_api_http_*`, p95 latency | Logs + Tempo traces |
| TargetDown firing | Infrastructure Overview | `sum by (job)(up == 0)` | Map port → service → pods |
| TemporalDown | Infrastructure Overview / Dependencies | `up{job="temporal"}` | Temporal UI `30880`, pods, logs |
| No logs for service | Log coverage / Loki Explore | `count_over_time(...)` | Check correct Loki + labels |
| Guardrail/Text 401 | Endpoint check | `curl -w '%{http_code}'` | 401 is expected; check auth |
| GPU/vLLM slow | GPU, vLLM, Model Residency | `DCGM_*`, `hope_vllm_*` | Check model load/eviction |
| Dashboard empty | Explore | `up`, simple Loki selector | Check time range, datasource, labels |
| Alert storm | Alertmanager triage | `ALERTS{alertstate="firing"}` | Group by rule/job/namespace |

---

## 2. User reports slowness or errors

### 2.1 Check the application dashboards

1. Open **HOPE — Platform (Application Plane)**.
2. Look at panels for:
   - API gateway request rate
   - API response status / error rate
   - API latency (p50/p95/p99)
   - STT realtime sessions
   - Guardrail wait / admission
   - Text generation rate and latency
   - NLP queue depth
3. Open **HOPE — SDK Clients**.
   - If SDK error rate is high but API error rate is low, check client version/client-side network.
4. Open **HOPE — Kubernetes Workloads & Events**.
   - Restarts or waiting containers usually explain sudden degradation.

### 2.2 Confirm with Prometheus

In **Explore → Prometheus**:

```promql
sum(rate(hope_api_http_requests_total[5m]))
```

```promql
sum by (status) (rate(hope_api_http_requests_total[5m]))
```

```promql
histogram_quantile(
  0.95,
  sum by (le) (rate(hope_api_http_request_duration_seconds_bucket[5m]))
)
```

For Python services, compare:

```promql
rate(http_requests_total{job="guardrail"}[5m])
```

```promql
histogram_quantile(
  0.95,
  sum by (le) (rate(http_request_duration_seconds_bucket{job="guardrail"}[5m]))
)
```

For queue-driven services:

```promql
guardrail_queue_depth
```

```promql
nlp_inference_queue_depth
```

```promql
stt_vllm_slot_wait_seconds
```

### 2.3 Read the logs

In **Explore → Loki**, select the `loki` datasource.

Start broad:

```logql
{service_name="hope-api"}
```

Narrow to errors:

```logql
{service_name="hope-api"} | detected_level="error"
```

Search message text:

```logql
{service_name="hope-api"} |= "error"
```

Guardrail decision failures:

```logql
{service_name="hope-guardrail"} |~ "undetermined|failed|circuit"
```

Text generation failures:

```logql
{service_name="hope-text"} |~ "judge.failed|generation|provider"
```

Available structured fields include `detected_level`, `k8s_pod_name`, `hope_request_id`, `enduser.id`, and service-specific fields. Filter with `| field="value"`, not as indexed labels.

### 2.4 Correlate with traces

If Tempo is available and a `hope_request_id` is present:

1. Copy the request ID from the log line.
2. Open **Explore → Tempo**.
3. Search by that ID if the trace ID/field is supported, or open the related service trace in the dashboard.
4. Look for the slow downstream span: Postgres, Redis, Vault, vLLM, Guardrail peer, or external provider.

### 2.5 Decide what to escalate

| Finding | Escalate to |
|---|---|
| API runtime issue: event-loop lag, heap, FDs | Service owner / Indumati Vastrad |
| Guardrail decisions/outbox/circuit breaker | Guardrail owner |
| NLP/STT queue backlog | Service owner + GPU/infra owner |
| Postgres/Redis/Vault/Qdrant errors | Infra owner / Karan Mohan, Rijna Shameen |
| Temporal workflow failures | Infra owner + workflow owner |

---

## 3. TargetDown or ExpectedTargetCountMismatch firing

### 3.1 Identify theDown job

```promql
sum by (job) (up == 0)
```

```promql
up{job="temporal"}
```

During discovery, down jobs were:

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

### 3.2 Check whether the service is actually down

1. Use the port map in `observability_procedures.md` section 1.
2. For HTTP endpoints:

   ```bash
   curl -sSL --max-time 12 -o /dev/null \
     -w 'http=%{http_code} final=%{url_effective}\n' \
     http://192.168.112.6:30880
   ```

3. For raw TCP ports:

   ```bash
   python3 - <<'PY'
   import socket
   for name, port in [('postgres', 30543), ('qdrant-grpc', 30634)]:
       s = socket.socket(); s.settimeout(3)
       try:
           s.connect(('192.168.112.6', port))
           print(f'{name}: OPEN')
       except Exception as e:
           print(f'{name}: FAIL {e}')
       finally:
           s.close()
   PY
   ```

4. Check the Kubernetes objects:

   ```bash
   kubectl -n project-hope-vox-infra-v2 get pods,svc,endpoints -o wide
   ```

   or for apps:

   ```bash
   kubectl -n project-hope-vox-apps-v2 get pods,svc,endpoints -o wide
   ```

### 3.3 Decide

- Endpoint reachable, Prometheus target down → likely scrape config, network policy, or service discovery issue.
- Endpoint unreachable and pods not ready → real service outage.
- Guardrail/Text returns 401 → **not** an outage; 401 means authenticated API is reachable.
- Some data-tier scrape jobs may be down while the service itself works; compare with endpoint checks before paging.

---

## 4. A service has no logs

This is the most common source of confusion. Follow in order.

### 4.1 Make sure you are in the right Loki

| If the namespace is... | Use datasource | Label schema |
|---|---|---|
| `project-hope-vox-apps-v2` | `loki` | `service_name`, `k8s_namespace_name`, `k8s_container_name`, `deployment_environment_name` |
| `project-hope-vox`, `project-hope-vox-infra`, `project-hope-vox-infra-v2`, `monitoring`, etc. | Add/use `Loki (Infra)` pointing at the old Loki | `namespace`, `job`, `pod`, `container`, `service_name`, `stream`, `filename`, `node` |

The Grafana on `30300` only has the new apps-v2 Loki by default. The old Loki is the one that sees infra and legacy namespaces.

### 4.2 Widen the time range

```logql
sum by (service_name) (
  count_over_time({k8s_namespace_name="project-hope-vox-apps-v2"} [24h])
)
```

If 24h is empty, try 7 days. Retention is 30 days.

### 4.3 Check the exact service name

```logql
{service_name=~".*stt.*"}
```

```logql
{k8s_container_name=~".*worker.*"}
```

Do not assume the deployment name equals `service_name`.

### 4.4 Check structured metadata, not labels

This returns nothing in the new Loki:

```logql
{detected_level="error"}
```

Use:

```logql
{service_name="hope-api"} | detected_level="error"
```

### 4.5 Compare with the container directly

```bash
kubectl -n project-hope-vox-apps-v2 logs deploy/hope-nlp --since=1h --tail=20
```

```bash
kubectl -n project-hope-vox-apps-v2 logs deploy/hope-stt-v2-worker --since=24h --tail=20
```

Interpretation:

| Loki | kubectl | Meaning |
|---|---|---|
| has logs | has logs | Collection working |
| empty | has logs | ingestion/pipeline/label problem |
| empty | empty | application is silent |
| has logs | empty | wrong container/deployment selected |

### 4.6 Known case: `hope-stt-v2-worker`

During discovery:

- Last log line: `2026-11-21T07:35Z`
- `kubectl logs --since=24h` was empty
- Other STT services had logs

This points to a silent/stalled worker, not a Loki problem. Check pod state, restarts, queue backlog, and Temporal task failures:

```bash
kubectl -n project-hope-vox-apps-v2 get pods -l app=hope-stt-v2-worker -o wide
```

```promql
kube_pod_container_status_restarts_total{namespace="project-hope-vox-apps-v2",pod=~"hope-stt-v2-worker.*"}
```

```promql
ALERTS{alertname=~"STTBatch.*|TemporalWorkerTaskFailures"}
```

### 4.7 GPU-node nuance

Alloy does not run on `node-type=gpu-node`, but `hope-vllm`, `hope-vllm-asr`, `hope-nlp`, and `hope-stt-v2` do emit logs via app-level OTLP with pod/node metadata. Missing raw stdout tracebacks on the GPU node is a hardening gap, not the reason those services are missing from Loki.

---

## 5. TemporalDown firing

1. Confirm the alert:

   ```promql
   up{job="temporal"}
   ```

   ```promql
   ALERTS{alertname="TemporalDown"}
   ```

2. Check the UI endpoint:

   ```bash
   curl -sSL --max-time 12 -o /dev/null -w '%{http_code}\n' http://192.168.112.6:30880
   ```

3. Check the service and pods:

   ```bash
   kubectl -n project-hope-vox-infra-v2 get pods,svc,endpoints -o wide | grep -i temporal
   ```

4. Check logs in the correct Loki:

   ```logql
   {namespace="project-hope-vox-infra-v2"} |= "temporal"
   ```

5. Decide:
   - UI reachable and pods ready → likely scrape/misconfig; still investigate page-severity alert.
   - UI unreachable or pods waiting → real outage; escalate to infra owner.
   - Workflow failures but Temporal healthy → check Harness/STT worker logs and task queues.

---

## 6. Guardrail or Text returns 401

A 401 is expected for these authenticated APIs. It means the listener is up.

1. Check status:

   ```bash
   curl -sSL --max-time 12 -o /dev/null -w '%{http_code}\n' http://192.168.112.6:30863
   ```

2. If you need a health signal, ask the service owner for the correct health endpoint and required auth header.
3. Check metrics instead:

   ```promql
   up{job="guardrail"}
   ```

   ```promql
   guardrail_inflight_requests
   ```

   ```promql
   guardrail_queue_depth
   ```

4. Check logs:

   ```logql
   {service_name="hope-guardrail"} |~ "undetermined|failed|circuit|outbox"
   ```

---

## 7. GPU / vLLM slow or model missing

1. Open dashboards in this order:
   - HOPE — GPU (DCGM)
   - HOPE — vLLM Inference
   - HOPE — Model Residency
   - HOPE — Node & System Activity
2. Check:

   ```promql
   DCGM_FI_DEV_GPU_UTIL > 95
   ```

   ```promql
   DCGM_FI_DEV_FB_USED / DCGM_FI_DEV_FB_TOTAL > 0.9
   ```

   ```promql
   DCGM_FI_DEV_GPU_TEMP > 80
   ```

   ```promql
   model_resident_bytes
   ```

   ```promql
   rate(model_evictions_total[15m])
   ```

   ```promql
   rate(model_load_failures_total[15m])
   ```

3. Check vLLM logs:

   ```logql
   {service_name="hope-vllm"} |~ "error|OOM|evict|load"
   ```

   ```logql
   {service_name="hope-vllm-asr"} |~ "error|OOM|evict|load"
   ```

4. Escalate with GPU node name, model name, utilisation, framebuffer, eviction count, and log window.

---

## 8. Dashboard is empty or wrong

1. Check the time range: Last 1h, then Last 24h.
2. Check the datasource name in the panel:
   - `Prometheus`
   - `loki`
   - `tempo`
3. Check Grafana health:

   ```bash
   curl -sS http://192.168.112.6:30300/api/health
   ```

   Expected includes `database: ok`, `version: 13.1.2`.

4. Check the dashboard variables:
   - `namespace` should be `project-hope-vox-apps-v2` for app dashboards.
   - `gpu` or node filters may exclude all series.
5. If the alert search UI fails with HTTP 500, do not rely on it. Query Prometheus rules directly:

   ```promql
   ALERTS{alertstate=~"firing|pending"}
   ```

   Grafana `/api/search?type=alert` returned HTTP 500 during discovery; this is a known observation.

---

## 9. Alert storm / too much noise

1. List firing alerts:

   ```promql
   ALERTS{alertstate="firing"}
   ```

2. Group by rule:

   ```promql
   count by (alertname) (ALERTS{alertstate="firing"})
   ```

3. Group by namespace:

   ```promql
   count by (namespace) (ALERTS{alertstate="firing"})
   ```

4. Find which alerts are page severity:

   ```promql
   ALERTS{alertstate="firing",severity="page"}
   ```

5. During discovery, page severity included `TemporalDown` and pending `PodCrashLooping`. Ticket severity included `TargetDown`, `ExpectedTargetCountMismatch`, `ContainerWaitingOnError`, `DeploymentReplicasUnavailable`, and `PodEvicted`.
6. Do not silence a page-level alert without an owner and expiry. Record the reason in the incident/ticket.

---

## 10. What to record before escalating

Include:

- Grafana URL and dashboard/panel name
- Time window used
- Exact PromQL/LogQL run
- HTTP status codes from endpoint checks
- Pod/service/namespace names
- Alert name, severity, and start time
- Last known good log line, if applicable
- Whether the issue is in metrics, logs, traces, or the endpoint itself

Do **not** include raw payloads, credentials, patient identifiers, or full request IDs in shared tickets.

---

## 11. Escalation quick reference

| Area | Suggested owner |
|---|---|
| Guardrail, Text, NLP, LM Studio, STT services | Indumati Vastrad |
| PostgreSQL, Temporal, Silo/MinIO, Qdrant, Vault | Karan Mohan / Rijna Shameen |
| Grafana, Prometheus, Loki, Tempo, OTel Collector, alert rules | Platform / observability owner |
| Credential rotation and security | Platform owner + security |

For implementation steps such as adding a datasource or creating a dashboard, follow `observability_procedures.md`. For the full findings, use `observability_discovery.md`.
