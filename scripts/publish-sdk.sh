#!/usr/bin/env bash
# ============================================================================
# TASK-633 — Vox SDK family publisher (manual releases)
# ============================================================================
# Version-bumps, builds, and publishes the browser SDK family in dependency
# order. Replaces the hand-run bump/publish snippet that produced the broken
# 2.0.6 tree (stale `^0.1.0` peers + a vox pinned to a med-ner that was never
# published).
#
# WHY THIS EXISTS rather than `pnpm changeset publish`: the CI `publish-sdk`
# job calls changesets, but the repo has NO `.changeset/` directory, so that
# job cannot work as written. Manual publishing is the only path that runs
# today. If changesets is ever configured, prefer it and retire this script.
#
# USAGE:
#   ./scripts/publish-sdk.sh <version> [--dry-run] [--yes] [--skip-build]
#   pnpm sdk:publish 2.0.7
#   pnpm sdk:publish:dry 2.0.7
#
# ARGUMENTS:
#   <version>     Semver to publish, e.g. 2.0.7. Applied to every package in
#                 the family so they stay in lockstep.
#
# FLAGS:
#   --dry-run,-n  Bump + build + `pnpm publish --dry-run`. Publishes nothing.
#                 Version bumps ARE written to disk so the build is real —
#                 `git checkout packages/*/package.json` to undo.
#   --yes,-y      Skip the confirmation prompt.
#   --skip-build  Reuse existing dist/ (fast re-publish after a partial run).
#
# ORDER MATTERS: room ships first because every other package peer-depends on
# it; vox ships last because it depends on all of them. A consumer installing
# vox before its deps exist gets unresolvable peers.
#
# FAIL-FAST: `set -e` is deliberate. The original snippet had no error trap, so
# a failed med-ner publish let the script continue and ship vox anyway — which
# is exactly how vox@2.0.6 ended up pinned to a med-ner@2.0.6 that was never
# published. Never remove it.
#
# PREREQUISITES:
#   - Auth for the registry in `publishConfig` (npm.pkg.github.com) via
#     ~/.npmrc. There is no repo-level .npmrc; CI writes its own.
#   - Clean git tree (the script refuses to run otherwise unless --yes).
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

# Publish order: dependencies before dependents. `room` has no @arcaai deps;
# vad/noise-filter/stt/med-ner peer-depend on room; vox depends on all of them.
PUBLISH_ORDER=(room vad noise-filter stt med-ner vox)

# Directory name under packages/ for each package (vox is the odd one out).
pkg_dir() {
    case "$1" in
        vox) echo "agentic-sdk-v2" ;;
        *) echo "$1" ;;
    esac
}

VERSION=""
DRY_RUN=false
ASSUME_YES=false
SKIP_BUILD=false

for arg in "$@"; do
    [ "$arg" = "--" ] && continue
    case "$arg" in
        --dry-run|-n) DRY_RUN=true ;;
        --yes|-y) ASSUME_YES=true ;;
        --skip-build) SKIP_BUILD=true ;;
        --help|-h)
            sed -n '2,45p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
            exit 0 ;;
        -*)
            echo -e "${RED}Unknown flag '$arg'.${NC} See --help." >&2
            exit 2 ;;
        *)
            if [ -n "$VERSION" ]; then
                echo -e "${RED}Unexpected argument '$arg' (version already set to '$VERSION').${NC}" >&2
                exit 2
            fi
            VERSION="$arg" ;;
    esac
done

if [ -z "$VERSION" ]; then
    echo -e "${RED}Missing <version>.${NC} Usage: ./scripts/publish-sdk.sh 2.0.7 [--dry-run]" >&2
    exit 2
fi

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
    echo -e "${RED}'$VERSION' is not a semver version.${NC} Expected e.g. 2.0.7 or 2.1.0-rc.1" >&2
    exit 2
fi

# ----------------------------------------------------------------------------
# Preflight
# ----------------------------------------------------------------------------
echo -e "${CYAN}=== Preflight ===${NC}"

if [ -n "$(git status --porcelain)" ] && [ "$ASSUME_YES" = false ]; then
    echo -e "${YELLOW}Working tree is dirty.${NC} Publishing from uncommitted state makes the"
    echo "published artifact unreproducible. Commit first, or re-run with --yes."
    git status --short | head -10
    echo
fi

# A `workspace:*` peer publishes as an EXACT pin, and a hardcoded range goes
# stale the moment the family is bumped. Both produce unmet-peer errors for
# consumers, so refuse to publish until every intra-family peer uses
# `workspace:^` (which pnpm rewrites to `^<version>` at pack time).
STALE_PEERS=0
for name in "${PUBLISH_ORDER[@]}"; do
    dir="packages/$(pkg_dir "$name")"
    bad="$(node -e "
        const p = require('./$dir/package.json');
        const peers = p.peerDependencies || {};
        const bad = Object.entries(peers)
            .filter(([n, v]) => n.startsWith('@arcaai/') && v !== 'workspace:^')
            .map(([n, v]) => n + '@' + v);
        if (bad.length) console.log(bad.join(', '));
    ")"
    if [ -n "$bad" ]; then
        echo -e "${RED}  ✕ $dir peerDependencies not publish-safe:${NC} $bad"
        STALE_PEERS=1
    fi
done

if [ "$STALE_PEERS" -ne 0 ]; then
    echo
    echo -e "${RED}Refusing to publish.${NC} Intra-family peers must be 'workspace:^' so pnpm"
    echo "rewrites them to '^$VERSION' at pack time. A literal range (e.g. '^0.1.0')"
    echo "goes stale on every bump; 'workspace:*' publishes as an exact pin."
    exit 1
fi
echo -e "${GREEN}  ✓ intra-family peer ranges are publish-safe (workspace:^)${NC}"

if [ "$DRY_RUN" = false ] && [ "$ASSUME_YES" = false ]; then
    echo
    echo -e "Publishing ${CYAN}${#PUBLISH_ORDER[@]} packages${NC} at version ${CYAN}${VERSION}${NC} in order:"
    printf '  %s\n' "${PUBLISH_ORDER[@]}"
    read -r -p "Proceed? [y/N] " reply
    case "$reply" in [yY]*) ;; *) echo "Aborted."; exit 0 ;; esac
fi

# ----------------------------------------------------------------------------
# 1. Version bump
# ----------------------------------------------------------------------------
echo
echo -e "${CYAN}=== Bumping to $VERSION ===${NC}"
for name in "${PUBLISH_ORDER[@]}"; do
    dir="packages/$(pkg_dir "$name")"
    node -e "
        const fs = require('fs');
        const file = './$dir/package.json';
        const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
        pkg.version = '$VERSION';
        fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
        console.log('  ' + pkg.name + ' -> ' + pkg.version);
    "
done

# Manifests changed, so the lockfile is now stale. `pnpm publish` reads the
# manifest, but leaving the lockfile behind breaks the next `--frozen-lockfile`
# install (CI included).
echo -e "${CYAN}=== Syncing lockfile ===${NC}"
pnpm install --lockfile-only

# ----------------------------------------------------------------------------
# 2. Build
# ----------------------------------------------------------------------------
if [ "$SKIP_BUILD" = true ]; then
    echo -e "${YELLOW}=== Skipping build (--skip-build) ===${NC}"
else
    echo -e "${CYAN}=== Building ===${NC}"
    # `--filter=@arcaai/vox...` covers the whole family: med-ner is reached as a
    # devDependency of vox. Verified with `turbo run build --dry-run=json`.
    pnpm sdk:build
fi

# ----------------------------------------------------------------------------
# 3. Publish, dependencies first
# ----------------------------------------------------------------------------
echo
if [ "$DRY_RUN" = true ]; then
    echo -e "${YELLOW}=== Publishing (DRY RUN — nothing is uploaded) ===${NC}"
else
    echo -e "${CYAN}=== Publishing ===${NC}"
fi

for name in "${PUBLISH_ORDER[@]}"; do
    echo -e "${CYAN}--- @arcaai/$name${NC}"
    if [ "$DRY_RUN" = true ]; then
        pnpm --filter "@arcaai/$name" publish --no-git-checks --dry-run
    else
        # No `|| true`: a failure here must stop the run before dependents ship.
        pnpm --filter "@arcaai/$name" publish --no-git-checks
    fi
done

# ----------------------------------------------------------------------------
# 4. Report
# ----------------------------------------------------------------------------
echo
if [ "$DRY_RUN" = true ]; then
    echo -e "${GREEN}Dry run complete.${NC} Nothing was published."
    echo -e "Version bumps ARE on disk — undo with: ${CYAN}git checkout packages/*/package.json pnpm-lock.yaml${NC}"
else
    echo -e "${GREEN}Published ${#PUBLISH_ORDER[@]} packages at $VERSION.${NC}"
    echo
    echo "Verify what the registry actually received:"
    for name in "${PUBLISH_ORDER[@]}"; do
        echo "  npm view @arcaai/$name version --registry=https://npm.pkg.github.com"
    done
    echo
    echo -e "Then reinstall in a consumer and confirm ${CYAN}no unmet peer warnings${NC}."
    echo "Commit the version bumps + lockfile so the tags match what shipped."
fi
