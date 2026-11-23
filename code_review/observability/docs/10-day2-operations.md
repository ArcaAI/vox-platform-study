# 10 — Day-2 operations

Common tasks **after** the stack is up. All assume:

```bash
source ~/obs.env
cd /path/to/repos/VOX
```

---

## 1. Change configuration (the general rule)

Config lives in **ConfigMaps**. A ConfigMap change does **not** restart the pod:

| Component | Config source | After editing |
|---|---|---|
| Prometheus | `02-prometheus-config.yaml` (rendered by an initContainer) | `kubectl -n $NS rollout restart sts/prometheus` |
| Alertmanager | `04-alertmanager-config.yaml` | `kubectl -n $NS rollout restart sts/alertmanager` |
| Loki | `11-loki-config.yaml` | `kubectl -n $NS rollout restart sts/loki` |
| Promtail (in-cluster) | `13-promtail.yaml` | `kubectl -n $NS rollout restart ds/promtail` |
| Grafana provisioning | `06-grafana-provisioning.yaml` | `kubectl -n $NS rollout restart deploy/grafana` |
| Grafana dashboards | `07-grafana-dashboards.yaml` (via `generate.py`) | `rollout restart deploy/grafana` (Grafana 13 loads at startup) |

Always: **edit the manifest → `kubectl apply` → restart the workload → verify**
(`08-verification.md`).

---

## 2. Add an alert rule

Edit the `groups` block in `02-prometheus-config.yaml`, apply, restart:

```bash
kubectl apply -f review/observability/manifests/02-prometheus-config.yaml
kubectl -n $NS rollout restart sts/prometheus
curl -s 'http://localhost:9090/api/v1/rules' | python3 -m json.tool | less
```

Example rule:

```yaml
      - alert: HopeAppHighErrorRate
        expr: sum(rate(api_gateway_http_requests_total{status=~"5.."}[5m])) by (app) > 0.5
        for: 10m
        labels: { severity: warning }
        annotations:
          summary: "{{ $labels.app }} 5xx rate > 0.5/s"
```

---

## 3. Route alerts somewhere real (Alertmanager)

Out of the box the receiver is `null`. To send to Slack:

```yaml
# 04-alertmanager-config.yaml
route:
  receiver: slack
  group_by: [alertname, namespace]
  repeat_interval: 4h
receivers:
  - name: slack
    slack_configs:
      - api_url: https://hooks.slack.com/services/XXX/YYY/ZZZ
        channel: '#hope-alerts'
        send_resolved: true
```

For email, use `email_configs` with an SMTP block in `global`. Prefer putting the
webhook in a **Secret** and referencing it via `slack_api_url_file`. Apply +
`rollout restart sts/alertmanager`.

Test a route by firing a synthetic alert:

```bash
kubectl -n $NS port-forward svc/alertmanager 9093:9093 &
curl -XPOST http://localhost:9093/api/v2/alerts -H 'Content-Type: application/json' -d '[{
  "labels":{"alertname":"TestAlert","severity":"warning"},
  "annotations":{"summary":"test"}}]'
```

---

## 4. Change data retention

```bash
# Prometheus: --storage.tsdb.retention.time (03-prometheus.yaml), default 15d
kubectl -n $NS patch sts prometheus --type=json \
  -p '[{"op":"replace","path":"/spec/template/spec/containers/0/args","value":[<full args list>]}]'
# cleaner: edit 03-prometheus.yaml's args then:
kubectl apply -f review/observability/manifests/03-prometheus.yaml
kubectl -n $NS rollout restart sts/prometheus

# Loki: retention_period + compactor retention_enabled (11-loki-config.yaml), default 720h (30d)
kubectl apply -f review/observability/manifests/11-loki-config.yaml
kubectl -n $NS rollout restart sts/loki
```

> Shortening Prometheus/Loki retention does not shrink existing data immediately;
> old blocks are removed by the compactor / TSDB compaction over time.

---

## 5. Add a new application to monitoring

1. **Metrics** — if the app exposes `/metrics`, add its name to the `hope-apps`
   keep-regex in `02-prometheus-config.yaml`, ensure a Service/Endpoints exists, then
   restart Prometheus.
2. **Dashboard** — two options:

   **Option A: Add to generate.py (recommended, preserves ConfigMap workflow)**
   - Open `dashboards/generate.py` and add an entry to the `apps()` map (see the
     existing `app-hope-*` entries for the pattern: name, container, metric panels).
   - Re-run: `python3 dashboards/generate.py`
   - Apply: `kubectl apply -f manifests/07-grafana-dashboards.yaml`
   - Restart: `kubectl -n project-hope-vox-infra rollout restart deploy/grafana`

   **Option B: Use individual JSON files (new workflow, study/modify freely)**
   - Dashboard JSONs are generated in `manifests/dashboards/` by
     `dashboards/generate_individual.py`.
   - Review or modify the JSON files directly — no need to touch `generate.py`.
   - Import via Grafana UI: **+, Import**, select the `.json` file, choose the
     Prometheus/Loki datasource.
   - Or import via API: `curl -s -X POST http://localhost:3000/api/dashboards/db \
       -H "Content-Type: application/json" -u admin:$PW --data @<file>.json`.
   - To apply via ConfigMap: copy the JSON into the `07-grafana-dashboards.yaml`
     ConfigMap (preserve the `|` block format), then `kubectl apply` + restart Grafana.

   Both options result in the dashboard appearing in Grafana. Option A keeps the
   single-source-of-truth ConfigMap; Option B gives you editable JSON files for
   study and version control.

3. **Logs** — nothing to do: Promtail's static glob already captures every pod in
   the namespace.

Verify: target `up`, panel populated, logs visible with `{container="hope-<name>"}`.

---

## 6. Grafana administration

```bash
# Reset the admin password
kubectl -n $NS exec deploy/grafana -- \
  grafana cli --homepath /usr/share/grafana admin reset-admin-password 'NewPass123!'
kubectl -n $NS rollout restart deploy/grafana

# Add a read-only user via API
PW=$(kubectl -n $NS get secret grafana-admin -o jsonpath='{.data.GF_SECURITY_ADMIN_PASSWORD}' | base64 -d)
kubectl -n $NS port-forward svc/grafana 3000:3000 &
curl -s -XPOST -u admin:"$PW" -H 'Content-Type: application/json' \
  http://localhost:3000/api/admin/users \
  -d '{"name":"viewer","email":"v@example.com","login":"viewer","password":"Viewer123!","OrgId":1}'
```

> Users/teams/dashboard edits made in the UI persist on the `grafana-data` PVC, but
> dashboards delivered by the file provider are **read-only** and overwritten from
> the ConfigMap on restart.

---

## 7. Upgrade an image

Images are pinned by tag. Edit the tag in the manifest, apply, restart:

```bash
kubectl apply -f review/observability/manifests/09-grafana.yaml
kubectl -n $NS rollout restart deploy/grafana
kubectl -n $NS rollout status deploy/grafana
```

Do one component at a time and re-run `08-verification.md`. Watch for breaking
config syntax (Alertmanager matchers, Loki schema, Grafana provisioning) across
major versions.

---

## 8. Backup and restore

```bash
# Pod-name helpers
PROM=$(kubectl -n $NS get pod -l app=prometheus -o jsonpath='{.items[0].metadata.name}')
GRAF=$(kubectl -n $NS get pod -l app=grafana     -o jsonpath='{.items[0].metadata.name}')

# Grafana: users/dashboards/settings DB + provisioning (excludes plugins)
kubectl -n $NS exec $GRAF -- tar czf - -C /var/lib/grafana grafana.db > grafana-backup-$(date +%F).tgz

# Prometheus: TSDB snapshot (needs --web.enable-admin-api, which is enabled)
kubectl -n $NS exec $PROM -- \
  curl -s -XPOST http://localhost:9090/api/v1/admin/tsdb/snapshot
```

Restore: stop the workload, replace the PVC contents (or re-create the PVC and copy
data in), start the workload. Loki data is the Loki PVC — back it up the same way if
required (`tar` of `/loki`).

> The true source of truth is **this repository** (`manifests/` + `generate.py`).
> Restoring the ConfigMaps from git and re-applying is usually enough; the PVCs only
> hold history (TSDB, logs, Grafana DB).

---

## 9. Scale-out notes

- **Prometheus/Alertmanager/Loki** are StatefulSets with a single replica and local
  file storage — they are **not** horizontally scalable as configured. To grow,
  migrate to remote storage (e.g. object storage for Loki, remote-write for
  Prometheus). Do not simply bump replicas.
- **Node-exporter and Promtail** are DaemonSets: they scale automatically with
  nodes.

---

## 10. Secret rotation

```bash
# Recreate with a new value, then restart the consumer(s)
kubectl -n $NS create secret generic grafana-admin \
  --from-literal=GF_SECURITY_ADMIN_USER=admin \
  --from-literal=GF_SECURITY_ADMIN_PASSWORD="$(openssl rand -base64 24)" \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n $NS rollout restart deploy/grafana
# then reset the password to match (see §6)
```

---

## 11. GPU host maintenance

```bash
# On the GPU host
cd ~/gpu-telemetry
docker compose ps
docker compose restart           # after editing promtail-gpu.yml / docker-compose.yml
docker compose down              # stop telemetry (leaves the app containers alone)
docker compose up -d             # start again (LOKI_URL=... if not defaulted)
docker logs -f hope-promtail
```

The app containers (`vllm-whisper`, `hope-stt`, `triton`, …) are **not** managed by
this bundle — this only runs the telemetry agents.

---

## 12. Rotate / clean up the socat bounce

If you used the `gpu-bounce` pod:

```bash
kubectl -n $NS get pod gpu-bounce            # is it still there?
kubectl -n $NS delete pod gpu-bounce         # remove when done
pkill -f 'port-forward' || true              # stop local tunnels
```

Do **not** leave the bounce pod running: it forwards the node network to the GPU
host's SSH port.

---

## 13. Periodic health review (weekly)

```bash
# Anything not Running?
kubectl -n $NS get pods | grep -vE 'Running|Completed'

# Targets down?
kubectl -n $NS port-forward svc/prometheus 9090:9090 >/tmp/pf.log 2>&1 & sleep 3
curl -s 'http://localhost:9090/api/v1/targets?state=active' \
 | python3 -c 'import sys,json;[print("DOWN:",t["labels"].get("job"),t.get("lastError")) for t in json.load(sys.stdin)["data"]["activeTargets"] if t["health"]!="up"]'

# Firing alerts?
curl -s 'http://localhost:9090/api/v1/alerts' \
 | python3 -c 'import sys,json;[print(a["labels"]["alertname"],a["state"]) for a in json.load(sys.stdin)["data"]["alerts"]]'

# Disk usage creeping up? (PVCs)
kubectl -n $NS get pvc
```

---

## 14. Security housekeeping (do not forget)

- **Revoke/rotate the leaked Cloudflare API token.** It is still on disk in
  `cf/cf-le/cf.ini` and `cf/token_details.txt`. Rotate it in the Cloudflare
  dashboard and clean the files from version control.
- **Protect Prometheus/Alertmanager** with Cloudflare Access or unpublish them
  (`06-ingress-dns-cloudflare.md` §5).
- **Never expose Loki** (no auth).
- **Flush local DNS** after DNS changes:
  `sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder`.

Next → [`appendix-file-map.md`](./appendix-file-map.md)
