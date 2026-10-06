# TASK-1047 — Governed prompts, data-only incremental screening, bounded NLP inference

| Field | Value |
|---|---|
| Status | **Pending** — plan written, awaiting owner decisions (§6) and an explicit go |
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

| Lane | Tier | Owns | Delivers |
|---|---|---|---|
| L1 contract | opus | `packages/workflow-contract/**`, `apps/harness/src/harness/temporal/interpreter/compose_messages.py`, contract fixture | D1 pointer-everything + governance digests; parity fixture extended |
| L2 gateway composers | opus | `packages/applications/src/services/consultation/{live-documentation,prompt,note-composition}/**`, `services/agent/agent-invocation*`, `services/text-generation/compose-assembled-prompt*`, `text-request-enrichment*` | all paths on D1; `systemGovernance` attached; DNA samples → `style_reference` |
| L3 authoring screening | opus | `services/prompt-management/**`, `services/agent/{agent.service,agent-findings,agent-promote-to-system}*`, new `services/governed-prompt/**`, `packages/domains` trio for `GovernedPromptPiece` | D2 findings, registry, boot registration, re-screen job |
| L4 text egress | sonnet | `apps/text/src/text/services/{egress,data_blocks,output_gate}.py`, `models/requests.py`, `api/endpoints/generate.py` | D3 digest verify, data-only screening, `known_phi` everywhere, regions to guardrail |
| L5 guardrail | opus | `apps/guardrail/src/guardrail/{services/screening,safety_analyzer,external_nlp_client,pii_extraction}.py`, `api/endpoints/{screen,redact}.py`, new `services/window_cache.py`, `core/policy.py` | D4 windows, D5 cache, judge windows (OD-5), D7 deadlines |
| L6 nlp | sonnet | `apps/nlp/src/nlp/{api/v1/rest/guard.py,api/v1/rest/classify.py,services/gliner2_guard.py,dependencies.py,core/config.py,torch_runtime.py}`, `main.py` | D6 bounds, threads, shared weight registry, recycling |
| L7 seeds | sonnet | `packages/database/src/prisma/db_main/seed/{07-prompt-template,07b-*,07d-*,25-agents}.ts` | seeded templates rewritten to pointers (no runtime value in system) |
| L8 ops + settings | sonnet | `settings-registry/descriptors/{service-runtime,security-policy}.descriptors.ts`, `scripts/dev-service.sh` + stack supervisor, deployment repo overlays | settings for W/O/TTL/threads/workers/recycle; supervisor restart; k8s limits/HPA |
| L9 SDK/docs | haiku | `packages/agentic-sdk-v2` (GENERATE deprecation JSDoc), `docs/operations/deprecation-register.md`, rules `08`/`06` notes | OD-3 deprecation |

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
| L7 | seed render check: no `{{` runtime variable inside system text of any seeded agent; publish findings clean |
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

_Not started — awaiting the owner's go on §6._

## 9. Change History

| Date | Change |
|---|---|
| 2026-10-06 | Ticket created from the TASK-1045 e2e memory incident (NLP 36.8 GiB, swap exhaustion, kernel panic). Evidence: Jetsam/panic reports, controlled NLP memory probes (§2.1), code review of composition/egress/authoring (§2.2–2.4), external best practices (§3). Plan, lanes, TDD list, validation V1–V7 and decisions OD-1…OD-9 written. Status Pending. |
