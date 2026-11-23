# 11 — Traefik / Ingress Setup for the Admin Console + API Gateway

Goal: front the admin console and the API gateway with Traefik in k3s so the
console behaves like a real deployment — TLS, a single browser-reachable gateway
host for streams, and production `Secure` cookies — without the per-environment
origin and `NODE_ENV` workarounds that NodePort-only access forces.

> **Repo boundary.** No cluster manifest lives in `project-hope`. Every Ingress /
> Middleware / TLS object below belongs in the separate GitOps repo
> `arca/hope-v2-deployment` under `deployment/k8s/{base,overlays}/{dev,…}`. This
> doc describes what to add and why; it is not itself applied from here.

---

## 0. Current topology (why this is needed at all)

Today both services are reached by **NodePort** on the single k3s node:

| Service | Reached at | In-cluster DNS |
|---|---|---|
| API gateway | `http://192.168.112.6:32458` | `hope-api-svc.project-hope-vox.svc.cluster.local:8868` |
| Admin console | `http://192.168.112.6:32540` | `hope-admin-console-svc.project-hope-vox:3000` (confirm name) |

NodePort is fine for `curl` and for the console's BFF (`/api/hope/*`, login),
because those are **server-side** calls that carry no browser `Origin`. It breaks
two browser-only paths:

1. **Direct SSE/WS streams.** The browser connects straight to the gateway
   (`NEXT_PUBLIC_API_HOST`) for live transcription (`/ws/stt/stream`) and the
   playground/LLM stream. Those requests carry `Origin: http://192.168.112.6:32540`.
2. **Origin enforcement.** `origin.enforcementEnabled` defaults to **ON**
   (`packages/applications/src/services/settings-registry/descriptors/platform-ops.descriptors.ts:213`),
   and the seeded allow-list only admits loopback + `https://*.taphuynh.dev:*`
   (`packages/database/src/prisma/db_main/seed/11b-tenant-allowed-origins.ts`).
   An `http://IP:port` origin matches none of them → the stream is refused.
   `ADMIN_CONSOLE_URL` is **not** wired into that gate (it is "CORS guidance"
   only — no code reads it).

An Ingress with a `*.taphuynh.dev` host solves both at once: the origin already
matches the seed, and TLS makes the console's production `Secure` session cookie
(`apps/admin-console/src/server/session.ts:93`) work.

---

## 1. Confirm (or install) Traefik

k3s ships Traefik as the default ingress controller, and this cluster already
routes through it (the Grafana ingress + in-cluster Cloudflare tunnel in
`docs/operations/observability/README.md`). Confirm first:

```bash
kubectl -n kube-system get deploy,svc | grep traefik
# Expect: deploy/traefik  and  svc/traefik
kubectl get ingressclass
# Expect: traefik (controller: traefik.io/ingress-controller)
```

If it is **absent**, the k3s server was started with `--disable traefik`. Either
remove that flag and restart k3s (the bundled chart comes back), or Helm-install
Traefik into `kube-system`. Traefik's `LoadBalancer` Service is served by k3s
ServiceLB (klipper-lb), which binds the single node IP.

---

## 2. Ingress for the gateway and the console

Service ports: gateway `8868` (`PORT` in the gateway env), console `3000`
(`apps/admin-console/Dockerfile:110,115` → `PORT=3000`, `EXPOSE 3000`).

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: hope-api
  namespace: project-hope-vox
  annotations:
    traefik.ingress.kubernetes.io/router.middlewares: project-hope-vox/hope-no-buffer@kubernetescrd
spec:
  ingressClassName: traefik
  rules:
    - host: api.taphuynh.dev
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: hope-api-svc
                port:
                  number: 8868
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: hope-admin-console
  namespace: project-hope-vox
spec:
  ingressClassName: traefik
  rules:
    - host: admin-hope.taphuynh.dev
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: hope-admin-console-svc
                port:
                  number: 3000
```

> Confirm the console Service name/port before applying:
> `kubectl -n project-hope-vox get svc | grep -i admin`.

---

## 3. Streaming — the config that actually matters

Traefik handles WebSocket upgrades natively, but **SSE/WS through an ingress
needs no buffering and generous timeouts**, or live transcription and the LLM
playground stall. Without this the streams open then drop.

```yaml
apiVersion: traefik.io/v1alpha1
kind: Middleware
metadata:
  name: hope-no-buffer
  namespace: project-hope-vox
spec:
  buffering:
    maxRequestBodyBytes: 0
    memRequestBodyBytes: 0
    retryExpression: ""
---
apiVersion: traefik.io/v1alpha1
kind: ServersTransport
metadata:
  name: hope-transport
  namespace: project-hope-vox
spec:
  forwardingTimeouts:
    dialTimeout: 30s
    responseHeaderTimeout: 0s   # 0 = no timeout (long-lived streams)
    idleConnTimeout: 0s
```

Paths to verify after apply: WS `wss://api.taphuynh.dev/ws/stt/stream` and the
ticketed SSE endpoint `…/stream?ticket=…`. Both terminate at the gateway ingress.
If you see 502/504 only on those two, the buffering/timeout config above is the
fix — not the app.

---

## 4. TLS — pick one

| Option | When | Notes |
|---|---|---|
| **Cloudflare Tunnel** (current pattern) | You already front hosts with Cloudflare | Edge terminates TLS; the tunnel forwards unlisted hosts to Traefik. Add CNAMEs for `api`/`admin-hope` → the tunnel. No in-cluster cert. This is the TASK-858 setup. |
| **cert-manager + ClusterIssuer (Let's Encrypt)** | Self-contained public cluster | Requires `cert-manager` installed; annotate the Ingress with `cert-manager.io/cluster-issuer` and add a `tls:` block. |
| **Internal CA (`arcaai-internal-ca`)** | LAN-only | Clients must trust the CA. Simplest if nothing leaves the network. |

`Secure` cookies start working the moment the console is served over HTTPS; no
app change is needed.

---

## 5. Wire the app env and rebuild the console

Hostnames must match the seeded allow-list (`https://*.taphuynh.dev:*`) — that is
exactly why the `.taphuynh.dev` names are the path of least resistance.

| Var | Where | Value | Notes |
|---|---|---|---|
| `API_URL` | console (server) | `http://hope-api-svc.project-hope-vox.svc.cluster.local:8868` | BFF target; **cluster DNS**, do not hairpin the BFF back out through the ingress (`src/server/gateway.ts:7`). |
| `NEXT_PUBLIC_API_HOST` | console (client) | `https://api.taphuynh.dev` | Browser stream target. **Inlined at build time** — the console image MUST be rebuilt. CI passes it via `CONSOLE_GATEWAY_HOST` (`.gitlab/ci/build.yml:223`). |
| `ADMIN_CONSOLE_URL` | gateway | `https://admin-hope.taphuynh.dev` | CORS guidance. |

> **Most common mistake:** setting `NEXT_PUBLIC_API_HOST` at runtime. It is a
> build arg (`apps/admin-console/src/config/env.descriptors.ts:59`), so a running
> pod keeps the old value until the image is rebuilt. This is the exact failure
> recorded in the TASK-858 notes (stale `vox-api-dev.taphuynh.dev` baked into the
> bundle → WS/SSE `ERR_NAME_NOT_RESOLVED`).

---

## 6. Origins and CDN caveats

- **Origin gate.** With a `*.taphuynh.dev` host the seed already admits it. If you
  keep an IP:port origin instead, add it via `POST /api/v1/admin/allowed-origins`
  (SYSTEM tenant) or set `origin.enforcementEnabled=false`.
- **Cloudflare + optimistic concurrency.** If Cloudflare fronts the console, you
  MUST disable compression for `/api/hope/*`, or strong→weak ETag conversion
  breaks every `If-Match` write. See
  `docs/operations/deployment/cdn-edge-requirements.md` (verified on
  `admin-hope.taphuynh.dev`).

---

## 7. Verification

```bash
# Ingresses present and addressed
kubectl -n project-hope-vox get ingress

# Gateway health through the ingress host (add --resolve or /etc/hosts if DNS is local)
curl -sS https://api.taphuynh.dev/api/v1/health/ready && echo

# Console up, session cookie now Secure over HTTPS
curl -sS -i https://admin-hope.taphuynh.dev/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"username":"super_admin","password":"password123"}'

# Authenticated console call reusing the sealed session cookie
curl -sS -c /tmp/hope.cookies -X POST https://admin-hope.taphuynh.dev/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"username":"super_admin","password":"password123"}'
curl -sS -b /tmp/hope.cookies https://admin-hope.taphuynh.dev/api/hope/admin/tenants

# Browser paths (the ones NodePort could not serve) — expect 101 / text/event-stream
curl -i -H "Origin: https://admin-hope.taphuynh.dev" \
  https://api.taphuynh.dev/api/v1/health/ready
```

Then in a real browser: log in, open Live Transcription, confirm the WS opens to
`wss://api.taphuynh.dev/ws/stt/stream` (not the old host), and confirm the LLM
playground stream completes with `usage` + `done`.

---

## 8. Gotchas

- **Streaming timeout is the #1 ingress symptom.** A 502/504 on only the WS/SSE
  routes is the `ServersTransport` / `buffering` config, not the app.
- **Rebuild, don't re-env, `NEXT_PUBLIC_API_HOST`.**
- **BFF should talk to cluster DNS**, not the public host — avoids the node
  hairpin and a needless TLS hop.
- **TLS is what unblocks the Secure cookie.** `< 12 char`/password policy and
  login itself are unaffected.
- **GitOps only.** Per `docs/operations/deployment/README.md`, a live
  `kubectl apply`/`edit` is not durable under Argo auto-sync — land these objects
  in `arca/hope-v2-deployment` and let Argo apply them.

---

## References

- `apps/admin-console/src/config/env.descriptors.ts:41,59` — `API_URL`, `NEXT_PUBLIC_API_HOST`
- `apps/admin-console/src/server/gateway.ts:7` — BFF gateway URL construction
- `apps/admin-console/src/server/session.ts:93` — production `Secure` cookie
- `apps/admin-console/src/server/hope-proxy.ts:87` — `/api/hope/<path>` → `/api/v1/<path>`
- `packages/applications/.../platform-ops.descriptors.ts:213` — `origin.enforcementEnabled`
- `packages/database/.../seed/11b-tenant-allowed-origins.ts` — seeded origin allow-list
- `.gitlab/ci/build.yml:223` — `CONSOLE_GATEWAY_HOST` → `NEXT_PUBLIC_API_HOST` build arg
- `docs/operations/deployment/README.md`, `.../cdn-edge-requirements.md`
- `docs/operations/observability/README.md` — existing Traefik + Cloudflare tunnel routing
