# Current Setup — `project-hope-vox` + `project-hope-vox-infra`

Live cluster state captured with `kubectl` on 2026-10-13 (context
`kubernetes-admin@kubernetes`).

---

## 0. Cluster facts

| Field | Value |
|---|---|
| Distribution | **kubeadm** (NOT k3s) |
| Kubernetes | `v1.29.15` |
| Container runtime | `containerd://2.2.3` |
| OS | Rocky Linux 9.7 (Blue Onyx), kernel `5.14.0-503.14.1.el9_5` |
| Nodes | `master-node-1` (control-plane) + `worker-node-1..5` |
| Node IPs | `192.168.112.6` (master), `.7`–`.11` (workers) |
| IngressClass | **`traefik`** is the **only** class and is marked **default** (`ingressclass.kubernetes.io/is-default-class: "true"`); there is **no `nginx` IngressClass object** |

> Note: this cluster is **not** k3s, so the earlier "k3s bundles Traefik in
> `kube-system`" finding does not apply. Here Traefik is a **self-installed Helm
> release** (see §3).

### Namespaces relevant to HOPE
| Namespace | Role | Age |
|---|---|---|
| `project-hope-vox` | Application plane (HOPE services + Traefik) | 6d8h |
| `project-hope-vox-infra` | Data/infra plane (Temporal, Vault, Postgres, Qdrant, Redis, Silo) | 6d4h |

(An unrelated `cloudflare-tunnel` deployment runs in the `arcafabric` namespace, 33d.)

---

## 1. `project-hope-vox` — workloads

| Workload | Ready | Image | Node |
|---|---|---|---|
| `deploy/hope-api-gateway` | 1/1 | `192.168.112.13:5000/hope-v2/api:sha-dacdc311e` | worker-node-4 |
| `deploy/hope-admin-console` | 1/1 | `192.168.112.13:5000/admin-console:v2` | worker-node-2 |
| `deploy/hope-guardrail` | 1/1 | `192.168.112.13:5000/guardrail:latest` | worker-node-2 |
| `deploy/hope-harness` | 1/1 | `192.168.112.13:5000/hope-harness:latest` | worker-node-1 |
| `deploy/hope-harness-worker` | 1/1 | `192.168.112.13:5000/hope-harness-worker:latest` | worker-node-4 |
| `deploy/hope-nlp` | 1/1 | `192.168.112.13:5000/nlp:latest` | worker-node-4 |
| `deploy/hope-text` | 1/1 | `192.168.112.13:5000/hope-text:latest` | worker-node-3 |
| `deploy/hope-tts` | 1/1 | `192.168.112.13:5000/hope-tts:latest` | worker-node-1 |
| `deploy/traefik` | 1/1 | `docker.io/traefik:v3.7.14` | worker-node-3 |

PVC: `hope-nlp-cache` 10Gi RWX (`nfs-client`).

---

## 2. `project-hope-vox` — Services

| Service | Type | Port -> NodePort | Endpoint |
|---|---|---|---|
| `hope-api-gateway-svc` | NodePort | 8866 -> **32458** | `172.16.200.147:8868` |
| `hope-admin-console-svc` | ClusterIP | 3000 | `172.16.19.149:3000` |
| `hope-admin-console-svc-1776` | NodePort | 3000 -> **32540** | `172.16.19.149:3000` |
| `hope-guardrail-svc` (+`-5762`) | ClusterIP / NodePort | 8863 -> 30858 | `172.16.19.170:8863` |
| `hope-harness-svc` (+`-9399`) | ClusterIP / NodePort | 8866 -> 31665 | `172.16.212.105:8866` |
| `hope-nlp-svc` (+`-9207`) | ClusterIP / NodePort | 8864 -> 31765 | `172.16.200.151:8864` |
| `hope-text-svc` (+`-2038`) | ClusterIP / NodePort | 8862 -> 30366 | `172.16.8.246:8862` |
| `hope-tts-svc` (+`-5834`) | ClusterIP / NodePort | 8865 -> 30906 | `172.16.212.106:8865` |
| **`traefik`** | **LoadBalancer** | 80 -> **32067**, 443 -> **31815** | `172.16.8.252:8000,8443` |

> `traefik` Service has `EXTERNAL-IP: <pending>` — the cluster has **no
> LoadBalancer provisioner** (no MetalLB/cloud LB), so only the **NodePorts
> 32067/31815** are actually reachable from outside the cluster.

---

## 3. Traefik (Helm) — the core of the ingress strategy

Install method: **Helm**, release `traefik` in namespace `project-hope-vox`.

| Field | Value |
|---|---|
| Helm chart | `traefik-41.7.1` |
| App version | **`v3.7.14`** |
| Image | `docker.io/traefik:v3.7.14` |
| Release revision | 1 |
| USER-SUPPLIED VALUES | *(none — chart defaults)* |
| Deployed | 2026-10-12 03:09 |

### Container args (effective config)
```
--entryPoints.web.address=:8000/tcp
--entryPoints.websecure.address=:8443/tcp          # tls=true
--entryPoints.traefik.address=:8080/tcp            # dashboard
--entryPoints.metrics.address=:9100/tcp
--providers.kubernetescrd
--providers.kubernetescrd.allowEmptyServices=true
--providers.kubernetesingress
--providers.kubernetesingress.allowEmptyServices=true
--providers.kubernetesingress.ingressendpoint.publishedservice=project-hope-vox/traefik
--api.dashboard=true
--ping=true
--metrics.prometheus=true
--log.level=INFO
```

### RBAC / support objects
- ServiceAccount `traefik`
- ClusterRole + ClusterRoleBinding `traefik-project-hope-vox`
- IngressClass `traefik` (`traefik.io/ingress-controller`)
- Traefik CRDs installed (chart): `ingressroutes`, `middlewares`,
  `serverstransports`, `tlsoptions`, `traefikservices`, `middlewaretcps`, etc.
  (plus `*.hub.traefik.io` API-management CRDs)

---

## 4. `project-hope-vox-infra` — workloads

| Workload | Ready | Image | Node |
|---|---|---|---|
| `deploy/temporal` | 1/1 | `temporalio/auto-setup:1.25.1` | worker-node-1 |
| `deploy/temporal-ui` | 1/1 | `temporalio/ui:2.34.0` | worker-node-3 |
| `deploy/vault-store` | 1/1 | `hashicorp/vault:1.18.3` | worker-node-4 |
| `sts/postgres-pgvector-db` | 1/1 | `timescale/timescaledb-ha:pg18-all` | worker-node-2 |
| `sts/qdrant-store` | 1/1 | `qdrant/qdrant:v1.19.0` | worker-node-5 |
| `sts/redis-store` | 1/1 | `redis:8-alpine` | worker-node-4 |
| `sts/silo-object-store` | 1/1 | `pgsty/silo` | worker-node-5 |

ConfigMaps: `vault-store-cm-0`, `vault.hcl`. Secrets: none (empty). PVCs:
postgres 64Gi, qdrant 10Gi, redis 20Gi, silo 150Gi, vox-db 1Gi (all `nfs-client`).

### Services
| Service | Type | Port -> NodePort | Endpoint |
|---|---|---|---|
| `postgres-pgvector-db-svc` (+`-8436`) | ClusterIP / NodePort | 5432 -> 32251 | `172.16.19.133:5432` |
| `qdrant-store-svc` (+`-6340`) | ClusterIP / NodePort | 6333 -> 30661 | `172.16.181.227:6333` |
| `redis-store-svc` (+`-6433`) | ClusterIP / NodePort | 6379 -> 32522 | `172.16.200.160:6379` |
| `silo-object-store-svc` (+`-3627`) | ClusterIP / NodePort | 9000 -> 32631 | `172.16.181.228:9000` |
| `silo-object-store-svc-4633` | NodePort | 9001 -> 30372 | `172.16.181.228:9001` |
| `temporal-svc` | ClusterIP | 7233 | `172.16.212.75:7233` |
| `temporal-ui-svc` | NodePort | 8080 -> 31888 | `172.16.8.222:8080` |
| `vault-store-svc` (+`-2824`) | ClusterIP / NodePort | 8200 -> 32367 | `172.16.200.156:8200` |

---

## 5. Ingress / routing state (the important gap)

- **There are NO `Ingress`, `IngressRoute`, `Middleware`, or `TLSOption`
  resources in either namespace.** Traefik is running and watching, but currently
  routes **nothing**.
- All traffic reaches the apps through **NodePorts** today
  (`api-gateway :32458`, `admin-console :32540`, `temporal-ui :31888`, etc.).
- Ingresses elsewhere on the cluster (`rubix`, `supabase`, `supabase-ak`) declare
  `ingressClassName: nginx`, but **no `nginx` IngressClass exists** — Traefik is
  the sole class and is marked default. (Those nginx-classed Ingresses are
  therefore served by Traefik, or by nothing.)
- **No cert-manager / TLS certs**; `websecure` entrypoint exists but has no
  certificates.

### How the apps are wired today (env = IP:port, pre-ingress)
From `deploy/hope-api-gateway`:
```
URL=http://192.168.112.6:32458
ADMIN_CONSOLE_URL=http://192.168.112.6:32540
STT_URL=http://192.168.112.2:8862
NLP_URL=http://hope-nlp-svc.project-hope-vox.svc.cluster.local:8864
TTS_URL=http://hope-tts-svc.project-hope-vox.svc.cluster.local:8865
TEXT_URL=http://hope-text-svc.project-hope-vox.svc.cluster.local:8862
HARNESS_URL=http://hope-harness-svc.project-hope-vox.svc.cluster.local:8866
GUARDRAIL_URL=http://hope-guardrail-svc.project-hope-vox.svc.cluster.local:8863
DATABASE_URL=postgresql://postgres:postgres@postgres-pgvector-db-svc.project-hope-vox-infra.svc.cluster.local:5432/hope
REDIS_URL=redis://:<pass>@redis-store-svc.project-hope-vox-infra.svc.cluster.local:6379/0
VAULT_ADDR=http://vault-store-svc.project-hope-vox-infra.svc.cluster.local:8200
MINIO_ENDPOINT=silo-object-store-svc.project-hope-vox-infra.svc.cluster.local:9000
SECRETS_PROVIDER=vault
```
`deploy/hope-admin-console`:
```
API_URL=http://192.168.112.6:32458
NEXT_PUBLIC_API_HOST=http://192.168.112.6:32458
NODE_ENV=development
```

Cross-namespace service DNS used: `*.project-hope-vox.svc.cluster.local` and
`*.project-hope-vox-infra.svc.cluster.local`.

---

## 6. Cloudflare Tunnel state

- No `cloudflared` deployment in either HOPE namespace.
- The only tunnel on the cluster is `arcafabric/cloudflare-tunnel` (1/1 Running,
  33d) — unrelated to HOPE.

So at present HOPE is **not** exposed through Cloudflare from within these
namespaces; access is NodePort-only, consistent with the IP:port env above.

### 6.1 The `arcafabric/cloudflare-tunnel` (NOT used — a dedicated tunnel is planned)

> The vox2 plan does **not** touch this tunnel. The final decision is a **new,
> dedicated `hope-vox2` tunnel** (dashboard-managed, token-only). This section is
> kept only to document the pre-existing tunnel we inspected and chose not to
> reuse. Ignore it when deploying `vox2.arcaai.com`.

| Field | Value |
|---|---|
| Namespace / name | `arcafabric/cloudflare-tunnel` |
| Image | `cloudflare/cloudflared:latest` — process reports **`2026.8.3` (outdated; recommends `2026.10.0`)** |
| Replicas / node | 1/1 Running, 33d, `worker-node-1` |
| Mode | `tunnel --no-autoupdate run --token <inline>` (dashboard-managed, **no `config.yaml`**) |
| Health observed | Registers edge connections (BOM/MAA PoPs) but logs repeated `quic` dial timeouts and DNS resolver failures — **flaky** |

Because it is token-only, **all routing is managed in the Cloudflare dashboard**
(Zero Trust -> Networks -> Tunnels -> Public Hostnames); nothing edits the
cluster to add an HTTP hostname.

Inspect it:

```bash
kubectl -n arcafabric get deploy cloudflare-tunnel -o wide
kubectl -n arcafabric get pods -l app=cloudflare-tunnel -o wide
kubectl -n arcafabric get deploy cloudflare-tunnel -o yaml      # token is inline here
kubectl -n arcafabric logs deploy/cloudflare-tunnel -f
kubectl -n arcafabric logs deploy/cloudflare-tunnel --tail=50 | grep -Ei "registered|error|warn"
```

---

## 7. External STT service (out-of-cluster, Docker on a lab server)

STT is **not** a Kubernetes workload. It runs as **Docker containers on a separate
lab server at `192.168.112.2`** and is reached over the LAN from inside the cluster.

| Container | Image | Host port -> container port | Status |
|---|---|---|---|
| `hope-stt` | `hope-v2/stt-ml-runtime:sha-dacdc311e` | `0.0.0.0:8862 -> 8861/tcp` | Up 5 days (unhealthy) |
| `hope-stt-worker` | `hope-v2/stt-worker:sha-dacdc311e` | `8861/tcp`, `0.0.0.0:9192 -> 9191/tcp` | Up 5 days (unhealthy) |
| `stt-service` | `stt:ml` | `0.0.0.0:8861 -> 8861/tcp` | Up 4 days (unhealthy) |

Notes:
- The in-cluster `hope-api-gateway` env points at it directly:
  `STT_URL=http://192.168.112.2:8862` — which is exactly the `hope-stt` container's
  host mapping.
- Two images share the tag `sha-dacdc311e` with the API gateway
  (`hope-v2/api:sha-dacdc311e`) — same CI build.
- `stt:ml` also binds host `:8861`, colliding with `hope-stt`'s container port; on
  the host only `hope-stt` publishes to `8862` and `stt-service` to `8861`.
- All three containers report **`unhealthy`** despite running for days.

---

## 8. Observations / gaps

1. **Traefik installed but unused** — no Ingress/CRD routes exist; the whole
   platform still runs on NodePorts. The 20h-old Traefik release is stage-one only.
2. **Wrong topology vs the target docs** — the canonical
   `arca-deployment-template` design expects k3s bundled Traefik +
   `traefik.kube-system.svc.cluster.local:80` + an in-cluster `cloudflared`
   catch-all. This cluster is kubeadm, runs Traefik in `project-hope-vox`, and has
   no HOPE tunnel.
3. **LoadBalancer has no external IP** — only NodePorts reach Traefik; a tunnel or
   an LB (MetalLB) is required for a stable front door.
4. **No TLS** — `websecure` is defined but empty; no cert-manager.
5. **Unpinned images** — several `:latest` tags (`guardrail`, `harness`,
   `harness-worker`, `nlp`, `text`, `tts`) and `admin-console:v2`.
6. **Plaintext secrets in env** — `REDIS_PASS`, `VAULT_SECRET_ID`, `VAULT_ROLE_ID`,
   `ADMIN_SESSION_SECRET` are inline; `project-hope-vox-infra` has **no** Secrets.
7. **Duplicate `-svc-<n>` NodePort services** — each ClusterIP service has a
   parallel NodePort suffixed service (auto-generated), doubling the surface.
8. **STT lives off-cluster** — the STT runtime runs in Docker on the lab server
   `192.168.112.2`, not in Kubernetes, and is reached directly by IP:port
   (`STT_URL=http://192.168.112.2:8862`). All three STT containers report
   **`unhealthy`**, yet the gateway depends on them.

---

## 9. How this was collected

In-cluster (context `kubernetes-admin@kubernetes`):
```bash
kubectl config current-context
kubectl get nodes -o wide
kubectl get ns
kubectl get ingressclass
kubectl get ingress -A
kubectl get crd | grep -i traefik
kubectl -n project-hope-vox get deploy,sts,ds,pods -o wide
kubectl -n project-hope-vox get svc,ingress,ingressroute,middleware,servicetransport
kubectl -n project-hope-vox get endpoints,pvc,configmap,secret
kubectl -n project-hope-vox get deploy traefik -o yaml
helm -n project-hope-vox list
helm -n project-hope-vox get values traefik
helm -n project-hope-vox get manifest traefik
kubectl -n project-hope-vox-infra get deploy,sts,ds,pods,svc,ingress,endpoints,pvc,configmap,secret
```

Off-cluster STT host (`192.168.112.2`, reported by operator):
```bash
docker ps
```
