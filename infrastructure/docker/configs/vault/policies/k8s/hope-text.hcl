# Vault policy for the Kubernetes auth role
# `hope-text`, bound to the `hope-text` ServiceAccount.
# Renamed from `hope-smr` by TASK-740. Vault has no policy rename: the live
# swap is create-then-bind-then-delete, per the deployment-repo checklist in
# the ticket README section 6.4.
#
# LEAST PRIVILEGE BY ENUMERATION, NOT BY GLOB. Each path is one secret this
# workload actually reads (see deployment/vault-agent/README.md § Per-service
# secret sets). A `secret/data/hope/*` glob would let any compromised pod read
# every platform credential, which is the posture this policy is removing.
#
# Every name below is a `vault-kv` SettingDescriptor rendered through
# toEnvVarName(); adding one here without a descriptor means
# scripts/vault-seed-secrets.sh will never write it.

path "secret/data/hope/TEXT_SERVICE_TOKEN" {
  capabilities = ["read"]
}

# TEXT_AZURE_API_KEY removed — the text service's Azure OpenAI credential is now
# BYOK-only (db-secret / AiProviderConnection), never a Vault-kv platform secret.
# (OpenAI/Anthropic platform keys were likewise removed from the registry.)

path "secret/data/hope/REDIS_PASS" {
  capabilities = ["read"]
}

# Lease renewal for the agent's own auth lease.
path "auth/token/renew-self" {
  capabilities = ["update"]
}
