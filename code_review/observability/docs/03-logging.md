# 03 — Logging (Loki + Promtail)

**Goal:** collect container logs from **every node** with Promtail, store them in
Loki, make them queryable in Grafana, and expose Loki on a LAN-only NodePort so the
**GPU host** can ship its logs too.

**Before you start:** the core stack (`02-core-stack.md`) is running.

Stack pieces:

| Manifest | Object | Role |
|---|---|---|
| `11-loki-config.yaml` | ConfigMap `loki-config` | Loki server config |
| `12-loki.yaml` | StatefulSet + Service `loki` | Log store (ClusterIP only) |
| `13-promtail.yaml` | ServiceAccount + DaemonSet + Service `promtail` | Tails node logs, pushes to Loki |
| `14-loki-nodeport.yaml` | Service `loki-nodeport` | NodePort `31100` for the GPU host |

```bash
source ~/obs.env
cd /path/to/repos/VOX
```

---

## 1. Why this design (understand before deploying)

- **Loki is the store.** Grafana holds no logs. Loki is a single-binary
  ("monolithic") deployment: one pod, filesystem storage on an `nfs-client` PVC.
- **Promtail is the shipper.** A **DaemonSet** runs one Promtail per node; each
  tails the container log files on its own node.
- **Static file glob, not Kubernetes SD.** On this cluster,
  `kubernetes_sd_configs: {role: pod}` yields **zero targets** with Promtail 3.6.11
  (verified). So Promtail uses a proven static path glob
  `/var/log/pods/*/*/*.log` and derives labels from the file path. **No ClusterRole
  is needed** — Promtail only reads files.
- **Labels are minimal on purpose.** High-cardinality labels (request IDs, user
  IDs) destroy Loki performance. We keep: `namespace`, `pod`, `container`, `node`,
  `filename`, `job`, `stream`, `service_name`.
- **NodePort for the GPU box only.** Loki has **no authentication**
  (`auth_enabled: false`). It stays ClusterIP-only for in-cluster use; the GPU host
  (outside the pod network) reaches it via NodePort `31100` on the **node LAN**.

---

## 2. Step 1 — Loki config (`11-loki-config.yaml`)

Key settings (already correct in the file):

- `auth_enabled: false` — single tenant.
- `store: tsdb`, `schema: v13` — current default. (The retired
  `boltdb-shipper` from the old raw stack must **not** be used.)
- `limits_config.retention_period: 720h` (30 days).
- `compactor.retention_enabled: true` — **required** in Loki 3.x for retention to
  actually delete old data.

```bash
kubectl apply -f review/observability/manifests/11-loki-config.yaml
kubectl -n $NS get cm loki-config
```

---

## 3. Step 2 — Loki StatefulSet (`12-loki.yaml`)

- Image `grafana/loki:3.7.8`, replicas `1`, PVC `data-loki-0` (50Gi, `nfs-client`).
- An initContainer `loki-permissions-fix` runs as root and
  `chown -R 10001:10001 /loki` (Loki's uid is 10001). This mirrors the Grafana
  permissions Job and handles the `nfs-client`/`fsGroup` quirk.
- Service `loki` on `:3100` (**ClusterIP only** — deliberately no Ingress).

```bash
kubectl apply -f review/observability/manifests/12-loki.yaml
kubectl -n $NS rollout status sts/loki --timeout=180s
kubectl -n $NS get pods -l app=loki
kubectl -n $NS get pvc data-loki-0        # expect Bound, 50Gi
```

Verify Loki answers:

```bash
kubectl -n $NS port-forward svc/loki 3100:3100 >/tmp/loki-pf.log 2>&1 &
sleep 4
curl -s http://localhost:3100/ready ; echo
curl -s http://localhost:3100/metrics | grep -m1 loki_build_info
```

Expected: `ready`, and a `loki_build_info` line.

> If the Loki pod CrashLoops with `permission denied`, see
> `09-troubleshooting.md` → "Loki cannot write /loki".

---

## 4. Step 3 — Promtail DaemonSet (`13-promtail.yaml`)

The important parts of the embedded config (`promtail-config`):

- **Path glob:** `__path__: /var/log/pods/*/*/*.log`.
- **CRI stage** (`cri: {}`): strips the containerd prefix
  (`<ts> stdout F ...`). **Without it every log line keeps a timestamp prefix.**
- **Regex label extraction** from the filename:

  ```
  /var/log/pods/<namespace>_<pod>_<uid>/<container>/<n>.log
  ```
  → labels `namespace`, `pod`, `container`.

- **`node` label** via the downward API: env `NODE_NAME=spec.nodeName`, expanded by
  `-config.expand-env=true` into the config's `node: ${NODE_NAME}`.
- **Positions on hostPath** `/var/lib/promtail` — must be per-node (never NFS, or
  logs are re-shipped or lost).
- **Control-plane toleration** so the master node is covered too → expect **6/6**
  Promtail pods.

Apply:

```bash
kubectl apply -f review/observability/manifests/13-promtail.yaml
kubectl -n $NS rollout status ds/promtail --timeout=180s
kubectl -n $NS get pods -l app=promtail -o wide
```

Expected: `6/6` Promtail pods, one per node (`master-node-1`, `worker-node-1..5`).

---

## 4b. Optional — restrict to two namespaces (**Option B**)

By default Promtail ships **all** namespaces and you filter in Grafana ("Option
A"). To ship only `project-hope-vox` + `project-hope-vox-infra`, uncomment the
`match`/`drop` stage in the Promtail config inside `13-promtail.yaml`:

```yaml
          # - match:
          #     selector: '{namespace!~"project-hope-vox|project-hope-vox-infra"}'
          #     action: drop
```

then re-apply and restart the DaemonSet:

```bash
kubectl apply -f review/observability/manifests/13-promtail.yaml
kubectl -n $NS rollout restart ds/promtail
```

---

## 5. Step 3 — Loki NodePort (`14-loki-nodeport.yaml`)

**Do not expose Loki publicly.** This NodePort is reachable only on the node LAN
and is used solely by the GPU host's Promtail.

```bash
kubectl apply -f review/observability/manifests/14-loki-nodeport.yaml
kubectl -n $NS get svc loki-nodeport
```

Expected: `loki-nodeport  NodePort  ...  3100:31100/TCP`.

Test it from **inside the cluster** (simulating the GPU host):

```bash
NOW=$(python3 -c 'import time;print(int(time.time()*1e9))')
kubectl -n $NS run lokipush-$RANDOM --rm -i --restart=Never \
  --image=curlimages/curl:8.10.1 --quiet -- sh -c "
    curl -s -o /dev/null -w 'ready=%{http_code}\n' http://$NODE_IP:31100/ready;
    curl -s -o /dev/null -w 'push=%{http_code}\n' -XPOST http://'"$NODE_IP"':31100/loki/api/v1/push \
      -H 'Content-Type: application/json' \
      -d '{\"streams\":[{\"stream\":{\"job\":\"selftest\"},\"values\":[[\"$NOW\",\"hello\"]]}]}'"
```

Expected: `ready=200` and `push=204`. (This proves the GPU host will be able to
push; the actual GPU Promtail is installed in `07-gpu-server.md`.)

> If your nodes use a different port scheme, change `nodePort: 31100` in
> `14-loki-nodeport.yaml` and `LOKI_NODEPORT` accordingly.

---

## 5. Verify logs end-to-end

### 5a. Promtail is tailing and pushing

```bash
kubectl -n $NS port-forward svc/promtail 9080:9080 >/tmp/promtail-pf.log 2>&1 &
sleep 4
curl -s http://localhost:9080/metrics | grep -E '^promtail_(sent_bytes_total|targets_active|dropped_bytes_total)' | head
```

A rising `promtail_sent_bytes_total` and non-zero `targets_active` (the file
targets) indicate it is working. `dropped_bytes_total{reason="ingestion_rate_limited"}`
should stay flat.

### 5b. Loki has logs for both namespaces

```bash
curl -s -G 'http://localhost:3100/loki/api/v1/label/namespace/values' | python3 -m json.tool
```

Expected: includes `project-hope-vox` and `project-hope-vox-infra` (plus others,
under Option A).

Query recent lines:

```bash
curl -s -G 'http://localhost:3100/loki/api/v1/query_range' \
  --data-urlencode 'query={namespace=~"project-hope-vox|project-hope-vox-infra"}' \
  --data-urlencode 'limit=3' --data-urlencode 'since=1h' \
  | python3 -c 'import sys,json;d=json.load(sys.stdin)["data"]["result"];print("streams:",len(d))'
```

### 5c. Grafana sees Loki

Grafana → **Explore** → datasource **Loki** → query
`{namespace=~"project-hope-vox|project-hope-vox-infra"}`. If Explore errors, the
datasource is unreachable — see `09-troubleshooting.md`.

---

## 6. LogQL quick reference (the labels you actually have)

Live label set: `container`, `filename`, `job`, `namespace`, `node`, `pod`,
`stream`, `service_name`. **There is no `app` label.** Crucially,
**`container` equals the application name**:

```
hope-api-gateway  hope-guardrail  hope-harness  hope-harness-worker
hope-nlp  hope-text  hope-tts  hope-admin-console  cloudflared  traefik
```

Application logs are JSON (`{"level":..,"message":..,"timestamp":..}`).

```logql
{namespace="project-hope-vox", container="hope-api-gateway"}
{container=~"hope-.*"} | json | level="error"
{container="hope-tts"} |= "error" | json
{namespace="project-hope-vox-infra", container="prometheus"}
```

---

## 7. Phase checklist

- [ ] `11`–`14` applied.
- [ ] `loki-0` `1/1 Running`; PVC `data-loki-0` Bound.
- [ ] Promtail `6/6` Running (one per node).
- [ ] `curl svc/loki /ready` → `ready`.
- [ ] Loki NodePort self-test: `ready=200`, `push=204`.
- [ ] Loki label API includes both namespaces; queries return streams.
- [ ] Grafana Explore → Loki returns logs.

Next → [`04-metrics-scraping.md`](./04-metrics-scraping.md)
