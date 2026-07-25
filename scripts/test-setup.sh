#!/usr/bin/env bash
# ============================================================================
# One-command local TEST environment bootstrap
# ============================================================================
# Test counterpart to `pnpm setup:dev` (scripts/dev-setup.sh). Brings a fresh
# checkout to a state where `pnpm test:up:api` (and the vitest/playwright suites
# that read .env.test) boot cleanly against the isolated test infrastructure.
#
# Unlike dev, the test environment uses STATIC Postgres credentials from
# .env.test (DATABASE_URL=postgresql://test:test@localhost:5433/hope_test) and
# does NOT use Vault — so this bootstrap is intentionally simpler than dev-setup.
#
# Sequence:
#   1. Start isolated test infrastructure (Postgres:5433, Redis:6380, MinIO:9002,
#      Qdrant:6335) and wait for health
#   2. Generate the Prisma client
#   3. Push the schema to the test database (test:db:push)
#   4. Seed baseline data                  (test:db:seed)
#
# USAGE:
#   pnpm setup:test        (preferred)
#   ./scripts/test-setup.sh
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

red()    { printf "\033[31m%s\033[0m\n" "$*" >&2; }
green()  { printf "\033[32m%s\033[0m\n" "$*"; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }
bold()   { printf "\033[1m%s\033[0m\n" "$*"; }

if [ ! -f "$REPO_ROOT/.env.test" ]; then
  red "ERROR: .env.test not found at $REPO_ROOT/.env.test"
  echo "The test environment requires .env.test. Create it before running this script."
  exit 1
fi

bold "── Step 1/4: starting + validating test infrastructure ─────────────"
# start-test-infra.sh runs 'up -d --wait' and a health validation pass.
"$SCRIPT_DIR/start-test-infra.sh"

bold "── Step 2/4: generating Prisma client ──────────────────────────────"
pnpm db:generate

bold "── Step 3/4: pushing schema to test database (test:db:push) ─────────"
pnpm test:db:push

bold "── Step 4/4: seeding baseline data (test:db:seed) ──────────────────"
pnpm test:db:seed

green ""
green "✔ Local test environment is ready."
yellow "Start the test API:   pnpm test:up:api"
yellow "Run the test suites:  pnpm test:unit   |   pnpm test:integration   |   pnpm test:e2e"
