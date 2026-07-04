# TASK-355 · Appendix 04 — Cross-Stack Gating Inventory ("why does gating run so many times?")

> Produced by the gating-inventory review agent (code-level review of `apps/guardrail`, `apps/smr`,
> `apps/harness`, `apps/api`). Inventories every gating/safety invocation across the stack, its trigger
> frequency, and redundancy findings.

**Headline answer:** in the measured run gating executed **once end-to-end** — but that single inferential pass
internally fans out into **38 serialized LLM calls** (31 groundedness + 7 safety dimensions + 0 citation-verify),
each visible as a separate slow request in LM Studio logs. That internal fan-out — not a hidden re-gating loop —
is what looks like "gating running so many times". See [Appendix 01 §4](./01-workflow-trace-analysis.md).

---

## 1. The five gating layers

| Layer | Where | What | Default state |
|---|---|---|---|
| 1 | SMR pre-generation gate | "is this medical content?" before every generate | **OFF** (`SMR_V2_EXTERNAL_GUARDRAIL_ENABLED=false`; not enabled in dev) |
| 2 | Guardrail service (:8863) | medical validate (Granite) + content safety/PII/prompt-injection (GLiNER ONNX) | service of Layer 1 + direct callers |
| 3 | Harness computational sensors | 5 deterministic checks, pure Python | always, every regen iteration (~0 cost) |
| 4 | Harness inferential sensors | groundedness + citation_verify + safety (LLM judge + Granite) | always (safety per policy) — **THE expensive layer** |
| 5 | AWS Bedrock native guardrail | inline `guardrailConfig` on Bedrock converse | only when `SMR_V2_BEDROCK_GUARDRAIL_ID` set |

### Layer 1 — SMR pre-generation gate (per generate call)

`apps/smr/src/smr_v2/api/endpoints/generate.py:132–142` → `POST {guardrail}/api/medical/validate` (client: `services/external_guardrail.py`). Checks `{is_medical, confidence, context_type}`; rejects 422 if `require_medical` and not medical. Knobs: `SMR_V2_EXTERNAL_GUARDRAIL_ENABLED` (default `false`), `_FAIL_OPEN` (default `false` = fail-closed), `_REQUIRE_MEDICAL` (default `true`), `_TIMEOUT_S` (10 s). **Frequency when enabled:** 1× per SMR generate → on the harness path that is 1–3× per workflow (regen loop) **plus** every live flush (every 3 segments / 5 s idle) on the live path. Payload: full concatenated system+user prompt. Serial, blocking, before generation.

### Layer 2 — Guardrail service endpoints (`apps/guardrail`, :8863)

| Path | Check | Model |
|---|---|---|
| `POST /api/medical/validate` | medical-context classification | Granite Guardian 4.1-8b via LM Studio (or Ollama/Azure/Bedrock), input truncated to first 2 000 chars |
| `POST /api/medical/validate/batch` | same, batched (internal `asyncio.gather`) | — |
| `POST /api/guardrail/analyze` | content safety / PII / prompt-injection | **GLiNER ONNX** (`hivetrace/gliner-guard-uniencoder-onnx`), CPU thread-pool, sub-second, no LLM |
| `POST /api/guardrail/analyze/batch` · `/analyze/async` | batched / Redis job variants | GLiNER ONNX |

Per-tenant model resolution from `core."GlobalSetting"` when `GUARDRAIL_DB_CONFIG_ENABLED=true` (TTL cache). **All paths fail OPEN** (`safe: true` on timeout/error) — note the contrast with the harness gate, which fails CLOSED (FLAG).

### Layer 3 — Harness computational sensors (`run_sensors`)

`services/sensor_runner.py::run_computational_sensors`, called from `activities.py` (267–282), from the workflow **every regen iteration** (`workflows.py:373–387`). Five pure sensors, sequential, no I/O, <1 s:

| Sensor | Checks | Threshold | Harm class |
|---|---|---|---|
| `entity_faithfulness` | every note entity grounded in transcript | 1.0 | HIGHEST_HARM → FLAG |
| `numeric_dose` | numbers/doses cross-checked | 1.0 | HIGHEST_HARM → FLAG |
| `schema_validity` | SOAP JSON conforms to schema | — | REGEN-fixable |
| `coverage_omission` | ≥80 % transcript entities present | 0.8 | REGEN-fixable |
| `citation_presence` | every claim carries ≥1 evidence span | 1.0 | REGEN-fixable |

### Layer 4 — Harness inferential sensors (`run_inferential_sensors`) — the expensive layer

Runs **once per loop exit** (after computational sensors settle), re-runs fully on inferential-triggered regens. Per pass: `C` groundedness judge calls + `C_cited` citation-verify judge calls + `D` (=7) Granite safety calls — all serialized through `HARNESS_LLM_MAX_CONCURRENCY=1` (one shared semaphore for judge AND Granite, keyed `http://localhost:1234`). Full mechanics in [Appendix 02 §3](./02-harness-internals-review.md).

### Layer 5 — Bedrock native guardrail

`apps/smr/src/smr_v2/providers/bedrock.py:75–79` — `guardrailConfig` attached to `converse` when `SMR_V2_BEDROCK_GUARDRAIL_ID` set. Inline, ~0 extra latency, AWS-side.

### PHI guard — wired but NOT in the execution path ⚠

`apps/harness/src/harness/guards/phi/redactor.py` (Presidio + clinical NER recognizer, fail-closed `PhiEgressBlocked`) exists and is tested; `HarnessPolicy` carries `phi_enabled=true, phi_fail_closed=true` (returned by `fetch_policy` in the measured run) — **but no activity calls `ensure_safe_for_cloud` yet**. With a local-only SMR provider this is currently moot, but the policy *claims* an enforcement that the pipeline does not perform. Flag for a separate ticket if cloud egress (azure/bedrock) is enabled for any tenant.

---

## 2. Complete invocation table

| # | Caller | Callee / Mechanism | Trigger | Payload | Serial/Parallel | Cost | Enabled? |
|---|---|---|---|---|---|---|---|
| 1 | `smr generate.py:132` | Guardrail `POST /api/medical/validate` | per SMR generate (pre-gen) | full prompt | serial, blocking | 1 Granite call, ≤10 s | **off by default & in dev** |
| 2 | harness `GroundednessSensor` | LM Studio judge | per claim, per inferential pass | `PREMISE{transcript+evidence} / HYPOTHESIS{claim}` | serial (governed) | `C × ~9–20 s` | always |
| 3 | harness `CitationVerifySensor` | LM Studio judge | per cited claim, per pass | `PREMISE{kb_chunk} / HYPOTHESIS{claim}` | serial (governed) | `C_cited × ~9–20 s` | retrieval-dependent (0 in measured run) |
| 4 | harness `SafetySensor` → `GraniteGuardianClient.screen` | LM Studio Granite | 7× per pass (one per criterion) | full note + BYOC `<guardian>` block | serial (governed) | `7 × ~9–20 s` | `safety_enabled` (policy: true) |
| 5 | `smr bedrock.py:75` | AWS Bedrock guardrailConfig | per Bedrock converse | inline | inline | ~0 | only with guardrail id |
| 6 | harness `run_sensors` | pure Python ×5 | every regen iteration | parsed SOAP + entities | sequential, pure | ~0 | always |
| 7 | `apps/api` health controller | Guardrail `GET /api/health` | polling | — | — | — | health only, not gating |

## 3. Gate decision logic + revision loop (exact semantics)

`sensors/aggregator.py::aggregate()` (lines 93–140) — decision hierarchy:

1. **Any sensor degraded / expected sensor missing → FLAG** (never auto-PASS on missing evidence)
2. **`entity_faithfulness` / `numeric_dose` / `safety` failed → FLAG** (highest-harm; never auto-regenerated)
3. **`schema_validity` / `coverage_omission` / `citation_presence` / `groundedness` / `citation_verify` failed + budget remains → REGEN**
4. Same failures, budget exhausted → FLAG
5. All passed → PASS

Two-phase loop (`workflows.py:320–443`): computational-only verdicts can trigger REGEN **without** paying for the inferential pass; an inferential REGEN re-runs **everything including the full inferential pass** on the next iteration. Worst case at `max_regen=2`: `3 × (C + C_cited + 7)` LLM calls.

**Measured-run instantiation:** groundedness failed (0.387 < 0.8 → per-sensor label REGEN) *but* `entity_faithfulness` (0.474 < 1.0) and `numeric_dose` (0.6 < 1.0) also failed → rule 2 outranked rule 3 → **FLAG, loop exited, no regen, draft to human review**. This is why the trace shows a "REGEN" guardrail decision yet only one `generate`.

## 4. Redundancy / double-gating findings

| # | Finding | Detail | Materiality today |
|---|---|---|---|
| 1 | Two Granite deployments, overlapping intent | SMR pre-gen gate (input: "is it medical?") vs harness SafetySensor (output: harm taxonomy) — same model, same LM Studio box | Low (Layer 1 off by default) |
| 2 | **Full inferential re-run on every regen — no claim-level caching** | regen fixing one section re-judges ALL claims incl. unchanged sections (`sections_to_regen` is computed but unused for scoping) | **High** when regens fire — multiplies the 344 s |
| 3 | Groundedness + citation_verify double-judge the same claim | same hypothesis, different premises (transcript vs kb chunk) — 2 calls/claim when cited | Medium once RAG corpus is live |
| 4 | Safety screens the full note per criterion, every pass | 7 calls × whole note, even when only one section changed | Medium |
| 5 | Triple-stacking possible: Bedrock + SMR gate + harness safety | three mechanisms on one consultation if all enabled | Low (config-dependent) |

## 5. Optimization opportunities (gating-specific)

| Opportunity | Saving | Risk |
|---|---|---|
| Raise `HARNESS_LLM_MAX_CONCURRENCY` to 2–4 (sensors are architecturally parallel already) | ÷2–3 on the serialized chain | LM Studio must handle concurrent slots (verify ≥0.4.0; watch `terminated` 400s) |
| Parallelize the Granite 7-criterion loop (`asyncio.gather` inside `screen()`) | 7 serial → ceil(7/N) rounds | none semantically; result dict unchanged; only pays off with concurrency >1 |
| Batch claims per judge call (5–15/call, label-each JSON array) | `C` calls → `C/10` calls | parse hardening; conservative fallback (unparsed → ungrounded) |
| Scope regen re-verification to `sections_to_regen` + claim-hash cache | regen passes shrink to the delta | claim identity hashing; keep conservative on cache miss |
| Trim `harm_criteria` to a clinically-motivated subset | −10–20 s per removed criterion (serial) | **clinical governance decision**, not engineering |
| Merge groundedness+citation premises for dually-checked claims | 2 calls → 1 for cited claims | prompt design; keep verdicts separable in output |
| Keep Layer 1 (SMR pre-gen gate) off for harness-originated generates | avoids re-classifying the harness's own assembled prompt | if Layer 1 is ever enabled globally, exempt internal callers |

> Safety invariant for ALL of the above: failure direction must stay conservative (parse failure / timeout / cache miss ⇒ **un**grounded / escalate), and `safety` FLAG must remain non-regenerable — see README §7.
