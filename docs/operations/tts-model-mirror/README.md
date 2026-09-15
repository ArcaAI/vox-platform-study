# TTS Model Mirror — Indic Parler-TTS

Operator runbook for mirroring the gated `ai4bharat/indic-parler-tts` weights into the platform's
internal, ungated model store so the TTS GPU pod loads them offline — no click-through gate, no
personal `HF_TOKEN` at build or run time. Only needed to enable the self-hosted local Malayalam
engine (Indic Parler-TTS) on the GPU cluster; the day-1 cloud path (Azure, Sarvam) does not need
this. Dev/experiments may keep using the gated HF pull with a personal token.

## Layout

This directory holds only this file. The mirroring script it documents is
`apps/tts/scripts/mirror_parler_weights.py`.

## Commands

### One-time sync (operator laptop / jump host — never CI or the cluster)

```bash
python -m pip install huggingface_hub
export HF_TOKEN=hf_...          # a token that has ACCEPTED the indic-parler-tts gate
huggingface-cli login           # or rely on HF_TOKEN

# From the repo root:
python apps/tts/scripts/mirror_parler_weights.py --out ./mirror
```

The script pins the current commit sha of each repo, downloads them into
`./mirror/<name>/<sha>/`, writes a `checksums.sha256` manifest per repo, and writes a `NOTICE`
(Apache License 2.0 section 4 attribution) next to the Parler weights. Record the two pinned shas it prints. To
reproduce/rollback a specific revision: `--parler-revision <sha>`.

### License & attribution (Apache-2.0 section 4 - required)

Upstream ships no `LICENSE`/`NOTICE` file (the Apache-2.0 tag lives only in HF model-card
metadata). Before uploading, add both next to the Parler weights:

- `NOTICE` — already written by the sync script (source repo, pinned sha, model-card URL, retained
  DAC/MIT + Google/flan-t5 attribution). Review it.
- `LICENSE` — drop in the canonical Apache License 2.0 text:
  ```bash
  curl -sL https://www.apache.org/licenses/LICENSE-2.0.txt \
    -o ./mirror/indic-parler-tts/<sha>/LICENSE
  ```
- Also keep the upstream `README.md` (model card) in the snapshot for provenance.

### Upload to the shared model bucket

```bash
mc alias set hope https://<minio-host>:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
mc cp --recursive ./mirror/indic-parler-tts hope/hope-models/
mc cp --recursive ./mirror/flan-t5-large    hope/hope-models/
# Verify integrity after upload:
mc cp --recursive hope/hope-models/indic-parler-tts/<sha> /tmp/verify/ && \
  (cd /tmp/verify && sha256sum -c checksums.sha256)
```

Then set the `AiModel` row for Indic Parler-TTS: `bucketPrefix = "indic-parler-tts/<sha>"`, and put
the mirrored `flan-t5-large` prefix on the row's `_metadata.artifacts.descEncoderPath`. Whether
Parler may serve at all is a separate question — the SYSTEM `AiProviderConnection(tts, ...)` row's
`enabled` flag (or the tenant's own row for BYO).

### Verify

- **Cluster:** confirm the TTS pod's `warmup()` (or first synth request) succeeds with no external
  gated auth (no `HF_TOKEN` in the pod), then run a synth smoke test on clinical strings. On the
  first offline load confirm DAC is not separately fetched, and the baked
  `text_encoder._name_or_path` is exactly `google/flan-t5-large` (not `-base`).
- **Dev:** leave the row's `bucketPrefix` / description-artifact path empty and set a personal
  `HF_TOKEN` (after accepting the gate) — the gated pull path is unchanged.

## How it works

### What gets mirrored — two repos

| Repo | What | Size | License |
|---|---|---|---|
| `ai4bharat/indic-parler-tts` | Full snapshot — model (`model.safetensors` bundles the text encoder + Parler decoder + DAC codec), prompt tokenizer, configs | ~3.76 GB | Apache-2.0 (gated) |
| `google/flan-t5-large` | Description tokenizer ONLY (tokenizer + config JSONs, not weights) | ~3 MB | Apache-2.0 (ungated) |

**Why the second repo:** Parler bakes `google/flan-t5-large` as a Hub id in its `config.json`
(`model.config.text_encoder._name_or_path`), so transformers fetches that tokenizer at load even
when the model is local. Its weights are already inside the Parler safetensors — mirror only the
tokenizer files. DAC (`parler-tts/dac_44khZ_8kbps`, MIT) is bundled, so no separate mirror is
needed (verify on the first offline load).

### Where it lands — the shared `hope-models` bucket, not a per-provider hostPath

The platform's self-hosted model surfaces (STT, vLLM, LM Studio, and TTS) share ONE MinIO bucket,
`hope-models`, mounted read-only into the `hope-tts` pod by an `s3fs` native sidecar at
`/mnt/models-bucket` (`arca/hope-v2-deployment`'s `deployment/k8s/base/tts-v2.yaml`). There is no
per-provider init-container that copies files to a node-local `hostPath` — the whole bucket is
mounted into the pod directly, and there is no manifest-level per-engine enable flag either: the
five `TTS_*_ENABLED` flags were deleted from the Deployment on 2026-09-07 (dev-2.2) — which engines
load is entirely a **database** question now (`AiProviderConnection` / registry rows), never a
manifest one.

`AiModel` no longer carries a `localPath` column (removed; see
`packages/database/src/prisma/db_main/ai-model.prisma`). Instead:

- `AiModel.bucketPrefix` (relative to the `hope-models` bucket root) and, for a single-file
  artifact, `AiModel.primaryObject` are what an admin sets on the row.
- `local_path` is DERIVED from those at request-resolve time
  (`deriveLocalPath`/`derivedLocalPath` in `packages/applications/src/services/ai-model/constants.ts`),
  producing `/mnt/models-bucket/<bucketPrefix>[/<primaryObject>]` — the same mount path the s3fs
  sidecar already exposes, so no separate download step runs inside the pod.
- `IndicParlerProvider.from_spec` (`apps/tts/src/tts/providers/indic_parler.py`) builds its
  request-scoped config from the resolved candidate: the gated Hub id (`candidate.model.source_uri`),
  the ungated mirror (`candidate.model.local_path`), and the description-tokenizer mirror
  (`candidate.model.artifacts["descEncoderPath"]`, stored under the row's `_metadata`). Leaving
  `local_path`/the artifact path empty falls back to the gated Hub pull (dev only).

There is no `TTS_PARLER_MODEL_PATH` / `TTS_PARLER_DESC_ENCODER_PATH` environment variable — both
were retired onto the row (their `validation_alias` is a dead, tombstoned name; setting the env
var has no effect).

## Gotchas

- **The mirror script's own docstring is stale.** `mirror_parler_weights.py`'s header still refers
  to `TTS_PARLER_MODEL_PATH`/`TTS_PARLER_DESC_ENCODER_PATH` as live env vars and a generic
  `models/` MinIO prefix. Both are superseded by the `AiModel.bucketPrefix` + `hope-models` bucket
  mechanism described above — the script's actual download/checksum behavior is unaffected, only
  its docstring's account of what consumes the output is out of date.
- **Do not reintroduce a per-provider `hostPath`/init-container copy.** The current design mounts
  the whole `hope-models` bucket read-only via `s3fs` once, for every self-hosted model surface on
  that pod — adding a bespoke copy step for one engine fights that pattern.
- Pin a revision deliberately — do not auto-track upstream. To adopt a new upstream fix: re-run the
  one-time sync with the new sha (a new `hope-models/indic-parler-tts/<newsha>/` prefix), verify,
  then repoint the model row's `bucketPrefix` at the new sha. The old prefix stays for instant
  rollback. Re-confirm `google/flan-t5-large` is still ungated at sync time.

## Related

- [`../inference/README.md`](../inference/README.md), [`../inference/serving-tier-cluster-deployment.md`](../inference/serving-tier-cluster-deployment.md) — the same `hope-models` bucket and `s3fs` sidecar pattern, used for vLLM and LM Studio
- [`../../../.claude/rules/06-python-services.md`](../../../.claude/rules/06-python-services.md) — per-tenant/per-service configuration rules for Python services
