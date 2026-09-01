# Serving LM Studio from a MinIO bucket with an s3fs sidecar

**Date**: 2026-09-01
**Topic**: Mounting the `hope-models` MinIO bucket into `hope-lmstudio` so the weights live in object storage only, linked to `~/.lmstudio/models`
**Outcome**: **WORKING in-cluster** — s3fs sidecar Running with 0 restarts, all four model prefixes readable, symlink tree built. One unrelated blocker remains (§7).
**Prior art**: [TASK-835](../../implementation/TASK-835-S3-Mounted-Model-Store/README.md) (mount-mechanism spike), [TASK-836](../../implementation/TASK-836-MLflow-Registry-vLLM-Metal/README.md)
**Companion**: [mlflow-vllm-minio-onprem-inference-2026-09.md](./mlflow-vllm-minio-onprem-inference-2026-09.md)

---

## 1. Why s3fs and not the mountpoint-s3 CSI driver

Both were installed and driven on this cluster. The CSI driver was tried **first**
and abandoned for a concrete reason, not a preference.

| | s3fs sidecar | mountpoint-s3 CSI |
|---|---|---|
| sequential read (3.35 GB GGUF) | 312 MB/s | **376 MB/s** |
| egress per 512 MiB read | 550 MiB (**1.07x**) | 783 MiB (1.53x) |
| `mmap()` | OK | OK |
| cluster prerequisite | none | driver install (DaemonSet + CRD + `mount-s3` namespace) |
| extra container per pod | yes | no |
| **private CA support** | **trivial — mount the ConfigMap** | **no supported path (§1.1)** |

Rows 1–5 are TASK-835's measurements. Row 6 is what actually decided it.

### 1.1 The CSI blocker, measured

The driver does **not** run FUSE inside the workload pod. It spawns a *Mountpoint
pod* in its own `mount-s3` namespace, and that pod opens the S3 connection. Its
spec carries exactly two volumes — `comm` and `kube-api-access` — and chart 2.7.0
exposes only `priorityClassName` and `podLabels` under `mountpointPod`. There is no
supported way to add a CA bundle, and `hope-minio` serves a leaf from the **ARCAAI
Internal CA**.

Getting that far also surfaced two things worth keeping:

- **Cross-namespace ingress.** Because the Mountpoint pod is not in `hope-v2-dev`,
  `default-deny-ingress` refused it — a bare `podSelector` in a NetworkPolicy `from`
  block means *same namespace only*. Symptom: `AWS_IO_SOCKET_CONNECTION_REFUSED` on
  the initial `ListObjectsV2`. The policy that fixes it is kept in
  `components/network-policies/allow-mountpoint-s3.yaml` in case the driver is ever
  revisited.
- **`authenticationSource: secret` does not exist.** Only `driver` and `pod`. Static
  PVs must use driver-level credentials in the driver's namespace.

If the CA problem is ever solved upstream, mountpoint's 376 MB/s is worth revisiting
— but 1.53× egress amplification against s3fs's 1.07× is a real cost on every read.

---

## 2. The shape that works

```
hope-lmstudio pod
├── initContainers
│   ├── s3fs           (restartPolicy: Always — a NATIVE sidecar)
│   │     mounts s3://hope-models  ->  /mnt/models-bucket   [ro, Bidirectional]
│   └── link-models    builds /data/models/hope/<model>/*.gguf as SYMLINKS
│                      into /mnt/models-bucket, then writes /data/.ready
└── containers
    └── lmstudio       /data              (symlink tree, staging, .ready)
                       /mnt/models-bucket [HostToContainer]  <- MANDATORY
```

`~/.lmstudio/models -> /data/models` is a symlink **baked into the image**, so
nothing in the manifest has to create it.

### 2.1 Why a native sidecar

`initContainer` + `restartPolicy: Always` (k8s ≥ 1.29; this cluster is k3s v1.34.5)
starts before the regular containers and blocks the next init container until it is
*Started*. So the ordering is guaranteed: **mount → link → daemon**. A plain sidecar
would start *alongside* `lmstudio` and race the indexer.

### 2.2 Why symlinks, and not a bucket restructure

The bucket is **content-addressed**:

```
hope-models/<slug>/<version>/<files>
  gemma-4-e2b-it-qat-gguf/q4-0-451faffb5a16/gemma-4-E2B_q4_0-it.gguf
```

LM Studio indexes `<publisher>/<model>/<file>.gguf` and takes **the model key from
the directory name** (image README §3.4, §3.6). Those two layouts are incompatible,
so something has to bridge them. Options were: flatten the bucket (destroys the
versioning that makes publication verifiable), copy on start (a second 15 GiB), or
symlink.

Symlinking is the only one that costs nothing and keeps versioning. It works because
of a distinction TASK-835 §4.2 measured precisely:

| operation | result |
|---|---|
| symlink **inside** the mount | **FAILS** — `Operation not permitted` |
| symlink on the **container filesystem** pointing **at** the mount | **works** |

`link-models` discovers the version directory at runtime rather than hard-coding it,
so a re-publish under a new content hash needs no manifest change.

### 2.3 The slug → model-key mapping

```
gemma-4-e2b-it-qat-gguf                      -> hope/gemma-4-e2b-it-qat
granite-guardian-4.1-8b-gguf                 -> hope/granite-guardian-4.1-8b
text-embedding-embeddinggemma-300m-qat-gguf  -> hope/embeddinggemma-300m-qat
```

Strip the trailing `-gguf`; strip a leading `text-embedding-`. The second rule exists
because **LM Studio prepends `text-embedding-` for embedding models** (README §3.6) —
leaving it on yields the key `text-embedding-text-embedding-…`.

### 2.4 `imports.tsv` must NOT be supplied

`HOPE_IMPORT_MAP` is deliberately unset. `entrypoint.sh:239` returns early from
`publish_and_verify` when the map is absent, which skips the assertion at :244-249:

```sh
[ "${stage_dev}" = "${model_dev}" ] || die "... on DIFFERENT filesystems ..."
```

`lms import -L` hard-links, and a hard link cannot cross filesystems. A bucket mount
*guarantees* different filesystems, so supplying the map would hard-fail every start
(TASK-835 §6.2). Directory-watch indexing replaces `lms import` entirely.

---

## 3. Three NetworkPolicy defects this uncovered

All three were latent in `hope-lmstudio-egress` and had never fired, because the
workload had never actually run (`replicas: 0`).

| # | Defect | Symptom | Fix |
|---|---|---|---|
| 1 | **No egress to MinIO at all** — the policy allowed DNS only | s3fs: `Unable to connect(host=https://hope-minio:9000)` | egress rule to `app: hope-minio` on 9000 |
| 2 | **kube-dns `podSelector` can never match** — the resolver is addressed by the Service VIP (10.43.0.10) and this cluster evaluates egress **before** kube-proxy DNATs it to a CoreDNS pod IP | `nslookup`: `write to '10.43.0.10': Connection refused`, then `wget: bad address`; s3fs shows `CURLE_COULDNT_RESOLVE_HOST` | port 53 to **any** destination — the standard posture, and it grants no service-port reachability |
| 3 | **Same VIP problem for MinIO** — `podSelector` cannot match `hope-minio:9000` either | mount fails after DNS is fixed | add a service-CIDR `ipBlock` scoped to port 9000 |

Defect 1 was correct while the models came from a PVC. Mounting the bucket makes
MinIO a **network dependency of the pod**, and that is the general lesson: moving
storage from a volume to object storage changes a workload's egress requirements.

> **Diagnostic trap, worth knowing before debugging anything here.** This cluster
> programs NetworkPolicy rules a few seconds *after* a pod starts — measured
> **t=3s refused, t=6s HTTP 200**. A one-shot connectivity probe at container start
> reports a false negative, and several diagnostics during this work were misread
> that way before a retry loop exposed it. s3fs is especially exposed because it
> **exits on its first failed `CheckBucket`** instead of retrying, so the sidecar
> now waits for the MinIO endpoint before mounting. Wait for the endpoint; do not
> sleep a guess.

---

## 4. Configuration reference

```yaml
s3fs hope-models /mnt/models-bucket -f \
  -o passwd_file=/tmp/passwd-s3fs \      # 600; argv is world-readable via /proc
  -o url=https://hope-minio:9000 \
  -o use_path_request_style \            # MinIO is path-style, not virtual-host
  -o ro \                                # populated out-of-band; nothing here writes
  -o allow_other \                       # s3fs runs as root, lmstudio as 10001
  -o uid=10001 -o gid=10001 -o umask=0022
```

- **Image**: `efrecon/s3fs:1.95@sha256:737620a41f9eb99192a1416abb1a2fb36b42a8dae835c69266bcdc489517ce88`
- **Credentials**: `hope-models-reader` secret (`accessKeyId` / `secretAccessKey`) — a **read-only** MinIO identity, not root
- **Private CA**: s3fs is libcurl-based, so `CURL_CA_BUNDLE=/etc/ssl/arcaai/ca.crt` is all it takes, with the `arcaai-internal-ca` ConfigMap mounted
- **Privileges**: `privileged: true`, `runAsUser: 0` on the sidecar only. FUSE needs `SYS_ADMIN` + `/dev/fuse`, and `Bidirectional` propagation requires privileged. The `lmstudio` container keeps the pod default (non-root, uid 10001)

### 4.1 The mount every reader forgets

The symlinks under `/data/models` point at `/mnt/models-bucket`. **The `lmstudio`
container must mount `models-bucket` too**, with `mountPropagation: HostToContainer`.
Without it the links dangle and the daemon indexes nothing — with no error anywhere,
because a dangling symlink is not a failure, just an absence.

---

## 5. Verified in-cluster (2026-09-01)

```
init/s3fs        ready=true  restarts=0  running
init/link-models ready=true  exitCode=0

s3fs on /mnt/models-bucket type fuse.s3fs (ro,nosuid,nodev,relatime,user_id=0,group_id=10001,allow_other)

  gemma-4-e2b-it-qat-gguf (q4-0-451faffb5a16)          -> hope/gemma-4-e2b-it-qat
  gemma-4-e4b-it-qat-gguf (q4-0-7a0c80ad163b)          -> hope/gemma-4-e4b-it-qat
  granite-guardian-4.1-8b-gguf (q4-k-m-1af04917c451)   -> hope/granite-guardian-4.1-8b
  text-embedding-embeddinggemma-300m-qat-gguf (…)      -> hope/embeddinggemma-300m-qat
  linked 6 GGUF file(s)

-rwxr-xr-x 1 10001 10001  3.1G  gemma-4-E2B_q4_0-it.gguf
```

Bucket: **15 GiB, 31 objects**. MinIO PVC **200 Gi**, on `/dev/vdb` (the 300 GB
disk), 98 GB free.

---

## 6. Operational notes

- **Populate the bucket out-of-band.** `out-of-band/hope-models-publish.yaml`
  downloads, verifies against publisher digests, and uploads. Nothing may download
  *into* the mount — s3fs is mounted `ro`, and even writable FUSE-over-S3 refuses the
  reopen/append that HTTP downloaders finalise with (TASK-835 §4.2).
- **The publish job needs `--retry-all-errors` and `-C -`.** `--retry` alone does not
  cover a mid-stream HTTP/2 CANCEL from the HF CDN, and without resume every retry
  restarts a 4 GB file at byte 0. Both measured; see the job's own comments. Do **not**
  add `--http1.1` — it was tried and is worse (53 MB in 3m25s vs ~5 MB/s on HTTP/2).
- **Terminating pods can hang** on the FUSE mount. A stuck rollout may need
  `--force --grace-period=0`; watch for multiple ReplicaSets each holding a 12 GiB
  memory request.
- **Memory is the binding constraint on this node**, not GPU. Requests sit at ~85% of
  62.8 GiB, and `hope-lmstudio` alone requests 12 GiB — two of them will not schedule.

---

## 7. Known remaining blocker — unrelated to storage

`hope-lmstudio` still crash-loops, and the storage layer is **not** the cause:

```
entrypoint: model volume verified at 2026-09-01T15:30:24Z
entrypoint: starting llmster daemon
entrypoint: daemon up: llmster v0.0.23+1 is running (PID: 124)
entrypoint: FATAL: `lms runtime ls` returned nothing — cannot verify the accelerator.
```

The volume gate passes and the daemon starts. The failure is entrypoint **A-2**, the
accelerator check, with `HOPE_ACCEL_ENFORCE=strict`. The pod requests
`nvidia.com/gpu: 1` and the node advertises 6 time-sliced units, so this is about the
image's CUDA runtime bundle rather than scheduling — the `verify-lmstudio-runtime` CI
job asserts the same property at build time and is the place to look first.

Tracked separately; it does not affect any conclusion above.
