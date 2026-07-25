#!/usr/bin/env bash
# ============================================================================
# TASK-558 (lane F) — Seed the platform secrets into Vault kv-v2
# ============================================================================
# Writes every `vault-kv` SettingDescriptor's value into
#   <VAULT_KV_MOUNT>/data/<VAULT_KV_PREFIX>/<NAME>   field: value
# which is exactly the path `VaultSecretsProvider.kvPath()` reads and the layout
# `infrastructure/docker/configs/vault/dev-init.sh` already seeds by hand.
#
# THE KEY LIST IS NOT MAINTAINED HERE.
#   It is derived at runtime from PLATFORM_SECRET_SETTINGS in
#   packages/applications/src/services/settings-registry/descriptors/platform-secrets.descriptors.ts,
#   mapped through `toEnvVarName()` (the plan §3.3 mechanical 1:1). A hardcoded
#   list in a shell script is exactly the drift this ticket exists to remove, so
#   if the registry cannot be read this script FAILS — it never falls back to a
#   stale copy.
#
# GUARANTEES
#   * Idempotent      — reads the current value first and SKIPS an identical
#                       one, so a re-run creates no new kv-v2 version. (Version
#                       churn is not cosmetic: API_KEY_PEPPER's keyVersion is
#                       load-bearing for staged rotation.)
#   * Values from env — never from a hardcoded default and never generated.
#   * No secret is printed — output is NAME + status + byte length only. Values
#                       are passed to Vault over stdin, never as an argv (argv is
#                       world-readable in `ps`) and never echoed.
#   * Dev-only unless told otherwise — refuses to run against a Vault whose
#                       storage is not the in-memory dev backend unless
#                       --allow-non-dev is passed. Undeterminable ⇒ treated as
#                       NON-dev (fail closed).
#   * Absent values are SKIPPED, never written as empty. Seeding "" would make
#                       an unconfigured secret look configured; downstream code
#                       fails closed on absence, which is the correct signal.
#
# USAGE
#   ./scripts/vault-seed-secrets.sh --dry-run --env-file .env.dev
#   ./scripts/vault-seed-secrets.sh --env-file .env.dev
#   ./scripts/vault-seed-secrets.sh --allow-non-dev          # host env only
#
#   --dry-run          Report what WOULD happen. Performs reads, no writes.
#   --env-file PATH    Source PATH before reading values. Omit to use host env
#                      only (the correct mode for CI/production, per §9.1 D7).
#   --allow-non-dev    Permit a non-dev Vault. Required for staging/production.
#   --only NAME[,NAME] Restrict to specific secret names (still registry-checked).
#
# REQUIRES
#   * The `vault` CLI on PATH, or the dev container (VAULT_CONTAINER, default
#     `hope-vault`) running — the script picks whichever is available.
#   * VAULT_ADDR + VAULT_TOKEN for a real Vault; the dev container path falls
#     back to the dev root token (VAULT_DEV_ROOT_TOKEN, default `root`).
#   * A built @arcaai/applications:  pnpm --filter @arcaai/applications build
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

DRY_RUN=false
ALLOW_NON_DEV=false
ENV_FILE=""
ONLY=""

CONTAINER="${VAULT_CONTAINER:-hope-vault}"
KV_MOUNT="${VAULT_KV_MOUNT:-secret}"
KV_PREFIX="${VAULT_KV_PREFIX:-hope}"

red()    { printf "\033[31m%s\033[0m\n" "$*" >&2; }
green()  { printf "\033[32m%s\033[0m\n" "$*"; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }
dim()    { printf "\033[2m%s\033[0m\n" "$*"; }

# --- 1. Arguments -----------------------------------------------------------

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)       DRY_RUN=true; shift ;;
    --allow-non-dev) ALLOW_NON_DEV=true; shift ;;
    --env-file)      ENV_FILE="${2:?--env-file needs a path}"; shift 2 ;;
    --only)          ONLY="${2:?--only needs a comma-separated name list}"; shift 2 ;;
    -h|--help)       sed -n '2,55p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *)               red "Unknown argument: $1"; exit 2 ;;
  esac
done

# --- 2. Load values ---------------------------------------------------------
# Sourced, not parsed: an env file is shell syntax and `export -a` is how every
# other script in this repo consumes one. Only done when explicitly asked, so a
# production run can never accidentally pick up a developer's file.

if [ -n "${ENV_FILE}" ]; then
  [ -f "${ENV_FILE}" ] || { red "ERROR: --env-file '${ENV_FILE}' not found."; exit 1; }
  green "-> Sourcing ${ENV_FILE}"
  set -a
  # shellcheck disable=SC1090
  . "${ENV_FILE}"
  set +a
fi

# --- 3. Derive the secret list FROM THE REGISTRY ----------------------------

DESCRIPTORS_JS="${REPO_ROOT}/packages/applications/dist/services/settings-registry/descriptors/platform-secrets.descriptors.js"
TYPES_JS="${REPO_ROOT}/packages/applications/dist/services/settings-registry/registry.types.js"

if [ ! -f "${DESCRIPTORS_JS}" ] || [ ! -f "${TYPES_JS}" ]; then
  red "ERROR: the settings registry is not built, so the secret list cannot be derived."
  echo "This script deliberately has NO hardcoded fallback list — a stale copy is the"
  echo "drift TASK-558 exists to remove. Build it first:"
  echo "  pnpm --filter @arcaai/applications build"
  exit 1
fi

# Emits `<SECRET_NAME>\t<descriptor.key>` per vault-kv descriptor.
SECRET_ROWS="$(node -e '
  const { PLATFORM_SECRET_SETTINGS } = require(process.argv[1]);
  const { toEnvVarName } = require(process.argv[2]);
  const rows = PLATFORM_SECRET_SETTINGS
    .filter((d) => d.tier === "vault-kv")
    .map((d) => `${toEnvVarName(d.key)}\t${d.key}`);
  if (rows.length === 0) { console.error("no vault-kv descriptors registered"); process.exit(1); }
  process.stdout.write(rows.join("\n"));
' "${DESCRIPTORS_JS}" "${TYPES_JS}")"

if [ -n "${ONLY}" ]; then
  # Split on comma inside awk — `-v` cannot carry embedded newlines.
  SECRET_ROWS="$(printf '%s\n' "${SECRET_ROWS}" | awk -F'\t' -v names="${ONLY}" '
    BEGIN { n = split(names, a, ","); for (i = 1; i <= n; i++) keep[a[i]] = 1 }
    keep[$1]
  ')"
  [ -n "${SECRET_ROWS}" ] || { red "ERROR: --only matched no registered vault-kv secret."; exit 1; }
fi

TOTAL="$(printf '%s\n' "${SECRET_ROWS}" | wc -l | tr -d ' ')"

# --- 4. Pick a Vault transport ---------------------------------------------
# A host `vault` binary is preferred (it is the only option for a real Vault);
# the dev container is the fallback because local dev has no host binary.

VAULT_MODE=""
if command -v vault >/dev/null 2>&1; then
  VAULT_MODE="cli"
elif docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "${CONTAINER}"; then
  VAULT_MODE="docker"
  : "${VAULT_TOKEN:=${VAULT_DEV_ROOT_TOKEN:-root}}"
else
  red "ERROR: no way to reach Vault."
  echo "Install the vault CLI, or start the dev container:"
  echo "  pnpm infra:dev:up"
  exit 1
fi

# Runs a vault command. Any stdin is forwarded, so a secret VALUE never appears
# in argv (and therefore never in `ps`, shell history, or a CI job log).
vault_cli() {
  if [ "${VAULT_MODE}" = "cli" ]; then
    vault "$@"
  else
    docker exec -i \
      -e VAULT_ADDR="${VAULT_ADDR:-http://127.0.0.1:8200}" \
      -e VAULT_TOKEN="${VAULT_TOKEN}" \
      "${CONTAINER}" vault "$@"
  fi
}

# --- 5. Dev-mode gate -------------------------------------------------------
# Dev-mode Vault uses the in-memory storage backend; anything else is a real
# Vault holding real credentials. An unreadable status is treated as NON-dev.

STORAGE_TYPE="$(vault_cli status -format=json 2>/dev/null | node -e '
  let raw = "";
  process.stdin.on("data", (c) => (raw += c));
  process.stdin.on("end", () => {
    try { process.stdout.write(String(JSON.parse(raw).storage_type ?? "")); } catch { process.stdout.write(""); }
  });
' || true)"

IS_DEV=false
[ "${STORAGE_TYPE}" = "inmem" ] && IS_DEV=true

if [ "${IS_DEV}" = false ] && [ "${ALLOW_NON_DEV}" = false ]; then
  red "REFUSING TO RUN: this Vault is not a dev-mode instance."
  echo "  VAULT_ADDR   = ${VAULT_ADDR:-<unset>}"
  echo "  storage_type = ${STORAGE_TYPE:-<unreadable — treated as non-dev>}"
  echo ""
  echo "Seeding a real Vault overwrites production credential material. If that is"
  echo "genuinely what you intend, re-run with --allow-non-dev (and --dry-run first)."
  exit 1
fi

# --- 6. Report the plan -----------------------------------------------------

green "-> Vault kv-v2 seeding"
echo   "     transport   : ${VAULT_MODE}$([ "${VAULT_MODE}" = docker ] && echo " (${CONTAINER})")"
echo   "     path        : ${KV_MOUNT}/data/${KV_PREFIX}/<NAME>"
echo   "     instance    : $([ "${IS_DEV}" = true ] && echo "dev (storage=inmem)" || echo "NON-DEV (storage=${STORAGE_TYPE:-unknown}) — allowed by flag")"
echo   "     secrets     : ${TOTAL} (from the settings registry)"
echo   "     mode        : $([ "${DRY_RUN}" = true ] && echo "DRY RUN — no writes" || echo "APPLY")"
echo ""

WROTE=0; UNCHANGED=0; SKIPPED=0; WOULD_WRITE=0

# --- 7. Seed ----------------------------------------------------------------

while IFS="$(printf '\t')" read -r NAME REGISTRY_KEY; do
  [ -n "${NAME}" ] || continue

  # Indirect expansion: the descriptor's env name IS the variable name.
  VALUE="${!NAME-}"

  if [ -z "${VALUE}" ]; then
    printf '  %-38s %s\n' "${NAME}" "SKIP      (not set in environment)"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  BYTES="${#VALUE}"

  # Idempotence: compare before writing so an unchanged secret creates no new
  # kv-v2 version. A missing path simply yields an empty read.
  CURRENT="$(vault_cli kv get -mount="${KV_MOUNT}" -field=value "${KV_PREFIX}/${NAME}" 2>/dev/null || true)"

  if [ "${CURRENT}" = "${VALUE}" ]; then
    printf '  %-38s %s\n' "${NAME}" "unchanged (len=${BYTES})"
    UNCHANGED=$((UNCHANGED + 1))
    continue
  fi

  ACTION="write"
  [ -n "${CURRENT}" ] && ACTION="update"

  if [ "${DRY_RUN}" = true ]; then
    printf '  %-38s %s\n' "${NAME}" "WOULD ${ACTION} (len=${BYTES})  <- ${REGISTRY_KEY}"
    WOULD_WRITE=$((WOULD_WRITE + 1))
    continue
  fi

  # `value=-` reads the field from stdin: the secret never reaches argv.
  printf '%s' "${VALUE}" | vault_cli kv put -mount="${KV_MOUNT}" "${KV_PREFIX}/${NAME}" value=- >/dev/null
  printf '  %-38s %s\n' "${NAME}" "${ACTION}     (len=${BYTES})"
  WROTE=$((WROTE + 1))
done <<< "${SECRET_ROWS}"

# --- 8. Summary -------------------------------------------------------------

echo ""
if [ "${DRY_RUN}" = true ]; then
  green "[DRY RUN] ${WOULD_WRITE} would be written · ${UNCHANGED} already current · ${SKIPPED} not set in environment"
  dim   "          Re-run without --dry-run to apply."
else
  green "[OK] ${WROTE} written · ${UNCHANGED} already current · ${SKIPPED} not set in environment"
fi

if [ "${SKIPPED}" -gt 0 ]; then
  echo ""
  yellow "NOTE: skipped secrets were left ABSENT, not written as empty strings."
  yellow "      Every one is failMode 'closed', so its consumer fails closed on absence —"
  yellow "      which is the correct, visible signal. Set the variable and re-run."
fi
