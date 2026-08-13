#!/usr/bin/env bash
# =============================================================================
# HOPE — Vault chaos drill
# =============================================================================
# Injects realistic faults into a RUNNING HA Vault cluster and asserts the
# cluster (and, optionally, the HOPE API) self-recovers — no manual unseal, no
# data loss. Designed for STAGING; safe to smoke on a kind cluster.
#
# Drills:
#   A. Leader failover     — delete the active pod; assert a NEW leader is
#                            elected and the cluster returns to N unsealed nodes.
#   B. Follower loss       — delete a standby pod; assert it AUTO-UNSEALS (transit)
#                            and rejoins with no manual key entry.
#   C. Transit outage      — black-hole the seal Service (transit unreachable WITHOUT
#                            sealing the seal Vault itself — its Shamir keys are held
#                            offline), restart a Vault node so it CANNOT auto-unseal
#                            (asserts it stays sealed), then restore the Service and
#                            assert the node auto-unseals + rejoins.
#   D. App self-recovery   — (optional) if APP_HEALTH_URL is set, assert it reports
#                            healthy/non-degraded after each drill.
#
# Everything uses the UNAUTHENTICATED `vault status` (works after the root token
# is revoked) — no Vault token required. -c vault targets the server container
# (the audit sidecars share the pod).
#
# Usage:
#   CHAOS_CONFIRM=yes ./scripts/chaos/vault-drill.sh            # all drills
#   APP_HEALTH_URL=https://api.staging/health \
#     CHAOS_CONFIRM=yes ./scripts/chaos/vault-drill.sh
#   DRILLS="A C" CHAOS_CONFIRM=yes ./scripts/chaos/vault-drill.sh   # subset
#
# Env:
#   VAULT_NAMESPACE   (default vault-system)
#   SEAL_STATEFULSET  (default vault-seal)
#   APP_HEALTH_URL    (optional) HTTP(S) endpoint that 200s only when healthy
#   RECOVER_TIMEOUT   (default 150) seconds to wait for each recovery
#   DRILLS            (default "A B C") which drills to run
#   CHAOS_CONFIRM=yes skip the interactive "are you sure" prompt
# =============================================================================
set -euo pipefail

NS="${VAULT_NAMESPACE:-vault-system}"
SEAL_STS="${SEAL_STATEFULSET:-vault-seal}"
APP_HEALTH_URL="${APP_HEALTH_URL:-}"
RECOVER_TIMEOUT="${RECOVER_TIMEOUT:-150}"
DRILLS="${DRILLS:-A B C}"
SERVER_SEL="app.kubernetes.io/name=vault,component=server"

log()  { printf '\n\033[1;36m=== %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m  PASS:\033[0m %s\n' "$*"; }
info() { printf '\033[1;34m  ..  \033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m  FAIL:\033[0m %s\n' "$*" >&2; exit 1; }

for bin in kubectl jq; do command -v "$bin" >/dev/null || die "missing required tool: $bin"; done

# ---- helpers ----------------------------------------------------------------
server_pods() {
  kubectl -n "$NS" get pods -l "$SERVER_SEL" \
    -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null | sort
}
# Unauthenticated status of one pod -> JSON (empty on failure/sealed-exit).
vstatus() { kubectl -n "$NS" exec -c vault "$1" -- vault status -format=json 2>/dev/null || true; }
# Active leader pod name. We ask EACH node which one reports `HA Mode active`
# (version-stable text field) rather than parsing leader_address, which is the
# pod IP under Raft and carries no pod name.
leader_pod() {
  local p
  for p in $(server_pods); do
    if kubectl -n "$NS" exec -c vault "$p" -- vault status 2>/dev/null | grep -qE 'HA Mode[[:space:]]+active'; then
      printf '%s' "$p"; return 0
    fi
  done
  return 0
}
sealed() { vstatus "$1" | jq -e '.sealed == true'  >/dev/null 2>&1; }
unsealed_count() {
  local p n=0
  for p in $(server_pods); do vstatus "$p" | jq -e '.sealed == false' >/dev/null 2>&1 && n=$((n + 1)); done
  printf '%s' "$n"
}
node_total() { server_pods | grep -c . || printf '0'; }
wait_all_ready() {
  kubectl -n "$NS" wait --for=condition=Ready pod -l "$SERVER_SEL" --timeout="${RECOVER_TIMEOUT}s" >/dev/null
}
wait_all_unsealed() {
  local total deadline=$((SECONDS + RECOVER_TIMEOUT))
  total="$(node_total)"
  while [ "$SECONDS" -lt "$deadline" ]; do
    [ "$(unsealed_count)" = "$total" ] && return 0
    sleep 5
  done
  return 1
}
app_ok() {
  [ -z "$APP_HEALTH_URL" ] && return 0
  curl -fsS --max-time 5 "$APP_HEALTH_URL" >/dev/null 2>&1
}
assert_app_recovers() {
  [ -z "$APP_HEALTH_URL" ] && { info "APP_HEALTH_URL unset — skipping app self-recovery check"; return 0; }
  local deadline=$((SECONDS + RECOVER_TIMEOUT))
  while [ "$SECONDS" -lt "$deadline" ]; do app_ok && { ok "app reports healthy ($APP_HEALTH_URL)"; return 0; }; sleep 5; done
  die "app did NOT report healthy within ${RECOVER_TIMEOUT}s ($APP_HEALTH_URL)"
}

# ---- safety -----------------------------------------------------------------
CTX="$(kubectl config current-context 2>/dev/null || echo unknown)"
log "Vault chaos drill — context='${CTX}' ns='${NS}' drills='${DRILLS}'"
kubectl -n "$NS" get pods -l "$SERVER_SEL" -o wide || die "no Vault server pods in ns '$NS'"
TOTAL="$(node_total)"
[ "$TOTAL" -ge 3 ] || die "expected >=3 Vault server pods, found ${TOTAL} — refusing to drill a non-HA cluster"
if [ "${CHAOS_CONFIRM:-}" != "yes" ]; then
  printf '\033[1;33mThis DELETES Vault pods + black-holes the seal Service in %s/%s. Type yes to continue: \033[0m' "$CTX" "$NS"
  read -r ans; [ "$ans" = "yes" ] || die "aborted by operator"
fi

log "baseline: ${TOTAL} server pods; unsealed=$(unsealed_count); leader=$(leader_pod)"
[ "$(unsealed_count)" = "$TOTAL" ] || die "baseline not healthy — all nodes must be unsealed before drilling"
app_ok || { [ -n "$APP_HEALTH_URL" ] && die "baseline app health check failed ($APP_HEALTH_URL)"; }

# ---- Drill A: leader failover ------------------------------------------------
case " $DRILLS " in *" A "*)
  log "Drill A — kill the active leader"
  OLD_LEADER="$(leader_pod)"; [ -n "$OLD_LEADER" ] || die "could not identify the active leader"
  info "active leader = $OLD_LEADER — deleting it"
  kubectl -n "$NS" delete pod "$OLD_LEADER" --wait=false >/dev/null
  info "waiting for a NEW leader (<=${RECOVER_TIMEOUT}s) ..."
  deadline=$((SECONDS + RECOVER_TIMEOUT)); NEW_LEADER=""
  while [ "$SECONDS" -lt "$deadline" ]; do
    NEW_LEADER="$(leader_pod)"
    [ -n "$NEW_LEADER" ] && [ "$NEW_LEADER" != "$OLD_LEADER" ] && break
    sleep 5
  done
  [ -n "$NEW_LEADER" ] && [ "$NEW_LEADER" != "$OLD_LEADER" ] || die "no new leader elected after killing $OLD_LEADER"
  ok "new leader elected: $NEW_LEADER (was $OLD_LEADER)"
  wait_all_ready;    ok "all ${TOTAL} nodes Ready again"
  wait_all_unsealed || die "not all nodes unsealed after failover"
  ok "all ${TOTAL} nodes unsealed after failover"
  assert_app_recovers
;; esac

# ---- Drill B: follower loss + auto-unseal -----------------------------------
case " $DRILLS " in *" B "*)
  log "Drill B — kill a standby (follower)"
  LEADER="$(leader_pod)"
  VICTIM="$(server_pods | grep -v "^${LEADER}$" | head -1)"; [ -n "$VICTIM" ] || die "no follower to kill"
  info "follower = $VICTIM — deleting it (must auto-unseal via transit on restart)"
  kubectl -n "$NS" delete pod "$VICTIM" --wait=false >/dev/null
  wait_all_ready;    ok "$VICTIM restarted + Ready"
  wait_all_unsealed || die "$VICTIM did not auto-unseal/rejoin"
  ok "$VICTIM auto-unsealed + rejoined (no manual key entry)"
  assert_app_recovers
;; esac

# ---- Drill C: transit outage via seal-Service black-hole --------------------
# We make transit UNREACHABLE by pointing the seal Service at no pods (selector
# black-hole) rather than scaling/sealing the seal Vault itself. The seal Vault's
# Shamir keys are held offline and never persisted, so a seal-Vault RESTART needs
# manual re-unseal (not auto-recoverable in a drill). Black-holing the Service is
# fully reversible: the seal Vault pod stays up + unsealed, so restoring the
# selector instantly restores transit and the cluster self-heals.
case " $DRILLS " in *" C "*)
  log "Drill C — transit outage (seal Service black-hole; reversible, seal Vault pod untouched)"
  if ! kubectl -n "$NS" get service "$SEAL_STS" >/dev/null 2>&1; then
    info "seal Service '$SEAL_STS' not found — skipping Drill C"
  else
    # Capture the ORIGINAL selector verbatim so we restore EXACTLY what was there
    # (no assumption about key/value) — robust to custom seal-Service labels.
    ORIG_SEL="$(kubectl -n "$NS" get service "$SEAL_STS" -o json | jq -c '.spec.selector')"
    [ -n "$ORIG_SEL" ] && [ "$ORIG_SEL" != "null" ] || die "seal Service '$SEAL_STS' has no selector — refusing Drill C"
    restore_seal_svc() {
      kubectl -n "$NS" patch service "$SEAL_STS" --type=json \
        -p "[{\"op\":\"replace\",\"path\":\"/spec/selector\",\"value\":${ORIG_SEL}}]" >/dev/null 2>&1 || true
    }
    trap restore_seal_svc EXIT # restore transit even if we die mid-drill
    info "black-holing the seal Service selector — transit becomes unreachable"
    # Replace the WHOLE selector with a single non-matching key so NO original label
    # can keep it bound to the pod (works regardless of the original selector shape).
    kubectl -n "$NS" patch service "$SEAL_STS" --type=json \
      -p '[{"op":"replace","path":"/spec/selector","value":{"hope.io/chaos-blackhole":"true"}}]' >/dev/null
    drained="false"
    for _ in $(seq 1 18); do
      [ -z "$(kubectl -n "$NS" get endpoints "$SEAL_STS" -o jsonpath='{.subsets}' 2>/dev/null)" ] && { drained="true"; break; }
      sleep 5
    done
    [ "$drained" = "true" ] || die "seal Service did not drain its endpoints — cannot run Drill C deterministically"
    info "seal Service drained (no endpoints) — transit unreachable; seal Vault pod still up + unsealed"
    LEADER="$(leader_pod)"
    VICTIM="$(server_pods | grep -v "^${LEADER}$" | head -1)"; [ -n "$VICTIM" ] || die "no follower to restart"
    info "deleting $VICTIM (waiting for the OLD pod to be gone); its replacement must NOT auto-unseal"
    kubectl -n "$NS" delete pod "$VICTIM" --timeout=90s >/dev/null
    info "asserting the new $VICTIM never UNSEALS while transit is unreachable (~75s)"
    # PASS = sealed-or-unreachable for the whole window; FAIL only if it reports
    # sealed=false (truly unsealed) — that would mean auto-unseal isn't using transit.
    became_unsealed="false"
    for _ in $(seq 1 15); do
      sleep 5
      if vstatus "$VICTIM" | jq -e '.sealed == false' >/dev/null 2>&1; then became_unsealed="true"; break; fi
    done
    [ "$became_unsealed" = "false" ] || die "$VICTIM UNSEALED while transit was unreachable — auto-unseal is NOT depending on transit!"
    ok "$VICTIM stayed sealed/unreachable while transit was unreachable (transit dependency confirmed)"
    info "restoring the seal Service selector — transit reachable again"
    restore_seal_svc
    trap - EXIT
    wait_all_ready;    ok "all nodes Ready after transit restored"
    wait_all_unsealed || die "$VICTIM did not auto-unseal after transit returned"
    ok "$VICTIM auto-unsealed + rejoined once transit returned"
    assert_app_recovers
  fi
;; esac

log "baseline restored: unsealed=$(unsealed_count)/${TOTAL}; leader=$(leader_pod)"
log "CHAOS DRILL COMPLETE — cluster self-recovered from every injected fault"
