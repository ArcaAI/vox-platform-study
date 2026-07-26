# TASK-558 lane K (K1) — policy for the GitLab CI JWT role `hope-ci-deploy`.
#
# Deployment-time credentials: the hope-deployments write token, the PgBouncer
# smoke-test SSH identity and PostgreSQL role passwords, and the GitHub backup
# mirror credentials. Read-only; a separate tree from both `secret/ci/*` and
# `secret/hope/*`.
#
# The privilege boundary is the ROLE's bound_claims, not this policy: the role
# binds `ref` to the ARRAY ["staging", "dev", "v*"] (Vault's glob matcher has no
# brace alternation, so "{staging,dev,v*}" would match nothing). See the
# ⚠ OPEN ITEM in .gitlab/ci/vault.yml —
# `staging` and `dev` are not protected branches on this instance today, so the
# claim is a scoping mechanism rather than a hard boundary until they are.
# Protect them and add `"ref_protected":"true"` to close it.

path "secret/data/deploy/*" {
  capabilities = ["read"]
}

path "secret/metadata/deploy/*" {
  capabilities = ["read"]
}

path "auth/token/revoke-self" {
  capabilities = ["update"]
}
