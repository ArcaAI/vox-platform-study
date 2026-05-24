# TASK-302 — System Configuration Implementation Roadmap

| Field | Value |
|---|---|
| **Ticket Number** | TASK-302 |
| **Ticket Name** | System Configuration & Multi-Tenancy Implementation Roadmap |
| **Type** | `feature` (architecture) + `bugfix` (P0 security) + `refactor` (config plane) |
| **Created** | 2026-05-24 |
| **Last Updated** | 2026-05-24 |
| **Status** | **Pending** — awaiting team kickoff and Stream A start |
| **Parent Assessment** | [TASK-301 — System Configuration & Multi-Tenancy Deep Assessment](../TASK-301-System-Config-Multi-Tenancy-Assessment/README.md) |
| **Source Research** | [`research/architecture/system-config-multi-tenancy/`](../../../research/architecture/system-config-multi-tenancy/) |
| **Required Skill** | [`executing-plans`](file:///Users/taphuynh/.cursor/skills/methodology/executing-plans/SKILL.md) — fresh subagent per task, mandatory `code-reviewer` gate between sections |
| **Total Effort** | ~61–66 engineer-days (raw) → **~5–6 calendar weeks** with 4 engineers in parallel |
| **Total Tasks** | **~157 bite-sized tasks** + **~30 code-review gates** across 4 streams |

---

## TL;DR — what this roadmap is

This umbrella ticket coordinates the execution of **four implementation streams** that together close the critical findings of TASK-301 (System Configuration & Multi-Tenancy Assessment). Each stream is a self-contained, TDD-driven, subagent-executable plan written in the `methodology/writing-plans` format and ready to be picked up by the `methodology/executing-plans` skill (fresh subagent per task, mandatory `code-reviewer` between sections).

| # | Stream | Plan | Source Research | Eng-Days | Tasks |
|---|---|---|---|---|---|
| A | **Phase 0 Emergency Hotfix** (HARD GATE — must complete first) | [`01-phase-0-hotfix.md`](./01-phase-0-hotfix.md) | TASK-301 §Phase 0 (six items) | ~3 | 31 |
| B | **HashiCorp Vault Secrets Migration** (Vault primary; AWS/Azure as stub) | [`02-vault-migration.md`](./02-vault-migration.md) | [`02-secrets-cloud-kms-migration.md`](../../../research/architecture/system-config-multi-tenancy/02-secrets-cloud-kms-migration.md) | ~27–34.5 | 80 |
| C | **PgBouncer Validation & Rollout** (transaction mode if Prisma validation passes) | [`03-pgbouncer-rollout.md`](./03-pgbouncer-rollout.md) | [`03-pgbouncer-prisma.md`](../../../research/architecture/system-config-multi-tenancy/03-pgbouncer-prisma.md) | ~10–15 | ~30 |
| D | **Optimistic Locking on Config Writes** (existing `_version` column → CAS + ETag) | [`04-optimistic-locking.md`](./04-optimistic-locking.md) | [`04-optimistic-locking.md`](../../../research/architecture/system-config-multi-tenancy/04-optimistic-locking.md) | ~13.5 | ~40 |

**Explicitly out of scope** (per user decision 2026-05-24): `research/architecture/system-config-multi-tenancy/01-layered-resolution-migration.md` — the layered read-time resolution migration is **archived as reference only**. `__GLOBAL__` clone-on-create stays as the current model.

---

## 1. Requirement Analysis

### 1.1 Description

TASK-301 delivered a multi-stack assessment of HOPE's configuration plane and surfaced six P0 issues plus a long tail of P1/P2 architectural debt. The user locked in eight decisions on 2026-05-24 (see TASK-301 §Decisions) and then commissioned four research deep-dives at `research/architecture/system-config-multi-tenancy/`. The user has now selected the work to ship:

- **Implement completely**: secrets migration (Vault primary), optimistic locking
- **Review and roll out**: PgBouncer (with the user's locked-in answers)
- **Implement first as hard gate**: TASK-301 Phase 0 emergency hotfix
- **Skip**: layered read-time resolution (`__GLOBAL__` semantics stay as clone-on-create)

This roadmap is the executable plan for that work, broken into four streams sized for parallel execution by a multi-engineer team using subagent-driven implementation.

### 1.2 Business Context

| Concern | Why it matters |
|---|---|
| **Live credential exposure** (real Azure OpenAI keys in `.env.dev`) | Immediate incident — production credentials in source-controlled files. Stream A Item 6 closes this on day one. |
| **Mass-assignment → JWT secret hijack** (P0-2) | A `DOCTOR` user can rotate the platform-wide JWT signing key via `PATCH /tenants/me/config` today. Stream A Items 1+2 close this. |
| **Privilege escalation chain** (P0-3, P0-4) | `AuthorizationGuard` defaults to allow on empty permission lists; a `DOCTOR` can promote themselves to `SUPER_ADMIN`. Stream A Item 3 closes this. |
| **Audit-log secret leak** (P0-6) | Decrypted secret values are flowing into `SysEvent.ResourceUpdated` payloads for `locked` rows, defeating HIPAA §164.312(b) audit requirements. Stream A Item 4 closes this. |
| **Cache poisoning** (P0-1) | Cross-tenant cache collision in `AppSettingsService` allows a tenant to read/write platform-wide config keys. Stream A Item 5 adds detection; Stream B Phase 2 completes the structural fix. |
| **Secrets stored as plaintext `GlobalSetting` rows** | S3 keys, JWT secret, OIDC secret are all stored unencrypted in the DB. Stream B Phase 4 migrates to Vault envelope encryption. |
| **No optimistic locking on config writes** | Two SUPER_ADMINs editing `smr-provider-models` silently lose-write each other; investigators cannot reconcile audit logs. Stream D wires the existing `_version` column to a CAS write path with HTTP `ETag`/`If-Match`. |
| **PgBouncer drift** (HA blueprint says transaction mode; research recommends session mode for RLS) | Existing HA blueprint at `research/deployments/deploy-vm500-502-postgres-ha.md` ships PgBouncer pre-configured for transaction mode — incompatible with Prisma 7 unless `max_prepared_statements ≥ 200` is set. Stream C validates and reconciles. |
| **No fail-closed boot** when secrets backend is unreachable | Pods would start with empty secret defaults, silently degrading to insecure mode. Stream B Phase 2 adds fail-closed boot + stale-while-revalidate steady state. |

### 1.3 Acceptance Criteria (whole roadmap)

This roadmap is **Completed** when ALL of the following are true. Each stream's plan has finer-grained verification gates; these are the cross-stream gates that prove the umbrella ticket has landed.

- [ ] **Stream A — Phase 0 exit criteria all green** (TASK-301 §Phase 0 exit criteria, verbatim):
    - [ ] CI red-team test: a `DOCTOR` user `PATCH`ing `JWT_SECRET_KEY` returns 403/400, not 200
    - [ ] CI red-team test: `POST /admin/users/:id/roles` from a DOCTOR returns 403
    - [ ] Boot-time invariant fails fast in a staging env primed with a duplicate platform key
    - [ ] Audit-log SQL query confirms no new entries contain decrypted secret values for rows where `locked: true`
    - [ ] `apps/api/.env.dev` and `apps/api/.env.example` carry no values matching `gitleaks` known-secret patterns
    - [ ] Re-deployed JWT_SECRET_KEY rotation has occurred and old tokens have expired
- [ ] **Stream B — Vault**:
    - [ ] Every secret read in the inventory (12 sites, see Phase 3) routes through `SecretsService`; static grep `process.env.*SECRET|process.env.*KEY|process.env.*PASS` against the source tree returns zero hits in the application layer (excluding test files and the `EnvSecretsProvider` itself)
    - [ ] Local-dev `pnpm dev` still works without any Vault credentials (env-provider default for `NODE_ENV=development`)
    - [ ] Staging deploys with `SECRETS_PROVIDER=vault` pass the readiness probe
    - [ ] Vault Transit-encrypted `GlobalSetting.encryptedValue` rows round-trip successfully under load (Phase 4C smoke)
    - [ ] Vault Database secrets engine issues short-lived PostgreSQL credentials per pod (Phase 5)
    - [ ] HA Vault cluster (3-node Raft) deployed on Proxmox per SRE blueprint
- [ ] **Stream C — PgBouncer**:
    - [ ] `PrismaPg` adapter tuning shipped (Phase 0 of stream C)
    - [ ] Phase 1 validation rig run and **PASS/FAIL decision documented** (Task 1.19)
    - [ ] Either Phase 2A (transaction mode) or Phase 2B (session mode) deployed to staging, soaked ≥ 1 week
    - [ ] `pgbouncer_exporter` + Grafana dashboard live
    - [ ] HA blueprint drift resolved (config matches deployed reality)
    - [ ] Rollback rehearsal passed in staging
- [ ] **Stream D — Optimistic Locking**:
    - [ ] `Repository<T>.updateWithVersion()` shipped with permanent Postgres-only regression test (Phase B)
    - [ ] `TenantService.updateTenantConfigs` and `GlobalSettingService.update` use CAS inside a `$transaction` (Phase C)
    - [ ] Playwright e2e test proves "two concurrent PATCHes — one wins, one 412s" (Phase C)
    - [ ] `ETagInterceptor` + `@RequiresIfMatch()` + `@ExpectedVersion()` decorators shipped on `PATCH /tenants/me/config` and `PATCH /global-settings/:id` (Phase D)
    - [ ] SDK (`@arcaai/vox`) captures `ETag` and replays as `If-Match` (Phase D)
    - [ ] Roll out to Tenant, Department, PromptTemplate, AsrPipeline, Webhook (Phase E)
    - [ ] `optimistic_lock_conflict_total{model, route}` Prometheus metric live with Grafana panel
- [ ] **Documentation**:
    - [ ] TASK-301 README §Phase 0 flipped to "Completed"
    - [ ] Each stream's README updated with `Implementation Summary` per HOPE workflow rules
    - [ ] Per-service "Concurrency Model" README sections added (Stream D Phase E.7)
    - [ ] Runbooks for Vault disaster recovery (Stream B Appendix B) and PgBouncer rollback (Stream C Phase 3)

---

## 2. Current State Evaluation

See TASK-301 README §Current State Evaluation for the full audit. Highlights anchored to specific files:

| Issue | Anchor | Stream that closes it |
|---|---|---|
| Strict ValidationPipe missing | `apps/api/src/main.ts:221` | A (Item 1) |
| `updateTenantConfigs` spreads body verbatim | `packages/applications/src/services/tenant/tenant.service.ts:503` | A (Item 2) |
| AuthorizationGuard default allows on empty list | `packages/applications/src/authorization/authorization.guard.ts:96–100` | A (Item 3) |
| Audit log emits decrypted secret payloads | `tenant.service.ts:520-523`, `audit-log.service.ts` | A (Item 4) + B (Phase 4) |
| Cache key collision in `cacheAppSettings()` | `packages/applications/src/services/baseServices/_meta/appSettings/appSettings.service.ts:185–209` | A (Item 5 detection) + B (Phase 2 structural fix) |
| Live credentials in `.env.dev` | `apps/api/.env.dev`, repo root `.env.dev` | A (Item 6) |
| Direct `process.env.*` secret reads | 12 sites (see Stream B Phase 3) | B (Phase 3) |
| Plaintext `GlobalSetting` rows for S3/JWT/OIDC | `seed/06-stt.ts:1690-1712`, et al. | B (Phase 4) |
| Static `DATABASE_URL` password | `packages/database/src/client.ts` | B (Phase 5) |
| `_version` column never read or incremented | `packages/domains/src/common/baseEntity/base.entity.ts`, `Repository<T>.update` | D (Phase B) |
| HA blueprint `POOL_MODE: transaction` vs research doc session-mode recommendation | `research/configs/postgres-ha/docker-compose.yml:116-125` | C (Phase 1 validation → Phase 2A or 2B) |
| `PrismaPg` adapter using v7 defaults (max=10, idleTimeout=10s — aggressive) | `packages/database/src/client.ts` | C (Phase 0) |

---

## 3. Implementation Plan

### 3.1 Dependency graph

```
                    ┌──────────────────────────────┐
                    │  Stream A — Phase 0 Hotfix   │
                    │  (HARD GATE: must finish 1st)│
                    │  ~3 eng-days, 31 tasks       │
                    └──────────┬───────────────────┘
                               │
            ┌──────────────────┼──────────────────────┐
            │                  │                      │
            ▼                  ▼                      ▼
  ┌─────────────────┐  ┌──────────────────┐  ┌──────────────────┐
  │  Stream B       │  │   Stream C       │  │   Stream D       │
  │  Vault          │  │   PgBouncer      │  │   Opt-Locking    │
  │  ~27-34 days    │  │   ~10-15 days    │  │   ~13.5 days     │
  │  80 tasks       │  │   ~30 tasks      │  │   ~40 tasks      │
  └────────┬────────┘  └────────┬─────────┘  └────────┬─────────┘
           │                    │                     │
           │ Phase 4 (additive  │                     │ Phase B
           │ GlobalSetting cols)│                     │ (mapper, repo)
           │                    │                     │
           ├────────────────────┼─────────────────────┤
           │                    │                     │
           │       coordinate schema migration window │
           │                    │                     │
           ▼                    ▼                     ▼
  ┌────────────────────────────────────────────────────────────┐
  │   Phase 5 (Vault DB engine) sequenced AFTER Stream C       │
  │   reaches steady state (session/txn mode validated)        │
  └────────────────────────────────────────────────────────────┘
```

### 3.2 Cross-stream coordination rules

| Rule | Streams | Description |
|---|---|---|
| **R1 — Stream A is the hard gate** | A → B, C, D | No other stream may start tasks until Stream A's Final Code Review Gate has signed off AND prod deployment is verified. |
| **R2 — Schema migration window** | B Phase 4 / D Phase B | Both touch `GlobalSetting`. Stream B Phase 4 ships its additive columns (`encryptedValue Bytes?`, `keyVersion Int?`) FIRST; Stream D Phase B then references the new shape in its mapper. Coordinate via `git-manager` (one PR per migration; rebase, don't merge concurrent schema PRs). |
| **R3 — Vault DB engine sequenced after PgBouncer** | C → B Phase 5 | Vault's PostgreSQL Database secrets engine integrates via `@prisma/adapter-pg` password callback. PgBouncer transaction-mode + Vault dynamic credentials require validation. Either (a) Stream C finishes first OR (b) Stream B Phase 5 stages against direct PG until C lands. |
| **R4 — API → SDK → UI release ordering** | D Phase D + Vox SDK + UI | The new `ETag`/`If-Match`/412/428 wire contract MUST roll out in this order. If UI ships first, every PATCH becomes a 428. Release notes for every Stream D Phase D PR must call this out. |
| **R5 — `@Secret` decorator extension point** | A Item 4 → B Phase 4 | Stream A introduces the `@Secret` field decorator + audit scrubber as a metadata-only system. Stream B Phase 4 extends it with envelope-encryption hooks. The decorator location and signature are stabilized in Stream A; Stream B may only add metadata, not break the signature. |
| **R6 — Gitleaks rule pack** | A Item 6 → B Phase 1 → C Phase 2 | Stream A ships the baseline `.gitleaks.toml`. Stream B adds `VAULT_TOKEN=hvs\.…` rule. Stream C adds `hope-pgbouncer-userlist` rule. Each PR appends; nobody rewrites. |
| **R7 — No `DELETE`/`DROP`/`TRUNCATE` without user approval** | All | Workspace rule. Three plans have data-cleanup tasks (Stream A §D.6 audit-log backfill, Stream B Phase 4D plaintext seed removal). All three are **proposal docs**, NOT executable scripts; require user sign-off. |
| **R8 — One branch per section** | All | Branch naming convention: `feat/task-302-stream-<a\|b\|c\|d>/<section>-<short-name>`. One PR per section. Code-review gates correspond to PR boundaries. |

### 3.3 Team allocation

Mapped to the `executing-plans` subagent pool. A team of 4 engineers + 1 SRE can deliver the full roadmap in ~5–6 calendar weeks; smaller teams scale linearly with the parallelism noted below.

| Engineer / Subagent type | Primary stream ownership | Cross-cutting |
|---|---|---|
| **Eng 1 — Security & Backend Senior** (drives `security-auditor`, `code-reviewer`) | Stream A lead; Stream B `security-auditor` reviews | Code-review gates for all streams |
| **Eng 2 — Backend & DB Senior** (drives `database-admin`, `code-reviewer`) | Stream B lead; Stream D `database-admin` for `Repository.updateWithVersion` | Schema migration coordinator (R2) |
| **Eng 3 — Backend & API** (drives `api-designer`, `tester`, `code-reviewer`) | Stream D lead; Stream B Phase 3 secret-read migration | SDK + UI release sequencing (R4) |
| **Eng 4 — SRE / Platform** (drives `pipeline-architect`, `cicd-manager`, `database-admin`) | Stream C lead; Stream B Phase 1B HA Vault cluster | CI gates (gitleaks, vault-policy-lint) (R6) |
| **Subagent: `tester`** | Used by every stream | Vitest unit/integration, Playwright e2e, concurrency tests |
| **Subagent: `code-reviewer`** | Every code-review gate | ~30 gates across the roadmap; non-bypassable |
| **Subagent: `debugger`** | On-call across streams | Triage Vault auth failures, Prisma #10207-style regressions, prepared-statement errors |
| **Subagent: `docs-manager`** | Every stream | TASK-301 README update (status), per-service "Concurrency Model" sections, runbook updates |
| **Subagent: `git-manager`** | All streams | Branch naming, PR scoping, schema migration sequencing (R2), credential rotation timing (R1) |

### 3.4 Timeline (5-engineer team, paired/parallel)

Calendar weeks are wall-clock with parallel execution; engineer-day numbers are the sum of focused work.

| Week | Streams in flight | Milestones |
|---|---|---|
| **W1** | A only (entire team converges) | Day 1: Section A (credential rotation, serial); Day 2: Sections B/C/D/E in parallel; Day 3: Section F verification + Phase 0 production deploy |
| **W2** | B (1A, 2A), C (Phase 0+1), D (A+B) | Vault dev container live; Prisma adapter tuning shipped; PgBouncer validation rig boots; Opt-lock evidence test + `OptimisticConcurrencyException` |
| **W3** | B (2B, 2C, 3 start), C (Phase 1 decision gate), D (C start) | `VaultSecretsProvider` complete; PgBouncer Phase 1 go/no-go decision recorded; first opt-lock service migration |
| **W4** | B (3 finish, 4A, 4B), C (Phase 2A/B), D (C finish, D start) | All `process.env.*` secret reads migrated; PgBouncer transaction-mode (or session-mode fallback) staged; Opt-lock e2e test green; `ETagInterceptor` shipped |
| **W5** | B (4C, 5 start), C (Phase 3), D (D finish, E start) | Envelope encryption live; PgBouncer production cutover; SDK release with ETag capture; first 3 Stream-D rollouts (Tenant, Department, PromptTemplate) |
| **W6** | B (5 finish, 6, 7), D (E finish) | Vault DB engine live in prod; rotation automation; final 2 Stream-D rollouts (AsrPipeline, Webhook) + observability metric live |
| **W7 (buffer)** | Final hardening | Per-stream Implementation Summary update; TASK-302 sign-off; backout-rehearsal review |

If only 2 engineers are available, multiply by ~2.5×: ~12–14 calendar weeks elapsed. Single-engineer execution is ~16–18 calendar weeks (sequential).

### 3.5 Testing strategy (cross-stream)

Every task in every stream follows the HOPE workflow TDD requirement (read `.cursor/rules/01-development-workflow.mdc`):

1. **Red** — write a failing test, watch it fail
2. **Green** — minimal implementation
3. **Refactor** — clean up, all tests still green

Layer-wise test placement (per workflow rule):

| Layer | Location | Framework |
|---|---|---|
| Domain (`@arcaai/domains`) | `packages/domains/src/**/__tests__/` | Vitest |
| Services (`@arcaai/applications`) | `packages/applications/src/**/__tests__/` | Vitest |
| API controllers | `apps/api/src/**/__tests__/` | Vitest |
| API E2E (incl. concurrency, red-team) | `apps/api/tests/e2e/` | Playwright |
| Database integration (Prisma, PgBouncer) | `packages/database/tests/integration/` | Vitest + testcontainers |
| SDK | `packages/agentic-sdk-v2/src/**/__tests__/` | Vitest |

**Permanent regression tests** (these stay in CI forever):

- `apps/api/tests/e2e/phase-0-redteam.spec.ts` (Stream A) — DOCTOR mass-assign JWT_SECRET_KEY, DOCTOR self-promotion, audit-log scrubbing
- `packages/applications/src/services/tenant/__tests__/optimistic-locking-cas.test.ts` (Stream D) — Postgres CAS regression guard for Prisma #10207
- `packages/database/tests/integration/pgbouncer-compat.test.ts` (Stream C) — Prisma 7 ↔ PgBouncer transaction-mode compatibility (boots a fresh PgBouncer per run)
- `packages/applications/src/services/baseServices/_meta/secrets/__tests__/secrets.contract.test.ts` (Stream B) — `ISecretsProvider` contract that every provider must pass

### 3.6 Rollback strategy

Each stream's plan documents per-section rollback. The roadmap-level rollback principles:

- **Stream A is irreversible by design** — credential rotation can't be un-rotated. Per-item rollback documented in `01-phase-0-hotfix.md` Appendix A for the OTHER items (ValidationPipe, AuthGuard, @Secret decorator, boot invariant).
- **Stream B is reversible up to Phase 4A** (schema additive) — set `SECRETS_PROVIDER=env` to revert to env-only secret resolution. Phase 4D (plaintext seed removal) is the point of no return for some keys; gated by user approval.
- **Stream C is fully reversible** — flip `DATABASE_URL` back to direct HAProxy R/W, rolling restart of API pods, no schema change.
- **Stream D is reversible up to Phase D** — Phase E rollout is per-model and can be paused at any point. Phase D's HTTP contract is additive (`@RequiresIfMatch()` per route) so it can be removed by un-annotating routes without redeploying clients.

---

## 4. Stream-by-stream summary

Each section below links to the canonical plan and summarizes the key decisions, deliverables, and verification gates. Full task-level detail lives in the linked plan.

### 4.1 Stream A — Phase 0 Emergency Hotfix → [`01-phase-0-hotfix.md`](./01-phase-0-hotfix.md)

**HARD GATE. Must complete before B/C/D start.**

- 6 items, 31 tasks, 6 code-review gates, 3 appendices
- ~3 eng-days serial / ~1.5 calendar days with 2 engineers in parallel (Item 6 is strictly serial-first)
- **Sequenced sections**:
  - **A** (Item 6, serial first): rotate Azure OpenAI keys, scrub `.env.*`, ship `.gitleaks.toml` + pre-commit + CI gate, rotate `JWT_SECRET_KEY`
  - **B** (Items 1+2, parallel with D): strict global `ValidationPipe` (two-stage rollout), explicit allowlist in `updateTenantConfigs`, immutable setters on `GlobalSettingEntity`
  - **C** (Item 3, parallel with E): invert `AuthorizationGuard` default for `/admin/*`, sweep 9 admin controllers, boot-time route-introspection guard
  - **D** (Item 4, parallel with B): `@Secret` decorator (sourced in `@arcaai/domains` to avoid inbound dep), `scrubLockedForAudit` wiring, backfill SQL proposal (NOT executed)
  - **E** (Item 5, parallel with C): duplicate-platform-key boot invariant in `AppSettingsService.cacheAppSettings()` with dev-only bypass
  - **F**: red-team CI suite green, gitleaks scan green, prod deploy checklist, TASK-301 status flip
- **Extension points for downstream streams**:
  - `@Secret` decorator → Stream B Phase 4 envelope encryption
  - `.gitleaks.toml` → Stream B + Stream C append rules
  - Boot-time route-introspection guard → permanent regression prevention

### 4.2 Stream B — HashiCorp Vault Secrets Migration → [`02-vault-migration.md`](./02-vault-migration.md)

- 7 phases, 80 tasks, 14 code-review gates, 4 appendices
- ~27–34.5 eng-days (depending on solo vs paired)
- **Decision summary**:
  - **Vault is the only wired provider**; AWS Secrets Manager and Azure Key Vault providers compile but throw `NotImplementedException` (kept for future cloud cutover)
  - Default per environment: `env` in `development` / `test:unit`; `vault` in `staging` / `production` / `test:integration`
  - **Local dev never requires Vault credentials** — Vault dev-mode container is opt-in via `SECRETS_PROVIDER=vault docker compose --profile vault up`
  - Fail-closed at boot, stale-while-revalidate steady state
  - AppRole authentication; `role_id` in env, `secret_id` response-wrapped at pod start
  - Vault Transit secrets engine for envelope encryption
  - Vault Database secrets engine for short-lived PostgreSQL credentials (Phase 5)
  - `kv-v2` versioning + Redis Pub/Sub for rotation invalidation
  - Vault is **not** BAA-covered (self-hosted; HOPE owns operational responsibility) — documented in DR runbook
- **Phases**:
  - **1A**: Local dev Vault container (Compose profile)
  - **1B**: 3-node HA Vault cluster on Proxmox (SRE blueprint at `research/deployments/deploy-vm430-432-vault.md`)
  - **2**: `ISecretsProvider` interface + 5 providers (`env`, `vault`, `aws` stub, `azure` stub, `in-memory` for tests) + cache + Redis Pub/Sub invalidation + health indicator
  - **3**: Migrate 12 secret-read sites cited in TASK-301 inventory
  - **4**: Envelope encryption — additive `GlobalSetting` columns + Vault Transit setup + encrypt-on-write/decrypt-on-read for `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `JWT_SECRET_KEY`, `OIDC_CLIENT_SECRET` + user-gated plaintext seed cleanup
  - **5**: Vault Database secrets engine + `@prisma/adapter-pg` password callback + 24h staging soak
  - **6**: Rotation automation — Transit rotation, `kv-v2` versioning, BullMQ rotation worker tailing the Vault audit log
  - **7**: Production cutover + env-var decommission + 7-day soak
- **Cross-stream**: depends on Stream A (Items 4 `@Secret`, 6 gitleaks); coordinates with Stream D on `GlobalSetting` schema (Phase 4A); Phase 5 sequenced after Stream C.

### 4.3 Stream C — PgBouncer Validation & Rollout → [`03-pgbouncer-rollout.md`](./03-pgbouncer-rollout.md)

- 4 phases (0, 1, 2A/2B branch, 3), ~30 tasks, ~7 code-review gates
- ~10–15 eng-days / ~2–3 calendar weeks (1 senior backend + 1 SRE)
- **Decision summary (user's locked-in answers)**:
  - Q1: Keep `POOL_MODE: transaction` **IFF** Prisma 7 ↔ PgBouncer 1.21+ validation passes; otherwise switch to session mode
  - Q2: Keep `auth_file` (no `auth_query` in this stream)
  - Q3: Keep PgBouncer per-node, beside HAProxy (not behind)
  - Q4: Use `DATABASE_URL` (pooled) + `DIRECT_URL` (direct) pattern; `prisma.config.ts` uses `DIRECT_URL` for migrations
  - Q5: >1000 active connections → TBD (future trigger documented in Appendix A)
- **Phases**:
  - **0**: Prisma 7 `PrismaPg` adapter tuning (max=5, idleTimeoutMillis=300_000, connectionTimeoutMillis=5_000) + PG-side `idle_in_transaction_session_timeout='30s'`. Ships immediately, no pooler.
  - **1**: Validation rig — Docker Compose profile + Vitest integration suite (7 cases: `$transaction`+`set_config`, GUC leak, soft-delete, 100× concurrent prepared statements, `DISCARD ALL`, migrate via `DIRECT_URL`, concurrent RLS) + `pgbench` baseline + decision gate (Task 1.19 records PASS/FAIL against explicit rubric)
  - **2A** (conditional, if validation passes): Update HA Compose with `max_prepared_statements=200` + `server_reset_query_always=1` + raise pool size to 50; wire `DATABASE_URL`/`DIRECT_URL`; application-code audit for unsafe `SET`/`LISTEN`/`NOTIFY`/`pg_advisory_lock`/etc; `pgbouncer_exporter` + Grafana
  - **2B** (alternative, if validation fails): Switch to session mode per research doc §6.1
  - **3**: Production cutover with staging soak + rollback rehearsal
- **Cross-stream**: depends on Stream A Item 6 (gitleaks for `userlist.txt` hygiene); coordinates with Stream B Phase 5 (Vault DB credentials sequenced after this stream reaches steady state).

### 4.4 Stream D — Optimistic Locking on Config Writes → [`04-optimistic-locking.md`](./04-optimistic-locking.md)

- 5 phases (A–E), ~40 tasks, 5 code-review gates, 3 appendices
- ~13.5 eng-days / ~2–3 calendar weeks with 2 engineers in parallel
- **Decision summary**:
  - Optimistic (CAS) over pessimistic (row locks) — compatible with transaction-mode pooling
  - `updateMany` with version predicate (Postgres emits predicates verbatim; MySQL drops them per Prisma #10207/#28840 — pin a permanent regression test)
  - `version` is database-owned (no public setter; `applyChangesToEntity` filters; mapper round-trips on read only)
  - Bulk writes (`updateTenantConfigs`) all-or-nothing inside `$transaction`
  - Soft-delete bumps `_version`
  - Human writes never auto-retry (412 is meaningful); machine writes may retry with `pRetry({ retries: 3 })`
  - Strong ETag (`"<integer>"`, no `W/` prefix); missing `If-Match` on `@RequiresIfMatch()` route → 428 Precondition Required (RFC 6585)
  - `SysEvent.ResourceUpdated` payload includes `previousVersion` + `newVersion` for audit-log correlation
  - **No data migration** — every row already has `_version = 1` from Prisma default
- **Phases**:
  - **A** (Audit): committed-as-skipped Vitest test documenting today's silent overwrite
  - **B** (Infrastructure, additive only): `OptimisticConcurrencyException` in `@arcaai/exceptions`; `Repository<T>.updateWithVersion()`; permanent Postgres regression test against Prisma #10207; read-only `version` getter on `BaseEntity`; mapper handlers; `applyChangesToEntity` filter; `softDelete`/`restore` `_version` bump
  - **C** (Opt-in services): DTO `expectedVersion` field; `TenantService.updateTenantConfigs` migration with `$transaction` atomicity; `GlobalSettingService.update` migration; Playwright e2e for concurrent PATCH; `SysEvent` audit correlation
  - **D** (HTTP + SDK): `ETagInterceptor`; `@RequiresIfMatch()` + `@ExpectedVersion()` decorators; 412/428 wire contract; SDK `ConfigManager` ETag capture/replay with `ConfigConflictError`; UI conflict modal stub
  - **E** (Roll out): per-model migration for Tenant, Department, PromptTemplate, AsrPipeline, Webhook + `optimistic_lock_conflict_total{model, route}` Prometheus metric + Grafana panel + per-service "Concurrency Model" READMEs
- **Cross-stream**: depends on Stream A Items 1+2 (strict ValidationPipe + allowlist); coordinates with Stream B Phase 4 schema window; release sequencing rule (API → SDK → UI) for Phase D.

---

## 5. Execution Handoff

Two pathways are supported by the `executing-plans` skill:

### 5.1 Subagent-driven (current session)

```text
Use the `executing-plans` skill with the chosen plan file:
  - Read the plan
  - For each task: spawn a fresh subagent of the type specified in **Agent:** field
  - At each Code Review Gate: spawn a fresh `code-reviewer` subagent; do not proceed on rejection
  - At each user-approval gate (e.g. Stream A §D.6, Stream B §4D): stop and ask
```

Recommended execution order:

1. **Day 1 morning**: Stream A in this session. All 4 engineers' contributions flow through the same orchestrator. Wait for the Final Code Review Gate.
2. **Day 1 afternoon**: Verify Stream A in staging + prod. Stop here if anything fails the exit criteria.
3. **Week 2 onwards**: Spawn 3 parallel orchestrator sessions (one each for Streams B, C, D) — they can run independently. Use `git-manager` to coordinate the 3 schema-migration touch points (R2) and the Phase 5 / Stream C ordering (R3).

### 5.2 Multi-engineer parallel sessions

Each engineer claims a stream (or a section within a stream); each session reads its plan file and walks tasks sequentially with their own subagent dispatches. Daily sync covers cross-stream coordination rules R1–R8.

---

## 6. Implementation Summary

_To be filled in as each stream completes. Each stream's plan file owns its own detailed Implementation Summary; this section is the umbrella roll-up._

| Stream | Status | Lead engineer | Started | Completed | PR(s) | Notes |
|---|---|---|---|---|---|---|
| A — Phase 0 Hotfix | Pending | — | — | — | — | — |
| B — Vault Migration | Pending | — | — | — | — | — |
| C — PgBouncer Rollout | Pending | — | — | — | — | — |
| D — Optimistic Locking | Pending | — | — | — | — | — |

### Files changed (rolled up)

_To be filled in. Each stream contributes its own list; the umbrella points to representative anchors:_

- `apps/api/src/main.ts` (Stream A — ValidationPipe)
- `apps/api/src/interceptors/etag.interceptor.ts` (Stream D — new)
- `packages/applications/src/authorization/authorization.guard.ts` (Stream A — invert default)
- `packages/applications/src/services/tenant/tenant.service.ts` (Stream A — allowlist; Stream D — updateWithVersion)
- `packages/applications/src/services/baseServices/_meta/secrets/**` (Stream B — new module)
- `packages/applications/src/services/baseServices/_meta/appSettings/appSettings.service.ts` (Stream A — boot invariant)
- `packages/domains/src/common/repository.ts` (Stream D — updateWithVersion)
- `packages/domains/src/common/baseEntity/base.entity.ts` (Stream D — version getter)
- `packages/domains/src/common/decorators/secret.decorator.ts` (Stream A — new; Stream B extends)
- `packages/database/src/client.ts` (Stream C — PrismaPg tuning; Stream B Phase 5 — Vault DB credentials)
- `packages/database/src/prisma/schema.prisma` (Stream B Phase 4 — additive columns)
- `packages/exceptions/src/...` (Stream D — OptimisticConcurrencyException)
- `packages/agentic-sdk-v2/src/core/ConfigManager.ts` (Stream D Phase D — ETag capture/replay)
- `infrastructure/docker/docker-compose.dev.yml` (Stream B Phase 1A — Vault profile)
- `research/configs/postgres-ha/docker-compose.yml` (Stream C Phase 2A or 2B — PgBouncer config)
- `research/deployments/deploy-vm500-502-postgres-ha.md` (Stream C — drift resolution)
- `research/deployments/deploy-vm430-432-vault.md` (Stream B — new SRE blueprint)
- `.gitleaks.toml`, `.gitleaksignore` (Stream A — new; Stream B + C append rules)
- `.gitlab-ci.yml` (Stream A — scan-gitleaks job; Stream B — vault-policy-lint job)

### Migrations (rolled up)

- **Stream B Phase 4A** (only schema change in roadmap): additive columns `GlobalSetting.encryptedValue Bytes?`, `GlobalSetting.keyVersion Int?`, plus default Transit key reference. Backward-compatible; no data migration.
- **Stream B Phase 4D** (user-gated): proposal SQL for removing plaintext seed rows after migration verified. NOT executed by the plan; requires user approval per workspace rule.
- **Stream A §D.6** (user-gated): proposal SQL for scrubbing historical audit-log entries that contain decrypted secret values. NOT executed by the plan.

### Endpoints affected

- `PATCH /tenants/me/config` — Stream A (DTO whitelist), Stream D Phase D (`@RequiresIfMatch()`, 412/428)
- `PATCH /global-settings/:id` — Stream A (DTO whitelist), Stream D Phase D (`@RequiresIfMatch()`, 412/428)
- `POST /admin/users/:id/roles` — Stream A (auth guard inversion)
- All `/admin/*` routes — Stream A (boot-time route audit, explicit `@CanManage`)
- Stream E rollout adds `@RequiresIfMatch()` to PATCH routes for `Tenant`, `Department`, `PromptTemplate`, `AsrPipeline`, `Webhook`

---

## 7. Change History

| Date | Author | Description | Files modified |
|---|---|---|---|
| 2026-05-24 | AI orchestrator + 4 planner subagents | Initial roadmap created. Four sub-plans drafted in parallel (Phase 0, Vault, PgBouncer, Optimistic Locking). Umbrella README authored. Stream C cross-stream table corrected to reference Stream A (Phase 0) instead of the skipped layered-resolution research doc. Linked from TASK-301 README. | `README.md`, `01-phase-0-hotfix.md`, `02-vault-migration.md`, `03-pgbouncer-rollout.md`, `04-optimistic-locking.md` |

---

## 8. References

### Internal HOPE references

- [TASK-301 — System Configuration & Multi-Tenancy Deep Assessment](../TASK-301-System-Config-Multi-Tenancy-Assessment/README.md) — parent assessment, locked-in decisions, Phase 0 exit criteria
- [Research overview](../../../research/architecture/system-config-multi-tenancy/00-overview.md) — index of the four research documents
- [Research Doc 02 — Secrets cloud KMS migration](../../../research/architecture/system-config-multi-tenancy/02-secrets-cloud-kms-migration.md) — Stream B source
- [Research Doc 03 — PgBouncer + Prisma](../../../research/architecture/system-config-multi-tenancy/03-pgbouncer-prisma.md) — Stream C source (with user's locked-in answers in §10)
- [Research Doc 04 — Optimistic locking](../../../research/architecture/system-config-multi-tenancy/04-optimistic-locking.md) — Stream D source
- Workflow rules: [`.cursor/rules/00-project-context.mdc`](../../../.cursor/rules/00-project-context.mdc), [`.cursor/rules/01-development-workflow.mdc`](../../../.cursor/rules/01-development-workflow.mdc), [`.cursor/rules/_karpathy.mdc`](../../../.cursor/rules/_karpathy.mdc)

### Methodology skills (read these before starting)

- [`methodology/writing-plans`](file:///Users/taphuynh/.cursor/skills/methodology/writing-plans/SKILL.md) — plan authoring format
- [`methodology/executing-plans`](file:///Users/taphuynh/.cursor/skills/methodology/executing-plans/SKILL.md) — subagent-driven execution pattern with quality gates
- [`methodology/test-driven-development`](file:///Users/taphuynh/.cursor/skills/methodology/test-driven-development/SKILL.md) — red-green-refactor discipline
- [`methodology/verification-before-completion`](file:///Users/taphuynh/.cursor/skills/methodology/verification-before-completion/SKILL.md) — evidence-based completion
- [`methodology/defense-in-depth`](file:///Users/taphuynh/.cursor/skills/methodology/defense-in-depth/SKILL.md) — multi-layer validation strategy (relevant to Stream A and Stream B)
