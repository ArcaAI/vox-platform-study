# 06 — Public access: Traefik Ingress + Cloudflare tunnel

**Goal:** reach Grafana, Prometheus and Alertmanager from a browser via HTTPS
hostnames, through the existing Traefik ingress controller and the existing
Cloudflare tunnel.

**Before you start:** the three pods from `02-core-stack.md` are running; the
`cloudflared` tunnel connector is running in-cluster; you have access to the
Cloudflare dashboard.

```bash
source ~/obs.env
cd /path/to/repos/VOX
```

> **You can skip the Cloudflare part** and use `kubectl port-forward` forever if you
> prefer. The Ingress part is still worth applying if you want Traefik to route to
> these services (e.g. for the tunnel later).

The hostnames this stack uses (single-label under `arcaai.com`, so Cloudflare's
free Universal SSL covers them):

| Hostname | Backend | Auth |
|---|---|---|
| `grafana-vox2.arcaai.com` | `grafana:3000` | Grafana login |
| `prometheus-vox2.arcaai.com` | `prometheus:9090` | **none** |
| `alertmanager-vox2.arcaai.com` | `alertmanager:9093` | **none** |

---

## 1. Step 1 — Apply the Ingresses (`10-ingress.yaml`)

```bash
kubectl apply -f review/observability/manifests/10-ingress.yaml
kubectl -n $NS get ingress
```

Expected:

```
NAME              CLASS     HOSTS                          
hope-grafana      traefik   grafana-vox2.arcaai.com
hope-prometheus   traefik   prometheus-vox2.arcaai.com
hope-alertmanager traefik   alertmanager-vox2.arcaai.com
```

**Why Traefik needs no editing:** Traefik's ClusterRole watches Ingresses
cluster-wide and routes to a Service **in the same namespace as the Ingress**
(here, `project-hope-vox-infra`). The Ingresses are plain HTTP (TLS terminates at
the Cloudflare edge), matching the existing `vault-vox2` / `temporal-vox2` routes.
**No `router.middlewares` annotations** are used — the middleware names referenced
by the old raw stack do not exist on this cluster.

---

## 2. How the request flows

```
browser ──HTTPS→ Cloudflare edge (proxied CNAME) ──tunnel→ cloudflared (in-cluster)
        → traefik.project-hope-vox.svc:80 (Host header preserved) → Service (same ns)
```

The tunnel's HTTP routes forward **explicit Public Hostnames** to Traefik with the
original `Host` header intact. Traefik does all per-host routing.

---

## 2. Step 2 — Add the public hostnames in Cloudflare

> **Golden rule:** every hostname points at **Traefik**, never directly at
> Grafana/Prometheus/Alertmanager, and **never** set `httpHostHeader`.

1. Open <https://one.dash.cloudflare.com> → your account → **Zero Trust** →
   **Networks** → **Tunnels** → open the tunnel **`hope-vox2`**.
2. **Public Hostnames** tab → **Add a public hostname**. Fill in (example for
   Grafana):

   | Field | Value |
   |---|---|
   | Subdomain | `grafana-vox2` |
   | Domain | `arcaai.com` |
   | Path | *(leave empty)* |
   | Type | **HTTP** |
   | URL | `traefik.project-hope-vox.svc.cluster.local:80` |

3. Repeat for all three:

   | Subdomain | Domain | Path | Type | URL |
   |---|---|---|---|---|
   | `grafana-vox2` | `arcaai.com` | *(empty)* | HTTP | `traefik.project-hope-vox.svc.cluster.local:80` |
   | `prometheus-vox2` | `arcaai.com` | *(empty)* | HTTP | `traefik.project-hope-vox.svc.cluster.local:80` |
   | `alertmanager-vox2` | `arcaai.com` | *(empty)* | HTTP | `traefik.project-hope-vox.svc.cluster.local:80` |

4. **Do NOT** open *Additional application settings → HTTP Settings* and set
   **`httpHostHeader`**. Leaving it unset forwards the client's original `Host` —
   the only thing Traefik routes on. Setting it makes every host 404.
5. **Save** each.

> **If your tunnel is configured with a catch-all** that forwards every hostname to
> Traefik with the Host header intact, adding explicit public hostnames is optional.
> Adding them is the explicit, verifiable path.

### Confirm the DNS records

Saving a public hostname auto-creates a **proxied (orange-cloud) CNAME**
`<host>.arcaai.com → <tunnel-id>.cfargotunnel.com`. In **DNS → Records**, verify all
three are **Proxied** (orange). A **grey-clouded** `cfargotunnel.com` CNAME will not
resolve to anything reachable.

> **Avoid double labels.** Use `grafana-vox2.arcaai.com`, **not**
> `grafana.vox2.arcaai.com`. The latter is a two-level subdomain that the free
> Universal SSL certificate does not cover, which causes TLS errors.

---

## 2. Verify

From any machine (no VPN needed):

```bash
curl -sI https://grafana-vox2.arcaai.com        | head -1
curl -sI https://prometheus-vox2.arcaai.com     | head -1
curl -sI https://alertmanager-vox2.arcaai.com   | head -1
```

Expected: `HTTP/2 200` (or `302` for Alertmanager/Prometheus root redirects).

Grafana login:

```bash
curl -s https://grafana-vox2.arcaai.com/api/health
```

Expected: `{"database":"ok",...}`.

If DNS was just created, flush your local DNS cache:

```bash
# macOS
sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder
```

---

## 2. Security — read this

Traefik has **no auth middleware** on this cluster. Consequences:

- **Prometheus UI** is unauthenticated **and** exposes `/api/v1/admin/*` (delete
  series, take snapshots). Anyone who can resolve the hostname can use them.
- **Alertmanager UI** is unauthenticated and lets anyone create/expire silences.

Options (pick one):

1. **Put Cloudflare Access in front** of the Prometheus and Alertmanager hostnames
   (Zero Trust → Access → Applications → Add an application → Self-hosted). This
   prompts for identity before the tunnel forwards. **Recommended.**
2. **Don't publish them.** Delete the two docs from `10-ingress.yaml`, re-apply,
   and reach them with `kubectl port-forward` (below). Keep only Grafana public.

Grafana itself is authenticated (its own login) and is the safe one to expose.

Port-forward alternative for the unauthenticated UIs:

```bash
kubectl -n $NS port-forward svc/prometheus 9090:9090
kubectl -n $NS port-forward svc/alertmanager 9093:9093
```

**Never expose Loki.** It has no auth and is ClusterIP-only by design. The only
external access is the NodePort `31100` on the trusted node LAN, for the GPU host.

---

## 2. Verify routing end-to-end (optional, from outside)

```bash
curl -sI https://grafana-vox2.arcaai.com/api/health | head -1      # 200
curl -sI https://prometheus-vox2.arcaai.com/-/ready | head -1      # 200 (if published)
curl -sI https://alertmanager-vox2.arcaai.com/-/ready | head -1    # 200 (if published)
```

If a host 404s: the tunnel route is missing or `httpHostHeader` is set. If it
502s/timeouts: Traefik has the Ingress but the backend Service isn't ready, or the
connector is down.

---

## 3. Phase checklist

- [ ] `10-ingress.yaml` applied; 3 Ingresses with class `traefik`.
- [ ] Cloudflare public hostnames added → Traefik (no `httpHostHeader`).
- [ ] DNS CNAMEs proxied (orange).
- [ ] `https://grafana-vox2.arcaai.com/api/health` → `database: ok`.
- [ ] Prometheus/Alertmanager either behind Cloudflare Access **or** not published.
- [ ] Loki is not exposed publicly.

Next → [`07-gpu-server.md`](./07-gpu-server.md)
