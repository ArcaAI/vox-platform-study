# Steps to Follow — Expose HOPE v2 on `vox2.arcaai.com`

End-to-end runbook to publish the HOPE services under `vox2.arcaai.com` using a
**new, dedicated Cloudflare Tunnel** (independent of the existing `arcafabric`
tunnel), the **existing Traefik** already running in the cluster, and the
**off-cluster STT** running in Docker on the GPU lab server.

Three sections, in order:

1. **Cloudflare dashboard** (`dash.cloudflare.com`) — create the tunnel + public hostnames.
2. **Kubernetes server** — deploy the connector and the Traefik routing.
3. **GPU server** — make STT reachable from the cluster.

> Apply order matters: create the Cloudflare tunnel first (you need its token),
> then deploy the connector, then route.
>
> Companion manifests live in `manifests/`:
> `cloudflared-hope-vox2.yaml`, `stt-external-service.yaml`,
> `ingress-vox2-apps.yaml`, `ingress-vox2-infra.yaml`.

---

## Hostname inventory (what we are publishing)

| Public hostname | Backend | Reached via |
|---|---|---|
| `vox2.arcaai.com` | `hope-admin-console-svc:3000` | Traefik |
| `admin.vox2.arcaai.com` | `hope-admin-console-svc:3000` | Traefik |
| `api.vox2.arcaai.com` | `hope-api-gateway-svc:8866` | Traefik |
| `text.vox2.arcaai.com` | `hope-text-svc:8862` | Traefik |
| `stt.vox2.arcaai.com` | `192.168.112.2:8862` (GPU box) | Traefik -> selector-less Service |
| `tts.vox2.arcaai.com` | `hope-tts-svc:8865` | Traefik |
| `guardrail.vox2.arcaai.com` | `hope-guardrail-svc:8863` | Traefik |
| `nlp.vox2.arcaai.com` | `hope-nlp-svc:8864` | Traefik |
| `harness.vox2.arcaai.com` | `hope-harness-svc:8866` | Traefik |
| `vault.vox2.arcaai.com` | `vault-store-svc:8200` (ns `project-hope-vox-infra`) | Traefik |
| `temporal.vox2.arcaai.com` | `temporal-ui-svc:8080` (ns `project-hope-vox-infra`) | Traefik |

**Golden rule:** every HTTP hostname points at **Traefik**
(`http://traefik.project-hope-vox.svc.cluster.local:80`). Traefik does the
per-host routing. Never add a per-service target in Cloudflare, and never set
`httpHostHeader`.

---

## Part 1 — Cloudflare dashboard steps (`dash.cloudflare.com`)

### 1.1 Confirm the zone

- Log in at [dash.cloudflare.com](https://dash.cloudflare.com) and open the
  **`arcaai.com`** zone.
- Why: all hostnames must be created under this zone so the CNAMEs resolve
  through Cloudflare. Confirm status is **Active** and proxying is available.

### 1.2 Create a new dedicated tunnel

1. Go to **Zero Trust** -> **Networks** -> **Tunnels**.
2. Click **Create a tunnel**.
3. Connector type: **Cloudflared** -> **Next**.
4. Name it **`hope-vox2`** -> **Save tunnel**.
5. Choose the **Docker** environment (we only need its token, not its command).
6. **Copy the token** — the long `eyJ...` string in the shown command.
   - Why: the Kubernetes connector authenticates with this token; it also binds
     the tunnel to this account/zone.
   - Treat it as a secret. Do not commit it.

### 1.3 Add the public hostnames

For **each** hostname in the inventory, on the tunnel's **Public Hostnames**
tab -> **Add a public hostname**:

| Field | Value |
|---|---|
| Subdomain | `vox2` / `admin.vox2` / `api.vox2` / `text.vox2` / `stt.vox2` / `tts.vox2` / `guardrail.vox2` / `nlp.vox2` / `harness.vox2` / `vault.vox2` / `temporal.vox2` |
| Domain | `arcaai.com` |
| Path | *(leave empty)* |
| Type | **HTTP** |
| URL | **`traefik.project-hope-vox.svc.cluster.local:80`** |

- Why HTTP + Traefik DNS: the connector runs inside the cluster, so it can reach
  the Traefik Service by its cluster DNS name. TLS is terminated at Cloudflare;
  the hop to Traefik is plain HTTP.
- **Do NOT** expand "Additional application settings" -> "HTTP Settings" and set
  `httpHostHeader`. Leaving it unset forwards the client's original `Host`, which
  is the only thing Traefik routes on. Setting it makes every host 404.

> **Faster alternative (optional):** instead of 11 entries, add two —
> `vox2.arcaai.com` **and** `*.vox2.arcaai.com` (wildcard). Cloudflare supports
> wildcard public hostnames. A wildcard does **not** cover the apex, so the bare
> `vox2.arcaai.com` entry is still required for the root admin console URL.

### 1.4 Confirm the DNS records

- Saving a public hostname auto-creates a **proxied (orange-cloud) CNAME**
  `vox2... -> <tunnel-id>.cfargotunnel.com` in the **DNS** tab of the zone.
- Why proxied: a grey-clouded `*.cfargotunnel.com` CNAME resolves to nothing a
  client can reach. Leave the records proxied.

### 1.5 (Recommended) Protect sensitive hostnames with Cloudflare Access

- In **Zero Trust** -> **Access** -> **Applications**, create a **Self-hosted**
  app for `vault.vox2.arcaai.com` and `temporal.vox2.arcaai.com`, with a policy
  bound to your IdP.
- Why: Vault and the Temporal UI have no authentication of their own; publishing
  them without Access exposes them to anyone. Access runs at the edge, before the
  tunnel, so it protects backends that authenticate nothing themselves.

### 1.6 (Required for the console) Disable Cloudflare compression on `/api/hope/*`

- In the zone, add a **Configuration Rule** (Rules -> Configuration Rules) for
  `admin.vox2.arcaai.com` and `vox2.arcaai.com`, path `/api/hope/*`, setting
  **Compression** (and **Brotli** if shown) to **Off**.
- Why: Cloudflare recompresses responses and rewrites strong ETags (`"abc"`) to
  weak ones (`W/"abc"`), which breaks the console BFF's `If-Match`
  optimistic-concurrency writes (PATCH/DELETE to `/api/hope/*` start returning
  `412`/`428`). Documented failure on the existing Cloudflare-fronted console.

**Output of Part 1:** a tunnel token, and 11 public hostnames + DNS records.

---

## Part 2 — Kubernetes server steps

Run these against the `project-hope-vox` cluster (context
`kubernetes-admin@kubernetes`).

### 2.0 Preflight — confirm Traefik is the ingress authority

```bash
kubectl get ingressclass traefik
kubectl -n project-hope-vox get deploy,svc traefik
```

- Expected: IngressClass `traefik`
  (`traefik.io/ingress-controller`) and `deploy/traefik` 1/1 with
  `svc/traefik` exposing ports 80/443. This is the Helm release
  `traefik-41.7.1` (app `v3.7.14`).
- Why: the connector and all Ingresses below rely on this controller.

### 2.1 Create the tunnel token Secret

```bash
kubectl -n project-hope-vox create secret generic cloudflared-tunnel-token \
  --from-literal=token='<TUNNEL_TOKEN_FROM_STEP_1.2>'
```

- Why: the connector reads the token from the Secret via
  `secretKeyRef`, so it never appears in the manifest or in Git.
- Verify: `kubectl -n project-hope-vox get secret cloudflared-tunnel-token`.

### 2.2 Deploy the dedicated connector

```bash
kubectl apply -f manifests/cloudflared-hope-vox2.yaml
kubectl -n project-hope-vox rollout status deploy/cloudflared
kubectl -n project-hope-vox get pods -l app=cloudflared -o wide
```

- Why: this runs two `cloudflared` replicas with `maxUnavailable: 0`, a `/ready`
  readiness probe and `/metrics` liveness probe, on a digest-pinned image. Two
  replicas + readiness mean a rollout or a PoP blip never drops the tunnel.

### 2.3 Apply the STT backend (external GPU server)

```bash
kubectl apply -f manifests/stt-external-service.yaml
kubectl -n project-hope-vox get svc,endpoints hope-stt
```

- Why: STT is not a pod, so a selector-less `Service` + hand-written `Endpoints`
  gives Traefik a normal in-cluster backend (`192.168.112.2:8862`). This happens
  **before** the Ingress so the backend exists when the route is created.

### 2.4 Apply the Traefik Ingresses

```bash
kubectl apply -f manifests/ingress-vox2-infra.yaml   # vault, temporal (infra ns)
kubectl apply -f manifests/ingress-vox2-apps.yaml    # console, api, text, stt, tts, ...
kubectl get ingress -A | grep vox2
```

- Why: each Ingress declares `spec.rules[].host` = the public hostname and the
  backend Service. Traefik matches the incoming `Host` to this rule. The
  `api.vox2` Ingress carries the `hope-no-buffer` middleware annotation so
  WS/SSE streams (live transcription, LLM playground) are not buffered.
- The annotation value MUST be `project-hope-vox-hope-no-buffer@kubernetescrd`
  (namespace and name joined by a **dash**, then `@kubernetescrd`). Referencing a
  middleware that does not resolve makes Traefik **drop the router** (every
  `api.vox2.arcaai.com` request 404s), so confirm it renders in the Traefik
  dashboard after apply.
- The committed `ServersTransport` (`hope-long-streams`) is **optional** and is
  only active if you annotate the `hope-api-gateway-svc` Service with
  `traefik.ingress.kubernetes.io/service.serverstransport=project-hope-vox-hope-long-streams@kubernetescrd`
  (Traefik reads `service.*` annotations off the Service, not the Ingress).
  Traefik's default `responseHeaderTimeout` is already `0s`, so it is usually
  unnecessary.
- The `vllm`, `lmstudio`, `grafana` Ingresses are **commented out** in
  `ingress-vox2-apps.yaml` because those Services are not deployed yet; uncomment
  when they exist.

### 2.5 Register the browser origins (CORS) — required

The API gateway admits browser origins only from the DB registry
(`TenantAllowedOrigin`). There is **no `arcaai.com` row** today, so a browser
served from `vox2.arcaai.com` is refused until rows exist.

Add for the **ArcaAI** tenant (admin console page **`/allowed-origins`** — the API
behind it is `POST /api/v1/admin/allowed-origins`; or the seed
`11b-tenant-allowed-origins.ts`):

| origin | tenant | label |
|---|---|---|
| `https://vox2.arcaai.com` | ArcaAI | HOPE v2 admin console (root) |
| `https://*.vox2.arcaai.com:*` | ArcaAI | HOPE v2 services (any subdomain, https, any port) |

- Why: without these, API/STT/WS calls from the browser are rejected with
  `origin_registry_miss` (enforcement is default-ON, no env-var fallback).
- Strings must be **canonical** (`scheme://host[:port]`, lowercase, no path, no
  trailing slash). The row references must be minimal — no deviation.
- A **wildcard/pattern** origin (the `*` row) is refused unless the caller is a
  **super administrator**; a tenant admin can only add exact origins. Use a
  super-admin (SYSTEM-tier) account to add the `*` row.
- The pattern `*.vox2.arcaai.com` does **not** cover the apex, which is why the
  exact `https://vox2.arcaai.com` row above is separate. Both are required.

### 2.6 Point the app at the public hostnames

Update and redeploy:

| Var | Workload | New value |
|---|---|---|
| `NEXT_PUBLIC_API_HOST` | `hope-admin-console` (**build arg**) | `https://api.vox2.arcaai.com` |
| `API_URL` | `hope-admin-console` (server/BFF) | `http://hope-api-gateway-svc.project-hope-vox.svc.cluster.local:8866` |
| `ADMIN_CONSOLE_URL` | `hope-api-gateway` | `https://vox2.arcaai.com` |
| `STT_URL` | `hope-api-gateway` | `http://hope-stt:8862` (via the new Service), or keep `http://192.168.112.2:8862` |

- Why: `NEXT_PUBLIC_API_HOST` is inlined at build time, so the console image must
  be **rebuilt**; a running pod keeps the old value otherwise. The BFF should
  call cluster DNS, not hairpin through the public hostname.
- `ADMIN_CONSOLE_URL` is **CORS guidance only** — no code reads it for origin
  admission (that is the DB registry in step 2.5), so updating it is cosmetic.
- `STT_URL` is optional: the gateway already reaches STT directly over the LAN.
  Switching to `http://hope-stt:8862` only helps if you want the single Service
  as the reference point.

### 2.7 Verify

```bash
kubectl -n project-hope-vox logs deploy/cloudflared -f          # expect "Registered tunnel connection"
kubectl -n project-hope-vox get ingress -A | grep vox2
curl -I https://vox2.arcaai.com
curl -I https://admin.vox2.arcaai.com
curl -I https://api.vox2.arcaai.com/api/v1/health/ready
curl -I https://stt.vox2.arcaai.com
curl -i -H "Origin: https://vox2.arcaai.com" https://api.vox2.arcaai.com/ws/stt/stream  # 101/text-event-stream, not 502
```

---

## Part 3 — GPU server steps (connect STT to the cluster)

STT runs in Docker on the GPU lab server `192.168.112.2`. It is reached over the
LAN through the selector-less Service created in step 2.3. No tunnel is needed on
this host (Option A), but the service must be reachable and healthy.

### 3.1 Confirm the containers and the published port

```bash
ssh <gpu-server>
docker ps
# hope-stt          hope-v2/stt-ml-runtime:sha-dacdc311e   0.0.0.0:8862->8861/tcp
# hope-stt-worker   hope-v2/stt-worker:sha-dacdc311e       8861/tcp, 0.0.0.0:9192->9191/tcp
# stt-service       stt:ml                                 0.0.0.0:8861->8861/tcp
```

- Why: the cluster dials `192.168.112.2:8862`, which must map to the STT API
  container (`hope-stt`). `0.0.0.0` binding is required (a `127.0.0.1` bind is
  unreachable from the cluster).

### 3.2 Confirm the app is healthy (do not skip)

```bash
curl -sv http://127.0.0.1:8862/ 2>&1 | head
# discover the health path if unknown:
docker inspect --format '{{.Config.Healthcheck}}' hope-stt
docker logs --tail=50 hope-stt
docker logs --tail=50 hope-stt-worker
```

- Why: all three containers currently report **`unhealthy`**. Publishing an
  unhealthy backend produces 502s that look like an Ingress bug. Confirm a real
  2xx/4xx (not connection-refused) before exposing.

### 3.3 Open the firewall for the cluster subnet

```bash
# firewalld (Rocky/RHEL hosts)
sudo firewall-cmd --permanent --add-rich-rule \
  'rule family="ipv4" source address="192.168.112.0/24" port port="8862" protocol="tcp" accept'
sudo firewall-cmd --reload
# or ufw
sudo ufw allow from 192.168.112.0/24 to any port 8862 proto tcp
```

- Why: the kube-proxy/endpoint traffic originates from the cluster node subnet
  (`192.168.112.0/24`). A default DROP policy silently blackholes the connection
  and it presents as a timeout.

### 3.4 Verify reachability from a cluster node

```bash
# from a worker node (or: kubectl debug / ssh to 192.168.112.6)
curl -sv http://192.168.112.2:8862/ 2>&1 | head
```

- Why: this is exactly the path Traefik + the Endpoints object will use. If this
  fails, the Ingress will 502.

### 3.5 Ensure the containers survive a reboot

```bash
docker inspect --format '{{.HostConfig.RestartPolicy.Name}}' hope-stt
# if "no":
docker update --restart unless-stopped hope-stt hope-stt-worker stt-service
```

- Why: the cluster depends on this external service; it should come back
  automatically after a host reboot.

### 3.6 (Alternative) Tunnel directly from the GPU server

Only if you later decide to bypass the cluster for STT: install `cloudflared` on
this host and run a second connector. Not needed for Option A; documented for
completeness.

---

## Double-check / preflight checklist

- [ ] Tunnel `hope-vox2` exists in the correct account, token copied (Part 1.2).
- [ ] All 11 public hostnames point at `http://traefik.project-hope-vox.svc.cluster.local:80`, `httpHostHeader` NOT set (Part 1.3).
- [ ] DNS records created and **proxied** (Part 1.4).
- [ ] `cloudflared-tunnel-token` Secret exists in `project-hope-vox` (Part 2.1).
- [ ] `deploy/cloudflared` 2/2 Ready; logs show `Registered tunnel connection` (Part 2.2, 2.7).
- [ ] `hope-stt` Service **and** Endpoints exist, endpoint `192.168.112.2:8862` (Part 2.3).
- [ ] Ingresses present for every hostname (Part 2.4).
- [ ] CORS rows `https://vox2.arcaai.com` and `https://*.vox2.arcaai.com:*` added (Part 2.5, wildcard needs super admin).
- [ ] Cloudflare compression disabled for `/api/hope/*` (Part 1.6).
- [ ] Console rebuilt with `NEXT_PUBLIC_API_HOST=https://api.vox2.arcaai.com` (Part 2.6).
- [ ] GPU firewall allows `192.168.112.0/24:8862`; `curl` from a node succeeds (Part 3.3-3.4).
- [ ] `vault`/`temporal` protected by Cloudflare Access (Part 1.5).
- [ ] `api.vox2` router visible in Traefik dashboard (middleware reference resolved, Part 2.4).

## Rollback

```bash
kubectl delete -f manifests/ingress-vox2-apps.yaml
kubectl delete -f manifests/ingress-vox2-infra.yaml
kubectl delete -f manifests/stt-external-service.yaml
kubectl delete -f manifests/cloudflared-hope-vox2.yaml
kubectl -n project-hope-vox delete secret cloudflared-tunnel-token
# then delete the tunnel + public hostnames in the Cloudflare dashboard
```

## Related

- `manifests/README.md` — manifest summary
- `vox2-arcaai-com-routing.md` — hostname -> backend decisions
- `current-setup.md` — live cluster state
- `reference/cloudflare-tunnel.md` — canonical tunnel design (Host-header rule, guardrails)
