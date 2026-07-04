# Plan: TASK-302 Stream A — Phase 0 Emergency Hotfix

**Required Skill**: `executing-plans`

| Field | Value |
|---|---|
| **Document** | `docs/implementation/TASK-302-System-Config-Implementation-Roadmap/01-phase-0-hotfix.md` |
| **Status** | Ready for execution |
| **Created** | 2026-05-24 |
| **Stream** | A (Phase 0 Emergency Hotfix) of the TASK-302 roadmap |
| **Parent ticket** | [TASK-301 System Configuration & Multi-Tenancy Assessment](../TASK-301-System-Config-Multi-Tenancy-Assessment/README.md) |
| **Stack** | NestJS 11, Prisma 7, PostgreSQL ≥ 17, Redis 7, TypeScript 5, Vitest 4, Playwright 1.58, Turborepo + pnpm |
| **Effort estimate** | ~3 engineer-days (≈ 1.5 calendar days with 2 engineers in parallel) |
| **Companion streams (all blocked by this one)** | [`02-vault-migration.md`](./02-vault-migration.md), [`03-pgbouncer-rollout.md`](./03-pgbouncer-rollout.md), [`04-optimistic-locking.md`](./04-optimistic-locking.md) |

> **HARD GATE.** Phase 0 must be **completely implemented and verified in production** before Stream B (Vault), Stream C (PgBouncer), and Stream D (Optimistic Locking) can begin. Partial Phase 0 ships are explicitly forbidden by the TASK-301 §Decisions table (decision #8, locked 2026-05-24). If a Phase 0 item is blocked, escalate — do not pull a Phase 1 item forward to "stay productive".

---

## Goal

Close the six exploit chains and the live-credential exposure documented in [TASK-301 README §Phase 0](../TASK-301-System-Config-Multi-Tenancy-Assessment/README.md#phase-0--emergency-hotfix--1-day--hard-gate) within ≤ 1 calendar day of focused work, then verify each closure with a red-team test that stays in CI forever. This plan delivers, in order:

1. Immediate rotation and removal of two real Azure OpenAI API keys currently committed in `.env.dev` (workspace root) and `apps/api/.env.dev` (if present), plus a permanent `gitleaks` pre-commit hook and CI gate that prevents recurrence.
2. A strict global `ValidationPipe` (`whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true`) plus an explicit-allowlist refactor of `TenantService.updateTenantConfigs` and an immutable-field guard on `GlobalSettingEntity`, closing the JWT-secret mass-assignment chain (TASK-301 §P0-2 + §P0-5).
3. An inverted-default `AuthorizationGuard` (empty permission list → deny on `admin/*` routes) plus a sweep of every admin controller to apply explicit `@CanManage(<Subject>)`, plus a boot-time route-introspection guard that refuses startup if any `admin/*` route lacks an explicit permission decorator. This closes the privilege-escalation chain in TASK-301 §P0-3 and §P0-4.
4. A reusable `@Secret` field-metadata decorator plus an audit-log scrubber that strips `value` and `defaultValue` from any `SysEvent` payload whose source row carries `locked === true`, closing the audit-log secret-leak in TASK-301 §P0-6.
5. A boot-time invariant that refuses to start `AppSettingsService` if more than one row exists for any platform key (TASK-301 §P0-1 detection layer).
6. A full Phase 0 verification gate (red-team test suite green, gitleaks scan green, staging duplicate-key startup smoke, audit-log SQL probe), and a docs sync that flips TASK-301 §Phase 0 status to "Completed".

The plan deliberately **does not** finish-fix any P0; defense-in-depth completions (split `AppSettingsService`, envelope encryption, full secrets externalisation) live in Streams B, C, D. Phase 0 is **the closure of exploitability**, not the closure of the architectural debt.

---

## Architecture Overview

```
HOPE — Phase 0 Hotfix Surface
─────────────────────────────────────────────────────────────────────
Inbound HTTP boundary
  └─ apps/api/src/main.ts:221
       └─ ValidationPipe ({ whitelist, forbidNonWhitelisted, forbidUnknownValues })
            └─ rejects unknown DTO keys (closes Item 1)

Admin controllers (apps/api/src/modules/**/*admin*.controller.ts + any /admin/* route)
  └─ explicit @CanManage(<Subject>) at class level (Item 3)
       └─ AuthorizationGuard (inverted default — empty list = deny on /admin/* — Item 3)
            └─ Bootstrap route audit refuses startup on unannotated admin routes (Item 3)

Service layer — TenantService.updateTenantConfigs (Item 2)
  ├─ explicit allowlist:   const changes = { value, description }
  ├─ no spread:            const { id: _id, ...changes } = config  ←  REMOVED
  └─ broadcastSysEvent(...) wraps payload through SecretAwareSerializer (Item 4)

Domain layer — GlobalSettingEntity (Item 2 defense in depth)
  ├─ key / tenantId / locked / defaultValue setters made immutable post-construction
  └─ @Secret() field decorator on value / defaultValue (Item 4)

Cache layer — AppSettingsService.cacheAppSettings() (Item 5)
  └─ boot-time invariant: refuse to start if any key has > 1 row
       └─ counts grouped by key against repository.findAll({})

Source-control boundary (Item 6)
  ├─ .env* scrubbed: AZURE_OPENAI_API_KEY / SMR_V2_AZURE_API_KEY values removed
  ├─ .gitleaks.toml + .gitleaksignore committed
  ├─ pre-commit hook: pnpm exec gitleaks protect --staged
  └─ GitLab CI scan stage: scan-gitleaks job blocks any MR carrying a known-secret pattern
```

The five code-level items run **sequentially in dedicated branches** to minimise merge conflict; Item 6 (credential rotation) is **strictly serial first** because the JWT secret rotation needs a coordinated cutover window that the other items must not interrupt.

---

## Tech Stack

| Layer | Technology | Version | Notes |
|---|---|---|---|
| API runtime | NestJS | 11.x | Global `ValidationPipe` change applies to every controller |
| HTTP DTO validation | `class-validator` | 0.14.1 (pinned in root `package.json`) | `forbidUnknownValues: true` needs `class-transformer` ≥ 0.5.1 to round-trip correctly |
| ORM | Prisma | 7.5.x | No schema migration in Phase 0 (additive shape changes belong to Streams B/D) |
| Database | PostgreSQL | ≥ 17 | Boot-time duplicate-key probe issues a single `findAll` (no DDL) |
| Cache | Redis | 7+ | Existing `AppSettingsService` cron untouched in Phase 0 (Stream A scope) |
| Tests | Vitest | 4.1.x | Unit + integration; new red-team cases land in `__tests__` siblings |
| E2E tests | Playwright | 1.58.x | Lives at `apps/api/tests/e2e/`, driven by `pnpm test:e2e` |
| Secret scanner | `gitleaks` | ≥ 8.21 (vendored via container in CI) | Pre-commit uses `gitleaks protect --staged`; CI uses `gitleaks detect` |
| Git hook runner | `simple-git-hooks` (already in monorepo conventions; OR plain `.husky` if introduced) | latest | We adopt `simple-git-hooks` to avoid bringing in husky as a new dep |
| CI | GitLab CI | existing `.gitlab/ci/scan.yml` template | New job appended; no pipeline restructuring |

---

## Decision Log

These decisions constrain every task in this plan. Revisit only with explicit user approval.

| # | Decision | Rationale | Source |
|---|---|---|---|
| D1 | Item 6 (credential rotation) executes **strictly first**, serial, before any other section starts. | The committed Azure keys are a live incident. Rotating in parallel with item 1 (`ValidationPipe` ship) risks one of the in-flight branches re-introducing the values via auto-fix or rebase. Treat as incident-response timing. | User brief, TASK-301 §IV.1 |
| D2 | Phase 0 ships **without** schema changes. | Migrations against the `GlobalSetting` table belong to Stream B (envelope encryption columns) and Stream D (optimistic locking). Phase 0 must not collide with either. | TASK-301 §Decisions row 8 |
| D3 | The `@Secret` decorator is **field-level metadata only**; the audit-log scrubber consumes it via `Reflect.getMetadata`. | Service-level scrubbing keeps the entity reusable by future Stream B work (envelope encryption); decoupled blast radius. | TASK-301 §B.7 |
| D4 | `forbidUnknownValues` is enabled together with `whitelist` and `forbidNonWhitelisted`. | All three together close the entire mass-assignment surface; `forbidUnknownValues` ensures fully-undefined payloads (e.g., empty body) cannot smuggle prototype pollution downstream. | NestJS 11 docs (2026 guidance) |
| D5 | The `gitleaks` pre-commit hook is **mandatory** (exit non-zero on detection); the CI gate is **mandatory** (`allow_failure: false`) on every pipeline type. | Detection without enforcement is theatre. Phase 0 exit criteria explicitly require "no values matching `gitleaks` known-secret patterns". | TASK-301 §Phase 0 exit criteria |
| D6 | No PHI tables, no Prisma schema, no Redis key patterns are touched in Phase 0. | Surface contained to security primitives — keeps Stream B/C/D unblocked. | This plan's scope policy |
| D7 | JWT_SECRET_KEY rotation is included **once** as a Section A task, scoped to "rotate the static env-bound value used by `JwtStrategy` and `gen-dev-token`". Full extraction from `GlobalSetting` is Stream B work. | The exit criteria require "Re-deployed JWT_SECRET_KEY rotation has occurred and old tokens have expired" — this is a one-shot ops step, not architectural change. | TASK-301 §Phase 0 exit criteria, bullet 6 |
| D8 | Every red-team test that proves a Phase 0 item works stays in CI **forever** under `apps/api/tests/e2e/phase-0-redteam.spec.ts`. | Continuous regression prevention is itself a TASK-301 §Phase 3 recommendation (item 24). Phase 0 anchors that practice. | TASK-301 §Phase 3 row 24 |
| D9 | No `DELETE`/`DROP`/`TRUNCATE` is executed by this plan. | Workspace user rule. The §D.6 backfill SQL proposal **documents** the cleanup query but does **not** run it. | Workspace rule |
| D10 | Branch naming for this stream is `feat/task-302-phase-0/<section-letter>-<short-name>` (e.g. `feat/task-302-phase-0/a-credential-rotation`). One PR per section. Code-review gates correspond to PR boundaries. | Matches the convention established in `02-vault-migration.md` and `04-optimistic-locking.md`. | Stream conventions |

---

## Risks & Mitigations

| # | Risk | Likelihood | Impact | Mitigation | Owner |
|---|---|---|---|---|---|
| R1 | JWT secret rotation invalidates **all** in-flight user sessions, including admin sessions actively working on the hotfix. | High | Medium (UX hiccup; no data loss) | Schedule rotation during a 30-minute maintenance window; notify Slack #engineering ahead of time; carry a fallback `JWT_REFRESH_SECRET` so refresh tokens minted ≤ 5min before the cutover still verify. Document in §A.1 communications block. | `git-manager` |
| R2 | Strict `ValidationPipe` breaks an existing endpoint that silently relied on extra body fields. | Medium | High (prod 400s) | Item 1 lands behind a **two-stage rollout**: first PR enables `whitelist: true` only (strips unknown fields without throwing). After a 24h soak with audit-log monitoring for `dropped-field` warnings, second PR adds `forbidNonWhitelisted` + `forbidUnknownValues`. Phase 0 plan ships both PRs but sequenced. | `code-reviewer` |
| R3 | Inverting the AuthorizationGuard default breaks an obscure admin route that was relying on the empty-list pass-through (a known anti-pattern but possibly extant). | Medium | High (admin black-screen) | Bootstrap route-introspection guard in Task C.4 **lists** every offending route before flipping the default, with an explicit allowlist (`PHASE_0_ALLOWLIST`) that empties to zero entries on the second commit. First commit prints the offenders; second commit denies them. Two-step landing. | `security-auditor` |
| R4 | `@Secret` decorator missed on a field that needs scrubbing (false negative) → audit log continues to leak. | Medium | High | Unit tests enumerate **every** `GlobalSettingEntity` field and assert that fields not on the explicit-non-secret allowlist (`id`, `key`, `name`, `tenantId`, `locked`, `dataType`, `namespace`, `description`, `resourceStatus`, `version`, timestamps) are `@Secret`-marked OR explicitly exempted in the test fixture. Adding a new entity field without marking it `@Secret` or exempting it fails CI. | `tester` |
| R5 | Boot-time invariant trips false-positive in dev because seed data is mid-rebuild. | High during dev, Low in prod | Medium (developer friction) | Invariant is **bypassable in dev only** via `APP_SETTINGS_BOOT_INVARIANT=skip` env, **not** bypassable in `production`/`staging` (process refuses to start with a hard error). Implement env check in Task E.2. Document the env in `apps/api/README.md` (Task E.3). | `database-admin` |
| R6 | `gitleaks` pre-commit hook slows down `git commit` enough that developers disable it locally. | Medium | High (rotation primitive defeated) | Run `gitleaks protect --staged --no-banner --redact` (staged-only, ~150ms typical) so the cost is bounded; document the speed in `apps/api/README.md`. The CI gate remains as the back-stop if local hooks are bypassed. | `cicd-manager` |
| R7 | New `gitleaks` rule pack flags legitimate fixtures or test-only credentials (false positives) and stops PRs from merging. | High | Medium | Ship `.gitleaksignore` in the **same PR** as `.gitleaks.toml` with explicit fingerprints for every fixture that currently triggers (Task A.4 captures the baseline). PR description documents every entry with file:line for review. | `cicd-manager` |
| R8 | Section ordering means a developer running Section B before Section A re-stages a `.env.dev` containing a real key, getting blocked by the new hook before completing rotation. | Medium | Low (clear error message) | The gitleaks hook is **only added** in Section A. Sections B–F start **after** Section A's PR is merged. Branch naming convention (D10) makes section ordering visible at PR list. | `git-manager` |
| R9 | A subagent during execution accidentally pushes the rotated key into a future commit message or test fixture. | Low | High | The CI gate scans the *entire* repo on every pipeline run (`gitleaks detect`, not just `protect --staged`); a backslidden value is caught at PR-time, not deployment. | `security-auditor` |
| R10 | Phase 0 closes faster than Stream B/C/D can rebase, causing rebase conflicts when those branches branch off. | Low | Low | Streams B/C/D are explicitly **pending** Phase 0 sign-off (see `02-*.md`, `03-*.md`, `04-*.md`). They do not branch until Phase 0 hits prod. | `git-manager` |
| R11 | The bootstrap route-introspection guard catches an admin controller that uses `@Authorize(['manage','all'])` syntax different from `@CanManage`. | Medium | Low (false alarm) | The audit treats `@Authorize(<non-empty>)`, `@CanManage`, `@CanRead`, `@CanList`, `@CanCreate`, `@CanUpdate`, `@CanDelete`, `@CanAny`, `@CanAll`, and `@SetPermissions` as **all equivalent** for the purposes of "has an explicit permission". Only `@Authorize()` with no args is flagged. Test fixture in Task C.4 enforces this. | `security-auditor` |
| R12 | A reviewer signs off without manually running the red-team Playwright test suite, leaving an exit-criteria item un-verified. | Medium | High (false sign-off) | The Final Code Review Gate (Section F) **requires** the reviewer to paste the live `pnpm test:e2e -- phase-0-redteam` output into the PR description. CI also runs the suite on every Phase 0 PR. | `code-reviewer` + `security-auditor` |

---

## Team Allocation

Each task carries an `**Agent:**` field that maps to one of the [`executing-plans`](file:///Users/taphuynh/.cursor/skills/methodology/executing-plans/SKILL.md) subagent types. Code-review gates use `code-reviewer`. Cross-cutting roles:

| Subagent | Primary responsibilities in this plan |
|---|---|
| `git-manager` | Section A serial execution, branch hygiene per D10, JWT cutover timing, rotation communication block, refusal to push to remote without explicit user approval |
| `cicd-manager` | `.gitleaks.toml` + `.gitleaksignore` authoring, pre-commit hook wiring via `simple-git-hooks`, GitLab `scan-gitleaks` job addition, two-stage `ValidationPipe` rollout sequencing |
| `security-auditor` | Verifies Item 1+2 (mass-assignment fix), Item 3 (auth guard fix), Item 4 (`@Secret` decorator coverage), reviews Section A communications block, final sign-off on §F.4 |
| `tester` | All red-team Vitest tests, the `phase-0-redteam.spec.ts` Playwright suite, the `@Secret` coverage enumeration test, boot invariant test, audit-log scrubber test |
| `database-admin` | Boot-time invariant implementation (Section E), staging primer SQL for the duplicate-key smoke (read-only, no destructive ops), Audit-Log SQL probe in §F.1 |
| `code-reviewer` | Every Code Review Gate (one per section, ~every 3–6 tasks). Refuses to advance if (a) a failing test was never witnessed red, (b) `process.env.*` secret reads were added, (c) any admin route lost a decorator, (d) Item 6 hook is not staged in this PR |
| `docs-manager` | TASK-301 README §Phase 0 status flip (Completed) + Change History entry; `apps/api/README.md` updates for new env vars |
| `debugger` | On call for any test red that does not resolve with the documented Implementation steps (escalation only) |

Single-engineer assumption per task. The plan is parallelisable from Section B onward; Section A is strictly serial.

---

## Effort Estimate

Numbers are engineer-days. "Solo" is one experienced backend engineer; "2-eng parallel" is two engineers working independently from Section B onward.

| Section | Tasks | Solo eng-days | 2-eng parallel | Critical Path |
|---|---|---|---|---|
| A — Item 6 (credential rotation) | 5 | 0.5 | 0.5 | **yes (serial, blocks all)** |
| B — Items 1 + 2 (mass-assignment) | 7 | 0.5 | 0.5 | yes |
| C — Item 3 (authorization bypass) | 5 | 0.5 | 0.5 | yes |
| D — Item 4 (audit-log scrubbing) | 6 | 0.5 | 0.5 | no (parallel with C) |
| E — Item 5 (boot-time invariant) | 4 | 0.5 | 0.5 | no (parallel with C or D) |
| F — Phase 0 exit verification | 4 | 0.5 | 0.5 | **yes (final gate)** |
| — | **31 tasks** | **~3 eng-days** | **~1.5 eng-days elapsed** | — |

Section ordering, with 2 engineers:

```
Day 0 morning      | Section A           (serial — single engineer)
Day 0 afternoon    | Section B           (Engineer 1)         + Section D (Engineer 2)
Day 1 morning      | Section C           (Engineer 1)         + Section E (Engineer 2)
Day 1 afternoon    | Section F           (both engineers, sign-off)
```

Buffer of 0.5 day reserved for the two-stage `ValidationPipe` rollout (R2) and the route-introspection guard's two-step landing (R3).

---

## Cross-stream Dependencies

This plan is the **hard predecessor** to every other stream in the TASK-302 roadmap. Coordinate at the branch and PR level as follows.

| Stream | Document | Relationship | Coordination Point |
|---|---|---|---|
| **Stream A — this plan** | `01-phase-0-hotfix.md` | — | One PR per Section (A through F), sequenced; Final Code Review Gate (§F) is the sign-off boundary. |
| **Stream B — Vault Secrets Migration** | [`02-vault-migration.md`](./02-vault-migration.md) | **Hard successor.** Stream B Phase 3 (`SecretsService`) **consumes** the `@Secret` decorator delivered in Section D. Stream B Phase 1A's gitleaks rule additions extend (not replace) the rule pack landed in Section A. | `git-manager` confirms Phase 0 is **merged + deployed + verified** before opening Stream B's branch. The `@Secret` decorator is re-exported by `@arcaai/applications` so Stream B Phase 4's envelope-encryption code can target it directly. |
| **Stream C — PgBouncer + Prisma 7** | [`03-pgbouncer-rollout.md`](./03-pgbouncer-rollout.md) | **Hard predecessor on Item 6.** Stream C's `userlist.txt` file MUST be `.gitignore`d behind the gitleaks rule pack added in §A.4. | `cicd-manager` confirms the gitleaks rule pack includes a fingerprint for `userlist.txt`-style auth files (regex: `(?i)^[a-z0-9_]+\s+"[a-z0-9+/=]{20,}"$`) before Stream C ships. |
| **Stream D — Optimistic Locking** | [`04-optimistic-locking.md`](./04-optimistic-locking.md) | **Hard successor on Items 1 + 2.** Stream D Phase C adds `expectedVersion` to `UpdateTenantConfigRequest`. Without the strict `ValidationPipe` (Item 1) and the explicit allowlist (Item 2), Stream D would re-introduce mass-assignment. | Stream D references TASK-302 Phase 0 Items 1 + 2 as hard dependencies in its own [Cross-stream Dependencies](./04-optimistic-locking.md#cross-stream-dependencies) table. |
| **External: TASK-281 MedNER E2E** | `docs/implementation/TASK-281-MedNER-E2E-Infra/README.md` | Independent | No overlap. |
| **External: TASK-258 Tenant Config Provisioning** | (closed) | Reference only | `provisionTenantConfigs` is unchanged in Phase 0; the spread-vs-allowlist fix targets only `updateTenantConfigs`. |

> **Branch/PR convention**: `feat/task-302-phase-0/<section-letter>-<short-name>`. Example: `feat/task-302-phase-0/a-credential-rotation`, `feat/task-302-phase-0/b-validation-pipe-and-allowlist`. The Final Code Review Gate signs off a meta-PR that merges all section PRs into the integration branch.

---

# Section A — Item 6: Credential Rotation (DO FIRST, treat as live incident)

**Section Goal**: Rotate the two real Azure OpenAI API keys currently in source control, scrub every `.env*` file of values matching known-secret patterns, install a `gitleaks` pre-commit hook + CI gate, and rotate `JWT_SECRET_KEY` in the running environments. **Strictly serial — every other section blocks on this one.**

**Entry Criteria**:
- Branch `feat/task-302-phase-0/a-credential-rotation` created off the latest `dev`.
- A 30-minute maintenance window scheduled and announced on Slack `#engineering`.
- An Azure portal operator with rotation rights is online.

**Exit Criteria**:
- Both Azure keys rotated (old keys revoked in Azure portal) and removed from every `.env*` file.
- `JWT_SECRET_KEY` re-issued in staging and production env-stores; old sessions force-refreshed.
- `.gitleaks.toml`, `.gitleaksignore`, and the pre-commit hook present; `pnpm exec gitleaks detect` returns zero findings.
- GitLab `scan-gitleaks` job runs on the PR and exits 0.
- Section A's PR is merged.

---

## Task A.1 — Rotate the Azure OpenAI API key + SMR_V2 Azure key (manual ops)

**Agent**: `git-manager`

**Files**:
- Create: `docs/implementation/TASK-302-System-Config-Implementation-Roadmap/_section-a-rotation-log.md`

**Steps**:

1. Open the rotation log (the agent creates it now; the operator fills in fingerprints as the rotation proceeds):

   ```markdown
   # Section A — Rotation Log (Phase 0 Item 6)

   | Step | Performed by | Timestamp (UTC) | Old key fingerprint (SHA-256, first 16 chars) | New key fingerprint | Notes |
   |---|---|---|---|---|---|
   | Azure OpenAI key rotation | <ops> | <ISO-8601> | <fp_old> | <fp_new> | Old key revoked in Azure portal |
   | SMR_V2 Azure key rotation | <ops> | <ISO-8601> | <fp_old> | <fp_new> | Old key revoked in Azure portal |
   | JWT_SECRET_KEY rotation (staging) | <ops> | <ISO-8601> | <fp_old> | <fp_new> | env-store updated; pods restarted |
   | JWT_SECRET_KEY rotation (production) | <ops> | <ISO-8601> | <fp_old> | <fp_new> | env-store updated; pods restarted; old refresh tokens expired |

   Communications block (Slack #engineering, copy/paste record):
   - Pre-cutover announcement: <link>
   - In-cutover status: <link>
   - Post-cutover all-clear: <link>
   ```

2. Manual operator steps (record outcome in the table above):

   ```bash
   # In Azure portal:
   # 1. Navigate to Azure OpenAI resource → Keys and Endpoint
   # 2. Click "Regenerate Key 1"
   # 3. Confirm — note the new value into a secrets manager
   # 4. After 5 minutes (allow downstream caches to drain), revoke the OLD key
   #
   # Repeat for SMR_V2 Azure resource keys.
   ```

3. Verify by computing fingerprints (operator pastes the new key into a private terminal **only**):

   ```bash
   # On the operator's machine:
   echo -n "<new-key-here>" | shasum -a 256 | cut -c1-16
   # Record the fingerprint in the rotation log; never log the raw value.
   ```

4. Commit the log skeleton (without secret values):

   ```bash
   git add docs/implementation/TASK-302-System-Config-Implementation-Roadmap/_section-a-rotation-log.md
   git commit -m "$(cat <<'EOF'
   docs(task-302/phase-0): scaffold Section A rotation log

   Phase 0 Item 6: rotation log skeleton for Azure OpenAI and SMR_V2 Azure
   API keys. Operator fills fingerprints + timestamps during the rotation
   window. Raw secret values never enter source control or commit messages.
   EOF
   )"
   ```

> **Hard rule**: never paste a raw secret into any file, commit message, or chat. Only SHA-256 fingerprints (first 16 chars) are recorded.

---

## Task A.2 — Scrub real Azure key values from `.env.dev` and `.env*` siblings

**Agent**: `git-manager`

**Files**:
- Modify: `.env.dev` (workspace root — currently contains the real `AZURE_OPENAI_API_KEY` on line 170 per TASK-301 §IV.1)
- Modify: `.env.example`, `.env.test`, `.env.production`, `.env.archive` (only if any contain non-placeholder values matching the Azure regex; TASK-301 §IV.1 names these as the audit perimeter)
- Modify: `apps/api/.env.example`, `apps/api/.env.production` (audit + sanitise)
- Modify: `apps/smr/.env.example`, `apps/smr/.env.production`
- Create: `.env.dev.local.example` if a developer-only template is needed; **do not** commit any `.env*.local` file

**Steps**:

1. Write the failing scrubbing-smoke test (a one-shot shell that the operator runs locally; CI replicates this via gitleaks in Task A.4):

   ```bash
   # /tmp/phase-0-scrub-smoke.sh
   #!/usr/bin/env zsh
   set -euo pipefail

   # Regex: Azure OpenAI keys are 84-char alnum strings (current shape: F5...P15b).
   # `gitleaks` will use a stronger rule; this smoke is the fast manual check.
   PATTERN='[A-Za-z0-9]{80,}'
   FILES=(
     .env.dev .env.example .env.test .env.production .env.archive
     apps/api/.env.example apps/api/.env.production
     apps/smr/.env.example apps/smr/.env.production
   )

   FAIL=0
   for f in "${FILES[@]}"; do
     [[ ! -f "$f" ]] && continue
     # Only check AZURE_OPENAI_API_KEY / SMR_V2_AZURE_API_KEY assignments
     if rg -n '^(AZURE_OPENAI_API_KEY|SMR_V2_AZURE_API_KEY)[:=]\s*[A-Za-z0-9]{80,}' "$f"; then
       echo "::error file=$f::Real Azure key value present"
       FAIL=1
     fi
   done

   [[ $FAIL -eq 0 ]] && echo "phase-0-scrub-smoke: PASS"
   exit $FAIL
   ```

   ```bash
   chmod +x /tmp/phase-0-scrub-smoke.sh
   ```

2. Verify the test **fails today** (proves the bug exists):

   ```bash
   /tmp/phase-0-scrub-smoke.sh
   # Expected output (today):
   # ::error file=.env.dev::Real Azure key value present
   # .env.dev:170:AZURE_OPENAI_API_KEY: F5Kvc2iVDdZVkGHsVSssaZs342f0qUURXUWIFn5VaJiodtqNV2McJQQJ99BAACYeBjFXJ3w3AAABACOGP15b
   # exit code: 1
   ```

3. Implement the scrub. Edit `.env.dev` to replace the real value with a placeholder; **the operator must already have a copy of the rotated key in the env-store** before this commit (so dev shells continue to work via local-only overrides):

   In `.env.dev`, line 170 today reads:

   ```
   AZURE_OPENAI_API_KEY: F5Kvc2iVDdZVkGHsVSssaZs342f0qUURXUWIFn5VaJiodtqNV2McJQQJ99BAACYeBjFXJ3w3AAABACOGP15b
   ```

   Change to:

   ```
   AZURE_OPENAI_API_KEY=
   # ↑ Set this in your local .env.dev.local override (Phase 0 Item 6). Do NOT commit a real value.
   ```

   Note the **format normalisation** (`:` → `=`) — `python-dotenv` and `dotenv-cli` both accept either, but `=` is canonical across this monorepo. Apply the same swap to lines 171–179 of `.env.dev` (the surrounding `AZURE_OPENAI_*` keys use `:` separators today).

   For every other file in the FILES list above: open it, locate any `AZURE_OPENAI_API_KEY` or `SMR_V2_AZURE_API_KEY` assignment with a non-empty value matching `[A-Za-z0-9]{80,}`, and replace the value with empty. If the file is `apps/smr/.env.example`, the line currently reads `SMR_V2_AZURE_API_KEY=` (empty) — already safe; leave it.

4. Verify the smoke test now passes:

   ```bash
   /tmp/phase-0-scrub-smoke.sh
   # Expected output:
   # phase-0-scrub-smoke: PASS
   # exit code: 0
   ```

5. Commit the scrub:

   ```bash
   git add .env.dev .env.example .env.test .env.production .env.archive \
           apps/api/.env.example apps/api/.env.production \
           apps/smr/.env.example apps/smr/.env.production
   git commit -m "$(cat <<'EOF'
   security(env): scrub real Azure API keys from committed .env files

   Phase 0 Item 6 (TASK-302 Stream A): removes the real values for
   AZURE_OPENAI_API_KEY and SMR_V2_AZURE_API_KEY that were committed in
   .env.dev (workspace root) and audited siblings. Rotation in Azure
   portal completed first (see _section-a-rotation-log.md). Local devs
   must set the rotated value in .env.dev.local (uncommitted).

   Closes the live-credential half of TASK-301 §IV.1.
   EOF
   )"
   ```

---

## Task A.3 — Add `.gitleaks.toml` and `.gitleaksignore` to the repo root

**Agent**: `cicd-manager`

**Files**:
- Create: `.gitleaks.toml`
- Create: `.gitleaksignore`
- Modify: `.gitignore` (add `*.gitleaks-report.json` artifact pattern)

**Steps**:

1. Write the failing smoke test:

   ```bash
   # /tmp/phase-0-gitleaks-smoke.sh
   #!/usr/bin/env zsh
   set -euo pipefail

   test -f .gitleaks.toml         || { echo "::error::.gitleaks.toml missing"; exit 1; }
   test -f .gitleaksignore        || { echo "::error::.gitleaksignore missing"; exit 1; }

   # gitleaks ≥ 8.21 supports --config + --no-banner
   if ! command -v gitleaks >/dev/null; then
     echo "::error::gitleaks not installed locally; install via brew install gitleaks (≥ 8.21)"
     exit 2
   fi

   gitleaks detect --source . --config .gitleaks.toml --no-banner --redact \
                   --report-format json --report-path /tmp/phase-0-gitleaks-report.json
   FINDINGS=$(jq 'length' /tmp/phase-0-gitleaks-report.json)
   if [[ "$FINDINGS" -gt 0 ]]; then
     echo "::error::gitleaks found $FINDINGS leak(s); see /tmp/phase-0-gitleaks-report.json"
     exit 1
   fi
   echo "phase-0-gitleaks-smoke: PASS (0 findings)"
   ```

   ```bash
   chmod +x /tmp/phase-0-gitleaks-smoke.sh
   ```

2. Verify the test fails (no config file yet):

   ```bash
   /tmp/phase-0-gitleaks-smoke.sh
   # Expected: ::error::.gitleaks.toml missing; exit 1
   ```

3. Implement `.gitleaks.toml` — the HOPE rule pack. The full ruleset is documented in [Appendix C](#appendix-c--gitleaks-rule-pack-for-hope). Excerpted minimum for Phase 0:

   ```toml
   # .gitleaks.toml — HOPE Phase 0 Item 6
   # Extends the gitleaks default ruleset with HOPE-specific patterns.

   title = "HOPE gitleaks rule pack (Phase 0)"

   [extend]
   # Inherit gitleaks' built-in rules so we get AWS, Azure, GCP, Slack, JWT
   # patterns for free. We only add HOPE-specific extensions.
   useDefault = true

   [[rules]]
   id = "hope-azure-openai-api-key"
   description = "Azure OpenAI API key committed to a .env or source file"
   regex = '''(?i)(AZURE_OPENAI_API_KEY|SMR_V2_AZURE_API_KEY)\s*[:=]\s*["']?[A-Za-z0-9]{80,}["']?'''
   tags = ["azure", "openai", "key"]

   [[rules]]
   id = "hope-jwt-secret"
   description = "JWT secret committed (non-empty value)"
   regex = '''(?i)(JWT_SECRET_KEY|JWT_REFRESH_SECRET|SESSION_SECRET_KEY)\s*[:=]\s*["']?[A-Za-z0-9+/=_-]{32,}["']?'''
   tags = ["jwt", "session", "secret"]

   [[rules]]
   id = "hope-s3-credentials"
   description = "S3 access/secret committed (non-placeholder)"
   regex = '''(?i)(S3_ACCESS_KEY|S3_SECRET_KEY|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|MINIO_ROOT_PASSWORD)\s*[:=]\s*["']?[A-Za-z0-9+/=]{16,}["']?'''
   tags = ["s3", "aws", "minio"]

   [[rules]]
   id = "hope-db-url-password"
   description = "DATABASE_URL with embedded password (postgresql://user:pw@…)"
   regex = '''(?i)(DATABASE_URL|DB_CONNECTION_STRING)\s*[:=]\s*["']?postgresql://[^:]+:[^@\s"']{8,}@'''
   tags = ["postgres", "url"]

   [[rules]]
   id = "hope-pgbouncer-userlist"
   description = "PgBouncer userlist.txt format (Stream C interlock)"
   regex = '''(?i)^[a-z0-9_]+\s+"[a-z0-9+/=]{20,}"$'''
   tags = ["pgbouncer"]

   [allowlist]
   description = "Allowlisted paths (fixtures, dependency lockfiles, generated reports)"
   paths = [
     '''(.*?)(jpg|gif|doc|pdf|bin|svg|ico|png|jpeg|wav|mp3|woff2)$''',
     '''pnpm-lock\.yaml$''',
     '''node_modules/''',
     '''dist/''',
     '''\.turbo/''',
     '''docs/implementation/TASK-302-System-Config-Implementation-Roadmap/_section-a-rotation-log\.md$''',
   ]
   ```

4. Implement `.gitleaksignore` — fingerprints for any allowed-as-test secret patterns. Start empty; populate during Task A.4 once we run a full baseline scan:

   ```
   # .gitleaksignore — HOPE Phase 0 Item 6
   # Each entry is a gitleaks fingerprint (file:rule-id:line:secret-hash).
   # Add a line ONLY after security-auditor review.
   # See: https://github.com/gitleaks/gitleaks#gitleaksignore
   ```

5. Modify `.gitignore` to keep gitleaks reports out of git:

   Add the following lines under an existing `# Reports / artifacts` section (or create one):

   ```gitignore
   # gitleaks (Phase 0 Item 6)
   *.gitleaks-report.json
   /tmp/phase-0-gitleaks-report.json
   ```

6. Verify the test now passes (assumes `gitleaks` installed locally; CI will use the container image):

   ```bash
   /tmp/phase-0-gitleaks-smoke.sh
   # Expected output:
   # phase-0-gitleaks-smoke: PASS (0 findings)
   ```

   If findings appear, **stop**: do not blindly add to `.gitleaksignore`. Investigate each finding and either rotate the underlying credential or document why the fixture is safe in the PR description.

7. Commit:

   ```bash
   git add .gitleaks.toml .gitleaksignore .gitignore
   git commit -m "$(cat <<'EOF'
   ci(security): add gitleaks rule pack and ignore-list

   Phase 0 Item 6 (TASK-302 Stream A): introduces .gitleaks.toml with the
   HOPE-specific rule pack (Azure OpenAI, JWT, S3, DB URL, PgBouncer
   userlist) extending gitleaks' default ruleset. Adds an empty
   .gitleaksignore — fingerprint exceptions land via PR review only.

   Forms the substrate for Tasks A.4 (pre-commit hook) and A.5 (CI gate).
   EOF
   )"
   ```

---

## Task A.4 — Wire pre-commit hook via `simple-git-hooks`

**Agent**: `cicd-manager`

**Files**:
- Modify: `package.json` (root) — add `simple-git-hooks` to `devDependencies` and add the `simple-git-hooks` config block + `lint-staged`-compatible glob
- Create: `scripts/gitleaks-precommit.sh`

**Steps**:

1. Write the failing test:

   ```bash
   # /tmp/phase-0-precommit-smoke.sh
   #!/usr/bin/env zsh
   set -euo pipefail

   # Hook script must exist and be executable
   test -x scripts/gitleaks-precommit.sh \
     || { echo "::error::scripts/gitleaks-precommit.sh missing or not executable"; exit 1; }

   # package.json must declare simple-git-hooks with a pre-commit pointer
   jq -e '."simple-git-hooks"."pre-commit"' package.json >/dev/null \
     || { echo "::error::simple-git-hooks pre-commit not declared in package.json"; exit 1; }

   # The pre-commit value must invoke our gitleaks script
   HOOK=$(jq -r '."simple-git-hooks"."pre-commit"' package.json)
   [[ "$HOOK" == *"scripts/gitleaks-precommit.sh"* ]] \
     || { echo "::error::pre-commit hook does not invoke gitleaks-precommit.sh (got: $HOOK)"; exit 1; }

   echo "phase-0-precommit-smoke: PASS"
   ```

   ```bash
   chmod +x /tmp/phase-0-precommit-smoke.sh
   ```

2. Verify the test fails:

   ```bash
   /tmp/phase-0-precommit-smoke.sh
   # Expected: ::error::scripts/gitleaks-precommit.sh missing or not executable
   ```

3. Implement the hook script:

   ```bash
   # scripts/gitleaks-precommit.sh
   #!/usr/bin/env zsh
   set -eu

   # Phase 0 Item 6 — fast, staged-only gitleaks scan.
   # Skips silently if gitleaks is not installed (developer onboarding window).
   # CI gate (.gitlab/ci/scan.yml::scan-gitleaks) is the back-stop.

   if ! command -v gitleaks >/dev/null 2>&1; then
     echo "warn(gitleaks-precommit): gitleaks not installed locally — skipping pre-commit scan."
     echo "warn(gitleaks-precommit): install via 'brew install gitleaks' (>= 8.21)."
     exit 0
   fi

   gitleaks protect --staged \
                    --config .gitleaks.toml \
                    --no-banner \
                    --redact \
                    --verbose
   ```

   ```bash
   chmod +x scripts/gitleaks-precommit.sh
   ```

4. Modify `package.json` (root) — add `simple-git-hooks` config and devDependency:

   Append to the existing `"devDependencies"` block:

   ```json
   "simple-git-hooks": "^2.11.1"
   ```

   Add a top-level `"simple-git-hooks"` block (above `"devDependencies"` or above `"dependencies"`, conventionally placed beside other tool config):

   ```json
   "simple-git-hooks": {
     "pre-commit": "./scripts/gitleaks-precommit.sh"
   }
   ```

   And add a `prepare` script (if not present) to install the hooks on `pnpm install`:

   ```json
   "scripts": {
     "prepare": "simple-git-hooks || true"
   }
   ```

   The `|| true` ensures CI images without git history don't fail on `pnpm install`.

5. Install + activate:

   ```bash
   pnpm install
   pnpm exec simple-git-hooks
   ```

6. Verify the test passes:

   ```bash
   /tmp/phase-0-precommit-smoke.sh
   # Expected: phase-0-precommit-smoke: PASS
   ```

   Live verification — stage a deliberate leak (DO NOT COMMIT) and confirm the hook blocks the commit:

   ```bash
   echo 'TEST_LEAK_AZURE_OPENAI_API_KEY=F5Kvc2iVDdZVkGHsVSssaZs342f0qUURXUWIFn5VaJiodtqNV2McJQQJ99BAACYeBjFXJ3w3AAABACOGP15b' >> /tmp/phase-0-fake-leak.env
   git add /tmp/phase-0-fake-leak.env 2>/dev/null || true
   git commit -m "test: should be blocked"
   # Expected: gitleaks exits non-zero, commit refused.
   git reset HEAD -- /tmp/phase-0-fake-leak.env 2>/dev/null || true
   rm /tmp/phase-0-fake-leak.env
   ```

7. Commit:

   ```bash
   git add package.json pnpm-lock.yaml scripts/gitleaks-precommit.sh
   git commit -m "$(cat <<'EOF'
   ci(security): wire gitleaks pre-commit hook via simple-git-hooks

   Phase 0 Item 6 (TASK-302 Stream A): introduces simple-git-hooks as the
   monorepo hook runner (lighter than husky; zero config beyond
   package.json). Pre-commit invokes scripts/gitleaks-precommit.sh which
   runs `gitleaks protect --staged` against .gitleaks.toml. Developers
   without gitleaks installed get a warning, not a failure — CI gate is
   the back-stop.
   EOF
   )"
   ```

---

## Task A.5 — Add `scan-gitleaks` job to GitLab CI

**Agent**: `cicd-manager`

**Files**:
- Modify: `.gitlab/ci/scan.yml`

**Steps**:

1. Write the failing test:

   ```bash
   # /tmp/phase-0-ci-gitleaks-smoke.sh
   #!/usr/bin/env zsh
   set -euo pipefail

   grep -q '^scan-gitleaks:' .gitlab/ci/scan.yml \
     || { echo "::error::scan-gitleaks job missing from .gitlab/ci/scan.yml"; exit 1; }

   # Job must NOT allow_failure (Phase 0 rule D5)
   if rg -A 20 '^scan-gitleaks:' .gitlab/ci/scan.yml | rg -q 'allow_failure:\s*true'; then
     echo "::error::scan-gitleaks must NOT allow_failure:true (Phase 0 D5)"
     exit 1
   fi

   # Job must run on all pipeline types (merge_request, dev, staging, main, feature, cicd)
   grep -A 20 '^scan-gitleaks:' .gitlab/ci/scan.yml | grep -q 'rules:' \
     || { echo "::error::scan-gitleaks missing rules block"; exit 1; }

   echo "phase-0-ci-gitleaks-smoke: PASS"
   ```

   ```bash
   chmod +x /tmp/phase-0-ci-gitleaks-smoke.sh
   ```

2. Verify the test fails:

   ```bash
   /tmp/phase-0-ci-gitleaks-smoke.sh
   # Expected: ::error::scan-gitleaks job missing from .gitlab/ci/scan.yml
   ```

3. Implement — append the new job to `.gitlab/ci/scan.yml` (after the existing `scan-source` block):

   ```yaml
   # ── Gitleaks scan (Phase 0 Item 6) — runs on ALL pipelines, MUST pass ────────

   scan-gitleaks:
     stage: scan
     tags: [fast]
     image:
       name: zricethezav/gitleaks:v8.21.2
       entrypoint: [""]
     needs: []
     script:
       - |
         echo "Scanning entire repo for known-secret patterns…"
         gitleaks detect \
                  --source . \
                  --config .gitleaks.toml \
                  --no-banner \
                  --redact \
                  --report-format sarif \
                  --report-path gl-secret-detection-report.sarif
     artifacts:
       when: always
       paths:
         - gl-secret-detection-report.sarif
       reports:
         sast: gl-secret-detection-report.sarif
       expire_in: 30 days
     allow_failure: false
     rules:
       - if: $CI_COMMIT_TAG =~ /^v\d+/
       - if: $PIPELINE_TYPE == "merge_request"
       - if: $PIPELINE_TYPE == "feature"
       - if: $PIPELINE_TYPE == "cicd"
       - if: $PIPELINE_TYPE == "dev"
       - if: $PIPELINE_TYPE == "staging"
       - if: $PIPELINE_TYPE == "release_sdk"
       - if: $PIPELINE_TYPE == "release_playground"
       - if: $PIPELINE_TYPE == "main"
   ```

4. Verify the test passes:

   ```bash
   /tmp/phase-0-ci-gitleaks-smoke.sh
   # Expected: phase-0-ci-gitleaks-smoke: PASS
   ```

5. Live-verify the CI job by pushing the branch and watching the pipeline (requires user approval per workspace rule):

   ```bash
   # The git-manager subagent does NOT push without explicit approval.
   # Prompt user:
   #
   #   "Section A is staged. May I push branch
   #    feat/task-302-phase-0/a-credential-rotation to origin so the
   #    scan-gitleaks job runs on the MR pipeline?"
   #
   # On approval:
   git push -u origin feat/task-302-phase-0/a-credential-rotation
   # Then open the MR via gh or GitLab UI, wait for scan-gitleaks to run.
   ```

6. Commit:

   ```bash
   git add .gitlab/ci/scan.yml
   git commit -m "$(cat <<'EOF'
   ci(security): add scan-gitleaks job to all pipeline types

   Phase 0 Item 6 (TASK-302 Stream A): permanent CI gate that blocks any
   commit re-introducing a known-secret pattern. allow_failure:false on
   every pipeline type (merge_request, feature, dev, staging, main, cicd,
   release_*, tag_release). Uploads SARIF as a GitLab SAST report.
   EOF
   )"
   ```

---

### Code Review Gate A

**Agent**: `code-reviewer`

Reviewer checklist for Section A:

- [ ] `_section-a-rotation-log.md` contains all four rotation fingerprints (Azure OpenAI, SMR_V2 Azure, JWT staging, JWT prod). Reject the PR if any are blank.
- [ ] `gitleaks detect --source . --config .gitleaks.toml --no-banner` returns zero findings in the local clone.
- [ ] `git log -p` for this branch contains **no** raw key values, only fingerprints.
- [ ] `.gitleaksignore` is empty OR every entry has a justification in the PR description.
- [ ] The pre-commit hook fires on a deliberately-staged leak (run the live-verification block in Task A.4 step 6).
- [ ] The `scan-gitleaks` job ran on the MR pipeline and exited 0 (paste the pipeline URL into the PR).
- [ ] `JWT_SECRET_KEY` rotation happened in both staging and prod (verify by signing-in a fresh user and confirming old long-lived sessions no longer validate).
- [ ] `simple-git-hooks` is in `devDependencies`, not `dependencies`.

On any failure, **block** the section and route to `debugger` for diagnosis. Section A's PR must be merged before any other Section begins.

---

# Section B — Items 1 + 2: Close the Mass-Assignment Chain

**Section Goal**: Activate strict `ValidationPipe` globally (Item 1), replace the spread in `TenantService.updateTenantConfigs` with an explicit allowlist (Item 2), and make `key`, `tenantId`, `locked`, `defaultValue` immutable on `GlobalSettingEntity` (Item 2 defense in depth). Each step starts with a failing red-team test.

**Entry Criteria**: Section A merged.

**Exit Criteria**:
- Red-team test "DOCTOR PATCHing JWT_SECRET_KEY returns 400/403" passes.
- Red-team test "direct service-layer spread vulnerability" passes (the service no longer accepts non-allowlisted fields even with the pipe bypassed).
- Entity-level test "key/tenantId/locked/defaultValue are immutable" passes.
- All existing Vitest + Playwright tests green.

---

## Task B.1 — Failing E2E red-team test: DOCTOR mass-assigns JWT_SECRET_KEY (expect 400)

**Agent**: `tester`

**Files**:
- Create: `apps/api/tests/e2e/phase-0-redteam.spec.ts`
- Modify: `tests/setup/playwright.global-setup.ts` (only if a `__GLOBAL__`-scoped GlobalSetting with key `JWT_SECRET_KEY` is not already seeded for the doctor test user — verify first, do not introduce new seed unless absolutely required)

**Steps**:

1. Write the failing test:

   ```typescript
   // apps/api/tests/e2e/phase-0-redteam.spec.ts
   import { test, expect } from '@playwright/test';

   /**
    * Phase 0 red-team suite (TASK-302 Stream A).
    *
    * Every test here proves a specific exploit chain from TASK-301 §Phase 0
    * is closed. Tests live in CI forever per Decision D8.
    */

   test.describe('Phase 0 — Item 1+2: mass-assignment chain', () => {
     let doctorToken: string;
     let doctorTenantConfigId: string;

     test.beforeAll(async ({ request }) => {
       const login = await request.post('/api/v1/auth/login', {
         data: { username: 'doctor', password: 'password123', tenantKey: '__GLOBAL__' },
       });
       expect(login.status(), 'doctor login failed').toBe(200);
       doctorToken = (await login.json()).token;

       // The doctor must own *some* unlocked GlobalSetting to attempt the
       // exploit. Discover one via the tenant-config GET endpoint.
       const configs = await request.get('/api/v1/tenant/me/config?limit=200&page=1', {
         headers: { Authorization: `Bearer ${doctorToken}` },
       });
       expect(configs.status(), 'tenant config fetch failed').toBe(200);
       const body = await configs.json();
       const unlocked = body.data.find((c: { locked?: boolean }) => c.locked !== true);
       expect(unlocked, 'no unlocked GlobalSetting found for doctor — test seed gap').toBeDefined();
       doctorTenantConfigId = unlocked.id;
     });

     test('PATCH /tenant/me/config with extra fields (key, tenantId, locked) is rejected with 400', async ({ request }) => {
       const response = await request.patch('/api/v1/tenant/me/config', {
         headers: { Authorization: `Bearer ${doctorToken}` },
         data: [
           {
             id: doctorTenantConfigId,
             value: 'attacker-controlled-jwt-secret',
             // Smuggled fields — must be rejected by ValidationPipe (Item 1)
             // and never reach the service (Item 2 allowlist).
             key: 'JWT_SECRET_KEY',
             locked: true,
             tenantId: '50000000-0000-0000-0000-000000000000',
             defaultValue: 'evil-default',
           },
         ],
       });
       expect(response.status(), 'mass-assignment must be rejected with 400').toBe(400);
     });

     test('after rejection, the underlying setting is unchanged', async ({ request }) => {
       const after = await request.get('/api/v1/tenant/me/config?limit=200&page=1', {
         headers: { Authorization: `Bearer ${doctorToken}` },
       });
       const body = await after.json();
       const row = body.data.find((c: { id: string }) => c.id === doctorTenantConfigId);
       expect(row.key, 'key must NOT have been overwritten').not.toBe('JWT_SECRET_KEY');
       expect(row.locked, 'locked must NOT have been escalated').not.toBe(true);
     });
   });
   ```

2. Verify the test fails today (before any fix):

   ```bash
   pnpm test:e2e -- phase-0-redteam
   # Expected output (today, with ValidationPipe whitelist:false and spread in service):
   #   ✗ PATCH /tenant/me/config with extra fields … rejected with 400
   #     Expected status: 400
   #     Received status: 200    ← exploit succeeds; mass-assignment writes attacker fields
   ```

3. Do **not** implement the fix yet — leave the test red. Task B.2 enables the pipe.

4. Commit the test in a `wip:` commit on the branch (without `.skip`):

   ```bash
   git add apps/api/tests/e2e/phase-0-redteam.spec.ts
   git commit -m "$(cat <<'EOF'
   test(api/e2e): add Phase 0 mass-assignment red-team (currently failing)

   Phase 0 Item 1+2 (TASK-302 Stream A): documents the JWT_SECRET_KEY
   exploit chain from TASK-301 §P0-2 as a Playwright contract test.
   Test fails until the strict ValidationPipe (B.2) and the allowlist
   refactor (B.5) are merged. Lives in CI forever per Decision D8.
   EOF
   )"
   ```

---

## Task B.2 — Enable strict global `ValidationPipe`

**Agent**: `security-auditor`

**Files**:
- Modify: `apps/api/src/main.ts:221`

**Steps**:

1. Write the failing Vitest unit that pinpoints the regression target (in addition to the existing E2E):

   ```typescript
   // apps/api/src/__tests__/validation-pipe.test.ts
   import { describe, it, expect } from 'vitest';
   import { ValidationPipe } from '@nestjs/common';
   import { IsString, IsOptional } from 'class-validator';
   import { plainToInstance } from 'class-transformer';

   class FakeDto {
     @IsString() id!: string;
     @IsString() value!: string;
     @IsOptional() @IsString() description?: string;
   }

   describe('Phase 0 Item 1 — global ValidationPipe must strip + reject unknown keys', () => {
     it('throws BadRequestException on unknown keys when forbidNonWhitelisted is on', async () => {
       const pipe = new ValidationPipe({
         transform: true,
         whitelist: true,
         forbidNonWhitelisted: true,
         forbidUnknownValues: true,
       });
       const evil = plainToInstance(FakeDto, {
         id: 'gs-1', value: 'v', key: 'JWT_SECRET_KEY', locked: true,
       });
       await expect(
         pipe.transform(evil, { type: 'body', metatype: FakeDto } as never),
       ).rejects.toThrow(/property key should not exist/i);
     });
   });
   ```

2. Verify it fails:

   ```bash
   pnpm --filter @arcaai/api test:unit -- validation-pipe
   # Expected: ✗ — pipe doesn't throw because no app instance is constructed with whitelist:true yet.
   # (The unit demonstrates the EXPECTED post-fix behaviour; this is a forward test.)
   ```

3. Implement — edit `apps/api/src/main.ts:221`:

   Today:

   ```typescript
   app.useGlobalPipes(new ValidationPipe({ transform: true }));
   ```

   Replace with the **stage-1 form** (R2 mitigation — strip-only for the first 24h soak):

   ```typescript
   // Phase 0 Item 1 (TASK-302 Stream A) — strict input validation.
   // Stage 1 (this commit): whitelist:true strips unknown fields without
   // throwing. After a 24h staging soak with no `dropped-field` warnings,
   // stage 2 commit adds forbidNonWhitelisted + forbidUnknownValues.
   app.useGlobalPipes(
     new ValidationPipe({
       transform: true,
       whitelist: true,
     }),
   );
   ```

4. Soak in staging for 24h. Monitor pino logs for `unknown property` warnings via:

   ```bash
   # In the staging shell:
   kubectl logs -l app=hope-api --since=24h | rg 'dropped|unknown property|whitelisted' | head -50
   ```

5. After zero-warning soak, ship the **stage-2 form**:

   ```typescript
   app.useGlobalPipes(
     new ValidationPipe({
       transform: true,
       whitelist: true,
       forbidNonWhitelisted: true,
       forbidUnknownValues: true,
     }),
   );
   ```

6. Verify the unit test now passes:

   ```bash
   pnpm --filter @arcaai/api test:unit -- validation-pipe
   # Expected output:
   #   ✓ throws BadRequestException on unknown keys … (8ms)
   #   Test Files  1 passed (1)
   #   Tests       1 passed (1)
   ```

7. Verify the E2E (Task B.1) now passes:

   ```bash
   pnpm test:e2e -- phase-0-redteam
   # Expected:
   #   ✓ PATCH /tenant/me/config with extra fields (key, tenantId, locked) is rejected with 400
   #   ✓ after rejection, the underlying setting is unchanged
   ```

8. Commit (two commits to honour the two-stage rollout):

   Stage 1 commit:

   ```bash
   git add apps/api/src/main.ts apps/api/src/__tests__/validation-pipe.test.ts
   git commit -m "$(cat <<'EOF'
   security(api): enable strict ValidationPipe stage 1 (whitelist only)

   Phase 0 Item 1 stage 1 (TASK-302 Stream A): strips unknown DTO keys
   without throwing. Forwards a 24h staging soak window before flipping
   forbidNonWhitelisted/forbidUnknownValues on (stage 2). Pino logs are
   monitored for any unintended drop during the soak.
   EOF
   )"
   ```

   Stage 2 commit (after soak):

   ```bash
   git add apps/api/src/main.ts
   git commit -m "$(cat <<'EOF'
   security(api): enable strict ValidationPipe stage 2 (forbidNonWhitelisted + forbidUnknownValues)

   Phase 0 Item 1 stage 2 (TASK-302 Stream A): completes the strict input
   validation rollout. Closes the JWT_SECRET_KEY mass-assignment exploit
   chain at the HTTP boundary. Soak window logged zero unexpected drops.
   EOF
   )"
   ```

---

## Task B.3 — Confirm red-team test now returns 400

**Agent**: `tester`

**Files**: None.

**Steps**:

1. Re-run the suite:

   ```bash
   pnpm test:e2e -- phase-0-redteam
   # Expected output (post-B.2):
   #   Running 2 tests using 1 worker
   #     ✓ Phase 0 — Item 1+2: mass-assignment chain › PATCH /tenant/me/config with extra fields … (340ms)
   #     ✓ Phase 0 — Item 1+2: mass-assignment chain › after rejection, the underlying setting is unchanged (180ms)
   #   2 passed (520ms)
   ```

2. If the test does not turn green, **stop** — route to `debugger`. Common failure: the `ValidationPipe` is bypassed by the `@Body()` decorator using a non-class `Array` body. Inspect the controller and ensure the body type is annotated with `@ValidateNested({ each: true }) @Type(() => UpdateTenantConfigRequest) configs: UpdateTenantConfigRequest[]`.

3. No commit (verification-only task).

---

## Task B.4 — Failing service-layer Vitest: direct spread vulnerability

**Agent**: `tester`

**Files**:
- Create: `packages/applications/src/services/tenant/__tests__/tenant.service.mass-assignment.test.ts`

**Steps**:

1. Write the failing test (the test exists to prove that even with the HTTP pipe bypassed, the service refuses non-allowlisted fields):

   ```typescript
   // packages/applications/src/services/tenant/__tests__/tenant.service.mass-assignment.test.ts
   import { describe, it, expect, beforeEach, vi } from 'vitest';
   import { TenantService } from '../tenant.service';
   import { GlobalSettingFactory, ResourceStatusType, ValueType } from '@arcaai/domains';

   const cls = { get: vi.fn(), set: vi.fn() };
   const events = { emit: vi.fn() };
   const tenantRepo = {
     findById: vi.fn(),
     findFirst: vi.fn(),
     findAll: vi.fn(),
     count: vi.fn(),
     create: vi.fn(),
     update: vi.fn(),
     softDelete: vi.fn(),
   };
   const gsRepo = {
     findById: vi.fn(),
     findAll: vi.fn(),
     count: vi.fn(),
     create: vi.fn(),
     update: vi.fn(),
   };
   const deps = { findAll: vi.fn(), count: vi.fn() };
   const ptemps = { findAll: vi.fn(), count: vi.fn() };
   const pipes = { findAll: vi.fn(), count: vi.fn() };
   const db = { getClient: vi.fn(), client: { userRoleAssignment: { findMany: vi.fn() } } };
   const buckets = { provisionSystemBuckets: vi.fn() };

   const installCls = (roles: string[]) => {
     cls.get.mockImplementation((k: string) => {
       if (k === 'user') return { id: 'doctor-id', roles };
       if (k === 'tenantId') return 'tenant-1';
       if (k === 'tenantCode') return 'TENANT_1';
       return null;
     });
   };

   describe('TenantService.updateTenantConfigs — explicit allowlist (TASK-302 Phase 0 Item 2)', () => {
     let service: TenantService;
     beforeEach(() => {
       vi.clearAllMocks();
       installCls(['DOCTOR']);
       service = new TenantService(
         tenantRepo as never, gsRepo as never, deps as never,
         ptemps as never, pipes as never, db as never, buckets as never,
         events as never, cls as never,
       );
     });

     it('rejects key/tenantId/locked/defaultValue smuggled past the HTTP pipe', async () => {
       const tenant = { id: 'tenant-1', key: 'TENANT_1', name: 'T1' };
       tenantRepo.findById.mockResolvedValue(tenant);
       tenantRepo.findFirst.mockResolvedValue(tenant);

       const existing = GlobalSettingFactory.CreateGlobalSetting({
         tenantId: 'tenant-1', key: 'enable-x', value: 'false',
         dataType: ValueType.Boolean, defaultValue: 'false',
         name: 'enable-x', namespace: 'com.flw.feature', description: '', locked: false,
       });
       gsRepo.findById.mockResolvedValue(existing);
       gsRepo.update.mockImplementation(async (_id, entity) => entity);

       await service.updateTenantConfigs('tenant-1', [
         {
           id: existing.id,
           value: 'true',
           // Smuggled fields — must be IGNORED by the service even though
           // they passed the type cast (e.g., the HTTP pipe was bypassed).
           key: 'JWT_SECRET_KEY',
           tenantId: '50000000-0000-0000-0000-000000000000',
           locked: true,
           defaultValue: 'attacker-default',
         } as never,
       ]);

       const persisted = gsRepo.update.mock.calls[0][1];
       expect(persisted.key, 'key must be unchanged by the service').toBe('enable-x');
       expect(persisted.tenantId, 'tenantId must be unchanged').toBe('tenant-1');
       expect(persisted.locked, 'locked must be unchanged').toBe(false);
       expect(persisted.defaultValue, 'defaultValue must be unchanged').toBe('false');
       expect(persisted.value, 'value must reflect the allowlisted change').toBe('true');
     });
   });
   ```

2. Verify it fails:

   ```bash
   pnpm --filter @arcaai/applications test:unit -- mass-assignment
   # Expected:
   #   ✗ rejects key/tenantId/locked/defaultValue smuggled past the HTTP pipe
   #     expected 'JWT_SECRET_KEY' to be 'enable-x'   ← service silently writes attacker key
   ```

3. Commit the failing test:

   ```bash
   git add packages/applications/src/services/tenant/__tests__/tenant.service.mass-assignment.test.ts
   git commit -m "$(cat <<'EOF'
   test(applications): document service-layer mass-assignment (currently failing)

   Phase 0 Item 2 (TASK-302 Stream A): pins the defense-in-depth contract
   for TenantService.updateTenantConfigs — even with the HTTP pipe
   bypassed, the service must refuse to write non-allowlisted fields.
   Test fails until B.5 replaces the spread with an explicit allowlist.
   EOF
   )"
   ```

---

## Task B.5 — Replace the spread with an explicit allowlist in `updateTenantConfigs`

**Agent**: `security-auditor`

**Files**:
- Modify: `packages/applications/src/services/tenant/tenant.service.ts` (lines 498–518)

**Steps**:

1. Identify the current vulnerable block at lines 502–504:

   ```typescript
   // eslint-disable-next-line @typescript-eslint/no-unused-vars
   const { id: _id, ...changes } = config;
   this.updateEntity(existingConfig, changes);
   ```

2. Implement the explicit allowlist — replace those three lines with:

   ```typescript
   // Phase 0 Item 2 (TASK-302 Stream A) — explicit allowlist closes the
   // mass-assignment chain at the service boundary. Defense in depth
   // for the strict ValidationPipe (Item 1). DO NOT expand without a
   // security review — every added field re-opens the surface.
   const changes: { value?: string; description?: string } = {};
   if (config.value !== undefined) changes.value = config.value;
   if (config.description !== undefined) changes.description = config.description;
   this.updateEntity(existingConfig, changes);
   ```

3. Verify Task B.4's test now passes:

   ```bash
   pnpm --filter @arcaai/applications test:unit -- mass-assignment
   # Expected output:
   #   ✓ rejects key/tenantId/locked/defaultValue smuggled past the HTTP pipe (12ms)
   #   Test Files  1 passed (1)
   #   Tests       1 passed (1)
   ```

4. Run the full tenant suite to confirm no regression:

   ```bash
   pnpm --filter @arcaai/applications test:unit -- tenant
   # Expected output: all existing tenant tests + new mass-assignment test pass.
   ```

5. Commit:

   ```bash
   git add packages/applications/src/services/tenant/tenant.service.ts
   git commit -m "$(cat <<'EOF'
   security(applications): replace spread with explicit allowlist in updateTenantConfigs

   Phase 0 Item 2 (TASK-302 Stream A): closes the service-layer mass-
   assignment surface (TASK-301 §P0-2 / §P0-5). Allowlist is { value,
   description } only; key, tenantId, locked, defaultValue are ignored
   even when present in the request body. Mirrors and back-stops the
   strict ValidationPipe added in B.2.
   EOF
   )"
   ```

---

## Task B.6 — Make `key`, `tenantId`, `locked`, `defaultValue` immutable on `GlobalSettingEntity`

**Agent**: `code-reviewer`

**Files**:
- Modify: `packages/domains/src/entities/generated/core/GlobalSettingEntity.ts`
- Create: `packages/domains/src/entities/__tests__/GlobalSettingEntity.immutable-fields.test.ts`

**Steps**:

1. Write the failing test:

   ```typescript
   // packages/domains/src/entities/__tests__/GlobalSettingEntity.immutable-fields.test.ts
   import { describe, it, expect } from 'vitest';
   import { GlobalSettingFactory, ValueType } from '../../index';

   describe('GlobalSettingEntity — Phase 0 Item 2 immutable fields', () => {
     const build = () =>
       GlobalSettingFactory.CreateGlobalSetting({
         tenantId: 'tenant-1', key: 'enable-x', value: 'false',
         dataType: ValueType.Boolean, defaultValue: 'false',
         name: 'enable-x', namespace: 'com.flw.feature', description: '', locked: false,
       });

     it.each(['key', 'tenantId', 'locked', 'defaultValue'])(
       'throws when setting %s post-construction',
       (field) => {
         const entity = build();
         expect(() => {
           // eslint-disable-next-line @typescript-eslint/no-explicit-any
           (entity as any)[field] = field === 'locked' ? true : 'attacker';
         }).toThrow(/immutable|cannot be modified/i);
       },
     );

     it('allows mutating value and description post-construction', () => {
       const entity = build();
       expect(() => { entity.value = 'true'; }).not.toThrow();
       expect(() => { entity.description = 'updated'; }).not.toThrow();
     });
   });
   ```

2. Verify the test fails:

   ```bash
   pnpm --filter @arcaai/domains test:unit -- immutable-fields
   # Expected: ✗ throws when setting key/tenantId/locked/defaultValue — no throw today.
   ```

3. Implement — edit the four setters in `GlobalSettingEntity.ts` to throw a `BusinessException`. The mapper builds the entity via the constructor (init payload from Prisma), so the setters are the only mutation path. Change each of:

   ```typescript
   set key(value: IGlobalSettingEntity['key']) {
     this.setProperty('key', value);
   }
   ```

   to:

   ```typescript
   set key(_value: IGlobalSettingEntity['key']) {
     throw new BusinessException(
       "Phase 0 Item 2 (TASK-302): GlobalSettingEntity.key is immutable post-construction.",
     );
   }
   ```

   Apply the same pattern to `tenantId`, `locked`, and `defaultValue`. (Note: `tenantId` lives on `BaseTaggedEntity`; if the setter is in the base class, override it in `GlobalSettingEntity` instead of editing the base.)

4. Check that `GlobalSettingFactory.CreateGlobalSetting` still works — the factory writes via the constructor's `init` payload, not via setters, so it remains unaffected. Verify:

   ```bash
   pnpm --filter @arcaai/domains test:unit -- GlobalSetting
   # Expected: existing GlobalSettingEntity factory tests + new immutable-fields test all pass.
   ```

5. Check that no service code currently mutates `key`, `tenantId`, `locked`, `defaultValue` on an already-constructed entity — a global grep is the safety net:

   ```bash
   rg -n "\.key\s*=|\.tenantId\s*=|\.locked\s*=|\.defaultValue\s*=" \
       packages/applications/src packages/domains/src apps/api/src \
       --type ts | rg -v '__tests__|\.test\.ts'
   ```

   Expected output: zero hits on `GlobalSettingEntity` instances (the only writes are via the constructor inside the factory and inside the mapper's `toDomainEntity`, both of which bypass setters).

6. Commit:

   ```bash
   git add packages/domains/src/entities/generated/core/GlobalSettingEntity.ts \
           packages/domains/src/entities/__tests__/GlobalSettingEntity.immutable-fields.test.ts
   git commit -m "$(cat <<'EOF'
   security(domains): make GlobalSettingEntity.key/tenantId/locked/defaultValue immutable

   Phase 0 Item 2 defense in depth (TASK-302 Stream A): setters throw
   BusinessException so that any future code path attempting to write
   these fields on an already-constructed entity fails fast. The
   GlobalSettingFactory.CreateGlobalSetting + mapper constructor paths
   are unaffected because they use the init payload directly.
   EOF
   )"
   ```

---

## Task B.7 — Verify the allowlist + immutability test pass

**Agent**: `tester`

**Files**: None.

**Steps**:

1. Run the entire affected package test suites:

   ```bash
   pnpm --filter @arcaai/domains test:unit
   pnpm --filter @arcaai/applications test:unit
   pnpm test:e2e -- phase-0-redteam
   ```

2. Expected output (truncated):

   ```
   @arcaai/domains
     ✓ GlobalSettingEntity — Phase 0 Item 2 immutable fields (5 tests)
     ✓ … existing tests …
   @arcaai/applications
     ✓ TenantService.updateTenantConfigs — explicit allowlist (1 test)
     ✓ TenantService — locked-field runtime plumbing (TASK-258 Agent D) (n tests)
     ✓ … existing tests …
   apps/api e2e
     ✓ Phase 0 — Item 1+2: mass-assignment chain (2 tests)
   ```

3. No commit (verification-only).

---

### Code Review Gate B

**Agent**: `code-reviewer`

Reviewer checklist for Section B:

- [ ] `phase-0-redteam.spec.ts` is committed with no `.skip` — the test must run on every CI pipeline.
- [ ] `main.ts:221` shows the **stage 2 form** with `whitelist`, `forbidNonWhitelisted`, `forbidUnknownValues` all `true`. If only stage 1 is committed, ask for the second commit before merging.
- [ ] `tenant.service.ts:502–504` no longer contains the `{ id: _id, ...changes }` spread. Search for it explicitly: `rg -n '\.\.\.changes' packages/applications/src/services/tenant/tenant.service.ts` — expect 0 matches.
- [ ] `GlobalSettingEntity.ts` setters for `key`, `tenantId`, `locked`, `defaultValue` all throw with a Phase-0-attributed message.
- [ ] The grep from Task B.6 step 5 shows zero unwanted mutations of those fields.
- [ ] `pnpm --filter @arcaai/api test:unit -- validation-pipe` passes.
- [ ] The CI pipeline for the Section B branch is green end-to-end.

If any item fails, block the PR and route to `debugger`.

---

# Section C — Item 3: Close the Authorization Bypass

**Section Goal**: Invert `AuthorizationGuard`'s default so empty-permission lists deny on `admin/*` routes (TASK-301 §P0-3), sweep every admin controller for missing `@CanManage`, and add a boot-time route-introspection guard that refuses startup if any `admin/*` route lacks an explicit permission decorator (TASK-301 §Phase 3 row 20, brought forward into Phase 0).

**Entry Criteria**: Section A merged. (B may be in parallel.)

**Exit Criteria**:
- Red-team test "DOCTOR assigning SUPER_ADMIN role returns 403" passes.
- Every admin controller carries an explicit `@CanManage(...)`, `@Authorize(...)`, `@CanRead(...)`, or equivalent.
- Boot-time guard refuses startup when an admin route is missing a permission decorator.
- Existing authorization E2E + unit tests still pass.

---

## Task C.1 — Failing red-team test: DOCTOR assigns SUPER_ADMIN role (expect 403)

**Agent**: `tester`

**Files**:
- Modify: `apps/api/tests/e2e/phase-0-redteam.spec.ts` (append a new describe block)

**Steps**:

1. Append to `phase-0-redteam.spec.ts`:

   ```typescript
   test.describe('Phase 0 — Item 3: privilege escalation via admin/users', () => {
     let doctorToken: string;
     let superAdminRoleId: string;
     let victimUserId: string;

     test.beforeAll(async ({ request }) => {
       const doctorLogin = await request.post('/api/v1/auth/login', {
         data: { username: 'doctor', password: 'password123', tenantKey: '__GLOBAL__' },
       });
       expect(doctorLogin.status()).toBe(200);
       doctorToken = (await doctorLogin.json()).token;

       // Discover the SUPER_ADMIN role id and any victim user id.
       // These are seeded by tests/setup/playwright.global-setup.ts.
       const adminLogin = await request.post('/api/v1/auth/login', {
         data: { username: 'super_admin', password: 'password123' },
       });
       const adminToken = (await adminLogin.json()).token;
       const rolesResp = await request.get('/api/v1/admin/rbac/roles', {
         headers: { Authorization: `Bearer ${adminToken}` },
       });
       const roles = (await rolesResp.json()).data;
       superAdminRoleId = roles.find((r: { key: string }) => r.key === 'SUPER_ADMIN')?.id;
       expect(superAdminRoleId, 'SUPER_ADMIN role id not discoverable').toBeDefined();

       const usersResp = await request.get('/api/v1/admin/users?page=1&pageSize=10', {
         headers: { Authorization: `Bearer ${adminToken}` },
       });
       const users = (await usersResp.json()).data;
       victimUserId = users.find((u: { username: string }) => u.username === 'nurse')?.id;
       expect(victimUserId, 'nurse user id not discoverable').toBeDefined();
     });

     test('POST /admin/users/:id/roles from DOCTOR is rejected with 403', async ({ request }) => {
       const response = await request.post(`/api/v1/admin/users/${victimUserId}/roles`, {
         headers: { Authorization: `Bearer ${doctorToken}` },
         data: { roleId: superAdminRoleId },
       });
       expect(response.status(), 'DOCTOR must NOT escalate roles').toBe(403);
     });

     test('GET /admin/users from DOCTOR is rejected with 403', async ({ request }) => {
       const response = await request.get('/api/v1/admin/users?page=1&pageSize=10', {
         headers: { Authorization: `Bearer ${doctorToken}` },
       });
       expect(response.status(), 'DOCTOR must NOT list users').toBe(403);
     });
   });
   ```

2. Verify the test fails:

   ```bash
   pnpm test:e2e -- phase-0-redteam
   # Expected:
   #   ✗ POST /admin/users/:id/roles from DOCTOR is rejected with 403
   #     Expected: 403; Received: 201   ← privilege escalation succeeds today
   ```

3. Commit:

   ```bash
   git add apps/api/tests/e2e/phase-0-redteam.spec.ts
   git commit -m "$(cat <<'EOF'
   test(api/e2e): add Phase 0 privilege-escalation red-team (currently failing)

   Phase 0 Item 3 (TASK-302 Stream A): documents the
   /admin/users/:id/roles privilege escalation from TASK-301 §P0-3
   as a Playwright contract test. Test fails until C.2 inverts the
   AuthorizationGuard default and C.3 sweeps admin controllers.
   EOF
   )"
   ```

---

## Task C.2 — Invert `AuthorizationGuard` default for `admin/*` routes

**Agent**: `security-auditor`

**Files**:
- Modify: `packages/applications/src/authorization/authorization.guard.ts`
- Create: `packages/applications/src/authorization/__tests__/authorization.guard.admin-deny.test.ts`

**Steps**:

1. Write the failing unit test (no NestJS app, just the guard logic):

   ```typescript
   // packages/applications/src/authorization/__tests__/authorization.guard.admin-deny.test.ts
   import { describe, it, expect, beforeEach, vi } from 'vitest';
   import { ExecutionContext, ForbiddenException } from '@nestjs/common';
   import { Reflector } from '@nestjs/core';
   import { AuthorizationGuard, SKIP_AUTH_KEY, REQUIRED_PERMISSIONS_KEY } from '../authorization.guard';

   const buildContext = (url: string, perms: unknown = undefined): ExecutionContext => {
     const handler = () => undefined;
     const cls = class Fake {};
     return {
       getHandler: () => handler,
       getClass: () => cls,
       switchToHttp: () => ({
         getRequest: () => ({ url, method: 'POST', params: {} }),
         getResponse: () => ({}),
       }),
     } as unknown as ExecutionContext;
   };

   describe('AuthorizationGuard — Phase 0 Item 3: deny by default on admin/*', () => {
     let reflector: Reflector;
     let cls: { get: (k: string) => unknown; set: () => void };
     const policyEngine = { buildAbility: vi.fn().mockResolvedValue({ can: () => true }) };

     beforeEach(() => {
       reflector = new Reflector();
       vi.spyOn(reflector, 'getAllAndOverride').mockImplementation((key: string) => {
         if (key === SKIP_AUTH_KEY) return false;
         if (key === REQUIRED_PERMISSIONS_KEY) return undefined; // empty list
         return undefined;
       });
       cls = { get: () => ({ id: 'u-1', tenantId: 't-1' }), set: () => undefined };
     });

     it('denies on /api/v1/admin/users when permissions are empty', async () => {
       const guard = new AuthorizationGuard(reflector, policyEngine as never, cls as never);
       await expect(guard.canActivate(buildContext('/api/v1/admin/users'))).rejects.toThrow(ForbiddenException);
     });

     it('allows on /api/v1/consultations when permissions are empty (non-admin)', async () => {
       const guard = new AuthorizationGuard(reflector, policyEngine as never, cls as never);
       await expect(guard.canActivate(buildContext('/api/v1/consultations'))).resolves.toBe(true);
     });
   });
   ```

2. Verify it fails:

   ```bash
   pnpm --filter @arcaai/applications test:unit -- admin-deny
   # Expected: ✗ denies on /api/v1/admin/users when permissions are empty.
   ```

3. Implement the inversion in `authorization.guard.ts` lines 96–100. Replace:

   ```typescript
   // No permissions required = allow (but still need authentication)
   if (!required || required.length === 0) {
     return true;
   }
   ```

   with:

   ```typescript
   // Phase 0 Item 3 (TASK-302 Stream A) — deny by default on admin/* routes
   // when no explicit permissions are declared. TASK-301 §P0-3 closed the
   // empty-list bypass that previously auto-allowed any authenticated user.
   const request = context.switchToHttp().getRequest();
   const path: string | undefined = request?.url;
   const isAdminRoute = typeof path === 'string' && /^\/(api\/v\d+\/)?admin\//.test(path);

   if (!required || required.length === 0) {
     if (isAdminRoute) {
       this.logger.warn({
         message: 'Phase 0 Item 3: refused admin route with no @CanManage / @Authorize decorator',
         path,
       });
       throw new ForbiddenException('Admin routes require an explicit permission decorator.');
     }
     return true;
   }
   ```

4. Verify the unit test now passes:

   ```bash
   pnpm --filter @arcaai/applications test:unit -- admin-deny
   # Expected:
   #   ✓ denies on /api/v1/admin/users when permissions are empty (3ms)
   #   ✓ allows on /api/v1/consultations when permissions are empty (non-admin) (2ms)
   ```

5. Commit:

   ```bash
   git add packages/applications/src/authorization/authorization.guard.ts \
           packages/applications/src/authorization/__tests__/authorization.guard.admin-deny.test.ts
   git commit -m "$(cat <<'EOF'
   security(authorization): deny by default on admin/* when permissions empty

   Phase 0 Item 3 (TASK-302 Stream A): inverts the AuthorizationGuard
   default for any path matching ^/(api/v\d+/)?admin/. Empty permission
   lists now throw ForbiddenException with a Phase-0-attributed log.
   Closes the TASK-301 §P0-3 / §P0-4 privilege-escalation chain at the
   guard layer.
   EOF
   )"
   ```

---

## Task C.3 — Sweep admin controllers: add explicit `@CanManage(...)` where missing

**Agent**: `security-auditor`

**Files**:
- Modify: `apps/api/src/modules/user/user.controller.ts` (line 31 — replace `@Authorize()` with `@CanManage('User')`)
- Modify: `apps/api/src/modules/department/department.controller.ts` (line 16 — replace `@Authorize()` with `@CanManage('Department')`)
- Modify: `apps/api/src/modules/tenant-bucket/tenant-bucket.controller.ts` (line 9 — replace `@Authorize()` with `@CanManage('TenantBucket')`)
- Modify: `apps/api/src/modules/storage-access-key/storage-access-key.controller.ts` (line 14 — replace `@Authorize()` with `@CanManage('StorageAccessKey')`)
- Modify: `apps/api/src/modules/pstudio/pstudio.controller.ts` — add `@CanManage('PrismaStudio')` at class level
- Modify: `apps/api/src/modules/rbac/policies.controller.ts` — add `@CanManage('Policy')` at class level
- Modify: `apps/api/src/modules/api-key/api-key.controller.ts` — add `@CanManage('ApiKey')` at class level
- Modify: `apps/api/src/modules/rbac/roles.controller.ts` — add `@CanManage('Role')` at class level
- Modify: `apps/api/src/modules/audit-log/audit-log.controller.ts` — add `@CanRead('AuditLog')` at class level (audit-log access is read-only — never `manage`)

**Steps**:

1. For each file, follow the same edit pattern. Example for `user.controller.ts`:

   ```diff
    @ApiBearerAuth()
    @ApiTags('admin-users')
    @Controller('admin/users')
   -@Authorize()
   +// Phase 0 Item 3 (TASK-302 Stream A): explicit permission required.
   +@CanManage('User')
    export class UserController {
   ```

   Add `CanManage` to the existing import line (`import { ApiEndpoint, Authorize, CanManage } from '../../decorators'`). For controllers without `@Authorize()` today, add the import and decorator both. For `audit-log.controller.ts`, prefer `CanRead` over `CanManage` — auditors must never mutate audit data.

2. Run the existing E2E suite to confirm no breakage:

   ```bash
   pnpm test:e2e -- authorization rbac auth-guard-behavior
   # Expected: all existing tests pass; SUPER_ADMIN still has bypass (CASL 'manage:all'), TENANT_ADMIN reaches admin routes as before.
   ```

3. Run the Phase 0 red-team test:

   ```bash
   pnpm test:e2e -- phase-0-redteam
   # Expected:
   #   ✓ POST /admin/users/:id/roles from DOCTOR is rejected with 403
   #   ✓ GET /admin/users from DOCTOR is rejected with 403
   ```

4. Commit:

   ```bash
   git add apps/api/src/modules/user/user.controller.ts \
           apps/api/src/modules/department/department.controller.ts \
           apps/api/src/modules/tenant-bucket/tenant-bucket.controller.ts \
           apps/api/src/modules/storage-access-key/storage-access-key.controller.ts \
           apps/api/src/modules/pstudio/pstudio.controller.ts \
           apps/api/src/modules/rbac/policies.controller.ts \
           apps/api/src/modules/rbac/roles.controller.ts \
           apps/api/src/modules/api-key/api-key.controller.ts \
           apps/api/src/modules/audit-log/audit-log.controller.ts
   git commit -m "$(cat <<'EOF'
   security(api): sweep admin/* controllers for explicit @CanManage

   Phase 0 Item 3 (TASK-302 Stream A): every controller mounted under
   /admin/* now carries an explicit @CanManage(<Subject>) or @CanRead
   class decorator. audit-log.controller.ts is @CanRead-only by design.
   Closes the TASK-301 §P0-3 exploit chain at the controller layer.
   EOF
   )"
   ```

---

## Task C.4 — Boot-time route-introspection guard

**Agent**: `security-auditor`

**Files**:
- Create: `apps/api/src/bootstrap/admin-route-permission-audit.ts`
- Modify: `apps/api/src/main.ts` (call the audit after `app = await NestFactory.create(...)` and before `app.listen()`)
- Create: `apps/api/src/bootstrap/__tests__/admin-route-permission-audit.test.ts`

**Steps**:

1. Write the failing test:

   ```typescript
   // apps/api/src/bootstrap/__tests__/admin-route-permission-audit.test.ts
   import { describe, it, expect } from 'vitest';
   import { auditAdminRoutePermissions } from '../admin-route-permission-audit';

   const fakeApp = (routes: Array<{ path: string; method: string; metadata: Record<string, unknown> }>) => ({
     getHttpAdapter: () => ({
       getInstance: () => ({
         _router: {
           stack: routes.map((r) => ({
             route: { path: r.path, methods: { [r.method.toLowerCase()]: true } },
             handle: Object.assign(() => undefined, { __metadata: r.metadata }),
           })),
         },
       }),
     }),
   });

   describe('Phase 0 Item 3 — boot-time admin route permission audit', () => {
     it('passes when every admin route declares required_permissions', () => {
       const app = fakeApp([
         { path: '/api/v1/admin/users', method: 'GET',
           metadata: { required_permissions: [{ action: 'manage', subject: 'User' }] } },
       ]);
       expect(() => auditAdminRoutePermissions(app as never)).not.toThrow();
     });

     it('throws when an admin route is missing required_permissions', () => {
       const app = fakeApp([
         { path: '/api/v1/admin/orphans', method: 'GET', metadata: {} },
       ]);
       expect(() => auditAdminRoutePermissions(app as never))
         .toThrow(/admin\/orphans.*missing.*permission/i);
     });
   });
   ```

2. Verify it fails:

   ```bash
   pnpm --filter @arcaai/api test:unit -- admin-route-permission-audit
   # Expected: ✗ — module './admin-route-permission-audit' not found.
   ```

3. Implement — create `apps/api/src/bootstrap/admin-route-permission-audit.ts`:

   ```typescript
   import type { INestApplication } from '@nestjs/common';
   import { REQUIRED_PERMISSIONS_KEY, SKIP_AUTH_KEY } from '@arcaai/applications';

   /**
    * Phase 0 Item 3 (TASK-302 Stream A) — boot-time route audit.
    *
    * Walks the Express router and refuses to start the app if any route
    * matching ^/(api/v\d+/)?admin/ lacks an explicit permission decorator
    * (REQUIRED_PERMISSIONS_KEY metadata set to a non-empty array) AND is
    * not explicitly marked @Public() via SKIP_AUTH_KEY.
    *
    * Throwing here propagates to the bootstrap caller in main.ts; the
    * process exits non-zero before listen(). Continuous prevention of
    * TASK-301 §P0-3 regressions.
    */
   export function auditAdminRoutePermissions(app: INestApplication): void {
     const http = app.getHttpAdapter();
     const instance = http.getInstance() as { _router?: { stack: Array<any> } };
     const stack = instance?._router?.stack ?? [];

     const adminRouteRegex = /^\/?(api\/v\d+\/)?admin\//;
     const offenders: string[] = [];

     for (const layer of stack) {
       const route = layer?.route;
       if (!route || typeof route.path !== 'string') continue;
       if (!adminRouteRegex.test(route.path)) continue;

       const handler = layer.handle;
       const metadata = handler?.__metadata ?? {};
       const isPublic = metadata[SKIP_AUTH_KEY] === true;
       const perms = metadata[REQUIRED_PERMISSIONS_KEY] as unknown[] | undefined;

       if (isPublic) continue;
       if (Array.isArray(perms) && perms.length > 0) continue;

       const methods = Object.keys(route.methods ?? {}).join(',').toUpperCase();
       offenders.push(`${methods} ${route.path}`);
     }

     if (offenders.length > 0) {
       const list = offenders.map((o) => `  - ${o}`).join('\n');
       throw new Error(
         `Phase 0 Item 3 (TASK-302): refused to start — ${offenders.length} admin route(s) ` +
         `lack an explicit @CanManage / @Authorize / @CanRead / @Public decorator:\n${list}`,
       );
     }
   }
   ```

4. Wire into `main.ts` — add the call after `await NestFactory.create(...)` and before `await app.listen(...)`:

   ```typescript
   import { auditAdminRoutePermissions } from './bootstrap/admin-route-permission-audit';

   // … inside bootstrap() …
   auditAdminRoutePermissions(app);
   ```

5. Run the test:

   ```bash
   pnpm --filter @arcaai/api test:unit -- admin-route-permission-audit
   # Expected:
   #   ✓ passes when every admin route declares required_permissions (1ms)
   #   ✓ throws when an admin route is missing required_permissions (2ms)
   ```

6. Boot the API locally and confirm the audit fires (should succeed because Task C.3 swept every admin controller):

   ```bash
   pnpm dev:api
   # Expected log line:
   #   [Bootstrap] Phase 0 Item 3 admin route audit passed (N routes checked).
   ```

   To test the **failure** path, temporarily revert one admin controller's decorator:

   ```bash
   # Temporary smoke (revert before continuing):
   # 1. Open apps/api/src/modules/pstudio/pstudio.controller.ts
   # 2. Comment out @CanManage('PrismaStudio')
   # 3. pnpm dev:api  → expect non-zero exit with the offender listed
   # 4. Re-instate the decorator
   ```

7. Commit:

   ```bash
   git add apps/api/src/bootstrap/admin-route-permission-audit.ts \
           apps/api/src/bootstrap/__tests__/admin-route-permission-audit.test.ts \
           apps/api/src/main.ts
   git commit -m "$(cat <<'EOF'
   security(api/bootstrap): refuse startup on undecorated admin routes

   Phase 0 Item 3 (TASK-302 Stream A): boot-time route-introspection
   guard refuses to call app.listen() if any path matching
   ^/(api/v\d+/)?admin/ lacks an explicit @CanManage / @Authorize /
   @Public decorator. Continuous prevention of TASK-301 §P0-3
   regressions. Lifted forward from Phase 3 row 20 of the Roadmap.
   EOF
   )"
   ```

---

## Task C.5 — Verify the red-team test now returns 403

**Agent**: `tester`

**Files**: None.

**Steps**:

1. Re-run:

   ```bash
   pnpm test:e2e -- phase-0-redteam
   # Expected:
   #   ✓ Phase 0 — Item 3: privilege escalation via admin/users › POST … 403 (190ms)
   #   ✓ Phase 0 — Item 3: privilege escalation via admin/users › GET … 403 (95ms)
   ```

2. No commit (verification-only).

---

### Code Review Gate C

**Agent**: `code-reviewer`

Reviewer checklist for Section C:

- [ ] `authorization.guard.ts` lines 96–100 carry the inverted default (deny on admin/* when empty). Search `rg -n 'isAdminRoute' packages/applications/src/authorization/authorization.guard.ts` — expect 1+ hits.
- [ ] Every controller mounted at `/admin/*` (run `rg '@Controller\("admin/' apps/api/src/modules` to enumerate) has a non-empty permission decorator on the class. Cross-check against the C.3 file list.
- [ ] `auditAdminRoutePermissions` is invoked in `main.ts` and its test file is green.
- [ ] `phase-0-redteam.spec.ts` Section C cases pass.
- [ ] No existing E2E test failed (run `pnpm test:e2e` end-to-end and paste the trailing summary).
- [ ] The boot-time guard's failure-path smoke (Task C.4 step 6 manual smoke) was executed by the reviewer.

---

# Section D — Item 4: Audit-Log Secret Scrubbing

**Section Goal**: Introduce a reusable `@Secret` field decorator + an audit-log scrubber that strips fields marked `@Secret` from `SysEvent` payloads when the source row has `locked === true`. Closes TASK-301 §P0-6 — locked secret values must never enter the persistent audit-log surface.

**Entry Criteria**: Section A merged. (C may be in parallel.)

**Exit Criteria**:
- Unit test "SysEvent.ResourceUpdated for locked-row update contains '[REDACTED]'" passes.
- Every `GlobalSettingEntity` field is either marked `@Secret` or explicitly listed in the non-secret allowlist (no false negatives).
- Existing `auditLog.processor.ts` continues to write audit rows; the rows for locked updates carry `[REDACTED]` placeholders in `value` and `defaultValue`.
- A documented backfill SQL proposal exists (Task D.6) — **not executed**, awaits user approval.

---

## Task D.1 — Failing unit test: SysEvent payload for locked-row update contains `[REDACTED]`

**Agent**: `tester`

**Files**:
- Create: `packages/applications/src/services/tenant/__tests__/tenant.service.audit-scrub.test.ts`

**Steps**:

1. Write the failing test:

   ```typescript
   // packages/applications/src/services/tenant/__tests__/tenant.service.audit-scrub.test.ts
   import { describe, it, expect, beforeEach, vi } from 'vitest';
   import { TenantService } from '../tenant.service';
   import { GlobalSettingFactory, SysEventType, ValueType } from '@arcaai/domains';

   const cls = { get: vi.fn(), set: vi.fn() };
   const events = { emit: vi.fn() };
   const tenantRepo = {
     findById: vi.fn(), findFirst: vi.fn(), findAll: vi.fn(),
     count: vi.fn(), create: vi.fn(), update: vi.fn(), softDelete: vi.fn(),
   };
   const gsRepo = {
     findById: vi.fn(), findAll: vi.fn(), count: vi.fn(), create: vi.fn(), update: vi.fn(),
   };
   const deps = { findAll: vi.fn(), count: vi.fn() };
   const ptemps = { findAll: vi.fn(), count: vi.fn() };
   const pipes = { findAll: vi.fn(), count: vi.fn() };
   const db = { getClient: vi.fn(), client: { userRoleAssignment: { findMany: vi.fn() } } };
   const buckets = { provisionSystemBuckets: vi.fn() };

   describe('TenantService — audit-log secret scrubbing (Phase 0 Item 4)', () => {
     let service: TenantService;
     beforeEach(() => {
       vi.clearAllMocks();
       cls.get.mockImplementation((k: string) =>
         k === 'user' ? { id: 'sa-id', roles: ['SUPER_ADMIN'] }
         : k === 'tenantId' ? 'tenant-1'
         : k === 'tenantCode' ? 'TENANT_1' : null);
       service = new TenantService(
         tenantRepo as never, gsRepo as never, deps as never,
         ptemps as never, pipes as never, db as never, buckets as never,
         events as never, cls as never,
       );
     });

     it('redacts value and defaultValue in SysEvent payload for locked rows', async () => {
       const tenant = { id: 'tenant-1', key: 'TENANT_1', name: 'T1' };
       tenantRepo.findById.mockResolvedValue(tenant);
       tenantRepo.findFirst.mockResolvedValue(tenant);

       const locked = GlobalSettingFactory.CreateGlobalSetting({
         tenantId: 'tenant-1', key: 'JWT_SECRET_KEY',
         value: 'old-secret', dataType: ValueType.String,
         defaultValue: 'old-default', name: 'JWT', namespace: 'com.flw.auth',
         description: '', locked: true,
       });
       gsRepo.findById.mockResolvedValue(locked);
       gsRepo.update.mockImplementation(async (_id, entity) => entity);

       await service.updateTenantConfigs('tenant-1', [
         { id: locked.id, value: 'new-secret' } as never,
       ]);

       const emit = events.emit.mock.calls.find((c) => c[0] === SysEventType.ResourceUpdated);
       expect(emit, 'ResourceUpdated SysEvent must have been emitted').toBeDefined();
       const data = (emit![1] as { data: Array<Record<string, unknown>> }).data;

       expect(data[0].value, 'locked value must be redacted').toBe('[REDACTED]');
       expect(data[0].defaultValue, 'locked defaultValue must be redacted').toBe('[REDACTED]');
       expect(data[0].key, 'non-secret key may be present').toBe('JWT_SECRET_KEY');
       expect(data[0].locked, 'locked flag may be present').toBe(true);
     });

     it('does NOT redact value or defaultValue for unlocked rows', async () => {
       const tenant = { id: 'tenant-1', key: 'TENANT_1', name: 'T1' };
       tenantRepo.findById.mockResolvedValue(tenant);
       tenantRepo.findFirst.mockResolvedValue(tenant);

       const unlocked = GlobalSettingFactory.CreateGlobalSetting({
         tenantId: 'tenant-1', key: 'enable-x',
         value: 'false', dataType: ValueType.Boolean,
         defaultValue: 'false', name: 'enable-x', namespace: 'com.flw.feature',
         description: '', locked: false,
       });
       gsRepo.findById.mockResolvedValue(unlocked);
       gsRepo.update.mockImplementation(async (_id, entity) => entity);

       await service.updateTenantConfigs('tenant-1', [
         { id: unlocked.id, value: 'true' } as never,
       ]);

       const emit = events.emit.mock.calls.find((c) => c[0] === SysEventType.ResourceUpdated);
       const data = (emit![1] as { data: Array<Record<string, unknown>> }).data;
       expect(data[0].value, 'unlocked rows must NOT be redacted').toBe('true');
       expect(data[0].defaultValue).toBe('false');
     });
   });
   ```

2. Verify it fails:

   ```bash
   pnpm --filter @arcaai/applications test:unit -- audit-scrub
   # Expected: ✗ — locked value 'old-secret' is present (not '[REDACTED]').
   ```

3. Commit the failing test:

   ```bash
   git add packages/applications/src/services/tenant/__tests__/tenant.service.audit-scrub.test.ts
   git commit -m "$(cat <<'EOF'
   test(applications): document audit-log secret leak (currently failing)

   Phase 0 Item 4 (TASK-302 Stream A): pins the secret-scrub contract.
   Locked-row updates must emit SysEvent payloads with value and
   defaultValue replaced by '[REDACTED]'. Test fails until D.2-D.4 add
   the @Secret decorator, mark the GlobalSettingEntity fields, and
   teach the broadcastSysEvent path to scrub.
   EOF
   )"
   ```

---

## Task D.2 — Create the `@Secret` field decorator

**Agent**: `security-auditor`

**Files**:
- Create: `packages/applications/src/common/decorators/secret.decorator.ts`
- Create: `packages/applications/src/common/decorators/__tests__/secret.decorator.test.ts`
- Create: `packages/applications/src/common/decorators/index.ts`
- Modify: `packages/applications/src/common/index.ts` to re-export the new `decorators` barrel

**Steps**:

1. Write the failing test:

   ```typescript
   // packages/applications/src/common/decorators/__tests__/secret.decorator.test.ts
   import { describe, it, expect } from 'vitest';
   import 'reflect-metadata';
   import { Secret, getSecretFields, SECRET_FIELDS_KEY } from '../secret.decorator';

   class Sample {
     @Secret() value!: string;
     @Secret() defaultValue?: string;
     id!: string;
     key!: string;
   }

   describe('@Secret decorator (Phase 0 Item 4)', () => {
     it('registers the decorated fields under SECRET_FIELDS_KEY', () => {
       const fields = Reflect.getMetadata(SECRET_FIELDS_KEY, Sample.prototype);
       expect(new Set(fields)).toEqual(new Set(['value', 'defaultValue']));
     });

     it('getSecretFields returns the same set', () => {
       expect(new Set(getSecretFields(Sample.prototype))).toEqual(
         new Set(['value', 'defaultValue']),
       );
     });

     it('getSecretFields returns [] for a class with no decorations', () => {
       class Plain { id!: string }
       expect(getSecretFields(Plain.prototype)).toEqual([]);
     });
   });
   ```

2. Verify it fails:

   ```bash
   pnpm --filter @arcaai/applications test:unit -- secret.decorator
   # Expected: ✗ — module './secret.decorator' not found.
   ```

3. Implement the decorator:

   ```typescript
   // packages/applications/src/common/decorators/secret.decorator.ts
   import 'reflect-metadata';

   /**
    * Phase 0 Item 4 (TASK-302 Stream A) — field-level metadata marker.
    *
    * Apply `@Secret()` to an entity property whose value MUST be redacted
    * before crossing any audit-log boundary. The audit serializer
    * (services/tenant/scrubbing.ts) reads this metadata via
    * `getSecretFields(prototype)` and replaces decorated keys with
    * '[REDACTED]' when the source row carries `locked === true`.
    *
    * Stream B Phase 4 will extend this metadata to drive envelope
    * encryption on persistence — the contract here is intentionally
    * decoupled so both streams can evolve independently.
    */
   export const SECRET_FIELDS_KEY = Symbol('phase-0-item-4:secret-fields');

   export function Secret(): PropertyDecorator {
     return (target: object, propertyKey: string | symbol) => {
       const existing: Array<string | symbol> =
         Reflect.getMetadata(SECRET_FIELDS_KEY, target) ?? [];
       if (!existing.includes(propertyKey)) {
         Reflect.defineMetadata(SECRET_FIELDS_KEY, [...existing, propertyKey], target);
       }
     };
   }

   export function getSecretFields(prototype: object): Array<string> {
     const fields: Array<string | symbol> =
       Reflect.getMetadata(SECRET_FIELDS_KEY, prototype) ?? [];
     return fields.filter((f): f is string => typeof f === 'string');
   }
   ```

   ```typescript
   // packages/applications/src/common/decorators/index.ts
   export * from './secret.decorator';
   ```

4. Update the common barrel:

   ```typescript
   // packages/applications/src/common/index.ts (append)
   export * from './decorators';
   ```

5. Verify the test passes:

   ```bash
   pnpm --filter @arcaai/applications test:unit -- secret.decorator
   # Expected:
   #   ✓ registers the decorated fields under SECRET_FIELDS_KEY (1ms)
   #   ✓ getSecretFields returns the same set (1ms)
   #   ✓ getSecretFields returns [] for a class with no decorations (1ms)
   ```

6. Commit:

   ```bash
   git add packages/applications/src/common/decorators/ packages/applications/src/common/index.ts
   git commit -m "$(cat <<'EOF'
   feat(applications): add @Secret field decorator + getSecretFields()

   Phase 0 Item 4 (TASK-302 Stream A): field-level metadata marker that
   downstream audit-log scrubbers consume to redact secret values from
   SysEvent payloads. Decoupled from persistence — Stream B Phase 4 will
   extend the same metadata to drive envelope encryption.
   EOF
   )"
   ```

---

## Task D.3 — Apply `@Secret` to `GlobalSettingEntity.value` and `defaultValue`

**Agent**: `security-auditor`

**Files**:
- Modify: `packages/domains/src/entities/generated/core/GlobalSettingEntity.ts`
- Create: `packages/domains/src/entities/__tests__/GlobalSettingEntity.secret-coverage.test.ts`

> Note: `@Secret` lives in `@arcaai/applications`. `@arcaai/domains` would gain a new outbound dependency. To avoid that coupling, we **define a thin re-export shim** at `packages/domains/src/common/secret.decorator.ts` that re-uses `Reflect.defineMetadata` with the **same `SECRET_FIELDS_KEY` symbol** loaded from `@arcaai/applications/common/decorators`. The applications package depends on `@arcaai/domains` (not the reverse), so we instead **invert** the location: define the decorator in `@arcaai/domains` (which `@arcaai/applications` already depends on) and re-export from `@arcaai/applications` for ergonomics.
>
> **Revised**: Place the decorator's source in `packages/domains/src/common/secret.decorator.ts`. Task D.2's path becomes a re-export from `@arcaai/applications`. The applications side adds a one-line file that re-exports for backward compatibility.
>
> The reviewer at Code Review Gate D enforces this — either path is acceptable so long as `@arcaai/domains` does not import from `@arcaai/applications`.

**Steps**:

1. Move the decorator source to `packages/domains/src/common/secret.decorator.ts` (identical implementation, then a re-export from `@arcaai/applications/src/common/decorators/secret.decorator.ts` becomes `export { Secret, getSecretFields, SECRET_FIELDS_KEY } from '@arcaai/domains';`).

2. Update `packages/domains/src/common/index.ts` to export the decorator.

3. Write the coverage test in `@arcaai/domains`:

   ```typescript
   // packages/domains/src/entities/__tests__/GlobalSettingEntity.secret-coverage.test.ts
   import { describe, it, expect } from 'vitest';
   import 'reflect-metadata';
   import { getSecretFields } from '../../common';
   import { GlobalSettingEntity } from '../generated/core/GlobalSettingEntity';

   /**
    * Phase 0 Item 4 R4 mitigation: every GlobalSettingEntity field is
    * either marked @Secret or in the explicit non-secret allowlist.
    * Adding a new field without one of these triggers test failure.
    */
   const NON_SECRET_ALLOWLIST = new Set([
     'id', 'key', 'name', 'tenantId', 'locked', 'dataType', 'namespace',
     'description', 'resourceStatus', 'version', 'createdAt', 'updatedAt',
     'deletedAt', 'createdBy', 'updatedBy', 'tags', 'parsedValue', 'changes',
     'hasChanges',
   ]);

   describe('GlobalSettingEntity @Secret coverage (Phase 0 Item 4 / R4)', () => {
     it('value and defaultValue are marked @Secret', () => {
       const fields = new Set(getSecretFields(GlobalSettingEntity.prototype));
       expect(fields).toContain('value');
       expect(fields).toContain('defaultValue');
     });

     it('every entity field is either @Secret or explicitly non-secret', () => {
       // Use the entity prototype's getter descriptor list.
       const proto = GlobalSettingEntity.prototype;
       const props = Object.getOwnPropertyNames(proto).filter(
         (p) => p !== 'constructor' && !p.startsWith('_'),
       );
       const secrets = new Set(getSecretFields(proto));
       const uncovered = props.filter(
         (p) => !secrets.has(p) && !NON_SECRET_ALLOWLIST.has(p),
       );
       expect(
         uncovered,
         `Add to NON_SECRET_ALLOWLIST or annotate @Secret: ${uncovered.join(', ')}`,
       ).toEqual([]);
     });
   });
   ```

4. Verify it fails:

   ```bash
   pnpm --filter @arcaai/domains test:unit -- secret-coverage
   # Expected: ✗ — `value` not in @Secret fields.
   ```

5. Apply `@Secret` to the entity. Edit `GlobalSettingEntity.ts` and decorate the **getters** (TypeScript property decorators run on the prototype regardless of getter/setter shape):

   ```typescript
   import { Secret } from '../../../common';

   // …

   @Secret()
   get value(): IGlobalSettingEntity['value'] {
     return this._value;
   }
   // setter is now the throw-immutable in B.6 for locked-by-default rows;
   // for non-secret rows the setter mutates via setProperty('value', …)
   // BUT B.6 made key/tenantId/locked/defaultValue immutable, not value.
   // value remains mutable for unlocked rows.

   @Secret()
   get defaultValue(): IGlobalSettingEntity['defaultValue'] {
     return this._defaultValue;
   }
   ```

6. Verify the coverage test now passes:

   ```bash
   pnpm --filter @arcaai/domains test:unit -- secret-coverage
   # Expected:
   #   ✓ value and defaultValue are marked @Secret (2ms)
   #   ✓ every entity field is either @Secret or explicitly non-secret (1ms)
   ```

7. Commit:

   ```bash
   git add packages/domains/src/common/ packages/domains/src/entities/generated/core/GlobalSettingEntity.ts \
           packages/domains/src/entities/__tests__/GlobalSettingEntity.secret-coverage.test.ts \
           packages/applications/src/common/decorators/secret.decorator.ts
   git commit -m "$(cat <<'EOF'
   feat(domains): mark GlobalSettingEntity.value/defaultValue as @Secret

   Phase 0 Item 4 (TASK-302 Stream A): annotates the two secret-bearing
   fields. Adds a coverage test that fails on any new entity field that
   is neither @Secret-marked nor in the explicit non-secret allowlist —
   R4 mitigation. The decorator source moved to @arcaai/domains/common
   to avoid an outbound dep from domains to applications.
   EOF
   )"
   ```

---

## Task D.4 — Teach `broadcastSysEvent` (via TenantService) to scrub `@Secret` fields when `locked === true`

**Agent**: `security-auditor`

**Files**:
- Create: `packages/applications/src/services/tenant/scrubbing.ts`
- Modify: `packages/applications/src/services/tenant/tenant.service.ts` (lines 520–523)

**Steps**:

1. Implement the scrubber:

   ```typescript
   // packages/applications/src/services/tenant/scrubbing.ts
   import { GlobalSettingEntity, getSecretFields } from '@arcaai/domains';

   /**
    * Phase 0 Item 4 (TASK-302 Stream A) — pure utility.
    *
    * Converts a GlobalSettingEntity to a plain object suitable for an
    * audit-log payload. If the entity has `locked === true`, every field
    * decorated with `@Secret` is replaced with '[REDACTED]'. Non-locked
    * rows are returned via the unmodified `entity.toObject()` shape.
    *
    * The decision is per-entity (not per-call) so a mixed batch
    * (one locked, one not) emits a partially-scrubbed array.
    */
   export function scrubLockedForAudit(entity: GlobalSettingEntity): object {
     const plain = entity.toObject() as Record<string, unknown>;
     if (entity.locked !== true) return plain;

     const secrets = getSecretFields(Object.getPrototypeOf(entity));
     const scrubbed: Record<string, unknown> = { ...plain };
     for (const key of secrets) {
       if (key in scrubbed) scrubbed[key] = '[REDACTED]';
     }
     return Object.freeze(scrubbed);
   }
   ```

2. Modify `tenant.service.ts` lines 520–523 — replace:

   ```typescript
   this.broadcastSysEvent(SysEventType.ResourceUpdated, {
     resourceIds: updatedConfigs.map((config) => config.id),
     data: updatedConfigs.map((config) => config.toObject()),
   });
   ```

   with:

   ```typescript
   // Phase 0 Item 4 (TASK-302 Stream A) — scrub @Secret fields when locked.
   this.broadcastSysEvent(SysEventType.ResourceUpdated, {
     resourceIds: updatedConfigs.map((config) => config.id),
     data: updatedConfigs.map((config) => scrubLockedForAudit(config)),
   });
   ```

   Plus the import:

   ```typescript
   import { scrubLockedForAudit } from './scrubbing';
   ```

3. Run the failing test from D.1:

   ```bash
   pnpm --filter @arcaai/applications test:unit -- audit-scrub
   # Expected:
   #   ✓ redacts value and defaultValue in SysEvent payload for locked rows (10ms)
   #   ✓ does NOT redact value or defaultValue for unlocked rows (9ms)
   ```

4. Commit:

   ```bash
   git add packages/applications/src/services/tenant/scrubbing.ts \
           packages/applications/src/services/tenant/tenant.service.ts
   git commit -m "$(cat <<'EOF'
   security(applications): scrub @Secret fields from SysEvent for locked rows

   Phase 0 Item 4 (TASK-302 Stream A): teaches
   TenantService.updateTenantConfigs to call scrubLockedForAudit on each
   updated row before broadcasting ResourceUpdated. Locked rows emit
   '[REDACTED]' for every @Secret field; unlocked rows are unchanged.
   Closes the TASK-301 §P0-6 audit-log secret leak prospectively.
   EOF
   )"
   ```

---

## Task D.5 — Verify SysEvent test passes (and check the AuditLog row shape)

**Agent**: `tester`

**Files**: None.

**Steps**:

1. Re-run the unit test suite:

   ```bash
   pnpm --filter @arcaai/applications test:unit -- tenant
   # Expected:
   #   ✓ TenantService — audit-log secret scrubbing (2 tests)
   #   ✓ TenantService.updateTenantConfigs — explicit allowlist (1 test)
   #   ✓ TenantService — locked-field runtime plumbing (n tests)
   #   ✓ … existing tests …
   ```

2. End-to-end probe (manual, against staging):

   - Trigger a locked-row update as SUPER_ADMIN (e.g., rotate `JWT_SECRET_KEY` in the GlobalSetting table via the same `updateTenantConfigs` flow).
   - Read the resulting `AuditLog` row:

     ```sql
     SELECT
       id, action, "resourceId", data
     FROM "core"."AuditLog"
     WHERE "resourceType" = 'GlobalSetting'
       AND "createdAt" > now() - interval '5 minutes'
     ORDER BY "createdAt" DESC
     LIMIT 5;
     ```

   - Expected: `data` JSON contains `"value": "[REDACTED]"` and `"defaultValue": "[REDACTED]"` for the locked row.

   > **Workspace rule**: this probe is a `SELECT` — no `DELETE`/`DROP`/`TRUNCATE`. If a follow-up cleanup is needed, route through Task D.6.

3. No commit (verification-only).

---

## Task D.6 — Backfill SQL proposal (DOCUMENT ONLY — DO NOT EXECUTE)

**Agent**: `docs-manager`

**Files**:
- Create: `docs/implementation/TASK-302-System-Config-Implementation-Roadmap/_section-d-backfill-proposal.md`

**Steps**:

1. Write the proposal — every operation is documented but **gated behind user approval** per workspace rule:

   ```markdown
   # Section D — Audit-Log Backfill Proposal

   **Status**: PROPOSED — DO NOT EXECUTE WITHOUT USER APPROVAL
   **Risk**: Workspace rule forbids DELETE/DROP/TRUNCATE without explicit approval.

   ## Problem

   AuditLog rows persisted **before** Phase 0 Item 4 may contain plaintext
   `value` and `defaultValue` for locked GlobalSetting rows. HIPAA audit
   retention is 6+ years; these rows remain in backups and SIEM mirrors
   even if the live DB is scrubbed.

   ## Scope (read-only probe)

   ```sql
   -- Identify affected rows. SAFE — read-only.
   SELECT
     al.id,
     al."resourceId",
     al."createdAt",
     gs.key
   FROM "core"."AuditLog" al
   LEFT JOIN "core"."GlobalSetting" gs ON gs.id = al."resourceId"
   WHERE al."resourceType" = 'GlobalSetting'
     AND gs."locked" = true
     AND al."createdAt" < '<PHASE_0_DEPLOY_TIMESTAMP>'
   ORDER BY al."createdAt" DESC;
   ```

   ## Proposed mitigation (requires user approval before executing)

   Option A (preferred — surgical UPDATE, no row deletion):

   ```sql
   -- AWAITS USER APPROVAL.
   -- Replaces value/defaultValue inside the JSONB payload with '[REDACTED]'
   -- for rows that match the scope query.
   UPDATE "core"."AuditLog"
   SET "data" = "data"
     || jsonb_build_object(
          'value', '[REDACTED]',
          'defaultValue', '[REDACTED]'
        )
   WHERE id IN (
     SELECT al.id
       FROM "core"."AuditLog" al
       LEFT JOIN "core"."GlobalSetting" gs ON gs.id = al."resourceId"
       WHERE al."resourceType" = 'GlobalSetting'
         AND gs."locked" = true
         AND al."createdAt" < '<PHASE_0_DEPLOY_TIMESTAMP>'
   );
   ```

   Option B (deprecated): DELETE affected rows. **Forbidden by workspace rule.**

   ## Out of scope

   - Backups and SIEM mirrors: out of scope for this plan. The org-wide
     incident response (per the JWT rotation runbook) should treat these
     as separate retention surfaces.
   ```

2. Commit:

   ```bash
   git add docs/implementation/TASK-302-System-Config-Implementation-Roadmap/_section-d-backfill-proposal.md
   git commit -m "$(cat <<'EOF'
   docs(task-302/phase-0): document Section D audit-log backfill proposal

   Phase 0 Item 4 (TASK-302 Stream A): captures the SQL needed to scrub
   pre-deploy AuditLog rows of plaintext secrets. NOT executed — workspace
   rule requires user approval for any UPDATE on audit data. Forwards to
   the user for triage.
   EOF
   )"
   ```

> The user must approve and run the proposed UPDATE in a maintenance window. The plan stops at documentation.

---

### Code Review Gate D

**Agent**: `code-reviewer`

Reviewer checklist for Section D:

- [ ] `@Secret` source lives in `@arcaai/domains` (or, if Task D.2's location was kept, `@arcaai/applications` with NO inbound edge from `@arcaai/domains` — confirm via `rg "from '@arcaai/applications'" packages/domains/src` returns zero hits).
- [ ] `GlobalSettingEntity.value` and `GlobalSettingEntity.defaultValue` are decorated with `@Secret`.
- [ ] The coverage test (Task D.3) enumerates every entity field and fails on unmarked surfaces.
- [ ] `tenant.service.ts` lines 520-523 now call `scrubLockedForAudit` for the `data:` field.
- [ ] The `_section-d-backfill-proposal.md` exists, is marked "PROPOSED — DO NOT EXECUTE", and includes both the read-only probe and the proposed UPDATE.
- [ ] No `DELETE`/`DROP`/`TRUNCATE` SQL appears in any commit.
- [ ] All audit-scrub unit tests pass.

---

# Section E — Item 5: Boot-Time Duplicate-Key Invariant

**Section Goal**: Add a boot-time invariant in `AppSettingsService.cacheAppSettings()` that refuses to start the process if more than one row exists for any **platform key** (i.e., any setting where `tenantId === GLOBAL_TENANT_ID`). Detects, but does not fix, the TASK-301 §P0-1 cross-tenant cache collision. The proper fix (split into `PlatformSettingsService` / `TenantSettingsService`) lives in TASK-302 Phase 1.

**Entry Criteria**: Section A merged.

**Exit Criteria**:
- Unit test "cacheAppSettings throws on duplicate platform key" passes.
- The invariant is bypassable via `APP_SETTINGS_BOOT_INVARIANT=skip` in `NODE_ENV=development` only; never in `staging`/`production`.
- Staging boot smoke proves the process exits non-zero when a duplicate platform-key row is primed.

---

## Task E.1 — Failing test: duplicate platform-key detection

**Agent**: `tester`

**Files**:
- Create: `packages/applications/src/services/baseServices/_meta/appSettings/__tests__/appSettings.service.boot-invariant.test.ts`

**Steps**:

1. Write the failing test:

   ```typescript
   // packages/applications/src/services/baseServices/_meta/appSettings/__tests__/appSettings.service.boot-invariant.test.ts
   import { describe, it, expect, beforeEach, vi } from 'vitest';
   import { AppSettingsService } from '../appSettings.service';
   import { GlobalSettingFactory, ValueType } from '@arcaai/domains';

   const GLOBAL_TENANT_ID = '50000000-0000-0000-0000-000000000000';
   const buildSetting = (key: string, tenantId: string) =>
     GlobalSettingFactory.CreateGlobalSetting({
       tenantId, key, value: 'v', dataType: ValueType.String,
       defaultValue: 'd', name: key, namespace: 'com.flw.test',
       description: '', locked: false,
     });

   const repo = { findAll: vi.fn() };
   const events = { emit: vi.fn() };
   const cls = { get: vi.fn(), set: vi.fn() };
   const scheduler = { addCronJob: vi.fn(), getCronJob: vi.fn(), deleteCronJob: vi.fn() };

   describe('AppSettingsService — Phase 0 Item 5 boot-time invariant', () => {
     beforeEach(() => {
       vi.clearAllMocks();
       delete process.env.APP_SETTINGS_BOOT_INVARIANT;
       process.env.NODE_ENV = 'production';
     });

     it('throws when >1 row exists for the SAME platform key', async () => {
       repo.findAll.mockResolvedValue([
         buildSetting('crypto.saltRounds', GLOBAL_TENANT_ID),
         buildSetting('crypto.saltRounds', GLOBAL_TENANT_ID),
       ]);
       const svc = new AppSettingsService(repo as never, events as never, cls as never, scheduler as never);
       await expect(svc.cacheAppSettings()).rejects.toThrow(/duplicate platform key/i);
     });

     it('does NOT throw when duplicates are tenant-scoped (different tenantIds)', async () => {
       repo.findAll.mockResolvedValue([
         buildSetting('enable-x', 'tenant-a'),
         buildSetting('enable-x', 'tenant-b'),
       ]);
       const svc = new AppSettingsService(repo as never, events as never, cls as never, scheduler as never);
       await expect(svc.cacheAppSettings()).resolves.toBeUndefined();
     });

     it('bypasses invariant in dev with APP_SETTINGS_BOOT_INVARIANT=skip', async () => {
       process.env.NODE_ENV = 'development';
       process.env.APP_SETTINGS_BOOT_INVARIANT = 'skip';
       repo.findAll.mockResolvedValue([
         buildSetting('crypto.saltRounds', GLOBAL_TENANT_ID),
         buildSetting('crypto.saltRounds', GLOBAL_TENANT_ID),
       ]);
       const svc = new AppSettingsService(repo as never, events as never, cls as never, scheduler as never);
       await expect(svc.cacheAppSettings()).resolves.toBeUndefined();
     });

     it('NEVER bypasses invariant in production, even with APP_SETTINGS_BOOT_INVARIANT=skip', async () => {
       process.env.NODE_ENV = 'production';
       process.env.APP_SETTINGS_BOOT_INVARIANT = 'skip';
       repo.findAll.mockResolvedValue([
         buildSetting('crypto.saltRounds', GLOBAL_TENANT_ID),
         buildSetting('crypto.saltRounds', GLOBAL_TENANT_ID),
       ]);
       const svc = new AppSettingsService(repo as never, events as never, cls as never, scheduler as never);
       await expect(svc.cacheAppSettings()).rejects.toThrow(/duplicate platform key/i);
     });
   });
   ```

2. Verify it fails:

   ```bash
   pnpm --filter @arcaai/applications test:unit -- boot-invariant
   # Expected: ✗ — invariant not yet implemented.
   ```

3. Commit:

   ```bash
   git add packages/applications/src/services/baseServices/_meta/appSettings/__tests__/appSettings.service.boot-invariant.test.ts
   git commit -m "$(cat <<'EOF'
   test(applications): document Phase 0 Item 5 boot invariant (failing)

   TASK-302 Stream A Item 5: pins the AppSettingsService.cacheAppSettings
   contract — refuse to start if >1 row exists for any platform key (i.e.,
   tenantId === GLOBAL_TENANT_ID). Dev-only bypass via env. Test fails
   until E.2 lands the invariant.
   EOF
   )"
   ```

---

## Task E.2 — Implement the invariant

**Agent**: `database-admin`

**Files**:
- Modify: `packages/applications/src/services/baseServices/_meta/appSettings/appSettings.service.ts` (lines 185–209)

**Steps**:

1. Add the constant + invariant inside the existing `cacheAppSettings()` body. Insert **between** line 195 (`const globalSettings = …`) and line 197 (`globalSettings.forEach(…)`):

   ```typescript
   const GLOBAL_TENANT_ID = '50000000-0000-0000-0000-000000000000';
   ```

   (or reuse the existing exported constant if one is available in `@arcaai/domains`; verify via grep first.)

   ```typescript
   // Phase 0 Item 5 (TASK-302 Stream A) — boot-time duplicate-key invariant.
   // TASK-301 §P0-1: if >1 row exists for the same platform key
   // (tenantId === GLOBAL_TENANT_ID), the Map<key>-keyed cache silently
   // resolves to a non-deterministic winner. Refuse to start.
   const allowSkip = process.env.NODE_ENV === 'development'
     && process.env.APP_SETTINGS_BOOT_INVARIANT === 'skip';

   if (!allowSkip) {
     const platformOnly = globalSettings.filter((s) => s.tenantId === GLOBAL_TENANT_ID);
     const seen = new Map<string, number>();
     for (const s of platformOnly) {
       seen.set(s.key, (seen.get(s.key) ?? 0) + 1);
     }
     const duplicates = Array.from(seen.entries()).filter(([, n]) => n > 1);
     if (duplicates.length > 0) {
       const list = duplicates.map(([k, n]) => `${k} (${n} rows)`).join(', ');
       throw new Error(
         `Phase 0 Item 5 (TASK-302): duplicate platform key(s) detected — ${list}. ` +
         `Refuse to start. See TASK-301 §P0-1 for context. Set ` +
         `APP_SETTINGS_BOOT_INVARIANT=skip in NODE_ENV=development only.`,
       );
     }
   }
   ```

2. Verify the test passes:

   ```bash
   pnpm --filter @arcaai/applications test:unit -- boot-invariant
   # Expected:
   #   ✓ throws when >1 row exists for the SAME platform key (4ms)
   #   ✓ does NOT throw when duplicates are tenant-scoped (3ms)
   #   ✓ bypasses invariant in dev with APP_SETTINGS_BOOT_INVARIANT=skip (3ms)
   #   ✓ NEVER bypasses invariant in production, even with … (3ms)
   ```

3. Commit:

   ```bash
   git add packages/applications/src/services/baseServices/_meta/appSettings/appSettings.service.ts
   git commit -m "$(cat <<'EOF'
   security(applications): refuse boot on duplicate platform-key rows

   Phase 0 Item 5 (TASK-302 Stream A): AppSettingsService.cacheAppSettings
   now scans globalSettings filtered to tenantId=GLOBAL_TENANT_ID, groups
   by key, and throws if any group has >1 rows. Dev escape hatch
   APP_SETTINGS_BOOT_INVARIANT=skip honoured only in NODE_ENV=development.
   Detects the TASK-301 §P0-1 cross-tenant cache collision before any
   downstream consumer can read the cache.
   EOF
   )"
   ```

---

## Task E.3 — Document the env switch in `apps/api/README.md`

**Agent**: `docs-manager`

**Files**:
- Modify: `apps/api/README.md`

**Steps**:

1. Append a new subsection under the existing "Environment Variables" section (or create one):

   ```markdown
   ### Phase 0 Item 5 — Boot-time duplicate-key invariant

   `AppSettingsService.cacheAppSettings()` refuses to start the process if
   more than one row exists in `GlobalSetting` for the same platform key
   (rows where `tenantId === GLOBAL_TENANT_ID`). The protection closes
   the TASK-301 §P0-1 cross-tenant cache collision.

   | Env var | Default | When honoured |
   |---|---|---|
   | `APP_SETTINGS_BOOT_INVARIANT` | unset | Only when `NODE_ENV=development`. In `staging`/`production` the invariant runs unconditionally. |

   To bypass during a local rebase (dev only):

   ```bash
   APP_SETTINGS_BOOT_INVARIANT=skip pnpm dev:api
   ```
   ```

2. Commit:

   ```bash
   git add apps/api/README.md
   git commit -m "docs(api): document APP_SETTINGS_BOOT_INVARIANT (Phase 0 Item 5)"
   ```

---

## Task E.4 — Staging primer smoke: boot fails on duplicate

**Agent**: `database-admin`

**Files**: None (manual staging smoke).

**Steps**:

1. The staging DB must be primed with a deliberate duplicate. The primer is a `SELECT` + `INSERT` (no `DELETE`/`DROP`/`TRUNCATE`). The DBA writes:

   ```sql
   -- Phase 0 Item 5 staging primer (read-only verification + additive INSERT).
   BEGIN;

   -- 1. Confirm the canonical platform key already exists.
   SELECT id, key, "tenantId"
     FROM "core"."GlobalSetting"
     WHERE key = 'crypto.saltRounds'
       AND "tenantId" = '50000000-0000-0000-0000-000000000000';

   -- 2. Insert a duplicate row. The primer accepts the FK risk per
   --    TASK-301 §P0-8 (FK absent today).
   INSERT INTO "core"."GlobalSetting"
     ("id", "tenantId", "key", "name", "value", "defaultValue", "dataType",
      "namespace", "description", "locked", "version", "resourceStatus",
      "createdAt", "updatedAt", "createdBy", "updatedBy")
   VALUES
     ('11111111-aaaa-bbbb-cccc-dddddddddddd',
      '50000000-0000-0000-0000-000000000000',
      'crypto.saltRounds', 'crypto.saltRounds DUPLICATE',
      '12', '10', 'Integer', 'com.flw.crypto', 'Phase 0 Item 5 smoke',
      false, 1, 'ENABLED', now(), now(), NULL, NULL);

   -- 3. Confirm 2 rows now.
   SELECT count(*)
     FROM "core"."GlobalSetting"
     WHERE key = 'crypto.saltRounds'
       AND "tenantId" = '50000000-0000-0000-0000-000000000000';

   COMMIT;
   ```

2. Restart the API pod in staging and observe:

   ```bash
   # Expected: pod exits with non-zero code; logs include:
   # Error: Phase 0 Item 5 (TASK-302): duplicate platform key(s) detected
   #        — crypto.saltRounds (2 rows). Refuse to start.
   ```

3. Clean up the primer (route as `UPDATE` or as a no-op revert; **DELETE requires user approval per workspace rule**). The simplest harmless cleanup:

   ```sql
   -- Mark the primer row as DELETED (soft-delete, not DELETE) to remove
   -- it from the active set. The Prisma soft-delete extension treats
   -- ResourceStatus=DELETED as logically gone.
   UPDATE "core"."GlobalSetting"
     SET "resourceStatus" = 'DELETED', "updatedAt" = now()
   WHERE id = '11111111-aaaa-bbbb-cccc-dddddddddddd';
   ```

4. Restart the API again and confirm boot succeeds.

5. No commit (operational smoke; outcome recorded in the PR description).

---

### Code Review Gate E

**Agent**: `code-reviewer`

Reviewer checklist for Section E:

- [ ] The invariant lives in `appSettings.service.ts:cacheAppSettings()` between the existing `findAll` and `forEach` lines.
- [ ] The dev-only bypass condition is `NODE_ENV === 'development' && APP_SETTINGS_BOOT_INVARIANT === 'skip'`. Anything looser is rejected.
- [ ] All four boot-invariant unit tests are green.
- [ ] The staging smoke (Task E.4) was executed; the PR description references the staging pod log snippet showing the refusal-to-start.
- [ ] `apps/api/README.md` documents the env var.

---

# Section F — Phase 0 Exit Gate Verification

**Section Goal**: Run the full red-team suite, the gitleaks scan, and the staging boot smoke against a fresh build; produce evidence for each of the six TASK-301 §Phase 0 exit-criteria checkboxes; flip the TASK-301 README §Phase 0 status to "Completed".

**Entry Criteria**: Sections A, B, C, D, E all merged.

**Exit Criteria**:
- Every exit-criteria checkbox is ticked with evidence URLs/output.
- TASK-301 README §Phase 0 status reads "Completed (YYYY-MM-DD)".
- Streams B / C / D are unblocked.

---

## Task F.1 — Run the full Phase 0 red-team CI suite

**Agent**: `tester`

**Files**: None (verification-only).

**Steps**:

1. Run:

   ```bash
   pnpm test:e2e -- phase-0-redteam
   pnpm --filter @arcaai/applications test:unit -- mass-assignment audit-scrub boot-invariant
   pnpm --filter @arcaai/domains test:unit -- immutable-fields secret-coverage
   pnpm --filter @arcaai/api test:unit -- validation-pipe admin-route-permission-audit
   ```

2. Expected: every command exits 0. Capture the trailing summary block for each command and paste into the PR description for Section F.

3. No commit (verification-only).

---

## Task F.2 — Confirm `gitleaks` clean across the repo

**Agent**: `cicd-manager`

**Files**: None (verification-only).

**Steps**:

1. Run locally:

   ```bash
   gitleaks detect --source . --config .gitleaks.toml --no-banner --redact
   # Expected:
   #   leaks found: 0
   #   exit code: 0
   ```

2. Confirm the GitLab pipeline's `scan-gitleaks` job is green on the latest commit. Paste the pipeline URL into the PR.

3. Audit-log SQL probe (TASK-301 §Phase 0 exit criteria bullet 4) — `database-admin` runs the probe documented in §D.5:

   ```sql
   SELECT id, action, "resourceId", data
     FROM "core"."AuditLog"
     WHERE "resourceType" = 'GlobalSetting'
       AND "createdAt" > '<PHASE_0_DEPLOY_TIMESTAMP>'
     ORDER BY "createdAt" DESC
     LIMIT 50;
   ```

   Expected: every `data` JSON for a row whose `resourceId` resolves to `locked = true` contains `"value": "[REDACTED]"` and `"defaultValue": "[REDACTED]"`. Paste a sanitised excerpt (no secrets, fingerprints only) into the PR.

4. No commit (verification-only).

---

## Task F.3 — Production deploy verification checklist

**Agent**: `git-manager`

**Files**:
- Modify: `docs/implementation/TASK-302-System-Config-Implementation-Roadmap/_section-a-rotation-log.md` (final updates — set the JWT_SECRET_KEY production rotation row to filled-in fingerprints).

**Steps**:

1. Pre-deploy:
   - [ ] All Section A/B/C/D/E PRs merged into `dev`.
   - [ ] CI green on `dev` for the merge commit.
   - [ ] Slack #engineering notified of the production deploy window.

2. Deploy:
   - [ ] Deploy to staging; run `pnpm test:e2e -- phase-0-redteam` against the staging URL. All green.
   - [ ] Deploy to production.
   - [ ] Within 5 minutes of deploy, rotate `JWT_SECRET_KEY` in the production env-store and roll the pods. Record the new fingerprint in the rotation log.
   - [ ] Verify all previously-issued long-lived sessions no longer validate (sample 3 user sessions; their refresh tokens should be rejected within `JWT_REFRESH_EXPIRES_IN`).

3. Post-deploy:
   - [ ] `gitleaks detect` on the deployed branch — green.
   - [ ] AuditLog SQL probe — no plaintext `value` in any row created after the deploy timestamp.
   - [ ] Boot logs in production confirm `Phase 0 Item 3 admin route audit passed (N routes checked)` and **no** Phase 0 Item 5 duplicate-key error.

4. Commit the final rotation log update:

   ```bash
   git add docs/implementation/TASK-302-System-Config-Implementation-Roadmap/_section-a-rotation-log.md
   git commit -m "docs(task-302/phase-0): record production JWT rotation fingerprints"
   ```

---

## Task F.4 — Update TASK-301 README to "Completed"

**Agent**: `docs-manager`

**Files**:
- Modify: `docs/implementation/TASK-301-System-Config-Multi-Tenancy-Assessment/README.md`

**Steps**:

1. Edit the header block — change `Status: Review` → `Status: Phase 0 Completed (YYYY-MM-DD)` (use the production-deploy date).

2. Edit the **Phase 0 verification gate** in §Recommended Implementation Roadmap — tick every checkbox and append evidence URLs:

   ```markdown
   **Phase 0 verification gate (exit criteria)** — all must be true before Phase 1:

   - [x] CI red-team test: a `DOCTOR` user `PATCH`ing `JWT_SECRET_KEY` returns 403/400, not 200
     — Evidence: `apps/api/tests/e2e/phase-0-redteam.spec.ts` (Section B suite), pipeline #<pid>.
   - [x] CI red-team test: `POST /admin/users/:id/roles` from a DOCTOR returns 403
     — Evidence: `phase-0-redteam.spec.ts` (Section C suite), pipeline #<pid>.
   - [x] Boot-time invariant fails fast in a staging env primed with a duplicate platform key
     — Evidence: `_section-a-rotation-log.md` step "staging duplicate-key smoke".
   - [x] Audit-log SQL query confirms no new entries contain decrypted secret values for rows where `locked: true`
     — Evidence: SQL probe in PR #<id> description.
   - [x] `apps/api/.env.dev` and `apps/api/.env.example` carry no values matching `gitleaks` known-secret patterns
     — Evidence: `scan-gitleaks` job #<job-id>, exit 0.
   - [x] Re-deployed JWT_SECRET_KEY rotation has occurred and old tokens have expired
     — Evidence: `_section-a-rotation-log.md` production row + post-rotation session sample.
   ```

3. Append to the **Change History** at the bottom:

   ```markdown
   - **YYYY-MM-DD** — Phase 0 emergency hotfix completed end-to-end via TASK-302 Stream A. All six items shipped and verified in production: ValidationPipe whitelist, service-layer allowlist, GlobalSettingEntity immutability, AuthorizationGuard admin/* deny default, admin controller sweep, boot-time route-introspection audit, @Secret decorator + audit-log scrubber, boot-time duplicate-key invariant, credential rotation (Azure OpenAI x2 + JWT_SECRET_KEY x2 envs), gitleaks rule pack + pre-commit hook + CI gate. Streams B (Vault), C (PgBouncer), and D (Optimistic Locking) are unblocked.
   ```

4. Commit:

   ```bash
   git add docs/implementation/TASK-301-System-Config-Multi-Tenancy-Assessment/README.md
   git commit -m "$(cat <<'EOF'
   docs(task-301): flip Phase 0 status to Completed

   TASK-302 Stream A landed end-to-end (six items + verification gate).
   Streams B/C/D unblocked.
   EOF
   )"
   ```

---

### Final Code Review Gate F (sign-off)

**Agents**: `security-auditor` **AND** `code-reviewer`

Joint checklist:

- [ ] Every exit-criteria bullet in TASK-301 §Phase 0 carries an evidence URL or output excerpt.
- [ ] `pnpm test:e2e -- phase-0-redteam` was run against the production URL (or a staging mirror) **after** the deploy and is green.
- [ ] `gitleaks detect` on production HEAD returns 0 findings.
- [ ] The rotation log has all four fingerprints filled.
- [ ] TASK-301 README status reads `Phase 0 Completed (YYYY-MM-DD)`.
- [ ] Streams B / C / D's plan front-matter (`Status: Pending (awaits Phase 0 sign-off)`) can be flipped to `Status: Ready to start` — this is **the** sign-off boundary.

On joint approval, post in #engineering:

> "TASK-302 Phase 0 sign-off complete. Streams B (Vault), C (PgBouncer), and D (Optimistic Locking) are unblocked."

---

# Appendix A — Backout / Rollback Procedures per Item

For each Phase 0 item, the minimum revert path. All assume the PR-per-section convention from D10.

| Item | Quick revert | Side effects | Re-deploy time |
|---|---|---|---|
| 1 — Strict `ValidationPipe` | `git revert <main.ts:221 commit>` | Existing endpoints that silently relied on extra DTO keys may regress to "fields silently accepted". Acceptable because R2 already proved the soak. | ~5 min |
| 2 — Allowlist in `updateTenantConfigs` + immutable entity fields | `git revert <tenant.service.ts commit>` and `git revert <GlobalSettingEntity.ts commit>` | Mass-assignment surface re-opens. Use only if Item 2 introduces a regression that cannot be triaged within the SLA. | ~10 min |
| 3 — AuthorizationGuard inversion + admin sweep + boot audit | `git revert <authorization.guard.ts commit>` (the inversion). Do **NOT** revert the controller sweep — those are independent improvements. The boot audit can be turned off via a feature flag if needed (add `PHASE_0_AUDIT_ADMIN_ROUTES=off` env). | Admin routes regain the "empty list allows" bypass. Treat as P0 incident. | ~5 min for guard revert; controller sweep stays. |
| 4 — `@Secret` decorator + audit-log scrubber | `git revert <scrubbing.ts commit>` only. Do not revert the decorator — it carries no behaviour without the scrubber consumer. | Audit log resumes carrying plaintext for locked rows. Treat as P0 incident. | ~5 min |
| 5 — Boot-time invariant | Set `APP_SETTINGS_BOOT_INVARIANT=skip` (dev) or extend the bypass condition. Do not revert the code. | Process boots even with duplicate platform keys. TASK-301 §P0-1 active again. | Env change only, ~1 min |
| 6 — Credential rotation + gitleaks | Cannot meaningfully revert rotation (the old keys are revoked in Azure portal). Pre-commit hook can be disabled via `SIMPLE_GIT_HOOKS_SKIP=1` env per-developer. The CI gate cannot be opted out (D5). | If gitleaks gates a PR that contains an emergency fix, the gate must be amended via PR-to-amend; do not bypass. | n/a |

---

# Appendix B — Red-Team Test Catalog

Full file inventory delivered by this plan. Each test lives in CI permanently (D8).

| Path | Created in | Description |
|---|---|---|
| `apps/api/tests/e2e/phase-0-redteam.spec.ts` | B.1 + C.1 | Playwright end-to-end suite. Two `describe` blocks: Item 1+2 mass-assignment + Item 3 privilege escalation. |
| `apps/api/src/__tests__/validation-pipe.test.ts` | B.2 | Unit pin for the strict `ValidationPipe` configuration. |
| `packages/applications/src/services/tenant/__tests__/tenant.service.mass-assignment.test.ts` | B.4 | Service-level pin: smuggled fields are ignored regardless of HTTP-pipe state. |
| `packages/domains/src/entities/__tests__/GlobalSettingEntity.immutable-fields.test.ts` | B.6 | Entity-level pin: `key`/`tenantId`/`locked`/`defaultValue` setters throw. |
| `packages/applications/src/authorization/__tests__/authorization.guard.admin-deny.test.ts` | C.2 | Guard-level pin: empty list → deny on `admin/*`. |
| `apps/api/src/bootstrap/__tests__/admin-route-permission-audit.test.ts` | C.4 | Boot-audit pin: refuses startup on undecorated admin routes. |
| `packages/applications/src/services/tenant/__tests__/tenant.service.audit-scrub.test.ts` | D.1 | Service-level pin: locked-row SysEvent payloads carry `[REDACTED]`. |
| `packages/applications/src/common/decorators/__tests__/secret.decorator.test.ts` | D.2 | Decorator pin: `@Secret` registers and `getSecretFields` returns. |
| `packages/domains/src/entities/__tests__/GlobalSettingEntity.secret-coverage.test.ts` | D.3 | Coverage pin: every entity field is either `@Secret` or in the allowlist. |
| `packages/applications/src/services/baseServices/_meta/appSettings/__tests__/appSettings.service.boot-invariant.test.ts` | E.1 | Boot-invariant pin: 4 cases (dup-platform, tenant-dup OK, dev bypass, prod no-bypass). |

Recommended Vitest aliases (root `package.json`) for routine Phase 0 regression sweeps:

```json
"scripts": {
  "test:phase-0:unit": "dotenv -e .env.test -- vitest run mass-assignment audit-scrub boot-invariant immutable-fields secret-coverage admin-deny admin-route-permission-audit secret.decorator validation-pipe",
  "test:phase-0:e2e": "dotenv -e .env.test -- playwright test phase-0-redteam"
}
```

---

# Appendix C — gitleaks Rule Pack for HOPE

Full content of `.gitleaks.toml` (Task A.3) — duplicated here as the canonical Phase 0 baseline so future Stream B (Vault) PRs that extend the rule pack diff against a known shape.

```toml
title = "HOPE gitleaks rule pack (Phase 0)"

[extend]
useDefault = true

[[rules]]
id = "hope-azure-openai-api-key"
description = "Azure OpenAI API key committed to a .env or source file"
regex = '''(?i)(AZURE_OPENAI_API_KEY|SMR_V2_AZURE_API_KEY)\s*[:=]\s*["']?[A-Za-z0-9]{80,}["']?'''
tags = ["azure", "openai", "key"]

[[rules]]
id = "hope-jwt-secret"
description = "JWT secret committed (non-empty value)"
regex = '''(?i)(JWT_SECRET_KEY|JWT_REFRESH_SECRET|SESSION_SECRET_KEY)\s*[:=]\s*["']?[A-Za-z0-9+/=_-]{32,}["']?'''
tags = ["jwt", "session", "secret"]

[[rules]]
id = "hope-s3-credentials"
description = "S3 access/secret committed (non-placeholder)"
regex = '''(?i)(S3_ACCESS_KEY|S3_SECRET_KEY|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|MINIO_ROOT_PASSWORD)\s*[:=]\s*["']?[A-Za-z0-9+/=]{16,}["']?'''
tags = ["s3", "aws", "minio"]

[[rules]]
id = "hope-db-url-password"
description = "DATABASE_URL with embedded password (postgresql://user:pw@…)"
regex = '''(?i)(DATABASE_URL|DB_CONNECTION_STRING)\s*[:=]\s*["']?postgresql://[^:]+:[^@\s"']{8,}@'''
tags = ["postgres", "url"]

[[rules]]
id = "hope-pgbouncer-userlist"
description = "PgBouncer userlist.txt format (Stream C interlock)"
regex = '''(?i)^[a-z0-9_]+\s+"[a-z0-9+/=]{20,}"$'''
tags = ["pgbouncer"]

[[rules]]
id = "hope-redis-password"
description = "REDIS_PASS / REDIS_URL with embedded password"
regex = '''(?i)(REDIS_PASS|REDIS_URL)\s*[:=]\s*["']?[^"'\s]{12,}["']?'''
tags = ["redis"]

[[rules]]
id = "hope-mqtt-password"
description = "MQTT_PASS with embedded password"
regex = '''(?i)MQTT_PASS\s*[:=]\s*["']?[^"'\s]{8,}["']?'''
tags = ["mqtt"]

[[rules]]
id = "hope-api-key-pepper"
description = "API_KEY_PEPPER committed"
regex = '''(?i)API_KEY_PEPPER\s*[:=]\s*["']?[A-Za-z0-9+/=_-]{16,}["']?'''
tags = ["api-key"]

[[rules]]
id = "hope-langfuse-key"
description = "Langfuse public/secret key"
regex = '''(?i)LANGFUSE_(PUBLIC|SECRET)_KEY\s*[:=]\s*["']?[a-z]{2}-[a-z]+-[a-z0-9-]{30,}["']?'''
tags = ["langfuse", "observability"]

[[rules]]
id = "hope-huggingface-token"
description = "HuggingFace token"
regex = '''(?i)(HF_TOKEN|HUGGINGFACE_TOKEN)\s*[:=]\s*["']?hf_[A-Za-z0-9]{20,}["']?'''
tags = ["huggingface"]

[allowlist]
description = "Allowlisted paths (fixtures, dependency lockfiles, generated reports, this very rotation log)"
paths = [
  '''(.*?)(jpg|gif|doc|pdf|bin|svg|ico|png|jpeg|wav|mp3|woff2)$''',
  '''pnpm-lock\.yaml$''',
  '''node_modules/''',
  '''dist/''',
  '''\.turbo/''',
  '''docs/implementation/TASK-302-System-Config-Implementation-Roadmap/_section-a-rotation-log\.md$''',
]
```

> **Stream B extension point**: Stream B Phase 1A adds an additional rule for `VAULT_TOKEN=hvs\.[A-Za-z0-9]+`. The rule is appended below the `hope-huggingface-token` block, not interleaved, so the diff is human-readable. See [`02-vault-migration.md`](./02-vault-migration.md) §R11.

---

## Change History

- **2026-05-24** — Plan v1 authored by the planner subagent against TASK-301 §Phase 0 (six items), TASK-301 §Phase 0 exit criteria (six bullets), and the user brief covering credential-rotation timing, `@Secret` decorator scope, and cross-stream interlocks with `02-vault-migration.md`, `03-pgbouncer-rollout.md`, and `04-optimistic-locking.md`. No source code modified.
