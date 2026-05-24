# Phase 1A Task 1.4 (TASK-302 Stream B) - hope-app AppRole policy.
#
# Scope: minimum capabilities required by the NestJS API pod at runtime.
# Mirrored in production blueprint (research/deployments/deploy-vm430-432-vault.md).

# Read all hope application secrets (kv-v2 requires both data/ and metadata/ paths)
path "secret/data/hope/*" {
  capabilities = ["read", "list"]
}
path "secret/metadata/hope/*" {
  capabilities = ["read", "list"]
}

# Transit encrypt/decrypt for envelope-encrypted GlobalSetting rows (Phase 4)
path "transit/encrypt/hope-globalsetting" {
  capabilities = ["update"]
}
path "transit/decrypt/hope-globalsetting" {
  capabilities = ["update"]
}

# Dynamic PostgreSQL credentials (Phase 5)
path "database/creds/hope-app-role" {
  capabilities = ["read"]
}

# Health probe endpoint
path "sys/health" {
  capabilities = ["read"]
}
