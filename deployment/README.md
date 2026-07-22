# HOPE Platform — Cluster Deployment (k3s + ArgoCD)

Introduced: 2026-07-04 · Last verified: 2026-07-21

GitOps deployment of the HOPE application services onto the self-hosted k3s cluster. ArgoCD watches this repository's Kustomize overlays and syncs them into per-environment namespaces.

Scope boundaries:

- This directory deploys the application layer (API, Python services, UI, Redis, LLM engines).
- PostgreSQL and MinIO are provisioned outside these manifests (see Prerequisites).
- Vault production deployment is a separate stack: [infrastructure/single-deployment/vault/](../infrastructure/single-deployment/vault/README.md).
- Local development does not use any of this — see [infrastructure/docker/](../infrastructure/docker/README.md).

## Directory structure

```
deployment/
├── README.md                          # This file
├── secrets.dev.yaml.example           # Secret template for hope-v2-dev (copy, fill, apply)
├── secrets.prod.yaml.example          # Secret template for hope-v2-prod (copy, fill, apply)
├── argocd/
│   ├── bootstrap.dev.yaml.example     # Namespace + AppProject + dev Application (template; no ImageUpdater — dev tags are manual)
│   └── bootstrap.prod.yaml.example    # Same for prod + semver ImageUpdater (template)
└── k3s/
    ├── base/                          # Shared Kustomize base
    │   ├── kustomization.yaml
    │   ├── configmap.yaml             # Non-secret config (hope-config)
    │   ├── redis.yaml                 # StatefulSet + Service (5Gi PVC)
    │   ├── ollama.yaml                # LLM engine Deployment + Service (GPU, 100Gi model PVC)
    │   ├── lmstudio.yaml              # ExternalName Service alias for the out-of-cluster LM Studio host
    │   ├── api.yaml                   # Deployment + Service + Ingress (8868)
    │   ├── admin-console.yaml         # Deployment + Service + Ingress (3000) — Next.js admin console (TASK-415)
    │   ├── guardrail.yaml             # Deployment + Service (8863)
    │   ├── reranker.yaml              # TEI reranker Deployment + Service (public image)
    │   ├── vllm.yaml                  # StatefulSet + Service (8000, GPU) — production vLLM engine (public image)
    │   ├── llama-cpp.yaml             # Deployment + Service + PVC (8080) — production llama.cpp GGUF engine (public image)
    │   ├── smr.yaml                   # Deployment + Service (8862)
    │   ├── stt-v2.yaml                # Deployment + Service (8861, GPU)
    │   ├── stt-v2-worker.yaml         # Deployment, no Service
    │   ├── tts-v2.yaml                # Deployment + Service (8865)
    │   ├── ui.yaml                    # Deployment + Service + Ingress (3000) — ui-playground (deprecated)
    │   └── db-migrate.yaml            # Job, ArgoCD PreSync hook (runs Prisma migrations)
    ├── components/
    │   └── registry/
    │       └── kustomization.yaml     # Rewrites hope-v2/* image names to the private registry + adds pull secrets
    └── overlays/
        ├── dev/kustomization.yaml     # Namespace hope-v2-dev, dev config patches, image tags
        └── prod/kustomization.yaml    # Namespace hope-v2-prod, prod config patches, replicas, image tags
```

## Environments

Defined by the ArgoCD bootstrap templates in `argocd/`:

| Environment | Namespace | Overlay path | Tracked revision | Sync |
|---|---|---|---|---|
| Development | `hope-v2-dev` | `deployment/k3s/overlays/dev` | `main` | Automated (prune + self-heal) |
| Production | `hope-v2-prod` | `deployment/k3s/overlays/prod` | `prod` | Manual |

Ingress hostnames are patched per overlay: `api-dev.hope.local` / `ui-dev.hope.local` / `admin-dev.hope.local` (dev), `api.hope.local` / `ui.hope.local` / `admin.hope.local` (prod). Replace with real DNS names when wiring a public domain.

## How it works

1. ArgoCD `Application` resources (from the bootstrap files) point at the overlay directories in this repo.
2. Kustomize renders base + overlay: the `registry` component rewrites `hope-v2/*` image names to `registry.taphuynh.dev/arca/hope-v2/*` and injects `imagePullSecrets: hope-registry-creds` into every Deployment and Job; the overlay pins image tags via its `images:` block and patches config, hostnames, and replicas. (Known gap, found in TASK-414: the component's `newName` rewrite runs before the overlay `images:` block, whose entries match the original `hope-v2/*` names — so the `newTag` pins currently do not take effect and manifests render with `:latest`, a tag CI never pushes. See the caveat comments in the overlay files.)
3. On every sync, the `hope-db-migrate` Job runs as an ArgoCD PreSync hook (sync-wave -1) and applies Prisma migrations using the `hope-v2/database` image before the services roll.
4. Image tags in the overlays are not written by CI (the CI `deploy-staging` job targets the separate `hope-deployments` repo — see [CI/CD](#cicd-gitlab)). Dev tags are bumped manually on `main` (auto-synced). For prod, the bootstrap template optionally installs an ArgoCD Image Updater CR that tracks the semver tags CI pushes on `v*` releases and writes them back to the `prod` branch; syncing prod remains manual either way.

## Bootstrap (one-time per environment)

```bash
# 1. Secrets first (namespaces are also created by the bootstrap manifest;
#    create the namespace up front if you apply secrets before bootstrap):
cp deployment/secrets.dev.yaml.example deployment/secrets.dev.yaml   # fill all <REPLACE_*> values
kubectl create namespace hope-v2-dev --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -f deployment/secrets.dev.yaml -n hope-v2-dev

# 2. ArgoCD bootstrap (AppProject, Application, repo/registry creds, ImageUpdater):
cp deployment/argocd/bootstrap.dev.yaml.example deployment/argocd/bootstrap.dev.yaml   # fill placeholders
kubectl apply -f deployment/argocd/bootstrap.dev.yaml -n argocd
```

Repeat with the `prod` files for production. Do not commit the filled-in copies — only the `.example` templates are tracked.

The filled secrets provide `hope-secrets` (DB/Redis/MinIO/Azure/API keys consumed by the Deployments) and `hope-registry-creds` (image pull secret) in the target namespace.

## Prerequisites

- k3s cluster with the default Traefik ingress and `local-path` StorageClass (`kubectl get storageclass`).
- ArgoCD installed, plus ArgoCD Image Updater v2 (CRD-based) if image automation is wanted — install/patch commands are in the bootstrap template headers.
- Private registry access (`registry.taphuynh.dev`) — credentials go into `hope-registry-creds` via the secrets file.
- PostgreSQL reachable at the host configured in the secrets file (`DATABASE_URL`, default host name `hope-postgres`). There is no Postgres manifest in `k3s/base` — the database must exist before the first sync (the PreSync migrate Job connects to it).
- MinIO reachable at `MINIO_ENDPOINT` from the secrets file (runs on a separate VM in the homelab setup).
- A GPU node for `stt-v2` and `ollama` (both request `nvidia.com/gpu: 1`).
- An LM Studio host serving the OpenAI-compatible API on port 1234: set the real DNS name in `k3s/base/lmstudio.yaml` (ExternalName Service `hope-lmstudio`; an IP-based Service+Endpoints variant is documented inside that file). SMR, guardrail, and harness resolve it via the configmap.

### Database provisioning

PostgreSQL is not managed by this kustomization: there is no Postgres Deployment/StatefulSet/Service anywhere under `k3s/` (verified across base, components, and overlays). The manifests only *reference* a database host — `POSTGRES_HOST: hope-postgres` in `k3s/base/configmap.yaml`, and `hope-postgres` as the default host inside `DATABASE_URL` / `STT_V2_DATABASE_URL` in the secrets templates. Nothing creates a Service named `hope-postgres`, so that name does **not** resolve in-cluster on its own. Before the first sync the operator must do one of:

- Create an alias Service for the external Postgres host in the target namespace — ExternalName for a DNS name, or a selector-less Service + Endpoints for a raw IP (the same pattern, including the `commonLabels` caveat, is documented in `k3s/base/lmstudio.yaml` for `hope-lmstudio`).
- Or skip the alias and put the real reachable host directly into the secrets' `DATABASE_URL` / `STT_V2_DATABASE_URL` (and patch `POSTGRES_HOST` in an overlay if anything relies on it).

Either way the database itself must exist and accept connections before bootstrapping — the `hope-db-migrate` PreSync Job connects via `DATABASE_URL` on every sync, so a wrong or unresolvable host fails the sync at the migration step.

## Services (as deployed by `k3s/base`)

| Service | Kind | Port | Exposed via Ingress |
|---|---|---|---|
| hope-api | Deployment | 8868 | Yes |
| hope-admin-console | Deployment | 3000 | Yes (`admin[-dev].hope.local`) |
| hope-ui (ui-playground, deprecated) | Deployment | 3000 | Yes |
| hope-smr | Deployment | 8862 | No |
| hope-guardrail | Deployment | 8863 | No |
| hope-stt-v2 | Deployment (GPU) | 8861 | No |
| hope-stt-v2-worker | Deployment | — | No |
| hope-tts-v2 | Deployment | 8865 | No |
| hope-redis | StatefulSet | 6379 | No |
| hope-ollama | Deployment (GPU) | 11434 | No |
| hope-vllm | StatefulSet (GPU, public image) | 8000 | No |
| hope-llama-cpp | Deployment (public image) | 8080 | No |
| hope-reranker | Deployment (public TEI image) | 80 | No |
| hope-lmstudio | ExternalName Service | 1234 | No (alias to external host) |
| hope-db-migrate | Job (PreSync hook) | — | — |

Resource requests/limits are set per manifest in `k3s/base/` and patched per overlay where needed.

> The NLP service has no k3s manifest (the orphaned, never-registered `nlp.yaml` was removed 2026-07-22 by owner decision) — the base does not deploy hope-nlp; the gateway's `NLP_URL` config remains for out-of-cluster or future deployment. `vllm.yaml`, `llama-cpp.yaml`, and `tts-v2.yaml` are all registered. Third-party images (`hope-vllm`, `hope-llama-cpp`, `hope-reranker`, `hope-ollama`) are pinned and NOT rewritten by the registry component.

### Admin console (hope-admin-console) notes

The Next.js admin console (TASK-415) has three deployment-sensitive settings:

- **`CORS_ALLOWED_ORIGINS` (API side) must include the console origin.** The console's REST traffic is same-origin through its BFF proxy (no CORS involved), but SSE/WS streams connect the **browser directly to the gateway** using single-use stream tickets, which is a cross-origin request from the console hostname (e.g. `https://admin.hope.local`). The base configmap ships `"*"`; any prod overlay that restricts the list must keep the console origin in it (see the comment in `k3s/base/configmap.yaml`).
- **`NEXT_PUBLIC_API_HOST` is baked in at image build time.** Next.js inlines `NEXT_PUBLIC_*` into the client bundle during `next build`, so the runtime configmap value only affects server rendering. The image must be built with the browser-reachable gateway origin for the target environment (CI build arg), and rebuilt if that origin changes.
- **`ADMIN_SESSION_SECRET`** (session-cookie encryption key) must exist in the `hope-secrets` Secret — see `secrets.dev.yaml.example` / `secrets.prod.yaml.example`.

For clusters deployed from the separate **`hope-deployments`** repo (Helm values, see CI/CD below), the same three items must be set there: the `admin-console` image entry (CI `deploy-staging` writes tags), values for `API_URL` / `NEXT_PUBLIC_API_HOST` / the session-secret reference, the admin ingress host, and the API chart's `CORS_ALLOWED_ORIGINS` including that host's origin. That repo is external to this one — verify the exact keys against its charts when wiring it up.

## CI/CD (GitLab)

The pipeline is defined in `.gitlab-ci.yml` + `.gitlab/ci/*.yml` at the repo root. Deployment-relevant facts:

- Branch strategy: `main` (MR gates only), `dev` (manual builds), `staging` (builds + deploy), `cicd` (pipeline testing), `release-sdk` / `release-playground` (publishing), plus `v*` tags for releases.
- Images are tagged without `latest`: semver tags for releases, `staging-<sha8>` / `dev-<sha8>` / `cicd-<sha8>` per branch, and an immutable `sha-<sha8>`.
- The `deploy-staging` job (staging branch) updates image tags in a separate deployment repository (`hope-deployments`, Helm values files) that ArgoCD watches, and an optional `sync-argocd` job triggers syncs via the ArgoCD API. Required CI variables: `DEPLOY_REPO_URL`, `DEPLOY_TOKEN`, optional `ARGOCD_SERVER` / `ARGOCD_AUTH_TOKEN` — see `.gitlab/ci/deploy.yml`.
- A manual `smoke-pgbouncer-staging` job runs `scripts/smoke-pgbouncer.sh` against the staging PgBouncer over SSH.

Note that the in-repo kustomize flow (this directory) and the CI deploy job (separate `hope-deployments` repo) are two different ArgoCD source layouts; see the comments in `.gitlab/ci/deploy.yml` and the bootstrap templates for which applies to your cluster.

## Common operations

### Rollback a service

```bash
kubectl rollout undo deployment/hope-api -n hope-v2-dev
kubectl rollout history deployment/hope-api -n hope-v2-dev
```

### View logs

```bash
kubectl logs -f deployment/hope-api -n hope-v2-dev
kubectl logs --tail=100 deployment/hope-api -n hope-v2-dev
kubectl logs -f <pod-name> -n hope-v2-dev --all-containers
```

### Shell into a pod

```bash
kubectl exec -it deployment/hope-api -n hope-v2-dev -- sh
kubectl exec -it hope-redis-0 -n hope-v2-dev -- redis-cli -a <password>
```

### Scale a service

```bash
kubectl scale deployment/hope-api -n hope-v2-dev --replicas=2
```

### Port-forward for local testing

```bash
kubectl port-forward svc/hope-api -n hope-v2-dev 8868:8868
```

## Troubleshooting

### Pod stuck in CrashLoopBackOff

```bash
kubectl describe pod <pod-name> -n hope-v2-dev
kubectl logs <pod-name> -n hope-v2-dev --previous
```

### Image pull errors

```bash
kubectl get secret hope-registry-creds -n hope-v2-dev
# If credentials rotated, update secrets.dev.yaml and re-apply:
kubectl apply -f deployment/secrets.dev.yaml -n hope-v2-dev
kubectl describe pod <pod-name> -n hope-v2-dev | grep -A5 Events
```

### Migration job failing

```bash
kubectl logs job/hope-db-migrate -n hope-v2-dev
# Verify DATABASE_URL in the hope-secrets Secret points at a reachable Postgres.
```

### Service not reachable

```bash
kubectl get endpoints -n hope-v2-dev
kubectl get ingress -n hope-v2-dev
kubectl describe ingress hope-api -n hope-v2-dev
```

## K3s and Rancher notes

### Storage class

K3s ships the `local-path` provisioner. All PVCs (Redis 5Gi, Ollama models 100Gi, STT models) use the cluster default StorageClass.

### Private registry (containerd)

K3s uses containerd. If the registry is not served over trusted TLS, add it to `/etc/rancher/k3s/registries.yaml` on the cluster node and restart k3s:

```yaml
mirrors:
  "registry.taphuynh.dev":
    endpoint:
      - "https://registry.taphuynh.dev"
```

```bash
sudo systemctl restart k3s
```

### Traefik ingress

All Ingress resources use `ingressClassName: traefik` (the k3s default controller). Each environment gets unique hostnames via overlay patches to avoid routing conflicts.

### Rancher

Namespaces appear in Rancher automatically after the first sync; group `hope-v2-dev` / `hope-v2-prod` into a Rancher project for visibility. If the Rancher agent loses connectivity, check `kubectl get pods -n cattle-system` and its logs on the cluster node.
