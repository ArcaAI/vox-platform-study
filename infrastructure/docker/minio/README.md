# MinIO buckets — layout, immutability, and access

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
> `docs/implementation/TASK-831-MinIO-Internal-Access-And-Model-Bucket/README.md`
> §Operator procedure. Editing the compose file below does **not** change the
> cluster. Keep the two in step by hand.

---

## 1. Endpoint policy — internal traffic never uses a public hostname

`s3.taphuynh.dev` is a **proxied Cloudflare Tunnel** hostname with no Cloudflare
Access application in front of it. An in-cluster client that uses it sends every
object — consultation audio, generated documents, model weights — out to
Cloudflare's edge and back, for a host sitting on the k3s node's own `/24`.

Measured from `hope-text` (TASK-823 Phase 2, 2026-08-30, n=7 median):

| Path | Latency |
|---|---|
| `https://s3.taphuynh.dev` (tunnel → internet → edge → tunnel → origin) | 495.6 ms |
| `https://10.10.1.102:9000` (LAN) | **2.0 ms** |

**Rule: an internal consumer addresses MinIO by LAN IP, never by a public
hostname.** This matches how `hope-secrets` already reaches every other
out-of-band dependency — Postgres `10.10.1.250:5000`, Redis `10.10.1.120:6379`.
MinIO was the sole exception.

The public hostnames stay for humans and for out-of-cluster tooling. They are
not a fallback: a client that silently falls back to the tunnel when the LAN
address is missing reintroduces exactly the exposure this convention removes, so
the manifests **fail closed** instead (`configMapKeyRef` with `optional`
unset → `CreateContainerConfigError`).

## 2. TLS — a private CA, and it is mandatory

MinIO's leaf is issued by `CN=ARCAAI Internal CA` and is **not** in any system
trust store. The tunnel hides this today by presenting a public edge certificate
to its clients and setting `noTLSVerify: true` toward the origin. Going direct
removes both crutches, so every direct client must be given the CA:

| Client | Variable |
|---|---|
| `mc` (Go) | `SSL_CERT_FILE` — dropping the PEM into `<config-dir>/certs/CAs/` does **not** work (tested, TASK-823 §8.5) |
| boto3 / AWS SDKs | `AWS_CA_BUNDLE` |
| Python `requests`/`httpx` | `SSL_CERT_FILE` / `REQUESTS_CA_BUNDLE` |
| Node (`minio`, `@aws-sdk/client-s3`) | `NODE_EXTRA_CA_CERTS` |

There is deliberately **no** "skip verification" option anywhere in this
platform. This is a PHI object store; an unverified TLS session to it is not a
degraded mode, it is a different security posture.

The leaf's SAN carries `DNS:s3.taphuynh.dev, DNS:s3-console.taphuynh.dev,
DNS:localhost, DNS:minio, IP:10.10.1.102, IP:127.0.0.1` and expires
**2028-03-21**, so the IP verifies directly with no `Host` gymnastics.

## 3. Bucket-per-purpose, and the versioning/erasure tension

One bucket per purpose, because retention policy is a property of the purpose
and cannot be expressed per-prefix:

| Bucket | Purpose | Versioning | Object lock | Public |
|---|---|---|---|---|
| `hope-models` | served model weights | **ON** | **ON** (at creation) | no |
| `mlflow` | MLflow's proxied artifact store | **OFF — deliberately** | no | no |
| `recordings` | consultation audio (PHI) | off | no | ⚠️ local dev only, see below |
| `generated-audio` | TTS output | off | no | ⚠️ local dev only, see below |
| `documents` | generated clinical documents (PHI) | off | no | no |
| `backups` | database/system backups | off | no | no |
| `harness-claim-check` | Temporal claim-check payloads (PHI) | off | no | no |

**`hope-models` and `mlflow` have OPPOSITE requirements, and getting them the
same way round is a compliance bug in one direction and a correctness bug in the
other.** Stated here because this is where someone configuring a bucket will
read it:

- **`hope-models` wants immutability.** A published weight prefix must never
  change under a running pod. Versioning + object lock is what makes a promoted
  `s3://` URI mean one fixed byte-set forever.
- **`mlflow` must NOT be versioned.** `mlflow gc` is the only hard-delete path
  MLflow has, and therefore the only right-to-erasure mechanism for anything
  that lands in an artifact. With versioning on, `gc`'s delete writes a **delete
  marker** — the bytes survive as a non-current version, invisible to `mc ls`,
  fully recoverable. **Erasure silently becomes retention.** (TASK-822 F-4,
  verified 2026-08-30.)

> ⚠️ `recordings` and `generated-audio` are set to an anonymous read-all policy
> by the local-dev bootstrap. That is a **local-dev-only** convenience and must
> never be replicated on the cluster host — `recordings` holds PHI. Flagged
> here rather than changed, because changing it is a behaviour change for every
> developer's stack and belongs to its own ticket.

### Object lock can only be enabled at bucket creation

S3 object locking — MinIO included — is set with `mc mb --with-lock` and
**cannot be turned on afterwards**. `mc mb --ignore-existing --with-lock`
against a bucket that already exists silently does nothing and exits 0. The
bootstrap therefore probes for the lock configuration and prints a loud,
actionable warning rather than pretending it succeeded. On a developer machine
whose `hope-models` predates this change the fix is to drop that bucket and let
the bootstrap recreate it; on the cluster it is the operator procedure.

Object lock is enabled with **no default retention rule**. Retention is applied
per-object at publish time by the publisher credential
(`s3:PutObjectRetention`), so the capability exists uniformly across
environments without making a developer's scratch upload undeletable for 30
days.

## 4. Credentials — least privilege, never the root key

Two policies live in `policies/`:

| Policy | Grants | Held by |
|---|---|---|
| `hope-models-reader` | `ListBucket`, `GetObject`, `GetObjectVersion` on `hope-models` **only** | every in-cluster consumer (vLLM, STT, harness, text) |
| `hope-models-publisher` | the above plus `PutObject`, multipart, `PutObjectRetention` | a human or CI publishing weights |

Neither grants `s3:DeleteObject`. Removing a published model prefix is a root
operation performed knowingly, not something a compromised inference pod or a
mistyped `mc rm --recursive` can do.

**The reader policy is the mechanism that actually enforces "never overwrite a
published prefix."** Object lock protects bytes that are already there;
versioning makes a mistake recoverable; but a service account with no
`PutObject` is what makes the overwrite impossible in the first place. All
three, because each covers a different failure: malice, accident, and
misconfiguration.

Consumers must **not** reuse `MINIO_ACCESS_KEY`/`MINIO_SECRET_KEY` — that pair
carries read/write over the PHI buckets. A weight fetch has no business holding
a credential that can write `recordings`.

---

## 5. `hope-models` blob layout

```
s3://hope-models/
└── <slug>/                                  # lowercase [a-z0-9._-], the model's identity
    └── <version>/                           # IMMUTABLE. Never written twice.
        ├── manifest.json                    # the Merkle root — see §5.3
        ├── SHA256SUMS                       # same digests, `shasum -c` / `mc` interop
        ├── <slug>.<QUANT>.gguf              # single-file (preferred), OR
        ├── <slug>.<QUANT>-00001-of-000NN.gguf   # shard 1 — the ONLY one a server is pointed at
        ├── <slug>.<QUANT>-00002-of-000NN.gguf
        ├── config.json                      # when the engine needs it
        └── tokenizer.json / tokenizer_config.json / vocab.json / merges.txt
```

**Flat within the version prefix. Do not nest `model/` or
`components/tokenizer/` subdirectories** — vLLM's `pull_files()` /
`list_safetensors()` walk the prefix and expect the config, tokenizer and
weights side by side (TASK-823 §8.4, derived from `vllm/config/model.py:701-728`).

### 5.1 The five models

| Slug | Role | Format |
|---|---|---|
| `gemma4-e2b-it-qat` | llm | GGUF, 4-bit QAT |
| `gemma4-e4b-it-qat` | llm | GGUF, 4-bit QAT |
| `granite-guardian-4.1-8b` | llm (safety) | GGUF, 4-bit |
| `qwen3.5-4b` | llm | GGUF, 4-bit |
| `text-embedding-embeddinggemma-300m-qat` | embeddings | GGUF, 4-bit QAT |

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
  "engine": { "family": "llama.cpp", "minVersion": "b4500" },
  "upstream": {
    "repo": "google/gemma-4-e4b-it-qat-q4_0-gguf",
    "revision": "<upstream git sha>",
    "license": "gemma"
  },
  "primaryObject": "gemma4-e4b-it-qat.Q4_K_M.gguf",
  "shardCount": 1,
  "totalBytes": 4471234560,
  "objects": [
    {
      "path": "gemma4-e4b-it-qat.Q4_K_M.gguf",
      "bytes": 4471234560,
      "sha256": "3f9a1c7d2e05…"
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
| `engine.minVersion` | A GGUF written by a newer converter fails to load on an older `llama.cpp` with an unhelpful error. Recording the floor turns that into a pre-flight check. |
| **`primaryObject`** | **See §5.4 — this is the one that bites.** |
| `shardCount` | Lets a syncer assert completeness *before* serving. |

### 5.4 Sharding — `primaryObject` and the two silent failures

Single-file GGUF is preferred. Where a model must be sharded, two failure modes
are specific enough to design against:

1. **Pointing a llama.cpp-family server at any shard other than the first**
   yields `illegal split file idx`. The server derives the whole set from shard
   1's header; there is no discovery. `primaryObject` therefore records shard
   `-00001-of-000NN.gguf` **explicitly**, so no consumer has to infer it by
   sorting a key listing.
2. **A partial sync that lands shard 2 before shard 1 fails silently** — the
   prefix looks populated, `mc ls` shows objects, and the load fails later with
   an error that points at the model rather than at the transfer. `shardCount`
   plus the per-object digest list makes completeness a checkable property:
   a consumer asserts `len(objects with .gguf) == shardCount` before it starts.

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

# 2. Trust the internal CA. `mc` reads SSL_CERT_FILE; certs/CAs/ does NOT work.
export SSL_CERT_FILE=/path/to/arcaai-ca.crt
export MC_HOST_hope="https://<publisher-key>:<publisher-secret>@10.10.1.102:9000"

# 3. Upload. Ask MinIO to verify each object's SHA256 in flight rather than
#    trusting the transfer.
mc cp --recursive --checksum SHA256 ./<slug>/ "hope/hope-models/<slug>/${VERSION}/"

# 4. Prove what landed, and only then reference the prefix from config.
mc ls --recursive "hope/hope-models/<slug>/${VERSION}/"
```

**Promotion is a NEW prefix plus a config change — never an overwrite.**
Rollback is then a revert of the config, not a re-upload of several gigabytes
under time pressure.
