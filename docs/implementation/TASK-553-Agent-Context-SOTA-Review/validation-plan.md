# TASK-553 — Validation Plan

Written 2026-07-25 at Wave-2 close. Three parts: (1) what is already automated by this
ticket, (2) recommended standing automation to add (best practice, each with rationale),
(3) the owner's manual validation checklist for the extra pass.

## 1. Automation already in place (this ticket)

Every fix landed with TDD unit/integration tests; the load-bearing ones that act as
**standing regression locks**:

| Lock | Test | Guards against |
|---|---|---|
| Pinned-version serving | `prompt-assembly.service.test.ts` integration cases (pin v3 + edit v5 ⇒ v3 served) | F-01 recurrence — resolution/assembly composition drift |
| Eval-gate integrity | resolution/management tests: APPROVED-template content edit not served until re-approval | F-02 recurrence |
| Carry-forward safety | `prompt-assembly.prior-visit.test.ts` + `harness-internal.governance-wave2.test.ts` (knob-off byte-identical; deleted-parent null vs cross-tenant 404; truncation) | F-18 regressions |
| Curation gate | `gate-edit-mining.curation.test.ts` (`off` unchanged, `enforce` filters APPROVED) | F-24 regressions |
| SummaryMeta CAS | governance-wave2 tests (stale-version conflict + single retry) | F-11 races |
| Replay compatibility | `test_replay_compat.py` — **13 tests / 11 eras** incl. the new `task-553-assemble-reuse` fixture | Any workflow command-sequence drift |
| Double-tail latch | `test_session_manager_tail_flush_guard.py` (two simultaneous finalizes ⇒ one flush) | F-32 |
| Audio-loss backpressure | steady-state enqueue drop test + `STREAMING_INFERENCE_QUEUE_DROPPED_TOTAL` metric | F-08 |
| SSE co-viewer survival + no-missed-events | live-documentation SSE tests (refcount + ReplaySubject window) | F-04/F-05 |
| Resume honesty | stt-ws.gateway tests (`resume_failed` on phantom sessions) + SDK terminal-reason tests | F-06 |
| Reconnect chain | SttWebSocketClient tests (failed-open re-arm; drain-close no-reconnect; tail-final-before-close) | F-07/F-31 |
| Provenance scrub | context.service tests (foreign id dropped with warn, no 500) | F-34 |
| Injection surface | DTO `@MaxLength` validation tests + attachment truncation tests + spotlighting assertions | F-03 |

CI already re-runs all of these via the existing jobs (`test-api`, `test-packages`,
`test-sdk`, `test-harness`, `test-stt`) plus the generator drift gates.

## 2. Recommended standing automation (not yet done — owner decisions)

1. **Make the harness eval job blocking.** `.gitlab/ci/test.yml` runs `harness.eval.ci`
   with `allow_failure: true` (~line 525) — the SOTA baseline (sota-research §1.5) is that
   eval regressions BLOCK. Once the golden sets are trusted, flip `allow_failure: false`.
   Left to the owner because it can start failing pipelines on judge-model variance.
2. **Governance e2e spec.** Add `apps/api/tests/e2e/task-553-prompt-governance.spec.ts`
   (Playwright, real HTTP): create template → approve → bind agent → pin v1 → edit content
   → assert `assemble`-served version unchanged → re-approve → assert new version served →
   failing golden set blocks approve with 409 `EVAL_GATE_FAILED`. This is the one place
   unit tests can't see a wiring regression across modules. (Needs `pnpm test:api:up`.)
3. **PDQI-9-style scoring rubric on the golden sets** (sota-research §4.3): adopt the
   modified 11-item PDQI-9 + binary hallucination + template-conformance +
   provenance-coverage as the eval metrics, so promotion gating measures clinically
   validated dimensions rather than ad-hoc scores.
4. **Clinician-edit feedback loop** (sota-research §4.4): the `GateEditExemplar` corpus now
   has a curation gate; the next step is dashboarding edit-distance per template version so
   a template promotion that increases clinician edit burden is visible within days.
5. **Prompt-cache hit-rate metric** (sota-research §2.6): normalize backend cache counters
   (`cached_tokens`, `prompt_tokens_details.cached_tokens`, llama.cpp `tokens_cached`) into
   `apps/smr` `GenerationStats` — the harness→trajectory path is proven lossless, so the
   moment SMR emits them they appear in trajectory rollups. Then alert on hit-rate drops
   (a silent full-cache-miss regression is a cost/latency multiplier).
6. **Prompt-size alerting**: `harness.prompt_size_warn` now fires above
   `HARNESS_PROMPT_SIZE_WARN_CHARS` (400k chars) — route it to a Grafana/alert rule; a
   rising trend is the trigger to revisit compaction (F-19's long-term answer).
7. **Two-viewer SSE e2e**: a Playwright spec opening the same consultation's live-summary
   stream in two contexts and disconnecting one would lock F-04 at the HTTP layer.

## 3. Owner manual validation checklist (live stack)

Bring up the dev stack (`pnpm dev:stack`), then:

1. **Pinned-version proof (F-01/F-02)**: pin a department agent to an older template
   version, edit the template content (stay APPROVED), run a consultation → the harness
   trajectory / `SummaryMeta.resolvedPromptId`+`promptVersion` must name the PINNED
   version; approve the template → next run serves the new version. Also verify the 409
   `EVAL_GATE_FAILED` path with a failing golden set.
2. **Carry-forward flip (F-18)**: set `agentic.revisit.carryForwardEnabled=true` (settings
   registry), run a re-visit consultation (child of a prior one) → assembled prompt carries
   the `prior_visit_summary` EXTERNAL_DATA block; knob off → block absent.
3. **Curation enforce (F-24)**: approve one exemplar via
   `PATCH admin/harness/gate-edit-exemplars/:id/curation`, set
   `agentic.fewshot.curationMode=enforce` → few-shot block contains only approved
   exemplars.
4. **CAS observation (F-11)**: force a concurrent finalize (re-run the finalize activity)
   and observe the `SummaryMeta assurance backfill lost a compare-and-set` retry log.
5. **Two-tab SSE (F-04/F-05)**: open the live summary in two tabs, close one → the other
   keeps streaming; refresh mid-stream → no missed terminal event.
6. **STT reconnect honesty (F-06/F-07)**: kill the network >15 s mid-dictation → client
   must surface reconnect failure / start a fresh session — never a silent dead mic.
7. **Stop-drain (F-31)**: stop dictation immediately after speaking → the last utterance
   still appears in live captions before the socket closes.
8. **NER dedup (F-22)**: with `harnessEnabled` on a consultation, confirm exactly one NER
   pass persists (no duplicate BullMQ job) via logs/NamedEntity rows.
9. **Auth-degrade loudness (F-23)**: unset `HARNESS_SERVICE_TOKEN` on the worker →
   `harness.policy_auth_failed` appears in logs (not a silent `reduced_assurance`).
10. **Replay safety (F-13)**: with in-flight consultations, deploy the new worker →
    running workflows complete without non-determinism errors (the 13-fixture replay suite
    predicts this, but the live check is the final word).

## Residual open threads (small, non-blocking)

- Browser-side NER coordination (F-22 half) — nothing persisted, but no coordination
  signal exists; owner decision.
- Curation-queue admin UI (F-24 polish) — the API surface exists; console screen is a
  design-gated follow-up.
- SMR `GenerationStats` cache normalization (F-35 upstream half) — item 2.5 above.
- `HARNESS_PROMPT_SIZE_WARN_CHARS` intentionally not registered in `turbo.json#globalEnv`
  / `.env.example` (matches precedent for harness-only knobs with safe defaults).
