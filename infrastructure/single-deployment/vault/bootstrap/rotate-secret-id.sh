#!/usr/bin/env bash
# =============================================================================
# HOPE — rotate the hope-app wrapped secret_id (TASK-312 Phase E, Day-2)
# =============================================================================
# Mints a FRESH wrapped secret_id for the hope-app AppRole using ONLY the narrow
# secret_id-issuer token created by configure-app-auth.sh — NO root token. Run
# before each (re)deploy of the API (the wrapped secret_id is single-use and
# short-TTL); then roll the API pods so they consume it at boot.
#
#   APP_NS=hope ./rotate-secret-id.sh
#
# Idempotent: safe to run repeatedly; each run overwrites the wrapped_secret_id
# in Secret <APP_NS>/hope-vault-approle (role_id is unchanged).
# =============================================================================
set -euo pipefail

NS="${VAULT_NAMESPACE:-vault-system}"
POD="${VAULT_POD:-vault-0}"
APP_NS="${APP_NS:-hope}"
ROLE="${APP_ROLE:-hope-app}"
WRAP_TTL="${WRAP_TTL:-300s}" # size to max delay between mint and pod boot

log() { printf '\033[1;34m[rotate-secret-id]\033[0m %s\n' "$*"; }
err() { printf '\033[1;31m[rotate-secret-id] ERROR:\033[0m %s\n' "$*" >&2; }

ISSUER_TOKEN="$(kubectl get secret hope-vault-approle-issuer -n "$APP_NS" -o jsonpath='{.data.token}' 2>/dev/null | base64 -d || true)"
[ -n "$ISSUER_TOKEN" ] || { err "no issuer token in Secret ${APP_NS}/hope-vault-approle-issuer — run configure-app-auth.sh first"; exit 1; }

# Issuer token piped on STDIN (read by the in-pod shell) so it never lands in the
# `sh -ec` argv. -c vault: vault-0 has the audit-log-shipper sidecar too.
vexi() {
  printf '%s\n' "$ISSUER_TOKEN" | kubectl exec -i -n "$NS" -c vault "$POD" -- sh -ec '
    IFS= read -r VAULT_TOKEN; export VAULT_TOKEN VAULT_ADDR=http://127.0.0.1:8200
    '"$*"
}

# Keep the periodic issuer token alive: renewing on every (re)deploy means a cluster
# that deploys at least once per token period (720h) never has to re-bootstrap it.
# Best-effort — if it fails the token is likely already expired and the mint below
# will fail loudly with remediation.
log "renewing issuer token (keep-alive within its period)"
vexi "vault write -f auth/token/renew-self >/dev/null" || err "issuer renew-self failed (likely expired) — if the mint below fails, re-run configure-app-auth.sh"

log "minting fresh wrapped secret_id for ${ROLE} (-wrap-ttl=${WRAP_TTL}) via issuer token"
ROLE_ID="$(vexi "vault read -field=role_id auth/approle/role/${ROLE}/role-id")"
WRAPPED_SECRET_ID="$(vexi "vault write -wrap-ttl=${WRAP_TTL} -f -field=wrapping_token auth/approle/role/${ROLE}/secret-id")"
[ -n "$ROLE_ID" ] && [ -n "$WRAPPED_SECRET_ID" ] || { err "issuer token could not mint role_id / wrapped secret_id (token expired? re-run configure-app-auth.sh)"; exit 1; }

log "updating Secret ${APP_NS}/hope-vault-approle"
kubectl create secret generic hope-vault-approle -n "$APP_NS" \
  --from-literal=role_id="$ROLE_ID" \
  --from-literal=wrapped_secret_id="$WRAPPED_SECRET_ID" \
  --dry-run=client -o yaml | kubectl apply -f -

log "done. Roll the API to consume it:  kubectl -n ${APP_NS} rollout restart deploy/<api-deploy>"
