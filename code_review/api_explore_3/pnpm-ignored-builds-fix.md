# Fix `ERR_PNPM_IGNORED_BUILDS` (pnpm v10+/v12)

If you see an error like:

```text
ERR_PNPM_IGNORED_BUILDS
Ignored build scripts: @parcel/watcher@..., @prisma/engines@..., esbuild@..., prisma@..., ...
help: Run "pnpm approve-builds" to pick which dependencies should be allowed to run scripts.
```

it means `pnpm` blocked dependency lifecycle/build scripts by default until you explicitly approve them. Some packages may not be fully installed/built (native addons, Prisma engines, codegen/download steps, etc.) until approved scripts are allowed to run.

## Steps (run from terminal)

1. **Go to the monorepo root**
   ```bash
   cd /Users/apple/repos/VOX/project-hope
   ```

2. **Approve required build scripts (interactive)**
   ```bash
   pnpm approve-builds
   ```
   - A list of packages with ignored build scripts is shown.
   - Select the packages this repo needs (space to toggle, enter to confirm), then approve.
   - Common packages to approve in this monorepo are often:
     - `@prisma/engines`
     - `prisma`
     - `esbuild` (all listed versions, if multiple)
     - `@parcel/watcher`
     - `msgpackr-extract`
   - Approve others (e.g. `puppeteer`, `protobufjs`, `vue-demi`, `@scarf/scarf`) only if their install/build scripts are needed for your local workflow.
   - `pnpm` records approvals in project configuration so they persist for this workspace.

3. **Re-run install (and run approved scripts/rebuild as needed)**
   ```bash
   pnpm install
   ```
   If dependencies were already present but scripts did not run, also run:
   ```bash
   pnpm rebuild
   ```

4. **Retry your original command**
   After install/rebuild completes successfully, rerun the command you were trying (e.g. `pnpm api:test`, `pnpm api:build`, `pnpm api:openapi`).

## Notes

- **Approve only trusted packages** that genuinely require install/build scripts.
- In non-interactive environments, approvals can be configured via pnpm config/project settings instead of the interactive prompt, but `pnpm approve-builds` is the simplest local fix.
- If errors persist, capture the exact command and full output to identify which package script/build step is still failing.
