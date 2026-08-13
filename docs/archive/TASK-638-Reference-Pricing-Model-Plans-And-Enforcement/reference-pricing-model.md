# Reference Pricing Model — researched inputs + derived COST/SELL rate card

Companion to [README.md](./README.md). **Provenance:** the provider figures below are
~**Jan 2026** knowledge with the canonical pricing page cited per row — NOT live-fetched.
LLM prices move monthly; re-confirm against the live pages before any figure reaches a
customer-facing rate card. Currency USD. `unitPriceMicros` = integer micros (1e-6 USD) per
ONE unit (token, audio-second, character), matching `AiPriceBook`.

> **§4–§6 are RATIFIED and SEEDED** (book `2026-08-08-commercial-v1`, 2026-08-08). The two caveats that still travel with them: provider list prices are ~Jan-2026 knowledge, and self-hosted COST assumes ~90% GPU utilization (see §4).

---

## 1. Managed provider COGS (verify live)

**LLM $/1M tokens (representative mid-tier summarizer per provider):**

| Provider | Model | Input $/1M | Output $/1M | Source |
|---|---|---|---|---|
| OpenAI | GPT-5 mini | 0.25 | 2.00 | openai.com/api/pricing |
| OpenAI | GPT-4.1 mini | 0.40 | 1.60 | openai.com/api/pricing |
| Anthropic | Claude Sonnet 4.5 | 3.00 | 15.00 | anthropic.com/pricing |
| Anthropic | Claude Haiku 4.5 | 1.00 | 5.00 | anthropic.com/pricing |
| Azure OpenAI | GPT-4.1 mini (= OpenAI list; Data-Zone +10–20%) | 0.40 | 1.60 | azure … /openai-service |
| Bedrock | Amazon Nova Lite | 0.06 | 0.24 | aws.amazon.com/bedrock/pricing |
| Gemini/Vertex | Gemini 2.5 Flash | 0.30 | 2.50 | ai.google.dev/pricing |

Anthropic cache: write-5m = 1.25× input, write-1h = 2× input, read = 0.1× input (feeds the TASK-615 #7 `cacheTtl` COST rows). OpenAI cache read ≈ 0.1–0.5× input, no write surcharge.

**Other meters:** STT managed ≈ **$0.0001/audio-s** (Whisper $0.006/min; Deepgram Nova-3 $0.0000717/s; **Azure Speech $0.000278/s**). TTS managed ≈ **$0.000016/char** (Azure neural $16/1M, OpenAI tts-1 $15/1M; ElevenLabs 4–15× more — a premium, not commodity). Embeddings ≈ **$0.02/1M** (OpenAI 3-small / Voyage-lite) up to **$0.13/1M** (3-large).

**Per-token → micros:** `$/1M tokens` numerically equals `micros/token` (both are 1e-6). So Sonnet input $3/1M → **3 µ/token**; output $15/1M → **15 µ/token**. STT Azure $0.000278/s → **278 µ/audio-s** (this matches the existing seed COST row). TTS $0.000016/char → **16 µ/char**.

---

## 2. Self-hosted COGS (utilization-gated)

Cloud GPU $/hr (per single GPU, on-demand; neocloud/reserved cheaper): H100 ~$2.5–7, A100 ~$1.3–5, L40S ~$0.9–1.9, L4 ~$0.4–0.8. Throughput: 8B vLLM ~2,000–5,000 tok/s aggregate; 70B ~800–1,500 tok/s; whisper large-v3 RTFx 10–30× (up to 70× batched). US commercial electricity ~$0.13/kWh; H100 ~700W; PUE ~1.5.

Derived (formula in README §3.1, at **high** utilization):

| Meter | Self-hosted COGS | Managed COGS | Notes |
|---|---|---|---|
| LLM 8B | ~$0.17/1M tok (**~0.17 µ/token**) | $0.25–3/1M | sub-micro/token — see rounding note |
| LLM 70B | ~$0.69/1M tok (~0.69 µ/token) | $1–15/1M | |
| STT | ~$0.00002/audio-s (**~20 µ/s**) | $0.0001/s (100 µ) | ~5× cheaper than Whisper API |
| TTS (Kokoro/Indic) | GPU-economics like STT (single-digit–low-tens µ/char) | 16 µ/char | |

> **The dominant sensitivity is utilization.** At <30% GPU utilization the self-hosted COGS can EXCEED managed API prices. Model 30%/60%/90% before committing a self-hosted COST row.

> **Sub-micro rounding:** a self-hosted LLM token (~0.17 µ) is below the integer-micro floor. Options: (a) keep the self-hosted COST row at `0µ` (self-hosted LLM COGS is genuinely ~free at this granularity) and rate SELL off a managed reference; (b) add a `1000-token` unit if per-token COGS precision is ever needed. Recommend (a) — SELL is the revenue lever, and it should be **market-referenced**, not `self-host-COST × 4` (which would underprice).

---

## 3. Markup / margin — RATIFIED 80% / 5×

`SELL = COGS / (1 − target_gross_margin) = COGS × markup`. **Owner ratified 2026-08-08: `target_gross_margin = 80%` → markup = 5×** on all metered lines (the healthier end of the AI-SaaS 70–80% band).

For meters where the platform self-hosts (STT/TTS/embeddings, and LLM on the built-in models), self-hosted COGS is far below the managed price — so the `× 5` below is applied to the **managed reference COST** for each meter (what the platform pays on the SYSTEM/fallback provider), NOT to the near-zero self-hosted COGS. This makes the tenant pay a market-competitive rate while the platform banks the self-hosting delta ON TOP of the 80% target — i.e. 80% is the *floor* margin, higher whenever a self-hosted path serves the call.

---

## 4. COST rows — RATIFIED + SEEDED (book `2026-08-08-commercial-v1`)

Integer micros per unit. `provider: null` = self-hosted catch-all. Seeded 2026-08-08 — 26 COST rows.

> **Utilization caveat that travels with these numbers:** the self-hosted rows assume **~90% GPU utilization**. A clinical duty cycle is bursty (0.3–0.6) and cost/unit scales INVERSELY with utilization, so these rows **understate** self-hosted COGS at a realistic duty cycle — the margin-flattering direction. STT self-hosted is ~30µ at 60% and ~60µ at 30%. Changing the assumption is one number per affected row.

| plane | capability | provider | model | unit | µ/unit | basis |
|---|---|---|---|---|---|---|
| COST | STT | null (whisper_cpp) | — | AUDIO_SECOND | **20** | self-hosted high-util (was placeholder 3µ — too low) |
| COST | STT | azure-speech | — | AUDIO_SECOND | 278 | Azure real-time (already seeded) |
| COST | LLM | null (built-in) | — | INPUT_TOKEN | **0** | self-hosted ~sub-micro (see §2 note) |
| COST | LLM | null (built-in) | — | OUTPUT_TOKEN | **0** | " |
| COST | LLM | azure | gpt-4.1-mini | INPUT_TOKEN | 1 | $0.40/1M (round up from 0.4) |
| COST | LLM | azure | gpt-4.1-mini | OUTPUT_TOKEN | 2 | $1.60/1M |
| COST | LLM | anthropic | claude-sonnet-5 | INPUT_TOKEN | 3 | $3/1M |
| COST | LLM | anthropic | claude-sonnet-5 | OUTPUT_TOKEN | 15 | $15/1M |
| COST | LLM | anthropic | claude-sonnet-5 | CACHE_WRITE_TOKEN (cacheTtl `5m`) | 4 | 1.25× input, #7 dimension |
| COST | LLM | anthropic | claude-sonnet-5 | CACHE_WRITE_TOKEN (cacheTtl `1h`) | 6 | 2× input |
| COST | LLM | anthropic | claude-sonnet-5 | CACHE_READ_TOKEN | 1 | 0.1× input (round up) |
| COST | TTS | null (kokoro) | — | CHARACTER | 2 | self-hosted low |
| COST | TTS | azure-speech | — | CHARACTER | 16 | $16/1M |
| COST | EMBEDDING | null (lm-studio) | — | INPUT_TOKEN | 0 | self-hosted ~free |
| COST | EMBEDDING | openai | text-embedding-3-small | INPUT_TOKEN | 1 | $0.02/1M (round up) |

## 5. SELL rows — RATIFIED + SEEDED (book `2026-08-08-commercial-v1`)

Tier-agnostic overage defaults (`planTier: null`); add per-tier premium later if wanted (≤15%, D12). Each row is `5 × managed-reference COST`; the reference is named so you can adjust the basis without changing the 5×.

| plane | capability | unit | µ/unit | 5× of (managed reference) |
|---|---|---|---|---|
| SELL | STT | SESSION_SECOND | **500** | ~$0.0001/s Whisper-API-class (100µ) × 5 → ~$0.03/min. Covers the Azure-fallback COST (278µ) at ~1.8× and self-hosted (20µ) at 25×. |
| SELL | STT | AUDIO_SECOND | **500** | **CORRECTED at seeding time.** This row originally said 0 — wrong: `BILLABLE_UNITS[STT]` includes AUDIO_SECOND and OQ1 bills BATCH transcription on it (only *streaming* audio-seconds are excluded upstream). A 0 would have made batch transcription free. Seeded at parity with streaming. |
| SELL | LLM | INPUT_TOKEN | **5** | default SYSTEM model gpt-4.1-mini input ($0.40–1.0/1M ≈ 1µ) × 5 = ~$5/1M |
| SELL | LLM | OUTPUT_TOKEN | **10** | gpt-4.1-mini output ($1.60/1M ≈ 2µ) × 5 = ~$10/1M |
| SELL | LLM | CACHE_READ_TOKEN | 1 | 0.1× SELL input (≈0.5µ, rounded up) |
| SELL | LLM | CACHE_WRITE_TOKEN | 8 | ~1.5× SELL input |
| SELL | LLM | REASONING_TOKEN | **10** | **ADDED at seeding time** — this table omitted it. All billable token kinds pool into `monthlyLlmTokens` and the invoice engine FAILS CLOSED on a missing SELL rate, so a reasoning token in overage would have aborted the entire draft. Priced as output (market norm). |
| SELL | TTS | CHARACTER | **80** | Azure neural 16µ × 5 = ~$80/1M char |
| SELL | NLP | TEXT_UNIT | **50** | per 100-char NER unit (self-hosted GLiNER; no managed market — nominal) |
| SELL | EMBEDDING | INPUT_TOKEN | 1 | openai 3-small $0.02/1M ×5 ≈ 0.1µ → 1µ integer floor |

> **Premium models supersede.** These baseline SELL rows are priced off the **default SYSTEM model (gpt-4.1-mini class)**. A tenant running a pricier model (e.g. Sonnet, COST 3µ in / 15µ out) should get its own SELL rows keyed by model: `5× → 15µ in / 75µ out`. Add those as the premium tiers actually ship.

> **STT cost-basis caveat (decision #5):** SESSION_SECOND SELL must cover the *worst* provider the platform might route to. 500µ covers Azure-fallback (278µ) with margin; if you expect heavy Azure/premium-ASR routing, raise it. If you only ever self-host (20µ COGS), 500µ is a 25× margin and you could lower it to stay competitive.

## 6. Plan fees + allowances — RATIFIED 2026-08-08, SEEDED

Owner-ratified: **STARTER $50/mo · 50 consultations**, **PRO $100/mo · 250 consultations**, **ENTERPRISE negotiated / unlimited**. TRIAL stays a free 1-week PRO-entitled window.

**Intensity constants** used for the derivation (engineering estimates, revisit after a shadow-metering cycle): `avg_consultation_minutes = 20`, `avg_tokens_per_summary = 6,000` (in+out, all passes), `avg_tts_chars_per_consultation = 2,000`, `avg_ner_text_units = 30`, `avg_embed_tokens_per_consultation = 1,500`, `session_overhead = 1.1`.

| Tier | Plan fee/mo | consultations | transcriptionMin | summaries | sttSessionSeconds | llmTokens | ttsCharacters | nlpTextUnits | embeddingTokens |
|---|---|---|---|---|---|---|---|---|---|
| STARTER | **$50** | **50** | 1,000 | 50 | 132,000 | 600,000 | 200,000 | 3,000 | 150,000 |
| PRO / TRIAL | **$100** (TRIAL $0) | **250** | 5,000 | 250 | 660,000 | 3,000,000 | 1,000,000 | 15,000 | 750,000 |
| ENTERPRISE | negotiated | `null` | `null` | `null` | `null` | `null` | `null` | `null` | `null` |

**The per-capability numbers carry ×2 headroom on purpose.** `monthlyConsultations` is the *commercial* cap; the per-capability ceilings are **runaway guards** (a stuck loop, an abusive workload), not a second business cap. A tenant working normally inside its consultation cap must never trip one — which matters now that enforcement defaults ON in deployed environments (§5 of the README). Tighten them only once shadow metering reports real per-consultation intensity.

### 6.1 Margin check on the ratified fees — the one thing to watch

Per 20-minute consultation, at the §5 (5×) SELL rates the bundled value is ≈ **$0.86** (STT 1,320 session-s × 500µ = $0.66 · LLM 6k tokens ≈ $0.035 · TTS 2,000 × 80µ = $0.16 · NLP/embeddings ≈ $0.003).

| | STARTER ($50 / 50) | PRO ($100 / 250) |
|---|---|---|
| Bundled value at SELL rates | ~$43 | ~$215 |
| Fee vs bundled value | fee is **1.2× above** | fee is **0.47×** → a ~53% prepay discount |
| **COGS if self-hosted** (~$0.028/consultation) | $1.40 → **97% margin** ✅ | $7.00 → **93% margin** ✅ |
| **COGS if routed to Azure** (~$0.37/consultation) | $18.65 → **63% margin** ⚠️ | $93.25 → **~7% margin** 🚨 |

**Finding: both fees are healthy on self-hosted infrastructure and PRO is essentially break-even if its traffic falls back to managed Azure.** At a 30-minute average consultation, PRO on Azure goes *negative*. This is a routing-economics exposure, not a pricing error — the fees are fine for the intended self-hosted deployment.

**RESOLVED 2026-08-08 (owner): keep the SYSTEM default self-hosted; sell managed ASR as an add-on.** The fees stand as ratified.

### 6.2 Implementing that decision — what was already true, and what is not

Auditing the seed against the decision found the **structural posture already correct**, so the exposure was *latent*, not active:

| Invariant | State |
|---|---|
| Platform default ASR pipeline | `arcaai-whisper-large-ml-en-gguf` — self-hosted ✅ |
| SYSTEM managed-ASR provider connections (`azure-speech`, `sarvam`, `openai`, …) | `enabled: false`, `encryptedApiKey: null` — **no platform-funded managed credential** ✅ |
| SYSTEM `TenantSttConfig.fallbackPipelineId` | `null` — no platform-default fallback ✅ |

All three are now **locked by a seed-invariant guard**, `seed/__tests__/managed-asr-addon-posture.test.ts` (mutation-verified: flipping the SYSTEM `azure-speech` connection to `enabled: true` fails it). Enabling a SYSTEM managed-ASR connection *with a platform key* is precisely the change that would convert managed ASR from a tenant-funded add-on into a platform-funded default, and it now cannot happen silently.

### 6.3 Provider-aware rating — IMPLEMENTED (owner chose self-hosted-first)

The add-on could not carry a platform margin, because `BillingService.prefetchSellRates` resolved SELL rates with `provider: null` hard-coded — so a provider-keyed premium row would have been dead configuration. **Owner decision 2026-08-08: allowance allocation is SELF-HOSTED-FIRST**, and the engine now implements it.

**The allocation order is `SELF_HOSTED → BYOK → CLOUD`,** and each position is load-bearing:

| Tier | Position | Why |
|---|---|---|
| `SELF_HOSTED` | first | ~$0.028/consultation. Letting the bundled allowance absorb the cheap usage is what pushes expensive usage into overage. |
| `BYOK` | middle | Costs the platform **nothing** (the tenant funds it) — so it should not displace self-hosted from the allowance, but it must also never be rated at a managed premium. `prefetchSellRates` resolves the **provider-agnostic baseline** for BYOK deliberately: a premium recovers platform COGS, and on a tenant's own key the platform bears none. |
| `CLOUD` | last | ~$0.37/consultation. Spills into overage, where the provider-keyed premium row recovers the COGS. **This is the add-on being sold.** |

**This changes attribution only.** Total overage is `max(0, total − allowance)` under any ordering; the tiers decide *which* usage is the overage and therefore *at which rate* it prices. The property test (250 randomized scenarios) now varies deployment across all three tiers and re-proves that invariant.

**What it took** (the reason this was not a seed row):

1. **`deployment` joins the rollup grain** — schema + migration `20260808120000_task_638_rollup_deployment_dimension`, drainer, unique tuple. `provider` alone cannot answer it: the same `azure-speech` slug is CLOUD on a platform key and BYOK on a tenant key.
2. **`provider` + `deployment` survive into billing** — `DayUnitSum`/`DailyUnitQuantity` carry them, and the compensation aggregate (`sumDailyQuantitiesByOperation`) groups by them too. That last part is subtle and the tests caught it: the D16/OQ1 deductions *subtract from* rollup buckets, so if they don't agree on the key they cancel the wrong bucket.
3. **Tiered consumption in `computeCapabilityOverage`**, chronological within each tier, pro-rata across `(unit, provider)` inside the crossing day.
4. **Provider-keyed SELL rows** for `azure-speech` at **1,390µ** (5× the 278µ managed COST row) — now genuinely resolvable, so the add-on carries the ratified 80% margin instead of being subsidised at the self-hosted rate.

Mutation-verified: reversing the tier order makes managed overage bill at the 500µ baseline instead of the 1,390µ premium, and the guard test fails.

---

## 7. Decisions — status
1. ✅ **`target_gross_margin` = 80% → 5× markup** — RATIFIED 2026-08-08.
2. ✅ **Plan fees + consultation ceilings** — RATIFIED 2026-08-08 ($50/50, $100/250, ENTERPRISE negotiated). Seeded.
3. ✅ **The §5 SELL per-unit rates** — RATIFIED + SEEDED 2026-08-08 as book `2026-08-08-commercial-v1` (16 SELL rows). Two defects were caught and fixed while seeding: STT AUDIO_SECOND was 0 (would have made batch free) and REASONING_TOKEN was missing (would have aborted drafts).
4. ✅ **Intensity constants** — §6, applied with ×2 headroom; revisit after a shadow-metering cycle.
5. ⚠️ **Self-hosted COST utilization** — seeded at **~90%**, the value the §4 table encoded. This is the OPTIMISTIC end: at the 0.3–0.6 clinical duty cycle the doc itself predicts, self-hosted COGS is 1.5–3× higher, so reported margin is flattered. Revisit once real utilization is measured; each row carries the scaling in its note.
6. ✅ ENTERPRISE stays unlimited (negotiated per contract).
7. ✅ **Managed-fallback posture** — RESOLVED 2026-08-08: SYSTEM default stays self-hosted, managed ASR is an add-on. Locked by a seed-invariant guard (§6.2).
8. ✅ **Provider-aware rating** — RESOLVED 2026-08-08: allowance allocation is **self-hosted-first** (`SELF_HOSTED → BYOK → CLOUD`). Implemented and mutation-verified (§6.3); managed ASR now bills at 1,390µ/session-second while BYOK stays on the baseline.
