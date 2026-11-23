# vox2.arcaai.com — Manifests & Rollout Steps

Deliverables for exposing HOPE on `vox2.arcaai.com` via the existing Traefik
(Helm) and a **new, dedicated Cloudflare Tunnel (`hope-vox2`)** — independent of
the existing `arcafabric` tunnel.

> **Start with `../steps_to_follow.md`** — the full ordered runbook (Cloudflare
> dashboard -> Kubernetes -> GPU server). This file summarizes the manifests.

> These are the review artifacts. Per the canonical design
> (`cloudflare-tunnel-reference.md`), the durable copy belongs in the GitOps
> deployment repo (`arca/hope-v2-deployment`) and should be applied by Argo, not
> ad-hoc `kubectl`.

## Confirmed decisions

| Decision | Choice |
|---|---|
| Cloudflare tunnel | **New dedicated tunnel `hope-vox2`** (dashboard-managed public hostnames) |
| STT (off-cluster GPU box) | **Cluster-native selector-less Service + Endpoints** -> Traefik |
| Undeployed services (`vllm`, `lmstudio`, `grafana`) | **Commented out** until the Service exists |

## Files

| File | Namespace | Contents |
|---|---|---|
| `cloudflared-hope-vox2.yaml` | `project-hope-vox` | Dedicated connector Deployment + metrics Service (token via Secret) |
| `ingress-vox2-apps.yaml` | `project-hope-vox` | Middleware + ServersTransport, and Ingresses for `vox2.arcaai.com`, `admin`, `api`, `text`, `tts`, `guardrail`, `nlp`, `harness`, `stt` |
| `stt-external-service.yaml` | `project-hope-vox` | Selector-less `hope-stt` Service + `Endpoints` -> `192.168.112.2:8862` |
| `ingress-vox2-infra.yaml` | `project-hope-vox-infra` | Ingresses for `vault` (`vault-store-svc:8200`) and `temporal` (`temporal-ui-svc:8080`) |

## Apply order

```bash
# 0. Tunnel token Secret (from the Cloudflare dashboard; see steps_to_follow.md 1.2)
kubectl -n project-hope-vox create secret generic cloudflared-tunnel-token \
  --from-literal=token='<TUNNEL_TOKEN>'

# 1. Dedicated connector
kubectl apply -f manifests/cloudflared-hope-vox2.yaml

# 2. STT external backend first (so the Ingress has a target)
kubectl apply -f manifests/stt-external-service.yaml

# 3. Application-plane Ingresses + streaming middleware
kubectl apply -f manifests/ingress-vox2-apps.yaml

# 4. Infra-plane Ingresses (vault, temporal)
kubectl apply -f manifests/ingress-vox2-infra.yaml

# 5. Verify Traefik picked them up
kubectl get ingress -A | grep vox2
kubectl -n project-hope-vox port-forward svc/traefik 9000:8080
#   -> http://localhost:9000/dashboard/  (routers per host)
```

## Cloudflare steps (dedicated `hope-vox2` tunnel — dashboard-managed)

For **every** hostname below, add a **Public Hostname** on the new `hope-vox2`
tunnel (Zero Trust -> Networks -> Tunnels -> the tunnel -> Public Hostnames),
with **Service = `http://traefik.project-hope-vox.svc.cluster.local:80`**.
Cloudflare auto-creates the CNAME. Full walkthrough: `../steps_to_follow.md` Part 1.

| Public hostname | Target |
|---|---|
| `vox2.arcaai.com` | `http://traefik.project-hope-vox.svc.cluster.local:80` |
| `admin.vox2.arcaai.com` | `http://traefik.project-hope-vox.svc.cluster.local:80` |
| `api.vox2.arcaai.com` | `http://traefik.project-hope-vox.svc.cluster.local:80` |
| `text.vox2.arcaai.com` | `http://traefik.project-hope-vox.svc.cluster.local:80` |
| `stt.vox2.arcaai.com` | `http://traefik.project-hope-vox.svc.cluster.local:80` |
| `tts.vox2.arcaai.com` | `http://traefik.project-hope-vox.svc.cluster.local:80` |
| `guardrail.vox2.arcaai.com` | `http://traefik.project-hope-vox.svc.cluster.local:80` |
| `nlp.vox2.arcaai.com` | `http://traefik.project-hope-vox.svc.cluster.local:80` |
| `harness.vox2.arcaai.com` | `http://traefik.project-hope-vox.svc.cluster.local:80` |
| `vault.vox2.arcaai.com` | `http://traefik.project-hope-vox.svc.cluster.local:80` |
| `temporal.vox2.arcaai.com` | `http://traefik.project-hope-vox.svc.cluster.local:80` |

**Do NOT set `originRequest.httpHostHeader`** — Traefik routes on the original
Host; overriding it collapses every hostname and 404s the platform. **Do NOT add
a per-host HTTP rule to a `config.yaml`** — the tunnel's catch-all already
forwards everything.

> Because the connector runs token-only (`--token`, no `config.yaml`), all HTTP
> routing is dashboard-managed; there is nothing to edit in the cluster to add a
> hostname. (The old `arcafabric` tunnel is unaffected and can be ignored.)

## CORS allow-list (REQUIRED for browser apps)

The gateway admits browser origins only from the DB registry. There is **no
`arcaai.com` row** today, so the console served from `vox2.arcaai.com` will be
refused until rows are added (see `../../project-hope/packages/database/src/prisma/db_main/seed/11b-tenant-allowed-origins.ts`).

Add for the **ArcaAI** tenant (admin console page `/allowed-origins`, or the seed
`../../project-hope/packages/database/src/prisma/db_main/seed/11b-tenant-allowed-origins.ts`).
The `*` pattern row requires a **super-admin** caller.
| origin | tenant | label |
|---|---|---|
| `https://vox2.arcaai.com` | ArcaAI | HOPE v2 admin console (root) |
| `https://*.vox2.arcaai.com:*` | ArcaAI | HOPE v2 services (any subdomain, https) |

The wildcard covers `admin/api/text/stt/tts/guardrail/nlp/harness/...` and any
future subdomain. Add exact rows instead of the wildcard if you prefer tighter
scope.

## App env changes (build-time for the console)

The admin console currently points at the NodePort (`http://192.168.112.6:32458`).
For `vox2`, rebuild with the public API host:

| Var | Where | New value |
|---|---|---|
| `NEXT_PUBLIC_API_HOST` | console (BUILD arg) | `https://api.vox2.arcaai.com` |
| `API_URL` | console (server/BFF) | `http://hope-api-gateway-svc.project-hope-vox.svc.cluster.local:8866` |
| `ADMIN_CONSOLE_URL` | gateway | `https://vox2.arcaai.com` |
| `STT_URL` | gateway | `http://hope-stt:8862` (via the new Service) |

`NEXT_PUBLIC_API_HOST` is inlined at build time; a running pod keeps the old
value until the image is rebuilt. `ADMIN_CONSOLE_URL` is **CORS guidance only**
(no code reads it for origin admission — that is the DB registry above), and
`STT_URL` is optional (the gateway already reaches `192.168.112.2:8862` over the
LAN; switching to `http://hope-stt:8862` just makes the Service the reference
point). Full rationale: `../steps_to_follow.md` §2.6.

## Verify

```bash
curl -I https://vox2.arcaai.com
curl -I https://admin.vox2.arcaai.com
curl -I https://api.vox2.arcaai.com/api/v1/health/ready
curl -I https://stt.vox2.arcaai.com
# WS/SSE (expect 101 / text/event-stream, not 502/504):
curl -i -H "Origin: https://vox2.arcaai.com" https://api.vox2.arcaai.com/ws/stt/stream
```
