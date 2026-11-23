# 09 — Troubleshooting

Every failure mode encountered while building this stack, with the exact fix. Find
your symptom, apply the fix, then re-run the relevant check in
`08-verification.md`.

```bash
source ~/obs.env
```

---

## 0. Fast triage

```bash
# What's not running?
kubectl -n $NS get pods | grep -vE 'Running|Completed'

# Why? (pick the failing pod)
kubectl -n $NS describe pod <pod>
kubectl -n $NS logs <pod> --all-containers --tail=50
kubectl -n $NS get events --sort-by=.lastTimestamp | tail -20

# Are targets up?
kubectl -n $NS port-forward svc/prometheus 9090:9090 >/tmp/pf.log 2>&1 & sleep 3
curl -s 'http://localhost:9090/api/v1/targets?state=active' \
 | python3 -c 'import sys,json;[print(t["labels"].get("job"),t["health"],t.get("lastError","")) for t in json.load(sys.stdin)["data"]["activeTargets"]]'
```

---

## 1. Pod won't start

| Symptom | Cause | Fix |
|---|---|---|
| `CreateContainerConfigError: secret "grafana-admin" not found` | Grafana Secret missing | `01-prerequisites.md` §4 — create the Secret, then `kubectl -n $NS rollout restart deploy/grafana` |
| Grafana pod `CrashLoopBackOff`, log `permission denied` writing `/var/lib/grafana` | NFS volume not owned by uid 472 | Run the permissions Job; if it can't chown (root-squash), add `securityContext.runAsUser: 0` to the Grafana container (§"NFS permissions")
| Loki pod `CrashLoopBackOff`, `permission denied` writing `/loki` | `nfs-client` ignored `fsGroup: 10001` | The initContainer should have chowned it; if the export root-squashes root, set the Loki container `runAsUser: 0` and restart |
| Prometheus/Alertmanager `CrashLoop`, `permission denied` on `/prometheus`/`/alertmanager` | Same NFS/fsGroup issue | Same fix (see below) |
| `Pending` PVC / pod stuck `Pending` | No storage / wrong StorageClass | `kubectl get sc`; ensure `nfs-client` exists (or edit `storageClassName`). Check `kubectl describe pvc`. |
| `Init:Error` on Prometheus | Render initContainer failed | `kubectl -n $NS logs sts/prometheus -c render-prometheus-config` |
| Loki pod `CrashLoop` on config parse | Bad `loki-config` | `kubectl -n $NS logs sts/loki`; validate YAML |

### NFS / permissions fix (the common one)

Symptom: a pod logs `permission denied` writing its data dir. Cause: the
`nfs-client` provisioner often ignores the pod `fsGroup`, so the volume is owned by
root.

Preferred fix (already wired): the `grafana-permissions-fix` Job (Grafana) and the
`loki-permissions-fix` initContainer (Loki). If those can't chown (root-squashed
export), fall back to running the process as root:

```bash
# Example for Prometheus: add under spec.template.spec in 03-prometheus.yaml
#   containers: [ - name: prometheus ... securityContext: { runAsUser: 0 } ]
kubectl -n $NS edit sts/prometheus    # add the securityContext, then save
kubectl -n $NS rollout status sts/prometheus
```

---

## 1. Prometheus targets are DOWN

| Down target | Likely cause | Fix |
|---|---|---|
| `node-exporter` | DS not scheduled / label mismatch | `kubectl -n $NS get pods -l app=node-exporter`; must be 6/6. Re-apply `15-`. |
| `kube-state-metrics` | Service name/port differs | `kubectl -n kube-system get svc kube-state-metrics`; fix the static target in `02-`; restart Prometheus. |
| `kubernetes-cadvisor` (`403`) | Missing `nodes/proxy` RBAC | Re-apply `01-rbac.yaml`; `rollout restart sts/prometheus`. |
| `hope-apps` | Wrong Service name/port, or `/metrics` not plaintext | Check the keep-regex and that each app returns Prometheus text. See "app metrics" below. |
| `vllm` / `stt-gpu` | GPU host/firewall/endpoint | From a pod, `curl http://192.168.112.2:9000/metrics`; fix networking/Endpoints. |
| `node-exporter-gpu` | GPU agent not installed/stopped | Complete `07-gpu-server.md`; `docker ps` on the host. |
| `alertmanager`/`prometheus` | Pod not ready | Check the pod; this usually resolves once the pod is Running. |

Diagnose a specific target from Prometheus logs:

```bash
kubectl -n $NS logs sts/prometheus --tail=200 | grep -iE 'error|refused|403|no such host'
```

---

## 2. App metrics missing (`hope-apps`)

| Symptom | Cause | Fix |
|---|---|---|
| Target down, `context deadline exceeded` | Service port ≠ container port | Endpoint SD should use the real port; verify `kubectl -n $APP_NS get endpoints <svc>`. The gateway is published on `8866` but listens on `8868`. |
| `/metrics` returns HTML/`307` | Non-Prometheus endpoint (admin-console) | Exclude from the regex; give it a logs-only dashboard (already done). |
| Metric names ambiguous across apps | Same metric name on multiple apps | Filter by `{job="hope-apps", app="hope-<name>"}`. |
| Target up but panel empty | Metric name/type mismatch | Check the exact metric with `curl <pod>:<port>/metrics | grep <name>`, then adjust the panel expression in `generate.py`. |

---

## 1. Logs missing in Grafana

| Symptom | Cause | Fix |
|---|---|---|
| No logs at all | Promtail not running / not pushing | `kubectl -n $NS get pods -l app=promtail` (6/6). Check `promtail` logs and its `/metrics` (`promtail_sent_bytes_total`). |
| Logs have a timestamp prefix on every line | Missing CRI stage | Ensure `- cri: {}` is in the Promtail pipeline (it is in `13-`). |
| `kubernetes_sd_configs` yields 0 targets | Known on this cluster | This is why we use the **static glob**. Do not switch back to role: pod. |
| Loki returns `entry ... timestamp too old` (Promtail logs `400`) | Backfilling old logs | Expected on GPU-box first start; the bundle drops `older_than: 6h`. For in-cluster Promtail, it resumes from the positions file. |
| Loki `429` / `ingestion rate limited` | Too high a log rate | Raise `limits_config.ingestion_rate_mb` in `11-loki-config.yaml`, or use Option B to drop namespaces. Restart Loki. |
| Grafana Explore → Loki errors | Datasource unreachable | `kubectl -n $NS get svc loki`; check Grafana datasource `/health`; confirm `url: http://loki:3100`. |
| GPU logs missing (job=vllm/stt) | Promtail on GPU host not running / NodePort unreachable | `07-gpu-server.md` §6/§8. |

---

## 1. Grafana dashboards don't appear

| Symptom | Cause | Fix |
|---|---|---|
| Fewer than 13 dashboards | ConfigMap not applied, or Grafana not restarted | Re-apply `07-`, then `kubectl -n $NS rollout restart deploy/grafana`. Grafana 13 loads file-provisioned dashboards at startup. |
| Pod still shows old file list | Mounted ConfigMap not synced | Restart Grafana (guarantees remount). |
| Panel shows "Datasource not found" | Dashboard uid mismatch | Datasources must be `uid: prometheus` / `uid: loki`. Regenerate via `generate.py`. |
| New panel missing after edit | Edited the YAML, not the generator | Edit `generate.py`, re-run it, re-apply, restart Grafana. |

Verify the ConfigMap keys and the in-pod files:

```bash
kubectl -n $NS get cm grafana-dashboards -o jsonpath='{.data}' | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))'   # 13
kubectl -n $NS exec deploy/grafana -- ls /var/lib/grafana/dashboards
```

---

## 1. Grafana login / credentials

| Symptom | Cause | Fix |
|---|---|---|
| Login fails with the new password | Password only applies on **first** init on an empty volume | Reset it (see `10-day2-operations.md`): `grafana cli admin reset-admin-password`. |
| `GF_SECURITY_ADMIN_PASSWORD` unknown | Secret missing a key | Recreate the Secret with both keys; restart Grafana. |
| Cookie/login loop behind proxy | `GF_SECURITY_COOKIE_SECURE` mismatch | It is `false` (works over HTTP and HTTPS). If you only reach Grafana over HTTPS, you may set `true`. |
| Locked out entirely | — | Reset via `grafana cli` (below). |

```bash
kubectl -n $NS exec deploy/grafana -- \
  grafana cli --homepath /usr/share/grafana admin reset-admin-password "$(kubectl -n $NS get secret grafana-admin -o jsonpath='{.data.GF_SECURITY_ADMIN_PASSWORD}' | base64 -d)"
kubectl -n $NS rollout restart deploy/grafana
```

---

## 1. Ingress / DNS / Cloudflare

| Symptom | Cause | Fix |
|---|---|---|
| Hostname doesn't resolve | No DNS record / grey cloud | Add the public hostname on the tunnel; ensure the auto CNAME is **Proxied**. |
| Every host returns `404` | `httpHostHeader` set on the tunnel route | Remove it; Traefik routes on the original Host header. |
| `502`/timeout | Traefik has Ingress but backend not ready, or connector down | Check the Service/pod; check `cloudflared` pod. |
| `SSL_ERROR`/handshake, cert error | Two-level subdomain not covered by free cert | Use single-label hosts (`grafana-vox2.arcaai.com`). |
| Host resolves but wrong service | Ingress backend points at wrong Service | `kubectl -n $NS get ingress -o yaml`. |

```bash
kubectl -n $NS get ingress
kubectl -n $NS describe ingress hope-grafana
kubectl -n project-hope-vox logs deploy/cloudflared --tail=50
```

---

## 1. Alertmanager

| Symptom | Cause | Fix |
|---|---|---|
| Pod CrashLoop, config error | Old matcher syntax | Config must use `matchers`/`source_matchers`/`target_matchers` (v0.28). Already correct in `04-`. |
| Alerts never delivered | `null` receiver by design | Add a real receiver (see `10-day2-operations.md`). |
| Cannot silence alerts | UI reachable? | Ensure Alertmanager target `up` in Prometheus. |

---

## 1. GPU host issues

| Symptom | Cause | Fix |
|---|---|---|
| `ssh 192.168.112.2` times out | Host not on your LAN | Use the `socat` bounce pod (`07-gpu-server.md` §3). |
| SSH `Permission denied (publickey,...)` from the bounce | Wrong key/user | Use the correct user/key, or password auth with `sshpass`. Authorize your key on the host. |
| `docker compose up` fails | Docker/Compose missing | Install Docker + compose plugin. |
| `node-exporter` not scraped | Host `:9100` blocked / in use | `curl localhost:9100/metrics` on the host; check for port conflict; verify from a cluster pod. |
| GPU logs mislabeled | `vllm-whisper` matched `whisper` first | Keep the **vllm rule last** in `promtail-gpu.yml` (it is). |
| Config edit not taking effect | Mounted file not reloaded | `docker restart hope-promtail`. |
| Promtail `400 timestamp too old` | Backfill | Handled by `drop older_than: 6h`; transient at first start. |

---

## 1. Performance / cardinality

| Symptom | Cause | Fix |
|---|---|---|
| Loki slow / OOM | Too many label streams | Keep labels minimal (`namespace/pod/container/node/job`); never label by request/user id. |
| Prometheus high memory | Too many series (cAdvisor is heavy) | Reduce retention (`--storage.tsdb.retention.time`) or narrow the `kubernetes-cadvisor` job. |
| Grafana slow with long ranges | Huge log volume | Use log-volume panels with `$__interval`, not raw log lines, for wide ranges. |

---

## Diagnostic command cheat-sheet

```bash
NS=project-hope-vox-infra

kubectl -n $NS get pods,svc,pvc,cm
kubectl -n $NS describe pod <pod>
kubectl -n $NS logs <pod> --all-containers --tail=100
kubectl -n $NS events --sort-by=.lastTimestamp | tail -30

kubectl -n $NS port-forward svc/prometheus 9090:9090 &
curl -s 'http://localhost:9090/api/v1/targets' | python3 -m json.tool | less
curl -s 'http://localhost:9090/api/v1/rules'   | python3 -m json.tool | less

kubectl -n $NS port-forward svc/loki 3100:3100 &
curl -s http://localhost:3100/ready
curl -s http://localhost:3100/loki/api/v1/label/namespace/values

kubectl -n $NS port-forward svc/grafana 3000:3000 &
curl -s http://localhost:3000/api/health

kubectl -n $NS logs ds/promtail --tail=50
kubectl -n $NS get pod -l app=promtail -o wide
```

---

## Reset / clean slate (destructive — wipes data)

```bash
# Remove workloads (keeps PVCs because of the Retain policy)
kubectl -n $NS delete deploy/grafana sts/prometheus sts/alertmanager sts/loki ds/promtail ds/node-exporter

# Wipe the data too (DESTRUCTIVE)
kubectl -n $NS delete pvc grafana-data data-prometheus-0 data-alertmanager-0 data-loki-0

# then re-apply from 02-core-stack.md
```
