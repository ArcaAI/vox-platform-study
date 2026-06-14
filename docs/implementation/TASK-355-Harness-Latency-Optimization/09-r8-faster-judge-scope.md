# TASK-355 · Appendix 09 — R-8 Faster Entailment Judge (scope)

| | |
|---|---|
| **Lever** | R-8 (from the §5 Optimization Catalog: "swap judges: MiniCheck-class / Granite-groundedness verifier; cascade uncertain band") |
| **Created** | 2026-06-14 |
| **Status** | **PARKED (2026-06-14).** R-8a (reuse-resident Granite-groundedness) is fast enough to clear raw < 2 min (~2.1–2.4×, E2E ~95 s) but **FAILS the zero-unsafe-flip safety gate on a reproducible, prompt-resistant fabricated-demographic miss** (q04 "Four-year-old"), so it cannot replace gemma. **Runtime judge unchanged = gemma; the `GraniteGroundednessJudge` adapter + `inferential_judge_parity` instrument stay in-tree, tested, DEFAULT-OFF** as the ready substrate for a future R-8b. **Why park:** the *perceived* < 30 s goal is already shipped (Phase D); R-8 only moves the *raw* number; the remaining forks are structural (R-8c cascade gives ~no speedup since the grounded majority would still re-pay gemma; R-8b = new infra; human-truth recalibration is prep, not a fix). Reopen R-8 only if raw latency becomes blocking → start at **R-8b** (dedicated small NLI) scored on a **human-truth** set via the existing parity tool. — _History (was: E0/E1 BUILT + E2 DONE ×2 → R-8a gate FAILED; PROMPT-ITERATION EXHAUSTED.)_ v1 sweep: 87.7 % agree, ~2.4× faster, **4 unsafe flips**. **v2 (tightened BYOC: "any unsupported detail incl. age/dose/date"): the *identical* 4 unsafe flips persist** (q04 "Four-year-old" still passes despite an explicit *demographic/age* instruction), safe-flips 5→0, agreement 87.7 %→94.5 %, latency unchanged (~2.1× faster). ⇒ **The one genuine loosening (q04 fabricated age) is reproducible AND prompt-resistant** — a fabricated patient age slipping a groundedness gate is the disqualifying direction. Adjudication holds: of the 4 flips only **q04 is a real Granite miss**; **c01 + c05 are gemma false-positives Granite overturned**, **c03 borderline** ⇒ Granite is fast and *on-average arguably more accurate than gemma*, but has ≥1 safety-direction miss prompt-tuning can't fix. Decisions locked: **Q0** E0-first · **Q1** R-8a · **Q2** proxy+human · **Q3** zero-unsafe-flip. **Remaining options: park R-8 (recommended) · cascade R-8c (Granite fast-tier → escalate to gemma; catches q04 but ~no speedup on the grounded majority) · R-8b dedicated small NLI (new infra) · human-truth recalibration.** |
| **Goal** | Close the residual gap to the **< 2 min raw** hard goal **without loosening any verdict** |
| **Risk** | **High** (a different/weaker verifier is *more permissive* — the wrong direction for a clinical safety gate) |

> Read first: README §1–§2 (the 344 s anatomy), §5 R-8 row, the 2026-06-13 "DEFINITIVE E2E" + "CLEAN E2E BASELINE" change-log rows (the measured floor), and the Phase-B change-log row (the live parity gate that rejected batching — R-8 inherits exactly that gate).

---

## 0. TL;DR + recommendation

- **The felt win is already shipped.** Phase D (optimistic delivery) makes the draft visible in ~30–45 s and runs assurance concurrently with review, so the **< 30 s *perceived*** stretch goal is met. R-8 only moves the **raw** draft-latency number (159 s → target < 120 s). **Decide first whether that raw number is still worth a High-risk change** (§9 Q0).
- **If yes:** the bottleneck is the **31 groundedness judge calls (~108–120 s, 71 % of E2E)**, each paying a *reasoning* model (`gemma-4-e4b`) to emit ~140 `<think>` tokens before a 1-token verdict. R-8 = run that entailment on a **no-reasoning, single-token verifier** instead.
- **Recommended path:** **R-8a — reuse the already-resident Granite Guardian** in *groundedness* mode for the groundedness + citation-verify sensors (zero new infra; the model is already loaded for safety; single-token verdict; #3 on LLM-AggreFact, beats gpt-4o → *not* a weaker judge). Fall back to **R-8b** (dedicated MiniCheck/NLI server) only if Granite-groundedness fails calibration.
- **The crux is not the model — it's the parity gate.** R-8 must pass a **conservative-direction** test (zero ungrounded→grounded flips vs the incumbent + human adjudication) before it can ever gate. The harness *already has the substrate*: `inferential_corpus_eval.py` (live dual-sensor corpus scorer with label agreement) + `calibration/reliability.py` (ICC/AC2 release gate). E0 below extends them.

---

## 1. Why R-8 — the residual gap (measured)

| Measure (clean E2E, 2026-06-13, consult `019eb9ee…`) | Value |
|---|---|
| Draft latency (start → `persist_draft`) | **159.2 s** — misses < 120 s |
| `run_inferential_sensors` | **112.6 s (71 %)** |
| ↳ groundedness (31 per-claim entailment calls) | the dominant term |
| `generate` (SOAP) | 42.8 s |
| everything else | < 4 s |

Why each groundedness call is ~7 s for a binary yes/no (README §2b, Appendix 02 §3.2):
- `gemma-4-e4b` is a **reasoning** model — it emits a full `<think>` trace (~140 tokens) before `{"supported": bool}`; decode of that trace is the bulk of per-call cost. The `/no_think` lever was **empirically disproven on gemma** (README change-log 2026-06-13 probe: reasoning intact, latency unchanged).
- The shared transcript **premise (~1 000–1 500 tokens) is re-prefilled every call** (no KV reuse).

Levers already spent: R-2 concurrency (optimal at **6**; 8/10/12 are *worse* — GPU saturates), R-4 per-claim `asyncio.gather` (276 s → 112 s, **2.45×**, verdicts byte-identical). R-5 batching was **built and rejected** — it loosened two stable verdicts (clinical framing-dependence). **Concurrency and parallelism are exhausted; the only remaining lever is per-call cost → a different verifier.**

---

## 2. Scope — what R-8 changes (and what it must NOT)

**In scope (runtime sensor entailment only):**
- `GroundednessSensor` — the 31-call hotspot.
- `CitationVerifySensor` — same judge, same `{"supported": bool}` contract, 0 calls in the measured run but active once retrieval returns chunks.

**Explicitly OUT of scope (do not touch):**
- **Safety / Granite** — already no-think single-token (~0.3 s/call), gathered under R-4; not the bottleneck. (R-8a *reuses* this model for groundedness but leaves the safety path unchanged.)
- **The offline PDSQI eval/release judge** (`eval/judge/pdsqi.py`, `eval/ci.py`) — that path stays on `gemma`/Azure. R-8 targets the **runtime** judge only (`get_runtime_judge_config()` → `_build_runtime_judge()` in `temporal/activities.py`), a *separate* config from `get_judge_config()`. This isolation is what keeps R-8 from perturbing the calibrated release gate.
- The Temporal workflow command sequence (no replay-fixture / `workflow.patched()` work — R-8 is a same-shape activity-internal swap; the judge is constructed inside the activity, not the workflow body).

**Safety invariants carried verbatim from README §7:** degraded/parse-fail/timeout ⇒ claim **ungrounded** (stricter); never an auto-PASS; a backend failure ⇒ `degraded_result`, never an exception into the durable loop.

---

## 3. The integration seam (exact code surface)

The judge is already model-agnostic — this is a small, well-bounded swap:

- **Contract:** `JudgeClient` Protocol — `async complete(messages, *, json_mode, temperature, seed) -> str` (`eval/judge/base.py:29`).
- **Call sites (unchanged):** `groundedness.py:202` and `citation_verify.py:96` call `judge.complete(..., json_mode=True, temperature=0.0)` and parse `{"supported": bool}` via `_is_supported` (`groundedness.py:107`).
- **Construction (single point):** the activity builds one judge via `_build_runtime_judge()` and fans it into the sensors (`activities.py`, see Appendix 02 §3.1).
- **Factory + config:** `build_judge_client()` switches on `JudgeProvider` (`eval/judge/providers.py:297`); enum + knobs in `eval/config.py:26,70`.

> **Cleanest adapter shape:** implement R-8 as a **new `JudgeClient`** whose `complete()` returns the literal string `'{"supported": true}'` / `'{"supported": false}'`. Then **the sensors and the `_is_supported` parser change by zero lines** — only a new provider value + a `build_judge_client` branch + config knobs. The conservative-fallback semantics (`unparseable → ungrounded`) are inherited unchanged.

For **R-8a** specifically: `GraniteGuardianClient` (`sensors/inferential/granite_client.py`) already speaks the LM-Studio `<score>yes/no</score>` BYOC protocol; the R-8a adapter posts a **groundedness** criterion (context = premise, hypothesis = claim) and maps `no-risk/grounded → supported:true`. It can wrap that client or post directly, but exposes the `JudgeClient` interface so the sensors stay agnostic.

---

## 4. Candidate verifiers — the one real fork (§9 Q1)

| Option | What | Infra lift | Latency upside | Accuracy risk | Notes |
|---|---|---|---|---|---|
| **R-8a — reuse-resident Granite (recommended)** | Granite Guardian *groundedness* mode for groundedness/citation; safety path unchanged | **None** — model already loaded | no-reasoning single-token verdict: ~7 s → ~1–3 s/call ⇒ pass ~10–40 s | Med-High | #3 LLM-AggreFact (beats gpt-4o); confirm LM-Studio `granite-guardian-4.1-8b` exposes a groundedness risk/BYOC + accepts the long premise. Pairs with R-9 to also kill the prefill. |
| **R-8b — dedicated verifier** | Bespoke-MiniCheck-7B / sub-1B NLI (DeBERTa-MNLI) on `llama-server`/vLLM with prefix caching | **High** — new server + model + ops | fastest: ms-class verdicts, >500 docs/min, prefix-KV reuse built in | Med | Purpose-built fact-checkers; the cleanest long-term answer but a new deployment surface. Effectively R-8b **= R-8 + R-9** bundled. |
| **R-8c — cascade** | NLI fast tier (<60 ms) → escalate only the 0.2–0.8 uncertain band to `gemma` | Med (adds NLI tier) | ~19–34× on clear-cut claims; keeps gemma for hard calls | Lowest (gemma still adjudicates the hard band) | Best accuracy *preservation*, most code; the "safe" way to get most of the win while keeping the incumbent on borderline claims. |

Evidence base: Appendix 05 Topic 1 (MiniCheck ~400× cheaper at GPT-4 accuracy; Granite Guardian groundedness mode; ChainCheck/HalluScan cascades) + §9 sources.

---

## 5. The validation gate (the crux) — built on existing tooling

A faster judge is worthless if it loosens a verdict (Phase-B batching proved this is a *real*, non-noise risk on clinical content). The gate, in priority order:

1. **Conservative-direction parity (the decisive metric).** Not overall accuracy — the **directional confusion matrix** vs the incumbent (`gemma`, the currently-shipped judge) on a corpus:
   - **Unsafe flip** = incumbent says *ungrounded*, candidate says *grounded* → **must be zero** (or human-adjudicated to confirm the candidate is right and gemma was over-flagging).
   - **Safe flip** = candidate over-flags (grounded→ungrounded) → tolerable (noisier, never less safe).
2. **The measured-note anchor.** Reproduce the baseline note's **19 ungrounded / 12 grounded** split (consult `019eb9ee…`); the candidate must not regrade any of those 19 to grounded.
3. **Statistical calibration.** Feed paired verdicts through the existing `calibration/reliability.py` (`assert_judge_calibrated`, ICC ≥ 0.8 / Gwet AC2) — the same release gate the PDSQI judge already uses.
4. **Live shadow mode.** Before flipping authority: run the candidate **alongside** gemma in a real worker for N consults, candidate verdict **logged but NOT gating**, until 1–3 hold on live data. (Mirrors the Phase-B live parity gate.)

**Substrate already exists** (this is why R-8 validation is cheap to build):
- `eval/inferential_corpus_eval.py` already runs the **live** groundedness + safety sensors over a golden set, derives a citations map, and reports **agreement vs curated labels**. E0 extends it to score **two judges side-by-side** and emit the disagreement/confusion report.
- `eval/golden/fixtures/curated_v1.json` + `eval/calibration/reliability.py` provide the corpus and the ICC/AC2 gate.
- Gap to fill: a **clinically-adjudicated ground-truth set** for the disagreements (gemma-as-incumbent is a *proxy*, not truth — §9 Q2).

---

## 6. Phasing (TDD; each gate-checked, default-OFF until E4)

| Slice | What | Output / gate |
|---|---|---|
| **E0** | Extend `inferential_corpus_eval.py` → **dual-judge shadow scorer** + a parity/confusion report (offline, no runtime change) | The go/no-go instrument. RED-first on the report shape. |
| **E1** | Implement the candidate as a `JudgeClient` adapter + `JudgeProvider` value + runtime config knobs; **default OFF** (runtime judge stays `gemma`) | Unit tests: verdict parse, conservative fallback (`unparseable/timeout → ungrounded`), governor/timeout reuse. Sensors unchanged. |
| **E2** | Offline corpus parity run (E0) on the candidate → **decision** | Pass = §5.1–§5.3. **If it loosens → STOP** (park R-8, like batching). |
| **E3** | Live shadow in one worker (candidate logged, gemma gates) for N consults | §5.4 parity on live data **+ measured per-call / pass latency** (prove the speedup is real, as R-4 did). |
| **E4** | Flip the runtime judge default to the candidate via config; re-measure E2E | gemma remains **instant rollback** (one config flip). README change-log row with before/after. |

R-9 (dedicated `llama-server --cache-reuse` / prefix-KV) is the natural amplifier and is **bundled into R-8b**; for R-8a it is a follow-on if prefill (not reasoning) becomes the new floor.

---

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Weaker judge loosens verdicts (clinical-safety regression) | The §5 conservative-direction gate; zero-unsafe-flip bar; shadow mode before authority; instant config rollback. |
| Granite-groundedness mode unavailable / mis-calibrated on long premises (R-8a) | E2 catches it offline; fall back to R-8b. Confirm the risk/BYOC + context-length support in E1. |
| New deployment surface (R-8b server) | Prefer R-8a first (no new infra); only stand up R-8b if R-8a fails calibration. |
| Ground-truth is only gemma-proxy | Human-adjudicate the disagreement set (small N — only where the two judges differ) before E4 (§9 Q2). |
| Effort spent for a goal Phase D already softened | §9 Q0 — decide up front whether raw < 2 min still matters. |

---

## 8. Open decisions → see §9 (Q0 worth-it, Q1 model fork, Q2 ground truth, Q3 go/no-go bar).

## 9. Decisions needed before E0

- **Q0 — Is raw < 2 min still worth a High-risk change**, given Phase D already delivers the < 30 s *perceived* win? (Proceed / park R-8 / proceed-but-only-the-offline-E0-instrument.)
- **Q1 — Which verifier fork:** R-8a reuse-resident Granite (recommended) · R-8b dedicated MiniCheck/NLI · R-8c NLI-first cascade.
- **Q2 — Ground truth for the parity gate:** gemma-incumbent-proxy only · **+ human adjudication of disagreements** (recommended for a clinical gate).
- **Q3 — Go/no-go bar:** **zero unsafe (ungrounded→grounded) flips** on corpus + the 19-ungrounded note (recommended) · a tolerance band.

## 10. Change history

| Date | Description | Files |
|---|---|---|
| 2026-06-14 | **R-8 PARKED.** After the v2 prompt-iteration confirmed R-8a's safety miss is prompt-resistant, R-8 is parked: **no runtime swap** (judge stays gemma), and the two offline artifacts (`GraniteGroundednessJudge` adapter + `inferential_judge_parity` instrument, both default-OFF and fully tested) are **kept in-tree** as the ready substrate for a future R-8b. Rationale: Phase D already delivers the *perceived* < 30 s win, so R-8 only moves the *raw* number; R-8a can't pass the (correct) zero-unsafe-flip clinical gate; R-8c cascade yields ~no net speedup (grounded majority re-pays gemma); R-8b is new infra. **Reopen trigger:** raw latency becomes user-blocking → resume at R-8b scored against a *human-truth* label set (not the noisy gemma proxy) using the existing parity tool. No code change in this step (doc-only). | `09-r8-faster-judge-scope.md`, `README.md` |
| 2026-06-14 | **E2 RE-RUN with tightened BYOC prompt (v2) → genuine miss is PROMPT-RESISTANT; prompt-iteration exhausted.** Hypothesis: the q04 loosening was a prompt gap, not a model gap — so the groundedness criterion in `_groundedness_block` was tightened from "asserts clinical information not stated/entailed" to "**contains ANY detail — clinical fact, measurement, dose, date/duration, OR a patient demographic such as age or sex — not explicitly stated nor directly entailed**; every detail must be verifiable; an unsupported detail meets the criteria even if the rest is supported" + scoring "if not **fully** supported, 'yes'". Adapter tests still 9/9, ruff clean. Re-ran the full 18-case sweep (`r8-parity-curated_v1-v2.json`, same env). **Result: the 4 unsafe flips are byte-for-byte identical to v1** (q04-claim-1, c01-claim-2, c03-claim-5, c05-claim-1) — **q04 "Four-year-old…" still scored grounded despite the explicit *age* instruction**. Side effects: safe_flips 5→0 and agreement 87.7 %→94.5 % (the change quieted gemma-noise-side disagreements, did **not** make Granite stricter on the cases that matter); latency unchanged (gemma 24.1 s/case, Granite 11.4 s/case, ~2.1×). **Conclusion:** Granite Guardian's groundedness head does not catch this fabricated-demographic class even when explicitly told to, and the 4 unsafe flips are stable signal (the noisy safe-flips vanished, the unsafe-flips did not). **Prompt engineering is not a path to the zero-unsafe-flip bar for R-8a.** Remaining forks are structural (cascade R-8c / different model R-8b / human-truth recalibration) or park. **No runtime swap; default judge stays gemma.** | `apps/harness/src/harness/sensors/inferential/granite_client.py`, `r8-parity-curated_v1-v2.json`, `09-r8-faster-judge-scope.md` |
| 2026-06-14 | **E2 LIVE PARITY SWEEP DONE (curated_v1, 18 cases) → R-8a gate FAILS as-is.** Both models resident in LM Studio (gemma-4-e4b + granite-guardian-4.1-8b); run via `python -m harness.eval.inferential_judge_parity` (`HARNESS_JUDGE_MAX_TOKENS=3072`, `JSON_RESPONSE_FORMAT=text`, `HARNESS_LLM_MAX_CONCURRENCY=6`); report `r8-parity-curated_v1.json`. **Aggregate:** 73 claims compared, **agreement 87.7 %**, agree=64, **unsafe_flips=4, safe_flips=5**, 0 degraded; **latency: gemma 27.9 s/case vs Granite 11.6 s/case (~2.4× faster)** → projects the 112 s groundedness pass to ~47 s ⇒ E2E ~95 s (would clear <2 min). **`passed=false`** (zero-unsafe-flip bar). **Human adjudication of the 4 unsafe flips (Q2; gemma is a proxy, not truth):** (1) **q04 peds-otitis claim-1 [S]** "**Four-year-old** with two days of right ear pain…" — the age is **absent from the transcript**; gemma flagged it, Granite missed it → **GENUINE Granite loosening** (the disqualifying direction). (2) **c01 fabrication-mi claim-2 [P]** "Aspirin 81 mg daily, stress test, cardiology follow-up" — fully in the source Plan (the fabrication is the *other* claim, the MI) → **gemma false-positive, Granite correct**. (3) **c03 verbose-rhinitis claim-5 [A]** "allergen avoidance… discussed **in a fair amount of detail**" — core supported, only the embellishment is unsupported → **borderline, Granite defensible**. (4) **c05 uncited-otitis claim-1 [A]** "Right acute otitis media… red, bulging right eardrum" — all findings in source (case flaw is missing *citations*, not accuracy) → **gemma false-positive, Granite correct**. **Takeaways:** the instrument worked (caught a real loosening AND exposed gemma as a noisy proxy — ~half the "unsafe flips" were gemma's own over-flags); R-8a is fast and competitive but not zero-unsafe as-is. **Options:** park R-8a (accept ~159 s raw; perceived already solved by Phase D) · iterate the groundedness BYOC prompt (demand every demographic/temporal detail be supported, re-run E2) · cascade R-8c (Granite fast-tier, escalate disagreements to gemma — catches q04) · build a small human-truth set and re-score vs truth (gemma's noise suggests Granite may beat it on real labels). **No runtime swap; default judge stays gemma.** | `09-r8-faster-judge-scope.md`, `r8-parity-curated_v1.json` |
| 2026-06-14 | **E0 + E1 BUILT (offline, TDD RED→GREEN, default-OFF — no runtime change).** **E1 (R-8a candidate):** `GraniteGroundednessJudge` added to `sensors/inferential/granite_client.py` — a drop-in `JudgeClient` that reframes the sensors' `PREMISE/HYPOTHESIS` envelope as a single no-think Granite *groundedness* BYOC call (premise=Context, claim=assistant statement), maps `<score>no</score>`→`{"supported":true}` / `<score>yes</score>`|unparseable→`{"supported":false}` (conservative), raises `JudgeConnectionError` on transport failure (sensor degrades). Reuses the existing `_SCORE_RE`/`_GUARDIAN_INSTRUCTION`/`_chat_completions_url`/`governed_request`; exported from `sensors/inferential/__init__.py`. NOT wired into `build_judge_client`/`JudgeProvider` (runtime judge stays gemma) — the E4 flip is deferred behind the gate. **E0 (parity instrument):** `eval/inferential_judge_parity.py` — runs the live `GroundednessSensor` over a golden set with BOTH judges over identical claims; pure `diff_verdicts` → directional confusion (unsafe = incumbent-ungrounded→candidate-grounded; safe = stricter); `summarize_parity` gate (`passed = unsafe_total==0 and compared>0`); per-judge latency; unsafe-flip disagreement export for human adjudication (Q2); CLI writes a JSON report. Reuses `inferential_corpus_eval.build_inferential_context`. **Tests:** `test_granite_groundedness_judge.py` (9) + `test_inferential_judge_parity.py` (11) green; full sensors+eval suite **310 passed**; ruff clean; ReadLints clean. **Smoke (2 quality cases, live):** 9 claims, 100% agreement, 0 unsafe flips; candidate ~2.4× faster (gemma 29.6s/case vs Granite 12.4s/case) — pipeline validated; calibration cases (the discriminating ones) pending the full E2 sweep. | `apps/harness/src/harness/sensors/inferential/{granite_client.py, __init__.py}`, `apps/harness/src/harness/eval/inferential_judge_parity.py`, `apps/harness/src/harness/tests/unit/{sensors/test_granite_groundedness_judge.py, eval/test_inferential_judge_parity.py}` |
| 2026-06-14 | R-8 scope authored after Phase D completion. Grounded in code reads of the judge seam (`eval/judge/base.py`, `providers.py`, `eval/config.py`), the two entailment sensors (`groundedness.py`, `citation_verify.py`), the resident Granite client (`granite_client.py`), and — key finding — the **existing validation substrate** (`eval/inferential_corpus_eval.py` live dual-sensor corpus scorer + `eval/calibration/reliability.py` ICC/AC2 gate). Defines the seam (a `JudgeClient` adapter returning `{"supported":bool}` → zero sensor changes), three model forks (R-8a reuse-resident Granite recommended / R-8b dedicated MiniCheck / R-8c cascade), the conservative-direction parity gate, and E0–E4 phasing. Scope only — no code. Awaiting Q0–Q3. | `09-r8-faster-judge-scope.md` |
