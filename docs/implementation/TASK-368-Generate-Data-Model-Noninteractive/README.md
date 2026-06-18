# TASK-368 — Non-interactive, Idempotent `generate-data-model` with Drift `--check`

- **Ticket**: TASK-368 (follow-up to TASK-366)
- **Type**: infrastructure / tooling
- **Created**: 2026-06-18
- **Updated**: 2026-06-18
- **Status**: Completed (tool hardening) + Follow-up implemented (siblings / formatting / missing / ci) — see §6. `generate-data-model:check` is wired into CI (`allow_failure: true`) and currently **reports drift** that is blocked by a pre-existing substantive divergence in the committed generated layer (category-(iv) blockers, §6.4).

> Scope guardrail (original pass): code changes were confined to `packages/tools/`
> plus this document; `packages/domains/src/**/generated` was left untouched.
>
> **Follow-up pass (§6): the user explicitly authorized regenerating the
> generated layer.** Changes are now confined to `packages/tools/**`,
> `packages/domains/src/**/generated` (+ the barrel `index.ts` files), and the
> GitLab CI config. Enum **value sets** were not modified (TASK-367 owns the
> `Session*` removal); the uncommitted TASK-366 `ResourceType.ts` value set + the
> parity test are preserved.

---

## 1. Requirement Analysis

### Description

The data-model generator (`packages/tools/src/generate-data-model/index.ts`) was
**interactive only** — it used `inquirer.prompt` to choose the domain(s) and the
models/enums to emit. An interactive tool cannot run unattended in CI, a
pre-commit hook, or a script, so developers hand-edited the "generated" files
instead of regenerating. That is a direct contributor to the TASK-366 enum drift
(`ResourceType` DB ⇔ domain divergence).

### Business Context

The `enums/generated` and `models/generated` trees are the type-safe contract
between the database and the domain layer. When they silently drift from the
schema, audit-log writes throw at runtime (TASK-366) and the domain layer can't
exhaustively handle every resource type. A mechanical, unattended drift guard is
needed to catch staleness in CI before it ships.

### Acceptance Criteria

- [x] Non-interactive mode via flags, **preserving** interactive behavior in a TTY with no flags.
- [x] `--domain <name|all>` selects domains without prompting (default `all` non-interactively).
- [x] `--yes` / `-y` (and `--ci`) skip all prompts and select everything.
- [x] Auto-detect non-TTY (`!process.stdin.isTTY`) → behave as `--yes --domain all` (pipes/CI).
- [x] Existing `--overwrite <true|false>` keeps working.
- [x] Idempotent: two consecutive runs produce **zero** diff (verified byte-identical).
- [x] `--check` dry-run that writes nothing and exits non-zero on drift, zero when clean.
- [x] npm scripts added (`generate-data-model:all`, `generate-data-model:check`), existing script kept.
- [x] Guardrail 4 honored: characterized the regenerate-diff; left `domains/**/generated` untouched.

---

## 2. Current State Evaluation

### Existing behavior

`main()` discovered "domains" by scanning `node_modules/.prisma/*-prisma-client`,
loaded DMMF via `getPrismaDMMF()` (a dynamic `import()` of the generated client
reading `Prisma.dmmf`), then prompted for domain + item selection and wrote files
through the `model.hbs` Handlebars template.

### Blocking finding — the tool was fully broken on Prisma 7

This repo migrated to the Prisma 7 `prisma-client` generator. As a result:

| Assumption in the old tool | Reality in this repo |
| --- | --- |
| A client exists at `node_modules/.prisma/*-prisma-client` | `node_modules/.prisma` does **not** exist |
| The client is a CJS module exposing `Prisma.dmmf` | Client is ESM TypeScript at `packages/database/src/generated/core-prisma-client/`; it does **not** export `Prisma.dmmf` |

So the original tool exited immediately with *“The .prisma directory does not
exist in node_modules.”* — it could not run interactively **or** otherwise.
Making it merely "non-interactive" was therefore insufficient; the DMMF source
had to be fixed first for any of the acceptance criteria to be demonstrable.

### Dependencies / impact areas

- `packages/tools` already depends on `@prisma/internals@7.5.0`, which exposes
  `getSchemaWithPath`, `getConfig`, and `getDMMF` — the supported way to derive
  DMMF directly from the schema, independent of the generated client.
- `getPrismaDMMF` is shared by sibling generators (`generate-data-entity`,
  `generate-mapper`). They share the same Prisma-7 breakage, but are **out of
  scope** for this ticket, so the shared util was left untouched and the new
  schema-based loading was added **locally** to `generate-data-model`.
- TASK-366 added a bidirectional `ResourceType` parity test; `--check` is the
  general, complementary guard.

---

## 3. Implementation Plan (executed)

1. Replace the `node_modules/.prisma` discovery + `Prisma.dmmf` import with
   schema-based discovery/DMMF, **local** to `generate-data-model`:
   - Discover domains from workspace packages that declare `prisma.schema`.
   - Derive the stable domain name (`core`) from the generator `output`.
   - Load DMMF with `@prisma/internals` `getDMMF`.
2. Add CLI flags: `--domain`, `--yes`/`-y`, `--ci`, `--check`; auto-detect non-TTY.
3. Make output deterministic (stable alphabetical sort of items + index exports;
   preserve DMMF declaration order for enum values).
4. Add `--check` (in-memory generation + diff vs committed; exit code).
5. Add npm scripts; keep the existing one.
6. **Characterize** the would-be regenerate diff and, per guardrail 4, leave the
   generated files unchanged.
7. Verify: type-check, non-interactive run, idempotency, `--check`, clean `git status`.

---

## 4. New flags & scripts — usage

### Flags (`packages/tools/src/generate-data-model/index.ts`)

| Flag | Behavior |
| --- | --- |
| `--domain <name\|all>` | Select domain(s) without the prompt. Unknown name → clear error + non-zero exit. |
| `-y, --yes` | Non-interactive: select all domains and all items. |
| `--ci` | Alias of `--yes`. |
| `--check` | Dry-run: generate in-memory, diff against committed files, print drift, exit non-zero if any. **Writes nothing.** |
| `--overwrite <true\|false>` | Unchanged (kept). In `--check` mode it is forced on so the full would-be output is compared. |
| `-o, --output-path <path>` | Unchanged. Handy for generating into a throwaway dir. |

Auto-detection: when `stdin` is not a TTY (pipes / CI / pre-commit), the tool
behaves as `--yes --domain all`, so it never blocks on a prompt. A bare TTY run
with no flags keeps the **original** interactive prompts.

### npm scripts (`packages/tools/package.json`)

```jsonc
"generate-data-model":        "ts-node src/generate-data-model/index.ts --overwrite true",      // unchanged (interactive)
"generate-data-model:all":    "ts-node src/generate-data-model/index.ts --yes --overwrite true", // non-interactive, regenerate all
"generate-data-model:check":  "ts-node src/generate-data-model/index.ts --check",                // dry-run drift guard (CI)
"typecheck":                  "tsc --noEmit -p tsconfig.json"                                     // no build script existed
```

Run from the repo root, e.g.:

```bash
pnpm --filter @arcaai/tools generate-data-model:check   # CI staleness guard (exit 1 on drift)
pnpm --filter @arcaai/tools generate-data-model:all     # unattended full regenerate
```

---

## 5. Implementation Summary

### 5.1 Files changed (all within `packages/tools/`)

| File | Change |
| --- | --- |
| `src/generate-data-model/index.ts` | Schema-based discovery + DMMF (`@prisma/internals`); `--domain`/`--yes`/`--ci`/`--check` flags + non-TTY auto-detect; deterministic sort of items and index exports; `emit()` sink (write vs in-memory) and `reportDrift()` for `--check`. |
| `src/generate-data-model/types.ts` | `CommandLineOptions` (+`domain`,`yes`,`ci`,`check`); `DomainFolder` now carries `schemaPath`/`schemas`; `ProcessingOptions` (+`mode`,`interactive`,`selectedDomain`,`outputs`). |
| `package.json` | Added `generate-data-model:all`, `generate-data-model:check`, `typecheck`; kept the original `generate-data-model`. |

Determinism details: domains, model/enum **file order**, and all **index
exports** are sorted alphabetically. **Enum value order is preserved from the
schema (DMMF declaration order)** — it is deterministic and semantically
meaningful (Postgres enum sort order / the hand-curated `ResourceType` order), so
it is never re-sorted.

### 5.2 Verification evidence (actual output)

**Type-check** — `pnpm --filter @arcaai/tools typecheck` → exit `0`.

**Non-interactive run / non-TTY auto-detect** — empty stdin, no select flags,
into a temp dir:
```
$ printf '' | ts-node src/generate-data-model/index.ts -o "$TMP/" --overwrite true
EXIT=0 ; files written: 97        # no prompt, no hang
```

**Idempotency** — generate twice into two temp dirs and compare:
```
run1 exit=0 ; run2 exit=0
diff -r run1 run2  →  IDEMPOTENT: byte-identical across two runs (97 files)
```

**`--check` behavior**
```
# Against committed (drifted) files:
check: drift detected — 86 file(s) would change, 11 new file(s) would be created.   EXIT=1
# Against an in-sync tree (-o pointed at a freshly generated tree):
check: no drift — 97 generated file(s) match the committed files.                    EXIT=0
# Unknown domain:
Error generating data models: Unknown domain "bogus". Available: core (or "all").    EXIT=1
```

**No stray churn** — after all runs, `git status` shows only the three
`packages/tools` files (+ this doc); `domains/**/generated` shows only the
pre-existing TASK-366 `ResourceType.ts` modification, untouched by this work.

### 5.3 Guardrail 4 — characterization of the regenerate-diff (why generated files were left alone)

`generate-data-model:check` reports that a full regenerate would **change 86
files and create 11 new files**. The drift has three independent causes:

1. **Formatting.** Committed files were Prettier-reformatted after generation
   (2-space indent, no stray blank lines); the Handlebars template emits 4-space
   indent plus a leading and trailing blank line. This alone touches *every*
   file. Representative — `AuditAction.ts` (identical values & order):
   ```diff
    /* eslint-disable @typescript-eslint/no-explicit-any */
   +
    export enum AuditAction {
   -  CREATE = 'CREATE',
   +    CREATE = 'CREATE',
        ... (2-space → 4-space for every member)
    }
   +
   ```
2. **Value/declaration ordering.** `ResourceType.ts` is hand-curated (TASK-366
   order); regeneration would reorder it to the `audit.prisma` declaration order
   — on top of the formatting change above.
3. **Coverage.** The schema has models/enums never emitted into the domain layer.
   Regenerating would **create 11 new files**: models `FedlClient`, `FedlRound`,
   `FedlUpdate`, `FedlModelVersion`, `Policy`, `RolePolicy`; enums
   `FedlRoundStatus`, `PolicyScope`, `PromptTemplateCategory`,
   `PromptTemplateScope`, `PromptTemplateStatus`.

**Conclusion / decision:** a full regenerate would clobber meaningful manual
edits and produce a large, noisy diff. Per guardrail 4, the deliverable is the
tool hardening + this characterization; **the `domains/**/generated` files were
left unchanged.**

### 5.4 Recommended follow-up (not done here — would change generated files)

To make `generate-data-model:check` green and safe to wire into CI/pre-commit,
reconcile the generator output with the committed style **before** enabling
auto-regen:

1. **Formatting parity.** Either change `model.hbs` to emit 2-space indent with
   no leading/trailing blank lines, or pipe generated output through Prettier
   (`prettier --write`) as a generation step, so format drift disappears.
2. **`ResourceType` ordering.** Decide the single source of truth for value order
   (DB schema vs the hand-curated domain order) and align both, so regeneration
   doesn't reorder it. Keep the TASK-366 parity test as the value-set guard.
3. **Deliberate coverage.** Decide whether the 11 un-generated models/enums
   (Fedl*, Policy/RolePolicy, PromptTemplate*) should exist in the domain layer;
   generate them intentionally (with the matching entity/factory/mapper/repo) or
   exclude them explicitly.
4. **Then** add `pnpm --filter @arcaai/tools generate-data-model:check` to CI
   (and optionally pre-commit) as a staleness gate.
5. **Sibling generators.** `generate-data-entity` and `generate-mapper` share the
   same Prisma-7 DMMF breakage (still reading `node_modules/.prisma` +
   `Prisma.dmmf`). Apply the same schema-based loading when those tools are next
   touched.

---

## 6. Follow-up implementation (siblings / formatting / missing / ci)

The four follow-ups recommended in §5.4 were **explicitly authorized** and
implemented in a second pass. Scope is confined to `packages/tools/**`,
`packages/domains/src/**/generated` (+ barrel `index.ts`), and the GitLab CI
config. No enum value sets were changed; the TASK-366 `ResourceType.ts` value
set and parity test are preserved.

### 6.1 Siblings — Prisma-7 DMMF on `generate-data-entity` + `generate-mapper`

The Prisma-7 schema-based DMMF loading was extracted from `generate-data-model`
into a **shared** helper and adopted by both siblings (preferred over per-tool
copies so all generators stay in lock-step):

| File | Change |
| --- | --- |
| `src/utils/prismaSchema.ts` (**new**) | `discoverPrismaDomains()` + `getDMMFForDomain()` — schema discovery via workspace `prisma.schema` + DMMF via `@prisma/internals` `getSchemaWithPath`/`getConfig`/`getDMMF`. `PrismaDomain` type. |
| `src/utils/index.ts` | Barrel-exports the new helper. |
| `src/generate-data-model/index.ts` | Now consumes the shared helper (replaces its local discovery/DMMF). |
| `src/generate-data-entity/index.ts` | Replaces `node_modules/.prisma` scan + `getPrismaDMMF` with the shared helper; adds a non-TTY guard (selects all domains/items unattended). |
| `src/generate-mapper/generator.ts` | Replaces `getPrismaDMMF` with the shared helper; cleans up dead `fs`/`path` imports. |

**Verification (guarded runs into throwaway dirs):**

```
generate-data-entity  -o /tmp/...   → Processing domain: core … 57 entity files   EXIT=0
generate-mapper       -o /tmp/... -e <entities> -m <models>
                                    → Found 57 entity files and 57 model files
                                      Mapper generation completed successfully     EXIT=0  (57 mappers)
```

Both load DMMF on Prisma 7 again. Note: `generate-mapper` has a **separate,
pre-existing** latent crash (`Cannot read properties of undefined (reading
'fields')`) when a committed entity/model has no matching schema model — i.e. the
orphan `Permission` / `RolePermission` files (§6.4). It is unrelated to DMMF
loading and out of scope here; the guarded run above used orphan-free generated
inputs to exercise the full pipeline.

### 6.2 Formatting + ordering source-of-truth

- **Formatting parity via Prettier post-step.** `emit()` now runs generated
  content through the repo's Prettier (`prettier.resolveConfig` + `prettier.format`)
  before writing/diffing. Config is resolved from the generator source file
  (always inside the repo) so the repo's root `.prettierrc.js` (`singleQuote`,
  2-space) is applied **regardless of output path** (e.g. `-o /tmp`). This makes a
  fresh generate byte-identical to the committed Prettier style for in-sync files
  — proven: **45 files are now byte-identical** to a fresh generate (after the
  Prettier fix, landing the 6 new artifacts, and applying the 4 header-only enums
  in §6.3), and were therefore not rewritten.
- **Ordering source-of-truth = DMMF/schema declaration order (canonical).** The
  generator no longer alphabetically sorts enum values, models, or index exports;
  it preserves DMMF declaration order (which mirrors the `.prisma` source and
  Postgres enum sort order). Domain/file discovery remains alphabetical (Prisma
  reads schema files alphabetically). This is the documented canonical decision.
- **`Bytes → Uint8Array`** scalar mapping added (was defaulting to `any`).
- **No value-set changes.** `ResourceType` is reordered to canonical order with
  its **exact** value set preserved (verified `IDENTICAL_VALUE_SET`; parity test
  still green, it is order-insensitive).

### 6.3 Regeneration + categorization (what was kept)

A full regenerate was produced and every change categorized (formatting-only /
ordering-only / additive-new / substantive). **Kept** changes applied to the
tree:

| Category | Files | Action |
| --- | --- | --- |
| (ii) ordering-only | `enums/generated/ResourceType.ts` | Reordered to canonical DMMF order (values unchanged). |
| (iii) additive new | 4 models (`FedlClient`, `FedlRound`, `FedlUpdate`, `FedlModelVersion`) + 2 enums (`FedlRoundStatus`, `PromptTemplateCategory`) | Added + wired into barrels. |
| (i) formatting-only | 4 enums (`StorageProviderType`, `StorageTopologyType`, `TenantBucketPurpose`, `TenantBucketType`) | Applied — each only **gains** the standard 3-line `eslint-disable` header (no value/order/comment change). Verified via `git diff`: 16 insertions, 0 deletions. |

### 6.4 Category-(iv) BLOCKERS — substantive divergence, NOT overwritten

The headline finding: after formatting was reconciled, the residual diff is **not
formatting** — **37 existing model files + 1 enum have substantive divergence**
from current generator output. These are committed "generated" files that were
produced by an older generator/template and/or hand-edited. The current template
emits `this.x = data.x` (no `?? default`) and always `@VirtualDbProperty() public
Rel: T | undefined`, so the committed defaults/relation-styles/types are
divergences a blind regenerate would silently clobber. Per the safety rule these
were **left at their committed version and are reported as blockers** (not let
through).

**37 substantive model files (cat-iv):** `AiModel, ApiKey, AsrPipeline,
AsrPipelineVersion, AudioRecording, AuditLog, Consultation, ContextItem,
ContextItemVersion, Department, DnaUsageRecord, DnaWritingStyleReport,
DnaWritingStyleVersion, EvalRun, EvalScore, GoldenCase, GoldenSet,
HarnessAuditEvent, Highlight, KnowledgeChunk, KnowledgeDocument, Media,
NamedEntity, PromptTemplate, PromptUsageRecord, PromptVersion, Role,
StorageAccessKey, SummaryMeta, TenantBucket, TenantFrontendConfig,
TenantStorageConfig, TranscriptionJob, UserDepartment, User, UserRoleAssignment,
UserVoiceProfile`. Representative deltas: relations added (`@VirtualDbProperty()`);
constructor default initializers dropped (`?? []`/`?? false`/`?? Enums.X.Y`); Json
columns `any → JsonValue`; nullability flips (e.g. `tenantId: string | null →
string`); relation style `Rel?: T → Rel: T | undefined`.

**1 substantive enum (cat-iv):** `PermissionAction` — generator output adds
`MANAGE, LIST, EXPORT` (present in schema, absent from the committed enum). Left
committed (a value-set change; out of scope).

**Comment/JSDoc-loss (6, left committed):** 5 models lose hand-authored JSDoc
(`GlobalSetting`, `HarnessPolicyChange`, `HarnessPolicy`, `PipelinePolicyChange`,
`PipelinePolicy` — e.g. the WORM-table invariant and `scope`/`scopeId` polymorphism
notes) and `ConsultationStatus` loses a `// TASK-355` note. The generator does not
re-emit hand-written comments, so these are **preserved** (not regenerated) to keep
the documentation. (Distinct from the 4 header-only enums, which gain only
`eslint-disable` boilerplate and were therefore **applied** as category-(i)
formatting — see §6.3.)

**Orphans (2, untouched):** `PermissionModel.ts` / `RolePermissionModel.ts` exist
on disk + barrel but have **no** schema model (RBAC permission→policy refactor).
They are still referenced by committed `RoleModel.RolePermissions` + the
`Permission`/`RolePermission` mappers, so their barrel exports were **kept** (a
true regenerate would drop them and break the build). Schema↔domain drift to
reconcile separately.

**Missing artifacts that could NOT be landed (5, reported per "report if a new
artifact can't compile cleanly"):** `Policy`, `RolePolicy` models + `PolicyScope`,
`PromptTemplateScope`, `PromptTemplateStatus` enums. These enum names already
exist as **hand-authored string-union types** in out-of-scope files —
`PolicyScope` in `repositories/policy/PolicyFactory.ts`; `PromptTemplateScope` /
`PromptTemplateStatus` in `entities/generated/core/PromptTemplateEntity.ts`.
Generating enum mirrors with the same names produces duplicate top-level exports
(`TS2308`), and `PolicyModel`/`RolePolicyModel` depend on `Enums.PolicyScope`.
Reconciling requires editing those out-of-scope files (union type → generated
enum), which is a deliberate refactor for a separate ticket.

### 6.5 Diff stats

| Area | Modified | New |
| --- | --- | --- |
| `packages/tools/**` | `generate-data-model/index.ts`, `generate-data-entity/index.ts`, `generate-mapper/generator.ts`, `utils/index.ts` (+ `generate-data-model/types.ts`, `package.json` from pass 1) | `utils/prismaSchema.ts` |
| `packages/domains/src/**/generated` | `enums/generated/ResourceType.ts` (reorder), `enums/generated/{StorageProviderType,StorageTopologyType,TenantBucketPurpose,TenantBucketType}.ts` (header-only), `enums/generated/index.ts`, `models/generated/core/index.ts` | `models/generated/core/{FedlClient,FedlRound,FedlUpdate,FedlModelVersion}Model.ts`, `enums/generated/{FedlRoundStatus,PromptTemplateCategory}.ts` |
| CI | `.gitlab/ci/rules.yml`, `.gitlab/ci/validate.yml` | — |

> Hygiene note: `generate-data-model/index.ts` now imports `prettier`, which
> resolves via pnpm workspace hoisting (root devDependency). Declaring it
> explicitly under `@arcaai/tools` dependencies is recommended but requires a
> root `pnpm-lock.yaml` update (outside this task's file scope), so it was left
> as a follow-up.

### 6.6 CI wiring (GitLab)

Added an **additive** validate-stage job + a change-path rule (matching existing
conventions: `.node-base`, `node:22-alpine`, `needs: install-node` optional,
pnpm install/cache from the base):

```yaml
# .gitlab/ci/validate.yml
generate-data-model-check:
  stage: validate
  extends: .node-base
  needs:
    - job: install-node
      optional: true
  allow_failure: true     # TEMPORARY — see below; remove to make drift blocking
  script:
    - pnpm --filter @arcaai/tools generate-data-model:check
  rules:
    - !reference [.rules-data-model, rules]
```

```yaml
# .gitlab/ci/rules.yml — new fragment
.rules-data-model:
  rules:
    - !reference [.rules-always, rules]
    - !reference [.rules-cicd-always, rules]
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
      changes:
        paths:
          - packages/database/src/prisma/**/*.prisma
          - packages/domains/src/**/generated/**/*
          - packages/tools/src/generate-data-model/**/*
        compare_to: refs/heads/main
    - if: $PIPELINE_TYPE == "dev"
    - if: $PIPELINE_TYPE == "staging" || $PIPELINE_TYPE == "main" || $PIPELINE_TYPE == "feature"
      changes:
        - packages/database/src/prisma/**/*.prisma
        - packages/domains/src/**/generated/**/*
        - packages/tools/src/generate-data-model/**/*
```

The check reads `.prisma` schema files directly via `@prisma/internals` — **no
database connection / `db:generate`** required. `allow_failure: true` is
deliberate and **temporary**: the category-(iv) blockers (§6.4) mean the check
reports drift today, so a hard-fail gate would red every pipeline that touches
those paths. Once the divergence is reconciled, delete the `allow_failure` line
to make drift a hard failure.

### 6.7 Verification evidence

| Check | Command | Result |
| --- | --- | --- |
| Siblings load DMMF + run | guarded `generate-data-entity -o /tmp` / `generate-mapper -o /tmp -e <tmp-entities> -m <tmp-models>` | EXIT 0 / EXIT 0; 57 entity + 57 model classes, 59 files each (incl. indexes) |
| Domains build (typecheck) | `pnpm --filter @arcaai/domains build` | **EXIT 0** |
| Tools typecheck | `pnpm --filter @arcaai/tools typecheck` | **EXIT 0** |
| Tools lint | `ReadLints` on changed tool files | no errors |
| ResourceType parity | `vitest run …resourceType.enum-parity.test.ts` | **2 passed** |
| Drift check (before) | pass-1 baseline | drift: **86 change + 11 create** (EXIT 1) |
| Drift check (after) | `generate-data-model:check` | drift: **46 change + 5 create** (EXIT 1) — blocked by §6.4 cat-(iv) |

The before→after drop (86→46 change, 11→5 create) reflects the Prettier/ordering
reconciliation (formatting drift eliminated), the 6 landed new artifacts, and the
4 header-only enums applied in §6.3. The remaining **46 change + 5 create** is
exactly: **37** cat-(iv) model divergences + **`PermissionAction`** (value-set) +
**6** comment/JSDoc-loss files (preserved) + the **2** additive barrels
(`enums`/`models` index) + the **5** un-landable collision artifacts — none
clearable without overwriting hand-edits or editing out-of-scope files. (37 + 1 +
6 + 2 = 46 change; 5 create.)

---

## 7. Change History

| Date | Change | Files |
| --- | --- | --- |
| 2026-06-18 | Made `generate-data-model` Prisma-7-runnable (schema-based DMMF), non-interactive (`--domain`/`--yes`/`--ci` + non-TTY auto-detect), deterministic, and added a no-write `--check` drift guard; added npm scripts. Characterized the regenerate-diff and left `domains/**/generated` unchanged per guardrail 4. | `packages/tools/src/generate-data-model/index.ts`, `packages/tools/src/generate-data-model/types.ts`, `packages/tools/package.json`, this README |
| 2026-06-18 | Follow-up (authorized, §6): shared Prisma-7 DMMF helper adopted by `generate-data-entity` + `generate-mapper`; Prettier post-step + DMMF declaration order as canonical; regenerated + categorized the domain layer (kept ordering/new, flagged 37 models + `PermissionAction` as cat-(iv) blockers, 5 artifacts un-landable due to union-type collisions); landed 6 new artifacts (`Fedl*`, `FedlRoundStatus`, `PromptTemplateCategory`) + wired barrels; added GitLab CI drift gate. `@arcaai/domains` build + tools typecheck green; `:check` still red (cat-(iv) blockers). | `packages/tools/src/{generate-data-model/index.ts,generate-data-entity/index.ts,generate-mapper/generator.ts,utils/index.ts,utils/prismaSchema.ts}`, `packages/domains/src/enums/generated/{ResourceType.ts,index.ts,FedlRoundStatus.ts,PromptTemplateCategory.ts}`, `packages/domains/src/models/generated/core/{index.ts,FedlClientModel.ts,FedlRoundModel.ts,FedlUpdateModel.ts,FedlModelVersionModel.ts}`, `.gitlab/ci/{rules.yml,validate.yml}`, this README |
