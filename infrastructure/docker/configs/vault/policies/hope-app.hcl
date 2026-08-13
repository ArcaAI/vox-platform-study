# hope-app AppRole policy.
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

# Transit encrypt/decrypt for field-encrypted PHI (Data Encryption Initiative
# Phase 3A — ContextItem.content + clinical fields). Mirrors the hope-globalsetting
# grant; the hope-phi key itself is created in dev-init.sh / configure-app-auth.sh.
path "transit/encrypt/hope-phi" {
  capabilities = ["update"]
}
path "transit/decrypt/hope-phi" {
  capabilities = ["update"]
}

# Dynamic PostgreSQL credentials (Phase 5)
path "database/creds/hope-app-role" {
  capabilities = ["read"]
}

# Lease renewal/revoke for the dynamic DB credentials issued above
# (Phase 5 Task 5.7 — VaultLeaseRenewer). The path is global rather than
# lease-scoped because Vault does not template lease_id segments; we
# rely on the API server to reject renew calls for leases the caller
# did not originally request (lease ownership is checked server-side).
path "sys/leases/renew" {
  capabilities = ["update"]
}
path "sys/leases/revoke" {
  capabilities = ["update"]
}

# Health probe endpoint
path "sys/health" {
  capabilities = ["read"]
}
