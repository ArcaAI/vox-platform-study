# 07 — Known Deployment Errors & Fixes

Every error in this document was observed during the first real deployment
on 2026-08-09. Error text is exact — use Ctrl+F to find your error.

---

## ERROR: CreateContainerConfigError on hope-harness-worker

**Symptom:**
```
Error: couldn't find key HARNESS_INTERNAL_SERVICE_TOKEN in Secret hope-v2-dev/hope-secrets
```

**What it means:** The `hope-harness-worker` deployment requires
`HARNESS_INTERNAL_SERVICE_TOKEN` as a mandatory environment variable.
This key was missing from the `hope-secrets` Kubernetes Secret.

**Fix:**
1. Add the key to your `secrets.dev.yaml`:
   ```yaml
   HARNESS_INTERNAL_SERVICE_TOKEN: "your-token-here"  # Generate: openssl rand -hex 32
   ```
2. Re-apply the Secret:
   ```bash
   kubectl apply --server-side -n hope-v2-dev \
     -f arca-deployment-template/deployment/secrets.dev.yaml
   kubectl -n hope-v2-dev rollout restart deployment/hope-harness-worker
   ```

---

## ERROR: hope-api will not start — Vault unreachable or sealed

**Symptom:**
```
[Vault] Failed to authenticate: connection refused
[Vault] Vault is sealed. Cannot load secrets.
Error: VAULT_ROLE_ID or VAULT_SECRET_ID not configured
```

**What it means:** `hope-api` performs an AppRole login to Vault at startup.
If Vault is down, sealed, or the credentials are wrong, `hope-api` refuses to boot.

**Fix (production cluster):**
```bash
# 1. Check Vault status
kubectl -n hope-v2-dev exec hope-vault-0 -- vault status
# Look for: sealed: false

# 2. If sealed, unseal it (needs 3 of 5 unseal keys)
kubectl -n hope-v2-dev exec hope-vault-0 -- vault operator unseal <key1>
kubectl -n hope-v2-dev exec hope-vault-0 -- vault operator unseal <key2>
kubectl -n hope-v2-dev exec hope-vault-0 -- vault operator unseal <key3>

# 3. Restart hope-api after Vault is unsealed
kubectl -n hope-v2-dev rollout restart deployment/hope-api
```

**Fix (local testing):**
Add `SECRETS_PROVIDER=env` to your docker run command to bypass Vault:
```bash
docker run -e SECRETS_PROVIDER=env ... hope-v2/api:local
```

---

## ERROR: Job spec.template is immutable

**Symptom:**
```
Job.batch "hope-db-migrate" is invalid: spec.template: field is immutable
```

**What it means:** Kubernetes Jobs are immutable after creation. ArgoCD tries
to PATCH the existing Job on every sync, and the API server rejects it.

**Fix (dev environment — already handled):**
The dev overlay in `arca-deployment-template` already adds `Replace=true` to
the db-migrate Job. This tells ArgoCD to delete and recreate instead of patching.

If you're applying manually and hit this:
```bash
# Delete the old Job first
kubectl -n hope-v2-dev delete job hope-db-migrate

# Then re-apply
kubectl apply -k deployment/k8s/overlays/dev
```

---

## ERROR: Database migration P3005 — schema is not empty

**Symptom:**
```
Error: P3005
The database schema is not empty. Read more about how to baseline an existing
production database at https://pris.ly/d/migrate-baseline
```

**What it means:** The database has tables but no Prisma migration history.
This happens when the database was set up using `db push` instead of `migrate deploy`.

**Fix:**

> ⚠️ **Warning**: This procedure modifies the database. Back up first.

```bash
# 1. Back up the database
pg_dump --format=custom --no-owner --no-privileges \
  --file=/backup/hope-prebaseline-$(date +%Y%m%d%H%M).dump \
  "$DATABASE_URL"

# 2. Open a shell into the db-migrate pod or use local Prisma
cd project-hope

# 3. Check what migrations exist
DATABASE_URL="$DATABASE_URL" pnpm --filter @arcaai/database exec \
  prisma migrate status

# 4. Mark older migrations as already applied (they are in the DB from db push)
# This is manual — you need to identify which migrations are already in the schema
DATABASE_URL="$DATABASE_URL" pnpm --filter @arcaai/database exec \
  prisma migrate resolve --applied "20260601000000_migration_name"

# Repeat for each migration already reflected in the DB schema

# 5. Apply remaining pending migrations
DATABASE_URL="$DATABASE_URL" pnpm --filter @arcaai/database exec \
  prisma migrate deploy
```

---

## ERROR: Rollout stuck — "Deployment does not have minimum availability"

**Symptom:**
ArgoCD shows deployment in "Progressing" state for more than 5 minutes.
```
Deployment does not have minimum availability.
```

**Cause 1: Single-node cluster with maxSurge: 1 (out of CPU/memory)**

The dev node (`dell`) runs near-full capacity. `maxSurge: 1` tries to start a
new pod alongside the old one — there's no room.

**Fix:**
The dev overlay already patches heavy services to `maxSurge: 0`. If you added
a new service without this patch, add it in
`arca-deployment-template/deployment/k8s/overlays/dev/kustomization.yaml`:

```yaml
- patch: |
    apiVersion: apps/v1
    kind: Deployment
    metadata:
      name: hope-YOUR-SERVICE
    spec:
      strategy:
        type: RollingUpdate
        rollingUpdate:
          maxSurge: 0
          maxUnavailable: 1
  target:
    kind: Deployment
    name: hope-YOUR-SERVICE
```

**Cause 2: SMR readiness depends on LM Studio**

SMR's readiness probe returns 503 until an LLM provider is reachable.

**Fix:**
1. Start LM Studio on the host machine
2. Enable "Serve on Local Network" in LM Studio settings
3. Load a model (e.g., `gemma-4-e2b-it-qat`)
4. Verify from inside the cluster:
   ```bash
   kubectl -n hope-v2-dev exec deploy/hope-api -- \
     curl -s -m 4 http://10.10.1.10:1234/
   # Should return 200
   ```

---

## ERROR: ErrImagePull / 403 Forbidden on image pull

**Symptom:**
```
failed to fetch anonymous token: ... 403 Forbidden
Failed to pull image "registry.taphuynh.dev/arca/hope-v2/api:..."
```

**What it means:** The pod cannot pull the image because it doesn't have
the registry credentials. This is NOT a bad image tag — it's a missing pull secret.

**Fix:**
```bash
# Create the image pull secret (if not already done)
kubectl -n hope-v2-dev create secret docker-registry hope-registry-creds \
  --docker-server=registry.taphuynh.dev \
  --docker-username=<username> \
  --docker-password=<password>

# Verify
kubectl -n hope-v2-dev get secret hope-registry-creds
```

If the secret exists but pods still fail, check that the Deployment manifest
references it:
```yaml
spec:
  template:
    spec:
      imagePullSecrets:
        - name: hope-registry-creds
```

---

## ERROR: ImagePullBackOff on bitnami/* images

**Symptom:**
```
ImagePullBackOff
Failed to pull image "bitnami/kubectl:1.31"
```

**What it means:** Bitnami withdrew their public Docker Hub catalogue.
Images like `bitnami/kubectl:1.31` now 404 on Docker Hub.

**Fix:**
The deployment repo already fixed this — `hope-vault-init` now uses
`alpine/kubectl:1.34.1`. But the OLD job may still be running in the cluster:

```bash
# Delete the stale job — ArgoCD will recreate it with the fixed image
kubectl -n hope-v2-dev delete job hope-vault-init
```

If you see other `bitnami/*` images anywhere in your manifests, replace them.

---

## ERROR: ArgoCD "Access denied" / "authentication required"

**Symptom:**
```
failed to list refs: authentication required: HTTP Basic: Access denied
```

**What it means:** The ArgoCD repository credential is **project-scoped** —
it only works for one AppProject. If the Application's `spec.project` was
changed, ArgoCD loses Git access.

**Fix:**
```bash
# Remove the project scope from the repo credential
kubectl -n argocd patch secret repo-820844053 --type=json \
  -p='[{"op":"remove","path":"/data/project"}]'

# Verify Git is accessible
argocd repo list
# STATUS column should show "Successful"
```

---

## ERROR: Loki crash — NoSuchBucket

**Symptom:**
```
init compactor: failed to init delete store: NoSuchBucket
```

**What it means:** Loki tries to use MinIO bucket `hope-loki-logs` which
doesn't exist.

**Fix:**
```bash
# Create the missing bucket using mc (MinIO CLI)
brew install minio/stable/mc

mc alias set myminio http://minio.yourdomain.com:9000 access_key secret_key

mc mb myminio/hope-loki-logs
mc mb myminio/hope-tempo-traces

# Then restart Loki and Tempo
kubectl -n hope-v2-dev rollout restart deployment/loki
kubectl -n hope-v2-dev rollout restart deployment/tempo
```

---

## ERROR: Qdrant crash-loop — missing S3 config field

**Symptom:**
```
missing configuration field "storage.snapshots_config.s3_config.bucket"
```

**What it means:** Qdrant sees partial S3 snapshot config — some keys are
set but not all four required ones. Setting any one of the
`QDRANT_SNAPSHOTS_S3_*` keys without the others causes Qdrant to reject
its config and crash.

**Fix:**
Either set ALL four or NONE:
```yaml
# In secrets.dev.yaml — either comment all four out:
# QDRANT_SNAPSHOTS_S3_BUCKET: ""
# QDRANT_SNAPSHOTS_S3_ACCESS_KEY: ""
# QDRANT_SNAPSHOTS_S3_SECRET_KEY: ""
# QDRANT_SNAPSHOTS_S3_ENDPOINT_URL: ""

# OR set all four with real values
```

---

## ERROR: Grafana / Prometheus stuck in "Error opening storage"

**Symptom:**
```
opening storage failed: lock DB directory: resource temporarily unavailable
```

**What it means:** These services have single-writer data stores (Prometheus
TSDB, Loki chunks). With `maxSurge: 1`, the new pod starts while the old one
still holds the file lock.

**Fix:**
These services must use `strategy: Recreate` (not `RollingUpdate`):
```yaml
# In the base manifest (api.yaml, prometheus.yaml, etc.)
spec:
  strategy:
    type: Recreate
```
The manifests already have this fix. If you see it on a new service you added,
check its deployment strategy.

---

## ERROR: Sync blocked — "One invalid task fails the whole sync"

**Symptom:**
ArgoCD sync button does nothing. Everything shows OutOfSync but no changes land.

**Diagnose:**
```bash
# Check what the sync operation says
kubectl -n argocd get application hope-v2-dev \
  -o jsonpath='{.status.operationState.phase}{"\n"}{.status.operationState.message}{"\n"}'

# Check the controller logs
kubectl -n argocd logs argocd-application-controller-0 --tail=200 | \
  grep -i 'failed to apply\|SyncFailed'
```

**Common causes:**
- PVC size was reduced (can't shrink PVCs)
- A new resource Kind not in the AppProject whitelist
- The `hope-vault-init` hook Job is stuck (see `bitnami` error above)

**Fix the PVC shrink error:**
```bash
# Check the PVC
kubectl -n hope-v2-dev get pvc

# If you accidentally reduced PVC size in the manifest, revert it in Git
# You cannot reduce PVC size in Kubernetes — only increase
```

---

## ERROR: `promote-dev` CI job fails — DEPLOY_TOKEN missing

**Symptom (in GitLab CI):**
```
promote.sh: line 43: DEPLOY_TOKEN: DEPLOY_TOKEN is required
```

**What it means:** The CI variable `DEPLOY_TOKEN` is not reaching the job.
Usually because it was created as a "Protected" variable but the branch is not protected.

**Fix:**
1. Go to GitLab → `arca/hope-v2` → Settings → CI/CD → Variables
2. Find `DEPLOY_TOKEN`
3. Uncheck "Protected" (or add `dev-2.1` as a protected branch)

---

## Karpenter-Specific Errors (if using cloud Kubernetes)

If the DevOps team deployed to a cloud cluster (AWS EKS, GCP GKE) with Karpenter:

**Symptom:** Pods stay in `Pending` state with:
```
0/0 nodes are available: pod has unbound immediate PersistentVolumeClaims
```
or
```
no nodes available to schedule pods
```

**Root cause:** The current manifests were written for a **single-node k3s cluster**
on bare metal. They do not include:
- Karpenter `NodePool` / `EC2NodeClass` resources
- Cloud-specific storage classes for PVCs
- Node selectors for cloud instance types

**Fix:** The manifest files need to be adapted for the cloud environment.
The key changes required are:

1. **Storage Classes**: Replace `hostPath` PVCs with cloud storage class:
   ```yaml
   storageClassName: gp3  # AWS EBS
   # or
   storageClassName: standard  # GKE
   ```

2. **GPU nodes**: For STT service, Karpenter needs a NodePool that provisions
   GPU instances:
   ```yaml
   apiVersion: karpenter.sh/v1
   kind: NodePool
   metadata:
     name: gpu-pool
   spec:
     template:
       spec:
         requirements:
           - key: karpenter.k8s.aws/instance-gpu-name
             operator: In
             values: ["T4", "A10G"]
   ```

3. **Registry credentials**: Cloud clusters use IAM roles / Workload Identity
   instead of static docker credentials in many cases.

> Recommend: Ask the DevOps team specifically what cloud provider and cluster
> setup they used, and share the exact error messages from the pod describe output.

---

## General Triage Commands

Use these to quickly find what's wrong:

```bash
# 1. Are pods running?
kubectl -n hope-v2-dev get pods

# 2. What's wrong with a specific pod?
kubectl -n hope-v2-dev describe pod <pod-name>

# 3. What do the logs say?
kubectl -n hope-v2-dev logs deployment/hope-api --tail=50
kubectl -n hope-v2-dev logs deployment/hope-smr --tail=50

# 4. Recent cluster events (best first look)
kubectl -n hope-v2-dev get events \
  --sort-by='.lastTimestamp' | tail -30

# 5. Is ArgoCD syncing?
kubectl -n argocd get application hope-v2-dev \
  -o jsonpath='{.status.sync.status} {.status.health.status}'

# 6. Node capacity (is the node full?)
kubectl describe node | grep -A6 'Allocated resources'
```
