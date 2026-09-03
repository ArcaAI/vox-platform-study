#!/bin/bash
# ============================================================================
# Loop status report (read-only)
# ============================================================================
# Answers "does the harness agentic loop run in this database, right now, and
# for whom?" — without going through the API.
#
# CHANGED THE ANSWER'S SHAPE. The loop used to be governed by ONE
# platform kill-switch (`harness.loop.enabled`), so one row answered the whole
# question. It is now a SUBSCRIPTION FEATURE composed with an operational veto:
#
#     runs(tenant) ⇔ entitlement(tenant).agenticLoop AND NOT emergencyStop
#
# So this script prints three things, in that order:
#
#   1. harness.loop.emergencyStop — the platform veto (core."GlobalSetting").
#                                    ABSENT is the normal, intended state and
#                                    means "no emergency": the loop is allowed.
#   2. entitlements.enabled — whether entitlement enforcement is ON in
#                                    this environment at all. With it OFF,
#                                    `isFeatureEnabled` returns true for every
#                                    tenant, so the commercial gate is INERT and
#                                    every tenant runs the loop.
#   3. per-tenant plans — each tenant's plan, and the loop verdict
#                                    that plan implies (AGENTIC_LOOP_PLAN_DEFAULTS
#                                    in packages/applications/src/services/
#                                    entitlements/entitlements.constants.ts).
#                                    A NULL plan is "ungated-legacy" → allowed.
#
# It also prints consultation.ocr.enabled, the sibling switch still seeded by
# packages/database/src/prisma/db_main/seed/11c-consultation-gate-settings.ts,
# as a cross-check that the seed ran at all in this database.
#
# NOTE: per-tenant/per-plan OVERRIDES of the loop entitlement are not queried,
# because no `featureAgenticLoop` column exists yet — the plan defaults live in
# code until that schema change lands ( follow-up). When the
# columns arrive, add them to the plan query below.
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
# EXIT CODE: 1 if the database is unreachable or a query fails, 0 otherwise
# (0 even when a row is missing — "absent" is a valid, reportable finding, and
# for the emergency stop it is the EXPECTED one).
# ============================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT" || exit 1

# Row coordinates, verbatim from
# packages/database/src/prisma/db_main/seed/11c-consultation-gate-settings.ts
# and packages/database/src/prisma/db_main/seed/00-constants.ts (SEED_TENANT_ID).
SEED_TENANT_ID="50000000-0000-0000-0000-000000000000"

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

# 1 + 2 — the two platform switches that can suppress the loop.
SWITCH_QUERY="SELECT namespace, key, value, \"defaultValue\", \"updatedAt\", \"updatedBy\"
FROM core.\"GlobalSetting\"
WHERE \"tenantId\" = '${SEED_TENANT_ID}'
  AND key IN ('harness.loop.emergencyStop', 'consultation.ocr.enabled', 'entitlements.enabled')
ORDER BY key;"

echo "-- platform switches --"
if ! psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "$SWITCH_QUERY"; then
  echo "FAIL: query failed — database unreachable, schema missing, or connection refused" >&2
  echo "      This is itself a reportable finding for the environment above, not just a script error." >&2
  exit 1
fi

# 3 — who is entitled. The CASE mirrors AGENTIC_LOOP_PLAN_DEFAULTS exactly; keep
# the two in step if the packaging changes.
PLAN_QUERY="SELECT t.name,
       COALESCE(t.plan::text, '(none → ungated-legacy)') AS plan,
       CASE
         WHEN t.plan IS NULL      THEN 'allowed (ungated)'
         WHEN t.plan::text = 'STARTER' THEN 'NOT entitled'
         ELSE 'entitled'
       END AS \"agenticLoop\"
FROM core.\"Tenant\" t
WHERE t.\"resourceStatus\" <> 'DELETED'
ORDER BY t.name;"

echo
echo "-- per-tenant loop entitlement (from plan; overrides not stored yet) --"
if ! psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "$PLAN_QUERY"; then
  echo "FAIL: tenant/plan query failed" >&2
  exit 1
fi

cat <<'NOTES'

How to read this:
  * NO harness.loop.emergencyStop row  → no emergency in progress (expected).
    A row with value 'true' halts the loop for EVERY tenant, immediately.
  * entitlements.enabled = false       → the commercial gate is INERT here;
    isFeatureEnabled returns true for everyone, so the "NOT entitled" verdicts
    above are advisory only. Deployed environments seed this ON.
  * No harness.loop.enabled row is expected any more —  retired that
    key. If one is still present it is an inert leftover from an older seed.

See 
NOTES
