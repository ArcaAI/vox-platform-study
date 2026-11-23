# 02 — Deploy the Core Stack (Prometheus, Alertmanager, Grafana)

**Before you start:** finish `01-prerequisites.md` (cluster access, `grafana-admin`
Secret, `~/obs.env`).

**Goal:** bring up Prometheus (metrics), Alertmanager (alert routing) and Grafana
(dashboards) in namespace `project-hope-vox-infra`, then reach them with
`kubectl port-forward`. Public hostnames come later (`06-ingress-dns-cloudflare.md`)
— do not depend on them yet.

```bash
source ~/obs.env
cd /path/to/repos/VOX            # repository root
ls review/observability/manifests/01-rbac.yaml   # sanity: file exists
```

---

## 1. Apply order (why it matters)

| Step | File | Depends on |
|---|---|---|
| 1 | `01-rbac.yaml` | — |
| 2 | `02-prometheus-config.yaml` | — |
| 3 | `03-prometheus.yaml` | 1, 2 |
| 4 | `04-alertmanager-config.yaml` | — |
| 5 | `05-alertmanager.yaml` | 4 |
| 6 | `06-grafana-provisioning.yaml` | — |
| 7 | `07-grafana-dashboards.yaml` | — (generated; may be applied later) |
| 8 | `08-grafana-permissions.yaml` | StorageClass |
| 9 | `09-grafana.yaml` | 6, 7, 8, Graphana Secret |
| 10 | `10-ingress.yaml` | Traefik |

You can apply `01`–`06`, `08`, `09` together; `07` will be generated and applied in
`05-dashboards.md`, and `10` in `06-ingress-dns-cloudflare.md`. Below we apply them
in order with a check after each.

---

## 2. Step 1 — RBAC (`01-rbac.yaml`)

Creates the `prometheus` ServiceAccount and a **cluster-scoped** ClusterRole +
binding named `project-hope-vox-prometheus` (deliberately *not* the bare name
`prometheus`, which already exists on this cluster in `monitoring`).

```bash
kubectl apply -f review/observability/manifests/01-rbac.yaml
```

Expected:

```
serviceaccount/prometheus created
clusterrole.rbac.authorization.k8s.io/project-hope-vox-prometheus created
clusterrolebinding.rbac.authorization.k8s.io/project-hope-vox-prometheus created
```

Verify:

```bash
kubectl -n $NS get sa prometheus
kubectl get clusterrole project-hope-vox-prometheus
```

---

## 3. Step 2 — Prometheus config (`02-prometheus-config.yaml`)

Two ConfigMaps:

- **`prometheus-config`** — the config *template* (`prometheus.yml.tpl`). It is
  **not** mounted directly; the initContainer renders it (see below).
- **`prometheus-alert-rules`** — the alert rules, mounted at
  `/etc/prometheus/rules` where `rule_files` globs `*.yml`.

```bash
kubectl apply -f review/observability/manifests/02-prometheus-config.yaml
kubectl -n $NS get cm prometheus-config prometheus-alert-rules
```

> **Read this before editing config later:** Prometheus renders its config onto an
> **emptyDir** on every start. Changing the ConfigMap alone does **nothing** until
> you restart the StatefulSet:
> ```bash
> kubectl -n $NS rollout restart sts/prometheus
> ```
> The full job list and alert rules are explained in `04-metrics-scraping.md`.

---

## 4. Step 3 — Prometheus (`03-prometheus.yaml`)

A 1-replica StatefulSet with a `50Gi` PVC (`data-prometheus-0`) and a Service on
`:9090`. An initContainer (`render-prometheus-config`, busybox) substitutes
`${DOMAIN}` into the template and writes `/etc/prometheus/prometheus.yml`.

```bash
kubectl apply -f review/observability/manifests/03-prometheus.yaml
kubectl -n $NS rollout status sts/prometheus --timeout=180s
```

Expected:

```
statefulset.apps/prometheus created
service/prometheus created
statefulset.apps/prometheus condition met
```

Verify pods + PVC:

```bash
kubectl -n $NS get pods -l app=prometheus -o wide
kubectl -n $NS get pvc data-prometheus-0
```

Expected: `prometheus-0` is `1/1 Running`, PVC `Bound` (50Gi).

### If Prometheus CrashLoops with "permission denied"

The `nfs-client` provisioner sometimes ignores `fsGroup`. See
`09-troubleshooting.md` → "NFS permissions". Quick check:

```bash
kubectl -n $NS logs sts/prometheus -c prometheus --tail=20
```

---

## 5. Step 4 + 5 — Alertmanager (`04-`, `05-`)

Config uses **v0.28 matcher syntax** (`matchers`, `source_matchers`,
`target_matchers`). Everything routes to a built-in `null` receiver: alerts are
accepted and visible in the UI but **not delivered** anywhere yet (add a receiver
later in `10-day2-operations.md`).

```bash
kubectl apply -f review/observability/manifests/04-alertmanager-config.yaml
kubectl apply -f review/observability/manifests/05-alertmanager.yaml
kubectl -n $NS rollout status sts/alertmanager --timeout=120s
```

Expected: `statefulset.apps/alertmanager` and `service/alertmanager`.

Verify the config parsed (a syntax error makes the pod CrashLoop):

```bash
kubectl -n $NS logs sts/alertmanager --tail=20
```

Look for a line like `Listening on ...:9093` and no `error` about the config file.

---

## 6. Step 6 — Grafana provisioning (`06-grafana-provisioning.yaml`)

One ConfigMap with two files mounted into Grafana:

- `datasources.yaml` → Prometheus (`uid: prometheus`, default) and Loki
  (`uid: loki`).
- `dashboards.yaml` → a **file provider** reading `/var/lib/grafana/dashboards`.

```bash
kubectl apply -f review/observability/manifests/06-grafana-provisioning.yaml
kubectl -n $NS get cm grafana-provisioning
```

> The Loki datasource points at `http://loki:3100`. Until Loki exists
> (`03-logging.md`), the datasource is "configured but unreachable" — harmless.

---

## 7. Step 8 — Grafana volume permissions (`08-grafana-permissions.yaml`)

Grafana runs as uid **472** and writes `grafana.db` to PVC `grafana-data`. The
`nfs-client` provisioner often ignores `fsGroup`, so a one-shot Job chowns the
volume to `472:0` first.

```bash
kubectl apply -f review/observability/manifests/08-grafana-permissions.yaml
kubectl -n $NS get pvc grafana-data           # expect Bound
kubectl -n $NS get job grafana-permissions-fix
# wait for it to complete:
kubectl -n $NS wait --for=condition=Complete job/grafana-permissions-fix --timeout=120s
```

Expected: PVC `grafana-data` Bound; Job completes (`COMPLETIONS 1/1`).

---

## 8. Step 9 — Grafana (`09-grafana.yaml`)

Deployment (strategy `Recreate`, because `grafana.db` is single-writer on an RWO
PVC) + Service on `:3000`. Reads the `grafana-admin` Secret for credentials.

```bash
kubectl apply -f review/observability/manifests/09-grafana.yaml
kubectl -n $NS rollout status deploy/grafana --timeout=180s
kubectl -n $NS get pods -l app=grafana
```

Expected: `grafana-... 1/1 Running`.

Verify Grafana is up and reachable locally:

```bash
kubectl -n $NS port-forward svc/grafana 3000:3000 >/tmp/grafana-pf.log 2>&1 &
sleep 4
curl -s http://localhost:3000/api/health
```

Expected: `{"commit":"...","database":"ok","version":"13.1.2"}`.

> `07-grafana-dashboards.yaml` is applied in `05-dashboards.md`. It is safe to
> apply it now, but the dashboards show no data until Loki + node-exporter are up.

---

## 9. Confirm everything is running

```bash
kubectl -n $NS get pods,svc,pvc
```

Expected core set:

```
pod/alertmanager-0    1/1 Running
pod/grafana-...-...   1/1 Running
pod/prometheus-0      1/1 Running
service/alertmanager  ClusterIP  9093
service/grafana       ClusterIP  3000
service/prometheus    ClusterIP  9090
pvc/data-alertmanager-0  Bound  10Gi
pvc/data-prometheus-0    Bound  50Gi
pvc/grafana-data         Bound  10Gi
```

And Prometheus sees at least its own target:

```bash
kubectl -n $NS port-forward svc/prometheus 9090:9090 >/tmp/prom-pf.log 2>&1 &
sleep 4
curl -s 'http://localhost:9090/api/v1/targets?state=active' | python3 -c \
  'import sys,json;[print(t["labels"]["job"], t["health"]) for t in json.load(sys.stdin)["data"]["activeTargets"]]'
```

Expected: `prometheus up`, `alertmanager up` (and possibly `kubernetes-pods`).
More targets appear once you apply the scrape jobs (already in `02-`) and
node-exporter (`15-`).

Stop the port-forwards when done:

```bash
pkill -f 'port-forward' || true
```

---

## 10. Phase checklist

- [ ] `01`–`06`, `08`, `09` applied.
- [ ] `prometheus-0`, `alertmanager-0`, `grafana-...` all `1/1 Running`.
- [ ] PVCs `data-prometheus-0`, `data-alertmanager-0`, `grafana-data` Bound.
- [ ] Grafana `/api/health` returns `database: ok`.
- [ ] Prometheus shows `prometheus` and `alertmanager` targets `up`.
- [ ] No CrashLoop / permission errors.

Next → [`03-logging.md`](./03-logging.md)
