#!/usr/bin/env bash
# ============================================================================
# TASK-557 — Confirmation guard for the destructive domain-layer generators
# ============================================================================
# Two of the five `gen:*` commands are not safe to run casually:
#
#   generate-mapper      DESTRUCTIVE. It crashes partway through, but not
#                        before rewriting the mappers it already processed —
#                        and its output DROPS the `FIELDS_NOT_WRITABLE =
#                        ['version']` strip plus its stripNonWritableFields
#                        helper. That strip is the only thing stopping
#                        `_version` leaking into Prisma updates, so losing it
#                        silently breaks optimistic concurrency on every
#                        OCC-written model. A single 2026-07-20 invocation
#                        clobbered 24 mappers and stripped the guard from 18.
#
#   generate-repository  BROKEN. Fails immediately on a bad argument
#                        (`--overwrite true` → "too many arguments").
#                        Harmless, but useless.
#
# See .claude/rules/03-domain-layer.md §Generated Code Discipline. The mapper,
# repository, entity and factory layers are HAND-AUTHORED; only `gen:model` is
# a true generator.
#
# This wrapper makes the damage explicit and requires a typed confirmation plus
# a clean git worktree, so recovery is always a `git checkout` away.
#
# USAGE (via the root scripts, not directly):
#   pnpm gen:mapper
#   pnpm gen:repository
#
# Non-interactive callers must set GEN_GUARD_FORCE=1 AND pass --yes.
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

TARGET="${1:-}"
shift || true

ASSUME_YES=false
for arg in "$@"; do
    case "$arg" in
        --yes|-y) ASSUME_YES=true ;;
    esac
done

case "$TARGET" in
    mapper)
        SCRIPT_NAME="generate-mapper"
        GUARDED_PATH="packages/domains/src/mappers/generated/core/"
        SEVERITY="DESTRUCTIVE"
        WARNING="It rewrites mappers in place and DROPS the _version OCC guard before crashing."
        ;;
    repository)
        SCRIPT_NAME="generate-repository"
        GUARDED_PATH="packages/domains/src/repositories/generated/core/"
        SEVERITY="BROKEN"
        WARNING="It fails immediately on a bad argument and produces nothing."
        ;;
    *)
        echo -e "${RED}Usage: $0 <mapper|repository> [--yes]${NC}" >&2
        exit 2
        ;;
esac

echo -e "${RED}${BOLD}━━ ${SEVERITY} GENERATOR — ${SCRIPT_NAME} ━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${YELLOW}$WARNING${NC}"
echo ""
echo "  Affected path: $GUARDED_PATH"
echo "  Recovery:      git checkout -- $GUARDED_PATH"
echo "  Background:    .claude/rules/03-domain-layer.md §Generated Code Discipline"
echo ""
echo -e "${CYAN}The mapper/repository/entity/factory layers are HAND-AUTHORED in this repo.${NC}"
echo -e "${CYAN}If you are adding a model, hand-author the trio and run gen:entity + gen:factory${NC}"
echo -e "${CYAN}to reconcile the barrels instead. You almost certainly do not want this.${NC}"
echo ""

# --- clean-worktree check: recovery depends on git having the old content ----
if ! git rev-parse --git-dir >/dev/null 2>&1; then
    echo -e "${RED}Not a git repository — refusing to run a $SEVERITY generator with no way back.${NC}" >&2
    exit 1
fi

if [ -n "$(git status --porcelain -- "$GUARDED_PATH" 2>/dev/null)" ]; then
    echo -e "${RED}Refusing: '$GUARDED_PATH' has uncommitted changes.${NC}" >&2
    echo "Those changes would be overwritten with no way to recover them." >&2
    echo "Commit or stash them first." >&2
    exit 1
fi
echo -e "${GREEN}✓${NC} '$GUARDED_PATH' is clean — a git checkout can undo this."
echo ""

# --- confirmation ------------------------------------------------------------
if $ASSUME_YES && [ "${GEN_GUARD_FORCE:-0}" = "1" ]; then
    echo -e "${YELLOW}GEN_GUARD_FORCE=1 and --yes given — proceeding without a prompt.${NC}"
elif [ ! -t 0 ]; then
    echo -e "${RED}Refusing: stdin is not a TTY.${NC}" >&2
    echo "Non-interactive callers must set GEN_GUARD_FORCE=1 and pass --yes." >&2
    exit 1
else
    printf 'Type "%s" to proceed, anything else to abort: ' "$SCRIPT_NAME"
    read -r reply
    if [ "$reply" != "$SCRIPT_NAME" ]; then
        echo "Aborted — nothing was run."
        exit 1
    fi
fi

echo ""
echo -e "${YELLOW}Running $SCRIPT_NAME...${NC}"
exec pnpm --filter @arcaai/tools "$SCRIPT_NAME"
