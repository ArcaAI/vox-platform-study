#!/usr/bin/env bash
# ============================================================================
# TASK-557 — Workspace cleaner (build artifacts / caches / dependencies)
# ============================================================================
# One cleaner for the whole monorepo, in tiers. Deliberately implemented with
# `find` rather than `turbo run clean`, so it still works when node_modules is
# already gone (which is exactly when you need the `deps` tier).
#
# USAGE:
#   ./scripts/clean.sh [TIER] [--dry-run] [--yes]
#
# TIERS:
#   build    TypeScript/bundler outputs: dist, .next, storybook-static, pkg,
#            public/dist, *.tsbuildinfo, coverage, test-results,
#            packages/database/src/generated
#   cache    Tool caches: .turbo, node_modules/.cache, .next/cache, .eslintcache,
#            .vite, playwright-report, and Python __pycache__ / .pytest_cache /
#            .ruff_cache / .mypy_cache
#   deps     node_modules (every workspace) + pnpm-lock.yaml
#   default  build + cache          (this is what `pnpm clean` runs)
#   all      build + cache + deps   (this is what `pnpm clean:all` runs)
#
# FLAGS:
#   --dry-run   list what would be removed, delete nothing
#   --yes       skip the confirmation prompt for destructive tiers (deps/all)
#
# AFTER `deps` OR `all` you must reinstall before anything else works:
#   pnpm install && pnpm db:generate
#
# NOTE: the `build` tier removes packages/database/src/generated (the Prisma
# client). Re-run `pnpm db:generate` before typechecking or building.
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

TIER="default"
DRY_RUN=false
ASSUME_YES=false

for arg in "$@"; do
    [ "$arg" = "--" ] && continue
    case "$arg" in
        build|cache|deps|all|default) TIER="$arg" ;;
        --dry-run|-n) DRY_RUN=true ;;
        --yes|-y) ASSUME_YES=true ;;
        --help|-h)
            sed -n '2,32p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
            exit 0 ;;
        *)
            echo -e "${RED}Unknown argument '$arg'.${NC} Tiers: build|cache|deps|all. Flags: --dry-run, --yes" >&2
            exit 2 ;;
    esac
done

REMOVED_COUNT=0

# How many paths a --dry-run lists per category before collapsing to a count.
# Without this a single run prints thousands of .pyc paths and buries the
# summary the user actually came for.
DRY_RUN_SAMPLE="${CLEAN_DRY_RUN_SAMPLE:-8}"

# print_sample <path>...
print_sample() {
    local total=$#
    local shown=0
    local p
    for p in "$@"; do
        [ "$shown" -ge "$DRY_RUN_SAMPLE" ] && break
        echo "      $p"
        shown=$((shown + 1))
    done
    if [ "$total" -gt "$shown" ]; then
        echo "      … and $((total - shown)) more"
    fi
}

# Directories we never descend into while searching (they are handled wholesale
# by the deps tier, and descending into them is both slow and wrong).
PRUNE=(-name node_modules -o -name .git)

# remove_glob <description> <find-type: d|f> <name-pattern>...
# Finds matching entries anywhere in the repo (excluding node_modules/.git) and
# removes them.
remove_matching() {
    local desc="$1" ftype="$2"
    shift 2
    local -a name_args=()
    local first=true
    local pattern
    for pattern in "$@"; do
        if $first; then
            name_args+=(-name "$pattern")
            first=false
        else
            name_args+=(-o -name "$pattern")
        fi
    done

    local -a found=()
    while IFS= read -r line; do
        [ -n "$line" ] && found+=("$line")
    done < <(find . \( "${PRUNE[@]}" \) -prune -o -type "$ftype" \( "${name_args[@]}" \) -print 2>/dev/null || true)

    if [ "${#found[@]}" -eq 0 ]; then
        printf '  %-42s %s\n' "$desc" "— none"
        return 0
    fi

    if $DRY_RUN; then
        printf "  ${YELLOW}%-42s${NC} %s entr(y|ies)\n" "$desc" "${#found[@]}"
        print_sample "${found[@]}"
    else
        rm -rf "${found[@]}"
        printf "  ${GREEN}%-42s${NC} removed %s\n" "$desc" "${#found[@]}"
    fi
    REMOVED_COUNT=$((REMOVED_COUNT + ${#found[@]}))
}

# remove_path <description> <path>...
remove_path() {
    local desc="$1"
    shift
    local -a found=()
    local p
    for p in "$@"; do
        [ -e "$p" ] && found+=("$p")
    done
    if [ "${#found[@]}" -eq 0 ]; then
        printf '  %-42s %s\n' "$desc" "— none"
        return 0
    fi
    if $DRY_RUN; then
        printf "  ${YELLOW}%-42s${NC} %s\n" "$desc" "${found[*]}"
    else
        rm -rf "${found[@]}"
        printf "  ${GREEN}%-42s${NC} removed %s\n" "$desc" "${found[*]}"
    fi
    REMOVED_COUNT=$((REMOVED_COUNT + ${#found[@]}))
}

# node_modules must be removed with its own pass: the shared PRUNE list skips it
# for every other search, and nested workspace copies live several levels deep.
remove_node_modules() {
    local -a found=()
    while IFS= read -r line; do
        [ -n "$line" ] && found+=("$line")
    done < <(find . -name .git -prune -o -type d -name node_modules -prune -print 2>/dev/null || true)

    if [ "${#found[@]}" -eq 0 ]; then
        printf '  %-42s %s\n' "node_modules (all workspaces)" "— none"
        return 0
    fi
    if $DRY_RUN; then
        printf "  ${YELLOW}%-42s${NC} %s dir(s)\n" "node_modules (all workspaces)" "${#found[@]}"
        print_sample "${found[@]}"
    else
        rm -rf "${found[@]}"
        printf "  ${GREEN}%-42s${NC} removed %s dir(s)\n" "node_modules (all workspaces)" "${#found[@]}"
    fi
    REMOVED_COUNT=$((REMOVED_COUNT + ${#found[@]}))
}

clean_build() {
    echo -e "${CYAN}── build artifacts ──────────────────────────────────────────────${NC}"
    remove_matching "dist directories"                d "dist"
    remove_matching ".next directories"               d ".next"
    remove_matching "storybook-static"                d "storybook-static"
    remove_matching "coverage reports"                d "coverage"
    remove_matching "playwright test-results"         d "test-results"
    remove_matching "tsbuildinfo files"               f "*.tsbuildinfo"
    remove_path     "generated Prisma client"         "packages/database/src/generated"
    remove_path     "vox e2e fixture bundle"          "packages/agentic-sdk-v2/e2e/fixtures/dist"
    remove_path     "vad e2e fixture bundle"          "packages/vad/e2e/fixtures/dist"
}

clean_cache() {
    echo -e "${CYAN}── caches ───────────────────────────────────────────────────────${NC}"
    remove_matching "turbo caches (.turbo)"           d ".turbo"
    remove_matching "vite caches (.vite)"             d ".vite"
    remove_matching "playwright-report"               d "playwright-report"
    remove_matching "eslint caches"                   f ".eslintcache"
    echo -e "${CYAN}── python caches ────────────────────────────────────────────────${NC}"
    remove_matching "__pycache__"                     d "__pycache__"
    remove_matching ".pytest_cache"                   d ".pytest_cache"
    remove_matching ".ruff_cache"                     d ".ruff_cache"
    remove_matching ".mypy_cache"                     d ".mypy_cache"
    remove_matching "compiled python (*.pyc)"         f "*.pyc"
    echo -e "${CYAN}── package-manager caches ───────────────────────────────────────${NC}"
    # node_modules/.cache lives INSIDE node_modules, so the shared prune list
    # hides it — enumerate the workspace copies directly.
    local -a caches=()
    while IFS= read -r line; do
        [ -n "$line" ] && caches+=("$line")
    done < <(find . -name .git -prune -o -type d -path '*/node_modules/.cache' -prune -print 2>/dev/null || true)
    if [ "${#caches[@]}" -gt 0 ]; then
        remove_path "node_modules/.cache" "${caches[@]}"
    else
        printf '  %-42s %s\n' "node_modules/.cache" "— none"
    fi
}

clean_deps() {
    echo -e "${CYAN}── dependencies + lock files ────────────────────────────────────${NC}"
    remove_node_modules
    remove_path "pnpm-lock.yaml" "pnpm-lock.yaml"
}

# ----------------------------------------------------------------------------
# Confirmation for destructive tiers
# ----------------------------------------------------------------------------
needs_confirm=false
case "$TIER" in
    deps|all) needs_confirm=true ;;
esac

if $needs_confirm && ! $DRY_RUN && ! $ASSUME_YES; then
    echo -e "${YELLOW}Tier '$TIER' removes every node_modules directory AND pnpm-lock.yaml.${NC}"
    echo "A full 'pnpm install' will be required afterwards, and the lock file will"
    echo "be regenerated (dependency versions may move)."
    if [ ! -t 0 ]; then
        echo -e "${RED}Refusing: stdin is not a TTY and --yes was not given.${NC}" >&2
        exit 1
    fi
    printf 'Type "clean" to proceed: '
    read -r reply
    if [ "$reply" != "clean" ]; then
        echo "Aborted."
        exit 1
    fi
fi

echo -e "${CYAN}━━ clean (tier: $TIER${DRY_RUN:+, DRY RUN}) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

case "$TIER" in
    build)   clean_build ;;
    cache)   clean_cache ;;
    deps)    clean_deps ;;
    default) clean_build; clean_cache ;;
    all)     clean_build; clean_cache; clean_deps ;;
esac

echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
if $DRY_RUN; then
    echo -e "${YELLOW}DRY RUN — nothing was removed${NC} ($REMOVED_COUNT entr(y|ies) matched)."
    exit 0
fi
echo -e "${GREEN}Clean complete${NC} — $REMOVED_COUNT entr(y|ies) removed."

case "$TIER" in
    deps|all)
        echo ""
        echo -e "${YELLOW}Next steps:${NC}"
        echo "  pnpm install        # restore dependencies + regenerate the lock file"
        echo "  pnpm db:generate    # regenerate the Prisma client"
        ;;
    build|default)
        echo ""
        echo -e "${YELLOW}The Prisma client was removed — run 'pnpm db:generate' before building.${NC}"
        ;;
esac
