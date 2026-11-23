# Cloudflared / Traefik Findings

This folder documents how HOPE v2 is exposed to the internet through a
Cloudflare Tunnel and Traefik. It was **re-checked against the actual lab
cluster** on 2026-10-13 — earlier notes described a *different* estate, so read
the provenance first.

## Read this first (what is current vs. initial investigation)

| Category | Files | Meaning |
|---|---|---|
| **Current — follow these** | `steps_to_follow.md`, `manifests/`, `vox2-arcaai-com-routing.md` | The **final plan**: expose HOPE on `vox2.arcaai.com` via a **new dedicated tunnel `hope-vox2`** + the Helm Traefik already in the cluster |
| **Live state** | `current-setup.md` | What `kubectl` shows today on the kubeadm lab cluster (context `kubernetes-admin@kubernetes`) |
| **Background / initial investigation** | `traefik-k3s-findings.md`, `cloudflare-tunnel-reference.md`, `reference/` | Notes about the **reference estate** (`taphuynh.dev`, **k3s**-bundled Traefik, `hope-v2-dev` tunnel). Keep for context — **they do NOT describe the lab cluster or the vox2 plan** |

> Where these two disagree, the live cluster wins: the lab cluster is **kubeadm**
> (not k3s) and runs **Helm Traefik `v3.7.14`** in `project-hope-vox`, not
> k3s-bundled `3.6.9` in `kube-system`.

## Contents

| File | Purpose |
|---|---|
| `README.md` | This index + condensed summary of every finding |
| `steps_to_follow.md` | **Start here** — full ordered runbook: Cloudflare dashboard -> Kubernetes -> GPU server (new dedicated `hope-vox2` tunnel) |
| `current-setup.md` | **Live cluster state** of `project-hope-vox` and `project-hope-vox-infra` captured with `kubectl` |
| `vox2-arcaai-com-routing.md` | **Confirmed** `vox2.arcaai.com` hostname -> backend mapping for the arcaai.com domain |
| `manifests/` | Dedicated connector, Traefik Ingresses, STT external Service, and rollout steps for `vox2.arcaai.com` |
| `traefik-k3s-findings.md` | **Initial investigation (reference estate):** Traefik version and deployment on the k3s/taphuynh.dev setup — NOT the lab cluster |
| `cloudflare-tunnel-reference.md` | Points to the canonical `arca-deployment-template/blob/main/docs/cloudflare-tunnel.md` (reference estate) and relates it to these findings |
| `reference/` | Verbatim copies of the canonical manifests/doc (reference estate), for offline reading |

## Summary of findings

### 0. Live cluster (captured 2026-10-13, see `current-setup.md`)

- The HOPE cluster is **kubeadm** (Rocky Linux 9.7, k8s `v1.29.15`, 6 nodes),
  **not k3s** — so the k3s-bundled-Traefik story below does not describe this
  cluster.
- Traefik here is a **self-installed Helm release** (`traefik-41.7.1`, app
  **`v3.7.14`**) in namespace `project-hope-vox`. `IngressClass: traefik` is the
  **only** class and is marked **default** (there is no `nginx` IngressClass).
  Service is `LoadBalancer` with
  `EXTERNAL-IP: <pending>` (no LB provisioner) -> only NodePorts **32067/31815**.
- **Traefik routes nothing yet**: there are no `Ingress`/`IngressRoute`/
  `Middleware` resources in either HOPE namespace. All apps are reached by
  NodePort today (`api-gateway :32458`, `admin-console :32540`, ...).
- **No HOPE Cloudflare Tunnel**: the only `cloudflared` on the cluster lives in
  `arcafabric`. No TLS/cert-manager either.
- **STT is off-cluster**: it runs as Docker containers on the lab server
  `192.168.112.2` (`hope-stt`, `hope-stt-worker`, `stt-service`), reached directly
  by the gateway via `STT_URL=http://192.168.112.2:8862`.

### 1. Traefik version (reference estate — taphuynh.dev)

> Re-checked against the live lab cluster: the version that matters there is
> **Helm `traefik-41.7.1` / app `v3.7.14`** (`current-setup.md` §3), not the
> k3s figure below. The k3s `3.6.9` applies to the reference estate only.

- **No Traefik version is pinned in the Arca manifests.**
  `Arca-AgenticSystemDeployment/traefik/values.yaml` and its AWS mirror
  `AWS/k8s/traefik/values.yaml` set no image tag, and the install instructions run
  `helm upgrade --install traefik traefik/traefik` with no `--version`
  (`Arca-AgenticSystemDeployment/traefik/README.md:34`).
- The design doc flags this: `Arca-AgenticSystemDeployment/HIGH_LEVEL_DESIGN.md:1006`
  lists Traefik among unpinned images that use `latest` tags.
- The only **concrete version** recorded anywhere is the **k3s-bundled** image
  `rancher/mirrored-library-traefik:3.6.9`, in
  `project-hope/docs/archive/TASK-984-Public-Storage-Download-Endpoint/README.md:43`.
- The reference k3s cluster is single-node `v1.34.5+k3s1` with Traefik/servicelb
  **not** disabled (`project-hope/docs/archive/TASK-616-.../live-state-2026-08.md:16`).

### 2. How Traefik is deployed (reference estate — k3s)

> Again: the lab cluster is **not** k3s — Traefik there is a self-installed Helm
> release in `project-hope-vox` (`traefik.project-hope-vox.svc.cluster.local:80`),
> which is exactly what `steps_to_follow.md` targets.

- k3s **bundles Traefik v3** in the `kube-system` namespace, managed by the k3s
  helm-controller, with `IngressClass` named `traefik`. On a stock k3s cluster you
  **configure** it, you do not install it. Installing the Arca Helm chart on top would
  create a second controller.
- It is disabled only when k3s is started with `--disable=traefik`; this cluster does
  not disable it.
- External traffic reaches it via an **in-cluster `cloudflared` tunnel** that forwards
  `*.taphuynh.dev` to `traefik.kube-system.svc.cluster.local:80` — confirmed by the
  canonical doc and `deployment/k8s/base/cloudflared.yaml`.

### 3. Deployment-path discrepancies to be aware of

- The `Arca-AgenticSystemDeployment/traefik/` manifests target a **self-installed**
  Traefik in its own `traefik` namespace, exposed on **NodePort 30080**, with a
  **file provider** for middlewares. The **real** HOPE v2 deployment instead uses the
  **bundled** Traefik in `kube-system` (ClusterIP `:80`) and relies on the bundled
  chart's default Kubernetes **Ingress + CRD** providers. Reusing the Arca manifests
  requires: service DNS `traefik.traefik...` -> `traefik.kube-system...`, and
  middlewares `@file` -> `@kubernetescrd`.
- The canonical `docs/cloudflare-tunnel.md` lives on the `main` branch of
  `arca-deployment-template`, not in the default working tree (see
  `cloudflare-tunnel-reference.md`).

### 4. The Cloudflare Tunnel request path (from the canonical doc)

> For the lab cluster (`vox2.arcaai.com`) the only difference at the origin hop
> is the Traefik DNS: `traefik.project-hope-vox.svc.cluster.local:80` instead of
> `traefik.kube-system...` (`steps_to_follow.md`).

```
client -> Cloudflare edge (TLS terminated here)
       -> cloudflared pod (outbound QUIC/HTTP2, no inbound port)
       -> traefik.kube-system.svc.cluster.local:80 (plain HTTP, Host header UNCHANGED)
       -> Ingress (matched on Host) -> Service -> pod
```

- **TLS terminates at the Cloudflare edge only.** No cert-manager and no `tls:` block in
  the cluster; adding one without an Issuer yields a self-signed cert that looks secure.
- **The Host header is the whole design.** `cloudflared` has exactly one HTTP rule — a
  catch-all to Traefik — and does **not** set `originRequest.httpHostHeader`, so the
  client's original Host reaches Traefik, which is the only thing it routes on.
- **Adding a public HTTP hostname never edits `cloudflared.yaml`**: one Ingress + one
  proxied CNAME. Only non-HTTP (TCP/SSH) rules are added there, **above** the catch-all.
- **No trailing `http_status:404` rule** after the catch-all: a rule with no hostname
  *is* the catch-all, and `cloudflared` rejects a config with anything after it
  (`ingress validate` fails, CrashLooping both connectors).

### 5. Guardrails worth keeping

- Pin the connector image by digest (`cloudflare/cloudflared:2026.8.3@sha256:...` in the
  canonical deployment), not `:latest`.
- Run two replicas with `maxUnavailable: 0`, a `/ready` readiness probe and `/metrics`
  liveness probe, so rollouts never drop the tunnel.
- Bump the `cloudflared.hope/config-revision` pod annotation whenever the ConfigMap
  changes — `cloudflared` reads its config once at startup.
- The tunnel token is a `Secret` created out of band and must never be committed.
- Cloudflare Tunnel is transport, not authorization: most hostnames are unauthenticated
  or behind a single shared `X-Service-Token`. `vault-dev`, `db-dev`, `db-dev-read` and
  `temporal` need Cloudflare Access.

## Sources reviewed

- `Arca-AgenticSystemDeployment/traefik/` (`values.yaml`, `dynamic-config.yaml`,
  `cloudflared-deployment.yaml`, `cloudflared-configmap.yaml`, `README.md`)
- `Arca-AgenticSystemDeployment/HIGH_LEVEL_DESIGN.md`
- `arca-deployment-template@main:docs/cloudflare-tunnel.md` (canonical)
- `arca-deployment-template@main:deployment/k8s/base/cloudflared.yaml`
- `project-hope/docs/research/deployments/deploy-ct101-cloudflare-tunnel.md`
- `project-hope/docs/research/deployments/deploy-vm200-k3s-gpu.md`
- `project-hope/docs/archive/TASK-984-Public-Storage-Download-Endpoint/README.md`
- `project-hope/docs/archive/TASK-616-Deployment-CICD-Observability-Modernization/live-state-2026-08.md`
- `review/deploy/11-traefik-ingress-setup.md`
