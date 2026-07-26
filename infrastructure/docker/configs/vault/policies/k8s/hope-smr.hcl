# TASK-558 lane K (K3) — Vault policy for the Kubernetes auth role
# `hope-smr`, bound to the `hope-smr` ServiceAccount.
#
# LEAST PRIVILEGE BY ENUMERATION, NOT BY GLOB. Each path is one secret this
# workload actually reads (see deployment/vault-agent/README.md § Per-service
# secret sets). A `secret/data/hope/*` glob would let any compromised pod read
# every platform credential, which is the posture this ticket is removing.
#
# Every name below is a `vault-kv` SettingDescriptor rendered through
# toEnvVarName(); adding one here without a descriptor means
# scripts/vault-seed-secrets.sh will never write it.

path "secret/data/hope/SMR_SERVICE_TOKEN" {
  capabilities = ["read"]
}

path "secret/data/hope/SMR_AZURE_API_KEY" {
  capabilities = ["read"]
}

path "secret/data/hope/REDIS_PASS" {
  capabilities = ["read"]
}

# Lease renewal for the agent's own auth lease.
path "auth/token/renew-self" {
  capabilities = ["update"]
}
