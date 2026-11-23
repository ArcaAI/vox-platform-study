# Traefik on k3s — Findings

> **⚠️ INITIAL INVESTIGATION — REFERENCE ESTATE ONLY.**
> This file describes the **k3s cluster** used by the `taphuynh.dev` deployment
> (k3s-bundled Traefik in `kube-system`). It does **NOT** describe the lab
> cluster, which is **kubeadm** and runs a **self-installed Helm Traefik
> `v3.7.14`** in `project-hope-vox` (see `current-setup.md` §3). It is kept for
> background/reference. For the vox2 rollout follow `steps_to_follow.md`.

Findings from reviewing how Traefik is deployed and configured for the HOPE v2
deployment on a **k3s** cluster, and how it integrates with the Cloudflare Tunnel.

---

## 1. What version of Traefik is used?

There is **no pinned Traefik version** in the Arca manifests.

| Location | What it says |
|---|---|
| `Arca-AgenticSystemDeployment/traefik/values.yaml` | No image tag set |
| `Arca-AgenticSystemDeployment/AWS/k8s/traefik/values.yaml` | Identical to the above (mirror) |
| `Arca-AgenticSystemDeployment/traefik/README.md:34` | `helm upgrade --install traefik traefik/traefik ...` with **no `--version`** -> resolves to the latest chart at deploy time |
| `Arca-AgenticSystemDeployment/HIGH_LEVEL_DESIGN.md:1006` | Lists Traefik (with MinIO MC, LangFlow) as an "unpinned image" using `latest` |
| `project-hope/docs/archive/TASK-984-.../README.md:43` | **Only concrete version:** the cluster Traefik is `rancher/mirrored-library-traefik:3.6.9` |
| `project-hope/docs/archive/TASK-616-.../live-state-2026-08.md:16` | k3s `v1.34.5+k3s1`; Traefik/servicelb **not** disabled |

Conclusion: on this cluster Traefik's version is **whatever k3s bundles** (currently
**3.6.9**); nothing in the Arca repo pins it. To make it deterministic, add `--version`
to the Helm command or set `image.tag` in `values.yaml`.

---

## 2. How Traefik is provided on k3s

- k3s ships **Traefik v3 as the default ingress controller**, deployed into
  **`kube-system`** by the k3s helm-controller, with `IngressClass` named `traefik`
  (`traefik.io/ingress-controller`).
- It is disabled only if the server was started with `--disable=traefik`. This cluster
  does **not** disable it (`TASK-616` live-state).
- Therefore on a stock k3s cluster you **configure the bundled Traefik**; you do not
  install it. A separate Helm install would create a **second** Traefik and duplicate
  routers.

### Customizing the bundled chart
k3s manages it via helm-controller, so do **not** `helm upgrade` it directly. Use a
`HelmChartConfig` named `traefik` in `kube-system` (drop it in
`/var/lib/rancher/k3s/server/manifests/` or `kubectl apply` it):

```yaml
apiVersion: helm.cattle.io/v1
kind: HelmChartConfig
metadata:
  name: traefik
  namespace: kube-system
spec:
  valuesContent: |-
    # e.g. enable access logs, dashboard, extra entrypoints
```

The bundled chart already enables the **Kubernetes Ingress** and **CRD** providers, so
most routing needs no chart change.

---

## 3. The Arca self-installed approach (for contrast)

`Arca-AgenticSystemDeployment/traefik/` describes a **different** topology than the live
cluster:

| Aspect | Arca manifests | Live HOPE v2 (k3s bundled) |
|---|---|---|
| Install | Official Helm chart into namespace `traefik` | k3s bundled, namespace `kube-system` |
| IngressClass | `traefik` (non-default) | `traefik` |
| Exposure | `Service` type **NodePort**, web on `30080` | ClusterIP `:80` (behind the tunnel); ServiceLB gives a LoadBalancer on the node |
| Dynamic config | **file provider** at `/etc/traefik/dynamic` (`dynamic-config.yaml`) | bundled chart's default **Ingress + CRD** providers |
| Middlewares | file-format, referenced `@file` | should be `traefik.io/v1alpha1` CRDs, referenced `@kubernetescrd` |
| Front door | in-cluster `cloudflared` -> `http://traefik.traefik.svc.cluster.local:80` | in-cluster `cloudflared` -> `http://traefik.kube-system.svc.cluster.local:80` |

To reuse the Arca manifests with bundled Traefik, two edits are needed:
1. cloudflared service target: `traefik.traefik.svc.cluster.local:80` ->
   `traefik.kube-system.svc.cluster.local:80`.
2. middlewares: port `dynamic-config.yaml` to CRDs and change `@file` -> `@kubernetescrd`.

---

## 4. Traefik configuration relevant to k3s

From `Arca-AgenticSystemDeployment/traefik/values.yaml` and
`dynamic-config.yaml`:

- Entrypoint `web` on port 80; `websecure` disabled (TLS terminates at Cloudflare).
- `serversTransport.insecureSkipVerify=true` (relevant when origins use self-signed TLS).
- Dashboard enabled but not exposed.
- Middlewares: `secure-headers`, `gzip-compress`, `retry-default`, rate limits
  (`rl-dev`/`rl-test`/`rl-prod`, `rl-ai-heavy`/`rl-ai-light`), `ip-whitelist*`,
  `authentik-forwardauth`, and chains (`chain-dev`/`chain-test`/`chain-prod`,
  `chain-ai-admin`, `chain-ai-services`).
- Streaming (from `review/deploy/11-traefik-ingress-setup.md:124-145`): a `buffering`
  Middleware (`maxRequestBodyBytes: 0`, `retryExpression: ""`) plus a `ServersTransport`
  with `responseHeaderTimeout: 0s` / `idleConnTimeout: 0s`. Without these, WS/SSE paths
  (`/ws/stt/stream`, ticketed SSE) return 502/504 — an ingress symptom, not an app bug.

### Ingress wiring
App Ingresses use `ingressClassName: traefik`, e.g.
`arca-deployment-template/deployment/k8s/base/grafana.yaml:228`. Middleware references in
the live cluster are CRD-scoped, e.g.
`traefik.ingress.kubernetes.io/router.middlewares: project-hope-vox/hope-no-buffer@kubernetescrd`
(`review/deploy/11-traefik-ingress-setup.md:77`).

> **Correction (verified against Traefik v3.7 source):** that reference is wrong.
> The Ingress-provider annotation format is `<namespace>-<name>@kubernetescrd`
> (**dash**, not slash), i.e.
> `project-hope-vox-hope-no-buffer@kubernetescrd`. The CRD key is
> `Normalize("<ns>-<name>")+"@kubernetescrd"` and Traefik resolves the annotation
> string **verbatim**; a non-matching reference makes Traefik drop the router
> (route 404s). The same applies to `service.serverstransport`. The bug is
> inherited from `review/deploy/11-traefik-ingress-setup.md:77`.

---

## 5. Deployment / configuration steps for k3s (bundled Traefik)

1. **Verify state**
   ```bash
   k3s --version
   kubectl get ingressclass                      # expect: traefik
   kubectl -n kube-system get deploy,svc traefik  # svc ports 80->web, 443->websecure
   kubectl -n kube-system get helmchart traefik
   ```
2. **Customize only if needed** via `HelmChartConfig` in `kube-system` (Phase 2 above).
3. **Define middlewares as CRDs** (`traefik.io/v1alpha1`), namespaced per app.
4. **Wire Ingresses** with `ingressClassName: traefik` and `@kubernetescrd` middleware
   annotations.
5. **Run the in-cluster `cloudflared` tunnel** (see `cloudflare-tunnel-reference.md`):
   token Secret + ConfigMap (`*.${DOMAIN}` -> `traefik.kube-system.svc.cluster.local:80`)
   + Deployment (pin image by digest, 2 replicas, `/ready` readiness, `/metrics`
   liveness).
6. **Verify**
   ```bash
   kubectl -n <tunnel-ns> logs deploy/cloudflared -f
   kubectl get ingress -A
   curl -I https://api-dev.taphuynh.dev
   kubectl -n kube-system port-forward svc/traefik 9000:9000   # dashboard
   ```
7. **Repo boundary:** cluster manifests belong in the GitOps deployment repo (Argo), not
   in `project-hope` (`review/deploy/11-traefik-ingress-setup.md:8`).

---

## 6. Open items

- Pin the Traefik version (chart `--version` or `image.tag`) and the cloudflared image
  digest, so upgrades are intentional.
- Decide between bundled Traefik and the Arca Helm install; do not run both.
- Port the file-provider middlewares to CRDs before switching to bundled Traefik.
- Confirm the bundled Traefik Service DNS namespace (`kube-system`, confirmed by the
  canonical `cloudflared.yaml`).
