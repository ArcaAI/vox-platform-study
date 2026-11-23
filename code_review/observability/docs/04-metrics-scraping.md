# 04 — Metrics: node-exporter, kube-state-metrics, cAdvisor, apps, GPU

**Goal:** make Prometheus scrape everything the dashboards need:

1. **Host metrics** for all 6 nodes (`node-exporter` DaemonSet, manifest `15`).
2. **Kubernetes object metrics** (`kube-state-metrics`, already in `kube-system`).
3. **Per-pod container metrics** (cAdvisor, via the kubelet API proxy).
4. **Application metrics** (HOPE services' `/metrics`, endpoint-based discovery).
5. **GPU host metrics** (vLLM `:9000`, STT `:8862`, node-exporter `:9100`).

**Before you start:** Prometheus is running (`02-core-stack.md`). The scrape *jobs*
themselves already live in `manifests/02-prometheus-config.yaml` (applied in step
2 of the core stack) — this document installs the remaining exporter DaemonSet and
explains/verifies each job.

```bash
source ~/obs.env
cd /path/to/repos/VOX
```

---

## 1. The scrape jobs (what `02-prometheus-config.yaml` defines)

| Job name | Type | Target source | Metrics used by |
|---|---|---|---|
| `prometheus` | static | `localhost:9090` | self-health |
| `alertmanager` | static | `alertmanager:9093` | `up` for the down alert |
| `kubernetes-pods` | pod SD (annotations) | pods with `prometheus.io/scrape=true` | generic |
| `node-exporter` | pod SD (label) | our DaemonSet pods `app=node-exporter`, `:9100` | **k8s-infra**, **stt-gpu** |
| `kube-state-metrics` | static | `kube-state-metrics.kube-system.svc:8080` | **k8s-infra** |
| `kubernetes-cadvisor` | node SD + API proxy | `kubernetes.default.svc:443` → `/api/v1/nodes/<node>/proxy/metrics/cadvisor` | **k8s-infra**, per-app CPU/mem |
| `hope-apps` | endpoints SD | HOPE Services in `project-hope-vox` | **app-hope-*** |
| `vllm` | static | `192.168.112.2:9000` | **vllm**, **stt-gpu** |
| `stt-gpu` | static | `192.168.112.2:8862` | **stt-gpu** |
| `node-exporter-gpu` | static | `192.168.112.2:9100` | **stt-gpu** |

> **Config vs running state.** This job list lives in the `prometheus-config`
> ConfigMap, which is rendered onto an emptyDir **on start**. After editing it,
> always:
> ```bash
> kubectl -n $NS rollout restart sts/prometheus
> ```

---

## 1. Step 1 — Deploy the node-exporter DaemonSet (`15-node-exporter.yaml`)

Runs `prom/node-exporter:v1.9.1` on **every** node (tolerations `operator: Exists`
so the control-plane node is included too). It does **not** use `hostNetwork`, so
it does not clash with the legacy `monitoring/node-exporter` that already owns host
port 9100 on the workers.

```bash
kubectl apply -f review/observability/manifests/15-node-exporter.yaml
kubectl -n $NS rollout status ds/node-exporter --timeout=180s
kubectl -n $NS get pods -l app=node-exporter -o wide
```

Expected: **6/6** pods Running (one per node).

Prometheus discovers these pods by label (`app=node-exporter`) in the
`node-exporter` job — **no annotations needed**. Wait ~15s, then confirm targets:

```bash
kubectl -n $NS port-forward svc/prometheus 9090:9090 >/tmp/prom-pf.log 2>&1 &
sleep 4
curl -s 'http://localhost:9090/api/v1/targets?state=active' | python3 -c '
import sys,json
for t in json.load(sys.stdin)["data"]["activeTargets"]:
    j=t["labels"].get("job"); print(f"{j:22} {t[\"health\"]:6} {t[\"scrapeUrl\"]}")' | sort -u
```

Expected (among others): `node-exporter up` ×6, `kube-state-metrics up`.

---

## 2. Step 2 — kube-state-metrics (already present)

No manifest to apply — the cluster already runs KSM in `kube-system`. The
Prometheus job scrapes it at `kube-state-metrics.kube-system.svc:8080`. Verify:

```bash
kubectl -n kube-system get deploy,svc kube-state-metrics
```

Expected: a deployment and a ClusterIP Service on port `8080`. If the Service name
or port differs, edit the `kube-state-metrics` job target in
`02-prometheus-config.yaml` and restart Prometheus.

Provide metrics used by the infra dashboard: `kube_node_info`,
`kube_node_status_condition`, `kube_pod_status_phase`,
`kube_deployment_status_replicas_available`,
`kube_node_status_allocatable` / `_capacity`, `kube_pod_container_status_restarts_total`.

---

## 3. Step 3 — cAdvisor (per-pod CPU/memory) — RBAC already in place

cAdvisor is served by each kubelet; Prometheus reaches it through the API proxy:

```
https://kubernetes.default.svc:443/api/v1/nodes/<node>/proxy/metrics/cadvisor
```

This requires the read-only **`nodes/proxy`** rule already present in
`01-rbac.yaml`. Verify RBAC:

```bash
kubectl get clusterrole project-hope-vox-prometheus -o yaml | grep -A3 nodes/proxy
```

Expected: `resources: ["nodes/proxy"]`, `verbs: ["get"]`.

Metric names to look for: `container_cpu_usage_seconds_total`,
`container_memory_working_set_bytes`, `container_network_*`.

```bash
curl -s -G 'http://localhost:9090/api/v1/query' \
  --data-urlencode 'query=count(container_memory_working_set_bytes)' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["result"])'
```

Expected: a non-zero count.

> **If cAdvisor targets are down** with `403` or `server returned HTTP status 403`
> in Prometheus logs, the `nodes/proxy` RBAC rule is missing — re-apply `01-rbac.yaml`
> and restart Prometheus.

---

## 3. Step 3 — Application metrics (`hope-apps` job)

The HOPE services expose `/metrics`. Prometheus uses **endpoint** service discovery
in namespace `project-hope-vox`, keeping Services matching:

```
hope-(api-gateway|guardrail|harness|harness-worker|nlp|text|tts)-svc
```

Why endpoint SD? Because it uses each pod's **real container port**, which can
differ from the Service port (e.g. the gateway is published on `8866` but the
process listens on `8868`). The `app` label comes from the pod's `app` label.

> **`hope-admin-console` is deliberately excluded** — its `/metrics` returns a
> `307` HTML redirect, not Prometheus metrics. It gets logs only (an app dashboard
> built purely from Loki + cAdvisor). To add it later, either fix its `/metrics`
> or leave it logs-only.

Verify targets and a sample metric:

```bash
curl -s 'http://localhost:9090/api/v1/targets?state=active' | python3 -c '
import sys,json
for t in json.load(sys.stdin)["data"]["activeTargets"]:
    if t["labels"].get("job")=="hope-apps":
        print(t["labels"].get("app"), t["health"], t["scrapeUrl"])'
curl -s -G 'http://localhost:9090/api/v1/query' \
  --data-urlencode 'query=count(api_gateway_http_requests_total)' \
  | python3 -c 'import sys,json;print("metric present:", bool(json.load(sys.stdin)["data"]["result"]))'
```

Expected: one `up` target per app (6 scrapeable apps), and
`metric present: True`.

### Adding a new scrapeable app

1. Set a pod label `app: hope-<name>` on the workload, and ensure `/metrics` is
   plain Prometheus text on the container port.
2. Add its Service name to the `hope-apps` keep-regex in
   `02-prometheus-config.yaml` (e.g. `|hope-newthing-svc`).
3. `kubectl apply -f .../02-prometheus-config.yaml && kubectl -n $NS rollout restart sts/prometheus`.
4. Add a dashboard in `dashboards/generate.py` (see `05-dashboards.md`).

---

## 4. Step 4 — GPU target wiring (metrics side)

The GPU host is **off-cluster**. Its `vLLM` (`:9000`) and `STT` (`:8862`) are wired
into the cluster as selector-less Services with manual Endpoints, and Prometheus
scrapes the host IP **directly** via static jobs.

```bash
# These already exist in the cluster from the GPU integration:
kubectl -n $NS get svc hope-vllm hope-stt 2>/dev/null
kubectl -n $NS get endpoints hope-vllm hope-stt 2>/dev/null
```

Expected: Endpoints pointing at `192.168.112.2:9000` and `:8862`.

Check the three GPU targets after a scrape interval:

```bash
curl -s 'http://localhost:9090/api/v1/targets?state=active' | python3 -c '
import sys,json
for t in json.load(sys.stdin)["data"]["activeTargets"]:
    if t["labels"].get("job") in ("vllm","stt-gpu","node-exporter-gpu"):
        print(f"{t[\"labels\"][\"job\"]:20} {t[\"health\"]:6} {t[\"scrapeUrl\"]}")'
```

Expected: `vllm up`, `stt-gpu up`, and `node-exporter-gpu up` **only after** you
complete `07-gpu-server.md`. Until then, `node-exporter-gpu` is `down` and the alert
`GpuServerNodeExporterDown` may fire — that is expected and clears itself once the
agent is installed.

> **Metric name quirks:** vLLM metric names contain a colon, e.g.
> `vllm:num_requests_running`. Quote them in PromQL:
> `sum(vllm:num_requests_running{job="vllm"})`.

---

## 5. Alert rules (already in `02-prometheus-config.yaml`)

The `prometheus-alert-rules` ConfigMap defines:

| Alert | Fires when |
|---|---|
| `PrometheusTargetDown` | `up == 0` for 5m |
| `GpuServerNodeExporterDown` | GPU host `:9100` down for 10m |
| `GpuServerHighCpu` | GPU host CPU > 90% for 15m |
| `GpuServerHighMemory` | GPU host memory > 90% for 15m |

Confirm the rules loaded (Prometheus UI → Status → Rules, or API):

```bash
curl -s http://localhost:9090/api/v1/rules | python3 -c '
import sys,json
for g in json.load(sys.stdin)["data"]["groups"]:
    print(g["name"]); [print("  -", r["name"]) for r in g["rules"]]'
```

---

## 6. Verify metric coverage (the "do the dashboards have data?" check)

One command per data source the dashboards rely on:

```bash
q(){ printf '%-52s ' "$1"; curl -s -G http://localhost:9090/api/v1/query --data-urlencode "query=$1" \
  | python3 -c 'import sys,json;d=json.load(sys.stdin)["data"]["result"];print("OK" if d else "NO DATA")'; }
q 'count(node_cpu_seconds_total{job="node-exporter"})'
q 'count(kube_node_info)'
q 'count(container_memory_working_set_bytes)'
q 'count(api_gateway_http_requests_total)'
q 'count(vllm:num_requests_running{job="vllm"})'
q 'count(stt_streaming_sessions_active{job="stt-gpu"})'
q 'count(node_memory_MemTotal_bytes{job="node-exporter-gpu"})'
```

Expected: `OK` for all except the last line, which is `NO DATA` until
`07-gpu-server.md` is done.

Stop port-forwards:

```bash
pkill -f 'port-forward' || true
```

---

## 7. Phase checklist

- [ ] `15-node-exporter.yaml` applied; 6/6 node-exporter pods Running.
- [ ] kube-state-metrics reachable; `kube_*` metrics present.
- [ ] cAdvisor targets up; `container_*` metrics present.
- [ ] `hope-apps` targets up (6 apps) + `api_gateway_*` present.
- [ ] GPU `vllm` and `stt-gpu` targets up.
- [ ] Alert rules visible in Prometheus.
- [ ] Config edits followed by `rollout restart sts/prometheus`.

Next → [`05-dashboards.md`](./05-dashboards.md)
