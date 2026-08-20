# TASK-777 — Guardrail: policy plane correctness, throughput at 100 concurrent, injection defense

| Field | Value |
|---|---|
| Status | Review |
| Type | feature + infrastructure |
| Owner requirements date | 2026-08-19 |
| Affects | `apps/guardrail` ONLY (a sibling ticket owns `apps/nlp`) |
| Depends on | TASK-735 (guardrail hosts no models/engines), TASK-737 (mandatory `X-Tenant-Id`) |

---

## 1. Requirement Analysis

Three owner requirements, restated:

- **A — Per-tenant AND platform-wide policy, done properly.** Two tiers only (request tenant →
  SYSTEM), `50000000-…` never in a runtime cascade, `X-Tenant-Id` mandatory (absent = caller
  defect = 428), per-tenant cache keys, selection fails closed (503), tuning may fail
  open-to-default, and thresholds / criteria / label taxonomies are CONFIG — never Python literals.
- **B — ≥ 100 concurrent consultation sessions, measured.** Shared bounded `httpx.AsyncClient`
  with explicit pool limits and explicit connect/read/write/pool timeouts; bounded concurrency
  with declared backpressure; a circuit breaker per peer with a declared fail posture;
  single-flight on identical in-flight config reads; invalidation as the propagation path with
  TTL as backstop; Prometheus metrics for in-flight, queue depth, peer latency, breaker state and
  rejections; a repeatable load test with REAL numbers.
- **C — Prompt-injection and harmful request/response prevention, in BOTH directions**, with an
  explicit threat model, attributable verdicts, and a fail posture declared per check.

Guardrail after TASK-735 is a **policy plane**: no model weights, no LLM engines, no provider
adapters. Everything below preserves that. No inference stack is reintroduced.

## 2. Current State Evaluation (verified 2026-08-19 against `bb9c87535`)

### 2.1 What is already correct (do not regress)

| Property | Where |
|---|---|
| Two-tier cascade, tenant → SYSTEM | `core/tenant_config.py::resolve` / `_load_from_db` |
| No `50000000-…` anywhere | grep-verified; the `default_tenant_id` knob was deleted by TASK-735 |
| `X-Tenant-Id` mandatory, 428 on absence, `tenantless:<reason>` as the declared exception | `core/dependencies.py::require_tenant_id` |
| Per-tenant cache key `f"{task_key}::{tenant_id}"` | `core/tenant_config.py::_get_for_tenant` |
| Selection fails CLOSED (503); DISABLED tenant row is a veto, not a fold-through | `core/dependencies.py`, `TenantSelectionVetoedError` |
| Label taxonomies resolved from `AiModel._metadata.labelTaxonomy` through the same cascade | `core/dependencies.py::build_safety_analyzer` |
| Undetermined never degrades to `safe` | `core/errors.py`, `services/safety_analyzer.py` |
| Peer clients refuse to construct without a tenant | `TextJudgeClient`, `NlpGuardClient` |

### 2.2 Findings — A (policy resolution)

| # | Finding | Severity |
|---|---|---|
| **A-1** | **No single-flight on config reads.** `_get_for_tenant` is a plain dict + TTL. N concurrent requests for a cold tenant issue N identical `AiTaskDefault ⋈ AiModel` queries. At 100 concurrent sessions each opening with ~3 task-key reads, a cold cache is a 300-query thundering herd against a `pool_size=5` engine — the dominant latency cliff under load. | high |
| **A-2** | **TTL is the only propagation path.** Rule 09 §Config caches: *"invalidation is the propagation path; TTL is a bounded-staleness safety net"*. Guardrail has no invalidation channel at all, so a platform admin tightening a threshold waits out a 60s window on every node. | high |
| **A-3** | **Verdict-deciding criteria is a Python literal.** `services/external_text_client.py::MEDICAL_VALIDATION_CRITERIA` is the actual safety policy text, in code. TASK-735 §5 D5 assigned criteria to the config plane and Phase 4 never landed the Python half (blocked on G-01). | high |
| **A-4** | **The judge has a fabricated-verdict fallback that is also an injection bypass.** `_parse_verdict` catches an unparseable model response and calls `_keyword_verdict`, a hardcoded 40-term taxonomy (`_MEDICAL_KEYWORDS`) that scores the RAW MODEL OUTPUT. Two defects in one: a hardcoded taxonomy (A), and a path where an attacker who can steer the judge into emitting prose containing two clinical words earns `is_medical: true` without any model having judged it (C). | high |
| **A-5** | **Policy thresholds are code defaults, not config.** `JudgePolicy.min_confidence = 0.75`, `SafetyPolicy.pii_threshold = 0.5`, `classification_threshold = 0.4`, `GroundednessConfig.entailment_threshold` (an env var, `GUARDRAIL_V2_GROUNDEDNESS_ENTAILMENT_THRESHOLD`). Taxonomy-borne thresholds already override the last two; the judge's confidence floor has no config path at all. | medium |
| **A-6** | `min_confidence` is only LOGGED, never enforced — a verdict below the floor is returned as if it cleared it. | medium |

### 2.3 Findings — B (throughput)

| # | Finding | Severity |
|---|---|---|
| **B-1** | **The shared client's timeout is a single 300 s scalar** (`main.py`: `httpx.Timeout(300.0)`), so connect/read/write/pool all inherit 300 s. A peer that accepts a connection and stalls holds a pool slot for five minutes; 100 such requests exhaust `max_connections=100` and every subsequent request blocks on pool acquisition — with no pool timeout, forever. | high |
| **B-2** | **No admission control anywhere.** No semaphore, no queue-wait ceiling, no 503 backpressure. Load arrives unbounded at the peers. | high |
| **B-3** | **No circuit breaker.** Both peer clients retry (2 attempts) on every request, so a dead peer costs `2 × timeout` per request and *amplifies* load into an outage instead of shedding it. | high |
| **B-4** | **`batch_analyze` / `batch_validate` are unbounded `asyncio.gather`** over caller-supplied lists — a single request can fan out arbitrarily wide. | medium |
| **B-5** | **No throughput metrics.** `/metrics` carries per-model gauges and token counters only: no in-flight, no queue depth, no peer latency, no breaker state, no rejections. | medium |

### 2.4 Findings — C (injection / harmful content)

| # | Finding | Severity |
|---|---|---|
| **C-1** | **No structural defense at all.** Untrusted content (transcribed speech, retrieved documents, prior notes) is passed to the judge inside an f-string: `f"Analyze this text for medical context:\n\n{text}"`. There is no delimiting, no instruction-data separation, and no neutralization of content that closes the fence. This is OWASP LLM01 indirect prompt injection with no mitigation. | high |
| **C-2** | **No Unicode smuggling defense.** Unicode Tags (U+E0000–U+E007F), bidi overrides and zero-width characters carry instructions that are invisible to a human reviewer and to keyword screening, but are tokenized by the model. | high |
| **C-3** | **The outbound direction is essentially undefended.** The taxonomy declares `response_safety` / `response_toxicity` / `response_refusal`, but they only run under `guardrail_type="comprehensive"`, against the *input* text, from a route whose whole framing is inbound. There is no endpoint that screens a model response, and no PII-leakage check on a response before it reaches a clinician. | high |
| **C-4** | **Verdicts are not attributable in the response.** A verdict returns `{safe, issues, confidence}` — no tenant, no per-check model, no config source tier, no declared fail mode. An auditor cannot answer "whose policy decided this, with which model, and what would have happened had the check failed". | medium |
| **C-5** | Fail posture is *implemented* consistently but not *declared*: each call site re-decides by convention. There is no per-check declaration an auditor can read. | medium |

## 3. Threat Model

**System under protection.** A multi-tenant clinical documentation platform. Guardrail sits on the
critical path of every generation: `apps/text` gates each `/generate` on a guardrail verdict, and
guardrail delegates judgement to `apps/text` (isolated judge lane) and classification to `apps/nlp`.

**Assets.** (1) PHI in transcripts, notes and generated summaries. (2) Clinician trust in generated
clinical documentation. (3) Per-tenant safety configuration integrity. (4) The instruction/data
boundary of every downstream LLM call.

**Trust zones.**

| Zone | Content | Trust |
|---|---|---|
| Z0 | Platform code, SYSTEM-tenant config | trusted |
| Z1 | Tenant-admin config | semi-trusted; **tighten-only** relative to SYSTEM (TASK-735 D2) |
| Z2 | Clinician-authored prompt text | untrusted, but attributable to a user |
| Z3 | **Transcribed audio, retrieved documents, prior notes, uploaded referrals** | **fully untrusted and unattributable — the highest-risk channel** |
| Z4 | Model output (judge, generator) | untrusted; may be harmful, hallucinated, or PHI-leaking |

**Adversaries and the defense that answers each.**

| # | Adversary / capability | Direction | Defense (this ticket) |
|---|---|---|---|
| **T1** | End user crafts a jailbreak in the prompt ("ignore previous instructions…") | inbound | D4 jailbreak/safety classification via the `apps/nlp` guard plane, labels from the registry taxonomy |
| **T2** | **Indirect injection (OWASP LLM01):** a third party influences Z3 — speaks an instruction aloud in the consultation room so it lands in the transcript, or plants it in an uploaded referral letter | inbound | D2 structural containment (nonce-fenced, instruction-data-separated envelope; fence-closing sequences neutralized) + D4 classification |
| **T3** | Invisible-instruction smuggling via Unicode Tags / bidi / zero-width | inbound | D1 sanitization before any screening or delegation, so the screener sees what the model will see |
| **T4** | Model emits harmful, abusive or self-harm-adjacent content to a clinician | outbound | D5 response safety/toxicity classification |
| **T5** | Model leaks PHI that was never in the provided source (another patient's identifiers, memorized data) | outbound | D6 PII-span leakage check against the declared source context |
| **T6** | Injection succeeded upstream and the response now carries the exfiltration payload or the containment fence itself | outbound | D7 fence/marker echo detection |
| **T7** | Model fabricates clinical facts | outbound | existing NLI groundedness gate (unchanged; still degrades to `unverified`, never `grounded`) |
| **T8** | A caller drops `X-Tenant-Id`, silently downgrading a tenant to the (loosest admissible) SYSTEM floor | both | 428, pre-existing (TASK-737), re-asserted by tests here |
| **T9** | **Resource exhaustion.** Guardrail fails closed, so saturating guardrail is a denial of *generation* for every tenant | both | B: admission control with declared backpressure, per-peer breakers, bounded pools, single-flight config reads |

**Explicitly out of scope / accepted.** Guardrail cannot defend a downstream caller that ignores its
verdict; it cannot detect an injection that is semantically indistinguishable from legitimate
clinical dictation; and classification quality is bounded by the models `apps/nlp` serves — this
ticket owns policy, containment structure, attribution and fail posture, not model accuracy.

**Sources consulted:** OWASP Top 10 for LLM Applications 2025 (LLM01 Prompt Injection, LLM02
Sensitive Information Disclosure, LLM05 Improper Output Handling) — defense-in-depth combining
input validation, **context segregation**, privilege limitation and **output filtering**; OWASP's
own note that neither RAG nor fine-tuning fully mitigates LLM01.

## 4. Implementation Plan (TDD — RED first for every item)

### Lane A — policy plane
1. **A-1** Single-flight in `TenantConfigResolver`: an in-flight `asyncio.Future` map keyed by the
   existing `f"{task_key}::{tenant_id}"`. Concurrent misses await one load. Vetoes and errors
   propagate to every waiter identically.
2. **A-2** `invalidate(tenant_id=…, task_key=…)` + a Redis pub/sub subscriber on
   `arca:guardrail-config:invalidate` started in `lifespan`. TTL demoted to backstop, documented.
3. **A-3/A-5** New `core/policy.py`: `GuardrailPolicy` resolved from `AiModel._metadata.policy`
   through the SAME two-tier cascade (a new `KEY_POLICY` alongside `KEY_LABEL_TAXONOMY`), with a
   **declared `failMode` per key** — `closed` for anything that decides a verdict (criteria,
   confidence floor), `open-to-default` for tuning. `MEDICAL_VALIDATION_CRITERIA` is deleted from
   code; an unresolved criteria string is 503.
4. **A-4** Delete `_keyword_verdict` / `_MEDICAL_KEYWORDS`. An unparseable judge response is
   `REASON_INVALID_RESPONSE` → undetermined → 503.
5. **A-6** Enforce `min_confidence`: below the floor is undetermined, not a pass.

### Lane B — throughput
6. **B-1** Explicit `httpx.Timeout(connect=…, read=…, write=…, pool=…)` + limits, all bootstrap
   transport settings.
7. **B-2** `core/concurrency.py::AdmissionGate` — bounded semaphore + queue-wait ceiling; over
   ceiling ⇒ `AdmissionRejected` ⇒ **503 + `Retry-After`**. Declared backpressure.
8. **B-3** `core/breaker.py::CircuitBreaker` per peer (`text`, `nlp`), states closed/open/half-open,
   each construction carrying a **declared** `FailPosture`. Open circuit short-circuits without a
   peer call and still fails CLOSED for a verdict.
9. **B-4** Bounded batch fan-out through the same gate.
10. **B-5** Metrics: `guardrail_inflight_requests`, `guardrail_queue_depth`,
    `guardrail_admission_rejections_total`, `guardrail_peer_request_seconds`,
    `guardrail_peer_failures_total`, `guardrail_circuit_breaker_state`,
    `guardrail_config_cache_events_total`.
11. Load test: `scripts/loadtest.py` (in-process ASGI, peers stubbed) + a pytest that asserts 100
    concurrent requests all succeed under the gate.

### Lane C — injection defense
12. `services/injection_defense.py`: `sanitize_untrusted()` (Unicode Tags / bidi / zero-width /
    control chars, with a report of what was removed) and `wrap_untrusted()` (per-request random
    nonce fence + instruction-data-separation preamble; fence-closing sequences in the content are
    neutralized so the envelope cannot be closed early).
13. `services/screening.py`: `screen_inbound()` / `screen_outbound()` producing a
    `GuardrailDecision` — `tenant_id`, `direction`, `decision`, and a `CheckOutcome` per check
    carrying `name`, `outcome`, `fail_mode`, `model`, `source_tenant_id`, `reason`. PHI-free by
    construction (no analysed text in any field).
14. `api/endpoints/screen.py`: `POST /guardrail/screen/inbound`, `POST /guardrail/screen/outbound`.
15. Outbound PII leakage: spans in the response whose text is absent from the declared source
    context are `pii_leak`.

### Verification criteria
- Guardrail pytest green (run with `PYTHONPATH` at this worktree — the conda env's editable
  install points at the MAIN checkout).
- `ruff` + `mypy` clean on `src/guardrail`.
- Load test output pasted with p50/p95/p99 and throughput at 100 concurrent.

## 5. Implementation Summary

### 5.1 Files

| File | Change |
|---|---|
| `core/policy.py` | **NEW.** The governed policy surface: one `_SPECS` table declaring each key's `failMode` (and, for tuning keys, its default + bounds). `require_criteria` raises; `number()` falls back on absence *or* an out-of-range value. |
| `core/concurrency.py` | **NEW.** `AdmissionGate` — bounded semaphore + queue-wait ceiling, `AdmissionRejected` → 503 + `Retry-After`, plus `map()` as the bounded replacement for a bare `gather`. |
| `core/breaker.py` | **NEW.** `CircuitBreaker` (closed/open/half-open) with `FailPosture` as a **required** constructor argument. A failed half-open probe re-opens immediately; a success resets the failure *run*. |
| `services/injection_defense.py` | **NEW.** `sanitize_untrusted()` (NFKC, then Unicode Tags / bidi / zero-width / control stripping with a PHI-free count report + size bound) and `wrap_untrusted()` (nonce fence + instruction-data-separation preamble, nonce neutralized inside the body), `contains_fence_echo()`. |
| `services/screening.py` | **NEW.** `Screener.screen_inbound` / `screen_outbound` composing `CheckOutcome`s into an attributable, PHI-free `GuardrailDecision`. Fail posture declared once in `_DECLARED_FAIL_MODES`. |
| `api/endpoints/screen.py` | **NEW.** `POST /api/v1/guardrail/screen/{inbound,outbound}`. |
| `scripts/loadtest.py` | **NEW.** Repeatable load harness (see §5.3). |
| `core/tenant_config.py` | Single-flight (`_in_flight` future map, keyed identically to the cache) + `invalidate(tenant_id=, task_key=)`; `KEY_POLICY` read from `AiModel._metadata.policy` through the existing two-tier cascade; cache-event telemetry; `build_judge_client` resolves criteria + the confidence floor from policy. |
| `services/external_text_client.py` | `MEDICAL_VALIDATION_CRITERIA` and `_MEDICAL_KEYWORDS`/`_keyword_verdict` **deleted**; `criteria` is a required constructor argument; the confidence floor is **enforced**, not logged; optional breaker + peer-latency observation. |
| `services/external_nlp_client.py` | Optional breaker + peer-latency observation; non-2xx now raises `_PeerStatusError` so the breaker counts it. |
| `services/safety_analyzer.py` | New `classify_tasks()` / `model_for()` seam for the screener; `batch_analyze(gate=…)` bounded fan-out. |
| `core/config.py` | New `TransportPolicy` (pool limits, per-phase timeouts, gate sizes, breaker settings) — a `BaseModel`, so **no new env vars**. |
| `core/dependencies.py` | `admitted()` (gate → 503 + `Retry-After`), `build_screener()`, breaker injection, criteria-unresolved → 503. |
| `core/metrics.py` | 8 new metric families (§5.4). |
| `main.py` | `build_http_client` / `build_admission_gates` / `build_circuit_breakers`; Redis pub/sub config-invalidation listener on `arca:guardrail-config:invalidate`. |

### 5.2 Findings resolved

All of §2.2 (A-1…A-6), §2.3 (B-1…B-5) and §2.4 (C-1…C-5). Two are worth calling out
because they were *behaviour reversals*, not additions:

* **A-4** — `test_unparseable_judgement_degrades_to_the_deterministic_keyword_classifier`
  pinned the old fallback as a feature. It was a hardcoded taxonomy scoring
  attacker-influenceable text, and its output was indistinguishable on the wire
  from a judged verdict. The test now pins the opposite, with the reasoning in its
  docstring so the reversal is traceable rather than looking like drift.
* **A-6** — the confidence floor was logged and then ignored. Enforcing it means a
  low-confidence judgement is now a 503 where it used to be a 200.

### 5.3 Throughput — measured, not asserted

Harness: `apps/guardrail/scripts/loadtest.py`. **Real:** the route handler, the
mandatory-tenant precondition, the admission gate, the screener, sanitization,
containment, the decision record, the metrics. **Stubbed:** the two peers
(`apps/text`, `apps/nlp`) at the analyzer seam with a settable latency — the number
under test is guardrail's own overhead and queueing behaviour, not a peer's GPU.
Machine: darwin arm64, Python 3.11 (`arcaenv`), single process.

```
$ PYTHONPATH=apps/guardrail/src python apps/guardrail/scripts/loadtest.py \
      --concurrency 100 --requests 2000
concurrency        : 100
requests           : 2000
peer latency (stub): 20.0 ms
wall time          : 0.625 s
throughput         : 3,198.8 req/s
p50 / p95 / p99    : 27.35 / 38.29 / 48.68 ms
mean / max         : 28.39 / 48.89 ms
outcomes           : {'allow': 2000, 'block': 0, 'backpressure_503': 0, 'error': 0}
```

| Run | Concurrency | Requests | Peer latency | Throughput | p50 | p95 | p99 | Rejections |
|---|---|---|---|---|---|---|---|---|
| guardrail overhead only | 100 | 2 000 | 0 ms | **7 429.8 req/s** | 5.54 ms | 51.39 ms | 74.19 ms | 0 |
| realistic peer | 100 | 2 000 | 20 ms | **3 198.8 req/s** | 27.35 ms | 38.29 ms | 48.68 ms | 0 |
| slow peer | 100 | 5 000 | 50 ms | **1 782.3 req/s** | 53.57 ms | 58.18 ms | 86.01 ms | 0 |
| 5× the target | 500 | 5 000 | 50 ms | **3 982.0 req/s** | 110.74 ms | 147.38 ms | 150.38 ms | 0 |

**Verdict: the ≥ 100-concurrent target is met with substantial headroom.** At 100
concurrent with a 20 ms peer, p99 is 48.68 ms — i.e. ~28 ms of queueing on top of
the peer round-trip, and guardrail's own share of p50 is ~7 ms. At 500 concurrent
(above the 256 admission bound) work queues briefly and is still served: latency
roughly doubles, throughput does not collapse, and nothing is rejected — which is
the gate behaving as designed rather than as a cliff.

**The bottleneck, named:** guardrail's own cost is dominated by the per-decision
structured log (INFO per verdict — correct in production, since every verdict must
be attributable) and by `unicodedata.normalize` over the note. Both are linear in
note size and neither involves the event loop blocking. Under real load the
dominant term is the peer round-trip, exactly as the table shows: throughput tracks
`concurrency / peer_latency` almost perfectly (100 / 50 ms → ~2 000/s theoretical,
1 782/s measured).

**Not measured here:** a live `apps/text` / `apps/nlp`, and the database behind
`TenantConfigResolver` (single-flight is unit-tested — 100 concurrent cold reads
cost exactly one query — but not benchmarked against Postgres). Both need
infrastructure this ticket is not permitted to start.

### 5.4 Metrics added

`guardrail_inflight_requests{gate}` · `guardrail_queue_depth{gate}` ·
`guardrail_admission_wait_seconds{gate}` · `guardrail_admission_rejections_total{gate}` ·
`guardrail_peer_request_seconds{peer,operation}` · `guardrail_peer_failures_total{peer,reason}` ·
`guardrail_circuit_breaker_state{peer}` · `guardrail_config_cache_events_total{event}` ·
`guardrail_screening_decisions_total{direction,decision,reason}`.

All label sets are bounded and **tenant-free** — Prometheus is the fleet-health
plane; per-tenant answers come from Postgres, which has access controls a scrape
endpoint does not.

### 5.5 Verification

```
$ PYTHONPATH=apps/guardrail/src python -m pytest src/guardrail/tests -q
251 passed in 7.61s          # 196 at baseline; 55 new

$ python -m ruff check src/ scripts/
All checks passed!

$ PYTHONPATH=src python -m mypy src/guardrail
Success: no issues found in 35 source files
```

`pnpm guardrail:test` was NOT used: the `arcaenv` conda env has editable installs
pointing at the main checkout, so it silently tests the wrong tree. Everything above
ran with `PYTHONPATH` pinned to this worktree.

`black --check` reports drift across 34 files, which is **pre-existing** — e.g.
`services/job_processor.py`, untouched by this ticket, reformats. The two files
created here were formatted with black.

### 5.6 Left undone / follow-ups

1. **Seed rows for the new policy blob.** ~~`AiModel._metadata.policy` needs
   `medicalValidationCriteria` on the SYSTEM `guardrail.validate` row, or
   `/medical/validate` fails closed with 503.~~ **Resolved 2026-08-20 — see §5.7.**
   This was the intended posture (a judge with no criteria is no judge) but it was a
   **hard cutover**: the seed change had to land with this code. Seed authoring was a
   sibling lane and no seed run was performed in the original pass, per the working
   agreement.
2. **`injectionScreeningCriteria`** is declared and unused — reserved for an
   LLM-judge second opinion on the inbound path, which would close a call cycle with
   `apps/text` and needs its own design.
3. **`guardrail.transport.*` and `guardrail.policy.*` as `SettingDescriptor`s.**
   `TransportPolicy` remains code defaults, per TASK-735 §6b G-06 (adding env vars is
   explicitly the wrong resolution) and G-01 (there is still no tenant-cascade read
   surface for `db-config` keys). The policy blob route taken here needs no new plane.
4. **Callers are not yet repointed.** The screening routes exist and are tested; the
   gateway/`apps/text` do not call them yet. That is deliberate — a cross-service
   cutover is not `apps/guardrail`'s file scope.
5. **Groundedness is unchanged** (T7) and still degrades to `unverified`.

### 5.7 Seed data for the policy blob (2026-08-20)

Follow-up to §5.6 item 1: with no seed row carrying `_metadata.policy`,
`POST /medical/validate` was permanently 503 (`GuardrailPolicy.require_criteria`
fail-closed) — the correct posture for missing config, but only correct once the
config is actually shipped. This closes the gap.

**Files:**

| File | Change |
|---|---|
| `packages/database/src/prisma/db_main/seed/ai-models/shared.ts` | `AiModelSeed.metaData` gains an optional `policy?: Record<string, string \| number>` key, documented against `core/policy.py`'s governed key table. |
| `packages/database/src/prisma/db_main/seed/ai-models/llm.ts` | The SYSTEM `granite-guardian-4.1-8b` row (`80000000-0000-0000-0005-000000000060`, the platform default for `guardrail.validate`) gains `metaData.policy.medicalValidationCriteria`. |
| `packages/database/src/prisma/db_main/seed/__tests__/task-777-guardrail-policy-seed.test.ts` | **New.** 8 Vitest cases (mock-client, no live DB) — see below. |

**Criteria text — recovered, not rewritten.** `MEDICAL_VALIDATION_CRITERIA` was
deleted from `apps/guardrail/src/guardrail/services/external_text_client.py` by
commit `567d4baf5`. Its exact value was read back with
`git show 567d4baf5^:apps/guardrail/src/guardrail/services/external_text_client.py`
and extracted with `ast.literal_eval` (not hand-transcribed) to guarantee a
byte-for-byte match, including the embedded JSON-shape example and both blank
lines. The seeded string is that value verbatim — a fabricated clinical-validator
prompt would be a worse outcome than the pre-existing 503.

**`injectionScreeningCriteria` was deliberately NOT seeded.** It is declared in
`core/policy.py::_SPECS` with `failMode: closed`, but grepping
`apps/guardrail/src/guardrail` turns up no call site that resolves it —
§5.6 item 2 confirms it's "reserved for an LLM-judge second opinion on the inbound
path, which would close a call cycle with `apps/text` and needs its own design."
Authoring criteria text for a check nothing reads yet would be unreviewed clinical
policy masquerading as shipped configuration. When that lane is designed, it needs
its own seed entry and its own review — not a placeholder invented here.

**How the update reaches the EXISTING row (the create-only trap named in the
original task brief).** `seedAiTaskDefault` (`16-ai-task-default.ts:184-196`) genuinely
is create-only. `seedAiModels` (`06-stt.ts:1799`, invoked by `seedStt` — the actual
`AiModel` entry point) is **not**: for a slug that already exists it calls
`client.aiModel.update({ where: { id: existing.id }, data: { ...,
...(modelData.metaData !== undefined ? { metaData: modelData.metaData } : {}) } })`
— the exact mechanism `ai-models/nlp.ts` already relies on for `labelTaxonomy` and
`ai-models/tts.ts` for `voices`. Because `granite-guardian-4.1-8b`'s seed row didn't
previously set `metaData` at all, existing rows kept whatever `_metadata` they had
(the guard clause skips the key entirely). Adding `metaData: { policy: {...} }` now
means a `db:seed` re-run **overwrites the row's entire `_metadata` column** with
exactly that literal — the same full-column-write semantics every other
`metaData`-bearing row in this catalog already has, not a new merge mechanism. On
this row specifically that is safe: `granite-guardian-4.1-8b` carried no other
`metaData` keys before this change (verified: it's the only row in `LLM_AI_MODELS`'s
guardrail block, and no other file writes to its id). Fields OUTSIDE `metaData` —
`resourceStatus`, `downloadState`, and anything an admin sets through the AiModel
admin surface — are untouched; `seedAiModels`'s `update()` payload never carries them.

**Customer-tenant clones (`50000000-…0000`, `50000000-…0001`) — deliberately NOT
given the policy blob.** `tenant_config.py::_load_from_db`'s `_row_rank` ranks the
**SYSTEM** `AiModel` row over a tenant-owned copy of the SAME slug as a tie-break
(`0 if row.model_tenant_id == SYSTEM_TENANT_ID else 1`) — a shared-read design
pinned by the Python suite's `test_db_prefers_system_model_row_over_tenant_copy`.
For `guardrail.validate` specifically, a tenant would need to point its OWN
`AiTaskDefault` row at a DIFFERENT model slug to ever have its clone's `metaData`
consulted; the same-slug clone's `_metadata.policy` is structurally unreachable.
Separately, `backfillCustomerTenantAiModels` only resyncs an EXISTING clone's
`metaData` when `provider IS NULL` (`06-stt.ts:1888`) — the live dev DB's clones
were backfilled long ago and already carry `provider`, so even a resync pass
wouldn't touch them. Seeding `policy` onto the clones would be dead, unreachable
data pretending to be tenant-overridable config; the README instead documents the
reachability gap rather than papering over it with an inert write.

**Tests (`task-777-guardrail-policy-seed.test.ts`, all mock-client / static —
no live DB):**

1. The SYSTEM row's `metaData.policy.medicalValidationCriteria` equals the recovered
   text exactly.
2. `injectionScreeningCriteria` is absent from the seeded blob.
3. No other `DEFAULT_AI_MODELS` row accidentally carries a `policy` key.
4. `seedAiModels` against an "already exists" mock `update()`s the granite row's
   `metaData` to exactly `{ policy: { medicalValidationCriteria: <text> } }`, and
   creates nothing.
5. Re-running `seedAiModels` twice produces byte-identical update payloads
   (idempotency).
6. Every OTHER row with no seeded `metaData` gets an update payload with no
   `metaData` key at all (existing admin-set metadata on those rows is never
   clobbered by this change).
7. A brand-new customer-tenant clone (first backfill) DOES inherit
   `metaData.policy` — `backfillCustomerTenantAiModels` spreads the SYSTEM row
   verbatim on create, so this is accurate even though it's inert per the
   reachability note above.
8. An already-populated clone (`provider` already set — the live-DB state) is left
   untouched by the backfill's resync branch.

**Verification (this worktree, `.claude/worktrees/task-777-seed`, after
`pnpm install` + `DATABASE_URL=... DIRECT_URL=... pnpm --filter @arcaai/database
db:generate` to materialize the Prisma client and node_modules, neither of which
were checked in):**

```
$ pnpm --filter @arcaai/database exec vitest run src/prisma/db_main/seed/__tests__/task-777-guardrail-policy-seed.test.ts
 Test Files  1 passed (1)
      Tests  8 passed (8)

$ pnpm --filter @arcaai/database test
 Test Files  59 passed (59)
      Tests  1549 passed (1549)   # 1541 baseline + 8 new

$ pnpm --filter @arcaai/database build   # tsc
src/prisma/db_main/seed/ai-models/nlp.ts(111,7): error TS2353: ... 'languages' does not exist ...
src/prisma/db_main/seed/ai-models/nlp.ts(167,7): error TS2353: ... 'languages' does not exist ...
src/prisma/db_main/seed/ai-models/nlp.ts(261,7): error TS2353: ... 'languages' does not exist ...
ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @arcaai/database@0.1.0 build: `tsc`

$ pnpm --filter @arcaai/database typecheck   # identical 3 errors, same file/lines
```

Those 3 `nlp.ts` errors are **pre-existing on `feat/loop @ 636c4c917`**, unrelated to
this change — confirmed by `git stash -u` (stashing both this lane's tracked edits
AND the untracked new test file) and re-running `build`: the identical 3 errors
reproduce with ZERO files from this lane present. `AiModelSeed.metaData` was already
too narrow for `ai-models/nlp.ts`'s `languages`/`capabilities`/`labelTaxonomy` keys
before this change (a TASK-778-lane gap, out of this ticket's scope per the
Karpathy "surgical changes" rule — not touched here). This lane's own addition
(`metaData.policy` on the `AiModelSeed` interface, consumed only by `llm.ts`)
introduces zero new `tsc` errors, confirmed by diffing the error list before/after.

`pnpm --filter @arcaai/database lint` does not exist — the package has no `lint`
script and no ESLint config (`npx turbo run lint --filter=@arcaai/database` reports
"No tasks were executed"), consistent with `01-development-workflow.md`'s lint
guidance applying at the repo-aggregate level; there is nothing to lint in this
package specifically.

**Left undone:** the pre-existing `nlp.ts`/`shared.ts` typecheck drift above (not
this ticket's scope — flag separately if it should be fixed). No live seed run was
performed; run `pnpm db:seed` to apply.

## 6. Change History

| Date | Change |
|---|---|
| 2026-08-19 | Ticket created; current-state audit (§2), threat model (§3), plan (§4). |
| 2026-08-19 | Lane A landed: single-flight + invalidation, policy-as-config with per-key `failMode`, keyword-fallback deleted, confidence floor enforced. |
| 2026-08-19 | Lane B landed: explicit per-phase timeouts, admission gate, per-peer breakers, bounded batch fan-out, 8 metric families, load harness + measured numbers (§5.3). |
| 2026-08-19 | Lane C landed: sanitization, nonce-fenced containment, bidirectional screening with attributable per-check records, `/guardrail/screen/{inbound,outbound}`. |
| 2026-08-20 | §5.7: seeded `medicalValidationCriteria` (recovered verbatim from `567d4baf5^`) onto the SYSTEM `granite-guardian-4.1-8b` row's `metaData.policy`, closing the §5.6 item 1 gap that left `/medical/validate` permanently 503. `injectionScreeningCriteria` deliberately left unseeded (unused by any call site). Customer-tenant clones deliberately left unseeded (unreachable per `_row_rank`'s shared-read tie-break). 8 new Vitest cases; no seed run performed. |
