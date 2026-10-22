# Incident Resolution: Vault AppRole Secret ID Expiration & Fix

## 1. Incident Overview
- **Symptom**: User login failed with HTTP `401 Unauthorized` (`{"message":"Authentication system not configured"}`) on `POST /api/auth/login`.
- **Root Cause**: `hope-api-gateway` pod restarted after ~41 hours of uptime. On startup, it failed to authenticate to HashiCorp Vault with the error:
  ```text
  Error: VaultSecretsProvider.boot() FATAL: cannot authenticate to Vault 
  (http://vault-store-svc.project-hope-vox-infra.svc.cluster.local:8200) — invalid role or secret ID
  ```
  Because authentication failed, the gateway could not load `JWT_SECRET_KEY` and `SESSION_SECRET_KEY` into memory, causing all login authentication checks to fail closed.

---

## 2. Key Architecture Concept: Secret ID vs KV Store

| Concept | Location | Purpose |
|---|---|---|
| **`role_id` & `secret_id`** | Vault Auth Engine (`auth/approle`) | Acts like the username and password used by the API Gateway to log in to Vault. |
| **`JWT_SECRET_KEY` / `SESSION_SECRET_KEY`** | Vault KV Store (`secret/data/hope/...`) | The application secrets retrieved by the Gateway *after* successful authentication. |

The failure was not missing KV secrets—the KV store had all keys intact. The failure was that Vault's AppRole `secret_id` had expired or exceeded its usage limit.

---

## 3. Step-by-Step Fix Executed

### Step 1: Exec into the Vault Pod
```bash
kubectl exec -it vault-store-7877b7d766-tfb5x -n project-hope-vox-infra -- sh
export VAULT_ADDR="http://127.0.0.1:8200"
```

### Step 2: Configure the AppRole to Prevent Future Expiration
Configured the `hope-app` role so that newly generated secret IDs never expire and have infinite uses:
```sh
vault write auth/approle/role/hope-app \
  secret_id_ttl=0 \
  secret_id_num_uses=0 \
  token_ttl=24h \
  token_max_ttl=0
```
- `secret_id_ttl=0`: Secret ID never expires.
- `secret_id_num_uses=0`: Unlimited uses (pod can restart any number of times).
- `token_ttl=24h` & `token_max_ttl=0`: Client tokens issued to the gateway remain renewable indefinitely.

### Step 3: Generate the Fresh Permanent Secret ID
```sh
vault write -f auth/approle/role/hope-app/secret-id
```
Output:
```text
Key                   Value
---                   -----
secret_id             <NEW_SECRET_ID_UUID>
secret_id_accessor    <ACCESSOR_UUID>
secret_id_num_uses    0
secret_id_ttl         0s
```

### Step 4: Update the API Gateway Deployment
From `master-node-1`:
```bash
kubectl set env deployment/hope-api-gateway -n project-hope-vox VAULT_SECRET_ID="<NEW_SECRET_ID_UUID>"
```

### Step 5: Verify Rollout and Gateway Boot
```bash
kubectl rollout status deployment/hope-api-gateway -n project-hope-vox
kubectl logs -l app=hope-api-gateway -n project-hope-vox --tail=50
```
- Gateway successfully logs in to Vault, fetches `JWT_SECRET_KEY` and `SESSION_SECRET_KEY`, and login endpoint returns HTTP 200.

---

## 4. Behavior During Future Restarts

| Scenario | What Happens | Action Required |
|---|---|---|
| **API Gateway Pod restarts** | Reuses the configured `VAULT_SECRET_ID`. Because `secret_id_ttl=0` and `secret_id_num_uses=0`, authentication succeeds automatically. | **None** |
| **Cluster Node / Vault Pod restarts** | The secret ID remains safely stored in Vault's persistent storage. However, Vault boots in a **Sealed** state (`Sealed: true`). | Run `vault operator unseal` with 3 Shamir keys. Once unsealed, the gateway reconnects immediately. |
