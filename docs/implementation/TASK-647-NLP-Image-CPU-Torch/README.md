# TASK-647 — The NLP image ships a CUDA stack it can never use

| Field | Value |
|---|---|
| **Status** | `Pending` |
| **Type** | `infrastructure` |
| **Created** | 2026-08-09 |
| **Raised from** | The 2026-08-09 fleet rollout, where `hope-nlp` was down 24+ minutes on a single image pull |
| **Related** | TASK-642 (the same fix, measured, on the TTS image) |

---

## 1. Requirement Analysis

`hope-nlp`'s image is **4,132 MB, of which one layer is 4,061 MB**. On a single-node
cluster whose dev overlay sets `maxSurge: 0` (terminate-then-start, correct for one
node), that pull time is **downtime on every deploy**. Observed: NLP served zero ready
endpoints for 24+ minutes during the pipeline-#713 rollout, with `hope-api` reporting
`NLP DOWN fetch failed` throughout.

The goal is to cut the image to what the service actually runs, so a deploy stops
costing an outage.

## 2. Current State Evaluation

**The 4 GB layer is the Python venv** (`COPY --from=builder /app/.venv`), not models —
so this is not a `/mnt/data` model-storage question. It is dependency weight.

`apps/nlp/pyproject.toml` declares `torch`, `transformers` and `spacy`.
`apps/nlp/Dockerfile` installs them straight from the workspace lock with **no CPU wheel
index and no CUDA exclusion**:

| service | declares torch | CPU wheel index | nvidia excluded | requests a GPU |
|---|---|---|---|---|
| **nlp** | ✅ | ❌ | ❌ | **❌ none** |
| stt | ✅ | ❌ | ❌ | ✅ `nvidia.com/gpu: 1` |
| tts | ✅ | ✅ (TASK-642) | ✅ | ❌ none |
| guardrail / harness / smr | ❌ | — | — | ❌ |

**`hope-nlp` requests no GPU.** Verified against the live Deployment:
`{"limits":{"cpu":"2","memory":"4Gi"},"requests":{"cpu":"500m","memory":"1Gi"}}` — no
`nvidia.com/gpu`, and `base/nlp.yaml` contains no GPU resource at all. So every
`nvidia-*` and `triton` wheel in that layer is weight the process can never execute.

**The size of the prize is measured, not estimated.** TASK-642 did exactly this to the
TTS image and built both variants as a control: **7,338 MB unpinned vs 1,385 MB pinned
on linux/amd64 — 5.95 GB saved.** NLP's 4.1 GB is consistent with carrying the same
stack.

### ⚠ STT is NOT a candidate — do not "fix" it too

`hope-stt-v2` requests `nvidia.com/gpu: "1"` (6 references in `base/stt-v2.yaml`) and is
the ML runtime. Its CUDA torch is **correct and load-bearing**. Pinning it to a CPU wheel
would silently drop it to CPU inference. This ticket covers `nlp` only.

## 3. Implementation Plan

1. **Reproduce the baseline.** Build `apps/nlp/Dockerfile` as-is and record the real
   image size, so the saving is measured rather than asserted.
2. **Apply the TASK-642 recipe** to `apps/nlp/Dockerfile` — read it first; it is the
   proven form and encodes two non-obvious facts:
   - `--extra-index-url` **alone does not work**. Under `--frozen`, uv installs the exact
     URL and hash recorded in the lock and ignores extra indexes, so the flag silently
     produces the CUDA build anyway. It requires explicit `--no-install-package` exclusion
     of the `nvidia-*`/`triton` set plus a separate pinned CPU install.
   - The CPU torch version must match the version resolved in the workspace lock; the CPU
     index publishes it as `<version>+cpu`.
3. **Verify in the built image**, not by inspection: `torch.cuda.is_available() is False`,
   zero `nvidia*`/`triton*` packages in the venv, and NLP's own model/NER path still
   produces the same output as before.
4. **Re-measure** the image size and record the delta here.
5. **Run `apps/nlp` tests** (`pnpm nlp:test`) plus a real request against the built image.

## 4. Implementation Summary

_Not started._

## 5. Open Decisions (owner)

| # | Decision | Why it cannot be defaulted |
|---|---|---|
| OD-1 | Should NLP ever run on GPU? | If GPU inference is planned, the answer is a second image variant (as `apps/tts/Dockerfile` documents for Parler), not leaving CUDA in the default image. Today's Deployment requests no GPU |
| OD-2 | Does the single 4 GB layer warrant splitting regardless? | Even at CPU size, one monolithic venv layer means no partial cache reuse — any dependency change re-pulls the whole thing. Splitting is a separate, larger change |

## 6. Change History

| Date | Change |
|---|---|
| 2026-08-09 | Ticket created after `hope-nlp` was unavailable 24+ minutes during the pipeline-#713 rollout. Measured the image at 4,132 MB with a single 4,061 MB layer via the registry manifest; confirmed the layer is the venv, not models; confirmed NLP requests no GPU while STT does. No code written. |
