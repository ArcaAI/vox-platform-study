# TASK-542 — Runtime Defect Clearance (Cycle-1 Assessment Findings)

| | |
|---|---|
| **Status** | Review |
| **Type** | bugfix (batch defect-clearance; precedent: TASK-523) |
| **Program** | Release Readiness — TASK-539 cycle-1 planning output |
| **Created** | 2026-07-22 |
| **Sources (specs for every fix)** | `SOTA-Track/assessment-config-plane-2026-07-22.md` · `assessment-harness-agentic-loop-2026-07-22.md` · `assessment-admin-console-2026-07-22.md` · `findings-register.md` |

## Requirement Analysis

The three cycle-1 runtime assessments confirmed the program doctrine four times over: statically-green surfaces concealed production-affecting runtime defects. This ticket clears every fixable finding from that wave (owner-directed "finish completely and properly"). Each fix follows TDD against the failure scenario documented in its assessment doc.

## Scope (by finding)

| Finding | Fix | Lane | Size |
|---|---|---|---|
| **F-031 remainder (P0)** | `ContextItem.content` silently unpersisted on the ~9 remaining write lanes (summary processors, clinician-edit MODIFIED_SUMMARY, OCR) — 3 chain sites already fixed in-assessment; finish the rest, one failing test per site first | A | M |
| **F-027 (P0)** | SMR never consumes `provider_overrides` — add the request-model field + azure/bedrock client override plumbing + override-wins tests (gateway injection already proven at the wire) | B | M |
| **F-039 (P1)** | Admin-console suites entirely absent from CI — wire into `.gitlab/ci/test.yml` per existing job patterns | D | S |
| F-007 (P1) | Sys-event subscriber invalidating the AppSettingsService snapshot (closes the measured worst-~60s staleness) | A | S |
| F-032 (P1) | Segment-marker lane write-only (per harness assessment) | A | M |
| F-028 (P1) | Soft-deleted `AiProviderConnection` unrecoverable over HTTP — restore-with-overwrite on create-intent over a DELETED row | D | S |
| F-029 (P1) | Dev Vault bootstrap missing 5 service-token secrets (SMR/NLP/Guardrail/TTS/API-gateway) — seed in the bootstrap script | B | S |
| F-035 (P1) | Systemic hydration-mismatch class across 5 console screens | C | M |
| F-036 (P2) | IdP role-picker trap (backend boundary holds; UI fix) | C | S |
| F-037 (P2) | Axe serious: discovery-drawer scroll region | C | S |
| F-038 (P2) | Guardrail health path drift on the console side | C | S |
| F-018 (P2) | NUL byte in `live-documentation.service.ts` | A | XS |
| F-030 (P3) | Non-prod error bodies leak absolute-path stack traces | D | S |
| QW | `pynvml` optional extra; stt black drift | D | XS |

Out of scope (owner-gated, stay open): F-011 (OD-2 prod blast radius), F-012 GPU lane, F-013 SME, F-033 (per assessment), F-034 (orphan watchers — killed 2026-07-22, resolved).

## Verification criteria
- [ ] Every fix lands with a test that failed first (RED noted in the report)
- [ ] Affected suites green: applications, api, admin-console, smr, harness; builds green; lint clean
- [ ] Runtime re-proof where the assessment proved the break live: F-031 (persisted content non-null on each lane), F-027 (override consumed — azure/bedrock client receives the tenant key), F-007 (convergence < 2s post-subscriber)
- [ ] Findings register + assessment queue statuses updated with dated evidence

## Implementation Summary (consolidated verification, 2026-07-22)

All four lanes' fixes verified together on one machine, one API instance (8868 discipline held throughout).

### Suite matrix (all tails pasted verbatim)

| Suite | Result |
|---|---|
| `pnpm --filter @arcaai/applications test` | **6714 passed** / 4 skipped (333 files) |
| `pnpm --filter @arcaai/domains test` | **1376 passed** / 2 skipped / 9 todo (118 files) |
| `pnpm api:build` | green (8/8 tasks) — but see the tsbuildinfo hazard below |
| `pnpm --filter @arcaai/api test` | **2398 passed** / 4 skipped (152 files) |
| `pnpm --filter @arcaai/admin-console build` | green (Next 16 production build) |
| `pnpm --filter @arcaai/admin-console test` | **1115 passed** (144 files) |
| `pnpm smr:test` | **957 passed** / 32 deselected (clean rerun; see flake triage) |
| `pnpm harness:test` | **957 passed**, 96% coverage |
| `pnpm stt:lint` | "All checks passed!" |

```
applications:  Tests  6714 passed | 4 skipped (6718)
domains:       Tests  1376 passed | 2 skipped | 9 todo (1387)
api:           Tests  2398 passed | 4 skipped (2402)
admin-console: Tests  1115 passed (1115)
smr rerun:     957 passed, 32 deselected, 8 warnings in 150.28s
harness:       957 passed, 2 warnings in 47.80s
stt lint:   All checks passed!
```

**SMR flake triage:** the first full run had 1 failure — `test_wired_provider_queue.py::TestQueueWhenRateLimited::test_queued_request_proceeds_when_capacity_frees` (`assert 429 == 200`). Triaged: a 50 ms race window (`asyncio.sleep(0.05)` queue-processor vs request enqueue; queue `max_wait_s=0.5` → the 429 at ~554 ms is the queue-wait timeout) that loses only under machine load — it failed identically against BOTH the pre-lane (HEAD) source (via a PYTHONPATH shadow copy) and the working tree, and passed 3/3 both ways once the parallel suites finished. Unrelated to the F-027 changes (queue path untouched). Full-suite rerun on a quiet machine: 957/957 green.

### Runtime re-proofs (dev API booted from fresh dist, PID 49625, killed after; 8868 verified free before and after)

**F-031 — clinician-edit lane persists ciphertext at rest (live).** As seeded `doctor`, `PATCH /api/v1/consultations/019f8632-…42c0/summary/019f8634-…dc69` with a 70-char sentinel → 200; `GET …/summary/latest` returned the exact sentinel (decrypt-on-read). Read-only psql on dev DB:

```
id=019f8634-022e-7858-9495-1c9af29dcc69 | RAW_SUMMARY | enc_len=145 | enc_prefix=vault:v1: | updatedAt=<PATCH timestamp>
```

145 bytes is consistent with the 70-char sentinel (previous 828-char content would be ~1.1 KB) and the `updatedAt` matches the PATCH to the second — fresh Transit ciphertext, no plaintext at rest. A new `ContextItemVersion` row (edit snapshot) landed at the same timestamp. (Historical evidence of the defect remains visible: the one pre-fix live-runtime summary in dev still reads back `contentLen 0`.)

**F-007 — settings convergence via the subscriber, sub-2s, cron-free (live).** Used the one write lane that never refreshes the cache itself (`GlobalSettingService.update`, `PATCH admin/settings/:id`) against a snapshot-backed read (`GET admin/rate-limit`, served from `getValueFromCache`). Run deliberately at wallclock second :02 (cron fires at :45):

```
pre-flip snapshot relaxed.limit = 300 | wallclock sec = 2
PATCH -> 200 newVersion=2 in 21ms | sec=2
snapshot converged to 301 after 29ms (cron-free window, sec=2)
revert PATCH -> 200 v3; snapshot back to 300 after 7ms
```

**29 ms** same-instance convergence through `@OnEvent(SysEventType.ResourceUpdated)` → `refreshCache()`. Honest caveat (also in the fix's own comment): `@nestjs/event-emitter` is in-process — cross-instance convergence is still cron-bound (worst ~60 s); a fleet-wide push needs a Redis-pub/sub follow-up.

**F-027 — override consumption (unit-level; no live Azure key in this env).** `apps/smr/src/smr/tests/unit/test_provider_overrides.py` — 10/10 green inside the full suite, including `test_override_builds_a_request_scoped_client_with_tenant_credential` (Azure: `AsyncAzureOpenAI` constructed with the tenant key/endpoint/api-version; shared client untouched) and the Bedrock bearer-token twin. Gateway-side decrypt+injection was already proven at the wire in `assessment-config-plane-2026-07-22.md`. **Delta stated honestly:** the full BYO lane (real Azure/Bedrock credential end-to-end) remains env-gated — no cloud key exists in this environment.

### Residual findings from verification

1. **F-031 is NOT fully closed — a 10th write lane was found.** `live-documentation.service.ts#persistDurableSnapshot` (LIVE_SOAP_SNAPSHOT PRE_SUMMARY) sets `.content` and persists at 3 sites (`:1334`, `:1351`, `:1359`) with **no** `encryptContentIntoEntity` call — the live SOAP durable snapshot's clinical text is still silently unpersisted (breaks restart/late-join warm start; the harness warm-start reader would get NULL). This lane was outside the register's 9-site enumeration. All 9 enumerated sites + the 3 chain sites ARE fixed (grep-verified: every other `contextItemRepository.create/update` caller now encrypts). The write-side structural twin of `wrapDelegateWithPhiDecrypt` also remains unbuilt.
2. **F-038 not landed this wave**: guardrail still mounts health at `/api/health` only (`main.py:238`, no `/api/v1` alias); console + gateway already call the real path (`ai-service-proxy.client.ts:54`), so the residual is the alias-or-docs decision + k3s probe audit. (Guardrail was not running locally; path checked statically.)
3. **F-032 python half**: `extract_cited_segment_ids` (`prompt_cache.py`) still has zero python callers and `citation_presence` still scores the disjoint NER lane — the shipped fix implements extract→validate→strip→merge on the gateway persist lane (`harness-internal.service.ts:500/:535`, TS twin `extractAndStripSegmentCitationMarkers`), which closes the clinician-visible-marker and empty-citationsMap halves.

### Environment notes (disclosed)

- **Two orphaned `nest start --debug --watch` processes killed** at session start (PIDs 83922, 94663, ~25 h old, PPID 1) — the F-034 hazard class; none remain.
- **New build-system hazard found:** `apps/api` `build` = `rimraf dist && nest build && tsc-alias`, but `tsconfig.build.tsbuildinfo` survives the rimraf — incremental tsc then judges everything up-to-date and **emits nothing**, so `pnpm api:build` exits green with NO `dist/` at all (observed twice this session). Recovery: delete `tsconfig.build.tsbuildinfo` and rebuild. `rimraf dist` should also remove the tsbuildinfo (or the build should use `--force`).
- Dev-DB residue: the edited summary row `019f8634-…dc69` now holds the verification sentinel (content was assessment-generated, not clinical); `rate-limit.tier.relaxed.limit` value restored to 300, `_version` advanced 1→3. No rows created or deleted.
- All processes started by this verification were killed; 8868 verified free at the end.

## Change History
- 2026-07-22 — Ticket created from cycle-1 assessment output; fix wave launched.
- 2026-07-22 — **Consolidated verification complete** (see Implementation Summary): all 9 suites green (one SMR timing flake triaged as pre-existing and load-bound, clean on rerun); F-031/F-007 runtime re-proven live, F-027 proven unit-level (env-gated live half stated); F-031 found NOT fully closed (live-doc snapshot lane, 3 sites) and F-038 not landed — register updated accordingly.
- 2026-07-22 — Lane D (CI + misc) complete:
  - **F-039** — added `test-admin-console` job to `.gitlab/ci/test.yml` (+ `.rules-admin-console` in `.gitlab/ci/rules.yml`) running `pnpm --filter @arcaai/admin-console test` directly (not `pnpm turbo test`, which would drag in a full `next build` via the `test` task's `dependsOn: ["build"]` chain — out of scope; already covered by the `build-admin-console` Docker job). Verified locally: 143 files / 1112 tests green, hermetic (no DB/API). Scope is unit-only; the ~37-file Playwright e2e suite still needs a composed stack and stays local-discipline until a nightly job is built. YAML validated with `python -c 'yaml.load(..., Loader=...)'` (custom `!reference` constructor — the tag is GitLab-specific, not standard YAML).
  - **F-028** — `AiProviderConnectionService.upsertRow` now restores-with-overwrite when a create-intent (`If-Match: "0"`) lands on a soft-deleted `(tenantId, provider)` tombstone, instead of colliding with the unique index (previously 409 unique-constraint / 412 dead end, no HTTP recovery path). Added `AiProviderConnectionRepository.findDeletedByTenantAndProvider` + `AiProviderConnectionService.restoreAndOverwrite` (CAS-gated on the tombstone's own version, mirrors the `GlobalSettingService.create` / `UserRoleAssignmentService` revive-on-create precedent already in the codebase). TDD: 3 new tests RED (confirmed against pre-fix code — plain `create()` was called, colliding with the tombstone) → GREEN. Live OCC contract on non-deleted rows re-asserted unchanged. `packages/applications/src/services/ai-provider-connection/__tests__/ai-provider-connection.service.test.ts`: 37/37 green.
  - **F-030** — `BaseException.toJSON()` (`packages/exceptions/src/common/base.exception.ts`) no longer echoes the raw `this.stack` (absolute filesystem paths) into non-production HTTP error bodies; `sanitizeStack()` reduces every stack frame to `basename:line:col`. Also sets `this.name = this.constructor.name` in the constructor so the concrete exception class (not generic `Error`) is what survives the scrub. Production behavior (`stack: undefined`) unchanged. TDD: 4 new tests in `packages/exceptions/src/common/__tests__/base.exception.test.ts`, RED confirmed pre-fix → GREEN. No existing test asserted on raw stack shape, so nothing needed adjusting. Full `@arcaai/exceptions` suite (7/7), `apps/api` interceptor/filter suites (39/39, server-side logs unaffected — they read `err.stack` directly, not `toJSON()`) green; `apps/api` builds.
  - **pynvml optional extra** — `packages/py-runtime-models/pyproject.toml` gains `[project.optional-dependencies] nvml = ["pynvml>=11.5.0"]` (F-012's "extra omitted" half); `vram.py`'s existing feature-detected import is unchanged (still fully optional/try-except gated). `uv lock` re-run at repo root: additive-only diff (`pynvml` + `nvidia-ml-py` resolved under the new extra).
  - **stt black drift** — fixed the one genuinely hand-drifted file, `apps/stt/src/stt/core/database/voice_profile_model.py` (2-line quote-style fix). `black --check` on the full `apps/stt/src`/`tests` tree found ~100 files needing reformatting under the currently-pinned black 26.5.1 (matches `uv.lock`) — pre-existing, systemic drift, not caused by any single recent change (no CI job runs `black --check`; `lint-python` only runs `ruff check`). Flagged as a separate out-of-scope background task rather than bulk-reformatting 100 files under an XS-sized quick-win. `pnpm stt:lint` clean.
  - Verification: `pnpm --filter @arcaai/domains build`, `pnpm --filter @arcaai/exceptions build`, `pnpm --filter @arcaai/applications build`, `pnpm api:build` all green; `pnpm stt:lint` clean; `.gitlab/ci/{test,rules}.yml` YAML-valid.
- 2026-07-22 — Closed the three residual findings from the verification pass above:
  - **F-031 lane 10 (P0) — CLOSED.** `LiveDocumentationService#persistDurableSnapshot` (`packages/applications/src/services/consultation/live-documentation/live-documentation.service.ts`) now calls the new private `encryptSnapshotContent()` (mirrors `context.service.ts#encryptContent` / `chain-summary.service.ts`, via the shared `encryptPhiFields` guard) before **all 3** create/update sites (dedup-reuse update, first create, and steady-state update). TDD: added `'encrypts the running summary into the ContextItem before every create/update'` to `live-documentation.service.test.ts` (durable-snapshot describe block); RED confirmed first (`expected "vi.fn()" to be called 1 times, but got 0 times`) against the pre-fix source, then GREEN after the fix. `pnpm --filter @arcaai/applications test`: **6715 passed** / 4 skipped (333 files) — 6714 baseline + 1 new. All 10 of the register's enumerated `ContextItem.content` write lanes are now encrypt-on-write; the write-side structural twin of `wrapDelegateWithPhiDecrypt` remains a separate (unbuilt) hardening item.
  - **Build hazard — FIXED.** `apps/api/package.json` `build` script changed from `rimraf dist && nest build && tsc-alias` to `rimraf dist tsconfig.build.tsbuildinfo && nest build && tsc-alias`, so a stale buildinfo can no longer make incremental tsc judge everything up-to-date and emit nothing. Proof: ran `pnpm --filter @arcaai/api build` twice back-to-back from a clean `dist`/tsbuildinfo state — `dist/main.js` existed and its mtime advanced both times (`04:22:58` → `04:23:10`), confirming both runs actually recompiled and repopulated `dist/`.
  - **F-038 (P2) — FIXED.** `apps/guardrail/src/guardrail/main.py` now also mounts the existing health router at `/api/v1` (`app.include_router(health_router, prefix="/api/v1", tags=["health"])`), alongside the untouched `/api/health` mount — same handler, no route replaced. `apps/guardrail/src/guardrail/api/middleware/auth.py`'s `EXEMPT_PATHS` gained the matching `/api/v1/health`, `/api/v1/health/ready`, `/api/v1/health/live` entries (the v1 alias would otherwise 401 under a configured service token, since `EXEMPT_PATHS` is an exact-match set, not a prefix). TDD: `test_auth_middleware.py` gained `test_exempt_paths_membership` v1 assertions + two new tests (`test_v1_health_reachable_without_token_when_auth_disabled`, `test_v1_health_alias_matches_legacy_health_status`); RED confirmed by temporarily reverting both source edits (3 failures: exempt-paths membership, v1-health-reachable, v1-health-matches-legacy), then GREEN after reapplying. `pnpm guardrail:test`: **174 passed** (172 baseline + 2 net-new; one helper test file (`test_exempt_paths_membership`) grew in place) — full guardrail suite clean.
  - Findings register (`docs/implementation/SOTA-Track/findings-register.md`) updated: F-031 now reads fully closed (all 10 lanes); F-038 now reads fixed.
- 2026-07-22 — **Second consolidated verification (post-lane-landing) — all gates green; F-007 and F-032 fully closed.**
  - Suites (tails verbatim): harness **962 passed** (up from 957; replay-compat subset `test_replay_compat.py` exercised at 100% coverage — the F-032 workflow-payload change is replay-safe); applications **6726 passed / 4 skipped (334 files)**; admin-console **1115 passed (144 files)**; `pnpm api:build` green (8/8 tasks) with `dist/main.js` freshly emitted (tsbuildinfo-hazard fix holding).
  - **New defect found & fixed during verification:** `health-check.service.test.ts` failed deterministically (twice) at import — its `vi.mock('@nestjs/terminus')` lacked the `HealthIndicator`/`HealthCheckError` exports, and the F-007 module change (`appSettings.module.ts` → `RedisSubscriberService`/`RedisCacheModule`) extended the test's import graph to `secrets.health.ts`, which extends `HealthIndicator` at class-definition time. Fix: completed the mock (base class with `getStatus`, error class). RED observed first (full-suite runs 1 & 2: `1 failed | 332 passed`), GREEN after (`333 passed | 1 skipped`, file alone 20/20).
  - **F-007 two-instance LIVE proof (closes the last residual):** two API instances from one dist (A=8868; B=8869 via `ENV_FILE_PATH` pointing at a scratchpad copy of `.env.dev` with only `PORT` changed — `.env.dev` loads `override:true`, the F-034(b) hazard, re-confirmed live when a plain `PORT=8869` boot bound 8868 and died EADDRINUSE). Shared dev Redis. `PATCH admin/settings/85000000-…0307` (`rate-limit.tier.relaxed.limit`) 300→301 via A at wallclock second :07 (cron :45 ruled out) → B's snapshot-backed `GET admin/rate-limit` converged in **36ms**; revert converged on B in **36ms**. Final state restored (value 300 both instances; `_version` 3→5 — only dev-DB residue). Both PIDs killed; 8868/8869 verified free; scratchpad env copy + token deleted.
  - **F-032 python half verified landed:** `sensor_runner.run_computational_sensors` now calls `extract_cited_segment_ids` (validated against `allowed_segment_ids` threaded through the temporal payloads) into `SensorContext.cited_segment_ids`; `citation_presence` credits marker-evidenced provenance (1.0/`segmentEvidenced`) on the empty-claims path instead of degrading. F-032 fully closed.
  - **Script renames & doc verifiers:** zero `task-[0-9]` filenames under `packages/*/scripts` (renames: media-seed/media-storage/thumbnail-backfill, harness-consultation-seed/harness-knowledge-ingest-seed/harness-provenance-read); all 42 script-referencing root `package.json` aliases resolve to existing files; `node scripts/verify-traceability.mjs` → **OK, 754 claims, 0 failures**; `node scripts/verify-doc-claims.mjs` → **12 failures / 1878 claims, all confined to frozen `docs/research/**` refs** (the accepted baseline; no new residuals).
  - Tails: (a) `media-seed.ts` still uses `task-376` as a runtime KEY_PREFIX/tag/metaData value — deliberate (changing it would orphan already-seeded objects), values not filenames/comments; (b) an unstaged black-only re-wrap of the staged `sensor_runner.py` expression sits in the working tree (formatting, no behavior); (c) F-034(a) orphan-watcher discipline held — no orphans found this session.
- 2026-07-22 — **Status → Review.** All in-scope findings from the §Scope table are landed, including the closer's residual fixes surfaced by the ticket's own verification pass (F-031 lane 10 / `live-documentation.service.ts#persistDurableSnapshot`, the `tsconfig.build.tsbuildinfo` build hazard, and F-038 guardrail health-path alias) — confirmed present in the Change History above, not merely proposed. Remaining open items are the explicitly owner-gated ones listed under "Out of scope" (F-011 prod blast radius, F-012 GPU-hardware half, F-013 SME assignment) plus the two honestly-flagged non-closures: F-039's Playwright e2e half (needs a composed-stack nightly job) and the write-side structural twin of `wrapDelegateWithPhiDecrypt` (unbuilt hardening item, not a defect). No fix in this ticket's scope was left half-done.
