# Observability Core-3 (Prometheus + Alertmanager + Grafana)

Deploy target namespace: **`project-hope-vox-infra`**
Cluster: kubeadm v1.29 (see `review/cloudflared/current-setup.md`), Traefik is the
default IngressClass, storage is `nfs-client`.

Scope: the three components that make rules and dashboards meaningful —
**Prometheus** (scrape/alert), **Alertmanager** (alert routing), **Grafana**
(dashboards). Loki / Promtail / Jaeger / blackbox / node-exporter / cAdvisor /
pushgateway / karma / uptime-kuma are intentionally **out of scope**; these
manifests are a trimmed, cluster-corrected subset of the old
`Arca-AgenticSystemDeployment/observability/` raw stack.

> **Log aggregation** (Grafana + Loki + Promtail) for `project-hope-vox` and
> `project-hope-vox-infra` is a **separate follow-on phase**, planned in
> [`LOGGING.md`](./LOGGING.md). Loki is **required** (Grafana stores no logs and no
> log store exists today) and would be deployed in `project-hope-vox-infra`; it is
> **not** part of the Core-3 manifests here.

> **Not applied yet.** This folder is a review artifact. Applying it creates real
> PVCs and workloads.

---

## 1. How the "init configs" reach the images (the answer)

Neither image is custom-built — both are stock upstream images that read their
config from **mounted volumes on every start**. Bumping an image tag never changes
how config is applied.

| Component | Config mechanism | Image-version-independent? |
|---|---|---|
| **Prometheus** | A `busybox` **initContainer** (`render-prometheus-config`) `sed`-renders `prometheus-config/prometheus.yml.tpl` → `/etc/prometheus/prometheus.yml` on an `emptyDir`. Alert rules are a separate ConfigMap (`prometheus-alert-rules`) mounted at `/etc/prometheus/rules`. | Yes. The init step is in the pod spec, not the image. |
| **Grafana** | **No init container.** Provisioning ConfigMaps are mounted into `/etc/grafana/provisioning/{datasources,dashboards}` and dashboards into `/var/lib/grafana/dashboards`. Grafana's own entrypoint applies provisioning each boot. | Yes. Mount paths are stable across Grafana majors. |
| **Alertmanager** | ConfigMap mounted at `/etc/alertmanager/alertmanager.yml`. | Yes. |

So to deploy **fresh images**: edit the `image:` line in
`03-prometheus.yaml` / `05-alertmanager.yaml` / `09-grafana.yaml`, re-apply, done.
The same configs are applied automatically. See §6.

Data persistence: Prometheus TSDB, Alertmanager silences, and Grafana's
`grafana.db` all live on PVCs and are **auto-migrated on first start** of the new
version. Do not delete PVCs unless you mean to wipe data (§7).

---

## 2. Files

`manifests/` — apply in numeric order:

| File | Contents |
|---|---|
| `01-rbac.yaml` | ServiceAccount + ClusterRole + ClusterRoleBinding (cluster-scoped names de-collided to `project-hope-vox-prometheus`). |
| `02-prometheus-config.yaml` | `prometheus-config` (template) + `prometheus-alert-rules` (fixes old finding **H-30**). |
| `03-prometheus.yaml` | StatefulSet (initContainer renders config) + Service; PVC `prometheus-data` (50Gi). |
| `04-alertmanager-config.yaml` | `alertmanager-config`, rewritten to v0.28 matcher syntax, `null` receiver. |
| `05-alertmanager.yaml` | StatefulSet + Service; PVC `alertmanager-data` (10Gi). |
| `06-grafana-provisioning.yaml` | `grafana-provisioning` (datasource + dashboard provider). |
| `07-grafana-dashboards.yaml` | `grafana-dashboards` — **13** dashboards (see §8): passthrough `prometheus-overview` / `logs-overview`, `k8s-infra`, `stt-gpu`, `vllm`, and one `app-hope-*` per app (fixes old finding **H-32**). **Generated** by `dashboards/generate.py`. |
| `08-grafana-permissions.yaml` | PVC `grafana-data` (10Gi) + `grafana-permissions-fix` Job (chowns to 472:0). |
| `09-grafana.yaml` | Deployment (`Recreate`) + Service. |
| `10-ingress.yaml` | Traefik Ingresses for `grafana.vox2.arcaai.com`, `prometheus.vox2.arcaai.com` and `alertmanager.vox2.arcaai.com`. |
| `11-loki-config.yaml` | `loki-config` (schema v13/tsdb, 720h retention, `auth_enabled: false`). |
| `12-loki.yaml` | Loki StatefulSet + ClusterIP Service; PVC `data-loki-0` (50Gi). |
| `13-promtail.yaml` | Promtail DaemonSet + ServiceAccount (static `/var/log/pods` glob; no RBAC). |
| `14-loki-nodeport.yaml` | `loki-nodeport` → Loki `:3100` on NodePort **31100** (LAN-only, no auth) for the GPU-box shipper. |
| `15-node-exporter.yaml` | `node-exporter` DaemonSet (`prom/node-exporter:v1.9.1`) across all 6 nodes (no `hostNetwork`, so it does not clash with the legacy `monitoring/node-exporter`). |
| `grafana-secret.yaml.example` | **Example only** (`.example` is ignored by `kubectl apply -f`). |

What was dropped vs. the old raw stack, and why:
- **NetworkPolicies** — referenced `192.168.68.130` and namespaces `apps`/`highlight`/`mlflow` that do not exist here.
- **Loki / Promtail / Jaeger / karma / uptime-kuma / blackbox / pushgateway / node-exporter / cadvisor** — out of scope.
- **`$(DOMAIN)` kustomize vars + `stack.env`** — replaced by a direct `DOMAIN` env on the initContainer.
- **Ingress `router.middlewares`** — `secure-headers@file`, `ip-whitelist-cloudflared@file`, etc. do not exist on this cluster.
- **Committed Grafana password** — replaced by an out-of-band Secret (old finding **C-3**).

---

## 3. Prerequisites

1. Namespace exists:
   ```bash
   kubectl get ns project-hope-vox-infra
   ```
   (It does — created with the infra plane. Create only if missing.)

2. `nfs-client` StorageClass exists (it does on this cluster — all current PVCs use it):
   ```bash
   kubectl get sc
   ```

3. Create the Grafana admin Secret (do **not** commit the password):
   ```bash
   kubectl -n project-hope-vox-infra create secret generic grafana-admin \
     --from-literal=GF_SECURITY_ADMIN_USER=admin \
     --from-literal=GF_SECURITY_ADMIN_PASSWORD="$(openssl rand -hex 24)"
   ```

4. DNS: `grafana.vox2.arcaai.com`, `prometheus.vox2.arcaai.com` and
   `alertmanager.vox2.arcaai.com` must each be a proxied CNAME into the
   `hope-vox2` Cloudflare tunnel (per
   `review/cloudflared/vox2-arcaai-com-routing.md`). Traefik routes on the Host
   header; the tunnel must **not** override it (`originRequest.httpHostHeader`).
   **Exact click-by-click dashboard steps: §3d below.**

---

## 3b. Traefik, DNS & the UIs (answering the three questions)

**"Will the Traefik config be taken care of?"** — Yes, nothing to edit in Traefik
itself. Traefik is already installed (Helm, `project-hope-vox`, IngressClass
`traefik` is the default) and its **ClusterRole watches all namespaces**, so the
Ingress objects in `10-ingress.yaml` are picked up automatically once applied.
This mirrors how `vault.vox2.arcaai.com` / `temporal.vox2.arcaai.com` are already
served (`review/cloudflared/manifests/ingress-vox2-infra.yaml`). Traefik
`providers.kubernetesingress.publishedservice=project-hope-vox/traefik`.

**"Will the three hostnames work?"** — They will resolve and route **only after
both** of these are true:
1. the Ingress is applied (this folder does that), **and**
2. a **proxied (orange-cloud) CNAME** exists in Cloudflare for each hostname
   pointing at `<tunnel-id>.cfargotunnel.com`. Easiest path: add each as a
   **Public Hostname** on the `hope-vox2` tunnel in the Cloudflare dashboard —
   it creates the CNAME for you. The tunnel's HTTP catch-all already forwards
   every hostname to Traefik with the Host header intact, so no tunnel-side
   route is needed. A grey-clouded CNAME will **not** work.

| Hostname | Backend | Reachable? |
|---|---|---|
| `grafana.vox2.arcaai.com` | `grafana:3000` | Ingress in place; needs CNAME |
| `prometheus.vox2.arcaai.com` | `prometheus:9090` | Ingress in place; needs CNAME |
| `alertmanager.vox2.arcaai.com` | `alertmanager:9093` | Ingress in place; needs CNAME |

Prometheus/Alertmanager are served at the **root** of their own hostnames, so no
`--web.external-url` / `--web.route-prefix` juggling is required.

**"Does Alertmanager have a UI?"** — **Yes.** Alertmanager ships a built-in web
UI (port 9093) — it lists active alerts, and lets you view/add **silences** and
inspect status/config. So `alertmanager.vox2.arcaai.com` will show it. It is
basic (no graphs), and — importantly — it is **unauthenticated** by default, as is
the Prometheus UI. See the security note in §8.

---

## 3c. Conflict audit (checked against the live cluster)

Verified directly on the live cluster (context `kubernetes-admin@kubernetes`):

- **Every namespaced object name in this folder is free** in
  `project-hope-vox-infra`: `sa/prometheus`, the five ConfigMaps, `svc/prometheus`,
  `svc/alertmanager`, `svc/grafana`, `deploy/grafana`, `sts/prometheus`,
  `sts/alertmanager`, `pvc/grafana-data`, `job/grafana-permissions-fix`,
  `secret/grafana-admin`, and `ingress/hope-grafana|hope-prometheus|hope-alertmanager`.
- **Neither StatefulSet PVC name collides**: existing PVCs use the template name
  `data-vol` (`data-vol-<sts>-0`); ours use template `data` → `data-prometheus-0`,
  `data-alertmanager-0`.
- **No `ResourceQuota` / `LimitRange`, and no Pod Security Admission labels** on
  the namespace → nothing will reject the pods.
- **StorageClass `nfs-client` and IngressClass `traefik` both exist** (traefik is
  the default class).
- **The only collision risk was cluster-scoped, and was avoided by renaming.**
  A `ClusterRole` (and `ClusterRoleBinding`) named **`prometheus` already exists**
  on the cluster, owned by base install in the separate `monitoring` namespace
  (`subjects: ServiceAccount monitoring/default`). The original
  `Arca-AgenticSystemDeployment/observability/prometheus-rbac.yaml` also used the
  bare name `prometheus` — applying it as-is would have **mutated that foreign
  ClusterRole**. This folder uses `project-hope-vox-prometheus` instead, so it is
  fully isolated. (Our SA is namespace-local, so the old binding grants it nothing.)
- **Two Ingresses already exist and prove the pattern**: `hope-vault`
  (`vault.vox2.arcaai.com`) and `hope-temporal-ui` (`temporal.vox2.arcaai.com`) —
  both in `project-hope-vox-infra`, class `traefik`, backend a Service in the same
  namespace. Our three Ingresses follow the identical shape.

> **Traefik lives in `project-hope-vox`, not in this namespace — is that ok? Yes.**
> Kubernetes `networking.k8s.io/v1` Ingress requires the **backend Service to be in
> the Ingress's own namespace** (ours are — both are `project-hope-vox-infra`), but
> the **controller may live anywhere**. Traefik's ClusterRole/ClusterRoleBinding
> (`traefik-project-hope-vox`) watch Ingresses **cluster-wide** and route to
> Services cross-namespace; the existing `hope-vault`/`hope-temporal-ui` routes are
> live proof. `providers.kubernetesingress.ingressendpoint.publishedservice=project-hope-vox/traefik`
> only affects how the Service's LB/NodePort address is published — it plays no
> part in routing these hosts.

---

## 3d. Cloudflare dashboard — add the routes (`dash.cloudflare.com`)

This folder's Ingresses make **Traefik** aware of the hosts; **Cloudflare must also
be told to send those hostnames into the tunnel**. Do this on the dashboard so
Traefik receives them with the right `Host` header.

> **Golden rule:** every observability hostname points at **Traefik**, never at
> the Grafana/Prometheus/Alertmanager Service directly, and **never** set
> `httpHostHeader`. Traefik does all per-host routing.

**Prerequisite:** the dedicated tunnel **`hope-vox2`** must already exist and its
connector must be running in-cluster (if it doesn't exist yet, run
`review/cloudflared/steps_to_follow.md` Part 1.2 first).

### Steps

1. Open [dash.cloudflare.com](https://dash.cloudflare.com) → account →
   **Zero Trust** → **Networks** → **Tunnels** → open **`hope-vox2`**.
2. Go to the **Public Hostnames** tab → **Add a public hostname**. The form has
   these fields (shown filled in for Grafana — **`Path` stays empty**):

   | Field | Value |
   |---|---|
   | Subdomain | `grafana.vox2` |
   | Domain | `arcaai.com` |
   | Path | *(leave empty)* |
   | Type | **HTTP** |
   | URL | **`traefik.project-hope-vox.svc.cluster.local:80`** |

   Repeat for all three hosts:

   | Subdomain | Domain | Path | Type | URL |
   |---|---|---|---|---|
   | `grafana.vox2` | `arcaai.com` | *(empty)* | HTTP | `traefik.project-hope-vox.svc.cluster.local:80` |
   | `prometheus.vox2` | `arcaai.com` | *(empty)* | HTTP | `traefik.project-hope-vox.svc.cluster.local:80` |
   | `alertmanager.vox2` | `arcaai.com` | *(empty)* | HTTP | `traefik.project-hope-vox.svc.cluster.local:80` |

3. **Do NOT** expand *Additional application settings → HTTP Settings* and set
   `httpHostHeader`. Leaving it unset forwards the client's original `Host` —
   the only thing Traefik routes on. Setting it 404s every host.
4. Click **Save** for each.

### Confirm the DNS records (auto-created)

- Saving a public hostname auto-creates a **proxied (orange-cloud) CNAME**
  `<host>.vox2.arcaai.com → <tunnel-id>.cfargotunnel.com` in the zone's **DNS**
  tab. Verify all three are **proxied** — a grey-clouded `cfargotunnel.com`
  CNAME resolves to nothing a client can reach.
- Faster alternative: add `vox2.arcaai.com` + `*.vox2.arcaai.com` (wildcard) as two
  public hostnames instead of three; a wildcard does not cover the apex.

### Protect the unauthenticated UIs (recommended)

- **Zero Trust → Access → Applications → Self-hosted**, add a policy bound to your
  IdP for `prometheus.vox2.arcaai.com` and `alertmanager.vox2.arcaai.com`.
- Why: those two UIs have no auth (see §8), and Prometheus's admin API can delete
  series. Cloudflare Access runs at the edge, **before** the tunnel, so it protects
  backends that authenticate nothing. Grafana already has its own login.

**Result:** after these three rows + the Ingresses in `10-ingress.yaml`, the three
hostnames resolve, route through the tunnel, and Traefik sends each to the right
Service (§3b table).

> ⚠️ **TLS caveat for `*.vox2.arcaai.com` hosts.** Cloudflare's free Universal SSL
> covers only `*.arcaai.com` (**one** label), so every two-level
> `x.vox2.arcaai.com` host — including these three — fails the TLS handshake
> (`alert 40`) until a certificate covering `*.vox2.arcaai.com` exists. On a plan
> without Total TLS / ACM, the free fix is to issue a **Let's Encrypt wildcard**
> and upload it as a Cloudflare custom certificate: see
> **`review/cloudflared/custom_cert/token_gen.md`**. (The approach actually chosen
> instead renames the hosts to single-label `*-vox2.arcaai.com`, which Universal
> SSL covers — see `review/cloudflared/vox2-arcaai-com-routing.md`.)

---

## 4. Apply

```bash
cd review/observability

kubectl apply -f manifests/01-rbac.yaml
kubectl apply -f manifests/02-prometheus-config.yaml
kubectl apply -f manifests/03-prometheus.yaml

kubectl apply -f manifests/04-alertmanager-config.yaml
kubectl apply -f manifests/05-alertmanager.yaml

kubectl apply -f manifests/06-grafana-provisioning.yaml
kubectl apply -f manifests/07-grafana-dashboards.yaml
kubectl apply -f manifests/08-grafana-permissions.yaml
kubectl -n project-hope-vox-infra wait --for=condition=complete \
  job/grafana-permissions-fix --timeout=180s || true

kubectl apply -f manifests/09-grafana.yaml
kubectl apply -f manifests/10-ingress.yaml
```

Wait for readiness:
```bash
kubectl -n project-hope-vox-infra rollout status sts/prometheus
kubectl -n project-hope-vox-infra rollout status sts/alertmanager
kubectl -n project-hope-vox-infra rollout status deploy/grafana
```

---

## 5. Verify

```bash
kubectl -n project-hope-vox-infra get pods,pvc,svc,ingress

# Prometheus: config rendered by the initContainer, rules loaded, targets UP.
kubectl -n project-hope-vox-infra logs sts/prometheus -c render-prometheus-config
kubectl -n project-hope-vox-infra exec sts/prometheus -- \
  wget -qO- http://localhost:9090/api/v1/rules | grep -c '"state":"active"'
kubectl -n project-hope-vox-infra port-forward svc/prometheus 9090:9090
#   open http://localhost:9090/targets

# Grafana: dashboards + datasource provisioned.
kubectl -n project-hope-vox-infra exec deploy/grafana -- \
  ls /var/lib/grafana/dashboards
curl -s https://grafana.vox2.arcaai.com/api/health   # via Cloudflare edge

# Alertmanager: config accepted (v0.28 syntax).
kubectl -n project-hope-vox-infra logs sts/alertmanager
curl -s https://alertmanager.vox2.arcaai.com/api/v2/alerts

# All three hostnames route through Traefik via the Cloudflare tunnel:
curl -sI https://grafana.vox2.arcaai.com        | head -1
curl -sI https://prometheus.vox2.arcaai.com     | head -1
curl -sI https://alertmanager.vox2.arcaai.com   | head -1
```

To see the rules fire: stop something on purpose or just confirm
`PrometheusTargetDown` is `Inactive` on healthy targets — the rule set is loaded
and evaluating either way.

---

## 6. Deploying fresh images later

1. Edit the `image:` tag in `03-prometheus.yaml` / `05-alertmanager.yaml` / `09-grafana.yaml`.
2. Re-apply just that file:
   ```bash
   kubectl apply -f manifests/03-prometheus.yaml   # etc.
   ```
3. Config is untouched — the initContainer re-renders `prometheus.yml`, Grafana
   re-reads its mounted provisioning, data migrates in place.

Version notes for the *current* fresh set:
- **Grafana 10 → 13**: provisioning format unchanged. Dropped Loki/Jaeger datasources. Dashboard `schemaVersion` auto-migrates on load.
- **Prometheus 2.47 → 3.13**: config is compatible. Kept `--storage.tsdb.*`, `--web.enable-lifecycle`, `--web.enable-admin-api`.
- **Alertmanager 0.26 → 0.28**: `source_match`/`target_match`/route `match` **removed** — the config was rewritten to `matchers`/`source_matchers` (04). If you bump Alertmanager further, re-check the matcher syntax.

---

## 7. Rollback / clean slate

- **Roll back an image bump**: revert the `image:` tag, re-apply that file. Data is preserved.
- **Full wipe (loses all metrics/silences/dashboards-in-DB)**:
  ```bash
  kubectl -n project-hope-vox-infra delete deploy/grafana sts/prometheus sts/alertmanager
  kubectl -n project-hope-vox-infra delete pvc grafana-data data-prometheus-0 data-alertmanager-0
  # then re-apply from §4
  ```
  StatefulSet PVCs from `volumeClaimTemplates` are named
  `<templateName>-<statefulset>-<ordinal>` — here the template is named `data`, so
  the PVCs are `data-prometheus-0` and `data-alertmanager-0`.
  `persistentVolumeClaimRetentionPolicy` is set to `Retain`, so they survive
  deletion of the StatefulSet unless you delete them explicitly.

---

## 8. Known caveats

- **NFS permissions**. The `nfs-client` provisioner often ignores `fsGroup`, and a root-squashed export also blocks the `grafana-permissions-fix` chown. If a pod CrashLoops on `permission denied` writing its data dir, set that container's `securityContext.runAsUser: 0` as the fallback (Grafana uid 472, Prometheus/Alertmanager uid 65534). This is the one thing most likely to need a tweak on first apply.
- **No alert delivery**. Everything routes to Alertmanager's `null` receiver. Add a receiver (webhook / email / MS Teams) to `04-alertmanager-config.yaml` and point `route.receiver` at it to actually send alerts.
- **No in-cluster TLS**. Ingresses are plain HTTP; TLS terminates at the Cloudflare edge. `GF_SECURITY_COOKIE_SECURE` is `false` so a direct (non-Cloudflare) login still works; flip it to `true` once you only reach Grafana through HTTPS.
- **Prometheus & Alertmanager UIs are unauthenticated.** Grafana has a login; the other two do not. Exposing `prometheus.vox2.arcaai.com` also exposes `/api/v1/admin/*` (delete series, snapshot, etc.), and exposing `alertmanager.vox2.arcaai.com` lets anyone create/expire silences. Options: put **Cloudflare Access** in front of those two public hostnames, or **don't create** the Prometheus/Alertmanager Ingresses (delete those two docs from `10-ingress.yaml`) and reach them with `kubectl port-forward`. There is no Traefik auth middleware on this cluster yet.
- **Secret must exist** before applying `09-grafana.yaml`, or the pod will not start (missing `grafana-admin`).

---

## 8. Logs, metrics & GPU telemetry (extensions)

The Core-3 stack was extended with log aggregation (Loki/Promtail), app + node
metrics scraping, and dashboards. Files `11`–`15` implement this; GPU-box
telemetry lives outside the cluster (`gpu-box/`).

### 8.1 What Prometheus now scrapes (`02-prometheus-config.yaml`)

| Job | Target | Notes |
|---|---|---|
| `node-exporter` | our DaemonSet, all 6 nodes | `node_exporter:9100`; see `15-node-exporter.yaml`. |
| `kube-state-metrics` | `kube-system/kube-state-metrics` | `kube_*` object metrics. |
| `kubernetes-cadvisor` | node kubelets via `nodes/proxy` | `container_*` resource metrics (RBAC added in `01`). |
| `hope-apps` | the 7 HOPE pods' `/metrics` | Endpoints SD, `app` = pod label; `admin-console` excluded (HTML). |
| `vllm` | `192.168.112.2:9000` | selector-less Service + manual Endpoints. |
| `stt-gpu` | `192.168.112.2:8862` | `stt_*` metrics (unauthenticated `/metrics`). |
| `node-exporter-gpu` | `192.168.112.2:9100` | Box host CPU/mem/disk; **up** (installed via `gpu-box/`). |

Alert rules added for the GPU box (`GpuServerNodeExporterDown`,
`GpuServerHighCpu`, `GpuServerHighMemory`).

> Scrape-config changes need `kubectl -n project-hope-vox-infra rollout restart sts/prometheus`
> (emptyDir config re-rendered by the initContainer).

### 8.2 Dashboards (`07-grafana-dashboards.yaml`, generated)

`dashboards/generate.py` emits all 13 dashboards → `07-grafana-dashboards.yaml`.
Regenerate + apply + restart Grafana (Grafana 13 file-provisioning only reloads on
startup):

```bash
python3 dashboards/generate.py
kubectl apply -f manifests/07-grafana-dashboards.yaml
kubectl -n project-hope-vox-infra rollout restart deploy/grafana
```

Dashboards: `k8s-infra` (cluster CPU/mem/pods), `stt-gpu` (STT latency/RTF/sessions
+ host CPU/mem), `vllm` (throughput, TTFT, KV cache, queue), `app-hope-*` ×7
(per-app HTTP + inference + logs), plus the two passthroughs.

### 8.3 GPU box (`gpu-box/`) — off-cluster host `192.168.112.2`

Not in the pod network; only `:8862` (STT) and `:9000` (vLLM) are wired in via
manual Endpoints. Host CPU/memory and container logs require an agent on the box:

```bash
# on 192.168.112.2
LOKI_URL=http://192.168.112.6:31100 docker compose -f gpu-box/docker-compose.yml up -d
```

Runs `node-exporter` (host net :9100) + `promtail` (docker log driver → Loki via the
NodePort), mapping vLLM/STT containers to `job=vllm`/`job=stt`. Optional
`dcgm-exporter.compose.yml` adds NVIDIA GPU metrics. **Installed** at
`/root/gpu-telemetry/` (compose `restart: unless-stopped`); `node-exporter-gpu` is UP and
vLLM/STT logs are flowing. See `gpu-box/README.md` and `LOGGING.md` §14 for the two
config gotchas (stale-log drop + `vllm-whisper` job mapping).
