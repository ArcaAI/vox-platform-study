# TASK-710 — Working PHI Redactor (Guardrail Redact Endpoint + `IPhiRedactor` Implementation)

| | |
|---|---|
| **Status** | Pending |
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

- [ ] Task 0's mode-selection decision recorded before implementation starts
- [ ] `pnpm guardrail:test` green, including new golden redaction fixtures
- [ ] `pnpm guardrail:lint`, `pnpm guardrail:typecheck` clean
- [ ] `pnpm --filter @arcaai/applications test` green, including `GuardrailPhiRedactor` unit tests and the updated `gate-edit-mining` tests
- [ ] `pnpm --filter @arcaai/applications build` green
- [ ] Integration tests confirm Hop 1 (NLP) receives pseudonymized text with clinical entities intact and identifiers masked
- [ ] Integration tests confirm Hop 2 (DNA corpus → SMR) receives fully redacted text
- [ ] Both hops are fail-closed: a redactor error aborts the job, never falls through to unredacted content — asserted by tests that force `IPhiRedactor.redact` to throw
- [ ] `GateEditExemplar` mining test suite shows the corpus mines a non-empty exemplar for a fixture edit pair, confirming the previously-inert path is now un-blocked (without modifying `gate-edit-mining.service.ts` itself)
- [ ] `pnpm lint` clean across affected packages
- [ ] Paste actual command output for each of the above before marking Complete

## 6. Risks & Open Questions

- **HUMAN-GATED (Task 0):** the exact pseudonymization mechanism (stable per-session token substitution vs. category masking) affects downstream NER accuracy and needs a decision informed by `apps/nlp`'s actual entity-linking behavior, not just this ticket's own reasoning — flag for a quick check against `ontology_linker.py`'s dictionary during Task 0.
- Extending `IPhiRedactor`'s signature to add a `mode` parameter is a breaking interface change with exactly one existing consumer (`GateEditMiningService`) — low blast radius, but must be updated atomically in Task 3, not left half-migrated.
- TASK-700 (`dna-phi-containment`) and this ticket both edit `dna-writing-style.processor.ts`. Sequencing risk: if TASK-700 lands first, this ticket's Task 5 diff should rebase cleanly (it only touches the corpus→SMR seam, not the `textSamples`/opt-out branch TASK-700 touches) — but this should be confirmed at execution time, not assumed.
- The route correction from `/api/v1/guardrail/redact` (as loosely stated in the architecture doc) to the actually-idiomatic `/api/guardrail/redact` should be flagged back to the design doc if this pattern recurs elsewhere in the program — several other Plane 1/2 tickets may inherit the same imprecision.
- This ticket does not decrypt or scan any existing `DnaWritingStyleReport.styleText` rows for already-leaked PHI — that is TASK-700's decrypt-and-scan, explicitly out of scope here (§1).

## 7. Implementation Summary

_(Empty at authoring — filled during execution.)_

## 8. Change History

| Date | Change | By |
|---|---|---|
| 2026-08-16 | Ticket authored | Claude (ticket-authoring session) |
