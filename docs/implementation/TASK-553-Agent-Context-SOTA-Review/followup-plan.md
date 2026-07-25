# TASK-553 — Wave 2 Follow-up Plan (deferred findings)

Prepared 2026-07-25. Closes out the 11 deferred findings from `findings.md` so the ticket
can move to completion. Three parallel lanes with disjoint file ownership; Lane E owns ALL
schema/migration/generator steps. Model allocation per owner directive: **sonnet-5 (high)**
for exploration/scoped implementations, **opus-5 (high)** for complex implementations. TDD
throughout (failing test first). Same in-tree rules as Wave 1 (no git state changes, no
worktrees).

| Lane | Model / effort | Findings | Character |
|---|---|---|---|
| **E — Governance & schema features** | opus / high | F-18 (revisit carry-forward), F-24 (exemplar curation), F-11 (SummaryMeta OCC) | Complex; schema + control plane |
| **F — Temporal & STT concurrency/perf** | opus / high | F-13 (assemble reuse, new patch era), F-32 (finalize double-tail), F-19+F-35 (prompt-size & cache observability) | Complex; replay-compat critical |
| **G — Scoped hardening** | sonnet / high | F-22 (NER dedup), F-28 (buffer caps), F-31 (stop-drain protocol), F-34 (provenance re-validation) | Simple/medium with detailed instructions |

Remaining register entries after Wave 2: F-25 (DOC, accepted), F-27 (fixed), plus the
browser-NER half of F-22 (documented owner decision — see Lane G notes).

---

## Lane E — opus / high

**Owns**: `packages/database/src/prisma/db_main/{harness.prisma,consultation.prisma,enums.prisma,audit.prisma}` + one new migration; `packages/domains` (`GateEditExemplar*`, `SummaryMeta*`, `ResourceType` enum if needed) + generators (`db:generate`, `gen:model`, `gen:entity`, `gen:factory`; NEVER `gen:mapper`/`gen:repository`); `packages/applications`: `prompt-assembly.service.ts`, `harness-internal.service.ts`, the gate-edit-exemplar service/retriever + its admin controller (locate under services + `apps/api` HarnessAdminModule), `settings-registry` descriptors/registry; associated tests.

### E-1 · F-18 — Revisit carry-forward (safe, provenance-tagged, default OFF)

Design decisions (fixed — do not re-litigate):
- **Gate**: new settings-registry knob `agentic.revisit.carryForwardEnabled` (boolean,
  **default false**), registered following the existing agentic-context descriptor pattern
  and resolved in `harness-internal.service.ts` via the same effective-settings facade the
  live lane uses. Default-off = zero behavior change until an admin opts in.
- **Producer**: in `HarnessInternalService.assemble()` gathering, when the consultation has
  `parentConsultationId` AND the knob is on: load the parent consultation (direct repository
  fetch + tenant assert — 404-over-403 on mismatch), pick its most authoritative summary
  ContextItem (`SIGNED_NOTE` > `MODIFIED_SUMMARY` > `RAW_SUMMARY`, latest first), decrypt,
  cap at 15,000 chars with an explicit `…[prior visit summary truncated]` marker.
- **Injection**: new `PromptAssemblyParams.priorVisitSummary`; prompt-assembly appends a
  `<<<EXTERNAL_DATA section="prior_visit_summary">>>` block containing a fixed
  NON-AUTHORITATIVE preamble: prior-visit content is reference only, must be re-confirmed
  against the current transcript before any fact is restated, and carried content must never
  populate exam/medication statements without current-visit evidence (SOTA §4.5). Also
  expose it as a `{prior_visit_summary}` template variable (same consumed-variable
  convention as the other blocks).
- **Cleanup**: REMOVE the dead `sameDayPrequelSummary` param + `same_day_prequel_summary`
  variable (zero producers, superseded by this feature). Grep to confirm nothing else
  references them.
- TDD: knob-off ⇒ byte-identical prompt (regression lock); knob-on + revisit ⇒ block present
  with preamble + truncation cap; knob-on + new-visit ⇒ absent; cross-tenant parent ⇒ 404.

### E-2 · F-24 — GateEditExemplar curation gate

- **Schema**: enum `ExemplarCurationStatus { PENDING, APPROVED, REJECTED }` in
  `enums.prisma`; `curationStatus` field on `GateEditExemplar` default `PENDING` + index
  `(tenantId, curationStatus)`. Migration additive (existing rows ⇒ PENDING).
- **Knob**: `agentic.fewshot.curationMode` = `'off' | 'enforce'`, **default `'off'`**
  (current behavior: all exemplars eligible). `'enforce'` ⇒ retriever returns only
  `APPROVED`. Registered as a settings descriptor like E-1's.
- **Admin write**: a curation endpoint on the existing gate-edit-exemplars admin controller
  (`PATCH .../:id/curation` with body `{status}`), following that controller's existing
  decorator/OCC conventions (GateEditExemplar carries `_version` — use the versioned-update
  house pattern if the controller already does; otherwise plain update is acceptable for
  this ops table, matching its existing write style). Sys-event: CHECK whether
  `GateEditExemplar` is in the `ResourceType` enum first — if it is not, add it to BOTH
  `audit.prisma` (`ALTER TYPE ... ADD VALUE` in the migration) and
  `packages/domains/src/enums/generated/ResourceType.ts` (the TASK-366 failure mode;
  `resourceType.enum-parity.test.ts` is the guard) — or, if that enum surgery proves
  disruptive, log-only (no broadcast) and say so in the report.
- TDD: retriever `off` mode unchanged (regression lock); `enforce` filters to APPROVED;
  curation endpoint happy-path + cross-tenant 404 + invalid status 400.

### E-3 · F-11 — SummaryMeta OCC

- **Schema**: `version Int @default(1) @map("_version")` on `SummaryMeta` (migration:
  `ADD COLUMN ... NOT NULL DEFAULT 1`).
- **Domain**: surface on the SummaryMeta entity/model; the mapper MUST carry
  `FIELDS_NOT_WRITABLE = ['version']` + strip (OCC-written model now).
- **Service**: the two-phase flow in `harness-internal.service.ts`
  (`persistDraft` EARLY → `finalizeAssurance` backfill) becomes compare-and-set: finalize
  reads the row, then updates via the version-guarded path
  (`updateWithVersion`); on `OptimisticConcurrencyException`, re-read once and retry once
  (the phases are idempotent), else surface the conflict. Keep the existing HTTP
  idempotency layer untouched (defense in depth).
- TDD: concurrent finalize simulation — second CAS with stale version throws; retry path
  covered; existing suites stay green.

**Migration**: ONE hand-authored additive folder `<timestamp>_task_553b_governance_wave2`
(SummaryMeta `_version`, ExemplarCurationStatus enum + column + index, ResourceType ADD
VALUE if needed), applied via psql to dev (5432) AND test (5433) — never `prisma migrate`
against these db-push-managed DBs. Then `db:generate` → `gen:model` → hand-author
entity/mapper edits → `gen:entity`/`gen:factory` clean.

**Gates**: database/domains/applications builds + tests; targeted apps/api controller tests;
generator drift checks clean; psql outputs in report.

---

## Lane F — opus / high

**Owns**: `apps/harness/src/harness/temporal/{workflows.py,activities.py,models.py}`,
`apps/harness/src/harness/temporal/prompt_cache.py` (read; edit only if needed),
`apps/harness/src/harness/core/{config.py,metrics if any}`, harness tests (incl. replay
fixtures), and the STT streaming `session_manager.py` (+its tests). Detect the STT app path
first: it is `apps/stt` per CLAUDE.md but recent work used `apps/stt-v2` — use whichever
exists in the tree and the matching `pnpm py:stt*` aliases.

### F-1 · F-13 — Reuse `assemble` output across regen iterations (NEW PATCH ERA)

The regen loop re-runs the `assemble_prompt` activity every iteration though its output is
iteration-invariant (the regen-feedback suffix is appended later, harness-side, in the
`generate` activity). Skipping the repeat calls REMOVES scheduled commands ⇒ this REQUIRES
`workflow.patched("task-553-assemble-reuse")`:
- Patched branch: call `assemble_prompt` once per run (per pass where a re-assemble is
  genuinely needed — note the redaction re-run and the post-edit re-run paths; ONLY skip
  repeats within the same regen loop where inputs are identical), reuse the stored result.
- Unpatched branch: legacy per-iteration call (replay of old histories).
- Add the era to `test_replay_compat.py` following the existing forward-guard pattern AND
  capture/commit a replay fixture the way the other 10 eras do (mirror the existing fixture
  mechanism exactly). Update the era count note if the suite asserts one.
- VERIFY the invariance claim first (read `assemble_prompt`/`generate` carefully); if any
  regen-varying input flows into assemble, narrow or abandon the reuse and report why.

### F-2 · F-32 — Finalize double-tail guard (STT session manager)

Do NOT restructure the lock. Add a per-session `_tail_flush_started` flag (single-threaded
event-loop test-and-set before the first await) so `_flush_final_utterance` +
`_drain_inference_queue` run at most once per session across the three finalize trigger
sites; subsequent triggers skip straight to `_finalize_session` (which stays lock-serialized
and idempotent). Structured log on the skip path. TDD: simulate two near-simultaneous
finalize triggers → exactly one tail flush; normal single-trigger behavior unchanged.

### F-3 · F-19 + F-35 — Prompt-size & cache observability (no truncation!)

- In the `generate` activity: compute assembled prompt char count + estimated tokens
  (chars/4) and attach to the LLM_CALL trajectory step stats (`prompt_chars`,
  `prompt_tokens_est`) alongside existing stats; emit a structured WARNING
  (`harness.prompt_size_warn`) when chars exceed new setting
  `HARNESS_PROMPT_SIZE_WARN_CHARS` (default 400000 ≈ 100k tokens; config.py, HARNESS_
  prefix). Never truncate clinical content — observe only.
- Pass through (do not drop) any cache-related keys the SMR backend returns in generation
  stats (e.g. `cached_tokens`, `prompt_cache_hit*`) so cache-hit rate becomes visible in
  trajectory rollups; check the stats passthrough path and widen only if it filters keys.
- TDD: stats fields present on the trajectory step; warn fires above threshold, silent below.

**Gates**: `pnpm py:harness:test` (replay suite incl. the NEW era fixture) + lint; STT unit
tests + lint. All workflow edits outside F-1 must remain command-sequence-neutral.

---

## Lane G — sonnet / high

**Owns**: `packages/applications/src/services/consultation/events/consultation-event.handler.ts`
(+tests), `packages/applications/src/services/consultation/live-documentation/live-documentation.service.ts`
(+tests; NUL-byte gotcha ~line 1424 — use `/usr/bin/grep -a`, not rg),
`packages/applications/src/services/consultation/context/context.service.ts` (+tests), the
STT python `session.py` (+tests; same app-path detection note as Lane F), and
`packages/agentic-sdk-v2/src/core/` STT client/provider files for the stop-drain change
(+tests). Do NOT touch `session_manager.py` (Lane F owns it) or any Lane E file.

### G-1 · F-22 — Server-side NER dedup

In `handleSummaryGenerated`: when the resolved `pipelineConfig.harnessEnabled` is true,
SKIP `createNerJob` (the harness workflow persists its own `NamedEntity` rows for the same
content) with a structured info log naming the skip reason. TDD: harnessEnabled true ⇒ no
NER job queued; false/undefined ⇒ unchanged (regression lock). The browser-side NER path
(SDK `location:'browser'` default, results never persisted) is explicitly OUT of scope —
record it in your report as the remaining owner decision.

### G-2 · F-28 — Defensive buffer caps

- Python `StreamSession.results` (session.py): WARN once when finals exceed 10,000; refuse
  append beyond 50,000 with an ERROR log (pathological session; durable-transcript
  correctness preserved up to the cap). Constants module-level, commented.
- `LiveSession.transcriptParts` (live-documentation.service.ts): same two-tier pattern
  (warn 10k parts, hard-cap 50k with error log); confirm the windowing/flush logic is
  unaffected below the cap. TDD both.

### G-3 · F-31 — Stop-drain: don't close the WS under the tail final

Find the SDK stop path (exploration: the browser provider closes the WS immediately on
stop, so a tail final arriving after close misses the live-caption UI). Change: on stop,
send the finalize control frame, keep the socket open until the server's terminal status
(`closed`/`cancelled`) arrives OR a 5s drain timeout elapses, delivering any tail finals to
the normal callbacks, THEN close. Reconnect logic must not fire during an intentional
drain-close. TDD with the existing mock-socket test harness: tail final delivered before
close; timeout path closes anyway; no reconnect attempt on intentional stop.

### G-4 · F-34 — Provenance-id tenant re-validation on read

Explore first: find every reader that dereferences `SummaryMeta.caseNoteIds` /
`preSummaryIds` / `previousSummaryIds` (chain/summary assembly in context.service and any
sibling). Where the ids are dereferenced into content, re-validate tenant scope with ONE
batched `findAll({ id: { in } })` + in-tenant check (the write-side pattern at
`context.service.ts` `addRawSummary` is the reference), dropping (and warning on) any id
that fails instead of throwing — reads should degrade, not 500. TDD: a poisoned foreign-id
in the arrays is excluded from assembled output.

**Gates**: applications tests (events, live-documentation, context suites), vox targeted
tests, STT python unit tests + lint.

---

## Verification & automation strategy (all lanes)

1. Every fix lands with unit/integration tests written TDD (RED evidence noted in reports).
2. Cross-cutting final pass (orchestrator): full `@arcaai/applications` suite, domains +
   database suites, `py:harness` (replay incl. new era) + STT python suite, builds, lint.
3. Post-wave, a `validation-plan.md` records the recommended standing automation
   (CI-blocking eval gate, e2e governance spec, live checks) and the owner's manual
   validation checklist.
