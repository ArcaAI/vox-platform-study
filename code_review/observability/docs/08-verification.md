# 08 — End-to-end verification

Run this when you believe the stack is complete. Each section is independent; a
failure points to the document that fixes it.

```bash
source ~/obs.env
cd /path/to/repos/VOX

# open local tunnels for the checks
kubectl -n $NS port-forward svc/prometheus 9090:9090 >/tmp/pf-prom.log 2>&1 &
kubectl -n $NS port-forward svc/loki      3100:3100 >/tmp/pf-loki.log 2>&1 &
kubectl -n $NS port-forward svc/grafana   3000:3000 >/tmp/pf-graf.log 2>&1 &
sleep 5
```

A reusable helper:

```bash
PROM=http://localhost:9090
LOKI=http://localhost:3100
ask(){ printf '%-56s ' "$1"; curl -s -G "$PROM/api/v1/query" --data-urlencode "query=$1" \
  | python3 -c 'import sys,json;d=json.load(sys.stdin)["data"]["result"];print("OK" if d else "NO DATA")'; }
```

---

## 1. Workloads are running

```bash
kubectl -n $NS get pods
```

Expect (all `Running`/`Completed`):
`alertmanager-0`, `grafana-*`, `prometheus-0`, `loki-0`,
`node-exporter-*` ×6, `promtail-*` ×6, `grafana-permissions-fix` (Completed).

```bash
kubectl -n $NS get pvc
```

Expect `Bound`: `data-prometheus-0` (50Gi), `data-alertmanager-0` (10Gi),
`data-loki-0` (50Gi), `grafana-data` (10Gi).

```bash
kubectl -n $NS get svc
```

Expect: `prometheus:9090`, `alertmanager:9093`, `grafana:3000`, `loki:3100`,
`loki-nodeport` (NodePort 31100), `promtail:9080`.

---

## 2. Prometheus targets

```bash
curl -s "$PROM/api/v1/targets?state=active" | python3 -c '
import sys,json
ts=json.load(sys.stdin)["data"]["activeTargets"]
from collections import Counter
c=Counter((t["labels"].get("job"),t["health"]) for t in ts)
for (job,h),n in sorted(c.items()): print(f"  {job:22} {h:6} x{n}")'
```

Expect (health `up`):
`prometheus`, `alertmanager`, `kube-state-metrics`, `node-exporter` ×6,
`kubernetes-cadvisor` ×6, `hope-apps` ×6, `vllm`, `stt-gpu`, `node-exporter-gpu`.

Anything `down` → `09-troubleshooting.md`.

---

## 3. Metric coverage (one per dashboard data source)

```bash
ask 'count(node_cpu_seconds_total{job="node-exporter"})'
ask 'count(node_memory_MemTotal_bytes{job="node-exporter"})'
ask 'count(kube_node_info)'
ask 'count(kube_pod_status_phase)'
ask 'count(container_memory_working_set_bytes)'
ask 'count(container_cpu_usage_seconds_total)'
ask 'count(api_gateway_http_requests_total)'
ask 'count(tts_requests_total{job="hope-apps"})'
ask 'count(text_generation_total{job="hope-apps"})'
ask 'count(vllm:num_requests_running{job="vllm"})'
ask 'count(stt_streaming_sessions_active{job="stt-gpu"})'
ask 'count(node_memory_MemTotal_bytes{job="node-exporter-gpu"})'
```

All should be `OK`. The last line requires `07-gpu-server.md`; if it is
`NO DATA`, the GPU agent isn't installed/running.

---

## 4. GPU host (only if installed)

```bash
ask 'round(100*(1-avg(rate(node_cpu_seconds_total{job="node-exporter-gpu",mode="idle"}[5m]))),2)'
ask 'round(100*(1-node_memory_MemAvailable_bytes{job="node-exporter-gpu"}/node_memory_MemTotal_bytes{job="node-exporter-gpu"}),2)'
ask 'count(vllm:kv_cache_usage_perc{job="vllm"})'
```

Expect: CPU %, memory %, and a KV-cache series. (CPU may legitimately read `0` when
idle.)

---

## 5. Loki ingestion

```bash
# Namespaces present
curl -s -G "$LOKI/loki/api/v1/label/namespace/values" | python3 -m json.tool | grep -E 'project-hope'

# Recent lines for the app namespace
curl -s -G "$LOKI/loki/api/v1/query_range" \
  --data-urlencode 'query={namespace=~"project-hope-vox|project-hope-vox-infra"}' \
  --data-urlencode 'limit=5' --data-urlencode 'since=1h' \
  | python3 -c 'import sys,json;r=json.load(sys.stdin)["data"]["result"];print("streams:",len(r))'

# GPU logs (only if installed)
curl -s -G "$LOKI/api/v1/query_range" --data-urlencode 'query={host="gpu-server"}' \
  --data-urlencode 'limit=3' --data-urlencode 'since=1h' \
  | python3 -c 'import sys,json;r=json.load(sys.stdin)["data"]["result"];print("gpu streams:",len(r))'
```

---

## 5. Grafana datasources + dashboards

```bash
PW=$(kubectl -n $NS get secret grafana-admin -o jsonpath='{.data.GF_SECURITY_ADMIN_PASSWORD}' | base64 -d)

# health
curl -s http://localhost:3000/api/health

# datasources: expect Prometheus (default) + Loki, both with ok state in the UI
curl -s -u admin:"$PW" http://localhost:3000/api/datasources | python3 -c '
import sys,json
for d in json.load(sys.stdin): print("  ds:", d["name"], d["type"], d["uid"])'

# dashboards: expect 13
curl -s -u admin:"$PW" 'http://localhost:3000/api/search?type=dash-db' | python3 -c '
import sys,json;print("  dashboards:",len(json.load(sys.stdin)))'
```

Datasource proxy health (proves Grafana can reach each backend):

```bash
curl -s -u admin:"$PW" http://localhost:3000/api/datasources/uid/prometheus/health
curl -s -u admin:"$PW" http://localhost:3000/api/datasources/uid/loki/health
```

Expected: both report a 200/healthy result.

---

## 6. Alerting

```bash
curl -s "$PROM/api/v1/rules" | python3 -c '
import sys,json
for g in json.load(sys.stdin)["data"]["groups"]:
    for r in g["rules"]:
        if r.get("type")=="alerting":
            print(f"  {r[\"name\"]:32} {r.get(\"state\",\"?\")}")'
```

Expected: the 4+ rules present, mostly `inactive` on a healthy system
(`GpuServerNodeExporterDown` is `inactive` once the GPU agent is installed).

Alertmanager is reachable from Prometheus (a target in §2) and its UI loads at
`http://localhost:9093`:

```bash
kubectl -n $NS port-forward svc/alertmanager 9093:9093 >/tmp/pf-am.log 2>&1 &
sleep 3
curl -s http://localhost:9093/-/ready   # expect: Alertmanager is Ready
```

---

## 7. Public hostnames (if published)

```bash
curl -sI https://grafana-vox2.arcaai.com/api/health | head -1
```

Expected: `HTTP/2 200`. (See `06-ingress-dns-cloudflare.md` for the other two.)

---

## 8. Loki NodePort (GPU shipper path)

```bash
curl -s -o /dev/null -w 'loki nodeport ready=%{http_code}\n' http://$NODE_IP:$LOKI_NODEPORT/ready
```

Expected: `200` (from the node LAN). Not reachable from outside the LAN by design.

---

## 9. Optional quick dashboard smoke test via API

For one representative query per dashboard, confirm each returns data:

```bash
ask 'sum(kube_pod_status_phase{phase="Running"})'                                   # k8s-infra
ask 'stt_streaming_sessions_active{job="stt-gpu"}'                                  # stt-gpu
ask 'sum(vllm:num_requests_running{job="vllm"})'                                    # vllm
ask 'sum(rate(api_gateway_http_requests_total[5m]))'                                # api-gateway
ask 'sum(rate(tts_requests_total{job="hope-apps"}[5m]))'                            # tts
ask 'sum(rate(text_generation_total{job="hope-apps"}[5m]))'                         # text
ask 'sum(rate(http_requests_total{job="hope-apps", app="hope-nlp"}[5m]))'           # nlp
```

Some rate queries legitimately return `NO DATA` when the app is idle (no traffic).
A `NO DATA` here for an idle app is fine; check the corresponding log panel instead.

---

## Cleanup

```bash
pkill -f 'port-forward' || true
```

If you used the SSH bounce: `kubectl -n $NS delete pod gpu-bounce`.

---

## Final sign-off

- [ ] All pods Running; all PVCs Bound.
- [ ] All Prometheus targets `up`.
- [ ] Metric coverage `OK` for all sources (GPU last line only if installed).
- [ ] Loki returns logs for both namespaces (+ GPU host if installed).
- [ ] Grafana: 2 datasources healthy, 13 dashboards.
- [ ] Alert rules loaded.
- [ ] Public Grafana reachable (if published); Prometheus/Alertmanager protected or unpublished.
- [ ] Loki not publicly exposed.
