# Reference: `arca-deployment-template/blob/main/docs/cloudflare-tunnel.md`

> **⚠️ REFERENCE ESTATE.** The canonical doc describes the **`taphuynh.dev`**
> deployment on a **k3s** cluster with the **`hope-v2-dev`** and **`arca-dev`**
> tunnels. The lab-cluster plan for **`vox2.arcaai.com`** differs in several
> load-bearing ways: the tunnel is a **new dedicated `hope-vox2`**, the target is
> `traefik.project-hope-vox.svc.cluster.local:80` (Helm Traefik), and the
> connector is **token-only** (no `config.yaml`). Read this for design rationale;
> apply `steps_to_follow.md` for the rollout.

This file points to, and relates the findings from, the canonical Cloudflare Tunnel
document for the HOPE v2 deployment.

## The referenced file

| Field | Value |
|---|---|
| Path | `arca-deployment-template/docs/cloudflare-tunnel.md` |
| Branch | `main` |
| Repo (local) | `/Users/apple/repos/VOX/arca-deployment-template` |
| Repo (remote) | `https://github.com/ArcaAI/arca-deployment-template` (private) |
| Git remote ref | `git show main:docs/cloudflare-tunnel.md` |
| Local copy | `reference/cloudflare-tunnel.md` (snapshot) |
| Title | "Cloudflare Tunnel — how HOPE v2 reaches the internet" |
| Status line | "current as of 2026-09-01 (TASK-847)" |
| Owns | `deployment/k8s/base/cloudflared.yaml`, `deployment/k8s/base/ingress.yaml` |

> **Locating note:** the file is **not** present in the default checkout
> (`feature/arca-deploy` branch) and the GitHub repo is private (a public API request
> returns `404`). It lives on `main`. Read it with
> `git -C /Users/apple/repos/VOX/arca-deployment-template show main:docs/cloudflare-tunnel.md`.
> A snapshot is kept at `reference/cloudflare-tunnel.md` in this folder so it can be read
> without switching branches.

## What the canonical doc establishes (and how it relates to these findings)

### Two tunnels, one rule
- **`hope-v2-dev`** tunnel (this repo's `base/cloudflared.yaml`, `config_src: local`):
  the **application plane** — HOPE services.
- **`arca-dev`** tunnel (managed on the Proxmox hypervisor / dashboard): the
  **infrastructure plane** — SSH, GitLab, registry, Rancher, Argo, MinIO external host.
- Rule: a Kubernetes Service in `hope-v2-dev` -> `hope-v2-dev` tunnel here; a LAN host ->
  `arca-dev` tunnel, not modelled in this repo.

### The request path (matches `traefik-k3s-findings.md`)
```
client -> Cloudflare edge (TLS terminated)
       -> cloudflared pod (hope-v2-dev, 2 replicas; outbound QUIC/HTTP2 only)
       -> traefik.kube-system.svc.cluster.local:80  (plain HTTP, Host header unchanged)
       -> Ingress spec.rules[].host -> Service -> pod
```
This is the decisive evidence for the **k3s bundled Traefik** finding: the target is
`traefik.kube-system.svc.cluster.local:80`, the k3s-bundled controller — not the Arca
self-installed `traefik.traefik.svc.cluster.local:80` (NodePort 30080).

### The Host-header design
- `cloudflared` has **one** HTTP rule — a catch-all to Traefik — and deliberately does
  **not** set `originRequest.httpHostHeader`.
- Traefik routes on the client's original `Host`; setting `httpHostHeader` would collapse
  every hostname to one value and 404 the whole platform.
- Consequence: **adding a public HTTP hostname touches only `ingress.yaml` + a DNS
  CNAME** — never `cloudflared.yaml`.

### Ingress table rules (from `reference/cloudflared.yaml`)
- TCP rules (`db`, `db-ro` for PostgreSQL) go **above** the HTTP catch-all because they
  cannot traverse Traefik (no Host in the Postgres wire protocol).
- The HTTP catch-all is **last**, and there is deliberately **no trailing
  `http_status:404`** — a rule with no hostname *is* the catch-all, and `cloudflared`
  rejects any rule after it (`ingress validate` fails -> both connectors CrashLoop).
- Short Service names (`tcp://hope-postgres-rw:5432`) are used so overlays stay portable.

### Connector hardening (from `reference/cloudflared.yaml`)
- Image pinned by **digest**: `cloudflare/cloudflared:2026.8.3@sha256:51c9cef...`.
- `replicas: 2`, `maxUnavailable: 0`, `maxSurge: 1` — rollouts never drop the tunnel.
- Readiness probe `/ready` (200 iff connected to the edge); liveness `/metrics` (weaker,
  avoids restart loops on WAN blips).
- `terminationGracePeriodSeconds: 60` drains in-flight streams.
- `cloudflared.hope/config-revision` pod annotation must be **bumped** when the ConfigMap
  changes (config is read once at startup).
- Token Secret `cloudflared-tunnel-token` created **out of band**, never committed.

### Security posture (the blunt section)
- Only one Cloudflare Access application exists in the estate (`server.taphuynh.dev`);
  every HOPE hostname is outside it.
- Must add Cloudflare Access before anything else: `vault-dev`, `db-dev`, `db-dev-read`,
  `temporal`; also recommended for `lmstudio-dev`, `vllm-dev`, service-token-only
  hostnames, and `grafana-dev`.

## Related findings in this folder

- `README.md` — index and condensed summary.
- `traefik-k3s-findings.md` — Traefik version and k3s deployment/configuration.
- `reference/cloudflare-tunnel.md` — snapshot of the canonical doc (branch `main`).
- `reference/cloudflared.yaml` — snapshot of `deployment/k8s/base/cloudflared.yaml`.
