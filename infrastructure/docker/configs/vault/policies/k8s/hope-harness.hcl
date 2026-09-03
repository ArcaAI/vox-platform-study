# Vault policy for the Kubernetes auth role
# `hope-harness`, bound to the `hope-harness` ServiceAccount.
#
# LEAST PRIVILEGE BY ENUMERATION, NOT BY GLOB. Each path is one secret this
# workload actually reads (see deployment/vault-agent/README.md
# secret sets). A `secret/data/hope/*` glob would let any compromised pod read
# every platform credential, which is the posture this policy is removing.
#
# Every name below is a `vault-kv` SettingDescriptor rendered through
# toEnvVarName(); adding one here without a descriptor means
# scripts/vault-seed-secrets.sh will never write it.

path "secret/data/hope/HARNESS_SERVICE_TOKEN" {
  capabilities = ["read"]
}

path "secret/data/hope/HARNESS_JUDGE_OPENAI_COMPAT_API_KEY" {
  capabilities = ["read"]
}

path "secret/data/hope/HARNESS_CLAIM_CHECK_ACCESS_KEY" {
  capabilities = ["read"]
}

path "secret/data/hope/HARNESS_CLAIM_CHECK_SECRET_KEY" {
  capabilities = ["read"]
}

# Lease renewal for the agent's own auth lease.
path "auth/token/renew-self" {
  capabilities = ["update"]
}
