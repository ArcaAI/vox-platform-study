# vox2.arcaai.com — Confirmed Routing Scheme

Confirmed hostname plan for exposing HOPE on the `arcaai.com` domain (registered
at Cloudflare, NS `anastasia/miguel.ns.cloudflare.com`).

- **Main domain:** `arcaai.com` / `www.arcaai.com`
- **Zone of record:** `arcaai.com` (Cloudflare, proxied)
- **Root subdomain:** `vox2.arcaai.com`
- **Hostname pattern:** `<service>.vox2.arcaai.com`

This mirrors the hostname inventory in the canonical
`arca-deployment-template@main:docs/cloudflare-tunnel.md`
(snapshot: `reference/cloudflare-tunnel.md`), but re-parented under
`vox2.arcaai.com` and mapped to the **actual** services found in
`current-setup.md` (the docs and the live cluster differ).

> **Status: CONFIRMED (final, 2026-10-13).** Supersedes the older draft that
> proposed reusing the `arcafabric` tunnel — the final decision is a **new,
> dedicated tunnel `hope-vox2`** (see §4 #1). No cluster or Cloudflare changes
> have been applied yet; the ordered runbook is `steps_to_follow.md`.

> **Which hostnames are in scope:** the final plan publishes **11 hostnames**
> (§1a/§1b below, excluding the not-deployed/optional rows). `grafana.vox2`,
> `vllm.vox2`, `lmstudio.vox2`, `db.vox2`, `db-ro.vox2` are **out of scope** —
> their Services do not exist or need tunnel-level TCP routing.

---

## 1. Hostname -> backend mapping

### 1a. Served by Traefik (in-cluster HTTP)

Fronted by the Helm-installed Traefik in namespace `project-hope-vox`
(`IngressClass: traefik`).

| Public hostname | K8s Service | Service port | Notes |
|---|---|---|---|
| `vox2.arcaai.com` | `hope-admin-console-svc` | 3000 | Root also opens the admin console |
| `admin.vox2.arcaai.com` | `hope-admin-console-svc` | 3000 | Same backend as root |
| `api.vox2.arcaai.com` | `hope-api-gateway-svc` | 8866 | Gateway container listens on 8868 |
| `text.vox2.arcaai.com` | `hope-text-svc` | 8862 | |
| `tts.vox2.arcaai.com` | `hope-tts-svc` | 8865 | |
| `guardrail.vox2.arcaai.com` | `hope-guardrail-svc` | 8863 | |
| `nlp.vox2.arcaai.com` | `hope-nlp-svc` | 8864 | |
| `harness.vox2.arcaai.com` | `hope-harness-svc` | 8866 | Present in cluster; **not** in canonical doc |
| `vault.vox2.arcaai.com` | `vault-store-svc` (ns `project-hope-vox-infra`) | 8200 | Cross-namespace; see §4 |
| `temporal.vox2.arcaai.com` | `temporal-ui-svc` (ns `project-hope-vox-infra`) | 8080 | UI only; frontend 7233 stays unpublished |
| `grafana.vox2.arcaai.com` | `grafana` | 3000 | Only if the observability stack is in this cluster |
| `vllm.vox2.arcaai.com` | `hope-vllm` | 8000 | Not currently deployed (canonical `replicas: 0`) |
| `lmstudio.vox2.arcaai.com` | `hope-lmstudio` | 1234 | Selector-less Service + hand-written Endpoints |

> **Observability hostnames (added 2026-10-15).** The Core-3 stack (Grafana,
> Prometheus, Alertmanager) is now being deployed to `project-hope-vox-infra` —
> see `../observability/README.md`. This promotes `grafana.vox2.arcaai.com`
> from "commented out" to **in scope** and adds **two new** hosts:
> `prometheus.vox2.arcaai.com` and `alertmanager.vox2.arcaai.com`. The published
> count becomes **14 hostnames** (not 11). All three point at
> `http://traefik.project-hope-vox.svc.cluster.local:80` like the rest, and the
> click-by-click **Cloudflare dashboard steps** live in
> `../observability/README.md` **§3d**.

### 1b. Off-cluster backend (the STT GPU box) — wrapped in a cluster Service

| Public hostname | Backend | Notes |
|---|---|---|
| `stt.vox2.arcaai.com` | `hope-stt` Service (selector-less) -> `192.168.112.2:8862` (Docker on the GPU lab server) | **In scope.** The `hope-stt` Service + `Endpoints` make the off-cluster backend a normal in-cluster Service for Traefik. See §3 and `manifests/stt-external-service.yaml` |

### 1c. Out of scope — TCP hostnames (from the canonical doc)

These need a **direct `cloudflared` TCP rule**, not an Ingress/Traefik, and are
**NOT part of the 11-hostname plan**. Listed for reference only.

| Public hostname | Backend | Notes |
|---|---|---|
| `db.vox2.arcaai.com` | `tcp://postgres-pgvector-db-svc.project-hope-vox-infra:5432` | Needs a direct `cloudflared` TCP rule, not an Ingress |
| `db-ro.vox2.arcaai.com` | second DB host, if replicated | Not present in `project-hope-vox-infra` today |

---

## 2. Request path

```
client -> Cloudflare edge (TLS terminated)
       -> cloudflared tunnel to  <host>.vox2.arcaai.com
       -> traefik.project-hope-vox.svc.cluster.local:80   (Host header UNCHANGED)
       -> Ingress rule (spec.rules[].host) -> Service -> pod
```

- TLS terminates at the Cloudflare edge; the cluster hop is plain HTTP.
- Traefik routes on the original `Host`; the tunnel must **not** set
  `originRequest.httpHostHeader`.
- Adding a new HTTP hostname = one Ingress + one proxied CNAME; the tunnel's
  catch-all handles it. Only STT (external) and the `tcp://` DB routes need a
  tunnel-level rule.

---

## 3. STT (special case — external GPU server)

STT runs in Docker on `192.168.112.2`, published as `0.0.0.0:8862 -> 8861`. Two
options were considered:

- **Option A (cluster-native):** create a selector-less `Service` +
  `Endpoints` `hope-stt` in `project-hope-vox` pointing at
  `192.168.112.2:8862`, then a normal Ingress for `stt.vox2.arcaai.com`. Keeps
  all HTTP routing in Traefik.
- **Option B (tunnel-level):** add a rule **above** the catch-all in the
  `cloudflared` config: `hostname: stt.vox2.arcaai.com -> http://192.168.112.2:8862`.
  Bypasses Traefik; simpler but splits routing across two places.

> **Decision (2026-10-13): Option A.** Implemented in
> `manifests/stt-external-service.yaml`; the gateway already calls STT as a
> normal URL, and the new `hope-vox2` tunnel is token-only, so there is no
> `config.yaml` in which a per-host rule could even be written.

---

## 4. Decisions (confirmed)

1. **Tunnel — NEW dedicated tunnel `hope-vox2`** (created in the Cloudflare
   dashboard, token-only, **independent of the existing `arcafabric` tunnel**).
   Each public hostname is added in the dashboard and points at
   `http://traefik.project-hope-vox.svc.cluster.local:80`. The older draft
   ("reuse `arcafabric/cloudflare-tunnel`") is **superseded**; `arcafabric` is
   unrelated to HOPE and is left untouched.
2. **Cross-namespace Ingress** — `vault` and `temporal` Ingresses are declared in
   `project-hope-vox-infra` (Traefik's ClusterRole watches all namespaces).
3. **STT** — **Option A** (confirmed, §3): selector-less `hope-stt` Service +
   `Endpoints` -> `192.168.112.2:8862`, routed through Traefik.
4. **Scope** — the final plan publishes **11 hostnames**: `vox2`, `admin`, `api`,
   `text`, `stt`, `tts`, `guardrail`, `nlp`, `harness`, `vault`, `temporal`.
   `harness` and `temporal` are active; `vllm`, `lmstudio`, `grafana` are
   **commented out** in `manifests/ingress-vox2-apps.yaml` until their Services
   exist; `db`/`db-ro` TCP routes are **out of scope**.
5. **Typo** — `vault.vo2.arcaai.com` interpreted as `vault.vox2.arcaai.com`.
6. **CORS** — required: no `arcaai.com` row exists today; add
   `https://vox2.arcaai.com` and `https://*.vox2.arcaai.com:*` for the ArcaAI
   tenant (see `manifests/README.md` and `steps_to_follow.md` §2.5).
7. **TLS** — no certs / no cert-manager; TLS terminates at Cloudflare only.

Manifests: `manifests/` (see `manifests/README.md` for apply order and the
Cloudflare + CORS steps). Run-before-anything: `steps_to_follow.md`.

---

## 5. Next steps (once confirmed)

All of this is already written up, in order, in **`steps_to_follow.md`** (Part 1
Cloudflare dashboard -> Part 2 Kubernetes -> Part 3 GPU server):

1. Create the tunnel `hope-vox2` and its 11 public hostnames in the dashboard.
2. Apply the Traefik `Ingress` objects (one per host) in the correct namespaces.
3. Apply the STT Service/Endpoints (Option A).
4. Add the `TenantAllowedOrigin` rows for the `vox2.arcaai.com` origins.
5. Confirm the proxied CNAMEs Cloudflare auto-creates for each hostname.

---

## Related

- `current-setup.md` — the live cluster state this mapping is based on
- `reference/cloudflare-tunnel.md` — canonical hostname inventory
- `cloudflare-tunnel-reference.md` — how the canonical doc relates to these findings
