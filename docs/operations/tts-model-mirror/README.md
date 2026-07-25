# TTS Model Mirror — Indic Parler-TTS (TASK-495)

Operator runbook for mirroring the **gated** `ai4bharat/indic-parler-tts` weights
into an internal, ungated store so the TTS GPU pods load them **offline** — no
click-through gate, no personal `HF_TOKEN` at build or run time.

> **Scope.** Only needed to enable the self-hosted **local** Malayalam engine
> (Indic Parler-TTS) on the GPU cluster. The day-1 cloud path (Azure, Sarvam) does
> not need this. Local engines are `enabled=false` by default. Dev/experiments may
> keep using the gated HF pull with a personal token (§7).

## 1. What gets mirrored — TWO repos

| Repo | What | Size | License |
|---|---|---|---|
| `ai4bharat/indic-parler-tts` | Full snapshot — model (`model.safetensors` bundles the text encoder + Parler decoder + DAC codec), prompt tokenizer, configs | ~3.76 GB | Apache-2.0 (gated) |
| `google/flan-t5-large` | **Description tokenizer ONLY** (tokenizer + config JSONs, not weights) | ~3 MB | Apache-2.0 (ungated) |

**Why the second repo:** Parler bakes `google/flan-t5-large` as a Hub id in its
`config.json` (`model.config.text_encoder._name_or_path`), so transformers fetches
that tokenizer at load **even when the model is local**. Its weights are already
inside the Parler safetensors — mirror only the tokenizer files. **DAC**
(`parler-tts/dac_44khZ_8kbps`, MIT) is bundled → no separate mirror (verify on the
first offline load).

## 2. Chosen approach — Option A: MinIO + init-container

Mirrors the pattern `apps/stt` already runs on GPU nodes (a node-local model
cache hydrated before startup):

1. An authorized operator does **one** gated `snapshot_download` (token used here **only**).
2. Upload the snapshot to a new MinIO prefix `models/indic-parler-tts/<sha>/` and `models/flan-t5-large/<sha>/`.
3. The Parler GPU pod's **init-container** hydrates a node-local dir from MinIO (idempotent — skip if present).
4. Runtime loads fully offline via `TTS_PARLER_MODEL_PATH` / `TTS_PARLER_DESC_ENCODER_PATH` + `HF_HUB_OFFLINE=1` / `TRANSFORMERS_OFFLINE=1`.

Rejected: Option B (bake into the GPU image) reintroduces a build-time gated pull +
token and bloats every image ~+3.76 GB. Option C (OCI artifact via ORAS + Cosign)
is the runner-up if the team later wants registry-digest immutability.

## 3. One-time sync (operator laptop / jump host)

```bash
# Operator env only — NEVER in CI or the cluster.
python -m pip install huggingface_hub
export HF_TOKEN=hf_...          # a token that has ACCEPTED the indic-parler-tts gate
huggingface-cli login           # or rely on HF_TOKEN

# From the repo root:
python apps/tts/scripts/mirror_parler_weights.py --out ./mirror
```

The script pins the current commit sha of each repo, downloads them into
`./mirror/<name>/<sha>/`, writes a `checksums.sha256` manifest per repo, and writes
a `NOTICE` (Apache §4 attribution) next to the Parler weights. **Record the two
pinned shas it prints in the [TASK-495 README](../../implementation/TASK-495-Mirror-Gated-Parler-Weights/README.md).**

To reproduce/rollback a specific revision: `--parler-revision <sha>`.

## 4. License & attribution (Apache-2.0 §4 — REQUIRED)

Upstream ships **no** `LICENSE`/`NOTICE` file (the Apache-2.0 tag lives only in
HF model-card metadata). Before uploading, add both next to the Parler weights:

- `NOTICE` — already written by the sync script (source repo, pinned sha, model-card
  URL, retained DAC/MIT + Google/flan-t5 attribution). Review it.
- `LICENSE` — drop in the canonical Apache License 2.0 text:
  ```bash
  curl -sL https://www.apache.org/licenses/LICENSE-2.0.txt \
    -o ./mirror/indic-parler-tts/<sha>/LICENSE
  ```
- Also keep the upstream `README.md` (model card) in the snapshot for provenance.

## 5. Upload to MinIO

```bash
mc alias set hope https://<minio-host>:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
mc mb --ignore-existing hope/models
mc cp --recursive ./mirror/indic-parler-tts hope/models/
mc cp --recursive ./mirror/flan-t5-large    hope/models/
# Verify integrity after upload:
mc cp --recursive hope/models/indic-parler-tts/<sha> /tmp/verify/ && \
  (cd /tmp/verify && sha256sum -c checksums.sha256)
```

## 6. Cluster config (GPU overlay only)

The base deployment keeps Parler OFF. In the GPU overlay, an init-container copies
`models/indic-parler-tts/<sha>` and `models/flan-t5-large/<sha>` from MinIO to a
node-local `hostPath` (e.g. `/models`), then the container runs with:

```yaml
- name: TTS_PARLER_ENABLED
  value: "true"
- name: TTS_PARLER_MODEL_PATH
  value: "/models/indic-parler-tts/<sha>"
- name: TTS_PARLER_DESC_ENCODER_PATH
  value: "/models/flan-t5-large/<sha>"
- name: HF_HUB_OFFLINE          # belt-and-suspenders: fail loudly if anything still reaches hf.co
  value: "1"
- name: TRANSFORMERS_OFFLINE
  value: "1"
```

When `TTS_PARLER_MODEL_PATH` is set the provider loads with `local_files_only=True`
(`_resolve_model_source` / `_resolve_desc_source` in `providers/indic_parler.py`), so
nothing touches the gated hub. Leaving the paths empty falls back to the gated pull
(dev only).

## 7. Verify & dev fallback

- **Cluster:** the Parler pod's `warm_and_register` succeeds with **no** external gated
  auth (no `HF_TOKEN` in the pod), then run a synth smoke on the clinical strings.
  On the first offline load confirm: DAC is not separately fetched; the baked
  `text_encoder._name_or_path` is exactly `google/flan-t5-large` (not `-base`).
- **Dev:** leave `TTS_PARLER_MODEL_PATH`/`_DESC_ENCODER_PATH` empty and set a personal
  `HF_TOKEN` (after accepting the gate) — the gated pull path is unchanged.

## 8. Re-sync / rollback

Pin a revision deliberately — do not auto-track upstream. To adopt a new upstream
fix: re-run §3 with the new sha (new `models/<name>/<newsha>/` prefix), verify,
then flip the overlay `TTS_PARLER_MODEL_PATH` to the new sha. The old prefix stays
for instant rollback. Re-confirm `google/flan-t5-large` is still ungated at sync time.
