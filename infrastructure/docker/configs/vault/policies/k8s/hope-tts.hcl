# TASK-558 lane K (K3) — Vault policy for the Kubernetes auth role
# `hope-tts`, bound to the `hope-tts` ServiceAccount.
#
# LEAST PRIVILEGE BY ENUMERATION, NOT BY GLOB. Each path is one secret this
# workload actually reads (see deployment/vault-agent/README.md § Per-service
# secret sets). A `secret/data/hope/*` glob would let any compromised pod read
# every platform credential, which is the posture this ticket is removing.
#
# Every name below is a `vault-kv` SettingDescriptor rendered through
# toEnvVarName(); adding one here without a descriptor means
# scripts/vault-seed-secrets.sh will never write it.

path "secret/data/hope/TTS_SERVICE_TOKEN" {
  capabilities = ["read"]
}

# TASK-602: TTS_SARVAM_API_KEY and AZURE_SPEECH_KEY removed — TTS's Sarvam and
# Azure Speech credentials are now BYOK-only (db-secret / AiProviderConnection),
# never Vault-kv platform secrets.

# Lease renewal for the agent's own auth lease.
path "auth/token/renew-self" {
  capabilities = ["update"]
}
