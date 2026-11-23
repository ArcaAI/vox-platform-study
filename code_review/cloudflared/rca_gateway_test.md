# RCA — `gateway-test.arcaai.com` not routing

**Status:** RESOLVED
**Date:** 2026-11-04
**Namespace:** `project-hope-vox`
**Affected host:** `https://gateway-test.arcaai.com`
**Affected objects:** `Ingress/gateway-test-ingress`, `Service/gateway-test-svc`, `Deployment/gateway-test`

---

## 1. Summary

Traffic to `gateway-test.arcaai.com` returned Cloudflare's pass-through of Traefik's
default `404 page not found`. DNS, the Cloudflare Tunnel, the Service, its
Endpoints, and the pod were all healthy.

**Root cause:** the Ingress referenced **Service port `8868`**, but
`gateway-test-svc` only exposes **port `80`** (`targetPort: 8868`). Traefik
resolves Ingress backends against the **Service port**, not the pod/container
`targetPort`. Because no Service port `8868` exists, Traefik refused to build the
route and returned its own `404 page not found`.

**Fix:** point the Ingress backend at the Service port `80`. Applied live and
corrected in the source manifest.

---

## 2. Symptoms

```bash
curl -i https://gateway-test.arcaai.com/
```

Before the fix:

```http
HTTP/2 404
content-type: text/plain; charset=utf-8
content-length: 19
server: cloudflare
cf-ray: ...

404 page not found
```

The body was Traefik's built-in plain-text 404 — the request never reached the
`gateway-test` application.

---

## 3. Request path (all layers checked)

```
client
  -> Cloudflare edge (TLS terminated, proxied DNS)
  -> cloudflared tunnel "hope-vox2" (public hostname -> traefik:80)
  -> traefik.project-hope-vox.svc.cluster.local:80
  -> Ingress gateway-test-ingress (host match)
  -> Service gateway-test-svc :80
  -> pod gateway-test-* :8868
```

| Layer | Result | Evidence |
|---|---|---|
| DNS | OK | `gateway-test.arcaai.com` -> `172.67.164.217`, `104.21.10.250` (Cloudflare proxy) |
| Tunnel ingress rule | OK | cloudflared log: `gateway-test.arcaai.com -> http://traefik.project-hope-vox.svc.cluster.local:80` (config version 12) |
| cloudflared pods | OK | 2/2 `Running` |
| Ingress host / class | OK | `gateway-test.arcaai.com`, `ingressClassName: traefik` |
| Service | OK | `port: 80`, `targetPort: 8868`, `NodePort: 32319` |
| Endpoints | OK | `172.16.19.191:8868` |
| Pod | OK | `gateway-test-59475c688b-b5lmd` `1/1 Running`; app answers on `:8868` |
| **Ingress backend port** | **FAIL** | backend pointed at `gateway-test-svc:8868`, no such Service port |

---

## 4. Evidence

### 4.1 The mismatch

Ingress backend (`spec.rules[0].http.paths[0].backend`):

```json
{"service":{"name":"gateway-test-svc","port":{"number":8868}}}
```

Service ports:

```text
port=80 targetPort=8868
```

An Ingress `backend.service.port` must name a port **on the Service**
(`spec.ports[].port` or `spec.ports[].name`). `8868` is the `targetPort` only.

### 4.2 Traefik log (repeating)

```text
ERR Cannot create service error="service port not found"
    ingress=gateway-test-ingress namespace=project-hope-vox
    providerName=kubernetes serviceName=gateway-test-svc
    servicePort=&ServiceBackendPort{Name:,Number:8868,}
```

Traefik never created a load-balancer server for this Ingress, so the host fell
through to the default 404 handler.

---

## 5. Root cause

A copy/paste mismatch between the container port and the Service port:

- Container listens on `8868` (`Deployment/gateway-test`, `containerPort: 8868`).
- Service maps `port 80 -> targetPort 8868`.
- Ingress was written with `number: 8868` — the **targetPort** — instead of
  `number: 80` — the **Service port**.

The earlier example in `for_gatway-test.txt` contains the same mistake
(`service: gatway-test-svc` / `port: 8868`, while that Service also exposed
`80:30450`), which is the likely origin of the error. That older `nitik`
namespace Ingress/Service no longer exists; only the `project-hope-vox` objects
are live.

---

## 6. Solution applied

### 6.1 Live patch

```bash
kubectl -n project-hope-vox patch ingress gateway-test-ingress --type=json \
  -p '[{"op":"replace","path":"/spec/rules/0/http/paths/0/backend/service/port/number","value":80}]'
```

Result:

```text
ingress.networking.k8s.io/gateway-test-ingress patched
```

Current backend:

```text
{"service":{"name":"gateway-test-svc","port":{"number":80}}}
```

### 6.2 Manifest corrected

`review/cloudflared/nitik/gateway-test-ingress.yaml`:

```yaml
          - path: /
            pathType: Prefix
            backend:
              service:
                name: gateway-test-svc
                port:
                  # Must match the Service port (80), NOT the container targetPort (8868).
                  number: 80
```

The corrected manifest was applied and verified:

```bash
kubectl apply --dry-run=server -f review/cloudflared/nitik/gateway-test-ingress.yaml
# ingress.networking.k8s.io/gateway-test-ingress configured (server dry run)

kubectl apply -f review/cloudflared/nitik/gateway-test-ingress.yaml
# ingress.networking.k8s.io/gateway-test-ingress configured
```

The live object still reports `port.number: 80` and `https://gateway-test.arcaai.com/metrics`
returns `200` after the apply, so the manifest now reproduces the fixed state.

---

## 7. Verification

After the patch, the request reaches the Express application (headers and error
body are now the app's, not Traefik's):

```bash
curl -i https://gateway-test.arcaai.com/
```

```http
HTTP/2 404
content-type: application/json; charset=utf-8
x-powered-by: Express
...

{"message":"Cannot GET /","error":"Not Found","statusCode":404,"code":"HTTP.NOT_FOUND"}
```

A real application endpoint confirms end-to-end routing:

```bash
curl -o /dev/null -w '%{http_code}\n' https://gateway-test.arcaai.com/metrics
# 200
```

Additional checks:

```bash
# Traefik no longer reports "service port not found" for this Ingress after the patch
# (last such error was 06:29:00 UTC; none after the reconciled config)
kubectl -n project-hope-vox logs deploy/traefik --since=2m | grep gateway-test || echo "no gateway-test errors"

# Confirm backend port
kubectl -n project-hope-vox get ingress gateway-test-ingress \
  -o jsonpath='{.spec.rules[0].http.paths[0].backend}{"\n"}'
# {"service":{"name":"gateway-test-svc","port":{"number":80}}}
```

> Note: `GET /`, `/health`, `/healthz`, and `/swagger` return 404 from the app
> itself. That is the application's routing behaviour, not an ingress problem.
> Use `/metrics` (200) or a real API route for a health check.

---

## 8. Rollback

Only needed if the Service is changed back to expose `8868` directly:

```bash
kubectl -n project-hope-vox patch ingress gateway-test-ingress --type=json \
  -p '[{"op":"replace","path":"/spec/rules/0/http/paths/0/backend/service/port/number","value":8868}]'
```

Do not roll back while the Service exposes port `80`; that recreates this outage.

---

## 9. Prevention checklist

When adding a host behind the tunnel:

1. Ingress `backend.service.port.number` **must equal** `Service.spec.ports[].port`
   (or use a named port and reference the name).
2. Do not use the container `targetPort` in the Ingress.
3. Verify with Traefik logs — a successful route produces no
   `Cannot create service` / `service port not found` errors.
4. Test a real route (e.g. `/metrics`), not just `/`, because many services
   return 404 on `/` by design.
5. Keep the Ingress manifest in `review/cloudflared/` as the source of truth and
   apply it with `kubectl apply -f`, instead of hand-editing in the cluster.

Useful one-liner to catch this class of error before applying:

```bash
# Compare every Ingress backend port with its Service's exposed ports
kubectl get ingress -A -o json > /tmp/ingress.json
python3 - /tmp/ingress.json <<'EOF'
import json, subprocess, sys
ing = json.load(open(sys.argv[1]))
for i in ing["items"]:
    ns = i["metadata"]["namespace"]
    for rule in i["spec"].get("rules", []):
        for p in rule.get("http", {}).get("paths", []):
            b = p["backend"].get("service")
            if not b:
                continue
            svc = subprocess.check_output(
                ["kubectl", "-n", ns, "get", "svc", b["name"], "-o", "json"]
            )
            svc = json.loads(svc)
            ports = {str(x["port"]) for x in svc["spec"]["ports"]}
            names = {x.get("name") for x in svc["spec"]["ports"]}
            want = b["port"].get("number") or b["port"].get("name")
            if str(want) not in ports | names:
                print(f"MISMATCH {ns}/{i['metadata']['name']} -> "
                      f"{b['name']}:{want} (service ports: {sorted(ports)})")
EOF
```

---

## 10. Timeline (UTC)

| Time | Event |
|---|---|
| 2026-11-04 ~06:23 | Confirmed external 404; Traefik logs show `service port not found` for port 8868 |
| 2026-11-04 ~06:28 | Patched Ingress backend port 8868 -> 80 |
| 2026-11-04 ~06:29 | Verified: app responses reach the client; `/metrics` returns 200 |
| 2026-11-04 ~06:30 | Corrected `review/cloudflared/nitik/gateway-test-ingress.yaml` |
| 2026-11-04 ~06:32 | Applied corrected manifest; re-verified `/metrics` = 200 after apply |
