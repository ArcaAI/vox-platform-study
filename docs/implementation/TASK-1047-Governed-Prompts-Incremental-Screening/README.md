# TASK-1047 — Governed prompts, data-only incremental screening, bounded NLP inference

| Field | Value |
|---|---|
| Status | **In Progress** — implementation merged to `dev-2.2` and gated; validation V2–V6 next, then the TASK-1045 e2e (V7) |
| Type | refactor + infrastructure (safety plane efficiency; no new product feature) |
| Branch | `dev-2.2` (lanes in sibling worktrees, merged by the orchestrator) |
| Raised by | TASK-1045 e2e, 2026-10-06 — `apps/nlp` reached 36.8 GiB resident (88.8 GiB peak), the dev Mac exhausted swap, Jetsam killed system daemons and the kernel panicked |
| Blocks | Resuming the TASK-1045 ALaaS → HOPE e2e; production day-1 target of **100 concurrent consultations** |
| Related | TASK-1035 (egress safety decisions), TASK-1036 (egress scope, security review R-B), TASK-947 (composable instructions), TASK-1045 (lifecycle + note composer) |

---

## 1. Requirement Analysis

### 1.1 What the owner asked for (2026-10-06)

> "write this design as a new ticket, we need best practices for best performance and efficiency
> resources consumption. once it landed, you can perform validation tests before resuming the e2e tests."

And the principle behind it:

> "the prompt will be verified, validated, and checked when user composing and building using Prompt
> management interfaces. I believe there is no need to re-process and validate the prompt again, but the
> context information such as transcription, ingest/provided case notes, attachments, etc."

### 1.2 Restated requirement

1. **Authored prompt text is governed once, at authoring time** (Prompt Management approve, agent
   publish), and is **not** re-screened by ML models on every LLM call.
2. **Per-call screening covers only untrusted runtime content**: transcript, case notes, attachments,
   vitals, prior visits, caller-supplied text — everything that was not authored and approved.
3. Screening of runtime content is **bounded and incremental**: memory per inference is capped
   regardless of input length, and text already screened is never screened again.
4. The design must hold **100 concurrent consultations on day 1** with predictable CPU/GPU/RAM, and no
   safety guarantee from TASK-1035 may be lost (no opt-outs; cloud always redact + restore; local
   detect-only; medical judge kept).

### 1.3 Success criteria (all measured, §5)

| # | Criterion | Target |
|---|---|---|
| S1 | NLP peak RSS per inference, any input length up to the 200k-char request cap | ≤ 1.0 GiB above warm baseline |
| S2 | NLP steady-state RSS under the 100-consultation screening load | ≤ 6 GiB per pod (weights ≈ 4 GiB) and flat over a 2 h soak (< 5 % drift) |
| S3 | Characters ML-screened per minute at 100 concurrent consultations | ≤ 2 × the new speech + new attachment text (≈ 150k chars/min), not the whole prompt per call |
| S4 | Window-verdict cache hit rate on a live-summary consultation after the first flush | ≥ 90 % |
| S5 | Inbound screen p95 latency added to an LLM call (warm) | ≤ 300 ms |
| S6 | Medical-judge calls per live consultation | proportional to new text, not to flushes |
| S7 | Security regressions (injection in transcript / attachment / caller text, PHI to cloud, tampered governed prompt) | 0 — all still blocked/redacted |
| S8 | Note quality on the 14-case multi-encounter golden set after the template rewrite | no regression vs TASK-1045 baseline (coverage + citation metrics) |

---

## 2. Current State Evaluation (evidence, 2026-10-06)

### 2.1 Measured: GLiNER2 memory is quadratic in input length and the process keeps its high-water mark

Controlled probe against one `apps/nlp` process, one request at a time (synthetic text, CPU, 16 cores):

| Input chars | `/guard/pii` peak RSS | `/guard/classify` peak RSS | Wall time (pii / classify) |
|---|---|---|---|
| 1,000 | 2.36 GiB | — | 0.6 s |
| 2,000 | — | 1.73 GiB | — / 0.3 s |
| 4,000 | 2.96 GiB | 1.98 GiB | 1.4 s / 0.6 s |
| 8,000 | 4.87 GiB | 2.85 GiB | 3.1 s / 1.5 s |
| 12,000 | — | 4.78 GiB | — / 2.7 s |
| 16,000 | **11.46 GiB** | **7.61 GiB** | 13.1 s / 5.4 s |
| 32,000 | > 12 GiB — probe's safety ceiling killed NLP | — | — |

Repeating the same 8k request ten times plateaus at ≈ 7.8 GiB: **not a per-request leak — high-water
retention**. Under a live consultation NLP went 0.5 → 17–22 GiB within 2 minutes (38–70 threads); overnight
it held 36.8 GiB (Jetsam report `JetsamEvent-2026-10-06-042538.ips`, pid 92947, lifetime max 88.8 GiB),
followed by `panic(...): watchdog timeout: no checkins from watchdogd in 91 seconds`. Today NLP was SIGKILLed
mid-encounter, the dev supervisor did not restart it, guardrail's breaker to NLP opened, every `apps/text`
call failed closed and the note ended `FAILED / NOTE_GENERATION_FAILED`.

Model weights are small — every NLP-served model together is ≈ 6 GiB declared (`AiModel.memorySizeMb`):
`gliner2-privacy-filter-pii-multi` 1.0, `gliner2-guardrails-pii-multi` 1.4, `gliguard-llm-guardrails-300m`
1.0, `medical-ner` 1.0, `minicheck-flan-t5-large` 1.2, `symps-disease-bert-v3-c41` 0.5. The 17–37 GiB is
inference activations.

### 2.2 Why (code, verified)

| # | Cause | Evidence |
|---|---|---|
| C1 | `gliner2` 1.3.2 runs the whole text in one forward pass; `max_len=None` means no truncation and no windowing; span tensor `B × L × 8 × D` | site-packages `gliner2/processor.py:271-310,408-411`, `model.py:47,564-594`; nlp passes no `max_len` (`apps/nlp/src/nlp/services/gliner2_guard.py`) |
| C2 | The inbound **classify** screen sends the whole joined prompt in ONE call, capped only at `maxUntrustedChars` = 100,000 | `apps/guardrail/src/guardrail/services/screening.py:373-375`, `core/policy.py:110` |
| C3 | The joined prompt includes the **system prompt** on every call (TASK-1036 R-B, `49d5d15d8`) | `apps/text/src/text/services/egress.py:170-195,284-290` |
| C4 | Live summary re-sends system prompt + the whole transcript-so-far every flush, and every send is fully re-screened → total screening work grows quadratically over a consultation | `live-documentation.service.ts:505-530,6292-6298` |
| C5 | 4 concurrent inferences × torch threads = all 16 cores (no `NLP_TORCH_NUM_THREADS` / `OMP_NUM_THREADS` set) | `apps/nlp/src/nlp/core/config.py:327`, `torch_runtime.py:104-145` |
| C6 | Guardrail→NLP client: 60 s timeout × 2 attempts; the abandoned `to_thread` inference keeps running | `apps/guardrail/src/guardrail/services/external_nlp_client.py:136-142` |
| C7 | No input bound on NLP guard routes; queued requests (up to 256) hold their text | `apps/nlp/src/nlp/schemas/guard.py:62,110`; `core/config.py` queue depth |
| C8 | Five model caches × 3 models, count-bounded only; the same GLiNER2 weights can be resident twice (guard cache + token-classifier cache) | `apps/nlp/src/nlp/dependencies.py:196-217,275-281,501-525` |
| C9 | Dev supervisor does not restart a killed service | observed 2026-10-06 (`nlp.log`: `Killed: 9`, port 8864 refused for 10+ min) |

The PII path is already chunked at 4,000 chars in guardrail (`api/endpoints/redact.py:80`) — but chunks are
`gather`ed all at once, and the outbound `pii_leak` screen sends the whole response un-chunked.

### 2.3 How prompts are composed today (verified)

`composeMessages` (`packages/workflow-contract/src/compose-messages.ts:158-183`) builds:

- **system** = `platformRules` + `composePrompt(instruction, scope)` + output-language sentence + `outputContract`
- **user** = runtime data wrapped in `<<<EXTERNAL_DATA section="key">>> … <<<END_EXTERNAL_DATA>>>` blocks

The contract's intent ("everything per-encounter is DATA in the user message") is **not enforced**:

| Runtime value that lands in SYSTEM text | Where |
|---|---|
| `{{chief_complaint}}`, `{{safe_age}}`, `{{safe_dob}}`, `{{safe_gender}}`, `{{formatted_vitals}}`, `{{formatted_previous_visits}}`, `{{current_department}}`, `{{visit_type}}` | seeded GM live template `seed/07-prompt-template.ts:1771-1776`; pre-summary templates `07-prompt-template.ts:418-428`, `07d-dept-free-pre-summary-default.ts:72-73`, `07b-arcaai-clinical-content-v3.ts`; bound by `seed/25-agents.ts:727-738`; values from `realtimeRunContext` (`live-documentation.service.ts:4838-4880`) |
| caller `variables` / `context.*` on agent invocations | `agent-invocation.service.ts:340-344` |
| DNA style + redaction text, visit label (as `outputContract`) | `prompt-assembly.service.ts:695-709`, `compose-assembled-prompt.ts:51-70` |
| raw caller `system_prompt` / `prompt` | `POST text-generations/generate` (`text-proxy.controller.ts:745-751`), any API key / service account / JWT with `consultation:report:write`; browser SDK `TEXT_GENERATION_ENDPOINTS.GENERATE` (`agentic-sdk-v2/src/core/constants.ts:606`) |

Only `PromptAssemblyService` replaces nine data variables with a pointer (`[see the X data section below]`,
`prompt-assembly.service.ts:122-124,675-690`); the live lane and agent invocations do not.

**This is why TASK-1036 R-B re-screened the system prompt**: PHI reached cloud providers through it, and
`system_prompt` / variables were an injection bypass. The fix in this ticket removes the cause
structurally instead of screening around it.

### 2.4 What authoring time validates today (verified)

| Stage | Checks | Guardrail screening |
|---|---|---|
| PromptTemplate create/update | DTO `@MaxLength(50000)` | none |
| Approve | ownership split gate; eval golden-set gate if bound (`prompt-management.service.ts:664-760`) | none |
| Agent publish | `PROMPT_TEMPLATE_SYNTAX` (ERROR), `PROMPT_VARIABLE_UNDECLARED` (WARN), fragment/`when` checks (`agent.service.ts:1972-2290`) | none |
| promote-to-system | `entity.validate()`, evalGate stripped | none |

`grep -ciE "guardrail|screen|jailbreak|injection" prompt-management.service.ts` → **0**.

### 2.5 Other per-call costs on the same path

- **Medical judge**: every LLM call → guardrail `/api/medical/validate` → `apps/text /generate/internal/judge`
  → `granite-guardian-4.1-8b` (2.9–3.9 s per call observed). At 100 users × ~3 calls/min that is ≈ 300 judge
  calls/min ≈ 17 continuously busy 8B-model streams — on the same GPU as the note model in production
  (one RTX A6000 48 GB).
- **Outbound screen** (`output_gate.py:202-262`): response safety + `pii_leak` over the full response.
- **LLM prefix reuse is defeated**: runtime values interpolated into the system message make it differ per
  consultation, so vLLM automatic prefix caching (and LM Studio's) cannot reuse the KV cache of the static
  instruction across requests.

### 2.6 Capacity model (assumptions stated)

20-minute consultations; ≈ 750 chars of speech/min; live summary every ≈ 20 s (3 screened LLM calls/min);
measured screening cost ≈ 0.5 s per 1k chars at 16 threads (both checks, best case — larger inputs cost
super-linearly).

| Approach | Chars ML-screened per minute (100 users) | Compute |
|---|---|---|
| Today (whole prompt per call, avg ≈ 10k chars) | ≈ 3,000,000 | ≈ 25 × 16-core nodes — infeasible, and memory-unbounded |
| Windowing only | ≈ 3,000,000 | same compute, memory bounded |
| **This ticket** (governed system prompt skipped; data windows cached; only new text screened) | ≈ 75,000–150,000 | ≈ 0.6–1.2 × one 16-core node on CPU, or a small GPU slice |

---

## 3. Best practices applied (research)

| Practice | Source | Applied as |
|---|---|---|
| Separate trusted instructions from untrusted data; label untrusted content; trust boundaries | OWASP Top 10 for LLM Apps, LLM01 Prompt Injection | System message = governed authored text only; all runtime data in labelled `EXTERNAL_DATA` blocks (D1) |
| Govern prompts as versioned artifacts; validate at write time | OWASP LLM01 / LLM07 (system prompt leakage) | Screen at approve/publish, pin a digest (D2) |
| Encoder NER/classifiers have a bounded context; long text is processed with overlapping sliding windows, boundary spans de-duplicated | GLiNER papers and implementations (sliding window + overlap; GLiNER2.5 `max_len`) | Region-aligned windows + hard `max_len` (D4, D6) |
| Prefix caching needs stable content first, variable content last, deterministic serialisation | vLLM Automatic Prefix Caching design docs | Static system message; data blocks in a fixed order, growing transcript last (D1, D9) |
| Cache deterministic, idempotent results by content address; never key on raw PHI | General security practice (HMAC keys, no plaintext in keys) | HMAC-keyed window-verdict cache, offsets only (D5) |
| Bound every queue, deadline every call, cancel abandoned work, recycle workers that ratchet memory | SRE practice (load shedding, deadline propagation, `--max-requests` recycling) | D7, D8 |

Sources: [OWASP LLM01](https://aicsr.georgelambert.org/output/references/articles/owasp-llm01.md),
[Separating trusted instructions from untrusted data](https://promptessor.com/blog/prompt-injection-how-to-separate-trusted-instructions-from-untrusted-data),
[GLiNER multi-task (arXiv 2406.12925)](https://arxiv.org/pdf/2406.12925),
[GLiNER long-text chunking discussion](https://github.com/urchade/GLiNER/issues/82),
[vLLM Automatic Prefix Caching](https://docs.vllm.ai/en/stable/design/v1/prefix_caching.html),
[Prefix caching handbook](https://handbook.modular.com/inference-optimization/prefix-caching/).

---

## 4. Design

### D1 — The system message is governed text only (structural boundary)

- `composeMessages` (TS contract + the Python mirror `apps/harness/.../interpreter/compose_messages.py`,
  held by the shared fixture) renders **no runtime value into the system message**. Every template variable
  reference becomes a fixed pointer (`[see the <name> data section below]`) and the value is emitted as an
  `EXTERNAL_DATA` block named after the variable — the mechanism `PromptAssemblyService` already uses for
  nine sections, generalised into the contract so every path (live lane, agent invocation, assembled
  generate, workflow `core.agent`, harness) gets it.
- `when` conditions over scope still select fragments (selection is a function of governed pieces — §D2).
- DNA style **samples** move to the existing `style_reference` block; the DNA *rule text* stays static.
- `outputContract` additions that are platform constants (few-shot guidance, note-input guidance, turn
  instructions, correctives) stay in system and are registered as platform pieces (D2).
- Result: for a given (agent version, selected fragments, language) the system message is **byte-identical
  across all consultations and calls**.

### D2 — Authoring-time screening and a governed-piece registry

- A **governed piece** = one static text unit: the platform rules, each platform outputContract constant,
  each output-language sentence, each template body / fragment of an approved PromptVersion or published
  agent.
- On **PromptTemplate approve**, **agent publish** and **promote-to-system**, every piece is screened once by
  guardrail (prompt safety, jailbreak/injection, PII-in-template). Findings: `PROMPT_SCREENING_UNSAFE`,
  `PROMPT_SCREENING_INJECTION`, `PROMPT_CONTAINS_PII` (ERROR, block publish — no override, TASK-1035 "no
  opt-outs") and `PROMPT_SCREENING_UNAVAILABLE` (ERROR — fail closed: an unscreened piece is never governed).
- Registry: new model `GovernedPromptPiece` — `digest` (sha256 of the exact text, unique per tenant),
  `kind` (`PLATFORM | TEMPLATE_BODY | FRAGMENT | CONTRACT | LANGUAGE`), `sourceRef`, `policyVersion`,
  `verdict`, `screenedAt`. Platform pieces are registered at gateway boot (code-reviewed constants; also
  screened once by a CI test so a bad edit fails the build).
- A **policy-version change** (guardrail model or taxonomy) invalidates verdicts: a re-screen job walks the
  registry (bounded, background) and re-publishes nothing — it only refreshes verdicts, flagging any piece
  that now fails.

### D3 — Per-call: verify the system message by digest, screen data only

- The gateway composer attaches `systemGovernance = { digests: [piece digests in order], composedDigest }`
  to the internal `apps/text` request (service-token authenticated, the existing internal trust anchor).
- `apps/text` recomputes `sha256(system)` and checks it equals `composedDigest` and that the concatenation
  of the listed pieces (with the contract's fixed joiner) reproduces the system text; each digest must be
  in the registry snapshot the gateway sends (or a gateway lookup cached per digest).
  - **match** → the system message skips the ML screen, the medical judge and ML PII detection.
  - **mismatch / absent** (e.g. caller `system_prompt`, a non-gateway caller) → the system text is treated
    as **untrusted data** and goes through the full data path (D4–D6). No bypass is possible: the cheap
    path is only reachable by text the registry vouches for.
- **Cloud pseudonymisation** keeps the exact-match `known_phi` pass over *every* segment (string match,
  microseconds) as defence in depth; ML span detection runs on data blocks only.
- **Outbound `pii_leak`** source context = data blocks (+ untrusted segments), not governed text.

### D4 — Region-aligned windows for every ML screen

- Each data block (and each untrusted segment) is a **region**; windows are cut from the region's own
  start: size `W`, overlap `O` (default 4,000 / 256 — the realtime plane's geometry; final values from the
  V2 sweep, OD-6). An append-only region (the transcript) therefore yields byte-identical earlier windows
  on every flush.
- Applied to: inbound classify, inbound PII spans, outbound response screen, `pii_leak`, the medical judge
  (OD-5). Spans are re-based to region offsets; overlap duplicates resolved longest-span-wins.
- Windows of one request run through a bounded per-request concurrency (not `gather` of all).

### D5 — Window-verdict cache (content-addressed, PHI-safe)

- Key: `HMAC-SHA256(tenantKey, policyVersion ‖ modelDigest ‖ task ‖ windowText)`; `tenantKey` from Vault
  KV (rotatable; rotation = cold cache, never wrong answers). Value: verdict, scores, span offsets/labels —
  **never text**. Store: Redis (shared by guardrail replicas), TTL 24 h (setting).
- Hit → no NLP call. Miss → NLP, then write. Metrics: windows requested / computed / cached per task.

### D6 — NLP bounded inference

- Hard input bound on every guard route and `/classify/tokens`: `len(text) ≤ maxWindowChars` (setting,
  default `W + O`); above it → **413 `INPUT_EXCEEDS_WINDOW`** (callers window; nothing silently truncated).
  Plus `max_len` passed to gliner2 as a second fence.
- Torch threads per inference = `cpu_limit / inference_max_concurrent` (both settings), OMP/MKL aligned.
- Uniform window sizes make the existing MicroBatcher pad little and batch well.
- Process model: N uvicorn workers (setting) each with its own bound, and **worker recycling after K
  requests or RSS > limit** (setting) so allocator retention cannot ratchet.
- One GLiNER2 weight identity loaded once per process (guard and token-classifier caches share a
  weight-keyed registry — fixes C8).

### D7 — Deadlines, cancellation, no amplification

- Guardrail→NLP deadline derived from NLP's queue ceiling + p99 window latency (setting), **no retry while
  the first attempt may still be running**; cancellation propagates to the NLP worker (inference checks a
  cancel flag between batches).
- Load-shedding 503 stays; queue depth bounded per lane.

### D8 — Operability

- Prometheus: NLP RSS/peak per worker, windows computed vs cached, cache hit ratio, screen latency
  histograms by task, judge calls per consultation, 413 counts. Alerts: RSS > 80 % of limit, hit ratio
  < 70 %, shed rate > 1 %.
- Kubernetes (`hope-v2-deployment`): NLP requests/limits sized from V4 (expected ≈ 6–8 GiB/pod), HPA on
  queue depth; guardrail stateless behind the Redis cache.
- Dev: `scripts/dev-service.sh` / the stack supervisor restarts a service that exits (bounded backoff) and
  logs the exit signal (C9).

### D9 — Prompt layout for prefix caching (LLM efficiency, same change)

Message order fixed: governed system (identical across consultations) → stable data blocks (encounter
metadata, prior visits, case notes, attachments) → growing data (transcript) last. Deterministic block
serialisation. This lets vLLM/LM Studio reuse the instruction's KV cache across all requests and the
stable-context KV across a consultation's flushes.

---

## 5. Implementation Plan

### 5.1 Layer order

Database (GovernedPromptPiece) → workflow-contract (TS + Python mirror + fixture) → applications (composer
callers, authoring screening, governance attachment) → apps/api (findings surfaced, deprecation header) →
apps/text (egress) → apps/guardrail (windows, cache, judge, deadlines) → apps/nlp (bounds, threads,
workers) → seeds (template rewrite) → SDKs (deprecation note) → deployment repo (limits/HPA) → docs.

### 5.2 Lanes (one worktree each; the orchestrator owns DB migration, `pnpm install`, merges, gates)

| Lane | Agent / tier | Owns (no other lane edits these) | Delivers |
|---|---|---|---|
| L1 contract | hope-lane-deep / opus | `packages/workflow-contract/**`, `apps/harness/src/harness/temporal/interpreter/compose_messages.py` + `templating.py`, `tests/contracts/*compose*` / prompt fixtures | FC-1, FC-2 in TS + Python mirror, fixture parity |
| L2 gateway composers | hope-lane-deep / opus | `packages/applications/src/services/consultation/{live-documentation,prompt,note-composition}/**`, `services/agent/agent-invocation*`, text-generation compose/enrichment (`compose-assembled-prompt*`, `text-request-enrichment*`), every applications call site that posts `system_prompt` to apps/text | all gateway paths on FC-1; FC-4 attached after `areGoverned`; DNA samples → `style_reference` |
| L3 registry + authoring screening | hope-lane-deep / opus | `packages/domains` GovernedPromptPiece trio + `CoreDatabaseModule` registration, `services/governed-prompt/**` (new), `services/prompt-management/**`, `services/agent/{agent.service,agent-findings,agent-promote-to-system}*` | FC-3: registry service, approve/publish/promote screening + findings, compiledConfig stamping, boot platform registration + backfill |
| L4 text egress | hope-lane-deep / opus | `apps/text/src/text/services/{egress,data_blocks,output_gate,external_guardrail}.py`, `models/requests.py`, `api/endpoints/generate.py` (+ stream variants) | FC-4 verify, regions per FC-5, `known_phi` over all segments, pii_leak source = regions |
| L5 guardrail | hope-lane-deep / opus | `apps/guardrail/src/guardrail/**` (screen/redact/medical endpoints, screening, safety_analyzer, pii_extraction, external_nlp_client, policy, new window_cache) | FC-5, FC-7, OD-5 window judging, D7 deadlines, `policy-version` route |
| L6 nlp | hope-lane / sonnet | `apps/nlp/src/nlp/**` | FC-8 bounds, threads, shared weight registry, worker recycling |
| L8 ops + settings | hope-lane / sonnet | `settings-registry/descriptors/{service-runtime,platform-secrets}.descriptors.ts`, `scripts/dev-service.sh` + the stack supervisor script, `.env.sample`s, `turbo.json` | FC-8 descriptors, `GUARDRAIL_WINDOW_CACHE_KEY` vault-kv descriptor, supervisor restart with backoff |
| L9 API + SDK deprecation | hope-lane / sonnet | `apps/api/src/modules/streaming/text-proxy.controller.ts`, `packages/agentic-sdk-v2/src/core/constants.ts` JSDoc, `docs/operations/deprecation-register.md` | OD-3 deprecation header on raw `system_prompt`, strip caller `system_governance`, SDK JSDoc, register entry |
| L10 harness callers | hope-lane / sonnet | `apps/harness/src/harness/**` EXCEPT L1's two files | FC-6 |
| L11 validation tooling | hope-lane / sonnet | `apps/nlp/scripts/bench_guard_memory.py`, `scripts/perf/screening-replay/**`, `scripts/perf/screening-load/**` (new) | V2–V4 harnesses (bench, replay, 100-consultation load + soak) |

Seed templates need no rewrite for correctness (FC-1 renders pointers automatically); wording polish is
deferred until after the V6 golden set. The deployment-repo NLP limits/HPA are sized after V4 (OD-8).

The orchestrator authors the Prisma model + migration (`task_1047_governed_prompt_piece`) on a shadow DB
before L3 starts (rule 02).

### 5.3 TDD test list (RED first, per lane)

| Lane | Tests |
|---|---|
| L1 | a runtime value referenced in an instruction never appears in `system`; it appears as a block named after the variable; system byte-identical for two scopes differing only in data; Python mirror passes the same fixture; digests stable for identical pieces |
| L2 | live lane / agent invocation / assembled / harness compose put vitals, prior visits, chief complaint, caller variables in blocks; `systemGovernance` present and correct; DNA samples in `style_reference` |
| L3 | approve/publish refused with `PROMPT_SCREENING_INJECTION` / `_UNSAFE` / `PROMPT_CONTAINS_PII`; refused with `_UNAVAILABLE` when guardrail is down; clean piece registered with digest + policyVersion; promote-to-system screens; policy-version bump re-screens |
| L4 | governed system skips the ML screen and judge; tampered system (one byte) → screened as untrusted; caller `system_prompt` → screened; `known_phi` redacted in system for cloud; data blocks screened; `pii_leak` source = data |
| L5 | 100k-char region → windows of ≤ W; append-only region re-screen computes only the tail window (cache hit for the rest); cache key never contains text; spans re-based and deduped across overlap; judge per changed window (OD-5); no retry while first attempt running; deadline respected |
| L6 | text > bound → 413 `INPUT_EXCEEDS_WINDOW`; `max_len` passed; thread count = limit / concurrency; same weights loaded once across caches; worker recycles at threshold |
| L1+ | every SEEDED agent/template composes with no runtime value inside system (render all seeded prompts over a sample scope in a contract test) |
| L9 | raw `system_prompt` answers with `Deprecation`/`Sunset` headers and is forwarded WITHOUT governance; a caller-sent `system_governance` is stripped |
| L10 | harness sends FC-4 only when every piece digest is in `compiledConfig.governance`; mismatch / missing → no field |
| L11 | bench/replay/load scripts run against stubs in their own unit tests (argument parsing, metric math) |
| L8 | descriptors registered with fail modes; supervisor restarts a killed child (shell test) |

### 5.4 Verification before resuming the TASK-1045 e2e (the owner's gate)

| ID | Validation | Pass |
|---|---|---|
| V1 | Layer gates after full merge: domains/applications/api build + unit, `apps/{text,guardrail,nlp,harness}` pytest + ruff + mypy, workflow-contract parity, `gen:*` drift checks, `api:openapi:check` | all green (output pasted) |
| V2 | **NLP memory benchmark** (committed: `apps/nlp/scripts/bench_guard_memory.py`, the probe from this incident): sizes 1k–200k via the guardrail path; window-size sweep 1k/2k/4k on the PII golden set (accuracy, latency, peak RSS) → OD-6 values | S1; accuracy ≥ unwindowed baseline |
| V3 | **Replay efficiency**: replay a recorded live consultation's call sequence (flush cadence) through `apps/text` → guardrail → NLP; count windows computed vs cached, judge calls | S3, S4, S6 |
| V4 | **Load + soak**: 100 simulated consultations at realistic cadence against text/guardrail/NLP (LLM stubbed for the screening plane), 2 h; RSS, CPU, p95, shed rate | S2, S5, no crash, RSS flat |
| V5 | **Security regression suite**: injection in transcript, attachment, case note, caller text, caller `system_prompt`; PHI in data to cloud (redacted + restored); tampered governed text; guardrail down → fail closed | S7 |
| V6 | **Golden set** (14 multi-encounter cases) before/after the template rewrite on Gemma 4 E2B 32k | S8 |
| V7 | Then **resume TASK-1045 e2e** from scratch (headless E1/E2, UI flows, console) with the memory monitor running throughout | — |

### 5.5 Rollout

1. Merge behind no flag — the boundary is a correctness property, not an option. Order of merge:
   contract + composers (D1) and NLP bounds (D6) first (they are safe on their own), then registry +
   authoring screening (D2), then egress digest skip (D3) — the skip only activates when the registry
   vouches, so partial rollout never weakens screening.
2. Existing published agents/templates: a one-time **backfill job** screens and registers every current
   approved/published piece; anything failing is listed for the owner, not auto-unpublished.
3. Cluster: deployment-repo PR with NLP limits/HPA sized from V4; promotion through the normal digest
   pipeline.

---

## 6. Decisions for the owner

| ID | Decision | Options | Recommendation |
|---|---|---|---|
| OD-1 | Per-call ML screening scope | (a) data blocks + untrusted segments only, governed system verified by digest; (b) keep screening the system prompt per call | **(a)** — removes TASK-1036 R-B's cause structurally (no runtime value in system), keeps every untrusted input screened; amends TASK-1036's per-call scope, not TASK-1035's guarantees |
| OD-2 | Closed-vocabulary values (department, visit type, output language) | (a) also data blocks — system fully static; (b) allow inline as validated enums | **(a)** — simplest verification, maximal prefix-cache reuse |
| OD-3 | Raw caller `system_prompt` on `POST text-generations/generate` (and SDK `GENERATE`) | (a) screened as untrusted now + deprecated one release (`prompt_template_id` / agent invocation instead); (b) keep indefinitely, screened | **(a)** |
| OD-4 | Authoring-time screening failure | (a) blocking ERROR, no override; (b) warning | **(a)** — TASK-1035 "no opt-outs"; guardrail down also blocks publish |
| OD-5 | Medical judge | (a) per changed data window, cached; (b) per call on whole context (today) | **(a)** — today ≈ 17 continuously busy 8B streams at 100 users |
| OD-6 | Window geometry | 4,000/256 default; final from the V2 sweep | sweep decides; owner confirms |
| OD-7 | Verdict cache | (a) Redis, HMAC keys from Vault, TTL 24 h, offsets only; (b) per-process LRU | **(a)** |
| OD-8 | Production NLP placement | (a) CPU pods sized from V4; (b) GPU slice on the A6000 | decide after V4; (a) expected sufficient |
| OD-9 | Outbound screening | windowed + cached like inbound | yes |

---

**Owner approval (2026-10-06):** "approved the recommendations" — OD-1 (a), OD-2 (a), OD-3 (a), OD-4 (a),
OD-5 (a), OD-6 sweep-decided (default 4,000/256), OD-7 (a), OD-8 after V4, OD-9 yes. Execution: lanes on
model/effort tiers within a token budget, maximum parallelism, no overlapping ownership.

### 6.1 Frozen cross-lane contracts (orchestrator, 2026-10-06 — lanes code against these)

**FC-1 Pointer rendering (L1).** In the system message EVERY template placeholder renders as the fixed
pointer `[see the <block> data section below]`, where `<block>` = the placeholder path lower-cased with every
non `[a-z0-9]` run replaced by `_` (e.g. `trigger.context.formatted_vitals` → `trigger_context_formatted_vitals`;
an existing data-section alias — `PromptAssemblyService`'s nine — keeps its existing block name). The value
(resolved, or its `default("…")`) is emitted as an `EXTERNAL_DATA` block of that name; one block per distinct
name. Unresolved without default → the existing `PromptVariableUnresolvedError`. `{{{{` escapes unchanged.
**User-message block order (D9):** placeholder blocks in first-appearance order, THEN the caller's data blocks
in their given order (stable context first, growing transcript last). A placeholder whose block name equals a
caller block does not duplicate it.

**FC-2 Pieces and digests (L1 defines, L2/L3/L4/L10 consume).** `digest(text) = sha256(utf8(text))` lower-case
hex. The system message is the ordered pieces joined exactly as today: `platformRules` (kind PLATFORM) ‖
the instruction pieces — the rendered template body (TEMPLATE_BODY) or each selected composite fragment
(FRAGMENT) joined with the template's `join` ‖ the output-language sentence (LANGUAGE) ‖ each `outputContract`
part (CONTRACT); layers joined by `MESSAGE_LAYER_JOIN`. `composeMessages` additionally returns
`governance: { pieces: [{ kind, key, digest }], composedDigest }` where `composedDigest = digest(system)`.
Every piece is static text after FC-1 (no runtime value) — a piece that still contains runtime data is a
contract violation the L1 tests must catch. The input gains `blockAliases` (path → block name) and `outputContractParts`
(`[{key, text}]`, each a CONTRACT piece; a plain `outputContract` string is one part keyed `contract`). Piece
keys: platform rules `platform-rules@<PLATFORM_RULES_VERSION>`, template body `body`, fragment = its key,
language `language:<name>`, contract part = its key. **Python mirror shape** (snake_case):
`result["governance"] = {"pieces": [{"kind", "key", "digest"}], "composed_digest": str}`.

**FC-3 Registry (L3).** `GovernedPromptPiece` (migration `20261006040234_task_1047_governed_prompt_piece`).
Service token `IGovernedPromptRegistry` (`packages/applications/src/services/governed-prompt/`):
`screenAndRegister(tenantId, pieces[{kind, sourceType, sourceId, sourceKey, text}]) → {passed, findings[]}`
(authoring-time; calls guardrail inbound screen on each piece's text as REGIONS per FC-5; registers PASS/FAIL);
`areGoverned(tenantId, digests[]) → boolean` (all digests PASS under the CURRENT `policyVersion`, read
[tenant, SYSTEM]; in-process LRU by `(digest, policyVersion)`, TTL 300 s). Platform pieces (platform rules,
platform outputContract constants, language sentences) are registered under SYSTEM at gateway boot
(`sourceType PLATFORM`). Composers call `registerPlatformPieces(pieces)` (idempotent, background screening) for PLATFORM / CONTRACT / LANGUAGE pieces they emit. Publish/approve stamp `compiledConfig.governance = { policyVersion, pieceDigests }`
on the agent (for the harness, FC-6). A boot backfill screens every published agent / approved version
without registry rows; until screened, its calls take the full-screening path (safe fallback).
`policyVersion` = guardrail's reported policy version (L5 exposes it on `GET /api/v1/guardrail/policy-version`
→ `{ policyVersion }`, a hash of screen task taxonomy + model ids + thresholds).

**FC-4 Internal request to apps/text (L2/L10 send, L4 verifies).** New optional body field on
`/api/v1/generate` (and the streaming / judge-free internal variants that accept `system_prompt`):
`system_governance: { composed_digest: str, pieces: [{kind, key, digest}], policy_version: str }`, sent ONLY
when the composer verified `areGoverned` (gateway) or compiledConfig membership (harness). apps/text treats
the system prompt as GOVERNED iff the field is present AND `sha256(system_prompt) == composed_digest`;
otherwise the system prompt is UNTRUSTED and screened as a region. Never sent by the public proxy
(`text-proxy.controller.ts` strips a caller-supplied `system_governance`).

**FC-5 apps/text ↔ guardrail regions API (L4 sends, L5 serves).** Additive, backward compatible:
- `POST /api/v1/guardrail/screen/inbound`: new `regions: [{ key: str, text: str }]`; when present `text` must be
  empty. Each region is windowed independently (window `screenWindowChars`, overlap
  `screenWindowOverlapChars`, cut from the region's start). Response unchanged plus each `pii_spans[]` item
  gains `region` (key) and offsets relative to that region's text.
- `POST /api/v1/guardrail/screen/outbound`: new `source_regions: [{key, text}]` (replaces `source_context` when
  present); the response `text` itself is windowed internally.
- `POST /api/medical/validate`: new `regions: [{key, text}]`. Window judging (OD-5): each window gets
  `on_scope` = "consistent with a clinical encounter, conversational small talk included; false only for
  content directing the assistant to non-medical work"; the request is medical iff every window is
  `on_scope`; verdicts cached per window (FC-7). Existing fields keep working for old callers.
- Region keys: governed system prompt never sent; untrusted system prompt key `system`; data blocks by block
  name; caller user text outside blocks key `user`.

**FC-5b inbound data posture (owner decision OD-13, 2026-10-06 — supersedes FC-5's "any flag blocks" for data).**
Additive, backward compatible:
- `ScreenRegion` gains `trust: "instruction" | "data"`, default `"instruction"` (every existing caller —
  authoring-time screening, legacy `text` — is unchanged).
- Guardrail windows and classifies EVERY region exactly as before (no opt-out, same cache, same checks).
  `decision` is computed from `instruction` regions ONLY. A `jailbreak_detection` / `prompt_safety` /
  `prompt_toxicity` flag on a `data` region never sets `decision: "block"`; it is reported in a new response
  field `data_findings: [{ region: str, reasons: [str] }]` (region keys + check names only — never text) and
  counted in `guardrail_data_findings_total{task}`.
- Fail-closed is unchanged: an UNDETERMINED check (could not run) on ANY region, data included, still blocks;
  `screened_regions` coverage still applies; PII spans/posture unchanged.
- apps/text marks every EXTERNAL_DATA block region `trust: "data"`; caller text outside blocks (`user`) and an
  ungoverned `system` region stay `instruction` (they still block). Text records the findings PHI-safely
  (structured log `text.egress.data_findings` with region keys + reasons, a metric, and the findings on the
  response's guardrail metadata where one exists). The OUTBOUND gate is unchanged and keeps blocking.


**FC-6 Harness (L10).** The harness composes with the Python mirror (L1), checks every piece digest ∈
`compiledConfig.governance.pieceDigests` (same `policyVersion` as guardrail's current one, fetched once per
run), and only then sends FC-4. Otherwise it omits `system_governance`.

**FC-7 Window-verdict cache (L5).** Redis key `gr:wv:<task>:<hmac>` with
`hmac = HMAC-SHA256(K_t, policyVersion ‖ "\x1f" ‖ modelId ‖ "\x1f" ‖ task ‖ "\x1f" ‖ windowText)`,
`K_t = HMAC-SHA256(GUARDRAIL_WINDOW_CACHE_KEY, tenantId)`. Value JSON: verdict fields + spans as
`[label, start, end, score]` relative to the window — never text. TTL `windowCacheTtlSeconds` (86,400).
Key secret `GUARDRAIL_WINDOW_CACHE_KEY` is a platform `vault-kv` secret (L8 descriptor); ABSENT ⇒ cache
disabled (compute every window), never a skip.

**FC-8 NLP bounds (L6) and setting names (L8 registers, L6 reads).** Guard routes and `/classify/tokens`:
`len(text) > nlp.inference.maxInputChars` (default 8,192) → **413** `{"code":"INPUT_EXCEEDS_WINDOW","maxChars":N}`;
`max_len` passed to gliner2 (words, `nlp.inference.maxInputWords`, default 2,048).
`nlp.inference.threadsPerInference` (0 = `cpu_count // maxConcurrent`, min 1);
`nlp.worker.recycleAfterRequests` (default 2,000) and `nlp.worker.recycleRssMib` (default 12,288 — raised from 6,144 by F6, §8.1: after a
response the worker exits gracefully above it; the supervisor/uvicorn restarts it). Guardrail policy keys
(in `apps/guardrail/.../core/policy.py`, L5): `screenWindowChars` 2,000 (4,000 until the OD-6 re-decision, §8.5), `screenWindowOverlapChars` 256,
`screenWindowConcurrency` 4, `windowCacheTtlSeconds` 86,400, `nlpDeadlineSeconds` (default 30),
and `screenWindowChars + screenWindowOverlapChars` must be ≤ nlp `maxInputChars`.

## 7. Risks

| Risk | Mitigation |
|---|---|
| Moving T2–T4 out of the system text changes note quality on a 2B model | V6 golden set before/after; pointer wording tuned in L7 |
| A span split across a window boundary is missed | overlap ≥ longest expected entity; V2 accuracy vs unwindowed baseline |
| Cache poisoning / cross-tenant reuse | tenant-keyed HMAC; policyVersion + model digest in the key; values carry no text |
| Registry drift (platform constant edited without re-screen) | boot registration + CI screening test; digest mismatch falls back to full screening, never to skip |
| Interim: TASK-1045 e2e blocked until this lands | owner accepted (2026-10-06): validation V1–V6 before V7 |

---

## 8. Implementation Summary

Owner go 2026-10-06 (all OD recommendations approved). Orchestrator-authored base: model + migration
`20261006040234_task_1047_governed_prompt_piece`, frozen contracts FC-1…FC-8 (§6.1) and type seams
(`SystemGovernance`, `IGovernedPromptRegistry`), committed before any lane started.

| Lane | Tier | Merged | Delivered |
|---|---|---|---|
| L1 contract | opus | `f7f587a9f` | FC-1 pointer rendering + FC-2 piece digests in `composeMessages` (TS) and the Python mirror, one fixture; pure-TS `sha256Hex` (the package is imported by admin-console client components); contract test over every seeded prompt |
| L2 composers | opus | `9c2d3b909` | every gateway path free of runtime values in system text (prompt-assembly via `blockAliases`, live lane, agent invocation, assembled route, note plan); DNA samples → `style_reference`; D9 block order; FC-4 decided once in `text-request-enrichment` (`areGoverned` + digest check); note-plan calls carry `systemGovernance` |
| L3 registry | opus | `cb18d6e32` | GovernedPromptPiece domain trio; `GovernedPromptRegistryService`; authoring screening on approve / publish / promote-to-system (four ERROR findings, fail closed); `compiledConfig.governance` stamp; boot backfill; per-tenant policy version |
| L4 text egress | opus | `cdbc2f117` | digest-verified governed system skips ML screen + judge; untrusted text screened as regions; spans re-based per segment; `known_phi` over all segments; `source_regions`; fail-closed `screened_regions` coverage check (version-skew guard); whole-text judge cache removed |
| L5 guardrail | opus | `47dc67f71` | region windows on every path (the C2 fix), FC-7 HMAC window cache, windowed medical judge (`medicalWindowScopeCriteria`, seeded), NLP deadline with no retry once sent, NLP 413 = undetermined (blocks), `policy-version` route, `screened_regions` echo, metrics |
| L6 nlp | sonnet | `593c95252` | 413 `INPUT_EXCEEDS_WINDOW` before semaphore/model on every route (multi-label added by the orchestrator), gliner2 `max_len`, threads per inference, shared weight registry, post-response worker recycling |
| L8 ops | sonnet | `4db77f114` | FC-8 descriptors, `GUARDRAIL_WINDOW_CACHE_KEY` vault-kv secret, dev supervisor restart with backoff, `--limit-max-requests` |
| L9 deprecation | sonnet | `a4ad7c8cb` | raw `system_prompt` → Deprecation/Sunset + counter; caller `system_governance` stripped; SDK JSDoc; register entry |
| L10 harness | sonnet | `d89878811` | `core.agent` + note-plan calls forward governance; 25 harness tests moved to the pointer contract |
| L11 validation tools | sonnet | `38f1162d4` | `bench_guard_memory.py` (V2), `screening_replay.py` (V3), `screening_load.py` (V4) |
| L12 verify route | sonnet | `29ca89b9c` | `POST internal/governed-prompts/verify`; harness confirms the whole digest set through it (FC-6 gap) |
| G1–G3 gate fixes | sonnet | `8e404b25a`, `9099fe6c8`, `101ae4fa5` | test isolation (structlog cache, env tokens, Prometheus registry), tests moved to the pointer contract, new tag, env-file / tenant-scope / checkpoint registry entries |

Orchestrator integration on `dev-2.2`: authoring pieces render through the contract
(`renderTemplatePointers` + `sha256Hex`) and register both pointer variants (derived + prompt-assembly
aliases) — `tests/contracts/governed-piece-digest-parity.contract.test.ts` proves authoring digest ==
call-time digest for all 65 seeded prompts on both composer paths; registry wired into text-request and
note-composition modules; note plans return governance and carry the style reference; artifacts
regenerated (route manifest, openapi, portal, vox-node admin); gate fixes incl. a **clinical-safety
regression from TASK-1045 `3439b86fd`**: coverage accepted "TDS" as covering a twice-daily fact —
frequency/duration words are now generic in term matching.

**Gate (single pass after full merge, orchestrator only, 2026-10-06):** typecheck, lint, ruff, mypy
(text/guardrail/nlp/harness), openapi/portal/gen:admin checks, env-sync, gen model/entity/factory drift —
all 0; TS unit 32,087 passed / 0 failed; text 2,106, guardrail 659, nlp 797, harness 3,663, perf tools 27
passed; vox, vox-node, admin-console tests + build, SDK build/exports/codegen, ALaaS tsc/jest/web — all 0.
Known out of scope: 8 Python files not black-formatted predate TASK-1047 (black is not the lint gate).

Follow-ups recorded: deployment repo NLP pod `--limit-max-requests` + limits/HPA (after V4, OD-8);
seed template wording for pointers (after V6).

### 8.1 Fixes from live validation (local stack, `hope_1045_e2e`, 2026-10-06)

| Id | Commit | Found | Fix |
|---|---|---|---|
| F1 | `60e1203aa` | NLP reached 7 GiB RSS on the boot backfill: batches were capped by item COUNT, so several 8k-char regions shared one GLiNER2 forward pass (memory is quadratic in the padded batch) | Character-budget batching, `nlp.inference.maxBatchChars` (default 8192). A single over-budget item still gets its own pass (it is already ≤ the 8192-char window). Measured peak after the fix: 2.7–5.4 GiB |
| F2 | `2be91fed5` | A backfill pass that met a cold NLP left every source UNAVAILABLE until the next restart | UNAVAILABLE sources (never FAIL) are retried with doubling backoff, `governedPrompt.backfillRetryMinMs` 30 s → `backfillRetryMaxMs` 15 min; a policy-version change re-runs the full pass |
| — | `9383196a4` | The new knobs had no descriptors (ungoverned) | Descriptors for `governedPrompt.screenTimeoutMs`, `backfillRetryMinMs`, `backfillRetryMaxMs`, `nlp.inference.maxBatchChars` |
| F3 | `360caea3c` | The core note-finalisation instruction FAILED as `PROMPT_CONTAINS_PII`: it NAMES categories ("replace any … phone number or email") and GLiNER2 labels the word `email` at 0.968 | **Owner decision "Validate span values":** a PII span counts only when the sliced span text is an actual value (`pii-value.ts`: email needs `@` + domain, phone ≥ 7 digits, ID ≥ 4 digits, date/address a digit, name a capitalised proper name that is not a role word; `[NAME]`-style placeholders never count) |
| F4 | `68b768b88` | After F3, two classes still blocked legitimate authoring: a dated EXAMPLE ("12-Mar-2026") and `prompt_toxicity` on a clinical return-visit fragment | **Owner decision "Scope it":** BLOCKING (FAIL, publish/approve refused) = injection/jailbreak, direct-identifier PII values (name, contact, identifier, street address), screening unavailable, and a block that names no reason. ADVISORY (registered PASS, surfaced as a `WARNING` finding) = safety/toxicity (`PROMPT_SAFETY_ADVISORY`) and quasi-identifier values (date, age, place, facility, unknown label) with no direct identifier in the same piece (`PROMPT_QUASI_IDENTIFIER_ADVISORY`). Boot backfill paced: one source at a time, starting after `governedPrompt.backfillInitialDelayMs` (default 60 s, 0 = at once) so NLP loads its models first |
| F5 | `c4a2844ac` | After F3/F4, all 14 Global specialty templates still FAILED as `PROMPT_CONTAINS_PII`. Probe of every flagged span: 31 of 31 were drug + dose in example notes labelled `full_name` (`Shelcal 500 mg` ×22, `Metformin 500 mg` ×8, `Ecosprin 75 mg` ×1) | A name-labelled span containing a digit is never a person's name |
| F6 | `c4a2844ac` | The NLP worker restarted on almost every long-template screen: the warm working set with all screening models loaded peaks at 5.4–5.7 GiB, right at the FC-8 recycle ceiling of 6,144 MiB. After the first response over the ceiling the worker SIGTERMs itself, guardrail's NEXT check call (one screen makes several NLP calls) finds no listener, and guardrail fails closed → 503 | Default `nlp.worker.recycleRssMib` raised to 12,288 (≈2× the measured working set) in both the descriptor and `apps/nlp` bounds — a leak backstop, not a per-request event. Deployment follow-up: the NLP pod limit must sit above it, and production runs ≥ 2 workers or replicas so a recycle never leaves guardrail with no listener |

Rationale for F4's split: under HIPAA Safe Harbor a date or a place identifies only alongside the person
it belongs to, so an instruction carrying an example date is not PHI on its own; the runtime path still
screens every DATA region in full (D3), so an advisory at authoring time never weakens call-time egress.

### 8.2 Validation results (local stack, Apple Silicon, 2026-10-06)

**Boot backfill (after F4–F6):** 135 sources, 116 already governed, 19 screened → 19 PASS, 0 FAIL,
0 UNAVAILABLE; one pass in ~60 s after the 60 s delay; no NLP restart. 7 rows carry an ADVISORY finding.
One stale FAIL row remains for a digest no current source renders (pre-F3 rendering) — inert.

**V2 / S1 — `bench_guard_memory.py`** (RSS deltas over the warm baseline; warm baseline with every
screening model loaded ≈ 4.7–5.1 GiB on this Mac):

| Path | Size (chars) | Peak Δ MiB | Result |
|---|---|---|---|
| direct PII | 1k / 2k / 4k / 8k | 174 / 112 / 555 / **1,901** | 8k over the 1 GiB budget |
| direct classify | 1k / 2k / 4k / 8k | 12 / 54 / 129 / 691 | within |
| direct, > 8,192 | 16k–200k | 0 (413 in ≤ 7 ms) | cap works |
| direct leak check | 30 × 4k | +43 MiB plateau (tol 64) | no leak |
| direct concurrency | 4 / 8 × 4k | ≤ 833 | within |
| via guardrail | 1k / 2k / 4k | 82 / 177 / 635 | within |
| via guardrail | 8k / 16k / 32k / 64k / 200k | **1,109** / 649 / 945 / 832 / **1,626** | 8k and 200k over |
| via guardrail leak check | 30 × 4k | +0 MiB | no leak |

Reading: one window-sized inference (≤ 4,256 chars, what guardrail sends) costs ≤ ~0.65 GiB — the
per-inference S1 target holds there. Requests that fan out into several windows run up to
`screenWindowConcurrency` (4) × `nlp.inference.maxConcurrent` (4) windows at once, and the SUM of their
transient memory reaches 1.1–1.6 GiB; the absolute peak seen was 8.35 GiB (32k via guardrail). The
36.8 GiB failure mode is gone (bounded, no ratchet), but the S1 per-REQUEST reading misses by up to
0.6 GiB at the default concurrency. S2 (steady-state ≤ 6 GiB per pod) is decided by V4.

**Regression found while sizing S1 — NER callers vs the 8,192-char cap (FC-8 / L6):** the 413 cap
applies to `/classify/tokens` too, and five callers send unwindowed text there: the NER agent invoke
(`agent-invocation.service.ts:576`), summary `extractEntities` (`summary.service.ts:2009`, up to 200k),
live documentation's NER (`live-tool-registry.ts:206`, whole transcript when the delta is empty), the
harness `extract_entities` on transcript and note (`activities.py:1307`, degrades and RETRIES the 413),
and the console ai-inference proxy (≤ 20k). Before TASK-1047 these were accepted at quadratic memory
(the original blow-up); now long inputs fail or silently degrade (no entities in the note). Owner decision
2026-10-06 (OD-10): **NLP windows NER server-side** — see §8.3. S1 decision (OD-11): keep
`screenWindowConcurrency` 4 and judge memory by the V4 soak (S2); S1 is read per inference.

### 8.3 OD-10 — NLP windows NER server-side (FC-8a), and the harness 4xx fix

| Lane | Tier | Merged | Delivered |
|---|---|---|---|
| ner | opus | `78ebb6889` (+ orchestrator `d22c76959`) | `/api/v1/classify/tokens` only: text ≤ `nlp.inference.maxInputChars` → the old single pass, unchanged; ≤ `nlp.ner.maxRequestChars` (200,000) → windows of `nlp.ner.windowChars` (4,000) + `nlp.ner.windowOverlapChars` (256), cut on whitespace in the last 10 % of a window, each window starting after the first whitespace of its overlap (never mid-word — orchestrator fix), run one at a time through the normal bounded inference path; spans re-based to absolute offsets, identical spans keep the best score, same-label overlaps across windows keep the longer span. Above the request cap: 413 as before. `nlp_ner_windows` counter. Every other capped route keeps its 413 at 8,192. Descriptors for the three keys |
| hretry | sonnet | `4bf20f570` | Harness: an NLP 4xx other than 408/429 fails the NER activity as a NON-retryable `NlpClientError` (activity layer only; no workflow code, retry policy or activity signature changed — replay-safe). 5xx/408/429/timeouts still retry |

Response fields across windows: `vitals` per field first-found, `inference_ms` summed, `model_version`/`device`
from the first window. Cost: a 200k-char text is ~50 sequential window passes (latency, not memory).

### 8.4 Harness finding — guardrail read the wrong database (local e2e only)

`apps/guardrail` takes its DB from `GUARDRAIL_DATABASE_URL` (default `…/hope`), not `DATABASE_URL`. The e2e
launcher exported only `DATABASE_URL=…/hope_1045_e2e`, so guardrail resolved selections and policy from the
main `hope` DB, which predates the `medicalWindowScopeCriteria` seed: every per-window medical judgement
failed closed in ~2 ms (`unsupported_guardrail_type`), and none could be cached — the first V3 run's S4 45.9 %
and its 1.15 M "computed" judge characters were that, not the cache design. The launcher now exports
`GUARDRAIL_DATABASE_URL` too; after it, the medical judge answers (≈ 15 s per window on the local 2B model)
and the full re-screen under the corrected policy version registered 55/55 PASS (135 sources, 0 FAIL,
0 UNAVAILABLE). Not a product defect: the cluster sets guardrail's DB explicitly. **The main `hope` dev DB
still lacks `medicalWindowScopeCriteria`** — anyone running the stack on it needs a reseed of the
`granite-guardian-4.1-8b` row (`seed/ai-models/llm.ts`).

### 8.5 V3 replay, window sweep, OD-6 re-decision and the CPU re-baseline (OD-12)

**V3 — `screening_replay.py`, one 20-minute consultation, 60 flushes (guardrail on the right DB, §8.4):**

| Counter (this run) | classify | pii | medical judge |
|---|---|---|---|
| windows computed | 66 | 66 | 73 |
| plan's unique windows (a perfect cache) | 66 | 66 | 66 |

The window cache is at its theoretical optimum: every window computed is a window never seen before.
S4 reads 86.6 % (target 90 %) only because this replay's geometry cannot do better — every 20 s flush
grows the transcript's tail window, which is new content by definition. S6 passed (judge calls ∝ new
windows). S3 (1.85 M chars/min extrapolated to 100 consultations, target 150 k) and S5 (warm p95
2.6 s, target 300 ms) both measure the same thing: the growing tail window (≤ window size) is re-screened in
full on every flush, by GLiNER2 on CPU (~1.8 s per 4,000-char window here; the cluster's NLP is CPU too).
S3/S5 were written as if only the new 250 characters were screened.

**Window sweep (`bench_guard_memory.py --window-sweep`, PII golden set — 12 synthetic cases):**

| Window | P | R | F1 | p95 ms | peak MiB |
|---|---|---|---|---|---|
| unwindowed | 0.849 | 0.983 | 0.911 | 2,445 | 3,464 |
| 500 | 0.652 | 1.000 | 0.790 | 320 | 3,497 |
| 1,000 | 0.788 | 0.992 | 0.878 | 457 | 2,956 |
| **2,000** | 0.832 | 0.992 | **0.905** | **824** | **2,912** |
| 4,000 | 0.825 | 0.983 | 0.897 | 1,834 | 3,623 |

**Owner decisions 2026-10-06:**
- **OD-6 re-decided: 2,000-character windows** — guardrail `screenWindowChars` default 2,000 (overlap 256)
  and `nlp.ner.windowChars` 2,000. Better F1, ~55 % lower p95 and lower memory than 4,000; halves the tail
  re-screen. Below 1,000 precision drops (500 → F1 0.79), so delta-sized windows were rejected as a
  safety-screening quality regression. The golden set is small; V6 re-checks on the clinical set.
- **OD-12: S3/S5 re-baselined for CPU** — the cache design stays; the measured CPU figures become the
  baseline (S4 read as "computed windows = unique windows", which passes); NLP-on-GPU sizing for production
  is a deployment follow-up; capacity is judged by the V4 load/soak (shed rate, memory, p95).

### 8.6 V6 first run, the inbound classifier on clinical data, OD-13

**V6 first run (golden set, 14 multi-encounter cases, via `POST admin/harness/golden-sets/:id/run`):** all 14
cases errored in 54 s. Two defects, both found only by running the set live for the first time:
1. **15 of 16 generation calls refused `CONTENT_BLOCKED`** by the inbound gate — guardrail decisions during the
   run: 11 × `jailbreak_detection + prompt_safety + prompt_toxicity`, 1 × `prompt_safety + prompt_toxicity`,
   3 × `prompt_toxicity`, 1 allow.
2. The one call that passed answered **404 `PROVIDER_NOT_FOUND`**: the fixture named the engine `lmstudio`;
   apps/text serves `lm-studio` (the AiModel convention). Fixed in `1ed5acf78` with a guard test.

**Why the inbound gate refuses clinical content.** Before TASK-1047 the whole joined prompt (≤ 100k chars) was
scored in ONE classifier pass, so the encoder's length limit meant only the head — mostly the governed system
prompt — was ever scored; L5's region windows (the C2 fix) now score every window of every data block.
Calibration of the SYSTEM inbound classifier `gliguard-llm-guardrails-300m` (`fastino/gliguard-LLMGuardrails-300M`):

| Check | Benign clinical windows flagged (75 × 2k, golden transcripts) | Injections caught (10, embedded in clinical dialogue) |
|---|---|---|
| `jailbreak_detection` | 4 / 75 (5 %), scores 0.14–0.93 | 7 / 10, scores 0.23–0.95 (overlaps benign) |
| `prompt_safety` | 7 / 75 (9 %), median 0.95 | 7 / 10 |
| `prompt_toxicity` | 15 / 75 (20 %) — label `regulated_advice` (medical advice) | 7 / 10 |

Benign and attack scores overlap, so no threshold separates them. A note call carries many windows, so per-window
false-positive rates compound into near-certain refusal. The same classifier also flags seeded specialty
templates at authoring time (6 Global templates FAIL as INJECTION under the 2k geometry) and calls
"Write a concise SOAP note from the consultation transcript." toxic.

**Owner decision OD-13 (2026-10-06): detect-and-record on DATA regions** — contract FC-5b (§6.1). Data blocks
are still screened every time (no opt-out); a flag on a data region is a recorded finding (response
`data_findings`, metrics, PHI-safe logs), not a refusal. Refusal stays for caller instruction text and
ungoverned system prompts, for any undetermined check, and on the outbound gate. Rationale: the structural
boundary (FC-1 governed system, data by pointer, EXTERNAL_DATA fencing, nonce containment) is the primary
injection defence and the outbound gate catches compliance with an injected instruction (OWASP LLM01); a
classifier this weak cannot be the sole gate on clinical content, and patient disclosures must never stop
documentation. Follow-up (separate ticket): evaluate an injection-specific classifier (e.g. Llama Prompt Guard 2,
deberta-v3 prompt-injection-v2) and re-enable blocking on data for `jailbreak_detection` once it shows < 1 %
false positives per benign window and > 95 % recall on this calibration set.

Authoring-time note: the 6 template FAILs above are INJECTION findings on instruction text, which stays
BLOCKING under OD-4/"Scope it" — they remain un-governed (screened as untrusted at call time) until the
classifier follow-up lands or the templates are reworded.

## 9. Change History

| Date | Change |
|---|---|
| 2026-10-06 | Ticket created from the TASK-1045 e2e memory incident (NLP 36.8 GiB, swap exhaustion, kernel panic). Evidence: Jetsam/panic reports, controlled NLP memory probes (§2.1), code review of composition/egress/authoring (§2.2–2.4), external best practices (§3). Plan, lanes, TDD list, validation V1–V7 and decisions OD-1…OD-9 written. Status Pending. |
| 2026-10-06 | Owner approved all recommendations; lanes L1–L12 + gate-fix lanes G1–G3 merged to `dev-2.2`; single gate pass green (§8). Owner reminder recorded: sub-agents never run gating tests — only the orchestrator, once, after the full merge. |
