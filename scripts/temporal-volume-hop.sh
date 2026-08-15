#!/bin/bash
# ============================================================================
# Temporal volume hop — PRINT ONLY (TASK-702)
# ============================================================================
# Prints the 1.29.x → 1.30.4 → 1.31.2 hop commands for a leftover
# auto-setup Temporal DB after compose moved to server/admin-tools 1.31.2.
#
# USAGE (from the monorepo root):
#   pnpm infra:dev:temporal-hop
#   ./scripts/temporal-volume-hop.sh
#
# This script never starts, stops, or recreates containers. It never passes
# -v to compose. It never runs DELETE / DROP / TRUNCATE.
#
# Canonical runbook:
#   docs/implementation/TASK-702-Dependency-Blocker-Resolutions/README.md
# ============================================================================

set -euo pipefail

TARGET_SERVER="1.31.2"
TARGET_ADMINTOOLS="1.31.2"
HOP_SERVER="1.30.4"
HOP_ADMINTOOLS="1.30.4"
FALLBACK_AUTOSETUP="1.29.7"
CONTAINER="hope-temporal"

echo "TASK-702 Temporal volume hop — print only (does not apply anything)"
echo "Runbook: docs/implementation/TASK-702-Dependency-Blocker-Resolutions/README.md"
echo ""
echo "FORBIDDEN:"
echo "  - docker compose down -v   (wipes hope-postgres: app DB + Temporal DBs)"
echo "  - DELETE / DROP / TRUNCATE on temporal, temporal_visibility, or hope"
echo "  - temporalio/admin-tools:1.29.7  (tag does not exist)"
echo "  - jumping 1.29.x → ${TARGET_SERVER} on an existing cluster"
echo ""

if command -v docker >/dev/null 2>&1 && docker inspect "$CONTAINER" >/dev/null 2>&1; then
    image="$(docker inspect --format '{{.Config.Image}}' "$CONTAINER" 2>/dev/null || true)"
    status="$(docker inspect --format '{{.State.Status}}' "$CONTAINER" 2>/dev/null || true)"
    health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CONTAINER" 2>/dev/null || true)"
    echo "Observed ${CONTAINER}:"
    echo "  image:  ${image:-unknown}"
    echo "  status: ${status:-unknown}"
    echo "  health: ${health:-unknown}"
    echo ""
    case "$image" in
        *":${TARGET_SERVER}"*|*"server:${TARGET_SERVER}"*)
            if [ "$health" = "healthy" ]; then
                echo "hope-temporal is already ${TARGET_SERVER} and healthy."
                echo "No hop needed (this runbook is for leftover auto-setup 1.29.x DBs)."
                echo ""
            else
                echo "Image is ${TARGET_SERVER} but not healthy — if this volume is leftover 1.29.x, hop below."
                echo ""
            fi
            ;;
        *)
            echo "Image is not the compose default ${TARGET_SERVER}. If this is a 1.29.x leftover, hop below."
            echo ""
            ;;
    esac
else
    echo "No running/stopped ${CONTAINER} container (or Docker unavailable)."
    echo "Fresh clones with empty Temporal DBs: just pnpm infra:dev:up (defaults ${TARGET_SERVER})."
    echo "Hop only if a leftover 1.29.x Temporal DB already lives in hope-postgres."
    echo ""
fi

echo "Primary hop (existing 1.29.x Temporal DB, hope-temporal failing on ${TARGET_SERVER}):"
echo ""
echo "  # 1) Intermediate minor. Do not pass -v."
echo "  TEMPORAL_VERSION=${HOP_SERVER} TEMPORAL_ADMINTOOLS_VERSION=${HOP_ADMINTOOLS} pnpm infra:dev:up"
echo ""
echo "  # 2) Wait until hope-temporal is healthy (gRPC :7233)."
echo "  docker inspect --format '{{.State.Health.Status}}' ${CONTAINER}"
echo "  # expected: healthy"
echo ""
echo "  # 3) Compose default (${TARGET_SERVER} / admin-tools ${TARGET_ADMINTOOLS}, UI 2.53.1)."
echo "  pnpm infra:dev:up"
echo ""
echo "If 1.31 admin-tools already updated schema and ${HOP_ADMINTOOLS} admin-tools errors,"
echo "leave the schema as-is and hop only the server binary:"
echo ""
echo "  TEMPORAL_VERSION=${HOP_SERVER} pnpm infra:dev:up"
echo "  # wait healthy, then"
echo "  pnpm infra:dev:up"
echo ""
echo "Fallback if ${HOP_SERVER} refuses 1.29 data:"
echo "  Last auto-setup tag is ${FALLBACK_AUTOSETUP}. admin-tools:1.29.7 does not exist."
echo "  Temporarily run temporalio/auto-setup:${FALLBACK_AUTOSETUP} against the same"
echo "  hope-postgres (DBNAME=temporal, VISIBILITY_DBNAME=temporal_visibility) until"
echo "  healthy, then take the primary hop. Do not restore auto-setup as the default"
echo "  compose layout. Do not wipe volumes."
echo ""
echo "Optional read-only schema check (SELECT only):"
echo ""
echo "  docker exec hope-postgres psql -U postgres -d temporal -c \\"
echo "    \"SELECT curr_version, min_compatible_version FROM schema_version;\""
echo "  docker exec hope-postgres psql -U postgres -d temporal_visibility -c \\"
echo "    \"SELECT curr_version, min_compatible_version FROM schema_version;\""
echo ""
echo "1.31.0 expects core schema v1.19 and visibility v1.14."
echo "UI stays temporalio/ui:2.53.1. Do not change Qdrant / Grafana / Vault pins."
