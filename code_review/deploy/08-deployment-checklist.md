# 08 — Pre-Deployment Checklist

Complete this checklist **before** triggering any deployment (ArgoCD sync,
`kubectl apply`, or CI pipeline run). Every item has caused a failed deployment.

---

## PHASE 0 — Laptop / Local Validation (before touching the cluster)

- [ ] **Images build from source**
  ```bash
  cd project-hope
  docker build --file apps/api/Dockerfile --tag hope-v2/api:local \
    --build-arg DATABASE_URL="postgresql://..." .
  # Repeat for each service — see 03-build-images-from-source.md
  ```

- [ ] **Manifests render without errors**
  ```bash
  cd arca-deployment-template
  kustomize build deployment/k8s/overlays/dev > /dev/null && echo "OK"
  ```

- [ ] **Manifests pass schema validation**
  ```bash
  kustomize build deployment/k8s/overlays/dev | \
    kubeconform -strict -ignore-missing-schemas -summary
  # Expected: 0 invalid, 0 errors
  ```

- [ ] **No :latest image tags in dev overlay**
  ```bash
  kustomize build deployment/k8s/overlays/dev | grep "image:" | grep ":latest"
  # Should return nothing
  ```

- [ ] **ConfigMap key references are valid**
  ```bash
  kustomize build deployment/k8s/overlays/dev | \
    python3 scripts/check-config-refs.py /dev/stdin
  ```

---

## PHASE 1 — External Infrastructure (out-of-cluster)

- [ ] **PostgreSQL is running and reachable**
  ```bash
  psql "postgresql://user:pass@host:5432/dbname" -c "SELECT 1;"
  # Expected: 1 row
  ```

- [ ] **Redis is running and reachable**
  ```bash
  redis-cli -h <host> -p 6379 -a <password> ping
  # Expected: PONG
  ```

- [ ] **MinIO is running and reachable**
  ```bash
  mc alias set myminio http://minio.host:9000 access_key secret_key
  mc ls myminio
  ```

- [ ] **MinIO buckets exist** (create them if not)
  ```bash
  for bucket in hope-audio hope-audio-chunks hope-loki-logs hope-tempo-traces \
                mlflow recordings generated-audio documents backups; do
    mc mb --ignore-existing myminio/${bucket} && echo "${bucket}: OK"
  done
  ```

- [ ] **LM Studio is running on the host machine**
  - Application is open and a model is loaded (e.g., `gemma-4-e2b-it-qat`)
  - "Serve on Local Network" is enabled in LM Studio settings
  - Reachable at http://10.10.1.10:1234 (or your host IP)

- [ ] **Temporal is running** (at `10.10.1.10:7233` or your external address)
  ```bash
  curl -s http://10.10.1.10:7233 || echo "Check Temporal"
  ```

---

## PHASE 2 — Kubernetes Cluster Readiness

- [ ] **Namespace exists**
  ```bash
  kubectl get namespace hope-v2-dev
  # If not: kubectl create namespace hope-v2-dev
  ```

- [ ] **Image pull secret exists**
  ```bash
  kubectl -n hope-v2-dev get secret hope-registry-creds
  ```
  If missing:
  ```bash
  kubectl -n hope-v2-dev create secret docker-registry hope-registry-creds \
    --docker-server=registry.taphuynh.dev \
    --docker-username=<username> \
    --docker-password=<password>
  ```

- [ ] **`hope-secrets` exists with ALL required keys**
  ```bash
  kubectl -n hope-v2-dev get secret hope-secrets
  kubectl -n hope-v2-dev get secret hope-secrets -o json | jq '.data | keys | length'
  # Should be at least 31 keys
  ```

  Required keys checklist (verify each is non-empty):
  ```bash
  for key in DATABASE_URL STT_V2_DATABASE_URL TEMPORAL_DB_HOST TEMPORAL_DB_USER \
    TEMPORAL_DB_PASSWORD REDIS_HOST REDIS_PORT REDIS_PASS SESSION_SECRET_KEY \
    API_GATEWAY_KEY MINIO_ENDPOINT MINIO_ACCESS_KEY MINIO_SECRET_KEY \
    AZURE_OPENAI_API_KEY AZURE_OPENAI_ENDPOINT AZURE_OPENAI_DEPLOYMENT_NAME \
    AZURE_SPEECH_KEY VAULT_ROLE_ID VAULT_SECRET_ID JWT_SECRET_KEY ADMIN_SESSION_SECRET \
    HARNESS_SERVICE_TOKEN HARNESS_INTERNAL_SERVICE_TOKEN SMR_SERVICE_TOKEN \
    SMR_V2_SERVICE_TOKEN GUARDRAIL_SERVICE_TOKEN HUGGINGFACE_TOKEN HF_TOKEN \
    GRAFANA_ADMIN_PASSWORD SARVAM_API_KEY TTS_SARVAM_API_KEY; do
    val=$(kubectl -n hope-v2-dev get secret hope-secrets \
      -o jsonpath="{.data.${key}}" 2>/dev/null)
    [ -n "$val" ] && echo "✅ ${key}" || echo "❌ ${key} — MISSING or EMPTY"
  done
  ```

  > **⚠️ Critical**: `HARNESS_INTERNAL_SERVICE_TOKEN` must NOT be empty.
  > It causes `CreateContainerConfigError` on `hope-harness-worker`.

- [ ] **Vault is unsealed** (if using in-cluster Vault)
  ```bash
  kubectl -n hope-v2-dev exec hope-vault-0 -- vault status 2>/dev/null | grep -i sealed
  # Expected: Sealed: false
  ```

- [ ] **GPU time-slicing is activated** (required for STT service)
  ```bash
  kubectl get node -o jsonpath='{.items[0].status.allocatable.nvidia\.com/gpu}'
  # Expected: 6 (if 2 physical GPUs × 3 slices)
  # If shows 2 (unsliced): apply gpu-time-slicing.yaml (see below)
  ```
  If not activated:
  ```bash
  kubectl apply -f arca-deployment-template/deployment/k8s/base/gpu-time-slicing.yaml
  kubectl patch clusterpolicies.nvidia.com/cluster-policy -n gpu-operator \
    --type merge \
    -p '{"spec":{"devicePlugin":{"config":{"name":"time-slicing-config","default":"any"}}}}'
  ```

---

## PHASE 3 — ArgoCD Configuration

- [ ] **ArgoCD Application exists and is pointed at the right repo + path**
  ```bash
  argocd app get hope-v2-dev
  # Look for: Path: deployment/k8s/overlays/dev
  ```

- [ ] **ArgoCD repo credential is accessible**
  ```bash
  argocd repo list
  # STATUS column should show "Successful" for registry.taphuynh.dev
  ```

- [ ] **AppProject allows the required resource types**
  ```bash
  argocd proj get hope-v2-dev
  # Should list: Deployment, Service, Job, StatefulSet, ConfigMap, etc.
  ```

- [ ] **ArgoCD Application project-scoped credential is not broken**
  ```bash
  argocd app get hope-v2-dev --refresh 2>&1 | grep -i error
  # Should return nothing
  ```

- [ ] **LM Studio Service/Endpoints are applied out-of-band**
  ```bash
  kubectl -n hope-v2-dev get service hope-lmstudio
  kubectl -n hope-v2-dev get endpoints hope-lmstudio
  ```
  If missing:
  ```bash
  kubectl apply -n hope-v2-dev \
    -f arca-deployment-template/deployment/k8s/out-of-band/lmstudio-endpoints.yaml
  ```

---

## PHASE 4 — GitLab CI (if using the CI pipeline)

- [ ] **`DEPLOY_TOKEN` CI variable exists and is NOT marked Protected**
  - GitLab → `arca/hope-v2` → Settings → CI/CD → Variables
  - Find `DEPLOY_TOKEN`, uncheck Protected if set

- [ ] **`DEPLOY_TOKEN` has `write_repository` access to `arca/hope-v2-deployment`**

- [ ] **Dev branch (`dev-2.1`) has CI enabled**

---

## PHASE 5 — Deploy & Verify

- [ ] **Trigger the sync**
  ```bash
  # Via ArgoCD CLI
  argocd app sync hope-v2-dev

  # Or via kubectl (manual apply)
  kubectl apply -k arca-deployment-template/deployment/k8s/overlays/dev -n hope-v2-dev
  ```

- [ ] **Watch the rollout**
  ```bash
  # Watch all pods come up
  watch -n 5 kubectl -n hope-v2-dev get pods

  # Watch events for errors
  kubectl -n hope-v2-dev get events --sort-by='.lastTimestamp' -w
  ```

- [ ] **Infrastructure services are healthy first** (before app services)
  ```bash
  kubectl -n hope-v2-dev get pods | grep -E "vault|qdrant|temporal"
  # All should show Running
  ```

- [ ] **Database migration completed**
  ```bash
  kubectl -n hope-v2-dev get job hope-db-migrate
  # COMPLETIONS should show 1/1
  ```

- [ ] **All application services are Running and Ready**
  ```bash
  kubectl -n hope-v2-dev get deployment
  # All should show READY = 1/1 (or more)
  ```

- [ ] **Health endpoints respond**
  ```bash
  # From outside the cluster (NodePort)
  NODE_IP=$(kubectl get nodes -o jsonpath='{.items[0].status.addresses[0].address}')
  curl http://${NODE_IP}:30088/api/v1/health/ready
  ```

---

## Known Things That Will Be Degraded (not blocking)

These are known issues that do NOT block the deployment from working,
but should be fixed:

| Issue | Impact | Fix |
|-------|--------|-----|
| `GUARDRAIL_SERVICE_TOKEN` is empty | Guardrail runs in dev-bypass mode (no auth check) | OK for dev |
| `GRAFANA_ADMIN_PASSWORD` absent | Grafana uses default `admin/admin` | Set the key |
| GPU time-slicing not on | STT surges during rollout may starve the node | Apply `gpu-time-slicing.yaml` |
| `hope-secrets` cleartext annotation | All 31 secrets readable by anyone with `get secret` | Re-apply with `--server-side` |
| `HARNESS_INTERNAL_SERVICE_TOKEN` inconsistency | harness has it optional, harness-worker requires it | Decide which is correct and align |
| Database schema drift | Usage metering + billing + CORS registry not working | Run baseline migration (see §07) |
| Vault no auto-unseal | Any Vault restart requires manual unseal with 3 keys | Configure Transit auto-unseal |
