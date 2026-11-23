# 07 — GPU server telemetry (`192.168.112.2`)

**Goal:** get the GPU host's **host CPU/memory** into Prometheus and its **vLLM +
STT container logs** into Loki, so the `stt-gpu` and `vllm` dashboards populate.

**Before you start:** the cluster side is done — the Loki NodePort (`14`) exists and
Prometheus scrapes the GPU targets. You need SSH access to the GPU host.

```bash
source ~/obs.env
cd /path/to/repos/VOX
```

---

## 1. The problem (why the GPU host is special)

- The GPU host is **not a Kubernetes node** and is **outside the pod CIDR**. Its
  containers (`vllm-whisper`, `hope-stt`, `triton`, …) run under plain Docker.
- In-cluster Promtail only sees `/var/log/pods` **on the nodes** — it cannot see the
  GPU host's Docker logs.
- The host has **no node-exporter**, so host CPU/memory are missing.
- Its `vLLM` (`:9000`) and `STT` (`:8862`) are already wired into the cluster as
  selector-less Services with manual Endpoints, and Prometheus scrapes them
  **directly** — so **inference metrics already work**. Only host metrics + logs are
  missing.

We fix both by running two small containers **on the GPU host**, via the bundle in
`gpu-box/`:

| Container | Image | Binds | Fed by |
|---|---|---|---|
| `hope-node-exporter` | `prom/node-exporter:v1.9.1` | host `:9100` | Prometheus job `node-exporter-gpu` |
| `hope-promtail` | `grafana/promtail:3.6.11` | host `:9080` (debug) | pushes to Loki NodePort `31100` |

---

## 2. Prerequisites on the GPU host

Log in and check:

```bash
ssh <you>@192.168.112.2
docker version
docker compose version      # v2+ required
nvidia-smi | head -5        # confirms the GPU/driver (for the optional dcgm step)
```

- **Docker + Compose** must be installed. If `docker compose` is missing, install the
  compose plugin, or use `docker-compose` (v1) and adjust the commands.
- The host must be able to **reach a cluster node's NodePort `31100`** (same LAN):
  ```bash
  curl -s -o /dev/null -w '%{http_code}\n' http://192.168.112.6:31100/ready   # expect 200
  ```
- Port **9100** must be free on the host (`ss -ltnp | grep :9100` should be empty).
- **Clock/NTP** should be synced (Loki rejects far-past timestamps).

---

## 3. If you cannot reach the host directly (SSH bounce)

On many setups the GPU host is only reachable **from inside the cluster network**,
not from your laptop. If `ssh <you>@192.168.112.2` times out, create a temporary
`socat` bounce pod and port-forward through it.

```bash
# 1. Create a tiny pod that forwards TCP to the GPU host's :22
kubectl -n $NS run gpu-bounce --image=alpine/socat:1.8.0.0 --restart=Never \
  --command -- socat TCP-LISTEN:2222,reuseaddr,fork TCP:192.168.112.2:22
kubectl -n $NS wait --for=condition=Ready pod/gpu-bounce --timeout=90s

# 2. Forward local :2223 -> pod :2222 -> GPU :22
kubectl -n $NS port-forward pod/gpu-bounce 2223:2222 >/tmp/pf-bounce.log 2>&1 &
sleep 3

# 3. SSH to the host through the bounce
ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p 2223 <you>@127.0.0.1
```

> **Keep the `port-forward` running in its own terminal** while you work; it dies
> when the shell does. Re-run step 2 if it drops.
>
> **Delete the bounce pod when finished** (it is an unauthenticated TCP proxy to the
> host's SSH; keep the window short):
> ```bash
> kubectl -n $NS delete pod gpu-bounce
> ```
>
> **Auth troubleshooting:** if password auth seems to fail intermittently, retry.
> With `sshpass` use password-only auth explicitly:
> `sshpass -p '<pass>' ssh -o PreferredAuthentications=password -o PubkeyAuthentication=no -p 2223 <you>@127.0.0.1`.

---

## 4. Copy the bundle to the host

From your laptop (direct SSH shown; swap in the bounce flags if needed):

```bash
scp -r review/observability/gpu-box <you>@192.168.112.2:~/gpu-telemetry
```

Or, if you prefer to create files on the host by hand, copy these three:
`docker-compose.yml`, `promtail-gpu.yml` (and optionally
`dcgm-exporter.compose.yml`) into `~/gpu-telemetry` on the host.

---

## 5. Start the telemetry stack

```bash
ssh <you>@192.168.112.2
cd ~/gpu-telemetry
LOKI_URL=http://192.168.112.6:31100 docker compose up -d
docker ps --format 'table {{.Names}}\t{{.Status}}' | grep hope-
```

Expected: `hope-node-exporter` and `hope-promtail` `Up`.

> `LOKI_URL` = **any** node IP + the Loki NodePort. The compose file defaults to
> `http://192.168.112.6:31100` if you omit it.

Both containers use `restart: unless-stopped`, so they **survive host reboots**.

---

## 6. Verify from both sides

### On the GPU host

```bash
curl -s -o /dev/null -w 'node-exporter=%{http_code}\n' http://localhost:9100/metrics
docker logs hope-promtail 2>&1 | tail -5
```

Expected: `node-exporter=200`; Promtail logs show no `level=error` (see the gotcha
in §8 about stale-log backfill).

### From the cluster

```bash
pkill -f 'port-forward' || true
kubectl -n $NS port-forward svc/prometheus 9090:9090 >/tmp/prom-pf.log 2>&1 &
sleep 5
curl -s 'http://localhost:9090/api/v1/targets?state=active' | python3 -c '
import sys,json
for t in json.load(sys.stdin)["data"]["activeTargets"]:
    if t["labels"].get("job") in ("node-exporter-gpu","vllm","stt-gpu"):
        print(f"{t[\"labels\"][\"job\"]:20} {t[\"health\"]:6} {t[\"scrapeUrl\"]}")'
```

Expected: all three `up`.

Host metrics present:

```bash
curl -s -G http://localhost:9090/api/v1/query \
  --data-urlencode 'query=100*(1-node_memory_MemAvailable_bytes{job="node-exporter-gpu"}/node_memory_MemTotal_bytes{job="node-exporter-gpu"})' \
  | python3 -c 'import sys,json;print("GPU host mem %:",json.load(sys.stdin)["data"]["result"])'
```

### GPU logs in Loki

```bash
kubectl -n $NS port-forward svc/loki 3100:3100 >/tmp/loki-pf.log 2>&1 &
sleep 4
for j in vllm stt; do
  curl -s -G 'http://localhost:3100/loki/api/v1/query_range' \
    --data-urlencode "query={host=\"gpu-server\",job=\"$j\"}" \
    --data-urlencode 'limit=3' --data-urlencode 'since=1h' \
    | python3 -c 'import sys,json;d=json.load(sys.stdin)["data"]["result"];print("job='"$j"' streams:",len(d))'
done
pkill -f 'port-forward' || true
```

Expected: each `job` has ≥1 stream once the containers log (vLLM logs each
Prometheus `/metrics` scrape, so lines appear within ~15s).

Also confirm the Prometheus target flipped up (the down alert self-clears):

```bash
# after the GPU agent is up, GpuServerNodeExporterDown should go inactive
```

---

## 7. How `promtail-gpu.yml` works

- **Discovery:** `docker_sd_configs` with `host: unix:///var/run/docker.sock`.
- **Keep filter:** only containers whose name matches
  `vllm|whisper|stt|tts|triton|embed|inference`.
- **Job mapping** (order matters — see the gotcha in §8):
  - `stt` ← names containing `stt|tts|triton|embed|inference`
  - `vllm` → **last** rule, matches `vllm|whisper`, so `vllm-whisper` → `job=vllm`
- **Labels added:** `container`, `stream`, `host=gpu-server`, plus `job`.
- **Pipeline:** parse the Docker JSON log line, set the entry timestamp, output the
  `log` field, and **drop entries older than 6h** to avoid backfilling history.

Target queries used by the dashboards: `{job="vllm"}` and `{job="stt"}` (also
`{host="gpu-server"}`).

---

## 7. Optional — hardware GPU metrics (DCGM)

Software-side GPU metrics already come from vLLM (`vllm:kv_cache_usage_perc`,
etc.). For raw GPU utilisation/memory/temperature/power, add DCGM:

```bash
cd ~/gpu-telemetry
docker compose -f dcgm-exporter.compose.yml up -d
# then add a Prometheus job (02-prometheus-config.yaml) and restart Prometheus:
#   - job_name: 'dcgm-gpu'
#     static_configs:
#       - targets: ['192.168.112.2:9400']
#         labels: { host: gpu-server, environment: gpu }
```

Requires the NVIDIA driver + nvidia Docker runtime on the host.

---

## 8. Known gotchas (read these — they are the mistakes people actually hit)

1. **Stale-log backfill → Loki 400s.** On first start Promtail reads existing
   Docker log files from offset 0. If the containers have days of history, Loki
   rejects out-of-window samples (`400 ... timestamp too old`) and Promtail logs
   `final error sending batch`. The bundle already prevents this by dropping entries
   `older_than: 6h`. If you still see a brief burst at startup, it drains and stops.
2. **`vllm-whisper` mislabeled as `stt`.** The container name matches both `vllm`
   and `whisper`. In the bundle the **vllm rule runs last** so it wins. If you write
   your own relabel rules, keep that order or vLLM logs land under `job=stt`.
3. **Config changes need a container restart.** `promtail-gpu.yml` is a **mounted
   file**; `docker compose up -d` will **not** reload it if only the file content
   changed (the service definition is unchanged). Use:
   ```bash
   docker restart hope-promtail
   ```
4. **Container names differ?** Edit the `keep`/mapping regexes in
   `promtail-gpu.yml`. Inspect what Promtail discovered:
   `docker logs hope-promtail | grep -i target`.
5. **Non-Docker services (systemd).** If vLLM/STT run as systemd binaries instead of
   Docker, replace the `docker_sd_configs` block with file scrapes:
   ```yaml
   scrape_configs:
     - job_name: vllm
       static_configs:
         - targets: [localhost]
           labels: { job: vllm, host: gpu-server, __path__: /var/log/vllm/*.log }
     - job_name: stt
       static_configs:
         - targets: [localhost]
           labels: { job: stt, host: gpu-server, __path__: /var/log/stt/*.log }
   ```
6. **NodePort not reachable from the host.** Check the host is on the node LAN and
   `curl http://<node-ip>:31100/ready` returns 200. If `31100` is taken, change it
   in `14-loki-nodeport.yaml` **and** in the `LOKI_URL`.
7. **Port 9100 already in use on the host.** Stop whatever owns it, or change the
   node-exporter listen address in `docker-compose.yml` and the Prometheus
   `node-exporter-gpu` target.

---

## 9. Phase checklist

- [ ] `docker`/`docker compose` work on the GPU host.
- [ ] GPU host can reach `http://<node-ip>:31100/ready` (200).
- [ ] `gpu-box` copied; `docker compose up -d` started both containers.
- [ ] `node-exporter=200` locally; `node-exporter-gpu` target `up`.
- [ ] `vllm` and `stt-gpu` targets `up` (already were).
- [ ] Loki shows `{job="vllm"}` and `{job="stt"}` lines with recent timestamps.
- [ ] `stt-gpu` dashboard CPU/memory panels populate; `vllm` dashboard log panels populate.
- [ ] Bounce pod deleted (if used).

Next → [`08-verification.md`](./08-verification.md)
