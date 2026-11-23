# 01 — Prerequisites

**Goal:** confirm everything the stack depends on already exists, install the few
command-line tools you need, create the one Secret the deploy requires, and record
your environment's values so later steps are copy-paste.

> You will **not** create the cluster, Traefik, the StorageClass, the namespaces or
> the Cloudflare tunnel here — this runbook deploys *observability over an existing
> setup*. This document verifies they exist and helps you fix gaps.

---

## 1. Tools you need on the machine you run `kubectl` from

| Tool | Why | Check | Install (macOS) |
|---|---|---|---|
| `kubectl` | Talk to the cluster | `kubectl version --client` | `brew install kubectl` |
| `python3` | Run the dashboard generator | `python3 --version` | `brew install python` |
| `openssl` | Generate the Grafana password | `openssl version` | preinstalled |
| `curl` | Verify endpoints | `curl --version` | preinstalled |
| `sshpass` *(only for GPU setup)* | Non-interactive SSH to the GPU host | `which sshpass` | `brew install hudochenkov/sshpass/sshpass` |
| `docker` *(only on the GPU host)* | Run the telemetry bundle there | `docker version` *(on the GPU host)* | — |

A one-liner to check everything at once:

```bash
for t in kubectl python3 openssl curl; do
  printf '%-10s ' "$t"; command -v "$t" >/dev/null && "$t" --version 2>&1 | head -1 || echo "MISSING"
done
```

Expected: every tool prints a version. `sshpass`/`docker` are optional at this
stage.

---

## 2. Verify cluster access

```bash
kubectl config current-context
kubectl cluster-info | head -2
kubectl get nodes -o wide
```

**Expected:** your context name, the API server URL, and a node list. This repo's
cluster has 6 nodes:

```
NAME             STATUS   ROLES
master-node-1    Ready    control-plane
worker-node-1    Ready    <none>
worker-node-2    Ready    <none>
worker-node-3    Ready    <none>
worker-node-4    Ready    <none>
worker-node-5    Ready    <none>
```

> **Record your node IPs** — you'll need one for the GPU-box NodePort step:
> ```bash
> kubectl get nodes -o wide --no-headers | awk '{print $1, $6}'
> ```

If `kubectl` cannot connect, fix your kubeconfig first. Everything else depends on
this.

---

## 3. Verify the required cluster facilities

### 3.1 StorageClass `nfs-client`

```bash
kubectl get storageclass
```

Expected: `nfs-client` present (usually marked `(default)`). Every PVC in this
stack requests `nfs-client`. If your cluster uses a different class, replace
`storageClassName: nfs-client` in `03-`, `05-`, `08-`, `12-` manifests, or set your
class as the default.

### 2. IngressClass `traefik`

```bash
kubectl get ingressclass
```

Expected: a class named `traefik`, usually `(default)`.

### 3. Required namespaces

```bash
kubectl get ns project-hope-vox project-hope-vox-infra
```

Expected:

```
project-hope-vox        Active   ...
project-hope-vox-infra  Active   ...
```

If `project-hope-vox-infra` is missing, create it:

```bash
kubectl create namespace project-hope-vox-infra
```

### 4. Traefik and the Cloudflare connector are running

```bash
kubectl -n project-hope-vox get pods | grep -iE 'traefik|cloudflared'
```

Expected: `traefik-...` and `cloudflared-...` pods `Running`. If the tunnel
connector is absent, you cannot publish hostnames; see the cloudflared folder
(`../cloudflared/`) — but you can still complete everything except the public
hostnames.

---

## 3.5 (Optional) Confirm the pods you will monitor exist

These make the app/GPU dashboards meaningful. Missing pieces don't block the core
stack — the dashboards simply show no data for them.

```bash
# HOPE application pods (expected: api-gateway, guardrail, harness, nlp, text, tts, ...)
kubectl -n project-hope-vox get pods -o wide

# Kubernetes object metrics source
kubectl -n kube-system get deploy kube-state-metrics
```

> **Note the container ports.** Endpoint-based scraping uses the pod's real
> container port, which can differ from the Service port. This runbook already
> encodes the correct ports, but if you change services, re-check with
> `04-metrics-scraping.md`.

---

## 4. Create the Grafana admin Secret (required)

The Grafana Deployment reads two keys from a Secret named `grafana-admin`. It is
**never** committed to git (the example file `manifests/grafana-secret.yaml.example`
exists only to document it).

```bash
kubectl -n project-hope-vox-infra create secret generic grafana-admin \
  --from-literal=GF_SECURITY_ADMIN_USER=admin \
  --from-literal=GF_SECURITY_ADMIN_PASSWORD="$(openssl rand -hex 24)"
```

**Record the password now** — print it and save it somewhere safe:

```bash
kubectl -n project-hope-vox-infra get secret grafana-admin \
  -o jsonpath='{.data.GF_SECURITY_ADMIN_PASSWORD}' | base64 -d; echo
```

Verify:

```bash
kubectl -n project-hope-vox-infra get secret grafana-admin
```

Expected: a `grafana-admin` Secret of type `Opaque`.

> **Important:** the password is only applied on Grafana's **first** start on an
> empty volume. If you later change the Secret, reset the password explicitly —
> see `10-day2-operations.md`. If you skip this step, the Grafana pod will not
> start (`CreateContainerConfigError: secret "grafana-admin" not found`).

---

## 5. Namespace capacity sanity check

The stack requests modest resources. Confirm you have room:

```bash
kubectl -n project-hope-vox-infra describe resourcequota 2>/dev/null || echo "no ResourceQuota (fine)"
kubectl -n project-hope-vox-infra describe limitrange 2>/dev/null || echo "no LimitRange (fine)"
kubectl top nodes
```

Rough total the stack adds: ~1 CPU / ~2 GiB across Prometheus, Alertmanager,
Grafana, Loki, and 6× Promtail + 6× node-exporter. On 6 nodes this is negligible.

> `kubectl top nodes` requires metrics-server. If it errors, that's fine — it is
> unrelated to this stack (this runbook uses Prometheus, not metrics-server).

---

## 6. Firewall / network prerequisites

| Path | From → To | Port | Needed for |
|---|---|---|---|
| Kubernetes API | your machine → control plane | `6443` | everything |
| Prometheus → apps | `project-hope-vox-infra` → `project-hope-vox` | service ports | app metrics |
| Prometheus → GPU host | cluster → `192.168.112.2` | `9000`, `8862`, `9100` | GPU metrics |
| GPU Promtail → Loki | `192.168.112.2` → any node IP | `31100` (NodePort) | GPU logs |
| Browser → Grafana | internet → Cloudflare → Traefik | `443` | dashboards UI |
| you → GPU host (setup only) | your machine or a bounce pod → `192.168.112.2` | `22` | installing the GPU bundle |

The GPU host is **outside the pod network**; it must be reachable from the nodes
on the LAN. Confirm below (if the GPU host is not up yet, skip).

```bash
# Run from a cluster pod (proves cluster -> GPU reachability)
kubectl -n project-hope-vox-infra run netcheck --rm -i --restart=Never \
  --image=curlimages/curl:8.10.1 --quiet -- \
  sh -c 'for p in 9100 9000 8862; do printf "%s: ' $GPU_HOST; curl -s -o /dev/null -w "%{http_code}\n" --max-time 4 http://'"$GPU_HOST"':$p/metrics || echo DOWN; done'
```

If `9100` is DOWN now, that's expected — it is installed in
`07-gpu-server.md`. `9000` and `8862` should be `200` if the GPU services are
running.

---

## 7. Clock, timezone and retention (know before you deploy)

- **Clock skew breaks logs.** Loki rejects samples whose timestamp is too far in
  the past/future. Ensure the nodes and the GPU host have NTP synced. The GPU-box
  Promtail config additionally drops entries older than 6h to avoid backfilling
  history (see `07-gpu-server.md`).
- **Retention defaults:** Prometheus keeps `15d` / `10GB`; Loki keeps `30d`
  (`720h`). Adjust in `03-prometheus.yaml` / `11-loki-config.yaml` if disk is
  tight.
- **Storage sizes:** Prometheus `50Gi`, Alertmanager `10Gi`, Grafana `10Gi`,
  Loki `50Gi`. All on `nfs-client`.

---

## 8. Record your environment values

You will reuse these. Put them in `~/obs.env` and `source` it in each new shell:

```bash
cat > ~/obs.env <<'EOF'
export NS=project-hope-vox-infra
export APP_NS=project-hope-vox
export GPU_HOST=192.168.112.2
export GPU_SSH_USER=root
export NODE_IP=192.168.112.6
export LOKI_NODEPORT=31100
EOF
source ~/obs.env
echo "NS=$NS  GPU_HOST=$GPU_HOST  NODE_IP=$NODE_IP"
```

---

## 9. Phase checklist

Tick these before moving on:

- [ ] `kubectl` reaches the cluster; context confirmed.
- [ ] `nfs-client` StorageClass present.
- [ ] `traefik` IngressClass present.
- [ ] Namespaces `project-hope-vox` and `project-hope-vox-infra` exist.
- [ ] Traefik + cloudflared pods Running (for the public-hostname phase).
- [ ] Secret `grafana-admin` created; password saved.
- [ ] Cluster has spare capacity; no blocking ResourceQuota/PSA labels.
- [ ] `~/obs.env` written.

Next → [`02-core-stack.md`](./02-core-stack.md)
