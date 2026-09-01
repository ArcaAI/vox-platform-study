# TASK-835 — Serving models to LM Studio and vLLM from a mounted MinIO bucket

| Field | Value |
|---|---|
| Status | `Review` |
| Type | `infrastructure` (research spike) |
| Branch | `dev-2.2` |
| Date | 2026-08-31 |
| Related | `infrastructure/docker/lmstudio/` (LM Studio image + entrypoint), `infrastructure/docker/vllm/` |

> Numbering caveat: `docs/implementation/` tops out at TASK-834, so this is 835.
> `docs/archive/**` is blocked this sprint and could not be checked, per the
> normal two-place rule.

## 1. Requirement Analysis

Can a MinIO/S3 bucket be mounted into the LM Studio and vLLM service pods so that
one object store holds every model, instead of baking weights into images or
per-node PVCs?

Specifically:

1. LM Studio — mount the bucket, symlink it to `~/.lmstudio/models`, then download
   and load `lmstudio-community/Qwen3.5-0.8B-GGUF`.
2. vLLM — mount the bucket, create a working directory, symlink the mount into it,
   and load/serve the SAME GGUF.

Mount mechanism under test: **`mountpoint-s3` CSI**.

## 2. Current State Evaluation

Simulation topology, chosen to mirror hope-v2 (object store on its own Linux host,
services in k8s):

| Piece | What was used |
|---|---|
| MinIO host | OrbStack Ubuntu VM `minio-vm`, amd64 via Rosetta, `192.168.139.20:9000`, systemd unit |
| Bucket | `shared`, models under the `models/` prefix |
| Cluster | OrbStack k8s, single node, arm64 |
| Mount | `mountpoint-s3` CSI v2.7.0; PV mountOption `prefix models/` makes the mount root `models/` |
| Routing | pods reach the VM on its OrbStack IP directly; no Service/Endpoints shim required |

An earlier arm of the same spike also measured an **s3fs sidecar** for comparison
(see §5).

## 3. Implementation Plan

1. Stand up MinIO on a dedicated Linux VM; create `shared` + `models/` prefix.
2. Install the `mountpoint-s3` CSI driver; PV/PVC with a `prefix` mount option.
3. Build an arm64/CPU LM Studio image from the existing production Dockerfile.
4. Deploy LM Studio with the PVC at `/data/models`; verify the image's
   `~/.lmstudio/models -> /data/models` symlink resolves onto the FUSE mount.
5. Attempt in-place download; if it fails, stage out-of-band and re-verify.
6. Repeat the mount/working-dir/symlink pattern for vLLM and attempt to serve.

## 4. Implementation Summary

### 4.1 LM Studio — PASS

- `~/.lmstudio/models -> /data/models`, and `/data/models` is the `mountpoint-s3`
  FUSE mount (verified with `mount` inside the running pod).
- `lms ls` -> `qwen3.5-0.8b  0.8B  qwen35  734.85 MB  Local`
- **Load from S3: 33.9 s** (700.81 MiB resident) · **inference: 1.66 s** on
  `POST /v1/chat/completions` through the k8s Service.

### 4.2 Downloading INTO the mount — FAILS

`lms get <HF URL> --gguf -y` reached 38.97 % then:

    Error: Download failed: Checksum failed

leaving `downloading_<file>.gguf.part` objects behind. Explained exactly by the
measured write semantics (`allow-delete` + `allow-overwrite` set):

| op | mountpoint-s3 |
|---|---|
| mkdir | OK |
| sequential write | OK (6.0 MB/s) |
| rename | OK |
| **append / reopen-write** | **FAILED — Operation not permitted** |
| **symlink INSIDE the mount** | **FAILED — Operation not permitted** |

The downloader finalises with a reopen/append, which the mount refuses.
Staging out-of-band with `mc` ran at **47 MB/s** vs **6 MB/s** through the mount.

**Consequence:** the serving pod must treat the mount as read-only, and bucket
population is a separate job — which is exactly the sync-Job + `.ready` sentinel
design `entrypoint.sh` already assumes. Implemented here as an initContainer that
genuinely verifies the mount before writing `/data/.ready`, rather than defeating
the A-0 gate with `HOPE_REQUIRE_READY=0`.

The symlink the design needs is on the CONTAINER filesystem pointing AT the mount.
That works. A symlink *inside* the bucket does not, and nothing requires one.

### 4.3 vLLM — mount PASSES, GGUF premise FAILS

Mount/working-dir/symlink, exactly as specified:

    /workspace/models -> /mnt/s3
    mountpoint-s3 on /mnt/s3 type fuse (...)
    LOADED 197 tensors, 163.8M params in 5.74s from the S3 mount

(vLLM's own torch stack, real weights, through the symlink and the mount.)

**But vLLM 0.28.0 cannot load GGUF at all** — measured in the image, not inferred:

- `gguf` is ABSENT from `QUANTIZATION_METHODS` (30 registered; no gguf)
- no `quantization/gguf*` module in the package
- the `gguf` PyPI package is not installed
- one vLLM source file mentions gguf (`models/exaone_moe.py`)

Adjacent facts, for precision:
- the ARCHITECTURE is supported — `Qwen3_5ForCausalLM -> ("qwen3_5", ...)` is in
  vLLM's registry. The blocker is the FORMAT, not the model.
- `transformers`' ggml converter knows `qwen3`/`qwen3_moe` but NOT `qwen35`, the
  GGUF `general.architecture` this file declares.

vLLM also cannot RUN on the sim node: the published arm64 image is a CUDA build
with no CPU backend — `No platform detected ... RuntimeError: Failed to infer
device type`. Closing that would need a `VLLM_TARGET_DEVICE=cpu` source build;
by owner decision the spike stopped here, since the GGUF result already settles
the original question.

### 4.4 Rosetta 2 has no AVX — measured twice

In the amd64 VM and in an amd64 container:

    uname: x86_64   sse4_2: YES   avx: NO   avx2: NO   avx512f: NO

vLLM's x86 CPU backend needs AVX512/AVX2, and LM Studio's x86_64 engines are the
`-avx2` builds — both would SIGILL. **Rosetta is fine for the object store (MinIO
is Go) and unusable for the inference runtimes.** Simulating hope-v2's x86
*services* on Apple silicon is not possible; arm64-native is the only working path.

## 5. Mount-mechanism comparison (measured on a 3.35 GB GGUF)

| | s3fs sidecar | mountpoint-s3 CSI |
|---|---|---|
| `mmap()` | OK | OK |
| random page-in (mid / EOF) | 56 ms / 7 ms | 15 ms / 9 ms |
| sequential read | 312 MB/s | **376 MB/s** |
| egress per 512 MiB read | 550 MiB (**1.07x**) | 783 MiB (**1.53x**) |
| cluster prerequisite | none (privileged sidecar + `/dev/fuse`) | CSI driver install |
| extra container per pod | yes | no |

A prior expectation that FUSE-over-S3 would refuse `mmap` or degrade into a
whole-object download was **wrong on both arms**: `mmap` worked and served genuine
range GETs. Mountpoint is faster but prefetches ~43 % more bytes.

## 6. Findings that apply to the PRODUCTION image

1. **The inline vendor fetch is a CI hazard.** The bundle download in
   `infrastructure/docker/lmstudio/Dockerfile` aborted after 1463 s with
   `curl: (92) HTTP/2 stream ... INTERNAL_ERROR`. `--retry` does not cover a
   mid-stream HTTP/2 abort without `--retry-all-errors`, and buildkit cannot
   resume a partial, so the whole step is lost. A host-side `--http1.1 -C -`
   fetch was resumable at ~7.4 MB/s. **The production x64+cuda12 bundle is
   larger**, so CI is exposed to the same failure.
2. `publish_and_verify()`'s same-filesystem (`st_dev`) assertion WOULD fail a
   bucket-mounted layout, since the mount and `/data/staging` are necessarily
   different filesystems. It is currently dodged only because the function
   returns early with no `imports.tsv`. Mounting the bucket at `/data/models` and
   relying on directory-watch indexing avoids `lms import` entirely.
3. `HOPE_EXPECT_ACCEL=none` is an entrypoint-supported value, which is what makes
   a GPU-less arm64 dev image legitimate rather than a weakened production one.
4. Two vendor-CLI behaviours in the image README re-confirmed: `lms get` printed a
   hard error and still **exited 0**; and `lmstudio-community/...` is a HUGGINGFACE
   repo id — `lms get` lowercases it to a Hub artifact name and fails, so the full
   HF URL is required.

## 7. Design conclusion

One bucket can serve both services, but **not one artifact**:

- LM Studio consumes **GGUF** — proven end to end.
- vLLM consumes **HF format** (safetensors/bin + config + tokenizer) — its loader
  read exactly that from the same mount.

`shared/models/` should therefore hold **both representations per model**, with
each service pointed at its own subtree. Population is an out-of-band sync job;
serving pods mount read-only.

## 8. Verification Evidence

Commands and raw output are recorded in the spike scratchpad (`FINDINGS.md`,
`FINDINGS-SIM.md`). Key measured lines are quoted inline above.

## 9. Change History

| Date | Change |
|---|---|
| 2026-08-31 | Ticket opened. Spike executed end to end: LM Studio serving from a mounted MinIO bucket PASSES; vLLM mount PASSES but vLLM 0.28.0 GGUF support does not exist. Status `Review`. |
