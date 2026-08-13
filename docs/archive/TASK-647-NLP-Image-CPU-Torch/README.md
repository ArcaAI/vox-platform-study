# TASK-647 — The NLP image ships a CUDA stack it can never use

**Note:** This ticket number is shared with another, unrelated TASK-647 doc
(`TASK-647-Optional-Audio-Features-Default-On`) — a numbering collision. See that doc
separately; the two are not related.

| Field | Value |
|---|---|
| **Status** | `Review` |
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

**Status: done and measured.** One file changed — `apps/nlp/Dockerfile` (+54/−9). No
dependency was added or removed, so `uv.lock` is byte-unchanged (see §4.4).

### 4.1 The change

The TASK-642 recipe, ported verbatim in shape from `apps/tts/Dockerfile`:

| Addition | Purpose |
|---|---|
| `ARG TORCH_VERSION=2.8.0` / `ARG TORCH_CPU_INDEX=…/whl/cpu` | Pin, defaulted so CI (which passes only `BASE_IMAGE`) is unaffected |
| `ENV UV_NO_CUDA_SKIPS` — 15 `--no-install-package` flags (`torch`, `triton`, 13 × `nvidia-*-cu12`) | The exact CUDA set `torch` 2.8.0 declares on linux/x86_64, extracted from `uv.lock`. No-ops on aarch64, where the markers already exclude them |
| Layer 1b: `uv pip install --index-url ${TORCH_CPU_INDEX} torch==${TORCH_VERSION}` | The CPU wheel, in its own layer so it caches with the lock, not with source edits |
| `--inexact` on the layer-2 `uv sync` | **Load-bearing.** Without it the sync prunes the CPU torch as extraneous and the fix silently reverts |

The two traps in §3 were both confirmed real, not theoretical:
`--extra-index-url` alone is insufficient under `--frozen`, and the CPU index
publishes the lock's version as `2.8.0+cpu`.

### 4.2 Measured sizes — linux/amd64, both variants built as a control

Built on an aarch64 host under amd64 emulation, `hope-python-base` rebuilt for
amd64 from `infrastructure/docker/python-base/`. Both images built from the same
commit, differing only in the Dockerfile.

| | Uncompressed (`docker image inspect .Size`) | Compressed / **pull size** (registry manifest) | Largest layer (compressed) |
|---|---|---|---|
| **Baseline** (as-was) | 7,831,833,145 B = **7,831 MB** | **4,334 MB** | 4,258 MB |
| **Pinned** (this change) | 1,863,578,984 B = **1,864 MB** | **587 MB** | 510 MB |
| **Saving** | **5,968 MB (−76.2%)** | **3,747 MB (−86.5%)** | −3,748 MB |

**The baseline reproduction is faithful to the deployed image.** §2 measured the
live image at 4,132 MB with a 4,061 MB layer from the registry manifest; this
rebuild measures 4,334 MB / 4,258 MB — the same image, drifting only by base-image
and wheel churn since. So the compressed column is directly comparable to the
outage: **the pull that took 24+ minutes shrinks by 7.4×.**

The saving matches TASK-642's TTS control almost exactly (5.97 GB here vs 5.95 GB
there) — the same CUDA stack, removed the same way.

Where the weight was, inside the baseline venv (`du -sm site-packages`):

```
4183 MB  nvidia/          ← removed
 540 MB  triton/          ← removed
1642 MB  torch/           ← 673 MB after the CPU pin
7348 MB  site-packages total  →  1655 MB after
```

### 4.3 Verification inside the built images (not by inspection)

All run against the actual images, `--platform linux/amd64`.

| Check | Baseline | Pinned |
|---|---|---|
| `torch.__version__` | `2.8.0+cu128` | **`2.8.0+cpu`** |
| `torch.cuda.is_available()` | `False` | **`False`** |
| `nvidia*`/`triton*` distributions in venv (`importlib.metadata`) | 15 | **0** (asserted `== []`) |
| `transformers` / `spacy` | 5.5.4 / 3.8.14 | 5.5.4 / 3.8.14 (unchanged) |

**Output parity — byte-identical digests.** A probe exercising NLP's own code
paths (`get_app()` factory, `extract_vitals`, `classify_assertions` NegEx,
`OntologyLinker.link`, `transformers.BasicTokenizer`, plus a seeded torch matmul)
produced the same SHA-256 in both images:

```
DIGEST f0a64e623418d9d09e93dba31cce5126080138d9aaec17e2db43aa54378cf03d   (both)
   assertions: chest pain→ABSENT, diabetes→ABSENT
   ontology:   chest pain→C0008031/29857009/R07.9 · hypertension→C0020538/38341003/I10 · aspirin→C0004057/rx 1191
   vitals:     138/86, HR 92, SpO2 94, 38.4 °C
   matmul_sum: 7.265097
```

**Real NER inference parity.** A live `transformers` token-classification pipeline
constructed through the *same* device expression `token_classifier.py` uses
(`0 if (use_gpu and torch.cuda.is_available()) else -1`), plus a raw forward pass:

```
NER_DIGEST 96a4eeb734047dd39c4a6b24b7f12206723e5332b5dafb4f12994ab4460f9de0   (both)
   device: -1   logits_shape: [1, 18, 9]   logits_sum: 0.2098
   logits_head: [-0.04753, -0.01758, 0.03082, -0.00958, 0.02871, -0.02716, …]
```

Identical logits to 5 decimal places — the torch kernels compute the same numbers.

**Live service.** The pinned image boots and serves:

```
$ docker run -d -p 18864:8864 nlp-cputorch:task647
$ curl -s localhost:18864/api/v1/health
{"status":"healthy","service":"hope-nlp","version":"0.1.0",…}
$ docker inspect --format '{{.State.Health.Status}}'  →  healthy
```

`/openapi.json` reports all 9 paths; container logs contain no error, traceback,
or CUDA warning.

**Why no behavioral risk exists.** All three GPU call sites
(`medical_suggester.py:49`, `text_classifier.py:84`, `token_classifier.py:98`)
select `device=0 if (config.use_gpu and torch.cuda.is_available()) else -1`.
`torch.cuda.is_available()` is already **`False` in the CUDA image** — verified
above — because the pod has no GPU. The service was running on CPU all along; the
CUDA stack was inert weight, never a code path.

### 4.4 Lock, tests, lint

`uv.lock` is unchanged (no dependency edit), and still resolves for every
workspace member:

```
$ uv lock --check
Resolved 479 packages in 4ms
```

```
$ pnpm nlp:lint
All checks passed!

$ pnpm nlp:test
6 failed, 199 passed, 16 warnings in 0.56s
```

The 6 failures are **pre-existing and unrelated** — identical set and count before
and after this change, on a clean tree. All 6 are in `tests/test_extract.py`,
failing with `assert 401`: the auth middleware is enforcing because a
`SERVICE_TOKEN` leaks from `.env.dev` into `os.environ` at import. This is the
known cross-service test env-leak already tracked for SMR (`TASK-639`); NLP shares
the pattern. Out of scope here — flagged separately.

### 4.5 Files changed

| File | Change |
|---|---|
| `apps/nlp/Dockerfile` | +54 / −9 — CPU-torch pin, CUDA exclusion, `--inexact`, header rewrite |

Nothing else was touched. `apps/stt/**` was deliberately left alone (§2 warning):
`hope-stt-v2` requests `nvidia.com/gpu: "1"` and its CUDA torch is load-bearing.

## 5. Open Decisions (owner)

| # | Decision | Why it cannot be defaulted |
|---|---|---|
| OD-1 | Should NLP ever run on GPU? | **Still open — owner's call.** Evidence added: the service already runs on CPU in production (`torch.cuda.is_available()` is `False` even in the CUDA image), so nothing regressed. If GPU inference is ever planned, the answer is a second image variant (as `apps/tts/Dockerfile` documents for Parler), not restoring CUDA to the default image. The Dockerfile header now says so |
| OD-2 | Does the single 4 GB layer warrant splitting regardless? | **Answered below: no, not now.** Recommendation, with a re-open trigger |

### OD-2 — evidence and recommendation: do not split

**Recommendation: close as "no", with a re-open trigger.** The premise ("any
dependency change re-pulls the whole thing") is true but is now worth ~510 MB, not
~4.3 GB, and the only clean seam recovers a minority of that.

1. **The layer is no longer the problem.** Post-fix the venv layer is **510 MB
   compressed** (of a 587 MB image). The 4,258 MB layer that caused the outage is
   gone. A 510 MB pull is well under a minute on the cluster link — it is not a
   `maxSurge: 0` outage.
2. **Source commits already do not re-pull it.** `COPY apps/nlp/src` is its own
   **216 kB** layer above the venv. Day-to-day work never touches the big layer.
3. **The layer only re-pulls on dependency churn, which is low.** Last 12 months:
   `uv.lock` **17** commits, `apps/nlp/pyproject.toml` **12**, vs `apps/nlp/src`
   **31**. So ≈1.4 venv re-pulls/month.
4. **There is only one seam, and it is not clean.** Post-fix `site-packages`
   (1,655 MB uncompressed) is torch **673 MB (41%)** and then a long tail with no
   natural break: `opencv_python.libs` 116, `spacy` 111, `scipy` 83, `cv2` 72,
   `pymupdf` 59, `onnxruntime` 52, `transformers` 45, `pandas` 41. Splitting torch
   into its own `COPY --from=builder` saves ≈200 MB compressed **only on pulls
   where torch itself did not change** — and nothing when it did.
5. **Expected value.** ≈200 MB × ≈1.4 pulls/month, against a permanent cost: two
   disjoint `COPY --from=builder` subpaths of one venv, which is fragile (a
   misplaced `.pth`/`dist-info` silently breaks resolution) and diverges from the
   single-venv shape every other HOPE Python image uses.

**Re-open if** the venv layer exceeds ~1 GB compressed again, or dependency churn
rises materially above ~2 re-pulls/month. The cheaper lever first, if pull time
ever matters again, is registry-side: the CI build already does
`--cache-to mode=max,compression=zstd`; zstd on the *published* image would cut the
same layer further with no Dockerfile restructuring.

## 6. Change History

| Date | Change |
|---|---|
| 2026-08-09 | Ticket created after `hope-nlp` was unavailable 24+ minutes during the pipeline-#713 rollout. Measured the image at 4,132 MB with a single 4,061 MB layer via the registry manifest; confirmed the layer is the venv, not models; confirmed NLP requests no GPU while STT does. No code written. |
| 2026-08-09 | **Implemented.** Ported the TASK-642 CPU-torch recipe to `apps/nlp/Dockerfile` (only file changed, +54/−9): `TORCH_VERSION`/`TORCH_CPU_INDEX` ARGs, 15-package `UV_NO_CUDA_SKIPS` exclusion, a pinned CPU-index `torch==2.8.0` layer, and `--inexact` on the layer-2 sync so the CPU wheel is not pruned. Both variants BUILT on linux/amd64 as a control: **7,831 MB → 1,864 MB uncompressed; 4,334 MB → 587 MB compressed (pull size), −86.5%**, matching TASK-642's 5.95 GB TTS saving. Verified in-image: `torch 2.8.0+cpu`, `cuda_available False`, **zero** `nvidia*`/`triton*` distributions (was 15), byte-identical output digests for NLP's vitals/assertion/ontology/tokenizer paths AND for a real `transformers` NER forward pass (identical logits), service boots `healthy` and serves all 9 routes. `uv.lock` unchanged and still resolves (479 packages). `nlp:lint` clean; `nlp:test` 199 passed / 6 failed — the same 6 pre-existing `test_extract.py` 401s before and after (the TASK-639 test env-leak pattern), unrelated to this change. OD-2 answered: do not split, with evidence and a re-open trigger. STT deliberately untouched. |
