# Observability Stack — Step-by-Step Deployment Runbook

This folder is a **complete, beginner-friendly runbook** for reproducing the
observability stack that is already used on the `project-hope` cluster: the
**Core-3** tools (**Prometheus + Alertmanager + Grafana**), the **Loki/Promtail**
logging pipeline, node/application **metrics scraping**, the **13 Grafana
dashboards**, public access through **Traefik + Cloudflare**, and the **off-cluster
GPU server** telemetry.

Follow the files **in order**. Each step says exactly what to type, what you
should see, and what to do if it did not work.

> **Audience:** someone who has `kubectl` access to the cluster but has never
> deployed Prometheus/Loki/Grafana before. No prior observability knowledge is
> assumed. Every command is copy-pasteable.

---

## 0. What you will build

You will end up with this (all in the Kubernetes namespace
`project-hope-vox-infra`, except the GPU agents which run on a separate host):

```
                                   Internet
                                      │  HTTPS (grafana-vox2.arcaai.com, ...)
                                      ▼
                         ┌───────────────────────────┐
                         │  Cloudflare (DNS + tunnel) |  public hostnames
                         └────────────┬──────────────┘
                                      │ tunnel connector (in-cluster)
                                      ▼
                         ┌───────────────────────────┐
                         │  Traefik  (IngressClass)   │
                         └────────────┬──────────────┘
              ┌───────────────────────┼───────────────────────┐
              ▼                       ▼                       ▼
        ┌───────────┐          ┌────────────┐          ┌───────────────┐
        │  Grafana  │          │ Prometheus │          │ Alertmanager  │
        │  (3000)   │◄────────►│  (9090)    │─────────►│   (9093)      │
        └─────┬─────┘  query   └─────┬──────┘  alerts  └───────────────┘
              │                      │ scrape
              │          ┌───────────┼───────────┬───────────────┬───────────┐
              ▼          ▼           ▼           ▼               ▼           ▼
        ┌──────────┐ ┌────────┐ ┌─────────┐ ┌──────────┐ ┌────────────┐ ┌───────────┐
        │  Loki    │ │ node-  │ │ kube-   │ │ cAdvisor │ │ HOPE apps  │ │ GPU box   │
        │ (3100)   │ │exporters│ │state-  │ │ (kubelet │ │ /metrics   │ │ node-exp  │
        │          │ │(6 nodes)│ │metrics │ │  proxy)  │ │ (7 pods)   │ │ :9100     │
        └────┬─────┘ └────────┘ └─────────┘ └──────────┘ └────────────┘ └───────────┘
             ▲ push                                                    ▲
             │                                                         │ scrape
        ┌────┴─────┐                                             (direct, off-cluster)
        │ Promtail │  in-cluster DaemonSet (6/6 nodes)
        └──────────┘
             ▲ push (NodePort 31100)
        ┌────┴─────┐
        │ Promtail │  on the GPU host (192.168.112.2) → vLLM + STT logs
        └──────────┘
```

**Component summary**

| Layer | Software | Where | Purpose |
|---|---|---|---|
| Metrics store | Prometheus v3.13.2 | `project-hope-vox-infra` | Scrape + store + alert |
| Alert routing | Alertmanager v0.28.1 | `project-hope-vox-infra` | Dedupe/route alerts (null receiver by default) |
| Dashboards | Grafana 13.1.2 | `project-hope-vox-infra` | Visualise metrics (Prometheus) + logs (Loki) |
| Logs store | Loki 3.7.8 | `project-hope-vox-infra` | Store container logs |
| Log shipper | Promtail 3.6.11 | DaemonSet (cluster) + compose (GPU box) | Tail logs → Loki |
| Host metrics | node-exporter v1.9.1 | DaemonSet (cluster) + compose (GPU box) | CPU/mem/disk/net per host |
| Cluster objects | kube-state-metrics | `kube-system` (already present) | `kube_*` metrics |
| Container metrics | cAdvisor (kubelet) | scraped via API proxy | Per-pod CPU/mem |
| App metrics | HOPE services `/metrics` | `project-hope-vox` | Per-app HTTP + inference metrics |
| GPU inference | vLLM + STT `/metrics` | GPU host `192.168.112.2` | Inference + host metrics |

---

## How to use this runbook

Read the files **in order**. Each one starts with what you need before it and ends
with a verification step. Do not skip the verification steps.

| # | File | What it covers |
|---|---|---|
| 0 | `README.md` (this file) | Overview, prerequisites, variables, conventions |
| 1 | [`01-prerequisites.md`](./01-prerequisites.md) | Tools, cluster access, storage, namespace, secret, environment discovery |
| 2 | [`02-core-stack.md`](./02-core-stack.md) | Deploy Prometheus, Alertmanager, Grafana (manifests `01`–`10`) |
| 3 | [`03-logging.md`](./03-logging.md) | Deploy Loki + Promtail + the Loki NodePort (`11`–`14`) |
| 4 | [`04-metrics-scraping.md`](./04-metrics-scraping.md) | node-exporter, kube-state-metrics, cAdvisor, app + GPU targets (`15` + Prometheus jobs) |
| 5 | [`05-dashboards.md`](./05-dashboards.md) | Generate + apply the 13 Grafana dashboards (`07`) |
| 6 | [`06-ingress-dns-cloudflare.md`](./06-ingress-dns-cloudflare.md) | Public hostnames via Traefik + Cloudflare tunnel |
| 7 | [`07-gpu-server.md`](./07-gpu-server.md) | Install telemetry on the GPU host `192.168.112.2` |
| 8 | [`08-verification.md`](./08-verification.md) | End-to-end checklist (run this when you think you're done) |
| 9 | [`09-troubleshooting.md`](./09-troubleshooting.md) | Every known failure mode and its fix |
| 10 | [`10-day2-operations.md`](./10-day2-operations.md) | Upgrades, config edits, backups, teardown, extending |
| A | [`appendix-file-map.md`](./appendix-file-map.md) | Every file in this folder and what it does |

**Recommended first pass:** do parts 1–6 to get metrics + logs + dashboards working
entirely inside the cluster, verify with `08`, then do Part 7 (GPU box) and re-run
`08`.

---

## Conventions used in this documentation

1. **Shell prompts.** Commands are shown without the `$` prompt so you can copy
   them directly. Lines beginning with `#` inside a block are comments.

2. **Placeholders.** Values that depend on your environment appear in
   `<ANGLE_BRACKETS>`. Everything you might need to change is collected in the
   **Variables worksheet** below — fill it in once, then use the values.

3. **Environment variables.** Where practical we `export` a shell variable once
   (e.g. `NS`) so later commands are short. If a shell session is closed, re-run
   the `export` lines from [Variables used throughout](#variables-used-throughout-fill-this-in).

4. **"Expected result"** blocks show what a healthy command looks like. If you see
   something else, jump to `09-troubleshooting.md`.

5. **`kubectl` context** — all commands assume your current context points at the
   target cluster. Verify with `kubectl config current-context` (Step 1).

6. All YAML lives in **`../manifests/`** (relative to this folder). The runbook
   assumes your working directory is the repository root
   (`/Users/<you>/repos/VOX`). Adjust if yours differs.

---

## The "existing setup" this runbook assumes

This is a **reproduction over an existing cluster**, not a from-scratch cluster
build. Take as given (verify in `01-prerequisites.md`):

- A working **Kubernetes** cluster (this repo targets kubeadm v1.29, 6 nodes) with
  `kubectl` access.
- **Traefik** installed as the default `IngressClass` (in namespace
  `project-hope-vox`).
- **`nfs-client` StorageClass** (default; all PVCs use it).
- Two namespaces: **`project-hope-vox`** (applications) and
  **`project-hope-vox-infra`** (infra + this stack).
- A **Cloudflare tunnel** named `hope-vox2` with an in-cluster connector.
- **HOPE application services** exposing `/metrics` (used by per-app dashboards).
- A **GPU host** on the node LAN at `192.168.112.2` running vLLM (`:9000`) and STT
  (`:8862`), wired into the cluster via selector-less Services/Endpoints.

If any of these is missing, the corresponding runbook step says what to do.

---

## Variables used throughout (fill this in)

Adapt these to your environment. The values shown are the ones this repo uses.

| Variable | Meaning | This repo's value |
|---|---|---|
| `NS` | Infra namespace | `project-hope-vox-infra` |
| `APP_NS` | Applications namespace | `project-hope-vox` |
| `DOMAIN` | Base domain | `arcaai.com` (hosts are single-label, e.g. `grafana-vox2.arcaai.com`) |
| `STORAGE_CLASS` | StorageClass for PVCs | `nfs-client` |
| `INGRESS_CLASS` | IngressClass | `traefik` |
| `TUNNEL` | Cloudflare tunnel name | `hope-vox2` |
| `GPU_HOST` | GPU server IP (LAN) | `192.168.112.2` |
| `GPU_SSH_USER` | Login user on the GPU host | e.g. `root` or `sumankumar` |
| `NODE_IP` | Any cluster node IP (for NodePort access) | e.g. `192.168.112.6` |
| `LOKI_NODEPORT` | NodePort for GPU log shipping | `31100` |

Sane defaults for a shell session:

```bash
export NS=project-hope-vox-infra
export APP_NS=project-hope-vox
export GPU_HOST=192.168.112.2
export NODE_IP=192.168.112.6
export LOKI_NODEPORT=31100
```

> **Tip:** keep these in a file like `~/obs.env` and `source ~/obs.env` in new
> shells.

---

## Golden rules (read once)

1. **Apply manifests in numeric order.** They are numbered `01`–`15` for a reason.
2. **Config changes need a pod restart.** Prometheus renders its config on the
   emptyDir via an initContainer; Loki/Promtail/Grafana read mounted ConfigMaps on
   start. After editing any config ConfigMap you must restart the relevant workload
   (each step shows the exact command).
3. **Never expose Loki or the Prometheus/Alertmanager admin APIs publicly.** Loki
   has no auth; the Prometheus/Alertmanager UIs have no auth. See
   `06-ingress-dns-cloudflare.md`.
4. **Do not commit secrets.** The Grafana admin password is created out-of-band
   (`01-prerequisites.md`).
5. **Verify after every phase.** Each document ends with checks; the final
   `08-verification.md` is the authoritative checklist.

---

## Files in the parent folder (what you'll be applying)

The runbook references these manifests (do not edit them for a standard deploy —
they are already cluster-corrected):

| File | Purpose |
|---|---|
| `manifests/01-rbac.yaml` | Prometheus ServiceAccount + ClusterRole(-Binding) |
| `manifests/02-prometheus-config.yaml` | Prometheus config **template** + alert rules |
| `manifests/03-prometheus.yaml` | Prometheus StatefulSet + Service |
| `manifests/04-alertmanager-config.yaml` | Alertmanager config (v0.28 syntax) |
| `manifests/05-alertmanager.yaml` | Alertmanager StatefulSet + Service |
| `manifests/06-grafana-provisioning.yaml` | Grafana datasources + dashboard provider |
| `manifests/07-grafana-dashboards.yaml` | **Generated** — the 13 dashboards |
| `manifests/08-grafana-permissions.yaml` | Grafana PVC + chown Job |
| `manifests/09-grafana.yaml` | Grafana Deployment + Service |
| `manifests/10-ingress.yaml` | Traefik Ingresses for the 3 UIs |
| `manifests/11-loki-config.yaml` | Loki config |
| `manifests/12-loki.yaml` | Loki StatefulSet + Service |
| `manifests/13-promtail.yaml` | Promtail DaemonSet (+ SA) |
| `manifests/14-loki-nodeport.yaml` | Loki NodePort `31100` (GPU shipper) |
| `manifests/15-node-exporter.yaml` | node-exporter DaemonSet (all nodes) |
| `manifests/grafana-secret.yaml.example` | **Example only** — not applied |
| `dashboards/generate.py` | Source of truth for dashboards → `07` |
| `gpu-box/*` | Telemetry bundle for the GPU host |

See `appendix-file-map.md` for the full list including GPU-box files.

---

Start here → [`01-prerequisites.md`](./01-prerequisites.md)
