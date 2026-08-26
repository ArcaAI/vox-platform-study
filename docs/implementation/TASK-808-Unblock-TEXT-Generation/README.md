# TASK-808 — Unblock TEXT Generation

| Field | Value |
|---|---|
| **Status** | `Review` |
| **Type** | `bugfix` |
| **Branch** | `dev-2.2` |
| **Architecture** | <https://claude.ai/code/artifact/b6b68b73-3cb9-4cec-89f3-8afd1553c13b> |
| **Master** | [TASK-806](../TASK-806-Consultation-Workflow-Substrate-Unification/README.md) |
| **Depends on** | nothing — start immediately |
| **Blocks** | every other sub-ticket (nothing below is observable while generation 503s) |
| **Agent** | `debugger` · `opus` · effort `medium` · **main tree** (no worktree — infra + shared surfaces) |

> **Urgency.** This is a live production-path outage on `hope-v2-dev`, not preparatory work.
> No partial summary and no summary finalization are produced today.

## 1. Requirement Analysis & Scope

### In scope
- Restore `provider_overrides` injection on the six TEXT `/api/v1/generate` callers.
- Fix the `hope-nlp` model-cache permission failure.
- Investigate `hope-api` readiness flapping.
- Fix the stale five-artifact regeneration rule.

### Out of scope — the compat fence (owner: "Do NOT touch the compat things")

Reproduced in full so this ticket is self-contained. **Do not read, edit, refactor, rename, or
"tidy" anything below.** If a change appears to require touching one of these, make it **additively**
instead and report the constraint rather than editing.

```
apps/compat-playground/**                        apps/quick-compat-app/**
apps/api/src/modules/text-compat/**              apps/api/src/modules/stt-compat/**          (OD-8)
apps/api/src/global-prefix.config.ts             apps/api/src/main.ts:109-111
packages/vox-node/src/resources/summarization.ts packages/vox-node/src/types/summarization.ts
packages/vox-node/src/core/url.ts                (PREFIX_EXEMPT_PATHS)
packages/agentic-sdk-v2/src/compat.ts            packages/agentic-sdk-v2/src/compat/**
packages/agentic-sdk-v2/src/types/consultation.ts:117-122   (the @deprecated `department` field ONLY)
packages/agentic-sdk-v2/src/types/context.ts:172-179        (AddContextInput.structuredData ONLY)
```


## 2. Current State Evaluation

TASK-799 lane B (`70eec34d5`, 2026-08-23) deleted `apps/text`'s per-provider env plane. Every
adapter now requires a gateway-injected `provider_overrides` entry and **fails closed** with
`503 PROVIDER_CREDENTIALS_MISSING`. Only `prompt-management.service.ts` and
`text-proxy.controller.ts` call `TextRequestEnrichmentService.applyTenantProviderOverrides`.

Reproduced against the live pod: without overrides → 503; with them → 200 and a real completion.

**Root architectural point:** the live loop is a hand-rolled path outside the governed exposure
plane, which is *why* it bypassed the shared enrichment service. TASK-811 removes the hand-rolling;
this ticket stops the bleeding.


## 2a. Findings this ticket closes

| Finding | Evidence (verified) |
|---|---|
| TEXT fails closed with `503 PROVIDER_CREDENTIALS_MISSING` when no `provider_overrides` entry is injected | `apps/text/src/text/core/connection.py:65` — *"No provider connection resolved for '{provider}'. Text holds no endpoint or credential of its own…"* |
| TEXT resolves the connection from `request.provider_overrides` keyed by `request.provider` — it does **not** query the DB | `connection.py:37-52` (`resolve_connection`) |
| Only 2 of 8 TEXT callers enrich | `prompt-management.service.ts:1345` and `text-proxy.controller.ts` call `applyTenantProviderOverrides`; the six below do not |
| The env fallback that used to mask this was deleted | `70eec34d5` (2026-08-23) removed `TEXT_OPENAI_COMPAT_` incl. `base_url: str = "http://localhost:1234/v1"` |
| The gateway payload has no `provider_overrides` key | `live-documentation.service.ts` `callText` builds `{prompt, system_prompt, provider, model, max_tokens, stream, response_format}` then POSTs directly |

**Reproduction (run inside the `hope-text` pod — this is how the diagnosis was confirmed):**

```
POST http://127.0.0.1:8862/api/v1/generate   header: X-Tenant-Id: <tenant>
{"prompt":"say hi","provider":"lm-studio","model":"lms-gemma-4-e2b-it-qat","max_tokens":16,"stream":false}
  -> 503 {"detail":"No provider connection resolved for 'openai_compat'…","error_code":"PROVIDER_CREDENTIALS_MISSING"}

same body + "provider_overrides":{"lm-studio":{"api_key":"local","base_url":"http://hope-lmstudio:1234/v1","funding":"platform"}}
  -> 200 {"status":"completed","provider":"lm-studio","usage":{...},"latency_ms":2430}
```

**The six call sites (all must enrich):**

| File | Line |
|---|---|
| `packages/applications/src/services/consultation/live-documentation/live-documentation.service.ts` | 2033 |
| `packages/applications/src/services/consultation/jobs/processors/pre-summary.processor.ts` *(OD-9 exemption)* | 313 |
| `packages/applications/src/services/consultation/jobs/processors/comprehensive-summary.processor.ts` | 430 |
| `packages/applications/src/services/consultation/summary/chain-summary.service.ts` | 650 |
| `packages/applications/src/services/consultation/summary/summary.service.ts` *(OD-9 exemption)* | 1654 |
| `packages/applications/src/services/dna-writing-style/dna-writing-style.processor.ts` | 450 |

**Observed failure signature in `hope-api` logs** (2026-08-25, consultation `01a03816-…`):
`WARN [LiveDocumentationService] "TEXT running-summary call failed" … 503`, then
`"Live summary flush" … textFailed:true, nlpFailed:true, entityCount:0, summaryChars:0`, then
`GET /summary/latest -> 404 "No summary has been generated yet"`.

**Secondary (independent causes, both in scope):**
- NLP: `Token classification model load failed: PermissionError at /home/hope when downloading blaze999/Medical-NER`.
- `hope-api` Endpoints flipped to `notReadyAddresses` 09:02 → ready 09:03; TEXT reports
  `effective_config: last_refresh_ok:false, sources:{}` because `http://hope-api:8868` was refused.
  (Effective-config is deliberately fail-safe to env, so it is **not** the 503 cause.)

## 3. Implementation Plan (TDD)

| # | Task | Test first |
|---|---|---|
| 1 | Inject `TextRequestEnrichmentService` into `live-documentation.service.ts:2033` | assert the posted body carries `provider_overrides[provider]` |
| 2 | Same for `pre-summary.processor.ts:313` *(OD-9 exemption)* | same |
| 3 | Same for `comprehensive-summary.processor.ts:430` | same |
| 4 | Same for `chain-summary.service.ts:650` | same |
| 5 | Same for `summary.service.ts:1654` *(OD-9 exemption)* | same |
| 6 | Same for `dna-writing-style.processor.ts:450` | same |
| 7 | **Regression gate**: one test asserting *every* TEXT `/generate` caller enriches — the missing coverage that let this ship | new spec enumerating call sites |
| 8 | `hope-nlp`: writable `HF_HOME` volume (`PermissionError at /home/hope` downloading `blaze999/Medical-NER`) | manifest change in `arca/hope-v2-deployment` |
| 9 | `hope-api` readiness flapping — Endpoints flipped to `notReadyAddresses` 09:02 → ready 09:03 on 2026-08-25; also breaks TEXT's effective-config pull (`last_refresh_ok:false`) | probe/timeout review |
| 10 | Add `pnpm --filter @arcaai/vox-node gen:admin` to the DoD at `.claude/rules/05-nestjs-api.md:155` ("four artifacts" → five) | — |

## 4. Verification

```bash
pnpm --filter @arcaai/applications test
pnpm --filter @arcaai/applications build
pnpm lint
```
Then a live consultation on `hope-v2-dev` producing a non-empty `summaryChars` in the
`Live summary flush` log line, and `GET /consultations/:id/summary/latest` returning 200.

## 5. Definition of Done
- [x] All six callers enrich; regression gate green — three layers: a **source scan** so a new caller fails on its first commit, a behavioural test, and a **DI-wiring guard** (the injection is `@Optional()`, so a module missing the import silently no-ops and every positional fixture still passes)
- [ ] **Live flush shows `textFailed:false` and non-zero `summaryChars`** — needs deploy
- [ ] **NLP `/classify/tokens` returns 200** — needs an **image rebuild**; restarting the pod will not help
- [ ] **`hope-api` readiness stable over 30 min** — needs deploy
- [x] Rule 05 DoD updated to five artifacts
- [x] No compat file modified outside the OD-9 exemption

**Remaining work is entirely deployment**, not code. Durability of the NLP cache is
[TASK-817](../TASK-817-NLP-Persistent-Model-Cache/README.md).

## Best Practices — apply to every task here

- **Fail posture is declared, not decided at the call site.** Provider/model *selection* is
  `fail-closed`; tuning knobs are `open-to-default`. A backend error must never be disguised as
  "the default" — that is what made this outage invisible.
- **Use the shared enrichment path.** `TextRequestEnrichmentService.applyTenantProviderOverrides`
  resolves tenant → SYSTEM and carries the `funding` label so metering is derived from the
  supplying row rather than stamped at the call site. Hand-rolling the injection re-creates the bug.
- **The regression gate is the deliverable**, not the six edits. The reason this shipped is that no
  test asserted every TEXT caller enriches.
- **Credentials never appear in logs.** `api_key` is a `SecretStr` on the Python side for a reason.

## Standing instructions (every task in this ticket)

- **Evidence, not assertion.** "Tests pass" with nothing pasted is not a result. Paste actual
  command output (`01-development-workflow.md` §Phase 5).
- **TDD:** failing test first, and you must *see it fail*. A test that never failed verifies nothing.
- **Branch is `dev-2.2`**, never `dev`.
- **Never `git stash` in a worktree** — the stash stack is shared repo-wide. Commit, then
  `git checkout HEAD~1 -- <path>` for a baseline.
- **Orchestrator owns shared surfaces:** merges, `pnpm install`, `db:push`/`db:migrate`/
  `test:db:reset`, Docker/infra, and every `gen:*` invocation. Do not run them.
- **Lint warnings in `packages/*` are errors.** `eslint-plugin-only-warn` downgrades them; treat
  them as hard failures anyway.
- **Do not run** the test suites of `apps/compat-playground`, `apps/quick-compat-app`, or
  `packages/ui` unless your change lands inside that package (owner directive).

### The five-artifact rule (this ticket changes an admin route)

`.claude/rules/05-nestjs-api.md:155` still says **four** artifacts and omits the fifth. That
omission turned TASK-805's pipeline #990 red. The real rule:

```bash
pnpm api:build && pnpm api:route-manifest && pnpm api:openapi && pnpm api:portal \
  && pnpm --filter @arcaai/vox-node gen:admin
```
Verify with `pnpm api:openapi:check`, `pnpm api:portal:check`, `pnpm --filter @arcaai/vox-node gen:admin:check`.
**`packages/vox-node/src/resources/admin/**` is GENERATED — never hand-edit.** Only
`admin-resource.ts` is hand-authored.

## Close-out protocol — MANDATORY (owner directive 2026-08-26, amended by measurement)

**Which path applies depends on where you work. Read the right one.**

### If you work in a WORKTREE

You **cannot** merge into `dev-2.2` yourself, and you must not try. `dev-2.2` is checked out in the
primary checkout, so git refuses every route into it — `git push . HEAD:dev-2.2` returns
*"refusing to update checked out branch"*, and it is right to: the primary's index and work tree
would desync from HEAD. This was measured, not assumed.

1. **Verify your base FIRST — before any other work.** Worktrees have been created off **`dev`**,
   where `packages/workflow-contract` does not exist at all; two of two agents hit this.
   Run `git merge-base --is-ancestor $(git rev-parse dev-2.2) HEAD`. Non-zero ⇒ confirm your tree
   is clean, then `git reset --hard dev-2.2`. Report which you found.
2. Gates green on your branch, with output pasted.
3. Commit everything. Leave the worktree and branch **intact**.
4. Report your branch name, commit SHA, and that the merge is pending. The orchestrator merges from
   the primary checkout, re-runs the gates there, and only then destroys the worktree and branch.

### If you work in the MAIN CHECKOUT

1. Gates green on your branch, output pasted.
2. **Merge into `dev-2.2`.** Never `dev`.
3. **Re-run the affected gates AFTER the merge** — a clean merge is not a passing build; a sibling
   lane may have moved the base underneath you.
4. **Delete your branch**, only after confirming the merge is on `dev-2.2`
   (`git log dev-2.2 --oneline | grep <your-sha>`).

### Stop conditions — never force past these

- A merge that conflicts in a way you cannot resolve with confidence ⇒ **STOP and report**, leaving
  the branch intact. An abandoned branch is recoverable; a bad merge or a deleted branch is not.
- Gates failing after a merge ⇒ **STOP and report**. Delete nothing.
- Never `git worktree remove --force`, never `git worktree prune`, never delete a branch holding
  commits absent from `dev-2.2`.
- Never `git stash` — the stash stack is shared repo-wide across every worktree.

## Agent Brief (self-contained — copy verbatim when dispatching)

**Ticket:** TASK-808 · **Branch:** `dev-2.2` · **Tree:** main checkout (touches infra + shared surfaces — no worktree)
**Agent:** `debugger` · **Model:** `opus` · **Effort:** `medium`

**Per-task tiers:** the six call-site edits are mechanical (`sonnet`-grade), but the judgement of
*what must not be touched* under the OD-9 exemption is the risky part — keep the whole ticket at
`opus` rather than splitting it.

**You own:** the six TEXT `/api/v1/generate` callers, the NLP cache manifest, the API readiness
probe, and `.claude/rules/05-nestjs-api.md:155`.
**You must not touch:** everything in the compat fence above, except the OD-9 repair-only exemption
on `summary.service.ts:328-384,486-560` and `pre-summary.processor.ts` — restore credential
injection and fix defects found there; change nothing else in those files.
**Read first:** `.claude/rules/04-application-services.md`, `06-python-services.md`, `09-infrastructure-devops.md`.
**Return contract:** your final message is DATA for the orchestrator. Return: `FIXED` (table:
file:line → change), `EVIDENCE` (pasted test + live-flush output showing non-zero `summaryChars`),
`INFRA` (NLP + readiness findings), `UNTOUCHED` (confirmation no fence file was modified).

**Rules to read before starting:** `.claude/rules/` files 00, 01, 04, 06, 09. A subagent inherits NONE of the orchestrator's context — read them.

## 6. Implementation Summary

### 6.1 The six callers (tasks 1–6) — FIXED

All six now route their outgoing body through
`TextRequestEnrichmentService.applyTenantProviderOverrides` before POSTing. None hand-rolls the
injection, so the tenant → SYSTEM cascade and the `funding` label that derives metering apply
uniformly.

| File | Change |
|---|---|
| `live-documentation/live-documentation.service.ts:2034` | enrich `payload` before the flush POST |
| `jobs/processors/pre-summary.processor.ts:302` *(OD-9)* | enrich `textPayload` |
| `jobs/processors/comprehensive-summary.processor.ts:426` | enrich `textPayload` |
| `summary/chain-summary.service.ts:641` | enrich `textPayload` |
| `summary/summary.service.ts:1635` *(OD-9)* | enrich `textPayload` before the repair loop, so the original and the corrective retry post byte-identical credentials |
| `dna-writing-style/dna-writing-style.processor.ts:456` | payload HOISTED out of the call argument (it was an inline object literal), then enriched. Fields unchanged. |

Each also gained a trailing `@Optional() @Inject(TextRequestEnrichmentService)` ctor param — trailing
so every existing positional fixture keeps its arity — and each owning module now imports
`TextRequestServiceModule` (`live-documentation`, `consultation-job`, `chain-summary`, `summary`,
`dna-writing-style`).

### 6.2 The regression gate (task 7) — THREE layers, because one is not enough

The ticket is right that the gate is the deliverable. One gate could not cover it:

| Test | Answers | Why it alone is insufficient |
|---|---|---|
| `text-generate-caller-coverage.test.ts` | *Does every file that POSTs to `/api/v1/generate` reference a sanctioned injector?* Scans `apps/api/src` + `packages/applications/src` from source, so a NEW caller fails on its first commit. | Cannot prove the injector runs on the path that posts. |
| `text-generate-caller-injection.task808.test.ts` | *Does the body that reaches `axiosRef.post` actually carry `provider_overrides[provider]`?* Drives each of the six real payload-building methods. | Cannot see a caller nobody wrote a test for. |
| `text-enrichment.di-wiring.task808.test.ts` | *Does the token RESOLVE at boot?* Asserts each class injects it and each module imports the providing module. | **The gap that would have re-opened the outage.** The injection is `@Optional()`, so a module missing the import resolves `undefined`, the `?.` call is a silent no-op, and every positional fixture still passes. Precedent: `usage-ledger.di-wiring.task615.test.ts`, `gate-edit-mining.di-wiring.test.ts`. |

The scan allow-lists exactly two injector names: `applyTenantProviderOverrides` (the shared path)
and `attachLlmByok` — the pre-existing hand-rolled equivalent inside the compat fence, allow-listed
BY NAME rather than by file path so it cannot quietly become the pattern new code copies.

### 6.3 NLP model-cache PermissionError (task 8) — ROOT CAUSE WAS THE IMAGE, not the manifest

The ticket expected a volume in `arca/hope-v2-deployment`. It is not a manifest gap:

- `hope-python-base` creates the runtime user with **`--no-create-home`**, so `/home/hope` does not exist.
- huggingface_hub defaults its cache to `~/.cache/huggingface` → an uncreatable path → `PermissionError at /home/hope`.
- `apps/nlp/Dockerfile` never set `HF_HOME`. **`apps/guardrail` (`/app/.hf-cache`), `apps/tts` and `apps/stt` all already do** — `apps/nlp` was the only one that did not.
- `nlp/core/config.py:422,663` reads `HF_HOME` with an **empty default** and only re-exports it when non-empty, so the service cannot supply this for itself.
- Verified against the live `hope-nlp` Deployment: **no `HF_HOME` env var and no volumes at all**, so the image is the only possible source.

Fixed in `apps/nlp/Dockerfile` with the exact sibling pattern (`HF_HOME=/app/.cache/huggingface` +
`mkdir -p` + `chown -R hope:hope`), guarded by `apps/nlp/tests/test_hf_cache_writable_task808.py`.

**Followed up as [TASK-817](../TASK-817-NLP-Persistent-Model-Cache/README.md):** weights land in the
container's writable layer, so they are re-downloaded on every pod restart. Verified while opening
that ticket — `hope-stt` and `hope-tts` ALREADY mount a shared `models-cache` hostPath with an
`init-hf-cache` chown initContainer, so `hope-nlp` is the only weight-loading service without a
persistent cache and TASK-817 is an application of an existing pattern, not a new design.

### 6.4 `hope-api` readiness flapping (task 9) — a REMOTE, UNAUTHENTICATED way to evict the pod

Not a timeout-tuning problem. Mechanism:

1. `TieredThrottlerGuard` is a GLOBAL guard and runs **first**, ahead of `UnifiedAuthGuard`.
   `@Public()` exempts a route from AUTH, **not** from the throttler.
2. `ApiHealthController` carries `@Throttle({ default: { limit: 30, ttl: 60000 } })` — 30 req/min,
   shared across the whole controller.
3. The bucket key is `tenant:${tenantId}`, and an unauthenticated request resolves `tenantId` to
   **`null`** — so the kubelet's probes and every anonymous caller on the internet shared ONE bucket.
4. The class comment asserted "Kubernetes probe schedules sit well below 30/min." Against the live
   Deployment they do not: readiness `periodSeconds: 5` = 12/min + liveness `periodSeconds: 30` =
   2/min = **14/min steady state (~47% of budget)**, and **26/min (87%)** while the startup probe
   also runs at 5s.
5. A modest anonymous burst exhausts the window and **the probe** takes the 429. A non-2xx is a
   probe failure to the kubelet, and `failureThreshold: 2` at `periodSeconds: 5` removes the pod
   from Endpoints ~10s later — until the 60s window rolls.

That is a ~1-minute outage with **no container restart**, which is precisely the observed
09:02 → 09:03 flap, and it explains the secondary symptom too: while the pod was out of Endpoints,
`http://hope-api:8868` was refused and TEXT reported `last_refresh_ok:false, sources:{}`.

So the cap added to blunt unauthenticated reconnaissance against `/live`, `/ready`, `/startup` was
itself a remote unauthenticated way to evict the pod from its own Service, at ~16 req/min.

**Fixed** with `@SkipThrottle()` on the three kubelet probes
(`apps/api/src/modules/health/health.controller.ts`), guarded by
`probe-throttle-exemption.task808.test.ts`. The reconnaissance rationale is preserved: the three
probes return a constant `{status}` with nothing to enumerate, while `/health` — the detailed route
that *does* expose version and uptime — deliberately KEEPS its 30/min cap.

**Related observation, NOT changed (out of scope):** `hope-nlp` carries the same
`timeoutSeconds: 1` / `failureThreshold: 2` / `periodSeconds: 5` probe shape. It is FastAPI, so the
throttler mechanism above does not apply, but the 1-second budget is tight for a service that loads
models. Flagging rather than tuning another service's manifest under this ticket.

### 6.5 The five-artifact rule (task 10) — DONE

`.claude/rules/05-nestjs-api.md` DoD now reads **five** artifacts, adds
`pnpm --filter @arcaai/vox-node gen:admin` and its `:check`, and states why the omission turned
TASK-805's pipeline #990 red plus the never-hand-edit rule for `src/resources/admin/**`.

### 6.6 Files changed

| File | Kind |
|---|---|
| `packages/applications/.../live-documentation.service.ts` + `.module.ts` | fix + wiring |
| `packages/applications/.../pre-summary.processor.ts` *(OD-9)* | fix |
| `packages/applications/.../comprehensive-summary.processor.ts` | fix |
| `packages/applications/.../consultation-job.service.module.ts` | wiring (both processors) |
| `packages/applications/.../chain-summary.service.ts` + `.module.ts` | fix + wiring |
| `packages/applications/.../summary.service.ts` *(OD-9)* + `.module.ts` | fix + wiring |
| `packages/applications/.../dna-writing-style.processor.ts` + `.module.ts` | fix + wiring |
| `packages/applications/.../text-request/__tests__/text-generate-caller-coverage.test.ts` | NEW gate |
| `packages/applications/.../text-request/__tests__/text-generate-caller-injection.task808.test.ts` | NEW gate |
| `packages/applications/.../text-request/__tests__/text-enrichment.di-wiring.task808.test.ts` | NEW gate |
| `apps/api/src/modules/health/health.controller.ts` | fix |
| `apps/api/src/modules/health/__tests__/probe-throttle-exemption.task808.test.ts` | NEW gate |
| `apps/nlp/Dockerfile` | fix |
| `apps/nlp/tests/test_hf_cache_writable_task808.py` | NEW gate |
| `.claude/rules/05-nestjs-api.md` | rule correction |

**No compat-fence file was modified.** `summary.service.ts` and `pre-summary.processor.ts` were
touched under the OD-9 repair-only exemption and carry credential injection ONLY — verified by diff.

### 6.7 Evidence

TDD: every gate was seen RED before the fix, by neutralising the change and re-running.

```
# RED — the six injections neutralised
 Test Files  2 failed (2)
      Tests  7 failed | 1 passed (8)
   (the scan named exactly the six files independently:
    comprehensive-summary.processor.ts, pre-summary.processor.ts,
    live-documentation.service.ts, chain-summary.service.ts,
    summary.service.ts, dna-writing-style.processor.ts)

# RED — @SkipThrottle removed
 Test Files  1 failed (1)
      Tests  3 failed (3)

# RED — apps/nlp/Dockerfile reverted
 2 failed in 0.02s   (assert None — HF_HOME absent)
```

```
# GREEN — TASK-808 suites
 Test Files  6 passed (6)
      Tests  45 passed (45)

# GREEN — pnpm --filter @arcaai/applications test
 Test Files  584 passed | 1 skipped (585)
      Tests  10206 passed | 4 skipped (10210)

# GREEN — pnpm --filter @arcaai/api test
 Test Files  260 passed | 2 skipped (262)
      Tests  4024 passed | 4 skipped (4028)

# GREEN — apps/nlp guard
 2 passed in 0.01s

# builds
pnpm --filter @arcaai/applications build   -> tsc, no output (success)
pnpm api:build                             -> Tasks: 12 successful, 12 total

# lint (0 errors; ZERO new warnings in TASK-808 files, verified by per-file filter)
@arcaai/applications  -> 223 problems (0 errors, 223 warnings)  [all pre-existing]
@arcaai/api           -> 64 problems (0 errors, 64 warnings)    [all pre-existing]

# artifact gates — no drift, no regeneration needed (the change adds no route)
pnpm api:openapi:check                      -> OK, coverage clean
pnpm api:portal:check                       -> no drift (admin 606 ops, business 179 ops)
pnpm --filter @arcaai/vox-node gen:admin:check -> no drift (52 areas, 404 routes, 368 schemas)
pnpm api:route-manifest                     -> 680 routes, route-manifest.json byte-identical
```

### 6.8 NOT verified — needs a deploy (orchestrator owns it)

These three DoD items require the new images on `hope-v2-dev` and cannot be closed from a checkout:

- [ ] Live flush shows `textFailed:false` and non-zero `summaryChars`
- [ ] NLP `/classify/tokens` returns 200 (needs the rebuilt `hope-nlp` image — the fix is in the Dockerfile, so a rebuild is REQUIRED; restarting the current pod will not help)
- [ ] `hope-api` readiness stable over 30 min (needs the rebuilt `hope-api` image)

Baseline captured for comparison: `hope-api` `readyReplicas: 1` at the time of writing, last
`Available` transition 2026-08-25T15:39:29Z; `hope-nlp` `readyReplicas: 1`, image
`nlp@sha256:ab3eecea…`, no `HF_HOME` and no volumes.

## 7. Change History
| Date | Change |
|---|---|
| 2026-08-25 | Opened from TASK-806 §7. Renumbered from 807 (taken by the Vault-session fix, `fe7fc77c1`). |
| 2026-08-26 | Implemented tasks 1–7 and 10. Six callers now enrich through the shared service; three-layer regression gate added (source scan + behavioural + DI wiring). Status → `Review`. |
| 2026-08-26 | Task 8: root cause was `apps/nlp/Dockerfile` never setting `HF_HOME` (base image uses `--no-create-home`), NOT a missing volume in the deployment repo — the three sibling Python services already set it. Fixed in-repo with a pytest guard. |
| 2026-08-26 | Task 9: readiness flapping traced to the kubelet probes sharing the anonymous `tenant:null` 30 req/min throttle bucket — a remote unauthenticated way to evict the pod from Endpoints, matching the observed 1-minute flap with no restart. Fixed with `@SkipThrottle()` on the three probes; `/health` keeps its cap. |
| 2026-08-26 | Opened [TASK-817](../TASK-817-NLP-Persistent-Model-Cache/README.md) for the ephemeral-cache follow-up noted in §6.3. |
