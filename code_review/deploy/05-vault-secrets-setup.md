# 05 — Vault Secrets Setup

This document explains:
1. What HashiCorp Vault is and why HOPE uses it
2. Every secret that needs to be configured
3. Step-by-step procedure to set up Vault and load all secrets

---

## Why Vault?

HOPE is a medical AI platform that handles PHI (Protected Health Information).
Storing credentials in plain config files or Kubernetes Secrets risks exposure.
Vault provides:

- **Encrypted storage** — secrets are encrypted at rest
- **AppRole auth** — services authenticate with a role_id + secret_id pair
- **Transit engine** — PHI database fields are encrypted with a key that never leaves Vault
- **Audit log** — every read/write is logged with timestamp and caller identity

**Which services use Vault?**
- **`hope-api`** — the ONLY service that reads from Vault directly
- All other services read from a Kubernetes Secret named `hope-secrets`

---

## Part A — Secrets in Kubernetes `hope-secrets`

These secrets go into a Kubernetes Secret (not Vault). Every service except
`hope-api` reads from this Secret.

### Step 1 — Create the secrets file

Copy the example file from the deployment repository:

```bash
cp arca-deployment-template/deployment/secrets.dev.yaml.example \
   arca-deployment-template/deployment/secrets.dev.yaml
```

### Step 2 — Fill in all values

Open `secrets.dev.yaml` and replace every placeholder. Here is a complete
reference of every key and what it is:

#### Database

| Key | What it is | Example |
|-----|-----------|---------|
| `DATABASE_URL` | PostgreSQL connection string for the API + STT | `postgresql://user:pass@host:5432/dbname` |
| `STT_V2_DATABASE_URL` | PostgreSQL for STT (can be same database, different schema) | `postgresql://user:pass@host:5432/dbname` |
| `TEMPORAL_DB_HOST` | Postgres hostname for Temporal's own database | `postgres.yourdomain.com` |
| `TEMPORAL_DB_USER` | Postgres user for Temporal | `temporal` |
| `TEMPORAL_DB_PASSWORD` | Postgres password for Temporal | `your_password` |

#### Redis

| Key | What it is |
|-----|-----------|
| `REDIS_HOST` | Redis server hostname |
| `REDIS_PORT` | Redis port (usually `6379`) |
| `REDIS_PASS` | Redis password (empty string if no auth) |

#### API Authentication

| Key | What it is | Notes |
|-----|-----------|-------|
| `JWT_SECRET_KEY` | Signs JWT tokens | Must be a long random string — `openssl rand -base64 48` |
| `SESSION_SECRET_KEY` | Signs HTTP sessions | Must be a long random string |
| `API_GATEWAY_KEY` | Inter-service auth header | Any random string |
| `ADMIN_SESSION_SECRET` | Signs admin console sessions | Must be a long random string |

#### MinIO (object storage)

| Key | What it is |
|-----|-----------|
| `MINIO_ENDPOINT` | MinIO host:port (e.g., `minio.yourdomain.com:9000`) |
| `MINIO_ACCESS_KEY` | MinIO access key (username) |
| `MINIO_SECRET_KEY` | MinIO secret key (password) |

#### Azure OpenAI / Speech

| Key | What it is |
|-----|-----------|
| `AZURE_OPENAI_API_KEY` | Azure OpenAI API key |
| `AZURE_OPENAI_ENDPOINT` | Azure OpenAI endpoint URL |
| `AZURE_OPENAI_DEPLOYMENT_NAME` | Model deployment name (e.g., `gpt-4o`) |
| `AZURE_SPEECH_KEY` | Azure Cognitive Services speech key (for TTS) |

#### Vault AppRole (for hope-api to authenticate to Vault)

| Key | What it is | How to get it |
|-----|-----------|--------------|
| `VAULT_ROLE_ID` | The AppRole role ID | From Vault setup (Part B below) |
| `VAULT_SECRET_ID` | The AppRole secret ID | From Vault setup (Part B below) |

#### Inter-service Authentication Tokens

| Key | What it is | Notes |
|-----|-----------|-------|
| `HARNESS_SERVICE_TOKEN` | Token for harness service auth | Generate: `openssl rand -hex 32` |
| `HARNESS_INTERNAL_SERVICE_TOKEN` | Required by harness-worker | **⚠ MUST NOT be empty — harness-worker crashes without it** |
| `SMR_SERVICE_TOKEN` | Token for SMR service auth | Generate: `openssl rand -hex 32` |
| `SMR_V2_SERVICE_TOKEN` | Second SMR token variant | Same as above or leave empty for dev |
| `GUARDRAIL_SERVICE_TOKEN` | Token for guardrail service auth | Empty = dev-bypass mode (OK for dev) |

#### Qdrant (vector database)

| Key | What it is | Notes |
|-----|-----------|-------|
| `QDRANT_API_KEY` | Qdrant API key | Leave empty for unauthenticated local use |
| `QDRANT_READ_ONLY_API_KEY` | Read-only key for Qdrant | Leave empty for local use |

> **Warning**: For Qdrant S3 snapshots — set ALL four `QDRANT_SNAPSHOTS_S3_*`
> keys or set NONE. Setting only some causes Qdrant to crash-loop.

#### HuggingFace

| Key | What it is |
|-----|-----------|
| `HUGGINGFACE_TOKEN` | HuggingFace API token (for downloading models) |
| `HF_TOKEN` | Same token, alternate variable name used by some services |

#### Observability

| Key | What it is |
|-----|-----------|
| `GRAFANA_ADMIN_PASSWORD` | Grafana admin password. If absent, default is `admin` |

#### Provider Keys (optional)

| Key | What it is |
|-----|-----------|
| `SARVAM_API_KEY` | Sarvam AI provider API key |
| `TTS_SARVAM_API_KEY` | Same key, used by TTS service specifically |

### Step 3 — Apply the Secret to the cluster

```bash
# Apply to the dev namespace
kubectl apply -n hope-v2-dev -f arca-deployment-template/deployment/secrets.dev.yaml

# IMPORTANT: Apply with --server-side to avoid leaking secrets in annotations
kubectl apply --server-side -n hope-v2-dev \
  -f arca-deployment-template/deployment/secrets.dev.yaml

# Verify it was created
kubectl -n hope-v2-dev get secret hope-secrets
kubectl -n hope-v2-dev get secret hope-secrets -o json | jq '.data | keys'
# Should show all keys
```

---

## Part B — Setting Up HashiCorp Vault

This section covers setting up Vault so that `hope-api` can authenticate and
read its secrets.

### What Vault stores for hope-api

`hope-api` reads these secrets from Vault at startup:

| Vault Path | Keys stored |
|-----------|------------|
| `secret/hope/auth` | `JWT_SECRET_KEY`, `SESSION_SECRET_KEY`, `API_KEY_PEPPER` |
| `secret/hope/minio` | `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY` |
| `secret/hope/azure` | `AZURE_OPENAI_API_KEY`, `AZURE_SPEECH_KEY`, etc. |
| `secret/hope/transit` | The `hope-phi` Transit key (for PHI field encryption) |

### Option 1 — Local Vault for development (recommended for laptop testing)

```bash
# Start Vault in dev mode (not for production, no persistence)
docker run --rm -d \
  --name dev-vault \
  --network host \
  -e VAULT_DEV_ROOT_TOKEN_ID=root \
  -e VAULT_DEV_LISTEN_ADDRESS=0.0.0.0:8200 \
  hashicorp/vault:1.18

# Set environment for vault CLI
export VAULT_ADDR=http://localhost:8200
export VAULT_TOKEN=root

# Verify Vault is running
vault status
```

### Option 2 — Production Vault on Kubernetes (the real deployment)

The cluster runs Vault as a StatefulSet. It uses Shamir unseal (3-of-5 keys).

**Check if Vault is already initialized:**
```bash
kubectl -n hope-v2-dev exec hope-vault-0 -- vault status
```

**If not initialized, initialize it:**
```bash
kubectl -n hope-v2-dev exec hope-vault-0 -- vault operator init \
  -key-shares=5 \
  -key-threshold=3
```

> ⚠️ **CRITICAL**: Save all 5 unseal keys and the root token in a secure location
> (password manager, printed paper in a safe). If you lose the unseal keys and
> Vault restarts, you CANNOT unseal it. All secrets are lost.

**Unseal Vault (do this after each restart):**
```bash
# Run this 3 times with 3 different unseal keys
kubectl -n hope-v2-dev exec hope-vault-0 -- vault operator unseal <key1>
kubectl -n hope-v2-dev exec hope-vault-0 -- vault operator unseal <key2>
kubectl -n hope-v2-dev exec hope-vault-0 -- vault operator unseal <key3>

# Verify it's unsealed
kubectl -n hope-v2-dev exec hope-vault-0 -- vault status
# sealed: false  ← this is what you want
```

### Step 1 — Enable the KV secrets engine

```bash
export VAULT_ADDR=http://localhost:8200   # or the in-cluster address
export VAULT_TOKEN=<root-token>

# Enable KV v2 secrets at path "secret/"
vault secrets enable -path=secret kv-v2

# Enable Transit engine (for PHI encryption)
vault secrets enable transit

# Enable AppRole auth
vault auth enable approle
```

### Step 2 — Load secrets into Vault

```bash
# Auth secrets (JWT, session, etc.)
vault kv put secret/hope/auth \
  JWT_SECRET_KEY="$(openssl rand -base64 48)" \
  SESSION_SECRET_KEY="$(openssl rand -base64 48)" \
  API_KEY_PEPPER="$(openssl rand -base64 32)"

# MinIO secrets
vault kv put secret/hope/minio \
  MINIO_ENDPOINT="minio.yourdomain.com:9000" \
  MINIO_ACCESS_KEY="your_access_key" \
  MINIO_SECRET_KEY="your_secret_key"

# Azure secrets
vault kv put secret/hope/azure \
  AZURE_OPENAI_API_KEY="your_key" \
  AZURE_OPENAI_ENDPOINT="https://your-instance.openai.azure.com" \
  AZURE_OPENAI_DEPLOYMENT_NAME="gpt-4o" \
  AZURE_SPEECH_KEY="your_speech_key" \
  AZURE_SPEECH_REGION="eastus"

# Create the PHI Transit encryption key
vault write -f transit/keys/hope-phi
```

### Step 3 — Create the Vault policy for hope-api

```bash
# Create a policy file
cat > /tmp/hope-app-policy.hcl << 'EOF'
# Allow hope-api to read all secrets under secret/hope/
path "secret/data/hope/*" {
  capabilities = ["read"]
}

# Allow Transit encryption/decryption for PHI fields
path "transit/encrypt/hope-phi" {
  capabilities = ["update"]
}
path "transit/decrypt/hope-phi" {
  capabilities = ["update"]
}
EOF

# Apply the policy
vault policy write hope-app /tmp/hope-app-policy.hcl
```

### Step 4 — Create the AppRole for hope-api

```bash
# Create the AppRole
vault write auth/approle/role/hope-api \
  token_policies="hope-app" \
  token_ttl="1h" \
  token_max_ttl="4h"

# Get the role_id (this goes into hope-secrets as VAULT_ROLE_ID)
vault read auth/approle/role/hope-api/role-id
# Output: role_id = xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx

# Generate a secret_id (this goes into hope-secrets as VAULT_SECRET_ID)
vault write -f auth/approle/role/hope-api/secret-id
# Output: secret_id = xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

### Step 5 — Update hope-secrets with the Vault credentials

Take the `role_id` and `secret_id` from Step 4 and add them to your
`secrets.dev.yaml` file:

```yaml
VAULT_ROLE_ID: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"  # from role-id above
VAULT_SECRET_ID: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"  # from secret-id above
```

Re-apply the Secret:
```bash
kubectl apply --server-side -n hope-v2-dev \
  -f arca-deployment-template/deployment/secrets.dev.yaml
```

### Step 6 — Test that hope-api can authenticate to Vault

```bash
# Simulate what hope-api does at startup
vault write auth/approle/login \
  role_id="<your-role-id>" \
  secret_id="<your-secret-id>"

# Should output a token and TTL — if this succeeds, hope-api will too
```

---

## Part C — Skipping Vault for Local Testing

When testing on a laptop, you don't need Vault. Set this environment variable
to tell `hope-api` to read secrets from the OS environment directly:

```bash
SECRETS_PROVIDER=env
```

All secrets listed in Part A must then be set as environment variables when
running `hope-api`:

```bash
docker run --rm \
  -e SECRETS_PROVIDER=env \
  -e JWT_SECRET_KEY=local-test-secret \
  -e SESSION_SECRET_KEY=local-test-secret \
  ... (all other vars) ...
  hope-v2/api:local
```

This is safe for local laptop validation only. **Never use `SECRETS_PROVIDER=env`
in production or staging.**

---

## Summary — All Required Secrets

| Where stored | # of keys | Who reads it |
|---|---|---|
| Kubernetes `hope-secrets` | 31 keys | All services except hope-api for Vault-stored keys |
| Vault `secret/hope/*` | ~12 keys | hope-api only (via AppRole) |
| Vault `transit/keys/hope-phi` | 1 encryption key | hope-api CryptoService (PHI fields) |

The Kubernetes `hope-secrets` keys VAULT_ROLE_ID and VAULT_SECRET_ID bridge the
two stores: they're in the Kubernetes Secret so hope-api can bootstrap itself,
then it reads everything else from Vault.
