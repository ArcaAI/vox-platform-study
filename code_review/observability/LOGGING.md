# Log aggregation for `project-hope-vox` & `project-hope-vox-infra`

**Goal:** make Grafana (already in `project-hope-vox-infra`) able to **query container
logs** for every application in `project-hope-vox` and `project-hope-vox-infra`.

**Status:** **implemented and applied.** Loki + Promtail run in
`project-hope-vox-infra` and Grafana has the Loki datasource. Images pinned:
`grafana/loki:3.7.8`, `grafana/promtail:3.6.11`, `busybox:1.36.1`. Where the original
plan differed from what actually worked, the notes below reflect the **implemented**
version — most importantly Promtail uses a **static glob**, not service discovery
(§4.4, §12).

---

## 0. TL;DR — the decision

- **Yes, Loki is required.** Grafana is only a UI/datasource proxy; it stores **no**
  logs, and there is **no log store** anywhere in the two namespaces today. Without
  Loki the requirement cannot be met. (Verified on the live cluster, §1.)
- **Loki goes in `project-hope-vox-infra`** (same namespace as Grafana), as a
  single-binary "monolithic" StatefulSet with filesystem storage on the existing
  `nfs-client` StorageClass. No gateway, no S3, no microservices split.
- **A collector DaemonSet** ships pod logs from every node into Loki. First cut:
  **Promtail** (simplest, config already proven in the old raw stack). Loki 3.x has
  deprecated Promtail in favour of **Grafana Alloy** — see the decision in §4.2.
- **Grafana** gains a **Loki datasource**, added to the existing
  `grafana-provisioning` ConfigMap (`06-grafana-provisioning.yaml`).
- Loki stays **ClusterIP only** (no Ingress). Grafana reaches it in-cluster;
  operators reach Loki with `kubectl port-forward`. If you ever expose it, put
  **Cloudflare Access** in front (Loki has no auth).

---

## 1. Current state (verified on the live cluster)

| Thing | State |
|---|---|
| Grafana | `project-hope-vox-infra`, `deploy/grafana` 13.1.2, 1/1. Datasources: **Prometheus + Loki**. |
| Loki / Promtail | **Running** in `project-hope-vox-infra` (this doc). Alloy / Fluent*: absent. |
| Unrelated logging elsewhere | `arcafabric` (logstash, vector), `supabase*` (vector) — **not** ours, not reused. |
| StorageClass | `nfs-client` (default, `Delete` reclaim). |
| Nodes | 6 (`master-node-1` + `worker-node-1..5`), kubeadm v1.29, containerd. |
| IngressClass | `traefik` (default). TLS terminates at Cloudflare. |

Workloads whose logs we want:

| Namespace | Workloads |
|---|---|
| `project-hope-vox` | `hope-admin-console`, `hope-api-gateway`, `hope-guardrail`, `hope-harness`, `hope-harness-worker`, `hope-nlp`, `hope-text`, `hope-tts`, plus `cloudflared`, `traefik` |
| `project-hope-vox-infra` | `grafana`, `temporal`, `temporal-ui`, `vault-store`; `sts/alertmanager`, `prometheus`, `postgres-pgvector-db`, `qdrant-store`, `redis-store`, `silo-object-store` |

---

## 2. Why Loki (and why this shape)

- **Grafana can't store logs.** It needs a backing log store it can speak to; Loki is
  the Grafana-native one and the Grafana image already ships the Loki datasource type.
- **Label-based, low cost.** Loki indexes labels (namespace/pod/container), not full
  text — far cheaper than ELK for "show me the logs of pod X".
- **We already run Grafana + Alertmanager here**, so Loki's ruler can later reuse
  `alertmanager:9093`, and Grafana gives LogQL browsing with zero extra UI.
- **Not** ELK/OpenSearch: heavier, duplicates the (unrelated) logstash/vector stacks,
  and isn't needed for this requirement.

---

## 3. Architecture

```
   each node                          project-hope-vox-infra
 ┌───────────────┐                   ┌──────────────────────────┐
 │ containers    │                   │  Grafana (deploy)        │
 │  stdout/stderr│                   │   ├─ datasource: Prometheus
 │      │        │                   │   └─ datasource: Loki  ──┐
 │      ▼        │                   │                          │ LogQL
 │ /var/log/pods │◀── hostPath ──┐   │  Loki (sts, :3100) ◀─────┘  (ClusterIP)
 └───────────────┘               │   │    └─ PVC loki-data (nfs, /loki)
                                 │   └──────────────────────────┘
   DaemonSet: promtail  ──push──▶ http://loki:3100/loki/api/v1/push
   (one pod per node, tolerates control-plane)
```

Data path: container → containerd writes CRI log files under `/var/log/pods/...` →
Promtail (per node, hostPath) tails them, parses the CRI format, attaches labels →
HTTP push to `loki` → Loki stores chunks+index on its PVC → Grafana queries via LogQL.

---

## 4. Components

### 4.1 Loki (StatefulSet, `project-hope-vox-infra`)

- **Image:** `grafana/loki:3.7.8` (the raw stack used the long-EOL `2.9.2` — do
  **not** reuse it).
- **Mode:** single binary, `-config.file=/etc/loki/loki.yml`, `replicas: 1`.
- **Storage:** PVC `data-loki-0` (`volumeClaimTemplates`) on `nfs-client`. Raw stack
  asked for **100Gi**; started at **50Gi** — see §6.
- **Index schema:** `tsdb` + `schema: v13` (current default). The raw config used the
  retired `boltdb-shipper`; use `tsdb`.
- **Retention:** `limits_config.retention_period` + **compactor with
  `retention_enabled: true`** (retention only works via the compactor in 3.x).
- **Ports:** `http 3100` (`/ready` for probes), `grpc 9096`.
- **Service:** `loki` ClusterIP:3100 — this is the name Grafana and Promtail use.
- `auth_enabled: false` → single tenant. Fine for a private cluster.

### 4.2 Collector — Promtail vs Alloy (decision)

| | Promtail | Grafana Alloy |
|---|---|---|
| Status | **maintenance/EOL** for Loki 3.x, still functional | current, the recommended successor |
| Config | simple scrape_configs (proven in our raw stack) | River/alloy config (more to learn) |
| Fit here | least moving parts for a first cut | better long-term |

**Chosen:** **Promtail 3.6.11** — a DaemonSet on all 6 nodes with a control-plane
toleration, reading `/var/log/pods` and `/var/log` via hostPath, pushing to
`http://loki:3100/loki/api/v1/push`. Alloy remains the migration target.

### 4.3 Grafana datasource

Edit `manifest/06-grafana-provisioning.yaml` → append to `datasources.yaml`:

```yaml
      - name: Loki
        type: loki
        access: proxy
        url: http://loki:3100
        uid: loki
        editable: false
        jsonData:
          maxLines: 1000
```

Re-apply the ConfigMap and restart Grafana (`deploy/grafana` re-reads provisioning on
boot). No new volume/mount is needed — 09-grafana.yaml already mounts the provisioning
ConfigMap.

### 4.4 RBAC — none needed (static glob)

The implemented Promtail uses a **static `__path__` glob**
(`/var/log/pods/*/*/*.log`) and reads the files directly, so it needs **no** API
access and therefore **no ClusterRole / ClusterRoleBinding** — only the
`ServiceAccount promtail`. (Service discovery + a de-collided ClusterRole were in
the original plan; both were dropped — see §12 for why.)

---

## 5. Namespace scoping (only the two namespaces?)

Two options; pick one:

- **A — collect everything, filter in Grafana (recommended).** Promtail ships all pod
  logs with a `namespace` label; dashboards/queries constrain to `project-hope-vox`
  and `project-hope-vox-infra`. Simplest, and you get `kube-system`/troubleshooting
  logs for free.
- **B — restrict at the collector.** Add a `match`/`drop` stage (a static config has
  no k8s meta labels to relabel) after the `labels` stage:

  ```yaml
  pipeline_stages:
    - match:
        selector: '{namespace!~"project-hope-vox|project-hope-vox-infra"}'
        action: drop
  ```

  Lower volume/disk, but you can't troubleshoot the rest of the cluster.

**Default to A.** Disk, not CPU, is the constraint (NFS).

---

## 6. Storage & retention

- Loki compresses chunks (~10–20×). Rough guide: a few hundred MB/day for these two
  namespaces at INFO level → **50Gi ≈ several weeks**. Start 50Gi, monitor
  `loki_distributor_bytes_received_total`.
- `retention_period: 720h` (**30 days**) in `limits_config`, enforced by the
  **compactor**. Shorten to `168h` (7d) if disk is tight.
- `replication_factor: 1` and `inmemory` ring — correct for a single binary.
- **PVC name:** `data-loki-0` (`volumeClaimTemplates` with `serviceName: loki`).
  Confirmed no collision with the namespace's existing `data-*` PVCs.

---

## 7. Security

- **Loki has no authentication** (`auth_enabled: false`). Keep it **ClusterIP-only**.
  Do **not** add an Ingress. If remote access is ever required, front it with
  **Cloudflare Access** (as recommended for Prometheus/Alertmanager).
- Promtail pushes over plain HTTP **inside the cluster** — acceptable (same trust
  boundary as Prometheus scraping). The Cloudflare edge is not involved.
- No secrets needed for the first cut. If you later enable multi-tenancy or a
  gateway, add `X-Scope-OrgID` handling then.

---

## 8. Proposed files (to add to `manifests/`)

| File | Contents | Status |
|---|---|---|
| `11-loki-config.yaml` | ConfigMap `loki-config` (tsdb/v13, 720h retention, compactor, ruler→alertmanager). | applied |
| `12-loki.yaml` | StatefulSet `loki` (uid 10001, build-verified `grafana/loki:3.7.8`, root chown initContainer, `fsGroup: 10001`) + Service `loki` (ClusterIP:3100); PVC `data-loki-0` via `volumeClaimTemplates`. | applied |
| `13-promtail.yaml` | ConfigMap `promtail-config` (static glob + `source: filename` regex) + SA `promtail` + DaemonSet `promtail` (NODE_NAME via downward API) + Service `promtail`. **No RBAC.** | applied |
| edit `06-grafana-provisioning.yaml` | Append the Loki datasource (§4.3). | applied |

Apply order after the existing 01–10: `11 → 12 → 13`, then re-apply `06` + restart Grafana.
(Both configs were pre-validated by actually booting the containers against them.)

---

## 9. Rollout

```bash
cd review/observability
kubectl apply -f manifests/11-loki-config.yaml
kubectl apply -f manifests/12-loki.yaml
kubectl apply -f manifests/13-promtail.yaml
# add Loki datasource, then:
kubectl apply -f manifests/06-grafana-provisioning.yaml
kubectl -n project-hope-vox-infra rollout restart deploy/grafana
kubectl -n project-hope-vox-infra rollout status deploy/grafana
kubectl -n project-hope-vox-infra rollout status sts/loki
kubectl -n project-hope-vox-infra rollout status ds/promtail
```

---

## 10. Verify

```bash
# Loki is up and ready
kubectl -n project-hope-vox-infra exec sts/loki -- wget -qO- localhost:3100/ready

# Promtail sees targets and is pushing (per node)
kubectl -n project-hope-vox-infra get ds promtail            # DESIRED/READY == 6
kubectl -n project-hope-vox-infra logs ds/promtail --tail=20 | grep -i 'level=error' || echo "no errors"
kubectl -n project-hope-vox-infra port-forward svc/promtail 9080:9080
#   open http://localhost:9080/targets

# Loki has samples for our namespaces (LogQL over the HTTP API)
kubectl -n project-hope-vox-infra port-forward svc/loki 3100:3100 &
curl -s -G http://localhost:3100/loki/api/v1/query_range \
  --data-urlencode 'query={namespace="project-hope-vox"}' --data-urlencode 'limit=5' | head

# Through Grafana: Explore → datasource "Loki" → query
#   {namespace=~"project-hope-vox|project-hope-vox-infra"}
```

---

## 11. Rollback

```bash
kubectl -n project-hope-vox-infra delete ds/promtail
kubectl -n project-hope-vox-infra delete sts/loki
kubectl -n project-hope-vox-infra delete pvc data-loki-0   # wipes logs (Retain policy)
kubectl -n project-hope-vox-infra delete cm loki-config promtail-config
# revert 06-grafana-provisioning.yaml (remove Loki ds) and restart grafana
```

---

## 12. Caveats

- **NFS permissions (most likely first-apply snag).** Loki runs as uid **10001**;
  `nfs-client` often ignores `fsGroup`. If Loki CrashLoops on `permission denied`
  under `/loki`, set `securityContext.runAsUser: 0` for the Loki container (same
  fallback used for Grafana uid 472 / Prometheus uid 65534 in the README §8).
- **Control-plane tainting.** The DaemonSet needs the
  `node-role.kubernetes.io/control-plane` toleration (present in the raw manifest) to
  also collect `master-node-1` logs. Without it you'll see 5/6 pods.
- **CRI log format.** containerd writes CRI logs (`2026-... stdout F ...`). Promtail
  **must** keep the `cri: {}` pipeline stage or every line starts with a timestamp
  prefix.
- **Service discovery did not work on this cluster (hence the static glob).**
  `kubernetes_sd_configs: {role: pod}` started its provider but yielded **zero**
  targets — `promtail_targets_active_total` stayed `0` and there were no target
  updates even at `-log.level=debug`, so nothing shipped. The static `__path__` glob
  (`/var/log/pods/*/*/*.log`) is the config proven to work here: labels come from a
  `regex` stage with `source: filename`, and `node` from the downward API
  (`NODE_NAME`) + `-config.expand-env=true`. Revisit when migrating to Alloy.
- **`positions` file** must be on a per-node hostPath (`/var/lib/promtail`); putting it
  on NFS or a shared volume causes re-shipping or lost position.
- **Promtail EOL.** Plan the Alloy migration; Promtail still works with Loki 3.x today.
- **High-cardinality labels kill Loki.** Keep labels to namespace/pod/container/app/node.
  Never label by request-id, user-id, or free text.

---

## 13. Decisions (resolved)

1. **Collector:** **Promtail 3.6.11** ✅ (implemented; Alloy is the future migration).
2. **Scope:** **A** ✅ — collect all namespaces, filter in Grafana (§5).
3. **Retention & size:** **30 days / 50Gi** ✅ — adjust per disk budget (§6).
4. **Expose Loki UI/API?** **No** ✅ — ClusterIP only (§7).
5. **Dashboards:** ✅ — a starter **"Logs — project-hope-vox"** dashboard
   (`uid: logs-overview`, 4 panels: matching-lines stat, error-ish stat, volume-by-namespace
   timeseries, logs panel; `$namespace` + `$search` variables) was added to
   `07-grafana-dashboards.yaml` and is provisioned.
6. **Per-app + infra dashboards:** ✅ — 13 dashboards total, generated by
   `dashboards/generate.py` (§14.2).
7. **GPU-box logs:** ✅ shipped over the Loki **NodePort 31100** (§14.4); install
   script lives in `gpu-box/`.

---

## 14. Extensions (apps, nodes, GPU box)

Everything below was added on top of the original Loki plan.

### 14.1 Live label set — use `container`, not `app`

Loki labels on this cluster: `container, filename, job, namespace, node, pod,
service_name, stream`. There is **no `app` label**; **`container` equals the
application name** (`hope-api-gateway`, `hope-guardrail`, `hope-nlp`, `hope-text`,
`hope-tts`, `hope-harness`, `hope-harness-worker`, `hope-admin-console`,
`cloudflared`, `traefik`). App logs are JSON (`{level,message,timestamp}`).

Examples:

```logql
{namespace="project-hope-vox", container="hope-api-gateway"}
{container=~"hope-.*"} | json | level="error"
{container="hope-tts"} |= "error" | json
```

### 14.2 Dashboards (`07-grafana-dashboards.yaml`)

`dashboards/generate.py` writes all 13 dashboards into the `grafana-dashboards`
ConfigMap:

| uid | Purpose |
|---|---|
| `k8s-infra` | Cluster/node CPU, mem, pod phase, per-pod usage. |
| `stt-gpu` | STT latency/RTF/sessions/queue + **GPU host CPU & memory** (`job="node-exporter-gpu"`). |
| `vllm` | Throughput, TTFT, inter-token latency, KV-cache, queue depth + vLLM logs. |
| `app-hope-*` (×7) | Per-app HTTP rate/latency/errors, inference latencies, and its logs. |
| `prometheus-overview`, `logs-overview` | Passthrough/kept from the original set. |

> **Grafana 13 caveat:** file provisioning loads **only at startup** and a mounted
> ConfigMap does not hot-reload into the pod reliably — after applying `07`,
> `kubectl -n project-hope-vox-infra rollout restart deploy/grafana`.

### 14.3 Host metrics for the cluster

`15-node-exporter.yaml` runs `prom/node-exporter:v1.9.1` on all 6 nodes. It
deliberately **does not use `hostNetwork`** so it does not collide with the legacy
`monitoring/node-exporter` on `:9100` (that one covers only 5 workers). Prometheus
also scrapes `kube-state-metrics` and cAdvisor (`nodes/proxy`, RBAC in `01-rbac.yaml`).

### 14.4 GPU box shipper (`192.168.112.2`)

The box is on the node LAN but **outside the pod CIDR** — `kubectl`/promtail in-cluster
can't see its `/var/lib/docker` logs, and it has no node-exporter. It only exposes
`stt` (`:8862`) and `vllm` (`:9000`), both already scraped by Prometheus via manual
Endpoints. For logs + host CPU/mem, run the bundle on the box:

```bash
# on 192.168.112.2
LOKI_URL=http://192.168.112.6:31100 docker compose -f gpu-box/docker-compose.yml up -d
```

- `promtail-gpu.yml` uses `docker_sd_configs`, keeps `vllm|whisper|stt|tts|triton|embed|inference`
  containers, maps them to `job=vllm` / `job=stt`, and pushes to `${LOKI_URL}/loki/api/v1/push`.
- Loki is reachable at NodePort **31100** (`14-loki-nodeport.yaml`), LAN-only, **no auth**
  — acceptable only because the node LAN is trusted; do not expose it beyond the LAN.
- Verified: `GET /ready` → 200 and `POST /loki/api/v1/push` → 204 from inside the cluster
  against `192.168.112.6:31100`.

**Installed** on `192.168.112.2` at `/root/gpu-telemetry/` (`docker compose up -d`,
`restart: unless-stopped`, survives reboot). Verified live: `node-exporter-gpu` target
**UP**, box `:9100` → 200, and `{host="gpu-server",job="vllm"}` /
`{host="gpu-server",job="stt"}` both return fresh lines.

Two gotchas hit during install, both fixed in `promtail-gpu.yml`:

1. **Backfill flood.** Docker log files held ~1 week of history; on first start Promtail
   read them from offset 0 and Loki rejected the out-of-window samples (`400 ... timestamp
   too old`, ~3.6 MB dropped). The config now parses the Docker JSON, sets the entry
   timestamp, and `drop`s anything `older_than: 6h`.
2. **`vllm-whisper` mislabelled.** The container name matches both `vllm` *and* `whisper`;
   with the vllm rule first the later whisper rule overwrote `job` to `stt`. Reordered so
   the **vllm rule runs last** — `vllm-whisper` → `job=vllm`, everything else STT/Triton →
   `job=stt`.

The stack is managed on the box under `/root/gpu-telemetry/` (`docker compose
up -d` / `restart hope-promtail` after a config change; the config file is a **mounted
volume**, so `up -d` alone won't reload it).
