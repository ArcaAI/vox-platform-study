# TASK-495 — Mirror Gated Indic Parler-TTS Weights into an Internal Registry

| | |
|---|---|
| **Status** | **Implemented (code + operator tooling)** (2026-07-11). Offline mirror-load path, sync script, and runbook are done; the actual gated fetch → MinIO upload → GPU-overlay wiring are **operator steps** (need a gated token + cluster access — see the runbook). |
| **Type** | `infrastructure` — supply-chain / model-artifact hosting |
| **Created** | 2026-07-11 |
| **Parent** | [TASK-488](../TASK-488-Realtime-TTS-Service/README.md) §7 risk + Phase 0 finding (2026-07-11): the "Apache-2.0 local model" sits behind an HF click-through gate |
| **Depends on** | TASK-488 local-engine deploy path (only relevant once local engines are enabled on GPU nodes) |
| **Branch (suggested)** | `feature/495-mirror-parler-weights` |

## 1. Requirement Analysis

The TASK-488 Phase 0 spike discovered that `ai4bharat/indic-parler-tts` — although Apache-2.0 — is a **gated HuggingFace repo** (click-through terms; downloads require an authenticated account + token; the spike used a developer's personal `HF_TOKEN`). A production/cluster deploy must **not** depend on a gated HF pull or a personal token at build/run time (unreliable, non-reproducible, a supply-chain + secrets risk).

**Requirements**
- R1 — Host the Parler weights (and tokenizer/codec assets) in an **internal, ungated** location the cluster can pull without external gated auth: an internal model registry, OCI artifact, or MinIO bucket.
- R2 — The Parler provider loads from the internal mirror (a local path or an internal endpoint), not `hf.co` at runtime.
- R3 — A documented, repeatable **sync procedure** (one authenticated fetch by an authorized operator → push to the internal store), with license/attribution preserved.
- R4 — Applies to any other gated/large model the local tier adds later (Kokoro is ungated Apache-2.0; IndicF5 per TASK-494 would ride the same mirror).

## 2. Current State Evaluation

- `IndicParlerConfig.hf_model = "ai4bharat/indic-parler-tts"` (TASK-488) — the provider lazy-loads via `from_pretrained(hf_model)`, which today resolves against gated HF.
- HOPE has MinIO (object storage, already used for recordings/generated-audio buckets) and a private container registry (k3s `registry` kustomize component). Either can host model artifacts.
- Local engines are `enabled=false` by default; this ticket is a **prerequisite for enabling Parler on the GPU cluster**, not for the current cloud/Azure path.
- Dev keeps using the gated HF pull with a personal token (acceptable for local experiments); prod must not.

## 3. Design (options — decide in Phase 0)

- **Option A — MinIO bucket** (`models/indic-parler-tts/…`): a sync job downloads the HF snapshot once (authorized token) and uploads it; the Parler image/pod pulls from MinIO at build or via an init-container to a local path; `TTS_PARLER_MODEL_PATH` points `from_pretrained` at the local dir. Simplest, reuses existing infra.
- **Option B — bake into the GPU image**: a build stage (with a build-time HF token secret) downloads the snapshot into the `[local]` GPU image layer; runtime pulls nothing. Reproducible per image tag; larger image.
- **Option C — internal HF-compatible endpoint / OCI model artifact**: host as an OCI artifact in the private registry; init-container fetches. Most registry-native.

Add `TTS_PARLER_MODEL_PATH` (local path override) to `IndicParlerConfig` — when set, `from_pretrained(model_path)` is used instead of the gated `hf_model`. Same knob serves all three options.

## 4. Implementation Plan
- **Phase 0** — pick A/B/C with ops; confirm licence permits internal redistribution (Apache-2.0 does, with attribution) and record the source commit/revision pinned.
- Implement the sync mechanism (script or CI job): authenticated snapshot download → checksum → push to the chosen store; document the runbook (`docs/operations/`).
- Add `TTS_PARLER_MODEL_PATH` config + provider load-from-path branch; k3s init-container / image stage; env/turbo/configmap wiring.
- Remove any reliance on a personal `HF_TOKEN` in prod paths; keep dev fallback documented.

**Verification**: a GPU pod loads Parler from the internal mirror with **no external gated auth**; `warm_and_register` succeeds; a synth smoke on the clinical strings. (No unit-test surface beyond the config path branch — this is ops-heavy.)

## 5. Risks
- Model-artifact size + storage/egress (Parler ≈ several GB incl. the flan-t5 text encoder).
- Keeping the mirror in sync with upstream fixes (pin a revision; re-sync deliberately).
- Attribution/licence file must travel with the mirror.

## 5b. Verified Research (2026-07-11 spike) — amends §3/§4/§5

- **Recommendation: Option A (MinIO + init-container).** Clone the pattern `apps/stt` already runs on GPU nodes — a `hostPath` model cache + `HF_HOME=/models/hf-cache`. One authorized operator does a single gated `snapshot_download`, uploads to a new MinIO `models/` prefix; the Parler GPU pod's init-container hydrates the node-local cache (idempotent — skip if present) before startup; runtime loads fully offline. Token lives only at operator-sync time — never in CI or the cluster. (Option C / OCI-artifact via ORAS is the runner-up if the team wants registry-digest immutability + Cosign; Option B / image-bake is NOT recommended — reintroduces a build-time gated pull + token and bloats every image ~+3.76 GB.)
- **⚠️ TWO repos to mirror (NEW — changes §1/§5):** besides `ai4bharat/indic-parler-tts` (~3.76 GB — `model.safetensors` bundles the text-encoder + Parler decoder + DAC codec; tokenizer/config JSONs), the provider also loads a **description tokenizer** from `model.config.text_encoder._name_or_path` = **`google/flan-t5-large`** (a Hub id baked in `config.json` → fetches at load even when the model is local). Mirror flan-t5-large's **tokenizer files only** (~3 MB, ungated Apache-2.0) — NOT its weights (already inside the Parler safetensors). **DAC** (`parler-tts/dac_44khZ_8kbps`, MIT) is bundled → no separate mirror (confirm on first offline load).
- **⚠️ One knob is NOT enough (NEW):** need `TTS_PARLER_MODEL_PATH` (model + prompt tokenizer) **and** `TTS_PARLER_DESC_ENCODER_PATH` (flan-t5 desc tokenizer), **plus** `HF_HUB_OFFLINE=1` + `TRANSFORMERS_OFFLINE=1` belt-and-suspenders. Load-branch: `source = model_path or hf_model` (dev fallback), `local_files_only=True` when a path is set; desc tokenizer `= desc_encoder_path or model.config.text_encoder._name_or_path`.
- **No LICENSE/NOTICE in the upstream repo (NEW):** the Apache-2.0 designation lives only in HF model-card metadata. To satisfy Apache §4 we must **author** a `LICENSE` (canonical text) + a `NOTICE` (crediting AI4Bharat, repo id, pinned commit sha, model-card URL; retain DAC/MIT + Google/flan-t5 attribution) and mirror the `README.md` alongside the weights.
- **Reproducibility**: pin the full commit sha (`HfApi().model_info(repo).sha`), store it + a checksum manifest in the ticket; sha-scoped MinIO prefix (`models/indic-parler-tts/<sha>/`) enables rollback on re-sync.
- **New env vars** (`TTS_PARLER_MODEL_PATH`, `TTS_PARLER_DESC_ENCODER_PATH`, `HF_HUB_OFFLINE`, `TRANSFORMERS_OFFLINE`) → `turbo.json#globalEnv` + `.env.example` + k3s configmap. A short operator runbook goes in `docs/operations/`.
- **Flags to close on first offline load**: confirm DAC is not separately fetched; confirm `text_encoder._name_or_path` is exactly `google/flan-t5-large` (not `-base`); resolve/record the pinned sha (config is behind the gate — unreadable from here); re-confirm flan-t5-large still ungated at sync time.

Full spike (snapshot script, offline-load levers, option matrix, runbook outline) in the completion report; cited: HF download guide, transformers offline mode, indic-parler-tts model page, ORAS, Apache-2.0 §4.

## 6. Implementation Summary — ✅ (2026-07-11, Option A code + tooling)

Implemented the **code + operator tooling** for the mirror-load path; the physical
sync/upload/overlay-wiring remain operator steps (gated token + cluster access).

- **Config** (`core/config.py`) — `IndicParlerConfig.model_path` + `desc_encoder_path` (both `""` = dev fallback to the gated hub).
- **Provider offline load-branch** (`providers/indic_parler.py`) — two pure, unit-tested helpers:
  - `_resolve_model_source(cfg)` → `(model_path, {local_files_only:True})` when set, else `(hf_model, {})`.
  - `_resolve_desc_source(cfg, baked_id)` → `(desc_encoder_path, {local_files_only:True})` when set, else `(baked_id, {})` where `baked_id = model.config.text_encoder._name_or_path` (`google/flan-t5-large`).
  - `_load_model` now loads the model + prompt tokenizer AND the description tokenizer through these, so a configured mirror never touches `hf.co`.
- **Sync script** (`apps/tts/scripts/mirror_parler_weights.py`) — operator one-shot: pins each repo's commit sha (`HfApi().model_info`), `snapshot_download`s `indic-parler-tts` (full) + `google/flan-t5-large` (tokenizer files only) into sha-scoped dirs, writes a `checksums.sha256` manifest per repo and an Apache §4 `NOTICE`. Uses `huggingface_hub` (operator env only — not a runtime dep).
- **Runbook** (`docs/operations/tts-model-mirror/README.md`) — Option A end-to-end: two-repos rationale, sync, LICENSE/NOTICE authoring, MinIO upload + checksum verify, GPU-overlay env (`TTS_PARLER_MODEL_PATH` / `TTS_PARLER_DESC_ENCODER_PATH` / `HF_HUB_OFFLINE=1` / `TRANSFORMERS_OFFLINE=1`) + init-container, verify, dev fallback, re-sync/rollback.
- **Env wiring** — `turbo.json#globalEnv` gains `TTS_PARLER_MODEL_PATH`, `TTS_PARLER_DESC_ENCODER_PATH`, `HF_HUB_OFFLINE`, `TRANSFORMERS_OFFLINE`; `.env.example` + `.env.dev` document them (commented; empty = dev gated-pull fallback). **k3s base stays Parler-off** — the offline env belongs in the GPU overlay only, so `HF_HUB_OFFLINE` never bleeds into stt/nlp via the shared configmap (runbook §6).

**Evidence:**
```
pytest src/tts/tests -q          → 108 passed, 2 deselected  (4 new: model/desc source × default-hub/offline-mirror)
ruff check apps/tts/{scripts,src} → clean
```

**Remaining operator steps (not code):** run the sync with a gated token → add the canonical Apache `LICENSE` → upload to MinIO → wire the GPU overlay init-container → GPU warm/synth smoke with no `HF_TOKEN` in the pod. First-offline-load flags to close: DAC not separately fetched; `text_encoder._name_or_path == google/flan-t5-large`; record the pinned shas here.

## 7. Change History
| Date | Change | Author |
|---|---|---|
| 2026-07-11 | Plan scaffolded (TASK-488 gated-weights finding) | Claude (Fable 5) + Tap Huynh |
| 2026-07-11 | Research spike done (§5b): recommend Option A (MinIO+init-container, mirrors stt); **found a 2nd repo to mirror** (google/flan-t5-large desc tokenizer via baked config id) → need `TTS_PARLER_MODEL_PATH` + `TTS_PARLER_DESC_ENCODER_PATH` + offline env; author LICENSE/NOTICE (none upstream); ~3.76 GB, pin sha | Claude (Fable 5) + Tap Huynh |
| 2026-07-11 | **Implemented (§6)** the code + tooling: config knobs, offline load-branch (`_resolve_model_source`/`_resolve_desc_source` + 4 unit tests), operator sync script (`scripts/mirror_parler_weights.py`), runbook (`docs/operations/tts-model-mirror/`), turbo/env wiring; k3s base stays Parler-off (offline env is overlay-only). 108/108 pytest, ruff clean. Physical sync/upload/overlay remain operator steps | Claude (Fable 5) + Tap Huynh |
