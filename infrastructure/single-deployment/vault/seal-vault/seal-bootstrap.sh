#!/usr/bin/env bash
# =============================================================================
# HOPE — seal-Vault bootstrap (TASK-312 Phase C, C.3)
# =============================================================================
# Initialises + unseals the single-node seal Vault, enables Transit, creates the
# `autounseal` key + a tightly-scoped token, and stores that token as the k8s
# Secret `vault-seal-transit` that helm/values.yaml mounts into the HA cluster.
#
# Run ONCE, right after `kubectl apply -f seal-vault.yaml`, BEFORE installing the
# HA chart. All `vault` calls run INSIDE the pod (the host needs no vault CLI).
#
#   ./seal-bootstrap.sh
#
# Re-run safety: if the seal Vault is already initialised this script will NOT
# re-init (that would orphan your data). To refresh the transit token on an
# already-initialised seal Vault, pass a privileged token:
#   VAULT_SEAL_ROOT_TOKEN=<token> ./seal-bootstrap.sh --refresh-token
#
# !!! The init step prints the unseal keys + root token EXACTLY ONCE. Store them
# !!! offline (split among ops, e.g. 5 shares / 3 threshold). They are NOT saved.
# =============================================================================
set -euo pipefail

NS="${VAULT_NAMESPACE:-vault-system}"
POD="${SEAL_POD:-vault-seal-0}"
KEY_SHARES="${KEY_SHARES:-5}"
KEY_THRESHOLD="${KEY_THRESHOLD:-3}"
TRANSIT_KEY="${TRANSIT_KEY:-autounseal}"
TOKEN_SECRET="${TOKEN_SECRET:-vault-seal-transit}"
REFRESH_ONLY="false"
[ "${1:-}" = "--refresh-token" ] && REFRESH_ONLY="true"

log() { printf '\033[1;34m[seal-bootstrap]\033[0m %s\n' "$*"; }
err() { printf '\033[1;31m[seal-bootstrap] ERROR:\033[0m %s\n' "$*" >&2; }

vex() { kubectl exec -n "$NS" "$POD" -- sh -c "$*"; }

# Token-bearing exec: pipe the privileged token on STDIN (read by the in-pod
# shell) so it never appears in the `sh` argv — not visible to `ps` inside the
# pod. Used for every root-token operation in configure_transit().
vext() {
  printf '%s\n' "$ROOT_TOKEN" | kubectl exec -i -n "$NS" "$POD" -- sh -ec '
    IFS= read -r VAULT_TOKEN; export VAULT_TOKEN VAULT_ADDR=http://127.0.0.1:8200
    '"$*"
}

require_pod() {
  log "waiting for ${POD} in ns/${NS} to be Running ..."
  kubectl wait --for=condition=Ready pod/"$POD" -n "$NS" --timeout=120s \
    || { err "seal Vault pod not Ready (a sealed/uninit Vault is NOT Ready by k8s probes is fine — check 'kubectl get pod -n $NS $POD')"; }
  # The pod can be 'Running' but not 'Ready' (no readiness probe on unseal); poll the API instead.
  for _ in $(seq 1 30); do
    if vex 'VAULT_ADDR=http://127.0.0.1:8200 vault status -format=json >/dev/null 2>&1 || [ $? -eq 2 ]'; then
      return 0
    fi
    sleep 2
  done
  err "seal Vault API never answered on :8200"; exit 1
}

is_initialized() {
  # vault status exit code: 0 unsealed, 2 sealed, 1 error. Use -format=json field.
  vex 'VAULT_ADDR=http://127.0.0.1:8200 vault status -format=json 2>/dev/null' \
    | grep -q '"initialized": true'
}

write_token_secret() {
  local token="$1"
  log "writing k8s Secret ${TOKEN_SECRET} (transit auto-unseal token) in ns/${NS}"
  kubectl create secret generic "$TOKEN_SECRET" -n "$NS" \
    --from-literal=token="$token" \
    --dry-run=client -o yaml | kubectl apply -f -
}

configure_transit() {
  # Idempotent: enabling an already-enabled engine / re-writing a key is a no-op.
  log "enabling transit engine + key '${TRANSIT_KEY}'"
  vext "vault secrets enable -path=transit transit 2>/dev/null || true; \
        vault write -f transit/keys/${TRANSIT_KEY} >/dev/null"

  log "writing 'autounseal' policy (transit encrypt/decrypt on ${TRANSIT_KEY} ONLY)"
  vext "printf 'path \"transit/encrypt/${TRANSIT_KEY}\" { capabilities = [\"update\"] }\n\
path \"transit/decrypt/${TRANSIT_KEY}\" { capabilities = [\"update\"] }\n' \
        | vault policy write autounseal -"

  log "minting periodic, orphan token bound to 'autounseal' policy"
  AUTOUNSEAL_TOKEN="$(vext "vault token create -orphan -policy=autounseal -period=24h -field=token")"
  [ -n "$AUTOUNSEAL_TOKEN" ] || { err "failed to mint autounseal token"; exit 1; }
  write_token_secret "$AUTOUNSEAL_TOKEN"
}

require_pod

if [ "$REFRESH_ONLY" = "true" ]; then
  ROOT_TOKEN="${VAULT_SEAL_ROOT_TOKEN:?--refresh-token requires VAULT_SEAL_ROOT_TOKEN}"
  configure_transit
  log "transit token refreshed. Restart HA pods to pick it up if it changed: kubectl rollout restart sts/vault -n ${NS}"
  exit 0
fi

if is_initialized; then
  err "seal Vault is already initialised. Re-run with --refresh-token + VAULT_SEAL_ROOT_TOKEN to rotate the transit token, or 'kubectl delete -f seal-vault.yaml' (DESTROYS the seal key — only if you will re-key the whole cluster)."
  exit 1
fi

# Production safety: the seal Vault is the cluster's ROOT OF TRUST. Shamir 1/1 (or
# any <3/2) means a single key-holder can unseal it alone — a critical single
# point of compromise. Refuse it unless explicitly allowed (the kind E2E sets
# ALLOW_INSECURE_KEY_SHARES=true for speed on a throwaway cluster).
if [ "$KEY_SHARES" -lt 3 ] || [ "$KEY_THRESHOLD" -lt 2 ]; then
  if [ "${ALLOW_INSECURE_KEY_SHARES:-false}" != "true" ]; then
    err "refusing Shamir ${KEY_SHARES}/${KEY_THRESHOLD} (<3/2) for the root-of-trust seal Vault. Use 5/3 in production. Set ALLOW_INSECURE_KEY_SHARES=true ONLY for throwaway test clusters."
    exit 1
  fi
  log "WARNING: insecure Shamir ${KEY_SHARES}/${KEY_THRESHOLD} (ALLOW_INSECURE_KEY_SHARES=true) — test clusters ONLY"
fi

log "initialising seal Vault (${KEY_SHARES} key shares / ${KEY_THRESHOLD} threshold)"
INIT_JSON="$(vex "VAULT_ADDR=http://127.0.0.1:8200 vault operator init \
  -key-shares=${KEY_SHARES} -key-threshold=${KEY_THRESHOLD} -format=json")"

ROOT_TOKEN="$(printf '%s' "$INIT_JSON" | grep -o '"root_token": *"[^"]*"' | sed 's/.*: *"//;s/"$//')"
[ -n "$ROOT_TOKEN" ] || { err "could not parse root token from init output"; exit 1; }

# Unseal keys (base64). `vault operator init -format=json` pretty-prints the
# array across MULTIPLE lines, and grep is line-oriented — so flatten newlines
# first. `|| true` stops set -e/pipefail from aborting silently on a parse miss;
# we validate explicitly right after. macOS host bash is 3.2 (no mapfile), so the
# keys are fed to a here-doc while loop (runs in the current shell).
INIT_ONELINE="$(printf '%s' "$INIT_JSON" | tr '\n' ' ')"
UNSEAL_KEYS_RAW="$(printf '%s' "$INIT_ONELINE" \
  | grep -o '"unseal_keys_b64": *\[[^]]*\]' \
  | grep -o '"[^"]\{20,\}"' | tr -d '"' || true)"
[ -n "$UNSEAL_KEYS_RAW" ] || { err "could not parse unseal keys from init output"; exit 1; }

log "unsealing with ${KEY_THRESHOLD} key(s)"
n=0
while IFS= read -r key; do
  [ -z "$key" ] && continue
  n=$((n + 1))
  [ "$n" -gt "$KEY_THRESHOLD" ] && break
  vex "VAULT_ADDR=http://127.0.0.1:8200 vault operator unseal '${key}'" >/dev/null
done <<EOF
${UNSEAL_KEYS_RAW}
EOF

configure_transit

cat <<BANNER

================================ STORE OFFLINE NOW ================================
  The following appear ONLY ONCE and are NOT saved anywhere by this script.
  Distribute the unseal keys to separate ops custodians (Shamir ${KEY_SHARES}/${KEY_THRESHOLD}).

  ROOT TOKEN : ${ROOT_TOKEN}

  UNSEAL KEYS (base64):
$(printf '%s\n' "${UNSEAL_KEYS_RAW}" | sed 's/^/    - /')

  After a seal-Vault restart you MUST manually re-unseal it with ${KEY_THRESHOLD} keys:
    kubectl exec -n ${NS} ${POD} -- vault operator unseal <key>   # x${KEY_THRESHOLD}
  (The HA cluster stays sealed until the seal Vault is unsealed.)
==================================================================================

BANNER

log "done. Next: install the HA chart (see ../README.md)."
