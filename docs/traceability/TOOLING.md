# Traceability & Doc-Claim Checkers

Two standalone Node scripts keep the documentation honest against the code. Both are
plain ESM (`.mjs`), require **only Node ≥ 18** (no dependencies, no build step), resolve
the repo root from their own location, and exit non-zero on failure so CI can gate on
them.

| Script | Ticket | Checks |
|---|---|---|
| [`scripts/verify-traceability.mjs`](../../scripts/verify-traceability.mjs) | TASK-538 (Wave-4 #3) | The per-domain traceability rows in `docs/traceability/*.md` do not drift from code. |
| [`scripts/verify-doc-claims.mjs`](../../scripts/verify-doc-claims.mjs) | TASK-537 (Wave-3 #2) | Backtick-quoted paths and `pnpm <script>` refs across `docs/**/*.md` + every `README.md` resolve. |

## verify-traceability.mjs

```bash
node scripts/verify-traceability.mjs             # verify mode (default)
node scripts/verify-traceability.mjs --coverage  # coverage mode
```

**Verify mode** parses the capability **table rows** in every `docs/traceability/*.md`
file (narrative prose is intentionally *not* treated as a claim — it may name removed or
hypothetical paths) and checks four kinds of claim:

1. **Repo paths** — every backtick token that is a real repo-relative path (rooted at
   `apps/`, `packages/`, `docs/`, `scripts/`, `infrastructure/`, `deployment/`, `tests/`,
   `.claude/`, `.gitlab/`, `.github/`, a `db_main/…` schema file, or a `./`-relative `.md`
   link) must exist on disk.
2. **Route strings** — `@Controller('…')` must appear in an `apps/**/*.ts` controller,
   `APIRouter(prefix="…")` in an `apps/**/*.py` router, and
   `@WebSocketGateway({ path: '…' })` in an `apps/**/*.ts` file.
3. **Prisma models** — PascalCase names in the **Prisma models** field must be declared as
   a `model` **or** `enum` in `packages/database/src/prisma/db_main/*.prisma`.
4. **Test globs** — entries in the **Tests** field (with brace-expansion and `*`/`**`
   support) must match at least one file. Abbreviated names in a parenthetical list
   (e.g. `harness-internal.service`) are informational and skipped.

Exit `0` when every checkable claim resolves; exit `1` with a per-file failure list
otherwise. The tool is **conservative** — a token that cannot be resolved to a concrete,
rooted target is skipped rather than flagged, so a reported failure is a real one.

**Coverage mode** lists every `apps/api/src/modules/*` and
`apps/admin-console/src/features/*` that is referenced in **no** traceability file, so a
new capability cannot ship without a row. Exits `1` if any surface is unreferenced.

Current tree: **verify mode passes (0 failures, ~750 claims); coverage mode passes (all
46 modules + 41 features referenced).**

## verify-doc-claims.mjs

```bash
node scripts/verify-doc-claims.mjs                    # docs/archive excluded (default)
node scripts/verify-doc-claims.mjs --include-archive  # also scan docs/archive/**
```

Scans `docs/**/*.md` plus every `README.md` in the repo and verifies:

1. **Repo-relative paths** — backtick tokens rooted at a known repo dir (as above) exist,
   using an *exists-somewhere* suffix fallback so a package-relative path such as
   `tests/unit/temporal/test_replay_compat.py` (which lives under `apps/harness/…`) is not
   flagged.
2. **`pnpm <script>` references** — the script name exists in some workspace
   `package.json`. `pnpm` built-ins (`install`, `exec`, `dlx`, …) and `node_modules/.bin`
   executables (`pnpm turbo`, `pnpm tsx`) are recognized as valid and skipped.

Conservatively skipped to avoid false positives: fenced code blocks (illustrative
examples), tokens with placeholder/glob chars (`< > * { } …` or a literal `...`), ambiguous
`./`-relative code/export subpaths (only doc-to-doc `.md` links are checked), and paths a
sentence deliberately marks as gone (`(NOT \`x\`)`, `the former \`x\``, `removed … (e.g.
\`x\`)`).

**`docs/archive/**` is excluded by default** — it is an immutable snapshot of superseded
tickets and is expected to reference removed paths. Pass `--include-archive` to scan it.

### Reading the output

A failure means *"this backtick path/script, taken as repo-relative, does not exist."*
On the current tree that is a mix of genuine drift a maintainer should fix and
forward-looking references in planning/research notes:

- **Stale cross-references** to tickets that were archived or renamed (e.g. a
  `docs/implementation/TASK-415-…/capabilities-matrix.md` link that now lives under
  `docs/archive/…`) → fix the link.
- **Real path drift** (e.g. a module referenced as `ai-provider` that is now
  `ai-provider-connection`, or a service path missing its `harness/` subdir) → fix the doc.
- **Planned-but-unlanded artifacts** named in a ticket README or research proposal (e2e
  specs, scripts, tests that don't exist yet) → expected while the ticket is open; resolve
  when the work lands.

These are reported, not papered over. Triage per the buckets above.

## CI wiring (proposed — validate stage)

These jobs are **not yet added** to `.gitlab/ci/*.yml`. Add them to `.gitlab/ci/validate.yml`
alongside the existing generator-drift gates. `verify-doc-claims` is proposed as
**non-blocking** initially (`allow_failure: true`) because the current tree still carries
real, pre-existing drift; flip it to blocking once that backlog is burned down.

```yaml
# .gitlab/ci/validate.yml — add under the `validate` stage

verify-traceability:
  stage: validate
  extends: .node-base            # reuse the repo's Node/pnpm setup anchor
  needs: []                      # no build needed — pure file checks
  script:
    - node scripts/verify-traceability.mjs
    - node scripts/verify-traceability.mjs --coverage
  rules:
    - if: '$CI_PIPELINE_SOURCE == "merge_request_event"'
    - if: '$CI_COMMIT_BRANCH'

verify-doc-claims:
  stage: validate
  extends: .node-base
  needs: []
  allow_failure: true            # non-blocking until the pre-existing drift is cleared
  script:
    - node scripts/verify-doc-claims.mjs
  rules:
    - if: '$CI_PIPELINE_SOURCE == "merge_request_event"'
    - if: '$CI_COMMIT_BRANCH'
```

Both scripts need no database, services, or `pnpm install` output beyond a normal checkout
(`verify-doc-claims` reads `node_modules/.bin` when present, but degrades gracefully when
it is absent), so they can run early in `validate` with `needs: []`.
