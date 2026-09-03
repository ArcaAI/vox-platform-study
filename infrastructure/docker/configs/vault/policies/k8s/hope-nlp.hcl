# Vault policy for the Kubernetes auth role
# `hope-nlp`, bound to the `hope-nlp` ServiceAccount.
#
# LEAST PRIVILEGE BY ENUMERATION, NOT BY GLOB. Each path is one secret this
# workload actually reads (see deployment/vault-agent/README.md
# secret sets). A `secret/data/hope/*` glob would let any compromised pod read
# every platform credential, which is the posture this policy is removing.
#
# Every name below is a `vault-kv` SettingDescriptor rendered through
# toEnvVarName(); adding one here without a descriptor means
# scripts/vault-seed-secrets.sh will never write it.

path "secret/data/hope/NLP_SERVICE_TOKEN" {
  capabilities = ["read"]
}

# Lease renewal for the agent's own auth lease.
path "auth/token/renew-self" {
  capabilities = ["update"]
}
