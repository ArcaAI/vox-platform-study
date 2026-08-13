#!/usr/bin/env bash
# =============================================================================
# Assert the Vault Agent injection contract on a set of rendered manifests.
# =============================================================================
# Usage:
#   deployment/vault-agent/check-contract.sh                    # the reference manifest
#   kubectl kustomize <dir> | deployment/vault-agent/check-contract.sh -
#   helm template <chart> | deployment/vault-agent/check-contract.sh -
#
# Point it at the hope-deployments render too — the contract is the same
# wherever the manifests are authored.
#
# Checks, per pod template that has `vault.hashicorp.com/agent-inject: true`:
#   1. Every `agent-inject-secret-<X>` has a matching `agent-inject-template-<X>`
#      (an unmatched pair renders Vault's default JSON blob, not a bare value).
#   2. <X> is a valid environment-variable name — the file the agent writes IS
#      the env var name, which is the whole `packages/py-env` contract.
#   3. The template emits `.Data.data.value` with `{{-`/`-}}` trimming, so no
#      trailing newline ends up inside a service token.
#   4. The kv path is `<mount>/data/<prefix>/<X>` and its last segment equals
#      <X> — the layout dev-init.sh and vault-seed-secrets.sh both use.
#   5. `HOPE_SECRETS_DIR` (if set) equals `secret-volume-path` (or its default).
#   6. No `envFrom: secretRef:` — materialized k8s Secrets are rejected for PHI.
#   7. `agent-run-as-user` is set (the injector's default 100 cannot be read by
#      the app's uid 1001, and the failure looks like an empty secret).
# =============================================================================
set -euo pipefail

SRC="${1:-}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -z "${SRC}" ]; then
  MANIFEST="$(kubectl kustomize "${HERE}")"
elif [ "${SRC}" = "-" ]; then
  MANIFEST="$(cat)"
else
  MANIFEST="$(cat "${SRC}")"
fi

command -v yq >/dev/null 2>&1 || {
  echo "ERROR: yq is required (brew install yq)." >&2
  exit 2
}

FAIL=0
CHECKED=0
fail() {
  printf 'FAIL  %s\n' "$*" >&2
  FAIL=$((FAIL + 1))
}
pass() { printf 'ok    %s\n' "$*"; }

# One line per (deployment, annotation-key, annotation-value).
# shellcheck disable=SC2016  # $name/$vol are yq variables, not shell expansions
ANNOTATIONS="$(printf '%s' "${MANIFEST}" | yq eval-all '
  select(.kind == "Deployment")
  | .metadata.name as $name
  | .spec.template.metadata.annotations // {}
  | to_entries
  | .[]
  | $name + "|" + .key + "|" + (.value | sub("\n$"; ""))
' - 2>/dev/null || true)"

if [ -z "${ANNOTATIONS}" ]; then
  echo "No Deployment annotations found — nothing to check." >&2
  exit 1
fi

# ── 1-4. secret/template pairing, naming, trimming, kv layout ───────────────
while IFS='|' read -r DEPLOY KEY VALUE; do
  case "${KEY}" in
    vault.hashicorp.com/agent-inject-secret-*) ;;
    *) continue ;;
  esac
  NAME="${KEY#vault.hashicorp.com/agent-inject-secret-}"
  CHECKED=$((CHECKED + 1))

  case "${NAME}" in
    [A-Z] | [A-Z][A-Z0-9_]*) ;;
    *) fail "${DEPLOY}: '${NAME}' is not a valid env var name; the rendered FILENAME is the env var name." ;;
  esac

  TPL="$(printf '%s\n' "${ANNOTATIONS}" | awk -F'|' -v d="${DEPLOY}" \
    -v k="vault.hashicorp.com/agent-inject-template-${NAME}" '$1==d && $2==k {print $3}')"

  if [ -z "${TPL}" ]; then
    fail "${DEPLOY}/${NAME}: no agent-inject-template-${NAME}; Vault would render its default JSON, not the bare value."
  else
    case "${TPL}" in
      *".Data.data.value"*) ;;
      *) fail "${DEPLOY}/${NAME}: template does not read .Data.data.value (kv-v2 'value' field)." ;;
    esac
    case "${TPL}" in
      "{{- with"*"-}}") ;;
      *) fail "${DEPLOY}/${NAME}: template is not whitespace-trimmed ({{- ... -}}); a trailing newline would corrupt the secret." ;;
    esac
  fi

  LAST_SEGMENT="${VALUE##*/}"
  if [ "${LAST_SEGMENT}" != "${NAME}" ]; then
    fail "${DEPLOY}/${NAME}: kv path '${VALUE}' does not end in '${NAME}'."
  fi
  case "${VALUE}" in
    */data/*) ;;
    *) fail "${DEPLOY}/${NAME}: kv path '${VALUE}' is missing the kv-v2 '/data/' segment." ;;
  esac
done <<EOF
${ANNOTATIONS}
EOF

# ── 5. HOPE_SECRETS_DIR agrees with secret-volume-path ──────────────────────
# shellcheck disable=SC2016  # $n/$vol/$dirs are yq variables, not shell expansions
printf '%s' "${MANIFEST}" | yq eval-all '
  select(.kind == "Deployment")
  | .metadata.name as $n
  | ((.spec.template.metadata.annotations."vault.hashicorp.com/secret-volume-path") // "/vault/secrets") as $vol
  | [.spec.template.spec.containers[].env[]? | select(.name == "HOPE_SECRETS_DIR") | .value] as $dirs
  | $n + " " + $vol + " " + ($dirs | join(","))
' - | while read -r N VOL DIRS; do
  if [ -n "${DIRS:-}" ] && [ "${DIRS}" != "${VOL}" ]; then
    echo "FAIL  ${N}: HOPE_SECRETS_DIR='${DIRS}' != secret-volume-path='${VOL}'" >&2
    exit 1
  fi
  echo "ok    ${N}: HOPE_SECRETS_DIR agrees with secret-volume-path (${VOL})"
done || FAIL=$((FAIL + 1))

# ── 6. no materialized Secret objects ──────────────────────────────────────
if printf '%s' "${MANIFEST}" | yq eval-all '
  select(.kind == "Deployment") | .spec.template.spec.containers[].envFrom[]?.secretRef.name // ""
' - | grep -q '[^[:space:]]'; then
  fail "a container uses envFrom.secretRef — materialized k8s Secrets are rejected by §9.2 L7 for PHI."
else
  pass "no envFrom.secretRef (secrets are injected, not materialized into etcd)"
fi

# ── 7. agent runs as the application uid ───────────────────────────────────
if printf '%s\n' "${ANNOTATIONS}" | grep -q 'vault.hashicorp.com/agent-run-as-user'; then
  pass "agent-run-as-user is set (injector default 100 is unreadable by the app's uid 1001)"
else
  fail "agent-run-as-user is not set; rendered files would be owned by uid 100 and unreadable by the app."
fi

echo
echo "${CHECKED} injected secret(s) checked; ${FAIL} failure(s)."
[ "${FAIL}" -eq 0 ]
