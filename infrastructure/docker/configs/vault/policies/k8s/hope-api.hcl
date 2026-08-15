# Vault policy for the Kubernetes auth role
# `hope-api`, bound to the `hope-api` ServiceAccount.
#
# LEAST PRIVILEGE BY ENUMERATION, NOT BY GLOB. Each path is one secret this
# workload actually reads (see deployment/vault-agent/README.md § Per-service
# secret sets). A `secret/data/hope/*` glob would let any compromised pod read
# every platform credential, which is the posture this policy is removing.
#
# Every name below is a `vault-kv` SettingDescriptor rendered through
# toEnvVarName(); adding one here without a descriptor means
# scripts/vault-seed-secrets.sh will never write it.

path "secret/data/hope/JWT_SECRET_KEY" {
  capabilities = ["read"]
}

path "secret/data/hope/SESSION_SECRET_KEY" {
  capabilities = ["read"]
}

path "secret/data/hope/API_KEY_PEPPER" {
  capabilities = ["read"]
}

path "secret/data/hope/OIDC_CLIENT_SECRET" {
  capabilities = ["read"]
}

path "secret/data/hope/REDIS_PASS" {
  capabilities = ["read"]
}

path "secret/data/hope/MQTT_PASS" {
  capabilities = ["read"]
}

path "secret/data/hope/MINIO_ACCESS_KEY" {
  capabilities = ["read"]
}

path "secret/data/hope/MINIO_SECRET_KEY" {
  capabilities = ["read"]
}

path "secret/data/hope/S3_ACCESS_KEY" {
  capabilities = ["read"]
}

path "secret/data/hope/S3_SECRET_KEY" {
  capabilities = ["read"]
}

path "secret/data/hope/TEXT_SERVICE_TOKEN" {
  capabilities = ["read"]
}

path "secret/data/hope/NLP_SERVICE_TOKEN" {
  capabilities = ["read"]
}

path "secret/data/hope/GUARDRAIL_SERVICE_TOKEN" {
  capabilities = ["read"]
}

path "secret/data/hope/HARNESS_SERVICE_TOKEN" {
  capabilities = ["read"]
}

path "secret/data/hope/TTS_SERVICE_TOKEN" {
  capabilities = ["read"]
}

path "secret/data/hope/API_GATEWAY_KEY" {
  capabilities = ["read"]
}

# Lease renewal for the agent's own auth lease.
path "auth/token/renew-self" {
  capabilities = ["update"]
}
