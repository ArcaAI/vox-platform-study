#!/bin/sh
# =============================================================================
# TASK-558 lane K (K1) — GitLab OIDC → Vault JWT auth, CE/Free form.
# =============================================================================
# Exchanges the job-scoped GitLab ID token ($VAULT_ID_TOKEN, minted by the
# `id_tokens:` keyword) for a short-lived Vault token, reads the kv-v2 paths
# named in $VAULT_SECRETS, and prints `export NAME='value'` lines on stdout.
#
# WHY A SCRIPT AND NOT THE `secrets:` KEYWORD
#   GitLab's native `secrets:` + `vault:` keyword is Premium/Ultimate only.
#   This instance (https://git.taphuynh.dev, project arca/hope-v2) is Free —
#   verified 2026-07-26 with the project CI lint endpoint: a config carrying
#   `secrets:` returns
#       "jobs:tier-probe config contains unknown keys: secrets"
#   while the same config with only `id_tokens:` lints valid. `id_tokens` has
#   been Free-tier since GitLab 15.7, so the OIDC half works everywhere and
#   only the login/read half has to be a shell command. If this project is ever
#   upgraded to Premium, this script is replaceable by `secrets:` one job at a
#   time — the Vault-side roles and policies are identical either way.
#
# CONTRACT
#   Input  (job variables)
#     VAULT_ADDR      Vault base URL. EMPTY (the default) = feature disabled;
#                     the script no-ops and the job keeps using its CI
#                     variables exactly as before. This is what keeps every
#                     existing pipeline green before Vault is wired up.
#     VAULT_AUTH_ROLE Vault JWT role name (default: derived, see below).
#     VAULT_AUTH_PATH JWT auth mount path (default: jwt-gitlab).
#     VAULT_KV_MOUNT  kv-v2 mount (default: secret) — same default as
#                     scripts/vault-seed-secrets.sh and the app runtime.
#     VAULT_SECRETS   Space-separated `<kv-path>=<ENV_NAME>` pairs, e.g.
#                       "ci/DATABASE_URL=DATABASE_URL ci/REDIS_PASS=REDIS_PASS"
#                     The kv-v2 field is always `value`, matching
#                     infrastructure/docker/configs/vault/dev-init.sh and
#                     VaultSecretsProvider.kvPath(). Empty = nothing to do.
#     VAULT_ID_TOKEN  Injected by GitLab from the job's `id_tokens:` block.
#
#   Output (stdout)  `export NAME='...'` lines, for `eval` by the caller.
#   Output (stderr)  Diagnostics. NAMES ONLY — never a value, never a length
#                    that could be a Hamming oracle, never the Vault token.
#
# SECURITY NOTES
#   * Values fetched at runtime are NOT masked by GitLab (masking only applies
#     to variables defined in project settings). Nothing here echoes a value,
#     and callers must not `set -x` around the eval.
#   * The Vault token is revoked before the script returns, so it cannot outlive
#     the fetch even though its TTL would allow it.
#   * No long-lived VAULT_TOKEN is stored in project settings. The only CI
#     variable this design needs is the non-secret VAULT_ADDR.
# =============================================================================

set -eu

: "${VAULT_ADDR:=}"
: "${VAULT_SECRETS:=}"
: "${VAULT_AUTH_PATH:=jwt-gitlab}"
: "${VAULT_KV_MOUNT:=secret}"
: "${VAULT_ID_TOKEN:=}"

log() { printf '[vault] %s\n' "$*" >&2; }

# --- 0. Opt-in gate ---------------------------------------------------------
# Both halves must be present. Either missing is the "not wired up yet" state,
# which is a silent no-op so the job falls through to its CI variables.

if [ -z "${VAULT_SECRETS}" ]; then
  exit 0
fi

if [ -z "${VAULT_ADDR}" ]; then
  log "VAULT_ADDR is empty — skipping Vault fetch, job uses its CI variables."
  exit 0
fi

if [ -z "${VAULT_ID_TOKEN}" ]; then
  log "ERROR: VAULT_ADDR is set but VAULT_ID_TOKEN is absent."
  log "       The job needs an \`id_tokens:\` block (see .gitlab/ci/vault.yml)."
  exit 1
fi

# Default role: one per environment class. Protected refs (staging, tags) get
# the deploy role; everything else gets the read-only CI role. Vault's
# bound_claims are the real boundary — this is only the client-side default.
if [ -z "${VAULT_AUTH_ROLE:-}" ]; then
  case "${CI_COMMIT_BRANCH:-}${CI_COMMIT_TAG:-}" in
    staging | v*) VAULT_AUTH_ROLE="hope-ci-deploy" ;;
    *) VAULT_AUTH_ROLE="hope-ci" ;;
  esac
fi

# --- 1. Transport + JSON field extraction -----------------------------------
# The job images differ (node:22-alpine, python:3.11-slim, alpine:3.20+curl),
# so pick whichever HTTP client and JSON reader the image actually has rather
# than adding a package install to every job's critical path.

# `python:3.11-slim` (test-stt / test-smr / test-nlp / …) ships NEITHER curl nor
# wget, so python3 is a first-class transport here, not a curiosity.
if command -v curl >/dev/null 2>&1; then
  HTTP=curl
elif command -v wget >/dev/null 2>&1; then
  HTTP=wget
elif command -v python3 >/dev/null 2>&1; then
  HTTP=python3
else
  log "ERROR: no HTTP client available (need one of: curl, wget, python3)."
  exit 1
fi

if command -v jq >/dev/null 2>&1; then
  JSON=jq
elif command -v node >/dev/null 2>&1; then
  JSON=node
elif command -v python3 >/dev/null 2>&1; then
  JSON=python3
else
  log "ERROR: no JSON reader available (need one of: jq, node, python3)."
  exit 1
fi

log "auth=${VAULT_AUTH_PATH} role=${VAULT_AUTH_ROLE} http=${HTTP} json=${JSON}"

# py_http <url> <method> <body-or-empty> <token-or-empty> — stdlib only.
# Prints the response body and exits 0 even on 4xx/5xx: callers detect failure
# by the absent field, and Vault's error body is what makes the log actionable.
py_http() {
  python3 -c '
import sys, urllib.request, urllib.error
url, method, body, token = sys.argv[1:5]
data = body.encode() if body else (b"" if method == "POST" else None)
req = urllib.request.Request(url, data=data, method=method)
if token:
    req.add_header("X-Vault-Token", token)
if data is not None:
    req.add_header("Content-Type", "application/json")
try:
    with urllib.request.urlopen(req, timeout=20) as r:
        sys.stdout.write(r.read().decode("utf-8", "replace"))
except urllib.error.HTTPError as e:
    sys.stdout.write(e.read().decode("utf-8", "replace"))
except Exception as e:
    sys.stderr.write(f"[vault] transport error: {e}\n")
' "$1" "$2" "$3" "$4"
}

# http_post <url> <json-body>  / http_get <url> <vault-token>
http_post() {
  case "${HTTP}" in
    curl) curl -sS --max-time 20 -X POST -d "$2" "$1" ;;
    wget) wget -q -O - --timeout=20 --post-data="$2" "$1" ;;
    python3) py_http "$1" POST "$2" "" ;;
  esac
}

http_get() {
  case "${HTTP}" in
    curl) curl -sS --max-time 20 -H "X-Vault-Token: $2" "$1" ;;
    wget) wget -q -O - --timeout=20 --header="X-Vault-Token: $2" "$1" ;;
    python3) py_http "$1" GET "" "$2" ;;
  esac
}

# json_field <dotted.path> — reads JSON on stdin, prints the string or nothing.
json_field() {
  case "${JSON}" in
    jq) jq -r "$1 // empty" ;;
    node) node -e '
      let raw = "";
      process.stdin.on("data", (c) => (raw += c));
      process.stdin.on("end", () => {
        let v;
        try { v = JSON.parse(raw); } catch { process.exit(0); }
        for (const seg of process.argv[1].replace(/^\./, "").split(".")) {
          if (v == null) break;
          v = v[seg];
        }
        if (typeof v === "string") process.stdout.write(v);
      });
    ' "$1" ;;
    python3) python3 -c '
import json, sys
try:
    v = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for seg in sys.argv[1].lstrip(".").split("."):
    if v is None:
        break
    v = v.get(seg) if isinstance(v, dict) else None
if isinstance(v, str):
    sys.stdout.write(v)
' "$1" ;;
  esac
}

# --- 2. Login ---------------------------------------------------------------
# The ID token is passed in the request BODY, not the URL, so it never reaches
# a proxy access log.

LOGIN_BODY="$(printf '{"role":"%s","jwt":"%s"}' "${VAULT_AUTH_ROLE}" "${VAULT_ID_TOKEN}")"
LOGIN_RESPONSE="$(http_post "${VAULT_ADDR}/v1/auth/${VAULT_AUTH_PATH}/login" "${LOGIN_BODY}" || true)"
VAULT_CI_TOKEN="$(printf '%s' "${LOGIN_RESPONSE}" | json_field '.auth.client_token')"

if [ -z "${VAULT_CI_TOKEN}" ]; then
  log "ERROR: JWT login failed at ${VAULT_ADDR}/v1/auth/${VAULT_AUTH_PATH}/login"
  log "       role=${VAULT_AUTH_ROLE}"
  log "       Vault error: $(printf '%s' "${LOGIN_RESPONSE}" | tr -d '\n' | cut -c1-300)"
  log "       Check the role's bound_claims against this job's claims:"
  log "         project_path=${CI_PROJECT_PATH:-?} ref=${CI_COMMIT_REF_NAME:-?}"
  log "         ref_protected=${CI_COMMIT_REF_PROTECTED:-?}"
  exit 1
fi

# Revoke on the way out no matter how we leave. The read loop below is the only
# thing this token is ever needed for.
# revoke-self needs the token header, which http_post does not send, so it is
# spelled out here rather than reusing that helper.
cleanup() {
  case "${HTTP}" in
    curl)
      curl -sS --max-time 10 -X POST -H "X-Vault-Token: ${VAULT_CI_TOKEN}" \
        "${VAULT_ADDR}/v1/auth/token/revoke-self" >/dev/null 2>&1 || true
      ;;
    wget)
      wget -q -O - --timeout=10 --post-data="" \
        --header="X-Vault-Token: ${VAULT_CI_TOKEN}" \
        "${VAULT_ADDR}/v1/auth/token/revoke-self" >/dev/null 2>&1 || true
      ;;
    python3)
      py_http "${VAULT_ADDR}/v1/auth/token/revoke-self" POST "" "${VAULT_CI_TOKEN}" \
        >/dev/null 2>&1 || true
      ;;
  esac
}
trap cleanup EXIT

# --- 3. Read each requested secret ------------------------------------------

FETCHED=0
for PAIR in ${VAULT_SECRETS}; do
  KV_PATH="${PAIR%%=*}"
  ENV_NAME="${PAIR#*=}"

  if [ "${KV_PATH}" = "${PAIR}" ] || [ -z "${ENV_NAME}" ]; then
    log "ERROR: malformed VAULT_SECRETS entry '${PAIR}' (want <kv-path>=<ENV_NAME>)."
    exit 1
  fi

  READ_RESPONSE="$(http_get "${VAULT_ADDR}/v1/${VAULT_KV_MOUNT}/data/${KV_PATH}" "${VAULT_CI_TOKEN}" || true)"
  VALUE="$(printf '%s' "${READ_RESPONSE}" | json_field '.data.data.value')"

  if [ -z "${VALUE}" ]; then
    log "ERROR: ${VAULT_KV_MOUNT}/data/${KV_PATH} returned no 'value' field."
    log "       Either the path is unseeded or role ${VAULT_AUTH_ROLE} cannot read it."
    exit 1
  fi

  # Single-quote the value and escape any embedded single quote, so a password
  # containing $ ` " \ or a newline survives `eval` byte-for-byte.
  ESCAPED="$(printf '%s' "${VALUE}" | sed "s/'/'\\\\''/g")"
  printf "export %s='%s'\n" "${ENV_NAME}" "${ESCAPED}"
  FETCHED=$((FETCHED + 1))
  log "  ${ENV_NAME} <- ${VAULT_KV_MOUNT}/${KV_PATH}"
done

log "${FETCHED} secret(s) exported from Vault; CI variables not used for these."
