# MinIO buckets — layout, access, and the `hope-models` convention

This directory holds the IAM policy documents mounted into the `minio-setup`
bootstrap container of `infrastructure/docker/docker-compose.yml`, plus the
convention that governs the `hope-models` bucket in **every** environment.

> **Two init paths, and only one of them is in this repo.**
>
> | Path | Who bootstraps it | Where |
> |---|---|---|
> | **Local dev** | the `minio-setup` service in `infrastructure/docker/docker-compose.yml` | this repo |
> | **Cluster (`hope-v2-dev`)** | **nobody — a human, out of band** | MinIO is a standalone LAN host, `10.10.1.102`. It is not a pod, has no `Service`, and no manifest in `hope-v2-deployment` creates or configures it. |
>
> The cluster procedure is written out in
> `docs/implementation/TASK-832-MinIO-Internal-Access-And-Model-Bucket/README.md`
> §Operator procedure. Editing the compose file below does **not** change the
> cluster. Keep the two in step by hand.

> **Owner directives, 2026-08-30** — these override anything older in this file.
> 1. **No private CA anywhere.** MinIO authentication is a **service account**
>    (access key + secret). There is no `ARCAAI Internal CA` ConfigMap, no
>    `AWS_CA_BUNDLE`, no `SSL_CERT_FILE`, no `NODE_EXTRA_CA_CERTS`.
> 2. **PHI is not the argument.** Internalizing the endpoint is worth doing
>    because it is faster and simpler. Where a PHI-driven control was relaxed,
>    it is marked `RELAXED:` in one line so it can be reversed later.
> 3. **Favour the simplest thing that works.** Best practices for deployment,
>    integration and configuration are in the ticket's `BEST-PRACTICES.md`.

---

## 1. Endpoint policy — internal traffic uses the LAN address

`s3.taphuynh.dev` is a proxied Cloudflare Tunnel hostname. An in-cluster client
that uses it sends every object out to Cloudflare's edge and back, for a host
sitting on the k3s node's own `/24`.

Measured from `hope-text` (TASK-823 Phase 2, 2026-08-30, n=7 median):

| Path | Latency |
|---|---|
| `s3.taphuynh.dev` (pod → internet → edge → tunnel → origin) | 495.6 ms |
| `10.10.1.102:9000` (LAN) | **2.0 ms** |

**Rule: an internal consumer addresses MinIO by LAN IP, never by a public
hostname.** Two reasons, neither of them PHI:

- **~248× on every object operation**, on a path that a weight fetch and an
  audio upload both sit on.
- **Fewer moving parts.** The tunnel adds DNS, a Cloudflare account, an edge
  certificate and a `cloudflared` process to a hop between two machines on the
  same switch. Every one of those is a way for the storage path to break for a
  reason that has nothing to do with storage.

This matches how the platform already reaches every other out-of-band
dependency — Postgres `10.10.1.250:5000`, Redis `10.10.1.120:6379`. MinIO was
the sole exception.

The public hostnames stay for humans and out-of-cluster tooling. They are not a
fallback: a client that silently falls back to the tunnel when the LAN address
is missing reintroduces the slow path invisibly, so manifests **fail closed**
instead (`configMapKeyRef` with `optional` unset → `CreateContainerConfigError`).

## 2. Transport — no CA, and the one decision that is still open

Per directive 1 there is **no private CA distributed to any client**. That
settles the trust question and opens a transport question, because the MinIO
host was given a self-signed certificate in
`docs/research/deployments/deploy-vm402-minio.md` §14 and now serves **HTTPS on
:9000**. MinIO auto-detects TLS from the files in its certs directory and serves
one scheme per port — it cannot serve HTTP and HTTPS on :9000 simultaneously.

So "LAN + no CA" resolves one of two ways, and **this needs an owner decision**:

| | **A — MinIO serves plain HTTP** (the literal directive) | **B — MinIO keeps HTTPS, clients skip verification** |
|---|---|---|
| Change on the MinIO host | drop `--certs-dir` and restart | none |
| App-repo change | none — every client already supports it | `verify=False` / `rejectUnauthorized:false` in 2 client factories (§2.1) |
| Other LAN consumers | **pgBackRest breaks** (`deploy-vm402-minio.md:456` records that it requires HTTPS for S3); GitLab, Loki, Tempo, Prometheus and the `cloudflared` origin all need re-pointing | unchanged — all four already run with verification off |
| Precedent in this platform | the pre-§14 state | `repo1-storage-verify-tls=n` (`deploy-vm402-minio.md:694`), `insecure_skip_verify: true` (Prometheus), `http_config.insecure_skip_verify: true` (Loki), `tls_insecure_skip_verify: true` (Tempo), `No TLS Verify` on both tunnel origins |

**B is the smaller change and is already the de-facto platform posture in four
places.** It honours directive 1 exactly — the ban is on distributing a CA, not
on TLS. A is what the directive says literally, and is cheaper in the app repo
but breaks four things outside it.

`RELAXED:` under either option the MinIO certificate is not verified by anyone
on the LAN. Reversing this means publishing the CA and setting
`AWS_CA_BUNDLE` / `SSL_CERT_FILE` / `NODE_EXTRA_CA_CERTS` per §2.1's table.

### 2.1 What each client can actually do today

Verified by reading the client factories, 2026-08-30:

| Workload | Client | Plain HTTP | Skip verification |
|---|---|---|---|
| `hope-stt`, `hope-stt-worker` | Python `minio` | ✅ `MINIO_SECURE=false` | ✅ `MINIO_CERT_CHECK=false` → `urllib3.PoolManager(cert_reqs="CERT_NONE")` (`apps/stt/src/stt/core/storage/minio_client.py:38`; settings at `core/config/settings.py:137-138`) |
| `hope-harness`, `hope-harness-worker` | `boto3` | ✅ `use_ssl=False` (`apps/harness/src/harness/temporal/claim_check.py:153`; scheme built at `models/source_resolver.py:113`) | ❌ **no `verify=` argument is passed** — would need a one-line change |
| `hope-api` | `@aws-sdk/client-s3` | ✅ `endpoint: http://…` | ❌ **no `requestHandler` is configured** (`packages/applications/src/services/baseServices/storage/providers/s3-blob.provider.ts:58`, `.../storage/s3/s3.service.ts:256`) — would need a `NodeHttpHandler` with `rejectUnauthorized:false`, or the blunt process-wide `NODE_TLS_REJECT_UNAUTHORIZED=0` |
| `mc` | — | ✅ | ✅ `--insecure` (used at `deploy-vm402-minio.md:653`) |

That asymmetry is the whole reason option A looks attractive: **plain HTTP needs
zero code changes; skip-verify needs two.**

## 3. Bucket-per-purpose, and the versioning/erasure tension

One bucket per purpose, because retention policy is a property of the purpose
and cannot be expressed per-prefix:

| Bucket | Purpose | Versioning | Object lock | Public |
|---|---|---|---|---|
| `hope-models` | served model weights | **ON** | **ON** (at creation) | no |
| `mlflow` | MLflow's proxied artifact store | **OFF — deliberately** | no | no |
| `recordings` | consultation audio | off | no | ⚠️ local dev only, see below |
| `generated-audio` | TTS output | off | no | ⚠️ local dev only, see below |
| `documents` | generated clinical documents | off | no | no |
| `backups` | database/system backups | off | no | no |
| `harness-claim-check` | Temporal claim-check payloads | off | no | no |
| `hope-audio`, `hope-audio-chunks` | STT working buckets — created at RUNTIME by the app, not by any bootstrap | off | no | no |

**`hope-models` and `mlflow` have OPPOSITE requirements, and getting them the
same way round is a bug in one direction or the other:**

- **`hope-models` wants immutability.** A published weight prefix must never
  change under a running pod. Versioning + object lock is what makes a promoted
  `s3://` URI mean one fixed byte-set forever.
- **`mlflow` must NOT be versioned.** `mlflow gc` is the only hard-delete path
  MLflow has. With versioning on, `gc`'s delete writes a **delete marker** — the
  bytes survive as a non-current version, invisible to `mc ls`, fully
  recoverable, so a deletion silently becomes retention. (TASK-822 F-4.)

> ⚠️ `recordings` and `generated-audio` are set to an anonymous read-all policy
> by the local-dev bootstrap. Local-dev only; never replicate it on the cluster
> host. (In practice the call is already inert — see §6, M-6.)

## 4. Credentials — service accounts, one per role

Directive 1: **MinIO authentication is a service account (access key + secret).**
MinIO has two layers, and the platform already uses both for pgBackRest
(`deploy-vm402-minio.md` §9b) — that is the pattern to copy:

| Layer | Command | What it is |
|---|---|---|
| **Identity + permissions** | `mc admin user add` + `mc admin policy attach` | the *role*. Long-lived. Named after the job, not the consumer. |
| **Credential** | `mc admin user svcacct add` | the *access key + secret* a service actually holds. Inherits the parent identity's policy. Disposable — this is the unit of rotation. |

Two policies live in `policies/`, both scoped to `hope-models` alone:

| Policy | Grants | Held by |
|---|---|---|
| `hope-models-reader` | `ListBucket`, `GetBucketLocation` on the bucket; `GetObject`, `GetObjectVersion` on its objects | every in-cluster weight consumer |
| `hope-models-publisher` | the above plus `ListBucketMultipartUploads`, `ListBucketVersions`, `GetBucketObjectLockConfiguration`, `PutObject`, `AbortMultipartUpload`, `ListMultipartUploadParts`, `PutObjectRetention`, `GetObjectRetention` | a human or CI publishing weights |

**Neither grants `s3:DeleteObject`.** Retiring a published prefix is a root
operation performed knowingly, not something a compromised inference pod or a
mistyped `mc rm --recursive` can do.

**The reader policy is the mechanism that actually enforces "never overwrite a
published prefix."** §6 measured why: object lock protects *version bytes*, not
*visibility* — a delete marker still hides an object from every listing. A
credential with no `PutObject` and no `DeleteObject` is the layer that holds.

Consumers must **not** reuse `MINIO_ACCESS_KEY`/`MINIO_SECRET_KEY` — that pair
carries read/write over every bucket. A weight fetch has no business holding a
credential that can write `recordings`.

### 4.1 Provisioning, verbatim

Runs on any host with `mc` and network reach to `10.10.1.102`. Copy the two
policy documents out of this directory first.

```bash
# 0. Alias. `--insecure` only if MinIO is serving HTTPS (§2 option B).
mc --insecure alias set hope https://10.10.1.102:9000 <root-access-key> <root-secret>
mc --insecure admin info hope        # must succeed before continuing

# 1. The two roles: policy, then identity, then attach.
mc admin policy create hope hope-models-reader    ./hope-models-reader.json
mc admin policy create hope hope-models-publisher ./hope-models-publisher.json

mc admin user add hope hope-models-reader    "$(openssl rand -base64 32)"
mc admin user add hope hope-models-publisher "$(openssl rand -base64 32)"

mc admin policy attach hope hope-models-reader    --user hope-models-reader
mc admin policy attach hope hope-models-publisher --user hope-models-publisher

# 2. The credentials services actually hold. Record the printed Access Key and
#    Secret Key — MinIO does not show the secret again.
mc admin user svcacct add hope hope-models-reader \
  --name hope-models-reader-sa --description "in-cluster weight consumers"
mc admin user svcacct add hope hope-models-publisher \
  --name hope-models-publisher-sa --description "weight publishing (human/CI)"
```

### 4.2 Rotation

Rotation touches only the credential layer, so the policy and the identity —
the reviewed parts — never move:

```bash
mc admin user svcacct list hope hope-models-reader          # find the current key
mc admin user svcacct add  hope hope-models-reader --name hope-models-reader-sa-2
#   ...roll the new pair into hope-secrets / the AiProviderConnection row,
#      restart consumers, confirm they are serving...
mc admin user svcacct rm   hope <old-access-key>            # only then
```

Both keys are valid during the overlap, so there is no restart-ordering
requirement — which is what makes this the cheap operation it should be.
`mc admin user svcacct info hope <access-key>` shows which identity a key
belongs to when the mapping has been lost.

---

## 5. `hope-models` blob layout

```
s3://hope-models/
└── <slug>/                                  # lowercase [a-z0-9._-], the model's identity
    └── <version>/                           # IMMUTABLE. Never written twice.
        ├── manifest.json                    # the Merkle root — see §5.3
        ├── SHA256SUMS                       # same digests, `shasum -c` / `mc` interop
        ├── <name>.gguf                      # PRIMARY — single-file (preferred), OR
        ├── <name>-00001-of-000NN.gguf       # shard 1 — the ONLY one a server is pointed at
        ├── <name>-00002-of-000NN.gguf
        ├── <name>-mmproj.gguf               # COMPANION projector (multimodal only)
        ├── config.json                      # when the engine needs it
        └── tokenizer.json / tokenizer_config.json / vocab.json / merges.txt
```

**Flat within the version prefix. Do not nest `model/` or
`components/tokenizer/` subdirectories.** Two independent reasons, so the rule
survives an engine change:

- **llama.cpp** (the engine for all five GGUF models) is pointed at one file
  path and, for multimodal, one `--mmproj` path. Nesting buys nothing and makes
  every reference longer.
- **vLLM** (still the engine for the existing `qwen3-4b-awq` safetensors prefix)
  actively requires it: `pull_files()` / `list_safetensors()` walk the prefix and
  expect config, tokenizer and weights side by side (TASK-823 §8.4, derived from
  `vllm/config/model.py:701-728`).

### 5.1 The five models

Artifact facts below are TASK-831's (Model Catalogue Alignment) verified inventory.
**The engine for all five is llama.cpp, not vLLM** — vLLM's in-tree GGUF support
is deprecated and out-of-tree. Build floor **`b9383`** for the Gemma pair.

| Slug | Role | Primary object | Companion |
|---|---|---|---|
| `gemma4-e2b-it-qat` | llm (multimodal) | `gemma-4-E2B_q4_0-it.gguf` (3.35 GB) | **`gemma-4-E2B-it-mmproj.gguf` (987 MB)** |
| `gemma4-e4b-it-qat` | llm (multimodal) | `gemma-4-E4B_q4_0-it.gguf` (5.15 GB) | **`gemma-4-E4B-it-mmproj.gguf` (992 MB)** |
| `granite-guardian-4.1-8b` | llm (safety) | Q4_K_M, 4.77 GiB | — |
| `qwen3.5-4b` | llm | Q4_K_M, 2.81 GiB | — |
| `text-embedding-embeddinggemma-300m-qat` | embeddings | Q4_0, 278 MB | — |

**Slug normalization.** The catalogue names the fourth model `qwen3.5-4B`; the
S3 key is `qwen3.5-4b`. S3 keys are case-sensitive, so the rule is stated rather
than left to chance: **lowercase the catalogue id to form the slug.** Dots are
kept (`qwen3.5-4b`) — see below.

> ⚠️ The Gemma pair has a **provenance window**: Google re-uploaded these repos
> on 2026-07-17 to fix a bad checkpoint. Any copy cached or mirrored between
> 15–17 July 2026 is poisoned. Verify digests against the current publisher
> blobs before staging into MinIO — which is what §5.5 step 0 does.

**There is no `llm/` vs `embeddings/` top-level split, and that is a decision,
not an oversight.** Role is recorded in `manifest.json`. A prefix split would
buy nothing a manifest field does not, would break the already-published
`hope-models/qwen3-4b-awq/v1/` URI, and would diverge from the
`models/{slug}/{revision}/{filename}` shape STT's `path_resolver.py` already
builds. One bucket, one shape, role as metadata.

Slugs are lowercase. Dots are permitted in **keys** (`qwen3.5-4b`) because every
client in this platform is pinned to **path-style** addressing
(`forcePathStyle: true`, `RUNAI_STREAMER_S3_USE_VIRTUAL_ADDRESSING=0`); dots are
only hazardous in a *bucket* name, under virtual-host addressing.

### 5.2 `<version>` is content-addressed

**Preferred form: `<quant>-<sha256-12>`** — e.g. `q4-k-m-3f9a1c7d2e05` — where
the twelve hex characters are the first 12 of `sha256(manifest.json)`.

Why the digest of the *manifest* and not of the weights file: a model is
frequently more than one object (tokenizer, config, shards). The manifest lists
a digest for every object, so hashing the manifest yields a **Merkle root** —
one short label that pins the entire tree. Naming the prefix after the weights
file alone would leave the tokenizer free to change under a stable URI, which is
the exact class of silent drift this convention exists to prevent.

Why content-addressing at all, rather than `v1`, `v2`: **overwriting a published
prefix means running pods keep serving the old bytes from page cache while newly
scheduled pods fetch different bytes from an identical URI, with no signal
anywhere.** No error, no version bump, no log line — two pods answering the same
request from different weights. A content-derived name makes that impossible to
express: different bytes cannot produce the same prefix.

**Grandfather clause.** `hope-models/qwen3-4b-awq/v1/` was published under the
earlier sequential scheme (TASK-823) and stays as it is. Sequential `vN` remains
*acceptable* — it delivers immutability provided it is never rewritten — but new
publications should use the content-derived form, which delivers immutability
*and* makes a violation detectable rather than merely forbidden.

### 5.3 `manifest.json`

One per model version. Written at publish time, read by whatever verifies a
model before serving it.

```json
{
  "schemaVersion": 1,
  "slug": "gemma4-e4b-it-qat",
  "version": "q4-k-m-3f9a1c7d2e05",
  "role": "llm",
  "format": "gguf",
  "quantization": "Q4_K_M",
  "contextLength": 8192,
  "engine": { "family": "llama.cpp", "minVersion": "b9383" },
  "upstream": {
    "repo": "google/gemma-4-e4b-it-qat-q4_0-gguf",
    "revision": "<upstream git sha>",
    "license": "gemma"
  },
  "primaryObject": "gemma-4-E4B_q4_0-it.gguf",
  "shardCount": 1,
  "projectorObject": "gemma-4-E4B-it-mmproj.gguf",
  "totalBytes": 6142000000,
  "objects": [
    {
      "path": "gemma-4-E4B_q4_0-it.gguf",
      "role": "weights",
      "bytes": 5150000000,
      "sha256": "3f9a1c7d2e05…"
    },
    {
      "path": "gemma-4-E4B-it-mmproj.gguf",
      "role": "projector",
      "bytes": 992000000,
      "sha256": "b71c04e9aa18…"
    }
  ],
  "publishedAt": "2026-08-30T00:00:00Z",
  "publishedBy": "<operator or CI job url>"
}
```

Every field earns its place:

| Field | Why it is not optional |
|---|---|
| `sha256` per object | The only way to prove what landed equals what the publisher verified against upstream. `mc cp --checksum SHA256` verifies the *transfer*; this verifies the *artifact*. |
| `bytes` per object | A truncated object with a correct-looking name is caught before a load attempt, not during one. |
| `quantization` | Two prefixes of the same model differ only by this. Serving the wrong one is a silent quality regression, not a crash. |
| `contextLength` | The engine will happily start with a smaller window than the caller assumes and truncate prompts silently. |
| **`primaryObject`** | **See §5.4 — this is the one that bites.** |
| **`projectorObject`** | **See §5.4.** A multimodal model's `mmproj` is a separate file that no engine auto-pairs from a plain path. |
| `shardCount` | Lets a syncer assert completeness *before* serving. |
| `engine.minVersion` | For the Gemma pair this is a **correctness** floor, not a compatibility one — see §5.4 item 3. |

### 5.4 The three ways a multi-file model fails quietly

Single-file GGUF is preferred. Three failure modes are specific enough to design
against, and the manifest fields above exist precisely to remove each one:

1. **Pointing a llama.cpp-family server at any shard other than the first**
   yields `illegal split file idx`. The server derives the whole set from shard
   1's header; there is no discovery. `primaryObject` therefore records shard
   `-00001-of-000NN.gguf` **explicitly**, so no consumer has to infer it by
   sorting a key listing.
2. **A partial sync that lands shard 2 before shard 1 fails silently** — the
   prefix looks populated, `mc ls` shows objects, and the load fails later with
   an error that points at the model rather than at the transfer. `shardCount`
   plus the per-object digest list makes completeness a checkable property:
   a consumer asserts `len(objects with role "weights") == shardCount` before it
   starts.
3. **The multimodal projector is a separate file that nothing auto-pairs.** The
   Gemma 4 pair ships `*-mmproj.gguf` alongside the weights, and
   `llama-server -m <weights>.gguf` **without `--mmproj` is a text-only server**
   — only the `-hf` shorthand auto-pairs, and a MinIO-served model never uses
   `-hf`. `projectorObject` records the path so the launch argument is derived,
   not remembered. `llama-server` at least fails loudly on an image with no
   projector; **the version floor is the part that fails silently.** Two bugs
   (projector post-norm vs pre-norm, and audio RMS-norm eps `1e-5` vs `1e-6`)
   produced plausible-but-wrong multimodal output with no error at all between
   roughly build `b8630` and `b9383`. That is why `engine.minVersion` is a
   required field and not documentation: a consumer can refuse to start on an
   older runtime instead of quietly degrading. Use the **BF16** projector; other
   quantizations are known-degraded.

### 5.5 Publish procedure

```bash
# 0. Verify against the PUBLISHER before anything is uploaded. For HuggingFace:
#      curl -s 'https://huggingface.co/api/models/<repo>/tree/main?recursive=1' \
#        | jq -r '.[] | select(.lfs) | "\(.lfs.oid)  \(.path)"'
shasum -a 256 ./<slug>/*.gguf          # must equal the publisher's digests

# 1. Digests + manifest. SHA256SUMS is the interop copy; manifest.json is the record.
( cd <slug> && shasum -a 256 ./* | tee SHA256SUMS )
#    ...author manifest.json from those digests (schema in §5.3), then:
VERSION="q4-k-m-$(shasum -a 256 <slug>/manifest.json | cut -c1-12)"

# 2. The PUBLISHER service-account credential (§4). No CA, no cert file.
#    Prefix every mc call with --insecure if MinIO is serving HTTPS (§2 option B);
#    that is the position proven to work in deploy-vm402-minio.md:653.
mc --insecure alias set hope https://10.10.1.102:9000 <publisher-access-key> <publisher-secret>

# 3. Upload. Ask MinIO to verify each object's SHA256 in flight rather than
#    trusting the transfer.
mc --insecure cp --recursive --checksum SHA256 ./<slug>/ "hope/hope-models/<slug>/${VERSION}/"

# 4. Prove what landed, and only then reference the prefix from config.
mc --insecure ls --recursive "hope/hope-models/<slug>/${VERSION}/"
```

**Promotion is a NEW prefix plus a config change — never an overwrite.**
Rollback is then a revert of the config, not a re-upload of several gigabytes
under time pressure.

---

## 6. Measured behaviours — things this file used to assert

Run 2026-08-30 against `minio/minio:RELEASE.2025-04-08T15-41-24Z` (4-drive
erasure set) and `minio/mc:RELEASE.2025-04-16T18-13-26Z`, in a throwaway
Kubernetes namespace, using **the committed policy documents verbatim**.
Evidence is in the ticket README §7.

| # | Behaviour |
|---|---|
| **M-1** | **`mc retention info --default <bucket>` prints a message that contradicts its exit code.** On a bucket created `--with-lock` it prints `Object locking is not enabled.` and **exits 0**; on a lockless bucket it errors `does not support locking` and **exits 1**. The bootstrap's probe branches on the exit code and is therefore CORRECT — but an operator running the same command by hand reads the message and concludes the opposite. **Judge lock by exit code, or behaviourally** (`mc retention set … <bucket>/<obj>` succeeds only when lock is on). |
| **M-2** | **`mc mb --ignore-existing --with-lock` on an existing lockless bucket prints `Bucket created successfully` and exits 0** — and the bucket still has no lock. It does not merely do nothing quietly; it reports success. Object lock really is creation-only. |
| **M-3** | **`mc ls <alias>` is filtered by policy.** The reader and publisher service accounts see `hope-models` and nothing else — not `recordings`, not other buckets. Neither policy grants `s3:ListAllMyBuckets` and neither needs it. Do **not** add it "so `mc ls` works". |
| **M-4** | **Object lock does not stop an object disappearing.** With lock enabled and GOVERNANCE retention set on the current version, `mc rm` still succeeded — it wrote a *delete marker*, so the object vanished from every listing while the bytes survived as a non-current version. Object lock protects **version bytes**; it does not protect **visibility**. The layer that actually prevents this is the credential having no `DeleteObject`. |
| **M-5** | Both policy documents are accepted by MinIO verbatim; `mc admin policy info` echoes them back with only action ordering normalized. |
| **M-6** | `mc policy set public` is **deprecated and a no-op** — it prints `mc: Please use 'mc anonymous'` and exits 0. `recordings` and `generated-audio` have therefore not actually been anonymous-readable on any recent `mc`. Left alone deliberately: *restoring* anonymous read is not a change to make silently. |
| **M-7** | A publisher overwrite of an existing key creates a new version and retains the old bytes (`v1` + `v2` both listed by `mc ls --versions`). Anonymous access to `hope-models` is denied. |

All six least-privilege assertions passed with the committed policies:
publisher can write and set retention; reader can list and get; reader cannot
overwrite, delete or set retention; neither identity can see any other bucket.
