# TASK-558 lane K (K1) — policy for the GitLab CI JWT role `hope-ci`.
#
# Attached to a token minted by exchanging a job-scoped GitLab ID token at
# auth/jwt-gitlab. Read-only, and scoped to `secret/ci/*` ONLY.
#
# `secret/ci/*` is deliberately a SIBLING of `secret/hope/*`, not a child:
# Vault's trailing `*` matches across `/`, so `secret/data/hope/*` (granted to
# the application AppRole in hope-app.hcl) would otherwise also cover
# `secret/data/hope/ci/...`. Keeping the trees disjoint means a compromised
# application pod cannot read the pipeline's credentials, and a compromised
# pipeline cannot read the platform's.

path "secret/data/ci/*" {
  capabilities = ["read"]
}

# kv-v2 metadata is needed for a version-pinned read; list is NOT granted, so a
# token cannot enumerate what other CI secrets exist.
path "secret/metadata/ci/*" {
  capabilities = ["read"]
}

# Self-revocation, so vault-login.sh can drop the token the moment the fetch is
# done instead of leaving it valid for the rest of its TTL.
path "auth/token/revoke-self" {
  capabilities = ["update"]
}
