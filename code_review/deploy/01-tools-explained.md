# 01 — Tools Explained (Plain Language)

This document explains every tool used in the HOPE deployment, written for
someone who is not a DevOps expert.

---

## The Big Picture

Think of it like this:

```
Your App Code  →  Docker Image  →  Kubernetes Cluster  →  Running Services
(project-hope)   (build step)    (k3s + Karpenter)      (ArgoCD deploys)
                                                          (Vault stores secrets)
```

---

## 1. Docker — "Package your app into a box"

**What it is**: Docker lets you package an application and all its dependencies
into a single file called an **image**. When you run that image, it creates a
**container** — a lightweight, isolated process.

**Why HOPE uses it**: Each of the 11 services (api, stt, smr, etc.) is packaged
as its own Docker image. This ensures the app runs exactly the same way on any
machine.

**Key concepts**:
- **Dockerfile**: The recipe for building an image (found in each `apps/*` folder)
- **Image**: The built package (stored in `registry.taphuynh.dev`)
- **Container**: A running instance of an image
- **Registry**: A place to store and share images (like GitHub but for Docker images)

---

## 2. Kubernetes — "Manage many containers automatically"

**What it is**: Kubernetes (often called "k8s") is a system that runs and manages
containers across one or more servers. It handles:
- Starting/stopping containers
- Restarting them if they crash
- Balancing traffic between them
- Giving them configuration and secrets

**Why HOPE uses it**: Instead of manually running 11 `docker run` commands on a
server, Kubernetes does it automatically and keeps everything healthy.

**Key concepts**:
- **Cluster**: A group of servers (nodes) that Kubernetes manages
- **Node**: A single server in the cluster
- **Pod**: The smallest unit — usually one container running inside Kubernetes
- **Deployment**: Tells Kubernetes "run X copies of this container"
- **Service**: A stable network address to reach a Deployment (like a DNS name)
- **Namespace**: A logical partition — HOPE uses `hope-v2-dev`, `hope-v2-staging`, `hope-v2-prod`
- **ConfigMap**: Non-secret configuration stored in the cluster (env variables)
- **Secret**: Sensitive configuration (passwords, API keys) stored in the cluster

**Manifest file**: A YAML file that describes what Kubernetes should create.
Example: `api.yaml` says "create a Deployment named `hope-api` with 1 replica
using this image, expose port 8868, give it these env variables".

---

## 3. k3s — "A lightweight Kubernetes for self-hosted servers"

**What it is**: k3s is a simplified version of Kubernetes made by Rancher. It
runs on a single server or small cluster without needing expensive cloud hardware.

**Why HOPE uses it**: The production cluster runs on a self-hosted server (`dell`)
with k3s instead of a cloud provider like AWS or GCP. This is cheaper and gives
full control.

**What you need to know**: k3s behaves exactly like full Kubernetes. All
`kubectl` commands work the same way. The only difference is how it's installed
on the server.

---

## 4. Karpenter — "Automatically add/remove servers based on workload"

**What it is**: Karpenter is a node provisioner for Kubernetes. When Kubernetes
needs more server capacity (because you're deploying more containers), Karpenter
automatically provisions new nodes (VMs) from a cloud provider.

**Why HOPE's DevOps team used it**: They were trying to set up auto-scaling — if
the cluster runs out of CPU/memory, Karpenter would add new nodes automatically.

**Important note for HOPE**: The current `arca-deployment-template` manifests
are written for a **single-node k3s cluster** (`dell`). Karpenter is a cloud
auto-scaler (AWS/GCP/Azure). The manifest files do not currently have Karpenter
configuration. This may be why the DevOps team hit errors — Karpenter expects
different node selectors and cloud-specific annotations that aren't in the manifests.

> ⚠️ **Action needed**: Clarify with the DevOps team whether the target cluster
> is single-node k3s (current setup) or a cloud-managed Kubernetes with Karpenter.
> The manifests may need changes for a cloud environment.

---

## 5. Kustomize — "Customize Kubernetes manifests without copy-pasting"

**What it is**: Kustomize is a tool to manage Kubernetes YAML files. Instead of
having three separate copies of all manifests (for dev, staging, prod), you have:
- A `base/` folder with the common configuration
- `overlays/dev`, `overlays/staging`, `overlays/prod` folders with only the differences

**Why HOPE uses it**: The dev environment has smaller resource limits and debug
settings. Staging/prod have larger limits, real image digests pinned by CI. Kustomize
merges base + overlay to produce the final YAML.

**How to use it**:
```bash
# Preview what the dev environment will deploy
kustomize build arca-deployment-template/deployment/k8s/overlays/dev

# Apply it (Argo normally does this, but you can do it manually)
kubectl apply -k arca-deployment-template/deployment/k8s/overlays/dev
```

**Install Kustomize**:
```bash
brew install kustomize   # macOS
```

---

## 6. ArgoCD — "Automatically deploy from Git"

**What it is**: ArgoCD watches a Git repository. When a file changes in Git
(e.g., a new image tag is pushed), ArgoCD automatically applies the changes
to the Kubernetes cluster.

**Why HOPE uses it**: Instead of manually running `kubectl apply` after every
code change, the CI pipeline pushes a commit to `arca-deployment-template`,
and ArgoCD picks it up and deploys automatically.

**How the flow works**:
```
Developer pushes code to project-hope
  → GitLab CI builds Docker image
  → CI pushes image to registry.taphuynh.dev
  → CI updates image digest in arca-deployment-template
  → ArgoCD detects the change
  → ArgoCD runs kustomize build + kubectl apply on the cluster
```

**Key ArgoCD terms**:
- **Application**: An ArgoCD object that links a Git repo path to a namespace
- **AppProject**: Access control — which repos/namespaces an Application can use
- **Sync**: ArgoCD applying Git state to the cluster
- **Self-heal**: ArgoCD reverting any manual `kubectl` changes to match Git
- **Prune**: ArgoCD deleting cluster resources that were removed from Git

**How to check status** (if you have cluster access):
```bash
# Install ArgoCD CLI
brew install argocd

# Check application status
argocd app get hope-v2-dev

# Trigger a manual sync
argocd app sync hope-v2-dev
```

---

## 7. HashiCorp Vault — "A secure safe for secrets"

**What it is**: Vault is a tool for storing and managing sensitive information
(passwords, API keys, database credentials, encryption keys). Instead of putting
secrets in config files or environment variables directly, services ask Vault
for them at runtime.

**Why HOPE uses it**: The platform handles PHI (Protected Health Information).
Secrets must not be stored in Git or plain Kubernetes Secrets. Vault provides:
- **Encrypted storage** of all secrets
- **AppRole authentication** — services prove their identity to get secrets
- **Transit encryption** — encrypts PHI fields in the database using a key that never leaves Vault
- **Audit logging** — every secret access is logged

**How `hope-api` uses Vault**:
1. At startup, `hope-api` reads `VAULT_ROLE_ID` and `VAULT_SECRET_ID` from the Kubernetes Secret
2. It authenticates to Vault using those credentials (AppRole auth)
3. Vault returns a token
4. `hope-api` uses that token to read secrets like `JWT_SECRET_KEY`, `MINIO_*`, etc.
5. If Vault is unreachable, `hope-api` **will not start**

**Important**: Only `hope-api` reads from Vault. All other services read their
secrets from a Kubernetes Secret called `hope-secrets`.

---

## 8. MinIO — "Self-hosted Amazon S3"

**What it is**: MinIO is an open-source object storage server — it works exactly
like Amazon S3 but runs on your own hardware.

**Why HOPE uses it**: Audio recordings, generated audio, documents, and backups
are stored in MinIO. Services like STT (speech-to-text) upload audio chunks to
MinIO for the worker to process.

**Key detail**: MinIO buckets are **not created automatically** by deployment.
You must create them manually before the services start:
- `hope-audio`
- `hope-audio-chunks`
- `hope-loki-logs` (for Loki log storage)
- `hope-tempo-traces` (for Tempo trace storage)
- `mlflow`, `recordings`, `generated-audio`, `documents`, `backups`

---

## 9. Temporal — "Manage long-running workflows"

**What it is**: Temporal is a workflow orchestration platform. It lets you write
code that needs to run for a long time (hours, days) reliably — if it crashes,
it automatically picks up where it left off.

**Why HOPE uses it**: The clinical documentation harness (`hope-harness`) uses
Temporal to manage multi-step clinical documentation workflows that may take
several minutes.

**Important**: HOPE runs Temporal **outside the cluster** on the VM directly
at `10.10.1.10:7233`. The in-cluster `temporal.yaml` deployment exists but the
harness service is NOT connected to it — it points to the external VM address.

---

## 10. The Full Tool Stack at a Glance

```
┌─────────────────────────────────────────────────────────────────┐
│                         HOPE Platform                          │
├────────────────────────┬────────────────────────────────────────┤
│   Source Code          │   project-hope/                        │
│   (monorepo)           │   11 apps + 27 packages               │
├────────────────────────┼────────────────────────────────────────┤
│   Build                │   Docker (each app has a Dockerfile)   │
│                        │   GitLab CI builds + pushes images     │
├────────────────────────┼────────────────────────────────────────┤
│   Image Registry       │   registry.taphuynh.dev/arca/hope-v2/ │
├────────────────────────┼────────────────────────────────────────┤
│   Deployment Config    │   arca-deployment-template/            │
│                        │   Kustomize base + overlays            │
├────────────────────────┼────────────────────────────────────────┤
│   GitOps Sync          │   ArgoCD (watches Git, applies YAML)   │
├────────────────────────┼────────────────────────────────────────┤
│   Cluster              │   k3s on bare-metal server "dell"      │
│                        │   (or cloud k8s if Karpenter is used)  │
├────────────────────────┼────────────────────────────────────────┤
│   Secrets              │   HashiCorp Vault (API gateway only)   │
│                        │   Kubernetes Secret (all other svcs)   │
├────────────────────────┼────────────────────────────────────────┤
│   Backing Services     │   PostgreSQL, Redis, MinIO, Qdrant     │
│                        │   Temporal, LM Studio (LLM backend)    │
└────────────────────────┴────────────────────────────────────────┘
```
