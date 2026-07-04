# TASK-355 · Appendix 05 — External Best-Practices Research (2025–2026)

> Produced by the research agent (web research, June 2026). Every claim carries a source URL.
> Context given to the agent: 344 s inferential gating pass (94 % of pipeline), serialized LLM-as-judge
> calls at concurrency 1 against LM Studio, ~6 min note delivery, <2 min target.

## Executive summary

The `run_inferential_sensors` pass is slow for one structural reason: it already fans out sensors with `asyncio.gather`, but every LLM call is then **re-serialized by `HARNESS_LLM_MAX_CONCURRENCY=1`** against a single-request LM Studio backend — paying per-call latency × N calls, sequentially, with the same large instruction+document prefix recomputed every time. The highest-leverage fixes attack exactly those three multipliers: **(1) concurrency** (LM Studio 0.4.0 does continuous batching; raise the governor), **(2) per-call cost** (small specialized verifiers — MiniCheck / Granite Guardian groundedness mode — and NLI-first cascades), **(3) redundant prefill** (prefix caching of the shared system prompt + document). Industry ambient scribes ship notes in ~20–90 s, so <2 min is a reasonable target.

---

## Topic 1 — LLM-as-judge latency optimization

### Batching multiple claims per call vs per-claim

- Batching reduces round-trips and is the production default — **but only with CoT that forces the judge to enumerate each claim, structured JSON output, and temperature 0**. Naive "score all of these" prompting produces shallow vibe-scoring. ([galtea.ai](https://galtea.ai/blog/llm-as-a-judge-the-complete-guide), [labelyourdata.com](https://labelyourdata.com/articles/llm-as-a-judge))
- The accuracy cost of over-batching is quantifiable: judges exhibit **position bias** weakly correlated with prompt length, strongly affected by item-quality gaps (150 k-instance study, 15 judges) ([aclanthology.org/2025.ijcnlp-long.18](https://aclanthology.org/2025.ijcnlp-long.18.pdf)); long combined prompts also hit **context-window-overflow failures** scored as wrong ([arxiv 2606.01629](https://arxiv.org/html/2606.01629v2)).
- **"Attention overflow"**: list-reasoning degradation begins around **~100 items** for mid-2024 flagships; Llama-3-8B holds 75 % accuracy only below ~1 024 items ([aclanthology.org/2025.findings-ijcnlp.44](https://aclanthology.org/2025.findings-ijcnlp.44.pdf)). → **Batch in small groups (≈5–15 claims, e.g. per SOAP section), not all-at-once.**
- Parallelizing orthogonal sub-judgments cut judge latency **~38 %** in a controlled MT-Bench experiment ([tylerburleigh.com](https://tylerburleigh.com/blog/2025/03/02/)).

### Small specialized verifiers instead of a large general judge

- **MiniCheck**: GPT-4-level fact-checking accuracy at **~400× lower cost**; `MiniCheck-FT5` is 770 M params; works sentence-level with **no claim-decomposition step**. ([aclanthology 2024.emnlp-main.499](https://aclanthology.org/2024.emnlp-main.499.pdf), [arxiv 2404.10774](https://arxiv.org/html/2404.10774v2))
- **Bespoke-MiniCheck-7B**: SOTA on LLM-AggreFact (beats GPT-4o, Mistral-Large-2), millisecond-class verdicts, `enable_prefix_caching=True`, **>500 docs/min on one A6000** with vLLM. Sub-1B variants exist (Flan-T5-L 0.8B, RoBERTa-L 0.4B, DeBERTa-v3-L 0.4B). ([huggingface.co](https://huggingface.co/bespokelabs/Bespoke-MiniCheck-7B), [bespokelabs.ai](https://bespokelabs.ai/blog/hallucinations-fact-checking-entailment-and-all-that-what-does-it-all-mean), [github.com/Liyan06/MiniCheck](https://github.com/Liyan06/MiniCheck/blob/main/README.md))
- **Granite Guardian (already deployed here) is a groundedness verifier, not just a safety classifier**: GG 3.3-8B ranks #3 on LLM-AggreFact and #1 on REVEAL, beating gpt-4o despite 8B size; emits a **single Yes/No token + risk probability** (`max_new_tokens≈20`); built-in `groundedness`, `context_relevance`, `answer_relevance` risk configs; sizes 2B / 3B (MoE, low-latency) / 5B (~30 % pruned from 8B) / 8B. ([github.com/ibm-granite/granite-guardian](https://github.com/ibm-granite/granite-guardian), [arxiv 2412.07724](https://arxiv.org/html/2412.07724v1), [huggingface.co/ibm-granite/granite-guardian-3.2-5b](https://huggingface.co/ibm-granite/granite-guardian-3.2-5b), [heidloff.net](https://heidloff.net/article/risk-detection-granite-guardian-llms/)) → **GG's groundedness mode can replace much of the LLM-judge groundedness pass; binary-token output makes decode near-free (cost is prefill → see prefix caching).**

### Cascade / early-exit verification

- **ChainCheck**: NLI first (~51–60 ms), escalate to the judge (~1 113–1 755 ms) only in the ambiguous **0.2–0.8** band — **~19–34× faster on clear-cut claims**; judge alone 95.5 % precision, cascade flags correctly 96.5 %. ([github.com/pauti04/chaincheck](https://github.com/pauti04/chaincheck), [pypi.org/project/chaincheck](https://pypi.org/project/chaincheck/))
- **HalluScan**: free local pre-filters (<1 ms) route only uncertain cases to expensive verifiers — **~2.0× cost reduction, minimal AUROC loss**; documented production cascade: DeBERTa fast tier → vLLM judge slow tier. ([arxiv 2605.02443](https://arxiv.org/html/2605.02443v1), [docs.llmtrace.io](https://docs.llmtrace.io/architecture/JUDGE_CASCADE/))
- For citation verification, NLI/DeBERTa-MNLI entailment (claim = hypothesis, cited span = premise) is the natural cheap tier.

---

## Topic 2 — Local LLM serving throughput

- **LM Studio historically served one request at a time — changed in 0.4.0** (llama.cpp 2.0.0 engine): parallel requests via continuous batching, **`Max Concurrent Predictions`** (default 4; `--n-parallel N` headless) + **Unified KV Cache** (on by default, "no additional memory overhead"). Community report: **>10× speedup** for short-output/high-concurrency workloads — which describes binary-verdict judge calls. ([lmstudio.ai/blog/0.4.0](https://lmstudio.ai/blog/0.4.0), [github.com/lmstudio-ai/docs](https://github.com/lmstudio-ai/docs/blob/c6854fba/0_app/5_advanced/parallel-requests.md)) → **This removes the original reason `HARNESS_LLM_MAX_CONCURRENCY=1` exists.**
- **llama.cpp server**: concurrency needs **`--parallel N` AND `--cont-batching`**; without the latter it still answers one at a time. ([llama.cpp server README](https://github.com/ggml-org/llama.cpp/blob/refs/heads/master/tools/server/README.md), [resonance.distantmagic.com](https://resonance.distantmagic.com/tutorials/how-to-serve-llm-completions/))
- **vLLM**: PagedAttention + continuous batching → **5–10× (up to 10–24× cited)** throughput under load; at 32 concurrent requests ≈10× llama.cpp; ~12 500 tok/s for Llama-3.1-8B on one H100. ([dibi8.com](https://dibi8.com/resources/llm-frameworks/local-llm-runner-comparison-2026/), [techplained.com](https://www.techplained.com/ollama-vs-vllm-vs-llamacpp), [pub.towardsai.net](https://pub.towardsai.net/i-tested-ollama-vs-vllm-vs-llama-cpp-the-easiest-one-collapses-at-5-concurrent-users-d4f8e0e84886), [tensorfoundry.io](https://tensorfoundry.io/blog/llm-inference-servers-compared))

### Prefix caching / KV reuse (critical: many same-prefix judge calls)

- Judge calls here share an identical instruction prefix + document context, differing only in the claim — the canonical prefix-caching win.
- **vLLM Automatic Prefix Caching** (`--enable-prefix-caching`): shared prefix computed once; saves **prefill only**; 16-token block granularity. ([docs.vllm.ai](https://docs.vllm.ai/en/latest/features/automatic_prefix_caching/), [turion.ai](https://turion.ai/blog/vllm-vs-sglang-inference-comparison-2026/))
- **SGLang RadixAttention** (token-level, on by default): up to **5× throughput**, **3–5× lower effective prefill latency at >60 % prefix reuse**, ~29 % higher throughput than vLLM, 75–95 % hit rates with shared system prompts. ([lmsys.org](https://lmsys.org/blog/2024-01-17-sglang/), [devcheolu.com](https://devcheolu.com/en/posts/azRkCJ0tMGnqdtPNDheD), [turion.ai](https://turion.ai/blog/vllm-vs-sglang-inference-comparison-2026/))
- Because judge **decode is tiny** (a verdict), **prefill dominates → prefix caching is disproportionately valuable**.

---

## Topic 3 — Incremental / streaming verification architectures

- Post-hoc atomic-claim pipelines (FActScore, SAFE) are explicitly "impractical for real-time"; the research direction is **streaming verification concurrent with generation**. ([arxiv 2509.03531](https://arxiv.org/html/2509.03531v1))
- **Streaming-VR**: verify/correct tokens *as generated*, external verifier running simultaneously with generation. ([arxiv 2501.07824](https://www.arxiv.org/pdf/2501.07824v3))
- **Real-time token-level entity-hallucination detection** (fabricated names/dates/citations): **0.90 AUC** with no retrieval and no auxiliary LLM — usable as an always-on cheap tier while drafting. ([arxiv 2509.03531](https://arxiv.org/html/2509.03531v1))
- **Verify-while-draft (PPSD)**: overlapping drafting and verification eliminates idle bubbles → **2.01–3.81× speedup**; principle: don't wait for full generation to start verifying. ([arxiv 2509.19368](https://www.arxiv.org/pdf/2509.19368), [openreview.net](https://openreview.net/forum?id=6ezbdRe90k))
- **Claim-hash caching**: verify each partial summary's claims during the session, store `{hash(claim+evidence) → verdict}`, verify **only the delta** at finalization — same reuse logic as prefix caching, applied at the application layer; this is what shifts verification off the end-of-consult critical path.

---

## Topic 4 — Temporal workflow latency best practices

- Run independent activities concurrently with `asyncio.gather` on activity handles (deterministic event loop; durable cancellation). The harness already gathers — the win is removing downstream serialization, not changing the workflow. ([temporalio/samples-python](https://github.com/temporalio/samples-python/blob/main/hello/hello_parallel_activity.py), [temporal.io blog](https://temporal.io/blog/durable-distributed-asyncio-event-loop))
- **Heartbeat long LLM activities**; `heartbeat_timeout` < `start_to_close`; heartbeats throttled to ~0.8 × heartbeat_timeout; **cancellation is only delivered on heartbeat** — a non-heartbeating activity can't be cancelled. Matches TASK-354 Defect A exactly. ([docs.temporal.io](https://docs.temporal.io/develop/python/activities/timeouts), [community.temporal.io](https://community.temporal.io/t/long-running-activities-right-practices-questions/10726))
- **Activity granularity**: single-purpose activities give finer recovery/visibility; put the per-call timeout where the hang manifests (per judge call), not per sensor.
- **Local activities**: only for millisecond/second glue (e.g. progress) — don't chain many, don't use for long ops. ([skill-temporal-developer patterns](https://github.com/temporalio/skill-temporal-developer/blob/main/references/core/patterns.md))
- Splitting the judge pass into many short activities only pays off when scaling beyond one inference box; otherwise the backend is the bottleneck. Cap fan-out with `maxConcurrentActivityExecutionSize`.

---

## Topic 5 — Clinical documentation industry benchmarks (2025–2026)

| Vendor | Reported time-to-note | Notes |
|---|---|---|
| **Nabla** | **sub-20 s** | fastest cited ([ai-agent-brief.com](https://www.ai-agent-brief.com/ai-for-business/healthcare-medical/nuance-dax-vs-suki-ai-vs-nabla-which-ai-medical-scribe-is-best.html)) |
| **Commure** | **~43 s avg chart close**, 99.4 % accuracy | ([commure.com](https://www.commure.com/blog-scribe/best-ai-medical-scribes)) |
| **LucasAI** | **~52 s avg** | "note ready as you leave the room" ([lucashealth.ai](https://lucashealth.ai/compare/lucasai-vs-ambience)) |
| **Suki** | **~60 s** | ([ai-agent-brief.com](https://www.ai-agent-brief.com/ai-for-business/healthcare-medical/nuance-dax-vs-suki-ai-vs-nabla-which-ai-medical-scribe-is-best.html)) |
| **Abridge** | **30–90 s** | click-to-hear source audio per note line (grounding presented to reviewer, not blocking) ([mytheai.com](https://mytheai.com/compare/abridge-vs-nuance-dax)) |
| **Ambience** | real-time | enterprise "documentation integrity" emphasis ([lucashealth.ai](https://lucashealth.ai/compare/lucasai-vs-ambience)) |
| **Nuance/Microsoft DAX Copilot** | **2–3 min** (some configs minutes→hours) | ([ai-agent-brief.com](https://www.ai-agent-brief.com/ai-for-business/healthcare-medical/nuance-dax-vs-suki-ai-vs-nabla-which-ai-medical-scribe-is-best.html)) |

- Industry vocabulary: *real-time* = ready before the patient leaves; *near-real-time* = **within 1–2 min**; *delayed* = minutes-to-hours. ([glass.health](https://glass.health/resources/best-ai-medical-scribe)) → **6 min = "delayed"; the 2-min target = slow end of "near-real-time"; leaders are <90 s.**
- Grounding trend: Abridge's differentiator is **traceability presented to the reviewer** (line→source audio), not a serialized post-hoc judging gate.

---

## Ranked actionable techniques for THIS system

1. **Remove the concurrency-1 bottleneck** (config + LM Studio ≥0.4.0 w/ parallel slots; raise governor to match): ~**2–5×** on the serialized chain; pair with TASK-354 per-call timeout + heartbeat so a stuck slot degrades instead of stalling.
2. **Prefix caching of the shared instruction+transcript prefix** (LM Studio unified KV / llama-server `--cache-reuse`; bigger win on vLLM/SGLang): **3–5× lower prefill** at high reuse; decode already tiny.
3. **Small specialized verifiers + cascade** (Bespoke-MiniCheck or GG groundedness mode; NLI-first escalation on the 0.2–0.8 band): ~19–34× on clear-cut claims, ~2× fewer expensive calls — **raises accuracy** (these beat general judges on LLM-AggreFact). Requires calibration before trusting in a clinical gate.
4. **Move verification into the live consultation** (incremental + claim-hash cache + delta-verify at stop): the structural change that approaches the <90 s industry band.
5. **Modest claim batching** (5–15/call, label-each, strict JSON, temp 0): safe round-trip reduction; stay far below the ~100-item overflow zone.
6. **Temporal hygiene** (per-call timeout, heartbeat, local-activity progress): tail-latency + reliability, not steady-state throughput.

**Realistic path to <2 min:** #1 + #2 alone (config/server only) plausibly take 344 s → ~80–150 s; #3 + #4 give comfortable margin and approach 30–90 s.

### Caveats / accuracy guardrails

- Prefix caching helps prefill only — if judges ever emit long rationales, decode dominates and gains shrink.
- Over-batching trades latency for position bias + attention overflow + context overflow — keep groups small.
- Clinical-gate cascades must **fail toward escalation**: fast-tier error/timeout ⇒ "uncertain → escalate"; slow-tier failure ⇒ conservative verdict.
