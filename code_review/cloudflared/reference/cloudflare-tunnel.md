<!-- ============================================================
  ⚠️ SNAPSHOT — REFERENCE ESTATE ONLY (arca-deployment-template@main).
  Verbatim copy of the canonical doc, describing the taphuynh.dev / k3s estate
  (`hope-v2-dev` + `arca-dev` tunnels, bundled Traefik in kube-system).

  It is NOT the plan for the lab cluster: see ../steps_to_follow.md
  (new dedicated `hope-vox2` tunnel, Helm Traefik in project-hope-vox,
  token-only connector, vox2.arcaai.com hostnames).
  ============================================================ -->
# Cloudflare Tunnel — how HOPE v2 reaches the internet

**Status:** current as of 2026-09-01 (TASK-847).
**Owns:** `deployment/k8s/base/cloudflared.yaml`, `deployment/k8s/base/ingress.yaml`.

This document answers four questions that used to have no written answer anywhere:
which hostnames are on the public internet, what each one reaches, which of the two
tunnels carries it, and what is protecting it. Before this ticket the routing lived
only in the Cloudflare dashboard, so none of it appeared in a merge request, a
`git log`, or a backup of this repository.

---

## 1. Two tunnels, and the one rule that decides between them

There are two `cloudflared` deployments in this estate. They are not redundant and
they are not interchangeable.

| | **`hope-v2-dev`** (this repo) | **`arca-dev`** (hypervisor) |
|---|---|---|
| Tunnel id | `be60e97a-e5d3-43ea-9ab0-3d23bcc9981c` | `e917ee9e-c140-47d1-9c34-f9e555bc3095` |
| Runs where | Two pods in the `hope-v2-dev` namespace | On the Proxmox hypervisor |
| Configured how | `config_src: local` — the ingress table is `base/cloudflared.yaml`, in Git | Remotely managed — routing lives in the Cloudflare dashboard |
| Carries | The **application plane**: the HOPE services | The **infrastructure plane**: SSH to VMs, GitLab, the container registry, Rancher, Argo CD, MinIO |
| Changed by | A merge request against this repo | The Cloudflare dashboard |

> **The rule.** If the backend is a **Kubernetes Service in `hope-v2-dev`**, the hostname
> belongs to the **`hope-v2-dev`** tunnel and is declared in this repo. If the backend is a
> **LAN host** — a VM, the hypervisor, an appliance — it belongs to the **`arca-dev`**
> tunnel and is *not* modelled here.
>
> The single case that looks like an exception and is not: `lmstudio-dev.taphuynh.dev`.
> LM Studio runs on the node *host* (`10.10.1.10:1234`), but it is reached through a
> Kubernetes Service (`hope-lmstudio`, a selector-less Service with hand-written
> Endpoints — see `deployment/k8s/out-of-band/lmstudio-service.yaml`). The rule looks at
> the backend *object*, not at where the process happens to run.
>
> `minio-dev.taphuynh.dev` is the mirror image: MinIO is an external LAN host with no
> Service here, so it belongs to `arca-dev`. Do not add it to this repo.

Nothing below applies to `arca-dev`. If a hostname in this document does not resolve
and you cannot find it in `base/ingress.yaml`, check whether it is an infrastructure
hostname on the other tunnel before debugging anything in this namespace.

---

## 2. The request path

### HTTP hostnames

```
  browser / API client
        │  HTTPS  (TLS terminated by Cloudflare)
        ▼
  Cloudflare edge
        │  tunnel  (cloudflared's own outbound QUIC/HTTP2 to Cloudflare, port 7844;
        │           no inbound port is open on 10.10.1.10 — that is the point)
        ▼
  cloudflared pod  (hope-v2-dev, 2 replicas)
        │  plain HTTP, in-cluster, Host header UNCHANGED
        ▼
  traefik.kube-system.svc.cluster.local:80
        │  matches Host against spec.rules[].host
        ▼
  Ingress → Service → pod
```

**Where TLS terminates: at the Cloudflare edge, and nowhere else.** The hop from the
edge to the `cloudflared` pod is inside Cloudflare's own tunnel transport. The hop from
`cloudflared` to Traefik, and from Traefik to the backend pod, is **plain HTTP over the
cluster pod network**. There is no cert-manager in this cluster and no `tls:` block on
any Ingress; adding one without an Issuer would make Traefik serve a self-signed
certificate, which is worse than plain HTTP behind a tunnel because it *looks* secure.

**The Host header is the whole design.** `cloudflared` has exactly **one** HTTP rule — a
catch-all to Traefik — and it deliberately does **not** set
`originRequest.httpHostHeader`. Cloudflare's origin-parameter reference gives that field
a default of `""` and describes setting it as *"Sets the HTTP `Host` header on requests
sent to the local service"*; leaving it unset is what forwards the client's original
`Host` to Traefik, and that header is the only thing Traefik routes on. Setting it —
the obvious-looking "fix" when an origin returns 404 — would collapse all twelve
hostnames onto one value, match no Ingress rule, and 404 the entire platform in a way
that reads like an Ingress bug.

The practical consequence, and the reason this design was chosen: **adding a public
HTTP hostname never touches `cloudflared.yaml`.** It is one Ingress plus one DNS record.

### TCP hostnames (PostgreSQL)

```
  psql on your laptop
        │  plain TCP to 127.0.0.1:<local port>
        ▼
  cloudflared access tcp   (local process, authenticates you to Cloudflare)
        │  TCP-over-WebSocket, TLS to the edge
        ▼
  Cloudflare edge ──tunnel──▶ cloudflared pod
        │  raw TCP
        ▼
  hope-postgres-rw.hope-v2-dev.svc.cluster.local:5432
```

Traefik is not involved. An Ingress is an HTTP object: the PostgreSQL wire protocol
carries no `Host` header, so there is nothing for an Ingress rule to match on. These two
hostnames are therefore the **only** entries in `cloudflared.yaml`'s ingress table that
name a backend directly, and the only reason that file would ever need editing.

One property worth knowing before you read an audit log: for non-HTTP protocols the
origin sees the **`cloudflared` pod's IP**, not the client's. (For HTTP, the client IP is
in `CF-Connecting-IP`.) Postgres `pg_hba`/log lines will show the connector, so client
attribution for database access has to come from Cloudflare's edge logs, not from
Postgres.

---

## 3. Hostname inventory

Everything below is on the `hope-v2-dev` tunnel. "Authn" is what stands between a
stranger on the internet and the backend **today**.

### HTTP — routed by Traefik, declared in `base/ingress.yaml`

| Hostname | Service | Port | Authn today |
|---|---|---|---|
| `api-dev.taphuynh.dev` | `hope-api` | 8868 | Gateway auth (deny-by-default `UnifiedAuthGuard`) |
| `admin-dev.taphuynh.dev` | `hope-admin-console` | 3000 | Console login (BFF session cookie) |
| `text-dev.taphuynh.dev` | `hope-text` | 8862 | `X-Service-Token` shared secret only |
| `stt-dev.taphuynh.dev` | `hope-stt` | 8861 | `X-Service-Token` shared secret only |
| `tts-hope.taphuynh.dev` | `hope-tts` | 8865 | `X-Service-Token` shared secret only |
| `guardrail.taphuynh.dev` | `hope-guardrail` | 8863 | `X-Service-Token` shared secret only |
| `nlp-dev.taphuynh.dev` | `hope-nlp` | 8864 | `X-Service-Token` shared secret only |
| `vllm-dev.taphuynh.dev` | `hope-vllm` | 8000 | none — and the Deployment is at `replicas: 0`, so it answers 503 |
| `lmstudio-dev.taphuynh.dev` | `hope-lmstudio` | 1234 | **none** |
| `vault-dev.taphuynh.dev` | `hope-vault` | 8200 | Vault token auth only — **see §7** |
| `temporal.taphuynh.dev` | `hope-temporal-ui` | 8080 | **none** |
| `grafana-dev.taphuynh.dev` | `grafana` | 3000 | Grafana login, with an **unmanaged** admin password (`base/grafana.yaml`) |

`grafana-dev` is the one hostname whose Ingress is **not** in `base/ingress.yaml` — it
lives in `base/grafana.yaml`, next to the `GF_SERVER_ROOT_URL` that has to move with it.
Do not add a second Ingress for it; two Ingresses for one host is a conflict.

### TCP — declared in `base/cloudflared.yaml`

| Hostname | Backend | Authn today |
|---|---|---|
| `db-dev.taphuynh.dev` | `tcp://hope-postgres-rw.hope-v2-dev.svc.cluster.local:5432` | PostgreSQL password only — **see §7** |
| `db-dev-read.taphuynh.dev` | `tcp://hope-postgres-ro.hope-v2-dev.svc.cluster.local:5432` | PostgreSQL password only — **see §7** |

> ⚠️ **These two do not work yet, and the reason is an overlay, not the tunnel.** Both
> Services come from `components/data-tier`, which today is enabled only by
> `overlays/standalone` — `kustomize build deployment/k8s/overlays/dev` contains no
> `hope-postgres-rw` and no `hope-postgres-ro` (verified 2026-09-01). Until the dev
> overlay enables that component, these hostnames resolve to nothing.
>
> The failure is contained: `cloudflared` resolves a `tcp://` origin per connection, so
> an unresolvable one fails only its own hostname. The connector still starts and every
> HTTP hostname above is unaffected.

### Deliberately absent

* **The harness.** Owner decision, 2026-09-01. Do not add a hostname for it because the
  service exists.
* **The Temporal frontend** (`hope-temporal`, 7233). The UI is published; the workflow
  control plane is not.
* **MinIO.** External LAN host — `arca-dev` tunnel.

---

## 4. Adding a new hostname

### 4a. An HTTP service (the normal case)

1. **Add an Ingress** to `deployment/k8s/base/ingress.yaml`:

   ```yaml
   ---
   apiVersion: networking.k8s.io/v1
   kind: Ingress
   metadata:
     name: hope-example
     labels:
       app: hope-example
       app.kubernetes.io/part-of: project-hope
   spec:
     ingressClassName: traefik
     rules:
       - host: example-dev.taphuynh.dev
         http:
           paths:
             - path: /
               pathType: Prefix
               backend:
                 service:
                   name: hope-example
                   port:
                     number: 1234
   ```

2. **Create the DNS record.** A **CNAME**, on the `taphuynh.dev` zone:

   | Type | Name | Target | Proxy |
   |---|---|---|---|
   | CNAME | `example-dev` | `be60e97a-e5d3-43ea-9ab0-3d23bcc9981c.cfargotunnel.com` | **Proxied (orange cloud)** — required |

   Either in the dashboard, or from a machine holding the tunnel `cert.pem`:

   ```sh
   cloudflared tunnel route dns be60e97a-e5d3-43ea-9ab0-3d23bcc9981c example-dev.taphuynh.dev
   ```

   The record **must be proxied**. A grey-clouded `*.cfargotunnel.com` CNAME does not
   resolve to anything a client can reach.

3. **`cloudflared` does NOT need restarting, and its ConfigMap does not change.** The
   catch-all already forwards every hostname to Traefik with the Host header intact; the
   new Ingress is picked up by Traefik's Kubernetes watch within seconds of the Argo
   sync. This is the payoff of the catch-all design — resist the urge to add a
   per-hostname rule to `cloudflared.yaml`.

4. **Decide whether it needs Cloudflare Access** — §7. Do this *before* the DNS record
   exists, not after.

### 4b. A non-HTTP service (TCP, SSH, RDP…)

This is the case that *does* edit `cloudflared.yaml`.

1. Add a rule to `data["config.yaml"].ingress` in `base/cloudflared.yaml`, **above** the
   HTTP catch-all (rules are matched top to bottom, and the catch-all matches
   everything):

   ```yaml
   - hostname: thing-dev.taphuynh.dev
     service: tcp://hope-thing.hope-v2-dev.svc.cluster.local:9999
   ```

   **Do not add a trailing `- service: http_status:404`.** Cloudflare's own examples end
   every ingress list with one, so its absence here looks like an omission — it is not.
   A rule with no `hostname` *is* the catch-all, this config already ends with one (the
   Traefik rule), and `cloudflared` rejects a config where anything follows it:

   ```
   Validation failed: Rule #3 is matching the hostname '', but this will match every
   hostname, meaning the rules which follow it will never be triggered.
   ```

   `cloudflared` exits non-zero on that, so the mistake CrashLoops both connectors.
   `maxUnavailable: 0` keeps the incumbent pods serving — turning it into a stuck
   rollout rather than an outage — but run step 4 rather than relying on that.

2. **Bump `cloudflared.hope/config-revision`** in the Deployment's pod annotations.
   `cloudflared` reads its config once at startup; without a pod-template change the
   ConfigMap is updated on the volume and the running connectors keep serving the old
   table, so Git and the cluster disagree silently.

3. Create the CNAME exactly as in 4a step 2.

4. **Verify with the real binary before merging.** Extract the ConfigMap's `config.yaml`
   to a scratch file, then:

   ```sh
   docker run --rm -v "$PWD:/etc/cloudflared:ro" --entrypoint cloudflared \
     cloudflare/cloudflared:2026.8.3 \
     tunnel --config /etc/cloudflared/config.yaml ingress validate
   # -> OK

   # and prove a specific hostname reaches the backend you intended:
   docker run --rm -v "$PWD:/etc/cloudflared:ro" --entrypoint cloudflared \
     cloudflare/cloudflared:2026.8.3 \
     tunnel --config /etc/cloudflared/config.yaml ingress rule https://thing-dev.taphuynh.dev
   # -> Matched rule #N  hostname: thing-dev.taphuynh.dev  service: tcp://...
   ```

   `ingress rule` is the one that catches ordering mistakes: a `tcp://` rule placed
   *below* the Traefik catch-all reports `Matched rule #2  service: http://traefik...`
   instead of its own rule, which is exactly how a TCP hostname ends up silently served
   as HTTP.

### 4c. Retiring a hostname

Delete the Ingress (or the `tcp://` rule) **and** the DNS record. A CNAME left pointing
at `<tunnel-id>.cfargotunnel.com` with no matching rule falls through to the catch-all,
reaches Traefik, matches no Ingress, and returns a Traefik 404 — which looks like a
broken service rather than a retired one.

---

## 5. Connecting to PostgreSQL from a laptop

`db-dev` (read/write primary) and `db-dev-read` (read-only replica) are TCP hostnames,
so a normal `psql` cannot dial them directly — a local `cloudflared` process brokers the
connection.

**One-time:** install `cloudflared` (`brew install cloudflared` on macOS).

**Every session — two terminals.**

Terminal 1, the bridge. It stays running; killing it drops the connection:

```sh
cloudflared access tcp --hostname db-dev.taphuynh.dev --url 127.0.0.1:15432
```

Terminal 2, the client:

```sh
psql "postgresql://<user>:<password>@127.0.0.1:15432/<database>?sslmode=disable"
```

For the read-only replica, use a different local port so both can be open at once:

```sh
cloudflared access tcp --hostname db-dev-read.taphuynh.dev --url 127.0.0.1:15433
psql "postgresql://<user>:<password>@127.0.0.1:15433/<database>?sslmode=disable"
```

Notes that will otherwise cost you an hour:

* **`--url` is the LOCAL listener**, not the remote target. `127.0.0.1:15432` is a port
  on your own machine. Do not put the database's address there.
* **Point every client at `127.0.0.1:15432`, never at `db-dev.taphuynh.dev`.** That
  includes GUI clients (DBeaver, TablePlus, DataGrip) and any `DATABASE_URL` you export.
* **`sslmode=disable` is honest, not lax.** The confidentiality on this path comes from
  the TLS between your `cloudflared` and Cloudflare's edge, and from the tunnel to the
  connector. Postgres itself is reached over plain TCP inside the cluster. Setting
  `sslmode=require` would fail unless the server has TLS configured.
* **Once Cloudflare Access is applied to these hostnames (§7), the `cloudflared access`
  command opens a browser for you to authenticate.** That is expected, and it is the
  whole point.
* For a long-lived or high-throughput connection (a migration, a bulk export),
  Cloudflare's guidance is to use Client-to-Tunnel / WARP rather than
  `cloudflared access tcp`, which streams over a WebSocket.

**`kubectl port-forward` remains available and adds no public attack surface**, so for
one-off admin work from a machine that already has cluster access it is still the better
tool:

```sh
kubectl -n hope-v2-dev port-forward svc/hope-postgres-rw 15432:5432
```

---

## 6. Operating the connector

### The token secret

`cloudflared` authenticates to Cloudflare with a tunnel token supplied by the
`cloudflared-tunnel-token` Secret, key `token`.

**That Secret is not in this repository and must never be.** Argo CD's AppProject
blacklists `Secret`, and the `scan-gitleaks` CI job scans the whole tree — a committed
token would be both rejected and burned. Create it out of band, once:

```sh
kubectl -n hope-v2-dev create secret generic cloudflared-tunnel-token \
  --from-literal=token='<TUNNEL_TOKEN>'
```

The token value comes from the Cloudflare dashboard (**Networking → Tunnels →
`hope-v2-dev`**) or from `cloudflared tunnel token be60e97a-e5d3-43ea-9ab0-3d23bcc9981c`
on a machine holding `cert.pem`. It is of the form `eyJhIjoiNWFiNGU5Z…`.

The reference is deliberately **not** `optional: true`: a connector with no token cannot
connect, and a pod stuck in `CreateContainerConfigError` is a far better signal than two
Running pods that never register with the edge.

**Rotating it:** recreate the Secret, then `kubectl -n hope-v2-dev rollout restart
deploy/cloudflared`. `maxUnavailable: 0` means the tunnel stays up across the restart.

### Rollouts never drop the tunnel

Three settings do this together, and all three are load-bearing:

* `replicas: 2` — two connectors register independently; Cloudflare balances across them.
* `maxUnavailable: 0` — the replacement pod must be Ready before the incumbent may go.
* readiness probe on **`/ready`** — which returns 200 *if and only if* that connector has
  a live connection to Cloudflare's network. So "Ready" means "actually carrying edge
  traffic", not "the process started".

The liveness probe deliberately uses `/metrics` instead, which is weaker.
`/ready` goes red whenever the edge is unreachable, so using it for liveness would turn a
Cloudflare-side incident or a WAN blip into a restart loop that destroys the connector's
reconnect backoff and makes recovery slower. Readiness already removes a disconnected pod
from service; liveness only needs to catch a wedged process.

`terminationGracePeriodSeconds: 60` exceeds `cloudflared`'s own 30-second shutdown grace
period, so in-flight streams — an open STT WebSocket, a streaming SSE summarization —
drain instead of being cut.

### Metrics

The metrics server is on `0.0.0.0:2000` and is scraped by the `kubernetes-pods` job in
`base/observability-config.yaml`, via the `prometheus.io/scrape` pod annotations.
`cloudflared` is the **first** workload in this namespace to use that opt-in mechanism,
which is safe precisely because it has no hand-written `static_configs` job to
double-count against.

For ad-hoc checks there is a `cloudflared-metrics` ClusterIP Service:

```sh
kubectl -n hope-v2-dev port-forward svc/cloudflared-metrics 2000:2000
curl -s localhost:2000/ready        # 200 == connected to the edge
curl -s localhost:2000/metrics | grep -i cloudflared_tunnel_ha_connections
```

Prometheus scrapes the **pods**, not this Service, on purpose: a Service target would
load-balance and report a random *single* connector per scrape, so one pod's connection
count would silently stand in for both.

### Troubleshooting, in the order that finds it fastest

| Symptom | Look here |
|---|---|
| Hostname does not resolve at all | The DNS CNAME is missing, or is grey-clouded instead of proxied (§4a step 2) |
| Cloudflare error 1033 | No connector is registered. `kubectl -n hope-v2-dev get pods -l app=cloudflared`; check the token Secret exists |
| **Traefik 404 page** | The Host reached Traefik but matched no Ingress rule. Either the Ingress is missing/misnamed, or someone set `originRequest.httpHostHeader` in `cloudflared.yaml` — see §2 |
| **503 from Traefik** | The Ingress matched but the Service has no ready endpoints. Expected for `vllm-dev` (`replicas: 0`) and for `lmstudio-dev` if the out-of-band Service/Endpoints have not been applied |
| A `tcp://` change had no effect | `cloudflared.hope/config-revision` was not bumped, so the pods are still running the old table (§4b step 2) |
| Everything 404s at once | Almost certainly `httpHostHeader`. See §2 |

---

## 7. Security — what is actually protecting these hostnames

This section is deliberately blunt, because the honest answer is uncomfortable and
writing it down is most of its value.

**Cloudflare Tunnel is a transport, not an authorization system.** Cloudflare's own
documentation states it plainly for published applications: *"By default, anyone on the
Internet can connect to the server using the hostname of the published application."*
Putting a Service behind this tunnel does not authenticate anyone. The only thing it
removes is the need for an inbound port on `10.10.1.10`.

### Currently unauthenticated on the public internet

* **`temporal.taphuynh.dev`** — the Temporal UI has no login. It exposes every workflow
  execution, its inputs and its history. On a clinical-documentation platform those
  payloads are the most likely place for PHI to appear.
* **`lmstudio-dev.taphuynh.dev`** — an open OpenAI-compatible inference endpoint running
  on the node host. Free compute for anyone who finds it, and a prompt-injection surface
  reachable without credentials.
* **`vllm-dev.taphuynh.dev`** — same shape; currently mitigated only by the Deployment
  being scaled to zero. That is a capacity accident, not a control.

### Protected only by a shared secret

`text-dev`, `stt-dev`, `tts-hope`, `guardrail`, `nlp-dev` sit behind their service's
`X-Service-Token` middleware. That is a **single shared bearer value with no rotation
story, no per-caller identity and no audit trail** — designed for peer-to-peer calls
inside a pod network, now load-bearing on the open internet. Note also that an **empty**
token disables the check entirely (dev-mode bypass); confirm the value is actually set
in every one of these services before relying on it.

### The two that need Cloudflare Access before anything else

**`vault-dev.taphuynh.dev`.** This repo previously made, and documented, the decision
*not* to expose Vault — `docs/vault-seal-migration.md` §12.3, "Why not a hostname on the
tunnel". Its argument still stands on its own terms, and it named three things that must
land **together** for a route to be acceptable:

1. a Service exposure for `hope-vault` — **this ticket provides it**;
2. a **Cloudflare Access application** over the hostname, bound to the already-registered
   Entra IdP (`867397e1-…`), enabled *before* the route is — **not done**;
3. **TLS to the origin** — Vault still runs `tls_disable = true` — **not done**.

The owner has now asked for the hostname, so item 1 has landed alone. Until items 2 and 3
land, `vault-dev` puts the secrets plane of a PHI platform on the internet behind Vault's
own token auth and nothing else, and the initial **root token** is still live in this
namespace (`docs/vault-seal-migration.md` §12.3 and the `hope-vault-init` Role comment in
`base/vault.yaml`). If only one thing on this page gets done, make it the Access
application over `vault-dev`.

**`db-dev.taphuynh.dev` / `db-dev-read.taphuynh.dev`.** A TCP hostname with no Access
application is an internet-reachable PostgreSQL port whose only control is the database
password. It is also the one path where the origin cannot see the client IP (§2), so a
password-guessing campaign leaves no attributable trace in Postgres logs — only in
Cloudflare's edge logs. These need an Access application at least as much as `vault-dev`
does.

### The state of Access across the estate

As recorded in `docs/vault-seal-migration.md` §12.3, Cloudflare Access is currently
applied to **exactly one application in the whole estate** (`server.taphuynh.dev`, on the
other tunnel). Every hostname in §3 of this document is outside it.

### Recommended posture

| Hostname | Recommendation |
|---|---|
| `vault-dev`, `db-dev`, `db-dev-read` | **Cloudflare Access, bound to Entra, before anything else.** Highest blast radius on the list |
| `temporal.taphuynh.dev` | Access — it has no authentication of its own at all |
| `lmstudio-dev`, `vllm-dev` | Access, or unpublish. There is no reason an inference backend needs a public hostname; the callers are all in-cluster |
| `grafana-dev` | Access, *and* fix the unmanaged admin password (`base/grafana.yaml`, `docs/observability-multi-env.md` §6) |
| `text-dev`, `stt-dev`, `tts-hope`, `guardrail`, `nlp-dev` | Access. Their callers are `hope-api` and each other — all in-cluster. Publishing them is a convenience for manual testing that costs a permanent internet-facing surface |
| `api-dev`, `admin-dev` | Keep public. These are the products; they carry real deny-by-default authentication |

An Access application is created in **Cloudflare One → Access → Applications** as a
self-hosted application over the hostname, with a policy bound to the Entra IdP. It sits
at the edge, so it takes effect before a request ever enters the tunnel — which means it
protects hostnames whose backends have no authentication of their own, and it does so
without any change to this repository.

---

## Related

* `deployment/k8s/base/cloudflared.yaml` — the connector and its ingress table
* `deployment/k8s/base/ingress.yaml` — the per-hostname HTTP routing table
* `deployment/k8s/base/grafana.yaml` — owns the `grafana-dev` Ingress
* `deployment/k8s/out-of-band/lmstudio-service.yaml` — why `hope-lmstudio` is not in the kustomize tree
* `deployment/k8s/components/network-policies/` — the default-deny ingress baseline
* `docs/vault-seal-migration.md` §12.3 — the prior decision not to expose Vault
* `docs/deployment-runbook.md` — how a change in this repo reaches the cluster
