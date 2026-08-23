#!/usr/bin/env bash
# ============================================================================
# generate-prod-secrets.sh — generate the platform secrets for a PRODUCTION
# deploy and emit a Vault-seed handoff bundle.
# ============================================================================
# WHY THIS EXISTS
#   Production reads NO env file (NODE_ENV=production loads nothing) and runs
#   SECRETS_PROVIDER=vault: every service — the gateway AND all six Python
#   services — resolves its secrets from Vault kv-v2 at `secret/data/hope/<NAME>`
#   via Vault Agent injection (deployment/vault-agent/README.md). There is ONE
#   canonical location per secret, so seeding one generated value per secret
#   makes every consumer that needs it read the identical value — the
#   service-to-service token hops (X-Service-Token, X-Internal-Service-Key) line
#   up BY CONSTRUCTION.
#
#   scripts/vault-seed-secrets.sh already pushes env -> Vault (its key list is
#   derived from the settings registry), but it deliberately NEVER invents a
#   value. This script fills that gap: it GENERATES the safely-synthesizable
#   platform secrets, then hands them to that seeder.
#
# WHAT IT GENERATES  (safely synthesizable — HOPE owns both ends)
#   HMAC signing keys, hash peppers, and the inter-service tokens. Every name
#   below is a `vault-kv` descriptor in the settings registry and appears in the
#   per-service table of deployment/vault-agent/README.md.
#
# WHAT IT DOES NOT GENERATE  (operator-supplied pass-throughs)
#   * External provider keys (Azure / OpenAI / Anthropic / Sarvam / vLLM / OIDC)
#     — real third-party credentials; no value can be synthesized.
#   * Object-store / Redis / MQTT credentials — these must MATCH the systems the
#     operator provisioned; a random value would only be right if this script
#     also stood up that infrastructure, which it does not.
#   * The database password — there is none to seed: production uses Vault's
#     DYNAMIC database engine (PG_DYNAMIC_CREDS=true), minting a short-lived user
#     per connection. See apps/api/.env.prod and docs/operations/vault/README.md.
#   A pass-through that IS present in the environment when this runs is folded
#   into the bundle (so one seed run covers everything you prepared); one that is
#   absent is reported as TODO and left unseeded (its consumer fails closed —
#   the correct, visible signal).
#
# OUTPUT
#   A chmod-600, gitignored KEY='value' file (default .env.prod.secrets) that
#   scripts/vault-seed-secrets.sh consumes via --env-file. The file is real
#   credential material for a handoff — seed it, verify, then delete it. It must
#   NEVER be committed (.gitignore blocks .env.prod.secrets / .env.*.secrets).
#
# WHY THIS SCRIPT DOES NOT LOOK LIKE dev-setup.sh / test-setup.sh
#   Those two run a full local bootstrap: create env file -> start infra ->
#   wait for it -> migrate + seed -> refresh Vault AppRole creds -> bootstrap
#   Vault dynamic DB creds -> finalize (reconcile Vault kv with the env file).
#   A production deploy is NOT a bigger version of that sequence run from a
#   laptop — each step is owned by a different, already-existing system, and
#   pretending otherwise here would mean this script silently gains the power
#   to touch production infra/DB, which is exactly the blast radius `01-development-workflow.md`
#   and `09-infrastructure-devops.md` keep out of ad hoc scripts:
#     * infra + wait-ready      -> the k3s cluster itself (deployment/, ArgoCD-managed)
#     * migrate + seed          -> the `db-migrate` Job, an ArgoCD PreSync hook
#     * Vault AppRole creds     -> Vault Agent / Vault Secrets Operator injection
#                                  per pod (response-WRAPPED, single-use — never
#                                  minted by a script talking to a shared container)
#     * Vault dynamic DB creds  -> the SAME Vault database secrets engine dev
#                                  uses, but configured against the real HA
#                                  Postgres cluster by the operator, not this script
#   This script's actual job is exactly ONE step of that shape — "finalize the
#   env" — for the ONE part that's safe to run from outside the cluster:
#   generating the secrets HOPE can synthesize and seeding them into Vault
#   kv-v2 (--seed, i.e. vault-seed-secrets.sh --allow-non-dev). Everything
#   upstream of that is a cluster operation; see deployment/README.md and
#   docs/operations/vault/README.md, not this script.
#
# USAGE
#   ./scripts/generate-prod-secrets.sh                 # write ./.env.prod.secrets
#   ./scripts/generate-prod-secrets.sh --out /secure/hope-prod.secrets
#   ./scripts/generate-prod-secrets.sh --force         # regenerate (see WARNING)
#   ./scripts/generate-prod-secrets.sh --seed --dry-run   # generate + preview seed
#   ./scripts/generate-prod-secrets.sh --seed          # generate + seed prod Vault
#
#   --out PATH        Output bundle path (default ./.env.prod.secrets).
#   --force           Overwrite an existing bundle (ROTATION WARNING below).
#   --seed            After writing, run vault-seed-secrets.sh --env-file <out>
#                     --allow-non-dev against the Vault in your environment
#                     (needs VAULT_ADDR/VAULT_TOKEN + a built @arcaai/applications).
#   --dry-run         Only meaningful with --seed: pass --dry-run to the seeder.
#
# ROTATION WARNING
#   Re-generating is a credential ROTATION, not a cosmetic refresh:
#     * API_KEY_PEPPER      — invalidates EVERY issued API key the instant it changes.
#     * STORAGE_ACCESS_KEY_PEPPER — invalidates every stored storage access key.
#     * JWT_SECRET_KEY / SESSION_SECRET_KEY — invalidates live tokens / sessions.
#     * service tokens      — every service must be re-seeded and rolled together.
#   --force exists so this is always deliberate. Stage rotations; never surprise them.
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

red()    { printf "\033[31m%s\033[0m\n" "$*" >&2; }
green()  { printf "\033[32m%s\033[0m\n" "$*"; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }
bold()   { printf "\033[1m%s\033[0m\n" "$*"; }
dim()    { printf "\033[2m%s\033[0m\n" "$*"; }

OUT_FILE="$REPO_ROOT/.env.prod.secrets"
FORCE=false
SEED=false
DRY_RUN=false

while [ $# -gt 0 ]; do
  case "$1" in
    --out)     OUT_FILE="${2:?--out needs a path}"; shift 2 ;;
    --force)   FORCE=true; shift ;;
    --seed)    SEED=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    -h|--help) sed -n '2,74p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *)         red "Unknown argument: $1"; exit 2 ;;
  esac
done

# A URL-safe random hex secret (32 bytes -> 64 hex chars). openssl everywhere;
# /dev/urandom fallback keeps it working without it.
_rand_hex() {
  local n="${1:-32}"
  openssl rand -hex "$n" 2>/dev/null || head -c "$n" /dev/urandom | od -An -tx1 | tr -d ' \n'
}

# Single-quote a value so the bundle is safely shell-sourceable (the seeder does
# `set -a; . file`). Embedded single quotes become '\'' .
_shq() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

# Platform secrets to GENERATE. Every name is a vault-kv registry descriptor and
# is in deployment/vault-agent/README.md's per-service table.
GENERATE_KEYS=(
  JWT_SECRET_KEY
  SESSION_SECRET_KEY
  API_KEY_PEPPER
  STORAGE_ACCESS_KEY_PEPPER
  TEXT_SERVICE_TOKEN
  NLP_SERVICE_TOKEN
  GUARDRAIL_SERVICE_TOKEN
  HARNESS_SERVICE_TOKEN
  TTS_SERVICE_TOKEN
  HARNESS_INTERNAL_SERVICE_TOKEN
  API_GATEWAY_KEY
)

# Operator-supplied pass-throughs — folded in only if already in the environment.
PASSTHROUGH_KEYS=(
  OIDC_CLIENT_SECRET
  AZURE_FOUNDRY_API_KEY HARNESS_JUDGE_OPENAI_COMPAT_API_KEY
  AZURE_STORAGE_CONNECTION_STRING AZURE_STORAGE_ACCOUNT_KEY
  REDIS_PASS MQTT_PASS
  MINIO_ACCESS_KEY MINIO_SECRET_KEY S3_ACCESS_KEY S3_SECRET_KEY
  HARNESS_CLAIM_CHECK_ACCESS_KEY HARNESS_CLAIM_CHECK_SECRET_KEY
  STORAGE_PLATFORM_DEFAULT_CREDENTIALS
)

if [ -e "$OUT_FILE" ] && [ "$FORCE" != true ]; then
  red "REFUSING TO OVERWRITE: $OUT_FILE already exists."
  echo "Regenerating rotates every secret (see the ROTATION WARNING: --help)."
  echo "Re-run with --force if that is genuinely what you intend."
  exit 1
fi

bold "── Generating production platform secrets ───────────────────────────"

# Restrictive perms from the first byte — never a window where the file is 644.
umask 077
tmp="$(mktemp "${OUT_FILE}.XXXXXX")"
trap 'rm -f "$tmp"' EXIT

{
  echo "# ============================================================================"
  echo "# HOPE production secret bundle — GENERATED, DO NOT COMMIT, DELETE AFTER SEEDING"
  echo "# ============================================================================"
  echo "# Handoff for: scripts/vault-seed-secrets.sh --env-file <this> --allow-non-dev"
  echo "# Generated platform secrets + any operator pass-throughs present at run time."
  echo "# Every value is real credential material. chmod 600; shred once seeded."
  echo "#"
  echo "# NOTE: the DB password is NOT here — production mints it via Vault's dynamic"
  echo "#       database engine (PG_DYNAMIC_CREDS=true). Non-secret coordinates live in"
  echo "#       each app's host env (apps/*/.env.prod), not in this bundle."
  echo ""
  echo "# ── Generated platform secrets ────────────────────────────────────────────"
} >"$tmp"

for k in "${GENERATE_KEYS[@]}"; do
  # Honor an operator-provided value (pass-through / re-seed), else generate.
  existing="${!k-}"
  if [ -n "$existing" ]; then
    printf '%s=%s\n' "$k" "$(_shq "$existing")" >>"$tmp"
    printf '  %-34s %s\n' "$k" "kept (from environment)"
  else
    printf '%s=%s\n' "$k" "$(_shq "$(_rand_hex 32)")" >>"$tmp"
    printf '  %-34s %s\n' "$k" "generated"
  fi
done

printf '\n# ── Operator pass-throughs (only those set in the environment) ─────────────\n' >>"$tmp"
present=0
missing=()
for k in "${PASSTHROUGH_KEYS[@]}"; do
  val="${!k-}"
  if [ -n "$val" ]; then
    printf '%s=%s\n' "$k" "$(_shq "$val")" >>"$tmp"
    printf '  %-34s %s\n' "$k" "included (from environment)"
    present=$((present + 1))
  else
    missing+=("$k")
  fi
done

mv "$tmp" "$OUT_FILE"
trap - EXIT
chmod 600 "$OUT_FILE"

echo ""
green "✔ Wrote $OUT_FILE  (chmod 600)"
green "  ${#GENERATE_KEYS[@]} platform secrets · ${present} operator pass-throughs folded in"

if [ "${#missing[@]}" -gt 0 ]; then
  echo ""
  yellow "Pass-throughs NOT in this bundle (supply real values before/at seed time,"
  yellow "or leave unset to keep that provider/integration off — consumers fail closed):"
  printf '     %s\n' "${missing[@]}" >&2
  dim   "   e.g.  OIDC_CLIENT_SECRET=… REDIS_PASS=… ./scripts/generate-prod-secrets.sh --force"
fi

echo ""
bold "Next — seed production Vault kv-v2:"
echo "   VAULT_ADDR=https://vault.internal:8200 VAULT_TOKEN=… \\"
echo "     pnpm --filter @arcaai/applications build   # registry drives the seed key list"
echo "   ./scripts/vault-seed-secrets.sh --env-file $(printf '%q' "$OUT_FILE") --allow-non-dev --dry-run"
echo "   ./scripts/vault-seed-secrets.sh --env-file $(printf '%q' "$OUT_FILE") --allow-non-dev"
dim   "Then verify the app boots and SHRED the bundle:  shred -u $(printf '%q' "$OUT_FILE")"

if [ "$SEED" = true ]; then
  echo ""
  bold "── --seed: invoking vault-seed-secrets.sh ───────────────────────────"
  seed_args=(--env-file "$OUT_FILE" --allow-non-dev)
  [ "$DRY_RUN" = true ] && seed_args+=(--dry-run)
  "$SCRIPT_DIR/vault-seed-secrets.sh" "${seed_args[@]}"
fi
