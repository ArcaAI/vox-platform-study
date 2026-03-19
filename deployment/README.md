# HOPE Platform - Deployment Guide

All deployments are automated via **GitLab CI/CD**. Pushing to `dev`, `test`, or `prod` branches triggers the pipeline automatically.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│  VM 200 (128GB RAM, 64 CPU, 300GB SSD) - Kubernetes        │
│                                                             │
│  Namespaces: hope-dev │ hope-test │ hope-prod               │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │  hope-api    │  │  hope-ui     │  │  hope-nlp    │      │
│  │  (NestJS)    │  │  (React/Vite)│  │  (Python)    │      │
│  │  :8868       │  │  :5175       │  │  :8864       │      │
│  └──────┬───────┘  └──────┬───────┘  └──────────────┘      │
│         │                 │                                  │
│  ┌──────┴───────┐  ┌──────┴───────┐                         │
│  │  hope-smr    │  │  hope-stt-v2 │                         │
│  │  (Python)    │  │  (Python)    │                         │
│  │  :8862       │  │  :8861       │                         │
│  └──────────────┘  └──────────────┘                         │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐                         │
│  │  PostgreSQL  │  │  Redis       │                         │
│  │  :5432       │  │  :6379       │                         │
│  └──────────────┘  └──────────────┘                         │
│                                                             │
│  Traefik Ingress (managed by Rancher)                       │
└─────────────────────────────────────────────────────────────┘

External:
  VM 402 - MinIO (object storage)
  VM 410 - GitLab
  VM 411 - GitLab Runner
  VM 400 - Rancher

Public endpoints (via Cloudflare):
  - hope-api   → api-{env}.<your-domain>
  - hope-ui    → {env}.<your-domain>
```

## Environments

| Environment | Branch | Namespace | NODE_ENV | Image Tag Suffix |
|-------------|--------|-----------|----------|------------------|
| Development | `dev` | `hope-dev` | `development` | `dev` |
| Testing | `test` | `hope-test` | `test` | `test` |
| Production | `prod` | `hope-prod` | `production` | `prod` |

**Ingress hostnames per environment (Traefik on K3s):**

| Environment | UI Hostname | API Hostname |
|-------------|-------------|--------------|
| dev | `dev.hope.local` | `api-dev.hope.local` |
| test | `test.hope.local` | `api-test.hope.local` |
| prod | `prod.hope.local` | `api-prod.hope.local` |

> Each environment gets unique hostnames to avoid Traefik routing conflicts across namespaces on the same K3s cluster.

## Services

| Service | Type | Port | Image Tag Pattern | Public |
|---------|------|------|-------------------|--------|
| api | NestJS backend | 8868 | `api-{env}-latest` | Yes |
| ui-playground | React/Vite frontend | 5175 | `ui-playground-{env}-latest` | Yes |
| nlp | Python NLP service | 8864 | `nlp-{env}-latest` | No |
| smr | Python summarization | 8862 | `smr-{env}-latest` | No |
| stt-v2 | Python speech-to-text | 8861 | `stt-v2-{env}-latest` | No |

## Directory Structure

```
infrastructure/deploy/
├── README.md                    # This file
├── gitlab-ci.yml                # GitLab CI/CD pipeline definition
└── k3s/
    ├── namespace/
    │   └── namespace.yaml       # Namespace (uses __NAMESPACE__ placeholder)
    ├── config/
    │   ├── configmap.yaml       # Non-sensitive configuration (templated)
    │   └── secrets.yaml.template # Template for environment secrets
    ├── infra/
    │   ├── postgres.yaml        # PostgreSQL StatefulSet + Service
    │   └── redis.yaml           # Redis StatefulSet + Service
    ├── services/
    │   ├── api.yaml             # API Deployment + Service + Ingress
    │   ├── nlp.yaml             # NLP Deployment + Service
    │   ├── smr.yaml             # SMR Deployment + Service
    │   ├── stt-v2.yaml          # STT-V2 Deployment + Service + PVC
    │   └── ui-playground.yaml   # UI Deployment + Service + Ingress
    └── jobs/
        └── db-migrate.yaml      # Database migration Job
```

**Manifest templating:** All YAML manifests use placeholders (`__NAMESPACE__`, `__ENV__`, `__NODE_ENV__`, `__IMAGE_TAG__`) that are substituted at deploy time via `sed` in the CI pipeline.

---

## GitLab CI/CD Pipeline

### How It Works

```
git push to branch (dev / test / prod)
  └─> build stage (only changed services, parallel, env-tagged)
        └─> migrate stage (if packages/database/** changed)
              └─> deploy stage (rolling update to hope-{env} namespace)
```

**Image tagging convention:**
```
{service}-{env}-latest      e.g., api-dev-latest, stt-v2-prod-latest
{service}-{env}-{sha}       e.g., api-dev-abc1234
```

Each build job only runs when its relevant source files change. For example, `build-api` triggers on changes to `apps/api/**`, `packages/applications/**`, `packages/database/**`, etc.

### Setup (One-Time)

1. **Copy the CI config to the repo root:**
   ```bash
   cp infrastructure/deploy/gitlab-ci.yml .gitlab-ci.yml
   ```

2. **Set GitLab CI/CD variables** (Settings > CI/CD > Variables):

   | Variable | Value | Protected | Masked |
   |----------|-------|-----------|--------|
   | `KUBECONFIG_CONTENT` | Base64-encoded kubeconfig | Yes | Yes |
   | `CI_REGISTRY_USER` | GitLab username | No | No |
   | `CI_REGISTRY_PASSWORD` | GitLab password/token | Yes | Yes |

   Generate `KUBECONFIG_CONTENT`:
   ```bash
   base64 -i ~/.kube/config | tr -d '\n'
   ```

3. **Create Kubernetes secrets** for each environment (these are applied via kubectl, not committed to git):
   ```bash
   cd infrastructure/deploy/k3s/config
   cp secrets.yaml.template secrets.dev.yaml   # Edit and fill values
   cp secrets.yaml.template secrets.test.yaml   # Edit and fill values
   cp secrets.yaml.template secrets.prod.yaml   # Edit and fill values
   ```
   Then apply them to the cluster:
   ```bash
   kubectl apply -f secrets.dev.yaml -n hope-dev
   kubectl apply -f secrets.test.yaml -n hope-test
   kubectl apply -f secrets.prod.yaml -n hope-prod
   ```

### Deploying

Push to the target branch — the pipeline handles everything:

```bash
git push origin dev    # → builds & deploys to hope-dev
git push origin test   # → builds & deploys to hope-test
git push origin prod   # → builds & deploys to hope-prod
```

### Pipeline Stages

| Stage | What It Does | When It Runs |
|-------|-------------|--------------|
| **build** | Builds Docker images, pushes to GitLab registry | Changed source files for each service |
| **migrate** | Runs database migration job | `packages/database/**` changed |
| **deploy** | Applies K3s manifests, rolling restart | Changed service or infra files |

---

## Common Operations

### Rollback a Service

```bash
kubectl rollout undo deployment/hope-api -n hope-dev

# Check rollout history
kubectl rollout history deployment/hope-api -n hope-dev
```

### View Logs

```bash
# Follow logs (replace hope-dev with target namespace)
kubectl logs -f deployment/hope-api -n hope-dev

# Last 100 lines
kubectl logs --tail=100 deployment/hope-api -n hope-dev

# All containers in a pod
kubectl logs -f <pod-name> -n hope-dev --all-containers
```

### Shell into a Pod

```bash
kubectl exec -it deployment/hope-api -n hope-dev -- sh
kubectl exec -it hope-postgres-0 -n hope-dev -- psql -U <user> -d hope
kubectl exec -it hope-redis-0 -n hope-dev -- redis-cli -a <password>
```

### Scale a Service

```bash
kubectl scale deployment/hope-api -n hope-dev --replicas=2
```

### Port-Forward for Local Testing

```bash
# Access API locally
kubectl port-forward svc/hope-api -n hope-dev 8868:8868

# Access PostgreSQL locally
kubectl port-forward svc/hope-postgres -n hope-dev 5432:5432
```

---

## Troubleshooting

### Pod stuck in CrashLoopBackOff

```bash
# Check error (replace hope-dev with target namespace)
kubectl describe pod <pod-name> -n hope-dev
kubectl logs <pod-name> -n hope-dev --previous
```

### Image pull errors

```bash
# Verify image exists in registry
curl -s http://gitlab-server:5000/v2/arca/tags/list | python3 -m json.tool

# Check pod events
kubectl describe pod <pod-name> -n hope-dev | grep -A5 Events
```

### Database connection issues

```bash
# Verify postgres is running
kubectl get pods -n hope-dev -l app=hope-postgres

# Test connectivity from another pod
kubectl exec -it deployment/hope-api -n hope-dev -- \
  sh -c 'wget -qO- http://hope-postgres:5432 || echo "Port open"'
```

### Service not reachable

```bash
# Check service endpoints
kubectl get endpoints -n hope-dev

# Check ingress
kubectl get ingress -n hope-dev
kubectl describe ingress hope-api -n hope-dev
```

### Reset an environment

```bash
# Delete all resources for an environment (DESTRUCTIVE)
kubectl delete namespace hope-dev

# Re-trigger pipeline to redeploy
git push origin dev
```

---

## Resource Allocation (VM 200: 128GB RAM, 64 CPU)

**Per environment:**

| Component | CPU Request | CPU Limit | Memory Request | Memory Limit |
|-----------|-------------|-----------|----------------|--------------|
| PostgreSQL | 1 | 4 | 2Gi | 8Gi |
| Redis | 250m | 1 | 256Mi | 1Gi |
| API | 500m | 2 | 512Mi | 2Gi |
| NLP | 250m | 1 | 256Mi | 1Gi |
| SMR | 500m | 2 | 512Mi | 2Gi |
| STT-V2 | 4 | 8 | 8Gi | 16Gi |
| UI | 100m | 500m | 64Mi | 256Mi |
| **Total/env** | **~6.6** | **~18.5** | **~11.6Gi** | **~30.3Gi** |

**Multi-environment capacity (all 3 envs at limits):**

| | CPU Limit | Memory Limit | Storage (PVC) |
|--|-----------|--------------|---------------|
| Per environment | ~18.5 | ~30.3Gi | ~155Gi (100Gi PG + 5Gi Redis + 50Gi STT models) |
| 3 environments | ~55.5 | ~90.9Gi | ~465Gi |
| VM 200 capacity | 64 CPU | 128Gi RAM | 300Gi SSD |

> **Storage warning:** 3 full environments would request ~465Gi on a 300GB SSD. Consider:
> - Sharing PostgreSQL across envs (separate DBs, same instance)
> - Sharing the STT-V2 model PVC across envs (ReadOnlyMany)
> - Or: only running 1-2 environments at full scale

---

## K3s & Rancher Notes

### Storage Class

K3s ships with the `local-path` provisioner (StorageClass: `local-path`). All PVCs in the manifests use the cluster default StorageClass. Verify it's set:

```bash
kubectl get storageclass
# Should show local-path (default)
```

### Insecure Registry for K3s (containerd)

K3s uses **containerd** (not Docker). To pull images from the insecure GitLab registry, the `/etc/rancher/k3s/registries.yaml` on **VM 200** must include the registry used in image tags:

```yaml
# /etc/rancher/k3s/registries.yaml on VM 200
mirrors:
  "gitlab-server:5000":
    endpoint:
      - "http://gitlab-server:5000"
```

Also ensure VM 200 can resolve `gitlab-server` — add to `/etc/hosts` if needed:
```bash
echo "172.30.0.25 gitlab-server" | sudo tee -a /etc/hosts
```

After editing registries.yaml, restart K3s:
```bash
sudo systemctl restart k3s
```

### Traefik Ingress (K3s default)

K3s bundles Traefik as the default ingress controller. All Ingress resources use `ingressClassName: traefik`. Each environment has unique hostnames to prevent routing conflicts:

- `dev.hope.local` / `api-dev.hope.local`
- `test.hope.local` / `api-test.hope.local`
- `prod.hope.local` / `api-prod.hope.local`

Update these hostnames in the Ingress manifests when configuring Cloudflare DNS with your actual domain.

### Rancher Namespace Visibility

After deploying a new environment, the namespace appears in Rancher automatically. To organize them, go to **Rancher UI → Cluster → Projects/Namespaces** and move the `hope-dev`, `hope-test`, `hope-prod` namespaces into a shared Rancher project.

---

## Rancher Agent Troubleshooting

### Check Rancher Agent Logs

> 📍 **Run on: VM 200** via SSH

```bash
# List agent pods
kubectl get pods -n cattle-system

# Check logs for a specific agent pod
kubectl logs <pod-name> -n cattle-system
```

### Re-import Cluster into Rancher

> 📍 **Run on: VM 200** via SSH

If the Rancher agent fails to connect (e.g., TLS or hostname issues), re-import using the internal IP:

```bash
# Download the import manifest
curl --insecure -sfL http://10.10.1.100/v3/import/<RANCHER_TOKEN>.yaml > /tmp/cluster.yaml

# Patch the manifest to use the internal Rancher IP instead of the public hostname
sed -i 's|https://rancher.taphuynh.dev|http://10.10.1.100|g' /tmp/cluster.yaml

# Clear the CA checksum (not needed for HTTP)
sed -i 's|CATTLE_CA_CHECKSUM:.*|CATTLE_CA_CHECKSUM: ""|g' /tmp/cluster.yaml

# Apply the patched manifest
kubectl apply -f /tmp/cluster.yaml
```

### Clean Up Rancher Agent

> 📍 **Run on: VM 200** via SSH — ⚠️ **DESTRUCTIVE: removes Rancher agent from the cluster**

```bash
kubectl delete namespace cattle-system
kubectl delete namespace fleet-system 2>/dev/null
```