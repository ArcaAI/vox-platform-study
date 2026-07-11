# TASK-495 — Mirror Gated Indic Parler-TTS Weights into an Internal Registry

| | |
|---|---|
| **Status** | `Pending` — plan only (no code) |
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

## 6. Implementation Summary
_(empty — plan only)_

## 7. Change History
| Date | Change | Author |
|---|---|---|
| 2026-07-11 | Plan scaffolded (TASK-488 gated-weights finding) | Claude (Fable 5) + Tap Huynh |
