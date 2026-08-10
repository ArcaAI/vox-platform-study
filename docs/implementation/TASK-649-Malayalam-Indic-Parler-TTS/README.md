# TASK-649 — Malayalam TTS via Indic Parler-TTS (HF-Cache Read-Through)

| | |
|---|---|
| **Status** | Pending — **sourcing DECIDED 2026-08-09/10, see §0** |
| **§0 OWNER DECISION** | **Read-through HF cache, as instructed — TASK-495's offline MinIO mirror is superseded.** The choice was put to the owner with the trade-off stated plainly: `ai4bharat/indic-parler-tts` is click-through **gated**, so a read-through cache requires a **gate-accepted `HF_TOKEN` inside a PHI-adjacent pod**, able to pull arbitrary Hugging Face content — which is precisely what TASK-495 was designed to avoid. The owner chose read-through anyway, for consistency with every other model on this platform and because a miss then self-heals instead of failing. **Implement it that way, and do not silently reintroduce `HF_HUB_OFFLINE=1`.** Two consequences to carry: (1) the token's gate-acceptance is an *account-level* fact — a syntactically valid token whose account never accepted the terms still 401s, and that failure will look like a network problem; (2) egress to `huggingface.co` from the TTS pod is now expected traffic, so any future network policy must allow it or this breaks silently on the first cache miss. |
| **Type** | `infrastructure` — model deployment / cluster config |
| **Created** | 2026-08-09 |
| **Owner decision on file** | *"most of models will be handled by huggingface, the HF_HOME is set to the directory mapped to `/mnt/data` (it's a directory in an external disk)"*; *"we dont store any model file in any apps/services image"*; *"for stt, malayalam will be indic_parler"* (read as TTS — see §1.1) |
| **Cross-links** | [TASK-642 — TTS Kokoro Built-In](../TASK-642-TTS-Kokoro-Built-In/README.md) (the `HF_HUB_CACHE` read-through-cache pattern this ticket must reuse; OD-1 left Malayalam open) · [TASK-643 — Platform-Default Provider Credential Cascade](../TASK-643-Platform-Default-Provider-Credential-Cascade/README.md) (cloud-credential path only — see §1.2, does not block this ticket) · [TASK-495 — Mirror Gated Indic Parler-TTS Weights](../../archive/TASK-495-Mirror-Gated-Parler-Weights/README.md) (archived — a DIFFERENT, already-"implemented" design this ticket supersedes; see §2.3) |

## 1. Requirement Analysis

Enable the self-hosted `indic_parler` TTS provider (`apps/tts/src/tts/providers/indic_parler.py`) as the Malayalam engine, with its weights fetched from Hugging Face and cached on the shared `/mnt/data` external disk — the same read-through-cache mechanism TASK-642 proved out for Kokoro — rather than baked into the `apps/tts` image or hosted through the MinIO-mirror path TASK-495 built instead.

### 1.1 Ambiguity flagged, not silently resolved

The owner's brief says *"for stt, malayalam will be indic_parler."* Indic Parler-TTS is a **text-to-speech** model (`ParlerTTSForConditionalGeneration`, generates audio from text + a voice description) — there is no STT variant of it, and nothing named `indic_parler` exists on the STT side of this repo. STT's Malayalam path is the whisper ml-en code-switch fine-tune (`docs/implementation/TASK-594-Malayalam-English-Codeswitch-Quality`), which is unrelated to this ticket and untouched by it. This ticket assumes the owner meant the **TTS** Malayalam path, because:
- `IndicParlerConfig` and `IndicParlerProvider` only exist in `apps/tts`.
- `TenantTtsConfig.routingMl` already ships seeded as `['indic_parler']` (`packages/database/src/prisma/db_main/seed/19-tenant-tts-config.ts:52`) — the routing table already points Malayalam TTS at this exact engine.
- TASK-642 (TTS) recorded Malayalam as its own open decision (OD-1) rather than closing it, which is exactly the gap this ticket fills.

**If "stt" was literal and the owner meant the STT service, say so and this ticket should be re-scoped or renamed** — as written it proceeds on the TTS reading.

### 1.2 Relationship to TASK-643 (does not block this ticket)

TASK-643's credential cascade is scoped to the **cloud** TTS providers (Azure, Sarvam) reached through `AiProviderConnection` — `docs/implementation/TASK-643-.../README.md:307` names it as what unblocks "Cloud TTS … this is what unblocks TASK-642 Step 4 (Malayalam)" via a cloud key. `indic_parler` is self-hosted and needs no `AiProviderConnection` credential at all — `IndicParlerProvider.is_configured = True` unconditionally (`indic_parler.py:66`, marked `# TASK-602: self-hosted engine needs no credential`). This ticket's Malayalam path is independent of TASK-643 and does not wait on it; TASK-643 only matters if the owner later also wants the Sarvam/Azure Malayalam fallback live.

## 2. Current State Evaluation

### 2.1 Why it cannot work today — image, dependencies, code

- `apps/tts/Dockerfile` builds with `uv sync --frozen --package tts --extra kokoro --no-dev --no-install-project --no-editable` (lines 60–61) — only the `[kokoro]` extra. `torch`/`transformers`/`kokoro`/`soxr`/`lameenc` are baked; `[indic-parler]`'s `sentencepiece`/`accelerate` and, critically, `parler-tts` itself are **not installed**.
- `apps/tts/pyproject.toml:92-99` — the `[indic-parler]` extra lists `transformers`, `sentencepiece`, `accelerate`, but **not `parler-tts`**, because `parler-tts` installs from git (not PyPI) and is deliberately excluded from the shared `uv.lock` (comment at pyproject.toml:95-97: *"parler-tts itself installs from git … so it is added in a dedicated image build, never here: the shared uv.lock must stay resolvable"*). `apps/tts/src/tts/providers/indic_parler.py:139` does `from parler_tts import ParlerTTSForConditionalGeneration` — this import will `ModuleNotFoundError` on the current image regardless of any env var.
- Flipping `TTS_PARLER_ENABLED=true` (`IndicParlerConfig.enabled`, `core/config.py:78`) on the **current** `tts-kokoro` image does register the provider (`main.py:75,91-99` registers any local engine whose `.enabled` is true, unconditionally of what's installed) — the failure only surfaces on first synth, when `_load_model` (`indic_parler.py:135`) tries to import `parler_tts` and 500s. There is no import-time or readiness-time guard for this today; a keyless-Kokoro-only image with Parler flagged on would report `/health/ready` healthy and then fail every Malayalam request.
- **Conclusion: this needs a second, GPU/CPU-capable image variant (or a rebuilt `tts` image with the `indic-parler` extra + a git-installed `parler-tts` layer), not just an env flag.** The Dockerfile's own header already documents this as a known gap: *"NOT in this image: Indic Parler-TTS (Malayalam) … Both belong in a separate image variant"* (Dockerfile lines 13-16).

### 2.2 The weights — size, gating, and what that means for a "just let HF cache it" plan

- `ai4bharat/indic-parler-tts`: **~3.76 GB**, **HF click-through gated** (Apache-2.0 license, but requires an authenticated HF account that has accepted the repo's terms). Re-verified against the TASK-495 spike record (`docs/archive/TASK-495-Mirror-Gated-Parler-Weights/README.md` §5b) and the code comment at the top of `indic_parler.py:11-12`: *"the ai4bharat/indic-parler-tts weights are HF click-through gated — a production deploy must mirror them into an internal registry."* Not independently re-downloaded in this pass (no cluster/token access from this session) — treat the size/gating facts as **verified from two independent prior artifacts** (the spike doc and the shipped code comment), not freshly re-measured.
- **This is the load-bearing fact the owner's plan has to reconcile:** Kokoro's read-through cache self-heals a miss by fetching anonymously from `hf.co` — no token needed, because `hexgrad/Kokoro-82M` is ungated (TASK-642 §5b: *"HF_HUB_OFFLINE is not set — offline turns a miss into a hard failure, when a miss should self-heal"*). Indic Parler-TTS **cannot** self-heal the same way: an anonymous or non-accepting-token request 401/403s. So "download and cache by Hugging Face" for Parler necessarily means **a valid `HF_TOKEN`/`HUGGINGFACE_TOKEN` with the gate accepted must be present in the pod's environment**, at least for the first population of the cache on each fresh disk/prefix. `HF_TOKEN`/`HUGGINGFACE_TOKEN`/`HUGGING_FACE_HUB_TOKEN` already exist as one aliased secret for `hope-stt-v2` (`docs/implementation/TASK-616-.../component-design-config-plane.md:56`) and `.env.sample:2086` documents a commented `HUGGINGFACE_TOKEN` — the *mechanism* to deliver a token to a pod already exists. What does **not** exist is confirmation that the token behind that secret has **accepted the indic-parler-tts click-through gate** — that is an account-level fact on huggingface.co, not something a valid API token guarantees. This needs an explicit owner/operator check before the read-through-cache design can work for Parler the way it works for Kokoro.
- Note the reversal this creates versus TASK-495 (§2.3 below): TASK-495 was built specifically to get the token *out* of the runtime path ("Remove any reliance on a personal HF_TOKEN in prod paths"). The owner's new instruction re-introduces a token into the runtime path, deliberately, in exchange for reusing the proven Kokoro mechanism instead of maintaining a second (MinIO) pipeline. That tradeoff should be named explicitly to the owner, not made implicitly by this ticket.
- Second point on gating: once the disk cache is warm, subsequent pods hit a warm `HF_HUB_CACHE` and never call `hf.co` again (same as Kokoro) — the gated-token requirement is a **first-population** concern, not a steady-state one, but it recurs on any disk wipe/rotation to a fresh `/mnt/data` prefix.

### 2.3 The already-implemented, DIFFERENT mirror design (TASK-495) — reconcile before building

TASK-495 (`docs/archive/TASK-495-Mirror-Gated-Parler-Weights/README.md`, archived, status **"Implemented (code + operator tooling)"**) already shipped a working offline-load path for `indic_parler` that is **architecturally different** from what the owner is now describing:

| | TASK-495 (shipped) | Owner's decision (this ticket) |
|---|---|---|
| Storage | MinIO `models/` prefix, uploaded by an operator | Hugging Face cache on `/mnt/data`, populated by the pod itself |
| Runtime network | `HF_HUB_OFFLINE=1` / `TRANSFORMERS_OFFLINE=1` — **no** egress to `hf.co` ever, by design | Read-through — egress on a cache miss (Kokoro's model) |
| Token in the pod | Explicitly **never** ("Token lives only at operator-sync time — never in CI or the cluster") | Required at least on first population (§2.2) |
| Config knobs | `TTS_PARLER_MODEL_PATH` + `TTS_PARLER_DESC_ENCODER_PATH` (`IndicParlerConfig.model_path` / `.desc_encoder_path`, `core/config.py:90-91`) | None needed — plain `hf_model` id + `HF_HUB_CACHE`, same as Kokoro |
| Code | `_resolve_model_source` / `_resolve_desc_source` (`indic_parler.py:35-51`) — branches to `local_files_only=True` when a path is set | This code path is simply **not exercised** if `model_path`/`desc_encoder_path` stay empty (the existing "dev fallback to the gated hub pull" branch) |

Both designs share the same provider code and the same `_load_model`, and the "dev fallback" branch of `_resolve_model_source`/`_resolve_desc_source` (empty `model_path`/`desc_encoder_path` → plain `hf_model` id) is **exactly** what the owner's HF-cache plan needs — no code change to the provider is required, only env/deployment config, provided `HF_HUB_CACHE` is set and a gate-accepting token is present.

**Drift found while verifying TASK-495's own claims:** its Implementation Summary (§6) states *"turbo.json#globalEnv gains TTS_PARLER_MODEL_PATH, TTS_PARLER_DESC_ENCODER_PATH, HF_HUB_OFFLINE, TRANSFORMERS_OFFLINE; .env.example + .env.dev document them."* Neither `turbo.json` nor `apps/tts/.env.sample` nor the root `.env.sample` contain any of those four names today (`grep` of all three for `TTS_PARLER|HF_HUB_OFFLINE|TRANSFORMERS_OFFLINE` returns nothing beyond `TTS_PARLER_ENABLED` and `TTS_PARLER_DEVICE`, both commented-out at `apps/tts/.env.sample:61-62`). Either that wiring was reverted after TASK-495 shipped, or the claim in that ticket's summary was inaccurate — either way, **do not assume TASK-495's env wiring is present**; this ticket's plan (§3) re-verifies and adds only the two vars its own design needs (`TTS_PARLER_ENABLED`, and `HF_HUB_CACHE` if TTS doesn't already inherit it — see §3).

**Recommendation:** proceed with the owner's HF-cache design (it is simpler, has no MinIO/init-container to maintain, and reuses proven Kokoro infrastructure) and treat TASK-495's mirror path as **superseded, not deleted** — its runbook and script remain valid as a documented fallback if the gate-token approach proves unreliable in production (rate limits, gate re-acceptance, HF outages), but the GPU overlay should not wire both paths simultaneously. Flag this explicitly to the owner as a decision, since TASK-495 was previously signed off as the answer to this exact problem.

### 2.4 The caching contract — reuse Kokoro's, note one naming correction

TASK-642 §5b (`docs/implementation/TASK-642-TTS-Kokoro-Built-In/README.md:475-513`) already decided and verified the mechanism this ticket must reuse:

- The env var is **`HF_HUB_CACHE`**, not `HF_HOME`. The owner's brief says *"HF_HOME is set to the directory mapped to /mnt/data"* — per TASK-642's verified finding, that is not quite what's deployed: *"HF_HUB_CACHE (deliberately not HF_HOME) points at /mnt/data/models-cache. … Setting HF_HOME there instead resolves the cache to `<that>/hub`, finds nothing, and re-downloads every model into a nested directory — a second copy of every weight on a disk already ~90% full."* The share's layout is hub-style with `models--hexgrad--Kokoro-82M` at the directory **root** (how `hope-stt-v2` populated it), so `HF_HOME` and `HF_HUB_CACHE` are **not interchangeable** against this specific disk layout. This ticket should set `HF_HUB_CACHE=/mnt/data/models-cache` (or wherever the live overlay actually points it — outside this repo, verify against the deployment manifest before wiring) for the `tts` deployment, matching Kokoro exactly, and must NOT introduce `HF_HOME` as an alternate/competing variable. If the owner's own mental model is "HF_HOME," that's worth a one-line correction back to them — the two variables silently diverge on this share.
- `HF_HUB_OFFLINE` must stay **unset** for the read-through behavior (a miss self-heals); this is the opposite of TASK-495's design (§2.3) and is the crux of why the two cannot coexist in the same overlay.
- I did not independently re-verify the live `HF_HUB_CACHE` value or the pod's actual env against the cluster in this session (read-only planning, no manifest/cluster access) — TASK-642's finding is taken as verified-by-that-ticket, cited rather than re-proven.
- **Disk headroom:** TASK-642 recorded the shared disk at **~90% full** (also given in the owner's brief as ~85–90%); adding Parler's ~3.76 GB (§2.2) is a real, non-trivial cost on a disk that is already tight. This should be sized/confirmed against current free space before enabling, not assumed to "just fit" — I have no live disk-usage number for this session and treat ~85–90% as the owner-supplied figure, not independently re-measured here.

### 2.5 The description tokenizer — a second, smaller download

`IndicParlerConfig` (`core/config.py:71-91`) exposes both `model_path` and `desc_encoder_path` because Parler bakes `google/flan-t5-large` as a Hub id inside `model.config.text_encoder._name_or_path` (`indic_parler.py:44-51`, `_resolve_desc_source`). Confirmed by the TASK-495 spike (`docs/archive/TASK-495-.../README.md` §5b): *"the provider also loads a description tokenizer from … google/flan-t5-large (a Hub id baked in config.json → fetches at load even when the model is local)."* Under the owner's HF-cache design (no `model_path`/`desc_encoder_path` set, no `HF_HUB_OFFLINE`), this is **not** a problem the way it was for TASK-495's offline design — `flan-t5-large` is ungated and small (tokenizer/config JSONs only, ~3 MB per the spike), so it simply becomes a second, tiny, self-healing cache entry the exact same way Kokoro's weights are. It only becomes a hard failure if `HF_HUB_OFFLINE=1` is ever set (§2.3's design) without the tokenizer files already present in the cache — another reason not to mix the two designs.

### 2.6 Resource cost — likely undersized, not independently re-measured this pass

- The TTS Deployment is currently sized `requests: 1536Mi` / `limits: 4Gi` (owner-supplied figure for the live cluster manifest, outside this repo — not independently re-verified here, no cluster/manifest access this session).
- TASK-642's own rusage measurements for **Kokoro alone** (82M params, CPU): 1.8–2.7 GB peak RSS per single-request case after the single-worker-thread fix (`docs/implementation/TASK-642-.../README.md:520` and the case table around line 313), and up to 7.2 GB at 5 concurrent requests **before** that fix. So the current 4Gi limit is already fairly tight for Kokoro under any concurrency, on the owner's own numbers.
- Indic Parler-TTS (`ai4bharat/indic-parler-tts`) is a substantially larger model than Kokoro-82M — its fp32 weight footprint alone (~3.76 GB per §2.2, consistent with roughly 900M–1B parameters at 4 bytes/param) is bigger than Kokoro's entire measured peak RSS. **Estimate, not a measurement: loading Parler's weights plus PyTorch/transformers runtime overhead plus generation-time activation memory will plausibly peak well above the model's raw weight size — a rough 2–3× multiplier (consistent with what Kokoro showed: ~1.4 GB image footprint but 1.8–2.7 GB+ peak RSS in practice) would put Parler alone in the 7–11 GB range.** Confidence: **low** — this is an order-of-magnitude inference from Kokoro's ratio, not a Parler-specific measurement, and Parler's audio-codec (DAC) generation path may behave very differently under torch than Kokoro's G2P+vocoder path. **This must be measured directly (same `ru_maxrss` methodology as TASK-642 §4) before sizing the Deployment**, not estimated from this ticket.
- Both engines are registered **unconditionally** whenever their `.enabled` flag is true (`main.py:75-99`) and each has its own idle-TTL model cache (`ModelCache`, `ttl_seconds` from `settings.model_cache_ttl_seconds`), so Kokoro and Parler are not necessarily co-resident — but nothing prevents a Kokoro request and a Parler request landing close enough in time that both models are loaded simultaneously, and the pod has one shared memory limit. If Parler alone plausibly needs 7–11 GB, the **current 4Gi limit is very likely insufficient even for Parler by itself**, before considering Kokoro co-residency at all.
- Cluster headroom (owner-supplied, not re-verified this session): the node is 48 GB with ~61% already requested — i.e. roughly 18–19 GB unrequested. A revised TTS request/limit in the high-single-digit-GB range is plausible within that headroom, but should be confirmed against the actual measurement above, not assumed.

### 2.7 What must not change

`TTS_INDICF5_ENABLED` stays `false`. `IndicF5Config` (`core/config.py:96-110`) carries the license blocker verbatim in its docstring: *"the released weights are a fine-tune of the CC-BY-NC SWivid F5-TTS base — the MIT tag can't override NonCommercial. Never set TTS_INDICF5_ENABLED=true in production without written clearance."* Nothing in this ticket touches `IndicF5Config`, `indic_f5.py`, or its registration in `main.py:100-108` — confirmed unaffected by grep; no changes planned there.

## 3. Implementation Plan

This plan follows the owner's HF-cache design (§2.3 recommendation) and reuses the TASK-642 Kokoro pattern wherever possible. It does **not** touch the TASK-495 MinIO/offline code path (`model_path`/`desc_encoder_path`/`_resolve_*_source`), which stays available but unused.

### 3.1 Open decisions the owner must confirm before implementation starts

1. **Gate acceptance** — has the HF account behind the platform's `HF_TOKEN`/`HUGGINGFACE_TOKEN` secret accepted the `ai4bharat/indic-parler-tts` click-through terms? If not, someone with account access must do so before any pod can populate the cache.
2. **Disk headroom** — current free space on `/mnt/data` (or whichever host path backs `HF_HUB_CACHE`) versus the ~3.76 GB Parler needs, on a disk already reported ~85–90% full.
3. **Memory sizing** — run the TASK-642-style `ru_maxrss` measurement for Parler (single request, a range of input lengths, and concurrency 1/3/5) before committing a Deployment `requests`/`limits` change.
4. **TASK-495 disposition** — supersede-but-keep (this ticket's recommendation, §2.3) vs. formally deprecate/delete the MinIO runbook and script. Needs an explicit owner call since TASK-495 was previously the signed-off answer to this same problem.
5. **Image strategy** — build a second `tts` image variant with `--extra indic-parler` plus a git-installed `parler-tts` layer (mirrors the Dockerfile's own suggestion, §2.1), rather than adding it to the default Kokoro-only image (keeps the default image's proven 1.39 GB CPU-only footprint intact for English-only deploys).

### 3.2 TDD test list (`apps/tts/src/tts/tests/`)

Existing coverage to extend, following the Kokoro precedent (`test_kokoro_provider.py`, the keyless-readiness gate pattern in TASK-642 §4):

| Test | Verifies |
|---|---|
| `test_indic_parler_is_a_dependency_of_the_gpu_image` (new, mirrors `test_kokoro_is_a_dependency_of_the_default_image`) | The `indic-parler` extra (and a `parler-tts` install step) exists in whichever Dockerfile/build target is chosen for the Malayalam-capable image variant — deterministic proxy, no Docker build needed |
| `test_resolve_model_source_defaults_to_hub_id_when_no_local_path` (existing behavior, add explicit regression test if not already covered) | With `model_path=""`/`desc_encoder_path=""` (the HF-cache design's config), `_resolve_model_source`/`_resolve_desc_source` return the plain `hf_model`/baked-id with `local_files_only` absent — i.e. the read-through path, not TASK-495's offline path |
| `test_ready_with_parler_enabled_and_no_local_mirror_path` (new) | `/health/ready` reports healthy once Parler is registered under the HF-cache config (no `TTS_PARLER_MODEL_PATH` set) — mirrors the Kokoro keyless-readiness gate; guards against silently falling back to expecting a mirror |
| `test_reaching_ready_opens_no_network_connection` (extend existing Kokoro test to also register Parler) | Registration stays lazy for Parler too — the gated pull must not happen at boot/readiness-probe time, only on first synth, same invariant TASK-642 enforced for Kokoro |
| `test_parler_synth_smoke` (marked `e2e`, not run in CI per `06-python-services.md` harness-CI hermeticity note — analogous exclusion) | A real synth against a live, warm `HF_HUB_CACHE` produces non-empty audio for a short Malayalam string — the actual verification step from §3.1 item 3/4, run manually against the cluster, not in the hermetic suite |

### 3.3 File change order

1. `apps/tts/pyproject.toml` — add `parler-tts` to the `[indic-parler]` extra (git URL) once the image-variant decision (§3.1 item 5) is made; keep it OUT of `dependencies` and the shared lock, matching the existing `spacy` git-wheel precedent in the Dockerfile.
2. New or modified Dockerfile target for the Malayalam-capable `tts` image variant (per §3.1 item 5) — `--extra indic-parler` sync layer + `parler-tts` git-install layer, `HF_HOME`/`HF_HUB_CACHE` env left for the deployment manifest to set (not baked), no weight-download step at build time (owner's "not baked into any image" rule).
3. `apps/tts/src/tts/tests/unit/test_indic_parler_provider.py` (or new file) — the TDD list in §3.2, RED first.
4. No changes planned to `apps/tts/src/tts/providers/indic_parler.py`, `apps/tts/src/tts/core/config.py`, or `apps/tts/src/tts/main.py` — the HF-cache design is a pure config/deployment change against existing, already-tested code paths (§2.3). If the memory measurement (§3.1 item 3) forces a single-worker-thread serialization fix analogous to TASK-642 Step 2b, that becomes an explicit follow-up, not assumed here.
5. `turbo.json#globalEnv` + `apps/tts/.env.sample` + root `.env.sample` — add `TTS_PARLER_ENABLED` (uncomment/document), and `HF_HUB_CACHE` if the `tts` service does not already inherit it from a shared/base env (verify against what Kokoro's deployment actually sets before assuming it needs re-adding).
6. Deployment repo (`arca/hope-v2-deployment`, out of this repo per `09-infrastructure-devops.md`) — GPU/Malayalam overlay: new image tag, `TTS_PARLER_ENABLED=true`, `HF_HUB_CACHE` pointed at the same `/mnt/data` mount Kokoro uses, revised `requests`/`limits` from the §3.1 item 3 measurement, `HF_TOKEN`/`HUGGINGFACE_TOKEN` wired from the existing aliased secret. This ticket only specifies the change; it is executed in the separate deployment repo per the GitOps workflow.
7. `packages/database/src/prisma/db_main/seed/19-tenant-tts-config.ts` — no change expected; `routingMl: ['indic_parler']` is already seeded correctly (§1.1). Re-verify after deploy that the SYSTEM row still resolves as intended.

### 3.4 Verification criteria

- New/extended unit tests pass hermetically (no live HF access, no cluster) — `pnpm tts:test`.
- `pnpm tts:lint` / `pnpm tts:typecheck` clean.
- Manual `e2e`-marked synth smoke against a live overlay with a warm cache: zero unexpected `hf.co` egress after first population (verify via network policy/logs, same as TASK-642's "zero network egress" claim), non-empty Malayalam audio out.
- Measured peak RSS for Parler (§3.1 item 3) recorded in this README's Implementation Summary before any Deployment resource change ships.
- Disk usage on `/mnt/data` checked before and after first population; confirm no unexpected second copy (the `HF_HOME`-vs-`HF_HUB_CACHE` trap from §2.4) was created.

## 4. Implementation Summary

*(Pending — fill in once implementation starts.)*

## 5. Change History

| Date | Change | Author |
|---|---|---|
| 2026-08-09 | Ticket created from owner decision; research-only pass establishes why `TTS_PARLER_ENABLED=true` cannot work on the current image, reconciles the owner's HF-cache instruction against the already-shipped TASK-495 MinIO mirror design (recommends superseding it), corrects `HF_HOME` → `HF_HUB_CACHE` per TASK-642's verified finding, flags the STT/TTS wording ambiguity, and flags unmeasured memory/disk risk. No code written. | Claude (Sonnet 5) + Tap Huynh |
