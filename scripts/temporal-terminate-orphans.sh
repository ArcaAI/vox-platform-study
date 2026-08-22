#!/usr/bin/env bash
# Terminate every RUNNING Temporal workflow in the dev namespace.
#
# WHY: Temporal keeps its history in its OWN databases inside hope-postgres
# (`temporal` / `temporal_visibility`, see docker-compose.dev.yml), which
# `pnpm db:all --force-reset` does NOT touch — it only resets `hope`. So after a
# DB reset every workflow that was still open keeps running against rows that no
# longer exist, and the Temporal worker floods the logs with retries it can never
# satisfy:
#
#   ConsultationLoopWorkflow -> fetch_loop_config -> apps/api /loop-config
#   HarnessDocWorkflow       -> fetch_policy / assemble_prompt -> 404s forever
#
# A reset of `hope` therefore invalidates EVERY open workflow, not just certain
# types — so this terminates all of them rather than carrying a workflow-type
# allowlist that would silently miss whatever gets added next.
#
# DEV ONLY. It refuses to run when NODE_ENV=production.
#
# Usage:
#   ./scripts/temporal-terminate-orphans.sh [--dry-run] [--reason "..."]
#
# Run it directly, not via the pnpm alias, when passing flags: `pnpm <alias> --
# --dry-run` swallows the `--` (the same root-package gotcha as `pnpm test:e2e`).
set -euo pipefail

NAMESPACE="${TEMPORAL_NAMESPACE:-default}"
NETWORK="${DOCKER_NETWORK:-hope-network}"
ADMINTOOLS_IMAGE="temporalio/admin-tools:${TEMPORAL_ADMINTOOLS_VERSION:-1.31.2}"
TEMPORAL_CONTAINER="${TEMPORAL_CONTAINER:-hope-temporal}"
ADDRESS="temporal:7233"

DRY_RUN=0
REASON="orphaned by local dev DB reset"
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --reason)  REASON="${2:?--reason needs a value}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ "${NODE_ENV:-development}" = "production" ]; then
  echo "REFUSING: this script terminates running workflows and is dev-only." >&2
  exit 1
fi

# The `temporal` profile is optional (pnpm infra:dev:up:all runs without it), and
# the server image ships no `temporal` CLI — the admin-tools image does. Both
# absences are a no-op, not an error.
if ! docker ps --format '{{.Names}}' | grep -qx "$TEMPORAL_CONTAINER"; then
  echo "Temporal not running (${TEMPORAL_CONTAINER}); nothing to terminate."
  exit 0
fi

temporal_cli() {
  docker run --rm --network "$NETWORK" "$ADMINTOOLS_IMAGE" \
    temporal "$@" --address "$ADDRESS" --namespace "$NAMESPACE"
}

QUERY='ExecutionStatus="Running"'

running="$(temporal_cli workflow count --query "$QUERY" 2>/dev/null | awk '/^Total:/ {print $2}')"
running="${running:-0}"

if [ "$running" -eq 0 ]; then
  echo "No running workflows in namespace '${NAMESPACE}'; nothing to terminate."
  exit 0
fi

echo "Found ${running} running workflow(s) in namespace '${NAMESPACE}':"
temporal_cli workflow list --query "$QUERY" --limit 20 || true

if [ "$DRY_RUN" -eq 1 ]; then
  echo "--dry-run: leaving them alone."
  exit 0
fi

echo "Terminating (reason: ${REASON})..."
temporal_cli workflow terminate --query "$QUERY" --reason "$REASON" --yes
echo "✔ Terminated ${running} orphaned workflow(s)."
