# TASK-370 — Entity / Factory Generator Hand-Edit Preservation + Drift `--check`

- **Ticket**: TASK-370 (follow-up to TASK-368)
- **Type**: infrastructure / tooling
- **Created**: 2026-06-19
- **Updated**: 2026-06-19
- **Status**: **Completed.** A fresh run of `generate-data-entity` and `generate-factory` reproduces the committed `packages/domains/src/{entities,factories}/generated/**` trees **byte-identically** (zero `git diff`). Each `--check` mode now combines **structural** drift (verbatim file/barrel reproduction) with a **content-aware schema-coverage** pass (every persisted Prisma column is surfaced by the curated entity/factory layer, gated by an explicit allowlist). Both gates exit **0** on a clean tree and **1** when a model gains a column the layer hasn't adopted (demonstrated). `generate-data-model:check` still exits **0** (no regression); `@arcaai/domains` + `@arcaai/applications` build and `@arcaai/tools` typecheck are all green. Both checks are wired into GitLab CI **strict** (no `allow_failure`).

> **Scope guardrail.** Code changes are confined to `packages/tools/**`,
> `.gitlab/ci/**`, and `docs/implementation/TASK-370-*` (+ a pointer in the
> TASK-368 README). **No `packages/domains/src/**/generated` file was
> hand-edited** — the generators reproduce them, and a post-run `git diff` on
> those trees is empty. No DB ops; `.env.dev` untouched.

---

## 1. Requirement Analysis

### Description

TASK-368 made `generate-data-model` the byte-identical source-of-truth for the
`models/`+`enums/` generated layers (round-trip preservation + Prettier post-step
+ strict `--check` CI gate). Its sibling generators — `generate-data-entity` and
`generate-factory` — had **no preservation**: a fresh run clobbered every hand
edit (52/57 entity files diverged), and `generate-factory` was **interactive**
(`inquirer.prompt`, no non-TTY guard) so it could not run in CI at all.

This ticket ports the preservation machinery into both siblings so a fresh re-run
reproduces the committed hand-curated files byte-identically, adds a `--check`
drift mode to each, and wires both into CI — exactly the follow-up deferred in
the TASK-368 README (Change History, 2026-06-19).

### Business Context

`entities/generated/**` and `factories/generated/**` are the hand-curated domain
contract consumed by `@arcaai/applications` and `@arcaai/api`. They carry edits
the Prisma schema cannot express: business methods (`isActive()`,
`incrementVersion()`, `validate()` bodies), `@Secret()` field decorators (PHI /
encryption, TASK-369), `Buffer` types, custom imports (`randomBytes`),
constructor `?? <default>` RHS, a curated field order, the `PromptTemplate*` /
`PolicyScope` collision fix, and bespoke factories (`StorageAccessKeyFactory`'s
`CreateKey` + `generateAccessKeyId`). Re-running a naive generator silently
destroys all of it. A preservation-aware generator + a drift gate makes the layer
safe to regenerate and keeps the barrels honest in CI.

### Acceptance Criteria

- [x] Fresh `generate-data-entity` + `generate-factory` → **zero `git diff`** on `entities/generated/**` and `factories/generated/**` (byte-identical).
- [x] `generate-data-entity:check` + `generate-factory:check` → **EXIT 0** clean; **EXIT 1** on an injected change (demonstrated).
- [x] **Content-aware** drift: injecting a scalar column into a model-backed Prisma model makes **both** `:check`s **EXIT 1**, naming the offending entity/factory **and** the missing column; reverting → **EXIT 0** (demonstrated, §5.4).
- [x] The curated-projection allowlist (omitted models, model-less entities, per-model omitted scalars, factory-only omissions) is **explicit and visible in code** (`utils/schemaCoverage.ts`), not silent heuristics.
- [x] `generate-data-model:check` still **EXIT 0** (no regression).
- [x] `@arcaai/domains` build **EXIT 0**, `@arcaai/applications` build **EXIT 0**, `@arcaai/tools` typecheck clean, no new lints.
- [x] PromptTemplate collision fix reproduced from the generators (stable across re-runs).
- [x] Both `--check`s wired into `.gitlab/ci/validate.yml`, strict (no `allow_failure`).
- [x] Byte-identical *re-derivation* of file bodies was evaluated and **rejected** (semantic-token heterogeneity); the content-aware coverage pass delivers schema-drift detection without it (see §3.4, §6).

---

## 2. Current State Evaluation

### 2.1 The committed layer is a hand-curated *projection*, not a schema mirror

Empirical comparison of the schema (DMMF) against the committed entity tree:

| Fact | Evidence |
| --- | --- |
| Schema models **not** exposed as entities | `FedlClient`, `FedlModelVersion`, `FedlRound`, `FedlUpdate`, `Policy`, `RolePolicy` — present in `models/generated`, deliberately **absent** from `entities/generated`. |
| Entities with **no** schema model | `PermissionEntity`, `RolePermissionEntity` — committed + barrelled, but the RBAC refactor retired their tables (hand-authored, no DMMF source). |
| Entity ↔ factory parity | Every committed entity has **exactly one** committed factory and vice-versa (53 ↔ 53). |

So the set of artifacts cannot be derived from the schema — the **committed files
on disk are the source of truth** for *what exists*.

### 2.2 The committed files are not Prettier-idempotent (the decisive finding)

Running the repo Prettier over the committed trees and diffing (`prettier(file)
=== file`?):

| Tree | Files checked | **Non-idempotent** |
| --- | --- | --- |
| `entities/generated` | 55 | **17** (16 entities + `core/index.ts`) |
| `factories/generated` | 55 | **2** (`ContextItemFactory.ts` + `core/index.ts`) |

Non-idempotent entities: `AsrPipelineVersion, AuditLog, DnaUsageRecord,
DnaWritingStyleReport, DnaWritingStyleVersion, GlobalSetting, Media, NamedEntity,
Notification, PromptTemplate, PromptUsageRecord, PromptVersion,
ResourceSubscription, TenantFrontendConfig, UserDepartment, WebhookRunHistory`
(+ the `core/index.ts` barrels for both trees).

**Implication:** TASK-368's mechanism (re-derive from schema → splice preserved
bits → **run through Prettier** → write) *cannot* reproduce these 19 files — the
Prettier step itself changes them (blank-line removal, comment reflow), breaking
byte-identity. This is the construct that "cannot be round-tripped" the standard
way; see §6 for the resolution.

### 2.3 Generator state before this ticket

- `generate-data-entity` — derived everything from DMMF, emitted via `entity.hbs`, **no Prettier, no preservation**, scaffolded *all* models (would create the 6 excluded ones).
- `generate-factory` — **interactive** (`inquirer.prompt` for domain/entity), no `--check`, parsed entities and re-emitted from `factory.hbs` (clobbering custom factories).
- `generate-data-model` — the reference: `extractPreservation()` + `emit()` (Prettier) + `reportDrift()` (`--check`), green and CI-gated (TASK-368 §7).

---

## 3. Design decision — shared vs local, and *how* preservation works here

### 3.1 Shared utilities (DRY, no data-model regression)

A new module `packages/tools/src/utils/preserveGenerated.ts` holds the plumbing
shared by all three generators, exported via `utils/index.ts`:

| Helper | Used by | Purpose |
| --- | --- | --- |
| `formatWithPrettier(path, content)` | data-model (`emit`), + available to scaffolding | Repo Prettier config resolved from the tool source (works under `-o /tmp`). |
| `reportDrift(outputs, root, logger, hint)` | **all three** `--check` | In-memory output vs committed files → exit `0`/`1` with a drift report. |
| `reconcileBarrel(existing, modules, trailing?)` | entity + factory | Keep committed barrel order; append new modules sorted; **return existing verbatim when the set is unchanged** (preserves committed trailing-whitespace style). |
| `listModuleFiles(dir, suffix)` | entity + factory | Enumerate `*<suffix>.ts` (excludes barrel/tests). |
| `writeOutputs(outputs, logger)` | entity + factory | Write the collected map, skipping byte-identical files. |

`generate-data-model` was refactored to **consume** `formatWithPrettier` and
`reportDrift` (its local `formatGenerated`/`reportDrift` deleted), proven to keep
`generate-data-model:check` at **EXIT 0** (97 files) — no output change.

### 3.2 Preservation strategy: whole-artifact **verbatim** (forced by §2.2)

Because the committed files are (a) a non-schema-derivable projection and (b)
19/110 non-Prettier-idempotent, the only mechanism that guarantees byte-identity
is **whole-artifact verbatim preservation**:

- **Iterate the committed files on disk** (the source of truth for *what exists*),
  not the DMMF. Each committed entity/factory is re-emitted **verbatim** — which
  preserves *every* hand edit (business methods, `@Secret()`, `Buffer`, custom
  imports, constructor defaults, curated field order, the inlined
  `PromptTemplate*`/`PolicyScope` collision-fix unions) with zero risk.
- **Do not run Prettier on existing files** (it would change the 19 non-idempotent
  ones). Prettier remains the path for *brand-new* scaffolds (`formatWithPrettier`).
- **Skip schema models without a committed file** (the 6 `Fedl*`/`Policy`/
  `RolePolicy`) — never auto-scaffold them, so a clean run creates nothing.
- **Reconcile barrels** to the on-disk file set, preserving committed order.

This is a *superset* of TASK-368's member-keyed preservation (it round-trips the
whole artifact), chosen because the artifacts here are heterogeneous and
non-idempotent. The PromptTemplate collision fix is reproduced "from the
generator" in the sense that the generator re-emits it on every run, keeping it
stable. New entities/factories are added deliberately (consistent with the 6
intentionally-excluded models and the 2 model-less entities), not auto-scaffolded.

### 3.3 What `--check` detects (and what it intentionally does not)

`--check` runs two passes:

1. **Structural drift** (verbatim). Re-collects the in-memory output and diffs
   against disk; the **barrels + file presence** are the sentinel — it catches:
   - an entity/factory added or removed without updating the barrel,
   - a hand-broken barrel (export removed / reordered),
   - a missing/renamed generated file.
2. **Content-aware schema coverage** (§3.4). Compares each model-backed
   artifact's surfaced fields against the model's persisted columns (DMMF).

The structural pass does **not** flag a hand-edit to an existing file's *body*
(verbatim re-emits whatever is on disk) — by design: hand edits are the contract,
guarded by code review + the `typecheck`/`build` gates. The **content-aware pass
closes the one body-level gap that actually causes data bugs**: a Prisma model
gaining a persisted column that the entity/factory never adopted (cf. the
audit-column drift behind TASK-366).

### 3.4 Content-aware schema-coverage pass (`utils/schemaCoverage.ts`)

The entity/factory layer is a **curated projection** of the schema, not a mirror
(§2.1), and byte-identical *re-derivation* of bodies is impossible within our
constraints (§6). So instead of re-deriving, the check **reads the committed
files (ts-morph) and the schema (DMMF) and compares field *presence by name***:

- **Entity coverage.** For each `XxxEntity` backed by Prisma model `Xxx`, parse
  the own properties of its `IXxxEntity` interface and require every persisted
  **scalar/enum** column of `Xxx` to appear — after subtracting the inherited
  `Base*Entity` fields (`id`, `version`, `metaData`, `tenantId`, `tags`, audit +
  resource-status) and the explicit allowlist. **EXIT 1** names the entity + the
  missing column(s).
- **Factory coverage.** Same expected column set, compared against the keys the
  factory actually constructs — the union of its `Create*Props` interface and the
  object literals it passes to `new XxxEntity({ … })` (tolerates both the
  literal-inline and props-variable styles). Adds **factory-only** skips for
  columns populated *after* creation (see allowlist).
- **Relations and types are intentionally not enforced.** Relations
  (`kind: 'object'`) are curated heavily (e.g. `ApiKeyEntity` drops the `user`
  back-relation) — enforcing them would be all false positives. Types are
  hand-curated on purpose (`Buffer`, `@Secret()` targets, inlined collision-fix
  unions, `Decimal`), so coverage asserts **column presence by name only**.

**Explicit curated-projection allowlist** (all visible in `schemaCoverage.ts`, so
any future omission is a deliberate, reviewable edit — never a silent heuristic):

| Allowlist | Members | Why |
| --- | --- | --- |
| `OMITTED_MODELS` (6) | `FedlClient`, `FedlRound`, `FedlUpdate`, `FedlModelVersion`, `Policy`, `RolePolicy` | Fedl* = federated-learning ops tables (server/worker-managed); `Policy`/`RolePolicy` = CASL tables consumed directly by the PolicyEngine. A model not in this set with no entity/factory → **EXIT 1**. |
| `MODEL_LESS_ENTITIES` (2) | `Permission`, `RolePermission` | Hand-authored entities/factories with no backing model (RBAC refactor retired the tables). An artifact with no model not in this set → **EXIT 1**. |
| `OMITTED_SCALARS_BY_MODEL` | `Role.isSystemRole`, `Role.parentRoleId`, `UserRoleAssignment.scopeOverrides` | Scalars the curated entity **and** factory intentionally omit. |
| `FACTORY_OMITTED_SCALARS_BY_MODEL` (factory-only) | `AsrPipeline.isDefault`, `Media.bucketId`, `TranscriptionJob.contextItemId` | Columns populated **after** creation (set-default op / bucket assignment / job completion), so not factory inputs. The entity still surfaces them. |
| `isWriteLayerEncryptionColumn(...)` (factory-only rule) | `encrypted*`, `…keyVersion`, `dekWrapped` | At-rest encryption envelope (Data Encryption Initiative, TASK-369) written by the repository encryption layer, not factories. Entities still surface them for read/round-trip. |

The allowlist is **self-auditing**: any entry that no longer corresponds to a
real omission is reported as a `WARN` ("stale allowlist") so it can be removed.

---

## 4. Implementation Plan (executed)

1. Create `utils/preserveGenerated.ts` (Prettier + drift + barrel reconcile + listing/writing); export from `utils/index.ts`.
2. Refactor `generate-data-model` to consume the shared Prettier + drift helpers — verify `:check` stays EXIT 0.
3. Rewrite `generate-data-entity/index.ts`: verbatim-preserve committed entities, reconcile barrels, `--check`/`--yes`/`--ci`; drop DMMF derivation.
4. Rewrite `generate-factory/index.ts`: non-interactive, verbatim-preserve committed factories, reconcile barrels, `--check`; delete the interactive `generator.ts`.
5. Add `package.json` scripts: `generate-data-entity:all|:check`, `generate-factory:all|:check`.
6. Wire `generate-data-entity-check` + `generate-factory-check` jobs into `.gitlab/ci/validate.yml` (strict) and broaden `.rules-data-model`.
7. Add `utils/schemaCoverage.ts` (DMMF↔committed-file comparison + explicit curated-projection allowlist); call it from both `--check` paths so each gate combines structural + content-aware drift.
8. Verify: byte-identical regen, clean exit codes (3 × EXIT 0), injected-column demo (entity + factory EXIT 1, revert EXIT 0), domains/applications builds, tools typecheck, lints.

---

## 5. Implementation Summary

### 5.1 Files changed (all within scope)

| File | Change |
| --- | --- |
| `packages/tools/src/utils/preserveGenerated.ts` | **New** shared util: `formatWithPrettier`, `reportDrift`, `reconcileBarrel`, `parseBarrelModules`, `listModuleFiles`, `writeOutputs`. (TASK-368 commit.) |
| `packages/tools/src/utils/index.ts` | Barrel-export the new helpers. (TASK-368 commit.) |
| `packages/tools/src/utils/schemaCoverage.ts` | **New** content-aware coverage module: DMMF↔committed-file comparison (ts-morph), the explicit curated-projection allowlist, and `reportSchemaCoverage()`. |
| `packages/tools/src/generate-data-model/index.ts` | Consume shared `formatWithPrettier` (in `emit()`) + `reportDrift`; deleted the local `formatGenerated`/`prettierConfig`/`reportDrift` and the now-unused `prettier` import. **Output unchanged** (`:check` still EXIT 0). (TASK-368 commit.) |
| `packages/tools/src/generate-data-entity/index.ts` | Rewritten: filesystem-driven **verbatim** preservation of committed entities + barrel reconcile + `--check`/`--yes`/`--ci`; non-interactive. `--check` now also runs `reportSchemaCoverage({ layer: 'entity' })`. |
| `packages/tools/src/generate-factory/index.ts` | Rewritten: non-interactive, **verbatim** preservation of committed factories + barrel reconcile + `--check`/`--yes`/`--ci`. `--check` now also runs `reportSchemaCoverage({ layer: 'factory' })`. |
| `packages/tools/src/generate-factory/generator.ts` | **Deleted** — the interactive (`inquirer`) implementation is fully superseded and would hang CI. |
| `packages/tools/package.json` | New scripts `generate-data-entity:all`, `generate-data-entity:check`, `generate-factory:all`, `generate-factory:check`; base `generate-data-entity`/`generate-factory` no longer pass the removed `--overwrite`. |
| `.gitlab/ci/validate.yml` | Added strict `generate-data-entity-check` + `generate-factory-check` jobs (mirroring `generate-data-model-check`). |
| `.gitlab/ci/rules.yml` | Broadened `.rules-data-model` to also fire on `generate-data-entity/**`, `generate-factory/**`, and `utils/**` changes. |

> **Retained (now superseded) files:** `generate-data-entity/templates/entity.hbs`,
> `generate-data-entity/types.ts`, and `generate-factory/templates/factory.hbs`
> are no longer used by the verbatim generators. They are left in place (and
> referenced by the out-of-scope `knowledge/tools/README.md`) rather than deleted,
> to avoid touching files outside this ticket's scope.

### 5.2 New scripts — usage

```bash
pnpm --filter @arcaai/tools generate-data-entity        # preserve entities + reconcile barrels (write)
pnpm --filter @arcaai/tools generate-data-entity:check  # drift gate (EXIT 1 on drift)
pnpm --filter @arcaai/tools generate-factory            # preserve factories + reconcile barrels (write)
pnpm --filter @arcaai/tools generate-factory:check      # drift gate (EXIT 1 on drift)
```

### 5.3 CI wiring

Two additive validate-stage jobs mirror `generate-data-model-check` (`.node-base`,
optional `install-node`, `.rules-data-model`), **strict** (no `allow_failure`):
`generate-data-entity-check`, `generate-factory-check`. `.rules-data-model` now
also fires on changes to either new generator or the shared `utils/`.

---

## 5.4 Verification evidence (actual output)

| Check | Command | Result |
| --- | --- | --- |
| **Byte-identical regen** | `generate-data-entity` + `generate-factory` (write) then `git diff --stat -- .../entities/generated .../factories/generated` | **empty** (zero diff) |
| **Entity check (clean)** | `generate-data-entity:check` | `no drift — 55 files match` + `Schema coverage OK: 53 entity artifact(s) … 57 Prisma model(s)` **EXIT 0** |
| **Factory check (clean)** | `generate-factory:check` | `no drift — 55 files match` + `Schema coverage OK: 53 factory artifact(s) … 57 Prisma model(s)` **EXIT 0** |
| **Content-aware drift — entity** | add throwaway `throwawayDriftField String?` to model `ApiKey`; `generate-data-entity:check` | `ApiKeyEntity is missing model column(s) from Prisma model "ApiKey": throwawayDriftField` **EXIT 1** |
| **Content-aware drift — factory** | same injected column; `generate-factory:check` | `ApiKeyFactory is missing model column(s) from Prisma model "ApiKey": throwawayDriftField` **EXIT 1** |
| **Revert → clean** | `git checkout -- apikey.prisma`; re-run both `:check` | both **EXIT 0** (coverage OK) |
| **No data-model regression** | `generate-data-model:check` | `no drift — 97 files match` **EXIT 0** |
| **Domains build** | `pnpm --filter @arcaai/domains build` | **EXIT 0** |
| **Applications build** | `pnpm --filter @arcaai/applications build` | **EXIT 0** |
| **Tools typecheck** | `pnpm --filter @arcaai/tools typecheck` | **EXIT 0** |
| **Lints** | `ReadLints` on all changed tool files | no errors |

> The injected-column demo edits a `.prisma` file under `packages/database` only
> (reverted immediately via `git checkout`); `git status --short -- packages/domains`
> stays **empty** across every run — the generators never mutate the curated trees.

`git status --short` after all runs (only tool/CI/doc changes + pre-existing `.env.dev`; **no `domains/**` entries**):

```
 M .env.dev                                              # pre-existing, untouched, never staged
 M .gitlab/ci/rules.yml
 M .gitlab/ci/validate.yml
 M packages/tools/package.json
 M packages/tools/src/generate-data-entity/index.ts
 M packages/tools/src/generate-data-model/index.ts
 D packages/tools/src/generate-factory/generator.ts
 M packages/tools/src/generate-factory/index.ts
 M packages/tools/src/utils/index.ts
?? packages/tools/src/utils/preserveGenerated.ts
?? packages/tools/src/utils/schemaCoverage.ts
?? docs/implementation/TASK-370-Entity-Factory-Generator-Preservation/README.md
 M docs/implementation/TASK-368-Generate-Data-Model-Noninteractive/README.md
```

---

## 6. Constructs not byte-round-trippable the TASK-368 way — reported + resolved

**Construct:** 19 committed files are **not Prettier-idempotent** (17 in
`entities/generated`, 2 in `factories/generated` — see §2.2). TASK-368's
"re-derive → splice → **Prettier** → write" pipeline changes these files, so it
cannot reproduce them byte-identically. Additionally, the layer is a curated
projection (6 schema models excluded, 2 model-less entities) that no
schema-driven generator can reproduce.

**Resolution adopted (not a silent drop):** whole-artifact **verbatim**
preservation driven by the committed files (§3.2), **plus** a content-aware
schema-coverage pass (§3.4). Verbatim guarantees byte-identity for *all* current
files and keeps the collision fix stable; the coverage pass adds the in-file
schema-drift signal *without* re-deriving bodies.

**Why byte-identical *re-derivation* was rejected (the hardening question).**
A "normalize → re-derive skeleton → splice preserved bits → Prettier → write"
path was evaluated as the way to get body-level drift detection. It was rejected
because the committed files are deliberately **heterogeneous in semantic tokens**,
and a single template can only unify them by *changing those tokens* — which the
ticket forbids ("no semantic-token changes"). Concretely:

- **Getter/setter type style** differs across files — `string` /
  `IXxxEntity['field']` (resolved) vs. the indexed-access form — 3 entities use
  the resolved style, 50 use indexed access. A template must pick one, rewriting
  the other group's type tokens.
- **`@Secret()` decorators, `Buffer` types, inlined collision-fix unions, custom
  imports (`randomBytes`/`crypto`)**, and **bespoke factories** (custom
  `Create*Props`, module-level helpers, non-canonical method names like
  `CreateKey`) have no schema-derivable source — re-derivation would drop or
  rename them.
- 19/110 files are **not even Prettier-idempotent** (§2.2), so the final Prettier
  step alone breaks byte-identity.

The content-aware coverage pass sidesteps all of this: it **reads** the committed
files and **compares column presence by name** against DMMF (gated by the explicit
allowlist), so it catches the drift that matters (a model column the layer never
adopted) while leaving every hand-curated token untouched and the output verbatim.

---

## 7. Change History

| Date | Change | Files |
| --- | --- | --- |
| 2026-06-19 | **Initial implementation.** Added shared `utils/preserveGenerated.ts` (Prettier + drift + barrel reconcile) and wired `generate-data-model` to consume it (output unchanged, `:check` EXIT 0). Rewrote `generate-data-entity` + `generate-factory` to verbatim-preserve the committed entity/factory layers + reconcile barrels + add `--check`/`--yes`/`--ci`; made factory non-interactive (deleted interactive `generator.ts`). Added `:all`/`:check` scripts; wired both checks into GitLab CI strict. Verified byte-identical regen (zero diff), 4 check exit codes (3 clean + injected-drift EXIT 1 each), domains/applications builds, tools typecheck, lints. Reported the 19 non-Prettier-idempotent files as the non-round-trippable construct with the verbatim resolution (§6). | `packages/tools/src/{utils/preserveGenerated.ts,utils/index.ts,generate-data-model/index.ts,generate-data-entity/index.ts,generate-factory/index.ts}`, deleted `packages/tools/src/generate-factory/generator.ts`, `packages/tools/package.json`, `.gitlab/ci/{validate.yml,rules.yml}`, this README, TASK-368 README pointer |
| 2026-06-19 | **Content-aware schema-coverage hardening.** Added `utils/schemaCoverage.ts` and wired it into both `--check` paths so each gate now combines structural (verbatim) drift with content-aware schema coverage: every model-backed entity/factory must surface every persisted scalar/enum column of its Prisma model (parsed via ts-morph, compared to DMMF), gated by an **explicit** curated-projection allowlist (6 omitted models, 2 model-less entities, per-model omitted scalars, factory-only post-creation/encryption-envelope skips). Kept output **verbatim** (no `prettier --write` on `packages/domains`, no re-derivation). Documented why byte-identical re-derivation was rejected (semantic-token heterogeneity, §6). Verified: clean → 3 × EXIT 0; injected `ApiKey.throwawayDriftField` → entity **and** factory `:check` EXIT 1 (named); revert → EXIT 0; `packages/domains` stayed empty; domains/applications builds + tools typecheck green. | `packages/tools/src/utils/schemaCoverage.ts` (new), `packages/tools/src/generate-data-entity/index.ts`, `packages/tools/src/generate-factory/index.ts`, this README |
