# Observability procedures — step by step for a beginner engineer

Date: 2026-11-23  
Companion documents: `observability_discovery.md`, `observability_recommendation.md`, `observability_troubleshoot.md`

These procedures are safe read-only checks unless a step explicitly says **CHANGE**. Always get approval before changing production objects.  
When you run commands for this work, save output under `review/grafana2/`.

---

## 0. Before you start

You need:

- `kubectl` installed and pointed at the lab cluster
- network access to `192.168.112.6`
- Grafana login (get it from the owner, not from chat)
- this folder: `review/grafana2/`

Check your context:

```bash
kubectl config current-context
```

Expected:

```text
kubernetes-admin@kubernetes
```

If it says something else, stop and ask which context to use.

---

## 1. Find which Kubernetes service owns a port

Example: port `30863`.

```bash
kubectl get svc -A -o wide | grep 30863
```

Expected line:

```text
project-hope-vox-apps-v2  hope-guardrail  NodePort  ...  8863:30863/TCP
```

Read it as:

- Namespace: `project-hope-vox-apps-v2`
- Service: `hope-guardrail`
- Service port `8863` is exposed on every node as `30863`

Quick mapping from the current inventory:

| Port | Namespace | Service |
|---:|---|---|
| `30300` | `project-hope-vox-apps-v2` | `grafana` |
| `30543` | `project-hope-vox-infra-v2` | `postgres` |
| `30633`, `30634` | `project-hope-vox-infra-v2` | `qdrant` |
| `30820` | `project-hope-vox-infra-v2` | `hope-vault` |
| `30862` | `project-hope-vox-apps-v2` | `hope-text` |
| `30863` | `project-hope-vox-apps-v2` | `hope-guardrail` |
| `30864` | `project-hope-vox-apps-v2` | `hope-nlp` |
| `30880` | `project-hope-vox-infra-v2` | `temporal-ui` |
| `30901` | `project-hope-vox-infra-v2` | `silo-console` |
| `31234` | `project-hope-vox-apps-v2` | `hope-lmstudio` |

---

## 2. Check whether an endpoint is reachable

For an HTTP endpoint:

```bash
curl -sSL --max-time 12 -o /dev/null \
  -w 'http=%{http_code} final=%{url_effective} bytes=%{size_download}\n' \
  http://192.168.112.6:30864
```

Interpretation:

- `200` → reachable and responding
- `401` → reachable but requires authentication; this is normal for Guardrail and Text
- `302` → redirect; follow it with `-L`
- timeout/connection refused → investigate

For a raw TCP port such as PostgreSQL or Qdrant gRPC:

```bash
python3 - <<'PY'
import socket
for name, port in [('postgres', 30543), ('qdrant-grpc', 30634)]:
    s = socket.socket()
    s.settimeout(3)
    try:
        s.connect(('192.168.112.6', port))
        print(f'{name}: OPEN')
    except Exception as e:
        print(f'{name}: FAIL {e}')
    finally:
        s.close()
PY
```

---

## 3. Open Grafana and find the HOPE dashboards

1. Open `http://192.168.112.6:30300`.
2. Log in with the admin credentials provided by the owner.
3. Click **Dashboards** in the left menu.
4. Open the folder **HOPE**.
5. You should see 9 dashboards:

   - Data-tier Dependencies
   - GPU (DCGM)
   - Infrastructure Overview
   - Kubernetes Workloads & Events
   - Model Residency
   - Node & System Activity
   - Platform (Application Plane)
   - SDK Clients
   - vLLM Inference

If the folder is empty or missing, your account may lack permissions, or you may be on the wrong Grafana instance. Verify the port mapping with step 1.

---

## 4. Query Prometheus from Grafana Explore

1. Click **Explore** in the left menu.
2. Select datasource **Prometheus**.
3. Paste a query and click **Run query**.

Start with these:

```promql
up
```

Shows every scrape target and whether it is up (`1`) or down (`0`).

```promql
count(up == 1)
```

Number of healthy targets.

```promql
up{job="temporal"}
```

Check the Temporal scrape target specifically.

```promql
ALERTS{alertstate="firing"}
```

Currently firing alerts.

```promql
sum(rate(hope_api_http_requests_total[5m]))
```

API request rate.

```promql
histogram_quantile(0.95, sum by (le) (rate(hope_api_http_request_duration_seconds_bucket[5m])))
```

API p95 latency.

If a query returns no data, check:

- time range in Grafana (try last 1 hour or last 24 hours)
- job name spelling
- whether the target is down (`up{job="..."}`)

---

## 5. Query Loki from Grafana Explore

1. Click **Explore**.
2. Select datasource **Loki**.
3. Use the **Builder** or switch to **Code** and paste LogQL.

### 5.1 Basic label selectors

The apps-v2 Loki indexes only four labels:

- `service_name`
- `k8s_namespace_name`
- `k8s_container_name`
- `deployment_environment_name`

Examples:

```logql
{service_name="hope-api"}
```

```logql
{service_name="hope-guardrail"}
```

```logql
{k8s_namespace_name="project-hope-vox-apps-v2"}
```

### 5.2 Structured metadata filters

Fields such as level, pod, request ID, and user ID are **not** indexed labels. Filter them with `|`:

```logql
{service_name="hope-api"} | detected_level="warn"
```

```logql
{service_name="hope-api"} | k8s_pod_name="hope-api-..."
```

```logql
{service_name="hope-api"} | hope_request_id="..."
```

Do not write `{detected_level="error"}` — that will return nothing in the new Loki.

### 5.3 Count logs by service

```logql
sum by (service_name) (
  count_over_time({k8s_namespace_name="project-hope-vox-apps-v2"} [1h])
)
```

Use a 24h window if 1h is empty:

```logql
sum by (service_name) (
  count_over_time({k8s_namespace_name="project-hope-vox-apps-v2"} [24h])
)
```

---

## 6. Check which services have logs

Run this in Loki Explore:

```logql
sum by (service_name) (
  count_over_time({k8s_namespace_name="project-hope-vox-apps-v2"} [24h])
)
```

Expected services include:

`hope-api`, `hope-guardrail`, `hope-harness`, `hope-harness-worker`, `hope-model-publisher`, `hope-nlp`, `hope-stt-v2`, `hope-text`, `hope-tts`, `hope-vllm`, `hope-vllm-asr`, `hope-admin-console`, plus platform services.

If `hope-stt-v2-worker` is zero, check the container directly:

```bash
kubectl -n project-hope-vox-apps-v2 logs deploy/hope-stt-v2-worker --since=24h --tail=20
```

If that is also empty, the application is silent — not Loki.

---

## 7. Add the old infra Loki as a second datasource — CHANGE

Do this only after owner approval.

1. In Grafana, click **Connections → Data sources**.
2. Click **Add new data source**.
3. Choose **Loki**.
4. Name it `Loki (Infra)`.
5. Set URL to:

   ```text
   http://loki.project-hope-vox-infra.svc.cluster.local:3100
   ```

6. Click **Save & test**.
7. In Explore, select `Loki (Infra)`.
8. Remember its label schema is different:

   ```logql
   {namespace="project-hope-vox-infra"}
   ```

   not

   ```logql
   {k8s_namespace_name="project-hope-vox-infra"}
   ```

---

## 8. Create a new dashboard in the HOPE folder — CHANGE

1. Click **Dashboards → New → Dashboard**.
2. Add a panel.
3. Select datasource **Prometheus** or **Loki**.
4. Paste a query from section 4 or 5.
5. Set a useful title, e.g. `Guardrail decisions by outcome`.
6. Click **Apply**.
7. Click **Save**.
8. Choose folder **HOPE**.
9. Use a descriptive name, e.g. `HOPE — Guardrail Decisions & Outbox Health`.

Beginner tip: start by duplicating an existing dashboard and removing panels you do not need. This preserves variables such as `$namespace` and `$gpu`.

---

## 9. Add raw stdout log collection on the GPU node — CHANGE, optional

Only do this if raw traceback coverage is required. It can duplicate logs because GPU services already export OTLP logs.

1. Export the current DaemonSet:

   ```bash
   kubectl -n project-hope-vox-apps-v2 get ds alloy-logs -o yaml > alloy-logs-base.yaml
   cp alloy-logs-base.yaml alloy-logs-gpu.yaml
   ```

2. Edit `alloy-logs-gpu.yaml`:

   - `metadata.name: alloy-logs-gpu`
   - `spec.selector.matchLabels.app: alloy-logs-gpu`
   - `spec.template.metadata.labels.app: alloy-logs-gpu`

3. Replace the `affinity` block with:

   ```yaml
   affinity:
     nodeAffinity:
       requiredDuringSchedulingIgnoredDuringExecution:
         nodeSelectorTerms:
         - matchExpressions:
           - key: node-type
             operator: In
             values:
             - gpu-node
   ```

4. Keep everything else unchanged: same ConfigMap, ServiceAccount, volumes, and OTel endpoint.
5. Apply:

   ```bash
   kubectl apply -f alloy-logs-gpu.yaml
   kubectl -n project-hope-vox-apps-v2 rollout status ds/alloy-logs-gpu
   kubectl -n project-hope-vox-apps-v2 get ds alloy-logs alloy-logs-gpu -o wide
   ```

6. Verify:

   ```bash
   kubectl -n project-hope-vox-apps-v2 logs ds/alloy-logs-gpu --tail=30
   ```

7. Check for duplicates in Loki:

   ```logql
   sum by (service_name) (
     count_over_time({k8s_namespace_name="project-hope-vox-apps-v2"} [1h])
   )
   ```

If lines doubled, disable one of the two paths or add collector deduplication.

---

## 10. Rotate the Grafana admin password — CHANGE

1. Log in to Grafana as admin.
2. Click the profile/avatar icon.
3. Choose **Profile → Change password** (or **Administration → Users → admin**).
4. Enter a new strong password.
5. Log out and log back in to confirm.
6. Update any secret/secret reference that stores the old value.
7. Do not paste the new password into chat or into files under `review/grafana2/`.

---

## 11. File your work

Save command output as you go:

```bash
mkdir -p review/grafana2/procedure-runs
kubectl get pods -A -o wide | tee review/grafana2/procedure-runs/pods.txt
```

Never write passwords, tokens, or raw clinical payloads into these files.
