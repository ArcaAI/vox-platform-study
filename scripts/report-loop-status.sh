#!/bin/bash
# ============================================================================
# Loop status report (read-only)
# ============================================================================
# Answers "what is harness.loop.enabled's EFFECTIVE value in this database,
# right now?" — without going through the API. Prints the exact
# core."GlobalSetting" row `value` / `defaultValue` / `updatedAt` / `updatedBy`
# for the two consultation-gate kill-switches seeded by
# packages/database/src/prisma/db_main/seed/11c-consultation-gate-settings.ts:
#
#   harness.loop.enabled       — the switch this ticket (TASK-705) investigates
#   consultation.ocr.enabled   — sibling switch seeded by the SAME file; used
#                                 here only as a cross-check that the seed ran
#                                 at all (if this row is also missing, the
#                                 whole file never ran — a stronger signal than
#                                 "harness.loop.enabled is unseeded" alone)
#
# READ-ONLY. No writes, no migrations, no seeding. Safe to run against any
# reachable environment's database.
#
# USAGE:
#   scripts/report-loop-status.sh
#
#   DATABASE_URL is resolved the same way the rest of the repo does
#   (host env wins; falls back to the literal DATABASE_URL= line in .env.dev
#   at the repo root — see packages/applications/src/common/env/
#   env-file-resolution.ts for the canonical TS-side version of this
#   precedence). Override explicitly for any other environment:
#
#     DATABASE_URL=postgresql://user:pass@host:5432/hope scripts/report-loop-status.sh
#
# EXIT CODE: 1 if the database is unreachable or the query fails, 0 otherwise
# (0 even when a row is missing — "unseeded" is a valid, reportable finding,
# not a script error).
# ============================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT" || exit 1

# Row coordinates, verbatim from
# packages/database/src/prisma/db_main/seed/11c-consultation-gate-settings.ts
# and packages/database/src/prisma/db_main/seed/00-constants.ts (SEED_TENANT_ID).
SEED_TENANT_ID="50000000-0000-0000-0000-000000000000"
NAMESPACE="registry"

# --- Resolve DATABASE_URL: host env wins over the .env.dev file. -----------
if [ -z "${DATABASE_URL:-}" ] && [ -f "$REPO_ROOT/.env.dev" ]; then
  DATABASE_URL="$(grep -m1 '^DATABASE_URL=' "$REPO_ROOT/.env.dev" | cut -d= -f2-)"
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "FAIL: DATABASE_URL not set and no DATABASE_URL= line found in .env.dev" >&2
  echo "      Set it explicitly: DATABASE_URL=postgresql://... scripts/report-loop-status.sh" >&2
  exit 1
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "FAIL: psql not found on PATH — cannot run a read-only query without it" >&2
  exit 1
fi

echo "== Loop status report =="
echo "Target: $(echo "$DATABASE_URL" | sed -E 's#//[^@]*@#//****:****@#')"
echo

QUERY="SELECT key, value, \"defaultValue\", \"updatedAt\", \"updatedBy\"
FROM core.\"GlobalSetting\"
WHERE namespace = '${NAMESPACE}'
  AND \"tenantId\" = '${SEED_TENANT_ID}'
  AND key IN ('harness.loop.enabled', 'consultation.ocr.enabled')
ORDER BY key;"

if ! psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "$QUERY"; then
  echo "FAIL: query failed — database unreachable, schema missing, or connection refused" >&2
  echo "      This is itself a reportable finding for the environment above, not just a script error." >&2
  exit 1
fi

echo
echo "No row for harness.loop.enabled above means: this database was never seeded"
echo "(seed/11c-consultation-gate-settings.ts never ran here), so the EFFECTIVE"
echo "value falls back to the settings-registry descriptor default ('false')."
echo "See docs/implementation/TASK-705-Loop-Status-Discovery/README.md §2.1."
