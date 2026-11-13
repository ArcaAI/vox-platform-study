# `apps/api` test output and report locations (`project-hope`)

## Regular test runs (no coverage)

Commands like:

```bash
cd /Users/apple/repos/VOX/project-hope
pnpm api:test
# or
pnpm --filter @arcaai/api test
# or (from apps/api)
pnpm test
pnpm vitest run
```

**Where results are saved:** nowhere by default (current `apps/api/vitest.config.ts`).

- Test results are emitted to the terminal (stdout/stderr).
- Pass/fail is indicated by the final Vitest summary and the process exit code.
- No file-based test-result reporters are configured for normal runs (e.g. no JUnit/XML/JSON test report `outputFile` in the current config).

## Coverage runs

Commands like:

```bash
cd /Users/apple/repos/VOX/project-hope
pnpm api:test:cov
# or (from apps/api)
pnpm test:cov
pnpm vitest run --coverage
```

**Where reports are saved:** `project-hope/apps/api/coverage/`  
(configured via `test.coverage.reportsDirectory: './coverage'` in `apps/api/vitest.config.ts`)

**Configured coverage reporters:** `text`, `json`, `html`

**Typical files/artifacts:**
- `apps/api/coverage/index.html` — HTML coverage report (open in a browser)
- `apps/api/coverage/coverage-final.json` — machine-readable JSON coverage data
- `apps/api/coverage/base.css`, `apps/api/coverage/prettify.js`, `apps/api/coverage/sorter.js`, etc. — HTML report assets
- `apps/api/coverage/src/...` — per-file HTML coverage pages

## Notes

- If `apps/api/coverage/` already exists, it may contain results from a previous coverage run. Check file timestamps and rerun with coverage to refresh.
- CI systems may capture terminal logs/artifacts separately, but that is outside the default local Vitest configuration above.
- If you need persistent non-coverage test reports (e.g. JUnit XML for CI dashboards), Vitest reporters/output configuration must be added explicitly in `apps/api/vitest.config.ts` or passed via CLI flags.
