#!/usr/bin/env bash
# =============================================================================
# HOPE — Vault HA end-to-end test on kind (TASK-312 Phase C, C.9)
# =============================================================================
# Proves the whole Phase C stack on a throwaway local cluster:
#   1. seal Vault up + transit auto-unseal token (Shamir 1/1 for speed)
#   2. 3-node Raft HA chart installs, ALL 3 nodes auto-unseal + join quorum
#   3. init Job stores recovery keys + enables audit
#   4. app auth configured; AppRole creds delivered as a k8s Secret (B.9 shape)
#   5. agent-injector delivers a secret to /vault/secrets/* in an annotated pod
#      (AC-C4)
#
# Usage:  ./kind-e2e.sh [--keep]
#   --keep   leave the cluster running for inspection (default: delete on exit)
#
# Requires: kind, kubectl, helm, docker (daemon running).
# Exit 0 = all assertions passed.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CLUSTER="${CLUSTER:-hope-vault-e2e}"
NS="vault-system"
CHART_VERSION="0.32.0"
KEEP="false"
[ "${1:-}" = "--keep" ] && KEEP="true"

VAULT_IMG="hashicorp/vault:1.21.2"
INJECTOR_IMG="hashicorp/vault-k8s:1.7.2"
BUSYBOX_IMG="busybox:1.37"
KUBECTL_IMG="alpine/k8s:1.33.1" # init-job.yaml drives Vault via kubectl exec (needs a shell)

log()  { printf '\n\033[1;36m=== %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m  PASS:\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m  FAIL:\033[0m %s\n' "$*" >&2; exit 1; }

cleanup() {
  if [ "$KEEP" = "true" ]; then
    log "leaving cluster '${CLUSTER}' up (--keep). Delete with: kind delete cluster --name ${CLUSTER}"
  else
    log "tearing down cluster '${CLUSTER}'"
    kind delete cluster --name "$CLUSTER" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

for bin in kind kubectl helm docker; do command -v "$bin" >/dev/null || die "missing required tool: $bin"; done
docker info >/dev/null 2>&1 || die "docker daemon not reachable"

log "creating kind cluster ${CLUSTER}"
if ! kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
  kind create cluster --name "$CLUSTER" --wait 120s
fi
kubectl config use-context "kind-${CLUSTER}" >/dev/null

log "pre-pulling + loading images (de-flakes in-cluster pulls)"
for img in "$VAULT_IMG" "$INJECTOR_IMG" "$BUSYBOX_IMG" "$KUBECTL_IMG"; do
  docker image inspect "$img" >/dev/null 2>&1 || docker pull "$img"
  kind load docker-image "$img" --name "$CLUSTER"
done

helm repo add hashicorp https://helm.releases.hashicorp.com >/dev/null 2>&1 || true
helm repo update hashicorp >/dev/null

# ---- 1. seal Vault + transit token --------------------------------------------
log "deploying seal Vault"
kubectl apply -f "$ROOT/seal-vault/seal-vault.yaml"
kubectl -n "$NS" rollout status sts/vault-seal --timeout=120s
# ALLOW_INSECURE_KEY_SHARES: Shamir 1/1 is refused by seal-bootstrap.sh in prod;
# this is a throwaway kind cluster, so opt into it explicitly for speed.
ALLOW_INSECURE_KEY_SHARES=true KEY_SHARES=1 KEY_THRESHOLD=1 SEAL_POD=vault-seal-0 "$ROOT/seal-vault/seal-bootstrap.sh"
kubectl -n "$NS" get secret vault-seal-transit >/dev/null || die "transit token Secret not created"
ok "seal Vault unsealed + transit token Secret present"

# ---- 2. HA chart --------------------------------------------------------------
log "installing HA chart (3-node Raft, transit auto-unseal)"
# Single-node kind: disable the chart's default pod anti-affinity so all 3 Raft
# replicas schedule on the one node. Production keeps the chart default (one
# Vault per node) — this override is E2E-only.
helm upgrade --install vault hashicorp/vault --version "$CHART_VERSION" -n "$NS" \
  -f "$ROOT/helm/values.yaml" -f "$ROOT/manifests/audit-sidecar.values.yaml" \
  --set server.affinity=""

log "waiting for vault-0 pod to exist + container to start"
for _ in $(seq 1 60); do kubectl -n "$NS" get pod vault-0 >/dev/null 2>&1 && break; sleep 2; done

# ---- 3. init Job --------------------------------------------------------------
log "running init Job"
kubectl apply -f "$ROOT/bootstrap/init-job.yaml"
kubectl -n "$NS" wait --for=condition=complete job/vault-init --timeout=240s \
  || { kubectl -n "$NS" logs job/vault-init --tail=50 || true; die "init Job did not complete"; }
kubectl -n "$NS" get secret vault-init-keys >/dev/null || die "vault-init-keys Secret missing"
ok "init Job complete; recovery keys stored"

log "waiting for all 3 nodes to be Ready (auto-unsealed + joined)"
for n in 0 1 2; do
  kubectl -n "$NS" wait --for=condition=Ready pod/"vault-$n" --timeout=180s \
    || die "vault-$n not Ready (auto-unseal/join failed)"
done
ok "3/3 nodes Ready"

ROOT_TOKEN="$(kubectl -n "$NS" get secret vault-init-keys -o jsonpath='{.data.root-token}' | base64 -d)"
# Nodes join Raft immediately but start as NON-voters; autopilot promotes them to
# voters only after server_stabilization_time (10s) + a reconcile tick. "3/3 Ready"
# (unsealed) therefore RACES promotion — poll for the 3-voter quorum instead of
# snapshotting it once, since this cluster state is eventually-consistent.
log "waiting for Raft autopilot to promote all 3 nodes to voters (<=90s)"
VOTERS=0
for _ in $(seq 1 30); do
  RAFT_JSON="$(kubectl -n "$NS" exec -c vault vault-0 -- sh -ec "export VAULT_ADDR=http://127.0.0.1:8200 VAULT_TOKEN='$ROOT_TOKEN'; vault operator raft list-peers -format=json" 2>/dev/null || true)"
  VOTERS="$(printf '%s' "$RAFT_JSON" | tr -d ' \n' | grep -o '"voter":true' | wc -l | tr -d ' ')"
  [ "$VOTERS" -ge 3 ] && break
  sleep 3
done
[ "$VOTERS" -ge 3 ] || die "expected >=3 raft voters, got $VOTERS"
ok "Raft quorum: $VOTERS voters (autopilot reports Failure Tolerance >=1)"

# ---- 3b. AC-C3: audit device enabled ------------------------------------------
log "asserting AC-C3: file audit device is enabled"
kubectl -n "$NS" exec -c vault vault-0 -- sh -ec "export VAULT_ADDR=http://127.0.0.1:8200 VAULT_TOKEN='$ROOT_TOKEN'; vault audit list -format=json" \
  | tr -d ' \n' | grep -q '"file/"' || die "AC-C3: no file audit device enabled"
ok "AC-C3: file audit device enabled (file/)"

# ---- 3c. AC-C2: auto-unseal on restart (THE headline value prop) --------------
# Delete a follower; it must come back Ready WITHOUT any manual unseal. Ready
# requires unsealed (readinessProbe standbyok=true => sealed/uninit returns 503),
# so "Ready again" proves transit auto-unseal worked unattended.
log "asserting AC-C2: a deleted node auto-unseals + rejoins (no manual key entry)"
kubectl -n "$NS" delete pod vault-2 --wait=false
sleep 5
kubectl -n "$NS" wait --for=condition=Ready pod/vault-2 --timeout=180s \
  || die "AC-C2: vault-2 did not auto-unseal + become Ready after restart"
VOTERS=0
for _ in $(seq 1 30); do
  RAFT_JSON="$(kubectl -n "$NS" exec -c vault vault-0 -- sh -ec "export VAULT_ADDR=http://127.0.0.1:8200 VAULT_TOKEN='$ROOT_TOKEN'; vault operator raft list-peers -format=json" 2>/dev/null || true)"
  VOTERS="$(printf '%s' "$RAFT_JSON" | tr -d ' \n' | grep -o '"voter":true' | wc -l | tr -d ' ')"
  [ "$VOTERS" -ge 3 ] && break
  sleep 3
done
[ "$VOTERS" -ge 3 ] || die "AC-C2: quorum did not recover to 3 voters after restart (got $VOTERS)"
ok "AC-C2: vault-2 auto-unsealed + rejoined quorum ($VOTERS voters)"

# ---- 4. app auth (B.9 file-shape creds) ---------------------------------------
log "configuring app auth"
APP_NS=hope "$ROOT/bootstrap/configure-app-auth.sh"
kubectl -n hope get secret hope-vault-approle -o jsonpath='{.data.role_id}' | base64 -d | grep -q . \
  || die "hope-vault-approle role_id missing"
ok "AppRole creds delivered as Secret hope/hope-vault-approle (role_id + wrapped_secret_id)"

# ---- 5. agent-injector (AC-C4) ------------------------------------------------
log "proving agent-injector delivers a secret to /vault/secrets/* (AC-C4)"
# Vault's k8s auth needs the server SA to be a token reviewer.
kubectl create clusterrolebinding vault-auth-delegator \
  --clusterrole=system:auth-delegator \
  --serviceaccount="${NS}:vault" --dry-run=client -o yaml | kubectl apply -f -

kubectl -n "$NS" exec vault-0 -- sh -ec "
  export VAULT_ADDR=http://127.0.0.1:8200 VAULT_TOKEN='$ROOT_TOKEN'
  vault auth enable kubernetes 2>/dev/null || true
  vault write auth/kubernetes/config \
    kubernetes_host=https://\$KUBERNETES_PORT_443_TCP_ADDR:443 \
    token_reviewer_jwt=@/var/run/secrets/kubernetes.io/serviceaccount/token \
    kubernetes_ca_cert=@/var/run/secrets/kubernetes.io/serviceaccount/ca.crt
  printf 'path \"secret/data/hope/*\" { capabilities=[\"read\"] }\n' | vault policy write hope-injector-test -
  vault write auth/kubernetes/role/hope-injector-test \
    bound_service_account_names=injector-test \
    bound_service_account_namespaces=default \
    policies=hope-injector-test ttl=1h
  vault kv put secret/hope/JWT_SECRET_KEY value=injected-ok
"

kubectl create serviceaccount injector-test --dry-run=client -o yaml | kubectl apply -f -
cat <<'POD' | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: injector-test
  namespace: default
  annotations:
    vault.hashicorp.com/agent-inject: "true"
    vault.hashicorp.com/role: "hope-injector-test"
    vault.hashicorp.com/agent-inject-secret-jwt: "secret/data/hope/JWT_SECRET_KEY"
    vault.hashicorp.com/agent-inject-template-jwt: |
      {{- with secret "secret/data/hope/JWT_SECRET_KEY" -}}{{ .Data.data.value }}{{- end -}}
spec:
  serviceAccountName: injector-test
  containers:
    - name: app
      image: busybox:1.37
      command: ["/bin/sh","-c","sleep 600"]
POD

log "waiting for injected token at /vault/secrets/jwt (<=90s)"
INJECTED=""
for _ in $(seq 1 30); do
  INJECTED="$(kubectl exec injector-test -c app -- cat /vault/secrets/jwt 2>/dev/null || true)"
  [ "$INJECTED" = "injected-ok" ] && break
  sleep 3
done
[ "$INJECTED" = "injected-ok" ] || die "injector did not deliver /vault/secrets/jwt (got: '$INJECTED')"
ok "agent-injector delivered secret to /vault/secrets/jwt"

# ---- 6. revoke the bootstrap root token (no permanent root credential) --------
# Run LAST: all root-needing setup is done. Recovery keys remain in vault-init-keys
# for `vault operator generate-root` when privileged access is needed again.
log "revoking the bootstrap root token; proving it is dead afterwards"
kubectl -n "$NS" exec -c vault vault-0 -- sh -ec "export VAULT_ADDR=http://127.0.0.1:8200 VAULT_TOKEN='$ROOT_TOKEN'; vault token revoke -self"
if kubectl -n "$NS" exec -c vault vault-0 -- sh -ec "export VAULT_ADDR=http://127.0.0.1:8200 VAULT_TOKEN='$ROOT_TOKEN'; vault token lookup -self" >/dev/null 2>&1; then
  die "root token still valid after 'vault token revoke -self'"
fi
ok "bootstrap root token revoked (verified dead); recovery keys persist for generate-root"

# ---- 7. no-root secret_id rotation (Phase E issuer token) ---------------------
# Proves redeploys can refresh the wrapped secret_id with the NARROW issuer token
# alone — root is already revoked, so this is the real day-2 rotation path.
log "rotating wrapped secret_id via issuer token (NO root — root is revoked)"
OLD_WSID="$(kubectl -n hope get secret hope-vault-approle -o jsonpath='{.data.wrapped_secret_id}')"
APP_NS=hope "$ROOT/bootstrap/rotate-secret-id.sh"
NEW_WSID="$(kubectl -n hope get secret hope-vault-approle -o jsonpath='{.data.wrapped_secret_id}')"
[ -n "$NEW_WSID" ] && [ "$NEW_WSID" != "$OLD_WSID" ] || die "rotate-secret-id.sh did not refresh the wrapped_secret_id"
ok "secret_id rotated without root (issuer token only); wrapped_secret_id changed"

log "ALL E2E ASSERTIONS PASSED"
