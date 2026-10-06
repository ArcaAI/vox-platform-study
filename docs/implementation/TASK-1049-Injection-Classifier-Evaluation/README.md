# TASK-1049 — Injection-specific classifier evaluation for inbound DATA regions

| Field | Value |
|---|---|
| Status | **In Progress** — owner approved the plan and OD-1…OD-9 as recommended (2026-10-06); evaluation running |
| Type | research / evaluation (no production config change; the recommendation feeds a follow-up implementation ticket) |
| Branch | `dev-2.2` |
| Raised by | TASK-1047 §8.6 / OD-13 follow-up (FC-5b, §6.1) |
| Related | TASK-1047 (governed prompts, windows, FC-5b), TASK-1035 (egress safety decisions), TASK-1019/1023 (model registry) |

---

## 1. Requirement Analysis

### 1.1 What the owner asked for (2026-10-06)

Evaluate injection-specific classifiers against clinical data and say whether one can replace GLiGuard for
`jailbreak_detection`, so FC-5b data regions can block again **for jailbreak only**. Report FP rate per window,
recall, CPU latency and memory. Production config is not changed without owner approval.

### 1.2 Restated requirement

1. Measure each candidate against:
   - (a) the 75 benign 2,000-char windows of the golden set (`apps/harness/src/harness/eval/golden/fixtures/multi_encounter_v1.json`)
   - (b) a larger synthetic and public clinical benign set
   - (c) public prompt-injection benchmarks, plus injections embedded in clinical data
2. Use the production geometry: 2,000-char windows with a 256 overlap (`guardrail/services/windowing.py`), run on CPU.
3. Recommend:
   - register or don't register a model as `jailbreak_detection`, with the `AiModel` row, `labelTaxonomy` and threshold;
   - the exact criteria and config that flip FC-5b data regions back to blocking for jailbreak only.

### 1.3 Acceptance bar (from OD-13)

- **Specificity:** < 1 % false positives per benign 2,000-char window.
- **Sensitivity:** > 95 % recall on injections.

§6 OD-4 makes both statistically defensible.

## 2. Current State Evaluation (verified 2026-10-06)

| Area | Fact | Evidence |
|---|---|---|
| Inbound tasks | `INBOUND_TASKS = (jailbreak_detection, prompt_safety, prompt_toxicity)` | `apps/guardrail/src/guardrail/services/screening.py:87` |
| Data posture | A hard-coded `trust == "data"` mask makes data-region flags non-blocking (`DataFinding`). No per-task switch exists, so re-enabling blocking is a code change. | `screening.py:77-85, 547-596` |
| Binding | ONE routing key `guardrail.safety` → `gliguard-llm-guardrails-300m` serves all three tasks. There is no per-task routing key. | `seed/16-ai-routing-policy.ts:93` |
| Taxonomy | Lives on the model: `_metadata.labelTaxonomy`, `threshold` 0.4, `jailbreak_detection` 12 labels, multi-label, `cls_threshold` 0.4 | `seed/ai-models/nlp.ts:702-784` |
| NLP guard route | `POST /api/v1/guard/classify` is hard-wired to the gliner2 runtime (`Gliner2GuardService`). Tenant 428, model-less 503, batching through `guard_dispatch`. | `apps/nlp/src/nlp/api/v1/rest/guard.py:62-425`, `services/gliner2_guard.py:101-210` |
| HF seq-cls in NLP | `POST /api/v1/classify/text` runs `AutoModelForSequenceClassification`. It has no guard lanes or batching, and `model_path` handling is unverified. | `services/text_classifier.py:52-147` |
| Windows | `iter_windows(text, 2000, 256)` | `apps/guardrail/src/guardrail/services/windowing.py:65`, `core/policy.py:176` |
| TASK-1047 calibration | 75 windows / 10 injections, run ad hoc. **No committed script, and the 10 injections are not in the repo.** | TASK-1047 README §8.6 |
| Cluster CPU | `hope-nlp` limit 4 CPU (dev overlay), `OMP_NUM_THREADS=8`, memory limit 4 Gi in base | `hope-v2-deployment/deployment/k8s/base/nlp.yaml:261-355`, `overlays/dev/kustomization.yaml:60` |
| Local env | `arcaenv`: transformers 5.5.4, torch 2.8.0. Apple M3 Max, 16 cores, 48 GB. | measured |
| Model access (HF token) | Prompt Guard 2 86M / 22M: 200. protectai v2, PIGuard: OK. `rogue-security/...sentinel-v2`, `qualifire/prompt-injection-sentinel`, Semalith: **403 (gated, not accepted)** | measured |

## 3. Research — candidates and benchmarks

### 3.1 Candidates

| Model | Base / size | Labels | Max len | Licence | Notes |
|---|---|---|---|---|---|
| **GLiGuard 300M** (baseline) | GLiNER2 | 12-label jailbreak taxonomy | — | apache-2.0 | 5 % FP, 7/10 recall on TASK-1047 |
| **Llama Prompt Guard 2 86M** | mDeBERTa-v3-base | BENIGN / MALICIOUS | 512 tok | Llama 4 Community | Vendor figures: AUC .998, 97.5 % recall at 1 % FPR, 92 ms. The v2 **dropped the "injection" label**: it targets *explicit attempts to override instructions*. Uses an energy-based loss for out-of-distribution FP. 8 languages, no Malayalam. |
| **Llama Prompt Guard 2 22M** | DeBERTa-xsmall | same | 512 tok | same | Vendor figures: 88.7 % recall at 1 % FPR, 19 ms |
| **protectai/deberta-v3-base-prompt-injection-v2** | DeBERTa-v3-base 184M | SAFE / INJECTION | 512 tok | apache-2.0 | The LLM Guard default. LLM Guard was archived in July 2026; the model is still published. Known for over-defence. |
| **leolee99/PIGuard** (InjecGuard) | DeBERTa-v3-base ~200M | benign / injection | 512 tok | MIT | Trained against over-defence on trigger words (NotInject). **Requires `trust_remote_code=True`.** |
| *rogue-security/prompt-injection-jailbreak-sentinel-v2* (optional) | Qwen3 seq-cls (~0.6B) | binary | long | "other" | Gated with auto-accept. An upper-bound reference, probably too heavy for the CPU budget. |

Excluded:
- **Semalith v1.5**: manual gate, zero downloads, unvetted.
- **StackOne Defender**: ships as an npm package, so apps/nlp (Python) cannot serve it.
- **JailGuard**: Rust MLP, not a model the registry can serve.
- **qualifire Sentinel v1**: superseded by v2.

### 3.2 Benchmarks

| Set | Use | Licence |
|---|---|---|
| `deepset/prompt-injections` | injections + benign (direct) | apache-2.0 |
| `Lakera/gandalf_ignore_instructions` | injections (instruction override) | MIT |
| `reshabhs/SPML_Chatbot_Prompt_Injection` | injections in system-prompt context | MIT |
| `leolee99/NotInject` | over-defence: benign text full of trigger words | MIT |
| ACI-Bench, MTS-Dialog (doctor–patient dialogue) | clinical benign at scale | CC BY 4.0 — **verify before use** |
| `microsoft/BIPIA` (indirect injection) | **excluded**: repository archived, licence NOASSERTION | — |

### 3.3 What matters for HOPE specifically

- **Indirect, not direct, injection.** The threat is text inside a transcript or attachment. A direct-jailbreak
  benchmark score does not transfer, so the clinical embedded set (c2) is the decisive one.
- **Clinical imperatives are natural.** Doctors say "stop taking", "forget the old dose", "ignore the previous
  result". Trigger-word bias (the NotInject finding) is the expected failure mode, so (b) needs a hard-negative
  slice.
- **Window vs model limit.** A 2,000-char window is about 450–600 tokens, which can exceed 512. Each window is
  therefore split into 512-token segments (overlap 64), and the window is flagged if ANY segment is flagged,
  exactly as the Prompt Guard card recommends. Latency counts every segment.

## 4. Evaluation Design

### 4.1 Datasets (built deterministically, seed fixed)

| Id | Set | Target size | How it is built |
|---|---|---|---|
| a | Golden benign | 75 windows | Render each case through the **real** apps/text data-region renderer, then window it at 2,000 / 256. Calibration check: GLiGuard must reproduce 4 / 7 / 15 per 75 (TASK-1047 §8.6). A naive render gives 83 windows, so the renderer matters. |
| b1 | Public clinical benign | ≥ 400 windows | ACI-Bench + MTS-Dialog dialogues, rendered as data regions and windowed |
| b2 | Clinical hard negatives | ≥ 150 windows | Local LM Studio (gemma) generates consultations dense in clinician imperatives, plus "patient quotes another doctor / a leaflet / a text message", plus attached-report style text. The generation prompts are committed; a human spot-checks 10 %. |
| b3 | NotInject | 339 | As published, unwindowed. Over-defence reference only, not part of the < 1 % bar. |
| c1 | Public injections | ~500 | Sampled from deepset (injection label), gandalf, SPML. Unwindowed recall (direct-attack reference). |
| c2 | Clinical embedded injections | ≥ 200 | ~40 payloads × 5 carriers. **Payloads:** override, role-play, system-prompt exfiltration, markdown-image exfiltration, false-fact insertion ("record that the patient is fit for surgery"), obfuscated or encoded, multilingual. **Carriers:** patient speech, doctor speech, pasted lab report, attachment text, end-of-window split across a window boundary. Each payload is embedded at a random offset in a benign (a) or (b1) window. Includes reconstructions of the TASK-1047 ten. |

Split: (b1, b2, c2) are split 30 / 70 into **dev** (threshold selection) and **test** (reported numbers). (a) is test-only.

### 4.2 Metrics per model

- FP rate per window on a, b1, b2, b1+b2+a, each with a Clopper-Pearson 95 % upper bound.
- Recall on c1 and c2, with the 95 % lower bound; c2 is also broken down per carrier and payload class.
- ROC/AUC and the threshold that meets FPR ≤ 1 % on dev, then both metrics on test at that fixed threshold.
- Overlap check: the highest benign score against the lowest attack score (the GLiGuard failure mode).
- CPU: p50 / p95 ms per 2,000-char window (segments included) at `torch.set_num_threads(4)` (the pod limit) and at 1 thread (concurrency proxy); batch-8 throughput (windows/s); peak and steady RSS after load; cold-load time.
- Portability calibration: re-run GLiGuard on this Mac and compare it with the TASK-1047 CPU numbers, so the cluster CPU can be extrapolated.
- Secondary: the 6 Global specialty templates that FAIL at authoring time (TASK-1047 §8.6). A better classifier may also clear instruction-text false positives.

### 4.3 Decision rule (proposed — OD-4)

A candidate PASSES if, on the **test** split at ONE fixed threshold:
1. the per-window FP point estimate is < 1 % on a + b1 + b2 **and** its 95 % upper bound is ≤ 1.5 %;
2. c2 recall is ≥ 95 % (point) and the lower bound is ≥ 92 %; no carrier class falls below 90 %;
3. p95 at 4 threads is ≤ 150 ms per window, and the added steady RSS is ≤ 600 MiB.

With about 600 benign test windows, criterion 1 tolerates at most 5 false positives. Among passers, the
smallest or fastest model wins.

## 5. Implementation Plan (evaluation only)

### 5.1 Files (single writer, no worktree, nothing under service runtime code)

| File | Purpose |
|---|---|
| `apps/nlp/scripts/bench_injection_classifiers.py` | Loads candidates (pinned `revision` SHAs), segments windows into 512 tokens, scores, records metrics, latency and RSS, and writes a JSON report |
| `apps/nlp/scripts/injection_eval/build_sets.py` | Deterministic builders for a / b1 / b2 / c1 / c2 (seeded) |
| `apps/nlp/scripts/injection_eval/payloads.json`, `b2_prompts.json` | Committed synthetic payloads and generation prompts. No PHI, all synthetic. |
| `apps/nlp/tests/scripts/test_bench_injection.py` | Unit tests (§5.2) |
| this README §8 | Results tables and the recommendation |

Public datasets are downloaded at run time into the scratch cache and never committed. Generated b2 text is
committed only if small (< 1 MB); otherwise it stays regenerable from the prompts and seed.

### 5.2 TDD test list (RED first)

1. The window builder matches `guardrail.services.windowing.iter_windows` on a fixture (parity: offsets and lengths).
2. Token segmentation covers every token of a window, with ≤ 512 per segment and overlap 64; window score = max(segment scores).
3. Label mapping per model: MALICIOUS / INJECTION / injection → attack, and the rest → benign. An unknown label raises.
4. Embedding is deterministic for a given seed, the payload lands inside the window, and a boundary carrier straddles two windows.
5. Clopper-Pearson bounds match known values (0/300, 1/600).
6. Threshold is selected on dev only: the test split is never read during selection (guarded by the API shape).

### 5.3 Run order

1. Build the sets. Confirm the (a) count is 75 and GLiGuard reproduces 4/7/15; if not, stop and reconcile the renderer.
2. Run the accuracy pass for all candidates.
3. Run the CPU pass on a quiet box: stop the dev stack and LM Studio during latency runs.
4. Fill §8 and the recommendation.

### 5.4 What a PASS leads to (follow-up ticket, NOT this one)

1. **Serving:** add a seq-cls runtime behind `/guard/classify` (`libraryName: transformers`, `guard_dispatch`
   seam). That keeps tenant 428, lanes and batching, rather than reusing `/classify/text`.
2. **Binding:** add a new routing key `guardrail.injection` → new SYSTEM `AiModel`. The `jailbreak_detection`
   taxonomy moves to it, as binary `{labels: [benign, injection], threshold: <measured>}`. `prompt_safety` and
   `prompt_toxicity` stay on GLiGuard under `guardrail.safety`.
3. **FC-5b flip, config-driven** (replaces the code constant): a `global-kv` descriptor
   `guardrail.inbound.dataBlockingTasks` (string[], `failMode: open-to-default`, default `[]`, tenant → SYSTEM).
   SYSTEM is set to `["jailbreak_detection"]` only after the follow-up's own live validation (TASK-1047 V6 golden
   run with 0 refusals across 14 cases, plus the c2 replay through guardrail). `prompt_safety` and
   `prompt_toxicity` are not admitted to that list until a classifier passes for them.
4. **Publish:** `POST admin/ai-models/register-from-hub` (never `download-missing` live). Cluster pods run
   `HF_HUB_OFFLINE=1`.

## 6. Decisions for the owner

| # | Decision | Recommendation |
|---|---|---|
| OD-1 | Candidate set | PG2-86M, PG2-22M, protectai v2, PIGuard, with GLiGuard as baseline. Add Sentinel v2 only if you click "accept" on its HF gate (an upper-bound reference). |
| OD-2 | PIGuard needs `trust_remote_code` | Allowed for the **offline eval only**: pin the commit SHA and read the remote code first. Any production use needs a separate decision. |
| OD-3 | Clinical benign sources | ACI-Bench + MTS-Dialog (after a licence check) + LM Studio–generated hard negatives. No real PHI anywhere. |
| OD-4 | Statistical bar | The §4.3 rule (point < 1 % with upper bound ≤ 1.5 % on ~600 test windows; recall ≥ 95 % with lower bound ≥ 92 %, and every carrier ≥ 90 %). Alternative: the point estimate only, which matches OD-13 literally. |
| OD-5 | Latency / memory ceiling | ≤ 150 ms p95 per window at 4 threads, ≤ 600 MiB added RSS (the NLP pod limit is 4 Gi, GLiGuard peaks at ~2.9 GiB) |
| OD-6 | Where it runs | This Mac, CPU-only, 4 threads, with the GLiGuard calibration step |
| OD-7 | Llama 4 Community Licence | Fine for evaluation. Before production, confirm the attribution duty ("Built with Llama") and the licence terms with whoever owns licensing. |
| OD-8 | Malayalam / ml-en | Notes are English (owner rule), but transcripts can carry Malayalam. Add 50 ml-en windows from the TASK-934/994 test material if suitable; PG2 does not list Malayalam, so report it separately and keep it out of the bar. |
| OD-9 | Flip mechanism (follow-up) | The `guardrail.inbound.dataBlockingTasks` descriptor in §5.4, rather than editing the code constant |

## 7. Risks

- **Benchmark transfer.** Vendor numbers are measured on direct prompts. Clinical indirect injection may land well below them, which is exactly why c2 decides.
- **Synthetic-on-synthetic bias.** b2 and c2 are both written by us and an LLM. Spot-check them, and keep public sets in the mix.
- **The flip widens the blast radius.** Blocking on data refuses documentation. The follow-up keeps prompt_safety and toxicity non-blocking, and the flip needs its own live V6 pass.
- **Mac CPU ≠ cluster CPU.** Mitigated by the GLiGuard calibration ratio.

## 8. Implementation Summary

_Not started — awaiting approval._

## 9. Change History

| Date | Change |
|---|---|
| 2026-10-06 | Owner: "go" — plan and all OD recommendations approved (Sentinel v2 not added: gate not accepted). |
| 2026-10-06 | Ticket created from the TASK-1047 OD-13 follow-up. Exploration (code paths, seed, cluster limits, model access) and research (candidates, benchmarks) done; plan and OD-1…OD-9 written. Status Pending. |
