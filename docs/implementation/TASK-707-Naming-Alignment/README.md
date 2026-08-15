# TASK-707 — Naming Alignment

| | |
|---|---|
| **Status** | Pending |
| **Wave** | 0 (barrier) · **Size** | L |
| **Epic slug** | `naming-alignment` |
| **Depends on** | TASK-700, TASK-701, TASK-702, TASK-703, TASK-704, TASK-705, TASK-706 (all Wave-0 code fixes must land first — this ticket is a deliberate barrier, per [backlog.md](../../architecture/agentic-workflow-platform/backlog.md) "Sequencing notes": *"707 `naming-alignment` is a deliberate barrier: it lands after the Wave-0 code fixes so the rename doesn't collide with them, and before Wave 1 so all new code is born with the new names."*) |
| **Design refs** | D8 (`smr` → `text`; `GLOBAL_ADMIN` → `SUPER_ADMIN`, "a rename — code already has one elevated role. Batched in one `naming-alignment` epic, executed early") |
| **Findings closed** | — (D8 is a design decision, not a remediation of a numbered conformance finding) |

## 1. Requirement Analysis

[design.md](../../architecture/agentic-workflow-platform/design.md) D8 commits to two renames
ahead of the Wave-1 structural work so nothing new is born under the old names:

1. **`smr` → `text`** — the service is described in design.md's Services Program table as a
   "control-plane proxy for text-generation + text-embedding across engines," and its own
   `pyproject.toml` description already reads *"Multi-provider text generation service"*
   (`apps/smr/pyproject.toml:6-7`) — the code already knows what it is; only the name lags.
2. **`GLOBAL_ADMIN` → `SUPER_ADMIN`** — confirmed a **pure rename**, not a semantic merge:
   `ELEVATED_ROLES` (`packages/applications/src/common/tenant-guards.ts:38`) is `readonly
   string[] = [GLOBAL_ADMIN_ROLE]` — exactly one entry — and this is itself asserted by
   `packages/applications/src/common/__tests__/tenant-guards.test.ts:287`,
   `expect(ELEVATED_ROLES).toEqual(['GLOBAL_ADMIN'])`. The role's own doc comment
   (`tenant-guards.ts:22-27`) already records the mirror-image precedent: *"The former
   `SUPER_ADMIN` role was consolidated into `GLOBAL_ADMIN` and retired"* — a real, prior migration
   this ticket's DB-migration phase should imitate the shape of (see §2.3).

This ticket delivers a **complete, counted inventory** (this README's job, done below) and a
**phased, verification-gated mechanical execution plan**. Given the scale confirmed in §2 (roughly
789 non-archive files touch the `smr` string; 421 non-archive files touch `GLOBAL_ADMIN`), this
ticket is explicitly search-and-replace-driven, not a hand-enumerated file-by-file diff — every
phase below names the exact search command an execution agent re-runs at the start of its task
(counts drift as earlier Wave-0 tickets land; re-running is required, not optional) and the
verification gate it must pass before the next phase starts.

**Out of scope**: `docs/archive/**` (343 files touch `smr`, 85 touch `GLOBAL_ADMIN` there —
historical record, explicitly excluded by this ticket-template's search-exclusion rule and by
`.claude/rules/00-project-context.md`'s ticket workflow, which treats archived tickets as closed
history, not live surface); `.cursor/rules/*.mdc` mirrors of `.claude/rules/*.md` are updated only
as a courtesy pass at the very end (Task 11) since they are not authoritative per
`.claude/rules/README.md`'s "Claude Code ignores [Cursor frontmatter]" note, and must never block
this ticket's real gates.

## 2. Current State Evaluation

All counts below are re-derived directly against `feat/loop` via
`git ls-files | grep -v -E '^(\.claude/worktrees/|.*node_modules/|.*/dist/|.*\.venv/|.*__pycache__/|.*/generated/)'`
piped through `grep -l`, executed at authoring time. **Re-run these exact commands at the start of
each task below** — the numbers will have shifted by the time this ticket executes, since it is
explicitly sequenced after seven other Wave-0 tickets land.

### 2.1 `smr` → `text` — scale and shape

| Metric | Count (verified) |
|---|---|
| Files containing `smr` (case-insensitive), excluding `docs/archive/**` and the standard exclusions | **789** |
| Same, within `docs/archive/**` only (out of scope, left untouched) | 343 |

Confirmed structural pieces, each requiring a different rename mechanism:

- **`SMR_*` env-var prefix** — `apps/smr/src/smr/core/config.py` (pydantic-settings,
  `env_prefix="SMR_"` and per-provider sub-prefixes `SMR_OLLAMA_`/`SMR_AZURE_`/`SMR_VERTEX_`/
  `SMR_BEDROCK_`/`SMR_OPENAI_`/`SMR_ANTHROPIC_`/`SMR_LLAMA_CPP_`/`SMR_VLLM_`/etc.). `turbo.json:287-299`
  declares 13 `SMR_*` entries in `globalEnv`, confirmed verbatim: `SMR_ANTHROPIC_BASE_URL`,
  `SMR_ANTHROPIC_DEFAULT_MODEL`, `SMR_EXTERNAL_GUARDRAIL_ENABLED`, `SMR_OPENAI_BASE_URL`,
  `SMR_OPENAI_DEFAULT_MODEL`, `SMR_OPENAI_ORGANIZATION`, `SMR_PORT`, `SMR_SERVICE_TOKEN`,
  `SMR_SERVICE_URL`, `SMR_URL`, `SMR_VERTEX_DEFAULT_MODEL`, `SMR_VERTEX_LOCATION`,
  `SMR_VERTEX_PROJECT`. `.env.sample` (root) and `apps/smr/.env.sample` carry the full set.
- **Root `package.json` `smr:*` scripts** — 15 scripts, confirmed verbatim at `package.json:129-145`:
  `smr:setup[:cpu|:apple|:gpu]`, `smr:dev`, `smr:dev:watch`,
  `smr:test[:unit|:integration|:e2e|:cov|:managed]`, `smr:lint[:fix]`, `smr:typecheck`,
  `smr:format[:check]`.
- **Gateway `IConfigService.getConfigValue('SMR_URL')` call sites** — exactly 3 in production
  code, confirmed: `apps/api/src/modules/health/health.controller.ts:83`,
  `apps/api/src/modules/streaming/smr-proxy.controller.ts:285`,
  `apps/api/src/modules/smr-compat/smr-compat.controller.ts:861` (plus explanatory comments at
  `smr-proxy.controller.ts:279-280` and `smr-compat.controller.ts:860` citing the
  `no-direct-downstream-url-env` lint rule by name — see the lint-gate note below).
- **uv workspace** — root `pyproject.toml:23`, `"apps/smr"` in `[tool.uv.workspace] members`;
  `pyproject.toml:78`, `{ package = "smr" }` (Redis-Stream-boundary services list).
  `apps/smr/pyproject.toml:6`, `name = "smr"`.
- **Dockerfile** — `apps/smr/Dockerfile` exists and is smr-specific (build args, `SERVICE_NAME`,
  healthcheck path). The shared `infrastructure/docker/python-base` is generic and does not
  hardcode `smr`.
- **CI job names** (`.gitlab/ci/*.yml`) — confirmed: `build.yml:210` (`build-smr:` job),
  `build.yml:216` (`needs: [{job: test-smr}]`), `build.yml:219` (`SERVICE_NAME: smr`),
  `test.yml:393` (`test-smr:` job), plus references across `rules.yml`, `publish.yml`, `scan.yml`,
  `validate.yml`, and the root `.gitlab-ci.yml`.
- **Ports docs** — `.claude/rules/00-project-context.md` and `.claude/rules/06-python-services.md`
  (both already provided as this session's project context — SMR port 8862), plus
  `docs/development-guide.md`, `docs/development-patterns-and-standards.md`,
  `docs/architecture/overview.md`, `docs/architecture/environment-configuration-reference.md`,
  `docs/traceability/summarization.md`, `docs/operations/inference/README.md`, and
  `.claude/launch.json`.
- **Grafana dashboards** — 4 files literally named for it (need renaming as artifacts, not just
  content edits), confirmed present: `infrastructure/grafana/dashboards/smr-overview.json`,
  `smr-cache-friendliness.json`, `smr-resilience.json`, `smr-security.json`. Two more reference
  `smr` internally without the filename: `hope-platform-metrics.json`, `agentic-trajectory.json`.
- **Admin-console literal "smr" components** — confirmed present:
  `apps/admin-console/src/features/ai-task-defaults/components/smr-models-section.tsx`,
  `smr-default-provider-control.tsx`, and their two `__tests__/` siblings. Broader concentration
  across `features/ai-task-defaults/**`, `features/playground-llm/**`, `features/ai-models/**`
  (56 files touch the string per the case-insensitive count).
- **SDK literal "smr" references** — confirmed present:
  `packages/agentic-sdk-v2/src/compat/useSMR.ts` (+ `__tests__/useSMR.test.ts`),
  `compat/config-adapter.ts`, `compat/types.ts`, `core/constants.ts`,
  `core/StreamingSessionManager.ts`. `packages/vox-node/src/{client.ts, client.test.ts,
  types/summarization.ts, core/url.ts, core/errors.ts, core/__tests__/transport.test.ts,
  resources/summarization.ts, core/__tests__/url.test.ts, resources/__tests__/summarization.stream.test.ts,
  resources/__tests__/summarization.test.ts}` — 10 files confirmed.
- **`packages/applications` service modules built around the name** (not named in the original
  design brief — confirmed present, material scope): `packages/applications/src/services/smr/`
  (`index.ts`, `streaming/smr-stream-consumer.service.ts` + module + test) and
  `packages/applications/src/services/smr-request/` (`smr-request-enrichment.service.ts`,
  `smr-request.service.module.ts`, `index.ts`).
- **`apps/api/src/modules/smr-compat/`** and **`smr-proxy.controller.ts`** — whole
  module/controller directory and file names built around "smr", even though the gateway's actual
  HTTP route prefix is already `text` (per `.claude/rules/08-vox-sdk.md`'s reference to the SMR
  service and the design brief's note that the service already speaks of itself as text
  generation) — i.e. the **route** was already renamed at some point; the **module/file names**
  were not. Confirm the current route prefix directly (`grep -n "@Controller" apps/api/src/modules/smr-compat/smr-compat.controller.ts`)
  before assuming this, and record the actual finding in Task 1.
- **CI/lint drift gates that hardcode the string**:
  `packages/eslint-plugin-arcaai-internal/rules/no-direct-downstream-url-env.js:23-24` — the
  banned-identifier array literally contains `'SMR_URL'` and `'SMR_SERVICE_URL'` (confirmed
  verbatim), used to catch `process.env.SMR_URL` bypasses of `IConfigService`. Its test fixture
  (`__tests__/no-direct-downstream-url-env.test.js`) hardcodes both strings across several
  assertions. **This must be updated in the SAME phase as the env-var rename, or the lint rule
  silently stops enforcing anything for the new variable name** — a real regression risk, not a
  cosmetic one.
- **`scripts/env-consumer-inventory.py`** — confirmed to reference `smr` in an explanatory comment
  (`:22-23`, explaining `SMR_GATEWAY_URL`'s alias mapping) and in `PY_SERVICES = ["stt", "smr",
  "guardrail", "nlp", "harness", "tts"]` (`:57`). (Note: an earlier, unverified pass claimed a
  larger mapping table and a title string deeper in this file — re-checked directly and not
  found; the two references above are the actual full extent. This correction is recorded here
  precisely because the ticket-template's authoring rule requires re-deriving every citation, and
  this is a case where a first pass overstated a finding.)

### 2.2 `GLOBAL_ADMIN` → `SUPER_ADMIN` — scale and shape

| Metric | Count (verified) |
|---|---|
| Files containing the literal `GLOBAL_ADMIN`, excluding `docs/archive/**` and standard exclusions | **421** |
| Same, within `docs/archive/**` only (out of scope) | 85 |
| **Total** | 506 |

Breakdown by area, non-archive (re-verified directly, `grep -l` file counts — not comment-vs-code
weighted, so these are upper bounds on real editing effort per area):

| Area | Files |
|---|---|
| `packages/applications` | 132 |
| `apps/api` | 118 |
| `apps/admin-console` | 106 |
| `packages/database` | 23 |
| `packages/agentic-sdk-v2` | 17 |
| `packages/domains` | 2 |
| `packages/vox-node` | 0 (confirmed clean) |
| `.claude/rules` | 3 |

Confirmed as a **pure token rename** — one literal string, no directory moves, no structural
package reorganization (contrast with §2.1's `apps/smr` → `apps/text` directory move). But it
touches two genuinely different persistence constructs that need different migration strategies:

1. **`Role.name`** — `packages/database/src/prisma/db_main/rbac.prisma:27`, a plain `String`
   column, **not a Prisma enum**. `GLOBAL_ADMIN` is only a seeded row value
   (`packages/database/src/prisma/db_main/seed/03-role.ts:94`). Renaming this needs a **data
   migration** (`UPDATE "Role" SET name = 'SUPER_ADMIN' WHERE name = 'GLOBAL_ADMIN'`), following
   the shape of the exact precedent this codebase already has for the mirror-image rename:
   `packages/database/src/prisma/db_main/migrations/20260705000000_task_417_consolidate_super_admin_into_global_admin/`
   (confirmed present).
2. **`ChangelogAudience`** — a real Prisma **enum** with a `GLOBAL_ADMIN` member, confirmed:
   `packages/database/src/prisma/db_main/enums.prisma:614-621`:
   ```prisma
   // Filters both the one-time popup and the /changelog list.
   enum ChangelogAudience {
     ALL
     GLOBAL_ADMIN
     TENANT_ADMIN
     @@schema("core")
   }
   ```
   Its generated TS mirror is `packages/domains/src/enums/generated/ChangelogAudience.ts`. This
   needs `ALTER TYPE "core"."ChangelogAudience" RENAME VALUE 'GLOBAL_ADMIN' TO 'SUPER_ADMIN'` per
   `.claude/rules/02-database-prisma.md`. **A confirmed blocker to check first**: the comment block
   immediately preceding this section of `enums.prisma` (`:598-602`) states *"Service Version &
   Release Registry — ChangelogEntry. Exact member values are frozen in the ticket's
   `contracts/service-release.api.yaml` — do not rename without updating that contract."* That
   contract file exists at a path under `docs/archive/**` (a pre-sprint ticket, out of this
   ticket-template's citable set per authoring rule 2) — this ticket must **not** read or cite that
   archived ticket's content, but Task 8 below must still locate and update whatever
   external-facing contract file the live `enums.prisma` comment points to, since the comment
   itself (live code, not archive) makes clear such a contract exists and is load-bearing.
3. **Role-name literals elsewhere** — `ELEVATED_ROLES` is duplicated (deliberately, per its own
   comment, to avoid a `common/` → `services/` import) in exactly two more places:
   `apps/api/src/database/tenant-context.provider.ts:43` and
   `apps/admin-console/src/shared/auth/ability.ts:17` — all three must be renamed together, and a
   fourth check (`services/tenant/constants.GLOBAL_ADMIN_ROLE`, named in
   `tenant-guards.ts:24`'s comment) should be located and confirmed as a fourth site or the same
   one under a different import path.
4. **SDK constant** — `packages/agentic-sdk-v2/src/hooks/useAuth.ts:19`,
   `const IMPERSONATION_ROLES = ['GLOBAL_ADMIN', 'TENANT_ADMIN'] as const;` — a real code constant
   (not prose), confirmed present.
5. **DTOs serializing the role literally** (external-consumer compatibility concern) — found under
   `packages/applications/src/services/{globalSetting, harness-policy, tenant-idp-config,
   tenant-storage-config, prompt-management}/dto/*.ts`. If any of these are already-published
   external API surface, the rename is a breaking change for those consumers — flagged as a
   Risk (§6), decided in Task 1.

No hardcoded-string CI/lint drift gate references `GLOBAL_ADMIN` directly (unlike `smr`'s
`no-direct-downstream-url-env` rule) — the only enforcement mechanism is `ELEVATED_ROLES` as the
single source of truth (§2.2 point 3) plus
`packages/database/src/prisma/db_main/seed/__tests__/seed-idempotency.test.ts`, which needs the
literal string swapped but not its logic changed.

### 2.3 Precedent to imitate

`.claude/rules/README.md`'s own changelog (v6.3.2) documents that TASK-417 (a pre-sprint ticket,
cited here only via the rules file's own changelog entry — not by opening the archived ticket
itself, consistent with the "no pre-sprint ticket citations" rule) "consolidated the legacy
`SUPER_ADMIN` role into `GLOBAL_ADMIN` platform-wide (seed no longer creates `SUPER_ADMIN`;
existing assignments migrated; `ELEVATED_ROLES` is `['GLOBAL_ADMIN']`)." The migration file this
produced (`20260705000000_task_417_consolidate_super_admin_into_global_admin/`, confirmed present
in the live migrations directory — this is schema history, not an archived document, and is fully
citable) is the exact shape this ticket's data migration should follow for the reverse rename.

## 3. Knowledge & Best Practices

- `.claude/rules/02-database-prisma.md` — "NEVER edit a committed migration; roll forward with a
  new migration." The `Role.name` data migration and the `ChangelogAudience` enum-value rename are
  each a **new** migration, authored via the shadow-DB workflow (`§Migration Workflow` in that
  rule): throwaway shadow DB → `db:migrate:create` → apply + diff-empty proof → sync dev DB. Enum
  value rename uses `ALTER TYPE ... RENAME VALUE`, not a drop/recreate.
- `.claude/rules/01-development-workflow.md` §Script Naming — every renamed `smr:*` script becomes
  `text:*`, one-for-one, matching the existing taxonomy (`<target>:<action>`); `text` is not yet
  listed among the taxonomy's target names in that rule's table — this ticket's Task 4 is also
  responsible for updating that rule's own script-taxonomy table (a real doc-drift risk if skipped:
  a future reader of `01-development-workflow.md` would see `smr` as a taxonomy target and be
  confused after this ticket lands).
- `.claude/rules/09-infrastructure-devops.md` §Environment & Secrets Strategy — "New runtime env
  vars go into `turbo.json#globalEnv`." The renamed `TEXT_*` variables are not "new" in the sense
  of new config, but they are new **identifiers**, so the same registration discipline applies:
  update `turbo.json#globalEnv`, `.env.sample` files, and confirm `pnpm env:sync` regenerates
  cleanly (Task 3).
- `.claude/rules/03-domain-layer.md` §Generated Code Discipline — `ChangelogAudience`'s TS mirror
  (`packages/domains/src/enums/generated/ChangelogAudience.ts`) is a **model-layer** generated file
  (`gen:model`'s output, DMMF-derived) — regenerate it with `pnpm gen:model` after the Prisma enum
  rename lands, do not hand-edit it.
- `.claude/rules/_karpathy.md` §3 Surgical Changes — "Touch only what you must." This ticket is the
  one sanctioned exception to that instinct at scale: the whole point is a wide, deliberate,
  single-purpose sweep. The discipline that still applies: each phase's diff should contain
  **only** the rename, never opportunistic unrelated cleanup discovered along the way (log any
  such finds via `spawn_task`-style follow-up notes instead, per this program's own working
  practice, not silently fixed inline).
- **Pitfall — `smr` structural move vs `GLOBAL_ADMIN` token-only rename are different risk
  classes.** The `apps/smr` → `apps/text` directory move changes import paths, breaks anything with
  a relative path into `apps/smr`, and requires `git mv` (preserving history) rather than
  delete+recreate. The `GLOBAL_ADMIN` rename never moves a file. Do not apply the same "phase
  batch" granularity to both — §4 sequences them as clearly separate phase groups for this reason.
- **Pitfall — do not run the `GLOBAL_ADMIN` sweep before the `Role.name` data migration lands.** A
  code-only rename of the CASL/guard literal without the corresponding DB row rename would make
  every existing `GLOBAL_ADMIN`-named row unrecognized by the new code — a full lockout of the
  platform's only elevated role. Sequence data migration first, then code, in the same phase
  window (Task 8 before Task 9), never split across a deploy boundary.

## 4. Implementation Plan

Two independent phase groups (A: `smr`→`text`, B: `GLOBAL_ADMIN`→`SUPER_ADMIN`) that may run in
parallel with each other, but each phase WITHIN a group is strictly sequential (a verification gate
before the next phase starts) because later phases in each group depend on earlier ones compiling
cleanly.

### Group A — `smr` → `text`

#### Task 1 — Re-confirm scope + resolve the `smr-compat`/`smr-proxy` route-vs-name question
- **Agent:** T3 · sonnet-5 · medium (lead)
- **Files:** none (investigation)
- **Approach:** Re-run `git ls-files | grep -v -E '^(\.claude/worktrees/|.*node_modules/|.*/dist/|.*\.venv/|.*__pycache__/|.*/generated/)' | xargs grep -li smr | grep -v '^docs/archive/' | wc -l` and diff against this README's 789 baseline (Wave-0 tickets 700-706 will have changed some files). Run `grep -n "@Controller" apps/api/src/modules/smr-compat/smr-compat.controller.ts` and `apps/api/src/modules/streaming/smr-proxy.controller.ts` to confirm today's actual HTTP route prefixes (§2.1 flagged this as unconfirmed) — record findings before Task 2-7 assume a route rename is or isn't needed.
- **Verify:** A written, current count + the confirmed route-prefix finding, both pasted into this ticket's Implementation Summary before Task 2 starts.

#### Task 2 — Env vars + lint gate + env tooling (must land together)
- **Agent:** T2 · sonnet-5 · medium
- **Files:** `apps/smr/src/smr/core/config.py`, `turbo.json`, `.env.sample` (root),
  `apps/smr/.env.sample`, `apps/harness/.env.sample`, `apps/api/.env.sample`, `apps/nlp/.env.sample`,
  `packages/eslint-plugin-arcaai-internal/rules/no-direct-downstream-url-env.js`,
  `packages/eslint-plugin-arcaai-internal/__tests__/no-direct-downstream-url-env.test.js`,
  `scripts/env-consumer-inventory.py`
- **Approach:** Rename every `SMR_*` identifier to `TEXT_*` (`SMR_URL`→`TEXT_URL`,
  `SMR_OLLAMA_*`→`TEXT_OLLAMA_*`, etc. — one-for-one, no semantic changes) in the pydantic-settings
  classes, then propagate to `turbo.json#globalEnv` (all 13 confirmed entries), every `.env.sample`
  that declares one, the lint rule's banned-identifier array (`'SMR_URL'`→`'TEXT_URL'`,
  `'SMR_SERVICE_URL'`→`'TEXT_SERVICE_URL'`) and its test fixture, and
  `env-consumer-inventory.py`'s two confirmed references (`:22-23` comment, `:57` `PY_SERVICES`
  list — note `PY_SERVICES` holds directory names, so this entry becomes `"text"` only once Task 5
  renames the directory; sequence this sub-edit after Task 5, or defer it and note the ordering
  explicitly). This is the phase the lint rule's own regression protection depends on landing
  atomically per §3's pitfall.
- **Verify:** `pnpm --filter @arcaai/eslint-plugin-arcaai-internal test` (or the package's actual
  test script name — confirm via that package's `package.json`), `pnpm lint`, `pnpm env:sync`
  regenerates `.env.sample` files with zero unexpected diff beyond the rename itself.

#### Task 3 — Root `package.json` scripts + `.claude/rules/01-development-workflow.md` taxonomy table
- **Agent:** T1 · haiku-4-5 · default
- **Files:** `package.json`, `.claude/rules/01-development-workflow.md`
- **Approach:** Rename all 15 confirmed `smr:*` scripts to `text:*` (script bodies also reference
  `apps/smr/src/smr/...` paths — those change together with Task 5's directory move; sequence this
  sub-step after Task 5, or land the script rename with old paths first and fix paths in Task 5 —
  pick the ordering that keeps `pnpm smr:test`-equivalents runnable throughout; do not leave a
  window where neither name works). Add `text` to the target list in
  `.claude/rules/01-development-workflow.md`'s Script Naming table, remove `smr`.
- **Verify:** `pnpm text:test` (post-rename) runs the same pytest suite `pnpm smr:test` used to.

#### Task 4 — Gateway config + module/file renames in `apps/api` and `packages/applications`
- **Agent:** T2 · sonnet-5 · medium
- **Files:** `apps/api/src/modules/health/health.controller.ts`,
  `apps/api/src/modules/streaming/smr-proxy.controller.ts` (+ rename to `text-proxy.controller.ts`
  if Task 1 confirms the route itself should follow),
  `apps/api/src/modules/smr-compat/**` (rename directory per Task 1's finding),
  `packages/applications/src/services/smr/**` → `text/`,
  `packages/applications/src/services/smr-request/**` → `text-request/`, and all `getConfigValue('SMR_URL')`
  call sites (3 confirmed, §2.1) → `getConfigValue('TEXT_URL')`.
- **Approach:** `git mv` each directory to preserve history; update all imports; update the 8
  confirmed test files under `apps/api` whose path or module name contains "smr"
  (`src/__tests__/smr-service-token-migration.test.ts`, `smr-compat.controller.test.ts`,
  `smr-compat-template.service.test.ts`, 4 `smr-proxy*.test.ts` files,
  `tests/e2e/task-562-smr-compat.spec.ts`) to their renamed equivalents.
- **Verify:** `pnpm --filter @arcaai/applications build test`, `pnpm api:build`, `pnpm test:unit`.

#### Task 5 — `apps/smr` → `apps/text` directory move + uv workspace + Dockerfile
- **Agent:** T3 · sonnet-5 · medium (structural move — highest blast-radius single step in Group A)
- **Files:** `apps/smr/**` → `apps/text/**` (148 confirmed `.py` files under `apps/smr/src/smr/`,
  moving to `apps/text/src/text/`), root `pyproject.toml:23,78`, `apps/text/pyproject.toml` (renamed
  `name = "text"`), `apps/text/Dockerfile`, `.gitlab/ci/build.yml` (`build-smr`→`build-text`,
  `SERVICE_NAME: smr`→`text`, `DOCKERFILE: apps/smr/Dockerfile`→`apps/text/Dockerfile`),
  `.gitlab/ci/test.yml` (`test-smr`→`test-text`, cache key, `cd apps/smr`, junit filename), plus the
  remaining CI files (`rules.yml`, `publish.yml`, `scan.yml`, `validate.yml`, root
  `.gitlab-ci.yml`) confirmed to reference the string.
- **Approach:** `git mv apps/smr apps/text`, then `git mv apps/text/src/smr apps/text/src/text`
  (two-step so the outer app-directory rename and the inner Python-package rename are each their
  own reviewable commit). Update every import (`from smr.` → `from text.`) across the moved 148
  files plus any cross-service import from `apps/harness`/`apps/nlp` that reaches into `smr`'s
  package (confirm none exist via `grep -rn "from smr\." apps/ --include=*.py | grep -v apps/smr`
  before assuming zero cross-service imports).
- **Verify:** `uv lock` (root) re-resolves clean with the renamed workspace member; `pnpm
  text:test` (Task 3's renamed script, now pointing at the moved path) passes; `pnpm harness:test`,
  `pnpm nlp:test` unaffected (proves no silent cross-import broke).

#### Task 6 — Admin-console + SDK literal cleanup
- **Agent:** T2 · sonnet-5 · medium, fan-out ×2 (one for `apps/admin-console`, one for
  `packages/agentic-sdk-v2` + `packages/vox-node`)
- **Files:** `apps/admin-console/src/features/ai-task-defaults/components/{smr-models-section,smr-default-provider-control}.tsx`
  (+ tests, rename to `text-*`) and the remaining 52 files with in-content references across
  `features/ai-task-defaults/**`, `features/playground-llm/**`, `features/ai-models/**`;
  `packages/agentic-sdk-v2/src/compat/useSMR.ts` (+ test, → `useText.ts`), `compat/config-adapter.ts`,
  `compat/types.ts`, `core/constants.ts`, `core/StreamingSessionManager.ts`;
  `packages/vox-node/src/{client.ts,client.test.ts,types/summarization.ts,core/url.ts,core/errors.ts,
  core/__tests__/transport.test.ts,resources/summarization.ts,core/__tests__/url.test.ts,
  resources/__tests__/summarization.stream.test.ts,resources/__tests__/summarization.test.ts}`
  (10 confirmed files).
- **Approach:** Rename component/hook files, update imports, update any user-facing copy string
  that literally says "SMR" (not "summarization" — the product concept name stays, only the
  internal service-identifier string changes). `useSMR.ts` is a compat shim per
  `.claude/rules/08-vox-sdk.md` — confirm whether it should become `useText.ts` outright or keep a
  deprecated re-export alias for one release, matching this ticket's own "retired routes keep a
  `redirect()` for one release" pattern-of-precedent from `.claude/rules/13-nextjs-apps.md` (decide
  and record in Task 1's investigation, applied here).
- **Verify:** `pnpm --filter @arcaai/admin-console build lint test`, `pnpm --filter @arcaai/vox
  build test`, `pnpm --filter @arcaai/vox-node build test` (or `pnpm sdk:build`/`pnpm
  sdk-node:build` per the root aliases named in `.claude/rules/08-vox-sdk.md`).

#### Task 7 — Grafana dashboards + docs
- **Agent:** T1 · haiku-4-5 · default
- **Files:** `infrastructure/grafana/dashboards/{smr-overview,smr-cache-friendliness,smr-resilience,smr-security}.json`
  (rename files + internal panel/query references), `hope-platform-metrics.json`,
  `agentic-trajectory.json` (content-only references), `docs/development-guide.md`,
  `docs/development-patterns-and-standards.md`, `docs/architecture/overview.md`,
  `docs/architecture/environment-configuration-reference.md`, `docs/traceability/summarization.md`,
  `docs/operations/inference/README.md`, `.claude/launch.json`, `.claude/rules/00-project-context.md`,
  `.claude/rules/06-python-services.md`.
- **Approach:** Mechanical rename + content sweep. Grafana JSON files: confirm no dashboard UID
  changes (only filename + display title + panel query strings that reference `smr`-prefixed
  metric names — coordinate with whatever metric-name prefix the renamed service actually emits
  post-Task-5, since a dashboard renamed but still querying `smr_*` Prometheus metrics would go
  blank).
- **Verify:** `infrastructure/grafana/dashboards/*.json` are valid JSON (`jq . <file>` on each);
  manual spot-check one dashboard loads in a local Grafana if `pnpm infra:dev:up:observability` is
  running.

### Group B — `GLOBAL_ADMIN` → `SUPER_ADMIN`

#### Task 8 — `Role.name` data migration + `ChangelogAudience` enum rename (must land first, together)
- **Agent:** T3 · sonnet-5 · medium (lead — this is the one task in Group B with real migration risk)
- **Files:** new migration under `packages/database/src/prisma/db_main/migrations/`,
  `packages/database/src/prisma/db_main/enums.prisma`,
  `packages/domains/src/enums/generated/ChangelogAudience.ts` (regenerated, not hand-edited)
- **Approach:** Follow `.claude/rules/02-database-prisma.md`'s shadow-DB migration workflow exactly
  (throwaway `hope_shadow` DB, `db:migrate:create -n task_707_rename_global_admin_to_super_admin`,
  apply + prove empty diff, sync dev DB). The migration SQL does two things: `UPDATE "Role" SET
  name = 'SUPER_ADMIN' WHERE name = 'GLOBAL_ADMIN'` (mirrors the TASK-417 precedent's shape, §2.3),
  and `ALTER TYPE "core"."ChangelogAudience" RENAME VALUE 'GLOBAL_ADMIN' TO 'SUPER_ADMIN'`. Before
  writing the enum rename: **locate the live contract file the `enums.prisma:598-602` comment
  names** (a `contracts/service-release.api.yaml` this comment asserts freezes the enum's member
  values) and confirm whether it lives anywhere in-scope for this sprint or only in
  `docs/archive/**` (§2.2 point 2 — confirmed at authoring time to be archive-only); if
  archive-only, this is a **HUMAN-GATED** call: renaming a value a frozen historical contract
  references may break an external consumer of the Changelog API that this ticket cannot see from
  the live tree alone. Do not proceed with the enum-value rename half of this task without that
  confirmation — the `Role.name` data migration half has no such dependency and may proceed
  independently.
- **Verify:** `pnpm --filter @arcaai/database db:migrate:deploy` on the shadow DB, then `npx prisma
  migrate diff --from-config-datasource --to-schema src/prisma/db_main --script` prints "This is an
  empty migration." per the rule's required proof; `pnpm gen:model` regenerates
  `ChangelogAudience.ts` with the new member and reports no other drift;
  `pnpm --filter @arcaai/database test` passes.

#### Task 9 — Code literal sweep: `packages/applications`, `apps/api`, `packages/database` (seeds)
- **Agent:** T2 · sonnet-5 · medium, fan-out ×3 (one per area — non-overlapping file sets)
- **Files:** 132 files under `packages/applications`, 118 under `apps/api`, seed files under
  `packages/database/src/prisma/db_main/seed/` (`03-role.ts`, `00-constants.ts` — id/name
  constants, `01-policy.ts`, `11-global-setting.ts`, `91-user.ts`, `16-ai-task-default.ts`,
  `11c-consultation-gate-settings.ts`, `11b-tenant-allowed-origins.ts` — all confirmed to reference
  the string in §2.2). Includes the three `ELEVATED_ROLES` sites
  (`packages/applications/src/common/tenant-guards.ts:29,38`,
  `apps/api/src/database/tenant-context.provider.ts:43`) and the `services/tenant/constants`
  location `tenant-guards.ts:24`'s comment names — locate and confirm as a fourth site.
- **Approach:** Literal string rename `'GLOBAL_ADMIN'` → `'SUPER_ADMIN'` everywhere in code,
  comments, and DTO `@ApiProperty` example values (§2.2 point 5 DTOs — flag any that look like
  already-published external contract, per Task 1's classification, rather than silently renaming
  a wire-breaking field). **Must run after Task 8's data migration lands** (§3 pitfall — sequence
  dependency, not parallel with Task 8).
- **Verify:** `pnpm --filter @arcaai/applications build test`, `pnpm api:build`, `pnpm test:unit`,
  `pnpm test:e2e` (cross-tenant/admin-role e2e specs must still pass with the renamed role — these
  are exactly the specs most likely to hardcode the old literal in a fixture).

#### Task 10 — Admin-console + SDK
- **Agent:** T2 · sonnet-5 · medium, fan-out ×2 (`apps/admin-console` / `agentic-sdk-v2`)
- **Files:** 106 files under `apps/admin-console` (including
  `apps/admin-console/src/shared/auth/ability.ts:17`'s `ELEVATED_ROLES` mirror),
  `packages/agentic-sdk-v2/src/hooks/useAuth.ts:19`'s `IMPERSONATION_ROLES` constant, plus the
  remaining 16 `agentic-sdk-v2` files with prose/JSDoc references.
- **Approach:** Same literal sweep. `packages/vox-node` needs no changes (confirmed 0 occurrences,
  §2.2).
- **Verify:** `pnpm --filter @arcaai/admin-console build lint test`, `pnpm --filter @arcaai/vox
  build test`, both-theme manual check on any admin-console screen displaying the role name as
  visible copy (per `.claude/rules/11-ux-ui-principles.md` — a renamed role string appearing in the
  UI is a copy change, not just code).

### Both groups

#### Task 11 — `.claude/rules/*.md` sweep + `.cursor/rules/*.mdc` courtesy pass
- **Agent:** T1 · haiku-4-5 · default
- **Files:** `.claude/rules/00-project-context.md`, `06-python-services.md`, `08-vox-sdk.md`,
  `README.md` (3 confirmed `GLOBAL_ADMIN` references, plus the `smr` port/script references
  already covered in Task 7); `.cursor/rules/{00-project-context,06-python-services}.mdc` mirrors.
- **Approach:** Update the authoritative `.claude/rules/*.md` files first and treat them as the
  gate; the `.cursor/` mirrors are non-authoritative (per `.claude/rules/README.md`'s own framing)
  and updated last, purely for consistency — never block this ticket's completion on them.
- **Verify:** `grep -rli 'smr\|GLOBAL_ADMIN' .claude/rules/ .cursor/rules/` returns only the
  historical-changelog entries in `.claude/rules/README.md` that describe the TASK-417 precedent
  (§2.3) — those stay unchanged, they are dated history, not live naming.

#### Task 12 — Full verification pass, both groups
- **Agent:** T2 · sonnet-5 · low
- **Files:** none (verification only)
- **Approach:** Run every layer gate across the whole monorepo.
- **Verify:** `pnpm lint:all`, `pnpm typecheck:all`, `pnpm format:all`, `pnpm verify` (per
  `.claude/rules/01-development-workflow.md`'s named aggregates), `pnpm test:unit`, `pnpm
  test:integration`, `pnpm test:up:api` + `pnpm test:e2e`, `pnpm text:test` (renamed),
  `pnpm --filter @arcaai/database test`.

## 5. Acceptance Criteria

- [ ] `grep -rliE 'smr' $(git ls-files | grep -v -E '^(\.claude/worktrees/|.*node_modules/|.*/dist/|.*\.venv/|.*__pycache__/|.*/generated/|docs/archive/)')` returns **zero** files (all confirmed non-archive occurrences renamed)
- [ ] `grep -rl 'GLOBAL_ADMIN' $(git ls-files | grep -v -E '^(\.claude/worktrees/|.*node_modules/|.*/dist/|.*\.venv/|.*__pycache__/|.*/generated/|docs/archive/)')` returns **zero** files, except any DTO/contract file Task 1/9 explicitly classified as an intentional compatibility-window exception (documented, not silent)
- [ ] `pnpm --filter @arcaai/database test` passes, including the migration diff-empty proof for both the `Role.name` data migration and the `ChangelogAudience` enum rename
- [ ] `pnpm gen:model` reports no drift after the `ChangelogAudience` regeneration
- [ ] `pnpm lint:all`, `pnpm typecheck:all`, `pnpm verify` all pass
- [ ] `pnpm text:test` (renamed from `smr:test`) passes, running the same suite
- [ ] `uv.lock` re-resolves clean with `apps/text` as the workspace member name
- [ ] `pnpm test:unit`, `pnpm test:integration`, `pnpm test:up:api` + `pnpm test:e2e` all pass,
      including cross-tenant/admin-role e2e specs under the renamed `SUPER_ADMIN` literal
- [ ] `packages/eslint-plugin-arcaai-internal`'s `no-direct-downstream-url-env` rule test suite
      passes against the renamed `TEXT_URL`/`TEXT_SERVICE_URL` identifiers
- [ ] Grafana dashboard JSON files are valid and renamed; no dashboard silently goes blank from a
      stale metric-name query (manually spot-checked)
- [ ] `.claude/rules/01-development-workflow.md`'s script-taxonomy table lists `text`, not `smr`
- [ ] Ticket README's Implementation Summary records: the final confirmed counts from Task 1's
      re-run, the route-prefix finding, the `ChangelogAudience` contract-file HUMAN-GATED decision
      outcome, and pasted output from every verification command above

## 6. Risks & Open Questions

- **HUMAN-GATED (Task 8): the `ChangelogAudience` enum rename may be blocked by a frozen external
  contract.** `enums.prisma:598-602`'s comment names a `contracts/service-release.api.yaml` that
  freezes exact member values; the file this comment points to is only reachable under
  `docs/archive/**` (a pre-sprint ticket), which this ticket-template forbids citing. This is a
  real, live constraint asserted by CURRENT code, not stale archive content — Task 8 must resolve
  whether that contract is still binding (ask the product/API owner) before renaming the enum
  value. If binding, this ticket ships the `Role.name` data migration and every code-literal rename
  except the `ChangelogAudience` enum value, and files a follow-up for that one piece once the
  contract question is resolved — do not silently skip documenting the split.
- **DTO/external-API compatibility (§2.2 point 5, Task 9)**: several DTOs under
  `packages/applications/src/services/*/dto/` may serialize `GLOBAL_ADMIN` as a literal value on
  already-public API responses. Renaming without a compatibility window breaks any external caller
  (including `@arcaai/vox`/`@arcaai/vox-node` SDK consumers) that pattern-matches on the string.
  Task 1 must classify each DTO before Task 9 executes broadly; a compatibility window (accept both
  strings on read, only emit the new one) may be warranted for any DTO Task 1 cannot confirm is
  internal-only.
- **`apps/smr` → `apps/text` is the highest single-step blast radius in this ticket** — 148 Python
  files move, all cross-service imports must be re-verified, and CI job renames must land in the
  same commit as the Dockerfile path change or `build-text`/`test-text` will reference a
  nonexistent path. Task 5 is deliberately assigned T3, not T2, for this reason despite the group's
  overall "mostly T2/T1" tier per the backlog's own primary-tier note.
- **The compat shim `useSMR.ts` (Task 6)** — whether it becomes `useText.ts` outright or keeps a
  deprecated re-export for one release is a real API-surface decision for whoever owns SDK
  versioning, not purely mechanical; flagged for confirmation during Task 1, decided before Task 6
  executes.
- **This ticket is a hard barrier for Wave 1** (`707 → 715 workflow-definition-model`, per the
  backlog dependency graph) — any slippage here delays the entire structural wave, so the phase
  gates in §4 exist specifically to allow partial early completion (Group A and Group B can finish
  independently) rather than an all-or-nothing single PR.

## 7. Implementation Summary

_(Empty at authoring — filled during execution.)_

## 8. Change History

| Date | Change | By |
|---|---|---|
| 2026-08-16 | Ticket authored | Wave-0 ticket-authoring agent |
