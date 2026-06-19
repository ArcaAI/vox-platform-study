#!/usr/bin/env bash
# =============================================================================
# HOPE — app auth config for the HA cluster (TASK-312 Phase C)
# =============================================================================
# Idempotent. Configures everything the NestJS API needs and delivers AppRole
# creds in the FILE shape the app already expects (VAULT_ROLE_ID_FILE /
# VAULT_WRAPPED_SECRET_ID_FILE — apps/api/.env.production, B.9/B.10):
#   - kv-v2 at secret/        (warmup secrets: JWT_SECRET_KEY, …)
#   - transit/ + hope-globalsetting key (GlobalSetting rows) + hope-phi key (PHI fields)
#   - approle auth + hope-app policy + hope-app role
#   - k8s Secret <APP_NS>/hope-vault-approle  data: role_id, wrapped_secret_id
#     (mount as files in the API Deployment; see ../README.md "Wiring the app")
#
# Mirrors infrastructure/docker/configs/vault/dev-init.sh, but for prod HA.
# Run AFTER init-job.yaml has completed.
#
#   APP_NS=hope ./configure-app-auth.sh
#
# NOTE: this seeds NO secret VALUES (those are injected by ops / CI, never in
# git). It only stands up the engines, policy, role, and bootstrap creds.
# =============================================================================
set -euo pipefail

NS="${VAULT_NAMESPACE:-vault-system}"
POD="${VAULT_POD:-vault-0}"
APP_NS="${APP_NS:-hope}"
ROLE="${APP_ROLE:-hope-app}"
WRAP_TTL="${WRAP_TTL:-300s}" # size to max delay between mint and pod boot (cold rollouts/image pulls)
SECRET_ID_TTL="${SECRET_ID_TTL:-10m}"
TOKEN_TTL="${TOKEN_TTL:-1h}"
TOKEN_MAX_TTL="${TOKEN_MAX_TTL:-24h}"

log() { printf '\033[1;34m[configure-app-auth]\033[0m %s\n' "$*"; }
err() { printf '\033[1;31m[configure-app-auth] ERROR:\033[0m %s\n' "$*" >&2; }

# Privileged token source, in priority order:
#   1. $VAULT_TOKEN  — for re-runs AFTER the bootstrap root token was revoked:
#      mint a fresh temporary root with `vault operator generate-root` (recovery-
#      key quorum) and pass it here (see ../README.md "Rotating / re-running").
#   2. Secret vault-init-keys — the bootstrap root token from init-job.yaml.
ROOT_TOKEN="${VAULT_TOKEN:-$(kubectl get secret vault-init-keys -n "$NS" -o jsonpath='{.data.root-token}' 2>/dev/null | base64 -d || true)}"
[ -n "$ROOT_TOKEN" ] || { err "no privileged token: export VAULT_TOKEN=<root> (e.g. from 'vault operator generate-root') or run init-job.yaml first (Secret vault-init-keys)"; exit 1; }

# -c vault: the HA pod has a second container (audit-log-shipper) once the audit
# sidecar overlay is applied; pin the target so kubectl doesn't warn/guess.
# The token is piped on STDIN (read by the in-pod shell) so it never lands in the
# `sh -ec` argv — i.e. not exposed to `ps`/process listings inside the container.
vex() {
  printf '%s\n' "$ROOT_TOKEN" | kubectl exec -i -n "$NS" -c vault "$POD" -- sh -ec '
    IFS= read -r VAULT_TOKEN; export VAULT_TOKEN VAULT_ADDR=http://127.0.0.1:8200
    '"$*"
}

log "enabling kv-v2 at secret/"
vex 'vault secrets enable -path=secret -version=2 kv 2>/dev/null || true'

log "enabling transit + keys hope-globalsetting, hope-phi"
# hope-phi: dedicated PHI field-encryption key (Data Encryption Initiative
# Phase 3A), kept separate from hope-globalsetting so PHI rotation/blast-radius
# is independent. Mirrors dev-init.sh; `-f` is idempotent (no-op if it exists).
vex 'vault secrets enable transit 2>/dev/null || true; vault write -f transit/keys/hope-globalsetting >/dev/null; vault write -f transit/keys/hope-phi >/dev/null'

log "enabling approle auth"
vex 'vault auth enable approle 2>/dev/null || true'

log "writing ${ROLE} policy"
vex "printf '%s' '
path \"secret/data/hope/*\"     { capabilities = [\"read\", \"list\"] }
path \"secret/metadata/hope/*\" { capabilities = [\"read\", \"list\"] }
path \"transit/encrypt/hope-globalsetting\" { capabilities = [\"update\"] }
path \"transit/decrypt/hope-globalsetting\" { capabilities = [\"update\"] }
path \"transit/encrypt/hope-phi\" { capabilities = [\"update\"] }
path \"transit/decrypt/hope-phi\" { capabilities = [\"update\"] }
path \"database/creds/hope-app-role\" { capabilities = [\"read\"] }
path \"sys/leases/renew\"  { capabilities = [\"update\"] }
path \"sys/leases/revoke\" { capabilities = [\"update\"] }
path \"auth/token/renew-self\" { capabilities = [\"update\"] }
path \"sys/health\" { capabilities = [\"read\"] }
' | vault policy write ${ROLE} -"

log "creating ${ROLE} approle role (token_ttl=${TOKEN_TTL} max=${TOKEN_MAX_TTL})"
vex "vault write auth/approle/role/${ROLE} \
  token_policies=${ROLE} \
  token_ttl=${TOKEN_TTL} \
  token_max_ttl=${TOKEN_MAX_TTL} \
  token_num_uses=0 \
  secret_id_ttl=${SECRET_ID_TTL} \
  secret_id_num_uses=1 \
  token_renewable=true"

# --- secret_id issuer (Phase E Day-2 rotation) --------------------------------
# A NARROW, periodic token scoped to ONLY this role's secret-id + role-id endpoints
# (no root, no other paths). bootstrap/rotate-secret-id.sh uses it to refresh the
# wrapped_secret_id before each (re)deploy WITHOUT the bootstrap root token, so root
# can stay revoked.
#
# BLAST RADIUS — treat this token like the hope-app credentials themselves: a holder
# can mint a secret_id AND read the role_id (both granted below), AppRole-login as
# hope-app, and thus read everything hope-app's policy grants (KV hope/* secrets,
# transit encrypt/decrypt, dynamic DB creds). It grants NO path beyond that (no root,
# no other roles). If it leaks: rotate it (re-run THIS script with a generate-root
# token) and rotate the exposed hope-app secrets.
#
# PERIOD — periodic tokens expire if not renewed within each period. We use 720h
# (30d) idle tolerance and rotate-secret-id.sh renew-self's it on every run, so any
# cluster that (re)deploys at least monthly keeps it alive indefinitely. If it DOES
# lapse, re-run this script (generate-root) to mint a fresh one.
log "writing ${ROLE}-secret-id-issuer policy + periodic token"
vex "printf '%s' '
path \"auth/approle/role/${ROLE}/secret-id\" { capabilities = [\"create\", \"update\"] }
path \"auth/approle/role/${ROLE}/role-id\"   { capabilities = [\"read\"] }
' | vault policy write ${ROLE}-secret-id-issuer -"
ISSUER_TOKEN="$(vex "vault token create -orphan -policy=${ROLE}-secret-id-issuer -period=720h -display-name=${ROLE}-secret-id-issuer -field=token")"
[ -n "$ISSUER_TOKEN" ] || { err "failed to mint secret_id-issuer token"; exit 1; }
kubectl get namespace "$APP_NS" >/dev/null 2>&1 || kubectl create namespace "$APP_NS"
kubectl create secret generic hope-vault-approle-issuer -n "$APP_NS" \
  --from-literal=token="$ISSUER_TOKEN" \
  --dry-run=client -o yaml | kubectl apply -f -

log "reading role_id + minting wrapped secret_id (-wrap-ttl=${WRAP_TTL})"
ROLE_ID="$(vex "vault read -field=role_id auth/approle/role/${ROLE}/role-id")"
WRAPPED_SECRET_ID="$(vex "vault write -wrap-ttl=${WRAP_TTL} -f -field=wrapping_token auth/approle/role/${ROLE}/secret-id")"
[ -n "$ROLE_ID" ] && [ -n "$WRAPPED_SECRET_ID" ] || { err "failed to obtain role_id / wrapped secret_id"; exit 1; }

log "writing k8s Secret ${APP_NS}/hope-vault-approle (role_id + wrapped_secret_id)"
kubectl get namespace "$APP_NS" >/dev/null 2>&1 || kubectl create namespace "$APP_NS"
kubectl create secret generic hope-vault-approle -n "$APP_NS" \
  --from-literal=role_id="$ROLE_ID" \
  --from-literal=wrapped_secret_id="$WRAPPED_SECRET_ID" \
  --dry-run=client -o yaml | kubectl apply -f -

cat <<DONE

[configure-app-auth] done.
  role_id stored (non-secret). wrapped_secret_id is single-use, TTL=${WRAP_TTL}.
  Mount Secret hope-vault-approle into the API pod as files:
    VAULT_ROLE_ID_FILE=/run/secrets/vault/role_id
    VAULT_WRAPPED_SECRET_ID_FILE=/run/secrets/vault/wrapped_secret_id
  A fresh wrapped_secret_id is needed before each (re)deploy. Use the no-root
  rotation path (it uses the narrow secret_id-issuer token created above, so the
  bootstrap root token can stay revoked):
    APP_NS=${APP_NS} ./rotate-secret-id.sh
  Re-running THIS script (full re-bootstrap) needs a privileged token after root
  is revoked: VAULT_TOKEN=<generate-root output> APP_NS=${APP_NS} ./configure-app-auth.sh
DONE
