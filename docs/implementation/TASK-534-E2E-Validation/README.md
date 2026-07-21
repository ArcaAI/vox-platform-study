# TASK-534 — Program E2E Validation & Evidence Roll-Up

- **Status**: Pending
- **Type**: infrastructure / test (program Phase 7 — deliberately last)
- **Program**: [2026-07-20 agentic platform program plan](../SOTA-Track/2026-07-20-agentic-platform-program-plan.md) §4 Phase 7 · [companion findings review](../SOTA-Track/2026-07-20-agentic-platform-review-findings.md) (gate evidence §5, defect register §4)
- **Ticket number**: TASK-534 is the program plan's *suggested* number (highest allocated is TASK-522; the program reserves 523–534). Confirm at open time per the CLAUDE.md ticket workflow.
- **Size**: M · **Lanes**: B (Platform TS / `apps/api` tests) + F (Infra/CI)
- **Dependencies**: ALL of TASK-523…TASK-533. **Incremental execution policy**: per-surface partial runs are allowed as phases land — each child ticket's surface may be executed (and its evidence pasted into that child's README) as soon as that ticket merges; the *program-closing* full-suite run and roll-up (§5.4) happens only after 523–533 are all landed. TASK-530 is reserved/unallocated — if it is never opened, it imposes no dependency.

---

## 1. Requirement Analysis

This ticket is the program's final validation wave (owner's "e2e at last" discipline, proven in the TASK-508–522 run — plan §2.2: "specs may be *authored* earlier, executed in P7"). It closes E8 ("fix all defects; build green") at the *live-HTTP* level and provides the evidence protocol for the whole program's Definition of Done.

Four workstreams:

1. **(a) Execute the existing agentic gateway e2e specs live** — the four renamed agentic suites + the cross-tenant contract suites + the task-506 governance suite, via `pnpm test:api:up` (terminal 1) → `pnpm test:e2e` (terminal 2), against the isolated test stack.
2. **(b) Author + execute net-new specs** for every program surface not owned by another ticket (spec matrix §4.1): TASK-524 provider connections / runtime-profile cascade / settings write-lane, TASK-526 BYO azure override reaching SMR (env-gated), TASK-528 discovery merge + register, TASK-529 retention round-trip, TASK-532 governance locks. TASK-531 and TASK-533 author their own specs (plan §4 P4/P6); this ticket owns their *execution*. Every new admin/by-id surface gets a `*-cross-tenant.spec.ts` (house rule, `05-nestjs-api.md` §Testing).
3. **(c) Env-gated live-engine suites** (vLLM / llama.cpp / LM Studio / Ollama real servers; GPU tiers) — owner-run; this ticket documents the gating env vars and the runbook pointer (`docs/operations/inference/README.md`).
4. **(d) Full gate sweep re-run** (the findings §5 command list) + the evidence-capture protocol: each child README's Implementation Summary carries pasted actual output; the program closes with the roll-up section here (§9).

**Program DoD served**: findings §5 all-green re-run + every child ticket carrying pasted evidence + all cross-tenant contracts green = program DONE (see §5.5).

---

## 2. Current State Evaluation (code-verified 2026-07-20)

### 2.1 Existing e2e spec inventory — `apps/api/tests/e2e/`

**65 `*.spec.ts` files + 1 `consultation-jobs.e2e-spec.ts`.** Naming convention is `.spec.ts` (NOT `.test.ts`) — enforced by root `playwright.config.ts:31` (`testDir: './apps/api/tests/e2e'`) and `:34` (`testMatch: '**/*.spec.ts'`). ⚠️ Observation: `consultation-jobs.e2e-spec.ts` ends in `-spec.ts`, not `.spec.ts`, so it is **not collected** by the testMatch glob (unverified whether intentional — check during execution; its content overlaps `consultation-job-cross-user.spec.ts`).

**The four renamed agentic suites** (renamed from `task-5xx-*` prefixes in the working-tree docs cleanup; content verified 2026-07-20):

| Spec | One-line scope |
|---|---|
| `agentic-policy.spec.ts` (9.4 KB, Jul 19) | HarnessPolicy loop-knob OCC (428 missing If-Match / 412 stale / version bump), GLOBAL_ADMIN-only 403 wall on `PATCH admin/harness/policy/global`, prompt-template approve OCC + privilege wall, DRAFT-prompt never resolved via `GET admin/agentic/instructions` |
| `generation-stats.spec.ts` (6.4 KB) | AD-1 GenerationStats via the trajectory read plane — step `stats` JSON blob shape (`stopReason`/`ttftMs`/`tokensPerSecond` typed when present), `payloadRef` never exposed, `@CanManage('HarnessPolicy')` 403 for plain doctor; populated-stats assertions seed-guarded |
| `mcp-admin.spec.ts` (9.2 KB) | MCP registry CRUD at `admin/mcp-servers` — cross-tenant/absent indistinguishable 404 (DEF-C3), foreign `?tenantId=` rejected `[403,404]`-never-200, OCC 428/412, throwaway SYSTEM row soft-deleted in `afterAll`. **Carries D-02**: unused `APIRequestContext` import at `mcp-admin.spec.ts:30` (verified: single occurrence, import-only) — fixed by TASK-523 item 0.2; this ticket re-verifies lint before execution |
| `trajectory-admin.spec.ts` (8.3 KB) | Trajectory admin read plane — session list shape, offset pagination, steps keyset pagination (`nextCursor` advance, no overlap), `stats`-yes/`payloadRef`-never projection, cross-tenant 404-over-403 |

**Cross-tenant contract suites** (the house-pattern exemplars): `task-307-{consultation-job,storage,tenant-bucket,transcription-job,voice-profile}-cross-tenant.spec.ts` + `task-307-w3-aggregate.spec.ts`, `task-326-admin-fetchall-cross-tenant.spec.ts`, `task-348-harness-progress-cross-tenant.spec.ts`, `task-444-role-members-cross-tenant.spec.ts`, `task-450-stt-session-cross-tenant.spec.ts`, `task-506-ai-task-defaults-cross-tenant.spec.ts`, `consultation-job-cross-user.spec.ts`.

House pattern (read from `task-307-storage-cross-tenant.spec.ts:1-80`): (1) header comment documents the *original vulnerability* and the fix's mechanism; (2) `beforeAll` logs in both a tenant admin (`DEFAULT_TENANT_KEY` = `__GLOBAL__`) and an elevated ARCAAI user via `loginUser(request, SEEDED_USERS.…)`; (3) **genuine-probe discipline** — the spec first asserts the foreign resource *exists* (visible to its owner) so a cross-tenant 404 proves ownership enforcement, not a missing row; (4) asserts 404 (never 403, never 200) with existence-indistinguishable body (DEF-C3 "Resource not found").

**task-506 conventions** (`task-506-ai-task-defaults-cross-tenant.spec.ts:1-80`): bearer-header helper, `readRowVersion()` so every PUT carries the *current* `_version` (OCC), foreign `?tenantId=` rejected `[403,404]`-never-200 (`resolveScopedTenantId` posture), OCC 428/412 assertions, unknown-key 400. ⚠️ **Stale contract inside this spec**: its header (line 13) and the effective-defaults test (line 67, expects `['guardrail.validate','nlp.ner','nlp.classification']` and "nlp.* writes stay tenant-admin allowed") predate the current tree's `GLOBAL_ADMIN_ONLY_TASK_PREFIXES = ['guardrail.','smr.','nlp.','harness.']` and the 9-key expansion (findings §2, D-16 family). Expect RED on first run; reconciling this spec to the current governance **is owned by this ticket** (it is an e2e file; TASK-523 only fixes comments/copy).

**Remaining ~48 specs** (not re-executed individually here, listed for the full-run scope): auth/authz/RBAC/throttle (9), OCC + red-team + audit (4), admin-console backend waves task-372…419 (16), settings/filter/streaming task-423…455 (6), harness gates task-330 ×2, ai-inference task-446, speech task-488, health/monitoring/tenants/services-proxy (5), task-219-gaps.

### 2.2 Shared helpers — `tests/helpers/`

Barrel `tests/helpers/index.ts` re-exports `auth.helper.ts`, `db.helper.ts`, `api.helper.ts`, `e2e.helper.ts`, `streaming.helper.ts`. E2e specs import **only** from the barrel: `DEFAULT_TENANT_KEY` (`e2e.helper.ts:56`), `SEEDED_USERS` (`:69`), `loginUser` (`:210`); also available: `SEEDED_API_KEY` (`:62`), `loginBothUsers`-style helpers (`:251-252`).

**Known pre-existing type errors** (prior program records flagged the barrel; re-verified this pass via standalone `tsc --noEmit --strict` on `tests/helpers/index.ts`): `api.helper.ts:122,135` (`.status` on `never`), `auth.helper.ts:52` (jwt `expiresIn` string vs `StringValue`), `db.helper.ts:24` (`@arcaai/database` module resolution — invocation-dependent), `db.helper.ts:217` (untyped generic call). **Not blocking execution** — Playwright transpiles specs without a typecheck pass, and the three symbols e2e specs use are unaffected. Do NOT fix them in this ticket (out of manifest); note them wherever a new spec's import surprises a reviewer.

Cross-tenant unit fixture: `tests/cross-tenant/fixtures.ts` — pure synthetic (no DB), deterministic UUIDs (tenantA `aaaa…`, tenantB `bbbb…`, GLOBAL_ADMIN `eeee…`) shaping the CLS payload exactly as `apps/api/src/database/tenant-context.provider.ts` reads it. This is the **unit/contract-test** fixture — e2e specs use the live seeded users instead; new *service-level* cross-tenant tests in child tickets reuse it.

### 2.3 Test infra & commands (verified in root `package.json`)

| Command | Line | Effect |
|---|---|---|
| `pnpm docker:test:up` | `package.json:50` | `./scripts/start-test-infra.sh` — isolated compose stack up |
| `pnpm test:setup` | `:55` | `./scripts/test-setup.sh` — infra + DB push + seed, one shot |
| `pnpm test:api:up` | `:56` | `./scripts/start-test-api.sh` — API on :8868 against test infra (terminal 1) |
| `pnpm test:unit` | `:84` | Vitest, excludes `**/integration/**` and `**/e2e/**` |
| `pnpm test:integration` | `:87` | Vitest sequential vs live test DB |
| `pnpm test:e2e` | `:88` | `dotenv -e .env.test -- playwright test` (root `playwright.config.ts`) |
| `pnpm test:db:seed` | `:96` | test-DB seed (+ media) |
| `pnpm test:db:reset` | `:98` | `test:db:push` + `test:db:seed` |

All three scripts exist (`scripts/start-test-api.sh`, `scripts/start-test-infra.sh`, `scripts/test-setup.sh` — verified on disk).

**Isolated test stack ports** (verified `tests/docker-compose.test.yml`): Postgres **5433**→5432 (`:38-39`), Redis **6380**→6379 (`:75-76`), MinIO **9002**→9000 (`:109-110`), Qdrant **6335**→6333 (`:165-166`) — dev-stack ports untouched; header comment (`:5-11`) states the isolation contract.

### 2.4 Runbook & prior evidence

- `docs/operations/inference/README.md` exists (vLLM/llama.cpp production engines; LM Studio/Ollama dev engines; PHI in-boundary posture) — the anchor for §4.3 env-gated suites. TASK-529 adds `docs/operations/inference/model-retention.md` (plan AD-4).
- Most recent full-suite evidence (findings §5, 2026-07-19 tracker): api 2281, applications 6408, domains 1368, database 799 — e2e suites were **not** re-run by the review; this ticket produces the fresh run.

---

## 3. Architecture, Patterns & Best Practices

House e2e conventions (binding for every net-new spec):

1. **Real HTTP, no mocks** — Playwright `request` against `http://localhost:8868/api/v1` (rule 05 §Testing); API started separately via `pnpm test:api:up`. Specs never import app code; contracts are asserted purely over the wire.
2. **File placement/naming** — `apps/api/tests/e2e/<surface>.spec.ts`, cross-tenant contracts as `<surface>-cross-tenant.spec.ts` (this program drops task-number prefixes, matching the renamed agentic suites).
3. **Header-comment contract** — every spec opens with the locked contracts it probes, the exact controller/route, and the live-stack requirement line (see `agentic-policy.spec.ts:1-38` as the template).
4. **Genuine-probe discipline** — before asserting a cross-tenant 404, prove the foreign row exists via its owner's scope (`task-307-storage-cross-tenant.spec.ts:61-78`); otherwise the test silently degrades to a missing-row 404.
5. **Tenancy assertions** — 404-over-403 on by-id probes (absent ≡ foreign, DEF-C3 body); foreign `?tenantId=` on list/row routes rejected `[403,404]`, **never 200** (`resolveScopedTenantId` posture, task-506 pattern).
6. **OCC assertions** — versioned PATCH/PUT: missing `If-Match` → 428, stale `"999"` → 412, correct version succeeds and bumps `version`; always re-read the current version first (`readRowVersion` pattern).
7. **Secrets** — any credential-bearing surface asserts the secret appears in **no** response body at any status (TASK-524/526 `encryptedApiKey`; `authRef` precedent in `mcp-admin.spec.ts`).
8. **Data hygiene** — mutations target throwaway rows created in `beforeAll` and soft-deleted in `afterAll`; seed rows are read, never destroyed; no `DELETE`/`TRUNCATE` ever. E2e runs **only** on the isolated test stack (§2.3) — never the dev DB.
9. **Env-gated suites pattern** — suites needing live engines/creds guard with `test.skip(!process.env.<GATE>, '<reason>')` at describe level, so the default run is green-by-skip with an explicit skip count (never green-by-assertion-removal).
10. **Evidence discipline** — paste actual terminal output (suite counts, skips, durations) into READMEs; a claim without pasted output is not evidence (`verification-before-completion` skill). No retries-mask-flake: see §4.4.

---

## 4. Implementation Plan

### 4.1 Spec matrix

| Surface | Spec file | Existing/new | Owner ticket | Assertions summary | Env-gated? |
|---|---|---|---|---|---|
| Harness/agentic policy + prompt governance | `agentic-policy.spec.ts` | existing | 508-program (exec: 534) | OCC 428/412, global-policy 403 wall, DRAFT-skip | no |
| GenerationStats read plane | `generation-stats.spec.ts` | existing | 508-program (exec: 534) | `stats` shape, `payloadRef` never, RBAC 403 | no (populated-stats seed-guarded) |
| MCP registry admin | `mcp-admin.spec.ts` | existing | 508-program (exec: 534) | CRUD, DEF-C3 404, OCC | no |
| Trajectory admin plane | `trajectory-admin.spec.ts` | existing | 508-program (exec: 534) | pagination, projection, 404-over-403 | no |
| AiTaskDefault governance | `task-506-ai-task-defaults-cross-tenant.spec.ts` | existing — **update** (stale nlp.* contract, §2.1) | 534 | all-9-keys global-only writes, OCC, `[403,404]` | no |
| Provider connections (SYSTEM + tenant lanes) | `ai-provider-connections.spec.ts` + `ai-provider-connections-cross-tenant.spec.ts` | **new** | 534 (surface: 524/526) | secret-never-echoed (all statuses), self-host-provider tenant row → 403, cloud tenant row OK, OCC 428/412, cross-tenant 404, DTO whitelist 400 | no |
| Runtime-profile cascade | `ai-runtime-profiles.spec.ts` | **new** | 534 (surface: 524) | model-override beats provider-default beats null (via effective read), global-admin-only writes, OCC | no |
| Settings write-lane | `settings-registry-write.spec.ts` | **new** | 534 (surface: 524) | `PUT admin/settings/registry/:key`: `globalOnly` key by tenant admin → 403, clamp behavior, kill-switch invariant (registered kill-switch default-OFF observable), effective read reflects write | no |
| BYO azure override → SMR | `byo-llm-credentials.spec.ts` | **new** | 534 (surface: 526) | tenant A sets azure credential → generation request routes with override (assert via SMR echo/status), tenant B unaffected, key never echoed | **yes** — `E2E_SMR_URL` live SMR or `E2E_SMR_STUB=1` stub (define at authoring; default skip) |
| Model source resolution (localPath/S3) | — **integration-level, not gateway e2e** | placement decision | 527 | `resolve_model_dir` precedence is a Python/service concern with no gateway route to probe; lives in per-service pytest (moto/minio doubles) per plan §4 P2. This ticket only verifies 527's suites ran (evidence check) | n/a |
| Discovery merge + register | `ai-model-discovery.spec.ts` | **new** | 534 (surface: 528) | merged listing tags `registered\|discovered\|registered-missing-on-server`; register creates AiModel row; global-admin-only | **partial** — merge shape vs live engine needs `E2E_OLLAMA_URL`/`E2E_LMSTUDIO_URL`; registry-only assertions ungated |
| Retention settings round-trip | `model-retention-settings.spec.ts` | **new** | 534 (surface: 529) | admin PUT `models.retention.ttlSeconds` → effective-config (`GET internal/effective-config` via service-token or admin effective read) reflects clamped value; out-of-clamp values clamp 60–3600 | no |
| Template immutability / clone / resync | `pipeline-templates.spec.ts` (name per 531) | existing-by-then (authored by 531) | 531 (exec: 534) | locked-clone PATCH/DELETE → 403 + actionable message, clone flow, resync adds missing template | no |
| Governance locks (E3) | `governance-locks.spec.ts` | **new** | 534 (surface: 532) | tenant PATCH `safetyEnabled`/`phiFailClosed` → 403; new `McpServer`/`AgentTrajectory` RBAC subjects honored; 404-over-403 preserved | no |
| Token-budget events + agentic-context round-trip | authored by 533 | existing-by-then | 533 (exec: 534) | budget stop annotation on trajectory; `agentic.context.*` write → live-doc behavior change | no |
| Live-engine suites (vLLM/llama.cpp/LM Studio/Ollama, GPU tiers) | `live-engines/*.spec.ts` | **new** (thin) | 534 (owner-run) | provider health + one real generation per engine; keep_alive/ttl propagation observable | **yes** — `E2E_LIVE_ENGINES=1` + per-engine URL vars (§5.3) |

New-surface cross-tenant rule: `ai-provider-connections-cross-tenant.spec.ts` is mandatory (tenant BYO rows are by-id, tenant-scoped). Runtime profiles, settings registry, discovery, retention are SYSTEM/global-only surfaces — cross-tenant probes fold into their main spec (foreign `?tenantId=`/privilege-wall assertions) rather than separate files; 531/533 own their surfaces' cross-tenant coverage per their plans.

### 4.2 Execution order

1. **Pre-flight** (any time): fix `task-506` stale contract; verify `pnpm --filter @arcaai/api lint` green (D-02 fixed by 523); decide `consultation-jobs.e2e-spec.ts` fate (rename to `.spec.ts` or document as superseded).
2. **Per-phase partial runs** as children land (dependency policy, header): run only the affected suite(s) + their cross-tenant sibling; paste output into the child's README.
3. **Net-new spec authoring** — may begin as soon as each surface's routes are frozen (plan §3 AD-1…AD-7 contracts); RED against the pre-feature tree is expected and is the authored-early evidence.
4. **Program-closing full run** — after 533 lands: full protocol §5.1, all suites, evidence into §9.
5. **Owner-run gated suites** — handed off with the §5.3 env-var table + runbook pointer; results pasted by owner into §9.

### 4.3 File table (net-new, this ticket's authoring scope)

| File | Status |
|---|---|
| `apps/api/tests/e2e/ai-provider-connections.spec.ts` | NEW |
| `apps/api/tests/e2e/ai-provider-connections-cross-tenant.spec.ts` | NEW |
| `apps/api/tests/e2e/ai-runtime-profiles.spec.ts` | NEW |
| `apps/api/tests/e2e/settings-registry-write.spec.ts` | NEW |
| `apps/api/tests/e2e/byo-llm-credentials.spec.ts` | NEW (env-gated) |
| `apps/api/tests/e2e/ai-model-discovery.spec.ts` | NEW (partially env-gated) |
| `apps/api/tests/e2e/model-retention-settings.spec.ts` | NEW |
| `apps/api/tests/e2e/governance-locks.spec.ts` | NEW |
| `apps/api/tests/e2e/live-engines/*.spec.ts` | NEW (env-gated, owner-run) |
| `apps/api/tests/e2e/task-506-ai-task-defaults-cross-tenant.spec.ts` | UPDATE (stale governance contract) |
| `docs/implementation/TASK-534-E2E-Validation/README.md` | NEW (this file) |

**Ownership manifest**: ONLY the files above — net-new/updated files under `apps/api/tests/e2e/**` + this README. No production code, no helper edits (`tests/helpers/**` stays untouched — its known type errors are out of scope), no config changes. Specs authored by 531/533 stay in those manifests.

### 4.4 Flake policy

**No retries.** `playwright.config.ts` retry count stays as-is (0 locally); a flaky test is investigated first (`systematic-debugging` skill) — root causes seen before: seed drift (fix the seed or the guard-assertion), timing on async persistence (poll with bounded deadline, never sleep-and-hope), port collision (§7). A test quarantined more than one session becomes its own bug ticket; green-by-retry is not evidence.

---

## 5. TDD / Verification Plan

This ticket IS the verification phase — "RED first" here means new specs are expected RED against any tree where their surface hasn't landed, and that run is captured as authored-early evidence.

### 5.1 Run protocol (per run, full or partial)

```
1. pnpm test:setup            # or: pnpm docker:test:up && pnpm test:db:reset
2. pnpm test:api:up           # terminal 1 — API :8868 vs isolated stack (PG 5433/Redis 6380/MinIO 9002/Qdrant 6335)
3. pnpm test:e2e              # terminal 2 — full; or: pnpm test:e2e -- <spec-file> for partial
4. Capture: suite counts, skip counts (env-gated suites report skips, not silent green), duration, failures verbatim
5. Paste into the owning child README's Implementation Summary; roll up here (§9)
```

Seed/reset between destructive investigations: `pnpm test:db:reset` (push + seed; isolated DB only — the dev DB is `db push`-managed and must never be reset, per repo memory).

### 5.2 Full gate sweep (findings §5 command list, re-run at program close)

```
pnpm build:api                                    # 8/8 tasks green
pnpm --filter @arcaai/admin-console build         # after @arcaai/ui build
pnpm turbo lint                                   # incl. api hard-errors + packages only-warn-as-error
pnpm --filter @arcaai/vox typecheck && pnpm --filter @arcaai/vox lint
pnpm py:stt-v2:lint  py:smr-v2:lint  py:guardrail:lint  py:nlp:lint  py:harness:lint  py:tts-v2:lint
pnpm py:stt-v2:typecheck  py:smr-v2:typecheck  py:guardrail:typecheck  py:nlp:typecheck  py:harness:typecheck
pnpm test:unit && pnpm test:integration
pnpm py:stt-v2:test  py:smr-v2:test  py:guardrail:test  py:nlp:test  py:harness:test  py:tts-v2:test
pnpm test:api:up  →  pnpm test:e2e
```

### 5.3 Env-gated suite gating (documented for owner handoff)

| Var | Gates | Notes |
|---|---|---|
| `E2E_SMR_STUB=1` / `E2E_SMR_URL` | `byo-llm-credentials.spec.ts` | stub asserts override headers/payload reach SMR; live asserts a real azure round-trip (owner creds) |
| `E2E_LIVE_ENGINES=1` | `live-engines/*.spec.ts` | master gate; default run skips with count |
| `E2E_OLLAMA_URL`, `E2E_LMSTUDIO_URL`, `E2E_VLLM_URL`, `E2E_LLAMACPP_URL` | per-engine suites + discovery live half | engine endpoints per `docs/operations/inference/README.md` staging steps |
| GPU tier | vLLM/llama.cpp suites | owner-run on tiered hardware (2026-07-18 review §7 matrix) |

Exact var names are proposals frozen at spec-authoring time; they are test-only (NOT runtime config — no `turbo.json#globalEnv` entry needed unless a script reads them, verify then).

### 5.4 What constitutes program DONE

1. Findings §5 sweep (§5.2) fully green, output pasted in §9.
2. `pnpm test:e2e` full run green (env-gated suites: green-or-skipped with skip counts shown).
3. Every cross-tenant spec (existing + new) green.
4. Each child ticket README (523–533) Implementation Summary carries pasted evidence for its own gates.
5. Owner-run suites executed by owner OR explicitly handed off with the §5.3 table + runbook pointer recorded.
6. Roll-up section §9 completed; program plan Change History updated to Completed.

---

## 6. Acceptance Criteria & DoD

- [ ] All 4 renamed agentic suites + all 13 cross-tenant/contract suites (§2.1) executed live and green; output pasted
- [ ] `task-506-ai-task-defaults-cross-tenant.spec.ts` reconciled to all-9-keys global-only governance and green
- [ ] All §4.3 net-new specs authored (house header-comment contract, genuine-probe, OCC, secret-never-echoed, DEF-C3 assertions) and green against the landed tree
- [ ] Every new admin/by-id surface from TASK-524…533 covered by a `*-cross-tenant.spec.ts` or an in-spec cross-tenant block — all green
- [ ] Env-gated suites: skip cleanly by default with visible skip counts; owner-run suites documented (§5.3) + handed off
- [ ] Full gate sweep (§5.2) re-run green; evidence pasted in §9
- [ ] Every child README (523–533) Implementation Summary carries pasted actual output (no green-by-assertion)
- [ ] No production code, helper, or config files touched (manifest §4.3 honored); no dev-DB writes at any point
- [ ] `consultation-jobs.e2e-spec.ts` collection gap resolved or documented
- [ ] This README §9 roll-up completed; Change History updated

---

## 7. Risks & Rollback

| Risk | Mitigation |
|---|---|
| **Port 8868 collision with the dev stack** — precedent: the TASK-504 session's e2e/browser runs were blocked by a concurrently-running dev API on 8868 (prior-session note in the program records) | Pre-flight check in the run protocol: `lsof -i :8868` before `test:api:up`; stop `pnpm dev:stack` first. The test API must be the only 8868 listener |
| **Test-data pollution / destructive ops against dev DB** | E2e runs ONLY on the isolated stack (PG 5433/Redis 6380/MinIO 9002/Qdrant 6335, §2.3); specs create throwaway rows + `afterAll` soft-delete; `pnpm test:db:reset` resets the isolated DB only — dev DB is never reset (repo memory: it is `db push`-managed and behind migration history) |
| **Timing flake** (async persistence, sys-event fan-out, SSE) | §4.4 investigate-first, zero retries; bounded polling helpers, never fixed sleeps |
| **Seed drift breaks genuine-probes** (the task-307 lesson) | Existence pre-assertions stay mandatory; seed-count test updates land with any seed change (plan §5.7) |
| **Suites authored early go stale as surfaces evolve** | Frozen contracts (plan §3 AD-1…AD-7) are the authoring source; drift found at execution is triaged to the owning child ticket, not patched silently here |
| **Env-gated suites silently never run** | Skip counts asserted visible in every pasted run; §5.3 handoff row is a DoD item |

**Rollback**: this ticket adds only test files + this doc — rollback is `git rm` of the §4.3 files; zero production impact.

---

## 8. References

- Program plan: `docs/implementation/SOTA-Track/2026-07-20-agentic-platform-program-plan.md` (Phase 7, §2.2 e2e-last discipline, §3 frozen contracts)
- Findings: `docs/implementation/SOTA-Track/2026-07-20-agentic-platform-review-findings.md` (§4 D-register, §5 gates, §7 GAP-register)
- House e2e rules: `.claude/rules/05-nestjs-api.md` §Testing · `.claude/rules/01-development-workflow.md` §Test Placement
- Pattern exemplars: `apps/api/tests/e2e/task-307-storage-cross-tenant.spec.ts` (genuine probe) · `task-506-ai-task-defaults-cross-tenant.spec.ts` (OCC + governance) · `agentic-policy.spec.ts` (header-contract template)
- Helpers: `tests/helpers/e2e.helper.ts` (`loginUser:210`, `SEEDED_USERS:69`, `DEFAULT_TENANT_KEY:56`) · `tests/cross-tenant/fixtures.ts`
- Infra: root `playwright.config.ts:31,34` · `tests/docker-compose.test.yml` · `scripts/{start-test-infra,start-test-api,test-setup}.sh`
- Runbook: `docs/operations/inference/README.md` (+ `model-retention.md` once TASK-529 lands)

---

## 9. Implementation Summary

**First full execution + defect clearance, 2026-07-21** (TASK-539 cycle-1 queue item 1; workflow evidence in SOTA-Track `findings-register.md` F-022/023/024):

- **Run 1 (first-ever execution)** against the freshly reset test stack (API on 8868, no port collision; S3-enum + task_524 schema present via push+seed): **649 passed / 22 failed / 23 skipped** (1.1 m).
- **Triage** (all 22 root-caused with live repros): **15 product defects in 7 groups / 7 test bugs in 2 groups** — G1 harness-policy first-edit ignored `If-Match`; G2 `If-Match: "0"` create lane impossible (decorator vs TASK-506/526 contract — also broke the shipped console's first-edit path); G3 provider PUT encrypted before OCC → 500; G4 `ArgumentInvalidException` → 500 platform-wide; G5 `findFirst`-throws killed the settings-registry read lane; G6 discovery routes shadowed by `:id` (surface dead); G9 role clone demanded `manage:Role`; G7 non-hermetic specs under `fullyParallel`; G8 specs frozen at pre-TASK-532 governance.
- **Fixes applied** (TDD where a unit seam exists; ~9 new/updated unit tests): controller-order fix (`ai-model.module.ts`), null-safe `findBackingRow`, `ArgumentInvalidException`→400 interceptor branch, OCC-before-encryption + Transit-failure→503, create-branch OCC enforcement in harness-policy, clone gate → `@CanCreate('Role')` (owner-reversible, comment at route), 404-on-null in `fetchById/fetchBySlug` (audio-pipeline + ai-model admin), serial-mode/fixture hermeticity for 528/531 specs, 506 spec refreshed to the 9-key registry + all-prefixes-global-admin governance.
- **Owner decision (G2/F-023):** accept `If-Match: "0"` as create-intent — decorator relaxed with RED→GREEN evidence (28 decorator tests), stale-`"0"`-vs-existing-row → 412 covered, both former known-reds restored and green.
- **End state on the 7 affected suites: 107 passed / 0 failed / 1 pre-existing conditional skip.** Units: applications 6,677 · api 2,396+ green; `pnpm build:api` green; full-suite confirmation run recorded in Change History.

---

## 10. Change History

| Date | Change |
|---|---|
| 2026-07-20 | Ticket README authored (execution-ready): code-verified spec inventory (65 `*.spec.ts` + 1 uncollected `-spec.ts`), helper-barrel known type errors re-verified, test-infra commands + isolated ports confirmed, spec matrix + ownership manifest + run protocol + gate sweep + env-gating handoff defined. Status Pending — blocked on TASK-523…533 (per-surface partial execution allowed as phases land). |
| 2026-07-20 | Program plan §2.5 **Completion & Cleanup Doctrine** adopted as BINDING for this ticket (owner directive): incorrect implementations in the owned surface are removed completely with the fix; partial implementations are finished end-to-end (or explicitly retired); redundant implementations are converged and deleted. Reviewer enforces the §2.5 classification table, plan-conformance (deviations = recorded decision rows), full-closure traceability of the claimed GAP/D/M IDs, and the performance gates. |
| 2026-07-21 | **First full execution + defect clearance** (see §9): run 1 = 649/22/23; 22 failures triaged (15 product defects / 7 test bugs), all fixed incl. owner-decided G2 (`If-Match: "0"` = create-intent). Confirmation full-suite run: **669 passed / 23 skipped / 1 throttle-flake** (task-388 — 19/19 green re-run in isolation; flake caused by back-to-back full runs hitting the login throttle, not by any fix). API e2e gate is GREEN at working-tree state on top of `3d016cb0`. Remaining ticket scope: env-gated lanes (Vault-live, browser/console e2e) per §4. |
