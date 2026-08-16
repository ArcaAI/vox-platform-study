# TASK-710 — Working PHI Redactor (Guardrail Redact Endpoint + `IPhiRedactor` Implementation)

| | |
|---|---|
| **Status** | Completed — Tasks 1–5 done and green; Task 0's Decision #12 (pseudonymization mechanism) confirmed against `apps/nlp`'s actual entity-linking behavior and finalized 2026-08-16; Task 6 backed by a real, measured GLiNER benchmark, and the timeout/memory risk it flagged now FIXED by server-side chunking (§7 "Task 6 follow-up", 2026-08-16) |
| **Wave** | 1 · **Size** | L |
| **Epic slug** | `phi-redactor` |
| **Depends on** | TASK-706 (`egress-failclose`) |
| **Design refs** | Not a D1–D8 fork (Plane 2 remediation). Governed by the explicit spec correction in `docs/architecture/consultation-session-workflow/assessment/04-target-architecture.md` §"Spec red-team of dataset.xml" #1 and restated in `docs/architecture/agentic-workflow-platform/design.md` under Plane 2 / Wave 1: **identifier pseudonymization before NLP** (preserve the clinical terms NER exists to extract), **full redaction only for retained / derived / cross-patient artifacts**. |
| **Findings closed** | A-02 (`02-conformance-matrix.md`, CRITICAL); un-blocks the exemplar-mining fail-closed-to-nothing state documented in `03-compliance-posture.md` "What is genuinely sound" #4 and F-07's minimal fix in `03-compliance-posture.md`. Structural precondition for TASK-700 (`dna-phi-containment`) but does not duplicate it — see §1 Out of Scope. |

## 1. Requirement Analysis

**No working PHI redactor exists anywhere in this codebase.** `IPhiRedactor` (`packages/applications/src/services/gate-edit-mining/IPhiRedactor.ts:1-21`) is a well-designed, fail-closed TypeScript port — `redact(text: string): Promise<string>`, documented as: *"Throwing, returning empty, or returning the input unchanged all cause the candidate to be dropped"* — but it has **zero implementations and zero DI providers anywhere in the repository** (verified: repo-wide grep for `implements IPhiRedactor` → 0 hits; grep for `provide:\s*IPhiRedactor` → 0 hits; only 5 files reference the symbol at all, all inside `gate-edit-mining/`). Its sole current consumer, `GateEditMiningService`, is fail-closed by design (`gate-edit-mining.service.ts:172-182`, `:408-418`) — the absence of a redactor means the `GateEditExemplar` corpus mines nothing, which is the safe failure mode but leaves the feature permanently inert.

Separately, guardrail already runs GLiNER over every analyzed text and extracts PII entities with per-entity confidence scores (`apps/guardrail/src/guardrail/providers/gliner.py:175-181`), then **discards them** — `GuardrailResponse` (`apps/guardrail/src/guardrail/api/endpoints/guardrails.py:36-45`) has no `sanitized_text`/`entities`/`spans` field, only `{safe, issues, confidence, ...}`. The redactor this ticket builds is therefore mostly wiring: surface the entity spans GLiNER already computes, add a masking/pseudonymization function, and implement the TS-side port against the new endpoint.

This ticket delivers:
1. A guardrail `POST /api/guardrail/redact` endpoint (two modes: `pseudonymize`, `full`), behind the existing `X-Service-Token` middleware.
2. A TypeScript `GuardrailPhiRedactor implements IPhiRedactor` with a DI provider registered — which simultaneously un-blocks `GateEditMiningService`'s exemplar mining as a side effect, without this ticket touching that service's own logic.
3. Wiring at exactly two hops, per the design constraint: (a) finalized transcript → NLP (`ner.processor.ts`, currently posts raw content), and (b) the DNA-corpus hop (coordinates with, but does not duplicate, TASK-700's scope — see below).
4. A short T4 mode-selection design task (Task 0 below) deciding which artifact classes get `pseudonymize` vs. `full`, since the interface as it exists today (`redact(text: string): Promise<string>`) has no mode parameter at all and must be extended.

**Explicitly out of scope:**
- **The primary summarization prompt.** Per the design correction, redacting the transcript before summarization would remove the patient facts the note must contain. This ticket does not add a redaction hop before `SummaryService`/`summary.processor.ts`'s SMR call.
- **TASK-700's `dna-phi-containment` fixes** (the DNA prompt's missing `json_schema`, the `textSamples` opt-out bypass, the decrypt-and-scan of `DnaWritingStyleReport.styleText`) — those are TASK-700's scope. This ticket only ensures the DNA corpus is *redacted before it reaches SMR*; it does not touch the prompt-config, the opt-out gate ordering, or the historical-data question. State the dependency explicitly: TASK-700 and this ticket both touch `dna-writing-style.processor.ts`, and should not be executed concurrently without coordinating the diff.
- **The cloud-LLM-egress redactor** (`apps/harness/src/harness/guards/phi/redactor.py`, Presidio-based, scoped to `cloud_egress_providers`) — that already exists and is TASK-706's scope to fix the fail-open allowlist. This ticket does not modify it; the new guardrail redactor is a separate implementation living in a different process/language boundary (guardrail, not harness) and serving different hops.
- Extending redaction to every context-item kind or building a general "PHI classifier" — only the three named hops.

## 2. Current State Evaluation

Re-verified against the live tree on `feat/loop` (2026-08-16).

**`IPhiRedactor` — the port, unimplemented:**
```ts
// packages/applications/src/services/gate-edit-mining/IPhiRedactor.ts:12-20
export interface IPhiRedactor {
  redact(text: string): Promise<string>;
}
export const IPhiRedactor = Symbol('IPhiRedactor');
```
`gate-edit-mining.service.module.ts:8-13` documents the omission explicitly: *"Note what is NOT provided here: `IPhiRedactor`. The redactor is supplied by the host that owns the guardrail client, and its absence is FAIL-CLOSED by design."* `GateEditMiningService` constructor: `@Optional() @Inject(IPhiRedactor) private readonly phiRedactor?: IPhiRedactor` (:134). `redactOrNull` (:408-418) returns `null` immediately if `!this.phiRedactor` (:409), and separately treats a no-op redaction (`redacted === text`) as a failure via a direct-identifier heuristic (`looksLikeDirectIdentifier`, :447-449).

**Guardrail already extracts what this ticket needs — and throws it away:**
```python
# apps/guardrail/src/guardrail/providers/gliner.py:175-181
if run_pii:
    entities = self.runtime.extract_entities(text, PII_LABELS)
    pii = [e for e in (entities or []) if e.score >= self.config.pii_threshold]
    if pii:
        safe = False
        issues.append("pii_detected")
        confidence_scores.append(max(e.score for e in pii))
```
`PII_LABELS` (gliner.py:23-38): person, first_name, last_name, email, phone, address, city, country, card_number, bank_account, crypto_wallet, passport, national_id, date_of_birth. `_sync_analyze` (:128-191) returns only `{safe, issues, confidence}` (:187-191) — the actual `entities` objects (each carrying offsets/label/score per the `extract_entities` contract) never leave the function.

`GuardrailResponse` (`apps/guardrail/src/guardrail/api/endpoints/guardrails.py:36-45`):
```python
class GuardrailResponse(BaseModel):
    safe: bool
    issues: list[str] = Field(default_factory=list)
    confidence: float
    processing_time_ms: float
    request_id: str
    timestamp: str
    error: str | None = None
```
No `sanitized_text`, `entities`, or `spans` field.

**Endpoint mounting convention (a real drift catch — do not copy the assessment's path literally).** `apps/guardrail/src/guardrail/main.py` mounts `guardrails_router` at `prefix="/api"` (not `/api/v1`) — confirmed: `app.include_router(guardrails_router, prefix="/api", tags=["guardrails"])`. The existing sibling endpoints are therefore `POST /api/guardrail/analyze` (`guardrails.py:59`) and `POST /api/guardrail/ground` (`apps/guardrail/src/guardrail/api/endpoints/groundedness.py:90`) — **not** under `/api/v1/`. `docs/architecture/consultation-session-workflow/assessment/04-target-architecture.md` §6 describes the new route as `POST /api/v1/guardrail/redact`; that is imprecise against the live mounting convention. This ticket's new route is **`POST /api/guardrail/redact`**, matching its two existing siblings exactly.

**Best structural exemplar for the new endpoint is `groundedness.py`, not `guardrails.py`.** `apps/guardrail/src/guardrail/api/endpoints/groundedness.py` (`POST /guardrail/ground`, router :90-161) already returns character-offset spans (`GroundednessSegmentModel.start/end` :50-51, `FlaggedSpanModel.start/end` :57-58) and documents its own fail-closed posture (:8-11: *"Sits behind the `X-Service-Token` middleware exactly like `/guardrail/analyze`"*). `guardrails.py`'s `/analyze` is fail-**open** on error (`safe=True` on failure, :97-108) — the wrong posture to copy for a redactor, where a failed call must drop the candidate, not silently pass raw text through. Auth for both is global middleware, not per-route: `apps/guardrail/src/guardrail/api/middleware/auth.py`, `ServiceAuthMiddleware` (:42), validates `X-Service-Token` via `hmac.compare_digest` (:55) against `app.state.settings.service_token`; empty token bypasses (dev/CI, :48); `EXEMPT_PATHS` (:24-39) covers only health/metrics/docs.

**Idiomatic entity-shape precedent — `{start, end, label/entity_type, score/confidence}` is used in at least three places already**, supporting using the same shape in the redact response: `apps/nlp/src/nlp/schemas/common.py:13-15` (`TextPosition{start, end}`, embedded in `Entity` at :33-48); the harness's own `RedactedEntity` (`apps/harness/src/harness/guards/phi/redactor.py:63-71`, flat `entity_type, start, end, score`); guardrail's own `groundedness.py` `FlaggedSpanModel`/`GroundednessSegmentModel` (:40-58, `start`/`end` character offsets).

**Hop 1 — STT-finalized transcript → NLP, unredacted (the default-path hole, A-02):**
```ts
// packages/applications/src/services/consultation/jobs/processors/ner.processor.ts:218-227
const response = await this.httpService.axiosRef.post(
  `${this.nlpServiceUrl}/api/v1/classify/tokens`,
  { text: content, ...modelSelection },
  { timeout: 60000 },
);
```
`content` is `contextItem.content`, passed in raw at :99 (`this.callNlpService(contextItem.content)`).

**Hop 2 — approved notes → DNA corpus, unredacted:**
`packages/applications/src/services/dna-writing-style/dna-writing-style.processor.ts` — `buildCorpus` (static method, :305-313), invoked at :174; `callSmr` (:315-351), POST to `${smrServiceUrl}/api/v1/generate` at :332-348, invoked at :189. Confirmed: **zero redaction calls** anywhere between `buildCorpus`'s output and the SMR POST body — only a length truncation (`samples.substring(0, maxContextChars)`, :177-179), no PHI scrubbing. Note this hop's `textSamples` bypass branch (:105-111, gate-skip comment :116-117) is TASK-700's territory, not this ticket's — this ticket only inserts the redaction call on the corpus-building path regardless of which branch produced `samples`.

**DI pattern to follow.** `packages/applications/src/services/crypto/crypto.service.module.ts:7-17` — `providers: [{ provide: ICryptoService, useClass: CryptoService }], exports: [ICryptoService]` — confirmed as the idiomatic narrow-port binding style (this exact `provide: I<Name>` shape recurs in ~90 modules across `packages/applications/src/services/**`, e.g. `ITenantService`, `IAuditLogService`, `IEntitlementsService`).

## 3. Knowledge & Best Practices

- `.claude/rules/06-python-services.md` §Gateway Integration & Auth: inbound auth is `X-Service-Token` shared-secret middleware, constant-time compare, empty-token dev bypass, health/docs/metrics exempt — the new endpoint inherits this for free by living in `apps/guardrail/src/guardrail/api/endpoints/`, no per-route auth code needed.
- `.claude/rules/06-python-services.md` §Configuration: fail-closed for provider/model selection is the platform's own stated policy split (`SettingDescriptor.failMode`) — apply the same posture here: an unreachable or errored redact call must cause the caller (`ner.processor.ts`, `dna-writing-style.processor.ts`) to **drop or abort**, mirroring `GateEditMiningService`'s existing fail-closed pattern, never to fall through to unredacted text.
- `.claude/rules/04-application-services.md` §NEVER: don't import `@arcaai/database` runtime code from the new TS redactor implementation; it is a pure HTTP client over the guardrail service, structurally identical to other `services/**` HTTP-client wrappers.
- `01-development-workflow.md` §TDD Requirements: golden redaction fixtures (input text with known PII spans → expected masked/pseudonymized output) must exist and fail red before the endpoint is implemented.
- Pitfall (from `04-target-architecture.md` §6, restated): **the primary summarization prompt is explicitly NOT a redaction hop** — building this wrong (redacting before summarization) would be a regression that breaks note quality, not a fix. The two hops in this ticket are deliberately narrow.
- Pitfall: `IPhiRedactor.redact(text: string): Promise<string>` today has **no mode parameter** — extending the interface signature is a breaking change for `GateEditMiningService`'s existing (if currently no-op) usage. Task 1 below must decide and document the new signature before any implementation lands, and `GateEditMiningService`'s call site must be updated in the same PR so the interface and its one existing consumer never drift apart.
- Pitfall: guardrail's `/analyze` endpoint fails **open**; the new `/redact` endpoint must fail **closed** (error/timeout → no `sanitized_text`, HTTP-level error, not a `200` with the input echoed back) — do not copy `/analyze`'s error-handling pattern.

## 4. Implementation Plan

### Task 0 — Mode-selection policy design (per-artifact-class pseudonymize vs. full)
- **Agent:** T4 · opus-4-8 · medium
- **Files:** none (design note — append findings to this README's §7 before Task 1 starts, or spin into a short design doc referenced from here)
- **Approach:** Enumerate every artifact class this ticket and its near-term siblings touch (STT-finalized transcript → NLP; DNA corpus; cloud-LLM egress — already `full`, TASK-706; gate-edit exemplar bank — already `full` by `GateEditMiningService`'s existing design) and assign each a mode per the design constraint: `pseudonymize` where the consuming pipeline needs clinical entities (NLP/NER), `full` where the artifact is retained, derived, or crosses patients (DNA corpus, exemplar bank, egress). Decide the concrete pseudonymization mechanism (e.g. GLiNER label → stable per-session token substitution, such as `[PERSON_1]`/`[DATE_1]`, versus outright masking) — this determines whether NER downstream can still extract medication/condition entities correctly (spot-check against `apps/nlp/src/nlp/services/ontology_linker.py`'s ~40-term dictionary inputs).
- **Verify:** Decision recorded in §7 with rationale; unblocks Task 2's endpoint contract.

### Task 1 — Failing tests: golden redaction fixtures
- **Agent:** T2 · sonnet-5 · medium
- **Files:** `apps/guardrail/src/guardrail/tests/test_redact_endpoint.py` (new), fixture data alongside
- **Approach:** Build fixture pairs — input text containing names/MRN-like strings/dates/phone numbers interleaved with medication and condition names — with expected span offsets and expected `pseudonymize`/`full` outputs. Assert `pseudonymize` mode preserves the medication/condition tokens verbatim while masking identifiers; `full` mode masks everything GLiNER flags above `pii_threshold`.
- **Verify:** `pnpm guardrail:test -- test_redact_endpoint` — fails red (endpoint doesn't exist yet).

### Task 2 — `POST /api/guardrail/redact` endpoint
- **Agent:** T3 · sonnet-5 · medium
- **Files:** `apps/guardrail/src/guardrail/api/endpoints/redact.py` (new), `apps/guardrail/src/guardrail/main.py` (router registration)
- **Approach:** New `APIRouter`, structured like `groundedness.py` (fail-closed posture, offset-based response model) rather than `guardrails.py` (fail-open). Request: `{text: str, mode: Literal['pseudonymize', 'full']}`. Response: `{sanitized_text: str, entities: list[{label: str, start: int, end: int, score: float}]}`. Implementation calls the existing GLiNER runtime's `extract_entities(text, PII_LABELS)` (same call `gliner.py:176` already makes) and applies the Task 0 masking/pseudonymization function per mode — do not duplicate the PII-detection logic between `/analyze` and `/redact`; extract a shared helper if `gliner.py`'s `extract_entities` call needs to be reused across both endpoint modules. Register `app.include_router(redact_router, prefix="/api", tags=["guardrails"])` in `main.py` alongside the existing `guardrails_router` line.
- **Verify:** `pnpm guardrail:test -- test_redact_endpoint` green. `pnpm guardrail:lint`, `pnpm guardrail:typecheck` clean.

### Task 3 — `GuardrailPhiRedactor implements IPhiRedactor` + DI registration
- **Agent:** T2 · sonnet-5 · medium
- **Files:** `packages/applications/src/services/gate-edit-mining/IPhiRedactor.ts` (signature extension for mode), `packages/applications/src/services/phi-redaction/guardrail-phi-redactor.service.ts` (new — new folder per `04-application-services.md` §Service Folder Pattern), `packages/applications/src/services/phi-redaction/phi-redaction.service.module.ts` (new), `packages/applications/src/services/gate-edit-mining/gate-edit-mining.service.module.ts` (wire the new provider in place of the current omission)
- **Approach:** Extend `IPhiRedactor.redact(text: string, mode: 'pseudonymize' | 'full'): Promise<string>` (breaking change — update `GateEditMiningService`'s one call site in the same PR to pass `'full'`, preserving its current behavior exactly). Implement `GuardrailPhiRedactor` as an `HttpService`-based client POSTing to `${guardrailServiceUrl}/api/guardrail/redact` with `X-Service-Token` from `SecretsService`, following the `crypto.service.module.ts:7-17` DI shape (`{ provide: IPhiRedactor, useClass: GuardrailPhiRedactor }`). On any HTTP error, timeout, or a response whose `sanitized_text === text` for input that looks like it contains a direct identifier, throw (never return the input unchanged) — `GateEditMiningService`'s existing `redactOrNull` already treats a thrown/no-op redaction as "drop the candidate," so implementing this correctly here automatically un-blocks exemplar mining without touching `gate-edit-mining.service.ts`'s logic.
- **Verify:** `pnpm --filter @arcaai/applications test` — new unit tests for `GuardrailPhiRedactor` (mock `HttpService`, assert correct request shape, assert throw-on-unchanged behavior) plus a re-run of `gate-edit-mining.service.ts`'s existing tests confirming exemplar mining now succeeds when the new provider is wired (previously asserted "mines nothing" with no provider — that assertion should now cover the "provider present, redaction succeeds" branch as an added case, not a removed one).

### Task 4 — Wire Hop 1: STT-finalized transcript → NLP
- **Agent:** T2 · sonnet-5 · medium
- **Files:** `packages/applications/src/services/consultation/jobs/processors/ner.processor.ts`
- **Approach:** Inject `IPhiRedactor`. Before the POST at :218-227, call `await this.phiRedactor.redact(content, 'pseudonymize')` and post the pseudonymized text instead of raw `contextItem.content`. Fail-closed: if `redact` throws, do not silently fall back to raw content — either abort the NER job (mirroring `SummaryService.callSmrService`'s throw-don't-substitute pattern) or mark the job degraded per the existing job-failure conventions in this processor; do not invent a third failure semantics.
- **Verify:** Integration test on `ner.processor.ts` asserting the NLP call receives pseudonymized text (no raw name/MRN token reaches the mocked NLP client) while medication/condition tokens in the fixture survive unchanged. `pnpm --filter @arcaai/applications test`.

### Task 5 — Wire Hop 2: DNA corpus → SMR
- **Agent:** T2 · sonnet-5 · medium
- **Files:** `packages/applications/src/services/dna-writing-style/dna-writing-style.processor.ts`
- **Approach:** Inject `IPhiRedactor`. Between `buildCorpus`'s output (:174/:305-313) and `callSmr` (:189), call `await this.phiRedactor.redact(samples, 'full')` — full redaction, per the design constraint, because the DNA profile is a retained, cross-patient artifact. Fail-closed: if `redact` throws, abort the DNA-report job rather than falling back to the unredacted corpus (mirrors the existing DNA opt-out throw at :121-122). **Do not** modify the `textSamples` bypass branch (:105-124) or the opt-out gate ordering — that is TASK-700's diff; keep this change scoped to inserting the redaction call regardless of which branch populated `samples`.
- **Verify:** Integration test asserting `callSmr`'s prompt argument, when built from a corpus containing a fixture name/MRN, contains none of it. `pnpm --filter @arcaai/applications test`.

### Task 6 — Perf note: GLiNER latency budget per hop
- **Agent:** T2 · sonnet-5 · low
- **Files:** none (documentation — append to §7)
- **Approach:** Measure or estimate added latency per hop: Hop 1 runs synchronously inside a BullMQ job before the NER call (acceptable — NER itself is already async/job-based); Hop 2 runs inside a DNA-report generation job (already async, user-facing latency budget is generous). Record the measured/estimated added latency and confirm neither hop sits on a live, user-blocking request path (the live-documentation SSE loop is explicitly NOT a redaction hop per §1 scope, so this ticket does not touch the tightest latency budget in the system).
- **Verify:** Numbers recorded in §7; no regression against existing job timeout budgets (check `ner.processor.ts`'s and the DNA job's existing timeout configuration for headroom).

## 5. Acceptance Criteria

- [x] Task 0's mode-selection decision recorded before implementation starts — mode-per-artifact-class recorded; the pseudonymization MECHANISM (Decision #12) is CONFIRMED, validated against `apps/nlp`'s actual `ontology_linker.py`/`token_classifier.py`/`assertion.py` behavior (§7 Task 0)
- [x] Guardrail redact tests green, including new golden redaction fixtures — verified with `python -m pytest apps/guardrail/src/guardrail/tests` directly (not via `pnpm guardrail:test`'s conda wrapper, which is broken in this environment per this run's constraints); 213/213 pass (§7 Task 1/2)
- [x] Guardrail lint/typecheck clean — verified with `ruff check`, `black --check`, `mypy` directly on changed files (§7 Task 2)
- [x] `pnpm --filter @arcaai/applications test` green, including `GuardrailPhiRedactor` unit tests and the updated `gate-edit-mining` tests — full suite 483 files / 9040 tests passed (§7 "Full regression check")
- [x] `pnpm --filter @arcaai/applications build` green (§7 "Full regression check")
- [x] Integration tests confirm Hop 1 (NLP) receives pseudonymized text with clinical entities intact and identifiers masked (§7 Task 4)
- [x] Integration tests confirm Hop 2 (DNA corpus → SMR) receives fully redacted text (§7 Task 5)
- [x] Both hops are fail-closed: a redactor error aborts the job, never falls through to unredacted content — asserted by tests that force `IPhiRedactor.redact` to throw (§7 Task 4/5)
- [x] `GateEditExemplar` mining test suite shows the corpus mines a non-empty exemplar for a fixture edit pair, confirming the previously-inert path is now un-blocked (without modifying `gate-edit-mining.service.ts`'s own logic) — this was already covered by the pre-existing mock-redactor test suite (`gate-edit-mining.service.test.ts`), re-verified green with the `mode` param now threaded through; production wiring is what actually un-blocks it (§7 Task 3)
- [x] Lint clean across affected `packages/applications` files (targeted `eslint` run, not the repo-root `pnpm lint` aggregate — sibling agents share this tree and the orchestrator runs root aggregates) — 0 errors, 0 new warnings (§7 "Full regression check")
- [x] Actual command output pasted for each of the above (§7)

## 6. Risks & Open Questions

- **HUMAN-GATED (Task 0):** the exact pseudonymization mechanism (stable per-session token substitution vs. category masking) affects downstream NER accuracy and needs a decision informed by `apps/nlp`'s actual entity-linking behavior, not just this ticket's own reasoning — flag for a quick check against `ontology_linker.py`'s dictionary during Task 0. **Answer**: Lets review, suggest best practices to gain high-accuracy and performance. **Resolved 2026-08-16** — stable per-label, per-distinct-value tokens (already implemented) CONFIRMED as the correct mechanism, but on a corrected rationale: see §7 Task 0 for the full analysis against the real `ontology_linker.py` and `token_classifier.py`.
- Extending `IPhiRedactor`'s signature to add a `mode` parameter is a breaking interface change with exactly one existing consumer (`GateEditMiningService`) — low blast radius, but must be updated atomically in Task 3, not left half-migrated. **Answer**: Lets review, suggest best practices. **Resolved** — already done atomically in the same PR (Task 3); the migration pattern (extend the port, update the sole call site in the same diff, never leave a half-migrated signature) matches how every other narrow-port interface in `packages/applications/src/services/**` is evolved in this codebase. No further action.
- TASK-700 (`dna-phi-containment`) and this ticket both edit `dna-writing-style.processor.ts`. Sequencing risk: if TASK-700 lands first, this ticket's Task 5 diff should rebase cleanly (it only touches the corpus→SMR seam, not the `textSamples`/opt-out branch TASK-700 touches) — but this should be confirmed at execution time, not assumed. **Answer**: Lets review, suggest best practices. **Resolved** — TASK-700 landed first (wave-0, commit `62400f55d`/`d21915881`, Status: Completed) and is confirmed on the live tree. Re-read `dna-writing-style.processor.ts` end to end: TASK-700's opt-out gate (`configResolver.resolveEffectiveDnaStyleEnabled`) and the `textSamples` bypass branch sit entirely above Task 5's redaction call, which is the last statement before `callSmr` regardless of which branch populated `samples` — no overlap, no rebase conflict, confirmed by reading the code, not assumed.
- The route correction from `/api/v1/guardrail/redact` (as loosely stated in the architecture doc) to the actually-idiomatic `/api/guardrail/redact` should be flagged back to the design doc if this pattern recurs elsewhere in the program — several other Plane 1/2 tickets may inherit the same imprecision. **Answer**: Lets review, suggest best practices. **Resolved** — grepped `docs/architecture/**` and `docs/implementation/**` for `api/v1/guardrail`: the imprecise path appears in exactly one place, `04-target-architecture.md:196`, already identified and corrected in this ticket's §2. It does not recur in any other design doc or ticket README, so no further flag-back is needed at this time.
- This ticket does not decrypt or scan any existing `DnaWritingStyleReport.styleText` rows for already-leaked PHI — that is TASK-700's decrypt-and-scan, explicitly out of scope here (§1). **Answer**: Lets review, suggest best practices. **Resolved** — confirmed still out of scope; TASK-700's own README (Status: Completed) records that decrypt-and-scan as human-gated and unresolved there too, so this remains a genuine open gap tracked by TASK-700, not silently dropped.

## 7. Implementation Summary

**Executed 2026-08-16 (Wave 1, Tasks 1–5) and finalized 2026-08-16 (this session): Decision #12
resolved against the real `apps/nlp` linking code, and Task 6 backed by a real GLiNER benchmark
now that local infra is up.**

### Task 0 — Mode-selection policy (COMPLETE — Decision #12 CONFIRMED 2026-08-16)

Mode assignment per artifact class (well-specified by the ticket's own design constraint,
not gated):

| Artifact class | Mode | Rationale |
|---|---|---|
| STT-finalized transcript → NLP (hop 1) | `pseudonymize` | NER needs clinical entities (medication/condition names) intact |
| DNA writing-style corpus → SMR (hop 2) | `full` | Retained, cross-patient artifact |
| Gate-edit exemplar bank (`GateEditMiningService`) | `full` | Already blanket-redacted by design pre-ticket; unchanged |
| Cloud-LLM egress (`apps/harness/.../redactor.py`) | `full` | Out of scope — TASK-706's Presidio-based redactor, untouched |

**Decision #12 — CONFIRMED 2026-08-16, validated against the real `apps/nlp` code (not
assumed).** The owner's instruction for this run was explicit: check the mechanism against
`ontology_linker.py`'s *actual* entity-linking behavior rather than accepting the original
"stable tokens preserve coreference for downstream NER" justification at face value. Read all
three files that actually process the pseudonymized text on the NLP side —
`token_classifier.py`, `ontology_linker.py`, `assertion.py` — and the finding is a genuine
correction to that original justification, not a confirmation of it as stated:

1. **`OntologyLinker.link()` (`ontology_linker.py:204-208`) is a stateless per-span dictionary
   lookup — case-folded exact-match against a curated vocabulary, called once per NER-recognized
   span with zero cross-mention state.** It has no coreference machinery at all, so "stable
   tokens preserve coreference for the ontology linker" — the reasoning the implementation
   originally shipped under — does not actually hold for this codebase. The linker cannot
   benefit from token stability because it never looks at more than one span at a time.
2. **That miss is immaterial, though, because of a structural fact that makes the whole
   coreference question moot: GLiNER's `PII_LABELS` (`gliner.py:23-38` — person, first_name,
   last_name, email, phone, address, city, country, card_number, bank_account, crypto_wallet,
   passport, national_id, date_of_birth) never include a clinical entity category.** Medication /
   condition / symptom / lab / procedure spans are therefore **never flagged as PII and never
   masked, in EITHER `pseudonymize` or `full` mode** — `_apply_mask` (`redact.py:96-122`) only
   ever touches GLiNER-flagged spans. Clinical-term preservation for the ontology linker (and
   for `token_classifier.py`'s NER model generally) is a property of the label taxonomy, not of
   which masking mode is chosen. Verified directly: `apps/nlp/src/nlp/tests` fixtures and the
   vocabulary in `ontology_linker.py:94-184` contain zero overlap with `PII_LABELS`.
3. **The real, defensible reason to keep distinct per-entity tokens (`[PERSON_1]`,
   `[PERSON_2]`, `[EMAIL_1]`, ...) for `pseudonymize` instead of collapsing everything to one
   `[REDACTED]` literal is `token_classifier.py`'s transformer NER model itself**
   (`TransformerTokenClassifier.process`, `:110-150`), which re-tags the WHOLE pseudonymized
   document via a HuggingFace `token-classification` pipeline. Collapsing every identifier in a
   document to the identical repeated string `[REDACTED]` `[REDACTED]` `[REDACTED]` is a
   degenerate, low-diversity token pattern rare in the model's training distribution (real
   clinical text never repeats an identical token that many times in a row); distinct
   placeholder tokens keep ordinary token diversity and avoid that specific failure mode. This
   is the standard clinical-NLP de-identification practice (i2b2/n2c2-style consistent
   per-entity surrogate substitution over blanket masking, precisely because downstream NLP
   models are re-run on the de-identified text) — applied here for the right reason after
   verification, not the reason originally assumed.
4. **`NegExAssertionClassifier` (`assertion.py`) is unaffected either way** — its pre-trigger
   lexicon (`_TRIGGERS`, `:37-90`) matches on family-relation and negation words ("father",
   "denies", "history of", ...), never on names/identifiers, so neither masking choice changes
   assertion classification. Checked directly against the trigger list; no regression risk from
   this angle in either mode.

**Net decision: no code change to the mechanism.** The already-implemented stable per-label,
per-distinct-value token scheme (`_apply_mask`'s pseudonymize branch, `redact.py:107-122`) is
the correct choice — but the DOCUMENTED rationale was wrong (it invoked ontology-linker
coreference, which does not exist in this codebase) and has been corrected in both docstrings
(`redact.py`'s module docstring, `IPhiRedactor.ts`) to cite the actual reason: clinical-term
preservation is structural (taxonomy-driven, mode-independent), and token diversity protects
the downstream transformer NER model, not the ontology linker. Decision #12 is now CONFIRMED,
not provisional.

### Task 1 — Failing tests: golden redaction fixtures — DONE

`apps/guardrail/src/guardrail/tests/test_redact_endpoint.py` (new, 8 tests). Confirmed RED
first (route didn't exist → 7/8 failed with 404; the 8th accidentally passed because
`!= 200` is satisfied by 404 too — noted, not a false green, since implementing the route
made all 8 pass for the right reason). Then GREEN after Task 2.

```
$ GUARDRAIL_SERVICE_TOKEN="" python -m pytest src/guardrail/tests/test_redact_endpoint.py -q
........
8 passed in 4.71s
```

### Task 2 — `POST /api/guardrail/redact` endpoint — DONE

- `apps/guardrail/src/guardrail/api/endpoints/redact.py` (new): structured like
  `groundedness.py` (fail-closed), not `guardrails.py` (fail-open). Reuses the SAME
  `pinned_gliner_provider` / `get_gliner_model_id` DB-selected-model seam `/guardrail/analyze`
  uses (`guardrail.safety` selection) — missing selection → 503.
- `apps/guardrail/src/guardrail/providers/gliner.py`: extracted the PII-detection core into a
  shared `_sync_extract_pii` (used by both `_sync_analyze`'s aggregate check and the new public
  `extract_pii_entities`, which offloads to the thread pool and — unlike `analyze_content` —
  RAISES on error/disabled instead of fail-opening), so no logic is duplicated between
  `/analyze` and `/redact`.
- `main.py`: registered the router at `/api/guardrail/redact` (not `/api/v1/...` — matches the
  live mounting convention documented in §2, not the architecture doc's imprecise path).
- Fail posture verified by test: a mid-extraction exception → HTTP 502 (never a 200 echoing
  `text` back); a missing DB model selection → HTTP 503.

```
$ python -m pytest apps/guardrail/src/guardrail/tests -q
213 passed in ~20s
$ python -m ruff check <changed files>          → All checks passed!
$ python -m black --check <changed files>       → (reformatted once, then clean)
$ python -m mypy src/guardrail/api/endpoints/redact.py src/guardrail/providers/gliner.py src/guardrail/main.py
Success: no issues found in 3 source files
```

### Task 3 — `GuardrailPhiRedactor implements IPhiRedactor` + DI — DONE

- `IPhiRedactor.ts`: extended to `redact(text: string, mode: 'pseudonymize' | 'full'): Promise<string>`
  (breaking change, migrated atomically in this PR).
- `gate-edit-mining.service.ts`: its one call site now passes `'full'` — behavior byte-identical
  to before (the exemplar bank was always meant to be blanket-redacted).
- `packages/applications/src/services/phi-redaction/` (new folder, per the service-folder
  pattern): `guardrail-phi-redactor.service.ts` (HTTP client over
  `POST /api/guardrail/redact`, following `GuardrailGroundednessTool`'s exemplar for URL
  (`GUARDRAIL_URL` config key) + token (`GUARDRAIL_SERVICE_TOKEN` via `SecretsService`)
  resolution) and `phi-redaction.service.module.ts` (binds `IPhiRedactor` →
  `GuardrailPhiRedactor`).
- `gate-edit-mining.service.module.ts` now imports `PhiRedactionServiceModule` — this is what
  turns the previously-dormant "mines nothing without a redactor" contract into "mines redacted
  exemplars," as a side effect, without touching `gate-edit-mining.service.ts`'s own logic.
- Barrel exports added (`phi-redaction/index.ts`, `services/index.ts`).

```
$ npx vitest run src/services/phi-redaction/__tests__/guardrail-phi-redactor.service.test.ts
Test Files  1 passed (1) · Tests  7 passed (7)
$ npx vitest run src/services/gate-edit-mining
Test Files  2 passed (2) · Tests  29 passed (29)
```

### Task 4 — Wire Hop 1 (STT-finalized transcript → NLP) — DONE

`ner.processor.ts`: injected `@Optional() @Inject(IPhiRedactor)` (trailing, matching this
file's existing optional-dependency convention); `callNlpService` now posts
`await this.phiRedactor.redact(content, 'pseudonymize')` instead of raw `content` when a
redactor is wired. Fail-closed by propagation: `callNlpService`'s existing try/catch already
turns ANY failure (including a throwing redactor) into a generic thrown Error, which the
outer `process()` catch turns into `notifyFailed` + rethrow — no new failure semantics were
invented, and the NLP call is never reached on a redactor throw (asserted by test).
`ConsultationJobServiceModule` now imports `PhiRedactionServiceModule` so production DI
actually supplies the redactor (this is the real safety guarantee — not a processor-level
"absent ⇒ throw", see the design note below).

**Design note (deviation from a literal reading of "never fall back to raw content"):** when
`phiRedactor` is simply *absent* from DI (not wired), the processor behaves exactly as it did
before this ticket (posts raw content) — it does NOT throw. Making absence itself fail-closed
would have required threading a mandatory dependency through ~14 existing positional test
constructions of `NerProcessor` across 2 test files, well beyond this ticket's scope and
against the "surgical changes" / "touch only your ticket's files" constraints for this run.
The production safety guarantee instead comes from `ConsultationJobServiceModule` always
importing `PhiRedactionServiceModule` (verified above) — the same "optional param, mandatory
module wiring" pattern already used for `secretsService`/`aiTaskDefaultService` in this exact
file. Flagging this explicitly since it is a narrower reading than the ticket's Task 4
wording taken literally.

```
$ npx vitest run src/services/consultation/jobs/__tests__/ner.processor.test.ts
Test Files  1 passed (1) · Tests  51 passed (51)   (3 new: pseudonymize-posted / fail-closed-throw / no-redactor-unchanged)
```

### Task 5 — Wire Hop 2 (DNA corpus → SMR) — DONE

`dna-writing-style.processor.ts`: injected `@Optional() @Inject(IPhiRedactor)` (trailing, after
`promptTemplateRepository`); inserted `samples = await this.phiRedactor.redact(samples, 'full')`
immediately after the existing `maxContextChars` truncation and before `callSmr` — scoped to
exactly the corpus→SMR seam, **not** touching the `textSamples` bypass branch or the opt-out
gate ordering (TASK-700's territory, confirmed untouched by diff). Fail-closed by propagation
into the existing outer try/catch (mirrors the opt-out throw already in this method).
`DnaWritingStyleServiceModule` now imports `PhiRedactionServiceModule` directly (importing
`ConsultationJobServiceModule` alone does NOT transitively re-export `IPhiRedactor`, since
that module's own `exports` array doesn't include it — verified by reading the module, not
assumed). Same "absent ⇒ unchanged prior behavior, module wiring is the real guarantee" design
note as Task 4 applies here too.

```
$ npx vitest run src/services/dna-writing-style/__tests__/dna-writing-style.processor.test.ts
Test Files  1 passed (1) · Tests  41 passed (41)   (3 new: redacted-corpus-posted / fail-closed-throw / no-redactor-unchanged)
```

### Task 6 — Perf note — MEASURED 2026-08-16 (local infra up; real GLiNER benchmark, not an estimate)

Local infra is up this session, and the cached ONNX weights for
`hivetrace/gliner-guard-uniencoder-onnx` were already present
(`~/.cache/huggingface/hub/models--hivetrace--gliner-guard-uniencoder-onnx`), so this section
replaces the prior estimate with an actual benchmark. Method: instantiated the real
`GlinerProvider` (`apps/guardrail/src/guardrail/providers/gliner.py`) directly — the same class
`/api/guardrail/redact` uses — loaded the real ONNX weights, and timed
`_sync_extract_pii()` (the exact function the endpoint calls) over synthetic clinical text built
from repeating a realistic sentence unit containing PII (name/DOB/phone/address/email) and
clinical terms (medication/condition/symptom/procedure), sized to match each hop's real input
range. CPU-only (`CPUExecutionProvider`), Apple Silicon dev machine, 48GB RAM. Script and raw
logs: `/private/tmp/.../scratchpad/bench_gliner_redact.py`, `bench_single.py` (this run's
scratchpad; not committed — throwaway benchmark tooling, not test code).

**Model load** (cold, first call in a fresh process): ~8.5s. This happens once per guardrail
worker process lifetime (lazy-loaded on first use, `GlinerProvider.load()`), not per request —
irrelevant to steady-state latency.

**Hop 1 (transcript → NLP, `pseudonymize`) — representative single-transcript sizes:**

| Input size | Latency (avg of 3 calls) | Entities found |
|---|---|---|
| 500 chars | 134.8 ms (min 88.5, max 179.8) | 15 |
| 2,000 chars | 374.4 ms (min 253.4, max 529.7) | 51 |
| 8,000 chars | 1,032.7 ms (min 988.5, max 1,107.6) | 193 |
| 20,000 chars | 4,115.4 ms (min 4,019.9, max 4,267.4) | 436 |

`ner.processor.ts`'s existing NLP-call timeout is 60,000ms and `GuardrailPhiRedactor`'s HTTP
timeout is a separate, fixed 30,000ms (`guardrail-phi-redactor.service.ts:48`). A finalized
consultation transcript in this system is realistically well under 20,000 characters (a very
long single-session transcript); at that size the redact call (~4.1s) leaves ample headroom
under both budgets. **No regression risk for Hop 1** at realistic transcript sizes.

**Hop 2 (DNA corpus → SMR, `full`) — representative sizes, up to the processor's own default
cap `CONTEXT_DEFAULTS.maxContextChars = 100_000` (`dna-writing-style.processor.ts:35`):**

| Input size | Latency (single isolated call) | Peak RSS (measured, `/usr/bin/time -l`) | Entities found |
|---|---|---|---|
| 10,000 chars | 1,354.6 ms (avg of 2) | — | 236 |
| 20,000 chars | 3,618.6 ms | 5.19 GB | 436 |
| 50,000 chars | 17,508.3 ms | 17.81 GB | 1,010 |

**Genuine finding, not fabricated — flagging as a real risk, not fixing it here (out of this
task's file scope):** latency and memory both grow super-linearly with input size (20k→50k is
2.5× the characters but ~4.8× the time and ~3.4× the peak RSS). A same-process SECOND
consecutive call at 50,000 chars (immediately after the first, in the combined benchmark script)
was killed by the OS with no traceback — consistent with cumulative memory pressure, not a code
bug in this ticket's diff. Extrapolating the measured 20k→50k growth curve, a call at the
processor's own **default** `maxContextChars` of 100,000 chars would plausibly need
30-45+ seconds and 30-45+ GB of peak memory — which **exceeds `GuardrailPhiRedactor`'s fixed
30,000ms HTTP timeout** (the redact call itself would time out and abort the DNA job under this
ticket's own fail-closed design) and would very likely exceed a production worker container's
memory limit. **This was not attempted directly at 100,000 chars** — extrapolating from the
measured 20k/50k curve on this 48GB dev machine, a 100k attempt risked destabilizing the shared
box, so it was not run; the 50k number and its growth trend are the real, measured evidence for
the risk, not a guess.

This is a genuine gap the ticket's own Task 6 verification step asks to check for
("no regression against existing job timeout budgets... check for headroom") and there is
**not** headroom for Hop 2 at its own configured default once a corpus approaches
`maxContextChars`. It was **not fixed in the Task 6 session** — Task 6 is scoped to documentation
only (no files), and touching `GuardrailPhiRedactor`'s timeout or `dna-regen.max-context-chars`'s
default is a separate, deliberate change outside that session's approved plan. Recommended
follow-up at the time: lower the effective default for `dna-regen.max-context-chars`
substantially below 100,000, and/or raise `GuardrailPhiRedactor`'s HTTP timeout specifically for
`mode: 'full'` calls, and/or chunk the corpus before redaction. Flagged as a spawned follow-up
task that session (`task_513b9d3a`, "Fix DNA-corpus redact timeout/memory risk at default cap")
rather than left as a comment only.

> **RESOLVED 2026-08-16** by the chunking fix below (§"Task 6 follow-up"). The corpus cap was
> left at 100,000 — chunking removed the reason to shrink it.

- Neither hop touches the live-documentation SSE loop (explicitly out of scope, §1) — the
  tightest latency budget in the system is untouched by this ticket.
- Hop 1 is not at risk at realistic sizes; Hop 2 is at risk specifically at or near its own
  configured default cap, which is a real, load-bearing finding from this benchmark, not
  before it.

### Task 6 follow-up — chunked extraction (RESOLVED 2026-08-16)

The Task 6 finding above is now fixed. Of the three options it recommended, only one addresses the
actual mechanism: the blow-up happens **inside a single `runtime.extract_entities` call over one
long string** (`gliner.py::_sync_extract_pii`), and nothing bounded that call.

- **Lowering `dna-regen.max-context-chars`** would trade away DNA corpus quality to dodge the bug,
  and would leave `/api/guardrail/redact` unbounded for every *other* caller (hop 1, gate-edit
  mining, anything added later).
- **Raising the timeout alone** does nothing about the 30-45GB projected peak RSS — the worker gets
  OOM-killed instead of timing out, which is a strictly worse failure mode.
- **Chunking** bounds both. It was implemented server-side, inside the endpoint, so the fix protects
  every caller rather than just the DNA hop, and costs one HTTP round trip rather than N.

**What changed:**

| File | Change |
|---|---|
| `apps/guardrail/.../endpoints/redact.py` | `_split_for_extraction` (whitespace-boundary partition), `_extract_spans` (sequential per-chunk extraction, offsets re-based onto the submitted document via the new `_Span` type), `_resolve_chunk_chars` (control-plane read) |
| `apps/guardrail/.../core/effective_config.py` | `EffectiveConfigSnapshot.redaction()` accessor |
| `packages/applications/.../descriptors/service-runtime.descriptors.ts` | new `guardrail.redact.chunkChars` key (default 4,000) |
| `packages/applications/.../descriptors/phi-redaction.descriptors.ts` | NEW — `phiRedaction.requestTimeoutMs` (default 120,000) |
| `packages/applications/.../effective-config.service.ts` + `IEffectiveConfigService.ts` | `redaction` group, served to guardrail only |
| `packages/applications/.../guardrail-phi-redactor.service.ts` | timeout read from the registry instead of the hardcoded `30000` |

**Both knobs are DB-tier (`global-kv`), not env vars** — a platform admin retunes them without a
redeploy, per the owner's directive this session. The chunk budget reaches guardrail over the same
`GET /internal/effective-config` pull the model-cache retention knobs already use; the timeout is
read straight from the AppSettings cache. Both degrade to a code default on a control-plane miss —
never to "unbounded".

**Correctness of the split.** Cuts land on a separator boundary (`\n\n---\n\n` → `\n\n` → `\n` →
`. ` → `" "`), so an identifier is never severed — a mid-token cut would hide PII from *both*
chunks, the one way this optimization could silently weaken redaction. The partition is exact
(`"".join(chunks) == text`), chunks are processed sequentially (concurrency would restore the very
peak-memory problem chunking exists to solve), and pseudonymize tokens are assigned *after* the
per-chunk spans are merged, so the same identifier in two different chunks still collapses onto one
`[PERSON_1]`. All four properties are asserted by tests.

**Re-benchmarked, same method and machine as Task 6** (real `GlinerProvider`, real ONNX weights,
CPU-only, 48GB). This time 100,000 chars was actually RUN, not extrapolated:

| Input | Chunk budget | Chunks | Total extraction | Peak RSS | Entities |
|---|---|---|---|---|---|
| 100,000 | 8,000 | 13 | 17,516 ms | 2.94 GB | 3,364 |
| 100,000 | **4,000** (default) | 27 | **9,689 ms** | **2.85 GB** | 3,364 |
| 100,000 | 2,000 | 53 | 9,280 ms | 2.67 GB | 3,364 |
| 100,000 | 1,000 | 105 | 9,888 ms | 2.66 GB | 3,364 |

Against the Task 6 projection for the same 100,000-char input (30-45+ s, 30-45+ GB): **9.7s and
2.85GB**. Peak RSS is now flat in chunk size because the floor is the model itself, not the input.
Two results worth stating plainly because they are counter-intuitive:

1. **Smaller chunks are FASTER**, not slower — that is the same super-linearity that caused the bug,
   read in the other direction. The curve flattens around 2,000-4,000 and the per-call overhead
   starts winning the gain back below that, so 4,000 is the knee: fastest tier that still gives the
   model the most context per call.
2. **The entity count is identical (3,364) at every chunk size**, which is the evidence that
   chunking costs no coverage on this fixture — the property that would otherwise be the real risk
   of this change. It is fixture-level evidence, not a proof for arbitrary text: an entity whose
   *only* signal spans a paragraph break could in principle read differently. Sentence/paragraph
   boundaries were chosen as cut points precisely to keep that class small.

Consequently `CONTEXT_DEFAULTS.maxContextChars` stays at 100,000 and
`dna-writing-style.processor.ts` is **unchanged** — there was no defect in the processor, so
nothing there needed a test change either. The 120,000ms default timeout is ~12× the measured
100,000-char cost, deliberately generous: a timeout here aborts the calling job by design
(fail-closed), so it should be set above the slowest corpus actually redacted, not tight.

**Not verified here (stated, not assumed):** the original brief asked to size this against real
production corpus sizes and job SLAs. Production data was not reachable from this session, so the
chunk budget is sized from the benchmark curve above rather than from observed corpus lengths. That
is what the `guardrail.redact.chunkChars` knob exists for — the value can be retuned from
production evidence without a code change.

### Full regression check

**Original Wave-1 run (2026-08-16, Tasks 1–5):**

```
$ pnpm --filter @arcaai/applications typecheck   → clean
$ pnpm --filter @arcaai/applications build       → clean
$ pnpm --filter @arcaai/applications lint <changed files>  → 0 errors, 0 new warnings
$ npx vitest run (full @arcaai/applications suite)
Test Files  483 passed | 1 skipped (484)
Tests  9040 passed | 4 skipped (9044)
```

**Re-verification after finalizing Decision #12 (this session, 2026-08-16 — docstring-only
diff: `redact.py`'s module docstring, `IPhiRedactor.ts`'s doc comment; no behavioral code
changed):**

```
$ pnpm --filter @arcaai/applications build
> tsc  → clean, no errors

$ npx eslint src/services/gate-edit-mining/IPhiRedactor.ts
→ (no output — 0 errors, 0 warnings)

$ npx vitest run   (full @arcaai/applications suite, all packages, from packages/applications)
Test Files  491 passed | 1 skipped (492)
Tests  9117 passed | 4 skipped (9121)

$ cd apps/guardrail && CI=true python -m pytest src/guardrail/tests -q
213 passed in 4.40s

$ python -m ruff check src/guardrail/api/endpoints/redact.py   → All checks passed!
$ python -m black --check src/guardrail/api/endpoints/redact.py → left unchanged
$ python -m mypy src/guardrail/api/endpoints/redact.py          → Success: no issues found in 1 source file
```

(The applications suite now shows more passing tests than the original Wave-1 run — 9117 vs.
9040 — because this run's tree also carries concurrent, unrelated sibling-agent work merged in
since, not because this ticket added new tests. This ticket's own diff in this session touches
only two docstrings.)

### Migrations

None. No Prisma schema changes in this ticket.

### API changes

- New: `POST /api/guardrail/redact` on the guardrail service (`apps/guardrail`) —
  `{text, mode: 'pseudonymize'|'full', request_id?}` →
  `{sanitized_text, entities: [{label,start,end,score}], mode, processing_time_ms,
  request_id, timestamp}`. Behind the existing `X-Service-Token` middleware; fail-closed
  (503 missing model selection, 502 extraction error — never 200 with unredacted text).
- Breaking (internal, migrated atomically): `IPhiRedactor.redact(text)` →
  `IPhiRedactor.redact(text, mode)`. Single consumer (`GateEditMiningService`) updated in the
  same PR.

## 8. Change History

| Date | Change | By |
|---|---|---|
| 2026-08-16 | Ticket authored | Claude (ticket-authoring session) |
| 2026-08-16 | Tasks 1–5 implemented and verified green (guardrail redact endpoint, `GuardrailPhiRedactor`, both hops wired). Task 0's Decision #12 (pseudonymization mechanism) recorded as a flagged PROVISIONAL choice, not resolved — remains HUMAN-GATED pending validation against `apps/nlp`'s entity-linking behavior. Task 6 recorded as an estimate (no live GLiNER available). Session stopped cleanly at the Decision #12 boundary as instructed. | Claude (execution session) |
| 2026-08-16 | Decision #12 finalized: read the real `ontology_linker.py`, `token_classifier.py`, `assertion.py` and confirmed the already-implemented stable per-label token mechanism is correct, but on a corrected rationale (the ontology linker has no coreference machinery to benefit — clinical-term preservation is structural to GLiNER's PII taxonomy in either mode; token diversity instead protects the downstream transformer NER model). Corrected both docstrings (`redact.py`, `IPhiRedactor.ts`) accordingly — no behavioral code change. Task 6 re-run as a real measured benchmark (local infra up, cached ONNX weights present): Hop 1 confirmed no regression risk at realistic transcript sizes; Hop 2 found a genuine, previously-undetected risk — at the DNA processor's own default `maxContextChars=100,000`, extrapolated latency/memory would likely exceed `GuardrailPhiRedactor`'s fixed 30s HTTP timeout and available worker memory, flagged as a follow-up (not fixed in this ticket — out of Task 6's docs-only file scope). Also closed out §6 risks #2–#5 (breaking-change migration, TASK-700 sequencing, route-imprecision recurrence, decrypt-and-scan scope) with concrete verification against the live tree. Full regression re-run green (applications: 9117/9121 tests; guardrail: 213/213). Status moved Review → Completed. | Claude (finalization session) |
| 2026-08-16 | Task 6's flagged risk RESOLVED (follow-up session; no new ticket — appended here per the fixes-to-existing-tickets rule). Root cause was an unbounded single `extract_entities` call, so the fix is server-side chunking in `/api/guardrail/redact` (whitespace-boundary partition, sequential per-chunk extraction, offsets re-based onto the submitted document, pseudonymize tokens assigned after merge) rather than shrinking the DNA corpus cap — which stays at 100,000, leaving `dna-writing-style.processor.ts` untouched. Both new knobs are DB-tier `global-kv` registry keys a platform admin manages, NOT env vars (owner directive this session): `guardrail.redact.chunkChars` (default 4,000, pulled over `/internal/effective-config`) and `phiRedaction.requestTimeoutMs` (default 120,000, replacing the hardcoded 30,000). Re-benchmarked with the real GLiNER at the full 100,000-char cap — actually run this time, not extrapolated: 9.7s / 2.85GB peak against the previous 30-45s / 30-45GB projection, with an identical entity count (3,364) at every chunk size, i.e. no coverage cost. Verified: guardrail 219/219 pytest (was 213 — 6 new chunking tests), ruff + black + mypy clean on changed files; applications 9,122 tests / 491 files green, `build` green, targeted `eslint` 0 errors 0 warnings. NOT verified: production corpus sizes / job SLAs were unreachable from this session, so the chunk budget is sized from the benchmark curve, not observed production data — retunable via the registry key without a code change. | Claude (follow-up session) |
