# Environment Loading Refactor

**Ticket Number**: TASK-002
**Created Date**: 2026-01-27
**Last Updated**: 2026-01-27
**Status**: Completed

---

## Requirement Analysis

### Business Context
The HOPE monorepo needed a standardized way to load environment variables across all packages and services. The previous implementation had inconsistent env loading:
- Some files searched for `.env` by traversing up directories
- Some files loaded from hardcoded relative paths
- Test environments could be overridden by development config
- No clear separation between development, test, and production environments

### Acceptance Criteria
1. Environment files follow a clear naming convention:
   - `.env.dev` for local development
   - `.env.test` for local testing
   - `.env.production` for production reference
2. Host environment variables always have highest priority
3. CI/CD and production environments use only host variables (no file loading)
4. Test environments are isolated and not affected by development config

---

## Current State Evaluation

### Before Refactoring

**Issues Identified:**

1. **config.service.ts** - Searched for `.env` by traversing up directories
2. **packages/database/src/client.ts** - Used `import('dotenv/config')` conditionally
3. **packages/database/src/index.ts** - Loaded from hardcoded `../../../.env`
4. **prisma.config.ts** - Only handled test vs non-test
5. **Test setups** - Each loaded `.env.test` directly with `dotenv.config()`
6. **logging.service.ts** - Had its own env file search logic
7. **Tools package** - Each tool loaded `.env` from its own directory

### Related Components
- `packages/applications/src/services/baseServices/_meta/config/`
- `packages/database/src/`
- `packages/tools/src/`
- `tests/setup/`
- `scripts/start-test-api.sh`

---

## Implementation Plan

### Phase 1: Create Centralized Env Loading Utilities
- Create `packages/applications/src/common/env/index.ts` with shared utility
- Create `packages/database/src/env.ts` for database package (no circular deps)
- Create `packages/tools/src/utils/loadEnv.ts` for tools package

### Phase 2: Update All Env Loading Points
- Update config.service.ts to use centralized utility
- Update database package to use its env utility
- Update prisma.config.ts
- Update test setup files
- Update tools package files

### Phase 3: Update Environment Files
- Keep `.env.dev` as canonical development file
- Keep `.env.test` for testing
- Create `.env.production` as production template
- Update `.gitignore` to track the right files

### Phase 4: Update Documentation
- Update `docs/ENVIRONMENT_VARIABLES.md`
- Update `.env.example` header
- Update script files

---

## Implementation Summary

### What Was Implemented

1. **Centralized Environment Loading Utilities**
   - `packages/applications/src/common/env/index.ts` - Main utility with `loadEnv()` function
   - `packages/database/src/env.ts` - Standalone utility for database package
   - `packages/tools/src/utils/loadEnv.ts` - Utility for CLI tools

2. **Environment File Convention**
   - `.env.dev` → Local development (NODE_ENV=development)
   - `.env.test` → Local testing (NODE_ENV=test)
   - `.env.production` → Production template (NODE_ENV=production uses host env)
   - `.env` → Fallback for backwards compatibility (deprecated)

3. **Loading Priority**
   - Host environment variables always have highest priority
   - In CI (`CI=true`) or production, no files are loaded
   - In development, loads `.env.dev` (falls back to `.env`)
   - In test mode, files are loaded via `dotenv-cli` (not overridden)

### Files Created/Modified

**New Files:**
- `packages/applications/src/common/env/index.ts`
- `packages/database/src/env.ts`
- `packages/tools/src/utils/loadEnv.ts`
- `.env.production`
- `docs/implementation/TASK-002-Environment-Loading-Refactor/README.md`

**Modified Files:**
- `packages/applications/src/common/index.ts` - Added env export
- `packages/applications/src/services/baseServices/_meta/config/config.service.ts` - Uses centralized utility
- `packages/applications/src/services/baseServices/logging/logging.service.ts` - Removed redundant env loading
- `packages/database/src/client.ts` - Uses `./env.js`
- `packages/database/src/index.ts` - Uses `./env.js`
- `packages/database/src/prisma/db_main/seed/index.ts` - Removed dotenv import
- `prisma.config.ts` - Uses NODE_ENV-based file selection
- `playwright.config.ts` - Relies on dotenv-cli
- `tests/setup/vitest.setup.ts` - Relies on dotenv-cli
- `tests/setup/integration.setup.ts` - Relies on dotenv-cli
- `tests/setup/playwright.global-setup.ts` - Relies on dotenv-cli
- `apps/api/tests/setup/integration.setup.ts` - Relies on dotenv-cli
- `packages/tools/src/prisma-commander/index.ts` - Uses NODE_ENV-based loading
- `packages/tools/src/generate-mapper/index.ts` - Uses shared utility
- `packages/tools/src/generate-mapper/generator.ts` - Uses shared utility
- `packages/tools/src/generate-data-model/index.ts` - Uses shared utility
- `packages/tools/src/generate-data-entity/index.ts` - Uses shared utility
- `packages/tools/src/generate-factory/index.ts` - Uses shared utility
- `package.json` - Added NODE_ENV to dev scripts
- `scripts/start-test-api.sh` - Simplified script
- `.gitignore` - Updated to track correct files
- `.env.example` - Updated header with new convention
- `.env.dev` - Updated header
- `docs/ENVIRONMENT_VARIABLES.md` - Full documentation update

### Testing Performed
- Linter validation passed for all modified files
- No circular dependency issues
- Consistent pattern across all packages

### Key Design Decisions

1. **Separate utilities for each package** - To avoid circular dependencies, each package (applications, database, tools) has its own env loading utility with the same logic.

2. **Auto-load on import** - The env utilities auto-load when imported, ensuring env vars are available before any other code runs.

3. **Test mode uses dotenv-cli** - Instead of loading `.env.test` in code, tests are run with `dotenv -e .env.test -- ...` to ensure test config takes precedence.

4. **No override in test mode** - When `NODE_ENV=test`, the env file is not loaded with `override: true` to respect variables set by dotenv-cli.

5. **CI/Production skip files** - In CI (`CI=true`) or production, no env files are loaded to ensure security and use of host-provided variables.

---

## Verification

### How to Verify

1. **Development mode**:
   ```bash
   pnpm dev:api
   # Should log: "Loaded environment from /path/.env.dev"
   ```

2. **Test mode**:
   ```bash
   pnpm test:unit
   # Should use .env.test variables (DATABASE_URL with port 5433)
   ```

3. **CI mode** (simulate):
   ```bash
   CI=true pnpm dev:api
   # Should log: "Using host environment variables"
   ```

---

## Change History

### Initial Implementation - 2026-01-27
- Created centralized environment loading utilities
- Updated all packages to use consistent env loading
- Created `.env.production` template
- Updated documentation
